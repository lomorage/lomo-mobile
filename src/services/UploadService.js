import * as FileSystem from 'expo-file-system/legacy';
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

        try {
            // 1. Get full asset info and local URI
            const info = await MediaService.getAssetInfo(asset.id);
            const uri = info.localUri || info.uri;
            if (!uri) throw new Error('Could not resolve local file path.');

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

            // 5. Binary Upload using standard React Native XMLHttpRequest
            // This replaces the deprecated expo-file-system createUploadTask
            // while retaining the 100% accurate byte progress stream without FormData.
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', uploadUrl);
                xhr.setRequestHeader('Authorization', `token=${token}`);
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.timeout = 30000; // 30s timeout for large file uploads

                xhr.upload.onprogress = (event) => {
                    if (onProgress) {
                        // event.total is unreliable when passing {uri} directly in RN XHR
                        const total = (event.total && event.total > fileSizeBytes) ? event.total : fileSizeBytes;
                        let progress = event.loaded / total;
                        if (progress > 1) progress = 1; // Clamp at 100% just in case
                        onProgress(progress);
                    }
                };

                xhr.onload = () => {
                    if (xhr.status === 200 || xhr.status === 201 || xhr.status === 409) {
                        resolve({ success: true, hash });
                    } else {
                        let errorMsg = `Server returned ${xhr.status}`;
                        try {
                            const body = JSON.parse(xhr.responseText);
                            errorMsg = body.text || errorMsg;
                        } catch (e) {}
                        reject(new Error(errorMsg));
                    }
                };

                xhr.onerror = (e) => {
                    console.error('[UploadService] XHR Error:', e);
                    reject(new Error('Network error or server unreachable.'));
                };

                xhr.ontimeout = () => {
                    console.error('[UploadService] XHR Timeout');
                    reject(new Error('Upload timed out. Check your connection.'));
                };

                // In React Native, passing an object with a `uri` key and `type` directly
                // into XHR un-boxes it and streams the raw file as the request body.
                xhr.send({ uri, type: 'application/octet-stream', name: info.filename || 'file.raw' });
            });

        } catch (error) {
            console.error('[UploadService] Upload failed:', error);
            throw error;
        }
    }
}

export default new UploadService();

