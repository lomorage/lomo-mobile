import { requireNativeModule } from 'expo-modules-core';

export interface LivePhotoBackupResult {
  uri: string;
  hash: string;
  imageHash: string;
  videoHash: string;
  filename: string;
}

type ExpoLomoHasherModuleType = {
  hashFileAsync(uri: string): Promise<string>;
  isLivePhotoAsync(uri: string): Promise<boolean>;
  prepareLivePhotoBackupAsync(uri: string): Promise<LivePhotoBackupResult | null>;
};

const ExpoLomoHasher = requireNativeModule<ExpoLomoHasherModuleType>('ExpoLomoHasher');

export async function hashFileAsync(uri: string): Promise<string> {
  return await ExpoLomoHasher.hashFileAsync(uri);
}

export async function isLivePhotoAsync(uri: string): Promise<boolean> {
  return await ExpoLomoHasher.isLivePhotoAsync(uri);
}

export async function prepareLivePhotoBackupAsync(uri: string): Promise<LivePhotoBackupResult | null> {
  return await ExpoLomoHasher.prepareLivePhotoBackupAsync(uri);
}
