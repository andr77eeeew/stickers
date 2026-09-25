import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { countStorageIssues } from '../lib/stickerModel';

// Describes the capture mode only from what the server can actually know.
const describeCapture = ({ captureStatus, sessionInfo }) => {
  const devtools = captureStatus.devtools || {};
  if (devtools.enabled !== true) {
    return {
      tone: 'ok',
      short: 'Manual',
      title: 'Manual import',
      detail: 'Local files are the default path and never contact TikTok. Manual imports do not change the DevTools status.'
    };
  }
  if (sessionInfo?.exhausted) {
    return {
      tone: 'problem',
      short: 'Budget exhausted',
      title: 'DevTools capture budget exhausted',
      detail: `Limit reached (${sessionInfo.exhaustReason || 'budget'}). Reset only when you intentionally start a new capture session.`
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
  if (devtools.state === 'last_asset_accepted') {
    const at = devtools.lastAcceptedAt || devtools.lastIngestAt;
    return {
      tone: 'ok',
      short: 'Last asset accepted',
      title: 'Last DevTools asset accepted',
      detail: `${at ? `Accepted ${new Date(at).toLocaleString()}. ` : ''}The server cannot tell whether the DevTools panel is still open; check the extension popup.`
    };
  }
  return {
    tone: 'pending',
    short: 'Awaiting DevTools',
    title: 'Awaiting opt-in DevTools capture',
    detail: 'Open DevTools before the sticker loads, select the Sticker Capture panel and keep it open. No DOM automation or CDN refetch is used.'
  };
};

export function StatusPopover({
  bootstrapState, bootstrapError, socketConnected, captureStatus, sessionInfo,
  onRetry, onResetBudget, onOpenHealth
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const capture = describeCapture({ captureStatus, sessionInfo });
  const storageIssues = countStorageIssues(captureStatus.storage);
  const devtoolsEnabled = captureStatus.devtools?.enabled === true;

  let service;
  if (bootstrapState === 'error') {
    service = { tone: 'problem', label: 'Service unavailable' };
  } else if (bootstrapState === 'loading') {
    service = { tone: 'pending', label: 'Connecting…' };
  } else if (!socketConnected) {
    service = { tone: 'pending', label: 'Updates paused' };
  } else {
    service = { tone: capture.tone, label: `Local · ${capture.short}` };
  }

  return (
    <div className="status-popover" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="status-pill"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`dot dot-${service.tone}`} aria-hidden="true" />
        <span className="status-pill-label">{service.label}</span>
      </button>

      {open && (
        <div className="popover-panel" id={panelId} role="region" aria-label="Service and capture status">
          <section>
            <h2>Local service</h2>
            <p className="popover-value">
              <span className={`dot dot-${bootstrapState === 'error' ? 'problem' : socketConnected ? 'ok' : 'pending'}`} aria-hidden="true" />
              {bootstrapState === 'error'
                ? 'Unavailable'
                : bootstrapState === 'loading'
                  ? 'Connecting'
                  : socketConnected ? 'Connected · live updates' : 'Connected · updates paused'}
            </p>
            {bootstrapState === 'error' && (
              <p className="popover-detail">{bootstrapError || 'The local session could not be established.'} Retrying automatically.</p>
            )}
            {(bootstrapState === 'error' || !socketConnected) && (
              <button type="button" className="btn btn-small" onClick={onRetry}>
                <RefreshCw size={14} aria-hidden="true" /> Reconnect
              </button>
            )}
          </section>

          <section>
            <h2>Capture</h2>
            <p className="popover-value">
              <span className={`dot dot-${capture.tone}`} aria-hidden="true" />
              {capture.title}
            </p>
            <p className="popover-detail">{capture.detail}</p>
            {devtoolsEnabled && sessionInfo && (
              <div className="popover-row">
                <span className="tabular">Session {sessionInfo.captureCount || 0}/{sessionInfo.maxCaptures || '—'}</span>
                <button type="button" className="btn btn-small" onClick={onResetBudget} disabled={bootstrapState !== 'ready'}>
                  Reset budget
                </button>
              </div>
            )}
            {devtoolsEnabled && (
              <p className="popover-detail">Live capture is never ban-safe; residual account and policy risk remains.</p>
            )}
          </section>

          {storageIssues > 0 && (
            <section>
              <h2>Storage</h2>
              <p className="popover-detail">{storageIssues} item(s) need review. Nothing is removed automatically.</p>
              <button type="button" className="btn btn-small" onClick={() => { setOpen(false); onOpenHealth(); }}>
                Open Health
              </button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
