// Exposes a narrow, typed-by-convention API to the UI (see src/bridge.ts). No Node access leaks into the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('standlink', {
  prompt: args => ipcRenderer.invoke('acp:prompt', args),
  start: args => ipcRenderer.invoke('acp:start', args),
  setConfig: (projectId, memberId, configId, value) => ipcRenderer.invoke('acp:config', { projectId, memberId, configId, value }),
  listSkills: cwd => ipcRenderer.invoke('skills:list', cwd),
  saveSkill: skill => ipcRenderer.invoke('skills:save', skill),
  deleteSkill: (name, cwd) => ipcRenderer.invoke('skills:delete', { name, cwd }),
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
