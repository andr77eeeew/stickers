'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const extensionRoot = path.resolve(__dirname, '..', '..', 'extension');
const StickerPolicy = require(path.join(
  extensionRoot,
  'shared',
  'stickerPolicy.js'
));
const CapturePayload = require(path.join(
  extensionRoot,
  'shared',
  'capturePayload.js'
));
const DeliveryPolicy = require(path.join(
  extensionRoot,
  'shared',
  'deliveryPolicy.js'
));
const policy = StickerPolicy.validatePolicy(
  JSON.parse(
    fs.readFileSync(
      path.join(extensionRoot, 'shared', 'sticker-policy.json'),
      'utf8'
    )
  )
);

const observedUrl =
  'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/demo.awebp?x-sensitive=1#fragment';

test('accepts observed DM sticker URL and strips query and fragment', () => {
  assert.deepEqual(
    StickerPolicy.classifyStickerResource(
      observedUrl,
      'image/webp; charset=binary',
      policy
    ),
    {
      allowed: true,
      mimeType: 'image/webp',
      sourceUrl:
        'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/demo.awebp'
    }
  );
});

test('accepts exact common host only with a sticker-specific path', () => {
  assert.equal(
    StickerPolicy.classifyStickerResource(
      'https://p16-common-sign.tiktokcdn.com/media/sticker/demo.webp?token=secret',
      'image/webp',
      policy
    ).allowed,
    true
  );
  assert.equal(
    StickerPolicy.classifyStickerResource(
      'https://p16-common-sign.tiktokcdn.com/musically-maliva-obj/id~tplv-tiktokx-cropcenter:720:720.jpeg',
      'image/jpeg',
      policy
    ).reason,
    'rejected_path'
  );
});

test('rejects lookalike, nested, non-HTTPS, credential and port URLs', () => {
  const rejected = [
    'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com.attacker.example/obj/video2sticker/a.awebp',
    'https://nested.p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/a.awebp',
    'https://evil-p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/a.awebp',
    'https://p16-common-sign.tiktokcdn.com.evil.example/media/sticker/a.webp',
    'http://p16-common-sign.tiktokcdn.com/media/sticker/a.webp',
    'https://user:pass@p16-common-sign.tiktokcdn.com/media/sticker/a.webp',
    'https://p16-common-sign.tiktokcdn.com:444/media/sticker/a.webp'
  ];
  for (const url of rejected) {
    assert.equal(
      StickerPolicy.classifyStickerResource(url, 'image/webp', policy).allowed,
      false,
      url
    );
  }
});

test('requires sticker path marker, allowed extension, and allowed MIME', () => {
  assert.equal(
    StickerPolicy.classifyStickerResource(
      'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/media/demo.webp',
      'image/webp',
      policy
    ).reason,
    'path_not_sticker_specific'
  );
  assert.equal(
    StickerPolicy.classifyStickerResource(
      'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/media/sticker/demo.svg',
      'image/webp',
      policy
    ).reason,
    'unsupported_extension'
  );  assert.equal(
    StickerPolicy.classifyStickerResource(
      'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/media/stickerish/demo.webp',
      'image/webp',
      policy
    ).reason,
    'path_not_sticker_specific'
  );
  assert.equal(
    StickerPolicy.classifyStickerResource(observedUrl, 'text/html', policy)
      .reason,
    'mime_not_allowed'
  );
});

test('normalizes base64 and plain binary getContent bodies', () => {
  const binary = 'RIFF\x00\x00\x00\x00WEBP';
  const fromPlain = CapturePayload.contentToBase64(binary, '', 100);
  assert.equal(fromPlain.ok, true);
  assert.equal(CapturePayload.detectImageMime(
    CapturePayload.base64ToBytes(fromPlain.contentBase64)
  ), 'image/webp');

  const fromBase64 = CapturePayload.contentToBase64(
    `  ${fromPlain.contentBase64}\n`,
    'base64',
    100
  );
  assert.equal(fromBase64.ok, true);
  assert.equal(fromBase64.contentBase64, fromPlain.contentBase64);
  assert.equal(
    CapturePayload.contentToBase64(binary, 'gzip', 100).reason,
    'unsupported_body_encoding'
  );
});

