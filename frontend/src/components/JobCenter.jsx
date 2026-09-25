import { useId, useState } from 'react';
import { ListChecks, X, CircleCheck, CircleAlert, LoaderCircle, CircleMinus, Clock } from 'lucide-react';
import { Sheet } from './Sheet';
import { StickerMedia } from './StickerMedia';
import {
  ITEM_STATE_LABELS, JOB_STATE_LABELS, countActiveJobs, describeFailure, describeJobProgress
} from '../lib/jobModel';

const ITEM_ICONS = {
  queued: Clock,
  running: LoaderCircle,
  succeeded: CircleCheck,
  failed: CircleAlert,
  skipped: CircleMinus,
  cancelled: CircleMinus
};

const JOB_TONE = { running: 'accent', succeeded: 'ok', partial: 'warning', failed: 'problem', cancelled: 'neutral' };

function ProgressBar({ counts }) {
  // Segments show observed item outcomes, not an estimate of remaining time.
  const segment = (value, className) => (value > 0
    ? <span className={className} style={{ flexGrow: value }} />
    : null);
  return (
    <span className="job-progress" aria-hidden="true">
      {segment(counts.succeeded, 'seg-ok')}
      {segment(counts.failed, 'seg-problem')}
      {segment(counts.skipped + counts.cancelled, 'seg-muted')}
      {segment(counts.running + counts.queued, 'seg-pending')}
    </span>
  );
}

function JobCard({ job, stickersById, onOpenSticker, onCancel }) {
  const problemItems = job.items.filter((item) => item.state === 'failed' || item.state === 'skipped');
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? job.items : problemItems;
  const listId = useId();

  return (
    <li className="job-card">
      <div className="job-card-header">
        <div>
          <h3 className="job-title">{job.label || 'Job'}</h3>
          <p className="muted small">
            <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleTimeString()}</time>
          </p>
        </div>
        <span className={`badge badge-${JOB_TONE[job.state] || 'neutral'}`}>
          {job.state === 'running' && <LoaderCircle size={11} className="spin" aria-hidden="true" />}
          {JOB_STATE_LABELS[job.state] || job.state}
        </span>
      </div>
      <ProgressBar counts={job.counts} />
      <p className="small tabular">{describeJobProgress(job)}</p>

      <div className="job-actions">
        {job.kind === 'convert' && job.counts.queued > 0 && (
          <button type="button" className="btn btn-small" onClick={() => onCancel(job.id)}>
            Cancel {job.counts.queued} queued
          </button>
        )}
        <button
          type="button"
          className="link-btn"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show problems only' : `Show all ${job.counts.total} items`}
        </button>
      </div>

      {visibleItems.length > 0 && (
        <ul className="job-items" id={listId}>
          {visibleItems.map((item) => {
            const sticker = stickersById.get(item.stickerId);
            const Icon = ITEM_ICONS[item.state] || Clock;
            return (
              <li key={item.stickerId} className={`job-item state-${item.state}`}>
                <button
                  type="button"
                  className="job-item-button"
                  disabled={!sticker}
                  onClick={() => onOpenSticker(item.stickerId)}
                >
                  <span className="job-thumb preview-surface">
                    {sticker && <StickerMedia sticker={sticker} still />}
                  </span>
                  <span className="job-item-text">
                    <span className="mono">{item.stickerId.slice(0, 8)}</span>
                    {item.error && <span className="job-item-error">{describeFailure(item.error)}</span>}
                  </span>
                  <span className="job-item-state">
                    <Icon size={14} className={item.state === 'running' ? 'spin' : ''} aria-hidden="true" />
                    {ITEM_STATE_LABELS[item.state] || item.state}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function JobCenterButton({ jobs, onOpen }) {
  const active = countActiveJobs(jobs);
  return (
    <button type="button" className="status-pill jobs-pill" onClick={onOpen} aria-label={active ? `Jobs, ${active} running` : 'Jobs'}>
      {active
        ? <LoaderCircle size={16} className="spin" aria-hidden="true" />
        : <ListChecks size={16} aria-hidden="true" />}
      <span className="status-pill-label">Jobs</span>
      {active > 0 && <span className="pill-count tabular" aria-hidden="true">{active}</span>}
    </button>
  );
}

export function JobCenter({ open, onClose, jobs, jobHistory, stickersById, onOpenSticker, onCancel }) {
  const titleId = useId();
  return (
    <Sheet open={open} onClose={onClose} className="sheet sheet-side" labelledBy={titleId}>
      <div className="sheet-header">
        <div>
          <h2 id={titleId}>Jobs</h2>
          <p className="muted small">
            Batch conversions and tag changes. The local server keeps the last 20 jobs in memory; the list resets when it restarts
            {jobHistory?.serverStartedAt ? ` (running since ${new Date(jobHistory.serverStartedAt).toLocaleString()})` : ''}.
          </p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close jobs" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {jobs.length === 0 ? (
        <p className="muted">No jobs yet. Select stickers in the library to convert or tag several at once.</p>
      ) : (
        <ul className="job-list" aria-live="polite">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              stickersById={stickersById}
              onOpenSticker={(id) => { onClose(); onOpenSticker(id); }}
              onCancel={onCancel}
            />
          ))}
        </ul>
      )}
    </Sheet>
  );
}
