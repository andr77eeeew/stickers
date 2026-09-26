importScripts(
  'shared/stickerPolicy.js',
  'shared/capturePayload.js',
  'shared/capturePipeline.js',
  'shared/deliveryPolicy.js',
  'shared/queueStore.js'
);

const MAX_QUEUE_ITEMS = 500;
const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_TIMEOUT_MS = 12000;
const PERIODIC_ALARM = 'capture-queue-periodic';
const RETRY_ALARM = 'capture-queue-retry';
const STATUS_KEY = 'captureRuntimeStatus';
const LISTENER_STALE_MS = 25000;
const MAX_EVENTS = 20;
const HELD_LIST_LIMIT = 50;
const BUDGET_PAUSE_REASON = 'capture_budget_exhausted';
const LISTENER_SITES = ['tiktok', 'other', 'unknown'];
const SERVER_HEARTBEAT_MS = 20000;
const SERVER_HEARTBEAT_MIN_GAP_MS = 2000;
// Session feed and diagnostics live in chrome.storage.session: in memory,
// gone when the browser closes.
const FEED_KEY = 'captureFeed';
const FEED_LIMIT = 60;
const DIAGNOSTICS_KEY = 'captureDiagnostics';
const DIAGNOSTIC_EXAMPLES = 3;
// Hashes the server already acknowledged, so a sticker seen again is not
// sent again. Reset whenever the server URL or token changes.
const KNOWN_KEY = 'knownCaptures';
const KNOWN_LIMIT = 2000;
const CAPTURE_ORIGINS = ['live', 'network_log'];
const STICKER_ID_PATTERN = /^[a-f0-9]{64}$/;

const BADGE_COLORS = Object.freeze({
  off: '#5D6B80',
  problem: '#B42318',
  paused: '#9A5B00',
  queued: '#5133D4'
});

const DEFAULT_STATUS = Object.freeze({
  version: 2,
  listeners: {},
  serverState: 'unknown',
  pausedReason: null,
  session: null,
  lastDeliveryAt: null,
  lastAcceptedAt: null,
  lastError: null,
  lastEvent: 'Extension initialized',
  events: [],
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

// The token comes from the dashboard (Health → Capture extension) or from
// INGEST_TOKEN in .env; the extension no longer invents one on install.
async function initializeSettings() {
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
  if (typeof current.ingestToken === 'undefined') {
    updates.ingestToken = '';
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
    listeners: { ...(status.listeners || {}) },
    events: Array.isArray(status.events) ? status.events : [],
    counters: {
      ...DEFAULT_STATUS.counters,
      ...(status.counters || {})
    }
  };
}

// event: { tone: 'ok' | 'info' | 'warning' | 'problem', text }. Only events
// change lastEvent; heartbeats and pings never overwrite it.
function patchStatus(patch, counterDelta, event) {
  const task = statusChain.then(async () => {
    const current = await readStatus();
    const counters = { ...current.counters };
    for (const [name, delta] of Object.entries(counterDelta || {})) {
      counters[name] = Math.max(0, (Number(counters[name]) || 0) + delta);
    }
    const next = {
      ...current,
      ...(typeof patch === 'function' ? patch(current) : patch),
      counters
    };
    if (event) {
      next.lastEvent = event.text;
      next.events = [
        { at: Date.now(), tone: event.tone, text: event.text },
        ...current.events
      ].slice(0, MAX_EVENTS);
    }
    await storageSet({ [STATUS_KEY]: next });
    return next;
  });
  statusChain = task.catch(() => undefined);
  return task;
}

const memorySession = {};

function sessionGet(defaults) {
  if (!chrome.storage.session) {
    const result = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      result[key] = key in memorySession ? memorySession[key] : fallback;
    }
    return Promise.resolve(result);
  }
  return new Promise((resolve) => chrome.storage.session.get(defaults, resolve));
}

function sessionSet(values) {
  if (!chrome.storage.session) {
    Object.assign(memorySession, values);
    return Promise.resolve();
  }
  return new Promise((resolve) => chrome.storage.session.set(values, resolve));
}

let feedChain = Promise.resolve();

function chainFeed(task) {
  const next = feedChain.then(task);
  feedChain = next.catch(() => undefined);
  return next;
}

// touch: move the entry to the top (a new observation); otherwise update in place.
function upsertFeed(entry, { touch = false } = {}) {
  return chainFeed(async () => {
    const stored = await sessionGet({ [FEED_KEY]: [] });
    const feed = Array.isArray(stored[FEED_KEY]) ? stored[FEED_KEY] : [];
    const index = feed.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      const merged = {
        ...feed[index],
        ...entry,
        thumbnail: entry.thumbnail || feed[index].thumbnail || null
      };
      if (touch) {
        feed.splice(index, 1);
        feed.unshift(merged);
      } else {
        feed[index] = merged;
      }
    } else {
      feed.unshift({ at: Date.now(), thumbnail: null, reason: null, stickerId: null, ...entry });
    }
    await sessionSet({ [FEED_KEY]: feed.slice(0, FEED_LIMIT) });
  });
}

