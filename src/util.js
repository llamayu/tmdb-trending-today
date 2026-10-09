'use strict';

/** Run at most `max` async tasks at a time; the rest wait in a FIFO queue. */
function createLimiter(max) {
    let active = 0;
    const queue = [];
    const pump = () => {
        while (active < max && queue.length) {
            const { fn, resolve, reject } = queue.shift();
            active++;
            Promise.resolve()
                .then(fn)
                .then(resolve, reject)
                .finally(() => { active--; pump(); });
        }
    };
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

/** Callers asking for the same key while work is in progress share one promise instead of repeating the work. */
function createSingleFlight() {
    const inflight = new Map();
    return {
        run(key, fn) {
            let p = inflight.get(key);
            if (!p) {
                p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
                inflight.set(key, p);
            }
            return p;
        },
        get size() { return inflight.size; },
    };
}

/**
 * TTL + LRU cache with optional entry/byte caps.
 * `staleMs` keeps expired entries around so callers can fall back to them when the upstream is failing.
 */
class MemoryCache {
    constructor({ ttlMs, staleMs = 0, maxEntries = Infinity, maxBytes = Infinity, sizeOf = () => 0, now = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.staleMs = staleMs;
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.sizeOf = sizeOf;
        this.now = now;
        this.map = new Map();
        this.bytes = 0;
    }

    get size() { return this.map.size; }

    _drop(key) {
        const entry = this.map.get(key);
        if (entry) { this.bytes -= entry.size; this.map.delete(key); }
    }

    /** Fresh value, or undefined. Marks the entry as recently used. */
    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        const t = this.now();
        if (t >= entry.expires + this.staleMs) { this._drop(key); return undefined; }
        if (t >= entry.expires) return undefined;
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    /** Expired-but-still-inside-the-stale-window value, or undefined. */
    getStale(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (this.now() >= entry.expires + this.staleMs) { this._drop(key); return undefined; }
        return entry.value;
    }

    set(key, value, expires = this.now() + this.ttlMs) {
        this._drop(key);
        const size = this.sizeOf(value);
        if (size > this.maxBytes) return; // bigger than the whole budget: don't cache
        this.map.set(key, { value, size, expires });
        this.bytes += size;
        while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
            this._drop(this.map.keys().next().value);
        }
    }

    delete(key) { this._drop(key); }
}

/** Freeze recursively so accidental mutation of shared cached data throws (in strict mode) instead of corrupting other requests. */
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

module.exports = { createLimiter, createSingleFlight, MemoryCache, deepFreeze };
