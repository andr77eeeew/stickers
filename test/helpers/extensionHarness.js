'use strict';

// Runs extension scripts in a vm context with in-memory chrome.* APIs.
// Every fetch is recorded; anything that is neither an extension resource
// nor a loopback server is refused and reported as a violation.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extensionRoot = path.resolve(__dirname, '..', '..', 'extension');
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46,
  0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50
]);
const STICKER_URL =
  'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/demo.awebp?x-signature=secret#frag';

// Lets queued work finish. WebCrypto digests run on the thread pool, so pure
// setImmediate rounds can outrun them when the whole suite runs in parallel;
// short real pauses give them time.
async function settle(rounds = 60) {
  for (let step = 0; step < rounds; step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (step % 5 === 4) await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// Mirrors the public API of extension/shared/queueStore.js without IndexedDB.
function createMemoryQueueStore() {
  const records = new Map();
  const clone = (value) => structuredClone(value);
  const HELD_STATES = ['blocked', 'paused'];
  const HELD_UNTIL = Number.MAX_SAFE_INTEGER;

  function summarize() {
    let count = 0;
    let blocked = 0;
    let paused = 0;
    let earliestNextAttemptAt = null;
    for (const record of records.values()) {
      count += 1;
      if (record.state === 'blocked') blocked += 1;
      if (record.state === 'paused') paused += 1;
      if (
        !HELD_STATES.includes(record.state) &&
        (earliestNextAttemptAt === null ||
          record.nextAttemptAt < earliestNextAttemptAt)
      ) {
        earliestNextAttemptAt = record.nextAttemptAt;
      }
    }
    return { count, blocked, paused, earliestNextAttemptAt };
  }

  function release(states, now) {
    for (const record of records.values()) {
      if (states.includes(record.state)) {
        record.state = 'pending';
        record.nextAttemptAt = now;
        record.lastError = null;
      }
    }
  }

  return {
    HELD_UNTIL,
    records,
    async get(id) {
      return records.has(id) ? clone(records.get(id)) : undefined;
    },
    async count() {
      return records.size;
    },
    async add(record) {
      if (records.has(record.id)) {
        const error = new Error('Key already exists in the object store.');
        error.name = 'ConstraintError';
        throw error;
      }
      records.set(record.id, clone(record));
    },
    async put(record) {
      records.set(record.id, clone(record));
    },
    async remove(id) {
      records.delete(id);
    },
    async getDue(now, limit) {
      return [...records.values()]
        .filter((record) => record.nextAttemptAt <= now && !HELD_STATES.includes(record.state))
        .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)
        .slice(0, limit)
        .map(clone);
    },
    async summary() {
      return summarize();
    },
    async releaseBlocked(now) {
      release(['blocked'], now);
    },
    async releaseHeld(now) {
      release(HELD_STATES, now);
    },
    async releasePaused(now) {
      release(['paused'], now);
    },
    async pausePending(reason) {
      for (const record of records.values()) {
        if (record.state === 'pending') {
          record.state = 'paused';
          record.nextAttemptAt = HELD_UNTIL;
          record.lastError = reason;
        }
      }
    },
    async listHeld(limit) {
      return [...records.values()]
        .filter((record) => HELD_STATES.includes(record.state))
        .slice(0, limit)
        .map((record) => ({
          id: record.id,
          state: record.state,
          attempts: record.attempts,
          createdAt: record.createdAt,
          lastError: record.lastError,
          mimeType: record.payload && record.payload.mimeType,
          base64Length: record.payload ? record.payload.contentBase64.length : 0
        }));
    }
  };
}

const TIKTOK_DOCUMENT = Object.freeze({
  type: 'document',
  url: 'https://www.tiktok.com/messages?lang=en'
});

function createChrome({ storage = {}, resources = [TIKTOK_DOCUMENT] } = {}) {
  const store = structuredClone(storage);
  const sessionStore = {};
  const listeners = {
    storage: [],
    message: [],
    alarm: [],
    installed: [],
    startup: [],
    requestFinished: [],
    navigated: []
  };
  const alarms = new Map();
  const badge = { text: '', color: null };
  const panels = [];

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (resource) => `${EXTENSION_ORIGIN}/${resource}`,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8')),
      onMessage: { addListener: (listener) => listeners.message.push(listener) },
      onInstalled: { addListener: (listener) => listeners.installed.push(listener) },
      onStartup: { addListener: (listener) => listeners.startup.push(listener) },
      sendMessage: null
    },
    storage: {
      local: {
        get(defaults, callback) {
          const result = {};
          for (const [key, fallback] of Object.entries(defaults || {})) {
            result[key] = key in store ? structuredClone(store[key]) : fallback;
          }
          queueMicrotask(() => callback(result));
        },
        set(values, callback) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = structuredClone(value);
          }
          queueMicrotask(() => {
            if (callback) callback();
            for (const listener of listeners.storage) listener(changes, 'local');
          });
        }
      },
      session: {
        get(defaults, callback) {
          const result = {};
          for (const [key, fallback] of Object.entries(defaults || {})) {
            result[key] = key in sessionStore ? structuredClone(sessionStore[key]) : fallback;
          }
          queueMicrotask(() => callback(result));
        },
        set(values, callback) {
          for (const [key, value] of Object.entries(values)) sessionStore[key] = structuredClone(value);
          queueMicrotask(() => callback && callback());
        }
      },
      onChanged: { addListener: (listener) => listeners.storage.push(listener) }
    },
    alarms: {
      create(name, info) {
        alarms.set(name, info);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: { addListener: (listener) => listeners.alarm.push(listener) }
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      }
    },
    devtools: {
      network: {
        onRequestFinished: {
          addListener: (listener) => listeners.requestFinished.push(listener)
        },
        onNavigated: {
          addListener: (listener) => listeners.navigated.push(listener)
        }
      },
      panels: {
        themeName: 'default',
        create(title, icon, page) {
          panels.push({ title, icon, page });
        }
      },
      inspectedWindow: {
        tabId: 7,
        getResources(callback) {
          queueMicrotask(() => callback(resources.map((resource) => ({ ...resource }))));
        }
      }
    }
  };

  return { chrome, store, sessionStore, listeners, alarms, badge, panels };
}

