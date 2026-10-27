'use strict';

const store = require('../data/store');
const cache = require('../data/cache');
const gmail = require('./gmail');
const outlook = require('./outlook');
const { mapPool } = require('../shared/util');

function accountOf(accountId) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('That account is not in Light Mail.');
  return account;
}

function providerOf(account) {
  return account.provider === 'outlook' ? outlook : gmail;
}

function assertSome(result, action) {
  if (result && result.failed && result.failed.length && (!result.updated || !result.updated.length)) {
    throw new Error(result.failed[0].error || `Could not ${action} the message.`);
  }
  return result;
}

function sortMessages(result) {
  result.messages.sort((a, b) => new Date(b.date) - new Date(a.date));
  return result;
}

function keptKey(accountId, folderId) {
  return `mail:${accountId}:kept:v1:${folderId || ''}`;
}

function readKept(accountId, folderId) {
  const hit = cache.get(keptKey(accountId, folderId));
  if (hit && Array.isArray(hit.messages)) return { messages: hit.messages, nextPage: hit.nextPage || null };
  return seedKept(accountId, folderId);
}

function seedKept(accountId, folderId) {
  const marker = `mail:${accountId}:list:v4:${folderId}:::`;
  const pages = cache.collect(`mail:${accountId}:list:v4:${folderId}:`)
    .filter((row) => row.key.startsWith(marker) && row.value && Array.isArray(row.value.messages));
  pages.sort((a, b) => {
    if (a.key === marker) return -1;
    if (b.key === marker) return 1;
    return a.key.localeCompare(b.key);
  });
  const messages = [];
  const seen = new Set();
  let nextPage = null;
  for (const page of pages) {
    for (const message of page.value.messages) {
      if (!message || !message.id || seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
    if (page.value.nextPage) nextPage = page.value.nextPage;
  }
  if (!messages.length) return null;
  return writeKept(accountId, folderId, messages, nextPage);
}

function byMailDate(a, b) {
  const stamp = (message) => {
    const time = Date.parse(message && message.date);
    return Number.isFinite(time) && time >= 630720000000 ? time : 0;
  };
  return stamp(b) - stamp(a);
}

function sliceKept(kept, offset, limit) {
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Number(limit) || 30);
  const all = (kept.messages || []).slice().sort(byMailDate);
  const messages = all.slice(start, start + size);
  const next = start + messages.length;
  return {
    messages,
    nextPage: next < all.length ? `kept:${next}` : (kept.nextPage || null),
  };
}

function writeKept(accountId, folderId, messages, nextPage) {
  return cache.set(keptKey(accountId, folderId), {
    messages: (messages || []).slice().sort(byMailDate),
    nextPage: nextPage || null,
  });
}

function markKept(accountId, ids, change) {
  const idSet = new Set(ids);
  cache.edit(`mail:${accountId}:kept:v1:`, (value) => {
    if (!value || !Array.isArray(value.messages)) return value;
    for (const message of value.messages) {
      if (message && idSet.has(message.id)) change(message);
    }
    return value;
  });
}

function applySummary(prev, next) {
  if (!prev) return { ...next, removed: false };
  return {
    ...prev,
    ...next,
    removed: false,
    pinned: Boolean(next.pinned) || Boolean(prev.pinned),
  };
}

function mergeHead(existing, incoming) {
  const prevById = new Map((existing || []).filter((message) => message && message.id).map((message) => [message.id, message]));
  const seen = new Set();
  const head = [];
  for (const message of incoming || []) {
    if (!message || !message.id || seen.has(message.id)) continue;
    seen.add(message.id);
    head.push(applySummary(prevById.get(message.id), message));
  }
  const rest = [];
  for (const message of existing || []) {
    if (!message || !message.id || seen.has(message.id)) continue;
    rest.push(message);
  }
  return head.concat(rest);
}

async function noteMissing(account, folderId, messages, missingIds) {
  if (!missingIds.length) return;
  const provider = providerOf(account);
  await mapPool(missingIds, 8, async (id) => {
    const message = messages.find((item) => item && item.id === id);
    if (!message) return;
    try {
      const place = await provider.messagePlace(account, id);
      if (!place || place.found === false) {
        message.removed = true;
        return;
      }
      const labels = place.labels || [];
      const leftFolder = account.provider === 'outlook'
        ? Boolean(place.folderId && folderId && place.folderId !== folderId)
        : Boolean(folderId && labels.length && !labels.includes(folderId));
      message.removed = leftFolder;
    } catch {
      // A failed check leaves the saved message in place.
    }
  });
}

async function syncKept(account, accountId, folderId, kept, options = {}) {
  const head = Boolean(options.head);
  const result = await providerOf(account).listMessages(account, folderId, head ? { limit: 20 } : {});
  if (head) stampPins(account.id, result.messages);
  else await attachPins(account, folderId, {}, result);
  const incoming = result.messages || [];
  const incomingIds = new Set(incoming.map((message) => message && message.id).filter(Boolean));
  const missing = (kept.messages || []).slice(0, head ? 12 : 40).map((message) => message && message.id).filter((id) => id && !incomingIds.has(id));
  const merged = mergeHead(kept.messages || [], incoming);
  const nextPage = (kept.messages || []).length > incoming.length
    ? (kept.nextPage || result.nextPage || null)
    : (result.nextPage || kept.nextPage || null);
  const saved = writeKept(accountId, folderId, merged, nextPage);
  absorbStatus(accountId, incoming);
  stampPins(accountId, saved.messages);
  if (!head) prefetchMessages(accountId, incoming);
  if (missing.length) {
    noteMissing(account, folderId, saved.messages, missing).then(() => {
      writeKept(accountId, folderId, saved.messages, saved.nextPage);
    }).catch(() => {});
  }
  if (head) {
    return {
      messages: incoming,
      nextPage: saved.messages.length > incoming.length ? `kept:${incoming.length}` : saved.nextPage,
    };
  }
  return sliceKept(saved, 0, 90);
}

function copyStatus(message, next) {
  message.unread = Boolean(next.unread);
  message.flagged = Boolean(next.flagged);
  message.removed = Boolean(next.removed);
  if (next.subject) message.subject = next.subject;
  if (next.snippet != null) message.snippet = next.snippet;
  if (next.from) message.from = next.from;
  if (next.date) message.date = next.date;
  if (next.folderId) message.folderId = next.folderId;
  if (next.tags) message.tags = next.tags;
  message.pinned = Boolean(next.pinned) || Boolean(message.pinned);
}

function absorbStatus(accountId, messages) {
  const byId = new Map((messages || []).filter((message) => message && message.id).map((message) => [message.id, message]));
  if (!byId.size) return;
  cache.edit(`mail:${accountId}:kept:v1:`, (value) => {
    if (!value || !Array.isArray(value.messages)) return value;
    for (const message of value.messages) {
      const next = message && byId.get(message.id);
      if (next) copyStatus(message, next);
    }
    return value;
  });
}

function unreadFromKept(accountId) {
  const rows = cache.collect(`mail:${accountId}:kept:v1:`);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    for (const message of (row.value && row.value.messages) || []) {
      if (!message || !message.id || !message.unread || message.removed || seen.has(message.id)) continue;
      seen.add(message.id);
      out.push({ ...message });
    }
  }
  return out;
}

