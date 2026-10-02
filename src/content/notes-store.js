// ─────────────────────────────────────────────────────────────────────
// Notes data
//
// Notes are messages under one label (_Notes unless renamed), read and
// written through the background worker like everything else. A note's
// versions share an id; saving inserts the new version and then moves
// the old one to Trash, so Gmail's Trash doubles as thirty days of
// history. Folders are labels under the notes label; a note carries the
// notes label and at most one folder's.
//
// Messages never change once stored, so the metadata cache below can only
// go stale in one way - a note moved to another folder elsewhere - and
// which folder a note is in is therefore worked out afresh from every
// listing, never taken from the cache.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { api, store, util, KEYS } = ns;
  const notesLogic = ns.notesLogic;
  const fmt = ns.noteFormat;

  const S = {
    label: null,       // { name, id } once resolved for the current account
    folders: [],       // notesLogic.folderTree() of the labels under it
    meta: new Map(),   // message id → note (metadata only)
    bodies: new Map(), // message id → formatted content (note-format blocks)
  };

  // ── The label ────────────────────────────────────────────────────────
  //
  // Remembered by id as well as name, like the board's columns, so that
  // renaming it in Gmail ("_Notes" to "_Notizen", say) is simply followed.

  async function resolveLabel(account) {
    const key = KEYS.notes(account);
    const got = await chrome.storage.sync.get(key);
    const saved = got[key] || {};
    await store.refreshLabels();

    // The same resolution the board uses for its columns: follow the id,
    // fall back to the name, create it if neither exists.
    const wanted = { id: 'notes', title: 'Notes', label: saved.label || notesLogic.DEFAULT_LABEL };
    if (saved.labelId) wanted.labelId = saved.labelId;
    let [col] = ns.logic.resolveColumnLabels([wanted], store.allLabels()).columns;
    await store.ensureLabels([col.label]);
    [col] = ns.logic.resolveColumnLabels([col], store.allLabels()).columns;

    if (col.label !== saved.label || col.labelId !== saved.labelId) {
      await chrome.storage.sync.set({ [key]: { label: col.label, labelId: col.labelId } });
    }
    S.label = { name: col.label, id: col.labelId };
    return S.label;
  }

  function labelName() {
    return S.label ? S.label.name : notesLogic.DEFAULT_LABEL;
  }

  function folders() {
    return S.folders;
  }

  function refreshFolders() {
    S.folders = S.label ? notesLogic.folderTree(store.allLabels(), S.label.name) : [];
    return S.folders;
  }

  // ── Reading ──────────────────────────────────────────────────────────

  // Every note, newest first, one entry per note, each with the folder it
  // is in. The notes label and each folder label are listed separately -
  // Gmail's label filter does not reach into sublabels, and a note filed
  // into a folder by hand in Gmail may lack the notes label. With a query,
  // Gmail's own search runs inside each, over bodies too, which is the
  // point of keeping notes in Gmail at all.
  async function list(account, query = '') {
    const label = await resolveLabel(account);
    const tree = refreshFolders();
    const q = String(query || '').trim() || undefined;
    const scans = [{ id: label.id }, ...tree];
    const results = await util.mapPool(scans, 6, l =>
      api.gmail('GET', 'messages', { labelIds: l.id, q, maxResults: 100 }));

    const seen = new Map(); // message id → label ids it was listed under
    let truncated = false;
    results.forEach((r, i) => {
      if (!r) return;
      if (r.nextPageToken) truncated = true;
      for (const m of r.messages || []) {
        if (!seen.has(m.id)) seen.set(m.id, []);
        seen.get(m.id).push(scans[i].id);
      }
    });
    const refs = [...seen.keys()].map(id => ({ id }));
    await util.mapPool(refs.filter(m => !S.meta.has(m.id)), 6, async m => {
      try {
        const msg = await api.gmail('GET', `messages/${m.id}`, {
          format: 'metadata',
          metadataHeaders: ['Subject', 'Date', notesLogic.NOTE_HEADER],
        });
        S.meta.set(m.id, notesLogic.noteFromMessage(msg));
      } catch (err) {
        if (api.STATE_CODES.has(err.code) || err.code === 'extension_reloaded') throw err;
      }
    });

    for (const [id, via] of seen) {
      const n = S.meta.get(id);
      if (n) n.folderId = notesLogic.folderOf(via, tree);
    }
    const { live, stale } = notesLogic.dedupeNotes(refs.map(m => S.meta.get(m.id)).filter(Boolean));
    // Older versions still carrying the label: a save that inserted the
    // new one but never got to trash the old. Tidied quietly - but only
    // from the full list, never from a search, which sees a partial view.
    if (!query) for (const n of stale) retire(n).catch(() => {});
    return { notes: live, truncated, folders: tree };
  }

  // A note's content as formatted blocks: read from its HTML part, or -
  // for notes saved before formatting existed, and plain mail - from its
  // text.
  async function body(note) {
    if (S.bodies.has(note.messageId)) return S.bodies.get(note.messageId);
    const msg = await api.gmail('GET', `messages/${note.messageId}`, { format: 'full' });
    const doc = fmt.docFromParts(notesLogic.noteFromMessage(msg).parts || {});
    S.bodies.set(note.messageId, doc);
    return doc;
  }

  // ── Writing ──────────────────────────────────────────────────────────

  // Inserts the new version, then retires the old one. If retiring fails
  // the note briefly has two versions; the next full list keeps the newer
  // and tidies the older away, so nothing is lost either way.
  async function save(account, previous, { title, doc, folderId = '', noteId: wanted = '' }) {
    const label = S.label || await resolveLabel(account);
    const folder = folderId && S.folders.some(f => f.id === folderId) ? folderId : '';
    const noteId = notesLogic.noteIdFor(previous, wanted);
    const clean = fmt.normaliseDoc(doc);
    const text = fmt.toPlain(clean);
    const raw = notesLogic.buildNoteRaw({ noteId, title, body: text, html: fmt.toHtml(clean), account });
    const inserted = await api.gmail('POST', 'messages', null, { raw, labelIds: folder ? [label.id, folder] : [label.id] });

    const note = {
      messageId: inserted.id,
      threadId: inserted.threadId || '',
      noteId,
      own: true,
      key: `n:${noteId}`,
      title: notesLogic.titleFor(title, text) || 'Untitled note',
      updated: Date.now(),
      snippet: text.replace(/\s+/g, ' ').trim().slice(0, 140),
      body: null,
      labelIds: inserted.labelIds || [label.id],
      folderId: folder,
    };
    S.meta.set(note.messageId, note);
    S.bodies.set(note.messageId, clean);

    if (previous && previous.messageId) await retire(previous).catch(() => {});
    return note;
  }

  // Off the list: a note of ours goes to Trash; mail that was only filed
  // as a note just loses the notes and folder labels and stays where it was.
  async function retire(note) {
    const label = S.label;
    S.meta.delete(note.messageId);
    if (note.own) await api.gmail('POST', `messages/${note.messageId}/trash`);
    else if (label) {
      await api.gmail('POST', `messages/${note.messageId}/modify`, null, {
        addLabelIds: [], removeLabelIds: [label.id, ...S.folders.map(f => f.id)],
      });
    }
  }

  async function restore(note) {
    if (note.own) await api.gmail('POST', `messages/${note.messageId}/untrash`);
    else if (S.label) {
      await api.gmail('POST', `messages/${note.messageId}/modify`, null, {
        addLabelIds: note.folderId ? [S.label.id, note.folderId] : [S.label.id], removeLabelIds: [],
      });
    }
    S.meta.set(note.messageId, note);
  }

  // ── Folders ──────────────────────────────────────────────────────────

  async function move(note, folderId) {
    if (!S.label) throw new Error('Notes are not loaded yet.');
    await api.gmail('POST', `messages/${note.messageId}/modify`, null,
      notesLogic.moveFolderDiff(S.label.id, S.folders, folderId || ''));
    note.folderId = folderId || '';
  }

  // Under `parent` (a folder) or at the top level. Gmail only nests a label
  // in its sidebar when the parent exists, which ensureLabels sees to.
  async function createFolder(parent, title) {
    if (!S.label) throw new Error('Notes are not loaded yet.');
    const name = `${parent ? parent.name : S.label.name}/${String(title).trim()}`;
    await store.ensureLabels([name], { fresh: true });
    refreshFolders();
    return S.folders.find(f => f.name.toLowerCase() === name.toLowerCase()) || null;
  }

  // Gmail's API renames only the label it is given, so the folder's
  // subfolders are renamed after it - each one only if Gmail has not
  // already done so itself.
  async function renameFolder(folder, title) {
    for (const step of notesLogic.renamePlan(folder, title, S.folders)) {
      await store.refreshLabels();
      const now = store.allLabels().find(l => l.id === step.id);
      if (now && now.name !== step.name) await api.gmail('PATCH', `labels/${step.id}`, null, { name: step.name });
    }
    await store.refreshLabels();
    refreshFolders();
  }

  async function deleteFolder(folder) {
    await api.gmail('DELETE', `labels/${folder.id}`);
    await store.refreshLabels();
    refreshFolders();
  }

  ns.notesStore = {
    resolveLabel, labelName, folders, list, body, save, retire, restore,
    move, createFolder, renameFolder, deleteFolder,
  };
})();
