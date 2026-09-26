const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const multer = require('multer');
const conversionQueue = require('./ConversionQueue');
const { JobRegistry } = require('./lib/jobRegistry');
const {
  ANIMATED_SIZE_LIMIT,
  MAX_DURATION_MS,
  STATIC_SIZE_LIMIT,
  compressAnimatedWebM,
  compressStaticSticker,
  computeTargetDimensions,
  createJobDirectory,
  escapeXml,
  normalizeFrameDelays,
  normalizeTransforms,
  selectFrameRange
} = require('./lib/conversion');
const SessionBudget = require('./lib/sessionBudget');
const { normalizeFileToWebp, isSupportedFilename } = require('./lib/manualImport');
const {
  loadStickerPolicy,
  validateStickerUrl,
  validateStickerPayload,
  detectMimeType,
  decodeBase64Strict,
  normalizeMimeType
} = require('./lib/stickerPolicy');
const {
  StickerDatabase,
  reconcileStorage,
  resolveUnder
} = require('./lib/stickerDatabase');
const {
  createLibraryArchiveSnapshot,
  listLibraryArchives,
  verifyLibraryArchive
} = require('./lib/libraryArchive');
const { createLocalSecurity, isExtensionOrigin } = require('./lib/localSecurity');
const { IngestTokenStore, IngestTokenError } = require('./lib/ingestTokenStore');
const { CaptureSettings } = require('./lib/captureSettings');
const { PackStore, PackError, PACK_ID_PATTERN } = require('./lib/packStore');
const { buildPackExport } = require('./lib/packExport');
const {
  HOST,
  PORT,
  INGEST_TOKEN,
  OUTPUT_DIR: CONFIG_OUTPUT_DIR,
  TEMP_DIR: CONFIG_TEMP_DIR,
  DASHBOARD_ORIGINS,
  MAX_DECODED_PIXELS,
  MANUAL_FILE_MAX_BYTES,
  MANUAL_REQUEST_MAX_BYTES,
  HAR_MAX_BYTES,
  SESSION_MAX_CAPTURES,
  SESSION_MAX_MS,
  CAPTURE_MIN_INTERVAL_MS,
  CAPTURE_JITTER_MS,
  INGEST_RATE_WINDOW_MS,
  INGEST_RATE_MAX,
  AUTO_CONVERT_DELAY_MS
} = require('./lib/config');

const app = express();
const security = createLocalSecurity({
  // Read on every request: pairing in the dashboard can change the token.
  ingestToken: () => ingestTokens.current(),
  dashboardOrigins: DASHBOARD_ORIGINS
});
const stickerPolicy = loadStickerPolicy();

app.disable('x-powered-by');
app.use(security.originMiddleware);
app.use(express.json({ limit: Math.ceil(stickerPolicy.maxBodyBytes * 4 / 3) + 64 * 1024 }));

function getTodayDateStr() {
  return new Date().toISOString().split('T')[0];
}

const OUTPUT_DIR = path.resolve(CONFIG_OUTPUT_DIR || path.join(__dirname, 'output'));
const TEMP_DIR = path.resolve(CONFIG_TEMP_DIR || path.join(__dirname, 'temp'));
const UPLOAD_DIR = resolveUnder(TEMP_DIR, 'uploads');
const HAR_UPLOAD_DIR = resolveUnder(TEMP_DIR, 'har-uploads');
const ARCHIVES_DIR = resolveUnder(OUTPUT_DIR, 'archives');
const ingestTokens = new IngestTokenStore({
  envToken: INGEST_TOKEN,
  filePath: path.join(OUTPUT_DIR, '.ingest-token')
});
const captureSettings = new CaptureSettings({
  filePath: path.join(OUTPUT_DIR, 'capture-settings.json')
});

function getCapturedDir(dateStr = getTodayDateStr()) {
  const dir = resolveUnder(OUTPUT_DIR, path.join('captured', dateStr));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStaticsDir(dateStr = getTodayDateStr()) {
  const dir = resolveUnder(OUTPUT_DIR, path.join('statics', dateStr));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAnimatedDir(dateStr = getTodayDateStr()) {
  const dir = resolveUnder(OUTPUT_DIR, path.join('animated', dateStr));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

for (const directory of [OUTPUT_DIR, TEMP_DIR, UPLOAD_DIR, HAR_UPLOAD_DIR, ARCHIVES_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) => {
      const safeExtension = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
      callback(null, `upload_${crypto.randomBytes(12).toString('hex')}${safeExtension}`);
    }
  }),
  limits: { fileSize: MANUAL_FILE_MAX_BYTES, files: 30 },
  fileFilter: (_req, file, callback) => {
    if (isSupportedFilename(file.originalname)) callback(null, true);
    else callback(new Error(`Unsupported file type: ${file.originalname}`));
  }
});

const harUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, HAR_UPLOAD_DIR),
    filename: (_req, _file, callback) =>
      callback(null, `har_${crypto.randomBytes(12).toString('hex')}.json`)
  }),
  limits: { fileSize: HAR_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension === '.har' || extension === '.json') callback(null, true);
    else callback(new Error('HAR import accepts only .har or .json files.'));
  }
});

function cleanupUploadFiles(files) {
  for (const file of files || []) {
    if (!file || !file.path) continue;
    try {
      const relative = path.relative(TEMP_DIR, path.resolve(file.path));
      const resolved = resolveUnder(TEMP_DIR, relative);
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    } catch (_) {
      // Health reporting exposes any file that could not be removed.
    }
  }
}

app.use(
  '/captured',
  security.requireDashboard,
  express.static(path.join(OUTPUT_DIR, 'captured'), { fallthrough: false })
);
app.use(
  '/statics',
  security.requireDashboard,
  express.static(path.join(OUTPUT_DIR, 'statics'), { fallthrough: false })
);
app.use(
  '/animated',
  security.requireDashboard,
  express.static(path.join(OUTPUT_DIR, 'animated'), { fallthrough: false })
);

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Application State
let lastIngestAt = null;
let lastIngestSource = null;
let lastIngestError = null;
// A payload refused by the sticker policy is not a delivery failure.
let lastIngestRejection = null;
// Last heartbeat from the capture extension; only the extension knows
// whether DevTools is open on a TikTok tab.
const EXTENSION_HEARTBEAT_STALE_MS = 45_000;
const EXTENSION_LISTENER_STATES = new Set(['off', 'closed', 'other_site', 'watching_unconfirmed', 'watching']);
const EXTENSION_WARNING_CODES = new Set([
  'challenge', 'session_limit', 'cache_disabled', 'session_near_limit', 'frequent_navigation', 'fast_capture'
]);
let extensionHeartbeat = null;
let extensionStaleTimer = null;
let capturedStickers = [];
const dbPath = path.join(OUTPUT_DIR, 'stickers_db.json');
const database = new StickerDatabase(dbPath);
let storageHealth = null;

const loadedDatabase = database.load();
capturedStickers = loadedDatabase.stickers;
const initialReconciliation = reconcileStorage(capturedStickers, {
  outputDir: OUTPUT_DIR,
  tempDir: TEMP_DIR,
  // Only at startup can a 'converting' record be known to be interrupted.
  recoverInterrupted: true
});
storageHealth = {
  ...initialReconciliation.report,
  recoveredFromBackup: loadedDatabase.recoveredFromBackup
};
if (loadedDatabase.changed || initialReconciliation.changed) database.save(capturedStickers);

function saveDatabase() {
  database.save(capturedStickers);
}

// Packs live in their own file. The first write ever takes a library snapshot
// so the state before packs existed can always be restored.
const packStore = new PackStore(path.join(OUTPUT_DIR, 'packs.json'), {
  beforeFirstWrite: () => {
    if (capturedStickers.length) createLibraryArchive();
  }
});
packStore.load();
if (packStore.loadError) console.warn(`[Packs] packs.json is unreadable and left untouched: ${packStore.loadError}`);

function refreshStorageHealth({ collectItems = false } = {}) {
  const reconciliation = reconcileStorage(capturedStickers, {
    outputDir: OUTPUT_DIR,
    tempDir: TEMP_DIR,
    collectItems
  });
  storageHealth = {
    ...reconciliation.report,
    recoveredFromBackup: Boolean(storageHealth && storageHealth.recoveredFromBackup)
  };
  if (reconciliation.changed) saveDatabase();
  return collectItems ? { storage: storageHealth, issues: reconciliation.issues } : storageHealth;
}

// Measured on every read so the UI never trusts a stale or legacy size field.
// The value is derived for clients only and is never written to the database.
function measureOutputSize(sticker) {
  if (typeof sticker.convertedPath !== 'string' || !sticker.convertedPath) return null;
  try {
    const diskPath = resolveUnder(OUTPUT_DIR, sticker.convertedPath.replace(/^[/\\]+/, ''));
    const stat = fs.statSync(diskPath);
    return stat.isFile() ? stat.size : null;
  } catch (_) {
    return null;
  }
}

