'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3001';
const elements = {
  overall: document.getElementById('overall'),
  overallText: document.getElementById('overallText'),
  listenerState: document.getElementById('listenerState'),
  serverState: document.getElementById('serverState'),
  queueState: document.getElementById('queueState'),
  sessionLine: document.getElementById('sessionLine'),
  warnings: document.getElementById('warnings'),
  lastEvent: document.getElementById('lastEvent'),
  captureEnabled: document.getElementById('captureEnabled'),
  settingsBox: document.getElementById('settingsBox'),
  settingsLabel: document.getElementById('settingsLabel'),
  connectSteps: document.getElementById('connectSteps'),
  serverUrl: document.getElementById('serverUrl'),
  ingestToken: document.getElementById('ingestToken'),
  generateToken: document.getElementById('generateToken'),
  copyToken: document.getElementById('copyToken'),
  saveSettings: document.getElementById('saveSettings'),
  saveLabel: document.getElementById('saveLabel'),
  retryQueue: document.getElementById('retryQueue'),
  message: document.getElementById('message'),
  heldSection: document.getElementById('heldSection'),
  heldList: document.getElementById('heldList')
};
const WARNINGS_SHOWN = 2;
let heldSignature = '';
let warningsSignature = '';
let needsSetup = null;

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
  elements.message.className = `inline-alert ${isError ? 'tone-problem' : 'tone-ok'}`;
  elements.message.replaceChildren(
    Icons.element(isError ? 'octagon-x' : 'circle-check'),
    document.createTextNode(text)
  );
}

// A status row value: a tone dot and the text, as in the dashboard.
function setDescribed(element, description) {
  const dot = document.createElement('span');
  dot.className = 'dot';
  element.className = `check-value tone-${description.tone}`;
  element.replaceChildren(dot, document.createTextNode(description.text));
}

function renderOverall(status) {
  const overall = StatusText.describeOverall(status);
  elements.overall.className = `status-pill tone-${overall.tone}`;
  if (elements.overallText.textContent !== overall.text) {
    elements.overallText.textContent = overall.text;
  }
}

// Without a token the settings open as the Connect step.
function renderSetup(hasToken) {
  const setup = !hasToken;
  if (setup === needsSetup) return;
  const justConnected = needsSetup === true && !setup;
  needsSetup = setup;
  if (justConnected) elements.settingsBox.open = false;
  elements.settingsBox.classList.toggle('needs-setup', setup);
  elements.settingsLabel.textContent = setup ? 'Connect to Sticker Workspace' : 'Settings';
  elements.saveLabel.textContent = setup ? 'Connect' : 'Save and reconnect';
  elements.connectSteps.hidden = !setup;
  if (setup) elements.settingsBox.open = true;
}

function renderWarnings(status) {
  const warnings = (status.warnings || [])
    .map(StatusText.describeWarning)
    .filter(Boolean)
    .slice(0, WARNINGS_SHOWN);
  const signature = warnings.map((warning) => warning.text).join('|');
  if (signature === warningsSignature) return;
  warningsSignature = signature;
  elements.warnings.replaceChildren(...warnings.map((warning) => {
    const item = document.createElement('li');
    item.className = `inline-alert tone-${warning.tone}`;
    item.append(Icons.element(Icons.TONE_ICONS[warning.tone]), document.createTextNode(warning.text));
    return item;
  }));
}

function renderStatus(status) {
  elements.captureEnabled.checked = status.captureEnabled !== false;
  renderOverall(status);
  renderSetup(status.hasToken);
  setDescribed(elements.listenerState, StatusText.describeListener(status.listenerState));
  setDescribed(elements.serverState, StatusText.describeServer(status.serverState));
  setDescribed(
    elements.queueState,
    StatusText.describeQueue(status.queue, status.pausedReason)
  );
  const session = StatusText.describeSession(status.session, Date.now());
  setDescribed(elements.sessionLine, session || { tone: 'ok', text: 'No capture session yet' });
  renderWarnings(status);
  elements.lastEvent.textContent = status.lastEvent ? `Last: ${status.lastEvent}` : 'No activity yet.';
}

