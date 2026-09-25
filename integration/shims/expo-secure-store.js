// In-memory SecureStore; each test file starts logged out with a fresh device id.
const store = new Map();

module.exports = {
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  WHEN_UNLOCKED: 'WHEN_UNLOCKED',
  getItemAsync: async (key) => (store.has(key) ? store.get(key) : null),
  setItemAsync: async (key, value) => {
    store.set(key, String(value));
  },
  deleteItemAsync: async (key) => {
    store.delete(key);
  },
  __store: store,
};
