export const PAGE_SIZE = 24;
export const PAGE_SIZE_DENSE = 48;

// Telegram sticker limits as documented for the @Stickers bot.
export const TELEGRAM_LIMITS = {
  staticBytes: 512 * 1024,
  videoBytes: 256 * 1024,
  maxDurationSeconds: 3,
  side: 512
};

export const SYSTEM_TAG_PREFIX = 'import:';

export const normalizeMediaPath = (path) => {
  if (!path) return '';
  if (path.startsWith('/')) return path;
  return `/${path.replace(/^\.?[\\/]+/, '').replaceAll('\\', '/')}`;
};

export const getOriginalPath = (sticker) => normalizeMediaPath(
  sticker.originalPath
  || sticker.capturedPath
  || `captured/${sticker.capturedDate || 'default'}/${sticker.originalFilename}`
);

export const getOutputMediaPath = (sticker) => normalizeMediaPath(sticker.convertedPath || '');

const readFiniteNumber = (...values) => {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(number) && number >= 0) return number;
  }
  return null;
};

export const getStickerDuration = (sticker) => {
  if (!sticker?.isAnimated) return 0;
  const durationMs = readFiniteNumber(sticker.durationMs, sticker.metadata?.durationMs, sticker.animation?.durationMs);
  if (durationMs !== null) return durationMs / 1000;
  const durationSeconds = readFiniteNumber(sticker.durationSeconds, sticker.duration, sticker.metadata?.durationSeconds, sticker.animation?.durationSeconds);
  if (durationSeconds !== null) return durationSeconds;
  const frameDelays = sticker.frameDelays || sticker.metadata?.frameDelays;
  if (Array.isArray(frameDelays) && frameDelays.length) {
    return frameDelays.reduce((sum, delay) => sum + Math.max(0, Number(delay) || 0), 0) / 1000;
  }
  if (Array.isArray(sticker.delay) && sticker.delay.length) {
    return sticker.delay.reduce((sum, delay) => sum + Math.max(0, Number(delay) || 0), 0) / 1000;
  }
  const frameCount = readFiniteNumber(sticker.frames) || 0;
  const frameDelayMs = readFiniteNumber(sticker.delay, sticker.metadata?.delay);
  if (frameDelayMs !== null) return (frameCount * frameDelayMs) / 1000;
  const fps = readFiniteNumber(sticker.fps, sticker.metadata?.fps);
  return fps ? frameCount / fps : frameCount / 25;
};

export const getPersistedRange = (sticker) => {
  const source = sticker.selectedRange || sticker.renderedRange || sticker.conversion?.range || {};
  const start = readFiniteNumber(source.start, source.startTime, sticker.selectedStartTime, sticker.startTime, sticker.conversion?.startTime) || 0;
  const explicitEnd = readFiniteNumber(source.end, source.endTime, sticker.selectedEndTime);
  const duration = readFiniteNumber(source.duration, sticker.selectedDuration, sticker.conversion?.duration) || 3;
  return { start, end: explicitEnd ?? start + duration };
};

export const hasPersistedRange = (sticker) => Boolean(
  sticker.selectedRange
  || sticker.renderedRange
  || sticker.conversion?.range
  || Number.isFinite(Number(sticker.selectedStartTime))
  || Number.isFinite(Number(sticker.startTime))
  || Number.isFinite(Number(sticker.conversion?.startTime))
);

export const getTodayFolder = () => new Date().toISOString().split('T')[0];

export const getShortId = (sticker) => String(sticker?.id || '').slice(0, 8);

export const getUserTags = (sticker) => (sticker?.tags || [])
  .filter((tag) => !String(tag).startsWith(SYSTEM_TAG_PREFIX));

export const getSystemTags = (sticker) => (sticker?.tags || [])
  .filter((tag) => String(tag).startsWith(SYSTEM_TAG_PREFIX));

export const getImportName = (sticker) => {
  const tag = getSystemTags(sticker)[0];
  return tag ? String(tag).slice(SYSTEM_TAG_PREFIX.length) : null;
};

const hasHealth = (sticker, flag) => Array.isArray(sticker?.health) && sticker.health.includes(flag);

export const isOriginalMissing = (sticker) => hasHealth(sticker, 'missing_original');