function recordDiagnostic(message) {
  const reason = /^[a-z_]{1,40}$/.test(String(message.reason || ''))
    ? message.reason
    : 'unknown';
  const pattern = String(message.pattern || '').slice(0, 200);
  return chainFeed(async () => {
    const stored = await sessionGet({ [DIAGNOSTICS_KEY]: {} });
    const diagnostics = stored[DIAGNOSTICS_KEY] || {};
    const current = diagnostics[reason] || { count: 0, examples: [], lastAt: null };
    diagnostics[reason] = {
      count: current.count + 1,
      examples: [pattern, ...current.examples.filter((item) => item !== pattern)]
        .filter(Boolean)
        .slice(0, DIAGNOSTIC_EXAMPLES),
      lastAt: Date.now()
    };
    await sessionSet({ [DIAGNOSTICS_KEY]: diagnostics });
  });
}

async function knownServerKey() {
  const settings = await getSettings();
  const digest = await sha256Hex(new TextEncoder().encode(settings.ingestToken));
  return `${settings.serverUrl}|${digest.slice(0, 16)}`;
}

async function lookupKnown(id) {
  const [stored, serverKey] = await Promise.all([
    storageGet({ [KNOWN_KEY]: null }),
    knownServerKey()
  ]);
  const known = stored[KNOWN_KEY];
  if (!known || known.serverKey !== serverKey || !Array.isArray(known.entries)) return null;
  const entry = known.entries.find(([hash]) => hash === id);
  return entry ? entry[1] : null;
}

async function rememberKnown(id, stickerId) {
  if (!STICKER_ID_PATTERN.test(String(stickerId || ''))) return;
  const [stored, serverKey] = await Promise.all([
    storageGet({ [KNOWN_KEY]: null }),
    knownServerKey()
  ]);
  const known = stored[KNOWN_KEY];
  const entries = known && known.serverKey === serverKey && Array.isArray(known.entries)
    ? known.entries.filter(([hash]) => hash !== id)
    : [];
  entries.push([id, stickerId]);
  await storageSet({
    [KNOWN_KEY]: { serverKey, entries: entries.slice(-KNOWN_LIMIT) }
  });
}