function toClientSticker(sticker) {
  if (!sticker) return sticker;
  return { ...sticker, outputSizeBytes: measureOutputSize(sticker) };
}

const STICKER_MESSAGE_TYPES = new Set(['new_sticker', 'sticker_update']);
const SERVER_STARTED_AT = new Date().toISOString();

// Batch job history is in memory only; clients are told it resets on restart.
const jobRegistry = new JobRegistry({
  maxJobs: 20,
  onChange: (job) => broadcast({ type: 'job_update', data: job })
});

function getJobsPayload() {
  return { jobs: jobRegistry.list(), historyScope: 'server-process', serverStartedAt: SERVER_STARTED_AT };
}

function broadcast(message) {
  const payload = JSON.stringify(STICKER_MESSAGE_TYPES.has(message.type)
    ? { ...message, data: toClientSticker(message.data) }
    : message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

function extensionSnapshot() {
  if (!extensionHeartbeat) {
    return { connected: false, lastSeenAt: null, listenerState: null, queue: null, pausedReason: null, warnings: [], version: null };
  }
  return {
    connected: Date.now() - extensionHeartbeat.receivedAt < EXTENSION_HEARTBEAT_STALE_MS,
    lastSeenAt: new Date(extensionHeartbeat.receivedAt).toISOString(),
    listenerState: extensionHeartbeat.listenerState,
    queue: extensionHeartbeat.queue,
    pausedReason: extensionHeartbeat.pausedReason,
    warnings: extensionHeartbeat.warnings,
    version: extensionHeartbeat.version
  };
}

function getStatusPayload() {
  const accepted = Boolean(lastIngestAt);
  const ingestEnabled = Boolean(ingestTokens.current());
  return {
    captureMode: ingestEnabled ? 'devtools' : 'offline',
    devtools: {
      enabled: ingestEnabled,
      pairing: ingestTokens.status(),
      autoConvert: captureSettings.get().autoConvert,
      extension: extensionSnapshot(),
      state: !ingestEnabled ? 'disabled' : lastIngestError ? 'local_delivery_failed' : accepted ? 'last_asset_accepted' : 'awaiting_devtools',
      listening: null,
      requiresDevToolsOpen: true,
      lastAcceptedAt: lastIngestAt,
      lastIngestAt,
      lastError: lastIngestError,
      lastRejectedAt: lastIngestRejection ? lastIngestRejection.at : null,
      lastRejectedReason: lastIngestRejection ? lastIngestRejection.reason : null
    },
    session: sessionBudget.snapshot(),
    lastIngestAt,
    lastIngestSource,
    stickerCount: capturedStickers.length,
    storage: storageHealth
  };
}

function getOutputPaths() {
  return {
    root: OUTPUT_DIR,
    captured: path.join(OUTPUT_DIR, 'captured'),
    statics: path.join(OUTPUT_DIR, 'statics'),
    animated: path.join(OUTPUT_DIR, 'animated'),
    archives: ARCHIVES_DIR
  };
}

function emitStatus() {
  broadcast({ type: 'status', data: getStatusPayload() });
}

const ingestTimestamps = [];
const sessionBudget = new SessionBudget({
  maxCaptures: SESSION_MAX_CAPTURES,
  maxMs: SESSION_MAX_MS,
  onExhausted: (reason) => {
    console.warn(`[SessionBudget] Exhausted: ${reason}.`);
    emitStatus();
  }
});

let captureQueueTail = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureGapMs() {
  const jitter = CAPTURE_JITTER_MS > 0 ? Math.floor(Math.random() * (CAPTURE_JITTER_MS + 1)) : 0;
  return CAPTURE_MIN_INTERVAL_MS + jitter;
}

function checkIngestRateLimit() {
  const now = Date.now();
  while (ingestTimestamps.length && now - ingestTimestamps[0] > INGEST_RATE_WINDOW_MS) {
    ingestTimestamps.shift();
  }
  if (ingestTimestamps.length >= INGEST_RATE_MAX) return false;
  ingestTimestamps.push(now);
  return true;
}

function writeFileAtomic(filePath, buffer) {
  if (fs.existsSync(filePath)) {
    const existingHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const incomingHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (existingHash !== incomingHash) {
      throw new Error('Existing content-addressed file has different bytes.');
    }
    return;
  }

  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fd !== null && fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (fs.existsSync(temporaryPath)) {
      try { fs.unlinkSync(temporaryPath); } catch (_) {}
    }
  }
}

async function processCapturedSticker({
  sourceUrl,
  buffer,
  contentBase64,
  mimeType,
  source = 'devtools',
  observedAt,
  countsBudget = true
}) {
  const validated = await validateStickerPayload({
    sourceUrl,
    mimeType,
    contentBase64,
    buffer,
    policy: stickerPolicy,
    maxDecodedPixels: MAX_DECODED_PIXELS
  });
  let storedBuffer = validated.buffer;
  let storedMetadata = validated.metadata;
  if (validated.detectedMime !== 'image/webp') {
    storedBuffer = await sharp(validated.buffer, {
      animated: true,
      limitInputPixels: MAX_DECODED_PIXELS
    })
      .webp({ quality: 92, effort: 4 })
      .toBuffer();
    storedMetadata = await validateLocalWebp(storedBuffer);
  }

  const sha256 = crypto.createHash('sha256').update(storedBuffer).digest('hex');
  const existing = capturedStickers.find((sticker) => sticker.id === sha256);
  if (existing) return { sticker: existing, duplicate: true };

  if (countsBudget) {
    const budget = sessionBudget.check();
    if (!budget.ok) {
      const error = new Error(`Session budget exhausted: ${budget.reason}.`);
      error.code = 'SESSION_EXHAUSTED';
      throw error;
    }
  }

  const pages = Math.max(1, Number(storedMetadata.pages) || 1);
  const delays = Array.isArray(storedMetadata.delay) ? storedMetadata.delay : [];
  const capturedAt =
    typeof observedAt === 'string' && !Number.isNaN(Date.parse(observedAt))
      ? new Date(observedAt).toISOString()
      : new Date().toISOString();
  const today = getTodayDateStr();
  const filename = `sticker_${sha256}.webp`;
  const newSticker = {
    id: sha256,
    originalUrl: validated.canonicalUrl,
    isAnimated: pages > 1,
    capturedAt,
    capturedDate: today,
    width: storedMetadata.width,
    height: storedMetadata.pageHeight || storedMetadata.height,
    frames: pages,
    delay: delays.length ? delays[0] : Number(storedMetadata.delay) || 40,
    frameDelays: delays.length ? delays : undefined,
    originalFilename: filename,
    convertedPath: null,
    convertedFilename: null,
    status: 'captured',
    tags: [],
    captureSource: source,
    sourceMimeType: validated.detectedMime
  };

  writeFileAtomic(path.join(getCapturedDir(today), filename), storedBuffer);
  capturedStickers.unshift(newSticker);
  try {
    saveDatabase();
  } catch (error) {
    capturedStickers.shift();
    throw error;
  }

  if (countsBudget) sessionBudget.recordCapture();
  lastIngestAt = new Date().toISOString();
  lastIngestSource = source;
  lastIngestError = null;
  broadcast({ type: 'new_sticker', data: newSticker });
  emitStatus();
  return { sticker: newSticker, duplicate: false };
}

function enqueueCapture(options, { applyGap = true } = {}) {
  const result = captureQueueTail.then(async () => {
    try {
      return await processCapturedSticker(options);
    } finally {
      if (applyGap) await sleep(captureGapMs());
    }
  });
  captureQueueTail = result.catch(() => null);
  return result;
}

async function validateLocalWebp(webpBuffer) {
  if (!Buffer.isBuffer(webpBuffer) || !webpBuffer.length) throw new Error('Empty WebP buffer.');
  if (webpBuffer.length > MANUAL_FILE_MAX_BYTES) throw new Error('Normalized WebP exceeds the file limit.');
  if (detectMimeType(webpBuffer) !== 'image/webp') throw new Error('Normalizer did not produce WebP bytes.');
  const metadata = await sharp(webpBuffer, {
    animated: true,
    limitInputPixels: MAX_DECODED_PIXELS
  }).metadata();
  const pages = Math.max(1, Number(metadata.pages) || 1);
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.pageHeight || metadata.height) || 0;
  if (!width || !height || width * height * pages > MAX_DECODED_PIXELS) {
    throw new Error('Decoded WebP dimensions exceed the configured pixel limit.');
  }
  return metadata;
}

