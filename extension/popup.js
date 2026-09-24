'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3001';
const elements = {
  listenerState: document.getElementById('listenerState'),
  serverState: document.getElementById('serverState'),
  queueState: document.getElementById('queueState'),
  lastEvent: document.getElementById('lastEvent'),
  captureEnabled: document.getElementById('captureEnabled'),
  serverUrl: document.getElementById('serverUrl'),
  ingestToken: document.getElementById('ingestToken'),
  generateToken: document.getElementById('generateToken'),
  copyToken: document.getElementById('copyToken'),
  saveSettings: document.getElementById('saveSettings'),
  retryQueue: document.getElementById('retryQueue'),
  message: document.getElementById('message')
};

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function sendMessage(message) {
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

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function isValidServerUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(parsed.hostname.toLowerCase()) &&
      parsed.port === '3001' &&
      (parsed.pathname === '/' || parsed.pathname === '') &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function showMessage(text, isError) {
  elements.message.hidden = false;
  elements.message.textContent = text;
  elements.message.className = isError ? 'message error' : 'message';
}

function setState(element, text, className) {
  element.textContent = text;
  element.className = className || '';
}

function renderStatus(status) {
  elements.captureEnabled.checked = status.captureEnabled !== false;
  setState(
    elements.listenerState,
    status.listenerState === 'listening' ? 'Listening' : 'DevTools closed',
    status.listenerState === 'listening' ? 'ok' : 'warn'
  );

  const labels = {
    online: 'Online',
    offline: 'Offline',
    unauthorized: 'Token rejected',
    configuration_required: 'Setup required',
    unknown: 'Not checked'
  };
  setState(
    elements.serverState,
    labels[status.serverState] || status.serverState,
    status.serverState === 'online'
      ? 'ok'
      : status.serverState === 'unknown'
        ? 'warn'
        : 'bad'
  );

  const queue = status.queue || {};
  setState(
    elements.queueState,
    queue.blocked
      ? `${queue.count || 0} (${queue.blocked} blocked)`
      : String(queue.count || 0),
    queue.blocked ? 'bad' : queue.count ? 'warn' : 'ok'
  );
  elements.lastEvent.textContent = status.lastError
    ? `${status.lastEvent || 'Issue'}: ${status.lastError}`
    : status.lastEvent || 'No activity yet.';
}

async function refreshStatus(messageType = 'GET_STATUS') {
  try {
    const response = await sendMessage({ type: messageType });
    if (response.ok) renderStatus(response);
  } catch {
    setState(elements.serverState, 'Extension unavailable', 'bad');
  }
}

async function load() {
  const settings = await storageGet({
    serverUrl: DEFAULT_SERVER_URL,
    ingestToken: '',
    captureEnabled: false
  });
  elements.serverUrl.value = settings.serverUrl || DEFAULT_SERVER_URL;
  elements.ingestToken.value = settings.ingestToken || '';
  elements.captureEnabled.checked = settings.captureEnabled !== false;
  await refreshStatus('PING_SERVER');
}

elements.generateToken.addEventListener('click', () => {
  elements.ingestToken.value = generateToken();
  showMessage('New token generated. Save it, then copy it to server .env.', false);
});

elements.copyToken.addEventListener('click', async () => {
  const token = elements.ingestToken.value.trim();
  if (!token) {
    showMessage('Generate or enter a token first.', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    showMessage('Token copied.', false);
  } catch {
    elements.ingestToken.focus();
    elements.ingestToken.select();
    showMessage('Press Ctrl+C to copy the selected token.', false);
  }
});

elements.saveSettings.addEventListener('click', async () => {
  const serverUrl = elements.serverUrl.value.trim();
  const ingestToken = elements.ingestToken.value.trim();
  if (!isValidServerUrl(serverUrl)) {
    showMessage('Use exactly http://127.0.0.1:3001 or http://localhost:3001.', true);
    return;
  }
  if (!ingestToken) {
    showMessage('Bearer token is required.', true);
    return;
  }

  elements.saveSettings.disabled = true;
  try {
    await storageSet({
      serverUrl: new URL(serverUrl).origin,
      ingestToken,
      captureEnabled: elements.captureEnabled.checked
    });
    await sendMessage({ type: 'SETTINGS_UPDATED' });
    await refreshStatus('PING_SERVER');
    showMessage('Settings saved. Use this token as server INGEST_TOKEN.', false);
  } catch (error) {
    showMessage(error.message || 'Unable to save settings.', true);
  } finally {
    elements.saveSettings.disabled = false;
  }
});

elements.captureEnabled.addEventListener('change', async () => {
  await storageSet({ captureEnabled: elements.captureEnabled.checked });
  await refreshStatus();
});

elements.retryQueue.addEventListener('click', async () => {
  elements.retryQueue.disabled = true;
  try {
    const response = await sendMessage({ type: 'RETRY_QUEUE' });
    if (response.ok) renderStatus(response);
    showMessage('Blocked items released for another local delivery attempt.', false);
  } catch {
    showMessage('Unable to retry the queue.', true);
  } finally {
    elements.retryQueue.disabled = false;
  }
});

void load();
setInterval(() => void refreshStatus(), 2000);
