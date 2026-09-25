const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { startSandboxServer } = require('./helpers/sandboxServer');

test('library, tags and outputs survive a restart; jobs and interrupted work are reported honestly', { timeout: 180_000 }, async () => {
  const server = await startSandboxServer('stickers-restart-test-');
  try {
    const form = new FormData();
    for (const [name, color] of [['one.png', '#3366ff'], ['two.png', '#ff6633']]) {
      const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
      form.append('files', new Blob([png], { type: 'image/png' }), name);
    }
    const imported = await server.request('/api/import/files', { method: 'POST', body: form });
    const [one, two] = imported.body.results.map((entry) => entry.sticker);

    const job = await server.request('/api/jobs/convert', { method: 'POST', body: { ids: [one.id] } });
    assert.equal(job.status, 202);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const { body } = await server.request('/api/jobs');
      if (body.jobs[0].state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await server.request('/api/jobs/tags', { method: 'POST', body: { ids: [one.id, two.id], add: ['keep'] } });
    const before = (await server.request('/api/stickers')).body;

    // Simulate a crash in the middle of converting "two".
    await server.restart();
    const databasePath = path.join(server.outputDir, 'stickers_db.json');
    const document = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
    document.stickers.find((sticker) => sticker.id === two.id).status = 'converting';
    fs.writeFileSync(databasePath, JSON.stringify(document));
    await server.restart();

    const after = (await server.request('/api/stickers')).body;
    assert.deepEqual(after.map((sticker) => sticker.id).sort(), before.map((sticker) => sticker.id).sort(), 'no record lost');
    const oneAfter = after.find((sticker) => sticker.id === one.id);
    assert.equal(oneAfter.status, 'converted');
    assert.ok(oneAfter.outputSizeBytes > 0, 'converted output is still on disk');
    assert.deepEqual(oneAfter.tags, ['import:one.png', 'keep']);

    const twoAfter = after.find((sticker) => sticker.id === two.id);
    assert.equal(twoAfter.status, 'failed');
    assert.match(twoAfter.error, /interrupted/i);
    assert.ok(twoAfter.health.includes('interrupted_conversion'));

    const status = (await server.request('/api/status')).body;
    assert.equal(status.storage.staleConversions, 1);

    const jobs = (await server.request('/api/jobs')).body;
    assert.deepEqual(jobs.jobs, [], 'job history is in memory only');
    assert.equal(jobs.historyScope, 'server-process');

    // A later routine check keeps the interrupted flag until the sticker is converted again.
    const check = await server.request('/api/storage/check', { method: 'POST' });
    assert.equal(check.body.storage.staleConversions, 1);
    const retried = await server.request('/api/convert', { method: 'POST', body: { id: two.id } });
    assert.equal(retried.status, 200);
    const recheck = await server.request('/api/storage/check', { method: 'POST' });
    assert.equal(recheck.body.storage.staleConversions, 0);
  } finally {
    await server.stop();
  }
});
