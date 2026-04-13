import Zeroconf from 'react-native-zeroconf';

class DiscoveryService {
    constructor() {
        this._zeroconf = null; // Lazy-init to avoid blocking module load
        this.isScanning = false;
        this.onDiscoveredCallbacks = new Set();
        this._scanPromise = null;
    }

    // Lazy getter - only creates Zeroconf when actually needed
    get zeroconf() {
        if (!this._zeroconf) {
            this._zeroconf = new Zeroconf();
        }
        return this._zeroconf;
    }

    /**
     * Scans for Lomorage services (_lomod._tcp) on the local network.
     * If a scan is already in progress, waits for it and returns its results.
     * @param {number} timeout - How long to scan in milliseconds (default 5s).
     * @returns {Promise<Array>} - List of discovered services.
     */
    scan(timeout = 5000) {
        if (this._scanPromise) {
            console.log('[DiscoveryService] Scan already in progress, queuing caller...');
            return this._scanPromise;
        }

        this._scanPromise = new Promise((resolve) => {
            const discovered = [];
            this.isScanning = true;

            const onResolved = (service) => {
                console.log('[DiscoveryService] Resolved:', service.name, service.host);
                if (service.host && service.port) {
                    const ip = (service.addresses && service.addresses.length > 0)
                        ? service.addresses[0]
                        : service.host;
                    const normalized = {
                        name: service.name,
                        address: `${ip}:${service.port}`,
                        host: service.host,
                        port: service.port,
                        fullUrl: `http://${ip}:${service.port}`
                    };
                    // Avoid duplicates if resolved fires twice for the same service
                    if (!discovered.find(d => d.name === normalized.name && d.fullUrl === normalized.fullUrl)) {
                        discovered.push(normalized);
                    }
                    this.onDiscoveredCallbacks.forEach(cb => cb(normalized));
                }
            };

            const onError = (err) => {
                console.warn('[DiscoveryService] Error:', err);
                cleanup();
                resolve(discovered);
            };

            const cleanup = () => {
                try {
                    this.zeroconf.removeListener('resolved', onResolved);
                    this.zeroconf.removeListener('error', onError);
                    this.zeroconf.stop();
                } catch (e) {
                    console.warn('[DiscoveryService] Error during cleanup:', e);
                }
                this.isScanning = false;
                this._scanPromise = null;
            };

            this.zeroconf.on('resolved', onResolved);
            this.zeroconf.on('error', onError);

            console.log('[DiscoveryService] Starting scan...');
            try {
                this.zeroconf.scan('lomod', 'tcp', 'local.');
            } catch (e) {
                console.warn('[DiscoveryService] Failed to start scan:', e);
                cleanup();
                resolve([]);
                return;
            }

            setTimeout(() => {
                if (this.isScanning) {
                    console.log(`[DiscoveryService] Scan complete. Found ${discovered.length} service(s).`);
                    cleanup();
                    resolve(discovered);
                }
            }, timeout);
        });

        return this._scanPromise;
    }

    /**
     * Subscribes to real-time discovery events during a scan.
     * Returns an unsubscribe function.
     */
    onDiscovered(callback) {
        this.onDiscoveredCallbacks.add(callback);
        return () => this.onDiscoveredCallbacks.delete(callback);
    }
}

export default new DiscoveryService();

