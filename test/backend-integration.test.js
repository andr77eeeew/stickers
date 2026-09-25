const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');
const WebSocket = require('ws');

const projectRoot = path.resolve(__dirname, '..');
const extensionId = 'a'.repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}`;
const ingestToken = 'integration-test-token';

async function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10_000);
    const onData = (data) => {
      output += data.toString();
      if (output.includes('STICKER SERVER:')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited during startup with code ${code}: ${output}`));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
}

function requestHeaders(origin, cookie) {
  return {
    Origin: origin,
    ...(cookie ? { Cookie: cookie } : {})
  };
}

async function rejectedWebSocket(url, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Unauthorized WebSocket did not reject in time.'));
    }, 5_000);
    ws.once('open', () => {
      clearTimeout(timeout);
      ws.terminate();
      reject(new Error('Unauthorized WebSocket opened.'));
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      assert.equal(response.statusCode, 401);
      response.resume();
      resolve();
    });
    ws.once('error', () => {
      // unexpected-response is the assertion path.
    });
  });
}

async function authorizedWebSocket(url, origin, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, headers: { Cookie: cookie } });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Authorized WebSocket init timed out.'));
    }, 5_000);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      const message = JSON.parse(data.toString());
      ws.close();
      resolve(message);
    });
    ws.once('error', reject);
  });
}

