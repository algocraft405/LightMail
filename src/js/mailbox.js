'use strict';

function clearSearch(reload) {
  clearTimeout(state.searchTimer);
  state.query = '';
  if (state.module === 'calendar') {
    if (reload) loadMessages();
    return;
  }
  const input = document.getElementById('search');
  if (input && input.value) input.value = '';
  if (reload) loadMessages();
}


function appendUnique(incoming) {
  const seen = new Set(state.messages.map((message) => `${message.accountId || ''}|${message.id}`));
  const extra = (incoming || []).filter((message) => message && message.id && !state.justRead.has(`${message.accountId || ''}|${message.id}`) && !seen.has(`${message.accountId || ''}|${message.id}`));
  if (!extra.length) return;
  state.messages = state.messages.concat(extra);
  sortMail();
}

function takeBatch(messages, nextPage) {
  const list = sortMail((messages || []).slice());
  if (list.length <= FIRST_BATCH) {
    state.heldTail = [];
    state.heldNext = null;
    return { messages: list, nextPage: nextPage || null };
  }
  state.heldTail = list.slice(FIRST_BATCH);
  state.heldNext = nextPage || null;
  return { messages: list.slice(0, FIRST_BATCH), nextPage: 'tail' };
}

function drainTail() {
  if (state.nextPage !== 'tail' || !state.heldTail.length) return null;
  const chunk = state.heldTail.splice(0, 30);
  state.nextPage = state.heldTail.length ? 'tail' : (state.heldNext || null);
  appendUnique(chunk);
  return chunk;
}

function fillIfShort(gen) {
  if (gen !== state.listGen || !state.nextPage) return;
  requestAnimationFrame(() => {
    if (gen !== state.listGen || state.syncingList || state.loadingList || !lowRunway()) return;
    fillAhead(gen, false, 1);
  });
}

async function appendFolderPage(fresh) {
  const key = listCacheKey(state.accountId, state.folderId, state.tagFilter, state.query, false);
  if (drainTail()) {
    rememberList(key, state.messages.concat(state.heldTail), state.heldTail.length ? state.heldNext : state.nextPage);
    return;
  }
  const token = state.nextPage;
  const data = await call(() => api.listMessages(state.accountId, state.folderId, {
    pageToken: token,
    query: state.query,
    tag: state.tagFilter,
    fresh: Boolean(fresh),
  }));
  appendUnique((data.messages || []).map((message) => ({ ...message, accountId: state.accountId })));
  state.nextPage = data.nextPage && data.nextPage !== token ? data.nextPage : null;
  rememberList(key, state.messages, state.nextPage);
}

async function appendUnreadPage(fresh) {
  if (drainTail()) return;
  const accounts = newMailAccounts().filter((account) => state.unreadPages[account.id]);
  if (!accounts.length) {
    state.nextPage = null;
    return;
  }
  const chunks = await Promise.all(accounts.map(async (account) => {
    const token = state.unreadPages[account.id];
    try {
      const loaded = await fetchUnread(account, token, fresh);
      return { account, ...loaded, token };
    } catch {
      return { account, messages: [], nextPage: null, token };
    }
  }));
  appendUnique(chunks.flatMap((chunk) => chunk.messages));
  state.messages.sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
  for (const chunk of chunks) {
    state.unreadPages[chunk.account.id] = chunk.nextPage && chunk.nextPage !== chunk.token ? chunk.nextPage : null;
  }
  state.nextPage = Object.values(state.unreadPages).some(Boolean) ? 'more' : null;
}

