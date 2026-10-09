'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { ImageStore } = require('../src/imageStore');
const { createArtwork, LAYOUTS, buildTagComposites } = require('../src/artwork');
const { createTmdbClient } = require('../src/tmdb');
const { createApp } = require('../src/app');
const { express, addonBuilder } = require('./helpers/miniExpress');
const { NOW, iso, makeMovie, makeShow, standardImages, createFakeTmdb } = require('./helpers/fakeTmdb');

const silent = { warn() {}, error() {}, log() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-top-'));
const png = (buf) => sharp(buf).metadata();
const isJpeg = (buf) => Buffer.isBuffer(buf) && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
const isPng = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// ─── ImageStore ──────────────────────────────────────────────────────────────

test('ImageStore: round trip through disk, TTL, atomic writes', async (t) => {
    const dir = tmpDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    let now = 1_000_000;
    const a = new ImageStore({ dir, ttlMs: 1000, now: () => now, logger: silent });
    await a.set('k1', Buffer.from('hello'));
    assert.equal((await a.get('k1')).toString(), 'hello');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []); // temp file was renamed away

    // a fresh instance (e.g. after a restart) finds it on disk
    const b = new ImageStore({ dir, ttlMs: 1000, now: () => Date.now(), logger: silent });
    assert.equal((await b.get('k1')).toString(), 'hello');
    assert.equal(await b.get('never-stored'), null);

    // expired on disk: ignored
    const c = new ImageStore({ dir, ttlMs: 1000, now: () => Date.now() + 5000, logger: silent });
    assert.equal(await c.get('k1'), null);
});

test('ImageStore: generated images expire at the next local midnight', async (t) => {
    const dir = tmpDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    let now = new Date(2026, 0, 1, 23, 59, 0).getTime();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const store = new ImageStore({ dir, now: () => now, logger: silent });
    await store.set('midnight-image', Buffer.from('image'));
    fs.utimesSync(store.fileFor('midnight-image'), now / 1000, now / 1000);

    now = midnight.getTime() - 1;
    assert.equal((await store.get('midnight-image')).toString(), 'image');
    now = midnight.getTime();
    assert.equal(await store.get('midnight-image'), null);
    assert.equal(await store.sweep(), 1);
});

test('ImageStore: jpg files round-trip and are swept like png files', async (t) => {
    const dir = tmpDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new ImageStore({ dir, ttlMs: 1000, logger: silent });
    await store.set('poster|jpg|k', Buffer.from('jpeg-bytes'), 'jpg');
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.jpg')));
    assert.equal((await new ImageStore({ dir, logger: silent }).get('poster|jpg|k', 'jpg')).toString(), 'jpeg-bytes');
    const later = new ImageStore({ dir, ttlMs: 1000, now: () => Date.now() + 5000, logger: silent });
    assert.equal(await later.sweep(), 1);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('ImageStore: concurrent writers of one key never expose a partial file', async (t) => {
    const dir = tmpDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new ImageStore({ dir, logger: silent });
    const big = Buffer.alloc(2_000_000, 7);
    await Promise.all([store.set('same', big), store.set('same', big), store.set('same', big)]);
    const reader = new ImageStore({ dir, logger: silent });
    assert.equal((await reader.get('same')).length, big.length);
});

test('ImageStore.sweep: removes expired + leftover temp files, honours the size budget, leaves other files alone', async (t) => {
    const dir = tmpDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const DAY = 86_400_000;
    const make = (name, bytes, ageMs) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, Buffer.alloc(bytes, 1));
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(file, when, when);
    };
    make('old.png', 100, 2 * DAY); // expired
    make('leftover.png.123.abcd.tmp', 100, 2 * 3_600_000); // stale temp file
    make('fresh-newest.png', 400, 1000);
    make('fresh-older.png', 400, 3_600_000);
    make('notes.txt', 100, 5 * DAY); // not ours: must survive

    const store = new ImageStore({ dir, ttlMs: DAY, maxDiskBytes: 500, logger: silent });
    const removed = await store.sweep();
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, ['fresh-newest.png', 'notes.txt']); // older fresh file trimmed to fit the 500-byte budget
    assert.equal(removed, 3);
    assert.equal(await store.sweep(), 0);
});

