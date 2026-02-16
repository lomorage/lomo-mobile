import axios from 'axios';
import * as FileSystem from 'expo-file-system';
import MediaService from './MediaService';

class UploadService {
    constructor() {
        this.host = '';
        this.port = '';
        this.token = '';
        this.isUploading = false;
    }

    setServerConfig(host, port, token) {
        this.host = host;
        this.port = port;
        this.token = token;
    }

    async uploadAsset(asset) {
        if (!this.host || !this.token) {
            throw new Error('Server configuration missing');
        }

        try {
            const assetInfo = await MediaService.getAssetInfo(asset.id);
            const uri = assetInfo.localUri || assetInfo.uri;
            const fileName = assetInfo.filename;
            const creationTime = new Date(assetInfo.creationTime).toISOString();
            const fileExt = fileName.split('.').pop().toLowerCase();

            // In a real implementation, we would calculate SHA1 hash here.
            // For this initial version, we'll use a placeholder or the asset ID if the server allows.
            // Assuming a simplified POST endpoint for now.

            const uploadUrl = `http://${this.host}:${this.port}/asset/upload?ext=${fileExt}&createtime=${creationTime}`;

            const response = await FileSystem.uploadAsync(uploadUrl, uri, {
                httpMethod: 'POST',
                uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
                headers: {
                    'Authorization': `token=${this.token}`,
                    'Content-Type': 'application/octet-stream',
                },
            });

            return response.status === 200 || response.status === 201;
        } catch (error) {
            console.error('Upload failed:', error);
            throw error;
        }
    }
}

export default new UploadService();
