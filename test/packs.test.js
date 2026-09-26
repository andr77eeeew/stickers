const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { PackStore, PackError, parseEmojiList, PACK_LIMITS } = require('../lib/packStore');
const { createStoredZip } = require('../lib/zipWriter');
const { buildPackExport, findExportProblems } = require('../lib/packExport');
const { startSandboxServer } = require('./helpers/sandboxServer');
const { readZip } = require('./helpers/zipReader');

const idOf = (char) => char.repeat(64);

test('emoji lists are validated, deduplicated and limited', () => {
  assert.deepEqual(parseEmojiList('😀 🎉,😀'), ['😀', '🎉']);
  assert.deepEqual(parseEmojiList(['👍🏽', '🇺🇦', '❤️', '1️⃣']), ['👍🏽', '🇺🇦', '❤️', '1️⃣']);
  assert.deepEqual(parseEmojiList('👨‍👩‍👧'), ['👨‍👩‍👧'], 'ZWJ sequence is one emoji');
  assert.deepEqual(parseEmojiList(''), []);
  assert.throws(() => parseEmojiList('cat'), PackError);
  assert.throws(() => parseEmojiList('😀a'), /not an emoji/);
  const many = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '😚', '🙂', '🤗', '🤩'];
  assert.equal(many.length, PACK_LIMITS.maxEmoji + 1);
  assert.throws(() => parseEmojiList(many.join('')), /at most 20/);
});

test('pack store writes atomically, guards revisions and keeps formats apart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-packs-unit-'));
  try {
    let snapshots = 0;
    const store = new PackStore(path.join(dir, 'packs.json'), { beforeFirstWrite: () => { snapshots += 1; } });
    store.load();
    assert.deepEqual(store.snapshot().packs, []);

    const stickers = new Map([
      [idOf('a'), { isAnimated: false }],
      [idOf('b'), { isAnimated: false }],
      [idOf('c'), { isAnimated: true }]
    ]);
    const resolveSticker = (id) => stickers.get(id) || null;

    const pack = store.create('  My   pack ');
    assert.equal(pack.title, 'My pack');
    assert.equal(store.snapshot().activePackId, pack.id);
    assert.equal(snapshots, 1, 'snapshot before the first write only');
    store.create('Second');
    assert.equal(snapshots, 1);

    const updated = store.update(pack.id, {
      revision: 1,
      items: [{ stickerId: idOf('b'), emoji: '😀' }, { stickerId: idOf('a'), emoji: [] }]
    }, { resolveSticker });
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.items.map((item) => item.emoji), [['😀'], []]);

    assert.throws(
      () => store.update(pack.id, { revision: 1, title: 'Stale' }, { resolveSticker }),
      (error) => error.status === 409 && error.pack.revision === 2
    );
    assert.throws(
      () => store.update(pack.id, { revision: 2, items: [...updated.items, { stickerId: idOf('c') }] }, { resolveSticker }),
      /separate packs/
    );
    assert.throws(
      () => store.update(pack.id, { revision: 2, items: [{ stickerId: idOf('d') }] }, { resolveSticker }),
      (error) => error.status === 404
    );
    assert.throws(
      () => store.update(pack.id, { revision: 2, items: [{ stickerId: idOf('a') }, { stickerId: idOf('a') }] }, { resolveSticker }),
      /only once/
    );

    // A record that disappeared from the library stays in the pack until removed by hand.
    stickers.delete(idOf('a'));
    const kept = store.update(pack.id, { revision: 2, items: updated.items }, { resolveSticker });
    assert.equal(kept.items.length, 2);

    // Reload from disk: same content; the previous version is kept as backup.
    const reloaded = new PackStore(path.join(dir, 'packs.json'));
    reloaded.load();
    assert.deepEqual(reloaded.snapshot().packs, store.snapshot().packs);
    assert.ok(fs.existsSync(path.join(dir, 'packs.backup.json')));
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);

    reloaded.remove(pack.id);
    assert.equal(reloaded.snapshot().packs.length, 1);
    assert.notEqual(reloaded.snapshot().activePackId, pack.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable packs file is recovered from backup or left untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-packs-corrupt-'));
  try {
    const file = path.join(dir, 'packs.json');
    const store = new PackStore(file);
    store.load();
    store.create('Kept');
    store.create('Latest');
    fs.writeFileSync(file, '{ broken');

    const recovered = new PackStore(file);
    recovered.load();
    assert.equal(recovered.recoveredFromBackup, true);
    assert.deepEqual(recovered.snapshot().packs.map((pack) => pack.title), ['Kept']);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('packs.corrupt-')), 'broken file copied aside');

    fs.writeFileSync(path.join(dir, 'packs.backup.json'), 'also broken');
    const blocked = new PackStore(file);
    blocked.load();
    assert.ok(blocked.loadError);
    assert.throws(() => blocked.create('New'), (error) => error.status === 503);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', 'unreadable file is not overwritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stored ZIP entries round-trip with UTF-8 names', () => {
  const zip = createStoredZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'пак.txt', data: Buffer.from('😀') }
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'пак.txt']);
  assert.equal(entries[1].data.toString('utf8'), '😀');
  assert.throws(() => createStoredZip([{ name: '../x', data: Buffer.alloc(0) }]));
  assert.throws(() => createStoredZip([{ name: 'a', data: Buffer.alloc(0) }, { name: 'a', data: Buffer.alloc(0) }]));
});

