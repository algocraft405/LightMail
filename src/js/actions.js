'use strict';

async function handleAction(el, event) {
  const action = el.dataset.action;
  if (action === 'open-message') return openMessage(el.getAttribute('data-id'), event, el.getAttribute('data-account'));
  if (action === 'select-message') {
    event.stopPropagation();
    event.preventDefault();
    toggleSelected(el.getAttribute('data-id'));
    return;
  }
  if (action === 'toggle-menu') {
    const name = el.dataset.menu;
    state.menu = state.menu === name ? null : name;
    renderCommands();
    return;
  }
  if (action === 'account') {
    const id = el.getAttribute('data-id');
    if (state.collapsed.has(id)) state.collapsed.delete(id);
    else state.collapsed.add(id);
    saveUi();
    renderNav();
    return;
  }
  if (action === 'new-mail-account') return selectNewMailAccount(el.getAttribute('data-id'));
  if (action === 'folder') return selectFolder(el.getAttribute('data-id'), el.getAttribute('data-account'));
  if (action === 'toggle-favorite') return toggleFavorite(el.getAttribute('data-id'), el.getAttribute('data-account'));
  if (action === 'mail-mode') return setMailMode(el.dataset.mode);
  if (action === 'filter-tag') {
    const tag = el.getAttribute('data-tag');
    state.tagFilter = state.tagFilter === tag ? null : tag;
    state.selected.clear();
    renderNav();
    await loadMessages();
    return;
  }
  if (action === 'compose-new') return openCompose('new');
  if (action === 'reply') return openCompose('reply');
  if (action === 'reply-all') return openCompose('replyAll');
  if (action === 'forward') return openCompose('forward');
  if (action === 'remove') return removeSelected();
  if (action === 'archive') return archiveSelected();
  if (action === 'mark-read') return markRead(true);
  if (action === 'mark-unread') return markRead(false);
  if (action === 'flag') return toggleFlag();
  if (action === 'pin') return togglePin(targetIds());
  if (action === 'pin-message') {
    event.stopPropagation();
    event.preventDefault();
    return togglePin([el.getAttribute('data-id')]);
  }
  if (action === 'row-read' || action === 'row-reply' || action === 'row-reply-all' || action === 'row-forward' || action === 'row-flag') {
    event.stopPropagation();
    event.preventDefault();
    const id = el.getAttribute('data-id');
    if (!id) return;
    const message = state.messages.find((item) => item.id === id) || state.active;
    state.activeId = id;
    if (message) state.active = message;
    state.selected.clear();
    state.selected.add(id);
    if (action === 'row-read') return markRead(Boolean(message && message.unread));
    if (action === 'row-reply') return openCompose('reply');
    if (action === 'row-reply-all') return openCompose('replyAll');
    if (action === 'row-forward') return openCompose('forward');
    return toggleFlag();
  }
  if (action === 'refresh') {
    if (state.module === 'calendar') return loadCalendar({ force: true });
    await Promise.all([refreshFolders(true), loadMessages({ fresh: true })]);
    if (state.active && state.active.removed) renderReader();
    return;
  }
  if (action === 'move') return moveTo(el.getAttribute('data-id'));
  if (action === 'toggle-tag') return toggleTag(el.getAttribute('data-tag'));
  if (action === 'remove-tag') return removeTag(el.getAttribute('data-tag'));
  if (action === 'load-more') return fillAhead(state.listGen, false, SCROLL_PAGES);
  if (action === 'download') {
    const result = await call(() => api.saveAttachment(ownerId(state.activeId), state.activeId, el.getAttribute('data-id')));
    if (result && !result.canceled) toast('Attachment saved.');
    return;
  }
  if (action === 'new-folder') return openFolderModal();
  if (action === 'new-tag') return openTagModal();
  if (action === 'pick-color') {
    state.tagColor = el.dataset.color;
    document.querySelectorAll('[data-action="pick-color"]').forEach((node) => node.classList.toggle('picked', node === el));
    return;
  }
  if (action === 'create-folder-submit') return createFolder();
  if (action === 'create-tag-submit') return createTag();
  if (action === 'manage-accounts') return openAccounts();
  if (action === 'open-settings') return openSettings();
  if (action === 'toggle-settings-help') {
    const body = document.getElementById('settings-help');
    if (!body) return;
    const open = body.hidden;
    body.hidden = !open;
    el.classList.toggle('open', open);
    el.setAttribute('aria-expanded', String(open));
    return;
  }
  if (action === 'win-min') return call(() => api.windowAction('min'));
  if (action === 'win-max') {
    const data = await call(() => api.windowAction('max'));
    paintWindowState(data && data.maximized);
    return;
  }
  if (action === 'win-close') return call(() => api.windowAction('close'));
  if (action === 'clear-data') return clearStoredData(el.dataset.scope);
  if (action === 'export-config') return exportConfig();
  if (action === 'import-config') return importConfig();
  if (action === 'export-database') return exportDatabase();
  if (action === 'import-database') return importDatabase();
  if (action === 'export-backup') return exportBackup();
  if (action === 'import-backup') return importBackup();
  if (action === 'pick-google') return pickGoogle();
  if (action === 'import-tokens') return importTokenFiles(false);
  if (action === 'import-tokens-folder') return importTokenFiles(true);
  if (action === 'add-gmail') return addAccount('gmail');
  if (action === 'add-outlook') return addAccount('outlook');
  if (action === 'remove-account') return removeAccount(el.getAttribute('data-id'));
  if (action === 'set-theme') {
    rememberTheme({ id: el.dataset.id === 'custom' ? 'custom' : el.dataset.id });
    paintThemePicks();
    return;
  }
  if (action === 'pick-wallpaper') return pickWallpaper();
  if (action === 'clear-wallpaper') return clearWallpaper();
  if (action === 'save-settings') {
    await saveProviderSettings();
    toast('Settings saved.');
    return;
  }
  if (action === 'send') return sendCompose();
  if (action === 'toggle-cc') {
    const compose = state.compose;
    compose.to = document.getElementById('compose-to').value;
    compose.subject = document.getElementById('compose-subject').value;
    compose.html = document.getElementById('compose-body').innerHTML;
    compose.showCc = !compose.showCc;
    renderCompose();
    return;
  }
  if (action === 'close-modal' || action === 'confirm-no') {
    const reopenAccounts = state.modal === 'confirm' && state.accounts;
    closeModal(false);
    return reopenAccounts;
  }
  if (action === 'confirm-yes') return closeModal(true);
  if (action === 'cancel-auth') return api.cancelAuth();
  if (action === 'show-mail') return showMail();
  if (action === 'show-calendar') return showCalendar();
  if (action === 'cal-today') return shiftCalendar('today');
  if (action === 'cal-prev') return shiftCalendar(-1);
  if (action === 'cal-next') return shiftCalendar(1);
  if (action === 'cal-view') return setCalView(el.dataset.view);
  if (action === 'cal-day') return pickDay(el.dataset.date);
  if (action === 'cal-mini') return shiftMini(Number(el.dataset.dir));
  if (action === 'open-event') return openEvent(el.getAttribute('data-id'), el.getAttribute('data-calendar'), el.getAttribute('data-account'));
  if (action === 'new-event') return openEventEditor(null, el.dataset.date ? { date: el.dataset.date, hour: el.dataset.hour } : null);
  if (action === 'cal-slot') {
    const column = el.classList.contains('day-col') ? el : el.closest('.day-col');
    let hour = el.dataset.hour;
    if ((hour == null || hour === '') && column) {
      const bounds = column.getBoundingClientRect();
      hour = String(Math.min(23, Math.max(0, Math.floor((event.clientY - bounds.top) / 48))));
    }
    return openEventEditor(null, { date: el.dataset.date, hour: hour || '9' });
  }
  if (action === 'save-event') return saveEventForm();
  if (action === 'delete-event') return deleteEventForm();
}
