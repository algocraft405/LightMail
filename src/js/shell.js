'use strict';

function paint(id, html) {
  const el = document.getElementById(id);
  const scroller = id === 'nav' ? (el.querySelector('.nav-scroll') || el) : el;
  const top = scroller.scrollTop;
  el.innerHTML = html;
  const next = id === 'nav' ? (el.querySelector('.nav-scroll') || el) : el;
  next.scrollTop = top;
}

function paintList(html) {
  const pane = document.getElementById('list-pane');
  const rows = [...pane.querySelectorAll('.mail-row')];
  const anchor = rows.find((row) => row.offsetTop + row.offsetHeight > pane.scrollTop + 52);
  const id = anchor ? anchor.getAttribute('data-id') : '';
  const account = anchor ? anchor.getAttribute('data-account') : '';
  const delta = anchor ? pane.scrollTop - anchor.offsetTop : 0;
  pane.innerHTML = html;
  if (!id) return;
  const next = [...pane.querySelectorAll('.mail-row')].find((row) => row.getAttribute('data-id') === id && row.getAttribute('data-account') === account);
  if (next) pane.scrollTop = next.offsetTop + delta;
}

function renderCommands() {
  if (state.module === 'calendar') {
    renderCalendarCommands();
    return;
  }
  const ids = targetIds();
  const enabled = ids.length > 0;
  const account = currentAccount();
  const moveItems = state.folders
    .filter((folder) => !folder.virtual && folder.kind !== 'flagged' && folder.id !== state.folderId)
    .map((folder) => `<button type="button" class="menu-item" data-action="move" data-id="${esc(folder.id)}">${icon(folderIcon(folder.kind))}<span>${esc(folder.name)}</span></button>`)
    .join('') || '<div class="menu-item">No other folders</div>';
  const selectedRows = state.messages.filter((message) => ids.includes(message.id));
  const tagItems = state.tags.map((tag) => {
    const on = selectedRows.length > 0 && selectedRows.every((message) => message.tags.some((item) => item.name === tag.name));
    return `<button type="button" class="menu-item" data-action="toggle-tag" data-tag="${esc(tag.name)}"><i class="dot" style="background:${esc(tag.color)}"></i><span class="name">${esc(tag.name)}</span>${on ? icon('check') : ''}</button>`;
  }).join('');
  const commands = [
    ribbonGroup([
      button('compose-new', 'New', 'compose', { primary: true, title: 'New mail (Ctrl+N)', always: true }),
    ]),
    ribbonGroup([
      button('remove', 'Delete', 'trash', { title: 'Delete (Del)', enabled }),
      button('archive', 'Archive', 'archive', { enabled }),
    ]),
    ribbonGroup([
      menuButton('move', 'Move', 'folder', moveItems, enabled),
      menuButton('tag', 'Tag', 'tag', `${tagItems}<div class="menu-sep"></div><button type="button" class="menu-item" data-action="new-tag">${icon('plus')} New tag</button>`, enabled && Boolean(account)),
    ]),
    ribbonGroup([
      button('mark-read', 'Read', 'read', { enabled }),
      button('mark-unread', 'Unread', 'unread', { title: 'Mark unread (Ctrl+U)', enabled }),
    ]),
    ribbonGroup([
      button('flag', 'Flag', 'flag', { enabled }),
      button('pin', rowsPinned(ids) ? 'Unpin' : 'Pin', 'pin', { enabled }),
    ]),
    ribbonGroup([
      button('refresh', 'Refresh', 'refresh', { title: 'Refresh', enabled: Boolean(account) }),
    ]),
  ];
  document.getElementById('commands').innerHTML = commands.join('');
  syncChrome();
}

function ribbonGroup(items) {
  return `<div class="ribbon-group">${items.join('')}</div>`;
}

function button(action, label, iconName, opts = {}) {
  const disabled = opts.always || opts.enabled ? '' : 'disabled';
  const klass = opts.primary ? 'cmd primary' : 'cmd';
  return `<button type="button" class="${klass}" data-action="${action}" ${disabled} title="${esc(opts.title || label)}">${icon(iconName)}<span>${esc(label)}</span></button>`;
}

function menuButton(name, label, iconName, items, enabled) {
  const open = state.menu === name;
  return `<div class="menu"><button type="button" class="cmd" data-action="toggle-menu" data-menu="${name}" ${enabled ? '' : 'disabled'}>${icon(iconName)}<span>${esc(label)}</span></button>${open ? `<div class="popover">${items}</div>` : ''}</div>`;
}

