import React, { useState, useEffect } from 'react';
import { StyleSheet, Dimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated';
import { clampPan, doubleTapTarget, fittedSize } from '../utils/zoomMath';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

export default function ZoomableMedia({ children, onZoomStateChange, style, contentAspect }) {
    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const translationX = useSharedValue(0);
    const translationY = useSharedValue(0);
    const savedTranslationX = useSharedValue(0);
    const savedTranslationY = useSharedValue(0);
    // Size of this view (measured in onLayout). Zoom and pan limits depend on it, not on
    // the screen: the photo area is only part of the screen.
    const viewWidth = useSharedValue(screenWidth);
    const viewHeight = useSharedValue(screenHeight * 0.7);
    // Width / height of the picture shown inside (fitted, so it can be smaller than the view).
    const aspect = useSharedValue(contentAspect || 0);
    // Pull the picture back inside the pan limits (they change with the picture's shape, the view's
    // size and the zoom). Runs on the JS thread: for effects and layout, not gesture callbacks.
    const reclamp = () => {
        if (scale.value <= 1) return;
        const content = fittedSize(viewWidth.value, viewHeight.value, aspect.value);
        translationX.value = clampPan(translationX.value, content.width, viewWidth.value, scale.value);
        translationY.value = clampPan(translationY.value, content.height, viewHeight.value, scale.value);
        savedTranslationX.value = translationX.value;
        savedTranslationY.value = translationY.value;
    };
    useEffect(() => {
        aspect.value = contentAspect || 0;
        // The picture's real shape can arrive after zooming (it loads).
        reclamp();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contentAspect]);

    const [isZoomedInternal, setIsZoomedInternal] = useState(false);

    const updateZoomState = (isZoomed) => {
        setIsZoomedInternal(isZoomed);
        if (onZoomStateChange) {
            onZoomStateChange(isZoomed);
        }
    };

    const doubleTapGesture = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd((event) => {
            if (scale.value > 1) {
                scale.value = withSpring(1);
                translationX.value = withSpring(0);
                translationY.value = withSpring(0);
                savedScale.value = 1;
                savedTranslationX.value = 0;
                savedTranslationY.value = 0;
                runOnJS(updateZoomState)(false);
            } else {
                scale.value = withSpring(2.5);
                // Zoom towards double tap center
                const target = doubleTapTarget(event.x, event.y, viewWidth.value, viewHeight.value, aspect.value, 2.5);
                const targetX = target.x;
                const targetY = target.y;
                translationX.value = withSpring(targetX);
                translationY.value = withSpring(targetY);
                savedScale.value = 2.5;
                savedTranslationX.value = targetX;
                savedTranslationY.value = targetY;
                runOnJS(updateZoomState)(true);
            }
        });

    const pinchGesture = Gesture.Pinch()
        .onUpdate((event) => {
            scale.value = Math.max(1, Math.min(event.scale * savedScale.value, 4));
            if (scale.value > 1) {
                // Pinching down shrinks the pan limits: keep the picture inside them as it goes.
                const content = fittedSize(viewWidth.value, viewHeight.value, aspect.value);
                translationX.value = clampPan(translationX.value, content.width, viewWidth.value, scale.value);
                translationY.value = clampPan(translationY.value, content.height, viewHeight.value, scale.value);
                runOnJS(updateZoomState)(true);
            }
        })
        .onEnd(() => {
            if (scale.value < 1.1) {
                scale.value = withSpring(1);
                translationX.value = withSpring(0);
                translationY.value = withSpring(0);
                savedScale.value = 1;
                savedTranslationX.value = 0;
                savedTranslationY.value = 0;
                runOnJS(updateZoomState)(false);
            } else {
                savedScale.value = scale.value;
                // Pinching back down shrinks the pan limits: pull the picture back inside them.
                const content = fittedSize(viewWidth.value, viewHeight.value, aspect.value);
                const x = clampPan(translationX.value, content.width, viewWidth.value, scale.value);
                const y = clampPan(translationY.value, content.height, viewHeight.value, scale.value);
                translationX.value = withSpring(x);
                translationY.value = withSpring(y);
                savedTranslationX.value = x;
                savedTranslationY.value = y;
            }
        });

    const panGesture = Gesture.Pan()
        .minPointers(1)
        .enabled(isZoomedInternal)
        .onUpdate((event) => {
            if (scale.value > 1) {
                // Limit pan boundaries based on current scale
                const content = fittedSize(viewWidth.value, viewHeight.value, aspect.value);
                translationX.value = clampPan(event.translationX + savedTranslationX.value, content.width, viewWidth.value, scale.value);
                translationY.value = clampPan(event.translationY + savedTranslationY.value, content.height, viewHeight.value, scale.value);
            }
        })
        .onEnd(() => {
            if (scale.value > 1) {
                savedTranslationX.value = translationX.value;
                savedTranslationY.value = translationY.value;
            }
        });

    const animatedStyle = useAnimatedStyle(() => {
        return {
            transform: [
                { translateX: translationX.value },
                { translateY: translationY.value },
                { scale: scale.value },
            ],
        };
    });

    const gestures = Gesture.Simultaneous(
        pinchGesture,
        Gesture.Simultaneous(panGesture, doubleTapGesture)
    );

    return (
        <GestureDetector gesture={gestures}>
            <Animated.View
                style={[style, animatedStyle]}
                onLayout={(e) => {
                    viewWidth.value = e.nativeEvent.layout.width;
                    viewHeight.value = e.nativeEvent.layout.height;
                    reclamp();
                }}
            >
                {children}
            </Animated.View>
        </GestureDetector>
    );
}
