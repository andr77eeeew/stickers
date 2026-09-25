import { useId, useState } from 'react';
import { Upload, X, CircleCheck, CircleAlert, Copy as DuplicateIcon, LoaderCircle } from 'lucide-react';
import { Sheet } from './Sheet';
import { IMPORT_ACCEPT, IMPORT_MAX_FILES } from '../hooks/useManualImport';
import { getShortId } from '../lib/stickerModel';
import { ITEM_STATE_LABELS, describeFailure, describeJobProgress } from '../lib/jobModel';

function ResultRow({ entry, jobItem }) {
  const status = !entry.success ? 'failed' : entry.duplicate ? 'duplicate' : 'accepted';
  const Icon = status === 'failed' ? CircleAlert : status === 'duplicate' ? DuplicateIcon : CircleCheck;
  const label = status === 'failed' ? 'Failed' : status === 'duplicate' ? 'Duplicate' : 'Accepted';
  return (
    <li className={`import-row import-${status}`}>
      <span className="import-name break">{entry.name}</span>
      <span className="import-status">
        <Icon size={14} aria-hidden="true" /> {label}
      </span>
      {status === 'duplicate' && entry.sticker && (
        <span className="import-note">Already in library as <span className="mono">{getShortId(entry.sticker)}</span></span>
      )}
      {status === 'failed' && <span className="import-note">{describeFailure(entry.error) || 'The file could not be imported.'}</span>}
      {jobItem && (
        <span className={`import-note conversion-${jobItem.state}`}>
          Conversion: {ITEM_STATE_LABELS[jobItem.state] || jobItem.state}
          {jobItem.error ? ` — ${describeFailure(jobItem.error)}` : ''}
        </span>
      )}
    </li>
  );
}

export function ImportPanel({
  open, onClose, manualImporting, manualAutoConvert, setManualAutoConvert,
  importReport, fileInputRef, handleManualFiles, bootstrapState, onShowInLibrary, jobs, onOpenJobs
}) {
  const titleId = useId();
  const [dragOver, setDragOver] = useState(false);
  const report = importReport;
  const job = report?.jobId ? jobs.find((item) => item.id === report.jobId) : null;
  const jobItems = new Map((job?.items || []).map((item) => [item.stickerId, item]));

  return (
    <Sheet open={open} onClose={onClose} className="sheet sheet-side" labelledBy={titleId}>
      <div className="sheet-header">
        <div>
          <h2 id={titleId}>Import local files</h2>
          <p className="muted small">Images and short videos stay on this computer. Nothing contacts TikTok.</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close import" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div
        className={`dropzone ${dragOver ? 'is-over' : ''}`}
        aria-busy={manualImporting}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragOver(false);
          handleManualFiles(event.dataTransfer.files);
        }}
      >
        {manualImporting
          ? <LoaderCircle size={28} className="spin" aria-hidden="true" />
          : <Upload size={28} aria-hidden="true" />}
        <p className="dropzone-title">{manualImporting ? 'Importing…' : 'Drop images or videos here'}</p>
        <p className="muted small">PNG, JPG, WebP, GIF, TIFF, AVIF, MP4, WebM, MOV, MKV, M4V · up to {IMPORT_MAX_FILES} files at once</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={IMPORT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => handleManualFiles(event.target.files)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={manualImporting || bootstrapState !== 'ready'}
          onClick={() => fileInputRef.current?.click()}
        >
          Choose files
        </button>
      </div>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={manualAutoConvert}
          onChange={(event) => setManualAutoConvert(event.target.checked)}
        />
        Convert to Telegram format after import
      </label>

      <div className="import-report" aria-live="polite">
        {report?.error && <p className="inline-alert tone-problem" role="alert">{report.error}</p>}
        {report && !report.error && (
          <>
            <div className="import-summary tabular">
              <span><strong>{report.imported}</strong> imported</span>
              <span><strong>{report.duplicates}</strong> duplicates</span>
              <span className={report.failed ? 'tone-problem' : ''}><strong>{report.failed}</strong> failed</span>
            </div>
            {job && (
              <p className="small tabular" role="status">
                Converting for Telegram: {describeJobProgress(job)}{' '}
                <button type="button" className="link-btn" onClick={onOpenJobs}>Open Jobs</button>
              </p>
            )}
            <ul className="import-list">
              {report.results.map((entry, index) => (
                <ResultRow
                  key={`${entry.name}-${index}`}
                  entry={entry}
                  jobItem={entry.sticker && !entry.duplicate ? jobItems.get(entry.sticker.id) : null}
                />
              ))}
            </ul>
            {report.imported > 0 && (
              <button type="button" className="btn" onClick={onShowInLibrary}>Show in library</button>
            )}
          </>
        )}
        {report?.skipped?.length > 0 && (
          <p className="muted small">Skipped unsupported: {report.skipped.join(', ')}</p>
        )}
      </div>
    </Sheet>
  );
}
