const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 2;

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeHistoricalUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return value;
  }
}

function validateSticker(sticker, index) {
  if (!isPlainObject(sticker)) throw new Error(`Sticker at index ${index} must be an object.`);
  if (typeof sticker.id !== 'string' || !/^[a-f0-9]{64}$/i.test(sticker.id)) {
    throw new Error(`Sticker at index ${index} has an invalid id.`);
  }
  if (
    typeof sticker.originalFilename !== 'string' ||
    !sticker.originalFilename ||
    path.basename(sticker.originalFilename) !== sticker.originalFilename
  ) {
    throw new Error(`Sticker at index ${index} has an unsafe originalFilename.`);
  }
  if (
    sticker.capturedDate !== undefined &&
    !/^\d{4}-\d{2}-\d{2}$/.test(String(sticker.capturedDate))
  ) {
    throw new Error(`Sticker at index ${index} has an invalid capturedDate.`);
  }
}

function normalizeDatabaseDocument(parsed) {
  const wasLegacyArray = Array.isArray(parsed);
  const source = wasLegacyArray ? parsed : parsed && parsed.stickers;
  if (!Array.isArray(source)) throw new Error('Sticker database must contain a stickers array.');
  if (!wasLegacyArray && parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported sticker database schemaVersion: ${parsed.schemaVersion}.`);
  }

  let changed = wasLegacyArray;
  const stickers = source.map((rawSticker, index) => {
    validateSticker(rawSticker, index);
    const sticker = { ...rawSticker };
    if (!sticker.capturedDate) {
      sticker.capturedDate =
        typeof sticker.capturedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sticker.capturedAt)
          ? sticker.capturedAt.slice(0, 10)
          : new Date().toISOString().slice(0, 10);
      changed = true;
    }
    const sanitizedUrl = sanitizeHistoricalUrl(sticker.originalUrl);
    if (sanitizedUrl !== sticker.originalUrl) {
      sticker.originalUrl = sanitizedUrl;
      changed = true;
    }
    return sticker;
  });

  return {
    document: { schemaVersion: SCHEMA_VERSION, stickers },
    stickers,
    changed,
    migratedFromLegacyArray: wasLegacyArray
  };
}

class StickerDatabase {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.backupPath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath, path.extname(this.filePath))}.backup.json`
    );
    this.skipNextBackup = false;
    this.lastQuarantinePath = null;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return {
        stickers: [],
        changed: false,
        migratedFromLegacyArray: false,
        recoveredFromBackup: false
      };
    }

    let primaryError = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { ...normalizeDatabaseDocument(parsed), recoveredFromBackup: false };
    } catch (error) {
      primaryError = error;
    }

    if (fs.existsSync(this.backupPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'));
        const normalized = normalizeDatabaseDocument(parsed);
        this.skipNextBackup = true;
        const quarantineName =
          `${path.basename(this.filePath, path.extname(this.filePath))}.corrupt-` +
          `${new Date().toISOString().replace(/[:.]/g, '-')}-` +
          `${crypto.randomBytes(4).toString('hex')}.json`;
        this.lastQuarantinePath = path.join(path.dirname(this.filePath), quarantineName);
        try {
          fs.copyFileSync(this.filePath, this.lastQuarantinePath);
        } catch (_) {
          this.lastQuarantinePath = null;
        }
        return {
          ...normalized,
          changed: true,
          recoveredFromBackup: true,
          quarantinedPrimaryPath: this.lastQuarantinePath,
          primaryError: primaryError.message
        };
      } catch (backupError) {
        throw new Error(
          `Sticker database and backup are invalid. Primary: ${primaryError.message}; backup: ${backupError.message}`
        );
      }
    }

    throw new Error(`Sticker database is invalid and no backup exists: ${primaryError.message}`);
  }

  save(stickers) {
    const normalized = normalizeDatabaseDocument({
      schemaVersion: SCHEMA_VERSION,
      stickers
    });
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${suffix}.tmp`);
    const serialized = `${JSON.stringify(normalized.document, null, 2)}\n`;

    let fd;
    try {
      fd = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      if (fs.existsSync(this.filePath) && !this.skipNextBackup) {
        fs.copyFileSync(this.filePath, this.backupPath);
      }
      fs.renameSync(temporaryPath, this.filePath);
      this.skipNextBackup = false;
    } finally {
      if (fd !== null && fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          // Already closed.
        }
      }
      if (fs.existsSync(temporaryPath)) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch (_) {
          // A later save can safely ignore this uniquely named temp file.
        }
      }
    }
  }
}

function resolveUnder(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe storage path: ${relativePath}`);
  }
  return resolved;
}

