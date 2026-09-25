const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MEDIA_FOLDERS = ['captured', 'statics', 'animated'];

function slashPath(value) {
  return value.replace(/\\/g, '/');
}

function sha256File(fileSystem, filePath) {
  return crypto.createHash('sha256').update(fileSystem.readFileSync(filePath)).digest('hex');
}

function writeFileExclusive(fileSystem, filePath, contents) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(filePath, 'wx', 0o600);
    fileSystem.writeFileSync(descriptor, contents, 'utf8');
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch (_) {
        // The descriptor may already have been closed by the failed operation.
      }
    }
  }
}

function collectFiles(fileSystem, root) {
  if (!fileSystem.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fileSystem.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function chooseArchiveId(fileSystem, archivesDir, createdAt) {
  const baseId = createdAt.replace(/[:.]/g, '-');
  let id = baseId;
  let suffix = 1;
  while (fileSystem.existsSync(path.join(archivesDir, id))) {
    id = `${baseId}-${suffix++}`;
  }
  return id;
}

function createTemporaryArchiveDirectory(fileSystem, archivesDir, id) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = crypto.randomBytes(8).toString('hex');
    const temporaryPath = path.join(archivesDir, `.${id}.${process.pid}.${suffix}.tmp`);
    try {
      fileSystem.mkdirSync(temporaryPath, { recursive: false });
      return temporaryPath;
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('Unable to allocate a unique temporary archive directory.');
}

function createLibraryArchiveSnapshot({
  outputDir,
  archivesDir = path.join(outputDir, 'archives'),
  databaseFiles = [],
  mediaFolders = DEFAULT_MEDIA_FOLDERS,
  stickerCount = 0,
  createdAt = new Date().toISOString(),
  fileSystem = fs
}) {
  const resolvedOutputDir = path.resolve(outputDir);
  const resolvedArchivesDir = path.resolve(archivesDir);
  fileSystem.mkdirSync(resolvedArchivesDir, { recursive: true });

  const id = chooseArchiveId(fileSystem, resolvedArchivesDir, createdAt);
  const archivePath = path.join(resolvedArchivesDir, id);
  let temporaryPath;

  try {
    temporaryPath = createTemporaryArchiveDirectory(fileSystem, resolvedArchivesDir, id);
    const copyPlan = [];

    for (const folder of mediaFolders) {
      const sourceRoot = path.join(resolvedOutputDir, folder);
      for (const sourcePath of collectFiles(fileSystem, sourceRoot)) {
        copyPlan.push({
          sourcePath,
          relativePath: path.join(folder, path.relative(sourceRoot, sourcePath)),
          media: true
        });
      }
    }

    for (const databaseFile of databaseFiles) {
      const sourcePath = path.resolve(databaseFile);
      if (!fileSystem.existsSync(sourcePath) || !fileSystem.statSync(sourcePath).isFile()) continue;
      copyPlan.push({
        sourcePath,
        relativePath: path.basename(sourcePath),
        media: false
      });
    }

    const destinations = new Set();
    for (const item of copyPlan) {
      const normalized = slashPath(item.relativePath);
      if (destinations.has(normalized)) {
        throw new Error(`Archive destination collision: ${normalized}`);
      }
      destinations.add(normalized);
    }

    const files = [];
    let mediaFileCount = 0;
    for (const item of copyPlan) {
      const destinationPath = path.join(temporaryPath, item.relativePath);
      fileSystem.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fileSystem.copyFileSync(item.sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      const stats = fileSystem.statSync(destinationPath);
      files.push({
        path: slashPath(item.relativePath),
        size: stats.size,
        sha256: sha256File(fileSystem, destinationPath)
      });
      if (item.media) mediaFileCount += 1;
    }
    files.sort((left, right) => left.path.localeCompare(right.path));

    const manifest = {
      schemaVersion: 1,
      id,
      createdAt,
      snapshotOnly: true,
      stickerCount,
      mediaFileCount,
      files
    };
    writeFileExclusive(
      fileSystem,
      path.join(temporaryPath, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    fileSystem.renameSync(temporaryPath, archivePath);
    temporaryPath = undefined;
    return { id, path: archivePath, stickerCount, createdAt, manifest };
  } catch (error) {
    if (temporaryPath && fileSystem.existsSync(temporaryPath)) {
      try {
        fileSystem.rmSync(temporaryPath, { recursive: true, force: true });
      } catch (_) {
        // Never broaden cleanup beyond the uniquely-created directory.
      }
    }
    throw error;
  }
}

// ----- Read-only listing and verification -----

const ARCHIVE_ID_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z(-[0-9]+)?$/;
const REPORT_PATH_LIMIT = 50;

function resolveArchiveDirectory(archivesDir, id) {
  if (typeof id !== 'string' || !ARCHIVE_ID_PATTERN.test(id)) {
    const error = new Error('Unknown archive.');
    error.code = 'ARCHIVE_NOT_FOUND';
    throw error;
  }
  const root = path.resolve(archivesDir);
  const directory = path.resolve(root, id);
  if (path.dirname(directory) !== root) {
    const error = new Error('Unknown archive.');
    error.code = 'ARCHIVE_NOT_FOUND';
    throw error;
  }
  return directory;
}

function readManifest(fileSystem, directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fileSystem.existsSync(manifestPath)) return { manifest: null, problem: 'missing_manifest' };
  try {
    const manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
    if (!manifest || !Array.isArray(manifest.files)) return { manifest: null, problem: 'unreadable_manifest' };
    return { manifest, problem: null };
  } catch (_) {
    return { manifest: null, problem: 'unreadable_manifest' };
  }
}

/** Lists archives created by the app. Temporary and foreign folders are ignored. */
function listLibraryArchives({ archivesDir, fileSystem = fs }) {
  const root = path.resolve(archivesDir);
  if (!fileSystem.existsSync(root)) return [];
  return fileSystem.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ARCHIVE_ID_PATTERN.test(entry.name))
    .map((entry) => {
      const { manifest, problem } = readManifest(fileSystem, path.join(root, entry.name));
      if (!manifest) return { id: entry.name, createdAt: null, problem };
      return {
        id: entry.name,
        createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
        stickerCount: Number.isInteger(manifest.stickerCount) ? manifest.stickerCount : null,
        fileCount: manifest.files.length,
        totalBytes: manifest.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
        problem: null
      };
    })
    .sort((left, right) => right.id.localeCompare(left.id));
}

function hashFileStream(fileSystem, filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fileSystem.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Re-hashes every file listed in the manifest. Never writes, moves or deletes
 * anything; the result only describes what was found.
 */
async function verifyLibraryArchive({ archivesDir, id, fileSystem = fs, now = () => new Date().toISOString() }) {
  const directory = resolveArchiveDirectory(archivesDir, id);
  if (!fileSystem.existsSync(directory)) {
    const error = new Error('Unknown archive.');
    error.code = 'ARCHIVE_NOT_FOUND';
    throw error;
  }
  const { manifest, problem } = readManifest(fileSystem, directory);
  if (!manifest) {
    return { id, verifiedAt: now(), status: 'unverifiable', problem, checked: 0, missing: [], changed: [], extra: [], counts: { missing: 0, changed: 0, extra: 0 } };
  }

  const missing = [];
  const changed = [];
  const listed = new Set(['manifest.json']);
  let checked = 0;

  for (const file of manifest.files) {
    const relative = String(file.path || '');
    const target = path.resolve(directory, relative);
    // A manifest entry that escapes the archive is treated as changed, never read.
    if (!relative || !target.startsWith(directory + path.sep)) {
      changed.push(relative || '(empty path)');
      continue;
    }
    listed.add(slashPath(path.relative(directory, target)));
    if (!fileSystem.existsSync(target) || !fileSystem.statSync(target).isFile()) {
      missing.push(relative);
      continue;
    }
    const stats = fileSystem.statSync(target);
    if (stats.size !== Number(file.size) || (await hashFileStream(fileSystem, target)) !== file.sha256) {
      changed.push(relative);
    }
    checked += 1;
  }

  const extra = collectFiles(fileSystem, directory)
    .map((filePath) => slashPath(path.relative(directory, filePath)))
    .filter((relative) => !listed.has(relative));

  const status = missing.length || changed.length ? 'mismatch' : 'verified';
  return {
    id,
    verifiedAt: now(),
    status,
    problem: null,
    checked,
    counts: { missing: missing.length, changed: changed.length, extra: extra.length },
    missing: missing.slice(0, REPORT_PATH_LIMIT),
    changed: changed.slice(0, REPORT_PATH_LIMIT),
    extra: extra.slice(0, REPORT_PATH_LIMIT)
  };
}

module.exports = {
  createLibraryArchiveSnapshot,
  listLibraryArchives,
  verifyLibraryArchive,
  ARCHIVE_ID_PATTERN
};
