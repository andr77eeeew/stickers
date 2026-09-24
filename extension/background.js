importScripts(
  'shared/stickerPolicy.js',
  'shared/capturePayload.js',
  'shared/deliveryPolicy.js',
  'shared/queueStore.js'
);

const MAX_QUEUE_ITEMS = 500;
const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_TIMEOUT_MS = 12000;
const BLOCKED_RETRY_AT = Number.MAX_SAFE_INTEGER;
const PERIODIC_ALARM = 'capture-queue-periodic';
const RETRY_ALARM = 'capture-queue-retry';
const STATUS_KEY = 'captureRuntimeStatus';

const DEFAULT_STATUS = Object.freeze({
  version: 1,
  lastHeartbeatAt: null,
  serverState: 'unknown',
  lastDeliveryAt: null,
  lastAcceptedAt: null,
  lastError: null,
  lastEvent: 'Extension initialized',
  counters: {
    observed: 0,
    queued: 0,
    skipped: 0,
    delivered: 0,
    duplicates: 0
  }
});

let policyPromise;
let deliveryPromise = null;
let enqueueChain = Promise.resolve();
let statusChain = Promise.resolve();

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
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

async function initializeSettings(generateMissingToken) {
  const current = await storageGet({
    settingsVersion: undefined,
    serverUrl: undefined,
    ingestToken: undefined,
    captureEnabled: undefined
  });
  const updates = {};
  if (typeof current.serverUrl === 'undefined') {
    updates.serverUrl = DeliveryPolicy.DEFAULT_SERVER_URL;
  }
  if (current.settingsVersion !== 2) {
    updates.settingsVersion = 2;
    updates.captureEnabled = false;
  } else if (typeof current.captureEnabled === 'undefined') {
    updates.captureEnabled = false;
  }
  if (
    typeof current.ingestToken === 'undefined' ||
    (generateMissingToken && !String(current.ingestToken || '').trim())
  ) {
    updates.ingestToken = generateToken();
  }
  if (Object.keys(updates).length > 0) await storageSet(updates);
}

async function getSettings() {
  const settings = await storageGet({
    serverUrl: DeliveryPolicy.DEFAULT_SERVER_URL,
    ingestToken: '',
    captureEnabled: false
  });
  return {
    serverUrl: DeliveryPolicy.normalizeServerUrl(settings.serverUrl),
    ingestToken:
      typeof settings.ingestToken === 'string'
        ? settings.ingestToken.trim()
        : '',
    captureEnabled: settings.captureEnabled !== false
  };
}

function getPolicy() {
  if (!policyPromise) {
    policyPromise = StickerPolicy.loadPolicy(
      chrome.runtime.getURL('shared/sticker-policy.json')
    );
  }
  return policyPromise;
}

async function readStatus() {
  const stored = await storageGet({ [STATUS_KEY]: null });
  const status = stored[STATUS_KEY] || {};
  return {
    ...DEFAULT_STATUS,
    ...status,
    counters: {
      ...DEFAULT_STATUS.counters,
      ...(status.counters || {})
    }
  };
}

function patchStatus(patch, counterDelta) {
  const task = statusChain.then(async () => {
    const current = await readStatus();
    const counters = { ...current.counters };
    for (const [name, delta] of Object.entries(counterDelta || {})) {
      counters[name] = Math.max(0, (Number(counters[name]) || 0) + delta);
    }
    const next = {
      ...current,
      ...patch,
      counters
    };
    await storageSet({ [STATUS_KEY]: next });
    return next;
  });
  statusChain = task.catch(() => undefined);
  return task;
}

