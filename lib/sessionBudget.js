/**
 * Per-process session budget for live capture.
 * The time window starts with the first accepted unique asset, not server boot.
 */
class SessionBudget {
  constructor({ maxCaptures, maxMs, onExhausted }) {
    this.maxCaptures = maxCaptures;
    this.maxMs = maxMs;
    this.onExhausted = onExhausted || (() => {});
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.captureCount = 0;
    this.exhausted = false;
    this.exhaustReason = null;
  }

  check() {
    if (this.exhausted) {
      return { ok: false, reason: this.exhaustReason || 'session_exhausted' };
    }
    if (this.startedAt !== null && Date.now() - this.startedAt >= this.maxMs) {
      this._exhaust('session_time_limit');
      return { ok: false, reason: 'session_time_limit' };
    }
    if (this.captureCount >= this.maxCaptures) {
      this._exhaust('session_capture_limit');
      return { ok: false, reason: 'session_capture_limit' };
    }
    return { ok: true };
  }

  recordCapture() {
    if (this.startedAt === null) this.startedAt = Date.now();
    this.captureCount += 1;
    if (this.captureCount >= this.maxCaptures) this._exhaust('session_capture_limit');
  }

  _exhaust(reason) {
    if (this.exhausted) return;
    this.exhausted = true;
    this.exhaustReason = reason;
    try {
      this.onExhausted(reason);
    } catch (_) {
      // Status reporting must not break the budget.
    }
  }

  snapshot() {
    this.check();
    const elapsedMs = this.startedAt === null ? 0 : Date.now() - this.startedAt;
    return {
      captureCount: this.captureCount,
      maxCaptures: this.maxCaptures,
      remainingCaptures: Math.max(0, this.maxCaptures - this.captureCount),
      elapsedMs,
      maxMs: this.maxMs,
      remainingMs: this.startedAt === null ? this.maxMs : Math.max(0, this.maxMs - elapsedMs),
      exhausted: this.exhausted,
      exhaustReason: this.exhaustReason,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString()
    };
  }
}

module.exports = SessionBudget;