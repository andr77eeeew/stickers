const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DEFAULT_POLICY_PATH = path.join(__dirname, '..', 'extension', 'shared', 'sticker-policy.json');

function normalizeMimeType(value) {
  const mime = String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return mime === 'image/awebp' ? 'image/webp' : mime;
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('Sticker policy must be an object.');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new Error('Sticker policy version must be a positive integer.');
  }
  if (!Number.isSafeInteger(policy.maxBodyBytes) || policy.maxBodyBytes < 1024) {
    throw new Error('Sticker policy maxBodyBytes is invalid.');
  }
  if (!Array.isArray(policy.allowedMimeTypes) || policy.allowedMimeTypes.length === 0) {
    throw new Error('Sticker policy must define allowedMimeTypes.');
  }
  if (!policy.allowedHosts || !Array.isArray(policy.allowedHosts.exact)) {
    throw new Error('Sticker policy must define allowedHosts.exact.');
  }
  if (!Array.isArray(policy.allowedHosts.subdomainLabelPrefixes)) {
    throw new Error('Sticker policy must define allowedHosts.subdomainLabelPrefixes.');
  }
  for (const field of ['allowedPathExtensions', 'requiredPathMarkers', 'rejectedPathMarkers']) {
    if (!Array.isArray(policy[field])) throw new Error(`Sticker policy must define ${field}.`);
  }
  return Object.freeze({
    ...policy,
    allowedMimeTypes: Object.freeze(policy.allowedMimeTypes.map(normalizeMimeType)),
    allowedHosts: Object.freeze({
      exact: Object.freeze(policy.allowedHosts.exact.map((value) => String(value).toLowerCase())),
      subdomainLabelPrefixes: Object.freeze(
        policy.allowedHosts.subdomainLabelPrefixes.map((rule) =>
          Object.freeze({
            parentDomain: String(rule.parentDomain || '').toLowerCase(),
            prefix: String(rule.prefix || '').toLowerCase()
          })
        )
      )
    }),
    allowedPathExtensions: Object.freeze(
      policy.allowedPathExtensions.map((value) => String(value).toLowerCase())
    ),
    requiredPathMarkers: Object.freeze(
      policy.requiredPathMarkers.map((value) => String(value).toLowerCase())
    ),
    rejectedPathMarkers: Object.freeze(
      policy.rejectedPathMarkers.map((value) => String(value).toLowerCase())
    )
  });
}

function loadStickerPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = fs.readFileSync(policyPath, 'utf8');
  return validatePolicy(JSON.parse(raw));
}

function hostAllowed(host, allowedHosts) {
  if (allowedHosts.exact.includes(host)) return true;
  return allowedHosts.subdomainLabelPrefixes.some(({ parentDomain, prefix }) => {
    if (!parentDomain || !prefix || !host.endsWith(`.${parentDomain}`)) return false;
    const label = host.slice(0, -(parentDomain.length + 1));
    return !label.includes('.') && label.startsWith(prefix);
  });
}

function sanitizeSourceUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS sticker URLs are accepted.');
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function validateStickerUrl(value, policy) {
  if (!value || typeof value !== 'string') return { ok: false, reason: 'missing_url' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'url_credentials_rejected' };

  const host = parsed.hostname.toLowerCase();
  const pathName = parsed.pathname.toLowerCase();
  if (!hostAllowed(host, policy.allowedHosts)) return { ok: false, reason: 'host_rejected' };
  if (policy.rejectedPathMarkers.some((marker) => marker && pathName.includes(marker))) {
    return { ok: false, reason: 'path_rejected' };
  }
  if (
    policy.allowedPathExtensions.length > 0 &&
    !policy.allowedPathExtensions.some((extension) => pathName.endsWith(extension))
  ) {
    return { ok: false, reason: 'extension_rejected' };
  }
  if (
    policy.requiredPathMarkers.length > 0 &&
    !policy.requiredPathMarkers.some((marker) => marker && pathName.includes(marker))
  ) {
    return { ok: false, reason: 'marker_missing' };
  }

  return {
    ok: true,
    canonicalUrl: sanitizeSourceUrl(parsed.toString()),
    host
  };
}

function detectMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  const gif = buffer.subarray(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

function decodeBase64Strict(value, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('contentBase64 is required.');
  const compact = value.replace(/\s/g, '');
  if (compact.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error('Sticker body exceeds the configured byte limit.');
  }
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('contentBase64 is malformed.');
  }
  const buffer = Buffer.from(compact, 'base64');
  if (!buffer.length) throw new Error('Sticker body is empty.');
  if (buffer.length > maxBytes) throw new Error('Sticker body exceeds the configured byte limit.');
  const normalizedInput = compact.replace(/=+$/, '');
  if (buffer.toString('base64').replace(/=+$/, '') !== normalizedInput) {
    throw new Error('contentBase64 is malformed.');
  }
  return buffer;
}

async function validateStickerPayload({
  sourceUrl,
  mimeType,
  contentBase64,
  buffer,
  policy,
  maxDecodedPixels
}) {
  const urlResult = validateStickerUrl(sourceUrl, policy);
  if (!urlResult.ok) {
    const error = new Error(`Sticker URL rejected: ${urlResult.reason}.`);
    error.code = 'URL_REJECTED';
    throw error;
  }

  const declaredMime = normalizeMimeType(mimeType);
  if (!policy.allowedMimeTypes.includes(declaredMime)) {
    const error = new Error('Sticker MIME type is not allowed.');
    error.code = 'MIME_REJECTED';
    throw error;
  }

  const body = buffer || decodeBase64Strict(contentBase64, policy.maxBodyBytes);
  if (!Buffer.isBuffer(body) || !body.length || body.length > policy.maxBodyBytes) {
    const error = new Error('Sticker body is empty or too large.');
    error.code = 'BODY_REJECTED';
    throw error;
  }

  const detectedMime = detectMimeType(body);
  if (!detectedMime || detectedMime !== declaredMime) {
    const error = new Error('Declared MIME type does not match sticker magic bytes.');
    error.code = 'MAGIC_MISMATCH';
    throw error;
  }

  let metadata;
  try {
    metadata = await sharp(body, {
      animated: true,
      limitInputPixels: maxDecodedPixels
    }).metadata();
  } catch (_) {
    const error = new Error('Sticker bytes are not a valid decodable image.');
    error.code = 'IMAGE_INVALID';
    throw error;
  }

  const width = Number(metadata.width) || 0;
  const height = Number(metadata.pageHeight || metadata.height) || 0;
  const pages = Math.max(1, Number(metadata.pages) || 1);
  if (!width || !height || width * height * pages > maxDecodedPixels) {
    const error = new Error('Decoded sticker dimensions exceed the configured pixel limit.');
    error.code = 'PIXEL_LIMIT';
    throw error;
  }
  if (normalizeMimeType(`image/${metadata.format}`) !== declaredMime) {
    const error = new Error('Decoded image format does not match declared MIME type.');
    error.code = 'FORMAT_MISMATCH';
    throw error;
  }

  return {
    buffer: body,
    canonicalUrl: urlResult.canonicalUrl,
    detectedMime,
    metadata
  };
}

module.exports = {
  DEFAULT_POLICY_PATH,
  normalizeMimeType,
  validatePolicy,
  loadStickerPolicy,
  validateStickerUrl,
  sanitizeSourceUrl,
  detectMimeType,
  decodeBase64Strict,
  validateStickerPayload
};