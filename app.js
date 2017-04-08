require('./env.js');
var languageClient = require('@google-cloud/language')({
  projectId: process.env.LANGUAGE_PROJECT_ID
});
var googleMapsClient = require('@google/maps').createClient({
  Promise: Promise,
  key: process.env.MAPS_API_KEY
});
var async = require('async');
var request = require('request');
var fs = require('fs-extra');
var wordfilter = require('wordfilter');
var Gm = require('gm');
var Twit = require('twit-promise');
var _ = require('lodash');

var T = new Twit({
  consumer_key: process.env.TWIT_CONSUMER_KEY,
  consumer_secret: process.env.TWIT_CONSUMER_SECRET,
  access_token: process.env.TWIT_ACCESS_TOKEN,
  access_token_secret: process.env.TWIT_ACCESS_TOKEN_SECRET
});

function queryTweets() {
  console.log('> getting tweets');
  return T.get('search/tweets', {
    q: 'a',
    count: 25,
    result_type: 'recent',
    lang: 'en'
  });
}

function getTweetText(result) {
  console.log('> retrieved ' + result.data.statuses.length + ' tweets');
  console.log('> getting tweet text');
  var tweetData = {
    tweetTexts: result.data.statuses.map(function(status) {
      return status.text;
    })
  };
  return tweetData;
}

