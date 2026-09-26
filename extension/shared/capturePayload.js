(function (root, factory) {
  const policyApi =
    typeof module === 'object' && module.exports
      ? require('./stickerPolicy.js')
      : root.StickerPolicy;
  const api = factory(policyApi);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CapturePayload = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function (StickerPolicy) {
  'use strict';

  function normalizeBase64(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, '');
    if (
      !normalized ||
      normalized.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
      return null;
    }
    return normalized;
  }

  function base64ByteLength(value) {
    const normalized = normalizeBase64(value);
    if (!normalized) return -1;
    let padding = 0;
    if (normalized.endsWith('==')) padding = 2;
    else if (normalized.endsWith('=')) padding = 1;
    return (normalized.length / 4) * 3 - padding;
  }

  function binaryStringToBase64(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) > 255) return null;
    }
    return btoa(value);
  }

  function contentToBase64(content, encoding, maxBytes) {
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, reason: 'body_unavailable' };
    }

    const normalizedEncoding = String(encoding || '').trim().toLowerCase();
    let contentBase64;
    if (normalizedEncoding === 'base64') {
      contentBase64 = normalizeBase64(content);
    } else if (!normalizedEncoding || normalizedEncoding === 'binary') {
      contentBase64 = binaryStringToBase64(content);
    } else {
      return { ok: false, reason: 'unsupported_body_encoding' };
    }

    if (!contentBase64) {
      return { ok: false, reason: 'invalid_body_encoding' };
    }
    const byteLength = base64ByteLength(contentBase64);
    if (byteLength <= 0) {
      return { ok: false, reason: 'body_unavailable' };
    }
    if (Number.isFinite(maxBytes) && byteLength > maxBytes) {
      return { ok: false, reason: 'body_too_large' };
    }
    return { ok: true, contentBase64, byteLength };
  }

  function base64ToBytes(value) {
    const normalized = normalizeBase64(value);
    if (!normalized) throw new Error('Invalid base64');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function asciiAt(bytes, start, expected) {
    if (bytes.length < start + expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (bytes[start + index] !== expected.charCodeAt(index)) return false;
    }
    return true;
  }

  function detectImageMime(bytes) {
    if (
      bytes.length >= 12 &&
      asciiAt(bytes, 0, 'RIFF') &&
      asciiAt(bytes, 8, 'WEBP')
    ) {
      return 'image/webp';
    }
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    ) {
      return 'image/jpeg';
    }
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      asciiAt(bytes, 1, 'PNG\r\n\x1a\n')
    ) {
      return 'image/png';
    }
    if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
      return 'image/gif';
    }
    return '';
  }

  // Magic bytes need only the first 12 bytes (16 base64 characters).
  function detectBase64ImageMime(contentBase64) {
    const normalized = normalizeBase64(contentBase64);
    if (!normalized || normalized.length < 16) return '';
    return detectImageMime(base64ToBytes(normalized.slice(0, 16)));
  }

  function validateCapturePayload(payload, policy) {
    if (!payload || payload.source !== 'devtools') {
      return { ok: false, reason: 'invalid_source' };
    }

    const resource = StickerPolicy.classifyStickerResource(
      payload.sourceUrl,
      payload.mimeType,
      policy
    );
    if (!resource.allowed) {
      return { ok: false, reason: resource.reason };
    }

    const encoded = contentToBase64(
      payload.contentBase64,
      'base64',
      policy.maxBodyBytes
    );
    if (!encoded.ok) return encoded;

    let bytes;
    try {
      bytes = base64ToBytes(encoded.contentBase64);
    } catch {
      return { ok: false, reason: 'invalid_body_encoding' };
    }

    const detectedMimeType = detectImageMime(bytes);
    if (
      !detectedMimeType ||
      !policy.allowedMimeTypes.includes(detectedMimeType) ||
      (resource.mimeType && detectedMimeType !== resource.mimeType)
    ) {
      return { ok: false, reason: 'content_type_mismatch' };
    }

    const parsedObservedAt = Date.parse(payload.observedAt);
    const observedAt = Number.isFinite(parsedObservedAt)
      ? new Date(parsedObservedAt).toISOString()
      : new Date().toISOString();

    return {
      ok: true,
      bytes,
      payload: {
        source: 'devtools',
        sourceUrl: resource.sourceUrl,
        mimeType: detectedMimeType,
        contentBase64: encoded.contentBase64,
        observedAt
      }
    };
  }

  return {
    normalizeBase64,
    base64ByteLength,
    contentToBase64,
    base64ToBytes,
    detectImageMime,
    detectBase64ImageMime,
    validateCapturePayload
  };
});
