'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Whole-machine and container figures for the dashboard's Server section.
 *
 * Linux exposes everything here as small text files, and a container sees the real numbers for the host:
 *   /proc/stat, /proc/loadavg, /proc/meminfo, /proc/uptime   the whole VM
 *   /sys/fs/cgroup/...                                      this container: its CPU cap (and how often it hit it) and memory
 *   statfs on the mounted folders                           the real disk behind the bind mounts
 * Each piece is optional: on macOS, Windows or a locked-down container the missing parts come back as null
 * and the dashboard simply leaves them out.
 */

const MB = 1024 * 1024;

// ─── Pure parsers (exported for tests) ───────────────────────────────────────

/** First line of /proc/stat: cumulative CPU time of the whole machine, in clock ticks. */
function parseProcStat(text) {
    const line = String(text || '').split('\n').find((l) => /^cpu\s/.test(l));
    if (!line) return null;
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    if (n.length < 4 || n.some((v) => !Number.isFinite(v))) return null;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = n; // guest time is already inside user
    return { user, nice, system, idle, iowait, irq, softirq, steal };
}

/**
 * Share of the machine's CPU time spent between two /proc/stat readings, in percent (all four add up to 100):
 *   busy = running code · iowait = idle but waiting on the disk · steal = taken by the hypervisor · idle = nothing to do
 */
function cpuShares(prev, cur) {
    if (!prev || !cur) return null;
    const busyOf = (t) => t.user + t.nice + t.system + t.irq + t.softirq;
    const d = {
        busy: busyOf(cur) - busyOf(prev), iowait: cur.iowait - prev.iowait,
        steal: cur.steal - prev.steal, idle: cur.idle - prev.idle,
    };
    const total = d.busy + d.iowait + d.steal + d.idle;
    if (!(total > 0) || Object.values(d).some((v) => v < 0)) return null; // counters reset, or no time passed
    const pct = (v) => (v / total) * 100;
    return { busy: pct(d.busy), iowait: pct(d.iowait), steal: pct(d.steal), idle: pct(d.idle) };
}

function parseLoadavg(text) {
    const [a, b, c] = String(text || '').trim().split(/\s+/).slice(0, 3).map(Number);
    return [a, b, c].every(Number.isFinite) ? { one: a, five: b, fifteen: c } : null;
}

/** /proc/meminfo, in bytes. "Available" is what could be handed out without swapping (not just "free"). */
function parseMeminfo(text) {
    const kb = {};
    for (const line of String(text || '').split('\n')) {
        const m = /^(\w+):\s+(\d+)/.exec(line);
        if (m) kb[m[1]] = Number(m[2]);
    }
    if (!kb.MemTotal) return null;
    const available = kb.MemAvailable ?? ((kb.MemFree || 0) + (kb.Buffers || 0) + (kb.Cached || 0));
    return {
        total: kb.MemTotal * 1024,
        available: Math.min(available, kb.MemTotal) * 1024,
        swapTotal: (kb.SwapTotal || 0) * 1024,
        swapFree: (kb.SwapFree || 0) * 1024,
    };
}

function parseUptime(text) {
    const s = Number(String(text || '').trim().split(/\s+/)[0]);
    return Number.isFinite(s) && s >= 0 ? s : null;
}

/** "key value" per line (cpu.stat, memory.stat). */
function parseKeyValue(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = /^(\w+)\s+(-?\d+)\s*$/.exec(line);
        if (m) out[m[1]] = Number(m[2]);
    }
    return out;
}

/** cgroup v2 cpu.max ("300000 100000" = 3 cores, "max 100000" = no cap) -> cores or null. */
function parseCpuMax(text) {
    const [quota, period] = String(text || '').trim().split(/\s+/);
    if (!quota || quota === 'max') return null;
    const q = Number(quota);
    const p = Number(period);
    return q > 0 && p > 0 ? q / p : null;
}

/** "max" (v2) or an absurdly large number (v1 uses 2^63) means no limit. */
function parseLimit(text) {
    const s = String(text || '').trim();
    if (!s || s === 'max') return null;
    const v = Number(s);
    return Number.isFinite(v) && v > 0 && v < 2 ** 60 ? v : null;
}

/** Same arithmetic as `df`: used / (used + available to unprivileged users). */
function diskFigures(st) {
    const bs = Number(st.bsize);
    const total = Number(st.blocks) * bs;
    const free = Number(st.bfree) * bs;
    const avail = Number(st.bavail) * bs;
    const used = total - free;
    const denom = used + avail;
    return { total, free: avail, used, pct: denom > 0 ? (used / denom) * 100 : 0 };
}

// ─── Reader ──────────────────────────────────────────────────────────────────

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const firstText = (...files) => { for (const f of files) { const t = readText(f); if (t !== null) return t; } return null; };

