const { test } = require('node:test');
const assert = require('node:assert/strict');

const modelPromise = import('../frontend/src/lib/jobModel.js');

const job = (overrides = {}) => ({
  id: 'j1',
  kind: 'convert',
  label: 'Convert 3 stickers',
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-25T10:00:01.000Z',
  state: 'running',
  counts: { total: 3, queued: 1, running: 1, succeeded: 1, failed: 0, skipped: 0, cancelled: 0 },
  items: [
    { stickerId: 'a', state: 'succeeded', error: null },
    { stickerId: 'b', state: 'running', error: null },
    { stickerId: 'c', state: 'queued', error: null }
  ],
  ...overrides
});

test('upsertJob keeps newest first and ignores stale updates', async () => {
  const { upsertJob } = await modelPromise;
  const older = job({ id: 'old', createdAt: '2026-09-25T09:00:00.000Z' });
  let jobs = upsertJob([older], job());
  assert.deepEqual(jobs.map((item) => item.id), ['j1', 'old']);
  jobs = upsertJob(jobs, job({ updatedAt: '2026-09-25T10:00:05.000Z', state: 'succeeded' }));
  assert.equal(jobs[0].state, 'succeeded');
  jobs = upsertJob(jobs, job({ updatedAt: '2026-09-25T10:00:02.000Z', state: 'running' }));
  assert.equal(jobs[0].state, 'succeeded', 'a late, older snapshot does not win');
});

test('queued stickers and progress text come only from observed counts', async () => {
  const { getQueuedStickerIds, countActiveJobs, describeJobProgress } = await modelPromise;
  assert.deepEqual(getQueuedStickerIds([job()]), new Set(['c']));
  assert.equal(countActiveJobs([job(), job({ id: 'x', state: 'partial' })]), 1);
  assert.equal(describeJobProgress(job()), '1 of 3 finished · 1 working · 1 queued');
  assert.equal(
    describeJobProgress(job({ state: 'partial', counts: { total: 3, queued: 0, running: 0, succeeded: 2, failed: 1, skipped: 0, cancelled: 0 } })),
    '2 of 3 done · 1 failed'
  );
});

test('failure reasons are translated into plain language without paths', async () => {
  const { describeFailure } = await modelPromise;
  assert.match(describeFailure('Animated sticker is 300000 bytes; limit is 250880 bytes.'), /Telegram size limit/);
  assert.match(describeFailure('FFmpeg exited 1: C:\\Users\\me\\clip.mp4 invalid'), /could not be decoded/);
  assert.equal(describeFailure('Already queued in another job.'), 'Already queued in another job.');
  assert.doesNotMatch(describeFailure('Unexpected failure at D:\\Projects\\stickers\\output\\x.webp'), /Projects/);
});

test('finished job toasts separate full success from partial results', async () => {
  const { describeFinishedJob } = await modelPromise;
  const done = describeFinishedJob(job({ state: 'succeeded', counts: { total: 3, queued: 0, running: 0, succeeded: 3, failed: 0, skipped: 0, cancelled: 0 } }));
  assert.deepEqual(done, { tone: 'ok', message: '3 stickers converted.' });
  const partial = describeFinishedJob(job({ state: 'partial', counts: { total: 3, queued: 0, running: 0, succeeded: 1, failed: 1, skipped: 1, cancelled: 0 } }));
  assert.equal(partial.tone, 'error');
  assert.match(partial.message, /1 converted, 2 need attention/);
});
