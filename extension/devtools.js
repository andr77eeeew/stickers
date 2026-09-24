'use strict';

let captureEnabled = false;
let captureChain = Promise.resolve();

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

function reportEvent(kind, reason) {
  return sendRuntimeMessage({
    type: 'DEVTOOLS_EVENT',
    kind,
    reason
  }).catch(() => undefined);
}

async function handleFinishedRequest(request, policy) {
  if (!captureEnabled) return;

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

  let result;
  try {
    result = await sendRuntimeMessage({
      type: 'QUEUE_CAPTURE',
      payload: {
        source: 'devtools',
        sourceUrl: resource.sourceUrl,
        mimeType: resource.mimeType,
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

  await reportEvent('listening', 'network_listener_ready');
  await sendRuntimeMessage({ type: 'DEVTOOLS_HEARTBEAT' });
  setInterval(() => {
    void sendRuntimeMessage({ type: 'DEVTOOLS_HEARTBEAT' }).catch(
      () => undefined
    );
  }, 10000);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.captureEnabled) {
    captureEnabled = changes.captureEnabled.newValue !== false;
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
