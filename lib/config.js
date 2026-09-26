/**
 * Runtime safety configuration (env-overridable).
 *
 * Capture is intentionally bytes-only. There is no CDP or server-side CDN
 * download switch in this configuration anymore.
 */
require('dotenv').config({ quiet: true });

const HOST = '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, parseInt(process.env.PORT || '3001', 10) || 3001));
const INGEST_TOKEN = String(process.env.INGEST_TOKEN || '').trim();
const captureMode = INGEST_TOKEN ? 'devtools' : 'offline';

const OUTPUT_DIR = process.env.STICKER_OUTPUT_DIR || '';
const TEMP_DIR = process.env.STICKER_TEMP_DIR || '';

const DASHBOARD_ORIGINS = new Set(
  [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    ...(process.env.DASHBOARD_ORIGINS || '').split(',')
  ]
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

const MAX_DECODED_PIXELS = Math.max(
  1_000_000,
  parseInt(process.env.MAX_DECODED_PIXELS || String(64 * 1024 * 1024), 10) || 64 * 1024 * 1024
);
const MANUAL_FILE_MAX_BYTES = Math.max(
  1024,
  parseInt(process.env.MANUAL_FILE_MAX_BYTES || String(40 * 1024 * 1024), 10) || 40 * 1024 * 1024
);
const MANUAL_REQUEST_MAX_BYTES = Math.max(
  MANUAL_FILE_MAX_BYTES,
  parseInt(process.env.MANUAL_REQUEST_MAX_BYTES || String(160 * 1024 * 1024), 10) || 160 * 1024 * 1024
);
const HAR_MAX_BYTES = Math.max(
  1024,
  parseInt(process.env.HAR_MAX_BYTES || String(128 * 1024 * 1024), 10) || 128 * 1024 * 1024
);

const SESSION_MAX_CAPTURES = Math.max(
  1,
  parseInt(process.env.SESSION_MAX_CAPTURES || '25', 10) || 25
);
const SESSION_MAX_MS = Math.max(
  60_000,
  parseInt(process.env.SESSION_MAX_MS || String(20 * 60 * 1000), 10) || 20 * 60 * 1000
);

const CAPTURE_MIN_INTERVAL_MS = Math.max(
  200,
  parseInt(process.env.CAPTURE_MIN_INTERVAL_MS || '600', 10) || 600
);
const CAPTURE_JITTER_MS = Math.max(
  0,
  parseInt(process.env.CAPTURE_JITTER_MS || '800', 10) || 800
);

const INGEST_RATE_WINDOW_MS = 60_000;
const INGEST_RATE_MAX = Math.max(
  5,
  parseInt(process.env.INGEST_RATE_MAX || '40', 10) || 40
);
// Captures arriving close together are converted as one job.
const AUTO_CONVERT_DELAY_MS = Math.max(
  0,
  parseInt(process.env.AUTO_CONVERT_DELAY_MS || '4000', 10) || 0
);

module.exports = {
  HOST,
  PORT,
  captureMode,
  INGEST_TOKEN,
  OUTPUT_DIR,
  TEMP_DIR,
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
};