import { NativeModule, requireNativeModule } from 'expo';

import { ExpoLomoHasherModuleEvents } from './ExpoLomoHasher.types';

declare class ExpoLomoHasherModule extends NativeModule<ExpoLomoHasherModuleEvents> {
  PI: number;
  hello(): string;
  setValueAsync(value: string): Promise<void>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<ExpoLomoHasherModule>('ExpoLomoHasher');
