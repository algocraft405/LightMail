'use strict';

function pollChoice(value) {
  const seconds = Number(value);
  if (seconds === 0) return 0;
  return POLL_CHOICES.includes(seconds) ? seconds : 60;
}

function pollIntervalMs() {
  const seconds = pollChoice(state.pollSeconds);
  return seconds > 0 ? seconds * 1000 : 0;
}

function startMailPoll() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  const ms = pollIntervalMs();
  if (!ms) return;
  state.pollTimer = setInterval(() => {
    pollNewMail({ scheduled: true }).catch(() => {});
  }, ms);
}

function messageKey(message) {
  return `${message.accountId || ''}|${message.id}`;
}

function mergeFreshPage(incoming) {
  const index = new Map(state.messages.map((message, at) => [messageKey(message), at]));
  const extra = [];
  let changed = false;
  let leading = true;
  for (const message of incoming || []) {
    if (!message || !message.id) continue;
    const key = messageKey(message);
    if (state.justRead.has(key)) continue;
    const at = index.get(key);
    if (at == null) {
      if (leading) {
        extra.push(message);
        index.set(key, -1);
      }
      continue;
    }
    leading = false;
    const current = state.messages[at];
    if (current.unread !== message.unread || current.flagged !== message.flagged || current.pinned !== message.pinned || current.removed !== message.removed || current.subject !== message.subject) {
      state.messages[at] = { ...current, ...message, accountId: current.accountId || message.accountId };
      changed = true;
    }
  }
  if (extra.length) state.messages = extra.concat(state.messages);
  if (extra.length || changed) sortMail();
  return { added: extra.length, changed };
}

function prependCached(key, incoming) {
  const cached = listCache.get(key);
  if (!cached || !Array.isArray(cached.messages)) return 0;
  const index = new Map(cached.messages.map((message, at) => [messageKey(message), at]));
  const extra = [];
  let changed = false;
  let leading = true;
  for (const message of incoming || []) {
    if (!message || !message.id || state.justRead.has(messageKey(message))) continue;
    const id = messageKey(message);
    const at = index.get(id);
    if (at == null) {
      if (leading) {
        extra.push(message);
        index.set(id, -1);
      }
      continue;
    }
    leading = false;
    const current = cached.messages[at];
    if (current.unread !== message.unread || current.flagged !== message.flagged || current.pinned !== message.pinned || current.removed !== message.removed || current.subject !== message.subject) {
      cached.messages[at] = { ...current, ...message, accountId: current.accountId || message.accountId };
      changed = true;
    }
  }
  if (!extra.length && !changed) return 0;
  rememberList(key, extra.concat(cached.messages), cached.nextPage);
  return extra.length;
}

function statusChanged(current, message) {
  return current.unread !== message.unread || current.flagged !== message.flagged || current.pinned !== message.pinned || current.removed !== message.removed || current.subject !== message.subject;
}

function syncLists(messages, options) {
  const incoming = (messages || []).filter((message) => message && message.id && !(state.justRead.has(messageKey(message)) && message.unread));
  if (!incoming.length) return false;
  let countsChanged = false;
  const byAccount = new Map();
  for (const message of incoming) {
    const accountId = message.accountId || '';
    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId).push(message);
  }
  const unreadKeys = new Set();
  for (const [key, entry] of [...listCache.entries()]) {
    const accountId = key.slice(0, key.indexOf('|'));
    const batch = byAccount.get(accountId);
    if (!batch || !entry || !Array.isArray(entry.messages)) continue;
    const unreadCache = key.endsWith('|unread');
    if (unreadCache) unreadKeys.add(accountId);
    const index = new Map(entry.messages.map((message, at) => [message.id, at]));
    let changed = false;
    const next = entry.messages.slice();
    for (const message of batch) {
      const at = index.get(message.id);
      if (at == null) continue;
      if (statusChanged(next[at], message)) {
        next[at] = { ...next[at], ...message, accountId: next[at].accountId || message.accountId };
        changed = true;
      }
    }
    let kept = next;
    if (unreadCache) {
      const filtered = kept.filter((message) => message.unread && !message.removed);
      if (filtered.length !== kept.length) changed = true;
      const extras = batch.filter((message) => message.unread && !message.removed && message.id && !filtered.some((item) => item.id === message.id));
      if (extras.length) changed = true;
      kept = extras.length ? extras.concat(filtered) : filtered;
    }
    if (changed) {
      rememberList(key, kept, entry.nextPage);
      if (unreadCache) countsChanged = true;
    }
  }
  for (const [accountId, batch] of byAccount) {
    const extras = batch.filter((message) => message.unread && !message.removed && message.id);
    if (!extras.length) continue;
    if (unreadKeys.has(accountId)) continue;
    rememberList(listCacheKey(accountId, '', '', '', true), mergeUnreadLists(collectUnread(accountId), extras, accountId), null);
    countsChanged = true;
  }
  if (state.module === 'calendar') return false;
  let visibleChanged = false;
  let readerChanged = false;
  const index = new Map(state.messages.map((message, at) => [messageKey(message), at]));
  const fresh = new Map(incoming.map((message) => [messageKey(message), message]));
  for (const message of incoming) {
    const at = index.get(messageKey(message));
    if (at != null && statusChanged(state.messages[at], message)) {
      state.messages[at] = { ...state.messages[at], ...message, accountId: state.messages[at].accountId || message.accountId };
      visibleChanged = true;
    }
    if (state.active && state.active.id === message.id && (state.active.accountId || '') === (message.accountId || '')) {
      if (state.active.unread !== message.unread || state.active.flagged !== message.flagged || state.active.removed !== message.removed) {
        state.active = { ...state.active, unread: message.unread, flagged: message.flagged, removed: Boolean(message.removed), subject: message.subject || state.active.subject };
        readerChanged = true;
      }
    }
  }
  if (unreadMode()) {
    const before = state.messages.length;
    const allowed = new Set(newMailAccounts().map((account) => account.id));
    state.messages = state.messages.filter((message) => {
      const next = fresh.get(messageKey(message));
      if (!next) return true;
      return next.unread && !next.removed;
    });
    const extras = incoming.filter((message) => (
      message.unread && !message.removed && allowed.has(message.accountId) && !index.has(messageKey(message))
    ));
    if (extras.length) {
      state.messages = extras.concat(state.messages);
      sortMail();
      visibleChanged = true;
    }
    if (state.messages.length !== before) visibleChanged = true;
  }
  if (visibleChanged) renderList();
  if (readerChanged) renderReader();
  if (countsChanged || (unreadMode() && visibleChanged)) renderNav();
  return visibleChanged;
}

