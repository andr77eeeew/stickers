const { test } = require('node:test');
const assert = require('node:assert/strict');

const packModelPromise = import('../frontend/src/lib/packModel.js');
const stickerModelPromise = import('../frontend/src/lib/stickerModel.js');

const idOf = (char) => char.repeat(64);
const ready = (char, overrides = {}) => ({
  id: idOf(char), isAnimated: false, status: 'converted', convertedPath: `/statics/x/${char}.webp`, outputSizeBytes: 1000, ...overrides
});

test('client emoji parsing matches the server rules', async () => {
  const { parseEmojiInput } = await packModelPromise;
  assert.deepEqual(parseEmojiInput('😀, 🎉 😀'), { emoji: ['😀', '🎉'], error: null });
  assert.deepEqual(parseEmojiInput('👨‍👩‍👧 🇺🇦').emoji, ['👨‍👩‍👧', '🇺🇦']);
  assert.match(parseEmojiInput('hi').error, /not an emoji/);
  assert.match(parseEmojiInput('😀'.repeat(1) + '😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗🤩').error, /at most 20/);
});

test('pack summary explains exactly what blocks the export', async () => {
  const { summarizePack, getItemProblems, canAddToPack } = await packModelPromise;
  const stickers = new Map([
    [idOf('a'), ready('a')],
    [idOf('b'), ready('b', { status: 'captured', convertedPath: null })],
    [idOf('c'), ready('c', { isAnimated: true })]
  ]);

  const empty = summarizePack({ items: [] }, stickers);
  assert.equal(empty.kind, null);
  assert.match(empty.exportBlockedReason, /Add stickers/);

  const pack = { id: 'p_1', items: [{ stickerId: idOf('a'), emoji: ['😀'] }, { stickerId: idOf('b'), emoji: [] }] };
  const summary = summarizePack(pack, stickers);
  assert.equal(summary.kind, 'static');
  assert.equal(summary.missingEmoji, 1);
  assert.equal(summary.notReady, 1);
  assert.equal(summary.exportBlockedReason, '1 sticker without emoji.');
  assert.deepEqual(getItemProblems(pack.items[1], stickers.get(idOf('b'))).map((problem) => problem.label), ['No emoji', 'Not converted']);
  assert.deepEqual(getItemProblems({ stickerId: idOf('z'), emoji: ['😀'] }, undefined).map((problem) => problem.code), ['missing']);

  const done = summarizePack({ items: [{ stickerId: idOf('a'), emoji: ['😀'] }] }, stickers);
  assert.equal(done.exportBlockedReason, null);

  assert.deepEqual(canAddToPack(pack, stickers.get(idOf('c')), stickers).ok, false);
  assert.match(canAddToPack(pack, stickers.get(idOf('c')), stickers).reason, /static pack/);
  assert.equal(canAddToPack(pack, stickers.get(idOf('a')), stickers).reason, 'Already in this pack.');
  assert.equal(canAddToPack({ items: [] }, stickers.get(idOf('c')), stickers).ok, true);
});

test('membership marks the current pack and moveItem reorders safely', async () => {
  const { getMembership, moveItem } = await packModelPromise;
  const packs = [
    { id: 'p_a', title: 'A', items: [{ stickerId: 'x', emoji: ['😀'] }] },
    { id: 'p_b', title: 'B', items: [{ stickerId: 'x', emoji: ['🎉'] }, { stickerId: 'y', emoji: [] }] }
  ];
  const membership = getMembership(packs, 'p_b');
  assert.deepEqual(membership.get('x'), { emoji: ['🎉'], inActive: true, packs: [{ id: 'p_a', title: 'A' }, { id: 'p_b', title: 'B' }] });
  assert.equal(getMembership(packs, 'p_a').get('y').inActive, false);

  assert.deepEqual(moveItem([1, 2, 3, 4], 0, 2), [2, 3, 1, 4]);
  assert.deepEqual(moveItem([1, 2, 3], 2, 0), [3, 1, 2]);
  const same = [1, 2];
  assert.equal(moveItem(same, 0, 5), same, 'out of range is a no-op');
});

test('packs view and the not-in-a-pack filter live in the URL and in the counts', async () => {
  const { parseViewState, buildViewSearch, VIEW_DEFAULTS, selectCatalogue } = await stickerModelPromise;
  const state = { ...VIEW_DEFAULTS, view: 'packs', pack: 'p_0123456789ab' };
  assert.equal(buildViewSearch(state), 'view=packs&pack=p_0123456789ab');
  assert.deepEqual(parseViewState(`?${buildViewSearch(state)}`), state);
  assert.equal(parseViewState('?unpacked=1').unpacked, true);
  assert.equal(buildViewSearch({ ...VIEW_DEFAULTS, unpacked: true }), 'unpacked=1');
  assert.equal(parseViewState('?pack=../x').pack, null);

  const stickers = [ready('a'), ready('b'), ready('c', { isAnimated: true })];
  const packedIds = new Set([idOf('a')]);
  const catalogue = selectCatalogue(stickers, { unpacked: true, packedIds });
  assert.deepEqual(catalogue.items.map((sticker) => sticker.id).sort(), [idOf('b'), idOf('c')]);
  assert.equal(catalogue.counts.all, 2);
  assert.equal(catalogue.counts.static, 1);
  assert.equal(selectCatalogue(stickers, { unpacked: false, packedIds }).total, 3);
});
