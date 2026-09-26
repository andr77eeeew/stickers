'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  READY_STORAGE,
  capturePayload,
  finishedRequest,
  loadBackground,
  loadDevtools
} = require('../helpers/extensionHarness');

const INGEST_URL = 'http://127.0.0.1:3001/api/ingest';

function ingestCalls(harness) {
  return harness.network.calls.filter(({ url }) => url === INGEST_URL);
}

function onlyRecord(harness) {
  const records = [...harness.queue.records.values()];
  assert.equal(records.length, 1);
  return records[0];
}

test('accepted capture is delivered once to loopback and leaves the queue', async () => {
  const harness = await loadBackground();
  const response = await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    payload: capturePayload()
  });

  assert.equal(response.ok, true);
  assert.equal(response.queued, true);
  assert.equal(ingestCalls(harness).length, 1);

  const [delivery] = harness.server.ingest;
  assert.equal(delivery.headers.Authorization, 'Bearer test-ingest-token');
  assert.deepEqual(Object.keys(delivery.body).sort(), [
    'contentBase64',
    'mimeType',
    'observedAt',
    'source',
    'sourceUrl'
  ]);
  assert.equal(delivery.body.sourceUrl.includes('?'), false);
  assert.equal(JSON.stringify(delivery.body).includes('test-ingest-token'), false);

  const { options } = ingestCalls(harness)[0];
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');

  const status = await harness.status();
  assert.equal(harness.queue.records.size, 0);
  assert.equal(status.serverState, 'online');
  assert.equal(status.counters.delivered, 1);
  assert.equal(harness.badge.text, '');
  assert.deepEqual(harness.network.violations, []);
});

test('rejects payloads outside the sticker policy before queueing', async () => {
  const harness = await loadBackground();
  const avatar = await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    payload: capturePayload({
      sourceUrl:
        'https://p16-common-sign.tiktokcdn.com/tos-maliva-avt-0068/id~tplv-tiktokx-cropcenter:168:168.webp'
    })
  });
  const wrongBytes = await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    payload: capturePayload({
      contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64')
    })
  });

  assert.equal(avatar.ok, false);
  assert.equal(avatar.reason, 'rejected_path');
  assert.equal(wrongBytes.reason, 'content_type_mismatch');
  assert.equal(harness.queue.records.size, 0);
  assert.equal(ingestCalls(harness).length, 0);
});

test('keeps one queue entry per content hash while delivery is failing', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = () => ({ status: 503, body: { error: 'busy' } });

  const first = await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    payload: capturePayload()
  });
  const second = await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    payload: capturePayload({ observedAt: '2026-09-26T12:01:00.000Z' })
  });

  assert.equal(first.queued, true);
  assert.equal(second.duplicateQueued, true);
  const record = onlyRecord(harness);
  assert.equal(record.state, 'pending');
  assert.equal(record.attempts, 1);
  assert.ok(record.nextAttemptAt > Date.now());
  assert.equal(harness.alarms.has('capture-queue-retry'), true);
  assert.equal((await harness.status()).serverState, 'offline');
});

test('unreachable server keeps the payload for a later local retry', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = () => {
    throw new TypeError('Failed to fetch');
  };
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });

  const record = onlyRecord(harness);
  assert.equal(record.state, 'pending');
  assert.equal(record.lastError, 'local_server_unreachable');

  harness.server.onIngest = () => ({ status: 200, body: { success: true } });
  record.nextAttemptAt = 0;
  harness.queue.records.set(record.id, record);
  await harness.fireAlarm('capture-queue-retry');
  assert.equal(harness.queue.records.size, 0);
});

test('client errors block the item until the user releases it', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = () => ({ status: 422, body: { error: 'bad body' } });
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });

  assert.equal(onlyRecord(harness).state, 'blocked');
  assert.equal(harness.badge.text, '!');

  await harness.fireAlarm('capture-queue-periodic');
  assert.equal(ingestCalls(harness).length, 1, 'blocked items are not retried by alarms');

  harness.server.onIngest = () => ({ status: 200, body: { success: true, duplicate: true } });
  const status = await harness.sendAndSettle({ type: 'RETRY_QUEUE' });
  assert.equal(status.ok, true);
  assert.equal(harness.queue.records.size, 0);
  assert.equal((await harness.status()).counters.duplicates, 1);
});

test('missing token holds deliveries without contacting the server', async () => {
  const harness = await loadBackground({
    storage: { ...READY_STORAGE, ingestToken: '' }
  });
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });

  assert.equal(ingestCalls(harness).length, 0);
  assert.equal(onlyRecord(harness).state, 'pending');
  const status = await harness.status();
  assert.equal(status.serverState, 'configuration_required');
  assert.equal(status.hasToken, false);
});