function appendListRows(messages) {
  const pane = document.getElementById('list-pane');
  if (!pane || !messages.length) return;
  const unread = unreadMode();
  const last = [...pane.querySelectorAll('.mail-row')].pop();
  let lastGroup = last ? last.getAttribute('data-group') || '' : '';
  const html = sortMail(messages.slice()).map((message) => {
    const group = mailDateGroup(message.date);
    const divider = group.key !== lastGroup ? dateDivider(group.label) : '';
    lastGroup = group.key;
    return divider + mailRow(message, unread, group.key);
  }).join('');
  const more = pane.querySelector('.list-more');
  const top = pane.scrollTop;
  if (more) more.insertAdjacentHTML('beforebegin', html);
  else pane.insertAdjacentHTML('beforeend', html);
  const head = pane.querySelector('.list-head span');
  if (head && state.selected.size <= 1) {
    head.textContent = `${state.messages.length}${state.nextPage ? '+' : ''} messages`;
  }
  if (more && !state.nextPage) more.remove();
  if (pane.scrollTop !== top) pane.scrollTop = top;
}

async function fillAhead(gen, fresh, pages) {
  if (!pages || !state.nextPage || state.syncingList || gen !== state.listGen) return;
  state.syncingList = true;
  let addedTotal = 0;
  try {
    let count = 0;
    while (state.nextPage && gen === state.listGen && count < pages) {
      count += 1;
      const before = state.messages.length;
      if (unreadMode()) await appendUnreadPage(fresh);
      else await appendFolderPage(fresh);
      if (gen !== state.listGen) return;
      const added = state.messages.slice(before);
      addedTotal += added.length;
      if (added.length) {
        sortMail();
        renderList();
      }
    }
  } catch (error) {
    if (gen === state.listGen) toast(error.message);
  } finally {
    if (gen === state.listGen) {
      state.syncingList = false;
      if (addedTotal > 0 && state.nextPage && lowRunway()) fillAhead(gen, false, SCROLL_PAGES);
    }
  }
}

function lowRunway() {
  const pane = document.getElementById('list-pane');
  if (!pane) return false;
  const remaining = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
  return remaining < Math.max(RUNWAY_PX, pane.clientHeight * 5);
}

function aheadPages() {
  return 0;
}

async function loadMessages(options = {}) {
  if (unreadMode()) return loadUnread(options);
  if (!state.accountId || !state.folderId) {
    state.messages = [];
    state.nextPage = null;
    state.loadingList = false;
    state.syncingList = false;
    renderList();
    return;
  }
  const gen = ++state.listGen;
  state.syncingList = false;
  const append = Boolean(options.append);
  const key = listCacheKey(state.accountId, state.folderId, state.tagFilter, state.query, false);
  if (options.fresh && !append && state.messages.length && !state.query && !state.tagFilter) {
    showProgress(true);
    try {
      const data = await call(() => api.listMessages(state.accountId, state.folderId, { fresh: true, head: true }));
      if (gen !== state.listGen) return;
      const incoming = (data.messages || []).map((message) => ({ ...message, accountId: state.accountId }));
      const merged = mergeFreshPage(incoming);
      rememberList(key, state.messages, state.nextPage);
      if (state.active && state.activeId) {
        const row = state.messages.find((message) => message.id === state.activeId);
        if (row) state.active.removed = Boolean(row.removed);
      }
      syncLists(incoming);
      markUpdated();
      if (merged.added || merged.changed) showArrivals(merged.added > 0);
      else renderList();
    } catch (error) {
      if (gen === state.listGen) toast(error.message);
    } finally {
      showProgress(false);
      if (gen === state.listGen) {
        state.loadingList = false;
        renderCommands();
        fillIfShort(gen);
      }
    }
    return;
  }
  const cached = !append && !options.fresh ? listCache.get(key) : null;
  if (cached) {
    const shown = takeBatch(cached.messages, cached.nextPage);
    state.messages = shown.messages;
    state.nextPage = shown.nextPage;
    state.loadingList = false;
    renderList();
    renderCommands();
    fillIfShort(gen);
    return;
  }
  if (append && !state.nextPage) return;
  state.loadingList = !append && !state.messages.length;
  if (!append) renderList();
  showProgress(true);
  try {
    const data = await call(() => api.listMessages(state.accountId, state.folderId, {
      pageToken: append ? state.nextPage : null,
      query: state.query,
      tag: state.tagFilter,
      fresh: Boolean(options.fresh),
    }));
    if (gen !== state.listGen) return;
    const incoming = (data.messages || []).map((message) => ({ ...message, accountId: state.accountId }));
    if (append) {
      const seen = new Set(state.messages.map((message) => message.id));
      state.messages = state.messages.concat(incoming.filter((message) => message.id && !seen.has(message.id)));
      state.nextPage = data.nextPage || null;
    } else {
      const shown = takeBatch(incoming, data.nextPage);
      state.messages = shown.messages;
      state.nextPage = shown.nextPage;
      if (!options.fresh) state.selected.clear();
      rememberList(key, state.messages.concat(state.heldTail), state.heldTail.length ? state.heldNext : state.nextPage);
      if (options.fresh && state.active && state.activeId) {
        const row = state.messages.find((message) => message.id === state.activeId);
        if (row) state.active.removed = Boolean(row.removed);
      }
    }
    if (!append) markUpdated();
  } catch (error) {
    if (gen !== state.listGen) return;
    if (!append && !state.messages.length) {
      state.messages = [];
      state.nextPage = null;
    }
    toast(error.message);
  } finally {
    showProgress(false);
    if (gen === state.listGen) {
      state.loadingList = false;
      syncLists(state.messages);
      renderList();
      renderCommands();
      fillIfShort(gen);
    }
  }
}

