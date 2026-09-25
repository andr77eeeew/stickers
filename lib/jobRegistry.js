const crypto = require('crypto');

const ITEM_STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']);
const PENDING_STATES = new Set(['queued', 'running']);

function emptyCounts(total) {
  return { total, queued: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0 };
}

/**
 * Overall state is derived only from item states the server observed.
 * running   — some items are still queued or running
 * succeeded — every item succeeded
 * cancelled — the user cancelled queued items and nothing failed
 * failed    — nothing succeeded
 * partial   — some items succeeded, others failed or were skipped
 */
function deriveJobState(counts) {
  if (counts.queued || counts.running) return 'running';
  if (counts.succeeded === counts.total) return 'succeeded';
  if (counts.cancelled && !counts.failed) return 'cancelled';
  if (counts.succeeded === 0) return 'failed';
  return 'partial';
}

/**
 * In-memory registry of batch jobs. History is bounded and lives only as long
 * as the server process; clients are told so instead of assuming persistence.
 */
class JobRegistry {
  constructor({ maxJobs = 20, now = () => new Date().toISOString(), onChange = () => {} } = {}) {
    this.maxJobs = maxJobs;
    this.now = now;
    this.onChange = onChange;
    this.jobs = new Map();
  }

  /**
   * @param {string} kind
   * @param {Array<{stickerId: string, state?: string, error?: string}>} items
   * @param {{label?: string}} options
   */
  create(kind, items, { label = '' } = {}) {
    const createdAt = this.now();
    const job = {
      id: crypto.randomUUID(),
      kind,
      label,
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      state: 'running',
      counts: emptyCounts(items.length),
      items: items.map((item) => ({
        stickerId: item.stickerId,
        state: ITEM_STATES.has(item.state) ? item.state : 'queued',
        error: item.error || null
      }))
    };
    this.recount(job);
    this.jobs.set(job.id, job);
    this.evict();
    this.onChange(this.snapshot(job));
    return this.snapshot(job);
  }

  recount(job) {
    const counts = emptyCounts(job.items.length);
    for (const item of job.items) counts[item.state] += 1;
    job.counts = counts;
    const previous = job.state;
    job.state = deriveJobState(counts);
    if (job.state !== 'running' && previous === 'running') job.finishedAt = this.now();
  }

  setItem(jobId, stickerId, patch) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const item = job.items.find((entry) => entry.stickerId === stickerId);
    if (!item) return null;
    if (patch.state && !ITEM_STATES.has(patch.state)) throw new TypeError(`Unknown item state: ${patch.state}`);
    // A finished item never changes again, so late callbacks cannot rewrite history.
    if (!PENDING_STATES.has(item.state)) return this.snapshot(job);
    if (patch.state) item.state = patch.state;
    if (patch.error !== undefined) item.error = patch.error || null;
    job.updatedAt = this.now();
    this.recount(job);
    this.onChange(this.snapshot(job));
    return this.snapshot(job);
  }

  /** Cancels items that have not started. Running items finish normally. */
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    let changed = false;
    for (const item of job.items) {
      if (item.state === 'queued') {
        item.state = 'cancelled';
        changed = true;
      }
    }
    if (changed) {
      job.updatedAt = this.now();
      this.recount(job);
      this.onChange(this.snapshot(job));
    }
    return this.snapshot(job);
  }

  itemState(jobId, stickerId) {
    return this.jobs.get(jobId)?.items.find((item) => item.stickerId === stickerId)?.state || null;
  }

  /** Sticker IDs that are queued or running in any unfinished job. */
  pendingStickerIds() {
    const ids = new Set();
    for (const job of this.jobs.values()) {
      for (const item of job.items) {
        if (PENDING_STATES.has(item.state)) ids.add(item.stickerId);
      }
    }
    return ids;
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job) : null;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => this.snapshot(job));
  }

  evict() {
    if (this.jobs.size <= this.maxJobs) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.state !== 'running')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size > this.maxJobs && finished.length) {
      this.jobs.delete(finished.shift().id);
    }
  }

  snapshot(job) {
    return {
      ...job,
      counts: { ...job.counts },
      items: job.items.map((item) => ({ ...item }))
    };
  }
}

module.exports = { JobRegistry, deriveJobState };
