(function (root, factory) {
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
        root.linkAggregator = factory(
            root.Codebird,
            root.R,
            root.fetch,
            root.Promise
        );
    }
}(this, function(Codebird, R, fetch, Promise) {
'use strict';

// TODO fix when cert is deployed
if (true || process && process.env.NODE_ENV !== 'production') {
    // Running in Node
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// Constructor
function agg(args) {
    // Self-instantiate if needed.
    if (!this || !(this instanceof agg)) return new agg(args);
    return this;
};

agg.prototype.setTwitterConsumerKey = function(key, secret) {
    this.codebird.setConsumerKey(key, secret);
};

agg.prototype.setTwitterToken = function(token, secret) {
    this.codebird.setToken(token, secret);
};

agg.prototype._toCategoryPairs = function(categories) {
    return R.map((category) => {
        var regexp = categories[category];

        if(Array.isArray(regexp)) regexp = regexp.join('|');

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

agg.prototype.setIgnoreWords = function(words) {
    this.ignoreWords = (words) ? words : [];
}

agg.prototype.getIgnoreWords = function() {
    return this.ignoreWords;
}

agg.prototype.setCategories = function(categories) {
    this.categoriesUnprocessed = categories;
    this.categories = (categories) ? R.compose(R.map(R.zipObj(['name', 'keywords'])), this._toCategoryPairs)(categories) : [];
}

agg.prototype.getCategories = function() {
    return this.categoriesUnprocessed;
}


// https://dev.twitter.com/rest/reference/get/lists/statuses
agg.prototype._asyncGetTwitterList = function (args, cb) {
    args = args || {};

    var self = this;

    self._tweets = [];

    // Init
    if(!args.data) {
        args.data = [];
        args.iterations = 0;
    }

    var listOptions = {
        owner_screen_name: args.owner,
        slug: args.name,
        count: args.count || 100
    };

    // Pagination
    if ('max_id' in args) listOptions.max_id = args.max_id;

    // TODO: send pagination calls out in parallel instead of sequentially
    this.codebird.__call(
        'lists_statuses',
        listOptions,
        function (reply, rate, err) {
            // TODO pay attention to rate limits

            if (err) {
                cb(err);
            }

            args.iterations++;
            
            if (args.multipleCallbacks) {
                // Return current batch immediately
                cb(null, reply);
            } else {
                // Group up results;
                if (self._tweets) {
                    // append
                    self._tweets = self._tweets.concat(reply);
                } else {
                    // init
                    self._tweets = reply;
                }
            }

            // Reached the limit
            // TODO pull out iteration #, or base results on filtered count
            if (args.iterations > 4) {
                if (args.multipleCallbacks) {
                    // cb already sent above
                    return;
                } else {
                    return cb(null, self._tweets);
                }
            }

            // Fetch the next page
            if (reply.length === 0) {
                cb('Twitter API reply is 0 length - hit a rate limit?');
            } else {
                args.max_id = reply[reply.length - 1].id;
                self._asyncGetTwitterList(args, cb);
            }
        }
    );
};

agg.prototype._getCategoriesFromText = function(text, categories) {
    var cats = [];
    categories = categories || [];

    cats = R.filter(function(category) {
        return text.match(category.keywords.regexp);
    })(categories);
    
    cats = R.pluck('name', cats);

    return cats;
};


// Get tweets from a user's Twitter list.  With keyword filtering to discard irrelevant tweets.
agg.prototype.twitterList = function(args, cb) {
    var self = this;

    // Make links first-class here instead of tweets themselves.
    // Init if needed
    if(!this.twitterLinks) this.twitterLinks = {};

    this._asyncGetTwitterList(args, function(err, data){
        // Sanity checks
        if(err) {
            throw new Error(err);
        }

        if(data.length === 0) {
            return cb('No tweets - network problems?');
        }

        var tweets;

        // Discard tweets matching certain criteria
        tweets = R.reject(function(tweet){
            // No link, so discard
            if(tweet.entities.urls.length === 0) return true;

            // Discard if tweet contains an ignore word
            var ignoreMatch = false;
            ignoreMatch = R.find(function(ignoreWord){
                var txt = '@' + tweet.user.screen_name + ':' + tweet.text;

                var urls = R.pluck('expanded_url', tweet.entities.urls);

                // Append urls to text to simplify regexp logic
                txt += ' ' + urls.join(', ');

                return txt.match(new RegExp(ignoreWord, 'gi'));
            })(self.ignoreWords);

            return ignoreMatch;
        }, data);


        // Each tweet: data massaging
        R.forEach(function(tweet){
            // Pull out links from tweet
            var urls = R.path(['entities', 'urls'], tweet);

            // Each url
            R.forEach(function(url){
                url = url.expanded_url;

                // TODO resolve shortened urls like bit.ly

                if (!self.twitterLinks[url]) {
                    // new url, so init
                    self.twitterLinks[url] = {
                        source: 'twitter',
                        categories: [],
                        tweetTexts: [],
                        hashtags: [],
                        media: [],  // photos, videos associated with the link
                        mentionCount: 0,
                        retweetCount: 0,
                        favoriteCount: 0,
                        firstMentionTime: (new Date(tweet.created_at)).getTime(),
                        lastMentionTime: null,
                    };
                }

                // TODO use R.mergeWith instead here?

                self.twitterLinks[url].tweetTexts.push('@' + tweet.user.screen_name + ': ' + tweet.text);
                self.twitterLinks[url].tweetTexts = R.uniq(self.twitterLinks[url].tweetTexts);

                var hashtags = R.pluck('text')(tweet.entities.hashtags);
                self.twitterLinks[url].hashtags = R.uniq(self.twitterLinks[url].hashtags.concat(hashtags));

                if ('media' in tweet.entities) {
                    self.twitterLinks[url].media = R.uniq(self.twitterLinks[url].media.concat(tweet.entities.media));
                }

                self.twitterLinks[url].mentionCount++;
                self.twitterLinks[url].retweetCount += tweet.retweet_count;
                self.twitterLinks[url].favoriteCount += tweet.favorite_count;
                self.twitterLinks[url].rank = self.twitterLinks[url].favoriteCount + self.twitterLinks[url].retweetCount + self.twitterLinks[url].mentionCount;
                self.twitterLinks[url].lastMentionTime = (new Date(tweet.created_at)).getTime();

                //
                var categories = [];
                var tweetsPlusFullLinks = [];
                R.forEach(function(subtweet){
                    var cats = self._getCategoriesFromText(subtweet + ', ' + url, self.categories);

                    if(cats.length > 0) {
                        categories = categories.concat(cats);
                    }
                }, self.twitterLinks[url].tweetTexts);
                // TODO: do a category search on all URLs in tweet instead of just one (url)

                self.twitterLinks[url].categories = R.uniq(self.twitterLinks[url].categories.concat(categories));
            }, urls);
        }, tweets);


        // Sort tweets according to date, then link count

        // Convert to array
        var linkArray = R.compose(R.map(R.zipObj(['url', 'details'])), R.toPairs)(self.twitterLinks);

        // Remove nested 'details' object.
        linkArray = R.map(function(link){return R.assoc('url', link.url, link.details);}, linkArray);

        // Sort by mentions, rewtweets, favorites all combined
        linkArray = R.reverse(R.sortBy(R.prop('rank'))(linkArray));

        cb(null, linkArray);
    });
};

// Get a user's Pocket list.  No keyword filtering here, as Pocket is more user-curated.
// TODO: pagination
agg.prototype.getPocketList = function(args) {
    args = args || {};

    var consumerKey = args.consumerKey;
    var accessToken = args.accessToken;
    var url = args.apiUrl;

    var fetchPocket = fetch(url, {
        method: 'post',
        mode: 'cors',
        body: JSON.stringify({
            // See http://www.jamesfmackenzie.com/getting-started-with-the-pocket-developer-api/
            consumer_key: consumerKey,
            access_token: accessToken,
            tag: args.tag || ''
        }),
        headers: {
            'X-Accept': 'application/json',
            'Content-Type': 'application/json; charset=UTF8'
        }
    })
    .then(response => {
        return response.json();
    })
    .then(json => {
        return this._formatPocketList(json.list);
    })
    .catch(error => {
        console.error(error.message);
    });

    var timeout = new Promise(function (resolve, reject) {
        setTimeout(() => reject(new Error('request timeout')), 8000)
    });

    return Promise.race([
        fetchPocket,
        timeout
    ])
};

var MS_IN_SECONDS = 1000;

// Data massaging for Pocket data.
agg.prototype._formatPocketList = function(list) {
    var self = this;
    var output;

    // Convert object to array
    output = R.values(list);

    // Only pull out the data we care about
    output = R.map((listItem) => {
        return {
            source: 'pocket',
            url: listItem.resolved_url,
            title: listItem.resolved_title,
            time_added: listItem.time_added * MS_IN_SECONDS,
            id: listItem.item_id, // Pocket ID
            excerpt: listItem.excerpt,
            categories: this._getCategoriesFromText(listItem.resolved_title + ', ' + listItem.excerpt, this.categories)
        };
    }, output);

    // Sort by time_added, newest on top
    output = R.reverse(R.sortBy(R.prop('time_added'))(output));

    return output;
};


return agg;

}));