function newMailAccounts() {
  if (state.newMailAccountId) return state.accounts.filter((account) => account.id === state.newMailAccountId);
  return state.accounts;
}

function unreadCacheKey(accountId) {
  return listCacheKey(accountId, '', '', state.query, true);
}

function unreadFromLocal(accounts) {
  state.unreadPages = {};
  const all = [];
  for (const account of accounts) {
    const cached = listCache.get(unreadCacheKey(account.id));
    state.unreadPages[account.id] = (cached && cached.nextPage) || null;
    all.push(...mergeUnreadLists(collectUnread(account.id, state.query), (cached && cached.messages) || [], account.id));
  }
  all.sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
  const more = Object.values(state.unreadPages).some(Boolean) ? 'more' : null;
  const shown = takeBatch(all, more);
  state.messages = shown.messages;
  state.nextPage = shown.nextPage;
  state.loadingList = false;
  state.syncingList = false;
}

function unreadCachesReady(accounts) {
  return accounts.every((account) => listCache.has(unreadCacheKey(account.id)));
}

async function fetchUnread(account, pageToken, fresh) {
  const key = unreadCacheKey(account.id);
  const local = collectUnread(account.id, state.query);
  if (!pageToken && !fresh) {
    const cached = listCache.get(key);
    if (cached) {
      return {
        messages: mergeUnreadLists(local, cached.messages, account.id),
        nextPage: cached.nextPage || null,
      };
    }
    if (local.length) return { messages: local, nextPage: null };
  }
  const data = await call(() => api.listMessages(account.id, '', {
    pageToken: pageToken || null,
    query: state.query,
    unread: true,
    fresh: Boolean(fresh),
    head: Boolean(fresh && !pageToken),
  }));
  const remote = (data.messages || []).map((message) => ({ ...message, accountId: account.id }));
  const messages = pageToken ? remote : mergeUnreadLists(local, remote, account.id);
  if (!pageToken) rememberList(key, messages, data.nextPage);
  return { messages, nextPage: data.nextPage || null };
}