// outputSizeBytes is measured by the server on every read: a number means the
// file exists, null means it does not. Older payloads fall back to the size
// recorded at conversion time.
export const getOutputSize = (sticker) => {
  if (typeof sticker?.outputSizeBytes === 'number') return sticker.outputSizeBytes;
  if (sticker?.outputSizeBytes === null) return null;
  return typeof sticker?.convertedSizeBytes === 'number' ? sticker.convertedSizeBytes : null;
};

export const isOutputMissing = (sticker) => sticker?.status === 'converted' && (
  !sticker.convertedPath
  || hasHealth(sticker, 'missing_converted')
  || sticker.outputSizeBytes === null
);

export const getTelegramLimitBytes = (sticker) => (sticker?.isAnimated
  ? TELEGRAM_LIMITS.videoBytes
  : TELEGRAM_LIMITS.staticBytes);

/**
 * One state per sticker, derived from the server status plus file facts.
 * ready | output_missing | over_limit | unmeasured | captured | converting | failed
 */
export const getStickerState = (sticker) => {
  if (sticker?.status === 'converting') return 'converting';
  if (sticker?.status === 'failed') return 'failed';
  if (sticker?.status !== 'converted') return 'captured';
  if (isOutputMissing(sticker)) return 'output_missing';
  const size = getOutputSize(sticker);
  if (size === null) return 'unmeasured';
  if (size > getTelegramLimitBytes(sticker)) return 'over_limit';
  return 'ready';
};

const ACTION_STATES = new Set(['captured', 'failed', 'output_missing', 'over_limit']);

export const needsAction = (sticker) => ACTION_STATES.has(getStickerState(sticker));

export const STATE_LABELS = {
  ready: 'Ready',
  output_missing: 'Output missing',
  over_limit: 'Over limit',
  unmeasured: 'Size unknown',
  captured: 'Not converted',
  converting: 'Converting…',
  failed: 'Failed'
};

export const formatBytes = (bytes) => {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
};

export const formatSeconds = (seconds) => `${Number(seconds).toFixed(1)} s`;

