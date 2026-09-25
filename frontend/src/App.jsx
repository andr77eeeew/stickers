import React, { useState, useEffect, useRef } from 'react';
import { useStickerSession } from './hooks/useStickerSession';
import { useStickerEditor } from './hooks/useStickerEditor';
import { useStickerActions } from './hooks/useStickerActions';
import { useManualImport } from './hooks/useManualImport';
import { StatusSection } from './components/StatusSection';
import { LibraryStats } from './components/LibraryStats';
import { ManualImportZone } from './components/ManualImportZone';
import { StickerGroups } from './components/StickerGroups';
import { EditorModal } from './components/EditorModal';
import { PAGE_SIZE, selectLibrary } from './lib/stickerModel';
import { CheckCircle, AlertTriangle, Archive, Info } from 'lucide-react';

export default function App() {
  const {
    stickers, setStickers,
    bootstrapState, bootstrapError,
    captureStatus, setCaptureStatus,
    sessionInfo, setSessionInfo,
    outputPaths, socketConnected
  } = useStickerSession();
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'static' | 'animated'
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [toastMessage, setToastMessage] = useState(null);
  // Custom slider state dictionary mapping sticker.id -> selectedStartTime (seconds)
  const [selectedStartTimes, setSelectedStartTimes] = useState({});
  
  const toastTimerRef = useRef(null);

  const showToast = (message) => {
    setToastMessage(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 4000);
  };

  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  const editor = useStickerEditor({ setStickers, selectedStartTimes, showToast });
  const { openEditor } = editor;
  const {
    editingTags, setEditingTags, archiving, folderCopySuccess,
    handleConvert, handleSaveTags, triggerBrowserDownload,
    handleArchiveLibrary, handleResetSession, copyFolderPath, outputPath
  } = useStickerActions({
    stickers, setStickers, selectedStartTimes, showToast,
    captureStatus, setCaptureStatus, setSessionInfo, outputPaths
  });
  const {
    manualImporting, manualAutoConvert, setManualAutoConvert,
    manualDragOver, setManualDragOver, fileInputRef, handleManualFiles
  } = useManualImport({ bootstrapState, setStickers, showToast, handleConvert });




  const {
    filteredStickers, totalCount, staticCount, animatedCount, stickersByDate, sortedDates
  } = selectLibrary(stickers, activeTab, searchQuery, visibleCount);
  return (
    <div className="app-container">
      <StatusSection
        socketConnected={socketConnected}
        bootstrapState={bootstrapState}
        bootstrapError={bootstrapError}
        captureStatus={captureStatus}
        sessionInfo={sessionInfo}
        outputPaths={outputPaths}
        folderCopySuccess={folderCopySuccess}
        copyFolderPath={copyFolderPath}
        handleResetSession={handleResetSession}
      />

      <LibraryStats totalCount={totalCount} staticCount={staticCount} animatedCount={animatedCount} />

      {/* Main Section */}
      <main className="main-section">

        <ManualImportZone
          manualDragOver={manualDragOver}
          setManualDragOver={setManualDragOver}
          manualImporting={manualImporting}
          manualAutoConvert={manualAutoConvert}
          setManualAutoConvert={setManualAutoConvert}
          bootstrapState={bootstrapState}
          fileInputRef={fileInputRef}
          handleManualFiles={handleManualFiles}
        />
        
        {/* Glow Search Filter Container */}
        <div className="search-container">
          <label className="sr-only" htmlFor="sticker-search">Search stickers</label>
          <input
            id="sticker-search"
            type="search"
            placeholder="Search stickers by ID, filename, or manual tags…"
            value={searchQuery}
            onChange={(event) => { setSearchQuery(event.target.value); setVisibleCount(PAGE_SIZE); }}
            className="search-input"
          />
        </div>

        {/* Filters and Actions */}
        <div className="filter-bar">
          <div className="tabs" role="group" aria-label="Sticker type filter">
            <button 
              className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => { setActiveTab('all'); setVisibleCount(PAGE_SIZE); }}
              aria-pressed={activeTab === 'all'}
            >
              All Intercepted
            </button>
            <button 
              className={`tab-btn ${activeTab === 'static' ? 'active' : ''}`}
              onClick={() => { setActiveTab('static'); setVisibleCount(PAGE_SIZE); }}
              aria-pressed={activeTab === 'static'}
            >
              Static ({staticCount})
            </button>
            <button 
              className={`tab-btn ${activeTab === 'animated' ? 'active' : ''}`}
              onClick={() => { setActiveTab('animated'); setVisibleCount(PAGE_SIZE); }}
              aria-pressed={activeTab === 'animated'}
            >
              Animated ({animatedCount})
            </button>
          </div>

          {stickers.length > 0 && (
            <button
              type="button"
              className="archive-btn"
              onClick={handleArchiveLibrary}
              disabled={archiving || bootstrapState !== 'ready'}
              title="Copy the current database and media to a dated archive; the active library remains unchanged"
            >
              <Archive size={16} aria-hidden="true" /> {archiving ? 'Creating snapshot...' : 'Create archive snapshot'}
            </button>
          )}
        </div>

        <StickerGroups
          filteredStickers={filteredStickers}
          sortedDates={sortedDates}
          stickersByDate={stickersByDate}
          selectedStartTimes={selectedStartTimes}
          setSelectedStartTimes={setSelectedStartTimes}
          editingTags={editingTags}
          setEditingTags={setEditingTags}
          handleSaveTags={handleSaveTags}
          handleConvert={handleConvert}
          openEditor={openEditor}
          triggerBrowserDownload={triggerBrowserDownload}
          visibleCount={visibleCount}
          setVisibleCount={setVisibleCount}
        />

        {/* Output instructions helper card */}
        {stickers.some(s => s.status === 'converted') && (
          <div className="glass-panel instructions-panel">
            <Info size={22} style={{ color: 'var(--accent-cyan)', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <h4>Stickers Export & Upload Guide</h4>
              <p style={{ marginTop: '4px' }}>
                Converted files are saved to the directories reported by the local server:
                <br />
                • Animated WebM: <code style={{ color: 'var(--accent-fuchsia)' }}>{outputPath('animated')}</code>
                <br />
                • Static WebP: <code style={{ color: 'var(--accent-emerald)' }}>{outputPath('statics')}</code>
                <br />
                Upload them manually through the official Telegram <a href="https://t.me/stickers" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-purple)', fontWeight: 700, textDecoration: 'none' }}>@Stickers</a> bot. This application never publishes to Telegram automatically.
              </p>
            </div>
          </div>
        )}
      </main>

      <EditorModal {...editor} />

      {/* Premium Toast Notification */}
      {toastMessage && (
        <div className="toast glass-panel" role="status" aria-live="polite" aria-atomic="true">
          {toastMessage.includes('❌') ? (
            <AlertTriangle size={18} style={{ color: 'var(--status-red)' }} />
          ) : (
            <CheckCircle size={18} style={{ color: 'var(--accent-emerald)' }} />
          )}
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
