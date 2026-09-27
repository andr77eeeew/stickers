'use strict';

const elements = {
  overall: document.getElementById('overall'),
  overallText: document.getElementById('overallText'),
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
  diagnostics: document.getElementById('diagnostics'),
  sessionLine: document.getElementById('sessionLine'),
  warnings: document.getElementById('warnings')
};
let warningsSignature = '';
let feedSignature = '';
let diagnosticsSignature = '';
const EVENTS_SHOWN = 6;
// Background event tones use 'warning'; the page vocabulary is 'pending'.
const EVENT_TONES = Object.freeze({ problem: 'problem', warning: 'pending' });

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

// A status value: a tone dot and the text, as in the dashboard.
function setDescribed(element, description, baseClass) {
  const dot = document.createElement('span');
  dot.className = 'dot';
  const text = document.createElement('span');
  text.textContent = description.text;
  element.className = `${baseClass} tone-${description.tone}`;
  element.replaceChildren(dot, text);
}

function renderEvents(events) {
  const items = (events || []).slice(1, EVENTS_SHOWN).map((event) => {
    const item = document.createElement('li');
    const tone = EVENT_TONES[event.tone];
    if (tone) item.className = `tone-${tone}`;
    const time = document.createElement('time');
    time.dateTime = new Date(event.at).toISOString();
    time.textContent = new Date(event.at).toLocaleTimeString();
    const text = document.createElement('span');
    text.textContent = event.text;
    item.append(time, text);
    return item;
  });
  elements.events.replaceChildren(...items);
}

function render(status) {
  elements.captureEnabled.checked = status.captureEnabled !== false;
  const overall = StatusText.describeOverall(status);
  elements.overall.className = `status-pill tone-${overall.tone}`;
  if (elements.overallText.textContent !== overall.text) {
    elements.overallText.textContent = overall.text;
  }
  setDescribed(elements.listenerState, StatusText.describeListener(status.listenerState), 'stat-value');
  setDescribed(elements.serverState, StatusText.describeServer(status.serverState), 'stat-value');
  setDescribed(
    elements.queueState,
    StatusText.describeQueue(status.queue, status.pausedReason),
    'stat-value tabular'
  );
  elements.deliveredCount.textContent = String(
    status.counters && status.counters.delivered || 0
  );
  elements.lastEvent.textContent =
    status.lastEvent || 'No capture events yet.';
  renderEvents(status.events);
  renderPacing(status);
}

function renderPacing(status) {
  const session = StatusText.describeSession(status.session, Date.now());
  setDescribed(
    elements.sessionLine,
    session || { tone: 'ok', text: 'No capture session yet' },
    'session-line tabular'
  );
  const warnings = (status.warnings || []).map(StatusText.describeWarning).filter(Boolean);
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
    preview.textContent = (item.mimeType || '').replace('image/', '') || '—';
  }
  preview.classList.add('feed-thumb');

  const body = document.createElement('div');
  body.className = 'feed-body';
  const state = document.createElement('strong');
  setDescribed(state, StatusText.describeFeedItem(item), 'feed-state');
  const meta = document.createElement('span');
  meta.className = 'feed-meta';
  const time = new Date(item.at).toLocaleTimeString();
  meta.textContent = item.origin === 'network_log' ? `${time} · from Network log` : time;
  body.append(state, meta);

  if (item.stickerId) {
    const link = document.createElement('a');
    link.className = 'feed-link';
    link.href = libraryLink(serverUrl, item.stickerId);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append('Open in library', Icons.element('external-link'));
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

function showLogResult(text, tone = 'info') {
  elements.logResult.hidden = false;
  elements.logResult.className = `inline-alert tone-${tone}`;
  elements.logResult.replaceChildren(Icons.element(Icons.TONE_ICONS[tone]), document.createTextNode(text));
}

// Reads responses DevTools already recorded; no request is repeated.
async function captureFromNetworkLog() {
  elements.captureLog.disabled = true;
  showLogResult('Checking the Network log…');
  try {
    const site = await CapturePipeline.detectInspectedSite(chrome.devtools.inspectedWindow);
    if (site === 'other') {
      showLogResult('DevTools is open on another site. Open it on the TikTok tab to capture from its Network log.', 'pending');
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
    const summary = CapturePipeline.summarize(outcomes);
    showLogResult(StatusText.describeLogSummary(summary), summary.queued ? 'ok' : 'info');
    await refreshFeed();
  } catch (error) {
    showLogResult(`Could not read the Network log: ${error.message}`, 'problem');
  } finally {
    elements.captureLog.disabled = false;
  }
}

async function refresh() {
  try {
    const response = await sendMessage({ type: 'GET_STATUS' });
    if (response.ok) render(response);
  } catch {
    setDescribed(elements.serverState, { tone: 'problem', text: 'Extension unavailable' }, 'stat-value');
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

Icons.hydrate(document);
void refresh();
void refreshFeed();
setInterval(() => {
  void refresh();
  void refreshFeed();
}, 1500);
