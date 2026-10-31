import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  estimateStudioBody,
  estimateStudioLayoutBodies,
  alignStudioGroupDepth,
} from '../src/studio-body.mjs';
import { validateStudioDoc } from '../src/studio-domain.mjs';

const makeItem = (id = 'a', bbox = [384, 384, 640, 800], extra = {}) => ({
  id,
  label: 'object',
  caption: 'A wooden crate',
  bbox,
  ...extra,
});

const makeLayout = (items = [makeItem()], extra = {}) => ({
  width: 1024,
  height: 1024,
  bbox_coord_space: 'abs',
  bbox_format: 'xyxy',
  summary: { caption: 'A test scene' },
  items,
  ...extra,
});

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

const errorCode = (code) => (error) => error.code === code;

function assertValidLayout(layout) {
  const doc = {
    kind: 'layout',
    layout,
    caption: { caption: '' },
  };
  assert.doesNotThrow(() => validateStudioDoc(doc));
}

test('explicit body is returned as a detached copy and text items get screen anchor', () => {
  const explicitItem = makeItem('exp', [100, 100, 300, 300], {
    body: { z: 2.34, thickness: 0.8, yaw: -45, anchor: 'world' },
  });
  const textItem = makeItem('txt', [50, 50, 400, 120], {
    label: 'text',
    caption: 'Title banner',
    text: 'HELLO',
  });
  const input = freeze(makeLayout([explicitItem, textItem]));
  const expBody = estimateStudioBody(explicitItem, input);
  assert.deepEqual(expBody, explicitItem.body);
  assert.notEqual(expBody, explicitItem.body);

  const txtBody = estimateStudioBody(textItem, input);
  assert.deepEqual(txtBody, { z: 1, thickness: 0.05, yaw: 0, anchor: 'screen' });
});

test('background coverage and bilingual keyword heuristics classify backdrop vs world', () => {
  const W = 1024, H = 1024;
  // Rule 1: width >= 0.9W and height >= 0.6H -> backdrop even with neutral caption
  const fullCover = makeItem('c1', [0, 0, 930, 620], { caption: 'plain rectangle' });
  // Rule 2: > half canvas area (e.g. 800 * 700 = 560,000 > 524,288) + bilingual keyword
  const halfSky = makeItem('c2', [100, 50, 900, 750], { name: '远处天空', caption: 'clear blue' });
  const halfPlain = makeItem('c3', [100, 50, 900, 750], { caption: 'large red box' });
  // Rule 3: width >= 0.85W and (depth === 'bg' or keyword) and area > 0.15 canvas
  const wideBgDepth = makeItem('c4', [50, 0, 950, 220], { depth: 'bg', caption: 'distant strip' });
  const wideWaterWord = makeItem('c5', [50, 600, 950, 820], { caption: 'calm ocean water surface' });
  const wideTooSmall = makeItem('c6', [50, 0, 950, 100], { depth: 'bg', caption: 'sky strip' }); // 900*100 = 90,000 < 0.15*1048576
  // Character with huge bbox stays world, not backdrop
  const hugeChar = makeItem('c7', [0, 0, 960, 960], { label: 'character', caption: 'background guard' });

  const l = freeze(makeLayout([fullCover, halfSky, halfPlain, wideBgDepth, wideWaterWord, wideTooSmall, hugeChar]));

  assert.deepEqual(estimateStudioBody(fullCover, l), { z: 6, thickness: 0, yaw: 0, anchor: 'backdrop' });
  assert.deepEqual(estimateStudioBody(halfSky, l), { z: 6, thickness: 0, yaw: 0, anchor: 'backdrop' });
  assert.equal(estimateStudioBody(halfPlain, l).anchor, 'world');
  assert.deepEqual(estimateStudioBody(wideBgDepth, l), { z: 6, thickness: 0, yaw: 0, anchor: 'backdrop' });
  assert.deepEqual(estimateStudioBody(wideWaterWord, l), { z: 6, thickness: 0, yaw: 0, anchor: 'backdrop' });
  assert.equal(estimateStudioBody(wideTooSmall, l).anchor, 'world');
  assert.equal(estimateStudioBody(hugeChar, l).anchor, 'world');
});

