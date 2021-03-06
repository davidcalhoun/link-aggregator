/*
 * link-aggregator
 * Aggregates popular links from Twitter and Pocket lists, ranking and sorting based on popularity.
 * TODO: remove Codebird dependency, talk directly to Twitter API instead.
 */
const Codebird = require('codebird');
const R = require('ramda');
const fetch = require('isomorphic-fetch');
const Promise = require('promise-polyfill');
const urlUtil = require('url');
const redis = require('redis');
const origRequest = require('request');
const async = require('async');
const winston = require('winston');
const cheerio = require('cheerio');
const defaultJunkParams = require('./default-junk-params');
const parseMessyTime = require('parse-messy-time');

winston.level = 'debug';

const msInAWeek = 604800000;
const msInAMonth = 2592000000;

const client = redis.createClient();

// Keep track of module name for logging purposes.
const moduleName = 'link-aggregator';

// Flag for cached urls that were removed (e.g by the user) and should be ignored.
const urlRemovedFlagKey = 'isRemoved';

// Namespace prefix for organizing Redis data.
let redisNS = 'la-';

const redisIsFetchingKey = 'isCurrentlyFetching';

// Configure request.js
const request = origRequest.defaults({
  // Enable global cookies (some sites won't function normally without cookies)
  jar: true,

  // Request headers.
  headers: {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.8',
    'cache-control': 'no-cache',
    dnt: 1,
    pragma: 'no-cache',
    // This is kind of cheesy pretending to be Chrome, but unfortunately some sites completely break
    // unless given something looking closer to a real browser.
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36'
  }
});

// For communicating with proxy in dev mode: enables receiving data even with self-signed SSL certs.
// TODO: look into if this is still needed.
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * Public functions.
 */
class Aggregator {
  constructor(config) {
    // Init Codebird (helper for accessing Twitter API)
    this.codebird = new Codebird();

    // Hash of all links.  Need to keep this reference here so both Twitter and Pocket can update
    // it.
    this.urls = {};

    client.set(`${redisNS}${redisIsFetchingKey}`, 0);

    // Used for internal performance timing.
    this._performanceTimers = {};

    // Allow redis prefix override.
    if (config && config.redisPrefix) redisNS = config.redisPrefix;
  }

  /**
   * Performance timing (similar usage as console.time).
   */
  _timerStart(id) {
    this._performanceTimers[id] = Date.now();
  }

  /**
   * Performance timing (similar usage as console.time).
   */
  _timerEnd(id) {
    if (this._performanceTimers[id]) {
      const timeMS = Date.now() - this._performanceTimers[id];

      winston.debug(`Timer ${id}: ${timeMS} ms.`);

      // Clear timer.
      this._performanceTimers[id] = null;
    }
  }

  /**
   * Sets consumer key and secret for Twitter API.
   */
  setTwitterConsumerKey(key, secret) {
    this.codebird.setConsumerKey(key, secret);
  }

  /**
   * Sets token and secret for Twitter API.
   */
  setTwitterToken(token, secret) {
    this.codebird.setToken(token, secret);
  }

  /**
   * Sets words to ignore in links (for filtering irrelevant links).
   */
  setIgnoreWords(words) {
    this.ignoreWords = words || [];
  }

  /**
   * Gets words to ignore in links.
   */
  getIgnoreWords() {
    return this.ignoreWords;
  }

  /**
   * Transforms category classification config for easier lookups.
   */
  _toCategoryPairs(categories) {
    return R.map((category) => {
      let regexp = categories[category];

      if (Array.isArray(regexp)) {
        regexp = regexp.join('\\b|\\b');
      }

      // Match both "front end" and "front-end".
      regexp = regexp.replace(' ', '(\\s|-)');

      const dontMatchEntities = '[^&]';
      regexp = new RegExp(`${dontMatchEntities}\\b${regexp}\\b`, 'gi');

      return [
        category,
        {
          keywords: categories[category],
          regexp
        }
      ];
    }, Object.keys(categories));
  }

  /**
   * Sets categories for topic tagging.
   */
  setCategories(categories) {
    this.categoriesUnprocessed = categories;

    /*
     * Convert to an easier lookup object with a regexp.
     * Example before:
     * {
     *   Accessibility: ['a', 'b', 'c', 'd', 'e', 'f', 'g']
     * }
     *
     * Example after:
     * [
     *   {
     *     name: 'Accessibility',
     *     keywords: {
     *       keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
     *       regexp: /a|b|c|d|e|f|g/gi
     *     }
     *   }
     * ]
     */
    this.categories = (categories) ?
      R.compose(R.map(R.zipObj(['name', 'keywords'])), this._toCategoryPairs)(categories) :
      [];
  }

  /**
   * Gets categories, for tagging link topics.
   */
  getCategories() {
    return this.categoriesUnprocessed;
  }

  /**
   * Fetches links from a Twitter list.
   * https://dev.twitter.com/rest/reference/get/lists/statuses
   */
  _asyncGetTwitterList(args, cb) {
    const fnName = '_asyncGetTwitterList';

    winston.debug(fnName);

    const argsCopy = Object.assign({}, args);

    // Tests: return a data stub immediately.
    if (argsCopy.dataStub) return cb(null, argsCopy.dataStub);

    let tweets = [];

    // Initialize if needed.
    if (!argsCopy.data) {
      argsCopy.data = [];
      argsCopy.iterations = 0;
    }

    const listOptions = {
      owner_screen_name: argsCopy.owner,
      slug: argsCopy.name,
      count: argsCopy.count || 110
    };

    // Pagination
    if ('max_id' in argsCopy) listOptions.max_id = argsCopy.max_id;

    winston.debug(`${fnName}: fetching...`, argsCopy);

    // TODO: send pagination calls out in parallel instead of sequentially
    return this.codebird.__call(
      'lists_statuses',
      listOptions,
      (reply, rate, err) => {
        // TODO pay attention to rate limits

        if (err) {
          return cb(err);
        }

        if (reply.errors) {
          return cb(JSON.stringify(reply.errors));
        }

        argsCopy.iterations++;

        if (argsCopy.multipleCallbacks) {
          // Return current batch immediately.  This will result in the callback being called
          // multiple times as the data comes in, which will be faster than waiting for one big
          // callback at the end.
          cb(null, reply);
        } else if (!argsCopy.multipleCallbacks && tweets) {
          // Group up results into one callback;

          // append
          tweets = tweets.concat(reply);
        } else if (!argsCopy.multipleCallbacks && !tweets) {
          // init
          tweets = reply;
        }

        // Reached the limit
        // TODO pull out iteration #, or base results on filtered count
        if (argsCopy.iterations > 4) {
          // cb already sent above
          if (argsCopy.multipleCallbacks) return null;
          return cb(null, tweets);
        }

        // Fetch the next page
        if (reply.length === 0) {
          return cb('Twitter API reply is 0 length - hit a rate limit?');
        }

        const lastItem = reply[reply.length - 1] || {};
        const lastItemID = R.path(['id'], lastItem);

        if (!lastItemID) {
          winston.error(`${fnName}: could not find id of last tweet in list`);
          console.log(reply);
        }

        argsCopy.max_id = lastItemID;
        return this._asyncGetTwitterList(argsCopy, cb);
      }
    );
  }

