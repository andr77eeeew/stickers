import { useEffect, useReducer, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { getOriginalPath, getPersistedRange } from '../lib/stickerModel';
import { DEFAULT_PARAMS, getAnimationWindow } from '../lib/editorModel';
import { canUndo, createEditorHistory, editorHistoryReducer, isDirty } from '../lib/editorHistory';
import { CANVAS_SIZE, renderSticker } from '../lib/editorRender';

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Preview image could not be loaded'));
  image.src = src;
});

/**
 * Editor state for one sticker: parameters with undo history, the animation
 * window, the preview frame and saving. Nothing reaches the server until save.
 */
export function useStickerEditor({ sticker, initialStart, setStickers, setSelectedStartTimes, showToast }) {
  const [history, dispatch] = useReducer(editorHistoryReducer, null, () => createEditorHistory({
    params: DEFAULT_PARAMS,
    start: sticker?.isAnimated ? getAnimationWindow(sticker, initialStart ?? getPersistedRange(sticker).start).start : 0
  }));
  const state = history.current;
  const [previewFrame, setPreviewFrame] = useState(null);
  const [mode, setMode] = useState('telegram');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const canvasRef = useRef(null);
  const imageCacheRef = useRef(new Map());

  const animationWindow = sticker?.isAnimated ? getAnimationWindow(sticker, state.start) : null;
  const frameIndex = animationWindow
    ? Math.min(Math.max(previewFrame ?? animationWindow.startFrame, animationWindow.startFrame), animationWindow.endFrame)
    : 0;
  const imageSrc = !sticker
    ? null
    : sticker.isAnimated ? `/api/stickers/${sticker.id}/frame/${frameIndex}` : getOriginalPath(sticker);
  const dirty = isDirty(history);

  const getImage = (src) => {
    const cache = imageCacheRef.current;
    if (!cache.has(src)) {
      const pending = loadImage(src);
      pending.catch(() => cache.delete(src));
      cache.set(src, pending);
    }
    return cache.get(src);
  };

  // Redraw whenever the image, parameters or preview mode change. The previous
  // drawing stays until the next image is ready, so the preview does not flash.
  useEffect(() => {
    if (!imageSrc) return undefined;
    let cancelled = false;
    getImage(imageSrc).then((image) => {
      if (cancelled || !canvasRef.current) return;
      renderSticker(canvasRef.current.getContext('2d'), image, state.params, mode);
      setPreviewError('');
    }).catch((error) => {
      if (!cancelled) setPreviewError(error.message);
    });
    return () => { cancelled = true; };
  }, [imageSrc, state.params, mode]);

  // Warn before closing or reloading the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /** Live update; call checkpoint() when a gesture ends to make it undoable. */
  const update = (patch) => {
    dispatch({ type: 'update', patch });
    if (patch.start !== undefined) setPreviewFrame(null);
  };
  const checkpoint = () => dispatch({ type: 'checkpoint' });
  const undo = () => {
    dispatch({ type: 'undo' });
    setPreviewFrame(null);
  };
  const reset = () => {
    dispatch({ type: 'reset' });
    setPreviewFrame(null);
  };

  const save = async () => {
    if (!sticker) return false;
    setSaving(true);
    setSaveError('');
    try {
      let response;
      if (sticker.isAnimated) {
        response = await apiFetch('/api/edit-convert-animated', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: sticker.id,
            startTime: state.start,
            transforms: { ...state.params, textColor: '#ffffff', textSize: 36 }
          })
        });
      } else {
        // The export is always rendered with effects, whichever preview is shown.
        const image = await getImage(getOriginalPath(sticker));
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = CANVAS_SIZE;
        exportCanvas.height = CANVAS_SIZE;
        renderSticker(exportCanvas.getContext('2d'), image, state.params, 'telegram');
        response = await apiFetch('/api/edit-convert-static', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sticker.id, pngBase64: exportCanvas.toDataURL('image/png') })
        });
      }
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error || 'The edited sticker could not be saved');
      setStickers((previous) => previous.map((item) => (item.id === sticker.id ? { ...item, ...result.sticker } : item)));
      if (sticker.isAnimated) setSelectedStartTimes((previous) => ({ ...previous, [sticker.id]: state.start }));
      showToast(`Edited sticker saved and converted (${sticker.isAnimated ? 'WebM' : 'WebP'}).`);
      return true;
    } catch (error) {
      setSaveError(error.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    canvasRef, params: state.params, start: state.start, animationWindow, frameIndex, setPreviewFrame,
    mode, setMode, update, checkpoint, undo, reset, canUndo: canUndo(history),
    dirty, save, saving, saveError, previewError
  };
}
