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
    it('preserves hashes by default', () => {
      const removeConfig = [
        {
          domain: ['medium.com'],
          params: []
        }
      ];
      const url = 'https://medium.com/fooo/writing-well-c361ce91f69f#---0-151.46y842iju';
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
      const url = 'https://medium.com/fooo/writing-well-c361ce91f69f#---0-151.46y842iju';
      const expectedOutput = 'https://medium.com/fooo/writing-well-c361ce91f69f';
      const output = linkAggregator.removeJunkURLParams(url, removeConfig);

      assert.equal(output, expectedOutput);
    });
  });

  describe('_getCategoriesFromText', function() {
    const categories = {
      "Video": ["video"]
    };

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

    it('strips HTML', () => {
      const expectedResult = 'foo foo bar bar';
      const body = `<meta property="og:description" content="${expectedResult}&lt;a href=&quot;https://www.reddit.co" />`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageExcerpt($);

      assert.deepEqual(result, expectedResult);
    });

    it('preserves instructional HTML', () => {
      const body = `<body><p>to provide clarity on how web loading primitives (like <a href="example.com"><strong>&lt;link rel=“preload”&gt;</strong>)</a></p></body>`;
      $ = cheerio.load(body);
      const result = linkAggregator.getPageExcerpt($);

      assert.deepEqual(result, 'to provide clarity on how web loading primitives (like &lt;link rel=“preload”&gt;)');
    });
  });

  describe('getTwitterAuthor', function() {
    let $;
    const expectedResult = 'twitteruser';

    describe('intents', () => {
      it('ignores user intents', () => {
        const body = `<a target="_blank" href="https://twitter.com/intent/user?screen_name=creativebloq" class="icon icon-circle icon-twitter"></a>
  </div>`;
        $ = cheerio.load(body);
        const result = linkAggregator.getTwitterAuthor($);

        assert.deepEqual(result, '');
      });

      it('ignores tweet intents', () => {
        const body = `<a href="https://twitter.com/intent/tweet?hashtags=codebrahma&original_referer=http://www.codebramha.com/&text=Check%20out%20this%20amazing%20post%20:%20&tw_p=tweetbutton&url=https://codebrahma.com/structuring-async-operations-react-redux-applications/&via=codebrahma" class="social twitter" title="Share on Twitter" target="_blank"><i class="fa fa-twitter"></i></a>`;
        $ = cheerio.load(body);
        const result = linkAggregator.getTwitterAuthor($);

        assert.deepEqual(result, '');
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