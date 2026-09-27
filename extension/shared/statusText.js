(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.StatusText = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  // One vocabulary for the popup and the DevTools panel. Tones match the
  // dashboard status dots: ok, pending, problem.
  const LISTENER = Object.freeze({
    off: { tone: 'pending', text: 'Capture off' },
    closed: { tone: 'pending', text: 'DevTools not open' },
    other_site: { tone: 'pending', text: 'DevTools on another site' },
    watching_unconfirmed: { tone: 'pending', text: 'DevTools open, site not confirmed' },
    watching: { tone: 'ok', text: 'Watching TikTok tab' }
  });

  const SERVER = Object.freeze({
    online: { tone: 'ok', text: 'Online' },
    offline: { tone: 'problem', text: 'Offline' },
    unauthorized: { tone: 'problem', text: 'Token rejected' },
    capture_disabled: { tone: 'problem', text: 'Capture disabled on server' },
    configuration_required: { tone: 'pending', text: 'Setup required' },
    server_error: { tone: 'problem', text: 'Server error' },
    unknown: { tone: 'pending', text: 'Not checked' }
  });

  function describeListener(state) {
    return LISTENER[state] || LISTENER.closed;
  }

  function describeServer(state) {
    return SERVER[state] || { tone: 'pending', text: String(state || 'Unknown') };
  }

  function describeQueue(queue, pausedReason) {
    const count = Number(queue && queue.count) || 0;
    const blocked = Number(queue && queue.blocked) || 0;
    const paused = Number(queue && queue.paused) || 0;
    if (blocked > 0) {
      return { tone: 'problem', text: `${count} (${blocked} blocked)` };
    }
    if (paused > 0 || pausedReason) {
      return { tone: 'pending', text: `${count} held: budget paused` };
    }
    if (count > 0) return { tone: 'pending', text: `${count} delivering` };
    return { tone: 'ok', text: 'Empty' };
  }

  // Compact listener texts, the same as the dashboard header pill.
  const LISTENER_SHORT = Object.freeze({
    off: 'Capture off',
    closed: 'DevTools closed',
    other_site: 'Other site',
    watching_unconfirmed: 'DevTools open',
    watching: 'Watching'
  });

  const SERVER_SHORT = Object.freeze({
    offline: 'Server offline',
    unauthorized: 'Token rejected',
    capture_disabled: 'Server not connected',
    configuration_required: 'Not connected',
    server_error: 'Server error'
  });

  // The single most important state for the header pill of the popup and
  // the panel, in the same order as the dashboard pill
  // (frontend/src/lib/captureModel.js describeCapture).
  function describeOverall(status) {
    const current = status || {};
    const codes = (current.warnings || []).map((warning) => warning && warning.code);
    if (!current.hasToken) return { tone: 'pending', text: 'Not connected' };
    if (SERVER_SHORT[current.serverState]) {
      return { tone: current.serverState === 'configuration_required' ? 'pending' : 'problem', text: SERVER_SHORT[current.serverState] };
    }
    if (codes.includes('challenge')) return { tone: 'problem', text: 'Verification check' };
    if (current.captureEnabled === false) return { tone: 'pending', text: 'Capture off' };
    if (codes.includes('session_limit') || (current.session && current.session.exhausted)) {
      return { tone: 'problem', text: 'Session limit' };
    }
    const queue = current.queue || {};
    if (Number(queue.blocked) > 0) return { tone: 'problem', text: 'Delivery failed' };
    const listener = describeListener(current.listenerState);
    const tones = codes.map((code) => (describeWarning({ code }) || {}).tone);
    const tone = tones.includes('problem') || Number(queue.paused) > 0
      ? 'problem'
      : tones.includes('pending') ? 'pending' : listener.tone;
    return { tone, text: LISTENER_SHORT[current.listenerState] || listener.text };
  }

  const FEED_REASONS = Object.freeze({
    capture_budget_exhausted: 'capture budget paused',
    content_type_mismatch: 'not a sticker image',
    queue_full: 'queue full'
  });

  function describeReason(code) {
    return code ? FEED_REASONS[code] || String(code).replace(/_/g, ' ') : '';
  }

  // Session feed rows in the DevTools panel.
  function describeFeedItem(item) {
    const reason = describeReason(item && item.reason);
    switch (item && item.state) {
      case 'new':
        return { tone: 'ok', text: 'Added to library' };
      case 'duplicate':
        return { tone: 'ok', text: 'Already in library' };
      case 'queued':
        return { tone: 'pending', text: reason ? `Delivering · ${reason}` : 'Delivering…' };
      case 'held':
        return { tone: 'problem', text: `Held: ${reason || 'see popup'}` };
      case 'rejected':
        return { tone: 'problem', text: `Rejected: ${reason || 'unknown reason'}` };
      case 'discarded':
        return { tone: 'pending', text: 'Discarded' };
      default:
        return { tone: 'pending', text: 'Unknown' };
    }
  }

  function describeLogSummary(summary) {
    if (!summary.stickers) {
      return 'No sticker responses in the Network log. It only lists requests made while DevTools was open; scroll the chat normally instead of reloading it.';
    }
    const parts = [
      summary.queued && `${summary.queued} sent to the library`,
      summary.known && `${summary.known} already in library`,
      summary.already && `${summary.already} already queued`,
      summary.held && `${summary.held} held`,
      summary.skipped && `${summary.skipped} skipped`
    ].filter(Boolean);
    return `Found ${summary.stickers} sticker response${summary.stickers === 1 ? '' : 's'}: ${parts.join(', ')}.`;
  }

  // Pacing and account-safety warnings. The dashboard renders the same codes
  // with the same texts (frontend/src/lib/captureModel.js).
  const WARNING_CODES = Object.freeze([
    'challenge',
    'session_limit',
    'cache_disabled',
    'session_near_limit',
    'frequent_navigation',
    'fast_capture'
  ]);

  function describeWarning(warning) {
    const count = Number(warning && warning.count) || 0;
    switch (warning && warning.code) {
      case 'challenge':
        return { tone: 'problem', text: 'TikTok showed a verification check. Capture was turned off: close DevTools and use TikTok normally for a while.' };
      case 'session_limit':
        return { tone: 'problem', text: 'Session limit reached. Captures are kept; after a break, start a new session in the dashboard.' };
      case 'cache_disabled':
        return { tone: 'problem', text: '“Disable cache” or a hard reload is on: every sticker is downloaded again. Turn it off in the DevTools Network panel.' };
      case 'session_near_limit':
        return { tone: 'pending', text: `Session: ${count} of ${warning.max} captures, ${warning.minutes} of ${warning.maxMinutes} min. Plan a break soon.` };
      case 'frequent_navigation':
        return { tone: 'pending', text: `The TikTok tab reloaded ${count} times in 10 min. Reloading to capture again adds traffic.` };
      case 'fast_capture':
        return { tone: 'pending', text: `${count} new stickers in 2 min. Scroll at a normal pace: fast bulk loading looks unlike normal use.` };
      default:
        return null;
    }
  }

  function describeSession(session, now) {
    if (!session || !session.maxCaptures) return null;
    const startedAt = Date.parse(session.startedAt || '');
    const minutes = Number.isFinite(startedAt)
      ? Math.min(Math.round(session.maxMs / 60000), Math.floor((now - startedAt) / 60000))
      : 0;
    const maxMinutes = Math.round((Number(session.maxMs) || 0) / 60000);
    const used = Math.max(
      (Number(session.captureCount) || 0) / session.maxCaptures,
      Number.isFinite(startedAt) && session.maxMs ? (now - startedAt) / session.maxMs : 0
    );
    return {
      tone: session.exhausted ? 'problem' : used >= 0.8 ? 'pending' : 'ok',
      text: session.exhausted
        ? 'Session limit reached'
        : Number.isFinite(startedAt)
          ? `${session.captureCount} of ${session.maxCaptures} captures · ${minutes} of ${maxMinutes} min`
          : `0 of ${session.maxCaptures} captures · starts with the first new sticker`
    };
  }

  const EXTENSIONS = Object.freeze({
    'image/webp': 'webp',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif'
  });

  function heldFileName(item) {
    const extension = EXTENSIONS[item && item.mimeType] || 'bin';
    return `sticker_${String(item && item.id || 'capture').slice(0, 12)}.${extension}`;
  }

  function formatBytesFromBase64(length) {
    const bytes = Math.floor((Number(length) || 0) * 3 / 4);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return {
    describeListener,
    describeServer,
    describeQueue,
    LISTENER_SHORT,
    describeOverall,
    describeReason,
    describeFeedItem,
    describeLogSummary,
    WARNING_CODES,
    describeWarning,
    describeSession,
    heldFileName,
    formatBytesFromBase64
  };
});
