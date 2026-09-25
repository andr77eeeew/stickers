import { toSafeErrorMessage } from './stickerModel.js';

export const PENDING_ITEM_STATES = new Set(['queued', 'running']);

export const JOB_STATE_LABELS = {
  running: 'In progress',
  succeeded: 'Done',
  partial: 'Finished with problems',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

export const ITEM_STATE_LABELS = {
  queued: 'Queued',
  running: 'Working…',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled'
};

/** Inserts or replaces a job, keeping newest first. Stale updates never win. */
export const upsertJob = (jobs, job) => {
  if (!job?.id) return jobs;
  const existing = jobs.find((item) => item.id === job.id);
  if (existing && existing.updatedAt > job.updatedAt) return jobs;
  return [job, ...jobs.filter((item) => item.id !== job.id)]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
};

/** Sticker IDs waiting in a queue (not yet running) across all jobs. */
export const getQueuedStickerIds = (jobs) => {
  const ids = new Set();
  for (const job of jobs) {
    for (const item of job.items || []) {
      if (item.state === 'queued') ids.add(item.stickerId);
    }
  }
  return ids;
};

export const countActiveJobs = (jobs) => jobs.filter((job) => job.state === 'running').length;

/** Observed progress only: finished items out of total, never a time estimate. */
export const describeJobProgress = (job) => {
  const { counts } = job;
  const done = counts.total - counts.queued - counts.running;
  const parts = [`${done} of ${counts.total} finished`];
  if (counts.succeeded && job.state !== 'running') parts[0] = `${counts.succeeded} of ${counts.total} done`;
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  if (counts.running) parts.push(`${counts.running} working`);
  if (counts.queued) parts.push(`${counts.queued} queued`);
  return parts.join(' · ');
};

const FAILURE_PATTERNS = [
  [/cannot fit within|exceeds \d+ bytes|limit is \d+ bytes/i, 'Could not compress it under the Telegram size limit. Try a shorter window or Edit to simplify it.'],
  [/duration must be (no more than|between)/i, 'The selected animation is longer than 3 seconds.'],
  [/FFmpeg timed out/i, 'Decoding took too long. Try exporting the file again as MP4 or WebM.'],
  [/FFmpeg exited/i, 'The video could not be decoded. Try exporting it again as MP4 or WebM.'],
  [/empty/i, 'The file is empty.'],
  [/unsupported image format|corrupt|premature end|invalid (png|jpeg|webp|gif)/i, 'The file is damaged or is not a supported image.'],
  [/pixel limit/i, 'The image is too large. Resize it and try again.'],
  [/Unsupported file type/i, 'This file type is not supported.'],
  [/Original (sticker )?file (is missing|not found)/i, 'The original file is missing on disk.'],
  [/no usable frame timing/i, 'The animation has no frame timing and cannot be converted.']
];

/** Plain-language reason for an import or conversion failure; never exposes paths. */
export const describeFailure = (message) => {
  if (!message) return '';
  for (const [pattern, text] of FAILURE_PATTERNS) {
    if (pattern.test(message)) return text;
  }
  return toSafeErrorMessage(message);
};

/** Short toast text for a job that just finished. */
export const describeFinishedJob = (job) => {
  const { counts } = job;
  const noun = job.kind === 'tags' ? 'tagged' : 'converted';
  if (job.state === 'succeeded') return { tone: 'ok', message: `${counts.succeeded} sticker${counts.succeeded === 1 ? '' : 's'} ${noun}.` };
  if (job.state === 'cancelled') return { tone: 'ok', message: `${job.label}: cancelled after ${counts.succeeded} ${noun}.` };
  const problems = counts.failed + counts.skipped;
  return {
    tone: 'error',
    message: `${job.label}: ${counts.succeeded} ${noun}, ${problems} need${problems === 1 ? 's' : ''} attention. See Jobs.`
  };
};
