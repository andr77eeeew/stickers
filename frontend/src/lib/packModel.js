import { STATE_LABELS, getStickerState } from './stickerModel.js';

// Mirrors lib/packStore.js. Telegram: up to 120 stickers per set, 1–20 emoji per sticker.
export const PACK_LIMITS = { maxPacks: 50, maxStickers: 120, maxEmoji: 20, titleLength: 64 };

// The official @Stickers bot keeps static and video stickers in separate packs.
export const BOT_COMMAND = { static: '/newpack', video: '/newvideo' };
export const KIND_LABELS = { static: 'Static pack', video: 'Video pack' };

export const QUICK_EMOJI = ['😀', '😂', '🥰', '😎', '🤔', '😢', '😭', '😡', '👍', '👎', '👏', '🙏', '🔥', '❤️', '🎉', '💀'];

const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

/** Returns { emoji, error }; the server applies the same rules. */
export const parseEmojiInput = (text) => {
  const value = String(text ?? '');
  const segments = graphemes ? [...graphemes.segment(value)].map((part) => part.segment) : Array.from(value);
  const emoji = [];
  for (const segment of segments) {
    if (/^[\s,]+$/u.test(segment)) continue;
    if (!EMOJI_GRAPHEME.test(segment)) return { emoji, error: `“${segment}” is not an emoji.` };
    if (!emoji.includes(segment)) emoji.push(segment);
  }
  if (emoji.length > PACK_LIMITS.maxEmoji) {
    return { emoji, error: `A sticker can have at most ${PACK_LIMITS.maxEmoji} emoji.` };
  }
  return { emoji, error: null };
};

export const stickerKind = (sticker) => (sticker?.isAnimated ? 'video' : 'static');

/** The pack's kind comes from its stickers; an empty pack accepts either. */
export const getPackKind = (pack, stickersById) => {
  for (const item of pack?.items || []) {
    const sticker = stickersById.get(item.stickerId);
    if (sticker) return stickerKind(sticker);
  }
  return null;
};

export const canAddToPack = (pack, sticker, stickersById) => {
  if (!pack) return { ok: false, reason: 'No pack yet.' };
  if (pack.items.some((item) => item.stickerId === sticker.id)) return { ok: false, reason: 'Already in this pack.' };
  if (pack.items.length >= PACK_LIMITS.maxStickers) {
    return { ok: false, reason: `A pack holds at most ${PACK_LIMITS.maxStickers} stickers.` };
  }
  const kind = getPackKind(pack, stickersById);
  if (kind && kind !== stickerKind(sticker)) {
    return {
      ok: false,
      reason: kind === 'video'
        ? 'This is a video pack. Static stickers go into a separate pack in @Stickers.'
        : 'This is a static pack. Video stickers go into a separate pack in @Stickers.'
    };
  }
  return { ok: true, reason: null };
};

/** Problems of one pack row, in the order the user should fix them. */
export const getItemProblems = (item, sticker) => {
  if (!sticker) return [{ code: 'missing', label: 'Not in library' }];
  const problems = [];
  if (!item.emoji.length) problems.push({ code: 'no_emoji', label: 'No emoji' });
  const state = getStickerState(sticker);
  if (state !== 'ready') problems.push({ code: 'not_ready', label: STATE_LABELS[state] || 'Not ready' });
  return problems;
};

/**
 * Everything the pack screen and the draft bar need from one snapshot.
 * `exportBlockedReason` is null only when the server would accept the export.
 */
export const summarizePack = (pack, stickersById) => {
  const summary = {
    count: pack.items.length, kind: getPackKind(pack, stickersById),
    missingEmoji: 0, notReady: 0, missing: 0, mixed: false, exportBlockedReason: null
  };
  const kinds = new Set();
  for (const item of pack.items) {
    const sticker = stickersById.get(item.stickerId);
    if (sticker) kinds.add(stickerKind(sticker));
    for (const problem of getItemProblems(item, sticker)) {
      if (problem.code === 'missing') summary.missing += 1;
      if (problem.code === 'no_emoji') summary.missingEmoji += 1;
      if (problem.code === 'not_ready') summary.notReady += 1;
    }
  }
  summary.mixed = kinds.size > 1;
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (!summary.count) summary.exportBlockedReason = 'Add stickers to export the pack.';
  else if (summary.mixed) summary.exportBlockedReason = 'Static and video stickers go into separate packs.';
  else if (summary.missing) summary.exportBlockedReason = `${plural(summary.missing, 'sticker')} no longer in the library.`;
  else if (summary.missingEmoji) summary.exportBlockedReason = `${plural(summary.missingEmoji, 'sticker')} without emoji.`;
  else if (summary.notReady) summary.exportBlockedReason = `${plural(summary.notReady, 'sticker')} not ready for Telegram.`;
  return summary;
};

/** stickerId → { emoji, inActive, packs: [{ id, title }] } across all packs. */
export const getMembership = (packs, activePackId) => {
  const membership = new Map();
  for (const pack of packs) {
    for (const item of pack.items) {
      const entry = membership.get(item.stickerId) || { emoji: [], inActive: false, packs: [] };
      entry.packs.push({ id: pack.id, title: pack.title });
      if (pack.id === activePackId) {
        entry.inActive = true;
        entry.emoji = item.emoji;
      }
      membership.set(item.stickerId, entry);
    }
  }
  return membership;
};

export const moveItem = (items, from, to) => {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};