function mixUnread(messages, extra) {
  const have = new Set((messages || []).map((message) => message && message.id).filter(Boolean));
  const add = [];
  for (const message of extra || []) {
    if (!message || !message.id || !message.unread || message.removed || have.has(message.id)) continue;
    have.add(message.id);
    add.push(message);
  }
  return add.length ? add.concat(messages || []) : (messages || []);
}

function patchMessages(accountId, ids, change) {
  const idSet = new Set(ids);
  const listPrefix = `mail:${accountId}:list:`;
  const messagePrefix = `mail:${accountId}:msg:`;
  const unreadKey = listKey(accountId, '', { unread: true });
  const snapshots = new Map();
  const apply = (message) => {
    if (message && idSet.has(message.id)) {
      change(message);
      snapshots.set(message.id, { ...message });
    }
  };
  cache.edit(listPrefix, (list) => {
    for (const message of (list && list.messages) || []) apply(message);
    return list;
  });
  cache.edit(`mail:${accountId}:kept:v1:`, (value) => {
    if (!value || !Array.isArray(value.messages)) return value;
    for (const message of value.messages) apply(message);
    return value;
  });
  cache.edit(messagePrefix, (message, key) => {
    if (idSet.has(key.slice(messagePrefix.length))) {
      change(message);
      if (message) snapshots.set(message.id || key.slice(messagePrefix.length), { ...message });
    }
    return message;
  });
  let unreadTouched = false;
  cache.edit(listPrefix, (list, key) => {
    if (!list || !Array.isArray(list.messages) || !key.includes(':list:v4:unread:')) return list;
    unreadTouched = true;
    list.messages = list.messages.filter((message) => message && message.unread && !message.removed);
    const have = new Set(list.messages.map((message) => message.id));
    for (const snapshot of snapshots.values()) {
      if (snapshot && snapshot.unread && !snapshot.removed && snapshot.id && !have.has(snapshot.id)) {
        list.messages.unshift(snapshot);
        have.add(snapshot.id);
      }
    }
    return list;
  });
  const unreadSnaps = [...snapshots.values()].filter((message) => message && message.unread && !message.removed && message.id);
  if (unreadSnaps.length && !unreadTouched) {
    const current = cache.get(unreadKey);
    cache.set(unreadKey, {
      messages: mixUnread((current && current.messages) || [], unreadSnaps),
      nextPage: (current && current.nextPage) || null,
    });
  }
  cache.drop(`mail:${accountId}:folders`);
}

