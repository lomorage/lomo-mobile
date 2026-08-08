import { MIN_FACE_SIZE, buildFaceBoundingBox, isFaceTooSmall, attachEyeLandmarks } from '../faceGeometry';

describe('buildFaceBoundingBox', () => {
  test('flattens MLKit origin/size frame into x/y/width/height', () => {
    const face = { frame: { origin: { x: 10, y: 20 }, size: { x: 100, y: 150 } } };
    expect(buildFaceBoundingBox(face)).toEqual({ x: 10, y: 20, width: 100, height: 150 });
  });
});

describe('isFaceTooSmall', () => {
  test('is false when both dimensions meet MIN_FACE_SIZE', () => {
    expect(isFaceTooSmall({ width: MIN_FACE_SIZE, height: MIN_FACE_SIZE })).toBe(false);
    expect(isFaceTooSmall({ width: 200, height: 200 })).toBe(false);
  });

  test('is true when either dimension is below MIN_FACE_SIZE', () => {
    expect(isFaceTooSmall({ width: MIN_FACE_SIZE - 1, height: 200 })).toBe(true);
    expect(isFaceTooSmall({ width: 200, height: MIN_FACE_SIZE - 1 })).toBe(true);
  });
});

describe('attachEyeLandmarks', () => {
  test('attaches leftEye/rightEye when both landmarks are present (numeric MLKit type codes)', () => {
    const face = {
      landmarks: [
        { type: '4', position: { x: 30, y: 40 } },  // LEFT_EYE
        { type: '10', position: { x: 60, y: 40 } }, // RIGHT_EYE
        { type: '0', position: { x: 45, y: 55 } },  // some other landmark (e.g. nose base)
      ],
    };
    const bbox = { x: 0, y: 0, width: 100, height: 100 };
    const result = attachEyeLandmarks(bbox, face);
    expect(result.leftEye).toEqual({ x: 30, y: 40 });
    expect(result.rightEye).toEqual({ x: 60, y: 40 });
  });

  test('also matches the named LEFT_EYE/RIGHT_EYE landmark type strings', () => {
    const face = {
      landmarks: [
        { type: 'LEFT_EYE', position: { x: 5, y: 6 } },
        { type: 'RIGHT_EYE', position: { x: 7, y: 8 } },
      ],
    };
    const result = attachEyeLandmarks({}, face);
    expect(result.leftEye).toEqual({ x: 5, y: 6 });
    expect(result.rightEye).toEqual({ x: 7, y: 8 });
  });

  test('leaves boundingBox untouched when landmarks are missing entirely', () => {
    const bbox = { x: 0, y: 0, width: 100, height: 100 };
    const result = attachEyeLandmarks(bbox, {});
    expect(result).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(result.leftEye).toBeUndefined();
  });

  test('leaves boundingBox untouched when only one eye is detected', () => {
    const face = { landmarks: [{ type: 'LEFT_EYE', position: { x: 1, y: 2 } }] };
    const bbox = { x: 0, y: 0, width: 100, height: 100 };
    const result = attachEyeLandmarks(bbox, face);
    expect(result.leftEye).toBeUndefined();
    expect(result.rightEye).toBeUndefined();
  });

  test('mutates the boundingBox object in place, not just the return value', () => {
    const face = {
      landmarks: [
        { type: 'LEFT_EYE', position: { x: 1, y: 2 } },
        { type: 'RIGHT_EYE', position: { x: 3, y: 4 } },
      ],
    };
    const bbox = { x: 0, y: 0, width: 10, height: 10 };
    attachEyeLandmarks(bbox, face);
    expect(bbox.leftEye).toEqual({ x: 1, y: 2 });
  });
});
