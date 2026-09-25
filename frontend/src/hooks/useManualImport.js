import { useRef, useState } from 'react';
import { apiFetch } from '../lib/api';

export function useManualImport({ bootstrapState, setStickers, showToast, handleConvert }) {
  const [manualImporting, setManualImporting] = useState(false);
  const [manualAutoConvert, setManualAutoConvert] = useState(true);
  const [manualDragOver, setManualDragOver] = useState(false);
  const fileInputRef = useRef(null);

  /** Manual local import — zero TikTok traffic */
  const handleManualFiles = async (fileList) => {
    if (bootstrapState !== 'ready') {
      showToast('Wait for the local authenticated session before importing files.');
      return;
    }

    const files = Array.from(fileList || []);
    if (!files.length) return;

    const allowed = /\.(png|jpe?g|webp|gif|tif{1,2}|avif|mp4|webm|mov|mkv|m4v)$/i;
    const valid = files.filter((f) => allowed.test(f.name));
    if (!valid.length) {
      showToast('Unsupported files. Use png, jpg, webp, gif, mp4, webm, mov…');
      return;
    }

    setManualImporting(true);
    try {
      const form = new FormData();
      valid.forEach((f) => form.append('files', f));

      const response = await apiFetch(`/api/import/files`, {
        method: 'POST',
        body: form
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Import failed');
      }

      const newOnes = (result.results || [])
        .filter((r) => r.success && r.sticker)
        .map((r) => r.sticker);

      if (newOnes.length) {
        setStickers((prev) => {
          const ids = new Set(prev.map((s) => s.id));
          const merged = [...newOnes.filter((s) => !ids.has(s.id)), ...prev];
          return merged;
        });
      }

      showToast(
        `Import: ${result.imported} new, ${result.duplicates || 0} dup, ${result.failed || 0} failed`
      );

      if (manualAutoConvert && newOnes.length) {
        for (const s of newOnes) {
          if (s.status === 'captured' && !result.results?.find((r) => r.sticker?.id === s.id && r.duplicate)) {
            // only convert truly new non-duplicate imports
            const wasDup = (result.results || []).find((r) => r.sticker?.id === s.id)?.duplicate;
            if (!wasDup) {
              await handleConvert(s.id);
            }
          }
        }
      }
    } catch (err) {
      console.error('Manual import error:', err);
      showToast(`Import failed: ${err.message}`);
    } finally {
      setManualImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return {
    manualImporting, manualAutoConvert, setManualAutoConvert,
    manualDragOver, setManualDragOver, fileInputRef, handleManualFiles
  };
}
