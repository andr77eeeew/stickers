# 💎 TikTok to Telegram: Sticker Powerhouse Suite

A premium, production-grade tool designed to passively intercept WebP stickers from active TikTok chats and convert them into compliant formats ready for Telegram (`@Stickers` bot drag-and-drop).

The suite is built with a sleek Cyberpunk Obsidian-neon visual aesthetic and features a companion overlay injected directly into the TikTok interface.

---

## 🚀 Key Features

1. **Instant Real-Time Capture (Zero-Reload Grabber)**:
   Uses Chrome DevTools Protocol (CDP) to inject a passive DOM `MutationObserver` script. It detects incoming/outgoing stickers in TikTok chats and sends them to the local server in `< 10ms` without page reloads.
2. **TikTok Overlay companion Mini-App**:
   Injects a collapsible floating panel styled with obsidian-neon glassmorphism directly into the TikTok webpage. You can convert, scrub frames, and download sticker outputs without leaving the TikTok tab.
3. **Transparent HTML5 Canvas Editor**:
   Allows crops, rotations, scaling, top/bottom text overlays (Impact font), and an algorithmic silhouette stroke border outline generator utilizing offscreen compositing.
4. **Low-Latency Media Pipeline**:
   * **On-Demand Frame Extraction Cache (ODFC)**: Pre-warms memory with low-resolution frame previews on scrub timelines, avoiding thread pool contention.
   * **FFmpeg CPU Queue**: Background task queue (max concurrency = 2) prevents high-CPU locks during VP9 WebM encodes.
5. **Manual Tagging & Search**:
   Allows user-assigned tags for fuzzy indexing in the main dashboard.

---

## 🛠️ Tech Stack

* **Backend**: Node.js, Express, WebSockets (`ws`), `chrome-remote-interface` (CDP), `sharp` (metadata, resizes, canvas layering), `ffmpeg-static` (VP9 animated WebM encodes).
* **Frontend**: React (Vite), Lucide Icons, Vanilla CSS (glowing obsidian styling).

---

## 📁 Directory Structure

```
stickers/
├── .agents/               # Custom Agent Rules & Context
│   └── AGENTS.md          # Onboarding guide for future AI agents
├── frontend/              # React Vite client dashboard
│   ├── src/
│   │   ├── App.jsx        # Main client interface & Canvas Editor
│   │   ├── index.css      # Obsidian Cyberpunk design system
│   │   └── main.jsx       # Entrypoint
│   └── vite.config.js
├── output/                # Database and converted sticker directories
│   ├── captured/          # Original intercepted WebP files
│   ├── statics/           # Compliant Telegram WebP static stickers
│   ├── animated/          # Compliant Telegram VP9 WebM animated stickers
│   └── stickers_db.json   # SQLite-like JSON database mapping stickers
├── temp/                  # volative folders for frame extraction
├── start-chrome.bat       # Script to launch Chrome in debug mode on port 9222
├── server.js              # Core CDP connector, WebSocket & Media server
├── ConversionQueue.js     # Background concurrency limiter for FFmpeg
└── package.json           # Backend dependency configurations
```

---

## 🏁 How to Launch

### Step 1: Launch Google Chrome in Debugging Mode
Close all Chrome instances or launch the debugging session using the isolated profiles batch file:
```powershell
.\start-chrome.bat
```
*Note: This creates an isolated session under `.chrome-profile` listening on debugging port `9222`. You will need to log in to TikTok in this browser window.*

### Step 2: Start the Servers
Install dependencies and run the concurrently runner:
```powershell
npm install
npm run dev
```
This boots:
* **Backend Webhook/WebSocket Server**: `http://localhost:3001`
* **Vite Frontend Dashboard**: `http://localhost:3000`

---

## 🎨 Compliance Specs (Telegram Sticker Bot)

* **Static Stickers**: PNG/WebP, transparent background, exactly 512px on one side (other side $\le$ 512px), file size $\le$ 512 KB.
* **Animated Stickers**: VP9 WebM, transparent background, no audio, exactly 512px on one side, framerate $\le$ 30 FPS, duration $\le$ 3.0 seconds, file size $\le$ 256 KB.
