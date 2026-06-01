import React from 'react';
import { StyleSheet, Dimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

export default function ZoomableMedia({ children, onZoomStateChange, style }) {
    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const translationX = useSharedValue(0);
    const translationY = useSharedValue(0);
    const savedTranslationX = useSharedValue(0);
    const savedTranslationY = useSharedValue(0);

    const updateZoomState = (isZoomed) => {
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
                const targetX = (screenWidth / 2 - event.x) * 1.5;
                const targetY = (screenHeight / 2 - event.y) * 1.5;
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
            }
        });

    const panGesture = Gesture.Pan()
        .minPointers(1)
        .onUpdate((event) => {
            if (scale.value > 1) {
                // Limit pan boundaries based on current scale
                const maxPanX = (screenWidth * (scale.value - 1)) / 2;
                const maxPanY = (screenHeight * (scale.value - 1)) / 2;
                translationX.value = Math.max(-maxPanX, Math.min(event.translationX + savedTranslationX.value, maxPanX));
                translationY.value = Math.max(-maxPanY, Math.min(event.translationY + savedTranslationY.value, maxPanY));
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
            <Animated.View style={[style, animatedStyle]}>
                {children}
            </Animated.View>
        </GestureDetector>
    );
}
