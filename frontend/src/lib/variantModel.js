// TikTok serves one sticker in several sizes under the same asset key:
// .../<32 hex>~tplv-<template>-<variant>.<ext> (e.g. video2sticker-mid).
// The key comes from the capture URL or from the name of a manually imported
// file (system tag "import:<name>"). Nothing is stored; it is derived on read.

const ASSET_PATTERN = /([0-9a-f]{32})~tplv-[a-z0-9]+-([a-z0-9-]+?)\.(?:a?webp|jpe?g|png|gif|avif)$/i;
const IMPORT_TAG = 'import:';

function parseAsset(value) {
  const match = ASSET_PATTERN.exec(String(value || ''));
  return match ? { key: match[1].toLowerCase(), variant: match[2].toLowerCase() } : null;
}

export function assetOf(sticker) {
  if (!sticker) return null;
  let path;
  try {
    path = sticker.originalUrl ? new URL(sticker.originalUrl).pathname : '';
  } catch {
    path = '';
  }
  const fromUrl = parseAsset(path);
  if (fromUrl) return fromUrl;
  for (const tag of sticker.tags || []) {
    if (typeof tag === 'string' && tag.startsWith(IMPORT_TAG)) {
      const fromName = parseAsset(tag.slice(IMPORT_TAG.length));
      if (fromName) return fromName;
    }
  }
  return null;
}

const area = (sticker) => (Number(sticker.width) || 0) * (Number(sticker.height) || 0);

// Larger pixel area wins; then more frames; then the newer capture.
function compareQuality(left, right) {
  return area(right) - area(left)
    || (Number(right.frames) || 1) - (Number(left.frames) || 1)
    || String(right.capturedAt || '').localeCompare(String(left.capturedAt || ''));
}

/** Map of sticker ID → { key, variant, siblingIds, bestId } for keys seen more than once. */
export function indexVariants(stickers) {
  const groups = new Map();
  for (const sticker of stickers || []) {
    const asset = assetOf(sticker);
    if (!asset) continue;
    if (!groups.has(asset.key)) groups.set(asset.key, []);
    groups.get(asset.key).push({ sticker, asset });
  }
  const index = new Map();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((left, right) => compareQuality(left.sticker, right.sticker));
    const bestId = ordered[0].sticker.id;
    const ids = members.map(({ sticker }) => sticker.id);
    for (const { sticker, asset } of members) {
      index.set(sticker.id, {
        key,
        variant: asset.variant,
        siblingIds: ids.filter((id) => id !== sticker.id),
        bestId
      });
    }
  }
  return index;
}

/** The better capture of the same TikTok sticker, if one has more pixels. */
export function betterVariant(sticker, index, stickersById) {
  const entry = sticker && index.get(sticker.id);
  if (!entry || entry.bestId === sticker.id) return null;
  const best = stickersById.get(entry.bestId);
  if (!best || area(best) <= area(sticker)) return null;
  return best;
}
