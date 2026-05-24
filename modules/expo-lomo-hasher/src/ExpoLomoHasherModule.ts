import { NativeModule, requireNativeModule } from 'expo';

import { ExpoLomoHasherModuleEvents } from './ExpoLomoHasher.types';

declare class ExpoLomoHasherModule extends NativeModule<ExpoLomoHasherModuleEvents> {
  PI: number;
  hello(): string;
  setValueAsync(value: string): Promise<void>;
  hashFileAsync(uri: string): Promise<string>;
  isLivePhotoAsync(uri: string): Promise<boolean>;
  prepareLivePhotoBackupAsync(uri: string): Promise<{
    uri: string;
    hash: string;
    imageHash: string;
    videoHash: string;
    filename: string;
  } | null>;
  extractVideoFromZipAsync(zipUri: string): Promise<string>;
  getLocalLivePhotoVideoUriAsync(uri: string): Promise<string>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<ExpoLomoHasherModule>('ExpoLomoHasher');