  /**
   * Searches a text string for matching categories.
   */
  _getCategoriesFromText(text, categories) {
    const fnName = `${moduleName}/_getCategoriesFromText`;

    //winston.debug(`${fnName}: ${text}`);

    let cats = [];
    const categoriesCopy = categories || this.categories || [];

    cats = R.filter((category) => text && text.match(category.keywords.regexp))(categoriesCopy);

    cats = R.pluck('name', cats);

    return cats;
  }

  /**
   * Filters out tweets missing urls, or containing words that should be ignored.
   */
  filterTweets(tweets, ignoreWords) {
    const fnName = `${moduleName}/filterTweets`;

    const numBefore = tweets.length;

    const tweetsAfter = R.reject((tweet) => {
      // If this tweet includes a quoted or rewteeted tweet, reference the original tweet.
      if (tweet.quoted_status) tweet = tweet.quoted_status;
      if (tweet.retweeted_status) tweet = tweet.retweeted_status;

      // Discard tweets with no urls.
      if (!tweet.entities || !tweet.entities.urls || tweet.entities.urls.length === 0) {
        //winston.debug(`Rejecting - no urls present in tweet: ${tweet.text}`);
        return true;
      }

      // Discard ignored words.  Url filtering will happen later.
      const shouldIgnore = R.find((ignoreWord) => {
        let txt = `@${tweet.user.screen_name}: ${tweet.text}`;
        const matches = `${txt}`.match(new RegExp(ignoreWord, 'gi'));

        //if (matches) winston.debug(`Rejecting due to ignore word "${matches[0]}": ${tweet.text}`);

        return matches;
      })(ignoreWords || []);

      return shouldIgnore;
    }, tweets);

    const numRejected = numBefore - tweetsAfter.length;

    //winston.info(`${fnName}: ${numRejected} tweet urls rejected`);

    return tweetsAfter;
  }

  /**
   * Filters out url objects containing words on the ignore list.
   */
  filterUrlsWithIgnoreWords(urls, ignoreWords) {
    const fnName = `${moduleName}/filterUrlsWithIgnoreWords`;

    const numUrlsBefore = urls.length;

    const urlsAfter = R.reject((url) => {
      // Discard ignored words.
      const shouldIgnore = R.find((ignoreWord) => {
        // Append urls to text to simplify regexp logic
        const searchString = (typeof url === 'object')
          ? `${url.url} ${url.title} ${url.excerpt}`
          : url;

        const matches = searchString.match(new RegExp(`\\b${ignoreWord}\\b`, 'gi'));

        if (matches) winston.debug(`Rejecting url due to ignore word "${matches[0]}": \
${searchString}`);

        return matches;
      })(ignoreWords || []);

      return shouldIgnore;
    }, urls);

    const numUrlsRejected = numUrlsBefore - urlsAfter.length;

    //winston.info(`${fnName}: ${numUrlsRejected} urls with ignore words rejected after scraping, ${urlsAfter.length} remaining`);

    return urlsAfter;
  }

  /**
   * Merges new url info with old info, preventing duplication.
   */
  mergeUrls(url1, urlMeta) {
    let mergedUrlObj = Object.assign({}, url1);

    // Init if necessary.
    if (!mergedUrlObj.source) {
      mergedUrlObj = Object.assign(mergedUrlObj, {
        source: [],
        sourceDetails: [],
        categories: [],
        tweetTexts: [],
        tweetIDs: [],
        tweetMentionCount: 0,
        tweetFavoriteCount: 0,
        tweetRetweetCount: 0,
        tweetFirstMentionMS: 0,
        tweetLastMentionMS: 0,
        pocketTag: [],
        pocketTimeAdded: [],
        pocketID: [],
      });
    }

    let source, sourceDetails, categories, timestamp;

    if (urlMeta.tweetObj) {
      // Tweet handling.

      // Pull out metadata from the tweet.
      const {
        favorite_count,
        retweet_count,
        listOwner,
        listName,
        text,
        created_at,
        id_str,
        user,
      } = urlMeta.tweetObj;

      // No-op if tweet was already processed.
      const tweetAlreadyProcessed = mergedUrlObj.tweetIDs && (mergedUrlObj.tweetIDs.indexOf(urlMeta.tweetObj.id_str) !== -1);
      if (tweetAlreadyProcessed) return mergedUrlObj;

      const tweetTimeMS = (new Date(created_at)).getTime();

      // Init times if needed.
      if (mergedUrlObj.source.length === 0) {
        mergedUrlObj.tweetFirstMentionMS = tweetTimeMS;
        mergedUrlObj.tweetLastMentionMS = tweetTimeMS;
      }

      source = 'twitter';
      sourceDetails = `${listOwner}/${listName}`;
      mergedUrlObj.tweetTexts = R.union(mergedUrlObj.tweetTexts, [`@${user.screen_name}: ${text}`]);
      timestamp = mergedUrlObj.articleTimestamp || tweetTimeMS;
      mergedUrlObj.tweetMentionCount++;
      mergedUrlObj.tweetRetweetCount += retweet_count;
      mergedUrlObj.tweetFavoriteCount += favorite_count;
      mergedUrlObj.tweetIDs = R.union(mergedUrlObj.tweetIDs, [id_str]);

      // TODO: update mention times
    } else if(urlMeta.pocketObj) {
      // Pocket url processing.

      const {
        username,
        tag,
        time_added,
        item_id
      } = urlMeta.pocketObj;

      const timeAddedMS = time_added * 1000;

      source = 'pocket';
      sourceDetails = username;
      timestamp = mergedUrlObj.articleTimestamp || timeAddedMS;
      mergedUrlObj.pocketTag = R.union(mergedUrlObj.pocketTag, [ tag ]);
      mergedUrlObj.pocketTimeAdded = R.union(mergedUrlObj.pocketTimeAdded, [ timeAddedMS ]);
      mergedUrlObj.pocketID = R.union(mergedUrlObj.pocketID, [ item_id ]);
    }

    if (source) {
      mergedUrlObj.source = R.union(mergedUrlObj.source, [ source ]);
      mergedUrlObj.sourceDetails = R.union(mergedUrlObj.sourceDetails, [ sourceDetails ]);
      mergedUrlObj.timestamp = timestamp;
    }

    // Get categories from url and title.
    const urlPlusTitle = `${mergedUrlObj.url} ${mergedUrlObj.title}`;
    mergedUrlObj.categories = this._getCategoriesFromText(urlPlusTitle, this.categories);

    // Fallback: get categories from excerpt.
    if (mergedUrlObj.categories.length === 0) {
      mergedUrlObj.categories = this._getCategoriesFromText(mergedUrlObj.excerpt, this.categories);
    }

    return mergedUrlObj;
  }

