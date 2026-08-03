const express = require("express");
const { addonBuilder } = require("stremio-addon-sdk");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    next();
});

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const ADDON_URL = process.env.ADDON_URL;

const imageCache = new Map();
const tmdbCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TMDB_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_DIR = path.join(__dirname, "image-cache");

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFilePath(cacheKey) {
    const hash = crypto.createHash("sha256").update(cacheKey).digest("hex");
    return path.join(CACHE_DIR, `${hash}.png`);
}

async function fetchTmdbJson(url) {
    const cached = tmdbCache.get(url);
    if (cached && Date.now() < cached.expires) {
        return cached.data;
    }

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`TMDB fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    tmdbCache.set(url, { data, expires: Date.now() + TMDB_CACHE_TTL_MS });
    if (tmdbCache.size > 1000) {
        const oldestKey = tmdbCache.keys().next().value;
        tmdbCache.delete(oldestKey);
    }
    return data;
}

let genreMap = {};
async function fetchGenres() {
    try {
        const [movieRes, tvRes] = await Promise.all([
            fetchTmdbJson(`https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}`),
            fetchTmdbJson(`https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_API_KEY}`)
        ]);
        if (movieRes.genres) movieRes.genres.forEach(g => genreMap[g.id] = g.name);
        if (tvRes.genres) tvRes.genres.forEach(g => genreMap[g.id] = g.name);
        console.log("Genres loaded successfully!");
    } catch (error) { console.error("Failed to fetch genres:", error); }
}
fetchGenres();

const manifest = {
    id: "com.trending.custom",
    version: "1.12.2",
    name: "TMDB Top Today",
    description: "Customizable Stremio catalogs for top trending TMDB content with optional graphic tags and ranked posters.",
    behaviorHints: { configurable: true, configurationRequired: true },
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs: [
        { id: "top_movies_today", type: "movie", name: "Top Movies Today" },
        { id: "top_shows_today", type: "series", name: "Top Shows Today" }
    ]
};

const builder = new addonBuilder(manifest);

// ─── Date helpers ────────────────────────────────────────────────────────────

const parseLocal = (dateStr) => {
    if (!dateStr) return null;
    if (dateStr.length === 10) return new Date(dateStr + "T00:00:00");
    return new Date(dateStr);
};

const diffDays = (date1, date2) => {
    const d1 = new Date(date1); d1.setHours(0, 0, 0, 0);
    const d2 = new Date(date2); d2.setHours(0, 0, 0, 0);
    return Math.round(Math.abs(d1 - d2) / (1000 * 60 * 60 * 24));
};

const formatFutureDate = (dateObj) => {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${monthNames[dateObj.getMonth()]} ${dateObj.getDate()}`;
};

const tagDisplayNameMap = {
    "just_added": "Just Added",
    "coming_soon": "Coming Soon",
    "now_streaming": "Now Streaming",
    "out_on_bluray": "Now on Blu-ray",
    "premiere": "Premiere",
    "new_series": "New Series",
    "season_finale": "Season Finale",
    "series_finale": "Series Finale",
    "final_season": "Final Season",
    "new_season": "New Season",
    "new_episode": "New Episode"
};

/**
 * Calculate the appropriate tag for a given movie ID.
 * Mirrors the logic from the catalog handler.
 */
async function getMovieTag(movieId) {
    const TODAY = new Date();
    try {
        const releaseData = await fetchTmdbJson(`https://api.themoviedb.org/3/movie/${movieId}/release_dates?api_key=${TMDB_API_KEY}`);

        let earliestDigital = null, earliestPhysical = null, earliestTheatrical = null;

        if (releaseData.results) {
            const usData = releaseData.results.find(c => c.iso_3166_1 === 'US');
            const globalDates = releaseData.results.flatMap(c => c.release_dates);

            const findEarliest = (releases, types) => {
                let earliest = null;
                for (const r of releases) {
                    if (types.includes(r.type)) {
                        const d = parseLocal(r.release_date.substring(0, 10));
                        if (!earliest || d < earliest) earliest = d;
                    }
                }
                return earliest;
            };

            const usReleases = usData ? usData.release_dates : [];
            earliestTheatrical = findEarliest(usReleases, [1, 2, 3]) || findEarliest(globalDates, [1, 2, 3]);
            earliestDigital = findEarliest(usReleases, [4]) || findEarliest(globalDates, [4]);
            earliestPhysical = findEarliest(usReleases, [5]) || findEarliest(globalDates, [5]);
        }

        const daysSincePhysical = (earliestPhysical && earliestPhysical <= TODAY) ? diffDays(TODAY, earliestPhysical) : null;
        const daysSinceDigital = (earliestDigital && earliestDigital <= TODAY) ? diffDays(TODAY, earliestDigital) : null;

        if (daysSincePhysical !== null && daysSincePhysical <= 14) {
            return "out_on_bluray";
        } else if (daysSinceDigital !== null && daysSinceDigital <= 14) {
            return (earliestTheatrical && earliestTheatrical < earliestDigital) ? "just_added" : "now_streaming";
        } else if (!earliestDigital || earliestDigital > TODAY) {
            if (earliestDigital) {
                const daysUntil = diffDays(earliestDigital, TODAY);
                if (daysUntil <= 14) {
                    return `coming_date_${formatFutureDate(earliestDigital).replace(' ', '_')}`;
                }
            }
            return "coming_soon";
        }
    } catch (error) {
        console.error(`Failed to get movie tag for ${movieId}:`, error);
    }
    return "none";
}

/**
 * Calculate the appropriate tag for a given series ID.
 * Mirrors the logic from the catalog handler.
 */
async function getSeriesTag(seriesId) {
    const TODAY = new Date();
    try {
        const tvData = await fetchTmdbJson(`https://api.themoviedb.org/3/tv/${seriesId}?api_key=${TMDB_API_KEY}`);

        let lastEp = tvData.last_episode_to_air;
        let nextEp = tvData.next_episode_to_air;

        if (nextEp && nextEp.air_date) {
            const nextAirDate = parseLocal(nextEp.air_date);
            if (nextAirDate <= TODAY) { lastEp = nextEp; nextEp = null; }
        }

        let isFinale = false;
        if (lastEp) {
            const currentSeason = tvData.seasons?.find(s => s.season_number === lastEp.season_number);
            const expectedCount = currentSeason?.episode_count || 0;
            isFinale = lastEp.episode_type === "finale" || (expectedCount > 0 && lastEp.episode_number >= expectedCount);
        }

        const firstAir = parseLocal(tvData.first_air_date);
        const lastAir = lastEp?.air_date ? parseLocal(lastEp.air_date) : null;

        let futureDate = null, isBrandNewSeries = false;

        if (firstAir && firstAir > TODAY) {
            futureDate = firstAir;
            isBrandNewSeries = true;
        } else if (nextEp && nextEp.episode_number === 1) {
            futureDate = parseLocal(nextEp.air_date);
        }

        if (futureDate) {
            const daysUntil = diffDays(futureDate, TODAY);
            if (daysUntil <= 14) {
                return `coming_date_${formatFutureDate(futureDate).replace(' ', '_')}`;
            } else if (isBrandNewSeries) {
                return "coming_soon";
            }
        }

        if (nextEp?.air_date) {
            const nextAirDate = parseLocal(nextEp.air_date);
            if (nextAirDate > TODAY && diffDays(nextAirDate, TODAY) <= 5) {
                const nextSeason = tvData.seasons?.find(s => s.season_number === nextEp.season_number);
                const expectedCount = nextSeason?.episode_count || 0;
                let isNextFinale = nextEp.episode_type === "finale" || (expectedCount > 0 && nextEp.episode_number >= expectedCount);
                if (isNextFinale) {
                    return `finale_date_${formatFutureDate(nextAirDate).replace(' ', '_')}`;
                }
            }
        }

        const latestSeason = tvData.seasons?.slice().reverse().find(s => s.season_number > 0);
        const seasonAir = latestSeason?.air_date ? parseLocal(latestSeason.air_date) : null;

        if (firstAir && firstAir <= TODAY && diffDays(TODAY, firstAir) <= 6) return "premiere";
        if (firstAir && firstAir <= TODAY && diffDays(TODAY, firstAir) <= 13) return "new_series";
        if (seasonAir && seasonAir <= TODAY && diffDays(TODAY, seasonAir) <= 13) return "new_season";
        if (isFinale && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 13) {
            return (tvData.status === "Ended" || tvData.status === "Canceled") ? "series_finale" : "season_finale";
        }
        if (lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 6) return "new_episode";
        if ((tvData.status === "Ended" || tvData.status === "Canceled") && tvData.number_of_seasons > 1 && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 30) {
            return "final_season";
        }

    } catch (error) {
        console.error(`Failed to get series tag for ${seriesId}:`, error);
    }
    return "none";
}

