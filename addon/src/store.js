// ─────────────────────────────────────────────────────────────────────
// Notes and the board, from Apps Script
//
// The extension's notes store, made synchronous for Apps Script, for the
// phone app's server side (app-server.js): every call starts afresh,
// reads what it needs, and is done. Same label, same folders, same
// messages, same rules - a note saved here is exactly what the extension
// would have saved. And the little the phone panel needs: the open
// email's place on the board, and a move to another column.
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

  // What a call from the phone app needs to know about the notes, read
  // once per call: the notes label (made if it is missing), its folders,
  // and - only if a save needs it - the account's address. `labels`:
  // Gmail's list of them, if already read.
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

  // ── The board, for the phone panel ───────────────────────────────────
  //
  // The panel opens on every email, so it reads as little as it can: the
  // labels, for the columns, and the open conversation, side by side in
  // one round trip. Nothing of the notes: no notes label is looked for,
  // and none is made.

  const columnsOf = labels => panel.boardColumns(labels, boardName());
  const threadRead = id => ['GET', `threads/${encodeURIComponent(id)}`, { format: 'minimal' }];
  const messageRead = id => ['GET', `messages/${encodeURIComponent(id)}`, { format: 'minimal' }];

  // A conversation's labels: those of all its messages together, which is
  // how the board sees it.
  function threadOf(t) {
    const labelIds = [];
    (t.messages || []).forEach(m => (m.labelIds || []).forEach(id => {
      if (labelIds.indexOf(id) < 0) labelIds.push(id);
    }));
    return { id: t.id, labelIds };
  }

  // The board's columns, and the open email's conversation. Gmail says
  // which conversation is open, but not in what form; should it not say,
  // or say it in a form its API does not take, the message says which
  // conversation it is in, at the cost of a second round trip.
  function openEmail(messageId, threadId) {
    const [labels, got] = gmail.callAll([['GET', 'labels'], threadId ? threadRead(threadId) : messageRead(messageId)]);
    if (labels.error) throw labels.error;
    const columns = columnsOf(labels.labels || []);
    if (threadId && !got.error) return { columns, thread: threadOf(got) };
    if (got.error && !(threadId && messageId)) throw got.error;
    if (threadId) console.warn(`The open conversation ${threadId} could not be read, so its message was: ${got.error.message}`);
    const msg = threadId ? gmail.call(...messageRead(messageId)) : got;
    return { columns, thread: threadOf(gmail.call(...threadRead(msg.threadId))) };
  }

  // Into a column ('' for off the board), with the columns as they are
  // now. A column that has gone since the card was drawn changes nothing,
  // rather than taking the email off the board.
  function moveThread(threadId, columnId) {
    const columns = columnsOf(gmail.call('GET', 'labels').labels || []);
    const target = columnId ? columns.find(c => c.id === columnId) : null;
    if (columnId && !target) throw new Error('That column is not on the board any more.');
    gmail.modifyThread(threadId, panel.boardDiff(columns, target ? target.id : ''));
    return { columns, target };
  }

  ns.addonStore = { context, peek, open, newerVersion, save, move, openEmail, moveThread };
})();
