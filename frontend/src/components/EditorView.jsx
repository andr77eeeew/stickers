import { useEffect, useId, useState } from 'react';
import { ArrowLeft, Undo2, RotateCcw, LoaderCircle } from 'lucide-react';
import { useStickerEditor } from '../hooks/useStickerEditor';
import { ConfirmDialog } from './ConfirmDialog';
import { EDITOR_LIMITS, sampleFrames } from '../lib/editorModel';
import { getShortId, isOriginalMissing } from '../lib/stickerModel';
import { describeFailure } from '../lib/jobModel';

function NumberField({ label, unit, value, limits, onChange, onCommit, disabled }) {
  const id = useId();
  return (
    <div className="editor-field">
      <label htmlFor={id} className="editor-field-row">
        <span>{label}</span>
      </label>
      <div className="number-field">
        <input
          type="range"
          aria-labelledby={id}
          min={limits.min}
          max={limits.max}
          step={limits.step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
        />
        <span className="number-input">
          <input
            id={id}
            type="number"
            min={limits.min}
            max={limits.max}
            step={limits.step}
            value={value}
            disabled={disabled}
            onChange={(event) => event.target.value !== '' && onChange(Number(event.target.value))}
            onBlur={onCommit}
          />
          <span className="unit" aria-hidden="true">{unit}</span>
        </span>
      </div>
    </div>
  );
}

function EditorBody({ sticker, onExit, setStickers, selectedStartTimes, setSelectedStartTimes, showToast }) {
  const editor = useStickerEditor({
    sticker,
    initialStart: selectedStartTimes[sticker.id],
    setStickers,
    setSelectedStartTimes,
    showToast
  });
  const {
    canvasRef, params, start, animationWindow, frameIndex, setPreviewFrame, mode, setMode,
    update, checkpoint, undo, reset, canUndo, dirty, save, saving, saveError, previewError
  } = editor;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleId = useId();
  const sliceId = useId();

  const requestExit = () => {
    if (dirty) setConfirmDiscard(true);
    else onExit();
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (dirty) setConfirmDiscard(true);
        else onExit();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === 'text') return;
        event.preventDefault();
        undo();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dirty, onExit, undo]);

  const handleSave = async () => {
    if (await save()) onExit();
  };

  const setParam = (key) => (value) => update({ params: { [key]: value } });
  const filmstrip = animationWindow ? sampleFrames(animationWindow.startFrame, animationWindow.endFrame, 8) : [];

  return (
    <div className="editor-page">
      <div className="editor-bar">
        <button type="button" className="btn btn-ghost" onClick={requestExit}>
          <ArrowLeft size={16} aria-hidden="true" /> Library
        </button>
        <div className="editor-title">
          <h1 id={titleId}>Edit sticker</h1>
          <p className="muted small mono">{getShortId(sticker)} · {sticker.isAnimated ? 'animated → WebM' : 'static → WebP'}</p>
        </div>
        <div className="editor-bar-actions">
          <button type="button" className="btn btn-ghost" onClick={undo} disabled={!canUndo || saving} title="Undo (Ctrl+Z)">
            <Undo2 size={16} aria-hidden="true" /> <span className="hide-narrow">Undo</span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={reset} disabled={!dirty || saving}>
            <RotateCcw size={16} aria-hidden="true" /> <span className="hide-narrow">Reset</span>
          </button>
          <button type="button" className="btn hide-narrow" onClick={requestExit} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <><LoaderCircle size={16} className="spin" aria-hidden="true" /> Saving…</> : 'Save & convert'}
          </button>
        </div>
      </div>

      {saveError && (
        <p className="inline-alert tone-problem editor-alert" role="alert">
          {describeFailure(saveError)} Your settings are kept — adjust them and try again.
        </p>
      )}

      <div className="editor-layout" aria-labelledby={titleId}>
        <section className="editor-stage" aria-label="Preview">
          <div className="segmented" role="group" aria-label="Preview">
            <button type="button" aria-pressed={mode === 'original'} onClick={() => setMode('original')}>Original</button>
            <button type="button" aria-pressed={mode === 'telegram'} onClick={() => setMode('telegram')}>Telegram</button>
          </div>
          <div className="editor-canvas-frame">
            <canvas
              ref={canvasRef}
              width={512}
              height={512}
              className="editor-canvas"
              role="img"
              aria-label={mode === 'original' ? 'Original sticker' : 'Preview with your settings'}
            />
          </div>
          {previewError && <p className="field-error">{previewError}</p>}
          <p className="muted small">
            {sticker.isAnimated
              ? `Frame ${frameIndex + 1} of ${sticker.frames}. One frame with approximate effects — the WebM is rendered by the local server from the selected window.`
              : 'The saved WebP is rendered from exactly this preview.'}
          </p>

          {animationWindow && (
            <>
              <ul className="filmstrip" aria-label="Frames in the selected window">
                {filmstrip.map((index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="filmstrip-frame"
                      aria-pressed={index === frameIndex}
                      aria-label={`Preview frame ${index + 1}`}
                      onClick={() => setPreviewFrame(index)}
                    >
                      <img src={`/api/stickers/${sticker.id}/frame/${index}`} alt="" loading="lazy" decoding="async" />
                    </button>
                  </li>
                ))}
              </ul>

              <div className="slice-control editor-slice">
                <label htmlFor={sliceId} className="slice-header">
                  <span>Animation slice start</span>
                  <span className="tabular">
                    Selected: {animationWindow.start.toFixed(1)}–{animationWindow.end.toFixed(1)} s ({animationWindow.length.toFixed(1)} s)
                  </span>
                </label>
                <input
                  id={sliceId}
                  type="range"
                  min={0}
                  max={animationWindow.maxStart}
                  step={0.05}
                  value={start}
                  disabled={animationWindow.maxStart === 0}
                  onChange={(event) => update({ start: Number(event.target.value) })}
                  onPointerUp={checkpoint}
                  onKeyUp={checkpoint}
                />
                <p className="muted small tabular">
                  Source: {animationWindow.sourceDuration.toFixed(1)} s ·{' '}
                  {animationWindow.maxStart === 0
                    ? 'The whole animation fits into one Telegram sticker.'
                    : `Telegram allows up to ${EDITOR_LIMITS.windowSeconds} s; move the start to choose the part.`}
                </p>
              </div>
            </>
          )}
        </section>

        <section className="editor-controls" aria-label="Settings">
          <fieldset>
            <legend>Transform</legend>
            <NumberField label="Scale" unit="×" value={params.scale} limits={EDITOR_LIMITS.scale} onChange={setParam('scale')} onCommit={checkpoint} />
            <NumberField label="Rotation" unit="°" value={params.rotation} limits={EDITOR_LIMITS.rotation} onChange={setParam('rotation')} onCommit={checkpoint} />
          </fieldset>

          <details className="editor-group" open>
            <summary>Outline</summary>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={params.strokeActive}
                onChange={(event) => { update({ params: { strokeActive: event.target.checked } }); checkpoint(); }}
              />
              Add outline
            </label>
            <NumberField label="Width" unit="px" value={params.strokeWidth} limits={EDITOR_LIMITS.strokeWidth} onChange={setParam('strokeWidth')} onCommit={checkpoint} disabled={!params.strokeActive} />
            <label className="editor-field editor-color">
              <span>Color</span>
              <input
                type="color"
                value={params.strokeColor}
                disabled={!params.strokeActive}
                onChange={(event) => update({ params: { strokeColor: event.target.value } })}
                onBlur={checkpoint}
              />
              <span className="mono">{params.strokeColor.toUpperCase()}</span>
            </label>
          </details>

          <details className="editor-group" open>
            <summary>Text</summary>
            {[
              { key: 'topText', label: 'Top text' },
              { key: 'bottomText', label: 'Bottom text' }
            ].map((field) => (
              <label key={field.key} className="editor-field">
                <span className="editor-field-row">
                  <span>{field.label}</span>
                  <span className="muted small tabular">{params[field.key].length}/{EDITOR_LIMITS.textLength}</span>
                </span>
                <input
                  type="text"
                  className="text-input"
                  maxLength={EDITOR_LIMITS.textLength}
                  value={params[field.key]}
                  onChange={(event) => update({ params: { [field.key]: event.target.value } })}
                  onBlur={checkpoint}
                />
              </label>
            ))}
          </details>

          <p className="muted small">{dirty ? 'Changes are local until you save.' : 'No changes yet.'}</p>
        </section>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard changes?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => { setConfirmDiscard(false); onExit(); }}
      >
        <p>Your edits to this sticker have not been saved. The current Telegram file stays as it is.</p>
      </ConfirmDialog>
    </div>
  );
}

export function EditorView({ sticker, loading, onExit, ...rest }) {
  if (!sticker) {
    return (
      <div className="page">
        <div className="state-panel">
          <h1>{loading ? 'Loading…' : 'Sticker not found'}</h1>
          {!loading && <button type="button" className="btn" onClick={onExit}>Back to library</button>}
        </div>
      </div>
    );
  }
  if (isOriginalMissing(sticker)) {
    return (
      <div className="page">
        <div className="state-panel" role="alert">
          <h1>Editing is unavailable</h1>
          <p>The original file of this sticker is missing on disk, so it cannot be edited or converted again. An existing Telegram file can still be downloaded from the library.</p>
          <button type="button" className="btn" onClick={onExit}>Back to library</button>
        </div>
      </div>
    );
  }
  return <EditorBody key={sticker.id} sticker={sticker} onExit={onExit} {...rest} />;
}
