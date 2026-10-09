'use strict';
const sharp = require('sharp');
const { createLimiter } = require('./util');
const { tagLabel } = require('./tags');
const { resolveProviderLogoInfo, hasNetworkProviderMapping } = require('./providers');

const FONT_STACK = "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FALLBACK_LANGS = ['en', 'null', 'ja', 'ko', 'es', 'fr', 'de', 'hi', 'it', 'pt', 'ru', 'zh', 'th', 'tr', 'pl', 'nl', 'sv', 'ar'];
const XMLNS = 'xmlns="http://www.w3.org/2000/svg"';

// Output formats. Artwork is a photo with small overlays, so lossless PNG is ~8-10x larger than an equivalent JPEG.
// Quality 90 with full-resolution chroma keeps the saturated provider logos and text edges crisp (visually
// indistinguishable from PNG at 1x); mozjpeg would save ~15% more but doubles encode time.
const JPEG_OPTIONS = Object.freeze({ quality: 90, chromaSubsampling: '4:4:4' });
const encode = (image, format) => (format === 'jpg' ? image.flatten({ background: '#000000' }).jpeg(JPEG_OPTIONS) : image.png());

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/**
 * Everything that differs between posters and backdrops. Sizes are ratios of the source image.
 * (Keeping this as data is what lets one pipeline serve both routes.)
 */
const LAYOUTS = {
    poster: {
        imageList: 'posters',
        size: 'w500',
        preferEnglish: true,
        titleLogo: false,
        placeholder: { width: 500, height: 750, label: 'Poster Unavailable' },
        tag: { heightRatio: 0.09, fontRatio: 0.625 },
        rank(w) {
            const fontSize = Math.round(w * 0.30);
            const padTop = Math.round(w * 0.08);
            const padLeft = Math.round(w * 0.08);
            return { fontSize, x: padLeft, y: padTop + fontSize / 1.3, shimmerW: w * 0.6, shimmerH: fontSize * 2 };
        },
        providerLogo(w) {
            return { width: Math.round(w * 0.15), top: Math.round(w * 0.04), rightPad: Math.round(w * 0.04) };
        },
    },
    backdrop: {
        imageList: 'backdrops',
        size: 'w1280',
        preferEnglish: false,
        titleLogo: true,
        placeholder: { width: 1280, height: 720, label: 'No Background Available' },
        tag: { heightRatio: 0.15, fontRatio: 0.75 },
        rank(w, h) {
            const fontSize = Math.round(h * 0.30);
            const padTop = Math.round(h * 0.05);
            const padLeft = Math.round(w * 0.05);
            return { fontSize, x: padLeft, y: padTop + fontSize / 1.1, shimmerW: w * 0.4, shimmerH: fontSize * 1.5 };
        },
        providerLogo(w, h) {
            return { width: Math.round(w * 0.10), top: Math.round(h * 0.04), rightPad: Math.round(h * 0.04) };
        },
    },
};

// ─── Text helpers ────────────────────────────────────────────────────────────

/** Rough rendered width of `text` at `fontSize` (bold sans-serif). */
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const char of text) {
        if ('iIl1., -'.includes(char)) w += fontSize * 0.25;
        else if ('rftj'.includes(char)) w += fontSize * 0.35;
        else if ('WMwm@'.includes(char)) w += fontSize * 0.85;
        else if ('NQDOUCGRHKBAVXY'.includes(char)) w += fontSize * 0.70;
        else if ('PESZT'.includes(char)) w += fontSize * 0.60;
        else w += fontSize * 0.50;
    }
    return w;
}

