'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { extensionRoot } = require('../helpers/extensionHarness');
const Icons = require('../../extension/shared/icons.js');
const StatusText = require('../../extension/shared/statusText.js');

const repoRoot = path.join(extensionRoot, '..');
const tokens = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'docs', 'redesign', 'stage1', 'tokens.json'), 'utf8')
);
const tokensCss = fs.readFileSync(path.join(extensionRoot, 'shared', 'tokens.css'), 'utf8');
const read = (file) => fs.readFileSync(path.join(extensionRoot, file), 'utf8');

function cssBlock(selector) {
  const start = tokensCss.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} block`);
  const body = tokensCss.slice(start, tokensCss.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])
  );
}

const light = cssBlock(':root');
const dark = cssBlock(':root[data-theme="dark"]');

// tokens.json key → variable name used by the dashboard and the extension.
const COLOR_VARIABLES = {
  page: '--page',
  surface: '--surface',
  surfaceSubtle: '--surface-subtle',
  text: '--text',
  textSecondary: '--text-2',
  border: '--border',
  accent: '--accent',
  accentHover: '--accent-hover',
  accentSubtle: '--accent-subtle',
  focus: '--focus',
  success: '--ok',
  warning: '--warning',
  danger: '--problem',
  successSubtle: '--ok-subtle',
  warningSubtle: '--warning-subtle',
  dangerSubtle: '--problem-subtle',
  previewNeutral: '--preview-neutral',
  previewChecker: '--preview-checker'
};

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

test('light extension tokens match docs/redesign/stage1/tokens.json', () => {
  for (const [key, variable] of Object.entries(COLOR_VARIABLES)) {
    assert.equal(light[variable]?.toUpperCase(), tokens.colors[key], `${key} (${variable})`);
  }
  assert.equal(light['--radius-tile'], `${tokens.radiusPx.tile}px`);
  assert.equal(light['--radius-control'], `${tokens.radiusPx.control}px`);
  assert.equal(light['--radius-panel'], `${tokens.radiusPx.panel}px`);
  assert.equal(light['--focus-ring'], `${tokens.layoutPx.focusRingWidth}px`);
  assert.equal(light['--control-min'], `${tokens.layoutPx.controlMinHeight}px`);
  assert.equal(light['--fast'], `${tokens.motionMs.fast}ms`);
  assert.equal(light['--normal'], `${tokens.motionMs.normal}ms`);
  const words = (value) => value.replace(/"/g, '').split(',').map((part) => part.trim());
  assert.deepEqual(words(light['--font']), words(tokens.fontFamily));
  assert.deepEqual(words(light['--font-mono']), words(tokens.fontFamilyMono));
});

test('light tokens use the dashboard values', () => {
  const dashboard = fs.readFileSync(path.join(repoRoot, 'frontend', 'src', 'index.css'), 'utf8');
  const root = dashboard.slice(dashboard.indexOf(':root {'), dashboard.indexOf('}', dashboard.indexOf(':root {')));
  for (const [, name, value] of root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    if (name in light) assert.equal(light[name], value.trim(), name);
  }
});

test('the dark panel palette redefines every colour', () => {
  const colors = Object.keys(light).filter((name) => /^#/.test(light[name]));
  for (const name of colors) {
    assert.match(dark[name] || '', /^#[0-9a-f]{6}$/i, `${name} in the dark theme`);
  }
});

test('text colours keep a contrast of at least 4.5:1 in both themes', () => {
  for (const [theme, palette] of Object.entries({ light, dark })) {
    const check = (foreground, background) => {
      const ratio = contrast(palette[foreground], palette[background]);
      assert.ok(ratio >= 4.5, `${theme}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
    };
    for (const background of ['--page', '--surface', '--surface-subtle']) {
      for (const foreground of ['--text', '--text-2', '--accent-text', '--ok', '--warning', '--problem']) {
        check(foreground, background);
      }
    }
    check('--ok', '--ok-subtle');
    check('--warning', '--warning-subtle');
    check('--problem', '--problem-subtle');
    check('--accent-text', '--accent-subtle');
    check('--on-accent', '--accent');
    check('--on-accent', '--accent-hover');
    check('--on-problem', '--problem');
    check('--on-problem', '--problem-hover');
  }
});

test('toolbar badge colours come from the tokens', () => {
  const background = read('background.js');
  const block = background.slice(background.indexOf('const BADGE_COLORS'), background.indexOf('});', background.indexOf('const BADGE_COLORS')));
  const colors = Object.fromEntries([...block.matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)].map(([, key, value]) => [key, value.toUpperCase()]));
  assert.deepEqual(colors, {
    off: tokens.colors.textSecondary,
    problem: tokens.colors.danger,
    paused: tokens.colors.warning,
    queued: tokens.colors.accent
  });
});

