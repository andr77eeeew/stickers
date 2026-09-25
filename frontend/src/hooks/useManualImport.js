import { useRef, useState } from 'react';
import { apiFetch } from '../lib/api';

export const IMPORT_EXTENSIONS = /\.(png|jpe?g|webp|gif|tif{1,2}|avif|mp4|webm|mov|mkv|m4v)$/i;
export const IMPORT_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.avif,.mp4,.webm,.mov,.mkv,.m4v,image/*,video/*';
export const IMPORT_MAX_FILES = 30;

/** Manual local import — zero TikTok traffic. */
export function useManualImport({ bootstrapState, setStickers, showToast, startConvertJob }) {
  const [manualImporting, setManualImporting] = useState(false);
  const [manualAutoConvert, setManualAutoConvert] = useState(true);
  // Report of the latest batch, straight from the server response. In memory only.
  const [importReport, setImportReport] = useState(null);
  const fileInputRef = useRef(null);

  const handleManualFiles = async (fileList) => {
    if (bootstrapState !== 'ready') {
      showToast('Wait for the local service before importing files.', 'error');
      return;
    }

    const files = Array.from(fileList || []);
    if (!files.length) return;

    const valid = files.filter((file) => IMPORT_EXTENSIONS.test(file.name));
    const skipped = files.filter((file) => !IMPORT_EXTENSIONS.test(file.name)).map((file) => file.name);
    if (!valid.length) {
      setImportReport({ error: 'None of these files are supported. Use PNG, JPG, WebP, GIF, TIFF, AVIF, MP4, WebM, MOV, MKV or M4V.', skipped, results: [] });
      return;
    }
    if (valid.length > IMPORT_MAX_FILES) {
      setImportReport({ error: `Choose up to ${IMPORT_MAX_FILES} files at a time.`, skipped, results: [] });
      return;
    }

    setManualImporting(true);
    setImportReport(null);
    try {
      const form = new FormData();
      valid.forEach((file) => form.append('files', file));

      const response = await apiFetch('/api/import/files', { method: 'POST', body: form });
      let result = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }
      if (!response.ok) {
        setImportReport({
          error: response.status === 413
            ? 'Files exceed the upload limit. Try a smaller batch.'
            : result.error || 'Import failed.',
          skipped,
          results: []
        });
        return;
      }

      const results = result.results || [];
      setImportReport({
        imported: result.imported || 0,
        duplicates: result.duplicates || 0,
        failed: result.failed || 0,
        skipped,
        results
      });

      const newOnes = results
        .filter((entry) => entry.success && entry.sticker && !entry.duplicate)
        .map((entry) => entry.sticker);

      if (newOnes.length) {
        setStickers((previous) => {
          const ids = new Set(previous.map((sticker) => sticker.id));
          return [...newOnes.filter((sticker) => !ids.has(sticker.id)), ...previous];
        });
      }

      // One server job converts the batch; the queue bounds concurrency per sticker.
      const toConvert = newOnes.filter((sticker) => sticker.status === 'captured').map((sticker) => sticker.id);
      if (manualAutoConvert && toConvert.length) {
        const job = await startConvertJob(toConvert);
        if (job) setImportReport((previous) => (previous ? { ...previous, jobId: job.id } : previous));
      }
    } catch (error) {
      console.error('Manual import error:', error);
      setImportReport({ error: `Import failed: ${error.message}`, skipped, results: [] });
    } finally {
      setManualImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return {
    manualImporting, manualAutoConvert, setManualAutoConvert,
    importReport, setImportReport, fileInputRef, handleManualFiles
  };
}
