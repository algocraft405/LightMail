'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartMail', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveUi: (ui) => ipcRenderer.invoke('ui:save', ui),
  dataInfo: () => ipcRenderer.invoke('data:info'),
  clearData: (scope) => ipcRenderer.invoke('data:clear', scope),
  exportConfig: () => ipcRenderer.invoke('data:export-config'),
  importConfig: () => ipcRenderer.invoke('data:import-config'),
  exportDatabase: () => ipcRenderer.invoke('data:export-db'),
  importDatabase: () => ipcRenderer.invoke('data:import-db'),
  exportBackup: () => ipcRenderer.invoke('data:export-backup'),
  importBackup: () => ipcRenderer.invoke('data:import-backup'),
  pickGoogleCredentials: () => ipcRenderer.invoke('google:pick'),
  pickThemeImage: () => ipcRenderer.invoke('theme:pick-image'),
  clearThemeImage: () => ipcRenderer.invoke('theme:clear-image'),
  themeImageUrl: () => ipcRenderer.invoke('theme:image-url'),
  addGmail: () => ipcRenderer.invoke('accounts:add-gmail'),
  addOutlook: () => ipcRenderer.invoke('accounts:add-outlook'),
  importTokens: (options) => ipcRenderer.invoke('accounts:import-tokens', options),
  cancelAuth: () => ipcRenderer.invoke('accounts:cancel-auth'),
  removeAccount: (accountId) => ipcRenderer.invoke('accounts:remove', accountId),
  listFolders: (accountId, options) => ipcRenderer.invoke('mail:folders', accountId, options),
  listTags: (accountId, options) => ipcRenderer.invoke('mail:tags', accountId, options),
  listMessages: (accountId, folderId, options) => ipcRenderer.invoke('mail:list', accountId, folderId, options),
  getMessage: (accountId, messageId, options) => ipcRenderer.invoke('mail:get', accountId, messageId, options),
  setRead: (accountId, ids, read) => ipcRenderer.invoke('mail:read', accountId, ids, read),
  setFlag: (accountId, ids, flagged) => ipcRenderer.invoke('mail:flag', accountId, ids, flagged),
  setPinned: (accountId, ids, pinned) => ipcRenderer.invoke('mail:pin', accountId, ids, pinned),
  removeMessages: (accountId, ids, options) => ipcRenderer.invoke('mail:remove', accountId, ids, options),
  moveMessages: (accountId, ids, destinationId, sourceFolderId) => (
    ipcRenderer.invoke('mail:move', accountId, ids, destinationId, sourceFolderId)
  ),
  archiveMessages: (accountId, ids) => ipcRenderer.invoke('mail:archive', accountId, ids),
  setTags: (accountId, messageId, tagNames) => ipcRenderer.invoke('mail:tags:set', accountId, messageId, tagNames),
  createFolder: (accountId, name, parentId) => ipcRenderer.invoke('mail:folder:create', accountId, name, parentId),
  createTag: (accountId, name, color) => ipcRenderer.invoke('mail:tag:create', accountId, name, color),
  send: (accountId, draft) => ipcRenderer.invoke('mail:send', accountId, draft),
  saveAttachment: (accountId, messageId, attachmentId) => (
    ipcRenderer.invoke('mail:attachment', accountId, messageId, attachmentId)
  ),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  windowState: () => ipcRenderer.invoke('window:state'),
  onWindowState: (cb) => {
    ipcRenderer.on('window:state', (_event, data) => cb(data));
  },
  listEvents: (accountId, range) => ipcRenderer.invoke('cal:list', accountId, range),
  saveEvent: (accountId, draft) => ipcRenderer.invoke('cal:save', accountId, draft),
  deleteEvent: (accountId, event) => ipcRenderer.invoke('cal:delete', accountId, event),
});
