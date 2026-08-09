jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn(),
  getBatteryStateAsync: jest.fn(),
  BatteryState: { CHARGING: 2, FULL: 3, UNPLUGGED: 1, UNKNOWN: 0 },
}));

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(),
  },
  Platform: { OS: 'android' },
  DeviceEventEmitter: {
    addListener: jest.fn(),
    emit: jest.fn(),
  },
}));

const Battery = require('expo-battery');
const { AppState, DeviceEventEmitter } = require('react-native');
import TaskSchedulerService from '../TaskSchedulerService';

// TaskSchedulerService registers these callbacks once, in its constructor
// (it's a singleton instantiated at import time).
const appStateListener = AppState.addEventListener.mock.calls[0][1];
const interactionListener = DeviceEventEmitter.addListener.mock.calls[0][1];

describe('TaskSchedulerService.isInteractive', () => {
  beforeEach(() => {
    appStateListener('active');
    TaskSchedulerService.lastInteractionTime = 0;
  });

  test('is false when the app is backgrounded, regardless of recent interaction', () => {
    interactionListener();
    appStateListener('background');
    expect(TaskSchedulerService.isInteractive()).toBe(false);
  });

  test('is true right after a user_interaction event while active', () => {
    interactionListener();
    expect(TaskSchedulerService.isInteractive()).toBe(true);
  });

  test('is false once INTERACTION_TIMEOUT has elapsed since the last interaction', () => {
    TaskSchedulerService.lastInteractionTime = Date.now() - (TaskSchedulerService.INTERACTION_TIMEOUT + 1);
    expect(TaskSchedulerService.isInteractive()).toBe(false);
  });

  test('is false when there has never been an interaction', () => {
    expect(TaskSchedulerService.isInteractive()).toBe(false);
  });
});

describe('TaskSchedulerService.waitUntilIdle', () => {
  beforeEach(() => {
    appStateListener('active');
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('resolves immediately when already idle', async () => {
    TaskSchedulerService.lastInteractionTime = 0;
    const spy = jest.fn();
    TaskSchedulerService.waitUntilIdle().then(spy);
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
  });

  test('polls once a second until interaction stops, then resolves', async () => {
    interactionListener(); // user touches the screen right now
    const spy = jest.fn();
    TaskSchedulerService.waitUntilIdle().then(spy);

    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();

    // Still within INTERACTION_TIMEOUT after one poll tick.
    await jest.advanceTimersByTimeAsync(1000);
    expect(spy).not.toHaveBeenCalled();

    // Push lastInteractionTime far enough into the past that the next poll sees "idle".
    TaskSchedulerService.lastInteractionTime = 0;
    await jest.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalled();
  });
});

describe('TaskSchedulerService.hasSufficientBattery', () => {
  test('is true when battery is above 20%, even unplugged', async () => {
    Battery.getBatteryLevelAsync.mockResolvedValue(0.5);
    Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.UNPLUGGED);
    await expect(TaskSchedulerService.hasSufficientBattery()).resolves.toBe(true);
  });

  test('is false when battery is at or below 20% and not charging', async () => {
    Battery.getBatteryLevelAsync.mockResolvedValue(0.2);
    Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.UNPLUGGED);
    await expect(TaskSchedulerService.hasSufficientBattery()).resolves.toBe(false);
  });

  test('is true when low on battery but charging', async () => {
    Battery.getBatteryLevelAsync.mockResolvedValue(0.05);
    Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.CHARGING);
    await expect(TaskSchedulerService.hasSufficientBattery()).resolves.toBe(true);
  });

  test('is true when full', async () => {
    Battery.getBatteryLevelAsync.mockResolvedValue(1);
    Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.FULL);
    await expect(TaskSchedulerService.hasSufficientBattery()).resolves.toBe(true);
  });

  test('assumes true (fails open) when the battery API throws', async () => {
    Battery.getBatteryLevelAsync.mockRejectedValue(new Error('no battery API on this device'));
    await expect(TaskSchedulerService.hasSufficientBattery()).resolves.toBe(true);
  });
});
