describe.skip('twitter', function(){
    var assert = require('assert');
    var config = require('./api-config');
    var la = require('../link-aggregator');
    var linkAggregator;

    before(function() {
        linkAggregator = la(config);
    });

    it('gets a Twitter list', function(done){
      this.timeout(10000);

      // // https://twitter.com/franksvalli/lists/frontend
      linkAggregator.twitterList({
        owner: 'franksvalli',
        name: 'frontend',
        multipleCallbacks: false
      }, (err, data) => {
        assert.equal(err, null);
        assert.equal(typeof data, 'object');

        done();
      });
    });

    it('returns categories', function(done){
      this.timeout(10000);

      linkAggregator.setCategories({
          'Accessibility': ['accessible', 'accessibility', 'aria', 'screen reader', 'screenreader'],
          'Angular': ['Angular'],
          'Apple': ['developer.apple.com'],
          'Book': ['manning.com', 'book'],
          'Business': ['pitch'],
          'Chrome': ['chrome', 'canary'],
          'Class': ['centercentre.com', 'workshop', 'connect.tech'],
          'CSS': ['css'],
          'Demo': ['codepen.io'],
          'Design': ['design', 'designers', 'interface', '#ux', 'leadingdesignconf.com', '#ui', 'usability'],
          'Devtools': ['devtools'],
          'Event': [
              'call for speakers', 'call for papers', 'AWSSummit', 'viewsourceconf.org', 'leadingdesignconf.com',
              'jsconf', 'webdirections', '@ffconf', 'bdconf.com', '@bdconf', 'sciencehackday.org', '@render_conf',
              'webinar', '@braziljs',
          ],
          'JavaScript': [
              // Note: 'service workers' term is too overloaded
              'javascript', 'web workers', 'indexeddb', 'ES5', 'ES6', 'ES7', 'ES8', 'ES9',
              'Polyfill', 'web animations', 'echojs.com', '@echojs', '@JavaScriptDaily', 'lodash', 'ramda',
              '@varjs',
          ],
          'Meetup': ['meetup.com', 'eventbrite.com', 'manhattanjs.com', '@AustinJS', '@leedsjs'],
          'Microsoft Edge': ['Microsoft Edge', '@MicrosoftEdge'],
          'Mobile': ['mobile', 'mobile web', '#mobileweb'],
          'Node.js': ['node', 'nodejs', 'node.js', 'npmjs.com/package'],
          'Opera': ['Opera'],
          'Performance': ['performance', 'perfmatters', '@velocityconf', '@perfplanet', 'WPOstats'],
          'Podcast': ['podcast', '5by5.tv', 'changelog.com', 'rfc.fm'],
          'Package Managers': ['webpack'],
          'Progressive Web Apps': ['Progressive Web Apps', '#pwa'],
          'React Native': ['ReactNative'],
          'React.js': ['React.js'],
          'Responsive Web Design': ['Responsive Web Design', '#rwd'],
          'Safari': ['safari'],
          'Security': ['security', 'hackers'],
          'Sencha': ['sencha'],
          'Slides': ['speakerdeck.com'],
          'Testing': ['mocha', 'jasmine'],
          'Webkit': ['webkit.org'],
          'Web Apps': ['web app', 'webapp'],
      });

      // // https://twitter.com/franksvalli/lists/frontend
      linkAggregator.twitterList({
        owner: 'franksvalli',
        name: 'frontend',
        multipleCallbacks: false
      }, (err, data) => {
        assert.equal(err, null);
        assert.equal(typeof data, 'object');

        done();
      });
    });

});