test('validates magic bytes before a capture enters the durable queue', () => {
  const webp = Buffer.from([
    0x52, 0x49, 0x46, 0x46,
    0x00, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50
  ]).toString('base64');
  const valid = CapturePayload.validateCapturePayload(
    {
      source: 'devtools',
      sourceUrl: observedUrl,
      mimeType: 'image/webp',
      contentBase64: webp,
      observedAt: '2026-08-18T12:00:00.000Z'
    },
    policy
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.payload.sourceUrl.includes('?'), false);

  const mismatch = CapturePayload.validateCapturePayload(
    {
      source: 'devtools',
      sourceUrl: observedUrl,
      mimeType: 'image/webp',
      contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64'),
      observedAt: '2026-08-18T12:00:00.000Z'
    },
    policy
  );
  assert.equal(mismatch.reason, 'content_type_mismatch');
});

test('local delivery policy rejects non-loopback and lookalike servers', () => {
  assert.equal(
    DeliveryPolicy.normalizeServerUrl('http://127.0.0.1:3001/'),
    'http://127.0.0.1:3001'
  );
  assert.equal(
    DeliveryPolicy.normalizeServerUrl('http://localhost:3001'),
    'http://localhost:3001'
  );
  for (const url of [
    'http://localhost.evil:3001',
    'https://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3001/path',
    'http://user@127.0.0.1:3001'
  ]) {
    assert.equal(DeliveryPolicy.normalizeServerUrl(url), null, url);
  }
});

test('delivery ACK and retry rules preserve at-least-once semantics', () => {
  assert.deepEqual(
    DeliveryPolicy.classifyIngestResponse(200, { success: true }),
    { action: 'ack', duplicate: false, serverState: 'online' }
  );
  assert.deepEqual(
    DeliveryPolicy.classifyIngestResponse(200, {
      success: true,
      duplicate: true
    }),
    { action: 'ack', duplicate: true, serverState: 'online' }
  );
  assert.equal(
    DeliveryPolicy.classifyIngestResponse(422, { error: 'bad body' }).action,
    'block'
  );
  for (const status of [401, 403]) {
    assert.equal(
      DeliveryPolicy.classifyIngestResponse(status, {}).action,
      'block'
    );
  }
  assert.equal(
    DeliveryPolicy.classifyIngestResponse(500, {}).action,
    'retry'
  );
  assert.equal(DeliveryPolicy.computeBackoffMs(0), 1000);
  assert.equal(DeliveryPolicy.computeBackoffMs(20), 60000);
});

test('manifest has no TikTok access or automation permissions', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8')
  );
  assert.equal(manifest.devtools_page, 'devtools.html');
  assert.equal('content_scripts' in manifest, false);
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'storage']);
  assert.deepEqual(manifest.host_permissions.sort(), [
    'http://127.0.0.1:3001/*',
    'http://localhost:3001/*'
  ]);
  for (const permission of ['debugger', 'tabs', 'webRequest']) {
    assert.equal(manifest.permissions.includes(permission), false);
  }
});

test('DevTools capture reads response content and never calls fetch', () => {
  const source = ['devtools.js', 'shared/capturePipeline.js']
    .map((file) => fs.readFileSync(path.join(extensionRoot, file), 'utf8'))
    .join('\n');
  assert.match(source, /\.getContent\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /MutationObserver|document\.body|querySelector/);
  assert.equal(fs.existsSync(path.join(extensionRoot, 'content.js')), false);
});

