const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Packs are ordered sets of sticker IDs with emoji, stored apart from the
// sticker database. Removing a pack never touches stickers or media files.
const PACK_SCHEMA_VERSION = 1;
const PACK_LIMITS = {
  maxPacks: 50,
  // Telegram regular sticker sets hold up to 120 stickers.
  maxStickers: 120,
  // Telegram accepts 1–20 emoji per sticker.
  maxEmoji: 20,
  titleLength: 64
};
const PACK_ID_PATTERN = /^p_[a-f0-9]{12}$/;
const STICKER_ID_PATTERN = /^[a-f0-9]{64}$/;
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

class PackError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Accepts a string or an array of strings; returns unique emoji in input order. */
function parseEmojiList(value) {
  if (value === undefined || value === null) return [];
  const text = Array.isArray(value) ? value.map((part) => String(part)).join('') : String(value);
  if (text.length > 400) throw new PackError('Emoji list is too long.');
  const emoji = [];
  for (const { segment } of graphemes.segment(text)) {
    if (/^[\s,]+$/u.test(segment)) continue;
    if (!EMOJI_GRAPHEME.test(segment)) throw new PackError(`“${segment}” is not an emoji.`);
    if (!emoji.includes(segment)) emoji.push(segment);
  }
  if (emoji.length > PACK_LIMITS.maxEmoji) {
    throw new PackError(`A sticker can have at most ${PACK_LIMITS.maxEmoji} emoji.`);
  }
  return emoji;
}

function parseTitle(value) {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!title) throw new PackError('Pack title is required.');
  if (title.length > PACK_LIMITS.titleLength) {
    throw new PackError(`Pack title can be at most ${PACK_LIMITS.titleLength} characters.`);
  }
  return title;
}

function emptyDocument() {
  return { schemaVersion: PACK_SCHEMA_VERSION, activePackId: null, packs: [] };
}

function normalizeDocument(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.packs)) {
    throw new Error('Packs file has no packs array.');
  }
  if (parsed.schemaVersion !== PACK_SCHEMA_VERSION) {
    throw new Error(`Unsupported packs schema version: ${parsed.schemaVersion}`);
  }
  const packs = parsed.packs.map((pack) => {
    if (!pack || !PACK_ID_PATTERN.test(pack.id) || !Array.isArray(pack.items)) {
      throw new Error('Packs file contains an invalid pack.');
    }
    return {
      id: pack.id,
      title: String(pack.title || 'Untitled pack'),
      createdAt: pack.createdAt || null,
      updatedAt: pack.updatedAt || null,
      revision: Number.isInteger(pack.revision) ? pack.revision : 1,
      items: pack.items
        .filter((item) => item && STICKER_ID_PATTERN.test(item.stickerId))
        .map((item) => ({
          stickerId: item.stickerId,
          emoji: Array.isArray(item.emoji) ? item.emoji.map(String) : []
        }))
    };
  });
  const activePackId = packs.some((pack) => pack.id === parsed.activePackId) ? parsed.activePackId : null;
  return { schemaVersion: PACK_SCHEMA_VERSION, activePackId, packs };
}

class PackStore {
  /**
   * @param {string} filePath
   * @param {{ beforeFirstWrite?: () => void }} options Runs once before the
   *   file is created for the first time; a throw aborts the write.
   */
  constructor(filePath, { beforeFirstWrite = null } = {}) {
    this.filePath = path.resolve(filePath);
    this.backupPath = path.join(path.dirname(this.filePath), 'packs.backup.json');
    this.beforeFirstWrite = beforeFirstWrite;
    this.document = emptyDocument();
    this.loadError = null;
    this.recoveredFromBackup = false;
    this.skipNextBackup = false;
  }

