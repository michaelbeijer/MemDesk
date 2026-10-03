# MemDesk – Claude Code reference

A Kanban board, notes and a read-only calendar inside Gmail, for one person,
backed entirely by Gmail: cards are threads, columns are labels, notes are
messages under `_Notes`. No server, no database. Formerly called Supermail
(until 0.17.1). The README is the full manual; this is the short version for
working on the code.

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
| README / store pictures | `tools/readme-shots.mjs` → `images/`, `store/` |
| Icon | `tools/icon-svg.py` → `icons/icon.svg` → `tools/make-icons.mjs`; `LOGO` in `src/content/ui.js` must match |

## Rules that tests enforce (and that must not be broken)

- Never send mail, never delete anything for good, never touch Spam; only a
  note of ours goes to Trash; only an empty notes folder is deleted; the board
  never adds Trash, Spam or Inbox. The calendar is read-only.
- No HTML-string sinks in `src/` or `dev/` (`innerHTML`, `insertAdjacentHTML`,
  `DOMParser`, …): Gmail's Trusted Types would block them. Build DOM with `h()`.
  HTML is read with note-format's own tokenizer.
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
```

Set `PLAYWRIGHT_CORE` (a playwright-core folder) or `CHROMIUM_PATH` to use an
existing install. Steps stop at the first failure; screenshots go to
`SCREENS_DIR` (default: the temp folder's `board-screens`).

## Releasing a version

1. Bump the version in `manifest.json`, `package.json`, `tests/static.test.js`,
   and the README's badge and "Version x.y.z" line.
2. `node tools/build-addon.mjs`, then `npm test` and the three browser suites.
3. Privacy: if what is stored or read changes, update `PRIVACY.md` (and its
   date); the website's privacy page is built from it.
4. The user's update package: the extension as `git archive --format=zip
   --prefix=MemDesk/ -o MemDesk-x.y.z.zip origin/main` (unzipped over their
   unpacked extension folder, then reloaded in `chrome://extensions`), plus
   `addon/Code.gs` (and `addon/appsscript.json` if it changed).

## Style

British English, plain words, short sentences; comments explain why. Match the
surrounding code. Commit messages and PR descriptions say what changed for the
person using it.

## Open ideas

- Markdown: "Copy as Markdown" for a note; `**bold**` typed shortcuts.
- Calendar step 2: ticking tasks off, due dates on cards, adding events.
- Chrome Web Store listing (`store/`, `PUBLISHING.md`).
