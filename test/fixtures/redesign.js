// Synthetic UI fixtures only. Never copy the user's database or media into Git.
function makeStickerFixture(index, overrides = {}) {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError('index must be a non-negative integer');
  }

  const id = index.toString(16).padStart(64, '0');
  const isAnimated = index % 2 === 1;
  const status = index % 23 === 0 ? 'failed' : index % 17 === 0 ? 'captured' : 'converted';
  const extension = isAnimated ? 'webm' : 'webp';

  return {
    id,
    originalFilename: `synthetic-${id.slice(-8)}.${extension}`,
    capturedDate: '2026-01-01',
    isAnimated,
    status,
    tags: index % 5 === 0 ? ['sample'] : [],
    width: 240,
    height: 240,
    frames: isAnimated ? 40 : undefined,
    duration: isAnimated ? 2.4 : undefined,
    originalPath: `captured/2026-01-01/synthetic-${id.slice(-8)}.${extension}`,
    convertedPath: status === 'converted'
      ? `${isAnimated ? 'animated' : 'statics'}/2026-01-01/synthetic-${id.slice(-8)}.${extension}`
      : undefined,
    ...overrides
  };
}

function makeCatalogueFixture(count = 1000) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('count must be a non-negative integer');
  }
  return Array.from({ length: count }, (_, index) => makeStickerFixture(index));
}

function makeStageFixture() {
  return [
    makeStickerFixture(0, { status: 'captured', convertedPath: undefined }),
    makeStickerFixture(1, { status: 'failed', convertedPath: undefined }),
    makeStickerFixture(2, { status: 'converted' }),
    makeStickerFixture(3, { status: 'converted', convertedPath: undefined, health: { missingConverted: true } }),
    makeStickerFixture(4, { status: 'captured', originalPath: undefined, health: { missingOriginal: true } })
  ];
}

module.exports = { makeStickerFixture, makeCatalogueFixture, makeStageFixture };
