const assert = require('assert');
const cheerio = require('cheerio');

describe('scraper', function() {
  const assert = require('assert');
  const la = require('../link-aggregator');

  let linkAggregator;

  beforeEach(function() {
    linkAggregator = new la();
  });

  describe('filterUrlsWithIgnoreWords', function() {
    it('filters url strings', () => {
      const urls = [
        'https://www.nytimes.com/2016/07/29/science/brain-scans-math.html',
        'https://google.com'
      ];
      const ignoreWords = ['nytimes.com'];

      const result = linkAggregator.filterUrlsWithIgnoreWords(urls, ignoreWords);

      assert.deepEqual(result, ['https://google.com']);
    });

    it('filters url objects', () => {
      const urls = [
        {
          url: 'https://www.nytimes.com/2016/07/29/science/brain-scans-math.html',
        },
        {
          url: 'https://google.com',
        }
      ];
      const ignoreWords = ['nytimes.com'];

      const result = linkAggregator.filterUrlsWithIgnoreWords(urls, ignoreWords);

      assert.deepEqual(result, [ { url: 'https://google.com' } ]);
    });
  });

  describe('removeJunkURLParams', function() {
    it('removes junk 1', () => {
      const removeConfig = [
        {
          "domain": "codeburst.io",
          "params": ["gi"]
        }
      ];
      const cleanedUrl = 'https://codeburst.io/javascript-hoisting-in-action-a2cef1212d52';
      const url = `${cleanedUrl}?gi=a003e3ac7e0b`;
      const output = linkAggregator.removeJunkURLParams(url, removeConfig);

      assert.equal(output, cleanedUrl);
    });

    it('preserves hashes by default', () => {
      const removeConfig = [
        {
          domain: ['medium.com'],
          params: []
        }
      ];
      const cleanedUrl = 'https://medium.com/fooo/writing-well-c361ce91f69f';
      const url = `${cleanedUrl}#---0-151.46y842iju`;
      const output = linkAggregator.removeJunkURLParams(url, removeConfig);

      assert.equal(output, url);
    });

    it('removes hashes', () => {
      const removeConfig = [
        {
          domain: ['medium.com'],
          params: [],
          removeHash: true
        }
      ];
      const cleanedUrl = 'https://medium.com/fooo/writing-well-c361ce91f69f';
      const url = `${cleanedUrl}#---0-151.46y842iju`;
      const output = linkAggregator.removeJunkURLParams(url, removeConfig);

      assert.equal(output, cleanedUrl);
    });
  });

  describe('mergeUrls', () => {
    describe('category matching', () => {
      const categories = {
        "Video": ["video"],
        "Foo": ["foo"],
        "Bar": ["bar"]
      };

      it('prefers matches in url and title over excerpt', () => {
        const scrapedUrlObj = {
          url: 'https://github.com/foo/video',
          title: 'Something foo something',
          excerpt: 'Something bar something'
        };

        const socialUrlObj = {
          tweetObj: {
            user: {}
          }
        };

        linkAggregator.setCategories(categories);
        const result = linkAggregator.mergeUrls(scrapedUrlObj, socialUrlObj);

        assert.deepEqual(result.categories, [ 'Video', 'Foo' ]);
      });

      it('falls back to excerpt', () => {
        const scrapedUrlObj = {
          url: 'https://github.com/sadas/vasfdfsdideo',
          title: 'Something gdg something',
          excerpt: 'Something bar something'
        };

        const socialUrlObj = {
          tweetObj: {
            user: {}
          }
        };

        linkAggregator.setCategories(categories);
        const result = linkAggregator.mergeUrls(scrapedUrlObj, socialUrlObj);

        assert.deepEqual(result.categories, [ 'Bar' ]);
      });
    });
  })

  describe('_getCategoriesFromText', function() {
    const categories = {
      "Video": ["video"],
      "Foo": ["amp"],
      "Dash": ["dash dash"]
    };

    it('matches with a dash', () => {
      linkAggregator.setCategories(categories);
      const cats = linkAggregator._getCategoriesFromText('something dash-dash');
      assert.deepEqual(cats, [ 'Dash' ]);
    });

    it('matches a word in a sentence', () => {
      linkAggregator.setCategories(categories);
      const cats = linkAggregator._getCategoriesFromText('something video something');
      assert.deepEqual(cats, [ 'Video' ]);
    });

    it('matches a word in a url', () => {
      linkAggregator.setCategories(categories);
      const cats = linkAggregator._getCategoriesFromText('http://video.com');
      assert.deepEqual(cats, [ 'Video' ]);
    });

    it('doesnt match a partial word', () => {
      linkAggregator.setCategories({
        "Design": ["design"]
      });
      const cats = linkAggregator._getCategoriesFromText('foofoodesignedfoo');
      assert.deepEqual(cats, []);
    });

    it('matches a word from complex categories', () => {
      linkAggregator.setCategories({
        "Foo": ["foo", "bar", "baz"]
      });
      const cats = linkAggregator._getCategoriesFromText('something bar something');
      assert.deepEqual(cats, [ 'Foo' ]);
    });

    it('doesnt match partial word with complex categories', () => {
      linkAggregator.setCategories({
        "Foo": ["foo", "bar", "baz"]
      });
      const cats = linkAggregator._getCategoriesFromText('somethingbarsomething');
      assert.deepEqual(cats, [ ]);
    });
  });

  describe('getStandardizedSegments', function() {
    it('produces 10 segments by default 1', () => {
      const arr = [1,2,3,4,5,6,7,8,9,10];
      const result = linkAggregator.getStandardizedSegments(arr);
      const expectedResult = arr;

      assert.deepEqual(result, expectedResult);
    });
    it('produces 10 segments by default 2', () => {
      const arr = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20];
      const result = linkAggregator.getStandardizedSegments(arr);
      const expectedResult = [2,4,6,8,10,12,14,16,18,20];

      assert.deepEqual(result, expectedResult);
    });
    it('produces 10 segments by default 3', () => {
      const arr = [1,2,3,4,5,6,7,8,9,10,11];
      const result = linkAggregator.getStandardizedSegments(arr);
      const expectedResult = [1.1,2.2,3.3,4.4,5.5,6.6,7.7,8.8,9.9,11];

      assert.deepEqual(result, expectedResult);
    });
    it('produces 10 segments by default 4', () => {
      const arr = [1,2,3,4,5];
      const result = linkAggregator.getStandardizedSegments(arr);
      const expectedResult = [0,0,0,0,0,1,2,3,4,5];

      assert.deepEqual(result, expectedResult);
    });
    it('produces 10 segments by default 5', () => {
      const arr = [1,20,30,33,34,35,60,77,88,100,200,500,4000,90000,900000];
      const result = linkAggregator.getStandardizedSegments(arr);
      const expectedResult = [1.1,33,36.3,38.5,66,96.8,110,550,4400,990000];

      assert.deepEqual(result, expectedResult);
    });
  });

  describe('getSegmentPosition', function() {
    it('1', () => {
      const segments = [1.1,33,36.3,38.5,66,96.8,110,550,4400,990000];
      const result = linkAggregator.getSegmentPosition(10, segments);
      const expectedResult = 1;

      assert.deepEqual(result, expectedResult);
    });
    it('2', () => {
      const segments = [1.1,33,36.3,38.5,66,96.8,110,550,4400,990000];
      const result = linkAggregator.getSegmentPosition(1000, segments);
      const expectedResult = 8;

      assert.deepEqual(result, expectedResult);
    });
  });

  describe('getPageExcerpt', function() {
    let $;

    it('preserves whitelisted HTML entities', () => {
      const expectedResult = 'webpack, without the &lt;code&gt;pack&lt;/code&gt;';
      const body = `<meta property="og:description" content="${expectedResult}">`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageExcerpt($);

      assert.deepEqual(result, expectedResult);
    });

    it('preserves whitelisted HTML entities 2', () => {
      const body = `<body><p>to provide clarity on how web loading primitives (like <a href="example.com"><strong>&lt;link rel=“preload”&gt;</strong>)</a></p></body>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageExcerpt($);

      assert.deepEqual(result, 'to provide clarity on how web loading primitives (like &lt;link rel=“preload”&gt;)');
    });

    it('strips HTML <strong>', () => {
      const expectedResult = 'Combine the transparency of a PNG with the compression of a JPEG. Based on the idea from';
      const expectedResult2 = 'asdasd';
      const body = `<meta property="og:description" content="${expectedResult} &lt;strong&gt;${expectedResult2}&lt;/strong&gt;">`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageExcerpt($);

      assert.deepEqual(result, `${expectedResult} ${expectedResult2}`);
    });

    it('strips HTML <strong> 2', () => {
      const expectedResult = 'Combine the transparency of a PNG with the compression of a JPEG. Based on the idea from';
      const expectedResult2 = 'asdasd';
      const body = `<meta property="og:description" content="${expectedResult} <strong>${expectedResult2}</strong>">`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageExcerpt($);

      assert.deepEqual(result, `${expectedResult} ${expectedResult2}`);
    });

    it('strips incomplete HTML <strong>', () => {
      const expectedResult = 'Combine the transparency of a PNG with the compression of a JPEG. Based on the idea from';
      const body = `<meta property="og:description" content="${expectedResult}&lt;/strong&gt;">`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageExcerpt($);

      assert.deepEqual(result, expectedResult);
    });

    it('strips HTML links', () => {
      const txt = 'foo foo bar bar ';
      const expectedResult = `${txt}reddit`;
      const body = `<meta property="og:description" content="${txt}&lt;a href=&quot;https://www.reddit.com&quot;&gt;reddit&lt;/a&gt;" />`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageExcerpt($);

      assert.deepEqual(result, expectedResult);
    });
  });

  describe('getPublishedTime', () => {
    let $;

    // General note: times not ms-precise due to https://github.com/substack/parse-messy-time/issues/10

    describe('meta tags', () => {
      const metas = [
        {itemprop: 'datePublished'},
        {itemprop: 'dateModified'},
        {itemprop: 'startDate'},
        {itemprop: 'endDate'},
        {property: 'article:published_time'},
        {name: 'revised'},
        {name: 'date'},
        {name: 'last-modified'},
        {name: 'last-updated'},
        {name: 'search_date'},
        {name: 'pubdate'},
        {property: 'datePublished'},
        {property: 'article:post_date'},
        {property: 'article:post_modified'},
        {property: 'DC.date.issued'}
      ];

      metas.forEach((meta) => {
        const firstKey = Object.keys(meta)[0];
        const firstVal = meta[firstKey];

        it(`${firstKey}/${firstVal}`, () => {
          const body = `<meta ${firstKey}="${firstVal}" content="2017-07-31 17:15:41 +0000">`;
          $ = cheerio.load(body);
          const result = linkAggregator.getPublishedTime($);
          const resultS = parseInt(result / 1000);
          assert.deepEqual(resultS, 1501521341);
        });
      });
    });

    it('prefers date to time', () => {
      const body = `
<span class="dt-published published dt-updated updated">
  <time class="value" datetime="17:37-0700">17:37</time> on <time class="value">2017-08-14</time>  </span>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1502668800);
    });

    it('prefers date over meta tags', () => {
      const body = `
<section class="subsection meta-box"><h2 class="title subsection__header">Details</h2><div id="bug-details" class="subsection__body edit-content"><dl>    <dt>Created</dt><dd>Aug 8, 2017</dd><dt>Privacy</dt><dd id="privacy"> This issue is public. </dd><div id="browser-list" class="detail-block"><dt>Found in</dt><dd><ul class="list--browser-icons"><li title="Microsoft Edge"><img src="https://az813057.vo.msecnd.net/images/edge_32x32.2268fcf.png" srcset="https://az813057.vo.msecnd.net/images/edge_64x64.d37f8fa.png 2x,https://az813057.vo.msecnd.net/images/edge_128x128.ab2b380.png 3x" alt="Microsoft Edge"></li>     </ul></dd></div><div id="standard-compliance" class="detail-block"></div><div id="found-in-build" class="detail-block"><dt>Found in build #</dt><dd id="buildNumber" class="ellipsis">16.16257</dd></div><div id="fixed-in-build" class="detail-block"></div><dt>Reports</dt><dd id="reported-by-num">Reported by 1 person</dd></dl><p><a href="/en-us/microsoft-edge/users/signin/?redirect=/en-us/microsoft-edge/platform/issues/13148742/">Sign in</a> to watch or report this issue.</p></div></section></div><div class="module module--primary wrap-text"><section class="subsection"><h2 class="title subsection__header header--alt">Steps to reproduce</h2><div class="subsection__body"><div id="repro-steps" class="bug-description base edit-content"><p>Steps to reproduce:</p>
<span class="activity__date__raw">2017-08-08T21:45:09.823Z</span>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1502228709);
    });


    it('nested date classes prefers date in h2', () => {
      const body = `
<div class="date-outer">
        
<h2 class='date-header'><span>Monday, 14 August 2017</span></h2>

          <div class="date-posts">
        
<div class='post-outer'>
<div class='post hentry'>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1502694000);
    });

    it('gives preference to nonempty time tags', () => {
      const body = `
<time datetime="2017-07-26 03:00:18"></time>
<time datetime="2017-07-19 17:36:04"></time>
<div class="byline">
  Posted <time datetime="2017-08-03" class="timestamp">Aug 3, 2017</time> by <a href="/author/ingrid-lunden/" title="Posts by Ingrid Lunden" onclick="s_objectID='river_author';" rel="author">Ingrid Lunden</a> <span class="twitter-handle">(<a href="https://twitter.com/ingridlunden" rel="external">@ingridlunden</a>)</span></div>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1501743600);
    });


    it('time with brackets and junk around it', () => {
      const body = `
<div class="date-and-tags" data-reactid="28"><!-- react-text: 29 -->[<!-- /react-text --><!-- react-text: 30 -->2017-07-22<!-- /react-text --><!-- react-text: 31 -->] <!-- /react-text --><a href="" data-reactid="32">dev</a><!-- react-text: 33 -->, <!-- /react-text --><a href="" data-reactid="34">javascript</a><!-- react-text: 35 -->, <!-- /react-text --><a href="" data-reactid="36">regexp</a><!-- react-text: 37 -->, <!-- /react-text --><a href="" data-reactid="38">template literals</a></div>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1500681600);
    });


    it('prefers the first occurring published-at time', () => {
      const body = `<span class="published-at">Jul 28, 2017</span>
<span class="published-at">on August 08, 2017</span>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1501225200);
    });

    it('updated id', () => {
      const body = `<section id="updated"><p>Last updated on 2017-07-17</p></section>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1500274800);
    });

    it('gets time in h2', () => {
      const body = `<h1 class="title">13 CSS Page Transitions</h1>
<h2 class="subtitle is-5">July 30, 2017 </h2>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1501398000);
    });

    it('published-at', () => {
      const body = `<span class="published-at">Jul 28, 2017</span><span class="action-space" id="action-space"></span>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1501225200);
    });

    it('nested date class', () => {
      const body = `<div class="date"><span>14 July 2017</span></div>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1500015600);
    });

    it('dateline class', () => {
      const body = `<span class="dateline">Jul. 31, 2017 12:47 AM</span>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1501487220);
    });

    it('post-meta class', () => {
      const body = `<div class="post-meta">Jul 17, 2017 • foobar</div>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1500274800);
    });

    it('meta class', () => {
      const body = `<p class="meta">
        Written by <em>Jorgé</em> on Saturday July 29, 2017
</p>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1501311600);
    });

    it('metadata class 1', () => {
      const body = `<p class="metadata">Posted 14-Aug 2017 under code.</p>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1502694000);
    });

    it('metadata class 2', () => {
      const body = `<p class="metadata">14-Aug 2017</p>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1502694000);
    });

    it('metadata class 3', () => {
      const body = `<p class="metadata">Posted 14-Aug 2017 under code.</p>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1502694000);
    });

    

    it('published-at class', () => {
      const body = `<span class="published-at">Jul 23, 2017</span>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1500793200);
    });

    it('published class', () => {
      const body = `<abbr class="published" title="2017-07-19T08:02:47-07:00">July 19, 2017</abbr>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1500447600);
    });

    it('matches <time> tag', () => {
      const body = `<time>July 19, 2017</time>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1500447600);
    });

    it('matches <time> tag with date not parsible in native JS', () => {
      const body = `<div class="banner__extra">Published on: <time datetime="20170727">27th July 2017 at 3pm</time></div>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1501192800);
    });

    it('matches non-meta tags', () => {
      const body = `<span class="pub-date" itemprop="datePublished" content="2017-07-21T03:00-0700">Jul 21, 2017</span>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1500631200);
    });

    it('matches class containing "date"', () => {
      const body = `<span class="byline__date">28 Jul 2017</span>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPublishedTime($);
      const resultS = parseInt(result / 1000);
      assert.deepEqual(resultS, 1501225200);
    });    
  })

  describe('getTwitterAuthor', function() {
    let $;
    const expectedResult = 'twitteruser';

    it('prefers Twitter links in likely author areas 1', () => {
      const body = `
<a href="twitter.com/foo">foo</a>
<footer>
<a href="twitter.com/${expectedResult}">foo</a>
</footer>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('prefers Twitter links in likely author areas 2', () => {
      const body = `
<a href="twitter.com/foo">foo</a>
<div class="foo-attribution-foo">
<a href="twitter.com/${expectedResult}">foo</a>
</div>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('prefers Twitter links in likely author areas 3', () => {
      const body = `
<a href="twitter.com/foo">foo</a>
<div class="foo-Attribution-foo">
<a href="twitter.com/${expectedResult}">foo</a>
</div>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('ignores Twitter names in comments (class)', () => {
      const body = `
  <div class="single-comment-node root  comment-deep-0"" data-comment-id="2591" data-comment-author-id="1737">
      <div class="inner-comment">
        <div class="details">
          <a href="/maxart2501">
            <img class="profile-pic" src="https://res.cloudinary.com/practicaldev/image/fetch/s--xVPVbw2O--/c_fill,f_auto,fl_progressive,h_50,q_auto,w_50/https://thepracticaldev.s3.amazonaws.com/uploads/user/profile_image/1737/2140858.jpeg" />
            <span class="comment-username">Massimo Artizzu</span>
          </a>
            <a href="http://twitter.com/MaxArt2501"><img class="icon-img" src="https://practicaldev-herokuapp-com.global.ssl.fastly.net/assets/twitter-logo-4f403dcfabe199e4eb9a484b701775e631514af75a980b2744a1d0cbfbaaa706.svg" alt="Twitter logo" /></a>
            <a href="http://github.com/MaxArt2501"><img class="icon-img" src="https://practicaldev-herokuapp-com.global.ssl.fastly.net/assets/github-logo-6a5bca60a4ebf959a6df7f08217acd07ac2bc285164fae041eacb8a148b1bab9.svg" alt="Github logo" /></a>
          <a href="/buntine/dom-elements-with-ids-are-global-variables/comments/3lh" class="permalink">
            <img class="icon-img" src="https://practicaldev-herokuapp-com.global.ssl.fastly.net/assets/link-e52c429ee7fe82bfec2d6542cc7b4a04b7d9f886827998833080ac23fcd2f169.svg" alt="Link" />
          </a>
        </div>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, '');
    });

    it('ignores Twitter names in comments (id)', () => {
      const body = `
  <div id="comment-node-2591">
      <div class="">
        <div class="details">
          <a href="/maxart2501">
            <img class="profile-pic" src="https://res.cloudinary.com/practicaldev/image/fetch/s--xVPVbw2O--/c_fill,f_auto,fl_progressive,h_50,q_auto,w_50/https://thepracticaldev.s3.amazonaws.com/uploads/user/profile_image/1737/2140858.jpeg" />
            <span class="comment-username">Massimo Artizzu</span>
          </a>
            <a href="http://twitter.com/MaxArt2501"><img class="icon-img" src="https://practicaldev-herokuapp-com.global.ssl.fastly.net/assets/twitter-logo-4f403dcfabe199e4eb9a484b701775e631514af75a980b2744a1d0cbfbaaa706.svg" alt="Twitter logo" /></a>
            <a href="http://github.com/MaxArt2501"><img class="icon-img" src="https://practicaldev-herokuapp-com.global.ssl.fastly.net/assets/github-logo-6a5bca60a4ebf959a6df7f08217acd07ac2bc285164fae041eacb8a148b1bab9.svg" alt="Github logo" /></a>
          <a href="/buntine/dom-elements-with-ids-are-global-variables/comments/3lh" class="permalink">
            <img class="icon-img" src="https://practicaldev-herokuapp-com.global.ssl.fastly.net/assets/link-e52c429ee7fe82bfec2d6542cc7b4a04b7d9f886827998833080ac23fcd2f169.svg" alt="Link" />
          </a>
        </div>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, '');
    });

    it('ignores links referring to twitter.com', () => {
      const body = `
<a href="http://www.npr.org/sections/money/2014/10/21/357629765/when-women-stopped-coding?utm_campaign=storyshare&utm_source=twitter.com&utm_medium=social">despite declining in other STEM fields</a>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, '');
    });

    it('handles hashbangs', () => {
      const body = `<div><a class="icon-twitter" href="http://twitter.com/#!/twitteruser"></a></div>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('ignores junk url params', () => {
      const body = `<li><a href='http://www.twitter.com/twitteruser?utm_medium=burger&utm_campaign=navigation&utm_source=ac'><span class='icomoon-twitter'></span></a></li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('ignores share links', () => {
      const body = `<a
    class="icon-twitter"
    href="https://twitter.com/share?text=8%20things%20to%20learn%20in%20React%20before%20using%20Redux by %40rwieruch %23ReactJs&url=https%3a%2f%2fwww.robinwieruch.de%2flearn-react-before-using-redux%2f"
    onclick="window.open(this.href, 'twitter-share', 'width=550,height=235');return false;">
    <i class="fa fa-twitter"></i>
</a>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, '');
    });

    it('ignores share 2', () => {
      const body = `<a href="https://twitter.com/share" class="twitter-share-button">Tweet</a>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, '');
    });

    it('gets author from share link', () => {
      const body = `<div><a href="https://twitter.com/share?text=Women%20Saved%20the%20Affordable%20Care%20Act&amp;via=twitteruser&amp;url=http%3A%2F%2Fwww.gq.com%2Fstory%2Fwomen-saved-the-affordable-care-act" data-pin-do="" target="_blank" aria-label="Twitter" data-reactid="86"><span class="icon" data-reactid="87"></span><span class="label" data-reactid="88">Twitter</span></a></div>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });


    describe('intents', () => {
      it('ignores user intent missing username', () => {
        const body = `<a target="_blank" href="https://twitter.com/intent/user?" class="icon icon-circle icon-twitter"></a>
  </div>`;
        $ = cheerio.load(body);
        const result = linkAggregator.getTwitterAuthor($);

        assert.deepEqual(result, '');
      });

      it('ignores user intent missing username 2', () => {
        const body = `<a href="//twitter.com/search?q=levelsio%20ARKit%20OR%20AR&src=typd">AR apps</a>`;
        $ = cheerio.load(body);
        const result = linkAggregator.getTwitterAuthor($);

        assert.deepEqual(result, '');
      });

      it('ignores first intent and is able to extract name from second link', () => {
        const body = `<div><a href="//twitter.com/search?q=levelsio%20ARKit%20OR%20AR&src=typd">AR apps</a>
<a href="//twitter.com/twitteruser">Twitter</a></div>`;
        $ = cheerio.load(body);
        const result = linkAggregator.getTwitterAuthor($);

        assert.deepEqual(result, expectedResult);
      });

      it('ignores tweet intent missing username', () => {
        const body = `<a href="https://twitter.com/intent/tweet?hashtags=codebrahma&original_referer=http://www.codebramha.com/&text=Check%20out%20this%20amazing%20post%20:%20&tw_p=tweetbutton&url=https://codebrahma.com/structuring-async-operations-react-redux-applications/" class="social twitter" title="Share on Twitter" target="_blank"><i class="fa fa-twitter"></i></a>`;
        $ = cheerio.load(body);
        const result = linkAggregator.getTwitterAuthor($);

        assert.deepEqual(result, '');
      });

      it('extracts username from user intent', () => {
        const body = `<div><a target="_blank" href="https://twitter.com/intent/user?screen_name=twitteruser" class="icon icon-circle icon-twitter"></a></div>`;
        $ = cheerio.load(body);
        const result = linkAggregator.getTwitterAuthor($);

        assert.deepEqual(result, expectedResult);
      });

      it('extracts username from tweet intent', () => {
        const body = `<div><a href="https://twitter.com/intent/tweet?hashtags=codebrahma&original_referer=http://www.codebramha.com/&text=Check%20out%20this%20amazing%20post%20:%20&tw_p=tweetbutton&url=https://codebrahma.com/structuring-async-operations-react-redux-applications/&via=twitteruser" class="social twitter" title="Share on Twitter" target="_blank"><i class="fa fa-twitter"></i></a></div>`;
        $ = cheerio.load(body);
        const result = linkAggregator.getTwitterAuthor($);

        assert.deepEqual(result, expectedResult);
      });
    });

    it('protocol-less url', () => {
      const body = `<li>
        <a href="//twitter.com/twitteruser" title="Follow on Twitter">
          <i class="fa fa-fw fa-twitter"></i>
        </a>
      </li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('protocol-less url 2', () => {
      const body = `<li>
        <a href="twitter.com/twitteruser" title="Follow on Twitter">
          <i class="fa fa-fw fa-twitter"></i>
        </a>
      </li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('unsecure http link', () => {
      const body = `<li>
        <a href="http://twitter.com/twitteruser" title="Follow on Twitter">
          <i class="fa fa-fw fa-twitter"></i>
        </a>
      </li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('secure https link', () => {
      const body = `<li>
        <a href="https://twitter.com/twitteruser" title="Follow on Twitter">
          <i class="fa fa-fw fa-twitter"></i>
        </a>
      </li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('trailing slash', () => {
      const body = `<li>
        <a href="https://twitter.com/twitteruser/" title="Follow on Twitter">
          <i class="fa fa-fw fa-twitter"></i>
        </a>
      </li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('ignores status tweets', () => {
      const body = `<li>
        <a href="https://twitter.com/twitteruser/status/883717424482209796" title="Follow on Twitter">
          <i class="fa fa-fw fa-twitter"></i>
        </a>
      </li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, '');
    });

    it('twitter card - creator', () => {
      const body = `<li>
        <meta name="twitter:creator" content="@twitteruser">
      </li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });

    it('twitter card - site', () => {
      const body = `<li>
        <meta name="twitter:site" content="@twitteruser">
      </li>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getTwitterAuthor($);

      assert.deepEqual(result, expectedResult);
    });
  });


  describe('getPageTitle', function() {
    let $;
    const expectedResult = 'thepagetitle';

    it('trims long titles', () => {
      const title = 'Did not check* Facebook for 2 weeks. This is my first post in a fortnight. Didn’t listen to iPod for 12d. Returning home from Paris after 10 days, everything seemed the same but different.';
      const body = `

<!DOCTYPE html><html><head><meta charset="utf-8" />
<title>${title}${title}${title}</title>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageTitle($);

      assert.deepEqual(result, title.substr(0, 150));
    });

    it('does not match multiple title tags', () => {
      const body = `
        <!doctype html>
<!--[if lt IE 7]>      <html class="no-js lt-ie9 lt-ie8 lt-ie7"> <![endif]-->
<!--[if IE 7]>         <html class="no-js lt-ie9 lt-ie8"> <![endif]-->
<!--[if IE 8]>         <html class="no-js lt-ie9"> <![endif]-->
<!--[if gt IE 8]><!--> <html class="no-js"> <!--<![endif]-->
    <head>
        <meta charset="UTF-8" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <title>${expectedResult}</title>


    </head>

    <body class="page page-id-49 page-template-default contact-us">
<symbol id="icon-lanyrd" viewBox="0 0 1024 1024">
    <title>lanyrd</title>
    <path class="path1" d="M512 20.48c-271.36 0-491.52 220.16-491.52 491.52s220.16 491.52 491.52 491.52 491.52-220.16 491.52-491.52-220.16-491.52-491.52-491.52zM711.68 675.84c-61.44 20.48-179.2 61.44-204.8 66.56-20.48 5.12-46.080 15.36-56.32-20.48 0 0-112.64-327.68-122.88-358.4s-20.48-46.080 5.12-56.32c51.2-20.48 107.52-46.080 117.76-15.36 10.24 25.6 107.52 327.68 107.52 327.68s112.64-40.96 143.36-51.2c30.72-10.24 40.96-15.36 51.2 30.72s20.48 56.32-40.96 76.8z"></path>
</symbol>
<symbol id="icon-mail" viewBox="0 0 1024 1024">
    <title>mail</title>
    <path class="path1" d="M81.613 270.643c24.986 13.466 371.149 199.373 384.051 206.285 12.851 6.912 29.542 10.24 46.336 10.24 16.845 0 33.536-3.328 46.387-10.291 12.902-6.912 359.014-192.819 384-206.285 25.037-13.414 48.691-55.552 2.765-55.552h-866.253c-45.926 0-22.323 42.138 2.714 55.603zM952.986 373.043c-28.416 14.848-377.19 197.171-394.598 206.285s-29.542 10.291-46.387 10.291c-16.794 0-28.928-1.178-46.336-10.291s-366.234-191.488-394.598-206.285c-20.019-10.445-19.866 1.792-19.866 11.213s0 375.552 0 375.552c0 21.504 28.621 49.152 50.79 49.152h820.070c22.221 0 50.739-27.648 50.739-49.101 0 0 0-366.131 0-375.552 0-9.472 0.205-21.709-19.814-11.264z"></path>
</symbol>
<symbol id="icon-arrow-left" viewBox="0 0 1024 1024">
    <title>arrow-left</title>
`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageTitle($);

      assert.deepEqual(result, expectedResult);
    });

    it('matches Twitter card', () => {
      const body = `
        <!doctype html>
    <head>
        <meta charset="UTF-8" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <meta name="twitter:title" content="${expectedResult}" />
        <title>foo2</title>

`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageTitle($);

      assert.deepEqual(result, expectedResult);
    });

    it('matches Open Graph', () => {
      const body = `
        <!doctype html>
    <head>
        <meta charset="UTF-8" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <meta property="og:title" content="${expectedResult}" />
        <title>foo2</title>

`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageTitle($);

      assert.deepEqual(result, expectedResult);
    });

    it('1', () => {
      const body = `<html lang="en"> <head> <meta charset="utf-8"> <meta name="viewport" content="width=device-width, initial-scale=1.0"> <!--Title--> <title>thepagetitle</title> <!--Description--> <meta name="description" content="Thinking about a switch from React to Vue? They're similar beasts but with a few key differences. In this article I'll explain the differences so you're ready to jump in to VueJS and be productive."> <!--Date--> <meta content="2017-05-28T00:00:00+00:00" property="article:published_time">`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageTitle($);

      assert.deepEqual(result, expectedResult);
    });

    it('2', () => {
      const body = `






<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
  <link rel="dns-prefetch" href="https://assets-cdn.github.com">
  <link rel="dns-prefetch" href="https://avatars0.githubusercontent.com">
  <link rel="dns-prefetch" href="https://avatars1.githubusercontent.com">
  <link rel="dns-prefetch" href="https://avatars2.githubusercontent.com">
  <link rel="dns-prefetch" href="https://avatars3.githubusercontent.com">
  <link rel="dns-prefetch" href="https://github-cloud.s3.amazonaws.com">
  <link rel="dns-prefetch" href="https://user-images.githubusercontent.com/">



  <link crossorigin="anonymous" href="https://assets-cdn.github.com/assets/frameworks-e04a23d39bf81b7db3c635177756ef51bc171feb440be9e174933c6eb56382da.css" integrity="sha256-4Eoj05v4G32zxjUXd1bvUbwXH+tEC+nhdJM8brVjgto=" media="all" rel="stylesheet" />
  <link crossorigin="anonymous" href="https://assets-cdn.github.com/assets/github-0eefc2e653e37f1e1077333bf8fa9ccdd7614e6f8ac38102f64367ab8165b029.css" integrity="sha256-Du/C5lPjfx4QdzM7+PqczddhTm+Kw4EC9kNnq4FlsCk=" media="all" rel="stylesheet" />
  
  
  
  

  <meta name="viewport" content="width=device-width">
  
  <title>thepagetitle</title>
  <link rel="search" type="application/opensearchdescription+xml" href="/opensearch.xml" title="GitHub">
  <link rel="fluid-icon" href="https://github.com/fluidicon.png" title="GitHub">
  <meta property="fb:app_id" content="1401488693436528">
      `;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageTitle($);

      assert.deepEqual(result, expectedResult);
    });


    
  });

  
});