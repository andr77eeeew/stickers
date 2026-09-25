import { useCallback, useEffect, useId, useState } from 'react';
import {
  Archive, Copy, RefreshCw, FileWarning, ImageOff, Unlink, Clock, CircleCheck, CircleAlert,
  CircleHelp, ShieldCheck, LoaderCircle
} from 'lucide-react';
import { Sheet } from './Sheet';
import { apiFetch } from '../lib/api';
import { countStorageIssues } from '../lib/stickerModel';
import { describeFailure } from '../lib/jobModel';

const CATEGORIES = [
  { key: 'missingOriginals', label: 'Missing originals', note: 'Source file is not on disk', meaning: 'The imported source is gone. Convert and Edit are unavailable; an existing output can still be downloaded.', icon: FileWarning, sticker: true },
  { key: 'missingConverted', label: 'Missing outputs', note: 'Converted file is not on disk', meaning: 'The Telegram file is gone. Re-convert it from the original.', icon: ImageOff, sticker: true },
  { key: 'staleConversions', label: 'Interrupted conversions', note: 'Stopped when the server stopped', meaning: 'The server stopped during conversion. Retry is safe.', icon: RefreshCw, sticker: true },
  { key: 'orphanFiles', label: 'Unlinked files', note: 'Stored but not linked to any sticker', meaning: 'A media file with no library record. Review it manually; nothing is deleted.', icon: Unlink },
  { key: 'tempEntries', label: 'Temporary entries', note: 'Upload or work files', meaning: 'Leftover or in-progress work files. They may belong to a running job.', icon: Clock }
];

const countOf = (storage, key) => {
  const value = storage?.[key];
  return Array.isArray(value) ? value.length : Number(value) || 0;
};

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

