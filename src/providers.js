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
 * The provider-list entry for the streaming service a network maps to ("Prime Video" -> Amazon Prime Video).
 * Prefers an exact name, then one starting with it, then the shortest that contains it, so "Max" beats "Cinemax"
 * and the plain service beats its "with Ads" tier. Channel/store variants are ignored.
 * @param {string} networkName
 * @param {Array<{provider_name: string, logo_path: string}>} catalog TMDB's /watch/providers/tv results
 */
function streamingServiceFor(networkName, catalog) {
    const key = clean(networkName);
    if (!Array.isArray(catalog)) return null;
    const fragment = STREAMING_NETWORKS[key] || NETWORK_TO_PROVIDER[(networkName || '').toLowerCase()];
    if (!fragment) return null;
    const normalizedFragment = clean(fragment);
    const tier = (name) => (name === normalizedFragment ? 0 : name.startsWith(normalizedFragment) ? 1 : 2);
    const matches = catalog
        .map((p) => ({ p, name: clean(p.provider_name) }))
        .filter(({ p, name }) => p.logo_path && name.includes(normalizedFragment) && !isChannelStore(name))
        .sort((a, b) => tier(a.name) - tier(b.name) || a.name.length - b.name.length);
    return matches.length ? matches[0].p : null;
}

function isStreamingNetwork(networkName) {
    return Object.hasOwn(STREAMING_NETWORKS, clean(networkName));
}

function hasNetworkProviderMapping(networkName) {
    const key = clean(networkName);
    return Object.hasOwn(STREAMING_NETWORKS, key) || Object.hasOwn(NETWORK_TO_PROVIDER, (networkName || '').toLowerCase());
}

/**
 * Pick the logo to show in the corner of the artwork.
 * @param {'tv'|'movie'} tmdbType
 * @param {object} details TMDB details, with the watch-providers payload under 'watch/providers'
 * @param {Array} [providerCatalog] TMDB's /watch/providers/tv results; only used when the title has no providers
 * @returns {{path: string, isNetwork: boolean}|null}
 */
function resolveProviderLogoInfo(tmdbType, details, providerCatalog) {
    const us = details['watch/providers']?.results?.US;

    // Skip "channel"/"store-within-a-store" versions of a service
    const flatrate = (us?.flatrate || []).filter((p) => !isChannelStore(clean(p.provider_name)));
    const network = tmdbType === 'tv' ? details.networks?.[0] : null;

    // Prefer actual title-specific availability; network mappings are fallback-only.
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

    // Only map the network to a service logo when the title has no streaming availability.
    if (network && hasNetworkProviderMapping(network.name)) {
        const service = streamingServiceFor(network.name, providerCatalog);
        if (service) return { path: service.logo_path, isNetwork: false };
        if (Object.hasOwn(STREAMING_NETWORKS, clean(network.name))) return null;
    }

    // Fall back to the raw network logo
    if (network) return { path: network.logo_path, isNetwork: true };
    return null;
}

module.exports = { resolveProviderLogoInfo, streamingServiceFor, isStreamingNetwork, hasNetworkProviderMapping };
