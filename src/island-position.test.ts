import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ISLAND_ANCHOR, ISLAND_ANCHORS, isIslandAnchor,
  nearestIslandAnchor, positionForAnchor,
  type IslandAnchor,
} from './island-position';

const area = { x: 0, y: 30, width: 1440, height: 840 };
const size = { width: 312, height: 76 };

test('all eight positions align to the work-area corners or edge midpoints', () => {
  const expected: Record<IslandAnchor, { x: number; y: number }> = {
    'top-left': { x: 12, y: 42 },
    'top-center': { x: 564, y: 42 },
    'top-right': { x: 1116, y: 42 },
    'right-center': { x: 1116, y: 412 },
    'bottom-right': { x: 1116, y: 782 },
    'bottom-center': { x: 564, y: 782 },
    'bottom-left': { x: 12, y: 782 },
    'left-center': { x: 12, y: 412 },
  };
  assert.equal(ISLAND_ANCHORS.length, 8);
  for (const anchor of ISLAND_ANCHORS) {
    assert.deepEqual(positionForAnchor(area, size, anchor), expected[anchor], anchor);
  }
});

test('monitor origins above or left of the primary display remain relative to that work area', () => {
  const shifted = { ...area, x: -1920, y: -1050 };
  for (const anchor of ISLAND_ANCHORS) {
    const base = positionForAnchor(area, size, anchor);
    assert.deepEqual(positionForAnchor(shifted, size, anchor), {
      x: base.x - 1920, y: base.y - 1080,
    });
  }
});

test('releasing near every position chooses that corner or midpoint', () => {
  for (const anchor of ISLAND_ANCHORS) {
    const exact = positionForAnchor(area, size, anchor);
    assert.equal(nearestIslandAnchor(area, size, exact), anchor);
    assert.equal(nearestIslandAnchor(area, size, { x: exact.x + 35, y: exact.y - 20 }), anchor);
  }
  assert.equal(nearestIslandAnchor(area, size, { x: -100, y: -100 }), 'top-left');
  assert.equal(nearestIslandAnchor(area, size, { x: 2000, y: 1500 }), 'bottom-right');
});

test('nearest position works across negative monitor coordinates', () => {
  const shifted = { x: -1920, y: -1080, width: 1920, height: 1050 };
  assert.equal(nearestIslandAnchor(shifted, size, { x: -1850, y: -950 }), 'top-left');
  assert.equal(nearestIslandAnchor(shifted, size, { x: -850, y: -80 }), 'bottom-center');
  assert.equal(nearestIslandAnchor(shifted, size, { x: -340, y: -610 }), 'right-center');
});

test('equidistant anchors prefer bottom-center, then deterministic clockwise order', () => {
  const bottomCenter = positionForAnchor(area, size, 'bottom-center');
  const bottomLeft = positionForAnchor(area, size, 'bottom-left');
  assert.equal(nearestIslandAnchor(area, size, {
    x: (bottomCenter.x + bottomLeft.x) / 2, y: bottomCenter.y,
  }), DEFAULT_ISLAND_ANCHOR);
  const topLeft = positionForAnchor(area, size, 'top-left');
  const topCenter = positionForAnchor(area, size, 'top-center');
  assert.equal(nearestIslandAnchor(area, size, {
    x: (topLeft.x + topCenter.x) / 2, y: topLeft.y,
  }), 'top-left');
});

test('oversized islands pin their oversized dimension to the work-area origin', () => {
  const tinyArea = { x: -150, y: 30, width: 100, height: 50 };
  const oversized = { width: 312, height: 76 };
  for (const anchor of ISLAND_ANCHORS) {
    assert.deepEqual(positionForAnchor(tinyArea, oversized, anchor), { x: -150, y: 30 });
  }
  assert.equal(nearestIslandAnchor(tinyArea, oversized, { x: -10, y: 400 }), DEFAULT_ISLAND_ANCHOR);
  assert.deepEqual(positionForAnchor(area, { width: 1600, height: 76 }, 'bottom-right'), {
    x: area.x, y: 782,
  });
});

test('padding shrinks when space is scarce and never pushes a fitting island outside the area', () => {
  const tightArea = { x: 20, y: 30, width: 322, height: 84 };
  for (const anchor of ISLAND_ANCHORS) {
    assert.deepEqual(positionForAnchor(tightArea, size, anchor), { x: 25, y: 34 });
  }
  assert.deepEqual(positionForAnchor(area, size, 'top-left', -10), { x: 0, y: 30 });
  assert.deepEqual(positionForAnchor(area, size, 'bottom-right', 24), { x: 1104, y: 770 });
});

test('midpoints use integer desktop pixels even with odd work-area dimensions', () => {
  const oddArea = { x: -101, y: 23, width: 1441, height: 841 };
  assert.deepEqual(positionForAnchor(oddArea, size, 'top-center'), { x: 464, y: 35 });
  assert.deepEqual(positionForAnchor(oddArea, size, 'left-center'), { x: -89, y: 406 });
});

test('anchor guard accepts only the supported persisted positions', () => {
  for (const anchor of ISLAND_ANCHORS) assert.equal(isIslandAnchor(anchor), true);
  for (const value of [null, undefined, '', 'center', 'top_left', 2, {}, ['bottom-center']]) {
    assert.equal(isIslandAnchor(value), false);
  }
});
