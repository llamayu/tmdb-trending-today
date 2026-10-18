'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const host = require('../src/host');
const { createStats, serverHints } = require('../src/stats');

const silent = { error() {}, warn() {}, log() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-'));
const write = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const GB = 1024 ** 3;

test('parseProcStat and cpuShares: busy, iowait, steal and idle add up to 100', () => {
    const a = host.parseProcStat('cpu  100 0 50 800 20 0 10 20 0 0\ncpu0 1 1 1 1 1 1 1 1\n');
    assert.deepEqual(a, { user: 100, nice: 0, system: 50, idle: 800, iowait: 20, irq: 0, softirq: 10, steal: 20 });
    const b = host.parseProcStat('cpu  200 0 100 1500 60 0 20 70 0 0\n');
    const s = host.cpuShares(a, b);
    // deltas: busy 100+50+10=160, iowait 40, steal 50, idle 700 -> total 950
    assert.ok(Math.abs(s.busy - (160 / 950) * 100) < 1e-9);
    assert.ok(Math.abs(s.iowait - (40 / 950) * 100) < 1e-9);
    assert.ok(Math.abs(s.steal - (50 / 950) * 100) < 1e-9);
    assert.ok(Math.abs(s.busy + s.iowait + s.steal + s.idle - 100) < 1e-9);
    assert.equal(host.cpuShares(a, a), null); // no time passed
    assert.equal(host.cpuShares(b, a), null); // counters went backwards (reset)
    assert.equal(host.cpuShares(null, a), null);
    assert.equal(host.parseProcStat('nonsense'), null);
    // older kernels only report four fields
    assert.deepEqual(host.parseProcStat('cpu 1 2 3 4\n'), { user: 1, nice: 2, system: 3, idle: 4, iowait: 0, irq: 0, softirq: 0, steal: 0 });
});

test('parseLoadavg, parseMeminfo, parseUptime', () => {
    assert.deepEqual(host.parseLoadavg('0.52 0.40 0.30 2/345 6789\n'), { one: 0.52, five: 0.4, fifteen: 0.3 });
    assert.equal(host.parseLoadavg(''), null);

    const m = host.parseMeminfo('MemTotal:       24000000 kB\nMemFree:         1000000 kB\nMemAvailable:   18000000 kB\nSwapTotal:       4000000 kB\nSwapFree:        3000000 kB\n');
    assert.equal(m.total, 24000000 * 1024);
    assert.equal(m.available, 18000000 * 1024);
    assert.equal(m.swapTotal - m.swapFree, 1000000 * 1024);
    // no MemAvailable (very old kernel): free + buffers + cached
    const old = host.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n');
    assert.equal(old.available, 300 * 1024);
    assert.equal(old.swapTotal, 0);
    assert.equal(host.parseMeminfo('junk'), null);

    assert.equal(host.parseUptime('12345.67 99999.00\n'), 12345.67);
    assert.equal(host.parseUptime('x'), null);
});

test('cgroup helpers: cpu.max, limits, key/value files', () => {
    assert.equal(host.parseCpuMax('300000 100000\n'), 3);
    assert.equal(host.parseCpuMax('50000 100000'), 0.5);
    assert.equal(host.parseCpuMax('max 100000'), null);
    assert.equal(host.parseLimit('max\n'), null);
    assert.equal(host.parseLimit('9223372036854771712'), null); // cgroup v1's "no limit"
    assert.equal(host.parseLimit('536870912'), 536870912);
    assert.deepEqual(host.parseKeyValue('nr_periods 10\nnr_throttled 2\nthrottled_usec 5000\n'), { nr_periods: 10, nr_throttled: 2, throttled_usec: 5000 });
});

test('diskFigures matches df: used / (used + available to users)', () => {
    const d = host.diskFigures({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 250 });
    assert.equal(d.total, 4096000);
    assert.equal(d.used, 700 * 4096);
    assert.equal(d.free, 250 * 4096);
    assert.ok(Math.abs(d.pct - (700 / 950) * 100) < 1e-9);
});

test('reader: cgroup v2 container with a 3-core cap', () => {
    const proc = tmp(); const cg = tmp();
    write(proc, 'stat', 'cpu  10 0 5 80 3 0 1 1 0 0\n');
    write(proc, 'loadavg', '1.25 0.80 0.50 1/100 1\n');
    write(proc, 'meminfo', 'MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
    write(proc, 'uptime', '86400.5 1.0\n');
    write(cg, 'cgroup.controllers', 'cpu memory io');
    write(cg, 'cpu.stat', 'usage_usec 1\nnr_periods 200\nnr_throttled 24\nthrottled_usec 3000000\n');
    write(cg, 'cpu.max', '300000 100000\n');
    write(cg, 'memory.current', String(600 * 1024 * 1024));
    write(cg, 'memory.max', String(1024 * 1024 * 1024));
    write(cg, 'memory.stat', `anon 1\ninactive_file ${100 * 1024 * 1024}\n`);
    const dataDir = tmp();
    const r = host.createHostReader({ procDir: proc, cgroupDir: cg, volumes: [{ key: 'data', label: 'Stats data', path: dataDir }] }).read();

    assert.equal(r.cpuTimes.idle, 80);
    assert.equal(r.load.one, 1.25);
    assert.equal(r.mem.total, 8 * GB);
    assert.equal(r.uptime, 86400.5);
    assert.deepEqual(r.cgroup.throttle, { periods: 200, throttled: 24, throttledUs: 3000000 });
    assert.equal(r.cgroup.cpuLimit, 3);
    assert.equal(r.cgroup.memory.used, 500 * 1024 * 1024); // file cache that can be dropped is not counted
    assert.equal(r.cgroup.memory.limit, GB);
    if (typeof fs.statfsSync === 'function') {
        assert.equal(r.disks.length, 1);
        assert.equal(r.disks[0].label, 'Stats data');
        assert.ok(r.disks[0].total > 0 && r.disks[0].pct >= 0 && r.disks[0].pct <= 100);
    }
});

test('reader: cgroup v1 layout, and a machine with nothing readable', () => {
    const cg = tmp();
    write(cg, 'cpu/cpu.stat', 'nr_periods 50\nnr_throttled 5\nthrottled_time 2000000000\n');
    write(cg, 'cpu/cpu.cfs_quota_us', '200000');
    write(cg, 'cpu/cpu.cfs_period_us', '100000');
    write(cg, 'memory/memory.usage_in_bytes', '1000');
    write(cg, 'memory/memory.limit_in_bytes', '9223372036854771712');
    const r = host.createHostReader({ procDir: tmp(), cgroupDir: cg }).read();
    assert.deepEqual(r.cgroup.throttle, { periods: 50, throttled: 5, throttledUs: 2000000 }); // ns -> us
    assert.equal(r.cgroup.cpuLimit, 2);
    assert.equal(r.cgroup.memory.limit, null);

    const none = host.createHostReader({ procDir: '/nonexistent/a', cgroupDir: '/nonexistent/b', volumes: [{ key: 'x', label: 'X', path: '/nonexistent/c' }] }).read();
    assert.equal(none.cpuTimes, null);
    assert.equal(none.mem, null);
    assert.equal(none.cgroup.throttle, null);
    assert.deepEqual(none.disks, []);
});

test('reader: two folders on one disk are reported once', { skip: typeof fs.statfsSync !== 'function' }, () => {
    const a = tmp(); const b = tmp();
    const r = host.createHostReader({ procDir: tmp(), cgroupDir: tmp(), volumes: [{ key: 'data', label: 'Stats data', path: a }, { key: 'cache', label: 'Image cache', path: b }] }).read();
    assert.equal(r.disks.length, 1);
    assert.equal(r.disks[0].label, 'Stats data + image cache');
});

test('measureDir adds up file sizes and ignores sub-folders', async () => {
    const dir = tmp();
    write(dir, 'a.png', 'x'.repeat(100));
    write(dir, 'b.jpg', 'x'.repeat(250));
    fs.mkdirSync(path.join(dir, 'sub'));
    assert.deepEqual(await host.measureDir(dir), { bytes: 350, files: 2 });
    assert.deepEqual(await host.measureDir('/nonexistent/dir'), { bytes: 0, files: 0 });
});

// ── through the stats sampler, with a scripted machine ──

/** A fake host whose readings are fed in one by one. */
function fakeHost(readings) {
    let i = 0;
    return { read: () => readings[Math.min(i++, readings.length - 1)] };
}
const reading = ({ stat = [0, 0, 0, 0, 0, 0, 0, 0], load = 0.5, avail = 0.5, swapUsed = 0, periods = 0, throttled = 0, usec = 0, ctr = 1e8, ctrLimit = null, disk = 40, uptime = 1000 } = {}) => ({
    cpuTimes: { user: stat[0], nice: stat[1], system: stat[2], idle: stat[3], iowait: stat[4], irq: stat[5], softirq: stat[6], steal: stat[7] },
    load: { one: load, five: load, fifteen: load },
    mem: { total: 8 * GB, available: avail * 8 * GB, swapTotal: 2 * GB, swapFree: 2 * GB - swapUsed },
    uptime,
    cgroup: { throttle: { periods, throttled, throttledUs: usec }, cpuLimit: 3, memory: { used: ctr, limit: ctrLimit } },
    disks: [{ key: 'data', label: 'Server disk', total: 100 * GB, used: disk * GB, free: (100 - disk) * GB, pct: disk }],
});
const mkHost = (readings, extra = {}) => createStats({ logger: silent, autoFlush: false, sampleProcess: false, geo: () => null, host: fakeHost(readings), ...extra });

test('server section: CPU, throttling, memory, disk and uptime over a range', () => {
    const stats = mkHost([
        reading({ stat: [0, 0, 0, 0, 0, 0, 0, 0] }),
        reading({ stat: [30, 0, 10, 50, 5, 0, 0, 5], load: 2, avail: 0.4, periods: 100, throttled: 20, usec: 4_000_000, disk: 50 }),
        reading({ stat: [60, 0, 20, 100, 10, 0, 0, 10], load: 4, avail: 0.08, swapUsed: 256 * 1024 * 1024, periods: 200, throttled: 32, usec: 6_000_000, disk: 60, ctr: 700 * 1024 * 1024, ctrLimit: 1024 * 1024 * 1024 }),
    ]);
    stats.sample(); // the first reading has nothing to compare against
    stats.sample();
    stats.sample();
    const s = stats.report(7).server;

    assert.equal(s.available, true);
    assert.equal(s.cpu.samples, 2);
    assert.ok(Math.abs(s.cpu.busyAvg - 40) < 1e-9); // 40 busy of 100 in each interval
    assert.ok(Math.abs(s.cpu.iowaitAvg - 5) < 1e-9);
    assert.ok(Math.abs(s.cpu.stealMax - 5) < 1e-9);
    assert.equal(s.load.max1, 4);
    assert.equal(s.throttle.periods, 200);
    assert.equal(s.throttle.throttled, 32);
    assert.equal(s.throttle.pct, 16);
    assert.equal(s.throttle.heldBackSec, 6);
    assert.equal(s.cpuLimit, 3);
    assert.equal(s.memory.total, 8 * GB);
    assert.ok(Math.abs(s.memory.availPctMin - 8) < 1e-9);
    assert.ok(s.memory.lowShare > 0.3 && s.memory.lowShare < 0.4); // 1 of 3 samples under 10% free
    assert.equal(s.memory.swapUsedMax, 256 * 1024 * 1024);
    assert.equal(s.memory.container.limit, 1024 * 1024 * 1024);
    assert.ok(Math.abs(s.memory.container.pctMax - (700 / 1024) * 100) < 1e-9);
    assert.equal(s.disks.length, 1);
    assert.equal(s.disks[0].pct, 60);
    assert.equal(s.disks[0].pctMax, 60);
    assert.equal(s.disks[0].free, 40 * GB);
    assert.ok(s.uptime.process > 0 && s.uptime.machine >= 1000);
    assert.equal(s.now.load.one, 4);

    const text = s.hints.map((h) => h.text).join(' | ');
    assert.match(text, /throttled 16% of the time/);
    assert.match(text, /consider raising the limit/);
    assert.match(text, /Memory has been under 10% free/);
    assert.doesNotMatch(text, /Nothing on the server looks strained/);
    assert.equal(s.hints[0].level, 'warn');
});

test('server figures survive a restart and compaction, and merge across days', () => {
    const dir = tmp();
    const now = (() => { let t = Date.parse('2026-10-01T12:00:00Z'); const f = () => new Date(t); f.advance = (ms) => { t += ms; }; return f; })();
    const readings = [reading({ stat: [0, 0, 0, 0, 0, 0, 0, 0] }), reading({ stat: [50, 0, 0, 50, 0, 0, 0, 0], periods: 10, throttled: 1, disk: 70 })];
    const a = createStats({ dir, now, logger: silent, autoFlush: false, sampleProcess: false, geo: () => null, host: fakeHost(readings) });
    a.sample(); a.sample();
    a.stop();

    now.advance(86_400_000);
    const b = createStats({ dir, now, logger: silent, autoFlush: false, sampleProcess: false, geo: () => null, host: fakeHost([reading()]) });
    const s = b.report(7).server;
    assert.equal(s.cpu.samples, 1);
    assert.ok(Math.abs(s.cpu.busyAvg - 50) < 1e-9);
    assert.equal(s.disks[0].pctMax, 70); // the earlier day's peak is still there (the machine hasn't been sampled live yet)
    b.stop();

    // 40 days later the detailed days are compacted to totals; the server record is kept
    now.advance(40 * 86_400_000);
    const c = createStats({ dir, now, logger: silent, autoFlush: false, sampleProcess: false, geo: () => null, host: fakeHost([reading()]) });
    const wide = c.report('all').server;
    assert.equal(wide.cpu.samples, 1);
    assert.equal(wide.throttle.periods, 10);
    c.stop();
});

test('files from before this feature load without server data', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({
        version: 2, salt: 'x', visitors: {},
        days: { '2026-09-01': { summary: true, requests: 5, errors: 0, clientErrors: 0, routes: {}, perf: {}, counts: {}, gauges: {}, proc: {}, timing: {}, totals: { users: 1, installs: 0, configure: 0 } } },
    }));
    const stats = createStats({ dir, now: () => new Date('2026-10-01T12:00:00Z'), logger: silent, autoFlush: false, sampleProcess: false, geo: () => null, host: fakeHost([]) });
    const s = stats.report('all').server;
    assert.equal(s.samples, 0);
    assert.equal(s.throttle, null);
    assert.equal(s.hints.length, 1);
    assert.equal(s.hints[0].level, 'muted');
    stats.stop();
});