async function registerLocalSticker({
  webpBuffer,
  source = 'manual',
  originalName = '',
  notes = '',
  sourceUrl = null,
  observedAt = null
}) {
  const metadata = await validateLocalWebp(webpBuffer);
  const sha256 = crypto.createHash('sha256').update(webpBuffer).digest('hex');
  const existing = capturedStickers.find((sticker) => sticker.id === sha256);
  if (existing) return { sticker: existing, duplicate: true };

  const today = getTodayDateStr();
  const filename = `sticker_${sha256}.webp`;
  writeFileAtomic(path.join(getCapturedDir(today), filename), webpBuffer);
  const pages = Math.max(1, Number(metadata.pages) || 1);
  const delays = Array.isArray(metadata.delay) ? metadata.delay : [];
  const newSticker = {
    id: sha256,
    originalUrl: sourceUrl || (originalName ? `manual://${path.basename(originalName)}` : `manual://${sha256}`),
    isAnimated: pages > 1,
    capturedAt:
      observedAt && !Number.isNaN(Date.parse(observedAt))
        ? new Date(observedAt).toISOString()
        : new Date().toISOString(),
    capturedDate: today,
    width: metadata.width,
    height: metadata.pageHeight || metadata.height,
    frames: pages,
    delay: delays.length ? delays[0] : Number(metadata.delay) || 40,
    frameDelays: delays.length ? delays : undefined,
    originalFilename: filename,
    convertedPath: null,
    convertedFilename: null,
    status: 'captured',
    tags: originalName ? [`import:${path.basename(originalName)}`] : [],
    captureSource: source,
    importNotes: notes || undefined
  };

  capturedStickers.unshift(newSticker);
  try {
    saveDatabase();
  } catch (error) {
    capturedStickers.shift();
    throw error;
  }
  broadcast({ type: 'new_sticker', data: newSticker });
  emitStatus();
  return { sticker: newSticker, duplicate: false };
}

async function* streamHarEntries(filePath) {
  const [
    { parser },
    { pick },
    { streamArray },
    { default: chain }
  ] = await Promise.all([
    import('stream-json'),
    import('stream-json/filters/pick.js'),
    import('stream-json/streamers/stream-array.js'),
    import('stream-chain')
  ]);

  const pipeline = chain([
    fs.createReadStream(filePath),
    parser(),
    pick({ filter: 'log.entries' }),
    streamArray()
  ]);

  try {
    for await (const item of pipeline) {
      yield item.value;
    }
  } catch (error) {
    throw new Error(`HAR streaming parse failed: ${error.message}`);
  } finally {
    pipeline.destroy();
  }
}

async function importHarFile(filePath) {
  const result = { accepted: 0, duplicates: 0, missingBody: 0, rejected: 0, errors: [] };
  let index = 0;

  for await (const streamedEntry of streamHarEntries(filePath)) {
    const entry = streamedEntry || {};
    const sourceUrl = entry.request && entry.request.url;
    const urlValidation = validateStickerUrl(sourceUrl, stickerPolicy);
    if (!urlValidation.ok) {
      result.rejected += 1;
      index += 1;
      continue;
    }

    const content = (entry.response && entry.response.content) || {};
    const mimeType = normalizeMimeType(content.mimeType);
    if (!stickerPolicy.allowedMimeTypes.includes(mimeType)) {
      result.rejected += 1;
      index += 1;
      continue;
    }
    if (typeof content.text !== 'string' || !content.text.length) {
      result.missingBody += 1;
      index += 1;
      continue;
    }

    try {
      let body;
      if (String(content.encoding || '').toLowerCase() === 'base64') {
        body = decodeBase64Strict(content.text, stickerPolicy.maxBodyBytes);
      } else {
        body = Buffer.from(content.text, 'utf8');
        if (!body.length || body.length > stickerPolicy.maxBodyBytes) {
          throw new Error('HAR response body is empty or too large.');
        }
      }
      const imported = await enqueueCapture(
        {
          sourceUrl,
          buffer: body,
          mimeType,
          source: 'har',
          observedAt: entry.startedDateTime,
          countsBudget: false
        },
        { applyGap: false }
      );
      if (imported.duplicate) result.duplicates += 1;
      else result.accepted += 1;
    } catch (error) {
      result.errors.push({ entry: index, error: error.message });
    }
    index += 1;
  }
  return result;
}

function createLibraryArchive() {
  return createLibraryArchiveSnapshot({
    outputDir: OUTPUT_DIR,
    archivesDir: ARCHIVES_DIR,
    databaseFiles: [database.filePath, database.backupPath, packStore.filePath, packStore.backupPath],
    stickerCount: capturedStickers.length
  });
}

// Conversion is implemented by lib/conversion.js.

// API Endpoints

app.get('/api/session', (req, res) => {
  if (req.headers.origin && !security.dashboardOrigins.has(req.headers.origin)) {
    return res.status(403).json({ error: 'Dashboard origin rejected.' });
  }
  security.setDashboardCookie(res);
  return res.json({
    authenticated: true,
    status: getStatusPayload(),
    outputPaths: getOutputPaths()
  });
});

app.get(
  '/api/status',
  (req, res, next) => {
    if (isExtensionOrigin(req.headers.origin)) return security.requireExtension(req, res, next);
    return security.requireDashboard(req, res, next);
  },
  (_req, res) => res.json(getStatusPayload())
);

app.post('/api/ingest', security.requireExtension, async (req, res) => {
  if (!checkIngestRateLimit()) {
    return res.status(429).json({ error: 'Ingest rate limit exceeded. Slow down.' });
  }

  const { source, sourceUrl, mimeType, contentBase64, observedAt } = req.body || {};
  if (!contentBase64) {
    return res.status(422).json({
      error: 'contentBase64 is required. URL-only capture and server-side CDN fetch are disabled.',
      needBuffer: true
    });
  }
  if (source !== 'devtools') return res.status(400).json({ error: 'source must be "devtools".' });

  try {
    const captured = await enqueueCapture({
      sourceUrl,
      mimeType,
      contentBase64,
      observedAt,
      source: 'devtools',
      countsBudget: true
    });
    if (!captured.duplicate) scheduleAutoConvert(captured.sticker.id);
    return res.json({
      success: true,
      duplicate: captured.duplicate,
      sticker: toClientSticker(captured.sticker),
      session: sessionBudget.snapshot()
    });
  } catch (error) {
    if (error.code === 'SESSION_EXHAUSTED') {
      emitStatus();
      res.setHeader('Retry-After', '60');
      return res.status(429).json({
        error: error.message,
        budgetExhausted: true,
        session: sessionBudget.snapshot()
      });
    }
    const clientCodes = new Set([
      'URL_REJECTED',
      'MIME_REJECTED',
      'MAGIC_MISMATCH',
      'IMAGE_INVALID',
      'PIXEL_LIMIT',
      'FORMAT_MISMATCH',
      'BODY_REJECTED'
    ]);
    const status = clientCodes.has(error.code) || /contentBase64|body|MIME|URL|image|pixel/i.test(error.message)
      ? 400
      : 500;
    if (status === 400) {
      lastIngestRejection = { at: new Date().toISOString(), reason: error.message };
    } else {
      lastIngestError = error.message;
    }
    emitStatus();
    return res.status(status).json({ error: error.message, code: error.code || null });
  }
});

const QUEUE_COUNT_MAX = 100_000;

function sanitizeQueueCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, QUEUE_COUNT_MAX) : 0;
}

function recordExtensionHeartbeat(body) {
  const listenerState = String(body.listenerState || '');
  if (!EXTENSION_LISTENER_STATES.has(listenerState)) {
    const error = new Error('Unknown listenerState.');
    error.status = 400;
    throw error;
  }
  const queue = body.queue && typeof body.queue === 'object' ? body.queue : {};
  const next = {
    receivedAt: Date.now(),
    listenerState,
    queue: {
      count: sanitizeQueueCount(queue.count),
      blocked: sanitizeQueueCount(queue.blocked),
      paused: sanitizeQueueCount(queue.paused)
    },
    pausedReason: /^[a-z_]{1,64}$/.test(String(body.pausedReason || '')) ? body.pausedReason : null,
    // Only known codes and small numbers; the texts live in the dashboard.
    warnings: (Array.isArray(body.warnings) ? body.warnings : [])
      .filter((warning) => warning && EXTENSION_WARNING_CODES.has(warning.code))
      .slice(0, EXTENSION_WARNING_CODES.size)
      .map((warning) => ({
        code: warning.code,
        count: sanitizeQueueCount(warning.count),
        max: sanitizeQueueCount(warning.max),
        minutes: sanitizeQueueCount(warning.minutes),
        maxMinutes: sanitizeQueueCount(warning.maxMinutes)
      })),
    version: /^[0-9][0-9.]{0,19}$/.test(String(body.version || '')) ? body.version : null
  };
  const previous = extensionSnapshot();
  const changed =
    !previous.connected ||
    previous.listenerState !== next.listenerState ||
    previous.pausedReason !== next.pausedReason ||
    JSON.stringify(previous.warnings) !== JSON.stringify(next.warnings) ||
    JSON.stringify(previous.queue) !== JSON.stringify(next.queue);
  extensionHeartbeat = next;
  clearTimeout(extensionStaleTimer);
  // Tell the dashboard when the extension goes quiet.
  extensionStaleTimer = setTimeout(emitStatus, EXTENSION_HEARTBEAT_STALE_MS + 1000);
  extensionStaleTimer.unref();
  if (changed) emitStatus();
}

