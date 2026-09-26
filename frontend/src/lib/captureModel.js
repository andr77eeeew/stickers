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

// Same texts as describeWarning / describeSession in extension/shared/statusText.js.
export function describeWarning(warning) {
  const count = Number(warning?.count) || 0;
  switch (warning?.code) {
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

export function describeSession(session, now = Date.now()) {
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
  const extension = devtools.extension || {};
  const warnings = extension.connected
    ? (extension.warnings || []).map(describeWarning).filter(Boolean)
    : [];
  const challenge = extension.connected && (extension.warnings || []).some((warning) => warning.code === 'challenge');
  if (challenge) {
    return {
      tone: 'problem',
      short: 'Verification check',
      title: 'TikTok showed a verification check',
      detail: describeWarning({ code: 'challenge' }).text,
      warnings: warnings.filter((warning) => warning.text !== describeWarning({ code: 'challenge' }).text)
    };
  }
  if (sessionInfo?.exhausted) {
    return {
      tone: 'problem',
      short: 'Session limit',
      title: 'Capture session limit reached',
      detail: describeWarning({ code: 'session_limit' }).text,
      warnings: warnings.filter((warning) => warning.text !== describeWarning({ code: 'session_limit' }).text)
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

  const listener = extension.connected ? LISTENER_LABELS[extension.listenerState] : null;
  if (listener) {
    const queue = extension.queue || {};
    const held = (queue.blocked || 0) + (queue.paused || 0);
    const warningTone = warnings.some((warning) => warning.tone === 'problem')
      ? 'problem'
      : warnings.length ? 'pending' : null;
    return {
      warnings,
      tone: held || warningTone === 'problem' ? 'problem' : warningTone || listener.tone,
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
