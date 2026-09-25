const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');

const STATIC_SIZE_LIMIT = 500 * 1024;
const ANIMATED_SIZE_LIMIT = 245 * 1024;
const DEFAULT_FRAME_DELAY_MS = 40;
const MAX_DURATION_MS = 3000;

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeJobKey(value) {
  return String(value || 'sticker').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

async function createJobDirectory(tempRoot, prefix, stickerId) {
  await fs.promises.mkdir(tempRoot, { recursive: true });
  return fs.promises.mkdtemp(path.join(tempRoot, `${sanitizeJobKey(prefix)}-${sanitizeJobKey(stickerId)}-`));
}

function normalizeFrameDelays(delayValue, totalFrames) {
  const source = Array.isArray(delayValue) ? delayValue : new Array(totalFrames).fill(delayValue);
  return Array.from({ length: totalFrames }, (_, index) => {
    const delay = finiteNumber(source[index], DEFAULT_FRAME_DELAY_MS);
    return clamp(Math.round(delay), 10, 10000);
  });
}

function frameForTime(delays, timeMs) {
  let elapsed = 0;
  for (let index = 0; index < delays.length; index += 1) {
    elapsed += delays[index];
    if (timeMs < elapsed) return index;
  }
  return Math.max(0, delays.length - 1);
}

function selectFrameRange({ delays, startFrame, endFrame, startTime, maxDurationMs = MAX_DURATION_MS }) {
  if (!Array.isArray(delays) || delays.length === 0) {
    throw new Error('Animation has no usable frame timing.');
  }

  let start;
  if (startFrame !== undefined && startFrame !== null && startFrame !== '') {
    start = Number(startFrame);
    if (!Number.isInteger(start)) throw new Error('startFrame must be an integer.');
  } else {
    const seconds = finiteNumber(startTime, 0);
    if (seconds < 0) throw new Error('startTime cannot be negative.');
    start = frameForTime(delays, seconds * 1000);
  }
  start = clamp(start, 0, delays.length - 1);

  let end;
  if (endFrame !== undefined && endFrame !== null && endFrame !== '') {
    end = Number(endFrame);
    if (!Number.isInteger(end)) throw new Error('endFrame must be an integer.');
    end = clamp(end, 0, delays.length - 1);
  } else {
    end = start;
    let duration = 0;
    while (end < delays.length && duration + delays[end] <= maxDurationMs) {
      duration += delays[end];
      end += 1;
    }
    end = Math.max(start, end - 1);
  }

  if (start > end) throw new Error('startFrame must be less than or equal to endFrame.');
  const selectedDelays = delays.slice(start, end + 1);
  const durationMs = selectedDelays.reduce((sum, delay) => sum + delay, 0);
  if (durationMs <= 0 || durationMs > maxDurationMs) {
    throw new Error(`Selected animation duration must be between 1 and ${maxDurationMs} ms.`);
  }

  return { start, end, delays: selectedDelays, durationMs };
}

function computeTargetDimensions(width, height, maxSide = 512) {
  const w = finiteNumber(width, 0);
  const h = finiteNumber(height, 0);
  if (w <= 0 || h <= 0) throw new Error('Image dimensions are invalid.');
  if (w >= h) return { width: maxSide, height: Math.max(1, Math.round((h * maxSide) / w)) };
  return { width: Math.max(1, Math.round((w * maxSide) / h)), height: maxSide };
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeTransforms(input = {}) {
  const color = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : fallback;
  const text = (value) => String(value || '').slice(0, 100);
  return {
    scale: clamp(finiteNumber(input.scale, 1), 0.1, 2),
    rotation: clamp(finiteNumber(input.rotation, 0), -180, 180),
    strokeActive: Boolean(input.strokeActive),
    strokeWidth: clamp(finiteNumber(input.strokeWidth, 0), 0, 32),
    strokeColor: color(input.strokeColor, '#ffffff'),
    topText: text(input.topText),
    bottomText: text(input.bottomText),
    textColor: color(input.textColor, '#ffffff'),
    textSize: Math.round(clamp(finiteNumber(input.textSize, 32), 12, 96))
  };
}

function runFFmpeg(args, { timeoutMs = 120000, maxStderrBytes = 128 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let settled = false;
    let stderr = '';

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`FFmpeg timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    child.on('error', (error) => finish(new Error(`Unable to start FFmpeg: ${error.message}`)));
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-maxStderrBytes);
    });
    child.on('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`FFmpeg exited with code ${code}${signal ? ` (${signal})` : ''}: ${stderr}`));
    });
  });
}

async function atomicReplace(candidatePath, outputPath) {
  const previousPath = `${outputPath}.previous-${crypto.randomUUID()}`;
  const hadPrevious = fs.existsSync(outputPath);
  if (hadPrevious) await fs.promises.rename(outputPath, previousPath);
  try {
    await fs.promises.rename(candidatePath, outputPath);
    if (hadPrevious) await fs.promises.unlink(previousPath).catch(() => {});
  } catch (error) {
    if (hadPrevious && fs.existsSync(previousPath)) {
      await fs.promises.rename(previousPath, outputPath).catch(() => {});
    }
    throw error;
  }
}

const STATIC_MIN_QUALITY = 30;
const STATIC_MAX_QUALITY = 95;
// effort 6 is ~100x slower than 4 on images with alpha for a few percent of size,
// so it is reserved for the encodes that can become the output.
const STATIC_FINAL_EFFORT = 6;
const STATIC_PROBE_EFFORT = 4;

async function compressStaticSticker(inputPath, outputPath, targetWidth, targetHeight, sizeLimit = STATIC_SIZE_LIMIT) {
  const pipeline = sharp(inputPath, { limitInputPixels: 40_000_000 }).resize(targetWidth, targetHeight, { fit: 'inside' });
  const encode = (quality, effort) => pipeline.clone().webp({ quality, effort }).toBuffer();
  let best = await encode(STATIC_MAX_QUALITY, STATIC_FINAL_EFFORT);
  let quality = STATIC_MAX_QUALITY;

  if (best.length > sizeLimit) {
    let low = STATIC_MIN_QUALITY;
    let high = STATIC_MAX_QUALITY - 1;
    let probe = null;
    let probeQuality = null;
    while (low <= high) {
      const candidateQuality = Math.floor((low + high) / 2);
      const buffer = await encode(candidateQuality, STATIC_PROBE_EFFORT);
      if (buffer.length <= sizeLimit) {
        probe = buffer;
        probeQuality = candidateQuality;
        low = candidateQuality + 1;
      } else {
        high = candidateQuality - 1;
      }
    }

    const finalQuality = probeQuality ?? STATIC_MIN_QUALITY;
    const final = await encode(finalQuality, STATIC_FINAL_EFFORT);
    if (final.length <= sizeLimit) {
      best = final;
      quality = finalQuality;
    } else {
      best = probe;
      quality = probeQuality;
    }
  }

  if (!best) throw new Error(`Static sticker cannot fit within ${sizeLimit} bytes.`);
  const candidatePath = `${outputPath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(candidatePath, best);
  try {
    const size = (await fs.promises.stat(candidatePath)).size;
    if (size > sizeLimit) throw new Error(`Static sticker exceeds ${sizeLimit} bytes after encoding.`);
    await atomicReplace(candidatePath, outputPath);
    return { sizeBytes: size, sizeKb: size / 1024, quality };
  } finally {
    await fs.promises.unlink(candidatePath).catch(() => {});
  }
}

function quoteConcatPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/'/g, `'\\''`);
}

async function writeConcatManifest(framesDir, frameDelaysMs) {
  const manifestPath = path.join(framesDir, `frames-${crypto.randomUUID()}.txt`);
  const lines = [];
  frameDelaysMs.forEach((delay, index) => {
    const framePath = path.join(framesDir, `frame_${String(index).padStart(4, '0')}.png`);
    lines.push(`file '${quoteConcatPath(framePath)}'`);
    lines.push(`duration ${(delay / 1000).toFixed(6)}`);
  });
  const lastPath = path.join(framesDir, `frame_${String(frameDelaysMs.length - 1).padStart(4, '0')}.png`);
  lines.push(`file '${quoteConcatPath(lastPath)}'`);
  await fs.promises.writeFile(manifestPath, `${lines.join('\n')}\n`, 'utf8');
  return manifestPath;
}

async function compressAnimatedWebM(framesDir, outputPath, frameDelaysMs, sizeLimit = ANIMATED_SIZE_LIMIT) {
  if (!Array.isArray(frameDelaysMs) || frameDelaysMs.length === 0) {
    throw new Error('Animated conversion requires frame durations.');
  }
  const durationSec = frameDelaysMs.reduce((sum, delay) => sum + delay, 0) / 1000;
  if (!(durationSec > 0 && durationSec <= MAX_DURATION_MS / 1000)) {
    throw new Error('Animated sticker duration must be no more than 3 seconds.');
  }

  const manifestPath = await writeConcatManifest(framesDir, frameDelaysMs);
  const candidatePath = `${outputPath}.${crypto.randomUUID()}.tmp.webm`;
  const passlogPrefix = path.join(framesDir, `pass-${crypto.randomUUID()}`);
  const inputArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', manifestPath, '-fps_mode', 'vfr'];
  const codecArgs = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-lag-in-frames', '0', '-auto-alt-ref', '0', '-row-mt', '1', '-an'];

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    for (const crf of [28, 34, 40, 46, 52, 58, 63]) {
      await runFFmpeg([...inputArgs, ...codecArgs, '-crf', String(crf), '-b:v', '0', '-deadline', 'good', '-cpu-used', '3', candidatePath]);
      const size = (await fs.promises.stat(candidatePath)).size;
      if (size <= sizeLimit) {
        await atomicReplace(candidatePath, outputPath);
        return { sizeBytes: size, sizeKb: size / 1024, mode: `crf-${crf}`, durationSec };
      }
    }

    const targetBitrate = Math.max(16000, Math.floor(((sizeLimit * 8) / durationSec) * 0.86));
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    await runFFmpeg([...inputArgs, ...codecArgs, '-b:v', String(targetBitrate), '-passlogfile', passlogPrefix, '-pass', '1', '-f', 'null', nullDevice]);
    await runFFmpeg([...inputArgs, ...codecArgs, '-b:v', String(targetBitrate), '-passlogfile', passlogPrefix, '-pass', '2', candidatePath]);
    const finalSize = (await fs.promises.stat(candidatePath)).size;
    if (finalSize > sizeLimit) {
      throw new Error(`Animated sticker is ${finalSize} bytes; limit is ${sizeLimit} bytes.`);
    }
    await atomicReplace(candidatePath, outputPath);
    return { sizeBytes: finalSize, sizeKb: finalSize / 1024, mode: 'two-pass', durationSec };
  } finally {
    await fs.promises.unlink(candidatePath).catch(() => {});
    await fs.promises.unlink(manifestPath).catch(() => {});
    const passlogDir = path.dirname(passlogPrefix);
    const passlogBase = path.basename(passlogPrefix);
    const files = await fs.promises.readdir(passlogDir).catch(() => []);
    await Promise.all(files.filter((name) => name.startsWith(passlogBase)).map((name) => fs.promises.unlink(path.join(passlogDir, name)).catch(() => {})));
  }
}

module.exports = {
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
  runFFmpeg,
  selectFrameRange
};