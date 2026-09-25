const state = { type: 'wifi', isConnected: true, isInternetReachable: true };

module.exports = {
  addEventListener: () => () => {},
  fetch: async () => state,
  refresh: async () => state,
};
