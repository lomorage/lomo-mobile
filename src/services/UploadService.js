import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import MediaService from './MediaService';
import AuthService from './AuthService';
import axios from 'axios';

class UploadService {
    constructor() {
        this.activeTasks = new Map(); // assetId -> task
        this.activePromises = new Map(); // assetId -> promise
        this.cancelledTasks = new Set(); // assetId
    }

    cancelUpload(assetId) {
        console.log(`[UploadService] Cancelling upload task for ${assetId}...`);
        this.cancelledTasks.add(assetId);
        const task = this.activeTasks.get(assetId);
        if (task) {
            task.cancelAsync().catch(() => {});
        }
    }

    cancelAllUploads() {
        console.log('[UploadService] Cancelling all active upload tasks...');
        for (const [assetId, task] of this.activeTasks.entries()) {
            this.cancelledTasks.add(assetId);
            task.cancelAsync().catch(() => {});
        }
    }

    /**
     * Checks if an asset already exists on the server to avoid redundant uploads.
     * Lomorage returns:
     *   200/409 → fully uploaded
     *   206     → partially uploaded, Content-Range header tells us how many bytes received
     *   404     → not uploaded yet
     */
    async checkUploadStatus(hash) {
        const serverUrl = AuthService.getServerUrl();
        const token = AuthService.getToken();
        if (!serverUrl || !token || !hash) return { exists: false };

        try {
            console.log(`[UploadService] checkUploadStatus: HEAD ${serverUrl}/asset/${hash.toLowerCase()}`);
            const response = await axios.head(`${serverUrl}/asset/${hash.toLowerCase()}`, {
                headers: { 'Authorization': `token=${token}` },
                timeout: 60000, // 60s: Lomorage backend does full-file SHA1 hashing on every HEAD, which can take > 5s for large videos on ARM NAS
                skipAutoProbe: true
            });
            
            console.log(`[UploadService] checkUploadStatus: returned ${response.status}`);

            if (response.status === 200 || response.status === 409) {
                return { exists: true };
            }
            if (response.status === 206) {
                // Lomorage backend returns the partial size in the "If-Match" response header
                // Format: If-Match: size=12345, sha1=...
                let receivedBytes = 0;
                const ifMatch = response.headers['if-match'] || response.headers['If-Match'];
                
                if (ifMatch) {
                    const match = ifMatch.match(/size=(\d+)/i);
                    if (match) {
                        receivedBytes = parseInt(match[1], 10);
                        console.log(`[UploadService] 206 Partial: parsed receivedBytes=${receivedBytes} from If-Match header`);
                    } else {
                        console.warn(`[UploadService] 206 Partial: If-Match header exists but missing size: ${ifMatch}`);
                    }
                } else {
                    console.warn(`[UploadService] 206 Partial: Missing If-Match header in server response!`, response.headers);
                }
                
                return { exists: false, resumable: true, receivedBytes, ifMatch };
            }
            return { exists: false };
        } catch (error) {
            // 404 is expected if not uploaded yet
            console.log(`[UploadService] checkUploadStatus: error ${error.response?.status || error.message}`);
            if (error.response && error.response.status === 404) {
                return { exists: false };
            }
            // If it's a timeout (Network Error) or 500, we MUST throw!
            // Otherwise, we incorrectly assume the file doesn't exist and force a full upload!
            throw error;
        }
    }

