require('env.js');
var Language = require('@google-cloud/language');
var gmaps = require('@google/maps');
var async = require('async');
var request = require('request');
var fs = require('fs-extra');
var Gm = require('gm');
var wordfilter = require('wordfilter');
var Twit = require('twit');
var _ = require('lodash');

var t = new Twit({
  consumer_key: process.env.TWIT_CONSUMER_KEY,
  consumer_secret: process.env.TWIT_CONSUMER_SECRET,
  access_token: process.env.TWIT_ACCESS_TOKEN,
  access_token_secret: process.env.TWIT_ACCESS_TOKEN_SECRET
});

getTweets = function(cb) {
  console.log('getting tweets');
  t.get('search/tweets', {
    q: 'e',
    count: 20,
    result_type: 'recent',
    lang: 'en'
  }, function(err, dat, response) {
    if (!err) {
      var data = {
        tweetTexts: dat.statuses.map(function(status) {
          return status.text;
        })
      };
      cb(null, data);
    } else {
      cb(err, null);
    }
  });
};

extractWords = function(data, cb) {
  console.log('extracting words');
  var excludeNonAlpha = /[^a-zA-Z]+/g;
  var excludeURLs = /https?:\/\/[-a-zA-Z0-9@:%_\+.~#?&\/=]+/g;
  var excludeHandles = /@[a-z0-9_-]+/g;
  var excludeRT = /\bRT\b/gi;
  var excludePatterns = [excludeURLs, excludeHandles, excludeNonAlpha, excludeRT];
  data.text = data.tweetTexts.join(' ');

  for (var pat = 0; pat < excludePatterns.length; pat++) {
    data.text = data.text.replace(excludePatterns[pat], ' ');
  }

  cb(null, data);
};

getPlaceNames = function(data, cb) {
  console.log('getting place names');
  var languageClient = Language({
    projectId: 'herebot-163615'
  });

  languageClient.detectEntities(data.text, function(err, results) {
      if (!err) {
        data.locationList = _.reject(results, (function(item) {
          return item.type !== 'LOCATION' || item.name.length < 3;
        })).map(function(item) {
          return item.name;
        });
        data.locIndex = 0;
        if (data.locationList.length) {
          cb(null, data);
        } else {
          cb('No locations found', data);
        }
      } else {
        cb(err, data);
      }
  });
};

excludeDupes = function(data, cb) {
  console.log('removing dupes');
  var excludeList = ["anywhere", "nowhere", "here", "there", "country", "city", "town", "state"];
  fs.readFile(process.env.TWEET_LIST, 'utf8', function readFileCallback(err, dat) {
    if (err) {
      cb(err, data);
    } else {
      obj = JSON.parse(dat);
      data.locationList = _.reject(data.locationList, function(item) {
        return (obj.tweets.map(function(tweet) {
          return tweet.location.toLowerCase();
        }).concat(excludeList).indexOf(item.toLowerCase()) > -1);
      });
      cb(null, data);
    }
  });
};

getCoords = function(data, cb) {
  console.log('getting coordinates');
  var googleMapsClient = gmaps.createClient({
    key: process.env.MAPS_API_KEY
  });

  data.location = data.locationList[data.locIndex];

  googleMapsClient.geocode({
    address: data.location
  }, function(err, response) {
    if (err)
      cb(err, data);
    else if (!response.json.results.length) {
      if (data.locIndex == data.locationList.length - 1)
        cb('No locations located', data);
      else {
        data.locIndex++;
        getCoords(data, cb);
      }
    } else {
      data.coords = response.json.results[0].geometry.location;
      cb(null, data);
    }
  });
};

makeDir = function(data, cb) {
  console.log('making directory');
  data.dirname = data.location.replace(' ', '');
  fs.mkdirSync(data.dirname);
  cb(null, data);
};

getImages = function(data, cb) {
  console.log('loading images');

  var res = 600;
  var levels = 16;
  var start = 2;
  var seq = [];

  for (var step = 0; step < levels; step++) {
    seq.push(step);
  }

  var lat = data.coords.lat,
      lng = data.coords.lng;
  data.images = [];

  var getFile = function(step, dlcallback) {
    var url = 'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/' + [lng, lat, step + start].join(',') + '/' + [res, res].join('x') + '?access_token=' + process.env.MAPBOX_TOKEN;
    var filename = data.dirname + '/img' + step + '.jpg';

    request.get(url, function(err, response, body) {
      if (err) {
        cb(err, data);
      } else {
        data.images[step] = filename;
        return dlcallback(null, body);
      }
    }).pipe(fs.createWriteStream(filename));
  };

  async.map(seq, getFile, function(err, results) {
    if (err) {
      cb(err, data);
    } else {
      cb(null, data);
    }
  });
};

makeGif = function(data, cb) {
  console.log('generating gif');

  var gm = new Gm();
  data.gifFile = data.dirname + '/animated.gif';

  data.images.forEach(function(img) {
    gm.in(img);
  });

  gm
    .delay(30)
    .write(data.gifFile, function(err) {
      if (err) cb(err, data);
      else cb(null, data);
    });
};

formatTweet = function(data, cb) {
  console.log('writing tweet');

  data.tweetText = '#' + data.location.split(' ').join('') + ': you are here.';
  if (wordfilter.blacklisted(data.tweetText))
    cb('That is obscene', data);
  else
    cb(null, data);
};

postTweet = function(data, cb) {
  console.log('posting tweet');

  var gif = fs.readFileSync(data.gifFile, {
    encoding: 'base64'
  });

  t.post('media/upload', {
    media_data: gif
  }, function(err, dat, response) {
    var mediaIdStr = dat.media_id_string;
    var altText = "Zooming in on " + data.location;
    var meta_params = {
      media_id: mediaIdStr,
      alt_text: {
        text: altText
      }
    };

    t.post('media/metadata/create', meta_params, function(err, dat, response) {
      if (err)
        cb(err, data);
      else {
        var params = {
          status: data.tweetText,
          media_ids: [mediaIdStr]
        };

        t.post('statuses/update', params, function(err, dat, response) {
          data.tweetDate = dat.created_at;
          data.tweetID = dat.id_str;
          cb(null, data);
        });
      }
    });
  });
};

cleanup = function(data, cb) {
  console.log('cleaning up');

  fs.removeSync(data.dirname);
  fs.readFile(process.env.TWEET_LIST, 'utf8', function readFileCallback(err, dat) {
    if (err) {
      cb(err, data);
    } else {
      obj = JSON.parse(dat);
      obj.tweets.push({
        location: data.location,
        date: data.tweetDate,
        id: data.tweetID
      });
      json = JSON.stringify(obj);
      fs.writeFile(process.env.TWEET_LIST, json, 'utf8', cb(null, data));
    }
  });
};

run = function() {
  async.waterfall([
      getTweets,
      extractWords,
      getPlaceNames,
      excludeDupes,
      getCoords,
      makeDir,
      getImages,
      makeGif,
      formatTweet,
      postTweet,
      cleanup
    ],
    function(err, data) {
      if (err) {
        console.log('There was an error: ', err, '\n', data);
      } else {
        console.log('Successful!');
        console.log(data);
      }
    });
};

run();
