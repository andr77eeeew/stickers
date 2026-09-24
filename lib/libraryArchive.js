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

module.exports = {
  createLibraryArchiveSnapshot
};
