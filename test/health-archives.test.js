const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { startSandboxServer } = require('./helpers/sandboxServer');

test('storage check lists issues read-only and archives can be listed and verified', { timeout: 120_000 }, async () => {
  const server = await startSandboxServer('stickers-health-test-');
  try {
    assert.equal((await fetch(`${server.origin}/api/storage/check`, { method: 'POST', headers: { Origin: server.origin } })).status, 401);
    assert.equal((await fetch(`${server.origin}/api/library/archives`, { headers: { Origin: server.origin } })).status, 401);

    const form = new FormData();
    for (const [name, color] of [['keep.png', '#00aa00'], ['lose.png', '#aa0000']]) {
      const png = await sharp({ create: { width: 48, height: 48, channels: 4, background: color } }).png().toBuffer();
      form.append('files', new Blob([png], { type: 'image/png' }), name);
    }
    const imported = await server.request('/api/import/files', { method: 'POST', body: form });
    const [keep, lose] = imported.body.results.map((entry) => entry.sticker);

    // Simulate damage: a missing original and a stray file nobody references.
    const losePath = path.join(server.outputDir, 'captured', lose.capturedDate, lose.originalFilename);
    fs.rmSync(losePath);
    const strayPath = path.join(server.outputDir, 'statics', 'stray.webp');
    fs.mkdirSync(path.dirname(strayPath), { recursive: true });
    fs.writeFileSync(strayPath, 'stray');

    const check = await server.request('/api/storage/check', { method: 'POST' });
    assert.equal(check.status, 200);
    assert.equal(check.body.storage.missingOriginals, 1);
    assert.deepEqual(check.body.issues.missingOriginals.items.map((item) => item.stickerId), [lose.id]);
    assert.deepEqual(check.body.issues.orphanFiles.items, [{ name: 'statics/stray.webp' }]);
    assert.ok(!JSON.stringify(check.body.issues).includes(server.outputDir), 'no absolute paths leak');
    assert.ok(fs.existsSync(strayPath), 'the check never deletes files');

    assert.deepEqual((await server.request('/api/library/archives')).body.archives, []);
    const created = await server.request('/api/library/archive', { method: 'POST' });
    assert.equal(created.status, 200);
    const archiveId = created.body.archive.id;

    const listed = await server.request('/api/library/archives');
    assert.equal(listed.body.archives.length, 1);
    assert.equal(listed.body.archives[0].id, archiveId);
    assert.equal(listed.body.archives[0].stickerCount, 2);
    assert.equal(listed.body.archives[0].lastVerification, null);

    const verified = await server.request(`/api/library/archives/${archiveId}/verify`, { method: 'POST' });
    assert.equal(verified.body.verification.status, 'verified');
    assert.ok(verified.body.verification.checked > 0);

    // Tamper with one archived file and add an unexpected one.
    const archiveDir = path.join(server.outputDir, 'archives', archiveId);
    const keepArchived = path.join(archiveDir, 'captured', keep.capturedDate, keep.originalFilename);
    fs.writeFileSync(keepArchived, 'tampered');
    fs.writeFileSync(path.join(archiveDir, 'note.txt'), 'extra');
    const mismatch = await server.request(`/api/library/archives/${archiveId}/verify`, { method: 'POST' });
    assert.equal(mismatch.body.verification.status, 'mismatch');
    assert.deepEqual(mismatch.body.verification.changed, [`captured/${keep.capturedDate}/${keep.originalFilename}`]);
    assert.deepEqual(mismatch.body.verification.extra, ['note.txt']);
    assert.equal(fs.readFileSync(keepArchived, 'utf8'), 'tampered', 'verification never repairs or restores');

    const relisted = await server.request('/api/library/archives');
    assert.equal(relisted.body.archives[0].lastVerification.status, 'mismatch');

    assert.equal((await server.request('/api/library/archives/..%2F..%2Fetc/verify', { method: 'POST' })).status, 404);
    assert.equal((await server.request('/api/library/archives/2026-01-01T00-00-00-000Z/verify', { method: 'POST' })).status, 404);
  } finally {
    await server.stop();
  }
});