function sanitizeThumbnail(value) {
  return typeof value === 'string' &&
    /^data:image\/(webp|png|jpeg);base64,/.test(value) &&
    value.length <= CapturePipeline.THUMBNAIL_MAX_LENGTH
    ? value
    : null;
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
  const [settings, queue, status] = await Promise.all([
    getSettings(),
    CaptureQueueStore.summary(),
    readStatus()
  ]);
  let text = '';
  let color = BADGE_COLORS.queued;
  if (!settings.captureEnabled) {
    text = 'OFF';
    color = BADGE_COLORS.off;
  } else if (queue.blocked > 0) {
    text = '!';
    color = BADGE_COLORS.problem;
  } else if (queue.paused > 0 || status.pausedReason) {
    text = 'II';
    color = BADGE_COLORS.paused;
  } else if (queue.count > 0) {
    text = queue.count > 99 ? '99+' : String(queue.count);
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function enqueueCapture(rawPayload, meta) {
  const origin = CAPTURE_ORIGINS.includes(meta.origin) ? meta.origin : 'live';
  const thumbnail = sanitizeThumbnail(meta.thumbnail);
  const policy = await getPolicy();
  const validation = CapturePayload.validateCapturePayload(rawPayload, policy);
  if (!validation.ok) {
    await patchStatus(
      { lastError: validation.reason },
      { observed: 1, skipped: 1 },
      { tone: 'warning', text: `Rejected: ${validation.reason}` }
    );
    await upsertFeed({
      id: `rejected-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      origin,
      state: 'rejected',
      reason: validation.reason,
      thumbnail
    });
    return { ok: false, reason: validation.reason };
  }

  const id = await sha256Hex(validation.bytes);
  const feedEntry = {
    id,
    origin,
    thumbnail,
    at: Date.now(),
    mimeType: validation.payload.mimeType,
    byteLength: validation.bytes.length
  };

  const knownStickerId = await lookupKnown(id);
  if (knownStickerId) {
    await patchStatus({}, { observed: 1 });
    await upsertFeed(
      { ...feedEntry, state: 'duplicate', stickerId: knownStickerId, reason: null },
      { touch: true }
    );
    return { ok: true, queued: false, known: true, stickerId: knownStickerId, id };
  }

  const existing = await CaptureQueueStore.get(id);
  if (existing) {
    await patchStatus({}, { observed: 1 });
    await upsertFeed({ ...feedEntry, state: 'queued' }, { touch: true });
    return { ok: true, queued: false, duplicateQueued: true, id };
  }

  if ((await CaptureQueueStore.count()) >= MAX_QUEUE_ITEMS) {
    await patchStatus(
      { lastError: 'queue_full' },
      { observed: 1, skipped: 1 },
      { tone: 'problem', text: 'Queue full: capture skipped' }
    );
    await upsertFeed({ ...feedEntry, state: 'rejected', reason: 'queue_full' }, { touch: true });
    await updateBadge();
    return { ok: false, reason: 'queue_full' };
  }

  const status = await readStatus();
  const paused = Boolean(status.pausedReason);
  const now = Date.now();
  try {
    await CaptureQueueStore.add({
      id,
      payload: validation.payload,
      state: paused ? 'paused' : 'pending',
      attempts: 0,
      createdAt: now,
      nextAttemptAt: paused ? CaptureQueueStore.HELD_UNTIL : now,
      lastError: paused ? status.pausedReason : null
    });
  } catch (error) {
    if (error && error.name === 'ConstraintError') {
      return { ok: true, queued: false, duplicateQueued: true, id };
    }
    throw error;
  }

  await upsertFeed(
    { ...feedEntry, state: 'queued', reason: paused ? status.pausedReason : null },
    { touch: true }
  );
  await patchStatus(
    {},
    { observed: 1, queued: 1 },
    paused
      ? { tone: 'warning', text: 'Captured and held: delivery is paused' }
      : { tone: 'info', text: 'Captured, delivering to the local server' }
  );
  await updateBadge();
  if (!paused) void processQueue();
  return { ok: true, queued: true, paused, id };
}

function queueCapture(payload, meta) {
  const task = enqueueChain.then(() => enqueueCapture(payload, meta || {}));
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
      body,
      response.headers.get('Retry-After')
    );
    const stickerId = body && body.sticker && body.sticker.id;
    return {
      ...result,
      httpStatus: response.status,
      stickerId: STICKER_ID_PATTERN.test(String(stickerId || '')) ? stickerId : null,
      session: body && body.session ? body.session : null,
      reason:
        result.action === 'ack'
          ? null
          : safeReason(body.error || `HTTP ${response.status}`)
    };
  } catch (error) {
    return {
      action: 'retry',
      duplicate: false,
      serverState: 'offline',
      reason:
        error && error.name === 'AbortError'
          ? 'local_server_timeout'
          : 'local_server_unreachable'
    };
  }
}

function describeFailure(result) {
  if (result.serverState === 'unauthorized') return 'Token rejected by the local server';
  if (result.serverState === 'capture_disabled') return 'Live capture is disabled on the local server';
  if (result.serverState === 'offline') return 'Local server unreachable';
  return result.reason;
}

// Returns false when the rest of the batch should wait.
async function handleDeliveryResult(record, result) {
  const now = Date.now();
  const sessionPatch = result.session ? { session: result.session } : {};

  if (result.action === 'ack') {
    await CaptureQueueStore.remove(record.id);
    await rememberKnown(record.id, result.stickerId);
    await upsertFeed({
      id: record.id,
      state: result.duplicate ? 'duplicate' : 'new',
      stickerId: result.stickerId,
      reason: null
    });
    await patchStatus(
      {
        ...sessionPatch,
        serverState: result.serverState,
        lastDeliveryAt: new Date(now).toISOString(),
        lastAcceptedAt: new Date(now).toISOString(),
        lastError: null
      },
      { delivered: 1, duplicates: result.duplicate ? 1 : 0 },
      result.duplicate
        ? { tone: 'ok', text: 'Already in library' }
        : { tone: 'ok', text: 'Server accepted sticker' }
    );
    return true;
  }

  if (result.action === 'pause') {
    await CaptureQueueStore.put({
      ...record,
      state: 'paused',
      attempts: record.attempts + 1,
      nextAttemptAt: CaptureQueueStore.HELD_UNTIL,
      lastError: BUDGET_PAUSE_REASON
    });
    await CaptureQueueStore.pausePending(BUDGET_PAUSE_REASON);
    await upsertFeed({ id: record.id, state: 'queued', reason: BUDGET_PAUSE_REASON });
    await patchStatus(
      {
        ...sessionPatch,
        serverState: result.serverState,
        pausedReason: BUDGET_PAUSE_REASON,
        lastError: BUDGET_PAUSE_REASON
      },
      undefined,
      {
        tone: 'warning',
        text: 'Delivery paused: capture budget exhausted. Captures are kept; reset the budget in the dashboard.'
      }
    );
    return false;
  }

  const attempts = record.attempts + 1;
  const blocked = result.action === 'block';
  await CaptureQueueStore.put({
    ...record,
    state: blocked ? 'blocked' : 'pending',
    attempts,
    nextAttemptAt: blocked
      ? CaptureQueueStore.HELD_UNTIL
      : now +
        Math.max(
          DeliveryPolicy.computeBackoffMs(attempts),
          Number(result.retryAfterMs) || 0
        ),
    lastError: result.reason
  });
  const failure = describeFailure(result);
  await upsertFeed({ id: record.id, state: 'queued', reason: failure });
  await patchStatus(
    {
      serverState: result.serverState,
      lastError: result.reason
    },
    undefined,
    blocked
      ? { tone: 'problem', text: `Delivery blocked: ${failure}` }
      : { tone: 'warning', text: `Delivery retry scheduled: ${failure}` }
  );
  return true;
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
  void sendServerHeartbeat(false);
  return queue;
}

function processQueue() {
  if (deliveryPromise) return deliveryPromise;
  deliveryPromise = (async () => {
    let processed = 0;
    let keepGoing = true;
    while (keepGoing && processed < DELIVERY_BATCH_SIZE) {
      const records = await CaptureQueueStore.getDue(
        Date.now(),
        DELIVERY_BATCH_SIZE - processed
      );
      if (records.length === 0) break;

      for (const record of records) {
        const result = await deliverRecord(record);
        if (result.action === 'wait') {
          await patchStatus(
            {
              serverState: 'configuration_required',
              lastError: result.reason
            },
            undefined,
            { tone: 'warning', text: `Delivery waiting: ${result.reason}` }
          );
          keepGoing = false;
          break;
        }
        keepGoing = await handleDeliveryResult(record, result);
        processed += 1;
        if (!keepGoing) break;
      }
    }
    return scheduleNextDelivery();
  })()
    .catch((error) => {
      void patchStatus(
        { lastError: safeReason(error && error.message) },
        undefined,
        { tone: 'problem', text: 'Queue processing failed' }
      ).catch(() => undefined);
      return null;
    })
    .finally(() => {
      deliveryPromise = null;
    });
  return deliveryPromise;
}

function computeListenerState(settings, status, now) {
  if (!settings.captureEnabled) return 'off';
  const live = Object.values(status.listeners).filter(
    (listener) => now - Number(listener.at) < LISTENER_STALE_MS
  );
  if (live.length === 0) return 'closed';
  if (live.some((listener) => listener.site === 'tiktok')) return 'watching';
  if (live.some((listener) => listener.site === 'unknown')) {
    return 'watching_unconfirmed';
  }
  return 'other_site';
}

async function getPublicStatus() {
  const [settings, status, queue] = await Promise.all([
    getSettings(),
    readStatus(),
    CaptureQueueStore.summary()
  ]);
  return {
    captureMode: 'devtools-network-body',
    captureEnabled: settings.captureEnabled,
    serverUrl:
      settings.serverUrl || DeliveryPolicy.DEFAULT_SERVER_URL,
    hasToken: Boolean(settings.ingestToken),
    listenerState: computeListenerState(settings, status, Date.now()),
    serverState: status.serverState,
    pausedReason: status.pausedReason,
    session: status.session,
    queue,
    lastDeliveryAt: status.lastDeliveryAt,
    lastAcceptedAt: status.lastAcceptedAt,
    lastError: status.lastError,
    lastEvent: status.lastEvent,
    events: status.events,
    counters: status.counters
  };
}

async function resumeDelivery(text) {
  await CaptureQueueStore.releasePaused(Date.now());
  await patchStatus(
    { pausedReason: null, lastError: null },
    undefined,
    { tone: 'ok', text }
  );
  await processQueue();
}

// Checks the local server; while delivery is paused by the capture budget,
// resumes it once the server reports the budget as available again.
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
  let body = null;
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
    body = await response.json().catch(() => ({}));
    await patchStatus((current) => ({
      serverState: DeliveryPolicy.serverStateForResponse(response.status, body),
      session: response.ok && body.session ? body.session : current.session,
      lastError: response.ok
        ? current.pausedReason
        : safeReason(body.error || `HTTP ${response.status}`)
    }));
    if (!response.ok) body = null;
  } catch {
    await patchStatus({
      serverState: 'offline',
      lastError: 'local_server_unreachable'
    });
  }

  const status = await readStatus();
  if (
    status.pausedReason === BUDGET_PAUSE_REASON &&
    body &&
    body.session &&
    body.session.exhausted === false
  ) {
    await resumeDelivery('Capture budget available again; delivery resumed');
  }
  return getPublicStatus();
}

// Tells the local dashboard what only the extension knows: whether DevTools
// is watching a TikTok tab. Loopback only, never more often than needed.
let lastServerHeartbeat = { key: '', at: 0 };

async function sendServerHeartbeat(force) {
  const settings = await getSettings();
  if (!settings.serverUrl || !settings.ingestToken) return;
  const status = await getPublicStatus();
  const queue = {
    count: status.queue.count,
    blocked: status.queue.blocked,
    paused: status.queue.paused
  };
  const key = JSON.stringify([status.listenerState, queue, status.pausedReason]);
  const now = Date.now();
  const elapsed = now - lastServerHeartbeat.at;
  const due =
    force ||
    elapsed >= SERVER_HEARTBEAT_MS ||
    (key !== lastServerHeartbeat.key && elapsed >= SERVER_HEARTBEAT_MIN_GAP_MS);
  if (!due) return;
  lastServerHeartbeat = { key, at: now };

  try {
    const response = await fetchWithTimeout(
      `${settings.serverUrl}/api/extension/heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.ingestToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          listenerState: status.listenerState,
          queue,
          pausedReason: status.pausedReason,
          version: chrome.runtime.getManifest().version
        })
      }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) lastServerHeartbeat.key = '';
    await patchStatus((current) => ({
      serverState: DeliveryPolicy.serverStateForResponse(response.status, body),
      session: response.ok && body.session ? body.session : current.session
    }));
  } catch {
    lastServerHeartbeat.key = '';
    await patchStatus({ serverState: 'offline' });
  }
}

