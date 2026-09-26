'use strict';

const elements = {
  captureEnabled: document.getElementById('captureEnabled'),
  listenerState: document.getElementById('listenerState'),
  serverState: document.getElementById('serverState'),
  queueState: document.getElementById('queueState'),
  deliveredCount: document.getElementById('deliveredCount'),
  lastEvent: document.getElementById('lastEvent'),
  events: document.getElementById('events'),
  retryQueue: document.getElementById('retryQueue')
};
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

async function refresh() {
  try {
    const response = await sendMessage({ type: 'GET_STATUS' });
    if (response.ok) render(response);
  } catch {
    setState(elements.serverState, 'Extension unavailable', 'bad');
  }
}

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
setInterval(refresh, 1500);
