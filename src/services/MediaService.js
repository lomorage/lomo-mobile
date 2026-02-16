import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

class MediaService {
  async requestPermissions() {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const { status } = await MediaLibrary.requestPermissionsAsync({
        granularPermissions: ['photo', 'video'],
      });
      return status === 'granted';
    }

    const { status } = await MediaLibrary.requestPermissionsAsync();
    return status === 'granted';
  }

  async getAssets(first = 50, after = null) {
    const options = {
      first,
      sortBy: [MediaLibrary.SortBy.creationTime],
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
    };
    if (after) {
      options.after = after;
    }

    return await MediaLibrary.getAssetsAsync(options);
  }

  async getAssetInfo(assetId) {
    return await MediaLibrary.getAssetInfoAsync(assetId);
  }
}

export default new MediaService();
