import { forwardRef } from 'react';
import { Search, X, LayoutGrid, Grid3x3, SquareCheck } from 'lucide-react';

const BACKGROUNDS = [
  { value: 'neutral', label: 'Neutral preview background' },
  { value: 'checker', label: 'Transparency checkerboard' },
  { value: 'chat-light', label: 'Approximate Telegram light chat background' },
  { value: 'chat-dark', label: 'Approximate Telegram dark chat background' }
];

function Segmented({ label, options, value, onChange, className = '' }) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          aria-label={option.ariaLabel}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.content}
        </button>
      ))}
    </div>
  );
}

export const LibraryToolbar = forwardRef(function LibraryToolbar({
  viewState, counts, onChange, preferences, setPreference, selectionMode, onToggleSelectionMode, hasPacks
}, searchRef) {
  const statusChips = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'ready', label: 'Ready', count: counts.ready },
    { value: 'action', label: 'Needs action', count: counts.action, tone: 'warning' },
    ...(counts.converting > 0 || viewState.status === 'converting'
      ? [{ value: 'converting', label: 'Converting', count: counts.converting }]
      : [])
  ];

  return (
    <div className="library-toolbar">
      <label className="search-field">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">Search stickers</span>
        <input
          ref={searchRef}
          type="search"
          value={viewState.q}
          placeholder="Search ID, import name, tag…"
          onChange={(event) => onChange({ q: event.target.value, page: 1 })}
          autoComplete="off"
          spellCheck={false}
        />
        {viewState.q ? (
          <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => onChange({ q: '', page: 1 })}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : <kbd aria-hidden="true">/</kbd>}
      </label>

      <div className="toolbar-scroll">
        <div className="chip-group" role="group" aria-label="Status">
          {statusChips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={`chip ${chip.tone ? `chip-${chip.tone}` : ''}`}
              aria-pressed={viewState.status === chip.value}
              onClick={() => onChange({ status: chip.value, page: 1 })}
            >
              {chip.tone && <span className="chip-pip" aria-hidden="true" />}
              {chip.label} <span className="chip-count">{chip.count}</span>
            </button>
          ))}
        </div>

        {(hasPacks || viewState.unpacked) && (
          <button
            type="button"
            className="chip"
            aria-pressed={viewState.unpacked}
            onClick={() => onChange({ unpacked: !viewState.unpacked, page: 1 })}
          >
            Not in a pack
          </button>
        )}

        <Segmented
          label="Type"
          value={viewState.type}
          onChange={(type) => onChange({ type, page: 1 })}
          options={[
            { value: 'all', content: <>All <span className="chip-count">{counts.anyType}</span></> },
            { value: 'static', content: <>Static <span className="chip-count">{counts.static}</span></> },
            { value: 'animated', content: <>Animated <span className="chip-count">{counts.animated}</span></> }
          ]}
        />

        <span className="toolbar-spacer" />

        <button type="button" className="btn btn-toolbar" aria-pressed={selectionMode} onClick={onToggleSelectionMode}>
          <SquareCheck size={16} aria-hidden="true" /> Select
        </button>

        <label className="select-field">
          <span className="sr-only">Sort</span>
          <select value={viewState.sort} onChange={(event) => onChange({ sort: event.target.value, page: 1 })}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="largest">Largest output</option>
          </select>
        </label>

        <Segmented
          label="Preview background"
          className="bg-switch"
          value={preferences.previewBackground}
          onChange={(value) => setPreference('previewBackground', value)}
          options={BACKGROUNDS.map((background) => ({
            value: background.value,
            ariaLabel: background.label,
            title: background.label,
            content: <span className={`swatch swatch-${background.value}`} aria-hidden="true" />
          }))}
        />

        <Segmented
          label="Density"
          value={preferences.density}
          onChange={(value) => setPreference('density', value)}
          options={[
            { value: 'comfortable', ariaLabel: 'Comfortable grid', title: 'Comfortable grid', content: <LayoutGrid size={16} aria-hidden="true" /> },
            { value: 'dense', ariaLabel: 'Dense grid', title: 'Dense grid', content: <Grid3x3 size={16} aria-hidden="true" /> }
          ]}
        />
      </div>
    </div>
  );
});
