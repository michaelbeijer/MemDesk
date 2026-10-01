# Supermail

A Kanban board and a notes system inside Gmail, for one person, backed
entirely by Gmail itself.

Every card is a Gmail thread and every column is a Gmail label (`_Board/To do`,
`_Board/Doing`, `_Board/Waiting` and `_Board/Done` to start with). Moving a card
moves the label. Every note is a message in your own mailbox, never sent, filed
under `_Notes`. There is no separate database and no server: the board and the
notes are views of your mailbox. Because they are ordinary labels and messages,
they show up in the Gmail app on your phone too, so you can file a thread from
the train and see it on the board later, or look up a note. The leading
underscore sorts both labels to the top of Gmail's label list. The board and the
notes editor themselves only exist in desktop Chrome.

Version 0.5.0. Plain JavaScript, Manifest V3, no build step and no runtime
dependencies.

## Install

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. The setup page opens. Do the one-time Google setup below.
4. Reload any Gmail tabs that were already open.

The manifest carries a public `key`, so the extension ID is the same on every
install of this folder:

| | |
|---|---|
| Extension ID | `lfeogecmdohgofbifobhkolapmjikdih` |
| Redirect URI | `https://lfeogecmdohgofbifobhkolapmjikdih.chromiumapp.org/` |

The matching private key is not in the repository and is not needed to load the
extension. It only matters if you ever pack a `.crx`.

## One-time Google setup

The extension calls the Gmail API directly from your browser with a short-lived
token. It needs one OAuth client to do that.

### Reusing the dashboard's Cloud project (recommended)

The Google Cloud project you set up for the dashboard (see `EMAIL-SETUP.md` in
supervertaler-stats) already has the Gmail API enabled and an **Internal**
consent screen. You only need one new OAuth client:

1. Open [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
   in that project and choose **Create credentials → OAuth client ID**, with
   application type **Web application**. The dashboard's client is a *Desktop
   app*, which cannot use a `chromiumapp.org` redirect, hence a second one.
2. Under **Authorised redirect URIs**, add
   `https://lfeogecmdohgofbifobhkolapmjikdih.chromiumapp.org/`
3. Create it, open the extension's setup page, paste the **Client ID** and press
   **Save**. No client secret is needed: the browser flow does not use one.
4. Optional: under **Google Auth Platform → Data access**, add the
   `https://www.googleapis.com/auth/gmail.modify` scope. With an Internal app this
   is documentation rather than a requirement, but it keeps the consent screen's
   list honest.

Then press **Test connection** on the setup page. Google asks you to choose an
account, and the page should say "Connected as …".

The token request asks for `gmail.modify` alone, with
`include_granted_scopes=false`. Google treats every client in a project as one
app, so incremental auth would also fold the dashboard's `gmail.metadata` grant
into this token. Gmail then applies metadata-scope rules to the whole token, and
search (`q=`) stops working.

### Starting from a fresh project instead

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/).
2. **APIs & Services → Library → Gmail API → Enable**.
3. Configure the OAuth consent screen with user type **Internal**. This is only
   available on Google Workspace accounts. It avoids Google's verification review
   for a restricted scope and the seven-day token limit of "Testing" mode.
4. Follow steps 1 to 4 above.

## Usage

- **Open the board** with the **Board** button at the bottom left of Gmail, the
  toolbar icon, or **Alt+Shift+K**. Change the shortcut at
  `chrome://extensions/shortcuts`. Press **Esc** to close it.
- The first time you open it, the board creates any column labels that are
  missing, plus their parent (`_Board`) so Gmail nests them in the sidebar.
- Columns remember their label's id as well as its name, so renaming a label in
  Gmail itself (say `Board` to `_Board`, which renames every column label under
  it) is followed rather than answered with a fresh, empty label. New columns
  go under whatever parent the existing ones share.
- **Drag** a card to another column, or within a column to reorder it. A
  placeholder shows where it will land.
- Each card's **⋯** menu offers the same actions without a mouse: Open in Gmail,
  Move to another column, and Remove from board.
- **Edit card…** on the same menu gives a card your own title, a note and a
  colour. The title replaces the subject on the board, the note replaces the
  email preview, and the colour shows as a stripe down the card's left edge.
  None of it touches the email: the subject, the labels and what your
  correspondents see stay exactly as they were. Hover over a renamed card to see
  the email's real subject. "Use the email subject" in the editor, an empty note
  and "No colour" put the card back as it was. Enter saves from the title field,
  Ctrl+Enter from the note, and Esc cancels.
- **Click** a card to open the thread in Gmail. Ctrl-click or middle-click opens
  it in a new tab.