test('mock DevTools API queues only an already-loaded response body', async () => {
  const source = fs.readFileSync(
    path.join(extensionRoot, 'devtools.js'),
    'utf8'
  );
  const messages = [];
  let finishedListener;
  let getContentCalls = 0;

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (resource) => `chrome-extension://test/${resource}`,
      sendMessage(message, callback) {
        messages.push(message);
        callback({ ok: true, queued: message.type === 'QUEUE_CAPTURE' });
      }
    },
    storage: {
      local: {
        get(_defaults, callback) {
          callback({ captureEnabled: true });
        }
      },
      onChanged: { addListener() {} }
    },
    devtools: {
      network: {
        onRequestFinished: {
          addListener(listener) {
            finishedListener = listener;
          }
        }
      },
      panels: { create() {} }
    }
  };

  vm.runInNewContext(source, {
    chrome,
    CapturePayload,
    CapturePipeline: require(path.join(extensionRoot, 'shared', 'capturePipeline.js')),
    StickerPolicy: {
      ...StickerPolicy,
      loadPolicy: async () => policy
    },
    setInterval: () => 1,
    console
  }, { filename: 'devtools.js' });

  for (let step = 0; step < 10 && !finishedListener; step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof finishedListener, 'function');

  const contentBase64 = Buffer.from([
    0x52, 0x49, 0x46, 0x46,
    0x00, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50
  ]).toString('base64');
  finishedListener({
    request: { url: observedUrl },
    response: {
      status: 200,
      content: { mimeType: 'image/webp', size: 12 }
    },
    getContent(callback) {
      getContentCalls += 1;
      callback(contentBase64, 'base64');
    }
  });

  for (
    let step = 0;
    step < 10 && !messages.some((entry) => entry.type === 'QUEUE_CAPTURE');
    step += 1
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const queued = messages.find((entry) => entry.type === 'QUEUE_CAPTURE');
  assert.equal(getContentCalls, 1);
  assert.ok(queued);
  assert.deepEqual(Object.keys(queued.payload).sort(), [
    'contentBase64',
    'mimeType',
    'observedAt',
    'source',
    'sourceUrl'
  ]);
  assert.equal(queued.payload.source, 'devtools');
  assert.equal(queued.payload.sourceUrl.includes('?'), false);
  assert.equal(queued.payload.contentBase64, contentBase64);
  assert.equal('headers' in queued.payload, false);
  assert.equal('cookies' in queued.payload, false);
});
test('capture requires an explicit v2 opt-in', () => {
  const background = fs.readFileSync(
    path.join(extensionRoot, 'background.js'),
    'utf8'
  );
  const devtools = fs.readFileSync(
    path.join(extensionRoot, 'devtools.js'),
    'utf8'
  );
  assert.match(background, /current\.settingsVersion !== 2/);
  assert.match(background, /updates\.captureEnabled = false/);
  assert.match(devtools, /get\(\{ captureEnabled: false \}/);
});
test('popup and panel share one status vocabulary', () => {
  const StatusText = require(path.join(extensionRoot, 'shared', 'statusText.js'));
  assert.deepEqual(StatusText.describeListener('watching'), { tone: 'ok', text: 'Watching TikTok tab' });
  assert.equal(StatusText.describeListener('listening').text, 'DevTools not open', 'no legacy "Listening" claim');
  assert.equal(StatusText.describeServer('unauthorized').text, 'Token rejected');
  assert.equal(StatusText.describeServer('capture_disabled').tone, 'problem');
  assert.deepEqual(StatusText.describeQueue({ count: 2, paused: 2 }, 'capture_budget_exhausted'), {
    tone: 'pending',
    text: '2 held: budget paused'
  });
  assert.equal(StatusText.describeQueue({ count: 3, blocked: 1 }).tone, 'problem');
  assert.equal(StatusText.describeQueue({ count: 0 }).text, 'Empty');
  assert.equal(
    StatusText.heldFileName({ id: 'abcdef0123456789', mimeType: 'image/webp' }),
    'sticker_abcdef012345.webp'
  );
  assert.equal(StatusText.formatBytesFromBase64(4096), '3 KB');
  assert.equal(StatusText.formatBytesFromBase64(2796204), '2.0 MB');
});
