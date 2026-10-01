// ─────────────────────────────────────────────────────────────────────
// Board data
//
// Shared by the board and the dock, so a move made from either is seen by
// both. Gmail is the source of truth for which column a thread is in;
// what lives here is a cache of label ids and thread summaries, plus the
// two small things Gmail cannot hold - the column layout (storage.sync,
// so it follows the user between computers) and card order within each
// column (storage.local, because it changes on every drag and sync has a
// tight write quota).
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { api, logic, util, KEYS } = ns;

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

  // ── Settings ─────────────────────────────────────────────────────────

  async function loadColumns(account) {
    const key = KEYS.columns(account);
    const got = await chrome.storage.sync.get(key);
    return logic.normaliseColumns(got[key]);
  }

  async function saveColumns(account, columns) {
    await chrome.storage.sync.set({ [KEYS.columns(account)]: columns });
    emit('columns-changed', { columns });
  }

  async function loadOrder(account) {
    const key = KEYS.order(account);
    const got = await chrome.storage.local.get(key);
    return got[key] || {};
  }

  async function saveOrder(account, lists, columns) {
    await chrome.storage.local.set({ [KEYS.order(account)]: logic.pruneOrder(lists, columns) });
  }

  async function loadDockPosition() {
    const got = await chrome.storage.sync.get(KEYS.dockPosition);
    const v = got[KEYS.dockPosition];
    return v === 'right' || v === 'hidden' ? v : 'left';
  }

  // ── Labels ───────────────────────────────────────────────────────────

  async function refreshLabels() {
    const r = await api.gmail('GET', 'labels');
    S.labels = new Map((r.labels || []).map(l => [l.name.toLowerCase(), l]));
    S.labelsAt = Date.now();
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

  // Fetches metadata only for threads that are new to the cache or whose
  // historyId moved. On a warm refresh of an unchanged board that is zero
  // calls beyond the one list per column.
  async function hydrate(refs, account) {
    const need = refs.filter(t => {
      const m = S.meta.get(t.id);
      return !m || (t.historyId && m.historyId !== String(t.historyId));
    });
    await util.mapPool(need, 6, async t => {
      try {
        const full = await api.gmail('GET', `threads/${t.id}`, {
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        });
        S.meta.set(t.id, logic.summariseThread(full, account));
      } catch (err) {
        // One thread deleted between list and get must not sink the board.
        if (isFatal(err)) throw err;
      }
    });
  }

  // Everything the board needs for one render: per-column thread ids
  // (each thread in exactly one column) and which columns were cut off.
  async function loadBoard(account, columns) {
    // Let any move still in flight land first, or the list could show the
    // thread back in the column it is leaving.
    await Promise.allSettled([...S.pending]);
    await ensureLabels(columns.map(c => c.label), { fresh: true });

    const results = await util.mapPool(columns, 6, col =>
      api.gmail('GET', 'threads', { labelIds: labelId(col.label), maxResults: 100 })
    );

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
    return { lists, truncated };
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

  async function moveToColumn(threadId, columns, columnId, source) {
    await ensureLabels(columns.map(c => c.label));
    await modify(threadId, logic.moveLabelDiff(columns, columnId, labelId), source);
  }

  async function removeFromBoard(threadId, columns, source) {
    if (!S.labelsAt) await refreshLabels();
    await modify(threadId, logic.removeLabelDiff(columns, labelId), source);
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
    bus, loadColumns, saveColumns, loadOrder, saveOrder, loadDockPosition,
    refreshLabels, ensureLabels, renameLabel, labelId,
    thread, loadBoard, moveToColumn, removeFromBoard, search, threadColumn,
  };
})();