/** Average colour of the bottom half of the image; decides the tag's text colour and tint. */
async function sampleBottomHalf(imageBuffer, metadata) {
    try {
        const top = Math.floor(metadata.height / 2);
        const height = metadata.height - top;
        const { data, info } = await sharp(imageBuffer)
            .extract({ left: 0, top, width: metadata.width, height })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const { channels } = info;
        const gray = channels < 3; // greyscale (+alpha) sources have no G/B channels
        const pixelCount = info.width * info.height;
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = 0; i < data.length; i += channels) {
            sumR += data[i];
            sumG += gray ? data[i] : data[i + 1];
            sumB += gray ? data[i] : data[i + 2];
        }
        const meanR = Math.round(sumR / pixelCount);
        const meanG = Math.round(sumG / pixelCount);
        const meanB = Math.round(sumB / pixelCount);
        return { meanR, meanG, meanB, luminance: (0.299 * meanR) + (0.587 * meanG) + (0.114 * meanB) };
    } catch {
        return { meanR: 26, meanG: 26, meanB: 26, luminance: 26 };
    }
}

async function blurRegion(imageBuffer, region) {
    try {
        return await sharp(imageBuffer).extract(region).blur(15).png().toBuffer();
    } catch {
        return null;
    }
}

// ─── Overlays ────────────────────────────────────────────────────────────────

/** Soft dark alpha halo so transparent logo edges remain readable on bright artwork. */
async function buildLogoComposites(imageBuffer, left, top, canvasWidth, canvasHeight, { opacity, blur, padding }) {
    const { data, info } = await sharp(imageBuffer)
        .ensureAlpha()
        .extractChannel(3)
        .raw()
        .toBuffer({ resolveWithObject: true });
    const padLeft = Math.min(padding, left);
    const padTop = Math.min(padding, top);
    const padRight = Math.min(padding, canvasWidth - left - info.width);
    const padBottom = Math.min(padding, canvasHeight - top - info.height);
    const shadowWidth = info.width + padLeft + padRight;
    const shadowHeight = info.height + padTop + padBottom;
    const shadow = Buffer.alloc(shadowWidth * shadowHeight * 4);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        const x = i % info.width;
        const y = Math.floor(i / info.width);
        const shadowIndex = ((y + padTop) * shadowWidth + x + padLeft) * 4;
        shadow[shadowIndex + 3] = Math.round(data[i] * opacity);
    }
    const shadowBuffer = await sharp(shadow, {
        raw: { width: shadowWidth, height: shadowHeight, channels: 4 },
    }).blur(blur).png().toBuffer();
    return [
        { input: shadowBuffer, top: top - padTop, left: left - padLeft },
        { input: imageBuffer, top, left },
    ];
}

function buildTitleLogoGradient(left, top, logoWidth, logoHeight, canvasWidth, canvasHeight, portrait) {
    const cx = left + logoWidth / 2;
    const cy = top + logoHeight / 2;
    const rx = Math.min(canvasWidth, Math.round(logoWidth * (portrait ? 0.8 : 0.75)));
    const ry = Math.min(canvasHeight, Math.round(logoHeight * (portrait ? 1.9 : 1.8)));
    const svg = `<svg ${XMLNS} width="${canvasWidth}" height="${canvasHeight}">
        <defs><radialGradient id="titleFade">
            <stop offset="0%" stop-color="#000" stop-opacity="0.38"/>
            <stop offset="45%" stop-color="#000" stop-opacity="0.25"/>
            <stop offset="78%" stop-color="#000" stop-opacity="0.08"/>
            <stop offset="100%" stop-color="#000" stop-opacity="0"/>
        </radialGradient></defs>
        <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#titleFade)"/>
    </svg>`;
    return { input: Buffer.from(svg), top: 0, left: 0 };
}

