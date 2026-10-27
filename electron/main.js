'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

app.setPath('userData', path.join(app.getPath('appData'), 'SmartMail'));
if (process.platform === 'win32') app.setAppUserModelId('com.smartmail.desktop');

const store = require('./data/store');
const cache = require('./data/cache');
const importTokens = require('./data/importTokens');
const oauth = require('./auth/oauth');
const mail = require('./mail/service');
const calendar = require('./calendar/service');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      console.error(`[${channel}]`, error && error.message ? error.message : error);
      return { ok: false, error: (error && error.message) || 'Something went wrong.' };
    }
  });
}

handle('state:get', () => ({
  settings: store.loadSettings(),
  accounts: store.listAccounts(),
}));

handle('settings:save', (partial) => store.updateSettings(partial || {}));
handle('ui:save', (ui) => store.updateSettings({ ui: ui || {} }));

function readConfigFile(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || (data.app !== 'Light Mail' && data.app !== 'Smart Mail') || Number(data.version) !== 1 || !data.settings) {
    throw new Error('That file is not a Light Mail configuration.');
  }
  return data;
}

function applyConfig(data) {
  store.replaceSettings(data.settings);
  store.writeTokens(data.tokens);
  return { settings: store.loadSettings(), accounts: store.listAccounts() };
}

function backupFolder(picked) {
  if (fs.existsSync(path.join(picked, 'configuration.json'))) return picked;
  const nested = path.join(picked, 'Light Mail Backup');
  if (fs.existsSync(path.join(nested, 'configuration.json'))) return nested;
  const legacy = path.join(picked, 'Smart Mail Backup');
  if (fs.existsSync(path.join(legacy, 'configuration.json'))) return legacy;
  return picked;
}

handle('data:info', () => cache.stats());

handle('data:clear', (scope) => cache.clear(scope));

handle('data:export-config', async () => {
  const result = await dialog.showSaveDialog({
    title: 'Export configuration',
    defaultPath: 'Light Mail configuration.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const body = {
    app: 'Light Mail',
    kind: 'config',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: store.loadSettings(),
    tokens: store.listTokens(),
  };
  fs.writeFileSync(result.filePath, JSON.stringify(body, null, 2), 'utf8');
  return { canceled: false, path: result.filePath };
});

handle('data:import-config', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import configuration',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, ...applyConfig(readConfigFile(result.filePaths[0])) };
});