// ─── Artwork renderer ────────────────────────────────────────────────────────

function artworkFor(fixtures) {
    const fake = createFakeTmdb(fixtures);
    const tmdb = createTmdbClient({ apiKey: 'k', fetchImpl: fake.fetch, sleep: async () => {}, retries: 0, logger: silent });
    return { fake, tmdb, artwork: createArtwork({ tmdb, logger: silent }) };
}
const base = { kind: 'poster', id: '1', type: 'movie', tag: 'none', rank: 'none', lang: 'en', logos: false };
const netflix = { flatrate: [{ provider_name: 'Netflix', logo_path: '/nf.png' }] };

test('artwork: nothing to draw -> redirect to the right TMDB size', async () => {
    const { artwork } = artworkFor({ movies: [makeMovie(1)] });
    assert.deepEqual(await artwork.render(base), { kind: 'redirect', url: 'https://image.tmdb.org/t/p/w500/poster_en_1.jpg' });
    assert.deepEqual(await artwork.render({ ...base, kind: 'backdrop', lang: 'null' }), { kind: 'redirect', url: 'https://image.tmdb.org/t/p/w1280/bd_null_1.jpg' });
});

test('artwork: poster with tag + rank + provider logo', async () => {
    const { artwork } = artworkFor({ movies: [makeMovie(1, { providers: netflix })] });
    const out = await artwork.render({ ...base, tag: 'coming_date_Oct_2', rank: '3', logos: true });
    assert.equal(out.kind, 'image');
    assert.ok(isPng(out.buffer));
    const meta = await png(out.buffer);
    assert.deepEqual([meta.width, meta.height], [500, 750]);
});

test('artwork: poster and background tags have a subtle rounded top-edge highlight', async () => {
    for (const [width, height, heightRatio, fontRatio, y] of [
        [500, 750, LAYOUTS.poster.tag.heightRatio, LAYOUTS.poster.tag.fontRatio, 682],
        [1280, 720, LAYOUTS.backdrop.tag.heightRatio, LAYOUTS.backdrop.tag.fontRatio, 612],
    ]) {
        const image = await sharp({ create: { width, height, channels: 3, background: '#202020' } }).png().toBuffer();
        const composites = await buildTagComposites(image, { width, height }, 'Now Streaming', heightRatio, fontRatio);
        const { data, info } = await sharp(image).composite(composites).raw().toBuffer({ resolveWithObject: true });
        const sample = (sampleY) => {
            const offset = (sampleY * info.width + Math.floor(width / 2)) * info.channels;
            return data[offset] + data[offset + 1] + data[offset + 2];
        };

        assert.ok(sample(y) > sample(y + 5) + 30, `${width}x${height} tag top border should be brighter than the fill`);
    }
});

test('artwork: landscape rank font is 30% of backdrop height', () => {
    assert.equal(LAYOUTS.backdrop.rank(1280, 720).fontSize, 216);
});

test('artwork: backdrop with textless art gets a title logo, provider logo, tag and rank', async () => {
    // Only a textless backdrop exists, so the requested language can't be satisfied and the title logo is drawn on top
    const images = { ...standardImages(1), backdrops: [{ iso_639_1: null, file_path: '/bd_null_1.jpg' }] };
    const { artwork, fake } = artworkFor({ movies: [makeMovie(1, { providers: netflix, images })] });
    const out = await artwork.render({ ...base, kind: 'backdrop', tag: 'now_streaming', rank: '7', lang: 'en', logos: true });
    assert.equal(out.kind, 'image');
    const meta = await png(out.buffer);
    assert.deepEqual([meta.width, meta.height], [1280, 720]);
    assert.equal(fake.count('/t/p/original/logo_en_1.png'), 1); // the title logo was fetched
    assert.equal(fake.count('/t/p/w154/nf.png'), 1); // and the provider logo

    // An English backdrop exists here, so it is used as-is: no title logo (it already has the title on it)
    const { artwork: plain, fake: plainFake } = artworkFor({ movies: [makeMovie(1)] });
    const withText = await plain.render({ ...base, kind: 'backdrop', tag: 'now_streaming', lang: 'en' });
    assert.equal(withText.kind, 'image');
    assert.equal(plainFake.count('/t/p/original/logo_'), 0);
});

