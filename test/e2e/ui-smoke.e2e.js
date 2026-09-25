// Repeatable local UI smoke test. Runs the built dashboard against an empty
// sandbox library in headless Chrome. It never opens TikTok or Telegram.
// Run with: npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { chromium } = require('playwright-core');
const { startSandboxServer } = require('../helpers/sandboxServer');

const CONNECTION_NOISE = /ERR_CONNECTION_REFUSED|Failed to load resource|WebSocket/i;

async function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-e2e-files-'));
  const files = [];
  for (const [name, color] of [['red.png', '#e53935'], ['green.png', '#43a047'], ['blue.png', '#1e88e5']]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><circle cx="120" cy="120" r="100" fill="${color}"/></svg>`;
    const filePath = path.join(dir, name);
    await sharp(Buffer.from(svg)).png().toFile(filePath);
    files.push(filePath);
  }
  const broken = path.join(dir, 'broken.png');
  fs.writeFileSync(broken, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  return { dir, files, broken };
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function tabUntil(page, predicate, limit = 60) {
  for (let step = 0; step < limit; step += 1) {
    if (await page.evaluate(predicate)) return true;
    await page.keyboard.press('Tab');
  }
  return page.evaluate(predicate);
}

test('dashboard smoke: import, search, keyboard download, tags, editor, batch, health, reconnect', { timeout: 300_000 }, async () => {
  const server = await startSandboxServer('stickers-e2e-');
  const fixtures = await makeFixtures();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${server.origin}/`);
    await page.getByRole('heading', { name: 'No stickers yet' }).waitFor();

    // Import three images and one broken file; auto-convert runs as one job.
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.locator('dialog[open] input[type=file]').setInputFiles([...fixtures.files, fixtures.broken]);
    await page.locator('.import-summary').filter({ hasText: '3 imported' }).waitFor();
    assert.match(await page.locator('.import-failed').innerText(), /damaged|not a supported image/i);
    await page.waitForFunction(() => document.querySelectorAll('.sticker-tile[aria-label$="Ready"]').length === 3, null, { timeout: 60_000 });

    await page.locator('dialog[open] input[type=file]').setInputFiles([fixtures.files[0]]);
    await page.locator('.import-duplicate').waitFor();
    await page.keyboard.press('Escape');

    // Search is reflected in the URL and has an honest empty state.
    const stickers = (await server.request('/api/stickers')).body;
    const target = stickers.find((sticker) => sticker.tags.includes('import:green.png'));
    await page.keyboard.press('/');
    await page.keyboard.type(target.id.slice(0, 8));
    await page.waitForFunction((prefix) => location.search.includes(`q=${prefix}`), target.id.slice(0, 8));
    await page.waitForFunction(() => document.querySelectorAll('.sticker-tile').length === 1);

    // Keyboard only: reach the tile, open it, reach Download and press Enter.
    assert.ok(await tabUntil(page, () => document.activeElement?.classList.contains('sticker-tile')), 'tile reachable by Tab');
    await page.keyboard.press('Enter');
    await page.locator('.inspector').waitFor();
    assert.ok(await tabUntil(page, () => document.activeElement?.textContent?.includes('Download WebP')), 'download reachable by Tab');
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    assert.match(download.suggestedFilename(), /\.webp$/);

    // Tags are saved alongside the import tag.
    await page.getByLabel('Add tag').fill('e2e');
    await page.getByLabel('Add tag').press('Enter');
    await page.getByRole('button', { name: 'Save tags' }).click();
    await page.waitForFunction(async (id) => {
      const list = await fetch('/api/stickers').then((response) => response.json());
      return list.find((sticker) => sticker.id === id).tags.includes('e2e');
    }, target.id);

    await page.keyboard.press('Escape');
    await page.locator('.inspector').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.stickerId), target.id, 'focus returns to the tile');

    // The no-results state, then clearing filters.
    await page.getByLabel('Search stickers').fill('zzzz');
    await page.getByRole('heading', { name: 'No stickers match your search' }).waitFor();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sticker-tile').length === 3);

    // Editor: unsaved changes are guarded.
    await page.locator('.sticker-tile').first().click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('heading', { name: 'Edit sticker' }).waitFor();
    assert.match(page.url(), /view=editor/);
    await page.getByRole('spinbutton', { name: 'Rotation' }).fill('30');
    await page.getByRole('spinbutton', { name: 'Rotation' }).blur();
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Discard changes?' }).waitFor();
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.waitForFunction(() => !location.search.includes('view=editor'));
    await page.keyboard.press('Escape');

    // Batch: tag and convert the whole page, follow the job in Jobs.
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: /Select page/ }).click();
    await page.getByRole('button', { name: /Tags/ }).click();
    await page.getByLabel('Add tags').fill('batch');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByText('Updated 3 of 3.').waitFor();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Convert 3' }).click();
    await page.getByRole('button', { name: /^Jobs/ }).click();
    await page.locator('.job-card').first().locator('.badge', { hasText: 'Done' }).waitFor({ timeout: 60_000 });
    await page.keyboard.press('Escape');

    // Health: real check, snapshot, verification.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Health' }).click();
    await page.getByRole('button', { name: 'Run check' }).click();
    await page.locator('.health-headline', { hasText: 'No issues found' }).waitFor();
    await page.getByRole('button', { name: 'Create archive snapshot' }).click();
    await page.getByRole('button', { name: 'Create snapshot' }).click();
    await page.locator('.archive-row').waitFor();
    await page.getByRole('button', { name: 'Verify files' }).click();
    await page.locator('.archive-integrity', { hasText: 'Verified' }).waitFor();

    // No horizontal overflow at the supported widths.
    for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1280, 800], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      for (const url of ['/', '/?view=health', `/?view=editor&id=${target.id}`]) {
        await page.goto(`${server.origin}${url}`);
        await page.locator('.app-header').waitFor();
        await page.waitForTimeout(300);
        assert.ok(await noHorizontalOverflow(page), `no horizontal overflow at ${width}px on ${url}`);
      }
    }

    // Mobile detail is a full-screen layer with Back.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.origin}/`);
    await page.locator('.sticker-tile').first().click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.locator('.inspector').waitFor({ state: 'detached' });

    assert.deepEqual(errors, [], 'no console errors during the scenarios');

    // Reconnect: stopping the server pauses updates; restarting recovers without a reload.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.origin}/`);
    await page.locator('.status-pill', { hasText: 'Local' }).waitFor();
    await server.restart();
    await page.locator('.status-pill', { hasText: 'Local' }).waitFor({ timeout: 20_000 });
    assert.equal(await page.locator('.sticker-tile').count(), 3, 'library stays visible across the reconnect');
    const unexpected = errors.filter((message) => !CONNECTION_NOISE.test(message));
    assert.deepEqual(unexpected, [], 'only connection noise while the server restarted');
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(fixtures.dir, { recursive: true, force: true });
  }
});

