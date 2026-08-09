function makeFakeZeroconf() {
  const listeners = {};
  return {
    on: jest.fn((event, cb) => { listeners[event] = cb; }),
    removeListener: jest.fn((event) => { delete listeners[event]; }),
    scan: jest.fn(),
    stop: jest.fn(),
    _emit: (event, arg) => listeners[event]?.(arg),
  };
}

jest.mock('react-native-zeroconf', () => {
  return jest.fn().mockImplementation(() => global.__fakeZeroconf);
});

import DiscoveryService from '../DiscoveryService';

beforeEach(() => {
  jest.useFakeTimers();
  global.__fakeZeroconf = makeFakeZeroconf();
  // Force a fresh Zeroconf instance per test (DiscoveryService lazily caches it).
  DiscoveryService._zeroconf = null;
  DiscoveryService.isScanning = false;
  DiscoveryService._scanPromise = null;
  DiscoveryService.onDiscoveredCallbacks = new Set();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('DiscoveryService.scan', () => {
  test('resolves with discovered services once the timeout elapses', async () => {
    const promise = DiscoveryService.scan(5000);
    global.__fakeZeroconf._emit('resolved', {
      name: 'nas1', host: 'nas1.local', port: 8000, addresses: ['192.168.1.50'],
    });

    await jest.advanceTimersByTimeAsync(5000);
    const results = await promise;

    expect(results).toEqual([
      { name: 'nas1', address: '192.168.1.50:8000', host: 'nas1.local', port: 8000, fullUrl: 'http://192.168.1.50:8000' },
    ]);
  });

  test('prefers the resolved IP address over the mDNS hostname', async () => {
    const promise = DiscoveryService.scan(1000);
    global.__fakeZeroconf._emit('resolved', {
      name: 'nas1', host: 'nas1.local', port: 8000, addresses: [],
    });
    await jest.advanceTimersByTimeAsync(1000);
    const results = await promise;
    expect(results[0].fullUrl).toBe('http://nas1.local:8000');
  });

  test('ignores a resolved event missing host/port', async () => {
    const promise = DiscoveryService.scan(1000);
    global.__fakeZeroconf._emit('resolved', { name: 'incomplete' });
    await jest.advanceTimersByTimeAsync(1000);
    expect(await promise).toEqual([]);
  });

  test('dedupes a service that fires "resolved" twice', async () => {
    const promise = DiscoveryService.scan(1000);
    const service = { name: 'nas1', host: 'nas1.local', port: 8000, addresses: ['192.168.1.50'] };
    global.__fakeZeroconf._emit('resolved', service);
    global.__fakeZeroconf._emit('resolved', service);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await promise).toHaveLength(1);
  });

  test('a concurrent scan() call reuses the in-flight promise instead of starting a second scan', () => {
    const p1 = DiscoveryService.scan(5000);
    const p2 = DiscoveryService.scan(5000);
    expect(p1).toBe(p2);
    expect(global.__fakeZeroconf.scan).toHaveBeenCalledTimes(1);
  });

  test('resolves immediately (with whatever was found so far) on a zeroconf error', async () => {
    const promise = DiscoveryService.scan(5000);
    global.__fakeZeroconf._emit('resolved', {
      name: 'nas1', host: 'nas1.local', port: 8000, addresses: ['192.168.1.50'],
    });
    global.__fakeZeroconf._emit('error', new Error('mdns unavailable'));

    const results = await promise;
    expect(results).toHaveLength(1);
    expect(DiscoveryService.isScanning).toBe(false);
    expect(global.__fakeZeroconf.stop).toHaveBeenCalled();
  });

  test('resolves with an empty array if zeroconf.scan() throws synchronously', async () => {
    global.__fakeZeroconf.scan.mockImplementation(() => { throw new Error('permission denied'); });
    const results = await DiscoveryService.scan(5000);
    expect(results).toEqual([]);
    expect(DiscoveryService.isScanning).toBe(false);
  });

  test('a fresh scan() after completion starts a new scan (not reusing the finished promise)', async () => {
    const p1 = DiscoveryService.scan(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await p1;

    DiscoveryService.scan(1000);
    expect(global.__fakeZeroconf.scan).toHaveBeenCalledTimes(2);
  });
});

describe('DiscoveryService.onDiscovered', () => {
  test('invokes the callback for each newly resolved service during a scan', () => {
    const cb = jest.fn();
    DiscoveryService.onDiscovered(cb);
    DiscoveryService.scan(5000);
    global.__fakeZeroconf._emit('resolved', {
      name: 'nas1', host: 'nas1.local', port: 8000, addresses: ['192.168.1.50'],
    });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ name: 'nas1' }));
  });

  test('the returned unsubscribe function stops future callbacks', () => {
    const cb = jest.fn();
    const unsubscribe = DiscoveryService.onDiscovered(cb);
    unsubscribe();
    DiscoveryService.scan(5000);
    global.__fakeZeroconf._emit('resolved', {
      name: 'nas1', host: 'nas1.local', port: 8000, addresses: ['192.168.1.50'],
    });
    expect(cb).not.toHaveBeenCalled();
  });
});
