'use strict';

const { withToken } = require('../auth/oauth');
const {
  GMAIL_LABEL_COLORS,
  unique,
  mapPool,
  decodeBase64Url,
  encodeBase64Url,
  decodeEntities,
  stripHtml,
  encodeHeader,
  parseAddressList,
  formatAddressList,
  wrap76,
  colorKey,
  parseHttpBatch,
  requestJson,
} = require('../shared/util');

const PAGE_SIZE = 30;
const GMAIL_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SYSTEM_KIND = {
  INBOX: 'inbox',
  SENT: 'sent',
  DRAFT: 'drafts',
  SPAM: 'junk',
  TRASH: 'trash',
  STARRED: 'flagged',
};

const SYSTEM_ORDER = ['INBOX', 'DRAFT', 'SENT', 'STARRED', 'SPAM', 'TRASH'];
const HIDDEN_SYSTEM = new Set([
  'UNREAD', 'IMPORTANT', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'YELLOW_STAR',
]);

async function gmail(account, path, options = {}) {
  return withToken(account, (token) => requestJson(`${GMAIL_ROOT}${path}`, { ...options, token }));
}

const labelBurst = new Map();

async function fetchLabels(account, options = {}) {
  if (options.fresh) labelBurst.delete(account.id);
  const hit = labelBurst.get(account.id);
  if (hit && Date.now() - hit.at < 60000) return hit.promise;
  const promise = gmail(account, '/labels').then((data) => data.labels || []);
  labelBurst.set(account.id, { at: Date.now(), promise });
  promise.catch(() => labelBurst.delete(account.id));
  return promise;
}

function dropLabels(account) {
  labelBurst.delete(account.id);
}

async function gmailBatch(account, paths) {
  const slices = [];
  for (let start = 0; start < paths.length; start += 50) slices.push(paths.slice(start, start + 50));
  const groups = await Promise.all(slices.map((slice) => gmailBatchOnce(account, slice)));
  return groups.flat();
}

async function gmailBatchOnce(account, paths) {
  if (!paths.length) return [];
  const boundary = `smart_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const body = `${paths.map((path, index) => (
    `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m${index}>\r\n\r\nGET ${path} HTTP/1.1\r\n\r\n`
  )).join('')}--${boundary}--\r\n`;
  return withToken(account, async (token) => {
    const response = await fetch('https://www.googleapis.com/batch/gmail/v1', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`Gmail batch failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const found = (response.headers.get('content-type') || '').match(/boundary="?([^=";]+)"?/i);
    const parts = parseHttpBatch(text, found ? found[1] : boundary);
    const byId = new Map(parts.filter((part) => part.id).map((part) => [part.id, part]));
    const useIndex = byId.size === 0;
    return paths.map((path, index) => {
      const part = byId.get(`m${index}`) || (useIndex ? parts[index] : null);
      return part && part.data && part.status < 400 ? part.data : null;
    });
  });
}

function tagFromLabel(label) {
  const background = label.color && label.color.backgroundColor;
  return {
    id: label.id,
    name: label.name,
    color: background || '#4a86e8',
  };
}

function folderUnread(kind, count) {
  if (kind === 'drafts' || kind === 'sent') return 0;
  return Math.max(0, Number(count) || 0);
}

function folderFromLabel(label) {
  const full = label.name || label.id;
  const parts = String(full).split('/');
  if (label.type === 'system') {
    const kind = SYSTEM_KIND[label.id];
    return {
      id: label.id,
      name: systemName(label.id),
      path: label.id,
      kind,
      unread: folderUnread(kind, label.messagesUnread),
      total: Number(label.messagesTotal || 0),
      parentId: null,
      depth: 0,
    };
  }
  return {
    id: label.id,
    name: parts[parts.length - 1],
    path: full,
    kind: 'custom',
    unread: folderUnread('custom', label.messagesUnread),
    total: Number(label.messagesTotal || 0),
    parentId: null,
    depth: Math.max(0, parts.length - 1),
  };
}

function systemName(id) {
  return {
    INBOX: 'Inbox',
    SENT: 'Sent',
    DRAFT: 'Drafts',
    SPAM: 'Junk',
    TRASH: 'Trash',
    STARRED: 'Starred',
  }[id] || id;
}

