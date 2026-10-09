'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTmdbClient } = require('../src/tmdb');
const { parseMovieReleases, createTrending, createGenres, createTagResolver, isOut } = require('../src/media');
const { createCatalog, buildManifest } = require('../src/catalog');
const { NOW, iso, makeMovie, makeShow, createFakeTmdb } = require('./helpers/fakeTmdb');

const silent = { warn() {}, error() {}, log() {} };
const now = () => NOW;
const setup = (fixtures, { imageExt } = {}) => {
    const fake = createFakeTmdb(fixtures);
    const tmdb = createTmdbClient({ apiKey: 'k', fetchImpl: fake.fetch, sleep: async () => {}, logger: silent });
    const trending = createTrending({ tmdb, now });
    const tags = createTagResolver({ tmdb, now, logger: silent });
    const genres = createGenres(tmdb, { logger: silent });
    const catalog = createCatalog({ tmdb, trending, tags, genres, addonUrl: 'https://addon.test', imageExt });
    return { fake, tmdb, trending, tags, genres, catalog };
};

test('parseMovieReleases prefers US dates and falls back to worldwide', () => {
    const r = parseMovieReleases({
        results: [
            { iso_3166_1: 'GB', release_dates: [{ type: 3, release_date: '2025-01-01T00:00:00.000Z' }, { type: 4, release_date: '2025-02-01T00:00:00.000Z' }] },
            { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2025-03-01T00:00:00.000Z' }, { type: 5, release_date: '2025-06-01T00:00:00.000Z' }, { type: 5, release_date: 'garbage' }] },
        ],
    });
    assert.equal(r.theatrical.getMonth(), 2); // US March, not GB January
    assert.equal(r.digital.getMonth(), 1); // no US digital date: worldwide February
    assert.equal(r.physical.getMonth(), 5);
    assert.deepEqual(parseMovieReleases({}), { theatrical: null, digital: null, physical: null });
});

test('isOut', () => {
    const d = (n) => new Date(NOW.getTime() + n * 86_400_000);
    assert.equal(isOut({ digital: d(-1), physical: null }, NOW), true);
    assert.equal(isOut({ digital: null, physical: d(-1) }, NOW), true);
    assert.equal(isOut({ digital: d(3), physical: d(-30) }, NOW), false); // future digital date beats a suspicious disc date
    assert.equal(isOut({ digital: null, physical: null }, NOW), false);
    assert.equal(isOut(null, NOW), false);
});

test('trending: filters by language and by digital availability, pulling extra pages when needed', async () => {
    const out = { releases: [{ type: 3, date: iso(-90) }, { type: 4, date: iso(-60) }] };
    const inCinemas = { releases: [{ type: 3, date: iso(-10) }] };
    const movies = [];
    // page 1: 20 items, only 4 of them are out digitally; page 2: plenty
    for (let i = 1; i <= 20; i++) movies.push(makeMovie(i, i % 5 === 0 ? out : inCinemas));
    for (let i = 21; i <= 40; i++) movies.push(makeMovie(i, out));
    const { trending, fake } = setup({ movies });

    const list = await trending.list({ type: 'movie', langs: ['en'], digitalOnly: true });
    assert.deepEqual(list.slice(0, 5).map((e) => e.item.id), [5, 10, 15, 20, 21]);
    assert.ok(list.length >= 10);
    assert.ok(list[0].releases.digital instanceof Date);
    assert.equal(fake.count('/trending/movie/day'), 2);

    const unfiltered = await trending.list({ type: 'movie', langs: ['en'], digitalOnly: false });
    assert.equal(unfiltered[0].item.id, 1);
    assert.equal(unfiltered[0].releases, null);
    assert.equal(unfiltered.length, 20);

    await assert.rejects(async () => { list[0].item.id = 99; }, TypeError); // shared list is frozen
});

test('trending: language rules', async () => {
    const movies = [makeMovie(1, { lang: 'en' }), makeMovie(2, { lang: 'ja' }), makeMovie(3, { lang: 'ko' }), makeMovie(4, { lang: 'fr' })];
    const { trending } = setup({ movies });
    const ids = async (langs) => (await trending.list({ type: 'movie', langs, digitalOnly: false })).map((e) => e.item.id);
    assert.deepEqual(await ids(['en']), [1]);
    assert.deepEqual(await ids(['all']), [1, 2, 3, 4]);
    assert.deepEqual(await ids(['non-en']), [2, 3, 4]);
    assert.deepEqual(await ids(['ja', 'ko']), [2, 3]);
});

test('trending: concurrent callers share one build; rankOf agrees with the list', async () => {
    const movies = Array.from({ length: 25 }, (_, i) => makeMovie(i + 1));
    const { trending, fake } = setup({ movies });
    const args = { type: 'movie', langs: ['en'], digitalOnly: true };
    await Promise.all(Array.from({ length: 10 }, () => trending.list(args)));
    const pages = fake.count('/trending/movie/day');
    assert.ok(pages <= 2, `expected one build, saw ${pages} page fetches`);
    assert.equal(await trending.rankOf({ ...args, id: '3' }), '3');
    assert.equal(await trending.rankOf({ ...args, id: 3 }), '3');
    assert.equal(await trending.rankOf({ ...args, id: '9999' }), 'none');
});

test('genres load lazily and recover after a failure', async () => {
    let healthy = false;
    const fake = createFakeTmdb({ fail: { '/genre/': () => new Response('x', { status: 500 }) } });
    const tmdb = createTmdbClient({ apiKey: 'k', retries: 0, sleep: async () => {}, logger: silent, fetchImpl: (u) => (healthy ? createFakeTmdb().fetch(u) : fake.fetch(u)) });
    const genres = createGenres(tmdb, { retryMs: 0, logger: silent });
    assert.equal((await genres.ensure()).size, 0); // failed, but did not throw
    healthy = true;
    const map = await genres.ensure(); // tries again instead of staying empty forever
    assert.equal(map.get(28), 'Action');
    assert.equal(map.get(18), 'Drama');
});

test('tag resolver: movie and series, using the same rules everywhere', async () => {
    const { tags, fake } = setup({
        movies: [makeMovie(1, { releases: [{ type: 3, date: iso(-40) }, { type: 4, date: iso(-3) }] })],
        shows: [
            makeShow(2, { tv: { last_episode_to_air: { season_number: 2, episode_number: 8, air_date: iso(-4), episode_type: 'finale' } } }),
            // TMDB left an already-aired episode in next_episode_to_air; the season list shows episode 7 aired yesterday
            makeShow(3, {
                tv: { last_episode_to_air: { season_number: 2, episode_number: 3, air_date: iso(-30), episode_type: 'standard' }, next_episode_to_air: { season_number: 2, episode_number: 4, air_date: iso(-21), episode_type: 'standard' } },
                seasonEpisodes: { 2: [[4, -21], [5, -14], [6, -7], [7, -1], [8, 6]].map(([n, offset]) => ({ season_number: 2, episode_number: n, air_date: iso(offset) })) },
            }),
        ],
    });
    assert.equal(await tags.movieTag('1'), 'just_added');
    assert.equal(await tags.seriesTag('2'), 'season_finale');
    assert.equal(await tags.seriesTag('3'), 'new_episode');
    assert.ok(fake.count('/tv/3/season/2') >= 1);
    assert.equal(await tags.movieTag('404'), 'none'); // unknown title: no badge, no throw
    assert.equal(await tags.seriesTag('404'), 'none');
});

test('catalog: movies', async () => {
    const movies = [
        makeMovie(1, { genres: [28, 35] }),
        makeMovie(2, { releases: [{ type: 3, date: iso(-40) }, { type: 4, date: iso(-2) }], imdb: null }),
        ...Array.from({ length: 12 }, (_, i) => makeMovie(i + 3)),
    ];
    const { catalog, fake } = setup({ movies });
    const { metas, cacheMaxAge } = await catalog.getCatalog('movie', {});

    assert.equal(metas.length, 10);
    assert.ok(cacheMaxAge > 0);
    assert.equal(metas[0].id, 'tt1000001');
    assert.equal(metas[0].name, 'Movie 1');
    assert.deepEqual(metas[0].genres, ['Action', 'Comedy']);
    assert.equal(metas[0].posterShape, 'poster');
    assert.equal(metas[0].logo, 'https://image.tmdb.org/t/p/original/logo_en_1.png');
    assert.equal(metas[1].id, 'tmdb:2'); // no IMDb id: falls back to the TMDB id

    // Parameter order is a public contract; the extension is .jpg by default (see the PNG test below)
    assert.equal(metas[1].poster, 'https://addon.test/poster/2.jpg?type=movie&tag=just_added&rank=2&lang=en&logos=0');
    assert.equal(metas[1].background, 'https://addon.test/backdrop/2.jpg?type=movie&tag=just_added&rank=none&lang=en&logos=0&titleStyle=gradient-v9');

    // Details / tags are only fetched for the titles that are shown
    assert.equal(fake.calls.filter((c) => /\/3\/movie\/\d+\?/.test(c) && c.includes('append_to_response')).length, 10);
});

test('catalog: settings change the URLs', async () => {
    const { catalog } = setup({ movies: [makeMovie(1)], shows: [makeShow(9)] });

    const off = (await catalog.getCatalog('movie', { posterTags: 'false', posterRanked: 'false', backdropTags: 'false' })).metas[0];
    assert.equal(off.poster, 'https://image.tmdb.org/t/p/w500/p1.jpg'); // nothing to draw: straight to TMDB
    assert.equal(off.background, 'https://addon.test/backdrop/1.jpg?type=movie&tag=none&rank=none&lang=en&logos=0&titleStyle=gradient-v9');

    const custom = (await catalog.getCatalog('movie', { posterLanguage: 'ja', posterLogos: 'true', backdropRanked: 'true', backdropLanguage: 'null' })).metas[0];
    assert.match(custom.poster, /lang=ja&logos=1$/);
    assert.match(custom.background, /rank=1&lang=null&logos=0&titleStyle=gradient-v9$/);

    // Landscape: the tile follows the poster settings and the background follows the backdrop settings, exactly like portrait
    const landscape = (await catalog.getCatalog('series', { posterShape: 'landscape', posterRanked: 'false', backdropRanked: 'true', backdropLanguage: 'null' })).metas[0];
    assert.equal(landscape.posterShape, 'landscape');
    assert.equal(landscape.poster, 'https://addon.test/backdrop/9.jpg?type=series&tag=none&rank=none&lang=en&logos=0&titleStyle=gradient-v9');
    assert.equal(landscape.background, 'https://addon.test/backdrop/9.jpg?type=series&tag=none&rank=1&lang=null&logos=0&titleStyle=gradient-v9');

    const textless = (await catalog.getCatalog('movie', {
        textlessArtwork: 'true', posterTags: 'false', posterRanked: 'false',
    })).metas[0];
    assert.equal(textless.poster, 'https://addon.test/poster/1.jpg?type=movie&tag=none&rank=none&lang=en&logos=0&textless=1&titleStyle=gradient-v9');
    assert.equal(textless.background, 'https://addon.test/backdrop/1.jpg?type=movie&tag=none&rank=none&lang=en&logos=0&titleStyle=gradient-v9');

    const curatedBackground = (await catalog.getCatalog('movie', {
        backdropTextlessArtwork: 'true', backdropTags: 'false', backdropRanked: 'false',
        posterTags: 'false', posterRanked: 'false',
    })).metas[0];
    assert.equal(curatedBackground.background, 'https://addon.test/backdrop/1.jpg?type=movie&tag=none&rank=none&lang=en&logos=0&textless=1&titleStyle=gradient-v9');
    assert.equal(curatedBackground.poster, 'https://image.tmdb.org/t/p/w500/p1.jpg');
});

test('catalog: IMAGE_FORMAT=png keeps handing out .png URLs', async () => {
    const { catalog } = setup({ movies: [makeMovie(1)] }, { imageExt: 'png' });
    const meta = (await catalog.getCatalog('movie', {})).metas[0];
    assert.equal(meta.poster, 'https://addon.test/poster/1.png?type=movie&tag=none&rank=1&lang=en&logos=0');
    assert.match(meta.background, /^https:\/\/addon\.test\/backdrop\/1\.png\?/);
});

test('catalog: series tags, and the non-English language chip', async () => {
    const shows = [makeShow(1, { lang: 'ko', tv: { last_episode_to_air: { season_number: 2, episode_number: 8, air_date: iso(-2), episode_type: 'finale' } } })];
    const { catalog } = setup({ shows });
    const meta = (await catalog.getCatalog('series', { listLang: 'non-en' })).metas[0];
    assert.match(meta.poster, /tag=season_finale/);
    assert.equal(meta.genres[0], 'Korean');
    assert.equal(meta.id, 'tt2000001');
});

test('catalog: survives a failed details request for one title', async () => {
    const { catalog } = setup({
        movies: [makeMovie(1), makeMovie(2)],
        fail: { '/3/movie/2?append_to_response': 500 },
    });
    const { metas } = await catalog.getCatalog('movie', {});
    assert.equal(metas.length, 2);
    assert.equal(metas[1].id, 'tmdb:2');
});

test('manifest keeps the identity existing installs rely on', () => {
    const m = buildManifest('https://addon.test');
    assert.equal(m.id, 'com.trending.custom');
    assert.deepEqual(m.catalogs.map((c) => c.id), ['top_shows_today', 'top_movies_today']);
    assert.equal(m.behaviorHints.configurationURL, 'https://addon.test/configure');
    assert.equal(m.logo, 'https://addon.test/favicon.svg');
});
