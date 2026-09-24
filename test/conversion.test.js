const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const {
  ANIMATED_SIZE_LIMIT,
  compressAnimatedWebM,
  compressStaticSticker,
  computeTargetDimensions,
  escapeXml,
  normalizeFrameDelays,
  normalizeTransforms,
  selectFrameRange
} = require('../lib/conversion');

test('selectFrameRange uses cumulative variable frame delays', () => {
  const delays = [1000, 100, 500, 700, 900];
  assert.equal(selectFrameRange({ delays, startTime: 0.95 }).start, 0);
  assert.equal(selectFrameRange({ delays, startTime: 1 }).start, 1);

  const range = selectFrameRange({ delays, startFrame: 1 });
  assert.deepEqual(range.delays, [100, 500, 700, 900]);
  assert.equal(range.durationMs, 2200);

  assert.throws(
    () => selectFrameRange({ delays: [2000, 2000], startFrame: 0, endFrame: 1 }),
    /between 1 and 3000 ms/
  );
});

test('normalizes timing, transforms, dimensions and XML safely', () => {
  assert.deepEqual(normalizeFrameDelays([0, 25, undefined], 3), [10, 25, 40]);
  assert.deepEqual(computeTargetDimensions(1000, 500), { width: 512, height: 256 });
  assert.equal(escapeXml(`<A&B "C" 'D'>`), '&lt;A&amp;B &quot;C&quot; &apos;D&apos;&gt;');

  const transforms = normalizeTransforms({
    scale: 99,
    rotation: -999,
    strokeWidth: 500,
    strokeColor: 'url(evil)',
    topText: 'x'.repeat(150)
  });
  assert.equal(transforms.scale, 2);
  assert.equal(transforms.rotation, -180);
  assert.equal(transforms.strokeWidth, 32);
  assert.equal(transforms.strokeColor, '#ffffff');
  assert.equal(transforms.topText.length, 100);
});

test('static and animated encoders enforce final size limits', { timeout: 120000 }, async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stickers-conversion-test-'));
  try {
    const staticInput = path.join(tempDir, 'static.png');
    const staticOutput = path.join(tempDir, 'static.webp');
    await sharp({
      create: { width: 700, height: 500, channels: 4, background: { r: 30, g: 120, b: 220, alpha: 1 } }
    }).png().toFile(staticInput);
    const staticResult = await compressStaticSticker(staticInput, staticOutput, 512, 366);
    assert.ok(staticResult.sizeBytes <= 500 * 1024);

    const framesDir = path.join(tempDir, 'frames');
    await fs.promises.mkdir(framesDir);
    for (let index = 0; index < 3; index += 1) {
      await sharp({
        create: {
          width: 128,
          height: 128,
          channels: 4,
          background: { r: 50 + index * 50, g: 80, b: 160, alpha: 0.8 }
        }
      }).png().toFile(path.join(framesDir, `frame_${String(index).padStart(4, '0')}.png`));
    }

    const animatedOutput = path.join(tempDir, 'animated.webm');
    const animatedResult = await compressAnimatedWebM(framesDir, animatedOutput, [100, 250, 400]);
    assert.ok(animatedResult.sizeBytes <= ANIMATED_SIZE_LIMIT);
    assert.equal((await fs.promises.stat(animatedOutput)).size, animatedResult.sizeBytes);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});