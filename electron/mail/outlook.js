'use strict';

const { withToken } = require('../auth/oauth');
const {
  OUTLOOK_CATEGORY_PRESETS,
  PRESET_HEX,
  TAG_COLORS,
  unique,
  chunk,
  mapPool,
  stripHtml,
  parseAddressList,
  odataQuote,
  colorKey,
  requestJson,
} = require('../shared/util');

const PAGE_SIZE = 30;
const GRAPH = 'https://graph.microsoft.com/v1.0';

const WELL_KNOWN = {
  inbox: { kind: 'inbox', name: 'Inbox', order: 0 },
  drafts: { kind: 'drafts', name: 'Drafts', order: 1 },
  sentitems: { kind: 'sent', name: 'Sent', order: 2 },
  junkemail: { kind: 'junk', name: 'Junk', order: 4 },
  deleteditems: { kind: 'trash', name: 'Trash', order: 5 },
  archive: { kind: 'archive', name: 'Archive', order: 6 },
};

const LIST_SELECT = [
  'id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime',
  'isRead', 'bodyPreview', 'categories', 'hasAttachments', 'flag', 'conversationId', 'parentFolderId',
].join(',');

const FULL_SELECT = `${LIST_SELECT},bccRecipients,body,internetMessageId,replyTo`;

async function graph(account, method, path, options = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  return withToken(account, (token) => requestJson(url, {
    method,
    token,
    body: options.body,
    headers: options.headers,
  }));
}

function person(value) {
  const address = (value && value.emailAddress) || {};
  return { name: address.name || '', email: address.address || '' };
}

function people(list) {
  return (list || []).map(person).filter((item) => item.email || item.name);
}

function folderKind(folder) {
  const known = WELL_KNOWN[(folder.wellKnownName || '').toLowerCase()];
  if (known) return known.kind;
  return 'custom';
}

function mapFolder(folder, depth) {
  const known = WELL_KNOWN[(folder.wellKnownName || '').toLowerCase()];
  const kind = folderKind(folder);
  const unread = (kind === 'drafts' || kind === 'sent') ? 0 : Number(folder.unreadItemCount || 0);
  return {
    id: folder.id,
    name: known ? known.name : (folder.displayName || 'Folder'),
    path: folder.displayName || '',
    kind,
    unread,
    total: Number(folder.totalItemCount || 0),
    parentId: folder.parentFolderId || null,
    depth,
    wellKnownName: (folder.wellKnownName || '').toLowerCase(),
  };
}

async function readChildFolders(account, parentId, depth, into) {
  if (depth > 4) return;
  let url = `/me/mailFolders/${encodeURIComponent(parentId)}/childFolders?$top=100`;
  while (url) {
    const data = await graph(account, 'GET', url);
    for (const folder of data.value || []) {
      into.push(mapFolder(folder, depth));
      if (folder.childFolderCount) await readChildFolders(account, folder.id, depth + 1, into);
    }
    url = data['@odata.nextLink'] || '';
  }
}