function renderNav() {
  if (!state.accounts.length) {
    paint('nav', `<div class="nav-scroll"><div class="welcome"><p>No accounts yet.</p><button type="button" class="cmd primary" data-action="manage-accounts">Add an account</button></div></div><div class="nav-foot"><button type="button" class="text-btn" data-action="open-settings">Settings</button></div>`);
    syncChrome();
    return;
  }
  const original = state.mailMode !== 'new';
  const favorites = original ? favoriteItems().map(favoriteRow).join('') : '';
  const sticky = original
    ? mailModeSwitch()
    : `${mailModeSwitch()}<button type="button" class="folder all-mail${state.newMailAccountId ? '' : ' active'}" data-action="new-mail-account" data-id=""><span class="name">All accounts</span>${countBadge(state.accounts.reduce((sum, account) => sum + accountNewCount(account.id), 0))}</button>`;
  const rest = original
    ? `<div class="nav-label"><span title="Drag to reorder">Favorites</span></div>${favorites || '<div class="hint fav-empty">Star a folder to keep it here.</div>'}`
    : `<p class="hint mail-mode-hint">Click an account for its unread mail. Leave All accounts selected to see every account together.</p>`;
  const blocks = state.accounts.map((account) => accountBlock(account, original)).join('');
  paint('nav', `<div class="nav-sticky">${sticky}</div><div class="nav-scroll">${rest}${blocks}</div><div class="nav-foot"><button type="button" class="text-btn" data-action="manage-accounts">Manage accounts</button><button type="button" class="text-btn" data-action="open-settings">Settings</button></div>`);
  syncChrome();
}

function accountBlock(account, original) {
  const open = original && !state.collapsed.has(account.id);
  const picked = original
    ? account.id === state.accountId
    : account.id === state.newMailAccountId;
  const folders = open ? state.folders && account.id === state.accountId
    ? state.folders.map((folder) => folderRow(folder, account.id, false)).join('')
    : foldersOf(account.id).map((folder) => folderRow(folder, account.id, false)).join('') : '';
  const tags = open && account.id === state.accountId ? state.tags.map((tag) => {
    const active = state.tagFilter === tag.name ? ' active' : '';
    return `<button type="button" class="tag-link${active}" data-action="filter-tag" data-tag="${esc(tag.name)}"><i class="dot" style="background:${esc(tag.color)}"></i><span class="name">${esc(tag.name)}</span></button>`;
  }).join('') : '';
  const lists = !open ? '' : `<div class="nav-label"><span>Folders</span>${account.id === state.accountId ? '<button type="button" class="text-btn" data-action="new-folder">New</button>' : ''}</div>${folders || '<div class="hint" style="padding:0 8px">No folders yet</div>'}
    ${account.id === state.accountId ? `<div class="nav-label"><span>Tags</span><button type="button" class="text-btn" data-action="new-tag">New</button></div>${tags || '<div class="hint" style="padding:0 8px">No tags yet</div>'}` : ''}`;
  const action = original ? 'account' : 'new-mail-account';
  const newBadge = original ? '' : countBadge(accountNewCount(account.id));
  return `<section class="account">
    <button type="button" class="account-head${open ? ' open' : ''}${picked ? ' current' : ''}" data-action="${action}" data-id="${esc(account.id)}">
      ${original ? `<span class="twist">${open ? '▾' : '▸'}</span>` : ''}
      ${avatar({ name: account.name, email: account.email })}
      <span class="account-meta"><strong>${esc(account.name || account.email)}</strong><em>${esc(account.email)}</em></span>
      ${newBadge}
    </button>
    ${lists}
  </section>`;
}

function countBadge(count) {
  const n = Number(count) || 0;
  return n > 0 ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '';
}

function accountNewCount(accountId) {
  return collectUnread(accountId).length;
}

function favoriteItems() {
  const items = [];
  for (const key of state.favoriteFolders) {
    const parsed = parseFavKey(key);
    if (!parsed) continue;
    const account = state.accounts.find((item) => item.id === parsed.accountId);
    if (!account) continue;
    const folder = foldersOf(account.id).find((item) => item.id === parsed.folderId);
    if (folder) items.push({ account, folder });
  }
  return items;
}

function folderBadge(folder) {
  if (!folder || folder.kind === 'drafts' || folder.kind === 'sent') return '';
  const n = Number(folder.unread) || 0;
  return n > 0 ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '';
}

