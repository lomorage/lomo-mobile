import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import JSZip from 'jszip';

const LOG_FILE_PATH = FileSystem.cacheDirectory + 'lomorage_app.log';
const MAX_LOG_LINES = 5000;
const FLUSH_INTERVAL_MS = 5000;

class Logger {
    constructor() {
        this.logBuffer = [];
        this.originalConsole = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            debug: console.debug,
        };
        this.flushTimer = null;
        this.isFlushing = false;
        this.hasNewLogs = false;
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
                
                // Add to buffer
                this.logBuffer.push(logLine);
                
                // Enforce max lines to prevent memory leaks
                if (this.logBuffer.length > MAX_LOG_LINES) {
                    // Remove oldest 100 lines at once for performance
                    this.logBuffer.splice(0, 100);
                }

                this.hasNewLogs = true;
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
            this.logBuffer.push(`[${new Date().toISOString()}] [${tag}] ${msg}`);
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
        if (!this.hasNewLogs || this.isFlushing || this.logBuffer.length === 0) return;
        this.isFlushing = true;
        this.hasNewLogs = false;

        try {
            const logsText = this.logBuffer.join('\n');
            await FileSystem.writeAsStringAsync(LOG_FILE_PATH, logsText, { encoding: 'utf8' });
        } catch (e) {
            this.originalConsole.error('[Logger] Failed to flush logs to disk:', e);
        } finally {
            this.isFlushing = false;
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