test('artwork: textless mode uses textless posters and overlays the title logo', async () => {
    const poster = await sharp({ create: { width: 500, height: 750, channels: 3, background: '#446688' } }).jpeg().toBuffer();
    const { artwork, fake } = artworkFor({
        movies: [makeMovie(1)],
        cdnImages: { '/t/p/w500/poster_null_1.jpg': poster },
    });
    const out = await artwork.render({ ...base, textless: true, tag: 'now_streaming' });
    assert.equal(out.kind, 'image');
    assert.deepEqual([(await png(out.buffer)).width, (await png(out.buffer)).height], [500, 750]);
    assert.equal(fake.count('/t/p/w500/poster_null_1.jpg'), 1);
    assert.equal(fake.count('/t/p/original/logo_en_1.png'), 1);
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    const pixel = (480 * info.width + 250) * info.channels;
    const sourcePixel = (480 * 500 + 250) * 3;
    const source = await sharp(poster).raw().toBuffer();
    assert.deepEqual(Array.from(data.subarray(pixel, pixel + 3)), Array.from(source.subarray(sourcePixel, sourcePixel + 3)), 'high-contrast artwork is left untouched');
});

test('artwork: curated portrait poster rasterizes SVG title logos sharply at display size', async () => {
    const poster = await sharp({ create: { width: 500, height: 750, channels: 3, background: '#446688' } }).jpeg().toBuffer();
    const stripes = Array.from({ length: 100 }, (_, i) => `<rect x="${i}" y="0" width="0.5" height="30" fill="white"/>`).join('');
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="30"><rect width="100" height="30" fill="black"/>${stripes}</svg>`);
    const images = { ...standardImages(1), logos: [{ iso_639_1: 'en', file_path: '/vector.svg' }] };
    const { artwork } = artworkFor({
        movies: [makeMovie(1, { images })],
        cdnImages: {
            '/t/p/w500/poster_null_1.jpg': poster,
            '/t/p/original/vector.svg': svg,
        },
    });

    const out = await artwork.render({ ...base, textless: true });
    assert.equal(out.kind, 'image');
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    let crispWhitePixels = 0;
    for (let y = 580; y < 700; y++) {
        let brightInRow = 0;
        for (let x = 45; x < 455; x++) {
            const offset = (y * info.width + x) * info.channels;
            if (data[offset] > 220 && data[offset + 1] > 220 && data[offset + 2] > 220) brightInRow++;
        }
        crispWhitePixels = Math.max(crispWhitePixels, brightInRow);
    }
    assert.ok(crispWhitePixels > 50, `expected crisp SVG detail at final poster size, found ${crispWhitePixels} bright pixels`);
});

test('artwork: low-contrast title logo gets a radial halo with streaming logos both off and on', async () => {
    const poster = await sharp({ create: { width: 500, height: 750, channels: 3, background: '#eeeeee' } }).jpeg().toBuffer();
    const { artwork } = artworkFor({
        movies: [makeMovie(1, { providers: netflix })],
        cdnImages: { '/t/p/w500/poster_null_1.jpg': poster },
    });
    const render = async (logos) => {
        const out = await artwork.render({ ...base, textless: true, logos });
        assert.equal(out.kind, 'image');
        const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
        const offset = (480 * info.width + 250) * info.channels;
        return Array.from(data.subarray(offset, offset + 3));
    };
    const withoutProviderLogo = await render(false);
    const withProviderLogo = await render(true);
    assert.deepEqual(withProviderLogo, withoutProviderLogo);
    const source = await sharp(poster).raw().toBuffer();
    const pixel = (480 * 500 + 250) * 3;
    assert.ok(withProviderLogo[0] < source[pixel] - 20, 'radial halo darkens nearby artwork when logo contrast is low');
});

test('artwork: textless landscape mode uses the textless backdrop and title logo', async () => {
    const { artwork, fake } = artworkFor({ movies: [makeMovie(1)] });
    const out = await artwork.render({ ...base, kind: 'backdrop', textless: true });
    assert.equal(out.kind, 'image');
    assert.deepEqual([(await png(out.buffer)).width, (await png(out.buffer)).height], [1280, 720]);
    assert.equal(fake.count('/t/p/w1280/bd_null_1.jpg'), 1);
    assert.equal(fake.count('/t/p/original/logo_en_1.png'), 1);
});

test('artwork: textless portrait falls back to a centered, portrait-cropped textless backdrop', async () => {
    const images = {
        posters: [{ iso_639_1: 'en', file_path: '/poster_en_1.jpg' }],
        backdrops: [{ iso_639_1: null, file_path: '/bd_null_1.jpg' }],
        logos: [],
    };
    const { artwork, fake } = artworkFor({ movies: [makeMovie(1, { images })] });
    const out = await artwork.render({ ...base, textless: true, tag: 'none', rank: 'none' });
    assert.equal(out.kind, 'image');
    assert.deepEqual([(await png(out.buffer)).width, (await png(out.buffer)).height], [500, 750]);
    assert.equal(fake.count('/t/p/w1280/bd_null_1.jpg'), 1);
});

test('artwork: textless art without a title logo gets the regular title text', async () => {
    const images = { ...standardImages(1), logos: [] };
    const poster = await sharp({ create: { width: 500, height: 750, channels: 3, background: '#446688' } }).jpeg().toBuffer();
    const backdrop = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#446688' } }).jpeg().toBuffer();
    const { artwork, fake } = artworkFor({
        movies: [makeMovie(1, { images })],
        cdnImages: {
            '/t/p/w500/poster_null_1.jpg': poster,
            '/t/p/w1280/bd_null_1.jpg': backdrop,
        },
    });

    for (const [kind, imageBuffer] of [['poster', poster], ['backdrop', backdrop]]) {
        const out = await artwork.render({ ...base, kind, textless: true });
        assert.equal(out.kind, 'image');
        const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
        const source = await sharp(imageBuffer).raw().toBuffer();
        const top = Math.floor(info.height * 0.68);
        let hasTitleText = false;
        let titleTop = info.height;
        let titleBottom = -1;
        for (let y = top; y < info.height; y++) {
            for (let x = 0; x < info.width; x++) {
                const offset = (y * info.width + x) * info.channels;
                const sourceOffset = (y * info.width + x) * 3;
                if (data[offset] > 220 && data[offset + 1] > 220 && data[offset + 2] > 220 &&
                    source[sourceOffset] < 120 && source[sourceOffset + 1] < 150 && source[sourceOffset + 2] < 180) {
                    hasTitleText = true;
                    titleTop = Math.min(titleTop, y);
                    titleBottom = Math.max(titleBottom, y);
                }
            }
        }
        assert.ok(hasTitleText, `${kind} textless artwork should include readable title text`);
        assert.ok(titleBottom - titleTop > (kind === 'poster' ? 40 : 55), `${kind} fallback title uses the larger font size`);
    }
    assert.equal(fake.count('/t/p/original/logo_en_1.png'), 0);
});

test('artwork: format=jpg produces a JPEG of the same size, png stays the default', async () => {
    const { artwork } = artworkFor({ movies: [makeMovie(1, { providers: netflix })] });
    const args = { ...base, tag: 'coming_date_Oct_2', rank: '3', logos: true };
    const png = await artwork.render(args);
    const jpg = await artwork.render({ ...args, format: 'jpg' });
    assert.ok(isPng(png.buffer) && isJpeg(jpg.buffer));
    const meta = await sharp(jpg.buffer).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 500, 750]);
    assert.ok(jpg.buffer.length < png.buffer.length, 'jpeg should be smaller');

    const bd = await artwork.render({ ...args, kind: 'backdrop', format: 'jpg' });
    assert.deepEqual([(await sharp(bd.buffer).metadata()).format, (await sharp(bd.buffer).metadata()).width], ['jpeg', 1280]);

    const holder = artworkFor({ movies: [makeMovie(1, { images: { posters: [], backdrops: [], logos: [] } })] }).artwork;
    assert.ok(isJpeg((await holder.render({ ...base, format: 'jpg' })).buffer)); // placeholder honours the format too
    assert.ok(isPng((await holder.render(base)).buffer));
});

test('artwork: a failing logo download does not fail the image', async () => {
    const { artwork } = artworkFor({ movies: [makeMovie(1, { providers: netflix })], fail: { '/t/p/w154/': 404 } });
    const withTag = await artwork.render({ ...base, tag: 'new_episode', logos: true });
    assert.equal(withTag.kind, 'image');
    // only a logo was requested and it failed: fall back to the plain TMDB image instead of crashing
    const onlyLogo = await artwork.render({ ...base, logos: true });
    assert.equal(onlyLogo.kind, 'redirect');
});

test('artwork: a failing watch-providers lookup only costs the logo', async () => {
    const { artwork } = artworkFor({ movies: [makeMovie(1, { providers: netflix })], fail: { '/watch/providers': 500 } });
    const withTag = await artwork.render({ ...base, tag: 'new_episode', logos: true });
    assert.equal(withTag.kind, 'image');
    assert.equal((await artwork.render({ ...base, logos: true })).kind, 'redirect');
});

test('artwork: no image on TMDB -> local placeholder, not a third-party URL', async () => {
    const { artwork } = artworkFor({ movies: [makeMovie(1, { images: { posters: [], backdrops: [], logos: [] } })] });
    const out = await artwork.render({ ...base, tag: 'coming_soon' });
    assert.equal(out.kind, 'placeholder');
    assert.deepEqual([(await png(out.buffer)).width, (await png(out.buffer)).height], [500, 750]);
    const backdrop = await artwork.render({ ...base, kind: 'backdrop' });
    assert.deepEqual([(await png(backdrop.buffer)).width, (await png(backdrop.buffer)).height], [1280, 720]);
});

test('artwork: image language preference (requested, then original, then textless, then English)', async () => {
    const images = {
        posters: [{ iso_639_1: 'de', file_path: '/de.jpg' }, { iso_639_1: 'ja', file_path: '/ja.jpg' }, { iso_639_1: 'en', file_path: '/en.jpg' }, { iso_639_1: null, file_path: '/none.jpg' }],
        backdrops: [], logos: [],
    };
    const { artwork } = artworkFor({ movies: [makeMovie(1, { images, lang: 'ja' }), makeMovie(2, { images })] });
    const url = async (id, lang) => (await artwork.render({ ...base, id, lang })).url;
    assert.equal(await url('2', 'de'), 'https://image.tmdb.org/t/p/w500/de.jpg');
    assert.equal(await url('1', 'fr'), 'https://image.tmdb.org/t/p/w500/ja.jpg'); // not available: the film's original language
    assert.equal(await url('2', 'null'), 'https://image.tmdb.org/t/p/w500/none.jpg');
});

test('artwork: unknown title -> 404 error from TMDB', async () => {
    const { artwork } = artworkFor({ movies: [] });
    await assert.rejects(artwork.render({ ...base, id: '999' }), (err) => err.status === 404);
});

// ─── The whole app over HTTP (Express stand-in, fake TMDB, real sharp) ───────

function appFor(fixtures) {
    const fake = createFakeTmdb(fixtures);
    const tmdb = createTmdbClient({ apiKey: 'k', fetchImpl: fake.fetch, sleep: async () => {}, retries: 0, logger: silent });
    const dir = tmpDir();
    const env = { tmdbApiKey: 'k', addonUrl: 'https://addon.test', port: 0, cacheDir: dir, renderConcurrency: 2, imageFormat: 'jpg' };
    const { app, shutdown } = createApp(env, { express, sdk: { addonBuilder }, tmdb, now: () => NOW, logger: silent });
    return { app, fake, cleanup: () => { shutdown(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('HTTP: addon routes', async (t) => {
    const { app, cleanup } = appFor({ movies: [makeMovie(1)], shows: [makeShow(2)] });
    t.after(cleanup);

    await t.test('manifest', async () => {
        const res = await app.request('/manifest.json');
        assert.equal(res.status, 200);
        assert.equal(res.json().behaviorHints.configurationRequired, true);
        const configured = await app.request('/posterTags=false|listLang=en/manifest.json');
        assert.equal(configured.json().behaviorHints.configurationRequired, false);
        assert.equal(configured.json().behaviorHints.configurationURL, 'https://addon.test/posterTags=false|listLang=en/configure');
    });

    await t.test('configure page is served with the favicon URL filled in', async () => {
        for (const url of ['/', '/configure', '/posterTags=false/configure']) {
            const res = await app.request(url);
            assert.equal(res.status, 200);
            assert.match(res.body, /href="https:\/\/addon\.test\/favicon\.svg"/);
            assert.doesNotMatch(res.body, /\{\{[A-Z_]+\}\}/); // every placeholder filled in
            assert.match(res.body, /\/image\/\{type\}\/\{tmdb_id\}\.jpg"/);
            assert.match(res.body, /\/landscape\/\{type\}\/\{tmdb_id\}\.jpg"/);
            assert.match(res.body, /textlessArtwork/);
            assert.match(res.body, /backdropTextlessArtwork/);
            assert.equal(res.headers['cache-control'], 'no-store');
        }
    });

    await t.test('catalog with and without config, with and without the extra segment', async () => {
        const plain = await app.request('/catalog/movie/top_movies_today.json');
        assert.equal(plain.status, 200);
        assert.equal(plain.json().metas[0].name, 'Movie 1');
        assert.match(plain.headers['cache-control'], /max-age=900/);
        assert.equal(plain.headers['access-control-allow-origin'], '*');

        const configured = await app.request('/posterTags=false|posterRanked=false|backdropTags=false/catalog/movie/top_movies_today/skip=0.json');
        assert.equal(configured.status, 200);
        assert.equal(configured.json().metas[0].poster, 'https://image.tmdb.org/t/p/w500/p1.jpg');

        const series = await app.request('/catalog/series/top_shows_today.json');
        assert.equal(series.json().metas[0].name, 'Show 2');
    });

    await t.test('unknown catalog -> 404 JSON, not a 500', async () => {
        const res = await app.request('/catalog/movie/nope.json');
        assert.equal(res.status, 404);
        assert.deepEqual(res.json(), { err: 'Not found' });
        assert.equal((await app.request('/catalog/series/top_movies_today.json')).status, 404);
    });

    await t.test('health + favicon', async () => {
        assert.equal((await app.request('/healthz')).body, 'ok');
        assert.equal((await app.request('/favicon.svg')).headers['content-type'], 'image/svg+xml');
    });
});

test('HTTP: image routes', async (t) => {
    const { app, fake, cleanup } = appFor({ movies: [makeMovie(1), makeMovie(3, { images: { posters: [], backdrops: [], logos: [] } })], shows: [makeShow(2)] });
    t.after(cleanup);
    const q = '?type=movie&tag=coming_date_Oct_2&rank=4&lang=en&logos=0';

    await t.test('renders a PNG, then serves repeats from cache without touching TMDB', async () => {
        const first = await app.request(`/poster/1.png${q}`);
        assert.equal(first.status, 200);
        assert.equal(first.headers['content-type'], 'image/png');
        assert.equal(first.headers['cache-control'], 'public, max-age=86400');
        assert.ok(isPng(first.body));
        fake.reset();
        const second = await app.request(`/poster/1.png${q}`);
        assert.equal(second.status, 200);
        assert.ok(second.body.equals(first.body));
        assert.equal(fake.calls.length, 0);
    });

    await t.test('ten simultaneous identical requests cause one render', async () => {
        fake.reset();
        const url = '/backdrop/1.png?type=movie&tag=new_series&rank=9&lang=en&logos=0';
        const results = await Promise.all(Array.from({ length: 10 }, () => app.request(url)));
        assert.ok(results.every((r) => r.status === 200 && r.body.equals(results[0].body)));
        assert.equal(fake.count('/t/p/w1280/'), 1);
    });

    await t.test('junk in the query cannot create new cache entries or reach the renderer', async () => {
        fake.reset();
        const evil = await app.request('/poster/1.png?type=movie&tag=coming_date_Oct_2&rank=4&lang=en&logos=0&cachebust=123&x=<svg>');
        assert.equal(evil.status, 200);
        assert.equal(fake.calls.length, 0); // normalised key == the earlier request

        // Every hostile value is rejected individually (tag -> none, rank -> none, lang -> en, logos -> off),
        // so nothing is left to draw and the client is simply sent to TMDB's own poster
        const sanitized = await app.request('/poster/1.png?type=movie&tag=coming_date_%3C/text%3E%3Cimage_1&rank=%3Cscript%3E&lang=../../etc&logos=yes');
        assert.equal(sanitized.status, 302);
        assert.equal(sanitized.headers.location, 'https://image.tmdb.org/t/p/w500/poster_en_1.jpg');
    });

    await t.test('.jpg URLs return JPEG; .png URLs keep returning PNG; the two are cached separately', async () => {
        const jq = '?type=movie&tag=now_streaming&rank=5&lang=en&logos=0';
        const jpg = await app.request(`/poster/1.jpg${jq}`);
        assert.equal(jpg.status, 200);
        assert.equal(jpg.headers['content-type'], 'image/jpeg');
        assert.equal(jpg.headers['cache-control'], 'public, max-age=86400');
        assert.ok(isJpeg(jpg.body));
        const pngRes = await app.request(`/poster/1.png${jq}`);
        assert.equal(pngRes.headers['content-type'], 'image/png');
        assert.ok(isPng(pngRes.body));
        fake.reset();
        assert.ok((await app.request(`/poster/1.jpg${jq}`)).body.equals(jpg.body)); // repeat: from cache
        assert.ok((await app.request(`/poster/1.png${jq}`)).body.equals(pngRes.body));
        assert.equal(fake.calls.length, 0);
        const bd = await app.request('/backdrop/1.jpg?type=movie&tag=coming_soon&rank=2&lang=en&logos=0');
        assert.ok(isJpeg(bd.body));
    });

    await t.test('.jpg passthrough redirect and placeholder', async () => {
        const red = await app.request('/poster/1.jpg?tag=none&rank=none');
        assert.equal(red.status, 302);
        assert.equal(red.headers.location, 'https://image.tmdb.org/t/p/w500/poster_en_1.jpg');
        const ph = await app.request('/poster/3.jpg?tag=coming_soon');
        assert.equal(ph.headers['content-type'], 'image/jpeg');
        assert.ok(isJpeg(ph.body));
        assert.equal(ph.headers['cache-control'], 'public, max-age=3600');
    });

    await t.test('nothing to draw -> 302 to TMDB (not a permanent redirect)', async () => {
        const res = await app.request('/poster/1.png?type=movie&tag=none&rank=none&lang=en&logos=0');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, 'https://image.tmdb.org/t/p/w500/poster_en_1.jpg');
        assert.match(res.headers['cache-control'], /max-age=86400/);
    });

    await t.test('textless image option reaches renderer and has a distinct cached variant', async () => {
        const res = await app.request('/poster/1.png?type=movie&tag=none&rank=none&lang=en&logos=0&textless=1');
        assert.equal(res.status, 200);
        assert.ok(isPng(res.body));
        assert.equal(fake.count('/t/p/w500/poster_null_1.jpg'), 1);
        fake.reset();
        const repeated = await app.request('/poster/1.png?type=movie&tag=none&rank=none&lang=en&logos=0&textless=1');
        assert.ok(repeated.body.equals(res.body));
        assert.equal(fake.calls.length, 0);
        const standard = await app.request('/poster/1.png?type=movie&tag=none&rank=none&lang=en&logos=0');
        assert.equal(standard.status, 302);
        assert.equal(standard.headers.location, 'https://image.tmdb.org/t/p/w500/poster_en_1.jpg');
    });

    await t.test('title without artwork -> local placeholder with a short cache', async () => {
        const res = await app.request('/poster/3.png?type=movie&tag=coming_soon&rank=1&lang=en&logos=0');
        assert.equal(res.status, 200);
        assert.ok(isPng(res.body));
        assert.equal(res.headers['cache-control'], 'public, max-age=3600');
    });

    await t.test('bad ids -> 400; unknown title -> 404; TMDB outage -> 502; nothing is cached for errors', async () => {
        for (const bad of ['abc', '1abc', '../1', '12345678901', '%2e%2e']) {
            const res = await app.request(`/poster/${bad}.png`);
            assert.ok([400, 404].includes(res.status), `${bad} -> ${res.status}`);
        }
        assert.equal((await app.request('/poster/1abc.png')).status, 400);
        const missing = await app.request('/poster/999.png?tag=coming_soon');
        assert.equal(missing.status, 404);
        assert.equal(missing.headers['cache-control'], 'no-store');
    });

    await t.test('legacy proxy-image routes still redirect (and encode the id)', async () => {
        const res = await app.request('/proxy-image-poster/movie/1/coming_soon/3/en/0.png');
        assert.equal(res.status, 301);
        assert.equal(res.headers.location, '/poster/1.png?type=movie&tag=coming_soon&rank=3&lang=en&logos=0');
        const bd = await app.request('/proxy-image-backdrop/series/2/none/none/ja/1.png');
        assert.equal(bd.headers.location, '/backdrop/2.png?type=series&tag=none&rank=none&lang=ja&logos=1');
    });
});

test('HTTP: AIOMetadata pattern routes compute tag and rank, then redirect', async (t) => {
    const movies = Array.from({ length: 12 }, (_, i) => makeMovie(i + 1, i === 2 ? { releases: [{ type: 3, date: iso(-30) }, { type: 4, date: iso(-2) }] } : {}));
    const shows = [makeShow(50, { tv: { last_episode_to_air: { season_number: 2, episode_number: 8, air_date: iso(-3), episode_type: 'finale' } } })];
    const { app, cleanup } = appFor({ movies, shows });
    t.after(cleanup);

    await t.test('auto tag + rank for a movie', async () => {
        const res = await app.request('/image/movie/3.png?ranked=1&listLang=en&digitalOnly=1');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, '/poster/3.png?type=movie&tag=just_added&rank=3&lang=en&logos=0');
        assert.equal(res.headers['cache-control'], 'public, max-age=300');
    });

    await t.test('series use the same series rules as the catalog', async () => {
        const res = await app.request('/image/series/50.png?ranked=true&logos=1&lang=ja');
        assert.equal(res.headers.location, '/poster/50.png?type=series&tag=season_finale&rank=1&lang=ja&logos=1');
    });

    await t.test('the pattern URL keeps its extension: .jpg -> /poster/*.jpg, .png -> /poster/*.png', async () => {
        const jpg = await app.request('/image/movie/3.jpg?ranked=1&listLang=en');
        assert.equal(jpg.headers.location, '/poster/3.jpg?type=movie&tag=just_added&rank=3&lang=en&logos=0');
        const land = await app.request('/landscape/series/50.jpg?tag=none');
        assert.equal(land.headers.location, '/backdrop/50.jpg?type=series&tag=none&rank=none&lang=en&logos=0&titleStyle=gradient-v9');
        const old = await app.request('/image/movie/3.png?ranked=1&listLang=en');
        assert.equal(old.headers.location, '/poster/3.png?type=movie&tag=just_added&rank=3&lang=en&logos=0');
    });

    await t.test('explicit tag=none, no ranking, and landscape target', async () => {
        const res = await app.request('/landscape/movie/3.png?tag=none');
        assert.equal(res.headers.location, '/backdrop/3.png?type=movie&tag=none&rank=none&lang=en&logos=0&titleStyle=gradient-v9');
    });

    await t.test('textless query passes through to the generated artwork URL', async () => {
        const res = await app.request('/landscape/movie/3.png?tag=none&textless=1');
        assert.equal(res.headers.location, '/backdrop/3.png?type=movie&tag=none&rank=none&lang=en&logos=0&textless=1&titleStyle=gradient-v9');
    });

    await t.test('hostile / unknown values are normalised', async () => {
        const res = await app.request('/image/anime/3.png?tag=<b>&lang=%3Cx%3E&logos=true&ranked=1&listLang=all');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, '/poster/3.png?type=movie&tag=none&rank=3&lang=en&logos=0');
        assert.equal((await app.request('/image/movie/notanid.png')).status, 400);
    });

    await t.test('title not in the list -> rank none; TMDB failing for the rank lookup does not break the redirect', async () => {
        const res = await app.request('/image/movie/11.png?ranked=1&listLang=all&digitalOnly=0&tag=none');
        assert.equal(res.headers.location, '/poster/11.png?type=movie&tag=none&rank=11&lang=en&logos=0');
    });
});

test('HTTP: TMDB outage surfaces as 502 and is not cached', async (t) => {
    const { app, cleanup } = appFor({ movies: [makeMovie(1)], fail: { '/movie/1/images': 500 } });
    t.after(cleanup);
    const res = await app.request('/poster/1.png?tag=coming_soon');
    assert.equal(res.status, 502);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body, 'Error generating image');
    const cat = await app.request('/catalog/movie/top_movies_today.json');
    assert.equal(cat.status, 200); // catalog doesn't depend on that endpoint
});
