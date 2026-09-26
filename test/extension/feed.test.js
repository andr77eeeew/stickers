'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  WEBP_BYTES,
  capturePayload,
  extensionRoot,
  finishedRequest,
  loadBackground,
  loadDevtools,
  settle
} = require('../helpers/extensionHarness');
const CapturePipeline = require('../../extension/shared/capturePipeline.js');
const StickerPolicy = require('../../extension/shared/stickerPolicy.js');

const INGEST_URL = 'http://127.0.0.1:3001/api/ingest';
const SERVER_STICKER_ID = 'c'.repeat(64);
const THUMBNAIL = 'data:image/webp;base64,UklGRgAAAABXRUJQ';
const policy = StickerPolicy.validatePolicy(JSON.parse(
  fs.readFileSync(path.join(extensionRoot, 'shared', 'sticker-policy.json'), 'utf8')
));

const ingestCalls = (harness) => harness.network.calls.filter(({ url }) => url === INGEST_URL);
const acceptWithId = () => ({
  status: 200,
  body: { success: true, duplicate: false, sticker: { id: SERVER_STICKER_ID } }
});

test('session feed follows a capture from queue to library with its thumbnail', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = acceptWithId;
  await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    origin: 'network_log',
    thumbnail: THUMBNAIL,
    payload: capturePayload()
  });

  const feed = await harness.send({ type: 'GET_FEED' });
  assert.equal(feed.serverUrl, 'http://127.0.0.1:3001');
  assert.equal(feed.items.length, 1);
  const [item] = feed.items;
  assert.equal(item.state, 'new');
  assert.equal(item.stickerId, SERVER_STICKER_ID);
  assert.equal(item.origin, 'network_log');
  assert.equal(item.thumbnail, THUMBNAIL);
  assert.equal(item.mimeType, 'image/webp');
  assert.equal(item.byteLength, WEBP_BYTES.length);
  assert.equal('payload' in item || 'contentBase64' in item, false, 'feed keeps no sticker bytes');
  assert.equal(JSON.stringify(harness.server.ingest[0].body).includes('thumbnail'), false, 'thumbnail never goes to the server');
  assert.ok(harness.sessionStore.captureFeed, 'feed lives in session storage');
  assert.equal('captureFeed' in harness.store, false, 'feed is not persisted to local storage');
});

test('a sticker the server already acknowledged is not sent again', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = acceptWithId;
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });
  const again = await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });

  assert.equal(again.known, true);
  assert.equal(again.stickerId, SERVER_STICKER_ID);
  assert.equal(ingestCalls(harness).length, 1);
  const { items } = await harness.send({ type: 'GET_FEED' });
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'duplicate');

  harness.chrome.storage.local.set({ ingestToken: 'new-token' });
  await settle();
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });
  assert.equal(ingestCalls(harness).length, 2, 'a new token forgets what the old server knew');
});

test('feed reports held captures and discards, and drops unsafe thumbnails', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = () => ({ status: 422, body: { error: 'bad body' } });
  await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    thumbnail: 'javascript:alert(1)',
    payload: capturePayload()
  });

  let { items } = await harness.send({ type: 'GET_FEED' });
  assert.equal(items[0].state, 'held');
  assert.equal(items[0].reason, 'bad body');
  assert.equal(items[0].thumbnail, null);

  await harness.sendAndSettle({ type: 'DISCARD_ITEM', id: items[0].id });
  ({ items } = await harness.send({ type: 'GET_FEED' }));
  assert.equal(items[0].state, 'discarded');

  await harness.sendAndSettle({ type: 'CLEAR_FEED' });
  assert.equal((await harness.send({ type: 'GET_FEED' })).items.length, 0);
});

test('rejected payloads appear in the feed with the reason', async () => {
  const harness = await loadBackground();
  await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    payload: capturePayload({ contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64') })
  });
  const { items } = await harness.send({ type: 'GET_FEED' });
  assert.equal(items[0].state, 'rejected');
  assert.equal(items[0].reason, 'content_type_mismatch');
});

