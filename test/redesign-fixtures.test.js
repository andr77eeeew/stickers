const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCatalogueFixture, makeStageFixture } = require('./fixtures/redesign');

test('redesign fixtures provide a deterministic 1000-item catalogue without real user data', () => {
  const catalogue = makeCatalogueFixture();
  assert.equal(catalogue.length, 1000);
  assert.equal(new Set(catalogue.map((sticker) => sticker.id)).size, 1000);
  assert.deepEqual(catalogue, makeCatalogueFixture());
  assert.ok(catalogue.some((sticker) => sticker.isAnimated));
  assert.ok(catalogue.some((sticker) => sticker.status === 'failed'));
  assert.ok(catalogue.some((sticker) => sticker.status === 'captured'));
});

test('redesign stage fixture covers pending, failed, converted and missing-media states', () => {
  const stages = makeStageFixture();
  assert.deepEqual(stages.map((sticker) => sticker.status), [
    'captured', 'failed', 'converted', 'converted', 'captured'
  ]);
  assert.equal(stages[3].health.missingConverted, true);
  assert.equal(stages[4].health.missingOriginal, true);
});
