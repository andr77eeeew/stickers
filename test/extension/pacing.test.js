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
const StatusText = require('../../extension/shared/statusText.js');

const policy = StickerPolicy.validatePolicy(JSON.parse(
  fs.readFileSync(path.join(extensionRoot, 'shared', 'sticker-policy.json'), 'utf8')
));
const NO_CACHE = [{ name: 'Pragma', value: 'no-cache' }, { name: 'Cache-Control', value: 'no-cache' }];
// Arrays built inside the vm context have another prototype; copy them out.
const plain = (value) => JSON.parse(JSON.stringify(value));
const codes = (status) => plain(status.warnings).map(({ code }) => code);

test('safety signals: verification checks and no-cache sticker requests are recognised', () => {
  const signals = (options, isCdnImage) =>
    CapturePipeline.detectSafetySignals(finishedRequest(options), policy, isCdnImage);

  assert.deepEqual(signals({ url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/secsdk-captcha/2.28/captcha.js' }, false), ['challenge']);
  assert.deepEqual(signals({ url: 'https://verification-va.tiktok.com/captcha/get?lang=en' }, false), ['challenge']);
  assert.deepEqual(signals({ requestHeaders: NO_CACHE }, true), ['cache_disabled']);
  assert.deepEqual(signals({ requestHeaders: NO_CACHE }, false), [], 'no-cache on non-image requests is ignored');
  assert.deepEqual(signals({ requestHeaders: [{ name: 'Cache-Control', value: 'max-age=0' }] }, true), []);
  assert.deepEqual(signals({}, true), []);
});

test('live listener reports each signal at most every 30 s; the Network log never does', async () => {
  const harness = await loadDevtools();
  for (let index = 0; index < 3; index += 1) {
    await harness.finish(finishedRequest({ requestHeaders: NO_CACHE }));
  }
  await harness.finish(finishedRequest({ url: 'https://www.tiktok.com/captcha/verify', mimeType: 'application/json', status: 403, body: Buffer.from('{}') }));
  const signals = harness.messages.filter(({ type }) => type === 'SAFETY_SIGNAL').map(({ signal }) => signal);
  assert.deepEqual(signals, ['cache_disabled', 'challenge']);

  const sent = [];
  const replay = CapturePipeline.createPipeline({
    policy,
    origin: 'network_log',
    lastError: () => null,
    send: async (message) => {
      sent.push(message);
      return { ok: true, queued: true };
    }
  });
  await replay.processEntry(finishedRequest({ requestHeaders: NO_CACHE }));
  assert.equal(sent.some(({ type }) => type === 'SAFETY_SIGNAL'), false);
});

test('page loads of the TikTok tab are reported, including reloads of the same site', async () => {
  const harness = await loadDevtools();
  await harness.navigate('https://www.tiktok.com/messages');
  await harness.navigate('https://www.tiktok.com/messages');
  await harness.navigate('https://example.com/');
  const navigations = harness.messages.filter(({ signal }) => signal === 'navigation');
  assert.equal(navigations.length, 2);
});

test('a verification check turns capture off and is reported to the dashboard', async () => {
  const harness = await loadBackground();
  await harness.sendAndSettle({ type: 'SAFETY_SIGNAL', signal: 'challenge' });
  const status = await harness.status();
  assert.equal(status.captureEnabled, false);
  assert.equal(harness.store.captureEnabled, false);
  assert.deepEqual(codes(status), ['challenge']);
  assert.match(status.lastEvent, /verification check/);
  const beat = harness.server.heartbeats.at(-1).body;
  assert.equal(beat.listenerState, 'off');
  assert.deepEqual(plain(beat.warnings).map(({ code }) => code), ['challenge']);

  await harness.sendAndSettle({ type: 'SAFETY_SIGNAL', signal: 'unknown_signal' });
  assert.deepEqual(codes(await harness.status()), ['challenge'], 'unknown signals are ignored');
});

test('cache, reload and capture-rate warnings follow their thresholds', async () => {
  const harness = await loadBackground();
  await harness.sendAndSettle({ type: 'SAFETY_SIGNAL', signal: 'cache_disabled' });
  for (let index = 0; index < 2; index += 1) {
    await harness.sendAndSettle({ type: 'SAFETY_SIGNAL', signal: 'navigation' });
  }
  assert.deepEqual(codes(await harness.status()), ['cache_disabled'], 'two reloads are fine');
  await harness.sendAndSettle({ type: 'SAFETY_SIGNAL', signal: 'navigation' });
  let status = await harness.status();
  assert.deepEqual(codes(status), ['cache_disabled', 'frequent_navigation']);
  assert.equal(status.warnings[1].count, 3);
  assert.equal(status.captureEnabled, true, 'only a verification check turns capture off');

  for (let index = 0; index < 12; index += 1) {
    const bytes = Buffer.concat([WEBP_BYTES, Buffer.from([index])]);
    await harness.sendAndSettle({ type: 'QUEUE_CAPTURE', payload: capturePayload({ contentBase64: bytes.toString('base64') }) });
  }
  status = await harness.status();
  const fast = status.warnings.find(({ code }) => code === 'fast_capture');
  assert.equal(fast.count, 12);
});

test('session warnings come from the server budget: near the limit, then at it', async () => {
  const harness = await loadBackground({ storage: { settingsVersion: 2, serverUrl: 'http://127.0.0.1:3001', ingestToken: 'test-ingest-token', captureEnabled: false } });
  const session = {
    captureCount: 21,
    maxCaptures: 25,
    maxMs: 20 * 60 * 1000,
    startedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    exhausted: false
  };
  harness.server.onHeartbeat = () => ({ status: 200, body: { ok: true, session } });
  harness.chrome.storage.local.set({ captureEnabled: true });
  await settle();
  let status = await harness.status();
  assert.deepEqual(plain(status.warnings), [{ code: 'session_near_limit', count: 21, max: 25, minutes: 6, maxMinutes: 20 }]);
  assert.equal(StatusText.describeSession(status.session, Date.now()).text, '21 of 25 captures · 6 of 20 min');

  session.exhausted = true;
  harness.chrome.storage.local.set({ captureEnabled: false });
  await settle();
  status = await harness.status();
  assert.deepEqual(codes(status), ['session_limit']);
});

test('dashboard shows the same warning and session texts as the extension', async () => {
  const model = await import('../../frontend/src/lib/captureModel.js');
  const samples = [
    { code: 'challenge' },
    { code: 'session_limit' },
    { code: 'cache_disabled' },
    { code: 'session_near_limit', count: 21, max: 25, minutes: 6, maxMinutes: 20 },
    { code: 'frequent_navigation', count: 4 },
    { code: 'fast_capture', count: 14 },
    { code: 'unknown' }
  ];
  assert.deepEqual(StatusText.WARNING_CODES, samples.slice(0, 6).map(({ code }) => code));
  for (const sample of samples) {
    assert.deepEqual(model.describeWarning(sample), StatusText.describeWarning(sample), sample.code);
  }
  const now = Date.parse('2026-09-27T12:00:00Z');
  for (const session of [
    null,
    { captureCount: 0, maxCaptures: 25, maxMs: 1200000, startedAt: null, exhausted: false },
    { captureCount: 5, maxCaptures: 25, maxMs: 1200000, startedAt: '2026-09-27T11:52:30Z', exhausted: false },
    { captureCount: 25, maxCaptures: 25, maxMs: 1200000, startedAt: '2026-09-27T11:40:00Z', exhausted: true }
  ]) {
    assert.deepEqual(model.describeSession(session, now), StatusText.describeSession(session, now));
  }
});

test('dashboard capture status puts a verification check first', async () => {
  const { describeCapture } = await import('../../frontend/src/lib/captureModel.js');
  const extension = {
    connected: true,
    listenerState: 'off',
    lastSeenAt: new Date().toISOString(),
    warnings: [{ code: 'challenge' }, { code: 'cache_disabled' }]
  };
  const capture = describeCapture({ captureStatus: { devtools: { enabled: true, extension } } });
  assert.equal(capture.short, 'Verification check');
  assert.equal(capture.tone, 'problem');
  assert.equal(capture.warnings.length, 1);
  assert.match(capture.warnings[0].text, /Disable cache/);

  const watching = describeCapture({
    captureStatus: {
      devtools: {
        enabled: true,
        extension: { ...extension, listenerState: 'watching', warnings: [{ code: 'fast_capture', count: 13 }] }
      }
    }
  });
  assert.equal(watching.short, 'Watching');
  assert.equal(watching.tone, 'pending', 'a pacing warning tints the status');
});