app.post('/api/extension/heartbeat', security.requireExtension, (req, res) => {
  try {
    recordExtensionHeartbeat(req.body || {});
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  return res.json({ ok: true, session: sessionBudget.snapshot() });
});

app.use('/api', security.requireDashboard);

function sendTokenResponse(res, token) {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ token, pairing: ingestTokens.status() });
}

function sendTokenError(res, error) {
  if (error instanceof IngestTokenError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: 'The connection token could not be saved.' });
}

// Creates (or replaces) the token the capture extension must present.
app.post('/api/extension/pair', (_req, res) => {
  try {
    const token = ingestTokens.pair();
    lastIngestError = null;
    extensionHeartbeat = null;
    emitStatus();
    return sendTokenResponse(res, token);
  } catch (error) {
    return sendTokenError(res, error);
  }
});

app.post('/api/extension/token', (_req, res) => {
  const token = ingestTokens.current();
  if (!token) return res.status(404).json({ error: 'The extension is not connected.', code: 'NOT_PAIRED' });
  return sendTokenResponse(res, token);
});

app.post('/api/extension/settings', (req, res) => {
  try {
    const settings = captureSettings.update(req.body);
    emitStatus();
    return res.json({ settings });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Settings could not be saved.' });
  }
});

app.post('/api/extension/unpair', (_req, res) => {
  try {
    ingestTokens.unpair();
    extensionHeartbeat = null;
    emitStatus();
    return res.json({ pairing: ingestTokens.status() });
  } catch (error) {
    return sendTokenError(res, error);
  }
});

app.post('/api/session/reset', (_req, res) => {
  sessionBudget.reset();
  lastIngestError = null;
  lastIngestRejection = null;
  emitStatus();
  res.json({ success: true, session: sessionBudget.snapshot() });
});

app.get('/api/stickers', (_req, res) => {
  res.json(capturedStickers.map(toClientSticker));
});

app.post('/api/import/files', (req, res) => {
  upload.array('files', 30)(req, res, async (error) => {
    if (error) {
      cleanupUploadFiles(req.files);
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: error.message || 'Upload failed.'
      });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded. Use form field "files".' });
    }
    const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    if (totalBytes > MANUAL_REQUEST_MAX_BYTES) {
      cleanupUploadFiles(files);
      return res.status(413).json({ error: 'Combined upload size exceeds the request limit.' });
    }

    const results = [];
    try {
      for (const file of files) {
        const entry = {
          name: file.originalname,
          success: false,
          error: null,
          sticker: null,
          duplicate: false
        };
        try {
          const normalized = await normalizeFileToWebp(file.path, file.originalname, TEMP_DIR, {
            maxDecodedPixels: MAX_DECODED_PIXELS
          });
          const registered = await registerLocalSticker({
            webpBuffer: normalized.webpBuffer,
            source: 'manual',
            originalName: file.originalname,
            notes: normalized.notes
          });
          entry.success = true;
          entry.sticker = toClientSticker(registered.sticker);
          entry.duplicate = registered.duplicate;
        } catch (importError) {
          entry.error = importError.message;
        }
        results.push(entry);
      }
    } finally {
      cleanupUploadFiles(files);
      refreshStorageHealth();
    }

    const imported = results.filter((entry) => entry.success && !entry.duplicate).length;
    const duplicates = results.filter((entry) => entry.success && entry.duplicate).length;
    const failed = results.filter((entry) => !entry.success).length;
    return res.json({ success: failed === 0, imported, duplicates, failed, results });
  });
});

app.post('/api/import/har', (req, res) => {
  harUpload.single('file')(req, res, async (error) => {
    if (error) {
      cleanupUploadFiles(req.file ? [req.file] : []);
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: error.message || 'HAR upload failed.'
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No HAR uploaded. Use form field "file".' });

    try {
      const result = await importHarFile(req.file.path);
      refreshStorageHealth();
      return res.json({ success: result.errors.length === 0, ...result });
    } catch (importError) {
      return res.status(400).json({ error: importError.message });
    } finally {
      cleanupUploadFiles([req.file]);
    }
  });
});

app.post('/api/library/archive', (_req, res) => {
  try {
    const archive = createLibraryArchive();
    return res.json({ success: true, archive, status: getStatusPayload() });
  } catch (error) {
    return res.status(500).json({
      error: `Archive snapshot failed; the active library was left untouched: ${error.message}`
    });
  }
});

// Read-only archive history. Verification results live for the server process only.
const archiveVerifications = new Map();
let archiveVerificationRunning = false;

app.get('/api/library/archives', (_req, res) => {
  try {
    const archives = listLibraryArchives({ archivesDir: ARCHIVES_DIR }).map((archive) => ({
      ...archive,
      lastVerification: archiveVerifications.get(archive.id) || null
    }));
    return res.json({ archives, verificationScope: 'server-process' });
  } catch (error) {
    return res.status(500).json({ error: `Archive list could not be read: ${error.message}` });
  }
});

app.post('/api/library/archives/:id/verify', async (req, res) => {
  if (archiveVerificationRunning) {
    return res.status(409).json({ error: 'Another archive is being verified. Try again when it finishes.' });
  }
  archiveVerificationRunning = true;
  try {
    const result = await verifyLibraryArchive({ archivesDir: ARCHIVES_DIR, id: String(req.params.id) });
    archiveVerifications.set(result.id, result);
    return res.json({ verification: result });
  } catch (error) {
    if (error.code === 'ARCHIVE_NOT_FOUND') return res.status(404).json({ error: 'Archive not found.' });
    return res.status(500).json({ error: `Archive could not be verified: ${error.message}` });
  } finally {
    archiveVerificationRunning = false;
  }
});

// Runs the storage comparison now and returns item-level issues. It may update
// health flags but never deletes, moves or repairs files.
app.post('/api/storage/check', (_req, res) => {
  try {
    const result = refreshStorageHealth({ collectItems: true });
    emitStatus();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: `Storage check failed: ${error.message}` });
  }
});

// Bounded on-demand frame cache. Only the requested frame is decoded.
const FRAME_CACHE_LIMIT = 128;
const frameCache = new Map();

function readCachedFrame(cacheKey) {
  if (!frameCache.has(cacheKey)) return null;
  const value = frameCache.get(cacheKey);
  frameCache.delete(cacheKey);
  frameCache.set(cacheKey, value);
  return value;
}

function cacheFrame(cacheKey, buffer) {
  if (frameCache.has(cacheKey)) frameCache.delete(cacheKey);
  frameCache.set(cacheKey, buffer);
  while (frameCache.size > FRAME_CACHE_LIMIT) {
    const oldestKey = frameCache.keys().next().value;
    frameCache.delete(oldestKey);
  }
}

app.get('/api/stickers/:id/frame/:frameIndex', async (req, res) => {
  const { id, frameIndex } = req.params;
  const frameIndexInt = Number(frameIndex);
  if (!Number.isSafeInteger(frameIndexInt) || frameIndexInt < 0) {
    return res.status(400).json({ error: 'Frame index must be a non-negative integer.' });
  }

  const sticker = capturedStickers.find((item) => item.id === id);
  if (!sticker) return res.status(404).json({ error: 'Sticker not found.' });

  const totalFrames = Math.max(1, Number(sticker.frames) || 1);
  if (frameIndexInt >= totalFrames) {
    return res.status(404).json({ error: 'Frame index out of bounds.' });
  }

  const inputPath = resolveUnder(
    OUTPUT_DIR,
    path.join('captured', sticker.capturedDate, sticker.originalFilename)
  );
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Original sticker file not found.' });
  }

  const cacheKey = `${id}:${frameIndexInt}`;
  const cached = readCachedFrame(cacheKey);
  if (cached) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.send(cached);
  }

  try {
    // Buffer input prevents libvips from retaining a Windows file handle after the response.
    const sourceBuffer = await fs.promises.readFile(inputPath);
    const frame = await sharp(sourceBuffer, {
      page: frameIndexInt,
      limitInputPixels: MAX_DECODED_PIXELS
    })
      .resize(160, 160, { fit: 'inside' })
      .png()
      .toBuffer();
    cacheFrame(cacheKey, frame);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.send(frame);
  } catch (error) {
    console.error(`[Frame Extraction] ${id}:${frameIndexInt}:`, error.message);
    return res.status(500).json({ error: `Frame extraction failed: ${error.message}` });
  }
});
// Physical deletion is intentionally not exposed over HTTP.
// Use POST /api/library/archive to create a recoverable snapshot.

// Conversion route helpers
const CONVERSION_STATE_FIELDS = [
  'status',
  'convertedPath',
  'convertedFilename',
  'convertedAt',
  'convertedRange',
  'selectedRange',
  'selectedStartTime',
  'durationMs',
  'durationSeconds',
  'convertedSizeBytes',
  'conversion',
  'error',
  'conversionError'
];

function conversionClientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireStickerForConversion(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/i.test(id)) {
    throw conversionClientError('A valid sticker ID is required.');
  }
  const sticker = capturedStickers.find((item) => item.id === id);
  if (!sticker) throw conversionClientError('Sticker not found.', 404);
  return sticker;
}

function parseOptionalFinite(value, name, { integer = false, min = null, max = null } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw conversionClientError(`${name} must be a finite number.`);
  if (integer && !Number.isInteger(number)) throw conversionClientError(`${name} must be an integer.`);
  if (min !== null && number < min) throw conversionClientError(`${name} must be at least ${min}.`);
  if (max !== null && number > max) throw conversionClientError(`${name} must be at most ${max}.`);
  return number;
}

function parseRangeRequest(body = {}) {
  return {
    startFrame: parseOptionalFinite(body.startFrame, 'startFrame', { integer: true, min: 0 }),
    endFrame: parseOptionalFinite(body.endFrame, 'endFrame', { integer: true, min: 0 }),
    startTime: parseOptionalFinite(body.startTime, 'startTime', { min: 0 })
  };
}

function validateTransformsRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw conversionClientError('transforms must be an object.');
  }
  for (const name of ['scale', 'rotation', 'strokeWidth', 'textSize']) {
    if (value[name] !== undefined && !Number.isFinite(Number(value[name]))) {
      throw conversionClientError(`transforms.${name} must be a finite number.`);
    }
  }
  if (value.strokeActive !== undefined && typeof value.strokeActive !== 'boolean') {
    throw conversionClientError('transforms.strokeActive must be a boolean.');
  }
  for (const name of ['strokeColor', 'topText', 'bottomText', 'textColor']) {
    if (value[name] !== undefined && typeof value[name] !== 'string') {
      throw conversionClientError(`transforms.${name} must be a string.`);
    }
  }
  return normalizeTransforms(value);
}

function cloneMetadataValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function snapshotConversionState(sticker) {
  const snapshot = {};
  for (const field of CONVERSION_STATE_FIELDS) {
    snapshot[field] = Object.prototype.hasOwnProperty.call(sticker, field)
      ? { present: true, value: cloneMetadataValue(sticker[field]) }
      : { present: false };
  }
  return snapshot;
}

function restoreConversionState(sticker, snapshot) {
  for (const field of CONVERSION_STATE_FIELDS) {
    if (snapshot[field] && snapshot[field].present) {
      sticker[field] = cloneMetadataValue(snapshot[field].value);
    } else {
      delete sticker[field];
    }
  }
}

function snapshotHasValidOutput(snapshot) {
  const status = snapshot.status && snapshot.status.value;
  const convertedPath = snapshot.convertedPath && snapshot.convertedPath.value;
  if (status !== 'converted' || typeof convertedPath !== 'string' || !convertedPath) return false;
  try {
    const diskPath = resolveUnder(OUTPUT_DIR, convertedPath.replace(/^[/\\]+/, ''));
    return fs.existsSync(diskPath) && fs.statSync(diskPath).isFile();
  } catch (_) {
    return false;
  }
}

function markConversionStarted(sticker) {
  sticker.status = 'converting';
  delete sticker.error;
  delete sticker.conversionError;
  broadcast({ type: 'sticker_update', data: sticker });
}

function recordConversionFailure(sticker, snapshot, error) {
  restoreConversionState(sticker, snapshot);
  sticker.status = snapshotHasValidOutput(snapshot) ? 'converted' : 'failed';
  sticker.error = error.message;
  sticker.conversionError = {
    message: error.message,
    at: new Date().toISOString()
  };
  try {
    saveDatabase();
  } catch (saveError) {
    console.error('[Conversion] Unable to persist failure state:', saveError.message);
  }
  broadcast({ type: 'sticker_update', data: sticker });
}

function buildRangeMetadata(allDelays, range) {
  const startTimeMs = allDelays.slice(0, range.start).reduce((sum, delay) => sum + delay, 0);
  return {
    startFrame: range.start,
    endFrame: range.end,
    startTime: startTimeMs / 1000,
    durationMs: range.durationMs,
    durationSeconds: range.durationMs / 1000,
    frameDelays: [...range.delays]
  };
}

function buildConversionUpdates({
  kind,
  convertedPath,
  convertedFilename,
  range,
  sizeBytes,
  details = {}
}) {
  return {
    status: 'converted',
    convertedPath,
    convertedFilename,
    convertedAt: new Date().toISOString(),
    convertedRange: cloneMetadataValue(range),
    selectedRange: cloneMetadataValue(range),
    selectedStartTime: range.startTime,
    durationMs: range.durationMs,
    durationSeconds: range.durationSeconds,
    convertedSizeBytes: sizeBytes,
    conversion: {
      type: kind,
      range: cloneMetadataValue(range),
      startTime: range.startTime,
      durationMs: range.durationMs,
      durationSeconds: range.durationSeconds,
      details
    }
  };
}

async function assertOutputFile(filePath, sizeLimit) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Converter produced an empty output file.');
  if (stat.size > sizeLimit) {
    throw new Error(`Converted file is ${stat.size} bytes; limit is ${sizeLimit} bytes.`);
  }
  return stat.size;
}

async function promoteCandidateAndPersist({
  candidatePath,
  outputPath,
  sizeLimit,
  sticker,
  snapshot,
  updates
}) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await assertOutputFile(candidatePath, sizeLimit);

  const stagedPath = `${outputPath}.candidate-${crypto.randomUUID()}`;
  const previousPath = `${outputPath}.previous-${crypto.randomUUID()}`;
  let previousMoved = false;
  let candidatePromoted = false;

  try {
    await fs.promises.copyFile(candidatePath, stagedPath);
    await assertOutputFile(stagedPath, sizeLimit);
    if (fs.existsSync(outputPath)) {
      await fs.promises.rename(outputPath, previousPath);
      previousMoved = true;
    }
    await fs.promises.rename(stagedPath, outputPath);
    candidatePromoted = true;

    Object.assign(sticker, updates);
    delete sticker.error;
    delete sticker.conversionError;
    saveDatabase();

    if (previousMoved) await fs.promises.unlink(previousPath).catch(() => {});
    broadcast({ type: 'sticker_update', data: sticker });
    return sticker;
  } catch (error) {
    restoreConversionState(sticker, snapshot);
    if (candidatePromoted) await fs.promises.unlink(outputPath).catch(() => {});
    if (previousMoved && fs.existsSync(previousPath)) {
      await fs.promises.rename(previousPath, outputPath).catch(() => {});
    }
    throw error;
  } finally {
    await fs.promises.unlink(stagedPath).catch(() => {});
  }
}

// Every conversion for one sticker shares the queue key, so single requests
// and batch jobs never convert the same ID concurrently.
function enqueueConversion(sticker, job, { beforeStart = null } = {}) {
  return conversionQueue.enqueue(async () => {
    if (beforeStart && beforeStart() === false) return null;
    const snapshot = snapshotConversionState(sticker);
    markConversionStarted(sticker);
    try {
      return await job(snapshot);
    } catch (error) {
      recordConversionFailure(sticker, snapshot, error);
      throw error;
    }
  }, { key: sticker.id });
}

async function runQueuedConversion(res, sticker, job) {
  try {
    const result = await enqueueConversion(sticker, job);
    return res.json({ success: true, sticker: toClientSticker(result) });
  } catch (error) {
    const queueFull = error.message === 'Conversion queue is full';
    const statusCode = queueFull ? 503 : error.statusCode || 500;
    return res.status(statusCode).json({
      error: queueFull ? error.message : `Conversion failed: ${error.message}`
    });
  }
}

async function loadConversionMetadata(inputPath) {
  const metadata = await sharp(inputPath, {
    animated: true,
    limitInputPixels: MAX_DECODED_PIXELS
  }).metadata();
  const pages = Math.max(1, Number(metadata.pages) || 1);
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.pageHeight || metadata.height) || 0;
  if (!width || !height || width * height * pages > MAX_DECODED_PIXELS) {
    throw conversionClientError('Source dimensions exceed the decoded pixel limit.');
  }
  return { metadata, pages, dimensions: computeTargetDimensions(width, height) };
}

function delaysForConversion(metadata, sticker, totalFrames) {
  const source =
    Array.isArray(metadata.delay) && metadata.delay.length
      ? metadata.delay
      : Array.isArray(sticker.frameDelays) && sticker.frameDelays.length
        ? sticker.frameDelays
        : sticker.delay;
  return normalizeFrameDelays(source, totalFrames);
}

async function removeJobDirectory(jobDirectory) {
  if (!jobDirectory) return;
  await fs.promises.rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
}

function decodePngDataUri(value) {
  if (typeof value !== 'string') throw conversionClientError('pngBase64 must be a PNG data URI.');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) throw conversionClientError('pngBase64 must be a valid PNG data URI.');
  let buffer;
  try {
    buffer = decodeBase64Strict(match[1], stickerPolicy.maxBodyBytes);
  } catch (error) {
    throw conversionClientError(error.message);
  }
  if (detectMimeType(buffer) !== 'image/png') {
    throw conversionClientError('pngBase64 does not contain PNG bytes.');
  }
  return buffer;
}

