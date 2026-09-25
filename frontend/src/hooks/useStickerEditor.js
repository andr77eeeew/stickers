import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { getOriginalPath, getPersistedRange } from '../lib/stickerModel';

export function useStickerEditor({ setStickers, selectedStartTimes, showToast }) {
  // ----------------------------------------------------
  // Canvas Editor Modal States
  // ----------------------------------------------------
  const [editingSticker, setEditingSticker] = useState(null);
  const [editorScale, setEditorScale] = useState(1.0);
  const [editorRotation, setEditorRotation] = useState(0);
  const [editorTopText, setEditorTopText] = useState('');
  const [editorBottomText, setEditorBottomText] = useState('');
  const [editorStrokeActive, setEditorStrokeActive] = useState(false);
  const [editorStrokeWidth, setEditorStrokeWidth] = useState(6);
  const [editorStrokeColor, setEditorStrokeColor] = useState('#ffffff');
  const [editorActiveFrame, setEditorActiveFrame] = useState(0);
  const [editorSaving, setEditorSaving] = useState(false);

  const canvasRef = useRef(null);
  const modalRef = useRef(null);
  const modalCloseRef = useRef(null);
  const editorTriggerRef = useRef(null);

  // ----------------------------------------------------
  // Canvas Rendering Pipeline (HTML5 Compositor)
  // ----------------------------------------------------
  useEffect(() => {
    if (!editingSticker) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const img = new Image();
    img.crossOrigin = 'anonymous';

    // Source depending on static WebP vs scrubbing animated frame
    if (editingSticker.isAnimated) {
      img.src = `/api/stickers/${editingSticker.id}/frame/${editorActiveFrame}`;
    } else {
      img.src = getOriginalPath(editingSticker);
    }

    img.onload = () => {
      // 1. Reset canvas
      ctx.clearRect(0, 0, 512, 512);
      ctx.save();

      // 2. Perform transformations
      ctx.translate(256, 256);
      ctx.rotate((editorRotation * Math.PI) / 180);
      ctx.scale(editorScale, editorScale);

      // Fit sticker perfectly inside 512x512 with a boundary cushion for outlines & texts
      const w = editingSticker.width;
      const h = editingSticker.height;
      let targetW, targetH;
      if (w >= h) {
        targetW = 380;
        targetH = Math.round((h * 380) / w);
      } else {
        targetH = 380;
        targetW = Math.round((w * 380) / h);
      }

      const drawX = -targetW / 2;
      const drawY = -targetH / 2;

      // 3. Draw outline border using offscreen double-buffering
      if (editorStrokeActive && editorStrokeWidth > 0) {
        const offscreen = document.createElement('canvas');
        offscreen.width = 512;
        offscreen.height = 512;
        const oCtx = offscreen.getContext('2d');

        // Draw transformed frame onto offscreen buffer
        oCtx.save();
        oCtx.translate(256, 256);
        oCtx.rotate((editorRotation * Math.PI) / 180);
        oCtx.scale(editorScale, editorScale);
        oCtx.drawImage(img, drawX, drawY, targetW, targetH);
        oCtx.restore();

        // source-in composite color tinting
        oCtx.globalCompositeOperation = 'source-in';
        oCtx.fillStyle = editorStrokeColor;
        oCtx.fillRect(0, 0, 512, 512);

        // Stamp shifted silhouttes radially on main canvas
        const step = 0.25;
        for (let angle = 0; angle < Math.PI * 2; angle += step) {
          const dx = Math.cos(angle) * editorStrokeWidth;
          const dy = Math.sin(angle) * editorStrokeWidth;
          ctx.drawImage(offscreen, dx, dy);
        }
      }

      // 4. Paint primary transparent sticker exactly centered on top of borders
      ctx.drawImage(img, drawX, drawY, targetW, targetH);
      ctx.restore();

      // 5. Draw meme texts (Impact font, black border outline)
      ctx.font = 'bold 36px Impact, Arial Black, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 5;
      ctx.textAlign = 'center';

      if (editorTopText) {
        ctx.strokeText(editorTopText.toUpperCase(), 256, 60);
        ctx.fillText(editorTopText.toUpperCase(), 256, 60);
      }

      if (editorBottomText) {
        ctx.strokeText(editorBottomText.toUpperCase(), 256, 460);
        ctx.fillText(editorBottomText.toUpperCase(), 256, 460);
      }
    };

    img.onerror = () => {
      ctx.clearRect(0, 0, 512, 512);
      ctx.fillStyle = 'var(--text-muted)';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Failed to load frame preview buffer', 256, 256);
    };
  }, [
    editingSticker,
    editorScale,
    editorRotation,
    editorTopText,
    editorBottomText,
    editorStrokeActive,
    editorStrokeWidth,
    editorStrokeColor,
    editorActiveFrame
  ]);

  useEffect(() => {
    if (!editingSticker) return undefined;

    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => modalCloseRef.current?.focus());

    const handleModalKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setEditingSticker(null);
        return;
      }

      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.hasAttribute('hidden'));
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleModalKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleModalKeyDown);
      document.body.style.overflow = previousOverflow;
      const focusTarget = editorTriggerRef.current || previouslyFocused;
      window.setTimeout(() => focusTarget?.focus(), 0);
    };
  }, [editingSticker]);

  const openEditor = (sticker, trigger) => {
    editorTriggerRef.current = trigger;
    setEditorScale(1.0);
    setEditorRotation(0);
    setEditorTopText('');
    setEditorBottomText('');
    setEditorStrokeActive(false);
    setEditorStrokeWidth(6);
    setEditorStrokeColor('#ffffff');
    setEditorActiveFrame(0);
    setEditingSticker(sticker);
  };

  // Compile Customized Canvas Edits
  const handleSaveEdit = async () => {
    if (!editingSticker) return;
    setEditorSaving(true);

    try {
      if (editingSticker.isAnimated) {
        // Post transforms model to backend for frame-by-frame renders
        const startTime = selectedStartTimes[editingSticker.id] ?? getPersistedRange(editingSticker).start;
        const response = await apiFetch(`/api/edit-convert-animated`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingSticker.id,
            startTime,
            transforms: {
              scale: editorScale,
              rotation: editorRotation,
              strokeActive: editorStrokeActive,
              strokeWidth: editorStrokeWidth,
              strokeColor: editorStrokeColor,
              topText: editorTopText,
              bottomText: editorBottomText,
              textColor: '#ffffff',
              textSize: 36
            }
          })
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Animated edit compile failed.');

        setStickers(prev => prev.map(s => s.id === editingSticker.id ? { ...s, ...result.sticker } : s));
        showToast(`✨ Customized Animated Sticker compiled successfully! Saved to output/animated/`);
      } else {
        // Upload base64 PNG data for high-speed static WebP conversion
        const canvas = canvasRef.current;
        const dataUrl = canvas.toDataURL('image/png');

        const response = await apiFetch(`/api/edit-convert-static`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingSticker.id,
            pngBase64: dataUrl
          })
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Static edit compile failed.');

        setStickers(prev => prev.map(s => s.id === editingSticker.id ? { ...s, ...result.sticker } : s));
        showToast(`✨ Customized Static Sticker saved successfully! Saved to output/statics/`);
      }

      setEditingSticker(null);
    } catch (err) {
      showToast(`❌ Editing failed: ${err.message}`);
    } finally {
      setEditorSaving(false);
    }
  };

  return {
    editingSticker, setEditingSticker, modalRef, modalCloseRef, canvasRef,
    editorActiveFrame, setEditorActiveFrame, editorScale, setEditorScale,
    editorRotation, setEditorRotation, editorStrokeActive, setEditorStrokeActive,
    editorStrokeWidth, setEditorStrokeWidth, editorStrokeColor, setEditorStrokeColor,
    editorTopText, setEditorTopText, editorBottomText, setEditorBottomText,
    editorSaving, handleSaveEdit, openEditor
  };
}
