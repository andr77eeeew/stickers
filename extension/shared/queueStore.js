(function (root, factory) {
  root.CaptureQueueStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const DB_NAME = 'tiktok-sticker-devtools-queue';
  const DB_VERSION = 1;
  const STORE_NAME = 'captures';
  // Held records (blocked or paused) are never due on their own.
  const HELD_STATES = ['blocked', 'paused'];
  const HELD_UNTIL = Number.MAX_SAFE_INTEGER;
  let databasePromise;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error || new Error('IndexedDB transaction aborted'));
      transaction.onerror = () =>
        reject(transaction.error || new Error('IndexedDB transaction failed'));
    });
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: 'id'
        });
        store.createIndex('nextAttemptAt', 'nextAttemptAt', { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return databasePromise;
  }

  async function get(id) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    return requestResult(transaction.objectStore(STORE_NAME).get(id));
  }

  async function count() {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    return requestResult(transaction.objectStore(STORE_NAME).count());
  }

  async function add(record) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).add(record);
    await transactionDone(transaction);
  }

  async function put(record) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  }

  async function remove(id) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  }

  async function getDue(now, limit) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const index = transaction.objectStore(STORE_NAME).index('nextAttemptAt');
    const range = IDBKeyRange.upperBound(now);
    return new Promise((resolve, reject) => {
      const records = [];
      const request = index.openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= limit) {
          resolve(records);
          return;
        }
        if (!HELD_STATES.includes(cursor.value.state)) records.push(cursor.value);
        cursor.continue();
      };
    });
  }

  async function summary() {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
      let countValue = 0;
      let blocked = 0;
      let paused = 0;
      let earliestNextAttemptAt = null;
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve({ count: countValue, blocked, paused, earliestNextAttemptAt });
          return;
        }
        const record = cursor.value;
        countValue += 1;
        if (record.state === 'blocked') blocked += 1;
        if (record.state === 'paused') paused += 1;
        if (
          !HELD_STATES.includes(record.state) &&
          (earliestNextAttemptAt === null ||
            record.nextAttemptAt < earliestNextAttemptAt)
        ) {
          earliestNextAttemptAt = record.nextAttemptAt;
        }
        cursor.continue();
      };
    });
  }

  async function updateEach(mutate) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value;
      if (mutate(record)) cursor.update(record);
      cursor.continue();
    };
    await transactionDone(transaction);
  }

  function release(states, now) {
    return updateEach((record) => {
      if (!states.includes(record.state)) return false;
      record.state = 'pending';
      record.nextAttemptAt = now;
      record.lastError = null;
      return true;
    });
  }

  function releaseBlocked(now) {
    return release(['blocked'], now);
  }

  function releaseHeld(now) {
    return release(HELD_STATES, now);
  }

  function releasePaused(now) {
    return release(['paused'], now);
  }

  function pausePending(reason) {
    return updateEach((record) => {
      if (record.state !== 'pending') return false;
      record.state = 'paused';
      record.nextAttemptAt = HELD_UNTIL;
      record.lastError = reason;
      return true;
    });
  }

  // Metadata of held records for the UI; payload bytes stay in the store.
  async function listHeld(limit) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
      const records = [];
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= limit) {
          resolve(records);
          return;
        }
        const record = cursor.value;
        if (HELD_STATES.includes(record.state)) {
          records.push({
            id: record.id,
            state: record.state,
            attempts: record.attempts,
            createdAt: record.createdAt,
            lastError: record.lastError,
            mimeType: record.payload && record.payload.mimeType,
            base64Length:
              record.payload && typeof record.payload.contentBase64 === 'string'
                ? record.payload.contentBase64.length
                : 0
          });
        }
        cursor.continue();
      };
    });
  }

  return {
    HELD_UNTIL,
    get,
    count,
    add,
    put,
    remove,
    getDue,
    summary,
    releaseBlocked,
    releaseHeld,
    releasePaused,
    pausePending,
    listHeld
  };
});
