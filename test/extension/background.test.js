'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  READY_STORAGE,
  WEBP_BYTES,
  capturePayload,
  finishedRequest,
  loadBackground,
  loadDevtools,
  settle
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
  assert.equal((await harness.status()).serverState, 'server_error');
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

test('first run waits for a dashboard token and keeps capture disabled', async () => {
  const harness = await loadBackground({ storage: {} });
  for (const listener of harness.listeners.installed) listener({ reason: 'install' });
  await settle();
  const status = await harness.status();

  assert.equal(status.captureEnabled, false);
  assert.equal(status.hasToken, false);
  assert.equal(harness.store.ingestToken, '');
  assert.equal(harness.badge.text, 'OFF');
  assert.equal(harness.server.heartbeats.length, 0, 'no token, no heartbeat');
});

test('an existing token is kept across updates', async () => {
  const harness = await loadBackground({
    storage: { settingsVersion: 2, ingestToken: 'kept-token', captureEnabled: true }
  });
  for (const listener of harness.listeners.installed) listener({ reason: 'update' });
  await settle();
  assert.equal(harness.store.ingestToken, 'kept-token');
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

// Regression contracts for defects fixed in stage E1 (docs/extension/PLAN.md §2).

test(
  'B1: heartbeat does not overwrite the last meaningful event',
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

test('B2: delivery resumes after the budget is reset and holds new captures meanwhile', async () => {
  const harness = await loadBackground();
  let budgetExhausted = true;
  harness.server.onIngest = () => budgetExhausted
    ? { status: 429, body: { error: 'Session budget exhausted.', budgetExhausted: true } }
    : { status: 200, body: { success: true } };
  const serverStatus = harness.server.handle;
  harness.server.handle = (pathname, options) => pathname === '/api/status'
    ? { status: 200, body: { session: { exhausted: budgetExhausted, captureCount: 25, maxCaptures: 25 } } }
    : serverStatus(pathname, options);

  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });
  const held = await harness.sendAndSettle({
    type: 'QUEUE_CAPTURE',
    payload: capturePayload({
      contentBase64: Buffer.concat([WEBP_BYTES, Buffer.from([1])]).toString('base64')
    })
  });
  assert.equal(held.paused, true);
  assert.equal(ingestCalls(harness).length, 1, 'held capture is not sent while paused');
  assert.equal(harness.badge.text, 'II');

  await harness.fireAlarm('capture-queue-periodic');
  assert.equal(harness.queue.records.size, 2, 'still exhausted: nothing resumes');

  budgetExhausted = false;
  await harness.fireAlarm('capture-queue-periodic');
  const status = await harness.status();
  assert.equal(harness.queue.records.size, 0);
  assert.equal(status.pausedReason, null);
  assert.equal(status.counters.delivered, 2);
  assert.match(status.events.map(({ text }) => text).join('\n'), /resumed/);
});

test('plain rate limit honours Retry-After without pausing', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = () => ({
    status: 429,
    headers: { 'Retry-After': '120' },
    body: { error: 'Ingest rate limit exceeded. Slow down.' }
  });
  const before = Date.now();
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });

  const record = onlyRecord(harness);
  assert.equal(record.state, 'pending');
  assert.ok(record.nextAttemptAt >= before + 120000);
  assert.equal((await harness.status()).pausedReason, null);
});

test('server with capture disabled is reported distinctly from a wrong token', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = () => ({
    status: 401,
    body: { error: 'Extension ingest is disabled until INGEST_TOKEN is configured.', code: 'INGEST_DISABLED' }
  });
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });
  const status = await harness.status();
  assert.equal(status.serverState, 'capture_disabled');
  assert.match(status.lastEvent, /disabled on the local server/);
});

test('B8: held items can be listed, saved as a file and discarded', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = () => ({ status: 422, body: { error: 'bad body' } });
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });

  const { items } = await harness.send({ type: 'LIST_HELD' });
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'blocked');
  assert.equal(items[0].mimeType, 'image/webp');
  assert.equal('payload' in items[0], false, 'listing carries no bytes');

  const file = await harness.send({ type: 'GET_ITEM_FILE', id: items[0].id });
  assert.equal(file.ok, true);
  assert.equal(file.contentBase64, WEBP_BYTES.toString('base64'));

  const discarded = await harness.sendAndSettle({ type: 'DISCARD_ITEM', id: items[0].id });
  assert.equal(discarded.ok, true);
  assert.equal(harness.queue.records.size, 0);
  assert.equal(harness.badge.text, '');
});

test('B8: pending items cannot be discarded or read through the held API', async () => {
  const harness = await loadBackground();
  harness.server.onIngest = () => ({ status: 503, body: {} });
  await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload() });
  const { id } = onlyRecord(harness);

  assert.equal((await harness.send({ type: 'DISCARD_ITEM', id })).ok, false);
  assert.equal((await harness.send({ type: 'GET_ITEM_FILE', id })).ok, false);
  assert.equal(harness.queue.records.size, 1);
});