async function loadUnread(options = {}) {
  const accounts = newMailAccounts();
  if (!accounts.length) {
    state.messages = [];
    state.nextPage = null;
    state.loadingList = false;
    state.syncingList = false;
    renderList();
    return;
  }
  const gen = ++state.listGen;
  const append = Boolean(options.append);
  const fresh = Boolean(options.fresh);
  if (!append && !fresh) {
    unreadFromLocal(accounts);
    state.selected.clear();
    renderList();
    renderNav();
    renderCommands();
    if (unreadCachesReady(accounts) || state.messages.length) {
      if (state.nextPage === 'tail') fillIfShort(gen);
      return;
    }
  }
  if (fresh && !append && state.messages.length && !state.query) {
    showProgress(true);
    const errors = [];
    try {
      const chunks = await Promise.all(accounts.map(async (account) => {
        try {
          return (await fetchUnread(account, null, true)).messages;
        } catch (error) {
          errors.push(`${account.email}: ${error.message}`);
          return [];
        }
      }));
      if (gen !== state.listGen) return;
      const incoming = chunks.flat();
      const merged = mergeFreshPage(incoming);
      if (merged.added) state.messages.sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
      syncLists(incoming);
      markUpdated();
      if (merged.added || merged.changed) showArrivals(merged.added > 0);
      else renderList();
      if (errors.length && !incoming.length) toast(errors[0]);
    } catch (error) {
      if (gen === state.listGen) toast(error.message);
    } finally {
      showProgress(false);
      if (gen === state.listGen) {
        state.loadingList = false;
        state.syncingList = false;
        renderCommands();
        fillIfShort(gen);
      }
    }
    return;
  }
  if (append && !state.nextPage) return;
  state.syncingList = false;
  state.loadingList = !append && !state.messages.length;
  if (!append) {
    unreadFromLocal(accounts);
    state.selected.clear();
    if (!state.messages.length) state.loadingList = true;
    renderList();
  }
  showProgress(true);
  const errors = [];
  try {
    const chunks = await Promise.all(accounts.map(async (account) => {
      const pageToken = append ? (state.unreadPages[account.id] || null) : null;
      if (append && !pageToken) return { account, messages: [], nextPage: state.unreadPages[account.id] || null, skip: true };
      try {
        const loaded = await fetchUnread(account, pageToken, fresh);
        return { account, ...loaded, skip: false };
      } catch (error) {
        errors.push(`${account.email}: ${error.message}`);
        return { account, messages: [], nextPage: null, skip: false };
      }
    }));
    if (gen !== state.listGen) return;
    for (const chunk of chunks) {
      if (!chunk.skip) state.unreadPages[chunk.account.id] = chunk.nextPage;
    }
    const moreRemote = Object.values(state.unreadPages).some(Boolean) ? 'more' : null;
    if (append) {
      const seen = new Set(state.messages.map((message) => `${message.accountId}|${message.id}`));
      const extra = chunks.flatMap((chunk) => chunk.messages).filter((message) => !seen.has(`${message.accountId}|${message.id}`));
      state.messages = state.messages.concat(extra);
      state.messages.sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
      state.nextPage = moreRemote;
    } else {
      const all = accounts.flatMap((account) => {
        const chunk = chunks.find((item) => item.account.id === account.id);
        return mergeUnreadLists(collectUnread(account.id, state.query), (chunk && chunk.messages) || [], account.id);
      });
      all.sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
      const shown = takeBatch(all, moreRemote);
      state.messages = shown.messages;
      state.nextPage = shown.nextPage;
      markUpdated();
    }
    if (errors.length && !state.messages.length) toast(errors[0]);
  } catch (error) {
    if (gen !== state.listGen) return;
    toast(error.message);
  } finally {
    showProgress(false);
    if (gen === state.listGen) {
      state.loadingList = false;
      state.syncingList = false;
      syncLists(state.messages);
      renderList();
      renderCommands();
      fillIfShort(gen);
    }
  }
}

async function selectNewMailAccount(accountId) {
  releaseHeldUnread();
  const next = accountId && accountId !== state.newMailAccountId ? accountId : null;
  state.newMailAccountId = next;
  state.selected.clear();
  state.active = null;
  state.activeId = null;
  const list = document.getElementById('list-pane');
  if (list) list.scrollTop = 0;
  renderNav();
  renderReader();
  await loadUnread();
}

