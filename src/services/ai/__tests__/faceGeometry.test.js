import { MIN_FACE_SIZE, MIN_FACE_WIDTH_RATIO, MIN_FACE_OF_LARGEST_RATIO, buildFaceBoundingBox, isFaceTooSmall, isBystanderFace, minFaceSizeForScale, attachEyeLandmarks } from '../faceGeometry';

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

  test('a downscaled copy makes the same decision when the floor is scaled with it', () => {
    // 1600px photo, face exactly 80px (5% of the width, so the ratio check passes
    // and the absolute floor is what would reject anything smaller). Half size
    // must still pass.
    const scale = 0.5;
    const imageWidth = 1600;
    const full = { width: MIN_FACE_SIZE, height: MIN_FACE_SIZE };
    const prepared = { width: MIN_FACE_SIZE * scale, height: MIN_FACE_SIZE * scale };
    expect(isFaceTooSmall(full, imageWidth)).toBe(false);
    expect(isFaceTooSmall(prepared, imageWidth * scale, minFaceSizeForScale(scale))).toBe(false);

    // One pixel under the floor is rejected on the original and on the half-size copy.
    const under = { width: MIN_FACE_SIZE - 1, height: MIN_FACE_SIZE };
    const underPrepared = { width: (MIN_FACE_SIZE - 1) * scale, height: MIN_FACE_SIZE * scale };
    expect(isFaceTooSmall(under, imageWidth)).toBe(true);
    expect(isFaceTooSmall(underPrepared, imageWidth * scale, minFaceSizeForScale(scale))).toBe(true);

    // 100px in 4032px is a bystander (~2.5%). Half size is still a bystander.
    expect(isFaceTooSmall({ width: 100, height: 100 }, 4032)).toBe(true);
    expect(isFaceTooSmall({ width: 50, height: 50 }, 2016, minFaceSizeForScale(scale))).toBe(true);
  });
});

describe('minFaceSizeForScale', () => {
  test('keeps the 80px floor when the image was not shrunk', () => {
    expect(minFaceSizeForScale(1)).toBe(MIN_FACE_SIZE);
    expect(minFaceSizeForScale(0)).toBe(MIN_FACE_SIZE);
    expect(minFaceSizeForScale(undefined)).toBe(MIN_FACE_SIZE);
  });

  test('shrinks the floor by the same factor as the image', () => {
    expect(minFaceSizeForScale(0.25)).toBe(20);
  });
});

describe('isBystanderFace', () => {
  test('a face under 40% of the largest face in the same photo is a bystander', () => {
    // 100 / 300 is about 0.33, and 100px on a 2000px photo still clears both floors.
    expect(isBystanderFace({ width: 100, height: 100 }, 2000, MIN_FACE_SIZE, 300)).toBe(true);
  });

  test('a face at exactly 40% of the largest is kept', () => {
    const largest = 300;
    const width = largest * MIN_FACE_OF_LARGEST_RATIO;
    expect(isBystanderFace({ width, height: width }, 2000, MIN_FACE_SIZE, largest)).toBe(false);
  });

  test('the only face is not a bystander', () => {
    expect(isBystanderFace({ width: 200, height: 200 }, 2000, MIN_FACE_SIZE, 200)).toBe(false);
  });

  test('a child-sized face next to an adult is kept', () => {
    // 220 / 400 = 0.55, the size of a child standing beside an adult.
    expect(isBystanderFace({ width: 220, height: 220 }, 4000, MIN_FACE_SIZE, 400)).toBe(false);
  });

  test('an absolute-floor failure is still a bystander when it is the largest face', () => {
    expect(isBystanderFace({ width: 40, height: 40 }, 2000, MIN_FACE_SIZE, 40)).toBe(true);
  });

  test('a missing largest width does not add a relative rejection', () => {
    expect(isBystanderFace({ width: 200, height: 200 }, 2000)).toBe(false);
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
