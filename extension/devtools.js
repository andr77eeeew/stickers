'use strict';

const HEARTBEAT_MS = 10000;

let captureEnabled = false;
let captureChain = Promise.resolve();
// 'tiktok' | 'other' | 'unknown': site of the inspected tab, learned only
// from DevTools metadata (resources and navigation), never from page code.
let inspectedSite = 'unknown';

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response || {});
    });
  });
}

function getRequestContent(request) {
  return new Promise((resolve, reject) => {
    request.getContent((content, encoding) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve({ content, encoding });
    });
  });
}

function getResponseMimeType(response) {
  const direct =
    response &&
    response.content &&
    typeof response.content.mimeType === 'string'
      ? response.content.mimeType
      : '';
  if (direct) return direct;

  const header = (response && response.headers || []).find(
    (entry) =>
      entry &&
      typeof entry.name === 'string' &&
      entry.name.toLowerCase() === 'content-type'
  );
  return header && header.value ? header.value : '';
}

function classifySite(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol === 'https:' &&
    (host === 'tiktok.com' || host.endsWith('.tiktok.com'))
  ) {
    return 'tiktok';
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    ? 'other'
    : 'unknown';
}

function detectInitialSite() {
  return new Promise((resolve) => {
    const inspected = chrome.devtools.inspectedWindow;
    if (!inspected || typeof inspected.getResources !== 'function') {
      resolve('unknown');
      return;
    }
    inspected.getResources((resources) => {
      const documents = (resources || []).filter(
        (resource) => resource && resource.type === 'document'
      );
      const sites = documents.map((resource) => classifySite(resource.url));
      if (sites.includes('tiktok')) resolve('tiktok');
      else if (sites.includes('other')) resolve('other');
      else resolve('unknown');
    });
  });
}

function listenerInfo() {
  const inspected = chrome.devtools.inspectedWindow;
  return {
    tabId: inspected ? inspected.tabId : undefined,
    site: inspectedSite
  };
}

function reportEvent(kind, reason) {
  return sendRuntimeMessage({
    type: 'DEVTOOLS_EVENT',
    kind,
    reason,
    ...listenerInfo()
  }).catch(() => undefined);
}

function sendHeartbeat() {
  if (!captureEnabled) return Promise.resolve();
  return sendRuntimeMessage({
    type: 'DEVTOOLS_HEARTBEAT',
    ...listenerInfo()
  }).catch(() => undefined);
}

async function handleFinishedRequest(request, policy) {
  if (!captureEnabled || inspectedSite === 'other') return;

  const requestUrl =
    request && request.request && typeof request.request.url === 'string'
      ? request.request.url
      : '';
  const response = request && request.response;
  const status = Number(response && response.status);
  if (Number.isFinite(status) && (status < 200 || status >= 400)) return;

  const resource = StickerPolicy.classifyStickerResource(
    requestUrl,
    getResponseMimeType(response),
    policy
  );
  if (!resource.allowed) return;

  const reportedSize = Number(
    response && response.content && response.content.size
  );
  if (
    Number.isFinite(reportedSize) &&
    reportedSize > policy.maxBodyBytes
  ) {
    await reportEvent('skipped', 'body_too_large');
    return;
  }

  let body;
  try {
    body = await getRequestContent(request);
  } catch {
    await reportEvent('body_read_failed', 'get_content_failed');
    return;
  }

  const encoded = CapturePayload.contentToBase64(
    body.content,
    body.encoding,
    policy.maxBodyBytes
  );
  if (!encoded.ok) {
    await reportEvent('skipped', encoded.reason);
    return;
  }

  // The header is only a hint; the bytes decide the sticker type.
  const detectedMimeType = CapturePayload.detectBase64ImageMime(
    encoded.contentBase64
  );
  if (!policy.allowedMimeTypes.includes(detectedMimeType)) {
    await reportEvent('skipped', 'content_type_mismatch');
    return;
  }

  let result;
  try {
    result = await sendRuntimeMessage({
      type: 'QUEUE_CAPTURE',
      payload: {
        source: 'devtools',
        sourceUrl: resource.sourceUrl,
        mimeType: detectedMimeType,
        observedAt: new Date().toISOString(),
        contentBase64: encoded.contentBase64
      }
    });
  } catch {
    await reportEvent('body_read_failed', 'background_unavailable');
    return;
  }

  if (!result.ok) {
    await reportEvent('skipped', result.reason || 'queue_rejected');
  }
}

async function startCapture() {
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get({ captureEnabled: false }, resolve);
  });
  captureEnabled = settings.captureEnabled !== false;

  const policy = await StickerPolicy.loadPolicy(
    chrome.runtime.getURL('shared/sticker-policy.json')
  );

  chrome.devtools.network.onRequestFinished.addListener((request) => {
    captureChain = captureChain
      .then(() => handleFinishedRequest(request, policy))
      .catch(() => reportEvent('body_read_failed', 'capture_pipeline_failed'));
  });

  if (chrome.devtools.network.onNavigated) {
    chrome.devtools.network.onNavigated.addListener((url) => {
      const site = classifySite(url);
      if (site === inspectedSite) return;
      inspectedSite = site;
      if (captureEnabled) void reportEvent('site_changed');
    });
  }

  inspectedSite = await detectInitialSite();
  if (captureEnabled) await reportEvent('listening');
  setInterval(() => void sendHeartbeat(), HEARTBEAT_MS);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.captureEnabled) {
    captureEnabled = changes.captureEnabled.newValue !== false;
    if (captureEnabled) void reportEvent('listening');
  }
});

chrome.devtools.panels.create(
  'Sticker Capture',
  '',
  'panel.html'
);

startCapture().catch((error) => {
  void reportEvent(
    'body_read_failed',
    error && error.message ? error.message : 'listener_start_failed'
  );
});