test('1000-record catalogue keeps one page in the DOM and stays responsive', { timeout: 180_000 }, async (t) => {
  const { makeCatalogueFixture } = require('../fixtures/redesign');
  const server = await startSandboxServer('stickers-e2e-1000-', {
    // Synthetic records only; their media files do not exist, which the UI must tolerate.
    seed: ({ outputDir }) => {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'stickers_db.json'), JSON.stringify(makeCatalogueFixture(1000)));
    }
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const started = Date.now();
    await page.goto(`${server.origin}/`);
    await page.locator('.sticker-tile').first().waitFor();
    const firstTileMs = Date.now() - started;

    const metrics = await page.evaluate(() => ({
      tiles: document.querySelectorAll('.sticker-tile').length,
      firstTileTop: Math.round(document.querySelector('.sticker-tile').getBoundingClientRect().top),
      documentHeight: document.documentElement.scrollHeight,
      pageLabel: document.querySelector('.pagination')?.innerText.replace(/\s+/g, ' ')
    }));

    // Typing latency: time from a keystroke to the filtered grid.
    const search = page.getByLabel('Search stickers');
    await search.click();
    const typingStart = Date.now();
    await page.keyboard.type('fff');
    await page.waitForFunction(() => location.search.includes('q=fff'));
    await page.waitForFunction(() => document.querySelector('.pagination')?.innerText.includes('of') || document.querySelector('.state-panel'));
    const searchMs = Date.now() - typingStart;

    t.diagnostic(`first tile ${firstTileMs} ms, search 3 keys ${searchMs} ms, ${JSON.stringify(metrics)}`);
    assert.equal(metrics.tiles, 24, 'only one page of tiles is rendered');
    assert.ok(metrics.firstTileTop <= 280, 'first tile inside the first mobile screen');
    assert.ok(metrics.documentHeight < 4000, 'the page is not tens of thousands of pixels tall');
    assert.ok(searchMs < 2000, 'search stays responsive');
  } finally {
    await browser.close();
    await server.stop();
  }
});
