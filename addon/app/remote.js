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

  const S = {
    label: '_Notes',
    folders: [],
    docs: new Map(), // message id → content, from a search or a save
  };

  ns.notesStore = {
    labelName: () => S.label,
    folders: () => S.folders,

    async list(account, query) {
      const r = await call('appList', query || '');
      S.label = r.label;
      S.folders = r.folders || [];
      Object.keys(r.docs || {}).forEach(id => S.docs.set(id, r.docs[id]));
      return { notes: r.notes, truncated: r.truncated, folders: S.folders };
    },

    // Messages never change, so a note's content, once read, is kept.
    async body(note) {
      if (S.docs.has(note.messageId)) return S.docs.get(note.messageId);
      const doc = await call('appBody', note.messageId);
      S.docs.set(note.messageId, doc);
      return doc;
    },

    async save(account, previous, snap) {
      const r = await call('appSave', previous ? previous.messageId : '', {
        title: snap.title, doc: fmt.normaliseDoc(snap.doc), folderId: snap.folderId || '', noteId: snap.noteId || '',
      });
      S.docs.set(r.note.messageId, fmt.normaliseDoc(snap.doc));
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

  // Asked once, as the app starts: the board keeps its settings per account.
  function loadAccount() {
    return call('appAccount').then(a => { who.account = String(a || ''); return who.account; });
  }

  const threadUrl = threadId =>
    `https://mail.google.com/mail/?authuser=${encodeURIComponent(who.account)}#all/${encodeURIComponent(threadId)}`;

  ns.hooks = {
    getAccount: () => who.account,
    threadUrl,
    // The conversation in Gmail - which, on a phone, the Gmail app may offer to open.
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

  ns.api = { STATE_CODES: new Set(), gmail, gmailMany, googleMany };
  ns.appRemote = { call, loadAccount };

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

  // Read from the script once, then kept here and written through.
  let synced = null;
  const syncAll = async () => (synced = synced || await call('appPrefsGet', null));
  const sync = {
    async get(keys) { return pick(await syncAll(), keys); },
    async set(items) {
      await call('appPrefsSet', items);
      Object.assign(await syncAll(), JSON.parse(JSON.stringify(items)));
    },
    async remove(keys) {
      const list = [].concat(keys);
      await call('appPrefsRemove', list);
      const all = await syncAll();
      for (const k of list) delete all[k];
    },
  };

  const chromeLike = (globalThis.chrome = globalThis.chrome || {});
  if (!chromeLike.storage) chromeLike.storage = { local, sync, onChanged: { addListener() {} } };
})();