const formatSize = (bytes) => {
  if (typeof bytes !== 'number') return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

const INTEGRITY = {
  verified: { icon: CircleCheck, tone: 'ok', label: 'Verified' },
  mismatch: { icon: CircleAlert, tone: 'problem', label: 'Mismatch' },
  unverifiable: { icon: CircleHelp, tone: 'unknown', label: 'Could not verify' },
  none: { icon: CircleHelp, tone: 'unknown', label: 'Not checked' }
};

function StorageIssues({ issues, stickerIds, onOpenSticker }) {
  const [category, setCategory] = useState(() => CATEGORIES.find((item) => issues[item.key]?.items.length)?.key || CATEGORIES[0].key);
  const current = CATEGORIES.find((item) => item.key === category);
  const bucket = issues[category] || { items: [], truncated: false };

  return (
    <div className="issue-browser">
      <div className="chip-group chip-wrap" role="group" aria-label="Issue category">
        {CATEGORIES.map((item) => (
          <button
            key={item.key}
            type="button"
            className="chip"
            aria-pressed={category === item.key}
            onClick={() => setCategory(item.key)}
          >
            {item.label} <span className="chip-count">{issues[item.key]?.items.length || 0}{issues[item.key]?.truncated ? '+' : ''}</span>
          </button>
        ))}
      </div>
      <p className="muted small">{current.meaning}</p>
      {bucket.items.length === 0 ? (
        <p className="inline-alert tone-ok">No items in this category.</p>
      ) : (
        <ul className="issue-list">
          {bucket.items.map((item) => (
            <li key={`${item.stickerId || ''}${item.name}`} className="issue-row">
              <span className="issue-name">
                {item.stickerId && <span className="mono">{item.stickerId.slice(0, 8)}</span>}
                <span className="mono break muted small">{item.name}</span>
              </span>
              {current.sticker && item.stickerId && stickerIds.has(item.stickerId)
                ? <button type="button" className="btn btn-small" onClick={() => onOpenSticker(item.stickerId)}>Open sticker</button>
                : <span className="muted small">Review manually</span>}
            </li>
          ))}
        </ul>
      )}
      {bucket.truncated && <p className="muted small">Showing the first {bucket.items.length} items.</p>}
    </div>
  );
}

function ArchiveRow({ archive, onVerify, verifying, busy }) {
  const verification = archive.lastVerification;
  const integrity = INTEGRITY[verification?.status || (archive.problem ? 'unverifiable' : 'none')];
  const Icon = integrity.icon;
  const date = archive.createdAt ? new Date(archive.createdAt) : null;
  const details = verification && verification.status !== 'verified'
    ? ['missing', 'changed', 'extra'].flatMap((kind) => (verification[kind] || []).map((file) => ({ kind, file })))
    : [];

  return (
    <li className="archive-row">
      <div className="archive-main">
        <p className="archive-date">{date ? date.toLocaleString() : 'Date unknown'}</p>
        <p className="muted small mono break">{archive.id}</p>
      </div>
      <dl className="archive-facts tabular">
        <div><dt>Stickers</dt><dd>{archive.stickerCount ?? '—'}</dd></div>
        <div><dt>Files</dt><dd>{archive.fileCount ?? '—'}</dd></div>
        <div><dt>Size</dt><dd>{formatSize(archive.totalBytes)}</dd></div>
      </dl>
      <p className={`archive-integrity tone-${integrity.tone}`}>
        <Icon size={16} aria-hidden="true" /> {integrity.label}
        {verification?.verifiedAt && <span className="muted small"> · {new Date(verification.verifiedAt).toLocaleTimeString()}</span>}
      </p>
      <button type="button" className="btn btn-small" onClick={() => onVerify(archive.id)} disabled={busy || Boolean(archive.problem)}>
        {verifying ? <><LoaderCircle size={14} className="spin" aria-hidden="true" /> Verifying…</> : <><ShieldCheck size={14} aria-hidden="true" /> Verify files</>}
      </button>
      {archive.problem && <p className="archive-note muted small">The manifest is {archive.problem === 'missing_manifest' ? 'missing' : 'unreadable'}, so this archive cannot be verified.</p>}
      {verification?.status === 'mismatch' && (
        <div className="archive-note">
          <p className="small tone-problem">
            {verification.counts.missing} missing · {verification.counts.changed} changed · {verification.counts.extra} unexpected. The archive was not modified.
          </p>
          <ul className="plain-list small mono">
            {details.slice(0, 12).map((entry) => <li key={`${entry.kind}:${entry.file}`}>{entry.kind}: {entry.file}</li>)}
          </ul>
        </div>
      )}
      {verification?.status === 'verified' && verification.counts.extra > 0 && (
        <p className="archive-note muted small">{verification.counts.extra} file(s) not listed in the manifest were found; listed files all match.</p>
      )}
    </li>
  );
}

export function HealthView({
  storage, outputPath, copyText, onShowNeedsAction, onOpenSticker, stickerIds,
  handleArchiveLibrary, archiving, bootstrapState, libraryTotal, setCaptureStatus
}) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [issues, setIssues] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [archiveResult, setArchiveResult] = useState(null);
  const [archiveError, setArchiveError] = useState('');
  const [archives, setArchives] = useState(null);
  const [archivesError, setArchivesError] = useState('');
  const [verifyingId, setVerifyingId] = useState(null);
  const [verifyError, setVerifyError] = useState('');
  const confirmTitleId = useId();
  const issueCount = countStorageIssues(storage);
  const ready = bootstrapState === 'ready';

  const loadArchives = useCallback(async () => {
    try {
      const response = await apiFetch('/api/library/archives');
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'Archive list unavailable');
      setArchives(result.archives || []);
      setArchivesError('');
    } catch (error) {
      setArchivesError(error.message);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    // Fetching on entry keeps the list current; the result is local to this view.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadArchives();
  }, [ready, loadArchives]);

  const runCheck = async () => {
    setChecking(true);
    setCheckError('');
    try {
      const response = await apiFetch('/api/storage/check', { method: 'POST' });
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'Storage check failed');
      setIssues(result.issues);
      setCaptureStatus((previous) => ({ ...previous, storage: result.storage }));
    } catch (error) {
      setCheckError(describeFailure(error.message));
    } finally {
      setChecking(false);
    }
  };

  const createArchive = async () => {
    setConfirmOpen(false);
    setArchiveError('');
    setArchiveResult(null);
    try {
      const archive = await handleArchiveLibrary();
      setArchiveResult(archive || {});
      loadArchives();
    } catch (error) {
      setArchiveError(error.message);
    }
  };

  const verify = async (id) => {
    setVerifyingId(id);
    setVerifyError('');
    try {
      const response = await apiFetch(`/api/library/archives/${encodeURIComponent(id)}/verify`, { method: 'POST' });
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'Verification failed');
      setArchives((previous) => (previous || []).map((archive) => (
        archive.id === id ? { ...archive, lastVerification: result.verification } : archive
      )));
    } catch (error) {
      setVerifyError(error.message);
    } finally {
      setVerifyingId(null);
    }
  };

  return (
    <div className="page health-page">
      <div className="page-heading">
        <div>
          <h1>Health</h1>
          <p className="muted">Storage checks, archive snapshots and output folders. Nothing is removed or repaired automatically.</p>
        </div>
      </div>

      <section className="panel" aria-labelledby="storage-title">
        <div className="panel-header">
          <div>
            <h2 id="storage-title">Storage</h2>
            <p className="muted small">
              {storage?.checkedAt ? `Last checked ${new Date(storage.checkedAt).toLocaleString()}` : 'Not checked yet in this session.'}
            </p>
          </div>
          <button type="button" className="btn" onClick={runCheck} disabled={checking || !ready}>
            <RefreshCw size={16} className={checking ? 'spin' : ''} aria-hidden="true" /> {checking ? 'Checking…' : 'Run check'}
          </button>
        </div>

        {checkError && <p className="inline-alert tone-problem" role="alert">Storage check unavailable. {checkError}</p>}

        {!storage ? (
          <p className="inline-alert tone-unknown">Storage check unavailable. Connect to the local service and run the check.</p>
        ) : (
          <>
            <p className={`health-headline ${issueCount ? 'tone-problem' : 'tone-ok'}`} role="status">
              {issueCount
                ? <><CircleAlert size={20} aria-hidden="true" /> {issueCount} item(s) need review</>
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
                    {count > 0 && category.sticker && (
                      <button type="button" className="link-btn" onClick={onShowNeedsAction}>Show in library</button>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="muted small">Categories are counted separately: one sticker can have several flags, and unlinked or temporary files may not belong to any sticker.</p>
            {issues
              ? <StorageIssues issues={issues} stickerIds={stickerIds} onOpenSticker={onOpenSticker} />
              : <p className="muted small">Run the check to list the individual items.</p>}
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="archives-title">
        <div className="panel-header">
          <div>
            <h2 id="archives-title">Archives</h2>
            <p className="muted small">A snapshot copies the database and media into a dated folder with a SHA-256 manifest. The active library stays unchanged.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setConfirmOpen(true)} disabled={archiving || !ready || !libraryTotal}>
            <Archive size={16} aria-hidden="true" /> {archiving ? 'Creating snapshot…' : 'Create archive snapshot'}
          </button>
        </div>
        {archiveError && <p className="inline-alert tone-problem" role="alert">Archive could not be created. {archiveError}</p>}
        {archiveResult && (
          <p className="inline-alert tone-ok" role="status">
            Snapshot created{typeof archiveResult.stickerCount === 'number' ? ` with ${archiveResult.stickerCount} stickers` : ''}.
          </p>
        )}
        {verifyError && <p className="inline-alert tone-problem" role="alert">{verifyError}</p>}
        {archivesError && <p className="inline-alert tone-unknown">Archive history is unavailable: {archivesError}</p>}
        {archives && archives.length === 0 && <p className="muted">No archives yet.</p>}
        {archives && archives.length > 0 && (
          <ul className="archive-list">
            {archives.map((archive) => (
              <ArchiveRow
                key={archive.id}
                archive={archive}
                onVerify={verify}
                verifying={verifyingId === archive.id}
                busy={Boolean(verifyingId)}
              />
            ))}
          </ul>
        )}
        <p className="muted small">Verification re-hashes every file and only reports what it finds; results are kept until the server restarts. Restoring an archive is a separate manual operation.</p>
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
