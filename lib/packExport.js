const { createStoredZip } = require('./zipWriter');
const { PACK_LIMITS } = require('./packStore');

// Telegram limits for regular stickers sent through the @Stickers bot.
const LIMIT_BYTES = { static: 512 * 1024, video: 256 * 1024 };
const BOT_COMMAND = { static: '/newpack', video: '/newvideo' };

const pad = (value) => String(value).padStart(3, '0');

/**
 * Lists everything that blocks an export. Each problem names the pack
 * position so the UI can point at the row. `outputSize(sticker)` returns the
 * measured size of the converted file or null when it is missing.
 */
function findExportProblems(pack, { resolveSticker, outputSize }) {
  const problems = [];
  if (!pack.items.length) problems.push({ code: 'empty', message: 'The pack has no stickers.' });
  if (pack.items.length > PACK_LIMITS.maxStickers) {
    problems.push({ code: 'too_many', message: `A pack holds at most ${PACK_LIMITS.maxStickers} stickers.` });
  }
  const kinds = new Set();
  pack.items.forEach((item, index) => {
    const position = index + 1;
    const add = (code, message) => problems.push({ code, position, stickerId: item.stickerId, message });
    const sticker = resolveSticker(item.stickerId);
    if (!sticker) {
      add('missing', 'The sticker is no longer in the library.');
      return;
    }
    const kind = sticker.isAnimated ? 'video' : 'static';
    kinds.add(kind);
    if (!item.emoji.length) add('no_emoji', 'Choose at least one emoji.');
    if (sticker.status !== 'converted' || !sticker.convertedPath) {
      add('not_converted', 'Not converted for Telegram yet.');
      return;
    }
    const extension = String(sticker.convertedPath).split('.').pop().toLowerCase();
    if (extension !== (kind === 'video' ? 'webm' : 'webp')) add('format', `Unexpected output format .${extension}.`);
    const size = outputSize(sticker);
    if (size === null) add('output_missing', 'The converted file is missing on disk.');
    else if (size > LIMIT_BYTES[kind]) add('over_limit', `The file is larger than ${LIMIT_BYTES[kind] / 1024} KB.`);
  });
  if (kinds.size > 1) {
    problems.push({ code: 'mixed', message: 'Static and video stickers go into separate packs in @Stickers.' });
  }
  return problems;
}

function fileNameFor(position, sticker) {
  return `${pad(position)}_${sticker.id.slice(0, 8)}.${sticker.isAnimated ? 'webm' : 'webp'}`;
}

function buildCheatSheet(pack, rows, kind, exportedAt) {
  const kindLabel = kind === 'video' ? 'video' : 'static';
  const fileWidth = Math.max(4, ...rows.map((row) => row.file.length));
  const lines = [
    pack.title,
    `${rows.length} ${kindLabel} sticker${rows.length === 1 ? '' : 's'} · exported ${exportedAt.slice(0, 10)}`,
    '',
    'Publish manually in Telegram:',
    `1. Open @Stickers and send ${BOT_COMMAND[kind]}.`,
    '2. Send the pack title.',
    '3. For each row, in order: send the file as a document (not as a photo), then send its emoji.',
    '4. Send /publish, choose an icon or send /skip, then choose the short name for the link.',
    '',
    `No.  ${'File'.padEnd(fileWidth)}  Emoji`,
    ...rows.map((row) => `${pad(row.position)}  ${row.file.padEnd(fileWidth)}  ${row.emoji.join(' ')}`),
    ''
  ];
  return lines.join('\r\n');
}

function zipFileName(title) {
  const slug = title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').toLowerCase().slice(0, 48);
  return `${slug || 'sticker-pack'}.zip`;
}

/**
 * Builds the export ZIP or returns the blocking problems. Never writes to disk.
 * `readOutput(sticker)` returns the converted file as a Buffer.
 */
function buildPackExport(pack, { resolveSticker, outputSize, readOutput, now = new Date() }) {
  const problems = findExportProblems(pack, { resolveSticker, outputSize });
  if (problems.length) return { problems };

  const exportedAt = now.toISOString();
  const rows = pack.items.map((item, index) => {
    const sticker = resolveSticker(item.stickerId);
    return { position: index + 1, sticker, file: fileNameFor(index + 1, sticker), emoji: item.emoji };
  });
  const kind = rows[0].sticker.isAnimated ? 'video' : 'static';
  const entries = rows.map((row) => ({ name: row.file, data: readOutput(row.sticker) }));
  entries.push({ name: 'pack.txt', data: Buffer.from(`﻿${buildCheatSheet(pack, rows, kind, exportedAt)}`, 'utf8') });

  return {
    problems: [],
    fileName: zipFileName(pack.title),
    kind,
    count: rows.length,
    zip: createStoredZip(entries, { date: now })
  };
}

module.exports = { buildPackExport, findExportProblems, LIMIT_BYTES, BOT_COMMAND };