// ─── Shared image-generation helpers ─────────────────────────────────────────

/**
 * Resolve a tag string to its display text, or null if none.
 */
function parseTagText(tag) {
    if (!tag || tag === 'none') return null;
    if (tagDisplayNameMap[tag]) return tagDisplayNameMap[tag];
    if (tag.startsWith('coming_date_')) {
        const [month, day] = tag.replace('coming_date_', '').split('_');
        return `Coming ${month} ${day}`;
    }
    if (tag.startsWith('finale_date_')) {
        const [month, day] = tag.replace('finale_date_', '').split('_');
        return `Finale ${month} ${day}`;
    }
    return null;
}

/**
 * Determine the best provider/network logo to show.
 * Returns { path, isNetwork } or null.
 */
function resolveProviderLogoInfo(tmdbType, details) {
    const cleanString = (str) => str ? str.toLowerCase().replace(/\+/g, 'plus').replace(/\s+/g, '') : '';
    const customMappings = {
        "hbo": "max", "cbs": "paramount", "nbc": "peacock",
        "fx": "hulu", "abc": "hulu", "fox": "hulu",
        "amc": "amc", "showtime": "paramount", "the cw": "max", "bbc": "britbox"
    };
    const topTiers = ['netflix', 'max', 'disney', 'hulu', 'apple', 'paramount', 'peacock',
        'crunchyroll', 'mgm', 'starz', 'showtime', 'amc', 'amazon'];

    let usProviders = null;
    if (details['watch/providers']?.results) {
        const providers = details['watch/providers'].results;
        usProviders = providers.US;
    }

    // Pre-filter flatrate providers to exclude channel/store-within-a-store versions
    const validFlatrate = (usProviders?.flatrate || []).filter(p => {
        const pName = cleanString(p.provider_name);
        return !((pName.includes('amazon') && pName.includes('channel')) ||
            (pName.includes('roku') && pName.includes('premium')) ||
            (pName.includes('apple') && pName.includes('channel')));
    });

    // 1. Match TV network → streaming provider
    if (tmdbType === 'tv' && details.networks?.length > 0) {
        const networkName = details.networks[0].name;
        const targetProvider = customMappings[networkName.toLowerCase()] || cleanString(networkName);
        if (validFlatrate.length > 0) {
            const matched = validFlatrate.find(p => {
                const pName = cleanString(p.provider_name);
                return pName.includes(targetProvider) || targetProvider.includes(pName);
            });
            if (matched) return { path: matched.logo_path, isNetwork: false };
        }
    }

    // 2. Pick best flatrate streaming provider
    if (validFlatrate.length > 0) {
        let best = null, bestIdx = Infinity;
        for (const p of validFlatrate) {
            const idx = topTiers.findIndex(t => cleanString(p.provider_name).includes(t));
            if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = p; }
        }
        if (!best) {
            best = validFlatrate.find(p => !cleanString(p.provider_name).includes('amazon')) || validFlatrate[0];
        }
        return { path: best.logo_path, isNetwork: false };
    }

    // 3. Fallback: raw network logo
    if (tmdbType === 'tv' && details.networks?.length > 0) {
        return { path: details.networks[0].logo_path, isNetwork: true };
    }

    return null;
}

/**
 * Sample the average color of the bottom half of an image.
 * Uses raw pixel data — avoids a full PNG encode/decode cycle.
 * Returns { meanR, meanG, meanB, luminance }.
 */
async function sampleBottomHalf(imageBuffer, metadata) {
    try {
        const top = Math.floor(metadata.height / 2);
        const height = metadata.height - top;

        const { data, info } = await sharp(imageBuffer)
            .extract({ left: 0, top, width: metadata.width, height })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const channels = info.channels; // 3 (RGB) or 4 (RGBA)
        const pixelCount = info.width * info.height;
        let sumR = 0, sumG = 0, sumB = 0;

        for (let i = 0; i < data.length; i += channels) {
            sumR += data[i];
            sumG += data[i + 1];
            sumB += data[i + 2];
        }

        const meanR = Math.round(sumR / pixelCount);
        const meanG = Math.round(sumG / pixelCount);
        const meanB = Math.round(sumB / pixelCount);
        const luminance = (0.299 * meanR) + (0.587 * meanG) + (0.114 * meanB);
        return { meanR, meanG, meanB, luminance };
    } catch {
        return { meanR: 26, meanG: 26, meanB: 26, luminance: 26 };
    }
}

/**
 * Estimate rendered text width given a font size.
 */
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const char of text) {
        if ("iIl1., -".includes(char)) w += fontSize * 0.25;
        else if ("rftj".includes(char)) w += fontSize * 0.35;
        else if ("WMwm@".includes(char)) w += fontSize * 0.85;
        else if ("NQDOUCGRHKBAVXY".includes(char)) w += fontSize * 0.70;
        else if ("PESZT".includes(char)) w += fontSize * 0.60;
        else w += fontSize * 0.50;
    }
    return w;
}

/**
 * Build the frosted-glass tag composite operations for a given image.
 * The blur extraction and color sampling run in parallel.
 *
 * @param {Buffer} imageBuffer  - Source image buffer
 * @param {object} metadata     - sharp metadata for imageBuffer
 * @param {string} tagText      - Display string for the tag
 * @param {number} heightRatio  - Tag height as fraction of image height (0.08 poster / 0.15 backdrop)
 * @param {number} fontRatio    - Font size as fraction of tag height (0.60 poster / 0.75 backdrop)
 * @returns {Promise<Array>}    - Array of sharp composite operation objects
 */
async function buildTagComposites(imageBuffer, metadata, tagText, heightRatio, fontRatio) {
    const { width, height } = metadata;
    const tagHeight = Math.round(height * heightRatio);
    const fontSize = Math.round(tagHeight * fontRatio);
    const tagWidth = Math.round(estimateTextWidth(tagText, fontSize) + fontSize * 1.8);
    const startX = Math.round((width / 2) - (tagWidth / 2));
    const startY = height - tagHeight;
    const r = Math.round(tagHeight * 0.25);

    const extractLeft = Math.max(0, startX);
    const extractTop = Math.max(0, startY);
    const extractWidth = Math.min(tagWidth, width - extractLeft);
    const extractHeight = Math.min(tagHeight, height - extractTop);

    // ── Run color sampling and region blur in parallel ───────────────────────
    const [colorInfo, blurBuffer] = await Promise.all([
        sampleBottomHalf(imageBuffer, metadata),
        sharp(imageBuffer)
            .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
            .blur(15)
            .png()
            .toBuffer()
            .catch(() => null)
    ]);

    const { meanR, meanG, meanB, luminance } = colorInfo;

    const textColor = luminance > 140 ? "#121212" : "#ffffff";

    // Blend the sampled color with white if text is black, otherwise grey
    const greyMixFactor = 0.25;
    const blendTarget = textColor === "#121212" ? 255 : 128;
    const adjR = Math.round(meanR + (blendTarget - meanR) * greyMixFactor);
    const adjG = Math.round(meanG + (blendTarget - meanG) * greyMixFactor);
    const adjB = Math.round(meanB + (blendTarget - meanB) * greyMixFactor);

    const tagFillColor = `rgb(${adjR}, ${adjG}, ${adjB})`;
    let tagFillOpacity = "0.45";

    const composites = [];
    const fontStack = "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

    // ── Frosted blur region ──────────────────────────────────────────────────
    if (blurBuffer) {
        const localPath = `M 0,${extractHeight} L ${extractWidth},${extractHeight} L ${extractWidth},${r} Q ${extractWidth},0 ${extractWidth - r},0 L ${r},0 Q 0,0 0,${r} Z`;
        const maskSvg = `<svg width="${extractWidth}" height="${extractHeight}"><path d="${localPath}" fill="white"/></svg>`;

        const shapedBlur = await sharp(blurBuffer)
            .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
            .png()
            .toBuffer();
        composites.push({ input: shapedBlur, top: extractTop, left: extractLeft });
    } else {
        tagFillOpacity = "0.85";
    }

    // ── Pill + text overlay ──────────────────────────────────────────────────
    const pillPath = `M ${startX},${height} L ${startX + tagWidth},${height} L ${startX + tagWidth},${startY + r} Q ${startX + tagWidth},${startY} ${startX + tagWidth - r},${startY} L ${startX + r},${startY} Q ${startX},${startY} ${startX},${startY + r} Z`;
    const tagSvg = `<svg width="${width}" height="${height}">
        <path d="${pillPath}" fill="${tagFillColor}" fill-opacity="${tagFillOpacity}"/>
        <text x="${width / 2}" y="${startY + (tagHeight / 2) + (fontSize * 0.35)}" text-anchor="middle"
              font-family="${fontStack}" font-size="${fontSize}" fill="${textColor}" font-weight="bold">${tagText}</text>
    </svg>`;
    composites.push({ input: Buffer.from(tagSvg), top: 0, left: 0 });

    return composites;
}

