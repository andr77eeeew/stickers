import { Upload, FileImage } from 'lucide-react';

export function ManualImportZone({
  manualDragOver, setManualDragOver, manualImporting, manualAutoConvert,
  setManualAutoConvert, bootstrapState, fileInputRef, handleManualFiles
}) {
  return (
    <>
        {/* Manual import — local files only, no TikTok */}
        <div
          className={`manual-import-zone glass-panel ${manualDragOver ? 'drag-over' : ''} ${manualImporting ? 'importing' : ''}`}
          role="region"
          aria-label="Manual local sticker import"
          aria-busy={manualImporting}
          onDragOver={(e) => {
            e.preventDefault();
            setManualDragOver(true);
          }}
          onDragLeave={() => setManualDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setManualDragOver(false);
            handleManualFiles(e.dataTransfer.files);
          }}
        >
          <div className="manual-import-icon">
            <Upload size={28} />
          </div>
          <div className="manual-import-copy">
            <h3>Manual sticker import</h3>
            <p>
              Drop <strong>png / jpg / webp / gif / mp4 / webm</strong> here — converts locally for Telegram.
              No TikTok connection. Safest path (zero account risk).
            </p>
            <label className="manual-auto-convert">
              <input
                type="checkbox"
                checked={manualAutoConvert}
                onChange={(e) => setManualAutoConvert(e.target.checked)}
              />
              Auto-convert to Telegram format after import
            </label>
          </div>
          <div className="manual-import-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.avif,.mp4,.webm,.mov,.mkv,.m4v,image/*,video/*"
              style={{ display: 'none' }}
              onChange={(e) => handleManualFiles(e.target.files)}
            />
            <button
              type="button"
              className="download-btn"
              disabled={manualImporting || bootstrapState !== 'ready'}
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: '10px 18px', fontSize: '0.85rem' }}
            >
              <FileImage size={16} />
              {manualImporting ? 'Importing…' : 'Choose files'}
            </button>
          </div>
        </div>
    </>
  );
}
