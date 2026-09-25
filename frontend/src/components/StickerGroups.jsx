import { Layers, Folder, Sparkles, CheckCircle, Tag, Clock, ArrowDownToLine, RefreshCw, AlertTriangle, Edit3 } from 'lucide-react';
import { PAGE_SIZE, getStickerDuration, getPersistedRange, getOriginalPath } from '../lib/stickerModel';

export function StickerGroups({
  filteredStickers, sortedDates, stickersByDate, selectedStartTimes, setSelectedStartTimes,
  editingTags, setEditingTags, handleSaveTags, handleConvert, openEditor,
  triggerBrowserDownload, visibleCount, setVisibleCount
}) {
  return (
    <>
        {/* Empty State */}
        {filteredStickers.length === 0 ? (
          <div className="glass-panel empty-state">
            <Layers className="empty-icon" size={56} />
            <h3 className="empty-title">No Stickers Yet</h3>
            <p className="empty-subtitle">
              Drop local images or videos above. Optional live capture works only through a manually opened DevTools Sticker Capture panel.
            </p>
          </div>
        ) : (
          /* Date-Grouped Stickers History Grid */
          <div className="date-groups-container" style={{ display: 'flex', flexDirection: 'column', gap: '40px' }}>
            {sortedDates.map((date) => (
              <div key={date} className="date-group-section" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <h3 className="date-group-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem', fontWeight: 700, paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <Folder size={18} style={{ color: 'var(--accent-cyan)' }} />
                  <span>Stickers captured on <strong style={{ color: 'white' }}>{date}</strong></span>
                  <span className="date-badge" style={{ background: 'rgba(6, 182, 212, 0.1)', color: 'var(--accent-cyan)', fontSize: '0.75rem', padding: '2px 8px', borderRadius: '10px', marginLeft: '6px', border: '1px solid rgba(6, 182, 212, 0.15)' }}>{stickersByDate[date].length}</span>
                </h3>
                <div className="sticker-grid">
                  {stickersByDate[date].map((sticker) => {
                    const stickerDuration = getStickerDuration(sticker);
                    const isLongDuration = sticker.isAnimated && stickerDuration > 3.0;
                    const persistedRange = getPersistedRange(sticker);
                    const maxSliceStart = Math.max(0, stickerDuration - 3.0);
                    const selectedStart = Math.min(
                      maxSliceStart,
                      Math.max(0, selectedStartTimes[sticker.id] ?? persistedRange.start)
                    );
                    const selectedEnd = Math.min(stickerDuration, selectedStart + 3.0);
                    const hasPersistedRange = Boolean(
                      sticker.selectedRange
                      || sticker.renderedRange
                      || sticker.conversion?.range
                      || Number.isFinite(Number(sticker.selectedStartTime))
                      || Number.isFinite(Number(sticker.startTime))
                      || Number.isFinite(Number(sticker.conversion?.startTime))
                    );
                    const renderedStart = hasPersistedRange
                      ? Math.min(stickerDuration, Math.max(0, persistedRange.start))
                      : selectedStart;
                    const renderedEnd = hasPersistedRange
                      ? Math.min(stickerDuration, Math.max(renderedStart, persistedRange.end))
                      : selectedEnd;
                    const isTagEditing = editingTags[sticker.id] !== undefined;

                    return (
                      <div key={sticker.id} className={`glass-panel glass-panel-interactive sticker-card status-${sticker.status}`}>
                        {/* Sticker Preview Container */}
                        <div className="sticker-preview-container">
                          <img
                            src={getOriginalPath(sticker)}
                            alt={`Sticker ${String(sticker.id || '').slice(0, 8)}`}
                            className="sticker-img"
                            loading="lazy"
                            decoding="async"
                          />
                          <div className={`sticker-badge ${sticker.isAnimated ? 'animated' : 'static'}`}>
                            {sticker.isAnimated ? (
                              <>
                                <Sparkles size={12} /> Animated
                              </>
                            ) : (
                              <>
                                <CheckCircle size={12} /> Static
                              </>
                            )}
                          </div>
                        </div>

                        {/* Sticker Metadata & Actions */}
                        <div className="sticker-info">
                          <div>
                            <div className="sticker-meta">
                              <span>ID: sticker_{String(sticker.id || '').slice(0, 8)}</span>
                              <span>{sticker.width}x{sticker.height} px</span>
                            </div>

                            {sticker.isAnimated && (
                              <div className="sticker-meta" style={{ marginTop: '4px', color: 'var(--text-secondary)' }}>
                                <span>Frames: {sticker.frames}</span>
                                <span>Duration: {stickerDuration.toFixed(2)}s</span>
                              </div>
                            )}

                            {/* Tags list rendering */}
                            <div className="tags-list">
                              {sticker.tags && sticker.tags.map(tag => (
                                <span key={tag} className="tag-badge">#{tag}</span>
                              ))}
                            </div>

                            {/* Tags inline editing form */}
                            {isTagEditing ? (
                              <div className="tag-input-container">
                                <input
                                  type="text"
                                  placeholder="tags separated by commas..."
                                  value={editingTags[sticker.id]}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setEditingTags(prev => ({ ...prev, [sticker.id]: val }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveTags(sticker.id);
                                  }}
                                  className="tag-edit-input"
                                  aria-label={`Tags for sticker ${String(sticker.id || '').slice(0, 8)}`}
                                />
                                <button className="tag-save-btn" onClick={() => handleSaveTags(sticker.id)}>Save</button>
                              </div>
                            ) : (
                              <button
                                className="tag-badge"
                                style={{ marginTop: '8px', cursor: 'pointer', background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.1)' }}
                                onClick={() => setEditingTags(prev => ({ ...prev, [sticker.id]: (sticker.tags || []).join(', ') }))}
                              >
                                <Tag size={8} style={{ marginRight: '4px', display: 'inline' }} /> Tag Sticker
                              </button>
                            )}

                            {/* Select the next slice independently from the persisted rendered range. */}
                            {isLongDuration && sticker.status !== 'converting' && (
                              <div className="time-slider-container">
                                <div className="time-slider-header">
                                  <span className="time-slider-title">
                                    <Clock size={12} style={{ color: 'var(--accent-fuchsia)' }} aria-hidden="true" />
                                    {sticker.status === 'converted' ? 'Next 3-second slice' : '3-second slice'}
                                  </span>
                                  <span className="time-slider-value">
                                    {selectedStart.toFixed(2)}s – {selectedEnd.toFixed(2)}s
                                  </span>
                                </div>
                                <div className="time-slider-wrapper">
                                  <input
                                    type="range"
                                    min={0}
                                    max={maxSliceStart}
                                    step={0.05}
                                    value={selectedStart}
                                    onChange={(event) => {
                                      const value = Number.parseFloat(event.target.value);
                                      setSelectedStartTimes((previous) => ({
                                        ...previous,
                                        [sticker.id]: value
                                      }));
                                    }}
                                    className="custom-range-slider"
                                    aria-label={`Start time for sticker ${String(sticker.id || '').slice(0, 8)}`}
                                  />
                                </div>
                              </div>
                            )}

                            {isLongDuration && sticker.status === 'converted' && (
                              <div className="time-slider-container rendered-range">
                                <div className="time-slider-header">
                                  <span className="time-slider-title" style={{ color: 'var(--accent-emerald)' }}>
                                    <CheckCircle size={12} aria-hidden="true" /> Rendered slice
                                  </span>
                                  <span className="time-slider-value rendered-range-value">
                                    {renderedStart.toFixed(2)}s – {renderedEnd.toFixed(2)}s
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="sticker-actions">
                            {/* Render action button based on conversion status */}
                            {sticker.status === 'captured' && (
                              <button
                                className="download-btn"
                                onClick={() => handleConvert(sticker.id)}
                              >
                                <ArrowDownToLine size={16} /> Convert for Telegram
                              </button>
                            )}

                            {sticker.status === 'converting' && (
                              <button className="download-btn" disabled>
                                <RefreshCw size={16} className="spinner" /> Slicing & Encoding...
                              </button>
                            )}

                            {sticker.status === 'converted' && (
                              <button
                                className="download-btn success"
                                onClick={() => handleConvert(sticker.id)}
                              >
                                <CheckCircle size={16} /> Re-Slice & Save
                              </button>
                            )}

                            {sticker.status === 'failed' && (
                              <button
                                className="download-btn failed"
                                onClick={() => handleConvert(sticker.id)}
                              >
                                <AlertTriangle size={16} /> Failed (Try Again)
                              </button>
                            )}

                            {/* Secondary Actions */}
                            <div className="secondary-actions">
                              <button
                                onClick={(event) => openEditor(sticker, event.currentTarget)}
                                className="action-btn-mini"
                                style={{ color: 'var(--accent-fuchsia)', borderColor: 'rgba(217, 70, 239, 0.2)' }}
                                title="Open in transparent HTML5 canvas editor"
                              >
                                <Edit3 size={12} /> Edit on Canvas
                              </button>

                              {sticker.status === 'converted' && (
                                <button
                                  onClick={() => triggerBrowserDownload(sticker)}
                                  className="action-btn-mini"
                                  style={{ color: 'var(--accent-cyan)', borderColor: 'rgba(6, 182, 212, 0.2)' }}
                                  title="Click to download the converted file to your local computer."
                                >
                                  <ArrowDownToLine size={12} /> Download
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {visibleCount < filteredStickers.length && (
              <button
                type="button"
                className="load-more-btn"
                onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
              >
                Load {Math.min(PAGE_SIZE, filteredStickers.length - visibleCount)} more stickers
              </button>
            )}
          </div>
        )}
    </>
  );
}
