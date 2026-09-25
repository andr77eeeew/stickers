import { RefreshCw, Tag, X } from 'lucide-react';

export function SelectionBar({
  count, convertibleCount, pageCount, allPageSelected, onTogglePage, onConvert, onTags, onClear, onDone
}) {
  return (
    <div className="selection-bar" role="region" aria-label="Selection">
      <p className="selection-count" aria-live="polite">
        <strong className="tabular">{count}</strong> selected
      </p>
      <button type="button" className="btn btn-small btn-on-dark" onClick={onTogglePage} disabled={!pageCount}>
        {allPageSelected ? 'Unselect page' : `Select page (${pageCount})`}
      </button>
      {count > 0 && (
        <button type="button" className="btn btn-small btn-on-dark" onClick={onClear}>Clear</button>
      )}
      <span className="selection-spacer" />
      <button
        type="button"
        className="btn btn-small btn-light"
        disabled={!convertibleCount}
        title={count && !convertibleCount ? 'None of the selected stickers can be converted right now' : undefined}
        onClick={onConvert}
      >
        <RefreshCw size={14} aria-hidden="true" /> Convert{convertibleCount ? ` ${convertibleCount}` : ''}
      </button>
      <button type="button" className="btn btn-small btn-light" disabled={!count} onClick={onTags}>
        <Tag size={14} aria-hidden="true" /> Tags…
      </button>
      <button type="button" className="icon-btn icon-on-dark" aria-label="Exit selection" onClick={onDone}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