test('export lists every blocking problem and builds a numbered ZIP when ready', () => {
  const stickers = new Map([
    [idOf('a'), { id: idOf('a'), isAnimated: false, status: 'converted', convertedPath: '/statics/x/a.webp' }],
    [idOf('b'), { id: idOf('b'), isAnimated: false, status: 'captured' }],
    [idOf('c'), { id: idOf('c'), isAnimated: true, status: 'converted', convertedPath: '/animated/x/c.webm' }],
    [idOf('d'), { id: idOf('d'), isAnimated: false, status: 'converted', convertedPath: '/statics/x/d.webp' }]
  ]);
  const sizes = { [idOf('a')]: 1000, [idOf('c')]: 300 * 1024, [idOf('d')]: 2000 };
  const context = {
    resolveSticker: (id) => stickers.get(id) || null,
    outputSize: (sticker) => sizes[sticker.id] ?? null,
    readOutput: (sticker) => Buffer.from(`file-${sticker.id[0]}`)
  };

  const problems = findExportProblems({
    items: [
      { stickerId: idOf('a'), emoji: [] },
      { stickerId: idOf('b'), emoji: ['😀'] },
      { stickerId: idOf('c'), emoji: ['🎉'] },
      { stickerId: idOf('e'), emoji: ['🎉'] }
    ]
  }, context);
  assert.deepEqual(problems.map((problem) => [problem.code, problem.position ?? null]), [
    ['no_emoji', 1], ['not_converted', 2], ['over_limit', 3], ['missing', 4], ['mixed', null]
  ]);
  assert.deepEqual(findExportProblems({ items: [] }, context).map((problem) => problem.code), ['empty']);

  const result = buildPackExport({
    title: 'Cats & Dogs!',
    items: [{ stickerId: idOf('d'), emoji: ['🐶'] }, { stickerId: idOf('a'), emoji: ['🐱', '😺'] }]
  }, { ...context, now: new Date('2026-09-25T12:00:00Z') });
  assert.deepEqual(result.problems, []);
  assert.equal(result.fileName, 'cats-dogs.zip');
  assert.equal(result.kind, 'static');
  const entries = readZip(result.zip);
  assert.deepEqual(entries.map((entry) => entry.name), ['001_dddddddd.webp', '002_aaaaaaaa.webp', 'pack.txt']);
  assert.equal(entries[0].data.toString(), 'file-d');
  const sheet = entries[2].data.toString('utf8');
  assert.match(sheet, /\/newpack/);
  assert.match(sheet, /001 {2}001_dddddddd\.webp {2}🐶/);
  assert.match(sheet, /002 {2}002_aaaaaaaa\.webp {2}🐱 😺/);
});

