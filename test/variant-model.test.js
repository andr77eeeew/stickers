const { test } = require('node:test');
const assert = require('node:assert/strict');
const StatusText = require('../extension/shared/statusText.js');

const modelPromise = import('../frontend/src/lib/variantModel.js');

const KEY = '9ff7f9aed9bb451cac28965b63b36a41';
const cdn = (variant, ext = 'webp') =>
  `https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/tos-alisg-i-dhq7zx4c1p-sg/${KEY}~tplv-dhq7zx4c1p-${variant}.${ext}`;
const sticker = (id, fields) => ({ id: id.repeat(64).slice(0, 64), tags: [], ...fields });

test('asset key and variant come from the capture URL or the imported file name', async () => {
  const { assetOf } = await modelPromise;
  assert.deepEqual(assetOf(sticker('a', { originalUrl: cdn('video2sticker-mid') })), { key: KEY, variant: 'video2sticker-mid' });
  assert.deepEqual(
    assetOf(sticker('b', { originalUrl: null, tags: [`import:${KEY}~tplv-dhq7zx4c1p-photo-comment-full.webp`] })),
    { key: KEY, variant: 'photo-comment-full' }
  );
  assert.equal(assetOf(sticker('c', { tags: ['import:sticker_1234.webp'] })), null);
  assert.equal(assetOf(sticker('d', { originalUrl: 'not a url' })), null);
});

test('the larger capture of the same sticker is suggested, never the smaller one', async () => {
  const { indexVariants, betterVariant } = await modelPromise;
  const mid = sticker('a', { originalUrl: cdn('video2sticker-mid'), width: 240, height: 240, capturedAt: '2026-09-27T10:00:00Z' });
  const full = sticker('b', { originalUrl: cdn('video2sticker-full'), width: 512, height: 512, capturedAt: '2026-09-27T09:00:00Z' });
  const other = sticker('c', { originalUrl: cdn('video2sticker-mid').replace(KEY, 'f'.repeat(32)), width: 240, height: 240 });
  const stickers = [mid, full, other];
  const byId = new Map(stickers.map((item) => [item.id, item]));
  const index = indexVariants(stickers);

  assert.equal(index.has(other.id), false, 'a single capture has no variants');
  assert.equal(index.get(mid.id).bestId, full.id);
  assert.deepEqual(index.get(full.id).siblingIds, [mid.id]);
  assert.equal(betterVariant(mid, index, byId), full);
  assert.equal(betterVariant(full, index, byId), null);

  const sameSize = sticker('d', { originalUrl: cdn('full'), width: 240, height: 240 });
  const tieIndex = indexVariants([mid, sameSize]);
  const tieById = new Map([[mid.id, mid], [sameSize.id, sameSize]]);
  assert.equal(betterVariant(mid, tieIndex, tieById), null);
  assert.equal(betterVariant(sameSize, tieIndex, tieById), null, 'equal size is not "better"');
});

test('feed rows and Network log summaries read plainly', () => {
  assert.deepEqual(StatusText.describeFeedItem({ state: 'new' }), { tone: 'ok', text: 'Added to library' });
  assert.equal(StatusText.describeFeedItem({ state: 'duplicate' }).text, 'Already in library');
  assert.equal(StatusText.describeFeedItem({ state: 'queued', reason: 'capture_budget_exhausted' }).text, 'Delivering · capture budget paused');
  assert.equal(StatusText.describeFeedItem({ state: 'held', reason: 'bad body' }).tone, 'problem');
  assert.equal(StatusText.describeFeedItem({ state: 'rejected', reason: 'content_type_mismatch' }).text, 'Rejected: not a sticker image');

  assert.match(StatusText.describeLogSummary({ stickers: 0 }), /No sticker responses/);
  assert.equal(
    StatusText.describeLogSummary({ stickers: 3, queued: 1, known: 2, already: 0, held: 0, skipped: 0 }),
    'Found 3 sticker responses: 1 sent to the library, 2 already in library.'
  );
});
