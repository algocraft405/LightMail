'use strict';

const store = require('../data/store');
const cache = require('../data/cache');
const { withToken } = require('../auth/oauth');
const { mapPool, requestJson, stripHtml, wallClockToUtc } = require('../shared/util');

const GOOGLE = 'https://www.googleapis.com/calendar/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const WINDOWS_ZONES = {
  UTC: 'UTC',
  'America/New_York': 'Eastern Standard Time',
  'America/Detroit': 'Eastern Standard Time',
  'America/Toronto': 'Eastern Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/Winnipeg': 'Central Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Edmonton': 'Mountain Standard Time',
  'America/Phoenix': 'US Mountain Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
  'America/Vancouver': 'Pacific Standard Time',
  'America/Anchorage': 'Alaskan Standard Time',
  'Pacific/Honolulu': 'Hawaiian Standard Time',
  'America/Halifax': 'Atlantic Standard Time',
  'America/St_Johns': 'Newfoundland Standard Time',
  'Europe/London': 'GMT Standard Time',
  'Europe/Dublin': 'GMT Standard Time',
  'Europe/Paris': 'Romance Standard Time',
  'Europe/Berlin': 'W. Europe Standard Time',
  'Europe/Madrid': 'Romance Standard Time',
  'Europe/Rome': 'W. Europe Standard Time',
  'Europe/Amsterdam': 'W. Europe Standard Time',
  'Europe/Stockholm': 'W. Europe Standard Time',
  'Europe/Athens': 'GTB Standard Time',
  'Europe/Helsinki': 'FLE Standard Time',
  'Asia/Jerusalem': 'Israel Standard Time',
  'Asia/Dubai': 'Arabian Standard Time',
  'Asia/Kolkata': 'India Standard Time',
  'Asia/Bangkok': 'SE Asia Standard Time',
  'Asia/Singapore': 'Singapore Standard Time',
  'Asia/Shanghai': 'China Standard Time',
  'Asia/Hong_Kong': 'China Standard Time',
  'Asia/Tokyo': 'Tokyo Standard Time',
  'Asia/Seoul': 'Korea Standard Time',
  'Australia/Sydney': 'AUS Eastern Standard Time',
  'Australia/Melbourne': 'AUS Eastern Standard Time',
  'Australia/Perth': 'W. Australia Standard Time',
  'Pacific/Auckland': 'New Zealand Standard Time',
};

const OUTLOOK_COLORS = {
  auto: '#0f6cbd',
  lightBlue: '#4a86e8',
  lightGreen: '#16a765',
  lightOrange: '#ff7537',
  lightGray: '#8a8886',
  lightYellow: '#c9a227',
  lightTeal: '#2da2bb',
  lightPink: '#e06c9f',
  lightBrown: '#8e562e',
  lightRed: '#e66550',
  maxColor: '#0f6cbd',
};

function accountOf(accountId) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('That account is not in Light Mail.');
  return account;
}

function zoneName() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function windowsZone() {
  return WINDOWS_ZONES[zoneName()] || 'UTC';
}

function explain(error) {
  const message = (error && error.message) || 'Calendar request failed.';
  if (/Calendar API has not been used|accessNotConfigured|API has not been enabled|not been enabled/i.test(message)) {
    return new Error('Enable the Google Calendar API in Google Cloud Console, then try again.');
  }
  if (/insufficient|Insufficient privileges|ErrorAccessDenied|Access is denied|Authorization_RequestDenied|required scopes/i.test(message)) {
    return new Error('This account does not have calendar permission yet. Remove it, add it again, and allow calendar access. Outlook also needs the Calendars.ReadWrite permission on the app registration.');
  }
  return error instanceof Error ? error : new Error(message);
}

async function google(account, path, options = {}) {
  return withToken(account, (token) => requestJson(`${GOOGLE}${path}`, { ...options, token }));
}

async function graph(account, method, path, options = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  return withToken(account, (token) => requestJson(url, {
    method,
    token,
    body: options.body,
    headers: options.headers,
  }));
}

function emailsOf(value) {
  return String(value || '')
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.includes('@'));
}

function addDaysKey(key, days) {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

async function listCalendars(accountId) {
  const account = accountOf(accountId);
  try {
    if (account.provider === 'outlook') return await outlookCalendars(account);
    return await googleCalendars(account);
  } catch (error) {
    throw explain(error);
  }
}

async function googleCalendars(account) {
  const data = await google(account, '/users/me/calendarList?maxResults=250');
  return (data.items || [])
    .filter((item) => item.accessRole !== 'freeBusyReader')
    .map((item) => ({
      id: item.id,
      name: item.summary || item.id,
      color: item.backgroundColor || '#0f6cbd',
      primary: Boolean(item.primary),
      editable: item.accessRole === 'owner' || item.accessRole === 'writer',
      selected: item.selected !== false,
    }))
    .sort(byCalendar);
}

async function outlookCalendars(account) {
  const calendars = [];
  let url = '/me/calendars?$top=100&$select=id,name,color,isDefaultCalendar,canEdit';
  while (url) {
    const data = await graph(account, 'GET', url);
    for (const item of data.value || []) {
      calendars.push({
        id: item.id,
        name: item.name || 'Calendar',
        color: OUTLOOK_COLORS[item.color] || '#0f6cbd',
        primary: Boolean(item.isDefaultCalendar),
        editable: item.canEdit !== false,
        selected: true,
      });
    }
    url = data['@odata.nextLink'] || '';
  }
  return calendars.sort(byCalendar);
}

function dropEvents(accountId) {
  cache.drop(`cal:${accountId}`);
}

function mergeSpans(spans) {
  const sorted = spans.slice().sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      const seen = new Set(last.events.map((event) => `${event.calendarId}:${event.id}`));
      for (const event of span.events) {
        const id = `${event.calendarId}:${event.id}`;
        if (!seen.has(id)) last.events.push(event);
      }
      last.end = Math.max(last.end, span.end);
      last.events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    } else {
      merged.push({
        start: span.start,
        end: span.end,
        events: span.events.slice(),
      });
    }
  }
  return merged;
}

