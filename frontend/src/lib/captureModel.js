// Capture status as the dashboard can honestly know it: pairing comes from
// the server, listener state only from extension heartbeats. The listener
// texts are the same as extension/shared/statusText.js (checked by a test).

export const LISTENER_LABELS = Object.freeze({
  off: { tone: 'pending', text: 'Capture off' },
  closed: { tone: 'pending', text: 'DevTools not open' },
  other_site: { tone: 'pending', text: 'DevTools on another site' },
  watching_unconfirmed: { tone: 'pending', text: 'DevTools open, site not confirmed' },
  watching: { tone: 'ok', text: 'Watching TikTok tab' }
});

// Compact forms for the header pill; the popover shows the full text.
const LISTENER_SHORT = Object.freeze({
  off: 'Capture off',
  closed: 'DevTools closed',
  other_site: 'Other site',
  watching_unconfirmed: 'DevTools open',
  watching: 'Watching'
});

const LISTENER_DETAILS = Object.freeze({
  off: 'Capture is turned off in the extension popup.',
  closed: 'Open DevTools on the TikTok tab before stickers load; the Sticker Capture panel does not need to be selected.',
  other_site: 'DevTools is open on another site. Nothing is read there; switch DevTools to the TikTok tab.',
  watching_unconfirmed: 'DevTools is open, but the extension has not confirmed the site yet.',
  watching: 'Stickers that load in the chat are delivered to this computer. No DOM automation or CDN refetch is used.'
});

export function formatAgo(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(at).toLocaleString();
}

export function describeCapture({ captureStatus = {}, sessionInfo = null, now = Date.now() }) {
  const devtools = captureStatus.devtools || {};
  if (devtools.enabled !== true) {
    return {
      tone: 'ok',
      short: 'Manual',
      title: 'Manual import',
      detail: 'Local files are the default path and never contact TikTok. To capture from TikTok DMs, connect the extension in Health.',
      connectable: true
    };
  }
  if (sessionInfo?.exhausted) {
    return {
      tone: 'problem',
      short: 'Budget exhausted',
      title: 'DevTools capture budget exhausted',
      detail: `Limit reached (${sessionInfo.exhaustReason || 'budget'}). The extension keeps new captures and delivers them after you reset the budget.`
    };
  }
  if (devtools.state === 'local_delivery_failed' || devtools.lastError) {
    return {
      tone: 'problem',
      short: 'Delivery failed',
      title: 'Local DevTools delivery failed',
      detail: devtools.lastError || 'The extension could not deliver an already-loaded response body to this computer.'
    };
  }

  const extension = devtools.extension || {};
  const listener = extension.connected ? LISTENER_LABELS[extension.listenerState] : null;
  if (listener) {
    const queue = extension.queue || {};
    const held = (queue.blocked || 0) + (queue.paused || 0);
    return {
      tone: held ? 'problem' : listener.tone,
      short: LISTENER_SHORT[extension.listenerState],
      title: `Extension · ${listener.text}`,
      detail: `${LISTENER_DETAILS[extension.listenerState]} Last signal ${formatAgo(extension.lastSeenAt, now)}.${held ? ` ${held} capture(s) held in the extension; see its popup.` : ''}`
    };
  }

  const noSignal = 'No signal from the extension: it is not installed, not connected or Chrome is closed.';
  if (devtools.state === 'last_asset_accepted') {
    const at = devtools.lastAcceptedAt || devtools.lastIngestAt;
    return {
      tone: 'ok',
      short: 'Last asset accepted',
      title: 'Last DevTools asset accepted',
      detail: `${at ? `Accepted ${new Date(at).toLocaleString()}. ` : ''}${noSignal}`
    };
  }
  return {
    tone: 'pending',
    short: 'Awaiting DevTools',
    title: 'Awaiting opt-in DevTools capture',
    detail: noSignal
  };
}

export function describePairing(pairing) {
  if (!pairing?.enabled) {
    return { state: 'none', text: 'Not connected' };
  }
  if (pairing.source === 'env') {
    return { state: 'env', text: 'Connected with INGEST_TOKEN from .env' };
  }
  return {
    state: 'paired',
    text: pairing.createdAt
      ? `Connected ${new Date(pairing.createdAt).toLocaleString()}`
      : 'Connected'
  };
}
