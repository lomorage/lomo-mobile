import { MIN_FACE_SIZE, MIN_FACE_WIDTH_RATIO, MIN_FACE_OF_LARGEST_RATIO, ANALYSIS_MAX_EDGE, REMOTE_PREVIEW_EDGE, buildFaceBoundingBox, isFaceTooSmall, isBystanderFace, minFaceSizeForScale, minFaceSizeForPreview, jpegSize, attachEyeLandmarks } from '../faceGeometry';

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

describe('minFaceSizeForPreview', () => {
  test('scales the 80px floor from the 2048px analysis image down to a 640px preview', () => {
    expect(minFaceSizeForPreview(REMOTE_PREVIEW_EDGE)).toBe(MIN_FACE_SIZE * REMOTE_PREVIEW_EDGE / ANALYSIS_MAX_EDGE);
  });

  test('keeps a 5% face on a 640px preview and still drops one under 4%', () => {
    const floor = minFaceSizeForPreview(640);
    const previewWidth = 640;
    // 107px on the 2000px analysis image of a 4000px photo is 34px here.
    const kept = { width: 34, height: 34 };
    const largest = 78;
    expect(isBystanderFace(kept, previewWidth, floor, largest)).toBe(false);
    expect(isBystanderFace({ width: 20, height: 20 }, previewWidth, floor, largest)).toBe(true);
  });

  test('still drops a passer-by under 40% of the largest face', () => {
    const floor = minFaceSizeForPreview(640);
    expect(isBystanderFace({ width: 42, height: 42 }, 640, floor, 146)).toBe(true);
  });

  test('a preview narrower than the tier was not shrunk, so the floor stays 80px', () => {
    expect(minFaceSizeForPreview(500)).toBe(MIN_FACE_SIZE);
    expect(isBystanderFace({ width: 40, height: 40 }, 500, minFaceSizeForPreview(500), 40)).toBe(true);
  });

  test('an unknown width keeps the 80px floor', () => {
    expect(minFaceSizeForPreview(0)).toBe(MIN_FACE_SIZE);
    expect(minFaceSizeForPreview(undefined)).toBe(MIN_FACE_SIZE);
  });

  test('uses the real original width when the preview is a shrunk copy', () => {
    // 640 / 4000 of the 80px floor. A 5% face (34px on this preview) stays,
    // and a file that is already 640px wide keeps the full 80px floor.
    expect(minFaceSizeForPreview(640, 4000)).toBe(MIN_FACE_SIZE * 640 / 4000);
    expect(isBystanderFace({ width: 34, height: 34 }, 640, minFaceSizeForPreview(640, 4000), 78)).toBe(false);
    expect(minFaceSizeForPreview(640, 640)).toBe(MIN_FACE_SIZE);
  });
});

describe('jpegSize', () => {
  test('reads width and height from a SOF0 marker after an APP0 segment', () => {
    const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46];
    // precision 8, height 4000 (0x0fa0), width 2600 (0x0a28), 3 components
    const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x0f, 0xa0, 0x0a, 0x28, 0x03, 0x01, 0x11, 0x00];
    const bytes = new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
    expect(jpegSize(bytes)).toEqual({ width: 2600, height: 4000 });
  });

  test('returns null for a header that is not a JPEG', () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(null);
    expect(jpegSize(null)).toBe(null);
  });

  test('stops at the compressed scan and does not invent a size from it', () => {
    const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xff, 0xc0, 0x00, 0x0b];
    const bytes = new Uint8Array([0xff, 0xd8, ...sos]);
    expect(jpegSize(bytes)).toBe(null);
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