test('isolated server enforces auth and processes only supplied local bytes', { timeout: 180_000 }, async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-server-test-'));
  const outputDir = path.join(sandbox, 'output');
  const tempDir = path.join(sandbox, 'temp');
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const baseUrl = origin;
  let child;

  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(port),
        INGEST_TOKEN: ingestToken,
        DASHBOARD_ORIGINS: origin,
        STICKER_OUTPUT_DIR: outputDir,
        STICKER_TEMP_DIR: tempDir,
        SESSION_MAX_CAPTURES: '1',
        CAPTURE_MIN_INTERVAL_MS: '200',
        CAPTURE_JITTER_MS: '0'
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForReady(child);

    const ingestPreflight = await fetch(`${baseUrl}/api/ingest`, {
      method: 'OPTIONS',
      headers: {
        Origin: extensionOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type'
      }
    });
    assert.equal(ingestPreflight.status, 204);
    assert.equal(ingestPreflight.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(
      ingestPreflight.headers.get('access-control-allow-headers'),
      'Authorization, Content-Type'
    );

    const statusPreflight = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: extensionOrigin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization'
      }
    });
    assert.equal(statusPreflight.status, 204);
    assert.equal(statusPreflight.headers.get('access-control-allow-methods'), 'GET');
    assert.equal(statusPreflight.headers.get('access-control-allow-headers'), 'Authorization');

    const rejectedExtensionPreflight = await fetch(`${baseUrl}/api/stickers`, {
      method: 'OPTIONS',
      headers: {
        Origin: extensionOrigin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization'
      }
    });
    assert.equal(rejectedExtensionPreflight.status, 403);

    const rejectedSession = await fetch(`${baseUrl}/api/session`, {
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(rejectedSession.status, 403);

    const sessionResponse = await fetch(`${baseUrl}/api/session`, {
      headers: requestHeaders(origin)
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.authenticated, true);
    assert.equal(session.status.captureMode, 'devtools');
    assert.equal(session.status.devtools.listening, null);
    assert.equal(path.resolve(session.outputPaths.root), path.resolve(outputDir));
    const cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];
    const postDashboardJson = async (endpoint, payload) => {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          ...requestHeaders(origin, cookie),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload || {})
      });
      return { response, body: await response.json() };
    };

    assert.equal((await fetch(`${baseUrl}/api/stickers`, {
      headers: requestHeaders(origin)
    })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/stickers`, {
      headers: requestHeaders(origin, cookie)
    })).status, 200);

    const extensionStatus = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: extensionOrigin,
        Authorization: `Bearer ${ingestToken}`
      }
    });
    assert.equal(extensionStatus.status, 200);

    const urlOnly = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        Origin: extensionOrigin,
        Authorization: `Bearer ${ingestToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: 'devtools',
        sourceUrl: 'https://p16-common-sign.tiktokcdn.com/tos/video2sticker/empty.webp',
        mimeType: 'image/webp'
      })
    });
    assert.equal(urlOnly.status, 422);

    const webp = await sharp({
      create: {
        width: 3,
        height: 3,
        channels: 4,
        background: { r: 120, g: 80, b: 20, alpha: 1 }
      }
    })
      .webp()
      .toBuffer();
    const sourceUrl =
      'https://p16-common-sign.tiktokcdn.com/tos/video2sticker/integration.webp?token=secret';

    const ingest = async ({ bytes = webp, url = sourceUrl } = {}) => {
      const response = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          Origin: extensionOrigin,
          Authorization: `Bearer ${ingestToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          source: 'devtools',
          sourceUrl: url,
          mimeType: 'image/webp',
          contentBase64: bytes.toString('base64'),
          observedAt: '2026-08-18T12:00:00.000Z'
        })
      });
      return { response, body: await response.json() };
    };

    const first = await ingest();
    assert.equal(first.response.status, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.duplicate, false);
    assert.equal(first.body.sticker.originalUrl.includes('?'), false);

    const duplicate = await ingest();
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.session.exhausted, true);

    const secondWebp = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: { r: 20, g: 140, b: 220, alpha: 1 }
      }
    })
      .webp()
      .toBuffer();
    const secondUrl =
      'https://p16-common-sign.tiktokcdn.com/tos/video2sticker/second.webp?token=second-secret';
    const exhausted = await ingest({ bytes: secondWebp, url: secondUrl });
    assert.equal(exhausted.response.status, 429);
    assert.equal(exhausted.response.headers.get('retry-after'), '60');
    assert.equal(exhausted.body.budgetExhausted, true);

    const reset = await postDashboardJson('/api/session/reset', {});
    assert.equal(reset.response.status, 200);
    assert.equal(reset.body.session.exhausted, false);
    const retriedAfterReset = await ingest({ bytes: secondWebp, url: secondUrl });
    assert.equal(retriedAfterReset.response.status, 200);
    assert.equal(retriedAfterReset.body.duplicate, false);

    const database = JSON.parse(fs.readFileSync(path.join(outputDir, 'stickers_db.json'), 'utf8'));
    assert.equal(database.schemaVersion, 2);
    assert.equal(database.stickers.length, 2);
    assert.equal(database.stickers.some((sticker) => sticker.originalUrl.includes('secret')), false);

    const har = {
      log: {
        entries: [
          {
            startedDateTime: '2026-08-18T12:01:00.000Z',
            request: { url: sourceUrl },
            response: {
              content: {
                mimeType: 'image/webp',
                encoding: 'base64',
                text: webp.toString('base64')
              }
            }
          },
          {
            request: {
              url: 'https://p16-common-sign.tiktokcdn.com/tos/video2sticker/missing.webp'
            },
            response: { content: { mimeType: 'image/webp' } }
          },
          {
            request: { url: 'https://evil.example/sticker.webp' },
            response: { content: { mimeType: 'image/webp', text: 'ignored' } }
          }
        ]
      }
    };
    const harForm = new FormData();
    harForm.append('file', new Blob([JSON.stringify(har)], { type: 'application/json' }), 'sample.har');
    const harResponse = await fetch(`${baseUrl}/api/import/har`, {
      method: 'POST',
      headers: requestHeaders(origin, cookie),
      body: harForm
    });
    assert.equal(harResponse.status, 200);
    const harResult = await harResponse.json();
    assert.equal(harResult.duplicates, 1);
    assert.equal(harResult.missingBody, 1);
    assert.equal(harResult.rejected, 1);
    assert.equal(harResult.errors.length, 0);

    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 1 }
      }
    })
      .png()
      .toBuffer();
    const manualForm = new FormData();
    manualForm.append('files', new Blob([png], { type: 'image/png' }), 'manual.png');
    const manualResponse = await fetch(`${baseUrl}/api/import/files`, {
      method: 'POST',
      headers: requestHeaders(origin, cookie),
      body: manualForm
    });
    assert.equal(manualResponse.status, 200);
    const manualResult = await manualResponse.json();
    assert.equal(manualResult.imported, 1);
    assert.equal(manualResult.results[0].sticker.outputSizeBytes, null, 'unconverted stickers report no output');
    const staticId = manualResult.results[0].sticker.id;
    assert.deepEqual(fs.readdirSync(path.join(tempDir, 'uploads')), []);

    const staticConversion = await postDashboardJson('/api/convert', { id: staticId });
    assert.equal(staticConversion.response.status, 200);
    assert.equal(staticConversion.body.sticker.status, 'converted');
    assert.equal(staticConversion.body.sticker.conversion.type, 'static');
    assert.deepEqual(staticConversion.body.sticker.selectedRange, {
      startFrame: 0,
      endFrame: 0,
      startTime: 0,
      durationMs: 0,
      durationSeconds: 0,
      frameDelays: []
    });
    assert.ok(staticConversion.body.sticker.convertedSizeBytes <= 500 * 1024);
    const staticOutputPath = path.resolve(
      outputDir,
      staticConversion.body.sticker.convertedPath.replace(/^[/\\]+/, '')
    );
    const staticOutputHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(staticOutputPath))
      .digest('hex');

    const invalidStaticRange = await postDashboardJson('/api/convert', {
      id: staticId,
      startFrame: 1
    });
    assert.equal(invalidStaticRange.response.status, 400);
    const afterFailedStaticConversion = await fetch(`${baseUrl}/api/stickers`, {
      headers: requestHeaders(origin, cookie)
    }).then((response) => response.json());
    const preservedStatic = afterFailedStaticConversion.find((sticker) => sticker.id === staticId);
    assert.equal(preservedStatic.status, 'converted');
    assert.equal(preservedStatic.outputSizeBytes, fs.statSync(staticOutputPath).size, 'output size is measured from disk');
    const storedDatabase = JSON.parse(fs.readFileSync(path.join(outputDir, 'stickers_db.json'), 'utf8'));
    assert.ok(storedDatabase.stickers.every((sticker) => !('outputSizeBytes' in sticker)), 'measured size is never persisted');
    assert.match(preservedStatic.error, /Static stickers only support frame 0/);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(staticOutputPath)).digest('hex'),
      staticOutputHash
    );

    const editedPng = await sharp({
      create: {
        width: 96,
        height: 64,
        channels: 4,
        background: { r: 210, g: 40, b: 100, alpha: 0.75 }
      }
    })
      .png()
      .toBuffer();
    const staticEdit = await postDashboardJson('/api/edit-convert-static', {
      id: staticId,
      pngBase64: `data:image/png;base64,${editedPng.toString('base64')}`
    });
    assert.equal(staticEdit.response.status, 200);
    assert.equal(staticEdit.body.sticker.conversion.type, 'static-edit');
    assert.ok(staticEdit.body.sticker.convertedSizeBytes <= 500 * 1024);

    const malformedStaticEdit = await postDashboardJson('/api/edit-convert-static', {
      id: staticId,
      pngBase64: 'data:image/png;base64,AAAA'
    });
    assert.equal(malformedStaticEdit.response.status, 400);

    const animatedFixtureDir = path.join(sandbox, 'animated-fixture');
    fs.mkdirSync(animatedFixtureDir, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      await sharp({
        create: {
          width: 72,
          height: 72,
          channels: 4,
          background: { r: 40 + index * 70, g: 180 - index * 30, b: 90, alpha: 0.9 }
        }
      })
        .png()
        .toFile(path.join(animatedFixtureDir, `frame_${String(index).padStart(4, '0')}.png`));
    }
    const animatedSourcePath = path.join(animatedFixtureDir, 'animated.webp');
    execFileSync(
      ffmpegPath,
      [
        '-y',
        '-framerate',
        '5',
        '-i',
        path.join(animatedFixtureDir, 'frame_%04d.png'),
        '-c:v',
        'libwebp_anim',
        '-lossless',
        '0',
        '-q:v',
        '80',
        '-loop',
        '0',
        '-an',
        animatedSourcePath
      ],
      { windowsHide: true, stdio: 'ignore', timeout: 30_000 }
    );
    const animatedBytes = fs.readFileSync(animatedSourcePath);
    const animatedMetadata = await sharp(animatedBytes, { animated: true }).metadata();
    assert.ok(animatedMetadata.pages >= 3);

    const animatedForm = new FormData();
    animatedForm.append(
      'files',
      new Blob([animatedBytes], { type: 'image/webp' }),
      'animated.webp'
    );
    const animatedImportResponse = await fetch(`${baseUrl}/api/import/files`, {
      method: 'POST',
      headers: requestHeaders(origin, cookie),
      body: animatedForm
    });
    assert.equal(animatedImportResponse.status, 200);
    const animatedImport = await animatedImportResponse.json();
    assert.equal(animatedImport.imported, 1);
    const animatedSticker = animatedImport.results[0].sticker;
    assert.equal(animatedSticker.isAnimated, true);

    const animatedConversion = await postDashboardJson('/api/convert', {
      id: animatedSticker.id,
      startFrame: 0,
      endFrame: 2
    });
    assert.equal(animatedConversion.response.status, 200);
    assert.equal(animatedConversion.body.sticker.conversion.type, 'animated');
    assert.equal(animatedConversion.body.sticker.selectedRange.startFrame, 0);
    assert.equal(animatedConversion.body.sticker.selectedRange.endFrame, 2);
    assert.ok(animatedConversion.body.sticker.durationMs > 0);
    assert.ok(animatedConversion.body.sticker.durationMs <= 3000);
    assert.ok(animatedConversion.body.sticker.convertedSizeBytes <= 245 * 1024);

    const animatedEdit = await postDashboardJson('/api/edit-convert-animated', {
      id: animatedSticker.id,
      startFrame: 0,
      endFrame: 2,
      transforms: {
        scale: 1.1,
        rotation: 15,
        strokeActive: true,
        strokeWidth: 2,
        strokeColor: '#ff00ff',
        topText: '<unsafe&',
        bottomText: 'ok',
        textColor: '#ffffff',
        textSize: 28
      }
    });
    assert.equal(animatedEdit.response.status, 200);
    assert.equal(animatedEdit.body.sticker.conversion.type, 'animated-edit');
    assert.equal(animatedEdit.body.sticker.conversion.details.transforms.topText, '<unsafe&');
    assert.ok(animatedEdit.body.sticker.convertedSizeBytes <= 245 * 1024);

    const invalidAnimatedEdit = await postDashboardJson('/api/edit-convert-animated', {
      id: animatedSticker.id,
      transforms: { scale: 'Infinity' }
    });
    assert.equal(invalidAnimatedEdit.response.status, 400);

    assert.deepEqual(fs.readdirSync(path.join(tempDir, 'uploads')), []);
    assert.deepEqual(fs.readdirSync(path.join(tempDir, 'har-uploads')), []);
    assert.deepEqual(
      fs.readdirSync(tempDir).filter((name) => !['uploads', 'har-uploads'].includes(name)),
      []
    );

    await rejectedWebSocket(`ws://127.0.0.1:${port}/ws`, origin);
    const init = await authorizedWebSocket(`ws://127.0.0.1:${port}/ws`, origin, cookie);
    assert.equal(init.type, 'init');
    assert.equal(init.data.stickers.length, 4);

    const beforeArchive = await fetch(`${baseUrl}/api/stickers`, {
      headers: requestHeaders(origin, cookie)
    }).then((response) => response.json());
    const activeDatabasePath = path.join(outputDir, 'stickers_db.json');
    const activeDatabaseHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(activeDatabasePath))
      .digest('hex');
    const archiveResponse = await fetch(`${baseUrl}/api/library/archive`, {
      method: 'POST',
      headers: requestHeaders(origin, cookie)
    });
    assert.equal(archiveResponse.status, 200);
    const archiveResult = await archiveResponse.json();
    assert.equal(archiveResult.archive.stickerCount, beforeArchive.length);
    const archiveManifest = JSON.parse(
      fs.readFileSync(path.join(archiveResult.archive.path, 'manifest.json'), 'utf8')
    );
    assert.equal(archiveManifest.snapshotOnly, true);
    const archivedDatabase = archiveManifest.files.find((entry) => entry.path === 'stickers_db.json');
    assert.ok(archivedDatabase);
    const archivedDatabasePath = path.join(archiveResult.archive.path, archivedDatabase.path);
    assert.equal(archivedDatabase.size, fs.statSync(archivedDatabasePath).size);
    assert.equal(
      archivedDatabase.sha256,
      crypto.createHash('sha256').update(fs.readFileSync(archivedDatabasePath)).digest('hex')
    );
    assert.equal(archivedDatabase.sha256, activeDatabaseHash);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(activeDatabasePath)).digest('hex'),
      activeDatabaseHash
    );
    const afterArchive = await fetch(`${baseUrl}/api/stickers`, {
      headers: requestHeaders(origin, cookie)
    }).then((response) => response.json());
    assert.equal(afterArchive.length, beforeArchive.length);

    const removedClear = await fetch(`${baseUrl}/api/stickers/clear`, {
      method: 'POST',
      headers: requestHeaders(origin, cookie)
    });
    assert.equal(removedClear.status, 404);
  } finally {
    await stopChild(child);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