test('first run generates a token but keeps capture disabled', async () => {
  const harness = await loadBackground({ storage: {} });
  for (const listener of harness.listeners.installed) listener({ reason: 'install' });
  await new Promise((resolve) => setImmediate(resolve));
  const status = await harness.status();

  assert.equal(status.captureEnabled, false);
  assert.equal(status.hasToken, true);
  assert.ok(harness.store.ingestToken.length >= 40);
  assert.equal(harness.badge.text, 'OFF');
});

test('status never exposes the ingest token', async () => {
  const harness = await loadBackground();
  const status = await harness.status();
  assert.equal(JSON.stringify(status).includes(READY_STORAGE.ingestToken), false);
});

test('DevTools listener reads bodies only for sticker responses', async () => {
  const harness = await loadDevtools();
  const dmApi = finishedRequest({
    url: 'https://www.tiktok.com/api/im/message/list?cursor=1',
    mimeType: 'application/json',
    body: Buffer.from('{"messages":["private"]}')
  });
  const avatar = finishedRequest({
    url: 'https://p16-common-sign.tiktokcdn.com/tos-maliva-avt-0068/id~tplv-tiktokx-cropcenter:168:168.webp',
    mimeType: 'image/webp'
  });
  const failed = finishedRequest({ status: 404 });
  const sticker = finishedRequest();

  for (const entry of [dmApi, avatar, failed, sticker]) await harness.finish(entry);

  assert.equal(dmApi.getContentCalls, 0);
  assert.equal(avatar.getContentCalls, 0);
  assert.equal(failed.getContentCalls, 0);
  assert.equal(sticker.getContentCalls, 1);

  const queued = harness.messages.filter(({ type }) => type === 'QUEUE_CAPTURE');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.sourceUrl.includes('?'), false);
  assert.equal(JSON.stringify(queued[0]).includes('sid=secret'), false);
  assert.deepEqual(harness.network.violations, []);
});

test('DevTools listener ignores traffic while capture is disabled', async () => {
  const harness = await loadDevtools({ storage: { captureEnabled: false } });
  const sticker = finishedRequest();
  await harness.finish(sticker);

  assert.equal(sticker.getContentCalls, 0);
  assert.equal(harness.messages.some(({ type }) => type === 'QUEUE_CAPTURE'), false);
});

// Contracts for known defects (docs/extension/PLAN.md §2). They are marked
// todo until stage E1 fixes them; remove the todo option together with the fix.

test(
  'B1: heartbeat does not overwrite the last meaningful event',
  { todo: 'E1: heartbeat must update only lastHeartbeatAt' },
  async () => {
    const harness = await loadBackground();
    await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });
    assert.match((await harness.status()).lastEvent, /accepted/i);

    await harness.sendAndSettle({ type: 'DEVTOOLS_HEARTBEAT' });
    assert.match((await harness.status()).lastEvent, /accepted/i);
  }
);

test(
  'B2: exhausted capture budget pauses delivery instead of reporting offline',
  { todo: 'E1: 429 budgetExhausted must pause the queue without retries' },
  async () => {
    const harness = await loadBackground();
    harness.server.onIngest = () => ({
      status: 429,
      headers: { 'Retry-After': '60' },
      body: {
        error: 'Session budget exhausted: session_capture_limit.',
        budgetExhausted: true,
        session: { exhausted: true, exhaustReason: 'session_capture_limit' }
      }
    });
    await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });

    const status = await harness.status();
    assert.notEqual(status.serverState, 'offline');
    assert.match(`${status.lastEvent} ${status.lastError}`, /budget/i);
    assert.equal(harness.queue.records.size, 1, 'payload is kept');

    const record = onlyRecord(harness);
    record.nextAttemptAt = 0;
    harness.queue.records.set(record.id, record);
    await harness.fireAlarm('capture-queue-periodic');
    assert.equal(ingestCalls(harness).length, 1, 'paused items are not retried by alarms');
  }
);

test(
  'B9: rejected token is reported as unauthorized, not offline',
  { todo: 'E1: classify auth failures by HTTP status, not by the reason text' },
  async () => {
    const harness = await loadBackground();
    // lib/localSecurity.js always sends an error text with 401.
    harness.server.onIngest = () => ({
      status: 401,
      body: { error: 'Invalid or missing bearer token.' }
    });
    await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });

    assert.equal(onlyRecord(harness).state, 'blocked');
    assert.equal((await harness.status()).serverState, 'unauthorized');
  }
);

test(
  'B3: sticker type is taken from bytes, not the Content-Type header',
  { todo: 'E1: classify by URL, detect type by magic bytes' },
  async () => {
    const harness = await loadDevtools();
    const awebp = finishedRequest({ mimeType: 'image/awebp' });
    const octet = finishedRequest({
      url: 'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/other.webp',
      mimeType: 'application/octet-stream'
    });
    await harness.finish(awebp);
    await harness.finish(octet);

    const queued = harness.messages.filter(({ type }) => type === 'QUEUE_CAPTURE');
    assert.equal(queued.length, 2);
    for (const message of queued) assert.equal(message.payload.mimeType, 'image/webp');
  }
);
