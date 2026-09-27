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

async function startCapture() {
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get({ captureEnabled: false }, resolve);
  });
  captureEnabled = settings.captureEnabled !== false;

  const policy = await StickerPolicy.loadPolicy(
    chrome.runtime.getURL('shared/sticker-policy.json')
  );
  const pipeline = CapturePipeline.createPipeline({
    policy,
    origin: 'live',
    send: (message) => sendRuntimeMessage(
      message.type === 'DEVTOOLS_EVENT' ? { ...message, ...listenerInfo() } : message
    ),
    lastError: () => chrome.runtime.lastError
  });

  chrome.devtools.network.onRequestFinished.addListener((request) => {
    if (!captureEnabled || inspectedSite === 'other') return;
    captureChain = captureChain
      .then(() => pipeline.processEntry(request))
      .catch(() => reportEvent('body_read_failed', 'capture_pipeline_failed'));
  });

  if (chrome.devtools.network.onNavigated) {
    chrome.devtools.network.onNavigated.addListener((url) => {
      const site = CapturePipeline.classifySite(url);
      // Page loads of the TikTok tab count towards the "frequent reloads" warning.
      if (captureEnabled && site === 'tiktok') {
        void sendRuntimeMessage({ type: 'SAFETY_SIGNAL', signal: 'navigation' }).catch(() => undefined);
      }
      if (site === inspectedSite) return;
      inspectedSite = site;
      if (captureEnabled) void reportEvent('site_changed');
    });
  }

  inspectedSite = await CapturePipeline.detectInspectedSite(
    chrome.devtools.inspectedWindow
  );
  if (captureEnabled) await reportEvent('listening');
  setInterval(() => void sendHeartbeat(), HEARTBEAT_MS);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.captureEnabled) {
    captureEnabled = changes.captureEnabled.newValue !== false;
    if (captureEnabled) void reportEvent('listening');
  }
});

// Best effort: lets the dashboard show "DevTools not open" right away instead
// of waiting for the heartbeat to go stale.
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => {
    chrome.runtime.sendMessage({ type: 'DEVTOOLS_CLOSED', ...listenerInfo() }, () => {
      void chrome.runtime.lastError;
    });
  });
}

chrome.devtools.panels.create(
  'Sticker Capture',
  'icons/icon-16.png',
  'panel.html'
);

startCapture().catch((error) => {
  void reportEvent(
    'body_read_failed',
    error && error.message ? error.message : 'listener_start_failed'
  );
});
