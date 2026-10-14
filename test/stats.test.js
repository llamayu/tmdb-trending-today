'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createStats, normalizeIp, classifyRoute, classifyAgent, describeSetup, configSegment } = require('../src/stats');
const { registerAdminRoutes } = require('../src/routes/admin');
const { loadEnv } = require('../src/env');

const silent = { error() {}, warn() {}, log() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
const clock = (iso) => { let t = Date.parse(iso); const f = () => new Date(t); f.advance = (ms) => { t += ms; }; return f; };
const mk = (opts = {}) => createStats({ logger: silent, autoFlush: false, geo: () => 'US', ...opts });
const hit = (stats, ip, p, extra = {}) => stats.record({ ip, path: p, query: {}, status: 200, ms: 5, ua: 'Stremio/4.4 (Windows)', ...extra });

test('normalizeIp: IPv4 stays, IPv6 collapses to its /64, junk is rejected', () => {
    assert.equal(normalizeIp('203.0.113.9'), '203.0.113.9');
    assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:0db8:0001:0002::/64');
    // two addresses of the same phone (rotating privacy suffix) are one visitor
    assert.equal(normalizeIp('2001:db8:1:2::1'), normalizeIp('2001:db8:1:2:ffff:eeee:dddd:cccc'));
    assert.equal(normalizeIp('::1'), '0000:0000:0000:0000::/64');
    assert.equal(normalizeIp('not an ip'), null);
    assert.equal(normalizeIp(undefined), null);
});

test('classifyRoute', () => {
    const cases = {
        '/': 'configure', '/configure': 'configure', '/abc/configure': 'configure',
        '/manifest.json': 'manifest', '/cfg/manifest.json': 'manifest',
        '/catalog/movie/top.json': 'catalog', '/cfg/catalog/movie/top.json': 'catalog',
        '/poster/1.jpg': 'poster', '/backdrop/1.png': 'backdrop',
        '/image/movie/1.jpg': 'redirect', '/landscape/series/1.jpg': 'redirect',
        '/wp-login.php': 'other',
        '/healthz': null, '/favicon.svg': null, '/admin': null, '/admin/api/stats': null,
    };
    for (const [p, expected] of Object.entries(cases)) assert.equal(classifyRoute(p), expected, p);
});

test('classifyAgent', () => {
    assert.equal(classifyAgent('Stremio/4.4.168 (Windows NT 10.0)'), 'Stremio · Desktop');
    assert.equal(classifyAgent('Stremio Android 1.7'), 'Stremio · Android');
    assert.equal(classifyAgent('Mozilla/5.0 Chrome/120.0 Safari/537.36'), 'Browser · Chrome');
    assert.equal(classifyAgent('Mozilla/5.0 Firefox/121.0'), 'Browser · Firefox');
    assert.equal(classifyAgent('curl/8.4.0'), 'Bot / script');
    assert.equal(classifyAgent('Googlebot/2.1'), 'Bot / script');
    assert.equal(classifyAgent(''), 'Unknown');
    // apps and addons are grouped regardless of version
    for (const ua of ['Nuvio/0.8.12-beta', 'Nuvio/1.0.0', 'Nuvio/1.1.0-beta.5']) assert.equal(classifyAgent(ua), 'Nuvio', ua);
    assert.equal(classifyAgent('AIOStreams/2.35.9'), 'AIOStreams');
    assert.equal(classifyAgent('AIOMetadata/0.0.0-testing.20261010.2'), 'AIOMetadata');
    assert.equal(classifyAgent('Odin/1.2026.282 CFNetwork/3896.100.1.1.1 Darwin/27.0.0'), 'Odin'); // not "Apple app"
    assert.equal(classifyAgent('okhttp/5.3.2'), 'Android app');
    assert.equal(classifyAgent('node'), 'Bot / script');
    assert.equal(classifyAgent('ktor-client'), 'Other');
});

test('counts distinct visitors, installs, countries and clients; scanners are not users', () => {
    const stats = mk();
    hit(stats, '198.51.100.1', '/manifest.json');
    hit(stats, '198.51.100.1', '/catalog/movie/top.json');
    hit(stats, '198.51.100.1', '/poster/603.jpg', { query: { type: 'movie', tag: 'coming_soon', lang: 'en', rank: '3', logos: '1' }, ms: 2000 });
    hit(stats, '198.51.100.2', '/catalog/movie/top.json', { ua: 'Mozilla/5.0 Chrome/120 Safari/537' });
    hit(stats, '198.51.100.3', '/configure');
    hit(stats, '198.51.100.4', '/wp-login.php', { status: 404 });
    hit(stats, '198.51.100.1', '/healthz');
    hit(stats, '198.51.100.1', '/admin');
    hit(stats, '198.51.100.9', '/poster/1.jpg', { status: 500 });

    const r = stats.report(30);
    assert.equal(r.totals.users, 3); // .1, .2, .9
    assert.equal(r.totals.installs, 1);
    assert.equal(r.totals.configure, 1);
    assert.equal(r.totals.requests, 7); // health check and admin are ignored
    assert.equal(r.totals.errors, 1);
    assert.deepEqual(r.totals.today, { users: 3, installs: 1, configure: 1, requests: 7, errors: 1 });
    assert.deepEqual(r.countries, [['US', 3]]);
    assert.deepEqual(Object.fromEntries(r.agents), { 'Stremio · Desktop': 2, 'Browser · Chrome': 1 });
    assert.deepEqual(Object.fromEntries(r.routes), { poster: 2, catalog: 2, manifest: 1, configure: 1, other: 1 });
    assert.equal(r.timing.count, 2);
    assert.equal(r.timing.slow, 1);
    assert.equal(r.daily.at(-1).users, 3);
});

test('configSegment finds the install-URL settings, and only there', () => {
    assert.equal(configSegment('/posterTags=false|listLang=en/manifest.json'), 'posterTags=false|listLang=en');
    assert.equal(configSegment('/posterTags%3Dfalse%7ClistLang%3Den/catalog/movie/top.json'), 'posterTags=false|listLang=en');
    assert.equal(configSegment('/manifest.json'), null);
    assert.equal(configSegment('/catalog/movie/top.json'), null);
    assert.equal(configSegment('/poster/1.jpg'), null);
});

test('describeSetup: matches the configure page presets, otherwise Custom', () => {
    const cfg = (v) => `posterTags=${v[0]}|posterLogos=${v[1]}|posterRanked=${v[2]}|backdropTags=${v[3]}|backdropLogos=${v[4]}|backdropRanked=${v[5]}`;
    const bool = (bits) => [...bits].map((b) => (b === '1' ? 'true' : 'false'));
    assert.equal(describeSetup(cfg(bool('000000'))).preset, 'Clean');
    assert.equal(describeSetup(cfg(bool('001000'))).preset, 'Ranked');
    assert.equal(describeSetup(cfg(bool('101000'))).preset, 'Classic');
    assert.equal(describeSetup(cfg(bool('111000'))).preset, 'Everything');
    assert.equal(describeSetup(cfg(bool('010101'))).preset, 'Custom');
    assert.equal(describeSetup(null).preset, 'Not configured');
    assert.equal(describeSetup('garbage-without-equals').preset, 'Not configured');

    const o = Object.fromEntries(describeSetup('posterTags=false|posterLanguage=null|listLang=en,ja|posterShape=landscape|digitalOnly=false').options);
    assert.deepEqual(
        [o['Poster tags'], o['Poster language'], o['Catalog languages'], o['Poster shape'], o['Digital releases only']],
        ['off', 'Textless', 'en,ja', 'landscape', 'off'],
    );
});

test('setups: counts people (not requests) per preset and per option, with a total', () => {
    const stats = mk();
    const clean = 'posterTags=false|posterLogos=false|posterRanked=false|backdropTags=false|backdropLogos=false|backdropRanked=false|listLang=en';
    const ranked = 'posterTags=false|posterLogos=false|posterRanked=true|backdropTags=false|backdropLogos=false|backdropRanked=false|listLang=all';
    hit(stats, '198.51.100.1', `/${clean}/manifest.json`);
    hit(stats, '198.51.100.1', `/${clean}/catalog/movie/top.json`); // same person, same setup: still one
    hit(stats, '198.51.100.2', `/${ranked}/catalog/movie/top.json`);
    hit(stats, '198.51.100.3', `/${ranked}/manifest.json`);
    hit(stats, '198.51.100.4', '/manifest.json'); // installed without configuring
    hit(stats, '198.51.100.5', '/poster/1.jpg'); // artwork only: no setup info, so not part of this view

    const { setups } = stats.report(30);
    assert.equal(setups.total, 4);
    assert.deepEqual(Object.fromEntries(setups.presets), { Ranked: 2, Clean: 1, 'Not configured': 1 });
    const ranking = setups.options.find((o) => o.label === 'Poster ranking');
    assert.deepEqual(ranking.values, [['on', 2], ['off', 1]]);
    const langs = Object.fromEntries(setups.options.find((o) => o.label === 'Catalog languages').values);
    assert.deepEqual(langs, { all: 2, en: 1 });
});

test('junk URLs cannot create setup entries', () => {
    const stats = mk();
    hit(stats, '198.51.100.1', `/${'x=' + 'y'.repeat(300)}/manifest.json`);
    hit(stats, '198.51.100.1', '/%E0%A4%A/manifest.json'); // malformed percent-encoding must not throw
    const { setups } = stats.report(7);
    assert.ok(setups.total <= 1);
});

test('a returning visitor counts once in any range', () => {
    const now = clock('2026-03-10T12:00:00Z');
    const stats = mk({ now });
    hit(stats, '198.51.100.1', '/manifest.json');
    now.advance(86_400_000);
    hit(stats, '198.51.100.1', '/manifest.json');
    hit(stats, '198.51.100.2', '/manifest.json');
    const r = stats.report(14);
    assert.equal(r.totals.today.users, 2);
    assert.equal(r.totals.users, 2); // the returning visitor counts once
    assert.equal(r.daily.at(-2).users, 1);
});

test('persists across restarts, never writes raw IPs, and keeps the same visitor hash', () => {
    const dir = tmp();
    const now = clock('2026-03-10T12:00:00Z');
    try {
        const a = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'DE' });
        hit(a, '198.51.100.77', '/manifest.json');
        a.stop();

        const raw = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8');
        assert.ok(!raw.includes('198.51.100.77'), 'raw IP must not be stored');

        const b = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'DE' });
        assert.equal(b.report(7).totals.today.users, 1);
        hit(b, '198.51.100.77', '/manifest.json'); // same visitor after a restart
        assert.equal(b.report(7).totals.today.users, 1);
        hit(b, '198.51.100.78', '/manifest.json');
        assert.equal(b.report(7).totals.today.users, 2);
        b.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt stats file is set aside, not fatal', () => {
    const dir = tmp();
    try {
        fs.writeFileSync(path.join(dir, 'stats.json'), '{ nope');
        const stats = createStats({ dir, logger: silent, autoFlush: false, geo: () => null });
        assert.equal(stats.report(7).totals.today.requests, 0);
        assert.ok(fs.existsSync(path.join(dir, 'stats.json.corrupt')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('days past the retention window shrink to totals', () => {
    const dir = tmp();
    const now = clock('2026-03-01T12:00:00Z');
    try {
        const a = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'US' });
        hit(a, '198.51.100.1', '/manifest.json');
        hit(a, '198.51.100.2', '/manifest.json');
        a.stop();
        now.advance(40 * 86_400_000);
        const b = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'US' });
        const r = b.report(90);
        const old = r.daily.find((d) => d.date === '2026-03-01');
        assert.equal(old.users, 2); // the daily number survives…
        assert.equal(r.totals.users, 2); // (90 days still reaches back to them)
        assert.equal(b.report(30).totals.users, 0); // …and 30 days no longer does
        assert.equal(b.report('all').totals.users, 2);
        b.stop();
        assert.ok(!fs.readFileSync(path.join(dir, 'stats.json'), 'utf8').includes('"users":["')); // per-day visitor lists are gone
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('middleware records after the response finishes, using the proxy-aware req.ip', () => {
    const stats = mk();
    const req = { ip: '198.51.100.5', path: '/manifest.json', query: {}, headers: { 'user-agent': 'Stremio/4.4' } };
    const res = new EventEmitter();
    res.statusCode = 200;
    let called = false;
    stats.middleware(req, res, () => { called = true; });
    assert.ok(called);
    assert.equal(stats.report(7).totals.today.requests, 0); // not yet
    res.emit('finish');
    assert.equal(stats.report(7).totals.today.users, 1);
});

// ─── Admin routes ────────────────────────────────────────────────────────────

function adminHarness(token = 'a-long-enough-secret', extra = {}) {
    const routes = {};
    registerAdminRoutes(
        { get: (p, fn) => { routes[p] = fn; }, post: (p, fn) => { routes[`POST ${p}`] = fn; } },
        { stats: mk(), token, html: '<html>admin</html>', logger: silent, ...extra },
    );
    const call = (p, { auth, ip = '203.0.113.1', query = {} } = {}) => {
        const out = { headers: {}, status: 200 };
        const res = {
            set(h, v) { Object.assign(out.headers, typeof h === 'object' ? h : { [h]: v }); return res; },
            status(c) { out.status = c; return res; },
            type() { return res; },
            send(b) { out.body = b; return res; },
            json(b) { out.body = b; return res; },
        };
        const done = routes[p]({ ip, query, headers: auth ? { authorization: auth } : {} }, res);
        return done && typeof done.then === 'function' ? done.then(() => out) : out;
    };
    return { call };
}

test('admin: page is served with noindex; API needs the right bearer token', () => {
    const { call } = adminHarness();
    const page = call('/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers['X-Robots-Tag'], /noindex/);
    assert.equal(page.headers['Cache-Control'], 'no-store');

    assert.equal(call('/admin/api/stats').status, 401);
    assert.equal(call('/admin/api/stats', { auth: 'Bearer wrong' }).status, 401);
    assert.equal(call('/admin/api/stats', { auth: 'a-long-enough-secret' }).status, 401); // must be a Bearer header
    const ok = call('/admin/api/stats', { auth: 'Bearer a-long-enough-secret' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.totals);
});

test('admin: repeated wrong tokens get rate limited, per IP', () => {
    const { call } = adminHarness();
    for (let i = 0; i < 10; i++) assert.equal(call('/admin/api/stats', { auth: 'Bearer nope' }).status, 401);
    assert.equal(call('/admin/api/stats', { auth: 'Bearer nope' }).status, 429);
    assert.equal(call('/admin/api/stats', { auth: 'Bearer a-long-enough-secret' }).status, 429); // locked out even with the right one
    assert.equal(call('/admin/api/stats', { auth: 'Bearer a-long-enough-secret', ip: '203.0.113.2' }).status, 200); // other IPs unaffected
});

// ─── Env ─────────────────────────────────────────────────────────────────────

test('env: dashboard is off by default, token must be long enough, geo and proxy have sane defaults', () => {
    const good = { TMDB_API_KEY: 'k', ADDON_URL: 'https://addon.test' };
    const off = loadEnv(good);
    assert.equal(off.statsToken, '');
    assert.equal(off.statsGeo, true);
    assert.match(off.trustProxy, /uniquelocal/);
    assert.throws(() => loadEnv({ ...good, STATS_TOKEN: 'short' }), /STATS_TOKEN/);
    const on = loadEnv({ ...good, STATS_TOKEN: 'x'.repeat(24), STATS_DIR: '/data/stats', STATS_GEO: '0' });
    assert.deepEqual([on.statsToken.length, on.statsDir, on.statsGeo], [24, path.resolve('/data/stats'), false]);
});

test('user agents: distinct people, requests and what each one asks for', () => {
    const stats = mk();
    const client = 'okhttp/4.12.0';
    const loader = 'okhttp/5.3.2';
    hit(stats, '198.51.100.1', '/manifest.json', { ua: client });
    hit(stats, '198.51.100.1', '/catalog/movie/top.json', { ua: client });
    hit(stats, '198.51.100.2', '/catalog/movie/top.json', { ua: client });
    hit(stats, '198.51.100.3', '/poster/1.jpg', { ua: loader });
    hit(stats, '198.51.100.3', '/poster/2.jpg', { ua: loader });
    hit(stats, '198.51.100.3', '/backdrop/2.jpg', { ua: loader });

    const [first, second] = stats.report(30).userAgents;
    assert.equal(first.ua, client);
    assert.equal(first.users, 2);
    assert.equal(first.requests, 3);
    assert.deepEqual(Object.fromEntries(first.routes), { catalog: 2, manifest: 1 });
    assert.equal(second.ua, loader);
    assert.equal(second.users, 1);
    assert.equal(second.requests, 3);
    assert.deepEqual(Object.fromEntries(second.routes), { poster: 2, backdrop: 1 });
});

test('user agents survive a restart and old-format files load without error', () => {
    const dir = tmp();
    const now = clock('2026-03-10T12:00:00Z');
    try {
        const a = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'US' });
        hit(a, '198.51.100.1', '/manifest.json', { ua: 'okhttp/4.12.0' });
        a.stop();
        const b = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'US' });
        assert.equal(b.report(7).userAgents[0].users, 1);
        b.stop();

        // a file written by the first dashboard version (no `uas`, counter-style `agentsRaw`)
        const file = path.join(dir, 'stats.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const d of Object.values(data.days)) { delete d.uas; d.agentsRaw = { 'okhttp/4.12.0': 5 }; }
        fs.writeFileSync(file, JSON.stringify(data));
        const c = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'US' });
        assert.deepEqual(c.report(7).userAgents, []);
        c.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── Performance metrics ─────────────────────────────────────────────────────

const { unionMs, instrumentTmdb, instrumentArtwork } = require('../src/metrics');
const { createLimiter } = require('../src/util');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('unionMs counts overlapping waits once', () => {
    assert.equal(unionMs([]), 0);
    assert.equal(unionMs([[0, 10]]), 10);
    assert.equal(unionMs([[0, 10], [5, 20]]), 20);
    assert.equal(unionMs([[0, 10], [2, 4], [30, 35]]), 15);
    assert.equal(unionMs([[30, 35], [0, 10]]), 15); // order doesn't matter
});

test('timings: averages, approximate percentiles, counters and peaks', () => {
    const stats = mk();
    for (const ms of [3, 4, 8, 20, 40, 90, 200, 400, 900, 3000]) stats.metrics.time('render.total', ms);
    stats.metrics.count('artwork.hit', 8);
    stats.metrics.count('artwork.image', 2);
    stats.metrics.gauge('render.inFlight', 3);
    stats.metrics.gauge('render.inFlight', 7);
    stats.metrics.gauge('render.inFlight', 2);
    const p = stats.report(7).performance;
    const t = p.timings['render.total'];
    assert.equal(t.count, 10);
    assert.equal(t.avgMs, 466.5);
    assert.equal(t.maxMs, 3000);
    assert.ok(t.p50Ms >= 20 && t.p50Ms <= 50, `p50 ${t.p50Ms}`);
    assert.ok(t.p95Ms >= 900 && t.p95Ms <= 3000, `p95 ${t.p95Ms}`);
    assert.deepEqual(p.outcomes, { cached: 8, rendered: 2, passedThrough: 0, passedThroughCached: 0, placeholder: 0 });
    assert.equal(p.hitRate, 0.8);
    assert.equal(p.inFlightPeak, 7);
});

test('instrumented renders split TMDB waiting from local work, even through the render limiter', async () => {
    const stats = mk();
    const limit = createLimiter(1);
    const tmdbRaw = { json: async () => { await sleep(60); return {}; }, image: async () => { await sleep(60); return Buffer.alloc(1); }, imageUrl: () => 'u' };
    const tmdb = instrumentTmdb(tmdbRaw, stats.metrics);
    // like the real renderer: TMDB lookups first, then local work (plus a TMDB download) inside the limiter
    const artworkRaw = {
        async render() {
            await Promise.all([tmdb.json(), tmdb.json()]); // overlapping calls: ~30 ms of waiting, not 60
            await limit(async () => { await sleep(40); await tmdb.image(); });
            return { kind: 'image' };
        },
    };
    const artwork = instrumentArtwork(artworkRaw, stats.metrics);
    await Promise.all([artwork.render(), artwork.render(), artwork.render()]); // 3 at once, 1 slot: the others queue

    const p = stats.report(7).performance;
    assert.equal(p.timings['render.total'].count, 3);
    assert.equal(p.inFlightPeak, 3);
    // The two lookups overlap, so a render's TMDB wait is about one lookup plus the download (~120 ms), not
    // both lookups added up (~180 ms). Compared against the measured call times so a busy machine can't break it.
    const tmdbAvg = p.timings['render.tmdb'].avgMs;
    const api = p.timings['tmdb.api'].avgMs;
    const image = p.timings['tmdb.image'].avgMs;
    assert.ok(tmdbAvg >= image + 0.8 * api, `tmdb avg ${tmdbAvg} should cover one lookup plus the download`);
    assert.ok(tmdbAvg < image + 1.6 * api, `tmdb avg ${tmdbAvg} must not add the overlapping lookups together`);
    assert.ok(p.timings['render.local'].avgMs > 35, `local avg ${p.timings['render.local'].avgMs}`);
    assert.equal(p.timings['tmdb.api'].count, 6);
    assert.equal(p.timings['tmdb.image'].count, 3);
    assert.ok(p.timings['render.local'].maxMs > p.timings['render.local'].avgMs); // the last in the queue waited longest
});

test('metrics are no-ops when the dashboard is off', () => {
    const { NOOP_METRICS } = require('../src/metrics');
    const tmdb = { json() {}, image() {} };
    const artwork = { render() {} };
    assert.equal(instrumentTmdb(tmdb, NOOP_METRICS), tmdb);
    assert.equal(instrumentArtwork(artwork, NOOP_METRICS), artwork);
});

test('process sample records CPU, memory and lag', () => {
    const stats = createStats({ logger: silent, autoFlush: false, sampleProcess: true, geo: () => null });
    try {
        stats.sample();
        const p = stats.report(7).performance;
        assert.equal(p.proc.samples, 1);
        assert.ok(p.proc.rssMax > 10 * 1024 * 1024);
        assert.ok(p.proc.cpuAvg >= 0);
    } finally { stats.stop(); }
});

test('hints name the bottleneck in plain language', () => {
    const feed = (stats, name, ms, n) => { for (let i = 0; i < n; i++) stats.metrics.time(name, ms); };

    const waiting = mk({ renderConcurrency: 2 });
    feed(waiting, 'render.total', 1000, 30); feed(waiting, 'render.tmdb', 800, 30); feed(waiting, 'render.local', 200, 30);
    assert.match(waiting.report(7).performance.hints.join(' '), /waiting on TMDB/);

    const cpu = mk({ renderConcurrency: 2 });
    feed(cpu, 'render.total', 1000, 30); feed(cpu, 'render.tmdb', 200, 30); feed(cpu, 'render.local', 800, 30);
    cpu.metrics.gauge('render.inFlight', 6);
    const text = cpu.report(7).performance.hints.join(' ');
    assert.match(text, /local/);
    assert.match(text, /RENDER_CONCURRENCY/);

    const quiet = mk();
    assert.match(quiet.report(7).performance.hints[0], /Not enough renders/);
});

test('limiter keeps each task in the context of whoever queued it', async () => {
    const { AsyncLocalStorage } = require('async_hooks');
    const als = new AsyncLocalStorage();
    const limit = createLimiter(1);
    const seen = [];
    await Promise.all(['a', 'b', 'c'].map((id) => als.run(id, () => limit(async () => { await sleep(5); seen.push([id, als.getStore()]); }))));
    assert.deepEqual(seen, [['a', 'a'], ['b', 'b'], ['c', 'c']]);
});

// ─── Timezone ────────────────────────────────────────────────────────────────

test('timezone: a day ends at midnight in the configured zone, not UTC', () => {
    const tokyo = mk({ now: clock('2026-03-10T16:00:00Z'), timezone: 'Asia/Tokyo' }); // 01:00 on the 11th in Tokyo
    hit(tokyo, '198.51.100.1', '/manifest.json');
    const t = tokyo.report(7);
    assert.equal(t.timezone, 'Asia/Tokyo');
    assert.equal(t.today, '2026-03-11');
    assert.equal(t.daily.at(-1).date, '2026-03-11');
    assert.equal(t.daily.at(-1).users, 1);

    const la = mk({ now: clock('2026-03-10T03:00:00Z'), timezone: 'America/Los_Angeles' }); // still the 9th there (PDT)
    assert.equal(la.report(7).today, '2026-03-09');

    const utc = mk({ now: clock('2026-03-10T16:00:00Z') });
    assert.equal(utc.report(7).timezone, 'UTC');
    assert.equal(utc.report(7).today, '2026-03-10');
});

test('timezone: the daily counters reset at local midnight', () => {
    const now = clock('2026-03-10T23:30:00Z'); // 19:30 in New York (EDT)
    const stats = mk({ now, timezone: 'America/New_York' });
    hit(stats, '198.51.100.1', '/manifest.json');
    assert.equal(stats.report(7).totals.today.users, 1);
    now.advance(5 * 3_600_000); // 00:30 on the 11th in New York, still the 11th (04:30) in UTC
    const r = stats.report(7);
    assert.equal(r.today, '2026-03-11');
    assert.equal(r.totals.today.users, 0);
    assert.equal(r.daily.at(-2).users, 1);
    assert.equal(r.totals.users, 1); // still inside the 7-day range
});

test('timezone: an invalid value falls back to UTC with a warning instead of failing', () => {
    const warnings = [];
    const stats = mk({ now: clock('2026-03-10T16:00:00Z'), timezone: 'Not/AZone', logger: { ...silent, warn: (m) => warnings.push(m) } });
    assert.equal(stats.report(7).timezone, 'UTC');
    assert.equal(stats.report(7).today, '2026-03-10');
    assert.match(warnings.join(' '), /not a valid timezone/);
});

test('env: TZ is passed through for the dashboard, empty by default', () => {
    const good = { TMDB_API_KEY: 'k', ADDON_URL: 'https://addon.test' };
    assert.equal(loadEnv(good).statsTimezone, '');
    assert.equal(loadEnv({ ...good, TZ: ' Europe/Berlin ' }).statsTimezone, 'Europe/Berlin');
});

// ─── Time ranges ─────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const cfg = (v) => `/posterTags=${v}|listLang=en/manifest.json`;

test('every figure follows the selected range', () => {
    const now = clock('2026-01-01T12:00:00Z');
    const country = { '198.51.100.1': 'US', '198.51.100.2': 'DE', '198.51.100.3': 'JP' };
    const stats = mk({ now, geo: (ip) => country[ip] });

    // day 0: A (US, Nuvio, tags off); day 10: B (DE, Odin, tags on); day 40: C (JP) and A comes back
    hit(stats, '198.51.100.1', cfg('false'), { ua: 'Nuvio/1.0.0' });
    hit(stats, '198.51.100.1', '/poster/1.jpg');
    now.advance(10 * DAY);
    hit(stats, '198.51.100.2', cfg('true'), { ua: 'Odin/1.2026.282 CFNetwork/3896 Darwin/27' });
    now.advance(30 * DAY); // day 40
    hit(stats, '198.51.100.3', cfg('true'), { ua: 'okhttp/4.12.0' });
    hit(stats, '198.51.100.1', '/catalog/movie/top.json', { ua: 'Nuvio/1.0.0' });

    const users = (range) => stats.report(range).totals.users;
    assert.equal(users(7), 2); // C and A
    assert.equal(users(30), 2); // B was last seen 30 days ago, just outside
    assert.equal(users(90), 3);
    assert.equal(users('all'), 3);

    // new people: first seen inside the range, ignoring those present on the very first day of data
    assert.equal(stats.report(7).totals.newUsers, 1); // C
    assert.equal(stats.report(90).totals.newUsers, 2); // B and C (A was already there on day 0)

    // countries, clients and setups only count people active in the range
    assert.deepEqual(stats.report(7).countries.map(([c]) => c).sort(), ['JP', 'US']);
    assert.deepEqual(stats.report('all').countries.map(([c]) => c).sort(), ['DE', 'JP', 'US']);
    assert.deepEqual(Object.fromEntries(stats.report(7).agents), { Nuvio: 1, 'Android app': 1 });
    assert.equal(stats.report(7).setups.total, 2); // A (tags off, latest known) and C
    assert.equal(stats.report('all').setups.total, 3);
    const tags = (range) => Object.fromEntries(stats.report(range).setups.options.find((o) => o.label === 'Poster tags').values);
    assert.deepEqual(tags(7), { off: 1, on: 1 });
    assert.deepEqual(tags('all'), { off: 1, on: 2 });

    // counters follow it too
    assert.equal(stats.report(7).totals.requests, 2);
    assert.equal(stats.report('all').totals.requests, 5);
    assert.equal(stats.report(7).range.key, '7');
    assert.equal(stats.report('all').range.key, 'all');
    assert.equal(stats.report('all').range.since, '2026-01-01');
    assert.equal(stats.report(7).daily.length, 7);
    assert.equal(stats.report('all').daily.length, 41);
});

test('all time works with no data, and an unknown range falls back to 30 days', () => {
    const stats = mk({ now: clock('2026-03-10T12:00:00Z') });
    const empty = stats.report('all');
    assert.equal(empty.range.days, 1);
    assert.equal(empty.totals.users, 0);
    assert.equal(stats.report('nonsense').range.days, 30);
    assert.equal(stats.report(0).range.days, 30);
    assert.equal(stats.report(9999).range.days, 365);
});

test('long ranges are averaged into buckets so the chart stays readable', () => {
    const now = clock('2026-01-01T12:00:00Z');
    const stats = mk({ now });
    hit(stats, '198.51.100.1', '/manifest.json');
    now.advance(300 * DAY);
    hit(stats, '198.51.100.2', '/manifest.json');
    const r = stats.report('all');
    assert.equal(r.range.days, 301);
    assert.ok(r.bucketDays > 1);
    assert.ok(r.daily.length <= 100, `${r.daily.length} buckets`);
    assert.equal(r.daily.reduce((a, b) => a + b.requests, 0), 2); // nothing lost in the averaging
    assert.equal(stats.report(30).bucketDays, 1);
});

test('performance numbers survive compaction, so long ranges still have them', () => {
    const dir = tmp();
    const now = clock('2026-01-01T12:00:00Z');
    try {
        const a = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'US' });
        for (let i = 0; i < 25; i++) a.metrics.time('render.total', 800);
        a.metrics.count('artwork.hit', 5);
        a.stop();
        now.advance(60 * DAY); // the day is now older than the detail window
        const b = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => 'US' });
        assert.equal(b.report(30).performance.timings['render.total'], undefined); // not in the 30-day range
        const wide = b.report(90).performance;
        assert.equal(wide.timings['render.total'].count, 25);
        assert.equal(wide.outcomes.cached, 5);
        assert.equal(b.report('all').performance.timings['render.total'].count, 25);
        b.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('client detail only covers the detail window, and says so', () => {
    const stats = mk({ now: clock('2026-03-10T12:00:00Z') });
    assert.equal(stats.report(7).userAgentDays, 7);
    assert.equal(stats.report(90).userAgentDays, 30);
    assert.equal(stats.report('all').userAgentDays, 1); // only one day of data exists so far
});

test('upgrading from the first stats file format keeps every number', () => {
    const dir = tmp();
    const file = path.join(dir, 'stats.json');
    const legacyDay = {
        requests: 6, errors: 0, clientErrors: 0, routes: { manifest: 2, catalog: 3, poster: 1 },
        titles: { 'movie/1': 4 }, uas: {}, timing: { count: 0, totalMs: 0, maxMs: 0, slow: 0 },
        users: ['aaaa', 'bbbb'], installs: ['aaaa'], configure: ['cccc'],
        countries: { US: ['aaaa', 'bbbb'] },
        agents: { Nuvio: ['aaaa'], 'Browser · Chrome': ['bbbb'] },
        presets: { Clean: ['aaaa'], 'Not configured': ['bbbb'] },
        options: { 'Poster tags|off': ['aaaa'], 'Catalog languages|en': ['aaaa'] },
    };
    try {
        fs.writeFileSync(file, JSON.stringify({ version: 1, salt: 'old-salt', days: { '2026-03-09': legacyDay } }));
        const stats = createStats({ dir, now: clock('2026-03-10T12:00:00Z'), logger: silent, autoFlush: false, geo: () => null });
        const r = stats.report(30);
        assert.equal(r.totals.users, 2);
        assert.equal(r.totals.installs, 1);
        assert.equal(r.totals.configure, 1);
        assert.equal(r.totals.requests, 6);
        assert.deepEqual(r.countries, [['US', 2]]);
        assert.deepEqual(Object.fromEntries(r.agents), { Nuvio: 1, 'Browser · Chrome': 1 });
        assert.equal(r.setups.total, 2);
        assert.deepEqual(Object.fromEntries(r.setups.presets), { Clean: 1, 'Not configured': 1 });
        assert.deepEqual(r.setups.options.find((o) => o.label === 'Poster tags').values, [['off', 1]]);
        assert.equal(stats.report('all').totals.users, 2);

        stats.stop(); // rewrites the file in the new format
        const written = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(written.version, 2);
        assert.equal(Object.keys(written.visitors).length, 3);
        assert.equal(written.salt, 'old-salt'); // same salt: yesterday's visitors stay recognisable
        assert.equal(written.days['2026-03-09'].countries, undefined); // the heavy per-day lists are gone
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── Today, and what the errors were ─────────────────────────────────────────

const { errorHandler } = require('../src/http');

test('Today is a one-day range, with a 7-day chart for context', () => {
    const now = clock('2026-03-10T12:00:00Z');
    const stats = mk({ now });
    hit(stats, '198.51.100.1', '/manifest.json');
    now.advance(DAY);
    hit(stats, '198.51.100.2', '/manifest.json');
    hit(stats, '198.51.100.2', '/catalog/movie/top.json');
    const r = stats.report(1);
    assert.equal(r.range.days, 1);
    assert.equal(r.range.start, '2026-03-11');
    assert.equal(r.totals.users, 1); // yesterday's visitor is not part of today
    assert.equal(r.totals.requests, 2);
    assert.equal(r.daily.length, 7); // just the chart, for context
    assert.equal(r.chartDays, 7);
    assert.equal(stats.report(7).chartDays, 7);
    assert.equal(stats.report(30).chartDays, 30);
});

test('server errors keep what they were, grouped, newest details first', () => {
    const now = clock('2026-03-10T12:00:00Z');
    const stats = mk({ now });
    const fail = (p, status, error, extra = {}) => stats.record({ ip: '198.51.100.1', path: p, query: {}, status, ms: 5, ua: 'x', error, ...extra });
    fail('/poster/603.jpg', 502, { kind: 'tmdb', message: 'TMDB responded 503' });
    now.advance(60_000);
    fail('/poster/604.jpg', 502, { kind: 'tmdb', message: 'TMDB responded 503' });
    fail('/backdrop/9.jpg', 500, { kind: 'internal', message: 'Input buffer contains unsupported image format' });
    fail('/catalog/movie/top.json', 500, null); // nothing recorded about this one
    stats.record({ ip: '198.51.100.1', path: '/poster/1.jpg', status: 404, ms: 1, ua: 'x' }); // not a server error

    const r = stats.report(7);
    assert.equal(r.totals.errors, 4);
    assert.equal(r.errorDetails.length, 3);
    const [first, ...rest] = r.errorDetails;
    assert.deepEqual([first.status, first.route, first.kind, first.message, first.count], [502, 'poster', 'tmdb', 'TMDB responded 503', 2]);
    assert.equal(first.example, '/poster/604.jpg'); // the latest occurrence
    assert.equal(first.last, '2026-03-10T12:01:00.000Z');
    assert.deepEqual(rest.map((e) => [e.status, e.route, e.kind]).sort(), [[500, 'backdrop', 'internal'], [500, 'catalog', 'internal']]);
    assert.equal(rest.find((e) => e.route === 'catalog').message, 'No details recorded');
    assert.equal(r.errorDetailDays, 7);
});

test('error details are merged across days, and keys never reach the dashboard', () => {
    const now = clock('2026-03-10T12:00:00Z');
    const stats = mk({ now });
    const fail = (message) => stats.record({ ip: '198.51.100.1', path: '/poster/1.jpg', status: 502, ms: 1, ua: 'x', error: { kind: 'tmdb', message } });
    fail('fetch failed for https://api.themoviedb.org/3/movie/1?api_key=SECRET123&language=en');
    now.advance(DAY);
    fail('fetch failed for https://api.themoviedb.org/3/movie/1?api_key=SECRET123&language=en');
    const r = stats.report(7);
    assert.equal(r.errorDetails.length, 1);
    assert.equal(r.errorDetails[0].count, 2);
    assert.ok(!JSON.stringify(r).includes('SECRET123'));
    assert.match(r.errorDetails[0].message, /api_key=…/);
    assert.ok(r.errorDetails[0].message.length <= 160);
});

test('error log is bounded, and old days keep the count but drop the details', () => {
    const dir = tmp();
    const now = clock('2026-01-01T12:00:00Z');
    try {
        const a = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => null });
        for (let i = 0; i < 80; i++) a.record({ ip: '198.51.100.1', path: '/poster/1.jpg', status: 500, ms: 1, ua: 'x', error: { message: `unique failure ${i}` } });
        assert.equal(a.report(7).errorDetails.length, 20); // top 20 shown
        assert.equal(a.report(7).totals.errors, 80); // every error still counted
        a.stop();
        now.advance(40 * DAY);
        const b = createStats({ dir, now, logger: silent, autoFlush: false, geo: () => null });
        assert.equal(b.report('all').totals.errors, 80);
        assert.deepEqual(b.report('all').errorDetails, []);
        assert.equal(b.report('all').errorDetailDays, 30);
        b.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the error handler hands the dashboard what went wrong, and the middleware records it', () => {
    const quiet = { error() {}, warn() {}, log() {} };
    const run = (err) => {
        const res = Object.assign(new EventEmitter(), {
            locals: {}, headersSent: false, statusCode: 200,
            set() { return this; }, status(c) { this.statusCode = c; return this; }, type() { return this; },
            json() { return this; }, send() { return this; },
        });
        errorHandler(quiet)(err, { method: 'GET', originalUrl: '/poster/1.jpg', path: '/poster/1.jpg' }, res, () => {});
        return res;
    };
    const upstream = Object.assign(new Error('TMDB responded 503'), { name: 'TmdbError', status: 503 });
    const res = run(upstream);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.locals.statsError, { kind: 'tmdb', message: 'TMDB responded 503' });
    assert.deepEqual(run(new TypeError('boom')).locals.statsError, { kind: 'internal', message: 'boom' });

    // end to end through the middleware
    const stats = mk();
    const req = { ip: '198.51.100.5', path: '/poster/1.jpg', query: {}, headers: { 'user-agent': 'x' } };
    stats.middleware(req, res, () => {});
    res.emit('finish');
    const [e] = stats.report(7).errorDetails;
    assert.deepEqual([e.status, e.kind, e.message], [502, 'tmdb', 'TMDB responded 503']);
});
