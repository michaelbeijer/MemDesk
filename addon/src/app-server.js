// ─────────────────────────────────────────────────────────────────────
// The phone app's server side
//
// The phone app (addon/app) is the extension's own board and Notes view,
// served as a full-screen web page by this same script. Where the
// extension asks Gmail through its background worker, the app asks these
// functions through google.script.run - and they keep the worker's rules:
// only notes are inserted, only notes go to Trash or come back out of it,
// mail kept as a note just leaves the list, only an empty notes folder is
// ever deleted, and the board only reads, labels and unlabels - nothing
// is ever sent, deleted, or put in Trash, Spam or the Inbox. The calendar
// only reads.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const notesLogic = ns.notesLogic;
  const fmt = ns.noteFormat;
  const gmail = ns.addonGmail;
  const store = ns.addonStore;

  const META = ['Subject', 'Date', notesLogic.NOTE_HEADER];
  const LIST_MAX = 100;

  const notesLabelIds = ctx => [ctx.root.id].concat(ctx.folders.map(f => f.id));

  // What the page gets for a note: the listing's fields, no message parts.
  function plainNote(n) {
    return {
      messageId: n.messageId, threadId: n.threadId, noteId: n.noteId, own: n.own, key: n.key,
      title: n.title, updated: n.updated, snippet: n.snippet, labelIds: n.labelIds, folderId: n.folderId || '',
    };
  }

  function ok(results) {
    const bad = results.find(r => r && r.error);
    if (bad) throw bad.error;
    return results;
  }

  // Every note, newest first, one entry per note, each with its folder -
  // the notes label and each folder's label listed separately, as the
  // extension does. With a query, Gmail's search runs in each, and the
  // notes come back with their content, for the excerpts.
  function list(query) {
    const ctx = store.context();
    const q = String(query || '').trim();
    const scans = [ctx.root].concat(ctx.folders);
    const listed = ok(gmail.callAll(scans.map(l => ['GET', 'messages', { labelIds: l.id, q: q || undefined, maxResults: LIST_MAX }])));
    const via = {};
    let truncated = false;
    listed.forEach((r, i) => {
      if (r.nextPageToken) truncated = true;
      (r.messages || []).forEach(m => { (via[m.id] = via[m.id] || []).push(scans[i].id); });
    });
    const ids = Object.keys(via);
    const msgs = gmail.callAll(ids.map(id => ['GET', `messages/${id}`, q ? { format: 'full' } : { format: 'metadata', metadataHeaders: META }]))
      .filter(m => m && !m.error);
    const notes = msgs.map(m => {
      const n = notesLogic.noteFromMessage(m);
      n.folderId = notesLogic.folderOf(via[m.id], ctx.folders);
      return n;
    });
    const { live, stale } = notesLogic.dedupeNotes(notes);
    // Older versions a cut-short save left behind, tidied as the extension
    // tidies them - only from the full list, never from a search.
    if (!q) {
      stale.forEach(n => {
        try { retireNote(ctx, n); } catch (err) { console.warn(`Could not tidy ${n.messageId}: ${err.message}`); }
      });
    }
    const docs = {};
    if (q) live.forEach(n => { docs[n.messageId] = fmt.docFromParts(n.parts || {}); });
    return { notes: live.map(plainNote), truncated, folders: ctx.folders, label: ctx.root.name, docs };
  }

  function body(messageId) {
    return store.open(store.context(), messageId).doc;
  }

  // ── Opening the app ──────────────────────────────────────────────────
  //
  // The page's first call: whose mailbox, the app's settings, the board's
  // first columns if it has none saved, and the scratchpad. The phone
  // keeps a copy of the scratchpad and says which message it is (`hint`);
  // if that message is still the scratchpad - nobody has saved it since -
  // one round of Gmail requests answers everything and the text need not
  // travel. Otherwise the current one comes back in full.

  const metadataOf = refs => gmail.callAll(refs.map(m => ['GET', `messages/${m.id}`, { format: 'metadata', metadataHeaders: META }]))
    .filter(m => m && !m.error);

  function noteOf(ctx, msg) {
    const n = notesLogic.noteFromMessage(msg);
    n.folderId = notesLogic.folderOf(n.labelIds, ctx.folders);
    return n;
  }

  const isScratch = (ctx, n) => n.own && n.noteId === notesLogic.SCRATCHPAD_ID &&
    n.labelIds.indexOf(ctx.root.id) >= 0 && n.labelIds.indexOf('TRASH') < 0;

  // The scratchpad, newest version: among the newest notes, a few at a
  // time, or failing that by its name.
  function findScratch(ctx) {
    const pick = refs => notesLogic.dedupeNotes(metadataOf(refs).map(m => noteOf(ctx, m)).filter(n => isScratch(ctx, n))).live[0] || null;
    const refs = gmail.call('GET', 'messages', { labelIds: ctx.root.id, maxResults: LIST_MAX }).messages || [];
    for (const [from, to] of [[0, 10], [10, 40], [40, refs.length]]) {
      const found = from < refs.length ? pick(refs.slice(from, to)) : null;
      if (found) return found;
    }
    if (refs.length < LIST_MAX) return null;
    const named = gmail.call('GET', 'messages', { labelIds: ctx.root.id, q: `subject:"${notesLogic.SCRATCHPAD_TITLE}"`, maxResults: 20 }).messages || [];
    return named.length ? pick(named) : null;
  }

  function start(hint) {
    const kept = String(hint || '');
    const first = gmail.callAll([['GET', 'labels'], ['GET', 'profile']]
      .concat(kept ? [['GET', `messages/${encodeURIComponent(kept)}`, { format: 'metadata', metadataHeaders: META }]] : []));
    const [labels, profile] = ok(first.slice(0, 2));
    const ctx = store.context(labels.labels || []);
    const account = String(profile.emailAddress || '');
    const copy = kept && first[2] && !first[2].error ? noteOf(ctx, first[2]) : null;
    let scratch = copy && isScratch(ctx, copy) ? copy : null;
    let doc = null; // the phone has it
    if (!scratch) {
      scratch = findScratch(ctx);
      if (scratch) doc = store.open(ctx, scratch.messageId).doc;
    }
    const prefs = prefsGet(null);
    const columns = prefs[ns.KEYS.columns(account)] ? null : boardColumns(labels.labels || []);
    return {
      account, label: ctx.root.name, folders: ctx.folders,
      scratch: scratch ? plainNote(scratch) : null, doc, prefs, columns,
    };
  }

  // A newer version of the note a save starts from, saved on another
  // device since this page read it - or, for the scratchpad when the page
  // knew of none, the one there already.
  function newerThan(ctx, previous, noteId) {
    if (previous) return previous.own ? store.newerVersion(ctx, previous) : null;
    if (noteId !== notesLogic.SCRATCHPAD_ID) return null;
    return store.newerVersion(ctx, { own: true, noteId, messageId: '', inNotes: false, trashed: false, updated: 0 });
  }

  // A new version (or a new note), and the old one retired. What the page
  // says about the previous version is not taken on trust: it is read. If
  // another device has saved a newer one since, nothing is written: the
  // page is told, merges the two, and saves again.
  function save(previousId, snap) {
    const ctx = store.context();
    const previous = previousId ? store.peek(ctx, previousId) : null;
    const s = snap || {};
    const newer = newerThan(ctx, previous, String(s.noteId || ''));
    if (newer) return { conflict: plainNote(newer) };
    const folderId = ctx.folders.some(f => f.id === s.folderId) ? s.folderId : '';
    const id = store.save(ctx, previous, { title: String(s.title || ''), doc: s.doc, folderId, noteId: String(s.noteId || '') });
    return { note: plainNote(store.peek(ctx, id)) };
  }

  function retireNote(ctx, note) {
    if (note.own) gmail.trashNote(note.messageId);
    else gmail.modifyLabels(note.messageId, { addLabelIds: [], removeLabelIds: notesLabelIds(ctx) });
  }

  function retire(messageId) {
    const ctx = store.context();
    retireNote(ctx, store.peek(ctx, messageId));
    return true;
  }

  function restore(messageId, folderId) {
    const ctx = store.context();
    const note = store.peek(ctx, messageId);
    if (note.own) gmail.untrashNote(messageId);
    else {
      const folder = ctx.folders.some(f => f.id === folderId) ? folderId : '';
      gmail.modifyLabels(messageId, { addLabelIds: folder ? [ctx.root.id, folder] : [ctx.root.id], removeLabelIds: [] });
    }
    return true;
  }

  function move(messageId, folderId) {
    const ctx = store.context();
    store.move(ctx, messageId, ctx.folders.some(f => f.id === folderId) ? folderId : '');
    return true;
  }

  // ── Folders ──────────────────────────────────────────────────────────

  function siblingsOf(ctx, parentPath, except) {
    return ctx.folders.filter(f => f.parentPath === parentPath && f !== except).map(f => f.title);
  }

  function createFolder(parentId, title) {
    const ctx = store.context();
    const parent = ctx.folders.find(f => f.id === parentId) || null;
    const problem = notesLogic.validateFolderTitle(title, siblingsOf(ctx, parent ? parent.path : '', null));
    if (problem) throw new Error(problem);
    const name = `${parent ? parent.name : ctx.root.name}/${String(title).trim()}`;
    gmail.call('POST', 'labels', null, { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    const after = store.context();
    return { folder: after.folders.find(f => f.name.toLowerCase() === name.toLowerCase()) || null, folders: after.folders };
  }

  // Gmail's API renames only the label it is given, so the folders under
  // it are renamed after it - each only if Gmail has not done it already.
  function renameFolder(folderId, title) {
    const ctx = store.context();
    const folder = ctx.folders.find(f => f.id === folderId);
    if (!folder) throw new Error('That folder is not there any more.');
    const problem = notesLogic.validateFolderTitle(title, siblingsOf(ctx, folder.parentPath, folder));
    if (problem) throw new Error(problem);
    notesLogic.renamePlan(folder, title, ctx.folders).forEach(step => {
      const now = (gmail.call('GET', 'labels').labels || []).find(l => l.id === step.id);
      if (now && now.name !== step.name) gmail.call('PATCH', `labels/${encodeURIComponent(step.id)}`, null, { name: step.name });
    });
    return { folders: store.context().folders };
  }

  // Only a folder under the notes label with no notes in it and no
  // folders under it - checked here, from Gmail, whatever the page says.
  function deleteFolder(folderId) {
    const ctx = store.context();
    const label = gmail.call('GET', `labels/${encodeURIComponent(folderId)}`);
    const all = gmail.call('GET', 'labels').labels || [];
    const live = (gmail.call('GET', 'messages', { labelIds: folderId, maxResults: 1 }).messages || []).length;
    if (!notesLogic.isDeletableFolder(label, ctx.root.name, all, live)) {
      throw new Error('not_allowed: only an empty notes folder can be deleted.');
    }
    gmail.call('DELETE', `labels/${encodeURIComponent(folderId)}`);
    return { folders: store.context().folders };
  }

  // The page itself, built into Code.gs by tools/build-addon.mjs. With
  // ?ping=1, a line that says the script itself runs - to tell a problem
  // here from one in the page.
  function page(e) {
    const html = globalThis.MEMDESK_APP_HTML || '';
    if (e && e.parameter && e.parameter.ping) {
      return HtmlService.createHtmlOutput(`<p style="font: 16px/1.5 Arial, sans-serif; padding: 24px">${ns.APP_NAME} ${globalThis.MEMDESK_VERSION || ''}: ` +
        `the script runs, and its page is ${html.length} characters long.</p>`).setTitle(`${ns.APP_NAME} notes`);
    }
    const out = HtmlService.createHtmlOutput(html || '<p>The app is not built into this Code.gs.</p>')
      .setTitle(ns.APP_NAME)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
    // Our icon rather than Apps Script's, in the tab and on the home screen.
    // Only a nicety: a refused address must not cost the page.
    try {
      if (globalThis.MEMDESK_ICON_URL) out.setFaviconUrl(globalThis.MEMDESK_ICON_URL);
    } catch (err) {
      console.warn(`The icon was not set: ${err.message}`);
    }
    return out;
  }

  // ── The board ────────────────────────────────────────────────────────
  //
  // The app runs the extension's own board (src/content/board.js and
  // store.js), whose Gmail requests come here instead of to the worker.
  // They are held to what the board does with Gmail, and nothing more.

  const BOARD_REQUESTS = [
    ['GET', /^labels$/],
    ['GET', /^threads$/],
    ['GET', /^threads\/[A-Za-z0-9]+$/],
    ['POST', /^labels$/],
    ['PATCH', /^labels\/Label_[0-9]+$/],
    ['POST', /^threads\/[A-Za-z0-9]+\/modify$/],
  ];
  const BATCH_MAX = 200;

  function boardAllowed(method, path) {
    const m = String(method || '').toUpperCase();
    const p = String(path || '');
    if (!BOARD_REQUESTS.some(([mm, re]) => mm === m && re.test(p))) {
      throw new Error(`not_allowed: ${m} ${p} is not something the board does.`);
    }
    return [m, p];
  }

  function boardGmail(method, path, query, body) {
    const [m, p] = boardAllowed(method, path);
    const b = body || {};
    // Labelling: never Trash, Spam or the Inbox (gmail.js refuses those).
    if (m === 'POST' && p.endsWith('/modify')) return gmail.modifyThread(p.split('/')[1], b);
    // A column's label: a name, and how Gmail shows it - nothing else.
    if (m === 'POST' || m === 'PATCH') {
      const name = String(b.name || '').trim();
      if (!name) throw new Error('not_allowed: a label needs a name.');
      const label = { name };
      if (m === 'POST') Object.assign(label, { labelListVisibility: 'labelShow', messageListVisibility: 'show' });
      return gmail.call(m, p, null, label);
    }
    return gmail.call(m, p, query || null);
  }

  // Several reads side by side: a board's worth of cards in one round
  // trip instead of one each. Each answer is the response, or { error }.
  function boardGmailMany(list) {
    const calls = (list || []).slice(0, BATCH_MAX).map(([method, path, query]) => {
      const [m, p] = boardAllowed(method, path);
      if (m !== 'GET') throw new Error('not_allowed: only reads go in a batch.');
      return [m, p, query || null];
    });
    return gmail.callAll(calls).map(r => (r && r.error ? { error: { message: r.error.message, status: r.error.status || 0 } } : r));
  }

  // Whose mailbox this is, for the board's per-account settings.
  function account() {
    return gmail.call('GET', 'profile').emailAddress;
  }

  // Before the app has a column layout of its own: the board's labels as
  // Gmail has them, so a column renamed in the extension does not come
  // back here as a fresh, empty label of the old name. null: no board
  // labels yet, and the usual columns will be made.
  function boardColumns(known) {
    const labels = Array.isArray(known) ? known : gmail.call('GET', 'labels').labels || [];
    const cols = ns.panelLogic.boardColumns(labels, String(globalThis.MEMDESK_BOARD_LABEL || ns.logic.DEFAULT_ROOT).trim());
    return cols.length ? cols : null;
  }

  // ── The board's layout ───────────────────────────────────────────────
  //
  // Kept in Gmail for every computer and phone (logic.layoutReadFlow and
  // layoutWriteFlow), read and written here within the script's own
  // limits: reads, an insert only of a note (gmail.insertNote), and Trash
  // only for an older version of the layout itself.

  function trashLayout(id) {
    try {
      const msg = gmail.call('GET', `messages/${encodeURIComponent(id)}`, { format: 'metadata', metadataHeaders: [notesLogic.NOTE_HEADER] });
      if (notesLogic.noteFromMessage(msg).noteId !== ns.logic.LAYOUT_ID) return null;
      return gmail.trashNote(id);
    } catch (err) {
      return null; // left behind: the newest still wins, and the next save replaces it
    }
  }

  const layoutIo = {
    read: ([method, path, query]) => {
      if (String(method).toUpperCase() !== 'GET') throw new Error('not_allowed: the layout is only read here.');
      return gmail.call('GET', path, query || null);
    },
    readMany: list => gmail.callAll(list.map(([, path, query]) => ['GET', path, query || null])),
    insert: body => gmail.insertNote(body),
    trash: trashLayout,
  };

  function layout(rootLabelId, knownId) {
    if (!rootLabelId) return null;
    return ns.util.runSync(ns.logic.layoutReadFlow(String(rootLabelId), String(knownId || '')), layoutIo);
  }

  function saveLayout(rootLabelId, columns, replaces) {
    if (!rootLabelId) throw new Error('not_allowed: the layout is filed under the board’s label.');
    const flow = ns.logic.layoutWriteFlow({
      rootLabelId: String(rootLabelId), columns, replaces: [].concat(replaces || []).map(String), account: account(),
    });
    return ns.util.runSync(flow, layoutIo);
  }

  // ── The calendar ─────────────────────────────────────────────────────
  //
  // Google Calendar and Google Tasks: the same short list of reads the
  // extension's worker allows (calendarLogic.isAllowedRequest), side by
  // side in one round trip, and one change at a time.

  function googleMany(list) {
    const cal = ns.calendarLogic;
    const urls = (list || []).slice(0, BATCH_MAX).map(([service, path, query]) => {
      if (!cal.isAllowedRequest(service, 'GET', path)) {
        throw new Error(`not_allowed: ${service} ${path} is not something the calendar does.`);
      }
      return cal.buildUrl(service, path, query || null);
    });
    let allow = null;
    return gmail.getAll(urls).map(r => {
      if (!r || !r.error) return r;
      const e = r.error;
      // Not allowed (yet): the script was authorised before it asked for
      // the calendar, or the box was unticked on Google's page. Google
      // lets a script run with some of its permissions, and does not ask
      // again by itself, so the app offers the page that asks.
      if (e.status === 403 && /insufficient.*scope/i.test(e.detail || e.message)) {
        if (allow === null) allow = allowUrl();
        return { error: { code: 'calendar_scope', status: 403, url: allow, message: 'Not allowed for this app yet.' } };
      }
      return { error: { message: e.detail || e.message, status: e.status || 0 } };
    });
  }

  const CALENDAR_SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
  ];

  // Google's page that asks for what the script has not been allowed:
  // for the calendar's two permissions if this Apps Script can say so,
  // otherwise for all of them. '' if there is none to give.
  function allowUrl() {
    const mode = ScriptApp.AuthMode.FULL;
    for (const ask of [() => ScriptApp.getAuthorizationInfo(mode, CALENDAR_SCOPES), () => ScriptApp.getAuthorizationInfo(mode)]) {
      try {
        const url = ask().getAuthorizationUrl();
        if (url) return String(url);
      } catch (err) { /* an older Apps Script: try the next */ }
    }
    return '';
  }

  // One change: an event or a task added, changed or deleted - only what
  // the extension's worker lets through (calendarLogic.isAllowedRequest),
  // with an event's version (If-Match), so one changed in Google
  // meanwhile is refused rather than overwritten. { data }, or { error }
  // with a code the page knows: "changed", or "calendar_scope" and the
  // page that allows it.
  function googleWrite(service, method, path, body, etag) {
    const cal = ns.calendarLogic;
    const m = String(method || '').toUpperCase();
    const b = body === null ? undefined : body;
    if (m === 'GET' || !cal.isAllowedRequest(service, m, path, b)) {
      throw new Error(`not_allowed: ${m} ${service} ${path} is not something the calendar does.`);
    }
    const r = gmail.sendGoogle(cal.buildUrl(service, path, null), m, b, service === 'calendar' ? String(etag || '') : '');
    // A deletion answers with nothing at all.
    if (!r || !r.error) return { data: m === 'DELETE' ? null : r };
    const e = r.error;
    if (e.status === 403 && /insufficient.*scope/i.test(e.detail || e.message)) {
      return { error: { code: 'calendar_scope', status: 403, url: allowUrl(), message: 'Changing it is not allowed for this app yet.' } };
    }
    if (e.status === 412) return { error: { code: 'changed', status: 412, message: 'It was changed in Google meanwhile.' } };
    return { error: { message: e.detail || e.message, status: e.status || 0 } };
  }

  // Run once from the script editor, if the app's Allow button is not
  // there or does not help: asks for every permission not yet given.
  function allowCalendar() {
    ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
    console.log('All permissions granted');
    return true;
  }

  // ── The app's settings ───────────────────────────────────────────────
  //
  // What the extension keeps in Chrome's synced storage (the column
  // layout, card titles, notes and colours), the app keeps in the
  // script's user properties: per Google account, and the same on every
  // phone and computer the app is opened on.

  const PREF = 'gkb.';
  const props = () => PropertiesService.getUserProperties();

  function prefsGet(keys) {
    const all = props().getProperties();
    const out = {};
    for (const k of Object.keys(all)) {
      if (!k.startsWith(PREF)) continue;
      const key = k.slice(PREF.length);
      if (keys && keys.indexOf(key) < 0) continue;
      try { out[key] = JSON.parse(all[k]); } catch (err) { /* not ours */ }
    }
    return out;
  }

  function prefsSet(items) {
    const out = {};
    for (const k of Object.keys(items || {})) {
      const text = JSON.stringify(items[k]);
      if (text.length > 8000) throw new Error('That is too much to keep in one setting.');
      out[PREF + k] = text;
    }
    props().setProperties(out);
    return true;
  }

  function prefsRemove(keys) {
    const p = props();
    for (const k of keys || []) p.deleteProperty(PREF + k);
    return true;
  }

  // ── The licence ──────────────────────────────────────────────────────
  //
  // As the extension's worker keeps it (licenceLogic), in the script's
  // user properties: one for the phone app and the phone panel, on every
  // phone. Lemon Squeezy is asked through UrlFetchApp with the key and a
  // name for the activation - and, unlike every other request this script
  // makes, without the script's Google token, which must never go there.

  const LICENCE = 'licence';

  function askLemon([action, fields]) {
    const lic = ns.licenceLogic;
    if (!lic.isAllowedRequest(action, fields)) throw new Error('not_allowed: that is not something the licence check asks.');
    try {
      const res = UrlFetchApp.fetch(lic.urlOf(action), {
        method: 'post', contentType: 'application/x-www-form-urlencoded', payload: lic.formBody(fields),
        headers: { Accept: 'application/json' }, muteHttpExceptions: true,
      });
      return lic.parseReply(res.getContentText());
    } catch (err) {
      return { understood: false, unreachable: true, error: '' };
    }
  }

  // `action`: 'status', 'peek' (no asking, for the panel), 'check',
  // 'enter' with a key, or 'remove'. { view, error? }.
  function licence(action, key) {
    const lic = ns.licenceLogic;
    const env = { storeId: Number(ns.LICENCE_STORE_ID) || 0, where: 'phone app', now: () => Date.now() };
    const flow = lic.flow(String(action || 'status'), env, typeof key === 'string' ? key : '');
    if (!flow) throw new Error('not_allowed: that is not something the licence check does.');
    return lic.runSync(flow, {
      load: () => {
        try { return JSON.parse(props().getProperty(LICENCE) || 'null'); } catch (err) { return null; }
      },
      save: rec => { props().setProperty(LICENCE, JSON.stringify(rec)); },
      ask: askLemon,
    });
  }

  ns.app = {
    page, start, list, body, save, retire, restore, move, createFolder, renameFolder, deleteFolder,
    account, boardGmail, boardGmailMany, boardColumns, layout, saveLayout, googleMany, googleWrite, allowCalendar,
    prefsGet, prefsSet, prefsRemove, licence,
  };
})();