function base64ToBlob(contentBase64, mimeType) {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

async function saveHeldItem(item) {
  const file = await sendMessage({ type: 'GET_ITEM_FILE', id: item.id });
  if (!file.ok) {
    showMessage('This capture is no longer held.', true);
    return;
  }
  const url = URL.createObjectURL(base64ToBlob(file.contentBase64, file.mimeType));
  const link = document.createElement('a');
  link.href = url;
  link.download = StatusText.heldFileName(item);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showMessage('File saved. Import it in the dashboard with Import.', false);
}

function iconButton(icon, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small';
  const label = document.createElement('span');
  label.textContent = text;
  button.append(Icons.element(icon), label);
  return { button, label };
}

function renderHeldItem(item) {
  const row = document.createElement('li');
  row.className = item.state === 'paused' ? 'held-item is-paused' : 'held-item';
  const label = document.createElement('span');
  label.className = 'held-reason';
  const reason = item.state === 'paused'
    ? 'Paused: session limit'
    : `Blocked: ${StatusText.describeReason(item.lastError) || 'rejected'}`;
  label.textContent = `${reason} · ${StatusText.formatBytesFromBase64(item.base64Length)}`;

  const { button: save } = iconButton('download', 'Save file');
  save.addEventListener('click', () => {
    void saveHeldItem(item).catch(() => showMessage('Unable to save the file.', true));
  });

  // Discarding deletes the only copy of the bytes, so it takes two clicks.
  const { button: discard, label: discardLabel } = iconButton('trash-2', 'Discard');
  discard.addEventListener('click', async () => {
    if (discard.dataset.armed !== 'true') {
      discard.dataset.armed = 'true';
      discard.classList.add('btn-danger');
      discardLabel.textContent = 'Confirm discard';
      return;
    }
    discard.disabled = true;
    const result = await sendMessage({ type: 'DISCARD_ITEM', id: item.id }).catch(() => ({}));
    showMessage(result.ok ? 'Capture discarded.' : 'Unable to discard the capture.', !result.ok);
    await refreshHeld();
    await refreshStatus();
  });

  const actions = document.createElement('div');
  actions.className = 'held-actions';
  actions.append(save, discard);
  row.append(label, actions);
  return row;
}

async function refreshHeld() {
  let items = [];
  try {
    const response = await sendMessage({ type: 'LIST_HELD' });
    if (response.ok) items = response.items || [];
  } catch {
    return;
  }
  const signature = items.map((item) => `${item.id}:${item.state}`).join('|');
  if (signature === heldSignature) return;
  heldSignature = signature;
  elements.heldSection.hidden = items.length === 0;
  elements.heldList.replaceChildren(...items.map(renderHeldItem));
}

async function refreshStatus(messageType = 'GET_STATUS') {
  try {
    const response = await sendMessage({ type: messageType });
    if (response.ok) renderStatus(response);
  } catch {
    setDescribed(elements.serverState, { tone: 'problem', text: 'Extension unavailable' });
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
  await refreshHeld();
}

elements.generateToken.addEventListener('click', () => {
  elements.ingestToken.value = generateToken();
  showMessage('New token generated. Save it, then set it as INGEST_TOKEN in .env and restart the server.', false);
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
    elements.serverUrl.focus();
    return;
  }
  if (!ingestToken) {
    showMessage('Paste the connection token from the dashboard first.', true);
    elements.ingestToken.focus();
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
    const status = await sendMessage({ type: 'GET_STATUS' });
    showMessage(
      status.serverState === 'online'
        ? 'Connected to the local server.'
        : `Saved. Local server: ${StatusText.describeServer(status.serverState).text}.`,
      status.serverState !== 'online'
    );
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
    showMessage('Held captures released for another local delivery attempt.', false);
    await refreshHeld();
  } catch {
    showMessage('Unable to retry the held captures.', true);
  } finally {
    elements.retryQueue.disabled = false;
  }
});

Icons.hydrate(document);
void load();
setInterval(() => {
  void refreshStatus();
  void refreshHeld();
}, 2000);
