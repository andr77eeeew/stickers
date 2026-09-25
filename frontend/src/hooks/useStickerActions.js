import { useState } from 'react';
import { apiFetch } from '../lib/api';
import {
  normalizeMediaPath, getPersistedRange, getOutputPath, getSystemTags, toSafeErrorMessage
} from '../lib/stickerModel';

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

export function useStickerActions({
  stickers, setStickers, selectedStartTimes, showToast,
  captureStatus, setCaptureStatus, setSessionInfo, outputPaths
}) {
  const [archiving, setArchiving] = useState(false);

  const handleConvert = async (id) => {
    try {
      setStickers((previous) => previous.map((sticker) => (
        sticker.id === id ? { ...sticker, status: 'converting' } : sticker
      )));

      const currentSticker = stickers.find((sticker) => sticker.id === id);
      const startTime = selectedStartTimes[id] ?? getPersistedRange(currentSticker || {}).start;

      const response = await apiFetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, startTime })
      });
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'Conversion failed');

      setStickers((previous) => previous.map((sticker) => (
        sticker.id === id ? { ...sticker, ...result.sticker } : sticker
      )));
      showToast(`Converted for Telegram (${result.sticker.isAnimated ? 'WebM' : 'WebP'}).`);
    } catch (error) {
      console.error('Sticker conversion error:', error);
      // The server restores a previous valid output when a re-conversion fails;
      // its sticker_update broadcast carries the authoritative status.
      setStickers((previous) => previous.map((sticker) => (
        sticker.id === id && sticker.status === 'converting' ? { ...sticker, status: 'failed' } : sticker
      )));
      showToast(`Conversion failed: ${toSafeErrorMessage(error.message)}`, 'error');
    }
  };

  /** Saves user tags while keeping system import tags. Throws on failure. */
  const handleSaveTags = async (id, userTags) => {
    const sticker = stickers.find((item) => item.id === id);
    const tags = [...getSystemTags(sticker), ...userTags];
    const response = await apiFetch(`/api/stickers/${id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags })
    });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error || 'Tags could not be saved');
    setStickers((previous) => previous.map((item) => (item.id === id ? { ...item, ...result.sticker } : item)));
    showToast('Tags saved.');
  };

  const triggerBrowserDownload = (sticker) => {
    if (!sticker.convertedPath) return;
    const link = document.createElement('a');
    link.href = normalizeMediaPath(sticker.convertedPath);
    link.download = sticker.convertedFilename || '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Archiving creates a recoverable snapshot; the active library remains untouched.
  // Confirmation is handled by the calling dialog. Throws on failure.
  const handleArchiveLibrary = async () => {
    setArchiving(true);
    try {
      const response = await apiFetch('/api/library/archive', { method: 'POST' });
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'Archive could not be created');

      if (result.status) {
        setCaptureStatus((previous) => ({
          ...previous,
          ...result.status,
          devtools: { ...previous.devtools, ...(result.status.devtools || {}) }
        }));
        if (result.status.session) setSessionInfo(result.status.session);
      }
      showToast('Archive snapshot created. The active library is unchanged.');
      return result.archive || null;
    } finally {
      setArchiving(false);
    }
  };

  const handleResetSession = async () => {
    try {
      const response = await apiFetch('/api/session/reset', { method: 'POST' });
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'Reset failed');
      setSessionInfo(result.session);
      showToast('DevTools capture budget reset.');
    } catch (error) {
      showToast(`Session reset failed: ${error.message}`, 'error');
    }
  };

  const outputPath = (key) => getOutputPath(key, outputPaths, captureStatus.storage);

  const copyText = async (text, label = 'Copied') => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label}.`);
      return true;
    } catch {
      showToast('Could not copy to the clipboard.', 'error');
      return false;
    }
  };

  return {
    archiving,
    handleConvert, handleSaveTags, triggerBrowserDownload,
    handleArchiveLibrary, handleResetSession, outputPath, copyText
  };
}
