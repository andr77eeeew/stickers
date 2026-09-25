const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCatalogueFixture, makeStageFixture } = require('./fixtures/redesign');

const modelPromise = import('../frontend/src/lib/stickerModel.js');

const KB = 1024;

test('sticker state combines server status with measured output facts', async () => {
  const { getStickerState, needsAction } = await modelPromise;
  const converted = { status: 'converted', convertedPath: '/statics/a.webp', isAnimated: false };
  assert.equal(getStickerState({ ...converted, outputSizeBytes: 40 * KB }), 'ready');
  assert.equal(getStickerState({ ...converted, outputSizeBytes: null }), 'output_missing');
  assert.equal(getStickerState({ ...converted, outputSizeBytes: 40 * KB, health: ['missing_converted'] }), 'output_missing');
  assert.equal(getStickerState({ ...converted, outputSizeBytes: 600 * KB }), 'over_limit');
  assert.equal(getStickerState({ ...converted, isAnimated: true, outputSizeBytes: 300 * KB }), 'over_limit');
  assert.equal(getStickerState({ ...converted }), 'unmeasured');
  assert.equal(getStickerState({ ...converted, convertedSizeBytes: 10 * KB }), 'ready');
  assert.equal(getStickerState({ status: 'captured' }), 'captured');
  assert.equal(getStickerState({ status: 'failed' }), 'failed');
  assert.equal(getStickerState({ status: 'converting' }), 'converting');
  assert.equal(needsAction({ status: 'captured' }), true);
  assert.equal(needsAction({ status: 'converting' }), false);
  assert.equal(needsAction({ ...converted, outputSizeBytes: 40 * KB }), false);
});

test('catalogue selector filters, facets, sorts and paginates from one snapshot', async () => {
  const { selectCatalogue } = await modelPromise;
  const stickers = [
    { id: 'a1', status: 'converted', convertedPath: '/s/a', outputSizeBytes: 10 * KB, isAnimated: false, capturedAt: '2026-09-01T00:00:00Z', tags: ['import:cat.png'] },
    { id: 'b2', status: 'converted', convertedPath: '/a/b', outputSizeBytes: 200 * KB, isAnimated: true, capturedAt: '2026-09-03T00:00:00Z', tags: ['pet'] },
    { id: 'c3', status: 'failed', isAnimated: true, capturedAt: '2026-09-02T00:00:00Z', tags: [] },
    { id: 'd4', status: 'captured', isAnimated: false, capturedAt: '2026-09-04T00:00:00Z', tags: [] }
  ];

  const all = selectCatalogue(stickers);
  assert.deepEqual(all.items.map((item) => item.id), ['d4', 'b2', 'c3', 'a1']);
  assert.deepEqual(
    { all: all.counts.all, ready: all.counts.ready, action: all.counts.action, static: all.counts.static, animated: all.counts.animated },
    { all: 4, ready: 2, action: 2, static: 2, animated: 2 }
  );

  const animatedAction = selectCatalogue(stickers, { type: 'animated', status: 'action' });
  assert.deepEqual(animatedAction.items.map((item) => item.id), ['c3']);
  assert.equal(animatedAction.counts.all, 2, 'status counts respect the type filter');
  assert.equal(animatedAction.counts.static, 1, 'type counts respect the status filter');

  assert.deepEqual(selectCatalogue(stickers, { q: 'CAT.PNG' }).items.map((item) => item.id), ['a1'], 'import name is searchable');
  assert.deepEqual(selectCatalogue(stickers, { q: 'pet' }).items.map((item) => item.id), ['b2']);
  assert.deepEqual(selectCatalogue(stickers, { sort: 'oldest' }).items.map((item) => item.id), ['a1', 'c3', 'b2', 'd4']);
  assert.deepEqual(selectCatalogue(stickers, { sort: 'largest' }).items.map((item) => item.id), ['b2', 'a1', 'c3', 'd4']);

  const paged = selectCatalogue(stickers, { pageSize: 3, page: 9 });
  assert.equal(paged.page, 2, 'page is clamped to the last page');
  assert.equal(paged.pageCount, 2);
  assert.deepEqual(paged.items.map((item) => item.id), ['a1']);
});

