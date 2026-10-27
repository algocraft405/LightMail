'use strict';

function closeModal(confirmed) {
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  state.modal = null;
  state.compose = null;
  document.getElementById('modal-root').innerHTML = '';
  if (resolve) resolve(confirmed === true);
}

function confirmDialog(message, title, confirmLabel) {
  return new Promise((resolve) => {
    state.modal = 'confirm';
    state.confirmResolve = resolve;
    document.getElementById('modal-root').innerHTML = `<div class="backdrop"><div class="dialog" role="dialog" aria-modal="true" style="width:min(440px,100%)">
      <h2>${esc(title || 'Please confirm')}</h2>
      <p>${esc(message)}</p>
      <div class="dialog-actions">
        <button type="button" class="cmd" data-action="confirm-no">Cancel</button>
        <button type="button" class="cmd primary" data-action="confirm-yes">${esc(confirmLabel || 'Delete')}</button>
      </div>
    </div></div>`;
  });
}

function openFolderModal() {
  const account = currentAccount();
  if (!account) return;
  const parents = state.folders.filter((folder) => {
    if (folder.virtual || folder.kind === 'trash' || folder.kind === 'junk' || folder.kind === 'flagged') return false;
    if (account.provider === 'gmail' && folder.kind !== 'custom') return false;
    return true;
  });
  const options = ['<option value="">Top level</option>'].concat(parents.map((folder) => {
    const selected = folder.id === state.folderId ? ' selected' : '';
    return `<option value="${esc(folder.id)}"${selected}>${esc(folder.name)}</option>`;
  }));
  const hint = account.provider === 'gmail'
    ? 'Gmail stores folders as labels. A new folder is nested only when you pick another folder you created.'
    : 'The folder is created in this Outlook mailbox.';
  state.modal = 'folder';
  document.getElementById('modal-root').innerHTML = `<div class="backdrop"><form class="dialog" role="dialog" style="width:min(460px,100%)">
    <h2>New folder</h2>
    <p class="hint">${hint}</p>
    <label class="field">Name<input id="folder-name" type="text" maxlength="120" required></label>
    <label class="field">Place inside<select id="folder-parent">${options.join('')}</select></label>
    <div class="dialog-actions">
      <button type="button" class="cmd" data-action="close-modal">Cancel</button>
      <button type="submit" class="cmd primary" data-action="create-folder-submit">Create</button>
    </div>
  </form></div>`;
  document.getElementById('folder-name').focus();
}

function openTagModal() {
  const account = currentAccount();
  if (!account) return;
  state.tagColor = 'blue';
  state.modal = 'tag';
  const swatches = COLORS.map(([key, hex]) => `<button type="button" class="swatch-btn${key === 'blue' ? ' picked' : ''}" style="background:${hex}" data-action="pick-color" data-color="${key}" aria-label="${key}"></button>`).join('');
  const hint = account.provider === 'gmail'
    ? 'On Gmail, a tag is a label. It can sit on a message together with a folder.'
    : 'On Outlook, a tag is a category. Moving the message does not remove it.';
  document.getElementById('modal-root').innerHTML = `<div class="backdrop"><form class="dialog" role="dialog" style="width:min(460px,100%)">
    <h2>New tag</h2>
    <p class="hint">${hint}</p>
    <label class="field">Name<input id="tag-name" type="text" maxlength="80" required></label>
    <div class="field">Color<div class="swatches">${swatches}</div></div>
    <div class="dialog-actions">
      <button type="button" class="cmd" data-action="close-modal">Cancel</button>
      <button type="submit" class="cmd primary" data-action="create-tag-submit">Create</button>
    </div>
  </form></div>`;
  document.getElementById('tag-name').focus();
}

async function createFolder() {
  const name = document.getElementById('folder-name').value.trim();
  const parentId = document.getElementById('folder-parent').value;
  if (!name) return;
  await call(() => api.createFolder(state.accountId, name, parentId || null));
  closeModal();
  await refreshFolders();
  toast('Folder created.');
}

async function createTag() {
  const name = document.getElementById('tag-name').value.trim();
  if (!name) return;
  await call(() => api.createTag(state.accountId, name, state.tagColor));
  closeModal();
  await refreshFolders();
  toast('Tag created.');
}

function fieldValue(id, fallback) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : (fallback || '');
}

