import axios from 'axios';

class NetworkQueue {
    constructor() {
        this.queue = [];
        this.activeCount = 0;
        this.MAX_CONCURRENT = 4;
        this.controllers = new Map(); // groupId -> AbortController
    }

    /**
     * Cancels all pending and in-flight requests for a given groupId.
     * @param {string} groupId 
     */
    cancelGroup(groupId) {
        if (!groupId) return;
        
        // 1. Abort in-flight requests
        if (this.controllers.has(groupId)) {
            const controller = this.controllers.get(groupId);
            controller.abort();
            this.controllers.delete(groupId);
        }
        
        // 2. Remove pending requests from the queue
        this.queue = this.queue.filter(item => {
            if (item.groupId === groupId) {
                item.reject(new axios.Cancel(`Request cancelled by group ${groupId}`));
                return false;
            }
            return true;
        });
    }

    _getController(groupId) {
        if (!groupId) return null;
        if (!this.controllers.has(groupId)) {
            this.controllers.set(groupId, new AbortController());
        }
        return this.controllers.get(groupId);
    }

    enqueue(config, resolve, reject) {
        const priority = config.priority ?? 2; // Default NORMAL priority
        const groupId = config.groupId;
        
        if (groupId) {
            const controller = this._getController(groupId);
            // Only assign if signal isn't manually set by the caller
            if (!config.signal) {
                config.signal = controller.signal;
            }
        }

        this.queue.push({ config, resolve, reject, priority, groupId });
        this._processQueue();
    }

    _processQueue() {
        // Sort queue by priority: lower number = higher priority
        this.queue.sort((a, b) => a.priority - b.priority);

        while (this.activeCount < this.MAX_CONCURRENT && this.queue.length > 0) {
            const item = this.queue.shift();
            
            // If the item was aborted while sitting in the queue, reject it immediately
            if (item.config.signal && item.config.signal.aborted) {
                item.reject(new axios.Cancel('Request aborted before dispatch'));
                continue;
            }

            this.activeCount++;
            item.resolve(item.config);
        }
    }

    onResponse() {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this._processQueue();
    }

    setupInterceptors(axiosInstance) {
        axiosInstance.interceptors.request.use((config) => {
            // Bypass queue for authentication or explicit skip
            if (config.skipQueue || config.url.includes('/login') || config.url.includes('/mount')) {
                return config;
            }
            
            return new Promise((resolve, reject) => {
                this.enqueue(config, resolve, reject);
            });
        }, (error) => {
            return Promise.reject(error);
        });

        axiosInstance.interceptors.response.use(
            (response) => {
                this.onResponse();
                return response;
            },
            (error) => {
                this.onResponse();
                return Promise.reject(error);
            }
        );
    }
}

export default new NetworkQueue();
