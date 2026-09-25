const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const sharp = require('sharp');
const WebSocket = require('ws');
const { JobRegistry, deriveJobState } = require('../lib/jobRegistry');

const projectRoot = path.resolve(__dirname, '..');

test('job state is derived only from observed item states', () => {
  const counts = (patch) => ({ total: 3, queued: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, ...patch });
  assert.equal(deriveJobState(counts({ queued: 1, succeeded: 2 })), 'running');
  assert.equal(deriveJobState(counts({ succeeded: 3 })), 'succeeded');
  assert.equal(deriveJobState(counts({ succeeded: 2, failed: 1 })), 'partial');
  assert.equal(deriveJobState(counts({ failed: 2, skipped: 1 })), 'failed');
  assert.equal(deriveJobState(counts({ cancelled: 2, skipped: 1 })), 'cancelled');
  assert.equal(deriveJobState(counts({ cancelled: 2, succeeded: 1 })), 'cancelled', 'a cancelled job is not reported as a problem');
  assert.equal(deriveJobState(counts({ cancelled: 1, succeeded: 1, failed: 1 })), 'partial');
});

test('registry reports every change, freezes finished items and cancels only queued work', () => {
  const events = [];
  let tick = 0;
  const registry = new JobRegistry({
    now: () => new Date(Date.UTC(2026, 8, 25, 0, 0, tick++)).toISOString(),
    onChange: (job) => events.push(job)
  });
  const job = registry.create('convert', [
    { stickerId: 'a' }, { stickerId: 'b' }, { stickerId: 'c' }, { stickerId: 'd', state: 'skipped', error: 'Sticker not found.' }
  ], { label: 'Convert 4 stickers' });

  assert.equal(job.state, 'running');
  assert.deepEqual(registry.pendingStickerIds(), new Set(['a', 'b', 'c']));

  registry.setItem(job.id, 'a', { state: 'running' });
  registry.setItem(job.id, 'a', { state: 'succeeded' });
  registry.setItem(job.id, 'a', { state: 'failed', error: 'late callback' });
  assert.equal(registry.itemState(job.id, 'a'), 'succeeded', 'finished items never change');

  registry.setItem(job.id, 'b', { state: 'running' });
  const cancelled = registry.cancel(job.id);
  assert.equal(cancelled.counts.cancelled, 1, 'only the queued item is cancelled');
  assert.equal(registry.itemState(job.id, 'b'), 'running');

  const finished = registry.setItem(job.id, 'b', { state: 'failed', error: 'boom' });
  assert.equal(finished.state, 'partial');
  assert.ok(finished.finishedAt);
  assert.deepEqual(finished.counts, { total: 4, queued: 0, running: 0, succeeded: 1, failed: 1, skipped: 1, cancelled: 1 });
  assert.equal(events.at(-1).state, 'partial');
  assert.equal(registry.pendingStickerIds().size, 0);
});

test('registry keeps a bounded history and never evicts running jobs', () => {
  let tick = 0;
  const registry = new JobRegistry({ maxJobs: 2, now: () => String(tick++).padStart(6, '0') });
  const running = registry.create('convert', [{ stickerId: 'r' }]);
  const done1 = registry.create('tags', [{ stickerId: 'x', state: 'succeeded' }]);
  registry.create('tags', [{ stickerId: 'y', state: 'succeeded' }]);
  const ids = registry.list().map((job) => job.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes(running.id));
  assert.ok(!ids.includes(done1.id));
});