    /**
     * Attempt a resumable (partial) upload.
     * Uses native FileSystem chunking to avoid JS Blob OOM crashes on large files.
     */
    async _resumeUpload({ assetId, uri, hash, uploadUrl, token, receivedBytes, ifMatch, fileSize, onProgress }) {
        const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks (Speeds up upload 5x while still avoiding RN bridge ANR)
        let position = receivedBytes;
        let currentIfMatch = ifMatch;
        this.cancelledTasks.delete(assetId);
        
        const tempChunkDir = FileSystem.cacheDirectory + 'lomorage_chunks/';
        await FileSystem.makeDirectoryAsync(tempChunkDir, { intermediates: true }).catch(()=>{});
        const tempChunkUri = tempChunkDir + `chunk_${assetId}_${hash}.tmp`;

        try {
            console.log(`[UploadService] Resuming upload via native slices from byte ${position}...`);

            while (position < fileSize) {
                if (this.cancelledTasks.has(assetId)) {
                    console.log(`[UploadService] Resumable upload cancelled by user at byte ${position}`);
                    throw new Error('Upload cancelled by user');
                }

                const endPosition = Math.min(position + CHUNK_SIZE, fileSize);
                const length = endPosition - position;

                // Native slice: read slice to base64, then write back to a temp binary file.
                // Using 1MB chunks ensures we don't block the JS thread with massive strings.
                const chunkBase64 = await FileSystem.readAsStringAsync(uri, {
                    encoding: FileSystem.EncodingType.Base64,
                    position: position,
                    length: length
                });

                await FileSystem.writeAsStringAsync(tempChunkUri, chunkBase64, {
                    encoding: FileSystem.EncodingType.Base64
                });

                const uploadResult = await FileSystem.uploadAsync(uploadUrl, tempChunkUri, {
                    httpMethod: 'PATCH',
                    headers: {
                        'Authorization': `token=${token}`,
                        'Content-Type': 'application/octet-stream',
                        'If-Match': currentIfMatch
                    }
                });
                
                if (uploadResult.status === 200 || uploadResult.status === 201 || uploadResult.status === 409) {
                    // Upload complete! (Final chunk uploaded and overall file hash matched)
                    if (onProgress) onProgress(1);
                    return { success: true, hash };
                } else if (uploadResult.status === 400 || uploadResult.status === 500) {
                    // Lomorage backend returns 400/500 (ErrAssetDiffHash) if the chunk appended successfully 
                    // but the accumulated file's SHA1 doesn't match the final file's SHA1 yet (because it's not the last chunk).
                    // We verify if it actually appended by calling HEAD again to get the new If-Match header!
                    const status = await this.checkUploadStatus(hash);
                    if (status.resumable && status.receivedBytes === endPosition) {
                        // Success! The chunk appended perfectly.
                        currentIfMatch = status.ifMatch;
                        position = endPosition;
                        if (onProgress) onProgress(position / fileSize);
                    } else {
                        // Real failure
                        console.warn(`[UploadService] Chunk rejected. Server size is ${status.receivedBytes}, expected ${endPosition}.`);
                        throw new Error(`Chunk rejected by server. Status: ${uploadResult.status}`);
                    }
                } else {
                    throw new Error(`Chunk upload failed with status ${uploadResult.status}`);
                }
                
                // Yield to UI thread for 50ms to allow Garbage Collector to clear the 1.3MB Base64 strings
                // This completely eliminates the "App isn't responding" ANR!
                await new Promise(r => setTimeout(r, 50)); 
            }
            
            console.log(`[UploadService] Resumed upload completed for ${hash}`);
            return { success: true, hash, resumed: true };

        } finally {
            await FileSystem.deleteAsync(tempChunkUri, { idempotent: true }).catch(()=>{});
        }
    }

    async uploadAsset(asset, onProgress) {
        if (this.activePromises.has(asset.id)) {
            console.log(`[UploadService] Asset ${asset.id} is already uploading, returning existing promise.`);
            return this.activePromises.get(asset.id);
        }

        const uploadPromise = this._executeUpload(asset, onProgress);
        this.activePromises.set(asset.id, uploadPromise);
        try {
            return await uploadPromise;
        } finally {
            this.activePromises.delete(asset.id);
            this.activeTasks.delete(asset.id);
            this.cancelledTasks.delete(asset.id);
        }
    }