function originalInputPath(sticker) {
  return resolveUnder(
    OUTPUT_DIR,
    path.join('captured', sticker.capturedDate || getTodayDateStr(), sticker.originalFilename)
  );
}

// Converts one sticker to its Telegram format. Must run inside enqueueConversion.
async function performConversion({ sticker, requestedRange, inputPath, snapshot }) {
  let jobDirectory;
  try {
    jobDirectory = await createJobDirectory(TEMP_DIR, 'convert', sticker.id);
    const { metadata, pages, dimensions } = await loadConversionMetadata(inputPath);
    const dateStr = sticker.capturedDate || getTodayDateStr();

    if (pages > 1) {
      const allDelays = delaysForConversion(metadata, sticker, pages);
      const selected = selectFrameRange({
        delays: allDelays,
        ...requestedRange,
        maxDurationMs: MAX_DURATION_MS
      });
      const range = buildRangeMetadata(allDelays, selected);

      for (let frameIndex = selected.start; frameIndex <= selected.end; frameIndex += 1) {
        const relativeIndex = frameIndex - selected.start;
        const framePath = path.join(
          jobDirectory,
          `frame_${String(relativeIndex).padStart(4, '0')}.png`
        );
        await sharp(inputPath, {
          page: frameIndex,
          limitInputPixels: MAX_DECODED_PIXELS
        })
          .resize(dimensions.width, dimensions.height, { fit: 'inside' })
          .png()
          .toFile(framePath);
      }

      const outputFilename = `sticker_${sticker.id}.webm`;
      const candidatePath = path.join(jobDirectory, outputFilename);
      const compression = await compressAnimatedWebM(
        jobDirectory,
        candidatePath,
        selected.delays
      );
      const sizeBytes = await assertOutputFile(candidatePath, ANIMATED_SIZE_LIMIT);
      const outputPath = path.join(getAnimatedDir(dateStr), outputFilename);
      const updates = buildConversionUpdates({
        kind: 'animated',
        convertedPath: `/animated/${dateStr}/${outputFilename}`,
        convertedFilename: outputFilename,
        range,
        sizeBytes,
        details: {
          encoderMode: compression.mode,
          sourceFrames: pages
        }
      });
      return promoteCandidateAndPersist({
        candidatePath,
        outputPath,
        sizeLimit: ANIMATED_SIZE_LIMIT,
        sticker,
        snapshot,
        updates
      });
    }

    if (
      (requestedRange.startFrame !== undefined && requestedRange.startFrame !== 0) ||
      (requestedRange.endFrame !== undefined && requestedRange.endFrame !== 0) ||
      (requestedRange.startTime !== undefined && requestedRange.startTime !== 0)
    ) {
      throw conversionClientError('Static stickers only support frame 0 and startTime 0.');
    }

    const outputFilename = `sticker_${sticker.id}.webp`;
    const candidatePath = path.join(jobDirectory, outputFilename);
    const compression = await compressStaticSticker(
      inputPath,
      candidatePath,
      dimensions.width,
      dimensions.height
    );
    const sizeBytes = await assertOutputFile(candidatePath, STATIC_SIZE_LIMIT);
    const outputPath = path.join(getStaticsDir(dateStr), outputFilename);
    const range = {
      startFrame: 0,
      endFrame: 0,
      startTime: 0,
      durationMs: 0,
      durationSeconds: 0,
      frameDelays: []
    };
    const updates = buildConversionUpdates({
      kind: 'static',
      convertedPath: `/statics/${dateStr}/${outputFilename}`,
      convertedFilename: outputFilename,
      range,
      sizeBytes,
      details: { quality: compression.quality }
    });
    return promoteCandidateAndPersist({
      candidatePath,
      outputPath,
      sizeLimit: STATIC_SIZE_LIMIT,
      sticker,
      snapshot,
      updates
    });
  } finally {
    await removeJobDirectory(jobDirectory);
  }
}

// Convert sticker endpoint (supporting cumulative frame ranges)
app.post('/api/convert', async (req, res) => {
  let sticker;
  let requestedRange;
  try {
    const body = req.body || {};
    sticker = requireStickerForConversion(body.id);
    requestedRange = parseRangeRequest(body);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  const inputPath = originalInputPath(sticker);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Original sticker file not found on disk.' });
  }

  return runQueuedConversion(res, sticker, (snapshot) => performConversion({
    sticker,
    requestedRange,
    inputPath,
    snapshot
  }));
});

// Edit and convert static sticker via a validated PNG data URI
app.post('/api/edit-convert-static', async (req, res) => {
  let sticker;
  let pngBuffer;
  let metadata;
  try {
    const body = req.body || {};
    sticker = requireStickerForConversion(body.id);
    if (sticker.isAnimated) {
      throw conversionClientError('Animated stickers must use /api/edit-convert-animated.');
    }
    pngBuffer = decodePngDataUri(body.pngBase64);
    metadata = await sharp(pngBuffer, {
      limitInputPixels: MAX_DECODED_PIXELS
    }).metadata();
    const width = Number(metadata.width) || 0;
    const height = Number(metadata.height) || 0;
    if (metadata.format !== 'png' || !width || !height || width * height > MAX_DECODED_PIXELS) {
      throw conversionClientError('Edited PNG dimensions or format are invalid.');
    }
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  let jobDirectory;
  try {
    jobDirectory = await createJobDirectory(TEMP_DIR, 'edit-static', sticker.id);
    const inputPath = path.join(jobDirectory, 'edited.png');
    await fs.promises.writeFile(inputPath, pngBuffer);
    pngBuffer = null;

    return await runQueuedConversion(res, sticker, async (snapshot) => {
      const dimensions = computeTargetDimensions(metadata.width, metadata.height);
      const dateStr = sticker.capturedDate || getTodayDateStr();
      const outputFilename = `sticker_${sticker.id}.webp`;
      const candidatePath = path.join(jobDirectory, outputFilename);
      const compression = await compressStaticSticker(
        inputPath,
        candidatePath,
        dimensions.width,
        dimensions.height
      );
      const sizeBytes = await assertOutputFile(candidatePath, STATIC_SIZE_LIMIT);
      const range = {
        startFrame: 0,
        endFrame: 0,
        startTime: 0,
        durationMs: 0,
        durationSeconds: 0,
        frameDelays: []
      };
      const updates = buildConversionUpdates({
        kind: 'static-edit',
        convertedPath: `/statics/${dateStr}/${outputFilename}`,
        convertedFilename: outputFilename,
        range,
        sizeBytes,
        details: {
          quality: compression.quality,
          sourceWidth: metadata.width,
          sourceHeight: metadata.height
        }
      });
      return promoteCandidateAndPersist({
        candidatePath,
        outputPath: path.join(getStaticsDir(dateStr), outputFilename),
        sizeLimit: STATIC_SIZE_LIMIT,
        sticker,
        snapshot,
        updates
      });
    });
  } catch (error) {
    if (!res.headersSent) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
    return undefined;
  } finally {
    await removeJobDirectory(jobDirectory);
  }
});

// Edit and convert animated sticker with normalized transforms
function colorToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };
}

