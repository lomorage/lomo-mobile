import React from 'react';
import renderer, { act } from 'react-test-renderer';

let mockBatteryListener;
jest.mock('expo-battery', () => ({
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 },
  getBatteryStateAsync: jest.fn(),
  addBatteryStateListener: jest.fn((listener) => {
    mockBatteryListener = listener;
    return { remove: jest.fn(() => { mockBatteryListener = undefined; }) };
  }),
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn().mockResolvedValue(undefined),
}));

const Battery = require('expo-battery');
const KeepAwake = require('expo-keep-awake');
const { default: useKeepScreenOnWhileCharging, KEEP_SCREEN_ON_TAG } = require('../useKeepScreenOnWhileCharging');

function Probe({ enabled }) {
  useKeepScreenOnWhileCharging(enabled);
  return null;
}

async function mount(enabled) {
  let root;
  await act(async () => {
    root = renderer.create(<Probe enabled={enabled} />);
  });
  return root;
}

async function plug(state) {
  await act(async () => {
    mockBatteryListener({ batteryState: state });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBatteryListener = undefined;
  Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.UNPLUGGED);
});

test('does nothing while the setting is off, and does not even watch the battery', async () => {
  Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.CHARGING);
  const root = await mount(false);

  expect(KeepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
  expect(Battery.addBatteryStateListener).not.toHaveBeenCalled();
  act(() => root.unmount());
});

test.each([['charging', 2], ['full', 3]])('keeps the screen on when the app opens already %s', async (_label, state) => {
  Battery.getBatteryStateAsync.mockResolvedValue(state);
  const root = await mount(true);

  expect(KeepAwake.activateKeepAwakeAsync).toHaveBeenCalledWith(KEEP_SCREEN_ON_TAG);
  act(() => root.unmount());
});

test('follows the charger: on when plugged in, off when unplugged', async () => {
  const root = await mount(true);
  expect(KeepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();

  await plug(Battery.BatteryState.CHARGING);
  expect(KeepAwake.activateKeepAwakeAsync).toHaveBeenCalledTimes(1);

  await plug(Battery.BatteryState.UNPLUGGED);
  expect(KeepAwake.deactivateKeepAwake).toHaveBeenCalledWith(KEEP_SCREEN_ON_TAG);
  act(() => root.unmount());
});

test('turning the setting off while charging lets the screen sleep and stops watching the battery', async () => {
  Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.CHARGING);
  const root = await mount(true);
  expect(KeepAwake.activateKeepAwakeAsync).toHaveBeenCalledTimes(1);

  await act(async () => {
    root.update(<Probe enabled={false} />);
  });

  expect(KeepAwake.deactivateKeepAwake).toHaveBeenCalledWith(KEEP_SCREEN_ON_TAG);
  expect(mockBatteryListener).toBeUndefined();
  act(() => root.unmount());
});

test('a first reading that arrives after an unplug event does not turn the screen back on', async () => {
  let resolveRead;
  Battery.getBatteryStateAsync.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
  const root = await mount(true);

  await plug(Battery.BatteryState.UNPLUGGED);
  await act(async () => {
    resolveRead(Battery.BatteryState.CHARGING);
  });

  expect(KeepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
  act(() => root.unmount());
});

test('the battery is watched before the first reading is taken', async () => {
  const root = await mount(true);

  expect(Battery.addBatteryStateListener.mock.invocationCallOrder[0])
    .toBeLessThan(Battery.getBatteryStateAsync.mock.invocationCallOrder[0]);
  act(() => root.unmount());
});

test('a battery reading that fails leaves the screen to sleep normally', async () => {
  Battery.getBatteryStateAsync.mockRejectedValue(new Error('no battery service'));
  const root = await mount(true);

  expect(KeepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
  act(() => root.unmount());
});

test('uses its own tag, so it never releases the first-backup keep-awake', async () => {
  Battery.getBatteryStateAsync.mockResolvedValue(Battery.BatteryState.CHARGING);
  const root = await mount(true);
  act(() => root.unmount());

  for (const [tag] of KeepAwake.deactivateKeepAwake.mock.calls) {
    expect(tag).toBe(KEEP_SCREEN_ON_TAG);
  }
  expect(KEEP_SCREEN_ON_TAG).not.toBe('lomorage-first-backup');
});