/**
 * `volumes`: [{ key, label, path }] folders whose disk to report. Folders on the same device are reported once
 * with their labels joined (two bind mounts of one VPS disk are one disk).
 */
function createHostReader({ procDir = '/proc', cgroupDir = '/sys/fs/cgroup', volumes = [] } = {}) {
    const v2 = fs.existsSync(path.join(cgroupDir, 'cgroup.controllers'));

    function cgroup() {
        const out = { throttle: null, cpuLimit: null, memory: null };

        // How often the CPU cap held the container back
        const cpuStat = parseKeyValue(v2
            ? readText(path.join(cgroupDir, 'cpu.stat'))
            : firstText(path.join(cgroupDir, 'cpu', 'cpu.stat'), path.join(cgroupDir, 'cpu,cpuacct', 'cpu.stat')));
        if (cpuStat.nr_periods !== undefined && cpuStat.nr_throttled !== undefined) {
            out.throttle = {
                periods: cpuStat.nr_periods,
                throttled: cpuStat.nr_throttled,
                throttledUs: cpuStat.throttled_usec ?? (cpuStat.throttled_time !== undefined ? cpuStat.throttled_time / 1000 : 0), // v1 counts nanoseconds
            };
        }

        if (v2) {
            out.cpuLimit = parseCpuMax(readText(path.join(cgroupDir, 'cpu.max')));
        } else {
            const quota = Number(firstText(path.join(cgroupDir, 'cpu', 'cpu.cfs_quota_us'), path.join(cgroupDir, 'cpu,cpuacct', 'cpu.cfs_quota_us')));
            const period = Number(firstText(path.join(cgroupDir, 'cpu', 'cpu.cfs_period_us'), path.join(cgroupDir, 'cpu,cpuacct', 'cpu.cfs_period_us')));
            out.cpuLimit = quota > 0 && period > 0 ? quota / period : null;
        }

        // Memory: like `docker stats`, file cache that can be dropped (inactive_file) is not counted as used
        const current = v2
            ? Number(readText(path.join(cgroupDir, 'memory.current')))
            : Number(readText(path.join(cgroupDir, 'memory', 'memory.usage_in_bytes')));
        if (current > 0) {
            const stat = parseKeyValue(readText(path.join(cgroupDir, v2 ? 'memory.stat' : 'memory/memory.stat')));
            const inactive = (v2 ? stat.inactive_file : stat.total_inactive_file) || 0;
            out.memory = {
                used: Math.max(0, current - inactive),
                limit: parseLimit(readText(path.join(cgroupDir, v2 ? 'memory.max' : 'memory/memory.limit_in_bytes'))),
            };
        }
        return out;
    }

    function disks() {
        if (typeof fs.statfsSync !== 'function') return [];
        const byDevice = new Map();
        for (const vol of volumes) {
            try {
                const dev = fs.statSync(vol.path).dev;
                const figures = diskFigures(fs.statfsSync(vol.path));
                const seen = byDevice.get(dev);
                if (seen) { seen.label += ` + ${vol.label.toLowerCase()}`; seen.keys.push(vol.key); } else byDevice.set(dev, { keys: [vol.key], label: vol.label, ...figures });
            } catch { /* folder not created yet, or unreadable */ }
        }
        return [...byDevice.values()].map(({ keys, ...d }) => ({ key: keys.join('+'), ...d }));
    }

    /** One reading of everything. Every field is null when this machine can't tell. */
    function read() {
        const t = (name) => readText(path.join(procDir, name));
        return {
            cpuTimes: parseProcStat(t('stat')),
            load: parseLoadavg(t('loadavg')),
            mem: parseMeminfo(t('meminfo')),
            uptime: parseUptime(t('uptime')),
            cgroup: cgroup(),
            disks: disks(),
        };
    }

    return { read };
}

/** Total size and file count of a folder (one level; the image cache is flat). Never rejects. */
async function measureDir(dir) {
    let bytes = 0;
    let files = 0;
    let names;
    try { names = await fsp.readdir(dir); } catch { return { bytes: 0, files: 0 }; }
    for (let i = 0; i < names.length; i += 64) {
        const sizes = await Promise.all(names.slice(i, i + 64).map((name) => fsp.stat(path.join(dir, name)).then((s) => (s.isFile() ? s.size : -1), () => -1)));
        for (const s of sizes) if (s >= 0) { bytes += s; files += 1; }
    }
    return { bytes, files };
}

module.exports = {
    createHostReader, measureDir, MB,
    parseProcStat, cpuShares, parseLoadavg, parseMeminfo, parseUptime, parseKeyValue, parseCpuMax, parseLimit, diskFigures,
};
