'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, createSingleFlight, MemoryCache, deepFreeze } = require('../src/util');
const { parseUserConfig, parseConfigSegment, parseListLang } = require('../src/userConfig');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('createLimiter never exceeds max concurrency and preserves results', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(5);
        active--;
        return i * 2;
    })));
    assert.equal(peak, 3);
    assert.deepEqual(results, Array.from({ length: 12 }, (_, i) => i * 2));
});

test('createLimiter keeps working after failures (sync throw and rejection)', async () => {
    const limit = createLimiter(1);
    await assert.rejects(limit(() => { throw new Error('sync'); }), /sync/);
    await assert.rejects(limit(async () => { throw new Error('async'); }), /async/);
    assert.equal(await limit(async () => 'still alive'), 'still alive');
});

test('createSingleFlight shares work, then forgets it', async () => {
    const flights = createSingleFlight();
    let runs = 0;
    const work = async () => { runs++; await tick(10); return { value: runs }; };
    const [a, b, c] = await Promise.all([flights.run('k', work), flights.run('k', work), flights.run('other', work)]);
    assert.equal(a, b); // same object: literally the same promise result
    assert.notEqual(a, c);
    assert.equal(runs, 2);
    assert.equal(flights.size, 0);
    await flights.run('k', work);
    assert.equal(runs, 3);
});

test('createSingleFlight: a failure is shared, not sticky', async () => {
    const flights = createSingleFlight();
    let runs = 0;
    const flaky = async () => { runs++; await tick(5); if (runs === 1) throw new Error('first fails'); return 'ok'; };
    const settled = await Promise.allSettled([flights.run('k', flaky), flights.run('k', flaky)]);
    assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected']);
    assert.equal(runs, 1);
    assert.equal(await flights.run('k', flaky), 'ok');
});

test('MemoryCache: TTL, stale window, LRU and byte cap', async (t) => {
    await t.test('expires after ttl but stays readable as stale', () => {
        let now = 1000;
        const cache = new MemoryCache({ ttlMs: 100, staleMs: 500, now: () => now });
        cache.set('a', 1);
        assert.equal(cache.get('a'), 1);
        now = 1100;
        assert.equal(cache.get('a'), undefined);
        assert.equal(cache.getStale('a'), 1);
        now = 1150;
        assert.equal(cache.get('a'), undefined);
        assert.equal(cache.getStale('a'), 1);
        now = 1700;
        assert.equal(cache.getStale('a'), undefined);
        assert.equal(cache.size, 0);
    });

    await t.test('evicts least recently used first', () => {
        const cache = new MemoryCache({ ttlMs: 1e9, maxEntries: 2 });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.get('a'); // a is now the most recent
        cache.set('c', 3);
        assert.equal(cache.get('b'), undefined);
        assert.equal(cache.get('a'), 1);
        assert.equal(cache.get('c'), 3);
    });

    await t.test('byte budget is enforced, oversize values are skipped', () => {
        const cache = new MemoryCache({ ttlMs: 1e9, maxBytes: 10, sizeOf: (b) => b.length });
        cache.set('a', Buffer.alloc(4));
        cache.set('b', Buffer.alloc(4));
        cache.set('c', Buffer.alloc(4)); // pushes out 'a'
        assert.equal(cache.get('a'), undefined);
        assert.ok(cache.get('b') && cache.get('c'));
        assert.equal(cache.bytes, 8);
        cache.set('huge', Buffer.alloc(11));
        assert.equal(cache.get('huge'), undefined);
        assert.equal(cache.bytes, 8);
        cache.set('b', Buffer.alloc(2)); // replacing adjusts the total
        assert.equal(cache.bytes, 6);
    });
});

test('deepFreeze makes nested mutation throw in strict mode', () => {
    const data = deepFreeze({ a: { b: [1, { c: 2 }] } });
    assert.throws(() => { data.a.b[1].c = 3; }, TypeError);
    assert.throws(() => { data.a.b.push(4); }, TypeError);
    assert.equal(deepFreeze(null), null);
});

