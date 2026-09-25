export const PAGE_SIZE = 48;

export const normalizeMediaPath = (path) => {
  if (!path) return '';
  if (path.startsWith('/')) return path;
  return `/${path.replace(/^\.?[\\/]+/, '').replaceAll('\\', '/')}`;
};

export const getOriginalPath = (sticker) => normalizeMediaPath(
  sticker.originalPath
  || sticker.capturedPath
  || `captured/${sticker.capturedDate || 'default'}/${sticker.originalFilename}`
);

const readFiniteNumber = (...values) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
};

export const getStickerDuration = (sticker) => {
  if (!sticker?.isAnimated) return 0;
  const durationMs = readFiniteNumber(sticker.durationMs, sticker.metadata?.durationMs, sticker.animation?.durationMs);
  if (durationMs !== null) return durationMs / 1000;
  const durationSeconds = readFiniteNumber(sticker.durationSeconds, sticker.duration, sticker.metadata?.durationSeconds, sticker.animation?.durationSeconds);
  if (durationSeconds !== null) return durationSeconds;
  const frameDelays = sticker.frameDelays || sticker.metadata?.frameDelays;
  if (Array.isArray(frameDelays) && frameDelays.length) {
    return frameDelays.reduce((sum, delay) => sum + Math.max(0, Number(delay) || 0), 0) / 1000;
  }
  if (Array.isArray(sticker.delay) && sticker.delay.length) {
    return sticker.delay.reduce((sum, delay) => sum + Math.max(0, Number(delay) || 0), 0) / 1000;
  }
  const frameCount = readFiniteNumber(sticker.frames) || 0;
  const frameDelayMs = readFiniteNumber(sticker.delay, sticker.metadata?.delay);
  if (frameDelayMs !== null) return (frameCount * frameDelayMs) / 1000;
  const fps = readFiniteNumber(sticker.fps, sticker.metadata?.fps);
  return fps ? frameCount / fps : frameCount / 25;
};

export const getPersistedRange = (sticker) => {
  const source = sticker.selectedRange || sticker.renderedRange || sticker.conversion?.range || {};
  const start = readFiniteNumber(source.start, source.startTime, sticker.selectedStartTime, sticker.startTime, sticker.conversion?.startTime) || 0;
  const explicitEnd = readFiniteNumber(source.end, source.endTime, sticker.selectedEndTime);
  const duration = readFiniteNumber(source.duration, sticker.selectedDuration, sticker.conversion?.duration) || 3;
  return { start, end: explicitEnd ?? start + duration };
};

export const getTodayFolder = () => new Date().toISOString().split('T')[0];

export const selectLibrary = (stickers, activeTab, searchQuery, visibleCount) => {
  const filteredStickers = stickers.filter((sticker) => {
    let matchesTab = true;
    if (activeTab === 'static') matchesTab = !sticker.isAnimated;
    if (activeTab === 'animated') matchesTab = sticker.isAnimated;
    let matchesSearch = true;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const idMatch = String(sticker.id || '').toLowerCase().includes(query);
      const filenameMatch = String(sticker.originalFilename || '').toLowerCase().includes(query);
      const tagMatch = sticker.tags?.some((tag) => String(tag).toLowerCase().includes(query));
      matchesSearch = idMatch || filenameMatch || Boolean(tagMatch);
    }
    return matchesTab && matchesSearch;
  });
  const visibleStickers = filteredStickers.slice(0, visibleCount);
  const stickersByDate = visibleStickers.reduce((groups, sticker) => {
    const date = sticker.capturedDate || getTodayFolder();
    if (!groups[date]) groups[date] = [];
    groups[date].push(sticker);
    return groups;
  }, {});
  return {
    filteredStickers,
    stickersByDate,
    sortedDates: Object.keys(stickersByDate).sort((a, b) => b.localeCompare(a)),
    totalCount: stickers.length,
    staticCount: stickers.filter((sticker) => !sticker.isAnimated).length,
    animatedCount: stickers.filter((sticker) => sticker.isAnimated).length
  };
};

export const getOutputPath = (key, outputPaths, storage) => {
  const aliases = {
    root: ['root', 'output', 'outputRoot', 'rootPath'],
    captured: ['captured', 'capturedPath'],
    statics: ['statics', 'static', 'staticsPath', 'staticPath'],
    animated: ['animated', 'animatedPath']
  };
  const sources = [outputPaths, storage?.paths, storage];
  for (const source of sources) {
    for (const alias of aliases[key] || [key]) {
      if (typeof source?.[alias] === 'string' && source[alias]) return source[alias];
    }
  }
  return key === 'root' ? 'output/' : `output/${key}/`;
};

export const countStorageIssues = (storage) => ['missingOriginals', 'missingConverted', 'orphanFiles', 'tempEntries', 'staleConversions']
  .reduce((sum, key) => {
    const value = storage?.[key];
    return sum + (Array.isArray(value) ? value.length : Number(value) || 0);
  }, 0);
