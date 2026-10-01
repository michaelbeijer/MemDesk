// ─────────────────────────────────────────────────────────────────────
// Notes data
//
// Notes are messages under one label (_Notes unless renamed), read and
// written through the background worker like everything else. A note's
// versions share an id; saving inserts the new version and then moves
// the old one to Trash, so Gmail's Trash doubles as thirty days of
// history. Messages never change once stored, which makes the metadata
// cache below simple: an entry can only ever go away, never go stale.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { api, store, util, KEYS } = ns;
  const notesLogic = ns.notesLogic;
  const fmt = ns.noteFormat;

  const S = {
    label: null,       // { name, id } once resolved for the current account
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

  // ── Reading ──────────────────────────────────────────────────────────

  // The newest notes first, one entry per note. With a query, Gmail's own
  // search runs inside the label - over bodies too, which is the point of
  // keeping notes in Gmail at all.
  async function list(account, query = '') {
    const label = await resolveLabel(account);
    const r = await api.gmail('GET', 'messages', {
      labelIds: label.id,
      q: String(query || '').trim() || undefined,
      maxResults: 100,
    });
    const refs = r.messages || [];
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

    const { live, stale } = notesLogic.dedupeNotes(refs.map(m => S.meta.get(m.id)).filter(Boolean));
    // Older versions still carrying the label: a save that inserted the
    // new one but never got to trash the old. Tidied quietly - but only
    // from the full list, never from a search, which sees a partial view.
    if (!query) for (const n of stale) retire(n).catch(() => {});
    return { notes: live, truncated: !!r.nextPageToken };
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
  async function save(account, previous, { title, doc }) {
    const label = S.label || await resolveLabel(account);
    const noteId = previous && previous.own ? previous.noteId : notesLogic.newNoteId();
    const clean = fmt.normaliseDoc(doc);
    const text = fmt.toPlain(clean);
    const raw = notesLogic.buildNoteRaw({ noteId, title, body: text, html: fmt.toHtml(clean), account });
    const inserted = await api.gmail('POST', 'messages', null, { raw, labelIds: [label.id] });

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
    };
    S.meta.set(note.messageId, note);
    S.bodies.set(note.messageId, clean);

    if (previous && previous.messageId) await retire(previous).catch(() => {});
    return note;
  }

  // Off the list: a note of ours goes to Trash; mail that was only filed
  // as a note just loses the label and stays where it was.
  async function retire(note) {
    const label = S.label;
    S.meta.delete(note.messageId);
    if (note.own) await api.gmail('POST', `messages/${note.messageId}/trash`);
    else if (label) await api.gmail('POST', `messages/${note.messageId}/modify`, null, { addLabelIds: [], removeLabelIds: [label.id] });
  }

  async function restore(note) {
    if (note.own) await api.gmail('POST', `messages/${note.messageId}/untrash`);
    else if (S.label) await api.gmail('POST', `messages/${note.messageId}/modify`, null, { addLabelIds: [S.label.id], removeLabelIds: [] });
    S.meta.set(note.messageId, note);
  }

  ns.notesStore = { resolveLabel, labelName, list, body, save, retire, restore };
})();
