import { useState } from 'react';
import { apiFetch } from '../lib/api';
import { normalizeMediaPath, getPersistedRange, getTodayFolder, getOutputPath } from '../lib/stickerModel';

export function useStickerActions({
  stickers, setStickers, selectedStartTimes, showToast,
  captureStatus, setCaptureStatus, setSessionInfo, outputPaths
}) {
  const [editingTags, setEditingTags] = useState({});
  const [archiving, setArchiving] = useState(false);
  const [folderCopySuccess, setFolderCopySuccess] = useState(false);

  // Trigger Conversion API
  const handleConvert = async (id) => {
    try {
      setStickers(prev =>
        prev.map(s => s.id === id ? { ...s, status: 'converting' } : s)
      );

      const currentSticker = stickers.find((sticker) => sticker.id === id);
      const startTime = selectedStartTimes[id] ?? getPersistedRange(currentSticker || {}).start;

      const response = await apiFetch(`/api/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, startTime })
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Conversion failed');
      }

      setStickers(prev =>
        prev.map(s => s.id === id ? { ...s, ...result.sticker } : s)
      );

      const folderName = result.sticker.isAnimated ? 'animated' : 'statics';
      const dateFolder = result.sticker.capturedDate || getTodayFolder();
      showToast(`✨ Sticker successfully converted & saved to output/${folderName}/${dateFolder}/`);

    } catch (err) {
      console.error('Sticker conversion error:', err);
      setStickers(prev =>
        prev.map(s => s.id === id ? { ...s, status: 'failed' } : s)
      );
      showToast(`❌ Sticker conversion failed: ${err.message}`);
    }
  };


  // Persist manual tags to backend
  const handleSaveTags = async (id) => {
    const tagString = editingTags[id] || '';
    const tagsArray = tagString.split(',').map(t => t.trim()).filter(Boolean);

    try {
      const response = await apiFetch(`/api/stickers/${id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: tagsArray })
      });
      const result = await response.json();
      if (response.ok) {
        setStickers(prev => prev.map(s => s.id === id ? { ...s, ...result.sticker } : s));
        showToast('🏷️ Tags updated successfully!');
        setEditingTags(prev => {
          const copy = { ...prev };
          delete copy[id];
          return copy;
        });
      }
    } catch {
      showToast('❌ Failed to save tags.');
    }
  };

  const triggerBrowserDownload = (sticker) => {
    if (!sticker.convertedPath) return;
    const downloadUrl = normalizeMediaPath(sticker.convertedPath);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = sticker.convertedFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Archiving creates a recoverable snapshot; the active library remains untouched.
  const handleArchiveLibrary = async () => {
    const confirmed = window.confirm(
      'Create an archive snapshot of the current library? The server will copy the database and media to a dated archive. The active library will stay unchanged.'
    );
    if (!confirmed) return;

    setArchiving(true);
    try {
      const response = await apiFetch('/api/library/archive', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Archive failed');

      if (result.status) {
        setCaptureStatus((previous) => ({
          ...previous,
          ...result.status,
          devtools: { ...previous.devtools, ...(result.status.devtools || {}) }
        }));
        if (result.status.session) setSessionInfo(result.status.session);
      }
      const archivePath = result.archive?.path;
      showToast(archivePath ? `Archive snapshot created: ${archivePath}` : 'Archive snapshot created. The active library is unchanged.');
    } catch (error) {
      showToast(`Archive failed: ${error.message}`);
    } finally {
      setArchiving(false);
    }
  };

  const handleResetSession = async () => {
    try {
      const response = await apiFetch('/api/session/reset', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Reset failed');
      setSessionInfo(result.session);
      showToast('DevTools capture budget reset.');
    } catch (error) {
      showToast(`Session reset failed: ${error.message}`);
    }
  };

  const outputPath = (key) => getOutputPath(key, outputPaths, captureStatus.storage);

  const copyFolderPath = async () => {
    try {
      await navigator.clipboard.writeText(outputPath('root'));
      setFolderCopySuccess(true);
      window.setTimeout(() => setFolderCopySuccess(false), 2000);
    } catch {
      showToast('Could not copy the storage path.');
    }
  };

  return {
    editingTags, setEditingTags, archiving, folderCopySuccess,
    handleConvert, handleSaveTags, triggerBrowserDownload,
    handleArchiveLibrary, handleResetSession, copyFolderPath, outputPath
  };
}
