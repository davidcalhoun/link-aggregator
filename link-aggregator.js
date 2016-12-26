(function la(root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD. Register as an anonymous module.
    define([
      'codebird',
      'ramda',
      'isomorphic-fetch',
      'promise-polyfill'
    ], factory);
  } else if (typeof exports === 'object') {
    // Node. Does not work with strict CommonJS, but
    // only CommonJS-like environments that support module.exports,
    // like Node.
    module.exports = factory(
      require('codebird'),
      require('ramda'),
      require('isomorphic-fetch'),
      require('promise-polyfill')
    );
  } else {
    // Browser globals (root is window)
    // eslint-disable-next-line no-param-reassign
    root.linkAggregator = factory(
        root.Codebird,
        root.R,
        root.fetch,
        root.Promise
    );
  }
}(this, (Codebird, R, fetch, Promise) => {
  // TODO fix when cert is deployed
  if (process && process.env.NODE_ENV !== 'production') {
    // Running in Node
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  class Aggregator {
    constructor(args) {
      // Init Codebird (helper for accessing Twitter API)
      this.codebird = new Codebird;
    }

    // Sets consumer key and secret for Twitter API.
    setTwitterConsumerKey(key, secret) {
      this.codebird.setConsumerKey(key, secret);
    }

    // Sets token and secret for Twitter API.
    setTwitterToken(token, secret) {
      this.codebird.setToken(token, secret);
    }

    // Sets words to ignore in links (for filtering irrelevant links).
    setIgnoreWords(words) {
      this.ignoreWords = words || [];
    }

    // Gets words to ignore in links.
    getIgnoreWords() {
      return this.ignoreWords;
    }

    // Transforms category classification config for easier lookups.
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

    // Sets up categories for topic tagging.
    setCategories(categories) {
      this.categoriesUnprocessed = categories;
      this.categories = (categories) ?
        R.compose(R.map(R.zipObj(['name', 'keywords'])), this._toCategoryPairs)(categories) :
        [];
    }

    // Gets categories, for tagging link topics.
    getCategories() {
      return this.categoriesUnprocessed;
    }

    // Fetches links from a Twitter list.
    // https://dev.twitter.com/rest/reference/get/lists/statuses
    _asyncGetTwitterList(args, cb) {
      const argsCopy = Object.assign({}, args);

      // TODO: remove, replace with arrow fns
      const self = this;

      let listOptions = {};

      // TODO: remove this global state
      self._tweets = [];

      // Init
      if (!argsCopy.data) {
        argsCopy.data = [];
        argsCopy.iterations = 0;
      }

      listOptions = {
        owner_screen_name: argsCopy.owner,
        slug: argsCopy.name,
        count: argsCopy.count || 100
      };

      // Pagination
      if ('max_id' in argsCopy) listOptions.max_id = argsCopy.max_id;

      // TODO: send pagination calls out in parallel instead of sequentially
      this.codebird.__call(
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
          } else if (!argsCopy.multipleCallbacks && self._tweets) {
            // Group up results into one callback;

            // append
            self._tweets = self._tweets.concat(reply);
          } else if (!argsCopy.multipleCallbacks && !self._tweets) {
            // init
            self._tweets = reply;
          }

          // Reached the limit
          // TODO pull out iteration #, or base results on filtered count
          if (argsCopy.iterations > 4) {
            // cb already sent above
            if (argsCopy.multipleCallbacks) return null;
            return cb(null, self._tweets);
          }

          // Fetch the next page
          if (reply.length === 0) {
            return cb('Twitter API reply is 0 length - hit a rate limit?');
          }

          argsCopy.max_id = reply[reply.length - 1].id;
          return self._asyncGetTwitterList(argsCopy, cb);
        }
      );
    }

    // Searches a text string for matching categories.
    _getCategoriesFromText(text, categories) {
      let cats = [];
      const categoriesCopy = categories || [];

      cats = R.filter((category) => text.match(category.keywords.regexp))(categoriesCopy);

      cats = R.pluck('name', cats);

      return cats;
    }

    // Gets tweets from a user's Twitter list.  With keyword filtering to discard irrelevant tweets.
    twitterList(args, cb) {
      // TODO replace with arrow fns
      const self = this;

      // Stores by link, not by tweet.
      if (!self.twitterLinks) self.twitterLinks = {};

      // TODO: pull apart this big mess.
      self._asyncGetTwitterList(args, (err, data) => {
        let tweets = [];
        let ignoreMatch = false;
        let linkArray = [];

        // Sanity checks
        if (err) {
          return cb(err);
        }
        if (data.length === 0) {
          return cb('No tweets - network problems?');
        }

        // Filter out irrelevant tweets.
        tweets = R.reject((tweet) => {
          // Discard tweets with no urls.
          if (!tweet || !tweet.entities || tweet.entities.urls.length === 0) return true;

          // Discard ignored words.
          ignoreMatch = R.find((ignoreWord) => {
            let txt = `@${tweet.user.screen_name}: ${tweet.text}`;

            const urls = R.pluck('expanded_url', tweet.entities.urls);
            const joinedUrls = urls.join(', ');

            // Append urls to text to simplify regexp logic
            txt = `${txt} ${joinedUrls}`;

            return txt.match(new RegExp(ignoreWord, 'gi'));
          })(self.ignoreWords || []);

          return ignoreMatch;
        }, data);


        // Each tweet: data massaging
        R.forEach((tweet) => {
          // Pull out links from tweet
          const urls = R.path(['entities', 'urls'], tweet);

          // Each url
          R.forEach((url) => {
            const urlCopy = url.expanded_url;
            let hashtags = [];
            let categories = [];

            // TODO resolve shortened urls like bit.ly

            if (!self.twitterLinks[urlCopy]) {
              // new url, so init
              self.twitterLinks[urlCopy] = {
                source: 'twitter',
                sourceDetails: `${args.owner}/${args.name}`,
                categories: [],
                tweetTexts: [],
                hashtags: [],
                media: [],  // photos, videos associated with the link
                mentionCount: 0,
                retweetCount: 0,
                favoriteCount: 0,
                firstMentionTime: (new Date(tweet.created_at)).getTime(),
                lastMentionTime: null
              };
            }

            // TODO use R.mergeWith instead here?

            if (!self.twitterLinks[urlCopy]) return;

            self.twitterLinks[urlCopy].tweetTexts.push(`@${tweet.user.screen_name}: ${tweet.text}`);
            self.twitterLinks[urlCopy].tweetTexts = R.uniq(self.twitterLinks[urlCopy].tweetTexts);

            hashtags = R.pluck('text')(tweet.entities.hashtags);
            self.twitterLinks[urlCopy].hashtags =
              R.uniq(self.twitterLinks[urlCopy].hashtags.concat(hashtags));

            if ('media' in tweet.entities) {
              self.twitterLinks[urlCopy].media =
                R.uniq(self.twitterLinks[urlCopy].media.concat(tweet.entities.media));
            }

            self.twitterLinks[urlCopy].mentionCount++;
            self.twitterLinks[urlCopy].retweetCount += tweet.retweet_count;
            self.twitterLinks[urlCopy].favoriteCount += tweet.favorite_count;
            self.twitterLinks[urlCopy].rank = self.twitterLinks[urlCopy].favoriteCount +
              self.twitterLinks[urlCopy].retweetCount + self.twitterLinks[urlCopy].mentionCount;
            self.twitterLinks[urlCopy].lastMentionTime = (new Date(tweet.created_at)).getTime();

            R.forEach((subtweet) => {
              const cats = self._getCategoriesFromText(`${subtweet}, ${urlCopy}`, self.categories);

              if (cats.length > 0) {
                categories = categories.concat(cats);
              }
            }, self.twitterLinks[urlCopy].tweetTexts);
            // TODO: do a category search on all urls in tweet instead of just one (url)

            self.twitterLinks[urlCopy].categories =
              R.uniq(self.twitterLinks[urlCopy].categories.concat(categories));
          }, urls);
        }, tweets);

        // Sort tweets according to date, then link count

        // Convert to array.
        linkArray = R.compose(R.map(R.zipObj(['url', 'details'])), R.toPairs)(self.twitterLinks);

        // Remove nested 'details' object.
        linkArray = R.map((link) => R.assoc('url', link.url, link.details), linkArray);

        // Sort by mentions, rewtweets, favorites all combined
        linkArray = R.reverse(R.sortBy(R.prop('rank'))(linkArray));

        return cb(null, linkArray);
      });
    }

    // Gets a user's Pocket list.  No keyword filtering needed here, as Pocket is more curated
    // already.
    // TODO: pagination
    getPocketList(args, done) {
      const argsCopy = Object.assign({}, args);
      const consumerKey = argsCopy.consumerKey;
      const accessToken = argsCopy.accessToken;
      const username = argsCopy.username;
      const url = args.apiUrl;
      const tag = args.tag || '';
      const self = this;

      const fetchPocket = fetch(url, {
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
      .then(response => response.json())
      .then(json => self._formatPocketList({ list: json.list, tag, username }));

      // TODO: make timeout configurable.
      const timeout = new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('request timeout')), 8000);
      });

      Promise.race([
        fetchPocket,
        timeout
      ])
      .then((val) => done(null, val))
      .catch(error => done(error.message));
    }

    // Data massages pocket link objects into our standard format.
    _formatPocketList(args) {
      let output = [];

      const list = args.list;
      const tag = args.tag;
      const username = args.username;

      // Convert object to array
      output = R.values(list);

      // Only pull out the data we care about
      output = R.map((listItem) => ({
        source: 'pocket',
        sourceDetails: username,
        tag,
        url: listItem.resolved_url,
        title: listItem.resolved_title,
        time_added: listItem.time_added * 1000,
        id: listItem.item_id, // Pocket ID
        excerpt: listItem.excerpt,
        categories: this._getCategoriesFromText(`${listItem.resolved_title}, ${listItem.excerpt}`,
          this.categories)
      }), output);

      // Sort by time_added, newest on top
      output = R.reverse(R.sortBy(R.prop('time_added'))(output));

      return output;
    }
  }

  return Aggregator;
}));
