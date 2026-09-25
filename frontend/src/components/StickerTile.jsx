import { Film, LoaderCircle, Check } from 'lucide-react';
import { StickerMedia } from './StickerMedia';
import {
  STATE_LABELS, formatBytes, getOutputSize, getShortId, getStickerDuration, getStickerState
} from '../lib/stickerModel';

const BADGE_TONE = {
  captured: 'accent',
  converting: 'accent',
  queued: 'accent',
  failed: 'problem',
  output_missing: 'warning',
  over_limit: 'problem',
  unmeasured: 'neutral'
};

export function StickerTile({ sticker, selected, eager, onOpen, selectionMode, checked, onToggle, queued }) {
  const stickerState = getStickerState(sticker);
  // A queued job item is shown until the server actually starts converting it.
  const state = queued && stickerState !== 'converting' ? 'queued' : stickerState;
  const label = state === 'queued' ? 'Queued' : STATE_LABELS[state];
  const size = getOutputSize(sticker);
  const duration = getStickerDuration(sticker);
  const shortId = getShortId(sticker);
  const typeLabel = sticker.isAnimated ? 'animated' : 'static';
  const ariaLabel = `Sticker ${shortId}, ${typeLabel}, ${label}`;

  const content = (
    <>
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
            {(state === 'converting' || state === 'queued') && <LoaderCircle size={11} className={state === 'converting' ? 'spin' : ''} aria-hidden="true" />}
            {label}
          </span>
        )}
        {selectionMode && (
          <span className={`tile-check ${checked ? 'is-checked' : ''}`} aria-hidden="true">
            {checked && <Check size={14} strokeWidth={3} />}
          </span>
        )}
      </span>
      <span className="tile-caption">
        <span className="mono">{shortId}</span>
        <span>{size !== null ? formatBytes(size) : '—'}</span>
      </span>
    </>
  );

  return (
    <li className="tile-item">
      {selectionMode ? (
        <button
          type="button"
          className={`sticker-tile ${checked ? 'is-checked' : ''}`}
          data-sticker-id={sticker.id}
          aria-pressed={checked}
          aria-label={`Select ${ariaLabel}`}
          onClick={(event) => onToggle(sticker.id, event.shiftKey)}
        >
          {content}
        </button>
      ) : (
        <a
          className="sticker-tile"
          href={`?id=${sticker.id}`}
          data-sticker-id={sticker.id}
          aria-current={selected ? 'true' : undefined}
          aria-label={ariaLabel}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            onOpen(sticker.id);
          }}
        >
          {content}
        </a>
      )}
    </li>
  );
}
