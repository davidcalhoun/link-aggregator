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


  describe('getTwitterAuthor', function() {
    let $;
    const expectedResult = 'twitteruser';

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