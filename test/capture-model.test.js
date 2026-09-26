const { test } = require('node:test');
const assert = require('node:assert/strict');
const StatusText = require('../extension/shared/statusText.js');

const modelPromise = import('../frontend/src/lib/captureModel.js');

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const seen = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

function status(devtools) {
  return { devtools: { enabled: true, state: 'awaiting_devtools', lastError: null, ...devtools } };
}

test('dashboard and extension use the same listener vocabulary', async () => {
  const { LISTENER_LABELS } = await modelPromise;
  for (const state of ['off', 'closed', 'other_site', 'watching_unconfirmed', 'watching']) {
    assert.deepEqual(LISTENER_LABELS[state], StatusText.describeListener(state), state);
  }
});

test('capture description never claims a listener without a fresh heartbeat', async () => {
  const { describeCapture } = await modelPromise;

  const manual = describeCapture({ captureStatus: { devtools: { enabled: false } }, now: NOW });
  assert.equal(manual.title, 'Manual import');
  assert.equal(manual.connectable, true);

  const awaiting = describeCapture({ captureStatus: status({}), now: NOW });
  assert.equal(awaiting.short, 'Awaiting DevTools');
  assert.match(awaiting.detail, /No signal from the extension/);

  const stale = describeCapture({
    captureStatus: status({ extension: { connected: false, listenerState: 'watching', lastSeenAt: seen(300) } }),
    now: NOW
  });
  assert.equal(stale.short, 'Awaiting DevTools', 'stale heartbeat is ignored');

  const watching = describeCapture({
    captureStatus: status({ extension: { connected: true, listenerState: 'watching', lastSeenAt: seen(12), queue: { count: 0 } } }),
    now: NOW
  });
  assert.equal(watching.tone, 'ok');
  assert.equal(watching.short, 'Watching');
  assert.equal(watching.title, 'Extension · Watching TikTok tab');
  assert.match(watching.detail, /Last signal 12 s ago/);

  const held = describeCapture({
    captureStatus: status({ extension: { connected: true, listenerState: 'watching', lastSeenAt: seen(1), queue: { count: 3, blocked: 1, paused: 0 } } }),
    now: NOW
  });
  assert.equal(held.tone, 'problem');
  assert.match(held.detail, /1 capture\(s\) held/);
});

test('budget and delivery problems outrank the listener state', async () => {
  const { describeCapture } = await modelPromise;
  const extension = { connected: true, listenerState: 'watching', lastSeenAt: seen(1) };
  assert.equal(
    describeCapture({ captureStatus: status({ extension }), sessionInfo: { exhausted: true }, now: NOW }).short,
    'Session limit'
  );
  assert.equal(
    describeCapture({ captureStatus: status({ extension, lastError: 'disk full', state: 'local_delivery_failed' }), now: NOW }).short,
    'Delivery failed'
  );
});

test('pairing and relative time are described plainly', async () => {
  const { describePairing, formatAgo } = await modelPromise;
  assert.equal(describePairing(null).state, 'none');
  assert.equal(describePairing({ enabled: true, source: 'env' }).state, 'env');
  assert.equal(describePairing({ enabled: true, source: 'paired', createdAt: null }).text, 'Connected');
  assert.equal(formatAgo(seen(2), NOW), 'just now');
  assert.equal(formatAgo(seen(40), NOW), '40 s ago');
  assert.equal(formatAgo(seen(600), NOW), '10 min ago');
  assert.equal(formatAgo('', NOW), '');
});