function favoriteRow(item) {
  const { account, folder } = item;
  const active = !unreadMode() && account.id === state.accountId && folder.id === state.folderId && !state.tagFilter;
  const badge = folderBadge(folder);
  return `<div class="folder-row fav-row" data-id="${esc(folder.id)}" data-account="${esc(account.id)}" title="Drag to reorder">
    <button type="button" class="folder${active ? ' active' : ''}" data-action="folder" data-id="${esc(folder.id)}" data-account="${esc(account.id)}">${icon(folderIcon(folder.kind))}<span class="name">${esc(folder.name)}<small>${esc(account.email)}</small></span>${badge}</button>
    <button type="button" class="fav-btn on" data-action="toggle-favorite" data-id="${esc(folder.id)}" data-account="${esc(account.id)}" title="Remove from Favorites">${icon('star')}</button>
  </div>`;
}

function favRowKey(row) {
  return row ? favKey(row.getAttribute('data-account'), row.getAttribute('data-id')) : '';
}

function clearFavDragUi() {
  document.body.classList.remove('dragging-fav');
  document.querySelectorAll('.fav-row.is-dragging, .fav-row.drop-before, .fav-row.drop-after').forEach((row) => {
    row.classList.remove('is-dragging', 'drop-before', 'drop-after');
  });
}

function moveFavoriteDrag(event) {
  const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.moved) {
    if (dist < 6) return;
    drag.moved = true;
    document.body.classList.add('dragging-fav');
    const source = [...document.querySelectorAll('.fav-row')].find((row) => favRowKey(row) === drag.key);
    if (source) source.classList.add('is-dragging');
  }
  event.preventDefault();
  document.querySelectorAll('.fav-row.drop-before, .fav-row.drop-after').forEach((row) => {
    row.classList.remove('drop-before', 'drop-after');
  });
  const over = document.elementFromPoint(event.clientX, event.clientY);
  const row = over && over.closest ? over.closest('.fav-row') : null;
  if (!row || favRowKey(row) === drag.key) {
    drag.place = null;
    drag.targetKey = null;
    return;
  }
  const rect = row.getBoundingClientRect();
  drag.place = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  drag.targetKey = favRowKey(row);
  row.classList.add(drag.place === 'before' ? 'drop-before' : 'drop-after');
}

function reorderFavorite(fromKey, toKey, place) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const order = [...state.favoriteFolders];
  const from = order.indexOf(fromKey);
  if (from < 0 || order.indexOf(toKey) < 0) return;
  order.splice(from, 1);
  const insert = order.indexOf(toKey);
  if (insert < 0) return;
  order.splice(place === 'after' ? insert + 1 : insert, 0, fromKey);
  state.favoriteFolders = new Set(order);
  saveUi();
  renderNav();
}

function mailModeSwitch() {
  return `<div class="seg-group mail-modes" role="group" aria-label="Mail view">
    <button type="button" class="seg${state.mailMode === 'new' ? '' : ' on'}" data-action="mail-mode" data-mode="original">Original</button>
    <button type="button" class="seg${state.mailMode === 'new' ? ' on' : ''}" data-action="mail-mode" data-mode="new">New mail</button>
  </div>`;
}

function folderRow(folder, accountId) {
  const active = !unreadMode() && accountId === state.accountId && folder.id === state.folderId && !state.tagFilter;
  const badge = folderBadge(folder);
  const pinned = state.favoriteFolders.has(favKey(accountId, folder.id));
  const pad = 8 + folder.depth * 14;
  return `<div class="folder-row" data-id="${esc(folder.id)}" data-account="${esc(accountId)}" style="padding-left:${pad}px">
    <button type="button" class="folder${active ? ' active' : ''}" data-action="folder" data-id="${esc(folder.id)}" data-account="${esc(accountId)}">${icon(folderIcon(folder.kind))}<span class="name">${esc(folder.name)}</span>${badge}</button>
    <button type="button" class="fav-btn${pinned ? ' on' : ''}" data-action="toggle-favorite" data-id="${esc(folder.id)}" data-account="${esc(accountId)}" title="${pinned ? 'Remove from Favorites' : 'Add to Favorites'}">${icon('star')}</button>
  </div>`;
}

