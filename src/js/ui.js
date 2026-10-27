'use strict';

function hideKey(accountId, calendarId) {
  return `${accountId}|${calendarId}`;
}

function visibleCalAccounts() {
  return state.accounts.filter((account) => !state.hiddenCalAccounts.has(account.id));
}

function rememberCalendar(accountId, data, replace) {
  const coverage = data.coverage || {};
  const start = Number(coverage.start) || 0;
  const end = Number(coverage.end) || 0;
  const events = (data.events || []).map((event) => ({ ...event, accountId }));
  const calendars = (data.calendars || []).map((calendar) => ({ ...calendar, accountId }));
  let entry = calStores.get(accountId);
  if (!entry || replace) {
    entry = { start, end, events, calendars, at: Date.now() };
  } else if (start && end && entry.end && start <= entry.end && end >= entry.start) {
    const seen = new Set(entry.events.map((event) => `${event.calendarId}:${event.id}`));
    for (const event of events) {
      if (!seen.has(`${event.calendarId}:${event.id}`)) entry.events.push(event);
    }
    entry.start = Math.min(entry.start, start);
    entry.end = Math.max(entry.end, end);
    entry.calendars = calendars;
    entry.at = Date.now();
  } else {
    entry = { start, end, events, calendars, at: Date.now() };
  }
  calStores.set(accountId, entry);
  if (!state.seenCalAccounts.has(accountId)) {
    state.seenCalAccounts.add(accountId);
    for (const calendar of calendars) {
      if (calendar.selected === false) state.hiddenCalendars.add(hideKey(accountId, calendar.id));
    }
    saveUi();
  }
  return entry;
}

function publishCalendar() {
  const accounts = visibleCalAccounts();
  const calendars = [];
  const events = [];
  for (const account of accounts) {
    const entry = calStores.get(account.id);
    if (!entry) continue;
    calendars.push(...entry.calendars);
    events.push(...entry.events);
  }
  state.calendars = calendars;
  state.events = events;
}

function forgetCalendarAccount(accountId) {
  calStores.delete(accountId);
  state.hiddenCalAccounts.delete(accountId);
  state.seenCalAccounts.delete(accountId);
  for (const key of [...state.hiddenCalendars]) {
    if (key.startsWith(`${accountId}|`)) state.hiddenCalendars.delete(key);
  }
  publishCalendar();
  saveUi();
}

function calendarWriteAccount() {
  const visible = visibleCalAccounts();
  return visible.find((account) => account.id === state.accountId) || visible[0] || null;
}

function listCacheKey(accountId, folderId, tag, query, unread) {
  const scope = unread ? 'unread' : (folderId || '');
  return `${accountId}|${scope}|${tag || ''}|${query || ''}|${unread ? 'unread' : ''}`;
}

function favKey(accountId, folderId) {
  return `${accountId}|${folderId}`;
}

function parseFavKey(key) {
  const text = String(key || '');
  const sep = text.indexOf('|');
  if (sep <= 0) return null;
  return { accountId: text.slice(0, sep), folderId: text.slice(sep + 1) };
}

function unreadMode() {
  return state.module !== 'calendar' && state.mailMode === 'new';
}

function rememberList(key, messages, nextPage) {
  listCache.delete(key);
  listCache.set(key, { messages, nextPage: nextPage || null, complete: !nextPage });
  while (listCache.size > 40) {
    let victim = null;
    for (const item of listCache.keys()) {
      if (item === key || item.endsWith('|unread')) continue;
      victim = item;
      break;
    }
    if (!victim) break;
    listCache.delete(victim);
  }
}

