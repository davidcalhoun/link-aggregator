describe('pocket', function(){
    var assert = require('assert');
    var config = require('./api-config');
    var la = require('../link-aggregator');
    var linkAggregator;

    before(function() {
        linkAggregator = la(config);
    });

    it('gets a Pocket list', function(done){
      this.timeout(10000);

      linkAggregator.getPocketList()
        .then((data) => {
          console.log(444, data)
          assert.equal(typeof data, 'object');
          done();
        })
        .catch((error) => {
          assert.fail();
          done();
        })
    });

    it('returns categories', function(done){
      this.timeout(10000);

      linkAggregator.setCategories({
        'Accessibility': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      });

      linkAggregator.getPocketList({
        tag: 'fbfe'
      })
      .then((data) => {
        assert.equal(typeof data, 'object');
        assert.equal(Array.isArray(data), true);
        assert.notEqual(data[0].categories.length, 0);

        done();
      })
      .catch((error) => {
        assert.fail();
        done();
      })
    });

});