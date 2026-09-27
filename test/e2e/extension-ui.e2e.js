// UI smoke test of the extension popup and DevTools panel in headless Chrome.
// Installed Chrome does not load unpacked extensions from the command line,
// so the real pages are served from extension/ with a scripted chrome.* shim.
// Nothing here contacts TikTok: the page origin is a fake local host.
// Run with: npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { chromium } = require('playwright-core');

const extensionRoot = path.join(__dirname, '..', '..', 'extension');
const ORIGIN = 'http://extension.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// Runs in the page before any extension script.
function installChromeShim({ scenario, theme, har }) {
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  const base = {
    ok: true,
    captureEnabled: true,
    hasToken: true,
    serverUrl: 'http://127.0.0.1:3001',
    listenerState: 'watching',
    serverState: 'online',
    pausedReason: null,
    queue: { count: 0, blocked: 0, paused: 0 },
    session: { captureCount: 4, maxCaptures: 25, maxMs: 1200000, startedAt: iso(3), exhausted: false },
    warnings: [],
    lastEvent: 'Sticker delivered to the local server.',
    events: [
      { at: now - 5000, tone: 'ok', text: 'Sticker delivered to the local server.' },
      { at: now - 60000, tone: 'warning', text: 'Delivery paused: capture budget exhausted.' }
    ],
    counters: { delivered: 4 }
  };
  const scenarios = {
    connect: { hasToken: false, captureEnabled: false, listenerState: 'off', serverState: 'configuration_required', session: null, counters: { delivered: 0 } },
    off: { captureEnabled: false, listenerState: 'off' },
    watching: {},
    paused: {
      queue: { count: 1, blocked: 0, paused: 1 },
      pausedReason: 'capture_budget_exhausted',
      session: { captureCount: 25, maxCaptures: 25, maxMs: 1200000, startedAt: iso(12), exhausted: true },
      warnings: [{ code: 'session_limit' }]
    },
    failed: { queue: { count: 1, blocked: 1, paused: 0 } },
    challenge: {
      captureEnabled: false,
      listenerState: 'off',
      warnings: [{ code: 'challenge' }, { code: 'cache_disabled' }, { code: 'fast_capture', count: 14 }]
    }
  };
  const status = { ...base, ...scenarios[scenario] };
  const held = {
    paused: [{ id: 'held-paused-1', state: 'paused', base64Length: 40000, mimeType: 'image/webp' }],
    failed: [{ id: 'held-blocked-1', state: 'blocked', lastError: 'content_type_mismatch', base64Length: 16000, mimeType: 'image/webp' }]
  }[scenario] || [];
  const feed = scenario === 'connect' ? [] : [
    { id: 'f1', at: now - 5000, state: 'new', stickerId: 'a'.repeat(64), origin: 'live', mimeType: 'image/webp' },
    { id: 'f2', at: now - 9000, state: 'rejected', reason: 'content_type_mismatch', origin: 'network_log', mimeType: 'image/png' }
  ];
  const messages = [];
  window.__messages = messages;
  let captureEnabled = status.captureEnabled;
  window.chrome = {
    runtime: {
      lastError: null,
      getURL: (file) => `${location.origin}/${file}`,
      sendMessage(message, callback) {
        messages.push(message);
        setTimeout(() => {
          if (message.type === 'GET_FEED') callback({ ok: true, items: feed, diagnostics: {}, serverUrl: status.serverUrl });
          else if (message.type === 'LIST_HELD') callback({ ok: true, items: held });
          else if (message.type === 'QUEUE_CAPTURE') callback({ ok: true, queued: true });
          else if (message.type === 'DISCARD_ITEM') callback({ ok: true });
          else callback({ ...status, captureEnabled });
        }, 0);
      }
    },
    storage: {
      local: {
        get(defaults, callback) {
          callback({ ...defaults, serverUrl: status.serverUrl, ingestToken: status.hasToken ? 'x'.repeat(43) : '', captureEnabled });
        },
        set(values, callback) {
          if ('captureEnabled' in values) captureEnabled = values.captureEnabled;
          if (values.ingestToken) Object.assign(status, { hasToken: true, serverState: 'online' });
          messages.push({ type: 'storage.set', values });
          if (callback) callback();
        }
      }
    },
    devtools: {
      panels: { themeName: theme === 'dark' ? 'dark' : 'default' },
      inspectedWindow: {
        tabId: 7,
        getResources(callback) { callback([{ type: 'document', url: 'https://www.tiktok.com/messages' }]); }
      },
      network: {
        getHAR(callback) {
          callback({
            entries: (har || []).map((entry) => ({
              request: { url: entry.url, method: 'GET', headers: [] },
              response: { status: 200, headers: [{ name: 'content-type', value: entry.mimeType }], content: { mimeType: entry.mimeType, size: entry.size } },
              getContent(done) { done(entry.base64, 'base64'); }
            }))
          });
        }
      }
    }
  };
}