function listKey(accountId, folderId, options) {
  const scope = options.unread ? 'unread' : (folderId || '');
  return `mail:${accountId}:list:v4:${scope}:${options.tag || ''}:${options.query || ''}:${options.pageToken || ''}`;
}

async function listFolders(accountId, options = {}) {
  const key = `mail:${accountId}:folders:v2`;
  if (!options.fresh) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const account = accountOf(accountId);
  const folders = await providerOf(account).listFolders(account, options);
  return cache.set(key, folders);
}

async function listTags(accountId, options = {}) {
  const key = `mail:${accountId}:tags`;
  if (!options.fresh) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const account = accountOf(accountId);
  const tags = await providerOf(account).listTags(account, options);
  return cache.set(key, tags);
}

const inflight = new Map();
const prefetchQueue = [];
let prefetchActive = 0;
let listBusy = 0;
const PREFETCH_LIMIT = 3;

async function withListBusy(fn) {
  listBusy += 1;
  try {
    return await fn();
  } finally {
    listBusy = Math.max(0, listBusy - 1);
    pumpPrefetch();
  }
}

function messageKey(accountId, messageId) {
  return `mail:${accountId}:msg:${messageId}`;
}

function pinKey(accountId) {
  return `mail:${accountId}:pins`;
}

function pinSet(accountId) {
  const value = cache.get(pinKey(accountId));
  return new Set(Array.isArray(value) ? value : []);
}

function stampPins(accountId, messages) {
  const pins = pinSet(accountId);
  for (const message of messages || []) {
    if (!message) continue;
    message.pinned = Boolean(message.pinned) || pins.has(message.id);
  }
  return messages;
}

function hasBody(message) {
  return Boolean(message) && (message.bodyHtml != null || message.bodyText != null);
}

function prefetchMessages(accountId, messages, limit = 5) {
  const next = [];
  for (const message of (messages || []).slice(0, Math.max(0, limit))) {
    if (!message || !message.id) continue;
    const key = messageKey(accountId, message.id);
    if (hasBody(cache.get(key)) || inflight.has(key) || prefetchQueue.some((item) => item.key === key)) continue;
    next.push({ accountId, messageId: message.id, key });
  }
  if (!next.length) return;
  prefetchQueue.unshift(...next);
  while (prefetchQueue.length > 16) prefetchQueue.pop();
  pumpPrefetch();
}

function pumpPrefetch() {
  if (listBusy) return;
  while (prefetchActive < PREFETCH_LIMIT && prefetchQueue.length) {
    const job = prefetchQueue.shift();
    if (hasBody(cache.get(job.key)) || inflight.has(job.key)) continue;
    prefetchActive += 1;
    getMessage(job.accountId, job.messageId).catch(() => null).finally(() => {
      prefetchActive -= 1;
      pumpPrefetch();
    });
  }
}

