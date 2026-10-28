// ─────────────────────────────────────────────────────────────────────
// Board data
//
// Shared by the board and the dock, so a move made from either is seen by
// both. Gmail is the source of truth for which column a thread is in;
// what lives here is a cache of label ids and thread summaries, plus the
// small things kept apart: the user's own card titles, notes and colours
// (storage.sync, so they follow the user between computers) and card
// order within each column (storage.local, because it changes on every
// drag and sync has a tight write quota). The column layout is kept in
// Gmail, the same for every computer and phone, with a copy here.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { api, logic, KEYS } = ns;

  const bus = new EventTarget();
  const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

  const S = {
    labels: new Map(),   // lower-cased name → label resource
    labelsAt: 0,
    meta: new Map(),     // thread id → summary (see logic.summariseThread)
    pending: new Set(),  // in-flight threads.modify promises
  };

  // Errors that mean "nothing else will work either", which must stop a
  // batch rather than being swallowed per thread.
  function isFatal(err) {
    return api.STATE_CODES.has(err.code) || err.code === 'extension_reloaded';
  }

  // chrome.storage.sync or .local. A Gmail tab left over from before the
  // extension was reloaded has neither, and then gets the error a message
  // to the worker gets there. (The phone app's stand-ins never go.)
  function storageArea(name) {
    const area = chrome.storage && chrome.storage[name];
    if (!area) throw new api.ApiError('extension_reloaded', 'The extension was updated. Reload this Gmail tab.');
    return area;
  }

  // ── Settings ─────────────────────────────────────────────────────────
  //
  // The column layout: Gmail's (logic.layoutReadFlow), one for every
  // computer and phone, with a copy in storage.sync for when Gmail cannot
  // be reached. `layout` is the version in Gmail this board is showing -
  // its id and columns, and the versions a save replaces - or null while
  // Gmail has none, or it could not be read.

  let layout = null;

  // The labels are read afresh with the layout, for the board's load that
  // follows. The board's own label keeps its id through a rename, so once
  // it is known the two are asked for side by side: one wait, not two (in
  // the phone app, a round trip to the script each).
  async function readLayout(columns) {
    const root = logic.labelRoot(columns);
    const known = labelId(root);
    const ask = id => api.layoutRead(id, layout ? layout.id : '');
    const [, early] = await Promise.all([refreshLabels(), known ? ask(known) : null]);
    const rootId = labelId(root);
    const found = !rootId ? null : rootId === known ? early : await ask(rootId);
    if (!found) {
      layout = null;
      return null;
    }
    const cols = found.same && layout ? layout.columns : found.columns;
    layout = { id: found.id, columns: cols, replaces: [found.id, ...(found.older || [])] };
    return cols;
  }

  // Into Gmail, under the board's own parent label, made if need be.
  async function shareColumns(columns) {
    const root = logic.labelRoot(columns);
    await ensureLabels([root]);
    const rootId = labelId(root);
    if (!rootId) throw new Error(`The label “${root}” could not be found.`);
    const made = await api.layoutWrite(rootId, columns, layout ? layout.replaces : []);
    layout = { id: made.id, columns: made.columns, replaces: [made.id] };
  }

  // Gmail's layout when it has one; else this browser's own copy, which
  // then becomes Gmail's - if `firstWrite` (the phone app's copy never
  // does: see remote-board.js); else `fallback()`, or the defaults. With
  // Gmail out of reach, the copy. `shared: false` asks for the copy alone,
  // without asking Gmail: for opening at once, and for the notes and the
  // calendar, which work without the board (or Gmail) at all.
  async function loadColumns(account, { firstWrite = true, fallback = null, shared: ask = true } = {}) {
    const key = KEYS.columns(account);
    const own = (await storageArea('sync').get(key))[key];
    const copy = own ? logic.normaliseColumns(own) : fallback ? await fallback() : logic.defaultColumns();
    if (!ask) return copy;
    let shared;
    try {
      shared = await readLayout(copy);
    } catch (err) {
      if (isFatal(err)) throw err;
      return copy;
    }
    if (shared) {
      if (!own || !logic.sameColumns(shared, copy)) await storageArea('sync').set({ [key]: shared });
      return shared;
    }
    if (own && firstWrite) await shareColumns(copy).catch(() => {});
    return copy;
  }

  // Gmail's layout first, so a save it refuses changes nothing here (the
  // next load would bring Gmail's back anyway); then the copy.
  // `share: false` keeps a step to the copy alone.
  async function saveColumns(account, columns, { share = true } = {}) {
    if (share) await shareColumns(columns);
    await storageArea('sync').set({ [KEYS.columns(account)]: columns });
    emit('columns-changed', { columns });
  }

  async function loadOrder(account) {
    const key = KEYS.order(account);
    const got = await storageArea('local').get(key);
    return got[key] || {};
  }

  async function saveOrder(account, lists, columns) {
    await storageArea('local').set({ [KEYS.order(account)]: logic.pruneOrder(lists, columns) });
  }

  // ── Card edits ───────────────────────────────────────────────────────

  async function loadCardEdits(account) {
    const all = await storageArea('sync').get(null);
    return logic.cardEditsFrom(all, KEYS.cardPrefix(account));
  }

  // A null edit deletes the record. Sync's own quota message ("QUOTA_BYTES
  // quota exceeded") says nothing about what to do, so it is rephrased.
  async function saveCardEdit(account, threadId, edit) {
    const key = KEYS.card(account, threadId);
    try {
      if (edit) await storageArea('sync').set({ [key]: edit });
      else await storageArea('sync').remove(key);
    } catch (err) {
      if (/quota/i.test((err && err.message) || '')) {
        throw Object.assign(new Error(
          'Chrome’s synced storage is full. Clear the notes on cards you no longer need, or take finished cards off the board.'
        ), { code: 'quota' });
      }
      throw err;
    }
  }

  // Gmail's top bar unless a corner, or none, was chosen.
  async function loadDockPlace() {
    const got = await storageArea('sync').get(KEYS.dockPlace);
    const v = got[KEYS.dockPlace];
    return v === 'left' || v === 'right' || v === 'hidden' ? v : 'top';
  }

  // ── Labels ───────────────────────────────────────────────────────────

  async function refreshLabels() {
    const r = await api.gmail('GET', 'labels');
    S.labels = new Map((r.labels || []).map(l => [l.name.toLowerCase(), l]));
    S.labelsAt = Date.now();
  }

  // Labels read this long ago are still fresh enough for the board's load
  // to use rather than read again: they were read with the layout, just
  // before it (readLayout).
  const LABELS_FRESH_MS = 15 * 1000;

  function allLabels() {
    return [...S.labels.values()];
  }

  // Gmail label names are unique case-insensitively, so lookups are too.
  function labelId(name) {
    const l = S.labels.get(String(name || '').toLowerCase());
    return l ? l.id : '';
  }

  async function ensureLabels(names, { fresh = false } = {}) {
    if (fresh || !S.labelsAt) await refreshLabels();

    const wanted = [];
    for (const n of names) wanted.push(...logic.labelAncestors(n), n);

    // Sequential, parents first. Creating a handful of labels happens once
    // per board, so there is nothing to gain from racing them.
    for (const name of [...new Set(wanted)]) {
      if (labelId(name)) continue;
      try {
        const created = await api.gmail('POST', 'labels', null, {
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        });
        S.labels.set(name.toLowerCase(), created);
      } catch (err) {
        // 409: it exists after all (created in another tab, or differing
        // only in case). Re-read rather than fail.
        if (err.code === 'http_409') {
          await refreshLabels();
          if (labelId(name)) continue;
        }
        throw err;
      }
    }
  }

  // Renames the Gmail label in place, so every thread wearing it stays put.
  // If the new name already exists as a different label, the column simply
  // switches to that label - patching would fail with a conflict, and
  // pointing a column at an existing label is a reasonable thing to want.
  async function renameLabel(oldName, newName) {
    if (oldName === newName) return 'unchanged';
    await refreshLabels();
    const oldId = labelId(oldName);
    const existing = labelId(newName);
    if (existing && existing !== oldId) return 'repointed';
    if (!oldId) return 'created-later';
    const updated = await api.gmail('PATCH', `labels/${oldId}`, null, { name: newName });
    S.labels.delete(oldName.toLowerCase());
    S.labels.set(newName.toLowerCase(), updated);
    return 'renamed';
  }

  // ── Threads ──────────────────────────────────────────────────────────

  function thread(id) {
    return S.meta.get(id) || null;
  }

  // What the phone app's board last showed (board.js fromCopy), drawn
  // before Gmail answers. The labels give the cards their colours, but
  // nothing that changes Gmail goes by them: S.labelsAt stays 0, so those
  // read the labels first. The threads' summaries are re-read only once
  // Gmail says a thread has changed (its historyId), as for any other.
  function adopt({ labels, threads }) {
    if (!S.labelsAt) S.labels = new Map((labels || []).map(l => [String(l.name).toLowerCase(), l]));
    for (const t of threads || []) if (t && t.id && !S.meta.has(t.id)) S.meta.set(t.id, t);
  }

  // Fetches metadata only for threads that are new to the cache or whose
  // historyId moved. On a warm refresh of an unchanged board that is zero
  // calls beyond the one list per column.
  async function hydrate(refs, account) {
    const need = refs.filter(t => {
      const m = S.meta.get(t.id);
      return !m || (t.historyId && m.historyId !== String(t.historyId));
    });
    // Nothing new: no call at all (in the phone app, a round trip saved).
    if (!need.length) return;
    const results = await api.gmailMany(need.map(t => ['GET', `threads/${t.id}`, {
      format: 'metadata',
      // To and Cc: whether a message of the user's own went to anyone else.
      metadataHeaders: ['Subject', 'From', 'Date', 'To', 'Cc'],
    }]));
    results.forEach((full, i) => {
      // One thread deleted between list and get must not sink the board.
      if (full && full.error) {
        if (isFatal(full.error)) throw full.error;
        return;
      }
      if (full) S.meta.set(need[i].id, logic.summariseThread(full, account));
    });
  }

  // Brings the columns' label names in line with Gmail (a label renamed
  // there is followed by its id) and records ids for labels that have
  // them. Saved only when something changed.
  async function syncColumnLabels(account, columns) {
    const { columns: next, changed } = logic.resolveColumnLabels(columns, [...S.labels.values()]);
    if (!changed) return next;
    // Into Gmail's layout too, when there is one, so the other devices
    // need not do the same; if Gmail will not take it now, the copy here
    // follows all the same, and the next load tries again.
    try {
      await saveColumns(account, next, { share: !!layout });
    } catch (err) {
      if (isFatal(err)) throw err;
      await saveColumns(account, next, { share: false });
    }
    return next;
  }

  // Everything the board needs for one render: per-column thread ids
  // (each thread in exactly one column), which columns were cut off, and
  // the columns themselves, in case a label was renamed in Gmail.
  async function loadBoard(account, columnsIn) {
    // Let any move still in flight land first, or the list could show the
    // thread back in the column it is leaving.
    await Promise.allSettled([...S.pending]);
    // Renames first: ensuring labels by their stale names would recreate
    // the old ones, empty. Read a moment ago with the layout, they need
    // not be read again.
    if (Date.now() - S.labelsAt > LABELS_FRESH_MS) await refreshLabels();
    let columns = await syncColumnLabels(account, columnsIn);
    await ensureLabels(columns.map(c => c.label));
    columns = await syncColumnLabels(account, columns);

    const results = await api.gmailMany(columns.map(col => ['GET', 'threads', { labelIds: labelId(col.label), maxResults: 100 }]));
    const failed = results.find(r => r && r.error);
    if (failed) throw failed.error;

    const raw = {};
    const truncated = {};
    const refs = new Map();
    columns.forEach((col, i) => {
      const r = results[i] || {};
      const threads = r.threads || [];
      raw[col.id] = threads.map(t => t.id);
      truncated[col.id] = !!r.nextPageToken;
      for (const t of threads) refs.set(t.id, t);
    });

    await hydrate([...refs.values()], account);
    const lists = logic.assignColumns(columns, raw);
    for (const id of Object.keys(lists)) lists[id] = lists[id].filter(t => S.meta.has(t));
    emit('board-loaded', {});
    return { lists, truncated, columns };
  }

  // `source` lets listeners ignore echoes of their own changes: the board
  // has already drawn a move it made, the dock has not.
  async function modify(threadId, diff, source) {
    const p = api.gmail('POST', `threads/${threadId}/modify`, null, diff);
    S.pending.add(p);
    try {
      await p;
    } finally {
      S.pending.delete(p);
    }
    // Mark the cached summary stale so the next refresh re-reads it, and
    // keep its label set honest in the meantime.
    const m = S.meta.get(threadId);
    if (m) {
      m.historyId = '';
      const labels = new Set(m.labelIds);
      diff.removeLabelIds.forEach(id => labels.delete(id));
      diff.addLabelIds.forEach(id => labels.add(id));
      m.labelIds = [...labels];
    }
    emit('thread-changed', { threadId, source });
  }

  // To a column that archives, the conversation is read afresh first (one
  // cheap call): a card shows it as the board last read it, and a reply
  // that came since would otherwise leave the Inbox unseen. With mail in
  // the Inbox not read yet, the card moves but the mail stays in the
  // Inbox ({ keptInInbox }), and archive() is there for "archive anyway".
  async function moveToColumn(threadId, columns, columnId, source) {
    await ensureLabels(columns.map(c => c.label));
    const diff = logic.moveLabelDiff(columns, columnId, labelId);
    let keptInInbox = false;
    if (diff.removeLabelIds.includes('INBOX')) {
      const t = await api.gmail('GET', `threads/${threadId}`, { format: 'minimal' });
      if (logic.archiveHidesUnread(t)) {
        diff.removeLabelIds = diff.removeLabelIds.filter(id => id !== 'INBOX');
        keptInInbox = true;
      }
    }
    await modify(threadId, diff, source);
    return { keptInInbox };
  }

  async function archive(threadId, source) {
    await modify(threadId, { addLabelIds: [], removeLabelIds: ['INBOX'] }, source);
  }

  // Taking a card off the board also forgets its title, note and colour.
  // Edits would otherwise outlive their card, and sync's quota is small
  // enough that leftovers would eventually crowd out the ones in use. A
  // card that merely moves to Done keeps them.
  async function removeFromBoard(threadId, columns, source, account) {
    if (!S.labelsAt) await refreshLabels();
    await modify(threadId, logic.removeLabelDiff(columns, labelId), source);
    if (account) await saveCardEdit(account, threadId, null).catch(() => {});
  }

  async function search(text, account) {
    const r = await api.gmail('GET', 'threads', { q: logic.searchQuery(text), maxResults: 15 });
    const refs = r.threads || [];
    await hydrate(refs, account);
    return refs.map(t => t.id).filter(id => S.meta.has(id));
  }

  // Which column (if any) a single thread is in - for the dock, which has
  // no board loaded. format=minimal is the cheapest call that returns
  // label ids.
  async function threadColumn(threadId, columns) {
    if (!S.labelsAt) await refreshLabels();
    const t = await api.gmail('GET', `threads/${threadId}`, { format: 'minimal' });
    const labels = (t.messages || []).flatMap(m => m.labelIds || []);
    return logic.columnForLabels(columns, labels, labelId);
  }

  ns.store = {
    bus, storageArea, loadColumns, saveColumns, loadOrder, saveOrder, loadCardEdits, saveCardEdit, loadDockPlace,
    refreshLabels, ensureLabels, renameLabel, labelId, allLabels,
    thread, adopt, loadBoard, moveToColumn, archive, removeFromBoard, search, threadColumn,
  };
})();
