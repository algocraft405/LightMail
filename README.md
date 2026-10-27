# Light Mail

Outlook-style desktop mail for Gmail and Outlook. Add an account, open any folder, and read, reply, file, tag, or delete messages.

Sign-in uses the same loopback OAuth flow as the email checker: the app opens your browser, listens on `localhost`, and stores a token per account on this PC.

## Run

```powershell
npm install
npm start
```

If start says Electron is missing, download the desktop shell once:

```powershell
node node_modules/electron/install.js
```

Accounts and tokens are stored in `%APPDATA%\SmartMail`, not in this folder.

## Add Gmail

1. In Google Cloud Console, open **APIs & Services → Credentials**.
2. Enable the **Gmail API** and the **Google Calendar API**.
3. Create an OAuth client ID with application type **Desktop app**.
4. Download the JSON.
5. In Light Mail, open **Manage accounts**, choose **Browse credentials.json**, then **Add Gmail**.
6. If the consent screen is in Testing, add that Gmail address as a test user.

The app asks for `gmail.modify`, `gmail.send`, `calendar.readonly`, and `calendar.events`, so it can manage mail and calendar events.

## Add Outlook

1. In Microsoft Entra, create an app registration.
2. Under **Authentication → Add a platform**, choose **Mobile and desktop applications** (not Web).
3. Add redirect URI `http://localhost`.
4. Enable **Allow public client flows**.
5. Add these delegated permissions:
   - `User.Read`
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `MailboxSettings.ReadWrite`
   - `Calendars.ReadWrite`
   - `offline_access`
6. Copy the **Application (client) ID** into Light Mail.
7. Set the tenant:
   - `consumers` for personal Outlook, Hotmail, or Live
   - `organizations` for work or school
   - `common` only when the registration allows both
8. Click **Add Outlook**.

Leave the client secret empty for the desktop setup above. A secret is only needed if the redirect URI was created under **Web**.

## What you can do

- Switch between Gmail and Outlook accounts in the folder pane
- Read mail in Inbox, Sent, Drafts, Junk, Trash, Archive, and folders you create
- Mark messages read or unread, flag them, and delete them
- Move mail between folders, and archive it
- Create tags (Gmail labels or Outlook categories) and apply them
- Write a new message, reply, reply all, or forward
- Search the open folder and save attachments
- Open Calendar for month, week, and day views
- Create, edit, and delete events, including all-day events, locations, notes, and guests
- Show or hide individual calendars on the account

Gmail uses one label system for both folders and tags. Outlook keeps folders and categories separate. The same mail buttons work for both. Calendar uses Google Calendar or the Outlook calendar on that account. If an account was added before calendar support, remove it and add it again so the extra permission can be granted.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+N | New message, or a new event in Calendar |
| Ctrl+R | Reply |
| Ctrl+Shift+R | Reply all |
| Ctrl+F | Forward |
| Ctrl+Enter | Send |
| Ctrl+U | Mark unread |
| Delete | Delete |
| Ctrl+E | Search |