function buildTitleTextComposite(title, width, height, layout, hasTag) {
    const portrait = layout === LAYOUTS.poster;
    const maxFontSize = Math.round(height * (portrait ? 0.095 : 0.14));
    const maxWidth = Math.round(width * (portrait ? 0.84 : 0.90));
    const words = String(title).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;

    const lines = [];
    let line = '';
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && estimateTextWidth(candidate, maxFontSize) > maxWidth && lines.length === 0) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    lines.push(line);
    if (lines.length > 2) {
        lines.splice(1, lines.length - 2, `${lines.slice(1, -1).join(' ')} ${lines.at(-1)}`);
    }

    const fontSize = Math.max(16, Math.min(
        maxFontSize,
        ...lines.map((text) => Math.floor(maxWidth * maxFontSize / estimateTextWidth(text, maxFontSize))),
    ));
    const bottomSpace = portrait
        ? Math.round(height * (hasTag ? layout.tag.heightRatio + 0.04 : 0.07))
        : Math.round(height * 0.20);
    const lineHeight = Math.round(fontSize * 1.12);
    const firstBaseline = height - bottomSpace - ((lines.length - 1) * lineHeight);
    const textAnchor = portrait ? 'middle' : 'start';
    const x = portrait ? Math.round(width / 2) : Math.round(width * 0.05);
    const tspans = lines.map((text, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(text)}</tspan>`).join('');
    const svg = `<svg ${XMLNS} width="${width}" height="${height}">
        <defs><filter id="titleTextShadow" x="-20%" y="-30%" width="140%" height="160%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
            <feOffset dx="2" dy="3" result="offset"/>
            <feFlood flood-color="#000" flood-opacity="0.9"/>
            <feComposite in2="offset" operator="in"/>
            <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter></defs>
        <text y="${firstBaseline}" text-anchor="${textAnchor}" font-family="${FONT_STACK}"
              font-size="${fontSize}" font-weight="bold" fill="#fff" filter="url(#titleTextShadow)">${tspans}</text>
    </svg>`;
    return { input: Buffer.from(svg), top: 0, left: 0 };
}

const LINEAR_RGB = Array.from({ length: 256 }, (_, value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});
const pixelLuminance = (data, offset) =>
    (0.2126 * LINEAR_RGB[data[offset]]) +
    (0.7152 * LINEAR_RGB[data[offset + 1]]) +
    (0.0722 * LINEAR_RGB[data[offset + 2]]);

async function titleLogoContrast(imageBuffer, logoBuffer, left, top) {
    const logo = await sharp(logoBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const background = await sharp(imageBuffer)
        .extract({ left, top, width: logo.info.width, height: logo.info.height })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let logoLuminance = 0;
    let backgroundLuminance = 0;
    let totalAlpha = 0;
    for (let i = 0; i < logo.data.length; i += 4) {
        const alpha = logo.data[i + 3] / 255;
        if (alpha === 0) continue;
        logoLuminance += pixelLuminance(logo.data, i) * alpha;
        backgroundLuminance += pixelLuminance(background.data, i) * alpha;
        totalAlpha += alpha;
    }
    if (totalAlpha === 0) return Infinity;
    const logoMean = logoLuminance / totalAlpha;
    const backgroundMean = backgroundLuminance / totalAlpha;
    return (Math.max(logoMean, backgroundMean) + 0.05) / (Math.min(logoMean, backgroundMean) + 0.05);
}

/** Frosted-glass pill along the bottom edge, containing `tagText`. Returns sharp composite operations. */
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

    const [colorInfo, blurBuffer] = await Promise.all([
        sampleBottomHalf(imageBuffer, metadata),
        blurRegion(imageBuffer, { left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight }),
    ]);

    const { meanR, meanG, meanB, luminance } = colorInfo;
    const textColor = luminance > 140 ? '#121212' : '#ffffff';

    // Bright artwork gets a light tint with dark text; everything else gets a deep tint with white text,
    // so the label keeps strong contrast whatever the poster looks like.
    const darkText = textColor === '#121212';
    const blendTarget = darkText ? 255 : 0;
    const mix = darkText ? 0.25 : 0.5;
    const adjR = Math.round(meanR + (blendTarget - meanR) * mix);
    const adjG = Math.round(meanG + (blendTarget - meanG) * mix);
    const adjB = Math.round(meanB + (blendTarget - meanB) * mix);

    const tagFillColor = `rgb(${adjR}, ${adjG}, ${adjB})`;
    let tagFillOpacity = '0.7';
    const composites = [];

    if (blurBuffer) {
        const localPath = `M 0,${extractHeight} L ${extractWidth},${extractHeight} L ${extractWidth},${r} Q ${extractWidth},0 ${extractWidth - r},0 L ${r},0 Q 0,0 0,${r} Z`;
        const maskSvg = `<svg ${XMLNS} width="${extractWidth}" height="${extractHeight}"><path d="${localPath}" fill="white"/></svg>`;
        const shapedBlur = await sharp(blurBuffer)
            .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
            .png()
            .toBuffer();
        composites.push({ input: shapedBlur, top: extractTop, left: extractLeft });
    } else {
        tagFillOpacity = '0.88';
    }

    // Light edge along the top, the rounded corners and down both sides. A vertical gradient keeps it brightest at the top and
    // fades it to nothing by the bottom of the image, so the sides dissolve instead of ending abruptly. Its thickness
    // scales with the tag so it reads the same on posters and backdrops. A horizontal mask keeps it brightest in the
    // centre and softer toward the corners, which is what gives the tab its glassy highlight.
    const edge = Math.max(2, Math.round(tagHeight * 0.03));
    const edgePath = (inset) => {
        const x0 = startX + inset, x1 = startX + tagWidth - inset, y0 = startY + inset;
        const rr = Math.max(0, r - inset);
        return `M ${x0},${height} L ${x0},${y0 + rr} Q ${x0},${y0} ${x0 + rr},${y0} L ${x1 - rr},${y0} Q ${x1},${y0} ${x1},${y0 + rr} L ${x1},${height}`;
    };
    // On bright artwork a white line has nothing to contrast with, so add a faint dark line just outside it.
    const darkOutline = darkText
        ? `<path d="${edgePath(-edge / 2)}" fill="none" stroke="url(#edgeDark)" stroke-width="${edge}"/>`
        : '';

    const pillPath = `M ${startX},${height} L ${startX + tagWidth},${height} L ${startX + tagWidth},${startY + r} Q ${startX + tagWidth},${startY} ${startX + tagWidth - r},${startY} L ${startX + r},${startY} Q ${startX},${startY} ${startX},${startY + r} Z`;
    const tagSvg = `<svg ${XMLNS} width="${width}" height="${height}">
        <defs>
            <linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="0" y1="${startY}" x2="0" y2="${height}">
                <stop offset="0" stop-color="#fff" stop-opacity="0.5"/>
                <stop offset="0.2" stop-color="#fff" stop-opacity="0.3"/>
                <stop offset="0.45" stop-color="#fff" stop-opacity="0.08"/>
                <stop offset="0.7" stop-color="#fff" stop-opacity="0"/>
            </linearGradient>
            <linearGradient id="edgeDark" gradientUnits="userSpaceOnUse" x1="0" y1="${startY}" x2="0" y2="${height}">
                <stop offset="0" stop-color="#000" stop-opacity="0.18"/>
                <stop offset="0.2" stop-color="#000" stop-opacity="0.11"/>
                <stop offset="0.45" stop-color="#000" stop-opacity="0.03"/>
                <stop offset="0.7" stop-color="#000" stop-opacity="0"/>
            </linearGradient>
            <linearGradient id="edgeH" gradientUnits="userSpaceOnUse" x1="${startX}" y1="0" x2="${startX + tagWidth}" y2="0">
                <stop offset="0" stop-color="#fff" stop-opacity="0.25"/>
                <stop offset="0.5" stop-color="#fff" stop-opacity="1"/>
                <stop offset="1" stop-color="#fff" stop-opacity="0.25"/>
            </linearGradient>
            <mask id="edgeMask" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">
                <rect x="0" y="0" width="${width}" height="${height}" fill="url(#edgeH)"/>
            </mask>
        </defs>
        <path d="${pillPath}" fill="${tagFillColor}" fill-opacity="${tagFillOpacity}"/>
        <g mask="url(#edgeMask)">
            ${darkOutline}
            <path d="${edgePath(edge / 2)}" fill="none" stroke="url(#edge)" stroke-width="${edge}"/>
        </g>
        <text x="${width / 2}" y="${startY + (tagHeight / 2) + (fontSize * 0.35)}" text-anchor="middle"
              font-family="${FONT_STACK}" font-size="${fontSize}" fill="${textColor}" font-weight="bold">${escapeXml(tagText)}</text>
    </svg>`;
    composites.push({ input: Buffer.from(tagSvg), top: 0, left: 0 });
    return composites;
}

/** Big silver rank number with a soft shadow, top-left. */
function buildRankComposite(layout, rankText, width, height) {
    const g = layout.rank(width, height);
    const svg = `<svg ${XMLNS} width="${width}" height="${height}">
        <defs>
            <linearGradient id="rankGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%"   style="stop-color:#ffffff;stop-opacity:1"/>
                <stop offset="60%"  style="stop-color:#dedede;stop-opacity:1"/>
                <stop offset="100%" style="stop-color:#a8a8a8;stop-opacity:1"/>
            </linearGradient>
            <filter id="rankShadow" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
                <feOffset dx="3" dy="3" result="offsetblur"/>
                <feFlood flood-color="black" flood-opacity="0.9"/>
                <feComposite in2="offsetblur" operator="in"/>
                <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <radialGradient id="shimmerGradient" cx="0%" cy="0%" r="100%" fx="0%" fy="0%">
                <stop offset="0%"   style="stop-color:black;stop-opacity:0.75"/>
                <stop offset="40%"  style="stop-color:black;stop-opacity:0.45"/>
                <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
            </radialGradient>
        </defs>
        <rect x="0" y="0" width="${g.shimmerW}" height="${g.shimmerH}" fill="url(#shimmerGradient)"/>
        <text x="${g.x}" y="${g.y}" text-anchor="start"
              font-family="${FONT_STACK}" font-size="${g.fontSize}"
              fill="url(#rankGradient)" fill-opacity="0.75" font-weight="bold"
              filter="url(#rankShadow)">${escapeXml(rankText)}</text>
    </svg>`;
    return { input: Buffer.from(svg), top: 0, left: 0 };
}

/** Streaming-service / network logo, top-right. Returns null (and the image is still served) if anything goes wrong. */
async function buildProviderLogo(tmdb, info, layout, width, height, logger) {
    if (!info?.path) return null;
    try {
        const { width: logoWidth, top, rightPad } = layout.providerLogo(width, height);
        const buf = await tmdb.image('w154', info.path);
        let resized = await sharp(buf).resize({ width: logoWidth, withoutEnlargement: true }).png().toBuffer();
        const meta = await sharp(resized).metadata();

        if (!info.isNetwork) {
            const radius = Math.round(logoWidth * 0.2);
            const mask = Buffer.from(`<svg ${XMLNS} width="${meta.width}" height="${meta.height}">
                <rect x="0" y="0" width="${meta.width}" height="${meta.height}" rx="${radius}" ry="${radius}" fill="white"/>
            </svg>`);
            resized = await sharp(resized).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
        }
        return [{ input: resized, top, left: Math.round(width - meta.width - rightPad) }];
    } catch (err) {
        logger.error('Provider logo error:', err.message);
        return null;
    }
}

/** Title logo near the bottom; portrait artwork centers it above the reserved tag area. */
async function buildTitleLogo(tmdb, logo, imageBuffer, width, height, layout, hasTag, logger) {
    try {
        const buf = await tmdb.image('original', logo.file_path);
        const portrait = layout === LAYOUTS.poster;
        let source = sharp(buf);
        if (portrait) {
            source = source.trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 });
        }
        let resized = await source
            .resize({
                width: Math.round(width * (portrait ? 0.84 : 0.50)),
                height: Math.round(height * (portrait ? 0.25 : 0.40)),
                fit: 'inside',
            })
            .png()
            .toBuffer();
        const meta = await sharp(resized).metadata();

        const targetLeft = portrait ? Math.round((width - meta.width) / 2) : Math.round(width * 0.05);
        const bottomSpace = portrait
            ? Math.round(height * (hasTag ? layout.tag.heightRatio + 0.04 : 0.07))
            : Math.round(height * 0.20);
        const targetTop = height - meta.height - bottomSpace;

        // sharp refuses overlays that extend past the base image, so crop whatever would overhang
        const cropLeft = Math.max(0, -targetLeft);
        const cropTop = Math.max(0, -targetTop);
        const cropWidth = Math.min(meta.width, width - targetLeft) - cropLeft;
        const cropHeight = Math.min(meta.height, height - targetTop) - cropTop;
        if (cropWidth <= 0 || cropHeight <= 0) return null;
        if (cropWidth < meta.width || cropHeight < meta.height) {
            resized = await sharp(resized)
                .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
                .toBuffer();
        }
        const shadow = portrait
            ? { opacity: 0.7, blur: 5, padding: 16 }
            : { opacity: 0.9, blur: 10, padding: 30 };
        const logoLeft = targetLeft + cropLeft;
        const logoTop = targetTop + cropTop;
        const shadowComposites = await buildLogoComposites(resized, logoLeft, logoTop, width, height, shadow);
        const contrast = await titleLogoContrast(imageBuffer, resized, logoLeft, logoTop);
        const gradient = contrast < 3
            ? [buildTitleLogoGradient(logoLeft, logoTop, cropWidth, cropHeight, width, height, portrait)]
            : [];
        return [...gradient, ...shadowComposites];
    } catch (err) {
        logger.error('Title logo error:', err.message);
        return null;
    }
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/** First image whose language matches the earliest entry of `preferences` that has any. */
function pickByLanguage(images, preferences) {
    for (const lang of preferences) {
        const hit = images.find((im) => im.iso_639_1 === lang);
        if (hit) return hit;
    }
    return null;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./tmdb').createTmdbClient>} deps.tmdb
 * @param {number} [deps.concurrency] how many images may be composited at once (CPU/memory bound)
 */
function createArtwork({ tmdb, concurrency = 4, logger = console }) {
    const limit = createLimiter(concurrency);
    const placeholders = new Map();

    /** Locally generated stand-in for titles with no image (no dependency on an external placeholder service). */
    function placeholder(kind, format) {
        const memo = `${kind}|${format}`;
        if (!placeholders.has(memo)) {
            const { width, height, label } = LAYOUTS[kind].placeholder;
            const svg = `<svg ${XMLNS} width="${width}" height="${height}">
                <rect width="100%" height="100%" fill="#1e1e1e"/>
                <text x="50%" y="50%" text-anchor="middle" fill="#8a8a8a" font-family="${FONT_STACK}" font-size="${Math.round(height * 0.04)}">${escapeXml(label)}</text>
            </svg>`;
            placeholders.set(memo, encode(sharp(Buffer.from(svg)), format).toBuffer());
        }
        return placeholders.get(memo);
    }

    /**
     * @param {{kind:'poster'|'backdrop', id:string, type:'movie'|'series', tag:string, rank:string, lang:string, logos:boolean, textless?:boolean, format?:'png'|'jpg'}} params
     *        (already validated by the caller; format defaults to png)
     * @returns {Promise<{kind:'image', buffer:Buffer} | {kind:'redirect', url:string} | {kind:'placeholder', buffer:Buffer}>}
     */
    async function render(params) {
        const layout = LAYOUTS[params.kind];
        const format = params.format === 'jpg' ? 'jpg' : 'png';
        const tmdbType = params.type === 'series' ? 'tv' : 'movie';
        const tagText = tagLabel(params.tag);
        const rankText = params.rank !== 'none' ? params.rank : null;

        const details = await tmdb.json(`/${tmdbType}/${params.id}`);
        const originalLang = details.original_language;

        const langs = [...new Set([params.lang, originalLang, ...FALLBACK_LANGS])].filter(Boolean);
        const allowed = new Set(langs.map((l) => (l === 'null' ? null : l)));

        const [images, providers] = await Promise.all([
            tmdb.json(`/${tmdbType}/${params.id}/images`, { include_image_language: langs.join(',') }),
            // The corner logo is decoration: if this lookup fails, still serve the artwork without it
            params.logos ? tmdb.json(`/${tmdbType}/${params.id}/watch/providers`).catch(() => null) : null,
        ]);

        const candidates = (images[layout.imageList] || []).filter((im) => allowed.has(im.iso_639_1));
        const wanted = params.lang === 'null' ? null : params.lang;
        const standardImage = pickByLanguage(candidates, [wanted, originalLang, null, ...(layout.preferEnglish ? ['en'] : [])])
            || candidates[0];
        let image = standardImage;
        let fallbackBackdrop = false;
        if (params.textless) {
            if (params.kind === 'poster') {
                image = (images.posters || []).find((candidate) => candidate.iso_639_1 === null && candidate.file_path);
                if (!image) {
                    image = (images.backdrops || []).find((candidate) => candidate.iso_639_1 === null && candidate.file_path);
                    fallbackBackdrop = Boolean(image);
                }
            } else {
                image = (images.backdrops || []).find((candidate) => candidate.iso_639_1 === null && candidate.file_path);
            }
            image ||= standardImage;
        }
        if (!image?.file_path) return { kind: 'placeholder', buffer: await placeholder(params.kind, format) };

        // In textless mode, title logos also replace text on posters.
        const titleExpected = (params.textless || layout.titleLogo && params.lang !== 'null')
            && image.iso_639_1 === null;
        let titleLogo = null;
        if (titleExpected && images.logos?.length) {
            titleLogo = pickByLanguage(images.logos, [params.lang, originalLang, 'en']) || images.logos[0];
        }
        const titleText = titleExpected ? details.title || details.name : null;
        let providerCatalog;
        const networkName = details.networks?.[0]?.name;
        if (params.logos && tmdbType === 'tv' &&
            !(providers?.results?.US?.flatrate || []).length && hasNetworkProviderMapping(networkName)) {
            providerCatalog = await tmdb.json('/watch/providers/tv', { watch_region: 'US' }).then((r) => r.results, (err) => {
                logger.warn?.(`Failed to load streaming provider logos: ${err.message}`);
                return null;
            });
        }
        const providerInfo = params.logos
            ? resolveProviderLogoInfo(tmdbType, { ...details, 'watch/providers': providers }, providerCatalog)
            : null;

        const sourceSize = fallbackBackdrop ? LAYOUTS.backdrop.size : layout.size;
        const passthrough = { kind: 'redirect', url: tmdb.imageUrl(sourceSize, image.file_path) };
        if (!fallbackBackdrop && !tagText && !rankText && !providerInfo && !titleLogo && !titleText) return passthrough; // nothing to draw

        let base = await tmdb.image(sourceSize, image.file_path);
        if (fallbackBackdrop) {
            base = await sharp(base)
                .resize({
                    width: layout.placeholder.width,
                    height: layout.placeholder.height,
                    fit: 'cover',
                    position: 'centre',
                })
                .toBuffer();
        }

        const buffer = await limit(async () => {
            const { width, height } = await sharp(base).metadata();
            const meta = { width, height };
            const [tagOps, providerOps, titleOps] = await Promise.all([
                tagText ? buildTagComposites(base, meta, tagText, layout.tag.heightRatio, layout.tag.fontRatio) : [],
                providerInfo ? buildProviderLogo(tmdb, providerInfo, layout, width, height, logger) : null,
                titleLogo ? buildTitleLogo(tmdb, titleLogo, base, width, height, layout, Boolean(tagText), logger) : null,
            ]);
            const ops = [
                ...(providerOps || []),
                ...(titleOps || []),
                titleText && !titleOps?.length
                    ? buildTitleTextComposite(titleText, width, height, layout, Boolean(tagText))
                    : null,
                rankText ? buildRankComposite(layout, rankText, width, height) : null,
                ...tagOps,
            ].filter(Boolean);
            if (ops.length === 0) return fallbackBackdrop ? encode(sharp(base), format).toBuffer() : null;
            return encode(sharp(base).composite(ops), format).toBuffer();
        });

        return buffer ? { kind: 'image', buffer } : passthrough;
    }

    return { render };
}

module.exports = { createArtwork, LAYOUTS, escapeXml, estimateTextWidth, sampleBottomHalf, buildTagComposites, buildRankComposite };