function toggleFavorite(folderId, accountId) {
  const owner = accountId || state.accountId;
  if (!owner || !folderId) return;
  closeFolderMenu();
  const key = favKey(owner, folderId);
  const folder = foldersOf(owner).find((item) => item.id === folderId);
  const name = folder ? folder.name : 'Folder';
  if (state.favoriteFolders.has(key)) {
    state.favoriteFolders.delete(key);
    toast(`Removed ${name} from Favorites.`);
  } else {
    state.favoriteFolders.add(key);
    toast(`Added ${name} to Favorites.`);
  }
  saveUi();
  renderNav();
}

function showFolderMenu(folderId, accountId, x, y) {
  closeFolderMenu();
  const owner = accountId || state.accountId;
  const pinned = state.favoriteFolders.has(favKey(owner, folderId));
  const menu = document.createElement('div');
  menu.id = 'folder-menu';
  menu.className = 'popover folder-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.innerHTML = `<button type="button" class="menu-item" data-action="toggle-favorite" data-id="${esc(folderId)}" data-account="${esc(owner)}">${pinned ? 'Remove from Favorites' : 'Add to Favorites'}</button>`;
  document.body.appendChild(menu);
}

function closeFolderMenu() {
  const menu = document.getElementById('folder-menu');
  if (menu) menu.remove();
}

async function setMailMode(mode) {
  const next = mode === 'new' ? 'new' : 'original';
  if (next === state.mailMode) return;
  if (next === 'new') {
    const unread = [];
    for (const account of state.accounts) unread.push(...collectUnread(account.id));
    unread.push(...state.messages.filter((message) => message.unread && !message.removed));
    if (unread.length) syncLists(unread);
  }
  releaseHeldUnread();
  state.mailMode = next;
  state.newMailAccountId = null;
  state.tagFilter = null;
  state.selected.clear();
  closeFolderMenu();
  const input = document.getElementById('search');
  if (input && state.module !== 'calendar') {
    input.placeholder = next === 'new' ? 'Search unread mail' : 'Search this folder';
  }
  const list = document.getElementById('list-pane');
  if (list) list.scrollTop = 0;
  renderNav();
  renderCommands();
  saveUi();
  await loadMessages();
}

function rowsPinned(ids) {
  const rows = state.messages.filter((message) => ids.includes(message.id));
  return rows.length > 0 && rows.every((message) => message.pinned);
}