handle('data:export-db', async () => {
  const result = await dialog.showSaveDialog({
    title: 'Export database',
    defaultPath: 'mail.db',
    filters: [{ name: 'Light Mail database', extensions: ['db'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const source = cache.snapshotPath();
  if (path.resolve(source) !== path.resolve(result.filePath)) fs.copyFileSync(source, result.filePath);
  return { canceled: false, path: result.filePath };
});

handle('data:import-db', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import database',
    filters: [{ name: 'Light Mail database', extensions: ['db'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const info = cache.replace(fs.readFileSync(result.filePaths[0]));
  return { canceled: false, info };
});

handle('data:export-backup', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a folder for the backup',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const dir = path.join(result.filePaths[0], 'Light Mail Backup');
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    app: 'Light Mail',
    kind: 'config',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: store.loadSettings(),
    tokens: store.listTokens(),
  };
  fs.writeFileSync(path.join(dir, 'configuration.json'), JSON.stringify(body, null, 2), 'utf8');
  fs.copyFileSync(cache.snapshotPath(), path.join(dir, 'mail.db'));
  return { canceled: false, path: dir };
});

handle('data:import-backup', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a Light Mail backup folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const dir = backupFolder(result.filePaths[0]);
  const configFile = path.join(dir, 'configuration.json');
  const dbFile = path.join(dir, 'mail.db');
  if (!fs.existsSync(configFile) || !fs.existsSync(dbFile)) {
    throw new Error('Choose the Light Mail Backup folder. It needs configuration.json and mail.db.');
  }
  const applied = applyConfig(readConfigFile(configFile));
  cache.replace(fs.readFileSync(dbFile));
  return { canceled: false, ...applied };
});

handle('google:pick', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Google OAuth credentials',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  let json;
  try {
    json = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const block = json.installed || json.web || json;
  if (!block.client_id || !block.client_secret) {
    throw new Error('Use a Desktop app OAuth client JSON. It needs both a client ID and a client secret.');
  }
  const google = {
    clientId: block.client_id,
    clientSecret: block.client_secret,
    credentialsPath: result.filePaths[0],
  };
  store.updateSettings({ google });
  return { canceled: false, google };
});

handle('accounts:add-gmail', () => oauth.authorizeGoogle());
handle('accounts:add-outlook', () => oauth.authorizeOutlook());
handle('accounts:import-tokens', async (options) => {
  const folder = Boolean(options && options.folder);
  const result = await dialog.showOpenDialog({
    title: folder ? 'Choose a tokens folder' : 'Import email token files',
    filters: folder ? undefined : [{ name: 'JSON tokens', extensions: ['json'] }],
    properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const imported = importTokens.importFromPaths(result.filePaths);
  if (!imported.imported && imported.errors.length) {
    throw new Error(imported.errors[0]);
  }
  return {
    canceled: false,
    ...imported,
    settings: store.loadSettings(),
    allAccounts: store.listAccounts(),
  };
});
function themeDir() {
  const dir = path.join(app.getPath('userData'), 'theme');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function wallpaperMime(file) {
  const ext = path.extname(file).toLowerCase().replace('.', '');
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

function wallpaperDataUrl(fileName) {
  const name = path.basename(String(fileName || ''));
  if (!name) return '';
  const file = path.join(themeDir(), name);
  if (!fs.existsSync(file)) return '';
  const buf = fs.readFileSync(file);
  return `data:${wallpaperMime(file)};base64,${buf.toString('base64')}`;
}

handle('theme:pick-image', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a background image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const src = result.filePaths[0];
  const ext = path.extname(src).toLowerCase().replace('.', '');
  const safe = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) ? ext : 'png';
  const dir = themeDir();
  for (const name of fs.readdirSync(dir)) {
    if (/^background\./i.test(name)) fs.unlinkSync(path.join(dir, name));
  }
  const image = `background.${safe}`;
  fs.copyFileSync(src, path.join(dir, image));
  return { canceled: false, image, dataUrl: wallpaperDataUrl(image) };
});

handle('theme:clear-image', () => {
  const dir = themeDir();
  for (const name of fs.readdirSync(dir)) {
    if (/^background\./i.test(name)) fs.unlinkSync(path.join(dir, name));
  }
  return { cleared: true };
});

handle('theme:image-url', () => {
  const theme = ((store.loadSettings().ui || {}).theme) || {};
  return { dataUrl: wallpaperDataUrl(theme.image) };
});

handle('accounts:cancel-auth', () => oauth.cancelAuth());
handle('accounts:remove', (accountId) => {
  cache.drop(`mail:${accountId}:`);
  cache.drop(`cal:${accountId}`);
  return store.removeAccount(accountId);
});

handle('mail:folders', (accountId, options) => mail.listFolders(accountId, options));
handle('mail:tags', (accountId, options) => mail.listTags(accountId, options));
handle('mail:list', (accountId, folderId, options) => mail.listMessages(accountId, folderId, options));
handle('mail:get', (accountId, messageId, options) => mail.getMessage(accountId, messageId, options));
handle('mail:read', (accountId, ids, read) => mail.setRead(accountId, ids, read));
handle('mail:flag', (accountId, ids, flagged) => mail.setFlag(accountId, ids, flagged));
handle('mail:pin', (accountId, ids, pinned) => mail.setPinned(accountId, ids, pinned));
handle('mail:remove', (accountId, ids, options) => mail.removeMessages(accountId, ids, options));
handle('mail:move', (accountId, ids, destinationId, sourceFolderId) => (
  mail.moveMessages(accountId, ids, destinationId, sourceFolderId)
));
handle('mail:archive', (accountId, ids) => mail.archiveMessages(accountId, ids));
handle('mail:tags:set', (accountId, messageId, tagNames) => mail.setTags(accountId, messageId, tagNames));
handle('mail:folder:create', (accountId, name, parentId) => mail.createFolder(accountId, name, parentId));
handle('mail:tag:create', (accountId, name, color) => mail.createTag(accountId, name, color));
handle('mail:send', (accountId, draft) => mail.send(accountId, draft));
handle('cal:list', (accountId, range) => calendar.listEvents(accountId, range));
handle('cal:save', (accountId, draft) => calendar.saveEvent(accountId, draft));
handle('cal:delete', (accountId, event) => calendar.deleteEvent(accountId, event));

handle('mail:attachment', async (accountId, messageId, attachmentId) => {
  const file = await mail.getAttachment(accountId, messageId, attachmentId);
  const result = await dialog.showSaveDialog({ defaultPath: file.name || 'attachment' });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, file.buffer);
  return { canceled: false, path: result.filePath };
});

function mainWindow() {
  return BrowserWindow.getAllWindows()[0];
}

handle('window:action', (action) => {
  const win = mainWindow();
  if (!win) return { maximized: false };
  if (action === 'min') win.minimize();
  else if (action === 'max') {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === 'close') win.close();
  return { maximized: !win.isDestroyed() && win.isMaximized() };
});

handle('window:state', () => {
  const win = mainWindow();
  return { maximized: Boolean(win && win.isMaximized()) };
});

handle('shell:open', (url) => {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error('That link is invalid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only web links can be opened.');
  }
  return shell.openExternal(parsed.href);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#faf9f8',
    autoHideMenuBar: true,
    title: 'Light Mail',
    icon: path.join(__dirname, '..', 'src', 'logo.png'),
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  const sendState = () => {
    if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: win.isMaximized() });
  };
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  win.once('ready-to-show', () => {
    win.show();
    console.log('Light Mail ready');
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  return win;
}

if (gotLock) {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    await cache.open();
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => cache.flush());
}
