'use strict';
const { createSingleFlight, MemoryCache } = require('../util');
const { parseListLang } = require('../userConfig');
const { normalizeTag } = require('../tags');
const { NOOP_METRICS } = require('../metrics');
const { IMAGE_TYPES, parseId, parseType, parseLang, parseImageQuery, imageKey, itemGroup, imageGroup, wrap, sendImage } = require('../http');

const REDIRECT_TTL_MS = 6 * 3_600_000;

function registerImageRoutes(app, { store, artwork, trending, tags, logger = console, metrics = NOOP_METRICS }) {
    // Concurrent requests for the same image share one render
    const flights = createSingleFlight();
    // Titles that need nothing drawn are answered with a redirect to TMDB. Remember those answers for a while so a
    // repeat request skips the disk lookup and the two TMDB lookups (the client is told to cache them for a day anyway).
    const redirects = new MemoryCache({ ttlMs: REDIRECT_TTL_MS, maxEntries: 20_000 });

    // ── /poster/:id.(png|jpg) and /backdrop/:id.(png|jpg) ───────────────────
    // The extension picks the format. Old `.png` URLs keep returning PNG; new URLs are `.jpg` (much smaller).
    const serveArtwork = (kind, format) => wrap(async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).type('text').send('Invalid id');

        const params = { kind, id, format, ...parseImageQuery(req.query) };
        const key = imageKey(kind, id, params);

        const knownRedirect = redirects.get(key);
        if (knownRedirect) {
            metrics.count('artwork.redirectCached');
            res.set('Cache-Control', 'public, max-age=86400');
            return res.redirect(302, knownRedirect);
        }

        const readStart = Date.now();
        const cached = await store.get(key, format);
        metrics.time('store.read', Date.now() - readStart);
        if (cached) {
            metrics.count('artwork.hit');
            return sendImage(res, cached, format);
        }

        const result = await flights.run(key, async () => {
            const rendered = await artwork.render(params);
            metrics.count(`artwork.${rendered.kind}`); // image (freshly drawn) | redirect | placeholder
            if (rendered.kind === 'image') store.set(key, rendered.buffer, format); // fire-and-forget; set() never rejects
            if (rendered.kind === 'redirect') redirects.set(key, rendered.url);
            return rendered;
        });

        switch (result.kind) {
            case 'redirect': // nothing to draw: send the client straight to TMDB's copy (302: the "best" image can change)
                res.set('Cache-Control', 'public, max-age=86400');
                return res.redirect(302, result.url);
            case 'placeholder': // no image on TMDB (yet): short cache so a later upload gets picked up
                return sendImage(res, result.buffer, format, 3600);
            default:
                return sendImage(res, result.buffer, format);
        }
    });

    for (const format of Object.keys(IMAGE_TYPES)) {
        app.get(`/poster/:id.${format}`, serveArtwork('poster', format));
        app.get(`/backdrop/:id.${format}`, serveArtwork('backdrop', format));
    }

    // ── Old URL shapes still found in existing installs ─────────────────────
    for (const [prefix, target] of [['proxy-image-backdrop', 'backdrop'], ['proxy-image-poster', 'poster']]) {
        app.get(`/${prefix}/:type/:id/:tag/:rank/:lang/:logos.png`, (req, res) => {
            const { type, id, tag, rank, lang, logos } = req.params;
            const query = new URLSearchParams({ type, tag, rank: rank || 'none', lang, logos: logos || '0' });
            res.redirect(301, `/${target}/${encodeURIComponent(id)}.png?${query}`);
        });
    }

    // ── /image/:type/:id.(png|jpg) and /landscape/:type/:id.(png|jpg) (AIOMetadata URL patterns) ─────────
    // The tag and rank are worked out here, then the client is sent to the real image URL (same extension).
    const redirectPattern = (target, format) => wrap(async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).type('text').send('Invalid id');

        const known = req.params.type === 'movie' || req.params.type === 'series';
        const type = parseType(req.params.type);
        const q = req.query;

        let tag;
        if (typeof q.tag === 'string' && q.tag !== '' && q.tag !== 'auto') tag = normalizeTag(q.tag);
        else if (!known) tag = 'none';
        else tag = type === 'movie' ? await tags.movieTag(id) : await tags.seriesTag(id);

        let rank = 'none';
        if (q.ranked === '1' || q.ranked === 'true') {
            try {
                rank = await trending.rankOf({ type, id, langs: parseListLang(q.listLang), digitalOnly: q.digitalOnly !== '0' });
            } catch (err) {
                logger.error(`Failed to determine rank for ${type}/${id}:`, err.message);
            }
        }

        const query = new URLSearchParams({ type, tag, rank, lang: parseLang(q.lang), logos: q.logos === '1' ? '1' : '0' });
        if (q.textless === '1') query.set('textless', '1');
        if (target === 'backdrop' || q.textless === '1') query.set('titleStyle', 'gradient-v9');
        res.set('Cache-Control', 'public, max-age=300'); // tags change by the day, not the minute
        res.redirect(302, `/${target}/${id}.${format}?${query}`);
    });

    for (const format of Object.keys(IMAGE_TYPES)) {
        app.get(`/image/:type/:id.${format}`, redirectPattern('poster', format));
        app.get(`/landscape/:type/:id.${format}`, redirectPattern('backdrop', format));
    }

    /** Clear everything cached for one title, so its images are drawn again on the next request. */
    async function invalidate(type, id) {
        const group = itemGroup(type, id);
        const remembered = redirects.deleteWhere((key) => imageGroup(key) === group);
        const { memory, disk } = await store.invalidate(group);
        return { images: Math.max(memory, disk), remembered };
    }
    return { invalidate };
}

module.exports = { registerImageRoutes };
