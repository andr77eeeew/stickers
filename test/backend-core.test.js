const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const {
  loadStickerPolicy,
  validateStickerUrl,
  validateStickerPayload,
  decodeBase64Strict
} = require('../lib/stickerPolicy');
const {
  StickerDatabase,
  reconcileStorage,
  SCHEMA_VERSION
} = require('../lib/stickerDatabase');
const {
  createLocalSecurity,
  isExtensionOrigin,
  isLoopbackHostHeader
} = require('../lib/localSecurity');
const SessionBudget = require('../lib/sessionBudget');

const policy = loadStickerPolicy();
const validUrl =
  'https://p16-common-sign.tiktokcdn.com/tos/video2sticker/example.webp?signature=secret';

test('shared policy accepts only exact HTTPS sticker hosts and strips secrets', () => {
  const accepted = validateStickerUrl(validUrl, policy);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.canonicalUrl.includes('?'), false);

  const prefixed = validateStickerUrl(
    'https://p16-tiktok-dm-sticker-sign-eu.ibyteimg.com/tos/tplv-dhq7zx/item.awebp',
    policy
  );
  assert.equal(prefixed.ok, true);

  for (const rejected of [
    'http://p16-common-sign.tiktokcdn.com/tos/video2sticker/example.webp',
    'https://p16-common-sign.tiktokcdn.com.attacker.example/tos/video2sticker/example.webp',
    'https://nested.p16-tiktok-dm-sticker-sign-eu.ibyteimg.com/tos/tplv-dhq7zx/item.awebp',
    'https://p16-common-sign.tiktokcdn.com/avatar/video2sticker/example.webp',
    'https://p16-common-sign.tiktokcdn.com/tos/unrelated.webp'
  ]) {
    assert.equal(validateStickerUrl(rejected, policy).ok, false, rejected);
  }
});

test('payload validation requires strict base64, matching magic bytes, and decodable pixels', async () => {
  const webp = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 }
    }
  })
    .webp()
    .toBuffer();

  const validated = await validateStickerPayload({
    sourceUrl: validUrl,
    mimeType: 'image/webp; charset=binary',
    contentBase64: webp.toString('base64'),
    policy,
    maxDecodedPixels: 100
  });
  assert.equal(validated.detectedMime, 'image/webp');
  assert.equal(validated.canonicalUrl.includes('signature='), false);
  assert.deepEqual(validated.buffer, webp);

  assert.throws(() => decodeBase64Strict('%%%invalid%%%', policy.maxBodyBytes), /malformed/);
  await assert.rejects(
    validateStickerPayload({
      sourceUrl: validUrl,
      mimeType: 'image/png',
      contentBase64: webp.toString('base64'),
      policy,
      maxDecodedPixels: 100
    }),
    /magic bytes/
  );
});

test('local security separates dashboard cookies from extension bearer auth', () => {
  const origin = 'http://127.0.0.1:3001';
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const security = createLocalSecurity({
    ingestToken: 'test-secret',
    dashboardOrigins: new Set([origin])
  });

  const headers = {};
  security.setDashboardCookie({ setHeader: (name, value) => { headers[name] = value; } });
  const cookie = headers['Set-Cookie'].split(';', 1)[0];

  assert.equal(isLoopbackHostHeader('127.0.0.1:3001'), true);
  assert.equal(isLoopbackHostHeader('example.com:3001'), false);
  assert.equal(isExtensionOrigin(extensionOrigin), true);
  assert.equal(
    security.authorizeWebSocket({
      headers: { host: '127.0.0.1:3001', origin, cookie }
    }),
    true
  );
  assert.equal(
    security.authorizeWebSocket({
      headers: { host: '127.0.0.1:3001', origin: 'https://evil.example', cookie }
    }),
    false
  );
  assert.equal(
    security.validExtensionBearer({
      headers: { authorization: 'Bearer test-secret' }
    }),
    true
  );
  assert.equal(
    security.validExtensionBearer({
      headers: { authorization: 'Bearer wrong' }
    }),
    false
  );
});