test('a real process start is counted as a restart, and the image cache is measured', async () => {
    const cacheDir = tmp();
    write(cacheDir, 'x.jpg', 'x'.repeat(1234));
    const stats = createStats({ logger: silent, autoFlush: false, sampleProcess: true, geo: () => null, host: fakeHost([reading()]), cacheDir, cacheBudget: () => 1 * GB });
    try {
        assert.equal(stats.report(7).server.uptime.restarts, 1);
        await new Promise((r) => setTimeout(r, 3300));
        const s = stats.report(7).server;
        assert.equal(s.cache.bytes, 1234);
        assert.equal(s.cache.files, 1);
        assert.equal(s.cache.budget, GB);
        assert.equal(s.cache.max, 1234);
    } finally { stats.stop(); }
});

test('a host reader that throws never breaks sampling', () => {
    const stats = createStats({ logger: silent, autoFlush: false, sampleProcess: false, geo: () => null, host: { read() { throw new Error('boom'); } } });
    stats.sample();
    assert.equal(stats.report(7).server.available, false);
});

// ── hints ──

const base = () => ({
    available: true, samples: 100, cores: 4, cpuLimit: 3,
    cpu: { samples: 100, busyAvg: 20, busyMax: 40, iowaitAvg: 1, iowaitMax: 5, stealAvg: 0, stealMax: 0, addonAvg: 0.1 },
    load: { samples: 100, avg1: 0.5, max1: 1, now: null },
    throttle: { periods: 5000, throttled: 10, pct: 0.2, heldBackSec: 1 },
    memory: { samples: 100, total: 8 * GB, availPctMin: 40, availPctAvg: 55, lowShare: 0, swapTotal: 2 * GB, swapUsedMax: 0, container: { usedMax: 1e8, limit: null, pctMax: 0 } },
    disks: [{ label: 'Server disk', total: 100 * GB, used: 50 * GB, free: 50 * GB, pct: 50, pctMax: 50 }],
    uptime: { restarts: 1 },
});
const texts = (s) => serverHints(s).map((h) => h.text).join(' | ');