function byCalendar(a, b) {
  if (a.primary !== b.primary) return a.primary ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function listEvents(accountId, range) {
  const account = accountOf(accountId);
  const startMs = Date.parse(range && range.start);
  const endMs = Date.parse(range && range.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('Choose a date range.');
  const key = `cal:${accountId}`;
  if (range.fresh) cache.drop(key);
  const saved = cache.get(key);
  const covered = saved && (saved.spans || []).find((span) => span.start <= startMs && span.end >= endMs);
  if (covered) {
    return {
      calendars: saved.calendars,
      events: covered.events,
      coverage: { start: covered.start, end: covered.end },
    };
  }
  const span = endMs - startMs;
  const pad = span > 10 * 86400000 ? 7 * 86400000 : 14 * 86400000;
  const fetchStartMs = startMs - pad;
  const fetchEndMs = endMs + pad;
  const fetchStart = new Date(fetchStartMs).toISOString();
  const fetchEnd = new Date(fetchEndMs).toISOString();
  const calendars = await listCalendars(accountId);
  let denied = null;
  let failure = null;
  let failures = 0;
  const groups = await mapPool(calendars, 4, async (calendar) => {
    try {
      if (account.provider === 'outlook') return await outlookEvents(account, calendar, fetchStart, fetchEnd);
      return await googleEvents(account, calendar, fetchStart, fetchEnd);
    } catch (error) {
      failures += 1;
      const explained = explain(error);
      if (/calendar permission|Google Calendar API/i.test(explained.message)) denied = explained;
      else failure = explained;
      return [];
    }
  });
  const events = groups.flat().filter(Boolean);
  if (calendars.length && failures === calendars.length) {
    if (denied) throw denied;
    if (failure) throw failure;
  }
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const previous = cache.get(key) || { calendars, spans: [] };
  const spans = mergeSpans(previous.spans.concat([{ start: fetchStartMs, end: fetchEndMs, events }]));
  cache.set(key, { calendars, spans });
  const stored = spans.find((item) => item.start <= startMs && item.end >= endMs) || spans[spans.length - 1];
  return {
    calendars,
    events: stored.events,
    coverage: { start: stored.start, end: stored.end },
  };
}

async function googleEvents(account, calendar, start, end) {
  const events = [];
  let pageToken = '';
  const calendarPath = encodeURIComponent(calendar.id);
  do {
    const params = new URLSearchParams({
      timeMin: start,
      timeMax: end,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      showDeleted: 'false',
    });
    if (pageToken) params.set('pageToken', pageToken);
    params.set('fields', 'nextPageToken,items(id,status,summary,location,description,start,end,attendees,guestsCanModify,organizer)');
    const data = await google(account, `/calendars/${calendarPath}/events?${params}`);
    for (const item of data.items || []) {
      if (item.status === 'cancelled') continue;
      events.push(normalizeGoogle(item, calendar));
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken && events.length < 2000);
  return events;
}

function normalizeGoogle(item, calendar) {
  const allDay = Boolean(item.start && item.start.date && !item.start.dateTime);
  const start = allDay ? item.start.date : (item.start.dateTime || item.start.date);
  let end = allDay ? item.end.date : (item.end.dateTime || item.end.date);
  if (allDay && (!end || end <= start)) end = addDaysKey(start, 1);
  return {
    id: item.id,
    calendarId: calendar.id,
    calendarName: calendar.name,
    color: calendar.color,
    title: item.summary || '(no title)',
    location: item.location || '',
    description: item.description || '',
    allDay,
    start,
    end,
    attendees: (item.attendees || []).map((person) => person.email).filter(Boolean).join(', '),
    editable: calendar.editable && (item.guestsCanModify !== false || Boolean(item.organizer && item.organizer.self)),
  };
}

async function outlookEvents(account, calendar, start, end) {
  const events = [];
  const params = new URLSearchParams({
    startDateTime: start,
    endDateTime: end,
    $top: '100',
    $select: 'id,subject,bodyPreview,body,start,end,location,isAllDay,isCancelled,attendees,sensitivity',
  });
  let url = `/me/calendars/${encodeURIComponent(calendar.id)}/calendarView?${params}`;
  const headers = { Prefer: `outlook.timezone="${windowsZone()}"` };
  while (url && events.length < 2000) {
    const data = await graph(account, 'GET', url, { headers });
    for (const item of data.value || []) {
      if (item.isCancelled) continue;
      events.push(normalizeOutlook(item, calendar));
    }
    url = data['@odata.nextLink'] || '';
  }
  return events;
}

function normalizeOutlook(item, calendar) {
  const zone = zoneName();
  if (item.isAllDay) {
    const start = String(item.start && item.start.dateTime || '').slice(0, 10);
    let end = String(item.end && item.end.dateTime || '').slice(0, 10);
    if (!end || end <= start) end = addDaysKey(start, 1);
    return baseOutlook(item, calendar, true, start, end);
  }
  const start = wallClockToUtc(item.start && item.start.dateTime, item.start && item.start.timeZone === 'UTC' ? 'UTC' : zone);
  const end = wallClockToUtc(item.end && item.end.dateTime, item.end && item.end.timeZone === 'UTC' ? 'UTC' : zone);
  return baseOutlook(item, calendar, false, start, end);
}

function baseOutlook(item, calendar, allDay, start, end) {
  const body = item.body || {};
  const description = (body.contentType || '').toLowerCase() === 'html'
    ? stripHtml(body.content || '')
    : (body.content || item.bodyPreview || '');
  return {
    id: item.id,
    calendarId: calendar.id,
    calendarName: calendar.name,
    color: calendar.color,
    title: item.subject || '(no title)',
    location: (item.location && item.location.displayName) || '',
    description,
    allDay,
    start,
    end,
    attendees: (item.attendees || []).map((person) => person.emailAddress && person.emailAddress.address).filter(Boolean).join(', '),
    editable: calendar.editable,
  };
}

async function saveEvent(accountId, draft) {
  const account = accountOf(accountId);
  const title = String(draft.title || '').trim();
  if (!title) throw new Error('Enter a title.');
  if (!draft.calendarId) throw new Error('Choose a calendar.');
  if (!draft.start || !draft.end) throw new Error('Enter a start and end.');
  try {
    if (account.provider === 'outlook') return await saveOutlook(account, draft, title);
    return await saveGoogle(account, draft, title);
  } catch (error) {
    throw explain(error);
  } finally {
    dropEvents(accountId);
  }
}

async function saveGoogle(account, draft, title) {
  const path = `/calendars/${encodeURIComponent(draft.calendarId)}/events${draft.id ? `/${encodeURIComponent(draft.id)}` : ''}`;
  const attendees = emailsOf(draft.attendees).map((email) => ({ email }));
  const body = {
    summary: title,
    location: draft.location || '',
    description: draft.description || '',
    attendees,
    start: draft.allDay ? { date: draft.start } : { dateTime: new Date(draft.start).toISOString(), timeZone: zoneName() },
    end: draft.allDay ? { date: draft.end } : { dateTime: new Date(draft.end).toISOString(), timeZone: zoneName() },
  };
  const send = attendees.length ? 'all' : 'none';
  const saved = await google(account, `${path}?sendUpdates=${send}`, { method: draft.id ? 'PATCH' : 'POST', body });
  return { id: saved.id, calendarId: draft.calendarId };
}

function graphDateTime(value, allDay) {
  if (allDay) return { dateTime: `${value}T00:00:00`, timeZone: windowsZone() };
  const iso = new Date(value).toISOString().replace(/\.\d{3}Z$/, '');
  return { dateTime: iso, timeZone: 'UTC' };
}

async function saveOutlook(account, draft, title) {
  const attendees = emailsOf(draft.attendees).map((email) => ({
    emailAddress: { address: email },
    type: 'required',
  }));
  const body = {
    subject: title,
    body: { contentType: 'Text', content: draft.description || '' },
    location: { displayName: draft.location || '' },
    isAllDay: Boolean(draft.allDay),
    start: graphDateTime(draft.start, draft.allDay),
    end: graphDateTime(draft.end, draft.allDay),
    attendees,
  };
  const path = draft.id
    ? `/me/events/${encodeURIComponent(draft.id)}`
    : `/me/calendars/${encodeURIComponent(draft.calendarId)}/events`;
  const saved = await graph(account, draft.id ? 'PATCH' : 'POST', path, { body });
  return { id: saved.id, calendarId: draft.calendarId };
}

async function deleteEvent(accountId, event) {
  const account = accountOf(accountId);
  if (!event || !event.id || !event.calendarId) throw new Error('Choose an event to delete.');
  try {
    if (account.provider === 'outlook') {
      await graph(account, 'DELETE', `/me/events/${encodeURIComponent(event.id)}`);
    } else {
      await google(
        account,
        `/calendars/${encodeURIComponent(event.calendarId)}/events/${encodeURIComponent(event.id)}?sendUpdates=all`,
        { method: 'DELETE' }
      );
    }
  } catch (error) {
    throw explain(error);
  } finally {
    dropEvents(accountId);
  }
  return { deleted: true };
}

module.exports = {
  listCalendars,
  listEvents,
  saveEvent,
  deleteEvent,
};
