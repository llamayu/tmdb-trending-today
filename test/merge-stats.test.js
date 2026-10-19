'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { createStats } = require('../src/stats');
const { mergeStats } = require('../scripts/merge-stats');

const silent = { error() {}, warn() {}, log() {} };
const SCRIPT = path.join(__dirname, '..', 'scripts', 'merge-stats.js');

/** A stats file produced by the real addon code: `days` of traffic starting at `start`, from `visitors` different IPs. */
function makeFile(dir, { start, days, ipPrefix, perDay = 10, visitors = 4 }) {
    fs.mkdirSync(dir, { recursive: true });
    let t = Date.parse(start);
    const stats = createStats({ dir, now: () => new Date(t), logger: silent, autoFlush: false, sampleProcess: false, geo: () => null });
    for (let d = 0; d < days; d++) {
        for (let i = 0; i < perDay; i++) {
            stats.record({ ip: `${ipPrefix}.${i % visitors}`, path: i % 2 ? '/manifest.json' : '/catalog/movie/trending.json', status: i === 3 ? 500 : 200, ms: 10 + i, ua: 'Stremio/4.4 (Windows)', error: i === 3 ? new Error('boom') : null });
        }
        stats.sample();
        t += 86_400_000;
    }
    stats.stop();
    return path.join(dir, 'stats.json');
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const loadReport = (dir, now) => createStats({ dir, now: () => new Date(now), logger: silent, autoFlush: false, sampleProcess: false, geo: () => null });

test('merge: separate days are kept, the shared day is added up, nothing is lost', () => {
    const root = tmp();
    const olderFile = makeFile(path.join(root, 'a'), { start: '2026-09-01T12:00:00Z', days: 3, ipPrefix: '10.1.0' }); // Sep 1-3
    const newerFile = makeFile(path.join(root, 'b'), { start: '2026-09-03T18:00:00Z', days: 3, ipPrefix: '10.2.0' }); // Sep 3-5
    const older = read(olderFile), newer = read(newerFile);
    assert.notEqual(older.salt, newer.salt);

    const { merged, overlap } = mergeStats(older, newer);
    assert.deepEqual(overlap, ['2026-09-03']);
    assert.deepEqual(Object.keys(merged.days), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
    assert.equal(merged.salt, older.salt);
    assert.equal(merged.days['2026-09-03'].requests, older.days['2026-09-03'].requests + newer.days['2026-09-03'].requests);
    assert.equal(merged.days['2026-09-03'].errors, 2);
    const errorKinds = Object.values(merged.days['2026-09-03'].errorLog);
    assert.equal(errorKinds.length, 1); // the same kind of error in both files is one entry...
    assert.equal(errorKinds[0].count, 2); // ...with its counts added
    const total = (d) => Object.values(d.routes).reduce((n, v) => n + v, 0);
    assert.equal(total(merged.days['2026-09-03']), total(older.days['2026-09-03']) + total(newer.days['2026-09-03']));
    assert.equal(merged.days['2026-09-03'].users.length, 8); // different salts: the same IPs would hash differently, so these are 4 + 4
    assert.equal(Object.keys(merged.visitors).length, Object.keys(older.visitors).length + Object.keys(newer.visitors).length);
    assert.equal(mergeStats(older, newer, { salt: 'newer' }).merged.salt, newer.salt);

    // The inputs are untouched
    assert.deepEqual(read(olderFile), older);
});

test('merge: the addon loads the merged file and reports the combined totals', () => {
    const root = tmp();
    const olderFile = makeFile(path.join(root, 'a'), { start: '2026-09-01T12:00:00Z', days: 3, ipPrefix: '10.1.0' });
    const newerFile = makeFile(path.join(root, 'b'), { start: '2026-09-03T18:00:00Z', days: 3, ipPrefix: '10.2.0' });
    const out = path.join(root, 'merged.json');
    const text = execFileSync('node', [SCRIPT, olderFile, newerFile, out], { encoding: 'utf8' });
    assert.match(text, /merged: 2026-09-01 to 2026-09-05 \(5 days\), 60 requests/);
    assert.match(text, /days in both files, added together: 2026-09-03/);

    const dir = path.join(root, 'live');
    fs.mkdirSync(dir);
    fs.copyFileSync(out, path.join(dir, 'stats.json'));
    const stats = loadReport(dir, '2026-09-06T12:00:00Z');
    const report = stats.report('all');
    assert.equal(report.totals.requests, 60);
    assert.equal(report.totals.errors, 6);
    assert.equal(fs.existsSync(path.join(dir, 'stats.json.corrupt')), false); // it loaded cleanly
    stats.stop();
});

test('merge: compacted (old) days from the older file merge with detailed days', () => {
    const root = tmp();
    // the older file starts 60 days before the newer one, so its early days are compacted to totals
    const olderFile = makeFile(path.join(root, 'a'), { start: '2026-06-01T12:00:00Z', days: 2, ipPrefix: '10.1.0' });
    const older = read(olderFile);
    const compacted = { ...older, days: Object.fromEntries(Object.entries(older.days).map(([k, d]) => [k, {
        summary: true, requests: d.requests, errors: d.errors, clientErrors: d.clientErrors, routes: d.routes, perf: d.perf, counts: d.counts,
        gauges: d.gauges, proc: d.proc, host: d.host, timing: d.timing, totals: { users: d.users.length, installs: d.installs.length, configure: d.configure.length },
    }])) };
    const newerFile = makeFile(path.join(root, 'b'), { start: '2026-06-02T12:00:00Z', days: 2, ipPrefix: '10.2.0' });
    const { merged } = mergeStats(compacted, read(newerFile));
    const shared = merged.days['2026-06-02'];
    assert.equal(shared.summary, true);
    assert.equal(shared.requests, 20);
    assert.equal(shared.totals.users, 8);
    assert.equal(merged.days['2026-06-01'].summary, true);
    assert.equal(merged.days['2026-06-03'].requests, 10);
});

test('merge: refuses to overwrite its inputs or an existing file, and rejects files that are not stats', () => {
    const root = tmp();
    const a = makeFile(path.join(root, 'a'), { start: '2026-09-01T12:00:00Z', days: 1, ipPrefix: '10.1.0' });
    const b = makeFile(path.join(root, 'b'), { start: '2026-09-02T12:00:00Z', days: 1, ipPrefix: '10.2.0' });
    assert.notEqual(spawnSync('node', [SCRIPT, a, b, a]).status, 0);
    const out = path.join(root, 'out.json');
    assert.equal(spawnSync('node', [SCRIPT, a, b, out]).status, 0);
    assert.notEqual(spawnSync('node', [SCRIPT, a, b, out]).status, 0); // already exists
    assert.equal(spawnSync('node', [SCRIPT, a, b, out, '--force']).status, 0);
    const junk = path.join(root, 'junk.json');
    fs.writeFileSync(junk, '{"hello":1}');
    const r = spawnSync('node', [SCRIPT, a, junk, path.join(root, 'x.json')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not look like a stats\.json/);
});