test('B4: listener state reflects capture toggle and the inspected site', async () => {
  const harness = await loadBackground();
  assert.equal((await harness.status()).listenerState, 'closed');

  await harness.sendAndSettle({ type: 'DEVTOOLS_HEARTBEAT', tabId: 7, site: 'other' });
  assert.equal((await harness.status()).listenerState, 'other_site');

  await harness.sendAndSettle({ type: 'DEVTOOLS_HEARTBEAT', tabId: 9, site: 'tiktok' });
  assert.equal((await harness.status()).listenerState, 'watching');

  harness.chrome.storage.local.set({ captureEnabled: false });
  await settle();
  assert.equal((await harness.status()).listenerState, 'off');
});

test('B4: DevTools on another site reads no bodies until it navigates to TikTok', async () => {
  const harness = await loadDevtools({
    resources: [{ type: 'document', url: 'https://example.com/' }]
  });
  const listening = harness.messages.find(({ kind }) => kind === 'listening');
  assert.equal(listening.site, 'other');

  const ignored = finishedRequest();
  await harness.finish(ignored);
  assert.equal(ignored.getContentCalls, 0);

  await harness.navigate('https://www.tiktok.com/messages');
  const changed = harness.messages.filter(({ kind }) => kind === 'site_changed');
  assert.equal(changed.at(-1).site, 'tiktok');

  const sticker = finishedRequest();
  await harness.finish(sticker);
  assert.equal(sticker.getContentCalls, 1);
});

test('B4: disabled capture sends no heartbeat until it is enabled', async () => {
  const harness = await loadDevtools({ storage: { captureEnabled: false } });
  await harness.tickIntervals();
  assert.equal(harness.messages.some(({ type }) => type === 'DEVTOOLS_HEARTBEAT'), false);
  assert.equal(harness.messages.some(({ kind }) => kind === 'listening'), false);

  harness.chrome.storage.local.set({ captureEnabled: true });
  await settle();
  await harness.tickIntervals();
  const heartbeat = harness.messages.find(({ type }) => type === 'DEVTOOLS_HEARTBEAT');
  assert.deepEqual({ tabId: heartbeat.tabId, site: heartbeat.site }, { tabId: 7, site: 'tiktok' });
});

test('server heartbeat reports listener state with the bearer token only when it changes', async () => {
  const harness = await loadBackground();
  const beats = () => harness.server.heartbeats.map(({ body }) => body.listenerState);
  assert.deepEqual(beats(), ['closed'], 'bootstrap announces the extension');
  const [first] = harness.server.heartbeats;
  assert.equal(first.headers.Authorization, 'Bearer test-ingest-token');
  assert.deepEqual(Object.keys(first.body).sort(), ['listenerState', 'pausedReason', 'queue', 'version', 'warnings']);
  assert.equal(first.body.warnings.length, 0);
  assert.deepEqual(first.body.queue, { count: 0, blocked: 0, paused: 0 });
  assert.match(first.body.version, /^\d+\.\d+\.\d+$/);

  await harness.sendAndSettle({ type: 'DEVTOOLS_EVENT', kind: 'listening', tabId: 7, site: 'tiktok' });
  assert.deepEqual(beats(), ['closed', 'watching']);

  for (let step = 0; step < 3; step += 1) {
    await harness.sendAndSettle({ type: 'DEVTOOLS_HEARTBEAT', tabId: 7, site: 'tiktok' });
  }
  assert.equal(beats().length, 2, 'unchanged state is throttled');

  await harness.sendAndSettle({ type: 'DEVTOOLS_CLOSED', tabId: 7 });
  assert.deepEqual(beats(), ['closed', 'watching', 'closed']);
  assert.equal((await harness.status()).listenerState, 'closed');

  harness.chrome.storage.local.set({ captureEnabled: false });
  await settle();
  assert.equal(beats().at(-1), 'off');
  assert.deepEqual(harness.network.violations, []);
});

test('heartbeat rejection surfaces as a token problem before any capture', async () => {
  const harness = await loadBackground({ storage: { ...READY_STORAGE, captureEnabled: false } });
  harness.server.onHeartbeat = () => ({ status: 401, body: { error: 'Invalid or missing bearer token.', code: 'TOKEN_REJECTED' } });
  harness.chrome.storage.local.set({ captureEnabled: true });
  await settle();
  assert.equal((await harness.status()).serverState, 'unauthorized');
});

test('closing DevTools notifies the background right away', async () => {
  const harness = await loadDevtools();
  harness.closeDevtools();
  await settle();
  const closed = harness.messages.find(({ type }) => type === 'DEVTOOLS_CLOSED');
  assert.deepEqual({ tabId: closed.tabId, site: closed.site }, { tabId: 7, site: 'tiktok' });
});
