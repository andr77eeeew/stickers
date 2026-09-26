import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { countStorageIssues } from '../lib/stickerModel';
import { describeCapture } from '../lib/captureModel';

const AGO_REFRESH_MS = 5000;

export function StatusPopover({
  bootstrapState, bootstrapError, socketConnected, captureStatus, sessionInfo,
  onRetry, onResetBudget, onOpenHealth, onConnectExtension
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelId = useId();
  const [now, setNow] = useState(() => Date.now());

  // Keeps "Last signal N s ago" honest while the popover is open.
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => setNow(Date.now()), AGO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open]);

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

  const capture = describeCapture({ captureStatus, sessionInfo, now });
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
    service = { tone: capture.tone, prefix: 'Local · ', label: capture.short };
  }

  return (
    <div className="status-popover" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="status-pill"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setNow(Date.now());
          setOpen((value) => !value);
        }}
      >
        <span className={`dot dot-${service.tone}`} aria-hidden="true" />
        <span className="status-pill-label">
          {service.prefix && <span className="status-pill-prefix">{service.prefix}</span>}
          {service.label}
        </span>
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
            {capture.connectable && (
              <button type="button" className="btn btn-small" onClick={() => { setOpen(false); onConnectExtension(); }}>
                Connect extension
              </button>
            )}
            {devtoolsEnabled && captureStatus.devtools?.lastRejectedAt && (
              <p className="popover-detail">
                Last rejected {new Date(captureStatus.devtools.lastRejectedAt).toLocaleString()}: {captureStatus.devtools.lastRejectedReason}
              </p>
            )}
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
