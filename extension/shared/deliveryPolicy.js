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

  function classifyIngestResponse(status, body) {
    if (
      status >= 200 &&
      status < 300 &&
      body &&
      (body.success === true || body.duplicate === true)
    ) {
      return {
        action: 'ack',
        duplicate: body.duplicate === true
      };
    }
    if (BLOCKED_STATUSES.has(status)) {
      return { action: 'block', duplicate: false };
    }
    return { action: 'retry', duplicate: false };
  }

  return {
    DEFAULT_SERVER_URL,
    normalizeServerUrl,
    computeBackoffMs,
    classifyIngestResponse
  };
});
