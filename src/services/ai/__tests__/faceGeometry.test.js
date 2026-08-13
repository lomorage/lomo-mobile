import { MIN_FACE_SIZE, MIN_FACE_WIDTH_RATIO, buildFaceBoundingBox, isFaceTooSmall, attachEyeLandmarks } from '../faceGeometry';

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

  test('without imageWidth, only the absolute pixel floor applies (no ratio check)', () => {
    // A 100px face clears MIN_FACE_SIZE, so it's fine even though it would be
    // a tiny fraction of e.g. a 4000px photo -- we just don't know that here.
    expect(isFaceTooSmall({ width: 100, height: 100 })).toBe(false);
  });

  test('is true when the face clears the pixel floor but is a tiny fraction of a high-res photo', () => {
    // 100px face in a 4032px-wide photo (~2.5%) -- a background bystander, not a subject.
    expect(isFaceTooSmall({ width: 100, height: 100 }, 4032)).toBe(true);
  });

  test('is false when the face clears both the pixel floor and the width ratio', () => {
    // 200px face in a 4032px-wide photo (~5%) -- large enough to count as a subject.
    expect(isFaceTooSmall({ width: 200, height: 200 }, 4032)).toBe(false);
  });

  test('ratio check is a no-op on a low-res image where the pixel floor already dominates', () => {
    // 90px face in a 640px preview is ~14%, well above MIN_FACE_WIDTH_RATIO,
    // so behavior matches the pixel-only check on small source images.
    expect(isFaceTooSmall({ width: 90, height: 90 }, 640)).toBe(false);
  });

  test('boundary: exactly MIN_FACE_WIDTH_RATIO of the image width is not too small', () => {
    // Large enough image that the ratio check, not the absolute pixel floor, is what's being tested.
    const imageWidth = 4000;
    const faceWidth = imageWidth * MIN_FACE_WIDTH_RATIO;
    expect(isFaceTooSmall({ width: faceWidth, height: faceWidth }, imageWidth)).toBe(false);
  });

  test('treats a falsy imageWidth (0/undefined) as "unknown", skipping the ratio check', () => {
    expect(isFaceTooSmall({ width: 100, height: 100 }, 0)).toBe(false);
    expect(isFaceTooSmall({ width: 100, height: 100 }, undefined)).toBe(false);
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
