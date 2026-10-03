// ─────────────────────────────────────────────────────────────────────
// Notes, from the phone panel
//
// The extension's notes store, made synchronous for Apps Script: every
// trigger and button press starts afresh, reads what it needs, and is
// done. Same label, same folders, same messages, same rules - a note
// saved here is exactly what the extension would have saved.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const notesLogic = ns.notesLogic;
  const fmt = ns.noteFormat;
  const gmail = ns.addonGmail;
  const panel = ns.panelLogic;

  const META = ['Subject', 'Date', notesLogic.NOTE_HEADER];
  // Set at the top of Code.gs, for anyone who renamed _Notes in Gmail.
  const rootName = () => String(globalThis.MEMDESK_NOTES_LABEL || notesLogic.DEFAULT_LABEL).trim();
  const boardName = () => String(globalThis.MEMDESK_BOARD_LABEL || ns.logic.DEFAULT_ROOT).trim();

  // What one card needs to know about the mailbox, read once per trigger
  // or button press: the notes label (made if it is missing), its
  // folders, the board's columns, and - only if a save needs it - the
  // account's address. `labels`: Gmail's list of them, if already read.
  function context(labels) {
    const name = rootName();
    let all = labels || gmail.call('GET', 'labels').labels || [];
    let root = all.find(l => l.name.toLowerCase() === name.toLowerCase());
    if (!root) {
      root = gmail.call('POST', 'labels', null, { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
      all = all.concat([root]);
    }
    let email = '';
    return {
      root,
      folders: notesLogic.folderTree(all, root.name),
      board: panel.boardColumns(all, boardName()),
      account() {
        if (!email) email = gmail.call('GET', 'profile').emailAddress;
        return email;
      },
    };
  }

  const notesLabelIds = ctx => [ctx.root.id].concat(ctx.folders.map(f => f.id));

  function describe(ctx, msg) {
    const note = notesLogic.noteFromMessage(msg);
    const labels = msg.labelIds || [];
    const ours = notesLabelIds(ctx);
    note.folderId = notesLogic.folderOf(labels, ctx.folders);
    note.inNotes = labels.some(id => ours.indexOf(id) >= 0);
    note.trashed = labels.indexOf('TRASH') >= 0;
    return note;
  }

  function metadata(refs) {
    return gmail.callAll(refs.map(m => ['GET', `messages/${m.id}`, { format: 'metadata', metadataHeaders: META }]))
      .filter(m => m && !m.error);
  }

  // Newest first, one entry per note: every note, one folder's, or what
  // a Gmail search finds among them. A search reads the notes in full -
  // each with `doc`, its content - so the results can show where the
  // words are.
  function list(ctx, { folderId = '', query = '', max = 20 } = {}) {
    const r = gmail.call('GET', 'messages', { labelIds: folderId || ctx.root.id, q: query || undefined, maxResults: max + 10 });
    const refs = r.messages || [];
    const notes = query
      ? gmail.callAll(refs.map(m => ['GET', `messages/${m.id}`, { format: 'full' }])).filter(m => m && !m.error).map(m => {
        const n = describe(ctx, m);
        n.doc = fmt.docFromParts(n.parts || {});
        return n;
      })
      : metadata(refs).map(m => describe(ctx, m));
    const { live } = notesLogic.dedupeNotes(notes);
    // The scratchpad, when it is listed, at the top - as in the app.
    const scratch = live.findIndex(n => n.noteId === notesLogic.SCRATCHPAD_ID);
    if (scratch > 0 && !query) live.unshift(...live.splice(scratch, 1));
    return { notes: live.slice(0, max), more: live.length > max || !!r.nextPageToken };
  }

  // Whether a message is a note, without reading its body.
  function peek(ctx, messageId) {
    return describe(ctx, gmail.call('GET', `messages/${encodeURIComponent(messageId)}`, { format: 'metadata', metadataHeaders: META }));
  }

  // A note in full: the message, and its content as formatted blocks.
  function open(ctx, messageId) {
    const note = describe(ctx, gmail.call('GET', `messages/${encodeURIComponent(messageId)}`, { format: 'full' }));
    return { note, doc: fmt.docFromParts(note.parts || {}) };
  }

  // A newer version of `note`, if there is one: the newest live message
  // carrying its id - only newer than this one, if this one is live.
  // Gmail lists newest first, so for a live note only the messages above
  // it need reading, which is usually a handful.
  function newerVersion(ctx, note) {
    if (!note || !note.own) return null;
    const live = note.inNotes && !note.trashed;
    const refs = gmail.call('GET', 'messages', { labelIds: ctx.root.id, maxResults: 100 }).messages || [];
    const at = refs.findIndex(m => m.id === note.messageId);
    const found = metadata(live && at >= 0 ? refs.slice(0, at) : refs)
      .map(m => describe(ctx, m))
      .filter(n => n.own && n.noteId === note.noteId && n.messageId !== note.messageId && !n.trashed && (!live || n.updated > note.updated));
    found.sort((a, b) => b.updated - a.updated);
    return found[0] || null;
  }

  // Inserts the new version, then retires the one it replaces: a note of
  // ours goes to Trash (thirty days of history, as in the extension);
  // mail that was only filed as a note just leaves the notes. If that
  // second step fails, the note has two versions until the extension next
  // lists it and tidies the older away. Returns the new message's id.
  function save(ctx, previous, { title, doc, folderId = '', noteId: wanted = '' }) {
    const folder = folderId && ctx.folders.some(f => f.id === folderId) ? folderId : '';
    const noteId = notesLogic.noteIdFor(previous, wanted);
    const clean = fmt.normaliseDoc(doc);
    const text = fmt.toPlain(clean);
    const raw = notesLogic.buildNoteRaw({ noteId, title, body: text, html: fmt.toHtml(clean), account: ctx.account() });
    const inserted = gmail.insertNote({ raw, labelIds: folder ? [ctx.root.id, folder] : [ctx.root.id] });
    if (previous && previous.messageId) {
      try {
        if (previous.own) gmail.trashNote(previous.messageId);
        else gmail.modifyLabels(previous.messageId, { addLabelIds: [], removeLabelIds: notesLabelIds(ctx) });
      } catch (err) {
        console.warn(`Saved, but the previous version stayed: ${err.message}`);
      }
    }
    return inserted.id;
  }

  function move(ctx, messageId, folderId) {
    gmail.modifyLabels(messageId, notesLogic.moveFolderDiff(ctx.root.id, ctx.folders, folderId || ''));
  }

  // ── The board ────────────────────────────────────────────────────────

  // A conversation's labels: those of all its messages together, which is
  // how the board sees it.
  function thread(ctx, threadId) {
    const t = gmail.call('GET', `threads/${encodeURIComponent(threadId)}`, { format: 'minimal' });
    const labelIds = [];
    (t.messages || []).forEach(m => (m.labelIds || []).forEach(id => {
      if (labelIds.indexOf(id) < 0) labelIds.push(id);
    }));
    return { id: t.id || threadId, labelIds };
  }

  // Into a column ('' for off the board).
  function moveThread(ctx, threadId, columnId) {
    gmail.modifyThread(threadId, panel.boardDiff(ctx.board, columnId || ''));
  }

  ns.addonStore = { context, list, peek, open, newerVersion, save, move, thread, moveThread };
})();