function showArrivals(stickToTop) {
  const pane = document.getElementById('list-pane');
  const atTop = stickToTop && (!pane || pane.scrollTop < 48);
  renderList();
  if (atTop && pane) pane.scrollTop = 0;
}

function inboxUnreadTotal() {
  let total = 0;
  for (const account of state.accounts) {
    const inbox = foldersOf(account.id).find((folder) => folder.kind === 'inbox');
    total += inbox ? Number(inbox.unread) || 0 : 0;
  }
  return total;
}

function pollAccounts() {
  if (unreadMode()) return newMailAccounts();
  const current = state.accounts.find((account) => account.id === state.accountId);
  return current ? [current] : [];
}

async function refreshFolderBadges() {
  let changed = false;
  await Promise.all(pollAccounts().map(async (account) => {
    try {
      const folders = await call(() => api.listFolders(account.id, { fresh: true }));
      const next = folders || [];
      const stamp = (list) => list.map((folder) => `${folder.id}:${folder.unread || 0}`).join(',');
      if (stamp(foldersOf(account.id)) !== stamp(next)) changed = true;
      const cached = folderCache.get(account.id);
      const tags = cached ? cached.tags : (account.id === state.accountId ? state.tags : []);
      rememberFolders(account.id, next, tags);
      if (account.id === state.accountId) state.folders = next;
    } catch {
      // Keep the badges already on screen.
    }
  }));
  if (changed) renderNav();
}

async function fetchInboxPages() {
  if (unreadMode()) return [];
  const account = state.accounts.find((item) => item.id === state.accountId);
  if (!account || !state.folderId) return [];
  try {
    const data = await call(() => api.listMessages(account.id, state.folderId, { fresh: true, head: true }));
    return [{
      account,
      folderId: state.folderId,
      messages: (data.messages || []).map((message) => ({ ...message, accountId: account.id })),
    }];
  } catch {
    return [{ account, folderId: state.folderId, messages: [] }];
  }
}

function applyInboxPages(pages, gen) {
  if (gen !== state.listGen || state.loadingList) return 0;
  let added = 0;
  let visibleChanged = false;
  for (const page of pages) {
    const visible = state.module !== 'calendar' && !unreadMode() && !state.query && !state.tagFilter
      && page.account.id === state.accountId && page.folderId === state.folderId;
    if (!visible) {
      added += prependCached(listCacheKey(page.account.id, page.folderId, '', '', false), page.messages);
      continue;
    }
    const merged = mergeFreshPage(page.messages);
    added += merged.added;
    if (merged.added || merged.changed) {
      visibleChanged = true;
      rememberList(listCacheKey(page.account.id, page.folderId, '', '', false), state.messages, state.nextPage);
    }
  }
  if (visibleChanged) showArrivals(added > 0);
  syncLists(pages.flatMap((page) => page.messages));
  return added;
}

async function fetchUnreadPages() {
  if (!unreadMode()) return [];
  return Promise.all(newMailAccounts().map(async (account) => {
    try {
      const data = await call(() => api.listMessages(account.id, '', { unread: true, fresh: true, head: true }));
      return {
        account,
        messages: (data.messages || []).map((message) => ({ ...message, accountId: account.id })),
      };
    } catch {
      return { account, messages: [] };
    }
  }));
}

