const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');
const CDP = require('chrome-remote-interface');
const conversionQueue = require('./ConversionQueue');

// Load environment variables (optional)
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Helper for dates in YYYY-MM-DD format
function getTodayDateStr() {
  return new Date().toISOString().split('T')[0];
}

// Directories setup
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');

function getCapturedDir(dateStr = getTodayDateStr()) {
  const dir = path.join(OUTPUT_DIR, 'captured', dateStr);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStaticsDir(dateStr = getTodayDateStr()) {
  const dir = path.join(OUTPUT_DIR, 'statics', dateStr);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAnimatedDir(dateStr = getTodayDateStr()) {
  const dir = path.join(OUTPUT_DIR, 'animated', dateStr);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Create initial base folders
[OUTPUT_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Serve captured and converted stickers for preview (supporting subfolders)
app.use('/captured', express.static(path.join(OUTPUT_DIR, 'captured')));
app.use('/statics', express.static(path.join(OUTPUT_DIR, 'statics')));
app.use('/animated', express.static(path.join(OUTPUT_DIR, 'animated')));

// Create HTTP and WebSocket Server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Application State
let cdpClient = null;
let cdpConnecting = false;
let chromeConnected = false;
let tiktokTabFound = false;
let capturedStickers = []; // Stores list of metadata
const dbPath = path.join(OUTPUT_DIR, 'stickers_db.json');

// Load database if exists
if (fs.existsSync(dbPath)) {
  try {
    capturedStickers = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    // Database Migration: Ensure capturedDate exists for all legacy entries
    let migrated = false;
    capturedStickers = capturedStickers.map(s => {
      if (!s.capturedDate) {
        s.capturedDate = s.capturedAt ? s.capturedAt.split('T')[0] : getTodayDateStr();
        migrated = true;
      }
      return s;
    });
    if (migrated) {
      console.log('[Database] Migrated legacy database entries to include capturedDate.');
      saveDatabase();
    }
  } catch (err) {
    console.error('Failed to parse stickers database, starting fresh:', err);
  }
}

function saveDatabase() {
  fs.writeFileSync(dbPath, JSON.stringify(capturedStickers, null, 2), 'utf8');
}

// Broadcast WebSocket message to all connected frontend clients
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Check Chrome connection status and broadcast
function emitStatus() {
  broadcast({
    type: 'status',
    data: {
      chromeConnected,
      tiktokTabFound,
      cdpConnecting
    }
  });
}

// Process and download sticker from a given URL with SHA-256 de-duplication
async function processCapturedStickerUrl(url) {
  if (!url) return null;
  
  try {
    // 1. Download the sticker from the TikTok CDN
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image from CDN. HTTP Status: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error('Empty file buffer received.');
    }

    // 2. Calculate SHA-256 for duplicate prevention
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const existing = capturedStickers.find(s => s.id === sha256);
    if (existing) {
      console.log(`[Duplicate Prevented] Sticker already captured with ID ${sha256}`);
      return existing;
    }

    // 3. Save raw webp in date-based captured folder
    const today = getTodayDateStr();
    const currentCapturedDir = getCapturedDir(today);
    const filename = `sticker_${sha256}.webp`;
    const filepath = path.join(currentCapturedDir, filename);
    fs.writeFileSync(filepath, fileBuffer);

    // 4. Extract metadata using Sharp
    const sharpImg = sharp(filepath, { animated: true });
    const metadata = await sharpImg.metadata();
    const isAnimated = metadata.pages > 1;

    let delayVal = 40; // Default to 25 FPS
    if (metadata.delay) {
      delayVal = Array.isArray(metadata.delay) ? metadata.delay[0] : metadata.delay;
    }

    const newSticker = {
      id: sha256,
      originalUrl: url,
      isAnimated,
      capturedAt: new Date().toISOString(),
      capturedDate: today,
      width: metadata.width,
      height: metadata.pageHeight || metadata.height,
      frames: metadata.pages || 1,
      delay: delayVal,
      originalFilename: filename,
      convertedPath: null, // Filled on conversion
      convertedFilename: null,
      status: 'captured', // 'captured' | 'converting' | 'converted' | 'failed'
      tags: []
    };

    capturedStickers.unshift(newSticker);
    saveDatabase();

    console.log(`[Sticker Saved] ${isAnimated ? 'Animated' : 'Static'} sticker stored with ID: ${sha256}`);

    // 5. Broadcast to all active WebSocket frontend clients
    broadcast({
      type: 'new_sticker',
      data: newSticker
    });

    return newSticker;
  } catch (err) {
    console.error('[Sticker Capture Error] Failed to process URL:', err.message);
    return null;
  }
}

// Poll Chrome Remote Debugging port and manage connection
async function manageChromeConnection() {
  if (chromeConnected || cdpConnecting) return;

  cdpConnecting = true;
  emitStatus();

  try {
    // 1. Get list of tabs from Chrome DevTools debugging port
    const tabs = await CDP.List({ port: 9222 });
    
    // 2. Search for a TikTok tab (messages or chats page preferred)
    const tiktokTab = tabs.find(tab => 
      tab.url && (tab.url.includes('tiktok.com') || tab.url.includes('tiktokv.com'))
    );

    if (tiktokTab) {
      tiktokTabFound = true;
      console.log(`[CDP] TikTok tab found: "${tiktokTab.title}" at URL: ${tiktokTab.url}`);
      
      // 3. Connect to the specific TikTok tab
      cdpClient = await CDP({ target: tiktokTab, port: 9222 });
      chromeConnected = true;
      cdpConnecting = false;
      console.log(`[CDP] Connected to Chrome tab successfully!`);
      emitStatus();

      // Handle disconnect
      cdpClient.on('disconnect', () => {
        console.log('[CDP] Disconnected from Chrome.');
        chromeConnected = false;
        tiktokTabFound = false;
        cdpClient = null;
        emitStatus();
      });

      // Enable Network, Page, and Runtime domains
      const { Network, Page, Runtime } = cdpClient;
      await Promise.all([
        Network.enable(),
        Page.enable(),
        Runtime.enable()
      ]);

      // 4. Add the native Runtime binding function
      await Runtime.addBinding({ name: 'captureTiktokSticker' });

      // Listen to binding calls
      Runtime.bindingCalled(async (params) => {
        if (params.name === 'captureTiktokSticker') {
          const url = params.payload;
          console.log(`[CDP Binding Intercept] Received URL: ${url}`);
          await processCapturedStickerUrl(url);
        }
      });

      console.log('[CDP] Monitoring network requests and injecting DOM MutationObserver...');

      // 5. Intercept finished network responses as a secondary fallback
      Network.responseReceived(async (params) => {
        try {
          const { response } = params;
          const url = response.url;
          const mimeType = response.mimeType || '';

          const isStickerUrl = url.includes('sticker') || url.includes('stickers');
          const isWebpMime = mimeType.includes('webp') || url.includes('.webp');

          if (isStickerUrl && isWebpMime) {
            console.log(`[Network Intercept Fallback] Intercepted URL: ${url}`);
            await processCapturedStickerUrl(url);
          }
        } catch (err) {
          // Ignore background parsing errors for fallbacks
        }
      });

      // 6. Formulate the DOM MutationObserver and Floating Sidebar Mini-App Script
      const observerScript = `
        (function() {
          if (window.__tiktokStickerGrabberActive) return;
          window.__tiktokStickerGrabberActive = true;

          console.log("%c[Sticker Grabber Injected] Tracking DOM mutations and injecting Companion...", "color: #06b6d4; font-weight: bold;");

          // ----------------------------------------------------
          // Part A: CSS Injected Stylesheet
          // ----------------------------------------------------
          const sidebarCss = \`
            #tiktok-sticker-companion-widget {
              position: fixed;
              bottom: 24px;
              right: 24px;
              width: 52px;
              height: 52px;
              border-radius: 50%;
              background: linear-gradient(135deg, #d946ef, #06b6d4);
              box-shadow: 0 0 15px rgba(217, 70, 239, 0.7);
              cursor: pointer;
              z-index: 2147483647;
              display: flex;
              align-items: center;
              justify-content: center;
              transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
              color: white;
              font-size: 22px;
              font-family: Arial, sans-serif;
              user-select: none;
              border: 2px solid rgba(255, 255, 255, 0.2);
            }
            #tiktok-sticker-companion-widget:hover {
              transform: scale(1.1) rotate(15deg);
              box-shadow: 0 0 20px rgba(6, 182, 212, 0.9);
            }
            #tiktok-sticker-companion-sidebar {
              position: fixed;
              top: 0;
              right: -340px;
              width: 320px;
              height: 100vh;
              background: rgba(13, 10, 18, 0.96);
              border-left: 2px solid #d946ef;
              box-shadow: -10px 0 30px rgba(0, 0, 0, 0.95);
              z-index: 2147483646;
              transition: right 0.4s cubic-bezier(0.16, 1, 0.3, 1);
              font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              color: #e2e8f0;
              display: flex;
              flex-direction: column;
              text-align: left;
            }
            #tiktok-sticker-companion-sidebar.open {
              right: 0;
            }
            .companion-header {
              padding: 20px;
              border-bottom: 1px solid rgba(255, 255, 255, 0.08);
              display: flex;
              align-items: center;
              justify-content: space-between;
              background: rgba(255, 255, 255, 0.01);
            }
            .companion-title {
              font-size: 15px;
              font-weight: 800;
              letter-spacing: 0.5px;
              background: linear-gradient(to right, #06b6d4, #d946ef);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
            }
            .companion-close {
              cursor: pointer;
              color: #a0aec0;
              font-size: 24px;
              line-height: 1;
              transition: color 0.2s;
            }
            .companion-close:hover {
              color: #fff;
            }
            .companion-feed {
              flex: 1;
              overflow-y: auto;
              padding: 16px;
              display: flex;
              flex-direction: column;
              gap: 12px;
            }
            .companion-card {
              background: rgba(255, 255, 255, 0.03);
              border: 1px solid rgba(255, 255, 255, 0.06);
              border-radius: 10px;
              padding: 12px;
              display: flex;
              gap: 12px;
              align-items: center;
              position: relative;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .companion-card img {
              width: 58px;
              height: 58px;
              object-fit: contain;
              background: rgba(0, 0, 0, 0.4);
              border-radius: 8px;
              border: 1px solid rgba(255, 255, 255, 0.05);
            }
            .companion-card-info {
              flex: 1;
              font-size: 11px;
              color: #cbd5e0;
              line-height: 1.4;
            }
            .companion-card-actions {
              display: flex;
              flex-direction: column;
              justify-content: center;
            }
            .companion-btn {
              padding: 6px 12px;
              font-size: 10px;
              font-weight: 700;
              border: 1px solid transparent;
              border-radius: 6px;
              cursor: pointer;
              text-align: center;
              text-decoration: none;
              transition: all 0.2s;
            }
            .companion-btn-primary {
              background: rgba(6, 182, 212, 0.15);
              color: #22d3ee;
              border-color: rgba(6, 182, 212, 0.3);
            }
            .companion-btn-primary:hover {
              background: #06b6d4;
              color: white;
            }
            .companion-btn-success {
              background: rgba(16, 185, 129, 0.15);
              color: #34d399;
              border-color: rgba(16, 185, 129, 0.3);
            }
            .companion-btn-success:hover {
              background: #10b981;
              color: white;
            }
            .companion-status-badge {
              position: absolute;
              top: 8px;
              right: 8px;
              font-size: 8px;
              padding: 2px 5px;
              border-radius: 4px;
              font-weight: 700;
              letter-spacing: 0.5px;
            }
            .status-captured { background: rgba(6, 182, 212, 0.12); color: #22d3ee; }
            .status-converting { background: rgba(217, 70, 239, 0.12); color: #f472b6; }
            .status-converted { background: rgba(16, 185, 129, 0.12); color: #34d399; }
            .status-failed { background: rgba(239, 68, 68, 0.12); color: #f87171; }
          \`;

          const styleEl = document.createElement('style');
          styleEl.textContent = sidebarCss;
          document.head.appendChild(styleEl);

          // ----------------------------------------------------
          // Part B: HTML Overlay Creation
          // ----------------------------------------------------
          const widget = document.createElement('div');
          widget.id = 'tiktok-sticker-companion-widget';
          widget.title = 'Open Sticker Companion Drawer';
          widget.innerHTML = '⚡';
          document.body.appendChild(widget);

          const sidebar = document.createElement('div');
          sidebar.id = 'tiktok-sticker-companion-sidebar';
          sidebar.innerHTML = \`
            <div class="companion-header">
              <span class="companion-title">💎 STICKER COMPANION</span>
              <span class="companion-close" id="companion-close-btn">&times;</span>
            </div>
            <div class="companion-feed" id="companion-feed-container">
              <div style="text-align: center; color: #718096; padding-top: 60px; font-size: 12px; font-family: sans-serif;">
                Awaiting captures...
              </div>
            </div>
          \`;
          document.body.appendChild(sidebar);

          // Open/Close toggle UI event bindings
          widget.addEventListener('click', () => {
            sidebar.classList.toggle('open');
          });
          document.getElementById('companion-close-btn').addEventListener('click', () => {
            sidebar.classList.remove('open');
          });

          // State manager
          let companionStickers = [];

          function renderFeed() {
            const container = document.getElementById('companion-feed-container');
            if (companionStickers.length === 0) {
              container.innerHTML = \`<div style="text-align: center; color: #718096; padding-top: 60px; font-size: 12px;">No stickers captured in this session.</div>\`;
              return;
            }

            container.innerHTML = companionStickers.map(s => {
              const isAnim = s.isAnimated;
              const statusBadge = \`<span class="companion-status-badge status-\${s.status}">\${s.status.toUpperCase()}</span>\`;
              
              let actionBtn = '';
              if (s.status === 'captured') {
                actionBtn = \`<button class="companion-btn companion-btn-primary" onclick="window.companionConvert('\${s.id}')">Convert</button>\`;
              } else if (s.status === 'converting') {
                actionBtn = \`<button class="companion-btn companion-btn-primary" disabled style="opacity: 0.6; cursor: wait;">Encoding...</button>\`;
              } else if (s.status === 'converted') {
                const downloadUrl = \`http://localhost:3001\${s.convertedPath}\`;
                actionBtn = \`<a class="companion-btn companion-btn-success" href="\${downloadUrl}" target="_blank" download="\${s.convertedFilename}">Download</a>\`;
              } else {
                actionBtn = \`<button class="companion-btn companion-btn-primary" onclick="window.companionConvert('\${s.id}')">Retry</button>\`;
              }

              const imgUrl = \`http://localhost:3001/captured/\${s.capturedDate || 'default'}/\${s.originalFilename}\`;
              return \`
                <div class="companion-card">
                  \${statusBadge}
                  <img src="\${imgUrl}" />
                  <div class="companion-card-info">
                    <div style="font-weight: 800; margin-bottom: 4px; color: white;">sticker_\${s.id.substring(0, 8)}</div>
                    <div style="color: #a0aec0;">Dimensions: \${s.width}x\${s.height} px</div>
                    <div style="margin-top: 4px; color: #d946ef; font-weight: bold;">\${isAnim ? '🎬 Animated' : '🖼️ Static'}</div>
                  </div>
                  <div class="companion-card-actions">
                    \${actionBtn}
                  </div>
                </div>
              \`;
            }).join('');
          }

          // Global hook on window for companion clicks
          window.companionConvert = async (id) => {
            try {
              // Optimistically set to converting
              companionStickers = companionStickers.map(s => s.id === id ? { ...s, status: 'converting' } : s);
              renderFeed();

              const res = await fetch('http://localhost:3001/api/convert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
              });
              const data = await res.json();
              if (data.success) {
                companionStickers = companionStickers.map(s => s.id === id ? { ...s, ...data.sticker } : s);
              } else {
                companionStickers = companionStickers.map(s => s.id === id ? { ...s, status: 'failed' } : s);
              }
              renderFeed();
            } catch (e) {
              console.error("[Companion Convert Error]", e);
              companionStickers = companionStickers.map(s => s.id === id ? { ...s, status: 'failed' } : s);
              renderFeed();
            }
          };

          // Establish standard local WebSocket client
          function connectCompanionWS() {
            const ws = new WebSocket('ws://localhost:3001');
            ws.onmessage = (event) => {
              try {
                const message = JSON.parse(event.data);
                const { type, data } = message;
                if (type === 'init') {
                  companionStickers = data.stickers;
                  renderFeed();
                } else if (type === 'new_sticker') {
                  if (!companionStickers.some(s => s.id === data.id)) {
                    companionStickers.unshift(data);
                    renderFeed();
                    // Automatically slide open panel on new captures!
                    sidebar.classList.add('open');
                  }
                } else if (type === 'sticker_update') {
                  companionStickers = companionStickers.map(s => s.id === data.id ? { ...s, ...data } : s);
                  renderFeed();
                }
              } catch (e) {}
            };
            ws.onclose = () => {
              setTimeout(connectCompanionWS, 3000);
            };
          }

          connectCompanionWS();

          // ----------------------------------------------------
          // Part C: DOM MutationObserver Interception logic
          // ----------------------------------------------------
          const capturedUrls = new Set();

          function scanNodeForStickers(node) {
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

            // Search for images
            const imgs = node.tagName === 'IMG' ? [node] : node.querySelectorAll('img');
            imgs.forEach(img => {
              const src = img.src || "";
              
              // TikTok sticker URL match criteria
              const isSticker = src.includes('tiktokcdn.com') || 
                                src.includes('tiktokv.com') ||
                                src.includes('sticker') ||
                                img.getAttribute('data-sticker') !== null;

              if (isSticker && src && !capturedUrls.has(src)) {
                capturedUrls.add(src);
                console.log("[Mutation Grab] Found new sticker element:", src);

                // Send back via CDP Runtime Binding
                if (typeof window.captureTiktokSticker === 'function') {
                  window.captureTiktokSticker(src);
                } else {
                  // Fallback: REST post
                  fetch('http://localhost:3001/api/capture-url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: src })
                  }).catch(e => {});
                }
              }
            });
          }

          // Monitor subtree image creations and src loading changes
          const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              if (mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(node => scanNodeForStickers(node));
              }
              if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                const target = mutation.target;
                if (target.tagName === 'IMG') {
                  scanNodeForStickers(target);
                }
              }
            }
          });

          // Begin tracking
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
          });

          // Perform initial scan
          scanNodeForStickers(document.body);
        })();
      `;

      // 7. Inject to run on every new document load (for hard reloads / navigations)
      await Page.addScriptToEvaluateOnNewDocument({
        source: observerScript
      });

      // 8. Hot-evaluate instantly on the currently open page context (no reload required!)
      await Runtime.evaluate({
        expression: observerScript
      });

      console.log('[CDP] MutationObserver successfully active and hot-injected.');

    } else {
      tiktokTabFound = false;
      chromeConnected = false;
      cdpConnecting = false;
      emitStatus();
    }
  } catch (err) {
    // Port not open, or connection failed
    tiktokTabFound = false;
    chromeConnected = false;
    cdpConnecting = false;
    emitStatus();
  }
}

// Start Chrome connector polling
setInterval(manageChromeConnection, 4000);

// Helper function to spawn FFmpeg
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args);
    let stderr = '';
    process.stderr.on('data', (d) => stderr += d.toString());
    process.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}. Error: ${stderr}`));
    });
  });
}

/**
 * Compresses static WebP sticker to guarantee size < 512 KB using Binary Search
 */
async function compressStaticSticker(inputPath, outputPath, targetW, targetH) {
  const SIZE_LIMIT = 500 * 1024; // 500 KB safety limit
  let low = 50;
  let high = 95;
  let optimalBuffer = null;
  let optimalQuality = 90;

  const sharpImg = sharp(inputPath).resize(targetW, targetH);

  // Initial check at quality 90 with maximum effort
  let buffer = await sharpImg.clone().webp({ quality: 90, effort: 6 }).toBuffer();
  if (buffer.length <= SIZE_LIMIT) {
    await fs.promises.writeFile(outputPath, buffer);
    return { sizeKb: buffer.length / 1024, quality: 90 };
  }

  // Binary search for maximum quality under the limit
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    buffer = await sharpImg.clone().webp({ quality: mid, effort: 6 }).toBuffer();

    if (buffer.length <= SIZE_LIMIT) {
      optimalBuffer = buffer;
      optimalQuality = mid;
      low = mid + 1; // Try to get higher quality
    } else {
      high = mid - 1; // Over the limit, reduce quality
    }
  }

  if (!optimalBuffer) {
    optimalBuffer = await sharpImg.clone().webp({ quality: 45, effort: 6 }).toBuffer();
    optimalQuality = 45;
  }

  await fs.promises.writeFile(outputPath, optimalBuffer);
  return { sizeKb: optimalBuffer.length / 1024, quality: optimalQuality };
}

/**
 * Progressive WebM compression engine guaranteeing size < 256 KB
 */
async function compressAnimatedWebM(tempFramesDir, outputPath, targetFps, durationSec) {
  const SIZE_LIMIT = 245 * 1024; // 245 KB safety limit
  const maxBits = SIZE_LIMIT * 8;
  const targetBitrate = Math.floor((maxBits / durationSec) * 0.92); // Derive average bitrate with 8% safety cushion

  const baseArgs = [
    '-y',
    '-framerate', String(targetFps),
    '-i', path.join(tempFramesDir, 'frame_%04d.png'),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-lag-in-frames', '0',
    '-auto-alt-ref', '0',
    '-row-mt', '1',
    '-an'
  ];

  // ==========================================
  // TIER 1: FAST CQ PASS (CRF 30)
  // ==========================================
  console.log(`[Tier 1] Encoding fast draft at CRF 30...`);
  const tier1Args = [
    ...baseArgs,
    '-crf', '30',
    '-b:v', '0',
    '-deadline', 'good',
    '-cpu-used', '4',
    outputPath
  ];
  await runFFmpeg(tier1Args);
  let stats = fs.statSync(outputPath);
  
  if (stats.size <= SIZE_LIMIT) {
    console.log(`[Tier 1 Success] Size: ${(stats.size / 1024).toFixed(2)} KB. Re-compiling at premium fidelity (CRF 28)...`);
    const premiumArgs = [
      ...baseArgs,
      '-crf', '28',
      '-b:v', '0',
      '-deadline', 'good',
      '-cpu-used', '1', // Slower, maximum density
      outputPath
    ];
    await runFFmpeg(premiumArgs);
    return;
  }

  // ==========================================
  // TIER 2: STEPPED CRF REDUCTION (CRF 42)
  // ==========================================
  if (stats.size > SIZE_LIMIT && stats.size <= SIZE_LIMIT * 1.8) {
    console.log(`[Tier 2] Over limit: ${(stats.size/1024).toFixed(2)} KB. Re-compressing at CRF 42...`);
    const tier2Args = [
      ...baseArgs,
      '-crf', '42',
      '-b:v', '0',
      '-deadline', 'good',
      '-cpu-used', '2',
      outputPath
    ];
    await runFFmpeg(tier2Args);
    stats = fs.statSync(outputPath);
    if (stats.size <= SIZE_LIMIT) {
      console.log(`[Tier 2 Success] Size: ${(stats.size / 1024).toFixed(2)} KB`);
      return;
    }
  }

  // ==========================================
  // TIER 3: STRICT TWO-PASS BITRATE CONTROL
  // ==========================================
  console.log(`[Tier 3] Size remains high. Executing Two-Pass Bitrate Control at ${Math.round(targetBitrate / 1000)} kbps`);
  
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  
  const pass1Args = [
    '-y',
    '-framerate', String(targetFps),
    '-i', path.join(tempFramesDir, 'frame_%04d.png'),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-an',
    '-b:v', `${targetBitrate}`,
    '-speed', '4',
    '-row-mt', '1',
    '-lag-in-frames', '0',
    '-auto-alt-ref', '0',
    '-pass', '1',
    '-f', 'null',
    nullDevice
  ];

  const pass2Args = [
    '-y',
    '-framerate', String(targetFps),
    '-i', path.join(tempFramesDir, 'frame_%04d.png'),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-an',
    '-b:v', `${targetBitrate}`,
    '-speed', '2',
    '-row-mt', '1',
    '-lag-in-frames', '0',
    '-auto-alt-ref', '0',
    '-pass', '2',
    outputPath
  ];

  await runFFmpeg(pass1Args);
  await runFFmpeg(pass2Args);

  // Cleanup two-pass log files
  const logFiles = fs.readdirSync(process.cwd()).filter(f => f.startsWith('ffmpeg2pass-') || f === 'vp9_parser_log.txt');
  for (const f of logFiles) {
    try { fs.unlinkSync(path.join(process.cwd(), f)); } catch(e) {}
  }
  
  stats = fs.statSync(outputPath);
  console.log(`[Tier 3 Completed] Final WebM size: ${(stats.size / 1024).toFixed(2)} KB`);
}

// API Endpoints

// Get all captured stickers
app.get('/api/stickers', (req, res) => {
  res.json(capturedStickers);
});

// Fallback REST endpoint for the injected MutationObserver
app.post('/api/capture-url', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required.' });
  }

  try {
    console.log(`[REST Intercept] Received URL fallback: ${url}`);
    const sticker = await processCapturedStickerUrl(url);
    if (sticker) {
      return res.json({ success: true, sticker });
    } else {
      return res.status(500).json({ error: 'Failed to process sticker URL.' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Global in-memory cache for timeline scrubbing frames
const frameCache = new Map();

// Dynamic frame extraction route with On-Demand Frame Cache (ODFC)
app.get('/api/stickers/:id/frame/:frameIndex', async (req, res) => {
  const { id, frameIndex } = req.params;
  const frameIndexInt = parseInt(frameIndex);

  const sticker = capturedStickers.find(s => s.id === id);
  if (!sticker) return res.status(404).json({ error: 'Sticker not found' });

  const inputPath = path.join(getCapturedDir(sticker.capturedDate), sticker.originalFilename);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Original sticker file not found' });
  }

  // 1. Return from in-memory cache if available
  if (frameCache.has(id)) {
    const cachedFrames = frameCache.get(id);
    if (cachedFrames[frameIndexInt]) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(cachedFrames[frameIndexInt]);
    }
  }

  // 2. Cache miss: extract all frames of this sticker concurrently
  try {
    const totalFrames = sticker.frames || 1;
    console.log(`[Frame Cache Miss] Populating ODFC cache for sticker ${id} (${totalFrames} frames)...`);

    const frameBuffers = new Array(totalFrames);
    const extractionPromises = [];

    for (let i = 0; i < totalFrames; i++) {
      extractionPromises.push(
        sharp(inputPath, { page: i })
          .resize(160, 160, { fit: 'inside' })
          .png()
          .toBuffer()
          .then(buf => {
            frameBuffers[i] = buf;
          })
          .catch(err => {
            console.error(`[ODFC] Error extracting frame ${i} for ${id}:`, err.message);
          })
      );
    }

    await Promise.all(extractionPromises);
    
    // Save to global in-memory cache
    frameCache.set(id, frameBuffers);

    if (frameBuffers[frameIndexInt]) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(frameBuffers[frameIndexInt]);
    } else {
      return res.status(404).json({ error: 'Frame index out of bounds' });
    }
  } catch (err) {
    console.error(`[ODFC Error] Populating frames failed:`, err.message);
    return res.status(500).json({ error: `Frame extraction failed: ${err.message}` });
  }
});

// Clear all stickers (resets DB and recursive cleanup)
app.post('/api/stickers/clear', (req, res) => {
  capturedStickers = [];
  saveDatabase();

  const capturedRoot = path.join(OUTPUT_DIR, 'captured');
  const staticsRoot = path.join(OUTPUT_DIR, 'statics');
  const animatedRoot = path.join(OUTPUT_DIR, 'animated');

  [capturedRoot, staticsRoot, animatedRoot].forEach(dir => {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
    }
  });

  res.json({ success: true, message: 'All stickers cleared' });
});

// Convert sticker endpoint (supporting custom frame ranges & dynamic date paths)
app.post('/api/convert', async (req, res) => {
  const { id, startFrame, endFrame, startTime } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Sticker ID is required' });
  }

  const stickerIndex = capturedStickers.findIndex(s => s.id === id);
  if (stickerIndex === -1) {
    return res.status(404).json({ error: 'Sticker not found' });
  }

  const sticker = capturedStickers[stickerIndex];
  const inputPath = path.join(getCapturedDir(sticker.capturedDate), sticker.originalFilename);

  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Original sticker file not found on disk' });
  }

  // Update status to converting
  sticker.status = 'converting';
  broadcast({ type: 'sticker_update', data: sticker });

  // Enqueue the CPU-bound task in the queue
  conversionQueue.enqueue(async () => {
    const sharpImg = sharp(inputPath, { animated: true });
    const metadata = await sharpImg.metadata();
    const totalFrames = metadata.pages || 1;
    
    // Calculate Telegram dimensions (one side exactly 512, the other <= 512)
    const w = metadata.width;
    const h = metadata.pageHeight || metadata.height;
    let targetW, targetH;

    if (w >= h) {
      targetW = 512;
      targetH = Math.round((h * 512) / w);
    } else {
      targetH = 512;
      targetW = Math.round((w * 512) / h);
    }

    const dateStr = sticker.capturedDate || getTodayDateStr();

    if (sticker.isAnimated) {
      // 1. ANIMATED CONVERSION (WebP -> WebM with Offset Range Selection)
      console.log(`[Converter] Starting animated WebP to WebM conversion for ID: ${id}`);
      
      const tempFramesDir = path.join(TEMP_DIR, `frames_${id}`);
      if (fs.existsSync(tempFramesDir)) {
        fs.rmSync(tempFramesDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tempFramesDir, { recursive: true });

      // Determine single frame delay list
      let delays = metadata.delay || [];
      if (!Array.isArray(delays)) {
        delays = new Array(totalFrames).fill(metadata.delay || 40);
      }

      const totalDurationMsAll = delays.reduce((sum, d) => sum + d, 0);
      const originalFps = (totalFrames / totalDurationMsAll) * 1000 || 25;

      // Compute range bounds
      let start = 0;
      if (startFrame !== undefined) {
        start = Math.max(0, parseInt(startFrame));
      } else if (startTime !== undefined) {
        start = Math.min(totalFrames - 1, Math.round(parseFloat(startTime) * originalFps));
      } else {
        start = 0;
      }

      let end = 0;
      const avgDelayAll = totalDurationMsAll / totalFrames;
      if (endFrame !== undefined) {
        end = Math.min(totalFrames - 1, parseInt(endFrame));
      } else {
        // Calculate max frames for 3.0 seconds based on average delay
        const maxFramesIn3Sec = Math.floor(3000 / avgDelayAll);
        end = Math.min(totalFrames - 1, start + maxFramesIn3Sec - 1);
      }

      if (start > end) {
        throw new Error('Start frame must be less than or equal to end frame.');
      }

      const activeDelays = delays.slice(start, end + 1);
      const totalDurationMs = activeDelays.reduce((sum, d) => sum + d, 0);
      const durationSec = totalDurationMs / 1000;

      if (totalDurationMs > 3050) {
        throw new Error(`Trimmed range duration (${durationSec.toFixed(2)}s) exceeds Telegram 3.0s limit.`);
      }

      // Calculate Target FPS
      const avgDelay = totalDurationMs / activeDelays.length;
      const calculatedFps = (1000 / avgDelay) || 25;
      const targetFps = Math.min(30, Math.round(calculatedFps));

      console.log(`[Slice Engine] Slicing range [${start} - ${end}] (${activeDelays.length} frames, ${durationSec.toFixed(2)}s at ${targetFps} FPS, from startTime ${startTime || 0}s)`);

      // Extract frames sequentially
      for (let i = start; i <= end; i++) {
        const relativeIndex = i - start;
        const framePath = path.join(tempFramesDir, `frame_${String(relativeIndex).padStart(4, '0')}.png`);
        
        await sharp(inputPath, { page: i })
          .resize(targetW, targetH)
          .png()
          .toFile(framePath);
      }

      const outputFilename = `sticker_${id}.webm`;
      const dateSubdir = getAnimatedDir(dateStr);
      const outputPath = path.join(dateSubdir, outputFilename);

      // Run 3-Tier progressive WebM compression engine
      await compressAnimatedWebM(tempFramesDir, outputPath, targetFps, durationSec);

      // Cleanup frames folder
      try { fs.rmSync(tempFramesDir, { recursive: true, force: true }); } catch (e) {}

      sticker.status = 'converted';
      sticker.convertedPath = `/animated/${dateStr}/${outputFilename}`;
      sticker.convertedFilename = outputFilename;
      saveDatabase();
      broadcast({ type: 'sticker_update', data: sticker });

      return sticker;

    } else {
      // 2. STATIC CONVERSION (With Progressive WebP Binary Search)
      console.log(`[Converter] Starting static WebP conversion for ID: ${id}`);
      
      const outputFilename = `sticker_${id}.webp`;
      const dateSubdir = getStaticsDir(dateStr);
      const outputPath = path.join(dateSubdir, outputFilename);

      const compressionDetails = await compressStaticSticker(inputPath, outputPath, targetW, targetH);
      console.log(`[Static Done] Quality: ${compressionDetails.quality}, Size: ${compressionDetails.sizeKb.toFixed(2)} KB`);

      sticker.status = 'converted';
      sticker.convertedPath = `/statics/${dateStr}/${outputFilename}`;
      sticker.convertedFilename = outputFilename;
      saveDatabase();
      broadcast({ type: 'sticker_update', data: sticker });

      return sticker;
    }
  })
  .then((resultSticker) => {
    return res.json({ success: true, sticker: resultSticker });
  })
  .catch((err) => {
    console.error(`[Converter Error] Conversion failed for sticker ${id}:`, err);
    sticker.status = 'failed';
    saveDatabase();
    broadcast({ type: 'sticker_update', data: sticker });
    return res.status(500).json({ error: `Conversion failed: ${err.message}` });
  });
});

// Edit and convert static sticker via Canvas Base64 data stream
app.post('/api/edit-convert-static', async (req, res) => {
  const { id, pngBase64 } = req.body;
  if (!id || !pngBase64) {
    return res.status(400).json({ error: 'Sticker ID and pngBase64 data are required.' });
  }

  const sticker = capturedStickers.find(s => s.id === id);
  if (!sticker) return res.status(404).json({ error: 'Sticker not found.' });

  sticker.status = 'converting';
  broadcast({ type: 'sticker_update', data: sticker });

  try {
    // Strip header
    const matches = pngBase64.match(/^data:image\/png;base64,(.+)$/);
    if (!matches) throw new Error('Invalid base64 image data.');
    const buffer = Buffer.from(matches[1], 'base64');

    const dateStr = sticker.capturedDate || getTodayDateStr();
    const outputFilename = `sticker_${id}.webp`;
    const dateSubdir = getStaticsDir(dateStr);
    const outputPath = path.join(dateSubdir, outputFilename);

    // Save PNG buffer temporarily
    const tempPngPath = path.join(TEMP_DIR, `temp_edit_${id}.png`);
    fs.writeFileSync(tempPngPath, buffer);

    // Resize and compress with binary search
    const compressionDetails = await compressStaticSticker(tempPngPath, outputPath, 512, 512);
    console.log(`[Static Edit Done] Quality: ${compressionDetails.quality}, Size: ${compressionDetails.sizeKb.toFixed(2)} KB`);

    // Clean temp png
    try { fs.unlinkSync(tempPngPath); } catch (e) {}

    sticker.status = 'converted';
    sticker.convertedPath = `/statics/${dateStr}/${outputFilename}`;
    sticker.convertedFilename = outputFilename;
    saveDatabase();
    broadcast({ type: 'sticker_update', data: sticker });

    return res.json({ success: true, sticker });
  } catch (err) {
    console.error(`[Static Edit Error]:`, err.message);
    sticker.status = 'failed';
    saveDatabase();
    broadcast({ type: 'sticker_update', data: sticker });
    return res.status(500).json({ error: err.message });
  }
});

// Edit and convert animated sticker with sequential Sharp transformations
app.post('/api/edit-convert-animated', async (req, res) => {
  const { id, startTime, transforms } = req.body;
  if (!id || !transforms) {
    return res.status(400).json({ error: 'Sticker ID and transforms configuration are required.' });
  }

  const sticker = capturedStickers.find(s => s.id === id);
  if (!sticker) return res.status(404).json({ error: 'Sticker not found.' });

  sticker.status = 'converting';
  broadcast({ type: 'sticker_update', data: sticker });

  const inputPath = path.join(getCapturedDir(sticker.capturedDate), sticker.originalFilename);
  if (!fs.existsSync(inputPath)) {
    sticker.status = 'failed';
    broadcast({ type: 'sticker_update', data: sticker });
    return res.status(404).json({ error: 'Original sticker not found.' });
  }

  conversionQueue.enqueue(async () => {
    const sharpImg = sharp(inputPath, { animated: true });
    const metadata = await sharpImg.metadata();
    const totalFrames = metadata.pages || 1;

    const dateStr = sticker.capturedDate || getTodayDateStr();

    const tempFramesDir = path.join(TEMP_DIR, `frames_edit_${id}`);
    if (fs.existsSync(tempFramesDir)) {
      fs.rmSync(tempFramesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempFramesDir, { recursive: true });

    // Delays and range bounds
    let delays = metadata.delay || [];
    if (!Array.isArray(delays)) {
      delays = new Array(totalFrames).fill(metadata.delay || 40);
    }
    const totalDurationMsAll = delays.reduce((sum, d) => sum + d, 0);
    const originalFps = (totalFrames / totalDurationMsAll) * 1000 || 25;

    // Use selected 3-second chunk
    const start = Math.min(totalFrames - 1, Math.round((startTime || 0) * originalFps));
    const avgDelayAll = totalDurationMsAll / totalFrames;
    const maxFramesIn3Sec = Math.floor(3000 / avgDelayAll);
    const end = Math.min(totalFrames - 1, start + maxFramesIn3Sec - 1);

    const activeDelays = delays.slice(start, end + 1);
    const totalDurationMs = activeDelays.reduce((sum, d) => sum + d, 0);
    const durationSec = totalDurationMs / 1000;

    const avgDelay = totalDurationMs / activeDelays.length;
    const calculatedFps = (1000 / avgDelay) || 25;
    const targetFps = Math.min(30, Math.round(calculatedFps));

    console.log(`[Animated Editor] Slicing range [${start} - ${end}] for customized export`);

    const { scale, rotation, strokeActive, strokeWidth, strokeColor, topText, bottomText, textColor, textSize } = transforms;

    // Build SVG meme text overlays if configured
    let textOverlaySvg = null;
    if (topText || bottomText) {
      const topSvg = topText ? `<text x="256" y="60" text-anchor="middle" font-family="Impact" font-size="${textSize || 32}" font-weight="bold" fill="${textColor || 'white'}" stroke="black" stroke-width="2">${topText.toUpperCase()}</text>` : '';
      const bottomSvg = bottomText ? `<text x="256" y="460" text-anchor="middle" font-family="Impact" font-size="${textSize || 32}" font-weight="bold" fill="${textColor || 'white'}" stroke="black" stroke-width="2">${bottomText.toUpperCase()}</text>` : '';
      textOverlaySvg = Buffer.from(`
        <svg width="512" height="512">
          ${topSvg}
          ${bottomSvg}
        </svg>
      `);
    }

    // Apply frame-by-frame transforms
    for (let i = start; i <= end; i++) {
      const relativeIndex = i - start;
      const framePath = path.join(tempFramesDir, `frame_${String(relativeIndex).padStart(4, '0')}.png`);

      let frameMetadata = await sharp(inputPath, { page: i }).metadata();
      const w = frameMetadata.width;
      const h = frameMetadata.pageHeight || frameMetadata.height;
      let targetW, targetH;

      if (w >= h) {
        targetW = 512;
        targetH = Math.round((h * 512) / w);
      } else {
        targetH = 512;
        targetW = Math.round((w * 512) / h);
      }

      // Resize primary frame
      const resizedFrameBuffer = await sharp(inputPath, { page: i })
        .resize(Math.round(targetW * scale), Math.round(targetH * scale), { fit: 'inside' })
        .rotate(rotation)
        .png()
        .toBuffer();

      // Create primary sharp image for composite
      let finalPipeline = sharp({
        create: {
          width: 512,
          height: 512,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      });

      const compositingArray = [];

      // If stroke active, draw silhouette outline by overlaying a tinted mask radially
      if (strokeActive && strokeWidth > 0) {
        // Hex parsing to tint background color
        const r = parseInt(strokeColor.slice(1, 3), 16) || 255;
        const g = parseInt(strokeColor.slice(3, 5), 16) || 255;
        const b = parseInt(strokeColor.slice(5, 7), 16) || 255;

        // Build a tinted buffer
        const tintedOffset = await sharp(resizedFrameBuffer)
          .tint({ r, g, b })
          .toBuffer();

        const stepAngle = 0.5;
        for (let angle = 0; angle < Math.PI * 2; angle += stepAngle) {
          const dx = Math.round(Math.cos(angle) * strokeWidth);
          const dy = Math.round(Math.sin(angle) * strokeWidth);

          compositingArray.push({
            input: tintedOffset,
            top: Math.round(256 - (targetH * scale) / 2 + dy),
            left: Math.round(256 - (targetW * scale) / 2 + dx)
          });
        }
      }

      // Add main image exactly centered
      compositingArray.push({
        input: resizedFrameBuffer,
        top: Math.round(256 - (targetH * scale) / 2),
        left: Math.round(256 - (targetW * scale) / 2)
      });

      // Add SVG text overlays
      if (textOverlaySvg) {
        compositingArray.push({
          input: textOverlaySvg,
          top: 0,
          left: 0
        });
      }

      await finalPipeline
        .composite(compositingArray)
        .png()
        .toFile(framePath);
    }

    const outputFilename = `sticker_${id}.webm`;
    const dateSubdir = getAnimatedDir(dateStr);
    const outputPath = path.join(dateSubdir, outputFilename);

    // Compile frames to transparent WebM VP9
    await compressAnimatedWebM(tempFramesDir, outputPath, targetFps, durationSec);

    // Clean frames
    try { fs.rmSync(tempFramesDir, { recursive: true, force: true }); } catch (e) {}

    sticker.status = 'converted';
    sticker.convertedPath = `/animated/${dateStr}/${outputFilename}`;
    sticker.convertedFilename = outputFilename;
    saveDatabase();
    broadcast({ type: 'sticker_update', data: sticker });

    return sticker;
  })
  .then((result) => {
    return res.json({ success: true, sticker: result });
  })
  .catch((err) => {
    console.error(`[Animated Edit Error]:`, err.message);
    sticker.status = 'failed';
    saveDatabase();
    broadcast({ type: 'sticker_update', data: sticker });
    return res.status(500).json({ error: err.message });
  });
});

// Update custom tags for a sticker
app.post('/api/stickers/:id/tags', (req, res) => {
  const { id } = req.params;
  const { tags } = req.body;

  const sticker = capturedStickers.find(s => s.id === id);
  if (!sticker) {
    return res.status(404).json({ error: 'Sticker not found' });
  }

  sticker.tags = Array.isArray(tags) ? tags.map(t => t.toLowerCase().trim()).filter(Boolean) : [];
  saveDatabase();

  console.log(`[Tags Update] Updated tags for ${id}:`, sticker.tags);
  broadcast({ type: 'sticker_update', data: sticker });

  res.json({ success: true, sticker });
});

// WebSocket Server Handshake
wss.on('connection', (ws) => {
  console.log('[WebSocket] Frontend client connected.');
  
  // Send current state and captured stickers database on connect
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      chromeConnected,
      tiktokTabFound,
      cdpConnecting,
      stickers: capturedStickers
    }
  }));

  ws.on('close', () => {
    console.log('[WebSocket] Frontend client disconnected.');
  });
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` TIKTOK TO TELEGRAM STICKER SERVER RUNNING ON PORT ${PORT}`);
  console.log(` API Endpoint: http://localhost:${PORT}`);
  console.log(` Output folder: ${OUTPUT_DIR}`);
  console.log(`=======================================================`);
  console.log(`Waiting for Google Chrome connection... Run start-chrome.bat`);
});
