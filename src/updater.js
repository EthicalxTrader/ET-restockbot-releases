'use strict';

const { autoUpdater } = require('electron-updater');
const { dialog, BrowserWindow, Notification } = require('electron');
const path = require('path');

let mainWindow = null;
let updateCheckInterval = null;

// ── Configure updater ──────────────────────────────────────────────────────────

autoUpdater.autoDownload = true;          // download silently in background
autoUpdater.autoInstallOnAppQuit = true;  // install when user closes app
autoUpdater.allowDowngrade = false;

// Logging
autoUpdater.logger = require('electron').app
  ? null
  : console;

// ── Events ─────────────────────────────────────────────────────────────────────

autoUpdater.on('checking-for-update', () => {
  sendToWindow('updater-status', { status: 'checking' });
});

autoUpdater.on('update-available', (info) => {
  sendToWindow('updater-status', {
    status: 'available',
    version: info.version,
    releaseNotes: info.releaseNotes || ''
  });

  // Show a non-intrusive notification
  if (Notification.isSupported()) {
    new Notification({
      title: 'RestockBot Update Available',
      body: `Version ${info.version} is downloading in the background.`
    }).show();
  }
});

autoUpdater.on('update-not-available', () => {
  sendToWindow('updater-status', { status: 'up-to-date' });
});

autoUpdater.on('download-progress', (progress) => {
  sendToWindow('updater-status', {
    status: 'downloading',
    percent: Math.round(progress.percent),
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total
  });
});

autoUpdater.on('update-downloaded', (info) => {
  sendToWindow('updater-status', {
    status: 'downloaded',
    version: info.version
  });

  // Show dialog asking user to restart
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: `RestockBot ${info.version} has been downloaded.`,
    detail: 'The update will be installed when you restart the app. Restart now?',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    icon: path.join(__dirname, '..', 'assets', 'icon.png')
  }).then(result => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });
});

autoUpdater.on('error', (err) => {
  // Silently log — don't bother user with update errors
  console.error('[Updater] Error:', err.message);
  sendToWindow('updater-status', {
    status: 'error',
    message: err.message
  });
});

// ── Public API ─────────────────────────────────────────────────────────────────

function init(window) {
  mainWindow = window;

  // Check immediately on launch (with a short delay so app loads first)
  setTimeout(() => {
    checkForUpdates();
  }, 8000);

  // Then check every 4 hours while app is open
  updateCheckInterval = setInterval(() => {
    checkForUpdates();
  }, 4 * 60 * 60 * 1000);
}

function checkForUpdates() {
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    console.error('[Updater] Check failed:', err.message);
  }
}

function installNow() {
  autoUpdater.quitAndInstall(false, true);
}

function stop() {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

module.exports = { init, checkForUpdates, installNow, stop };
