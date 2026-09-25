// No mDNS in integration tests: tests always give the server address explicitly.
module.exports = class Zeroconf {
  on() {}
  removeListener() {}
  removeDeviceListeners() {}
  scan() {}
  stop() {}
};