test('pack API: auth, snapshot before first write, edits, export, restart and delete', { timeout: 120_000 }, async () => {
  const server = await startSandboxServer('stickers-packs-api-');
  try {
    assert.equal((await fetch(`${server.origin}/api/packs`, { headers: { Origin: server.origin } })).status, 401);
    assert.equal((await fetch(`${server.origin}/api/packs`, {
      method: 'POST', headers: { ...server.headers, Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{"title":"x"}'
    })).status, 403);

    const form = new FormData();
    for (const [name, color] of [['one.png', '#aa0000'], ['two.png', '#00aa00']]) {
      const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
      form.append('files', new Blob([png], { type: 'image/png' }), name);
    }
    const imported = await server.request('/api/import/files', { method: 'POST', body: form });
    const [one, two] = imported.body.results.map((entry) => entry.sticker);

    assert.deepEqual((await server.request('/api/library/archives')).body.archives, []);
    const created = await server.request('/api/packs', { method: 'POST', body: { title: 'Test pack' } });
    assert.equal(created.status, 200);
    const packId = created.body.pack.id;
    assert.equal(created.body.activePackId, packId);
    assert.equal((await server.request('/api/library/archives')).body.archives.length, 1, 'snapshot taken before packs.json was created');

    let saved = await server.request(`/api/packs/${packId}`, {
      method: 'POST',
      body: { revision: 1, items: [{ stickerId: one.id, emoji: '😀' }, { stickerId: two.id, emoji: '' }] }
    });
    assert.equal(saved.status, 200);

    // Not converted and one emoji missing: export is refused with reasons.
    const blocked = await server.request(`/api/packs/${packId}/export`);
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body.problems.map((problem) => problem.code).sort(), ['no_emoji', 'not_converted', 'not_converted']);

    const job = await server.request('/api/jobs/convert', { method: 'POST', body: { ids: [one.id, two.id] } });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const jobs = (await server.request('/api/jobs')).body.jobs;
      if (jobs.find((item) => item.id === job.body.job.id).state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    saved = await server.request(`/api/packs/${packId}`, {
      method: 'POST',
      body: { revision: 2, items: [{ stickerId: two.id, emoji: ['🎉'] }, { stickerId: one.id, emoji: ['😀'] }] }
    });
    assert.equal(saved.status, 200);
    assert.equal((await server.request(`/api/packs/${packId}`, { method: 'POST', body: { revision: 2, title: 'Stale' } })).status, 409);

    const exported = await fetch(`${server.origin}/api/packs/${packId}/export`, { headers: server.headers });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('content-type'), 'application/zip');
    assert.match(exported.headers.get('content-disposition'), /test-pack\.zip/);
    const entries = readZip(Buffer.from(await exported.arrayBuffer()));
    assert.deepEqual(entries.map((entry) => entry.name), [`001_${two.id.slice(0, 8)}.webp`, `002_${one.id.slice(0, 8)}.webp`, 'pack.txt']);
    const stickers = (await server.request('/api/stickers')).body;
    const outputOf = (id) => fs.readFileSync(path.join(server.outputDir, stickers.find((item) => item.id === id).convertedPath));
    assert.ok(entries[0].data.equals(outputOf(two.id)), 'ZIP holds the converted file byte for byte');

    await server.restart();
    const afterRestart = (await server.request('/api/packs')).body;
    assert.equal(afterRestart.activePackId, packId);
    assert.deepEqual(afterRestart.packs[0].items.map((item) => item.stickerId), [two.id, one.id]);

    const deleted = await server.request(`/api/packs/${packId}/delete`, { method: 'POST' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.packs, []);
    assert.equal((await server.request('/api/stickers')).body.length, 2, 'stickers stay');
    assert.ok(outputOf(one.id).length > 0, 'files stay');
    assert.equal((await server.request('/api/packs/p_000000000000/delete', { method: 'POST' })).status, 404);
    assert.equal((await server.request('/api/packs/..%2Fx/export')).status, 404);
  } finally {
    await server.stop();
  }
});
