import NetworkQueue from '../NetworkQueue';

// The module exports a singleton; reset its internal state between tests
// rather than re-importing (jest module registry would keep it fresh per
// test file anyway, but tests within this file share the same instance).
function resetQueue() {
  NetworkQueue.queue = [];
  NetworkQueue.activeCount = 0;
  NetworkQueue.controllers = new Map();
  NetworkQueue.MAX_CONCURRENT = 4;
}

function enqueueSpy(config) {
  const resolve = jest.fn();
  const reject = jest.fn();
  NetworkQueue.enqueue(config, resolve, reject);
  return { resolve, reject };
}

beforeEach(() => {
  resetQueue();
});

describe('enqueue / dispatch ordering', () => {
  test('dispatches immediately (resolve called synchronously) while under MAX_CONCURRENT', () => {
    const { resolve } = enqueueSpy({ priority: 2 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(NetworkQueue.activeCount).toBe(1);
  });

  test('queues extra requests once MAX_CONCURRENT in-flight requests are active', () => {
    NetworkQueue.MAX_CONCURRENT = 2;
    const a = enqueueSpy({ priority: 2 });
    const b = enqueueSpy({ priority: 2 });
    const c = enqueueSpy({ priority: 2 });

    expect(a.resolve).toHaveBeenCalledTimes(1);
    expect(b.resolve).toHaveBeenCalledTimes(1);
    expect(c.resolve).not.toHaveBeenCalled();
    expect(NetworkQueue.queue).toHaveLength(1);
  });

  test('a higher-priority (lower number) request cuts ahead of queued lower-priority ones', () => {
    NetworkQueue.MAX_CONCURRENT = 1;
    enqueueSpy({ priority: 2 }); // dispatched immediately, occupies the one slot
    const low = enqueueSpy({ priority: 3 });
    const high = enqueueSpy({ priority: 1 });

    // Both are queued (slot full); high priority should sit ahead of low priority.
    expect(NetworkQueue.queue.map(i => i.config.priority)).toEqual([1, 3]);
    expect(low.resolve).not.toHaveBeenCalled();
    expect(high.resolve).not.toHaveBeenCalled();
  });

  test('same-priority requests preserve FIFO order (stable insert)', () => {
    NetworkQueue.MAX_CONCURRENT = 1;
    enqueueSpy({ priority: 2, url: 'occupies-slot' });
    enqueueSpy({ priority: 2, url: 'first' });
    enqueueSpy({ priority: 2, url: 'second' });

    expect(NetworkQueue.queue.map(i => i.config.url)).toEqual(['first', 'second']);
  });

  test('defaults to NORMAL priority (2) when none is specified', () => {
    NetworkQueue.MAX_CONCURRENT = 1;
    enqueueSpy({}); // occupies the slot
    enqueueSpy({ priority: 3 });
    enqueueSpy({}); // no priority -> defaults to 2, should sit ahead of the priority-3 one

    expect(NetworkQueue.queue.map(i => i.priority)).toEqual([2, 3]);
  });
});

describe('onResponse / queue draining', () => {
  test('onResponse frees a slot and dispatches the next queued item', () => {
    NetworkQueue.MAX_CONCURRENT = 1;
    enqueueSpy({ priority: 2 });
    const next = enqueueSpy({ priority: 2 });
    expect(next.resolve).not.toHaveBeenCalled();

    NetworkQueue.onResponse();

    expect(next.resolve).toHaveBeenCalledTimes(1);
    expect(NetworkQueue.activeCount).toBe(1);
  });

  test('activeCount never goes negative from extra onResponse calls', () => {
    NetworkQueue.onResponse();
    NetworkQueue.onResponse();
    expect(NetworkQueue.activeCount).toBe(0);
  });

  test('an item whose signal was aborted while queued is rejected instead of dispatched', () => {
    NetworkQueue.MAX_CONCURRENT = 1;
    enqueueSpy({ priority: 2 }); // occupies the slot
    const controller = new AbortController();
    const queued = enqueueSpy({ priority: 2, signal: controller.signal });
    controller.abort();

    NetworkQueue.onResponse(); // frees the slot, tries to dispatch `queued`

    expect(queued.resolve).not.toHaveBeenCalled();
    expect(queued.reject).toHaveBeenCalledTimes(1);
    // The freed slot wasn't consumed by the aborted item, so activeCount stays at 0.
    expect(NetworkQueue.activeCount).toBe(0);
  });
});

describe('cancelGroup', () => {
  test('aborts the in-flight AbortController for that group', () => {
    const config = { priority: 2, groupId: 'g1' };
    NetworkQueue.enqueue(config, jest.fn(), jest.fn());
    const controller = NetworkQueue.controllers.get('g1');
    expect(controller.signal.aborted).toBe(false);

    NetworkQueue.cancelGroup('g1');

    expect(controller.signal.aborted).toBe(true);
    expect(NetworkQueue.controllers.has('g1')).toBe(false);
  });

  test('removes and rejects pending (not yet dispatched) items in that group', () => {
    NetworkQueue.MAX_CONCURRENT = 0; // nothing dispatches; everything stays queued
    const { reject } = enqueueSpy({ priority: 2, groupId: 'g1' });
    const other = enqueueSpy({ priority: 2, groupId: 'g2' });

    NetworkQueue.cancelGroup('g1');

    expect(reject).toHaveBeenCalledTimes(1);
    expect(NetworkQueue.queue).toHaveLength(1);
    expect(NetworkQueue.queue[0].groupId).toBe('g2');
    expect(other.reject).not.toHaveBeenCalled();
  });

  test('is a no-op for a falsy groupId', () => {
    expect(() => NetworkQueue.cancelGroup(null)).not.toThrow();
    expect(() => NetworkQueue.cancelGroup(undefined)).not.toThrow();
  });
});

describe('setupInterceptors', () => {
  function makeFakeAxiosInstance() {
    const requestHandlers = [];
    const responseHandlers = [];
    return {
      interceptors: {
        request: { use: (onFulfilled, onRejected) => requestHandlers.push({ onFulfilled, onRejected }) },
        response: { use: (onFulfilled, onRejected) => responseHandlers.push({ onFulfilled, onRejected }) },
      },
      _requestHandlers: requestHandlers,
      _responseHandlers: responseHandlers,
    };
  }

  test('bypasses the queue for /login and /mount URLs, and skipQueue configs', async () => {
    const instance = makeFakeAxiosInstance();
    NetworkQueue.setupInterceptors(instance);
    const { onFulfilled } = instance._requestHandlers[0];

    const loginConfig = { url: '/login', priority: 2 };
    const result = await onFulfilled(loginConfig);
    expect(result).toBe(loginConfig); // returned as-is, not queued
    expect(NetworkQueue.queue).toHaveLength(0);

    const skipConfig = { url: '/anything', skipQueue: true };
    const result2 = await onFulfilled(skipConfig);
    expect(result2).toBe(skipConfig);
  });

  test('routes other requests through the queue', () => {
    NetworkQueue.MAX_CONCURRENT = 0;
    const instance = makeFakeAxiosInstance();
    NetworkQueue.setupInterceptors(instance);
    const { onFulfilled } = instance._requestHandlers[0];

    onFulfilled({ url: '/album', priority: 2 });

    expect(NetworkQueue.queue).toHaveLength(1);
  });

  test('response interceptor frees a slot on both success and error', () => {
    const instance = makeFakeAxiosInstance();
    NetworkQueue.setupInterceptors(instance);
    NetworkQueue.activeCount = 2;

    instance._responseHandlers[0].onFulfilled({ data: 'ok' });
    expect(NetworkQueue.activeCount).toBe(1);

    instance._responseHandlers[0].onRejected(new Error('boom')).catch(() => {});
    expect(NetworkQueue.activeCount).toBe(0);
  });
});
