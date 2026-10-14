'use strict';
const fs = require('fs');
const path = require('path');

const { createTmdbClient } = require('./tmdb');
const { createTrending, createGenres, createTagResolver } = require('./media');
const { buildManifest, createCatalog } = require('./catalog');
const { createArtwork } = require('./artwork');
const { ImageStore } = require('./imageStore');
const { errorHandler, imageGroup } = require('./http');
const { registerAddonRoutes } = require('./routes/addon');
const { registerImageRoutes } = require('./routes/images');
const { registerAdminRoutes } = require('./routes/admin');
const { createStats } = require('./stats');
const { NOOP_METRICS, instrumentTmdb, instrumentArtwork } = require('./metrics');

/**
 * Build the Express app.
 * `deps` exists for tests: pass `express`, `sdk`, `tmdb`, `now` or `logger` to substitute the real ones.
 */
function createApp(env, deps = {}) {
    const express = deps.express || require('express');
    const { addonBuilder } = deps.sdk || require('stremio-addon-sdk');
    const logger = deps.logger || console;

    // Admin dashboard: only exists when STATS_TOKEN is set
    const stats = deps.stats || (env.statsToken
        ? createStats({ dir: env.statsDir, logger, renderConcurrency: env.renderConcurrency, timezone: env.statsTimezone, ...(env.statsGeo === false ? { geo: () => null } : {}) })
        : null);
    const metrics = stats ? stats.metrics : NOOP_METRICS;

    const tmdb = instrumentTmdb(deps.tmdb || createTmdbClient({ apiKey: env.tmdbApiKey, logger }), metrics);
    const genres = createGenres(tmdb, { logger });
    const trending = createTrending({ tmdb, now: deps.now });
    const tags = createTagResolver({ tmdb, now: deps.now, logger });
    const catalog = createCatalog({ tmdb, trending, tags, genres, addonUrl: env.addonUrl, imageExt: env.imageFormat || 'jpg' });
    const artwork = instrumentArtwork(createArtwork({ tmdb, concurrency: env.renderConcurrency, logger }), metrics);
    const store = new ImageStore({
        dir: env.cacheDir,
        // 0 hours keeps the old "expire at local midnight" behaviour
        ttlMs: env.imageCacheHours > 0 ? env.imageCacheHours * 3_600_000 : undefined,
        groupOf: imageGroup,
        logger,
    });

    // Stremio SDK: validates the manifest and gives us the manifest/handler interface
    const manifest = buildManifest(env.addonUrl);
    const builder = new addonBuilder(manifest);
    builder.defineCatalogHandler(({ type, extra }) => catalog.getCatalog(type, extra?.config));
    const addonInterface = builder.getInterface();

    const configHtml = fs
        .readFileSync(path.join(__dirname, '..', 'public', 'configure.html'), 'utf8')
        .replaceAll('{{FAVICON_URL}}', `${env.addonUrl}/favicon.svg`)
        .replaceAll('{{IMAGE_EXT}}', env.imageFormat || 'jpg');

    const app = express();
    app.disable('x-powered-by');
    // Behind Caddy, req.ip must be the visitor, not the proxy
    if (stats && typeof app.set === 'function') app.set('trust proxy', env.trustProxy || 'loopback, linklocal, uniquelocal');
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        next();
    });

    if (stats) {
        app.use(stats.middleware);
        const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8')
            .replaceAll('{{FAVICON_URL}}', `${env.addonUrl}/favicon.svg`);
        // Clears everything cached for one title: finished images, remembered pass-throughs and TMDB lookups
        const invalidateItem = async (type, id) => {
            const { images, remembered } = await imageRoutes.invalidate(type, id);
            const lookups = tmdb.invalidate ? tmdb.invalidate(type === 'series' ? 'tv' : 'movie', id) : 0;
            return { type, id, images, remembered, lookups };
        };
        registerAdminRoutes(app, { stats, token: env.statsToken, html: adminHtml, invalidate: invalidateItem, logger });
    }

    registerAddonRoutes(app, { manifest, addonInterface, configHtml, addonUrl: env.addonUrl });
    const imageRoutes = registerImageRoutes(app, { store, artwork, trending, tags, logger, metrics });
    app.use(errorHandler(logger));

    store.startSweeper();
    genres.ensure(); // warm up; failures are logged and retried on demand

    return { app, store, stats, shutdown: () => { store.stop(); stats?.stop(); } };
}

module.exports = { createApp };