function sortFolders(folders) {
  return folders.sort((a, b) => {
    const ai = SYSTEM_ORDER.indexOf(a.id);
    const bi = SYSTEM_ORDER.indexOf(b.id);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.path.localeCompare(b.path);
  });
}

async function fillFolderCounts(account, folders) {
  if (!folders.length) return folders;
  const paths = folders.map((folder) => `/gmail/v1/users/me/labels/${encodeURIComponent(folder.id)}`);
  const details = await gmailBatch(account, paths);
  for (let index = 0; index < folders.length; index += 1) {
    const detail = details[index];
    if (!detail) continue;
    folders[index].unread = folderUnread(folders[index].kind, detail.messagesUnread);
    folders[index].total = Number(detail.messagesTotal || 0);
  }
  return folders;
}

async function listFolders(account, options = {}) {
  const labels = await fetchLabels(account, options);
  const folders = [];
  for (const label of labels) {
    if (label.type === 'system') {
      if (!SYSTEM_KIND[label.id] || HIDDEN_SYSTEM.has(label.id)) continue;
      folders.push(folderFromLabel(label));
    } else {
      folders.push(folderFromLabel(label));
    }
  }
  const byPath = new Map(folders.filter((folder) => folder.kind === 'custom').map((folder) => [folder.path, folder.id]));
  for (const folder of folders) {
    if (folder.kind !== 'custom' || !folder.path.includes('/')) continue;
    const parentPath = folder.path.slice(0, folder.path.lastIndexOf('/'));
    folder.parentId = byPath.get(parentPath) || null;
  }
  try {
    await fillFolderCounts(account, folders);
  } catch {
    // Label names still show when Gmail omits per-label counts.
  }
  return sortFolders(folders);
}

