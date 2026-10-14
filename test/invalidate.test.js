'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryCache } = require('../src/util');
const { createTmdbClient } = require('../src/tmdb');
const { ImageStore } = require('../src/imageStore');
const { imageKey, itemGroup, imageGroup } = require('../src/http');
const { createApp } = require('../src/app');
const { express, addonBuilder } = require('./helpers/miniExpress');
const { NOW, makeMovie, makeShow, createFakeTmdb } = require('./helpers/fakeTmdb');

const silent = { error() {}, warn() {}, log() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'invalidate-'));
const TOKEN = 'a-long-enough-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

test('MemoryCache.deleteWhere removes matching entries and keeps the byte count right', () => {
    const cache = new MemoryCache({ ttlMs: 1000, maxBytes: 1000, sizeOf: (v) => v.length });
    cache.set('a|1', 'xxxx');
    cache.set('a|2', 'xxxx');
    cache.set('b|1', 'xxxx');
    assert.equal(cache.deleteWhere((k) => k.startsWith('a|')), 2);
    assert.equal(cache.get('a|1'), undefined);
    assert.equal(cache.get('b|1'), 'xxxx');
    assert.equal(cache.bytes, 4);
    assert.equal(cache.deleteWhere(() => false), 0);
});

test('TMDB client: invalidate forgets one title only (not look-alike ids, not the other type)', async () => {
    const calls = [];
    const tmdb = createTmdbClient({
        apiKey: 'k', sleep: async () => {}, retries: 0, logger: silent,
        fetchImpl: async (url) => { calls.push(new URL(url).pathname); return new Response('{"ok":true}', { status: 200 }); },
    });
    for (const p of ['/movie/603', '/movie/6031', '/tv/603', '/movie/603/watch/providers']) await tmdb.json(p);
    await tmdb.json('/movie/603/images', { include_image_language: 'en,null' });
    calls.length = 0;

    assert.equal(tmdb.invalidate('movie', '603'), 3); // details, images, providers
    for (const p of ['/movie/603', '/movie/6031', '/tv/603', '/movie/603/watch/providers']) await tmdb.json(p);
    await tmdb.json('/movie/603/images', { include_image_language: 'en,null' });
    assert.deepEqual(calls.sort(), ['/3/movie/603', '/3/movie/603/images', '/3/movie/603/watch/providers']); // only those were fetched again
    assert.equal(tmdb.invalidate('movie', '999'), 0);
});

test('cache keys map to their title, and the mapping matches imageKey', () => {
    assert.equal(itemGroup('movie', '603'), 'movie-603');
    assert.equal(itemGroup('series', '1399'), 'series-1399');
    const key = imageKey('poster', '603', { format: 'jpg', type: 'movie', tag: 'x', rank: '3', lang: 'en', logos: true, textless: false });
    assert.equal(imageGroup(key), 'movie-603');
    const series = imageKey('backdrop', '1399', { format: 'png', type: 'series', tag: 'none', rank: 'none', lang: 'en', logos: false, textless: true, titleStyle: 'gradient-v9' });
    assert.equal(imageGroup(series), 'series-1399');
});