test('policy near-misses are counted locally with a few masked examples', async () => {
  const harness = await loadBackground();
  for (let index = 0; index < 5; index += 1) {
    await harness.sendAndSettle({
      type: 'CAPTURE_DIAGNOSTIC',
      reason: 'path_not_sticker_specific',
      pattern: `p16-*.ibyteimg.com/obj/new-format/<id>-${index}.webp`
    });
  }
  await harness.sendAndSettle({ type: 'CAPTURE_DIAGNOSTIC', reason: '<script>', pattern: 'x' });
  const { diagnostics } = await harness.send({ type: 'GET_FEED' });
  assert.equal(diagnostics.path_not_sticker_specific.count, 5);
  assert.equal(diagnostics.path_not_sticker_specific.examples.length, 3);
  assert.equal(diagnostics.unknown.count, 1);
});

test('near-miss patterns mask IDs and ignore non-TikTok or non-image traffic', () => {
  const avatar = CapturePipeline.describeNearMiss(
    'https://p16-common-sign-va.tiktokcdn.com/tos-maliva-avt-0068/52ccdb3a692e329d7ce0e8a2efb7945b~tplv-tiktokx-cropcenter:168:168.jpeg?x-expires=1790000000&sig=abc',
    'image/jpeg',
    'rejected_path',
    policy
  );
  assert.equal(avatar.reason, 'rejected_path');
  assert.equal(avatar.pattern.includes('52ccdb3a692e329d7ce0e8a2efb7945b'), false);
  assert.equal(avatar.pattern.includes('sig='), false, 'query is never kept');
  assert.match(avatar.pattern, /<id>~tplv-tiktokx-cropcenter/);

  assert.equal(
    CapturePipeline.describeNearMiss('https://example.com/a.webp', 'image/webp', 'host_not_allowed', policy),
    null
  );
  assert.equal(
    CapturePipeline.describeNearMiss('https://www.tiktokv.com/api/im/list', 'application/json', 'host_not_allowed', policy),
    null
  );
});

test('live listener reports TikTok-CDN near-misses without reading their bodies', async () => {
  const harness = await loadDevtools();
  const avatar = finishedRequest({
    url: 'https://p16-common-sign.tiktokcdn.com/tos-maliva-avt-0068/id~tplv-tiktokx-cropcenter:168:168.webp',
    mimeType: 'image/webp'
  });
  await harness.finish(avatar);
  assert.equal(avatar.getContentCalls, 0);
  const diagnostic = harness.messages.find(({ type }) => type === 'CAPTURE_DIAGNOSTIC');
  assert.equal(diagnostic.reason, 'rejected_path');
});

test('Network log capture runs entries through the same pipeline and summarizes them', async () => {
  const sent = [];
  const replies = [{ ok: true, queued: true }, { ok: true, known: true }, { ok: true, duplicateQueued: true }];
  const pipeline = CapturePipeline.createPipeline({
    policy,
    origin: 'network_log',
    lastError: () => null,
    send: async (message) => {
      sent.push(message);
      return message.type === 'QUEUE_CAPTURE' ? replies.shift() : { ok: true };
    }
  });
  const entries = [
    finishedRequest(),
    finishedRequest({ url: 'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/b.webp' }),
    finishedRequest({ url: 'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/c.webp' }),
    finishedRequest({ url: 'https://www.tiktok.com/api/im/message/list', mimeType: 'application/json', body: Buffer.from('{}') }),
    finishedRequest({ url: 'https://p16-common-sign.tiktokcdn.com/tos-maliva-avt-0068/id~tplv-tiktokx-cropcenter:1:1.webp' })
  ];
  const outcomes = [];
  for (const entry of entries) outcomes.push(await pipeline.processEntry(entry));

  assert.deepEqual(CapturePipeline.summarize(outcomes), {
    total: 5, stickers: 3, queued: 1, known: 1, already: 1, held: 0, skipped: 0, nearMiss: 1
  });
  const queued = sent.filter(({ type }) => type === 'QUEUE_CAPTURE');
  assert.equal(queued.length, 3);
  assert.ok(queued.every((message) => message.origin === 'network_log'));
  assert.equal(entries[3].getContentCalls, 0, 'DM API bodies are never read');
});

test('HAR entries without getContent are skipped, not refetched', async () => {
  const pipeline = CapturePipeline.createPipeline({
    policy,
    origin: 'network_log',
    lastError: () => null,
    send: async () => ({ ok: true })
  });
  const entry = finishedRequest();
  delete entry.getContent;
  assert.deepEqual(await pipeline.processEntry(entry), { outcome: 'skipped', reason: 'get_content_failed' });
});
