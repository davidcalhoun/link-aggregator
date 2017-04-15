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
        // TODO remove keys here - not needed in tests
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

      linkAggregator.fetchPocketList(pocketConfig, (err, data) => {
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

      linkAggregator.fetchPocketList(config, (err, data) => {
        assert.equal(err, null);
        assert.equal(typeof data, 'object');
        assert.equal(Array.isArray(data), true);

        console.log(111, JSON.stringify(data, null, 2))

        //assert.notEqual(data[0].categories.length, 0);

        done();
      })
    });

});