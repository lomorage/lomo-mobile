jest.mock('@react-native-firebase/crashlytics', () => {
  const instance = { tag: 'crashlytics' };
  return {
    getCrashlytics: jest.fn(() => instance),
    log: jest.fn(),
    recordError: jest.fn(),
  };
});

const crashlytics = require('@react-native-firebase/crashlytics');
const { reportNonFatal, scrubMessage, _resetCrashReportingForTests } = require('../crashReporting');

describe('scrubMessage', () => {
  test.each([
    ['RNMLKitImage: Could not load image from file:///storage/emulated/0/DCIM/IMG_1.jpg',
      'RNMLKitImage: Could not load image from <uri>'],
    ['Could not open content URI: content://media/external/images/media/42',
      'Could not open content URI: <uri>'],
    ['open failed: ENOENT (/data/user/0/com.wtao.lomo/cache/analysis-1.jpg)',
      'open failed: ENOENT (<path>)'],
    ['/storage/emulated/0/Pictures/a b.png: open failed',
      '<path>: open failed'],
    ['Could not load image from file:///storage/emulated/0/DCIM/My Trip/a b.jpg',
      'Could not load image from <uri>'],
    ["rejected.\n→ Caused by: from file:///storage/emulated/0/x.jpg\nnext line",
      "rejected.\n→ Caused by: from <uri>\nnext line"],
    ['"file:///var/mobile/Containers/x.jpg", ph://ABC-123/L0/001',
      '"<uri>", <uri>'],
    ['InputImage width and height should be at least 32!',
      'InputImage width and height should be at least 32!'],
  ])('%s', (input, expected) => {
    expect(scrubMessage(input)).toBe(expected);
  });
});

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
    expect(recorded).not.toBe(original);
    expect(jsErrorName).toBe('FaceDetectionError');
    expect(crashlytics.log.mock.invocationCallOrder[0])
      .toBeLessThan(crashlytics.recordError.mock.invocationCallOrder[0]);
  });

  test('scrubs paths from the recorded message, its stack and the log line', () => {
    const original = new Error('RNMLKitImage: Could not load image from file:///storage/emulated/0/DCIM/IMG_1.jpg');

    reportNonFatal(original, 'FaceDetectionError', { note: 'content://media/external/images/media/42' });

    const recorded = crashlytics.recordError.mock.calls[0][1];
    const sent = JSON.stringify([recorded.message, recorded.stack, crashlytics.log.mock.calls]);
    expect(sent).not.toMatch(/storage|DCIM|IMG_1|media\/42/);
    expect(recorded.message).toBe('RNMLKitImage: Could not load image from <uri>');
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
