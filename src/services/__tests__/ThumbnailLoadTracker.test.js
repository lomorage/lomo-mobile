import ThumbnailLoadTracker from '../ThumbnailLoadTracker';

describe('ThumbnailLoadTracker', () => {
  beforeEach(() => {
    ThumbnailLoadTracker.activeCount = 0;
  });

  test('isActive reflects whether any loads are in flight', () => {
    expect(ThumbnailLoadTracker.isActive()).toBe(false);
    ThumbnailLoadTracker.increment();
    expect(ThumbnailLoadTracker.isActive()).toBe(true);
    ThumbnailLoadTracker.decrement();
    expect(ThumbnailLoadTracker.isActive()).toBe(false);
  });

  test('decrement never goes below zero', () => {
    ThumbnailLoadTracker.decrement();
    expect(ThumbnailLoadTracker.activeCount).toBe(0);
  });

  test('tracks multiple concurrent loads', () => {
    ThumbnailLoadTracker.increment();
    ThumbnailLoadTracker.increment();
    ThumbnailLoadTracker.increment();
    expect(ThumbnailLoadTracker.activeCount).toBe(3);
    ThumbnailLoadTracker.decrement();
    expect(ThumbnailLoadTracker.isActive()).toBe(true);
    expect(ThumbnailLoadTracker.activeCount).toBe(2);
  });
});
