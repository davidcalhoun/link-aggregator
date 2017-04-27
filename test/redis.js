const redis = require('redis');
const client = redis.createClient();
const assert = require('assert');

const redisNSPrefix = 'la-test-';

describe('redis', function() {
  const assert = require('assert');
  const la = require('../link-aggregator');

  let linkAggregator;

  const config = {
    redisPrefix: redisNSPrefix
  };

  beforeEach(function() {
    linkAggregator = new la(config);
  });

  describe('uniqueLPUSH', function() {
    const listName = `${redisNSPrefix}list`;

    afterEach((done) => {
      client.del(listName, done);
    });

    it('adds value to empty list', function(done) {
      const insertVal = 'foo';

      linkAggregator.uniqueLPUSH(listName, insertVal, (err, reply) => {
        assert.equal(err, null);
        assert.notEqual(reply, null);

        client.lrange(listName, 0, -1, (err, reply) => {
          assert.equal(err, null);
          assert.deepEqual(reply, [ insertVal ]);

          done();
        });
      });
    });

    it('adds value to nonempty list', function(done) {
      const insertVal = 'foo';

      // Setup list so it's not empty initially.
      client.lpush(listName, 'bar', (err, reply) => {
        assert.equal(err, null);
        assert.notEqual(reply, null);

        linkAggregator.uniqueLPUSH(listName, insertVal, (err, reply) => {
          assert.equal(err, null);
          assert.notEqual(reply, null);

          client.lrange(listName, 0, -1, (err, reply) => {
            assert.equal(err, null);
            assert.deepEqual(reply, [ insertVal, 'bar' ]);

            done();
          });
        });
      });
    });

    it('doesnt add value if dupe', function(done) {
      const insertVal = 'foo';

      client.lpush(listName, insertVal, (err, reply) => {
        assert.equal(err, null);
        assert.notEqual(reply, null);

        linkAggregator.uniqueLPUSH(listName, insertVal, (err, reply) => {
          assert.equal(err, null);
          assert.notEqual(reply, null);

          client.lrange(listName, 0, -1, (err, reply) => {
            assert.equal(err, null);
            assert.deepEqual(reply, [ insertVal ]);

            done();
          });
        });
      });
    });
  });
});