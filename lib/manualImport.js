/**
 * Normalize user-uploaded media into animated/static WebP for the sticker pipeline.
 * Local-only: no TikTok network I/O.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v']);

function extOf(name = '') {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function isSupportedFilename(name) {
  const extension = extOf(name);
  return IMAGE_EXTS.has(extension) || VIDEO_EXTS.has(extension);
}

function runFfmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      proc.kill('SIGKILL');
      settled = true;
      reject(new Error(`FFmpeg timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    proc.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function inputForSharp(input) {
  if (Buffer.isBuffer(input) && input.length) return input;
  if (typeof input === 'string' && fs.existsSync(input)) return input;
  throw new Error('Input media is empty or missing.');
}

/**
 * Convert a supported media Buffer or disk path into a WebP buffer.
 */
async function normalizeToWebp(
  input,
  originalName,
  tempDir,
  { maxDecodedPixels = 64 * 1024 * 1024 } = {}
) {
  if (!isSupportedFilename(originalName)) {
    throw new Error(
      `Unsupported type for "${originalName}". Use png, jpg, webp, gif, mp4, webm, mov, etc.`
    );
  }

  const extension = extOf(originalName);
  const stamp = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tempDir, `manual_${stamp}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    if (VIDEO_EXTS.has(extension)) {
      let inputPath = input;
      if (Buffer.isBuffer(input)) {
        if (!input.length) throw new Error('Input media is empty.');
        inputPath = path.join(workDir, `input${extension}`);
        fs.writeFileSync(inputPath, input);
      } else if (typeof input !== 'string' || !fs.existsSync(input)) {
        throw new Error('Uploaded video file is missing.');
      }

      const outputPath = path.join(workDir, 'out.webp');
      await runFfmpeg([
        '-y',
        '-max_pixels',
        String(maxDecodedPixels),
        '-i',
        inputPath,
        '-t',
        '3.0',
        '-vf',
        "fps=20,scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
        '-c:v',
        'libwebp',
        '-lossless',
        '0',
        '-compression_level',
        '4',
        '-q:v',
        '80',
        '-loop',
        '0',
        '-an',
        '-vsync',
        '0',
        outputPath
      ]);

      const webpBuffer = fs.readFileSync(outputPath);
      if (!webpBuffer.length) throw new Error('FFmpeg produced an empty WebP.');
      return { webpBuffer, notes: `video->webp (${extension})` };
    }

    const sharpInput = inputForSharp(input);
    const metadata = await sharp(sharpInput, {
      animated: true,
      limitInputPixels: maxDecodedPixels
    }).metadata();
    const pages = Math.max(1, Number(metadata.pages) || 1);
    const width = Number(metadata.width) || 0;
    const height = Number(metadata.pageHeight || metadata.height) || 0;
    if (!width || !height || width * height * pages > maxDecodedPixels) {
      throw new Error('Decoded media exceeds the configured pixel limit.');
    }

    if (pages > 1) {
      const webpBuffer = await sharp(sharpInput, {
        animated: true,
        limitInputPixels: maxDecodedPixels
      })
        .webp({ quality: 90, effort: 4 })
        .toBuffer();
      return { webpBuffer, notes: `animated image->webp (${extension}, ${pages} frames)` };
    }

    const webpBuffer = await sharp(sharpInput, { limitInputPixels: maxDecodedPixels })
      .ensureAlpha()
      .webp({ quality: 92, effort: 4 })
      .toBuffer();
    return { webpBuffer, notes: `static image->webp (${extension})` };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {
      // A later health report will expose leftover temp directories.
    }
  }
}

async function normalizeFileToWebp(inputPath, originalName, tempDir, options) {
  const input = IMAGE_EXTS.has(extOf(originalName))
    ? await fs.promises.readFile(inputPath)
    : inputPath;
  return normalizeToWebp(input, originalName, tempDir, options);
}

module.exports = {
  IMAGE_EXTS,
  VIDEO_EXTS,
  isSupportedFilename,
  normalizeToWebp,
  normalizeFileToWebp,
  extOf,
  runFfmpeg
};