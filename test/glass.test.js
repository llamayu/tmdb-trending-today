'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { refractGlass, sourceRegion } = require('../src/glass');

// A 400x300 test image read in full; the tag is 200 wide, 48 tall, sitting at the bottom (corner radius 12)
const W = 400, H = 300;
const pill = { startX: 100, startY: 252, width: 200, radius: 12 };
const region = { left: 100, top: 252, width: 200, height: 48 };
const make = (colourAt) => {
    const data = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(colourAt(x, y), (y * W + x) * 3);
    return { data, width: W, height: H, left: 0, top: 0 };
};
const px = (out, x, y) => [...out.data.subarray((y * region.width + x) * 3, (y * region.width + x) * 3 + 3)];

test('glass: the calm middle is copied exactly', () => {
    const src = make((x, y) => [x % 256, y % 256, (x + y) % 256]);
    const out = refractGlass(src, region, pill);
    const x = 100, y = 30; // well inside, more than a rim-width from every edge
    assert.deepEqual(px(out, x, y), [(region.left + x) % 256, (region.top + y) % 256, (region.left + x + region.top + y) % 256]);
    assert.equal(out.data.length, region.width * region.height * 3);
});

test('glass: just inside the top edge you see what lies above the tag', () => {
    const src = make((x, y) => (y < pill.startY ? [220, 20, 20] : [20, 20, 220])); // red above the tag, blue where the tag is
    const out = refractGlass(src, region, pill);
    const [r, , b] = px(out, 100, 3); // 3px below the top edge, middle of the tag
    assert.ok(r > 150 && b < 100, `top rim should show the red above, got r=${r} b=${b}`);
    const [r2, , b2] = px(out, 100, 30); // deeper in: untouched blue
    assert.ok(b2 > 200 && r2 < 40, `middle should stay blue, got r=${r2} b=${b2}`);
});

test('glass: just inside the side edges you see what lies beside the tag', () => {
    const src = make((x, y) => (x < pill.startX || x >= pill.startX + pill.width ? [20, 220, 20] : [20, 20, 220]));
    const out = refractGlass(src, region, pill);
    assert.ok(px(out, 2, 35)[1] > 150, 'left rim shows the green outside');
    assert.ok(px(out, region.width - 3, 35)[1] > 150, 'right rim shows the green outside');
    assert.ok(px(out, 100, 35)[1] < 40, 'middle stays blue');
});

test('glass: colours bend by slightly different amounts at the rim', () => {
    const src = make((x, y) => [y % 256, y % 256, y % 256]); // brightness = row, so "sampled further up" means darker
    const out = refractGlass(src, region, pill);
    const [r, g, b] = px(out, 100, 2);
    assert.ok(r < g && g < b, `expected red < green < blue at the rim, got ${r},${g},${b}`);
    const [r2, g2, b2] = px(out, 100, 30); // no fringe in the middle
    assert.ok(r2 === g2 && g2 === b2);
});

test('glass: the sharper rim fades out toward the middle', () => {
    const src = make(() => [128, 128, 128]);
    const out = refractGlass(src, region, pill);
    const at = (x, y) => out.rim[y * region.width + x];
    assert.ok(at(100, 0) > 0.7, 'strong at the edge');
    assert.ok(at(100, 8) < at(100, 0) && at(100, 8) > at(100, 30), 'easing off');
    assert.equal(at(100, 40), 0); // more than 1.5 rim widths in
});

test('glass: rounded corners bend smoothly (no gaps or jumps in a flat colour)', () => {
    const src = make(() => [90, 140, 200]);
    const out = refractGlass(src, region, pill);
    for (let i = 0; i < out.data.length; i += 3) {
        assert.deepEqual([out.data[i], out.data[i + 1], out.data[i + 2]], [90, 140, 200]);
    }
});

test('glass: the source region reaches past the tag by the bend distance, down to the image bottom', () => {
    const read = sourceRegion(region, pill, W, H);
    assert.ok(read.left < region.left && read.top < region.top);
    assert.ok(read.left + read.width > region.left + region.width);
    assert.equal(read.top + read.height, H);
    const edge = sourceRegion({ left: 0, top: 0, width: 50, height: 20 }, pill, W, H); // never reads outside the image
    assert.equal(edge.left, 0);
    assert.equal(edge.top, 0);
});
