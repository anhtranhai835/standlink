// Exposes a narrow, typed-by-convention API to the UI (see src/bridge.ts). No Node access leaks into the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('standlink', {
  prompt: args => ipcRenderer.invoke('acp:prompt', args),
  cancel: (projectId, memberId) => ipcRenderer.invoke('acp:cancel', { projectId, memberId }),
  permission: (reqId, optionId) => ipcRenderer.invoke('acp:permission', { reqId, optionId }),
  stop: (projectId, memberId) => ipcRenderer.invoke('acp:stop', { projectId, memberId }),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  onMcpCall: cb => {
    const handler = (_e, call) => cb(call);
    ipcRenderer.on('mcp:call', handler);
    return () => ipcRenderer.removeListener('mcp:call', handler);
  },
  mcpReply: (callId, text, isError) => ipcRenderer.invoke('mcp:reply', { callId, text, isError }),
  onEvent: cb => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('acp:event', handler);
    return () => ipcRenderer.removeListener('acp:event', handler);
  },
});
