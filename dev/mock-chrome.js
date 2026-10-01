// ─────────────────────────────────────────────────────────────────────
// Dev preview: a stand-in for chrome.* and for Gmail itself
//
// Lets the real content-script files run in an ordinary page with no
// extension, no Google account and no network. chrome.runtime.sendMessage
// answers exactly as the background worker would, backed by an in-memory
// mailbox; chrome.storage is three in-memory areas with onChanged.
//
// Every person, company and address below is invented. Domains use the
// reserved .example TLD.
//
// Query flags:
//   ?state=auth_required   gmail calls fail until "Connect Gmail" is used
//   ?state=not_configured  no client ID saved
//   ?fail=modify           every threads.modify fails with a 500
//   ?fresh                 no Board/* labels yet, so the board creates them
//   ?page=N                cap list pages at N threads (shows truncation)
//   ?latency=MS            simulated round-trip time (default 120)
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const LATENCY = Number(params.get('latency') || 120);
  const STATE = params.get('state') || '';
  const FAIL = params.get('fail') || '';
  const PAGE_CAP = Number(params.get('page') || 0);
  const FRESH = params.has('fresh');
  const ACCOUNT = 'test@example.com';

  // ── People ───────────────────────────────────────────────────────────

  const P = {
    me: 'Sam Test <test@example.com>',
    ingrid: 'Ingrid Vos <ingrid@halverson-vos.example>',
    tomas: 'Tomás Ferreira <tomas.ferreira@lumenra-bio.example>',
    brightwater: 'Brightwater Accounts <accounts@brightwater-language.example>',
    priya: 'Priya Raman <priya.raman@kestrel-medical.example>',
    jonas: 'Jonas Albrecht <jonas@albrecht-ip.example>',
    marta: 'Marta Kowalczyk <marta@oakfield-legal.example>',
    hendrik: 'Hendrik de Graaf <hendrik@degraaf-vertalingen.example>',
    sophie: 'Sophie Laurent <sophie@atelier-meridien.example>',
    guild: '"Northgate Translators\' Guild" <membership@northgate-guild.example>',
    daniel: 'Daniel Okafor <d.okafor@pinecrest-eng.example>',
    elena: 'Elena Petrova <elena.petrova@fernhill-books.example>',
    rafael: 'Rafael Mendes <rafael.mendes@solvia-pharma.example>',
    aiko: 'Aiko Tanaka <aiko.tanaka@example.org>',
    bram: 'Bram Jansen <bram@dijkstra-partners.example>',
    clara: 'Clara Whitfield <clara@fernhill-books.example>',
    lukas: 'Lukas Brandt <lukas@brandt-technik.example>',
    bank: 'Hollis Bank <no-reply@hollis-bank.example>',
    grace: 'Grace Liu <grace@quillmark.example>',
    mateo: 'Mateo García <mateo@vandermolen-instruments.example>',
    noor: 'Noor Haddad <noor@cedar-localisation.example>',
    felix: 'Felix Hartmann <felix.hartmann@example.net>',
    olivia: 'Olivia Brennan <olivia@larkspur-legal.example>',
    tms: 'Tessellate TMS <jobs@tessellate-tms.example>',
    yusuf: 'Yusuf Demir <yusuf@demir-conferences.example>',
  };

  // ── Seed threads ─────────────────────────────────────────────────────
  //
  // m(from, hoursAgo, snippet, extraLabels). Snippets are HTML-encoded the
  // way Gmail sends them, so the card's entity decoding gets exercised.

  const m = (from, hoursAgo, snippet, extra = []) => ({ from, hoursAgo, snippet, extra });

  const SEED = [
    { cols: ['todo'], subject: 'Quote request: DE→EN patent, 14,200 words', msgs: [
      m(P.ingrid, 26, 'Dear Sam, we&#39;d like a quote for the attached &quot;Verfahren zur Beschichtung&quot; application &amp; its 24 claims. The deadline is flexible.'),
      m(P.me, 25, 'Thanks Ingrid, I&#39;ll have a quote to you tomorrow morning.'),
      m(P.ingrid, 2, 'Great, thank you. One more thing: could you also quote for the two priority documents?', ['UNREAD']),
    ] },
    { cols: ['todo'], subject: 'Urgent: certified translation of a birth certificate', extra: ['STARRED'], msgs: [
      m(P.olivia, 0.7, 'Hi Sam, a client needs a certified PL&gt;EN translation by Friday. The scan is attached. Is that doable?', ['UNREAD']),
    ] },
    { cols: ['todo'], subject: 'Deadline moved to Thursday 10:00', extra: ['STARRED'], msgs: [
      m(P.jonas, 5, 'Quick heads-up: the client has moved the filing deadline to Thursday 10:00 CET. Sorry for the squeeze!'),
    ] },
    { cols: ['todo'], subject: 'Proofreading feedback – chapter 4', msgs: [
      m(P.elena, 74, 'I&#39;ve gone through chapter 4. Mostly small things, see the tracked changes. Two terminology questions at the end.'),
      m(P.me, 50, 'Thanks Elena, looking now.'),
    ] },
    { cols: ['todo', 'waiting'], subject: 'Drawing labels – query 7', msgs: [
      m(P.daniel, 98, 'Query 7: should &lt;Abb. 3&gt; be &quot;Fig. 3&quot; or &quot;Figure 3&quot; in the claims?'),
      m(P.me, 75, 'Fig. 3 in the claims, Figure 3 in the description, as agreed.'),
      m(P.daniel, 20, 'Perfect, that matches our style sheet. Updating now.'),
    ] },
    { cols: ['todo'], subject: 'Availability for October?', msgs: [
      m(P.grace, 140, 'We have a 30k-word medical device manual landing mid-October. Any capacity in weeks 42&#x2013;43?'),
    ] },
    { cols: ['doing'], subject: 'Glossary for the stent coating project', extra: ['IMPORTANT'], msgs: [
      m(P.tomas, 220, 'Attached is our in-house glossary (EN/PT, 340 terms). Please flag anything that looks inconsistent.'),
      m(P.me, 196, 'Thanks Tomás. Three entries disagree with the IFU; notes attached.'),
      m(P.tomas, 170, 'Good catches. Our regulatory team agrees with 2 of 3.'),
      m(P.me, 1, 'Updated glossary attached &amp; locked. I&#39;ll start on the coating spec today.'),
    ] },
    { cols: ['doing'], subject: 'Termbase export won’t open', msgs: [
      m(P.hendrik, 50, 'The .tbx you sent opens as an empty glossary on my side. Could it be the encoding?'),
      m(P.me, 48, 'Odd! Re-exporting as UTF-8 now.'),
      m(P.hendrik, 3, 'That worked: all 1,284 entries are there. Thanks!', ['UNREAD']),
    ] },
    { cols: ['doing'], subject: 'Office action response – claims 1–12', msgs: [
      m(P.bram, 7, 'Attached is the examiner&#39;s report. We need the amended claims in English by the 9th.', ['UNREAD']),
    ] },
    { cols: ['waiting'], subject: 'Updated IFU files & tracked changes', msgs: [
      m(P.priya, 120, 'Could you update the IFU with the new sterilisation section?'),
      m(P.me, 96, 'Hi Priya, here are the updated IFU files with tracked changes. Let me know if the regulatory team has comments.'),
    ] },
    { cols: ['waiting'], subject: 'Invoice 2026-131 – Lumenra Biotech', msgs: [
      m(P.me, 290, 'Please find attached invoice 2026-131 for the stent coating glossary (14 hours).', ['SENT']),
    ] },
    { cols: ['done'], archived: true, subject: 'Remittance advice – invoice 2026-114', msgs: [
      m(P.brightwater, 360, 'Payment of &#8364;1,840.00 has been made to your account. Reference BW-2026-114.'),
    ] },
    { cols: ['done'], archived: true, subject: 'PO 88213 for the stability study', msgs: [
      m(P.rafael, 480, 'Please find PO 88213 attached for the stability study translation (DE/FR/IT).'),
      m(P.me, 460, 'Received, thank you Rafael. Delivery as discussed on the 30th.'),
    ] },
    { cols: ['done'], archived: true, subject: 'Batch 3 delivered ✔', msgs: [
      m(P.noor, 720, 'All 46 files of batch 3 are in the portal. QA report attached &#x2014; zero major errors.'),
    ] },
    { cols: [], subject: 'Can you take a 3,000-word NDA this week?', msgs: [
      m(P.marta, 0.5, 'Hello Sam, we have a 3,000-word NDA (EN&gt;DE) that needs to go out by Wednesday. Interested?', ['UNREAD']),
    ] },
    { cols: [], subject: 'Website copy: FR→EN brief', msgs: [
      m(P.sophie, 28, 'Here is the brief for the new website copy. Tone: warm, not salesy. About 4,500 words.'),
    ] },
    { cols: [], subject: 'Your membership renewal', msgs: [
      m(P.guild, 76, 'Your Northgate Translators&#39; Guild membership renews on 1 November. No action needed.'),
    ] },
    { cols: [], subject: 'Coffee next week?', msgs: [
      m(P.aiko, 46, 'I&#39;m in town Tuesday to Thursday. Coffee at the usual place?'),
    ] },
    { cols: [], subject: '', msgs: [
      m(P.aiko, 6, 'Photo from Saturday attached.'),
    ] },
    { cols: [], subject: 'Sample translation feedback', msgs: [
      m(P.clara, 9, 'Our editor loved the sample. A few notes on house style before you start the full book.', ['UNREAD']),
    ] },
    { cols: [], subject: 'Style guide question (‘shall’ vs ‘must’)', msgs: [
      m(P.lukas, 124, 'In the safety section, do we render &quot;muss&quot; as &quot;shall&quot; or &quot;must&quot;?'),
      m(P.me, 120, '&quot;Shall&quot; for requirements, &quot;must&quot; for warnings. Happy to add it to the style guide.'),
      m(P.lukas, 100, 'Please do. Thanks!'),
    ] },
    { cols: [], subject: 'Your statement is ready', msgs: [
      m(P.bank, 240, 'Your September statement for the account ending 4412 is ready to view.'),
    ] },
    { cols: [], subject: 'Referral: Vandermolen Instruments', msgs: [
      m(P.mateo, 310, 'I passed your name to Vandermolen Instruments. They need a DE&gt;EN manual translated this quarter.'),
    ] },
    { cols: [], subject: 'Question about your CAT tool workflow', msgs: [
      m(P.felix, 430, 'I read your post about terminology checks. How do you handle client glossaries that conflict?'),
    ] },
    { cols: [], subject: 'New job available: 2,450 words EN→NL', msgs: [
      m(P.tms, 0.8, 'A new job matching your profile is available: 2,450 words, technical, due in 3 days.', ['UNREAD']),
    ] },
    { cols: [], archived: true, subject: 'Conference panel – speaker notes', msgs: [
      m(P.yusuf, 24 * 400, 'Thanks for joining the panel. Speaker notes attached for your records.'),
    ] },
  ];

  // ── Mailbox ──────────────────────────────────────────────────────────

  const now = Date.now();
  let historyCounter = 5000;
  let labelCounter = 10;

  const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'STARRED', 'UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL'];
  const labels = SYSTEM_LABELS.map(id => ({ id, name: id, type: 'system' }));

  function addUserLabel(name) {
    const label = {
      id: `Label_${labelCounter++}`,
      name,
      type: 'user',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    };
    labels.push(label);
    return label;
  }

  const COLUMN_LABELS = { todo: 'Board/To do', doing: 'Board/Doing', waiting: 'Board/Waiting', done: 'Board/Done' };
  addUserLabel('Clients');
  addUserLabel('Invoices');
  if (!FRESH) {
    addUserLabel('Board');
    for (const name of Object.values(COLUMN_LABELS)) addUserLabel(name);
  }
  const labelByName = name => labels.find(l => l.name.toLowerCase() === String(name).toLowerCase());

  const threads = new Map();
  SEED.forEach((seed, i) => {
    // Legacy-style 16-digit hex ids, like the ones the real API returns.
    const threadId = `18f2a3b4c5d6${(0xe000 + i * 37).toString(16)}`;
    const colLabels = FRESH ? [] : seed.cols.map(c => labelByName(COLUMN_LABELS[c]).id);
    const messages = seed.msgs.map((mm, j) => {
      const fromMe = mm.from === P.me;
      // Like Gmail: your own messages carry SENT, not INBOX, so a thread
      // you started and nobody answered is not in the Inbox.
      const base = fromMe ? ['SENT'] : (seed.archived ? [] : ['INBOX']);
      const ts = Math.round(now - mm.hoursAgo * 3600 * 1000);
      return {
        id: `${threadId}${j}`,
        threadId,
        labelIds: [...new Set([...base, ...colLabels, ...(seed.extra || []), ...mm.extra])],
        snippet: mm.snippet,
        historyId: String(historyCounter++),
        internalDate: String(ts),
        payload: {
          headers: [
            { name: 'From', value: mm.from },
            { name: 'To', value: fromMe ? 'them@example.net' : P.me },
            { name: 'Subject', value: j === 0 ? seed.subject : (seed.subject ? `Re: ${seed.subject}` : '') },
            { name: 'Date', value: new Date(ts).toUTCString() },
          ],
        },
      };
    });
    threads.set(threadId, { id: threadId, historyId: String(historyCounter++), messages });
  });

  // ── Search ───────────────────────────────────────────────────────────

  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const labelSlug = name => fold(name).replace(/[\s/]+/g, '-');

  function threadLabels(t) {
    return new Set(t.messages.flatMap(msg => msg.labelIds));
  }

  function header(msg, name) {
    const h = msg.payload.headers.find(x => x.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  }

  // A small subset of Gmail's query language: in:, is:, label:, from:,
  // subject:, and plain words. Enough to make the "+" search believable.
  function matches(t, q) {
    const tokens = String(q || '').match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) || [];
    const have = threadLabels(t);
    for (const raw of tokens) {
      const tok = raw.replace(/"/g, '');
      const [op, ...rest] = tok.includes(':') ? tok.split(':') : ['', tok];
      const val = fold(rest.join(':') || tok);
      if (op === 'in') {
        if (val === 'inbox' && !have.has('INBOX')) return false;
        if (val === 'sent' && !have.has('SENT')) return false;
      } else if (op === 'is') {
        if (val === 'unread' && !have.has('UNREAD')) return false;
        if (val === 'starred' && !have.has('STARRED')) return false;
        if (val === 'important' && !have.has('IMPORTANT')) return false;
      } else if (op === 'label') {
        const ok = labels.some(l => have.has(l.id) && labelSlug(l.name) === labelSlug(val));
        if (!ok) return false;
      } else if (op === 'from') {
        if (!t.messages.some(msg => fold(header(msg, 'From')).includes(val))) return false;
      } else if (op === 'subject') {
        if (!fold(header(t.messages[0], 'Subject')).includes(val)) return false;
      } else {
        const hay = fold(t.messages.map(msg => `${header(msg, 'From')} ${header(msg, 'Subject')} ${msg.snippet}`).join(' '));
        if (!hay.includes(fold(tok))) return false;
      }
    }
    return !have.has('TRASH') && !have.has('SPAM');
  }

  // ── API ──────────────────────────────────────────────────────────────

  class HttpError extends Error {
    constructor(status, message) { super(message); this.code = `http_${status}`; }
  }

  const latest = t => Math.max(...t.messages.map(msg => Number(msg.internalDate)));
  const changed = () => window.dispatchEvent(new CustomEvent('fakegmail:change'));

  const box = {
    profile() {
      return { emailAddress: ACCOUNT, messagesTotal: 4242, threadsTotal: threads.size, historyId: String(historyCounter) };
    },

    listLabels() {
      return { labels };
    },

    createLabel(body) {
      if (!body || !body.name) throw new HttpError(400, 'Invalid label name');
      if (labelByName(body.name)) throw new HttpError(409, 'Label name exists or conflicts');
      const l = addUserLabel(body.name);
      Object.assign(l, { labelListVisibility: body.labelListVisibility, messageListVisibility: body.messageListVisibility });
      changed();
      return l;
    },

    patchLabel(id, body) {
      const l = labels.find(x => x.id === id);
      if (!l) throw new HttpError(404, 'Requested entity was not found.');
      if (l.type === 'system') throw new HttpError(400, 'Invalid update request');
      if (body.name) {
        const clash = labelByName(body.name);
        if (clash && clash.id !== id) throw new HttpError(409, 'Label name exists or conflicts');
        l.name = body.name;
      }
      changed();
      return l;
    },

    listThreads(query) {
      let list = [...threads.values()];
      if (query.labelIds) {
        const want = [].concat(query.labelIds);
        list = list.filter(t => { const have = threadLabels(t); return want.every(id => have.has(id)); });
        list = list.filter(t => !threadLabels(t).has('TRASH'));
      }
      if (query.q) list = list.filter(t => matches(t, query.q));
      list.sort((a, b) => latest(b) - latest(a));
      const start = Number(query.pageToken || 0);
      const size = Math.min(Number(query.maxResults || 100), PAGE_CAP || Infinity);
      const page = list.slice(start, start + size);
      const out = {
        threads: page.map(t => ({ id: t.id, historyId: t.historyId, snippet: t.messages[t.messages.length - 1].snippet })),
        resultSizeEstimate: list.length,
      };
      if (start + size < list.length) out.nextPageToken = String(start + size);
      if (!out.threads.length) delete out.threads;
      return out;
    },

    getThread(id, query) {
      const t = threads.get(id);
      if (!t) throw new HttpError(404, 'Requested entity was not found.');
      const wanted = [].concat(query.metadataHeaders || []).map(s => s.toLowerCase());
      return {
        id: t.id,
        historyId: t.historyId,
        messages: t.messages.map(msg => {
          const base = { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds.slice(), historyId: msg.historyId, internalDate: msg.internalDate };
          if (query.format === 'minimal') return base;
          return {
            ...base,
            snippet: msg.snippet,
            payload: { headers: msg.payload.headers.filter(h => !wanted.length || wanted.includes(h.name.toLowerCase())) },
          };
        }),
      };
    },

    modify(id, body) {
      if (FAIL === 'modify') throw new HttpError(500, 'Backend Error');
      const t = threads.get(id);
      if (!t) throw new HttpError(404, 'Requested entity was not found.');
      const known = new Set(labels.map(l => l.id));
      for (const l of [...(body.addLabelIds || []), ...(body.removeLabelIds || [])]) {
        if (!known.has(l)) throw new HttpError(400, `Invalid label: ${l}`);
      }
      const hid = String(historyCounter++);
      for (const msg of t.messages) {
        const set = new Set(msg.labelIds);
        (body.removeLabelIds || []).forEach(l => set.delete(l));
        (body.addLabelIds || []).forEach(l => set.add(l));
        msg.labelIds = [...set];
        msg.historyId = hid;
      }
      t.historyId = hid;
      changed();
      return { id: t.id, messages: t.messages.map(msg => ({ id: msg.id, threadId: t.id, labelIds: msg.labelIds })) };
    },

    // ── Helpers for the backdrop and the browser tests ──

    threadsInInbox() {
      return [...threads.values()].filter(t => threadLabels(t).has('INBOX')).sort((a, b) => latest(b) - latest(a));
    },
    thread(id) { return threads.get(id); },
    threadLabelNames(id) {
      const t = threads.get(id);
      if (!t) return [];
      const have = threadLabels(t);
      return labels.filter(l => have.has(l.id)).map(l => l.name).sort();
    },
    findThread(subjectPart) {
      for (const t of threads.values()) {
        if (header(t.messages[0], 'Subject').includes(subjectPart)) return t.id;
      }
      return '';
    },
    labelNames() { return labels.filter(l => l.type === 'user').map(l => l.name).sort(); },
    labelByName,
    header,
  };

  // Mirrors the background worker's allow-list, so a call the real proxy
  // would refuse fails here too rather than working only in the preview.
  function route(method, path, query, body) {
    let mm;
    if (method === 'GET' && path === 'profile') return box.profile();
    if (method === 'GET' && path === 'labels') return box.listLabels();
    if (method === 'POST' && path === 'labels') return box.createLabel(body);
    if (method === 'PATCH' && (mm = path.match(/^labels\/([A-Za-z0-9_-]+)$/))) return box.patchLabel(mm[1], body || {});
    if (method === 'GET' && path === 'threads') return box.listThreads(query || {});
    if (method === 'GET' && (mm = path.match(/^threads\/([A-Za-z0-9]+)$/))) return box.getThread(mm[1], query || {});
    if (method === 'POST' && (mm = path.match(/^threads\/([A-Za-z0-9]+)\/modify$/))) return box.modify(mm[1], body || {});
    const err = new Error(`${method} ${path} is not something this extension does.`);
    err.code = 'not_allowed';
    throw err;
  }

  // ── chrome.runtime ───────────────────────────────────────────────────

  let connected = STATE !== 'auth_required';
  const log = [];
  const listeners = [];

  function fail(code, message) {
    return { ok: false, error: { code, message } };
  }

  async function handle(msg) {
    log.push({ type: msg.type, method: msg.method, path: msg.path, at: Date.now() });
    switch (msg.type) {
      case 'gmail': {
        if (STATE === 'not_configured') return fail('not_configured', 'Add your OAuth client ID on the setup page first.');
        if (!connected) return fail('auth_required', 'Gmail is not connected in this browser yet.');
        if (msg.account !== ACCOUNT) {
          return fail('account_mismatch', `Google signed in as ${ACCOUNT}, but this Gmail tab is ${msg.account}.`);
        }
        try {
          const data = route(String(msg.method || 'GET').toUpperCase(), String(msg.path || ''), msg.query, msg.body);
          return { ok: true, data: JSON.parse(JSON.stringify(data)) };
        } catch (err) {
          return fail(err.code || 'internal', err.message);
        }
      }
      case 'connect':
        if (STATE === 'not_configured') return fail('not_configured', 'Add your OAuth client ID on the setup page first.');
        connected = true;
        return { ok: true, data: { email: ACCOUNT } };
      case 'open-options':
        window.dispatchEvent(new CustomEvent('mock:open-options'));
        return { ok: true, data: null };
      case 'hello':
        return { ok: true, data: null };
      default:
        return fail('unknown_message', String(msg.type));
    }
  }

  function sendMessage(msg, callback) {
    // Structured-clone semantics, as across a real extension boundary.
    const copy = JSON.parse(JSON.stringify(msg));
    const p = new Promise(resolve => setTimeout(() => handle(copy).then(resolve), LATENCY));
    if (typeof callback === 'function') { p.then(callback); return undefined; }
    return p;
  }

  // ── chrome.storage ───────────────────────────────────────────────────

  const changeListeners = [];

  function area(name, initial) {
    const data = { ...initial };
    const pick = keys => {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys)) out[k] = k in data ? structuredClone(data[k]) : def;
      return out;
    };
    const notify = changes => {
      if (!Object.keys(changes).length) return;
      setTimeout(() => changeListeners.forEach(fn => fn(changes, name)), 0);
    };
    return {
      async get(keys) { return pick(keys); },
      async set(items) {
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
          data[k] = structuredClone(v);
        }
        notify(changes);
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) {
          if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; }
        }
        notify(changes);
      },
      dump() { return structuredClone(data); },
    };
  }

  const syncInit = STATE === 'not_configured' ? {} : { clientId: '000000000000-preview.apps.googleusercontent.com' };

  window.chrome = {
    runtime: {
      id: 'devpreviewdevpreviewdevpreviewde',
      sendMessage,
      getURL: p => new URL(`../${p.replace(/^\//, '')}`, location.href).href,
      onMessage: { addListener: fn => listeners.push(fn), removeListener() {} },
    },
    storage: {
      sync: area('sync', syncInit),
      local: area('local', {}),
      session: area('session', {}),
      onChanged: { addListener: fn => changeListeners.push(fn), removeListener() {} },
    },
  };

  // What the background worker does for the toolbar button and shortcut.
  function dispatchToTab(msg) {
    for (const fn of listeners) fn(msg, { id: window.chrome.runtime.id }, () => {});
  }

  window.__fakeGmail = box;
  window.__mockChrome = { log, dispatchToTab, account: ACCOUNT };
})();
