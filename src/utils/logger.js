import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import JSZip from 'jszip';
import { DeviceEventEmitter } from 'react-native';

const LOG_FILE_PATH = FileSystem.cacheDirectory + 'lomorage_app.log';
const MAX_LOG_LINES = 5000;
const FLUSH_INTERVAL_MS = 5000;
const ROTATE_THRESHOLD_BYTES = 2 * 1024 * 1024; // fold the file back down once it passes this size

class Logger {
    constructor() {
        this.logBuffer = []; // recent lines kept in memory (capped) for the debug overlay
        this.pendingLines = []; // lines written since the last successful disk flush
        this.originalConsole = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            debug: console.debug,
        };
        this.flushTimer = null;
        this.isFlushing = false;
        this.hasNewLogs = false;
        this._logFile = null;
    }

    _getLogFile() {
        if (!this._logFile) {
            this._logFile = new File(LOG_FILE_PATH);
        }
        return this._logFile;
    }

    init() {
        const createLogger = (level, originalMethod) => {
            return (...args) => {
                // Call the original console method so we still see it in the terminal
                originalMethod.apply(console, args);

                // Format the log
                const timestamp = new Date().toISOString();
                const formattedArgs = args.map(arg => {
                    if (typeof arg === 'object') {
                        try {
                            return JSON.stringify(arg);
                        } catch (e) {
                            return String(arg);
                        }
                    }
                    return String(arg);
                }).join(' ');

                const logLine = `[${timestamp}] [${level}] ${formattedArgs}`;

                // Keep a capped in-memory window (for the debug overlay), independent of
                // what's pending for disk — this never grows past MAX_LOG_LINES.
                this.logBuffer.push(logLine);
                if (this.logBuffer.length > MAX_LOG_LINES) {
                    // Remove oldest 100 lines at once for performance
                    this.logBuffer.splice(0, 100);
                }

                this.pendingLines.push(logLine);
                this.hasNewLogs = true;

                // Emit to React Native listeners (e.g. for debug overlay)
                DeviceEventEmitter.emit('app_debug_log', logLine);
            };
        };

        console.log = createLogger('INFO', this.originalConsole.log);
        console.warn = createLogger('WARN', this.originalConsole.warn);
        console.error = createLogger('ERROR', this.originalConsole.error);
        console.debug = createLogger('DEBUG', this.originalConsole.debug || this.originalConsole.log);

        console.log('[Logger] Initialized and capturing logs.');

        // Catch uncaught JS exceptions (these cause the app to quit silently without this).
        // ErrorUtils is the React Native global crash handler — setting it here means any
        // unhandled throw anywhere in JS will be written to the log file before the process exits.
        const previousHandler = global.ErrorUtils?.getGlobalHandler?.();
        global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
            const tag = isFatal ? 'FATAL' : 'ERROR';
            const msg = `[${tag}] Uncaught JS exception: ${error?.message}\n${error?.stack || ''}`;
            this.pendingLines.push(`[${new Date().toISOString()}] [${tag}] ${msg}`);
            this.hasNewLogs = true;
            // Flush immediately — the normal 5s timer may never fire after a fatal crash.
            this._flushToDisk();
            // Propagate to previous handler (shows red screen in dev, terminates in prod).
            previousHandler?.(error, isFatal);
        });

        // Catch unhandled promise rejections (silent crashes from async code).
        global.addEventListener?.('unhandledrejection', (event) => {
            const reason = event?.reason;
            const msg = reason instanceof Error
                ? `${reason.message}\n${reason.stack || ''}`
                : String(reason);
            console.error(`[Logger] Unhandled promise rejection: ${msg}`);
        });

        // Start periodic flush
        this.flushTimer = setInterval(() => {
            this._flushToDisk();
        }, FLUSH_INTERVAL_MS);
    }

    async _flushToDisk() {
        if (!this.hasNewLogs || this.isFlushing || this.pendingLines.length === 0) return;
        this.isFlushing = true;
        this.hasNewLogs = false;

        const linesToFlush = this.pendingLines;
        this.pendingLines = [];

        try {
            const file = this._getLogFile();
            if (!file.exists) {
                file.create();
            }

            // True append: seek the handle to end-of-file and write only the new
            // lines, instead of re-serializing and rewriting the whole log every
            // cycle (that used to redo the same disk write over and over as the
            // buffer grew, which adds up fast during a long photo sync).
            const chunk = linesToFlush.join('\n') + '\n';
            const handle = file.open();
            try {
                handle.offset = handle.size;
                handle.writeBytes(new TextEncoder().encode(chunk));
            } finally {
                handle.close();
            }

            this._rotateIfNeeded(file);
        } catch (e) {
            // Put the lines back so nothing is lost — retry on the next flush.
            this.pendingLines = linesToFlush.concat(this.pendingLines);
            this.hasNewLogs = true;
            this.originalConsole.error('[Logger] Failed to flush logs to disk:', e);
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * Appending never shrinks the file, so periodically fold it back down to the
     * newest lines once it passes ROTATE_THRESHOLD_BYTES. This full rewrite is the
     * expensive operation the old flush used to pay on every 5s tick — now it only
     * happens once every couple of MB of logs.
     */
    _rotateIfNeeded(file) {
        try {
            const info = file.info();
            if (!info.size || info.size < ROTATE_THRESHOLD_BYTES) return;
            const lines = file.textSync().split('\n').filter(Boolean);
            const trimmed = lines.slice(-MAX_LOG_LINES).join('\n') + '\n';
            file.write(trimmed);
        } catch (e) {
            this.originalConsole.error('[Logger] Failed to rotate log file:', e);
        }
    }

    /**
     * Downloads the server logs, bundles them with the local client logs in a ZIP,
     * and presents the native Share Sheet.
     */
    async exportLogs(serverUrl, token) {
        try {
            // Force flush first
            await this._flushToDisk();

            const zip = new JSZip();

            // 1. Add Local Client Log
            try {
                const localLogExists = await FileSystem.getInfoAsync(LOG_FILE_PATH);
                if (localLogExists.exists) {
                    const localLogData = await FileSystem.readAsStringAsync(LOG_FILE_PATH, { encoding: 'utf8' });
                    zip.file('lomorage_app.log', localLogData);
                } else {
                    zip.file('lomorage_app.log', 'No local logs found.');
                }
            } catch (e) {
                zip.file('lomorage_app.log', `Error reading local logs: ${e.message}`);
            }

            // 2. Download Server Log
            let serverLogDownloaded = false;
            if (serverUrl && token) {
                try {
                    const downloadUrl = `${serverUrl.replace(/\/$/, '')}/log`;
                    const tempServerLogPath = FileSystem.cacheDirectory + 'lomod.tar.gz';

                    const downloadResult = await FileSystem.downloadAsync(
                        downloadUrl,
                        tempServerLogPath,
                        {
                            headers: {
                                'Authorization': `token=${token}`
                            }
                        }
                    );

                    if (downloadResult.status === 200) {
                        const serverLogData = await FileSystem.readAsStringAsync(tempServerLogPath, { encoding: 'base64' });
                        zip.file('lomod.tar.gz', serverLogData, { base64: true });
                        serverLogDownloaded = true;
                    } else {
                        zip.file('server_log_error.txt', `Server returned status ${downloadResult.status}`);
                    }
                } catch (e) {
                    zip.file('server_log_error.txt', `Error downloading server logs: ${e.message}`);
                }
            } else {
                 zip.file('server_log_warning.txt', 'No server URL or token provided. Not connected?');
            }

            // 3. Generate ZIP
            const zipBase64 = await zip.generateAsync({ type: 'base64' });

            // 4. Save ZIP to file
            const zipPath = FileSystem.cacheDirectory + 'lomolog.zip';
            await FileSystem.writeAsStringAsync(zipPath, zipBase64, { encoding: 'base64' });

            // 5. Share
            const isAvailable = await Sharing.isAvailableAsync();
            if (isAvailable) {
                await Sharing.shareAsync(zipPath, {
                    mimeType: 'application/zip',
                    dialogTitle: 'Share Lomorage Logs',
                    UTI: 'public.zip-archive'
                });
            } else {
                throw new Error("Sharing is not available on this device.");
            }

            return { success: true, serverLogIncluded: serverLogDownloaded };

        } catch (error) {
            this.originalConsole.error('[Logger] exportLogs failed:', error);
            throw error;
        }
    }
}

export default new Logger();
