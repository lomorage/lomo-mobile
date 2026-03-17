import { requireNativeModule } from 'expo-modules-core';

type ExpoLomoHasherModuleType = {
  hashFileAsync(uri: string): Promise<string>;
};

const ExpoLomoHasher = requireNativeModule<ExpoLomoHasherModuleType>('ExpoLomoHasher');

export async function hashFileAsync(uri: string): Promise<string> {
  return await ExpoLomoHasher.hashFileAsync(uri);
}