test('image store: one title\'s images are cleared together, from memory and disk, and nothing else', async () => {
    const dir = tmp();
    try {
        const store = new ImageStore({ dir, ttlMs: 60_000, groupOf: imageGroup, logger: silent });
        const k = (type, id, tag) => imageKey('poster', id, { format: 'jpg', type, tag, rank: 'none', lang: 'en', logos: false, textless: false });
        await store.set(k('movie', '603', 'a'), Buffer.from('1'), 'jpg');
        await store.set(k('movie', '603', 'b'), Buffer.from('2'), 'jpg');
        await store.set(k('movie', '6031', 'a'), Buffer.from('3'), 'jpg'); // different title, similar id
        await store.set(k('series', '603', 'a'), Buffer.from('4'), 'jpg'); // same id, other type
        assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('movie-603_')));

        const result = await store.invalidate('movie-603');
        assert.deepEqual(result, { memory: 2, disk: 2 });
        assert.equal(await store.get(k('movie', '603', 'a'), 'jpg'), null);
        assert.equal(await store.get(k('movie', '603', 'b'), 'jpg'), null);
        assert.equal((await store.get(k('movie', '6031', 'a'), 'jpg')).toString(), '3');
        assert.equal((await store.get(k('series', '603', 'a'), 'jpg')).toString(), '4');

        // a restart (empty memory) finds nothing left on disk either
        const fresh = new ImageStore({ dir, ttlMs: 60_000, groupOf: imageGroup, logger: silent });
        assert.equal(await fresh.get(k('movie', '603', 'a'), 'jpg'), null);
        assert.deepEqual(await store.invalidate(''), { memory: 0, disk: 0 }); // an empty group never matches files
        assert.deepEqual(await store.invalidate('movie-999'), { memory: 0, disk: 0 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── End to end through the app ──────────────────────────────────────────────

function adminApp(fixtures) {
    const fake = createFakeTmdb(fixtures);
    const tmdb = createTmdbClient({ apiKey: 'k', fetchImpl: fake.fetch, sleep: async () => {}, retries: 0, logger: silent });
    const cacheDir = tmp();
    const statsDir = tmp();
    const env = {
        tmdbApiKey: 'k', addonUrl: 'https://addon.test', port: 0, cacheDir, renderConcurrency: 2, imageFormat: 'jpg',
        imageCacheHours: 48, statsToken: TOKEN, statsDir, statsGeo: false, statsTimezone: '',
    };
    const { app, shutdown } = createApp(env, { express, sdk: { addonBuilder }, tmdb, now: () => NOW, logger: silent });
    return {
        app, fake,
        cleanup: () => { shutdown(); fs.rmSync(cacheDir, { recursive: true, force: true }); fs.rmSync(statsDir, { recursive: true, force: true }); },
    };
}
const invalidate = (app, query, headers = AUTH) => app.request(`/admin/api/invalidate?${query}`, { method: 'POST', headers });

test('admin: clearing a title makes its next request draw a new image', async (t) => {
    const { app, fake, cleanup } = adminApp({ movies: [makeMovie(1), makeMovie(2)], shows: [makeShow(3)] });
    t.after(cleanup);
    const drawn = '/poster/1.jpg?type=movie&tag=new_series&rank=3&lang=en&logos=0';
    const other = '/poster/2.jpg?type=movie&tag=new_series&rank=1&lang=en&logos=0';
    const lookups = (id) => fake.calls.filter((c) => c.includes(`/movie/${id}`) && !c.includes('/t/p/')).length;

    await t.test('the first request draws, the second comes from cache', async () => {
        assert.equal((await app.request(drawn)).status, 200);
        assert.equal((await app.request(other)).status, 200);
        const before = lookups(1);
        assert.ok(before > 0);
        assert.equal((await app.request(drawn)).status, 200);
        assert.equal(lookups(1), before); // cached: no TMDB lookups
    });

    await t.test('wrong or missing token: nothing is cleared', async () => {
        assert.equal((await invalidate(app, 'id=1&type=movie', {})).status, 401);
        assert.equal((await invalidate(app, 'id=1&type=movie', { authorization: 'Bearer nope' })).status, 401);
    });

    await t.test('bad input is refused', async () => {
        assert.equal((await invalidate(app, 'id=abc&type=movie')).status, 400);
        assert.equal((await invalidate(app, 'id=&type=movie')).status, 400);
        assert.equal((await invalidate(app, 'id=0&type=movie')).status, 400);
        assert.equal((await invalidate(app, 'id=1&type=anime')).status, 400);
    });

    await t.test('clearing movie 1 reports what it removed', async () => {
        const res = await invalidate(app, 'id=1&type=movie');
        assert.equal(res.status, 200);
        const body = res.json();
        assert.equal(body.ok, true);
        assert.equal(body.results.length, 1);
        assert.deepEqual([body.results[0].type, body.results[0].id], ['movie', '1']);
        assert.equal(body.results[0].images, 1);
        assert.ok(body.results[0].lookups >= 2, 'details and image list were cached');
    });

    await t.test('the next request looks the title up and draws again; the other title is untouched', async () => {
        const before = lookups(1);
        assert.equal((await app.request(drawn)).status, 200);
        assert.ok(lookups(1) > before, 'movie 1 was looked up and drawn again');
        const otherBefore = lookups(2);
        assert.equal((await app.request(other)).status, 200);
        assert.equal(lookups(2), otherBefore, 'movie 2 stayed cached');
    });

    await t.test('"both" clears the movie and the series with that id', async () => {
        const res = await invalidate(app, 'id=3&type=both');
        assert.equal(res.status, 200);
        assert.deepEqual(res.json().results.map((r) => r.type), ['movie', 'series']);
    });
});

test('admin: remembered pass-through answers are cleared too', async (t) => {
    const { app, fake, cleanup } = adminApp({ movies: [makeMovie(1)] });
    t.after(cleanup);
    const url = '/poster/1.jpg?type=movie&tag=none&rank=none&lang=en&logos=0';
    assert.equal((await app.request(url)).status, 302);
    fake.reset();
    assert.equal((await app.request(url)).status, 302);
    assert.equal(fake.calls.length, 0); // answered from memory

    const res = await invalidate(app, 'id=1&type=movie');
    assert.equal(res.json().results[0].remembered, 1);
    fake.reset();
    assert.equal((await app.request(url)).status, 302);
    assert.ok(fake.calls.length > 0, 'asks TMDB again');
});
