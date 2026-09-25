import { Sparkles, ExternalLink, Folder, Check, Copy } from 'lucide-react';
import { countStorageIssues, getOutputPath } from '../lib/stickerModel';

export function StatusSection({
  socketConnected, bootstrapState, bootstrapError, captureStatus, sessionInfo,
  outputPaths, folderCopySuccess, copyFolderPath, handleResetSession
}) {
  const devtoolsStatus = captureStatus.devtools || {};
  const devtoolsState = devtoolsStatus.state || 'disabled';
  const isDevtoolsMode = devtoolsStatus.enabled === true;
  const isDeliveryFailure = devtoolsState === 'local_delivery_failed' || Boolean(devtoolsStatus.lastError);
  const lastAcceptedAt = devtoolsStatus.lastAcceptedAt || devtoolsStatus.lastIngestAt;
  const storageIssueCount = countStorageIssues(captureStatus.storage);
  const outputRootPath = getOutputPath('root', outputPaths, captureStatus.storage);

  return (
    <>
      {/* Header */}
      <header className="header">
        <div className="title-container">
          <Sparkles size={36} className="gradient-text" />
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 800 }}>
              TikTok to <span className="gradient-text">Telegram</span>
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '2px', fontWeight: 500 }}>
              Offline-first Sticker Workspace & Telegram Converter
            </p>
          </div>
        </div>

        <div className="glass-panel system-state" role="status" aria-live="polite">
          <span className={`status-dot ${socketConnected ? 'green' : bootstrapState === 'error' ? 'red' : 'yellow'}`} aria-hidden="true" />
          <span style={{ color: 'var(--text-secondary)' }}>
            Local service:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {socketConnected ? 'Connected' : bootstrapState === 'error' ? 'Unavailable' : 'Connecting'}
            </strong>
          </span>
        </div>
      </header>

      {/* Capture Safety Banner */}
      <div
        className="status-banner glass-panel"
        role={bootstrapState === 'error' || (isDevtoolsMode && isDeliveryFailure) ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div className="status-info">
          {bootstrapState === 'loading' ? (
            <>
              <span className="status-dot yellow" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-yellow)' }}>Authenticating local dashboard…</div>
                <div className="status-details">The dashboard establishes a private same-origin session before any API or WebSocket traffic.</div>
              </div>
            </>
          ) : bootstrapState === 'error' ? (
            <>
              <span className="status-dot red" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-red)' }}>Local server unavailable</div>
                <div className="status-details">{bootstrapError || 'Session authentication failed.'} Retrying automatically.</div>
              </div>
            </>
          ) : isDevtoolsMode && sessionInfo?.exhausted ? (
            <>
              <span className="status-dot red" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-red)' }}>DevTools capture budget exhausted</div>
                <div className="status-details">Limit hit ({sessionInfo.exhaustReason || 'budget'}). Reset only after you intentionally begin a new capture session.</div>
              </div>
            </>
          ) : isDevtoolsMode && isDeliveryFailure ? (
            <>
              <span className="status-dot red" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-red)' }}>Local DevTools delivery failed</div>
                <div className="status-details">{devtoolsStatus.lastError || 'The extension could not deliver an already-loaded response body to localhost.'}</div>
              </div>
            </>
          ) : isDevtoolsMode && devtoolsState === 'last_asset_accepted' ? (
            <>
              <span className="status-dot green" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--accent-emerald)' }}>Last DevTools asset accepted</div>
                <div className="status-details">
                  {lastAcceptedAt ? `Accepted ${new Date(lastAcceptedAt).toLocaleString()}. ` : ''}
                  The server cannot determine whether the DevTools panel is still open.
                </div>
              </div>
            </>
          ) : isDevtoolsMode ? (
            <>
              <span className="status-dot yellow" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-yellow)' }}>Awaiting opt-in DevTools capture</div>
                <div className="status-details">Open DevTools before the sticker loads, select the Sticker Capture panel, and keep it open. No DOM automation or CDN refetch is used.</div>
              </div>
            </>
          ) : (
            <>
              <span className="status-dot green" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--accent-emerald)' }}>Offline mode · manual import</div>
                <div className="status-details">Local files are the default path and do not contact TikTok. Manual imports never make live capture appear ready.</div>
              </div>
            </>
          )}
        </div>

        <div className="status-actions">
          <div className="cmd-box">
            <span>{isDevtoolsMode ? 'DevTools → Sticker Capture → keep panel open' : 'Offline default → drop local media below'}</span>
          </div>
          <div className="status-action-row">
            {isDevtoolsMode && sessionInfo && (
              <button
                type="button"
                className="download-btn compact-btn"
                onClick={handleResetSession}
                disabled={bootstrapState !== 'ready'}
              >
                Reset capture budget
              </button>
            )}
            {isDevtoolsMode && (
              <a
                href="https://www.tiktok.com/messages"
                target="_blank"
                rel="noreferrer"
                className="download-btn compact-btn"
              >
                Open TikTok Chats <ExternalLink size={14} />
              </a>
            )}
          </div>
          <span className="status-footnote">
            {isDevtoolsMode
              ? 'Residual account and policy risk remains; live capture is never ban-safe.'
              : 'HAR response bodies are not guaranteed; use manual media import unless a local capability test succeeds.'}
            {sessionInfo && isDevtoolsMode
              ? ` Session ${sessionInfo.captureCount || 0}/${sessionInfo.maxCaptures || '—'}.`
              : ''}
            {storageIssueCount > 0 ? ` Storage health reports ${storageIssueCount} item(s) needing review.` : ''}
          </span>
        </div>
      </div>

      {/* Server-reported storage path; never assume a drive or project location. */}
      <div className="folder-indicator-bar">
        <div className="folder-path-container">
          <div className="folder-icon-wrapper">
            <Folder size={18} aria-hidden="true" />
          </div>
          <div className="folder-path-info">
            <div className="folder-path-label">Active storage root</div>
            <div className="folder-path-value" title={outputRootPath}>
              <span>{outputRootPath}</span>
            </div>
          </div>
        </div>
        <button type="button" className="folder-copy-btn" onClick={copyFolderPath}>
          {folderCopySuccess ? (
            <>
              <Check size={14} style={{ color: 'var(--accent-emerald)' }} aria-hidden="true" />
              <span style={{ color: 'var(--accent-emerald)' }}>Copied!</span>
            </>
          ) : (
            <>
              <Copy size={14} aria-hidden="true" />
              <span>Copy path</span>
            </>
          )}
        </button>
      </div>

    </>
  );
}