test('ground vs aerial depth uses default or enabled perspective horizon and thickness rules', () => {
  // Default horizon = 0.45 * 1000 = 450; threshold = 450 + 50 = 500
  const groundChar = makeItem('char', [300, 200, 500, 850], { label: 'character' });
  // bottom = 850 > 500 -> z = (1000 - 450) / (850 - 450) = 550 / 400 = 1.375 -> round 0.01 = 1.38
  const aerialObj = makeItem('bird', [400, 100, 500, 200], { label: 'object' });
  // bottom = 200 <= 500 -> sqrt(0.18 * 1000 * 1000 / 10000) = sqrt(18) = 4.24264 -> 4.24
  const flatWide = makeItem('banner', [100, 700, 500, 800], { label: 'object' }); // w=400, h=100 (w > 3h) -> thickness 0.12
  const flatTall = makeItem('pole', [700, 200, 740, 850], { label: 'object' }); // w=40, h=650 (h > 4w) -> thickness 0.12

  const baseLayout = freeze(makeLayout([groundChar, aerialObj, flatWide, flatTall], { width: 1000, height: 1000 }));
  assert.deepEqual(estimateStudioBody(groundChar, baseLayout), {
    z: 1.38,
    thickness: 0.45,
    yaw: 0,
    anchor: 'world',
  });
  assert.deepEqual(estimateStudioBody(aerialObj, baseLayout), {
    z: 4.24,
    thickness: 0.6,
    yaw: 0,
    anchor: 'world',
  });
  assert.equal(estimateStudioBody(flatWide, baseLayout).thickness, 0.12);
  assert.equal(estimateStudioBody(flatTall, baseLayout).thickness, 0.12);

  // Enabled perspective with custom horizon_y = 700 -> groundChar bottom 850 > 750 -> z = (1000 - 700)/(850 - 700) = 2
  const perspLayout = freeze({
    ...baseLayout,
    perspective: { enabled: true, horizon_y: 700 },
  });
  assert.equal(estimateStudioBody(groundChar, perspLayout).z, 2);

  // Disabled perspective ignores horizon_y = 700 and uses 0.45 * H
  const disabledPerspLayout = freeze({
    ...baseLayout,
    perspective: { enabled: false, horizon_y: 700 },
  });
  assert.equal(estimateStudioBody(groundChar, disabledPerspLayout).z, 1.38);
});

test('held prop and group attachment follow parent depth with front/back layer factor and preference rules', () => {
  // Character from [200, 200, 600, 900] on 1000x1000:
  // horizon = 450, bottom = 900 -> z = 550 / 450 = 1.2222... -> base z ~ 1.22
  const behindProp = makeItem('cape', [220, 300, 320, 500], { label: 'object', caption: 'short cape' });
  const holderChar = makeItem('hero', [200, 200, 600, 900], { label: 'character', caption: 'hero' });
  const frontProp = makeItem('sword', [450, 400, 550, 550], { label: 'object', caption: 'sword' });

  const l1 = freeze(makeLayout([behindProp, holderChar, frontProp], { width: 1000, height: 1000 }));
  const charBody = estimateStudioBody(holderChar, l1);
  const behindBody = estimateStudioBody(behindProp, l1);
  const frontBody = estimateStudioBody(frontProp, l1);

  assert.equal(charBody.z, 1.22);
  // behindProp is before holderChar -> 1.03 factor
  assert.equal(behindBody.z, Math.round(charBody.z * 1.03 * 100) / 100);
  // frontProp is after holderChar -> 0.97 factor
  assert.equal(frontBody.z, Math.round(charBody.z * 0.97 * 100) / 100);

  // Explicit parent body is honored
  const explicitChar = { ...holderChar, body: { z: 3, thickness: 0.45, yaw: 0, anchor: 'world' } };
  const l2 = freeze(makeLayout([explicitChar, frontProp], { width: 1000, height: 1000 }));
  assert.equal(estimateStudioBody(frontProp, l2).z, 2.91); // 3 * 0.97

  // Same-group larger object is preferred over ungrouped character
  const groupMount = makeItem('horse', [380, 350, 750, 850], {
    label: 'object',
    group: 'riders',
    body: { z: 2.5, thickness: 0.6, yaw: 0, anchor: 'world' },
  });
  const groupedProp = makeItem('saddle', [460, 420, 540, 520], {
    label: 'object',
    group: 'riders',
  });
  // groupedProp overlaps both holderChar (z=1.22) and groupMount (z=2.5); prefers same-group groupMount
  const l3 = freeze(makeLayout([holderChar, groupMount, groupedProp], { width: 1024, height: 1024 }));
  assert.equal(estimateStudioBody(groupedProp, l3).z, Math.round(2.5 * 0.97 * 100) / 100);
});

