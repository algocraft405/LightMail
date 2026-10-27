'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  google: { clientId: '', clientSecret: '', credentialsPath: '' },
  outlook: { clientId: '', clientSecret: '', tenant: 'consumers' },
  accounts: [],
  ui: { accountId: null, folderId: null, navWidth: 268, listWidth: 392, module: 'mail', calView: 'month', pollSeconds: 60, theme: { id: 'light', color: '', image: '' } },
};

function rootDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function settingsPath() {
  return path.join(rootDir(), 'settings.json');
}

function tokensDir() {
  const dir = path.join(rootDir(), 'tokens');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function accountId(provider, email) {
  return `${provider}:${String(email || '').trim().toLowerCase()}`;
}

function loadSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.google = { ...settings.google, ...(data.google || {}) };
    settings.outlook = { ...settings.outlook, ...(data.outlook || {}) };
    settings.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    settings.ui = { ...settings.ui, ...(data.ui || {}) };
    if (!settings.outlook.tenant) settings.outlook.tenant = 'consumers';
    return settings;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function replaceSettings(data) {
  const source = data && typeof data === 'object' ? data : {};
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.google = { ...settings.google, ...(source.google || {}) };
  settings.outlook = { ...settings.outlook, ...(source.outlook || {}) };
  settings.accounts = (Array.isArray(source.accounts) ? source.accounts : []).map((entry) => ({
    provider: entry && entry.provider === 'outlook' ? 'outlook' : 'gmail',
    email: String((entry && entry.email) || '').trim(),
    name: String((entry && entry.name) || '').trim(),
  })).filter((entry) => entry.email);
  settings.ui = { ...settings.ui, ...(source.ui || {}) };
  if (!settings.outlook.tenant) settings.outlook.tenant = 'consumers';
  saveSettings(settings);
  return settings;
}

function listTokens() {
  return listAccounts().map((account) => {
    const token = readToken(account);
    if (!token || typeof token !== 'object') return null;
    return { provider: account.provider, email: account.email, token };
  }).filter(Boolean);
}

function writeTokens(tokens) {
  for (const item of Array.isArray(tokens) ? tokens : []) {
    if (!item || !item.email || !item.token || typeof item.token !== 'object') continue;
    writeToken({
      provider: item.provider === 'outlook' ? 'outlook' : 'gmail',
      email: item.email,
    }, item.token);
  }
}

function updateSettings(partial) {
  const settings = loadSettings();
  if (partial.google) settings.google = { ...settings.google, ...partial.google };
  if (partial.outlook) settings.outlook = { ...settings.outlook, ...partial.outlook };
  if (partial.ui) settings.ui = { ...settings.ui, ...partial.ui };
  saveSettings(settings);
  return settings;
}

function hydrate(entry) {
  const email = String(entry.email || '').trim();
  const provider = entry.provider === 'outlook' ? 'outlook' : 'gmail';
  return {
    id: accountId(provider, email),
    provider,
    email,
    name: String(entry.name || '').trim() || email,
  };
}

function listAccounts() {
  return loadSettings()
    .accounts
    .map(hydrate)
    .filter((account) => account.email);
}

function getAccount(id) {
  return listAccounts().find((account) => account.id === id) || null;
}

function upsertAccount(account) {
  const settings = loadSettings();
  const id = accountId(account.provider, account.email);
  settings.accounts = settings.accounts.filter((entry) => hydrate(entry).id !== id);
  settings.accounts.push({
    provider: account.provider,
    email: account.email,
    name: account.name || account.email,
  });
  saveSettings(settings);
  return getAccount(id);
}

function removeAccount(id) {
  const settings = loadSettings();
  const account = getAccount(id);
  settings.accounts = settings.accounts.filter((entry) => hydrate(entry).id !== id);
  if (settings.ui.accountId === id) {
    settings.ui.accountId = null;
    settings.ui.folderId = null;
  }
  saveSettings(settings);
  if (account) {
    const file = tokenPath(account.provider, account.email);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return account;
}

function tokenPath(provider, email) {
  const safe = String(email || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  const file = provider === 'gmail' ? `${safe}.json` : `${provider}_${safe}.json`;
  return path.join(tokensDir(), file);
}

function readToken(account) {
  const file = tokenPath(account.provider, account.email);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeToken(account, token) {
  const file = tokenPath(account.provider, account.email);
  fs.writeFileSync(file, JSON.stringify(token, null, 2), 'utf8');
}

module.exports = {
  loadSettings,
  saveSettings,
  replaceSettings,
  listTokens,
  writeTokens,
  updateSettings,
  listAccounts,
  getAccount,
  upsertAccount,
  removeAccount,
  readToken,
  writeToken,
  accountId,
};