test('extension CORS preflight is limited to ingest and status endpoints', () => {
  const security = createLocalSecurity({
    ingestToken: 'test-secret',
    dashboardOrigins: new Set(['http://127.0.0.1:3001'])
  });
  const origin = `chrome-extension://${'a'.repeat(32)}`;

  function invoke(
    pathname,
    requestedMethod = 'POST',
    requestedHeaders = 'authorization, content-type'
  ) {
    const headers = {};
    let statusCode = null;
    let body = null;
    let ended = false;
    let nextCalled = false;
    const req = {
      method: 'OPTIONS',
      path: pathname,
      headers: {
        host: '127.0.0.1:3001',
        origin,
        'access-control-request-method': requestedMethod,
        'access-control-request-headers': requestedHeaders
      }
    };
    const res = {
      setHeader: (name, value) => { headers[name] = value; },
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        body = value;
        return this;
      },
      end() {
        ended = true;
        return this;
      }
    };
    security.originMiddleware(req, res, () => { nextCalled = true; });
    return { headers, statusCode, body, ended, nextCalled };
  }

  const accepted = invoke('/api/ingest');
  assert.equal(accepted.statusCode, 204);
  assert.equal(accepted.ended, true);
  assert.equal(accepted.nextCalled, false);
  assert.equal(accepted.headers['Access-Control-Allow-Methods'], 'POST');
  assert.equal(accepted.headers['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
  assert.equal(accepted.headers['Access-Control-Allow-Origin'], origin);

  const status = invoke('/api/status', 'GET', 'authorization');
  assert.equal(status.statusCode, 204);
  assert.equal(status.headers['Access-Control-Allow-Methods'], 'GET');
  assert.equal(status.headers['Access-Control-Allow-Headers'], 'Authorization');
  assert.equal(status.headers['Access-Control-Allow-Origin'], origin);

  assert.equal(invoke('/api/status', 'POST', 'authorization').statusCode, 403);
  assert.equal(invoke('/api/status', 'GET', 'authorization, content-type').statusCode, 403);
  assert.equal(invoke('/api/ingest', 'POST', 'authorization, x-extra').statusCode, 403);
  assert.equal(invoke('/api/stickers', 'GET', 'authorization').statusCode, 403);
});

test('database writes schema-versioned JSON atomically and recovers from backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-db-test-'));
  try {
    const databasePath = path.join(root, 'output', 'stickers_db.json');
    const database = new StickerDatabase(databasePath);
    const stickerA = {
      id: 'a'.repeat(64),
      originalFilename: `sticker_${'a'.repeat(64)}.webp`,
      capturedDate: '2026-08-18',
      status: 'captured',
      originalUrl: `${validUrl}&token=private`
    };
    const stickerB = {
      id: 'b'.repeat(64),
      originalFilename: `sticker_${'b'.repeat(64)}.webp`,
      capturedDate: '2026-08-18',
      status: 'captured',
      originalUrl: 'manual://sample.webp'
    };

    database.save([stickerA]);
    database.save([stickerA, stickerB]);

    const raw = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
    assert.equal(raw.schemaVersion, SCHEMA_VERSION);
    assert.equal(raw.stickers.length, 2);
    assert.equal(raw.stickers[0].originalUrl.includes('?'), false);

    fs.writeFileSync(databasePath, '{broken', 'utf8');
    const recovered = database.load();
    assert.equal(recovered.recoveredFromBackup, true);
    assert.equal(recovered.stickers.length, 1);
    assert.ok(recovered.quarantinedPrimaryPath);
    assert.equal(fs.existsSync(recovered.quarantinedPrimaryPath), true);

    database.save(recovered.stickers);
    const preservedBackup = JSON.parse(fs.readFileSync(database.backupPath, 'utf8'));
    assert.equal(preservedBackup.stickers.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(databasePath, 'utf8')).stickers.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reconciliation reports damage without deleting files and makes stale jobs retryable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-reconcile-test-'));
  try {
    const outputDir = path.join(root, 'output');
    const tempDir = path.join(root, 'temp');
    const capturedDir = path.join(outputDir, 'captured', '2026-08-18');
    fs.mkdirSync(capturedDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    const filename = `sticker_${'c'.repeat(64)}.webp`;
    fs.writeFileSync(path.join(capturedDir, filename), 'preserved');
    fs.writeFileSync(path.join(capturedDir, 'orphan.webp'), 'preserved orphan');

    const stickers = [{
      id: 'c'.repeat(64),
      originalFilename: filename,
      capturedDate: '2026-08-18',
      status: 'converting',
      convertedPath: '/animated/2026-08-18/missing.webm'
    }];
    // A routine check while a conversion runs must not touch its status.
    const running = [{ ...stickers[0] }];
    const routine = reconcileStorage(running, { outputDir, tempDir });
    assert.equal(running[0].status, 'converting');
    assert.equal(routine.report.staleConversions, 0);

    const reconciled = reconcileStorage(stickers, { outputDir, tempDir, recoverInterrupted: true, collectItems: true });

    assert.equal(reconciled.report.staleConversions, 1);
    assert.equal(reconciled.report.missingConverted, 1);
    assert.equal(reconciled.report.orphanFiles, 1);
    assert.equal(stickers[0].status, 'failed');
    assert.equal(fs.existsSync(path.join(capturedDir, 'orphan.webp')), true);
    assert.deepEqual(reconciled.issues.orphanFiles.items, [{ name: 'captured/2026-08-18/orphan.webp' }]);
    assert.deepEqual(reconciled.issues.missingConverted.items, [
      { stickerId: 'c'.repeat(64), name: 'animated/2026-08-18/missing.webm' }
    ]);
    const serialized = JSON.stringify(reconciled.issues);
    assert.ok(!serialized.includes(root), 'issue names never contain absolute paths');

    // The interrupted flag survives later routine checks until the sticker is converted again.
    const later = reconcileStorage(stickers, { outputDir, tempDir });
    assert.equal(later.report.staleConversions, 1);
    assert.ok(stickers[0].health.includes('interrupted_conversion'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session budget timer is dormant until the first unique capture', () => {
  const budget = new SessionBudget({ maxCaptures: 2, maxMs: 60_000 });
  assert.equal(budget.snapshot().startedAt, null);
  assert.equal(budget.snapshot().elapsedMs, 0);
  budget.recordCapture();
  assert.ok(budget.snapshot().startedAt);
  assert.equal(budget.snapshot().captureCount, 1);
});