/**
 * Fetch, resize, and optionally round-corner a provider logo.
 * Returns a composite operation object, or null on failure.
 *
 * @param {string}  logoPath   - TMDB logo_path
 * @param {boolean} isNetwork  - Skip rounding for raw network logos
 * @param {number}  logoWidth  - Target pixel width
 * @param {number}  topOffset  - Composite top position
 * @param {number}  rightEdge  - Full image width (used to compute left position)
 * @param {number}  rightPad   - Padding from right edge
 */
async function buildLogoComposite(logoPath, isNetwork, logoWidth, topOffset, rightEdge, rightPad) {
    try {
        const res = await fetch(`https://image.tmdb.org/t/p/w154${logoPath}`);
        if (!res.ok) return null;

        const buf = Buffer.from(await res.arrayBuffer());
        let resized = await sharp(buf)
            .resize({ width: logoWidth, withoutEnlargement: true })
            .png()
            .toBuffer();

        const meta = await sharp(resized).metadata();

        if (!isNetwork) {
            const maskRadius = Math.round(logoWidth * 0.2);
            const mask = Buffer.from(`<svg width="${meta.width}" height="${meta.height}">
                <rect x="0" y="0" width="${meta.width}" height="${meta.height}"
                      rx="${maskRadius}" ry="${maskRadius}" fill="white"/>
            </svg>`);
            resized = await sharp(resized)
                .composite([{ input: mask, blend: 'dest-in' }])
                .png()
                .toBuffer();
        }

        return {
            input: resized,
            top: topOffset,
            left: Math.round(rightEdge - meta.width - rightPad)
        };
    } catch (e) {
        console.error("Provider logo error:", e);
        return null;
    }
}

/**
 * Shared cache middleware + probabilistic cache cleanup.
 * Returns true if the request was served from cache (caller should return early).
 */
async function serveCached(cacheKey, res) {
    const cached = imageCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=86400");
        res.send(cached.buffer);
        return true;
    }

    const filePath = cacheFilePath(cacheKey);
    try {
        const stats = await fs.promises.stat(filePath);
        if (Date.now() < stats.mtimeMs + CACHE_TTL_MS) {
            const buffer = await fs.promises.readFile(filePath);
            imageCache.set(cacheKey, { buffer, expires: Date.now() + CACHE_TTL_MS });
            res.set("Content-Type", "image/png");
            res.set("Cache-Control", "public, max-age=86400");
            res.send(buffer);
            return true;
        }
    } catch (err) {
        // ignore missing cache file
    }

    if (Math.random() < 0.05) {
        for (const [k, v] of imageCache.entries()) {
            if (Date.now() > v.expires) imageCache.delete(k);
        }
    }
    return false;
}

function cacheAndSend(cacheKey, buffer, res) {
    imageCache.set(cacheKey, { buffer, expires: Date.now() + CACHE_TTL_MS });
    fs.promises.writeFile(cacheFilePath(cacheKey), buffer).catch(() => { });
    if (imageCache.size > 500) {
        const oldestKey = imageCache.keys().next().value;
        imageCache.delete(oldestKey);
    }
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
}

// ─── Catalog handler (unchanged logic) ───────────────────────────────────────

