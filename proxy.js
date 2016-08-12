// CORS proxy for requests to the Pocket API, which doesn't support CORS (yet?)
// https://twitter.com/franksvalli/status/763201727533240321

// NOTE: Requires generation of SSL key and cert!
// Follow instructions at http://www.akadia.com/services/ssh_test_certificate.html
var sslKeyPath = __dirname + '/server.key';
var sslCertPath = __dirname + '/server.crt';


var fs = require('fs');
var http = require('http');
var https = require('https');
var express = require('express');  
var request = require('request');

var app = express();

var port = 8000;

// TLS/SSL key and cert, enabling HTTPS to function
var options = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath),
};

var app = express();

var server = https.createServer(options, app).listen(port, function(){
  console.log("Express server listening on port " + port);
});

var allowCrossDomain = function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'X-Accept, Content-Type');
  res.header('Access-Control-Max-Age', 86400); // In seconds (=1 day)
  res.header('Content-Length', 0);
  next();
};

app.use(allowCrossDomain);

app.use('/', function(req, res, next) {
  if('access-control-request-headers' in req.headers ||
     'access-control-request-method' in req.headers) {
    // CORS preflight request - see https://remysharp.com/2011/04/21/getting-cors-working
    console.log('CORS preflight');
    res.status(200).end();
  } else {
    // Regular request
    console.log('regular request')

    var url = req.url.replace('/?url=', '');
    req.pipe(request('https://' + url)).pipe(res);
  }

});
