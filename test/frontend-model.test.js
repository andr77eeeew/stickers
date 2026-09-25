const { test } = require('node:test');
const assert = require('node:assert/strict');

const modelPromise = import('../frontend/src/lib/stickerModel.js');

test('library selector preserves type and tag search, visible limit, and date grouping', async () => {
  const { selectLibrary } = await modelPromise;
  const stickers = [
    { id: 'a', originalFilename: 'cat.png', tags: ['pet'], isAnimated: false, capturedDate: '2026-09-20' },
    { id: 'b', originalFilename: 'wave.gif', tags: ['hello'], isAnimated: true, capturedDate: '2026-09-21' },
    { id: 'c', originalFilename: 'dog.png', tags: ['pet'], isAnimated: false, capturedDate: '2026-09-21' }
  ];

  const all = selectLibrary(stickers, 'all', '', 2);
  assert.equal(all.totalCount, 3);
  assert.equal(all.staticCount, 2);
  assert.equal(all.animatedCount, 1);
  assert.deepEqual(all.sortedDates, ['2026-09-21', '2026-09-20']);
  assert.deepEqual(all.stickersByDate['2026-09-21'].map((item) => item.id), ['b']);

  const filtered = selectLibrary(stickers, 'static', 'PET', 48);
  assert.deepEqual(filtered.filteredStickers.map((item) => item.id), ['a', 'c']);
});

test('media paths and saved animated range retain existing semantics', async () => {
  const { normalizeMediaPath, getOriginalPath, getPersistedRange, getStickerDuration } = await modelPromise;
  assert.equal(normalizeMediaPath('output\\statics\\sticker.webp'), '/output/statics/sticker.webp');
  assert.equal(getOriginalPath({ capturedDate: '2026-09-24', originalFilename: 'image.png' }), '/captured/2026-09-24/image.png');
  assert.deepEqual(getPersistedRange({ selectedRange: { start: 0.5, duration: 3 } }), { start: 0.5, end: 3.5 });
  assert.equal(getStickerDuration({ isAnimated: true, frameDelays: [100, 200, 300] }), 0.6);
});

test('server-reported storage paths and issue counts remain authoritative', async () => {
  const { getOutputPath, countStorageIssues } = await modelPromise;
  assert.equal(getOutputPath('root', {}, { paths: { root: 'D:\\safe\\output' } }), 'D:\\safe\\output');
  assert.equal(getOutputPath('statics', {}, {}), 'output/statics/');
  assert.equal(countStorageIssues({ missingOriginals: 1, missingConverted: ['a', 'b'], orphanFiles: 2 }), 5);
});
