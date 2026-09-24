'use strict';

const elements = {
  captureEnabled: document.getElementById('captureEnabled'),
  listenerState: document.getElementById('listenerState'),
  serverState: document.getElementById('serverState'),
  queueState: document.getElementById('queueState'),
  deliveredCount: document.getElementById('deliveredCount'),
  lastEvent: document.getElementById('lastEvent'),
  lastError: document.getElementById('lastError'),
  retryQueue: document.getElementById('retryQueue')
};

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

function render(status) {
  elements.captureEnabled.checked = status.captureEnabled !== false;
  setState(
    elements.listenerState,
    status.listenerState === 'listening' ? 'Listening' : 'DevTools closed',
    status.listenerState === 'listening' ? 'ok' : 'warn'
  );

  const serverLabels = {
    online: 'Online',
    offline: 'Offline',
    unauthorized: 'Token rejected',
    configuration_required: 'Token required',
    unknown: 'Not checked'
  };
  setState(
    elements.serverState,
    serverLabels[status.serverState] || status.serverState,
    status.serverState === 'online'
      ? 'ok'
      : status.serverState === 'unknown'
        ? 'warn'
        : 'bad'
  );

  const queue = status.queue || {};
  const blocked = Number(queue.blocked) || 0;
  setState(
    elements.queueState,
    blocked
      ? `${queue.count || 0} (${blocked} blocked)`
      : String(queue.count || 0),
    blocked ? 'bad' : queue.count ? 'warn' : 'ok'
  );
  elements.deliveredCount.textContent = String(
    status.counters && status.counters.delivered || 0
  );
  elements.lastEvent.textContent =
    status.lastEvent || 'No capture events yet.';
  elements.lastError.hidden = !status.lastError;
  elements.lastError.textContent = status.lastError
    ? `Issue: ${status.lastError}`
    : '';
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
