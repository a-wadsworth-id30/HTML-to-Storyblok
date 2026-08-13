const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  bootstrap: 'desktop:bootstrap',
  selectDirectory: 'desktop:select-directory',
  previewAction: 'desktop:preview-action',
  runAction: 'desktop:run-action',
  cancelAction: 'desktop:cancel-action',
  readArtifacts: 'desktop:read-artifacts',
  readRunHistory: 'desktop:read-run-history',
  openArtifact: 'desktop:open-artifact',
  cliEvent: 'desktop:cli-event'
});

contextBridge.exposeInMainWorld('htmlToStoryblokDesktop', {
  bootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap),
  selectDirectory: (options) => ipcRenderer.invoke(CHANNELS.selectDirectory, options),
  previewAction: (payload) => ipcRenderer.invoke(CHANNELS.previewAction, payload),
  runAction: (payload) => ipcRenderer.invoke(CHANNELS.runAction, payload),
  cancelAction: (requestId) => ipcRenderer.invoke(CHANNELS.cancelAction, requestId),
  readArtifacts: (payload) => ipcRenderer.invoke(CHANNELS.readArtifacts, payload),
  readRunHistory: () => ipcRenderer.invoke(CHANNELS.readRunHistory),
  openArtifact: (filePath) => ipcRenderer.invoke(CHANNELS.openArtifact, filePath),
  onCliEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(CHANNELS.cliEvent, listener);
    return () => ipcRenderer.off(CHANNELS.cliEvent, listener);
  }
});
