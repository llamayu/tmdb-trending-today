'use strict';
const sharp = require('sharp');

/**
 * What sits behind the tag, as seen through a thick edge of glass.
 *
 * A plain blur only softens the artwork. Real glass also bends light, most strongly at its rim: just inside the edge you
 * see a squeezed copy of what lies just beyond it, while the middle stays calm. So:
 *   1. every pixel within one corner-radius of the tag's top or side edge is taken from a spot further OUT (toward the edge,
 *      past it), by an amount that is largest at the edge and eases to nothing inside;
 *   2. red, green and blue are bent by slightly different amounts, which leaves the faint colour fringe real glass has;
 *   3. the middle is frosted as before, while the rim keeps a lightly blurred copy of the bent artwork so the effect is visible.
 *
 * The tag is small, so the per-pixel work below touches a few tens of thousands of pixels and takes a few milliseconds.
 */

const BEND = 0.9; // how far the very edge reaches out, as a share of the rim width (which equals the corner radius)
const DISPERSION = [1.12, 1, 0.88]; // red bends a little more than green, blue a little less
const RIM_REACH = 1.5; // the sharper rim fades out by this many rim widths
const RIM_STRENGTH = 0.85; // how much of the rim is the lightly blurred copy rather than the frosted one
const FROST_BLUR = 7; // the frosted middle (the original flat tag used 15; the glass rim now carries more of the look, so the middle can show more)
const RIM_BLUR = 1.2;

const smoothstep = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/** Bilinear sample of `src` at absolute image coordinates (ax, ay), clamped to the pixels that were read. */
function sampleChannel(src, ax, ay, channel) {
    const x = Math.max(0, Math.min(src.width - 1, ax - src.left - 0.5));
    const y = Math.max(0, Math.min(src.height - 1, ay - src.top - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const at = (xx, yy) => src.data[(yy * src.width + xx) * 3 + channel];
    return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

/**
 * Pure part: bend the pixels. `src` = { data (RGB), width, height, left, top } is a piece of the image read with some margin
 * around the tag; `region` is the part to produce (the tag's bounding box, in image coordinates); `pill` describes the tag:
 * { startX, startY, width, radius } (flat bottom runs off the image, top corners are rounded).
 * Returns { data: RGB pixels of the region, rim: per-pixel 0..1 weight of the sharper rim }.
 */
function refractGlass(src, region, pill) {
    const { startX, startY, width: tagWidth, radius: r } = pill;
    const rim = Math.max(1, r); // rim width = corner radius, which keeps the bend continuous around the corners
    const reach = BEND * rim;
    const endX = startX + tagWidth;
    const out = Buffer.alloc(region.width * region.height * 3);
    const rimWeight = new Float32Array(region.width * region.height);
    const push = (d) => (d >= rim ? 0 : (1 - d / rim) ** 2); // 1 at the edge, 0 one rim-width inside

    for (let py = 0; py < region.height; py++) {
        const ay = region.top + py + 0.5;
        for (let px = 0; px < region.width; px++) {
            const ax = region.left + px + 0.5;
            let vx = 0, vy = 0; // inward push, in units of "full strength"
            let d; // distance to the nearest edge

            const cornerX = ax < startX + r ? startX + r : ax > endX - r ? endX - r : null;
            if (cornerX !== null && ay < startY + r) {
                // rounded top corner: push straight in from the arc
                const cy = startY + r;
                const dist = Math.hypot(ax - cornerX, ay - cy) || 1e-6;
                d = r - dist;
                const g = push(d);
                vx = ((cornerX - ax) / dist) * g;
                vy = ((cy - ay) / dist) * g;
            } else {
                const dt = ay - startY, dl = ax - startX, dr = endX - ax;
                d = Math.min(dt, dl, dr);
                vy = push(dt);
                vx = push(dl) - push(dr);
            }

            const i = py * region.width + px;
            rimWeight[i] = RIM_STRENGTH * (1 - smoothstep(d / (rim * RIM_REACH)));
            if (vx === 0 && vy === 0) { // inside the calm middle: nothing bends, copy the pixel as it is
                const sx = Math.max(0, Math.min(src.width - 1, region.left + px - src.left));
                const sy = Math.max(0, Math.min(src.height - 1, region.top + py - src.top));
                const o = (sy * src.width + sx) * 3;
                out[i * 3] = src.data[o]; out[i * 3 + 1] = src.data[o + 1]; out[i * 3 + 2] = src.data[o + 2];
                continue;
            }
            for (let c = 0; c < 3; c++) {
                const k = reach * DISPERSION[c];
                out[i * 3 + c] = Math.round(sampleChannel(src, ax - vx * k, ay - vy * k, c)); // sample from further out
            }
        }
    }
    return { data: out, rim: rimWeight };
}

/** Region of the image to read: the tag's box plus enough margin above and beside it for the bend to reach into. */
function sourceRegion(region, pill, imageWidth, imageHeight) {
    const margin = Math.ceil(BEND * Math.max(1, pill.radius)) + 3;
    const left = Math.max(0, region.left - margin);
    const top = Math.max(0, region.top - margin);
    const right = Math.min(imageWidth, region.left + region.width + margin);
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, imageHeight - top) };
}

/**
 * The tag's interior as a PNG: refracted rim, frosted middle. `source` is an encoded image, or { buffer, raw } for pixels
 * that were already decoded (the artwork with the title drawn on it). Returns null if anything fails, so the caller can fall
 * back to the plain blur.
 */
async function glassRegion(source, imageWidth, imageHeight, region, pill) {
    try {
        const decoded = !Buffer.isBuffer(source); // { buffer, raw }: pixels that were already decoded
        const input = decoded ? source.buffer : source;
        const options = decoded ? { raw: source.raw } : undefined;
        const read = sourceRegion(region, pill, imageWidth, imageHeight);
        const { data, info } = await sharp(input, options)
            .extract(read)
            .removeAlpha()
            .toColourspace('srgb')
            .raw()
            .toBuffer({ resolveWithObject: true });
        if (info.channels !== 3) return null;

        const bent = refractGlass({ data, width: info.width, height: info.height, left: read.left, top: read.top }, region, pill);
        const raw = { width: region.width, height: region.height, channels: 3 };
        const [frosted, sharper] = await Promise.all([
            sharp(bent.data, { raw }).blur(FROST_BLUR).raw().toBuffer(),
            sharp(bent.data, { raw }).blur(RIM_BLUR).raw().toBuffer(),
        ]);
        const mixed = Buffer.alloc(bent.data.length);
        for (let i = 0; i < bent.rim.length; i++) {
            const w = bent.rim[i];
            for (let c = 0; c < 3; c++) mixed[i * 3 + c] = Math.round(frosted[i * 3 + c] * (1 - w) + sharper[i * 3 + c] * w);
        }
        return await sharp(mixed, { raw }).png().toBuffer();
    } catch {
        return null;
    }
}

module.exports = { glassRegion, refractGlass, sourceRegion, BEND, DISPERSION };
