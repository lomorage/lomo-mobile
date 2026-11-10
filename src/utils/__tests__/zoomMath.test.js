import { clampPan, doubleTapTarget, fittedSize, maxPan } from '../zoomMath';

// The photo area of the detail screen: full width, 70% of a 914dp screen.
const W = 411;
const H = 640;

describe('zoomMath', () => {
    it('fits a picture inside the view by its aspect ratio', () => {
        expect(fittedSize(W, H, 4 / 3)).toEqual({ width: W, height: W * 3 / 4 });
        const tall = fittedSize(W, H, 1 / 4);
        expect(tall.height).toBe(H);
        expect(tall.width).toBeCloseTo(H / 4);
        expect(fittedSize(W, H, undefined)).toEqual({ width: W, height: H });
    });

    it('allows panning only as far as the zoomed picture overflows the view', () => {
        expect(maxPan(W, W, 2.5)).toBeCloseTo(W * 0.75);
        // A landscape picture 308dp tall zoomed 2.5x is 770dp: 65dp of overflow each side.
        expect(maxPan(308, H, 2.5)).toBeCloseTo(65);
        // Still smaller than the view after zooming: stays centered.
        expect(maxPan(200, H, 2)).toBe(0);
        expect(clampPan(10000, W, W, 2)).toBe(W / 2);
        expect(clampPan(-10000, W, W, 2)).toBe(-W / 2);
        expect(clampPan(30, W, W, 2)).toBe(30);
    });

    it('does not move the picture when its center is double-tapped', () => {
        expect(doubleTapTarget(W / 2, H / 2, W, H, 4 / 3, 2.5)).toEqual({ x: 0, y: 0 });
    });

    it('moves a tapped point toward the center using the photo area, not the screen', () => {
        // Square-ish tall picture: tap 20dp below center; picture moves up 30dp.
        const t = doubleTapTarget(W / 2, H / 2 + 20, W, H, 1 / 4, 2.5);
        expect(t.y).toBeCloseTo(-30);
    });

    it('never shows an empty edge: a corner tap on a landscape picture stays within its overflow', () => {
        const t = doubleTapTarget(0, 0, W, H, 4 / 3, 2.5);
        expect(t.x).toBeCloseTo(maxPan(W, W, 2.5));
        expect(t.y).toBeCloseTo(maxPan(W * 3 / 4, H, 2.5));
        expect(t.y).toBeLessThan(maxPan(H, H, 2.5));
    });
});
