describe('pocket', function(){
    const assert = require('assert');
    const config = require('./api-config');
    const la = require('../link-aggregator');
    const Promise = require('promise-polyfill');
    const { pocketStub } = require('./stubs');

    let linkAggregator;
    let pocketConfig = {};

    before(function() {
      linkAggregator = new la(config);

      pocketConfig = {
        consumerKey: config.pocket.consumer_key,
        accessToken: config.pocket.access_token,
        apiUrl: config.pocket.proxy,
        fetchStub: () => {
          return new Promise((resolve, reject) => {
            resolve(pocketStub);
          })
        }
      };
    });

    it('gets a Pocket list', function(done){
      this.timeout(10000);

      linkAggregator.setCategories({
        'Accessibility': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      });

      linkAggregator.getPocketList(pocketConfig, (err, data) => {
        assert.equal(err, null);
        assert.equal(typeof data, 'object');
        done();
      });
    });

    it('returns categories', function(done){
      this.timeout(10000);

      linkAggregator.setCategories({
        'Accessibility': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      });

      const config = Object.assign({}, pocketConfig, {
        tag: 'fbfe'
      });

      linkAggregator.getPocketList(config, (err, data) => {
        assert.equal(err, null);
        assert.equal(typeof data, 'object');
        assert.equal(Array.isArray(data), true);

        assert.notEqual(data[0].categories.length, 0);

        done();
      })
    });

});