async function listTags(account, options = {}) {
  const labels = await fetchLabels(account, options);
  return labels
    .filter((label) => label.type === 'user')
    .map(tagFromLabel)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function headerMap(payload) {
  const headers = {};
  for (const header of (payload && payload.headers) || []) {
    if (header.name) headers[header.name.toLowerCase()] = header.value || '';
  }
  return headers;
}

function summaryFromMessage(message, labelMap) {
  const headers = headerMap(message.payload);
  const labelIds = message.labelIds || [];
  const tags = labelIds
    .map((id) => labelMap.get(id))
    .filter((label) => label && label.type === 'user')
    .map(tagFromLabel);
  const from = parseAddressList(headers.from)[0] || { name: '', email: '' };
  const internal = Number(message.internalDate || 0);
  const parsedHeader = Date.parse(headers.date || '');
  const date = internal ? new Date(internal).toISOString() : new Date(Number.isNaN(parsedHeader) ? Date.now() : parsedHeader).toISOString();
  return {
    id: message.id,
    threadId: message.threadId || '',
    subject: headers.subject || '(no subject)',
    from,
    to: parseAddressList(headers.to),
    cc: parseAddressList(headers.cc),
    date,
    snippet: decodeEntities(message.snippet || ''),
    unread: labelIds.includes('UNREAD'),
    flagged: labelIds.includes('STARRED'),
    folderId: gmailFolderId(labelIds),
    tags,
    hasAttachments: (message.payload && hasAttachment(message.payload)) || false,
  };
}

function gmailFolderId(labelIds) {
  const preferred = ['INBOX', 'SPAM', 'TRASH', 'SENT', 'DRAFT'];
  for (const id of preferred) {
    if (labelIds.includes(id)) return id;
  }
  return labelIds.find((id) => id !== 'UNREAD' && id !== 'STARRED' && id !== 'IMPORTANT' && !id.startsWith('CATEGORY_')) || '';
}

function hasAttachment(part) {
  if (part.filename) return true;
  return (part.parts || []).some(hasAttachment);
}

async function listMessages(account, folderId, options = {}) {
  const params = new URLSearchParams();
  params.set('maxResults', String(Math.min(100, Math.max(1, Number(options.limit) || PAGE_SIZE))));
  if (!options.unread) params.append('labelIds', folderId || 'INBOX');
  const labelsPromise = fetchLabels(account);
  const listingPromise = (async () => {
    if (options.tag) {
      const labels = await labelsPromise;
      const tagLabel = labels.find((label) => label.type === 'user' && label.name === options.tag);
      if (tagLabel) params.append('labelIds', tagLabel.id);
    }
    const search = [options.unread ? 'is:unread' : '', options.query || ''].filter(Boolean).join(' ');
    if (search) params.set('q', search);
    if (options.pageToken) params.set('pageToken', options.pageToken);
    return gmail(account, `/messages?${params}`);
  })();
  const [listing, labels] = await Promise.all([listingPromise, labelsPromise]);
  const labelMap = new Map(labels.map((label) => [label.id, label]));
  const ids = (listing.messages || []).map((item) => item.id);
  const headerList = ['From', 'To', 'Cc', 'Subject', 'Date'].map((name) => `metadataHeaders=${encodeURIComponent(name)}`).join('&');
  const fields = 'id,threadId,labelIds,snippet,internalDate,payload(headers)';
  const query = encodeURIComponent(fields);
  const detailPath = (id) => `/messages/${encodeURIComponent(id)}?format=metadata&${headerList}&fields=${query}`;
  const paths = ids.map((id) => `/gmail/v1/users/me${detailPath(id)}`);
  let hydrated = [];
  try {
    const messages = ids.length ? await gmailBatch(account, paths) : [];
    hydrated = messages.map((message) => {
      if (!message) return null;
      try {
        return summaryFromMessage(message, labelMap);
      } catch {
        return null;
      }
    });
  } catch {
    hydrated = ids.map(() => null);
  }
  const missing = ids.filter((id, index) => !hydrated[index]);
  if (missing.length) {
    const recovered = await mapPool(missing, 8, async (id) => {
      try {
        const message = await gmail(account, detailPath(id));
        return summaryFromMessage(message, labelMap);
      } catch {
        try {
          const message = await gmail(account, `/messages/${encodeURIComponent(id)}?format=full`);
          return summaryFromMessage(message, labelMap);
        } catch {
          return null;
        }
      }
    });
    const byId = new Map(recovered.filter(Boolean).map((message) => [message.id, message]));
    hydrated = ids.map((id, index) => hydrated[index] || byId.get(id) || null);
  }
  const messages = ids.map((id, index) => hydrated[index] || {
    id,
    threadId: (listing.messages[index] && listing.messages[index].threadId) || '',
    subject: '(no subject)',
    from: { name: '', email: '' },
    to: [],
    cc: [],
    date: '',
    snippet: '',
    unread: false,
    flagged: false,
    folderId: folderId || 'INBOX',
    tags: [],
    hasAttachments: false,
  });
  return {
    messages,
    nextPage: listing.nextPageToken || null,
  };
}

async function messagePlace(account, id) {
  try {
    const message = await gmail(account, `/messages/${encodeURIComponent(id)}?format=minimal&fields=${encodeURIComponent('id,labelIds')}`);
    return { found: true, labels: message.labelIds || [] };
  } catch (error) {
    if (error && error.status === 404) return { found: false };
    throw error;
  }
}

async function fetchSummaries(account, ids) {
  const clean = unique(ids).filter(Boolean).slice(0, 30);
  if (!clean.length) return [];
  const labels = await fetchLabels(account);
  const labelMap = new Map(labels.map((label) => [label.id, label]));
  const headerList = ['From', 'To', 'Cc', 'Subject', 'Date'].map((name) => `metadataHeaders=${encodeURIComponent(name)}`).join('&');
  const fields = encodeURIComponent('id,threadId,labelIds,snippet,internalDate,payload(headers)');
  const found = await mapPool(clean, 6, async (id) => {
    try {
      const message = await gmail(account, `/messages/${encodeURIComponent(id)}?format=metadata&${headerList}&fields=${fields}`);
      return summaryFromMessage(message, labelMap);
    } catch {
      return null;
    }
  });
  return found.filter(Boolean);
}

function extractContent(payload) {
  let html = '';
  let text = '';
  const attachments = [];

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    const filename = part.filename || '';
    const body = part.body || {};
    const isText = mime === 'text/plain' || mime === 'text/html';
    if (filename || (body.attachmentId && !isText && !mime.startsWith('multipart/'))) {
      attachments.push({
        id: body.attachmentId || '',
        name: filename || 'attachment',
        size: Number(body.size || 0),
        contentType: mime || 'application/octet-stream',
      });
    } else if (body.data && mime === 'text/html') {
      try {
        html += decodeBase64Url(body.data).toString('utf8');
      } catch {
        html += '';
      }
    } else if (body.data && mime === 'text/plain') {
      try {
        text += decodeBase64Url(body.data).toString('utf8');
      } catch {
        text += '';
      }
    }
    for (const child of part.parts || []) walk(child);
  }

  walk(payload);
  return { html: html.trim(), text: text.trim(), attachments };
}

