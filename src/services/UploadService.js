import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import MediaService from './MediaService';
import AuthService from './AuthService';
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { sliceFileAsync, sliceFileRangeAsync } from '../../modules/expo-lomo-hasher';

// Proxies in front of lomod can cap the request body: Cloudflare (demo.lomorage.com style
// tunnels) answers 413 to anything over 100 MiB, before a byte reaches lomod. Uploads to a
// server that has answered 413 are sent in pieces of at most this size, using lomod's
// resume protocol (POST the first piece, then PATCH the rest with the If-Match from HEAD).
export const CHUNK_SIZE = 90 * 1024 * 1024;
const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
const CHUNKED_SERVERS_KEY = 'lomo_chunked_upload_servers';

// lomod error bodies are {"id": "...", "text": "..."}
function parseErrorText(body) {
    try {
        return JSON.parse(body).text || '';
    } catch {
        return '';
    }
}

class UploadService {
    constructor() {
        this.activeTasks = new Map(); // assetId -> task
        this.activePromises = new Map(); // assetId -> promise
        this.cancelledTasks = new Set(); // assetId
        this.chunkedServers = null; // server URL -> piece size, loaded lazily from SecureStore
        // instance fields so integration tests can use small pieces
        this.chunkSize = CHUNK_SIZE;
        this.minChunkSize = MIN_CHUNK_SIZE;
    }

    async _loadChunkedServers() {
        if (this.chunkedServers) return this.chunkedServers;
        try {
            this.chunkedServers = JSON.parse(await SecureStore.getItemAsync(CHUNKED_SERVERS_KEY)) || {};
        } catch {
            this.chunkedServers = {};
        }
        return this.chunkedServers;
    }

    /** Piece size to use for serverUrl, or 0 if it has never rejected a request as too large. */
    async getChunkSize(serverUrl) {
        const servers = await this._loadChunkedServers();
        return servers[serverUrl] || 0;
    }

    async _rememberChunkSize(serverUrl, size) {
        const servers = await this._loadChunkedServers();
        if (servers[serverUrl] === size) return;
        servers[serverUrl] = size;
        console.log(`[UploadService] ${serverUrl} limits request size; uploading large files in ${size} byte pieces from now on.`);
        try {
            await SecureStore.setItemAsync(CHUNKED_SERVERS_KEY, JSON.stringify(servers));
        } catch (e) {
            console.warn('[UploadService] Failed to persist chunked upload setting:', e.message);
        }
    }

    _sessionType(serverUrl) {
        // iOS background URL sessions strictly require HTTPS, even with NSAllowsLocalNetworking.
        // Plain HTTP (LAN server) silently fails with Network Error.
        // We must fallback to FOREGROUND session on iOS for plain HTTP.
        const isHttps = serverUrl.toLowerCase().startsWith('https://');
        return Platform.OS === 'ios' && !isHttps
            ? (FileSystem.FileSystemSessionType?.FOREGROUND ?? 1)
            // eslint-disable-next-line import/namespace -- FileSystemUploadSessionType is an older expo-file-system export name kept as a fallback for SDK version differences
            : (FileSystem.FileSystemSessionType?.BACKGROUND ?? FileSystem.FileSystemUploadSessionType?.BACKGROUND ?? 0);
    }

    /** Sends fileUri as the whole request body; resolves to the native upload response. */
    async _send({ assetId, url, fileUri, method, token, headers = {}, onSent }) {
        const task = FileSystem.createUploadTask(
            url,
            fileUri,
            {
                httpMethod: method,
                headers: {
                    'Authorization': `token=${token}`,
                    'Content-Type': 'application/octet-stream',
                    ...headers,
                },
                sessionType: this._sessionType(url),
                uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
                mimeType: 'application/octet-stream',
            },
            (progress) => onSent && onSent(progress.totalBytesSent, progress.totalBytesExpectedToSend)
        );
        this.activeTasks.set(assetId, task);
        if (this.cancelledTasks.has(assetId)) {
            task.cancelAsync().catch(()=>{});
            throw new Error('Upload cancelled by user');
        }
        try {
            return await task.uploadAsync();
        } finally {
            this.activeTasks.delete(assetId);
        }
    }

