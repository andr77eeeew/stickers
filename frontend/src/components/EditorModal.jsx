import { Sliders, Type, RotateCw, RefreshCw } from 'lucide-react';

export function EditorModal({
  editingSticker, setEditingSticker, modalRef, modalCloseRef, canvasRef,
  editorActiveFrame, setEditorActiveFrame, editorScale, setEditorScale,
  editorRotation, setEditorRotation, editorStrokeActive, setEditorStrokeActive,
  editorStrokeWidth, setEditorStrokeWidth, editorStrokeColor, setEditorStrokeColor,
  editorTopText, setEditorTopText, editorBottomText, setEditorBottomText,
  editorSaving, handleSaveEdit
}) {
  return (
    <>
      {/* ----------------------------------------------------
          Creative HTML5 Canvas Editor Modal overlay
          ---------------------------------------------------- */}
      {editingSticker && (
        <div className="editor-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingSticker(null); }}>
          <div
            ref={modalRef}
            className="editor-modal-container glass-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="editor-modal-title"
          >
            <div className="editor-modal-content">

              {/* Left Pane - Drawing Canvas & Frame controls */}
              <div className="editor-left">
                <h3 className="companion-title" style={{ fontSize: '1.15rem' }}>🎯 CREATOR CANVAS</h3>

                <div className="canvas-wrapper">
                  <canvas
                    ref={canvasRef}
                    width={512}
                    height={512}
                    className="canvas-preview"
                    role="img"
                    aria-label="Preview of the customized sticker"
                  />
                </div>

                {editingSticker.isAnimated && (
                  <div className="editor-control-group" style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      <span>Scrub Preview Frames:</span>
                      <span style={{ fontFamily: 'monospace', color: 'var(--accent-cyan)' }}>{editorActiveFrame} / {editingSticker.frames - 1}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={editingSticker.frames - 1}
                      step={1}
                      value={editorActiveFrame}
                      onChange={(e) => setEditorActiveFrame(parseInt(e.target.value))}
                      className="custom-range-slider"
                      style={{ background: 'rgba(6, 182, 212, 0.15)' }}
                      aria-label="Preview animation frame"
                    />
                  </div>
                )}

                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  Visual Preview - Transparent Alpha Composited
                </span>
              </div>

              {/* Right Pane - Creative Sliders & Options controls */}
              <div className="editor-right">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 id="editor-modal-title" style={{ fontSize: '1.2rem', background: 'var(--gradient-cyber)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                    Sticker Customizer
                  </h3>
                  <button
                    ref={modalCloseRef}
                    type="button"
                    onClick={() => setEditingSticker(null)}
                    className="editor-close-btn"
                    aria-label="Close sticker editor"
                  >
                    &times;
                  </button>
                </div>

                {/* Transformations */}
                <div className="editor-control-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <label className="editor-control-label"><Sliders size={12} style={{ display: 'inline', marginRight: '4px' }} /> Scale Layout</label>
                    <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--accent-fuchsia)' }}>{editorScale.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.0}
                    step={0.05}
                    value={editorScale}
                    onChange={(e) => setEditorScale(parseFloat(e.target.value))}
                    className="custom-range-slider"
                    aria-label="Sticker scale"
                  />
                </div>

                <div className="editor-control-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <label className="editor-control-label"><RotateCw size={12} style={{ display: 'inline', marginRight: '4px' }} /> Rotation Angle</label>
                    <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--accent-fuchsia)' }}>{editorRotation}°</span>
                  </div>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={5}
                    value={editorRotation}
                    onChange={(e) => setEditorRotation(parseInt(e.target.value, 10))}
                    className="custom-range-slider"
                    aria-label="Sticker rotation in degrees"
                  />
                </div>

                {/* Outline stroke border */}
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }} />

                <div className="editor-control-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={editorStrokeActive}
                      onChange={(e) => setEditorStrokeActive(e.target.checked)}
                      style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: 'var(--accent-fuchsia)' }}
                    />
                    <span className="editor-control-label" style={{ userSelect: 'none' }}>Active Transparent Stroke Outline</span>
                  </label>
                </div>

                {editorStrokeActive && (
                  <>
                    <div className="editor-control-group">
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label className="editor-control-label">Stroke Width (Thickness)</label>
                        <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--accent-cyan)' }}>{editorStrokeWidth}px</span>
                      </div>
                      <input
                        type="range"
                        min={1}
                        max={20}
                        step={1}
                        value={editorStrokeWidth}
                        onChange={(e) => setEditorStrokeWidth(parseInt(e.target.value, 10))}
                        className="custom-range-slider"
                        aria-label="Outline stroke width"
                      />
                    </div>

                    <div className="editor-control-group">
                      <label className="editor-control-label">Stroke Border Color</label>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <input
                          type="color"
                          value={editorStrokeColor}
                          onChange={(e) => setEditorStrokeColor(e.target.value)}
                          aria-label="Outline stroke color"
                          style={{ border: 'none', width: '36px', height: '36px', cursor: 'pointer', background: 'transparent' }}
                        />
                        <span style={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>{editorStrokeColor.toUpperCase()}</span>
                      </div>
                    </div>
                  </>
                )}

                {/* Meme Texts */}
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }} />

                <div className="editor-control-group">
                  <label className="editor-control-label"><Type size={12} style={{ display: 'inline', marginRight: '4px' }} /> Top Text Overlay</label>
                  <input
                    type="text"
                    placeholder="e.g. COMPILING CODE WITHOUT LINTS..."
                    value={editorTopText}
                    onChange={(e) => setEditorTopText(e.target.value)}
                    className="editor-input"
                    aria-label="Top text overlay"
                  />
                </div>

                <div className="editor-control-group">
                  <label className="editor-control-label"><Type size={12} style={{ display: 'inline', marginRight: '4px' }} /> Bottom Text Overlay</label>
                  <input
                    type="text"
                    placeholder="e.g. FIRST TRY!"
                    value={editorBottomText}
                    onChange={(e) => setEditorBottomText(e.target.value)}
                    className="editor-input"
                    aria-label="Bottom text overlay"
                  />
                </div>

                {/* Saving / Apply Buttons */}
                <div style={{ display: 'flex', gap: '12px', marginTop: 'auto', paddingTop: '20px' }}>
                  <button
                    type="button"
                    onClick={() => setEditingSticker(null)}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', color: 'white', cursor: 'pointer', fontWeight: 600 }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    disabled={editorSaving}
                    className="download-btn success"
                    style={{ flex: 1.5 }}
                  >
                    {editorSaving ? (
                      <>
                        <RefreshCw size={16} className="spinner" /> Compiling Custom...
                      </>
                    ) : (
                      <>
                        💎 Apply & Compile Sticker
                      </>
                    )}
                  </button>
                </div>

              </div>

            </div>
          </div>
        </div>
      )}
    </>
  );
}
