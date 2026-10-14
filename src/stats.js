'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const { parseUserConfig, parseConfigSegment } = require('./userConfig');

/**
 * Usage statistics for the admin dashboard.
 *
 * Privacy: raw IP addresses are never stored. Each visitor is reduced to a short keyed hash (HMAC with a random
 * secret kept only in the stats file), so distinct visitors can be counted but not identified. Detailed data
 * (the sets of hashes) is kept for RETENTION_DAYS; older days shrink to plain totals.
 *
 * Storage: one JSON file, written atomically about once a minute and on shutdown. No database, no native modules.
 */

const RETENTION_DAYS = 30; // days that keep full detail (needed for 7/30-day unique counts)
const SUMMARY_DAYS = 3650; // days that keep totals, counters and timings only (the 'All time' range)
const MAX_VISITORS = 500_000; // safety cap on the visitor index
const FLUSH_MS = 60_000;
const MAP_CAP = 500; // distinct keys per counter per day, so junk URLs can't grow memory without bound
const SLOW_MS = 1500;
const SAMPLE_MS = 15_000; // how often CPU, memory and event-loop lag are sampled
// Upper bounds (ms) of the timing histogram; one extra slot counts everything above the last bound
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

function expandIPv6(value) {
    const [head, tail] = value.split('%')[0].split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return groups.map((g) => g.padStart(4, '0').toLowerCase());
}

/**
 * IPv4 stays as is. IPv6 collapses to its /64 prefix, because phones rotate the rest of the address and would
 * otherwise count as many people. Returns null when it isn't an IP at all.
 */
function normalizeIp(ip) {
    if (!ip) return null;
    let value = String(ip).trim();
    if (value.startsWith('::ffff:') && net.isIPv4(value.slice(7))) value = value.slice(7);
    if (net.isIPv4(value)) return value;
    if (net.isIPv6(value.split('%')[0])) return `${expandIPv6(value).slice(0, 4).join(':')}::/64`;
    return null;
}

