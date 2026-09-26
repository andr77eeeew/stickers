(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DeliveryPolicy = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const DEFAULT_SERVER_URL = 'http://127.0.0.1:3001';
  const BLOCKED_STATUSES = new Set([400, 401, 403, 413, 415, 422]);

  function normalizeServerUrl(value) {
    let parsed;
    try {
      parsed = new URL(value || DEFAULT_SERVER_URL);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(parsed.hostname.toLowerCase()) ||
      parsed.port !== '3001' ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return `http://${parsed.hostname.toLowerCase()}:3001`;
  }

  function computeBackoffMs(attempts, baseMs = 1000, maxMs = 60000) {
    const exponent = Math.max(0, Math.min(16, Number(attempts) || 0));
    return Math.min(maxMs, baseMs * 2 ** exponent);
  }

  function parseRetryAfterMs(value) {
    const seconds = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(seconds, 3600) * 1000;
  }

  // Server state is derived from the HTTP status only; the error text is
  // for people, not for classification.
  function serverStateForResponse(status, body) {
    if (status === 401 || status === 403) {
      return body && body.code === 'INGEST_DISABLED'
        ? 'capture_disabled'
        : 'unauthorized';
    }
    if (status >= 500) return 'server_error';
    return 'online';
  }

  function classifyIngestResponse(status, body, retryAfter) {
    const serverState = serverStateForResponse(status, body);
    if (
      status >= 200 &&
      status < 300 &&
      body &&
      (body.success === true || body.duplicate === true)
    ) {
      return {
        action: 'ack',
        duplicate: body.duplicate === true,
        serverState
      };
    }
    if (status === 429 && body && body.budgetExhausted === true) {
      return { action: 'pause', duplicate: false, serverState };
    }
    if (BLOCKED_STATUSES.has(status)) {
      return { action: 'block', duplicate: false, serverState };
    }
    return {
      action: 'retry',
      duplicate: false,
      serverState,
      retryAfterMs: status === 429 ? parseRetryAfterMs(retryAfter) : 0
    };
  }

  return {
    DEFAULT_SERVER_URL,
    normalizeServerUrl,
    computeBackoffMs,
    parseRetryAfterMs,
    serverStateForResponse,
    classifyIngestResponse
  };
});
