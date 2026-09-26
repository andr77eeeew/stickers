const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE_VERSION = 1;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

class IngestTokenError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Bearer token for the capture extension.
 * INGEST_TOKEN from .env always wins; otherwise the dashboard can pair the
 * extension by creating a token stored next to the library (output/ is not
 * tracked by Git and the file is never part of archive snapshots).
 */
class IngestTokenStore {
  constructor({ envToken = '', filePath, fileSystem = fs, now = () => new Date().toISOString() }) {
    this.envToken = String(envToken || '').trim();
    this.filePath = filePath;
    this.fs = fileSystem;
    this.now = now;
    this.paired = this.envToken ? null : this.readFile();
  }

  readFile() {
    if (!this.filePath || !this.fs.existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && parsed.version === TOKEN_FILE_VERSION && TOKEN_PATTERN.test(parsed.token)) {
        return { token: parsed.token, createdAt: parsed.createdAt || null };
      }
    } catch (_) {
      // A damaged file is treated as "not paired"; pairing again replaces it.
    }
    return null;
  }

  current() {
    if (this.envToken) return this.envToken;
    return this.paired ? this.paired.token : '';
  }

  source() {
    if (this.envToken) return 'env';
    return this.paired ? 'paired' : null;
  }

  status() {
    return {
      enabled: Boolean(this.current()),
      source: this.source(),
      createdAt: this.envToken ? null : this.paired ? this.paired.createdAt : null
    };
  }

  assertPairable() {
    if (this.envToken) {
      throw new IngestTokenError(
        'INGEST_TOKEN is set in .env and takes priority. Remove it from .env to manage the connection here.',
        409,
        'ENV_TOKEN'
      );
    }
  }

  pair() {
    this.assertPairable();
    const token = crypto.randomBytes(32).toString('base64url');
    const record = { version: TOKEN_FILE_VERSION, token, createdAt: this.now() };
    this.writeAtomic(`${JSON.stringify(record, null, 2)}\n`);
    this.paired = { token, createdAt: record.createdAt };
    return token;
  }

  unpair() {
    this.assertPairable();
    if (this.filePath && this.fs.existsSync(this.filePath)) this.fs.unlinkSync(this.filePath);
    this.paired = null;
  }

  writeAtomic(contents) {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
      this.fs.writeFileSync(temporaryPath, contents, { mode: 0o600, flag: 'wx' });
      this.fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (this.fs.existsSync(temporaryPath)) {
        try { this.fs.unlinkSync(temporaryPath); } catch (_) {}
      }
    }
  }
}

module.exports = { IngestTokenStore, IngestTokenError };
