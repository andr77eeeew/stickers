(function (root, factory) {
  root.CaptureQueueStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const DB_NAME = 'tiktok-sticker-devtools-queue';
  const DB_VERSION = 1;
  const STORE_NAME = 'captures';
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
        records.push(cursor.value);
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
      let earliestNextAttemptAt = null;
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve({ count: countValue, blocked, earliestNextAttemptAt });
          return;
        }
        const record = cursor.value;
        countValue += 1;
        if (record.state === 'blocked') blocked += 1;
        if (
          record.state !== 'blocked' &&
          (earliestNextAttemptAt === null ||
            record.nextAttemptAt < earliestNextAttemptAt)
        ) {
          earliestNextAttemptAt = record.nextAttemptAt;
        }
        cursor.continue();
      };
    });
  }

  async function releaseBlocked(now) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value;
      if (record.state === 'blocked') {
        record.state = 'pending';
        record.nextAttemptAt = now;
        record.lastError = null;
        cursor.update(record);
      }
      cursor.continue();
    };
    await transactionDone(transaction);
  }

  return {
    get,
    count,
    add,
    put,
    remove,
    getDue,
    summary,
    releaseBlocked
  };
});
