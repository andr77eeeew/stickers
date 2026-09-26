const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { once } = require('events');
const { IngestTokenStore } = require('../lib/ingestTokenStore');
const { startSandboxServer } = require('./helpers/sandboxServer');

const EXTENSION_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-token-test-'));
  return { directory, filePath: path.join(directory, 'output', '.ingest-token') };
}

test('token store: .env token wins and cannot be replaced from the dashboard', () => {
  const { directory, filePath } = tempFile();
  try {
    const store = new IngestTokenStore({ envToken: ' env-secret ', filePath });
    assert.equal(store.current(), 'env-secret');
    assert.deepEqual(store.status(), { enabled: true, source: 'env', createdAt: null });
    assert.throws(() => store.pair(), { code: 'ENV_TOKEN' });
    assert.throws(() => store.unpair(), { code: 'ENV_TOKEN' });
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('token store: pairing persists, survives reload and can be revoked', () => {
  const { directory, filePath } = tempFile();
  try {
    const store = new IngestTokenStore({ filePath, now: () => '2026-09-27T10:00:00.000Z' });
    assert.deepEqual(store.status(), { enabled: false, source: null, createdAt: null });

    const token = store.pair();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(store.status(), { enabled: true, source: 'paired', createdAt: '2026-09-27T10:00:00.000Z' });
    assert.equal(new IngestTokenStore({ filePath }).current(), token);
    assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['.ingest-token'], 'no temporary files left');

    const replaced = store.pair();
    assert.notEqual(replaced, token);
    assert.equal(new IngestTokenStore({ filePath }).current(), replaced);

    store.unpair();
    assert.equal(store.current(), '');
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('token store: a damaged token file means "not connected"', () => {
  const { directory, filePath } = tempFile();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    for (const contents of ['not json', '{"version":1,"token":"short"}', '{"version":2,"token":"' + 'a'.repeat(43) + '"}']) {
      fs.writeFileSync(filePath, contents);
      assert.equal(new IngestTokenStore({ filePath }).current(), '', contents);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dashboard pairing enables capture, heartbeats reach the dashboard, unpair disables it', { timeout: 60_000 }, async () => {
  const sandbox = await startSandboxServer('stickers-pairing-test-');
  const extension = (token, extra = {}) => ({
    Origin: EXTENSION_ORIGIN,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra
  });
  const heartbeat = (token, body) => fetch(`${sandbox.origin}/api/extension/heartbeat`, {
    method: 'POST',
    headers: extension(token),
    body: JSON.stringify(body)
  });
  let ws;
  try {
    const initial = await sandbox.request('/api/status');
    assert.equal(initial.body.captureMode, 'offline');
    assert.deepEqual(initial.body.devtools.pairing, { enabled: false, source: null, createdAt: null });
    assert.equal(initial.body.devtools.extension.connected, false);

    const beforePairing = await heartbeat('anything', { listenerState: 'watching' });
    assert.equal(beforePairing.status, 401);
    assert.equal((await beforePairing.json()).code, 'INGEST_DISABLED');

    const noSession = await fetch(`${sandbox.origin}/api/extension/pair`, {
      method: 'POST',
      headers: { Origin: sandbox.origin }
    });
    assert.equal(noSession.status, 401, 'pairing needs the dashboard session');
    const fromExtension = await fetch(`${sandbox.origin}/api/extension/pair`, {
      method: 'POST',
      headers: extension('anything')
    });
    assert.equal(fromExtension.status, 403, 'the extension cannot pair itself');

    const paired = await sandbox.request('/api/extension/pair', { method: 'POST' });
    assert.equal(paired.status, 200);
    const { token } = paired.body;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(paired.body.pairing.source, 'paired');
    assert.equal(fs.existsSync(path.join(sandbox.outputDir, '.ingest-token')), true);

    const status = await sandbox.request('/api/status');
    assert.equal(status.body.captureMode, 'devtools');
    assert.equal(JSON.stringify(status.body).includes(token), false, 'status never carries the token');

    ws = new WebSocket(`${sandbox.origin.replace('http', 'ws')}/ws`, {
      headers: { Origin: sandbox.origin, Cookie: sandbox.cookie }
    });
    await once(ws, 'message');
    const nextStatus = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'status' && message.data.devtools.extension.connected) resolve(message.data);
      });
    });

    const preflight = await fetch(`${sandbox.origin}/api/extension/heartbeat`, {
      method: 'OPTIONS',
      headers: {
        Origin: EXTENSION_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type'
      }
    });
    assert.equal(preflight.status, 204);

    const accepted = await heartbeat(token, {
      listenerState: 'watching',
      queue: { count: 2, blocked: 0, paused: 0 },
      pausedReason: null,
      version: '2.0.0'
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).session.exhausted, false);

    const broadcast = await nextStatus;
    assert.equal(broadcast.devtools.extension.listenerState, 'watching');
    assert.deepEqual(broadcast.devtools.extension.queue, { count: 2, blocked: 0, paused: 0 });
    assert.equal(broadcast.devtools.extension.version, '2.0.0');
    assert.equal(JSON.stringify(broadcast).includes(token), false);

    const invalid = await heartbeat(token, { listenerState: 'hacking' });
    assert.equal(invalid.status, 400);
    const wrongToken = await heartbeat('wrong-token', { listenerState: 'watching' });
    assert.equal(wrongToken.status, 401);
    assert.equal((await wrongToken.json()).code, 'TOKEN_REJECTED');

    const revealed = await sandbox.request('/api/extension/token', { method: 'POST' });
    assert.equal(revealed.body.token, token);

    await sandbox.restart();
    const afterRestart = await sandbox.request('/api/status');
    assert.equal(afterRestart.body.devtools.pairing.source, 'paired', 'pairing survives a restart');
    assert.equal((await heartbeat(token, { listenerState: 'closed' })).status, 200);

    const unpaired = await sandbox.request('/api/extension/unpair', { method: 'POST' });
    assert.equal(unpaired.status, 200);
    assert.equal(unpaired.body.pairing.enabled, false);
    assert.equal(fs.existsSync(path.join(sandbox.outputDir, '.ingest-token')), false);
    const afterUnpair = await heartbeat(token, { listenerState: 'watching' });
    assert.equal((await afterUnpair.json()).code, 'INGEST_DISABLED');
    assert.equal((await sandbox.request('/api/extension/token', { method: 'POST' })).status, 404);
  } finally {
    if (ws) ws.close();
    await sandbox.stop();
  }
});
