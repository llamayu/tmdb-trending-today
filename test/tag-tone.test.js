'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTmdbClient } = require('../src/tmdb');
const { createTrending, createGenres, createTagResolver } = require('../src/media');
const { createCatalog, configuredManifestId, artUrl } = require('../src/catalog');
const { parseUserConfig } = require('../src/userConfig');
const { parseImageQuery, imageKey, imageGroup } = require('../src/http');
const { NOW, iso, makeMovie, createFakeTmdb } = require('./helpers/fakeTmdb');

const silent = { warn() {}, error() {}, log() {} };

test('tag tone: only "tinted" is stored; glass is the default and never changes the manifest id', () => {
    assert.equal(parseUserConfig({ posterTagTone: 'tinted' }).posterTagTone, 'tinted');
    assert.equal(parseUserConfig({ backdropTagTone: 'tinted' }).backdropTagTone, 'tinted');
    for (const v of [undefined, 'glass', 'light', 'dark', 'TINTED', 'purple', '']) assert.ok(!('posterTagTone' in parseUserConfig({ posterTagTone: v }))); // no key at all

    // Glass is the default and adds no key to the hashed settings
    const defaults = configuredManifestId({ listLang: 'en' });
    assert.equal(configuredManifestId({ listLang: 'en', posterTagTone: 'glass', backdropTagTone: 'glass' }), defaults);
    assert.equal(configuredManifestId({ listLang: 'en', posterTagTone: 'nonsense' }), defaults);
    assert.notEqual(configuredManifestId({ listLang: 'en', posterTagTone: 'tinted' }), defaults);
    assert.notEqual(configuredManifestId({ listLang: 'en', posterTagTone: 'tinted' }), configuredManifestId({ listLang: 'en', backdropTagTone: 'tinted' }));
});

test('tag tone: image parameters are validated and get their own cache entries', () => {
    assert.equal(parseImageQuery({}).tagTone, 'glass');
    assert.equal(parseImageQuery({ tagTone: 'glass' }).tagTone, 'glass');
    assert.equal(parseImageQuery({ tagTone: 'tinted' }).tagTone, 'tinted');
    assert.equal(parseImageQuery({ tagTone: 'dark' }).tagTone, 'glass');
    assert.equal(parseImageQuery({ tagTone: '<script>' }).tagTone, 'glass');

    const base = { format: 'jpg', type: 'movie', tag: 'just_added', rank: '1', lang: 'en', logos: false, textless: false };
    const glass = imageKey('poster', '603', { ...base, tagTone: 'glass' });
    assert.equal(glass, imageKey('poster', '603', base)); // no tone given = glass
    const tinted = imageKey('poster', '603', { ...base, tagTone: 'tinted' });
    assert.notEqual(tinted, glass);
    assert.equal(imageGroup(tinted), imageGroup(glass)); // clearing a title still clears both looks
});

test('tag tone: tinted is added to artwork URLs only when it matters', () => {
    const art = { type: 'movie', tag: 'just_added', rank: 1, lang: 'en', logos: false };
    assert.equal(artUrl('https://a.test', 'poster', 1, art), 'https://a.test/poster/1.jpg?type=movie&tag=just_added&rank=1&lang=en&logos=0');
    assert.equal(artUrl('https://a.test', 'poster', 1, { ...art, tagTone: 'glass' }), 'https://a.test/poster/1.jpg?type=movie&tag=just_added&rank=1&lang=en&logos=0');
    assert.equal(artUrl('https://a.test', 'poster', 1, { ...art, tagTone: 'tinted' }), 'https://a.test/poster/1.jpg?type=movie&tag=just_added&rank=1&lang=en&logos=0&tagTone=tinted');
    // no tag drawn, so the tone is meaningless and must not multiply cached images
    assert.equal(artUrl('https://a.test', 'poster', 1, { ...art, tag: 'none', tagTone: 'tinted' }), 'https://a.test/poster/1.jpg?type=movie&tag=none&rank=1&lang=en&logos=0');
});

test('tag tone: the catalog applies each kind\u2019s own setting', async () => {
    const fake = createFakeTmdb({ movies: [makeMovie(1, { releases: [{ type: 3, date: iso(-30) }, { type: 4, date: iso(-2) }] })] }); // a recent digital release: a "just added" tag is drawn
    const tmdb = createTmdbClient({ apiKey: 'k', fetchImpl: fake.fetch, sleep: async () => {}, logger: silent });
    const catalog = createCatalog({
        tmdb, trending: createTrending({ tmdb, now: () => NOW }), tags: createTagResolver({ tmdb, now: () => NOW, logger: silent }),
        genres: createGenres(tmdb, { logger: silent }), addonUrl: 'https://addon.test',
    });

    const none = (await catalog.getCatalog('movie', {})).metas[0];
    assert.doesNotMatch(none.poster, /tagTone/);
    assert.doesNotMatch(none.background, /tagTone/);

    const posterTinted = (await catalog.getCatalog('movie', { posterTagTone: 'tinted' })).metas[0];
    assert.match(posterTinted.poster, /&tagTone=tinted$/);
    assert.doesNotMatch(posterTinted.background, /tagTone/);

    const backdropTinted = (await catalog.getCatalog('movie', { backdropTags: 'true', backdropTagTone: 'tinted' })).metas[0];
    assert.doesNotMatch(backdropTinted.poster, /tagTone/);
    assert.match(backdropTinted.background, /tagTone=tinted/);

    const tagsOff = (await catalog.getCatalog('movie', { posterTags: 'false', posterRanked: 'false', posterTagTone: 'tinted' })).metas[0];
    assert.doesNotMatch(tagsOff.poster, /tagTone/); // Off wins over a leftover tone
});
