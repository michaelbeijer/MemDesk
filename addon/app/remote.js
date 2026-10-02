// ─────────────────────────────────────────────────────────────────────
// The phone app's way to Gmail
//
// The Notes view (src/content/notes.js) talks to a notesStore. In the
// extension that store asks Gmail through the background worker; here it
// asks the script that served this page, through google.script.run, which
// asks Gmail. Same shape, same answers, so the view runs unchanged.
// Also the two other things the view expects to find: `hooks` (the
// account, and opening a message in Gmail) and `api` (which errors mean
// the account needs attention - none do here).
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

  ns.hooks = {
    getAccount: () => '',
    // The message in Gmail - which, on a phone, the Gmail app may offer to open.
    openThread(threadId) {
      window.open(`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`, '_blank', 'noopener');
    },
  };

  ns.api = { STATE_CODES: new Set() };
})();
