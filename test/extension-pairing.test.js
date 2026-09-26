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

test('live captures are auto-converted in one job unless the setting is off', { timeout: 90_000 }, async () => {
  // The window must outlast the server's pacing gap between captures (≤ 1.4 s).
  process.env.AUTO_CONVERT_DELAY_MS = '3000';
  const sharp = require('sharp');
  const sandbox = await startSandboxServer('stickers-autoconvert-test-');
  try {
    const { body: paired } = await sandbox.request('/api/extension/pair', { method: 'POST' });
    const ingest = async (index) => {
      const webp = await sharp({
        create: { width: 64, height: 64, channels: 4, background: { r: index * 40, g: 90, b: 160, alpha: 1 } }
      }).webp().toBuffer();
      const response = await fetch(`${sandbox.origin}/api/ingest`, {
        method: 'POST',
        headers: {
          Origin: EXTENSION_ORIGIN,
          Authorization: `Bearer ${paired.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          source: 'devtools',
          sourceUrl: `https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/${index}.webp`,
          mimeType: 'image/webp',
          contentBase64: webp.toString('base64'),
          observedAt: new Date().toISOString()
        })
      });
      assert.equal(response.status, 200);
      return (await response.json()).sticker.id;
    };
    const waitForJobs = async (count) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const { body } = await sandbox.request('/api/jobs');
        if (body.jobs.length >= count) return body.jobs;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return (await sandbox.request('/api/jobs')).body.jobs;
    };

    assert.equal((await sandbox.request('/api/status')).body.devtools.autoConvert, true, 'on by default');
    const first = await ingest(1);
    const second = await ingest(2);
    const jobs = await waitForJobs(1);
    assert.equal(jobs.length, 1, 'captures close together share one job');
    assert.equal(jobs[0].label, 'Convert 2 captured stickers');
    assert.deepEqual(jobs[0].items.map((item) => item.stickerId).sort(), [first, second].sort());

    const invalid = await sandbox.request('/api/extension/settings', { method: 'POST', body: { autoConvert: 'yes' } });
    assert.equal(invalid.status, 400);
    const off = await sandbox.request('/api/extension/settings', { method: 'POST', body: { autoConvert: false } });
    assert.equal(off.body.settings.autoConvert, false);
    await ingest(3);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal((await sandbox.request('/api/jobs')).body.jobs.length, 1, 'no job while auto-convert is off');

    await sandbox.restart();
    assert.equal((await sandbox.request('/api/status')).body.devtools.autoConvert, false, 'setting survives a restart');
  } finally {
    delete process.env.AUTO_CONVERT_DELAY_MS;
    await sandbox.stop();
  }
});
