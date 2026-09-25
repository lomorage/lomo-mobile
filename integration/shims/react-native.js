// Just enough of react-native for the service layer to run under plain Node.
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const DeviceEventEmitter = {
  addListener(event, listener) {
    emitter.on(event, listener);
    return { remove: () => emitter.off(event, listener) };
  },
  emit: (event, ...args) => emitter.emit(event, ...args),
  removeAllListeners: (event) => emitter.removeAllListeners(event),
  listenerCount: (event) => emitter.listenerCount(event),
};

const Platform = {
  OS: process.env.LOMO_IT_PLATFORM || 'android',
  Version: 34,
  select: (spec) => (Platform.OS in spec ? spec[Platform.OS] : spec.default),
};

const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove() {} }),
};

// A real Alert blocks until the user taps a button, and AuthService's
// network-error interceptor only settles its promise from a button handler.
// Press the cancel button (or the first one) right away so a dead server fails
// the test instead of hanging it. Tests can inspect `Alert.shown`.
const Alert = {
  shown: [],
  alert(title, message, buttons = []) {
    Alert.shown.push({ title, message });
    const button = buttons.find((b) => b.style === 'cancel') || buttons[0];
    if (button && button.onPress) setImmediate(() => button.onPress());
  },
};

const PermissionsAndroid = {
  PERMISSIONS: {},
  RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
  check: async () => true,
  request: async () => 'granted',
  requestMultiple: async (perms) => Object.fromEntries(perms.map((p) => [p, 'granted'])),
};

module.exports = {
  Alert,
  AppState,
  DeviceEventEmitter,
  Image: { getSize: (uri, ok) => ok(0, 0), prefetch: async () => true },
  NativeModules: {},
  PermissionsAndroid,
  PixelRatio: { get: () => 1 },
  Platform,
};
