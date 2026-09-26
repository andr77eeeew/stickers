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
    configuration_required: { tone: 'problem', text: 'Setup required' },
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
    heldFileName,
    formatBytesFromBase64
  };
});