    /**
     * Uploads uri in pieces of at most chunkSize bytes, starting at startOffset (with ifMatch
     * from HEAD when the server already holds part of the file). lomod answers every piece but
     * the last with 400 "different hash" and keeps the partial file; HEAD then reports its new
     * size. A piece that still gets 413 is retried at half the size.
     */
    async _chunkedUpload({ assetId, uri, hash, uploadUrl, token, fileSize, chunkSize, startOffset = 0, ifMatch = null, onProgress }) {
        const serverUrl = AuthService.getServerUrl();
        const tempChunkDir = FileSystem.cacheDirectory + 'lomorage_chunks/';
        await FileSystem.makeDirectoryAsync(tempChunkDir, { intermediates: true }).catch(()=>{});
        const pieceUri = tempChunkDir + `piece_${String(assetId).replace(/[^a-zA-Z0-9]/g, '')}_${hash}.tmp`;

        let offset = startOffset;
        try {
            while (offset < fileSize) {
                if (this.cancelledTasks.has(assetId)) throw new Error('Upload cancelled by user');
                const length = Math.min(chunkSize, fileSize - offset);
                const isLast = offset + length >= fileSize;
                await sliceFileRangeAsync(uri, pieceUri, offset, length);
                console.log(`[UploadService] Uploading bytes ${offset}-${offset + length} of ${fileSize} for ${hash}`);

                const pieceStart = offset;
                const response = await this._send({
                    assetId, url: uploadUrl, fileUri: pieceUri, token,
                    method: offset === 0 ? 'POST' : 'PATCH',
                    headers: offset === 0 ? {} : { 'If-Match': ifMatch },
                    onSent: (sent) => onProgress && onProgress({
                        fraction: Math.min(1, (pieceStart + sent) / fileSize),
                        loaded: pieceStart + sent,
                        total: fileSize,
                    }),
                });

                if (response.status === 200 || response.status === 201 || response.status === 409) {
                    if (onProgress) onProgress({ fraction: 1, loaded: fileSize, total: fileSize });
                    return { success: true, hash, chunked: true };
                }
                if (response.status === 413) {
                    if (chunkSize <= this.minChunkSize) {
                        throw new Error(`Server rejects uploads even in ${chunkSize} byte pieces (HTTP 413).`);
                    }
                    chunkSize = Math.max(this.minChunkSize, Math.floor(chunkSize / 2));
                    await this._rememberChunkSize(serverUrl, chunkSize);
                    continue;
                }
                const errorText = parseErrorText(response.body) || `Server returned ${response.status}`;
                if (response.status !== 400 || !errorText.includes('different hash') || isLast) {
                    const err = new Error(errorText);
                    err.isDifferentHash = errorText.includes('different hash');
                    throw err;
                }

                // Piece stored; ask the server where it stands before sending the next one.
                const status = await this.checkUploadStatus(hash);
                if (status.exists) return { success: true, hash, chunked: true };
                if (!status.resumable || !status.ifMatch || status.receivedBytes <= offset || status.receivedBytes > fileSize) {
                    throw new Error(`Server did not keep the uploaded piece (has ${status.receivedBytes || 0} of ${fileSize} bytes).`);
                }
                offset = status.receivedBytes;
                ifMatch = status.ifMatch;
            }
            throw new Error(`Upload of ${hash} ended without the server confirming it.`);
        } finally {
            await FileSystem.deleteAsync(pieceUri, { idempotent: true }).catch(()=>{});
        }
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
                timeout: 60000, // 60s: for a partially uploaded asset the backend SHA1-hashes the partial file to report resume state, which can take > 5s for large videos on ARM NAS (a complete asset is just a DB lookup)
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
     * Slices the remaining part of the file natively and uploads it in a single PATCH request.
     */
    async _resumeUpload({ assetId, uri, hash, uploadUrl, token, receivedBytes, ifMatch, fileSize, onProgress }) {
        this.cancelledTasks.delete(assetId);

        const tempChunkDir = FileSystem.cacheDirectory + 'lomorage_chunks/';
        await FileSystem.makeDirectoryAsync(tempChunkDir, { intermediates: true }).catch(()=>{});
        const tempSliceUri = tempChunkDir + `slice_${assetId}_${hash}.tmp`;

        try {
            console.log(`[UploadService] Slicing remaining bytes natively starting from ${receivedBytes}...`);
            await sliceFileAsync(uri, tempSliceUri, receivedBytes);

            console.log(`[UploadService] Initiating native PATCH upload of the remaining slice...`);
            const response = await this._send({
                assetId, url: uploadUrl, fileUri: tempSliceUri, token, method: 'PATCH',
                headers: { 'If-Match': ifMatch },
                onSent: (sent) => {
                    if (onProgress && fileSize > 0) {
                        const totalSent = receivedBytes + sent;
                        onProgress({
                            fraction: Math.min(1, totalSent / fileSize),
                            loaded: totalSent,
                            total: fileSize
                        });
                    }
                },
            });

            if (response.status === 200 || response.status === 201 || response.status === 409) {
                if (onProgress) onProgress({ fraction: 1, loaded: fileSize, total: fileSize });
                console.log(`[UploadService] Resumed upload completed for ${hash}`);
                return { success: true, hash, resumed: true };
            }
            if (response.status === 413) {
                return { tooLarge: true };
            }
            throw new Error(`Server returned ${response.status} on partial upload patch.`);

        } finally {
            await FileSystem.deleteAsync(tempSliceUri, { idempotent: true }).catch(()=>{});
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
            const info = await MediaService.getAssetInfo(asset.id, { shouldDownloadFromNetwork: true });
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

            // Save the hash for retry and comparison, but keep it pending until the
            // server confirms the asset. Marking it uploaded here can hide a failed
            // upload from the next background scan.
            try {
                const SyncService = require('./SyncService').default;
                await SyncService.loadLocalHashCache();
                SyncService.localHashCache[asset.id] = {
                    hash,
                    modificationTime: asset.modificationTime,
                    filename: info.filename || 'unknown',
                    uploaded: false
                };
                const AssetDBService = require('./AssetDBService').default;
                await AssetDBService.updateAssetHash(asset.id, hash, asset.modificationTime);
            } catch (cacheErr) {
                console.warn('[UploadService] Failed to save hash to cache:', cacheErr.message);
            }

            const markUploaded = async () => {
                try {
                    const SyncService = require('./SyncService').default;
                    const AssetDBService = require('./AssetDBService').default;
                    const cached = SyncService.localHashCache[asset.id] || {};
                    SyncService.localHashCache[asset.id] = {
                        ...cached,
                        hash,
                        modificationTime: asset.modificationTime,
                        filename: info.filename || cached.filename || 'unknown',
                        uploaded: true
                    };
                    await AssetDBService.markAssetUploaded(asset.id, fileSizeBytes);
                } catch (cacheErr) {
                    console.warn('[UploadService] Failed to mark confirmed upload in cache:', cacheErr.message);
                }
            };

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
                await markUploaded();
                if (tempFileToClean) await FileSystem.deleteAsync(tempFileToClean, { idempotent: true }).catch(()=>{});
                return { success: true, duplicate: true, hash };
            }

            // 5. Construct Upload URL with metadata
            const ext = livePhotoBackup ? 'zip' : (info.filename || 'file.jpg').split('.').pop().toLowerCase();
            const creationTime = new Date(info.creationTime || Date.now()).toISOString();
            const uploadUrl = `${serverUrl}/asset/${hash.toLowerCase()}?ext=${ext}&createtime=${encodeURIComponent(creationTime)}`;

            const finish = async (result) => {
                if (result.success) await markUploaded();
                if (tempFileToClean) await FileSystem.deleteAsync(tempFileToClean, { idempotent: true }).catch(()=>{});
                return result;
            };
            const uploadInPieces = (chunkSize, startOffset = 0, ifMatch = null) => {
                if (fileSizeBytes === 0) {
                    throw new Error('Cannot upload in pieces because exact local file size could not be determined.');
                }
                return this._chunkedUpload({
                    assetId: asset.id, uri, hash, uploadUrl, token, fileSize: fileSizeBytes,
                    chunkSize, startOffset, ifMatch, onProgress,
                });
            };
            // A server that rejected a large request before gets large files in pieces right away.
            const knownChunkSize = await this.getChunkSize(serverUrl);

            // 6. Attempt resumable upload if server has partial data (skip for Live Photo zips since recreated zip bytes can differ)
            if (status.resumable && status.receivedBytes > 0 && status.ifMatch && !livePhotoBackup) {
                if (fileSizeBytes === 0) {
                    throw new Error('Cannot safely resume upload because exact local file size could not be determined. Aborting to prevent server data corruption.');
                }
                if (knownChunkSize > 0 && fileSizeBytes - status.receivedBytes > knownChunkSize) {
                    return finish({ ...(await uploadInPieces(knownChunkSize, status.receivedBytes, status.ifMatch)), resumed: true });
                }
                const resumeResult = await this._resumeUpload({
                    assetId: asset.id, uri, hash, uploadUrl, token,
                    receivedBytes: status.receivedBytes,
                    ifMatch: status.ifMatch,
                    fileSize: fileSizeBytes,
                    onProgress,
                });
                if (resumeResult.tooLarge) {
                    await this._rememberChunkSize(serverUrl, this.chunkSize);
                    return finish({ ...(await uploadInPieces(this.chunkSize, status.receivedBytes, status.ifMatch)), resumed: true });
                }
                return finish(resumeResult);
            }

            if (knownChunkSize > 0 && fileSizeBytes > knownChunkSize) {
                console.log(`[UploadService] Uploading ${fileSizeBytes} bytes in pieces of ${knownChunkSize} to ${uploadUrl}`);
                return finish(await uploadInPieces(knownChunkSize));
            }

            console.log(`[UploadService] Full upload to: ${uploadUrl} (${fileSizeBytes} bytes)`);

            // 7. Full binary Upload using native session
            this.cancelledTasks.delete(asset.id);
            const response = await this._send({
                assetId: asset.id, url: uploadUrl, fileUri: uri, token, method: 'POST',
                onSent: (sent, expected) => {
                    if (onProgress) {
                        onProgress({
                            fraction: fileSizeBytes > 0 ? sent / fileSizeBytes : 0,
                            loaded: sent,
                            total: fileSizeBytes > 0 ? fileSizeBytes : expected
                        });
                    }
                },
            });

            if (response.status === 413) {
                // A proxy (e.g. Cloudflare's 100 MiB limit) refused the whole file; lomod never saw it.
                console.log(`[UploadService] ${uploadUrl} answered 413 for ${fileSizeBytes} bytes, retrying in pieces.`);
                await this._rememberChunkSize(serverUrl, this.chunkSize);
                return finish(await uploadInPieces(this.chunkSize));
            }

            if (response.status === 200 || response.status === 201 || response.status === 409) {
                await markUploaded();
                console.log(`[UploadService] Full upload completed for ${hash} (HTTP ${response.status}).`);
                if (tempFileToClean) await FileSystem.deleteAsync(tempFileToClean, { idempotent: true }).catch(()=>{});
                return { success: true, hash };
            } else {
                const errorMsg = parseErrorText(response.body) || `Server returned ${response.status}`;
                // Server returns UNIQUE constraint when a concurrent upload already saved it
                const isDuplicate = errorMsg.includes('UNIQUE constraint failed');
                // Server returns 'different hash' when iOS re-encodes the file between
                // hashing and uploading (HEIC auto-conversion, EXIF rewrite, iCloud sync, etc.)
                const isDifferentHash = errorMsg.includes('different hash');
                if (isDuplicate) {
                    console.warn(`[UploadService] Concurrent duplicate detected for ${hash}, treating as success.`);
                    await markUploaded();
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

