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
