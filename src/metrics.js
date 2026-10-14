'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');

/** What the app uses when the dashboard is off: every call does nothing. */
const NOOP_METRICS = Object.freeze({ enabled: false, time() {}, count() {}, gauge() {} });

// Each render gets its own context, so TMDB calls made on its behalf can be attributed to it
// (including calls made inside the render limiter, see util.createLimiter).
const renderContext = new AsyncLocalStorage();

/** Total length of the union of [start, end] intervals (overlapping waits are only counted once). */
function unionMs(intervals) {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let curStart = null;
    let curEnd = null;
    for (const [start, end] of sorted) {
        if (curEnd === null || start > curEnd) {
            if (curEnd !== null) total += curEnd - curStart;
            curStart = start;
            curEnd = end;
        } else if (end > curEnd) {
            curEnd = end;
        }
    }
    if (curEnd !== null) total += curEnd - curStart;
    return total;
}

/** Same client, but every call is timed ("tmdb.api" for JSON lookups, "tmdb.image" for downloads). */
function instrumentTmdb(tmdb, metrics) {
    if (!metrics.enabled) return tmdb;
    const timed = (name, fn) => async (...args) => {
        const start = performance.now();
        try {
            return await fn(...args);
        } finally {
            const end = performance.now();
            metrics.time(name, end - start);
            renderContext.getStore()?.intervals.push([start, end]);
        }
    };
    return { ...tmdb, json: timed('tmdb.api', tmdb.json), image: timed('tmdb.image', tmdb.image) };
}

/**
 * Same artwork renderer, but each render is split into time spent waiting on TMDB and everything else
 * (waiting for a free render slot + sharp compositing and encoding), and the number of renders in flight is tracked.
 */
function instrumentArtwork(artwork, metrics) {
    if (!metrics.enabled) return artwork;
    let inFlight = 0;
    return {
        ...artwork,
        async render(params) {
            const context = { intervals: [] };
            const start = performance.now();
            inFlight += 1;
            metrics.gauge('render.inFlight', inFlight);
            try {
                return await renderContext.run(context, () => artwork.render(params));
            } finally {
                inFlight -= 1;
                const total = performance.now() - start;
                const tmdbWait = Math.min(total, unionMs(context.intervals));
                metrics.time('render.total', total);
                metrics.time('render.tmdb', tmdbWait);
                metrics.time('render.local', total - tmdbWait);
            }
        },
    };
}

module.exports = { NOOP_METRICS, instrumentTmdb, instrumentArtwork, unionMs };
