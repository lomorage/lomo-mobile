import ImageLoadGate from '../ImageLoadGate';

describe('ImageLoadGate', () => {
  beforeEach(() => {
    ImageLoadGate.activeCount = 0;
    ImageLoadGate.queue = [];
  });

  test('grants immediately up to the concurrency cap', async () => {
    const t1 = await ImageLoadGate.acquire();
    const t2 = await ImageLoadGate.acquire();
    const t3 = await ImageLoadGate.acquire();
    expect(ImageLoadGate.activeCount).toBe(3);
    expect(t1.granted && t2.granted && t3.granted).toBe(true);
  });

  test('a 4th request queues instead of exceeding the cap', async () => {
    await ImageLoadGate.acquire();
    await ImageLoadGate.acquire();
    await ImageLoadGate.acquire();

    let fourthGranted = false;
    ImageLoadGate.acquire().then(() => { fourthGranted = true; });

    await Promise.resolve();
    expect(fourthGranted).toBe(false);
    expect(ImageLoadGate.queue.length).toBe(1);
  });

  test('releasing a slot grants the next queued waiter', async () => {
    const t1 = await ImageLoadGate.acquire();
    await ImageLoadGate.acquire();
    await ImageLoadGate.acquire();

    const fourth = ImageLoadGate.acquire();
    ImageLoadGate.release(t1);
    const t4 = await fourth;

    expect(t4.granted).toBe(true);
    expect(ImageLoadGate.activeCount).toBe(3);
  });

  test('cancelling a still-queued request removes it without freeing a slot', async () => {
    await ImageLoadGate.acquire();
    await ImageLoadGate.acquire();
    await ImageLoadGate.acquire();

    let queuedToken = null;
    ImageLoadGate.acquire().then(token => { queuedToken = token; });
    await Promise.resolve();
    expect(ImageLoadGate.queue.length).toBe(1);

    ImageLoadGate.cancel(ImageLoadGate.queue[0]);
    expect(ImageLoadGate.queue.length).toBe(0);
    expect(ImageLoadGate.activeCount).toBe(3);
    expect(queuedToken).toBeNull();
  });

  test('cancelling an already-granted token frees its slot', async () => {
    const t1 = await ImageLoadGate.acquire();
    expect(ImageLoadGate.activeCount).toBe(1);
    ImageLoadGate.cancel(t1);
    expect(ImageLoadGate.activeCount).toBe(0);
  });

  test('release is a no-op on an already-released token', async () => {
    const t1 = await ImageLoadGate.acquire();
    ImageLoadGate.release(t1);
    expect(ImageLoadGate.activeCount).toBe(0);
    ImageLoadGate.release(t1);
    expect(ImageLoadGate.activeCount).toBe(0);
  });
});
