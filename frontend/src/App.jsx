import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  Chrome, 
  Layers, 
  CheckCircle, 
  AlertTriangle, 
  ArrowDownToLine, 
  RefreshCw, 
  Trash2, 
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
  RotateCw
} from 'lucide-react';

const BACKEND_PORT = 3001;
const API_URL = `http://localhost:${BACKEND_PORT}`;
const WS_URL = `ws://localhost:${BACKEND_PORT}`;
const TARGET_FPS = 25; // Standard sticker FPS

export default function App() {
  const [stickers, setStickers] = useState([]);
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'static' | 'animated'
  const [searchQuery, setSearchQuery] = useState('');
  
  // Connection states
  const [chromeConnected, setChromeConnected] = useState(false);
  const [tiktokTabFound, setTiktokTabFound] = useState(false);
  const [cdpConnecting, setCdpConnecting] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [folderCopySuccess, setFolderCopySuccess] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  
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
  const canvasRef = useRef(null);

  const showToast = (message) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Connect to WebSocket Server
  const connectWebSocket = () => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    console.log(`[WebSocket] Connecting to ${WS_URL}...`);
    const socket = new WebSocket(WS_URL);
    wsRef.current = socket;

    socket.onopen = () => {
      console.log('[WebSocket] Connection established.');
      setSocketConnected(true);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        const { type, data } = message;

        switch (type) {
          case 'init':
            setChromeConnected(data.chromeConnected);
            setTiktokTabFound(data.tiktokTabFound);
            setCdpConnecting(data.cdpConnecting);
            setStickers(data.stickers);
            break;
            
          case 'status':
            setChromeConnected(data.chromeConnected);
            setTiktokTabFound(data.tiktokTabFound);
            setCdpConnecting(data.cdpConnecting);
            break;

          case 'new_sticker':
            setStickers(prev => {
              if (prev.some(s => s.id === data.id)) return prev;
              return [data, ...prev];
            });
            break;

          case 'sticker_update':
            setStickers(prev => 
              prev.map(s => s.id === data.id ? { ...s, ...data } : s)
            );
            break;

          default:
            break;
        }
      } catch (err) {
        console.error('[WebSocket] Message parsing error:', err);
      }
    };

    socket.onclose = () => {
      console.log('[WebSocket] Connection lost. Reconnecting in 3s...');
      setSocketConnected(false);
      setChromeConnected(false);
      setTiktokTabFound(false);
      setTimeout(connectWebSocket, 3000);
    };
  };

  useEffect(() => {
    connectWebSocket();
    return () => {
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
      img.src = `${API_URL}/api/stickers/${editingSticker.id}/frame/${editorActiveFrame}`;
    } else {
      img.src = `${API_URL}/captured/${editingSticker.capturedDate || 'default'}/${editingSticker.originalFilename}`;
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

  // Trigger Conversion API
  const handleConvert = async (id) => {
    try {
      setStickers(prev => 
        prev.map(s => s.id === id ? { ...s, status: 'converting' } : s)
      );

      const startTime = selectedStartTimes[id] || 0;

      const response = await fetch(`${API_URL}/api/convert`, {
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
        const startTime = selectedStartTimes[editingSticker.id] || 0;
        const response = await fetch(`${API_URL}/api/edit-convert-animated`, {
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

        const response = await fetch(`${API_URL}/api/edit-convert-static`, {
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
      const response = await fetch(`${API_URL}/api/stickers/${id}/tags`, {
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
    } catch (e) {
      showToast('❌ Failed to save tags.');
    }
  };

  const triggerBrowserDownload = (sticker) => {
    if (!sticker.convertedPath) return;
    const downloadUrl = `${API_URL}${sticker.convertedPath}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = sticker.convertedFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Clear Database API
  const handleClearAll = async () => {
    if (!window.confirm('Are you sure you want to clear all captured stickers? This will delete files on the server.')) {
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/stickers/clear`, {
        method: 'POST'
      });
      if (response.ok) {
        setStickers([]);
      }
    } catch (err) {
      console.error('Failed to clear stickers:', err);
    }
  };

  const copyCommand = () => {
    const cmd = `start chrome.exe --remote-debugging-port=9222 "https://www.tiktok.com/messages"`;
    navigator.clipboard.writeText(cmd);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  const getTodayFolder = () => {
    return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
  };

  const copyFolderPath = () => {
    const folderPath = `D:\\Projects\\stickers\\output\\${getTodayFolder()}`;
    navigator.clipboard.writeText(folderPath);
    setFolderCopySuccess(true);
    setTimeout(() => setFolderCopySuccess(false), 2000);
  };

  const getStickerDuration = (sticker) => {
    if (!sticker.isAnimated) return 0;
    return Math.round((sticker.frames / TARGET_FPS) * 10) / 10;
  };

  // Filter stickers by tab AND fuzzy search query
  const filteredStickers = stickers.filter(sticker => {
    let matchesTab = true;
    if (activeTab === 'static') matchesTab = !sticker.isAnimated;
    if (activeTab === 'animated') matchesTab = sticker.isAnimated;

    let matchesSearch = true;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const idMatch = sticker.id.toLowerCase().includes(q);
      const filenameMatch = sticker.originalFilename.toLowerCase().includes(q);
      const tagMatch = sticker.tags && sticker.tags.some(tag => tag.toLowerCase().includes(q));
      matchesSearch = idMatch || filenameMatch || tagMatch;
    }

    return matchesTab && matchesSearch;
  });

  const totalCount = stickers.length;
  const staticCount = stickers.filter(s => !s.isAnimated).length;
  const animatedCount = stickers.filter(s => s.isAnimated).length;

  const stickersByDate = filteredStickers.reduce((groups, sticker) => {
    const date = sticker.capturedDate || getTodayFolder();
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(sticker);
    return groups;
  }, {});

  const sortedDates = Object.keys(stickersByDate).sort((a, b) => b.localeCompare(a));

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
              Cyber Grabber & Premium Canvas Creator Suite
            </p>
          </div>
        </div>

        <div className="glass-panel" style={{ padding: '10px 20px', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.8rem', borderRadius: '14px' }}>
          <span className={`status-dot ${socketConnected ? 'green' : 'red'}`} />
          <span style={{ color: 'var(--text-secondary)' }}>
            System state: <strong style={{ color: 'var(--text-primary)' }}>{socketConnected ? 'Connected' : 'Disconnected'}</strong>
          </span>
        </div>
      </header>

      {/* Connection State Banner */}
      <div className="status-banner glass-panel">
        <div className="status-info">
          {chromeConnected && tiktokTabFound ? (
            <>
              <span className="status-dot green" />
              <div>
                <div className="status-text" style={{ color: 'var(--accent-emerald)' }}>Active & Monitoring</div>
                <div className="status-details">
                  Chrome debugger detected. Intercepting TikTok sticker DOM mutations in real time.
                </div>
              </div>
            </>
          ) : chromeConnected && !tiktokTabFound ? (
            <>
              <span className="status-dot yellow" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-yellow)' }}>Chrome Attached, Awaiting TikTok</div>
                <div className="status-details">
                  Chrome debugger active on port 9222, but no active TikTok chat page was detected.
                </div>
              </div>
            </>
          ) : (
            <>
              <span className="status-dot red" />
              <div>
                <div className="status-text" style={{ color: 'var(--status-red)' }}>Chrome Debugger Offline</div>
                <div className="status-details">
                  Close all Chrome windows and restart Chrome in debugging mode on port 9222.
                </div>
              </div>
            </>
          )}
        </div>

        {!chromeConnected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end', maxWidth: '500px' }}>
            <div className="cmd-box">
              <span>start chrome.exe --remote-debugging-port=9222 "https://www.tiktok.com/messages"</span>
              <button className="copy-btn" onClick={copyCommand}>
                {copySuccess ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Or double-click <code style={{ color: 'var(--accent-fuchsia)' }}>start-chrome.bat</code> in the project root!
            </span>
          </div>
        )}

        {chromeConnected && !tiktokTabFound && (
          <a 
            href="https://www.tiktok.com/messages" 
            target="_blank" 
            rel="noreferrer"
            className="download-btn"
            style={{ padding: '10px 20px', textDecoration: 'none', fontSize: '0.82rem', boxShadow: 'none' }}
          >
            Open TikTok Chats <ExternalLink size={14} />
          </a>
        )}
      </div>

      {/* Visual Folder Path Indicator (Active Save Folder) */}
      <div className="folder-indicator-bar">
        <div className="folder-path-container">
          <div className="folder-icon-wrapper">
            <Folder size={18} />
          </div>
          <div className="folder-path-info">
            <div className="folder-path-label">Active Save Directory</div>
            <div className="folder-path-value">
              <span>D:\Projects\stickers\output\</span>
              <span className="highlight-date">{getTodayFolder()}</span>
            </div>
          </div>
        </div>
        <button className="folder-copy-btn" onClick={copyFolderPath}>
          {folderCopySuccess ? (
            <>
              <Check size={14} style={{ color: 'var(--accent-emerald)' }} />
              <span style={{ color: 'var(--accent-emerald)' }}>Copied!</span>
            </>
          ) : (
            <>
              <Copy size={14} />
              <span>Copy Path</span>
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
        
        {/* Glow Search Filter Container */}
        <div className="search-container">
          <input 
            type="text" 
            placeholder="🔍 Search stickers by ID, filenames, or manual tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>

        {/* Filters and Actions */}
        <div className="filter-bar">
          <div className="tabs">
            <button 
              className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              All Intercepted
            </button>
            <button 
              className={`tab-btn ${activeTab === 'static' ? 'active' : ''}`}
              onClick={() => setActiveTab('static')}
            >
              Static ({staticCount})
            </button>
            <button 
              className={`tab-btn ${activeTab === 'animated' ? 'active' : ''}`}
              onClick={() => setActiveTab('animated')}
            >
              Animated ({animatedCount})
            </button>
          </div>

          {stickers.length > 0 && (
            <button className="clear-btn" onClick={handleClearAll}>
              <Trash2 size={16} /> Clear Session
            </button>
          )}
        </div>

        {/* Empty State */}
        {filteredStickers.length === 0 ? (
          <div className="glass-panel empty-state">
            <Layers className="empty-icon" size={56} />
            <h3 className="empty-title">No Stickers Intercepted Yet</h3>
            <p className="empty-subtitle">
              {chromeConnected && tiktokTabFound ? (
                "The grabber engine is ready. Navigate through TikTok chats or scroll stickers on the chat drawer to intercept them automatically in real-time!"
              ) : (
                "Start Chrome with debugging and launch TikTok messages. Loaded stickers will instantly stream into this cyber grid."
              )}
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
                    const selectedStart = selectedStartTimes[sticker.id] || 0;
                    const selectedEnd = Math.min(stickerDuration, selectedStart + 3.0);
                    
                    const isTagEditing = editingTags[sticker.id] !== undefined;

                    return (
                      <div key={sticker.id} className={`glass-panel glass-panel-interactive sticker-card status-${sticker.status}`}>
                        {/* Sticker Preview Container */}
                        <div className="sticker-preview-container">
                          <img 
                            src={`${API_URL}/captured/${sticker.capturedDate || 'default'}/${sticker.originalFilename}`} 
                            alt="Captured sticker" 
                            className="sticker-img"
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
                              <span>ID: sticker_{sticker.id.substring(0, 8)}</span>
                              <span>{sticker.width}x{sticker.height} px</span>
                            </div>
                            
                            {sticker.isAnimated && (
                              <div className="sticker-meta" style={{ marginTop: '4px', color: 'var(--text-secondary)' }}>
                                <span>Frames: {sticker.frames}</span>
                                <span>Duration: {stickerDuration.toFixed(1)}s</span>
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

                            {/* Interactive Time Range Slider for Animated Stickers longer than 3 seconds */}
                            {isLongDuration && sticker.status === 'captured' && (
                              <div className="time-slider-container">
                                <div className="time-slider-header">
                                  <span className="time-slider-title">
                                    <Clock size={12} style={{ color: 'var(--accent-fuchsia)' }} /> 3-Sec Slice Selector
                                  </span>
                                  <span className="time-slider-value">
                                    {selectedStart.toFixed(1)}s - {selectedEnd.toFixed(1)}s
                                  </span>
                                </div>
                                <div className="time-slider-wrapper">
                                  <input 
                                    type="range"
                                    min={0}
                                    max={stickerDuration - 3.0}
                                    step={0.1}
                                    value={selectedStart}
                                    onChange={(e) => {
                                      const val = parseFloat(e.target.value);
                                      setSelectedStartTimes(prev => ({
                                        ...prev,
                                        [sticker.id]: val
                                      }));
                                    }}
                                    className="custom-range-slider"
                                    title="Drag to select the 3-second chunk of animation to extract"
                                  />
                                </div>
                              </div>
                            )}

                            {/* Show active extraction chunk description after conversion */}
                            {isLongDuration && sticker.status === 'converted' && (
                              <div className="time-slider-container" style={{ background: 'rgba(16, 185, 129, 0.05)', borderColor: 'rgba(16, 185, 129, 0.15)' }}>
                                <div className="time-slider-header">
                                  <span className="time-slider-title" style={{ color: 'var(--accent-emerald)' }}>
                                    <CheckCircle size={12} /> Rendered Slice:
                                  </span>
                                  <span className="time-slider-value" style={{ color: 'var(--accent-emerald)', background: 'rgba(16, 185, 129, 0.12)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
                                    {selectedStart.toFixed(1)}s - {selectedEnd.toFixed(1)}s
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
                                onClick={() => {
                                  // Open Canvas Editor Modal
                                  setEditorScale(1.0);
                                  setEditorRotation(0);
                                  setEditorTopText('');
                                  setEditorBottomText('');
                                  setEditorStrokeActive(false);
                                  setEditorStrokeWidth(6);
                                  setEditorStrokeColor('#ffffff');
                                  setEditorActiveFrame(0);
                                  setEditingSticker(sticker);
                                }}
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
          </div>
        )}

        {/* Output instructions helper card */}
        {stickers.some(s => s.status === 'converted') && (
          <div className="glass-panel instructions-panel">
            <Info size={22} style={{ color: 'var(--accent-cyan)', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <h4>Stickers Export & Upload Guide</h4>
              <p style={{ marginTop: '4px' }}>
                All parsed stickers are automatically saved to your premium workspace output directories:
                <br />
                • Animated WEBMs: <code style={{ color: 'var(--accent-fuchsia)' }}>D:\Projects\stickers\output\animated</code>
                <br />
                • Static WebPs: <code style={{ color: 'var(--accent-emerald)' }}>D:\Projects\stickers\output\statics</code>
                <br />
                Simply open the official Telegram <a href="https://t.me/stickers" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-purple)', fontWeight: 700, textDecoration: 'none' }}>@Stickers</a> bot, send the <code style={{ color: 'var(--accent-cyan)' }}>/newpack</code> or <code style={{ color: 'var(--accent-cyan)' }}>/newvideo</code> command, and drag-and-drop these files straight from the save folders!
              </p>
            </div>
          </div>
        )}
      </main>

      {/* ----------------------------------------------------
          Creative HTML5 Canvas Editor Modal overlay
          ---------------------------------------------------- */}
      {editingSticker && (
        <div className="editor-modal-backdrop">
          <div className="editor-modal-container glass-panel">
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
                  <h3 style={{ fontSize: '1.2rem', background: 'var(--gradient-cyber)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                    Sticker Customizer
                  </h3>
                  <button 
                    onClick={() => setEditingSticker(null)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.2rem' }}
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
                    onChange={(e) => setEditorRotation(parseInt(e.target.value))}
                    className="custom-range-slider"
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
                        onChange={(e) => setEditorStrokeWidth(parseInt(e.target.value))}
                        className="custom-range-slider"
                      />
                    </div>

                    <div className="editor-control-group">
                      <label className="editor-control-label">Stroke Border Color</label>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <input 
                          type="color"
                          value={editorStrokeColor}
                          onChange={(e) => setEditorStrokeColor(e.target.value)}
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
                  />
                </div>

                {/* Saving / Apply Buttons */}
                <div style={{ display: 'flex', gap: '12px', marginTop: 'auto', paddingTop: '20px' }}>
                  <button 
                    onClick={() => setEditingSticker(null)}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', color: 'white', cursor: 'pointer', fontWeight: 600 }}
                  >
                    Cancel
                  </button>
                  <button 
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
        <div className="toast glass-panel">
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