async function listFolders(account) {
  const folders = [];
  let url = '/me/mailFolders?$top=100';
  while (url) {
    const data = await graph(account, 'GET', url);
    for (const folder of data.value || []) {
      const mapped = mapFolder(folder, 0);
      if (mapped.kind === 'custom' && /^(conversation history|sync issues|outbox|rss|search folders)$/i.test(mapped.name)) {
        continue;
      }
      folders.push(mapped);
      if (folder.childFolderCount) {
        try {
          await readChildFolders(account, folder.id, 1, folders);
        } catch {
          // A child folder the account cannot list should not hide the mailbox.
        }
      }
    }
    url = data['@odata.nextLink'] || '';
  }
  folders.push({
    id: 'flagged',
    name: 'Flagged',
    path: 'Flagged',
    kind: 'flagged',
    unread: 0,
    total: 0,
    parentId: null,
    depth: 0,
    virtual: true,
  });
  return folders.sort((a, b) => {
    const order = { inbox: 0, drafts: 1, sent: 2, flagged: 3, junk: 4, trash: 5, archive: 6, custom: 7 };
    const delta = (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
    if (delta) return delta;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.name.localeCompare(b.name);
  });
}

function hexForPreset(preset) {
  return PRESET_HEX[preset] || TAG_COLORS.blue;
}

async function listTags(account) {
  const data = await graph(account, 'GET', '/me/outlook/masterCategories');
  return (data.value || [])
    .filter((item) => item.displayName)
    .map((item) => ({
      id: item.id || item.displayName,
      name: item.displayName,
      color: hexForPreset(item.color),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function summaryFromMessage(message, tagColors) {
  const categories = message.categories || [];
  return {
    id: message.id,
    threadId: message.conversationId || '',
    subject: message.subject || '(no subject)',
    from: person(message.from || message.sender),
    to: people(message.toRecipients),
    cc: people(message.ccRecipients),
    date: message.receivedDateTime || new Date().toISOString(),
    snippet: message.bodyPreview || '',
    unread: message.isRead === false,
    flagged: Boolean(message.flag && message.flag.flagStatus === 'flagged'),
    tags: categories.map((name) => ({
      id: name,
      name,
      color: tagColors.get(name) || TAG_COLORS.blue,
    })),
    hasAttachments: Boolean(message.hasAttachments),
    folderId: message.parentFolderId || '',
  };
}

const tagBurst = new Map();

async function tagColorMap(account) {
  const hit = tagBurst.get(account.id);
  if (hit && Date.now() - hit.at < 60000) return hit.promise;
  const promise = listTags(account)
    .then((tags) => new Map(tags.map((tag) => [tag.name, tag.color])))
    .catch(() => new Map());
  tagBurst.set(account.id, { at: Date.now(), promise });
  return promise;
}

async function listMessages(account, folderId, options = {}) {
  const tagColors = await tagColorMap(account);
  const params = new URLSearchParams();
  params.set('$top', String(Math.min(50, Math.max(1, Number(options.limit) || PAGE_SIZE))));
  params.set('$select', LIST_SELECT);
  const headers = {};
  const tag = options.tag ? String(options.tag) : '';
  const query = (options.query || '').trim();
  const unread = Boolean(options.unread);
  if (query) {
    headers.ConsistencyLevel = 'eventual';
    params.set('$count', 'true');
    params.set('$search', `"${query.replace(/"/g, '')}"`);
  } else if (unread) {
    const filter = tag
      ? `isRead eq false and categories/any(c:c eq '${odataQuote(tag)}')`
      : 'isRead eq false';
    params.set('$filter', filter);
    params.set('$orderby', 'receivedDateTime desc');
  } else if (folderId === 'flagged') {
    const filter = tag
      ? `flag/flagStatus eq 'flagged' and categories/any(c:c eq '${odataQuote(tag)}')`
      : "flag/flagStatus eq 'flagged'";
    params.set('$filter', filter);
  } else if (tag) {
    params.set('$filter', `categories/any(c:c eq '${odataQuote(tag)}')`);
  } else {
    params.set('$orderby', 'receivedDateTime desc');
  }

  let url;
  if (options.pageToken) {
    url = options.pageToken;
  } else if (unread || folderId === 'flagged') {
    url = `/me/messages?${params}`;
  } else {
    url = `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params}`;
  }
  let data;
  try {
    data = await graph(account, 'GET', url, { headers });
  } catch (error) {
    if (options.pageToken || query || !params.has('$orderby')) throw error;
    params.delete('$orderby');
    const retryUrl = unread || folderId === 'flagged'
      ? `/me/messages?${params}`
      : `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params}`;
    data = await graph(account, 'GET', retryUrl, { headers });
  }
  let messages = (data.value || []).map((message) => summaryFromMessage(message, tagColors));
  if (query && tag) messages = messages.filter((message) => message.tags.some((item) => item.name === tag));
  if (query && unread) messages = messages.filter((message) => message.unread);
  return { messages, nextPage: data['@odata.nextLink'] || null };
}

async function messagePlace(account, id) {
  try {
    const message = await graph(account, 'GET', `/me/messages/${encodeURIComponent(id)}?$select=id,parentFolderId`);
    return { found: true, folderId: message.parentFolderId || '' };
  } catch (error) {
    if (error && error.status === 404) return { found: false };
    throw error;
  }
}

async function getMessage(account, messageId) {
  const [message, tagColors] = await Promise.all([
    graph(account, 'GET', `/me/messages/${encodeURIComponent(messageId)}?$select=${FULL_SELECT}`, {
      headers: { Prefer: 'outlook.body-content-type="html"' },
    }),
    tagColorMap(account),
  ]);
  const summary = summaryFromMessage(message, tagColors);
  const body = message.body || {};
  const html = (body.contentType || '').toLowerCase() === 'html' ? (body.content || '') : '';
  const text = html ? stripHtml(html) : (body.content || '');
  let attachments = [];
  if (message.hasAttachments) {
    const listed = await graph(account, 'GET', `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,size,contentType,isInline`);
    attachments = (listed.value || [])
      .filter((item) => !item.isInline)
      .map((item) => ({
        id: item.id,
        name: item.name || 'attachment',
        size: Number(item.size || 0),
        contentType: item.contentType || 'application/octet-stream',
      }));
  }
  return {
    ...summary,
    hasAttachments: attachments.length > 0 || summary.hasAttachments,
    bcc: people(message.bccRecipients),
    bodyHtml: html || null,
    bodyText: text,
    attachments,
    internetMessageId: message.internetMessageId || '',
    references: '',
  };
}

async function batch(account, requests) {
  const responses = [];
  for (const group of chunk(requests, 20)) {
    const data = await graph(account, 'POST', '/$batch', {
      body: {
        requests: group.map((item) => ({
          id: item.id,
          method: item.method,
          url: item.url,
          headers: { 'Content-Type': 'application/json' },
          body: item.body,
        })),
      },
    });
    responses.push(...(data.responses || []));
  }
  return responses;
}

async function patchEach(account, ids, body) {
  const clean = unique(ids);
  if (!clean.length) return { updated: [], failed: [] };
  try {
    const responses = await batch(account, clean.map((id, index) => ({
      id: String(index),
      method: 'PATCH',
      url: `/me/messages/${encodeURIComponent(id)}`,
      body,
    })));
    const updated = [];
    const failed = [];
    const seen = new Set();
    for (const response of responses) {
      const index = Number(response.id);
      if (!Number.isInteger(index) || index < 0 || index >= clean.length) continue;
      seen.add(index);
      if (response.status >= 200 && response.status < 300) updated.push(clean[index]);
      else failed.push({ id: clean[index], error: 'Outlook could not update this message.' });
    }
    clean.forEach((id, index) => {
      if (!seen.has(index)) failed.push({ id, error: 'Outlook did not return a result.' });
    });
    return { updated, failed };
  } catch {
    return mapFailures(clean, (id) => graph(account, 'PATCH', `/me/messages/${encodeURIComponent(id)}`, { body }));
  }
}

function setRead(account, ids, read) {
  return patchEach(account, ids, { isRead: Boolean(read) });
}

function setFlag(account, ids, flagged) {
  return patchEach(account, ids, { flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } });
}

async function removeMessages(account, ids, options = {}) {
  const clean = unique(ids);
  if (options.permanent) {
    return mapFailures(clean, (id) => graph(account, 'DELETE', `/me/messages/${encodeURIComponent(id)}`));
  }
  return mapFailures(clean, (id) => graph(account, 'POST', `/me/messages/${encodeURIComponent(id)}/move`, {
    body: { destinationId: 'deleteditems' },
  }));
}

async function moveMessages(account, ids, destinationId) {
  const clean = unique(ids);
  if (destinationId === 'deleteditems' || destinationId === 'trash') {
    return removeMessages(account, clean, { permanent: false });
  }
  return mapFailures(clean, (id) => graph(account, 'POST', `/me/messages/${encodeURIComponent(id)}/move`, {
    body: { destinationId },
  }));
}

function archiveMessages(account, ids) {
  return moveMessages(account, ids, 'archive');
}

async function setTags(account, messageId, tagNames) {
  await graph(account, 'PATCH', `/me/messages/${encodeURIComponent(messageId)}`, {
    body: { categories: unique(tagNames) },
  });
  return getMessage(account, messageId);
}

async function createFolder(account, name, parentId) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Enter a folder name.');
  const path = parentId && parentId !== 'flagged'
    ? `/me/mailFolders/${encodeURIComponent(parentId)}/childFolders`
    : '/me/mailFolders';
  const created = await graph(account, 'POST', path, { body: { displayName: clean } });
  return mapFolder(created, parentId ? 1 : 0);
}

async function createTag(account, name, color) {
  const clean = String(name || '').trim();
  if (!clean || clean.includes(',')) throw new Error('Enter a tag name.');
  const key = colorKey(color);
  try {
    const created = await graph(account, 'POST', '/me/outlook/masterCategories', {
      body: { displayName: clean, color: OUTLOOK_CATEGORY_PRESETS[key] },
    });
    return {
      id: created.id || clean,
      name: created.displayName || clean,
      color: hexForPreset(created.color),
    };
  } catch (error) {
    if (/already exists|ErrorDuplicate|conflict/i.test(error.message)) {
      throw new Error(`Tag "${clean}" already exists.`);
    }
    throw error;
  }
}

function graphRecipients(value) {
  return parseAddressList(value).map((person) => ({
    emailAddress: { address: person.email, name: person.name || undefined },
  }));
}

async function send(account, draft) {
  const to = graphRecipients(draft.to);
  if (!to.length) throw new Error('Add at least one recipient.');
  const mode = draft.mode || 'new';
  const message = {
    subject: draft.subject || '',
    body: { contentType: 'HTML', content: draft.html || '' },
    toRecipients: to,
    ccRecipients: graphRecipients(draft.cc),
    bccRecipients: graphRecipients(draft.bcc),
  };
  if (mode === 'new' || !draft.messageId) {
    await graph(account, 'POST', '/me/sendMail', { body: { message, saveToSentItems: true } });
    return { sent: true };
  }
  const action = mode === 'replyAll' ? 'createReplyAll' : mode === 'forward' ? 'createForward' : 'createReply';
  let created;
  try {
    created = await graph(account, 'POST', `/me/messages/${encodeURIComponent(draft.messageId)}/${action}`, { body: {} });
  } catch (error) {
    if (mode === 'forward') throw error;
    await graph(account, 'POST', '/me/sendMail', { body: { message, saveToSentItems: true } });
    return { sent: true };
  }
  await graph(account, 'PATCH', `/me/messages/${encodeURIComponent(created.id)}`, { body: message });
  await graph(account, 'POST', `/me/messages/${encodeURIComponent(created.id)}/send`, { body: {} });
  return { sent: true };
}

async function getAttachment(account, messageId, attachmentId) {
  const data = await graph(
    account,
    'GET',
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  if (!data.contentBytes) throw new Error('This attachment cannot be saved from Outlook.');
  return {
    name: data.name || 'attachment',
    buffer: Buffer.from(data.contentBytes, 'base64'),
  };
}

async function mapFailures(ids, fn) {
  const updated = [];
  const failed = [];
  await mapPool(ids, 4, async (id) => {
    try {
      await fn(id);
      updated.push(id);
    } catch (error) {
      failed.push({ id, error: error.message });
    }
  });
  return { updated, failed };
}

async function listPinned(account, folderId) {
  if (!folderId || folderId === 'flagged') return [];
  const tagColors = await tagColorMap(account);
  const groups = await Promise.all(['0x0F01', '0x0F02'].map(async (tag) => {
    const params = new URLSearchParams();
    params.set('$top', '50');
    params.set('$select', LIST_SELECT);
    params.set('$count', 'true');
    params.set('$filter', `singleValueExtendedProperties/any(ep: ep/id eq 'SystemTime ${tag}' and cast(ep/value, Edm.DateTimeOffset) gt 4000-01-01T00:00:00Z)`);
    try {
      const data = await graph(account, 'GET', `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params}`, {
        headers: { ConsistencyLevel: 'eventual' },
      });
      return data.value || [];
    } catch {
      return [];
    }
  }));
  const seen = new Set();
  const messages = [];
  for (const message of groups.flat()) {
    if (!message || !message.id || seen.has(message.id)) continue;
    seen.add(message.id);
    const summary = summaryFromMessage(message, tagColors);
    summary.pinned = true;
    messages.push(summary);
  }
  return messages;
}

async function fetchSummaries(account, ids) {
  const clean = unique(ids).slice(0, 30);
  if (!clean.length) return [];
  const tagColors = await tagColorMap(account);
  const responses = await batch(account, clean.map((id, index) => ({
    id: String(index),
    method: 'GET',
    url: `/me/messages/${encodeURIComponent(id)}?$select=${LIST_SELECT}`,
  })));
  const messages = [];
  for (const response of responses) {
    if (!response || response.status >= 300 || !response.body) continue;
    messages.push(summaryFromMessage(response.body, tagColors));
  }
  return messages;
}

function setPinned(account, ids, pinned) {
  const stamp = pinned ? '4500-09-01T00:00:00Z' : new Date().toISOString();
  return patchEach(account, ids, {
    singleValueExtendedProperties: [
      { id: 'SystemTime 0x0F01', value: stamp },
      { id: 'SystemTime 0x0F02', value: stamp },
    ],
  });
}

module.exports = {
  listFolders,
  listTags,
  listMessages,
  messagePlace,
  listPinned,
  fetchSummaries,
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
