'use strict';

const elements = {
  captureEnabled: document.getElementById('captureEnabled'),
  listenerState: document.getElementById('listenerState'),
  serverState: document.getElementById('serverState'),
  queueState: document.getElementById('queueState'),
  deliveredCount: document.getElementById('deliveredCount'),
  lastEvent: document.getElementById('lastEvent'),
  events: document.getElementById('events'),
  retryQueue: document.getElementById('retryQueue'),
  captureLog: document.getElementById('captureLog'),
  clearFeed: document.getElementById('clearFeed'),
  logResult: document.getElementById('logResult'),
  feed: document.getElementById('feed'),
  feedEmpty: document.getElementById('feedEmpty'),
  diagnosticsBox: document.getElementById('diagnosticsBox'),
  diagnosticsSummary: document.getElementById('diagnosticsSummary'),
  diagnostics: document.getElementById('diagnostics')
};
let feedSignature = '';
let diagnosticsSignature = '';
const TONE_CLASS = Object.freeze({ ok: 'ok', pending: 'warn', problem: 'bad' });
const EVENTS_SHOWN = 6;

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

function setState(element, text, className) {
  element.textContent = text;
  element.className = className || '';
}

function setDescribed(element, description) {
  setState(element, description.text, TONE_CLASS[description.tone]);
}

function renderEvents(events) {
  const items = (events || []).slice(1, EVENTS_SHOWN).map((event) => {
    const item = document.createElement('li');
    item.className = event.tone === 'problem' ? 'bad' : event.tone === 'warning' ? 'warn' : '';
    const time = document.createElement('time');
    time.dateTime = new Date(event.at).toISOString();
    time.textContent = new Date(event.at).toLocaleTimeString();
    item.append(time, ` ${event.text}`);
    return item;
  });
  elements.events.replaceChildren(...items);
}

function render(status) {
  elements.captureEnabled.checked = status.captureEnabled !== false;
  setDescribed(elements.listenerState, StatusText.describeListener(status.listenerState));
  setDescribed(elements.serverState, StatusText.describeServer(status.serverState));
  setDescribed(
    elements.queueState,
    StatusText.describeQueue(status.queue, status.pausedReason)
  );
  elements.deliveredCount.textContent = String(
    status.counters && status.counters.delivered || 0
  );
  elements.lastEvent.textContent =
    status.lastEvent || 'No capture events yet.';
  renderEvents(status.events);
}

function libraryLink(serverUrl, stickerId) {
  const url = new URL('/', serverUrl);
  url.searchParams.set('id', stickerId);
  return url.href;
}

function renderFeedItem(item, serverUrl) {
  const row = document.createElement('li');
  row.className = 'feed-item';

  let preview;
  if (item.thumbnail) {
    preview = document.createElement('img');
    preview.src = item.thumbnail;
    preview.alt = '';
  } else {
    preview = document.createElement('span');
    preview.className = 'feed-placeholder';
    preview.textContent = (item.mimeType || '').replace('image/', '') || '—';
  }
  preview.classList.add('feed-thumb');

  const body = document.createElement('div');
  body.className = 'feed-body';
  const description = StatusText.describeFeedItem(item);
  const state = document.createElement('strong');
  state.className = TONE_CLASS[description.tone];
  state.textContent = description.text;
  const meta = document.createElement('span');
  meta.className = 'feed-meta';
  const time = new Date(item.at).toLocaleTimeString();
  meta.textContent = item.origin === 'network_log' ? `${time} · from Network log` : time;
  body.append(state, meta);

  if (item.stickerId) {
    const link = document.createElement('a');
    link.href = libraryLink(serverUrl, item.stickerId);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open in library';
    body.append(link);
  }

  row.append(preview, body);
  return row;
}