  /**
   * Scraper: Gets url excerpt and other info.  First checks catch, then fetches only on cache
   * misses.
   */
  getUrlDetails(url, urlMeta, done) {
    const fnName = `${moduleName}/getUrlDetails`;

    let urlCopy = url;
    let urlDetailsObj;

    // Sanity check.
    if (!urlCopy) return done();

    // Remove marketing/tracking junk params.
    urlCopy = this.removeJunkURLParams(urlCopy);

    // Check the cache.
    return client.get(`${redisNS}${urlCopy}`, (err, reply) => {
      if (reply) {
        const parsedReply = JSON.parse(reply);

        //winston.debug(`${fnName}: cache hit for ${urlCopy}`);

        // Reject if url is an invalid content type (pdf, jpeg, etc) or had some error (404, etc).
        if (parsedReply.scraperError) return done();

        // Reject if url has been removed previously (e.g. by the user).
        if (parsedReply[urlRemovedFlagKey]) {
          //winston.debug(`${fnName}: removed previously by user: ${urlCopy}`);
          return done();
        }

        // Follow cached redirect if needed.
        const redirectURLIsDifferent = parsedReply.redirect !== urlCopy;
        if (parsedReply.redirect) {
          if (redirectURLIsDifferent) {
            return this.getUrlDetails(`${parsedReply.redirect}`, urlMeta, done);
          } else {
            winston.error(`${fnName}: ignoring circular redirect: ${urlCopy} ${parsedReply.redirect}`);
          } 
        }

        urlDetailsObj = this.mergeUrls(parsedReply, urlMeta);

        // Update cache with merged info.
        client.set(`${redisNS}${urlCopy}`, JSON.stringify(urlDetailsObj));

        return done(null, urlDetailsObj);
      }

      // Cache miss - new url, so scrape the page.
      //winston.debug(`${fnName}: cache miss for ${urlCopy}`);
      return this.fetchUrlDetails(urlCopy, urlMeta, done);
    });
  }

  /**
   * Scraper: gets article excerpt and other info.
   */
  fetchUrlDetails(url, args, done) {
    const fnName = `${moduleName}/fetchUrlDetails`;

    let urlCopy = this.removeJunkURLParams(url);

    // TODO: add functionality for retrying sites that may be overloaded.
    const requestOptions = {
      timeout: 15000
    };

    request(urlCopy, requestOptions, (error, response, body) => {
      let urlDetails = {};

      // Sanity check.
      if (!response) {
        winston.error(`${fnName}: ${urlCopy} returned no response`);
        console.log(error, response, body);

        // Cache result so we don't waste time processing this in the future.
        client.set(`${redisNS}${urlCopy}`, JSON.stringify(Object.assign({}, urlDetails, {
          scraperError: `No response`
        })));

        return done(null, urlDetails);
      }

      const resp = response || { headers: { } };
      const contentType = resp.headers['content-type'];

      if (!contentType) winston.debug(`No content-type found for ${urlCopy}`);

      // Checks for non-HTML content (such as PDFs, etc).
      const isUnsupportedFiletype = !contentType || !contentType.match('text/html');
      if (isUnsupportedFiletype) {
        winston.error(`${fnName}: ${urlCopy} is unsupported content type ${contentType}`);

        // Cache result so we don't waste time processing this in the future.
        client.set(`${redisNS}${urlCopy}`, JSON.stringify(Object.assign({}, urlDetails, {
          scraperError: contentType
        })));

        return done();
      }

      if (error) {
        winston.error(`${fnName}: ${error} for ${urlCopy}`);
        return done(null, urlDetails);
      }

      // Handles bad HTTP status codes.
      if (response.statusCode !== 200) {
        winston.debug(`${fnName}: HTTP ${resp.statusCode} for ${urlCopy}`);

        // Cache result so we don't waste time processing this in the future.
        client.set(`${redisNS}${urlCopy}`, JSON.stringify(Object.assign({}, urlDetails, {
          scraperError: `HTTP ${resp.statusCode}`
        })));

        return done(null, urlDetails);
      }

      // Handle URL redirects.
      const newUrl = response.request.uri.href;
      const wasRedirected = urlCopy !== newUrl;
      urlCopy = this.removeJunkURLParams(newUrl);

      if (wasRedirected) {
        //winston.debug(`${fnName}: redirect, so rewriting ${url} to ${urlCopy}`);

        // Cache redirect info, so this URL won't need to be fetched again.
        client.set(`${redisNS}${url}`, JSON.stringify({
          redirect: urlCopy
        }));
      }

      urlDetails.url = urlCopy;

      // Load HTML body into Cherrio for HTML parsing.
      const $ = cheerio.load(body);

      // Wrap in try-catch for large pages that may fail (needed due to bug in domutils).
      // See http://bit.ly/2iTvQNS
      try {
        //winston.debug(`${fnName}: parsing HTML`);

        // Get page title.
        urlDetails.title = this.getPageTitle($);

        // Get page excerpt.
        urlDetails.excerpt = this.getPageExcerpt.call(this, $);

        urlDetails.articleTwitterAuthor = this.getTwitterAuthor($);

        urlDetails.articleTimestamp = this.getPublishedTime($);
      } catch (e) {
        winston.error(`${fnName}: Failed to parse ${urlCopy}: ${e.message} ${e.stack}`);
      }

      // Add in relevant tweet/Pocket info.
      urlDetails = this.mergeUrls(urlDetails, args);

      // TODO: pocket merge

      // TODO: remove, use redis.setObj instead
      const urlDetailsStr = JSON.stringify(urlDetails);

      //winston.debug(`${fnName}: ${urlCopy} details: ${urlDetailsStr}`);

      // update cache
      client.set(`${redisNS}${urlCopy}`, urlDetailsStr);

      return this.uniqueLPUSH(`${redisNS}urls`, urlCopy, (err, reply) => {
        done(null, urlDetails);
      });
    });
  };

  uniqueLPUSH(key, val, cb) {
    const fnName = `${moduleName}/uniqueLPUSH`;

    cb = cb || (() => {});

    const placeholderVal = '__tempForUniquePush';
    const beforeOrAfterPivot = 'BEFORE';

    // Try to insert placeholder before the value, if it aleady exists.
    return client.linsert(key, beforeOrAfterPivot, val, placeholderVal, (err, linsertReply) => {
      if (err) winston.error(`${fnName}: err`);

      const keyNotFound = linsertReply === -1;
      const listEmpty = linsertReply === 0;
      if (keyNotFound || listEmpty) {
        // Key doesn't exist in list yet, so push it.
        client.lpush(key, val, (err, pushReply) => {
          if (err) winston.error(`${fnName}: err`);
        });
      }

      // Cleanup placeholder.
      return client.lrem(key, 0, placeholderVal, cb);
    });
  }

