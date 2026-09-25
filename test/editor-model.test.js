const { test } = require('node:test');
const assert = require('node:assert/strict');

const modelPromise = import('../frontend/src/lib/editorModel.js');
const historyPromise = import('../frontend/src/lib/editorHistory.js');

test('editor parameters are clamped to what the server accepts', async () => {
  const { normalizeParams } = await modelPromise;
  const params = normalizeParams({
    scale: 9, rotation: -500.4, strokeActive: 1, strokeWidth: 0.2, strokeColor: 'red', topText: 'x'.repeat(150), bottomText: null
  });
  assert.deepEqual(params, {
    scale: 2, rotation: -180, strokeActive: true, strokeWidth: 1, strokeColor: '#ffffff', topText: 'x'.repeat(100), bottomText: ''
  });
});

test('animation window is at most 3 s, follows the start and shrinks for short sources', async () => {
  const { getAnimationWindow, sampleFrames } = await modelPromise;
  const long = { isAnimated: true, frames: 96, delay: 50 }; // 4.8 s
  const window = getAnimationWindow(long, 0.4);
  assert.equal(window.sourceDuration, 4.8);
  assert.equal(window.length, 3);
  assert.equal(window.start, 0.4);
  assert.ok(Math.abs(window.end - 3.4) < 1e-9);
  assert.ok(Math.abs(window.maxStart - 1.8) < 1e-9);
  assert.equal(window.startFrame, 8);
  assert.equal(window.endFrame, 67);
  assert.equal(getAnimationWindow(long, 99).start, window.maxStart, 'start is clamped');

  const short = getAnimationWindow({ isAnimated: true, frames: 20, frameDelays: Array(20).fill(100) }, 1);
  assert.equal(short.length, 2);
  assert.equal(short.maxStart, 0);
  assert.equal(short.start, 0);

  assert.deepEqual(sampleFrames(8, 67, 8), [8, 16, 25, 33, 42, 50, 59, 67]);
  assert.deepEqual(sampleFrames(3, 3), [3]);
});

test('undo history records gestures, not every intermediate value', async () => {
  const { createEditorHistory, editorHistoryReducer: reduce, canUndo, isDirty } = await historyPromise;
  const { DEFAULT_PARAMS } = await modelPromise;
  let state = createEditorHistory({ params: DEFAULT_PARAMS, start: 0 });
  assert.equal(canUndo(state), false);

  for (const scale of [1.1, 1.2, 1.3]) state = reduce(state, { type: 'update', patch: { params: { scale } } });
  state = reduce(state, { type: 'checkpoint' });
  state = reduce(state, { type: 'update', patch: { params: { rotation: 45 } } });
  state = reduce(state, { type: 'checkpoint' });
  assert.equal(state.past.length, 2, 'one step per gesture');
  assert.equal(isDirty(state), true);

  state = reduce(state, { type: 'undo' });
  assert.equal(state.current.params.rotation, 0);
  assert.equal(state.current.params.scale, 1.3);

  state = reduce(state, { type: 'update', patch: { start: 1.5 } });
  state = reduce(state, { type: 'undo' });
  assert.equal(state.current.start, 0, 'uncommitted live change is undone first');
  assert.equal(state.current.params.scale, 1.3);

  state = reduce(state, { type: 'reset' });
  assert.equal(isDirty(state), false);
  state = reduce(state, { type: 'undo' });
  assert.equal(state.current.params.scale, 1.3, 'reset itself can be undone');
});
