import { useRef } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, RefreshCw, Upload } from 'lucide-react';
import { LibraryToolbar } from './LibraryToolbar';
import { AttentionBar } from './AttentionBar';
import { StickerTile } from './StickerTile';

const SKELETON_COUNT = 12;

function ServiceUnavailable({ error, onRetry }) {
  return (
    <div className="state-panel" role="alert">
      <CircleAlert size={28} className="state-icon problem" aria-hidden="true" />
      <h2>Can’t connect to the local service</h2>
      <p>Start the local server (<code>npm run dev</code> or <code>npm start</code>), then retry. Your sticker files have not been changed.</p>
      {error && <p className="muted small">{error}</p>}
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        <RefreshCw size={16} aria-hidden="true" /> Retry connection
      </button>
    </div>
  );
}

export function LibraryView({
  catalogue, viewState, updateView, openSticker, preferences, setPreference,
  attention, attentionSamples, bootstrapState, bootstrapError, onRetry, onImport, searchRef
}) {
  const gridRef = useRef(null);
  const { items, total, page, pageCount, counts, libraryTotal } = catalogue;
  const pageSize = preferences.density === 'dense' ? 48 : 24;
  const hasFilters = Boolean(viewState.q) || viewState.type !== 'all' || viewState.status !== 'all';

  const goToPage = (nextPage) => {
    updateView({ page: nextPage }, { push: true });
    gridRef.current?.closest('.library-main')?.scrollIntoView({ block: 'start' });
  };

  // Arrow keys move focus across the grid, respecting the rendered column count.
  const onGridKeyDown = (event) => {
    const offsets = { ArrowLeft: -1, ArrowRight: 1 };
    const tiles = Array.from(gridRef.current?.querySelectorAll('.sticker-tile') || []);
    const index = tiles.indexOf(document.activeElement);
    if (index < 0) return;
    const columns = getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    let offset = offsets[event.key];
    if (event.key === 'ArrowUp') offset = -columns;
    if (event.key === 'ArrowDown') offset = columns;
    if (event.key === 'Home') offset = -index;
    if (event.key === 'End') offset = tiles.length - 1 - index;
    if (offset === undefined) return;
    event.preventDefault();
    tiles[Math.max(0, Math.min(tiles.length - 1, index + offset))]?.focus();
  };

  const showUnavailable = bootstrapState === 'error' && libraryTotal === 0;
  const showSkeleton = bootstrapState === 'loading' && libraryTotal === 0;

  return (
    <div className="library-main">
      <h1 className="sr-only">Sticker library</h1>

      {!showUnavailable && viewState.status !== 'action' && (
        <AttentionBar
          summary={attention}
          samples={attentionSamples}
          onShow={() => updateView({ status: 'action', type: 'all', q: '', page: 1 }, { push: true })}
        />
      )}

      <LibraryToolbar
        ref={searchRef}
        viewState={viewState}
        counts={counts}
        onChange={(patch) => updateView(patch)}
        preferences={preferences}
        setPreference={setPreference}
      />

      {showUnavailable ? (
        <ServiceUnavailable error={bootstrapError} onRetry={onRetry} />
      ) : showSkeleton ? (
        <ul className={`sticker-grid density-${preferences.density}`} aria-busy="true" aria-label="Loading stickers">
          {Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <li key={index} className="tile-item"><span className="tile-skeleton" /></li>
          ))}
        </ul>
      ) : libraryTotal === 0 ? (
        <div className="state-panel">
          <h2>No stickers yet</h2>
          <p>Import local images or short videos. They are converted on this computer and never uploaded anywhere.</p>
          <button type="button" className="btn btn-primary" onClick={onImport}>
            <Upload size={16} aria-hidden="true" /> Import files
          </button>
        </div>
      ) : total === 0 ? (
        <div className="state-panel">
          <h2>No stickers match your search</h2>
          <p className="muted">
            {[
              viewState.q && `Search “${viewState.q}”`,
              viewState.status !== 'all' && `status: ${viewState.status === 'action' ? 'needs action' : viewState.status}`,
              viewState.type !== 'all' && `type: ${viewState.type}`
            ].filter(Boolean).join(' · ')}
          </p>
          {hasFilters && (
            <button type="button" className="btn" onClick={() => updateView({ q: '', type: 'all', status: 'all', page: 1 })}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <ul
            ref={gridRef}
            className={`sticker-grid density-${preferences.density}`}
            aria-label={`Stickers, page ${page} of ${pageCount}`}
            onKeyDown={onGridKeyDown}
          >
            {items.map((sticker, index) => (
              <StickerTile
                key={sticker.id}
                sticker={sticker}
                selected={sticker.id === viewState.id}
                eager={index < 12}
                onOpen={openSticker}
              />
            ))}
          </ul>

          <nav className="pagination" aria-label="Pages">
            <span className="muted tabular">
              {(page - 1) * pageSize + 1}–{(page - 1) * pageSize + items.length} of {total}
            </span>
            {pageCount > 1 && (
              <div className="pagination-controls">
                <button type="button" className="btn" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                  <ChevronLeft size={16} aria-hidden="true" /> Previous
                </button>
                <span className="tabular" aria-current="page">Page {page} of {pageCount}</span>
                <button type="button" className="btn" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>
                  Next <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            )}
          </nav>
        </>
      )}
    </div>
  );
}
