'use strict';

const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');
const store = require('../data/store');
const { requestJson } = require('../shared/util');

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

const OUTLOOK_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxSettings.ReadWrite',
  'Calendars.ReadWrite',
];

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Light Mail</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7fb;
    font-family: "Segoe UI", sans-serif; color: #1b1a19; }
  main { width: min(440px, calc(100% - 48px)); background: white; border: 1px solid #e1e1e1;
    border-radius: 12px; padding: 28px; box-shadow: 0 12px 40px rgba(0,0,0,.08); }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0; color: #616161; line-height: 1.5; }
</style></head>
<body><main><h1>You're signed in</h1>
<p>Light Mail has the account. You can close this window and return to the app.</p>
</main></body></html>`;

let activeFlow = null;
const refreshLocks = new Map();

function listen(host, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}

async function startLoopback() {
  const v4 = await listen('127.0.0.1', 0);
  const port = v4.address().port;
  const servers = [v4];
  try {
    servers.push(await listen('::1', port));
  } catch {
    // IPv6 loopback is optional. IPv4 still receives 127.0.0.1.
  }
  return { servers, redirectUri: `http://localhost:${port}/` };
}

function closeServers(servers) {
  for (const server of servers || []) {
    try {
      server.close();
    } catch {
      // Already closed.
    }
  }
}

function waitForRedirect(flow, timeoutMs) {
  const servers = flow.servers;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`No sign-in response within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    const poll = setInterval(() => {
      if (flow.cancelled) finish(new Error('Sign-in cancelled.'));
    }, 250);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      for (const server of servers) server.removeListener('request', onRequest);
      closeServers(servers);
      if (error) reject(error);
      else resolve(value);
    }

    function onRequest(req, res) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SUCCESS_HTML);
      finish(null, url);
    }

    for (const server of servers) server.on('request', onRequest);
  });
}

function cancelAuth() {
  if (!activeFlow) return false;
  activeFlow.cancelled = true;
  closeServers(activeFlow.servers);
  return true;
}

async function beginFlow() {
  cancelAuth();
  const loopback = await startLoopback();
  const flow = { cancelled: false, servers: loopback.servers, redirectUri: loopback.redirectUri };
  activeFlow = flow;
  return flow;
}

function endFlow(flow) {
  if (activeFlow === flow) activeFlow = null;
}

async function openBrowser(url) {
  await shell.openExternal(url);
}

function tokenRecord(payload, extra) {
  const expiresIn = Number(payload.expires_in || 3600);
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || extra.refresh_token || '',
    expires_at: Date.now() + expiresIn * 1000,
    scope: payload.scope || '',
    token_type: payload.token_type || 'Bearer',
    ...extra,
  };
}

async function authorizeGoogle() {
  const settings = store.loadSettings();
  const clientId = (settings.google.clientId || '').trim();
  const clientSecret = (settings.google.clientSecret || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Add a Google client ID and client secret first. Browse for the OAuth desktop credentials.json, or paste both values.');
  }

  const flow = await beginFlow();
  const state = crypto.randomBytes(24).toString('base64url');
  try {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: flow.redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    await openBrowser(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    const redirected = await waitForRedirect(flow, 180000);
    if (redirected.searchParams.get('state') !== state) {
      throw new Error('Google returned an unexpected sign-in response.');
    }
    const oauthError = redirected.searchParams.get('error');
    if (oauthError) {
      throw new Error(redirected.searchParams.get('error_description') || oauthError);
    }
    const code = redirected.searchParams.get('code');
    if (!code) throw new Error('Google did not return an authorization code.');

    const token = await requestJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: flow.redirectUri,
        grant_type: 'authorization_code',
      },
    });
    const profile = await requestJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      token: token.access_token,
    });
    const email = profile.emailAddress;
    if (!email) throw new Error('Gmail did not return an email address.');
    const account = { provider: 'gmail', email, name: email };
    store.writeToken(account, tokenRecord(token, { provider: 'gmail', email }));
    return store.upsertAccount(account);
  } finally {
    endFlow(flow);
  }
}

async function authorizeOutlook() {
  const settings = store.loadSettings();
  const outlook = settings.outlook || {};
  const clientId = (outlook.clientId || '').trim();
  const clientSecret = (outlook.clientSecret || '').trim();
  const tenant = (outlook.tenant || 'consumers').trim() || 'consumers';
  if (!clientId) {
    throw new Error('Add the Outlook Application (client) ID first.');
  }

  const flow = await beginFlow();
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(40).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  try {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: flow.redirectUri,
      response_mode: 'query',
      scope: OUTLOOK_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    const authorizeUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params}`;
    await openBrowser(authorizeUrl);
    const redirected = await waitForRedirect(flow, 180000);
    if (redirected.searchParams.get('state') !== state) {
      throw new Error('Microsoft returned an unexpected sign-in response.');
    }
    const oauthError = redirected.searchParams.get('error');
    if (oauthError) {
      throw new Error(redirected.searchParams.get('error_description') || oauthError);
    }
    const code = redirected.searchParams.get('code');
    if (!code) throw new Error('Microsoft did not return an authorization code.');

    const form = {
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      scope: OUTLOOK_SCOPES.join(' '),
      code_verifier: verifier,
    };
    if (clientSecret) form.client_secret = clientSecret;
    let token;
    try {
      token = await requestJson(tokenEndpoint(tenant), { method: 'POST', form });
    } catch (error) {
      throw new Error(outlookAuthHint(error.message));
    }
    const profile = await requestJson('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
      token: token.access_token,
    });
    const email = (profile.mail || profile.userPrincipalName || '').trim();
    if (!email) throw new Error('Microsoft Graph did not return an email address.');
    const account = { provider: 'outlook', email, name: profile.displayName || email };
    store.writeToken(account, tokenRecord(token, { provider: 'outlook', email, tenant }));
    return store.upsertAccount(account);
  } finally {
    endFlow(flow);
  }
}

