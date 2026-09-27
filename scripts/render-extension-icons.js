'use strict';

// Renders the extension icons (extension/icons/icon-<size>.png) from the
// dashboard brand mark: the lucide "sparkles" icon on a dark rounded square.
// Run after changing the artwork: node scripts/render-extension-icons.js
// Needs Google Chrome for playwright-core, like the e2e tests.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const outputDir = path.join(__dirname, '..', 'extension', 'icons');
const BACKGROUND = '#111820';
const FOREGROUND = '#FFFFFF';
const STAR = 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z';

// Large sizes use the outlined brand mark; at 16 px strokes blur, so the star
// is filled and the small accents are dropped.
function iconSvg(size) {
  const small = size <= 16;
  const art = small
    ? `<g transform="translate(14 14) scale(4.2)"><path d="${STAR}" fill="${FOREGROUND}" stroke="${FOREGROUND}" stroke-width="1.2" stroke-linejoin="round"/></g>`
    : `<g transform="translate(24 24) scale(3.333)" fill="none" stroke="${FOREGROUND}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="${STAR}"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>
      </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
    <rect x="${small ? 0 : 6}" y="${small ? 0 : 6}" width="${small ? 128 : 116}" height="${small ? 128 : 116}" rx="${small ? 28 : 26}" fill="${BACKGROUND}"/>
    ${art}
  </svg>`;
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const size of [16, 32, 48, 128]) {
      await page.setContent(`<body style="margin:0;background:transparent">${iconSvg(size)}</body>`);
      const svg = await page.$('svg');
      await svg.screenshot({ path: path.join(outputDir, `icon-${size}.png`), omitBackground: true });
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
