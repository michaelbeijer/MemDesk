// ─────────────────────────────────────────────────────────────────────
// The phone app's way to Gmail
//
// The Notes view (src/content/notes.js) talks to a notesStore, and the
// board's data layer (src/content/store.js) to `api.gmail` and
// `chrome.storage`. In the extension those reach Gmail through the
// background worker; here they ask the script that served this page,
// through google.script.run, which asks Gmail. Same shapes, same answers,
// so the views run unchanged. The calendar, likewise, through
// `api.googleMany`. Also `hooks`: the account, and opening a
// conversation in Gmail.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const fmt = ns.noteFormat;
  const notesLogic = ns.notesLogic;

  // google.script.run as a promise. A refusal from the script arrives as
  // "not_allowed: …", which the view knows to explain.
  function call(fn, ...args) {
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(err => {
          const text = String((err && err.message) || err || 'Something went wrong').replace(/^(Exception|Error):\s*/, '');
          const e = new Error(text.replace(/^not_allowed:\s*/, ''));
          if (/^not_allowed:/.test(text)) e.code = 'not_allowed';
          reject(e);
        })[fn](...args);
    });
  }

  // ── The phone's own copy ─────────────────────────────────────────────
  //
  // So that the app opens at once, this browser keeps what the notes need
  // before Gmail has answered: whose they are, the list (titles and first
  // lines), the scratchpad's text and the app's settings - and, apart,
  // scratchpad text typed but not yet saved. The page opens on these, and
  // Gmail's answers replace them a moment later. They never leave the phone.

  const COPY = 'memdesk.copy';
  const DRAFT = 'memdesk.draft';
  const readJson = key => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (err) { return null; }
  };
  const writeJson = (key, value) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (err) { /* storage off or full: no copy, only a slower start */ }
  };
  const read = readJson(COPY);
  // { account, label, folders, notes, truncated, scratch, prefs, columns };
  // scratch is { note, doc }, or null once Gmail has said there is none.
  const kept = read && read.v === 1 && read.account ? read : { v: 1 };
  let keepTimer = 0;
  const keepCopy = () => {
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => writeJson(COPY, kept), 150);
  };
  const forgetCopy = () => {
    for (const k of Object.keys(kept)) delete kept[k];
    kept.v = 1;
    writeJson(COPY, null);
    writeJson(DRAFT, null);
  };

  // The listing's fields of a note, and nothing else.
  const plainNote = n => n && {
    messageId: n.messageId, threadId: n.threadId, noteId: n.noteId, own: n.own, key: n.key,
    title: n.title, updated: n.updated, snippet: n.snippet, labelIds: n.labelIds, folderId: n.folderId || '',
  };
  const isScratch = n => !!n && n.noteId === notesLogic.SCRATCHPAD_ID;
  // The scratchpad's text, when it is the newest version seen.
  function keepScratch(note, doc) {
    const had = kept.scratch && kept.scratch.note;
    if (had && had.messageId !== note.messageId && had.updated > note.updated) return;
    kept.scratch = { note: plainNote(note), doc };
    keepCopy();
  }

  const S = {
    label: kept.label || '_Notes',
    folders: kept.folders || [],
    docs: new Map(), // message id → content, from a search or a save
  };
  if (kept.scratch && kept.scratch.note) S.docs.set(kept.scratch.note.messageId, kept.scratch.doc);

  ns.notesStore = {
    labelName: () => S.label,
    folders: () => S.folders,
    // A save tells of a newer version saved elsewhere (error code
    // "conflict"), so the view merges rather than overwrites.
    checksConflicts: true,

    // What to show before Gmail answers (notes.js fromCopy), or null.
    cached() {
      if (!kept.account) return null;
      const draft = readJson(DRAFT);
      return {
        notes: kept.notes || null,
        truncated: !!kept.truncated,
        folders: kept.folders || [],
        scratch: kept.scratch ? kept.scratch : kept.scratch === null ? { note: null, doc: null } : null,
        draft: draft && draft.account === kept.account ? draft : null,
      };
    },

    // The scratchpad's unsaved text, or null once it is saved.
    keepDraft(d) {
      writeJson(DRAFT, d ? { account: who.account, note: plainNote(d.note), base: d.base, doc: d.doc } : null);
    },

    async list(account, query) {
      const r = await call('appList', query || '');
      S.label = r.label;
      S.folders = r.folders || [];
      Object.keys(r.docs || {}).forEach(id => S.docs.set(id, r.docs[id]));
      if (!query) {
        Object.assign(kept, { label: S.label, folders: S.folders, notes: r.notes.map(plainNote), truncated: !!r.truncated });
        keepCopy();
      }
      return { notes: r.notes, truncated: r.truncated, folders: S.folders };
    },

    // Messages never change, so a note's content, once read, is kept.
    async body(note) {
      if (S.docs.has(note.messageId)) return S.docs.get(note.messageId);
      const doc = await call('appBody', note.messageId);
      S.docs.set(note.messageId, doc);
      if (isScratch(note)) keepScratch(note, doc);
      return doc;
    },

    async save(account, previous, snap) {
      const doc = fmt.normaliseDoc(snap.doc);
      const r = await call('appSave', previous ? previous.messageId : '', {
        title: snap.title, doc, folderId: snap.folderId || '', noteId: snap.noteId || '',
      });
      if (r.conflict) {
        const e = new Error('Saved on another device in the meantime.');
        e.code = 'conflict';
        e.newer = r.conflict;
        throw e;
      }
      S.docs.set(r.note.messageId, doc);
      if (isScratch(r.note)) {
        keepScratch(r.note, doc);
        if (kept.notes) kept.notes = [plainNote(r.note)].concat(kept.notes.filter(n => n.key !== r.note.key));
      }
      return r.note;
    },

    async retire(note) { await call('appRetire', note.messageId); },
    async restore(note) { await call('appRestore', note.messageId, note.folderId || ''); },

    async move(note, folderId) {
      await call('appMove', note.messageId, folderId || '');
      note.folderId = folderId || '';
    },

    async createFolder(parent, title) {
      const r = await call('appCreateFolder', parent ? parent.id : '', title);
      S.folders = r.folders;
      return r.folder;
    },

    async renameFolder(folder, title) {
      S.folders = (await call('appRenameFolder', folder.id, title)).folders;
    },

    async deleteFolder(folder) {
      S.folders = (await call('appDeleteFolder', folder.id)).folders;
    },
  };

  // ── Whose mailbox, and opening a conversation ─────────────────────────

  const who = { account: '' };

  if (kept.account) who.account = kept.account;

  // ── Opening ──────────────────────────────────────────────────────────
  //
  // One call as the app opens (appStart), sent before anything is drawn:
  // the account, the settings, the board's first columns if it has none,
  // and the scratchpad - just whether the copy here is still current, if
  // there is one. The page opens on the copy meanwhile (shell.js).

  let started = null;
  let columns = 'columns' in kept ? kept.columns : undefined;
  let prefsTouched = false;

  function start() {
    if (started) return started;
    const hint = kept.scratch && kept.scratch.note ? kept.scratch.note.messageId : '';
    started = call('appStart', hint).then(r => {
      const account = String(r.account || '');
      // A copy kept for another Google account is no use to this one.
      const otherAccount = !!kept.account && kept.account.toLowerCase() !== account.toLowerCase();
      if (otherAccount) forgetCopy();
      who.account = account;
      S.label = r.label || S.label;
      S.folders = r.folders || [];
      if (!prefsTouched) synced = r.prefs || {};
      columns = r.columns || null;
      Object.assign(kept, { account, label: S.label, folders: S.folders, prefs: synced, columns });
      if (r.scratch) {
        const same = kept.scratch && kept.scratch.note && kept.scratch.note.messageId === r.scratch.messageId;
        const doc = r.doc || (same ? kept.scratch.doc : null);
        if (doc) {
          S.docs.set(r.scratch.messageId, doc);
          kept.scratch = { note: plainNote(r.scratch), doc };
        }
      } else {
        kept.scratch = null;
      }
      writeJson(COPY, kept);
      return { scratch: r.scratch || null, otherAccount };
    });
    return started;
  }

  const hasCopy = () => !!kept.account;

  // The board's first columns, when its settings have none: from the
  // first call, or the copy - or, failing those, asked for.
  async function firstColumns() {
    if (columns !== undefined) return columns;
    if (started) {
      try { await started; } catch (err) { /* asked for below */ }
      if (columns !== undefined) return columns;
    }
    return call('appBoardColumns');
  }

  // On a phone, Gmail is its mobile site, which drops the desktop
  // address's "#all/<id>" and shows the inbox; its own form for a
  // conversation (#cv/<list>/<id>, All Mail holding every one) opens the
  // email itself. Tried on Android: the Gmail app cannot be sent to one
  // email from a web page - every way in only opened it on the inbox.
  // On a computer (the app installed there), Gmail's usual address.
  const onPhone = () => !!(navigator.userAgentData && navigator.userAgentData.mobile) ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const threadUrl = threadId => (onPhone()
    ? `https://mail.google.com/mail/mu/mp/?authuser=${encodeURIComponent(who.account)}#cv/All%20Mail/${encodeURIComponent(threadId)}`
    : `https://mail.google.com/mail/?authuser=${encodeURIComponent(who.account)}#all/${encodeURIComponent(threadId)}`);

  ns.hooks = {
    getAccount: () => who.account,
    threadUrl,
    // The conversation in Gmail, in the browser.
    openThread(threadId) {
      window.open(threadUrl(threadId), '_blank', 'noopener');
    },
  };

  // ── The board's Gmail ────────────────────────────────────────────────
  //
  // appBoardGmail allows only what the board does with Gmail. Errors come
  // back as the extension's do ("http_409"), since the board acts on some.

  function gmailError(message, status) {
    const e = new Error(String(message || 'Gmail did not answer.'));
    const m = /Gmail answered (\d{3})/.exec(e.message);
    e.code = status ? `http_${status}` : m ? `http_${m[1]}` : 'gmail';
    return e;
  }

  function gmail(method, path, query, body) {
    return call('appBoardGmail', method, path, query || null, body || null).catch(err => {
      if (!err.code) throw gmailError(err.message);
      throw err;
    });
  }

  // A batch of reads in one round trip: a board's worth of cards at once.
  async function gmailMany(list) {
    const results = await call('appBoardGmailMany', list);
    return results.map(r => (r && r.error ? { error: gmailError(r.error.message, r.error.status) } : r));
  }

  // ── The calendar's Google ────────────────────────────────────────────
  //
  // Calendar and Tasks reads, in one round trip, as the extension's
  // worker answers them: each the response, or { error } with a code.

  function googleError(e) {
    const err = new Error(String(e.message || 'Google did not answer.'));
    err.code = e.code || (e.status ? `http_${e.status}` : 'google');
    if (e.url) err.allowUrl = String(e.url);
    return err;
  }

  async function googleMany(list) {
    const results = await call('appGoogleMany', list);
    return results.map(r => (r && r.error ? { error: googleError(r.error) } : r));
  }

  // One change, as the extension's worker makes it: the answer, or a
  // refusal thrown with its code ("changed", "calendar_scope").
  async function googleWrite(service, method, path, body, etag) {
    const r = await call('appGoogleWrite', service, method, path, body === undefined ? null : body, etag || '');
    if (r && r.error) throw googleError(r.error);
    return r ? r.data : null;
  }

  // The licence, kept by the script (licenceLogic): { view, error? }.
  function licence(action, key) {
    return call('appLicence', action, key || '');
  }

  // The board's layout in Gmail: the script reads and writes it
  // (app-server.js), with the same flows as the extension.
  const layoutRead = (rootLabelId, knownId) => call('appLayout', rootLabelId, knownId || '');
  const layoutWrite = (rootLabelId, columns, replaces) => call('appSaveLayout', rootLabelId, columns, replaces || []);

  ns.api = { STATE_CODES: new Set(), gmail, gmailMany, googleMany, googleWrite, licence, layoutRead, layoutWrite };
  ns.appRemote = { call, start, hasCopy, firstColumns };

  // ── chrome.storage, as the board uses it ─────────────────────────────
  //
  // "sync" - the column layout and card titles, notes and colours - is the
  // script's per-user properties: the same on every phone and computer
  // the app is opened on (though not shared with the extension, whose
  // copy is Chrome's). "local" - card order and the last tab - is this
  // browser's own storage, as in the extension.

  function pick(all, keys) {
    if (keys === null || keys === undefined) return { ...all };
    if (typeof keys === 'string') keys = [keys];
    const out = {};
    if (Array.isArray(keys)) {
      for (const k of keys) if (k in all) out[k] = all[k];
      return out;
    }
    for (const k of Object.keys(keys)) out[k] = k in all ? all[k] : keys[k];
    return out;
  }

  // The app's old name, kept so prefs saved before the rename still count.
  const LOCAL = 'supermail.';
  function localAll() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LOCAL)) continue;
        try { out[k.slice(LOCAL.length)] = JSON.parse(localStorage.getItem(k)); } catch (err) { /* not ours */ }
      }
    } catch (err) { /* storage off: nothing kept */ }
    return out;
  }
  const local = {
    async get(keys) { return pick(localAll(), keys); },
    async set(items) {
      try { for (const k of Object.keys(items)) localStorage.setItem(LOCAL + k, JSON.stringify(items[k])); } catch (err) { /* not kept */ }
    },
    async remove(keys) {
      try { for (const k of [].concat(keys)) localStorage.removeItem(LOCAL + k); } catch (err) { /* nothing to remove */ }
    },
  };

  // From the first call (or the copy, until it answers), then kept here
  // and written through.
  let synced = kept.prefs || null;
  const syncAll = async () => {
    if (!synced && started) { try { await started; } catch (err) { /* asked for below */ } }
    return (synced = synced || await call('appPrefsGet', null));
  };
  const sync = {
    async get(keys) { return pick(await syncAll(), keys); },
    async set(items) {
      prefsTouched = true;
      await call('appPrefsSet', items);
      Object.assign(await syncAll(), JSON.parse(JSON.stringify(items)));
      kept.prefs = synced;
      keepCopy();
    },
    async remove(keys) {
      prefsTouched = true;
      const list = [].concat(keys);
      await call('appPrefsRemove', list);
      const all = await syncAll();
      for (const k of list) delete all[k];
      kept.prefs = synced;
      keepCopy();
    },
  };

  const chromeLike = (globalThis.chrome = globalThis.chrome || {});
  if (!chromeLike.storage) chromeLike.storage = { local, sync, onChanged: { addListener() {} } };
})();