async function forgetListener(message) {
  const key = String(message.tabId ?? 'default');
  await patchStatus((current) => {
    const listeners = { ...current.listeners };
    delete listeners[key];
    return { listeners };
  });
}

async function recordHeartbeat(message) {
  const key = String(message.tabId ?? 'default');
  const site = LISTENER_SITES.includes(message.site) ? message.site : 'unknown';
  const now = Date.now();
  await patchStatus((current) => {
    const listeners = {};
    for (const [tabId, listener] of Object.entries(current.listeners)) {
      if (now - Number(listener.at) < LISTENER_STALE_MS) listeners[tabId] = listener;
    }
    listeners[key] = { site, at: now };
    return { listeners };
  });
}

const SITE_EVENTS = Object.freeze({
  tiktok: 'DevTools open on a TikTok tab',
  other: 'DevTools open on another site: capture idle',
  unknown: 'DevTools open: site not confirmed yet'
});

async function recordDevtoolsEvent(message) {
  const kind = ['listening', 'site_changed', 'skipped', 'body_read_failed'].includes(
    message.kind
  )
    ? message.kind
    : 'unknown';
  if (kind === 'listening' || kind === 'site_changed') {
    await recordHeartbeat(message);
    const site = LISTENER_SITES.includes(message.site) ? message.site : 'unknown';
    await patchStatus({}, undefined, {
      tone: site === 'tiktok' ? 'ok' : 'info',
      text: SITE_EVENTS[site]
    });
    return;
  }
  const reason = safeReason(message.reason || kind);
  await patchStatus(
    { lastError: reason },
    kind === 'skipped' ? { skipped: 1 } : undefined,
    { tone: 'warning', text: `${kind === 'skipped' ? 'Skipped' : 'Body read failed'}: ${reason}` }
  );
}

