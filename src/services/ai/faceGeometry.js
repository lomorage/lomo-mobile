// Faces smaller than this (in pixels, on either axis) are treated as blurry
// background bystanders/passers-by rather than genuine subjects. This alone
// isn't resolution-aware: 80px is strict on a 320px preview but lets a tiny
// background face through on a 4000px+ camera photo, so it's paired with
// MIN_FACE_WIDTH_RATIO below whenever the source image's width is known.
export const MIN_FACE_SIZE = 80;

// A genuine subject's face spans a noticeable fraction of the photo's width;
// a passer-by in the background typically doesn't. 4% comfortably keeps
// group-photo subjects (even a face among 6-8 people) while dropping
// incidental strangers caught in the frame of a landscape/travel shot.
export const MIN_FACE_WIDTH_RATIO = 0.04;

// In one photo the people you meant to shoot are about the same size. A face
// much smaller than the largest face is a passer-by behind them, even when it
// clears the 4% width floor. 0.4 still keeps a child beside an adult (often
// half to two thirds of the adult face) and a row of similar-sized people.
export const MIN_FACE_OF_LARGEST_RATIO = 0.4;

// Converts an MLKit face detection result's frame ({origin, size}) into the
// flat {x, y, width, height} shape used throughout the face-matching pipeline.
export function buildFaceBoundingBox(face) {
  return {
    x: face.frame.origin.x,
    y: face.frame.origin.y,
    width: face.frame.size.x,
    height: face.frame.size.y,
  };
}

// imageWidth is optional: pass the full source image's pixel width (not the
// crop's) when known, to also catch faces that clear the absolute pixel floor
// but are still tiny relative to a high-resolution photo.
// minFaceSize overrides the absolute floor. Android downscales anything over
// 2048px before ML Kit sees it (a full 50MP decode is what was killing the
// process). Pass MIN_FACE_SIZE * scale so a face keeps the same yes/no it
// would have had on the original pixels.
export function isFaceTooSmall(boundingBox, imageWidth, minFaceSize = MIN_FACE_SIZE) {
  const floor = minFaceSize > 0 ? minFaceSize : MIN_FACE_SIZE;
  if (boundingBox.width < floor || boundingBox.height < floor) return true;
  if (imageWidth && boundingBox.width / imageWidth < MIN_FACE_WIDTH_RATIO) return true;
  return false;
}

// scale is preparedWidth / originalWidth from prepareAnalysisImageAsync.
// 1 (or anything that isn't a shrink) keeps the 80px floor.
export function minFaceSizeForScale(scale) {
  if (!(scale > 0) || scale >= 1) return MIN_FACE_SIZE;
  return MIN_FACE_SIZE * scale;
}

// Local face detection never decodes an edge longer than this. Keep it in
// step with AnalysisImages.kt ANALYSIS_MAX_EDGE.
export const ANALYSIS_MAX_EDGE = 2048;

// The server's large preview tier. A file narrower than this was not shrunk.
export const REMOTE_PREVIEW_EDGE = 640;

// Absolute face floor for a server preview, in that preview's pixels.
// The 80px floor is defined on the original. On a 640px-wide preview of a
// 4000px photo the same face is much smaller, and leaving the floor at 80
// drops people the local pass keeps. Pass the original width when it is
// known. Without it, a preview at the 640px tier is scaled as if the local
// pass had used ANALYSIS_MAX_EDGE, and a narrower file was not shrunk.
export function minFaceSizeForPreview(previewWidth, originalWidth) {
  const preview = Number(previewWidth) || 0;
  const original = Number(originalWidth) || 0;
  if (!(preview > 0)) return MIN_FACE_SIZE;
  if (original > 0) return minFaceSizeForScale(preview / original);
  if (preview < REMOTE_PREVIEW_EDGE - 1) return MIN_FACE_SIZE;
  return minFaceSizeForScale(preview / ANALYSIS_MAX_EDGE);
}

// Width and height from a JPEG header (SOF). Returns null when the header is
// not a JPEG or the frame marker is past the bytes we have. Does not decode
// pixels. Orientation is not applied; callers only need the scale of a preview.
export function jpegSize(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      if (!(width > 0) || !(height > 0)) return null;
      return { width, height };
    }
    // Standalone markers have no length. SOS is the compressed scan: the
    // frame size is never after it, and scanning it can mistake stuffed
    // bytes for another marker.
    if (marker === 0xda) return null;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) return null;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

// largestFaceWidth is the widest face box in the same photo. Omit it (or pass
// the box's own width) for a single face: that face is the subject.
export function isBystanderFace(boundingBox, imageWidth, minFaceSize = MIN_FACE_SIZE, largestFaceWidth) {
  if (isFaceTooSmall(boundingBox, imageWidth, minFaceSize)) return true;
  if (!(largestFaceWidth > 0)) return false;
  return boundingBox.width < largestFaceWidth * MIN_FACE_OF_LARGEST_RATIO;
}

// Locates the left/right eye landmarks on an MLKit face (when landmark
// detection was enabled) and attaches their positions to boundingBox, so
// downstream native code can use them to align the crop for ArcFace/SFace.
// Mutates and returns boundingBox for convenient chaining.
export function attachEyeLandmarks(boundingBox, face) {
  if (face.landmarks) {
    const leftEye = face.landmarks.find(l => l.type === '4' || l.type === 'LEFT_EYE');
    const rightEye = face.landmarks.find(l => l.type === '10' || l.type === 'RIGHT_EYE');
    if (leftEye && rightEye) {
      boundingBox.leftEye = { x: leftEye.position.x, y: leftEye.position.y };
      boundingBox.rightEye = { x: rightEye.position.x, y: rightEye.position.y };
    }
  }
  return boundingBox;
}
