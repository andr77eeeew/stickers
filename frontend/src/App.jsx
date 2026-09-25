import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleAlert } from 'lucide-react';
import { useStickerSession } from './hooks/useStickerSession';
import { useStickerEditor } from './hooks/useStickerEditor';
import { useStickerActions } from './hooks/useStickerActions';
import { useManualImport } from './hooks/useManualImport';
import { useViewState } from './hooks/useViewState';
import { usePreferences } from './hooks/usePreferences';
import { AppHeader } from './components/AppHeader';
import { LibraryView } from './components/LibraryView';
import { StickerInspector } from './components/StickerInspector';
import { ImportPanel } from './components/ImportPanel';
import { HealthView } from './components/HealthView';
import { EditorModal } from './components/EditorModal';
import {
  PAGE_SIZE, PAGE_SIZE_DENSE, needsAction, selectCatalogue, summarizeAttention
} from './lib/stickerModel';

const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

export default function App() {
  const session = useStickerSession();
  const {
    stickers, setStickers, bootstrapState, bootstrapError, captureStatus, setCaptureStatus,
    sessionInfo, setSessionInfo, outputPaths, socketConnected, retryConnection, refreshStatus
  } = session;
  const { viewState, updateView, openSticker, closeSticker } = useViewState();
  const { preferences, setPreference } = usePreferences();
  const [toast, setToast] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  // Selected 3-second window per animated sticker id (seconds).
  const [selectedStartTimes, setSelectedStartTimes] = useState({});
  const toastTimerRef = useRef(null);
  const searchRef = useRef(null);
  const dragDepthRef = useRef(0);

  const showToast = useCallback((message, tone = 'ok') => {
    setToast({ message, tone });
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), tone === 'error' ? 7000 : 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  const editor = useStickerEditor({ setStickers, selectedStartTimes, showToast });
  const actions = useStickerActions({
    stickers, setStickers, selectedStartTimes, showToast,
    captureStatus, setCaptureStatus, setSessionInfo, outputPaths
  });
  const importer = useManualImport({ bootstrapState, setStickers, showToast, handleConvert: actions.handleConvert });
  const { handleManualFiles } = importer;

  const pageSize = preferences.density === 'dense' ? PAGE_SIZE_DENSE : PAGE_SIZE;
  const catalogue = useMemo(
    () => selectCatalogue(stickers, { ...viewState, pageSize }),
    [stickers, viewState, pageSize]
  );
  const attention = useMemo(() => summarizeAttention(stickers), [stickers]);
  const attentionSamples = useMemo(() => stickers.filter(needsAction).slice(0, 5), [stickers]);
  const selectedSticker = viewState.id ? stickers.find((sticker) => sticker.id === viewState.id) || null : null;
  const inspectorOpen = viewState.view === 'library' && Boolean(viewState.id);

  // Keep the URL page within range after filters or WebSocket updates shrink the list.
  useEffect(() => {
    if (stickers.length && catalogue.page !== viewState.page) updateView({ page: catalogue.page });
  }, [catalogue.page, viewState.page, stickers.length, updateView]);

  const handleCloseInspector = useCallback(() => {
    const id = viewState.id;
    closeSticker();
    window.setTimeout(() => {
      document.querySelector(`[data-sticker-id="${id}"]`)?.focus({ preventScroll: false });
    }, 0);
  }, [closeSticker, viewState.id]);

  // "/" focuses search from anywhere outside a text field.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('dialog[open], .editor-modal-backdrop')) return;
      event.preventDefault();
      if (viewState.view !== 'library') updateView({ view: 'library' }, { push: true });
      window.setTimeout(() => searchRef.current?.focus(), 0);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [viewState.view, updateView]);

  // Files dropped anywhere in the window go through the same local import path.
  useEffect(() => {
    const onDragEnter = (event) => {
      if (!hasFiles(event)) return;
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onDragOver = (event) => { if (hasFiles(event)) event.preventDefault(); };
    const onDragLeave = (event) => {
      if (!hasFiles(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current) setDragActive(false);
    };
    const onDrop = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      setImportOpen(true);
      handleManualFiles(event.dataTransfer.files);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleManualFiles]);

  const navigate = (view) => updateView({ view, id: null }, { push: true });
  const showNeedsAction = () => updateView({ view: 'library', status: 'action', type: 'all', q: '', page: 1, id: null }, { push: true });

  return (
    <div className={`app bg-${preferences.previewBackground}`}>
      <AppHeader
        view={viewState.view}
        onNavigate={navigate}
        onImport={() => setImportOpen(true)}
        importDisabled={bootstrapState !== 'ready'}
        status={{
          bootstrapState, bootstrapError, socketConnected, captureStatus, sessionInfo,
          onRetry: retryConnection, onResetBudget: actions.handleResetSession
        }}
      />

      {viewState.view === 'health' ? (
        <main id="main-content" className="workspace" tabIndex={-1}>
          <HealthView
            storage={captureStatus.storage}
            outputPath={actions.outputPath}
            copyText={actions.copyText}
            refreshStatus={refreshStatus}
            onShowNeedsAction={showNeedsAction}
            handleArchiveLibrary={actions.handleArchiveLibrary}
            archiving={actions.archiving}
            bootstrapState={bootstrapState}
            libraryTotal={stickers.length}
          />
        </main>
      ) : (
        <div className={`workspace library-layout ${inspectorOpen ? 'has-inspector' : ''}`}>
          <main id="main-content" tabIndex={-1}>
            <LibraryView
              catalogue={catalogue}
              viewState={viewState}
              updateView={updateView}
              openSticker={openSticker}
              preferences={preferences}
              setPreference={setPreference}
              attention={attention}
              attentionSamples={attentionSamples}
              bootstrapState={bootstrapState}
              bootstrapError={bootstrapError}
              onRetry={retryConnection}
              onImport={() => setImportOpen(true)}
              searchRef={searchRef}
            />
          </main>
          {inspectorOpen && (
            <StickerInspector
              key={viewState.id}
              sticker={selectedSticker}
              loading={bootstrapState !== 'ready' || !stickers.length}
              onClose={handleCloseInspector}
              handleConvert={actions.handleConvert}
              openEditor={editor.openEditor}
              triggerBrowserDownload={actions.triggerBrowserDownload}
              handleSaveTags={actions.handleSaveTags}
              selectedStartTimes={selectedStartTimes}
              setSelectedStartTimes={setSelectedStartTimes}
              copyText={actions.copyText}
            />
          )}
        </div>
      )}

      <ImportPanel
        open={importOpen}
        onClose={() => setImportOpen(false)}
        {...importer}
        bootstrapState={bootstrapState}
        onShowInLibrary={() => {
          setImportOpen(false);
          updateView({ view: 'library', q: '', type: 'all', status: 'all', sort: 'newest', page: 1, id: null }, { push: true });
        }}
      />

      <EditorModal {...editor} />

      {dragActive && !importOpen && (
        <div className="drop-overlay" aria-hidden="true">
          <p>Drop images or videos to import them locally</p>
        </div>
      )}

      <div className="toast-region">
        {toast && (
          <div className={`toast tone-${toast.tone === 'error' ? 'problem' : 'ok'}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
            {toast.tone === 'error'
              ? <CircleAlert size={18} aria-hidden="true" />
              : <CircleCheck size={18} aria-hidden="true" />}
            <span>{toast.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}
