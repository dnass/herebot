const glang = require('@google-cloud/language');
const gmaps = require('@google/maps');
const request = require('request');
const fsp = require('fs-promise');
const wordfilter = require('wordfilter');
const Gm = require('gm');
const _ = require('lodash');
const Tbb = require('twitter-bot-bot');

const dataPath = `${__dirname}/data.json`;

const bot = new Tbb(run);

function getTweets() {
  bot.log('getting tweets');
  return bot.get('search/tweets', {
    q: 'a',
    count: 25,
    result_type: 'recent',
    lang: 'en'
  }).then(result => {
    bot.log(`retrieved ${result.data.statuses.length} tweets`);
    bot.log('getting tweet text');
    const tweetData = {
      tweetTexts: result.data.statuses.map(status => status.text)
    }
    bot.log('extracting words from tweets');
    const excludePatterns = [/https?:\/\/[-a-zA-Z0-9@:%_\+.~#?&\/=]+/g, /@[a-z0-9_-]+/g, /[^a-zA-Z]+/g, /\bRT\b/gi];
    excludePatterns.forEach(pat => {
      tweetData.text = tweetData.tweetTexts.join(' ').replace(pat, ' ');
    });
    return tweetData;
  })
}

function getEntities(tweetData) {
  bot.log('getting entity names');
  return glang({
    projectId: bot.params.LANGUAGE_PROJECT_ID,
    keyFilename: `${__dirname}/${bot.params.GOOGLE_APPLICATION_CREDENTIALS}`
  }).detectEntities(tweetData.text)
    .then(results => {
      tweetData.entities = results[0];
      bot.log('filtering out non-places');
      tweetData.locationList = _.reject(tweetData.entities, item => item.type !== 'LOCATION' || item.name.length < 3)
        .map(item => item.name);
      if (tweetData.locationList.length) {
        bot.log(`${tweetData.locationList.length} locations found`);
        return tweetData;
      } else
        throw Error('no locations found.');
    });
}

function filterList(tweetData) {
  bot.log('reading data')
  return fsp.readFile(dataPath, 'utf8')
    .then(fileData => {
      tweetData.fileData = JSON.parse(fileData);
      bot.log('filtering list');
      const excludeList = ["anywhere", "nowhere", "here", "there", "country", "city", "town", "state"];
      const fullList = tweetData.fileData.locations.map(location => location.toLowerCase())
        .concat(excludeList);
      tweetData.locationList = _.reject(tweetData.locationList, item => fullList.indexOf(item.toLowerCase()) > -1);
      if (tweetData.locationList.length) {
        bot.log(`${tweetData.locationList.length} locations remain`);
        return tweetData;
      } else
        throw Error('all locations rejected.');
    })
}

function checkGeocode(address) {
  bot.log(`checking geocode for ${address}`);
  return gmaps.createClient({
    Promise: Promise,
    key: bot.params.MAPS_API_KEY
  }).geocode({ address }).asPromise();
}

function getCoords(tweetData) {
  bot.log('checking coordinates');
  return Promise.all(tweetData.locationList.map(location => checkGeocode(location)))
    .then(results => {
      bot.log('picking coordinates');
      for (let i = 0; i < results.length; i++) {
        const location = results[i].json.results[0];
        if (location) {
          tweetData.coords = location.geometry.location;
          tweetData.location = tweetData.locationList[i];
          bot.log(`picked ${tweetData.location}`);
          return tweetData;
        }
      }
      throw Error('no coordinates found');
    })
}

function makeDir(tweetData) {
  bot.log('making directory');
  tweetData.dirName = `${__dirname}/${tweetData.location.replace(' ', '')}`;
  return fsp.mkdir(tweetData.dirName)
    .then(() => {
      return tweetData
    });
}

function loadImage(url, filename) {
  const file = request.get(url)
    .pipe(fsp.createWriteStream(filename));

  return new Promise(function(resolve, reject) {
    file.on('finish', () => {
      bot.log('downloaded ' + filename);
      resolve(filename);
    }).on('error', (err) => reject(err));
  });
}

function getImages(tweetData) {
  bot.log('loading images');
  const lat = tweetData.coords.lat,
    lng = tweetData.coords.lng;

  return Promise.all(_.range(3, 17).map(step => {
    const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${lng},${lat},${step}/600x600?access_token=${bot.params.MAPBOX_TOKEN}`;
    const filename = `${tweetData.dirName}/img${step}.jpg`;
    return loadImage(url, filename);
  })).then(images => {
    tweetData.images = images;
    return tweetData;
  });
}

function writeTweet(tweetData) {
  bot.log('writing tweet');
  tweetData.tweetText = `${tweetData.location}: you are here.`;
  wordfilter.removeWord('paki');
  if (wordfilter.blacklisted(tweetData.tweetText))
    throw Error('blacklisted word found');

  bot.log('generating gif');
  const gm = new Gm();
  tweetData.gifFile = `${tweetData.dirName}/animated.gif`;
  tweetData.images.forEach(image => gm.in(image));
  return new Promise((resolve, reject) => {
    gm.delay(30)
      .write(tweetData.gifFile, err => {
        if (err) reject(err);
        resolve(tweetData);
      })
  }).then(tweetData => {
    return fsp.readFile(tweetData.gifFile, { encoding: 'base64' })
      .then(image => {
        return bot.tweet({
          media: image,
          status: tweetData.tweetText,
          altText: tweetData.tweetText
        })
      }).then(result => {
        tweetData.tweetOutput = result;
        return tweetData;
      })
  })
}

function cleanup(tweetData) {
  bot.log('cleaning up');
  return fsp.remove(tweetData.dirName)
    .then(() => {
      bot.log('writing data');
      tweetData.fileData.locations.push(tweetData.location);
      return fsp.writeFile(dataPath, JSON.stringify(tweetData.fileData), 'utf8');
    })
}

function run() {
  return getTweets().then(getEntities).then(filterList).then(getCoords).then(makeDir).then(getImages).then(writeTweet).then(cleanup);
};
