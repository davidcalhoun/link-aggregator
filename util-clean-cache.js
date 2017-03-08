const redis = require('redis');

const client = redis.createClient();

const laPrefix = 'la-';

client.lrange(`${laPrefix}urls`, 0, -1, (err, urls) => {
	// Delete url list.
	client.del(`${laPrefix}urls`);

	deleteURLs(urls, (err, reply) => {
		console.log(`Deleted ${reply.length} urls from list.`);

		// Find orphaned urls not appearing on list.
		client.keys(`${laPrefix}*`, (err, orphanedURLs) => {
			deleteURLs(orphanedURLs, (err, reply) => {
				console.log(`Deleted ${reply.length} orphaned urls.`);
				process.exit();
			});
		});
	})
});



const deleteURLs = (urls, done) => {
	const deleteMulti = client.multi();

	// Delete each url's cache.
	urls.forEach((url) => {
		deleteMulti.del(url);
	});

	deleteMulti.exec(done);
};