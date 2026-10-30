'use strict';

const LANG = /^(null|[a-z]{2,3})$/;
const LIST_LANG_TOKEN = /^(all|non-en|[a-z]{2,3})$/;

/** First key that is present (older installs used "landscape..." / "portrait..." names and un-prefixed ones). */
const pick = (cfg, keys) => {
    for (const k of keys) if (cfg[k] !== undefined) return cfg[k];
    return undefined;
};
const firstTruthy = (cfg, keys) => {
    for (const k of keys) if (cfg[k]) return cfg[k];
    return undefined;
};
/** dflt=true: on unless "false". dflt=false: off unless "true". */
const flag = (value, dflt) => (value === undefined ? dflt : dflt ? value !== 'false' : value === 'true');
/**
 * The tag's tint. "glass" is the default and is left out of the result on purpose: the configured manifest id is a hash of these
 * settings, and adding a key to everyone's would give every existing install a new id.
 */
const isTinted = (value) => value === 'tinted';
const language = (value) => (LANG.test(value || '') ? value : 'en');

function parseListLang(value) {
    const tokens = String(value || 'en').split(',').map((t) => t.trim()).filter((t) => LIST_LANG_TOKEN.test(t));
    const unique = [...new Set(tokens)].slice(0, 12);
    return unique.length ? unique : ['en'];
}

/**
 * Turn the raw `key=value|key=value` install-URL settings into a validated object.
 * Unknown keys are ignored; bad values fall back to defaults.
 */
function parseUserConfig(cfg = {}) {
    const listLangs = parseListLang(cfg.listLang);
    const parsed = {
        backdropTags: flag(pick(cfg, ['backdropTags', 'landscapeTags', 'tags']), true),
        backdropLogos: flag(pick(cfg, ['backdropLogos', 'landscapeLogos', 'logos']), false),
        backdropRanked: flag(pick(cfg, ['backdropRanked', 'landscapeRanked']), false),
        backdropLanguage: language(firstTruthy(cfg, ['backdropLanguage', 'landscapePosterLang', 'posterLang'])),
        posterTags: flag(pick(cfg, ['posterTags', 'portraitTags', 'tags']), true),
        posterLogos: flag(pick(cfg, ['posterLogos', 'portraitLogos', 'logos']), false),
        posterRanked: flag(pick(cfg, ['posterRanked', 'portraitRanked', 'ranked']), true),
        posterLanguage: language(firstTruthy(cfg, ['posterLanguage', 'portraitPosterLang', 'posterLang'])),
        textlessArtwork: flag(cfg.textlessArtwork, false),
        backdropTextlessArtwork: flag(cfg.backdropTextlessArtwork, false),
        posterShape: cfg.posterShape === 'landscape' ? 'landscape' : 'portrait',
        digitalOnly: flag(cfg.digitalOnly, true),
        listLangs,
        listLang: listLangs.join(','),
    };
    // Only "tinted" is stored; glass (the default) adds no key at all.
    if (isTinted(cfg.backdropTagTone)) parsed.backdropTagTone = 'tinted';
    if (isTinted(cfg.posterTagTone)) parsed.posterTagTone = 'tinted';
    return parsed;
}

/** The `<config>` path segment of an install URL -> plain object. Never throws on malformed input. */
function parseConfigSegment(segment) {
    const out = Object.create(null);
    if (!segment) return out;
    for (const pair of String(segment).split('|')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const value = pair.slice(eq + 1);
        if (!value) continue;
        const key = pair.slice(0, eq);
        try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
    }
    return out;
}

module.exports = { parseUserConfig, parseConfigSegment, parseListLang };