async function listMessages(accountId, folderId, options) {
  const opts = { ...(options || {}) };
  const fresh = Boolean(opts.fresh);
  const head = Boolean(opts.head);
  delete opts.fresh;
  delete opts.head;
  if (head && !opts.limit) opts.limit = 20;
  const account = accountOf(accountId);
  const keptToken = /^kept:(\d+)$/.exec(String(opts.pageToken || ''));
  if (!opts.query && !opts.tag && !opts.unread) {
    const kept = readKept(accountId, folderId);
    if (kept && keptToken) {
      const sliced = sliceKept(kept, Number(keptToken[1]), 30);
      stampPins(accountId, sliced.messages);
      prefetchMessages(accountId, sliced.messages);
      return sliced;
    }
    const plain = !opts.pageToken;
    if (kept && fresh && plain) return withListBusy(() => syncKept(account, accountId, folderId, kept, { head }));
    if (kept && plain) {
      const sliced = sliceKept(kept, 0, 90);
      stampPins(accountId, sliced.messages);
      prefetchMessages(accountId, sliced.messages);
      return sliced;
    }
  }
  const key = listKey(accountId, folderId, opts);
  if (!fresh) {
    const hit = cache.get(key);
    if (hit) {
      if (opts.pageToken && !opts.query && !opts.tag && !opts.unread) {
        const kept = readKept(accountId, folderId) || { messages: [], nextPage: null };
        const seen = new Set((kept.messages || []).map((message) => message && message.id));
        const extra = (hit.messages || []).filter((message) => message && message.id && !seen.has(message.id));
        if (extra.length) writeKept(accountId, folderId, (kept.messages || []).concat(extra), hit.nextPage || kept.nextPage);
      }
      if (opts.unread && !opts.pageToken) {
        hit.messages = mixUnread(hit.messages, unreadFromKept(accountId));
        cache.set(key, hit);
      }
      stampPins(accountId, hit.messages);
      if (!head) prefetchMessages(accountId, hit.messages);
      return hit;
    }
  }
  return withListBusy(async () => {
    const result = await providerOf(account).listMessages(account, folderId, opts);
    if (head) stampPins(account.id, result.messages);
    else await attachPins(account, folderId, opts, result);
    if (!opts.query && !opts.tag && !opts.unread) {
      const kept = readKept(accountId, folderId) || { messages: [], nextPage: null };
      if (opts.pageToken) {
        const seen = new Set((kept.messages || []).map((message) => message && message.id));
        const extra = (result.messages || []).filter((message) => message && message.id && !seen.has(message.id));
        writeKept(accountId, folderId, (kept.messages || []).concat(extra), result.nextPage || kept.nextPage);
      } else {
        writeKept(accountId, folderId, mergeHead(kept.messages, result.messages), result.nextPage || null);
      }
    }
    if (opts.unread && !opts.pageToken) {
      result.messages = mixUnread(result.messages, unreadFromKept(accountId));
    }
    absorbStatus(account.id, result.messages);
    cache.set(key, result);
    if (!head && !opts.unread) prefetchMessages(accountId, result.messages);
    return result;
  });
}

async function getMessage(accountId, messageId, options = {}) {
  const key = messageKey(accountId, messageId);
  if (!options.fresh) {
    const hit = cache.get(key);
    if (hasBody(hit)) return stampPins(accountId, [hit])[0];
    if (inflight.has(key)) return inflight.get(key);
  }
  const task = fetchMessage(accountId, messageId, key);
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    if (inflight.get(key) === task) inflight.delete(key);
  }
}

async function fetchMessage(accountId, messageId, key) {
  const account = accountOf(accountId);
  const message = await providerOf(account).getMessage(account, messageId);
  stampPins(accountId, [message]);
  return cache.set(key, message);
}

async function attachPins(account, folderId, options, result) {
  const messages = result.messages || [];
  stampPins(account.id, messages);
  if (options.query || options.unread || options.pageToken) return result;
  const provider = providerOf(account);
  let server = [];
  if (account.provider === 'outlook' && folderId && folderId !== 'flagged') {
    try {
      server = await provider.listPinned(account, folderId);
    } catch {
      server = [];
    }
  }
  const have = new Set(messages.map((message) => message.id));
  const wanted = new Set(pinSet(account.id));
  for (const message of server) {
    message.pinned = true;
    wanted.add(message.id);
    if (!have.has(message.id)) {
      messages.push(message);
      have.add(message.id);
    }
  }
  for (const message of messages) {
    if (wanted.has(message.id)) message.pinned = true;
  }
  const missing = [...wanted].filter((id) => !have.has(id)).slice(0, 30);
  if (missing.length && provider.fetchSummaries) {
    try {
      const found = await provider.fetchSummaries(account, missing);
      for (const message of found || []) {
        if (!message || have.has(message.id)) continue;
        if (folderId && folderId !== 'flagged' && message.folderId && message.folderId !== folderId) continue;
        message.pinned = true;
        messages.push(message);
        have.add(message.id);
      }
    } catch {
      // A pin that cannot be loaded stays out of this page. The ones already listed still show.
    }
  }
  result.messages = messages;
  return result;
}