function listFilesRecursive(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) output.push(fullPath);
    }
  };
  visit(root);
  return output;
}

const ISSUE_ITEM_LIMIT = 500;

function slashRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function pushIssue(issues, key, item) {
  if (!issues) return;
  const bucket = issues[key];
  if (bucket.items.length < ISSUE_ITEM_LIMIT) bucket.items.push(item);
  else bucket.truncated = true;
}

/**
 * Compares the database with the files on disk. It only updates health flags;
 * it never deletes or moves files.
 *
 * recoverInterrupted: turn 'converting' records into failed ones. Only valid
 *   at startup — later calls would break conversions that are still running.
 * collectItems: also return item-level issues with relative, display-safe names.
 */
function reconcileStorage(stickers, { outputDir, tempDir, recoverInterrupted = false, collectItems = false }) {
  const expected = new Set();
  const report = {
    checkedAt: new Date().toISOString(),
    missingOriginals: 0,
    missingConverted: 0,
    orphanFiles: 0,
    tempEntries: 0,
    staleConversions: 0,
    recoveredFromBackup: false
  };
  const issues = collectItems
    ? Object.fromEntries(['missingOriginals', 'missingConverted', 'orphanFiles', 'tempEntries', 'staleConversions']
      .map((key) => [key, { items: [], truncated: false }]))
    : null;
  let changed = false;

  for (const sticker of stickers) {
    const health = [];
    const previousHealth = Array.isArray(sticker.health) ? sticker.health : [];
    const capturedRelative = path.join('captured', sticker.capturedDate, sticker.originalFilename);
    const capturedPath = resolveUnder(outputDir, capturedRelative);
    expected.add(path.normalize(capturedPath).toLowerCase());
    if (!fs.existsSync(capturedPath)) {
      health.push('missing_original');
      report.missingOriginals += 1;
      pushIssue(issues, 'missingOriginals', { stickerId: sticker.id, name: capturedRelative.split(path.sep).join('/') });
    }

    if (typeof sticker.convertedPath === 'string' && sticker.convertedPath) {
      const convertedRelative = sticker.convertedPath.replace(/^[/\\]+/, '');
      const convertedPath = resolveUnder(outputDir, convertedRelative);
      expected.add(path.normalize(convertedPath).toLowerCase());
      if (!fs.existsSync(convertedPath)) {
        health.push('missing_converted');
        report.missingConverted += 1;
        pushIssue(issues, 'missingConverted', { stickerId: sticker.id, name: convertedRelative.split(/[/\\]/).join('/') });
      }
    }

    if (recoverInterrupted && sticker.status === 'converting') {
      sticker.status = 'failed';
      sticker.error = 'Conversion was interrupted before the previous server stopped. Retry is safe.';
      health.push('interrupted_conversion');
      changed = true;
    } else if (previousHealth.includes('interrupted_conversion') && sticker.status === 'failed') {
      // Keep the flag until the sticker is converted again.
      health.push('interrupted_conversion');
    }
    if (health.includes('interrupted_conversion')) {
      report.staleConversions += 1;
      pushIssue(issues, 'staleConversions', { stickerId: sticker.id, name: sticker.originalFilename });
    }

    if (JSON.stringify(previousHealth) !== JSON.stringify(health)) {
      changed = true;
      if (health.length) sticker.health = health;
      else delete sticker.health;
    }
  }

  for (const folder of ['captured', 'statics', 'animated']) {
    for (const filePath of listFilesRecursive(path.join(outputDir, folder))) {
      if (!expected.has(path.normalize(filePath).toLowerCase())) {
        report.orphanFiles += 1;
        pushIssue(issues, 'orphanFiles', { name: slashRelative(outputDir, filePath) });
      }
    }
  }

  if (fs.existsSync(tempDir)) {
    for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
      const entryPath = path.join(tempDir, entry.name);
      if ((entry.name === 'uploads' || entry.name === 'har-uploads') && entry.isDirectory()) {
        for (const filePath of listFilesRecursive(entryPath)) {
          report.tempEntries += 1;
          pushIssue(issues, 'tempEntries', { name: slashRelative(tempDir, filePath) });
        }
      } else {
        report.tempEntries += 1;
        pushIssue(issues, 'tempEntries', { name: entry.name + (entry.isDirectory() ? '/' : '') });
      }
    }
  }

  return collectItems ? { report, changed, issues } : { report, changed };
}

module.exports = {
  SCHEMA_VERSION,
  StickerDatabase,
  normalizeDatabaseDocument,
  sanitizeHistoricalUrl,
  resolveUnder,
  listFilesRecursive,
  reconcileStorage
};