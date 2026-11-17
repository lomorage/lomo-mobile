// Zoom geometry for ZoomableMedia. The functions run on the UI thread inside gesture
// callbacks, hence the 'worklet' directives. Sizes are those of the zoomed view itself
// (not the screen: the photo area is only part of it) and of the picture drawn inside it
// (fitted with its aspect ratio, so usually smaller than the view in one direction). The tap
// position the gesture reports is relative to the view.

// Size the picture occupies inside the view when fitted ("contain"). Unknown aspect: fills it.
export function fittedSize(viewWidth, viewHeight, aspect) {
    'worklet';
    if (!(aspect > 0)) return { width: viewWidth, height: viewHeight };
    return {
        width: Math.min(viewWidth, viewHeight * aspect),
        height: Math.min(viewHeight, viewWidth / aspect),
    };
}

// How far the zoomed picture may move from center in one direction before an empty edge
// shows. A picture still smaller than the view after zooming stays centered.
export function maxPan(contentSize, viewSize, scale) {
    'worklet';
    return Math.max(0, (contentSize * scale - viewSize) / 2);
}

export function clampPan(value, contentSize, viewSize, scale) {
    'worklet';
    const max = maxPan(contentSize, viewSize, scale);
    return Math.max(-max, Math.min(value, max));
}

// Translation that keeps the tapped point under the finger while zooming to `scale` (the view
// scales around its center, so the point would otherwise slide away from it), kept inside the
// pan limits.
export function doubleTapTarget(tapX, tapY, viewWidth, viewHeight, aspect, scale) {
    'worklet';
    const content = fittedSize(viewWidth, viewHeight, aspect);
    return {
        x: clampPan((viewWidth / 2 - tapX) * (scale - 1), content.width, viewWidth, scale),
        y: clampPan((viewHeight / 2 - tapY) * (scale - 1), content.height, viewHeight, scale),
    };
}
