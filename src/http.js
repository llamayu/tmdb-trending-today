'use strict';
const { normalizeTag } = require('./tags');

// ─── Validation ──────────────────────────────────────────────────────────────
// Everything that arrives in a URL is checked here before it can reach TMDB, a cache key or an SVG.

/** TMDB id, or null. */
const parseId = (v) => (typeof v === 'string' && /^\d{1,9}$/.test(v) ? v : null);
/** Unknown types behave like movies (as before). */
const parseType = (v) => (v === 'series' ? 'series' : 'movie');
const parseRank = (v) => {
    if (typeof v !== 'string' || !/^\d{1,3}$/.test(v)) return 'none';
    const n = Number(v);
    return n > 0 ? String(n) : 'none';
};
const parseLang = (v) => (typeof v === 'string' && /^(null|[a-z]{2,3})$/.test(v) ? v : 'en');

/** Query string -> validated artwork parameters. */
function parseImageQuery(query = {}) {
    return {
        type: parseType(query.type),
        tag: normalizeTag(query.tag),
        rank: parseRank(query.rank),
        lang: parseLang(query.lang),
        logos: query.logos === '1',
        textless: query.textless === '1',
        titleStyle: query.titleStyle === 'gradient-v9' ? 'gradient-v9' : undefined,
    };
}

/** URL extension -> format. `.png` URLs keep returning PNG, so existing installs and saved patterns are unaffected. */
const IMAGE_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg' });
const ARTWORK_CACHE_VERSION = 'title-logo-svg-density-v6';

/** Cache / single-flight key: built from validated values only, so junk query params can't multiply cache entries. */
const imageKey = (kind, id, p) => [
    ARTWORK_CACHE_VERSION,
    kind,
    p.format,
    p.type,
    id,
    p.tag,
    p.rank,
    p.lang,
    p.logos ? 1 : 0,
    p.textless ? 1 : 0,
    p.titleStyle || '',
].join('|');

// ─── Express helpers ─────────────────────────────────────────────────────────

/** Express 4 doesn't catch rejected promises from async handlers; this forwards them to the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sendImage(res, buffer, format, maxAge = 86400) {
    res.set({ 'Content-Type': IMAGE_TYPES[format], 'Cache-Control': `public, max-age=${maxAge}` });
    res.send(buffer);
}

function errorHandler(logger = console) {
    // eslint-disable-next-line no-unused-vars
    return (err, req, res, next) => {
        if (res.headersSent) return next(err);
        const upstream = err?.name === 'TmdbError';
        const status = upstream ? (err.status === 404 ? 404 : 502) : 500;
        if (status !== 404) logger.error(`${req.method} ${String(req.originalUrl || '').split('?')[0]} failed:`, err?.message || err);
        res.set('Cache-Control', 'no-store');
        if (String(req.path || '').endsWith('.json')) {
            return res.status(status).json({ err: status === 404 ? 'Not found' : 'Internal Server Error' });
        }
        return res.status(status).type('text').send(status === 404 ? 'Not found' : 'Error generating image');
    };
}

module.exports = { IMAGE_TYPES, parseId, parseType, parseRank, parseLang, parseImageQuery, imageKey, wrap, sendImage, errorHandler };