async function saveProviderSettings() {
  const current = state.settings || { google: {}, outlook: {} };
  const settings = await call(() => api.saveSettings({
    google: {
      clientId: fieldValue('google-client-id', current.google.clientId),
      clientSecret: fieldValue('google-client-secret', current.google.clientSecret),
      credentialsPath: current.google.credentialsPath || '',
    },
    outlook: {
      clientId: fieldValue('outlook-client-id', current.outlook.clientId),
      clientSecret: fieldValue('outlook-client-secret', current.outlook.clientSecret),
      tenant: fieldValue('outlook-tenant', current.outlook.tenant || 'consumers'),
    },
  }));
  state.settings = settings;
}

function themePickStyle(colors) {
  return `--pick-bg:${colors.panel};--pick-ink:${colors.ink};--pick-line:${colors.lineStrong};--swatch:${colors.bg};--swatch-accent:${colors.accent}`;
}

function themePicker() {
  const theme = currentTheme();
  const color = theme.id === 'custom' && theme.color ? theme.color : themeColors(theme).bg;
  const picks = Object.entries(THEMES).map(([id, item]) => (
    `<button type="button" class="theme-pick${theme.id === id ? ' on' : ''}" data-action="set-theme" data-id="${id}" style="${themePickStyle(item)}">
      <span class="theme-swatch" style="background:${item.bg}"></span>
      <strong>${esc(item.name)}</strong>
    </button>`
  )).join('');
  const custom = customPalette(color);
  return `<div class="theme-picks">${picks}
    <button type="button" class="theme-pick${theme.id === 'custom' ? ' on' : ''}" data-action="set-theme" data-id="custom" style="${themePickStyle(custom)}">
      <span class="theme-swatch" style="background:${custom.bg}"></span>
      <strong>Custom</strong>
    </button>
  </div>
  <label class="field">Background color<input id="theme-color" type="color" value="${esc(color)}"></label>
  <p id="theme-image-hint" class="hint">${theme.image ? 'A background image is in use.' : 'Optional picture behind the chrome.'}</p>
  <div class="settings-actions">
    <button type="button" class="cmd" data-action="pick-wallpaper">Choose background image</button>
    <button type="button" class="cmd" data-action="clear-wallpaper"${theme.image ? '' : ' disabled'}>Remove image</button>
  </div>`;
}

function paintThemePicks() {
  const theme = currentTheme();
  const colors = themeColors(theme);
  document.querySelectorAll('.theme-pick[data-id]').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.id === theme.id);
  });
  const customBtn = document.querySelector('.theme-pick[data-id="custom"]');
  if (customBtn) {
    const custom = theme.id === 'custom' ? colors : customPalette(theme.color || colors.bg);
    customBtn.setAttribute('style', themePickStyle(custom));
    const swatch = customBtn.querySelector('.theme-swatch');
    if (swatch) swatch.style.background = custom.bg;
  }
  const input = document.getElementById('theme-color');
  if (input) input.value = theme.id === 'custom' && theme.color ? theme.color : colors.bg;
  const hint = document.getElementById('theme-image-hint');
  if (hint) hint.textContent = theme.image ? 'A background image is in use.' : 'Optional picture behind the chrome.';
  const clear = document.querySelector('[data-action="clear-wallpaper"]');
  if (clear) clear.disabled = !theme.image;
}

function providerFields() {
  const google = (state.settings && state.settings.google) || {};
  const outlook = (state.settings && state.settings.outlook) || {};
  const tenant = outlook.tenant || 'consumers';
  return `<section class="provider-card">
    <h3>Google</h3>
    <label class="field">Client ID<input id="google-client-id" type="text" value="${esc(google.clientId || '')}" autocomplete="off"></label>
    <label class="field">Client secret<input id="google-client-secret" type="password" value="${esc(google.clientSecret || '')}" autocomplete="new-password" spellcheck="false"></label>
    <div class="settings-actions">
      <button type="button" class="cmd" data-action="pick-google">Browse credentials.json</button>
    </div>
  </section>
  <section class="provider-card">
    <h3>Outlook</h3>
    <label class="field">Application (client) ID<input id="outlook-client-id" type="text" value="${esc(outlook.clientId || '')}" autocomplete="off"></label>
    <label class="field">Client secret<input id="outlook-client-secret" type="password" value="${esc(outlook.clientSecret || '')}" autocomplete="new-password" spellcheck="false"></label>
    <label class="field">Tenant<select id="outlook-tenant">
      <option value="consumers" ${tenant === 'consumers' ? 'selected' : ''}>consumers — personal Outlook, Hotmail, Live</option>
      <option value="organizations" ${tenant === 'organizations' ? 'selected' : ''}>organizations — work or school</option>
      <option value="common" ${tenant === 'common' ? 'selected' : ''}>common — work and personal together</option>
    </select></label>
  </section>`;
}