test('parseUserConfig', async (t) => {
    await t.test('defaults', () => {
        assert.deepEqual(parseUserConfig({}), {
            backdropTags: true, backdropLogos: false, backdropRanked: false, backdropLanguage: 'en',
            posterTags: true, posterLogos: false, posterRanked: true, posterLanguage: 'en',
            textlessArtwork: false, backdropTextlessArtwork: false, posterShape: 'portrait',
            digitalOnly: true, listLangs: ['en'], listLang: 'en',
        });
    });

    await t.test('legacy names still work, newer names win', () => {
        assert.equal(parseUserConfig({ landscapeTags: 'false' }).backdropTags, false);
        assert.equal(parseUserConfig({ portraitTags: 'false' }).posterTags, false);
        assert.equal(parseUserConfig({ tags: 'false' }).posterTags, false);
        assert.equal(parseUserConfig({ tags: 'false', backdropTags: 'true' }).backdropTags, true);
        assert.equal(parseUserConfig({ logos: 'true' }).posterLogos, true);
        assert.equal(parseUserConfig({ ranked: 'false' }).posterRanked, false);
        assert.equal(parseUserConfig({ ranked: 'true' }).backdropRanked, false); // legacy "ranked" never applied to backdrops
        assert.equal(parseUserConfig({ posterLang: 'ja' }).posterLanguage, 'ja');
        assert.equal(parseUserConfig({ landscapePosterLang: 'ko', posterLang: 'ja' }).backdropLanguage, 'ko');
        assert.equal(parseUserConfig({ portraitPosterLang: 'fr', posterLang: 'ja' }).posterLanguage, 'fr');
        assert.equal(parseUserConfig({ textlessArtwork: 'true' }).textlessArtwork, true);
        assert.equal(parseUserConfig({ textlessArtwork: 'invalid' }).textlessArtwork, false);
        assert.equal(parseUserConfig({ backdropTextlessArtwork: 'true' }).backdropTextlessArtwork, true);
        assert.equal(parseUserConfig({ backdropTextlessArtwork: 'invalid' }).backdropTextlessArtwork, false);
    });

    await t.test('bad values fall back safely', () => {
        const cfg = parseUserConfig({ posterLanguage: '<script>', backdropLanguage: 'EN', posterShape: 'diagonal', listLang: '../../etc,en' });
        assert.equal(cfg.posterLanguage, 'en');
        assert.equal(cfg.backdropLanguage, 'en');
        assert.equal(cfg.posterShape, 'portrait');
        assert.deepEqual(cfg.listLangs, ['en']);
    });

    await t.test('textless is a valid language choice', () => {
        assert.equal(parseUserConfig({ posterLanguage: 'null' }).posterLanguage, 'null');
    });

    await t.test('listLang parsing', () => {
        assert.deepEqual(parseListLang('all'), ['all']);
        assert.deepEqual(parseListLang('en, ja ,ja,non-en'), ['en', 'ja', 'non-en']);
        assert.deepEqual(parseListLang(''), ['en']);
        assert.deepEqual(parseListLang(undefined), ['en']);
        assert.equal(parseListLang(Array.from({ length: 40 }, (_, i) => `a${String.fromCharCode(97 + (i % 26))}`).join(',')).length, 12);
    });
});

test('parseConfigSegment never throws and ignores junk', () => {
    const cfg = parseConfigSegment('posterTags=false|listLang=en%2Cja|broken|=novalue|empty=|posterLanguage=%E0%A4%A|__proto__=x');
    assert.equal(cfg.posterTags, 'false');
    assert.equal(cfg.listLang, 'en,ja');
    assert.equal(cfg.posterLanguage, '%E0%A4%A'); // malformed escape kept verbatim instead of throwing
    assert.equal(cfg.broken, undefined);
    assert.equal(cfg.empty, undefined);
    assert.equal(Object.getPrototypeOf(cfg), null);
    assert.equal(Object.keys(parseConfigSegment(undefined)).length, 0);
});
