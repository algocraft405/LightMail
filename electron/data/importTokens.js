'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

function emailFromFileName(file) {
  let name = path.basename(file, path.extname(file));
  let provider = '';
  if (/^outlook_/i.test(name)) {
    provider = 'outlook';
    name = name.replace(/^outlook_/i, '');
  }
  const at = name.lastIndexOf('_');
  if (at <= 0) return { email: '', provider };
  return { email: `${name.slice(0, at)}@${name.slice(at + 1)}`.toLowerCase(), provider };
}

function expiryMs(raw) {
  if (raw && raw.expires_at != null && raw.expires_at !== '') {
    const n = Number(raw.expires_at);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  if (raw && raw.expiry) {
    const t = Date.parse(raw.expiry);
    if (Number.isFinite(t)) return t;
  }
  if (raw && raw.expires_in != null) {
    const seconds = Number(raw.expires_in);
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
  }
  return Date.now();
}

function looksLikeCredentials(raw) {
  return Boolean(raw && (raw.installed || raw.web) && (raw.installed || raw.web).client_id);
}

function looksLikeAppConfig(raw) {
  return Boolean(raw && (raw.app === 'Light Mail' || raw.app === 'Smart Mail' || raw.kind === 'config') && raw.settings);
}

function parseTokenFile(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { error: `${path.basename(file)} is not valid JSON.` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${path.basename(file)} is not a token file.` };
  }
  if (looksLikeCredentials(raw) || looksLikeAppConfig(raw)) {
    return { skip: true };
  }

  const fromName = emailFromFileName(file);
  const access = String(raw.access_token || raw.token || '').trim();
  const refresh = String(raw.refresh_token || '').trim();
  if (!access && !refresh) {
    return { error: `${path.basename(file)} has no access or refresh token.` };
  }

  let provider = raw.provider === 'outlook' || raw.provider === 'gmail' ? raw.provider : '';
  if (!provider && (raw.account_email || fromName.provider === 'outlook' || /^outlook_/i.test(path.basename(file)))) {
    provider = 'outlook';
  }
  if (!provider) provider = 'gmail';

  const email = String(raw.email || raw.account_email || raw.account || fromName.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { error: `${path.basename(file)} does not include an email address.` };
  }

  const token = {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiryMs(raw),
    scope: Array.isArray(raw.scopes) ? raw.scopes.filter(Boolean).join(' ') : String(raw.scope || ''),
    token_type: raw.token_type || 'Bearer',
    provider,
    email,
  };
  if (provider === 'outlook') token.tenant = String(raw.tenant || 'consumers').trim() || 'consumers';
  if (raw.client_id) token.client_id = String(raw.client_id).trim();
  if (raw.client_secret) token.client_secret = String(raw.client_secret).trim();

  return { provider, email, token };
}

function listTokenFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.json')) continue;
    if (/^(settings|credentials|configuration)\.json$/i.test(entry.name)) continue;
    files.push(path.join(dir, entry.name));
  }
  const nested = path.join(dir, 'tokens');
  if (nested !== dir && fs.existsSync(nested)) {
    try {
      if (fs.statSync(nested).isDirectory()) files.push(...listTokenFiles(nested));
    } catch {
      // Skip a tokens folder that cannot be read.
    }
  }
  return files;
}

function absorbGoogleSettings(tokens) {
  const settings = store.loadSettings();
  if ((settings.google.clientId || '').trim() && (settings.google.clientSecret || '').trim()) return;
  const source = tokens.find((item) => item.provider === 'gmail' && item.token.client_id && item.token.client_secret);
  if (!source) return;
  store.updateSettings({
    google: {
      clientId: settings.google.clientId || source.token.client_id,
      clientSecret: settings.google.clientSecret || source.token.client_secret,
    },
  });
}

function absorbOutlookTenant(tokens) {
  const settings = store.loadSettings();
  if ((settings.outlook.tenant || '').trim()) return;
  const source = tokens.find((item) => item.provider === 'outlook' && item.token.tenant);
  if (!source) return;
  store.updateSettings({ outlook: { tenant: source.token.tenant } });
}

function readOutlookAppFromDir(dir) {
  const candidates = [
    path.join(dir, 'settings.json'),
    path.join(path.dirname(dir), 'settings.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const outlook = (data && data.outlook) || {};
      const clientId = String(outlook.client_id || outlook.clientId || '').trim();
      const tenant = String(outlook.tenant || '').trim();
      if (clientId || tenant) return { clientId, tenant, clientSecret: String(outlook.client_secret || outlook.clientSecret || '').trim() };
    } catch {
      // Skip a settings file that is not the checker format.
    }
  }
  return null;
}

function stampOutlookApp(tokens, app) {
  const settings = store.loadSettings();
  const clientId = (app && app.clientId) || (settings.outlook.clientId || '').trim();
  const clientSecret = (app && app.clientSecret) || (settings.outlook.clientSecret || '').trim();
  const tenant = (app && app.tenant) || (settings.outlook.tenant || '').trim();
  if (app && (app.clientId || app.tenant) && (!(settings.outlook.clientId || '').trim() || !(settings.outlook.tenant || '').trim())) {
    store.updateSettings({
      outlook: {
        clientId: (settings.outlook.clientId || '').trim() || app.clientId || '',
        tenant: (settings.outlook.tenant || '').trim() || app.tenant || 'consumers',
        clientSecret: (settings.outlook.clientSecret || '').trim() || app.clientSecret || '',
      },
    });
  }
  if (!clientId && !tenant && !clientSecret) return;
  for (const item of tokens) {
    if (item.provider !== 'outlook') continue;
    if (clientId && !item.token.client_id) item.token.client_id = clientId;
    if (clientSecret && !item.token.client_secret) item.token.client_secret = clientSecret;
    if (tenant && !item.token.tenant) item.token.tenant = tenant;
  }
}

function importParsed(parsed, app) {
  const ready = [];
  const errors = [];
  for (const item of parsed) {
    if (item.skip) continue;
    if (item.error) {
      errors.push(item.error);
      continue;
    }
    ready.push(item);
  }
  absorbGoogleSettings(ready);
  absorbOutlookTenant(ready);
  stampOutlookApp(ready, app);
  const imported = [];
  const seen = new Set();
  for (const item of ready) {
    const id = store.accountId(item.provider, item.email);
    if (seen.has(id)) continue;
    seen.add(id);
    const account = store.upsertAccount({
      provider: item.provider,
      email: item.email,
      name: item.email,
    });
    store.writeToken(account, item.token);
    imported.push(account);
  }
  return {
    imported: imported.length,
    accounts: imported,
    emails: imported.map((account) => account.email),
    errors,
  };
}

function importFromPaths(paths) {
  const files = [];
  let app = null;
  for (const picked of paths || []) {
    if (!picked) continue;
    try {
      const stat = fs.statSync(picked);
      if (stat.isDirectory()) {
        files.push(...listTokenFiles(picked));
        if (!app) app = readOutlookAppFromDir(picked);
      } else if (stat.isFile()) {
        files.push(picked);
        if (!app) app = readOutlookAppFromDir(path.dirname(picked));
      }
    } catch {
      // Skip a path that disappeared after the dialog closed.
    }
  }
  if (!files.length) {
    return { imported: 0, accounts: [], emails: [], errors: ['No token JSON files were found.'] };
  }
  return importParsed(files.map(parseTokenFile), app);
}

module.exports = { parseTokenFile, listTokenFiles, importFromPaths };
