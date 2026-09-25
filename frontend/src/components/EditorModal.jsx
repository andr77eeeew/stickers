import { X, LoaderCircle } from 'lucide-react';

// Behaviour is unchanged from stage 2; the full editor redesign is stage 5.
export function EditorModal({
  editingSticker, setEditingSticker, modalRef, modalCloseRef, canvasRef,
  editorActiveFrame, setEditorActiveFrame, editorScale, setEditorScale,
  editorRotation, setEditorRotation, editorStrokeActive, setEditorStrokeActive,
  editorStrokeWidth, setEditorStrokeWidth, editorStrokeColor, setEditorStrokeColor,
  editorTopText, setEditorTopText, editorBottomText, setEditorBottomText,
  editorSaving, handleSaveEdit
}) {
  if (!editingSticker) return null;

  return (
    <div className="editor-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingSticker(null); }}>
      <div
        ref={modalRef}
        className="editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-modal-title"
      >
        <div className="editor-modal-header">
          <div>
            <h2 id="editor-modal-title">Edit sticker</h2>
            <p className="muted small mono">{String(editingSticker.id).slice(0, 8)}</p>
          </div>
          <button
            ref={modalCloseRef}
            type="button"
            onClick={() => setEditingSticker(null)}
            className="icon-btn"
            aria-label="Close sticker editor"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="editor-modal-body">
          <div className="editor-preview">
            <div className="editor-canvas-frame">
              <canvas
                ref={canvasRef}
                width={512}
                height={512}
                className="editor-canvas"
                role="img"
                aria-label="Preview of the customized sticker"
              />
            </div>

            {editingSticker.isAnimated && (
              <label className="editor-field">
                <span className="editor-field-row">
                  <span>Preview frame</span>
                  <span className="tabular">{editorActiveFrame} / {editingSticker.frames - 1}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={editingSticker.frames - 1}
                  step={1}
                  value={editorActiveFrame}
                  onChange={(event) => setEditorActiveFrame(parseInt(event.target.value, 10))}
                />
              </label>
            )}
            <p className="muted small">Preview composited on transparency. {editingSticker.isAnimated ? 'Shows one frame; the saved sticker uses the selected 3-second window.' : ''}</p>
          </div>

          <div className="editor-controls">
            <fieldset>
              <legend>Transform</legend>
              <label className="editor-field">
                <span className="editor-field-row"><span>Scale</span><span className="tabular">{editorScale.toFixed(2)}×</span></span>
                <input type="range" min={0.5} max={2.0} step={0.05} value={editorScale} onChange={(event) => setEditorScale(parseFloat(event.target.value))} />
              </label>
              <label className="editor-field">
                <span className="editor-field-row"><span>Rotation</span><span className="tabular">{editorRotation}°</span></span>
                <input type="range" min={-180} max={180} step={5} value={editorRotation} onChange={(event) => setEditorRotation(parseInt(event.target.value, 10))} />
              </label>
            </fieldset>

            <fieldset>
              <legend>Outline</legend>
              <label className="checkbox-row">
                <input type="checkbox" checked={editorStrokeActive} onChange={(event) => setEditorStrokeActive(event.target.checked)} />
                Add outline
              </label>
              {editorStrokeActive && (
                <>
                  <label className="editor-field">
                    <span className="editor-field-row"><span>Width</span><span className="tabular">{editorStrokeWidth} px</span></span>
                    <input type="range" min={1} max={20} step={1} value={editorStrokeWidth} onChange={(event) => setEditorStrokeWidth(parseInt(event.target.value, 10))} />
                  </label>
                  <label className="editor-field editor-color">
                    <span>Color</span>
                    <input type="color" value={editorStrokeColor} onChange={(event) => setEditorStrokeColor(event.target.value)} />
                    <span className="mono">{editorStrokeColor.toUpperCase()}</span>
                  </label>
                </>
              )}
            </fieldset>

            <fieldset>
              <legend>Text</legend>
              <label className="editor-field">
                <span>Top text</span>
                <input type="text" maxLength={100} value={editorTopText} onChange={(event) => setEditorTopText(event.target.value)} />
              </label>
              <label className="editor-field">
                <span>Bottom text</span>
                <input type="text" maxLength={100} value={editorBottomText} onChange={(event) => setEditorBottomText(event.target.value)} />
              </label>
            </fieldset>

            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setEditingSticker(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={handleSaveEdit} disabled={editorSaving}>
                {editorSaving ? <><LoaderCircle size={16} className="spin" aria-hidden="true" /> Saving…</> : 'Save & convert'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
