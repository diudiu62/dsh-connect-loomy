/**
 * 预加载桥：渲染进程只能碰这几个方法，拿不到 fs / 也拿不到 session。
 *
 * CJS（.cjs）是刻意的：Electron 的 ESM preload 需要额外开关，CJS 在所有版本
 * 上都稳。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('state'),
  import: (text) => ipcRenderer.invoke('import', text),
  importFile: () => ipcRenderer.invoke('importFile'),
  capture: () => ipcRenderer.invoke('capture'),
  switch: (payload) => ipcRenderer.invoke('switch', payload),
  signOut: (payload) => ipcRenderer.invoke('signOut', payload),
  rename: (payload) => ipcRenderer.invoke('rename', payload),
  remove: (payload) => ipcRenderer.invoke('remove', payload),
  export: () => ipcRenderer.invoke('export'),
  refreshCredits: () => ipcRenderer.invoke('refreshCredits'),
  refreshOne: (payload) => ipcRenderer.invoke('refreshOne', payload),
  refreshInvite: (payload) => ipcRenderer.invoke('refreshInvite', payload),
  redeemInvite: (payload) => ipcRenderer.invoke('redeemInvite', payload),
  revealBackups: () => ipcRenderer.invoke('revealBackups'),
  launchClient: () => ipcRenderer.invoke('launchClient'),
  quitClient: () => ipcRenderer.invoke('quitClient'),
  setTarget: (payload) => ipcRenderer.invoke('setTarget', payload),
  onProgress: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('progress', listener)
    return () => ipcRenderer.removeListener('progress', listener)
  },
})