async function openMessage(id, event, accountId) {
  const ids = state.messages.map((message) => message.id);
  if (event && event.shiftKey && state.anchorId) {
    const start = ids.indexOf(state.anchorId);
    const end = ids.indexOf(id);
    if (start >= 0 && end >= 0) {
      const [from, to] = start < end ? [start, end] : [end, start];
      state.selected = new Set(ids.slice(from, to + 1));
    }
    renderList();
    renderCommands();
    return;
  }
  if (event && (event.ctrlKey || event.metaKey)) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    state.anchorId = id;
    renderList();
    renderCommands();
    return;
  }
  const owner = ownerId(id, accountId);
  state.selected = new Set([id]);
  state.anchorId = id;
  state.activeId = id;
  if (unreadMode()) {
    releaseHeldUnread({ id, accountId: owner });
    const row = state.messages.find((item) => item.id === id && (item.accountId || owner) === owner);
    if (row && row.unread) state.heldUnread = { id, accountId: owner };
  }
  renderList();
  renderCommands();
  await readMessage(id, {}, accountId);
}

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  state.anchorId = id;
  renderList();
  renderCommands();
}

function previewMessage(row, id, owner) {
  const source = row || {};
  return {
    ...source,
    id,
    accountId: owner,
    from: source.from || { name: '', email: '' },
    to: source.to || [],
    cc: source.cc || [],
    subject: source.subject || '(no subject)',
    bodyHtml: null,
    bodyText: source.snippet || '',
    attachments: [],
    preview: true,
  };
}

function releaseHeldUnread(next) {
  const held = state.heldUnread;
  if (!held) return;
  if (next && next.id === held.id && (next.accountId || '') === (held.accountId || '')) return;
  state.heldUnread = null;
  finishUnread(held.accountId, held.id);
}

function finishUnread(accountId, id) {
  const key = `${accountId || ''}|${id}`;
  state.justRead.add(key);
  const pane = document.getElementById('list-pane');
  let anchorId = '';
  let anchorAccount = '';
  let delta = 0;
  if (pane) {
    const rows = [...pane.querySelectorAll('.mail-row')];
    let anchor = rows.find((row) => row.offsetTop + row.offsetHeight > pane.scrollTop + 52);
    if (anchor && anchor.getAttribute('data-id') === id && anchor.getAttribute('data-account') === accountId) {
      const index = rows.indexOf(anchor);
      anchor = rows[index + 1] || rows[index - 1] || null;
    }
    if (anchor) {
      anchorId = anchor.getAttribute('data-id') || '';
      anchorAccount = anchor.getAttribute('data-account') || '';
      delta = pane.scrollTop - anchor.offsetTop;
    }
  }
  const row = state.messages.find((item) => item.id === id && (item.accountId || accountId) === accountId);
  if (row) row.unread = false;
  syncLists([{ ...(row || { id }), id, accountId, unread: false, removed: false }]);
  const folder = row && row.folderId ? foldersOf(accountId).find((item) => item.id === row.folderId) : null;
  if (folder && folder.unread > 0) folder.unread -= 1;
  state.messages = state.messages.filter((item) => `${item.accountId || ''}|${item.id}` !== key);
  const cacheKey = listCacheKey(accountId, '', '', state.query, true);
  const cached = listCache.get(cacheKey);
  if (cached) rememberList(cacheKey, (cached.messages || []).filter((item) => item.id !== id), cached.nextPage);
  if (state.active && state.active.id === id) state.active.unread = false;
  api.setRead(accountId, [id], true).then((result) => {
    if (result && !result.ok) toast(result.error);
  });
  renderList();
  renderNav();
  if (anchorId && pane) {
    const next = [...pane.querySelectorAll('.mail-row')].find((item) => item.getAttribute('data-id') === anchorId && item.getAttribute('data-account') === anchorAccount);
    if (next) pane.scrollTop = next.offsetTop + delta;
  }
}

