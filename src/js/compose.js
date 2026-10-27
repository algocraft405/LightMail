'use strict';

function dedupePeople(list) {
  const out = [];
  const seen = new Set();
  for (const person of list || []) {
    const email = (person.email || '').toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(person);
  }
  return out;
}

function replyRecipients(message, mode, selfEmail) {
  const self = (selfEmail || '').toLowerCase();
  const keep = (person) => person.email && person.email.toLowerCase() !== self;
  if (mode === 'reply') {
    const from = message.from && message.from.email ? [message.from] : [];
    return { to: from.length ? from : dedupePeople(message.to).filter(keep), cc: [] };
  }
  if (mode === 'replyAll') {
    let to = dedupePeople([message.from, ...(message.to || [])]).filter(keep);
    if (!to.length) to = dedupePeople(message.to);
    const cc = dedupePeople(message.cc).filter(keep).filter((person) => (
      !to.some((item) => item.email.toLowerCase() === person.email.toLowerCase())
    ));
    return { to, cc };
  }
  return { to: [], cc: [] };
}

function withPrefix(subject, prefix) {
  const value = !subject || subject === '(no subject)' ? '' : subject;
  const word = prefix.replace(':', '');
  if (new RegExp(`^${word}:\\s`, 'i').test(value)) return value;
  return `${prefix} ${value}`.trim();
}

function quoteBlock(message, mode) {
  const when = formatFull(message.date);
  const from = formatPerson(message.from) || 'someone';
  const body = message.bodyHtml ? sanitizeHtml(message.bodyHtml, false) : `<pre>${esc(message.bodyText || '')}</pre>`;
  if (mode === 'forward') {
    return `<p><br></p><p>---------- Forwarded message ----------<br>From: ${esc(from)}<br>Date: ${esc(when)}<br>Subject: ${esc(message.subject || '')}<br>To: ${esc(peopleLine(message.to))}</p><blockquote>${body}</blockquote>`;
  }
  return `<p><br></p><p>On ${esc(when)}, ${esc(from)} wrote:</p><blockquote>${body}</blockquote>`;
}

async function openCompose(mode) {
  const owner = mode === 'new' ? state.accountId : ownerId(state.activeId);
  const account = state.accounts.find((item) => item.id === owner) || currentAccount();
  if (!account) {
    openAccounts();
    return;
  }
  let message = null;
  if (mode !== 'new') {
    if (!state.activeId) return;
    if (!state.active || state.active.id !== state.activeId || state.active.error) {
      message = await call(() => api.getMessage(ownerId(state.activeId), state.activeId));
      state.active = message;
    } else {
      message = state.active;
    }
  }
  const recipients = message ? replyRecipients(message, mode, account.email) : { to: [], cc: [] };
  state.compose = {
    mode,
    to: formatPeople(recipients.to),
    cc: formatPeople(recipients.cc),
    bcc: '',
    subject: message ? withPrefix(message.subject, mode === 'forward' ? 'FW:' : 'RE:') : '',
    html: message ? quoteBlock(message, mode) : '',
    showCc: Boolean(recipients.cc.length),
    messageId: message ? message.id : '',
    threadId: message ? message.threadId : '',
    internetMessageId: message ? message.internetMessageId : '',
    references: message ? message.references : '',
    accountId: account.id,
  };
  state.modal = 'compose';
  renderCompose();
}

function renderCompose() {
  const compose = state.compose;
  if (!compose) return;
  const titles = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' };
  document.getElementById('modal-root').innerHTML = `<div class="backdrop"><div class="dialog compose" role="dialog" aria-modal="true">
    <header>
      <h2>${titles[compose.mode] || 'Message'}</h2>
      <button type="button" class="cmd primary" data-action="send">Send</button>
      <button type="button" class="cmd" data-action="close-modal">Discard</button>
    </header>
    <div class="compose-row"><label>To</label><input id="compose-to" type="text" value="${esc(compose.to)}"><button type="button" class="linkish" data-action="toggle-cc">${compose.showCc ? 'Hide' : 'Cc'}</button></div>
    <div class="compose-row" ${compose.showCc ? '' : 'hidden'}><label>Cc</label><input id="compose-cc" type="text" value="${esc(compose.cc)}"></div>
    <div class="compose-row" ${compose.showCc ? '' : 'hidden'}><label>Bcc</label><input id="compose-bcc" type="text" value="${esc(compose.bcc)}"></div>
    <div class="compose-row"><label>Subject</label><input id="compose-subject" type="text" value="${esc(compose.subject)}"></div>
    <div id="compose-body" contenteditable="true" spellcheck="true"></div>
  </div></div>`;
  const body = document.getElementById('compose-body');
  body.innerHTML = compose.html || '';
  document.getElementById('compose-to').focus();
}

async function sendCompose() {
  const compose = state.compose;
  if (!compose) return;
  const sendButton = document.querySelector('[data-action="send"]');
  if (sendButton) sendButton.disabled = true;
  const payload = {
    to: document.getElementById('compose-to').value,
    cc: compose.showCc ? document.getElementById('compose-cc').value : '',
    bcc: compose.showCc ? document.getElementById('compose-bcc').value : '',
    subject: document.getElementById('compose-subject').value,
    html: sanitizeHtml(document.getElementById('compose-body').innerHTML, false),
    mode: compose.mode,
    messageId: compose.messageId,
    threadId: compose.threadId,
    internetMessageId: compose.internetMessageId,
    references: compose.references,
  };
  try {
    showProgress(true);
    await call(() => api.send(state.compose.accountId || state.accountId, payload));
    closeModal();
    toast('Message sent.');
    if (currentFolder() && (currentFolder().kind === 'sent' || currentFolder().kind === 'drafts')) {
      await loadMessages();
    }
  } catch (error) {
    if (sendButton) sendButton.disabled = false;
    toast(error.message);
  } finally {
    showProgress(false);
  }
}
