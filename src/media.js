'use strict';
const { parseLocal } = require('./dates');
const { MemoryCache, createSingleFlight } = require('./util');
const { computeMovieTag, computeSeriesTag, staleSeasonToLookUp } = require('./tags');

/** The catalog shows this many titles; rank badges are numbered against the same list. */
const CATALOG_SIZE = 10;
const TALK_SHOW_GENRE_ID = 10767;

// ─── Movie release dates ─────────────────────────────────────────────────────

/** TMDB release types: 1 premiere, 2 limited theatrical, 3 theatrical, 4 digital, 5 physical, 6 TV. */
function parseMovieReleases(json) {
    const results = json?.results || [];
    const us = results.find((c) => c.iso_3166_1 === 'US')?.release_dates || [];
    const everywhere = results.flatMap((c) => c.release_dates || []);

    const earliest = (releases, types) => {
        let best = null;
        for (const r of releases) {
            if (!types.includes(r.type)) continue;
            const d = parseLocal(String(r.release_date || '').substring(0, 10));
            if (d && (!best || d < best)) best = d;
        }
        return best;
    };
    // Prefer US dates; fall back to the earliest anywhere.
    const pick = (types) => earliest(us, types) || earliest(everywhere, types);
    return { theatrical: pick([1, 2, 3]), digital: pick([4]), physical: pick([5]) };
}

async function getMovieReleases(tmdb, id) {
    return parseMovieReleases(await tmdb.json(`/movie/${id}/release_dates`));
}

/** "Out" means a digital or physical release has happened, and no digital release is still in the future. */
function isOut(releases, today) {
    if (!releases) return false;
    if (releases.digital && releases.digital > today) return false; // a future digital date beats a suspicious past disc date
    return Boolean((releases.digital && releases.digital <= today) || (releases.physical && releases.physical <= today));
}

const matchesLanguage = (originalLanguage, langs) =>
    langs.includes('all') || (langs.includes('non-en') && originalLanguage !== 'en') || langs.includes(originalLanguage);

// ─── Trending list (shared by the catalog and by rank badges) ────────────────

/**
 * The ordered list behind "Top ... Today". The catalog shows the first CATALOG_SIZE entries and rank
 * badges look up an item's position in this same list, so the two can never disagree.
 * Pages are consumed whole, so the list can be a little longer than CATALOG_SIZE.
 */
function createTrending({ tmdb, now = () => new Date(), maxPages = 10, ttlMs = 10 * 60_000 }) {
    const cache = new MemoryCache({ ttlMs, maxEntries: 64 });
    const flights = createSingleFlight();

    async function build({ type, langs, digitalOnly }) {
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const today = now();
        const seen = new Set();
        const out = [];

        for (let page = 1; page <= maxPages && out.length < CATALOG_SIZE; page++) {
            const data = await tmdb.json(`/trending/${tmdbType}/day`, { page });
            if (!data.results || data.results.length === 0) break;

            const entries = [];
            for (const item of data.results) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                if (type === 'series' && item.genre_ids?.includes(TALK_SHOW_GENRE_ID)) continue;
                if (matchesLanguage(item.original_language, langs)) entries.push({ item, releases: null });
            }

            if (type === 'movie' && digitalOnly && entries.length > 0) {
                await Promise.all(entries.map(async (entry) => {
                    entry.releases = await getMovieReleases(tmdb, entry.item.id).catch(() => null);
                }));
                out.push(...entries.filter((entry) => isOut(entry.releases, today)));
            } else {
                out.push(...entries);
            }
        }
        return Object.freeze(out.map((entry) => Object.freeze(entry)));
    }

    /** @returns {Promise<ReadonlyArray<{item: object, releases: object|null}>>} */
    function list({ type, langs, digitalOnly }) {
        const kind = type === 'series' ? 'series' : 'movie';
        const key = `${kind}|${langs.join(',')}|${kind === 'movie' && digitalOnly ? 1 : 0}`;
        const hit = cache.get(key);
        if (hit) return Promise.resolve(hit);
        return flights.run(key, async () => {
            const result = await build({ type: kind, langs, digitalOnly });
            cache.set(key, result);
            return result;
        });
    }

    /** 1-based position of a TMDB id in the list, as a string; 'none' when it isn't in there. */
    async function rankOf({ type, id, langs, digitalOnly }) {
        const entries = await list({ type, langs, digitalOnly });
        const index = entries.findIndex((entry) => String(entry.item.id) === String(id));
        return index === -1 ? 'none' : String(index + 1);
    }

    return { list, rankOf };
}

// ─── Genres ──────────────────────────────────────────────────────────────────

/** Genre id -> name. Loads lazily, refreshes daily, and retries after a failure instead of staying empty forever. */
function createGenres(tmdb, { ttlMs = 24 * 3_600_000, retryMs = 60_000, logger = console } = {}) {
    let map = new Map();
    let loadedAt = 0;
    let lastAttempt = 0;
    let inflight = null;

    async function load() {
        const [movie, tv] = await Promise.all([tmdb.json('/genre/movie/list'), tmdb.json('/genre/tv/list')]);
        const next = new Map();
        for (const g of [...(movie.genres || []), ...(tv.genres || [])]) next.set(g.id, g.name);
        map = next;
        loadedAt = Date.now();
    }

    return {
        async ensure() {
            const t = Date.now();
            if (map.size > 0 && t - loadedAt < ttlMs) return map;
            if (t - lastAttempt < retryMs) return map;
            lastAttempt = t;
            inflight ??= load()
                .catch((err) => logger.error('Failed to fetch genres:', err.message))
                .finally(() => { inflight = null; });
            await inflight;
            return map;
        },
    };
}

// ─── Tags ────────────────────────────────────────────────────────────────────

/** Resolve the badge for a title. Failures are logged and produce 'none' rather than a wrong badge. */
function createTagResolver({ tmdb, now = () => new Date(), logger = console }) {
    return {
        /** `releases` may be passed if the caller already has them. */
        async movieTag(id, releases) {
            try {
                return computeMovieTag(releases ?? (await getMovieReleases(tmdb, id)), now());
            } catch (err) {
                logger.error(`Failed to get movie tag for ${id}:`, err.message);
                return 'none';
            }
        },
        /** `details` may be passed if the caller already fetched /tv/{id} (any superset of it works). */
        async seriesTag(id, details) {
            try {
                const tv = details ?? (await tmdb.json(`/tv/${id}`));
                const t = now();
                const season = staleSeasonToLookUp(tv, t);
                let episodes;
                if (season !== null) {
                    episodes = (await tmdb.json(`/tv/${id}/season/${season}`).catch(() => null))?.episodes;
                }
                return computeSeriesTag(tv, t, episodes);
            } catch (err) {
                logger.error(`Failed to get series tag for ${id}:`, err.message);
                return 'none';
            }
        },
    };
}

module.exports = {
    CATALOG_SIZE,
    parseMovieReleases,
    getMovieReleases,
    isOut,
    matchesLanguage,
    createTrending,
    createGenres,
    createTagResolver,
};
