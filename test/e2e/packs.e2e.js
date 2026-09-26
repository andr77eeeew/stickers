// Pack workflow in headless Chrome against an empty sandbox library:
// create, emoji, batch add, keyboard reorder, ZIP export, restart, delete.
// It never opens TikTok or Telegram. Run with: npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');
const { chromium } = require('playwright-core');
const { startSandboxServer } = require('../helpers/sandboxServer');
const { readZip } = require('../helpers/zipReader');

async function importAndConvert(server) {
  const form = new FormData();
  for (const [name, color] of [['red.png', '#e53935'], ['green.png', '#43a047'], ['blue.png', '#1e88e5']]) {
    const png = await sharp({ create: { width: 200, height: 200, channels: 4, background: color } }).png().toBuffer();
    form.append('files', new Blob([png], { type: 'image/png' }), name);
  }
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-e2e-video-'));
  const video = path.join(videoDir, 'clip.mp4');
  execFileSync(ffmpegPath, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x160:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', video]);
  form.append('files', new Blob([fs.readFileSync(video)], { type: 'video/mp4' }), 'clip.mp4');
  fs.rmSync(videoDir, { recursive: true, force: true });

  const imported = await server.request('/api/import/files', { method: 'POST', body: form });
  const stickers = imported.body.results.map((entry) => entry.sticker);
  const job = await server.request('/api/jobs/convert', { method: 'POST', body: { ids: stickers.map((sticker) => sticker.id) } });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const current = (await server.request('/api/jobs')).body.jobs.find((item) => item.id === job.body.job.id);
    if (current.state !== 'running') {
      assert.equal(current.state, 'succeeded');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const byName = (name) => stickers.find((sticker) => sticker.tags.includes(`import:${name}`));
  return { red: byName('red.png'), green: byName('green.png'), blue: byName('blue.png'), clip: byName('clip.mp4') };
}

const packRowIds = (page) => page.$$eval('.pack-row .pack-row-info .mono', (nodes) => nodes.map((node) => node.textContent));

test('packs: create, emoji, batch add, reorder, export ZIP, restart and delete', { timeout: 300_000 }, async () => {
  const server = await startSandboxServer('stickers-e2e-packs-');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const { red, green, blue, clip } = await importAndConvert(server);
    const short = (sticker) => sticker.id.slice(0, 8);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));

    // No pack yet: the library shows no pack bar and no pack filter.
    await page.goto(`${server.origin}/`);
    await page.locator('.sticker-tile').first().waitFor();
    assert.equal(await page.locator('.pack-bar').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Not in a pack' }).count(), 0);

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Packs' }).click();
    await page.getByRole('heading', { name: 'No packs yet' }).waitFor();
    await page.getByLabel('New pack title').fill('E2E pack');
    await page.getByRole('button', { name: 'New pack' }).click();
    await page.getByRole('heading', { name: 'E2E pack' }).waitFor();
    assert.match(page.url(), /view=packs&pack=p_[a-f0-9]{12}/);

    // Picking an emoji in the inspector adds the sticker to the current pack.
    await page.goto(`${server.origin}/?id=${green.id}`);
    await page.locator('.inspector').waitFor();
    await page.getByRole('group', { name: 'Quick emoji' }).getByRole('button', { name: '🔥' }).click();
    await page.locator('.inspector').getByText('#1 of 1').waitFor();
    await page.keyboard.press('Escape');
    await page.locator(`[data-sticker-id="${green.id}"] .tile-emoji`, { hasText: '🔥' }).waitFor();

    // Batch add: the video is skipped with a reason, the rest keep page order.
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: /Select page/ }).click();
    await page.getByRole('button', { name: 'Add to pack' }).click();
    await page.getByText(/Added 2 to “E2E pack”; skipped 1 already in it, 1 of the other format/).waitFor();
    await page.locator('.pack-bar').getByText('2 stickers without emoji.').waitFor();
    assert.ok(await page.locator('.pack-bar').getByRole('button', { name: 'Export for @Stickers' }).isDisabled());

    // "Not in a pack" leaves only the video.
    await page.getByRole('button', { name: 'Not in a pack' }).click();
    await page.waitForFunction(() => location.search.includes('unpacked=1'));
    assert.deepEqual(
      await page.$$eval('.sticker-tile', (tiles) => tiles.map((tile) => tile.dataset.stickerId)),
      [clip.id]
    );
    await page.getByRole('button', { name: 'Not in a pack' }).click();

    // Emoji per row, then keyboard reorder keeps focus on the pressed control.
    await page.locator('.pack-bar').getByRole('button', { name: 'Open pack' }).click();
    await page.getByRole('heading', { name: 'E2E pack' }).waitFor();
    const order = await packRowIds(page);
    assert.equal(order[0], short(green));
    for (const [index, emoji] of [[2, '😀'], [3, '👍 🎉']]) {
      await page.getByLabel(`Emoji for sticker ${index}`).fill(emoji);
      await page.getByLabel(`Emoji for sticker ${index}`).press('Enter');
    }
    await page.getByText(/Ready to export: 3 stickers/).waitFor();

    await page.getByLabel('Emoji for sticker 3').fill('abc');
    await page.getByLabel('Emoji for sticker 3').press('Enter');
    await page.getByText('“a” is not an emoji.').waitFor();
    await page.getByLabel('Emoji for sticker 3').fill('👍 🎉');

    await page.getByRole('button', { name: 'Move sticker 3 up' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction((expected) => document.querySelectorAll('.pack-row .mono')[1]?.textContent === expected, order[2]);
    assert.deepEqual(await packRowIds(page), [order[0], order[2], order[1]]);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Move sticker 2 up', 'focus follows the moved sticker');

    // Export: the ZIP holds the converted files in pack order plus the cheat sheet.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.pack-detail').getByRole('button', { name: 'Export for @Stickers' }).click()
    ]);
    assert.equal(download.suggestedFilename(), 'e2e-pack.zip');
    const entries = readZip(fs.readFileSync(await download.path()));
    assert.deepEqual(entries.map((entry) => entry.name), [
      `001_${order[0]}.webp`, `002_${order[2]}.webp`, `003_${order[1]}.webp`, 'pack.txt'
    ]);
    const sheet = entries[3].data.toString('utf8');
    assert.match(sheet, /E2E pack/);
    assert.match(sheet, /\/newpack/);
    assert.match(sheet, new RegExp(`001 {2}001_${order[0]}\\.webp {2}🔥`));
    const stickers = (await server.request('/api/stickers')).body;
    const onDisk = fs.readFileSync(path.join(server.outputDir, stickers.find((item) => item.id === green.id).convertedPath));
    assert.ok(entries[0].data.equals(onDisk), 'exported file is the converted output byte for byte');

    // No horizontal overflow on the packs page and the library with the pack bar.
    for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      for (const url of ['/?view=packs', '/']) {
        await page.goto(`${server.origin}${url}`);
        await page.locator('.app-header').waitFor();
        await page.waitForTimeout(300);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no overflow at ${width}px on ${url}`);
      }
    }

    // The pack survives a restart; deleting it leaves stickers and files alone.
    await server.restart();
    await page.goto(`${server.origin}/?view=packs`);
    await page.getByRole('heading', { name: 'E2E pack' }).waitFor();
    assert.deepEqual(await packRowIds(page), [order[0], order[2], order[1]]);
    await page.getByRole('button', { name: 'Delete pack' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete pack' }).click();
    await page.getByRole('heading', { name: 'No packs yet' }).waitFor();
    assert.equal((await server.request('/api/stickers')).body.length, 4);
    assert.ok(fs.existsSync(path.join(server.outputDir, stickers.find((item) => item.id === blue.id).convertedPath)));
    assert.ok(red && blue);

    assert.deepEqual(errors, [], 'no console errors');
  } finally {
    await browser.close();
    await server.stop();
  }
});
