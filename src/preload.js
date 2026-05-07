'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('restockbot', {
  // Store
  get: (key) => ipcRenderer.invoke('get-store', key),
  set: (key, value) => ipcRenderer.invoke('set-store', key, value),

  // Bot control
  startBot: () => ipcRenderer.invoke('start-bot'),
  stopBot: () => ipcRenderer.invoke('stop-bot'),
  checkNow: (id) => ipcRenderer.invoke('check-now', id),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),

  // Setup
  completeSetup: (settings) => ipcRenderer.invoke('complete-setup', settings),
  resetSetup: () => ipcRenderer.invoke('reset-setup'),

  // Utils
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Window controls (native frame handles these now)
  minimize: () => {},
  maximize: () => {},
  close: () => ipcRenderer.send('window-close'),
  quit: () => ipcRenderer.send('window-quit'),

  // Updater
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Events from main → renderer
  on: (channel, fn) => {
    const allowed = ['bot-status', 'restock-detected', 'checks-complete', 'log-entry', 'updater-status'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, data) => fn(data));
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel)
});