function openedMessage(message, id, owner) {
  const row = state.messages.find((item) => item.id === id && (item.accountId || owner) === owner);
  if (unreadMode()) {
    const wasUnread = Boolean((row && row.unread) || message.unread);
    state.heldUnread = wasUnread ? { id, accountId: owner } : null;
    if (row) {
      row.subject = message.subject || row.subject;
      row.from = message.from || row.from;
      row.date = message.date || row.date;
      row.snippet = message.snippet || row.snippet;
      row.tags = message.tags || row.tags;
      row.flagged = message.flagged;
      row.pinned = message.pinned;
      row.hasAttachments = message.hasAttachments;
      row.unread = wasUnread;
    }
    return;
  }
  if (message.unread) {
    message.unread = false;
    if (row) row.unread = false;
    state.justRead.add(`${owner}|${id}`);
    syncLists([{ ...(row || message), id, accountId: owner, unread: false, removed: false }]);
    const folder = currentFolder();
    if (folder && folder.unread > 0) folder.unread -= 1;
    api.setRead(owner, [id], true).then((result) => {
      if (result && !result.ok) toast(result.error);
    });
    renderNav();
  }
  if (row) {
    row.subject = message.subject || row.subject;
    row.from = message.from || row.from;
    row.date = message.date || row.date;
    row.snippet = message.snippet || row.snippet;
    row.tags = message.tags || row.tags;
    row.flagged = message.flagged;
    row.pinned = message.pinned;
    row.hasAttachments = message.hasAttachments;
    row.unread = message.unread;
  }
}

async function readMessage(id, options = {}, accountId) {
  const owner = ownerId(id, accountId);
  const gen = ++state.msgGen;
  const cacheKey = `${owner}|${id}`;
  const cached = options.fresh ? null : messageCache.get(cacheKey);
  const row = state.messages.find((item) => item.id === id && (!accountId || item.accountId === accountId || item.accountId === owner));
  state.activeId = id;
  if (cached && !cached.preview && (cached.bodyHtml != null || cached.bodyText != null)) {
    state.active = cached;
    state.loadingMessage = false;
    renderReader();
    openedMessage(cached, id, owner);
    return;
  }
  const previewTimer = setTimeout(() => {
    if (gen !== state.msgGen) return;
    state.active = previewMessage(row, id, owner);
    state.loadingMessage = false;
    renderReader();
  }, 120);
  try {
    const message = await call(() => api.getMessage(owner, id, { fresh: Boolean(options.fresh) }));
    if (gen !== state.msgGen) return;
    rememberMessage(owner, message);
    message.accountId = owner;
    state.active = message;
    openedMessage(message, id, owner);
  } catch (error) {
    if (gen !== state.msgGen) return;
    state.active = { ...(state.active || previewMessage(row, id, owner)), error: error.message, preview: false };
  } finally {
    clearTimeout(previewTimer);
    if (gen === state.msgGen) {
      state.loadingMessage = false;
      renderReader();
      renderList();
    }
  }
}

function noteFailures(result) {
  if (result && result.failed && result.failed.length) {
    toast(result.failed[0].error || 'Some messages could not be updated.');
  }
}

async function refreshFolders(fresh) {
  if (!state.accountId) return;
  try {
    const [folders, tags] = await Promise.all([
      call(() => api.listFolders(state.accountId, { fresh: Boolean(fresh) })),
      call(() => api.listTags(state.accountId, { fresh: Boolean(fresh) })),
    ]);
    state.folders = folders || [];
    state.tags = tags || [];
    rememberFolders(state.accountId, state.folders, state.tags);
    renderNav();
    renderCommands();
  } catch {
    // Keep the folders already on screen.
  }
}