function extractWords(tweetData) {
  console.log('> extracting words from tweets');
  try {
    var excludeNonAlpha = /[^a-zA-Z]+/g;
    var excludeURLs = /https?:\/\/[-a-zA-Z0-9@:%_\+.~#?&\/=]+/g;
    var excludeHandles = /@[a-z0-9_-]+/g;
    var excludeRT = /\bRT\b/gi;
    var excludePatterns = [excludeURLs, excludeHandles, excludeNonAlpha, excludeRT];
    tweetData.text = tweetData.tweetTexts.join(' ');
    for (var pat = 0; pat < excludePatterns.length; pat++) {
      tweetData.text = tweetData.text.replace(excludePatterns[pat], ' ');
    }
    return tweetData;
  } catch (err) {
    throw err;
  }
}

function getEntityNames(tweetData) {
  console.log('> getting entity names');
  return languageClient.detectEntities(tweetData.text)
    .then(function(results) {
      tweetData.entities = results[0];
      return tweetData;
    });
}

function removeNonPlaces(tweetData) {
  console.log('> filtering out non-places');
  tweetData.locationList = _.reject(tweetData.entities, (function(item) {
    return item.type !== 'LOCATION' || item.name.length < 3;
  })).map(function(item) {
    return item.name;
  });
  if (tweetData.locationList.length) {
    tweetData.locIndex = 0;
    console.log('> ' + tweetData.locationList.length + ' locations found');
    return tweetData;
  } else
    throw Error('no locations found.');
}

function getList(tweetData) {
  return new Promise(function(resolve, reject) {
    fs.readFile(process.env.TWEET_LIST, 'utf8', function(err, fileData) {
      if (err)
        reject(err);
      else {
        tweetData.fileData = JSON.parse(fileData);
        resolve(tweetData);
      }
    });
  });
}

function filterList(tweetData) {
  console.log('> filtering list');
  var excludeList = ["anywhere", "nowhere", "here", "there", "country", "city", "town", "state"];
  try {
    var fullList = tweetData.fileData.tweets.map(function(tweet) {
      return tweet.location.toLowerCase();
    }).concat(excludeList);
    tweetData.locationList = _.reject(tweetData.locationList, function(item) {
      return fullList.indexOf(item.toLowerCase()) > -1;
    });
    if (tweetData.locationList.length) {
      console.log('> ' + tweetData.locationList.length + ' locations remain');
      return tweetData;
    } else
      throw Error('all locations rejected.');
  } catch (err) {
    throw err;
  }
}

function checkGeocode(address) {
  console.log('> checking geocode for ' + address);
  return googleMapsClient.geocode({
    address: address
  }).asPromise();
}

function getCoords(tweetData) {
  console.log('> checking coordinates');
  return Promise.all(tweetData.locationList.map(function(location) {
    return checkGeocode(location);
  })).then(function(results) {
    tweetData.allCoords = results;
    return tweetData;
  });
}

function pickCoords(tweetData) {
  console.log('> picking coordinates');
  for (var i = 0; i < tweetData.allCoords.length; i++) {
    var loc = tweetData.allCoords[i].json.results[0];
    if (loc) {
      tweetData.coords = loc.geometry.location;
      tweetData.location = tweetData.locationList[i];
      console.log('> picked ' + tweetData.location);
      return tweetData;
    }
  }
  throw Error('no coordinates found');
}

function makeDir(tweetData) {
  console.log('> making directory');
  return new Promise(function(resolve, reject) {
    tweetData.dirName = tweetData.location.replace(' ', '');
    fs.mkdir(tweetData.dirName, function(err) {
      if (err)
        reject(err);
      else {
        resolve(tweetData);
      }
    });
  });
}

function loadImage(url, filename) {
  var file = request.get(url, function(err, response, body) {
    if (err)
      throw err;
  }).pipe(fs.createWriteStream(filename));

  return new Promise(function(resolve, reject) {
    file.on('finish', function() {
      console.log('> downloaded ' + filename);
      resolve(filename);
    }).on('error', function(err) {
      reject(err);
    });
  });
}

function getImages(tweetData) {
  console.log('> loading images');

  var res = 600;
  var levels = 14;
  var start = 3;
  var seq = [];
  for (var step = 0; step < levels; step++) {
    seq.push(step);
  }
  var lat = tweetData.coords.lat,
    lng = tweetData.coords.lng;

  return Promise.all(seq.map(function(step) {
    var url = 'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/' + [lng, lat, step + start].join(',') +
      '/' + res + 'x' + res +
      '?access_token=' + process.env.MAPBOX_TOKEN;
    var filename = tweetData.dirName + '/img' + step + '.jpg';
    return loadImage(url, filename);
  })).then(function(results) {
    tweetData.images = results;
    return tweetData;
  });
}

function makeGif(tweetData) {
  console.log('> generating gif');
  return new Promise(function(resolve, reject) {
    var gm = new Gm();
    tweetData.gifFile = tweetData.dirName + '/animated.gif';
    tweetData.images.forEach(function(img) {
      gm.in(img);
    });
    gm
      .delay(30)
      .write(tweetData.gifFile, function(err) {
        if (err)
          reject(err);
        else
          resolve(tweetData);
      });
  });
}

function formatTweet(tweetData) {
  console.log('> writing tweet');
  tweetData.tweetText = tweetData.location + ': you are here.';
  wordfilter.removeWord('paki');
  if (wordfilter.blacklisted(tweetData.tweetText))
    throw Error('naughty word found');
  else
    return tweetData;
}

function postTweet(tweetData) {
  var mediaIdStr;
  return new Promise(function(resolve, reject) {
    fs.readFile(tweetData.gifFile, {
      encoding: 'base64'
    }, function(err, data) {
      if (err)
        reject(err);
      else {
        resolve(data);
      }
    });
  }).then(function(image) {
    console.log('> uploading media');
    return T.post('media/upload', {
      media_data: image
    });
  }).then(function(result) {
    mediaIdStr = result.data.media_id_string;
    var altText = "Zooming in on " + tweetData.location;
    var meta_params = {
      media_id: mediaIdStr,
      alt_text: {
        text: altText
      }
    };
    return T.post('media/metadata/create', meta_params);
  }).then(function() {
    console.log('> posting tweet');
    var params = {
      status: tweetData.tweetText,
      media_ids: [mediaIdStr]
    };
    return T.post('statuses/update', params);
  }).then(function(result) {
    tweetData.tweetDate = result.data.created_at;
    tweetData.tweetID = result.data.id_str;
    return tweetData;
  });
}

function deleteFolder(tweetData) {
  console.log('> cleaning up');
  return new Promise(function(resolve, reject) {
    fs.remove(tweetData.dirName, function(err) {
      if (err)
        reject(err);
      else
        resolve(tweetData);
    });
  });
}

function updateList(tweetData) {
  console.log('> updating tweetlist');
  tweetData.fileData.tweets.push({
    location: tweetData.location,
    date: tweetData.tweetDate,
    id: tweetData.tweetID
  });
  var json = JSON.stringify(tweetData.fileData);
  return new Promise(function(resolve, reject) {
    fs.writeFile(process.env.TWEET_LIST, json, 'utf8', function(err) {
      if (err)
        reject(err);
      else
        resolve(tweetData);
    });
  });
}

function handleError(err) {
  if (err.stack)
    console.log(err.stack);
  else
    console.log('Error: ' + err);
}

function runSerial(tasks) {
  var result = Promise.resolve();
  tasks.forEach(function(task) {
    result = result.then(task);
  });
  return result.then(console.log).catch(handleError);
}

setTimeout(function() {
  runSerial([queryTweets, getTweetText, extractWords, getEntityNames, removeNonPlaces, getList, filterList, getCoords,
    pickCoords, makeDir, getImages, makeGif, formatTweet, postTweet, deleteFolder, updateList
  ]);
}, 60000 * 60);
