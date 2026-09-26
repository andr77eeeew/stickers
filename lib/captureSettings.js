const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SETTINGS_VERSION = 1;
const DEFAULTS = Object.freeze({ autoConvert: true });

/**
 * Small persisted settings for live capture. Auto-convert defaults to on,
 * the same as the manual import panel.
 */
class CaptureSettings {
  constructor({ filePath, fileSystem = fs }) {
    this.filePath = filePath;
    this.fs = fileSystem;
    this.values = { ...DEFAULTS, ...this.read() };
  }

  read() {
    if (!this.fs.existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || parsed.version !== SETTINGS_VERSION) return {};
      return typeof parsed.autoConvert === 'boolean' ? { autoConvert: parsed.autoConvert } : {};
    } catch (_) {
      return {};
    }
  }

  get() {
    return { ...this.values };
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || typeof patch.autoConvert !== 'boolean') {
      const error = new Error('autoConvert must be true or false.');
      error.status = 400;
      throw error;
    }
    const next = { ...this.values, autoConvert: patch.autoConvert };
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
      this.fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: SETTINGS_VERSION, ...next }, null, 2)}\n`,
        { flag: 'wx' }
      );
      this.fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (this.fs.existsSync(temporaryPath)) {
        try { this.fs.unlinkSync(temporaryPath); } catch (_) {}
      }
    }
    this.values = next;
    return this.get();
  }
}

module.exports = { CaptureSettings };
