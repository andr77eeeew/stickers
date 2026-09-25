import { Film, LoaderCircle } from 'lucide-react';
import { StickerMedia } from './StickerMedia';
import {
  STATE_LABELS, formatBytes, getOutputSize, getShortId, getStickerDuration, getStickerState
} from '../lib/stickerModel';

const BADGE_TONE = {
  captured: 'accent',
  converting: 'accent',
  failed: 'problem',
  output_missing: 'warning',
  over_limit: 'problem',
  unmeasured: 'neutral'
};

export function StickerTile({ sticker, selected, eager, onOpen }) {
  const state = getStickerState(sticker);
  const size = getOutputSize(sticker);
  const duration = getStickerDuration(sticker);
  const shortId = getShortId(sticker);
  const typeLabel = sticker.isAnimated ? 'animated' : 'static';

  return (
    <li className="tile-item">
      <a
        className="sticker-tile"
        href={`?id=${sticker.id}`}
        data-sticker-id={sticker.id}
        aria-current={selected ? 'true' : undefined}
        aria-label={`Sticker ${shortId}, ${typeLabel}, ${STATE_LABELS[state]}`}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(sticker.id);
        }}
      >
        <span className="tile-media preview-surface">
          <StickerMedia sticker={sticker} eager={eager} />
          {sticker.isAnimated && (
            <span className="badge badge-dark tile-badge-bl">
              <Film size={11} aria-hidden="true" />
              {duration > 0 ? `${duration.toFixed(1)}s` : 'Animated'}
            </span>
          )}
          {state !== 'ready' && (
            <span className={`badge badge-${BADGE_TONE[state]} tile-badge-tr`}>
              {state === 'converting' && <LoaderCircle size={11} className="spin" aria-hidden="true" />}
              {STATE_LABELS[state]}
            </span>
          )}
        </span>
        <span className="tile-caption">
          <span className="mono">{shortId}</span>
          <span>{size !== null ? formatBytes(size) : '—'}</span>
        </span>
      </a>
    </li>
  );
}
