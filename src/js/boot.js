'use strict';

document.addEventListener('change', (event) => {
  const el = event.target;
  if (!el || !el.dataset) return;
  if (el.dataset.action === 'toggle-calendar') toggleCalendar(el.dataset.id, el.dataset.account, el.checked);
  if (el.dataset.action === 'toggle-cal-account') toggleCalAccount(el.dataset.id, el.checked);
  if (el.dataset.action === 'event-account') switchEventAccount();
  if (el.dataset.action === 'toggle-all-day') toggleAllDay();
});

document.addEventListener('click', (event) => {
  if (skipClick) {
    skipClick = false;
    if (event.target.closest('.fav-row')) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
  if (unreadMode() && state.heldUnread) {
    const held = state.heldUnread;
    const row = event.target.closest('.mail-row');
    const onHeld = row && row.getAttribute('data-id') === held.id && row.getAttribute('data-account') === held.accountId;
    const actionEl = event.target.closest('[data-action]');
    const opening = actionEl && actionEl.dataset.action === 'open-message';
    const reading = event.target.closest('#reader, #commands, .dialog, .backdrop');
    if (!onHeld && !opening && !reading) releaseHeldUnread();
  }
  if (!event.target.closest('#folder-menu')) closeFolderMenu();
  const el = event.target.closest('[data-action]');
  if (el && el.getAttribute('type') === 'submit') return;
  if (!el) {
    if (state.menu && !event.target.closest('.popover')) {
      state.menu = null;
      renderCommands();
    }
    return;
  }
  if (el.dataset.action !== 'toggle-menu' && state.menu && !el.closest('.popover') && el.dataset.action !== 'move' && el.dataset.action !== 'toggle-tag') {
    state.menu = null;
  }
  handleAction(el, event).catch((error) => {
    if (!/cancelled/i.test(error.message || '')) toast(error.message);
  });
});

document.addEventListener('submit', (event) => {
  const submit = event.target.querySelector('[type="submit"][data-action]');
  if (!submit) return;
  event.preventDefault();
  handleAction(submit, event).catch((error) => toast(error.message));
});

document.addEventListener('keydown', (event) => {
  const typing = event.target.closest('input, textarea, [contenteditable="true"]');
  if (event.key === 'Escape') {
    if (!document.getElementById('auth-overlay').hidden) {
      api.cancelAuth();
      return;
    }
    if (state.modal) {
      closeModal(false);
      return;
    }
    if (state.menu) {
      state.menu = null;
      renderCommands();
    }
    return;
  }
  if (state.modal === 'compose' && event.ctrlKey && event.key === 'Enter') {
    event.preventDefault();
    sendCompose().catch((error) => toast(error.message));
    return;
  }
  if (typing || state.modal) return;
  if (state.module === 'calendar') {
    if (event.ctrlKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openEventEditor(null);
    } else if (event.ctrlKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      document.getElementById('search').focus();
    }
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    openCompose('new').catch((error) => toast(error.message));
  } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    openCompose('replyAll').catch((error) => toast(error.message));
  } else if (event.ctrlKey && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    openCompose('reply').catch((error) => toast(error.message));
  } else if (event.ctrlKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openCompose('forward').catch((error) => toast(error.message));
  } else if (event.ctrlKey && event.key.toLowerCase() === 'u') {
    event.preventDefault();
    markRead(false).catch((error) => toast(error.message));
  } else if (event.ctrlKey && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    document.getElementById('search').focus();
  } else if (event.key === 'Delete') {
    event.preventDefault();
    removeSelected().catch((error) => toast(error.message));
  }
});

document.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('.folder-row');
  if (!row || state.module === 'calendar' || state.mailMode === 'new') return;
  event.preventDefault();
  showFolderMenu(row.dataset.id, row.dataset.account, event.clientX, event.clientY);
});

document.getElementById('list-pane').addEventListener('scroll', () => {
  if (state.module === 'calendar' || !state.nextPage || state.syncingList || state.loadingList) return;
  if (!lowRunway()) return;
  fillAhead(state.listGen, false, SCROLL_PAGES);
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'theme-color') {
    rememberTheme({ id: 'custom', color: event.target.value });
    paintThemePicks();
    return;
  }
  if (event.target.id !== 'poll-seconds') return;
  state.pollSeconds = pollChoice(event.target.value);
  if (state.settings) state.settings.ui = { ...(state.settings.ui || {}), pollSeconds: state.pollSeconds };
  saveUi();
  startMailPoll();
  const seconds = state.pollSeconds;
  toast(seconds ? `Checking for new mail every ${seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? '' : 's'}`}.` : 'New mail checks are off.');
});

window.addEventListener('focus', () => {
  pollNewMail().catch(() => {});
});

document.getElementById('search').addEventListener('input', () => {
  const value = document.getElementById('search').value.trim();
  if (state.module === 'calendar') {
    state.calQuery = value;
    renderCalendar();
    return;
  }
  state.query = value;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.selected.clear();
    loadMessages();
  }, 320);
});

document.addEventListener('mousedown', (event) => {
  const splitter = event.target.closest('.splitter');
  if (splitter) {
    drag = {
      kind: splitter.dataset.split,
      startX: event.clientX,
      nav: state.navWidth,
      list: state.listWidth,
    };
    document.body.classList.add('dragging');
    return;
  }
  const fav = event.target.closest('.fav-row');
  if (!fav || event.button !== 0 || event.target.closest('.fav-btn')) return;
  drag = {
    kind: 'favorite',
    key: favKey(fav.getAttribute('data-account'), fav.getAttribute('data-id')),
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    place: null,
    targetKey: null,
  };
});

document.addEventListener('mousemove', (event) => {
  if (!drag) return;
  if (drag.kind === 'favorite') {
    moveFavoriteDrag(event);
    return;
  }
  const delta = event.clientX - drag.startX;
  if (drag.kind === 'nav') state.navWidth = Math.min(460, Math.max(200, drag.nav + delta));
  else state.listWidth = Math.min(680, Math.max(280, drag.list + delta));
  applyWidths();
});

window.addEventListener('resize', () => {
  if (state.module === 'calendar') syncCalendarScrollbar();
});

document.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.kind === 'favorite') {
    const moved = drag.moved;
    const fromKey = drag.key;
    const toKey = drag.targetKey;
    const place = drag.place;
    clearFavDragUi();
    drag = null;
    if (moved) skipClick = true;
    if (moved && fromKey && toKey) reorderFavorite(fromKey, toKey, place);
    return;
  }
  drag = null;
  document.body.classList.remove('dragging');
  saveUi();
});

if (!api) {
  document.body.innerHTML = '<p style="padding:24px">Open Light Mail with <code>npm start</code>.</p>';
  console.error('UI missing bridge');
} else {
  console.log('UI ready');
  if (api.onWindowState) {
    api.onWindowState((data) => paintWindowState(data && data.maximized));
    call(() => api.windowState()).then((data) => paintWindowState(data && data.maximized)).catch(() => {});
  }
  const titlebar = document.querySelector('.titlebar');
  if (titlebar) {
    titlebar.addEventListener('dblclick', (event) => {
      if (event.target.closest('.search-box, button, input')) return;
      call(() => api.windowAction('max')).then((data) => paintWindowState(data && data.maximized)).catch(() => {});
    });
  }
  boot().catch((error) => {
    toast(error.message);
    console.error(error);
  });
}
