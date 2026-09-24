import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  Layers, 
  CheckCircle, 
  AlertTriangle, 
  ArrowDownToLine, 
  RefreshCw, 
  Archive,
  ExternalLink,
  Info,
  Folder,
  Copy,
  Check,
  Clock,
  Edit3,
  Tag,
  Sliders,
  Type,
  RotateCw,
  Upload,
  FileImage
} from 'lucide-react';

const PAGE_SIZE = 48;

const apiFetch = (path, options = {}) => fetch(path, {
  ...options,
  credentials: 'same-origin'
});

const getWebSocketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};

const normalizeMediaPath = (path) => {
  if (!path) return '';
  if (path.startsWith('/')) return path;
  return `/${path.replace(/^\.?[\\/]+/, '').replaceAll('\\', '/')}`;
};

const getOriginalPath = (sticker) => normalizeMediaPath(
  sticker.originalPath
  || sticker.capturedPath
  || `captured/${sticker.capturedDate || 'default'}/${sticker.originalFilename}`
);

const readFiniteNumber = (...values) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
};

const getStickerDuration = (sticker) => {
  if (!sticker?.isAnimated) return 0;

  const durationMs = readFiniteNumber(
    sticker.durationMs,
    sticker.metadata?.durationMs,
    sticker.animation?.durationMs
  );
  if (durationMs !== null) return durationMs / 1000;

  const durationSeconds = readFiniteNumber(
    sticker.durationSeconds,
    sticker.duration,
    sticker.metadata?.durationSeconds,
    sticker.animation?.durationSeconds
  );
  if (durationSeconds !== null) return durationSeconds;

  const frameDelays = sticker.frameDelays || sticker.metadata?.frameDelays;
  if (Array.isArray(frameDelays) && frameDelays.length) {
    return frameDelays.reduce((sum, delay) => sum + Math.max(0, Number(delay) || 0), 0) / 1000;
  }

  if (Array.isArray(sticker.delay) && sticker.delay.length) {
    return sticker.delay.reduce((sum, delay) => sum + Math.max(0, Number(delay) || 0), 0) / 1000;
  }

  const frameCount = readFiniteNumber(sticker.frames) || 0;
  const frameDelayMs = readFiniteNumber(sticker.delay, sticker.metadata?.delay);
  if (frameDelayMs !== null) return (frameCount * frameDelayMs) / 1000;

  const fps = readFiniteNumber(sticker.fps, sticker.metadata?.fps);
  return fps ? frameCount / fps : frameCount / 25;
};

const getPersistedRange = (sticker) => {
  const source = sticker.selectedRange || sticker.renderedRange || sticker.conversion?.range || {};
  const start = readFiniteNumber(
    source.start,
    source.startTime,
    sticker.selectedStartTime,
    sticker.startTime,
    sticker.conversion?.startTime
  ) || 0;
  const explicitEnd = readFiniteNumber(source.end, source.endTime, sticker.selectedEndTime);
  const duration = readFiniteNumber(source.duration, sticker.selectedDuration, sticker.conversion?.duration) || 3;
  return { start, end: explicitEnd ?? start + duration };
};