function cleanSvgText(value) {
  return escapeXml(String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').toUpperCase());
}

function buildTextOverlay(transforms) {
  if (!transforms.topText && !transforms.bottomText) return null;
  const top = transforms.topText
    ? `<text x="256" y="60" text-anchor="middle" font-family="Impact, sans-serif" font-size="${transforms.textSize}" font-weight="bold" fill="${transforms.textColor}" stroke="#000000" stroke-width="2">${cleanSvgText(transforms.topText)}</text>`
    : '';
  const bottom = transforms.bottomText
    ? `<text x="256" y="460" text-anchor="middle" font-family="Impact, sans-serif" font-size="${transforms.textSize}" font-weight="bold" fill="${transforms.textColor}" stroke="#000000" stroke-width="2">${cleanSvgText(transforms.bottomText)}</text>`
    : '';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${top}${bottom}</svg>`,
    'utf8'
  );
}

async function centeredCompositeLayer(input, offsetX = 0, offsetY = 0) {
  const metadata = await sharp(input).metadata();
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.height) || 0;
  if (!width || !height) throw new Error('Transformed frame has invalid dimensions.');

  const rawLeft = Math.round((512 - width) / 2 + offsetX);
  const rawTop = Math.round((512 - height) / 2 + offsetY);
  const cropLeft = Math.max(0, -rawLeft);
  const cropTop = Math.max(0, -rawTop);
  const left = Math.max(0, rawLeft);
  const top = Math.max(0, rawTop);
  const visibleWidth = Math.min(width - cropLeft, 512 - left);
  const visibleHeight = Math.min(height - cropTop, 512 - top);
  if (visibleWidth <= 0 || visibleHeight <= 0) return null;

  let layerInput = input;
  if (cropLeft || cropTop || visibleWidth !== width || visibleHeight !== height) {
    layerInput = await sharp(input)
      .extract({
        left: cropLeft,
        top: cropTop,
        width: visibleWidth,
        height: visibleHeight
      })
      .png()
      .toBuffer();
  }
  return { input: layerInput, left, top };
}

app.post('/api/edit-convert-animated', async (req, res) => {
  let sticker;
  let requestedRange;
  let transforms;
  try {
    const body = req.body || {};
    sticker = requireStickerForConversion(body.id);
    if (!sticker.isAnimated) {
      throw conversionClientError('Static stickers must use /api/edit-convert-static.');
    }
    requestedRange = parseRangeRequest(body);
    transforms = validateTransformsRequest(body.transforms);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  const inputPath = resolveUnder(
    OUTPUT_DIR,
    path.join('captured', sticker.capturedDate || getTodayDateStr(), sticker.originalFilename)
  );
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Original sticker not found.' });
  }

  return runQueuedConversion(res, sticker, async (snapshot) => {
    let jobDirectory;
    try {
      jobDirectory = await createJobDirectory(TEMP_DIR, 'edit-animated', sticker.id);
      const { metadata, pages, dimensions } = await loadConversionMetadata(inputPath);
      if (pages <= 1) throw conversionClientError('Source does not contain multiple animation frames.');

      const allDelays = delaysForConversion(metadata, sticker, pages);
      const selected = selectFrameRange({
        delays: allDelays,
        ...requestedRange,
        maxDurationMs: MAX_DURATION_MS
      });
      const range = buildRangeMetadata(allDelays, selected);
      const textOverlay = buildTextOverlay(transforms);
      const scaledWidth = Math.max(1, Math.round(dimensions.width * transforms.scale));
      const scaledHeight = Math.max(1, Math.round(dimensions.height * transforms.scale));

      for (let frameIndex = selected.start; frameIndex <= selected.end; frameIndex += 1) {
        const relativeIndex = frameIndex - selected.start;
        const framePath = path.join(
          jobDirectory,
          `frame_${String(relativeIndex).padStart(4, '0')}.png`
        );

        const transformedFrame = await sharp(inputPath, {
          page: frameIndex,
          limitInputPixels: MAX_DECODED_PIXELS
        })
          .resize(scaledWidth, scaledHeight, { fit: 'inside' })
          .rotate(transforms.rotation, {
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .png()
          .toBuffer();

        const layers = [];
        if (transforms.strokeActive && transforms.strokeWidth > 0) {
          const tinted = await sharp(transformedFrame)
            .tint(colorToRgb(transforms.strokeColor))
            .png()
            .toBuffer();
          for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
            const layer = await centeredCompositeLayer(
              tinted,
              Math.round(Math.cos(angle) * transforms.strokeWidth),
              Math.round(Math.sin(angle) * transforms.strokeWidth)
            );
            if (layer) layers.push(layer);
          }
        }

        const mainLayer = await centeredCompositeLayer(transformedFrame);
        if (mainLayer) layers.push(mainLayer);
        if (textOverlay) layers.push({ input: textOverlay, left: 0, top: 0 });

        await sharp({
          create: {
            width: 512,
            height: 512,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          }
        })
          .composite(layers)
          .png()
          .toFile(framePath);
      }

      const dateStr = sticker.capturedDate || getTodayDateStr();
      const outputFilename = `sticker_${sticker.id}.webm`;
      const candidatePath = path.join(jobDirectory, outputFilename);
      const compression = await compressAnimatedWebM(
        jobDirectory,
        candidatePath,
        selected.delays
      );
      const sizeBytes = await assertOutputFile(candidatePath, ANIMATED_SIZE_LIMIT);
      const updates = buildConversionUpdates({
        kind: 'animated-edit',
        convertedPath: `/animated/${dateStr}/${outputFilename}`,
        convertedFilename: outputFilename,
        range,
        sizeBytes,
        details: {
          encoderMode: compression.mode,
          transforms: cloneMetadataValue(transforms),
          sourceFrames: pages
        }
      });
      return promoteCandidateAndPersist({
        candidatePath,
        outputPath: path.join(getAnimatedDir(dateStr), outputFilename),
        sizeLimit: ANIMATED_SIZE_LIMIT,
        sticker,
        snapshot,
        updates
      });
    } finally {
      await removeJobDirectory(jobDirectory);
    }
  });
});

// Update custom tags for a sticker
app.post('/api/stickers/:id/tags', (req, res) => {
  const { id } = req.params;
  const { tags } = req.body;

  const sticker = capturedStickers.find(s => s.id === id);
  if (!sticker) {
    return res.status(404).json({ error: 'Sticker not found' });
  }

  sticker.tags = Array.isArray(tags) ? tags.map(t => t.toLowerCase().trim()).filter(Boolean) : [];
  saveDatabase();

  console.log(`[Tags Update] Updated tags for ${id}:`, sticker.tags);
  broadcast({ type: 'sticker_update', data: sticker });

  res.json({ success: true, sticker: toClientSticker(sticker) });
});

// ----- Batch jobs -----

const MAX_JOB_ITEMS = 100;
const MAX_BATCH_TAGS = 20;
const STICKER_ID_PATTERN = /^[a-f0-9]{64}$/i;
const SYSTEM_TAG_PREFIX = 'import:';

function parseJobIds(value) {
  if (!Array.isArray(value) || !value.length) {
    throw conversionClientError('ids must be a non-empty array of sticker IDs.');
  }
  if (value.length > MAX_JOB_ITEMS) {
    throw conversionClientError(`A job can include at most ${MAX_JOB_ITEMS} stickers.`);
  }
  const ids = [...new Set(value.map((id) => String(id).toLowerCase()))];
  if (!ids.every((id) => STICKER_ID_PATTERN.test(id))) {
    throw conversionClientError('Every id must be a 64-character sticker ID.');
  }
  return ids;
}

function parseJobStartTimes(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw conversionClientError('startTimes must be an object keyed by sticker ID.');
  }
  const startTimes = {};
  for (const [id, seconds] of Object.entries(value)) {
    const parsed = parseOptionalFinite(seconds, 'startTimes value', { min: 0 });
    if (parsed !== undefined) startTimes[id.toLowerCase()] = parsed;
  }
  return startTimes;
}

function parseBatchTags(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw conversionClientError(`${name} must be an array of tags.`);
  const tags = [...new Set(value.map((tag) => String(tag).toLowerCase().trim()).filter(Boolean))];
  if (tags.length > MAX_BATCH_TAGS) throw conversionClientError(`${name} can include at most ${MAX_BATCH_TAGS} tags.`);
  if (tags.some((tag) => tag.length > 40)) throw conversionClientError('Tags can be at most 40 characters.');
  if (tags.some((tag) => tag.startsWith(SYSTEM_TAG_PREFIX))) {
    throw conversionClientError('Import tags are managed by the server and cannot be changed in a batch.');
  }
  return tags;
}

const plural = (count) => (count === 1 ? '' : 's');

app.get('/api/jobs', (_req, res) => {
  res.json(getJobsPayload());
});

// New live captures are converted like a manual import with auto-convert:
// captures that arrive close together share one job.
const AUTO_CONVERT_MAX_WAIT_MS = 15_000;
let autoConvertIds = [];
let autoConvertFirstAt = 0;
let autoConvertTimer = null;

function flushAutoConvert() {
  clearTimeout(autoConvertTimer);
  autoConvertTimer = null;
  const ids = [...new Set(autoConvertIds)];
  autoConvertIds = [];
  for (let index = 0; index < ids.length; index += MAX_JOB_ITEMS) {
    const chunk = ids.slice(index, index + MAX_JOB_ITEMS);
    startConvertJob(chunk, {}, `Convert ${chunk.length} captured sticker${plural(chunk.length)}`);
  }
}

function scheduleAutoConvert(stickerId) {
  if (!captureSettings.get().autoConvert) return;
  if (!autoConvertIds.length) autoConvertFirstAt = Date.now();
  autoConvertIds.push(stickerId);
  clearTimeout(autoConvertTimer);
  const waited = Date.now() - autoConvertFirstAt;
  if (autoConvertIds.length >= MAX_JOB_ITEMS || waited >= AUTO_CONVERT_MAX_WAIT_MS) {
    flushAutoConvert();
    return;
  }
  autoConvertTimer = setTimeout(flushAutoConvert, Math.min(AUTO_CONVERT_DELAY_MS, AUTO_CONVERT_MAX_WAIT_MS - waited));
  autoConvertTimer.unref();
}

// Queues a conversion job; every skipped ID carries its reason.
function startConvertJob(ids, startTimes, label) {
  // Resolve eligibility up front so the report explains every skipped ID.
  const pending = jobRegistry.pendingStickerIds();
  const plan = ids.map((id) => {
    const sticker = capturedStickers.find((item) => item.id === id);
    if (!sticker) return { stickerId: id, state: 'skipped', error: 'Sticker not found.' };
    if (pending.has(id)) return { stickerId: id, state: 'skipped', error: 'Already queued in another job.' };
    const inputPath = originalInputPath(sticker);
    if (!fs.existsSync(inputPath)) return { stickerId: id, state: 'skipped', error: 'Original file is missing on disk.' };
    return { stickerId: id, state: 'queued', sticker, inputPath };
  });

  const job = jobRegistry.create('convert', plan, { label });

  for (const entry of plan) {
    if (entry.state !== 'queued') continue;
    const { sticker, inputPath, stickerId } = entry;
    const requestedRange = startTimes[stickerId] !== undefined && sticker.isAnimated
      ? { startTime: startTimes[stickerId] }
      : {};
    enqueueConversion(
      sticker,
      (snapshot) => performConversion({ sticker, requestedRange, inputPath, snapshot }),
      {
        // Cancelled items are dropped here, before any file is touched.
        beforeStart: () => {
          if (jobRegistry.itemState(job.id, stickerId) !== 'queued') return false;
          jobRegistry.setItem(job.id, stickerId, { state: 'running' });
          return true;
        }
      }
    ).then(
      (result) => {
        if (result) jobRegistry.setItem(job.id, stickerId, { state: 'succeeded' });
      },
      (error) => {
        jobRegistry.setItem(job.id, stickerId, {
          state: 'failed',
          error: error.message === 'Conversion queue is full'
            ? 'The conversion queue is full. Try again later.'
            : error.message
        });
      }
    );
  }

  return job;
}

app.post('/api/jobs/convert', (req, res) => {
  let ids;
  let startTimes;
  try {
    ids = parseJobIds(req.body?.ids);
    startTimes = parseJobStartTimes(req.body?.startTimes);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  const job = startConvertJob(ids, startTimes, `Convert ${ids.length} sticker${plural(ids.length)}`);
  return res.status(202).json({ job: jobRegistry.get(job.id) });
});

app.post('/api/jobs/tags', (req, res) => {
  let ids;
  let add;
  let remove;
  try {
    ids = parseJobIds(req.body?.ids);
    add = parseBatchTags(req.body?.add, 'add');
    remove = parseBatchTags(req.body?.remove, 'remove');
    if (!add.length && !remove.length) throw conversionClientError('Provide tags to add or remove.');
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  const plan = ids.map((id) => {
    const sticker = capturedStickers.find((item) => item.id === id);
    return sticker
      ? { stickerId: id, state: 'running', sticker }
      : { stickerId: id, state: 'skipped', error: 'Sticker not found.' };
  });
  const verb = add.length && remove.length ? 'Update tags on' : add.length ? 'Add tags to' : 'Remove tags from';
  const job = jobRegistry.create('tags', plan, { label: `${verb} ${ids.length} sticker${plural(ids.length)}` });

  const previousTags = new Map();
  for (const { sticker } of plan.filter((entry) => entry.sticker)) {
    previousTags.set(sticker.id, sticker.tags);
    const current = Array.isArray(sticker.tags) ? sticker.tags : [];
    sticker.tags = [...new Set([...current.filter((tag) => !remove.includes(tag)), ...add])];
  }

  try {
    saveDatabase();
  } catch (_) {
    // All-or-nothing: restore every sticker so memory matches the database.
    for (const [id, tags] of previousTags) {
      const sticker = capturedStickers.find((item) => item.id === id);
      if (tags === undefined) delete sticker.tags;
      else sticker.tags = tags;
      jobRegistry.setItem(job.id, id, { state: 'failed', error: 'Tags could not be saved; nothing was changed.' });
    }
    return res.status(500).json({ error: 'Tags could not be saved; nothing was changed.', job: jobRegistry.get(job.id) });
  }

  for (const id of previousTags.keys()) {
    const sticker = capturedStickers.find((item) => item.id === id);
    broadcast({ type: 'sticker_update', data: sticker });
    jobRegistry.setItem(job.id, id, { state: 'succeeded' });
  }
  return res.json({ job: jobRegistry.get(job.id) });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobRegistry.cancel(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found. Job history resets when the server restarts.' });
  return res.json({ job });
});

// ----- Packs -----

function broadcastPacks() {
  broadcast({ type: 'packs_update', data: packStore.snapshot() });
}

function findSticker(id) {
  return capturedStickers.find((sticker) => sticker.id === id) || null;
}

function sendPackError(res, error, action) {
  if (error instanceof PackError) {
    return res.status(error.status).json({ error: error.message, ...(error.pack ? { pack: error.pack } : {}) });
  }
  console.error(`[Packs] ${action} failed:`, error);
  return res.status(500).json({ error: `${action} failed: ${error.message}` });
}

function requirePackId(req, res) {
  const id = String(req.params.id);
  if (!PACK_ID_PATTERN.test(id)) {
    res.status(404).json({ error: 'Pack not found.' });
    return null;
  }
  return id;
}

app.get('/api/packs', (_req, res) => {
  res.json(packStore.snapshot());
});

app.post('/api/packs', (req, res) => {
  try {
    const pack = packStore.create(req.body?.title);
    broadcastPacks();
    return res.json({ pack, ...packStore.snapshot() });
  } catch (error) {
    return sendPackError(res, error, 'Creating the pack');
  }
});

app.post('/api/packs/:id', (req, res) => {
  const id = requirePackId(req, res);
  if (!id) return undefined;
  const { title, items, revision } = req.body || {};
  try {
    const pack = packStore.update(id, { title, items, revision }, {
      resolveSticker: (stickerId) => findSticker(stickerId)
    });
    broadcastPacks();
    return res.json({ pack });
  } catch (error) {
    return sendPackError(res, error, 'Saving the pack');
  }
});

app.post('/api/packs/:id/activate', (req, res) => {
  const id = requirePackId(req, res);
  if (!id) return undefined;
  try {
    packStore.activate(id);
    broadcastPacks();
    return res.json(packStore.snapshot());
  } catch (error) {
    return sendPackError(res, error, 'Switching the current pack');
  }
});

// Deletes only the pack record; stickers and their files stay in the library.
app.post('/api/packs/:id/delete', (req, res) => {
  const id = requirePackId(req, res);
  if (!id) return undefined;
  try {
    packStore.remove(id);
    broadcastPacks();
    return res.json(packStore.snapshot());
  } catch (error) {
    return sendPackError(res, error, 'Deleting the pack');
  }
});

// Builds the ZIP in memory from the current outputs; nothing is written to disk.
app.get('/api/packs/:id/export', (req, res) => {
  const id = requirePackId(req, res);
  if (!id) return undefined;
  try {
    const pack = packStore.getPack(id);
    const result = buildPackExport(pack, {
      resolveSticker: findSticker,
      outputSize: measureOutputSize,
      readOutput: (sticker) => fs.readFileSync(resolveUnder(OUTPUT_DIR, sticker.convertedPath.replace(/^[/\\]+/, '')))
    });
    if (result.problems.length) {
      return res.status(409).json({ error: 'The pack is not ready to export.', problems: result.problems });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(result.zip.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.fileName}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`
    );
    return res.end(result.zip);
  } catch (error) {
    return sendPackError(res, error, 'Exporting the pack');
  }
});

