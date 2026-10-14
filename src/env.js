'use strict';
const path = require('path');

/**
 * Read and validate configuration once, at startup, so a typo shows up as a clear error
 * instead of as "undefined/favicon.svg" in the manifest and 401s from TMDB.
 */
function loadEnv(env = process.env) {
    const problems = [];

    const tmdbApiKey = (env.TMDB_API_KEY || '').trim();
    if (!tmdbApiKey) problems.push('TMDB_API_KEY is not set');

    const addonUrl = (env.ADDON_URL || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(addonUrl)) {
        problems.push('ADDON_URL must be an absolute http(s) URL, e.g. https://addon.example.com');
    }

    const imageFormat = (env.IMAGE_FORMAT || 'jpg').trim().toLowerCase();
    if (imageFormat !== 'jpg' && imageFormat !== 'png') problems.push('IMAGE_FORMAT must be "jpg" or "png"');

    // How long a rendered image stays cached. The URL carries every input (title, tag, rank, language...), so an image
    // never goes stale by itself; this only bounds how long a replaced TMDB poster or a moved streaming logo can linger.
    // 0 = expire at the next local midnight (the old behaviour).
    const imageCacheHours = env.IMAGE_CACHE_HOURS === undefined || String(env.IMAGE_CACHE_HOURS).trim() === '' ? 48 : Number(env.IMAGE_CACHE_HOURS);
    if (!Number.isFinite(imageCacheHours) || imageCacheHours < 0 || imageCacheHours > 24 * 30) {
        problems.push('IMAGE_CACHE_HOURS must be a number between 0 and 720 (0 = expire at local midnight)');
    }

    // Optional admin dashboard: set STATS_TOKEN to turn it on (collection and /admin both stay off without it)
    const statsToken = (env.STATS_TOKEN || '').trim();
    if (statsToken && statsToken.length < 16) problems.push('STATS_TOKEN must be at least 16 characters (or leave it empty to disable the dashboard)');

    if (problems.length) throw new Error(`Invalid environment:\n - ${problems.join('\n - ')}`);

    return {
        tmdbApiKey,
        addonUrl,
        port: Number(env.PORT) || 7000,
        // Same folder as before (next to server.js) unless CACHE_DIR points elsewhere, e.g. a Docker volume
        cacheDir: env.CACHE_DIR ? path.resolve(env.CACHE_DIR) : path.resolve(__dirname, '..', 'image-cache'),
        renderConcurrency: Number(env.RENDER_CONCURRENCY) || 4,
        // Format of the artwork URLs the catalog and configure page hand out. Both extensions are always served.
        imageFormat,
        imageCacheHours,
        statsToken,
        // Days in the dashboard roll over at midnight in this timezone (TZ, e.g. America/New_York); empty means UTC
        statsTimezone: (env.TZ || '').trim(),
        // Keep this on a Docker volume so the numbers survive redeploys
        statsDir: env.STATS_DIR ? path.resolve(env.STATS_DIR) : path.resolve(__dirname, '..', 'data'),
        // Country lookup loads a ~100 MB database into memory; STATS_GEO=0 turns it off
        statsGeo: !/^(0|false|off|no)$/i.test((env.STATS_GEO || '').trim()),
        // Whose X-Forwarded-For we believe: by default only private/loopback addresses (Caddy on the same host or Docker network)
        trustProxy: (env.TRUST_PROXY || 'loopback, linklocal, uniquelocal').trim(),
    };
}

module.exports = { loadEnv };