async function getMessage(account, messageId) {
  const [message, labels] = await Promise.all([
    gmail(account, `/messages/${encodeURIComponent(messageId)}?format=full`),
    fetchLabels(account),
  ]);
  const labelMap = new Map(labels.map((label) => [label.id, label]));
  const summary = summaryFromMessage(message, labelMap);
  const content = extractContent(message.payload);
  const headers = headerMap(message.payload);
  summary.hasAttachments = content.attachments.length > 0;
  return {
    ...summary,
    bcc: parseAddressList(headers.bcc),
    bodyHtml: content.html || null,
    bodyText: content.text || (content.html ? stripHtml(content.html) : ''),
    attachments: content.attachments,
    internetMessageId: headers['message-id'] || '',
    references: headers.references || '',
  };
}

async function modify(account, ids, addLabelIds, removeLabelIds) {
  dropLabels(account);
  const clean = unique(ids);
  if (!clean.length) return { updated: [], failed: [] };
  try {
    const body = { ids: clean };
    if (addLabelIds && addLabelIds.length) body.addLabelIds = addLabelIds;
    if (removeLabelIds && removeLabelIds.length) body.removeLabelIds = removeLabelIds;
    if (!body.addLabelIds && !body.removeLabelIds) return { updated: clean, failed: [] };
    await gmail(account, '/messages/batchModify', { method: 'POST', body });
    return { updated: clean, failed: [] };
  } catch (error) {
    return { updated: [], failed: clean.map((id) => ({ id, error: error.message })) };
  }
}

function setRead(account, ids, read) {
  return modify(account, ids, read ? [] : ['UNREAD'], read ? ['UNREAD'] : []);
}

function setFlag(account, ids, flagged) {
  return modify(account, ids, flagged ? ['STARRED'] : [], flagged ? [] : ['STARRED']);
}