function safeReason(value) {
  return String(value || 'unknown_error')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .slice(0, 160);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

async function updateBadge() {
  const settings = await getSettings();
  const queue = await CaptureQueueStore.summary();
  if (!settings.captureEnabled) {
    await chrome.action.setBadgeText({ text: 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
    return;
  }
  if (queue.blocked > 0) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f43f5e' });
    return;
  }
  const text =
    queue.count === 0 ? '' : queue.count > 99 ? '99+' : String(queue.count);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6' });
}

async function enqueueCapture(rawPayload) {
  const policy = await getPolicy();
  const validation = CapturePayload.validateCapturePayload(rawPayload, policy);
  if (!validation.ok) {
    await patchStatus(
      {
        lastEvent: `Rejected: ${validation.reason}`,
        lastError: validation.reason
      },
      { observed: 1, skipped: 1 }
    );
    return { ok: false, reason: validation.reason };
  }

  const id = await sha256Hex(validation.bytes);
  const existing = await CaptureQueueStore.get(id);
  if (existing) {
    await patchStatus(
      {
        lastEvent: 'Already queued',
        lastError: null
      },
      { observed: 1 }
    );
    return { ok: true, queued: false, duplicateQueued: true, id };
  }

  if ((await CaptureQueueStore.count()) >= MAX_QUEUE_ITEMS) {
    await patchStatus(
      {
        lastEvent: 'Queue full',
        lastError: 'queue_full'
      },
      { observed: 1, skipped: 1 }
    );
    await updateBadge();
    return { ok: false, reason: 'queue_full' };
  }

  const now = Date.now();
  try {
    await CaptureQueueStore.add({
      id,
      payload: validation.payload,
      state: 'pending',
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
      lastError: null
    });
  } catch (error) {
    if (error && error.name === 'ConstraintError') {
      return { ok: true, queued: false, duplicateQueued: true, id };
    }
    throw error;
  }

  await patchStatus(
    {
      lastEvent: 'Queued local capture',
      lastError: null
    },
    { observed: 1, queued: 1 }
  );
  await updateBadge();
  void processQueue();
  return { ok: true, queued: true, id };
}

function queueCapture(payload) {
  const task = enqueueChain.then(() => enqueueCapture(payload));
  enqueueChain = task.catch(() => undefined);
  return task;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverRecord(record) {
  const settings = await getSettings();
  if (!settings.serverUrl) {
    return { action: 'wait', reason: 'invalid_server_url' };
  }
  if (!settings.ingestToken) {
    return { action: 'wait', reason: 'missing_ingest_token' };
  }

  try {
    const response = await fetchWithTimeout(
      `${settings.serverUrl}/api/ingest`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.ingestToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(record.payload)
      }
    );
    const body = await response.json().catch(() => ({}));
    const result = DeliveryPolicy.classifyIngestResponse(
      response.status,
      body
    );
    return {
      ...result,
      reason:
        result.action === 'ack'
          ? null
          : safeReason(body.error || `HTTP ${response.status}`)
    };
  } catch (error) {
    return {
      action: 'retry',
      duplicate: false,
      reason:
        error && error.name === 'AbortError'
          ? 'local_server_timeout'
          : 'local_server_unreachable'
    };
  }
}

async function handleDeliveryResult(record, result) {
  const now = Date.now();
  if (result.action === 'ack') {
    await CaptureQueueStore.remove(record.id);
    await patchStatus(
      {
        serverState: 'online',
        lastDeliveryAt: new Date(now).toISOString(),
        lastAcceptedAt: new Date(now).toISOString(),
        lastError: null,
        lastEvent: result.duplicate
          ? 'Server acknowledged duplicate'
          : 'Server accepted sticker'
      },
      {
        delivered: 1,
        duplicates: result.duplicate ? 1 : 0
      }
    );
    return;
  }

  const attempts = record.attempts + 1;
  const blocked = result.action === 'block';
  await CaptureQueueStore.put({
    ...record,
    state: blocked ? 'blocked' : 'pending',
    attempts,
    nextAttemptAt: blocked
      ? BLOCKED_RETRY_AT
      : now + DeliveryPolicy.computeBackoffMs(attempts),
    lastError: result.reason
  });
  await patchStatus({
    serverState:
      result.reason === 'missing_ingest_token'
        ? 'configuration_required'
        : /^HTTP (401|403)$/.test(result.reason)
          ? 'unauthorized'
          : 'offline',
    lastError: result.reason,
    lastEvent: blocked
      ? `Delivery blocked: ${result.reason}`
      : `Delivery retry scheduled: ${result.reason}`
  });
}

async function scheduleNextDelivery() {
  const queue = await CaptureQueueStore.summary();
  await chrome.alarms.clear(RETRY_ALARM);
  if (queue.earliestNextAttemptAt !== null) {
    chrome.alarms.create(RETRY_ALARM, {
      when: Math.max(Date.now() + 30000, queue.earliestNextAttemptAt)
    });
  }
  await updateBadge();
  return queue;
}

function processQueue() {
  if (deliveryPromise) return deliveryPromise;
  deliveryPromise = (async () => {
    let processed = 0;
    while (processed < DELIVERY_BATCH_SIZE) {
      const records = await CaptureQueueStore.getDue(
        Date.now(),
        DELIVERY_BATCH_SIZE - processed
      );
      if (records.length === 0) break;

      let waitingForConfiguration = false;
      for (const record of records) {
        const result = await deliverRecord(record);
        if (result.action === 'wait') {
          await patchStatus({
            serverState: 'configuration_required',
            lastError: result.reason,
            lastEvent: `Delivery waiting: ${result.reason}`
          });
          waitingForConfiguration = true;
          break;
        }
        await handleDeliveryResult(record, result);
        processed += 1;
      }
      if (waitingForConfiguration) break;
    }
    return scheduleNextDelivery();
  })()
    .catch((error) => {
      void patchStatus({
        lastError: safeReason(error && error.message),
        lastEvent: 'Queue processing failed'
      }).catch(() => undefined);
      return null;
    })
    .finally(() => {
      deliveryPromise = null;
    });
  return deliveryPromise;
}

async function getPublicStatus() {
  const [settings, status, queue] = await Promise.all([
    getSettings(),
    readStatus(),
    CaptureQueueStore.summary()
  ]);
  const listenerAlive =
    Number(status.lastHeartbeatAt) > Date.now() - 25000;
  return {
    captureMode: 'devtools-network-body',
    captureEnabled: settings.captureEnabled,
    serverUrl:
      settings.serverUrl || DeliveryPolicy.DEFAULT_SERVER_URL,
    hasToken: Boolean(settings.ingestToken),
    listenerState: listenerAlive ? 'listening' : 'closed',
    serverState: status.serverState,
    queue,
    lastDeliveryAt: status.lastDeliveryAt,
    lastAcceptedAt: status.lastAcceptedAt,
    lastError: status.lastError,
    lastEvent: status.lastEvent,
    counters: status.counters
  };
}

async function pingServer() {
  const settings = await getSettings();
  if (!settings.serverUrl || !settings.ingestToken) {
    await patchStatus({
      serverState: 'configuration_required',
      lastError: !settings.serverUrl
        ? 'invalid_server_url'
        : 'missing_ingest_token'
    });
    return getPublicStatus();
  }
  try {
    const response = await fetchWithTimeout(
      `${settings.serverUrl}/api/status`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${settings.ingestToken}`
        }
      }
    );
    await patchStatus({
      serverState: response.ok
        ? 'online'
        : response.status === 401 || response.status === 403
          ? 'unauthorized'
          : 'offline',
      lastError: response.ok ? null : `HTTP ${response.status}`
    });
  } catch {
    await patchStatus({
      serverState: 'offline',
      lastError: 'local_server_unreachable'
    });
  }
  return getPublicStatus();
}

async function recordDevtoolsEvent(message) {
  const kind = ['listening', 'skipped', 'body_read_failed'].includes(
    message.kind
  )
    ? message.kind
    : 'unknown';
  const reason = safeReason(message.reason || kind);
  const patch = {
    lastEvent:
      kind === 'listening'
        ? 'DevTools listener active'
        : `${kind}: ${reason}`
  };
  if (kind !== 'listening') patch.lastError = reason;
  await patchStatus(patch, kind === 'skipped' ? { skipped: 1 } : undefined);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  let operation;
  if (message.type === 'QUEUE_CAPTURE') {
    operation = queueCapture(message.payload);
  } else if (message.type === 'GET_STATUS') {
    operation = getPublicStatus();
  } else if (message.type === 'PING_SERVER') {
    operation = pingServer();
  } else if (message.type === 'RETRY_QUEUE') {
    operation = CaptureQueueStore.releaseBlocked(Date.now())
      .then(() => processQueue())
      .then(() => getPublicStatus());
  } else if (message.type === 'SETTINGS_UPDATED') {
    operation = CaptureQueueStore.releaseBlocked(Date.now())
      .then(() => processQueue())
      .then(() => getPublicStatus());
  } else if (message.type === 'DEVTOOLS_HEARTBEAT') {
    operation = patchStatus({
      lastHeartbeatAt: Date.now(),
      lastEvent: 'DevTools listener active'
    }).then(() => ({ ok: true }));
  } else if (message.type === 'DEVTOOLS_EVENT') {
    operation = recordDevtoolsEvent(message).then(() => ({ ok: true }));
  } else {
    return false;
  }

  operation
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        reason: safeReason(error && error.message)
      })
    );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if ([PERIODIC_ALARM, RETRY_ALARM].includes(alarm.name)) {
    void processQueue();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    (changes.serverUrl || changes.ingestToken || changes.captureEnabled)
  ) {
    void updateBadge();
    if (changes.serverUrl || changes.ingestToken) {
      void CaptureQueueStore.releaseBlocked(Date.now()).then(() =>
        processQueue()
      );
    }
  }
});

async function bootstrap(generateMissingToken) {
  await initializeSettings(generateMissingToken);
  await getPolicy();
  chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: 1 });
  await updateBadge();
  void processQueue();
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap(true);
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap(false);
});

void bootstrap(false);
