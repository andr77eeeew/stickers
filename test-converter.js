const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const {
  compressAnimatedWebM,
  compressStaticSticker,
  computeTargetDimensions,
  normalizeFrameDelays,
  selectFrameRange
} = require('./lib/conversion');

async function main() {
  const inputArg = process.argv[2];
  const outputArg = process.argv[3];
  if (!inputArg || !outputArg) {
    throw new Error('Usage: node test-converter.js <input.webp> <output-directory>');
  }

  const inputPath = path.resolve(inputArg);
  const outputDir = path.resolve(outputArg);
  if (!fs.existsSync(inputPath)) throw new Error(`Input file does not exist: ${inputPath}`);
  await fs.promises.mkdir(outputDir, { recursive: true });

  const metadata = await sharp(inputPath, { animated: true, limitInputPixels: 40_000_000 }).metadata();
  const totalFrames = metadata.pages || 1;
  const dimensions = computeTargetDimensions(metadata.width, metadata.pageHeight || metadata.height);

  if (totalFrames === 1) {
    const outputPath = path.join(outputDir, `${path.parse(inputPath).name}.webp`);
    const result = await compressStaticSticker(inputPath, outputPath, dimensions.width, dimensions.height);
    console.log(JSON.stringify({ outputPath, ...result }, null, 2));
    return;
  }

  const delays = normalizeFrameDelays(metadata.delay, totalFrames);
  const range = selectFrameRange({ delays });
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sticker-converter-smoke-'));
  try {
    for (let index = range.start; index <= range.end; index += 1) {
      const relativeIndex = index - range.start;
      await sharp(inputPath, { page: index, limitInputPixels: 40_000_000 })
        .resize(dimensions.width, dimensions.height, { fit: 'inside' })
        .png()
        .toFile(path.join(tempDir, `frame_${String(relativeIndex).padStart(4, '0')}.png`));
    }
    const outputPath = path.join(outputDir, `${path.parse(inputPath).name}.webm`);
    const result = await compressAnimatedWebM(tempDir, outputPath, range.delays);
    console.log(JSON.stringify({ outputPath, range, ...result }, null, 2));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});