function tokenEndpoint(tenant) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

function outlookAuthHint(message) {
  const text = message || '';
  if (/AADSTS70000|scopes requested are unauthorized/i.test(text)) {
    return `${text}\n\nThis Outlook token was created with fewer permissions (mail read/write). Light Mail now refreshes using those original scopes. Import the tokens folder again if the account still fails, and use the same Outlook client ID as the checker.`;
  }
  if (!/AADSTS70002|client_secret/i.test(text)) return text;
  return `${text}\n\nThis desktop app uses a public client and usually does not need a secret. In Microsoft Entra, add a Mobile and desktop applications platform with redirect URI http://localhost, and enable Allow public client flows.`;
}

async function refreshToken(account, current) {
  const settings = store.loadSettings();
  if (account.provider === 'gmail') {
    const clientId = (current.client_id || settings.google.clientId || '').trim();
    const clientSecret = (current.client_secret || settings.google.clientSecret || '').trim();
    if (!clientId || !clientSecret || !current.refresh_token) {
      throw new Error(`Sign in to ${account.email} again.`);
    }
    const payload = await requestJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: current.refresh_token,
        grant_type: 'refresh_token',
      },
    });
    const next = tokenRecord(payload, {
      provider: 'gmail',
      email: account.email,
      refresh_token: current.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    store.writeToken(account, next);
    return next;
  }

  const clientId = (current.client_id || settings.outlook.clientId || '').trim();
  const clientSecret = (current.client_secret || settings.outlook.clientSecret || '').trim();
  const tenant = current.tenant || settings.outlook.tenant || 'consumers';
  if (!clientId || !current.refresh_token) {
    throw new Error(`Sign in to ${account.email} again. Outlook imports need the same Application (client) ID that created the token.`);
  }
  const form = {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
  };
  const granted = String(current.scope || '').trim();
  if (granted) form.scope = granted;
  if (clientSecret) form.client_secret = clientSecret;
  let payload;
  try {
    payload = await requestJson(tokenEndpoint(tenant), { method: 'POST', form });
  } catch (error) {
    throw new Error(outlookAuthHint(error.message));
  }
  const next = tokenRecord(payload, {
    provider: 'outlook',
    email: account.email,
    tenant,
    refresh_token: payload.refresh_token || current.refresh_token,
    client_id: clientId,
    scope: payload.scope || granted,
  });
  if (clientSecret) next.client_secret = clientSecret;
  store.writeToken(account, next);
  return next;
}

async function getAccessToken(account, force = false) {
  const existing = refreshLocks.get(account.id);
  if (existing) return existing;
  const job = (async () => {
    let token = store.readToken(account);
    if (!token || !token.access_token) {
      throw new Error(`${account.email} is not signed in. Remove it and add it again.`);
    }
    const fresh = !force && Number(token.expires_at || 0) > Date.now() + 60000;
    if (!fresh) token = await refreshToken(account, token);
    return token.access_token;
  })().finally(() => refreshLocks.delete(account.id));
  refreshLocks.set(account.id, job);
  return job;
}

async function withToken(account, fn) {
  const token = await getAccessToken(account, false);
  try {
    return await fn(token);
  } catch (error) {
    if (error.status !== 401) throw error;
    const refreshed = await getAccessToken(account, true);
    return fn(refreshed);
  }
}

module.exports = {
  GMAIL_SCOPES,
  OUTLOOK_SCOPES,
  authorizeGoogle,
  authorizeOutlook,
  cancelAuth,
  getAccessToken,
  withToken,
};
