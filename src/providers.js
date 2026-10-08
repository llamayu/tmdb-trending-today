'use strict';

const clean = (str) => (str ? str.toLowerCase().replace(/\+/g, 'plus').replace(/\s+/g, '') : '');

// Broadcast/cable networks -> the streaming service that carries them
const NETWORK_TO_PROVIDER = Object.freeze({
    hbo: 'max', cbs: 'paramount', nbc: 'peacock',
    fx: 'hulu', abc: 'hulu', fox: 'hulu',
    amc: 'amc', showtime: 'paramount', 'the cw': 'max', bbc: 'britbox',
});

// Preference order when several flat-rate providers carry a title
const TOP_TIERS = ['netflix', 'max', 'disney', 'hulu', 'apple', 'paramount', 'peacock',
    'crunchyroll', 'mgm', 'starz', 'showtime', 'amc', 'amazon'];

// Networks that ARE streaming services -> a fragment of that service's name in TMDB's provider list.
// Used when TMDB has no streaming availability for a title, so its icon can still be the service's app icon
// instead of the network's (often wide) wordmark. Keys and values are in `clean()` form.
const STREAMING_NETWORKS = Object.freeze({
    primevideo: 'primevideo', amazon: 'primevideo', amazonprimevideo: 'primevideo',
    netflix: 'netflix',
    appletvplus: 'appletvplus',
    disneyplus: 'disneyplus',
    hulu: 'hulu',
    paramountplus: 'paramountplus',
    peacock: 'peacock',
    max: 'max', hbomax: 'max',
    crunchyroll: 'crunchyroll',
});

const isChannelStore = (name) =>
    (name.includes('amazon') && name.includes('channel')) ||
    (name.includes('roku') && name.includes('premium')) ||
    (name.includes('apple') && name.includes('channel'));

/**
 * The provider-list entry for the streaming service a network stands for ("Prime Video" -> Amazon Prime Video).
 * Prefers an exact name, then one starting with it, then the shortest that contains it, so "Max" beats "Cinemax"
 * and the plain service beats its "with Ads" tier. Channel/store variants are ignored.
 * @param {string} networkName
 * @param {Array<{provider_name: string, logo_path: string}>} catalog TMDB's /watch/providers/tv results
 */
function streamingServiceFor(networkName, catalog) {
    const key = clean(networkName);
    if (!Array.isArray(catalog) || !Object.hasOwn(STREAMING_NETWORKS, key)) return null;
    const fragment = STREAMING_NETWORKS[key];
    const tier = (name) => (name === fragment ? 0 : name.startsWith(fragment) ? 1 : 2);
    const matches = catalog
        .map((p) => ({ p, name: clean(p.provider_name) }))
        .filter(({ p, name }) => p.logo_path && name.includes(fragment) && !isChannelStore(name))
        .sort((a, b) => tier(a.name) - tier(b.name) || a.name.length - b.name.length);
    return matches.length ? matches[0].p : null;
}

/**
 * Pick the logo to show in the corner of the artwork.
 * @param {'tv'|'movie'} tmdbType
 * @param {object} details TMDB details, with the watch-providers payload under 'watch/providers'
 * @param {Array} [providerCatalog] TMDB's /watch/providers/tv results; only needed for the network fallback (step 3)
 * @returns {{path: string, isNetwork: boolean}|null}
 */
function resolveProviderLogoInfo(tmdbType, details, providerCatalog) {
    const us = details['watch/providers']?.results?.US;

    // Skip "channel"/"store-within-a-store" versions of a service
    const flatrate = (us?.flatrate || []).filter((p) => !isChannelStore(clean(p.provider_name)));
    const network = tmdbType === 'tv' ? details.networks?.[0] : null;

    // 1. TV: the streaming service that matches the original network
    if (network && flatrate.length > 0) {
        const key = (network.name || '').toLowerCase();
        const target = Object.hasOwn(NETWORK_TO_PROVIDER, key) ? NETWORK_TO_PROVIDER[key] : clean(network.name);
        if (target) {
            const matched = flatrate.find((p) => {
                const name = clean(p.provider_name);
                return name.includes(target) || target.includes(name);
            });
            if (matched) return { path: matched.logo_path, isNetwork: false };
        }
    }

    // 2. Otherwise the best-ranked flat-rate provider
    if (flatrate.length > 0) {
        let best = null;
        let bestIdx = Infinity;
        for (const p of flatrate) {
            const idx = TOP_TIERS.findIndex((t) => clean(p.provider_name).includes(t));
            if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = p; }
        }
        if (!best) best = flatrate.find((p) => !clean(p.provider_name).includes('amazon')) || flatrate[0];
        return { path: best.logo_path, isNetwork: false };
    }

    // 3. No streaming availability, but the network is itself a streaming service: use that service's own icon
    if (network) {
        const service = streamingServiceFor(network.name, providerCatalog);
        if (service) return { path: service.logo_path, isNetwork: false };
    }

    // 4. Fall back to the raw network logo
    if (network) return { path: network.logo_path, isNetwork: true };
    return null;
}

module.exports = { resolveProviderLogoInfo, streamingServiceFor };
