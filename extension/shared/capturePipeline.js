(function (root, factory) {
  const isModule = typeof module === 'object' && module.exports;
  const api = factory(
    isModule ? require('./stickerPolicy.js') : root.StickerPolicy,
    isModule ? require('./capturePayload.js') : root.CapturePayload
  );
  if (isModule) {
    module.exports = api;
  } else {
    root.CapturePipeline = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function (StickerPolicy, CapturePayload) {
  'use strict';

  // One pipeline for the live DevTools listener and for the explicit
  // "Capture from Network log" action. It only reads bodies DevTools already
  // holds; it never issues a request of its own.

  const THUMBNAIL_SIZE = 96;
  const THUMBNAIL_MAX_LENGTH = 40000;
  const IMAGE_PATH = /\.(a?webp|jpe?g|png|gif|avif|heic)$/i;

  function getResponseMimeType(response) {
    const direct =
      response &&
      response.content &&
      typeof response.content.mimeType === 'string'
        ? response.content.mimeType
        : '';
    if (direct) return direct;

    const header = (response && response.headers || []).find(
      (entry) =>
        entry &&
        typeof entry.name === 'string' &&
        entry.name.toLowerCase() === 'content-type'
    );
    return header && header.value ? header.value : '';
  }

  function classifySite(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return 'unknown';
    }
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol === 'https:' &&
      (host === 'tiktok.com' || host.endsWith('.tiktok.com'))
    ) {
      return 'tiktok';
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? 'other'
      : 'unknown';
  }

  // Site of the inspected tab from DevTools metadata only, never page code.
  function detectInspectedSite(inspectedWindow) {
    return new Promise((resolve) => {
      if (!inspectedWindow || typeof inspectedWindow.getResources !== 'function') {
        resolve('unknown');
        return;
      }
      inspectedWindow.getResources((resources) => {
        const sites = (resources || [])
          .filter((resource) => resource && resource.type === 'document')
          .map((resource) => classifySite(resource.url));
        if (sites.includes('tiktok')) resolve('tiktok');
        else if (sites.includes('other')) resolve('other');
        else resolve('unknown');
      });
    });
  }

  function maskSegment(segment) {
    return segment
      .replace(/[0-9a-f]{16,}/gi, '<id>')
      .replace(/\d{5,}/g, '<n>');
  }

  // A TikTok-CDN image that the policy refused: counted locally so a change
  // in TikTok's URL format is noticed. IDs are masked; nothing leaves the
  // extension.
  function describeNearMiss(url, mimeType, reason, policy) {
    const suffixes = policy.diagnosticHostSuffixes || [];
    if (!suffixes.length) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (!suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      return null;
    }
    const isImage =
      /^image\//i.test(String(mimeType || '')) || IMAGE_PATH.test(parsed.pathname);
    if (!isImage) return null;
    const hostPattern = host.replace(/^([a-z0-9]+-)+[a-z0-9]+(?=\.)/, (label) =>
      label.replace(/-[a-z]{2,4}$/, '-*')
    );
    const pathPattern = parsed.pathname
      .split('/')
      .map(maskSegment)
      .join('/')
      .slice(0, 140);
    return { reason, pattern: `${hostPattern}${pathPattern}` };
  }

  function makeThumbnail(contentBase64, mimeType) {
    if (
      typeof document === 'undefined' ||
      typeof createImageBitmap !== 'function' ||
      typeof Blob === 'undefined'
    ) {
      return Promise.resolve(null);
    }
    return (async () => {
      const bytes = CapturePayload.base64ToBytes(contentBase64);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
      const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (typeof bitmap.close === 'function') bitmap.close();
      const url = canvas.toDataURL('image/webp', 0.8);
      return url.length <= THUMBNAIL_MAX_LENGTH ? url : null;
    })().catch(() => null);
  }

  function getRequestContent(request, lastError) {
    return new Promise((resolve, reject) => {
      if (!request || typeof request.getContent !== 'function') {
        reject(new Error('get_content_unavailable'));
        return;
      }
      request.getContent((content, encoding) => {
        const error = lastError();
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve({ content, encoding });
      });
    });
  }

  // send(message) → Promise<response>; lastError() → chrome.runtime.lastError.
  function createPipeline({ policy, send, lastError, origin }) {
    function report(kind, reason) {
      return send({ type: 'DEVTOOLS_EVENT', kind, reason }).catch(() => undefined);
    }

    function reportNearMiss(nearMiss) {
      return send({ type: 'CAPTURE_DIAGNOSTIC', ...nearMiss }).catch(() => undefined);
    }

    // Resolves to one of: ignored, near_miss, skipped, queued, known, held,
    // already_queued, rejected.
    async function processEntry(request) {
      const requestUrl =
        request && request.request && typeof request.request.url === 'string'
          ? request.request.url
          : '';
      const response = request && request.response;
      const status = Number(response && response.status);
      if (Number.isFinite(status) && (status < 200 || status >= 400)) {
        return { outcome: 'ignored' };
      }

      const responseMime = getResponseMimeType(response);
      const resource = StickerPolicy.classifyStickerResource(requestUrl, responseMime, policy);
      if (!resource.allowed) {
        const nearMiss = describeNearMiss(requestUrl, responseMime, resource.reason, policy);
        if (!nearMiss) return { outcome: 'ignored' };
        await reportNearMiss(nearMiss);
        return { outcome: 'near_miss', reason: resource.reason };
      }

      const reportedSize = Number(response && response.content && response.content.size);
      if (Number.isFinite(reportedSize) && reportedSize > policy.maxBodyBytes) {
        await report('skipped', 'body_too_large');
        return { outcome: 'skipped', reason: 'body_too_large' };
      }

      let body;
      try {
        body = await getRequestContent(request, lastError);
      } catch {
        await report('body_read_failed', 'get_content_failed');
        return { outcome: 'skipped', reason: 'get_content_failed' };
      }

      const encoded = CapturePayload.contentToBase64(body.content, body.encoding, policy.maxBodyBytes);
      if (!encoded.ok) {
        await report('skipped', encoded.reason);
        return { outcome: 'skipped', reason: encoded.reason };
      }

      // The header is only a hint; the bytes decide the sticker type.
      const mimeType = CapturePayload.detectBase64ImageMime(encoded.contentBase64);
      if (!policy.allowedMimeTypes.includes(mimeType)) {
        await report('skipped', 'content_type_mismatch');
        return { outcome: 'skipped', reason: 'content_type_mismatch' };
      }

      const thumbnail = await makeThumbnail(encoded.contentBase64, mimeType);
      let result;
      try {
        result = await send({
          type: 'QUEUE_CAPTURE',
          origin,
          thumbnail,
          payload: {
            source: 'devtools',
            sourceUrl: resource.sourceUrl,
            mimeType,
            observedAt: new Date().toISOString(),
            contentBase64: encoded.contentBase64
          }
        });
      } catch {
        await report('body_read_failed', 'background_unavailable');
        return { outcome: 'skipped', reason: 'background_unavailable' };
      }

      if (!result.ok) {
        await report('skipped', result.reason || 'queue_rejected');
        return { outcome: 'rejected', reason: result.reason || 'queue_rejected' };
      }
      if (result.known) return { outcome: 'known' };
      if (result.duplicateQueued) return { outcome: 'already_queued' };
      return { outcome: result.paused ? 'held' : 'queued' };
    }

    return { processEntry };
  }

  function summarize(outcomes) {
    const summary = { total: outcomes.length, stickers: 0, queued: 0, known: 0, already: 0, held: 0, skipped: 0, nearMiss: 0 };
    for (const { outcome } of outcomes) {
      if (outcome === 'ignored') continue;
      if (outcome === 'near_miss') {
        summary.nearMiss += 1;
        continue;
      }
      summary.stickers += 1;
      if (outcome === 'queued') summary.queued += 1;
      else if (outcome === 'known') summary.known += 1;
      else if (outcome === 'already_queued') summary.already += 1;
      else if (outcome === 'held') summary.held += 1;
      else summary.skipped += 1;
    }
    return summary;
  }

  return {
    THUMBNAIL_MAX_LENGTH,
    getResponseMimeType,
    classifySite,
    detectInspectedSite,
    describeNearMiss,
    createPipeline,
    summarize
  };
});