test('the 1000-item fixture never renders more than one page', async () => {
  const { selectCatalogue, PAGE_SIZE } = await modelPromise;
  const catalogue = selectCatalogue(makeCatalogueFixture(), { page: 3 });
  assert.equal(catalogue.items.length, PAGE_SIZE);
  assert.equal(catalogue.total, 1000);
  assert.equal(catalogue.pageCount, Math.ceil(1000 / PAGE_SIZE));
});

test('attention summary counts every kind of pending work separately', async () => {
  const { summarizeAttention } = await modelPromise;
  const summary = summarizeAttention(makeStageFixture());
  assert.equal(summary.captured, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.outputMissing, 1);
  assert.equal(summary.total, 4);
});

test('telegram check reports only what the data proves', async () => {
  const { getTelegramCheck } = await modelPromise;
  const byKey = (rows) => Object.fromEntries(rows.map((row) => [row.key, row]));

  const legacy = byKey(getTelegramCheck({
    status: 'converted', isAnimated: true, convertedPath: '/animated/x.webm', convertedFilename: 'x.webm',
    outputSizeBytes: 240 * KB, width: 240, height: 240
  }));
  assert.equal(legacy.format.tone, 'ok');
  assert.equal(legacy.size.tone, 'warning', '> 90 % of the 256 KB limit');
  assert.equal(legacy.duration.tone, 'unknown');
  assert.equal(legacy.dimensions.tone, 'unknown');
  assert.equal(legacy.source.tone, 'warning');
  assert.match(legacy.source.note, /Upscaled 2\.1×/);

  const current = byKey(getTelegramCheck({
    status: 'converted', isAnimated: true, convertedPath: '/animated/y.webm', outputSizeBytes: 100 * KB,
    width: 512, height: 512, conversion: { durationMs: 2400 }
  }));
  assert.equal(current.duration.value, '2.4 s / 3.0 s');
  assert.equal(current.duration.tone, 'ok');
  assert.equal(current.dimensions.tone, 'ok');
  assert.equal(current.source.tone, 'ok');

  const failed = byKey(getTelegramCheck({
    status: 'failed', error: 'ffmpeg failed reading D:\\Projects\\stickers\\output\\x.webp', health: ['missing_original']
  }));
  assert.equal(failed.original.tone, 'problem');
  assert.equal(failed.conversion.tone, 'problem');
  assert.doesNotMatch(failed.conversion.note, /Projects/, 'absolute paths are hidden');
});

test('user tags exclude system import tags', async () => {
  const { getUserTags, getSystemTags, getImportName } = await modelPromise;
  const sticker = { tags: ['import:photo.jpg', 'cat'] };
  assert.deepEqual(getUserTags(sticker), ['cat']);
  assert.deepEqual(getSystemTags(sticker), ['import:photo.jpg']);
  assert.equal(getImportName(sticker), 'photo.jpg');
});

test('view state round-trips through the query string and rejects unknown values', async () => {
  const { parseViewState, buildViewSearch, VIEW_DEFAULTS } = await modelPromise;
  assert.deepEqual(parseViewState(''), VIEW_DEFAULTS);
  assert.equal(buildViewSearch(VIEW_DEFAULTS), '');

  const state = { ...VIEW_DEFAULTS, q: 'cat', type: 'animated', status: 'action', sort: 'largest', page: 3, id: 'abcdef12' };
  assert.deepEqual(parseViewState(`?${buildViewSearch(state)}`), state);

  const hostile = parseViewState('?view=admin&type=gif&page=-4&id=../../etc');
  assert.equal(hostile.view, 'library');
  assert.equal(hostile.type, 'all');
  assert.equal(hostile.page, 1);
  assert.equal(hostile.id, null);
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
  assert.equal(getOutputPath('archives', { archives: 'D:\\safe\\archives' }, {}), 'D:\\safe\\archives');
  assert.equal(countStorageIssues({ missingOriginals: 1, missingConverted: ['a', 'b'], orphanFiles: 2 }), 5);
});
