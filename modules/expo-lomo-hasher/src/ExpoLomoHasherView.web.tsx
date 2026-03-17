import * as React from 'react';

import { ExpoLomoHasherViewProps } from './ExpoLomoHasher.types';

export default function ExpoLomoHasherView(props: ExpoLomoHasherViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
