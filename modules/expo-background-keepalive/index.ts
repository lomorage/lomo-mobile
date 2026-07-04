import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

const isIOS = Platform.OS === 'ios';
const ExpoBackgroundKeepalive = isIOS ? requireOptionalNativeModule('ExpoBackgroundKeepalive') : null;

export function startKeepAlive(): void {
  if (isIOS && ExpoBackgroundKeepalive) {
    ExpoBackgroundKeepalive.start();
  }
}

export function stopKeepAlive(): void {
  if (isIOS && ExpoBackgroundKeepalive) {
    ExpoBackgroundKeepalive.stop();
  }
}
