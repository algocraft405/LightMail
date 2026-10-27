'use strict';

async function boot(options = {}) {
  badgesReady = false;
  const data = await call(() => api.getState());
  state.settings = data.settings;
  state.accounts = data.accounts || [];
  state.navWidth = Number(data.settings.ui.navWidth) || 268;
  state.listWidth = Number(data.settings.ui.listWidth) || 392;
  state.calView = data.settings.ui.calView || 'month';
  if (Array.isArray(data.settings.ui.hiddenCalAccounts)) {
    state.hiddenCalAccounts = new Set(data.settings.ui.hiddenCalAccounts);
  }
  if (Array.isArray(data.settings.ui.hiddenCalendars)) {
    state.hiddenCalendars = new Set(data.settings.ui.hiddenCalendars);
  }
  if (Array.isArray(data.settings.ui.seenCalAccounts)) {
    state.seenCalAccounts = new Set(data.settings.ui.seenCalAccounts);
  }
  state.mailMode = data.settings.ui.mailMode === 'new' ? 'new' : 'original';
  state.pollSeconds = pollChoice(data.settings.ui.pollSeconds);
  if (Array.isArray(data.settings.ui.favoriteFolders)) {
    state.favoriteFolders = new Set(data.settings.ui.favoriteFolders);
  }
  if (Array.isArray(data.settings.ui.collapsedAccounts)) {
    state.collapsed = new Set(data.settings.ui.collapsedAccounts);
  }
  if (options.folderId === undefined && data.settings.ui.module === 'calendar') {
    state.module = 'calendar';
  }
  if (state.module === 'calendar') document.getElementById('search').placeholder = 'Search events';
  else if (state.mailMode === 'new') document.getElementById('search').placeholder = 'Search unread mail';
  applyWidths();
  await applyTheme();
  const prefer = options.prefer || data.settings.ui.accountId;
  const account = state.accounts.find((item) => item.id === prefer) || state.accounts[0];
  renderCommands();
  if (!account) {
    state.accountId = null;
    state.folderId = null;
    state.folders = [];
    state.tags = [];
    state.messages = [];
    state.active = null;
    state.activeId = null;
    renderNav();
    renderList();
    renderReader();
    syncChrome();
    if (state.module === 'calendar') renderCalendar();
    if (!options.silentEmpty) openAccounts();
    startMailPoll();
    return;
  }
  const folderId = options.folderId !== undefined
    ? options.folderId
    : (account.id === data.settings.ui.accountId ? data.settings.ui.folderId : null);
  syncChrome();
  startMailPoll();
  await selectAccount(account.id, folderId);
}

async function selectAccount(accountId, folderId) {
  const gen = ++state.accountGen;
  state.listGen += 1;
  state.msgGen += 1;
  state.accountId = accountId;
  state.tagFilter = null;
  state.selected.clear();
  state.active = null;
  state.activeId = null;
  state.loadingMessage = false;
  clearSearch(false);
  const remembered = folderCache.get(accountId);
  const hintedFolder = remembered
    ? ((remembered.folders.find((folder) => folder.id === folderId) || remembered.folders.find((folder) => folder.kind === 'inbox') || remembered.folders[0] || {}).id || null)
    : null;
  const listed = unreadMode()
    ? listCache.get(listCacheKey(accountId, '', '', '', true))
    : (hintedFolder ? listCache.get(listCacheKey(accountId, hintedFolder, '', '')) : null);
  state.folderId = hintedFolder;
  state.folders = remembered ? remembered.folders : [];
  state.tags = remembered ? remembered.tags : [];
  state.messages = listed ? listed.messages : [];
  state.nextPage = listed ? listed.nextPage : null;
  state.loadingList = !listed;
  renderCommands();
  renderNav();
  renderList();
  renderReader();
  try {
    const calendarTask = state.module === 'calendar' ? loadCalendar() : null;
    const [folders, tags] = await Promise.all([
      call(() => api.listFolders(accountId)),
      call(() => api.listTags(accountId)),
    ]);
    if (gen !== state.accountGen) return;
    state.folders = folders || [];
    state.tags = tags || [];
    rememberFolders(accountId, state.folders, state.tags);
    const wanted = state.folders.find((folder) => folder.id === folderId);
    const inbox = state.folders.find((folder) => folder.kind === 'inbox');
    state.folderId = (wanted || inbox || state.folders[0] || {}).id || null;
    renderNav();
    renderCommands();
    if (!state.folderId) {
      state.loadingList = false;
      renderList();
      toast('This account has no mail folders.');
      if (calendarTask) await calendarTask;
      return;
    }
    saveUi();
    loadOtherFolders().catch(() => {});
    await Promise.all([loadMessages(), calendarTask || Promise.resolve()]);
    markUpdated();
  } catch (error) {
    if (gen !== state.accountGen) return;
    state.loadingList = false;
    renderList();
    toast(error.message);
  }
}

async function loadOtherFolders() {
  for (const account of state.accounts) {
    if (folderCache.has(account.id)) continue;
    try {
      const [folders, tags] = await Promise.all([
        call(() => api.listFolders(account.id)),
        call(() => api.listTags(account.id)),
      ]);
      rememberFolders(account.id, folders || [], tags || []);
    } catch {
      // This account's folders stay hidden until the next refresh.
    }
  }
  if (state.module !== 'calendar') renderNav();
}

async function selectFolder(folderId, accountId) {
  const owner = accountId || state.accountId;
  if (owner && owner !== state.accountId) {
    await selectAccount(owner, folderId);
    return;
  }
  if (folderId === state.folderId && !state.tagFilter && !state.query) {
    await loadMessages();
    return;
  }
  state.folderId = folderId;
  state.tagFilter = null;
  state.selected.clear();
  state.active = null;
  state.activeId = null;
  clearSearch(false);
  const list = document.getElementById('list-pane');
  if (list) list.scrollTop = 0;
  renderNav();
  renderReader();
  renderCommands();
  saveUi();
  await loadMessages();
}
