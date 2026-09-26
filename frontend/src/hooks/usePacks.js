import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { toSafeErrorMessage } from '../lib/stickerModel';

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

const postJson = async (route, body = {}) => {
  const response = await apiFetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await readJson(response);
  if (!response.ok) {
    const error = new Error(toSafeErrorMessage(result.error) || 'The pack could not be saved');
    error.result = result;
    throw error;
  }
  return result;
};

/**
 * Pack actions. Saves run one after another and each reads the latest pack
 * when it starts, so quick edits never race on the pack revision.
 */
export function usePacks({ packState, setPackState, showToast }) {
  const stateRef = useRef(packState);
  const queueRef = useRef(Promise.resolve());
  const [exportingId, setExportingId] = useState(null);

  useEffect(() => {
    stateRef.current = packState;
  }, [packState]);

  const applyPack = useCallback((pack) => {
    const next = {
      ...stateRef.current,
      packs: stateRef.current.packs.map((item) => (item.id === pack.id ? pack : item))
    };
    stateRef.current = next;
    setPackState(next);
  }, [setPackState]);

  const applySnapshot = useCallback((result) => {
    const next = { ...stateRef.current, packs: result.packs, activePackId: result.activePackId };
    stateRef.current = next;
    setPackState(next);
  }, [setPackState]);

  const enqueue = useCallback((task) => {
    const run = queueRef.current.then(task, task);
    queueRef.current = run.catch(() => {});
    return run;
  }, []);

  /** `change(pack)` returns the patch ({ title?, items? }) or null to skip. Throws on failure. */
  const updatePack = useCallback((packId, change) => enqueue(async () => {
    const pack = stateRef.current.packs.find((item) => item.id === packId);
    if (!pack) throw new Error('Pack not found');
    const patch = change(pack);
    if (!patch) return pack;
    try {
      const result = await postJson(`/api/packs/${packId}`, { ...patch, revision: pack.revision });
      applyPack(result.pack);
      return result.pack;
    } catch (error) {
      // A newer version from another tab replaces the local one before the error is shown.
      if (error.result?.pack) applyPack(error.result.pack);
      throw error;
    }
  }), [applyPack, enqueue]);

  const createPack = useCallback((title) => enqueue(async () => {
    const result = await postJson('/api/packs', { title });
    applySnapshot(result);
    showToast(`Pack “${result.pack.title}” created and set as current.`);
    return result.pack;
  }), [applySnapshot, enqueue, showToast]);

  const activatePack = useCallback((packId) => enqueue(async () => {
    applySnapshot(await postJson(`/api/packs/${packId}/activate`));
  }), [applySnapshot, enqueue]);

  const deletePack = useCallback((packId) => enqueue(async () => {
    const title = stateRef.current.packs.find((pack) => pack.id === packId)?.title || 'Pack';
    applySnapshot(await postJson(`/api/packs/${packId}/delete`));
    showToast(`“${title}” deleted. Its stickers stay in the library.`);
  }), [applySnapshot, enqueue, showToast]);

  const renamePack = useCallback((packId, title) => updatePack(packId, () => ({ title })), [updatePack]);

  const setItems = useCallback((packId, items) => updatePack(packId, () => ({ items })), [updatePack]);

  const addStickers = useCallback((packId, stickerIds, emoji = []) => updatePack(packId, (pack) => {
    const present = new Set(pack.items.map((item) => item.stickerId));
    const added = stickerIds.filter((id) => !present.has(id)).map((stickerId) => ({ stickerId, emoji }));
    return added.length ? { items: [...pack.items, ...added] } : null;
  }), [updatePack]);

  const setEmoji = useCallback((packId, stickerId, emoji) => updatePack(packId, (pack) => ({
    items: pack.items.map((item) => (item.stickerId === stickerId ? { ...item, emoji } : item))
  })), [updatePack]);

  const removeSticker = useCallback((packId, stickerId) => updatePack(packId, (pack) => ({
    items: pack.items.filter((item) => item.stickerId !== stickerId)
  })), [updatePack]);

  /** Downloads the ZIP. Problems reported by the server are returned, not thrown. */
  const exportPack = useCallback(async (packId) => {
    setExportingId(packId);
    try {
      const response = await apiFetch(`/api/packs/${packId}/export`);
      if (!response.ok) {
        const result = await readJson(response);
        const first = result.problems?.[0];
        const detail = first ? `${first.position ? `#${first.position}: ` : ''}${first.message}` : '';
        showToast(`Export blocked. ${toSafeErrorMessage(detail || result.error || 'Unknown error')}`, 'error');
        return { problems: result.problems || [] };
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const fileName = decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'sticker-pack.zip');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      showToast(`Exported ${fileName}. Follow pack.txt inside it in @Stickers.`);
      return { problems: [] };
    } catch (error) {
      showToast(`Export failed: ${toSafeErrorMessage(error.message)}`, 'error');
      return { problems: [] };
    } finally {
      setExportingId(null);
    }
  }, [showToast]);

  return {
    createPack, activatePack, deletePack, renamePack, setItems, addStickers, setEmoji, removeSticker,
    exportPack, exportingId
  };
}