/** Which part of the addon a request path belongs to; null = not worth counting (health checks, the dashboard). */
function classifyRoute(p) {
    if (p === '/healthz' || p === '/favicon.svg' || p === '/admin' || p.startsWith('/admin/')) return null;
    if (p === '/' || /\/configure\/?$/.test(p)) return 'configure';
    if (/\/manifest\.json$/.test(p)) return 'manifest';
    if (/^\/(?:[^/]+\/)?catalog\//.test(p)) return 'catalog';
    if (p.startsWith('/poster/')) return 'poster';
    if (p.startsWith('/backdrop/')) return 'backdrop';
    if (/^\/(?:image|landscape|proxy-image-poster|proxy-image-backdrop)\//.test(p)) return 'redirect';
    return 'other'; // scanners and typos: counted as requests, never as users
}

/** Coarse client family. The raw user agents are tracked too, so these buckets can be refined from real data. */
function classifyAgent(ua) {
    const s = String(ua || '');
    if (!s) return 'Unknown';
    // Known apps and addons come first: their user agents can also contain words (node, Darwin...) matched below
    if (/^Nuvio\//i.test(s)) return 'Nuvio';
    if (/^AIOStreams\//i.test(s)) return 'AIOStreams';
    if (/^AIOMetadata\//i.test(s)) return 'AIOMetadata';
    if (/^Odin\//i.test(s)) return 'Odin';
    if (/^node$/i.test(s)) return 'Bot / script';
    if (/bot|spider|crawl|curl|wget|python|axios|node-fetch|undici|got\/|go-http|java\/|okhttp\/.*bot|httpclient|aiohttp|scrapy|monitor|uptime/i.test(s)) return 'Bot / script';
    if (/stremio/i.test(s)) {
        if (/android/i.test(s)) return 'Stremio · Android';
        if (/iphone|ipad|ios/i.test(s)) return 'Stremio · iOS';
        return 'Stremio · Desktop';
    }
    if (/exoplayer|androidtv|android tv|googletv|aft[a-z]+ build|bravia/i.test(s)) return 'Android TV / Fire TV';
    if (/okhttp|dalvik/i.test(s)) return 'Android app';
    if (/cfnetwork|darwin/i.test(s)) return 'Apple app';
    if (/tizen|smart-tv|smarttv|webos|netcast/i.test(s)) return 'Smart TV';
    if (/edg\//i.test(s)) return 'Browser · Edge';
    if (/firefox\//i.test(s)) return 'Browser · Firefox';
    if (/chrome\/|crios\//i.test(s)) return 'Browser · Chrome';
    if (/safari\//i.test(s)) return 'Browser · Safari';
    return 'Other';
}

// ─── Setups (what people configured) ─────────────────────────────────────────

// The configure page's presets, as the six overlay switches: poster tags/logos/ranked + backdrop tags/logos/ranked
const PRESET_SWITCHES = { Clean: '000000', Ranked: '001000', Classic: '101000', Everything: '111000' };
const OPTION_ORDER = [
    'Poster tags', 'Poster ranking', 'Poster provider logos', 'Poster language', 'Poster shape', 'Curated posters',
    'Backdrop tags', 'Backdrop ranking', 'Backdrop provider logos', 'Backdrop language', 'Curated backdrops',
    'Catalog languages', 'Digital releases only',
];

const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

/** The `<config>` segment of an install URL (/<config>/manifest.json, /<config>/catalog/...), or null. */
function configSegment(p) {
    const m = /^\/([^/]+)\/(?:manifest\.json|catalog\/)/.exec(p);
    return m ? safeDecode(m[1]) : null;
}

const onOff = (v) => (v ? 'on' : 'off');
const langLabel = (v) => (v === 'null' ? 'Textless' : v);

/** A person's setup, from their install URL: which preset it matches (or Custom) and each individual option. */
function describeSetup(segment) {
    const raw = segment === null ? {} : parseConfigSegment(segment);
    if (!Object.keys(raw).length) return { preset: 'Not configured', options: [] };
    const c = parseUserConfig(raw);
    const switches = [c.posterTags, c.posterLogos, c.posterRanked, c.backdropTags, c.backdropLogos, c.backdropRanked].map((v) => (v ? '1' : '0')).join('');
    const preset = Object.entries(PRESET_SWITCHES).find(([, v]) => v === switches)?.[0] || 'Custom';
    return {
        preset,
        options: [
            ['Poster tags', onOff(c.posterTags)], ['Poster ranking', onOff(c.posterRanked)], ['Poster provider logos', onOff(c.posterLogos)],
            ['Poster language', langLabel(c.posterLanguage)], ['Poster shape', c.posterShape], ['Curated posters', onOff(c.textlessArtwork)],
            ['Backdrop tags', onOff(c.backdropTags)], ['Backdrop ranking', onOff(c.backdropRanked)], ['Backdrop provider logos', onOff(c.backdropLogos)],
            ['Backdrop language', langLabel(c.backdropLanguage)], ['Curated backdrops', onOff(c.backdropTextlessArtwork)],
            ['Catalog languages', c.listLang], ['Digital releases only', onOff(c.digitalOnly)],
        ],
    };
}

/** Calendar date (YYYY-MM-DD) of `date` in the given IANA timezone. */
const dayFormatters = new Map();
function dayKey(date, timeZone) {
    let f = dayFormatters.get(timeZone);
    if (!f) {
        // en-CA formats dates as YYYY-MM-DD
        f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
        dayFormatters.set(timeZone, f);
    }
    return f.format(date);
}
const isValidTimeZone = (tz) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};
const daysAgo = (dateStr, n) => new Date(Date.parse(`${dateStr}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Error text for the dashboard: single line, short, and never carrying a key or token. */
function cleanMessage(message) {
    return String(message || 'No details recorded')
        .replace(/(api_key|apikey|token|authorization)=[^&\s"']+/gi, '$1=…')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160) || 'No details recorded';
}

function bump(map, key, by = 1, cap = MAP_CAP) {
    if (key in map) map[key] += by;
    else if (Object.keys(map).length < cap) map[key] = by;
}
const mergeCounts = (target, source = {}) => { for (const [k, v] of Object.entries(source)) target[k] = (target[k] || 0) + v; };

const newTiming = () => ({ count: 0, total: 0, max: 0, buckets: Array(BUCKETS.length + 1).fill(0) });
const newProc = () => ({ samples: 0, cpuSum: 0, cpuMax: 0, lagP99Max: 0, lagMax: 0, rssMax: 0 });

/** Approximate percentile from histogram buckets (reports the bucket's upper bound, never above the real maximum). */
function percentile(t, q) {
    if (!t.count) return 0;
    const target = Math.ceil(t.count * q);
    let seen = 0;
    for (let i = 0; i < t.buckets.length; i++) {
        seen += t.buckets[i];
        if (seen >= target) return i < BUCKETS.length ? Math.min(BUCKETS[i], t.max) : t.max;
    }
    return t.max;
}

const newDay = () => ({
    perf: {}, counts: {}, gauges: {}, proc: newProc(), // performance: timings, counters, peaks, process samples
    requests: 0, errors: 0, clientErrors: 0, errorLog: {}, // errorLog: what the 5xx responses were
    routes: {}, uas: {}, // uas: raw user agent -> { requests, routes, users }
    timing: { count: 0, totalMs: 0, maxMs: 0, slow: 0 },
    users: new Set(), installs: new Set(), configure: new Set(),
});

// ─── (De)serialisation ───────────────────────────────────────────────────────


const serialiseUas = (uas = {}) => Object.fromEntries(Object.entries(uas).map(([k, v]) => [k, { ...v, users: [...v.users] }]));
const reviveUas = (uas = {}) => Object.fromEntries(Object.entries(uas).map(([k, v]) => [k, { requests: v.requests || 0, routes: v.routes || {}, users: new Set(v.users || []) }]));

function serialiseDay(d) {
    if (d.summary) return d;
    return { ...d, users: [...d.users], installs: [...d.installs], configure: [...d.configure], uas: serialiseUas(d.uas) };
}
function reviveDay(d) {
    if (d.summary) return d;
    // (older files also carried per-day country/client/setup sets; those now live in the visitor index)
    const { countries, agents, presets, options, ...rest } = d;
    return { ...newDay(), ...rest, users: new Set(d.users), installs: new Set(d.installs), configure: new Set(d.configure), uas: reviveUas(d.uas) };
}
/** Older than the detail window: keep the numbers (visitor sets and per-client detail are dropped). */
function compactDay(d) {
    if (d.summary) return d;
    return {
        summary: true, requests: d.requests, errors: d.errors, clientErrors: d.clientErrors, routes: d.routes,
        perf: d.perf, counts: d.counts, gauges: d.gauges, proc: d.proc, timing: d.timing,
        totals: { users: d.users.size, installs: d.installs.size, configure: d.configure.size },
    };
}

/**
 * People index. One small record per visitor hash, which is what makes every time range exact:
 *   f first day seen · u last day seen using the addon · i last manifest load · c last configure visit
 *   k country · a { client: last day used } · p latest preset · o latest option values (in OPTION_ORDER order)
 * "Active in the last N days" is just "last seen on or after day X".
 */
function backfillVisitors(rawDays) {
    const visitors = {};
    const get = (hash, date) => (visitors[hash] ||= { f: date, a: {} });
    for (const date of Object.keys(rawDays).sort()) { // oldest first, so the latest value wins
        const d = rawDays[date];
        if (!d || d.summary) continue;
        for (const h of d.users || []) get(h, date).u = date;
        for (const h of d.installs || []) get(h, date).i = date;
        for (const h of d.configure || []) get(h, date).c = date;
        for (const [cc, list] of Object.entries(d.countries || {})) for (const h of list) get(h, date).k = cc;
        for (const [name, list] of Object.entries(d.agents || {})) for (const h of list) get(h, date).a[name] = date;
        for (const [name, list] of Object.entries(d.presets || {})) for (const h of list) get(h, date).p = name;
        for (const [key, list] of Object.entries(d.options || {})) {
            const i = key.indexOf('|');
            const index = OPTION_ORDER.indexOf(key.slice(0, i));
            if (index < 0) continue;
            for (const h of list) (get(h, date).o ||= Array(OPTION_ORDER.length).fill(null))[index] = key.slice(i + 1);
        }
    }
    return visitors;
}

// ─── Geo lookup (optional) ───────────────────────────────────────────────────

/** geoip-lite is an optional dependency and is only loaded when the first visitor needs a lookup. */
function lazyGeoip() {
    let lib;
    let tried = false;
    return (ip) => {
        if (!tried) {
            tried = true;
            try { lib = require('geoip-lite'); } catch { lib = null; }
        }
        try { return (lib && lib.lookup(ip)?.country) || null; } catch { return null; }
    };
}

// ─── Performance hints ───────────────────────────────────────────────────────

/** Plain-language reading of the numbers, so the dashboard answers "what is slow?" without interpretation. */
function performanceHints(p) {
    const out = [];
    const pct = (x) => `${Math.round(x * 100)}%`;
    const total = p.timings['render.total'];
    if (!total || total.count < 20) {
        out.push(`Not enough renders yet to say what is slow (about 20 needed, ${total?.count || 0} so far).`);
    } else {
        const tmdbShare = Math.min(1, (p.timings['render.tmdb']?.avgMs || 0) / total.avgMs);
        if (tmdbShare >= 0.6) {
            out.push(`Renders spend ${pct(tmdbShare)} of their time waiting on TMDB, not drawing. More CPU would not make them faster.`);
        } else if (1 - tmdbShare >= 0.6) {
            out.push(`${pct(1 - tmdbShare)} of render time is local: waiting for a free render slot plus sharp drawing and encoding. That is where to look first.`);
        }
        if (p.renderConcurrency && p.inFlightPeak > p.renderConcurrency) {
            out.push(`Up to ${p.inFlightPeak} renders were in flight at once but only ${p.renderConcurrency} run at a time (RENDER_CONCURRENCY), so requests queued.`);
        }
    }
    if (p.proc.samples && p.proc.cpuMax >= 0.85 * p.cores * 100) {
        out.push(`CPU peaked at ${Math.round(p.proc.cpuMax)}% (100% is one core, this machine has ${p.cores}). Rendering can compete with your other addons at those moments.`);
    }
    if (p.proc.lagP99Max > 100) {
        out.push(`The server stalled for up to ${Math.round(p.proc.lagP99Max)} ms at times (event-loop lag). Something synchronous is slow; every request waits during that.`);
    }
    if (p.hitRate !== null && p.lookups >= 50 && p.hitRate < 0.5) {
        out.push(`Only ${pct(p.hitRate)} of artwork requests are served from cache, so most need a fresh render.`);
    }
    if (p.proc.rssMax > 0.7 * p.totalMem) {
        out.push(`Memory peaked at ${Math.round(p.proc.rssMax / 1048576)} MB, over 70% of this machine's RAM.`);
    }
    if (!out.length) out.push('Nothing looks like a bottleneck right now.');
    return out;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function createStats({ dir, now = () => new Date(), logger = console, geo = lazyGeoip(), autoFlush = true, sampleProcess = autoFlush, renderConcurrency, timezone = 'UTC' } = {}) {
    const file = dir ? path.join(dir, 'stats.json') : null;
    // Days roll over at midnight in this timezone (an invalid one falls back to UTC instead of stopping the addon)
    let tz = String(timezone || 'UTC').trim() || 'UTC';
    if (!isValidTimeZone(tz)) {
        logger.warn?.(`Stats: "${tz}" is not a valid timezone, using UTC (set TZ to e.g. America/New_York)`);
        tz = 'UTC';
    }
    const todayKey = () => dayKey(now(), tz);
    let salt = crypto.randomBytes(24).toString('hex');
    let days = {};
    let visitors = {};
    let dirty = false;
    let timer = null;

    // ── load ──
    if (file && fs.existsSync(file)) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (typeof data.salt === 'string' && data.salt) salt = data.salt;
            days = Object.fromEntries(Object.entries(data.days || {}).map(([date, d]) => [date, reviveDay(d)]));
            if (data.visitors && typeof data.visitors === 'object') {
                visitors = data.visitors;
            } else if (data.days) {
                visitors = backfillVisitors(data.days); // file from before the visitor index: rebuild it from the detailed days
                dirty = true;
            }
        } catch (err) {
            logger.warn?.(`Stats file unreadable (${err.message}); starting fresh and keeping the old one as stats.json.corrupt`);
            try { fs.renameSync(file, `${file}.corrupt`); } catch { /* ignore */ }
        }
    }

    let visitorCount = Object.keys(visitors).length;
    const hashOf = (ip) => crypto.createHmac('sha256', salt).update(ip).digest('hex').slice(0, 12);

    /** Returns true when anything was dropped or shrunk, so the file gets rewritten without the old detail. */
    function prune() {
        const t = todayKey();
        let changed = false;
        for (const date of Object.keys(days)) {
            const age = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
            if (age > SUMMARY_DAYS) { delete days[date]; changed = true; }
            else if (age >= RETENTION_DAYS && !days[date].summary) { days[date] = compactDay(days[date]); changed = true; }
        }
        return changed;
    }
    if (prune()) dirty = true;

    /** Count one finished request. */
    function record({ ip, path: reqPath, status = 200, ms = 0, ua = '', error = null }) {
        const route = classifyRoute(String(reqPath || '/'));
        if (!route) return;
        const date = todayKey();
        const day = (days[date] ||= newDay());
        dirty = true;

        day.requests += 1;
        if (status >= 500) {
            day.errors += 1;
            const message = cleanMessage(error?.message);
            const key = `${status}|${route}|${message}`;
            const entry = day.errorLog[key] || (Object.keys(day.errorLog).length < 50
                ? (day.errorLog[key] = { status, route, kind: error?.kind === 'tmdb' ? 'tmdb' : 'internal', message, count: 0, last: '', example: '' })
                : null);
            if (entry) {
                entry.count += 1;
                entry.last = now().toISOString();
                entry.example = String(reqPath || '').slice(0, 120);
            }
        } else if (status >= 400) day.clientErrors += 1;
        bump(day.routes, route);

        // Scanners hitting random URLs are requests, not users
        const visitorIp = route === 'other' ? null : normalizeIp(ip);
        if (visitorIp) {
            const hash = hashOf(visitorIp);
            let v = visitors[hash];
            if (!v && visitorCount < MAX_VISITORS) {
                v = visitors[hash] = { f: date, a: {} };
                visitorCount += 1;
            }
            if (route === 'configure') {
                day.configure.add(hash);
                if (v) v.c = date;
            } else {
                day.users.add(hash);
                if (route === 'manifest') day.installs.add(hash);
                if (v) {
                    v.u = date;
                    if (route === 'manifest') v.i = date;
                    v.a[classifyAgent(ua)] = date;
                    if (!v.k) v.k = geo(String(ip)) || '??';
                    if (route === 'manifest' || route === 'catalog') {
                        const setup = describeSetup(configSegment(String(reqPath)));
                        // A plain, unconfigured URL never replaces a setup we already know for this visitor
                        // (someone else on the same connection, or a script, may have fetched it)
                        if (setup.preset !== 'Not configured' || !v.p) {
                            v.p = setup.preset;
                            const byLabel = Object.fromEntries(setup.options);
                            v.o = setup.options.length ? OPTION_ORDER.map((label) => byLabel[label] ?? null) : null;
                        }
                    }
                }
            }
        }

        if (route === 'poster' || route === 'backdrop') {
            const t = day.timing;
            t.count += 1;
            t.totalMs += ms;
            t.maxMs = Math.max(t.maxMs, ms);
            if (ms > SLOW_MS) t.slow += 1;

        }
        if (ua) {
            const key = String(ua).slice(0, 120);
            if (!day.uas[key] && Object.keys(day.uas).length < 100) day.uas[key] = { requests: 0, routes: {}, users: new Set() };
            const entry = day.uas[key];
            if (entry) {
                entry.requests += 1;
                bump(entry.routes, route);
                if (visitorIp) entry.users.add(hashOf(visitorIp));
            }
        }
    }

    // ── performance metrics (fed by src/metrics.js and the image routes) ──
    const currentDay = () => (days[todayKey()] ||= newDay());
    const metrics = {
        enabled: true,
        time(name, ms) {
            const t = (currentDay().perf[name] ||= newTiming());
            t.count += 1;
            t.total += ms;
            t.max = Math.max(t.max, ms);
            const i = BUCKETS.findIndex((bound) => ms <= bound);
            t.buckets[i < 0 ? BUCKETS.length : i] += 1;
            dirty = true;
        },
        count(name, by = 1) {
            const counts = currentDay().counts;
            counts[name] = (counts[name] || 0) + by;
            dirty = true;
        },
        gauge(name, value) {
            const gauges = currentDay().gauges;
            gauges[name] = Math.max(gauges[name] || 0, value);
            dirty = true;
        },
    };

    // CPU (100% = one core, and sharp's worker threads count), memory and event-loop lag since the previous sample
    const lagHistogram = sampleProcess ? monitorEventLoopDelay({ resolution: 20 }) : null;
    lagHistogram?.enable();
    let lastCpu = process.cpuUsage();
    let lastAt = process.hrtime.bigint();
    function sample() {
        const at = process.hrtime.bigint();
        const elapsedMs = Number(at - lastAt) / 1e6;
        const used = process.cpuUsage(lastCpu);
        lastCpu = process.cpuUsage();
        lastAt = at;
        const cpuPct = elapsedMs > 0 ? ((used.user + used.system) / 1000 / elapsedMs) * 100 : 0;
        const p = currentDay().proc;
        p.samples += 1;
        p.cpuSum += cpuPct;
        p.cpuMax = Math.max(p.cpuMax, cpuPct);
        if (lagHistogram) {
            p.lagP99Max = Math.max(p.lagP99Max, lagHistogram.percentile(99) / 1e6);
            p.lagMax = Math.max(p.lagMax, lagHistogram.max / 1e6);
            lagHistogram.reset();
        }
        p.rssMax = Math.max(p.rssMax, process.memoryUsage().rss);
        dirty = true;
    }

    /** Express middleware: records once the response has finished. */
    function middleware(req, res, next) {
        const start = process.hrtime.bigint();
        if (typeof res.on === 'function') {
            res.on('finish', () => {
                try {
                    record({
                        ip: req.ip || req.socket?.remoteAddress,
                        path: req.path || String(req.url || '').split('?')[0],
                        status: res.statusCode,
                        ms: Number(process.hrtime.bigint() - start) / 1e6,
                        ua: req.headers?.['user-agent'],
                        error: res.locals?.statsError || null,
                    });
                } catch (err) {
                    logger.error('Stats record failed:', err.message);
                }
            });
        }
        next();
    }

    /**
     * Everything the dashboard shows, for one time range: 7, 14, 30, 90 (days ending today) or 'all'.
     * People counts come from the visitor index, so they are exact for any range; counters and timings are summed
     * per day. The only detail that is limited is the per-client list, which covers the last RETENTION_DAYS days.
     */
    function report(range = 30) {
        const t = todayKey();
        const known = Object.keys(days).sort();
        const dataStart = known.length && known[0] < t ? known[0] : t;
        const wantAll = String(range) === 'all';
        const n = wantAll ? null : Math.min(365, Math.max(1, Math.floor(Number(range)) || 30));
        const start = wantAll ? dataStart : daysAgo(t, n - 1);
        const span = Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
        const dates = Array.from({ length: span }, (_, i) => daysAgo(t, span - 1 - i));
        // A one-day chart is a single bar, so 'Today' shows the last 7 days for context (figures stay today-only)
        const chartSpan = Math.max(span, 7);
        const chartDates = Array.from({ length: chartSpan }, (_, i) => daysAgo(t, chartSpan - 1 - i));
        const present = dates.map((date) => days[date]).filter(Boolean);
        const sum = (field) => present.reduce((a, d) => a + (d[field] || 0), 0);

        // ── people ──
        const people = { users: 0, newUsers: 0, installs: 0, configure: 0, today: { users: 0, installs: 0, configure: 0 } };
        const countries = {};
        const agents = {};
        const presets = {};
        const optionCounts = OPTION_ORDER.map(() => ({}));
        let withSetup = 0;
        for (const v of Object.values(visitors)) {
            if (v.u !== undefined && v.u >= start) {
                people.users += 1;
                if (v.f >= start && v.f > dataStart) people.newUsers += 1;
                bump(countries, v.k || '??', 1, Infinity);
                for (const [name, day] of Object.entries(v.a || {})) if (day >= start) bump(agents, name, 1, Infinity);
                if (v.p) {
                    withSetup += 1;
                    bump(presets, v.p, 1, Infinity);
                    (v.o || []).forEach((value, i) => { if (value !== null && value !== undefined) bump(optionCounts[i], value, 1, Infinity); });
                }
            }
            if (v.i !== undefined && v.i >= start) people.installs += 1;
            if (v.c !== undefined && v.c >= start) people.configure += 1;
            if (v.u === t) people.today.users += 1;
            if (v.i === t) people.today.installs += 1;
            if (v.c === t) people.today.configure += 1;
        }
        const ranked = (map, limit) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, limit);

        // ── daily series (long ranges are averaged into buckets so the chart stays readable) ──
        const perDay = chartDates.map((date) => {
            const d = days[date];
            if (!d) return { date, users: 0, installs: 0, configure: 0, requests: 0, errors: 0 };
            return d.summary
                ? { date, ...d.totals, requests: d.requests, errors: d.errors }
                : { date, users: d.users.size, installs: d.installs.size, configure: d.configure.size, requests: d.requests, errors: d.errors };
        });
        const bucketDays = perDay.length > 120 ? Math.ceil(perDay.length / 90) : 1;
        const daily = bucketDays === 1 ? perDay : Array.from({ length: Math.ceil(perDay.length / bucketDays) }, (_, i) => {
            const slice = perDay.slice(i * bucketDays, (i + 1) * bucketDays);
            const avg = (key) => Math.round((slice.reduce((a, x) => a + x[key], 0) / slice.length) * 10) / 10;
            return {
                date: slice[0].date, days: slice.length,
                users: avg('users'), installs: avg('installs'), configure: avg('configure'),
                requests: slice.reduce((a, x) => a + x.requests, 0), errors: slice.reduce((a, x) => a + x.errors, 0),
            };
        });

        const routes = {};
        for (const d of present) mergeCounts(routes, d.routes);
        const timing = present.reduce((a, d) => ({
            count: a.count + (d.timing?.count || 0), totalMs: a.totalMs + (d.timing?.totalMs || 0),
            maxMs: Math.max(a.maxMs, d.timing?.maxMs || 0), slow: a.slow + (d.timing?.slow || 0),
        }), { count: 0, totalMs: 0, maxMs: 0, slow: 0 });

        /** Is rendering the bottleneck? Merged over the selected range. */
        function performance() {
            const merged = {};
            const counts = {};
            const gauges = {};
            const proc = newProc();
            for (const d of present) {
                for (const [name, v] of Object.entries(d.perf || {})) {
                    const m = (merged[name] ||= newTiming());
                    m.count += v.count;
                    m.total += v.total;
                    m.max = Math.max(m.max, v.max);
                    v.buckets.forEach((count, i) => { m.buckets[i] += count; });
                }
                mergeCounts(counts, d.counts);
                for (const [k, v] of Object.entries(d.gauges || {})) gauges[k] = Math.max(gauges[k] || 0, v);
                if (d.proc) {
                    proc.samples += d.proc.samples;
                    proc.cpuSum += d.proc.cpuSum;
                    for (const k of ['cpuMax', 'lagP99Max', 'lagMax', 'rssMax']) proc[k] = Math.max(proc[k], d.proc[k]);
                }
            }
            const timings = Object.fromEntries(Object.entries(merged).map(([name, tm]) => [name, {
                count: tm.count, avgMs: tm.total / tm.count, p50Ms: percentile(tm, 0.5), p95Ms: percentile(tm, 0.95), maxMs: tm.max,
            }]));
            const outcomes = {
                cached: counts['artwork.hit'] || 0, // a finished image was ready
                rendered: counts['artwork.image'] || 0, // had to be drawn
                passedThrough: counts['artwork.redirect'] || 0, // nothing to draw, needed TMDB lookups to find the file
                passedThroughCached: counts['artwork.redirectCached'] || 0, // nothing to draw, answer remembered
                placeholder: counts['artwork.placeholder'] || 0,
            };
            const lookups = outcomes.cached + outcomes.rendered + outcomes.passedThrough + outcomes.passedThroughCached + outcomes.placeholder;
            const result = {
                windowDays: span,
                rangeAll: wantAll,
                renderConcurrency: renderConcurrency || null,
                cores: os.cpus().length || 1,
                totalMem: os.totalmem(),
                outcomes,
                hitRate: lookups ? (outcomes.cached + outcomes.passedThroughCached) / lookups : null,
                lookups,
                timings,
                inFlightPeak: gauges['render.inFlight'] || 0,
                proc: {
                    samples: proc.samples, cpuAvg: proc.samples ? proc.cpuSum / proc.samples : 0, cpuMax: proc.cpuMax,
                    lagP99Max: proc.lagP99Max, lagMax: proc.lagMax, rssMax: proc.rssMax,
                },
            };
            return { ...result, hints: performanceHints(result) };
        }

        /** Raw user agents: distinct people, requests, and which kinds of request each one makes (detailed days only). */
        function userAgents() {
            const merged = {};
            for (const d of present) {
                if (d.summary) continue;
                for (const [ua, v] of Object.entries(d.uas)) {
                    const m = (merged[ua] ||= { ua, requests: 0, routes: {}, users: new Set() });
                    m.requests += v.requests;
                    mergeCounts(m.routes, v.routes);
                    v.users.forEach((h) => m.users.add(h));
                }
            }
            return Object.values(merged)
                .map((m) => ({ ua: m.ua, users: m.users.size, requests: m.requests, routes: Object.entries(m.routes).sort((a, b) => b[1] - a[1]) }))
                .sort((a, b) => b.users - a.users || b.requests - a.requests)
                .slice(0, 15);
        }

        /** What the server errors were, merged over the range (detailed days only). */
        function errorDetails() {
            const merged = {};
            for (const d of present) {
                if (d.summary) continue;
                for (const [key, e] of Object.entries(d.errorLog || {})) {
                    const m = (merged[key] ||= { ...e, count: 0, last: '' });
                    m.count += e.count;
                    if (e.last > m.last) { m.last = e.last; m.example = e.example; }
                }
            }
            return Object.values(merged).sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1)).slice(0, 20);
        }

        const options = OPTION_ORDER
            .map((label, i) => ({ label, values: ranked(optionCounts[i], 50) }))
            .filter((o) => o.values.length);

        return {
            generatedAt: now().toISOString(),
            timezone: tz,
            today: t,
            range: { key: wantAll ? 'all' : String(n), days: span, start, since: dataStart },
            totals: {
                users: people.users, newUsers: people.newUsers, installs: people.installs, configure: people.configure,
                requests: sum('requests'), errors: sum('errors'),
                today: { ...people.today, requests: days[t]?.requests || 0, errors: days[t]?.errors || 0 },
            },
            daily,
            bucketDays,
            chartDays: chartSpan,
            errorDetails: errorDetails(),
            errorDetailDays: Math.min(span, RETENTION_DAYS),
            countries: ranked(countries, 30),
            agents: ranked(agents, 50),
            routes: ranked(routes, 10),
            setups: { total: withSetup, presets: ranked(presets, 10), options },
            performance: performance(),
            userAgents: userAgents(),
            userAgentDays: Math.min(span, RETENTION_DAYS),
            timing: { ...timing, avgMs: timing.count ? timing.totalMs / timing.count : 0 },
        };
    }

    // ── persistence ──
    function snapshot() {
        prune();
        return JSON.stringify({ version: 2, salt, visitors, days: Object.fromEntries(Object.entries(days).map(([k, d]) => [k, serialiseDay(d)])) });
    }
    function writeFile(sync) {
        if (!file || !dirty) return Promise.resolve();
        dirty = false;
        const tmp = `${file}.tmp`;
        try {
            fs.mkdirSync(dir, { recursive: true });
            const body = snapshot();
            if (sync) {
                fs.writeFileSync(tmp, body, { mode: 0o600 });
                fs.renameSync(tmp, file);
                return Promise.resolve();
            }
            return fs.promises.writeFile(tmp, body, { mode: 0o600 }).then(() => fs.promises.rename(tmp, file)).catch((err) => {
                dirty = true;
                logger.error('Stats write failed:', err.message);
            });
        } catch (err) {
            dirty = true;
            logger.error('Stats write failed:', err.message);
            return Promise.resolve();
        }
    }

    if (autoFlush && file) {
        timer = setInterval(() => writeFile(false), FLUSH_MS);
        timer.unref();
    }
    let sampler = null;
    if (sampleProcess) {
        sampler = setInterval(sample, SAMPLE_MS);
        sampler.unref();
    }

    return {
        record, middleware, report, metrics, sample,
        flush: () => writeFile(false),
        stop() {
            if (timer) clearInterval(timer);
            if (sampler) clearInterval(sampler);
            lagHistogram?.disable();
            writeFile(true);
        },
    };
}

module.exports = { createStats, normalizeIp, classifyRoute, classifyAgent, describeSetup, configSegment, RETENTION_DAYS };
