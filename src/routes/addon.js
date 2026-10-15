'use strict';
const { parseConfigSegment } = require('../userConfig');
const { wrap } = require('../http');
const { CATALOG_CACHE_SECONDS, configuredManifestId } = require('../catalog');

const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="red" x2="0" y2="1"><stop stop-color="#c9272d"/><stop offset="1" stop-color="#a71920"/></linearGradient><linearGradient id="edge" x2="1"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".42"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect x="2" y="2" width="96" height="96" rx="23" fill="url(#red)" stroke="#fff" stroke-opacity=".12" stroke-width="1.5"/><path d="M17 3.5h66" fill="none" stroke="url(#edge)" stroke-width="1.5" stroke-linecap="round"/><path d="M25 70l15-25 15 15 20-30" fill="none" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><path d="M55 30h20v20" fill="none" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * @param app       Express app (only `.get` is used)
 * @param manifest  the addon manifest
 * @param addonInterface  result of stremio-addon-sdk's `builder.getInterface()`
 * @param configHtml      the configure page, already personalised with the addon URL
 */
function registerAddonRoutes(app, { manifest, addonInterface, configHtml, addonUrl }) {
    // ── Configure UI ────────────────────────────────────────────────────────
    const serveConfig = (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.send(configHtml);
    };
    app.get('/', serveConfig);
    app.get('/configure', serveConfig);
    app.get('/:config/configure', serveConfig);

    app.get('/favicon.svg', (req, res) => {
        res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(FAVICON_SVG);
    });
    app.get('/healthz', (req, res) => res.type('text').send('ok'));

    // ── Manifest ────────────────────────────────────────────────────────────
    app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
    app.get('/:config/manifest.json', (req, res) => {
        const configured = JSON.parse(JSON.stringify(addonInterface.manifest));
        configured.id = configuredManifestId(parseConfigSegment(req.params.config));
        if (configured.behaviorHints) {
            configured.behaviorHints.configurationRequired = false;
            configured.behaviorHints.configurationURL = `${addonUrl}/${req.params.config}/configure`;
        }
        res.json(configured);
    });

    // ── Catalogs ────────────────────────────────────────────────────────────
    const known = new Set(manifest.catalogs.map((c) => `${c.type}/${c.id}`));

    const catalog = (withConfig) => wrap(async (req, res) => {
        const { type, id } = req.params;
        if (!known.has(`${type}/${id}`)) return res.status(404).json({ err: 'Not found' });
        const config = withConfig ? parseConfigSegment(req.params.config) : {};
        const body = await addonInterface.get('catalog', type, id, { config });
        res.set('Cache-Control', `public, max-age=${CATALOG_CACHE_SECONDS}, stale-while-revalidate=${CATALOG_CACHE_SECONDS * 2}, stale-if-error=86400`);
        res.json(body);
    });

    // The optional "extra" segment (e.g. skip=20) isn't used: each catalog is a single page
    app.get('/catalog/:type/:id.json', catalog(false));
    app.get('/catalog/:type/:id/:extra.json', catalog(false));
    app.get('/:config/catalog/:type/:id.json', catalog(true));
    app.get('/:config/catalog/:type/:id/:extra.json', catalog(true));
}

module.exports = { registerAddonRoutes, FAVICON_SVG };
