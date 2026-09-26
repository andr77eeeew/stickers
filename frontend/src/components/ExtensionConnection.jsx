import { useEffect, useId, useRef, useState } from 'react';
import { Copy, EyeOff, KeyRound, Link2, Unlink } from 'lucide-react';
import { Sheet } from './Sheet';
import { apiFetch } from '../lib/api';
import { LISTENER_LABELS, describePairing, formatAgo } from '../lib/captureModel';

const readJson = (response) => response.json().catch(() => ({}));

// Pairs the optional capture extension with this server. The token is shown
// only on request and is never part of status updates.
export function ExtensionConnection({ devtools, ready, copyText, focused, onFocusHandled }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const headingRef = useRef(null);
  const titleId = useId();
  const confirmTitleId = useId();
  const tokenId = useId();
  const pairing = describePairing(devtools?.pairing);
  const extension = devtools?.extension || {};
  const listener = extension.connected ? LISTENER_LABELS[extension.listenerState] : null;

  useEffect(() => {
    if (!focused) return;
    headingRef.current?.scrollIntoView({ block: 'start' });
    headingRef.current?.focus({ preventScroll: true });
    onFocusHandled();
  }, [focused, onFocusHandled]);

  const call = async (route, { keepToken = true } = {}) => {
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(route, { method: 'POST' });
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'The request failed.');
      setToken(keepToken ? result.token || '' : '');
      return true;
    } catch (requestError) {
      setError(requestError.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setAutoConvert = async (autoConvert) => {
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/extension/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoConvert })
      });
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'The setting could not be saved.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setConfirmOpen(false);
    await call('/api/extension/unpair', { keepToken: false });
  };

  return (
    <section className="panel" aria-labelledby={titleId} id="capture-extension">
      <div className="panel-header">
        <div>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>Capture extension</h2>
          <p className="muted small">
            Optional live capture of stickers that TikTok DMs already loaded, through Chrome DevTools.
            It is never ban-safe; manual import stays the safest path.
          </p>
        </div>
        {pairing.state === 'none' ? (
          <button type="button" className="btn btn-primary" onClick={() => call('/api/extension/pair')} disabled={busy || !ready}>
            <Link2 size={16} aria-hidden="true" /> {busy ? 'Connecting…' : 'Connect extension'}
          </button>
        ) : !token && (
          <button type="button" className="btn" onClick={() => call('/api/extension/token')} disabled={busy || !ready}>
            <KeyRound size={16} aria-hidden="true" /> Show token
          </button>
        )}
      </div>

      {error && <p className="inline-alert tone-problem" role="alert">{error}</p>}

      <dl className="extension-facts">
        <div>
          <dt>Connection</dt>
          <dd>
            <span className={`dot dot-${pairing.state === 'none' ? 'pending' : 'ok'}`} aria-hidden="true" /> {pairing.text}
          </dd>
        </div>
        <div>
          <dt>Extension</dt>
          <dd>
            {listener ? (
              <>
                <span className={`dot dot-${listener.tone}`} aria-hidden="true" /> {listener.text}
                <span className="muted"> · last signal {formatAgo(extension.lastSeenAt)}</span>
                {extension.version && <span className="muted"> · v{extension.version}</span>}
              </>
            ) : (
              <>
                <span className="dot dot-pending" aria-hidden="true" /> No signal from the extension
              </>
            )}
          </dd>
        </div>
      </dl>

      {pairing.state !== 'none' && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={devtools?.autoConvert !== false}
            disabled={busy || !ready}
            onChange={(event) => setAutoConvert(event.target.checked)}
          />
          Convert new captures to Telegram format automatically (one job per burst of captures)
        </label>
      )}

      {token && (
        <div className="token-box">
          <label htmlFor={tokenId}>Connection token</label>
          <div className="token-row">
            <input id={tokenId} className="mono" readOnly value={token} onFocus={(event) => event.target.select()} />
            <button type="button" className="btn btn-small" onClick={() => copyText(token, 'Token copied')}>
              <Copy size={14} aria-hidden="true" /> Copy
            </button>
            <button type="button" className="btn btn-small" onClick={() => setToken('')}>
              <EyeOff size={14} aria-hidden="true" /> Hide
            </button>
          </div>
          <ol className="muted small steps">
            <li>Open the Sticker Capture extension popup in Chrome.</li>
            <li>Paste the token into <strong>Connection token</strong> and choose <strong>Save and reconnect</strong>.</li>
            <li>Turn on <strong>Capture enabled</strong>, then open DevTools on the TikTok tab before stickers load.</li>
          </ol>
          <p className="muted small">Anyone with this token can send files to this computer’s library. Do not share it or put it in screenshots.</p>
        </div>
      )}

      {pairing.state === 'env' && (
        <p className="muted small">Managed by <code>INGEST_TOKEN</code> in <code>.env</code>. Remove it there and restart the server to connect from here instead.</p>
      )}
      {pairing.state === 'paired' && (
        <button type="button" className="btn btn-small" onClick={() => setConfirmOpen(true)} disabled={busy || !ready}>
          <Unlink size={14} aria-hidden="true" /> Disconnect
        </button>
      )}

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} className="sheet sheet-dialog" labelledBy={confirmTitleId}>
        <h2 id={confirmTitleId}>Disconnect the extension?</h2>
        <p>The token is deleted and the extension stops delivering until you connect it again with a new token. Stickers already in the library are not changed.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={disconnect}>Disconnect</button>
        </div>
      </Sheet>
    </section>
  );
}
