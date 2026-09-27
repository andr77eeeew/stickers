'use strict';

// The extension service worker (vm harness) against the real server.js in a
// sandbox: the delivery contract that unit tests cover with a mock server.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  EXTENSION_ORIGIN,
  READY_STORAGE,
  capturePayload,
  loadBackground
} = require('./helpers/extensionHarness');
const { startSandboxServer } = require('./helpers/sandboxServer');

const plain = (value) => JSON.parse(JSON.stringify(value));

async function waitFor(read, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = plain(await read());
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label}: timed out, last value ${JSON.stringify(value)}`);
}

async function stickerPayload(index) {
  const webp = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: index * 50, g: 120, b: 200, alpha: 1 } }
  }).webp().toBuffer();
  return capturePayload({
    sourceUrl: `https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/contract-${index}.webp`,
    contentBase64: webp.toString('base64'),
    observedAt: new Date().toISOString()
  });
}

test('extension and server agree on budget pause, resume, rejection and unpairing', { timeout: 120_000 }, async () => {
  const sandbox = await startSandboxServer('stickers-contract-test-', { env: { SESSION_MAX_CAPTURES: '2' } });
  try {
    const { body: paired } = await sandbox.request('/api/extension/pair', { method: 'POST' });
    await sandbox.request('/api/extension/settings', { method: 'POST', body: { autoConvert: false } });
    const harness = await loadBackground({
      storage: { ...READY_STORAGE, ingestToken: paired.token },
      upstream: sandbox.origin
    });
    const dashboard = async () => (await sandbox.request('/api/status')).body;
    const library = async () => (await sandbox.request('/api/stickers')).body;
    const libraryCount = async () => {
      const body = await library();
      return (Array.isArray(body) ? body : body.stickers || []).length;
    };

    // Budget of 2: the third capture is held as paused, not lost or blocked.
    for (const index of [1, 2, 3]) {
      const queued = await harness.send({ type: 'QUEUE_CAPTURE', payload: await stickerPayload(index) });
      assert.equal(queued.ok, true, `capture ${index} queued`);
    }
    let status = await waitFor(
      harness.status,
      (value) => value.queue.paused === 1 && value.counters.delivered === 2,
      'budget pause'
    );
    assert.equal(status.pausedReason, 'capture_budget_exhausted');
    assert.equal(status.serverState, 'online');
    assert.equal(status.session.exhausted, true);
    assert.equal(status.queue.blocked, 0);
    assert.ok(status.warnings.some((warning) => warning.code === 'session_limit'));
    assert.equal(await libraryCount(), 2);

    // The dashboard learns about the held capture from the heartbeat.
    const held = await waitFor(dashboard, (value) => value.devtools.extension?.queue?.paused === 1, 'heartbeat');
    assert.equal(held.devtools.extension.connected, true);
    assert.equal(held.devtools.lastError, null, 'a budget pause is not a delivery failure');

    // "Start new session" in the dashboard; the next check resumes delivery.
    await sandbox.request('/api/session/reset', { method: 'POST' });
    await harness.send({ type: 'PING_SERVER' });
    status = await waitFor(
      harness.status,
      (value) => value.queue.count === 0 && value.counters.delivered === 3,
      'resume after a new session'
    );
    assert.equal(status.pausedReason, null);
    assert.equal(await libraryCount(), 3);

    // Bytes the extension accepts but the server cannot decode are blocked
    // in the extension and shown as a rejection, not a delivery failure.
    await harness.send({ type: 'QUEUE_CAPTURE', payload: capturePayload() });
    status = await waitFor(harness.status, (value) => value.queue.blocked === 1, 'server rejection');
    assert.equal(status.serverState, 'online');
    const rejected = await dashboard();
    assert.ok(rejected.devtools.lastRejectedReason, 'rejection recorded');
    assert.equal(rejected.devtools.lastError, null);
    assert.notEqual(rejected.devtools.state, 'local_delivery_failed');
    assert.equal(await libraryCount(), 3);

    // Disconnect in the dashboard: the extension reports it distinctly.
    await sandbox.request('/api/extension/unpair', { method: 'POST' });
    await harness.send({ type: 'PING_SERVER' });
    status = await waitFor(harness.status, (value) => value.serverState === 'capture_disabled', 'unpair');

    // Only loopback was contacted, with the extension origin; the token never
    // reaches the status the pages read or the server log.
    assert.deepEqual(plain(harness.network.violations), []);
    for (const call of harness.network.calls) {
      assert.match(call.url, /^(http:\/\/127\.0\.0\.1:3001\/api\/|chrome-extension:\/\/)/, call.url);
    }
    assert.ok(harness.network.calls.some((call) => call.url.endsWith('/api/extension/heartbeat')));
    assert.equal(JSON.stringify(status).includes(paired.token), false);
    assert.equal(sandbox.output.includes(paired.token), false, 'token not in server output');
    assert.ok(EXTENSION_ORIGIN.startsWith('chrome-extension://'));
  } finally {
    await sandbox.stop();
  }
});
