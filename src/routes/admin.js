'use strict';
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const MAX_FAILURES = 10; // wrong tokens per IP per minute before we stop answering
const WINDOW_MS = 60_000;

/**
 * Hidden dashboard. The page itself carries no data; the numbers come from /admin/api/stats, which needs the token
 * (sent as a Bearer header, never in the URL, so it doesn't end up in access logs).
 * `invalidate(type, id)` clears everything cached for one title (see POST /admin/api/invalidate).
 */
function registerAdminRoutes(app, { stats, token, html, invalidate, logger = console, now = Date.now }) {
    const failures = new Map(); // ip -> { count, resetAt }
    const expected = sha(token);

    const noindex = (res) => res.set({
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
    });

    /** True when the request carries the right token; otherwise the response has been sent. */
    function authorize(req, res) {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const t = now();
        const entry = failures.get(ip);
        if (entry && entry.resetAt > t && entry.count >= MAX_FAILURES) {
            res.status(429).json({ err: 'Too many attempts' });
            return false;
        }
        const header = String(req.headers?.authorization || '');
        const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!given || !crypto.timingSafeEqual(sha(given), expected)) {
            const fresh = entry && entry.resetAt > t ? entry : { count: 0, resetAt: t + WINDOW_MS };
            fresh.count += 1;
            failures.set(ip, fresh);
            if (failures.size > 1000) for (const [k, v] of failures) if (v.resetAt <= t) failures.delete(k);
            res.status(401).json({ err: 'Unauthorized' });
            return false;
        }
        failures.delete(ip);
        return true;
    }

    app.get('/admin', (req, res) => {
        noindex(res);
        res.type('html').send(html);
    });

    app.get('/admin/api/stats', (req, res) => {
        noindex(res);
        if (!authorize(req, res)) return;
        res.json(stats.report(req.query?.days));
    });

    // POST /admin/api/invalidate?id=603&type=movie|series|both
    app.post('/admin/api/invalidate', async (req, res) => {
        noindex(res);
        if (!authorize(req, res)) return;
        if (typeof invalidate !== 'function') return res.status(501).json({ err: 'Not available' });

        const id = String(req.query?.id || '').trim();
        const type = String(req.query?.type || 'both');
        if (!/^[1-9]\d{0,8}$/.test(id)) return res.status(400).json({ err: 'Enter a TMDB id (digits only)' });
        if (!['movie', 'series', 'both'].includes(type)) return res.status(400).json({ err: 'Type must be movie, series or both' });

        try {
            const results = [];
            for (const t of type === 'both' ? ['movie', 'series'] : [type]) results.push(await invalidate(t, id));
            logger.log?.(`Admin cleared the cache for ${type} ${id}: ${results.map((r) => `${r.type} ${r.images} images, ${r.remembered} remembered, ${r.lookups} lookups`).join('; ')}`);
            return res.json({ ok: true, id, results });
        } catch (err) {
            logger.error?.(`Cache invalidation for ${type} ${id} failed:`, err.message);
            return res.status(500).json({ err: 'Could not clear the cache' });
        }
    });
}

module.exports = { registerAdminRoutes };