builder.defineCatalogHandler(async (args) => {
    const { type, id, extra } = args;
    const config = extra?.config || {};

    const userConfig = {
        landscapeTags: config.landscapeTags !== undefined ? config.landscapeTags !== "false" : config.tags !== "false",
        landscapeLogos: config.landscapeLogos !== undefined ? config.landscapeLogos === "true" : config.logos === "true",
        landscapeRanked: config.landscapeRanked === "true",
        landscapePosterLang: config.landscapePosterLang || config.posterLang || "en",
        portraitTags: config.portraitTags !== undefined ? config.portraitTags !== "false" : config.tags !== "false",
        portraitLogos: config.portraitLogos !== undefined ? config.portraitLogos === "true" : config.logos === "true",
        portraitRanked: config.portraitRanked !== undefined ? config.portraitRanked !== "false" : config.ranked !== "false",
        portraitPosterLang: config.portraitPosterLang || config.posterLang || "en",
        digitalOnly: config.digitalOnly !== "false",
        listLang: config.listLang || "en"
    };

    const tmdbType = type === 'series' ? 'tv' : 'movie';
    let finalItems = [];
    let seenIds = new Set();
    let page = 1;
    const maxPages = 10;
    const TODAY = new Date();

    while (finalItems.length < 10 && page <= maxPages) {
        const data = await fetchTmdbJson(`https://api.themoviedb.org/3/trending/${tmdbType}/day?api_key=${TMDB_API_KEY}&page=${page}`);
        if (!data.results || data.results.length === 0) break;

        let pageItems = data.results.filter(item => {
            if (seenIds.has(item.id)) return false;

            const langs = userConfig.listLang.split(',');
            let keep = false;
            if (langs.includes('all')) keep = true;
            else if (langs.includes('non-en') && item.original_language !== 'en') keep = true;
            else if (langs.includes(item.original_language)) keep = true;

            if (!keep) return false;

            seenIds.add(item.id);
            return true;
        });

        if (pageItems.length > 0) {
            const detailsData = await Promise.all(pageItems.map(async (item) => {
                try {
                    return await fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${item.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);
                } catch { return null; }
            }));
            pageItems.forEach((item, index) => item._details = detailsData[index]);
        }

        if (type === 'movie' && pageItems.length > 0) {
            const releaseDatesData = await Promise.all(pageItems.map(async (movie) => {
                try {
                    const releaseData = await fetchTmdbJson(`https://api.themoviedb.org/3/movie/${movie.id}/release_dates?api_key=${TMDB_API_KEY}`);

                    let earliestTheatrical = null;
                    let earliestDigital = null;
                    let earliestPhysical = null;

                    if (releaseData.results) {
                        const usData = releaseData.results.find(c => c.iso_3166_1 === 'US');
                        const globalDates = releaseData.results.flatMap(c => c.release_dates);

                        const findEarliest = (releases, types) => {
                            let earliest = null;
                            for (const r of releases) {
                                if (types.includes(r.type)) {
                                    const d = parseLocal(r.release_date.substring(0, 10));
                                    if (!earliest || d < earliest) earliest = d;
                                }
                            }
                            return earliest;
                        };

                        const usReleases = usData ? usData.release_dates : [];
                        earliestTheatrical = findEarliest(usReleases, [1, 2, 3]) || findEarliest(globalDates, [1, 2, 3]);
                        earliestDigital = findEarliest(usReleases, [4]) || findEarliest(globalDates, [4]);
                        earliestPhysical = findEarliest(usReleases, [5]) || findEarliest(globalDates, [5]);
                    }
                    return { earliestTheatrical, earliestDigital, earliestPhysical };
                } catch { return { earliestTheatrical: null, earliestDigital: null, earliestPhysical: null }; }
            }));

            pageItems.forEach((item, index) => {
                const dates = releaseDatesData[index] || {};
                item._earliestTheatrical = dates.earliestTheatrical;
                item._earliestDigital = dates.earliestDigital;
                item._earliestPhysical = dates.earliestPhysical;
            });

            if (userConfig.digitalOnly) {
                pageItems = pageItems.filter(item => {
                    // Prevent TMDB metadata errors: if a future digital release exists,
                    // it is not truly out yet, regardless of erroneous past physical dates.
                    if (item._earliestDigital && item._earliestDigital > TODAY) return false;

                    const hasDigital = item._earliestDigital && item._earliestDigital <= TODAY;
                    const hasPhysical = item._earliestPhysical && item._earliestPhysical <= TODAY;
                    return hasDigital || hasPhysical;
                });
            }

            pageItems.forEach(item => {
                const needsTags = userConfig.landscapeTags || userConfig.portraitTags;
                if (needsTags) {
                    const daysSincePhysical = (item._earliestPhysical && item._earliestPhysical <= TODAY) ? diffDays(TODAY, item._earliestPhysical) : null;
                    const daysSinceDigital = (item._earliestDigital && item._earliestDigital <= TODAY) ? diffDays(TODAY, item._earliestDigital) : null;

                    if (daysSincePhysical !== null && daysSincePhysical <= 14) {
                        item._tag = "out_on_bluray";
                    } else if (daysSinceDigital !== null && daysSinceDigital <= 14) {
                        item._tag = (item._earliestTheatrical && item._earliestTheatrical < item._earliestDigital)
                            ? "just_added" : "now_streaming";
                    } else if (!item._earliestDigital || item._earliestDigital > TODAY) {
                        if (item._earliestDigital) {
                            const daysUntil = diffDays(item._earliestDigital, TODAY);
                            if (daysUntil <= 14) {
                                const formattedDate = formatFutureDate(item._earliestDigital);
                                item._tag = `coming_date_${formattedDate.replace(' ', '_')}`;
                            } else {
                                item._tag = "coming_soon";
                            }
                        } else {
                            item._tag = "coming_soon";
                        }
                    } else {
                        item._tag = "none";
                    }
                } else {
                    item._tag = "none";
                }
            });

        } else if (type === 'series' && pageItems.length > 0) {
            const needsTags = userConfig.landscapeTags || userConfig.portraitTags;
            if (needsTags) {
                const tvDetailsData = await Promise.all(pageItems.map(async (show) => {
                    try {
                        const data = await fetchTmdbJson(`https://api.themoviedb.org/3/tv/${show.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);

                        let nextEp = data.next_episode_to_air;
                        if (nextEp && nextEp.air_date) {
                            const nextAirDate = parseLocal(nextEp.air_date);
                            if (nextAirDate <= TODAY) {
                                const currentSeason = data.seasons?.find(s => s.season_number === nextEp.season_number);
                                const expectedCount = currentSeason?.episode_count || 0;
                                if (expectedCount > 0 && nextEp.episode_number < expectedCount) {
                                    try {
                                        const seasonData = await fetchTmdbJson(`https://api.themoviedb.org/3/tv/${show.id}/season/${nextEp.season_number}?api_key=${TMDB_API_KEY}`);
                                        if (seasonData.episodes) {
                                            const validEps = seasonData.episodes.filter(ep => ep.air_date && parseLocal(ep.air_date) <= TODAY);
                                            if (validEps.length > 0) {
                                                const latest = validEps[validEps.length - 1];
                                                if (latest.episode_number > nextEp.episode_number) {
                                                    data.next_episode_to_air = latest;
                                                }
                                            }
                                        }
                                    } catch { /* ignore */ }
                                }
                            }
                        }
                        return data;
                    } catch { return null; }
                }));

                pageItems.forEach((item, index) => {
                    const tvData = tvDetailsData[index];
                    if (!tvData) return;
                    item._details = tvData; // Ensure details are attached for later use

                    let lastEp = tvData.last_episode_to_air;
                    let nextEp = tvData.next_episode_to_air;

                    if (nextEp && nextEp.air_date) {
                        const nextAirDate = parseLocal(nextEp.air_date);
                        if (nextAirDate <= TODAY) { lastEp = nextEp; nextEp = null; }
                    }

                    let isFinale = false;
                    if (lastEp) {
                        const currentSeason = tvData.seasons?.find(s => s.season_number === lastEp.season_number);
                        const expectedCount = currentSeason?.episode_count || 0;
                        if (lastEp.episode_type) {
                            isFinale = lastEp.episode_type === "finale";
                        } else if (expectedCount > 0 && lastEp.episode_number >= expectedCount) {
                            isFinale = true;
                        } else if (!nextEp && lastEp.episode_number > 1) {
                            if (expectedCount === 0 || lastEp.episode_number >= expectedCount) isFinale = true;
                        }
                    }

                    const firstAir = parseLocal(tvData.first_air_date);
                    const lastAir = lastEp?.air_date ? parseLocal(lastEp.air_date) : parseLocal(tvData.last_air_date);

                    let itemTag = null, futureDate = null, isBrandNewSeries = false;

                    if (firstAir && firstAir > TODAY) {
                        futureDate = firstAir;
                        isBrandNewSeries = true;
                    } else if (nextEp && nextEp.episode_number === 1) {
                        futureDate = parseLocal(nextEp.air_date);
                    }

                    if (futureDate) {
                        const daysUntil = diffDays(futureDate, TODAY);
                        if (daysUntil <= 14) {
                            itemTag = `coming_date_${formatFutureDate(futureDate).replace(' ', '_')}`;
                        } else if (isBrandNewSeries) {
                            itemTag = "coming_soon";
                        }
                    }

                    if (!itemTag && nextEp?.air_date) {
                        const nextAirDate = parseLocal(nextEp.air_date);
                        if (nextAirDate > TODAY && diffDays(nextAirDate, TODAY) <= 5) {
                            const nextSeason = tvData.seasons?.find(s => s.season_number === nextEp.season_number);
                            const expectedCount = nextSeason?.episode_count || 0;
                            let isNextFinale = nextEp.episode_type
                                ? nextEp.episode_type === "finale"
                                : (expectedCount > 0 && nextEp.episode_number >= expectedCount);
                            if (isNextFinale) {
                                itemTag = `finale_date_${formatFutureDate(nextAirDate).replace(' ', '_')}`;
                            }
                        }
                    }

                    if (!itemTag) {
                        const latestSeason = tvData.seasons?.slice().reverse().find(s => s.season_number > 0);
                        const seasonAir = latestSeason?.air_date ? parseLocal(latestSeason.air_date) : null;

                        if (firstAir && firstAir <= TODAY && diffDays(TODAY, firstAir) <= 6) {
                            itemTag = "premiere";
                        } else if (firstAir && firstAir <= TODAY && diffDays(TODAY, firstAir) <= 13) {
                            itemTag = "new_series";
                        } else if (seasonAir && seasonAir <= TODAY && diffDays(TODAY, seasonAir) <= 13) {
                            itemTag = "new_season";
                        } else if (isFinale && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 13) {
                            if (tvData.status === "Ended" || tvData.status === "Canceled") {
                                itemTag = "series_finale";
                            } else {
                                itemTag = "season_finale";
                            }
                        } else if (lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 6) {
                            itemTag = "new_episode";
                        } else if ((tvData.status === "Ended" || tvData.status === "Canceled") &&
                            tvData.number_of_seasons > 1 && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 30) {
                            itemTag = "final_season";
                        }
                    }

                    item._tag = itemTag || "none";
                });
            } else {
                pageItems.forEach(item => item._tag = "none");
            }
        }

        finalItems.push(...pageItems);
        page++;
    }

    const metas = finalItems.slice(0, 10).map((item, index) => {
        const rank = index + 1;
        let finalPosterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
        const imdbId = item._details?.imdb_id || item._details?.external_ids?.imdb_id;

        const pTag = userConfig.portraitTags ? (item._tag || 'none') : 'none';
        if (userConfig.portraitRanked || userConfig.portraitTags || userConfig.portraitLogos || userConfig.portraitPosterLang !== 'en') {
            finalPosterUrl = `${ADDON_URL}/poster/${item.id}.png?type=${type}&tag=${pTag}&rank=${userConfig.portraitRanked ? rank : 'none'}&lang=${userConfig.portraitPosterLang}&logos=${userConfig.portraitLogos ? '1' : '0'}`;
        }

        let itemGenres = item.genre_ids ? item.genre_ids.map(gId => genreMap[gId]).filter(Boolean) : [];
        if (userConfig.listLang === 'non-en' && item.original_language) {
            try {
                const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(item.original_language);
                if (langName && !itemGenres.includes(langName)) itemGenres.unshift(langName);
            } catch {
                itemGenres.unshift(item.original_language.toUpperCase());
            }
        }

        const lTag = userConfig.landscapeTags ? (item._tag || 'none') : 'none';

        return {
            id: imdbId || `tmdb:${item.id}`,
            _tmdbId: item.id,
            name: item.title || item.name,
            type: type,
            genres: itemGenres,
            description: item.overview || "",
            background: `${ADDON_URL}/backdrop/${item.id}.png?type=${type}&tag=${lTag}&rank=${userConfig.landscapeRanked ? rank : 'none'}&lang=${userConfig.landscapePosterLang}&logos=${userConfig.landscapeLogos ? '1' : '0'}`,
            poster: finalPosterUrl
        };
    });

    return { metas };
});

// ─── Backdrop route ───────────────────────────────────────────────────────────

app.get('/proxy-image-backdrop/:type/:id/:tag/:rank/:lang/:logos.png', async (req, res) => {
    const { type, id, tag, rank, lang, logos } = req.params;
    const query = new URLSearchParams({ type, tag, rank: rank || 'none', lang, logos: logos || '0' });
    return res.redirect(301, `/backdrop/${id}.png?${query.toString()}`);
});

