import { useId, useState } from 'react';
import {
  Archive, Copy, RefreshCw, FileWarning, ImageOff, Unlink, Clock, CircleCheck, CircleAlert
} from 'lucide-react';
import { Sheet } from './Sheet';
import { countStorageIssues } from '../lib/stickerModel';

const CATEGORIES = [
  { key: 'missingOriginals', label: 'Missing originals', note: 'Source file is not on disk', icon: FileWarning, library: true },
  { key: 'missingConverted', label: 'Missing outputs', note: 'Converted file is not on disk', icon: ImageOff, library: true },
  { key: 'orphanFiles', label: 'Unlinked files', note: 'Stored but not linked to any sticker', icon: Unlink },
  { key: 'tempEntries', label: 'Temporary entries', note: 'Leftover upload or work files', icon: Clock },
  { key: 'staleConversions', label: 'Interrupted conversions', note: 'Stopped when the server stopped; retry is safe', icon: RefreshCw, library: true }
];

const countOf = (storage, key) => {
  const value = storage?.[key];
  return Array.isArray(value) ? value.length : Number(value) || 0;
};

export function HealthView({
  storage, outputPath, copyText, refreshStatus, onShowNeedsAction,
  handleArchiveLibrary, archiving, bootstrapState, libraryTotal
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [archiveResult, setArchiveResult] = useState(null);
  const [archiveError, setArchiveError] = useState('');
  const confirmTitleId = useId();
  const issues = countStorageIssues(storage);
  const ready = bootstrapState === 'ready';

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError('');
    try {
      await refreshStatus();
    } catch (error) {
      setRefreshError(error.message);
    } finally {
      setRefreshing(false);
    }
  };

  const createArchive = async () => {
    setConfirmOpen(false);
    setArchiveError('');
    setArchiveResult(null);
    try {
      const archive = await handleArchiveLibrary();
      setArchiveResult(archive || {});
    } catch (error) {
      setArchiveError(error.message);
    }
  };

  return (
    <div className="page health-page">
      <div className="page-heading">
        <div>
          <h1>Health</h1>
          <p className="muted">Storage checks, archive snapshots and output folders. Nothing is removed automatically.</p>
        </div>
      </div>

      <section className="panel" aria-labelledby="storage-title">
        <div className="panel-header">
          <div>
            <h2 id="storage-title">Storage</h2>
            <p className="muted small">
              {storage?.checkedAt ? `Last checked ${new Date(storage.checkedAt).toLocaleString()}` : 'The server checks storage when it starts and after imports.'}
            </p>
          </div>
          <button type="button" className="btn" onClick={refresh} disabled={refreshing || !ready}>
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Refresh summary
          </button>
        </div>

        {refreshError && <p className="inline-alert tone-problem" role="alert">Could not refresh: {refreshError}</p>}

        {!storage ? (
          <p className="inline-alert tone-unknown">Storage check unavailable. Connect to the local service and refresh.</p>
        ) : (
          <>
            <p className={`health-headline ${issues ? 'tone-problem' : 'tone-ok'}`}>
              {issues
                ? <><CircleAlert size={20} aria-hidden="true" /> {issues} item(s) need review</>
                : <><CircleCheck size={20} aria-hidden="true" /> No issues found</>}
            </p>
            <ul className="health-grid">
              {CATEGORIES.map((category) => {
                const Icon = category.icon;
                const count = countOf(storage, category.key);
                return (
                  <li key={category.key} className={`health-card ${count ? 'has-issues' : ''}`}>
                    <Icon size={20} aria-hidden="true" />
                    <span className="health-count tabular">{count}</span>
                    <span className="health-label">{category.label}</span>
                    <span className="muted small">{category.note}</span>
                    {count > 0 && category.library && (
                      <button type="button" className="link-btn" onClick={onShowNeedsAction}>Show in library</button>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="muted small">Categories are counted separately: one sticker can have several flags, and unlinked or temporary files may not belong to any sticker. Item-level details are not available yet.</p>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="archives-title">
        <div className="panel-header">
          <div>
            <h2 id="archives-title">Archives</h2>
            <p className="muted small">A snapshot copies the database and media into a dated folder. The active library stays unchanged.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setConfirmOpen(true)} disabled={archiving || !ready || !libraryTotal}>
            <Archive size={16} aria-hidden="true" /> {archiving ? 'Creating snapshot…' : 'Create archive snapshot'}
          </button>
        </div>
        {archiveError && <p className="inline-alert tone-problem" role="alert">Archive could not be created. {archiveError}</p>}
        {archiveResult && (
          <p className="inline-alert tone-ok" role="status">
            Snapshot created{typeof archiveResult.stickerCount === 'number' ? ` with ${archiveResult.stickerCount} stickers` : ''}.
            {archiveResult.path && <> <span className="mono break">{archiveResult.path}</span></>}
          </p>
        )}
        <p className="muted small">Archive history is not available yet. Restoring an archive is a separate manual operation.</p>
      </section>

      <section className="panel" aria-labelledby="output-title">
        <h2 id="output-title">Output & Telegram</h2>
        <ul className="path-list">
          {[
            { key: 'statics', label: 'Static stickers (WebP)' },
            { key: 'animated', label: 'Video stickers (WebM)' },
            { key: 'archives', label: 'Archives' }
          ].map((item) => (
            <li key={item.key}>
              <span className="path-label">{item.label}</span>
              <span className="mono break path-value">{outputPath(item.key)}</span>
              <button type="button" className="btn btn-small" onClick={() => copyText(outputPath(item.key), 'Path copied')}>
                <Copy size={14} aria-hidden="true" /> Copy path
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">
          Upload converted files yourself through the official Telegram <a href="https://t.me/stickers" target="_blank" rel="noreferrer">@Stickers</a> bot.
          This app never publishes to Telegram.
        </p>
      </section>

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} className="sheet sheet-dialog" labelledBy={confirmTitleId}>
        <h2 id={confirmTitleId}>Create archive snapshot?</h2>
        <p>The server copies the database and all media into a new dated folder with a SHA-256 manifest. It needs free disk space roughly equal to the library size. The active library is not changed.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={createArchive}>Create snapshot</button>
        </div>
      </Sheet>
    </div>
  );
}
