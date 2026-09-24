/**
 * Backward-compatible wrapper around the single JSON sticker policy.
 * New code should import lib/stickerPolicy directly.
 */
const {
  loadStickerPolicy,
  validateStickerUrl,
  sanitizeSourceUrl
} = require('./stickerPolicy');

const policy = loadStickerPolicy();

function isTikTokDmStickerUrl(url) {
  return validateStickerUrl(url, policy).ok;
}

function canonicalizeStickerUrl(url) {
  try {
    return sanitizeSourceUrl(url);
  } catch (_) {
    return String(url || '');
  }
}

module.exports = {
  isTikTokDmStickerUrl,
  canonicalizeStickerUrl
};
