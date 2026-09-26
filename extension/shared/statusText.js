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

  const FEED_REASONS = Object.freeze({
    capture_budget_exhausted: 'capture budget paused',
    content_type_mismatch: 'not a sticker image',
    queue_full: 'queue full'
  });

  // Session feed rows in the DevTools panel.
  function describeFeedItem(item) {
    const reason = item && item.reason ? FEED_REASONS[item.reason] || item.reason : '';
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
    describeFeedItem,
    describeLogSummary,
    heldFileName,
    formatBytesFromBase64
  };
});
