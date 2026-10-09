'use strict';
const sharp = require('sharp');

const NOW = new Date('2026-09-29T12:00:00');

const iso = (offsetDays) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + offsetDays);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const solid = (w, h, background, channels = 3) => sharp({ create: { width: w, height: h, channels, background } });
const jpegImage = (w, h, color = '#446688') => solid(w, h, color).jpeg().toBuffer();
const pngLogo = (w, h) => solid(w, h, { r: 255, g: 255, b: 255, alpha: 1 }, 4).png().toBuffer();

const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function standardImages(id, { textlessBackdrop = true } = {}) {
    return {
        posters: [{ iso_639_1: 'en', file_path: `/poster_en_${id}.jpg` }, { iso_639_1: null, file_path: `/poster_null_${id}.jpg` }],
        backdrops: [
            ...(textlessBackdrop ? [{ iso_639_1: null, file_path: `/bd_null_${id}.jpg` }] : []),
            { iso_639_1: 'en', file_path: `/bd_en_${id}.jpg` },
        ],
        logos: [{ iso_639_1: 'en', file_path: `/logo_en_${id}.png` }],
    };
}

/** Movie fixture. `releases` are [{type, date}] using TMDB release types. */
function makeMovie(id, o = {}) {
    return {
        kind: 'movie',
        id,
        title: `Movie ${id}`,
        overview: `Overview ${id}`,
        original_language: o.lang ?? 'en',
        poster_path: `/p${id}.jpg`,
        genre_ids: o.genres ?? [28],
        imdb_id: o.imdb === undefined ? `tt${1000000 + id}` : o.imdb,
        releases: o.releases ?? [{ type: 3, date: iso(-120) }, { type: 4, date: iso(-60) }],
        images: o.images ?? standardImages(id),
        providers: o.providers ?? null,
    };
}

/** Show fixture; `tv` overrides fields of the /tv/{id} payload. */
function makeShow(id, o = {}) {
    return {
        kind: 'tv',
        id,
        name: `Show ${id}`,
        overview: `Overview ${id}`,
        original_language: o.lang ?? 'en',
        poster_path: `/p${id}.jpg`,
        genre_ids: o.genres ?? [18],
        imdb: o.imdb === undefined ? `tt${2000000 + id}` : o.imdb,
        images: o.images ?? standardImages(id),
        providers: o.providers ?? null,
        seasonEpisodes: o.seasonEpisodes ?? {},
        tv: {
            first_air_date: iso(-400),
            last_air_date: iso(-100),
            status: 'Returning Series',
            number_of_seasons: 2,
            seasons: [{ season_number: 1, air_date: iso(-400), episode_count: 8 }, { season_number: 2, air_date: iso(-200), episode_count: 8 }],
            last_episode_to_air: { season_number: 2, episode_number: 5, air_date: iso(-100), episode_type: 'standard' },
            next_episode_to_air: null,
            networks: [{ name: 'HBO', logo_path: '/hbo.png' }],
            ...o.tv,
        },
    };
}

/**
 * A fetch() stand-in that behaves like api.themoviedb.org + image.tmdb.org for the given fixtures.
 * `fail` maps a substring of "host+path" to a status code (or a function returning a Response) to simulate outages.
 */
function createFakeTmdb({ movies = [], shows = [], fail = {}, cdnImages = {}, providerCatalog = [] } = {}) {
    const calls = [];
    const byId = (list, id) => list.find((x) => String(x.id) === String(id));
    const genres = {
        movie: [{ id: 28, name: 'Action' }, { id: 35, name: 'Comedy' }],
        tv: [{ id: 18, name: 'Drama' }, { id: 10759, name: 'Action & Adventure' }],
    };
    const summary = (x) => ({
        id: x.id, title: x.title, name: x.name, overview: x.overview, original_language: x.original_language,
        poster_path: x.poster_path, genre_ids: x.genre_ids,
    });

    async function api(url) {
        const parts = url.pathname.replace(/^\/3\//, '').split('/');
        const page = Number(url.searchParams.get('page') || 1);

        if (parts[0] === 'watch' && parts[1] === 'providers' && parts[2] === 'tv') {
            return json({ results: providerCatalog });
        }
        if (parts[0] === 'trending') {
            const list = parts[1] === 'tv' ? shows : movies;
            return json({ page, results: list.slice((page - 1) * 20, page * 20).map(summary) });
        }
        if (parts[0] === 'genre') return json({ genres: genres[parts[1]] });

        const list = parts[0] === 'tv' ? shows : movies;
        const item = byId(list, parts[1]);
        if (!item) return json({ status_message: 'not found' }, 404);
        const sub = parts.slice(2).join('/');

        if (sub === 'release_dates') {
            return json({ results: [{ iso_3166_1: 'US', release_dates: item.releases.map((r) => ({ type: r.type, release_date: `${r.date}T00:00:00.000Z` })) }] });
        }
        if (sub === 'images') return json(item.images);
        if (sub === 'watch/providers') return json({ results: item.providers ? { US: item.providers } : {} });
        if (sub.startsWith('season/')) return json({ episodes: item.seasonEpisodes[sub.split('/')[1]] || [] });
        if (sub === '') {
            const extras = url.searchParams.get('append_to_response');
            const base = item.kind === 'tv'
                ? { id: item.id, name: item.name, original_language: item.original_language, ...item.tv }
                : { id: item.id, title: item.title, original_language: item.original_language, imdb_id: item.imdb_id };
            if (extras) {
                base.external_ids = { imdb_id: item.kind === 'tv' ? item.imdb : item.imdb_id };
                base.images = item.images;
            }
            return json(base);
        }
        return json({ status_message: 'unknown endpoint' }, 404);
    }

    async function cdn(url) {
        const size = url.pathname.split('/')[3];
        if (cdnImages[url.pathname]) return new Response(cdnImages[url.pathname], { status: 200 });
        if (size === 'w500') return new Response(await jpegImage(500, 750), { status: 200 });
        if (size === 'w1280') return new Response(await jpegImage(1280, 720), { status: 200 });
        if (size === 'w154') return new Response(await pngLogo(154, 154), { status: 200 });
        return new Response(await pngLogo(600, 200), { status: 200 }); // 'original' title logos
    }

    async function fetchImpl(input) {
        const url = new URL(String(input));
        const record = url.host + url.pathname + url.search.replace(/api_key=[^&]*&?/, '');
        calls.push(record);
        for (const [needle, outcome] of Object.entries(fail)) {
            if (record.includes(needle)) {
                if (typeof outcome === 'function') return outcome();
                return new Response('boom', { status: outcome });
            }
        }
        return url.host === 'image.tmdb.org' ? cdn(url) : api(url);
    }

    return {
        fetch: fetchImpl,
        calls,
        count: (needle) => calls.filter((c) => c.includes(needle)).length,
        reset: () => { calls.length = 0; },
    };
}

module.exports = { NOW, iso, makeMovie, makeShow, standardImages, createFakeTmdb, jpegImage, pngLogo };