async function setPinned(accountId, ids, pinned) {
  const account = accountOf(accountId);
  const pins = pinSet(accountId);
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (account.provider === 'outlook') {
    try {
      await outlook.setPinned(account, clean, pinned);
    } catch {
      // The pin is still kept in Light Mail when Outlook rejects the mailbox property.
    }
  }
  for (const id of clean) {
    if (pinned) pins.add(id);
    else pins.delete(id);
  }
  cache.set(pinKey(accountId), [...pins]);
  patchMessages(accountId, clean, (message) => { message.pinned = Boolean(pinned); });
  return { updated: clean, failed: [] };
}

async function setRead(accountId, ids, read) {
  const account = accountOf(accountId);
  try {
    return assertSome(await providerOf(account).setRead(account, ids, read), 'mark');
  } finally {
    patchMessages(accountId, ids, (message) => { message.unread = !read; });
  }
}

async function setFlag(accountId, ids, flagged) {
  const account = accountOf(accountId);
  try {
    return assertSome(await providerOf(account).setFlag(account, ids, flagged), 'flag');
  } finally {
    patchMessages(accountId, ids, (message) => { message.flagged = Boolean(flagged); });
  }
}

async function removeMessages(accountId, ids, options) {
  const account = accountOf(accountId);
  try {
    return assertSome(await providerOf(account).removeMessages(account, ids, options || {}), 'delete');
  } finally {
    markKept(accountId, ids, (message) => { message.removed = true; });
    patchMessages(accountId, ids, (message) => { message.removed = true; });
  }
}

async function moveMessages(accountId, ids, destinationId, sourceFolderId) {
  const account = accountOf(accountId);
  try {
    return assertSome(
      await providerOf(account).moveMessages(account, ids, destinationId, sourceFolderId),
      'move'
    );
  } finally {
    markKept(accountId, ids, (message) => {
      message.folderId = destinationId || message.folderId;
      message.removed = true;
    });
    patchMessages(accountId, ids, (message) => { message.removed = true; });
  }
}

async function archiveMessages(accountId, ids) {
  const account = accountOf(accountId);
  try {
    return assertSome(await providerOf(account).archiveMessages(account, ids), 'archive');
  } finally {
    markKept(accountId, ids, (message) => { message.removed = true; });
    patchMessages(accountId, ids, (message) => { message.removed = true; });
  }
}

async function setTags(accountId, messageId, tagNames) {
  const account = accountOf(accountId);
  try {
    return await providerOf(account).setTags(account, messageId, tagNames || []);
  } finally {
    cache.drop(`mail:${accountId}:tags`);
  }
}

async function createFolder(accountId, name, parentId) {
  const account = accountOf(accountId);
  try {
    return await providerOf(account).createFolder(account, name, parentId || null);
  } finally {
    cache.drop(`mail:${accountId}:folders`);
  }
}

async function createTag(accountId, name, color) {
  const account = accountOf(accountId);
  try {
    return await providerOf(account).createTag(account, name, color);
  } finally {
    cache.drop(`mail:${accountId}:tags`);
  }
}

async function send(accountId, draft) {
  const account = accountOf(accountId);
  try {
    return await providerOf(account).send(account, draft || {});
  } finally {
    cache.drop(`mail:${accountId}:folders`);
  }
}

async function getAttachment(accountId, messageId, attachmentId) {
  const account = accountOf(accountId);
  return providerOf(account).getAttachment(account, messageId, attachmentId);
}

module.exports = {
  listFolders,
  listTags,
  listMessages,
  getMessage,
  setRead,
  setFlag,
  setPinned,
  removeMessages,
  moveMessages,
  archiveMessages,
  setTags,
  createFolder,
  createTag,
  send,
  getAttachment,
};
