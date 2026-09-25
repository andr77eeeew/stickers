// Editor parameters and the animation window. Ranges never exceed what the
// server accepts (lib/conversion.js normalizeTransforms).

export const EDITOR_LIMITS = {
  scale: { min: 0.5, max: 2, step: 0.05 },
  rotation: { min: -180, max: 180, step: 1 },
  strokeWidth: { min: 1, max: 20, step: 1 },
  textLength: 100,
  windowSeconds: 3
};

export const DEFAULT_PARAMS = {
  scale: 1,
  rotation: 0,
  strokeActive: false,
  strokeWidth: 6,
  strokeColor: '#ffffff',
  topText: '',
  bottomText: ''
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const normalizeParams = (params) => {
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    scale: clamp(number(params.scale, 1), EDITOR_LIMITS.scale.min, EDITOR_LIMITS.scale.max),
    rotation: Math.round(clamp(number(params.rotation, 0), EDITOR_LIMITS.rotation.min, EDITOR_LIMITS.rotation.max)),
    strokeActive: Boolean(params.strokeActive),
    strokeWidth: Math.round(clamp(number(params.strokeWidth, 6), EDITOR_LIMITS.strokeWidth.min, EDITOR_LIMITS.strokeWidth.max)),
    strokeColor: /^#[0-9a-fA-F]{6}$/.test(String(params.strokeColor)) ? String(params.strokeColor).toLowerCase() : '#ffffff',
    topText: String(params.topText || '').slice(0, EDITOR_LIMITS.textLength),
    bottomText: String(params.bottomText || '').slice(0, EDITOR_LIMITS.textLength)
  };
};

export const sameEditorState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Per-frame delays in milliseconds, as the server would use them. */
export const getFrameDelays = (sticker) => {
  if (!sticker?.isAnimated) return [];
  const frames = Math.max(1, Number(sticker.frames) || 1);
  if (Array.isArray(sticker.frameDelays) && sticker.frameDelays.length === frames) {
    return sticker.frameDelays.map((delay) => Math.max(0, Number(delay) || 0));
  }
  const delay = Number(sticker.delay) > 0 ? Number(sticker.delay) : 40;
  return Array.from({ length: frames }, () => delay);
};

export const frameIndexAt = (delays, seconds) => {
  let elapsed = 0;
  for (let index = 0; index < delays.length; index += 1) {
    if (elapsed + delays[index] / 1000 > seconds + 1e-6) return index;
    elapsed += delays[index] / 1000;
  }
  return Math.max(0, delays.length - 1);
};

/**
 * The selected slice: a fixed window of at most 3 s whose end follows the
 * chosen start. Short sources get a shorter window automatically.
 */
export const getAnimationWindow = (sticker, requestedStart = 0) => {
  const delays = getFrameDelays(sticker);
  const sourceDuration = delays.reduce((sum, delay) => sum + delay, 0) / 1000;
  const length = Math.min(EDITOR_LIMITS.windowSeconds, sourceDuration);
  const maxStart = Math.max(0, sourceDuration - length);
  const start = clamp(Number(requestedStart) || 0, 0, maxStart);
  const end = start + length;
  const startFrame = frameIndexAt(delays, start);
  const endFrame = Math.max(startFrame, frameIndexAt(delays, Math.max(start, end - 0.001)));
  return { start, end, length, maxStart, sourceDuration, startFrame, endFrame, delays };
};

/** Evenly spaced frame indexes inside the window for the filmstrip. */
export const sampleFrames = (startFrame, endFrame, count = 8) => {
  const span = endFrame - startFrame;
  if (span <= 0) return [startFrame];
  const total = Math.min(count, span + 1);
  const frames = Array.from({ length: total }, (_, index) => startFrame + Math.round((span * index) / (total - 1)));
  return [...new Set(frames)];
};