async function openSettings() {
  state.modal = 'settings';
  try {
    state.dataInfo = await call(() => api.dataInfo());
  } catch (error) {
    state.dataInfo = null;
    toast(error.message);
  }
  renderSettings({ resetScroll: true });
}

function renderSettings(opts) {
  const previous = document.querySelector('.settings-dialog .dialog-body');
  const scrollTop = previous ? previous.scrollTop : 0;
  const helpOpen = Boolean(document.querySelector('.settings-help-toggle.open'));
  const info = state.dataInfo || {};
  const meta = info.path
    ? `${formatSize(info.bytes)} · ${info.records || 0} saved records · ${info.mail || 0} mail · ${info.calendar || 0} calendar`
    : 'Database details are unavailable.';
  document.getElementById('modal-root').innerHTML = `<div class="backdrop"><div class="dialog settings-dialog" role="dialog" aria-modal="true" tabindex="-1">
    <header class="dialog-head">
      <div>
        <h2>Settings</h2>
        <p class="lede">Sign-in apps, new-mail checks, and local data on this PC.</p>
      </div>
      <button type="button" class="dialog-close" data-action="close-modal" title="Close" aria-label="Close">${icon('x')}</button>
    </header>
    <div class="dialog-body">
      <section class="settings-block">
        <h3>Configuration</h3>
        <p class="lede">Google and Outlook sign-in apps used when you add an account.</p>
        ${providerFields()}
        <div class="settings-actions">
          <button type="button" class="cmd primary" data-action="save-settings">Save configuration</button>
        </div>
        <button type="button" class="settings-help-toggle" data-action="toggle-settings-help" aria-expanded="false">How to register the sign-in apps</button>
        <div id="settings-help" class="settings-help-body" hidden>
          <p><strong>Gmail.</strong> In Google Cloud Console, enable the Gmail API and the Google Calendar API, create an OAuth client of type Desktop app, and download the JSON. If the consent screen is in Testing, add your Gmail address as a test user.</p>
          <p><strong>Outlook.</strong> In Microsoft Entra, register an app and add a Mobile and desktop applications platform with redirect URI <code>http://localhost</code>. Turn on Allow public client flows. Add delegated permissions User.Read, Mail.ReadWrite, Mail.Send, MailboxSettings.ReadWrite, Calendars.ReadWrite, and offline_access. Paste the Application (client) ID above. A client secret is only needed if the redirect was created under Web.</p>
        </div>
      </section>
      <section class="settings-block">
        <h3>Theme</h3>
        <p class="lede">Choose a look, a background color, or a picture behind the mail windows.</p>
        ${themePicker()}
      </section>
      <section class="settings-block">
        <h3>New mail</h3>
        <p class="lede">Light Mail checks the mailbox on a timer and adds new messages to the list.</p>
        <label class="field">Check every<select id="poll-seconds">
          ${[30, 60, 120, 300, 0].map((seconds) => `<option value="${seconds}"${pollChoice(state.pollSeconds) === seconds ? ' selected' : ''}>${seconds === 0 ? 'Off' : (seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? '' : 's'}`)}</option>`).join('')}
        </select></label>
      </section>
      <section class="settings-block">
        <h3>Database</h3>
        <p class="lede">Fetched mail and calendar data stays here until you refresh or clear it. Clearing does not delete anything from Gmail or Outlook.</p>
        <p class="db-meta">${esc(meta)}${info.path ? `<span class="db-path">${esc(info.path)}</span>` : ''}</p>
        <div class="settings-actions">
          <button type="button" class="cmd" data-action="clear-data" data-scope="mail">Clear mail cache</button>
          <button type="button" class="cmd" data-action="clear-data" data-scope="calendar">Clear calendar cache</button>
          <button type="button" class="cmd" data-action="clear-data" data-scope="all">Clear all cached data</button>
        </div>
      </section>
      <section class="settings-block">
        <h3>Import and export</h3>
        <p class="lede">Configuration files include account sign-in tokens. Keep them private. A full backup is a folder with configuration.json and mail.db.</p>
        <div class="settings-actions">
          <button type="button" class="cmd" data-action="export-config">Export configuration</button>
          <button type="button" class="cmd" data-action="import-config">Import configuration</button>
          <button type="button" class="cmd" data-action="export-database">Export database</button>
          <button type="button" class="cmd" data-action="import-database">Import database</button>
          <button type="button" class="cmd" data-action="export-backup">Export full backup</button>
          <button type="button" class="cmd" data-action="import-backup">Import full backup</button>
          <button type="button" class="cmd" data-action="import-tokens">Import token files</button>
          <button type="button" class="cmd" data-action="import-tokens-folder">Import tokens folder</button>
        </div>
      </section>
    </div>
    <div class="dialog-actions">
      <button type="button" class="cmd primary" data-action="close-modal">Done</button>
    </div>
  </div></div>`;
  const dialog = document.querySelector('.settings-dialog');
  const body = document.querySelector('.settings-dialog .dialog-body');
  if (helpOpen) {
    const toggle = document.querySelector('.settings-help-toggle');
    const help = document.getElementById('settings-help');
    if (toggle && help) {
      help.hidden = false;
      toggle.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
    }
  }
  if (opts && opts.resetScroll) {
    if (dialog) dialog.focus({ preventScroll: true });
    if (body) body.scrollTop = 0;
  } else if (body) {
    body.scrollTop = scrollTop;
  }
}

function forgetMemory() {
  listCache.clear();
  messageCache.clear();
  folderCache.clear();
  calStores.clear();
  state.messages = [];
  state.active = null;
  state.activeId = null;
  state.selected.clear();
}

async function reloadAfterImport() {
  forgetMemory();
  await boot({ silentEmpty: true, folderId: null });
  if (state.module === 'calendar') await loadCalendar();
}

async function clearStoredData(scope) {
  const label = scope === 'mail' ? 'mail cache' : (scope === 'calendar' ? 'calendar cache' : 'cached mail and calendar data');
  const yes = await confirmDialog(`Clear the local ${label}? Messages and events stay in the mailbox. Light Mail downloads them again the next time you open them.`, 'Clear database', 'Clear');
  if (!yes) return openSettings();
  try {
    await call(() => api.clearData(scope));
    if (scope !== 'calendar') {
      listCache.clear();
      messageCache.clear();
      folderCache.clear();
      state.messages = [];
      state.active = null;
      state.activeId = null;
    }
    if (scope !== 'mail') calStores.clear();
    if (scope !== 'calendar' && state.module !== 'calendar') {
      await refreshFolders(true);
      await loadMessages({ fresh: true });
    }
    if (scope !== 'mail' && state.module === 'calendar') await loadCalendar({ force: true });
    toast('Cached data cleared.');
  } finally {
    await openSettings();
  }
}

async function exportConfig() {
  if (document.getElementById('google-client-id')) await saveProviderSettings();
  const result = await call(() => api.exportConfig());
  if (result && !result.canceled) toast('Configuration exported.');
}

async function importConfig() {
  const yes = await confirmDialog('Replace the saved configuration and account sign-in with the file you choose?', 'Import configuration', 'Import');
  if (!yes) return openSettings();
  try {
    const result = await call(() => api.importConfig());
    if (!result || result.canceled) return;
    await reloadAfterImport();
    toast('Configuration imported.');
  } finally {
    await openSettings();
  }
}

async function exportDatabase() {
  const result = await call(() => api.exportDatabase());
  if (result && !result.canceled) toast('Database exported.');
}

async function importDatabase() {
  const yes = await confirmDialog('Replace the local mail and calendar database with the file you choose? Accounts and settings stay as they are.', 'Import database', 'Import');
  if (!yes) return openSettings();
  try {
    const result = await call(() => api.importDatabase());
    if (!result || result.canceled) return;
    await reloadAfterImport();
    toast('Database imported.');
  } finally {
    await openSettings();
  }
}

async function exportBackup() {
  if (document.getElementById('google-client-id')) await saveProviderSettings();
  const result = await call(() => api.exportBackup());
  if (result && !result.canceled) toast('Backup exported.');
}

async function importBackup() {
  const yes = await confirmDialog('Replace configuration, account sign-in, and the local database with the backup you choose?', 'Import backup', 'Import');
  if (!yes) return openSettings();
  try {
    const result = await call(() => api.importBackup());
    if (!result || result.canceled) return;
    await reloadAfterImport();
    toast('Backup imported.');
  } finally {
    await openSettings();
  }
}

function openAccounts() {
  state.modal = 'accounts';
  renderAccountsModal();
}

function renderAccountsModal() {
  const empty = !state.accounts.length;
  const rows = empty
    ? '<p class="hint">No accounts yet.</p>'
    : state.accounts.map((account) => `<div class="account-row"><span class="account-id"><strong>${esc(account.email)}</strong><em>${esc(account.provider === 'gmail' ? 'Gmail' : 'Outlook')}</em></span><button type="button" class="text-remove" data-action="remove-account" data-id="${esc(account.id)}">Remove</button></div>`).join('');
  document.getElementById('modal-root').innerHTML = `<div class="backdrop"><div class="dialog accounts-dialog" role="dialog" aria-modal="true">
    <header class="dialog-head">
      <div>
        <h2>Accounts</h2>
        <p class="lede">Add a mailbox with browser sign-in, or import saved token files. Tokens stay on this PC.</p>
      </div>
      <button type="button" class="dialog-close" data-action="close-modal" title="Close" aria-label="Close">${icon('x')}</button>
    </header>
    <div class="dialog-body">
      <div class="account-list${empty ? ' empty' : ''}">${rows}</div>
      <div class="accounts-add">
        <button type="button" class="cmd primary" data-action="add-gmail">Add Gmail</button>
        <button type="button" class="cmd primary" data-action="add-outlook">Add Outlook</button>
      </div>
      <section class="provider-card">
        <h3>Import tokens</h3>
        <p class="hint">Add mailboxes from saved token JSON files, including a checker <code>tokens</code> folder.</p>
        <div class="accounts-actions">
          <button type="button" class="cmd" data-action="import-tokens">Import token files</button>
          <button type="button" class="cmd" data-action="import-tokens-folder">Import tokens folder</button>
        </div>
      </section>
    </div>
    <div class="dialog-actions">
      <button type="button" class="cmd primary" data-action="close-modal">Done</button>
    </div>
  </div></div>`;
}

async function importTokenFiles(folder) {
  try {
    const result = await call(() => api.importTokens({ folder: Boolean(folder) }));
    if (!result || result.canceled) return;
    if (result.settings) state.settings = result.settings;
    const imported = result.accounts || [];
    const prefer = imported[0] && imported[0].id;
    await boot({ prefer: prefer || undefined, folderId: null, silentEmpty: true });
    const count = result.imported || imported.length;
    if (count === 1) toast(`Imported ${imported[0].email}`);
    else toast(`Imported ${count} accounts`);
    if (result.errors && result.errors.length) toast(result.errors[0]);
    const outlook = imported.some((account) => account.provider === 'outlook');
    const outlookId = ((state.settings && state.settings.outlook) || {}).clientId;
    if (outlook && !String(outlookId || '').trim()) {
      toast('Add an Outlook client ID so those accounts can refresh sign-in.');
    }
  } finally {
    if (state.modal === 'accounts' || !state.modal) openAccounts();
    else if (state.modal === 'settings') openSettings();
  }
}

async function addAccount(provider) {
  if (document.getElementById('google-client-id')) await saveProviderSettings();
  document.getElementById('auth-overlay').hidden = false;
  try {
    const account = await call(() => (provider === 'gmail' ? api.addGmail() : api.addOutlook()));
    document.getElementById('auth-overlay').hidden = true;
    await boot({ prefer: account.id, folderId: null, silentEmpty: true });
    toast(`Added ${account.email}`);
    openAccounts();
  } catch (error) {
    if (!/cancelled/i.test(error.message || '')) toast(error.message);
  } finally {
    document.getElementById('auth-overlay').hidden = true;
  }
}

async function removeAccount(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  const yes = await confirmDialog(`Remove ${account.email} from Light Mail? Messages stay in the mailbox.`, 'Remove account');
  if (!yes) {
    openAccounts();
    return;
  }
  await call(() => api.removeAccount(accountId));
  forgetCalendarAccount(accountId);
  const data = await call(() => api.getState());
  state.settings = data.settings;
  state.accounts = data.accounts || [];
  if (state.accountId === accountId) {
    const next = state.accounts[0];
    if (next) await selectAccount(next.id, null);
    else {
      state.accountId = null;
      state.folders = [];
      state.messages = [];
      state.active = null;
      renderNav();
      renderList();
      renderReader();
      renderCommands();
      if (state.module === 'calendar') renderCalendar();
    }
  } else {
    renderNav();
    if (state.module === 'calendar') renderCalendar();
  }
  openAccounts();
  toast(`Removed ${account.email}`);
}

async function pickGoogle() {
  const result = await call(() => api.pickGoogleCredentials());
  if (result.canceled) return;
  state.settings.google = result.google;
  if (state.modal === 'settings') renderSettings();
  else if (state.modal === 'accounts') renderAccountsModal();
  toast('Google credentials saved.');
}

async function pickWallpaper() {
  const result = await call(() => api.pickThemeImage());
  if (!result || result.canceled) return;
  rememberTheme({ image: result.image, stamp: Date.now(), dataUrl: result.dataUrl || '' });
  paintThemePicks();
  toast('Background image saved.');
}

async function clearWallpaper() {
  await call(() => api.clearThemeImage());
  rememberTheme({ image: '', stamp: 0 });
  paintThemePicks();
  toast('Background image removed.');
}