app.get('/backdrop/:id.png', async (req, res) => {
    if (await serveCached(req.originalUrl, res)) return;

    try {
        const { id } = req.params;
        const { type, tag, rank, lang, logos } = req.query;
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const showLogos = logos === '1';
        const tagText = parseTagText(tag);
        const drawTag = !!tagText;
        const drawRank = rank && rank !== 'none';

        // ── 1. Fetch TMDB metadata ────────────────────────────────────────
        const details = await fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}?api_key=${TMDB_API_KEY}`);
        const originalLang = details.original_language;

        const fallbackLangs = ['en', 'null', 'ja', 'ko', 'es', 'fr', 'de', 'hi', 'it', 'pt', 'ru', 'zh', 'th', 'tr', 'pl', 'nl', 'sv', 'ar'];
        const tmdbLangsSet = [...new Set([lang, originalLang, ...fallbackLangs])].filter(Boolean);
        const allowedLangs = tmdbLangsSet.map(l => l === 'null' ? null : l);
        const tmdbLangs = tmdbLangsSet.join(',');

        const [images, providers] = await Promise.all([
            fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}/images?api_key=${TMDB_API_KEY}&include_image_language=${tmdbLangs}`),
            showLogos ? fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}/watch/providers?api_key=${TMDB_API_KEY}`) : Promise.resolve(null)
        ]);

        if (providers) details['watch/providers'] = providers;

        if (images.backdrops) {
            images.backdrops = images.backdrops.filter(b => allowedLangs.includes(b.iso_639_1));
        }

        const backdropLangToUse = lang === 'null' ? null : lang;
        const backdrop = images.backdrops?.find(b => b.iso_639_1 === backdropLangToUse)
            || (originalLang && images.backdrops?.find(b => b.iso_639_1 === originalLang))
            || images.backdrops?.find(b => b.iso_639_1 === null)
            || images.backdrops?.[0];

        if (!backdrop?.file_path) {
            return res.redirect(301, 'https://via.placeholder.com/1280x720.png?text=No+Background+Available');
        }

        let titleLogo = null;
        if (lang !== 'null' && backdrop.iso_639_1 === null && images.logos && images.logos.length > 0) {
            titleLogo = images.logos.find(l => l.iso_639_1 === lang)
                || (originalLang && images.logos.find(l => l.iso_639_1 === originalLang))
                || images.logos.find(l => l.iso_639_1 === 'en')
                || images.logos[0];
        }

        // Resolve logo info (sync, no fetch yet)
        const logoInfo = showLogos ? resolveProviderLogoInfo(tmdbType, details) : null;

        // Fast path: nothing to draw → just redirect
        if (!drawTag && !drawRank && !logoInfo && !titleLogo) {
            return res.redirect(301, `https://image.tmdb.org/t/p/original${backdrop.file_path}`);
        }

        // ── 2. Fetch backdrop image + provider logo in parallel ───────────
        const [backdropBuffer, logoCompositeResult] = await Promise.all([
            fetch(`https://image.tmdb.org/t/p/w1280${backdrop.file_path}`)
                .then(r => r.arrayBuffer())
                .then(ab => Buffer.from(ab)),
            logoInfo
                ? (async () => { /* placeholder — computed after we know image dimensions */ return logoInfo; })()
                : Promise.resolve(null)
        ]);

        const backdropImage = sharp(backdropBuffer);
        const metadata = await backdropImage.metadata();
        const { width } = metadata;

        // ── 3. Build rank SVG (sync, zero I/O) ───────────────────────────
        let rankComposite = null;
        if (drawRank) {
            const fontSize = Math.round(metadata.height * 0.20);
            const paddingTop = Math.round(metadata.height * 0.05);
            const paddingLeft = Math.round(width * 0.05);
            const fontStack = "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

            const rankSvg = `<svg width="${width}" height="${metadata.height}">
                <defs>
                    <linearGradient id="rankGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%"   style="stop-color:#ffffff;stop-opacity:1"/>
                        <stop offset="60%"  style="stop-color:#c0c0c0;stop-opacity:1"/>
                        <stop offset="100%" style="stop-color:#808080;stop-opacity:1"/>
                    </linearGradient>
                    <filter id="rankShadow" x="-10%" y="-10%" width="120%" height="120%">
                        <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
                        <feOffset dx="3" dy="3" result="offsetblur"/>
                        <feFlood flood-color="black" flood-opacity="0.9"/>
                        <feComposite in2="offsetblur" operator="in"/>
                        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
                    </filter>
                    <radialGradient id="shimmerGradient" cx="0%" cy="0%" r="100%" fx="0%" fy="0%">
                        <stop offset="0%"   style="stop-color:black;stop-opacity:0.6"/>
                        <stop offset="40%"  style="stop-color:black;stop-opacity:0.3"/>
                        <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
                    </radialGradient>
                </defs>
                <rect x="0" y="0" width="${width * 0.4}" height="${fontSize * 1.5}" fill="url(#shimmerGradient)"/>
                <text x="${paddingLeft}" y="${paddingTop + fontSize / 1.1}" text-anchor="start"
                      font-family="${fontStack}" font-size="${fontSize}"
                      fill="url(#rankGradient)" fill-opacity="0.80" font-weight="bold"
                      filter="url(#rankShadow)">${rank}</text>
            </svg>`;

            rankComposite = { input: Buffer.from(rankSvg), top: 0, left: 0 };
        }

        // ── 4. Tag composites + logo fetch run in parallel ────────────────
        const [tagComposites, logoComposite, titleLogoComposite] = await Promise.all([
            drawTag
                ? buildTagComposites(backdropBuffer, metadata, tagText, 0.15, 0.75)
                : Promise.resolve([]),
            logoInfo
                ? buildLogoComposite(
                    logoInfo.path,
                    logoInfo.isNetwork,
                    Math.round(width * 0.10),
                    Math.round(metadata.height * 0.04),
                    width,
                    Math.round(metadata.height * 0.04)
                )
                : Promise.resolve(null),
            titleLogo
                ? (async () => {
                    try {
                        const res = await fetch(`https://image.tmdb.org/t/p/original${titleLogo.file_path}`);
                        if (!res.ok) return null;
                        const buf = Buffer.from(await res.arrayBuffer());
                        const targetWidth = Math.round(width * 0.50);
                        const maxHeight = Math.round(metadata.height * 0.50);
                        let resized = await sharp(buf)
                            .resize({ width: targetWidth, height: maxHeight, fit: 'inside' })
                            .png()
                            .toBuffer();
                        const meta = await sharp(resized).metadata();
                        const paddingLeft = Math.round(width * 0.05);
                        const paddingBottom = Math.round(metadata.height * 0.20);

                        const targetLeft = paddingLeft;
                        const targetTop = metadata.height - meta.height - paddingBottom;

                        // Sharp throws an error if the composite overlay is larger than the base image
                        const extractLeft = Math.max(0, -targetLeft);
                        const extractTop = Math.max(0, -targetTop);
                        const extractRight = Math.min(meta.width, width - targetLeft);
                        const extractBottom = Math.min(meta.height, metadata.height - targetTop);

                        const extractWidth = extractRight - extractLeft;
                        const extractHeight = extractBottom - extractTop;

                        if (extractWidth <= 0 || extractHeight <= 0) return null;

                        if (extractWidth < meta.width || extractHeight < meta.height) {
                            resized = await sharp(resized)
                                .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
                                .toBuffer();
                        }

                        return {
                            input: resized,
                            left: targetLeft + extractLeft,
                            top: targetTop + extractTop
                        };
                    } catch (e) {
                        console.error("Title logo error:", e);
                        return null;
                    }
                })()
                : Promise.resolve(null)
        ]);

        const compositeOperations = [
            ...(rankComposite ? [rankComposite] : []),
            ...tagComposites,
            ...(titleLogoComposite ? [titleLogoComposite] : []),
            ...(logoComposite ? [logoComposite] : [])
        ];

        const finalImageBuffer = await backdropImage
            .composite(compositeOperations)
            .png()
            .toBuffer();

        cacheAndSend(req.originalUrl, finalImageBuffer, res);
    } catch (error) {
        console.error("Backdrop generation error:", error);
        res.status(500).send("Error generating image");
    }
});

// ─── Universal image route ────────────────────────────────────────────────────

app.get('/image/:type/:id.png', async (req, res) => {
    const { type, id } = req.params;
    const { tag, lang, logos } = req.query;

    let finalTag = tag;

    // If no tag is provided, calculate it.
    if (!finalTag || finalTag === 'auto') {
        if (type === 'movie') {
            finalTag = await getMovieTag(id);
        } else if (type === 'series') {
            finalTag = await getSeriesTag(id);
        } else {
            finalTag = 'none';
        }
    }

    const query = new URLSearchParams({ type, tag: finalTag, rank: 'none', lang: lang || 'en', logos: logos || '0' });
    const newUrl = `/poster/${id}.png?${query.toString()}`;
    return res.redirect(302, newUrl); // Use 302 Found, as the tag can change
});

