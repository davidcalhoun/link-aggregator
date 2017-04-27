const assert = require('assert');

describe('scraper', function() {
  const assert = require('assert');
  const la = require('../link-aggregator');

  let linkAggregator;

  beforeEach(function() {
    linkAggregator = new la();
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
    const categories = [{
      name: 'Video',
      keywords: {
        keywords: ['video'],
        regexp: /video/gi
      }
    }];

    it('matches a word in a sentence', () => {
      const cats = linkAggregator._getCategoriesFromText('something video something', categories);
      assert.deepEqual(cats, [ 'Video' ]);
    });

    it('matches a word in a url', () => {
      const cats = linkAggregator._getCategoriesFromText('http://video.com', categories);
      assert.deepEqual(cats, [ 'Video' ]);
    });

    it('doesnt match a partial word', () => {
      const categories = [{
        name: 'Design',
        keywords: {
          keywords: ['design'],
          regexp: /\bdesign\b/gi
        }
      }];
      const cats = linkAggregator._getCategoriesFromText('foofoodesignedfoo', categories);
      assert.deepEqual(cats, []);
    });
  });
});