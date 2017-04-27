const assert = require('assert');

describe('scraper', function() {
  const assert = require('assert');
  const la = require('../link-aggregator');

  let linkAggregator;

  beforeEach(function() {
    linkAggregator = new la();
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