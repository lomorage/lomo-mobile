import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useThrottledImageUri } from '../useThrottledImageUri';

jest.mock('../../services/ImageLoadQueue', () => ({
    schedule: jest.fn(),
    cancel: jest.fn(),
    release: jest.fn(),
}));
const ImageLoadQueue = require('../../services/ImageLoadQueue');

async function flush() {
    await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    });
}

function TestComponent({ uri, onRender }) {
    const [readyUri, onLoadSettled] = useThrottledImageUri(uri);
    onRender(readyUri, onLoadSettled);
    return null;
}

describe('useThrottledImageUri', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders nothing until the queue grants a slot, then renders the uri', async () => {
        let grant;
        ImageLoadQueue.schedule.mockReturnValue(new Promise((resolve) => { grant = resolve; }));

        const renders = [];
        let component;
        await act(async () => {
            component = renderer.create(
                <TestComponent uri="http://server/photo.jpg" onRender={(u) => renders.push(u)} />
            );
        });
        expect(renders[renders.length - 1]).toBeNull();

        await act(async () => { grant(); });
        await flush();
        expect(renders[renders.length - 1]).toBe('http://server/photo.jpg');
    });

    test('does not call schedule when there is no uri yet', async () => {
        await act(async () => {
            renderer.create(<TestComponent uri={null} onRender={() => {}} />);
        });
        expect(ImageLoadQueue.schedule).not.toHaveBeenCalled();
    });

    test('calling onLoadSettled after a slot was granted releases it exactly once', async () => {
        ImageLoadQueue.schedule.mockResolvedValue();

        let latestSettle;
        await act(async () => {
            renderer.create(<TestComponent uri="http://server/photo.jpg" onRender={(u, settle) => { latestSettle = settle; }} />);
        });
        await flush();

        act(() => { latestSettle(); });
        expect(ImageLoadQueue.release).toHaveBeenCalledTimes(1);

        // Calling it again (e.g. a duplicate onError after onLoad) must not
        // free a slot that was already handed back.
        act(() => { latestSettle(); });
        expect(ImageLoadQueue.release).toHaveBeenCalledTimes(1);
    });

    test('unmounting while still queued cancels the request instead of releasing a slot', async () => {
        ImageLoadQueue.schedule.mockReturnValue(new Promise(() => {})); // never resolves -- still waiting

        let component;
        await act(async () => {
            component = renderer.create(<TestComponent uri="http://server/photo.jpg" onRender={() => {}} />);
        });

        act(() => { component.unmount(); });

        expect(ImageLoadQueue.cancel).toHaveBeenCalledTimes(1);
        expect(ImageLoadQueue.release).not.toHaveBeenCalled();
    });

    test('unmounting after a slot was granted releases it instead of cancelling', async () => {
        ImageLoadQueue.schedule.mockResolvedValue();

        let component;
        await act(async () => {
            component = renderer.create(<TestComponent uri="http://server/photo.jpg" onRender={() => {}} />);
        });
        await flush();

        act(() => { component.unmount(); });

        expect(ImageLoadQueue.release).toHaveBeenCalledTimes(1);
        expect(ImageLoadQueue.cancel).not.toHaveBeenCalled();
    });

    test('switching to a different uri before the old one is granted cancels the stale request', async () => {
        let resolveFirst;
        ImageLoadQueue.schedule.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
        ImageLoadQueue.schedule.mockResolvedValueOnce(); // second uri's request

        let component;
        const renders = [];
        await act(async () => {
            component = renderer.create(<TestComponent uri="http://server/a.jpg" onRender={(u) => renders.push(u)} />);
        });

        await act(async () => {
            component.update(<TestComponent uri="http://server/b.jpg" onRender={(u) => renders.push(u)} />);
        });
        await flush();

        // The first request was still waiting when we switched away from it.
        expect(ImageLoadQueue.cancel).toHaveBeenCalledTimes(1);
        expect(renders[renders.length - 1]).toBe('http://server/b.jpg');

        // If the stale first request somehow still resolves later (race with
        // the queue), it must hand its slot straight back, not render a.jpg.
        await act(async () => { resolveFirst(); });
        await flush();
        expect(ImageLoadQueue.release).toHaveBeenCalledTimes(1);
        expect(renders[renders.length - 1]).toBe('http://server/b.jpg');
    });

    // Regression test: a recycled FlashList tile whose slot for photo A was
    // already granted (A is on screen) must not keep rendering A's uri once
    // it's recycled to show photo B, even for the single render before B's
    // own queue request resolves -- otherwise the tile flashes A's photo in
    // a cell that's now supposed to be B, self-correcting only once B's
    // request eventually gets its turn. This is exactly what a user sees as
    // "shows the previous photo, then it gets replaced after a bit."
    test('recycling to a new uri never renders the previous (already-granted) uri, even for one frame', async () => {
        ImageLoadQueue.schedule.mockResolvedValueOnce(); // a.jpg grants immediately
        let resolveSecond;
        ImageLoadQueue.schedule.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

        let component;
        const renders = [];
        await act(async () => {
            component = renderer.create(<TestComponent uri="http://server/a.jpg" onRender={(u) => renders.push(u)} />);
        });
        await flush();
        expect(renders[renders.length - 1]).toBe('http://server/a.jpg');

        // b.jpg's schedule() call is still pending (queue is full) -- the
        // render that happens synchronously off this prop change must not
        // show a.jpg's uri.
        act(() => {
            component.update(<TestComponent uri="http://server/b.jpg" onRender={(u) => renders.push(u)} />);
        });
        expect(renders[renders.length - 1]).toBeNull();
        // The slot a.jpg was holding must be handed back, not leaked.
        expect(ImageLoadQueue.release).toHaveBeenCalledTimes(1);

        await act(async () => { resolveSecond(); });
        await flush();
        expect(renders[renders.length - 1]).toBe('http://server/b.jpg');
    });
});