// WebSocket Server Handshake
server.on('upgrade', (request, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  } catch (_) {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws' || !security.authorizeWebSocket(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      ...getStatusPayload(),
      stickers: capturedStickers.map(toClientSticker),
      ...getJobsPayload(),
      packs: packStore.snapshot()
    }
  }));
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

const frontendDist = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
}

app.use((error, _req, res, _next) => {
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body exceeds the configured limit.' });
  }
  console.error('[HTTP Error]', error);
  return res.status(500).json({ error: 'Internal server error.' });
});

function startServer(port = PORT) {
  if (server.listening) return server;
  server.listen(port, HOST, () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    console.log('=======================================================');
    console.log(` STICKER SERVER: http://${HOST}:${listeningPort}`);
    console.log(` Output folder: ${OUTPUT_DIR}`);
    console.log(' Capture mode: DevTools response bodies only (no CDP, DOM automation, or CDN refetch)');
    console.log(` Session budget: ${SESSION_MAX_CAPTURES} captures / ${Math.round(SESSION_MAX_MS / 60000)} min`);
    const tokenSource = ingestTokens.source();
    console.log(` Extension ingest: ${tokenSource === 'env'
      ? 'Bearer token from .env'
      : tokenSource === 'paired'
        ? 'Bearer token paired in the dashboard'
        : 'DISABLED (connect in Health or set INGEST_TOKEN)'}`);
    if (tokenSource && listeningPort !== 3001) {
      console.warn(` Warning: the capture extension only delivers to port 3001; it cannot reach port ${listeningPort}.`);
    }
    console.log('=======================================================');
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  app,
  server,
  wss,
  startServer,
  getStatusPayload,
  getOutputPaths,
  importHarFile,
  createLibraryArchive,
  processCapturedSticker
};