// Error text from the server can include absolute paths; never show them.
export const toSafeErrorMessage = (message) => {
  if (!message) return '';
  const cleaned = String(message)
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '[local file]')
    .replace(/(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]+/g, ' [local file]')
    .trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}…` : cleaned;
};

const matchesSearch = (sticker, query) => {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (String(sticker.id || '').toLowerCase().includes(needle)) return true;
  if (String(sticker.originalFilename || '').toLowerCase().includes(needle)) return true;
  return (sticker.tags || []).some((tag) => String(tag).toLowerCase().includes(needle));
};

const matchesType = (sticker, type) => {
  if (type === 'static') return !sticker.isAnimated;
  if (type === 'animated') return Boolean(sticker.isAnimated);
  return true;
};

const matchesStatus = (sticker, status) => {
  if (status === 'ready') return getStickerState(sticker) === 'ready';
  if (status === 'action') return needsAction(sticker);
  if (status === 'converting') return getStickerState(sticker) === 'converting';
  return true;
};

const capturedTime = (sticker) => {
  const time = Date.parse(sticker.capturedAt || sticker.capturedDate || '');
  return Number.isFinite(time) ? time : 0;
};

const byId = (a, b) => String(a.id).localeCompare(String(b.id));

const SORTERS = {
  newest: (a, b) => capturedTime(b) - capturedTime(a) || byId(a, b),
  oldest: (a, b) => capturedTime(a) - capturedTime(b) || byId(a, b),
  largest: (a, b) => {
    const sizeA = getOutputSize(a);
    const sizeB = getOutputSize(b);
    if (sizeA === null && sizeB === null) return byId(a, b);
    if (sizeA === null) return 1;
    if (sizeB === null) return -1;
    return sizeB - sizeA || byId(a, b);
  }
};

export const summarizeAttention = (stickers) => {
  const summary = { captured: 0, failed: 0, outputMissing: 0, overLimit: 0, converting: 0 };
  for (const sticker of stickers) {
    const state = getStickerState(sticker);
    if (state === 'captured') summary.captured += 1;
    else if (state === 'failed') summary.failed += 1;
    else if (state === 'output_missing') summary.outputMissing += 1;
    else if (state === 'over_limit') summary.overLimit += 1;
    else if (state === 'converting') summary.converting += 1;
  }
  summary.total = summary.captured + summary.failed + summary.outputMissing + summary.overLimit;
  return summary;
};

/**
 * Filters, counts, sorts and paginates the catalogue from one snapshot.
 * Status counts respect the type filter and type counts respect the status
 * filter, so every number describes what clicking it would show.
 */
export const selectCatalogue = (stickers, {
  q = '', type = 'all', status = 'all', sort = 'newest', page = 1, pageSize = PAGE_SIZE
} = {}) => {
  const searched = stickers.filter((sticker) => matchesSearch(sticker, q.trim()));
  const ofType = searched.filter((sticker) => matchesType(sticker, type));
  const ofStatus = searched.filter((sticker) => matchesStatus(sticker, status));

  const counts = {
    all: ofType.length,
    ready: ofType.filter((sticker) => matchesStatus(sticker, 'ready')).length,
    action: ofType.filter((sticker) => matchesStatus(sticker, 'action')).length,
    converting: ofType.filter((sticker) => matchesStatus(sticker, 'converting')).length,
    anyType: ofStatus.length,
    static: ofStatus.filter((sticker) => matchesType(sticker, 'static')).length,
    animated: ofStatus.filter((sticker) => matchesType(sticker, 'animated')).length
  };

  const filtered = ofType
    .filter((sticker) => matchesStatus(sticker, status))
    .sort(SORTERS[sort] || SORTERS.newest);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const start = (currentPage - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page: currentPage,
    pageCount,
    counts,
    libraryTotal: stickers.length
  };
};

const recordedDurationSeconds = (sticker) => {
  const ms = readFiniteNumber(sticker.conversion?.durationMs, sticker.convertedRange?.durationMs);
  if (ms !== null) return ms / 1000;
  return readFiniteNumber(sticker.conversion?.durationSeconds, sticker.convertedRange?.durationSeconds);
};

const NOT_RECORDED = 'Not recorded (converted by an earlier version)';

/**
 * Telegram check rows: { key, label, value, tone, note?, ratio? }.
 * tone is ok | warning | problem | unknown. Nothing is inferred beyond the data.
 */
export const getTelegramCheck = (sticker) => {
  const rows = [];
  const state = getStickerState(sticker);

  if (isOriginalMissing(sticker)) {
    rows.push({ key: 'original', label: 'Original', value: 'Missing on disk', tone: 'problem' });
  }

  if (state === 'captured') {
    rows.push({ key: 'conversion', label: 'Conversion', value: 'Not converted yet', tone: 'unknown' });
  } else if (state === 'converting') {
    rows.push({ key: 'conversion', label: 'Conversion', value: 'In progress', tone: 'unknown' });
  } else if (state === 'failed') {
    rows.push({
      key: 'conversion',
      label: 'Conversion',
      value: 'Failed',
      tone: 'problem',
      note: toSafeErrorMessage(sticker.error || sticker.conversionError?.message) || undefined
    });
  } else {
    const extension = String(sticker.convertedFilename || sticker.convertedPath || '').split('.').pop().toLowerCase();
    const expected = sticker.isAnimated ? 'webm' : 'webp';
    rows.push({
      key: 'format',
      label: 'Format',
      value: extension === 'webm' ? 'WebM video' : extension === 'webp' ? 'WebP' : extension.toUpperCase() || 'Unknown',
      tone: extension === expected ? 'ok' : 'warning'
    });

    const limit = getTelegramLimitBytes(sticker);
    const size = getOutputSize(sticker);
    if (state === 'output_missing') {
      rows.push({ key: 'size', label: 'File size', value: 'Output file missing', tone: 'problem' });
    } else if (size === null) {
      rows.push({ key: 'size', label: 'File size', value: 'Not measured', tone: 'unknown' });
    } else {
      const ratio = size / limit;
      rows.push({
        key: 'size',
        label: 'File size',
        value: `${formatBytes(size)} / ${formatBytes(limit)}`,
        tone: ratio > 1 ? 'problem' : ratio > 0.9 ? 'warning' : 'ok',
        ratio: Math.min(ratio, 1)
      });
    }

    if (sticker.isAnimated) {
      const duration = recordedDurationSeconds(sticker);
      rows.push(duration === null
        ? { key: 'duration', label: 'Duration', value: NOT_RECORDED, tone: 'unknown' }
        : {
          key: 'duration',
          label: 'Duration',
          value: `${formatSeconds(duration)} / ${formatSeconds(TELEGRAM_LIMITS.maxDurationSeconds)}`,
          tone: duration <= TELEGRAM_LIMITS.maxDurationSeconds + 0.001 ? 'ok' : 'problem'
        });
    }

    rows.push(sticker.conversion
      ? { key: 'dimensions', label: 'Dimensions', value: `${TELEGRAM_LIMITS.side} px, checked at conversion`, tone: 'ok' }
      : { key: 'dimensions', label: 'Dimensions', value: NOT_RECORDED, tone: 'unknown' });
  }

  const width = Number(sticker.width) || 0;
  const height = Number(sticker.height) || 0;
  if (width && height) {
    const factor = TELEGRAM_LIMITS.side / Math.max(width, height);
    rows.push(factor > 1.5
      ? {
        key: 'source',
        label: 'Source',
        value: `${width} × ${height}`,
        tone: 'warning',
        note: `Upscaled ${factor.toFixed(1)}× to reach ${TELEGRAM_LIMITS.side} px — edges may look soft.`
      }
      : { key: 'source', label: 'Source', value: `${width} × ${height}`, tone: 'ok' });
  }

  return rows;
};

// ----- URL view state -----

export const VIEW_DEFAULTS = {
  view: 'library', q: '', type: 'all', status: 'all', sort: 'newest', page: 1, id: null
};

const ALLOWED = {
  view: ['library', 'health', 'editor'],
  type: ['all', 'static', 'animated'],
  status: ['all', 'ready', 'action', 'converting'],
  sort: ['newest', 'oldest', 'largest']
};

export const parseViewState = (search) => {
  const params = new URLSearchParams(search || '');
  const pick = (key) => (ALLOWED[key].includes(params.get(key)) ? params.get(key) : VIEW_DEFAULTS[key]);
  const page = Number.parseInt(params.get('page') || '', 10);
  const id = params.get('id');
  return {
    view: pick('view') === 'editor' && !(id && /^[a-f0-9]{8,64}$/i.test(id)) ? VIEW_DEFAULTS.view : pick('view'),
    q: (params.get('q') || '').slice(0, 200),
    type: pick('type'),
    status: pick('status'),
    sort: pick('sort'),
    page: Number.isInteger(page) && page > 0 ? page : 1,
    id: id && /^[a-f0-9]{8,64}$/i.test(id) ? id : null
  };
};

export const buildViewSearch = (state) => {
  const params = new URLSearchParams();
  for (const key of ['view', 'q', 'type', 'status', 'sort', 'page', 'id']) {
    const value = state[key];
    if (value === null || value === undefined || value === '' || value === VIEW_DEFAULTS[key]) continue;
    params.set(key, String(value));
  }
  return params.toString();
};

// ----- Server-reported paths and storage -----

export const getOutputPath = (key, outputPaths, storage) => {
  const aliases = {
    root: ['root', 'output', 'outputRoot', 'rootPath'],
    captured: ['captured', 'capturedPath'],
    statics: ['statics', 'static', 'staticsPath', 'staticPath'],
    animated: ['animated', 'animatedPath'],
    archives: ['archives', 'archivesPath']
  };
  const sources = [outputPaths, storage?.paths, storage];
  for (const source of sources) {
    for (const alias of aliases[key] || [key]) {
      if (typeof source?.[alias] === 'string' && source[alias]) return source[alias];
    }
  }
  return key === 'root' ? 'output/' : `output/${key}/`;
};

export const STORAGE_ISSUE_KEYS = ['missingOriginals', 'missingConverted', 'orphanFiles', 'tempEntries', 'staleConversions'];

export const countStorageIssues = (storage) => STORAGE_ISSUE_KEYS
  .reduce((sum, key) => {
    const value = storage?.[key];
    return sum + (Array.isArray(value) ? value.length : Number(value) || 0);
  }, 0);