  load() {
    this.loadError = null;
    this.recoveredFromBackup = false;
    if (!fs.existsSync(this.filePath)) {
      this.document = emptyDocument();
      return this.document;
    }
    try {
      this.document = normalizeDocument(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      return this.document;
    } catch (primaryError) {
      try {
        this.document = normalizeDocument(JSON.parse(fs.readFileSync(this.backupPath, 'utf8')));
        this.recoveredFromBackup = true;
        // Keep the unreadable file next to the library before the next save replaces it.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(this.filePath, path.join(path.dirname(this.filePath), `packs.corrupt-${stamp}.json`));
        this.skipNextBackup = true;
        return this.document;
      } catch (_) {
        // Neither file is usable: keep both untouched and refuse writes.
        this.document = emptyDocument();
        this.loadError = primaryError.message;
        return this.document;
      }
    }
  }

  snapshot() {
    return {
      packs: this.document.packs,
      activePackId: this.document.activePackId,
      limits: PACK_LIMITS,
      loadError: this.loadError
    };
  }

  getPack(id) {
    const pack = this.document.packs.find((item) => item.id === id);
    if (!pack) throw new PackError('Pack not found.', 404);
    return pack;
  }

  commit(next) {
    if (this.loadError) {
      throw new PackError('The packs file could not be read, so it is left untouched and packs are read-only.', 503);
    }
    if (!fs.existsSync(this.filePath) && this.beforeFirstWrite) this.beforeFirstWrite();

    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.packs.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    let fd = null;
    try {
      fd = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      if (fs.existsSync(this.filePath) && !this.skipNextBackup) fs.copyFileSync(this.filePath, this.backupPath);
      fs.renameSync(temporaryPath, this.filePath);
      this.skipNextBackup = false;
      this.document = next;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) { /* already closed */ }
      }
      if (fs.existsSync(temporaryPath)) {
        try { fs.unlinkSync(temporaryPath); } catch (_) { /* uniquely named; safe to leave */ }
      }
    }
  }

  create(title) {
    if (this.document.packs.length >= PACK_LIMITS.maxPacks) {
      throw new PackError(`You can keep at most ${PACK_LIMITS.maxPacks} packs.`, 409);
    }
    const now = new Date().toISOString();
    const pack = {
      id: `p_${crypto.randomBytes(6).toString('hex')}`,
      title: parseTitle(title),
      createdAt: now,
      updatedAt: now,
      revision: 1,
      items: []
    };
    this.commit({ ...this.document, activePackId: pack.id, packs: [...this.document.packs, pack] });
    return pack;
  }

  /**
   * Replaces title and/or ordered items. `revision` must match the stored one
   * so two tabs never silently overwrite each other.
   * `resolveSticker(id)` returns { isAnimated } for known stickers or null.
   */
  update(id, { title, items, revision }, { resolveSticker }) {
    const current = this.getPack(id);
    if (revision !== current.revision) {
      throw new PackError('This pack was changed elsewhere. The latest version is shown.', 409, { pack: current });
    }
    const next = { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    if (title !== undefined) next.title = parseTitle(title);
    if (items !== undefined) next.items = this.parseItems(items, current, resolveSticker);
    this.commit({
      ...this.document,
      packs: this.document.packs.map((pack) => (pack.id === id ? next : pack))
    });
    return next;
  }

  parseItems(items, current, resolveSticker) {
    if (!Array.isArray(items)) throw new PackError('items must be an array.');
    if (items.length > PACK_LIMITS.maxStickers) {
      throw new PackError(`A Telegram sticker pack holds at most ${PACK_LIMITS.maxStickers} stickers.`);
    }
    const existing = new Set(current.items.map((item) => item.stickerId));
    const seen = new Set();
    const kinds = new Set();
    const parsed = items.map((item) => {
      const stickerId = String(item?.stickerId || '').toLowerCase();
      if (!STICKER_ID_PATTERN.test(stickerId)) throw new PackError('Every item needs a 64-character sticker ID.');
      if (seen.has(stickerId)) throw new PackError('A sticker can appear in a pack only once.');
      seen.add(stickerId);
      const sticker = resolveSticker(stickerId);
      // Items already in the pack stay even if their record is gone, so nothing is lost silently.
      if (!sticker && !existing.has(stickerId)) throw new PackError('Sticker not found in the library.', 404);
      if (sticker) kinds.add(sticker.isAnimated ? 'video' : 'static');
      return { stickerId, emoji: parseEmojiList(item.emoji) };
    });
    if (kinds.size > 1) {
      throw new PackError('The @Stickers bot keeps static and video stickers in separate packs. Use another pack for this sticker.');
    }
    return parsed;
  }

  activate(id) {
    this.getPack(id);
    this.commit({ ...this.document, activePackId: id });
  }

  /** Removes the pack record only; stickers and files are untouched. */
  remove(id) {
    this.getPack(id);
    const packs = this.document.packs.filter((pack) => pack.id !== id);
    const activePackId = this.document.activePackId === id ? (packs[packs.length - 1]?.id || null) : this.document.activePackId;
    this.commit({ ...this.document, activePackId, packs });
  }
}

module.exports = { PackStore, PackError, PACK_LIMITS, PACK_ID_PATTERN, parseEmojiList };
