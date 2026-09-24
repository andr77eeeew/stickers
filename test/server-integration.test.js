const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const sharp = require('sharp');
const WebSocket = require('ws');

test('loopback server enforces dashboard/extension boundaries and bytes-only ingest', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-server-test-'));
  process.env.STICKER_OUTPUT_DIR = path.join(root, 'output');
  process.env.STICKER_TEMP_DIR = path.join(root, 'temp');
  process.env.INGEST_TOKEN = 'integration-secret';
  process.env.PORT = '31991';

  const { server, wss, startServer } = require('../server');
  let ws;
  try {
    startServer(0);
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const dashboardOrigin = 'http://127.0.0.1:31991';

    const evil = await fetch(`${baseUrl}/api/session`, {
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(evil.status, 403);

    const session = await fetch(`${baseUrl}/api/session`, {
      headers: { Origin: dashboardOrigin }
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie').split(';', 1)[0];

    const status = await fetch(`${baseUrl}/api/status`, {
      headers: { Origin: dashboardOrigin, Cookie: cookie }
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).captureMode, 'devtools');

    ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { Origin: dashboardOrigin, Cookie: cookie }
    });
    const [message] = await once(ws, 'message');
    assert.equal(JSON.parse(message.toString()).type, 'init');

    const webp = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } }
    }).webp().toBuffer();
    const payload = {
      source: 'devtools',
      sourceUrl: 'https://p16-common-sign.tiktokcdn.com/tos/video2sticker/test.webp?secret=yes',
      mimeType: 'image/webp',
      contentBase64: webp.toString('base64'),
      observedAt: '2026-08-18T12:00:00.000Z'
    };
    const extensionHeaders = {
      Origin: `chrome-extension://${'a'.repeat(32)}`,
      Authorization: 'Bearer integration-secret',
      'Content-Type': 'application/json'
    };

    const missingBody = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST',
      headers: extensionHeaders,
      body: JSON.stringify({ ...payload, contentBase64: '' })
    });
    assert.equal(missingBody.status, 422);

    const captured = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST', headers: extensionHeaders, body: JSON.stringify(payload)
    });
    assert.equal(captured.status, 200);
    const capturedBody = await captured.json();
    assert.equal(capturedBody.duplicate, false);
    assert.equal(capturedBody.sticker.originalUrl.includes('?'), false);

    const malformedFrame = await fetch(
      `${baseUrl}/api/stickers/${capturedBody.sticker.id}/frame/0junk`,
      { headers: { Origin: dashboardOrigin, Cookie: cookie } }
    );
    assert.equal(malformedFrame.status, 400);

    const firstFrame = await fetch(
      `${baseUrl}/api/stickers/${capturedBody.sticker.id}/frame/0`,
      { headers: { Origin: dashboardOrigin, Cookie: cookie } }
    );
    assert.equal(firstFrame.status, 200);
    assert.match(firstFrame.headers.get('content-type') || '', /^image\/png/);
    assert.match(firstFrame.headers.get('cache-control') || '', /private/);
    assert.ok((await firstFrame.arrayBuffer()).byteLength > 0);

    const outOfRangeFrame = await fetch(
      `${baseUrl}/api/stickers/${capturedBody.sticker.id}/frame/1`,
      { headers: { Origin: dashboardOrigin, Cookie: cookie } }
    );
    assert.equal(outOfRangeFrame.status, 404);

    const duplicate = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST', headers: extensionHeaders, body: JSON.stringify(payload)
    });
    assert.equal((await duplicate.json()).duplicate, true);

    const har = {
      log: {
        entries: [{
          startedDateTime: '2026-08-18T12:00:01.000Z',
          request: { url: payload.sourceUrl },
          response: { content: { mimeType: 'image/webp', encoding: 'base64', text: payload.contentBase64 } }
        }]
      }
    };
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(har)], { type: 'application/json' }), 'sample.har');
    const imported = await fetch(`${baseUrl}/api/import/har`, {
      method: 'POST',
      headers: { Origin: dashboardOrigin, Cookie: cookie },
      body: form
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).duplicates, 1);

    const archive = await fetch(`${baseUrl}/api/library/archive`, {
      method: 'POST',
      headers: { Origin: dashboardOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(archive.status, 200);
    const archiveBody = await archive.json();
    assert.equal(archiveBody.archive.stickerCount, 1);

    const stickers = await fetch(`${baseUrl}/api/stickers`, {
      headers: { Origin: dashboardOrigin, Cookie: cookie }
    });
    assert.equal((await stickers.json()).length, 1, 'snapshot archive must not clear active records');
  } finally {
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    for (const client of wss.clients) client.terminate();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});