async function openPage(browser, file, { scenario = 'watching', theme = 'light', har = [], width = 360, height = 700 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  const problems = [];
  const requests = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const filePath = path.join(extensionRoot, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(extensionRoot) || !fs.existsSync(filePath)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(filePath)], body: fs.readFileSync(filePath) });
  });
  await page.addInitScript(installChromeShim, { scenario, theme, har });
  await page.goto(`${ORIGIN}/${file}`);
  await page.waitForFunction(() => document.getElementById('overallText').textContent !== 'Checking…');
  return { page, problems, requests };
}

async function pill(page) {
  return page.evaluate(() => ({
    text: document.getElementById('overallText').textContent,
    tone: document.getElementById('overall').className.match(/tone-(\w+)/)[1]
  }));
}

async function layoutCheck(page, label) {
  const result = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    unlabeled: [...document.querySelectorAll('input')].filter((input) => input.labels.length === 0).map((input) => input.id),
    unnamedButtons: [...document.querySelectorAll('button')].filter((button) => !button.textContent.trim()).length
  }));
  assert.equal(result.overflow, false, `${label}: horizontal overflow`);
  assert.deepEqual(result.unlabeled, [], `${label}: inputs without a label`);
  assert.equal(result.unnamedButtons, 0, `${label}: buttons without text`);
}

