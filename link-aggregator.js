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

winston.level = 'debug';

const client = redis.createClient();

// Keep track of module name for logging purposes.
const moduleName = 'link-aggregator';

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

const msInAWeek = 7 * 24 * 60 * 60 * 1000;

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

      if (Array.isArray(regexp)) regexp = regexp.join('|');

      regexp = new RegExp(regexp, 'gi');

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

        argsCopy.max_id = reply[reply.length - 1].id;
        return this._asyncGetTwitterList(argsCopy, cb);
      }
    );
  }

  /**
   * Searches a text string for matching categories.
   */
  _getCategoriesFromText(text, categories) {
    const fnName = `${moduleName}/_getCategoriesFromText`;

    let cats = [];
    const categoriesCopy = categories || [];

    cats = R.filter((category) => text.match(category.keywords.regexp))(categoriesCopy);

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

        if (matches) winston.debug(`Rejecting due to ignore word "${matches[0]}": ${tweet.text}`);

        return matches;
      })(ignoreWords || []);

      return shouldIgnore;
    }, tweets);

    const numRejected = numBefore - tweetsAfter.length;

    winston.info(`${fnName}: ${numRejected} tweet urls rejected`);

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
        const searchString = `${url.url} ${url.title} ${url.excerpt}`;

        const matches = searchString.match(new RegExp(ignoreWord, 'gi'));

        if (matches) winston.debug(`Rejecting url due to ignore word "${matches[0]}": ${url.url}`);

        return matches;
      })(ignoreWords || []);

      return shouldIgnore;
    }, urls);

    const numUrlsRejected = numUrlsBefore - urlsAfter.length;

    winston.info(`${fnName}: ${numUrlsRejected} urls with ignore words rejected after scraping, ${urlsAfter.length} remaining`);

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
        url,
        title,
        excerpt,
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
      categories = this._getCategoriesFromText(`${text} ${mergedUrlObj.url} ${mergedUrlObj.title} ${mergedUrlObj.excerpt}`, this.categories);
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
        url,
        title,
        excerpt,
        username,
        tag,
        time_added,
        item_id
      } = urlMeta.pocketObj;

      const timeAddedMS = time_added * 1000;

      source = 'pocket';
      sourceDetails = username;
      categories = this._getCategoriesFromText(`${mergedUrlObj.title} ${mergedUrlObj.url} ${excerpt}`, this.categories);
      timestamp = mergedUrlObj.articleTimestamp || timeAddedMS;
      mergedUrlObj.pocketTag = R.union(mergedUrlObj.pocketTag, [ tag ]);
      mergedUrlObj.pocketTimeAdded = R.union(mergedUrlObj.pocketTimeAdded, [ timeAddedMS ]);
      mergedUrlObj.pocketID = R.union(mergedUrlObj.pocketID, [ item_id ]);
    }

    if (source) {
      mergedUrlObj.source = R.union(mergedUrlObj.source, [ source ]);
      mergedUrlObj.sourceDetails = R.union(mergedUrlObj.sourceDetails, [ sourceDetails ]);
      mergedUrlObj.categories = R.union(mergedUrlObj.categories, categories);
      mergedUrlObj.timestamp = timestamp;
    }

    return mergedUrlObj;
  }

  /**
   * Scraper: Gets url excerpt and other info.  First checks catch, then fetches only on cache misses.
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

        // Follow cached redirect if needed.
        if (parsedReply.redirect) {
          return this.getUrlDetails(`${parsedReply.redirect}`, urlMeta, done);
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

    const requestOptions = {
      timeout: 8000
    };

    request(urlCopy, requestOptions, (error, response, body) => {
      let urlDetails = {};

      // Sanity check.
      if (!response) {
        winston.error(`${fnName}: ${urlCopy} returned no response`);

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
    let time;

    // Search for Open Graph published_time.
    const publishedTag = $('meta[property="article:published_time"]');
    time = publishedTag.attr('content');

    // Schema.org
    if (!time) {
      const datePublishedTag = $('meta[itemprop=datePublished]');
      time = datePublishedTag.attr('content');
    }

    // Search for a <time> tag.
    if (!time) {
      const timeTag = $('[datetime]');
      time = timeTag.attr('datetime');
    }

    // Last ditch effort: look for classname containing "datetime".
    if (!time) {
      const tag = $('[class*=datetime]');
      time = tag.text();
    }

    // Convert to timestamp.
    if (time) {
      time = (new Date(time)).getTime();
    }

    return time || 0;
  }

  /**
   * Scraper: gets the Twittle handle of the article author.  Note: often this turns out to be the
   * platform's Twitter handle instead of the actual author (e.g. "@wallstreetjournal instead of
   * @joeschmoe").
   */
  getTwitterAuthor($) {
    let author;

    const twitterCreatorTag = $('meta[name="twitter:creator"]');
    author = twitterCreatorTag.attr('content');

    if (!author) {
      const twitterSiteTag = $('meta[name="twitter:site"]');
      author = twitterSiteTag.attr('content');
    }

    return author || '';
  }

  /**
   * Scraper: gets the title of the article.
   */
  getPageTitle($) {
    let title;

    const ogTitleTag = $('meta[property="og:title"]');
    title = ogTitleTag.attr('content');

    if (!title) {
      const titleTag = $('title');
      title = titleTag.text().trim();
    }

    return title || '';
  }

  /**
   * Scraper: gets an excerpt from the beginning of an article.
   */
  getPageExcerpt($) {
    let excerpt = '';

    // Check for Open Graph description.
    const ogDescriptionTag = $('meta[property="og:description"]');
    excerpt = ogDescriptionTag.attr('content');

    // Check for Twitter description.
    if (!excerpt) {
      const twitterDescriptionTag = $('meta[name="twitter:description"]');
      excerpt = twitterDescriptionTag.attr('content');;
    }

    // Check for regular meta description tag.
    if (!excerpt) {
      const metaDescriptionTag = $('meta[name="description"]');
      excerpt = metaDescriptionTag.attr('content');
    }

    // Fallback to scraping the first paragraph.
    if (!excerpt) {
      // Find the first paragraph containing more than 20 words, then use that as an excerpt.
      // Note: don't use fat arrow here because 'this' context needs to NOT be outer closure
      // context.
      const paragraphs = $('p');
      paragraphs.each(function processParagraph() {
        // TODO: DON'T traverse ALL ps
        if (!excerpt && $(this).text().split(/\s+/).length > 20) {
          excerpt = $(this).text();
        }
      });
    }

    if (!excerpt) return '';

    // Trim excerpt.
    const maxLength = 200;
    excerpt = excerpt.split(' ').reduce((a, b) => {return (a.length > maxLength) ? a : `${a} ${b}`});

    return excerpt;
  }

  /**
   * Filters out non-articles (e.g. links to other tweets).
   */
  filterNonArticles(urlObjects) {
    const fnName = `${moduleName}/filterNonArticles`;

    const numUrlsBefore = urlObjects.length;
    const isNonArticle = (urlObj) => {
      if(!urlObj.url) winston.debug(`missing url`, urlObj);
      return urlObj.url && urlObj.url.match('twitter.com');
    }
    const flattenedUrlObjects = R.reject(isNonArticle, urlObjects);
    const numUrlsRejected = numUrlsBefore - flattenedUrlObjects.length;
    winston.debug(`${fnName}: discarded ${numUrlsRejected} non-article urls (tweets only)`);

    return flattenedUrlObjects;
  }

  /**
   * Filters out old articles.
   * TODO: merge with filterOldUrls
   */

  filterStaleUrls(urlObjects, prop = 'timestamp', expiry = msInAWeek) {
    const fnName = `${moduleName}/filterStaleUrls`;

    const numUrlsBefore = urlObjects.length;

    const cutoffTimeMS = Date.now() - expiry;
    
    const isURLStale = (url) => {
      if(!url) {
        winston.error(`${fnName}: url object is null`);
        return true;
      }
      const timestamp = (typeof prop === 'string') ? url[prop] : prop(url);
      const timestampArr = (Array.isArray(timestamp)) ? timestamp : [ timestamp ];

      const isFresh = R.any(timeMS => timeMS > cutoffTimeMS)(timestampArr)
      return !isFresh;
    }
    const flattenedUrlObjects = R.reject(isURLStale, urlObjects);
    const numUrlsRejected = numUrlsBefore - flattenedUrlObjects.length;
    winston.debug(`${fnName}: discarded ${numUrlsRejected} stale urls`);

    return flattenedUrlObjects;
  }

  /**
   * Pulls out urls from each tweet.
   */
  tweetsToURLs(tweets, args, done) {
    const fnName = `${moduleName}/tweetsToURLs`;

    winston.debug(`${fnName}: processing ${tweets.length} tweets...`);

    this._timerStart(fnName);

    const parallelFns = R.map((tweet) => ((parallelCb) => this.tweetToURLs(tweet, args, parallelCb)), tweets);
    async.parallelLimit(parallelFns, 5, (err, reply) => {
      //winston.debug(`${fnName} parallelLimit reply:`, reply);

      this._timerEnd(fnName);

      let flattenedUrlObjects = R.flatten(reply);

      // Remove rejected urls.
      flattenedUrlObjects = R.reject(R.isNil, flattenedUrlObjects);

      // Filter out old urls.
      winston.debug(`Twitter URLs before stale filter: ${flattenedUrlObjects.length}`);
      flattenedUrlObjects = this.filterStaleUrls(flattenedUrlObjects, 'articleTimestamp');
      winston.debug(`Twitter URLs after stale filter: ${flattenedUrlObjects.length}`);

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
    const tweetURLs = R.pluck('expanded_url')(urlObjs);

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
   * TODO: pull out, make configurable by client
   */
  removeJunkURLParams(url) {
    const removeParams = [
      // Misc
      '_mc', 'abg', 'abt', 'app', 'camp', 'cid', 'ecid', 'email_SHA1_lc', 'ex_cid', 'extid',
      'idg_eid', 'imm_mid', 'link_id', 'linkCode', 'linkId', 'LSD', 'mwrsm', 'partnerid',
      'postshare', 'ref', 'ref_', 'referer', 'referrer', 'rf', 'rref', 's_subsrc', 'share', 'source', 'sp_ref', 'sr', 'src',
      'tid', 'trackId', 'tse_id', 'ttl', 'via', 'xid',

      // HubSpot
      '_hsenc', '_hsmi',

      // The Guardian
      'CMP',

      // Oreilly
      'cmp',

      // Bloomberg, etc
      'cmpid',

      // Medium
      'gi',

      // Hootsuite
      'hootPostID', 'platform',

      // New Yorker, etc
      'mbid',

      // Mailchimp
      'mc_cid', 'mc_eid',

      // Marketo
      // http://docs.marketo.com/display/public/DOCS/Disable+Tracking+for+an+Email+Link
      'mkt_tok',

      // Techcrunch, Huffingtonpost
      'ncid',

      // Comscore
      'ns_source', 'ns_mchannel', 'ns_campaign', 'ns_linkname', 'ns_fee',

      // Forbes
      'refURL',

      // NY Times, Vulture, etc.
      'smprod', 'smid', 'mid', 'smtyp', 'smvar',

      // Yahoo News
      'soc_src', 'soc_trk',

      // Simple Reach (implemented on Techcrunch, Engadget, etc)
      'sr_share', 'sr_source',

      // LinkedIn
      'trk', 'trkInfo',

      // Google campaign url params.
      // Note: UTM = 'Urchin tracking module'
      // https://ga-dev-tools.appspot.com/campaign-url-builder/
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_cid', 'utm_name',

      // Webtrends
      'WT.mc_id',

      {
        doamin: 'www.aclu.org',
        params: ['redirect', 'ms']
      },

      {
        domain: ['www.nytimes.com', 'myaccount.nytimes.com', 'mobile.nytimes.com'],
        params: [
          '_r', 'action', 'pgtype', 'clickSource', 'module', 'region', 'WT.nav', 'emc', 'nl',
          'nlid', 'te'
        ]
      },

      {
        domain: 'www.washingtonpost.com',
        params: ['wpisrc', 'wpmm', 'hpid']
      },

      {
        domain: 'www.economist.com',
        params: ['fsrc']
      },

      {
        domain: 'meetup.com',
        params: ['a', 'rv', '_af', '_af_eid', 'https']
      },

      {
        domain: 'www.youtube.com',
        params: ['feature', 'a']
      },

      {
        domain: 'itunes.apple.com',
        params: ['mt']
      },

      {
        domain: 'www.magzter.com',
        params: ['dt']
      },

      {
        domain: 'www.cbsnews.com',
        params: ['ftag']
      },

      {
        domain: 'www.npr.org',
        params: ['ft', 'f']
      },

      {
        domain: ['www.eventbrite.com', 'www.eventbrite.co.uk'],
        params: ['aff']
      },

      {
        domain: ['www.amazon.com', 'www.eventbrite.co.uk'],
        params: ['aff']
      },

      {
        domain: ['www.amazon.com', 'www.amazon.co.uk', 'smile.amazon.com'],
        params: [
          'qid', 'keywords', 'creativeASIN', 'ie', 'tag', 'ref_', 'sr', 'psc', '_encoding', 'refRID'
        ]
      },

      {
        domain: 'businessinsider.com',
        params: ['r', 'IR']
      },

      {
        domain: 'research.googleblog.com',
        params: ['m']
      },

      {
        domain: ['www.upi.com'],
        params: ['spt', 'or']
      },

      {
        domain: ['medium.freecodecamp.com'],
        params: ['r']
      },

      {
        domain: ['www.popsci.com'],
        params: ['dom']
      },

      {
        domain: ['www.apple.com'],
        params: ['fnode']
      },

      {
        domain: ['gizmodo.com'],
        params: ['rev']
      },

      {
        domain: ['www.reuters.com'],
        params: ['mod', 'channelName']
      },

      {
        domain: ['www.wsj.com'],
        params: ['mod']
      }
    ];

    const urlParsed = urlUtil.parse(url, true);
    const query = urlParsed.query;

    // Remove junk params.
    removeParams.forEach((param) => {
      if (typeof param === 'string') {
        delete query[param];
      } else if(typeof param === 'object') {
        const hostname = (typeof urlParsed.hostname === 'string') ?
          [ urlParsed.hostname ] :
          urlParsed.hostname;

        // Domain-specific param removal.
        const domainMatches = hostname.indexOf(param.domain) !== -1;
        if (domainMatches) {
          param.params.forEach(param2 => delete query[param2]);
        }
      }
    });

    const queryFormatted = this.objToFormattedURLParams(query);

    urlParsed.search = (queryFormatted) ? `?${queryFormatted}` : '';

    return urlParsed.format();
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

    const maxFaves = this.getMaxTweetFavoriteCount(urlObjects);
    const maxRetweets = this.getMaxTweetRetweetCount(urlObjects);
    const maxMentions = this.getMaxTweetMentionCount(urlObjects);
    const maxNumPocketMentions = this.getMaxNumPocketMentions(urlObjects);

    urlObjects.forEach((urlObj) => {
      const urlObjCopy = Object.assign({}, urlObj);

      // Ignore urls thrown out by a previous filter.
      if (!urlObjCopy.url) return;

      // Find all occurances of this url.
      // const occuranceObjs = R.filter((a) => a.url === urlObjCopy.url, urlsCopy);

      // if(occuranceObjs.length > 1) {
      //   // Multiple occurances, so merge.
      //   const uniqueOccurances = R.uniqBy((a) => {
      //     return {tweetIDs: a.tweetIDs, source: a.source}
      //   }, occuranceObjs);
      // } else {

      // }

      urlObjCopy.rank = this.getURLRank(urlObjCopy, {
        maxFaves,
        maxRetweets,
        maxMentions,
        maxNumPocketMentions
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
      R.descend(R.prop('rank')),
      R.descend(R.prop('timestamp'))
    ])(urlsCopy);

    // Figure out size of each 10% segment.
    let urlsCopyRanks = R.pluck('rank')(urlsCopy);
    urlsCopyRanks = R.uniq(urlsCopyRanks);
    const segmentSize = Math.ceil(urlsCopyRanks.length / 10);
    const segments = [];
    const segmentLength = 10;
    for(let a=0, len=segmentLength; a<len; a++) {
      let segmentVal = urlsCopyRanks[a] || 0;
      segments.push(segmentVal);
    }

    urlsCopy = urlsCopy.map((urlObj) => {
      let rank = this.getSegmentPosition(urlObj.rank, segments);
      return Object.assign({}, urlObj, {
        rank,
        rankRaw: urlObj.rank
      });
    });

    return urlsCopy;
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
      position = 9;
    }

    position++;

    console.log(`${fnName}: ${rank} -> ${position} ; ${segments}`);

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
      maxFaves,
      maxRetweets,
      maxMentions,
      maxNumPocketMentions
    } = args;

    const {
      url,
      tweetRetweetCount,
      tweetFavoriteCount,
      tweetTexts,
      pocketTimeAdded
    } = urlObj;

    const faveVal = tweetFavoriteCount || 0;
    const retweetVal = tweetRetweetCount || 0;
    const pocketTimeVal = pocketTimeAdded.length || 0;

    const faveRanking = this.normalizeVal(faveVal, 0, maxFaves, 0, 9);
    const retweetRanking = this.normalizeVal(retweetVal, 0, maxRetweets, 0, 9);
    const pocketRanking = this.normalizeVal(pocketTimeVal, 0, maxNumPocketMentions, 0, 9);

    const rankingArr = [pocketRanking, retweetRanking, faveRanking];
    let ranking = rankingArr.join('');

    ranking = parseFloat(ranking) * 1000;

    winston.debug(`${fnName}: ${ranking} ; ${rankingArr} ; ${pocketTimeAdded.length}, ${tweetRetweetCount}, ${tweetFavoriteCount}, ${url}`);

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
   * Determines the largest number of Tweet retweets.  Needed for relative ranking of Twitter
   * links.
   */
  getMaxTweetRetweetCount(urlObjects) {
    const fnName = `${moduleName}/getMaxTweetRetweetCount`;
    if (urlObjects.length === 0) return 0;

    const sort = R.sortBy((a) => a.tweetRetweetCount || 0);
    const urlsObjectsSorted = sort(urlObjects);
    const maxItem = urlsObjectsSorted[urlsObjectsSorted.length - 1];

    if (!maxItem) {
      winston.error(`${fnName}: maxItem is null`);
      console.log(JSON.stringify(urlsObjectsSorted, null, 2))
      return 0;
    }

    return R.prop('tweetRetweetCount', maxItem) || 0;
  }

  /**
   * Determines the largest number of Tweet mentions.  Needed for relative ranking of Twitter
   * links.
   */
  getMaxTweetMentionCount(urlObjects) {
    const fnName = `${moduleName}/getMaxTweetMentionCount`;
    if (urlObjects.length === 0) return 0;

    const sort = R.sortBy((a) => (a.tweetTexts && a.tweetTexts.length) || 0);
    const urlsObjectsSorted = sort(urlObjects);
    const maxItem = urlsObjectsSorted[urlsObjectsSorted.length - 1];

    if (!maxItem) {
      winston.error(`${fnName}: maxItem is null`);
      console.log(JSON.stringify(urlsObjectsSorted, null, 2))
      return 0;
    }

    return R.path(['tweetTexts', 'length'], maxItem) || 0;
  }

  /**
   * Determines the largest number of Pocket mentions.
   */
  getMaxNumPocketMentions(urlObjects) {
    if (urlObjects.length === 0) return 0;

    const sort = R.sortBy((a) => (a.pocketID && a.pocketID.length) || 0);
    const urlsObjectsSorted = sort(urlObjects);
    const maxItem = urlsObjectsSorted[urlsObjectsSorted.length - 1];
    return R.path(['pocketTimeAdded', 'length'], maxItem) || 0;
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
        return done(null, []);
      } else {
        winston.debug(`${fnName}: starting list fetching.`)
      }

      return client.set(`${redisNS}${redisIsFetchingKey}`, Date.now(), () => {
        // Pocket
        lists.pocket.forEach((pocketList) => {
          // Separate call for each Pocket tag.
          pocketList.tags.forEach((tag) => {
            let pocketArgs = Object.assign({}, pocketList, { tag });
            parallelFns.push((parallelCb) => this.fetchPocketList(pocketArgs, parallelCb));
          });
        });

        // Twitter
        lists.twitter.forEach((twitterList) => {
          parallelFns.push((parallelCb) => this.fetchTwitterList(twitterList, parallelCb));
        });

        // No-op, no lists to process.
        if (parallelFns.length === 0) return done(null, []);

        return async.parallelLimit(parallelFns, 2, (err, urls) => {
          // Combine all lists together.
          let allUrls = R.flatten(urls);

          // 1-10 ranking.
          allUrls = this.rankUrls(allUrls);

          // Remove dupes.
          console.log(`before dupe removal: ${allUrls.length}`);
          allUrls = R.unionWith(R.eqBy(R.prop('url')), allUrls, []);
          console.log(`after dupe removal: ${allUrls.length}`);

          winston.debug(`${fnName}: complete!`);
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

    const argsCopy = Object.assign({}, args);

    this._timerStart(fnName);

    this._asyncGetTwitterList(argsCopy, (err, tweets) => {
      // Sanity checks
      if (err) return done(`${fnName} ${err}`);
      if (tweets.length === 0) return done(`${fnName} No tweets - network problems?`);

      this._timerEnd(fnName);

      winston.debug(`${fnName}: ${tweets.length} tweets returned before processing.`);

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
    done = done || (() => {});

    const argsCopy = Object.assign({}, args);
    const { consumerKey, accessToken, apiUrl, fetchStub } = argsCopy;
    const username = argsCopy.username || '';
    const tag = argsCopy.tag || '';

    // Sanity checks.
    const argsNotPresent = this.findUndefinedArgs(args, ['consumerKey', 'accessToken', 'apiUrl']);

    if (argsNotPresent.length > 0) {
      const argsNotPresentStr = argsNotPresent.join(', ');
      return done(`${fnName} error: required args are not present: ${argsNotPresentStr}`);
    }

    // Use fetchStub for tests.
    const fetchAction = fetchStub || fetch;

    this._timerStart(fnName);

    const fetchPocket = fetchAction(apiUrl, {
      method: 'post',
      mode: 'cors',
      body: JSON.stringify({
        // See http://www.jamesfmackenzie.com/getting-started-with-the-pocket-developer-api/
        consumer_key: consumerKey,
        access_token: accessToken,
        tag
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

      return this.pocketToURLs(pocketAPIResponse, {
        tag,
        username
      }, done);
    })
    .catch(error => done(`link-aggregator/getPocketList ${error.message}`));
  }

  /**
   * Converts a raw Pocket object into a formatted URL object.
   */
  pocketToURL(pocketUrlObj, args, done) {
    const fnName = `${moduleName}/pocketToURL`;

    const urlDetailsArgs = {
      pocketObj: Object.assign({}, pocketUrlObj, args)
    };

    // Get scraped info for this url.
    return this.getUrlDetails(pocketUrlObj.resolved_url, urlDetailsArgs, (err, urlDetailsObj) => {
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

    let pocketURLs = R.values(pocketAPIResponse.list);

    // Filter out old urls.
    winston.debug(`Pocket URLs before stale filter: ${pocketURLs.length}`);
    pocketURLs = this.filterStaleUrls(pocketURLs, (obj) => R.prop('time_added', obj) * 1000);
    winston.debug(`Pocket URLs after stale filter: ${pocketURLs.length}`);

    winston.debug(`${pocketURLs.length} Pocket links returned before processing.`);

    const parallelFns = pocketURLs.map((obj) => (parallelCb) => this.pocketToURL(obj, args, parallelCb));
    return async.parallelLimit(parallelFns, 5, (err, urlObjs) => {
      if (err) winston.error(`${fnName}: err`);

      let urlObjsCopy = urlObjs.concat();

      return done(null, urlObjsCopy);
    });
  }
}

module.exports = Aggregator;
