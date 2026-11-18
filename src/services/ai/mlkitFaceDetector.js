import { requireNativeModule } from 'expo-modules-core';

// The package's RNMLKitFaceDetector catches every native rejection, logs it
// and resolves undefined, from initialize() and detectFaces() alike. Callers
// then cannot tell a failure from "no faces": the scan saved such photos as
// done, and the error never reached Crashlytics. This calls the same native
// module and lets rejections through.

let nativeModule;

function getNativeModule() {
  if (!nativeModule) nativeModule = requireNativeModule('RNMLKitFaceDetection');
  return nativeModule;
}

export class MlKitFaceDetector {
  constructor(options) {
    this.options = options;
  }

  // The native side keeps one detector; this installs this instance's options.
  initialize() {
    return getNativeModule().initialize(this.options);
  }

  // Resolves { faces, ... }; rejects with the native error.
  detectFaces(imageUri) {
    return getNativeModule().detectFaces(imageUri);
  }
}

export function _resetMlKitFaceDetectorForTests() {
  nativeModule = undefined;
}
