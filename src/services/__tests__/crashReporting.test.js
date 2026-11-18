jest.mock('@react-native-firebase/crashlytics', () => {
  const instance = { tag: 'crashlytics' };
  return {
    getCrashlytics: jest.fn(() => instance),
    log: jest.fn(),
    recordError: jest.fn(),
  };
});

const crashlytics = require('@react-native-firebase/crashlytics');
const { reportNonFatal, _resetCrashReportingForTests } = require('../crashReporting');

describe('reportNonFatal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetCrashReportingForTests();
  });

  test('logs the context, then records the error under the given name', () => {
    const original = new Error('Failed to run face detector.');

    expect(reportNonFatal(original, 'FaceDetectionError', { source: 'local', width: 20 })).toBe(true);

    const instance = crashlytics.getCrashlytics.mock.results[0].value;
    expect(crashlytics.log).toHaveBeenCalledWith(instance, 'FaceDetectionError {"source":"local","width":20}');
    const [recordedOn, recorded, jsErrorName] = crashlytics.recordError.mock.calls[0];
    expect(recordedOn).toBe(instance);
    expect(recorded.message).toBe('Failed to run face detector.');
    expect(recorded.name).toBe('FaceDetectionError');
    expect(recorded.stack).toBe(original.stack);
    expect(jsErrorName).toBe('FaceDetectionError');
    expect(crashlytics.log.mock.invocationCallOrder[0])
      .toBeLessThan(crashlytics.recordError.mock.invocationCallOrder[0]);
  });

  test('accepts a non-Error rejection', () => {
    reportNonFatal('plain string', 'FaceDetectionError');
    expect(crashlytics.recordError.mock.calls[0][1].message).toBe('plain string');
  });

  test('stops after 10 reports in one session', () => {
    for (let i = 0; i < 15; i += 1) reportNonFatal(new Error(`e${i}`), 'FaceDetectionError');
    expect(crashlytics.recordError).toHaveBeenCalledTimes(10);
  });

  test('never throws when Crashlytics is unavailable', () => {
    crashlytics.getCrashlytics.mockImplementationOnce(() => { throw new Error('No Firebase App'); });
    expect(reportNonFatal(new Error('x'), 'FaceDetectionError')).toBe(false);
    expect(crashlytics.recordError).not.toHaveBeenCalled();
  });

  test('never throws when recording itself fails', () => {
    crashlytics.recordError.mockImplementationOnce(() => { throw new Error('bridge gone'); });
    expect(() => reportNonFatal(new Error('x'), 'FaceDetectionError')).not.toThrow();
  });
});
