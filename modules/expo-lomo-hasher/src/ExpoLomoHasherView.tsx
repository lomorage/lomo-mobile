import { requireNativeView } from 'expo';
import * as React from 'react';

import { ExpoLomoHasherViewProps } from './ExpoLomoHasher.types';

const NativeView: React.ComponentType<ExpoLomoHasherViewProps> =
  requireNativeView('ExpoLomoHasher');

export default function ExpoLomoHasherView(props: ExpoLomoHasherViewProps) {
  return <NativeView {...props} />;
}