// Feed entries still in the queue report the queue's current state.
async function getFeed() {
  const [stored, settings] = await Promise.all([
    sessionGet({ [FEED_KEY]: [], [DIAGNOSTICS_KEY]: {} }),
    getSettings()
  ]);
  const items = await Promise.all((stored[FEED_KEY] || []).map(async (item) => {
    if (item.state !== 'queued') return item;
    const record = await CaptureQueueStore.get(item.id);
    if (!record || !['blocked', 'paused'].includes(record.state)) return item;
    return { ...item, state: 'held', reason: record.lastError || item.reason };
  }));
  return {
    items,
    diagnostics: stored[DIAGNOSTICS_KEY] || {},
    serverUrl: settings.serverUrl || DeliveryPolicy.DEFAULT_SERVER_URL
  };
}

function clearFeed() {
  return chainFeed(() => sessionSet({ [FEED_KEY]: [], [DIAGNOSTICS_KEY]: {} }));
}

async function discardHeldItem(id) {
  const record = typeof id === 'string' ? await CaptureQueueStore.get(id) : null;
  if (!record || !['blocked', 'paused'].includes(record.state)) {
    return { ok: false, reason: 'item_not_held' };
  }
  await CaptureQueueStore.remove(id);
  await upsertFeed({ id, state: 'discarded', reason: null });
  await patchStatus({}, undefined, { tone: 'info', text: 'Held capture discarded' });
  await updateBadge();
  return { ok: true };
}