function renderDiagnostics(diagnostics) {
  const entries = Object.entries(diagnostics || {}).sort((left, right) => right[1].count - left[1].count);
  const signature = JSON.stringify(entries.map(([reason, value]) => [reason, value.count]));
  if (signature === diagnosticsSignature) return;
  diagnosticsSignature = signature;
  const total = entries.reduce((sum, [, value]) => sum + value.count, 0);
  elements.diagnosticsBox.hidden = total === 0;
  elements.diagnosticsSummary.textContent = `TikTok images refused by the policy: ${total}`;
  elements.diagnostics.replaceChildren(...entries.map(([reason, value]) => {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = `${reason.replace(/_/g, ' ')} · ${value.count}`;
    const examples = document.createElement('ul');
    for (const pattern of value.examples) {
      const example = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = pattern;
      example.append(code);
      examples.append(example);
    }
    item.append(label, examples);
    return item;
  }));
}

async function refreshFeed() {
  let feed;
  try {
    feed = await sendMessage({ type: 'GET_FEED' });
  } catch {
    return;
  }
  if (!feed.ok) return;
  const signature = feed.items.map((item) => `${item.id}:${item.state}:${item.stickerId}:${item.reason}`).join('|');
  if (signature !== feedSignature) {
    feedSignature = signature;
    elements.feed.replaceChildren(...feed.items.map((item) => renderFeedItem(item, feed.serverUrl)));
    elements.feedEmpty.hidden = feed.items.length > 0;
  }
  renderDiagnostics(feed.diagnostics);
}

function getHar() {
  return new Promise((resolve, reject) => {
    const network = chrome.devtools && chrome.devtools.network;
    if (!network || typeof network.getHAR !== 'function') {
      reject(new Error('The Network log is not available in this window.'));
      return;
    }
    network.getHAR((log) => resolve(log && Array.isArray(log.entries) ? log.entries : []));
  });
}

function showLogResult(text) {
  elements.logResult.hidden = false;
  elements.logResult.textContent = text;
}

// Reads responses DevTools already recorded; no request is repeated.
async function captureFromNetworkLog() {
  elements.captureLog.disabled = true;
  showLogResult('Checking the Network log…');
  try {
    const site = await CapturePipeline.detectInspectedSite(chrome.devtools.inspectedWindow);
    if (site === 'other') {
      showLogResult('DevTools is open on another site. Open it on the TikTok tab to capture from its Network log.');
      return;
    }
    const policy = await StickerPolicy.loadPolicy(chrome.runtime.getURL('shared/sticker-policy.json'));
    const pipeline = CapturePipeline.createPipeline({
      policy,
      origin: 'network_log',
      send: sendMessage,
      lastError: () => chrome.runtime.lastError
    });
    const entries = await getHar();
    const outcomes = [];
    for (const entry of entries) {
      outcomes.push(await pipeline.processEntry(entry).catch(() => ({ outcome: 'skipped' })));
    }
    showLogResult(StatusText.describeLogSummary(CapturePipeline.summarize(outcomes)));
    await refreshFeed();
  } catch (error) {
    showLogResult(`Could not read the Network log: ${error.message}`);
  } finally {
    elements.captureLog.disabled = false;
  }
}

async function refresh() {
  try {
    const response = await sendMessage({ type: 'GET_STATUS' });
    if (response.ok) render(response);
  } catch {
    setState(elements.serverState, 'Extension unavailable', 'bad');
  }
}

elements.captureLog.addEventListener('click', () => {
  void captureFromNetworkLog();
});

elements.clearFeed.addEventListener('click', async () => {
  await sendMessage({ type: 'CLEAR_FEED' }).catch(() => undefined);
  elements.logResult.hidden = true;
  await refreshFeed();
});

elements.captureEnabled.addEventListener('change', () => {
  chrome.storage.local.set({
    captureEnabled: elements.captureEnabled.checked
  });
});

elements.retryQueue.addEventListener('click', async () => {
  elements.retryQueue.disabled = true;
  try {
    const response = await sendMessage({ type: 'RETRY_QUEUE' });
    if (response.ok) render(response);
  } finally {
    elements.retryQueue.disabled = false;
  }
});

void refresh();
void refreshFeed();
setInterval(() => {
  void refresh();
  void refreshFeed();
}, 1500);
