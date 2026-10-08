# MemDesk – Claude Code reference

A Kanban board, notes and a two-way calendar inside Gmail, for one person,
backed entirely by Gmail: cards are threads, columns are labels, notes are
messages under `_Notes`. No server, no database. Formerly called Supermail
(until 0.17.1). The README is the full manual; this is the short version for
working on the code.

The licence is source available (`LICENSE`, modelled on Supervertaler for
Trados's): anyone may read, audit and build the code, but using it needs a
licence, with a free preview licence until licences are sold. It was MIT
before; never call MemDesk open source now.

## Three ways it runs, one codebase

| Surface | Where | Talks to Google through |
|---|---|---|
| Chrome extension | `manifest.json`, `src/` | the background worker `src/background/sw.js` (an allow-list of Gmail, Calendar and Tasks requests) |
| Phone app (home-screen web app) | `addon/app/` (shell, remote) | `google.script.run` → `addon/src/app-server.js` in Apps Script |
| Gmail panel (add-on cards): the open email's board column, nothing else since 0.21.0 | `addon/src/cards.js`, `addon/src/panel-logic.js` | Apps Script, as the user |

The board, notes, editor and calendar views in `src/content/` run unchanged in
the extension and the phone app; `addon/app/remote.js` stands in for the
extension's API and storage. Pure logic is in `src/lib/` (tested in Node).

`addon/Code.gs` is **built**, never edited: `node tools/build-addon.mjs` packs
`addon/src`, the shared `src/` files and the phone app's page into it. A test
fails if it is out of date. The user pastes `Code.gs` (and `appsscript.json`
when it changes) into their Apps Script project.

## Key paths

| What | Path |
|---|---|
| Note model, HTML/plain/Markdown in and out, merging | `src/lib/note-format.js` |
| Note editor (blocks, tables, paste) | `src/content/note-editor.js` |
| Notes view (list, folders, saving, merge on catch-up) | `src/content/notes.js` |
| Board / calendar views | `src/content/board.js`, `calendar.js` |
| Phone app start, local copy, timings | `addon/app/shell.js`, `addon/app/remote.js` |
| Phone app server functions (`appStart`, `appSave`, …) | `addon/src/app-server.js`, entry points in `addon/src/triggers.js` |
| Dev preview with a fake Gmail | `dev/preview.html`, `dev/mock-chrome.js` |
| Website (memdesk.app, GitHub Pages via Actions) | `site/index.html`, `tools/build-site.mjs`, `.github/workflows/pages.yml` |
| The demo (memdesk.app/demo/): the preview and the phone app with `Code.gs` in the page | `site/demo/`, built by `tools/build-site.mjs`; Apps Script's services in `dev/apps-script-services.js` (shared with `tests/helpers/apps-script.js`) |
| README / store pictures | `tools/readme-shots.mjs` → `images/`, `store/` |
| Icon | `tools/icon-svg.py` → `icons/icon.svg` → `tools/make-icons.mjs`; `LOGO` in `src/content/ui.js` must match |

## Rules that tests enforce (and that must not be broken)

- Never send mail, never delete mail for good, never touch Spam; only a
  note of ours goes to Trash; only an empty notes folder is deleted; the board
  never adds Trash, Spam or Inbox. The board's column layout is kept in
  Gmail as a note-shaped message (fixed id, under `_Board`;
  `logic.layoutReadFlow`/`layoutWriteFlow`), one for every device: only its
  older versions go to Trash, and the phone app's own copy is never the
  first one put there.
- The calendar writes only one event or one task at a time, with only the
  fields the editor edits (`calendarLogic.isAllowedRequest`, the same rules in
  the worker and the app's script): never guests, a calendar, a task list or
  sharing. An event's change carries its version (If-Match) and is refused
  ("changed") if Google has a newer one. A delete is sent only after the
  editor's confirmation and an 8-second Undo; a tab closed before then
  deletes nothing. A series is one event: "All events" goes to it (read
  first, for its rule and version); deleting it, or stopping it repeating,
  waits out the same Undo. Rule lines MemDesk cannot show are kept as they
  are. Tests cover each of these: keep them.
- The licence (`src/lib/licence-logic.js`): Lemon Squeezy's licence API
  only (activate, validate, deactivate), with only the key and an
  activation's name, never a Google token (the stand-in fails if the
  script sends one). A reply that cannot be read changes nothing; only one
  that says active renews the 30 days offline. A Supervertaler key (store
  307062) is validated, never activated. `LICENCE_STORE_ID` in
  `src/shared/ns.js` is 0 while MemDesk is in preview: then nothing is
  asked or kept, and the demo must stay that way.
- No HTML-string sinks in `src/` or `dev/` (`innerHTML`, `insertAdjacentHTML`,
  `DOMParser`, …): Gmail's Trusted Types would block them. Build DOM with `h()`.
  HTML is read with note-format's own tokenizer.
- The website's pages (`index.html`, `privacy/`) run no scripts; only the
  demo does, and it loads nothing from elsewhere. The demo is built from the
  real code, never a copy: keep it that way.
- The display name "MemDesk" appears only in the rename spots listed in the
  README's *Renaming* section; elsewhere use `APP_NAME`.
- Internal identifiers stay brand-free (`gkb` namespace, storage keys). The
  phone app's `supermail.` localStorage prefix stays (saved settings).
- The Gmail panel opens on every email, so it reads only the labels and the
  open conversation, in one round trip (`store.openEmail`); a test counts
  the requests. Notes and the calendar on a phone belong to the phone app.
- A save in the phone app is refused by the script if another device saved a
  newer version (`{ conflict }`); the view merges (`noteFormat.mergeDocs`) and
  saves again. Keep that path intact.

## Tests

```bash
npm test                         # unit tests, Node 18+, no installs
node tools/build-addon.mjs       # after changing anything that goes into Code.gs
```

Browser tests need `playwright-core` and Chromium:

```bash
npm i --no-save playwright-core
npx playwright-core install chromium
node tests/e2e/preview.e2e.mjs     # board, notes, editor, tables in the dev preview
node tests/e2e/app.e2e.mjs         # the phone app against the Apps Script stand-in
node tests/e2e/extension.e2e.mjs   # the real extension loaded in Chromium
node tests/e2e/demo.e2e.mjs        # the website's demo, built and served
```

Set `PLAYWRIGHT_CORE` (a playwright-core folder) or `CHROMIUM_PATH` to use an
existing install. Steps stop at the first failure; screenshots go to
`SCREENS_DIR` (default: the temp folder's `board-screens`).

## Releasing a version

1. Bump the version in `manifest.json`, `package.json`, `tests/static.test.js`,
   `APP_VERSION` in `src/shared/ns.js` (the logo menu shows it), and the
   README's badge and "Version x.y.z" line.
2. `node tools/build-addon.mjs`, then `npm test` and the four browser suites.
3. Privacy: if what is stored or read changes, update `PRIVACY.md` (and its
   date); the website's privacy page is built from it.
4. The user's update package: the extension as `git archive --format=zip
   --prefix=MemDesk/ -o MemDesk-x.y.z.zip origin/main` (unzipped over their
   unpacked extension folder, then reloaded in `chrome://extensions`). Put
   every zip for the user, previews of a branch included, in **both** their
   Downloads folder and the repo's `dist/` (gitignored), and say where.
5. The script: once merged, `node tools/push-addon.mjs` puts `addon/Code.gs`
   and `addon/appsscript.json` from origin/main into the user's Apps Script
   project with clasp (signed in as the user; the project's id in
   `dist/clasp/push/.clasp.json`). It refuses if the project holds other
   files, and reads it back. The project runs its test deployment (@HEAD),
   so the phone app and the Gmail panel have it at once: nothing to paste.

## Style

British English, plain words, short sentences; comments explain why. Match the
surrounding code. Commit messages and PR descriptions say what changed for the
person using it.

## Open ideas

- Markdown: "Copy as Markdown" for a note; `**bold**` typed shortcuts.
- Due dates on cards: a card's ⋯ menu makes a Google Task linked to the email.
- Chrome Web Store listing (`store/`, `PUBLISHING.md`).
