// Faces smaller than this (in pixels, on either axis) are treated as blurry
// background bystanders/passers-by rather than genuine subjects.
export const MIN_FACE_SIZE = 80;

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

export function isFaceTooSmall(boundingBox) {
  return boundingBox.width < MIN_FACE_SIZE || boundingBox.height < MIN_FACE_SIZE;
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