  /**
   * Scraper: gets time an article was published.
   */
  getPublishedTime($) {
    const now = new Date();
    const MS_IN_A_YEAR = 31536000000;
    const lastYear = (new Date(now - MS_IN_A_YEAR)).getFullYear();
    const currentYear = now.getFullYear();

    let time;
    let timeModified;

    // Attempt to find published time.
    const publishedTag = $(`[property="article:published_time"],
[property="article:post_date"],
[itemprop="datePublished"],
[property="article:published_time"],
[name="date"],
[name="search_date"],
[name="pubdate"],
[property="datePublished"],
[property="DC.date.issued"],
[itemprop="startDate"]
`);
    time = publishedTag.first().attr('content');

    // Fallbacks, with highest as the top priority.
    let fallbackMatches = [];
    let likelyMatches = [];
    if (!time) {
      const fallbackTimeTags = [
        'time',
        '[datetime]',
        'h2[class*="datetime"], h2[id*="datetime"], h2[class*="date"], h2[id*="date"]',
        '[class*="datetime"], [id*="datetime"], [class*="date"], [id*="date"]',
        '[class*="published"], [id*="published"]',
        'h2',
        '[class*="meta"], [id*="meta"]'
      ];

      const processTagObj = (index, tagElt) => {
        const curElt = $(tagElt)[0] || tagElt;
        const hasChildren = curElt.children && curElt.children.length > 1;
        if (hasChildren) {
          $(tagElt)[0].children.forEach((child, index) => processTagObj(index, child));
        } else {
          let txt = $(tagElt).first().text();
          const isLikelyYear = txt.match(new RegExp(`${currentYear}|${lastYear}`), 'gi');

          if (txt) {
            if (isLikelyYear) {
              likelyMatches.push(txt);
            } else {
              fallbackMatches.push(txt);
            }
          }
        }
      };

      fallbackTimeTags.forEach((tag) => {
        const tagElts = $(tag);

        tagElts.each(processTagObj);
      });

      time = likelyMatches[0] || fallbackMatches[0] || '';
    }

    // Attempt to find updated time.
    const updatedTag = $(`[property="article:post_modified"],
[itemprop="dateModified"],
[itemprop="endDate"],
[name="revised"],
[name="last-modified"],
[name="last-updated"]`);
    timeModified = updatedTag.first().attr('content');

    if (!timeModified) {
      const updatedTag = $('[class*="updated"], [id*="updated"]');
      timeModified = updatedTag.first().text();
    }


    // If no published time, but only modified time, use the latter.
    if (!time && timeModified) {
      time = timeModified;
    }

    // Note: brackets seem to throw off the parser.
    time = time.replace(/\[|\]/g, '');

    // Remove stuff that doesn't look like a date.
    const stuffThatLookLikeDates = [
      '\\d',
      '-',
      '\\s',
      '\\+',
      'th',
      'T',
      ':',
      'am',
      'pm',
      '\\.',
      'Z'
    ];
    const months = [
      'january',
      'jan',
      'february',
      'feb',
      'march',
      'mar',
      'april',
      'apr',
      'may',
      'june',
      'jun',
      'july',
      'jul',
      'august',
      'aug',
      'september',
      'sept',
      'sep',
      'october',
      'oct',
      'november',
      'nov',
      'december',
      'dec'
    ];
    const acceptableStrings = stuffThatLookLikeDates.concat(months).join('|');
    const regexp = new RegExp(acceptableStrings, 'gi');
    time = time.match(regexp);
    if (time) time = time.join('').trim();

    // Convert to timestamp.
    let timestamp;
    if (time) {
      timestamp = new Date(time);
      timestamp = timestamp.getTime();
    }

    const isInvalidDate = Number.isNaN(timestamp);
    if (isInvalidDate && time) {
      // Try parsing human-readable time
      timestamp = parseMessyTime(time);
      timestamp = timestamp.getTime();
    }

    return timestamp || 0;
  }

  stripNonAlphaNumeric(str = '') {
    return str.replace(/[^a-zA-Z\d:_]/gi, '');
  }

