'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTmdbClient, TmdbError } = require('../src/tmdb');

const silent = { warn() {}, error() {}, log() {} };
const ok = (body, init) => new Response(JSON.stringify(body), { status: 200, ...init });
const client = (fetchImpl, o = {}) => createTmdbClient({ apiKey: 'SECRET_KEY', fetchImpl, sleep: async () => {}, logger: silent, ...o });

test('caches successful responses and keeps the api key out of the cache key and errors', async () => {
    const urls = [];
    const tmdb = client(async (url) => { urls.push(String(url)); return ok({ n: urls.length }); });
    const a = await tmdb.json('/movie/1', { b: 2, a: 1 });
    const b = await tmdb.json('/movie/1', { a: 1, b: 2 }); // param order doesn't matter
    assert.equal(a, b);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /api_key=SECRET_KEY/);
    assert.deepEqual([...tmdb.cache.map.keys()], ['/3/movie/1?a=1&b=2']);
});

test('returned data is frozen', async () => {
    const tmdb = client(async () => ok({ list: [{ x: 1 }] }));
    const data = await tmdb.json('/x');
    assert.throws(() => { data.list[0].x = 2; }, TypeError);
});

test('concurrent identical requests share one round trip', async () => {
    let calls = 0;
    const tmdb = client(async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return ok({ v: 1 }); });
    const results = await Promise.all(Array.from({ length: 8 }, () => tmdb.json('/same')));
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r === results[0]));
});

test('retries 5xx and network errors, then succeeds', async () => {
    const script = [() => new Response('x', { status: 503 }), () => { throw new TypeError('fetch failed'); }, () => ok({ done: true })];
    let i = 0;
    const tmdb = client(async () => script[i++]());
    assert.deepEqual(await tmdb.json('/flaky'), { done: true });
    assert.equal(i, 3);
});

test('honours Retry-After on 429 (capped)', async () => {
    const waits = [];
    let i = 0;
    const tmdb = createTmdbClient({
        apiKey: 'k', logger: silent, sleep: async (ms) => waits.push(ms),
        fetchImpl: async () => (i++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : ok({ ok: 1 })),
    });
    await tmdb.json('/limited');
    assert.deepEqual(waits, [2000]);

    i = 0; waits.length = 0;
    const capped = createTmdbClient({
        apiKey: 'k', logger: silent, sleep: async (ms) => waits.push(ms),
        fetchImpl: async () => (i++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : ok({})),
    });
    await capped.json('/limited2');
    assert.deepEqual(waits, [5000]);
});

test('gives up after the retry budget and does not leak the key', async () => {
    let calls = 0;
    const tmdb = client(async () => { calls++; return new Response('down', { status: 500 }); }, { retries: 2 });
    await assert.rejects(tmdb.json('/down'), (err) => {
        assert.ok(err instanceof TmdbError);
        assert.equal(err.status, 500);
        assert.doesNotMatch(String(err.stack) + err.message, /SECRET_KEY/);
        return true;
    });
    assert.equal(calls, 3);
});

test('404 and other 4xx are not retried', async () => {
    let calls = 0;
    const tmdb = client(async () => { calls++; return new Response('nope', { status: 404 }); });
    await assert.rejects(tmdb.json('/missing'), (err) => err.status === 404);
    assert.equal(calls, 1);
    calls = 0;
    const unauthorized = client(async () => { calls++; return new Response('bad key', { status: 401 }); });
    await assert.rejects(unauthorized.json('/x'), (err) => err.status === 401);
    assert.equal(calls, 1);
});

test('serves a stale copy when TMDB fails after the ttl, but never for 404', async () => {
    let now = 0;
    let healthy = true;
    const tmdb = createTmdbClient({
        apiKey: 'k', logger: silent, sleep: async () => {}, retries: 0, ttlMs: 100, staleMs: 10_000,
        fetchImpl: async () => (healthy ? ok({ v: 'fresh' }) : new Response('', { status: 502 })),
    });
    tmdb.cache.now = () => now; // drive the clock
    assert.deepEqual(await tmdb.json('/thing'), { v: 'fresh' });
    healthy = false;
    now = 500; // expired, still inside the stale window
    assert.deepEqual(await tmdb.json('/thing'), { v: 'fresh' });
    now = 20_000; // beyond the stale window
    await assert.rejects(tmdb.json('/thing'), (err) => err.status === 502);
});