function mailDateGroup(iso) {
  const date = mailTime(iso);
  if (!date) return { key: 'older', label: 'Older' };
  const now = new Date();
  const dayNumber = (value) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((dayNumber(now) - dayNumber(date)) / 86400000);
  if (days <= 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  const key = `${date.getFullYear()}-${date.getMonth()}`;
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return { key: 'this-month', label: 'This month' };
  }
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (date.getFullYear() === last.getFullYear() && date.getMonth() === last.getMonth()) {
    return { key: 'last-month', label: 'Last month' };
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  const label = date.toLocaleDateString([], sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
  return { key, label };
}

function dateDivider(label) {
  return `<div class="date-divider"><span>${esc(label)}</span></div>`;
}

function datedRows(items, unread) {
  const sorted = items.slice().sort((a, b) => mailStamp(b.date) - mailStamp(a.date));
  let last = '';
  let html = '';
  for (const message of sorted) {
    const group = mailDateGroup(message.date);
    if (group.key !== last) {
      html += dateDivider(group.label);
      last = group.key;
    }
    html += mailRow(message, unread, group.key);
  }
  return html;
}

function rowAction(action, title, iconName, message, on) {
  const id = esc(message.id);
  const account = esc(message.accountId || state.accountId || '');
  return `<button type="button" class="row-action${on ? ' on' : ''}" data-action="${action}" data-id="${id}" data-account="${account}" title="${esc(title)}">${icon(iconName)}</button>`;
}

function mailRow(message, unread, groupKey) {
  const classes = ['mail-row'];
  const group = groupKey || mailDateGroup(message.date).key;
  if (message.unread) classes.push('unread');
  if (message.removed) classes.push('removed');
  if (message.pinned) classes.push('pinned');
  if (message.flagged) classes.push('flagged');
  if (state.selected.has(message.id) || state.activeId === message.id) classes.push('selected');
  if (state.selected.has(message.id)) classes.push('checked');
  const chips = (message.tags || []).slice(0, 3).map((tag) => `<span class="chip"><b style="background:${esc(tag.color)}"></b><span>${esc(tag.name)}</span></span>`).join('');
  const where = unread ? messagePlace(message) : '';
  const id = esc(message.id);
  const account = esc(message.accountId || state.accountId || '');
  return `<div class="${classes.join(' ')}" data-action="open-message" data-group="${esc(group)}" data-id="${id}" data-account="${account}" tabindex="0">
    <span class="row-face">
      ${avatar(message.from)}
      <button type="button" class="tick" data-action="select-message" data-id="${id}" aria-label="Select">${icon('check')}</button>
    </span>
    <span class="mail-stack">
      <span class="from">${esc(message.from.name || message.from.email || 'Unknown')}</span>
      <span class="when">${message.hasAttachments ? icon('clip') : ''}${esc(formatWhen(message.date))}</span>
      <span class="subject">${esc(message.subject || '(no subject)')}</span>
      <span class="row-actions">
        ${rowAction('row-read', message.unread ? 'Mark as read' : 'Mark as unread', message.unread ? 'read' : 'unread', message)}
        ${rowAction('row-reply', 'Reply', 'reply', message)}
        ${rowAction('row-reply-all', 'Reply all', 'replyAll', message)}
        ${rowAction('row-forward', 'Forward', 'forward', message)}
        ${rowAction('row-flag', message.flagged ? 'Unflag' : 'Flag', 'flag', message, message.flagged)}
      </span>
      <span class="snippet">${message.removed ? '<b class="removed-tag">Removed</b> ' : ''}${where ? `<b class="where">${esc(where)}</b> ` : ''}${esc(message.snippet || '')}</span>
      ${chips ? `<span class="chips">${chips}</span>` : ''}
    </span>
  </div>`;
}

function groupedRows(unread) {
  return datedRows(state.messages, unread);
}
function renderList() {
  const account = currentAccount();
  if (!account) {
    paint('list-pane', `<div class="welcome"><div class="empty-mark">${icon('mail')}</div><h1>Your mail, in one place</h1><p>Add a Gmail or Outlook account, then read, reply, file, and tag messages the way you do in Outlook.</p><button type="button" class="cmd primary" data-action="manage-accounts">Add an account</button></div>`);
    return;
  }
  const folder = currentFolder();
  const unread = unreadMode();
  const focused = unread ? state.accounts.find((item) => item.id === state.newMailAccountId) : null;
  const title = unread
    ? (focused ? `New mail · ${focused.email}` : 'New mail')
    : `${folder ? folder.name : 'Mail'}${state.tagFilter ? ` · ${state.tagFilter}` : ''}`;
  const count = `${state.messages.length}${state.nextPage ? '+' : ''} messages`;
  const meta = state.selected.size > 1
    ? `${state.selected.size} selected`
    : (state.syncingList ? `${state.messages.length} messages · loading the rest` : (state.loadingList && !state.messages.length ? 'Loading…' : count));
  const rows = groupedRows(unread);
  const status = !rows && state.loadingList
    ? '<div class="list-status">Loading mail…</div>'
    : (!rows ? `<div class="list-status">${state.query || state.tagFilter ? 'No messages match.' : (unread ? 'No unread mail.' : 'No messages in this folder.')}</div>` : '');
  const more = state.nextPage ? `<div class="list-more">${state.syncingList ? 'Loading more mail…' : ''}</div>` : '';
  paintList(`<div class="list-head"><h2>${esc(title)}</h2><span>${esc(meta)}</span></div>${rows}${status}${more}`);
  if (syncOpenFolderBadge()) renderNav();
}

function messageFolderName(message) {
  if (!message || !message.folderId) return '';
  const folder = foldersOf(message.accountId || state.accountId).find((item) => item.id === message.folderId);
  return folder ? folder.name : '';
}

function messagePlace(message) {
  const folder = messageFolderName(message);
  if (state.newMailAccountId) return folder;
  const account = state.accounts.find((item) => item.id === (message.accountId || state.accountId));
  return [account ? account.email : '', folder].filter(Boolean).join(' · ');
}

function renderReader() {
  const el = document.getElementById('reader');
  if (!state.accountId) {
    el.innerHTML = '';
    return;
  }
  if (state.loadingMessage && !state.active) {
    el.innerHTML = '<div class="reader-empty">Loading message…</div>';
    return;
  }
  const message = state.active;
  if (!message) {
    el.innerHTML = `<div class="reader-empty"><div class="empty-mark">${icon('read')}</div><h1>Select a message</h1><p>Replies, flags, and tags show up here.</p></div>`;
    return;
  }
  if (message.error) {
    el.innerHTML = `<div class="reader-empty"><p class="error-text">${esc(message.error)}</p></div>`;
    return;
  }
  const tags = (message.tags || []).map((tag) => `<span class="chip"><b style="background:${esc(tag.color)}"></b><span>${esc(tag.name)}</span><button type="button" data-action="remove-tag" data-tag="${esc(tag.name)}" aria-label="Remove tag">${icon('x')}</button></span>`).join('');
  const files = (message.attachments || []).map((file) => `<button type="button" class="attachment" data-action="download" data-id="${esc(file.id)}" data-name="${esc(file.name)}">${icon('clip')}<span>${esc(file.name)}</span><small>${esc(formatSize(file.size))}</small></button>`).join('');
  el.innerHTML = `<div class="reader-scroll">
    <div class="reader-toolbar">
      <button type="button" class="cmd" data-action="reply" title="Reply (Ctrl+R)">${icon('reply')}<span>Reply</span></button>
      <button type="button" class="cmd" data-action="reply-all" title="Reply all (Ctrl+Shift+R)">${icon('replyAll')}<span>Reply all</span></button>
      <button type="button" class="cmd" data-action="forward" title="Forward (Ctrl+F)">${icon('forward')}<span>Forward</span></button>
      <button type="button" class="cmd" data-action="remove">${icon('trash')}<span>Delete</span></button>
    </div>
    <h1 class="reader-subject">${esc(message.subject || '(no subject)')}</h1>
    ${message.removed ? '<p class="removed-note">This message is no longer in the mailbox. The saved copy stays here.</p>' : ''}
    ${tags ? `<div class="tag-row">${tags}</div>` : ''}
    <div class="reader-from">
      ${avatar(message.from)}
      <div><strong>${esc(message.from.name || message.from.email || 'Unknown')}</strong><div class="muted">${esc(message.from.email || '')}</div><div class="muted">To: ${esc(peopleLine(message.to))}${(message.cc || []).length ? ` · Cc: ${esc(peopleLine(message.cc))}` : ''}</div></div>
      <time class="muted">${esc(formatFull(message.date))}</time>
    </div>
    ${files ? `<div class="attachments">${files}</div>` : ''}
    ${message.preview ? '<p class="body-wait">Loading the full message…</p>' : ''}
    <div id="mail-body"></div>
  </div>`;
  mountBody(document.getElementById('mail-body'), message);
}

function sanitizeHtml(html, allowStyle) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const blocked = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'BASE']);
  if (!allowStyle) blocked.add('STYLE');
  for (const node of [...template.content.querySelectorAll('*')]) {
    if (blocked.has(node.tagName)) {
      node.remove();
      continue;
    }
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on') || name === 'srcdoc') node.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) node.removeAttribute(attr.name);
    }
  }
  return template.innerHTML;
}

