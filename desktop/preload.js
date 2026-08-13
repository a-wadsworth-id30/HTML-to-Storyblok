import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('htmlToStoryblokDesktop', {
  bootstrap: () => ipcRenderer.invoke('desktop:bootstrap'),
  selectDirectory: (options) => ipcRenderer.invoke('desktop:select-directory', options),
  previewAction: (payload) => ipcRenderer.invoke('desktop:preview-action', payload),
  runAction: (payload) => ipcRenderer.invoke('desktop:run-action', payload),
  cancelAction: (requestId) => ipcRenderer.invoke('desktop:cancel-action', requestId),
  readArtifacts: (payload) => ipcRenderer.invoke('desktop:read-artifacts', payload),
  openArtifact: (filePath) => ipcRenderer.invoke('desktop:open-artifact', filePath),
  onCliEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:cli-event', listener);
    return () => ipcRenderer.off('desktop:cli-event', listener);
  }
});
