import { Download, LoaderCircle, Package } from 'lucide-react';
import { StickerMedia } from './StickerMedia';
import { KIND_LABELS, PACK_LIMITS, summarizePack } from '../lib/packModel';

const THUMB_COUNT = 8;

/** Draft of the current pack, docked under the library grid. */
export function PackBar({ pack, stickersById, onOpen, onExport, exporting }) {
  const summary = summarizePack(pack, stickersById);
  const thumbs = pack.items.slice(0, THUMB_COUNT).map((item) => stickersById.get(item.stickerId)).filter(Boolean);
  const rest = pack.items.length - thumbs.length;

  return (
    <div className="pack-bar" role="region" aria-label="Current pack">
      <div className="pack-bar-title">
        <Package size={18} aria-hidden="true" />
        <span className="pack-bar-name">{pack.title}</span>
        <span className="muted small tabular">{summary.count}/{PACK_LIMITS.maxStickers}{summary.kind ? ` · ${KIND_LABELS[summary.kind]}` : ''}</span>
      </div>
      {thumbs.length > 0 && (
        <ol className="pack-bar-thumbs" aria-label="First stickers in order">
          {thumbs.map((sticker) => (
            <li key={sticker.id} className="pack-bar-thumb preview-surface">
              <StickerMedia sticker={sticker} still />
            </li>
          ))}
          {rest > 0 && <li className="pack-bar-more tabular">+{rest}</li>}
        </ol>
      )}
      <p className={`pack-bar-status small ${summary.exportBlockedReason ? 'tone-warning-text' : 'tone-ok-text'}`}>
        {summary.exportBlockedReason || 'Ready to export'}
      </p>
      <div className="pack-bar-actions">
        <button type="button" className="btn btn-small" onClick={onOpen}>Open pack</button>
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={Boolean(summary.exportBlockedReason) || exporting}
          title={summary.exportBlockedReason || undefined}
          onClick={onExport}
        >
          {exporting ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
          Export for @Stickers
        </button>
      </div>
    </div>
  );
}
