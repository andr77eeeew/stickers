import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleAlert } from 'lucide-react';
import { useStickerSession } from './hooks/useStickerSession';
import { useStickerActions } from './hooks/useStickerActions';
import { useManualImport } from './hooks/useManualImport';
import { useViewState } from './hooks/useViewState';
import { usePreferences } from './hooks/usePreferences';
import { AppHeader } from './components/AppHeader';
import { LibraryView } from './components/LibraryView';
import { StickerInspector } from './components/StickerInspector';
import { ImportPanel } from './components/ImportPanel';
import { HealthView } from './components/HealthView';
import { EditorView } from './components/EditorView';
import { JobCenter } from './components/JobCenter';
import { SelectionBar } from './components/SelectionBar';
import { BatchTagsDialog } from './components/BatchTagsDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import {
  PAGE_SIZE, PAGE_SIZE_DENSE, getStickerState, isOriginalMissing, needsAction, selectCatalogue, summarizeAttention
} from './lib/stickerModel';
import { describeFinishedJob, getQueuedStickerIds } from './lib/jobModel';

// One-click batch conversions above this size ask for confirmation first.
const LARGE_BATCH_CONFIRM = 10;

const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

export default function App() {
  const session = useStickerSession();
  const {
    stickers, setStickers, bootstrapState, bootstrapError, captureStatus, setCaptureStatus,
    sessionInfo, setSessionInfo, outputPaths, socketConnected, retryConnection,
    jobs, setJobs, jobHistory
  } = session;
  const { viewState, updateView, openSticker, closeSticker } = useViewState();
  const { preferences, setPreference } = usePreferences();
  const [toast, setToast] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [pendingConvertIds, setPendingConvertIds] = useState(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const lastToggledRef = useRef(null);
  const jobStatesRef = useRef(new Map());
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

  const actions = useStickerActions({
    stickers, setStickers, selectedStartTimes, showToast,
    captureStatus, setCaptureStatus, setSessionInfo, outputPaths, setJobs
  });
  const importer = useManualImport({ bootstrapState, setStickers, showToast, startConvertJob: actions.startConvertJob });
  const { handleManualFiles } = importer;

  const pageSize = preferences.density === 'dense' ? PAGE_SIZE_DENSE : PAGE_SIZE;
  const catalogue = useMemo(
    () => selectCatalogue(stickers, { ...viewState, pageSize }),
    [stickers, viewState, pageSize]
  );
  const attention = useMemo(() => summarizeAttention(stickers), [stickers]);
  const attentionSamples = useMemo(() => stickers.filter(needsAction).slice(0, 5), [stickers]);
  const stickersById = useMemo(() => new Map(stickers.map((sticker) => [sticker.id, sticker])), [stickers]);
  const queuedIds = useMemo(() => getQueuedStickerIds(jobs), [jobs]);
  // Only stickers the server can convert now: original present, not already busy.
  const isConvertible = useCallback((sticker) => Boolean(sticker)
    && !isOriginalMissing(sticker)
    && getStickerState(sticker) !== 'converting'
    && !queuedIds.has(sticker.id), [queuedIds]);
  const attentionConvertibleIds = useMemo(
    () => stickers.filter((sticker) => needsAction(sticker) && isConvertible(sticker)).map((sticker) => sticker.id),
    [stickers, isConvertible]
  );
  const selectedConvertibleIds = useMemo(
    () => [...selectedIds].filter((id) => isConvertible(stickersById.get(id))),
    [selectedIds, stickersById, isConvertible]
  );
  const pageIds = catalogue.items.map((sticker) => sticker.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  // Announce each batch conversion once, when the server reports it finished.
  useEffect(() => {
    const previous = jobStatesRef.current;
    for (const job of jobs) {
      const before = previous.get(job.id);
      if (before === 'running' && job.state !== 'running' && job.kind === 'convert') {
        const { message, tone } = describeFinishedJob(job);
        showToast(message, tone);
      }
      previous.set(job.id, job.state);
    }
  }, [jobs, showToast]);

  const toggleSelectionMode = () => {
    setSelectionMode((value) => !value);
    setSelectedIds(new Set());
    lastToggledRef.current = null;
  };

  // Shift+click selects the range on the current page since the last toggle.
  const toggleSelected = (id, withRange) => {
    // Read the anchor now: React may run the updater after the ref changes below.
    const anchor = lastToggledRef.current;
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (withRange && anchor && pageIds.includes(anchor) && pageIds.includes(id)) {
        const [from, to] = [pageIds.indexOf(anchor), pageIds.indexOf(id)].sort((a, b) => a - b);
        pageIds.slice(from, to + 1).forEach((pageId) => next.add(pageId));
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    lastToggledRef.current = id;
  };

  const togglePageSelection = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      pageIds.forEach((id) => (allPageSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  // Escape leaves selection mode unless a dialog or the inspector handles it first.
  useEffect(() => {
    if (!selectionMode) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open], .inspector')) return;
      setSelectionMode(false);
      setSelectedIds(new Set());
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectionMode]);

  const convertSelected = async () => {
    const job = await actions.startConvertJob(selectedConvertibleIds);
    if (job) {
      setSelectedIds(new Set());
      setSelectionMode(false);
    }
  };

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
      if (document.querySelector('dialog[open]') || viewState.view === 'editor') return;
      event.preventDefault();
      // Focus synchronously when the field exists so the next keystroke lands in it.
      if (viewState.view === 'library' && searchRef.current) {
        searchRef.current.focus();
        return;
      }
      updateView({ view: 'library' }, { push: true });
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

  // The editor is a pushed history entry, so leaving it steps back to the
  // library exactly as it was (filters, page and open inspector).
  const openEditorView = (id) => updateView({ view: 'editor', id }, { push: true, marker: 'editor' });
  const exitEditor = useCallback(() => {
    if (window.history.state === 'editor') window.history.back();
    else updateView({ view: 'library' });
  }, [updateView]);
  const stickerIds = useMemo(() => new Set(stickers.map((sticker) => sticker.id)), [stickers]);

  const navigate = (view) => updateView({ view, id: null }, { push: true });
  const showNeedsAction = () => updateView({ view: 'library', status: 'action', type: 'all', q: '', page: 1, id: null }, { push: true });

  return (
    <div className={`app bg-${preferences.previewBackground}`}>
      <AppHeader
        view={viewState.view}
        onNavigate={navigate}
        onImport={() => setImportOpen(true)}
        importDisabled={bootstrapState !== 'ready'}
        jobs={jobs}
        onOpenJobs={() => setJobsOpen(true)}
        status={{
          bootstrapState, bootstrapError, socketConnected, captureStatus, sessionInfo,
          onRetry: retryConnection, onResetBudget: actions.handleResetSession
        }}
      />

      {viewState.view === 'editor' ? (
        <main id="main-content" className="workspace" tabIndex={-1}>
          <EditorView
            sticker={selectedSticker}
            loading={bootstrapState !== 'ready' || !stickers.length}
            onExit={exitEditor}
            setStickers={setStickers}
            selectedStartTimes={selectedStartTimes}
            setSelectedStartTimes={setSelectedStartTimes}
            showToast={showToast}
          />
        </main>
      ) : viewState.view === 'health' ? (
        <main id="main-content" className="workspace" tabIndex={-1}>
          <HealthView
            storage={captureStatus.storage}
            setCaptureStatus={setCaptureStatus}
            outputPath={actions.outputPath}
            copyText={actions.copyText}
            stickerIds={stickerIds}
            onOpenSticker={(id) => updateView({ view: 'library', id }, { push: true })}
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
              selectionMode={selectionMode}
              onToggleSelectionMode={toggleSelectionMode}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              queuedIds={queuedIds}
              attentionConvertible={attentionConvertibleIds.length}
              onConvertAttention={() => (attentionConvertibleIds.length > LARGE_BATCH_CONFIRM
                ? setPendingConvertIds(attentionConvertibleIds)
                : actions.startConvertJob(attentionConvertibleIds))}
            />
            {selectionMode && (
              <SelectionBar
                count={selectedIds.size}
                convertibleCount={selectedConvertibleIds.length}
                pageCount={pageIds.length}
                allPageSelected={allPageSelected}
                onTogglePage={togglePageSelection}
                onConvert={convertSelected}
                onTags={() => setTagsOpen(true)}
                onClear={() => setSelectedIds(new Set())}
                onDone={toggleSelectionMode}
              />
            )}
          </main>
          {inspectorOpen && (
            <StickerInspector
              key={viewState.id}
              sticker={selectedSticker}
              loading={bootstrapState !== 'ready' || !stickers.length}
              onClose={handleCloseInspector}
              handleConvert={actions.handleConvert}
              openEditor={(sticker) => openEditorView(sticker.id)}
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
        jobs={jobs}
        onOpenJobs={() => { setImportOpen(false); setJobsOpen(true); }}
        onShowInLibrary={() => {
          setImportOpen(false);
          updateView({ view: 'library', q: '', type: 'all', status: 'all', sort: 'newest', page: 1, id: null }, { push: true });
        }}
      />

      <JobCenter
        open={jobsOpen}
        onClose={() => setJobsOpen(false)}
        jobs={jobs}
        jobHistory={jobHistory}
        stickersById={stickersById}
        onOpenSticker={(id) => updateView({ view: 'library', id }, { push: true })}
        onCancel={actions.cancelJob}
      />

      <ConfirmDialog
        open={Boolean(pendingConvertIds)}
        title={`Convert ${pendingConvertIds?.length || 0} stickers?`}
        confirmLabel={`Convert ${pendingConvertIds?.length || 0}`}
        onCancel={() => setPendingConvertIds(null)}
        onConfirm={() => {
          const ids = pendingConvertIds;
          setPendingConvertIds(null);
          actions.startConvertJob(ids);
        }}
      >
        <p>Every sticker that needs action and still has its original will be queued as one job and converted two at a time. Existing outputs of these stickers are replaced. You can cancel queued items in Jobs.</p>
      </ConfirmDialog>

      <BatchTagsDialog
        open={tagsOpen}
        onClose={() => setTagsOpen(false)}
        count={selectedIds.size}
        onSubmit={(add, remove) => actions.startTagJob([...selectedIds], add, remove)}
      />


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
