// Puts fixture files into the fake camera roll (shims/expo-media-library.js)
// and returns them shaped like MediaLibrary.getAssetsAsync assets.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const MediaLibrary = require('expo-media-library');
const sandbox = require('../shims/sandbox');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
let nextId = 1;

function fixturePath(name) {
  return path.join(FIXTURES_DIR, name);
}

function addToCameraRoll(fixture, { creationTime, filename = fixture } = {}) {
  const id = String(nextId++);
  const dest = path.join(sandbox.dir('DCIM'), `${id}-${filename}`);
  fs.copyFileSync(fixturePath(fixture), dest);
  const time = creationTime ?? fs.statSync(dest).mtimeMs;
  const asset = {
    id,
    filename,
    uri: pathToFileURL(dest).href,
    mediaType: /\.(mp4|mov)$/i.test(filename) ? 'video' : 'photo',
    mediaSubtypes: [],
    width: 0,
    height: 0,
    duration: 0,
    creationTime: time,
    modificationTime: time,
    albumId: 'camera',
  };
  MediaLibrary.__assets.set(id, asset);
  return { ...asset };
}

module.exports = { addToCameraRoll, fixturePath };