// ─── Poster route ─────────────────────────────────────────────────────────────

app.get('/proxy-image-poster/:type/:id/:tag/:rank/:lang/:logos.png', async (req, res) => {
    const { type, id, tag, rank, lang, logos } = req.params;
    const query = new URLSearchParams({ type, tag, rank: rank || 'none', lang, logos: logos || '0' });
    return res.redirect(301, `/poster/${id}.png?${query.toString()}`);
});

app.get('/poster/:id.png', async (req, res) => {
    if (await serveCached(req.originalUrl, res)) return;

    try {
        const { id } = req.params;
        const { type, tag, rank, lang, logos } = req.query;
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const showLogos = logos === '1';
        const tagText = parseTagText(tag);
        const drawTag = !!tagText;
        const drawRank = rank && rank !== 'none';

        // ── 1. Fetch TMDB metadata ────────────────────────────────────────
        const details = await fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}?api_key=${TMDB_API_KEY}`);
        const originalLang = details.original_language;

        const fallbackLangs = ['en', 'null', 'ja', 'ko', 'es', 'fr', 'de', 'hi', 'it', 'pt', 'ru', 'zh', 'th', 'tr', 'pl', 'nl', 'sv', 'ar'];
        const tmdbLangsSet = [...new Set([lang, originalLang, ...fallbackLangs])].filter(Boolean);
        const allowedLangs = tmdbLangsSet.map(l => l === 'null' ? null : l);
        const tmdbLangs = tmdbLangsSet.join(',');

        const [images, providers] = await Promise.all([
            fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}/images?api_key=${TMDB_API_KEY}&include_image_language=${tmdbLangs}`),
            showLogos ? fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}/watch/providers?api_key=${TMDB_API_KEY}`) : Promise.resolve(null)
        ]);

        if (providers) details['watch/providers'] = providers;

        if (images.posters) {
            images.posters = images.posters.filter(p => allowedLangs.includes(p.iso_639_1));
        }

        const posterLangToUse = lang === 'null' ? null : lang;
        const poster = images.posters?.find(p => p.iso_639_1 === posterLangToUse)
            || (originalLang && images.posters?.find(p => p.iso_639_1 === originalLang))
            || images.posters?.find(p => p.iso_639_1 === null)
            || images.posters?.find(p => p.iso_639_1 === 'en')
            || images.posters?.[0];

        if (!poster?.file_path) {
            return res.redirect(301, 'https://via.placeholder.com/500x750.png?text=Poster+Unavailable');
        }

        // Resolve logo info (sync, no fetch yet)
        const logoInfo = showLogos ? resolveProviderLogoInfo(tmdbType, details) : null;

        // Fast path: nothing to draw → just redirect
        if (!drawTag && !drawRank && !logoInfo) {
            return res.redirect(301, `https://image.tmdb.org/t/p/w500${poster.file_path}`);
        }

        // ── 2. Fetch poster image (logo fetch is deferred until we have width) ──
        const posterBuffer = await fetch(`https://image.tmdb.org/t/p/w500${poster.file_path}`)
            .then(r => r.arrayBuffer())
            .then(ab => Buffer.from(ab));

        const posterImage = sharp(posterBuffer);
        const metadata = await posterImage.metadata();
        const { width } = metadata;

        // ── 3. Build rank SVG (sync, zero I/O) ───────────────────────────
        let rankComposite = null;
        if (drawRank) {
            const fontSize = Math.round(width * 0.30);
            const paddingTop = Math.round(width * 0.08);
            const paddingLeft = Math.round(width * 0.08);
            const fontStack = "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

            const rankSvg = `<svg width="${width}" height="${metadata.height}">
                <defs>
                    <linearGradient id="rankGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%"   style="stop-color:#ffffff;stop-opacity:1"/>
                        <stop offset="60%"  style="stop-color:#c0c0c0;stop-opacity:1"/>
                        <stop offset="100%" style="stop-color:#808080;stop-opacity:1"/>
                    </linearGradient>
                    <filter id="rankShadow" x="-10%" y="-10%" width="120%" height="120%">
                        <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
                        <feOffset dx="3" dy="3" result="offsetblur"/>
                        <feFlood flood-color="black" flood-opacity="0.9"/>
                        <feComposite in2="offsetblur" operator="in"/>
                        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
                    </filter>
                    <radialGradient id="shimmerGradient" cx="0%" cy="0%" r="100%" fx="0%" fy="0%">
                        <stop offset="0%"   style="stop-color:black;stop-opacity:0.6"/>
                        <stop offset="40%"  style="stop-color:black;stop-opacity:0.3"/>
                        <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
                    </radialGradient>
                </defs>
                <rect x="0" y="0" width="${width * 0.6}" height="${fontSize * 2}" fill="url(#shimmerGradient)"/>
                <text x="${paddingLeft}" y="${paddingTop + fontSize / 1.3}" text-anchor="start"
                      font-family="${fontStack}" font-size="${fontSize}"
                      fill="url(#rankGradient)" fill-opacity="0.80" font-weight="bold"
                      filter="url(#rankShadow)">${rank}</text>
            </svg>`;

            rankComposite = { input: Buffer.from(rankSvg), top: 0, left: 0 };
        }

        // ── 4. Tag composites + logo fetch run in parallel ────────────────
        const [tagComposites, logoComposite] = await Promise.all([
            drawTag
                ? buildTagComposites(posterBuffer, metadata, tagText, 0.08, 0.60)
                : Promise.resolve([]),
            logoInfo
                ? buildLogoComposite(
                    logoInfo.path,
                    logoInfo.isNetwork,
                    Math.round(width * 0.15),
                    Math.round(width * 0.04),
                    width,
                    Math.round(width * 0.04)
                )
                : Promise.resolve(null)
        ]);

        const compositeOperations = [
            ...(rankComposite ? [rankComposite] : []),
            ...tagComposites,
            ...(logoComposite ? [logoComposite] : [])
        ];

        const finalImageBuffer = await posterImage
            .composite(compositeOperations)
            .png()
            .toBuffer();

        cacheAndSend(req.originalUrl, finalImageBuffer, res);
    } catch (error) {
        console.error("Poster generation error:", error);
        res.status(500).send("Error generating image");
    }
});


// ─── Config UI ────────────────────────────────────────────────────────────────

