let ImageLoadQueue;

// The module is a singleton with internal mutable state (active count +
// queue), so each test needs a fresh instance rather than sharing state
// leaked from a previous test.
beforeEach(() => {
    jest.resetModules();
    ImageLoadQueue = require('../ImageLoadQueue').default;
});

function resolvedFlags(promises) {
    const flags = promises.map(() => false);
    promises.forEach((p, i) => p.then(() => { flags[i] = true; }));
    return flags;
}

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('ImageLoadQueue', () => {
    test('grants a slot immediately while under the concurrency limit', async () => {
        const flags = resolvedFlags([ImageLoadQueue.schedule('a'), ImageLoadQueue.schedule('b')]);
        await flush();
        expect(flags).toEqual([true, true]);
    });

    test('queues requests beyond the concurrency limit until a slot is released', async () => {
        const promises = ['a', 'b', 'c', 'd', 'e'].map((id) => ImageLoadQueue.schedule(id));
        const flags = resolvedFlags(promises);
        await flush();
        // Exactly 4 (MAX_CONCURRENT) granted immediately, the 5th queued.
        expect(flags).toEqual([true, true, true, true, false]);

        ImageLoadQueue.release();
        await flush();
        expect(flags[4]).toBe(true);
    });

    test('releases hand slots to the most-recently-queued waiter first (LIFO)', async () => {
        // Most-recently-queued approximates "closest to what's currently on
        // screen" during a scroll far better than arrival order does -- see
        // the rationale comment on ImageLoadQueue.release().
        for (let i = 0; i < 4; i++) ImageLoadQueue.schedule(`filler-${i}`);
        const order = [];
        const p1 = ImageLoadQueue.schedule('first').then(() => order.push('first'));
        const p2 = ImageLoadQueue.schedule('second').then(() => order.push('second'));
        await flush();

        ImageLoadQueue.release();
        await flush();
        ImageLoadQueue.release();
        await flush();

        await Promise.all([p1, p2]);
        expect(order).toEqual(['second', 'first']);
    });

    test('cancel drops a still-queued request so it never resolves and never consumes a slot', async () => {
        for (let i = 0; i < 4; i++) ImageLoadQueue.schedule(`filler-${i}`);
        const queuedPromise = ImageLoadQueue.schedule('to-cancel');
        const flag = resolvedFlags([queuedPromise])[0];
        await flush();
        expect(flag).toBe(false);

        ImageLoadQueue.cancel('to-cancel');
        // Freeing a slot now should go to nobody -- the cancelled request
        // must not have silently stayed in the queue.
        ImageLoadQueue.release();
        await flush();
        expect(flag).toBe(false);
    });

    test('cancel on an already-granted id is a no-op (does not free an extra slot)', async () => {
        const flags = resolvedFlags([
            ImageLoadQueue.schedule('a'), ImageLoadQueue.schedule('b'),
            ImageLoadQueue.schedule('c'), ImageLoadQueue.schedule('d'),
        ]);
        await flush();
        expect(flags).toEqual([true, true, true, true]);

        ImageLoadQueue.cancel('a'); // already running, not in the queue anymore
        const fifthFlag = resolvedFlags([ImageLoadQueue.schedule('e')])[0];
        await flush();
        expect(fifthFlag).toBe(false); // still no free slot -- cancel() didn't fabricate one
    });
});