function emailDocument(message) {
  const colors = themeColors(currentTheme());
  const dark = hexLuma(colors.bg) < 150;
  const body = message.bodyHtml
    ? sanitizeHtml(message.bodyHtml, true)
    : `<pre>${esc(message.bodyText || '')}</pre>`;
  return `<!DOCTYPE html><html style="color-scheme:${dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:${colors.panel};color:${colors.ink}}
    body{font:14px/1.55 "Segoe UI",sans-serif;overflow-wrap:anywhere}
    img,video{max-width:100%;height:auto} pre{white-space:pre-wrap;font:inherit;margin:0;color:inherit}
    a{color:${colors.accent || '#0f6cbd'}} blockquote{margin:8px 0 8px .4rem;padding-left:12px;border-left:3px solid ${colors.lineStrong};color:${colors.muted}}
  </style></head><body>${body}</body></html>`;
}

function mountBody(container, message) {
  if (!container) return;
  if (message.preview) {
    const note = document.createElement('p');
    note.className = 'preview-body';
    note.textContent = message.snippet || message.bodyText || '';
    container.appendChild(note);
    return;
  }
  const frame = document.createElement('iframe');
  frame.className = 'mail-frame';
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = emailDocument(message);
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    frame.style.height = `${Math.max(doc.body.scrollHeight, 220) + 28}px`;
    doc.addEventListener('click', (event) => {
      const link = event.target.closest && event.target.closest('a');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        event.preventDefault();
        api.openExternal(href);
      }
    });
  });
  container.appendChild(frame);
}