function createFetch({ server }) {
  const calls = [];
  const violations = [];

  async function fetch(input, options = {}) {
    const url = String(input);
    calls.push({ url, options });

    if (url.startsWith(`${EXTENSION_ORIGIN}/`)) {
      const relative = url.slice(EXTENSION_ORIGIN.length + 1);
      const filePath = path.join(extensionRoot, relative);
      return new Response(fs.readFileSync(filePath), { status: 200 });
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      violations.push(url);
      throw new TypeError(`Invalid URL ${url}`);
    }
    if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      violations.push(url);
      throw new TypeError(`Non-loopback fetch refused: ${url}`);
    }

    const reply = (await server.handle(parsed.pathname, options)) || {};
    return new Response(JSON.stringify(reply.body || {}), {
      status: reply.status || 200,
      headers: { 'content-type': 'application/json', ...(reply.headers || {}) }
    });
  }

  return { fetch, calls, violations };
}

function defaultServer() {
  const server = {
    ingest: [],
    heartbeats: [],
    handle(pathname, options) {
      if (pathname === '/api/extension/heartbeat') {
        server.heartbeats.push({ headers: options.headers || {}, body: JSON.parse(options.body) });
        return server.onHeartbeat(server.heartbeats.at(-1));
      }
      if (pathname === '/api/ingest') {
        server.ingest.push({
          headers: options.headers || {},
          body: JSON.parse(options.body)
        });
        return server.onIngest(server.ingest.at(-1));
      }
      if (pathname === '/api/status') return { status: 200, body: {} };
      return { status: 404, body: { error: 'not found' } };
    },
    onIngest: () => ({ status: 200, body: { success: true, duplicate: false } }),
    onHeartbeat: () => ({ status: 200, body: { ok: true, session: { exhausted: false } } })
  };
  return server;
}

// Intervals never fire on their own; tests run them with tickIntervals().
function createContext(chrome, fetch, intervals) {
  return vm.createContext({
    chrome,
    fetch,
    console,
    setTimeout,
    clearTimeout,
    setInterval: (callback) => intervals.push(callback),
    clearInterval: () => undefined,
    AbortController,
    URL,
    crypto: globalThis.crypto,
    btoa,
    atob,
    structuredClone,
    queueMicrotask,
    TextEncoder
  });
}