test('pages load the shared tokens and use only bundled icons', () => {
  for (const page of ['popup.html', 'panel.html']) {
    const source = read(page);
    assert.match(source, /href="shared\/tokens\.css"[\s\S]*href="shared\/ui\.css"/, `${page} loads tokens before components`);
    for (const [, name] of source.matchAll(/data-icon="([^"]+)"/g)) {
      assert.ok(Icons.NODES[name], `${page} icon ${name}`);
    }
  }
  for (const script of ['popup.js', 'panel.js']) {
    for (const [, name] of read(script).matchAll(/Icons\.element\('([^']+)'\)/g)) {
      assert.ok(Icons.NODES[name], `${script} icon ${name}`);
    }
  }
  for (const name of Object.values(Icons.TONE_ICONS)) assert.ok(Icons.NODES[name], name);
});

test('the panel follows the DevTools theme and the popup stays light', () => {
  const panel = read('panel.html');
  assert.ok(panel.indexOf('src="panelTheme.js"') < panel.indexOf('<body'), 'theme applies before the first paint');
  assert.doesNotMatch(read('popup.html'), /panelTheme|data-theme/);
  assert.match(read('panelTheme.js'), /chrome\.devtools\.panels[\s\S]*themeName === 'dark'/);
});

test('manifest names the extension and ships every icon size', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.name, 'Sticker Workspace Capture');
  assert.equal(manifest.action.default_title, manifest.name);
  assert.equal(manifest.version, '3.0.0');
  const icons = { ...manifest.icons, ...manifest.action.default_icon };
  assert.deepEqual(Object.keys(manifest.icons).sort(), ['128', '16', '32', '48']);
  for (const [size, file] of Object.entries(icons)) {
    const png = fs.readFileSync(path.join(extensionRoot, file));
    assert.equal(png.toString('ascii', 1, 4), 'PNG', file);
    assert.equal(png.readUInt32BE(16), Number(size), `${file} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `${file} height`);
  }
  assert.match(read('devtools.js'), /panels\.create\(\s*'Sticker Capture',\s*'icons\/icon-16\.png'/);
});

test('header pill: the most important state first, as in the dashboard', async () => {
  const { LISTENER_SHORT } = await import('../../frontend/src/lib/captureModel.js');
  assert.deepEqual({ ...StatusText.LISTENER_SHORT }, { ...LISTENER_SHORT });

  const base = {
    hasToken: true,
    serverState: 'online',
    captureEnabled: true,
    listenerState: 'watching',
    queue: { count: 0, blocked: 0, paused: 0 },
    warnings: []
  };
  const pill = (patch) => StatusText.describeOverall({ ...base, ...patch });
  assert.deepEqual(pill({}), { tone: 'ok', text: 'Watching' });
  assert.deepEqual(pill({ hasToken: false, serverState: 'offline' }), { tone: 'pending', text: 'Not connected' });
  assert.deepEqual(pill({ serverState: 'offline', warnings: [{ code: 'challenge' }] }), { tone: 'problem', text: 'Server offline' });
  assert.deepEqual(pill({ serverState: 'unauthorized' }), { tone: 'problem', text: 'Token rejected' });
  assert.deepEqual(pill({ serverState: 'unknown' }), { tone: 'ok', text: 'Watching' });
  assert.deepEqual(
    pill({ captureEnabled: false, listenerState: 'off', warnings: [{ code: 'challenge' }] }),
    { tone: 'problem', text: 'Verification check' }
  );
  assert.deepEqual(pill({ captureEnabled: false, listenerState: 'off' }), { tone: 'pending', text: 'Capture off' });
  assert.deepEqual(pill({ session: { exhausted: true } }), { tone: 'problem', text: 'Session limit' });
  assert.deepEqual(pill({ queue: { count: 2, blocked: 1, paused: 0 } }), { tone: 'problem', text: 'Delivery failed' });
  assert.deepEqual(pill({ warnings: [{ code: 'fast_capture', count: 13 }] }), { tone: 'pending', text: 'Watching' });
  assert.deepEqual(pill({ warnings: [{ code: 'cache_disabled' }] }), { tone: 'problem', text: 'Watching' });
  assert.deepEqual(pill({ listenerState: 'closed' }), { tone: 'pending', text: 'DevTools closed' });
});