function raiseFolderUnread(accountId, folderId, messages) {
  const unread = (messages || []).filter((message) => message && message.unread && !message.removed && message.id);
  if (!unread.length) return false;
  const folders = foldersOf(accountId);
  if (!folders.length) return false;
  const folder = (folderId && folders.find((item) => item.id === folderId))
    || folders.find((item) => item.kind === 'inbox');
  if (!folder || folder.kind === 'drafts' || folder.kind === 'sent') return false;
  const next = Math.max(Number(folder.unread) || 0, unread.length);
  if (next === (Number(folder.unread) || 0)) return false;
  folder.unread = next;
  const cached = folderCache.get(accountId);
  rememberFolders(accountId, folders, cached ? cached.tags : (accountId === state.accountId ? state.tags : []));
  if (accountId === state.accountId) state.folders = folders;
  return true;
}

function applyFolderBadges(inboxPages, unreadPages) {
  let changed = false;
  for (const page of inboxPages || []) {
    if (raiseFolderUnread(page.account.id, page.folderId, page.messages)) changed = true;
  }
  for (const page of unreadPages || []) {
    const inbox = foldersOf(page.account.id).find((folder) => folder.kind === 'inbox');
    const forInbox = (page.messages || []).filter((message) => {
      if (!inbox) return true;
      return !message.folderId || message.folderId === inbox.id || message.folderId === 'INBOX';
    });
    if (raiseFolderUnread(page.account.id, inbox && inbox.id, forInbox)) changed = true;
  }
  if (syncOpenFolderBadge()) changed = true;
  if (changed) renderNav();
}

function syncOpenFolderBadge() {
  if (unreadMode() || state.module === 'calendar' || !state.accountId || !state.folderId) return false;
  const folders = foldersOf(state.accountId);
  const folder = folders.find((item) => item.id === state.folderId);
  if (!folder || folder.kind === 'drafts' || folder.kind === 'sent') return false;
  const unread = state.messages.filter((message) => message.unread && !message.removed).length;
  if (unread <= (Number(folder.unread) || 0)) return false;
  folder.unread = unread;
  rememberFolders(state.accountId, folders, state.tags);
  if (folders !== state.folders) state.folders = folders;
  return true;
}

function applyUnreadPages(pages, gen) {
  if (gen !== state.listGen || state.loadingList || state.query) return 0;
  const fetched = pages.flatMap((page) => page.messages);
  if (!unreadMode()) {
    let added = 0;
    for (const page of pages) {
      const key = listCacheKey(page.account.id, '', '', '', true);
      const cached = listCache.get(key);
      const before = new Set(((cached && cached.messages) || []).map((message) => message.id));
      added += page.messages.filter((message) => message.unread && !message.removed && message.id && !before.has(message.id)).length;
    }
    syncLists(fetched, { insertUnread: true });
    return added;
  }
  const visibleAccounts = newMailAccounts();
  const visibleIds = new Set(visibleAccounts.map((account) => account.id));
  const merged = mergeFreshPage(fetched.filter((message) => visibleIds.has(message.accountId)));
  if (merged.added) state.messages.sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
  if (merged.added || merged.changed) {
    for (const account of visibleAccounts) {
      const messages = state.messages.filter((message) => message.accountId === account.id);
      const key = listCacheKey(account.id, '', '', '', true);
      const cached = listCache.get(key);
      const nextPage = state.unreadPages[account.id] || (cached && cached.nextPage) || null;
      rememberList(key, messages, nextPage);
    }
    showArrivals(merged.added > 0);
  }
  syncLists(fetched, { insertUnread: true });
  return merged.added;
}

async function pollNewMail(options = {}) {
  if (state.pollBusy || !state.accounts.length || !pollIntervalMs()) return;
  if (!options.scheduled && Date.now() - (state.lastPollAt || 0) < 15000) return;
  if (state.loadingList) return;
  state.pollBusy = true;
  state.lastPollAt = Date.now();
  const gen = state.listGen;
  const unreadBefore = badgesReady ? inboxUnreadTotal() : null;
  try {
    const [inboxPages, unreadPages] = await Promise.all([
      fetchInboxPages(),
      fetchUnreadPages(),
      refreshFolderBadges(),
    ]);
    const unreadGain = unreadBefore == null ? 0 : Math.max(0, inboxUnreadTotal() - unreadBefore);
    badgesReady = true;
    const inboxAdded = applyInboxPages(inboxPages, gen);
    const unreadAdded = applyUnreadPages(unreadPages, gen);
    applyFolderBadges(inboxPages, unreadPages);
    const added = Math.max(inboxAdded, unreadAdded);
    const count = Math.max(added, unreadGain);
    if (count > 0 && gen === state.listGen) toast(count === 1 ? '1 new message' : `${count} new messages`);
    markUpdated();
    if (state.module === 'calendar' && gen === state.listGen) loadCalendar({ force: true }).catch(() => {});
  } catch {
    // The next poll tries again.
  } finally {
    state.pollBusy = false;
  }
}