async function reloadAfterChange(updated, accountIds) {
  if (!updated || !updated.length) return;
  const keep = state.activeId;
  for (const accountId of accountIds && accountIds.length ? accountIds : [state.accountId]) dropListCache(accountId);
  await loadMessages({ fresh: true });
  refreshFolders(true);
  if (keep && !state.messages.some((message) => message.id === keep)) {
    state.activeId = null;
    state.active = null;
    state.selected.clear();
    renderReader();
  }
}

async function markRead(read) {
  const ids = targetIds();
  if (!ids.length) return;
  const groups = [...groupsFor(ids)];
  for (const id of ids) {
    const row = state.messages.find((message) => message.id === id);
    if (row) row.unread = !read;
    if (state.active && state.active.id === id) state.active.unread = !read;
    const accountId = (row && row.accountId) || ownerId(id);
    const key = `${accountId || ''}|${id}`;
    if (read) state.justRead.add(key);
    else state.justRead.delete(key);
    bumpFolderUnread(accountId, row, read ? -1 : 1);
  }
  syncLists(ids.map((id) => {
    const row = state.messages.find((message) => message.id === id) || { id };
    return { ...row, id, accountId: (row && row.accountId) || ownerId(id), unread: !read };
  }));
  if (unreadMode() && read) {
    const gone = new Set(ids);
    state.messages = state.messages.filter((message) => !gone.has(message.id));
    if (state.heldUnread && gone.has(state.heldUnread.id)) state.heldUnread = null;
    for (const [accountId, group] of groups) {
      const cacheKey = listCacheKey(accountId, '', '', state.query, true);
      const cached = listCache.get(cacheKey);
      if (cached) rememberList(cacheKey, (cached.messages || []).filter((message) => !group.includes(message.id)), cached.nextPage);
    }
  }
  renderList();
  renderReader();
  renderNav();
  for (const [accountId, group] of groups) {
    call(() => api.setRead(accountId, group, read)).then((result) => {
      noteFailures(result);
    }).catch((error) => toast(error.message));
  }
}

function bumpFolderUnread(accountId, message, delta) {
  if (!accountId || !delta) return;
  const folders = foldersOf(accountId);
  if (!folders.length) return;
  const folder = (message && message.folderId && folders.find((item) => item.id === message.folderId))
    || folders.find((item) => item.kind === 'inbox');
  if (!folder || folder.kind === 'drafts' || folder.kind === 'sent') return;
  folder.unread = Math.max(0, (Number(folder.unread) || 0) + delta);
  const cached = folderCache.get(accountId);
  rememberFolders(accountId, folders, cached ? cached.tags : (accountId === state.accountId ? state.tags : []));
  if (accountId === state.accountId) state.folders = folders;
}

async function togglePin(ids) {
  const clean = (ids || []).filter(Boolean);
  if (!clean.length) return;
  const rows = state.messages.filter((message) => clean.includes(message.id));
  const pinned = !(rows.length && rows.every((message) => message.pinned));
  const updated = [];
  for (const [accountId, group] of groupsFor(clean)) {
    const result = await call(() => api.setPinned(accountId, group, pinned));
    noteFailures(result);
    updated.push(...(result.updated || []));
  }
  for (const id of updated) {
    const row = state.messages.find((message) => message.id === id);
    if (row) row.pinned = pinned;
    if (state.active && state.active.id === id) state.active.pinned = pinned;
  }
  syncLists(updated.map((id) => {
    const row = state.messages.find((message) => message.id === id) || { id };
    return { ...row, id, accountId: (row && row.accountId) || ownerId(id), pinned };
  }));
  renderList();
  renderCommands();
}

