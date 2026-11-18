jest.mock('@react-native-firebase/crashlytics', () => {
  const instance = { tag: 'crashlytics' };
  return {
    getCrashlytics: jest.fn(() => instance),
    log: jest.fn(),
    recordError: jest.fn(),
  };
});

const crashlytics = require('@react-native-firebase/crashlytics');
const { reportNonFatal, safeFields, _resetCrashReportingForTests } = require('../crashReporting');

describe('safeFields', () => {
  test('keeps finite numbers, booleans and identifier-like strings', () => {
    expect(safeFields({ width: 20, scale: 0.5, ok: true, source: 'local', code: 'ERR_FUNCTION_CALL' }))
      .toEqual({ width: 20, scale: 0.5, ok: true, source: 'local', code: 'ERR_FUNCTION_CALL' });
  });

  test.each([
    ['a uri', 'file:///storage/emulated/0/DCIM/IMG_1.jpg'],
    ['a name with comma and space', 'Trip, Alice.jpg'],
    ['a bracket', 'a(2)'],
    ['an absolute path', '/data/user/0/x'],
    ['a message', 'Could not load image'],
    ['an empty string', ''],
    ['a 65-char token', 'a'.repeat(65)],
  ])('drops a string that is %s', (_label, value) => {
    expect(safeFields({ value })).toEqual({});
  });

  test('drops objects, arrays, null, undefined, NaN and Infinity', () => {
    expect(safeFields({ a: { p: 1 }, b: [1], c: null, d: undefined, e: NaN, f: Infinity })).toEqual({});
  });

  test('drops keys that are not identifiers', () => {
    expect(safeFields({ 'file:///x.jpg': 1, 'two words': 2, ok: 3 })).toEqual({ ok: 3 });
  });

  test('accepts no fields', () => {
    expect(safeFields(undefined)).toEqual({});
  });
});

describe('reportNonFatal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetCrashReportingForTests();
  });

  test('records "name: category" and logs only the safe fields first', () => {
    expect(reportNonFatal('FaceDetectionError', 'too_small', { source: 'local', width: 20, path: '/storage/x.jpg' }))
      .toBe(true);

    const instance = crashlytics.getCrashlytics.mock.results[0].value;
    expect(crashlytics.log).toHaveBeenCalledWith(instance, 'FaceDetectionError {"source":"local","width":20}');
    const [recordedOn, recorded, jsErrorName] = crashlytics.recordError.mock.calls[0];
    expect(recordedOn).toBe(instance);
    expect(recorded.message).toBe('FaceDetectionError: too_small');
    expect(recorded.name).toBe('FaceDetectionError');
    expect(jsErrorName).toBe('FaceDetectionError');
    expect(crashlytics.log.mock.invocationCallOrder[0])
      .toBeLessThan(crashlytics.recordError.mock.invocationCallOrder[0]);
  });

  test('replaces a name or category that is not an identifier', () => {
    reportNonFatal('Bad name', 'Could not load image from file:///x.jpg');
    const recorded = crashlytics.recordError.mock.calls[0][1];
    expect(recorded.message).toBe('NonFatal: other');
    expect(JSON.stringify([recorded.stack, crashlytics.log.mock.calls])).not.toContain('x.jpg');
  });

  test('stops after 10 reports in one session', () => {
    for (let i = 0; i < 15; i += 1) reportNonFatal('FaceDetectionError', 'run_failed');
    expect(crashlytics.recordError).toHaveBeenCalledTimes(10);
  });

  test('never throws when Crashlytics is unavailable', () => {
    crashlytics.getCrashlytics.mockImplementationOnce(() => { throw new Error('No Firebase App'); });
    expect(reportNonFatal('FaceDetectionError', 'run_failed')).toBe(false);
    expect(crashlytics.recordError).not.toHaveBeenCalled();
  });

  test('never throws when recording itself fails', () => {
    crashlytics.recordError.mockImplementationOnce(() => { throw new Error('bridge gone'); });
    expect(() => reportNonFatal('FaceDetectionError', 'run_failed')).not.toThrow();
  });
});
