import logger from './logger';

class MetricsTracker {
    constructor() {
        this.metrics = {};
    }

    start(name) {
        this.metrics[name] = Date.now();
    }

    end(name, extraInfo = '') {
        if (this.metrics[name]) {
            const duration = Date.now() - this.metrics[name];
            console.log(`[Metrics] ${name} took ${duration}ms ${extraInfo}`);
            delete this.metrics[name];
            return duration;
        }
        return -1;
    }

    async measure(name, asyncFn, extraInfo = '') {
        const start = Date.now();
        try {
            return await asyncFn();
        } finally {
            const duration = Date.now() - start;
            console.log(`[Metrics] ${name} took ${duration}ms ${extraInfo}`);
        }
    }
    
    measureSync(name, fn, extraInfo = '') {
        const start = Date.now();
        try {
            return fn();
        } finally {
            const duration = Date.now() - start;
            console.log(`[Metrics] ${name} took ${duration}ms ${extraInfo}`);
        }
    }
}

export default new MetricsTracker();