const configUI = `<!DOCTYPE html>
<html>
<head>
    <title>TMDB Top Today</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><circle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%238b0000%22/><path d=%22M25 70 l15 -25 l15 15 l20 -30%22 fill=%22none%22 stroke=%22white%22 stroke-width=%228%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/><path d=%22M55 30 h20 v20%22 fill=%22none%22 stroke=%22white%22 stroke-width=%228%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>">
    <style>
        body { font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #121212; color: #fff; margin: 0; padding: 20px; box-sizing: border-box; height: 100vh; overflow: hidden; }
        .wrapper { display: flex; flex-direction: row; gap: 30px; width: 100%; height: 100%; max-width: none; align-items: stretch; }
        .container { background-color: #1e1e1e; padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.5); flex: 0 0 420px; min-width: 420px; box-sizing: border-box; display: flex; flex-direction: column; height: 100%; max-height: 100%; overflow-y: auto; }
        .preview-container { background-color: #1e1e1e; padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.5); flex: 1; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; height: 100%; max-height: 100%; overflow-y: auto; }
        h2 { margin-top: 0; text-align: center; color: #e0e0e0; margin-bottom: 25px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; font-size: 14px; color: #b3b3b3; }
        select { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: #fff; font-size: 14px; outline: none; box-sizing: border-box; }
        select:focus { border-color: #8b0000; }
        .checkbox-group { display: flex; align-items: center; background: #2a2a2a; padding: 12px; border-radius: 6px; border: 1px solid #333; cursor: pointer; margin-bottom: 10px; }
        .checkbox-group input { margin-right: 12px; width: 18px; height: 18px; cursor: pointer; accent-color: #8b0000; }
        .checkbox-group span { margin-bottom: 0; cursor: pointer; color: #fff; font-size: 15px; }
        .link-container { display: flex; gap: 10px; margin-top: 5px; }
        .link-container input { flex-grow: 1; padding: 12px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: #aaa; font-size: 13px; outline: none; }
        .link-container button { width: auto; margin-top: 0; padding: 0 20px; background-color: #8b0000; color: #fff; font-size: 14px; font-weight: 700; border: none; border-radius: 6px; cursor: pointer; transition: background .2s; }
        .link-container button:hover { background-color: #660000; }
        .main-btn { width: 100%; padding: 14px; border: none; border-radius: 6px; background-color: #8b0000; color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; transition: background .2s; }
        .main-btn:hover { background-color: #660000; }
        .preview-section { width: 100%; }
        .row-title { color: #e0e0e0; margin: 0 0 15px 0; font-size: 16px; border-bottom: 1px solid #333; padding-bottom: 8px; }
        .horizontal-scroll { display: flex; overflow-x: auto; gap: 15px; padding-bottom: 15px; align-items: flex-start; }
        .horizontal-scroll::-webkit-scrollbar { height: 8px; }
        .horizontal-scroll::-webkit-scrollbar-track { background: #2a2a2a; border-radius: 4px; }
        .horizontal-scroll::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
        .horizontal-scroll::-webkit-scrollbar-thumb:hover { background: #8b0000; }
        .item-card { display: flex; flex-direction: column; gap: 10px; text-decoration: none; }
        .item-card.landscape { width: 280px; }
        .item-card.portrait { width: 150px; }
        .item-card img { object-fit: cover; border-radius: 6px; background-color: #2a2a2a; }
        .item-card.landscape img { width: 280px; aspect-ratio: 16/9; }
        .item-card.portrait img { width: 150px; aspect-ratio: 2/3; }
        .item-title { font-size: 13px; color: #b3b3b3; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; margin: 0; }
        .loading { color: #aaa; font-style: italic; font-size: 14px; padding: 20px 0; text-align: center; width: 100%; align-self: center; }
        .multi-select { position: relative; width: 100%; margin-bottom: 15px; user-select: none; }
        .select-box { padding: 12px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: #fff; font-size: 14px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
        .select-box::after { content: "▼"; font-size: 10px; color: #aaa; }
        .options-container { position: absolute; top: 100%; left: 0; right: 0; background: #2a2a2a; border: 1px solid #333; border-radius: 6px; max-height: 200px; overflow-y: auto; z-index: 100; display: none; flex-direction: column; margin-top: 4px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
        .options-container.show { display: flex; }
        .options-container label { padding: 10px 12px; margin: 0; cursor: pointer; display: flex; align-items: center; border-bottom: 1px solid #333; color: #fff; font-size: 14px; font-weight: 400; }
        .options-container label:last-child { border-bottom: none; }
        .options-container label:hover { background: #333; }
        .options-container input { margin-right: 10px; width: 16px; height: 16px; accent-color: #8b0000; cursor: pointer; }
        .tooltip { position: relative; display: inline-flex; justify-content: center; align-items: center; background: #444; color: #ddd; border-radius: 50%; width: 16px; height: 16px; font-size: 12px; font-weight: bold; margin-left: 6px; cursor: help; }
        .tooltip .tooltiptext { visibility: hidden; width: 220px; background-color: #333; color: #fff; text-align: center; border-radius: 6px; padding: 8px; position: absolute; z-index: 10; bottom: 125%; left: 50%; transform: translateX(-50%); opacity: 0; transition: opacity 0.2s; font-size: 12px; font-weight: 400; box-shadow: 0 4px 10px rgba(0,0,0,0.5); pointer-events: none; line-height: 1.4; }
        .tooltip .tooltiptext::after { content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border-width: 5px; border-style: solid; border-color: #333 transparent transparent transparent; }
        .tooltip:hover .tooltiptext { visibility: visible; opacity: 1; }
        @media (max-width: 768px) {
            body { padding: 10px; height: auto; overflow: auto; }
            .wrapper { flex-direction: column; height: auto; }
            .container, .preview-container { flex: none; width: 100%; max-width: 100%; min-width: 0; height: auto; max-height: none; overflow-y: visible; padding: 20px; }
            .item-card.landscape { width: 220px; }
            .item-card.landscape img { width: 220px; }
            .item-card.portrait { width: 120px; }
            .item-card.portrait img { width: 120px; }
        }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="container">
            <h2>TMDB Top Today</h2>

            <div class="form-group">
                <h3 style="color: #e0e0e0; margin: 0 0 15px 0; font-size: 16px; border-bottom: 1px solid #333; padding-bottom: 8px;">Catalog Filters</h3>
                <label>Language</label>
                <div class="multi-select" id="listLangSelect">
                    <div class="select-box" onclick="toggleMultiSelect()">English</div>
                    <div class="options-container" id="listLangOptions">
                        <label><input type="checkbox" value="all" onchange="handleLangChange(this)"> All</label>
                        <label><input type="checkbox" value="en" checked onchange="handleLangChange(this)"> English</label>
                        <label><input type="checkbox" value="non-en" onchange="handleLangChange(this)"> Global (non English)</label>
                        <label><input type="checkbox" value="ja" onchange="handleLangChange(this)"> Japanese</label>
                        <label><input type="checkbox" value="ko" onchange="handleLangChange(this)"> Korean</label>
                        <label><input type="checkbox" value="es" onchange="handleLangChange(this)"> Spanish</label>
                        <label><input type="checkbox" value="fr" onchange="handleLangChange(this)"> French</label>
                        <label><input type="checkbox" value="de" onchange="handleLangChange(this)"> German</label>
                        <label><input type="checkbox" value="hi" onchange="handleLangChange(this)"> Hindi</label>
                    </div>
                </div>
                <label class="checkbox-group" for="digitalOnly"><input type="checkbox" id="digitalOnly" checked onchange="updateLink()"><span>Filter Movies Not Released Digitally</span></label>
            </div>
            
            <div class="form-group">
                <h3 style="color: #e0e0e0; margin: 0 0 15px 0; font-size: 16px; border-bottom: 1px solid #333; padding-bottom: 8px;">Poster Config</h3>
                <div style="display: flex; justify-content: space-between; margin-bottom: 10px; color: #b3b3b3; font-weight: 600; font-size: 14px; padding: 0 10px;">
                    <span style="flex: 1.5;">Config</span>
                    <span style="flex: 1; text-align: center;">Landscape</span>
                    <span style="flex: 1; text-align: center;">Portrait</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; background: #2a2a2a; padding: 12px; border-radius: 6px; border: 1px solid #333; margin-bottom: 10px;">
                    <span style="flex: 1.5; color: #fff; font-size: 15px;">Tags</span>
                    <div style="flex: 1; text-align: center;"><input type="checkbox" id="landscapeTags" checked onchange="updateLink()" style="width: 18px; height: 18px; accent-color: #8b0000; cursor: pointer;"></div>
                    <div style="flex: 1; text-align: center;"><input type="checkbox" id="portraitTags" checked onchange="updateLink()" style="width: 18px; height: 18px; accent-color: #8b0000; cursor: pointer;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; background: #2a2a2a; padding: 12px; border-radius: 6px; border: 1px solid #333; margin-bottom: 10px;">
                    <span style="flex: 1.5; color: #fff; font-size: 15px;">Streaming Logos</span>
                    <div style="flex: 1; text-align: center;"><input type="checkbox" id="landscapeLogos" onchange="updateLink()" style="width: 18px; height: 18px; accent-color: #8b0000; cursor: pointer;"></div>
                    <div style="flex: 1; text-align: center;"><input type="checkbox" id="portraitLogos" onchange="updateLink()" style="width: 18px; height: 18px; accent-color: #8b0000; cursor: pointer;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; background: #2a2a2a; padding: 12px; border-radius: 6px; border: 1px solid #333; margin-bottom: 10px;">
                    <span style="flex: 1.5; color: #fff; font-size: 15px;">Ranked</span>
                    <div style="flex: 1; text-align: center;"><input type="checkbox" id="landscapeRanked" onchange="updateLink()" style="width: 18px; height: 18px; accent-color: #8b0000; cursor: pointer;"></div>
                    <div style="flex: 1; text-align: center;"><input type="checkbox" id="portraitRanked" checked onchange="updateLink()" style="width: 18px; height: 18px; accent-color: #8b0000; cursor: pointer;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; background: #2a2a2a; padding: 12px; border-radius: 6px; border: 1px solid #333; margin-bottom: 10px;">
                    <span style="flex: 1.5; color: #fff; font-size: 15px;">Language <span class="tooltip">?<span class="tooltiptext">If unavailable, falls back to media source language.</span></span></span>
                    <div style="flex: 2; text-align: center;">
                        <select id="posterLang" onchange="updateLink()" style="width: 97.5%; padding: 6px; font-size: 12px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; outline: none;"><option value="en" selected>English</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="hi">Hindi</option><option value="null">Textless</option></select>
                    </div>
                </div>
            </div>
            
            <div style="margin-top: auto;">
                <div class="form-group">
                    <label>Manifest URL</label>
                    <div class="link-container">
                        <input type="text" id="manifestUrl" readonly style="font-size: 12px;">
                        <button id="copyBtn" onclick="copyLink('manifestUrl', 'copyBtn')">Copy</button>
                    </div>
                </div>
                <div class="form-group">
                    <label>AIOMetadata Poster Pattern URL <span class="tooltip">?<span class="tooltiptext">Uses portrait poster config. Add it to AIOMetadata by pasting it at: Art Providers → Art URL Overrides → URL Patterns → Poster URL Pattern</span></span></label>
                    <div class="link-container">
                        <input type="text" id="patternUrl" readonly style="font-size: 12px;">
                        <button id="copyPatternBtn" onclick="copyLink('patternUrl', 'copyPatternBtn')">Copy</button>
                    </div>
                </div>
                <button id="installBtn" class="main-btn">Install</button>
            </div>
        </div>
        
        <div class="preview-container">
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 25px;">
                <h2 style="margin: 0;">Catalog Preview</h2>
                <select id="previewMode" onchange="renderCurrentData()" style="width: auto; padding: 8px; margin-bottom: 0;">
                    <option value="landscape" selected>Landscape</option>
                    <option value="portrait">Portrait</option>
                </select>
            </div>
            <div class="preview-section">
                <h3 class="row-title">Top Shows Today</h3>
                <div id="shows-preview" class="horizontal-scroll"><div class="loading">Loading shows...</div></div>
            </div>
            <div class="preview-section" style="margin-top: 20px;">
                <h3 class="row-title">Top Movies Today</h3>
                <div id="movies-preview" class="horizontal-scroll"><div class="loading">Loading movies...</div></div>
            </div>
        </div>
    </div>
    <script>
        let previewTimeout;
        let currentShows = [];
        let currentMovies = [];

        function toggleMultiSelect() {
            document.getElementById('listLangOptions').classList.toggle('show');
        }

        document.addEventListener('click', function(e) {
            if (!e.target.closest('.multi-select')) {
                const opts = document.getElementById('listLangOptions');
                if (opts) opts.classList.remove('show');
            }
        });

        function handleLangChange(cb) {
            if ((cb.value === 'all' || cb.value === 'non-en') && cb.checked) {
                document.querySelectorAll('#listLangOptions input').forEach(input => {
                    if (input !== cb) input.checked = false;
                });
            } else if (cb.checked) {
                const allCb = document.querySelector('#listLangOptions input[value="all"]');
                if (allCb) allCb.checked = false;
                const nonEnCb = document.querySelector('#listLangOptions input[value="non-en"]');
                if (nonEnCb) nonEnCb.checked = false;
            }
            updateLink();
        }

        function updateLink() {
            const lt = document.getElementById('landscapeTags').checked,
                  llo = document.getElementById('landscapeLogos').checked,
                  lr = document.getElementById('landscapeRanked').checked,
                  pt = document.getElementById('portraitTags').checked,
                  plo = document.getElementById('portraitLogos').checked,
                  pr_chk = document.getElementById('portraitRanked').checked,
                  plang = document.getElementById('posterLang').value,
                  d = document.getElementById('digitalOnly').checked;
                  
            const checkedLangs = Array.from(document.querySelectorAll('#listLangOptions input:checked'));
            const l = checkedLangs.map(opt => opt.value).join(',') || 'all';
            
            const box = document.querySelector('.select-box');
            if (checkedLangs.length === 0) box.textContent = 'All';
            else if (checkedLangs.length <= 2) box.textContent = checkedLangs.map(cb => cb.parentElement.textContent.trim()).join(', ');
            else box.textContent = checkedLangs.length + ' Languages Selected';
                  
            const c = "landscapeTags=" + lt + "|landscapeLogos=" + llo + "|landscapeRanked=" + lr + "|portraitTags=" + pt + "|portraitLogos=" + plo + "|portraitRanked=" + pr_chk + "|posterLang=" + plang + "|digitalOnly=" + d + "|listLang=" + l;
            const h = window.location.host, pr = window.location.protocol;
            
            // Build dynamic pattern URL
            const patternParams = new URLSearchParams();
            if (!pt) { // if portrait tags are disabled
                patternParams.set('tag', 'none');
            }
            if (plo) { // if portrait logos are enabled
                patternParams.set('logos', '1');
            }
            if (plang !== 'en') { // if language is not the default
                patternParams.set('lang', plang);
            }
            const patternQuery = patternParams.toString() ? '?' + patternParams.toString() : '';

            document.getElementById('manifestUrl').value = pr + "//" + h + "/" + c + "/manifest.json";
            document.getElementById('patternUrl').value = pr + "//" + h + "/image/{type}/{id}.png" + patternQuery;
            document.getElementById('installBtn').onclick = () => { window.location.href = "stremio://" + h + "/" + c + "/manifest.json" };
            
            clearTimeout(previewTimeout);
            previewTimeout = setTimeout(() => updatePreviews(c, pr, h), 500);
        }
        
        async function updatePreviews(config, pr, h) {
            const showsContainer = document.getElementById('shows-preview');
            const moviesContainer = document.getElementById('movies-preview');
            
            showsContainer.innerHTML = '<div class="loading">Loading shows...</div>';
            moviesContainer.innerHTML = '<div class="loading">Loading movies...</div>';
            
            try {
                const [showsRes, moviesRes] = await Promise.all([
                    fetch(pr + "//" + h + "/" + config + "/catalog/series/top_shows_today.json"),
                    fetch(pr + "//" + h + "/" + config + "/catalog/movie/top_movies_today.json")
                ]);
                
                const showsData = await showsRes.json();
                const moviesData = await moviesRes.json();
                
                currentShows = showsData.metas || [];
                currentMovies = moviesData.metas || [];
                
                renderCurrentData();
                
            } catch (err) {
                showsContainer.innerHTML = '<div class="loading">Error loading preview</div>';
                moviesContainer.innerHTML = '<div class="loading">Error loading preview</div>';
            }
        }
        
        function renderCurrentData() {
            const showsContainer = document.getElementById('shows-preview');
            const moviesContainer = document.getElementById('movies-preview');
            const mode = document.getElementById('previewMode').value;
            
            const renderItems = (items) => {
                if (!items || items.length === 0) return '<div class="loading">No items found</div>';
                return items.map(item => {
                    const tmdbType = item.type === 'series' ? 'tv' : 'movie';
                    const imgTag = mode === 'landscape' 
                        ? '<img src="' + item.background + '" alt="bg" loading="lazy" />'
                        : '<img src="' + item.poster + '" alt="poster" loading="lazy" />';
                    return '<a href="https://www.themoviedb.org/' + tmdbType + '/' + item._tmdbId + '" target="_blank" class="item-card ' + mode + '">' +
                           imgTag + 
                           '<p class="item-title" title="' + item.name + '">' + item.name + '</p>' + 
                           '</a>';
                }).join('');
            };
            
            showsContainer.innerHTML = renderItems(currentShows);
            moviesContainer.innerHTML = renderItems(currentMovies);
        }
        
        function copyLink(inputId, buttonId) {
            const c = document.getElementById(inputId);
            c.select();
            c.setSelectionRange(0, 99999);
            navigator.clipboard.writeText(c.value).then(() => {
                const b = document.getElementById(buttonId);
                const o = b.innerText;
                b.innerText = "Copied!";
                b.style.backgroundColor = "#660000";
                setTimeout(() => { b.innerText = o; b.style.backgroundColor = "#8b0000" }, 2000);
            });
        }
        updateLink();
    </script>
</body>
</html>`;

