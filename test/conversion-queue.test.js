const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversionQueue } = require('../ConversionQueue');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('serializes jobs with the same key while allowing unrelated jobs', async () => {
  const queue = new ConversionQueue(2);
  const firstGate = deferred();
  const otherGate = deferred();
  const started = [];

  const first = queue.enqueue(async () => {
    started.push('same:first');
    await firstGate.promise;
  }, { key: 'same' });

  const second = queue.enqueue(async () => {
    started.push('same:second');
  }, { key: 'same' });

  const other = queue.enqueue(async () => {
    started.push('other');
    await otherGate.promise;
  }, { key: 'other' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['same:first', 'other']);

  firstGate.resolve();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['same:first', 'other', 'same:second']);

  otherGate.resolve();
  await Promise.all([second, other]);
  assert.equal(queue.getSnapshot().running, 0);
});

test('rejects work once the pending queue reaches its bound', async () => {
  const queue = new ConversionQueue(1, { maxQueueLength: 1 });
  const gate = deferred();

  const running = queue.enqueue(() => gate.promise, { key: 'one' });
  const pending = queue.enqueue(async () => {}, { key: 'two' });

  await assert.rejects(
    queue.enqueue(async () => {}, { key: 'three' }),
    /queue is full/i
  );

  gate.resolve();
  await Promise.all([running, pending]);
});