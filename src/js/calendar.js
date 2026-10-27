'use strict';

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date, count) {
  const next = new Date(date);
  next.setDate(next.getDate() + count);
  return next;
}

function startOfWeek(date) {
  const next = startOfDay(date);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function shiftKey(key, days) {
  const date = parseKey(key);
  return date ? dateKey(addDays(date, days)) : key;
}

function toLocalInput(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function visibleRange() {
  const cursor = startOfDay(state.cursor || new Date());
  if (state.calView === 'day') return { start: cursor, end: addDays(cursor, 1) };
  if (state.calView === 'week') {
    const start = startOfWeek(cursor);
    return { start, end: addDays(start, 7) };
  }
  const start = startOfWeek(startOfMonth(cursor));
  return { start, end: addDays(start, 42) };
}

function periodTitle() {
  const cursor = state.cursor || new Date();
  if (state.calView === 'day') {
    return cursor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  if (state.calView === 'week') {
    const start = startOfWeek(cursor);
    const end = addDays(start, 6);
    const left = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const right = end.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    return `${left} – ${right}`;
  }
  return cursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function shownEvents() {
  const query = (state.calQuery || '').toLowerCase();
  return (state.events || []).filter((event) => {
    if (state.hiddenCalAccounts.has(event.accountId)) return false;
    if (state.hiddenCalendars.has(hideKey(event.accountId, event.calendarId))) return false;
    if (!query) return true;
    return `${event.title} ${event.location} ${event.description}`.toLowerCase().includes(query);
  });
}

function occursOn(event, day) {
  const key = dateKey(day);
  if (event.allDay) return event.start <= key && key < event.end;
  const start = new Date(event.start);
  const end = new Date(event.end);
  const from = startOfDay(day);
  const to = addDays(from, 1);
  return start < to && end > from;
}

function renderCalendarCommands() {
  const account = Boolean(currentAccount());
  const views = ['day', 'week', 'month'].map((view) => (
    `<button type="button" class="seg${state.calView === view ? ' on' : ''}" data-action="cal-view" data-view="${view}">${view[0].toUpperCase()}${view.slice(1)}</button>`
  )).join('');
  document.getElementById('commands').innerHTML = [
    ribbonGroup([
      button('new-event', 'New', 'newevent', { primary: true, title: 'New event (Ctrl+N)', always: true }),
    ]),
    ribbonGroup([
      button('cal-today', 'Today', 'calendar', { always: true }),
      button('cal-prev', 'Previous', 'prev', { always: true }),
      button('cal-next', 'Next', 'next', { always: true }),
    ]),
    ribbonGroup([`<div class="seg-group">${views}</div>`]),
    ribbonGroup([
      button('refresh', 'Refresh', 'refresh', { enabled: account }),
    ]),
  ].join('');
  syncChrome();
}

async function showMail() {
  const input = document.getElementById('search');
  if (state.module === 'calendar' && input) {
    state.calQuery = input.value.trim();
    input.value = state.query || '';
    input.placeholder = state.mailMode === 'new' ? 'Search unread mail' : 'Search this folder';
  }
  state.module = 'mail';
  state.menu = null;
  syncChrome();
  renderCommands();
  saveUi();
  await loadMessages();
}

async function showCalendar() {
  const input = document.getElementById('search');
  if (state.module !== 'calendar' && input) {
    state.query = input.value.trim();
    input.value = state.calQuery || '';
    input.placeholder = 'Search events';
    state.module = 'calendar';
  }
  state.menu = null;
  state.selectedDay = startOfDay(state.selectedDay || new Date());
  state.cursor = startOfDay(state.cursor || state.selectedDay);
  syncChrome();
  renderCommands();
  saveUi();
  await loadCalendar();
}

async function loadCalendar(options = {}) {
  if (!state.accounts.length) {
    state.events = [];
    state.calendars = [];
    state.calError = '';
    renderCalendar();
    return;
  }
  const accounts = visibleCalAccounts();
  if (!accounts.length) {
    publishCalendar();
    state.calError = '';
    state.calLoading = false;
    renderCalendar();
    return;
  }
  const range = visibleRange();
  const startMs = range.start.getTime();
  const endMs = range.end.getTime();
  const missing = accounts.filter((account) => {
    const stored = calStores.get(account.id);
    return options.force || !stored || stored.start > startMs || stored.end < endMs;
  });
  if (!missing.length) {
    publishCalendar();
    state.calLoading = false;
    state.calError = '';
    renderCalendar();
    return;
  }
  const gen = (state.calGen || 0) + 1;
  state.calGen = gen;
  state.calLoading = !state.events.length;
  state.calError = '';
  showProgress(true);
  if (!state.events.length) renderCalendar();
  try {
    const results = await Promise.all(missing.map(async (account) => {
      try {
        const data = await call(() => api.listEvents(account.id, {
          start: range.start.toISOString(),
          end: range.end.toISOString(),
          fresh: Boolean(options.force),
        }));
        return { account, data };
      } catch (error) {
        return { account, error };
      }
    }));
    if (gen !== state.calGen) return;
    const errors = [];
    for (const result of results) {
      if (result.error) errors.push(`${result.account.email}: ${result.error.message}`);
      else rememberCalendar(result.account.id, result.data, Boolean(options.force));
    }
    publishCalendar();
    state.calError = errors.join(' ');
    if (errors.length && !state.events.length) toast(errors[0]);
    if (results.some((result) => !result.error)) markUpdated();
  } catch (error) {
    if (gen !== state.calGen) return;
    state.calError = error.message;
    toast(error.message);
  } finally {
    showProgress(false);
    if (gen === state.calGen) {
      state.calLoading = false;
      renderCalendar();
    }
  }
}

async function shiftCalendar(direction) {
  if (direction === 'today') {
    state.cursor = startOfDay(new Date());
    state.selectedDay = startOfDay(new Date());
  } else if (state.calView === 'month') {
    const next = new Date(state.cursor);
    next.setMonth(next.getMonth() + direction);
    state.cursor = startOfMonth(next);
    state.selectedDay = startOfMonth(next);
  } else if (state.calView === 'week') {
    state.cursor = addDays(state.cursor, 7 * direction);
    state.selectedDay = startOfDay(state.cursor);
  } else {
    state.cursor = addDays(state.cursor, direction);
    state.selectedDay = startOfDay(state.cursor);
  }
  state.calScrollReset = true;
  await loadCalendar();
}

async function shiftMini(direction) {
  const next = new Date(state.cursor);
  next.setMonth(next.getMonth() + direction);
  state.cursor = next;
  state.selectedDay = startOfDay(next);
  await loadCalendar();
}

async function setCalView(view) {
  if (!view || view === state.calView) return;
  state.calView = view;
  state.calScrollReset = true;
  renderCommands();
  saveUi();
  await loadCalendar();
}

async function pickDay(value) {
  const day = parseKey(value);
  if (!day) return;
  const before = visibleRange();
  state.selectedDay = day;
  if (state.calView === 'month') {
    if (day.getMonth() !== state.cursor.getMonth() || day.getFullYear() !== state.cursor.getFullYear()) {
      state.cursor = startOfMonth(day);
    }
  } else {
    state.cursor = day;
    state.calScrollReset = true;
  }
  const after = visibleRange();
  if (before.start.getTime() !== after.start.getTime() || before.end.getTime() !== after.end.getTime()) await loadCalendar();
  else renderCalendar();
}

function toggleCalendar(id, accountId, visible) {
  if (!id) return;
  const key = hideKey(accountId || '', id);
  if (visible) state.hiddenCalendars.delete(key);
  else state.hiddenCalendars.add(key);
  saveUi();
  renderCalendar();
}

function toggleCalAccount(id, visible) {
  if (!id) return;
  if (visible) state.hiddenCalAccounts.delete(id);
  else state.hiddenCalAccounts.add(id);
  saveUi();
  const range = visibleRange();
  const stored = calStores.get(id);
  const covered = stored && stored.start <= range.start.getTime() && stored.end >= range.end.getTime();
  if (!visible || covered) {
    publishCalendar();
    renderCalendar();
    return;
  }
  loadCalendar();
}

function renderCalendar() {
  const root = document.getElementById('calendar-root');
  if (!root) return;
  const previousScroll = root.querySelector('.cal-scroll');
  const previousSide = root.querySelector('.cal-side');
  const scrollTop = previousScroll ? previousScroll.scrollTop : null;
  const sideTop = previousSide ? previousSide.scrollTop : 0;
  if (!state.accounts.length) {
    root.innerHTML = `<div class="welcome"><div class="empty-mark">${icon('calendar')}</div><h1>Calendar</h1><p>Add a Gmail or Outlook account to see and edit its events.</p><button type="button" class="cmd primary" data-action="manage-accounts">Add an account</button></div>`;
    return;
  }
  const events = shownEvents();
  const days = state.calView === 'day'
    ? [startOfDay(state.cursor)]
    : Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(state.cursor), index));
  const main = state.calView === 'month' ? monthBoard(events) : `${dayHeader(days)}${timeGrid(events, days)}`;
  root.innerHTML = `<div class="cal-shell">
    ${calendarSide()}
    <section class="cal-main">
      <div class="cal-title"><h2>${esc(periodTitle())}</h2>${state.calLoading ? '<span>Loading…</span>' : ''}</div>
      ${state.calError ? `<p class="cal-error">${esc(state.calError)}</p>` : ''}
      ${visibleCalAccounts().length ? '' : '<p class="hint cal-empty">Check an account to show its calendars.</p>'}
      ${main}
    </section>
    ${agenda(events)}
  </div>`;
  const scroller = root.querySelector('.cal-scroll');
  syncCalendarScrollbar();
  if (scroller && state.calScrollReset && state.calView !== 'month') {
    scroller.scrollTop = 7 * 48;
    state.calScrollReset = false;
  } else if (scroller && scrollTop != null) {
    scroller.scrollTop = scrollTop;
  }
  const side = root.querySelector('.cal-side');
  if (side) side.scrollTop = sideTop;
  startNowClock();
}

function syncCalendarScrollbar() {
  const root = document.getElementById('calendar-root');
  const scroller = root && root.querySelector('.cal-scroll');
  const main = root && root.querySelector('.cal-main');
  if (!main) return;
  const bar = scroller ? scroller.offsetWidth - scroller.clientWidth : 0;
  main.style.setProperty('--cal-scrollbar', `${Math.max(0, bar)}px`);
}

function calendarSide() {
  const groups = state.accounts.map((account) => {
    const on = !state.hiddenCalAccounts.has(account.id);
    const calendars = state.calendars.filter((calendar) => calendar.accountId === account.id);
    const list = !on
      ? ''
      : calendars.length
        ? calendars.map((calendar) => `<label class="cal-check sub"><input type="checkbox" data-action="toggle-calendar" data-account="${esc(account.id)}" data-id="${esc(calendar.id)}" ${state.hiddenCalendars.has(hideKey(account.id, calendar.id)) ? '' : 'checked'}><i class="dot" style="background:${esc(calendar.color)}"></i><span>${esc(calendar.name)}</span></label>`).join('')
        : '<p class="hint cal-subhint">No calendars yet.</p>';
    return `<div class="cal-account"><label class="cal-check account-check"><input type="checkbox" data-action="toggle-cal-account" data-id="${esc(account.id)}" ${on ? 'checked' : ''}><span class="account-meta"><strong>${esc(account.name || account.email)}</strong><em>${esc(account.email)}</em></span></label>${list}</div>`;
  }).join('');
  return `<aside class="cal-side">${miniMonthHtml()}<div class="nav-label"><span>Calendars</span></div>${groups || '<p class="hint">No accounts yet.</p>'}</aside>`;
}

function miniMonthHtml() {
  const cursor = state.cursor || new Date();
  const label = cursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const start = startOfWeek(startOfMonth(cursor));
  let cells = '';
  for (let index = 0; index < 42; index += 1) {
    const day = addDays(start, index);
    const classes = ['mini-day'];
    if (day.getMonth() !== cursor.getMonth()) classes.push('outside');
    if (sameDay(day, new Date())) classes.push('today');
    if (sameDay(day, state.selectedDay)) classes.push('picked');
    cells += `<button type="button" class="${classes.join(' ')}" data-action="cal-day" data-date="${dateKey(day)}">${day.getDate()}</button>`;
  }
  const names = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((name) => `<span>${name}</span>`).join('');
  return `<div class="mini"><div class="mini-head"><button type="button" data-action="cal-mini" data-dir="-1" aria-label="Previous month">‹</button><strong>${esc(label)}</strong><button type="button" data-action="cal-mini" data-dir="1" aria-label="Next month">›</button></div><div class="mini-names">${names}</div><div class="mini-grid">${cells}</div></div>`;
}

function monthBoard(events) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const start = startOfWeek(startOfMonth(state.cursor));
  let cells = '';
  for (let index = 0; index < 42; index += 1) {
    const day = addDays(start, index);
    const key = dateKey(day);
    const classes = ['cal-cell'];
    if (day.getMonth() !== state.cursor.getMonth()) classes.push('outside');
    if (sameDay(day, new Date())) classes.push('today');
    if (sameDay(day, state.selectedDay)) classes.push('picked');
    const dayEvents = events.filter((event) => occursOn(event, day));
    const chips = dayEvents.slice(0, 3).map(eventChip).join('');
    const more = dayEvents.length > 3 ? `<span class="more">+${dayEvents.length - 3}</span>` : '';
    cells += `<div class="${classes.join(' ')}" data-action="cal-day" data-date="${key}"><span class="cal-num">${day.getDate()}</span>${chips}${more}</div>`;
  }
  return `<div class="dow-row">${names.map((name) => `<span>${name}</span>`).join('')}</div><div class="month-grid">${cells}</div>`;
}

function eventChip(event) {
  const time = event.allDay ? '' : `${formatTime(event.start)} `;
  return `<button type="button" class="cal-chip" style="--c:${esc(event.color || '#0f6cbd')}" data-action="open-event" data-id="${esc(event.id)}" data-calendar="${esc(event.calendarId)}" data-account="${esc(event.accountId || '')}" title="${esc(event.title)}${esc(eventAccountMark(event))}"><span>${esc(`${time}${event.title}`)}</span></button>`;
}

function dayHeader(days) {
  return `<div class="dow-grid" style="--days:${days.length}"><div></div>${days.map((day) => {
    const classes = ['dow'];
    if (sameDay(day, new Date())) classes.push('today');
    if (sameDay(day, state.selectedDay)) classes.push('picked');
    return `<button type="button" class="${classes.join(' ')}" data-action="cal-day" data-date="${dateKey(day)}"><span>${esc(day.toLocaleDateString([], { weekday: 'short' }))}</span><strong>${day.getDate()}</strong></button>`;
  }).join('')}</div>`;
}

function nowLine(days) {
  const now = new Date();
  if (!days.some((day) => sameDay(day, now))) return '';
  const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const top = minutes * (48 / 60);
  const label = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<div class="now-line" data-day="${dateKey(now)}" style="top:${top}px"><span>${esc(label)}</span></div>`;
}

function tickNowLine() {
  if (state.module !== 'calendar' || state.calView === 'month') return;
  const line = document.querySelector('#calendar-root .now-line');
  const now = new Date();
  if (!line) return;
  if (line.dataset.day !== dateKey(now)) {
    renderCalendar();
    return;
  }
  const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  line.style.top = `${minutes * (48 / 60)}px`;
  const label = line.querySelector('span');
  if (label) label.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function startNowClock() {
  if (state.nowTimer) return;
  state.nowTimer = setInterval(tickNowLine, 30000);
}

function timeGrid(events, days) {
  const allDay = `<div class="allday" style="--days:${days.length}"><div class="gutter">All day</div>${days.map((day) => `<div class="allday-col">${events.filter((event) => event.allDay && occursOn(event, day)).map(eventChip).join('')}</div>`).join('')}</div>`;
  const columns = days.map((day) => {
    const key = dateKey(day);
    const blocks = placeEvents(events.filter((event) => !event.allDay && occursOn(event, day)), day);
    const boxes = blocks.map((item) => {
      const box = blockBounds(item, blocks);
      const when = box.height >= 34
        ? `${formatTime(item.event.start)} – ${formatTime(item.event.end)}`
        : formatTime(item.event.start);
      const width = 100 / item.cols;
      const left = item.col * width;
      return `<button type="button" class="cal-block" style="top:${box.top}px;height:${box.height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);--c:${esc(item.event.color || '#0f6cbd')}" data-action="open-event" data-id="${esc(item.event.id)}" data-calendar="${esc(item.event.calendarId)}" data-account="${esc(item.event.accountId || '')}"><strong>${esc(when)}</strong> ${esc(item.event.title)}</button>`;
    }).join('');
    return `<div class="day-col" data-action="cal-slot" data-date="${key}">${boxes}</div>`;
  }).join('');
  let gutter = '';
  for (let hour = 0; hour < 24; hour += 1) {
    const label = hour === 0 ? '' : new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
    gutter += `<div class="hour-label">${esc(label)}</div>`;
  }
  return `${allDay}<div class="cal-scroll"><div class="time-grid" style="--days:${days.length}"><div class="gutter-col">${gutter}</div>${columns}${nowLine(days)}</div></div>`;
}

function placeEvents(events, day) {
  const items = events.map((event) => {
    const span = minutesOn(event, day);
    return { event, start: span.start, end: span.end, col: 0, cols: 1 };
  }).sort((a, b) => a.start - b.start || a.end - b.end);

  const clusters = [];
  let group = [];
  let groupEnd = -1;
  for (const item of items) {
    if (group.length && item.start >= groupEnd - 0.25) {
      clusters.push(group);
      group = [];
      groupEnd = -1;
    }
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  }
  if (group.length) clusters.push(group);

  for (const cluster of clusters) {
    const columnEnds = [];
    for (const item of cluster) {
      let col = columnEnds.findIndex((end) => item.start >= end - 0.25);
      if (col < 0) {
        col = columnEnds.length;
        columnEnds.push(item.end);
      } else columnEnds[col] = item.end;
      item.col = col;
    }
    const count = Math.max(1, columnEnds.length);
    for (const item of cluster) item.cols = count;
  }
  return items;
}

function sharesSpan(a, b) {
  const a0 = a.col / a.cols;
  const a1 = (a.col + 1) / a.cols;
  const b0 = b.col / b.cols;
  const b1 = (b.col + 1) / b.cols;
  return a0 < b1 - 0.001 && b0 < a1 - 0.001;
}

function blockBounds(item, items) {
  const px = 48 / 60;
  const top = item.start * px;
  let nextTop = 24 * 48;
  for (const other of items) {
    if (other === item || other.start < item.start || other.start + 0.25 < item.end) continue;
    if (!sharesSpan(item, other)) continue;
    nextTop = Math.min(nextTop, other.start * px);
  }
  const room = Math.max(0, Math.min(Math.max(item.end * px, top + 16), nextTop) - top);
  const gap = room >= 10 ? 2 : 0;
  return { top, height: Math.max(0, room - gap) };
}

function minutesOn(event, day) {
  const from = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const startMs = new Date(event.start).getTime();
  const endMs = new Date(event.end).getTime();
  if (!Number.isFinite(startMs)) return { start: 0, end: 15 };
  const start = Math.max(startMs, from);
  const end = Math.min(Number.isFinite(endMs) ? Math.max(endMs, start) : start + 15 * 60000, dayEnd);
  const startMin = (start - from) / 60000;
  let endMin = (end - from) / 60000;
  if (endMin <= startMin) endMin = Math.min(24 * 60, startMin + 15);
  return { start: startMin, end: endMin };
}

function agenda(events) {
  const day = startOfDay(state.selectedDay || new Date());
  const items = events.filter((event) => occursOn(event, day));
  const title = day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const body = items.length
    ? items.map((event) => `<button type="button" class="agenda-item" data-action="open-event" data-id="${esc(event.id)}" data-calendar="${esc(event.calendarId)}" data-account="${esc(event.accountId || '')}"><i style="background:${esc(event.color || '#0f6cbd')}"></i><span><strong>${esc(event.title)}</strong><small>${esc(event.allDay ? 'All day' : `${formatTime(event.start)} – ${formatTime(event.end)}`)}${event.location ? ` · ${esc(event.location)}` : ''}${esc(eventAccountMark(event))}</small></span></button>`).join('')
    : '<p class="hint">Nothing scheduled.</p>';
  return `<aside class="cal-agenda"><h2>${esc(title)}</h2>${body}<button type="button" class="cmd primary" data-action="new-event" data-date="${dateKey(day)}">New event</button></aside>`;
}

function eventAccountMark(event) {
  if (visibleCalAccounts().length < 2) return '';
  const account = state.accounts.find((item) => item.id === event.accountId);
  return account ? ` · ${account.email}` : '';
}

function defaultCalendarId(accountId) {
  const calendars = state.calendars.filter((calendar) => calendar.accountId === accountId);
  const editable = calendars.filter((calendar) => calendar.editable);
  const primary = editable.find((calendar) => calendar.primary) || editable[0] || calendars[0];
  return primary ? primary.id : '';
}

function openEvent(id, calendarId, accountId) {
  const event = state.events.find((item) => item.id === id && item.calendarId === calendarId && (!accountId || item.accountId === accountId));
  if (event) openEventEditor(event);
}

function openEventEditor(existing, preset) {
  if (!state.accounts.length) {
    openAccounts();
    return;
  }
  if (!existing && !visibleCalAccounts().length) {
    toast('Check an account to add an event.');
    return;
  }
  state.modal = 'event';
  renderEventEditor(existing ? formDraft(existing) : blankEvent(preset));
}

function blankEvent(preset) {
  const day = preset && preset.date ? parseKey(preset.date) : startOfDay(state.selectedDay || new Date());
  const start = new Date(day || new Date());
  if (preset && preset.hour != null && preset.hour !== '') start.setHours(Number(preset.hour), 0, 0, 0);
  else if (sameDay(start, new Date())) start.setHours(Math.min(23, new Date().getHours() + 1), 0, 0, 0);
  else start.setHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const writer = calendarWriteAccount();
  return {
    id: '',
    accountId: writer ? writer.id : '',
    calendarId: writer ? defaultCalendarId(writer.id) : '',
    title: '',
    location: '',
    description: '',
    attendees: '',
    allDay: false,
    editable: true,
    start: toLocalInput(start),
    end: toLocalInput(end),
  };
}

function formDraft(event) {
  if (event.allDay) {
    const inclusive = shiftKey(event.end, -1);
    return { ...event, start: event.start, end: inclusive < event.start ? event.start : inclusive };
  }
  return { ...event, start: toLocalInput(event.start), end: toLocalInput(event.end) };
}

function renderEventEditor(draft) {
  const options = state.calendars
    .filter((calendar) => calendar.accountId === draft.accountId && (calendar.editable || calendar.id === draft.calendarId))
    .map((calendar) => `<option value="${esc(calendar.id)}"${calendar.id === draft.calendarId ? ' selected' : ''}>${esc(calendar.name)}</option>`)
    .join('');
  const locked = draft.id ? 'disabled' : '';
  const accounts = visibleCalAccounts();
  const accountField = draft.id || accounts.length < 2
    ? `<input id="event-account-id" type="hidden" value="${esc(draft.accountId || '')}">`
    : `<label class="field">Account<select id="event-account" data-action="event-account">${accounts.map((account) => `<option value="${esc(account.id)}"${account.id === draft.accountId ? ' selected' : ''}>${esc(account.email)}</option>`).join('')}</select></label>`;
  document.getElementById('modal-root').innerHTML = `<div class="backdrop"><form class="dialog event-dialog" role="dialog" aria-modal="true">
    <h2>${draft.id ? 'Edit event' : 'New event'}</h2>
    <input id="event-id" type="hidden" value="${esc(draft.id || '')}">
    ${accountField}
    <label class="field">Title<input id="event-title" type="text" value="${esc(draft.title || '')}" required></label>
    <label class="field">Calendar<select id="event-calendar" ${locked}>${options}</select></label>
    <label class="check-line"><input id="event-all-day" type="checkbox" data-action="toggle-all-day" ${draft.allDay ? 'checked' : ''}> All day</label>
    <div class="when-row">
      <label class="field">Start<input id="event-start" type="${draft.allDay ? 'date' : 'datetime-local'}" value="${esc(draft.start || '')}" required></label>
      <label class="field">End<input id="event-end" type="${draft.allDay ? 'date' : 'datetime-local'}" value="${esc(draft.end || '')}" required></label>
    </div>
    <label class="field">Location<input id="event-location" type="text" value="${esc(draft.location || '')}"></label>
    <label class="field">Guests<input id="event-attendees" type="text" value="${esc(draft.attendees || '')}" placeholder="name@example.com, ..."></label>
    <label class="field">Notes<textarea id="event-notes" rows="4">${esc(draft.description || '')}</textarea></label>
    <div class="dialog-actions">
      ${draft.id && draft.editable !== false ? '<button type="button" class="cmd" data-action="delete-event">Delete</button>' : ''}
      <button type="button" class="cmd" data-action="close-modal">Cancel</button>
      ${draft.editable === false ? '' : '<button type="submit" class="cmd primary" data-action="save-event">Save</button>'}
    </div>
  </form></div>`;
  const title = document.getElementById('event-title');
  if (title) title.focus();
}

function switchEventAccount() {
  const draft = formDraftFromInputs(readEventForm());
  draft.id = '';
  draft.calendarId = defaultCalendarId(draft.accountId);
  renderEventEditor(draft);
}

function toggleAllDay() {
  const allDay = document.getElementById('event-all-day').checked;
  const start = document.getElementById('event-start');
  const end = document.getElementById('event-end');
  if (allDay) {
    start.value = String(start.value || '').slice(0, 10);
    end.value = String(end.value || start.value).slice(0, 10);
    start.type = 'date';
    end.type = 'date';
  } else {
    const day = String(start.value || dateKey(new Date())).slice(0, 10);
    start.type = 'datetime-local';
    end.type = 'datetime-local';
    start.value = `${day}T09:00`;
    end.value = `${day}T10:00`;
  }
}

function readEventForm() {
  const allDay = document.getElementById('event-all-day').checked;
  let start = document.getElementById('event-start').value;
  let end = document.getElementById('event-end').value;
  if (allDay) {
    if (!end || end < start) end = start;
    end = shiftKey(end, 1);
  }
  const accountPick = document.getElementById('event-account');
  return {
    id: document.getElementById('event-id').value,
    accountId: accountPick ? accountPick.value : (document.getElementById('event-account-id') || {}).value || '',
    calendarId: document.getElementById('event-calendar').value,
    title: document.getElementById('event-title').value.trim(),
    location: document.getElementById('event-location').value.trim(),
    attendees: document.getElementById('event-attendees').value.trim(),
    description: document.getElementById('event-notes').value,
    allDay,
    start,
    end,
  };
}

async function saveEventForm() {
  const draft = readEventForm();
  if (!draft.accountId || !draft.calendarId) throw new Error('Choose an account and a calendar.');
  if (!draft.allDay && new Date(draft.end) <= new Date(draft.start)) {
    throw new Error('The end must be after the start.');
  }
  const button = document.querySelector('[data-action="save-event"]');
  if (button) button.disabled = true;
  showProgress(true);
  try {
    await call(() => api.saveEvent(draft.accountId, draft));
    closeModal();
    toast(draft.id ? 'Event updated.' : 'Event created.');
    await loadCalendar({ force: true });
  } catch (error) {
    if (button) button.disabled = false;
    throw error;
  } finally {
    showProgress(false);
  }
}

async function deleteEventForm() {
  const draft = readEventForm();
  const yes = await confirmDialog('Delete this event from the calendar?', 'Delete event');
  if (!yes) {
    renderEventEditor(formDraftFromInputs(draft));
    return;
  }
  showProgress(true);
  try {
    await call(() => api.deleteEvent(draft.accountId, { id: draft.id, calendarId: draft.calendarId }));
    closeModal();
    toast('Event deleted.');
    await loadCalendar({ force: true });
  } finally {
    showProgress(false);
  }
}

function formDraftFromInputs(draft) {
  const next = { ...draft, editable: true };
  if (next.allDay && next.end) next.end = shiftKey(next.end, -1);
  return next;
}
