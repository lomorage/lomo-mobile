import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import MediaService from './MediaService';
import AuthService from './AuthService';
import axios from 'axios';

class UploadService {
    constructor() {
        this.isUploading = false;
    }

    /**
     * Checks if an asset already exists on the server to avoid redundant uploads.
     * Lomorage returns 200/206 if exists or partial, 404 if not found.
     */
    async checkUploadStatus(hash) {
        const serverUrl = AuthService.getServerUrl();
        const token = AuthService.getToken();
        if (!serverUrl || !token || !hash) return { exists: false };

        try {
            const response = await axios.head(`${serverUrl}/asset/${hash.toLowerCase()}`, {
                headers: { 'Authorization': `token=${token}` },
                timeout: 5000
            });
            
            if (response.status === 200 || response.status === 409) {
                return { exists: true };
            }
            if (response.status === 206) {
                // Potential for resumable upload (If-Match header)
                return { exists: false, resumable: true };
            }
            return { exists: false };
        } catch (error) {
            // 404 is expected if not uploaded yet
            return { exists: false };
        }
    }

    async uploadAsset(asset, onProgress) {
        const serverUrl = AuthService.getServerUrl();
        const token = AuthService.getToken();
        
        if (!serverUrl || !token) {
            throw new Error('Server connection not established. Please log in again.');
        }

        let tempFileToClean = null;

        try {
            // 1. Get full asset info
            const info = await MediaService.getAssetInfo(asset.id);
            let uploadUri = info.localUri || info.uri;

            if (Platform.OS === 'ios' && asset.uri && asset.uri.startsWith('ph://')) {
                // EXACT BYTES EXTRACTION:
                // info.localUri from Expo often points to a dynamically transcoded JPG on iOS 
                // which has a completely different hash than the original HEIC. 
                // Copying the ph:// URI directly extracts the exact original file bytes.
                uploadUri = `${FileSystem.cacheDirectory}${asset.id.replace(/[^a-zA-Z0-9]/g, '')}.raw`;
                await FileSystem.copyAsync({ from: asset.uri, to: uploadUri });
                tempFileToClean = uploadUri;
            }

            if (!uploadUri) throw new Error('Could not resolve local file path.');
            const uri = MediaService.normalizeUri(uploadUri);

            // 2. Calculate SHA1 hash (required for Lomorage protocol)
            let hash = asset.hash;
            if (!hash) {
                hash = await MediaService.calculateHash(uri);
            }
            if (!hash) throw new Error('Failed to calculate file integrity hash.');

            // 3. Check if already uploaded (Server-side de-duplication)
            const status = await this.checkUploadStatus(hash);
            if (status.exists) {
                console.log(`[UploadService] Asset ${hash} already on server, skipping.`);
                return { success: true, duplicate: true, hash };
            }

            // 4. Construct Upload URL with metadata
            const ext = (info.filename || 'file.jpg').split('.').pop().toLowerCase();
            const creationTime = new Date(info.creationTime || Date.now()).toISOString();
            const uploadUrl = `${serverUrl}/asset/${hash.toLowerCase()}?ext=${ext}&createtime=${creationTime}`;

            // React Native XHR is notoriously bad at calculating `event.total` for raw `{uri}` streams
            // We fetch the exact raw file size from the disk to use as our reliable denominator.
            let fileSizeBytes = 1;
            try {
                const fileInfo = await FileSystem.getInfoAsync(uri, { size: true });
                if (fileInfo.exists && fileInfo.size) {
                    fileSizeBytes = fileInfo.size;
                }
            } catch(e) {}

            console.log(`[UploadService] Uploading to: ${uploadUrl} (Size: ${fileSizeBytes} bytes)`);

            // 5. Binary Upload using native session
            // iOS background URL sessions require HTTPS — plain HTTP (LAN server) silently
            // fails with NSURLErrorUnknown (-1). Use a foreground session on iOS instead.
            // Android background sessions work fine with HTTP, so keep BACKGROUND there.
            const sessionType = Platform.OS === 'ios'
                ? (FileSystem.FileSystemSessionType?.FOREGROUND ?? 1)
                : (FileSystem.FileSystemSessionType?.BACKGROUND ?? FileSystem.FileSystemUploadSessionType?.BACKGROUND ?? 0);

            const task = FileSystem.createUploadTask(
                uploadUrl,
                uri,
                {
                    httpMethod: 'POST',
                    headers: {
                        'Authorization': `token=${token}`,
                        'Content-Type': 'application/octet-stream',
                    },
                    sessionType,
                },
                (progress) => {
                    if (onProgress && progress.totalBytesExpectedToSend > 0) {
                        onProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
                    }
                }
            );

            const response = await task.uploadAsync();
            
            if (response.status === 200 || response.status === 201 || response.status === 409) {
                return { success: true, hash };
            } else {
                let errorMsg = `Server returned ${response.status}`;
                let isDuplicate = false;
                let isDifferentHash = false;
                try {
                    const body = JSON.parse(response.body);
                    errorMsg = body.text || errorMsg;
                    // Server returns UNIQUE constraint when a concurrent upload already saved it
                    if (errorMsg.includes('UNIQUE constraint failed')) isDuplicate = true;
                    // Server returns 'different hash' when iOS re-encodes the file between
                    // hashing and uploading (HEIC auto-conversion, EXIF rewrite, iCloud sync, etc.)
                    if (errorMsg.includes('different hash')) isDifferentHash = true;
                } catch (e) {}
                if (isDuplicate) {
                    console.warn(`[UploadService] Concurrent duplicate detected for ${hash}, treating as success.`);
                    return { success: true, hash, duplicate: true };
                }
                const err = new Error(errorMsg);
                err.isDifferentHash = isDifferentHash;
                throw err;
            }

        } catch (error) {
            console.error('[UploadService] Upload failed:', error);
            throw error;
        } finally {
            if (tempFileToClean) {
                try {
                    await FileSystem.deleteAsync(tempFileToClean, { idempotent: true });
                } catch (e) {}
            }
        }
    }
}

export default new UploadService();

