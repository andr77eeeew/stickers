(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.StickerPolicy = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  function asLowercaseStringArray(value, field) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`Sticker policy ${field} must be a non-empty array`);
    }
    return value.map((entry) => {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`Sticker policy ${field} contains an invalid value`);
      }
      return entry.trim().toLowerCase();
    });
  }

  function validatePolicy(raw) {
    if (!raw || typeof raw !== 'object' || raw.version !== 1) {
      throw new Error('Unsupported sticker policy version');
    }
    if (!Number.isSafeInteger(raw.maxBodyBytes) || raw.maxBodyBytes <= 0) {
      throw new Error('Sticker policy maxBodyBytes must be a positive integer');
    }

    const exact = asLowercaseStringArray(
      raw.allowedHosts && raw.allowedHosts.exact,
      'allowedHosts.exact'
    );
    const prefixRules = raw.allowedHosts && raw.allowedHosts.subdomainLabelPrefixes;
    if (!Array.isArray(prefixRules) || prefixRules.length === 0) {
      throw new Error('Sticker policy requires subdomainLabelPrefixes');
    }

    const subdomainLabelPrefixes = prefixRules.map((rule) => {
      const parentDomain =
        typeof rule.parentDomain === 'string'
          ? rule.parentDomain.trim().toLowerCase()
          : '';
      const prefix =
        typeof rule.prefix === 'string' ? rule.prefix.trim().toLowerCase() : '';
      if (
        !parentDomain ||
        !prefix ||
        parentDomain.startsWith('.') ||
        parentDomain.endsWith('.')
      ) {
        throw new Error('Sticker policy contains an invalid host prefix rule');
      }
      return Object.freeze({ parentDomain, prefix });
    });

    return Object.freeze({
      version: raw.version,
      maxBodyBytes: raw.maxBodyBytes,
      allowedMimeTypes: Object.freeze(
        asLowercaseStringArray(raw.allowedMimeTypes, 'allowedMimeTypes')
      ),
      allowedHosts: Object.freeze({
        exact: Object.freeze(exact),
        subdomainLabelPrefixes: Object.freeze(subdomainLabelPrefixes)
      }),
      allowedPathExtensions: Object.freeze(
        asLowercaseStringArray(
          raw.allowedPathExtensions,
          'allowedPathExtensions'
        )
      ),
      requiredPathMarkers: Object.freeze(
        asLowercaseStringArray(raw.requiredPathMarkers, 'requiredPathMarkers')
      ),
      rejectedPathMarkers: Object.freeze(
        asLowercaseStringArray(raw.rejectedPathMarkers, 'rejectedPathMarkers')
      ),
      contentTypeHints: Object.freeze(
        raw.contentTypeHints === undefined
          ? []
          : asLowercaseStringArray(raw.contentTypeHints, 'contentTypeHints')
      ),
      diagnosticHostSuffixes: Object.freeze(
        raw.diagnosticHostSuffixes === undefined
          ? []
          : asLowercaseStringArray(raw.diagnosticHostSuffixes, 'diagnosticHostSuffixes')
      )
    });
  }

  async function loadPolicy(resourceUrl) {
    const response = await fetch(resourceUrl, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Unable to load sticker policy: HTTP ${response.status}`);
    }
    return validatePolicy(await response.json());
  }

  function normalizeMimeType(value) {
    if (typeof value !== 'string') return '';
    const normalized = value.split(';', 1)[0].trim().toLowerCase();
    if (normalized === 'image/jpg') return 'image/jpeg';
    if (normalized === 'image/awebp') return 'image/webp';
    return normalized;
  }

  function matchesAllowedHost(hostname, policy) {
    const host = String(hostname || '').toLowerCase();
    if (!host || host.endsWith('.')) return false;
    if (policy.allowedHosts.exact.includes(host)) return true;

    return policy.allowedHosts.subdomainLabelPrefixes.some((rule) => {
      const suffix = `.${rule.parentDomain}`;
      if (!host.endsWith(suffix)) return false;
      const label = host.slice(0, -suffix.length);
      return (
        !label.includes('.') &&
        label.startsWith(rule.prefix) &&
        label.length > rule.prefix.length
      );
    });
  }

  // URL-only part of the policy: host, path markers and extension.
  function classifyStickerUrl(sourceUrl, policy) {
    let parsed;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      return { allowed: false, reason: 'invalid_url' };
    }

    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port
    ) {
      return { allowed: false, reason: 'unsafe_url' };
    }
    if (!matchesAllowedHost(parsed.hostname, policy)) {
      return { allowed: false, reason: 'host_not_allowed' };
    }

    let path;
    try {
      path = decodeURIComponent(parsed.pathname).toLowerCase();
    } catch {
      return { allowed: false, reason: 'invalid_path_encoding' };
    }

    if (policy.rejectedPathMarkers.some((marker) => path.includes(marker))) {
      return { allowed: false, reason: 'rejected_path' };
    }
    if (
      !policy.allowedPathExtensions.some((extension) =>
        path.endsWith(extension)
      )
    ) {
      return { allowed: false, reason: 'unsupported_extension' };
    }
    if (!policy.requiredPathMarkers.some((marker) => path.includes(marker))) {
      return { allowed: false, reason: 'path_not_sticker_specific' };
    }

    return {
      allowed: true,
      sourceUrl: `${parsed.origin}${parsed.pathname}`
    };
  }

  // The Content-Type header is only a hint: CDNs also answer with
  // octet-stream or no type at all. An allowed image type is kept as the
  // expected type; a generic hint leaves it empty until bytes are checked.
  function classifyStickerResource(sourceUrl, mimeType, policy) {
    const url = classifyStickerUrl(sourceUrl, policy);
    if (!url.allowed) return url;

    const normalizedMimeType = normalizeMimeType(mimeType);
    if (policy.allowedMimeTypes.includes(normalizedMimeType)) {
      return { ...url, mimeType: normalizedMimeType };
    }
    const hints = policy.contentTypeHints || [];
    if (!normalizedMimeType || hints.includes(normalizedMimeType)) {
      return { ...url, mimeType: '' };
    }
    return { allowed: false, reason: 'mime_not_allowed' };
  }

  return {
    validatePolicy,
    loadPolicy,
    normalizeMimeType,
    matchesAllowedHost,
    classifyStickerUrl,
    classifyStickerResource
  };
});