// ─── Route plumbing (unchanged) ───────────────────────────────────────────────

const parseConfig = (configStr) => {
    const configObj = {};
    if (configStr) {
        configStr.split('|').forEach(pair => {
            const [key, val] = pair.split('=');
            if (key && val) configObj[key] = decodeURIComponent(val);
        });
    }
    return configObj;
};

const addonInterface = builder.getInterface();

app.get('/', (req, res) => res.send(configUI));
app.get('/configure', (req, res) => res.send(configUI));
app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
app.get('/:config/manifest.json', (req, res) => {
    const configuredManifest = JSON.parse(JSON.stringify(addonInterface.manifest));
    if (configuredManifest.behaviorHints) configuredManifest.behaviorHints.configurationRequired = false;
    res.json(configuredManifest);
});

app.get('/catalog/:type/:id.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: {} }));
    } catch { res.status(500).json({ err: "Internal Server Error" }); }
});

app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: {} }));
    } catch { res.status(500).json({ err: "Internal Server Error" }); }
});

app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: parseConfig(req.params.config) }));
    } catch { res.status(500).json({ err: "Internal Server Error" }); }
});

app.get('/:config/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: parseConfig(req.params.config) }));
    } catch { res.status(500).json({ err: "Internal Server Error" }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon active on port ${PORT}`));