- The **+** on a column opens a search box that takes Gmail search syntax
  (`from:anna is:unread`). Leave it empty to list your Inbox. Click a result to
  add it to that column.
- **Done** archives on drop: moving a thread there also takes it out of the
  Inbox. You can switch this on or off for any column.
- The **columns button** in the header adds, renames, reorders and removes
  columns. Renaming a label there renames the Gmail label itself, so the mail
  filed under it stays put. Removing a column only takes it off the board. The
  Gmail label and its mail are left untouched.
- While you are reading a thread, a second button appears next to **Board**:
  **Add to board ▾**, or **On board: Doing ▾** if the thread is already on the
  board. Its menu files the thread without opening the board.
- Cards show the subject, the latest sender ("me" if it was you), how long ago
  the latest message arrived, two lines of the snippet, a message count, a star
  for starred threads, and bold text with a dot for unread ones.
- The board refreshes when you open it if what it shows is more than a minute
  old, and whenever you press the refresh button. Each column loads up to 100
  threads and says so when there are more.
- The setup page can move the buttons to the bottom right or hide them.

Card order within each column is stored in this browser (`storage.local`). The
column layout and your card edits are stored in `storage.sync`, so they follow
your Chrome profile to other computers. All of it is kept per Gmail account.

### Notes

- **Open the notes** with the **Notes** tab next to **Board** at the top of the
  board, or the **Notes** button beside **Board** at the bottom left of Gmail.
  The board reopens on whichever tab you used last.
- **Folders** are in the column on the left: **All notes**, then your folders
  as a tree, each with how many notes it holds. Choose one to see only its
  notes (and to search only inside it). The **+** at the top makes a folder;
  a folder's **⋯** menu renames it (its subfolders come along), makes a
  subfolder, or deletes it - only once it is empty. Move a note by dragging it
  onto a folder (onto **All notes** to take it out of its folder), or with the
  folder button above the note. A new note starts in the folder you are
  looking at. Each folder is a Gmail label under `_Notes` - `_Notes/Work`,
  `_Notes/Work/Clients` - so the same tree shows in Gmail's label list on the
  phone.
- The list in the middle shows your notes, newest first, with their first lines.
  The **search box** above it runs Gmail's own search inside your notes, so it
  finds words anywhere in a note and takes Gmail syntax (`before:2026/09/01`).
  **New** starts a note.
- The open note is on the right: a title and the text. It **saves itself** a
  couple of seconds after you stop typing, and again when you switch notes or
  tabs or close the board; **Ctrl+S** saves at once. The line above the title
  says "Unsaved changes", "Saving…" or "Saved". Closing the Gmail tab with an
  unsaved change asks before leaving. Enter in the title moves to the text.
- A note with no title is filed under its first line.
- **Delete** moves the note to Gmail's Trash, with an **Undo**. **Open in Gmail**
  shows the note as Gmail stores it.
- **Formatting.** The toolbar above the text has a text style menu (normal text
  and three heading sizes), bold, italic, strike-through, bulleted, numbered and
  check lists, less and more indent (three levels deep), links and clear
  formatting. Keyboard: Ctrl+B and Ctrl+I; Ctrl+K for a link; Ctrl+Shift+7, 8
  and 9 for numbered, bulleted and check lists; Tab and Shift+Tab to indent a
  list item; Ctrl+Enter ticks a check box, as does clicking it. Typing `- `,
  `1. `, `[] `, `[x] ` or `#`, `##`, `###` and a space at the start of a line
  turns it into that list or heading. Enter on an empty list item ends the list;
  Backspace at the start of a list item or heading turns it back into text.
  Ctrl-click a link to open it.
- **Pasting brings text only.** Whatever was copied - a web page, a Word
  document - arrives as plain lines, so no outside styling, images or scripts
  come with it.