async function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10_000);
    const onData = (data) => {
      output += data.toString();
      if (output.includes('STICKER SERVER:')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited during startup with code ${code}: ${output}`));
    });
  });
}

test('batch jobs convert and tag stickers with a per-ID report', { timeout: 180_000 }, async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-jobs-test-'));
  const outputDir = path.join(sandbox, 'output');
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let socket;

  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(port),
        INGEST_TOKEN: '',
        STICKER_OUTPUT_DIR: outputDir,
        STICKER_TEMP_DIR: path.join(sandbox, 'temp')
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForReady(child);

    const session = await fetch(`${origin}/api/session`, { headers: { Origin: origin } });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const headers = { Origin: origin, Cookie: cookie };
    const postJson = async (route, body) => {
      const response = await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };

    assert.equal((await fetch(`${origin}/api/jobs`, { headers: { Origin: origin } })).status, 401, 'jobs require the dashboard session');

    const form = new FormData();
    for (const [name, color] of [['red.png', '#ff0000'], ['blue.png', '#0000ff']]) {
      const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
      form.append('files', new Blob([png], { type: 'image/png' }), name);
    }
    const imported = await fetch(`${origin}/api/import/files`, { method: 'POST', headers, body: form }).then((r) => r.json());
    const [redId, blueId] = imported.results.map((entry) => entry.sticker.id);
    const missingId = 'f'.repeat(64);

    // Remove one original so the job must explain why it was skipped.
    fs.rmSync(path.join(outputDir, 'captured', imported.results[1].sticker.capturedDate, imported.results[1].sticker.originalFilename));

    const updates = [];
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers: { Cookie: cookie } });
    const init = await new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      socket.once('error', reject);
    });
    assert.deepEqual(init.data.jobs, []);
    assert.equal(init.data.historyScope, 'server-process');
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'job_update') updates.push(message.data);
    });

    assert.equal((await postJson('/api/jobs/convert', { ids: [] })).status, 400);
    assert.equal((await postJson('/api/jobs/convert', { ids: ['../etc'] })).status, 400);

    const started = await postJson('/api/jobs/convert', { ids: [redId, blueId, missingId, redId] });
    assert.equal(started.status, 202);
    const jobId = started.body.job.id;
    assert.equal(started.body.job.counts.total, 3, 'duplicate IDs are collapsed');
    const byId = Object.fromEntries(started.body.job.items.map((item) => [item.stickerId, item]));
    assert.equal(byId[blueId].state, 'skipped');
    assert.match(byId[blueId].error, /Original file is missing/);
    assert.equal(byId[missingId].state, 'skipped');

    const duplicate = await postJson('/api/jobs/convert', { ids: [redId] });
    const duplicateItem = duplicate.body.job.items[0];
    assert.ok(
      duplicateItem.state === 'skipped' ? /Already queued/.test(duplicateItem.error) : true,
      'a sticker already pending in another job is not converted twice'
    );

    let finished;
    for (let attempt = 0; attempt < 120 && !finished; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const { jobs } = await fetch(`${origin}/api/jobs`, { headers }).then((r) => r.json());
      finished = jobs.find((job) => job.id === jobId && job.state !== 'running');
    }
    assert.ok(finished, 'convert job finished');
    assert.equal(finished.state, 'partial');
    assert.equal(finished.counts.succeeded, 1);
    assert.equal(finished.counts.skipped, 2);
    assert.ok(updates.some((job) => job.id === jobId && job.state === 'partial'), 'job_update reached the WebSocket');

    const stickers = await fetch(`${origin}/api/stickers`, { headers }).then((r) => r.json());
    assert.equal(stickers.find((sticker) => sticker.id === redId).status, 'converted');

    assert.equal((await postJson('/api/jobs/tags', { ids: [redId], add: ['import:evil'] })).status, 400, 'system tags are protected');
    const tagged = await postJson('/api/jobs/tags', { ids: [redId, blueId, missingId], add: ['Batch', 'qa'], remove: ['nope'] });
    assert.equal(tagged.status, 200);
    assert.equal(tagged.body.job.state, 'partial');
    assert.equal(tagged.body.job.counts.succeeded, 2);
    const afterTags = await fetch(`${origin}/api/stickers`, { headers }).then((r) => r.json());
    assert.deepEqual(afterTags.find((sticker) => sticker.id === redId).tags, ['import:red.png', 'batch', 'qa']);

    const removed = await postJson('/api/jobs/tags', { ids: [redId], remove: ['qa'] });
    assert.equal(removed.body.job.state, 'succeeded');
    const afterRemove = await fetch(`${origin}/api/stickers`, { headers }).then((r) => r.json());
    assert.deepEqual(afterRemove.find((sticker) => sticker.id === redId).tags, ['import:red.png', 'batch']);

    assert.equal((await postJson('/api/jobs/unknown/cancel', {})).status, 404);
  } finally {
    socket?.terminate();
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
