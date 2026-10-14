const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('securePrintConfig', {
  get: () => ipcRenderer.invoke('get-client-config')
});

contextBridge.exposeInMainWorld('electronAPI', {
  getDownloads: () => ipcRenderer.invoke('get-downloads'),
  browseFile: () => ipcRenderer.invoke('browse-file'),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  printFile: (options) => ipcRenderer.invoke('print-file', options),
  previewFile: (filePath) => ipcRenderer.invoke('preview-file', filePath),
  navigate: (page) => {
    console.log('[ELECTRON] Navigate to:', page);
    return ipcRenderer.invoke('navigate', page);
  },
  getPdfInfo: (filePath) => ipcRenderer.invoke('get-pdf-info', filePath),
  // File conversion (Word, Excel, PPT, images, text → PDF)
  convertFile: (filePath) => ipcRenderer.invoke('convert-file', filePath),
  // External file handling (context menu / Open With)
  getPendingFile: () => ipcRenderer.invoke('get-pending-file'),
  clearPendingFile: () => ipcRenderer.invoke('clear-pending-file'),
  // Print enforcer status
  getEnforcerStatus: () => ipcRenderer.invoke('get-enforcer-status'),
  onPrintBlocked: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Print blocked notification callback must be a function.');
    }
    const listener = (_event, message) => {
      if (typeof message === 'string') callback(message);
    };
    ipcRenderer.on('print-blocked-warning', listener);
    return () => ipcRenderer.removeListener('print-blocked-warning', listener);
  },
  syncPrintLogs: (token) => ipcRenderer.invoke('sync-print-logs', token),
  clearPrintLogToken: () => ipcRenderer.invoke('clear-print-log-token')
});

// Expose secure storage for token
contextBridge.exposeInMainWorld('secureStorage', {
  set: (key, value) => {
    try { localStorage.setItem(key, value); } catch(e) {}
  },
  get: (key) => {
    try { return localStorage.getItem(key); } catch(e) { return null; }
  },
  remove: (key) => {
    try { localStorage.removeItem(key); } catch(e) {}
  },
  clear: () => {
    try { localStorage.clear(); } catch(e) {}
  }
});