async function getHeldItemFile(id) {
  const record = typeof id === 'string' ? await CaptureQueueStore.get(id) : null;
  if (!record || !['blocked', 'paused'].includes(record.state)) {
    return { ok: false, reason: 'item_not_held' };
  }
  return {
    ok: true,
    id: record.id,
    mimeType: record.payload.mimeType,
    contentBase64: record.payload.contentBase64
  };
}

async function releaseAllHeld() {
  await CaptureQueueStore.releaseHeld(Date.now());
  await patchStatus({ pausedReason: null });
  await processQueue();
  return getPublicStatus();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  let operation;
  if (message.type === 'QUEUE_CAPTURE') {
    operation = queueCapture(message.payload, {
      origin: message.origin,
      thumbnail: message.thumbnail
    });
  } else if (message.type === 'GET_STATUS') {
    operation = getPublicStatus();
  } else if (message.type === 'PING_SERVER') {
    operation = pingServer();
  } else if (message.type === 'RETRY_QUEUE') {
    operation = releaseAllHeld();
  } else if (message.type === 'SETTINGS_UPDATED') {
    operation = CaptureQueueStore.releaseBlocked(Date.now())
      .then(() => processQueue())
      .then(() => getPublicStatus());
  } else if (message.type === 'LIST_HELD') {
    operation = CaptureQueueStore.listHeld(HELD_LIST_LIMIT).then((items) => ({ items }));
  } else if (message.type === 'DISCARD_ITEM') {
    operation = discardHeldItem(message.id);
  } else if (message.type === 'GET_ITEM_FILE') {
    operation = getHeldItemFile(message.id);
  } else if (message.type === 'DEVTOOLS_HEARTBEAT') {
    operation = recordHeartbeat(message).then(() => {
      void sendServerHeartbeat(false);
      return { ok: true };
    });
  } else if (message.type === 'DEVTOOLS_EVENT') {
    operation = recordDevtoolsEvent(message).then(() => {
      void sendServerHeartbeat(['listening', 'site_changed'].includes(message.kind));
      return { ok: true };
    });
  } else if (message.type === 'GET_FEED') {
    operation = getFeed();
  } else if (message.type === 'CLEAR_FEED') {
    operation = clearFeed().then(() => ({ ok: true }));
  } else if (message.type === 'CAPTURE_DIAGNOSTIC') {
    operation = recordDiagnostic(message).then(() => ({ ok: true }));
  } else if (message.type === 'DEVTOOLS_CLOSED') {
    operation = forgetListener(message).then(() => {
      void sendServerHeartbeat(true);
      return { ok: true };
    });
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
  if (alarm.name === RETRY_ALARM) {
    void processQueue();
  } else if (alarm.name === PERIODIC_ALARM) {
    void processQueue().then(async () => {
      const [status, queue] = await Promise.all([
        readStatus(),
        CaptureQueueStore.summary()
      ]);
      if (status.pausedReason || queue.paused > 0) await pingServer();
      await sendServerHeartbeat(false);
    });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    (changes.serverUrl || changes.ingestToken || changes.captureEnabled)
  ) {
    void updateBadge();
    if (changes.serverUrl || changes.ingestToken) {
      void storageSet({ [KNOWN_KEY]: null });
      void CaptureQueueStore.releaseBlocked(Date.now()).then(() =>
        processQueue()
      );
    }
    void sendServerHeartbeat(true);
  }
});

async function bootstrap() {
  await initializeSettings();
  await getPolicy();
  chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: 1 });
  await updateBadge();
  void processQueue();
  void sendServerHeartbeat(true);
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

void bootstrap();
