class ConversionQueue {
  constructor(maxConcurrency = 2, { maxQueueLength = 100 } = {}) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new TypeError('maxConcurrency must be a positive integer');
    }

    this.maxConcurrency = maxConcurrency;
    this.maxQueueLength = maxQueueLength;
    this.runningCount = 0;
    this.queue = [];
    this.activeKeys = new Set();
  }

  /**
   * Pushes a job to the execution queue. Jobs sharing a key never overlap,
   * while unrelated stickers can still use the global concurrency budget.
   *
   * @param {Function} job - An async function returning a Promise
   * @param {{key?: string|null}} options
   * @returns {Promise} Resolves when the underlying job completes
   */
  enqueue(job, { key = null } = {}) {
    if (typeof job !== 'function') {
      return Promise.reject(new TypeError('job must be a function'));
    }

    if (this.queue.length >= this.maxQueueLength) {
      return Promise.reject(new Error('Conversion queue is full'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject, key: key || null });
      this.next();
    });
  }

  next() {
    while (this.runningCount < this.maxConcurrency && this.queue.length > 0) {
      const runnableIndex = this.queue.findIndex(({ key }) => !key || !this.activeKeys.has(key));
      if (runnableIndex === -1) return;

      const [{ job, resolve, reject, key }] = this.queue.splice(runnableIndex, 1);
      this.runningCount += 1;
      if (key) this.activeKeys.add(key);

      console.log(`[Queue] Starting a conversion job. Active: ${this.runningCount}/${this.maxConcurrency}. Pending: ${this.queue.length}`);

      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          this.runningCount -= 1;
          if (key) this.activeKeys.delete(key);
          console.log(`[Queue] Conversion job completed. Active: ${this.runningCount}/${this.maxConcurrency}. Running next...`);
          queueMicrotask(() => this.next());
        });
    }
  }

  getSnapshot() {
    return {
      maxConcurrency: this.maxConcurrency,
      maxQueueLength: this.maxQueueLength,
      running: this.runningCount,
      pending: this.queue.length,
      activeKeys: [...this.activeKeys]
    };
  }
}

const defaultQueue = new ConversionQueue(2);

module.exports = defaultQueue;
module.exports.ConversionQueue = ConversionQueue;