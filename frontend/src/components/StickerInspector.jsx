import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, X, Download, Pencil, RefreshCw, Copy, Play, Pause, LoaderCircle,
  CircleCheck, TriangleAlert, CircleAlert, CircleHelp
} from 'lucide-react';
import { StickerMedia } from './StickerMedia';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { TagEditor } from './TagEditor';
import {
  getImportName, getOutputMediaPath, getPersistedRange, getShortId, getStickerDuration,
  getStickerState, getTelegramCheck, getUserTags, hasPersistedRange, isOriginalMissing,
} from '../lib/stickerModel';
import { describeFailure } from '../lib/jobModel';

const TONE_ICONS = {
  ok: CircleCheck,
  warning: TriangleAlert,
  problem: CircleAlert,
  unknown: CircleHelp
};
const TONE_LABELS = { ok: 'Passed', warning: 'Warning', problem: 'Problem', unknown: 'Unknown' };

function TelegramCheck({ rows }) {
  return (
    <ul className="check-list">
      {rows.map((row) => {
        const Icon = TONE_ICONS[row.tone];
        return (
          <li key={row.key} className={`check-row tone-${row.tone}`}>
            <Icon size={18} className="check-icon" aria-label={TONE_LABELS[row.tone]} />
            <span className="check-label">{row.label}</span>
            <span className="check-value tabular">{row.value}</span>
            {typeof row.ratio === 'number' && (
              <span className="meter" aria-hidden="true">
                <span style={{ transform: `scaleX(${row.ratio})` }} />
              </span>
            )}
            {row.note && <span className="check-note">{row.note}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function OutputPreview({ sticker }) {
  const reducedMotion = usePrefersReducedMotion();
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(!reducedMotion);
  const src = getOutputMediaPath(sticker);

  if (!sticker.isAnimated) {
    return <img className="sticker-media" src={src} alt="" decoding="async" />;
  }

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  return (
    <>
      <video
        ref={videoRef}
        className="sticker-media"
        src={src}
        autoPlay={!reducedMotion}
        loop
        muted
        playsInline
        aria-label="Converted Telegram video sticker"
      />
      <button type="button" className="badge badge-dark preview-play" onClick={toggle}>
        {playing ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
        {playing ? 'Pause' : 'Play'}
      </button>
    </>
  );
}

function SliceControl({ sticker, selectedStartTimes, setSelectedStartTimes }) {
  const duration = getStickerDuration(sticker);
  if (!sticker.isAnimated || duration <= 3 || sticker.status === 'converting') return null;

  const persisted = getPersistedRange(sticker);
  const maxStart = Math.max(0, duration - 3);
  const start = Math.min(maxStart, Math.max(0, selectedStartTimes[sticker.id] ?? persisted.start));
  const end = Math.min(duration, start + 3);
  const rendered = hasPersistedRange(sticker) && sticker.status === 'converted'
    ? { start: Math.min(duration, persisted.start), end: Math.min(duration, Math.max(persisted.start, persisted.end)) }
    : null;

  return (
    <section className="inspector-section">
      <h3>Animation slice</h3>
      <label className="slice-control">
        <span className="slice-header">
          <span>{sticker.status === 'converted' ? 'Next 3-second window' : '3-second window'}</span>
          <span className="tabular">{start.toFixed(2)}–{end.toFixed(2)} s</span>
        </span>
        <input
          type="range"
          min={0}
          max={maxStart}
          step={0.05}
          value={start}
          onChange={(event) => {
            const value = Number.parseFloat(event.target.value);
            setSelectedStartTimes((previous) => ({ ...previous, [sticker.id]: value }));
          }}
        />
      </label>
      <p className="muted small tabular">
        Source: {duration.toFixed(1)} s{rendered ? ` · Rendered: ${rendered.start.toFixed(2)}–${rendered.end.toFixed(2)} s` : ''}
      </p>
    </section>
  );
}

export function StickerInspector({
  sticker, loading, onClose, handleConvert, openEditor, triggerBrowserDownload,
  handleSaveTags, selectedStartTimes, setSelectedStartTimes, copyText
}) {
  const headingRef = useRef(null);
  const state = sticker ? getStickerState(sticker) : null;
  const outputAvailable = state === 'ready' || state === 'over_limit' || state === 'unmeasured';
  // 'auto' follows output availability until the viewer picks a source.
  const [pickedMode, setMode] = useState('auto');
  const mode = pickedMode === 'auto' ? (outputAvailable ? 'telegram' : 'original') : pickedMode;

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const header = (title) => (
    <div className="inspector-header">
      <button type="button" className="btn btn-ghost inspector-back" onClick={onClose}>
        <ArrowLeft size={16} aria-hidden="true" /> Back
      </button>
      <h2 ref={headingRef} tabIndex={-1}>{title}</h2>
      <button type="button" className="icon-btn inspector-close" aria-label="Close details" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );

  if (!sticker) {
    return (
      <aside className="inspector" aria-label="Sticker details">
        {header(loading ? 'Loading…' : 'Sticker not found')}
        {!loading && <p className="muted">This sticker is not in the library. It may have been opened from an old link.</p>}
      </aside>
    );
  }

  const originalMissing = isOriginalMissing(sticker);
  const shortId = getShortId(sticker);
  const outputLabel = sticker.isAnimated ? 'WebM' : 'WebP';
  const importName = getImportName(sticker);
  const convertBlockedReason = originalMissing ? 'The original file is missing on disk.' : null;

  let primary;
  if (state === 'converting') {
    primary = <button type="button" className="btn btn-primary btn-block" disabled><LoaderCircle size={16} className="spin" aria-hidden="true" /> Converting…</button>;
  } else if (outputAvailable) {
    primary = (
      <button type="button" className="btn btn-primary btn-block" onClick={() => triggerBrowserDownload(sticker)}>
        <Download size={16} aria-hidden="true" /> Download {outputLabel}
      </button>
    );
  } else {
    const label = state === 'captured' ? 'Convert for Telegram' : state === 'failed' ? 'Retry conversion' : 'Re-convert';
    primary = (
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={Boolean(convertBlockedReason)}
        onClick={() => handleConvert(sticker.id)}
      >
        <RefreshCw size={16} aria-hidden="true" /> {label}
      </button>
    );
  }

  const telegramDisabledReason = outputAvailable
    ? null
    : state === 'output_missing' ? 'Output missing' : 'Not converted yet';

  return (
    <aside className="inspector" aria-label="Sticker details">
      {header(<>Sticker <span className="mono">{shortId}</span></>)}

      <div className="inspector-preview preview-surface">
        {mode === 'telegram' && outputAvailable
          ? <OutputPreview sticker={sticker} />
          : <StickerMedia sticker={sticker} eager />}
      </div>
      <div className="segmented segmented-block" role="group" aria-label="Preview source">
        <button type="button" aria-pressed={mode === 'original'} onClick={() => setMode('original')}>Original</button>
        <button
          type="button"
          aria-pressed={mode === 'telegram' && outputAvailable}
          disabled={!outputAvailable}
          title={telegramDisabledReason || undefined}
          onClick={() => setMode('telegram')}
        >
          Telegram{telegramDisabledReason ? ` · ${telegramDisabledReason}` : ''}
        </button>
      </div>

      <section className="inspector-section">
        <h3>Telegram check</h3>
        <TelegramCheck rows={getTelegramCheck(sticker)} />
      </section>

      <div className="inspector-actions">
        {primary}
        <button
          type="button"
          className="btn"
          disabled={Boolean(convertBlockedReason) || state === 'converting'}
          onClick={(event) => openEditor(sticker, event.currentTarget)}
        >
          <Pencil size={16} aria-hidden="true" /> Edit
        </button>
        {outputAvailable ? (
          <button
            type="button"
            className="btn"
            disabled={Boolean(convertBlockedReason)}
            onClick={() => handleConvert(sticker.id)}
          >
            <RefreshCw size={16} aria-hidden="true" /> Re-convert
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => copyText(sticker.id, 'Sticker ID copied')}>
            <Copy size={16} aria-hidden="true" /> Copy ID
          </button>
        )}
        {convertBlockedReason && <p className="action-note">{convertBlockedReason} Convert and Edit are unavailable.</p>}
        {state === 'failed' && !convertBlockedReason && sticker.error && (
          <p className="action-note">{describeFailure(sticker.error)}</p>
        )}
      </div>

      <SliceControl
        sticker={sticker}
        selectedStartTimes={selectedStartTimes}
        setSelectedStartTimes={setSelectedStartTimes}
      />

      <section className="inspector-section">
        <h3>Tags</h3>
        <TagEditor
          key={sticker.id}
          initialTags={getUserTags(sticker)}
          onSave={(tags) => handleSaveTags(sticker.id, tags)}
        />
      </section>

      <section className="inspector-section">
        <h3>Details</h3>
        <dl className="details-list">
          <dt>ID</dt>
          <dd>
            <span className="mono break">{sticker.id}</span>
            <button type="button" className="icon-btn" aria-label="Copy sticker ID" onClick={() => copyText(sticker.id, 'Sticker ID copied')}>
              <Copy size={14} aria-hidden="true" />
            </button>
          </dd>
          <dt>Type</dt>
          <dd>{sticker.isAnimated ? `Animated${sticker.frames ? ` · ${sticker.frames} frames` : ''}` : 'Static'}</dd>
          {sticker.capturedAt && (<><dt>Imported</dt><dd>{new Date(sticker.capturedAt).toLocaleString()}</dd></>)}
          <dt>Source</dt>
          <dd>{sticker.captureSource === 'devtools' ? 'DevTools capture' : sticker.captureSource === 'manual' ? 'Manual import' : 'Earlier capture'}</dd>
          {importName && (<><dt>Import name</dt><dd className="break">{importName}</dd></>)}
          {sticker.convertedAt && (<><dt>Converted</dt><dd>{new Date(sticker.convertedAt).toLocaleString()}</dd></>)}
        </dl>
      </section>
    </aside>
  );
}