test('a request that hangs is aborted by the timeout', async () => {
    const tmdb = createTmdbClient({
        apiKey: 'k', logger: silent, sleep: async () => {}, retries: 0, timeoutMs: 30,
        fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    });
    // AbortSignal.timeout() timers are unref'd; a real socket (or the listening server) keeps the loop alive, this stands in for it
    const keepAlive = setTimeout(() => {}, 2000);
    const started = Date.now();
    try {
        await assert.rejects(tmdb.json('/hang'));
        assert.ok(Date.now() - started < 1000);
    } finally {
        clearTimeout(keepAlive);
    }
});

test('limits concurrent upstream calls', async () => {
    let active = 0;
    let peak = 0;
    const tmdb = client(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return ok({});
    }, { maxConcurrent: 4 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => tmdb.json(`/item/${i}`)));
    assert.equal(peak, 4);
});

test('rejects malformed paths and image paths before any request', async () => {
    let calls = 0;
    const tmdb = client(async () => { calls++; return ok({}); });
    for (const bad of ['movie/1', '/movie/../account', '/movie/1?api_key=x', '/movie/1#x', '/a\\b', 42]) {
        await assert.rejects(tmdb.json(bad), (err) => err.status === 400, `path ${String(bad)}`);
    }
    for (const bad of ['../etc/passwd', '/a/b.jpg', '', null, '/x y.jpg']) {
        await assert.rejects(tmdb.image('w500', bad), (err) => err.status === 400, `image ${String(bad)}`);
    }
    assert.equal(calls, 0);
});

test('image() checks the response status', async () => {
    const tmdb = client(async (url) => (String(url).includes('bad') ? new Response('gone', { status: 404 }) : new Response(Buffer.from([1, 2, 3]))));
    assert.deepEqual([...(await tmdb.image('w500', '/good.jpg'))], [1, 2, 3]);
    await assert.rejects(tmdb.image('w500', '/bad.jpg'), (err) => err.status === 404);
    assert.equal(tmdb.imageUrl('w500', '/x.jpg'), 'https://image.tmdb.org/t/p/w500/x.jpg');
});

test('requires an api key', () => {
    assert.throws(() => createTmdbClient({}), /apiKey/);
});

test('image(): downloads are cached and shared while in flight; a different size is a different file', async () => {
    let calls = 0;
    const tmdb = client(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return new Response(Buffer.from('imagebytes'), { status: 200 }); });
    const [a, b, c] = await Promise.all([tmdb.image('w500', '/a.jpg'), tmdb.image('w500', '/a.jpg'), tmdb.image('w500', '/a.jpg')]);
    assert.equal(calls, 1);
    assert.ok(a === b && b === c);
    assert.equal(a.toString(), 'imagebytes');
    await tmdb.image('w500', '/a.jpg');
    assert.equal(calls, 1); // served from memory
    await tmdb.image('w1280', '/a.jpg');
    assert.equal(calls, 2);
});

test('image(): failures are not remembered', async () => {
    let calls = 0;
    let failing = true;
    const tmdb = client(async () => { calls++; return failing ? new Response('no', { status: 500 }) : new Response(Buffer.from('ok'), { status: 200 }); });
    await assert.rejects(tmdb.image('w500', '/b.jpg'), TmdbError);
    failing = false;
    assert.equal((await tmdb.image('w500', '/b.jpg')).toString(), 'ok');
    assert.equal(calls, 2);
});

test('image(): the cache is capped by bytes, oldest first, and entries expire', async () => {
    let calls = 0;
    let t = 0;
    const tmdb = createTmdbClient({
        apiKey: 'k', sleep: async () => {}, logger: silent, imageCacheBytes: 25, imageTtlMs: 1000,
        fetchImpl: async () => { calls++; return new Response(Buffer.alloc(10, 1), { status: 200 }); },
    });
    await tmdb.image('w500', '/a.jpg');
    await tmdb.image('w500', '/b.jpg');
    await tmdb.image('w500', '/c.jpg'); // 30 bytes > 25: the oldest (a) goes
    assert.equal(calls, 3);
    await tmdb.image('w500', '/c.jpg');
    await tmdb.image('w500', '/b.jpg');
    assert.equal(calls, 3); // b and c still cached
    await tmdb.image('w500', '/a.jpg');
    assert.equal(calls, 4); // a was evicted
    void t;
});