test('hints: a healthy server says so, and says the CPU cap is fine', () => {
    const h = serverHints(base());
    assert.ok(h.every((x) => x.level === 'ok'));
    assert.match(texts(base()), /not holding the addon back/);
    assert.match(texts(base()), /Nothing on the server looks strained/);
});

test('hints: throttling needs enough periods and 5% before it warns', () => {
    const s = base();
    s.throttle = { periods: 5000, throttled: 600, pct: 12, heldBackSec: 90 };
    assert.match(texts(s), /throttled 12% of the time \(2 min held back in total\)/);
    s.throttle = { periods: 5000, throttled: 150, pct: 3, heldBackSec: 5 };
    assert.doesNotMatch(texts(s), /throttled/);
    s.throttle = { periods: 20, throttled: 20, pct: 100, heldBackSec: 5 };
    assert.doesNotMatch(texts(s), /throttled/); // too few periods to mean anything
});

test('hints: disk, memory, swap, steal, iowait, load and restarts', () => {
    const s = base();
    s.disks = [{ label: 'Server disk', total: 100e9, used: 88e9, free: 12e9, pct: 88, pctMax: 88 }];
    assert.match(texts(s), /"Server disk" is 88% full \(12 GB free of 100 GB\)/);
    s.disks = [{ label: 'Server disk', total: 100 * GB, used: 50 * GB, free: 50 * GB, pct: 50, pctMax: 91 }];
    assert.match(texts(s), /reached 91% full earlier/);

    const m = base();
    m.memory = { ...m.memory, availPctMin: 4, lowShare: 0.25, swapUsedMax: 1 * GB };
    assert.match(texts(m), /under 10% free for 25% of the time \(lowest 4%/);
    assert.match(texts(m), /Swap was in use/);

    const c = base();
    c.cpu = { ...c.cpu, stealAvg: 6, stealMax: 25, iowaitAvg: 12, iowaitMax: 60, busyMax: 97 };
    assert.match(texts(c), /hypervisor took up to 25%/);
    assert.match(texts(c), /waited on the disk 12%/);
    assert.match(texts(c), /whole machine reached 97%/);

    const l = base();
    l.load = { samples: 10, avg1: 3, max1: 9.5, now: null };
    l.uptime = { restarts: 4 };
    l.memory.container = { usedMax: 950, limit: 1000 * 1024 * 1024, pctMax: 95 };
    assert.match(texts(l), /Load average peaked at 9\.5 on 4 cores/);
    assert.match(texts(l), /started 4 times/);
    assert.match(texts(l), /95% of its/);
});

test('hints: not enough samples, or a machine without Linux figures', () => {
    const few = { ...base(), samples: 2 };
    assert.match(texts(few), /Collecting server samples/);
    assert.doesNotMatch(texts(few), /Nothing on the server looks strained/);
    const none = serverHints({ ...base(), available: false });
    assert.equal(none.length, 1);
    assert.equal(none[0].level, 'muted');
});

test('live summary for the System view: current figures plus the last hour of readings', () => {
    const stats = mkHost([
        reading({ stat: [0, 0, 0, 0, 0, 0, 0, 0] }),
        reading({ stat: [3, 0, 0, 97, 0, 0, 0, 0], load: 0.5, avail: 0.6, disk: 47 }),
        reading({ stat: [13, 0, 0, 187, 0, 0, 0, 0], load: 0.7, avail: 0.59, disk: 47 }),
    ]);
    stats.sample(); stats.sample(); stats.sample();
    const live = stats.report(7).server.live;
    assert.equal(live.windowMin, 60);
    assert.equal(live.points.length, 3);
    assert.equal(live.points[0][1], null); // the first reading has no CPU delta yet
    assert.ok(Math.abs(live.points[1][1] - 3) < 1e-9);
    assert.ok(Math.abs(live.points[2][1] - 10) < 1e-9);
    assert.ok(Math.abs(live.points[2][2] - 41) < 1e-9); // memory % used
    assert.equal(live.points[2][3], 47);
    assert.ok(Math.abs(live.cpu.used - 10) < 1e-9);
    assert.ok(Math.abs(live.cpu.idle - 90) < 1e-9);
    assert.equal(live.load.one, 0.7);
    assert.ok(Math.abs(live.memory.usedPct - 41) < 1e-9);
    assert.equal(live.memory.total, 8 * GB);
    assert.equal(live.disk.free, 53 * GB);
    assert.equal(live.disk.used, 47 * GB);
    assert.equal(live.disk.usedPct, 47);
    assert.ok(live.cores >= 1 && typeof live.arch === 'string');
});

test('live history is capped at one hour of samples, and absent before the first reading', () => {
    const stats = mkHost([reading()]);
    assert.equal(stats.report(7).server.live, null);
    for (let i = 0; i < 250; i++) stats.sample();
    assert.equal(stats.report(7).server.live.points.length, 240);
});

test('every hint says which card it belongs to', () => {
    const s = base();
    s.throttle = { periods: 5000, throttled: 600, pct: 12, heldBackSec: 90 };
    s.disks = [{ label: 'Server disk', total: 100e9, used: 90e9, free: 10e9, pct: 90, pctMax: 90 }];
    s.memory = { ...s.memory, availPctMin: 3, lowShare: 0.5 };
    s.cpu = { ...s.cpu, stealAvg: 8, stealMax: 30 };
    s.uptime = { restarts: 5 };
    const areas = Object.fromEntries(serverHints(s).map((h) => [h.text.split(' ')[0], h.area]));
    assert.equal(areas.CPU, 'throttle');
    assert.equal(areas.Disk, 'disk');
    assert.equal(areas.Memory, 'memory');
    const area = (re) => serverHints(s).find((h) => re.test(h.text)).area;
    assert.equal(area(/hypervisor/), 'cpu');
    assert.equal(area(/started 5 times/), 'uptime');
    assert.ok(serverHints(s).every((h) => ['general', 'cpu', 'throttle', 'memory', 'disk', 'uptime'].includes(h.area)));
    assert.equal(serverHints(base()).at(-1).area, 'general'); // "nothing looks strained"
});
