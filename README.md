# RestockBot Desktop App

A native desktop application built with Electron. Distributes as a
single `.exe` installer (Windows) or `.dmg` (Mac) — no Node.js,
no terminal, no config files required for end users.

---

## For End Users (no setup needed)

1. Download `RestockBot-Setup.exe` (Windows) or `RestockBot.dmg` (Mac)
2. Install it like any normal app
3. A setup wizard walks through everything on first launch
4. The bot runs in the background from the system tray

---

## For Developers: Building the Installer

### Prerequisites

- Node.js 18+ (nodejs.org)
- npm

### Setup

```bash
cd restockbot-electron
npm install
```

### Run in development

```bash
npm start
```

### Build installer

**Windows (.exe installer):**
```bash
npm run build:win
```

**Mac (.dmg):**
```bash
npm run build:mac
```

**Both platforms:**
```bash
npm run build:all
```

Output goes to the `dist/` folder.

---

## App Icons

Before building, add your icons to the `assets/` folder:

| File | Size | Used for |
|------|------|---------|
| `assets/icon.png` | 512×512 | Linux, fallback |
| `assets/icon.ico` | Multi-size ICO | Windows |
| `assets/icon.icns` | ICNS bundle | Mac |
| `assets/tray-icon.png` | 16×16 or 32×32 | System tray |

Free tool to convert PNG → ICO/ICNS: https://icoconvert.com

---

## Project Structure

```
restockbot-electron/
├── src/
│   ├── main.js        ← Electron main process, bot engine, IPC handlers
│   └── preload.js     ← Secure bridge: renderer ↔ main
├── renderer/
│   ├── setup.html     ← First-run setup wizard (5 steps)
│   └── dashboard.html ← Main app UI (watchlist, log, settings)
├── assets/            ← App icons
└── package.json       ← Electron + electron-builder config
```

## How config is stored

All settings are stored using `electron-store` in the user's app data folder
(no `.env` file needed). Location:

- **Windows:** `%APPDATA%\restockbot\config.json`
- **Mac:** `~/Library/Application Support/restockbot/config.json`
- **Linux:** `~/.config/restockbot/config.json`

Users can re-run the setup wizard anytime from Settings → "Re-run setup wizard".

---

## Distributing to Others

After `npm run build:win`, share the file from `dist/`:

- `RestockBot Setup 1.0.0.exe` — Windows NSIS installer with Start Menu + Desktop shortcut
- `RestockBot-1.0.0.dmg` — Mac drag-to-Applications installer

The installer bundles Node.js and all dependencies — recipients just
double-click and install like any app, no technical knowledge needed.