export default function App() {
  const [stickers, setStickers] = useState([]);
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'static' | 'animated'
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // The dashboard authenticates with the local server before opening WebSocket.
  const [bootstrapState, setBootstrapState] = useState('loading');
  const [bootstrapError, setBootstrapError] = useState('');
  const [captureStatus, setCaptureStatus] = useState({
    captureMode: 'offline',
    devtools: { state: 'closed', listening: false, lastAcceptedAt: null, lastError: null },
    storage: null
  });
  const [sessionInfo, setSessionInfo] = useState(null);
  const [outputPaths, setOutputPaths] = useState({});
  const [socketConnected, setSocketConnected] = useState(false);
  const [folderCopySuccess, setFolderCopySuccess] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const [manualImporting, setManualImporting] = useState(false);
  const [manualAutoConvert, setManualAutoConvert] = useState(true);
  const [manualDragOver, setManualDragOver] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const fileInputRef = useRef(null);
  
  // Tags editing state dictionary (stickerId -> string)
  const [editingTags, setEditingTags] = useState({});

  // ----------------------------------------------------
  // Canvas Editor Modal States
  // ----------------------------------------------------
  const [editingSticker, setEditingSticker] = useState(null);
  const [editorScale, setEditorScale] = useState(1.0);
  const [editorRotation, setEditorRotation] = useState(0);
  const [editorTopText, setEditorTopText] = useState('');
  const [editorBottomText, setEditorBottomText] = useState('');
  const [editorStrokeActive, setEditorStrokeActive] = useState(false);
  const [editorStrokeWidth, setEditorStrokeWidth] = useState(6);
  const [editorStrokeColor, setEditorStrokeColor] = useState('#ffffff');
  const [editorActiveFrame, setEditorActiveFrame] = useState(0);
  const [editorSaving, setEditorSaving] = useState(false);
  
  // Custom slider state dictionary mapping sticker.id -> selectedStartTime (seconds)
  const [selectedStartTimes, setSelectedStartTimes] = useState({});
  
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(false);
  const canvasRef = useRef(null);
  const modalRef = useRef(null);
  const modalCloseRef = useRef(null);
  const editorTriggerRef = useRef(null);
  const toastTimerRef = useRef(null);

  const showToast = (message) => {
    setToastMessage(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 4000);
  };

  useEffect(() => {
    mountedRef.current = true;

    const applyStatus = (payload) => {
      if (!payload) return;
      const status = payload.status || payload;
      setCaptureStatus((previous) => ({
        ...previous,
        ...status,
        devtools: { ...previous.devtools, ...(status.devtools || {}) }
      }));
      if (status.session) setSessionInfo(status.session);
      if (status.outputPaths) setOutputPaths((previous) => ({ ...previous, ...status.outputPaths }));
      if (status.storage?.paths) setOutputPaths((previous) => ({ ...previous, ...status.storage.paths }));
    };

    const scheduleReconnect = () => {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) bootstrap();
      }, 3000);
    };

    const connectWebSocket = () => {
      if (!mountedRef.current) return;
      const socket = new WebSocket(getWebSocketUrl());
      wsRef.current = socket;

      socket.onopen = () => setSocketConnected(true);
      socket.onmessage = (event) => {
        try {
          const { type, data } = JSON.parse(event.data);
          if (type === 'init') {
            applyStatus(data);
            setStickers(data?.stickers || []);
          } else if (type === 'status' || type === 'capture_status') {
            applyStatus(data);
          } else if (type === 'new_sticker') {
            setStickers((previous) => previous.some((item) => item.id === data.id)
              ? previous
              : [data, ...previous]);
            if (data.captureSource === 'devtools') {
              setCaptureStatus((previous) => ({
                ...previous,
                devtools: {
                  ...previous.devtools,
                  state: 'last_asset_accepted',
                  listening: null,
                  lastAcceptedAt: data.capturedAt || new Date().toISOString(),
                  lastError: null
                }
              }));
            }
          } else if (type === 'sticker_update') {
            setStickers((previous) => previous.map((item) => item.id === data.id
              ? { ...item, ...data }
              : item));
          }
        } catch (error) {
          console.error('[WebSocket] Invalid message:', error);
        }
      };
      socket.onerror = () => setSocketConnected(false);
      socket.onclose = () => {
        setSocketConnected(false);
        if (mountedRef.current) scheduleReconnect();
      };
    };

    const bootstrap = async () => {
      try {
        setBootstrapState('loading');
        setBootstrapError('');
        const response = await apiFetch('/api/session');
        const result = await response.json();
        if (!response.ok || !result.authenticated) {
          throw new Error(result.error || 'Local session authentication failed');
        }

        if (!mountedRef.current) return;
        applyStatus(result.status || result);
        setOutputPaths(result.outputPaths || result.status?.outputPaths || {});
        setBootstrapState('ready');

        if (wsRef.current) {
          wsRef.current.onclose = null;
          wsRef.current.close();
        }
        connectWebSocket();
      } catch (error) {
        if (!mountedRef.current) return;
        setBootstrapState('error');
        setBootstrapError(error.message);
        setSocketConnected(false);
        scheduleReconnect();
      }
    };

    bootstrap();
    return () => {
      mountedRef.current = false;
      window.clearTimeout(reconnectTimerRef.current);
      window.clearTimeout(toastTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  // ----------------------------------------------------
  // Canvas Rendering Pipeline (HTML5 Compositor)
  // ----------------------------------------------------
  useEffect(() => {
    if (!editingSticker) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const img = new Image();
    img.crossOrigin = 'anonymous';

    // Source depending on static WebP vs scrubbing animated frame
    if (editingSticker.isAnimated) {
      img.src = `/api/stickers/${editingSticker.id}/frame/${editorActiveFrame}`;
    } else {
      img.src = getOriginalPath(editingSticker);
    }

    img.onload = () => {
      // 1. Reset canvas
      ctx.clearRect(0, 0, 512, 512);
      ctx.save();
      
      // 2. Perform transformations
      ctx.translate(256, 256);
      ctx.rotate((editorRotation * Math.PI) / 180);
      ctx.scale(editorScale, editorScale);

      // Fit sticker perfectly inside 512x512 with a boundary cushion for outlines & texts
      const w = editingSticker.width;
      const h = editingSticker.height;
      let targetW, targetH;
      if (w >= h) {
        targetW = 380;
        targetH = Math.round((h * 380) / w);
      } else {
        targetH = 380;
        targetW = Math.round((w * 380) / h);
      }

      const drawX = -targetW / 2;
      const drawY = -targetH / 2;

      // 3. Draw outline border using offscreen double-buffering
      if (editorStrokeActive && editorStrokeWidth > 0) {
        const offscreen = document.createElement('canvas');
        offscreen.width = 512;
        offscreen.height = 512;
        const oCtx = offscreen.getContext('2d');

        // Draw transformed frame onto offscreen buffer
        oCtx.save();
        oCtx.translate(256, 256);
        oCtx.rotate((editorRotation * Math.PI) / 180);
        oCtx.scale(editorScale, editorScale);
        oCtx.drawImage(img, drawX, drawY, targetW, targetH);
        oCtx.restore();

        // source-in composite color tinting
        oCtx.globalCompositeOperation = 'source-in';
        oCtx.fillStyle = editorStrokeColor;
        oCtx.fillRect(0, 0, 512, 512);

        // Stamp shifted silhouttes radially on main canvas
        const step = 0.25;
        for (let angle = 0; angle < Math.PI * 2; angle += step) {
          const dx = Math.cos(angle) * editorStrokeWidth;
          const dy = Math.sin(angle) * editorStrokeWidth;
          ctx.drawImage(offscreen, dx, dy);
        }
      }

      // 4. Paint primary transparent sticker exactly centered on top of borders
      ctx.drawImage(img, drawX, drawY, targetW, targetH);
      ctx.restore();

      // 5. Draw meme texts (Impact font, black border outline)
      ctx.font = 'bold 36px Impact, Arial Black, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 5;
      ctx.textAlign = 'center';

      if (editorTopText) {
        ctx.strokeText(editorTopText.toUpperCase(), 256, 60);
        ctx.fillText(editorTopText.toUpperCase(), 256, 60);
      }

      if (editorBottomText) {
        ctx.strokeText(editorBottomText.toUpperCase(), 256, 460);
        ctx.fillText(editorBottomText.toUpperCase(), 256, 460);
      }
    };

    img.onerror = () => {
      ctx.clearRect(0, 0, 512, 512);
      ctx.fillStyle = 'var(--text-muted)';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Failed to load frame preview buffer', 256, 256);
    };
  }, [
    editingSticker,
    editorScale,
    editorRotation,
    editorTopText,
    editorBottomText,
    editorStrokeActive,
    editorStrokeWidth,
    editorStrokeColor,
    editorActiveFrame
  ]);

  useEffect(() => {
    if (!editingSticker) return undefined;

    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => modalCloseRef.current?.focus());

    const handleModalKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setEditingSticker(null);
        return;
      }

      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.hasAttribute('hidden'));
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleModalKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleModalKeyDown);
      document.body.style.overflow = previousOverflow;
      const focusTarget = editorTriggerRef.current || previouslyFocused;
      window.setTimeout(() => focusTarget?.focus(), 0);
    };
  }, [editingSticker]);

  const openEditor = (sticker, trigger) => {
    editorTriggerRef.current = trigger;
    setEditorScale(1.0);
    setEditorRotation(0);
    setEditorTopText('');
    setEditorBottomText('');
    setEditorStrokeActive(false);
    setEditorStrokeWidth(6);
    setEditorStrokeColor('#ffffff');
    setEditorActiveFrame(0);
    setEditingSticker(sticker);
  };

  // Trigger Conversion API
  const handleConvert = async (id) => {
    try {
      setStickers(prev => 
        prev.map(s => s.id === id ? { ...s, status: 'converting' } : s)
      );

      const currentSticker = stickers.find((sticker) => sticker.id === id);
      const startTime = selectedStartTimes[id] ?? getPersistedRange(currentSticker || {}).start;

      const response = await apiFetch(`/api/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, startTime })
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Conversion failed');
      }

      setStickers(prev => 
        prev.map(s => s.id === id ? { ...s, ...result.sticker } : s)
      );

      const folderName = result.sticker.isAnimated ? 'animated' : 'statics';
      const dateFolder = result.sticker.capturedDate || getTodayFolder();
      showToast(`✨ Sticker successfully converted & saved to output/${folderName}/${dateFolder}/`);

    } catch (err) {
      console.error('Sticker conversion error:', err);
      setStickers(prev => 
        prev.map(s => s.id === id ? { ...s, status: 'failed' } : s)
      );
      showToast(`❌ Sticker conversion failed: ${err.message}`);
    }
  };

  // Compile Customized Canvas Edits
  const handleSaveEdit = async () => {
    if (!editingSticker) return;
    setEditorSaving(true);

    try {
      if (editingSticker.isAnimated) {
        // Post transforms model to backend for frame-by-frame renders
        const startTime = selectedStartTimes[editingSticker.id] ?? getPersistedRange(editingSticker).start;
        const response = await apiFetch(`/api/edit-convert-animated`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingSticker.id,
            startTime,
            transforms: {
              scale: editorScale,
              rotation: editorRotation,
              strokeActive: editorStrokeActive,
              strokeWidth: editorStrokeWidth,
              strokeColor: editorStrokeColor,
              topText: editorTopText,
              bottomText: editorBottomText,
              textColor: '#ffffff',
              textSize: 36
            }
          })
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Animated edit compile failed.');

        setStickers(prev => prev.map(s => s.id === editingSticker.id ? { ...s, ...result.sticker } : s));
        showToast(`✨ Customized Animated Sticker compiled successfully! Saved to output/animated/`);
      } else {
        // Upload base64 PNG data for high-speed static WebP conversion
        const canvas = canvasRef.current;
        const dataUrl = canvas.toDataURL('image/png');

        const response = await apiFetch(`/api/edit-convert-static`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingSticker.id,
            pngBase64: dataUrl
          })
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Static edit compile failed.');

        setStickers(prev => prev.map(s => s.id === editingSticker.id ? { ...s, ...result.sticker } : s));
        showToast(`✨ Customized Static Sticker saved successfully! Saved to output/statics/`);
      }

      setEditingSticker(null);
    } catch (err) {
      showToast(`❌ Editing failed: ${err.message}`);
    } finally {
      setEditorSaving(false);
    }
  };

  // Persist manual tags to backend
  const handleSaveTags = async (id) => {
    const tagString = editingTags[id] || '';
    const tagsArray = tagString.split(',').map(t => t.trim()).filter(Boolean);

    try {
      const response = await apiFetch(`/api/stickers/${id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: tagsArray })
      });
      const result = await response.json();
      if (response.ok) {
        setStickers(prev => prev.map(s => s.id === id ? { ...s, ...result.sticker } : s));
        showToast('🏷️ Tags updated successfully!');
        setEditingTags(prev => {
          const copy = { ...prev };
          delete copy[id];
          return copy;
        });
      }
    } catch {
      showToast('❌ Failed to save tags.');
    }
  };

  const triggerBrowserDownload = (sticker) => {
    if (!sticker.convertedPath) return;
    const downloadUrl = normalizeMediaPath(sticker.convertedPath);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = sticker.convertedFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Archiving creates a recoverable snapshot; the active library remains untouched.
  const handleArchiveLibrary = async () => {
    const confirmed = window.confirm(
      'Create an archive snapshot of the current library? The server will copy the database and media to a dated archive. The active library will stay unchanged.'
    );
    if (!confirmed) return;

    setArchiving(true);
    try {
      const response = await apiFetch('/api/library/archive', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Archive failed');

      if (result.status) {
        setCaptureStatus((previous) => ({
          ...previous,
          ...result.status,
          devtools: { ...previous.devtools, ...(result.status.devtools || {}) }
        }));
        if (result.status.session) setSessionInfo(result.status.session);
      }
      const archivePath = result.archive?.path;
      showToast(archivePath ? `Archive snapshot created: ${archivePath}` : 'Archive snapshot created. The active library is unchanged.');
    } catch (error) {
      showToast(`Archive failed: ${error.message}`);
    } finally {
      setArchiving(false);
    }
  };

  /** Manual local import — zero TikTok traffic */
  const handleManualFiles = async (fileList) => {
    if (bootstrapState !== 'ready') {
      showToast('Wait for the local authenticated session before importing files.');
      return;
    }

    const files = Array.from(fileList || []);
    if (!files.length) return;

    const allowed = /\.(png|jpe?g|webp|gif|tif{1,2}|avif|mp4|webm|mov|mkv|m4v)$/i;
    const valid = files.filter((f) => allowed.test(f.name));
    if (!valid.length) {
      showToast('Unsupported files. Use png, jpg, webp, gif, mp4, webm, mov…');
      return;
    }

    setManualImporting(true);
    try {
      const form = new FormData();
      valid.forEach((f) => form.append('files', f));

      const response = await apiFetch(`/api/import/files`, {
        method: 'POST',
        body: form
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Import failed');
      }

      const newOnes = (result.results || [])
        .filter((r) => r.success && r.sticker)
        .map((r) => r.sticker);

      if (newOnes.length) {
        setStickers((prev) => {
          const ids = new Set(prev.map((s) => s.id));
          const merged = [...newOnes.filter((s) => !ids.has(s.id)), ...prev];
          return merged;
        });
      }

      showToast(
        `Import: ${result.imported} new, ${result.duplicates || 0} dup, ${result.failed || 0} failed`
      );

      if (manualAutoConvert && newOnes.length) {
        for (const s of newOnes) {
          if (s.status === 'captured' && !result.results?.find((r) => r.sticker?.id === s.id && r.duplicate)) {
            // only convert truly new non-duplicate imports
            const wasDup = (result.results || []).find((r) => r.sticker?.id === s.id)?.duplicate;
            if (!wasDup) {
              await handleConvert(s.id);
            }
          }
        }
      }
    } catch (err) {
      console.error('Manual import error:', err);
      showToast(`Import failed: ${err.message}`);
    } finally {
      setManualImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleResetSession = async () => {
    try {
      const response = await apiFetch('/api/session/reset', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Reset failed');
      setSessionInfo(result.session);
      showToast('DevTools capture budget reset.');
    } catch (error) {
      showToast(`Session reset failed: ${error.message}`);
    }
  };

  const getTodayFolder = () => {
    return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
  };

  const getOutputPath = (key) => {
    const aliases = {
      root: ['root', 'output', 'outputRoot', 'rootPath'],
      captured: ['captured', 'capturedPath'],
      statics: ['statics', 'static', 'staticsPath', 'staticPath'],
      animated: ['animated', 'animatedPath']
    };
    const sources = [outputPaths, captureStatus.storage?.paths, captureStatus.storage];
    for (const source of sources) {
      for (const alias of aliases[key] || [key]) {
        if (typeof source?.[alias] === 'string' && source[alias]) return source[alias];
      }
    }
    return key === 'root' ? 'output/' : `output/${key}/`;
  };

  const copyFolderPath = async () => {
    try {
      await navigator.clipboard.writeText(getOutputPath('root'));
      setFolderCopySuccess(true);
      window.setTimeout(() => setFolderCopySuccess(false), 2000);
    } catch {
      showToast('Could not copy the storage path.');
    }
  };


  // Filter stickers by tab AND fuzzy search query.
  const filteredStickers = stickers.filter((sticker) => {
    let matchesTab = true;
    if (activeTab === 'static') matchesTab = !sticker.isAnimated;
    if (activeTab === 'animated') matchesTab = sticker.isAnimated;

    let matchesSearch = true;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const idMatch = String(sticker.id || '').toLowerCase().includes(query);
      const filenameMatch = String(sticker.originalFilename || '').toLowerCase().includes(query);
      const tagMatch = sticker.tags?.some((tag) => String(tag).toLowerCase().includes(query));
      matchesSearch = idMatch || filenameMatch || Boolean(tagMatch);
    }

    return matchesTab && matchesSearch;
  });

  const visibleStickers = filteredStickers.slice(0, visibleCount);
  const totalCount = stickers.length;
  const staticCount = stickers.filter((sticker) => !sticker.isAnimated).length;
  const animatedCount = stickers.filter((sticker) => sticker.isAnimated).length;

  const stickersByDate = visibleStickers.reduce((groups, sticker) => {
    const date = sticker.capturedDate || getTodayFolder();
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(sticker);
    return groups;
  }, {});

  const sortedDates = Object.keys(stickersByDate).sort((a, b) => b.localeCompare(a));
  const devtoolsStatus = captureStatus.devtools || {};
  const devtoolsState = devtoolsStatus.state || 'disabled';
  const isDevtoolsMode = devtoolsStatus.enabled === true;
  const isDeliveryFailure = devtoolsState === 'local_delivery_failed' || Boolean(devtoolsStatus.lastError);
  const lastAcceptedAt = devtoolsStatus.lastAcceptedAt || devtoolsStatus.lastIngestAt;
  const storageIssueCount = ['missingOriginals', 'missingConverted', 'orphanFiles', 'tempEntries', 'staleConversions']
    .reduce((sum, key) => {
      const value = captureStatus.storage?.[key];
      return sum + (Array.isArray(value) ? value.length : Number(value) || 0);
    }, 0);
  const outputRootPath = getOutputPath('root');

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="title-container">
          <Sparkles size={36} className="gradient-text" />
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 800 }}>
              TikTok to <span className="gradient-text">Telegram</span>
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '2px', fontWeight: 500 }}>
              Offline-first Sticker Workspace & Telegram Converter
            </p>
          </div>
        </div>

        <div className="glass-panel system-state" role="status" aria-live="polite">
          <span className={`status-dot ${socketConnected ? 'green' : bootstrapState === 'error' ? 'red' : 'yellow'}`} aria-hidden="true" />
          <span style={{ color: 'var(--text-secondary)' }}>
            Local service:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {socketConnected ? 'Connected' : bootstrapState === 'error' ? 'Unavailable' : 'Connecting'}
            </strong>
          </span>
        </div>
      </header>

      {/* Capture Safety Banner */}
      <div
        className="status-banner glass-panel"
        role={bootstrapState === 'error' || (isDevtoolsMode && isDeliveryFailure) ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div className="status-info">
          {bootstrapState === 'loading' ? (
            <>
              <span className="status-dot yellow" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-yellow)' }}>Authenticating local dashboard…</div>
                <div className="status-details">The dashboard establishes a private same-origin session before any API or WebSocket traffic.</div>
              </div>
            </>
          ) : bootstrapState === 'error' ? (
            <>
              <span className="status-dot red" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-red)' }}>Local server unavailable</div>
                <div className="status-details">{bootstrapError || 'Session authentication failed.'} Retrying automatically.</div>
              </div>
            </>
          ) : isDevtoolsMode && sessionInfo?.exhausted ? (
            <>
              <span className="status-dot red" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-red)' }}>DevTools capture budget exhausted</div>
                <div className="status-details">Limit hit ({sessionInfo.exhaustReason || 'budget'}). Reset only after you intentionally begin a new capture session.</div>
              </div>
            </>
          ) : isDevtoolsMode && isDeliveryFailure ? (
            <>
              <span className="status-dot red" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-red)' }}>Local DevTools delivery failed</div>
                <div className="status-details">{devtoolsStatus.lastError || 'The extension could not deliver an already-loaded response body to localhost.'}</div>
              </div>
            </>
          ) : isDevtoolsMode && devtoolsState === 'last_asset_accepted' ? (
            <>
              <span className="status-dot green" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--accent-emerald)' }}>Last DevTools asset accepted</div>
                <div className="status-details">
                  {lastAcceptedAt ? `Accepted ${new Date(lastAcceptedAt).toLocaleString()}. ` : ''}
                  The server cannot determine whether the DevTools panel is still open.
                </div>
              </div>
            </>
          ) : isDevtoolsMode ? (
            <>
              <span className="status-dot yellow" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-yellow)' }}>Awaiting opt-in DevTools capture</div>
                <div className="status-details">Open DevTools before the sticker loads, select the Sticker Capture panel, and keep it open. No DOM automation or CDN refetch is used.</div>
              </div>
            </>
          ) : (
            <>
              <span className="status-dot green" aria-hidden="true" />
              <div>
                <div className="status-text" style={{ color: 'var(--accent-emerald)' }}>Offline mode · manual import</div>
                <div className="status-details">Local files are the default path and do not contact TikTok. Manual imports never make live capture appear ready.</div>
              </div>
            </>
          )}
        </div>

        <div className="status-actions">
          <div className="cmd-box">
            <span>{isDevtoolsMode ? 'DevTools → Sticker Capture → keep panel open' : 'Offline default → drop local media below'}</span>
          </div>
          <div className="status-action-row">
            {isDevtoolsMode && sessionInfo && (
              <button
                type="button"
                className="download-btn compact-btn"
                onClick={handleResetSession}
                disabled={bootstrapState !== 'ready'}
              >
                Reset capture budget
              </button>
            )}
            {isDevtoolsMode && (
              <a
                href="https://www.tiktok.com/messages"
                target="_blank"
                rel="noreferrer"
                className="download-btn compact-btn"
              >
                Open TikTok Chats <ExternalLink size={14} />
              </a>
            )}
          </div>
          <span className="status-footnote">
            {isDevtoolsMode
              ? 'Residual account and policy risk remains; live capture is never ban-safe.'
              : 'HAR response bodies are not guaranteed; use manual media import unless a local capability test succeeds.'}
            {sessionInfo && isDevtoolsMode
              ? ` Session ${sessionInfo.captureCount || 0}/${sessionInfo.maxCaptures || '—'}.`
              : ''}
            {storageIssueCount > 0 ? ` Storage health reports ${storageIssueCount} item(s) needing review.` : ''}
          </span>
        </div>
      </div>

      {/* Server-reported storage path; never assume a drive or project location. */}
      <div className="folder-indicator-bar">
        <div className="folder-path-container">
          <div className="folder-icon-wrapper">
            <Folder size={18} aria-hidden="true" />
          </div>
          <div className="folder-path-info">
            <div className="folder-path-label">Active storage root</div>
            <div className="folder-path-value" title={outputRootPath}>
              <span>{outputRootPath}</span>
            </div>
          </div>
        </div>
        <button type="button" className="folder-copy-btn" onClick={copyFolderPath}>
          {folderCopySuccess ? (
            <>
              <Check size={14} style={{ color: 'var(--accent-emerald)' }} aria-hidden="true" />
              <span style={{ color: 'var(--accent-emerald)' }}>Copied!</span>
            </>
          ) : (
            <>
              <Copy size={14} aria-hidden="true" />
              <span>Copy path</span>
            </>
          )}
        </button>
      </div>

      {/* Statistics Row */}
      <section className="stats-grid">
        <div className="stat-card glass-panel glass-panel-interactive">
          <div>
            <div className="stat-label">Total Grabbed</div>
            <div className="stat-value">{totalCount}</div>
          </div>
          <div className="stat-icon">
            <Layers size={24} />
          </div>
        </div>

        <div className="stat-card glass-panel glass-panel-interactive">
          <div>
            <div className="stat-label">Static Stickers</div>
            <div className="stat-value">{staticCount}</div>
          </div>
          <div className="stat-icon green">
            <CheckCircle size={24} />
          </div>
        </div>

        <div className="stat-card glass-panel glass-panel-interactive">
          <div>
            <div className="stat-label">Animated Stickers</div>
            <div className="stat-value">{animatedCount}</div>
          </div>
          <div className="stat-icon animated">
            <Sparkles size={24} />
          </div>
        </div>
      </section>

      {/* Main Section */}
      <main className="main-section">

        {/* Manual import — local files only, no TikTok */}
        <div
          className={`manual-import-zone glass-panel ${manualDragOver ? 'drag-over' : ''} ${manualImporting ? 'importing' : ''}`}
          role="region"
          aria-label="Manual local sticker import"
          aria-busy={manualImporting}
          onDragOver={(e) => {
            e.preventDefault();
            setManualDragOver(true);
          }}
          onDragLeave={() => setManualDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setManualDragOver(false);
            handleManualFiles(e.dataTransfer.files);
          }}
        >
          <div className="manual-import-icon">
            <Upload size={28} />
          </div>
          <div className="manual-import-copy">
            <h3>Manual sticker import</h3>
            <p>
              Drop <strong>png / jpg / webp / gif / mp4 / webm</strong> here — converts locally for Telegram.
              No TikTok connection. Safest path (zero account risk).
            </p>
            <label className="manual-auto-convert">
              <input
                type="checkbox"
                checked={manualAutoConvert}
                onChange={(e) => setManualAutoConvert(e.target.checked)}
              />
              Auto-convert to Telegram format after import
            </label>
          </div>
          <div className="manual-import-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.avif,.mp4,.webm,.mov,.mkv,.m4v,image/*,video/*"
              style={{ display: 'none' }}
              onChange={(e) => handleManualFiles(e.target.files)}
            />
            <button
              type="button"
              className="download-btn"
              disabled={manualImporting || bootstrapState !== 'ready'}
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: '10px 18px', fontSize: '0.85rem' }}
            >
              <FileImage size={16} />
              {manualImporting ? 'Importing…' : 'Choose files'}
            </button>
          </div>
        </div>
        
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

        {/* Output instructions helper card */}
        {stickers.some(s => s.status === 'converted') && (
          <div className="glass-panel instructions-panel">
            <Info size={22} style={{ color: 'var(--accent-cyan)', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <h4>Stickers Export & Upload Guide</h4>
              <p style={{ marginTop: '4px' }}>
                Converted files are saved to the directories reported by the local server:
                <br />
                • Animated WebM: <code style={{ color: 'var(--accent-fuchsia)' }}>{getOutputPath('animated')}</code>
                <br />
                • Static WebP: <code style={{ color: 'var(--accent-emerald)' }}>{getOutputPath('statics')}</code>
                <br />
                Upload them manually through the official Telegram <a href="https://t.me/stickers" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-purple)', fontWeight: 700, textDecoration: 'none' }}>@Stickers</a> bot. This application never publishes to Telegram automatically.
              </p>
            </div>
          </div>
        )}
      </main>

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
