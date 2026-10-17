import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DictationAPI } from './contracts';

const invoke = (action: string, ...args: unknown[]) => ipcRenderer.invoke(`dictation:${action}`, ...args);
const api: DictationAPI = {
  getState: () => invoke('state'),
  refresh: () => invoke('refresh'),
  setSettings: (settings) => invoke('settings', settings),
  requestPermission: (kind) => invoke('permission', kind),
  openSettings: (kind) => invoke('open-permission-settings', kind),
  begin: () => invoke('begin'),
  end: () => invoke('end'),
  copyTranscript: (id) => invoke('copy', id),
  holdOverlay: (held) => ipcRenderer.send('dictation:overlay-hover', held),
  beginOverlayDrag: () => ipcRenderer.send('dictation:overlay-drag-start'),
  moveOverlayDrag: () => ipcRenderer.send('dictation:overlay-drag-move'),
  endOverlayDrag: () => ipcRenderer.send('dictation:overlay-drag-end'),
  openLogs: () => invoke('logs'),
  showSettings: () => invoke('show-settings'),
  quit: () => invoke('quit'),
  ready: () => invoke('ready'),
  reportCapturing: (takeId, microphoneName) => ipcRenderer.send('dictation:capturing', takeId, microphoneName),
  reportLevel: (level) => ipcRenderer.send('dictation:level', level),
  reportError: (message, takeId) => ipcRenderer.send('dictation:recorder-error', message, takeId),
  start: (takeId) => invoke('start', takeId),
  sendAudio: (audio, takeId) => ipcRenderer.send('dictation:audio', audio, takeId),
  stop: (takeId) => invoke('stop', takeId),
  cancel: (takeId) => invoke('cancel', takeId),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: AppEvent) => callback(message);
    ipcRenderer.on('dictation:event', listener);
    return () => ipcRenderer.removeListener('dictation:event', listener);
  },
};
contextBridge.exposeInMainWorld('dictation', api);
