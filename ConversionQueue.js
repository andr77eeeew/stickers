class ConversionQueue {
  constructor(maxConcurrency = 2) {
    this.maxConcurrency = maxConcurrency;
    this.runningCount = 0;
    this.queue = [];
  }

  /**
   * Pushes a job to the execution queue
   * @param {Function} job - An async function returning a Promise
   * @returns {Promise} Resolves when the underlying job completes
   */
  enqueue(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.next();
    });
  }

  next() {
    if (this.runningCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const { job, resolve, reject } = this.queue.shift();
    this.runningCount++;

    console.log(`[Queue] Starting a conversion job. Active: ${this.runningCount}/${this.maxConcurrency}. Pending: ${this.queue.length}`);

    job()
      .then((val) => {
        resolve(val);
      })
      .catch((err) => {
        reject(err);
      })
      .finally(() => {
        this.runningCount--;
        console.log(`[Queue] Conversion job completed. Active: ${this.runningCount}/${this.maxConcurrency}. Running next...`);
        this.next();
      });
  }
}

module.exports = new ConversionQueue(2); // Restrict to maximum 2 concurrent encodes
