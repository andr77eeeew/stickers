const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createLibraryArchiveSnapshot } = require('../lib/libraryArchive');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-archive-'));
  const outputDir = path.join(root, 'output');
  const archivesDir = path.join(outputDir, 'archives');
  const primary = path.join(outputDir, 'stickers_db.json');
  const backup = path.join(outputDir, 'stickers_db.backup.json');
  const media = path.join(outputDir, 'captured', '2026-08-19', 'asset.webp');
  const converted = path.join(outputDir, 'animated', '2026-08-19', 'asset.webm');
  fs.mkdirSync(path.dirname(media), { recursive: true });
  fs.mkdirSync(path.dirname(converted), { recursive: true });
  fs.writeFileSync(primary, '{"schemaVersion":2,"stickers":[]}\n');
  fs.writeFileSync(backup, '{"schemaVersion":2,"stickers":[{"backup":true}]}\n');
  fs.writeFileSync(media, Buffer.from('webp fixture'));
  fs.writeFileSync(converted, Buffer.from('webm fixture'));
  return { root, outputDir, archivesDir, primary, backup, media, converted };
}

test('archive is committed atomically with a byte-verifiable manifest', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const activeBefore = new Map(
    [fixture.primary, fixture.backup, fixture.media, fixture.converted].map((file) => [file, hash(file)])
  );

  const result = createLibraryArchiveSnapshot({
    outputDir: fixture.outputDir,
    archivesDir: fixture.archivesDir,
    databaseFiles: [fixture.primary, fixture.backup],
    stickerCount: 17,
    createdAt: '2026-08-19T12:34:56.789Z'
  });

  assert.equal(result.id, '2026-08-19T12-34-56-789Z');
  assert.equal(fs.existsSync(result.path), true);
  assert.deepEqual(
    fs.readdirSync(fixture.archivesDir).filter((entry) => entry.endsWith('.tmp')),
    []
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(result.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.snapshotOnly, true);
  assert.equal(manifest.stickerCount, 17);
  assert.equal(manifest.mediaFileCount, 2);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    [
      'animated/2026-08-19/asset.webm',
      'captured/2026-08-19/asset.webp',
      'stickers_db.backup.json',
      'stickers_db.json'
    ]
  );
  for (const entry of manifest.files) {
    assert.equal(entry.path.includes('\\'), false);
    const archivedFile = path.join(result.path, ...entry.path.split('/'));
    assert.equal(entry.size, fs.statSync(archivedFile).size);
    assert.equal(entry.sha256, hash(archivedFile));
  }
  for (const [file, expectedHash] of activeBefore) {
    assert.equal(hash(file), expectedHash, `active file changed: ${file}`);
  }
});

test('failed commit removes only its own temporary archive', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(fixture.archivesDir, { recursive: true });
  const existingArchive = path.join(fixture.archivesDir, 'existing-archive');
  const unrelatedTemp = path.join(fixture.archivesDir, '.unrelated.tmp');
  fs.mkdirSync(existingArchive);
  fs.mkdirSync(unrelatedTemp);
  fs.writeFileSync(path.join(existingArchive, 'keep.txt'), 'keep archive');
  fs.writeFileSync(path.join(unrelatedTemp, 'keep.txt'), 'keep temp');
  const activeBefore = new Map(
    [fixture.primary, fixture.backup, fixture.media, fixture.converted].map((file) => [file, hash(file)])
  );

  const failingFs = Object.create(fs);
  failingFs.renameSync = () => {
    const error = new Error('simulated atomic commit failure');
    error.code = 'EACCES';
    throw error;
  };

  assert.throws(
    () => createLibraryArchiveSnapshot({
      outputDir: fixture.outputDir,
      archivesDir: fixture.archivesDir,
      databaseFiles: [fixture.primary, fixture.backup],
      stickerCount: 17,
      createdAt: '2026-08-19T12:34:56.789Z',
      fileSystem: failingFs
    }),
    /simulated atomic commit failure/
  );

  assert.equal(fs.readFileSync(path.join(existingArchive, 'keep.txt'), 'utf8'), 'keep archive');
  assert.equal(fs.readFileSync(path.join(unrelatedTemp, 'keep.txt'), 'utf8'), 'keep temp');
  assert.equal(fs.existsSync(path.join(fixture.archivesDir, '2026-08-19T12-34-56-789Z')), false);
  assert.deepEqual(
    fs.readdirSync(fixture.archivesDir).sort(),
    ['.unrelated.tmp', 'existing-archive']
  );
  for (const [file, expectedHash] of activeBefore) {
    assert.equal(hash(file), expectedHash, `active file changed after failure: ${file}`);
  }
});