    async _executeUpload(asset, onProgress) {
        const serverUrl = AuthService.getServerUrl();
        const token = AuthService.getToken();
        
        if (!serverUrl || !token) {
            throw new Error('Server connection not established. Please log in again.');
        }

        let tempFileToClean = null;

        try {
            // 1. Get full asset info
            const info = await MediaService.getAssetInfo(asset.id);
            // ALWAYS prioritize info.uri (content:// on Android) over localUri.
            // localUri is often an ephemeral cached transcode with a different hash.
            // Using content:// guarantees consistent hashes across app restarts!
            let uploadUri = info.uri || info.localUri;
            let isLivePhoto = false;
            let livePhotoBackup = null;

            if (Platform.OS === 'ios' && asset.uri && asset.uri.startsWith('ph://')) {
                isLivePhoto = await MediaService.isLivePhotoAsync(asset.uri);
                if (isLivePhoto) {
                    try {
                        console.log(`[UploadService] Asset ${asset.id} is a Live Photo. Preparing zip backup...`);
                        livePhotoBackup = await MediaService.prepareLivePhotoBackupAsync(asset.uri);
                    } catch (err) {
                        console.error('[UploadService] Live Photo zipping failed:', err);
                        throw err;
                    }
                }
            }

            if (livePhotoBackup) {
                uploadUri = livePhotoBackup.uri;
                tempFileToClean = uploadUri;
            } else if (Platform.OS === 'ios' && asset.uri && asset.uri.startsWith('ph://')) {
                // EXACT BYTES EXTRACTION:
                // info.localUri from Expo often points to a dynamically transcoded JPG on iOS 
                // which has a completely different hash than the original HEIC. 
                // Copying the ph:// URI directly extracts the exact original file bytes.
                uploadUri = `${FileSystem.cacheDirectory}${asset.id.replace(/[^a-zA-Z0-9]/g, '')}.raw`;
                const tempInfo = await FileSystem.getInfoAsync(uploadUri);
                if (!tempInfo.exists) {
                    await FileSystem.copyAsync({ from: asset.uri, to: uploadUri });
                } else {
                    console.log(`[UploadService] Reusing existing exact bytes temp file for ${asset.id}`);
                }
                tempFileToClean = uploadUri;
            }

            if (!uploadUri) throw new Error('Could not resolve local file path.');
            const uri = MediaService.normalizeUri(uploadUri);

            // 2. Calculate SHA1 hash (required for Lomorage protocol)
            let hash = asset.hash;
            if (livePhotoBackup) {
                hash = livePhotoBackup.hash;
            }
            if (!hash) {
                hash = await MediaService.calculateHash(uri);
            }
            if (!hash) throw new Error('Failed to calculate file integrity hash.');

            // Save hash to cache so it's instantly available for heuristic checks on next load
            try {
                const SyncService = require('./SyncService').default;
                await SyncService.loadLocalHashCache();
                SyncService.localHashCache[asset.id] = {
                    hash,
                    modificationTime: asset.modificationTime,
                    filename: info.filename || 'unknown'
                };
                await SyncService.saveLocalHashCache();
            } catch (cacheErr) {
                console.warn('[UploadService] Failed to save hash to cache:', cacheErr.message);
            }

            // 3. Get accurate file size from disk (needed for Content-Range header)
            let fileSizeBytes = 0;
            try {
                const fileInfo = await FileSystem.getInfoAsync(uri, { size: true });
                if (fileInfo.exists && fileInfo.size) {
                    fileSizeBytes = fileInfo.size;
                }
            } catch(e) {}
            
            // On Android, content:// URIs sometimes return 0 size from getInfoAsync.
            // We MUST have the correct file size to do a safe resumable upload.
            if (fileSizeBytes === 0) {
                try {
                    const response = await fetch(uri);
                    const fullBlob = await response.blob();
                    if (fullBlob.size) fileSizeBytes = fullBlob.size;
                } catch(e) {}
            }

            // 4. Check if already uploaded or partially uploaded (Server-side de-duplication)
            const status = await this.checkUploadStatus(hash);
            if (status.exists) {
                console.log(`[UploadService] Asset ${hash} already on server, skipping.`);
                if (tempFileToClean) await FileSystem.deleteAsync(tempFileToClean, { idempotent: true }).catch(()=>{});
                return { success: true, duplicate: true, hash };
            }

            // 5. Construct Upload URL with metadata
            const ext = livePhotoBackup ? 'zip' : (info.filename || 'file.jpg').split('.').pop().toLowerCase();
            const creationTime = new Date(info.creationTime || Date.now()).toISOString();
            const uploadUrl = `${serverUrl}/asset/${hash.toLowerCase()}?ext=${ext}&createtime=${creationTime}`;

            const isHttps = serverUrl.toLowerCase().startsWith('https://');

            // 6. Attempt resumable upload if server has partial data
            if (status.resumable && status.receivedBytes > 0 && status.ifMatch) {
                if (fileSizeBytes === 0) {
                    throw new Error('Cannot safely resume upload because exact local file size could not be determined. Aborting to prevent server data corruption.');
                }
                const resumeResult = await this._resumeUpload({
                    assetId: asset.id, uri, hash, uploadUrl, token,
                    receivedBytes: status.receivedBytes,
                    ifMatch: status.ifMatch,
                    fileSize: fileSizeBytes,
                    onProgress,
                });
                if (resumeResult) {
                    if (tempFileToClean) await FileSystem.deleteAsync(tempFileToClean, { idempotent: true }).catch(()=>{});
                    return resumeResult;
                }
            }

            console.log(`[UploadService] Full upload to: ${uploadUrl} (${fileSizeBytes} bytes)`);

            // 7. Full binary Upload using native session
            // iOS background URL sessions require HTTPS — plain HTTP (LAN server) silently
            // fails with NSURLErrorUnknown (-1). Use a foreground session on iOS instead for plain HTTP.
            const sessionType = Platform.OS === 'ios'
                ? (isHttps ? (FileSystem.FileSystemSessionType?.BACKGROUND ?? 0) : (FileSystem.FileSystemSessionType?.FOREGROUND ?? 1))
                : (FileSystem.FileSystemSessionType?.BACKGROUND ?? FileSystem.FileSystemUploadSessionType?.BACKGROUND ?? 0);

            this.cancelledTasks.delete(asset.id);
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
                    if (onProgress && fileSizeBytes > 0) {
                        onProgress(progress.totalBytesSent / fileSizeBytes);
                    }
                }
            );
            this.activeTasks.set(asset.id, task);

            if (this.cancelledTasks.has(asset.id)) {
                task.cancelAsync().catch(()=>{});
                throw new Error('Upload cancelled by user');
            }

            const response = await task.uploadAsync();
            this.activeTasks.delete(asset.id);
            
            if (response.status === 200 || response.status === 201 || response.status === 409) {
                if (tempFileToClean) await FileSystem.deleteAsync(tempFileToClean, { idempotent: true }).catch(()=>{});
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
                    if (tempFileToClean) await FileSystem.deleteAsync(tempFileToClean, { idempotent: true }).catch(()=>{});
                    return { success: true, hash, duplicate: true };
                }
                const err = new Error(errorMsg);
                err.isDifferentHash = isDifferentHash;
                throw err;
            }
        } catch (error) {
            console.error('[UploadService] Upload failed:', error);
            throw error;
        }
    }
}

export default new UploadService();