async function removeMessages(account, ids, options = {}) {
  const clean = unique(ids);
  if (options.permanent || options.folderId === 'TRASH') {
    return mapFailures(clean, (id) => gmail(account, `/messages/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  }
  return mapFailures(clean, (id) => gmail(account, `/messages/${encodeURIComponent(id)}/trash`, { method: 'POST' }));
}

async function moveMessages(account, ids, destinationId, sourceFolderId) {
  const clean = unique(ids);
  if (!clean.length) return { updated: [], failed: [] };
  if (destinationId === 'TRASH') return removeMessages(account, clean, { permanent: false });
  if (sourceFolderId === 'TRASH') {
    const untrashed = await mapFailures(clean, (id) => gmail(account, `/messages/${encodeURIComponent(id)}/untrash`, { method: 'POST' }));
    if (!untrashed.updated.length) return untrashed;
    const moved = await modify(account, untrashed.updated, destinationId === 'STARRED' ? ['STARRED'] : [destinationId], []);
    return { updated: moved.updated, failed: [...untrashed.failed, ...moved.failed] };
  }
  const remove = [];
  if (sourceFolderId && sourceFolderId !== destinationId && sourceFolderId !== 'STARRED') {
    remove.push(sourceFolderId);
  }
  const add = destinationId === 'STARRED' ? ['STARRED'] : [destinationId];
  return modify(account, clean, add, remove);
}

function archiveMessages(account, ids) {
  return modify(account, ids, [], ['INBOX']);
}

async function setTags(account, messageId, tagNames) {
  const labels = await fetchLabels(account);
  const wanted = new Set(tagNames || []);
  const userLabels = labels.filter((label) => label.type === 'user');
  const message = await gmail(account, `/messages/${encodeURIComponent(messageId)}?format=minimal`);
  const current = new Set(message.labelIds || []);
  const add = [];
  const remove = [];
  for (const label of userLabels) {
    const has = current.has(label.id);
    const should = wanted.has(label.name);
    if (should && !has) add.push(label.id);
    if (!should && has) remove.push(label.id);
  }
  const missing = [...wanted].filter((name) => !userLabels.some((label) => label.name === name));
  if (missing.length) {
    throw new Error(`Unknown tag: ${missing[0]}`);
  }
  if (add.length || remove.length) {
    const result = await modify(account, [messageId], add, remove);
    if (result.failed.length) throw new Error(result.failed[0].error || 'Gmail could not update the tags.');
  }
  return getMessage(account, messageId);
}

async function createFolder(account, name, parentId) {
  const clean = String(name || '').trim();
  if (!clean || clean.includes('/')) throw new Error('Enter a folder name without slashes.');
  const labels = await fetchLabels(account);
  let fullName = clean;
  if (parentId) {
    const parent = labels.find((label) => label.id === parentId && label.type === 'user');
    if (parent) fullName = `${parent.name}/${clean}`;
  }
  const created = await gmail(account, '/labels', {
    method: 'POST',
    body: {
      name: fullName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  dropLabels(account);
  return folderFromLabel(created);
}

async function createTag(account, name, color) {
  const clean = String(name || '').trim();
  if (!clean || clean.includes(',')) throw new Error('Enter a tag name.');
  const key = colorKey(color);
  try {
    const created = await gmail(account, '/labels', {
      method: 'POST',
      body: {
        name: clean,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
        color: GMAIL_LABEL_COLORS[key],
      },
    });
    dropLabels(account);
    return tagFromLabel(created);
  } catch (error) {
    if (/exists|conflict|409/i.test(error.message)) throw new Error(`Tag "${clean}" already exists.`);
    const created = await gmail(account, '/labels', {
      method: 'POST',
      body: {
        name: clean,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    dropLabels(account);
    return tagFromLabel(created);
  }
}

async function send(account, draft) {
  const to = parseAddressList(draft.to);
  const cc = parseAddressList(draft.cc);
  const bcc = parseAddressList(draft.bcc);
  if (!to.length) throw new Error('Add at least one recipient.');
  const mode = draft.mode || 'new';
  const lines = [
    `From: ${account.email}`,
    `To: ${formatAddressList(to)}`,
  ];
  if (cc.length) lines.push(`Cc: ${formatAddressList(cc)}`);
  if (bcc.length) lines.push(`Bcc: ${formatAddressList(bcc)}`);
  lines.push(`Subject: ${encodeHeader(draft.subject || '')}`);
  if (draft.internetMessageId && (mode === 'reply' || mode === 'replyAll')) {
    lines.push(`In-Reply-To: ${draft.internetMessageId}`);
    const references = [draft.references, draft.internetMessageId].filter(Boolean).join(' ');
    lines.push(`References: ${references}`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(wrap76(Buffer.from(draft.html || '', 'utf8').toString('base64')));
  const raw = encodeBase64Url(Buffer.from(lines.join('\r\n'), 'utf8'));
  const body = { raw };
  if (draft.threadId && (mode === 'reply' || mode === 'replyAll')) body.threadId = draft.threadId;
  await gmail(account, '/messages/send', { method: 'POST', body });
  return { sent: true };
}

async function getAttachment(account, messageId, attachmentId) {
  const message = await getMessage(account, messageId);
  const meta = message.attachments.find((item) => item.id === attachmentId);
  if (!meta || !attachmentId) throw new Error('That attachment is no longer available.');
  const data = await gmail(
    account,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  return { name: meta.name, buffer: decodeBase64Url(data.data || '') };
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

module.exports = {
  listFolders,
  listTags,
  listMessages,
  messagePlace,
  fetchSummaries,
  getMessage,
  setRead,
  setFlag,
  removeMessages,
  moveMessages,
  archiveMessages,
  setTags,
  createFolder,
  createTag,
  send,
  getAttachment,
};