test('extension popup: connect, off, watching, paused, delivery failed and verification check', { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const expected = {
      connect: { text: 'Not connected', tone: 'pending' },
      off: { text: 'Capture off', tone: 'pending' },
      watching: { text: 'Watching', tone: 'ok' },
      paused: { text: 'Session limit', tone: 'problem' },
      failed: { text: 'Delivery failed', tone: 'problem' },
      challenge: { text: 'Verification check', tone: 'problem' }
    };
    for (const [scenario, pillState] of Object.entries(expected)) {
      const { page, problems, requests } = await openPage(browser, 'popup.html', { scenario });
      await page.waitForTimeout(150);
      assert.deepEqual(await pill(page), pillState, `${scenario} pill`);
      await layoutCheck(page, `popup ${scenario}`);
      const state = await page.evaluate(() => ({
        bodyWidth: document.body.getBoundingClientRect().width,
        background: getComputedStyle(document.body).backgroundColor,
        theme: document.documentElement.dataset.theme || null,
        settingsOpen: document.getElementById('settingsBox').open,
        saveLabel: document.getElementById('saveLabel').textContent,
        switchOn: document.getElementById('captureEnabled').checked,
        held: [...document.querySelectorAll('.held-reason')].map((node) => node.textContent),
        heldVisible: !document.getElementById('heldSection').hidden,
        alerts: document.querySelectorAll('#warnings .inline-alert').length
      }));
      assert.equal(state.bodyWidth, 360, `${scenario}: popup width`);
      assert.equal(state.background, 'rgb(255, 255, 255)', `${scenario}: popup stays light`);
      assert.equal(state.theme, null);
      assert.equal(state.settingsOpen, scenario === 'connect', `${scenario}: settings open only for Connect`);
      assert.equal(state.saveLabel, scenario === 'connect' ? 'Connect' : 'Save and reconnect');
      assert.equal(state.switchOn, !['connect', 'off', 'challenge'].includes(scenario));
      if (scenario === 'paused') assert.deepEqual(state.held, ['Paused: session limit · 29 KB']);
      if (scenario === 'failed') assert.deepEqual(state.held, ['Blocked: not a sticker image · 12 KB']);
      assert.equal(state.heldVisible, ['paused', 'failed'].includes(scenario));
      assert.equal(state.alerts, scenario === 'challenge' ? 2 : scenario === 'paused' ? 1 : 0, `${scenario}: at most two warnings`);

      if (scenario === 'failed') {
        // Discard deletes the only copy, so the first click only arms it.
        const discard = page.locator('.held-actions button', { hasText: 'Discard' });
        await discard.click();
        assert.equal(await page.evaluate(() => window.__messages.some((message) => message.type === 'DISCARD_ITEM')), false);
        assert.match(await discard.getAttribute('class'), /btn-danger/);
        await page.locator('.held-actions button', { hasText: 'Confirm discard' }).click();
        await page.waitForFunction(() => window.__messages.some((message) => message.type === 'DISCARD_ITEM'));
      }
      if (scenario === 'connect') {
        await page.getByLabel('Connection token').fill('t'.repeat(43));
        await page.getByRole('button', { name: 'Connect' }).click();
        await page.waitForFunction(() => document.getElementById('message').textContent === 'Connected to the local server.');
        assert.equal(await page.evaluate(() => document.getElementById('settingsBox').open), false, 'settings collapse once connected');
        assert.deepEqual(await pill(page), { text: 'Capture off', tone: 'pending' });
        assert.equal(await page.evaluate(() => window.__messages.some((message) => message.type === 'SETTINGS_UPDATED')), true);
      }
      if (scenario === 'off') {
        await page.locator('#captureEnabled').focus();
        await page.keyboard.press('Space');
        await page.waitForFunction(() => window.__messages.some((message) => message.type === 'storage.set' && message.values.captureEnabled === true));
        const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineColor);
        assert.equal(ring, 'rgb(184, 167, 245)', 'keyboard focus ring uses the focus token');
      }
      assert.deepEqual(problems, [], `${scenario}: console errors`);
      assert.ok(requests.every((url) => url.startsWith(`${ORIGIN}/`)), `${scenario}: only bundled files`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('extension panel: DevTools theme, layout widths and Capture from Network log', { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [theme, background] of [['light', 'rgb(255, 255, 255)'], ['dark', 'rgb(18, 23, 30)']]) {
      for (const width of [480, 1000]) {
        const { page, problems } = await openPage(browser, 'panel.html', { scenario: 'challenge', theme, width, height: 800 });
        await page.waitForTimeout(150);
        assert.deepEqual(await pill(page), { text: 'Verification check', tone: 'problem' });
        await layoutCheck(page, `panel ${theme} ${width}`);
        const state = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          background: getComputedStyle(document.body).backgroundColor,
          tiles: document.querySelectorAll('.stat').length,
          warnings: document.querySelectorAll('#warnings .inline-alert').length,
          feed: document.querySelectorAll('.feed-item').length,
          links: [...document.querySelectorAll('.feed-link')].map((link) => link.href)
        }));
        assert.equal(state.theme, theme);
        assert.equal(state.background, background, `${theme} background`);
        assert.equal(state.tiles, 4);
        assert.equal(state.warnings, 3);
        assert.equal(state.feed, 2);
        assert.deepEqual(state.links, [`http://127.0.0.1:3001/?id=${'a'.repeat(64)}`]);
        assert.deepEqual(problems, [], `panel ${theme} ${width}: console errors`);
        await page.close();
      }
    }

    // Network log capture runs recorded entries through the real pipeline in
    // Chrome, including the thumbnail; it never requests the sticker URL.
    const webp = await sharp({
      create: { width: 160, height: 160, channels: 4, background: { r: 230, g: 80, b: 60, alpha: 1 } }
    }).webp().toBuffer();
    const stickerUrl = 'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/obj/video2sticker/e2e.awebp?x-signature=secret';
    const har = [
      { url: stickerUrl, mimeType: 'image/webp', size: webp.length, base64: webp.toString('base64') },
      { url: 'https://p16-common-sign.tiktokcdn.com/tos-maliva-avt-0068/abc~tplv-tiktokx-cropcenter:168:168.webp', mimeType: 'image/webp', size: webp.length, base64: webp.toString('base64') }
    ];
    const { page, problems, requests } = await openPage(browser, 'panel.html', { scenario: 'watching', har, width: 1000, height: 800 });
    await page.getByRole('button', { name: 'Capture from Network log' }).click();
    await page.waitForFunction(() => /Found 1 sticker response/.test(document.getElementById('logResult').textContent));
    const queued = await page.evaluate(() => window.__messages.filter((message) => message.type === 'QUEUE_CAPTURE'));
    assert.equal(queued.length, 1, 'only the sticker entry is queued');
    assert.equal(queued[0].origin, 'network_log');
    assert.equal(queued[0].payload.mimeType, 'image/webp');
    assert.equal(queued[0].payload.sourceUrl.includes('x-signature'), false, 'query stripped');
    assert.match(queued[0].thumbnail || '', /^data:image\/(webp|png);base64,/, 'thumbnail made in Chrome');
    assert.ok(queued[0].thumbnail.length < 40000);
    assert.equal(await page.evaluate(() => document.getElementById('logResult').className), 'inline-alert tone-ok');
    assert.ok(requests.every((url) => url.startsWith(`${ORIGIN}/`)), 'no request left the extension files');
    assert.deepEqual(problems, []);
    await page.close();
  } finally {
    await browser.close();
  }
});