  /**
   * Scraper: gets the Twittle handle of the article author.  Note: often this turns out to be the
   * platform's Twitter handle instead of the actual author (e.g. "@wallstreetjournal instead of
   * @joeschmoe").
   */
  getTwitterAuthor($) {
    let author = '';
    let via = '';
    let screen_name = '';

    // Look for a Twitter creator card.
    const twitterCreatorTag = $('[name="twitter:creator"]');
    author = twitterCreatorTag.attr('content');

    // Next look for link tag.
    let linkTagMatches = [];
    if (!author) {
      const twitterLinkTags = $('a[href*="twitter.com/"]');

      twitterLinkTags.each((index, linkTag) => {
        if (linkTag) {
          const isComment = $(linkTag).closest('[class*="Comment"], [id*="Comment"], [class*="comment"], [id*="comment"]').length > 0;
          if (isComment) return;

          const isLikelyAuthor = $(linkTag).closest('[class*="Attribution"], [id*="Attribution"], [class*="attribution"], [id*="attribution"], footer').length > 0;

          let href = linkTag.attribs.href;
          if (href) {
            // Fix for protocol-less urls (url util has problems with them).
            const hasProtocol = !!href.match(/http:\/\/|https:\/\//);
            if (!hasProtocol) {
              href = href.replace(/(\/\/)?twitter.com/, `https://twitter.com`);
            }

            // Fix for hashbangs.
            href = href.replace(/#\!\//, '');

            // Ignore tweets, share, etc.
            const isTweet = href.match(/(\/status\/)+/i);
            const isShare = href.match(/(\/twitter.com\/share\??)+/i);
            const isSearch = href.match(/(\/twitter.com\/search\??)+/i);
            const isHome = href.match(/(\/twitter.com\/home\??)+/i);
            const isIntent = href.match(/(\/intent\/)+/i);

            // See if we can extract a Twitter name.
            const parsedURL = urlUtil.parse(href, true);
            if (isIntent || isShare || isSearch || isHome) {
              via = via || R.path(['query', 'via'], parsedURL);
              screen_name = screen_name || R.path(['query', 'screen_name'], parsedURL);
            } else if (!isTweet) {
              if (isLikelyAuthor) {
                linkTagMatches.unshift(R.path(['pathname'], parsedURL));
              } else {
                linkTagMatches.push(R.path(['pathname'], parsedURL));
              }
            }
          }
        }
      });

      author = linkTagMatches[0];
    }

    // Next look for a Twitter site card.
    if (!author) {
      const twitterSiteTag = $('[name="twitter:site"]');
      author = twitterSiteTag.attr('content');
    }

    if (!author) author = screen_name || via;

    if (!author) {
      author = '';
    } else {
      // Strip out junk url params
      author = author.split('?')[0];
    }

    // Strip out unwanted characters.
    author = this.stripNonAlphaNumeric(author);

    return author;
  }

  /**
   * Scraper: gets the title of the article.
   */
  getPageTitle($) {
    let title;

    // First check for open graph title.
    const ogTitleTag = $('[property="og:title"]');
    title = ogTitleTag.attr('content');

    // Next check for Twitter card.
    if (!title) {
      const twitterTitleTag = $('[name="twitter:title"]');
      title = twitterTitleTag.attr('content');
    }
    
    // Next check for good old fashioned page title.
    if (!title) {
      const titleTag = $('title');
      title = titleTag.first().text().trim();
    }

    return title.substr(0, 150) || '';
  }

  /**
   * Scraper: gets an excerpt from the beginning of an article.
   */
  getPageExcerpt($) {
    let excerpt = '';

    // Check for Open Graph description.
    const ogDescriptionTag = $('[property="og:description"]');
    excerpt = ogDescriptionTag.attr('content');

    // Check for Twitter description.
    if (!excerpt) {
      const twitterDescriptionTag = $('[name="twitter:description"]');
      excerpt = twitterDescriptionTag.attr('content');;
    }

    // Check for regular meta description tag.
    if (!excerpt) {
      const metaDescriptionTag = $('[name="description"]');
      excerpt = metaDescriptionTag.attr('content');
    }

    // Fallback to scraping the first paragraph.
    if (!excerpt) {
      // Find the first paragraph containing more than 20 words, then use that as an excerpt.
      // Note: don't use fat arrow here because 'this' context needs to NOT be outer closure
      // context.
      const paragraphs = $('*:not(aside) p');
      paragraphs.each(function processParagraph() {
        // TODO: DON'T traverse ALL ps
        if (!excerpt && $(this).text().split(/\s+/).length > 10) {
          excerpt = $(this).text();
        }
      });
    }

    if (!excerpt) return '';

    // Strip out certain HTML tags, plus preserve when needed.
    const tagsToStrip = [
      'a',
      'strong',
      'br',
      'b',
      'i'
    ];

    const tagsToStripRegEx = tagsToStrip.join('|');

    const censoredOpeningTags = new RegExp(`(&lt;|<)(\\s)*((?:(${tagsToStripRegEx})))+(\\s|\\w|=|"|'|&quot;|\:|\\/|\\.)*(>|&gt;)?`, 'gi');
    const censoredClosingTags = new RegExp(`(&lt;|<)(\\s)*\/(\\s)*((?:(${tagsToStripRegEx})))+(\\s|\\w|=|"|')*(>|&gt;)?`, 'gi');
    excerpt = excerpt.replace(censoredOpeningTags, '');
    excerpt = excerpt.replace(censoredClosingTags, '');

    // Create placeholders for ok HTML tags.
    excerpt = excerpt.replace(new RegExp(`(&lt;|<)(?:\s*)?`, 'gi'), '--lt--');
    excerpt = excerpt.replace(new RegExp(`>|&gt;`, 'gi'), '--gt--');

    excerpt = excerpt.replace(/&gt;|>/gi, '--gt--');
    const $$ = cheerio.load(`<div id="stripFn">${excerpt}</div>`);
    excerpt = $$('#stripFn').text();

    // Replace placeholders for ok HTML tags.
    excerpt = excerpt.replace(/--lt--/gi, '&lt;');
    excerpt = excerpt.replace(/--gt--/gi, '&gt;');

    // Trim excerpt.
    const maxLength = 200;
    excerpt = excerpt.split(' ').reduce((a, b) => {return (a.length > maxLength) ? a : `${a} ${b}`});

    return excerpt;
  }

  /**
   * Filters out non-articles (e.g. links to other tweets).
   */
  filterNonArticles(urls) {
    const fnName = `${moduleName}/filterNonArticles`;

    const numUrlsBefore = urls.length;

    const isNonArticle = (url) => {
      const urlStr = (typeof url === 'object') ? url.url : url;
      return urlStr.match('twitter.com');
    }
    const filteredUrls = R.reject(isNonArticle, urls);
    const numUrlsRejected = numUrlsBefore - filteredUrls.length;
    //winston.debug(`${fnName}: discarded ${numUrlsRejected} non-article urls (tweets only)`);

    return filteredUrls;
  }

  /**
   * Filters out old articles.
   */

  filterStaleUrls(urlObjects, prop = 'timestamp', expiry = msInAMonth) {
    const fnName = `${moduleName}/filterStaleUrls`;

    const numUrlsBefore = urlObjects.length;
    
    const isURLStale = (url) => {
      if(!url) {
        winston.error(`${fnName}: url object is null`);
        return true;
      }
      const timestamp = (typeof prop === 'function') ? prop(url) : url[prop];
      const timestampArr = (Array.isArray(timestamp)) ? timestamp : [ timestamp ];

      let isFresh;
      if (typeof expiry === 'function') {
        // Special expiry function passed in, so use that.
        isFresh = R.any(timeMS => expiry(url, timeMS))(timestampArr);
      } else {
        // Normal: find expiry by cutoff time.
        const cutoffTimeMS = Date.now() - expiry;
        isFresh = R.any(timeMS => timeMS > cutoffTimeMS)(timestampArr);
      }

      return !isFresh;
    }
    const flattenedUrlObjects = R.reject(isURLStale, urlObjects);
    const numUrlsRejected = numUrlsBefore - flattenedUrlObjects.length;
    //winston.debug(`${fnName}: discarded ${numUrlsRejected} stale urls`);

    return flattenedUrlObjects;
  }

  /**
   * Pulls out urls from each tweet.
   */
  tweetsToURLs(tweets, args, done) {
    const fnName = `${moduleName}/tweetsToURLs`;

    //winston.debug(`${fnName}: processing ${tweets.length} tweets...`);

    this._timerStart(fnName);

    const parallelFns = R.map((tweet) => ((parallelCb) => this.tweetToURLs(tweet, args, parallelCb)), tweets);
    async.parallelLimit(parallelFns, 5, (err, reply) => {
      //winston.debug(`${fnName} parallelLimit reply:`, reply);

      this._timerEnd(fnName);

      const flattenedUrlObjectsUnfiltered = R.flatten(reply);

      // Remove rejected urls.
      let flattenedUrlObjects = R.reject(R.isNil, flattenedUrlObjectsUnfiltered);

      // Filter out old urls.
      flattenedUrlObjects = this.filterStaleUrls(flattenedUrlObjects, 'articleTimestamp');
      const staleURLObjects = R.differenceWith((x, y) => x && y && x.url === y.url, flattenedUrlObjectsUnfiltered, flattenedUrlObjects);
      const staleURLs = R.map((obj) => {
        if (!obj) return;
        const timestamp = new Date(obj.articleTimestamp);
        const url = obj.url;
        return `${timestamp}: ${url}`
      }, staleURLObjects);

      winston.debug(`${fnName}: ${staleURLs.length} stale Twitter urls`, JSON.stringify(staleURLs, null, 2));

      // Filter out urls not articles (e.g. tweets themselves).
      flattenedUrlObjects = this.filterNonArticles(flattenedUrlObjects);

      // Filter out ignore words/websites.
      flattenedUrlObjects = this.filterUrlsWithIgnoreWords(flattenedUrlObjects, args.ignoreWords);

      return done(err, flattenedUrlObjects);
    });
  }

  /*
   * Pulls out urls from tweets, and scrapes each individual url.
   */
  tweetToURLs(tweet, args, done) {
    const fnName = `${moduleName}/tweetToURLs`;

    // Make a copy of the tweet.
    let tweetObj = Object.assign({}, tweet);

    // If this tweet includes a quoted tweet, reference the original quoted tweet instead.
    if (tweetObj.quoted_status) tweetObj = tweetObj.quoted_status;
    if (tweetObj.retweeted_status) tweetObj = tweetObj.retweeted_status;

    // Add Twitter list owner and name to tweet object.
    tweetObj.listOwner = args.owner;
    tweetObj.listName = args.name;

    // Find each url in tweet, and treat it individually.
    const urlObjs = R.path(['entities', 'urls'], tweetObj);
    let tweetURLs = R.pluck('expanded_url')(urlObjs);


    // Filter out non-articles (e.g. tweets)
    tweetURLs = this.filterNonArticles(tweetURLs);

    // Filter out links which already match ignore words.
    tweetURLs = this.filterUrlsWithIgnoreWords(tweetURLs, args.ignoreWords);

    // Create parallel async functions for each URL present.
    const parallelFns = [];
    R.forEach((url) => {
      parallelFns.push((parallelCb) => {
        // Get scraped info for this url.
        this.getUrlDetails(url, { tweetObj }, (err, urlDetailsObj) => {
          // Return early if url was rejected.
          if (!urlDetailsObj) return parallelCb();

          return parallelCb(null, urlDetailsObj);
        });
      });
    }, tweetURLs);

    async.parallelLimit(parallelFns, 5, done);
  }

  /*
   * Assembles URL search parameters from an object.
   * { foo: 'bar', boo: 'baz' } -> 'foo=bar&boo=baz'
   */
  objToFormattedURLParams(params) {
    const keys = Object.keys(params);

    // Sanity check; makes sure there's query params to process.
    if (!params || keys.length === 0) return '';

    // Only one param to process.
    if (keys.length === 1) return `${keys[0]}=${params[keys[0]]}`;

    // Multiple params to process.
    return Object.keys(params).reduce((a, b) => {
      let output = '';

      if (typeof params[a] !== 'undefined') {
        // First iteration.
        output = `${a}=${params[a]}`;
      } else {
        // nth iteration.
        output = `${a}`;
      }

      return `${output}&${b}=${encodeURIComponent(params[b])}`;
    });
  }

  /*
   * Removes query params from a url.  These params are often used for campaign tracking.
   * TODO: url transforms for login redirects, e.g.
   * https://myaccount.nytimes.com/auth/login?URI=https://www.nytimes.com/2017/01/01/technology/google-amp-mobile-publishing.html?_r=0
   * https://www.forbes.com/forbes/welcome/?toURL=http://forbes.com/
   *
   * TODO: make case insensitive
   */
  removeJunkURLParams(url, removeConfig) {
    const removeParams = removeConfig || defaultJunkParams;

    let outputURL;
    const urlParsed = urlUtil.parse(url, true);
    const query = urlParsed.query;

    // Remove junk params.
    removeParams.forEach((param) => {
      if (typeof param === 'string') {
        delete query[param];
      } else if (typeof param === 'object' && !param['__comment']) {
        const hostname = (typeof urlParsed.hostname === 'string') ?
          [ urlParsed.hostname ] :
          urlParsed.hostname;

        // Domain-specific param removal.
        const domainMatches = param.domain.indexOf(urlParsed.hostname) !== -1;

        if (domainMatches) {
          param.params && param.params.forEach(param2 => delete query[param2]);

          if (param.removeHash) urlParsed.hash = '';
        }
      }
    });

    const queryFormatted = this.objToFormattedURLParams(query);

    urlParsed.search = (queryFormatted) ? `?${queryFormatted}` : '';

    outputURL = urlParsed.format();

    // Remove trailing slashes for consistency.
    // const hasTrailingSlash = outputURL[outputURL.length - 1] === '/';
    // if (hasTrailingSlash) {
    //   outputURL = outputURL.substr(0, outputURL.length - 1);
    // }

    return outputURL;
  }

  /*
   * Helper to utility to track down any required arguments passed to a function that are undefined.
   */
  findUndefinedArgs(passedInArgs, requiredArgs) {
    const undefinedArgNames = [];

    requiredArgs.forEach((arg) => {
      if (typeof passedInArgs[arg] === 'undefined') undefinedArgNames.push(arg);
    });

    return undefinedArgNames;
  }

  /**
   * Assigns a rank (1-10) to each url, with 10 being the best.
   */
  rankUrls(urlObjects) {
    let rankedUrls = [];

    const faveSegments = this.getObjSegments('tweetFavoriteCount', urlObjects);
    const retweetSegments = this.getObjSegments('tweetRetweetCount', urlObjects);
    const pocketSegments = this.getPocketSegments(urlObjects);

    urlObjects.forEach((urlObj) => {
      const urlObjCopy = Object.assign({}, urlObj);

      // Ignore urls thrown out by a previous filter.
      if (!urlObjCopy.url) return;

      urlObjCopy.rankRaw = this.getURLRank(urlObjCopy, {
        faveSegments,
        retweetSegments,
        pocketSegments
      });

      rankedUrls.push(urlObjCopy);
    });

    rankedUrls = this.normalizeRanks(rankedUrls);

    return rankedUrls;
  }

  /**
   * Sorts, normalizes rank distributions, and converts to 1-10 scale.
   */
  normalizeRanks(urlObjs) {
    let urlsCopy = urlObjs.concat();

    // Sort by rank.
    urlsCopy = R.sortWith([
      R.descend(R.prop('rankRaw')),
      R.descend(R.prop('tweetRetweetCount')),
      R.descend(R.prop('tweetFavoriteCount')),
      R.descend(R.prop('timestamp'))
    ])(urlsCopy);

    // Figure out size of each 10% segment.
    let urlsCopyRanks = R.pluck('rankRaw')(urlsCopy);
    urlsCopyRanks = R.uniq(urlsCopyRanks);
    const segments = this.getStandardizedSegments(urlsCopyRanks);

    urlsCopy = urlsCopy.map((urlObj) => {
      let rank = this.getSegmentPosition(urlObj.rankRaw, segments) + 1;
      return Object.assign({}, urlObj, { rank });
    });

    return urlsCopy;
  }

  numDiff(a, b) {
    return a - b;
  }

  getStandardizedSegments(arr, totalSegments = 10) {
    let arrSorted = R.sort(this.numDiff, arr);

    if (arrSorted.length < totalSegments) {
      const arrFillerSize = totalSegments - arrSorted.length;
      let fillerArr = new Array(arrFillerSize);
      fillerArr = fillerArr.fill(0);
      arrSorted = fillerArr.concat(arrSorted);
    }

    const arrSegmentSize = arrSorted.length / totalSegments;
    const isSegmentAnInt = Number.isInteger(arrSegmentSize);

    const segments = [];
    for (let index = arrSegmentSize - 1; index < arrSorted.length; index += arrSegmentSize) {
      let segmentVal;
      if (isSegmentAnInt) {
        segmentVal = arrSorted[index];
      } else {
        const indexInt = Math.floor(index);
        segmentVal = arrSorted[indexInt] + (arrSorted[indexInt] / totalSegments);
      }
      segments.push(segmentVal);
    }
    return segments;
  }

  /**
   * Returns the closest index for a rank within a group of rank segments (for ranking).
   * E.g. rank: 3, segments: [1,3,10] will return index 1
   */
  getSegmentPosition(rank, segments) {
    const fnName = `${moduleName}/getSegmentPosition`;
    const segmentsSorted = R.sort(R.gt, segments);

    let position = -1;

    for (let a=0, len=segmentsSorted.length; a<len; a++) {
      if(rank > segmentsSorted[a]) {
        continue;
      } else {
        position = a;
        break;
      }
    }

    if (position == -1) {
      position = segmentsSorted.length - 1;
    }

    //position++;

    return position;
  }

  /**
   * Determines the ranking of a url based on its presence on Twitter/Pocket lists, and number
   * of times it's been faved/retweeted.
   * TODO: trusted sources ranking
   */
  getURLRank(urlObj, args) {
    const fnName = `${moduleName}/getURLRank`;

    const {
      faveSegments,
      retweetSegments,
      pocketSegments
    } = args;

    const {
      url,
      tweetRetweetCount,
      tweetFavoriteCount,
      pocketTimeAdded
    } = urlObj;

    const faveVal = tweetFavoriteCount || 0;
    const retweetVal = tweetRetweetCount || 0;
    const pocketVal = pocketTimeAdded.length || 0;

    const faveRanking = this.getSegmentPosition(faveVal, faveSegments);
    const retweetRanking = this.getSegmentPosition(retweetVal, retweetSegments);
    const pocketRanking = this.getSegmentPosition(pocketVal, pocketSegments);

    const rankingArr = [pocketRanking, retweetRanking, faveRanking];

    // Join ranks together with string concatenation.
    let ranking = rankingArr.join('');
    
    ranking = parseFloat(ranking) * 1000;

    return ranking;
  }

  normalizeVal(val, min, max, newMin, newMax) {
    const fnName = `${moduleName}/normalizeVal`;

    // Sanity checking.
    const args = [val, min, max, newMin, newMax];
    args.forEach((arg, index) => {
      if (typeof arg !== 'number' || Number.isNaN(arg)) {
        winston.error(`${fnName}: input argument index ${index} is not a number.`);
        return 0;
      }
    });

    let percentage = (val - min) / (max - min);

    // Sanity check - check for division by 0.
    if (Number.isNaN(percentage)) {
      percentage = 0;
    }

    const outputVal = newMin + ((newMax - newMin) * percentage);

    return outputVal;
  }

  /**
   * Determines the largest number of Tweet favorites.  Needed for relative ranking of Twitter
   * links.
   */
  getMaxTweetFavoriteCount(urlObjects) {
    const fnName = `${moduleName}/getMaxTweetFavoriteCount`;
    if (urlObjects.length === 0) return 0;

    const sort = R.sortBy((a) => a.tweetFavoriteCount || 0);
    const urlsObjectsSorted = sort(urlObjects);
    const maxItem = urlsObjectsSorted[urlsObjectsSorted.length - 1];

    if (!maxItem) {
      winston.error(`${fnName}: maxItem is null`);
      console.log(JSON.stringify(urlsObjectsSorted, null, 2))
      return 0;
    }

    return R.prop('tweetFavoriteCount', maxItem) || 0;
  }

  /**
   * Determines the segment distribution of favorites.  Used for ranking, to ensure that numbers
   * are scaled correctly (e.g. so that a high value such as 1000 [rank 10] doesn't outweigh
   * everything else, and push all their ranks to 1).
   */
  getObjSegments(key, urlObjects) {
    const fnName = `${moduleName}/getObjSegments`;
    if (urlObjects.length === 0) return 0;

    const arr = R.pluck(key, urlObjects);
    return this.getStandardizedSegments(arr);
  }

  getPocketSegments(urlObjects) {
    const fnName = `${moduleName}/getPocketSegments`;
    if (urlObjects.length === 0) return 0;

    const key = 'pocketTimeAdded';
    let arr = R.pluck(key, urlObjects);
    arr = arr.map((ar) => ar && R.prop('length', ar));

    return this.getStandardizedSegments(arr);
  }

  /**
   * Fetches Pocket and Twitter urls lists.
   */
  fetchLists(lists, done) {
    const fnName = `${moduleName}/fetchLists`;
    const parallelFns = [];

    this._timerStart(fnName);

    client.get(`${redisNS}${redisIsFetchingKey}`, (err, reply) => {
      if (reply !== '0') {
        winston.debug(`${fnName}: list fetching already active.`);
        return done(`${fnName}: list fetching already active.`);
      } else {
        winston.debug(`${fnName}: starting list fetching`);
      }

      return client.set(`${redisNS}${redisIsFetchingKey}`, Date.now(), (err, reply) => {
        if (err) winston.error(`${fnName} redis set error: ${err}`);

        // Pocket
        lists.pocket.forEach((pocketList) => {
          // Separate call for each Pocket tag.
          winston.debug(`${fnName} Pocket ${pocketList.username}`);
          pocketList.tags.forEach((tag) => {
            let pocketArgs = Object.assign({}, pocketList, { tag });
            parallelFns.push((parallelCb) => this.fetchPocketList(pocketArgs, parallelCb));
          });
        });

        // Twitter
        lists.twitter.forEach((twitterList) => {
          winston.debug(`${fnName} Twitter`, twitterList);
          parallelFns.push((parallelCb) => this.fetchTwitterList(twitterList, parallelCb));
        });

        // No-op, no lists to process.
        if (parallelFns.length === 0) {
          winston.debug(`${fnName}: no lists to fetch`);
          client.set(`${redisNS}${redisIsFetchingKey}`, 0);
          return done(`${fnName}: no lists to fetch`);
        }

        return async.parallelLimit(parallelFns, 2, (err, urls) => {
          if (err) winston.error(`${fnName} parallelLimit error: ${err}`);

          // Combine with old url objects if present.
          const oldList = R.path(['oldList', 'list'], lists) || [];
          const oldListLength = R.path(['length'], oldList) || 0;

          const pocketLength = R.path([0, 'length'], urls) || 0;
          const twitterLength = R.path([1, 'length'], urls) || 0;

          winston.debug(`${fnName}: ${oldListLength} old urls.`);
          winston.debug(`${fnName}: ${pocketLength} new Pocket urls.`);
          winston.debug(`${fnName}: ${twitterLength} new Twitter urls.`);

          // Combine all lists together.
          let allUrls = R.flatten(urls, oldList);

          // Reject null urls.  TODO: investigate further up why this is happening.
          allUrls = R.reject(R.isNil, allUrls);

          // Remove dupes.
          winston.debug(`${fnName}: ${allUrls.length} urls before dupe removal.`);

          // TODO: uniqWith instead?
          allUrls = R.unionWith(R.eqBy(R.prop('url')), allUrls, oldList);
          winston.debug(`${fnName}: ${allUrls.length} after dupe removal.`);

          // Filter out old urls.
          winston.debug(`${fnName}: ${allUrls.length} urls before removing stale urls.`);
          const getTime = (obj) => {
            const pocketTimeAdded = R.path('pocketTimeAdded', 'length', obj) || 0;
            
            if (pocketTimeAdded > 0) {
              // TODO: return newest time instead
              return obj.pocketTimeAdded[0];
            } else {
              return obj.articleTimestamp;
            }
          };
          allUrls = this.filterStaleUrls(allUrls, getTime);

          // 1-10 ranking.
          allUrls = this.rankUrls(allUrls);

          // Remove old low-ranking articles.
          const now = Date.now();
          allUrls = this.filterStaleUrls(allUrls, getTime, (urlObj, timeMS) => {
            const olderThanAWeek = now - timeMS > msInAWeek;
            const isStale = urlObj.rank < 6 && olderThanAWeek;
            return !isStale;
          });
          winston.debug(`${fnName}: ${allUrls.length} urls after removing stale urls.`);

          this._timerEnd(fnName);
          client.set(`${redisNS}${redisIsFetchingKey}`, 0);

          return done(null, allUrls);
        });
      });
    });
  }

  /*
   * Gets tweets from a user's Twitter list.  With keyword filtering to discard irrelevant tweets.
   */
  fetchTwitterList(args, done) {
    const fnName = `${moduleName}/fetchTwitterList`;
    winston.debug(`${fnName} ${args.owner}/${args.name}`);

    const argsCopy = Object.assign({}, args);

    this._timerStart(fnName);

    this._asyncGetTwitterList(argsCopy, (err, tweets) => {
      this._timerEnd(fnName);

      // Sanity checks
      if (err) return done(`${fnName} ${err}`);
      if (tweets.length === 0) {
        const noTweetsError = `${fnName} No tweets - network problems?`;
        winston.error(noTweetsError);
        return done(noTweetsError);
      }

      //winston.debug(`${fnName}: ${tweets.length} tweets returned before processing.`);

      // Filter out obviously irrelevant tweets.  After url scraping, we'll have to run this again.
      let filteredTweets = this.filterTweets(tweets, this.ignoreWords);

      // Pare down list to a manageable size.
      //filteredTweets = filteredTweets.splice(0, 300);

      argsCopy.ignoreWords = this.ignoreWords;

      // Data massaging for each tweet.
      return this.tweetsToURLs(filteredTweets, argsCopy, done);
    });
  }

  /*
   * Gets a user's Pocket list.  No keyword filtering needed here, as Pocket is more curated
   * already.
   * TODO: pagination
   * TODO: replace fetch and Promises
   */
  fetchPocketList(args, done) {
    const fnName = `${moduleName}/fetchPocketList`;
    winston.debug(`${fnName}: ${args.username}`);

    done = done || (() => {});

    const argsCopy = Object.assign({}, args);
    const { consumerKey, accessToken, apiUrl, fetchStub } = argsCopy;
    const username = argsCopy.username || '';
    const tag = argsCopy.tag || '';

    // Sanity checks.
    const argsNotPresent = this.findUndefinedArgs(args, ['consumerKey', 'accessToken', 'apiUrl']);

    if (argsNotPresent.length > 0) {
      const argsNotPresentStr = argsNotPresent.join(', ');
      const argsNotPresentError = `${fnName} error: required args are not present: ${argsNotPresentStr}`;
      winston.error(argsNotPresentError);
      return done(argsNotPresentError);
    }

    // Use fetchStub for tests.
    const fetchAction = fetchStub || fetch;

    this._timerStart(fnName);

    const maxAgeTimestampMS = Date.now() - msInAMonth;
    const maxAgeTimestampS = maxAgeTimestampMS / 1000;

    const fetchPocket = fetchAction(apiUrl, {
      method: 'post',
      mode: 'cors',
      body: JSON.stringify({
        // See http://www.jamesfmackenzie.com/getting-started-with-the-pocket-developer-api/
        consumer_key: consumerKey,
        access_token: accessToken,
        tag,
        since: maxAgeTimestampS
      }),
      headers: {
        'X-Accept': 'application/json',
        'Content-Type': 'application/json; charset=UTF8'
      }
    })
    .then(response => {
      if (!response.ok) {
        return new Error(`${fnName}: ${apiUrl} HTTP status ${response.status}`);
      }

      return response.json();
    });

    // TODO: make timeout configurable.
    const timeout = new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('request timeout')), 8000);
    });

    Promise.race([
      fetchPocket,
      timeout
    ])
    .then((pocketAPIResponse) => {
      this._timerEnd(fnName);

      winston.debug(`${fnName} pocket response for ${username} status: ${pocketAPIResponse.status} complete: ${pocketAPIResponse.complete} error: ${pocketAPIResponse.error}`);

      return this.pocketToURLs(pocketAPIResponse, {
        tag,
        username
      }, (err, response) => {
        if (err) winston.error(`${fnName} pocketToURLs: ${err}`);
        done(err, response);
      });
    })
    .catch(error => {
      const pocketResponseError = `${fnName}: ${error.message}`;
      winston.error(pocketResponseError);
      done(pocketResponseError);
    });
  }

  /**
   * Converts a raw Pocket object into a formatted URL object.
   */
  pocketToURL(pocketUrlObj, args, done) {
    const fnName = `${moduleName}/pocketToURL`;

    //winston.debug(fnName);

    const urlDetailsArgs = {
      pocketObj: Object.assign({}, pocketUrlObj, args)
    };

    // Get scraped info for this url.
    return this.getUrlDetails(pocketUrlObj.resolved_url, urlDetailsArgs, (err, urlDetailsObj) => {
      if (err) winston.error(`${fnName} getUrlDetails: ${err}`);

      // Return early if url was rejected.
      if (!urlDetailsObj) return done();

      return done(null, urlDetailsObj);
    });
  }

  /**
   * Converts raw Pocket objects into formatted URL objects.
   */
  pocketToURLs(pocketAPIResponse, args, done) {
    const fnName = `${moduleName}/pocketToURLs`;

    //winston.debug(fnName);

    const pocketURLsUnfiltered = R.values(pocketAPIResponse.list);

    // Filter out old urls.
    let pocketURLs = this.filterStaleUrls(pocketURLsUnfiltered, (obj) => R.prop('time_added', obj) * 1000);
    const stalePocketURLObjects = R.differenceWith((x, y) => x.url === y.url, pocketURLsUnfiltered, pocketURLs);
    const stalePocketURLs = R.pluck('url', stalePocketURLObjects);
    winston.debug(`${fnName}: ${stalePocketURLs.length} stale Pocket urls found`, stalePocketURLs);
    winston.debug(`${pocketURLs.length} Pocket links returned before processing.`);

    const parallelFns = pocketURLs.map((obj) => (parallelCb) => {
      const urlObj = this.pocketToURL(obj, args, parallelCb);

      //winston.debug(`${fnName}: ${obj.resolved_url}`);

      return urlObj;
    });

    return async.parallelLimit(parallelFns, 5, (err, urlObjs) => {
      if (err) winston.error(`${fnName} parallelLimit: err`);

      let urlObjsCopy = urlObjs.concat();

      return done(null, urlObjsCopy);
    });
  }
}

module.exports = Aggregator;