function runFile(context, relativePath) {
  vm.runInContext(
    fs.readFileSync(path.join(extensionRoot, relativePath), 'utf8'),
    context,
    { filename: relativePath }
  );
}

const READY_STORAGE = Object.freeze({
  settingsVersion: 2,
  serverUrl: 'http://127.0.0.1:3001',
  ingestToken: 'test-ingest-token',
  captureEnabled: true
});

async function loadBackground({ storage = READY_STORAGE } = {}) {
  const env = createChrome({ storage });
  const server = defaultServer();
  const network = createFetch({ server });
  const queue = createMemoryQueueStore();
  const intervals = [];
  const context = createContext(env.chrome, network.fetch, intervals);
  context.importScripts = (...files) => {
    for (const file of files) {
      if (file === 'shared/queueStore.js') {
        context.CaptureQueueStore = queue;
      } else {
        runFile(context, file);
      }
    }
  };
  runFile(context, 'background.js');
  await settle();

  function send(message) {
    return new Promise((resolve) => {
      let async = false;
      for (const listener of env.listeners.message) {
        if (listener(message, {}, resolve) === true) async = true;
      }
      if (!async) resolve(undefined);
    });
  }

  async function sendAndSettle(message) {
    const response = await send(message);
    await settle();
    return response;
  }

  async function fireAlarm(name) {
    for (const listener of env.listeners.alarm) listener({ name });
    await settle();
  }

  return {
    ...env,
    context,
    server,
    network,
    queue,
    send,
    sendAndSettle,
    fireAlarm,
    status: () => send({ type: 'GET_STATUS' })
  };
}

async function loadDevtools({
  storage = { captureEnabled: true },
  resources = [TIKTOK_DOCUMENT]
} = {}) {
  const env = createChrome({ storage, resources });
  const server = defaultServer();
  const network = createFetch({ server });
  const messages = [];
  env.chrome.runtime.sendMessage = (message, callback) => {
    messages.push(message);
    queueMicrotask(() =>
      callback({ ok: true, queued: message.type === 'QUEUE_CAPTURE' })
    );
  };
  const intervals = [];
  const pageListeners = {};
  const context = createContext(env.chrome, network.fetch, intervals);
  context.addEventListener = (type, listener) => {
    (pageListeners[type] = pageListeners[type] || []).push(listener);
  };
  for (const file of ['shared/stickerPolicy.js', 'shared/capturePayload.js', 'shared/capturePipeline.js', 'devtools.js']) {
    runFile(context, file);
  }
  await settle();

  async function finish(entry) {
    for (const listener of env.listeners.requestFinished) listener(entry);
    await settle();
  }

  async function navigate(url) {
    for (const listener of env.listeners.navigated) listener(url);
    await settle();
  }

  async function tickIntervals() {
    for (const callback of intervals) callback();
    await settle();
  }

  function closeDevtools() {
    for (const listener of pageListeners.pagehide || []) listener({});
  }

  return { ...env, context, network, messages, finish, navigate, tickIntervals, closeDevtools };
}

function finishedRequest({
  url = STICKER_URL,
  status = 200,
  mimeType = 'image/webp',
  headers = [],
  body = WEBP_BYTES,
  encoding = 'base64',
  requestHeaders = []
} = {}) {
  const entry = {
    getContentCalls: 0,
    request: { url, method: 'GET', headers: [{ name: 'Cookie', value: 'sid=secret' }, ...requestHeaders] },
    response: {
      status,
      headers,
      content: { mimeType, size: body.length }
    },
    getContent(callback) {
      entry.getContentCalls += 1;
      queueMicrotask(() =>
        callback(encoding === 'base64' ? body.toString('base64') : body.toString('latin1'), encoding)
      );
    }
  };
  return entry;
}

function capturePayload(overrides = {}) {
  return {
    source: 'devtools',
    sourceUrl: STICKER_URL,
    mimeType: 'image/webp',
    observedAt: '2026-09-26T12:00:00.000Z',
    contentBase64: WEBP_BYTES.toString('base64'),
    ...overrides
  };
}

module.exports = {
  EXTENSION_ORIGIN,
  READY_STORAGE,
  STICKER_URL,
  WEBP_BYTES,
  capturePayload,
  extensionRoot,
  finishedRequest,
  loadBackground,
  loadDevtools,
  settle
};
