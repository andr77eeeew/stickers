'use strict';

// Guard rails for the account-safety boundary (docs/extension/PLAN.md §4).
// A change that needs to relax one of these checks must update this file
// deliberately, together with docs/ACCOUNT_SAFETY.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { extensionRoot } = require('../helpers/extensionHarness');

const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8')
);

function listFiles(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath, extension);
    return entry.name.endsWith(extension) ? [fullPath] : [];
  });
}

function relative(filePath) {
  return path.relative(extensionRoot, filePath).split(path.sep).join('/');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const scripts = listFiles(extensionRoot, '.js').map((filePath) => ({
  file: relative(filePath),
  source: stripComments(fs.readFileSync(filePath, 'utf8'))
}));
const pages = listFiles(extensionRoot, '.html').map((filePath) => ({
  file: relative(filePath),
  source: fs.readFileSync(filePath, 'utf8')
}));

function isLoopbackPattern(value) {
  return /^http:\/\/(127\.0\.0\.1|localhost):(\d+|\*)\/\*$/.test(value);
}

test('manifest keeps only reviewed top-level keys', () => {
  const allowed = new Set([
    'manifest_version',
    'name',
    'version',
    'description',
    'icons',
    'permissions',
    'host_permissions',
    'optional_host_permissions',
    'background',
    'devtools_page',
    'action',
    'minimum_chrome_version'
  ]);
  for (const key of Object.keys(manifest)) {
    assert.ok(allowed.has(key), `unexpected manifest key "${key}"`);
  }
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.devtools_page, 'devtools.html');
  assert.deepEqual(Object.keys(manifest.background), ['service_worker']);
});

test('page cannot probe or talk to the extension', () => {
  for (const key of [
    'content_scripts',
    'web_accessible_resources',
    'externally_connectable',
    'content_security_policy',
    'declarative_net_request',
    'optional_permissions'
  ]) {
    assert.equal(key in manifest, false, `${key} must stay absent`);
  }
});

test('API permissions stay within storage and alarms', () => {
  const allowed = new Set(['storage', 'alarms']);
  for (const permission of manifest.permissions || []) {
    assert.ok(allowed.has(permission), `permission "${permission}" is not reviewed`);
  }
});

test('host access is loopback only', () => {
  const hosts = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || [])
  ];
  assert.ok(hosts.length > 0);
  for (const host of hosts) {
    assert.ok(isLoopbackPattern(host), `host permission "${host}" is not loopback`);
  }
});

test('extension code has no page automation or extra network channels', () => {
  const forbidden = [
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bEventSource\b/, 'EventSource'],
    [/sendBeacon/, 'navigator.sendBeacon'],
    [/\beval\s*\(/, 'eval'],
    [/new\s+Function\s*\(/, 'new Function'],
    [/inspectedWindow\s*\.\s*(eval|reload)/, 'inspectedWindow.eval/reload'],
    [/chrome\s*\.\s*(scripting|debugger|tabs|webRequest|declarativeNetRequest|cookies|history|webNavigation|proxy|downloads)\b/, 'privileged chrome API'],
    [/\bdocument\s*\.\s*cookie\b/, 'document.cookie'],
    [/MutationObserver/, 'MutationObserver'],
    // The SVG namespace is an identifier, not an address; nothing is fetched from it.
    [/https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/]|www\.w3\.org\/2000\/svg')[a-z0-9.-]+/i, 'non-loopback URL literal']
  ];
  for (const { file, source } of scripts) {
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} uses ${label}`);
    }
  }
});

test('fetch is used only for local delivery and bundled policy', () => {
  const expected = {
    'background.js': 1,
    'shared/stickerPolicy.js': 1
  };
  for (const { file, source } of scripts) {
    const count = (source.match(/\bfetch\s*\(/g) || []).length;
    assert.equal(count, expected[file] || 0, `${file} fetch calls`);
  }

  const background = scripts.find(({ file }) => file === 'background.js').source;
  const targets = [...background.matchAll(/(?<!function )fetchWithTimeout\(\s*([^,]+),/g)]
    .map((match) => match[1].trim());
  assert.ok(targets.length > 0);
  for (const target of targets) {
    assert.match(target, /^`\$\{settings\.serverUrl\}\/api\//, `delivery target ${target}`);
  }
  assert.match(
    background,
    /serverUrl:\s*DeliveryPolicy\.normalizeServerUrl\(/,
    'server URL must pass the loopback normalizer'
  );
});

test('service worker imports only bundled scripts', () => {
  const background = scripts.find(({ file }) => file === 'background.js').source;
  const imports = background.match(/importScripts\(([\s\S]*?)\)/);
  assert.ok(imports);
  for (const [, target] of imports[1].matchAll(/'([^']+)'/g)) {
    assert.match(target, /^shared\/[a-zA-Z]+\.js$/);
    assert.ok(fs.existsSync(path.join(extensionRoot, target)), target);
  }
});

test('DevTools listener reads bodies only through getContent', () => {
  const devtools = scripts.find(({ file }) => file === 'devtools.js').source;
  const pipeline = scripts.find(({ file }) => file === 'shared/capturePipeline.js').source;
  assert.match(devtools, /onRequestFinished\.addListener/);
  assert.match(pipeline, /\.getContent\(/);
  for (const source of [devtools, pipeline]) {
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  }
});

test('extension pages load only bundled resources', () => {
  for (const { file, source } of pages) {
    assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i, `${file} has an inline script`);
    assert.doesNotMatch(source, /<(iframe|object|embed)\b/i, `${file} embeds a frame`);
    for (const [, attribute] of source.matchAll(/\b(?:src|href)="([^"]*)"/gi)) {
      assert.doesNotMatch(attribute, /^[a-z]+:|^\/\//i, `${file} references ${attribute}`);
    }
  }
});
