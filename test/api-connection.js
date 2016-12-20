describe('api-keys', function(){
    var assert = require('assert');
    var config = require('./api-config');
    var la = require('../link-aggregator');
    var LinkAggregator;

    before(function() {
        LinkAggregator = la(config);
    });

    it('is exported as an npm module', function(){
        var linkAggregator = require('../link-aggregator');
        assert.equal(typeof linkAggregator, 'function');
    });

    it('initializes Twitter', function() {
        assert.equal(typeof LinkAggregator.twitter, 'object');
    });

    it('initializes Codebird', function() {
        assert.equal(typeof LinkAggregator.codebird, 'object');
    });

    it('initializes Pocket', function() {
        assert.equal(typeof LinkAggregator.pocket, 'object');
    });
});