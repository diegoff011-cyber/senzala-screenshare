// Ponte segura entre a tela (renderer) e o sistema (main)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getIdentity: () => ipcRenderer.invoke('identity:get'),
  setName: (n) => ipcRenderer.invoke('identity:setName', n),
  newId: () => ipcRenderer.invoke('identity:newId'),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  inputStart: () => ipcRenderer.invoke('input:start'),
  inputSend: (line) => ipcRenderer.send('input:send', line),
  inputStop: () => ipcRenderer.send('input:stop'),
  showBar: (info) => ipcRenderer.send('bar:show', info),
  hideBar: () => ipcRenderer.send('bar:hide'),
  barDisconnect: () => ipcRenderer.send('bar:disconnect'),
  onBarDisconnect: (cb) => ipcRenderer.on('bar:disconnect', () => cb()),
  attention: () => ipcRenderer.send('win:attention'),
});