How it works: a note is a message placed straight into your mailbox with
`messages.insert`, labelled `_Notes` (and its folder's label, if it is in one)
and nothing else - not Inbox, not unread. It is addressed to you, with you as
Reply-To, but it is from "Notes" at a reserved address that can never send or
receive mail (`notes@notes.invalid`): Gmail files anything from your own address
under Sent, whatever labels it was given. A note is two renderings of the same
content: an HTML part, which is the record - Gmail shows it, formatting and all,
and the editor reads it back - and a plain-text part with bullets, numbers and
☐ / ☑ for Gmail's previews and plain-text mail clients. The editor reads the HTML
with its own small reader rather than the browser's HTML parser, and keeps only
what the toolbar can make: anything else becomes text. It carries an `X-Gkb-Note` header with the note's own id.
Gmail messages cannot be changed once stored, so saving inserts a new version
and moves the previous one to Trash. That makes Gmail's Trash a 30-day version
history: open an old version there to copy text back. If two versions are ever
both live (a save cut short, or two computers saving at once), the newest wins
and the other is moved to Trash the next time the list loads.

Anything else filed under `_Notes` shows up too - an email you sent yourself
from your phone, say. Its bold, italic, lists and links come across; the rest
reads as text. It is marked "From an email".
Editing it saves a new note in its place and takes the email off the list
(it keeps the email, just without the `_Notes` label); Delete does the same.

Like the columns, the notes label is followed by id, so you can rename `_Notes`
in Gmail and the notes follow.

### Storage

Chrome's sync storage is small: 100 KB in all, and at most 512 entries. Each
edited card takes one entry, so there is room for hundreds of renamed cards,
fewer if every one carries a long note (notes are capped at 500 characters,
titles at 200). Taking a card off the board deletes its edit. Moving it to Done
keeps it. If the storage ever fills, saving an edit says so rather than failing
silently.

## Privacy

- **There is no server.** The extension talks only to `gmail.googleapis.com`,
  from your browser.
- **The access token lives only in this browser's session storage**
  (`chrome.storage.session`). It is held in memory, is not readable by the Gmail
  page or by the content scripts, and is gone when Chrome closes. The implicit
  grant issues no refresh token, so nothing long-lived exists anywhere. Tokens
  last an hour and are renewed silently while you are signed in to Google.
- **What the scope allows.** `gmail.modify` is broad. It permits reading mail
  (including message bodies), changing labels, archiving, moving to Trash, and
  technically sending mail. It does **not** permit permanent deletion; that
  needs the full `https://mail.google.com/` scope.
- **What this code does.** For the board, it reads thread metadata (subject,
  sender, date, label ids and Gmail's snippet), creates and renames labels, and
  adds or removes labels on threads, including `INBOX` when archiving. For the
  notes, it reads the messages under `_Notes` and its folders (bodies
  included), inserts new notes, moves notes between folders, moves its own old
  versions and deleted notes to Trash, and creates, renames and deletes empty
  folders under `_Notes`. It **never
  sends and never permanently deletes**, never touches Spam, and moves nothing
  to Trash but its own notes. The background worker enforces this with an
  allow-list: any other Gmail API call, any `DELETE`, any attempt to add `TRASH`
  or `SPAM` as a label, and any insert that is not a note (a message carrying
  the `X-Gkb-Note` header, filed under user labels only - never Inbox, Sent,
  Drafts, Spam, Trash or unread) is refused before a token is even fetched.
  Before trashing a message, the worker reads that message's headers itself and
  refuses unless it is a note. The only label it will delete is an empty notes
  folder: before a `DELETE`, it reads the label, the full label list, and
  whether any message is still filed under it, and refuses anything that is not
  a folder under the notes label with no notes and no subfolders.
- Every token is checked against Gmail's own profile before use. If Google
  signs in a different account from the one in the Gmail tab, the token is
  discarded and the board says so, rather than acting on the wrong mailbox.

## Known fragile points

These depend on Gmail's page rather than on a documented interface. All of them
live in `src/content/gmail-hooks.js`, and each fails quietly.

- **Account detection** reads the address out of `document.title`
  ("Inbox (3) - you@example.com - Gmail"), falling back to the aria-label of the
  `Google Account` avatar link. If Gmail changes both, the board says it cannot
  tell which account the tab belongs to.
- **The open thread** is read from the `data-legacy-thread-id` attribute on the
  conversation's subject heading, polled once a second while the tab is visible.
  If Gmail drops the attribute, the "Add to board" button simply stops
  appearing. Everything else keeps working.
- **Opening a thread** sets `location.hash` to `#all/<threadId>`, using the
  legacy hex id the API returns. Gmail currently accepts these and redirects to
  its newer ids.
- **Gmail's keyboard shortcuts** are kept out of the board's text boxes by
  stopping key events at the shadow host. If Gmail ever listens for keys in the
  capture phase, typing in the search box could trigger them.
- The **implicit grant** (`response_type=token`) still works for Web
  application clients, but Google discourages it. If it is ever retired, the
  fix is authorisation code with PKCE in the same `launchWebAuthFlow` call.

None of these, nor real OAuth, can be exercised outside real Gmail. The tests
below cover everything else.

## Renaming

The display name appears in exactly these places:

1. `manifest.json`: `"name"`
2. `manifest.json`: `"action"."default_title"`
3. `src/shared/ns.js`: `APP_NAME`
4. `README.md`: the title
5. The setup page title. It is set from `APP_NAME` at runtime, so no edit is needed.

Nothing internal carries the name: not the `gkb` namespace, the storage keys
(`clientId`, `columns:<email>`, `order:<email>`), the CSS classes or the element
ids. A rename therefore leaves stored data, the extension ID (derived from the
`key`) and the redirect URI unchanged. `tests/static.test.js` fails if the name
turns up anywhere else. The app name on the Cloud consent screen is set
separately in the Cloud console.

## Running the tests

Unit tests (Node 18 or later, no installs):

```bash
npm test                      # same as: node --test tests/*.test.js
```

These cover auth URL building and redirect parsing, the proxy's allow-list,
order merging, the label arithmetic for moves, entity decoding, address parsing,
account-from-title detection, relative dates, and static checks on the source:
no HTML-string sinks, the name only in the rename spots, and the preview's
script list matching the manifest. Node 22's runner does not accept a bare
directory (`node --test tests/`), so the glob form is used. Node expands it
itself, so it works on Windows too.

Browser checks use `playwright-core`, which is deliberately not a dependency.
Either install it without saving it (`node_modules/` is gitignored), or point
`PLAYWRIGHT_CORE` at an existing copy:

```bash
npm i --no-save playwright-core
npm run test:preview          # (a) content scripts against a fake Gmail
npm run test:extension        # (b) the real unpacked extension
```

- `CHROMIUM_PATH` chooses the browser. It must be full Chromium, because
  `chrome-headless-shell` cannot load extensions. Otherwise
  `/opt/pw-browsers/chromium-*` is used if present, and then Playwright's own
  download.
- `SCREENS_DIR` is where screenshots go. The default is a folder in the system
  temp directory.
- (a) loads `dev/preview.html` under Trusted Types and drives it: drag between
  and within columns, the ⋯ menu, search-add, column settings, Esc, the dock
  button, dark mode, the connect and setup states, a failing move, and label
  creation. It checks the fake mailbox's labels after each step.
- (b) starts Chromium with `--load-extension`. It tries new headless first and
  falls back to `xvfb-run` if the service worker does not appear. It checks the
  worker, the extension ID, the setup page, the allow-list, and that the content
  scripts inject into a stand-in `mail.google.com` page and reach the worker.

### Dev preview

Open `dev/preview.html` straight from disk in Chrome. It runs the real content
scripts against a fake `chrome.*` and an in-memory mailbox of about 25 invented
threads. A strip at the top toggles an open thread, sends the shortcut, and
switches between states: `?state=auth_required`, `?state=not_configured`,
`?fail=modify`, `?fresh` (no labels yet), `?page=3` (truncated columns) and
`?latency=600`.

### Icons

`node tools/make-icons.mjs` redraws `icons/icon-*.png` from code, with a tiny
PNG encoder and no image library.

## Layout

```
manifest.json
src/shared/ns.js           namespace, APP_NAME, storage keys
src/lib/                   pure logic, shared by content scripts, worker and tests
  util.js                  entities, addresses, account detection, dates, pool
  auth.js                  auth URL, redirect parsing, API allow-list
  board-logic.js           columns, order merge, move label diffs, summaries, card edits
  notes-logic.js           building and reading note messages, what may be inserted
  note-format.js           the formatting model: HTML out and back in, plain text
src/background/sw.js       OAuth (launchWebAuthFlow) and the Gmail API proxy
src/content/               classic scripts, in manifest order
  gmail-hooks.js           every assumption about Gmail's page
  api.js, store.js         messaging and the shared data layer
  notes-store.js           notes: list, read, save (insert + trash), delete
  ui.js, styles.js         DOM builder, icons, menus, toasts, shadow hosts
  board.js, dock.js        the overlay (header, tabs, board) and the corner buttons
  note-editor.js           the formatted editor and its toolbar
  notes.js                 the Notes tab: list, editor, autosave
  main.js                  wiring
src/options/               setup page
dev/                       preview page and fake Gmail
tests/                     unit tests; tests/e2e/ browser checks
tools/make-icons.mjs       icon generator
```

## Roadmap

- **A to-do view.** One flat list across all columns, oldest first, for days when
  a board is too much.
- **Search results with highlighting** (next): while searching, excerpts around
  every match with the words highlighted, and inside an opened note every match
  highlighted with "2 of 5" stepping between them.
- **A panel in the Gmail phone app**, as a private Google Workspace add-on: a new
  note, adding to a note, ticking checklist items, moving a note to a folder.
- **A "Needs reply" column**, computed rather than labelled. It would reuse the
  triage and ranking logic in `supervertaler-stats/src/email.js`
  (`classifyBulk`, `scoreThread`): threads whose newest message is inbound and
  not bulk mail, ranked by who is waiting and for how long.