test('hidden parents, text items, and backdrops never act as holders', () => {
  const hiddenChar = makeItem('hidden-hero', [200, 200, 600, 900], {
    label: 'character',
    hidden: true,
    body: { z: 3, thickness: 0.45, yaw: 0, anchor: 'world' },
  });
  const backdropItem = makeItem('bg', [0, 0, 1000, 900], {
    label: 'object',
    caption: 'sky background',
  });
  const textParent = makeItem('txt', [200, 200, 600, 900], {
    label: 'text',
    text: 'BIG',
  });
  const prop = makeItem('orb', [350, 250, 450, 350], { label: 'object' }); // aerial: bottom=350 <= 500 -> sqrt(0.18*1e6/10000)=4.24

  const l = freeze(makeLayout([hiddenChar, backdropItem, textParent, prop], { width: 1000, height: 1000 }));
  assert.equal(estimateStudioBody(prop, l).z, 4.24);
});

test('estimateStudioLayoutBodies respects onlyMissing, locked items, and avoids stale unlocked parent bodies when onlyMissing is false', () => {
  const lockedParent = makeItem('locked-char', [100, 200, 400, 900], {
    label: 'character',
    locked: true,
    tags: ['keep'],
    body: { z: 4, thickness: 0.4, yaw: 15, anchor: 'world' },
  });
  const unlockedParent = makeItem('unlocked-char', [500, 200, 850, 900], {
    label: 'character',
    body: { z: 7, thickness: 0.9, yaw: 30, anchor: 'world' }, // stale manual body
  });
  const propOnUnlocked = makeItem('badge', [600, 400, 680, 480], {
    label: 'object',
    // missing body
  });
  const propOnLocked = makeItem('pin', [200, 400, 280, 480], {
    label: 'object',
    body: { z: 6, thickness: 0.5, yaw: 0, anchor: 'world' },
  });

  const input = freeze(makeLayout([lockedParent, unlockedParent, propOnUnlocked, propOnLocked], { width: 1024, height: 1024 }));
  const snapshot = JSON.stringify(input);

  // onlyMissing: true (default) -> preserves unlockedParent.body (z=7) and propOnLocked.body (z=6), estimates propOnUnlocked using unlockedParent's existing z=7
  const missingOnly = estimateStudioLayoutBodies(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(missingOnly.items[0], lockedParent);
  assert.deepEqual(missingOnly.items[1].body, unlockedParent.body);
  assert.equal(missingOnly.items[2].body.z, 6.79); // 7 * 0.97
  assert.deepEqual(missingOnly.items[3].body, propOnLocked.body);
  assertValidLayout(missingOnly);

  // onlyMissing: false -> lockedParent stays byte-for-byte identical (z=4);
  // unlockedParent is re-estimated from geometry on 1024x1024 (hy=460.8, bottom=900 -> 563.2/439.2 = 1.28),
  // and propOnUnlocked uses new parent estimate (1.28 * 0.97 = 1.24), NOT old z=7!
  // propOnLocked uses lockedParent's authority z=4 -> 4 * 0.97 = 3.88.
  const reestimated = estimateStudioLayoutBodies(input, { onlyMissing: false });
  assert.deepEqual(reestimated.items[0], lockedParent);
  assert.equal(reestimated.items[1].body.z, 1.28);
  assert.equal(reestimated.items[2].body.z, 1.24);
  assert.equal(reestimated.items[3].body.z, 3.88);
  assertValidLayout(reestimated);
});

test('alignStudioGroupDepth aligns overlapping selected world members from largest to smallest while preserving locked and non-selected items', () => {
  const large = makeItem('char', [200, 200, 600, 900], {
    label: 'character',
    group: 'g1',
    name: 'Hero',
    tags: ['lead'],
    body: { z: 2, thickness: 0.45, yaw: 25, anchor: 'world' },
  });
  const midInFront = makeItem('vest', [250, 300, 450, 600], {
    label: 'object',
    group: 'g1',
    body: { z: 5, thickness: 0.3, yaw: -10, anchor: 'world' },
  });
  const smallOnMid = makeItem('brooch', [280, 350, 340, 410], {
    label: 'object',
    group: 'g1',
    // missing body -> materialized then depth aligned
  });
  const disjoint = makeItem('bag', [750, 700, 850, 850], {
    label: 'object',
    group: 'g1',
    body: { z: 3.5, thickness: 0.6, yaw: 0, anchor: 'world' },
  });
  const unselected = makeItem('other', [260, 320, 360, 420], {
    label: 'object',
    body: { z: 4.5, thickness: 0.6, yaw: 0, anchor: 'world' },
  });

  // Layer order: smallOnMid (index 0, behind midInFront & large), large (index 1), midInFront (index 2, in front of large)
  const input = freeze(makeLayout([smallOnMid, large, midInFront, disjoint, unselected], { width: 1024, height: 1024 }));
  const snapshot = JSON.stringify(input);

  const aligned = alignStudioGroupDepth(input, ['brooch', 'char', 'vest', 'bag']);
  assert.equal(JSON.stringify(input), snapshot);
  const byId = new Map(aligned.items.map((item) => [item.id, item]));

  // large stays z=2
  assert.deepEqual(byId.get('char').body, large.body);
  // midInFront is after large -> 2 * 0.97 = 1.94, preserves thickness 0.3 and yaw -10
  assert.deepEqual(byId.get('vest').body, { z: 1.94, thickness: 0.3, yaw: -10, anchor: 'world' });
  // smallOnMid ('brooch') overlaps both large (area 3600) and midInFront (area 3600) equally -> tie broken by descending area (large first),
  // and smallOnMid is before large -> 2 * 1.03 = 2.06
  assert.equal(byId.get('brooch').body.z, 2.06);
  // disjoint has no overlap -> keeps z=3.5
  assert.deepEqual(byId.get('bag').body, disjoint.body);
  // unselected untouched
  assert.deepEqual(byId.get('other'), unselected);
  assertValidLayout(aligned);
});

test('alignStudioGroupDepth allows locked parent as depth anchor without modifying locked members', () => {
  const lockedAnchor = makeItem('locked-hero', [200, 200, 600, 900], {
    label: 'character',
    locked: true,
    body: { z: 3, thickness: 0.45, yaw: 0, anchor: 'world' },
  });
  const lockedSmall = makeItem('locked-prop', [250, 300, 350, 400], {
    label: 'object',
    locked: true,
    body: { z: 8, thickness: 0.6, yaw: 0, anchor: 'world' },
  });
  const unlockedProp = makeItem('unlocked-prop', [300, 350, 400, 450], {
    label: 'object',
    body: { z: 6, thickness: 0.6, yaw: 12, anchor: 'world' },
  });

  const input = freeze(makeLayout([lockedAnchor, lockedSmall, unlockedProp], { width: 1000, height: 1000 }));
  const aligned = alignStudioGroupDepth(input, ['locked-hero', 'locked-prop', 'unlocked-prop']);
  assert.deepEqual(aligned.items[0], lockedAnchor);
  assert.deepEqual(aligned.items[1], lockedSmall);
  assert.deepEqual(aligned.items[2].body, { z: 2.91, thickness: 0.6, yaw: 12, anchor: 'world' });
});

test('alignStudioGroupDepth does not align equal-area overlapping peers and breaks equal-area strictly-larger parent ties deterministically', () => {
  // Repro from T4-I1: a [100,100,300,300] z=2 and b [120,120,320,320] z=7 both have area 40,000 -> b must remain 7 (not 1.94)
  const peerA = makeItem('a', [100, 100, 300, 300], {
    body: { z: 2, thickness: 0.6, yaw: 270, anchor: 'world' },
  });
  const peerB = makeItem('b', [120, 120, 320, 320], {
    body: { z: 7, thickness: 0.6, yaw: 270, anchor: 'world' },
  });
  const peerLayout = freeze(makeLayout([peerA, peerB], { width: 1024, height: 1024 }));
  const peerAlignedAB = alignStudioGroupDepth(peerLayout, ['a', 'b']);
  const peerAlignedBA = alignStudioGroupDepth(peerLayout, ['b', 'a']);
  assert.equal(peerAlignedAB.items[0].body.z, 2);
  assert.equal(peerAlignedAB.items[1].body.z, 7);
  assert.equal(peerAlignedBA.items[0].body.z, 2);
  assert.equal(peerAlignedBA.items[1].body.z, 7);
  assertValidLayout(peerAlignedAB);

  // Two equal-area holders that are both strictly larger than child: deterministic tie-break by original array index
  const holderFirst = makeItem('holder-1', [100, 100, 500, 500], {
    body: { z: 2, thickness: 0.6, yaw: 0, anchor: 'world' },
  });
  const holderSecond = makeItem('holder-2', [100, 100, 500, 500], {
    body: { z: 5, thickness: 0.6, yaw: 0, anchor: 'world' },
  });
  const smallerChild = makeItem('child', [150, 150, 250, 250], {
    body: { z: 8, thickness: 0.6, yaw: 0, anchor: 'world' },
  });
  const tieLayout = freeze(makeLayout([holderFirst, holderSecond, smallerChild], { width: 1024, height: 1024 }));
  const tieAligned = alignStudioGroupDepth(tieLayout, ['holder-2', 'child', 'holder-1']);
  // holder-1 and holder-2 stay unchanged (equal area peers do not align to each other);
  // child aligns to holder-1 (earlier array index, z=2, child after holder-1 -> 2 * 0.97 = 1.94)
  assert.equal(tieAligned.items[0].body.z, 2);
  assert.equal(tieAligned.items[1].body.z, 5);
  assert.equal(tieAligned.items[2].body.z, 1.94);
  assertValidLayout(tieAligned);
});

test('explicit group alignment allows selected hidden world parent as anchor while unselected hidden or automatic estimation never uses hidden holders', () => {
  const hiddenLockedParent = makeItem('hidden-parent', [100, 100, 600, 900], {
    label: 'character',
    hidden: true,
    locked: true,
    body: { z: 7, thickness: 0.45, yaw: 0, anchor: 'world' },
  });
  const visibleChild = makeItem('visible-child', [200, 300, 300, 400], {
    label: 'object',
    body: { z: 5, thickness: 0.6, yaw: 0, anchor: 'world' },
  });
  const layout = freeze(makeLayout([hiddenLockedParent, visibleChild], { width: 1024, height: 1024 }));

  // 1. When hidden parent is explicitly selected in alignStudioGroupDepth, it anchors visibleChild (7 * 0.97 = 6.79) while locked parent stays byte-for-byte unchanged
  const alignedWithHiddenSelected = alignStudioGroupDepth(layout, ['hidden-parent', 'visible-child']);
  assert.deepEqual(alignedWithHiddenSelected.items[0], hiddenLockedParent);
  assert.equal(alignedWithHiddenSelected.items[1].body.z, 6.79);
  assertValidLayout(alignedWithHiddenSelected);

  // 2. When hidden parent is NOT selected, visibleChild keeps its own depth z=5
  const alignedWithoutHiddenSelected = alignStudioGroupDepth(layout, ['visible-child']);
  assert.deepEqual(alignedWithoutHiddenSelected.items[0], hiddenLockedParent);
  assert.equal(alignedWithoutHiddenSelected.items[1].body.z, 5);
  assertValidLayout(alignedWithoutHiddenSelected);

  // 3. Automatic estimation (estimateStudioBody & estimateStudioLayoutBodies) NEVER uses hidden holders even when present in layout
  const childMissingBody = makeItem('child-missing', [200, 300, 300, 400], { label: 'object' });
  const autoLayout = freeze(makeLayout([hiddenLockedParent, childMissingBody], { width: 1024, height: 1024 }));
  // Aerial independent estimate on 1024x1024 for 100x100 bbox: sqrt(0.18 * 1024 * 1024 / 10000) = 4.34
  assert.equal(estimateStudioBody(childMissingBody, autoLayout).z, 4.34);
  const autoEstimated = estimateStudioLayoutBodies(autoLayout, { onlyMissing: false });
  assert.deepEqual(autoEstimated.items[0], hiddenLockedParent);
  assert.equal(autoEstimated.items[1].body.z, 4.34);
});

test('rejects NaN, nonfinite, zero-area bbox, unknown ids, and runs in a pure browser-like VM realm', async () => {
  const good = makeLayout();
  assert.throws(() => estimateStudioBody(makeItem('bad', [100, 100, 100, 200]), good), errorCode('STUDIO_INVALID_INPUT'));
  assert.throws(() => estimateStudioBody(makeItem('nan', [0, 0, NaN, 200]), good), errorCode('STUDIO_INVALID_INPUT'));
  assert.throws(() => estimateStudioLayoutBodies({ ...good, width: 0 }), errorCode('STUDIO_INVALID_INPUT'));
  assert.throws(() => alignStudioGroupDepth(good, ['missing']), errorCode('STUDIO_ITEM_NOT_FOUND'));

  const source = await readFile(new URL('../src/studio-body.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /studio-domain|node:|process|require/);
  const context = vm.createContext({ TextEncoder, input: JSON.parse(JSON.stringify(good)) });
  const out = vm.runInContext(`${source.replace(/export /g, '')}\nJSON.stringify(estimateStudioLayoutBodies(input));`, context);
  assert.equal(JSON.parse(out).items[0].body.anchor, 'world');
});

test('grouped character attaches to larger same-group member and deterministic array order breaks overlap ties', () => {
  const parentA = makeItem('char-a', [100, 200, 500, 900], {
    label: 'character',
    group: 'team',
    body: { z: 2, thickness: 0.45, yaw: 0, anchor: 'world' },
  });
  const parentB = makeItem('char-b', [100, 200, 500, 900], {
    label: 'character',
    group: 'team',
    body: { z: 4, thickness: 0.45, yaw: 0, anchor: 'world' },
  });
  const childChar = makeItem('pet-char', [200, 400, 300, 550], {
    label: 'character',
    group: 'team',
  });
  const ungroupedSmallChar = makeItem('solo-char', [200, 400, 300, 550], {
    label: 'character',
  });

  // Equal overlap with parentA and parentB -> deterministic array order picks parentA (z=2), child is after parentA -> 2 * 0.97 = 1.94
  const l = freeze(makeLayout([parentA, parentB, childChar, ungroupedSmallChar], { width: 1024, height: 1024 }));
  assert.equal(estimateStudioBody(childChar, l).z, 1.94);

  // Ungrouped character does NOT attach to character parent -> uses independent ground depth
  // hy = 460.8, threshold = 512; bottom = 550 > 512 -> (1024 - 460.8) / (550 - 460.8) = 563.2 / 89.2 = 6.3139 -> 6.31
  assert.equal(estimateStudioBody(ungroupedSmallChar, l).z, 6.31);
});

test('estimateStudioLayoutBodies with onlyMissing false is independent of item array order for mutual or chained overlaps', () => {
  // Small prop overlaps medium object, which overlaps large character;
  // parent depth must come from independent ground estimate (not recursive chain or array order).
  const largeChar = makeItem('hero', [100, 200, 600, 900], { label: 'character' });
  const medShield = makeItem('shield', [200, 350, 450, 750], { label: 'object' });
  const smallGem = makeItem('gem', [250, 420, 320, 500], { label: 'object' });

  // Order 1: hero, shield, gem
  const l1 = freeze(makeLayout([largeChar, medShield, smallGem], { width: 1024, height: 1024 }));
  const res1 = estimateStudioLayoutBodies(l1, { onlyMissing: false });
  // gem overlaps hero (100% of gem area) and shield (100% of gem area);
  // ungrouped object only prefers character -> attaches to hero!
  const heroZ = res1.items[0].body.z; // 1.28
  assert.equal(res1.items[1].body.z, Math.round(heroZ * 0.97 * 100) / 100);
  assert.equal(res1.items[2].body.z, Math.round(heroZ * 0.97 * 100) / 100);

  // Even when all 3 are in the same group ('equip'), shield's own independent ground depth (not its attached depth to hero)
  // is used if shield is evaluated as a candidate, and array order of non-overlapping items never affects estimates.
  const gChar = { ...largeChar, group: 'equip', bbox: [100, 200, 500, 900] };
  const gMount = { ...medShield, group: 'equip', bbox: [520, 300, 880, 900] }; // disjoint from gChar, larger than gGem
  const gGem = { ...smallGem, group: 'equip', bbox: [600, 450, 680, 550] }; // inside gMount, after gMount

  const forwardLayout = freeze(makeLayout([gChar, gMount, gGem], { width: 1024, height: 1024 }));
  const swappedIrrelevant = freeze(makeLayout([gMount, gGem, gChar], { width: 1024, height: 1024 }));
  const estA = estimateStudioLayoutBodies(forwardLayout, { onlyMissing: false });
  const estB = estimateStudioLayoutBodies(swappedIrrelevant, { onlyMissing: false });
  const mapA = new Map(estA.items.map((x) => [x.id, x.body]));
  const mapB = new Map(estB.items.map((x) => [x.id, x.body]));
  assert.deepEqual(mapA.get('gem'), mapB.get('gem'));
  assert.deepEqual(mapA.get('shield'), mapB.get('shield'));
  assert.deepEqual(mapA.get('hero'), mapB.get('hero'));
});

test('preserves valid legacy explicit body yaw (270 / ±360) as detached copy and in onlyMissing/locked layouts; rejects >360 / nonfinite yaw, >128 items, and preserves all item/layout metadata', () => {
  const legacyYaw270 = makeItem('yaw-270', [100, 100, 300, 300], {
    body: { z: 1.5, thickness: 0.5, yaw: 270, anchor: 'world' },
  });
  const legacyYawNeg360 = makeItem('yaw-neg360', [350, 100, 550, 300], {
    locked: true,
    body: { z: 2.2, thickness: 0.45, yaw: -360, anchor: 'world' },
  });
  const legacyYawPos360 = makeItem('yaw-pos360', [600, 100, 800, 300], {
    body: { z: 1.8, thickness: 0.6, yaw: 360, anchor: 'world' },
  });
  const missingItem = makeItem('missing-body', [200, 400, 450, 850], {
    label: 'character',
  });
  const legacyLayout = freeze(makeLayout([legacyYaw270, legacyYawNeg360, legacyYawPos360, missingItem]));
  const legacySnapshot = JSON.stringify(legacyLayout);

  const copied270 = estimateStudioBody(legacyYaw270, legacyLayout);
  assert.deepEqual(copied270, legacyYaw270.body);
  assert.notEqual(copied270, legacyYaw270.body);

  const copiedNeg360 = estimateStudioBody(legacyYawNeg360, legacyLayout);
  assert.deepEqual(copiedNeg360, legacyYawNeg360.body);
  assert.notEqual(copiedNeg360, legacyYawNeg360.body);

  const copiedPos360 = estimateStudioBody(legacyYawPos360, legacyLayout);
  assert.deepEqual(copiedPos360, legacyYawPos360.body);
  assert.notEqual(copiedPos360, legacyYawPos360.body);

  const onlyMissingOut = estimateStudioLayoutBodies(legacyLayout, { onlyMissing: true });
  assert.equal(JSON.stringify(legacyLayout), legacySnapshot);
  assert.deepEqual(onlyMissingOut.items[0].body, legacyYaw270.body);
  assert.notEqual(onlyMissingOut.items[0].body, legacyYaw270.body);
  assert.deepEqual(onlyMissingOut.items[1], legacyYawNeg360);
  assert.deepEqual(onlyMissingOut.items[2].body, legacyYawPos360.body);
  assert.equal(onlyMissingOut.items[3].body.anchor, 'world');
  assertValidLayout(onlyMissingOut);

  const reestimateOut = estimateStudioLayoutBodies(legacyLayout, { onlyMissing: false });
  assert.deepEqual(reestimateOut.items[1], legacyYawNeg360);
  assertValidLayout(reestimateOut);

  const badYawHigh = makeItem('yaw-high', [100, 100, 300, 300], {
    body: { z: 1, thickness: 0.5, yaw: 360.001, anchor: 'world' },
  });
  const badYawLow = makeItem('yaw-low', [100, 100, 300, 300], {
    body: { z: 1, thickness: 0.5, yaw: -360.001, anchor: 'world' },
  });
  const badYawInf = makeItem('yaw-inf', [100, 100, 300, 300], {
    body: { z: 1, thickness: 0.5, yaw: Infinity, anchor: 'world' },
  });
  assert.throws(() => estimateStudioBody(badYawHigh, makeLayout([badYawHigh])), errorCode('STUDIO_INVALID_INPUT'));
  assert.throws(() => estimateStudioBody(badYawLow, makeLayout([badYawLow])), errorCode('STUDIO_INVALID_INPUT'));
  assert.throws(() => estimateStudioBody(badYawInf, makeLayout([badYawInf])), errorCode('STUDIO_INVALID_INPUT'));

  const tooMany = Array.from({ length: 129 }, (_, i) => makeItem(`i-${i}`, [10, 10, 50, 50]));
  assert.throws(() => estimateStudioLayoutBodies(makeLayout(tooMany)), errorCode('STUDIO_INVALID_INPUT'));

  const richItem = makeItem('rich', [200, 300, 500, 850], {
    label: 'character',
    name: 'Alice',
    tags: ['protagonist', 'blue'],
    palette: ['#112233'],
    depth: 'fg',
    color: 42,
    group: 'party',
  });
  const richLayout = freeze(makeLayout([richItem], {
    camera: { enabled: true, orbit: 15, pitch: -5 },
    perspective: { enabled: true, mode: 1, horizon_y: 440 },
    prompt_options: { depth: true, camera: true },
  }));
  const estimated = estimateStudioLayoutBodies(richLayout);
  assert.deepEqual(estimated.camera, richLayout.camera);
  assert.deepEqual(estimated.perspective, richLayout.perspective);
  assert.deepEqual(estimated.prompt_options, richLayout.prompt_options);
  const { body, ...restItem } = estimated.items[0];
  assert.deepEqual(restItem, richItem);
  assertValidLayout(estimated);
});

