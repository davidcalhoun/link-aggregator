const assert = require('assert');

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
});