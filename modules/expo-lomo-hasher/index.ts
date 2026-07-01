import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

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
  extractVideoFromZipAsync(zipUri: string): Promise<string>;
  getLocalLivePhotoVideoUriAsync(uri: string): Promise<string>;
  sliceFileAsync(sourceUri: string, destUri: string, offset: number): Promise<boolean>;
  encodeImageEmbeddingAsync(imageUri: string, modelPath: string): Promise<string>;
  encodeTextEmbeddingAsync(text: string, modelPath: string, vocabPath: string, mergesPath: string): Promise<string>;
  encodeFaceEmbeddingAsync(imageUri: string, boundingBox: any, modelPath: string): Promise<string>;
  generatePHashAsync(imageUri: string): Promise<string>;
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

export async function extractVideoFromZipAsync(zipUri: string): Promise<string> {
  return await ExpoLomoHasher.extractVideoFromZipAsync(zipUri);
}

export async function getLocalLivePhotoVideoUriAsync(uri: string): Promise<string> {
  return await ExpoLomoHasher.getLocalLivePhotoVideoUriAsync(uri);
}

export async function sliceFileAsync(sourceUri: string, destUri: string, offset: number): Promise<boolean> {
  return await ExpoLomoHasher.sliceFileAsync(sourceUri, destUri, offset);
}

export async function encodeImageEmbeddingAsync(imageUri: string, modelPath: string): Promise<string> {
  return await ExpoLomoHasher.encodeImageEmbeddingAsync(imageUri, modelPath);
}

export async function encodeTextEmbeddingAsync(text: string, modelPath: string, vocabPath: string, mergesPath: string): Promise<string> {
  return await ExpoLomoHasher.encodeTextEmbeddingAsync(text, modelPath, vocabPath, mergesPath);
}

export async function encodeFaceEmbeddingAsync(
  imageUri: string,
  boundingBox: { x: number; y: number; width: number; height: number },
  modelPath: string
): Promise<{ embedding: string, croppedImage: string } | "failed"> {
  if (Platform.OS === 'android') {
    return await ExpoLomoHasher.encodeFaceEmbeddingAsync(imageUri, boundingBox, modelPath);
  }
  return "failed";
}

export async function generatePHashAsync(imageUri: string): Promise<string> {
  return await ExpoLomoHasher.generatePHashAsync(imageUri);
}