async function toggleFlag() {
  const ids = targetIds();
  if (!ids.length) return;
  const rows = state.messages.filter((message) => ids.includes(message.id));
  const flagged = !(rows.length && rows.every((message) => message.flagged));
  const updated = [];
  for (const [accountId, group] of groupsFor(ids)) {
    const result = await call(() => api.setFlag(accountId, group, flagged));
    noteFailures(result);
    updated.push(...(result.updated || []));
  }
  for (const id of updated) {
    const row = state.messages.find((message) => message.id === id);
    if (row) row.flagged = flagged;
    if (state.active && state.active.id === id) state.active.flagged = flagged;
  }
  syncLists(updated.map((id) => {
    const row = state.messages.find((message) => message.id === id) || { id };
    return { ...row, id, accountId: (row && row.accountId) || ownerId(id), flagged };
  }));
  renderList();
  renderCommands();
}

async function removeSelected() {
  const ids = targetIds();
  if (!ids.length) return;
  const permanent = currentFolder() && currentFolder().kind === 'trash';
  if (permanent) {
    const yes = await confirmDialog(`Delete ${ids.length} message${ids.length === 1 ? '' : 's'} permanently? This cannot be undone.`, 'Delete permanently');
    if (!yes) return;
  }
  showProgress(true);
  try {
    const updated = [];
    const accountIds = [];
    for (const [accountId, group] of groupsFor(ids)) {
      const result = await call(() => api.removeMessages(accountId, group, {
        permanent,
        folderId: state.folderId,
      }));
      noteFailures(result);
      updated.push(...(result.updated || []));
      accountIds.push(accountId);
    }
    await reloadAfterChange(updated, accountIds);
  } finally {
    showProgress(false);
  }
}

async function moveTo(folderId) {
  const ids = targetIds();
  if (!ids.length || !folderId) return;
  const groups = [...groupsFor(ids)];
  if (groups.length !== 1 || groups[0][0] !== state.accountId) {
    toast('Select mail from the open account to move it.');
    return;
  }
  state.menu = null;
  showProgress(true);
  try {
    const result = await call(() => api.moveMessages(state.accountId, groups[0][1], folderId, state.folderId));
    noteFailures(result);
    await reloadAfterChange(result.updated, [state.accountId]);
  } finally {
    showProgress(false);
  }
}

async function archiveSelected() {
  const ids = targetIds();
  if (!ids.length) return;
  showProgress(true);
  try {
    const updated = [];
    const accountIds = [];
    for (const [accountId, group] of groupsFor(ids)) {
      const result = await call(() => api.archiveMessages(accountId, group));
      noteFailures(result);
      updated.push(...(result.updated || []));
      accountIds.push(accountId);
    }
    await reloadAfterChange(updated, accountIds);
  } finally {
    showProgress(false);
  }
}

async function toggleTag(name) {
  const ids = targetIds();
  if (!ids.length || !name) return;
  state.menu = null;
  const rows = ids.map((id) => state.messages.find((message) => message.id === id)).filter(Boolean);
  const allHave = rows.length === ids.length && rows.every((message) => message.tags.some((tag) => tag.name === name));
  showProgress(true);
  try {
    for (const id of ids) {
      const row = state.messages.find((message) => message.id === id) || (state.active && state.active.id === id ? state.active : null);
      const names = new Set(((row && row.tags) || []).map((tag) => tag.name));
      if (allHave) names.delete(name);
      else names.add(name);
      const updated = await call(() => api.setTags(ownerId(id), id, [...names]));
      const index = state.messages.findIndex((message) => message.id === id);
      if (index >= 0) state.messages[index] = { ...state.messages[index], ...updated };
      if (state.active && state.active.id === id) state.active = updated;
    }
    renderList();
    renderReader();
    renderCommands();
  } finally {
    showProgress(false);
  }
}

async function removeTag(name) {
  if (!state.active || !name) return;
  const names = state.active.tags.map((tag) => tag.name).filter((tag) => tag !== name);
  const updated = await call(() => api.setTags(ownerId(state.active.id), state.active.id, names));
  const index = state.messages.findIndex((message) => message.id === updated.id);
  if (index >= 0) state.messages[index] = { ...state.messages[index], ...updated };
  state.active = updated;
  renderList();
  renderReader();
}