function collectUnread(accountId, query) {
  const needle = String(query || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const [key, entry] of listCache) {
    if (!key.startsWith(`${accountId}|`) || !entry || !Array.isArray(entry.messages)) continue;
    for (const message of entry.messages) {
      if (!message || !message.id || !message.unread || message.removed || seen.has(message.id)) continue;
      if (state.justRead.has(`${accountId}|${message.id}`)) continue;
      if (needle) {
        const hay = `${message.subject || ''} ${message.snippet || ''} ${(message.from && (message.from.name || message.from.email)) || ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      seen.add(message.id);
      out.push({ ...message, accountId: message.accountId || accountId });
    }
  }
  out.sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
  return out;
}

function mergeUnreadLists(local, remote, accountId) {
  const seen = new Set();
  const out = [];
  for (const message of [...(local || []), ...(remote || [])]) {
    if (!message || !message.id || !message.unread || message.removed || seen.has(message.id)) continue;
    if (state.justRead.has(`${accountId}|${message.id}`)) continue;
    seen.add(message.id);
    out.push({ ...message, accountId: message.accountId || accountId });
  }
  out.sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
  return out;
}

function rememberMessage(accountId, message) {
  if (!message || !message.id) return;
  const key = `${accountId}|${message.id}`;
  messageCache.delete(key);
  messageCache.set(key, message);
  while (messageCache.size > 40) messageCache.delete(messageCache.keys().next().value);
}

function dropListCache(accountId) {
  for (const key of [...listCache.keys()]) {
    if (key.startsWith(`${accountId}|`)) listCache.delete(key);
  }
  folderCache.delete(accountId);
}

function rememberFolders(accountId, folders, tags) {
  folderCache.set(accountId, { folders: folders || [], tags: tags || [] });
}


function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function icon(name) {
  const file = String(name || 'folder').replace(/[^a-zA-Z0-9]/g, '') || 'folder';
  const src = `icons/${file}.png`;
  return `<span class="icon" style="-webkit-mask-image:url('${src}');mask-image:url('${src}')" aria-hidden="true"></span>`;
}

function folderIcon(kind) {
  return {
    inbox: 'inbox', sent: 'send', drafts: 'draft', junk: 'junk', trash: 'trash',
    archive: 'archive', flagged: 'star', custom: 'folder',
  }[kind] || 'folder';
}

function hue(text) {
  let hash = 0;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function initials(person) {
  const source = (person && (person.name || person.email)) || '?';
  const parts = source.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  const letters = ((parts[0] && parts[0][0]) || '?') + ((parts[1] && parts[1][0]) || '');
  return letters.toUpperCase().slice(0, 2);
}

function avatar(person, small) {
  const key = (person && (person.email || person.name)) || '?';
  return `<span class="avatar${small ? ' sm' : ''}" style="background:hsl(${hue(key)} 42% 38%)">${esc(initials(person))}</span>`;
}

function mailTime(iso) {
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time) || time < 630720000000) return null;
  return date;
}

function mailStamp(iso) {
  const date = mailTime(iso);
  return date ? date.getTime() : 0;
}

function sortMail(list) {
  const rows = list || state.messages;
  rows.sort((a, b) => mailStamp(b.date) - mailStamp(a.date) || String(a.id || '').localeCompare(String(b.id || '')));
  return rows;
}

function formatWhen(iso) {
  const date = mailTime(iso);
  if (!date) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatFull(iso) {
  const date = mailTime(iso);
  if (!date) return '';
  return date.toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function formatSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPerson(person) {
  if (!person || !person.email) return '';
  return person.name ? `${person.name} <${person.email}>` : person.email;
}

function formatPeople(list) {
  return (list || []).map(formatPerson).filter(Boolean).join(', ');
}

function peopleLine(list) {
  const text = (list || []).map((person) => person.name || person.email).filter(Boolean).join(', ');
  return text || '—';
}

function currentAccount() {
  return state.accounts.find((account) => account.id === state.accountId) || null;
}

function currentFolder() {
  return state.folders.find((folder) => folder.id === state.folderId) || null;
}

function targetIds() {
  if (state.selected.size) return [...state.selected];
  if (state.activeId) return [state.activeId];
  return [];
}

function ownerId(messageId, accountId) {
  if (accountId) return accountId;
  const message = state.messages.find((item) => item.id === messageId);
  return (message && message.accountId) || state.accountId;
}

function groupsFor(ids) {
  const groups = new Map();
  for (const id of ids) {
    const accountId = ownerId(id);
    if (!groups.has(accountId)) groups.set(accountId, []);
    groups.get(accountId).push(id);
  }
  return groups;
}

function foldersOf(accountId) {
  if (accountId === state.accountId && state.folders.length) return state.folders;
  const stored = folderCache.get(accountId);
  return (stored && stored.folders) || [];
}

function showProgress(on) {
  progressCount += on ? 1 : -1;
  if (progressCount < 0) progressCount = 0;
  document.getElementById('progress').hidden = progressCount === 0;
}

function toast(message) {
  if (!message) return;
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4600);
}

function paintUpdated() {
  const el = document.getElementById('updated-at');
  if (!el) return;
  if (!state.updatedAt) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const time = new Date(state.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.hidden = false;
  el.textContent = `Updated at ${time}`;
}

function markUpdated() {
  state.updatedAt = Date.now();
  paintUpdated();
}

async function call(fn) {
  const result = await fn();
  if (!result || !result.ok) throw new Error((result && result.error) || 'Something went wrong.');
  return result.data;
}

function paintWindowState(maximized) {
  const on = Boolean(maximized);
  document.body.classList.toggle('win-max', on);
  const btn = document.getElementById('win-max');
  if (!btn) return;
  btn.title = on ? 'Restore' : 'Maximize';
  btn.setAttribute('aria-label', on ? 'Restore' : 'Maximize');
  btn.innerHTML = on
    ? '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 3.4h5.1v5.1H3z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 6.2V2h4.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>'
    : '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
}

function syncChrome() {
  document.body.classList.toggle('checking', state.selected.size > 0);
  document.body.classList.toggle('no-account', !state.accountId);
  document.body.classList.toggle('module-calendar', state.module === 'calendar');
  const calendar = document.getElementById('calendar-root');
  if (calendar) calendar.hidden = state.module !== 'calendar';
  const mailTab = document.getElementById('tab-mail');
  const calTab = document.getElementById('tab-calendar');
  if (mailTab) mailTab.classList.toggle('on', state.module !== 'calendar');
  if (calTab) calTab.classList.toggle('on', state.module === 'calendar');
  const search = document.getElementById('search');
  if (search) search.disabled = !state.accountId;
}

function applyWidths() {
  document.documentElement.style.setProperty('--nav-w', `${state.navWidth}px`);
  document.documentElement.style.setProperty('--list-w', `${state.listWidth}px`);
}

function saveUi() {
  clearTimeout(saveUi.timer);
  saveUi.timer = setTimeout(() => {
    api.saveUi({
      accountId: state.accountId,
      folderId: state.folderId,
      navWidth: Math.round(state.navWidth),
      listWidth: Math.round(state.listWidth),
      module: state.module,
      calView: state.calView,
      hiddenCalAccounts: [...state.hiddenCalAccounts],
      hiddenCalendars: [...state.hiddenCalendars],
      seenCalAccounts: [...state.seenCalAccounts],
      mailMode: state.mailMode === 'new' ? 'new' : 'original',
      favoriteFolders: [...state.favoriteFolders],
      collapsedAccounts: [...state.collapsed],
      pollSeconds: state.pollSeconds,
      theme: currentTheme(),
    });
  }, 250);
}
