'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEnv } = require('../src/env');

const good = { TMDB_API_KEY: ' abc ', ADDON_URL: 'https://addon.example.com/' };

test('loadEnv: defaults, trimming, trailing slash', () => {
    const env = loadEnv(good);
    assert.equal(env.tmdbApiKey, 'abc');
    assert.equal(env.addonUrl, 'https://addon.example.com');
    assert.equal(env.port, 7000);
    assert.equal(env.imageFormat, 'jpg');
    assert.equal(env.renderConcurrency, 4);
    assert.equal(env.cacheDir, path.resolve(__dirname, '..', 'image-cache'));
});

test('loadEnv: overrides', () => {
    const env = loadEnv({ ...good, PORT: '8080', IMAGE_FORMAT: 'PNG', CACHE_DIR: '/data/img', RENDER_CONCURRENCY: '2' });
    assert.deepEqual([env.port, env.imageFormat, env.cacheDir, env.renderConcurrency], [8080, 'png', path.resolve('/data/img'), 2]);
});

test('loadEnv: reports every problem at once', () => {
    assert.throws(() => loadEnv({}), (err) => /TMDB_API_KEY/.test(err.message) && /ADDON_URL/.test(err.message));
    assert.throws(() => loadEnv({ ...good, ADDON_URL: 'example.com' }), /ADDON_URL/);
    assert.throws(() => loadEnv({ ...good, IMAGE_FORMAT: 'gif' }), /IMAGE_FORMAT/);
});

test('IMAGE_CACHE_HOURS: defaults to 48, 0 means "until local midnight", junk is rejected', () => {
    const { loadEnv } = require('../src/env');
    const base = { TMDB_API_KEY: 'k', ADDON_URL: 'https://addon.test' };
    assert.equal(loadEnv(base).imageCacheHours, 48);
    assert.equal(loadEnv({ ...base, IMAGE_CACHE_HOURS: '' }).imageCacheHours, 48);
    assert.equal(loadEnv({ ...base, IMAGE_CACHE_HOURS: '0' }).imageCacheHours, 0);
    assert.equal(loadEnv({ ...base, IMAGE_CACHE_HOURS: '6' }).imageCacheHours, 6);
    for (const bad of ['-1', 'abc', '5000']) assert.throws(() => loadEnv({ ...base, IMAGE_CACHE_HOURS: bad }), /IMAGE_CACHE_HOURS/, bad);
});
