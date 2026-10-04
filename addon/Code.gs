// The phone panel and phone app 0.23.0: a Gmail add-on and a web app, in Apps Script.
//
// Paste this whole file over Code.gs in the Apps Script editor, and
// addon/appsscript.json over appsscript.json. The setup steps are in the
// README, under "The phone panel".
//
// Built by tools/build-addon.mjs from the files listed below; change
// those and rebuild rather than editing this copy.
//   addon/src/shims.js
//   src/shared/ns.js
//   src/lib/util.js
//   src/lib/notes-logic.js
//   src/lib/note-format.js
//   src/lib/board-logic.js
//   src/lib/calendar-logic.js
//   addon/src/panel-logic.js
//   addon/src/gmail.js
//   addon/src/store.js
//   addon/src/cards.js
//   addon/src/app-server.js
//   addon/src/triggers.js

// The notes label, and the label the board's column labels are under.
// Change them only if you renamed _Notes or _Board in Gmail.
var MEMDESK_NOTES_LABEL = '_Notes';
var MEMDESK_BOARD_LABEL = '_Board';

// The phone app's icon, in the browser tab and on the home screen.
var MEMDESK_ICON_URL = 'https://raw.githubusercontent.com/michaelbeijer/MemDesk/main/icons/icon-192.png';

var MEMDESK_VERSION = '0.23.0';

// Apps Script has a global object but may not name it globalThis.
var globalThis = typeof globalThis !== 'undefined' ? globalThis : this;

// ════ addon/src/shims.js ══════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// What Apps Script lacks (phone panel only)
//
// The note code shared with the extension encodes messages with btoa,
// atob, TextEncoder and TextDecoder, checks links with URL, and makes
// note ids with crypto.getRandomValues - all browser APIs that Apps
// Script's runtime does not have. These fill them in, in plain JavaScript and only where
// they are missing, so the shared code runs there unchanged.
//
// TextDecoder knows UTF-8 and windows-1252 (which is what a browser
// decodes "iso-8859-1" and "us-ascii" as, too). Any other charset throws,
// and the shared code then falls back to UTF-8, as it does anywhere.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function btoa(binary) {
    const s = String(binary);
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i);
      const b = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      const c = i + 2 < s.length ? s.charCodeAt(i + 2) : 0;
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: a character is outside Latin-1');
      const n = (a << 16) | (b << 8) | c;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
        (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') +
        (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  }

  function atob(text) {
    const s = String(text).replace(/[\t\n\f\r ]+/g, '').replace(/=+$/, '');
    let out = '';
    let buf = 0;
    let bits = 0;
    for (let i = 0; i < s.length; i++) {
      const v = B64.indexOf(s[i]);
      if (v < 0) throw new Error('atob: not base64');
      buf = ((buf << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buf >> bits) & 0xff);
      }
    }
    return out;
  }

  class TextEncoder {
    get encoding() { return 'utf-8'; }

    encode(text) {
      const bytes = [];
      for (const ch of String(text === undefined ? '' : text)) {
        let cp = ch.codePointAt(0);
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // a lone surrogate
        if (cp < 0x80) bytes.push(cp);
        else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
      return new Uint8Array(bytes);
    }
  }

  const UTF8 = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8']);
  const WIN1252 = new Set(['windows-1252', 'cp1252', 'x-cp1252', 'iso-8859-1', 'iso8859-1', 'iso_8859-1', 'latin1',
    'l1', 'us-ascii', 'ascii', 'ansi_x3.4-1968', 'cp819', 'ibm819']);
  // windows-1252's 0x80-0x9F; the rest of the range is Latin-1 itself.
  const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

  class TextDecoder {
    constructor(label = 'utf-8') {
      const l = String(label).trim().toLowerCase();
      if (UTF8.has(l)) this.kind = 'utf-8';
      else if (WIN1252.has(l)) this.kind = 'windows-1252';
      else throw new RangeError(`TextDecoder: unsupported encoding ${label}`);
    }

    get encoding() { return this.kind; }

    decode(input) {
      const b = input || new Uint8Array(0);
      let out = '';
      if (this.kind === 'windows-1252') {
        for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i] >= 0x80 && b[i] < 0xa0 ? CP1252[b[i] - 0x80] : b[i]);
        return out;
      }
      for (let i = 0; i < b.length;) {
        const c = b[i];
        let cp;
        let n;
        if (c < 0x80) { cp = c; n = 1; }
        else if (c >= 0xc2 && c < 0xe0) { cp = c & 0x1f; n = 2; }
        else if (c >= 0xe0 && c < 0xf0) { cp = c & 0x0f; n = 3; }
        else if (c >= 0xf0 && c < 0xf5) { cp = c & 0x07; n = 4; }
        else { out += '�'; i++; continue; }
        let ok = i + n <= b.length;
        for (let k = 1; ok && k < n; k++) {
          const x = b[i + k];
          if ((x & 0xc0) !== 0x80) ok = false;
          else cp = (cp << 6) | (x & 0x3f);
        }
        if (ok && n === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
        if (ok && n === 4 && (cp < 0x10000 || cp > 0x10ffff)) ok = false;
        if (!ok) { out += '�'; i++; continue; }
        out += String.fromCodePoint(cp);
        i += n;
      }
      return out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
    }
  }

  // Note ids only need to be unlikely to collide, not unguessable.
  const crypto = {
    getRandomValues(arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
  };

  // Just enough of URL for the note code's link check: an http(s) or
  // mailto address split into its parts, with the scheme and host in
  // lower case, a default port dropped, an empty path made "/", and
  // anything outside printable ASCII percent-encoded - as a browser does.
  class URL {
    constructor(input) {
      const s = String(input).trim();
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
      if (!m) throw new TypeError(`Invalid URL: ${s}`);
      const enc = x => String(x || '').replace(/[^\x21-\x7e]+/g, run => encodeURIComponent(run));
      this.protocol = `${m[1].toLowerCase()}:`;
      this.search = enc(m[4]);
      this.hash = enc(m[5]);
      if (m[2] === undefined) {
        if (this.protocol === 'http:' || this.protocol === 'https:') throw new TypeError(`Invalid URL: ${s}`);
        this.host = '';
        this.pathname = enc(m[3]);
        this.href = `${this.protocol}${this.pathname}${this.search}${this.hash}`;
        return;
      }
      const auth = /^(?:([^@]*)@)?([^@:]*)(?::(\d*))?$/.exec(m[2]);
      if (!auth || !/^[A-Za-z0-9.\-_~\u0080-\uffff]+$/.test(auth[2])) throw new TypeError(`Invalid URL: ${s}`);
      const port = auth[3] && !((this.protocol === 'http:' && auth[3] === '80') || (this.protocol === 'https:' && auth[3] === '443')) ? `:${auth[3]}` : '';
      this.host = auth[2].toLowerCase() + port;
      this.pathname = enc(m[3]) || '/';
      this.href = `${this.protocol}//${auth[1] !== undefined ? `${enc(auth[1])}@` : ''}${this.host}${this.pathname}${this.search}${this.hash}`;
    }

    toString() { return this.href; }
  }

  const shims = { btoa, atob, TextEncoder, TextDecoder, crypto, URL };
  for (const name of Object.keys(shims)) {
    if (typeof globalThis[name] === 'undefined') globalThis[name] = shims[name];
  }
  if (typeof module === 'object' && module.exports) module.exports = shims;
})();

// ════ src/shared/ns.js ════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Shared namespace
//
// Content scripts are classic scripts that all run in one isolated world.
// Two files that each declared a top-level `const` of the same name would
// collide, so every file wraps itself in an IIFE and hangs what it exports
// off this one object instead. The service worker and the options page
// load the same files and see the same shape.
//
// APP_NAME is the only place the display name lives in code. Nothing
// internal - the namespace, storage keys, CSS classes, element ids - is
// derived from it, so a rename never has to touch stored data. The README
// lists every spot that does carry the name.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  const APP_NAME = 'MemDesk';
  // Shown in the logo's menu. The same as manifest.json's (a test says so),
  // for the phone app too, which has no manifest to read it from.
  const APP_VERSION = '0.23.0';

  // ── Storage keys ─────────────────────────────────────────────────────
  //
  // Keyed by lower-cased account email, because a Gmail tab at /u/1/ is a
  // different mailbox with different labels, and one person's column
  // layout must not leak into another account's board.

  const KEYS = {
    clientId: 'clientId',                        // storage.sync
    dockPosition: 'dockPosition',                // storage.sync
    columns: email => `columns:${String(email).toLowerCase()}`, // storage.sync
    order: email => `order:${String(email).toLowerCase()}`,     // storage.local
    // Card edits get one key per card rather than one map per account:
    // sync caps each item at 8 KB, which a single map would outgrow after
    // a few dozen notes, while the 512-item cap leaves room for hundreds.
    cardPrefix: email => `card:${String(email).toLowerCase()}:`,                  // storage.sync
    card: (email, threadId) => `card:${String(email).toLowerCase()}:${threadId}`, // storage.sync
    notes: email => `notes:${String(email).toLowerCase()}`,     // storage.sync: { label, labelId }
    view: 'view',                                // storage.local: 'board' | 'notes'
    pref: (email, name) => `pref:${String(email).toLowerCase()}:${name}`, // storage.local: the notes' small preferences
    token: email => `token:${String(email).toLowerCase()}`,     // storage.session
    calendarToken: email => `ctoken:${String(email).toLowerCase()}`, // storage.session: the calendar's own sign-in
    gmailTabs: 'gmailTabs',                      // storage.session
  };

  // Element ids for the two shadow hosts. Short and namespaced rather than
  // branded, so they survive a rename and are unlikely to clash with Gmail.
  const HOST_IDS = {
    board: 'gkb-board-host',
    dock: 'gkb-dock-host',
  };

  // The publisher's own OAuth client, for the build that goes to the
  // Chrome Web Store: with it, a user just clicks "Connect Gmail" and needs
  // no Google Cloud project of their own. Empty here, on purpose:
  // tools/package-extension.mjs writes it into the store build only, so a
  // copy loaded from this repository (or a fork) brings its own client,
  // as SETUP.md describes, rather than using up the publisher's quota of
  // users. A client ID saved on the setup page always wins.
  const BUILT_IN_CLIENT_ID = '';

  ns.APP_NAME = APP_NAME;
  ns.APP_VERSION = APP_VERSION;
  ns.BUILT_IN_CLIENT_ID = BUILT_IN_CLIENT_ID;
  ns.KEYS = KEYS;
  ns.HOST_IDS = HOST_IDS;

  if (typeof module === 'object' && module.exports) {
    module.exports = { APP_NAME, APP_VERSION, KEYS, HOST_IDS };
  }
})();

// ════ src/lib/util.js ═════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Small pure helpers
//
// Nothing in here touches the DOM, chrome.* or the network, which is what
// lets the Node tests require this file directly. The content scripts and
// the service worker reach the same functions through the shared
// namespace (ns.util).
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  // ── Header helpers ───────────────────────────────────────────────────

  function headerMap(message) {
    const out = {};
    const headers = (message && message.payload && message.payload.headers) || [];
    for (const h of headers) out[h.name.toLowerCase()] = h.value || '';
    return out;
  }

  // "Anna Vos <anna@example.com>" → { name, email }
  function parseAddress(raw) {
    if (!raw) return { name: '', email: '' };
    const angled = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    if (angled) {
      return {
        name: angled[1].replace(/^["']|["']$/g, '').trim(),
        email: angled[2].trim().toLowerCase(),
      };
    }
    return { name: '', email: raw.trim().toLowerCase() };
  }

  // What to call a sender on a card. A bare address is shortened to its
  // local part, because "accounts" reads better in a narrow column than
  // "accounts@brightwater-language.example".
  function displayName(addr) {
    if (!addr) return '';
    if (addr.name) return addr.name;
    return (addr.email || '').split('@')[0];
  }

  // ── Entities ─────────────────────────────────────────────────────────
  //
  // Gmail returns snippets HTML-encoded. The obvious decoder - assign to a
  // detached element's innerHTML and read textContent back - is what
  // Gmail's Trusted Types policy forbids, and it would also mean feeding
  // untrusted mail text to the HTML parser. A lookup table does the job.

  // The handful every mail needs, plus the typographic ones that HTML
  // mail written in Gmail or Outlook is full of.
  const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
    ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022', middot: '\u00b7',
    laquo: '\u00ab', raquo: '\u00bb', euro: '\u20ac', pound: '\u00a3', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  };

  function decodeEntities(input) {
    // Single pass, so "&amp;lt;" becomes the literal text "&lt;" and is
    // not decoded a second time into "<".
    return String(input == null ? '' : input).replace(
      /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g,
      (whole, body) => {
        if (body[0] === '#') {
          const hex = body[1] === 'x' || body[1] === 'X';
          const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
          // Out-of-range and surrogate code points would throw or produce
          // garbage; leave the original text alone instead.
          if (!isFinite(code) || code < 1 || code > 0x10ffff ||
              (code >= 0xd800 && code <= 0xdfff)) return whole;
          return String.fromCodePoint(code);
        }
        const named = NAMED[body.toLowerCase()];
        return named === undefined ? whole : named;
      }
    );
  }

  // ── Account detection ────────────────────────────────────────────────

  const EMAIL_ONLY_RE = /^[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+$/;
  const EMAIL_ANY_RE = /[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+/;

  // Gmail's title is "<view or subject> - <account> - <product>", e.g.
  // "Inbox (3,591) - someone@example.com - Gmail". Workspace accounts can
  // replace "Gmail" with the organisation's own name, so the product part
  // is not matched. Scanning from the right finds the account even when a
  // subject line contains an address or a dash of its own.
  function accountFromTitle(title) {
    const parts = String(title || '').split(/\s[-–—]\s/);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i].trim();
      if (EMAIL_ONLY_RE.test(p)) return p.toLowerCase();
    }
    return '';
  }

  // "Google Account: Anna Vos  (anna@example.com)" → "anna@example.com"
  function accountFromAriaLabel(label) {
    const m = String(label || '').match(EMAIL_ANY_RE);
    return m ? m[0].replace(/[).,;]+$/, '').toLowerCase() : '';
  }

  // "/mail/u/1/" → 1. Defaults to 0, which is what /mail/ alone means.
  function accountIndexFromPath(pathname) {
    const m = String(pathname || '').match(/\/mail\/u\/(\d+)\//);
    return m ? Number(m[1]) : 0;
  }

  // ── Dates ────────────────────────────────────────────────────────────
  //
  // Month and day names are spelled out here rather than taken from
  // Intl, so a card reads the same whatever the browser locale is and
  // the tests do not depend on the machine they run on.

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  // Compact age for a card: "just now", "12 min", "3 h", "Yesterday",
  // "Mon", "3 Sep", "3 Sep 2024". Hours win over "Yesterday" for anything
  // under a day old, because "2 h" is more useful at 1am than "Yesterday".
  function relativeDate(ts, now = Date.now()) {
    const t = Number(ts);
    if (!t || !isFinite(t)) return '';
    const diff = Math.max(0, now - t);
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours} h`;

    // Calendar days, not 24-hour blocks, so "Yesterday" means yesterday.
    const days = Math.round((startOfDay(now) - startOfDay(t)) / 86400000);
    const d = new Date(t);
    if (days <= 1) return 'Yesterday';
    if (days < 7) return DAYS[d.getDay()];
    const dm = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() === new Date(now).getFullYear() ? dm : `${dm} ${d.getFullYear()}`;
  }

  // Full date for a tooltip: "Tue 3 Sep 2026, 14:05".
  function fullDate(ts) {
    const t = Number(ts);
    if (!t || !isFinite(t)) return '';
    const d = new Date(t);
    const pad = n => String(n).padStart(2, '0');
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // For "updated Xs ago" in the board header.
  function agoText(ms) {
    const s = Math.max(0, Math.floor(Number(ms) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.floor(m / 60)} h ago`;
  }

  // ── Concurrency ──────────────────────────────────────────────────────

  // Runs fn over items with at most `limit` in flight. Gmail's per-user
  // quota is generous, but a board of 100 changed threads fired at once
  // still trips its burst limiter; six at a time keeps a cold load quick
  // without provoking 429s. The first rejection stops new work starting
  // and is re-thrown, so an auth failure does not fan out into 100 more.
  async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    let failed = null;
    async function worker() {
      while (failed === null && next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          if (failed === null) failed = err;
        }
      }
    }
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, worker));
    if (failed !== null) throw failed;
    return results;
  }

  const api = {
    headerMap, parseAddress, displayName, decodeEntities,
    accountFromTitle, accountFromAriaLabel, accountIndexFromPath,
    relativeDate, fullDate, agoText, mapPool,
  };

  ns.util = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

// ════ src/lib/notes-logic.js ══════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Notes logic (pure)
//
// A note is an email that was never sent: a message placed straight into
// the user's own mailbox with messages.insert, carrying the Notes label
// and nothing else - not INBOX, not UNREAD - so it stays out of the way
// until looked for, and Gmail's own search finds it.
//
// Gmail messages cannot be changed once stored, so saving a note inserts
// a new message and moves the previous one to Trash. Each note carries a
// stable id in an X-Gkb-Note header, which is how its versions are tied
// together and - just as important - how the background worker tells a
// note from real mail: it will only insert messages that carry the header
// and only trash messages that already do.
//
// Loaded by the content scripts, the service worker and Node's tests.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const util = (typeof module === 'object' && module.exports) ? require('./util.js') : ns.util;

  const NOTE_HEADER = 'X-Gkb-Note';
  const DEFAULT_LABEL = '_Notes';
  // .invalid is reserved and can never be delivered to, so nothing can
  // ever arrive from or go to this address.
  const NOTE_SENDER = '"Notes" <notes@notes.invalid>';

  // Generous for typed notes, and keeps one save comfortably inside what
  // the non-upload insert endpoint and a runtime message will carry.
  const MAX_BODY = 100000;
  const MAX_TITLE = 300;

  // Labels a note may never be inserted with. A note in the Inbox, or
  // dressed up as sent or draft mail, is no longer out of the way - and
  // nothing here should ever be able to put mail into Spam or Trash.
  const FORBIDDEN_INSERT_LABELS = new Set(['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD']);

  // ── Ids ──────────────────────────────────────────────────────────────

  const ID_RE = /^[a-z0-9]{12,40}$/;

  function newNoteId(rand = n => crypto.getRandomValues(new Uint8Array(n))) {
    return Array.from(rand(12), b => b.toString(36).padStart(2, '0').slice(-2)).join('').slice(0, 20);
  }

  // The scratchpad: one note with a fixed id, so that every computer and
  // phone finds - and saves into - the same one.
  const SCRATCHPAD_ID = 'scratchpad000000';
  const SCRATCHPAD_TITLE = 'Scratchpad';

  // The id a save writes under: the note's own, once it has one; for a
  // first save, the scratchpad's if that is what is being saved, and
  // otherwise a new one. No other id can be asked for.
  function noteIdFor(previous, wanted) {
    if (previous && previous.own && ID_RE.test(String(previous.noteId || ''))) return previous.noteId;
    return wanted === SCRATCHPAD_ID ? SCRATCHPAD_ID : newNoteId();
  }

  // ── Encoding ─────────────────────────────────────────────────────────

  function bytesToBinary(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return out;
  }

  function binaryToBytes(bin) {
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  const utf8ToBase64 = s => btoa(bytesToBinary(new TextEncoder().encode(s)));

  function base64UrlEncode(binary) {
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlDecode(s) {
    const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  }

  // Text in whatever charset the part declared. An unknown or mislabelled
  // charset falls back to UTF-8 rather than failing the whole note.
  function decodeBytes(bytes, charset) {
    try {
      return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  // RFC 2047 encoded words, for a subject that is not plain ASCII. At 39
  // bytes a word, even the first line ("Subject: " and one word) stays
  // under 78 characters, and no character is split across two words,
  // which some readers would show as two broken halves.
  function encodeHeaderText(text) {
    const s = String(text || '');
    if (/^[\x20-\x7e]*$/.test(s)) return s;
    const words = [];
    let chunk = '';
    let bytes = 0;
    for (const ch of s) {
      const n = new TextEncoder().encode(ch).length;
      if (bytes + n > 39 && chunk) {
        words.push(chunk);
        chunk = '';
        bytes = 0;
      }
      chunk += ch;
      bytes += n;
    }
    if (chunk) words.push(chunk);
    return words.map(w => `=?UTF-8?B?${utf8ToBase64(w)}?=`).join('\r\n ');
  }

  // The inverse, for the preview's fake Gmail and for the tests. (The real
  // API hands headers back already decoded.)
  function decodeHeaderText(value) {
    return String(value || '')
      .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
      .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
        const bin = enc.toUpperCase() === 'B'
          ? atob(text)
          : text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
        return decodeBytes(binaryToBytes(bin), charset);
      });
  }

  // Header values never carry line breaks of their own: one in a title
  // would end the header early and start another of the user's choosing.
  const oneLine = s => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // ── Building a note ──────────────────────────────────────────────────

  // A note with no title is filed under its first line, as most notes
  // apps do, so it still reads as something in Gmail's message list.
  function titleFor(title, body) {
    const t = oneLine(title).slice(0, MAX_TITLE);
    if (t) return t;
    const first = String(body || '').split('\n').map(l => l.trim()).find(Boolean) || '';
    return oneLine(first).slice(0, 80);
  }

  function wrap76(s) {
    return s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
  }

  const textPart = (type, s) => [
    `Content-Type: ${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8ToBase64(s.replace(/\n/g, '\r\n'))),
  ];

  // `body` is the plain text. With `html` as well, the note is a
  // multipart/alternative message: Gmail shows the HTML, and its previews
  // and plain-text readers get the text.
  function buildNoteRaw({ noteId, title, body, html, account, date = new Date() }) {
    if (!ID_RE.test(String(noteId || ''))) throw new Error('Invalid note id');
    const me = oneLine(account);
    const text = String(body || '').replace(/\r\n?/g, '\n').slice(0, MAX_BODY);
    const head = [
      // Not from the account's own address: Gmail files anything from you
      // under Sent, whatever labels it was given. Replies still reach you.
      `From: ${NOTE_SENDER}`,
      `To: ${me}`,
      `Reply-To: ${me}`,
      `Subject: ${encodeHeaderText(titleFor(title, text) || 'Untitled note')}`,
      `Date: ${date.toUTCString()}`,
      `Message-ID: <${noteId}.${date.getTime()}@notes.invalid>`,
      `${NOTE_HEADER}: ${noteId}`,
      'MIME-Version: 1.0',
    ];
    let lines;
    if (html) {
      // Base64 never contains "-", so this boundary cannot occur in a part.
      const boundary = `gkb-${noteId}-${date.getTime()}`;
      lines = [
        ...head,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        ...textPart('text/plain', text),
        `--${boundary}`,
        ...textPart('text/html', String(html)),
        `--${boundary}--`,
        '',
      ];
    } else {
      lines = [...head, ...textPart('text/plain', text), ''];
    }
    return base64UrlEncode(lines.join('\r\n'));
  }

  // ── What the worker allows ───────────────────────────────────────────

  function headerBlock(binary) {
    const end = binary.search(/\r?\n\r?\n/);
    return end < 0 ? binary : binary.slice(0, end);
  }

  // The note id a raw message carries, or '' if it is not a note.
  function noteIdOfRaw(raw) {
    let bin;
    try { bin = base64UrlDecode(raw); } catch { return ''; }
    const m = headerBlock(bin).match(new RegExp(`^${NOTE_HEADER}:[ \\t]*([^\\r\\n]*)$`, 'mi'));
    const id = m ? m[1].trim() : '';
    return ID_RE.test(id) ? id : '';
  }

  // The body of a messages.insert the worker will pass on: a note, filed
  // under user labels only, and nothing else in the request.
  function isNoteInsert(body) {
    if (!body || typeof body !== 'object' || typeof body.raw !== 'string') return false;
    const extra = Object.keys(body).filter(k => k !== 'raw' && k !== 'labelIds');
    if (extra.length) return false;
    const labels = body.labelIds === undefined ? [] : body.labelIds;
    if (!Array.isArray(labels)) return false;
    if (labels.some(id => FORBIDDEN_INSERT_LABELS.has(String(id).toUpperCase()))) return false;
    return !!noteIdOfRaw(body.raw);
  }

  // ── Reading notes back ───────────────────────────────────────────────

  function headerOf(message, name) {
    return util.headerMap(message)[name.toLowerCase()] || '';
  }

  function charsetOf(part) {
    const ct = (part.headers || []).find(h => h.name.toLowerCase() === 'content-type');
    const m = ct && /charset="?([^";\s]+)"?/i.exec(ct.value);
    return m ? m[1] : 'utf-8';
  }

  function partText(part) {
    if (!part || !part.body || !part.body.data) return '';
    return decodeBytes(binaryToBytes(base64UrlDecode(part.body.data)), charsetOf(part));
  }

  // A rough text rendering of an HTML email, for notes that arrived as
  // mail (say, sent to yourself from a phone). Done with patterns rather
  // than the DOM: parsing HTML into a document is a Trusted Types sink on
  // Gmail's page, and only the words are wanted anyway.
  function htmlToText(html) {
    const text = String(html || '')
      .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|ul|ol|tr|h[1-6]|blockquote|pre|table)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    return util.decodeEntities(text)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function textParts(payload) {
    const plain = [];
    const html = [];
    (function walk(p) {
      if (!p) return;
      const type = String(p.mimeType || '').toLowerCase();
      if (type === 'text/plain') plain.push(p);
      else if (type === 'text/html') html.push(p);
      (p.parts || []).forEach(walk);
    })(payload);
    return { plain, html };
  }

  // Prefers a text/plain part anywhere in the tree, then HTML.
  function extractText(payload) {
    const { plain, html } = textParts(payload);
    if (plain.length) return plain.map(partText).join('\n').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (html.length) return htmlToText(html.map(partText).join('\n'));
    return '';
  }

  // Both renderings, decoded, for the formatted reader: the HTML is the
  // record, the plain text the fallback for mail that has no HTML.
  function messageParts(payload) {
    const { plain, html } = textParts(payload);
    return {
      plain: plain.map(partText).join('\n').replace(/\r\n?/g, '\n').replace(/\n+$/, ''),
      html: html.map(partText).join('\n'),
    };
  }

  // One note from a messages.get. With format=metadata there is no body
  // (body stays null); with format=full there is.
  function noteFromMessage(msg) {
    const noteId = headerOf(msg, NOTE_HEADER).trim();
    const own = ID_RE.test(noteId);
    const full = !!(msg.payload && (msg.payload.body || msg.payload.parts));
    return {
      messageId: msg.id,
      threadId: msg.threadId || '',
      noteId: own ? noteId : '',
      own,
      key: own ? `n:${noteId}` : `m:${msg.id}`,
      title: oneLine(headerOf(msg, 'Subject')) || 'Untitled note',
      updated: Number(msg.internalDate) || Date.parse(headerOf(msg, 'Date')) || 0,
      snippet: util.decodeEntities(msg.snippet || ''),
      body: full ? extractText(msg.payload) : null,
      parts: full ? messageParts(msg.payload) : null,
      labelIds: msg.labelIds || [],
    };
  }

  // Two live versions of one note mean a save inserted the new one but
  // could not trash the old (offline, closed tab), or two computers saved
  // at once. The newest wins; the rest are reported so they can be
  // tidied into Trash, where they stay recoverable for thirty days.
  function dedupeNotes(notes) {
    const live = [];
    const stale = [];
    const best = new Map();
    for (const n of notes) {
      const cur = best.get(n.key);
      if (!cur) { best.set(n.key, n); continue; }
      if (n.updated > cur.updated) { stale.push(cur); best.set(n.key, n); }
      else stale.push(n);
    }
    for (const n of notes) if (best.get(n.key) === n) live.push(n);
    live.sort((a, b) => b.updated - a.updated);
    return { live, stale };
  }

  // ── Folders ──────────────────────────────────────────────────────────
  //
  // A folder is a Gmail label under the notes label: "_Notes/Work",
  // "_Notes/Work/Clients". Every note carries the notes label itself, plus
  // the label of at most one folder - so "All notes" is one label, and the
  // folders show up nested under _Notes in Gmail's own label list.

  const FOLDER_NAME_MAX = 60;

  // The folders under `root`, in tree order: each parent followed by its
  // children, alphabetically, with its depth. A label whose parent label
  // is missing (made by hand in Gmail) still appears, at its own depth.
  function folderTree(labels, root) {
    const prefix = `${root}/`;
    const list = (labels || [])
      .filter(l => l && typeof l.name === 'string' && l.name.startsWith(prefix) && l.name.length > prefix.length)
      .map(l => {
        const path = l.name.slice(prefix.length);
        const parts = path.split('/');
        return { id: l.id, name: l.name, path, title: parts[parts.length - 1], depth: parts.length - 1, parentPath: parts.slice(0, -1).join('/') };
      });
    // Sorting by path segment by segment keeps every child under its parent.
    const key = f => f.path.split('/').map(p => p.toLowerCase());
    list.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      }
      return x.length - y.length;
    });
    return list;
  }

  // The folder a note is in, from its labels; '' for none. Two folder
  // labels (applied by hand) resolve to the first in tree order.
  function folderOf(labelIds, folders) {
    const have = new Set(labelIds || []);
    const f = (folders || []).find(x => have.has(x.id));
    return f ? f.id : '';
  }

  // Moving a note: keep (or restore) the notes label, add the target's,
  // drop every other folder's.
  function moveFolderDiff(rootId, folders, targetId) {
    const add = [rootId];
    if (targetId) add.push(targetId);
    const remove = (folders || []).map(f => f.id).filter(id => id !== targetId);
    return { addLabelIds: add, removeLabelIds: remove };
  }

  function validateFolderTitle(title, siblings = []) {
    const t = String(title || '').trim();
    if (!t) return 'Give the folder a name.';
    if (t.includes('/')) return 'A folder name cannot contain “/”. Make a subfolder instead.';
    if (t.length > FOLDER_NAME_MAX) return `Keep folder names under ${FOLDER_NAME_MAX} characters.`;
    if (siblings.some(s => s.toLowerCase() === t.toLowerCase())) return `There is already a folder called “${t}” here.`;
    return '';
  }

  // Renaming a folder renames its label and every label below it, since
  // Gmail's API renames only the one label it is given.
  function renamePlan(folder, newTitle, folders) {
    const parent = folder.name.slice(0, folder.name.length - folder.title.length);
    const newName = `${parent}${String(newTitle).trim()}`;
    return (folders || [])
      .filter(f => f.name === folder.name || f.name.startsWith(`${folder.name}/`))
      .map(f => ({ id: f.id, name: newName + f.name.slice(folder.name.length) }));
  }

  // Whether the worker may delete a label: a folder under the notes label
  // with no notes in it and no folders under it. `liveMessages` is what a
  // messages.list on the label found - not the label's own count, which
  // also counts old versions waiting in Trash and would keep an emptied
  // folder undeletable for a month.
  function isDeletableFolder(label, root, allLabels, liveMessages) {
    if (!label || typeof label.name !== 'string' || !root) return false;
    if (!label.name.startsWith(`${root}/`) || label.name.length <= root.length + 1) return false;
    if (liveMessages !== 0) return false;
    return !(allLabels || []).some(l => l && typeof l.name === 'string' && l.name.startsWith(`${label.name}/`));
  }

  const api = {
    NOTE_HEADER, NOTE_SENDER, DEFAULT_LABEL, MAX_BODY, MAX_TITLE, FORBIDDEN_INSERT_LABELS, FOLDER_NAME_MAX,
    folderTree, folderOf, moveFolderDiff, validateFolderTitle, renamePlan, isDeletableFolder,
    SCRATCHPAD_ID, SCRATCHPAD_TITLE, newNoteId, noteIdFor, encodeHeaderText, decodeHeaderText, base64UrlEncode, base64UrlDecode,
    titleFor, buildNoteRaw, noteIdOfRaw, isNoteInsert,
    htmlToText, extractText, messageParts, noteFromMessage, dedupeNotes,
  };

  ns.notesLogic = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

// ════ src/lib/note-format.js ══════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Note formatting (pure)
//
// A formatted note is a list of blocks - paragraphs, three heading
// sizes, bulleted, numbered and check lists nested up to three deep, and
// tables - each holding runs of text that may be bold, italic, struck
// through or a link (a table, rows of cells of them). That is the whole
// model; nothing outside it survives a save.
//
// It is stored in the note's message twice. The HTML part is the real
// record: Gmail shows it (on the phone too), and this file reads it back
// with a small tokenizer of its own rather than the browser's HTML
// parser, which is a Trusted Types sink on Gmail's page and would accept
// far more than the model can hold. The plain-text part is a readable
// rendering - bullets, ☐ and ☑ - for Gmail's previews and for any mail
// client that shows text.
//
// Mail that arrived as a note (written in Gmail, say) goes through the
// same reader, so its bold, lists and links come across where they fit
// the model and everything else is reduced to text.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const util = (typeof module === 'object' && module.exports) ? require('./util.js') : ns.util;

  const TYPES = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'check', 'table']);
  const LISTS = new Set(['ul', 'ol', 'check']);
  const MAX_LEVEL = 3;
  // A table: at most this many columns and rows; a column is aligned
  // left (''), in the centre or to the right.
  const MAX_COLS = 26;
  const MAX_ROWS = 1000;
  const ALIGNS = new Set(['', 'center', 'right']);
  const BOX = '☐';     // ☐
  const TICKED = '☑';  // ☑
  const BULLET = '•';  // •

  // ── The model ────────────────────────────────────────────────────────

  function block(type = 'p', runs = [], { level = 0, checked = false } = {}) {
    return { type, level: LISTS.has(type) ? level : 0, checked: type === 'check' ? !!checked : false, runs };
  }

  // A table block: `rows` of cells, each cell { runs } - a line break
  // inside a cell is a "\n" in its text; `head`, whether the first row is
  // a heading row; `align`, each column's alignment.
  function table(rows = [[{ runs: [] }]], { head = false, align = [] } = {}) {
    return Object.assign(block('table'), { rows, head: !!head, align });
  }

  const emptyCell = () => ({ runs: [] });

  function emptyDoc() {
    return [block('p')];
  }

  const sameMarks = (a, b) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.s === !!b.s && (a.href || '') === (b.href || '');

  function cleanRun(r) {
    const out = { text: String(r.text || '') };
    if (r.b) out.b = true;
    if (r.i) out.i = true;
    if (r.s) out.s = true;
    const href = r.href ? safeHref(r.href) : '';
    if (href) out.href = href;
    return out;
  }

  // Drops empty runs and joins neighbours that look the same, so two
  // documents that read alike compare alike.
  function normaliseRuns(runs) {
    const out = [];
    for (const r of runs || []) {
      if (!r || !r.text) continue;
      const last = out[out.length - 1];
      if (last && sameMarks(last, r)) last.text += r.text;
      else out.push(cleanRun(r));
    }
    return out;
  }

  // Every row as wide as the widest (and within the limits), every cell
  // tidy, at least one cell.
  function normaliseTable(b) {
    const src = (Array.isArray(b.rows) ? b.rows : []).filter(Array.isArray).slice(0, MAX_ROWS);
    const widest = src.reduce((n, r) => Math.max(n, r.length), 0);
    const cols = Math.max(1, Math.min(MAX_COLS, widest));
    const rows = src.map(r => Array.from({ length: cols }, (_, k) => ({ runs: normaliseRuns(r[k] && r[k].runs) })));
    if (!rows.length) rows.push(Array.from({ length: cols }, emptyCell));
    const align = Array.from({ length: cols }, (_, k) => (b.align && ALIGNS.has(b.align[k]) ? b.align[k] : ''));
    return table(rows, { head: b.head, align });
  }

  // Unknown types become paragraphs; a list item may sit at most one level
  // deeper than the list item before it, which is what keeps the HTML a
  // properly nested list and the editor's indents meaningful. A table is
  // never last: a line follows it, somewhere to type after it.
  function normaliseDoc(doc) {
    const out = [];
    let prevLevel = -1;
    for (const b of Array.isArray(doc) ? doc : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'table') {
        out.push(normaliseTable(b));
        prevLevel = -1;
        continue;
      }
      const type = TYPES.has(b.type) ? b.type : 'p';
      let level = 0;
      if (LISTS.has(type)) {
        level = Math.max(0, Math.min(MAX_LEVEL, Number(b.level) || 0, prevLevel + 1));
        prevLevel = level;
      } else {
        prevLevel = -1;
      }
      out.push(block(type, normaliseRuns(b.runs), { level, checked: b.checked }));
    }
    if (out.length && out[out.length - 1].type === 'table') out.push(block('p'));
    return out.length ? out : emptyDoc();
  }

  const runsText = runs => runs.map(r => r.text).join('');
  // A table's text: a row a line, its cells between " | ".
  const tableText = b => b.rows.map(r => r.map(c => runsText(c.runs).replace(/\n/g, ' ')).join(' | ')).join('\n');
  const blockText = b => (b.type === 'table' ? tableText(b) : runsText(b.runs));

  function docText(doc) {
    return doc.map(blockText).join('\n');
  }

  // A table counts as something written, even with nothing in it yet.
  function isEmpty(doc) {
    return doc.every(b => b.type !== 'table' && !blockText(b).trim());
  }

  // ── Links ────────────────────────────────────────────────────────────

  // Web and mail links only. "example.com/x" gets https:// in front, a
  // bare address gets mailto:, and anything else - javascript:, data:,
  // file: - is not a link at all.
  function safeHref(url) {
    const s = String(url || '').trim();
    if (!s || /[\s<>"]/.test(s)) return '';
    if (/^mailto:/i.test(s)) return /^mailto:[^@\s]+@[^@\s]+$/i.test(s) ? s : '';
    if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(s)) return `mailto:${s}`;
    let candidate = s;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      if (!/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(s)) return '';
      candidate = `https://${s}`;
    }
    try {
      const u = new URL(candidate);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch {
      return '';
    }
  }

  // ── HTML out ─────────────────────────────────────────────────────────

  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Spaces HTML would collapse - doubled, at either end of a block, or
  // meeting across a tag - are written as &nbsp; so they come back as
  // typed.
  function runsHtml(runs) {
    let out = '';
    let prevSpace = false;
    for (let i = 0; i < runs.length;) {
      const href = runs[i].href || '';
      let j = i;
      let inner = '';
      while (j < runs.length && (runs[j].href || '') === href) {
        const raw = runs[j].text;
        let t = escHtml(raw).replace(/ {2}/g, ' &nbsp;').replace(/\n/g, '<br>');
        if (prevSpace && t[0] === ' ') t = `&nbsp;${t.slice(1)}`;
        prevSpace = / $/.test(raw);
        if (runs[j].s) t = `<s>${t}</s>`;
        if (runs[j].i) t = `<i>${t}</i>`;
        if (runs[j].b) t = `<b>${t}</b>`;
        inner += t;
        j++;
      }
      out += href ? `<a href="${escHtml(href)}">${inner}</a>` : inner;
      i = j;
    }
    // Edge spaces of the whole block, after the tags are in place.
    return out.replace(/^((?:<[^>]+>)*) /, '$1&nbsp;').replace(/ ((?:<\/[^>]+>)*)$/, '&nbsp;$1');
  }

  const STYLE = {
    doc: 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f1f1f',
    p: 'margin:0',
    h1: 'margin:14px 0 4px;font-size:22px;line-height:1.3;font-weight:bold',
    h2: 'margin:12px 0 2px;font-size:18px;line-height:1.3;font-weight:bold',
    h3: 'margin:10px 0 2px;font-size:15px;line-height:1.3;font-weight:bold',
    list: 'margin:0;padding-left:26px',
    check: 'margin:0;padding-left:4px;list-style:none',
    li: 'margin:1px 0',
    table: 'border-collapse:collapse;margin:6px 0',
    cell: 'border:1px solid #c4c7c5;padding:4px 8px;vertical-align:top;text-align:left',
    th: 'background:#f1f3f4;font-weight:bold',
  };

  // A table as Gmail and any mail client shows one, styled inline; the
  // heading row in <thead>, as <th>.
  function tableHtml(b) {
    const cell = (c, k, tag) => {
      const align = b.align[k] ? `;text-align:${b.align[k]}` : '';
      const style = `${STYLE.cell}${tag === 'th' ? `;${STYLE.th}` : ''}${align}`;
      return `<${tag} style="${style}">${runsHtml(c.runs) || '<br>'}</${tag}>`;
    };
    const row = (r, tag) => `<tr>${r.map((c, k) => cell(c, k, tag)).join('')}</tr>`;
    const body = b.rows.slice(b.head ? 1 : 0);
    return `<table data-gkb-table="1" style="${STYLE.table}">` +
      (b.head ? `<thead>${row(b.rows[0], 'th')}</thead>` : '') +
      (body.length ? `<tbody>${body.map(r => row(r, 'td')).join('')}</tbody>` : '') + '</table>';
  }

  function toHtml(docIn) {
    const doc = normaliseDoc(docIn);
    const stack = []; // open lists, one per level: { tag, check }
    let out = `<div data-gkb-note="1" style="${STYLE.doc}">`;
    const close = () => { out += `</li></${stack.pop().tag}>`; };

    for (const b of doc) {
      if (b.type === 'table') {
        while (stack.length) close();
        out += `${tableHtml(b)}\n`;
        continue;
      }
      const inner = runsHtml(b.runs);
      if (!LISTS.has(b.type)) {
        while (stack.length) close();
        out += `<${b.type} style="${STYLE[b.type]}">${inner || '<br>'}</${b.type}>\n`;
        continue;
      }
      const tag = b.type === 'ol' ? 'ol' : 'ul';
      const check = b.type === 'check';
      while (stack.length > b.level + 1) close();
      if (stack.length === b.level + 1) {
        const top = stack[stack.length - 1];
        if (top.tag !== tag || top.check !== check) close();
        else out += '</li>';
      }
      if (stack.length === b.level) {
        out += check ? `<ul data-check="1" style="${STYLE.check}">` : `<${tag} style="${STYLE.list}">`;
        stack.push({ tag, check });
      }
      const glyph = check ? `<span data-glyph="1">${b.checked ? TICKED : BOX}&nbsp;</span>` : '';
      out += `<li style="${STYLE.li}"${check ? ` data-checked="${b.checked ? 1 : 0}"` : ''}>${glyph}${inner || (check ? '' : '<br>')}`;
    }
    while (stack.length) close();
    return `${out}</div>`;
  }

  // ── Plain text out ───────────────────────────────────────────────────

  function runsPlain(runs) {
    let out = '';
    for (let i = 0; i < runs.length;) {
      const href = runs[i].href || '';
      let j = i;
      let text = '';
      while (j < runs.length && (runs[j].href || '') === href) text += runs[j++].text;
      const bare = href.replace(/^mailto:/, '');
      const same = s => s.trim().replace(/^(https?:\/\/|mailto:)/, '').replace(/\/$/, '');
      out += href && same(text) !== same(href) ? `${text} (${bare})` : text;
      i = j;
    }
    return out;
  }

  // A table as plain text: a row a line, " | " between its cells - what
  // Gmail's previews and a plain-text mail client show. (The HTML part is
  // the record; this only has to read well.)
  function tablePlain(b) {
    const cell = c => runsPlain(c.runs).replace(/\n/g, ' ').trim();
    return b.rows.map(r => r.map(cell).join(' | ')).join('\n');
  }

  function toPlain(docIn) {
    const doc = normaliseDoc(docIn);
    const counters = [0, 0, 0, 0];
    return doc.map(b => {
      if (b.type === 'table') {
        counters.fill(0);
        return tablePlain(b);
      }
      const text = runsPlain(b.runs);
      if (!LISTS.has(b.type)) {
        counters.fill(0);
        return text;
      }
      const pad = '  '.repeat(b.level);
      for (let l = b.level + 1; l < counters.length; l++) counters[l] = 0;
      if (b.type === 'ol') return `${pad}${++counters[b.level]}. ${text}`;
      counters[b.level] = 0;
      if (b.type === 'check') return `${pad}${b.checked ? TICKED : BOX} ${text}`;
      return `${pad}${BULLET} ${text}`;
    }).join('\n');
  }

  // ── Plain text in ────────────────────────────────────────────────────

  // A plain note (from before formatting existed, or plain mail) becomes
  // one block per line. Lines that already look like lists - "- ", "• ",
  // "1. ", "☐ " - become lists, indented two spaces a level.
  function fromPlain(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      // Two or more | a | b | lines, or one with a |---| line under it: a table.
      const t = pipeTable(lines, i, s => [{ text: s }]);
      if (t && (t.end - i > 1 || t.block.head)) {
        out.push(t.block);
        i = t.end - 1;
        continue;
      }
      const line = lines[i];
      const m = /^( *)(?:([-*•])|(\d{1,3})[.)]|([☐☑])) (.*)$/.exec(line);
      if (!m) { out.push(block('p', [{ text: line }])); continue; }
      const level = Math.floor(m[1].length / 2);
      if (m[4]) out.push(block('check', [{ text: m[5] }], { level, checked: m[4] === TICKED }));
      else out.push(block(m[3] ? 'ol' : 'ul', [{ text: m[5] }], { level }));
    }
    return normaliseDoc(out);
  }

  // ── Pipe tables (Markdown's, and the plain text above) ──────────────

  const PIPE_ROW = /^\s*\|.*\|\s*$/;
  const PIPE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const pipeCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

  // The table of | rows starting at lines[i], or null: { block, end }.
  // A |---| line under the first row makes it a heading row and gives the
  // columns' alignment; "<br>" in a cell is a line break.
  function pipeTable(lines, i, inline) {
    if (!PIPE_ROW.test(lines[i] || '') || PIPE_RULE.test(lines[i])) return null;
    const rows = [];
    let head = false;
    let align = [];
    let j = i;
    for (; j < lines.length && PIPE_ROW.test(lines[j]); j++) {
      if (PIPE_RULE.test(lines[j])) {
        if (rows.length === 1 && !head) {
          head = true;
          align = pipeCells(lines[j]).map(c => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : ''));
        }
        continue;
      }
      rows.push(pipeCells(lines[j]).map(c => ({ runs: inline(c.replace(/<br\s*\/?>/gi, '\n')) })));
    }
    return { block: table(rows, { head, align }), end: j };
  }

  // ── HTML in ──────────────────────────────────────────────────────────

  const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|[^<]+|</g;
  const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const SKIP = new Set(['script', 'style', 'head', 'title', 'template', 'svg', 'math', 'noscript', 'iframe', 'object', 'xml']);
  const PARA = new Set(['p', 'div', 'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'main', 'aside',
    'nav', 'table', 'tbody', 'thead', 'tfoot', 'center', 'dl', 'dt', 'dd', 'figure', 'figcaption',
    'form', 'fieldset', 'address', 'hr', 'body', 'html', 'caption']);
  // Tags that mark text, and the marks they stand for. span and font
  // carry theirs in a style attribute, if at all.
  const INLINE = {
    b: ['b'], strong: ['b'], i: ['i'], em: ['i'], cite: ['i'], s: ['s'], strike: ['s'], del: ['s'], span: [], font: [],
  };
  const HEADINGS = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };

  function attrsOf(s) {
    const out = {};
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(s || ''))) {
      out[m[1].toLowerCase()] = util.decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '');
    }
    return out;
  }

  // Bold, italic and strike-through written as inline styles, as Outlook
  // and pasted web text often do, count the same as the tags.
  function styleMarks(style) {
    const s = String(style || '').toLowerCase();
    const marks = [];
    if (/font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(s)) marks.push('b');
    if (/font-style\s*:\s*italic/.test(s)) marks.push('i');
    if (/text-decoration(-line)?\s*:[^;]*line-through/.test(s)) marks.push('s');
    return marks;
  }

  // Whether a browser would show space below a <p>: it does unless its
  // style says otherwise. Word and Outlook paragraphs (MsoNormal) are
  // lines, and so are the editor's own and Google Docs'.
  function paraGap(a) {
    if (/\bMso/.test(a.class || '')) return false;
    const style = String(a.style || '').toLowerCase();
    const zero = v => /^-?0(\.0+)?([a-z]+|%)?$/.test(v || '');
    const bottom = /(?:^|;)\s*margin-bottom\s*:\s*([^;!]+)/.exec(style);
    if (bottom) return !zero(bottom[1].trim());
    const all = /(?:^|;)\s*margin\s*:\s*([^;!]+)/.exec(style);
    if (all) {
      const v = all[1].trim().split(/\s+/);
      return !zero(v.length >= 3 ? v[2] : v[0]);
    }
    return true;
  }

  function parseHtml(html) {
    const blocks = [];
    const lists = [];         // open lists: { type, liOpen }
    const marks = { b: 0, i: 0, s: 0 };
    const hrefs = [];
    const inline = [];        // open inline tags: { name, marks } or { name, glyph: true }
    let skip = 0;
    let glyph = 0;
    let cur = null;
    // The open table, if any: { b, row, cell, thead, depth }. Its text goes
    // into its cells; a table inside a cell is read into that cell as text,
    // a row a line (depth counts those).
    let tbl = null;
    let pre = 0;              // inside <pre>: line breaks and spaces are text
    let para = null;          // the open <p>: { gap }
    let gap = false;          // a <p> just closed with space below it
    let ours = false;         // inside a note's own HTML, where paragraphs are lines

    const level = () => Math.max(0, lists.length - 1);
    const open = (type, extra) => {
      // The space a browser shows after a paragraph is an empty line in a
      // note - which has no space between paragraphs - except before a
      // heading, which has its own.
      if (gap) {
        gap = false;
        const last = blocks[blocks.length - 1];
        if (last && !HEADINGS[type] && last.runs.some(r => /\S/.test(r.text))) blocks.push(block('p'));
      }
      cur = block(type, [], extra);
      blocks.push(cur);
      return cur;
    };
    const end = () => { cur = null; };
    // Where text lands when no block is open: inside a list item, a
    // continuation of that item; otherwise a new paragraph.
    const context = () => {
      const top = lists[lists.length - 1];
      if (top && top.liOpen) return open(top.type, { level: level(), checked: false });
      return open('p');
    };
    const apply = (list, delta) => list.forEach(m => { marks[m] += delta; });
    const run = text => ({ text, b: marks.b > 0, i: marks.i > 0, s: marks.s > 0, href: hrefs.length ? hrefs[hrefs.length - 1] : '' });
    // Inside a table: the open cell's runs, or null between cells.
    const cellRuns = () => (tbl && tbl.cell ? tbl.cell.runs : null);
    // A line break in the open cell, unless it is empty or just had one.
    const cellBreak = () => {
      const runs = cellRuns();
      if (!runs || !runs.length) return;
      const last = runs[runs.length - 1];
      if (!/\n$/.test(last.text)) runs.push(run('\n'));
    };
    const rowsSeen = [];
    const closeCell = () => {
      if (!tbl || !tbl.cell) return;
      apply(tbl.cell.marks, -1);
      tbl.cell = null;
    };
    // The table done: empty rows gone, the heading row and the columns'
    // alignment worked out from the cells.
    const finishTable = () => {
      closeCell();
      const t = tbl;
      tbl = null;
      const rows = rowsSeen.filter(r => r.cells.length && t.b.rows.indexOf(r.cells) >= 0);
      rowsSeen.length = 0;
      t.b.rows = rows.map(r => r.cells);
      if (!rows.length) { blocks.splice(blocks.indexOf(t.b), 1); return; }
      const first = rows[0];
      t.b.head = first.thead || (first.th && first.cells.some(c => c.th) && rows.length > 1);
      const cols = Math.max(...rows.map(r => r.cells.length));
      t.b.align = Array.from({ length: cols }, (_, k) => {
        const seen = rows.slice(t.b.head ? 1 : 0).map(r => r.cells[k] && r.cells[k].align).filter(x => x !== undefined);
        return seen.length && seen.every(x => x === seen[0]) ? seen[0] : '';
      });
      // Bold that a heading cell is anyway, and a heading cell in a later
      // row (a row's label), written as bold.
      rows.forEach((r, i) => r.cells.forEach(c => {
        if (c.th && !(i === 0 && t.b.head)) c.runs.forEach(x => { x.b = true; });
      }));
    };

    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(String(html || '')))) {
      const [whole, closing, rawName, rawAttrs, selfClosing] = m;
      if (rawName === undefined) {
        if (whole[0] === '<' && whole.length > 1) continue; // comment, doctype, CDATA
        if (skip) continue;
        if (glyph) {
          // Word's list marker ("·", "1.", "a)"): not text, but it says
          // whether the list is bulleted or numbered.
          if (cur && cur.wordList) cur.marker += util.decodeEntities(whole);
          continue;
        }
        if (pre) {
          // Each line of preformatted text is a line of the note, its
          // spaces kept (as &nbsp;, which the tidying below leaves alone).
          let raw = util.decodeEntities(whole).replace(/\r\n?/g, '\n');
          if (pre.fresh) raw = raw.replace(/^\n/, '');
          pre.fresh = false;
          if (tbl) {
            if (cellRuns()) cellRuns().push(run(raw.replace(/\t/g, '    ')));
            continue;
          }
          raw.split('\n').forEach((line, k) => {
            if (k) {
              end();
              open('p').preLine = true;
            }
            if (!line) return;
            if (!cur) context();
            cur.runs.push({
              text: line.replace(/\t/g, '    ').replace(/ /g, '\u00a0'),
              b: marks.b > 0, i: marks.i > 0, s: marks.s > 0,
              href: hrefs.length ? hrefs[hrefs.length - 1] : '',
            });
          });
          continue;
        }
        const text = util.decodeEntities(whole === '<' ? '<' : whole).replace(/[ \t\r\n\f]+/g, ' ');
        if (tbl) {
          // Between cells, only stray whitespace: nothing.
          const runs = cellRuns();
          if (runs && (runs.length || /[^ \t\r\n\f]/.test(text))) runs.push(run(text));
          continue;
        }
        if (!cur) {
          // Only HTML's own whitespace is nothing; an &nbsp; is a space someone typed.
          if (!/[^ \t\r\n\f]/.test(text)) continue;
          context();
        }
        cur.runs.push({
          text,
          b: marks.b > 0, i: marks.i > 0, s: marks.s > 0,
          href: hrefs.length ? hrefs[hrefs.length - 1] : '',
        });
        continue;
      }

      const name = rawName.toLowerCase();
      const isClose = closing === '/';
      if (SKIP.has(name)) {
        if (!selfClosing) skip = Math.max(0, skip + (isClose ? -1 : 1));
        continue;
      }
      if (skip) continue;
      const a = isClose ? {} : attrsOf(rawAttrs);

      if (name === 'br') {
        if (tbl) {
          const runs = cellRuns();
          if (runs) runs.push(run('\n'));
          continue;
        }
        if (cur) end();
        else { context(); end(); }
        continue;
      }

      // ── Tables ──
      if (name === 'table') {
        if (isClose) {
          if (tbl && tbl.depth) { tbl.depth--; cellBreak(); continue; }
          if (tbl) finishTable();
          continue;
        }
        if (tbl) { tbl.depth++; cellBreak(); continue; }
        end();
        tbl = { b: table([], {}), row: null, cell: null, thead: false, depth: 0, headRow: true };
        blocks.push(tbl.b);
        continue;
      }
      if (tbl && name === 'caption') {
        if (!selfClosing) skip = Math.max(0, skip + (isClose ? -1 : 1));
        continue;
      }
      if (tbl && (name === 'thead' || name === 'tbody' || name === 'tfoot' || name === 'colgroup' || name === 'col')) {
        if (name === 'thead' && !tbl.depth) tbl.thead = !isClose;
        continue;
      }
      if (tbl && name === 'tr') {
        if (tbl.depth) { cellBreak(); continue; }
        closeCell();
        tbl.row = null;
        if (!isClose) {
          tbl.row = { cells: [], th: true, thead: tbl.thead };
          tbl.b.rows.push(tbl.row.cells);
          rowsSeen.push(tbl.row);
        }
        continue;
      }
      if (tbl && (name === 'td' || name === 'th')) {
        if (tbl.depth) {
          if (!isClose && cellRuns() && cellRuns().length && !/[\n ]$/.test(cellRuns()[cellRuns().length - 1].text)) cellRuns().push(run(' '));
          continue;
        }
        closeCell();
        if (isClose || selfClosing) continue;
        if (!tbl.row) {
          tbl.row = { cells: [], th: true, thead: tbl.thead };
          tbl.b.rows.push(tbl.row.cells);
          rowsSeen.push(tbl.row);
        }
        if (name === 'td') tbl.row.th = false;
        const st = String(a.style || '').toLowerCase();
        const al = (/text-align\s*:\s*(center|right)/.exec(st) || [])[1] || (/^(center|right)$/i.test(a.align || '') ? a.align.toLowerCase() : '');
        // Bold, italic or struck through cell styles (Google Sheets) count
        // as marks - but a heading cell is bold anyway.
        const got = styleMarks(st).filter(x => !(name === 'th' && x === 'b'));
        apply(got, 1);
        tbl.cell = { runs: [], align: al, marks: got, th: name === 'th' };
        tbl.row.cells.push(tbl.cell);
        // A cell spanning columns keeps the columns after it in place.
        const span = Math.min(MAX_COLS, Math.max(1, parseInt(a.colspan, 10) || 1));
        for (let k = 1; k < span; k++) tbl.row.cells.push(emptyCell());
        continue;
      }
      if (tbl && !tbl.cell && !isClose && (HEADINGS[name] || PARA.has(name) || name === 'li' || name === 'ul' || name === 'ol')) continue;
      if (tbl && (HEADINGS[name] || name === 'li' || name === 'ul' || name === 'ol' || name === 'pre' || PARA.has(name))) {
        // Lines inside a cell: paragraphs, headings and list items each
        // start a new one; a list item keeps a bullet.
        cellBreak();
        if (name === 'li' && !isClose && cellRuns()) cellRuns().push(run('• '));
        continue;
      }

      if (HEADINGS[name]) {
        end();
        if (!isClose) open(HEADINGS[name]);
        continue;
      }
      if (name === 'ul' || name === 'ol') {
        end();
        if (isClose) lists.pop();
        else lists.push({ type: a['data-check'] ? 'check' : name, liOpen: false });
        continue;
      }
      if (name === 'li') {
        end();
        if (!lists.length) lists.push({ type: 'ul', liOpen: false, implied: true });
        const top = lists[lists.length - 1];
        top.liOpen = !isClose;
        if (!isClose) {
          open(top.type, { level: level(), checked: a['data-checked'] === '1' });
          // One of ours: its box is in the attribute, and a ☐ at the start
          // of its text is text.
          if (a['data-checked'] !== undefined) cur.ours = true;
          // A checklist item marked up for screen readers (Google Docs).
          else if (a['aria-checked'] === 'true' || a['aria-checked'] === 'false') {
            cur.type = 'check';
            cur.checked = a['aria-checked'] === 'true';
            cur.ours = true;
          }
        }
        else if (top.implied) lists.pop();
        continue;
      }
      // Stray row or cell tags outside a table: a line each.
      if (name === 'tr' || name === 'td' || name === 'th') { end(); continue; }
      if (name === 'pre') {
        end();
        if (isClose) {
          // The line break before </pre> ends the last line; it is not one more.
          const last = blocks[blocks.length - 1];
          if (last && last.preLine && !last.runs.length) blocks.pop();
          pre = 0;
        } else if (!selfClosing) {
          pre = { fresh: true };
        }
        continue;
      }
      // A ticked or empty box at the start of a line - a task list on a
      // web page (GitHub) - makes it a checklist item.
      if (name === 'input' && String(a.type || '').toLowerCase() === 'checkbox') {
        if (tbl) {
          if (cellRuns()) cellRuns().push(run('checked' in a ? `${TICKED} ` : `${BOX} `));
          continue;
        }
        if (!cur) context();
        if (!cur.runs.some(r => /\S/.test(r.text))) {
          cur.type = 'check';
          cur.checked = 'checked' in a;
          cur.ours = true;
        }
        continue;
      }
      if (name === 'div' && a['data-gkb-note'] !== undefined) ours = true;
      // A block copied out of a note's editor keeps its kind.
      if (name === 'div' && !isClose && TYPES.has(a['data-type']) && a['data-type'] !== 'table') {
        end();
        open(a['data-type'], { level: Number(a['data-level']) || 0, checked: a['data-checked'] === '1' });
        cur.ours = true;
        continue;
      }
      // Word writes a list as paragraphs styled "mso-list: l0 level1".
      if (name === 'p' && !isClose) {
        const wl = /mso-list\s*:\s*l\d+\s+level(\d)/i.exec(a.style || '');
        if (wl) {
          end();
          open('ul', { level: Number(wl[1]) - 1 });
          cur.wordList = true;
          cur.marker = '';
          continue;
        }
      }
      if (name === 'p') {
        if (para && para.gap) gap = true;
        para = null;
        if (!isClose) {
          const top = lists[lists.length - 1];
          para = { gap: !ours && !tbl && !(top && top.liOpen) && paraGap(a) };
        }
      }
      if (PARA.has(name)) {
        // Straight inside a list item that has no text yet (Google Docs
        // wraps every item in a <p>), the line goes on.
        if (cur && !cur.runs.length && !isClose) continue;
        end();
        continue;
      }
      if (name === 'a') {
        if (isClose) hrefs.pop();
        else if (!selfClosing) hrefs.push(safeHref(a.href));
        continue;
      }
      if (INLINE[name]) {
        if (selfClosing) continue;
        if (isClose) {
          // The innermost open tag of that name - mail is not always tidily nested.
          for (let k = inline.length - 1; k >= 0; k--) {
            if (inline[k].name !== name) continue;
            const [got] = inline.splice(k, 1);
            if (got.glyph) glyph = Math.max(0, glyph - 1);
            else apply(got.marks, -1);
            break;
          }
          continue;
        }
        const style = String(a.style || '').toLowerCase();
        if (a['data-glyph'] || /mso-list\s*:\s*ignore/.test(style)) {
          inline.push({ name, glyph: true });
          glyph++;
          continue;
        }
        let got = [...INLINE[name], ...styleMarks(style)];
        // Google Docs wraps a whole paste in <b style="font-weight:normal">.
        if (/font-weight\s*:\s*(normal|lighter|[1-5]00)\b/.test(style)) got = got.filter(x => x !== 'b');
        if (/font-style\s*:\s*normal/.test(style)) got = got.filter(x => x !== 'i');
        got = [...new Set(got)];
        inline.push({ name, marks: got });
        apply(got, 1);
        continue;
      }
      // Anything else (img, u, sup, code, …): its text is kept, the tag is not.
    }
    if (tbl) finishTable();
    for (const k of Object.keys(marks)) marks[k] = Math.max(0, marks[k]);

    // Tidy each block: collapse the whitespace HTML would collapse, then
    // turn the &nbsp;s that held deliberate spaces back into spaces. In a
    // cell, a line break counts as an end, and none is left at either end.
    const tidyRuns = runs => {
      if (!runs.length) return;
      runs[0].text = runs[0].text.replace(/^[ \n]+/, '');
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/[ \n]+$/, '');
      for (let i = 1; i < runs.length; i++) {
        if (/[ \n]$/.test(runs[i - 1].text)) runs[i].text = runs[i].text.replace(/^ +/, '');
      }
      for (const r of runs) r.text = r.text.replace(/ +\n/g, '\n').replace(/ /g, ' ');
    };
    for (const b of blocks) {
      if (b.type === 'table') {
        b.rows.forEach(r => r.forEach(c => tidyRuns(c.runs)));
        continue;
      }
      const runs = b.runs;
      tidyRuns(runs);
      if (b.wordList && /^\s*(\d+|[a-z]|[ivxlc]+)[.)]\s*$/i.test(b.marker || '')) b.type = 'ol';
      // A check box drawn as text (mail from elsewhere, or a list whose
      // markers were lost) still counts as a check box.
      if (LISTS.has(b.type) && runs.length && !b.ours) {
        const g = /^([☐☑]) ?/.exec(runs[0].text);
        if (g) {
          runs[0].text = runs[0].text.slice(g[0].length);
          if (b.type === 'ul') b.type = 'check';
          if (b.type === 'check') b.checked = g[1] === TICKED;
        }
      }
    }
    return normaliseDoc(blocks);
  }

  // ── Markdown in ──────────────────────────────────────────────────────
  //
  // Text copied from a chat assistant, a README or a Markdown editor
  // arrives as plain text full of **stars** and "- " lines. The common
  // part of Markdown becomes formatting; the rest stays as typed.

  function mdInline(src, marks = {}) {
    const out = [];
    const s = String(src || '');
    let buf = '';
    const flush = () => {
      if (buf) out.push({ text: buf, ...marks });
      buf = '';
    };
    const nested = (inner, extra) => {
      flush();
      out.push(...mdInline(inner, { ...marks, ...extra }));
    };
    for (let i = 0; i < s.length;) {
      const rest = s.slice(i);
      const prev = i ? s[i - 1] : '';
      let m;
      if ((m = /^\\([\\`*_{}[\]()#+\-.!~|>])/.exec(rest))) { buf += m[1]; i += m[0].length; continue; }
      if ((m = /^`([^`\n]+)`/.exec(rest))) { buf += m[1]; i += m[0].length; continue; }
      if ((m = /^\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
        const href = safeHref(m[2]);
        nested(m[1], href ? { href } : {});
        i += m[0].length;
        continue;
      }
      if ((m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(rest))) {
        flush();
        const href = safeHref(m[1]);
        out.push({ text: m[1].replace(/^mailto:/, ''), ...marks, ...(href ? { href } : {}) });
        i += m[0].length;
        continue;
      }
      if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)) && !(m[1] === '__' && /[\p{L}\p{N}]/u.test(prev))) {
        nested(m[2], { b: true });
        i += m[0].length;
        continue;
      }
      if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { nested(m[1], { s: true }); i += m[0].length; continue; }
      if ((m = /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/.exec(rest))) { nested(m[1], { i: true }); i += m[0].length; continue; }
      if (!/[\p{L}\p{N}_]/u.test(prev) && (m = /^_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/u.exec(rest))) {
        nested(m[1], { i: true });
        i += m[0].length;
        continue;
      }
      buf += s[i];
      i++;
    }
    flush();
    return out;
  }

  // One line of Markdown: what kind of block it is, its indent and text.
  function mdLine(line) {
    const [, pad, s] = /^( *)(.*)$/.exec(line);
    const indent = pad.length;
    let x;
    if ((x = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(s))) return { type: ['h1', 'h2', 'h3'][Math.min(2, x[1].length - 1)], text: x[2] };
    if ((x = /^[-*+•]\s+\[([ xX])\]\s+(.*)$/.exec(s))) return { type: 'check', checked: x[1] !== ' ', text: x[2], indent };
    if ((x = /^([☐☑])\s+(.*)$/.exec(s))) return { type: 'check', checked: x[1] === TICKED, text: x[2], indent };
    if ((x = /^[-*+•]\s+(.*)$/.exec(s))) return { type: 'ul', text: x[1], indent };
    if ((x = /^\d{1,3}[.)]\s+(.*)$/.exec(s))) return { type: 'ol', text: x[1], indent };
    if ((x = /^>\s?(.*)$/.exec(s))) return { type: 'p', text: x[1].replace(/^(>\s?)+/, '') };
    return { type: 'p', text: s };
  }

  const MD_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

  function fromMarkdown(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const out = [];
    const indents = [];   // the indent of each open list level
    let fence = false;
    const last = () => out[out.length - 1];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) { out.push(block('p', [{ text: line }])); continue; }
      // | a | b | lines, with or without the |---| line under a heading row.
      const t = pipeTable(lines, i, mdInline);
      if (t) {
        indents.length = 0;
        out.push(t.block);
        i = t.end - 1;
        continue;
      }
      if (MD_RULE.test(line)) continue;
      // One empty line is a gap; more are not, and nor is one beside a
      // heading, which has space of its own.
      if (!line.trim()) {
        if (!out.length || !(fmtBlank(last()) || HEADINGS[last().type])) out.push(block('p'));
        continue;
      }
      const l = mdLine(line.replace(/\s+$/, ''));
      if (HEADINGS[l.type] && out.length && fmtBlank(last())) out.pop();
      if (LISTS.has(l.type)) {
        // A blank line between two items of a list is not a gap in it.
        if (out.length > 1 && fmtBlank(last()) && LISTS.has(out[out.length - 2].type)) out.pop();
        while (indents.length && l.indent < indents[indents.length - 1]) indents.pop();
        if (!indents.length || l.indent > indents[indents.length - 1]) indents.push(l.indent);
        out.push(block(l.type, mdInline(l.text), { level: indents.length - 1, checked: l.checked }));
        continue;
      }
      indents.length = 0;
      out.push(block(l.type, mdInline(l.text.trim())));
    }
    while (out.length > 1 && fmtBlank(last())) out.pop();
    while (out.length > 1 && fmtBlank(out[0])) out.shift();
    return normaliseDoc(out);
  }

  const fmtBlank = b => b.type === 'p' && !b.runs.some(r => r.text.trim());
  const isTable = b => b.type === 'table';

  // Whether plain text is worth reading as Markdown: a heading, list,
  // quote, table or code line, or bold, struck, linked or code text.
  function looksLikeMarkdown(text) {
    const s = String(text || '');
    return /^ {0,3}(#{1,6}\s+\S|[-*+•]\s+\S|[☐☑]\s+\S|\d{1,3}[.)]\s+\S|>\s|```)/m.test(s) ||
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(s) ||
      /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`/.test(s);
  }

  // ── Pasting ──────────────────────────────────────────────────────────

  // Whether a document has anything plain text would not: a heading, a
  // list, a mark or a link.
  function hasFormatting(doc) {
    return doc.some(b => b.type !== 'p' || b.runs.some(r => r.b || r.i || r.s || r.href));
  }

  // Whether a document is one table and nothing else (empty lines aside):
  // what a paste of cells from a spreadsheet is.
  function onlyTable(doc) {
    const kept = doc.filter(b => !fmtBlank(b));
    return kept.length === 1 && isTable(kept[0]) ? kept[0] : null;
  }

  // What a paste becomes: the clipboard's HTML, read like mail; or, when
  // that brings no formatting and the text is Markdown (from a chat
  // assistant, say), the Markdown read as formatting. Empty lines at
  // either end go. null means there is nothing to format: the text is
  // pasted as it is.
  function pasteDoc({ html, text } = {}) {
    let doc = html && /\S/.test(html) ? parseHtml(html) : null;
    if (doc && isEmpty(doc)) doc = null;
    if ((!doc || !hasFormatting(doc)) && looksLikeMarkdown(text)) doc = fromMarkdown(text);
    if (!doc) return null;
    // One cell copied on its own is its text, not a table of one.
    const one = onlyTable(doc);
    if (one && one.rows.length === 1 && one.rows[0].length === 1) {
      const runs = one.rows[0][0].runs;
      const lines = [[]];
      for (const r of runs) {
        r.text.split('\n').forEach((piece, k) => {
          if (k) lines.push([]);
          if (piece) lines[lines.length - 1].push({ ...r, text: piece });
        });
      }
      doc = normaliseDoc(lines.map(l => block('p', l)));
    }
    let i = 0;
    let j = doc.length;
    while (i < j && fmtBlank(doc[i])) i++;
    while (j > i && fmtBlank(doc[j - 1])) j--;
    return i < j ? doc.slice(i, j) : null;
  }

  // The note's content from its message parts: HTML when there is any,
  // the plain text otherwise.
  function docFromParts({ plain, html } = {}) {
    if (html && String(html).trim()) return parseHtml(html);
    return fromPlain(plain || '');
  }

  // ── Merging ──────────────────────────────────────────────────────────
  //
  // A note edited here while another computer or phone saved a newer
  // version of it: both sets of changes, block by block. `base` is the
  // version the edits here started from, `mine` the text here now, and
  // `theirs` the newer version. A stretch only one side changed takes
  // that side's blocks; a stretch both changed keeps theirs and then
  // whatever of mine they do not already have, so nothing typed on
  // either is lost - at worst a paragraph appears twice.

  const blockKey = b => JSON.stringify(b);
  const sameDoc = (a, b) => JSON.stringify(normaliseDoc(a)) === JSON.stringify(normaliseDoc(b));

  // The longest common subsequence of two lists of keys, as pairs of
  // indices [i in a, j in b], in order. The ends both lists share are
  // matched first, so the table only spans the stretch that differs.
  function commonPairs(a, b) {
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
    let ea = a.length;
    let eb = b.length;
    while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const pairs = [];
    for (let i = 0; i < lo; i++) pairs.push([i, i]);
    const n = ea - lo;
    const m = eb - lo;
    // Too big a table to be worth it: no matches in the middle, which
    // only makes the merge keep more of both sides.
    if (n && m && n * m <= 4e6) {
      const len = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          len[i][j] = a[lo + i] === b[lo + j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[lo + i] === b[lo + j]) { pairs.push([lo + i, lo + j]); i++; j++; } else if (len[i + 1][j] >= len[i][j + 1]) i++; else j++;
      }
    }
    for (let k = 0; k < a.length - ea; k++) pairs.push([ea + k, eb + k]);
    return pairs;
  }

  // { doc, map, clean }: the merged blocks; for each of mine's blocks,
  // where it is in them (so a cursor can stay put); and whether no
  // stretch was changed on both sides.
  function mergeDocs(baseIn, mineIn, theirsIn) {
    const base = normaliseDoc(baseIn);
    const mine = normaliseDoc(mineIn);
    const theirs = normaliseDoc(theirsIn);
    const kb = base.map(blockKey);
    const km = mine.map(blockKey);
    const kt = theirs.map(blockKey);
    const toMine = new Map(commonPairs(kb, km));
    const toTheirs = new Map(commonPairs(kb, kt));
    // The blocks neither side touched, in order on all three.
    const anchors = [];
    let lastM = -1;
    let lastT = -1;
    for (let i = 0; i < kb.length; i++) {
      if (!toMine.has(i) || !toTheirs.has(i)) continue;
      const m = toMine.get(i);
      const t = toTheirs.get(i);
      if (m > lastM && t > lastT) { anchors.push(i); lastM = m; lastT = t; }
    }
    const out = [];
    const map = new Array(mine.length).fill(-1);
    let clean = true;
    const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
    let b0 = 0;
    let m0 = 0;
    let t0 = 0;
    for (const a of anchors.concat([kb.length])) {
      const m1 = a < kb.length ? toMine.get(a) : km.length;
      const t1 = a < kb.length ? toTheirs.get(a) : kt.length;
      const B = kb.slice(b0, a);
      const M = km.slice(m0, m1);
      const T = kt.slice(t0, t1);
      const start = out.length;
      if (same(M, B) && !same(T, B)) {
        // Only they changed this stretch.
        for (let k = t0; k < t1; k++) out.push(theirs[k]);
        for (let k = m0; k < m1; k++) map[k] = Math.min(start + (k - m0), Math.max(start, out.length - 1));
      } else if (same(T, B) || same(M, T)) {
        // Only this side changed it, or both the same way.
        for (let k = m0; k < m1; k++) { map[k] = out.length; out.push(mine[k]); }
      } else if (B.length && M.length === B.length && T.length === B.length) {
        // As many blocks on each side: block by block, each side's change
        // where only it changed one, both where both changed the same one.
        for (let k = 0; k < B.length; k++) {
          const [b, mm, tt] = [B[k], M[k], T[k]];
          if (mm === b) { map[m0 + k] = out.length; out.push(theirs[t0 + k]); } else if (tt === b || tt === mm) { map[m0 + k] = out.length; out.push(mine[m0 + k]); } else {
            clean = false;
            out.push(theirs[t0 + k]);
            map[m0 + k] = out.length;
            out.push(mine[m0 + k]);
          }
        }
      } else if (B.length && (same(T.slice(0, B.length), B) || same(T.slice(T.length - B.length), B))) {
        // They only added before or after it, and this side changed it.
        const after = same(T.slice(0, B.length), B);
        if (!after) for (let k = t0; k < t1 - B.length; k++) out.push(theirs[k]);
        for (let k = m0; k < m1; k++) { map[k] = out.length; out.push(mine[k]); }
        if (after) for (let k = t0 + B.length; k < t1; k++) out.push(theirs[k]);
      } else if (B.length && (same(M.slice(0, B.length), B) || same(M.slice(M.length - B.length), B))) {
        // This side only added before or after it, and they changed it.
        const after = same(M.slice(0, B.length), B);
        if (!after) for (let k = m0; k < m1 - B.length; k++) { map[k] = out.length; out.push(mine[k]); }
        const theirsAt = out.length;
        for (let k = t0; k < t1; k++) out.push(theirs[k]);
        const kept = after ? [m0, m0 + B.length] : [m1 - B.length, m1];
        for (let k = kept[0]; k < kept[1]; k++) map[k] = Math.min(theirsAt + (k - kept[0]), Math.max(theirsAt, out.length - 1));
        if (after) for (let k = m0 + B.length; k < m1; k++) { map[k] = out.length; out.push(mine[k]); }
      } else {
        // Both changed it: theirs, then what of mine is new to it.
        clean = false;
        for (let k = t0; k < t1; k++) out.push(theirs[k]);
        for (let k = m0; k < m1; k++) {
          const there = T.indexOf(km[k]);
          if (there >= 0) map[k] = start + there;
          else { map[k] = out.length; out.push(mine[k]); }
        }
      }
      if (a < kb.length) { map[m1] = out.length; out.push(mine[m1]); }
      b0 = a + 1;
      m0 = m1 + 1;
      t0 = t1 + 1;
    }
    if (!out.length) out.push(block('p'));
    for (let k = 0; k < map.length; k++) map[k] = Math.max(0, Math.min(out.length - 1, map[k]));
    return { doc: out, map, clean };
  }

  const api = {
    TYPES, LISTS, MAX_LEVEL,
    block, emptyDoc, normaliseRuns, normaliseDoc, docText, isEmpty, safeHref,
    toHtml, toPlain, fromPlain, parseHtml, docFromParts, fromMarkdown, looksLikeMarkdown, hasFormatting, pasteDoc,
    mergeDocs, sameDoc, table, onlyTable, tableText, MAX_COLS, MAX_ROWS,
  };

  ns.noteFormat = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

// ════ src/lib/board-logic.js ══════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Board logic (pure)
//
// The board has no data of its own. A card is a Gmail thread, a column is
// a Gmail label, and the only things stored outside Gmail are the order of
// cards within a column and the user's own edits to a card. Everything
// here is the arithmetic between those: which labels a move adds and
// removes, where a thread shows up when it carries two column labels, how
// a saved order meets a fresh thread list, and what an edit looks like.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const util = (typeof module === 'object' && module.exports) ? require('./util.js') : ns.util;

  // ── Columns ──────────────────────────────────────────────────────────

  // The leading underscore sorts the board's labels above everything else
  // in Gmail's long, alphabetical label list - on the phone especially.
  const DEFAULT_ROOT = '_Board';

  // Done archives on drop because that is what finishing something in
  // Gmail usually means: out of the Inbox, still findable under its label.
  const DEFAULT_COLUMNS = [
    { id: 'todo', title: 'To do', label: `${DEFAULT_ROOT}/To do`, archiveOnDrop: false },
    { id: 'doing', title: 'Doing', label: `${DEFAULT_ROOT}/Doing`, archiveOnDrop: false },
    { id: 'waiting', title: 'Waiting', label: `${DEFAULT_ROOT}/Waiting`, archiveOnDrop: false },
    { id: 'done', title: 'Done', label: `${DEFAULT_ROOT}/Done`, archiveOnDrop: true },
  ];

  function defaultColumns() {
    return DEFAULT_COLUMNS.map(c => ({ ...c }));
  }

  // storage.sync can hold anything an older version - or a hand edit -
  // put there. Anything unusable falls back to the defaults rather than
  // leaving an empty board with no obvious way back.
  function normaliseColumns(raw) {
    if (!Array.isArray(raw)) return defaultColumns();
    const seen = new Set();
    const out = [];
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      const id = String(c.id || '').trim();
      const label = String(c.label || '').trim();
      if (!id || !label || seen.has(id)) continue;
      seen.add(id);
      const col = {
        id,
        title: String(c.title || '').trim() || label.split('/').pop(),
        label,
        archiveOnDrop: !!c.archiveOnDrop,
      };
      if (c.labelId && typeof c.labelId === 'string') col.labelId = c.labelId;
      out.push(col);
    }
    return out.length ? out : defaultColumns();
  }

  // Where a new column's label goes: under the parent the existing columns
  // share, so a board moved to "_Board/…" keeps growing there rather than
  // quietly recreating the old "Board" parent.
  function labelRoot(columns) {
    const parents = new Set((columns || []).map(c => {
      const parts = String(c.label || '').split('/');
      return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    }));
    if (parents.size === 1) {
      const [only] = parents;
      if (only) return only;
    }
    return DEFAULT_ROOT;
  }

  // Columns remember their label's id as well as its name, because Gmail
  // lets a label be renamed - and renaming "Board" to "_Board" renames
  // every column label under it. Following the id keeps a column on the
  // same mail; following the name alone would create a fresh, empty label
  // with the old name. Returns the columns with names brought up to date
  // and ids filled in, and whether anything changed (so it can be saved).
  function resolveColumnLabels(columns, labels) {
    const byId = new Map((labels || []).map(l => [l.id, l]));
    const byName = new Map((labels || []).map(l => [String(l.name).toLowerCase(), l]));
    let changed = false;
    const out = columns.map(c => {
      const viaId = c.labelId && byId.get(c.labelId);
      if (viaId) {
        if (viaId.name === c.label) return c;
        changed = true;
        return { ...c, label: viaId.name };
      }
      // Gmail's own spelling wins, so a case-only difference settles here
      // rather than counting as a rename on the next pass.
      const viaName = byName.get(String(c.label).toLowerCase());
      if (viaName) {
        if (c.labelId === viaName.id && c.label === viaName.name) return c;
        changed = true;
        return { ...c, label: viaName.name, labelId: viaName.id };
      }
      // Not in Gmail (yet): it is created under this name, and its id is
      // recorded on the next pass.
      if (c.labelId) {
        changed = true;
        const { labelId, ...rest } = c;
        return rest;
      }
      return c;
    });
    return { columns: out, changed };
  }

  function newColumnId(existing, rand = Math.random) {
    const taken = new Set((existing || []).map(c => c.id));
    let id;
    do {
      id = 'c' + Date.now().toString(36) + Math.floor(rand() * 1e6).toString(36);
    } while (taken.has(id));
    return id;
  }

  // Gmail reserves its system label names (case-insensitively) and rejects
  // empty path segments, so both are caught here with a readable message
  // instead of a bare 400 from the API.
  const RESERVED = new Set([
    'inbox', 'sent', 'drafts', 'spam', 'trash', 'starred', 'important',
    'unread', 'chat', 'snoozed', 'scheduled', 'all mail', 'outbox',
  ]);

  function validateColumns(cols) {
    if (!cols.length) return 'Keep at least one column.';
    const labels = new Set();
    for (const c of cols) {
      const title = (c.title || '').trim();
      const label = (c.label || '').trim();
      if (!title) return 'Every column needs a title.';
      if (!label) return `“${title}” needs a Gmail label.`;
      if (label.split('/').some(seg => !seg.trim())) {
        return `“${label}” has an empty part between slashes.`;
      }
      if (RESERVED.has(label.toLowerCase())) return `“${label}” is a Gmail system label and cannot be used.`;
      const key = label.toLowerCase();
      if (labels.has(key)) return `Two columns use the label “${label}”.`;
      labels.add(key);
    }
    return '';
  }

  // "_Board/To do" → ["_Board"]. Gmail only nests a label in its sidebar
  // when the parent exists, so the parents are created too.
  function labelAncestors(name) {
    const parts = String(name).split('/');
    const out = [];
    for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
    return out;
  }

  // ── Placement ────────────────────────────────────────────────────────

  // A thread carrying two column labels (moved on the phone, say) is shown
  // once, in the left-most of its columns. Showing it twice would make a
  // drag ambiguous about which label it is leaving.
  function assignColumns(columns, listsByColumn) {
    const seen = new Set();
    const out = {};
    for (const col of columns) {
      out[col.id] = [];
      for (const id of (listsByColumn[col.id] || [])) {
        if (seen.has(id)) continue;
        seen.add(id);
        out[col.id].push(id);
      }
    }
    return out;
  }

  // Saved order wins for every thread it mentions. Threads it does not
  // know about are new to the column, so they go on top - newest first -
  // where they will be noticed. Ids that have left the column drop out.
  function mergeOrder(savedIds, threads) {
    const present = new Map(threads.map(t => [t.id, t]));
    const kept = [];
    const keptSet = new Set();
    for (const id of (savedIds || [])) {
      if (present.has(id) && !keptSet.has(id)) { kept.push(id); keptSet.add(id); }
    }
    const fresh = threads
      .filter(t => !keptSet.has(t.id))
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
      .map(t => t.id);
    return fresh.concat(kept);
  }

  // Index is a position in the list as it looks WITHOUT the thread being
  // placed - which is what the drop zone measures, since the dragged card
  // is hidden while it is in flight.
  function placeId(list, id, index) {
    const rest = (list || []).filter(x => x !== id);
    const i = Math.max(0, Math.min(Number(index) || 0, rest.length));
    rest.splice(i, 0, id);
    return rest;
  }

  // Drops ids that are not on the board any more, and columns that no
  // longer exist, so storage.local does not slowly fill with dead threads.
  function pruneOrder(lists, columns) {
    const out = {};
    for (const col of columns) out[col.id] = (lists[col.id] || []).slice();
    return out;
  }

  // ── Label arithmetic ─────────────────────────────────────────────────

  function asLookup(labelIdOf) {
    if (typeof labelIdOf === 'function') return labelIdOf;
    if (labelIdOf instanceof Map) return name => labelIdOf.get(name);
    return name => (labelIdOf || {})[name];
  }

  // Moving a card is one threads.modify: add the target's label, strip
  // every other column label (so a thread is only ever in one column, even
  // if it had drifted into two), and drop INBOX when the target archives.
  function moveLabelDiff(columns, targetColumnId, labelIdOf) {
    const lookup = asLookup(labelIdOf);
    const target = columns.find(c => c.id === targetColumnId);
    if (!target) throw new Error(`Unknown column ${targetColumnId}`);
    const addId = lookup(target.label);
    if (!addId) throw new Error(`No Gmail label id for “${target.label}”`);

    const remove = new Set();
    for (const c of columns) {
      if (c.id === targetColumnId) continue;
      const id = lookup(c.label);
      if (id && id !== addId) remove.add(id);
    }
    if (target.archiveOnDrop) remove.add('INBOX');
    return { addLabelIds: [addId], removeLabelIds: [...remove] };
  }

  // Taking a card off the board strips every column label and nothing
  // else: the thread stays exactly where it was in Gmail.
  function removeLabelDiff(columns, labelIdOf) {
    const lookup = asLookup(labelIdOf);
    const remove = new Set();
    for (const c of columns) {
      const id = lookup(c.label);
      if (id) remove.add(id);
    }
    return { addLabelIds: [], removeLabelIds: [...remove] };
  }

  // Which column a thread belongs in, given the union of its label ids.
  function columnForLabels(columns, labelIds, labelIdOf) {
    const lookup = asLookup(labelIdOf);
    const have = new Set(labelIds || []);
    for (const c of columns) {
      const id = lookup(c.label);
      if (id && have.has(id)) return c;
    }
    return null;
  }

  // ── Threads ──────────────────────────────────────────────────────────

  // Reduces a threads.get(format=metadata) response to what a card shows.
  // Subject comes from the first message (replies prefix "Re:"), sender
  // and date from the latest real message (a pending draft is not news).
  function summariseThread(thread, account) {
    const msgs = (thread && thread.messages) || [];
    const id = thread && thread.id;
    const historyId = String((thread && thread.historyId) || '');
    if (!msgs.length) {
      return {
        id, historyId, subject: '(no subject)', from: '', fromEmail: '', ts: 0,
        snippet: util.decodeEntities((thread && thread.snippet) || ''),
        count: 0, unread: false, starred: false, hasDraft: false, labelIds: [],
      };
    }

    const isDraft = m => (m.labelIds || []).includes('DRAFT');
    const real = msgs.filter(m => !isDraft(m));
    const basis = real.length ? real : msgs;
    const latest = basis[basis.length - 1];
    const firstHeaders = util.headerMap(msgs[0]);
    const latestHeaders = util.headerMap(latest);

    const from = util.parseAddress(latestHeaders.from);
    const me = !!account && from.email === String(account).toLowerCase();
    const labels = new Set(msgs.flatMap(m => m.labelIds || []));

    return {
      id,
      historyId,
      subject: (firstHeaders.subject || '').trim() || '(no subject)',
      from: me ? 'me' : (util.displayName(from) || '(unknown sender)'),
      fromEmail: from.email,
      ts: Number(latest.internalDate) || Date.parse(latestHeaders.date) || 0,
      snippet: util.decodeEntities(latest.snippet || thread.snippet || ''),
      count: basis.length,
      unread: labels.has('UNREAD'),
      starred: labels.has('STARRED'),
      hasDraft: msgs.some(isDraft),
      labelIds: [...labels],
    };
  }

  function searchQuery(text) {
    const q = String(text || '').trim();
    return q || 'in:inbox';
  }

  // ── Card edits ───────────────────────────────────────────────────────
  //
  // A card can carry the user's own title, a short note and a colour. They
  // live in storage.sync beside the column layout and never touch the mail:
  // Gmail has nowhere to put a private title on a thread, and rewriting a
  // subject would change what correspondents see in their replies.

  const CARD_COLOURS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'];

  // Long enough for a working title or a "4,200 words, due Fri" note, short
  // enough that hundreds of cards fit sync's 100 KB.
  const MAX_TITLE = 200;
  const MAX_NOTE = 500;

  // Returns the edit to store, or null when nothing differs from the
  // email - so clearing every field deletes the record instead of leaving
  // an empty one to count against the quota. A title identical to the
  // subject is not an edit either: the editor opens pre-filled with it.
  function normaliseCardEdit(raw, subject = '') {
    if (!raw || typeof raw !== 'object') return null;
    const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    const note = String(raw.note || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_NOTE);
    const colour = CARD_COLOURS.includes(raw.colour) ? raw.colour : '';

    const out = {};
    if (title && title !== String(subject || '').trim()) out.title = title;
    if (note) out.note = note;
    if (colour) out.colour = colour;
    return Object.keys(out).length ? out : null;
  }

  function displayTitle(thread, edit) {
    return (edit && edit.title) || (thread && thread.subject) || '(no subject)';
  }

  // Picks one account's card edits out of a storage.sync dump, keyed by
  // thread id. Records that no longer normalise to anything are dropped.
  function cardEditsFrom(all, prefix) {
    const out = new Map();
    for (const [key, value] of Object.entries(all || {})) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const edit = normaliseCardEdit(value);
      if (id && edit) out.set(id, edit);
    }
    return out;
  }

  const api = {
    DEFAULT_ROOT, DEFAULT_COLUMNS, defaultColumns, normaliseColumns, labelRoot, resolveColumnLabels,
    newColumnId, validateColumns,
    labelAncestors, assignColumns, mergeOrder, placeId, pruneOrder,
    moveLabelDiff, removeLabelDiff, columnForLabels, summariseThread, searchQuery,
    CARD_COLOURS, MAX_TITLE, MAX_NOTE, normaliseCardEdit, displayTitle, cardEditsFrom,
  };

  ns.logic = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

// ════ src/lib/calendar-logic.js ═══════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Calendar logic (pure)
//
// The Calendar tab shows Google Calendar's events and Google Tasks'
// tasks side by side, day by day. This file holds the parts that need no
// browser: dates as "YYYY-MM-DD" keys in local time, the ranges each
// view shows, turning the two APIs' answers into one kind of day item,
// and which requests to Google are allowed at all.
//
// It is read-only for now. The second sign-in asks for read-only access to
// Calendar and Tasks, and the request policy below only lets GETs through:
// the calendar list, a calendar's events, the task lists and a list's
// tasks.
//
// Loaded by the content scripts, the service worker, the phone app's
// script and Node's tests.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  // ── Google, and what may be asked of it ──────────────────────────────

  // The second sign-in, separate from Gmail's, so that the board and the
  // notes never stop working for someone who has not allowed the calendar.
  // "email" lets the worker check whose calendar it is.
  const SCOPES = [
    'email',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/tasks.readonly',
  ];

  const BASES = {
    calendar: 'https://www.googleapis.com/calendar/v3/',
    tasks: 'https://tasks.googleapis.com/tasks/v1/',
  };

  const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

  // One path segment: an id, encoded with encodeURIComponent. Never one
  // that the URL parser would read as "." or "..", encoded or not.
  function isSegment(s) {
    if (!/^[A-Za-z0-9%._~-]+$/.test(s)) return false;
    let plain;
    try { plain = decodeURIComponent(s); } catch { return false; }
    return !/^\.+$/.test(plain) && !plain.includes('/');
  }

  const ALLOWED = {
    calendar: [
      p => p === 'users/me/calendarList',
      p => { const m = /^calendars\/([^/]+)\/events$/.exec(p); return !!m && isSegment(m[1]); },
    ],
    tasks: [
      p => p === 'users/@me/lists',
      p => { const m = /^lists\/([^/]+)\/tasks$/.exec(p); return !!m && isSegment(m[1]); },
    ],
  };

  function isAllowedRequest(service, method, path) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return false;
    const rules = Object.prototype.hasOwnProperty.call(ALLOWED, service) ? ALLOWED[service] : null;
    return !!rules && rules.some(ok => ok(String(path || '')));
  }

  // Query values may be arrays, as for Gmail.
  function buildUrl(service, path, query) {
    const parts = [];
    for (const key of Object.keys(query || {})) {
      const v = query[key];
      if (v === undefined || v === null || v === '') continue;
      for (const one of [].concat(v)) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(one)}`);
    }
    return BASES[service] + path + (parts.length ? `?${parts.join('&')}` : '');
  }

  // ── Dates ────────────────────────────────────────────────────────────
  //
  // A day is a "YYYY-MM-DD" string in local time: it sorts and compares as
  // text, and survives storage and messages unchanged. Weeks start on
  // Monday and are numbered as ISO 8601 numbers them.

  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                       'August', 'September', 'October', 'November', 'December'];

  // How far the agenda looks ahead, and how far one step moves it.
  const AGENDA_DAYS = 28;

  const pad = n => String(n).padStart(2, '0');

  function dateKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  }

  function isKey(key) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(key || ''));
  }

  function fromKey(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(key, n) {
    const d = fromKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }

  // Whole days from a to b. Rounded, because a day with a clock change
  // in it is an hour longer or shorter than 24.
  function daysBetween(a, b) {
    return Math.round((fromKey(b) - fromKey(a)) / 86400000);
  }

  // 0 for Monday … 6 for Sunday.
  function weekday(key) {
    return (fromKey(key).getDay() + 6) % 7;
  }

  function weekStart(key) {
    return addDays(key, -weekday(key));
  }

  // The ISO week: the one with the year's first Thursday in it is week 1.
  function isoWeek(key) {
    const thursday = addDays(weekStart(key), 3);
    const firstThursday = addDays(weekStart(`${thursday.slice(0, 4)}-01-04`), 3);
    return 1 + daysBetween(firstThursday, thursday) / 7;
  }

  function monthStart(key) {
    return `${String(key).slice(0, 7)}-01`;
  }

  // The same day n months on, or the month's last day if it is shorter.
  function addMonths(key, n) {
    const [y, m, d] = String(key).split('-').map(Number);
    const first = new Date(y, m - 1 + n, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return dateKey(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
  }

  // The days from start up to, not including, end.
  function days(start, end) {
    const out = [];
    for (let k = start; k < end; k = addDays(k, 1)) out.push(k);
    return out;
  }

  // ── Views ────────────────────────────────────────────────────────────

  const VIEWS = ['week', 'month', 'agenda'];

  // What a view shows around the day in focus: the week it is in; its
  // month, as whole weeks; or, for the agenda, four weeks from that day.
  // end is the day after the last.
  function viewRange(view, anchor) {
    if (view === 'month') {
      const first = monthStart(anchor);
      const last = addDays(addMonths(first, 1), -1);
      return { start: weekStart(first), end: addDays(weekStart(last), 7) };
    }
    if (view === 'agenda') return { start: anchor, end: addDays(anchor, AGENDA_DAYS) };
    const start = weekStart(anchor);
    return { start, end: addDays(start, 7) };
  }

  function step(view, anchor, dir) {
    if (view === 'month') return addMonths(anchor, dir);
    if (view === 'agenda') return addDays(anchor, dir * AGENDA_DAYS);
    return addDays(anchor, dir * 7);
  }

  // The month as rows of seven days, for the small calendar.
  function monthWeeks(anchor) {
    const { start, end } = viewRange('month', anchor);
    const all = days(start, end);
    const rows = [];
    for (let i = 0; i < all.length; i += 7) rows.push(all.slice(i, i + 7));
    return rows;
  }

  // "28 Sep – 4 Oct", "5 – 11 Oct", with the year when it is not this one.
  function spanText(first, last, today) {
    const [y1, m1, d1] = first.split('-').map(Number);
    const [y2, m2, d2] = last.split('-').map(Number);
    const thisYear = Number(String(today).slice(0, 4));
    const year = y => (y !== thisYear ? ` ${y}` : '');
    if (first === last) return `${d1} ${MONTHS[m1 - 1]}${year(y1)}`;
    if (y1 !== y2) return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
    if (m1 === m2) return `${d1} – ${d2} ${MONTHS[m2 - 1]}${year(y2)}`;
    return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]}${year(y2)}`;
  }

  function title(view, anchor, today) {
    if (view === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      return `${MONTHS_LONG[m - 1]} ${y}`;
    }
    const { start, end } = viewRange(view, anchor);
    const span = spanText(start, addDays(end, -1), today);
    return view === 'week' ? `Week ${isoWeek(anchor)} · ${span}` : span;
  }

  function monthName(key) {
    const [y, m] = key.split('-').map(Number);
    return { long: MONTHS_LONG[m - 1], short: MONTHS[m - 1], year: y };
  }

  function dayName(key) {
    return DAY_NAMES[weekday(key)];
  }

  // ── Sources ──────────────────────────────────────────────────────────

  function safeColour(c) {
    return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).toLowerCase() : '';
  }

  // Only plain https links are ever put on the page.
  function safeLink(url) {
    return /^https:\/\/[^\s]+$/i.test(String(url || '')) ? String(url) : '';
  }

  // A calendar from calendarList. Google's own "show in the list" choice
  // (selected) decides whether it is on until someone says otherwise here;
  // calendars hidden from Google's list are left out. The main calendar
  // is usually named after the address, of which the name part will do.
  function calendarSource(c) {
    if (!c || !c.id || c.hidden) return null;
    let name = String(c.summaryOverride || c.summary || c.id).trim();
    if (c.primary && name.includes('@')) name = name.split('@')[0];
    return {
      kind: 'calendar', id: String(c.id), name,
      colour: safeColour(c.backgroundColor) || '#1a73e8',
      primary: !!c.primary, on: c.selected !== false,
    };
  }

  function listSource(l) {
    if (!l || !l.id) return null;
    return { kind: 'tasks', id: String(l.id), name: String(l.title || '').trim() || 'Tasks', on: true };
  }

  // The main calendar first, then the rest as Google lists them, then
  // the task lists.
  function sources(calendarItems, listItems) {
    const cals = (calendarItems || []).map(calendarSource).filter(Boolean);
    cals.sort((a, b) => Number(b.primary) - Number(a.primary));
    return cals.concat((listItems || []).map(listSource).filter(Boolean));
  }

  // The switch someone flicked here wins over Google's default.
  function isOn(source, overrides) {
    const o = overrides && Object.prototype.hasOwnProperty.call(overrides, source.id) ? overrides[source.id] : undefined;
    return typeof o === 'boolean' ? o : source.on;
  }

  // ── Requests ─────────────────────────────────────────────────────────

  const CALENDAR_LIST_FIELDS = 'items(id,summary,summaryOverride,backgroundColor,selected,hidden,primary,accessRole)';
  const EVENT_FIELDS = 'items(id,status,summary,start,end,htmlLink,colorId,eventType,location),nextPageToken';

  function sourceRequests() {
    return [
      ['calendar', 'users/me/calendarList', { minAccessRole: 'reader', maxResults: 250, fields: CALENDAR_LIST_FIELDS }],
      ['tasks', 'users/@me/lists', { maxResults: 100 }],
    ];
  }

  // For each calendar, its events in the range (a day either side, for
  // calendars in another time zone; the days are sorted out here). For
  // each task list, its open tasks - dated or not, for the "No date" tray
  // and anything overdue - and the ones done within the range. Google's
  // own apps hide a task when it is ticked, hence showHidden.
  function rangeRequests(range, calendars, lists) {
    const from = addDays(range.start, -1);
    const to = addDays(range.end, 1);
    const out = [];
    for (const c of calendars) {
      out.push(['calendar', `calendars/${encodeURIComponent(c.id)}/events`, {
        timeMin: fromKey(from).toISOString(), timeMax: fromKey(to).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: 2500, fields: EVENT_FIELDS,
      }]);
    }
    for (const l of lists) {
      const path = `lists/${encodeURIComponent(l.id)}/tasks`;
      out.push(['tasks', path, { showCompleted: 'false', maxResults: 100 }]);
      out.push(['tasks', path, {
        showCompleted: 'true', showHidden: 'true', maxResults: 100,
        dueMin: `${from}T00:00:00.000Z`, dueMax: `${to}T00:00:00.000Z`,
      }]);
    }
    return out;
  }

  // ── Items ────────────────────────────────────────────────────────────

  // Google Calendar's own event colours, by colorId.
  const EVENT_COLOURS = {
    1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
    7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
  };

  // An event, on every day it covers (first to last, both included).
  // Working-location entries ("Home", "Office") are left out: they are
  // on every day and say nothing a glance needs.
  function eventItem(ev, cal) {
    if (!ev || ev.status === 'cancelled' || ev.eventType === 'workingLocation') return null;
    const s = ev.start || {};
    const e = ev.end || {};
    const base = {
      kind: 'event', id: `${cal.id}|${ev.id}`, source: cal.id,
      title: String(ev.summary || '').trim() || '(No title)',
      colour: EVENT_COLOURS[ev.colorId] || cal.colour,
      link: safeLink(ev.htmlLink), where: String(ev.location || '').trim(),
    };
    if (isKey(s.date)) {
      const last = isKey(e.date) ? addDays(e.date, -1) : s.date;
      return Object.assign(base, { allDay: true, first: s.date, last: last < s.date ? s.date : last, start: 0, end: 0 });
    }
    const start = Date.parse(s.dateTime);
    if (!isFinite(start)) return null;
    const endMs = Date.parse(e.dateTime);
    const end = isFinite(endMs) && endMs > start ? endMs : start;
    // An event ending at midnight does not spill into the next day.
    return Object.assign(base, {
      allDay: false, start, end, first: dateKey(start), last: dateKey(Math.max(start, end - 1)),
    });
  }

  // A task, on its due day. Google keeps only the date of a due date (the
  // time is always midnight UTC), so the date is read as written, not
  // moved into the local time zone. A task made from an email in Gmail
  // links back to it.
  function taskItem(t, list) {
    if (!t || !t.id || t.deleted) return null;
    const title = String(t.title || '').trim();
    if (!title) return null;
    const due = /^\d{4}-\d{2}-\d{2}/.test(String(t.due || '')) ? String(t.due).slice(0, 10) : '';
    const mail = (t.links || []).find(l => l && l.type === 'email' && /^https:\/\/mail\.google\.com\//.test(String(l.link || '')));
    return {
      kind: 'task', id: `${list.id}|${t.id}`, source: list.id, title, due,
      done: t.status === 'completed', email: !!mail,
      link: safeLink(mail ? mail.link : t.webViewLink), list: list.name,
    };
  }

  // Tasks arrive twice when one is both open and due in the range.
  function uniqueById(items) {
    const seen = new Set();
    return items.filter(x => !seen.has(x.id) && seen.add(x.id));
  }

  // All-day first, then by time, then the tasks: open before done.
  function compareItems(a, b) {
    const rank = x => (x.kind === 'event' ? (x.allDay ? 0 : 1) : (x.done ? 3 : 2));
    return rank(a) - rank(b) || (a.start || 0) - (b.start || 0) || a.title.localeCompare(b.title);
  }

  // Day key → what is on it, each entry { item, cont }: cont when a
  // timed event started on an earlier day.
  function byDay(items, dayKeys) {
    const out = new Map(dayKeys.map(k => [k, []]));
    if (!dayKeys.length) return out;
    const first = dayKeys[0];
    const last = dayKeys[dayKeys.length - 1];
    for (const item of items) {
      if (item.kind === 'task') {
        if (item.due && out.has(item.due)) out.get(item.due).push({ item, cont: false });
        continue;
      }
      if (item.last < first || item.first > last) continue;
      const from = item.first < first ? first : item.first;
      const to = item.last > last ? last : item.last;
      for (let k = from; k <= to; k = addDays(k, 1)) {
        if (out.has(k)) out.get(k).push({ item, cont: k !== item.first });
      }
    }
    for (const list of out.values()) list.sort((a, b) => compareItems(a.item, b.item));
    return out;
  }

  // What waits under the week: open tasks with no date, and open tasks
  // whose day has gone by.
  function tray(items, today) {
    const open = items.filter(x => x.kind === 'task' && !x.done);
    return {
      overdue: open.filter(x => x.due && x.due < today).sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title)),
      undated: open.filter(x => !x.due),
    };
  }

  const api = {
    SCOPES, BASES, USERINFO_URL, VIEWS, AGENDA_DAYS, DAY_NAMES, MONTHS, MONTHS_LONG, EVENT_COLOURS,
    isAllowedRequest, buildUrl,
    dateKey, isKey, fromKey, addDays, daysBetween, weekday, weekStart, isoWeek, monthStart, addMonths, days,
    viewRange, step, monthWeeks, spanText, title, monthName, dayName,
    safeColour, safeLink, calendarSource, listSource, sources, isOn,
    sourceRequests, rangeRequests, eventItem, taskItem, uniqueById, compareItems, byDay, tray,
  };

  ns.calendarLogic = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

// ════ addon/src/panel-logic.js ════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Phone panel logic (pure)
//
// What the Gmail add-on needs to put the open email on the board, without
// any of Apps Script's services - so it is tested in Node like the rest
// of the shared code: the columns, read from the labels; the column a
// conversation is in; the labels a move changes; and Gmail's ids in the
// form its API takes. The phone app's server side reads its first
// columns with boardColumns too.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const node = typeof module === 'object' && module.exports;
  const board = node ? require('../../src/lib/board-logic.js') : ns.logic;

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── The board ────────────────────────────────────────────────────────
  //
  // The extension keeps its column list in Chrome's synced storage, out of
  // reach here, so the panel reads the columns from the labels themselves:
  // every label directly under the board's parent ("_Board/Doing") is a
  // column. The usual four come first in their usual order, any others
  // after them alphabetically, and Done archives, as it does by default.
  // The moves themselves are the extension's own label arithmetic.

  function boardColumns(labels, root = board.DEFAULT_ROOT) {
    const prefix = `${root}/`.toLowerCase();
    const usual = board.DEFAULT_COLUMNS.map(c => c.title.toLowerCase());
    const rank = c => {
      const i = usual.indexOf(c.title.toLowerCase());
      return i < 0 ? usual.length : i;
    };
    return (labels || [])
      .filter(l => l && typeof l.name === 'string' && l.name.toLowerCase().startsWith(prefix) &&
        l.name.length > prefix.length && l.name.indexOf('/', prefix.length) < 0)
      .map(l => {
        const title = l.name.slice(prefix.length);
        return { id: l.id, title, label: l.name, labelId: l.id, archiveOnDrop: title.toLowerCase() === 'done' };
      })
      .sort((a, b) => rank(a) - rank(b) || (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : 0));
  }

  const labelIdOf = columns => name => {
    const c = columns.find(x => x.label === name);
    return c ? c.labelId : undefined;
  };

  // The column a thread is in, from the labels of all its messages.
  function currentColumn(columns, labelIds) {
    return board.columnForLabels(columns, labelIds, labelIdOf(columns)) || null;
  }

  // The labels to change to put a thread in a column ('' takes it off the
  // board): into one column only, out of the Inbox when that column archives.
  function boardDiff(columns, columnId) {
    return columnId
      ? board.moveLabelDiff(columns, columnId, labelIdOf(columns))
      : board.removeLabelDiff(columns, labelIdOf(columns));
  }

  // ── Ids ──────────────────────────────────────────────────────────────

  // Gmail's API names a message or a conversation by a hexadecimal id.
  // Gmail's own pages name them in decimal ("msg-f:1849…",
  // "thread-f:1849…"); should one arrive that way, it is the same number.
  function apiId(id) {
    const s = String(id || '').trim();
    const m = /^(?:msg|thread)-[af]:(\d+)$/.exec(s) || /^(\d{18,})$/.exec(s);
    if (!m) return s;
    let digits = m[1].replace(/^0+(?=\d)/, '').split('').map(Number);
    let hex = '';
    while (digits.length > 1 || digits[0] > 0) {
      const next = [];
      let rem = 0;
      for (const d of digits) {
        const cur = rem * 10 + d;
        const q = Math.floor(cur / 16);
        rem = cur % 16;
        if (next.length || q) next.push(q);
      }
      hex = '0123456789abcdef'[rem] + hex;
      digits = next.length ? next : [0];
    }
    return hex || '0';
  }

  const api = { esc, boardColumns, currentColumn, boardDiff, apiId };

  ns.panelLogic = api;
  if (node) module.exports = api;
})();

// ════ addon/src/gmail.js ══════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Gmail, from Apps Script (phone panel only)
//
// The same REST calls the extension makes, sent with UrlFetchApp and the
// script's own token, so requests and responses have exactly the shapes
// the shared note code expects. fetchAll sends a batch side by side,
// which is what keeps a list of twenty notes quick on a phone.
//
// The same limits as the extension's worker, too: it inserts only notes,
// moves to Trash only messages it has itself checked are notes, and
// never adds Trash, Spam or Inbox to anything.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const notesLogic = ns.notesLogic;

  const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
  const NEVER_ADD = /^(TRASH|SPAM|INBOX)$/i;

  function queryString(query) {
    const parts = [];
    for (const key of Object.keys(query || {})) {
      const v = query[key];
      if (v === undefined || v === null || v === '') continue;
      for (const one of [].concat(v)) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(one)}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
  }

  // UrlFetchApp's options for one call (fetchAll also wants the url in them).
  function options(method, body) {
    const req = {
      method: method.toLowerCase(),
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true,
    };
    if (body !== undefined && body !== null) {
      req.contentType = 'application/json; charset=utf-8';
      req.payload = JSON.stringify(body);
    }
    return req;
  }

  function parse(res, method, path, who = 'Gmail') {
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
    let message = text;
    try { message = JSON.parse(text).error.message || text; } catch (e) { /* not JSON */ }
    const err = new Error(`${who} answered ${code} to ${method} ${path}: ${message}`);
    err.status = code;
    err.detail = message;
    throw err;
  }

  function call(method, path, query, body) {
    return parse(UrlFetchApp.fetch(BASE + path + queryString(query), options(method, body)), method, path);
  }

  // Several GETs at once. Each result is the response, or { error }.
  function callAll(list) {
    if (!list.length) return [];
    const responses = UrlFetchApp.fetchAll(list.map(([method, path, query]) =>
      Object.assign({ url: BASE + path + queryString(query) }, options(method))));
    return responses.map((res, i) => {
      try {
        return parse(res, list[i][0], list[i][1]);
      } catch (err) {
        return { error: err };
      }
    });
  }

  // Reads from Google's other APIs (the calendar's), each a whole URL
  // that the caller has checked. Each result is the response, or { error }.
  function getAll(urls) {
    if (!urls.length) return [];
    const responses = UrlFetchApp.fetchAll(urls.map(url => Object.assign({ url }, options('GET'))));
    return responses.map((res, i) => {
      try {
        return parse(res, 'GET', urls[i].split('?')[0], 'Google');
      } catch (err) {
        return { error: err };
      }
    });
  }

  // ── The writes, with their limits ────────────────────────────────────

  function insertNote(body) {
    if (!notesLogic.isNoteInsert(body)) throw new Error('Only notes are ever added to Gmail from here.');
    return call('POST', 'messages', null, body);
  }

  function labelChange(diff) {
    const add = diff.addLabelIds || [];
    if (add.some(id => NEVER_ADD.test(id))) throw new Error('Mail is never moved to Trash, Spam or the Inbox from here.');
    return { addLabelIds: add, removeLabelIds: diff.removeLabelIds || [] };
  }

  function modifyLabels(messageId, diff) {
    return call('POST', `messages/${encodeURIComponent(messageId)}/modify`, null, labelChange(diff));
  }

  // A board move: the whole conversation, as the extension moves it.
  function modifyThread(threadId, diff) {
    return call('POST', `threads/${encodeURIComponent(threadId)}/modify`, null, labelChange(diff));
  }

  // Reads the message first and refuses anything that is not a note.
  function trashNote(messageId) {
    const msg = call('GET', `messages/${encodeURIComponent(messageId)}`, { format: 'metadata', metadataHeaders: [notesLogic.NOTE_HEADER] });
    if (!notesLogic.noteFromMessage(msg).own) throw new Error('Only notes are ever moved to Trash from here.');
    return call('POST', `messages/${encodeURIComponent(messageId)}/trash`);
  }

  // Undo of a delete: out of Trash again - also only for a note.
  function untrashNote(messageId) {
    const msg = call('GET', `messages/${encodeURIComponent(messageId)}`, { format: 'metadata', metadataHeaders: [notesLogic.NOTE_HEADER] });
    if (!notesLogic.noteFromMessage(msg).own) throw new Error('Only notes are ever taken out of Trash from here.');
    return call('POST', `messages/${encodeURIComponent(messageId)}/untrash`);
  }

  ns.addonGmail = { call, callAll, getAll, insertNote, modifyLabels, modifyThread, trashNote, untrashNote, queryString };
})();

// ════ addon/src/store.js ══════════════════════════════════════════════

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

// ════ addon/src/cards.js ══════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// The phone panel's cards
//
// Gmail shows an add-on at the bottom of an open email in its phone app,
// and beside it on a computer. The panel does one thing: it puts the
// open email on the board. It says which column the email is in, with a
// button for each column - one tap moves it there, as the button next to
// Board does in Chrome - and one to take it off the board. The notes and
// the calendar on a phone are the phone app's.
//
// It opens on every email, so it reads as little as it can (see
// store.openEmail), and with no email open it reads nothing at all.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const store = ns.addonStore;
  const panel = ns.panelLogic;

  const NAME = ns.APP_NAME;
  const GREY = '#5f6368';

  const params = e => (e && e.commonEventObject && e.commonEventObject.parameters) || (e && e.parameters) || {};

  // ── Building blocks ──────────────────────────────────────────────────

  const greyText = s => CardService.newTextParagraph().setText(`<font color="${GREY}">${panel.esc(s)}</font>`);

  // Parameters travel as strings; empty ones are left out rather than
  // sent as "".
  function action(fn, p) {
    const a = CardService.newAction().setFunctionName(fn);
    const kept = {};
    Object.keys(p || {}).forEach(k => { if (p[k] !== undefined && p[k] !== null && p[k] !== '') kept[k] = String(p[k]); });
    if (Object.keys(kept).length) a.setParameters(kept);
    return a;
  }

  function button(label, fn, p, filled) {
    const b = CardService.newTextButton().setText(label).setOnClickAction(action(fn, p));
    if (filled) b.setTextButtonStyle(CardService.TextButtonStyle.FILLED);
    return b;
  }

  function respond({ card, notify = '', changed = false }) {
    const r = CardService.newActionResponseBuilder();
    if (card) r.setNavigation(CardService.newNavigation().updateCard(card));
    if (notify) r.setNotification(CardService.newNotification().setText(notify));
    if (changed) r.setStateChanged(true);
    return r.build();
  }

  function card(name, title, subtitle, section) {
    return CardService.newCardBuilder()
      .setName(name)
      .setHeader(CardService.newCardHeader().setTitle(title).setSubtitle(subtitle))
      .addSection(section)
      .build();
  }

  // ── The cards ────────────────────────────────────────────────────────

  // The open email's place on the board: a button for each column, the
  // one it is in filled in, and one to take it off. `current`: its
  // column, or null.
  function boardCard(columns, threadId, current) {
    const section = CardService.newCardSection();
    if (!columns.length) {
      section.addWidget(greyText(`The board has no columns yet. Open it once in Chrome or in the ${NAME} app, and the usual four are made.`));
      return card('board', 'Not on the board', NAME, section);
    }
    const set = CardService.newButtonSet();
    columns.forEach(c => set.addButton(button(c.title, 'onMoveThread', { threadId, columnId: c.id }, !!current && c.id === current.id)));
    section.addWidget(set);
    const archives = columns.filter(c => c.archiveOnDrop).map(c => c.title);
    if (archives.length) section.addWidget(greyText(`${archives.join(' and ')} also archives it: out of the Inbox.`));
    if (current) section.addWidget(CardService.newButtonSet().addButton(button('Take off the board', 'onMoveThread', { threadId })));
    return card('board', current ? `On the board: ${current.title}` : 'Not on the board', NAME, section);
  }

  function homeCard() {
    return card('home', NAME, 'The board', CardService.newCardSection().addWidget(greyText('Open an email to put it on the board.')));
  }

  // ── When things go wrong ─────────────────────────────────────────────

  function explain(err) {
    const m = String((err && err.message) || err);
    if (/has not been used in project|is disabled/i.test(m)) {
      return 'The Gmail API is not switched on for this script. Check the Gmail service under Services in the script editor.';
    }
    if (/\b401\b|\b403\b.*(scope|permission)|insufficient/i.test(m)) return `${NAME} needs your permission again. Open it once in Gmail on a computer.`;
    return m.length > 180 ? `${m.slice(0, 179)}…` : m;
  }

  function errorCard(err) {
    return card('error', NAME, 'Something went wrong', CardService.newCardSection().addWidget(greyText(explain(err))));
  }

  function log(err) {
    console.error((err && err.stack) || String(err));
  }

  const cards = fn => e => {
    try { return fn(e); } catch (err) { log(err); return [errorCard(err)]; }
  };
  const act = fn => e => {
    try { return fn(e); } catch (err) { log(err); return respond({ notify: `Not done: ${explain(err)}` }); }
  };

  // ── Triggers and buttons ─────────────────────────────────────────────

  // Gmail with no email open (its side panel on a computer).
  const onHomepage = cards(() => [homeCard()]);

  // An email was opened.
  const onGmailMessage = cards(e => {
    const g = (e && e.gmail) || (e && e.messageMetadata) || {};
    const messageId = panel.apiId(g.messageId);
    const threadId = panel.apiId(g.threadId);
    if (!messageId && !threadId) return [homeCard()];
    const { columns, thread } = store.openEmail(messageId, threadId);
    return [boardCard(columns, thread.id, panel.currentColumn(columns, thread.labelIds))];
  });

  // A column's button, or Take off the board (no column).
  const onMoveThread = act(e => {
    const p = params(e);
    if (!p.threadId) return respond({ notify: 'Open an email first.' });
    const { columns, target } = store.moveThread(p.threadId, p.columnId || '');
    let said = 'Taken off the board.';
    if (target) said = target.archiveOnDrop ? `Moved to ${target.title} and archived.` : `Moved to ${target.title}.`;
    return respond({ card: boardCard(columns, p.threadId, target), notify: said, changed: true });
  });

  ns.panel = { onHomepage, onGmailMessage, onMoveThread };
})();

// ════ addon/src/app-server.js ═════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// The phone app's server side
//
// The phone app (addon/app) is the extension's own board and Notes view,
// served as a full-screen web page by this same script. Where the
// extension asks Gmail through its background worker, the app asks these
// functions through google.script.run - and they keep the worker's rules:
// only notes are inserted, only notes go to Trash or come back out of it,
// mail kept as a note just leaves the list, only an empty notes folder is
// ever deleted, and the board only reads, labels and unlabels - nothing
// is ever sent, deleted, or put in Trash, Spam or the Inbox. The calendar
// only reads.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const notesLogic = ns.notesLogic;
  const fmt = ns.noteFormat;
  const gmail = ns.addonGmail;
  const store = ns.addonStore;

  const META = ['Subject', 'Date', notesLogic.NOTE_HEADER];
  const LIST_MAX = 100;

  const notesLabelIds = ctx => [ctx.root.id].concat(ctx.folders.map(f => f.id));

  // What the page gets for a note: the listing's fields, no message parts.
  function plainNote(n) {
    return {
      messageId: n.messageId, threadId: n.threadId, noteId: n.noteId, own: n.own, key: n.key,
      title: n.title, updated: n.updated, snippet: n.snippet, labelIds: n.labelIds, folderId: n.folderId || '',
    };
  }

  function ok(results) {
    const bad = results.find(r => r && r.error);
    if (bad) throw bad.error;
    return results;
  }

  // Every note, newest first, one entry per note, each with its folder -
  // the notes label and each folder's label listed separately, as the
  // extension does. With a query, Gmail's search runs in each, and the
  // notes come back with their content, for the excerpts.
  function list(query) {
    const ctx = store.context();
    const q = String(query || '').trim();
    const scans = [ctx.root].concat(ctx.folders);
    const listed = ok(gmail.callAll(scans.map(l => ['GET', 'messages', { labelIds: l.id, q: q || undefined, maxResults: LIST_MAX }])));
    const via = {};
    let truncated = false;
    listed.forEach((r, i) => {
      if (r.nextPageToken) truncated = true;
      (r.messages || []).forEach(m => { (via[m.id] = via[m.id] || []).push(scans[i].id); });
    });
    const ids = Object.keys(via);
    const msgs = gmail.callAll(ids.map(id => ['GET', `messages/${id}`, q ? { format: 'full' } : { format: 'metadata', metadataHeaders: META }]))
      .filter(m => m && !m.error);
    const notes = msgs.map(m => {
      const n = notesLogic.noteFromMessage(m);
      n.folderId = notesLogic.folderOf(via[m.id], ctx.folders);
      return n;
    });
    const { live, stale } = notesLogic.dedupeNotes(notes);
    // Older versions a cut-short save left behind, tidied as the extension
    // tidies them - only from the full list, never from a search.
    if (!q) {
      stale.forEach(n => {
        try { retireNote(ctx, n); } catch (err) { console.warn(`Could not tidy ${n.messageId}: ${err.message}`); }
      });
    }
    const docs = {};
    if (q) live.forEach(n => { docs[n.messageId] = fmt.docFromParts(n.parts || {}); });
    return { notes: live.map(plainNote), truncated, folders: ctx.folders, label: ctx.root.name, docs };
  }

  function body(messageId) {
    return store.open(store.context(), messageId).doc;
  }

  // ── Opening the app ──────────────────────────────────────────────────
  //
  // The page's first call: whose mailbox, the app's settings, the board's
  // first columns if it has none saved, and the scratchpad. The phone
  // keeps a copy of the scratchpad and says which message it is (`hint`);
  // if that message is still the scratchpad - nobody has saved it since -
  // one round of Gmail requests answers everything and the text need not
  // travel. Otherwise the current one comes back in full.

  const metadataOf = refs => gmail.callAll(refs.map(m => ['GET', `messages/${m.id}`, { format: 'metadata', metadataHeaders: META }]))
    .filter(m => m && !m.error);

  function noteOf(ctx, msg) {
    const n = notesLogic.noteFromMessage(msg);
    n.folderId = notesLogic.folderOf(n.labelIds, ctx.folders);
    return n;
  }

  const isScratch = (ctx, n) => n.own && n.noteId === notesLogic.SCRATCHPAD_ID &&
    n.labelIds.indexOf(ctx.root.id) >= 0 && n.labelIds.indexOf('TRASH') < 0;

  // The scratchpad, newest version: among the newest notes, a few at a
  // time, or failing that by its name.
  function findScratch(ctx) {
    const pick = refs => notesLogic.dedupeNotes(metadataOf(refs).map(m => noteOf(ctx, m)).filter(n => isScratch(ctx, n))).live[0] || null;
    const refs = gmail.call('GET', 'messages', { labelIds: ctx.root.id, maxResults: LIST_MAX }).messages || [];
    for (const [from, to] of [[0, 10], [10, 40], [40, refs.length]]) {
      const found = from < refs.length ? pick(refs.slice(from, to)) : null;
      if (found) return found;
    }
    if (refs.length < LIST_MAX) return null;
    const named = gmail.call('GET', 'messages', { labelIds: ctx.root.id, q: `subject:"${notesLogic.SCRATCHPAD_TITLE}"`, maxResults: 20 }).messages || [];
    return named.length ? pick(named) : null;
  }

  function start(hint) {
    const kept = String(hint || '');
    const first = gmail.callAll([['GET', 'labels'], ['GET', 'profile']]
      .concat(kept ? [['GET', `messages/${encodeURIComponent(kept)}`, { format: 'metadata', metadataHeaders: META }]] : []));
    const [labels, profile] = ok(first.slice(0, 2));
    const ctx = store.context(labels.labels || []);
    const account = String(profile.emailAddress || '');
    const copy = kept && first[2] && !first[2].error ? noteOf(ctx, first[2]) : null;
    let scratch = copy && isScratch(ctx, copy) ? copy : null;
    let doc = null; // the phone has it
    if (!scratch) {
      scratch = findScratch(ctx);
      if (scratch) doc = store.open(ctx, scratch.messageId).doc;
    }
    const prefs = prefsGet(null);
    const columns = prefs[ns.KEYS.columns(account)] ? null : boardColumns(labels.labels || []);
    return {
      account, label: ctx.root.name, folders: ctx.folders,
      scratch: scratch ? plainNote(scratch) : null, doc, prefs, columns,
    };
  }

  // A newer version of the note a save starts from, saved on another
  // device since this page read it - or, for the scratchpad when the page
  // knew of none, the one there already.
  function newerThan(ctx, previous, noteId) {
    if (previous) return previous.own ? store.newerVersion(ctx, previous) : null;
    if (noteId !== notesLogic.SCRATCHPAD_ID) return null;
    return store.newerVersion(ctx, { own: true, noteId, messageId: '', inNotes: false, trashed: false, updated: 0 });
  }

  // A new version (or a new note), and the old one retired. What the page
  // says about the previous version is not taken on trust: it is read. If
  // another device has saved a newer one since, nothing is written: the
  // page is told, merges the two, and saves again.
  function save(previousId, snap) {
    const ctx = store.context();
    const previous = previousId ? store.peek(ctx, previousId) : null;
    const s = snap || {};
    const newer = newerThan(ctx, previous, String(s.noteId || ''));
    if (newer) return { conflict: plainNote(newer) };
    const folderId = ctx.folders.some(f => f.id === s.folderId) ? s.folderId : '';
    const id = store.save(ctx, previous, { title: String(s.title || ''), doc: s.doc, folderId, noteId: String(s.noteId || '') });
    return { note: plainNote(store.peek(ctx, id)) };
  }

  function retireNote(ctx, note) {
    if (note.own) gmail.trashNote(note.messageId);
    else gmail.modifyLabels(note.messageId, { addLabelIds: [], removeLabelIds: notesLabelIds(ctx) });
  }

  function retire(messageId) {
    const ctx = store.context();
    retireNote(ctx, store.peek(ctx, messageId));
    return true;
  }

  function restore(messageId, folderId) {
    const ctx = store.context();
    const note = store.peek(ctx, messageId);
    if (note.own) gmail.untrashNote(messageId);
    else {
      const folder = ctx.folders.some(f => f.id === folderId) ? folderId : '';
      gmail.modifyLabels(messageId, { addLabelIds: folder ? [ctx.root.id, folder] : [ctx.root.id], removeLabelIds: [] });
    }
    return true;
  }

  function move(messageId, folderId) {
    const ctx = store.context();
    store.move(ctx, messageId, ctx.folders.some(f => f.id === folderId) ? folderId : '');
    return true;
  }

  // ── Folders ──────────────────────────────────────────────────────────

  function siblingsOf(ctx, parentPath, except) {
    return ctx.folders.filter(f => f.parentPath === parentPath && f !== except).map(f => f.title);
  }

  function createFolder(parentId, title) {
    const ctx = store.context();
    const parent = ctx.folders.find(f => f.id === parentId) || null;
    const problem = notesLogic.validateFolderTitle(title, siblingsOf(ctx, parent ? parent.path : '', null));
    if (problem) throw new Error(problem);
    const name = `${parent ? parent.name : ctx.root.name}/${String(title).trim()}`;
    gmail.call('POST', 'labels', null, { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    const after = store.context();
    return { folder: after.folders.find(f => f.name.toLowerCase() === name.toLowerCase()) || null, folders: after.folders };
  }

  // Gmail's API renames only the label it is given, so the folders under
  // it are renamed after it - each only if Gmail has not done it already.
  function renameFolder(folderId, title) {
    const ctx = store.context();
    const folder = ctx.folders.find(f => f.id === folderId);
    if (!folder) throw new Error('That folder is not there any more.');
    const problem = notesLogic.validateFolderTitle(title, siblingsOf(ctx, folder.parentPath, folder));
    if (problem) throw new Error(problem);
    notesLogic.renamePlan(folder, title, ctx.folders).forEach(step => {
      const now = (gmail.call('GET', 'labels').labels || []).find(l => l.id === step.id);
      if (now && now.name !== step.name) gmail.call('PATCH', `labels/${encodeURIComponent(step.id)}`, null, { name: step.name });
    });
    return { folders: store.context().folders };
  }

  // Only a folder under the notes label with no notes in it and no
  // folders under it - checked here, from Gmail, whatever the page says.
  function deleteFolder(folderId) {
    const ctx = store.context();
    const label = gmail.call('GET', `labels/${encodeURIComponent(folderId)}`);
    const all = gmail.call('GET', 'labels').labels || [];
    const live = (gmail.call('GET', 'messages', { labelIds: folderId, maxResults: 1 }).messages || []).length;
    if (!notesLogic.isDeletableFolder(label, ctx.root.name, all, live)) {
      throw new Error('not_allowed: only an empty notes folder can be deleted.');
    }
    gmail.call('DELETE', `labels/${encodeURIComponent(folderId)}`);
    return { folders: store.context().folders };
  }

  // The page itself, built into Code.gs by tools/build-addon.mjs. With
  // ?ping=1, a line that says the script itself runs - to tell a problem
  // here from one in the page.
  function page(e) {
    const html = globalThis.MEMDESK_APP_HTML || '';
    if (e && e.parameter && e.parameter.ping) {
      return HtmlService.createHtmlOutput(`<p style="font: 16px/1.5 Arial, sans-serif; padding: 24px">${ns.APP_NAME} ${globalThis.MEMDESK_VERSION || ''}: ` +
        `the script runs, and its page is ${html.length} characters long.</p>`).setTitle(`${ns.APP_NAME} notes`);
    }
    const out = HtmlService.createHtmlOutput(html || '<p>The app is not built into this Code.gs.</p>')
      .setTitle(ns.APP_NAME)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
    // Our icon rather than Apps Script's, in the tab and on the home screen.
    // Only a nicety: a refused address must not cost the page.
    try {
      if (globalThis.MEMDESK_ICON_URL) out.setFaviconUrl(globalThis.MEMDESK_ICON_URL);
    } catch (err) {
      console.warn(`The icon was not set: ${err.message}`);
    }
    return out;
  }

  // ── The board ────────────────────────────────────────────────────────
  //
  // The app runs the extension's own board (src/content/board.js and
  // store.js), whose Gmail requests come here instead of to the worker.
  // They are held to what the board does with Gmail, and nothing more.

  const BOARD_REQUESTS = [
    ['GET', /^labels$/],
    ['GET', /^threads$/],
    ['GET', /^threads\/[A-Za-z0-9]+$/],
    ['POST', /^labels$/],
    ['PATCH', /^labels\/Label_[0-9]+$/],
    ['POST', /^threads\/[A-Za-z0-9]+\/modify$/],
  ];
  const BATCH_MAX = 200;

  function boardAllowed(method, path) {
    const m = String(method || '').toUpperCase();
    const p = String(path || '');
    if (!BOARD_REQUESTS.some(([mm, re]) => mm === m && re.test(p))) {
      throw new Error(`not_allowed: ${m} ${p} is not something the board does.`);
    }
    return [m, p];
  }

  function boardGmail(method, path, query, body) {
    const [m, p] = boardAllowed(method, path);
    const b = body || {};
    // Labelling: never Trash, Spam or the Inbox (gmail.js refuses those).
    if (m === 'POST' && p.endsWith('/modify')) return gmail.modifyThread(p.split('/')[1], b);
    // A column's label: a name, and how Gmail shows it - nothing else.
    if (m === 'POST' || m === 'PATCH') {
      const name = String(b.name || '').trim();
      if (!name) throw new Error('not_allowed: a label needs a name.');
      const label = { name };
      if (m === 'POST') Object.assign(label, { labelListVisibility: 'labelShow', messageListVisibility: 'show' });
      return gmail.call(m, p, null, label);
    }
    return gmail.call(m, p, query || null);
  }

  // Several reads side by side: a board's worth of cards in one round
  // trip instead of one each. Each answer is the response, or { error }.
  function boardGmailMany(list) {
    const calls = (list || []).slice(0, BATCH_MAX).map(([method, path, query]) => {
      const [m, p] = boardAllowed(method, path);
      if (m !== 'GET') throw new Error('not_allowed: only reads go in a batch.');
      return [m, p, query || null];
    });
    return gmail.callAll(calls).map(r => (r && r.error ? { error: { message: r.error.message, status: r.error.status || 0 } } : r));
  }

  // Whose mailbox this is, for the board's per-account settings.
  function account() {
    return gmail.call('GET', 'profile').emailAddress;
  }

  // Before the app has a column layout of its own: the board's labels as
  // Gmail has them, so a column renamed in the extension does not come
  // back here as a fresh, empty label of the old name. null: no board
  // labels yet, and the usual columns will be made.
  function boardColumns(known) {
    const labels = Array.isArray(known) ? known : gmail.call('GET', 'labels').labels || [];
    const cols = ns.panelLogic.boardColumns(labels, String(globalThis.MEMDESK_BOARD_LABEL || ns.logic.DEFAULT_ROOT).trim());
    return cols.length ? cols : null;
  }

  // ── The calendar ─────────────────────────────────────────────────────
  //
  // Google Calendar and Google Tasks, read-only: the same short list of
  // reads the extension's worker allows (calendarLogic.isAllowedRequest),
  // side by side in one round trip.

  function googleMany(list) {
    const cal = ns.calendarLogic;
    const urls = (list || []).slice(0, BATCH_MAX).map(([service, path, query]) => {
      if (!cal.isAllowedRequest(service, 'GET', path)) {
        throw new Error(`not_allowed: ${service} ${path} is not something the calendar does.`);
      }
      return cal.buildUrl(service, path, query || null);
    });
    let allow = null;
    return gmail.getAll(urls).map(r => {
      if (!r || !r.error) return r;
      const e = r.error;
      // Not allowed (yet): the script was authorised before it asked for
      // the calendar, or the box was unticked on Google's page. Google
      // lets a script run with some of its permissions, and does not ask
      // again by itself, so the app offers the page that asks.
      if (e.status === 403 && /insufficient.*scope/i.test(e.detail || e.message)) {
        if (allow === null) allow = allowUrl();
        return { error: { code: 'calendar_scope', status: 403, url: allow, message: 'Not allowed for this app yet.' } };
      }
      return { error: { message: e.detail || e.message, status: e.status || 0 } };
    });
  }

  const CALENDAR_SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/tasks.readonly',
  ];

  // Google's page that asks for what the script has not been allowed:
  // for the calendar's two permissions if this Apps Script can say so,
  // otherwise for all of them. '' if there is none to give.
  function allowUrl() {
    const mode = ScriptApp.AuthMode.FULL;
    for (const ask of [() => ScriptApp.getAuthorizationInfo(mode, CALENDAR_SCOPES), () => ScriptApp.getAuthorizationInfo(mode)]) {
      try {
        const url = ask().getAuthorizationUrl();
        if (url) return String(url);
      } catch (err) { /* an older Apps Script: try the next */ }
    }
    return '';
  }

  // Run once from the script editor, if the app's Allow button is not
  // there or does not help: asks for every permission not yet given.
  function allowCalendar() {
    ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
    console.log('All permissions granted');
    return true;
  }

  // ── The app's settings ───────────────────────────────────────────────
  //
  // What the extension keeps in Chrome's synced storage (the column
  // layout, card titles, notes and colours), the app keeps in the
  // script's user properties: per Google account, and the same on every
  // phone and computer the app is opened on.

  const PREF = 'gkb.';
  const props = () => PropertiesService.getUserProperties();

  function prefsGet(keys) {
    const all = props().getProperties();
    const out = {};
    for (const k of Object.keys(all)) {
      if (!k.startsWith(PREF)) continue;
      const key = k.slice(PREF.length);
      if (keys && keys.indexOf(key) < 0) continue;
      try { out[key] = JSON.parse(all[k]); } catch (err) { /* not ours */ }
    }
    return out;
  }

  function prefsSet(items) {
    const out = {};
    for (const k of Object.keys(items || {})) {
      const text = JSON.stringify(items[k]);
      if (text.length > 8000) throw new Error('That is too much to keep in one setting.');
      out[PREF + k] = text;
    }
    props().setProperties(out);
    return true;
  }

  function prefsRemove(keys) {
    const p = props();
    for (const k of keys || []) p.deleteProperty(PREF + k);
    return true;
  }

  ns.app = {
    page, start, list, body, save, retire, restore, move, createFolder, renameFolder, deleteFolder,
    account, boardGmail, boardGmailMany, boardColumns, googleMany, allowCalendar, prefsGet, prefsSet, prefsRemove,
  };
})();

// ════ addon/src/triggers.js ═══════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Entry points
//
// Apps Script calls these by name - from the manifest, and from the
// cards' buttons, and from the phone app's google.script.run - so they
// are plain top-level functions. Each one hands over to the panel or
// the app.
// ─────────────────────────────────────────────────────────────────────

// The phone panel: an email opened (or none), and a column's button.
function onHomepage(e) { return gkb.panel.onHomepage(e); }
function onGmailMessage(e) { return gkb.panel.onGmailMessage(e); }
function onMoveThread(e) { return gkb.panel.onMoveThread(e); }

// The phone app: the page, and what its notes view asks of Gmail.
function doGet(e) { return gkb.app.page(e); }
function appStart(hint) { return gkb.app.start(hint); }
function appList(query) { return gkb.app.list(query); }
function appBody(messageId) { return gkb.app.body(messageId); }
function appSave(previousId, snap) { return gkb.app.save(previousId, snap); }
function appRetire(messageId) { return gkb.app.retire(messageId); }
function appRestore(messageId, folderId) { return gkb.app.restore(messageId, folderId); }
function appMove(messageId, folderId) { return gkb.app.move(messageId, folderId); }
function appCreateFolder(parentId, title) { return gkb.app.createFolder(parentId, title); }
function appRenameFolder(folderId, title) { return gkb.app.renameFolder(folderId, title); }
function appDeleteFolder(folderId) { return gkb.app.deleteFolder(folderId); }
function appAccount() { return gkb.app.account(); }
function appBoardGmail(method, path, query, body) { return gkb.app.boardGmail(method, path, query, body); }
function appBoardGmailMany(list) { return gkb.app.boardGmailMany(list); }
function appBoardColumns() { return gkb.app.boardColumns(); }
function appGoogleMany(list) { return gkb.app.googleMany(list); }

// For the script editor: run once to give the phone app its calendar
// permissions, if its Allow button does not.
function allowCalendar() { return gkb.app.allowCalendar(); }
function appPrefsGet(keys) { return gkb.app.prefsGet(keys); }
function appPrefsSet(items) { return gkb.app.prefsSet(items); }
function appPrefsRemove(keys) { return gkb.app.prefsRemove(keys); }

// ════ the phone app's page (addon/app, built) ════════════════════

var MEMDESK_APP_HTML = [
"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<base target=\"_top\">\n<style>\n  html, body { margin: 0; height: 100%; background: #f6f8fc; }\n  @media (prefers-color-scheme: dark) { html, body { background: #131314; } }\n</style>\n</head>\n<body>\n<div id=\"boot\" style=\"font: 16px/1.5 Roboto, Arial, sans-serif; color: #444746; padding: 24px;\">Loading&hellip;</div>\n<script>\n  (function () {\n    var problems = [];\n    function show(message, stack) {\n      var boot = document.getElementById('boot');\n      if (!boot) return;\n      problems.push(String(message) + (stack ? '\\n' + String(stack).split('\\n').slice(0, 6).join('\\n') : ''));\n      boot.style.color = '#b3261e';\n      boot.textContent = 'The app could not start.';\n      var pre = document.createElement('pre');\n      pre.style.cssText = 'white-space: pre-wrap; font-size: 12px; color: #444746;';\n      pre.textContent = problems.join('\\n\\n'",
");\n      boot.appendChild(pre);\n    }\n    window.addEventListener('error', function (e) {\n      show((e.message || 'unknown error') + (e.lineno ? ' (line ' + e.lineno + ')' : ''), e.error && e.error.stack);\n    });\n    window.addEventListener('unhandledrejection', function (e) {\n      show(String((e.reason && e.reason.message) || e.reason), e.reason && e.reason.stack);\n    });\n    window.__bootFailed = show;\n  })();\n</script>\n<script>\n(function () {\n  var MODULES = [[\"src/shared/ns.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNoYXJlZCBuYW1lc3BhY2UKLy8KLy8gQ29udGVudCBzY3JpcHRzIGFyZSBjbGFzc2ljIHNjcmlwdHMgdGhhdCBhbGwgcnVuIGluIG9uZSBpc29sYXRlZCB3b3JsZC4KLy8gVHdvIGZpbGVzIHRoYXQgZWFjaCBkZWNsYXJlZCBhIHRvcC1sZXZlbCBgY29uc3RgIG9mIHRoZSBzYW1lIG5hbWUgd291",
"bGQKLy8gY29sbGlkZSwgc28gZXZlcnkgZmlsZSB3cmFwcyBpdHNlbGYgaW4gYW4gSUlGRSBhbmQgaGFuZ3Mgd2hhdCBpdCBleHBvcnRzCi8vIG9mZiB0aGlzIG9uZSBvYmplY3QgaW5zdGVhZC4gVGhlIHNlcnZpY2Ugd29ya2VyIGFuZCB0aGUgb3B0aW9ucyBwYWdlCi8vIGxvYWQgdGhlIHNhbWUgZmlsZXMgYW5kIHNlZSB0aGUgc2FtZSBzaGFwZS4KLy8KLy8gQVBQX05BTUUgaXMgdGhlIG9ubHkgcGxhY2UgdGhlIGRpc3BsYXkgbmFtZSBsaXZlcyBpbiBjb2RlLiBOb3RoaW5nCi8vIGludGVybmFsIC0gdGhlIG5hbWVzcGFjZSwgc3RvcmFnZSBrZXlzLCBDU1MgY2xhc3NlcywgZWxlbWVudCBpZHMgLSBpcwovLyBkZXJpdmVkIGZyb20gaXQsIHNvIGEgcmVuYW1lIG5ldmVyIGhhcyB0byB0b3VjaCBzdG9yZWQgZGF0YS4gVGhlIFJFQURNRQovLyBsaXN0cyBldmVyeSBzcG90IHRoYXQgZG9lcyBjYXJyeSB0aGUgbmFtZS4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlz",
"LmdrYiB8fCB7fSk7CgogIGNvbnN0IEFQUF9OQU1FID0gJ01lbURlc2snOwogIC8vIFNob3duIGluIHRoZSBsb2dvJ3MgbWVudS4gVGhlIHNhbWUgYXMgbWFuaWZlc3QuanNvbidzIChhIHRlc3Qgc2F5cyBzbyksCiAgLy8gZm9yIHRoZSBwaG9uZSBhcHAgdG9vLCB3aGljaCBoYXMgbm8gbWFuaWZlc3QgdG8gcmVhZCBpdCBmcm9tLgogIGNvbnN0IEFQUF9WRVJTSU9OID0gJzAuMjMuMCc7CgogIC8vIOKUgOKUgCBTdG9yYWdlIGtleXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBLZXllZCBieSBsb3dlci1jYXNlZCBhY2NvdW50IGVtYWlsLCBiZWNhdXNlIGEgR21haWwgdGFiIGF0IC91LzEvIGlzIGEKICAvLyBkaWZmZXJlbnQgbWFpbGJveCB3aXRoIGRpZmZlcmVudCBsYWJlbHMsIGFuZCBvbmUgcGVyc29uJ3MgY29sdW1uCiAgLy8gbGF5b3V0IG11c3Qgbm90IGxlYWsgaW50byBhbm90aGVyIGFjY291bnQncyBib2FyZC4KCiAgY29uc3QgS0VZUyA9IHsKICAgIGNsaWVudElkOiAnY2xpZW50SWQnLCAgICAgICAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgZG9ja1Bvc2l0aW9uOiAnZG9ja1Bvc2l0aW9uJywgICAgICAgICAgICAgICAgLy8gc3Rv",
"cmFnZS5zeW5jCiAgICBjb2x1bW5zOiBlbWFpbCA9PiBgY29sdW1uczoke1N0cmluZyhlbWFpbCkudG9Mb3dlckNhc2UoKX1gLCAvLyBzdG9yYWdlLnN5bmMKICAgIG9yZGVyOiBlbWFpbCA9PiBgb3JkZXI6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgICAgIC8vIHN0b3JhZ2UubG9jYWwKICAgIC8vIENhcmQgZWRpdHMgZ2V0IG9uZSBrZXkgcGVyIGNhcmQgcmF0aGVyIHRoYW4gb25lIG1hcCBwZXIgYWNjb3VudDoKICAgIC8vIHN5bmMgY2FwcyBlYWNoIGl0ZW0gYXQgOCBLQiwgd2hpY2ggYSBzaW5nbGUgbWFwIHdvdWxkIG91dGdyb3cgYWZ0ZXIKICAgIC8vIGEgZmV3IGRvemVuIG5vdGVzLCB3aGlsZSB0aGUgNTEyLWl0ZW0gY2FwIGxlYXZlcyByb29tIGZvciBodW5kcmVkcy4KICAgIGNhcmRQcmVmaXg6IGVtYWlsID0-IGBjYXJkOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfTpgLCAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgY2FyZDogKGVtYWlsLCB0aHJlYWRJZCkgPT4gYGNhcmQ6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9OiR7dGhyZWFkSWR9YCwgLy8gc3RvcmFnZS5zeW5jCiAgICBub3RlczogZW1haWwgPT4gYG5vdGVzOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsICAgICAvLyBzdG9yYWdlLnN5bmM6IHsgbGFiZWwsIGxhYmVsSWQgfQogICAgdmlldzogJ3ZpZXcnLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5s",
"b2NhbDogJ2JvYXJkJyB8ICdub3RlcycKICAgIHByZWY6IChlbWFpbCwgbmFtZSkgPT4gYHByZWY6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9OiR7bmFtZX1gLCAvLyBzdG9yYWdlLmxvY2FsOiB0aGUgbm90ZXMnIHNtYWxsIHByZWZlcmVuY2VzCiAgICB0b2tlbjogZW1haWwgPT4gYHRva2VuOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsICAgICAvLyBzdG9yYWdlLnNlc3Npb24KICAgIGNhbGVuZGFyVG9rZW46IGVtYWlsID0-IGBjdG9rZW46JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgLy8gc3RvcmFnZS5zZXNzaW9uOiB0aGUgY2FsZW5kYXIncyBvd24gc2lnbi1pbgogICAgZ21haWxUYWJzOiAnZ21haWxUYWJzJywgICAgICAgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5zZXNzaW9uCiAgfTsKCiAgLy8gRWxlbWVudCBpZHMgZm9yIHRoZSB0d28gc2hhZG93IGhvc3RzLiBTaG9ydCBhbmQgbmFtZXNwYWNlZCByYXRoZXIgdGhhbgogIC8vIGJyYW5kZWQsIHNvIHRoZXkgc3Vydml2ZSBhIHJlbmFtZSBhbmQgYXJlIHVubGlrZWx5IHRvIGNsYXNoIHdpdGggR21haWwuCiAgY29uc3QgSE9TVF9JRFMgPSB7CiAgICBib2FyZDogJ2drYi1ib2FyZC1ob3N0JywKICAgIGRvY2s6ICdna2ItZG9jay1ob3N0JywKICB9OwoKICAvLyBUaGUgcHVibGlzaGVyJ3Mgb3duIE9BdXRoIGNsaWVudCwgZm9yIHRoZSBidWlsZCB0aGF0IGdvZXMgdG8gdGhlCiAgLy8gQ2hyb21lIFdlYiBTdG9yZTogd2l0",
"aCBpdCwgYSB1c2VyIGp1c3QgY2xpY2tzICJDb25uZWN0IEdtYWlsIiBhbmQgbmVlZHMKICAvLyBubyBHb29nbGUgQ2xvdWQgcHJvamVjdCBvZiB0aGVpciBvd24uIEVtcHR5IGhlcmUsIG9uIHB1cnBvc2U6CiAgLy8gdG9vbHMvcGFja2FnZS1leHRlbnNpb24ubWpzIHdyaXRlcyBpdCBpbnRvIHRoZSBzdG9yZSBidWlsZCBvbmx5LCBzbyBhCiAgLy8gY29weSBsb2FkZWQgZnJvbSB0aGlzIHJlcG9zaXRvcnkgKG9yIGEgZm9yaykgYnJpbmdzIGl0cyBvd24gY2xpZW50LAogIC8vIGFzIFNFVFVQLm1kIGRlc2NyaWJlcywgcmF0aGVyIHRoYW4gdXNpbmcgdXAgdGhlIHB1Ymxpc2hlcidzIHF1b3RhIG9mCiAgLy8gdXNlcnMuIEEgY2xpZW50IElEIHNhdmVkIG9uIHRoZSBzZXR1cCBwYWdlIGFsd2F5cyB3aW5zLgogIGNvbnN0IEJVSUxUX0lOX0NMSUVOVF9JRCA9ICcnOwoKICBucy5BUFBfTkFNRSA9IEFQUF9OQU1FOwogIG5zLkFQUF9WRVJTSU9OID0gQVBQX1ZFUlNJT047CiAgbnMuQlVJTFRfSU5fQ0xJRU5UX0lEID0gQlVJTFRfSU5fQ0xJRU5UX0lEOwogIG5zLktFWVMgPSBLRVlTOwogIG5zLkhPU1RfSURTID0gSE9TVF9JRFM7CgogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgewogICAgbW9kdWxlLmV4cG9ydHMgPSB7IEFQUF9OQU1FLCBBUFBfVkVSU0lPTiwgS0VZUywgSE9TVF9JRFMgfTsKICB9Cn0pKCk7Cg\"],[\"src/lib/util.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNtYWxsIHB1cmUgaGVscGVycwovLwovLyBOb3RoaW5nIGluIGhlcmUgdG91Y2hlcyB0aGUgRE9NLCBjaHJvbWUuKiBvciB0aGUgbmV0d29yaywgd2hpY2ggaXMgd2hhdAovLyBsZXRzIHRoZSBOb2RlIHRlc3RzIHJlcXVpcmUgdGhpcyBmaWxlIGRpcmVjdGx5LiBUaGUgY29udGVudCBzY3JpcHRzIGFuZAovLyB0aGUgc2VydmljZSB3b3JrZXIgcmVhY2ggdGhlIHNhbWUgZnVuY3Rpb25zIHRocm91Z2ggdGhlIHNoYXJlZAovLyBuYW1lc3BhY2UgKG5zLnV0aWwpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt",
"9KTsKCiAgLy8g4pSA4pSAIEhlYWRlciBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBoZWFkZXJNYXAobWVzc2FnZSkgewogICAgY29uc3Qgb3V0ID0ge307CiAgICBjb25zdCBoZWFkZXJzID0gKG1lc3NhZ2UgJiYgbWVzc2FnZS5wYXlsb2FkICYmIG1lc3NhZ2UucGF5bG9hZC5oZWFkZXJzKSB8fCBbXTsKICAgIGZvciAoY29uc3QgaCBvZiBoZWFkZXJzKSBvdXRbaC5uYW1lLnRvTG93ZXJDYXNlKCldID0gaC52YWx1ZSB8fCAnJzsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyAiQW5uYSBWb3MgPGFubmFAZXhhbXBsZS5jb20-IiDihpIgeyBuYW1lLCBlbWFpbCB9CiAgZnVuY3Rpb24gcGFyc2VBZGRyZXNzKHJhdykgewogICAgaWYgKCFyYXcpIHJldHVybiB7IG5hbWU6ICcnLCBlbWFpbDogJycgfTsKICAgIGNvbnN0IGFuZ2xlZCA9IHJhdy5tYXRjaCgvXlxzKiguKj8pXHMqPChbXj5dKyk-XHMqJC8pOwogICAgaWYgKGFuZ2xlZCkgewogICAgICByZXR1cm4gewogICAgICAgIG5hbWU6IGFuZ2xlZFsxXS5yZXBsYWNlKC9eWyInXXxbIiddJC9nLCAnJykudHJpbSgpLAogICAgICAgIGVtYWlsOiBhbmdsZWRbMl0udHJpbSgpLnRvTG93ZXJDYXNlKCksCiAgICA",
"gIH07CiAgICB9CiAgICByZXR1cm4geyBuYW1lOiAnJywgZW1haWw6IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKSB9OwogIH0KCiAgLy8gV2hhdCB0byBjYWxsIGEgc2VuZGVyIG9uIGEgY2FyZC4gQSBiYXJlIGFkZHJlc3MgaXMgc2hvcnRlbmVkIHRvIGl0cwogIC8vIGxvY2FsIHBhcnQsIGJlY2F1c2UgImFjY291bnRzIiByZWFkcyBiZXR0ZXIgaW4gYSBuYXJyb3cgY29sdW1uIHRoYW4KICAvLyAiYWNjb3VudHNAYnJpZ2h0d2F0ZXItbGFuZ3VhZ2UuZXhhbXBsZSIuCiAgZnVuY3Rpb24gZGlzcGxheU5hbWUoYWRkcikgewogICAgaWYgKCFhZGRyKSByZXR1cm4gJyc7CiAgICBpZiAoYWRkci5uYW1lKSByZXR1cm4gYWRkci5uYW1lOwogICAgcmV0dXJuIChhZGRyLmVtYWlsIHx8ICcnKS5zcGxpdCgnQCcpWzBdOwogIH0KCiAgLy8g4pSA4pSAIEVudGl0aWVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gR21haWwgcmV0dXJucyBzbmlwcGV0cyBIVE1MLWVuY29kZWQuIFRoZSBvYnZpb3VzIGRlY29kZXIgLSBhc3NpZ24gdG8gYQogIC8vIGRldGFjaGVkIGVsZW1lbnQncyBpbm5lckhUTUwgYW5kIHJlYWQgdGV4dENvbnRlbnQgYmFjayAtIGlzIHd",
"oYXQKICAvLyBHbWFpbCdzIFRydXN0ZWQgVHlwZXMgcG9saWN5IGZvcmJpZHMsIGFuZCBpdCB3b3VsZCBhbHNvIG1lYW4gZmVlZGluZwogIC8vIHVudHJ1c3RlZCBtYWlsIHRleHQgdG8gdGhlIEhUTUwgcGFyc2VyLiBBIGxvb2t1cCB0YWJsZSBkb2VzIHRoZSBqb2IuCgogIC8vIFRoZSBoYW5kZnVsIGV2ZXJ5IG1haWwgbmVlZHMsIHBsdXMgdGhlIHR5cG9ncmFwaGljIG9uZXMgdGhhdCBIVE1MCiAgLy8gbWFpbCB3cml0dGVuIGluIEdtYWlsIG9yIE91dGxvb2sgaXMgZnVsbCBvZi4KICBjb25zdCBOQU1FRCA9IHsKICAgIGFtcDogJyYnLCBsdDogJzwnLCBndDogJz4nLCBxdW90OiAnIicsIGFwb3M6ICInIiwgbmJzcDogJ1x1MDBhMCcsCiAgICBsc3F1bzogJ1x1MjAxOCcsIHJzcXVvOiAnXHUyMDE5JywgbGRxdW86ICdcdTIwMWMnLCByZHF1bzogJ1x1MjAxZCcsCiAgICBuZGFzaDogJ1x1MjAxMycsIG1kYXNoOiAnXHUyMDE0JywgaGVsbGlwOiAnXHUyMDI2JywgYnVsbDogJ1x1MjAyMicsIG1pZGRvdDogJ1x1MDBiNycsCiAgICBsYXF1bzogJ1x1MDBhYicsIHJhcXVvOiAnXHUwMGJiJywgZXVybzogJ1x1MjBhYycsIHBvdW5kOiAnXHUwMGEzJywgY29weTogJ1x1MDBhOScsIHJlZzogJ1x1MDBhZScsIHRyYWRlOiAnXHUyMTIyJywKICB9OwoKICBmdW5jdGlvbiBkZWNvZGVFbnRpdGllcyhpbnB1dCkgewogICAgLy8gU2luZ2xlIHBhc3MsIHNvICImYW1wO2x0OyIgYmVjb21lcyB0aGUgbGl0ZXJhbCB0ZXh0ICImbHQ7IiB",
"hbmQgaXMKICAgIC8vIG5vdCBkZWNvZGVkIGEgc2Vjb25kIHRpbWUgaW50byAiPCIuCiAgICByZXR1cm4gU3RyaW5nKGlucHV0ID09IG51bGwgPyAnJyA6IGlucHV0KS5yZXBsYWNlKAogICAgICAvJigjW3hYXVswLTlhLWZBLUZdezEsNn18I1swLTldezEsN318W2EtekEtWl0rKTsvZywKICAgICAgKHdob2xlLCBib2R5KSA9PiB7CiAgICAgICAgaWYgKGJvZHlbMF0gPT09ICcjJykgewogICAgICAgICAgY29uc3QgaGV4ID0gYm9keVsxXSA9PT0gJ3gnIHx8IGJvZHlbMV0gPT09ICdYJzsKICAgICAgICAgIGNvbnN0IGNvZGUgPSBwYXJzZUludChib2R5LnNsaWNlKGhleCA_IDIgOiAxKSwgaGV4ID8gMTYgOiAxMCk7CiAgICAgICAgICAvLyBPdXQtb2YtcmFuZ2UgYW5kIHN1cnJvZ2F0ZSBjb2RlIHBvaW50cyB3b3VsZCB0aHJvdyBvciBwcm9kdWNlCiAgICAgICAgICAvLyBnYXJiYWdlOyBsZWF2ZSB0aGUgb3JpZ2luYWwgdGV4dCBhbG9uZSBpbnN0ZWFkLgogICAgICAgICAgaWYgKCFpc0Zpbml0ZShjb2RlKSB8fCBjb2RlIDwgMSB8fCBjb2RlID4gMHgxMGZmZmYgfHwKICAgICAgICAgICAgICAoY29kZSA-PSAweGQ4MDAgJiYgY29kZSA8PSAweGRmZmYpKSByZXR1cm4gd2hvbGU7CiAgICAgICAgICByZXR1cm4gU3RyaW5nLmZyb21Db2RlUG9pbnQoY29kZSk7CiAgICAgICAgfQogICAgICAgIGNvbnN0IG5hbWVkID0gTkFNRURbYm9keS50b0xvd2VyQ2FzZSgpXTsKICAgICAgICByZXR1cm4gbmFtZWQgPT09IHVuZGVmaW5",
"lZCA_IHdob2xlIDogbmFtZWQ7CiAgICAgIH0KICAgICk7CiAgfQoKICAvLyDilIDilIAgQWNjb3VudCBkZXRlY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IEVNQUlMX09OTFlfUkUgPSAvXlteXHNAPD4oKSJdK0BbXlxzQDw-KCkiXStcLlteXHNAPD4oKSJdKyQvOwogIGNvbnN0IEVNQUlMX0FOWV9SRSA9IC9bXlxzQDw-KCkiXStAW15cc0A8PigpIl0rXC5bXlxzQDw-KCkiXSsvOwoKICAvLyBHbWFpbCdzIHRpdGxlIGlzICI8dmlldyBvciBzdWJqZWN0PiAtIDxhY2NvdW50PiAtIDxwcm9kdWN0PiIsIGUuZy4KICAvLyAiSW5ib3ggKDMsNTkxKSAtIHNvbWVvbmVAZXhhbXBsZS5jb20gLSBHbWFpbCIuIFdvcmtzcGFjZSBhY2NvdW50cyBjYW4KICAvLyByZXBsYWNlICJHbWFpbCIgd2l0aCB0aGUgb3JnYW5pc2F0aW9uJ3Mgb3duIG5hbWUsIHNvIHRoZSBwcm9kdWN0IHBhcnQKICAvLyBpcyBub3QgbWF0Y2hlZC4gU2Nhbm5pbmcgZnJvbSB0aGUgcmlnaHQgZmluZHMgdGhlIGFjY291bnQgZXZlbiB3aGVuIGEKICAvLyBzdWJqZWN0IGxpbmUgY29udGFpbnMgYW4gYWRkcmVzcyBvciBhIGRhc2ggb2YgaXRzIG93bi4KICBmdW5jdGlvbiBhY2NvdW50RnJvbVRpdGxlKHRpdGxlKSB7CiAgICB",
"jb25zdCBwYXJ0cyA9IFN0cmluZyh0aXRsZSB8fCAnJykuc3BsaXQoL1xzWy3igJPigJRdXHMvKTsKICAgIGZvciAobGV0IGkgPSBwYXJ0cy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkgewogICAgICBjb25zdCBwID0gcGFydHNbaV0udHJpbSgpOwogICAgICBpZiAoRU1BSUxfT05MWV9SRS50ZXN0KHApKSByZXR1cm4gcC50b0xvd2VyQ2FzZSgpOwogICAgfQogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gIkdvb2dsZSBBY2NvdW50OiBBbm5hIFZvcyAgKGFubmFAZXhhbXBsZS5jb20pIiDihpIgImFubmFAZXhhbXBsZS5jb20iCiAgZnVuY3Rpb24gYWNjb3VudEZyb21BcmlhTGFiZWwobGFiZWwpIHsKICAgIGNvbnN0IG0gPSBTdHJpbmcobGFiZWwgfHwgJycpLm1hdGNoKEVNQUlMX0FOWV9SRSk7CiAgICByZXR1cm4gbSA_IG1bMF0ucmVwbGFjZSgvWykuLDtdKyQvLCAnJykudG9Mb3dlckNhc2UoKSA6ICcnOwogIH0KCiAgLy8gIi9tYWlsL3UvMS8iIOKGkiAxLiBEZWZhdWx0cyB0byAwLCB3aGljaCBpcyB3aGF0IC9tYWlsLyBhbG9uZSBtZWFucy4KICBmdW5jdGlvbiBhY2NvdW50SW5kZXhGcm9tUGF0aChwYXRobmFtZSkgewogICAgY29uc3QgbSA9IFN0cmluZyhwYXRobmFtZSB8fCAnJykubWF0Y2goL1wvbWFpbFwvdVwvKFxkKylcLy8pOwogICAgcmV0dXJuIG0gPyBOdW1iZXIobVsxXSkgOiAwOwogIH0KCiAgLy8g4pSA4pSAIERhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTW9udGggYW5kIGRheSBuYW1lcyBhcmUgc3BlbGxlZCBvdXQgaGVyZSByYXRoZXIgdGhhbiB0YWtlbiBmcm9tCiAgLy8gSW50bCwgc28gYSBjYXJkIHJlYWRzIHRoZSBzYW1lIHdoYXRldmVyIHRoZSBicm93c2VyIGxvY2FsZSBpcyBhbmQKICAvLyB0aGUgdGVzdHMgZG8gbm90IGRlcGVuZCBvbiB0aGUgbWFjaGluZSB0aGV5IHJ1biBvbi4KCiAgY29uc3QgTU9OVEhTID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsCiAgICAgICAgICAgICAgICAgICdKdWwnLCAnQXVnJywgJ1NlcCcsICdPY3QnLCAnTm92JywgJ0RlYyddOwogIGNvbnN0IERBWVMgPSBbJ1N1bicsICdNb24nLCAnVHVlJywgJ1dlZCcsICdUaHUnLCAnRnJpJywgJ1NhdCddOwoKICBmdW5jdGlvbiBzdGFydE9mRGF5KG1zKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUobXMpOwogICAgcmV0dXJuIG5ldyBEYXRlKGQuZ2V0RnVsbFllYXIoKSwgZC5nZXRNb250aCgpLCBkLmdldERhdGUoKSkuZ2V0VGltZSgpOwogIH0KCiAgLy8gQ29tcGFjdCBhZ2UgZm9yIGEgY2FyZDogImp1c3Qgbm93IiwgIjEyIG1pbiIsICIzIGgiLCAiWWVzdGVyZGF5IiwKICAvLyAiTW9uIiwgIjMgU2V",
"wIiwgIjMgU2VwIDIwMjQiLiBIb3VycyB3aW4gb3ZlciAiWWVzdGVyZGF5IiBmb3IgYW55dGhpbmcKICAvLyB1bmRlciBhIGRheSBvbGQsIGJlY2F1c2UgIjIgaCIgaXMgbW9yZSB1c2VmdWwgYXQgMWFtIHRoYW4gIlllc3RlcmRheSIuCiAgZnVuY3Rpb24gcmVsYXRpdmVEYXRlKHRzLCBub3cgPSBEYXRlLm5vdygpKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fCAhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBub3cgLSB0KTsKICAgIGNvbnN0IG1pbiA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgIGlmIChtaW4gPCAxKSByZXR1cm4gJ2p1c3Qgbm93JzsKICAgIGlmIChtaW4gPCA2MCkgcmV0dXJuIGAke21pbn0gbWluYDsKICAgIGNvbnN0IGhvdXJzID0gTWF0aC5mbG9vcihtaW4gLyA2MCk7CiAgICBpZiAoaG91cnMgPCAyNCkgcmV0dXJuIGAke2hvdXJzfSBoYDsKCiAgICAvLyBDYWxlbmRhciBkYXlzLCBub3QgMjQtaG91ciBibG9ja3MsIHNvICJZZXN0ZXJkYXkiIG1lYW5zIHllc3RlcmRheS4KICAgIGNvbnN0IGRheXMgPSBNYXRoLnJvdW5kKChzdGFydE9mRGF5KG5vdykgLSBzdGFydE9mRGF5KHQpKSAvIDg2NDAwMDAwKTsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGlmIChkYXlzIDw9IDEpIHJldHVybiAnWWVzdGVyZGF5JzsKICAgIGlmIChkYXlzIDwgNykgcmV0dXJuIERBWVNbZC5nZXREYXkoKV07CiAgICBjb25",
"zdCBkbSA9IGAke2QuZ2V0RGF0ZSgpfSAke01PTlRIU1tkLmdldE1vbnRoKCldfWA7CiAgICByZXR1cm4gZC5nZXRGdWxsWWVhcigpID09PSBuZXcgRGF0ZShub3cpLmdldEZ1bGxZZWFyKCkgPyBkbSA6IGAke2RtfSAke2QuZ2V0RnVsbFllYXIoKX1gOwogIH0KCiAgLy8gRnVsbCBkYXRlIGZvciBhIHRvb2x0aXA6ICJUdWUgMyBTZXAgMjAyNiwgMTQ6MDUiLgogIGZ1bmN0aW9uIGZ1bGxEYXRlKHRzKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fCAhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGNvbnN0IHBhZCA9IG4gPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgICByZXR1cm4gYCR7REFZU1tkLmdldERheSgpXX0gJHtkLmdldERhdGUoKX0gJHtNT05USFNbZC5nZXRNb250aCgpXX0gJHtkLmdldEZ1bGxZZWFyKCl9LCBgICsKICAgICAgICAgICBgJHtwYWQoZC5nZXRIb3VycygpKX06JHtwYWQoZC5nZXRNaW51dGVzKCkpfWA7CiAgfQoKICAvLyBGb3IgInVwZGF0ZWQgWHMgYWdvIiBpbiB0aGUgYm9hcmQgaGVhZGVyLgogIGZ1bmN0aW9uIGFnb1RleHQobXMpIHsKICAgIGNvbnN0IHMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKE51bWJlcihtcykgLyAxMDAwKSk7CiAgICBpZiAocyA8IDUpIHJldHVybiAnanVzdCBub3cnOwogICAgaWYgKHMgPCA2MCkgcmV0dXJuIGAke3N9cyBhZ29gOwogICAgY29uc3QgbSA9IE1hdGguZmx",
"vb3IocyAvIDYwKTsKICAgIGlmIChtIDwgNjApIHJldHVybiBgJHttfSBtaW4gYWdvYDsKICAgIHJldHVybiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9IGggYWdvYDsKICB9CgogIC8vIOKUgOKUgCBDb25jdXJyZW5jeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUnVucyBmbiBvdmVyIGl0ZW1zIHdpdGggYXQgbW9zdCBgbGltaXRgIGluIGZsaWdodC4gR21haWwncyBwZXItdXNlcgogIC8vIHF1b3RhIGlzIGdlbmVyb3VzLCBidXQgYSBib2FyZCBvZiAxMDAgY2hhbmdlZCB0aHJlYWRzIGZpcmVkIGF0IG9uY2UKICAvLyBzdGlsbCB0cmlwcyBpdHMgYnVyc3QgbGltaXRlcjsgc2l4IGF0IGEgdGltZSBrZWVwcyBhIGNvbGQgbG9hZCBxdWljawogIC8vIHdpdGhvdXQgcHJvdm9raW5nIDQyOXMuIFRoZSBmaXJzdCByZWplY3Rpb24gc3RvcHMgbmV3IHdvcmsgc3RhcnRpbmcKICAvLyBhbmQgaXMgcmUtdGhyb3duLCBzbyBhbiBhdXRoIGZhaWx1cmUgZG9lcyBub3QgZmFuIG91dCBpbnRvIDEwMCBtb3JlLgogIGFzeW5jIGZ1bmN0aW9uIG1hcFBvb2woaXRlbXMsIGxpbWl0LCBmbikgewogICAgY29uc3QgcmVzdWx0cyA9IG5ldyBBcnJheShpdGVtcy5sZW5ndGgpOwogICAgbGV",
"0IG5leHQgPSAwOwogICAgbGV0IGZhaWxlZCA9IG51bGw7CiAgICBhc3luYyBmdW5jdGlvbiB3b3JrZXIoKSB7CiAgICAgIHdoaWxlIChmYWlsZWQgPT09IG51bGwgJiYgbmV4dCA8IGl0ZW1zLmxlbmd0aCkgewogICAgICAgIGNvbnN0IGkgPSBuZXh0Kys7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHJlc3VsdHNbaV0gPSBhd2FpdCBmbihpdGVtc1tpXSwgaSk7CiAgICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgICBpZiAoZmFpbGVkID09PSBudWxsKSBmYWlsZWQgPSBlcnI7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBjb25zdCBuID0gTWF0aC5tYXgoMSwgTWF0aC5taW4obGltaXQsIGl0ZW1zLmxlbmd0aCkpOwogICAgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogbiB9LCB3b3JrZXIpKTsKICAgIGlmIChmYWlsZWQgIT09IG51bGwpIHRocm93IGZhaWxlZDsKICAgIHJldHVybiByZXN1bHRzOwogIH0KCiAgY29uc3QgYXBpID0gewogICAgaGVhZGVyTWFwLCBwYXJzZUFkZHJlc3MsIGRpc3BsYXlOYW1lLCBkZWNvZGVFbnRpdGllcywKICAgIGFjY291bnRGcm9tVGl0bGUsIGFjY291bnRGcm9tQXJpYUxhYmVsLCBhY2NvdW50SW5kZXhGcm9tUGF0aCwKICAgIHJlbGF0aXZlRGF0ZSwgZnVsbERhdGUsIGFnb1RleHQsIG1hcFBvb2wsCiAgfTsKCiAgbnMudXRpbCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHB",
"vcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/notes-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGVzIGxvZ2ljIChwdXJlKQovLwovLyBBIG5vdGUgaXMgYW4gZW1haWwgdGhhdCB3YXMgbmV2ZXIgc2VudDogYSBtZXNzYWdlIHBsYWNlZCBzdHJhaWdodCBpbnRvCi8vIHRoZSB1c2VyJ3Mgb3duIG1haWxib3ggd2l0aCBtZXNzYWdlcy5pbnNlcnQsIGNhcnJ5aW5nIHRoZSBOb3RlcyBsYWJlbAovLyBhbmQgbm90aGluZyBlbHNlIC0gbm90IElOQk9YLCBub3QgVU5SRUFEIC0gc28gaXQgc3RheXMgb3V0IG9mIHRoZSB3YXkKLy8gdW50aWwgbG9va2VkIGZvciwgYW5kIEdtYWlsJ3Mgb3duIHNlYXJjaCBmaW5kcyBpdC4KLy8KLy8gR21haWwgbWVzc2FnZXMgY2Fubm90IGJlIGNoYW5nZWQgb25jZSBzdG9yZWQsIHNvIHNhdmluZyBhIG5vdGUgaW5zZXJ0cwovLyBhIG5ldyBtZXNzYWdlIGFuZCBtb3ZlcyB0aGUgcHJldmlvdXMgb25lIHRvIFRyYXNoLiBFYWNoIG5vdGUgY2FycmllcyBhCi8vIHN0YWJsZSBpZCBpbiBhbiBYLUdrYi1Ob3RlIGhlYWRlciwgd2hpY2ggaXMgaG",
"93IGl0cyB2ZXJzaW9ucyBhcmUgdGllZAovLyB0b2dldGhlciBhbmQgLSBqdXN0IGFzIGltcG9ydGFudCAtIGhvdyB0aGUgYmFja2dyb3VuZCB3b3JrZXIgdGVsbHMgYQovLyBub3RlIGZyb20gcmVhbCBtYWlsOiBpdCB3aWxsIG9ubHkgaW5zZXJ0IG1lc3NhZ2VzIHRoYXQgY2FycnkgdGhlIGhlYWRlcgovLyBhbmQgb25seSB0cmFzaCBtZXNzYWdlcyB0aGF0IGFscmVhZHkgZG8uCi8vCi8vIExvYWRlZCBieSB0aGUgY29udGVudCBzY3JpcHRzLCB0aGUgc2VydmljZSB3b3JrZXIgYW5kIE5vZGUncyB0ZXN0cy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IE5PVEVfSEVBREVSID0gJ1gtR2tiLU5vdGUnOwogIGNvbnN0IERFRkFVTFRfTEFCRUwgPSAnX05vdG",
"VzJzsKICAvLyAuaW52YWxpZCBpcyByZXNlcnZlZCBhbmQgY2FuIG5ldmVyIGJlIGRlbGl2ZXJlZCB0bywgc28gbm90aGluZyBjYW4KICAvLyBldmVyIGFycml2ZSBmcm9tIG9yIGdvIHRvIHRoaXMgYWRkcmVzcy4KICBjb25zdCBOT1RFX1NFTkRFUiA9ICciTm90ZXMiIDxub3Rlc0Bub3Rlcy5pbnZhbGlkPic7CgogIC8vIEdlbmVyb3VzIGZvciB0eXBlZCBub3RlcywgYW5kIGtlZXBzIG9uZSBzYXZlIGNvbWZvcnRhYmx5IGluc2lkZSB3aGF0CiAgLy8gdGhlIG5vbi11cGxvYWQgaW5zZXJ0IGVuZHBvaW50IGFuZCBhIHJ1bnRpbWUgbWVzc2FnZSB3aWxsIGNhcnJ5LgogIGNvbnN0IE1BWF9CT0RZID0gMTAwMDAwOwogIGNvbnN0IE1BWF9USVRMRSA9IDMwMDsKCiAgLy8gTGFiZWxzIGEgbm90ZSBtYXkgbmV2ZXIgYmUgaW5zZXJ0ZWQgd2l0aC4gQSBub3RlIGluIHRoZSBJbmJveCwgb3IKICAvLyBkcmVzc2VkIHVwIGFzIHNlbnQgb3IgZHJhZnQgbWFpbCwgaXMgbm8gbG9uZ2VyIG91dCBvZiB0aGUgd2F5IC0gYW5kCiAgLy8gbm90aGluZyBoZXJlIHNob3VsZCBldmVyIGJlIGFibGUgdG8gcHV0IG1haWwgaW50byBTcGFtIG9yIFRyYXNoLgogIGNvbnN0IEZPUkJJRERFTl9JTlNFUlRfTEFCRUxTID0gbmV3IFNldChbJ0lOQk9YJywgJ1NFTlQnLCAnRFJBRlQnLCAnU1BBTScsICdUUkFTSCcsICdVTlJFQUQnXSk7CgogIC8vIOKUgOKUgCBJZHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IElEX1JFID0gL15bYS16MC05XXsxMiw0MH0kLzsKCiAgZnVuY3Rpb24gbmV3Tm90ZUlkKHJhbmQgPSBuID0-IGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKSB7CiAgICByZXR1cm4gQXJyYXkuZnJvbShyYW5kKDEyKSwgYiA9PiBiLnRvU3RyaW5nKDM2KS5wYWRTdGFydCgyLCAnMCcpLnNsaWNlKC0yKSkuam9pbignJykuc2xpY2UoMCwgMjApOwogIH0KCiAgLy8gVGhlIHNjcmF0Y2hwYWQ6IG9uZSBub3RlIHdpdGggYSBmaXhlZCBpZCwgc28gdGhhdCBldmVyeSBjb21wdXRlciBhbmQKICAvLyBwaG9uZSBmaW5kcyAtIGFuZCBzYXZlcyBpbnRvIC0gdGhlIHNhbWUgb25lLgogIGNvbnN0IFNDUkFUQ0hQQURfSUQgPSAnc2NyYXRjaHBhZDAwMDAwMCc7CiAgY29uc3QgU0NSQVRDSFBBRF9USVRMRSA9ICdTY3JhdGNocGFkJzsKCiAgLy8gVGhlIGlkIGEgc2F2ZSB3cml0ZXMgdW5kZXI6IHRoZSBub3RlJ3Mgb3duLCBvbmNlIGl0IGhhcyBvbmU7IGZvciBhCiAgLy8gZmlyc3Qgc2F2ZSwgdGhlIHNjcmF0Y2hwYWQncyBpZiB0aGF0IGlzIHdoYXQgaXMgYmVpbmcgc2F2ZWQsIGFuZAogIC8vIG90aGVyd2lzZSBhIG5ldyBvbmUuIE5vIG90aG",
"VyIGlkIGNhbiBiZSBhc2tlZCBmb3IuCiAgZnVuY3Rpb24gbm90ZUlkRm9yKHByZXZpb3VzLCB3YW50ZWQpIHsKICAgIGlmIChwcmV2aW91cyAmJiBwcmV2aW91cy5vd24gJiYgSURfUkUudGVzdChTdHJpbmcocHJldmlvdXMubm90ZUlkIHx8ICcnKSkpIHJldHVybiBwcmV2aW91cy5ub3RlSWQ7CiAgICByZXR1cm4gd2FudGVkID09PSBTQ1JBVENIUEFEX0lEID8gU0NSQVRDSFBBRF9JRCA6IG5ld05vdGVJZCgpOwogIH0KCiAgLy8g4pSA4pSAIEVuY29kaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBieXRlc1RvQmluYXJ5KGJ5dGVzKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIHsKICAgICAgb3V0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCwgYnl0ZXMuc3ViYXJyYXkoaSwgaSArIDB4ODAwMCkpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJpbmFyeVRvQnl0ZXMoYmluKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmluLmxlbm",
"d0aDsgaSsrKSBvdXRbaV0gPSBiaW4uY2hhckNvZGVBdChpKSAmIDB4ZmY7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgdXRmOFRvQmFzZTY0ID0gcyA9PiBidG9hKGJ5dGVzVG9CaW5hcnkobmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHMpKSk7CgogIGZ1bmN0aW9uIGJhc2U2NFVybEVuY29kZShiaW5hcnkpIHsKICAgIHJldHVybiBidG9hKGJpbmFyeSkucmVwbGFjZSgvXCsvZywgJy0nKS5yZXBsYWNlKC9cLy9nLCAnXycpLnJlcGxhY2UoLz0rJC8sICcnKTsKICB9CgogIGZ1bmN0aW9uIGJhc2U2NFVybERlY29kZShzKSB7CiAgICBjb25zdCBiNjQgPSBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvLS9nLCAnKycpLnJlcGxhY2UoL18vZywgJy8nKS5yZXBsYWNlKC9ccysvZywgJycpOwogICAgcmV0dXJuIGF0b2IoYjY0ICsgJz0nLnJlcGVhdCgoNCAtIChiNjQubGVuZ3RoICUgNCkpICUgNCkpOwogIH0KCiAgLy8gVGV4dCBpbiB3aGF0ZXZlciBjaGFyc2V0IHRoZSBwYXJ0IGRlY2xhcmVkLiBBbiB1bmtub3duIG9yIG1pc2xhYmVsbGVkCiAgLy8gY2hhcnNldCBmYWxscyBiYWNrIHRvIFVURi04IHJhdGhlciB0aGFuIGZhaWxpbmcgdGhlIHdob2xlIG5vdGUuCiAgZnVuY3Rpb24gZGVjb2RlQnl0ZXMoYnl0ZXMsIGNoYXJzZXQpIHsKICAgIHRyeSB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoY2hhcnNldCB8fCAndXRmLTgnKS5kZWNvZGUoYnl0ZXMpOwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiBuZX",
"cgVGV4dERlY29kZXIoJ3V0Zi04JykuZGVjb2RlKGJ5dGVzKTsKICAgIH0KICB9CgogIC8vIFJGQyAyMDQ3IGVuY29kZWQgd29yZHMsIGZvciBhIHN1YmplY3QgdGhhdCBpcyBub3QgcGxhaW4gQVNDSUkuIEF0IDM5CiAgLy8gYnl0ZXMgYSB3b3JkLCBldmVuIHRoZSBmaXJzdCBsaW5lICgiU3ViamVjdDogIiBhbmQgb25lIHdvcmQpIHN0YXlzCiAgLy8gdW5kZXIgNzggY2hhcmFjdGVycywgYW5kIG5vIGNoYXJhY3RlciBpcyBzcGxpdCBhY3Jvc3MgdHdvIHdvcmRzLAogIC8vIHdoaWNoIHNvbWUgcmVhZGVycyB3b3VsZCBzaG93IGFzIHR3byBicm9rZW4gaGFsdmVzLgogIGZ1bmN0aW9uIGVuY29kZUhlYWRlclRleHQodGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICgvXltceDIwLVx4N2VdKiQvLnRlc3QocykpIHJldHVybiBzOwogICAgY29uc3Qgd29yZHMgPSBbXTsKICAgIGxldCBjaHVuayA9ICcnOwogICAgbGV0IGJ5dGVzID0gMDsKICAgIGZvciAoY29uc3QgY2ggb2YgcykgewogICAgICBjb25zdCBuID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGNoKS5sZW5ndGg7CiAgICAgIGlmIChieXRlcyArIG4gPiAzOSAmJiBjaHVuaykgewogICAgICAgIHdvcmRzLnB1c2goY2h1bmspOwogICAgICAgIGNodW5rID0gJyc7CiAgICAgICAgYnl0ZXMgPSAwOwogICAgICB9CiAgICAgIGNodW5rICs9IGNoOwogICAgICBieXRlcyArPSBuOwogICAgfQogICAgaWYgKGNodW5rKSB3b3Jkcy",
"5wdXNoKGNodW5rKTsKICAgIHJldHVybiB3b3Jkcy5tYXAodyA9PiBgPT9VVEYtOD9CPyR7dXRmOFRvQmFzZTY0KHcpfT89YCkuam9pbignXHJcbiAnKTsKICB9CgogIC8vIFRoZSBpbnZlcnNlLCBmb3IgdGhlIHByZXZpZXcncyBmYWtlIEdtYWlsIGFuZCBmb3IgdGhlIHRlc3RzLiAoVGhlIHJlYWwKICAvLyBBUEkgaGFuZHMgaGVhZGVycyBiYWNrIGFscmVhZHkgZGVjb2RlZC4pCiAgZnVuY3Rpb24gZGVjb2RlSGVhZGVyVGV4dCh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCAnJykKICAgICAgLnJlcGxhY2UoLyg9XD9bXj9dK1w_W0JiUXFdXD9bXj9dKlw_PSlccysoPz09XD8pL2csICckMScpCiAgICAgIC5yZXBsYWNlKC89XD8oW14_XSspXD8oW0JiUXFdKVw_KFteP10qKVw_PS9nLCAoXywgY2hhcnNldCwgZW5jLCB0ZXh0KSA9PiB7CiAgICAgICAgY29uc3QgYmluID0gZW5jLnRvVXBwZXJDYXNlKCkgPT09ICdCJwogICAgICAgICAgPyBhdG9iKHRleHQpCiAgICAgICAgICA6IHRleHQucmVwbGFjZSgvXy9nLCAnICcpLnJlcGxhY2UoLz0oWzAtOUEtRmEtZl17Mn0pL2csIChtLCBoZXgpID0-IFN0cmluZy5mcm9tQ2hhckNvZGUocGFyc2VJbnQoaGV4LCAxNikpKTsKICAgICAgICByZXR1cm4gZGVjb2RlQnl0ZXMoYmluYXJ5VG9CeXRlcyhiaW4pLCBjaGFyc2V0KTsKICAgICAgfSk7CiAgfQoKICAvLyBIZWFkZXIgdmFsdWVzIG5ldmVyIGNhcnJ5IGxpbmUgYnJlYWtzIG9mIHRoZWlyIG93bjogb25lIG",
"luIGEgdGl0bGUKICAvLyB3b3VsZCBlbmQgdGhlIGhlYWRlciBlYXJseSBhbmQgc3RhcnQgYW5vdGhlciBvZiB0aGUgdXNlcidzIGNob29zaW5nLgogIGNvbnN0IG9uZUxpbmUgPSBzID0-IFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9bXHJcblx0XSsvZywgJyAnKS5yZXBsYWNlKC9cc3syLH0vZywgJyAnKS50cmltKCk7CgogIC8vIOKUgOKUgCBCdWlsZGluZyBhIG5vdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIEEgbm90ZSB3aXRoIG5vIHRpdGxlIGlzIGZpbGVkIHVuZGVyIGl0cyBmaXJzdCBsaW5lLCBhcyBtb3N0IG5vdGVzCiAgLy8gYXBwcyBkbywgc28gaXQgc3RpbGwgcmVhZHMgYXMgc29tZXRoaW5nIGluIEdtYWlsJ3MgbWVzc2FnZSBsaXN0LgogIGZ1bmN0aW9uIHRpdGxlRm9yKHRpdGxlLCBib2R5KSB7CiAgICBjb25zdCB0ID0gb25lTGluZSh0aXRsZSkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGlmICh0KSByZXR1cm4gdDsKICAgIGNvbnN0IGZpcnN0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnNwbGl0KCdcbicpLm1hcChsID0-IGwudHJpbSgpKS5maW5kKEJvb2xlYW4pIHx8ICcnOwogICAgcmV0dXJuIG9uZUxpbmUoZmlyc3QpLnNsaWNlKDAsIDgwKTsKICB9CgogIGZ1bm",
"N0aW9uIHdyYXA3NihzKSB7CiAgICByZXR1cm4gcy5yZXBsYWNlKC8uezEsNzZ9L2csICckJlxyXG4nKS50cmltRW5kKCk7CiAgfQoKICBjb25zdCB0ZXh0UGFydCA9ICh0eXBlLCBzKSA9PiBbCiAgICBgQ29udGVudC1UeXBlOiAke3R5cGV9OyBjaGFyc2V0PVVURi04YCwKICAgICdDb250ZW50LVRyYW5zZmVyLUVuY29kaW5nOiBiYXNlNjQnLAogICAgJycsCiAgICB3cmFwNzYodXRmOFRvQmFzZTY0KHMucmVwbGFjZSgvXG4vZywgJ1xyXG4nKSkpLAogIF07CgogIC8vIGBib2R5YCBpcyB0aGUgcGxhaW4gdGV4dC4gV2l0aCBgaHRtbGAgYXMgd2VsbCwgdGhlIG5vdGUgaXMgYQogIC8vIG11bHRpcGFydC9hbHRlcm5hdGl2ZSBtZXNzYWdlOiBHbWFpbCBzaG93cyB0aGUgSFRNTCwgYW5kIGl0cyBwcmV2aWV3cwogIC8vIGFuZCBwbGFpbi10ZXh0IHJlYWRlcnMgZ2V0IHRoZSB0ZXh0LgogIGZ1bmN0aW9uIGJ1aWxkTm90ZVJhdyh7IG5vdGVJZCwgdGl0bGUsIGJvZHksIGh0bWwsIGFjY291bnQsIGRhdGUgPSBuZXcgRGF0ZSgpIH0pIHsKICAgIGlmICghSURfUkUudGVzdChTdHJpbmcobm90ZUlkIHx8ICcnKSkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBub3RlIGlkJyk7CiAgICBjb25zdCBtZSA9IG9uZUxpbmUoYWNjb3VudCk7CiAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNsaWNlKDAsIE1BWF9CT0RZKTsKICAgIGNvbnN0IGhlYWQgPSBbCiAgICAgIC8vIE",
"5vdCBmcm9tIHRoZSBhY2NvdW50J3Mgb3duIGFkZHJlc3M6IEdtYWlsIGZpbGVzIGFueXRoaW5nIGZyb20geW91CiAgICAgIC8vIHVuZGVyIFNlbnQsIHdoYXRldmVyIGxhYmVscyBpdCB3YXMgZ2l2ZW4uIFJlcGxpZXMgc3RpbGwgcmVhY2ggeW91LgogICAgICBgRnJvbTogJHtOT1RFX1NFTkRFUn1gLAogICAgICBgVG86ICR7bWV9YCwKICAgICAgYFJlcGx5LVRvOiAke21lfWAsCiAgICAgIGBTdWJqZWN0OiAke2VuY29kZUhlYWRlclRleHQodGl0bGVGb3IodGl0bGUsIHRleHQpIHx8ICdVbnRpdGxlZCBub3RlJyl9YCwKICAgICAgYERhdGU6ICR7ZGF0ZS50b1VUQ1N0cmluZygpfWAsCiAgICAgIGBNZXNzYWdlLUlEOiA8JHtub3RlSWR9LiR7ZGF0ZS5nZXRUaW1lKCl9QG5vdGVzLmludmFsaWQ-YCwKICAgICAgYCR7Tk9URV9IRUFERVJ9OiAke25vdGVJZH1gLAogICAgICAnTUlNRS1WZXJzaW9uOiAxLjAnLAogICAgXTsKICAgIGxldCBsaW5lczsKICAgIGlmIChodG1sKSB7CiAgICAgIC8vIEJhc2U2NCBuZXZlciBjb250YWlucyAiLSIsIHNvIHRoaXMgYm91bmRhcnkgY2Fubm90IG9jY3VyIGluIGEgcGFydC4KICAgICAgY29uc3QgYm91bmRhcnkgPSBgZ2tiLSR7bm90ZUlkfS0ke2RhdGUuZ2V0VGltZSgpfWA7CiAgICAgIGxpbmVzID0gWwogICAgICAgIC4uLmhlYWQsCiAgICAgICAgYENvbnRlbnQtVHlwZTogbXVsdGlwYXJ0L2FsdGVybmF0aXZlOyBib3VuZGFyeT0iJHtib3VuZGFyeX0iYCwKICAgICAgICAnJywKIC",
"AgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvcGxhaW4nLCB0ZXh0KSwKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvaHRtbCcsIFN0cmluZyhodG1sKSksCiAgICAgICAgYC0tJHtib3VuZGFyeX0tLWAsCiAgICAgICAgJycsCiAgICAgIF07CiAgICB9IGVsc2UgewogICAgICBsaW5lcyA9IFsuLi5oZWFkLCAuLi50ZXh0UGFydCgndGV4dC9wbGFpbicsIHRleHQpLCAnJ107CiAgICB9CiAgICByZXR1cm4gYmFzZTY0VXJsRW5jb2RlKGxpbmVzLmpvaW4oJ1xyXG4nKSk7CiAgfQoKICAvLyDilIDilIAgV2hhdCB0aGUgd29ya2VyIGFsbG93cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaGVhZGVyQmxvY2soYmluYXJ5KSB7CiAgICBjb25zdCBlbmQgPSBiaW5hcnkuc2VhcmNoKC9ccj9cblxyP1xuLyk7CiAgICByZXR1cm4gZW5kIDwgMCA_IGJpbmFyeSA6IGJpbmFyeS5zbGljZSgwLCBlbmQpOwogIH0KCiAgLy8gVGhlIG5vdGUgaWQgYSByYXcgbWVzc2FnZSBjYXJyaWVzLCBvciAnJyBpZiBpdCBpcyBub3QgYSBub3RlLgogIGZ1bmN0aW9uIG5vdGVJZE9mUmF3KHJhdykgewogICAgbGV0IGJpbjsKICAgIHRyeSB7IGJpbiA9IGJhc2",
"U2NFVybERlY29kZShyYXcpOyB9IGNhdGNoIHsgcmV0dXJuICcnOyB9CiAgICBjb25zdCBtID0gaGVhZGVyQmxvY2soYmluKS5tYXRjaChuZXcgUmVnRXhwKGBeJHtOT1RFX0hFQURFUn06WyBcXHRdKihbXlxcclxcbl0qKSRgLCAnbWknKSk7CiAgICBjb25zdCBpZCA9IG0gPyBtWzFdLnRyaW0oKSA6ICcnOwogICAgcmV0dXJuIElEX1JFLnRlc3QoaWQpID8gaWQgOiAnJzsKICB9CgogIC8vIFRoZSBib2R5IG9mIGEgbWVzc2FnZXMuaW5zZXJ0IHRoZSB3b3JrZXIgd2lsbCBwYXNzIG9uOiBhIG5vdGUsIGZpbGVkCiAgLy8gdW5kZXIgdXNlciBsYWJlbHMgb25seSwgYW5kIG5vdGhpbmcgZWxzZSBpbiB0aGUgcmVxdWVzdC4KICBmdW5jdGlvbiBpc05vdGVJbnNlcnQoYm9keSkgewogICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgYm9keS5yYXcgIT09ICdzdHJpbmcnKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBleHRyYSA9IE9iamVjdC5rZXlzKGJvZHkpLmZpbHRlcihrID0-IGsgIT09ICdyYXcnICYmIGsgIT09ICdsYWJlbElkcycpOwogICAgaWYgKGV4dHJhLmxlbmd0aCkgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgbGFiZWxzID0gYm9keS5sYWJlbElkcyA9PT0gdW5kZWZpbmVkID8gW10gOiBib2R5LmxhYmVsSWRzOwogICAgaWYgKCFBcnJheS5pc0FycmF5KGxhYmVscykpIHJldHVybiBmYWxzZTsKICAgIGlmIChsYWJlbHMuc29tZShpZCA9PiBGT1JCSURERU5fSU5TRVJUX0",
"xBQkVMUy5oYXMoU3RyaW5nKGlkKS50b1VwcGVyQ2FzZSgpKSkpIHJldHVybiBmYWxzZTsKICAgIHJldHVybiAhIW5vdGVJZE9mUmF3KGJvZHkucmF3KTsKICB9CgogIC8vIOKUgOKUgCBSZWFkaW5nIG5vdGVzIGJhY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGhlYWRlck9mKG1lc3NhZ2UsIG5hbWUpIHsKICAgIHJldHVybiB1dGlsLmhlYWRlck1hcChtZXNzYWdlKVtuYW1lLnRvTG93ZXJDYXNlKCldIHx8ICcnOwogIH0KCiAgZnVuY3Rpb24gY2hhcnNldE9mKHBhcnQpIHsKICAgIGNvbnN0IGN0ID0gKHBhcnQuaGVhZGVycyB8fCBbXSkuZmluZChoID0-IGgubmFtZS50b0xvd2VyQ2FzZSgpID09PSAnY29udGVudC10eXBlJyk7CiAgICBjb25zdCBtID0gY3QgJiYgL2NoYXJzZXQ9Ij8oW14iO1xzXSspIj8vaS5leGVjKGN0LnZhbHVlKTsKICAgIHJldHVybiBtID8gbVsxXSA6ICd1dGYtOCc7CiAgfQoKICBmdW5jdGlvbiBwYXJ0VGV4dChwYXJ0KSB7CiAgICBpZiAoIXBhcnQgfHwgIXBhcnQuYm9keSB8fCAhcGFydC5ib2R5LmRhdGEpIHJldHVybiAnJzsKICAgIHJldHVybiBkZWNvZGVCeXRlcyhiaW5hcnlUb0J5dGVzKGJhc2U2NFVybERlY29kZShwYXJ0LmJvZHkuZGF0YSkpLCBjaGFyc2",
"V0T2YocGFydCkpOwogIH0KCiAgLy8gQSByb3VnaCB0ZXh0IHJlbmRlcmluZyBvZiBhbiBIVE1MIGVtYWlsLCBmb3Igbm90ZXMgdGhhdCBhcnJpdmVkIGFzCiAgLy8gbWFpbCAoc2F5LCBzZW50IHRvIHlvdXJzZWxmIGZyb20gYSBwaG9uZSkuIERvbmUgd2l0aCBwYXR0ZXJucyByYXRoZXIKICAvLyB0aGFuIHRoZSBET006IHBhcnNpbmcgSFRNTCBpbnRvIGEgZG9jdW1lbnQgaXMgYSBUcnVzdGVkIFR5cGVzIHNpbmsgb24KICAvLyBHbWFpbCdzIHBhZ2UsIGFuZCBvbmx5IHRoZSB3b3JkcyBhcmUgd2FudGVkIGFueXdheS4KICBmdW5jdGlvbiBodG1sVG9UZXh0KGh0bWwpIHsKICAgIGNvbnN0IHRleHQgPSBTdHJpbmcoaHRtbCB8fCAnJykKICAgICAgLnJlcGxhY2UoLzwoc2NyaXB0fHN0eWxlfGhlYWR8dGl0bGUpXGJbXj5dKj5bXHNcU10qPzxcL1wxXHMqPi9naSwgJycpCiAgICAgIC5yZXBsYWNlKC88YnJccypcLz8-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPGxpXGJbXj5dKj4vZ2ksICdcbuKAoiAnKQogICAgICAucmVwbGFjZSgvPFwvKHB8ZGl2fHVsfG9sfHRyfGhbMS02XXxibG9ja3F1b3RlfHByZXx0YWJsZSlccyo-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPFtePl0rPi9nLCAnJyk7CiAgICByZXR1cm4gdXRpbC5kZWNvZGVFbnRpdGllcyh0ZXh0KQogICAgICAucmVwbGFjZSgvXHUwMGEwL2csICcgJykKICAgICAgLnJlcGxhY2UoL1sgXHRdK1xuL2csICdcbicpCiAgICAgIC5yZXBsYWNlKC9cbnszLH",
"0vZywgJ1xuXG4nKQogICAgICAudHJpbSgpOwogIH0KCiAgZnVuY3Rpb24gdGV4dFBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHBsYWluID0gW107CiAgICBjb25zdCBodG1sID0gW107CiAgICAoZnVuY3Rpb24gd2FsayhwKSB7CiAgICAgIGlmICghcCkgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gU3RyaW5nKHAubWltZVR5cGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmICh0eXBlID09PSAndGV4dC9wbGFpbicpIHBsYWluLnB1c2gocCk7CiAgICAgIGVsc2UgaWYgKHR5cGUgPT09ICd0ZXh0L2h0bWwnKSBodG1sLnB1c2gocCk7CiAgICAgIChwLnBhcnRzIHx8IFtdKS5mb3JFYWNoKHdhbGspOwogICAgfSkocGF5bG9hZCk7CiAgICByZXR1cm4geyBwbGFpbiwgaHRtbCB9OwogIH0KCiAgLy8gUHJlZmVycyBhIHRleHQvcGxhaW4gcGFydCBhbnl3aGVyZSBpbiB0aGUgdHJlZSwgdGhlbiBIVE1MLgogIGZ1bmN0aW9uIGV4dHJhY3RUZXh0KHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIGlmIChwbGFpbi5sZW5ndGgpIHJldHVybiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKTsKICAgIGlmIChodG1sLmxlbmd0aCkgcmV0dXJuIGh0bWxUb1RleHQoaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykpOwogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gQm90aC",
"ByZW5kZXJpbmdzLCBkZWNvZGVkLCBmb3IgdGhlIGZvcm1hdHRlZCByZWFkZXI6IHRoZSBIVE1MIGlzIHRoZQogIC8vIHJlY29yZCwgdGhlIHBsYWluIHRleHQgdGhlIGZhbGxiYWNrIGZvciBtYWlsIHRoYXQgaGFzIG5vIEhUTUwuCiAgZnVuY3Rpb24gbWVzc2FnZVBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIHJldHVybiB7CiAgICAgIHBsYWluOiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKSwKICAgICAgaHRtbDogaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJyksCiAgICB9OwogIH0KCiAgLy8gT25lIG5vdGUgZnJvbSBhIG1lc3NhZ2VzLmdldC4gV2l0aCBmb3JtYXQ9bWV0YWRhdGEgdGhlcmUgaXMgbm8gYm9keQogIC8vIChib2R5IHN0YXlzIG51bGwpOyB3aXRoIGZvcm1hdD1mdWxsIHRoZXJlIGlzLgogIGZ1bmN0aW9uIG5vdGVGcm9tTWVzc2FnZShtc2cpIHsKICAgIGNvbnN0IG5vdGVJZCA9IGhlYWRlck9mKG1zZywgTk9URV9IRUFERVIpLnRyaW0oKTsKICAgIGNvbnN0IG93biA9IElEX1JFLnRlc3Qobm90ZUlkKTsKICAgIGNvbnN0IGZ1bGwgPSAhIShtc2cucGF5bG9hZCAmJiAobXNnLnBheWxvYWQuYm9keSB8fCBtc2cucGF5bG9hZC5wYXJ0cykpOwogICAgcmV0dXJuIHsKICAgICAgbWVzc2FnZUlkOiBtc2cuaWQsCiAgICAgIHRocmVhZElkOi",
"Btc2cudGhyZWFkSWQgfHwgJycsCiAgICAgIG5vdGVJZDogb3duID8gbm90ZUlkIDogJycsCiAgICAgIG93biwKICAgICAga2V5OiBvd24gPyBgbjoke25vdGVJZH1gIDogYG06JHttc2cuaWR9YCwKICAgICAgdGl0bGU6IG9uZUxpbmUoaGVhZGVyT2YobXNnLCAnU3ViamVjdCcpKSB8fCAnVW50aXRsZWQgbm90ZScsCiAgICAgIHVwZGF0ZWQ6IE51bWJlcihtc2cuaW50ZXJuYWxEYXRlKSB8fCBEYXRlLnBhcnNlKGhlYWRlck9mKG1zZywgJ0RhdGUnKSkgfHwgMCwKICAgICAgc25pcHBldDogdXRpbC5kZWNvZGVFbnRpdGllcyhtc2cuc25pcHBldCB8fCAnJyksCiAgICAgIGJvZHk6IGZ1bGwgPyBleHRyYWN0VGV4dChtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBwYXJ0czogZnVsbCA_IG1lc3NhZ2VQYXJ0cyhtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBsYWJlbElkczogbXNnLmxhYmVsSWRzIHx8IFtdLAogICAgfTsKICB9CgogIC8vIFR3byBsaXZlIHZlcnNpb25zIG9mIG9uZSBub3RlIG1lYW4gYSBzYXZlIGluc2VydGVkIHRoZSBuZXcgb25lIGJ1dAogIC8vIGNvdWxkIG5vdCB0cmFzaCB0aGUgb2xkIChvZmZsaW5lLCBjbG9zZWQgdGFiKSwgb3IgdHdvIGNvbXB1dGVycyBzYXZlZAogIC8vIGF0IG9uY2UuIFRoZSBuZXdlc3Qgd2luczsgdGhlIHJlc3QgYXJlIHJlcG9ydGVkIHNvIHRoZXkgY2FuIGJlCiAgLy8gdGlkaWVkIGludG8gVHJhc2gsIHdoZXJlIHRoZXkgc3RheSByZWNvdmVyYWJsZSBmb3IgdGhpcnR5IG",
"RheXMuCiAgZnVuY3Rpb24gZGVkdXBlTm90ZXMobm90ZXMpIHsKICAgIGNvbnN0IGxpdmUgPSBbXTsKICAgIGNvbnN0IHN0YWxlID0gW107CiAgICBjb25zdCBiZXN0ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSB7CiAgICAgIGNvbnN0IGN1ciA9IGJlc3QuZ2V0KG4ua2V5KTsKICAgICAgaWYgKCFjdXIpIHsgYmVzdC5zZXQobi5rZXksIG4pOyBjb250aW51ZTsgfQogICAgICBpZiAobi51cGRhdGVkID4gY3VyLnVwZGF0ZWQpIHsgc3RhbGUucHVzaChjdXIpOyBiZXN0LnNldChuLmtleSwgbik7IH0KICAgICAgZWxzZSBzdGFsZS5wdXNoKG4pOwogICAgfQogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSBpZiAoYmVzdC5nZXQobi5rZXkpID09PSBuKSBsaXZlLnB1c2gobik7CiAgICBsaXZlLnNvcnQoKGEsIGIpID0-IGIudXBkYXRlZCAtIGEudXBkYXRlZCk7CiAgICByZXR1cm4geyBsaXZlLCBzdGFsZSB9OwogIH0KCiAgLy8g4pSA4pSAIEZvbGRlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGZvbGRlciBpcyBhIEdtYWlsIGxhYmVsIHVuZGVyIHRoZSBub3RlcyBsYWJlbDogIl9Ob3Rlcy9Xb3JrIiwKIC",
"AvLyAiX05vdGVzL1dvcmsvQ2xpZW50cyIuIEV2ZXJ5IG5vdGUgY2FycmllcyB0aGUgbm90ZXMgbGFiZWwgaXRzZWxmLCBwbHVzCiAgLy8gdGhlIGxhYmVsIG9mIGF0IG1vc3Qgb25lIGZvbGRlciAtIHNvICJBbGwgbm90ZXMiIGlzIG9uZSBsYWJlbCwgYW5kIHRoZQogIC8vIGZvbGRlcnMgc2hvdyB1cCBuZXN0ZWQgdW5kZXIgX05vdGVzIGluIEdtYWlsJ3Mgb3duIGxhYmVsIGxpc3QuCgogIGNvbnN0IEZPTERFUl9OQU1FX01BWCA9IDYwOwoKICAvLyBUaGUgZm9sZGVycyB1bmRlciBgcm9vdGAsIGluIHRyZWUgb3JkZXI6IGVhY2ggcGFyZW50IGZvbGxvd2VkIGJ5IGl0cwogIC8vIGNoaWxkcmVuLCBhbHBoYWJldGljYWxseSwgd2l0aCBpdHMgZGVwdGguIEEgbGFiZWwgd2hvc2UgcGFyZW50IGxhYmVsCiAgLy8gaXMgbWlzc2luZyAobWFkZSBieSBoYW5kIGluIEdtYWlsKSBzdGlsbCBhcHBlYXJzLCBhdCBpdHMgb3duIGRlcHRoLgogIGZ1bmN0aW9uIGZvbGRlclRyZWUobGFiZWxzLCByb290KSB7CiAgICBjb25zdCBwcmVmaXggPSBgJHtyb290fS9gOwogICAgY29uc3QgbGlzdCA9IChsYWJlbHMgfHwgW10pCiAgICAgIC5maWx0ZXIobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKHByZWZpeCkgJiYgbC5uYW1lLmxlbmd0aCA-IHByZWZpeC5sZW5ndGgpCiAgICAgIC5tYXAobCA9PiB7CiAgICAgICAgY29uc3QgcGF0aCA9IGwubmFtZS5zbGljZShwcmVmaXgubGVuZ3",
"RoKTsKICAgICAgICBjb25zdCBwYXJ0cyA9IHBhdGguc3BsaXQoJy8nKTsKICAgICAgICByZXR1cm4geyBpZDogbC5pZCwgbmFtZTogbC5uYW1lLCBwYXRoLCB0aXRsZTogcGFydHNbcGFydHMubGVuZ3RoIC0gMV0sIGRlcHRoOiBwYXJ0cy5sZW5ndGggLSAxLCBwYXJlbnRQYXRoOiBwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpIH07CiAgICAgIH0pOwogICAgLy8gU29ydGluZyBieSBwYXRoIHNlZ21lbnQgYnkgc2VnbWVudCBrZWVwcyBldmVyeSBjaGlsZCB1bmRlciBpdHMgcGFyZW50LgogICAgY29uc3Qga2V5ID0gZiA9PiBmLnBhdGguc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRvTG93ZXJDYXNlKCkpOwogICAgbGlzdC5zb3J0KChhLCBiKSA9PiB7CiAgICAgIGNvbnN0IHggPSBrZXkoYSk7CiAgICAgIGNvbnN0IHkgPSBrZXkoYik7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5taW4oeC5sZW5ndGgsIHkubGVuZ3RoKTsgaSsrKSB7CiAgICAgICAgaWYgKHhbaV0gIT09IHlbaV0pIHJldHVybiB4W2ldIDwgeVtpXSA_IC0xIDogMTsKICAgICAgfQogICAgICByZXR1cm4geC5sZW5ndGggLSB5Lmxlbmd0aDsKICAgIH0pOwogICAgcmV0dXJuIGxpc3Q7CiAgfQoKICAvLyBUaGUgZm9sZGVyIGEgbm90ZSBpcyBpbiwgZnJvbSBpdHMgbGFiZWxzOyAnJyBmb3Igbm9uZS4gVHdvIGZvbGRlcgogIC8vIGxhYmVscyAoYXBwbGllZCBieSBoYW5kKSByZXNvbHZlIHRvIHRoZSBmaXJzdCBpbiB0cmVlIG9yZGVyLgogIG",
"Z1bmN0aW9uIGZvbGRlck9mKGxhYmVsSWRzLCBmb2xkZXJzKSB7CiAgICBjb25zdCBoYXZlID0gbmV3IFNldChsYWJlbElkcyB8fCBbXSk7CiAgICBjb25zdCBmID0gKGZvbGRlcnMgfHwgW10pLmZpbmQoeCA9PiBoYXZlLmhhcyh4LmlkKSk7CiAgICByZXR1cm4gZiA_IGYuaWQgOiAnJzsKICB9CgogIC8vIE1vdmluZyBhIG5vdGU6IGtlZXAgKG9yIHJlc3RvcmUpIHRoZSBub3RlcyBsYWJlbCwgYWRkIHRoZSB0YXJnZXQncywKICAvLyBkcm9wIGV2ZXJ5IG90aGVyIGZvbGRlcidzLgogIGZ1bmN0aW9uIG1vdmVGb2xkZXJEaWZmKHJvb3RJZCwgZm9sZGVycywgdGFyZ2V0SWQpIHsKICAgIGNvbnN0IGFkZCA9IFtyb290SWRdOwogICAgaWYgKHRhcmdldElkKSBhZGQucHVzaCh0YXJnZXRJZCk7CiAgICBjb25zdCByZW1vdmUgPSAoZm9sZGVycyB8fCBbXSkubWFwKGYgPT4gZi5pZCkuZmlsdGVyKGlkID0-IGlkICE9PSB0YXJnZXRJZCk7CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogYWRkLCByZW1vdmVMYWJlbElkczogcmVtb3ZlIH07CiAgfQoKICBmdW5jdGlvbiB2YWxpZGF0ZUZvbGRlclRpdGxlKHRpdGxlLCBzaWJsaW5ncyA9IFtdKSB7CiAgICBjb25zdCB0ID0gU3RyaW5nKHRpdGxlIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXQpIHJldHVybiAnR2l2ZSB0aGUgZm9sZGVyIGEgbmFtZS4nOwogICAgaWYgKHQuaW5jbHVkZXMoJy8nKSkgcmV0dXJuICdBIGZvbGRlciBuYW1lIGNhbm5vdCBjb250YWluIOKAnC_igJ0uIE",
"1ha2UgYSBzdWJmb2xkZXIgaW5zdGVhZC4nOwogICAgaWYgKHQubGVuZ3RoID4gRk9MREVSX05BTUVfTUFYKSByZXR1cm4gYEtlZXAgZm9sZGVyIG5hbWVzIHVuZGVyICR7Rk9MREVSX05BTUVfTUFYfSBjaGFyYWN0ZXJzLmA7CiAgICBpZiAoc2libGluZ3Muc29tZShzID0-IHMudG9Mb3dlckNhc2UoKSA9PT0gdC50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuIGBUaGVyZSBpcyBhbHJlYWR5IGEgZm9sZGVyIGNhbGxlZCDigJwke3R94oCdIGhlcmUuYDsKICAgIHJldHVybiAnJzsKICB9CgogIC8vIFJlbmFtaW5nIGEgZm9sZGVyIHJlbmFtZXMgaXRzIGxhYmVsIGFuZCBldmVyeSBsYWJlbCBiZWxvdyBpdCwgc2luY2UKICAvLyBHbWFpbCdzIEFQSSByZW5hbWVzIG9ubHkgdGhlIG9uZSBsYWJlbCBpdCBpcyBnaXZlbi4KICBmdW5jdGlvbiByZW5hbWVQbGFuKGZvbGRlciwgbmV3VGl0bGUsIGZvbGRlcnMpIHsKICAgIGNvbnN0IHBhcmVudCA9IGZvbGRlci5uYW1lLnNsaWNlKDAsIGZvbGRlci5uYW1lLmxlbmd0aCAtIGZvbGRlci50aXRsZS5sZW5ndGgpOwogICAgY29uc3QgbmV3TmFtZSA9IGAke3BhcmVudH0ke1N0cmluZyhuZXdUaXRsZSkudHJpbSgpfWA7CiAgICByZXR1cm4gKGZvbGRlcnMgfHwgW10pCiAgICAgIC5maWx0ZXIoZiA9PiBmLm5hbWUgPT09IGZvbGRlci5uYW1lIHx8IGYubmFtZS5zdGFydHNXaXRoKGAke2ZvbGRlci5uYW1lfS9gKSkKICAgICAgLm1hcChmID0-ICh7IGlkOiBmLmlkLCBuYW1lOiBuZXdOYW1lIC",
"sgZi5uYW1lLnNsaWNlKGZvbGRlci5uYW1lLmxlbmd0aCkgfSkpOwogIH0KCiAgLy8gV2hldGhlciB0aGUgd29ya2VyIG1heSBkZWxldGUgYSBsYWJlbDogYSBmb2xkZXIgdW5kZXIgdGhlIG5vdGVzIGxhYmVsCiAgLy8gd2l0aCBubyBub3RlcyBpbiBpdCBhbmQgbm8gZm9sZGVycyB1bmRlciBpdC4gYGxpdmVNZXNzYWdlc2AgaXMgd2hhdCBhCiAgLy8gbWVzc2FnZXMubGlzdCBvbiB0aGUgbGFiZWwgZm91bmQgLSBub3QgdGhlIGxhYmVsJ3Mgb3duIGNvdW50LCB3aGljaAogIC8vIGFsc28gY291bnRzIG9sZCB2ZXJzaW9ucyB3YWl0aW5nIGluIFRyYXNoIGFuZCB3b3VsZCBrZWVwIGFuIGVtcHRpZWQKICAvLyBmb2xkZXIgdW5kZWxldGFibGUgZm9yIGEgbW9udGguCiAgZnVuY3Rpb24gaXNEZWxldGFibGVGb2xkZXIobGFiZWwsIHJvb3QsIGFsbExhYmVscywgbGl2ZU1lc3NhZ2VzKSB7CiAgICBpZiAoIWxhYmVsIHx8IHR5cGVvZiBsYWJlbC5uYW1lICE9PSAnc3RyaW5nJyB8fCAhcm9vdCkgcmV0dXJuIGZhbHNlOwogICAgaWYgKCFsYWJlbC5uYW1lLnN0YXJ0c1dpdGgoYCR7cm9vdH0vYCkgfHwgbGFiZWwubmFtZS5sZW5ndGggPD0gcm9vdC5sZW5ndGggKyAxKSByZXR1cm4gZmFsc2U7CiAgICBpZiAobGl2ZU1lc3NhZ2VzICE9PSAwKSByZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gIShhbGxMYWJlbHMgfHwgW10pLnNvbWUobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaX",
"RoKGAke2xhYmVsLm5hbWV9L2ApKTsKICB9CgogIGNvbnN0IGFwaSA9IHsKICAgIE5PVEVfSEVBREVSLCBOT1RFX1NFTkRFUiwgREVGQVVMVF9MQUJFTCwgTUFYX0JPRFksIE1BWF9USVRMRSwgRk9SQklEREVOX0lOU0VSVF9MQUJFTFMsIEZPTERFUl9OQU1FX01BWCwKICAgIGZvbGRlclRyZWUsIGZvbGRlck9mLCBtb3ZlRm9sZGVyRGlmZiwgdmFsaWRhdGVGb2xkZXJUaXRsZSwgcmVuYW1lUGxhbiwgaXNEZWxldGFibGVGb2xkZXIsCiAgICBTQ1JBVENIUEFEX0lELCBTQ1JBVENIUEFEX1RJVExFLCBuZXdOb3RlSWQsIG5vdGVJZEZvciwgZW5jb2RlSGVhZGVyVGV4dCwgZGVjb2RlSGVhZGVyVGV4dCwgYmFzZTY0VXJsRW5jb2RlLCBiYXNlNjRVcmxEZWNvZGUsCiAgICB0aXRsZUZvciwgYnVpbGROb3RlUmF3LCBub3RlSWRPZlJhdywgaXNOb3RlSW5zZXJ0LAogICAgaHRtbFRvVGV4dCwgZXh0cmFjdFRleHQsIG1lc3NhZ2VQYXJ0cywgbm90ZUZyb21NZXNzYWdlLCBkZWR1cGVOb3RlcywKICB9OwoKICBucy5ub3Rlc0xvZ2ljID0gYXBpOwogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgbW9kdWxlLmV4cG9ydHMgPSBhcGk7Cn0pKCk7Cg\"],[\"src/lib/note-format.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGUgZm9ybWF0dGluZyAocHVyZSkKLy8KLy8gQSBmb3JtYXR0ZWQgbm90ZSBpcyBhIGxpc3Qgb2YgYmxvY2tzIC0gcGFyYWdyYXBocywgdGhyZWUgaGVhZGluZwovLyBzaXplcywgYnVsbGV0ZWQsIG51bWJlcmVkIGFuZCBjaGVjayBsaXN0cyBuZXN0ZWQgdXAgdG8gdGhyZWUgZGVlcCwgYW5kCi8vIHRhYmxlcyAtIGVhY2ggaG9sZGluZyBydW5zIG9mIHRleHQgdGhhdCBtYXkgYmUgYm9sZCwgaXRhbGljLCBzdHJ1Y2sKLy8gdGhyb3VnaCBvciBhIGxpbmsgKGEgdGFibGUsIHJvd3Mgb2YgY2VsbHMgb2YgdGhlbSkuIFRoYXQgaXMgdGhlIHdob2xlCi8vIG1vZGVsOyBub3RoaW5nIG91dHNpZGUgaXQgc3Vydml2ZXMgYSBzYXZlLgovLwovLyBJdCBpcyBzdG9yZWQgaW4gdGhlIG5vdGUncyBtZXNzYWdlIHR3aWNlLiBUaGUgSFRNTCBwYXJ0IGlzIHRoZSByZWFsCi8vIHJlY29yZDogR21haWwgc2hvd3MgaXQgKG9uIHRoZSBwaG9uZSB0b28pLCBhbmQgdGhpcyBmaWxlIHJlYWRzIGl0IGJhY2sKLy8gd2l0aCBhIHNtYWxsIHRva2VuaXplciBvZiBpdHMgb3duIHJhdGhlciB0aGFuIHRoZSBicm93c2VyJ3MgSFRNTAovLyBwYXJzZXIsIHdoaWNoIGlzIGEgVHJ1c3RlZCBUeXBlcyBzaW5rIG9uIEdtYWlsJ3MgcGFnZSBhbmQgd291bGQgYWNjZXB0Ci8vIG",
"ZhciBtb3JlIHRoYW4gdGhlIG1vZGVsIGNhbiBob2xkLiBUaGUgcGxhaW4tdGV4dCBwYXJ0IGlzIGEgcmVhZGFibGUKLy8gcmVuZGVyaW5nIC0gYnVsbGV0cywg4piQIGFuZCDimJEgLSBmb3IgR21haWwncyBwcmV2aWV3cyBhbmQgZm9yIGFueSBtYWlsCi8vIGNsaWVudCB0aGF0IHNob3dzIHRleHQuCi8vCi8vIE1haWwgdGhhdCBhcnJpdmVkIGFzIGEgbm90ZSAod3JpdHRlbiBpbiBHbWFpbCwgc2F5KSBnb2VzIHRocm91Z2ggdGhlCi8vIHNhbWUgcmVhZGVyLCBzbyBpdHMgYm9sZCwgbGlzdHMgYW5kIGxpbmtzIGNvbWUgYWNyb3NzIHdoZXJlIHRoZXkgZml0Ci8vIHRoZSBtb2RlbCBhbmQgZXZlcnl0aGluZyBlbHNlIGlzIHJlZHVjZWQgdG8gdGV4dC4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuan",
"MnKSA6IG5zLnV0aWw7CgogIGNvbnN0IFRZUEVTID0gbmV3IFNldChbJ3AnLCAnaDEnLCAnaDInLCAnaDMnLCAndWwnLCAnb2wnLCAnY2hlY2snLCAndGFibGUnXSk7CiAgY29uc3QgTElTVFMgPSBuZXcgU2V0KFsndWwnLCAnb2wnLCAnY2hlY2snXSk7CiAgY29uc3QgTUFYX0xFVkVMID0gMzsKICAvLyBBIHRhYmxlOiBhdCBtb3N0IHRoaXMgbWFueSBjb2x1bW5zIGFuZCByb3dzOyBhIGNvbHVtbiBpcyBhbGlnbmVkCiAgLy8gbGVmdCAoJycpLCBpbiB0aGUgY2VudHJlIG9yIHRvIHRoZSByaWdodC4KICBjb25zdCBNQVhfQ09MUyA9IDI2OwogIGNvbnN0IE1BWF9ST1dTID0gMTAwMDsKICBjb25zdCBBTElHTlMgPSBuZXcgU2V0KFsnJywgJ2NlbnRlcicsICdyaWdodCddKTsKICBjb25zdCBCT1ggPSAn4piQJzsgICAgIC8vIOKYkAogIGNvbnN0IFRJQ0tFRCA9ICfimJEnOyAgLy8g4piRCiAgY29uc3QgQlVMTEVUID0gJ-KAoic7ICAvLyDigKIKCiAgLy8g4pSA4pSAIFRoZSBtb2RlbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYmxvY2sodHlwZSA9ICdwJywgcnVucyA9IFtdLCB7IGxldmVsID0gMCwgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgew",
"ogICAgcmV0dXJuIHsgdHlwZSwgbGV2ZWw6IExJU1RTLmhhcyh0eXBlKSA_IGxldmVsIDogMCwgY2hlY2tlZDogdHlwZSA9PT0gJ2NoZWNrJyA_ICEhY2hlY2tlZCA6IGZhbHNlLCBydW5zIH07CiAgfQoKICAvLyBBIHRhYmxlIGJsb2NrOiBgcm93c2Agb2YgY2VsbHMsIGVhY2ggY2VsbCB7IHJ1bnMgfSAtIGEgbGluZSBicmVhawogIC8vIGluc2lkZSBhIGNlbGwgaXMgYSAiXG4iIGluIGl0cyB0ZXh0OyBgaGVhZGAsIHdoZXRoZXIgdGhlIGZpcnN0IHJvdyBpcwogIC8vIGEgaGVhZGluZyByb3c7IGBhbGlnbmAsIGVhY2ggY29sdW1uJ3MgYWxpZ25tZW50LgogIGZ1bmN0aW9uIHRhYmxlKHJvd3MgPSBbW3sgcnVuczogW10gfV1dLCB7IGhlYWQgPSBmYWxzZSwgYWxpZ24gPSBbXSB9ID0ge30pIHsKICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJsb2NrKCd0YWJsZScpLCB7IHJvd3MsIGhlYWQ6ICEhaGVhZCwgYWxpZ24gfSk7CiAgfQoKICBjb25zdCBlbXB0eUNlbGwgPSAoKSA9PiAoeyBydW5zOiBbXSB9KTsKCiAgZnVuY3Rpb24gZW1wdHlEb2MoKSB7CiAgICByZXR1cm4gW2Jsb2NrKCdwJyldOwogIH0KCiAgY29uc3Qgc2FtZU1hcmtzID0gKGEsIGIpID0-ICEhYS5iID09PSAhIWIuYiAmJiAhIWEuaSA9PT0gISFiLmkgJiYgISFhLnMgPT09ICEhYi5zICYmIChhLmhyZWYgfHwgJycpID09PSAoYi5ocmVmIHx8ICcnKTsKCiAgZnVuY3Rpb24gY2xlYW5SdW4ocikgewogICAgY29uc3Qgb3V0ID0geyB0ZXh0OiBTdHJpbmcoci",
"50ZXh0IHx8ICcnKSB9OwogICAgaWYgKHIuYikgb3V0LmIgPSB0cnVlOwogICAgaWYgKHIuaSkgb3V0LmkgPSB0cnVlOwogICAgaWYgKHIucykgb3V0LnMgPSB0cnVlOwogICAgY29uc3QgaHJlZiA9IHIuaHJlZiA_IHNhZmVIcmVmKHIuaHJlZikgOiAnJzsKICAgIGlmIChocmVmKSBvdXQuaHJlZiA9IGhyZWY7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gRHJvcHMgZW1wdHkgcnVucyBhbmQgam9pbnMgbmVpZ2hib3VycyB0aGF0IGxvb2sgdGhlIHNhbWUsIHNvIHR3bwogIC8vIGRvY3VtZW50cyB0aGF0IHJlYWQgYWxpa2UgY29tcGFyZSBhbGlrZS4KICBmdW5jdGlvbiBub3JtYWxpc2VSdW5zKHJ1bnMpIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgZm9yIChjb25zdCByIG9mIHJ1bnMgfHwgW10pIHsKICAgICAgaWYgKCFyIHx8ICFyLnRleHQpIGNvbnRpbnVlOwogICAgICBjb25zdCBsYXN0ID0gb3V0W291dC5sZW5ndGggLSAxXTsKICAgICAgaWYgKGxhc3QgJiYgc2FtZU1hcmtzKGxhc3QsIHIpKSBsYXN0LnRleHQgKz0gci50ZXh0OwogICAgICBlbHNlIG91dC5wdXNoKGNsZWFuUnVuKHIpKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBFdmVyeSByb3cgYXMgd2lkZSBhcyB0aGUgd2lkZXN0IChhbmQgd2l0aGluIHRoZSBsaW1pdHMpLCBldmVyeSBjZWxsCiAgLy8gdGlkeSwgYXQgbGVhc3Qgb25lIGNlbGwuCiAgZnVuY3Rpb24gbm9ybWFsaXNlVGFibGUoYikgewogICAgY29uc3Qgc3JjID0gKEFycm",
"F5LmlzQXJyYXkoYi5yb3dzKSA_IGIucm93cyA6IFtdKS5maWx0ZXIoQXJyYXkuaXNBcnJheSkuc2xpY2UoMCwgTUFYX1JPV1MpOwogICAgY29uc3Qgd2lkZXN0ID0gc3JjLnJlZHVjZSgobiwgcikgPT4gTWF0aC5tYXgobiwgci5sZW5ndGgpLCAwKTsKICAgIGNvbnN0IGNvbHMgPSBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfQ09MUywgd2lkZXN0KSk7CiAgICBjb25zdCByb3dzID0gc3JjLm1hcChyID0-IEFycmF5LmZyb20oeyBsZW5ndGg6IGNvbHMgfSwgKF8sIGspID0-ICh7IHJ1bnM6IG5vcm1hbGlzZVJ1bnMocltrXSAmJiByW2tdLnJ1bnMpIH0pKSk7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSByb3dzLnB1c2goQXJyYXkuZnJvbSh7IGxlbmd0aDogY29scyB9LCBlbXB0eUNlbGwpKTsKICAgIGNvbnN0IGFsaWduID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogY29scyB9LCAoXywgaykgPT4gKGIuYWxpZ24gJiYgQUxJR05TLmhhcyhiLmFsaWduW2tdKSA_IGIuYWxpZ25ba10gOiAnJykpOwogICAgcmV0dXJuIHRhYmxlKHJvd3MsIHsgaGVhZDogYi5oZWFkLCBhbGlnbiB9KTsKICB9CgogIC8vIFVua25vd24gdHlwZXMgYmVjb21lIHBhcmFncmFwaHM7IGEgbGlzdCBpdGVtIG1heSBzaXQgYXQgbW9zdCBvbmUgbGV2ZWwKICAvLyBkZWVwZXIgdGhhbiB0aGUgbGlzdCBpdGVtIGJlZm9yZSBpdCwgd2hpY2ggaXMgd2hhdCBrZWVwcyB0aGUgSFRNTCBhCiAgLy8gcHJvcGVybHkgbmVzdGVkIGxpc3QgYW5kIHRoZSBlZGl0b3Incy",
"BpbmRlbnRzIG1lYW5pbmdmdWwuIEEgdGFibGUgaXMKICAvLyBuZXZlciBsYXN0OiBhIGxpbmUgZm9sbG93cyBpdCwgc29tZXdoZXJlIHRvIHR5cGUgYWZ0ZXIgaXQuCiAgZnVuY3Rpb24gbm9ybWFsaXNlRG9jKGRvYykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBsZXQgcHJldkxldmVsID0gLTE7CiAgICBmb3IgKGNvbnN0IGIgb2YgQXJyYXkuaXNBcnJheShkb2MpID8gZG9jIDogW10pIHsKICAgICAgaWYgKCFiIHx8IHR5cGVvZiBiICE9PSAnb2JqZWN0JykgY29udGludWU7CiAgICAgIGlmIChiLnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICBvdXQucHVzaChub3JtYWxpc2VUYWJsZShiKSk7CiAgICAgICAgcHJldkxldmVsID0gLTE7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgY29uc3QgdHlwZSA9IFRZUEVTLmhhcyhiLnR5cGUpID8gYi50eXBlIDogJ3AnOwogICAgICBsZXQgbGV2ZWwgPSAwOwogICAgICBpZiAoTElTVFMuaGFzKHR5cGUpKSB7CiAgICAgICAgbGV2ZWwgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihNQVhfTEVWRUwsIE51bWJlcihiLmxldmVsKSB8fCAwLCBwcmV2TGV2ZWwgKyAxKSk7CiAgICAgICAgcHJldkxldmVsID0gbGV2ZWw7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgcHJldkxldmVsID0gLTE7CiAgICAgIH0KICAgICAgb3V0LnB1c2goYmxvY2sodHlwZSwgbm9ybWFsaXNlUnVucyhiLnJ1bnMpLCB7IGxldmVsLCBjaGVja2VkOiBiLmNoZWNrZWQgfSkpOwogICAgfQogICAgaW",
"YgKG91dC5sZW5ndGggJiYgb3V0W291dC5sZW5ndGggLSAxXS50eXBlID09PSAndGFibGUnKSBvdXQucHVzaChibG9jaygncCcpKTsKICAgIHJldHVybiBvdXQubGVuZ3RoID8gb3V0IDogZW1wdHlEb2MoKTsKICB9CgogIGNvbnN0IHJ1bnNUZXh0ID0gcnVucyA9PiBydW5zLm1hcChyID0-IHIudGV4dCkuam9pbignJyk7CiAgLy8gQSB0YWJsZSdzIHRleHQ6IGEgcm93IGEgbGluZSwgaXRzIGNlbGxzIGJldHdlZW4gIiB8ICIuCiAgY29uc3QgdGFibGVUZXh0ID0gYiA9PiBiLnJvd3MubWFwKHIgPT4gci5tYXAoYyA9PiBydW5zVGV4dChjLnJ1bnMpLnJlcGxhY2UoL1xuL2csICcgJykpLmpvaW4oJyB8ICcpKS5qb2luKCdcbicpOwogIGNvbnN0IGJsb2NrVGV4dCA9IGIgPT4gKGIudHlwZSA9PT0gJ3RhYmxlJyA_IHRhYmxlVGV4dChiKSA6IHJ1bnNUZXh0KGIucnVucykpOwoKICBmdW5jdGlvbiBkb2NUZXh0KGRvYykgewogICAgcmV0dXJuIGRvYy5tYXAoYmxvY2tUZXh0KS5qb2luKCdcbicpOwogIH0KCiAgLy8gQSB0YWJsZSBjb3VudHMgYXMgc29tZXRoaW5nIHdyaXR0ZW4sIGV2ZW4gd2l0aCBub3RoaW5nIGluIGl0IHlldC4KICBmdW5jdGlvbiBpc0VtcHR5KGRvYykgewogICAgcmV0dXJuIGRvYy5ldmVyeShiID0-IGIudHlwZSAhPT0gJ3RhYmxlJyAmJiAhYmxvY2tUZXh0KGIpLnRyaW0oKSk7CiAgfQoKICAvLyDilIDilIAgTGlua3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFdlYiBhbmQgbWFpbCBsaW5rcyBvbmx5LiAiZXhhbXBsZS5jb20veCIgZ2V0cyBodHRwczovLyBpbiBmcm9udCwgYQogIC8vIGJhcmUgYWRkcmVzcyBnZXRzIG1haWx0bzosIGFuZCBhbnl0aGluZyBlbHNlIC0gamF2YXNjcmlwdDosIGRhdGE6LAogIC8vIGZpbGU6IC0gaXMgbm90IGEgbGluayBhdCBhbGwuCiAgZnVuY3Rpb24gc2FmZUhyZWYodXJsKSB7CiAgICBjb25zdCBzID0gU3RyaW5nKHVybCB8fCAnJykudHJpbSgpOwogICAgaWYgKCFzIHx8IC9bXHM8PiJdLy50ZXN0KHMpKSByZXR1cm4gJyc7CiAgICBpZiAoL15tYWlsdG86L2kudGVzdChzKSkgcmV0dXJuIC9ebWFpbHRvOlteQFxzXStAW15AXHNdKyQvaS50ZXN0KHMpID8gcyA6ICcnOwogICAgaWYgKC9eW15cc0AvOl0rQFteXHNALzpdK1wuW15cc0AvOl0rJC8udGVzdChzKSkgcmV0dXJuIGBtYWlsdG86JHtzfWA7CiAgICBsZXQgY2FuZGlkYXRlID0gczsKICAgIGlmICghL15bYS16XVthLXowLTkrLi1dKjovaS50ZXN0KHMpKSB7CiAgICAgIGlmICghL15bXHctXSsoXC5bXHctXSspKyg6XGQrKT8oWy8_I118JCkvLnRlc3QocykpIHJldHVybiAnJzsKICAgICAgY2FuZGlkYXRlID0gYGh0dHBzOi8vJHtzfWA7Ci",
"AgICB9CiAgICB0cnkgewogICAgICBjb25zdCB1ID0gbmV3IFVSTChjYW5kaWRhdGUpOwogICAgICByZXR1cm4gdS5wcm90b2NvbCA9PT0gJ2h0dHA6JyB8fCB1LnByb3RvY29sID09PSAnaHR0cHM6JyA_IHUuaHJlZiA6ICcnOwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiAnJzsKICAgIH0KICB9CgogIC8vIOKUgOKUgCBIVE1MIG91dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgZXNjSHRtbCA9IHMgPT4gU3RyaW5nKHMpLnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9nLCAnJmx0OycpLnJlcGxhY2UoLz4vZywgJyZndDsnKS5yZXBsYWNlKC8iL2csICcmcXVvdDsnKTsKCiAgLy8gU3BhY2VzIEhUTUwgd291bGQgY29sbGFwc2UgLSBkb3VibGVkLCBhdCBlaXRoZXIgZW5kIG9mIGEgYmxvY2ssIG9yCiAgLy8gbWVldGluZyBhY3Jvc3MgYSB0YWcgLSBhcmUgd3JpdHRlbiBhcyAmbmJzcDsgc28gdGhleSBjb21lIGJhY2sgYXMKICAvLyB0eXBlZC4KICBmdW5jdGlvbiBydW5zSHRtbChydW5zKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBsZXQgcHJldlNwYWNlID0gZmFsc2U7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJ1bnMubG",
"VuZ3RoOykgewogICAgICBjb25zdCBocmVmID0gcnVuc1tpXS5ocmVmIHx8ICcnOwogICAgICBsZXQgaiA9IGk7CiAgICAgIGxldCBpbm5lciA9ICcnOwogICAgICB3aGlsZSAoaiA8IHJ1bnMubGVuZ3RoICYmIChydW5zW2pdLmhyZWYgfHwgJycpID09PSBocmVmKSB7CiAgICAgICAgY29uc3QgcmF3ID0gcnVuc1tqXS50ZXh0OwogICAgICAgIGxldCB0ID0gZXNjSHRtbChyYXcpLnJlcGxhY2UoLyB7Mn0vZywgJyAmbmJzcDsnKS5yZXBsYWNlKC9cbi9nLCAnPGJyPicpOwogICAgICAgIGlmIChwcmV2U3BhY2UgJiYgdFswXSA9PT0gJyAnKSB0ID0gYCZuYnNwOyR7dC5zbGljZSgxKX1gOwogICAgICAgIHByZXZTcGFjZSA9IC8gJC8udGVzdChyYXcpOwogICAgICAgIGlmIChydW5zW2pdLnMpIHQgPSBgPHM-JHt0fTwvcz5gOwogICAgICAgIGlmIChydW5zW2pdLmkpIHQgPSBgPGk-JHt0fTwvaT5gOwogICAgICAgIGlmIChydW5zW2pdLmIpIHQgPSBgPGI-JHt0fTwvYj5gOwogICAgICAgIGlubmVyICs9IHQ7CiAgICAgICAgaisrOwogICAgICB9CiAgICAgIG91dCArPSBocmVmID8gYDxhIGhyZWY9IiR7ZXNjSHRtbChocmVmKX0iPiR7aW5uZXJ9PC9hPmAgOiBpbm5lcjsKICAgICAgaSA9IGo7CiAgICB9CiAgICAvLyBFZGdlIHNwYWNlcyBvZiB0aGUgd2hvbGUgYmxvY2ssIGFmdGVyIHRoZSB0YWdzIGFyZSBpbiBwbGFjZS4KICAgIHJldHVybiBvdXQucmVwbGFjZSgvXigoPzo8W14-XSs-KSopIC8sICckMSZuYnNwOycpLn",
"JlcGxhY2UoLyAoKD86PFwvW14-XSs-KSopJC8sICcmbmJzcDskMScpOwogIH0KCiAgY29uc3QgU1RZTEUgPSB7CiAgICBkb2M6ICdmb250LWZhbWlseTpBcmlhbCxIZWx2ZXRpY2Esc2Fucy1zZXJpZjtmb250LXNpemU6MTRweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOiMxZjFmMWYnLAogICAgcDogJ21hcmdpbjowJywKICAgIGgxOiAnbWFyZ2luOjE0cHggMCA0cHg7Zm9udC1zaXplOjIycHg7bGluZS1oZWlnaHQ6MS4zO2ZvbnQtd2VpZ2h0OmJvbGQnLAogICAgaDI6ICdtYXJnaW46MTJweCAwIDJweDtmb250LXNpemU6MThweDtsaW5lLWhlaWdodDoxLjM7Zm9udC13ZWlnaHQ6Ym9sZCcsCiAgICBoMzogJ21hcmdpbjoxMHB4IDAgMnB4O2ZvbnQtc2l6ZToxNXB4O2xpbmUtaGVpZ2h0OjEuMztmb250LXdlaWdodDpib2xkJywKICAgIGxpc3Q6ICdtYXJnaW46MDtwYWRkaW5nLWxlZnQ6MjZweCcsCiAgICBjaGVjazogJ21hcmdpbjowO3BhZGRpbmctbGVmdDo0cHg7bGlzdC1zdHlsZTpub25lJywKICAgIGxpOiAnbWFyZ2luOjFweCAwJywKICAgIHRhYmxlOiAnYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlO21hcmdpbjo2cHggMCcsCiAgICBjZWxsOiAnYm9yZGVyOjFweCBzb2xpZCAjYzRjN2M1O3BhZGRpbmc6NHB4IDhweDt2ZXJ0aWNhbC1hbGlnbjp0b3A7dGV4dC1hbGlnbjpsZWZ0JywKICAgIHRoOiAnYmFja2dyb3VuZDojZjFmM2Y0O2ZvbnQtd2VpZ2h0OmJvbGQnLAogIH07CgogIC8vIEEgdGFibGUgYXMgR21haWwgYW",
"5kIGFueSBtYWlsIGNsaWVudCBzaG93cyBvbmUsIHN0eWxlZCBpbmxpbmU7IHRoZQogIC8vIGhlYWRpbmcgcm93IGluIDx0aGVhZD4sIGFzIDx0aD4uCiAgZnVuY3Rpb24gdGFibGVIdG1sKGIpIHsKICAgIGNvbnN0IGNlbGwgPSAoYywgaywgdGFnKSA9PiB7CiAgICAgIGNvbnN0IGFsaWduID0gYi5hbGlnbltrXSA_IGA7dGV4dC1hbGlnbjoke2IuYWxpZ25ba119YCA6ICcnOwogICAgICBjb25zdCBzdHlsZSA9IGAke1NUWUxFLmNlbGx9JHt0YWcgPT09ICd0aCcgPyBgOyR7U1RZTEUudGh9YCA6ICcnfSR7YWxpZ259YDsKICAgICAgcmV0dXJuIGA8JHt0YWd9IHN0eWxlPSIke3N0eWxlfSI-JHtydW5zSHRtbChjLnJ1bnMpIHx8ICc8YnI-J308LyR7dGFnfT5gOwogICAgfTsKICAgIGNvbnN0IHJvdyA9IChyLCB0YWcpID0-IGA8dHI-JHtyLm1hcCgoYywgaykgPT4gY2VsbChjLCBrLCB0YWcpKS5qb2luKCcnKX08L3RyPmA7CiAgICBjb25zdCBib2R5ID0gYi5yb3dzLnNsaWNlKGIuaGVhZCA_IDEgOiAwKTsKICAgIHJldHVybiBgPHRhYmxlIGRhdGEtZ2tiLXRhYmxlPSIxIiBzdHlsZT0iJHtTVFlMRS50YWJsZX0iPmAgKwogICAgICAoYi5oZWFkID8gYDx0aGVhZD4ke3JvdyhiLnJvd3NbMF0sICd0aCcpfTwvdGhlYWQ-YCA6ICcnKSArCiAgICAgIChib2R5Lmxlbmd0aCA_IGA8dGJvZHk-JHtib2R5Lm1hcChyID0-IHJvdyhyLCAndGQnKSkuam9pbignJyl9PC90Ym9keT5gIDogJycpICsgJzwvdGFibGU-JzsKICB9CgogIG",
"Z1bmN0aW9uIHRvSHRtbChkb2NJbikgewogICAgY29uc3QgZG9jID0gbm9ybWFsaXNlRG9jKGRvY0luKTsKICAgIGNvbnN0IHN0YWNrID0gW107IC8vIG9wZW4gbGlzdHMsIG9uZSBwZXIgbGV2ZWw6IHsgdGFnLCBjaGVjayB9CiAgICBsZXQgb3V0ID0gYDxkaXYgZGF0YS1na2Itbm90ZT0iMSIgc3R5bGU9IiR7U1RZTEUuZG9jfSI-YDsKICAgIGNvbnN0IGNsb3NlID0gKCkgPT4geyBvdXQgKz0gYDwvbGk-PC8ke3N0YWNrLnBvcCgpLnRhZ30-YDsgfTsKCiAgICBmb3IgKGNvbnN0IGIgb2YgZG9jKSB7CiAgICAgIGlmIChiLnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSBjbG9zZSgpOwogICAgICAgIG91dCArPSBgJHt0YWJsZUh0bWwoYil9XG5gOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IGlubmVyID0gcnVuc0h0bWwoYi5ydW5zKTsKICAgICAgaWYgKCFMSVNUUy5oYXMoYi50eXBlKSkgewogICAgICAgIHdoaWxlIChzdGFjay5sZW5ndGgpIGNsb3NlKCk7CiAgICAgICAgb3V0ICs9IGA8JHtiLnR5cGV9IHN0eWxlPSIke1NUWUxFW2IudHlwZV19Ij4ke2lubmVyIHx8ICc8YnI-J308LyR7Yi50eXBlfT5cbmA7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgY29uc3QgdGFnID0gYi50eXBlID09PSAnb2wnID8gJ29sJyA6ICd1bCc7CiAgICAgIGNvbnN0IGNoZWNrID0gYi50eXBlID09PSAnY2hlY2snOwogICAgICB3aGlsZSAoc3RhY2subGVuZ3",
"RoID4gYi5sZXZlbCArIDEpIGNsb3NlKCk7CiAgICAgIGlmIChzdGFjay5sZW5ndGggPT09IGIubGV2ZWwgKyAxKSB7CiAgICAgICAgY29uc3QgdG9wID0gc3RhY2tbc3RhY2subGVuZ3RoIC0gMV07CiAgICAgICAgaWYgKHRvcC50YWcgIT09IHRhZyB8fCB0b3AuY2hlY2sgIT09IGNoZWNrKSBjbG9zZSgpOwogICAgICAgIGVsc2Ugb3V0ICs9ICc8L2xpPic7CiAgICAgIH0KICAgICAgaWYgKHN0YWNrLmxlbmd0aCA9PT0gYi5sZXZlbCkgewogICAgICAgIG91dCArPSBjaGVjayA_IGA8dWwgZGF0YS1jaGVjaz0iMSIgc3R5bGU9IiR7U1RZTEUuY2hlY2t9Ij5gIDogYDwke3RhZ30gc3R5bGU9IiR7U1RZTEUubGlzdH0iPmA7CiAgICAgICAgc3RhY2sucHVzaCh7IHRhZywgY2hlY2sgfSk7CiAgICAgIH0KICAgICAgY29uc3QgZ2x5cGggPSBjaGVjayA_IGA8c3BhbiBkYXRhLWdseXBoPSIxIj4ke2IuY2hlY2tlZCA_IFRJQ0tFRCA6IEJPWH0mbmJzcDs8L3NwYW4-YCA6ICcnOwogICAgICBvdXQgKz0gYDxsaSBzdHlsZT0iJHtTVFlMRS5saX0iJHtjaGVjayA_IGAgZGF0YS1jaGVja2VkPSIke2IuY2hlY2tlZCA_IDEgOiAwfSJgIDogJyd9PiR7Z2x5cGh9JHtpbm5lciB8fCAoY2hlY2sgPyAnJyA6ICc8YnI-Jyl9YDsKICAgIH0KICAgIHdoaWxlIChzdGFjay5sZW5ndGgpIGNsb3NlKCk7CiAgICByZXR1cm4gYCR7b3V0fTwvZGl2PmA7CiAgfQoKICAvLyDilIDilIAgUGxhaW4gdGV4dCBvdXQg4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHJ1bnNQbGFpbihydW5zKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJ1bnMubGVuZ3RoOykgewogICAgICBjb25zdCBocmVmID0gcnVuc1tpXS5ocmVmIHx8ICcnOwogICAgICBsZXQgaiA9IGk7CiAgICAgIGxldCB0ZXh0ID0gJyc7CiAgICAgIHdoaWxlIChqIDwgcnVucy5sZW5ndGggJiYgKHJ1bnNbal0uaHJlZiB8fCAnJykgPT09IGhyZWYpIHRleHQgKz0gcnVuc1tqKytdLnRleHQ7CiAgICAgIGNvbnN0IGJhcmUgPSBocmVmLnJlcGxhY2UoL15tYWlsdG86LywgJycpOwogICAgICBjb25zdCBzYW1lID0gcyA9PiBzLnRyaW0oKS5yZXBsYWNlKC9eKGh0dHBzPzpcL1wvfG1haWx0bzopLywgJycpLnJlcGxhY2UoL1wvJC8sICcnKTsKICAgICAgb3V0ICs9IGhyZWYgJiYgc2FtZSh0ZXh0KSAhPT0gc2FtZShocmVmKSA_IGAke3RleHR9ICgke2JhcmV9KWAgOiB0ZXh0OwogICAgICBpID0gajsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBBIHRhYmxlIGFzIHBsYWluIHRleHQ6IGEgcm93IGEgbGluZSwgIiB8ICIgYmV0d2VlbiBpdHMgY2VsbHMgLSB3aGF0CiAgLy8gR21haWwncyBwcmV2aWV3cyBhbmQgYSBwbGFpbi",
"10ZXh0IG1haWwgY2xpZW50IHNob3cuIChUaGUgSFRNTCBwYXJ0IGlzCiAgLy8gdGhlIHJlY29yZDsgdGhpcyBvbmx5IGhhcyB0byByZWFkIHdlbGwuKQogIGZ1bmN0aW9uIHRhYmxlUGxhaW4oYikgewogICAgY29uc3QgY2VsbCA9IGMgPT4gcnVuc1BsYWluKGMucnVucykucmVwbGFjZSgvXG4vZywgJyAnKS50cmltKCk7CiAgICByZXR1cm4gYi5yb3dzLm1hcChyID0-IHIubWFwKGNlbGwpLmpvaW4oJyB8ICcpKS5qb2luKCdcbicpOwogIH0KCiAgZnVuY3Rpb24gdG9QbGFpbihkb2NJbikgewogICAgY29uc3QgZG9jID0gbm9ybWFsaXNlRG9jKGRvY0luKTsKICAgIGNvbnN0IGNvdW50ZXJzID0gWzAsIDAsIDAsIDBdOwogICAgcmV0dXJuIGRvYy5tYXAoYiA9PiB7CiAgICAgIGlmIChiLnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICBjb3VudGVycy5maWxsKDApOwogICAgICAgIHJldHVybiB0YWJsZVBsYWluKGIpOwogICAgICB9CiAgICAgIGNvbnN0IHRleHQgPSBydW5zUGxhaW4oYi5ydW5zKTsKICAgICAgaWYgKCFMSVNUUy5oYXMoYi50eXBlKSkgewogICAgICAgIGNvdW50ZXJzLmZpbGwoMCk7CiAgICAgICAgcmV0dXJuIHRleHQ7CiAgICAgIH0KICAgICAgY29uc3QgcGFkID0gJyAgJy5yZXBlYXQoYi5sZXZlbCk7CiAgICAgIGZvciAobGV0IGwgPSBiLmxldmVsICsgMTsgbCA8IGNvdW50ZXJzLmxlbmd0aDsgbCsrKSBjb3VudGVyc1tsXSA9IDA7CiAgICAgIGlmIChiLnR5cGUgPT09ICdvbCcpIHJldHVybiBgJH",
"twYWR9JHsrK2NvdW50ZXJzW2IubGV2ZWxdfS4gJHt0ZXh0fWA7CiAgICAgIGNvdW50ZXJzW2IubGV2ZWxdID0gMDsKICAgICAgaWYgKGIudHlwZSA9PT0gJ2NoZWNrJykgcmV0dXJuIGAke3BhZH0ke2IuY2hlY2tlZCA_IFRJQ0tFRCA6IEJPWH0gJHt0ZXh0fWA7CiAgICAgIHJldHVybiBgJHtwYWR9JHtCVUxMRVR9ICR7dGV4dH1gOwogICAgfSkuam9pbignXG4nKTsKICB9CgogIC8vIOKUgOKUgCBQbGFpbiB0ZXh0IGluIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBBIHBsYWluIG5vdGUgKGZyb20gYmVmb3JlIGZvcm1hdHRpbmcgZXhpc3RlZCwgb3IgcGxhaW4gbWFpbCkgYmVjb21lcwogIC8vIG9uZSBibG9jayBwZXIgbGluZS4gTGluZXMgdGhhdCBhbHJlYWR5IGxvb2sgbGlrZSBsaXN0cyAtICItICIsICLigKIgIiwKICAvLyAiMS4gIiwgIuKYkCAiIC0gYmVjb21lIGxpc3RzLCBpbmRlbnRlZCB0d28gc3BhY2VzIGEgbGV2ZWwuCiAgZnVuY3Rpb24gZnJvbVBsYWluKHRleHQpIHsKICAgIGNvbnN0IGxpbmVzID0gU3RyaW5nKHRleHQgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNwbGl0KCdcbicpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID",
"0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7CiAgICAgIC8vIFR3byBvciBtb3JlIHwgYSB8IGIgfCBsaW5lcywgb3Igb25lIHdpdGggYSB8LS0tfCBsaW5lIHVuZGVyIGl0OiBhIHRhYmxlLgogICAgICBjb25zdCB0ID0gcGlwZVRhYmxlKGxpbmVzLCBpLCBzID0-IFt7IHRleHQ6IHMgfV0pOwogICAgICBpZiAodCAmJiAodC5lbmQgLSBpID4gMSB8fCB0LmJsb2NrLmhlYWQpKSB7CiAgICAgICAgb3V0LnB1c2godC5ibG9jayk7CiAgICAgICAgaSA9IHQuZW5kIC0gMTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBjb25zdCBsaW5lID0gbGluZXNbaV07CiAgICAgIGNvbnN0IG0gPSAvXiggKikoPzooWy0q4oCiXSl8KFxkezEsM30pWy4pXXwoW-KYkOKYkV0pKSAoLiopJC8uZXhlYyhsaW5lKTsKICAgICAgaWYgKCFtKSB7IG91dC5wdXNoKGJsb2NrKCdwJywgW3sgdGV4dDogbGluZSB9XSkpOyBjb250aW51ZTsgfQogICAgICBjb25zdCBsZXZlbCA9IE1hdGguZmxvb3IobVsxXS5sZW5ndGggLyAyKTsKICAgICAgaWYgKG1bNF0pIG91dC5wdXNoKGJsb2NrKCdjaGVjaycsIFt7IHRleHQ6IG1bNV0gfV0sIHsgbGV2ZWwsIGNoZWNrZWQ6IG1bNF0gPT09IFRJQ0tFRCB9KSk7CiAgICAgIGVsc2Ugb3V0LnB1c2goYmxvY2sobVszXSA_ICdvbCcgOiAndWwnLCBbeyB0ZXh0OiBtWzVdIH1dLCB7IGxldmVsIH0pKTsKICAgIH0KICAgIHJldHVybiBub3JtYWxpc2VEb2Mob3V0KTsKICB9CgogIC8vIOKUgOKUgCBQaX",
"BlIHRhYmxlcyAoTWFya2Rvd24ncywgYW5kIHRoZSBwbGFpbiB0ZXh0IGFib3ZlKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgUElQRV9ST1cgPSAvXlxzKlx8LipcfFxzKiQvOwogIGNvbnN0IFBJUEVfUlVMRSA9IC9eXHMqXHw_XHMqOj8tezMsfTo_XHMqKFx8XHMqOj8tezMsfTo_XHMqKSpcfD9ccyokLzsKICBjb25zdCBwaXBlQ2VsbHMgPSBsaW5lID0-IGxpbmUudHJpbSgpLnJlcGxhY2UoL15cfC8sICcnKS5yZXBsYWNlKC9cfCQvLCAnJykuc3BsaXQoLyg_PCFcXClcfC8pLm1hcChjID0-IGMudHJpbSgpLnJlcGxhY2UoL1xcXHwvZywgJ3wnKSk7CgogIC8vIFRoZSB0YWJsZSBvZiB8IHJvd3Mgc3RhcnRpbmcgYXQgbGluZXNbaV0sIG9yIG51bGw6IHsgYmxvY2ssIGVuZCB9LgogIC8vIEEgfC0tLXwgbGluZSB1bmRlciB0aGUgZmlyc3Qgcm93IG1ha2VzIGl0IGEgaGVhZGluZyByb3cgYW5kIGdpdmVzIHRoZQogIC8vIGNvbHVtbnMnIGFsaWdubWVudDsgIjxicj4iIGluIGEgY2VsbCBpcyBhIGxpbmUgYnJlYWsuCiAgZnVuY3Rpb24gcGlwZVRhYmxlKGxpbmVzLCBpLCBpbmxpbmUpIHsKICAgIGlmICghUElQRV9ST1cudGVzdChsaW5lc1tpXSB8fCAnJykgfHwgUElQRV9SVUxFLnRlc3QobGluZXNbaV0pKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHJvd3MgPSBbXTsKICAgIGxldCBoZWFkID0gZmFsc2U7CiAgICBsZXQgYWxpZ24gPSBbXTsKICAgIGxldCBqID0gaTsKIC",
"AgIGZvciAoOyBqIDwgbGluZXMubGVuZ3RoICYmIFBJUEVfUk9XLnRlc3QobGluZXNbal0pOyBqKyspIHsKICAgICAgaWYgKFBJUEVfUlVMRS50ZXN0KGxpbmVzW2pdKSkgewogICAgICAgIGlmIChyb3dzLmxlbmd0aCA9PT0gMSAmJiAhaGVhZCkgewogICAgICAgICAgaGVhZCA9IHRydWU7CiAgICAgICAgICBhbGlnbiA9IHBpcGVDZWxscyhsaW5lc1tqXSkubWFwKGMgPT4gKC9eOi0rOiQvLnRlc3QoYykgPyAnY2VudGVyJyA6IC9eLSs6JC8udGVzdChjKSA_ICdyaWdodCcgOiAnJykpOwogICAgICAgIH0KICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICByb3dzLnB1c2gocGlwZUNlbGxzKGxpbmVzW2pdKS5tYXAoYyA9PiAoeyBydW5zOiBpbmxpbmUoYy5yZXBsYWNlKC88YnJccypcLz8-L2dpLCAnXG4nKSkgfSkpKTsKICAgIH0KICAgIHJldHVybiB7IGJsb2NrOiB0YWJsZShyb3dzLCB7IGhlYWQsIGFsaWduIH0pLCBlbmQ6IGogfTsKICB9CgogIC8vIOKUgOKUgCBIVE1MIGluIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBUT0tFTl9SRSA9IC88IS0tW1xzXFNdKj8tLT58PCFcW0NEQVRBXFtbXHNcU10qP1xdXF0-fDwhW14-XSo-fD",
"xcP1tePl0qPnw8KFwvPykoW2EtekEtWl1bYS16QS1aMC05Oi1dKikoKD86XHMrW15ccyInPi89XSsoPzpccyo9XHMqKD86IlteIl0qInwnW14nXSonfFteXHMiJz08PmBdKykpPykqKVxzKihcLz8pPnxbXjxdK3w8L2c7CiAgY29uc3QgQVRUUl9SRSA9IC8oW15ccyInPi89XSspKD86XHMqPVxzKig_OiIoW14iXSopInwnKFteJ10qKSd8KFteXHMiJz08PmBdKykpKT8vZzsKICBjb25zdCBTS0lQID0gbmV3IFNldChbJ3NjcmlwdCcsICdzdHlsZScsICdoZWFkJywgJ3RpdGxlJywgJ3RlbXBsYXRlJywgJ3N2ZycsICdtYXRoJywgJ25vc2NyaXB0JywgJ2lmcmFtZScsICdvYmplY3QnLCAneG1sJ10pOwogIGNvbnN0IFBBUkEgPSBuZXcgU2V0KFsncCcsICdkaXYnLCAnYmxvY2txdW90ZScsICdwcmUnLCAnc2VjdGlvbicsICdhcnRpY2xlJywgJ2hlYWRlcicsICdmb290ZXInLCAnbWFpbicsICdhc2lkZScsCiAgICAnbmF2JywgJ3RhYmxlJywgJ3Rib2R5JywgJ3RoZWFkJywgJ3Rmb290JywgJ2NlbnRlcicsICdkbCcsICdkdCcsICdkZCcsICdmaWd1cmUnLCAnZmlnY2FwdGlvbicsCiAgICAnZm9ybScsICdmaWVsZHNldCcsICdhZGRyZXNzJywgJ2hyJywgJ2JvZHknLCAnaHRtbCcsICdjYXB0aW9uJ10pOwogIC8vIFRhZ3MgdGhhdCBtYXJrIHRleHQsIGFuZCB0aGUgbWFya3MgdGhleSBzdGFuZCBmb3IuIHNwYW4gYW5kIGZvbnQKICAvLyBjYXJyeSB0aGVpcnMgaW4gYSBzdHlsZSBhdHRyaWJ1dGUsIGlmIGF0IGFsbC4KICBjb2",
"5zdCBJTkxJTkUgPSB7CiAgICBiOiBbJ2InXSwgc3Ryb25nOiBbJ2InXSwgaTogWydpJ10sIGVtOiBbJ2knXSwgY2l0ZTogWydpJ10sIHM6IFsncyddLCBzdHJpa2U6IFsncyddLCBkZWw6IFsncyddLCBzcGFuOiBbXSwgZm9udDogW10sCiAgfTsKICBjb25zdCBIRUFESU5HUyA9IHsgaDE6ICdoMScsIGgyOiAnaDInLCBoMzogJ2gzJywgaDQ6ICdoMycsIGg1OiAnaDMnLCBoNjogJ2gzJyB9OwoKICBmdW5jdGlvbiBhdHRyc09mKHMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgbGV0IG07CiAgICBBVFRSX1JFLmxhc3RJbmRleCA9IDA7CiAgICB3aGlsZSAoKG0gPSBBVFRSX1JFLmV4ZWMocyB8fCAnJykpKSB7CiAgICAgIG91dFttWzFdLnRvTG93ZXJDYXNlKCldID0gdXRpbC5kZWNvZGVFbnRpdGllcyhtWzJdICE9PSB1bmRlZmluZWQgPyBtWzJdIDogbVszXSAhPT0gdW5kZWZpbmVkID8gbVszXSA6IG1bNF0gfHwgJycpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIEJvbGQsIGl0YWxpYyBhbmQgc3RyaWtlLXRocm91Z2ggd3JpdHRlbiBhcyBpbmxpbmUgc3R5bGVzLCBhcyBPdXRsb29rCiAgLy8gYW5kIHBhc3RlZCB3ZWIgdGV4dCBvZnRlbiBkbywgY291bnQgdGhlIHNhbWUgYXMgdGhlIHRhZ3MuCiAgZnVuY3Rpb24gc3R5bGVNYXJrcyhzdHlsZSkgewogICAgY29uc3QgcyA9IFN0cmluZyhzdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgIGNvbnN0IG1hcmtzID0gW107CiAgICBpZiAoL2ZvbnQtd2",
"VpZ2h0XHMqOlxzKihib2xkfGJvbGRlcnxbNi05XTAwKS8udGVzdChzKSkgbWFya3MucHVzaCgnYicpOwogICAgaWYgKC9mb250LXN0eWxlXHMqOlxzKml0YWxpYy8udGVzdChzKSkgbWFya3MucHVzaCgnaScpOwogICAgaWYgKC90ZXh0LWRlY29yYXRpb24oLWxpbmUpP1xzKjpbXjtdKmxpbmUtdGhyb3VnaC8udGVzdChzKSkgbWFya3MucHVzaCgncycpOwogICAgcmV0dXJuIG1hcmtzOwogIH0KCiAgLy8gV2hldGhlciBhIGJyb3dzZXIgd291bGQgc2hvdyBzcGFjZSBiZWxvdyBhIDxwPjogaXQgZG9lcyB1bmxlc3MgaXRzCiAgLy8gc3R5bGUgc2F5cyBvdGhlcndpc2UuIFdvcmQgYW5kIE91dGxvb2sgcGFyYWdyYXBocyAoTXNvTm9ybWFsKSBhcmUKICAvLyBsaW5lcywgYW5kIHNvIGFyZSB0aGUgZWRpdG9yJ3Mgb3duIGFuZCBHb29nbGUgRG9jcycuCiAgZnVuY3Rpb24gcGFyYUdhcChhKSB7CiAgICBpZiAoL1xiTXNvLy50ZXN0KGEuY2xhc3MgfHwgJycpKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBzdHlsZSA9IFN0cmluZyhhLnN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgemVybyA9IHYgPT4gL14tPzAoXC4wKyk_KFthLXpdK3wlKT8kLy50ZXN0KHYgfHwgJycpOwogICAgY29uc3QgYm90dG9tID0gLyg_Ol58OylccyptYXJnaW4tYm90dG9tXHMqOlxzKihbXjshXSspLy5leGVjKHN0eWxlKTsKICAgIGlmIChib3R0b20pIHJldHVybiAhemVybyhib3R0b21bMV0udHJpbSgpKTsKICAgIGNvbnN0IG",
"FsbCA9IC8oPzpefDspXHMqbWFyZ2luXHMqOlxzKihbXjshXSspLy5leGVjKHN0eWxlKTsKICAgIGlmIChhbGwpIHsKICAgICAgY29uc3QgdiA9IGFsbFsxXS50cmltKCkuc3BsaXQoL1xzKy8pOwogICAgICByZXR1cm4gIXplcm8odi5sZW5ndGggPj0gMyA_IHZbMl0gOiB2WzBdKTsKICAgIH0KICAgIHJldHVybiB0cnVlOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VIdG1sKGh0bWwpIHsKICAgIGNvbnN0IGJsb2NrcyA9IFtdOwogICAgY29uc3QgbGlzdHMgPSBbXTsgICAgICAgICAvLyBvcGVuIGxpc3RzOiB7IHR5cGUsIGxpT3BlbiB9CiAgICBjb25zdCBtYXJrcyA9IHsgYjogMCwgaTogMCwgczogMCB9OwogICAgY29uc3QgaHJlZnMgPSBbXTsKICAgIGNvbnN0IGlubGluZSA9IFtdOyAgICAgICAgLy8gb3BlbiBpbmxpbmUgdGFnczogeyBuYW1lLCBtYXJrcyB9IG9yIHsgbmFtZSwgZ2x5cGg6IHRydWUgfQogICAgbGV0IHNraXAgPSAwOwogICAgbGV0IGdseXBoID0gMDsKICAgIGxldCBjdXIgPSBudWxsOwogICAgLy8gVGhlIG9wZW4gdGFibGUsIGlmIGFueTogeyBiLCByb3csIGNlbGwsIHRoZWFkLCBkZXB0aCB9LiBJdHMgdGV4dCBnb2VzCiAgICAvLyBpbnRvIGl0cyBjZWxsczsgYSB0YWJsZSBpbnNpZGUgYSBjZWxsIGlzIHJlYWQgaW50byB0aGF0IGNlbGwgYXMgdGV4dCwKICAgIC8vIGEgcm93IGEgbGluZSAoZGVwdGggY291bnRzIHRob3NlKS4KICAgIGxldCB0YmwgPSBudWxsOwogICAgbGV0IHByZSA9IDA7ICAgIC",
"AgICAgICAgICAvLyBpbnNpZGUgPHByZT46IGxpbmUgYnJlYWtzIGFuZCBzcGFjZXMgYXJlIHRleHQKICAgIGxldCBwYXJhID0gbnVsbDsgICAgICAgICAgLy8gdGhlIG9wZW4gPHA-OiB7IGdhcCB9CiAgICBsZXQgZ2FwID0gZmFsc2U7ICAgICAgICAgIC8vIGEgPHA-IGp1c3QgY2xvc2VkIHdpdGggc3BhY2UgYmVsb3cgaXQKICAgIGxldCBvdXJzID0gZmFsc2U7ICAgICAgICAgLy8gaW5zaWRlIGEgbm90ZSdzIG93biBIVE1MLCB3aGVyZSBwYXJhZ3JhcGhzIGFyZSBsaW5lcwoKICAgIGNvbnN0IGxldmVsID0gKCkgPT4gTWF0aC5tYXgoMCwgbGlzdHMubGVuZ3RoIC0gMSk7CiAgICBjb25zdCBvcGVuID0gKHR5cGUsIGV4dHJhKSA9PiB7CiAgICAgIC8vIFRoZSBzcGFjZSBhIGJyb3dzZXIgc2hvd3MgYWZ0ZXIgYSBwYXJhZ3JhcGggaXMgYW4gZW1wdHkgbGluZSBpbiBhCiAgICAgIC8vIG5vdGUgLSB3aGljaCBoYXMgbm8gc3BhY2UgYmV0d2VlbiBwYXJhZ3JhcGhzIC0gZXhjZXB0IGJlZm9yZSBhCiAgICAgIC8vIGhlYWRpbmcsIHdoaWNoIGhhcyBpdHMgb3duLgogICAgICBpZiAoZ2FwKSB7CiAgICAgICAgZ2FwID0gZmFsc2U7CiAgICAgICAgY29uc3QgbGFzdCA9IGJsb2Nrc1tibG9ja3MubGVuZ3RoIC0gMV07CiAgICAgICAgaWYgKGxhc3QgJiYgIUhFQURJTkdTW3R5cGVdICYmIGxhc3QucnVucy5zb21lKHIgPT4gL1xTLy50ZXN0KHIudGV4dCkpKSBibG9ja3MucHVzaChibG9jaygncCcpKTsKICAgICAgfQogICAgIC",
"BjdXIgPSBibG9jayh0eXBlLCBbXSwgZXh0cmEpOwogICAgICBibG9ja3MucHVzaChjdXIpOwogICAgICByZXR1cm4gY3VyOwogICAgfTsKICAgIGNvbnN0IGVuZCA9ICgpID0-IHsgY3VyID0gbnVsbDsgfTsKICAgIC8vIFdoZXJlIHRleHQgbGFuZHMgd2hlbiBubyBibG9jayBpcyBvcGVuOiBpbnNpZGUgYSBsaXN0IGl0ZW0sIGEKICAgIC8vIGNvbnRpbnVhdGlvbiBvZiB0aGF0IGl0ZW07IG90aGVyd2lzZSBhIG5ldyBwYXJhZ3JhcGguCiAgICBjb25zdCBjb250ZXh0ID0gKCkgPT4gewogICAgICBjb25zdCB0b3AgPSBsaXN0c1tsaXN0cy5sZW5ndGggLSAxXTsKICAgICAgaWYgKHRvcCAmJiB0b3AubGlPcGVuKSByZXR1cm4gb3Blbih0b3AudHlwZSwgeyBsZXZlbDogbGV2ZWwoKSwgY2hlY2tlZDogZmFsc2UgfSk7CiAgICAgIHJldHVybiBvcGVuKCdwJyk7CiAgICB9OwogICAgY29uc3QgYXBwbHkgPSAobGlzdCwgZGVsdGEpID0-IGxpc3QuZm9yRWFjaChtID0-IHsgbWFya3NbbV0gKz0gZGVsdGE7IH0pOwogICAgY29uc3QgcnVuID0gdGV4dCA9PiAoeyB0ZXh0LCBiOiBtYXJrcy5iID4gMCwgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLCBocmVmOiBocmVmcy5sZW5ndGggPyBocmVmc1tocmVmcy5sZW5ndGggLSAxXSA6ICcnIH0pOwogICAgLy8gSW5zaWRlIGEgdGFibGU6IHRoZSBvcGVuIGNlbGwncyBydW5zLCBvciBudWxsIGJldHdlZW4gY2VsbHMuCiAgICBjb25zdCBjZWxsUnVucyA9ICgpID0-ICh0Ym",
"wgJiYgdGJsLmNlbGwgPyB0YmwuY2VsbC5ydW5zIDogbnVsbCk7CiAgICAvLyBBIGxpbmUgYnJlYWsgaW4gdGhlIG9wZW4gY2VsbCwgdW5sZXNzIGl0IGlzIGVtcHR5IG9yIGp1c3QgaGFkIG9uZS4KICAgIGNvbnN0IGNlbGxCcmVhayA9ICgpID0-IHsKICAgICAgY29uc3QgcnVucyA9IGNlbGxSdW5zKCk7CiAgICAgIGlmICghcnVucyB8fCAhcnVucy5sZW5ndGgpIHJldHVybjsKICAgICAgY29uc3QgbGFzdCA9IHJ1bnNbcnVucy5sZW5ndGggLSAxXTsKICAgICAgaWYgKCEvXG4kLy50ZXN0KGxhc3QudGV4dCkpIHJ1bnMucHVzaChydW4oJ1xuJykpOwogICAgfTsKICAgIGNvbnN0IHJvd3NTZWVuID0gW107CiAgICBjb25zdCBjbG9zZUNlbGwgPSAoKSA9PiB7CiAgICAgIGlmICghdGJsIHx8ICF0YmwuY2VsbCkgcmV0dXJuOwogICAgICBhcHBseSh0YmwuY2VsbC5tYXJrcywgLTEpOwogICAgICB0YmwuY2VsbCA9IG51bGw7CiAgICB9OwogICAgLy8gVGhlIHRhYmxlIGRvbmU6IGVtcHR5IHJvd3MgZ29uZSwgdGhlIGhlYWRpbmcgcm93IGFuZCB0aGUgY29sdW1ucycKICAgIC8vIGFsaWdubWVudCB3b3JrZWQgb3V0IGZyb20gdGhlIGNlbGxzLgogICAgY29uc3QgZmluaXNoVGFibGUgPSAoKSA9PiB7CiAgICAgIGNsb3NlQ2VsbCgpOwogICAgICBjb25zdCB0ID0gdGJsOwogICAgICB0YmwgPSBudWxsOwogICAgICBjb25zdCByb3dzID0gcm93c1NlZW4uZmlsdGVyKHIgPT4gci5jZWxscy5sZW5ndGggJiYgdC5iLnJvd3MuaW",
"5kZXhPZihyLmNlbGxzKSA-PSAwKTsKICAgICAgcm93c1NlZW4ubGVuZ3RoID0gMDsKICAgICAgdC5iLnJvd3MgPSByb3dzLm1hcChyID0-IHIuY2VsbHMpOwogICAgICBpZiAoIXJvd3MubGVuZ3RoKSB7IGJsb2Nrcy5zcGxpY2UoYmxvY2tzLmluZGV4T2YodC5iKSwgMSk7IHJldHVybjsgfQogICAgICBjb25zdCBmaXJzdCA9IHJvd3NbMF07CiAgICAgIHQuYi5oZWFkID0gZmlyc3QudGhlYWQgfHwgKGZpcnN0LnRoICYmIGZpcnN0LmNlbGxzLnNvbWUoYyA9PiBjLnRoKSAmJiByb3dzLmxlbmd0aCA-IDEpOwogICAgICBjb25zdCBjb2xzID0gTWF0aC5tYXgoLi4ucm93cy5tYXAociA9PiByLmNlbGxzLmxlbmd0aCkpOwogICAgICB0LmIuYWxpZ24gPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiBjb2xzIH0sIChfLCBrKSA9PiB7CiAgICAgICAgY29uc3Qgc2VlbiA9IHJvd3Muc2xpY2UodC5iLmhlYWQgPyAxIDogMCkubWFwKHIgPT4gci5jZWxsc1trXSAmJiByLmNlbGxzW2tdLmFsaWduKS5maWx0ZXIoeCA9PiB4ICE9PSB1bmRlZmluZWQpOwogICAgICAgIHJldHVybiBzZWVuLmxlbmd0aCAmJiBzZWVuLmV2ZXJ5KHggPT4geCA9PT0gc2VlblswXSkgPyBzZWVuWzBdIDogJyc7CiAgICAgIH0pOwogICAgICAvLyBCb2xkIHRoYXQgYSBoZWFkaW5nIGNlbGwgaXMgYW55d2F5LCBhbmQgYSBoZWFkaW5nIGNlbGwgaW4gYSBsYXRlcgogICAgICAvLyByb3cgKGEgcm93J3MgbGFiZWwpLCB3cml0dGVuIGFzIGJvbGQuCiAgICAgIHJvd3",
"MuZm9yRWFjaCgociwgaSkgPT4gci5jZWxscy5mb3JFYWNoKGMgPT4gewogICAgICAgIGlmIChjLnRoICYmICEoaSA9PT0gMCAmJiB0LmIuaGVhZCkpIGMucnVucy5mb3JFYWNoKHggPT4geyB4LmIgPSB0cnVlOyB9KTsKICAgICAgfSkpOwogICAgfTsKCiAgICBsZXQgbTsKICAgIFRPS0VOX1JFLmxhc3RJbmRleCA9IDA7CiAgICB3aGlsZSAoKG0gPSBUT0tFTl9SRS5leGVjKFN0cmluZyhodG1sIHx8ICcnKSkpKSB7CiAgICAgIGNvbnN0IFt3aG9sZSwgY2xvc2luZywgcmF3TmFtZSwgcmF3QXR0cnMsIHNlbGZDbG9zaW5nXSA9IG07CiAgICAgIGlmIChyYXdOYW1lID09PSB1bmRlZmluZWQpIHsKICAgICAgICBpZiAod2hvbGVbMF0gPT09ICc8JyAmJiB3aG9sZS5sZW5ndGggPiAxKSBjb250aW51ZTsgLy8gY29tbWVudCwgZG9jdHlwZSwgQ0RBVEEKICAgICAgICBpZiAoc2tpcCkgY29udGludWU7CiAgICAgICAgaWYgKGdseXBoKSB7CiAgICAgICAgICAvLyBXb3JkJ3MgbGlzdCBtYXJrZXIgKCLCtyIsICIxLiIsICJhKSIpOiBub3QgdGV4dCwgYnV0IGl0IHNheXMKICAgICAgICAgIC8vIHdoZXRoZXIgdGhlIGxpc3QgaXMgYnVsbGV0ZWQgb3IgbnVtYmVyZWQuCiAgICAgICAgICBpZiAoY3VyICYmIGN1ci53b3JkTGlzdCkgY3VyLm1hcmtlciArPSB1dGlsLmRlY29kZUVudGl0aWVzKHdob2xlKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAocHJlKSB7CiAgICAgICAgICAvLyBFYWNoIGxpbm",
"Ugb2YgcHJlZm9ybWF0dGVkIHRleHQgaXMgYSBsaW5lIG9mIHRoZSBub3RlLCBpdHMKICAgICAgICAgIC8vIHNwYWNlcyBrZXB0IChhcyAmbmJzcDssIHdoaWNoIHRoZSB0aWR5aW5nIGJlbG93IGxlYXZlcyBhbG9uZSkuCiAgICAgICAgICBsZXQgcmF3ID0gdXRpbC5kZWNvZGVFbnRpdGllcyh3aG9sZSkucmVwbGFjZSgvXHJcbj8vZywgJ1xuJyk7CiAgICAgICAgICBpZiAocHJlLmZyZXNoKSByYXcgPSByYXcucmVwbGFjZSgvXlxuLywgJycpOwogICAgICAgICAgcHJlLmZyZXNoID0gZmFsc2U7CiAgICAgICAgICBpZiAodGJsKSB7CiAgICAgICAgICAgIGlmIChjZWxsUnVucygpKSBjZWxsUnVucygpLnB1c2gocnVuKHJhdy5yZXBsYWNlKC9cdC9nLCAnICAgICcpKSk7CiAgICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgICAgfQogICAgICAgICAgcmF3LnNwbGl0KCdcbicpLmZvckVhY2goKGxpbmUsIGspID0-IHsKICAgICAgICAgICAgaWYgKGspIHsKICAgICAgICAgICAgICBlbmQoKTsKICAgICAgICAgICAgICBvcGVuKCdwJykucHJlTGluZSA9IHRydWU7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgaWYgKCFsaW5lKSByZXR1cm47CiAgICAgICAgICAgIGlmICghY3VyKSBjb250ZXh0KCk7CiAgICAgICAgICAgIGN1ci5ydW5zLnB1c2goewogICAgICAgICAgICAgIHRleHQ6IGxpbmUucmVwbGFjZSgvXHQvZywgJyAgICAnKS5yZXBsYWNlKC8gL2csICdcdTAwYTAnKSwKICAgICAgICAgICAgICBiOiBtYXJrcy5iID",
"4gMCwgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLAogICAgICAgICAgICAgIGhyZWY6IGhyZWZzLmxlbmd0aCA_IGhyZWZzW2hyZWZzLmxlbmd0aCAtIDFdIDogJycsCiAgICAgICAgICAgIH0pOwogICAgICAgICAgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3QgdGV4dCA9IHV0aWwuZGVjb2RlRW50aXRpZXMod2hvbGUgPT09ICc8JyA_ICc8JyA6IHdob2xlKS5yZXBsYWNlKC9bIFx0XHJcblxmXSsvZywgJyAnKTsKICAgICAgICBpZiAodGJsKSB7CiAgICAgICAgICAvLyBCZXR3ZWVuIGNlbGxzLCBvbmx5IHN0cmF5IHdoaXRlc3BhY2U6IG5vdGhpbmcuCiAgICAgICAgICBjb25zdCBydW5zID0gY2VsbFJ1bnMoKTsKICAgICAgICAgIGlmIChydW5zICYmIChydW5zLmxlbmd0aCB8fCAvW14gXHRcclxuXGZdLy50ZXN0KHRleHQpKSkgcnVucy5wdXNoKHJ1bih0ZXh0KSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKCFjdXIpIHsKICAgICAgICAgIC8vIE9ubHkgSFRNTCdzIG93biB3aGl0ZXNwYWNlIGlzIG5vdGhpbmc7IGFuICZuYnNwOyBpcyBhIHNwYWNlIHNvbWVvbmUgdHlwZWQuCiAgICAgICAgICBpZiAoIS9bXiBcdFxyXG5cZl0vLnRlc3QodGV4dCkpIGNvbnRpbnVlOwogICAgICAgICAgY29udGV4dCgpOwogICAgICAgIH0KICAgICAgICBjdXIucnVucy5wdXNoKHsKICAgICAgICAgIHRleHQsCiAgICAgICAgICBiOiBtYXJrcy5iID4gMC",
"wgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLAogICAgICAgICAgaHJlZjogaHJlZnMubGVuZ3RoID8gaHJlZnNbaHJlZnMubGVuZ3RoIC0gMV0gOiAnJywKICAgICAgICB9KTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQoKICAgICAgY29uc3QgbmFtZSA9IHJhd05hbWUudG9Mb3dlckNhc2UoKTsKICAgICAgY29uc3QgaXNDbG9zZSA9IGNsb3NpbmcgPT09ICcvJzsKICAgICAgaWYgKFNLSVAuaGFzKG5hbWUpKSB7CiAgICAgICAgaWYgKCFzZWxmQ2xvc2luZykgc2tpcCA9IE1hdGgubWF4KDAsIHNraXAgKyAoaXNDbG9zZSA_IC0xIDogMSkpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChza2lwKSBjb250aW51ZTsKICAgICAgY29uc3QgYSA9IGlzQ2xvc2UgPyB7fSA6IGF0dHJzT2YocmF3QXR0cnMpOwoKICAgICAgaWYgKG5hbWUgPT09ICdicicpIHsKICAgICAgICBpZiAodGJsKSB7CiAgICAgICAgICBjb25zdCBydW5zID0gY2VsbFJ1bnMoKTsKICAgICAgICAgIGlmIChydW5zKSBydW5zLnB1c2gocnVuKCdcbicpKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAoY3VyKSBlbmQoKTsKICAgICAgICBlbHNlIHsgY29udGV4dCgpOyBlbmQoKTsgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CgogICAgICAvLyDilIDilIAgVGFibGVzIOKUgOKUgAogICAgICBpZiAobmFtZSA9PT0gJ3RhYmxlJykgewogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgIC",
"BpZiAodGJsICYmIHRibC5kZXB0aCkgeyB0YmwuZGVwdGgtLTsgY2VsbEJyZWFrKCk7IGNvbnRpbnVlOyB9CiAgICAgICAgICBpZiAodGJsKSBmaW5pc2hUYWJsZSgpOwogICAgICAgICAgY29udGludWU7CiAgICAgICAgfQogICAgICAgIGlmICh0YmwpIHsgdGJsLmRlcHRoKys7IGNlbGxCcmVhaygpOyBjb250aW51ZTsgfQogICAgICAgIGVuZCgpOwogICAgICAgIHRibCA9IHsgYjogdGFibGUoW10sIHt9KSwgcm93OiBudWxsLCBjZWxsOiBudWxsLCB0aGVhZDogZmFsc2UsIGRlcHRoOiAwLCBoZWFkUm93OiB0cnVlIH07CiAgICAgICAgYmxvY2tzLnB1c2godGJsLmIpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICh0YmwgJiYgbmFtZSA9PT0gJ2NhcHRpb24nKSB7CiAgICAgICAgaWYgKCFzZWxmQ2xvc2luZykgc2tpcCA9IE1hdGgubWF4KDAsIHNraXAgKyAoaXNDbG9zZSA_IC0xIDogMSkpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICh0YmwgJiYgKG5hbWUgPT09ICd0aGVhZCcgfHwgbmFtZSA9PT0gJ3Rib2R5JyB8fCBuYW1lID09PSAndGZvb3QnIHx8IG5hbWUgPT09ICdjb2xncm91cCcgfHwgbmFtZSA9PT0gJ2NvbCcpKSB7CiAgICAgICAgaWYgKG5hbWUgPT09ICd0aGVhZCcgJiYgIXRibC5kZXB0aCkgdGJsLnRoZWFkID0gIWlzQ2xvc2U7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKHRibCAmJiBuYW1lID09PSAndHInKSB7CiAgICAgICAgaWYgKHRibC",
"5kZXB0aCkgeyBjZWxsQnJlYWsoKTsgY29udGludWU7IH0KICAgICAgICBjbG9zZUNlbGwoKTsKICAgICAgICB0Ymwucm93ID0gbnVsbDsKICAgICAgICBpZiAoIWlzQ2xvc2UpIHsKICAgICAgICAgIHRibC5yb3cgPSB7IGNlbGxzOiBbXSwgdGg6IHRydWUsIHRoZWFkOiB0YmwudGhlYWQgfTsKICAgICAgICAgIHRibC5iLnJvd3MucHVzaCh0Ymwucm93LmNlbGxzKTsKICAgICAgICAgIHJvd3NTZWVuLnB1c2godGJsLnJvdyk7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICh0YmwgJiYgKG5hbWUgPT09ICd0ZCcgfHwgbmFtZSA9PT0gJ3RoJykpIHsKICAgICAgICBpZiAodGJsLmRlcHRoKSB7CiAgICAgICAgICBpZiAoIWlzQ2xvc2UgJiYgY2VsbFJ1bnMoKSAmJiBjZWxsUnVucygpLmxlbmd0aCAmJiAhL1tcbiBdJC8udGVzdChjZWxsUnVucygpW2NlbGxSdW5zKCkubGVuZ3RoIC0gMV0udGV4dCkpIGNlbGxSdW5zKCkucHVzaChydW4oJyAnKSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY2xvc2VDZWxsKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UgfHwgc2VsZkNsb3NpbmcpIGNvbnRpbnVlOwogICAgICAgIGlmICghdGJsLnJvdykgewogICAgICAgICAgdGJsLnJvdyA9IHsgY2VsbHM6IFtdLCB0aDogdHJ1ZSwgdGhlYWQ6IHRibC50aGVhZCB9OwogICAgICAgICAgdGJsLmIucm93cy5wdXNoKHRibC5yb3cuY2VsbHMpOwogICAgICAgICAgcm93c1NlZW4ucHVzaC",
"h0Ymwucm93KTsKICAgICAgICB9CiAgICAgICAgaWYgKG5hbWUgPT09ICd0ZCcpIHRibC5yb3cudGggPSBmYWxzZTsKICAgICAgICBjb25zdCBzdCA9IFN0cmluZyhhLnN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgICAgIGNvbnN0IGFsID0gKC90ZXh0LWFsaWduXHMqOlxzKihjZW50ZXJ8cmlnaHQpLy5leGVjKHN0KSB8fCBbXSlbMV0gfHwgKC9eKGNlbnRlcnxyaWdodCkkL2kudGVzdChhLmFsaWduIHx8ICcnKSA_IGEuYWxpZ24udG9Mb3dlckNhc2UoKSA6ICcnKTsKICAgICAgICAvLyBCb2xkLCBpdGFsaWMgb3Igc3RydWNrIHRocm91Z2ggY2VsbCBzdHlsZXMgKEdvb2dsZSBTaGVldHMpIGNvdW50CiAgICAgICAgLy8gYXMgbWFya3MgLSBidXQgYSBoZWFkaW5nIGNlbGwgaXMgYm9sZCBhbnl3YXkuCiAgICAgICAgY29uc3QgZ290ID0gc3R5bGVNYXJrcyhzdCkuZmlsdGVyKHggPT4gIShuYW1lID09PSAndGgnICYmIHggPT09ICdiJykpOwogICAgICAgIGFwcGx5KGdvdCwgMSk7CiAgICAgICAgdGJsLmNlbGwgPSB7IHJ1bnM6IFtdLCBhbGlnbjogYWwsIG1hcmtzOiBnb3QsIHRoOiBuYW1lID09PSAndGgnIH07CiAgICAgICAgdGJsLnJvdy5jZWxscy5wdXNoKHRibC5jZWxsKTsKICAgICAgICAvLyBBIGNlbGwgc3Bhbm5pbmcgY29sdW1ucyBrZWVwcyB0aGUgY29sdW1ucyBhZnRlciBpdCBpbiBwbGFjZS4KICAgICAgICBjb25zdCBzcGFuID0gTWF0aC5taW4oTUFYX0NPTFMsIE1hdGgubWF4KDEsIHBhcnNlSW",
"50KGEuY29sc3BhbiwgMTApIHx8IDEpKTsKICAgICAgICBmb3IgKGxldCBrID0gMTsgayA8IHNwYW47IGsrKykgdGJsLnJvdy5jZWxscy5wdXNoKGVtcHR5Q2VsbCgpKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAodGJsICYmICF0YmwuY2VsbCAmJiAhaXNDbG9zZSAmJiAoSEVBRElOR1NbbmFtZV0gfHwgUEFSQS5oYXMobmFtZSkgfHwgbmFtZSA9PT0gJ2xpJyB8fCBuYW1lID09PSAndWwnIHx8IG5hbWUgPT09ICdvbCcpKSBjb250aW51ZTsKICAgICAgaWYgKHRibCAmJiAoSEVBRElOR1NbbmFtZV0gfHwgbmFtZSA9PT0gJ2xpJyB8fCBuYW1lID09PSAndWwnIHx8IG5hbWUgPT09ICdvbCcgfHwgbmFtZSA9PT0gJ3ByZScgfHwgUEFSQS5oYXMobmFtZSkpKSB7CiAgICAgICAgLy8gTGluZXMgaW5zaWRlIGEgY2VsbDogcGFyYWdyYXBocywgaGVhZGluZ3MgYW5kIGxpc3QgaXRlbXMgZWFjaAogICAgICAgIC8vIHN0YXJ0IGEgbmV3IG9uZTsgYSBsaXN0IGl0ZW0ga2VlcHMgYSBidWxsZXQuCiAgICAgICAgY2VsbEJyZWFrKCk7CiAgICAgICAgaWYgKG5hbWUgPT09ICdsaScgJiYgIWlzQ2xvc2UgJiYgY2VsbFJ1bnMoKSkgY2VsbFJ1bnMoKS5wdXNoKHJ1bign4oCiICcpKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQoKICAgICAgaWYgKEhFQURJTkdTW25hbWVdKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSBvcGVuKEhFQURJTkdTW25hbWVdKTsKICAgICAgICBjb250aW51ZT",
"sKICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3VsJyB8fCBuYW1lID09PSAnb2wnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UpIGxpc3RzLnBvcCgpOwogICAgICAgIGVsc2UgbGlzdHMucHVzaCh7IHR5cGU6IGFbJ2RhdGEtY2hlY2snXSA_ICdjaGVjaycgOiBuYW1lLCBsaU9wZW46IGZhbHNlIH0pOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnbGknKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFsaXN0cy5sZW5ndGgpIGxpc3RzLnB1c2goeyB0eXBlOiAndWwnLCBsaU9wZW46IGZhbHNlLCBpbXBsaWVkOiB0cnVlIH0pOwogICAgICAgIGNvbnN0IHRvcCA9IGxpc3RzW2xpc3RzLmxlbmd0aCAtIDFdOwogICAgICAgIHRvcC5saU9wZW4gPSAhaXNDbG9zZTsKICAgICAgICBpZiAoIWlzQ2xvc2UpIHsKICAgICAgICAgIG9wZW4odG9wLnR5cGUsIHsgbGV2ZWw6IGxldmVsKCksIGNoZWNrZWQ6IGFbJ2RhdGEtY2hlY2tlZCddID09PSAnMScgfSk7CiAgICAgICAgICAvLyBPbmUgb2Ygb3VyczogaXRzIGJveCBpcyBpbiB0aGUgYXR0cmlidXRlLCBhbmQgYSDimJAgYXQgdGhlIHN0YXJ0CiAgICAgICAgICAvLyBvZiBpdHMgdGV4dCBpcyB0ZXh0LgogICAgICAgICAgaWYgKGFbJ2RhdGEtY2hlY2tlZCddICE9PSB1bmRlZmluZWQpIGN1ci5vdXJzID0gdHJ1ZTsKICAgICAgICAgIC8vIEEgY2hlY2tsaXN0IGl0ZW0gbWFya2VkIHVwIGZvciBzY3JlZW4gcm",
"VhZGVycyAoR29vZ2xlIERvY3MpLgogICAgICAgICAgZWxzZSBpZiAoYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJyB8fCBhWydhcmlhLWNoZWNrZWQnXSA9PT0gJ2ZhbHNlJykgewogICAgICAgICAgICBjdXIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICAgIGN1ci5jaGVja2VkID0gYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJzsKICAgICAgICAgICAgY3VyLm91cnMgPSB0cnVlOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgICBlbHNlIGlmICh0b3AuaW1wbGllZCkgbGlzdHMucG9wKCk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gU3RyYXkgcm93IG9yIGNlbGwgdGFncyBvdXRzaWRlIGEgdGFibGU6IGEgbGluZSBlYWNoLgogICAgICBpZiAobmFtZSA9PT0gJ3RyJyB8fCBuYW1lID09PSAndGQnIHx8IG5hbWUgPT09ICd0aCcpIHsgZW5kKCk7IGNvbnRpbnVlOyB9CiAgICAgIGlmIChuYW1lID09PSAncHJlJykgewogICAgICAgIGVuZCgpOwogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgICAvLyBUaGUgbGluZSBicmVhayBiZWZvcmUgPC9wcmU-IGVuZHMgdGhlIGxhc3QgbGluZTsgaXQgaXMgbm90IG9uZSBtb3JlLgogICAgICAgICAgY29uc3QgbGFzdCA9IGJsb2Nrc1tibG9ja3MubGVuZ3RoIC0gMV07CiAgICAgICAgICBpZiAobGFzdCAmJiBsYXN0LnByZUxpbmUgJiYgIWxhc3QucnVucy5sZW5ndGgpIGJsb2Nrcy5wb3AoKTsKICAgICAgICAgIHByZSA9IDA7CiAgICAgIC",
"AgfSBlbHNlIGlmICghc2VsZkNsb3NpbmcpIHsKICAgICAgICAgIHByZSA9IHsgZnJlc2g6IHRydWUgfTsKICAgICAgICB9CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQSB0aWNrZWQgb3IgZW1wdHkgYm94IGF0IHRoZSBzdGFydCBvZiBhIGxpbmUgLSBhIHRhc2sgbGlzdCBvbiBhCiAgICAgIC8vIHdlYiBwYWdlIChHaXRIdWIpIC0gbWFrZXMgaXQgYSBjaGVja2xpc3QgaXRlbS4KICAgICAgaWYgKG5hbWUgPT09ICdpbnB1dCcgJiYgU3RyaW5nKGEudHlwZSB8fCAnJykudG9Mb3dlckNhc2UoKSA9PT0gJ2NoZWNrYm94JykgewogICAgICAgIGlmICh0YmwpIHsKICAgICAgICAgIGlmIChjZWxsUnVucygpKSBjZWxsUnVucygpLnB1c2gocnVuKCdjaGVja2VkJyBpbiBhID8gYCR7VElDS0VEfSBgIDogYCR7Qk9YfSBgKSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKCFjdXIpIGNvbnRleHQoKTsKICAgICAgICBpZiAoIWN1ci5ydW5zLnNvbWUociA9PiAvXFMvLnRlc3Qoci50ZXh0KSkpIHsKICAgICAgICAgIGN1ci50eXBlID0gJ2NoZWNrJzsKICAgICAgICAgIGN1ci5jaGVja2VkID0gJ2NoZWNrZWQnIGluIGE7CiAgICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiBhWydkYXRhLWdrYi1ub3RlJ10gIT09IHVuZGVmaW5lZCkgb3VycyA9IHRydWU7CiAgICAgIC8vIE",
"EgYmxvY2sgY29waWVkIG91dCBvZiBhIG5vdGUncyBlZGl0b3Iga2VlcHMgaXRzIGtpbmQuCiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiAhaXNDbG9zZSAmJiBUWVBFUy5oYXMoYVsnZGF0YS10eXBlJ10pICYmIGFbJ2RhdGEtdHlwZSddICE9PSAndGFibGUnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgb3BlbihhWydkYXRhLXR5cGUnXSwgeyBsZXZlbDogTnVtYmVyKGFbJ2RhdGEtbGV2ZWwnXSkgfHwgMCwgY2hlY2tlZDogYVsnZGF0YS1jaGVja2VkJ10gPT09ICcxJyB9KTsKICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gV29yZCB3cml0ZXMgYSBsaXN0IGFzIHBhcmFncmFwaHMgc3R5bGVkICJtc28tbGlzdDogbDAgbGV2ZWwxIi4KICAgICAgaWYgKG5hbWUgPT09ICdwJyAmJiAhaXNDbG9zZSkgewogICAgICAgIGNvbnN0IHdsID0gL21zby1saXN0XHMqOlxzKmxcZCtccytsZXZlbChcZCkvaS5leGVjKGEuc3R5bGUgfHwgJycpOwogICAgICAgIGlmICh3bCkgewogICAgICAgICAgZW5kKCk7CiAgICAgICAgICBvcGVuKCd1bCcsIHsgbGV2ZWw6IE51bWJlcih3bFsxXSkgLSAxIH0pOwogICAgICAgICAgY3VyLndvcmRMaXN0ID0gdHJ1ZTsKICAgICAgICAgIGN1ci5tYXJrZXIgPSAnJzsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3AnKSB7CiAgICAgICAgaWYgKHBhcmEgJiYgcGFyYS5nYXApIG",
"dhcCA9IHRydWU7CiAgICAgICAgcGFyYSA9IG51bGw7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSB7CiAgICAgICAgICBjb25zdCB0b3AgPSBsaXN0c1tsaXN0cy5sZW5ndGggLSAxXTsKICAgICAgICAgIHBhcmEgPSB7IGdhcDogIW91cnMgJiYgIXRibCAmJiAhKHRvcCAmJiB0b3AubGlPcGVuKSAmJiBwYXJhR2FwKGEpIH07CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChQQVJBLmhhcyhuYW1lKSkgewogICAgICAgIC8vIFN0cmFpZ2h0IGluc2lkZSBhIGxpc3QgaXRlbSB0aGF0IGhhcyBubyB0ZXh0IHlldCAoR29vZ2xlIERvY3MKICAgICAgICAvLyB3cmFwcyBldmVyeSBpdGVtIGluIGEgPHA-KSwgdGhlIGxpbmUgZ29lcyBvbi4KICAgICAgICBpZiAoY3VyICYmICFjdXIucnVucy5sZW5ndGggJiYgIWlzQ2xvc2UpIGNvbnRpbnVlOwogICAgICAgIGVuZCgpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnYScpIHsKICAgICAgICBpZiAoaXNDbG9zZSkgaHJlZnMucG9wKCk7CiAgICAgICAgZWxzZSBpZiAoIXNlbGZDbG9zaW5nKSBocmVmcy5wdXNoKHNhZmVIcmVmKGEuaHJlZikpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChJTkxJTkVbbmFtZV0pIHsKICAgICAgICBpZiAoc2VsZkNsb3NpbmcpIGNvbnRpbnVlOwogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgICAvLyBUaGUgaW5uZXJtb3N0IG9wZW4gdGFnIG9mIHRoYXQgbmFtZSAtIG1haWwgaXMgbm",
"90IGFsd2F5cyB0aWRpbHkgbmVzdGVkLgogICAgICAgICAgZm9yIChsZXQgayA9IGlubGluZS5sZW5ndGggLSAxOyBrID49IDA7IGstLSkgewogICAgICAgICAgICBpZiAoaW5saW5lW2tdLm5hbWUgIT09IG5hbWUpIGNvbnRpbnVlOwogICAgICAgICAgICBjb25zdCBbZ290XSA9IGlubGluZS5zcGxpY2UoaywgMSk7CiAgICAgICAgICAgIGlmIChnb3QuZ2x5cGgpIGdseXBoID0gTWF0aC5tYXgoMCwgZ2x5cGggLSAxKTsKICAgICAgICAgICAgZWxzZSBhcHBseShnb3QubWFya3MsIC0xKTsKICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICB9CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3Qgc3R5bGUgPSBTdHJpbmcoYS5zdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAoYVsnZGF0YS1nbHlwaCddIHx8IC9tc28tbGlzdFxzKjpccyppZ25vcmUvLnRlc3Qoc3R5bGUpKSB7CiAgICAgICAgICBpbmxpbmUucHVzaCh7IG5hbWUsIGdseXBoOiB0cnVlIH0pOwogICAgICAgICAgZ2x5cGgrKzsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBsZXQgZ290ID0gWy4uLklOTElORVtuYW1lXSwgLi4uc3R5bGVNYXJrcyhzdHlsZSldOwogICAgICAgIC8vIEdvb2dsZSBEb2NzIHdyYXBzIGEgd2hvbGUgcGFzdGUgaW4gPGIgc3R5bGU9ImZvbnQtd2VpZ2h0Om5vcm1hbCI-LgogICAgICAgIGlmICgvZm9udC13ZWlnaHRccyo6XHMqKG5vcm1hbHxsaWdodGVyfFsxLT",
"VdMDApXGIvLnRlc3Qoc3R5bGUpKSBnb3QgPSBnb3QuZmlsdGVyKHggPT4geCAhPT0gJ2InKTsKICAgICAgICBpZiAoL2ZvbnQtc3R5bGVccyo6XHMqbm9ybWFsLy50ZXN0KHN0eWxlKSkgZ290ID0gZ290LmZpbHRlcih4ID0-IHggIT09ICdpJyk7CiAgICAgICAgZ290ID0gWy4uLm5ldyBTZXQoZ290KV07CiAgICAgICAgaW5saW5lLnB1c2goeyBuYW1lLCBtYXJrczogZ290IH0pOwogICAgICAgIGFwcGx5KGdvdCwgMSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQW55dGhpbmcgZWxzZSAoaW1nLCB1LCBzdXAsIGNvZGUsIOKApik6IGl0cyB0ZXh0IGlzIGtlcHQsIHRoZSB0YWcgaXMgbm90LgogICAgfQogICAgaWYgKHRibCkgZmluaXNoVGFibGUoKTsKICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhtYXJrcykpIG1hcmtzW2tdID0gTWF0aC5tYXgoMCwgbWFya3Nba10pOwoKICAgIC8vIFRpZHkgZWFjaCBibG9jazogY29sbGFwc2UgdGhlIHdoaXRlc3BhY2UgSFRNTCB3b3VsZCBjb2xsYXBzZSwgdGhlbgogICAgLy8gdHVybiB0aGUgJm5ic3A7cyB0aGF0IGhlbGQgZGVsaWJlcmF0ZSBzcGFjZXMgYmFjayBpbnRvIHNwYWNlcy4gSW4gYQogICAgLy8gY2VsbCwgYSBsaW5lIGJyZWFrIGNvdW50cyBhcyBhbiBlbmQsIGFuZCBub25lIGlzIGxlZnQgYXQgZWl0aGVyIGVuZC4KICAgIGNvbnN0IHRpZHlSdW5zID0gcnVucyA9PiB7CiAgICAgIGlmICghcnVucy5sZW5ndGgpIHJldHVybjsKICAgIC",
"AgcnVuc1swXS50ZXh0ID0gcnVuc1swXS50ZXh0LnJlcGxhY2UoL15bIFxuXSsvLCAnJyk7CiAgICAgIHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0ID0gcnVuc1tydW5zLmxlbmd0aCAtIDFdLnRleHQucmVwbGFjZSgvWyBcbl0rJC8sICcnKTsKICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBydW5zLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgaWYgKC9bIFxuXSQvLnRlc3QocnVuc1tpIC0gMV0udGV4dCkpIHJ1bnNbaV0udGV4dCA9IHJ1bnNbaV0udGV4dC5yZXBsYWNlKC9eICsvLCAnJyk7CiAgICAgIH0KICAgICAgZm9yIChjb25zdCByIG9mIHJ1bnMpIHIudGV4dCA9IHIudGV4dC5yZXBsYWNlKC8gK1xuL2csICdcbicpLnJlcGxhY2UoL8KgL2csICcgJyk7CiAgICB9OwogICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICBpZiAoYi50eXBlID09PSAndGFibGUnKSB7CiAgICAgICAgYi5yb3dzLmZvckVhY2gociA9PiByLmZvckVhY2goYyA9PiB0aWR5UnVucyhjLnJ1bnMpKSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgY29uc3QgcnVucyA9IGIucnVuczsKICAgICAgdGlkeVJ1bnMocnVucyk7CiAgICAgIGlmIChiLndvcmRMaXN0ICYmIC9eXHMqKFxkK3xbYS16XXxbaXZ4bGNdKylbLildXHMqJC9pLnRlc3QoYi5tYXJrZXIgfHwgJycpKSBiLnR5cGUgPSAnb2wnOwogICAgICAvLyBBIGNoZWNrIGJveCBkcmF3biBhcyB0ZXh0IChtYWlsIGZyb20gZWxzZXdoZXJlLCBvciBhIGxpc3Qgd2hvc2",
"UKICAgICAgLy8gbWFya2VycyB3ZXJlIGxvc3QpIHN0aWxsIGNvdW50cyBhcyBhIGNoZWNrIGJveC4KICAgICAgaWYgKExJU1RTLmhhcyhiLnR5cGUpICYmIHJ1bnMubGVuZ3RoICYmICFiLm91cnMpIHsKICAgICAgICBjb25zdCBnID0gL14oW-KYkOKYkV0pID8vLmV4ZWMocnVuc1swXS50ZXh0KTsKICAgICAgICBpZiAoZykgewogICAgICAgICAgcnVuc1swXS50ZXh0ID0gcnVuc1swXS50ZXh0LnNsaWNlKGdbMF0ubGVuZ3RoKTsKICAgICAgICAgIGlmIChiLnR5cGUgPT09ICd1bCcpIGIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICBpZiAoYi50eXBlID09PSAnY2hlY2snKSBiLmNoZWNrZWQgPSBnWzFdID09PSBUSUNLRUQ7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICByZXR1cm4gbm9ybWFsaXNlRG9jKGJsb2Nrcyk7CiAgfQoKICAvLyDilIDilIAgTWFya2Rvd24gaW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUZXh0IGNvcGllZCBmcm9tIGEgY2hhdCBhc3Npc3RhbnQsIGEgUkVBRE1FIG9yIGEgTWFya2Rvd24gZWRpdG9yCiAgLy8gYXJyaXZlcyBhcyBwbGFpbiB0ZXh0IGZ1bGwgb2YgKipzdGFycyoqIGFuZCAiLSAiIGxpbmVzLiBUaGUgY29tbW",
"9uCiAgLy8gcGFydCBvZiBNYXJrZG93biBiZWNvbWVzIGZvcm1hdHRpbmc7IHRoZSByZXN0IHN0YXlzIGFzIHR5cGVkLgoKICBmdW5jdGlvbiBtZElubGluZShzcmMsIG1hcmtzID0ge30pIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgcyA9IFN0cmluZyhzcmMgfHwgJycpOwogICAgbGV0IGJ1ZiA9ICcnOwogICAgY29uc3QgZmx1c2ggPSAoKSA9PiB7CiAgICAgIGlmIChidWYpIG91dC5wdXNoKHsgdGV4dDogYnVmLCAuLi5tYXJrcyB9KTsKICAgICAgYnVmID0gJyc7CiAgICB9OwogICAgY29uc3QgbmVzdGVkID0gKGlubmVyLCBleHRyYSkgPT4gewogICAgICBmbHVzaCgpOwogICAgICBvdXQucHVzaCguLi5tZElubGluZShpbm5lciwgeyAuLi5tYXJrcywgLi4uZXh0cmEgfSkpOwogICAgfTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IHJlc3QgPSBzLnNsaWNlKGkpOwogICAgICBjb25zdCBwcmV2ID0gaSA_IHNbaSAtIDFdIDogJyc7CiAgICAgIGxldCBtOwogICAgICBpZiAoKG0gPSAvXlxcKFtcXGAqX3t9W1xdKCkjK1wtLiF-fD5dKS8uZXhlYyhyZXN0KSkpIHsgYnVmICs9IG1bMV07IGkgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICgobSA9IC9eYChbXmBcbl0rKWAvLmV4ZWMocmVzdCkpKSB7IGJ1ZiArPSBtWzFdOyBpICs9IG1bMF0ubGVuZ3RoOyBjb250aW51ZTsgfQogICAgICBpZiAoKG0gPSAvXlxbKFteXF1cbl0rKVxdXChccyo8Py",
"hbXilccz5dKyk-Pyg_OlxzKyJbXiJdKiIpP1xzKlwpLy5leGVjKHJlc3QpKSkgewogICAgICAgIGNvbnN0IGhyZWYgPSBzYWZlSHJlZihtWzJdKTsKICAgICAgICBuZXN0ZWQobVsxXSwgaHJlZiA_IHsgaHJlZiB9IDoge30pOwogICAgICAgIGkgKz0gbVswXS5sZW5ndGg7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKChtID0gL148KCg_Omh0dHBzPzpcL1wvfG1haWx0bzopW14-XHNdKyk-Ly5leGVjKHJlc3QpKSkgewogICAgICAgIGZsdXNoKCk7CiAgICAgICAgY29uc3QgaHJlZiA9IHNhZmVIcmVmKG1bMV0pOwogICAgICAgIG91dC5wdXNoKHsgdGV4dDogbVsxXS5yZXBsYWNlKC9ebWFpbHRvOi8sICcnKSwgLi4ubWFya3MsIC4uLihocmVmID8geyBocmVmIH0gOiB7fSkgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoKG0gPSAvXihcKlwqfF9fKSg_PVxTKShbXHNcU10qP1xTKVwxLy5leGVjKHJlc3QpKSAmJiAhKG1bMV0gPT09ICdfXycgJiYgL1tccHtMfVxwe059XS91LnRlc3QocHJldikpKSB7CiAgICAgICAgbmVzdGVkKG1bMl0sIHsgYjogdHJ1ZSB9KTsKICAgICAgICBpICs9IG1bMF0ubGVuZ3RoOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICgobSA9IC9efn4oPz1cUykoW1xzXFNdKj9cUyl-fi8uZXhlYyhyZXN0KSkpIHsgbmVzdGVkKG1bMV0sIHsgczogdHJ1ZSB9KTsgaSArPSBtWzBdLmxlbmd0aD",
"sgY29udGludWU7IH0KICAgICAgaWYgKChtID0gL15cKig_PVteXHMqXSkoW1xzXFNdKj9bXlxzKl0pXCooPyFcKikvLmV4ZWMocmVzdCkpKSB7IG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7IGkgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICghL1tccHtMfVxwe059X10vdS50ZXN0KHByZXYpICYmIChtID0gL15fKD89W15cc19dKShbXHNcU10qP1teXHNfXSlfKD8hW1xwe0x9XHB7Tn1fXSkvdS5leGVjKHJlc3QpKSkgewogICAgICAgIG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBidWYgKz0gc1tpXTsKICAgICAgaSsrOwogICAgfQogICAgZmx1c2goKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBPbmUgbGluZSBvZiBNYXJrZG93bjogd2hhdCBraW5kIG9mIGJsb2NrIGl0IGlzLCBpdHMgaW5kZW50IGFuZCB0ZXh0LgogIGZ1bmN0aW9uIG1kTGluZShsaW5lKSB7CiAgICBjb25zdCBbLCBwYWQsIHNdID0gL14oICopKC4qKSQvLmV4ZWMobGluZSk7CiAgICBjb25zdCBpbmRlbnQgPSBwYWQubGVuZ3RoOwogICAgbGV0IHg7CiAgICBpZiAoKHggPSAvXigjezEsNn0pXHMrKC4qPykoPzpccysjKyk_XHMqJC8uZXhlYyhzKSkpIHJldHVybiB7IHR5cGU6IFsnaDEnLCAnaDInLCAnaDMnXVtNYXRoLm1pbigyLCB4WzFdLmxlbmd0aCAtIDEpXSwgdGV4dDogeFsyXSB9OwogICAgaWYgKCh4ID0gL1",
"5bLSor4oCiXVxzK1xbKFsgeFhdKVxdXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdICE9PSAnICcsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogICAgaWYgKCh4ID0gL14oW-KYkOKYkV0pXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdID09PSBUSUNLRUQsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzKyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3VsJywgdGV4dDogeFsxXSwgaW5kZW50IH07CiAgICBpZiAoKHggPSAvXlxkezEsM31bLildXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnb2wnLCB0ZXh0OiB4WzFdLCBpbmRlbnQgfTsKICAgIGlmICgoeCA9IC9ePlxzPyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3AnLCB0ZXh0OiB4WzFdLnJlcGxhY2UoL14oPlxzPykrLywgJycpIH07CiAgICByZXR1cm4geyB0eXBlOiAncCcsIHRleHQ6IHMgfTsKICB9CgogIGNvbnN0IE1EX1JVTEUgPSAvXlxzKihbLSpfXSkoXHMqXDEpezIsfVxzKiQvOwoKICBmdW5jdGlvbiBmcm9tTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgbGluZXMgPSBTdHJpbmcodGV4dCB8fCAnJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXHQvZywgJyAgICAnKS5zcGxpdCgnXG4nKTsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgaW5kZW",
"50cyA9IFtdOyAgIC8vIHRoZSBpbmRlbnQgb2YgZWFjaCBvcGVuIGxpc3QgbGV2ZWwKICAgIGxldCBmZW5jZSA9IGZhbHNlOwogICAgY29uc3QgbGFzdCA9ICgpID0-IG91dFtvdXQubGVuZ3RoIC0gMV07CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXTsKICAgICAgaWYgKC9eXHMqKGBgYHx-fn4pLy50ZXN0KGxpbmUpKSB7IGZlbmNlID0gIWZlbmNlOyBjb250aW51ZTsgfQogICAgICBpZiAoZmVuY2UpIHsgb3V0LnB1c2goYmxvY2soJ3AnLCBbeyB0ZXh0OiBsaW5lIH1dKSk7IGNvbnRpbnVlOyB9CiAgICAgIC8vIHwgYSB8IGIgfCBsaW5lcywgd2l0aCBvciB3aXRob3V0IHRoZSB8LS0tfCBsaW5lIHVuZGVyIGEgaGVhZGluZyByb3cuCiAgICAgIGNvbnN0IHQgPSBwaXBlVGFibGUobGluZXMsIGksIG1kSW5saW5lKTsKICAgICAgaWYgKHQpIHsKICAgICAgICBpbmRlbnRzLmxlbmd0aCA9IDA7CiAgICAgICAgb3V0LnB1c2godC5ibG9jayk7CiAgICAgICAgaSA9IHQuZW5kIC0gMTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoTURfUlVMRS50ZXN0KGxpbmUpKSBjb250aW51ZTsKICAgICAgLy8gT25lIGVtcHR5IGxpbmUgaXMgYSBnYXA7IG1vcmUgYXJlIG5vdCwgYW5kIG5vciBpcyBvbmUgYmVzaWRlIGEKICAgICAgLy8gaGVhZGluZywgd2hpY2ggaGFzIHNwYWNlIG9mIGl0cyBvd24uCiAgICAgIGlmICghbGluZS50cm",
"ltKCkpIHsKICAgICAgICBpZiAoIW91dC5sZW5ndGggfHwgIShmbXRCbGFuayhsYXN0KCkpIHx8IEhFQURJTkdTW2xhc3QoKS50eXBlXSkpIG91dC5wdXNoKGJsb2NrKCdwJykpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IGwgPSBtZExpbmUobGluZS5yZXBsYWNlKC9ccyskLywgJycpKTsKICAgICAgaWYgKEhFQURJTkdTW2wudHlwZV0gJiYgb3V0Lmxlbmd0aCAmJiBmbXRCbGFuayhsYXN0KCkpKSBvdXQucG9wKCk7CiAgICAgIGlmIChMSVNUUy5oYXMobC50eXBlKSkgewogICAgICAgIC8vIEEgYmxhbmsgbGluZSBiZXR3ZWVuIHR3byBpdGVtcyBvZiBhIGxpc3QgaXMgbm90IGEgZ2FwIGluIGl0LgogICAgICAgIGlmIChvdXQubGVuZ3RoID4gMSAmJiBmbXRCbGFuayhsYXN0KCkpICYmIExJU1RTLmhhcyhvdXRbb3V0Lmxlbmd0aCAtIDJdLnR5cGUpKSBvdXQucG9wKCk7CiAgICAgICAgd2hpbGUgKGluZGVudHMubGVuZ3RoICYmIGwuaW5kZW50IDwgaW5kZW50c1tpbmRlbnRzLmxlbmd0aCAtIDFdKSBpbmRlbnRzLnBvcCgpOwogICAgICAgIGlmICghaW5kZW50cy5sZW5ndGggfHwgbC5pbmRlbnQgPiBpbmRlbnRzW2luZGVudHMubGVuZ3RoIC0gMV0pIGluZGVudHMucHVzaChsLmluZGVudCk7CiAgICAgICAgb3V0LnB1c2goYmxvY2sobC50eXBlLCBtZElubGluZShsLnRleHQpLCB7IGxldmVsOiBpbmRlbnRzLmxlbmd0aCAtIDEsIGNoZWNrZWQ6IGwuY2hlY2tlZCB9KSk7CiAgICAgICAgY29udG",
"ludWU7CiAgICAgIH0KICAgICAgaW5kZW50cy5sZW5ndGggPSAwOwogICAgICBvdXQucHVzaChibG9jayhsLnR5cGUsIG1kSW5saW5lKGwudGV4dC50cmltKCkpKSk7CiAgICB9CiAgICB3aGlsZSAob3V0Lmxlbmd0aCA-IDEgJiYgZm10QmxhbmsobGFzdCgpKSkgb3V0LnBvcCgpOwogICAgd2hpbGUgKG91dC5sZW5ndGggPiAxICYmIGZtdEJsYW5rKG91dFswXSkpIG91dC5zaGlmdCgpOwogICAgcmV0dXJuIG5vcm1hbGlzZURvYyhvdXQpOwogIH0KCiAgY29uc3QgZm10QmxhbmsgPSBiID0-IGIudHlwZSA9PT0gJ3AnICYmICFiLnJ1bnMuc29tZShyID0-IHIudGV4dC50cmltKCkpOwogIGNvbnN0IGlzVGFibGUgPSBiID0-IGIudHlwZSA9PT0gJ3RhYmxlJzsKCiAgLy8gV2hldGhlciBwbGFpbiB0ZXh0IGlzIHdvcnRoIHJlYWRpbmcgYXMgTWFya2Rvd246IGEgaGVhZGluZywgbGlzdCwKICAvLyBxdW90ZSwgdGFibGUgb3IgY29kZSBsaW5lLCBvciBib2xkLCBzdHJ1Y2ssIGxpbmtlZCBvciBjb2RlIHRleHQuCiAgZnVuY3Rpb24gbG9va3NMaWtlTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIHJldHVybiAvXiB7MCwzfSgjezEsNn1ccytcU3xbLSor4oCiXVxzK1xTfFvimJDimJFdXHMrXFN8XGR7MSwzfVsuKV1ccytcU3w-XHN8YGBgKS9tLnRlc3QocykgfHwKICAgICAgL15ccypcfD9ccyo6Py17Myx9Oj9ccyooXHxccyo6Py17Myx9Oj9ccyopK1x8P1xzKiQvbS50ZXN0KH",
"MpIHx8CiAgICAgIC9cKlwqW14qXG5dK1wqXCp8X19bXl9cbl0rX198fn5bXn5cbl0rfn58XFtbXlxdXG5dK1xdXChbXilcc10rXCl8YFteYFxuXStgLy50ZXN0KHMpOwogIH0KCiAgLy8g4pSA4pSAIFBhc3Rpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFdoZXRoZXIgYSBkb2N1bWVudCBoYXMgYW55dGhpbmcgcGxhaW4gdGV4dCB3b3VsZCBub3Q6IGEgaGVhZGluZywgYQogIC8vIGxpc3QsIGEgbWFyayBvciBhIGxpbmsuCiAgZnVuY3Rpb24gaGFzRm9ybWF0dGluZyhkb2MpIHsKICAgIHJldHVybiBkb2Muc29tZShiID0-IGIudHlwZSAhPT0gJ3AnIHx8IGIucnVucy5zb21lKHIgPT4gci5iIHx8IHIuaSB8fCByLnMgfHwgci5ocmVmKSk7CiAgfQoKICAvLyBXaGV0aGVyIGEgZG9jdW1lbnQgaXMgb25lIHRhYmxlIGFuZCBub3RoaW5nIGVsc2UgKGVtcHR5IGxpbmVzIGFzaWRlKToKICAvLyB3aGF0IGEgcGFzdGUgb2YgY2VsbHMgZnJvbSBhIHNwcmVhZHNoZWV0IGlzLgogIGZ1bmN0aW9uIG9ubHlUYWJsZShkb2MpIHsKICAgIGNvbnN0IGtlcHQgPSBkb2MuZmlsdGVyKGIgPT4gIWZtdEJsYW5rKGIpKTsKICAgIHJldHVybiBrZXB0Lmxlbmd0aC",
"A9PT0gMSAmJiBpc1RhYmxlKGtlcHRbMF0pID8ga2VwdFswXSA6IG51bGw7CiAgfQoKICAvLyBXaGF0IGEgcGFzdGUgYmVjb21lczogdGhlIGNsaXBib2FyZCdzIEhUTUwsIHJlYWQgbGlrZSBtYWlsOyBvciwgd2hlbgogIC8vIHRoYXQgYnJpbmdzIG5vIGZvcm1hdHRpbmcgYW5kIHRoZSB0ZXh0IGlzIE1hcmtkb3duIChmcm9tIGEgY2hhdAogIC8vIGFzc2lzdGFudCwgc2F5KSwgdGhlIE1hcmtkb3duIHJlYWQgYXMgZm9ybWF0dGluZy4gRW1wdHkgbGluZXMgYXQKICAvLyBlaXRoZXIgZW5kIGdvLiBudWxsIG1lYW5zIHRoZXJlIGlzIG5vdGhpbmcgdG8gZm9ybWF0OiB0aGUgdGV4dCBpcwogIC8vIHBhc3RlZCBhcyBpdCBpcy4KICBmdW5jdGlvbiBwYXN0ZURvYyh7IGh0bWwsIHRleHQgfSA9IHt9KSB7CiAgICBsZXQgZG9jID0gaHRtbCAmJiAvXFMvLnRlc3QoaHRtbCkgPyBwYXJzZUh0bWwoaHRtbCkgOiBudWxsOwogICAgaWYgKGRvYyAmJiBpc0VtcHR5KGRvYykpIGRvYyA9IG51bGw7CiAgICBpZiAoKCFkb2MgfHwgIWhhc0Zvcm1hdHRpbmcoZG9jKSkgJiYgbG9va3NMaWtlTWFya2Rvd24odGV4dCkpIGRvYyA9IGZyb21NYXJrZG93bih0ZXh0KTsKICAgIGlmICghZG9jKSByZXR1cm4gbnVsbDsKICAgIC8vIE9uZSBjZWxsIGNvcGllZCBvbiBpdHMgb3duIGlzIGl0cyB0ZXh0LCBub3QgYSB0YWJsZSBvZiBvbmUuCiAgICBjb25zdCBvbmUgPSBvbmx5VGFibGUoZG9jKTsKICAgIGlmIChvbmUgJiYgb25lLnJvd3MubGVuZ3",
"RoID09PSAxICYmIG9uZS5yb3dzWzBdLmxlbmd0aCA9PT0gMSkgewogICAgICBjb25zdCBydW5zID0gb25lLnJvd3NbMF1bMF0ucnVuczsKICAgICAgY29uc3QgbGluZXMgPSBbW11dOwogICAgICBmb3IgKGNvbnN0IHIgb2YgcnVucykgewogICAgICAgIHIudGV4dC5zcGxpdCgnXG4nKS5mb3JFYWNoKChwaWVjZSwgaykgPT4gewogICAgICAgICAgaWYgKGspIGxpbmVzLnB1c2goW10pOwogICAgICAgICAgaWYgKHBpZWNlKSBsaW5lc1tsaW5lcy5sZW5ndGggLSAxXS5wdXNoKHsgLi4uciwgdGV4dDogcGllY2UgfSk7CiAgICAgICAgfSk7CiAgICAgIH0KICAgICAgZG9jID0gbm9ybWFsaXNlRG9jKGxpbmVzLm1hcChsID0-IGJsb2NrKCdwJywgbCkpKTsKICAgIH0KICAgIGxldCBpID0gMDsKICAgIGxldCBqID0gZG9jLmxlbmd0aDsKICAgIHdoaWxlIChpIDwgaiAmJiBmbXRCbGFuayhkb2NbaV0pKSBpKys7CiAgICB3aGlsZSAoaiA-IGkgJiYgZm10QmxhbmsoZG9jW2ogLSAxXSkpIGotLTsKICAgIHJldHVybiBpIDwgaiA_IGRvYy5zbGljZShpLCBqKSA6IG51bGw7CiAgfQoKICAvLyBUaGUgbm90ZSdzIGNvbnRlbnQgZnJvbSBpdHMgbWVzc2FnZSBwYXJ0czogSFRNTCB3aGVuIHRoZXJlIGlzIGFueSwKICAvLyB0aGUgcGxhaW4gdGV4dCBvdGhlcndpc2UuCiAgZnVuY3Rpb24gZG9jRnJvbVBhcnRzKHsgcGxhaW4sIGh0bWwgfSA9IHt9KSB7CiAgICBpZiAoaHRtbCAmJiBTdHJpbmcoaHRtbCkudHJpbSgpKSByZXR1cm4gcG",
"Fyc2VIdG1sKGh0bWwpOwogICAgcmV0dXJuIGZyb21QbGFpbihwbGFpbiB8fCAnJyk7CiAgfQoKICAvLyDilIDilIAgTWVyZ2luZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIEEgbm90ZSBlZGl0ZWQgaGVyZSB3aGlsZSBhbm90aGVyIGNvbXB1dGVyIG9yIHBob25lIHNhdmVkIGEgbmV3ZXIKICAvLyB2ZXJzaW9uIG9mIGl0OiBib3RoIHNldHMgb2YgY2hhbmdlcywgYmxvY2sgYnkgYmxvY2suIGBiYXNlYCBpcyB0aGUKICAvLyB2ZXJzaW9uIHRoZSBlZGl0cyBoZXJlIHN0YXJ0ZWQgZnJvbSwgYG1pbmVgIHRoZSB0ZXh0IGhlcmUgbm93LCBhbmQKICAvLyBgdGhlaXJzYCB0aGUgbmV3ZXIgdmVyc2lvbi4gQSBzdHJldGNoIG9ubHkgb25lIHNpZGUgY2hhbmdlZCB0YWtlcwogIC8vIHRoYXQgc2lkZSdzIGJsb2NrczsgYSBzdHJldGNoIGJvdGggY2hhbmdlZCBrZWVwcyB0aGVpcnMgYW5kIHRoZW4KICAvLyB3aGF0ZXZlciBvZiBtaW5lIHRoZXkgZG8gbm90IGFscmVhZHkgaGF2ZSwgc28gbm90aGluZyB0eXBlZCBvbgogIC8vIGVpdGhlciBpcyBsb3N0IC0gYXQgd29yc3QgYSBwYXJhZ3JhcGggYXBwZWFycyB0d2ljZS4KCiAgY29uc3QgYmxvY2",
"tLZXkgPSBiID0-IEpTT04uc3RyaW5naWZ5KGIpOwogIGNvbnN0IHNhbWVEb2MgPSAoYSwgYikgPT4gSlNPTi5zdHJpbmdpZnkobm9ybWFsaXNlRG9jKGEpKSA9PT0gSlNPTi5zdHJpbmdpZnkobm9ybWFsaXNlRG9jKGIpKTsKCiAgLy8gVGhlIGxvbmdlc3QgY29tbW9uIHN1YnNlcXVlbmNlIG9mIHR3byBsaXN0cyBvZiBrZXlzLCBhcyBwYWlycyBvZgogIC8vIGluZGljZXMgW2kgaW4gYSwgaiBpbiBiXSwgaW4gb3JkZXIuIFRoZSBlbmRzIGJvdGggbGlzdHMgc2hhcmUgYXJlCiAgLy8gbWF0Y2hlZCBmaXJzdCwgc28gdGhlIHRhYmxlIG9ubHkgc3BhbnMgdGhlIHN0cmV0Y2ggdGhhdCBkaWZmZXJzLgogIGZ1bmN0aW9uIGNvbW1vblBhaXJzKGEsIGIpIHsKICAgIGxldCBsbyA9IDA7CiAgICB3aGlsZSAobG8gPCBhLmxlbmd0aCAmJiBsbyA8IGIubGVuZ3RoICYmIGFbbG9dID09PSBiW2xvXSkgbG8rKzsKICAgIGxldCBlYSA9IGEubGVuZ3RoOwogICAgbGV0IGViID0gYi5sZW5ndGg7CiAgICB3aGlsZSAoZWEgPiBsbyAmJiBlYiA-IGxvICYmIGFbZWEgLSAxXSA9PT0gYltlYiAtIDFdKSB7IGVhLS07IGViLS07IH0KICAgIGNvbnN0IHBhaXJzID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxvOyBpKyspIHBhaXJzLnB1c2goW2ksIGldKTsKICAgIGNvbnN0IG4gPSBlYSAtIGxvOwogICAgY29uc3QgbSA9IGViIC0gbG87CiAgICAvLyBUb28gYmlnIGEgdGFibGUgdG8gYmUgd29ydGggaXQ6IG5vIG1hdGNoZXMgaW4gdG",
"hlIG1pZGRsZSwgd2hpY2gKICAgIC8vIG9ubHkgbWFrZXMgdGhlIG1lcmdlIGtlZXAgbW9yZSBvZiBib3RoIHNpZGVzLgogICAgaWYgKG4gJiYgbSAmJiBuICogbSA8PSA0ZTYpIHsKICAgICAgY29uc3QgbGVuID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogbiArIDEgfSwgKCkgPT4gbmV3IFVpbnQzMkFycmF5KG0gKyAxKSk7CiAgICAgIGZvciAobGV0IGkgPSBuIC0gMTsgaSA-PSAwOyBpLS0pIHsKICAgICAgICBmb3IgKGxldCBqID0gbSAtIDE7IGogPj0gMDsgai0tKSB7CiAgICAgICAgICBsZW5baV1bal0gPSBhW2xvICsgaV0gPT09IGJbbG8gKyBqXSA_IGxlbltpICsgMV1baiArIDFdICsgMSA6IE1hdGgubWF4KGxlbltpICsgMV1bal0sIGxlbltpXVtqICsgMV0pOwogICAgICAgIH0KICAgICAgfQogICAgICBsZXQgaSA9IDA7CiAgICAgIGxldCBqID0gMDsKICAgICAgd2hpbGUgKGkgPCBuICYmIGogPCBtKSB7CiAgICAgICAgaWYgKGFbbG8gKyBpXSA9PT0gYltsbyArIGpdKSB7IHBhaXJzLnB1c2goW2xvICsgaSwgbG8gKyBqXSk7IGkrKzsgaisrOyB9IGVsc2UgaWYgKGxlbltpICsgMV1bal0gPj0gbGVuW2ldW2ogKyAxXSkgaSsrOyBlbHNlIGorKzsKICAgICAgfQogICAgfQogICAgZm9yIChsZXQgayA9IDA7IGsgPCBhLmxlbmd0aCAtIGVhOyBrKyspIHBhaXJzLnB1c2goW2VhICsgaywgZWIgKyBrXSk7CiAgICByZXR1cm4gcGFpcnM7CiAgfQoKICAvLyB7IGRvYywgbWFwLCBjbGVhbiB9OiB0aGUgbWVyZ2VkIGJsb2",
"NrczsgZm9yIGVhY2ggb2YgbWluZSdzIGJsb2NrcywKICAvLyB3aGVyZSBpdCBpcyBpbiB0aGVtIChzbyBhIGN1cnNvciBjYW4gc3RheSBwdXQpOyBhbmQgd2hldGhlciBubwogIC8vIHN0cmV0Y2ggd2FzIGNoYW5nZWQgb24gYm90aCBzaWRlcy4KICBmdW5jdGlvbiBtZXJnZURvY3MoYmFzZUluLCBtaW5lSW4sIHRoZWlyc0luKSB7CiAgICBjb25zdCBiYXNlID0gbm9ybWFsaXNlRG9jKGJhc2VJbik7CiAgICBjb25zdCBtaW5lID0gbm9ybWFsaXNlRG9jKG1pbmVJbik7CiAgICBjb25zdCB0aGVpcnMgPSBub3JtYWxpc2VEb2ModGhlaXJzSW4pOwogICAgY29uc3Qga2IgPSBiYXNlLm1hcChibG9ja0tleSk7CiAgICBjb25zdCBrbSA9IG1pbmUubWFwKGJsb2NrS2V5KTsKICAgIGNvbnN0IGt0ID0gdGhlaXJzLm1hcChibG9ja0tleSk7CiAgICBjb25zdCB0b01pbmUgPSBuZXcgTWFwKGNvbW1vblBhaXJzKGtiLCBrbSkpOwogICAgY29uc3QgdG9UaGVpcnMgPSBuZXcgTWFwKGNvbW1vblBhaXJzKGtiLCBrdCkpOwogICAgLy8gVGhlIGJsb2NrcyBuZWl0aGVyIHNpZGUgdG91Y2hlZCwgaW4gb3JkZXIgb24gYWxsIHRocmVlLgogICAgY29uc3QgYW5jaG9ycyA9IFtdOwogICAgbGV0IGxhc3RNID0gLTE7CiAgICBsZXQgbGFzdFQgPSAtMTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwga2IubGVuZ3RoOyBpKyspIHsKICAgICAgaWYgKCF0b01pbmUuaGFzKGkpIHx8ICF0b1RoZWlycy5oYXMoaSkpIGNvbnRpbnVlOwogICAgICBjb2",
"5zdCBtID0gdG9NaW5lLmdldChpKTsKICAgICAgY29uc3QgdCA9IHRvVGhlaXJzLmdldChpKTsKICAgICAgaWYgKG0gPiBsYXN0TSAmJiB0ID4gbGFzdFQpIHsgYW5jaG9ycy5wdXNoKGkpOyBsYXN0TSA9IG07IGxhc3RUID0gdDsgfQogICAgfQogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBtYXAgPSBuZXcgQXJyYXkobWluZS5sZW5ndGgpLmZpbGwoLTEpOwogICAgbGV0IGNsZWFuID0gdHJ1ZTsKICAgIGNvbnN0IHNhbWUgPSAoeCwgeSkgPT4geC5sZW5ndGggPT09IHkubGVuZ3RoICYmIHguZXZlcnkoKHYsIGspID0-IHYgPT09IHlba10pOwogICAgbGV0IGIwID0gMDsKICAgIGxldCBtMCA9IDA7CiAgICBsZXQgdDAgPSAwOwogICAgZm9yIChjb25zdCBhIG9mIGFuY2hvcnMuY29uY2F0KFtrYi5sZW5ndGhdKSkgewogICAgICBjb25zdCBtMSA9IGEgPCBrYi5sZW5ndGggPyB0b01pbmUuZ2V0KGEpIDoga20ubGVuZ3RoOwogICAgICBjb25zdCB0MSA9IGEgPCBrYi5sZW5ndGggPyB0b1RoZWlycy5nZXQoYSkgOiBrdC5sZW5ndGg7CiAgICAgIGNvbnN0IEIgPSBrYi5zbGljZShiMCwgYSk7CiAgICAgIGNvbnN0IE0gPSBrbS5zbGljZShtMCwgbTEpOwogICAgICBjb25zdCBUID0ga3Quc2xpY2UodDAsIHQxKTsKICAgICAgY29uc3Qgc3RhcnQgPSBvdXQubGVuZ3RoOwogICAgICBpZiAoc2FtZShNLCBCKSAmJiAhc2FtZShULCBCKSkgewogICAgICAgIC8vIE9ubHkgdGhleSBjaGFuZ2VkIHRoaXMgc3RyZXRjaC4KIC",
"AgICAgICBmb3IgKGxldCBrID0gdDA7IGsgPCB0MTsgaysrKSBvdXQucHVzaCh0aGVpcnNba10pOwogICAgICAgIGZvciAobGV0IGsgPSBtMDsgayA8IG0xOyBrKyspIG1hcFtrXSA9IE1hdGgubWluKHN0YXJ0ICsgKGsgLSBtMCksIE1hdGgubWF4KHN0YXJ0LCBvdXQubGVuZ3RoIC0gMSkpOwogICAgICB9IGVsc2UgaWYgKHNhbWUoVCwgQikgfHwgc2FtZShNLCBUKSkgewogICAgICAgIC8vIE9ubHkgdGhpcyBzaWRlIGNoYW5nZWQgaXQsIG9yIGJvdGggdGhlIHNhbWUgd2F5LgogICAgICAgIGZvciAobGV0IGsgPSBtMDsgayA8IG0xOyBrKyspIHsgbWFwW2tdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVtrXSk7IH0KICAgICAgfSBlbHNlIGlmIChCLmxlbmd0aCAmJiBNLmxlbmd0aCA9PT0gQi5sZW5ndGggJiYgVC5sZW5ndGggPT09IEIubGVuZ3RoKSB7CiAgICAgICAgLy8gQXMgbWFueSBibG9ja3Mgb24gZWFjaCBzaWRlOiBibG9jayBieSBibG9jaywgZWFjaCBzaWRlJ3MgY2hhbmdlCiAgICAgICAgLy8gd2hlcmUgb25seSBpdCBjaGFuZ2VkIG9uZSwgYm90aCB3aGVyZSBib3RoIGNoYW5nZWQgdGhlIHNhbWUgb25lLgogICAgICAgIGZvciAobGV0IGsgPSAwOyBrIDwgQi5sZW5ndGg7IGsrKykgewogICAgICAgICAgY29uc3QgW2IsIG1tLCB0dF0gPSBbQltrXSwgTVtrXSwgVFtrXV07CiAgICAgICAgICBpZiAobW0gPT09IGIpIHsgbWFwW20wICsga10gPSBvdXQubGVuZ3RoOyBvdXQucHVzaCh0aGVpcnNbdDAgKy",
"BrXSk7IH0gZWxzZSBpZiAodHQgPT09IGIgfHwgdHQgPT09IG1tKSB7IG1hcFttMCArIGtdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVttMCArIGtdKTsgfSBlbHNlIHsKICAgICAgICAgICAgY2xlYW4gPSBmYWxzZTsKICAgICAgICAgICAgb3V0LnB1c2godGhlaXJzW3QwICsga10pOwogICAgICAgICAgICBtYXBbbTAgKyBrXSA9IG91dC5sZW5ndGg7CiAgICAgICAgICAgIG91dC5wdXNoKG1pbmVbbTAgKyBrXSk7CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9IGVsc2UgaWYgKEIubGVuZ3RoICYmIChzYW1lKFQuc2xpY2UoMCwgQi5sZW5ndGgpLCBCKSB8fCBzYW1lKFQuc2xpY2UoVC5sZW5ndGggLSBCLmxlbmd0aCksIEIpKSkgewogICAgICAgIC8vIFRoZXkgb25seSBhZGRlZCBiZWZvcmUgb3IgYWZ0ZXIgaXQsIGFuZCB0aGlzIHNpZGUgY2hhbmdlZCBpdC4KICAgICAgICBjb25zdCBhZnRlciA9IHNhbWUoVC5zbGljZSgwLCBCLmxlbmd0aCksIEIpOwogICAgICAgIGlmICghYWZ0ZXIpIGZvciAobGV0IGsgPSB0MDsgayA8IHQxIC0gQi5sZW5ndGg7IGsrKykgb3V0LnB1c2godGhlaXJzW2tdKTsKICAgICAgICBmb3IgKGxldCBrID0gbTA7IGsgPCBtMTsgaysrKSB7IG1hcFtrXSA9IG91dC5sZW5ndGg7IG91dC5wdXNoKG1pbmVba10pOyB9CiAgICAgICAgaWYgKGFmdGVyKSBmb3IgKGxldCBrID0gdDAgKyBCLmxlbmd0aDsgayA8IHQxOyBrKyspIG91dC5wdXNoKHRoZWlyc1trXSk7CiAgICAgIH0gZWxzZS",
"BpZiAoQi5sZW5ndGggJiYgKHNhbWUoTS5zbGljZSgwLCBCLmxlbmd0aCksIEIpIHx8IHNhbWUoTS5zbGljZShNLmxlbmd0aCAtIEIubGVuZ3RoKSwgQikpKSB7CiAgICAgICAgLy8gVGhpcyBzaWRlIG9ubHkgYWRkZWQgYmVmb3JlIG9yIGFmdGVyIGl0LCBhbmQgdGhleSBjaGFuZ2VkIGl0LgogICAgICAgIGNvbnN0IGFmdGVyID0gc2FtZShNLnNsaWNlKDAsIEIubGVuZ3RoKSwgQik7CiAgICAgICAgaWYgKCFhZnRlcikgZm9yIChsZXQgayA9IG0wOyBrIDwgbTEgLSBCLmxlbmd0aDsgaysrKSB7IG1hcFtrXSA9IG91dC5sZW5ndGg7IG91dC5wdXNoKG1pbmVba10pOyB9CiAgICAgICAgY29uc3QgdGhlaXJzQXQgPSBvdXQubGVuZ3RoOwogICAgICAgIGZvciAobGV0IGsgPSB0MDsgayA8IHQxOyBrKyspIG91dC5wdXNoKHRoZWlyc1trXSk7CiAgICAgICAgY29uc3Qga2VwdCA9IGFmdGVyID8gW20wLCBtMCArIEIubGVuZ3RoXSA6IFttMSAtIEIubGVuZ3RoLCBtMV07CiAgICAgICAgZm9yIChsZXQgayA9IGtlcHRbMF07IGsgPCBrZXB0WzFdOyBrKyspIG1hcFtrXSA9IE1hdGgubWluKHRoZWlyc0F0ICsgKGsgLSBrZXB0WzBdKSwgTWF0aC5tYXgodGhlaXJzQXQsIG91dC5sZW5ndGggLSAxKSk7CiAgICAgICAgaWYgKGFmdGVyKSBmb3IgKGxldCBrID0gbTAgKyBCLmxlbmd0aDsgayA8IG0xOyBrKyspIHsgbWFwW2tdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVtrXSk7IH0KICAgICAgfSBlbHNlIHsKICAgICAgICAvLy",
"BCb3RoIGNoYW5nZWQgaXQ6IHRoZWlycywgdGhlbiB3aGF0IG9mIG1pbmUgaXMgbmV3IHRvIGl0LgogICAgICAgIGNsZWFuID0gZmFsc2U7CiAgICAgICAgZm9yIChsZXQgayA9IHQwOyBrIDwgdDE7IGsrKykgb3V0LnB1c2godGhlaXJzW2tdKTsKICAgICAgICBmb3IgKGxldCBrID0gbTA7IGsgPCBtMTsgaysrKSB7CiAgICAgICAgICBjb25zdCB0aGVyZSA9IFQuaW5kZXhPZihrbVtrXSk7CiAgICAgICAgICBpZiAodGhlcmUgPj0gMCkgbWFwW2tdID0gc3RhcnQgKyB0aGVyZTsKICAgICAgICAgIGVsc2UgeyBtYXBba10gPSBvdXQubGVuZ3RoOyBvdXQucHVzaChtaW5lW2tdKTsgfQogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoYSA8IGtiLmxlbmd0aCkgeyBtYXBbbTFdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVttMV0pOyB9CiAgICAgIGIwID0gYSArIDE7CiAgICAgIG0wID0gbTEgKyAxOwogICAgICB0MCA9IHQxICsgMTsKICAgIH0KICAgIGlmICghb3V0Lmxlbmd0aCkgb3V0LnB1c2goYmxvY2soJ3AnKSk7CiAgICBmb3IgKGxldCBrID0gMDsgayA8IG1hcC5sZW5ndGg7IGsrKykgbWFwW2tdID0gTWF0aC5tYXgoMCwgTWF0aC5taW4ob3V0Lmxlbmd0aCAtIDEsIG1hcFtrXSkpOwogICAgcmV0dXJuIHsgZG9jOiBvdXQsIG1hcCwgY2xlYW4gfTsKICB9CgogIGNvbnN0IGFwaSA9IHsKICAgIFRZUEVTLCBMSVNUUywgTUFYX0xFVkVMLAogICAgYmxvY2ssIGVtcHR5RG9jLCBub3JtYWxpc2VSdW5zLCBub3JtYW",
"xpc2VEb2MsIGRvY1RleHQsIGlzRW1wdHksIHNhZmVIcmVmLAogICAgdG9IdG1sLCB0b1BsYWluLCBmcm9tUGxhaW4sIHBhcnNlSHRtbCwgZG9jRnJvbVBhcnRzLCBmcm9tTWFya2Rvd24sIGxvb2tzTGlrZU1hcmtkb3duLCBoYXNGb3JtYXR0aW5nLCBwYXN0ZURvYywKICAgIG1lcmdlRG9jcywgc2FtZURvYywgdGFibGUsIG9ubHlUYWJsZSwgdGFibGVUZXh0LCBNQVhfQ09MUywgTUFYX1JPV1MsCiAgfTsKCiAgbnMubm90ZUZvcm1hdCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/search-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNlYXJjaCBoaWdobGlnaHRpbmcgKHB1cmUpCi8vCi8vIEdtYWlsIGRvZXMgdGhlIHNlYXJjaGluZzsgdGhpcyBvbmx5IHNob3dzIHdoZXJlIHRoZSB3b3JkcyBhcmUuIEl0IHRha2VzCi8vIHRoZSB3b3JkcyBvdXQgb2YgYSBHbWFpbCBxdWVyeSAtIGxlYXZpbmcgb3V0IG9wZXJhdG9ycyBzdWNoIGFzIGZyb206IG9y",
"Ci8vIGJlZm9yZTosIGFuZCBhbnl0aGluZyBleGNsdWRlZCB3aXRoIGEgbWludXMgLSBhbmQgZmluZHMgdGhlbSBpbiBhCi8vIG5vdGUncyB0ZXh0IHRoZSB3YXkgYSBwZXJzb24gd291bGQgcmVhZCBhIG1hdGNoOiBpZ25vcmluZyBjYXNlIGFuZAovLyBhY2NlbnRzICgiY2FmZSIgZmluZHMgIkNhZsOpIiksIGF0IHRoZSBzdGFydCBvZiBhIHdvcmQgKCJnbG9zcyIgZmluZHMKLy8gImdsb3NzYXJ5Iiwgbm90ICJ4Z2xvc3MiKSwgYW5kIHBocmFzZXMgaW4gcXVvdGVzIGFzIHBocmFzZXMuCi8vCi8vIEZyb20gdGhvc2UgbWF0Y2hlcyBjb21lIHRoZSBleGNlcnB0cyBzaG93biBpbiB0aGUgcmVzdWx0cyBsaXN0LCB3aXRoCi8vIHRoZWlyIG9mZnNldHMsIHNvIHRoZSBsaXN0IGNhbiBtYXJrIHRoZW0gd2l0aG91dCBwYXJzaW5nIGFueSBIVE1MLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8gT3BlcmF0b3JzIHdob3NlIHZhbHVlIGlz",
"IGEgd29yZCB0byBsb29rIGZvciBpbiB0aGUgbm90ZSBpdHNlbGYuCiAgY29uc3QgVEVYVF9PUFMgPSBuZXcgU2V0KFsnc3ViamVjdCcsICdpbnRpdGxlJ10pOwogIGNvbnN0IEtFWVdPUkRTID0gbmV3IFNldChbJ29yJywgJ2FuZCcsICdhcm91bmQnXSk7CgogIC8vIOKUgOKUgCBUaGUgd29yZHMgaW4gYSBxdWVyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmV0dXJucyBbeyB3b3JkczogWydzdGVudCcsICdjb2F0aW5nJ10gfSwg4oCmXTogb25lIGVudHJ5IHBlciB0ZXJtLCBhCiAgLy8gcGhyYXNlIGJlaW5nIHNldmVyYWwgd29yZHMgaW4gYSByb3cuCiAgZnVuY3Rpb24gcXVlcnlUZXJtcyhxdWVyeSkgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3QgYWRkID0gdGV4dCA9PiB7CiAgICAgIGNvbnN0IHdvcmRzID0gU3RyaW5nKHRleHQpLnNwbGl0KC9bXHMiKClbXF17fTw-XSsvKS5tYXAodyA9PiB3LnJlcGxhY2UoL15bXlxwe0x9XHB7Tn1dK3xbXlxwe0x9XHB7Tn1dKyQvZ3UsICcnKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgICBpZiAoIXdvcmRzLmxlbmd0aCkgcmV0dXJuOwogICAgICBpZiAod29yZHMubGVuZ3RoID09PSAxICYmIHdvcmRzWzBdLmxl",
"bmd0aCA8IDIgJiYgL15bXHB7TH1ccHtOfV0kL3UudGVzdCh3b3Jkc1swXSkgJiYgL1thLXowLTldL2kudGVzdCh3b3Jkc1swXSkpIHJldHVybjsKICAgICAgY29uc3Qga2V5ID0gd29yZHMuam9pbignICcpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm47CiAgICAgIHNlZW4uYWRkKGtleSk7CiAgICAgIG91dC5wdXNoKHsgd29yZHMgfSk7CiAgICB9OwogICAgY29uc3QgdG9rZW5zID0gU3RyaW5nKHF1ZXJ5IHx8ICcnKS5tYXRjaCgvLT9bXHB7TH1ccHtOfV9dKzpcKFteKV0qXCl8LT9bXHB7TH1ccHtOfV9dKzoiW14iXSoifC0_IlteIl0qInxcUysvZ3UpIHx8IFtdOwogICAgZm9yIChjb25zdCByYXcgb2YgdG9rZW5zKSB7CiAgICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnLScpKSBjb250aW51ZTsgLy8gZXhjbHVkZWQ6IG5vdCBpbiB0aGUgbm90ZQogICAgICBjb25zdCBvcCA9IC9eKFtccHtMfVxwe059X10rKTooLiopJC91LmV4ZWMocmF3KTsKICAgICAgaWYgKG9wKSB7CiAgICAgICAgaWYgKFRFWFRfT1BTLmhhcyhvcFsxXS50b0xvd2VyQ2FzZSgpKSkgewogICAgICAgICAgY29uc3QgdiA9IG9wWzJdLnJlcGxhY2UoL15bKCJdfFspIl0kL2csICcnKTsKICAgICAgICAgIGlmICgvXlwoLy50ZXN0KG9wWzJdKSkgdi5zcGxpdCgvXHMrLykuZm9yRWFjaChhZGQpOwogICAgICAgICAgZWxzZSBhZGQodik7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlm",
"IChyYXcuc3RhcnRzV2l0aCgnIicpKSB7IGFkZChyYXcucmVwbGFjZSgvIi9nLCAnJykpOyBjb250aW51ZTsgfQogICAgICBjb25zdCB3b3JkID0gcmF3LnJlcGxhY2UoL15bKygpe31dK3xbKCl7fV0rJC9nLCAnJyk7CiAgICAgIGlmIChLRVlXT1JEUy5oYXMod29yZC50b0xvd2VyQ2FzZSgpKSkgY29udGludWU7CiAgICAgIGFkZCh3b3JkKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgRmluZGluZyB0aGVtIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBMb3dlciBjYXNlLCBhY2NlbnRzIG9mZiAtIG9uZSBjaGFyYWN0ZXIgYXQgYSB0aW1lLCB3aXRoIGEgbWFwIGJhY2sgdG8KICAvLyB3aGVyZSBlYWNoIGZvbGRlZCBjaGFyYWN0ZXIgY2FtZSBmcm9tLCBzbyBhIG1hdGNoIGluIHRoZSBmb2xkZWQgdGV4dAogIC8vIGlzIGEgbWF0Y2ggYXQga25vd24gb2Zmc2V0cyBpbiB0aGUgcmVhbCBvbmUuCiAgZnVuY3Rpb24gZm9sZCh0ZXh0KSB7CiAgICBsZXQgZm9sZGVkID0gJyc7CiAgICBjb25zdCBtYXAgPSBbXTsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHMubGVuZ3RoOykgewogICAgICBj",
"b25zdCBjcCA9IHMuY29kZVBvaW50QXQoaSk7CiAgICAgIGNvbnN0IGNoID0gU3RyaW5nLmZyb21Db2RlUG9pbnQoY3ApOwogICAgICBjb25zdCBmID0gY2gubm9ybWFsaXplKCdORkQnKS5yZXBsYWNlKC9ccHtNfSsvZ3UsICcnKS50b0xvd2VyQ2FzZSgpOwogICAgICBmb3IgKGxldCBrID0gMDsgayA8IGYubGVuZ3RoOyBrKyspIG1hcC5wdXNoKGkpOwogICAgICBmb2xkZWQgKz0gZjsKICAgICAgaSArPSBjaC5sZW5ndGg7CiAgICB9CiAgICBtYXAucHVzaChzLmxlbmd0aCk7CiAgICByZXR1cm4geyBmb2xkZWQsIG1hcCB9OwogIH0KCiAgY29uc3QgZXNjYXBlUmUgPSBzID0-IHMucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xdXFxdL2csICdcXCQmJyk7CgogIC8vIEV2ZXJ5IHBsYWNlIHRoZSB0ZXJtcyBvY2N1ciwgYXMgW3N0YXJ0LCBlbmQpIG9mZnNldHMgaW50byBgdGV4dGAsCiAgLy8gaW4gb3JkZXIsIHdpdGggb3ZlcmxhcHMgbWVyZ2VkLgogIGZ1bmN0aW9uIGZpbmRNYXRjaGVzKHRleHQsIHRlcm1zKSB7CiAgICBpZiAoIXRlcm1zIHx8ICF0ZXJtcy5sZW5ndGggfHwgIXRleHQpIHJldHVybiBbXTsKICAgIGNvbnN0IHsgZm9sZGVkLCBtYXAgfSA9IGZvbGQodGV4dCk7CiAgICBjb25zdCBmb3VuZCA9IFtdOwogICAgZm9yIChjb25zdCB0IG9mIHRlcm1zKSB7CiAgICAgIGNvbnN0IHBhdHRlcm4gPSB0LndvcmRzLm1hcCh3ID0-IGVzY2FwZVJlKGZvbGQodykuZm9sZGVkKSkuam9pbignW1xcc1xcdTAwYTBdKycpOwog",
"ICAgICBpZiAoIXBhdHRlcm4pIGNvbnRpbnVlOwogICAgICBjb25zdCByZSA9IG5ldyBSZWdFeHAoYCg_PCFbXFxwe0x9XFxwe059XSkke3BhdHRlcm59YCwgJ2d1Jyk7CiAgICAgIGxldCBtOwogICAgICB3aGlsZSAoKG0gPSByZS5leGVjKGZvbGRlZCkpKSB7CiAgICAgICAgZm91bmQucHVzaChbbWFwW20uaW5kZXhdLCBtYXBbbS5pbmRleCArIG1bMF0ubGVuZ3RoXV0pOwogICAgICAgIGlmIChtWzBdLmxlbmd0aCA9PT0gMCkgcmUubGFzdEluZGV4Kys7CiAgICAgIH0KICAgIH0KICAgIGZvdW5kLnNvcnQoKGEsIGIpID0-IGFbMF0gLSBiWzBdIHx8IGFbMV0gLSBiWzFdKTsKICAgIGNvbnN0IG1lcmdlZCA9IFtdOwogICAgZm9yIChjb25zdCBbcywgZV0gb2YgZm91bmQpIHsKICAgICAgY29uc3QgbGFzdCA9IG1lcmdlZFttZXJnZWQubGVuZ3RoIC0gMV07CiAgICAgIGlmIChsYXN0ICYmIHMgPD0gbGFzdC5lbmQpIGxhc3QuZW5kID0gTWF0aC5tYXgobGFzdC5lbmQsIGUpOwogICAgICBlbHNlIG1lcmdlZC5wdXNoKHsgc3RhcnQ6IHMsIGVuZDogZSB9KTsKICAgIH0KICAgIHJldHVybiBtZXJnZWQ7CiAgfQoKICAvLyDilIDilIAgRXhjZXJwdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA",
"4pSA4pSA4pSA4pSA4pSACgogIC8vIFVwIHRvIGBtYXhgIHN0cmV0Y2hlcyBvZiB0ZXh0IGFyb3VuZCB0aGUgbWF0Y2hlcywgZWFjaCB3aXRoIHRoZQogIC8vIG1hdGNoZXMgaW5zaWRlIGl0IGF0IG9mZnNldHMgcmVsYXRpdmUgdG8gdGhlIHN0cmV0Y2guIFN0cmV0Y2hlcyBzdGFydAogIC8vIGFuZCBlbmQgb24gYSBzcGFjZSB3aGVyZSBvbmUgaXMgbmVhciwgYW5kIHNheSB3aGV0aGVyIHRleHQgd2FzIGN1dC4KICBmdW5jdGlvbiBleGNlcnB0cyh0ZXh0LCBtYXRjaGVzLCB7IGNvbnRleHQgPSA1MCwgbWF4ID0gMyB9ID0ge30pIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBpID0gMDsKICAgIHdoaWxlIChpIDwgbWF0Y2hlcy5sZW5ndGggJiYgb3V0Lmxlbmd0aCA8IG1heCkgewogICAgICBsZXQgc3RhcnQgPSBNYXRoLm1heCgwLCBtYXRjaGVzW2ldLnN0YXJ0IC0gY29udGV4dCk7CiAgICAgIGxldCBlbmQgPSBNYXRoLm1pbihzLmxlbmd0aCwgbWF0Y2hlc1tpXS5lbmQgKyBjb250ZXh0KTsKICAgICAgLy8gTWF0Y2hlcyBjbG9zZSBlbm91Z2ggc2hhcmUgYW4gZXhjZXJwdC4KICAgICAgbGV0IGogPSBpICsgMTsKICAgICAgd2hpbGUgKGogPCBtYXRjaGVzLmxlbmd0aCAmJiBtYXRjaGVzW2pdLnN0YXJ0IDwgZW5kKSB7CiAgICAgICAgZW5kID0gTWF0aC5taW4ocy5sZW5ndGgsIE1hdGgubWF4KGVuZCwgbWF0Y2hlc1tqXS5lbmQgKyBNYXRoLmZsb29y",
"KGNvbnRleHQgLyAyKSkpOwogICAgICAgIGorKzsKICAgICAgfQogICAgICBpZiAoc3RhcnQgPiAwKSB7CiAgICAgICAgY29uc3Qgc3AgPSBzLnNsaWNlKHN0YXJ0LCBtYXRjaGVzW2ldLnN0YXJ0KS5zZWFyY2goL1xzLyk7CiAgICAgICAgaWYgKHNwID49IDApIHN0YXJ0ICs9IHNwICsgMTsKICAgICAgfQogICAgICBpZiAoZW5kIDwgcy5sZW5ndGgpIHsKICAgICAgICBjb25zdCB0YWlsID0gcy5zbGljZShtYXRjaGVzW2ogLSAxXS5lbmQsIGVuZCk7CiAgICAgICAgY29uc3Qgc3AgPSB0YWlsLnNlYXJjaCgvXHNcUyokLyk7CiAgICAgICAgaWYgKHNwID4gMCkgZW5kID0gbWF0Y2hlc1tqIC0gMV0uZW5kICsgc3A7CiAgICAgIH0KICAgICAgb3V0LnB1c2goewogICAgICAgIHRleHQ6IHMuc2xpY2Uoc3RhcnQsIGVuZCkucmVwbGFjZSgvXHMvZywgJyAnKSwKICAgICAgICBtYXJrczogbWF0Y2hlcy5zbGljZShpLCBqKS5tYXAobSA9PiAoeyBzdGFydDogTWF0aC5tYXgobS5zdGFydCwgc3RhcnQpIC0gc3RhcnQsIGVuZDogTWF0aC5taW4obS5lbmQsIGVuZCkgLSBzdGFydCB9KSksCiAgICAgICAgY3V0QmVmb3JlOiBzdGFydCA-IDAsCiAgICAgICAgY3V0QWZ0ZXI6IGVuZCA8IHMubGVuZ3RoLAogICAgICB9KTsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgYXBpID0geyBxdWVyeVRlcm1zLCBmb2xkLCBmaW5kTWF0Y2hlcywgZXhjZXJwdHMgfTsKCiAgbnMuc2VhcmNoTG9naWMgPSBh",
"cGk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKfSkoKTsK\"],[\"src/lib/board-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIEJvYXJkIGxvZ2ljIChwdXJlKQovLwovLyBUaGUgYm9hcmQgaGFzIG5vIGRhdGEgb2YgaXRzIG93bi4gQSBjYXJkIGlzIGEgR21haWwgdGhyZWFkLCBhIGNvbHVtbiBpcwovLyBhIEdtYWlsIGxhYmVsLCBhbmQgdGhlIG9ubHkgdGhpbmdzIHN0b3JlZCBvdXRzaWRlIEdtYWlsIGFyZSB0aGUgb3JkZXIgb2YKLy8gY2FyZHMgd2l0aGluIGEgY29sdW1uIGFuZCB0aGUgdXNlcidzIG93biBlZGl0cyB0byBhIGNhcmQuIEV2ZXJ5dGhpbmcKLy8gaGVyZSBpcyB0aGUgYXJpdGhtZXRpYyBiZXR3ZWVuIHRob3NlOiB3aGljaCBsYWJlbHMgYSBtb3ZlIGFkZHMgYW5kCi8vIHJlbW92ZXMsIHdoZXJlIGEgdGhyZWFkIHNob3dzIHVwIHdoZW4gaXQgY2FycmllcyB0d28gY29sdW1uIGxhYmVscywgaG93Ci8vIGEgc2F2ZWQgb3JkZXIgbWVldHMgYSBmcmVzaCB0aHJlYWQgbG",
"lzdCwgYW5kIHdoYXQgYW4gZWRpdCBsb29rcyBsaWtlLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB1dGlsID0gKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSA_IHJlcXVpcmUoJy4vdXRpbC5qcycpIDogbnMudXRpbDsKCiAgLy8g4pSA4pSAIENvbHVtbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRoZSBsZWFkaW5nIHVuZGVyc2NvcmUgc29ydHMgdGhlIGJvYXJkJ3MgbGFiZWxzIGFib3ZlIGV2ZXJ5dGhpbmcgZWxzZQogIC8vIGluIEdtYWlsJ3MgbG9uZywgYWxwaGFiZXRpY2FsIGxhYmVsIGxpc3QgLSBvbi",
"B0aGUgcGhvbmUgZXNwZWNpYWxseS4KICBjb25zdCBERUZBVUxUX1JPT1QgPSAnX0JvYXJkJzsKCiAgLy8gRG9uZSBhcmNoaXZlcyBvbiBkcm9wIGJlY2F1c2UgdGhhdCBpcyB3aGF0IGZpbmlzaGluZyBzb21ldGhpbmcgaW4KICAvLyBHbWFpbCB1c3VhbGx5IG1lYW5zOiBvdXQgb2YgdGhlIEluYm94LCBzdGlsbCBmaW5kYWJsZSB1bmRlciBpdHMgbGFiZWwuCiAgY29uc3QgREVGQVVMVF9DT0xVTU5TID0gWwogICAgeyBpZDogJ3RvZG8nLCB0aXRsZTogJ1RvIGRvJywgbGFiZWw6IGAke0RFRkFVTFRfUk9PVH0vVG8gZG9gLCBhcmNoaXZlT25Ecm9wOiBmYWxzZSB9LAogICAgeyBpZDogJ2RvaW5nJywgdGl0bGU6ICdEb2luZycsIGxhYmVsOiBgJHtERUZBVUxUX1JPT1R9L0RvaW5nYCwgYXJjaGl2ZU9uRHJvcDogZmFsc2UgfSwKICAgIHsgaWQ6ICd3YWl0aW5nJywgdGl0bGU6ICdXYWl0aW5nJywgbGFiZWw6IGAke0RFRkFVTFRfUk9PVH0vV2FpdGluZ2AsIGFyY2hpdmVPbkRyb3A6IGZhbHNlIH0sCiAgICB7IGlkOiAnZG9uZScsIHRpdGxlOiAnRG9uZScsIGxhYmVsOiBgJHtERUZBVUxUX1JPT1R9L0RvbmVgLCBhcmNoaXZlT25Ecm9wOiB0cnVlIH0sCiAgXTsKCiAgZnVuY3Rpb24gZGVmYXVsdENvbHVtbnMoKSB7CiAgICByZXR1cm4gREVGQVVMVF9DT0xVTU5TLm1hcChjID0-ICh7IC4uLmMgfSkpOwogIH0KCiAgLy8gc3RvcmFnZS5zeW5jIGNhbiBob2xkIGFueXRoaW5nIGFuIG9sZGVyIHZlcnNpb24gLSBvciBhIGhhbm",
"QgZWRpdCAtCiAgLy8gcHV0IHRoZXJlLiBBbnl0aGluZyB1bnVzYWJsZSBmYWxscyBiYWNrIHRvIHRoZSBkZWZhdWx0cyByYXRoZXIgdGhhbgogIC8vIGxlYXZpbmcgYW4gZW1wdHkgYm9hcmQgd2l0aCBubyBvYnZpb3VzIHdheSBiYWNrLgogIGZ1bmN0aW9uIG5vcm1hbGlzZUNvbHVtbnMocmF3KSB7CiAgICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkgcmV0dXJuIGRlZmF1bHRDb2x1bW5zKCk7CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGNvbnN0IGMgb2YgcmF3KSB7CiAgICAgIGlmICghYyB8fCB0eXBlb2YgYyAhPT0gJ29iamVjdCcpIGNvbnRpbnVlOwogICAgICBjb25zdCBpZCA9IFN0cmluZyhjLmlkIHx8ICcnKS50cmltKCk7CiAgICAgIGNvbnN0IGxhYmVsID0gU3RyaW5nKGMubGFiZWwgfHwgJycpLnRyaW0oKTsKICAgICAgaWYgKCFpZCB8fCAhbGFiZWwgfHwgc2Vlbi5oYXMoaWQpKSBjb250aW51ZTsKICAgICAgc2Vlbi5hZGQoaWQpOwogICAgICBjb25zdCBjb2wgPSB7CiAgICAgICAgaWQsCiAgICAgICAgdGl0bGU6IFN0cmluZyhjLnRpdGxlIHx8ICcnKS50cmltKCkgfHwgbGFiZWwuc3BsaXQoJy8nKS5wb3AoKSwKICAgICAgICBsYWJlbCwKICAgICAgICBhcmNoaXZlT25Ecm9wOiAhIWMuYXJjaGl2ZU9uRHJvcCwKICAgICAgfTsKICAgICAgaWYgKGMubGFiZWxJZCAmJiB0eXBlb2YgYy5sYWJlbElkID09PSAnc3RyaW5nJykgY29sLmxhYmVsSWQgPS",
"BjLmxhYmVsSWQ7CiAgICAgIG91dC5wdXNoKGNvbCk7CiAgICB9CiAgICByZXR1cm4gb3V0Lmxlbmd0aCA_IG91dCA6IGRlZmF1bHRDb2x1bW5zKCk7CiAgfQoKICAvLyBXaGVyZSBhIG5ldyBjb2x1bW4ncyBsYWJlbCBnb2VzOiB1bmRlciB0aGUgcGFyZW50IHRoZSBleGlzdGluZyBjb2x1bW5zCiAgLy8gc2hhcmUsIHNvIGEgYm9hcmQgbW92ZWQgdG8gIl9Cb2FyZC_igKYiIGtlZXBzIGdyb3dpbmcgdGhlcmUgcmF0aGVyIHRoYW4KICAvLyBxdWlldGx5IHJlY3JlYXRpbmcgdGhlIG9sZCAiQm9hcmQiIHBhcmVudC4KICBmdW5jdGlvbiBsYWJlbFJvb3QoY29sdW1ucykgewogICAgY29uc3QgcGFyZW50cyA9IG5ldyBTZXQoKGNvbHVtbnMgfHwgW10pLm1hcChjID0-IHsKICAgICAgY29uc3QgcGFydHMgPSBTdHJpbmcoYy5sYWJlbCB8fCAnJykuc3BsaXQoJy8nKTsKICAgICAgcmV0dXJuIHBhcnRzLmxlbmd0aCA-IDEgPyBwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpIDogJyc7CiAgICB9KSk7CiAgICBpZiAocGFyZW50cy5zaXplID09PSAxKSB7CiAgICAgIGNvbnN0IFtvbmx5XSA9IHBhcmVudHM7CiAgICAgIGlmIChvbmx5KSByZXR1cm4gb25seTsKICAgIH0KICAgIHJldHVybiBERUZBVUxUX1JPT1Q7CiAgfQoKICAvLyBDb2x1bW5zIHJlbWVtYmVyIHRoZWlyIGxhYmVsJ3MgaWQgYXMgd2VsbCBhcyBpdHMgbmFtZSwgYmVjYXVzZSBHbWFpbAogIC8vIGxldHMgYSBsYWJlbCBiZSByZW5hbWVkIC0gYW5kIHJlbmFtaW",
"5nICJCb2FyZCIgdG8gIl9Cb2FyZCIgcmVuYW1lcwogIC8vIGV2ZXJ5IGNvbHVtbiBsYWJlbCB1bmRlciBpdC4gRm9sbG93aW5nIHRoZSBpZCBrZWVwcyBhIGNvbHVtbiBvbiB0aGUKICAvLyBzYW1lIG1haWw7IGZvbGxvd2luZyB0aGUgbmFtZSBhbG9uZSB3b3VsZCBjcmVhdGUgYSBmcmVzaCwgZW1wdHkgbGFiZWwKICAvLyB3aXRoIHRoZSBvbGQgbmFtZS4gUmV0dXJucyB0aGUgY29sdW1ucyB3aXRoIG5hbWVzIGJyb3VnaHQgdXAgdG8gZGF0ZQogIC8vIGFuZCBpZHMgZmlsbGVkIGluLCBhbmQgd2hldGhlciBhbnl0aGluZyBjaGFuZ2VkIChzbyBpdCBjYW4gYmUgc2F2ZWQpLgogIGZ1bmN0aW9uIHJlc29sdmVDb2x1bW5MYWJlbHMoY29sdW1ucywgbGFiZWxzKSB7CiAgICBjb25zdCBieUlkID0gbmV3IE1hcCgobGFiZWxzIHx8IFtdKS5tYXAobCA9PiBbbC5pZCwgbF0pKTsKICAgIGNvbnN0IGJ5TmFtZSA9IG5ldyBNYXAoKGxhYmVscyB8fCBbXSkubWFwKGwgPT4gW1N0cmluZyhsLm5hbWUpLnRvTG93ZXJDYXNlKCksIGxdKSk7CiAgICBsZXQgY2hhbmdlZCA9IGZhbHNlOwogICAgY29uc3Qgb3V0ID0gY29sdW1ucy5tYXAoYyA9PiB7CiAgICAgIGNvbnN0IHZpYUlkID0gYy5sYWJlbElkICYmIGJ5SWQuZ2V0KGMubGFiZWxJZCk7CiAgICAgIGlmICh2aWFJZCkgewogICAgICAgIGlmICh2aWFJZC5uYW1lID09PSBjLmxhYmVsKSByZXR1cm4gYzsKICAgICAgICBjaGFuZ2VkID0gdHJ1ZTsKICAgICAgICByZXR1cm4geyAuLi",
"5jLCBsYWJlbDogdmlhSWQubmFtZSB9OwogICAgICB9CiAgICAgIC8vIEdtYWlsJ3Mgb3duIHNwZWxsaW5nIHdpbnMsIHNvIGEgY2FzZS1vbmx5IGRpZmZlcmVuY2Ugc2V0dGxlcyBoZXJlCiAgICAgIC8vIHJhdGhlciB0aGFuIGNvdW50aW5nIGFzIGEgcmVuYW1lIG9uIHRoZSBuZXh0IHBhc3MuCiAgICAgIGNvbnN0IHZpYU5hbWUgPSBieU5hbWUuZ2V0KFN0cmluZyhjLmxhYmVsKS50b0xvd2VyQ2FzZSgpKTsKICAgICAgaWYgKHZpYU5hbWUpIHsKICAgICAgICBpZiAoYy5sYWJlbElkID09PSB2aWFOYW1lLmlkICYmIGMubGFiZWwgPT09IHZpYU5hbWUubmFtZSkgcmV0dXJuIGM7CiAgICAgICAgY2hhbmdlZCA9IHRydWU7CiAgICAgICAgcmV0dXJuIHsgLi4uYywgbGFiZWw6IHZpYU5hbWUubmFtZSwgbGFiZWxJZDogdmlhTmFtZS5pZCB9OwogICAgICB9CiAgICAgIC8vIE5vdCBpbiBHbWFpbCAoeWV0KTogaXQgaXMgY3JlYXRlZCB1bmRlciB0aGlzIG5hbWUsIGFuZCBpdHMgaWQgaXMKICAgICAgLy8gcmVjb3JkZWQgb24gdGhlIG5leHQgcGFzcy4KICAgICAgaWYgKGMubGFiZWxJZCkgewogICAgICAgIGNoYW5nZWQgPSB0cnVlOwogICAgICAgIGNvbnN0IHsgbGFiZWxJZCwgLi4ucmVzdCB9ID0gYzsKICAgICAgICByZXR1cm4gcmVzdDsKICAgICAgfQogICAgICByZXR1cm4gYzsKICAgIH0pOwogICAgcmV0dXJuIHsgY29sdW1uczogb3V0LCBjaGFuZ2VkIH07CiAgfQoKICBmdW5jdGlvbiBuZXdDb2x1bW5JZChleGlzdG",
"luZywgcmFuZCA9IE1hdGgucmFuZG9tKSB7CiAgICBjb25zdCB0YWtlbiA9IG5ldyBTZXQoKGV4aXN0aW5nIHx8IFtdKS5tYXAoYyA9PiBjLmlkKSk7CiAgICBsZXQgaWQ7CiAgICBkbyB7CiAgICAgIGlkID0gJ2MnICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyBNYXRoLmZsb29yKHJhbmQoKSAqIDFlNikudG9TdHJpbmcoMzYpOwogICAgfSB3aGlsZSAodGFrZW4uaGFzKGlkKSk7CiAgICByZXR1cm4gaWQ7CiAgfQoKICAvLyBHbWFpbCByZXNlcnZlcyBpdHMgc3lzdGVtIGxhYmVsIG5hbWVzIChjYXNlLWluc2Vuc2l0aXZlbHkpIGFuZCByZWplY3RzCiAgLy8gZW1wdHkgcGF0aCBzZWdtZW50cywgc28gYm90aCBhcmUgY2F1Z2h0IGhlcmUgd2l0aCBhIHJlYWRhYmxlIG1lc3NhZ2UKICAvLyBpbnN0ZWFkIG9mIGEgYmFyZSA0MDAgZnJvbSB0aGUgQVBJLgogIGNvbnN0IFJFU0VSVkVEID0gbmV3IFNldChbCiAgICAnaW5ib3gnLCAnc2VudCcsICdkcmFmdHMnLCAnc3BhbScsICd0cmFzaCcsICdzdGFycmVkJywgJ2ltcG9ydGFudCcsCiAgICAndW5yZWFkJywgJ2NoYXQnLCAnc25vb3plZCcsICdzY2hlZHVsZWQnLCAnYWxsIG1haWwnLCAnb3V0Ym94JywKICBdKTsKCiAgZnVuY3Rpb24gdmFsaWRhdGVDb2x1bW5zKGNvbHMpIHsKICAgIGlmICghY29scy5sZW5ndGgpIHJldHVybiAnS2VlcCBhdCBsZWFzdCBvbmUgY29sdW1uLic7CiAgICBjb25zdCBsYWJlbHMgPSBuZXcgU2V0KCk7CiAgICBmb3IgKGNvbnN0IGMgb2YgY2",
"9scykgewogICAgICBjb25zdCB0aXRsZSA9IChjLnRpdGxlIHx8ICcnKS50cmltKCk7CiAgICAgIGNvbnN0IGxhYmVsID0gKGMubGFiZWwgfHwgJycpLnRyaW0oKTsKICAgICAgaWYgKCF0aXRsZSkgcmV0dXJuICdFdmVyeSBjb2x1bW4gbmVlZHMgYSB0aXRsZS4nOwogICAgICBpZiAoIWxhYmVsKSByZXR1cm4gYOKAnCR7dGl0bGV94oCdIG5lZWRzIGEgR21haWwgbGFiZWwuYDsKICAgICAgaWYgKGxhYmVsLnNwbGl0KCcvJykuc29tZShzZWcgPT4gIXNlZy50cmltKCkpKSB7CiAgICAgICAgcmV0dXJuIGDigJwke2xhYmVsfeKAnSBoYXMgYW4gZW1wdHkgcGFydCBiZXR3ZWVuIHNsYXNoZXMuYDsKICAgICAgfQogICAgICBpZiAoUkVTRVJWRUQuaGFzKGxhYmVsLnRvTG93ZXJDYXNlKCkpKSByZXR1cm4gYOKAnCR7bGFiZWx94oCdIGlzIGEgR21haWwgc3lzdGVtIGxhYmVsIGFuZCBjYW5ub3QgYmUgdXNlZC5gOwogICAgICBjb25zdCBrZXkgPSBsYWJlbC50b0xvd2VyQ2FzZSgpOwogICAgICBpZiAobGFiZWxzLmhhcyhrZXkpKSByZXR1cm4gYFR3byBjb2x1bW5zIHVzZSB0aGUgbGFiZWwg4oCcJHtsYWJlbH3igJ0uYDsKICAgICAgbGFiZWxzLmFkZChrZXkpOwogICAgfQogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gIl9Cb2FyZC9UbyBkbyIg4oaSIFsiX0JvYXJkIl0uIEdtYWlsIG9ubHkgbmVzdHMgYSBsYWJlbCBpbiBpdHMgc2lkZWJhcgogIC8vIHdoZW4gdGhlIHBhcmVudCBleGlzdHMsIHNvIHRoZSBwYXJlbnRzIGFyZS",
"BjcmVhdGVkIHRvby4KICBmdW5jdGlvbiBsYWJlbEFuY2VzdG9ycyhuYW1lKSB7CiAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyhuYW1lKS5zcGxpdCgnLycpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID0gMTsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSBvdXQucHVzaChwYXJ0cy5zbGljZSgwLCBpKS5qb2luKCcvJykpOwogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIOKUgOKUgCBQbGFjZW1lbnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIEEgdGhyZWFkIGNhcnJ5aW5nIHR3byBjb2x1bW4gbGFiZWxzIChtb3ZlZCBvbiB0aGUgcGhvbmUsIHNheSkgaXMgc2hvd24KICAvLyBvbmNlLCBpbiB0aGUgbGVmdC1tb3N0IG9mIGl0cyBjb2x1bW5zLiBTaG93aW5nIGl0IHR3aWNlIHdvdWxkIG1ha2UgYQogIC8vIGRyYWcgYW1iaWd1b3VzIGFib3V0IHdoaWNoIGxhYmVsIGl0IGlzIGxlYXZpbmcuCiAgZnVuY3Rpb24gYXNzaWduQ29sdW1ucyhjb2x1bW5zLCBsaXN0c0J5Q29sdW1uKSB7CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3Qgb3V0ID0ge307CiAgICBmb3IgKGNvbnN0IGNvbCBvZiBjb2x1bW5zKSB7CiAgICAgIG91dF",
"tjb2wuaWRdID0gW107CiAgICAgIGZvciAoY29uc3QgaWQgb2YgKGxpc3RzQnlDb2x1bW5bY29sLmlkXSB8fCBbXSkpIHsKICAgICAgICBpZiAoc2Vlbi5oYXMoaWQpKSBjb250aW51ZTsKICAgICAgICBzZWVuLmFkZChpZCk7CiAgICAgICAgb3V0W2NvbC5pZF0ucHVzaChpZCk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBTYXZlZCBvcmRlciB3aW5zIGZvciBldmVyeSB0aHJlYWQgaXQgbWVudGlvbnMuIFRocmVhZHMgaXQgZG9lcyBub3QKICAvLyBrbm93IGFib3V0IGFyZSBuZXcgdG8gdGhlIGNvbHVtbiwgc28gdGhleSBnbyBvbiB0b3AgLSBuZXdlc3QgZmlyc3QgLQogIC8vIHdoZXJlIHRoZXkgd2lsbCBiZSBub3RpY2VkLiBJZHMgdGhhdCBoYXZlIGxlZnQgdGhlIGNvbHVtbiBkcm9wIG91dC4KICBmdW5jdGlvbiBtZXJnZU9yZGVyKHNhdmVkSWRzLCB0aHJlYWRzKSB7CiAgICBjb25zdCBwcmVzZW50ID0gbmV3IE1hcCh0aHJlYWRzLm1hcCh0ID0-IFt0LmlkLCB0XSkpOwogICAgY29uc3Qga2VwdCA9IFtdOwogICAgY29uc3Qga2VwdFNldCA9IG5ldyBTZXQoKTsKICAgIGZvciAoY29uc3QgaWQgb2YgKHNhdmVkSWRzIHx8IFtdKSkgewogICAgICBpZiAocHJlc2VudC5oYXMoaWQpICYmICFrZXB0U2V0LmhhcyhpZCkpIHsga2VwdC5wdXNoKGlkKTsga2VwdFNldC5hZGQoaWQpOyB9CiAgICB9CiAgICBjb25zdCBmcmVzaCA9IHRocmVhZHMKICAgICAgLmZpbHRlcih0ID0-ICFrZXB0U2V0Lm",
"hhcyh0LmlkKSkKICAgICAgLnNvcnQoKGEsIGIpID0-IChOdW1iZXIoYi50cykgfHwgMCkgLSAoTnVtYmVyKGEudHMpIHx8IDApKQogICAgICAubWFwKHQgPT4gdC5pZCk7CiAgICByZXR1cm4gZnJlc2guY29uY2F0KGtlcHQpOwogIH0KCiAgLy8gSW5kZXggaXMgYSBwb3NpdGlvbiBpbiB0aGUgbGlzdCBhcyBpdCBsb29rcyBXSVRIT1VUIHRoZSB0aHJlYWQgYmVpbmcKICAvLyBwbGFjZWQgLSB3aGljaCBpcyB3aGF0IHRoZSBkcm9wIHpvbmUgbWVhc3VyZXMsIHNpbmNlIHRoZSBkcmFnZ2VkIGNhcmQKICAvLyBpcyBoaWRkZW4gd2hpbGUgaXQgaXMgaW4gZmxpZ2h0LgogIGZ1bmN0aW9uIHBsYWNlSWQobGlzdCwgaWQsIGluZGV4KSB7CiAgICBjb25zdCByZXN0ID0gKGxpc3QgfHwgW10pLmZpbHRlcih4ID0-IHggIT09IGlkKTsKICAgIGNvbnN0IGkgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihOdW1iZXIoaW5kZXgpIHx8IDAsIHJlc3QubGVuZ3RoKSk7CiAgICByZXN0LnNwbGljZShpLCAwLCBpZCk7CiAgICByZXR1cm4gcmVzdDsKICB9CgogIC8vIERyb3BzIGlkcyB0aGF0IGFyZSBub3Qgb24gdGhlIGJvYXJkIGFueSBtb3JlLCBhbmQgY29sdW1ucyB0aGF0IG5vCiAgLy8gbG9uZ2VyIGV4aXN0LCBzbyBzdG9yYWdlLmxvY2FsIGRvZXMgbm90IHNsb3dseSBmaWxsIHdpdGggZGVhZCB0aHJlYWRzLgogIGZ1bmN0aW9uIHBydW5lT3JkZXIobGlzdHMsIGNvbHVtbnMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgZm9yIChjb2",
"5zdCBjb2wgb2YgY29sdW1ucykgb3V0W2NvbC5pZF0gPSAobGlzdHNbY29sLmlkXSB8fCBbXSkuc2xpY2UoKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgTGFiZWwgYXJpdGhtZXRpYyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYXNMb29rdXAobGFiZWxJZE9mKSB7CiAgICBpZiAodHlwZW9mIGxhYmVsSWRPZiA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIGxhYmVsSWRPZjsKICAgIGlmIChsYWJlbElkT2YgaW5zdGFuY2VvZiBNYXApIHJldHVybiBuYW1lID0-IGxhYmVsSWRPZi5nZXQobmFtZSk7CiAgICByZXR1cm4gbmFtZSA9PiAobGFiZWxJZE9mIHx8IHt9KVtuYW1lXTsKICB9CgogIC8vIE1vdmluZyBhIGNhcmQgaXMgb25lIHRocmVhZHMubW9kaWZ5OiBhZGQgdGhlIHRhcmdldCdzIGxhYmVsLCBzdHJpcAogIC8vIGV2ZXJ5IG90aGVyIGNvbHVtbiBsYWJlbCAoc28gYSB0aHJlYWQgaXMgb25seSBldmVyIGluIG9uZSBjb2x1bW4sIGV2ZW4KICAvLyBpZiBpdCBoYWQgZHJpZnRlZCBpbnRvIHR3byksIGFuZCBkcm9wIElOQk9YIHdoZW4gdGhlIHRhcmdldCBhcmNoaXZlcy4KICBmdW5jdGlvbiBtb3ZlTGFiZWxEaWZmKGNvbHVtbnMsIHRhcmdldENvbHVtbklkLCBsYW",
"JlbElkT2YpIHsKICAgIGNvbnN0IGxvb2t1cCA9IGFzTG9va3VwKGxhYmVsSWRPZik7CiAgICBjb25zdCB0YXJnZXQgPSBjb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSB0YXJnZXRDb2x1bW5JZCk7CiAgICBpZiAoIXRhcmdldCkgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGNvbHVtbiAke3RhcmdldENvbHVtbklkfWApOwogICAgY29uc3QgYWRkSWQgPSBsb29rdXAodGFyZ2V0LmxhYmVsKTsKICAgIGlmICghYWRkSWQpIHRocm93IG5ldyBFcnJvcihgTm8gR21haWwgbGFiZWwgaWQgZm9yIOKAnCR7dGFyZ2V0LmxhYmVsfeKAnWApOwoKICAgIGNvbnN0IHJlbW92ZSA9IG5ldyBTZXQoKTsKICAgIGZvciAoY29uc3QgYyBvZiBjb2x1bW5zKSB7CiAgICAgIGlmIChjLmlkID09PSB0YXJnZXRDb2x1bW5JZCkgY29udGludWU7CiAgICAgIGNvbnN0IGlkID0gbG9va3VwKGMubGFiZWwpOwogICAgICBpZiAoaWQgJiYgaWQgIT09IGFkZElkKSByZW1vdmUuYWRkKGlkKTsKICAgIH0KICAgIGlmICh0YXJnZXQuYXJjaGl2ZU9uRHJvcCkgcmVtb3ZlLmFkZCgnSU5CT1gnKTsKICAgIHJldHVybiB7IGFkZExhYmVsSWRzOiBbYWRkSWRdLCByZW1vdmVMYWJlbElkczogWy4uLnJlbW92ZV0gfTsKICB9CgogIC8vIFRha2luZyBhIGNhcmQgb2ZmIHRoZSBib2FyZCBzdHJpcHMgZXZlcnkgY29sdW1uIGxhYmVsIGFuZCBub3RoaW5nCiAgLy8gZWxzZTogdGhlIHRocmVhZCBzdGF5cyBleGFjdGx5IHdoZXJlIGl0IHdhcyBpbiBHbWFpbC4KIC",
"BmdW5jdGlvbiByZW1vdmVMYWJlbERpZmYoY29sdW1ucywgbGFiZWxJZE9mKSB7CiAgICBjb25zdCBsb29rdXAgPSBhc0xvb2t1cChsYWJlbElkT2YpOwogICAgY29uc3QgcmVtb3ZlID0gbmV3IFNldCgpOwogICAgZm9yIChjb25zdCBjIG9mIGNvbHVtbnMpIHsKICAgICAgY29uc3QgaWQgPSBsb29rdXAoYy5sYWJlbCk7CiAgICAgIGlmIChpZCkgcmVtb3ZlLmFkZChpZCk7CiAgICB9CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogW10sIHJlbW92ZUxhYmVsSWRzOiBbLi4ucmVtb3ZlXSB9OwogIH0KCiAgLy8gV2hpY2ggY29sdW1uIGEgdGhyZWFkIGJlbG9uZ3MgaW4sIGdpdmVuIHRoZSB1bmlvbiBvZiBpdHMgbGFiZWwgaWRzLgogIGZ1bmN0aW9uIGNvbHVtbkZvckxhYmVscyhjb2x1bW5zLCBsYWJlbElkcywgbGFiZWxJZE9mKSB7CiAgICBjb25zdCBsb29rdXAgPSBhc0xvb2t1cChsYWJlbElkT2YpOwogICAgY29uc3QgaGF2ZSA9IG5ldyBTZXQobGFiZWxJZHMgfHwgW10pOwogICAgZm9yIChjb25zdCBjIG9mIGNvbHVtbnMpIHsKICAgICAgY29uc3QgaWQgPSBsb29rdXAoYy5sYWJlbCk7CiAgICAgIGlmIChpZCAmJiBoYXZlLmhhcyhpZCkpIHJldHVybiBjOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQoKICAvLyDilIDilIAgVGhyZWFkcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilI",
"DilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmVkdWNlcyBhIHRocmVhZHMuZ2V0KGZvcm1hdD1tZXRhZGF0YSkgcmVzcG9uc2UgdG8gd2hhdCBhIGNhcmQgc2hvd3MuCiAgLy8gU3ViamVjdCBjb21lcyBmcm9tIHRoZSBmaXJzdCBtZXNzYWdlIChyZXBsaWVzIHByZWZpeCAiUmU6IiksIHNlbmRlcgogIC8vIGFuZCBkYXRlIGZyb20gdGhlIGxhdGVzdCByZWFsIG1lc3NhZ2UgKGEgcGVuZGluZyBkcmFmdCBpcyBub3QgbmV3cykuCiAgZnVuY3Rpb24gc3VtbWFyaXNlVGhyZWFkKHRocmVhZCwgYWNjb3VudCkgewogICAgY29uc3QgbXNncyA9ICh0aHJlYWQgJiYgdGhyZWFkLm1lc3NhZ2VzKSB8fCBbXTsKICAgIGNvbnN0IGlkID0gdGhyZWFkICYmIHRocmVhZC5pZDsKICAgIGNvbnN0IGhpc3RvcnlJZCA9IFN0cmluZygodGhyZWFkICYmIHRocmVhZC5oaXN0b3J5SWQpIHx8ICcnKTsKICAgIGlmICghbXNncy5sZW5ndGgpIHsKICAgICAgcmV0dXJuIHsKICAgICAgICBpZCwgaGlzdG9yeUlkLCBzdWJqZWN0OiAnKG5vIHN1YmplY3QpJywgZnJvbTogJycsIGZyb21FbWFpbDogJycsIHRzOiAwLAogICAgICAgIHNuaXBwZXQ6IHV0aWwuZGVjb2RlRW50aXRpZXMoKHRocmVhZCAmJiB0aHJlYWQuc25pcHBldCkgfHwgJycpLAogICAgICAgIGNvdW50OiAwLCB1bnJlYWQ6IGZhbHNlLCBzdGFycmVkOiBmYWxzZSwgaGFzRHJhZnQ6IG",
"ZhbHNlLCBsYWJlbElkczogW10sCiAgICAgIH07CiAgICB9CgogICAgY29uc3QgaXNEcmFmdCA9IG0gPT4gKG0ubGFiZWxJZHMgfHwgW10pLmluY2x1ZGVzKCdEUkFGVCcpOwogICAgY29uc3QgcmVhbCA9IG1zZ3MuZmlsdGVyKG0gPT4gIWlzRHJhZnQobSkpOwogICAgY29uc3QgYmFzaXMgPSByZWFsLmxlbmd0aCA_IHJlYWwgOiBtc2dzOwogICAgY29uc3QgbGF0ZXN0ID0gYmFzaXNbYmFzaXMubGVuZ3RoIC0gMV07CiAgICBjb25zdCBmaXJzdEhlYWRlcnMgPSB1dGlsLmhlYWRlck1hcChtc2dzWzBdKTsKICAgIGNvbnN0IGxhdGVzdEhlYWRlcnMgPSB1dGlsLmhlYWRlck1hcChsYXRlc3QpOwoKICAgIGNvbnN0IGZyb20gPSB1dGlsLnBhcnNlQWRkcmVzcyhsYXRlc3RIZWFkZXJzLmZyb20pOwogICAgY29uc3QgbWUgPSAhIWFjY291bnQgJiYgZnJvbS5lbWFpbCA9PT0gU3RyaW5nKGFjY291bnQpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBsYWJlbHMgPSBuZXcgU2V0KG1zZ3MuZmxhdE1hcChtID0-IG0ubGFiZWxJZHMgfHwgW10pKTsKCiAgICByZXR1cm4gewogICAgICBpZCwKICAgICAgaGlzdG9yeUlkLAogICAgICBzdWJqZWN0OiAoZmlyc3RIZWFkZXJzLnN1YmplY3QgfHwgJycpLnRyaW0oKSB8fCAnKG5vIHN1YmplY3QpJywKICAgICAgZnJvbTogbWUgPyAnbWUnIDogKHV0aWwuZGlzcGxheU5hbWUoZnJvbSkgfHwgJyh1bmtub3duIHNlbmRlciknKSwKICAgICAgZnJvbUVtYWlsOiBmcm9tLmVtYWlsLAogICAgIC",
"B0czogTnVtYmVyKGxhdGVzdC5pbnRlcm5hbERhdGUpIHx8IERhdGUucGFyc2UobGF0ZXN0SGVhZGVycy5kYXRlKSB8fCAwLAogICAgICBzbmlwcGV0OiB1dGlsLmRlY29kZUVudGl0aWVzKGxhdGVzdC5zbmlwcGV0IHx8IHRocmVhZC5zbmlwcGV0IHx8ICcnKSwKICAgICAgY291bnQ6IGJhc2lzLmxlbmd0aCwKICAgICAgdW5yZWFkOiBsYWJlbHMuaGFzKCdVTlJFQUQnKSwKICAgICAgc3RhcnJlZDogbGFiZWxzLmhhcygnU1RBUlJFRCcpLAogICAgICBoYXNEcmFmdDogbXNncy5zb21lKGlzRHJhZnQpLAogICAgICBsYWJlbElkczogWy4uLmxhYmVsc10sCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gc2VhcmNoUXVlcnkodGV4dCkgewogICAgY29uc3QgcSA9IFN0cmluZyh0ZXh0IHx8ICcnKS50cmltKCk7CiAgICByZXR1cm4gcSB8fCAnaW46aW5ib3gnOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgZWRpdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGNhcmQgY2FuIGNhcnJ5IHRoZSB1c2VyJ3Mgb3duIHRpdGxlLCBhIHNob3J0IG5vdGUgYW5kIGEgY29sb3VyLiBUaGV5CiAgLy8gbGl2ZSBpbiBzdG9yYWdlLnN5bmMgYmVzaWRlIHRoZSBjb2x1bW4gbGF5b3",
"V0IGFuZCBuZXZlciB0b3VjaCB0aGUgbWFpbDoKICAvLyBHbWFpbCBoYXMgbm93aGVyZSB0byBwdXQgYSBwcml2YXRlIHRpdGxlIG9uIGEgdGhyZWFkLCBhbmQgcmV3cml0aW5nIGEKICAvLyBzdWJqZWN0IHdvdWxkIGNoYW5nZSB3aGF0IGNvcnJlc3BvbmRlbnRzIHNlZSBpbiB0aGVpciByZXBsaWVzLgoKICBjb25zdCBDQVJEX0NPTE9VUlMgPSBbJ3JlZCcsICdvcmFuZ2UnLCAneWVsbG93JywgJ2dyZWVuJywgJ2JsdWUnLCAncHVycGxlJywgJ2dyZXknXTsKCiAgLy8gTG9uZyBlbm91Z2ggZm9yIGEgd29ya2luZyB0aXRsZSBvciBhICI0LDIwMCB3b3JkcywgZHVlIEZyaSIgbm90ZSwgc2hvcnQKICAvLyBlbm91Z2ggdGhhdCBodW5kcmVkcyBvZiBjYXJkcyBmaXQgc3luYydzIDEwMCBLQi4KICBjb25zdCBNQVhfVElUTEUgPSAyMDA7CiAgY29uc3QgTUFYX05PVEUgPSA1MDA7CgogIC8vIFJldHVybnMgdGhlIGVkaXQgdG8gc3RvcmUsIG9yIG51bGwgd2hlbiBub3RoaW5nIGRpZmZlcnMgZnJvbSB0aGUKICAvLyBlbWFpbCAtIHNvIGNsZWFyaW5nIGV2ZXJ5IGZpZWxkIGRlbGV0ZXMgdGhlIHJlY29yZCBpbnN0ZWFkIG9mIGxlYXZpbmcKICAvLyBhbiBlbXB0eSBvbmUgdG8gY291bnQgYWdhaW5zdCB0aGUgcXVvdGEuIEEgdGl0bGUgaWRlbnRpY2FsIHRvIHRoZQogIC8vIHN1YmplY3QgaXMgbm90IGFuIGVkaXQgZWl0aGVyOiB0aGUgZWRpdG9yIG9wZW5zIHByZS1maWxsZWQgd2l0aCBpdC4KICBmdW5jdGlvbiBub3JtYWxpc2",
"VDYXJkRWRpdChyYXcsIHN1YmplY3QgPSAnJykgewogICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsOwogICAgY29uc3QgdGl0bGUgPSBTdHJpbmcocmF3LnRpdGxlIHx8ICcnKS5yZXBsYWNlKC9ccysvZywgJyAnKS50cmltKCkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGNvbnN0IG5vdGUgPSBTdHJpbmcocmF3Lm5vdGUgfHwgJycpCiAgICAgIC5yZXBsYWNlKC9cclxuPy9nLCAnXG4nKQogICAgICAucmVwbGFjZSgvXG57Myx9L2csICdcblxuJykKICAgICAgLnRyaW0oKQogICAgICAuc2xpY2UoMCwgTUFYX05PVEUpOwogICAgY29uc3QgY29sb3VyID0gQ0FSRF9DT0xPVVJTLmluY2x1ZGVzKHJhdy5jb2xvdXIpID8gcmF3LmNvbG91ciA6ICcnOwoKICAgIGNvbnN0IG91dCA9IHt9OwogICAgaWYgKHRpdGxlICYmIHRpdGxlICE9PSBTdHJpbmcoc3ViamVjdCB8fCAnJykudHJpbSgpKSBvdXQudGl0bGUgPSB0aXRsZTsKICAgIGlmIChub3RlKSBvdXQubm90ZSA9IG5vdGU7CiAgICBpZiAoY29sb3VyKSBvdXQuY29sb3VyID0gY29sb3VyOwogICAgcmV0dXJuIE9iamVjdC5rZXlzKG91dCkubGVuZ3RoID8gb3V0IDogbnVsbDsKICB9CgogIGZ1bmN0aW9uIGRpc3BsYXlUaXRsZSh0aHJlYWQsIGVkaXQpIHsKICAgIHJldHVybiAoZWRpdCAmJiBlZGl0LnRpdGxlKSB8fCAodGhyZWFkICYmIHRocmVhZC5zdWJqZWN0KSB8fCAnKG5vIHN1YmplY3QpJzsKICB9CgogIC8vIFBpY2tzIG",
"9uZSBhY2NvdW50J3MgY2FyZCBlZGl0cyBvdXQgb2YgYSBzdG9yYWdlLnN5bmMgZHVtcCwga2V5ZWQgYnkKICAvLyB0aHJlYWQgaWQuIFJlY29yZHMgdGhhdCBubyBsb25nZXIgbm9ybWFsaXNlIHRvIGFueXRoaW5nIGFyZSBkcm9wcGVkLgogIGZ1bmN0aW9uIGNhcmRFZGl0c0Zyb20oYWxsLCBwcmVmaXgpIHsKICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTsKICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGFsbCB8fCB7fSkpIHsKICAgICAgaWYgKCFrZXkuc3RhcnRzV2l0aChwcmVmaXgpKSBjb250aW51ZTsKICAgICAgY29uc3QgaWQgPSBrZXkuc2xpY2UocHJlZml4Lmxlbmd0aCk7CiAgICAgIGNvbnN0IGVkaXQgPSBub3JtYWxpc2VDYXJkRWRpdCh2YWx1ZSk7CiAgICAgIGlmIChpZCAmJiBlZGl0KSBvdXQuc2V0KGlkLCBlZGl0KTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBERUZBVUxUX1JPT1QsIERFRkFVTFRfQ09MVU1OUywgZGVmYXVsdENvbHVtbnMsIG5vcm1hbGlzZUNvbHVtbnMsIGxhYmVsUm9vdCwgcmVzb2x2ZUNvbHVtbkxhYmVscywKICAgIG5ld0NvbHVtbklkLCB2YWxpZGF0ZUNvbHVtbnMsCiAgICBsYWJlbEFuY2VzdG9ycywgYXNzaWduQ29sdW1ucywgbWVyZ2VPcmRlciwgcGxhY2VJZCwgcHJ1bmVPcmRlciwKICAgIG1vdmVMYWJlbERpZmYsIHJlbW92ZUxhYmVsRGlmZiwgY29sdW1uRm9yTGFiZWxzLCBzdW1tYXJpc2VUaHJlYW",
"QsIHNlYXJjaFF1ZXJ5LAogICAgQ0FSRF9DT0xPVVJTLCBNQVhfVElUTEUsIE1BWF9OT1RFLCBub3JtYWxpc2VDYXJkRWRpdCwgZGlzcGxheVRpdGxlLCBjYXJkRWRpdHNGcm9tLAogIH07CgogIG5zLmxvZ2ljID0gYXBpOwogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgbW9kdWxlLmV4cG9ydHMgPSBhcGk7Cn0pKCk7Cg\"],[\"src/lib/calendar-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIENhbGVuZGFyIGxvZ2ljIChwdXJlKQovLwovLyBUaGUgQ2FsZW5kYXIgdGFiIHNob3dzIEdvb2dsZSBDYWxlbmRhcidzIGV2ZW50cyBhbmQgR29vZ2xlIFRhc2tzJwovLyB0YXNrcyBzaWRlIGJ5IHNpZGUsIGRheSBieSBkYXkuIFRoaXMgZmlsZSBob2xkcyB0aGUgcGFydHMgdGhhdCBuZWVkIG5vCi8vIGJyb3dzZXI6IGRhdGVzIGFzICJZWVlZLU1NLUREIiBrZXlzIGluIGxvY2FsIHRpbWUsIHRoZSByYW5nZXMgZWFjaAovLyB2aWV3IHNob3dzLCB0dXJuaW5nIHRoZSB0d28gQVBJcycgYW5zd2VycyBpbnRvIG9uZSBraW5kIG9mIGRheSB",
"pdGVtLAovLyBhbmQgd2hpY2ggcmVxdWVzdHMgdG8gR29vZ2xlIGFyZSBhbGxvd2VkIGF0IGFsbC4KLy8KLy8gSXQgaXMgcmVhZC1vbmx5IGZvciBub3cuIFRoZSBzZWNvbmQgc2lnbi1pbiBhc2tzIGZvciByZWFkLW9ubHkgYWNjZXNzIHRvCi8vIENhbGVuZGFyIGFuZCBUYXNrcywgYW5kIHRoZSByZXF1ZXN0IHBvbGljeSBiZWxvdyBvbmx5IGxldHMgR0VUcyB0aHJvdWdoOgovLyB0aGUgY2FsZW5kYXIgbGlzdCwgYSBjYWxlbmRhcidzIGV2ZW50cywgdGhlIHRhc2sgbGlzdHMgYW5kIGEgbGlzdCdzCi8vIHRhc2tzLgovLwovLyBMb2FkZWQgYnkgdGhlIGNvbnRlbnQgc2NyaXB0cywgdGhlIHNlcnZpY2Ugd29ya2VyLCB0aGUgcGhvbmUgYXBwJ3MKLy8gc2NyaXB0IGFuZCBOb2RlJ3MgdGVzdHMuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgR29vZ2xlLCBhbmQgd2hhdCBtYXkgYmUgYXNrZWQgb2YgaXQg4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRoZSBzZWNvbmQgc2lnbi1pbiwgc2VwYXJhdGUgZnJvbSBHbWFpbCdzLCBzbyB0aGF0IHRoZSBib2FyZCBhbmQgdGhlCiAgLy8gbm90ZXMgbmV2ZXIgc3RvcCB3b3JraW5nIGZvciBzb21lb25lIHdobyBoYXMgbm90IGFsbG93ZWQgdGhlIGNhbGVuZGFyLgogIC8vICJlbWFpbCIgbGV0cyB0aGUgd29ya2VyIGNoZWNrIHdob3NlIGNhbGVuZGFyIGl0IGlzLgogIGNvbnN0IFNDT1BFUyA9IFsKICAgICdlbWFpbCcsCiAgICAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC9jYWxlbmRhci5yZWFkb25seScsCiAgICAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC90YXNrcy5yZWFkb25seScsCiAgXTsKCiAgY29uc3QgQkFTRVMgPSB7CiAgICBjYWxlbmRhcjogJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2NhbGVuZGFyL3YzLycsCiAgICB0YXNrczogJ2h0dHBzOi8vdGFza3MuZ29vZ2xlYXBpcy5jb20vdGFza3MvdjEvJywKICB9OwoKICBjb25zdCBVU0VSSU5GT19VUkwgPSAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vb2F1dGgyL3YzL3VzZXJpbmZvJzsKCiAgLy8gT25lIHBhdGggc2VnbWVudDogYW4gaWQsIGVuY29kZWQgd2l0aCBlbmNvZGVVUklDb21wb25lbnQuIE5ldmVyIG9uZQogIC8vIHRoYXQgdGhlIFVSTCBwYXJzZXIgd291bGQ",
"gcmVhZCBhcyAiLiIgb3IgIi4uIiwgZW5jb2RlZCBvciBub3QuCiAgZnVuY3Rpb24gaXNTZWdtZW50KHMpIHsKICAgIGlmICghL15bQS1aYS16MC05JS5ffi1dKyQvLnRlc3QocykpIHJldHVybiBmYWxzZTsKICAgIGxldCBwbGFpbjsKICAgIHRyeSB7IHBsYWluID0gZGVjb2RlVVJJQ29tcG9uZW50KHMpOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9CiAgICByZXR1cm4gIS9eXC4rJC8udGVzdChwbGFpbikgJiYgIXBsYWluLmluY2x1ZGVzKCcvJyk7CiAgfQoKICBjb25zdCBBTExPV0VEID0gewogICAgY2FsZW5kYXI6IFsKICAgICAgcCA9PiBwID09PSAndXNlcnMvbWUvY2FsZW5kYXJMaXN0JywKICAgICAgcCA9PiB7IGNvbnN0IG0gPSAvXmNhbGVuZGFyc1wvKFteL10rKVwvZXZlbnRzJC8uZXhlYyhwKTsgcmV0dXJuICEhbSAmJiBpc1NlZ21lbnQobVsxXSk7IH0sCiAgICBdLAogICAgdGFza3M6IFsKICAgICAgcCA9PiBwID09PSAndXNlcnMvQG1lL2xpc3RzJywKICAgICAgcCA9PiB7IGNvbnN0IG0gPSAvXmxpc3RzXC8oW14vXSspXC90YXNrcyQvLmV4ZWMocCk7IHJldHVybiAhIW0gJiYgaXNTZWdtZW50KG1bMV0pOyB9LAogICAgXSwKICB9OwoKICBmdW5jdGlvbiBpc0FsbG93ZWRSZXF1ZXN0KHNlcnZpY2UsIG1ldGhvZCwgcGF0aCkgewogICAgaWYgKFN0cmluZyhtZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCkgIT09ICdHRVQnKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBydWxlcyA9IE9iamVjdC5wcm9",
"0b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChBTExPV0VELCBzZXJ2aWNlKSA_IEFMTE9XRURbc2VydmljZV0gOiBudWxsOwogICAgcmV0dXJuICEhcnVsZXMgJiYgcnVsZXMuc29tZShvayA9PiBvayhTdHJpbmcocGF0aCB8fCAnJykpKTsKICB9CgogIC8vIFF1ZXJ5IHZhbHVlcyBtYXkgYmUgYXJyYXlzLCBhcyBmb3IgR21haWwuCiAgZnVuY3Rpb24gYnVpbGRVcmwoc2VydmljZSwgcGF0aCwgcXVlcnkpIHsKICAgIGNvbnN0IHBhcnRzID0gW107CiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhxdWVyeSB8fCB7fSkpIHsKICAgICAgY29uc3QgdiA9IHF1ZXJ5W2tleV07CiAgICAgIGlmICh2ID09PSB1bmRlZmluZWQgfHwgdiA9PT0gbnVsbCB8fCB2ID09PSAnJykgY29udGludWU7CiAgICAgIGZvciAoY29uc3Qgb25lIG9mIFtdLmNvbmNhdCh2KSkgcGFydHMucHVzaChgJHtlbmNvZGVVUklDb21wb25lbnQoa2V5KX09JHtlbmNvZGVVUklDb21wb25lbnQob25lKX1gKTsKICAgIH0KICAgIHJldHVybiBCQVNFU1tzZXJ2aWNlXSArIHBhdGggKyAocGFydHMubGVuZ3RoID8gYD8ke3BhcnRzLmpvaW4oJyYnKX1gIDogJycpOwogIH0KCiAgLy8g4pSA4pSAIERhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gQSBkYXkgaXMgYSAiWVlZWS1NTS1ERCIgc3RyaW5nIGluIGxvY2FsIHRpbWU6IGl0IHNvcnRzIGFuZCBjb21wYXJlcyBhcwogIC8vIHRleHQsIGFuZCBzdXJ2aXZlcyBzdG9yYWdlIGFuZCBtZXNzYWdlcyB1bmNoYW5nZWQuIFdlZWtzIHN0YXJ0IG9uCiAgLy8gTW9uZGF5IGFuZCBhcmUgbnVtYmVyZWQgYXMgSVNPIDg2MDEgbnVtYmVycyB0aGVtLgoKICBjb25zdCBEQVlfTkFNRVMgPSBbJ01vbicsICdUdWUnLCAnV2VkJywgJ1RodScsICdGcmknLCAnU2F0JywgJ1N1biddOwogIGNvbnN0IE1PTlRIUyA9IFsnSmFuJywgJ0ZlYicsICdNYXInLCAnQXByJywgJ01heScsICdKdW4nLCAnSnVsJywgJ0F1ZycsICdTZXAnLCAnT2N0JywgJ05vdicsICdEZWMnXTsKICBjb25zdCBNT05USFNfTE9ORyA9IFsnSmFudWFyeScsICdGZWJydWFyeScsICdNYXJjaCcsICdBcHJpbCcsICdNYXknLCAnSnVuZScsICdKdWx5JywKICAgICAgICAgICAgICAgICAgICAgICAnQXVndXN0JywgJ1NlcHRlbWJlcicsICdPY3RvYmVyJywgJ05vdmVtYmVyJywgJ0RlY2VtYmVyJ107CgogIC8vIEhvdyBmYXIgdGhlIGFnZW5kYSBsb29rcyBhaGVhZCwgYW5kIGhvdyBmYXIgb25lIHN0ZXAgbW92ZXMgaXQuCiAgY29uc3QgQUdFTkRBX0RBWVMgPSAyODsKCiAgY29uc3QgcGFkID0gbiA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgJzAnKTsKCiAgZnVuY3Rpb24gZGF",
"0ZUtleShkKSB7CiAgICBjb25zdCB4ID0gZCBpbnN0YW5jZW9mIERhdGUgPyBkIDogbmV3IERhdGUoZCk7CiAgICByZXR1cm4gYCR7eC5nZXRGdWxsWWVhcigpfS0ke3BhZCh4LmdldE1vbnRoKCkgKyAxKX0tJHtwYWQoeC5nZXREYXRlKCkpfWA7CiAgfQoKICBmdW5jdGlvbiBpc0tleShrZXkpIHsKICAgIHJldHVybiAvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChTdHJpbmcoa2V5IHx8ICcnKSk7CiAgfQoKICBmdW5jdGlvbiBmcm9tS2V5KGtleSkgewogICAgY29uc3QgW3ksIG0sIGRdID0gU3RyaW5nKGtleSkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIHJldHVybiBuZXcgRGF0ZSh5LCBtIC0gMSwgZCk7CiAgfQoKICBmdW5jdGlvbiBhZGREYXlzKGtleSwgbikgewogICAgY29uc3QgZCA9IGZyb21LZXkoa2V5KTsKICAgIGQuc2V0RGF0ZShkLmdldERhdGUoKSArIG4pOwogICAgcmV0dXJuIGRhdGVLZXkoZCk7CiAgfQoKICAvLyBXaG9sZSBkYXlzIGZyb20gYSB0byBiLiBSb3VuZGVkLCBiZWNhdXNlIGEgZGF5IHdpdGggYSBjbG9jayBjaGFuZ2UKICAvLyBpbiBpdCBpcyBhbiBob3VyIGxvbmdlciBvciBzaG9ydGVyIHRoYW4gMjQuCiAgZnVuY3Rpb24gZGF5c0JldHdlZW4oYSwgYikgewogICAgcmV0dXJuIE1hdGgucm91bmQoKGZyb21LZXkoYikgLSBmcm9tS2V5KGEpKSAvIDg2NDAwMDAwKTsKICB9CgogIC8vIDAgZm9yIE1vbmRheSDigKYgNiBmb3IgU3VuZGF5LgogIGZ1bmN0aW9uIHdlZWtkYXkoa2V5KSB",
"7CiAgICByZXR1cm4gKGZyb21LZXkoa2V5KS5nZXREYXkoKSArIDYpICUgNzsKICB9CgogIGZ1bmN0aW9uIHdlZWtTdGFydChrZXkpIHsKICAgIHJldHVybiBhZGREYXlzKGtleSwgLXdlZWtkYXkoa2V5KSk7CiAgfQoKICAvLyBUaGUgSVNPIHdlZWs6IHRoZSBvbmUgd2l0aCB0aGUgeWVhcidzIGZpcnN0IFRodXJzZGF5IGluIGl0IGlzIHdlZWsgMS4KICBmdW5jdGlvbiBpc29XZWVrKGtleSkgewogICAgY29uc3QgdGh1cnNkYXkgPSBhZGREYXlzKHdlZWtTdGFydChrZXkpLCAzKTsKICAgIGNvbnN0IGZpcnN0VGh1cnNkYXkgPSBhZGREYXlzKHdlZWtTdGFydChgJHt0aHVyc2RheS5zbGljZSgwLCA0KX0tMDEtMDRgKSwgMyk7CiAgICByZXR1cm4gMSArIGRheXNCZXR3ZWVuKGZpcnN0VGh1cnNkYXksIHRodXJzZGF5KSAvIDc7CiAgfQoKICBmdW5jdGlvbiBtb250aFN0YXJ0KGtleSkgewogICAgcmV0dXJuIGAke1N0cmluZyhrZXkpLnNsaWNlKDAsIDcpfS0wMWA7CiAgfQoKICAvLyBUaGUgc2FtZSBkYXkgbiBtb250aHMgb24sIG9yIHRoZSBtb250aCdzIGxhc3QgZGF5IGlmIGl0IGlzIHNob3J0ZXIuCiAgZnVuY3Rpb24gYWRkTW9udGhzKGtleSwgbikgewogICAgY29uc3QgW3ksIG0sIGRdID0gU3RyaW5nKGtleSkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIGNvbnN0IGZpcnN0ID0gbmV3IERhdGUoeSwgbSAtIDEgKyBuLCAxKTsKICAgIGNvbnN0IGxhc3QgPSBuZXcgRGF0ZShmaXJzdC5nZXRGdWxsWWVhcigpLCB",
"maXJzdC5nZXRNb250aCgpICsgMSwgMCkuZ2V0RGF0ZSgpOwogICAgcmV0dXJuIGRhdGVLZXkobmV3IERhdGUoZmlyc3QuZ2V0RnVsbFllYXIoKSwgZmlyc3QuZ2V0TW9udGgoKSwgTWF0aC5taW4oZCwgbGFzdCkpKTsKICB9CgogIC8vIFRoZSBkYXlzIGZyb20gc3RhcnQgdXAgdG8sIG5vdCBpbmNsdWRpbmcsIGVuZC4KICBmdW5jdGlvbiBkYXlzKHN0YXJ0LCBlbmQpIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgZm9yIChsZXQgayA9IHN0YXJ0OyBrIDwgZW5kOyBrID0gYWRkRGF5cyhrLCAxKSkgb3V0LnB1c2goayk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g4pSA4pSAIFZpZXdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBWSUVXUyA9IFsnd2VlaycsICdtb250aCcsICdhZ2VuZGEnXTsKCiAgLy8gV2hhdCBhIHZpZXcgc2hvd3MgYXJvdW5kIHRoZSBkYXkgaW4gZm9jdXM6IHRoZSB3ZWVrIGl0IGlzIGluOyBpdHMKICAvLyBtb250aCwgYXMgd2hvbGUgd2Vla3M7IG9yLCBmb3IgdGhlIGFnZW5kYSwgZm91ciB3ZWVrcyBmcm9tIHRoYXQgZGF5LgogIC8vIGVuZCBpcyB0aGUgZGF5IGFmdGVyIHRoZSBsYXN0LgogIGZ1bmN",
"0aW9uIHZpZXdSYW5nZSh2aWV3LCBhbmNob3IpIHsKICAgIGlmICh2aWV3ID09PSAnbW9udGgnKSB7CiAgICAgIGNvbnN0IGZpcnN0ID0gbW9udGhTdGFydChhbmNob3IpOwogICAgICBjb25zdCBsYXN0ID0gYWRkRGF5cyhhZGRNb250aHMoZmlyc3QsIDEpLCAtMSk7CiAgICAgIHJldHVybiB7IHN0YXJ0OiB3ZWVrU3RhcnQoZmlyc3QpLCBlbmQ6IGFkZERheXMod2Vla1N0YXJ0KGxhc3QpLCA3KSB9OwogICAgfQogICAgaWYgKHZpZXcgPT09ICdhZ2VuZGEnKSByZXR1cm4geyBzdGFydDogYW5jaG9yLCBlbmQ6IGFkZERheXMoYW5jaG9yLCBBR0VOREFfREFZUykgfTsKICAgIGNvbnN0IHN0YXJ0ID0gd2Vla1N0YXJ0KGFuY2hvcik7CiAgICByZXR1cm4geyBzdGFydCwgZW5kOiBhZGREYXlzKHN0YXJ0LCA3KSB9OwogIH0KCiAgZnVuY3Rpb24gc3RlcCh2aWV3LCBhbmNob3IsIGRpcikgewogICAgaWYgKHZpZXcgPT09ICdtb250aCcpIHJldHVybiBhZGRNb250aHMoYW5jaG9yLCBkaXIpOwogICAgaWYgKHZpZXcgPT09ICdhZ2VuZGEnKSByZXR1cm4gYWRkRGF5cyhhbmNob3IsIGRpciAqIEFHRU5EQV9EQVlTKTsKICAgIHJldHVybiBhZGREYXlzKGFuY2hvciwgZGlyICogNyk7CiAgfQoKICAvLyBUaGUgbW9udGggYXMgcm93cyBvZiBzZXZlbiBkYXlzLCBmb3IgdGhlIHNtYWxsIGNhbGVuZGFyLgogIGZ1bmN0aW9uIG1vbnRoV2Vla3MoYW5jaG9yKSB7CiAgICBjb25zdCB7IHN0YXJ0LCBlbmQgfSA9IHZpZXdSYW5nZSgnbW9",
"udGgnLCBhbmNob3IpOwogICAgY29uc3QgYWxsID0gZGF5cyhzdGFydCwgZW5kKTsKICAgIGNvbnN0IHJvd3MgPSBbXTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYWxsLmxlbmd0aDsgaSArPSA3KSByb3dzLnB1c2goYWxsLnNsaWNlKGksIGkgKyA3KSk7CiAgICByZXR1cm4gcm93czsKICB9CgogIC8vICIyOCBTZXAg4oCTIDQgT2N0IiwgIjUg4oCTIDExIE9jdCIsIHdpdGggdGhlIHllYXIgd2hlbiBpdCBpcyBub3QgdGhpcyBvbmUuCiAgZnVuY3Rpb24gc3BhblRleHQoZmlyc3QsIGxhc3QsIHRvZGF5KSB7CiAgICBjb25zdCBbeTEsIG0xLCBkMV0gPSBmaXJzdC5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgY29uc3QgW3kyLCBtMiwgZDJdID0gbGFzdC5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgY29uc3QgdGhpc1llYXIgPSBOdW1iZXIoU3RyaW5nKHRvZGF5KS5zbGljZSgwLCA0KSk7CiAgICBjb25zdCB5ZWFyID0geSA9PiAoeSAhPT0gdGhpc1llYXIgPyBgICR7eX1gIDogJycpOwogICAgaWYgKGZpcnN0ID09PSBsYXN0KSByZXR1cm4gYCR7ZDF9ICR7TU9OVEhTW20xIC0gMV19JHt5ZWFyKHkxKX1gOwogICAgaWYgKHkxICE9PSB5MikgcmV0dXJuIGAke2QxfSAke01PTlRIU1ttMSAtIDFdfSAke3kxfSDigJMgJHtkMn0gJHtNT05USFNbbTIgLSAxXX0gJHt5Mn1gOwogICAgaWYgKG0xID09PSBtMikgcmV0dXJuIGAke2QxfSDigJMgJHtkMn0gJHtNT05USFNbbTIgLSAxXX0ke3llYXIoeTIpfWA7CiAgICB",
"yZXR1cm4gYCR7ZDF9ICR7TU9OVEhTW20xIC0gMV19IOKAkyAke2QyfSAke01PTlRIU1ttMiAtIDFdfSR7eWVhcih5Mil9YDsKICB9CgogIGZ1bmN0aW9uIHRpdGxlKHZpZXcsIGFuY2hvciwgdG9kYXkpIHsKICAgIGlmICh2aWV3ID09PSAnbW9udGgnKSB7CiAgICAgIGNvbnN0IFt5LCBtXSA9IGFuY2hvci5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgICByZXR1cm4gYCR7TU9OVEhTX0xPTkdbbSAtIDFdfSAke3l9YDsKICAgIH0KICAgIGNvbnN0IHsgc3RhcnQsIGVuZCB9ID0gdmlld1JhbmdlKHZpZXcsIGFuY2hvcik7CiAgICBjb25zdCBzcGFuID0gc3BhblRleHQoc3RhcnQsIGFkZERheXMoZW5kLCAtMSksIHRvZGF5KTsKICAgIHJldHVybiB2aWV3ID09PSAnd2VlaycgPyBgV2VlayAke2lzb1dlZWsoYW5jaG9yKX0gwrcgJHtzcGFufWAgOiBzcGFuOwogIH0KCiAgZnVuY3Rpb24gbW9udGhOYW1lKGtleSkgewogICAgY29uc3QgW3ksIG1dID0ga2V5LnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4geyBsb25nOiBNT05USFNfTE9OR1ttIC0gMV0sIHNob3J0OiBNT05USFNbbSAtIDFdLCB5ZWFyOiB5IH07CiAgfQoKICBmdW5jdGlvbiBkYXlOYW1lKGtleSkgewogICAgcmV0dXJuIERBWV9OQU1FU1t3ZWVrZGF5KGtleSldOwogIH0KCiAgLy8g4pSA4pSAIFNvdXJjZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHNhZmVDb2xvdXIoYykgewogICAgcmV0dXJuIC9eI1swLTlhLWZdezZ9JC9pLnRlc3QoU3RyaW5nKGMgfHwgJycpKSA_IFN0cmluZyhjKS50b0xvd2VyQ2FzZSgpIDogJyc7CiAgfQoKICAvLyBPbmx5IHBsYWluIGh0dHBzIGxpbmtzIGFyZSBldmVyIHB1dCBvbiB0aGUgcGFnZS4KICBmdW5jdGlvbiBzYWZlTGluayh1cmwpIHsKICAgIHJldHVybiAvXmh0dHBzOlwvXC9bXlxzXSskL2kudGVzdChTdHJpbmcodXJsIHx8ICcnKSkgPyBTdHJpbmcodXJsKSA6ICcnOwogIH0KCiAgLy8gQSBjYWxlbmRhciBmcm9tIGNhbGVuZGFyTGlzdC4gR29vZ2xlJ3Mgb3duICJzaG93IGluIHRoZSBsaXN0IiBjaG9pY2UKICAvLyAoc2VsZWN0ZWQpIGRlY2lkZXMgd2hldGhlciBpdCBpcyBvbiB1bnRpbCBzb21lb25lIHNheXMgb3RoZXJ3aXNlIGhlcmU7CiAgLy8gY2FsZW5kYXJzIGhpZGRlbiBmcm9tIEdvb2dsZSdzIGxpc3QgYXJlIGxlZnQgb3V0LiBUaGUgbWFpbiBjYWxlbmRhcgogIC8vIGlzIHVzdWFsbHkgbmFtZWQgYWZ0ZXIgdGhlIGFkZHJlc3MsIG9mIHdoaWNoIHRoZSBuYW1lIHBhcnQgd2lsbCBkby4KICBmdW5jdGlvbiBjYWxlbmRhclNvdXJjZShjKSB7CiAgICBpZiAoIWMgfHwgIWMuaWQgfHwgYy5oaWRkZW4pIHJldHVybiBudWx",
"sOwogICAgbGV0IG5hbWUgPSBTdHJpbmcoYy5zdW1tYXJ5T3ZlcnJpZGUgfHwgYy5zdW1tYXJ5IHx8IGMuaWQpLnRyaW0oKTsKICAgIGlmIChjLnByaW1hcnkgJiYgbmFtZS5pbmNsdWRlcygnQCcpKSBuYW1lID0gbmFtZS5zcGxpdCgnQCcpWzBdOwogICAgcmV0dXJuIHsKICAgICAga2luZDogJ2NhbGVuZGFyJywgaWQ6IFN0cmluZyhjLmlkKSwgbmFtZSwKICAgICAgY29sb3VyOiBzYWZlQ29sb3VyKGMuYmFja2dyb3VuZENvbG9yKSB8fCAnIzFhNzNlOCcsCiAgICAgIHByaW1hcnk6ICEhYy5wcmltYXJ5LCBvbjogYy5zZWxlY3RlZCAhPT0gZmFsc2UsCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gbGlzdFNvdXJjZShsKSB7CiAgICBpZiAoIWwgfHwgIWwuaWQpIHJldHVybiBudWxsOwogICAgcmV0dXJuIHsga2luZDogJ3Rhc2tzJywgaWQ6IFN0cmluZyhsLmlkKSwgbmFtZTogU3RyaW5nKGwudGl0bGUgfHwgJycpLnRyaW0oKSB8fCAnVGFza3MnLCBvbjogdHJ1ZSB9OwogIH0KCiAgLy8gVGhlIG1haW4gY2FsZW5kYXIgZmlyc3QsIHRoZW4gdGhlIHJlc3QgYXMgR29vZ2xlIGxpc3RzIHRoZW0sIHRoZW4KICAvLyB0aGUgdGFzayBsaXN0cy4KICBmdW5jdGlvbiBzb3VyY2VzKGNhbGVuZGFySXRlbXMsIGxpc3RJdGVtcykgewogICAgY29uc3QgY2FscyA9IChjYWxlbmRhckl0ZW1zIHx8IFtdKS5tYXAoY2FsZW5kYXJTb3VyY2UpLmZpbHRlcihCb29sZWFuKTsKICAgIGNhbHMuc29ydCgoYSwgYikgPT4gTnVtYmVyKGIucHJpbWF",
"yeSkgLSBOdW1iZXIoYS5wcmltYXJ5KSk7CiAgICByZXR1cm4gY2Fscy5jb25jYXQoKGxpc3RJdGVtcyB8fCBbXSkubWFwKGxpc3RTb3VyY2UpLmZpbHRlcihCb29sZWFuKSk7CiAgfQoKICAvLyBUaGUgc3dpdGNoIHNvbWVvbmUgZmxpY2tlZCBoZXJlIHdpbnMgb3ZlciBHb29nbGUncyBkZWZhdWx0LgogIGZ1bmN0aW9uIGlzT24oc291cmNlLCBvdmVycmlkZXMpIHsKICAgIGNvbnN0IG8gPSBvdmVycmlkZXMgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG92ZXJyaWRlcywgc291cmNlLmlkKSA_IG92ZXJyaWRlc1tzb3VyY2UuaWRdIDogdW5kZWZpbmVkOwogICAgcmV0dXJuIHR5cGVvZiBvID09PSAnYm9vbGVhbicgPyBvIDogc291cmNlLm9uOwogIH0KCiAgLy8g4pSA4pSAIFJlcXVlc3RzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBDQUxFTkRBUl9MSVNUX0ZJRUxEUyA9ICdpdGVtcyhpZCxzdW1tYXJ5LHN1bW1hcnlPdmVycmlkZSxiYWNrZ3JvdW5kQ29sb3Isc2VsZWN0ZWQsaGlkZGVuLHByaW1hcnksYWNjZXNzUm9sZSknOwogIGNvbnN0IEVWRU5UX0ZJRUxEUyA9ICdpdGVtcyhpZCxzdGF0dXMsc3VtbWFyeSxzdGF",
"ydCxlbmQsaHRtbExpbmssY29sb3JJZCxldmVudFR5cGUsbG9jYXRpb24pLG5leHRQYWdlVG9rZW4nOwoKICBmdW5jdGlvbiBzb3VyY2VSZXF1ZXN0cygpIHsKICAgIHJldHVybiBbCiAgICAgIFsnY2FsZW5kYXInLCAndXNlcnMvbWUvY2FsZW5kYXJMaXN0JywgeyBtaW5BY2Nlc3NSb2xlOiAncmVhZGVyJywgbWF4UmVzdWx0czogMjUwLCBmaWVsZHM6IENBTEVOREFSX0xJU1RfRklFTERTIH1dLAogICAgICBbJ3Rhc2tzJywgJ3VzZXJzL0BtZS9saXN0cycsIHsgbWF4UmVzdWx0czogMTAwIH1dLAogICAgXTsKICB9CgogIC8vIEZvciBlYWNoIGNhbGVuZGFyLCBpdHMgZXZlbnRzIGluIHRoZSByYW5nZSAoYSBkYXkgZWl0aGVyIHNpZGUsIGZvcgogIC8vIGNhbGVuZGFycyBpbiBhbm90aGVyIHRpbWUgem9uZTsgdGhlIGRheXMgYXJlIHNvcnRlZCBvdXQgaGVyZSkuIEZvcgogIC8vIGVhY2ggdGFzayBsaXN0LCBpdHMgb3BlbiB0YXNrcyAtIGRhdGVkIG9yIG5vdCwgZm9yIHRoZSAiTm8gZGF0ZSIgdHJheQogIC8vIGFuZCBhbnl0aGluZyBvdmVyZHVlIC0gYW5kIHRoZSBvbmVzIGRvbmUgd2l0aGluIHRoZSByYW5nZS4gR29vZ2xlJ3MKICAvLyBvd24gYXBwcyBoaWRlIGEgdGFzayB3aGVuIGl0IGlzIHRpY2tlZCwgaGVuY2Ugc2hvd0hpZGRlbi4KICBmdW5jdGlvbiByYW5nZVJlcXVlc3RzKHJhbmdlLCBjYWxlbmRhcnMsIGxpc3RzKSB7CiAgICBjb25zdCBmcm9tID0gYWRkRGF5cyhyYW5nZS5zdGFydCwgLTEpOwogICAgY29",
"uc3QgdG8gPSBhZGREYXlzKHJhbmdlLmVuZCwgMSk7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAoY29uc3QgYyBvZiBjYWxlbmRhcnMpIHsKICAgICAgb3V0LnB1c2goWydjYWxlbmRhcicsIGBjYWxlbmRhcnMvJHtlbmNvZGVVUklDb21wb25lbnQoYy5pZCl9L2V2ZW50c2AsIHsKICAgICAgICB0aW1lTWluOiBmcm9tS2V5KGZyb20pLnRvSVNPU3RyaW5nKCksIHRpbWVNYXg6IGZyb21LZXkodG8pLnRvSVNPU3RyaW5nKCksCiAgICAgICAgc2luZ2xlRXZlbnRzOiAndHJ1ZScsIG9yZGVyQnk6ICdzdGFydFRpbWUnLCBtYXhSZXN1bHRzOiAyNTAwLCBmaWVsZHM6IEVWRU5UX0ZJRUxEUywKICAgICAgfV0pOwogICAgfQogICAgZm9yIChjb25zdCBsIG9mIGxpc3RzKSB7CiAgICAgIGNvbnN0IHBhdGggPSBgbGlzdHMvJHtlbmNvZGVVUklDb21wb25lbnQobC5pZCl9L3Rhc2tzYDsKICAgICAgb3V0LnB1c2goWyd0YXNrcycsIHBhdGgsIHsgc2hvd0NvbXBsZXRlZDogJ2ZhbHNlJywgbWF4UmVzdWx0czogMTAwIH1dKTsKICAgICAgb3V0LnB1c2goWyd0YXNrcycsIHBhdGgsIHsKICAgICAgICBzaG93Q29tcGxldGVkOiAndHJ1ZScsIHNob3dIaWRkZW46ICd0cnVlJywgbWF4UmVzdWx0czogMTAwLAogICAgICAgIGR1ZU1pbjogYCR7ZnJvbX1UMDA6MDA6MDAuMDAwWmAsIGR1ZU1heDogYCR7dG99VDAwOjAwOjAwLjAwMFpgLAogICAgICB9XSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g4pSA4pSAIEl0ZW1",
"zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBHb29nbGUgQ2FsZW5kYXIncyBvd24gZXZlbnQgY29sb3VycywgYnkgY29sb3JJZC4KICBjb25zdCBFVkVOVF9DT0xPVVJTID0gewogICAgMTogJyM3OTg2Y2InLCAyOiAnIzMzYjY3OScsIDM6ICcjOGUyNGFhJywgNDogJyNlNjdjNzMnLCA1OiAnI2Y2YmYyNicsIDY6ICcjZjQ1MTFlJywKICAgIDc6ICcjMDM5YmU1JywgODogJyM2MTYxNjEnLCA5OiAnIzNmNTFiNScsIDEwOiAnIzBiODA0MycsIDExOiAnI2Q1MDAwMCcsCiAgfTsKCiAgLy8gQW4gZXZlbnQsIG9uIGV2ZXJ5IGRheSBpdCBjb3ZlcnMgKGZpcnN0IHRvIGxhc3QsIGJvdGggaW5jbHVkZWQpLgogIC8vIFdvcmtpbmctbG9jYXRpb24gZW50cmllcyAoIkhvbWUiLCAiT2ZmaWNlIikgYXJlIGxlZnQgb3V0OiB0aGV5IGFyZQogIC8vIG9uIGV2ZXJ5IGRheSBhbmQgc2F5IG5vdGhpbmcgYSBnbGFuY2UgbmVlZHMuCiAgZnVuY3Rpb24gZXZlbnRJdGVtKGV2LCBjYWwpIHsKICAgIGlmICghZXYgfHwgZXYuc3RhdHVzID09PSAnY2FuY2VsbGVkJyB8fCBldi5ldmVudFR5cGUgPT09ICd3b3JraW5nTG9jYXRpb24nKSByZXR1cm4gbnVsbDs",
"KICAgIGNvbnN0IHMgPSBldi5zdGFydCB8fCB7fTsKICAgIGNvbnN0IGUgPSBldi5lbmQgfHwge307CiAgICBjb25zdCBiYXNlID0gewogICAgICBraW5kOiAnZXZlbnQnLCBpZDogYCR7Y2FsLmlkfXwke2V2LmlkfWAsIHNvdXJjZTogY2FsLmlkLAogICAgICB0aXRsZTogU3RyaW5nKGV2LnN1bW1hcnkgfHwgJycpLnRyaW0oKSB8fCAnKE5vIHRpdGxlKScsCiAgICAgIGNvbG91cjogRVZFTlRfQ09MT1VSU1tldi5jb2xvcklkXSB8fCBjYWwuY29sb3VyLAogICAgICBsaW5rOiBzYWZlTGluayhldi5odG1sTGluayksIHdoZXJlOiBTdHJpbmcoZXYubG9jYXRpb24gfHwgJycpLnRyaW0oKSwKICAgIH07CiAgICBpZiAoaXNLZXkocy5kYXRlKSkgewogICAgICBjb25zdCBsYXN0ID0gaXNLZXkoZS5kYXRlKSA_IGFkZERheXMoZS5kYXRlLCAtMSkgOiBzLmRhdGU7CiAgICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJhc2UsIHsgYWxsRGF5OiB0cnVlLCBmaXJzdDogcy5kYXRlLCBsYXN0OiBsYXN0IDwgcy5kYXRlID8gcy5kYXRlIDogbGFzdCwgc3RhcnQ6IDAsIGVuZDogMCB9KTsKICAgIH0KICAgIGNvbnN0IHN0YXJ0ID0gRGF0ZS5wYXJzZShzLmRhdGVUaW1lKTsKICAgIGlmICghaXNGaW5pdGUoc3RhcnQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGVuZE1zID0gRGF0ZS5wYXJzZShlLmRhdGVUaW1lKTsKICAgIGNvbnN0IGVuZCA9IGlzRmluaXRlKGVuZE1zKSAmJiBlbmRNcyA-IHN0YXJ0ID8gZW5kTXMgOiBzdGFydDsKICA",
"gIC8vIEFuIGV2ZW50IGVuZGluZyBhdCBtaWRuaWdodCBkb2VzIG5vdCBzcGlsbCBpbnRvIHRoZSBuZXh0IGRheS4KICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJhc2UsIHsKICAgICAgYWxsRGF5OiBmYWxzZSwgc3RhcnQsIGVuZCwgZmlyc3Q6IGRhdGVLZXkoc3RhcnQpLCBsYXN0OiBkYXRlS2V5KE1hdGgubWF4KHN0YXJ0LCBlbmQgLSAxKSksCiAgICB9KTsKICB9CgogIC8vIEEgdGFzaywgb24gaXRzIGR1ZSBkYXkuIEdvb2dsZSBrZWVwcyBvbmx5IHRoZSBkYXRlIG9mIGEgZHVlIGRhdGUgKHRoZQogIC8vIHRpbWUgaXMgYWx3YXlzIG1pZG5pZ2h0IFVUQyksIHNvIHRoZSBkYXRlIGlzIHJlYWQgYXMgd3JpdHRlbiwgbm90CiAgLy8gbW92ZWQgaW50byB0aGUgbG9jYWwgdGltZSB6b25lLiBBIHRhc2sgbWFkZSBmcm9tIGFuIGVtYWlsIGluIEdtYWlsCiAgLy8gbGlua3MgYmFjayB0byBpdC4KICBmdW5jdGlvbiB0YXNrSXRlbSh0LCBsaXN0KSB7CiAgICBpZiAoIXQgfHwgIXQuaWQgfHwgdC5kZWxldGVkKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHRpdGxlID0gU3RyaW5nKHQudGl0bGUgfHwgJycpLnRyaW0oKTsKICAgIGlmICghdGl0bGUpIHJldHVybiBudWxsOwogICAgY29uc3QgZHVlID0gL15cZHs0fS1cZHsyfS1cZHsyfS8udGVzdChTdHJpbmcodC5kdWUgfHwgJycpKSA_IFN0cmluZyh0LmR1ZSkuc2xpY2UoMCwgMTApIDogJyc7CiAgICBjb25zdCBtYWlsID0gKHQubGlua3MgfHwgW10pLmZpbmQobCA9PiBsICY",
"mIGwudHlwZSA9PT0gJ2VtYWlsJyAmJiAvXmh0dHBzOlwvXC9tYWlsXC5nb29nbGVcLmNvbVwvLy50ZXN0KFN0cmluZyhsLmxpbmsgfHwgJycpKSk7CiAgICByZXR1cm4gewogICAgICBraW5kOiAndGFzaycsIGlkOiBgJHtsaXN0LmlkfXwke3QuaWR9YCwgc291cmNlOiBsaXN0LmlkLCB0aXRsZSwgZHVlLAogICAgICBkb25lOiB0LnN0YXR1cyA9PT0gJ2NvbXBsZXRlZCcsIGVtYWlsOiAhIW1haWwsCiAgICAgIGxpbms6IHNhZmVMaW5rKG1haWwgPyBtYWlsLmxpbmsgOiB0LndlYlZpZXdMaW5rKSwgbGlzdDogbGlzdC5uYW1lLAogICAgfTsKICB9CgogIC8vIFRhc2tzIGFycml2ZSB0d2ljZSB3aGVuIG9uZSBpcyBib3RoIG9wZW4gYW5kIGR1ZSBpbiB0aGUgcmFuZ2UuCiAgZnVuY3Rpb24gdW5pcXVlQnlJZChpdGVtcykgewogICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoKTsKICAgIHJldHVybiBpdGVtcy5maWx0ZXIoeCA9PiAhc2Vlbi5oYXMoeC5pZCkgJiYgc2Vlbi5hZGQoeC5pZCkpOwogIH0KCiAgLy8gQWxsLWRheSBmaXJzdCwgdGhlbiBieSB0aW1lLCB0aGVuIHRoZSB0YXNrczogb3BlbiBiZWZvcmUgZG9uZS4KICBmdW5jdGlvbiBjb21wYXJlSXRlbXMoYSwgYikgewogICAgY29uc3QgcmFuayA9IHggPT4gKHgua2luZCA9PT0gJ2V2ZW50JyA_ICh4LmFsbERheSA_IDAgOiAxKSA6ICh4LmRvbmUgPyAzIDogMikpOwogICAgcmV0dXJuIHJhbmsoYSkgLSByYW5rKGIpIHx8IChhLnN0YXJ0IHx8IDApIC0gKGIuc3RhcnQ",
"gfHwgMCkgfHwgYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpOwogIH0KCiAgLy8gRGF5IGtleSDihpIgd2hhdCBpcyBvbiBpdCwgZWFjaCBlbnRyeSB7IGl0ZW0sIGNvbnQgfTogY29udCB3aGVuIGEKICAvLyB0aW1lZCBldmVudCBzdGFydGVkIG9uIGFuIGVhcmxpZXIgZGF5LgogIGZ1bmN0aW9uIGJ5RGF5KGl0ZW1zLCBkYXlLZXlzKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgTWFwKGRheUtleXMubWFwKGsgPT4gW2ssIFtdXSkpOwogICAgaWYgKCFkYXlLZXlzLmxlbmd0aCkgcmV0dXJuIG91dDsKICAgIGNvbnN0IGZpcnN0ID0gZGF5S2V5c1swXTsKICAgIGNvbnN0IGxhc3QgPSBkYXlLZXlzW2RheUtleXMubGVuZ3RoIC0gMV07CiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHsKICAgICAgaWYgKGl0ZW0ua2luZCA9PT0gJ3Rhc2snKSB7CiAgICAgICAgaWYgKGl0ZW0uZHVlICYmIG91dC5oYXMoaXRlbS5kdWUpKSBvdXQuZ2V0KGl0ZW0uZHVlKS5wdXNoKHsgaXRlbSwgY29udDogZmFsc2UgfSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKGl0ZW0ubGFzdCA8IGZpcnN0IHx8IGl0ZW0uZmlyc3QgPiBsYXN0KSBjb250aW51ZTsKICAgICAgY29uc3QgZnJvbSA9IGl0ZW0uZmlyc3QgPCBmaXJzdCA_IGZpcnN0IDogaXRlbS5maXJzdDsKICAgICAgY29uc3QgdG8gPSBpdGVtLmxhc3QgPiBsYXN0ID8gbGFzdCA6IGl0ZW0ubGFzdDsKICAgICAgZm9yIChsZXQgayA9IGZyb207IGsgPD0gdG8",
"7IGsgPSBhZGREYXlzKGssIDEpKSB7CiAgICAgICAgaWYgKG91dC5oYXMoaykpIG91dC5nZXQoaykucHVzaCh7IGl0ZW0sIGNvbnQ6IGsgIT09IGl0ZW0uZmlyc3QgfSk7CiAgICAgIH0KICAgIH0KICAgIGZvciAoY29uc3QgbGlzdCBvZiBvdXQudmFsdWVzKCkpIGxpc3Quc29ydCgoYSwgYikgPT4gY29tcGFyZUl0ZW1zKGEuaXRlbSwgYi5pdGVtKSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gV2hhdCB3YWl0cyB1bmRlciB0aGUgd2Vlazogb3BlbiB0YXNrcyB3aXRoIG5vIGRhdGUsIGFuZCBvcGVuIHRhc2tzCiAgLy8gd2hvc2UgZGF5IGhhcyBnb25lIGJ5LgogIGZ1bmN0aW9uIHRyYXkoaXRlbXMsIHRvZGF5KSB7CiAgICBjb25zdCBvcGVuID0gaXRlbXMuZmlsdGVyKHggPT4geC5raW5kID09PSAndGFzaycgJiYgIXguZG9uZSk7CiAgICByZXR1cm4gewogICAgICBvdmVyZHVlOiBvcGVuLmZpbHRlcih4ID0-IHguZHVlICYmIHguZHVlIDwgdG9kYXkpLnNvcnQoKGEsIGIpID0-IGEuZHVlLmxvY2FsZUNvbXBhcmUoYi5kdWUpIHx8IGEudGl0bGUubG9jYWxlQ29tcGFyZShiLnRpdGxlKSksCiAgICAgIHVuZGF0ZWQ6IG9wZW4uZmlsdGVyKHggPT4gIXguZHVlKSwKICAgIH07CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBTQ09QRVMsIEJBU0VTLCBVU0VSSU5GT19VUkwsIFZJRVdTLCBBR0VOREFfREFZUywgREFZX05BTUVTLCBNT05USFMsIE1PTlRIU19MT05HLCBFVkVOVF9DT0xPVVJTLAogICAgaXNBbGxvd2VkUmV",
"xdWVzdCwgYnVpbGRVcmwsCiAgICBkYXRlS2V5LCBpc0tleSwgZnJvbUtleSwgYWRkRGF5cywgZGF5c0JldHdlZW4sIHdlZWtkYXksIHdlZWtTdGFydCwgaXNvV2VlaywgbW9udGhTdGFydCwgYWRkTW9udGhzLCBkYXlzLAogICAgdmlld1JhbmdlLCBzdGVwLCBtb250aFdlZWtzLCBzcGFuVGV4dCwgdGl0bGUsIG1vbnRoTmFtZSwgZGF5TmFtZSwKICAgIHNhZmVDb2xvdXIsIHNhZmVMaW5rLCBjYWxlbmRhclNvdXJjZSwgbGlzdFNvdXJjZSwgc291cmNlcywgaXNPbiwKICAgIHNvdXJjZVJlcXVlc3RzLCByYW5nZVJlcXVlc3RzLCBldmVudEl0ZW0sIHRhc2tJdGVtLCB1bmlxdWVCeUlkLCBjb21wYXJlSXRlbXMsIGJ5RGF5LCB0cmF5LAogIH07CgogIG5zLmNhbGVuZGFyTG9naWMgPSBhcGk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKfSkoKTsK\"],[\"src/content/ui.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIERPTSB0b29sa2l0IGZvciB0aGUgaW5qZWN0ZWQgVUkKLy8KLy8gR21haWwgZW",
"5mb3JjZXMgVHJ1c3RlZCBUeXBlcyBvbiBpdHMgcGFnZSwgdW5kZXIgd2hpY2ggaW5uZXJIVE1MIGFuZAovLyBmcmllbmRzIHRocm93LiBDaHJvbWl1bSBjdXJyZW50bHkgZXhlbXB0cyBhIGNvbnRlbnQgc2NyaXB0J3MgaXNvbGF0ZWQKLy8gd29ybGQgZnJvbSB0aGF0IHBvbGljeSwgYnV0IG5vdGhpbmcgcHJvbWlzZXMgaXQgYWx3YXlzIHdpbGwgLSBhbmQgbWFpbAovLyBzdWJqZWN0cyBhcmUgdW50cnVzdGVkIHRleHQgcmVnYXJkbGVzcy4gU28gZXZlcnkgbm9kZSBoZXJlIGlzIGJ1aWx0Ci8vIHdpdGggY3JlYXRlRWxlbWVudCAvIGNyZWF0ZUVsZW1lbnROUyBhbmQgZmlsbGVkIHdpdGggdGV4dENvbnRlbnQuIEFsbAovLyBvZiBpdCBsaXZlcyBpbiBzaGFkb3cgcm9vdHMgc28gR21haWwncyBzdHlsZXNoZWV0IGFuZCBvdXJzIG5ldmVyIG1lZXQuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgRWxlbWVudHMg4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFByb3BlcnRpZXMgdGhhdCBtdXN0IGJlIHNldCBhcyBwcm9wZXJ0aWVzLCBub3QgYXR0cmlidXRlcywgdG8gdGFrZQogIC8vIGVmZmVjdCBhZnRlciBmaXJzdCByZW5kZXIgKGFuIGlucHV0J3MgdmFsdWUsIGEgY2hlY2tib3gncyBzdGF0ZSkuCiAgY29uc3QgUFJPUFMgPSBuZXcgU2V0KFsndmFsdWUnLCAnY2hlY2tlZCcsICdkaXNhYmxlZCcsICdoaWRkZW4nXSk7CgogIGZ1bmN0aW9uIGgodGFnLCBwcm9wcywgLi4ua2lkcykgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7CiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhwcm9wcyB8fCB7fSkpIHsKICAgICAgaWYgKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsIHx8IHYgPT09IGZhbHNlKSBjb250aW51ZTsKICAgICAgaWYgKGsgPT09ICdjbGFzcycpIGVsLmNsYXNzTmFtZSA9IEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcihCb29sZWFuKS5qb2luKCcgJykgOiB2OwogICAgICBlbHNlIGlmIChrID09PSAndGV4dCcpIGVsLnRleHRDb250ZW50ID0gU3RyaW5nKHYpOwogICAgICBlbHNlIGlmIChrID",
"09PSAnZGF0YXNldCcpIE9iamVjdC5hc3NpZ24oZWwuZGF0YXNldCwgdik7CiAgICAgIGVsc2UgaWYgKGsuc3RhcnRzV2l0aCgnb24nKSAmJiB0eXBlb2YgdiA9PT0gJ2Z1bmN0aW9uJykgZWwuYWRkRXZlbnRMaXN0ZW5lcihrLnNsaWNlKDIpLCB2KTsKICAgICAgZWxzZSBpZiAoUFJPUFMuaGFzKGspKSBlbFtrXSA9IHY7CiAgICAgIGVsc2UgZWwuc2V0QXR0cmlidXRlKGssIHYgPT09IHRydWUgPyAnJyA6IFN0cmluZyh2KSk7CiAgICB9CiAgICBhcHBlbmQoZWwsIGtpZHMpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgZnVuY3Rpb24gYXBwZW5kKGVsLCBraWRzKSB7CiAgICBmb3IgKGNvbnN0IGtpZCBvZiBraWRzLmZsYXQoSW5maW5pdHkpKSB7CiAgICAgIGlmIChraWQgPT09IG51bGwgfHwga2lkID09PSB1bmRlZmluZWQgfHwga2lkID09PSBmYWxzZSkgY29udGludWU7CiAgICAgIGVsLmFwcGVuZENoaWxkKHR5cGVvZiBraWQgPT09ICdzdHJpbmcnIHx8IHR5cGVvZiBraWQgPT09ICdudW1iZXInCiAgICAgICAgPyBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShTdHJpbmcoa2lkKSkgOiBraWQpOwogICAgfQogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIEljb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgO",
"KUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTWF0ZXJpYWwgU3ltYm9scyBwYXRocyAoQXBhY2hlIDIuMCksIHBsdXMgdGhlIGJvYXJkIGdseXBoIGRyYXduIHRvCiAgLy8gbWF0Y2ggdGhlIHRvb2xiYXIgaWNvbi4KCiAgY29uc3QgYmFyID0gKHgsIHksIHcsIGh0KSA9PgogICAgYE0ke3ggKyAxfSAke3l9aCR7dyAtIDJ9YTEgMSAwIDAgMSAxIDF2JHtodCAtIDJ9YTEgMSAwIDAgMS0xIDFoLSR7dyAtIDJ9YTEgMSAwIDAgMS0xLTF2LSR7aHQgLSAyfWExIDEgMCAwIDEgMS0xemA7CgogIGNvbnN0IElDT05TID0gewogICAgYm9hcmQ6IGJhcigzLCA0LCA1LCAxNikgKyBiYXIoOS41LCA0LCA1LCAxMCkgKyBiYXIoMTYsIDQsIDUsIDEzKSwKICAgIGNsb3NlOiAnTTE5IDYuNDEgMTcuNTkgNSAxMiAxMC41OSA2LjQxIDUgNSA2LjQxIDEwLjU5IDEyIDUgMTcuNTkgNi40MSAxOSAxMiAxMy40MSAxNy41OSAxOSAxOSAxNy41OSAxMy40MSAxMnonLAogICAgcmVmcmVzaDogJ00xNy42NSA2LjM1QTcuOTYgNy45NiAwIDAgMCAxMiA0YTggOCAwIDEgMCA3LjczIDEwaC0yLjA4QTYgNiAwIDEgMSAxMiA2YzEuNjYgMCAzLjE0LjY5IDQuMjIgMS43OEwxMyAxMWg3VjRsLTIuMzUgMi4zNXonLAogICAgYWRkOiAnTTE5IDEzaC02djZoLTJ2LTZINXYtMmg2VjVoMnY2aDZ2MnonLAogICAgbW9yZTogJ002IDEwYTIgMiAwIDEgMCAwIDQgMiAyIDAgMCAwIDAtNHptMTIgMGEyIDIgMCAxIDAgMCA0ID",
"IgMiAwIDAgMCAwLTR6bS02IDBhMiAyIDAgMSAwIDAgNCAyIDIgMCAwIDAgMC00eicsCiAgICBzdGFyOiAnTTEyIDE3LjI3IDE4LjE4IDIxbC0xLjY0LTcuMDNMMjIgOS4yNGwtNy4xOS0uNjFMMTIgMiA5LjE5IDguNjMgMiA5LjI0bDUuNDYgNC43M0w1LjgyIDIxeicsCiAgICB0dW5lOiAnTTMgMTd2Mmg2di0ySDN6TTMgNXYyaDEwVjVIM3ptMTAgMTZ2LTJoOHYtMmgtOHYtMmgtMnY2aDJ6TTcgOXYySDN2Mmg0djJoMlY5SDd6bTE0IDR2LTJIMTF2MmgxMHptLTYtNGgyVjdoNFY1aC00VjNoLTJ2NnonLAogICAgdXA6ICdNNCAxMmwxLjQxIDEuNDFMMTEgNy44M1YyMGgyVjcuODNsNS41OCA1LjU5TDIwIDEybC04LTgtOCA4eicsCiAgICBkb3duOiAnTTIwIDEybC0xLjQxLTEuNDFMMTMgMTYuMTdWNGgtMnYxMi4xN2wtNS41OC01LjU5TDQgMTJsOCA4IDgtOHonLAogICAgc2VhcmNoOiAnTTE1LjUgMTRoLS43OWwtLjI4LS4yN0E2LjQ3IDYuNDcgMCAwIDAgMTYgOS41IDYuNSA2LjUgMCAxIDAgOS41IDE2YzEuNjEgMCAzLjA5LS41OSA0LjIzLTEuNTdsLjI3LjI4di43OWw1IDQuOTlMMjAuNDkgMTlsLTQuOTktNXptLTYgMEM3LjAxIDE0IDUgMTEuOTkgNSA5LjVTNy4wMSA1IDkuNSA1IDE0IDcuMDEgMTQgOS41IDExLjk5IDE0IDkuNSAxNHonLAogICAgY2hlY2s6ICdNOSAxNi4xNyA0LjgzIDEybC0xLjQyIDEuNDFMOSAxOSAyMSA3bC0xLjQxLTEuNDF6JywKICAgIGNhcmV0OiAnTTcgMTBsNSA1IDUtNXonLAogICAgb3Blbj",
"ogJ00xOSAxOUg1VjVoN1YzSDVhMiAyIDAgMCAwLTIgMnYxNGEyIDIgMCAwIDAgMiAyaDE0YzEuMSAwIDItLjkgMi0ydi03aC0ydjd6TTE0IDN2MmgzLjU5bC05LjgzIDkuODMgMS40MSAxLjQxTDE5IDYuNDFWMTBoMlYzaC03eicsCiAgICBjYWxlbmRhcjogJ00yMCAzaC0xVjFoLTJ2Mkg3VjFINXYySDRjLTEuMSAwLTIgLjktMiAydjE2YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNWMwLTEuMS0uOS0yLTItMnptMCAxOEg0VjEwaDE2djExem0wLTEzSDRWNWgxNnYzeicsCiAgICBwcmV2OiAnTTE1LjQxIDcuNDEgMTQgNmwtNiA2IDYgNiAxLjQxLTEuNDFMMTAuODMgMTJ6JywKICAgIGNvbHVtbnM6ICdNMTAgMThoNVY1aC01djEzem0tNiAwaDVWNUg0djEzek0xNiA1djEzaDVWNWgtNXonLAogICAgcm93czogJ00yMSA4SDNWNGgxOHY0em0wIDJIM3Y0aDE4di00em0wIDZIM3Y0aDE4di00eicsCiAgICBuZXh0OiAnTTEwIDYgOC41OSA3LjQxIDEzLjE3IDEybC00LjU4IDQuNTlMMTAgMThsNi02eicsCiAgICBtYWlsOiAnTTIwIDRINGMtMS4xIDAtMS45OS45LTEuOTkgMkwyIDE4YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNmMwLTEuMS0uOS0yLTItMnptMCA0LTggNS04LTVWNmw4IDUgOC01djJ6JywKICAgIGJhY2s6ICdNMjAgMTFINy44M2w1LjU5LTUuNTlMMTIgNGwtOCA4IDggOCAxLjQxLTEuNDFMNy44MyAxM0gyMHYtMnonLAogICAgYXJyb3c6ICdNMTIgNGwtMS40MSAxLjQxTDE2LjE3ID",
"ExSDR2MmgxMi4xN2wtNS41OCA1LjU5TDEyIDIwbDgtOHonLAogICAgcmVtb3ZlOiAnTTE5IDEzSDV2LTJoMTR2MnonLAogICAgbm90ZTogJ00xNCAySDZjLTEuMSAwLTEuOTkuOS0xLjk5IDJMNCAyMGMwIDEuMS44OSAyIDEuOTkgMkgxOGMxLjEgMCAyLS45IDItMlY4bC02LTZ6bTIgMTZIOHYtMmg4djJ6bTAtNEg4di0yaDh2MnptLTMtNVYzLjVMMTguNSA5SDEzeicsCiAgICBkZWxldGU6ICdNNiAxOWMwIDEuMS45IDIgMiAyaDhjMS4xIDAgMi0uOSAyLTJWN0g2djEyek0xOSA0aC0zLjVsLTEtMWgtNWwtMSAxSDV2MmgxNFY0eicsCiAgICBlZGl0OiAnTTMgMTcuMjVWMjFoMy43NUwxNy44MSA5Ljk0bC0zLjc1LTMuNzVMMyAxNy4yNXpNMjAuNzEgNy4wNGExIDEgMCAwIDAgMC0xLjQxbC0yLjM0LTIuMzRhMSAxIDAgMCAwLTEuNDEgMGwtMS44MyAxLjgzIDMuNzUgMy43NSAxLjgzLTEuODN6JywKICAgIGZvbGRlcjogJ00xMCA0SDRjLTEuMSAwLTEuOTkuOS0xLjk5IDJMMiAxOGMwIDEuMS45IDIgMiAyaDE2YzEuMSAwIDItLjkgMi0yVjhjMC0xLjEtLjktMi0yLTJoLThsLTItMnonLAogICAgbm90ZXM6ICdNMyAxOGgxMnYtMkgzdjJ6TTMgNnYyaDE4VjZIM3ptMCA3aDE4di0ySDN2MnonLAogICAgLy8gRm9ybWF0dGluZyB0b29sYmFyLgogICAgYm9sZDogJ00xNS42IDEwLjc5Yy45Ny0uNjcgMS42NS0xLjc3IDEuNjUtMi43OSAwLTIuMjYtMS43NS00LTQtNEg3djE0aDcuMDRjMi4wOSAwIDMuNzEtMS43IDMuNzEtMy43OS",
"AwLTEuNTItLjg2LTIuODItMi4xNS0zLjQyek0xMCA2LjVoM2MuODMgMCAxLjUuNjcgMS41IDEuNXMtLjY3IDEuNS0xLjUgMS41aC0zdi0zem0zLjUgOUgxMHYtM2gzLjVjLjgzIDAgMS41LjY3IDEuNSAxLjVzLS42NyAxLjUtMS41IDEuNXonLAogICAgaXRhbGljOiAnTTEwIDR2M2gyLjIxbC0zLjQyIDhINnYzaDh2LTNoLTIuMjFsMy40Mi04SDE4VjR6JywKICAgIHN0cmlrZTogJ00xMCAxOWg0di0zaC00djN6TTUgNHYzaDV2M2g0VjdoNVY0SDV6TTMgMTRoMTh2LTJIM3YyeicsCiAgICBidWxsZXRzOiAnTTQgMTAuNWMtLjgzIDAtMS41LjY3LTEuNSAxLjVzLjY3IDEuNSAxLjUgMS41IDEuNS0uNjcgMS41LTEuNS0uNjctMS41LTEuNS0xLjV6bTAtNmMtLjgzIDAtMS41LjY3LTEuNSAxLjVTMy4xNyA3LjUgNCA3LjUgNS41IDYuODMgNS41IDYgNC44MyA0LjUgNCA0LjV6bTAgMTJjLS44MyAwLTEuNS42OC0xLjUgMS41cy42OCAxLjUgMS41IDEuNSAxLjUtLjY4IDEuNS0xLjUtLjY3LTEuNS0xLjUtMS41ek03IDE5aDE0di0ySDd2MnptMC02aDE0di0ySDd2MnptMC04djJoMTRWNUg3eicsCiAgICBudW1iZXJzOiAnTTIgMTdoMnYuNUgzdjFoMXYuNUgydjFoM3YtNEgydjF6bTEtOWgxVjRIMnYxaDF2M3ptLTEgM2gxLjhMMiAxMy4xdi45aDN2LTFIMy4yTDUgMTAuOVYxMEgydjF6bTUtNnYyaDE0VjVIN3ptMCAxNGgxNHYtMkg3djJ6bTAtNmgxNHYtMkg3djJ6JywKICAgIGNoZWNrbGlzdDogJ00yMiA3aC05djJoOVY3em0wID",
"hoLTl2Mmg5di0yek01LjU0IDExIDIgNy40NmwxLjQxLTEuNDEgMi4xMiAyLjEyIDQuMjQtNC4yNCAxLjQxIDEuNDFMNS41NCAxMXptMCA4TDIgMTUuNDZsMS40MS0xLjQxIDIuMTIgMi4xMiA0LjI0LTQuMjQgMS40MSAxLjQxTDUuNTQgMTl6JywKICAgIGluZGVudDogJ00zIDIxaDE4di0ySDN2MnpNMyA4djhsNC00LTQtNHptOCA5aDEwdi0ySDExdjJ6TTMgM3YyaDE4VjNIM3ptOCA2aDEwVjdIMTF2MnptMCA0aDEwdi0ySDExdjJ6JywKICAgIG91dGRlbnQ6ICdNMTEgMTdoMTB2LTJIMTF2MnptLTgtNSA0IDRWOGwtNCA0em0wIDloMTh2LTJIM3Yyek0zIDN2MmgxOFYzSDN6bTggNmgxMFY3SDExdjJ6bTAgNGgxMHYtMkgxMXYyeicsCiAgICBsaW5rOiAnTTMuOSAxMmMwLTEuNzEgMS4zOS0zLjEgMy4xLTMuMWg0VjdIN2MtMi43NiAwLTUgMi4yNC01IDVzMi4yNCA1IDUgNWg0di0xLjlIN2MtMS43MSAwLTMuMS0xLjM5LTMuMS0zLjF6TTggMTNoOHYtMkg4djJ6bTktNmgtNHYxLjloNGMxLjcxIDAgMy4xIDEuMzkgMy4xIDMuMXMtMS4zOSAzLjEtMy4xIDMuMWgtNFYxN2g0YzIuNzYgMCA1LTIuMjQgNS01cy0yLjI0LTUtNS01eicsCiAgICBjbGVhcjogJ00zLjI3IDUgMiA2LjI3bDYuOTcgNi45N0w2LjUgMTloM2wxLjU3LTMuNjZMMTYuNzMgMjEgMTggMTkuNzMgMy41NSA1LjI3IDMuMjcgNXpNNiA1di4xOEw4LjgyIDhoMi40bC0uNzIgMS42OCAyLjEgMi4xTDE0LjIxIDhIMjBWNUg2eicsCiAgICB0YWJsZTogJ00yMCAzSD",
"RjLTEuMSAwLTIgLjktMiAydjE0YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNWMwLTEuMS0uOS0yLTItMnptMCAydjNINFY1aDE2em0tMTAgMTRINHYtNGg2djR6bTAtNkg0di0zaDZ2M3ptMTAgNmgtOHYtNGg4djR6bTAtNmgtOHYtM2g4djN6JywKICAgIGFsaWduTGVmdDogJ00xNSAxNUgzdjJoMTJ2LTJ6bTAtOEgzdjJoMTJWN3pNMyAxM2gxOHYtMkgzdjJ6bTAgOGgxOHYtMkgzdjJ6TTMgM3YyaDE4VjNIM3onLAogICAgYWxpZ25DZW50ZXI6ICdNNyAxNXYyaDEwdi0ySDd6bS00IDZoMTh2LTJIM3Yyem0wLThoMTh2LTJIM3Yyem00LTZ2MmgxMFY3SDd6TTMgM3YyaDE4VjNIM3onLAogICAgYWxpZ25SaWdodDogJ00zIDIxaDE4di0ySDN2MnptNi00aDEydi0ySDl2MnptLTYtNGgxOHYtMkgzdjJ6bTYtNGgxMlY3SDl2MnpNMyAzdjJoMThWM0gzeicsCiAgfTsKCiAgY29uc3QgU1ZHX05TID0gJ2h0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnJzsKCiAgZnVuY3Rpb24gaWNvbihuYW1lLCBzaXplID0gMjApIHsKICAgIGNvbnN0IHN2ZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhTVkdfTlMsICdzdmcnKTsKICAgIHN2Zy5zZXRBdHRyaWJ1dGUoJ3ZpZXdCb3gnLCAnMCAwIDI0IDI0Jyk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCd3aWR0aCcsIFN0cmluZyhzaXplKSk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCdoZWlnaHQnLCBTdHJpbmcoc2l6ZSkpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnYXJpYS1oaWRkZW",
"4nLCAndHJ1ZScpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnZm9jdXNhYmxlJywgJ2ZhbHNlJyk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCdjbGFzcycsICdpY29uJyk7CiAgICBjb25zdCBwYXRoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudE5TKFNWR19OUywgJ3BhdGgnKTsKICAgIHBhdGguc2V0QXR0cmlidXRlKCdkJywgSUNPTlNbbmFtZV0gfHwgJycpOwogICAgcGF0aC5zZXRBdHRyaWJ1dGUoJ2ZpbGwnLCAnY3VycmVudENvbG9yJyk7CiAgICBzdmcuYXBwZW5kQ2hpbGQocGF0aCk7CiAgICByZXR1cm4gc3ZnOwogIH0KCiAgLy8gVGhlIGFwcCdzIG1hcms6ICJNZCIgb24gYSB2aW9sZXQgY2lyY2xlLCBhcyBpY29ucy9pY29uLnN2ZyBkcmF3cwogIC8vIGl0IChhIHRlc3Qga2VlcHMgdGhlIHR3byB0aGUgc2FtZSkuCiAgY29uc3QgTE9HTyA9IHsKICAgIGNvbG91cnM6IFsnIzZEMjhEOScsICcjOUY2N0ZBJ10sCiAgICBsZXR0ZXJzOiAnTTYxLjQ1IDg5VjYwLjkzUTYxLjQ1IDU5Ljk4IDYxLjQ3IDU5LjAyUTYxLjQ5IDU4LjA3IDYxLjc4IDUwLjg0UTU5LjQ1IDU5LjY4IDU4LjMzIDYzLjE3TDQ5Ljk4IDg5SDQzLjA4TDM0LjczIDYzLjE3TDMxLjIyIDUwLjg0UTMxLjYxIDU4LjQ3IDMxLjYxIDYwLjkzVjg5SDIzVjQyLjY5SDM1Ljk4TDQ0LjI3IDY4LjU5TDQ0Ljk5IDcxLjA5TDQ2LjU3IDc3LjNMNDguNjQgNjkuODdMNTcuMTUgNDIuNjlINzAuMDdWODlaIE05Ny41OCA5MFE5Ny40NyA4OS41OSA5Ny4zMiA4Ny45NFE5Ny",
"4xNyA4Ni4yOSA5Ny4xNyA4NS4ySDk3LjA3UTk0LjU4IDkwLjU0IDg3LjYzIDkwLjU0UTgyLjQ4IDkwLjU0IDc5LjY3IDg2LjUyUTc2Ljg2IDgyLjUgNzYuODYgNzUuMjdRNzYuODYgNjcuOTQgNzkuODIgNjMuOTRRODIuNzggNTkuOTUgODguMiA1OS45NVE5MS4zNCA1OS45NSA5My42MiA2MS4yNlE5NS44OSA2Mi41NyA5Ny4xMiA2NS4xNkg5Ny4xN0w5Ny4xMiA2MC4zVjQ5LjUzSDEwNC43OFY4My41NlExMDQuNzggODYuMjkgMTA1IDkwWk05Ny4yMyA3NS4wOFE5Ny4yMyA3MC4zMSA5NS42MyA2Ny43M1E5NC4wNCA2NS4xNiA5MC45MyA2NS4xNlE4Ny44NSA2NS4xNiA4Ni4zNSA2Ny42NVE4NC44NSA3MC4xNSA4NC44NSA3NS4yN1E4NC44NSA4NS4zMSA5MC44OCA4NS4zMVE5My45IDg1LjMxIDk1LjU3IDgyLjY1UTk3LjIzIDc5Ljk5IDk3LjIzIDc1LjA4WicsCiAgfTsKICBsZXQgbG9nb0NvdW50ID0gMDsKCiAgZnVuY3Rpb24gbG9nbyhzaXplID0gMjgpIHsKICAgIGNvbnN0IGVsID0gKHRhZywgYXR0cnMpID0-IHsKICAgICAgY29uc3QgbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhTVkdfTlMsIHRhZyk7CiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGF0dHJzKSkgbi5zZXRBdHRyaWJ1dGUoaywgdik7CiAgICAgIHJldHVybiBuOwogICAgfTsKICAgIC8vIEVhY2ggY29weSBpdHMgb3duIGdyYWRpZW50IGlkOiB0d28gbWFya3MgaW4gb25lIHBhZ2UgbXVzdCBub3Qgc2hhcmUuCiAgIC",
"Bjb25zdCBpZCA9IGBna2ItbG9nby0keysrbG9nb0NvdW50fWA7CiAgICBjb25zdCBncmFkID0gZWwoJ2xpbmVhckdyYWRpZW50JywgeyBpZCwgeDE6ICcwJywgeTE6ICcwJywgeDI6ICcxJywgeTI6ICcxJyB9KTsKICAgIGdyYWQuYXBwZW5kKGVsKCdzdG9wJywgeyBvZmZzZXQ6ICcwJywgJ3N0b3AtY29sb3InOiBMT0dPLmNvbG91cnNbMF0gfSksIGVsKCdzdG9wJywgeyBvZmZzZXQ6ICcxJywgJ3N0b3AtY29sb3InOiBMT0dPLmNvbG91cnNbMV0gfSkpOwogICAgY29uc3QgZGVmcyA9IGVsKCdkZWZzJywge30pOwogICAgZGVmcy5hcHBlbmQoZ3JhZCk7CiAgICBjb25zdCBzdmcgPSBlbCgnc3ZnJywgeyB2aWV3Qm94OiAnOCA4IDExMiAxMTInLCB3aWR0aDogU3RyaW5nKHNpemUpLCBoZWlnaHQ6IFN0cmluZyhzaXplKSwgJ2FyaWEtaGlkZGVuJzogJ3RydWUnLCBmb2N1c2FibGU6ICdmYWxzZScsIGNsYXNzOiAnbG9nby1tYXJrJyB9KTsKICAgIHN2Zy5hcHBlbmQoZGVmcywgZWwoJ2NpcmNsZScsIHsgY3g6ICc2NCcsIGN5OiAnNjQnLCByOiAnNTYnLCBmaWxsOiBgdXJsKCMke2lkfSlgIH0pLCBlbCgncGF0aCcsIHsgZDogTE9HTy5sZXR0ZXJzLCBmaWxsOiAnI2ZmZicgfSkpOwogICAgcmV0dXJuIHN2ZzsKICB9CgogIC8vIOKUgOKUgCBTaGFkb3cgaG9zdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGFkb3B0U3R5bGVzKHJvb3QsIGNzc1RleHQpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHNoZWV0ID0gbmV3IENTU1N0eWxlU2hlZXQoKTsKICAgICAgc2hlZXQucmVwbGFjZVN5bmMoY3NzVGV4dCk7CiAgICAgIHJvb3QuYWRvcHRlZFN0eWxlU2hlZXRzID0gW3NoZWV0XTsKICAgICAgcmV0dXJuOwogICAgfSBjYXRjaCB7IC8qIG9sZGVyIGVuZ2luZSBvciBhIGhvc3RpbGUgQ1NQOiBmYWxsIHRocm91Z2ggKi8gfQogICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpOwogICAgc3R5bGUudGV4dENvbnRlbnQgPSBjc3NUZXh0OwogICAgcm9vdC5hcHBlbmRDaGlsZChzdHlsZSk7CiAgfQoKICBmdW5jdGlvbiBtb3VudFNoYWRvdyhpZCwgY3NzVGV4dCkgewogICAgLy8gQSBwcmV2aW91cyBpbmplY3Rpb24gKGV4dGVuc2lvbiByZWxvYWRlZCB3aXRob3V0IHJlbG9hZGluZyBHbWFpbCkKICAgIC8vIGxlYXZlcyBhbiBvcnBoYW5lZCBob3N0IGJlaGluZDsgcmVwbGFjZSBpdCByYXRoZXIgdGhhbiBzdGFjayBhIHNlY29uZC4KICAgIGNvbnN0IHN0YWxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgaWYgKHN0YWxlKSBzdGFsZS5yZW1vdmUoKTsKCiAgICBjb25zdCBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7Ci",
"AgICBob3N0LmlkID0gaWQ7CiAgICBjb25zdCByb290ID0gaG9zdC5hdHRhY2hTaGFkb3coeyBtb2RlOiAnb3BlbicgfSk7CiAgICBhZG9wdFN0eWxlcyhyb290LCBjc3NUZXh0KTsKCiAgICAvLyBLZXkgZXZlbnRzIGZyb20gaW5zaWRlIGEgc2hhZG93IHJvb3QgcmVhY2ggR21haWwgcmV0YXJnZXRlZCB0byB0aGUKICAgIC8vIGhvc3QsIHdoaWNoIGlzIG5vdCBhbiBpbnB1dCAtIHNvIHR5cGluZyAiYyIgaW4gb3VyIHNlYXJjaCBib3ggd291bGQKICAgIC8vIG9wZW4gR21haWwncyBDb21wb3NlLiBPdXIgb3duIGhhbmRsZXJzIGluc2lkZSB0aGUgcm9vdCBydW4gZmlyc3Q7CiAgICAvLyBzdG9wcGluZyBwcm9wYWdhdGlvbiBoZXJlIGtlZXBzIEdtYWlsJ3Mgc2hvcnRjdXRzIG91dCBvZiBpdC4KICAgIGZvciAoY29uc3QgdHlwZSBvZiBbJ2tleWRvd24nLCAna2V5cHJlc3MnLCAna2V5dXAnXSkgewogICAgICBob3N0LmFkZEV2ZW50TGlzdGVuZXIodHlwZSwgZSA9PiBlLnN0b3BQcm9wYWdhdGlvbigpKTsKICAgIH0KCiAgICAoZG9jdW1lbnQuYm9keSB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQpLmFwcGVuZENoaWxkKGhvc3QpOwogICAgcmV0dXJuIHsgaG9zdCwgcm9vdCB9OwogIH0KCiAgLy8g4pSA4pSAIFRvYXN0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilI",
"DilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gdG9hc3RMYXllcihyb290KSB7CiAgICBsZXQgbGF5ZXIgPSByb290LnF1ZXJ5U2VsZWN0b3IoJy50b2FzdHMnKTsKICAgIGlmICghbGF5ZXIpIHsKICAgICAgbGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAndG9hc3RzJywgcm9sZTogJ3N0YXR1cycsICdhcmlhLWxpdmUnOiAncG9saXRlJyB9KTsKICAgICAgcm9vdC5hcHBlbmRDaGlsZChsYXllcik7CiAgICB9CiAgICByZXR1cm4gbGF5ZXI7CiAgfQoKICBmdW5jdGlvbiB0b2FzdChyb290LCBtZXNzYWdlLCB7IGtpbmQgPSAnaW5mbycsIGFjdGlvbiA9IG51bGwsIHRpbWVvdXQgfSA9IHt9KSB7CiAgICBjb25zdCBsYXllciA9IHRvYXN0TGF5ZXIocm9vdCk7CiAgICAvLyBBIG5ldyBjb25maXJtYXRpb24gcmVwbGFjZXMgdGhlIGxhc3Qgb25lIHJhdGhlciB0aGFuIHN0YWNraW5nIHVwOwogICAgLy8gZXJyb3JzIHN0YXkgdW50aWwgcmVhZCBvciB0aW1lZCBvdXQuIE9uZSBzdGlsbCBvZmZlcmluZyBhbiBhY3Rpb24KICAgIC8vIChVbmRvKSBpcyBrZXB0IHRvbywgc2luY2UgaXRzIGJ1dHRvbiBtYXkgYmUgYWJvdXQgdG8gYmUgY2xpY2tlZC4KICAgIGlmIChraW5kICE9PSAnZXJyb3InKSB7CiAgICAgIGZvciAoY29uc3Qgb2xkIG9mIGxheWVyLnF1ZXJ5U2VsZWN0b3JBbGwoJy50b2FzdDpub3QoLnRvYXN0LWVycm9yKScpKSB7Ci",
"AgICAgICAgaWYgKCFvbGQucXVlcnlTZWxlY3RvcignLnRvYXN0LWFjdGlvbicpKSBvbGQucmVtb3ZlKCk7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGNsb3NlID0gKCkgPT4gZWwucmVtb3ZlKCk7CiAgICBjb25zdCBlbCA9IGgoJ2RpdicsIHsgY2xhc3M6IFsndG9hc3QnLCBraW5kID09PSAnZXJyb3InICYmICd0b2FzdC1lcnJvciddIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndG9hc3QtdGV4dCcsIHRleHQ6IG1lc3NhZ2UgfSksCiAgICAgIGFjdGlvbiAmJiBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICd0b2FzdC1hY3Rpb24nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYWN0aW9uLmxhYmVsLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgYWN0aW9uLm9uQ2xpY2soKTsgfSwKICAgICAgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICd0b2FzdC1jbG9zZSBpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdEaXNtaXNzJywgb25jbGljazogY2xvc2UgfSwKICAgICAgICBpY29uKCdjbG9zZScsIDE4KSkKICAgICk7CiAgICBsYXllci5hcHBlbmRDaGlsZChlbCk7CiAgICAvLyBFcnJvcnMgc3RheSBhIGxpdHRsZSBsb25nZXI6IHRoZXkgdXN1YWxseSBuZWVkIHJlYWRpbmcsIG5vdCBnbGFuY2luZy4KICAgIHNldFRpbWVvdXQoY2xvc2UsIHRpbWVvdXQgfHwgKGtpbmQgPT09ICdlcnJvcicgPyA5MDAwIDogNTAwMCkpOwogICAgcmV0dXJuIGVsOwogIH0KCi",
"AgLy8g4pSA4pSAIE1lbnVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gaXRlbXM6IHsgbGFiZWwsIG9uU2VsZWN0LCBpY29uPywgY2hlY2tlZD8sIGRpc2FibGVkPywgZGFuZ2VyPyB9CiAgLy8gICAgICB8IHsgaGVhZGluZyB9IHwgeyBzZXBhcmF0b3I6IHRydWUgfQoKICBjb25zdCBvcGVuTWVudXMgPSBuZXcgV2Vha01hcCgpOyAvLyByb290IOKGkiBjbG9zZSBmdW5jdGlvbgoKICBmdW5jdGlvbiBjbG9zZU1lbnUocm9vdCkgewogICAgY29uc3QgY2xvc2UgPSBvcGVuTWVudXMuZ2V0KHJvb3QpOwogICAgaWYgKGNsb3NlKSBjbG9zZSgpOwogIH0KCiAgZnVuY3Rpb24gaXNNZW51T3Blbihyb290KSB7CiAgICByZXR1cm4gb3Blbk1lbnVzLmhhcyhyb290KTsKICB9CgogIGZ1bmN0aW9uIG9wZW5NZW51KHJvb3QsIGFuY2hvciwgaXRlbXMsIHsgbGFiZWwgPSAnQWN0aW9ucycsIHBsYWNlbWVudCA9ICdiZWxvdycgfSA9IHt9KSB7CiAgICBjbG9zZU1lbnUocm9vdCk7CgogICAgY29uc3QgbWVudSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51Jywgcm9sZTogJ21lbnUnLCAnYXJpYS1sYWJlbCc6IGxhYmVsIH0pOwogICAgZm9yIC",
"hjb25zdCBpdCBvZiBpdGVtcykgewogICAgICBpZiAoaXQuc2VwYXJhdG9yKSB7IG1lbnUuYXBwZW5kQ2hpbGQoaCgnZGl2JywgeyBjbGFzczogJ21lbnUtc2VwJywgcm9sZTogJ3NlcGFyYXRvcicgfSkpOyBjb250aW51ZTsgfQogICAgICBpZiAoaXQuaGVhZGluZykgeyBtZW51LmFwcGVuZENoaWxkKGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51LWhlYWRpbmcnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScsIHRleHQ6IGl0LmhlYWRpbmcgfSkpOyBjb250aW51ZTsgfQogICAgICBjb25zdCByb2xlID0gaXQuY2hlY2tlZCA9PT0gdW5kZWZpbmVkID8gJ21lbnVpdGVtJyA6ICdtZW51aXRlbXJhZGlvJzsKICAgICAgbWVudS5hcHBlbmRDaGlsZChoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6IFsnbWVudS1pdGVtJywgaXQuZGFuZ2VyICYmICdkYW5nZXInXSwKICAgICAgICB0eXBlOiAnYnV0dG9uJywKICAgICAgICByb2xlLAogICAgICAgICdhcmlhLWNoZWNrZWQnOiBpdC5jaGVja2VkID09PSB1bmRlZmluZWQgPyBudWxsIDogU3RyaW5nKCEhaXQuY2hlY2tlZCksCiAgICAgICAgZGlzYWJsZWQ6ICEhaXQuZGlzYWJsZWQsCiAgICAgICAgZGF0YXNldDogaXQua2V5ID8geyBrZXk6IGl0LmtleSB9IDogdW5kZWZpbmVkLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgaXQub25TZWxlY3QoKTsgfSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtaWNvbicgfSwgaXQuY2hlY2tlZCA_IG",
"ljb24oJ2NoZWNrJywgMTgpIDogKGl0Lmljb24gPyBpY29uKGl0Lmljb24sIDE4KSA6IG51bGwpKSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtbGFiZWwnLCB0ZXh0OiBpdC5sYWJlbCB9KQogICAgICApKTsKICAgIH0KCiAgICByb290LmFwcGVuZENoaWxkKG1lbnUpOwogICAgYW5jaG9yLnNldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsICd0cnVlJyk7CgogICAgLy8gRml4ZWQgcG9zaXRpb25pbmcgYWdhaW5zdCB0aGUgYW5jaG9yLCBmbGlwcGVkIG9yIG51ZGdlZCBzbyB0aGUgbWVudQogICAgLy8gbmV2ZXIgcnVucyBvZmYgdGhlIHZpZXdwb3J0IGVkZ2UuCiAgICBjb25zdCByID0gYW5jaG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgbXcgPSBtZW51Lm9mZnNldFdpZHRoOwogICAgY29uc3QgbWggPSBtZW51Lm9mZnNldEhlaWdodDsKICAgIGxldCBsZWZ0ID0gTWF0aC5taW4oci5sZWZ0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIG13IC0gOCk7CiAgICBpZiAoci5yaWdodCAtIG13ID4gOCAmJiBsZWZ0ICsgbXcgPiB3aW5kb3cuaW5uZXJXaWR0aCAtIDgpIGxlZnQgPSByLnJpZ2h0IC0gbXc7CiAgICBsZWZ0ID0gTWF0aC5tYXgoOCwgbGVmdCk7CiAgICBsZXQgdG9wID0gcGxhY2VtZW50ID09PSAnYWJvdmUnID8gci50b3AgLSBtaCAtIDYgOiByLmJvdHRvbSArIDY7CiAgICBpZiAodG9wICsgbWggPiB3aW5kb3cuaW5uZXJIZWlnaHQgLSA4KSB0b3AgPSByLnRvcCAtIG1oIC0gNj",
"sKICAgIGlmICh0b3AgPCA4KSB0b3AgPSA4OwogICAgbWVudS5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5yb3VuZChsZWZ0KX1weGA7CiAgICBtZW51LnN0eWxlLnRvcCA9IGAke01hdGgucm91bmQodG9wKX1weGA7CgogICAgY29uc3QgYnV0dG9ucyA9ICgpID0-IFsuLi5tZW51LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tZW51LWl0ZW06bm90KFtkaXNhYmxlZF0pJyldOwogICAgY29uc3Qgb25LZXkgPSBlID0-IHsKICAgICAgY29uc3QgbGlzdCA9IGJ1dHRvbnMoKTsKICAgICAgY29uc3QgaSA9IGxpc3QuaW5kZXhPZihyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgY2xvc2UoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93RG93bicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyAobGlzdFtpICsgMV0gfHwgbGlzdFswXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93VXAnKSB7IGUucHJldmVudERlZmF1bHQoKTsgKGxpc3RbaSAtIDFdIHx8IGxpc3RbbGlzdC5sZW5ndGggLSAxXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0hvbWUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFswXSAmJiBsaXN0WzBdLmZvY3VzKCk7IH0KICAgICAgZWxzZSBpZiAoZS5rZXkgPT09ICdFbmQnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFtsaXN0Lmxlbm",
"d0aCAtIDFdICYmIGxpc3RbbGlzdC5sZW5ndGggLSAxXS5mb2N1cygpOyB9CiAgICAgIGVsc2UgaWYgKGUua2V5ID09PSAnVGFiJykgeyBjbG9zZSgpOyB9CiAgICB9OwogICAgLy8gQ2xpY2tzIGFueXdoZXJlIGVsc2UgLSBpbiBvdXIgcm9vdCBvciBvbiBHbWFpbCBpdHNlbGYgLSBkaXNtaXNzIGl0LgogICAgY29uc3Qgb25Qb2ludGVyID0gZSA9PiB7CiAgICAgIGlmICghZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhtZW51KSAmJiAhZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhhbmNob3IpKSBjbG9zZSgpOwogICAgfTsKCiAgICAvLyBJZiB0aGUgbWVudSBoZWxkIGZvY3VzLCBpdCBnb2VzIGJhY2sgdG8gdGhlIGFuY2hvciAtIG9uIEVzYywgb24KICAgIC8vIGNob29zaW5nIGFuIGl0ZW0gKGJlZm9yZSB0aGUgYWN0aW9uIHJ1bnMsIHNvIGFuIGFjdGlvbiB0aGF0CiAgICAvLyByZS1yZW5kZXJzIGNhbiBmaW5kIHRoZSBhbmNob3IgYWdhaW4gYnkgaXRzIGRhdGEta2V5KSwgYW5kIHdoZW4gYQogICAgLy8gcmUtcmVuZGVyIGNsb3NlcyB0aGUgbWVudSBmcm9tIHVuZGVybmVhdGguCiAgICBmdW5jdGlvbiBjbG9zZSgpIHsKICAgICAgaWYgKG9wZW5NZW51cy5nZXQocm9vdCkgIT09IGNsb3NlKSByZXR1cm47CiAgICAgIGNvbnN0IGhhZEZvY3VzID0gbWVudS5jb250YWlucyhyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBvcGVuTWVudXMuZGVsZXRlKHJvb3QpOwogICAgICBtZW51LnJlbW92ZSgpOwogICAgICBpZi",
"AoaGFkRm9jdXMgJiYgYW5jaG9yLmlzQ29ubmVjdGVkKSBhbmNob3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBhbmNob3Iuc2V0QXR0cmlidXRlKCdhcmlhLWV4cGFuZGVkJywgJ2ZhbHNlJyk7CiAgICAgIG1lbnUucmVtb3ZlRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCBvblBvaW50ZXIsIHRydWUpOwogICAgfQoKICAgIG1lbnUuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgb25Qb2ludGVyLCB0cnVlKTsKICAgIG9wZW5NZW51cy5zZXQocm9vdCwgY2xvc2UpOwoKICAgIGNvbnN0IGZpcnN0ID0gYnV0dG9ucygpWzBdOwogICAgaWYgKGZpcnN0KSBmaXJzdC5mb2N1cygpOwogICAgcmV0dXJuIGNsb3NlOwogIH0KCiAgbnMudWkgPSB7IGgsIGFwcGVuZCwgaWNvbiwgbG9nbywgTE9HTywgbW91bnRTaGFkb3csIHRvYXN0LCBvcGVuTWVudSwgY2xvc2VNZW51LCBpc01lbnVPcGVuIH07Cn0pKCk7Cg\"],[\"src/content/styles.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFN0eWxlcyBmb3IgdGhlIGluamVjdGVkIFVJCi8vCi8vIFBsYWluIHN0cmluZ3MsIGFkb3B0ZWQgaW50byBlYWNoIHNoYWRvdyByb290LiBUaGUgbG9vayBib3Jyb3dzIEdtYWlsJ3MKLy8gb3duIHZvY2FidWxhcnkgLSBHb29nbGUgU2FucywgaXRzIGJsdWUsIGl0cyBlbGV2YXRpb24gc2hhZG93cywgcGlsbAovLyBidXR0b25zIC0gc28gdGhlIGJvYXJkIHJlYWRzIGFzIHBhcnQgb2YgR21haWwgcmF0aGVyIHRoYW4gc29tZXRoaW5nCi8vIGJvbHRlZCBvbi4gRGFyayBtb2RlIGZvbGxvd3MgdGhlIG9wZXJhdGluZyBzeXN0ZW0sIGFzIGFza2VkOyBHbWFpbCdzCi8vIG93biB0aGVtZSBzZXR0aW5nIGlzIG5vdCB2aXNpYmxlIHRvIGEgY29udGVudCBzY3JpcHQgd2l0aG91dCBzY3JhcGluZy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB",
"7fSk7CgogIC8vIOKUgOKUgCBTaGFyZWQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IEJBU0UgPSBgCjpob3N0IHsKICBhbGw6IGluaXRpYWwgIWltcG9ydGFudDsKICAvKiBBIHBvc2l0aW9uZWQgaG9zdCB3aXRoIGEgei1pbmRleCBpcyBpdHMgb3duIHN0YWNraW5nIGNvbnRleHQsIHNvCiAgICAgbWVudXMgYW5kIHRvYXN0cyBpbnNpZGUgaXQgY2FuIGxheWVyIG92ZXIgdGhlIGJvYXJkIHdpdGggc21hbGwKICAgICBudW1iZXJzIGluc3RlYWQgb2YgY29tcGV0aW5nIHdpdGggR21haWwncy4gKi8KICBwb3NpdGlvbjogcmVsYXRpdmUgIWltcG9ydGFudDsKICB6LWluZGV4OiAyMTQ3NDgzMDAwICFpbXBvcnRhbnQ7CgogIC0tYmc6ICNmNmY4ZmM7CiAgLS1iYXI6ICNmNmY4ZmM7CiAgLS1jb2w6ICNlOWVlZjY7CiAgLS1zdXJmYWNlOiAjZmZmZmZmOwogIC0tbWVudTogI2ZmZmZmZjsKICAtLWZnOiAjMWYxZjFmOwogIC0tZmctMjogIzQ0NDc0NjsKICAtLWZnLTM6ICM1ZTYwNjI7CiAgLS1hY2NlbnQ6ICMwYjU3ZDA7CiAgLS1vbi1hY2NlbnQ6ICNmZmZmZmY7CiAgLS1hY2NlbnQtc29mdDogI2QzZTNmZDsKICAtLW9uLWFjY2VudC1zb2Z",
"0OiAjMDQxZTQ5OwogIC0tYm9yZGVyOiAjZTFlM2UxOwogIC0tYm9yZGVyLXN0cm9uZzogI2M0YzdjNTsKICAtLWhvdmVyOiByZ2JhKDY4LCA3MSwgNzAsIC4wOCk7CiAgLS1wcmVzczogcmdiYSg2OCwgNzEsIDcwLCAuMTQpOwogIC0tZm9jdXM6ICMwYjU3ZDA7CiAgLS1kYW5nZXI6ICNiMzI2MWU7CiAgLS1zdGFyOiAjZThhNDAwOwogIC0taW52ZXJzZTogIzMwMzAzMDsKICAtLW9uLWludmVyc2U6ICNmMmYyZjI7CiAgLS1pbnZlcnNlLWFjY2VudDogI2E4YzdmYTsKICAtLXNjcmltOiByZ2JhKDMyLCAzMywgMzYsIC40KTsKICAtLXNoYWRvdy0xOiAwIDFweCAycHggcmdiYSg2MCwgNjQsIDY3LCAuMiksIDAgMXB4IDNweCAxcHggcmdiYSg2MCwgNjQsIDY3LCAuMSk7CiAgLS1zaGFkb3ctMjogMCAxcHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjMpLCAwIDJweCA2cHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjE1KTsKICAtLXNoYWRvdy0zOiAwIDRweCA4cHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjE1KSwgMCAxcHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjMpOwogIC0tZm9udDogIkdvb2dsZSBTYW5zIiwgUm9ib3RvLCBBcmlhbCwgc2Fucy1zZXJpZjsKICAvKiBDYXJkIGNvbG91cnM6IEdvb2dsZSdzIG93biBwYWxldHRlLCBhIHN0ZXAgbGlnaHRlciBpbiBkYXJrIG1vZGUgc28KICAgICB0aGUgc3RyaXBlIHN0aWxsIHJlYWRzIGFnYWluc3QgYSBkYXJrIGNhcmQuICovCiAgLS1jLXJlZDogI2Q5MzAyNTsKICAtLWMtb3J",
"hbmdlOiAjZTg3MTBhOwogIC0tYy15ZWxsb3c6ICNmOWFiMDA7CiAgLS1jLWdyZWVuOiAjMWU4ZTNlOwogIC0tYy1ibHVlOiAjMWE3M2U4OwogIC0tYy1wdXJwbGU6ICM5MzM0ZTY7CiAgLS1jLWdyZXk6ICM4MDg2OGI7CiAgLS1tYXJrOiAjZmRlMjkzOwogIC0tbWFyay1jdXJyZW50OiAjZjlhYjAwOwogIC0tb24tbWFyay1jdXJyZW50OiAjMWYxZjFmOwogIC8qIFRoZSBzY3JhdGNocGFkOiBwYXBlciBvZiBpdHMgb3duIGNvbG91ci4gKi8KICAtLXNjcmF0Y2g6ICNmZmY4ZGM7CiAgLS1zY3JhdGNoLWVkZ2U6ICNmMGUxYTA7CiAgLS1zY3JhdGNoLWluazogIzlhNmIwMDsKfQoKQG1lZGlhIChwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaykgewogIDpob3N0IHsKICAgIC0tYmc6ICMxMzEzMTQ7CiAgICAtLWJhcjogIzEzMTMxNDsKICAgIC0tY29sOiAjMWUxZjIwOwogICAgLS1zdXJmYWNlOiAjMmEyYjJkOwogICAgLS1tZW51OiAjMmQyZTMwOwogICAgLS1mZzogI2UzZTNlMzsKICAgIC0tZmctMjogI2M0YzdjNTsKICAgIC0tZmctMzogI2EyYTVhMzsKICAgIC0tYWNjZW50OiAjYThjN2ZhOwogICAgLS1vbi1hY2NlbnQ6ICMwNjJlNmY7CiAgICAtLWFjY2VudC1zb2Z0OiAjMDA0YTc3OwogICAgLS1vbi1hY2NlbnQtc29mdDogI2MyZTdmZjsKICAgIC0tYm9yZGVyOiAjM2EzYjNkOwogICAgLS1ib3JkZXItc3Ryb25nOiAjNWM1ZTYwOwogICAgLS1ob3ZlcjogcmdiYSgyMjcsIDIyNywgMjI3LCAuMDgpOwogICAgLS1wcmV",
"zczogcmdiYSgyMjcsIDIyNywgMjI3LCAuMTQpOwogICAgLS1mb2N1czogI2E4YzdmYTsKICAgIC0tZGFuZ2VyOiAjZjJiOGI1OwogICAgLS1zdGFyOiAjZmRkNjYzOwogICAgLS1pbnZlcnNlOiAjZTNlM2UzOwogICAgLS1vbi1pbnZlcnNlOiAjMWYxZjFmOwogICAgLS1pbnZlcnNlLWFjY2VudDogIzBiNTdkMDsKICAgIC0tc2NyaW06IHJnYmEoMCwgMCwgMCwgLjU1KTsKICAgIC0tc2hhZG93LTE6IDAgMXB4IDJweCByZ2JhKDAsIDAsIDAsIC41KSwgMCAxcHggM3B4IDFweCByZ2JhKDAsIDAsIDAsIC4yNSk7CiAgICAtLXNoYWRvdy0yOiAwIDFweCAzcHggcmdiYSgwLCAwLCAwLCAuNiksIDAgMnB4IDhweCAycHggcmdiYSgwLCAwLCAwLCAuMyk7CiAgICAtLXNoYWRvdy0zOiAwIDRweCAxMHB4IDNweCByZ2JhKDAsIDAsIDAsIC40NSksIDAgMXB4IDNweCByZ2JhKDAsIDAsIDAsIC42KTsKICAgIC0tYy1yZWQ6ICNmMjhiODI7CiAgICAtLWMtb3JhbmdlOiAjZmNhZDcwOwogICAgLS1jLXllbGxvdzogI2ZkZDY2MzsKICAgIC0tYy1ncmVlbjogIzgxYzk5NTsKICAgIC0tYy1ibHVlOiAjOGFiNGY4OwogICAgLS1jLXB1cnBsZTogI2M1OGFmOTsKICAgIC0tYy1ncmV5OiAjOWFhMGE2OwogICAgLS1tYXJrOiAjNmI1ODAwOwogICAgLS1tYXJrLWN1cnJlbnQ6ICNmZGQ2NjM7CiAgICAtLW9uLW1hcmstY3VycmVudDogIzFmMWYxZjsKICAgIC0tc2NyYXRjaDogIzJhMjYxNzsKICAgIC0tc2NyYXRjaC1lZGdlOiAjNGE0MTIyOwo",
"gICAgLS1zY3JhdGNoLWluazogI2ZkZDY2MzsKICB9Cn0KCiosICo6OmJlZm9yZSwgKjo6YWZ0ZXIgeyBib3gtc2l6aW5nOiBib3JkZXItYm94OyB9CgovKiBBdXRob3IgZGlzcGxheSBydWxlcyAoLnBpbGwsIC5vdmVybGF54oCmKSB3b3VsZCBvdGhlcndpc2UgYmVhdCB0aGUKICAgYnJvd3NlcidzIG93biBbaGlkZGVuXSB7IGRpc3BsYXk6IG5vbmUgfS4gKi8KW2hpZGRlbl0geyBkaXNwbGF5OiBub25lICFpbXBvcnRhbnQ7IH0KCmJ1dHRvbiB7CiAgZm9udDogaW5oZXJpdDsKICBjb2xvcjogaW5oZXJpdDsKICBiYWNrZ3JvdW5kOiBub25lOwogIGJvcmRlcjogMDsKICBtYXJnaW46IDA7CiAgcGFkZGluZzogMDsKICBjdXJzb3I6IHBvaW50ZXI7CiAgLXdlYmtpdC10YXAtaGlnaGxpZ2h0LWNvbG9yOiB0cmFuc3BhcmVudDsKfQpidXR0b246ZGlzYWJsZWQgeyBjdXJzb3I6IGRlZmF1bHQ7IH0KCjpmb2N1cyB7IG91dGxpbmU6IG5vbmU7IH0KOmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogMnB4OyB9CgouaWNvbiB7IGRpc3BsYXk6IGJsb2NrOyBmbGV4OiBub25lOyB9CgouaWNvbi1idG4gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDM2cHg7CiAgaGVpZ2h0OiAzNnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBjb2xvcjogdmFyKC0tZmctMik",
"7CiAgZmxleDogbm9uZTsKfQouaWNvbi1idG46aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLmljb24tYnRuOmFjdGl2ZSB7IGJhY2tncm91bmQ6IHZhcigtLXByZXNzKTsgfQouaWNvbi1idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNDsgYmFja2dyb3VuZDogbm9uZTsgfQoKLmJ0biB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDM2cHg7CiAgcGFkZGluZzogMCAxOHB4OwogIGJvcmRlci1yYWRpdXM6IDE4cHg7CiAgZm9udC1zaXplOiAxNHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wMWVtOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmJ0bi1wcmltYXJ5IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7IH0KLmJ0bi1wcmltYXJ5OmhvdmVyIHsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOyB9Ci5idG4tdG9uYWwgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLmJ0bi10ZXh0IHsgY29sb3I6IHZhcigtLWFjY2VudCk7IHBhZGRpbmc6IDAgMTJweDsgfQouYnRuLXRleHQ6aG92ZXIsIC5idG4tdG9uYWw6aG92ZXIgeyBiYWNrZ3JvdW5kLWltYWdlOiBsaW5lYXItZ3JhZGllbnQodmFyKC0",
"taG92ZXIpLCB2YXIoLS1ob3ZlcikpOyB9Ci5idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNTsgYm94LXNoYWRvdzogbm9uZTsgfQoKLyog4pSA4pSAIE1lbnVzIOKUgOKUgCAqLwoKLm1lbnUgewogIHBvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiAyMDsKICBtaW4td2lkdGg6IDIwOHB4OwogIG1heC13aWR0aDogMzIwcHg7CiAgbWF4LWhlaWdodDogNzB2aDsKICBvdmVyZmxvdy15OiBhdXRvOwogIHBhZGRpbmc6IDhweCAwOwogIGJhY2tncm91bmQ6IHZhcigtLW1lbnUpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGxpbmUtaGVpZ2h0OiAyMHB4Owp9Ci5tZW51LWl0ZW0gewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDEycHg7CiAgd2lkdGg6IDEwMCU7CiAgbWluLWhlaWdodDogMzZweDsKICBwYWRkaW5nOiA2cHggMjBweCA2cHggMTJweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5tZW51LWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLm1lbnUtaXRlbTpmb2N1cy12aXNpYmxlIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogLTJweDsgfQoubWVudS1pdGVtOmRpc2FibGVkIHsgb3BhY2l",
"0eTogLjQ1OyBiYWNrZ3JvdW5kOiBub25lOyB9Ci5tZW51LWl0ZW0uZGFuZ2VyIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KLm1lbnUtaWNvbiB7IHdpZHRoOiAxOHB4OyBoZWlnaHQ6IDE4cHg7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBjb2xvcjogdmFyKC0tZmctMik7IGZsZXg6IG5vbmU7IH0KLm1lbnUtaXRlbS5kYW5nZXIgLm1lbnUtaWNvbiB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci5tZW51LWl0ZW1bYXJpYS1jaGVja2VkPSJ0cnVlIl0gLm1lbnUtaWNvbiB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5tZW51LWxhYmVsIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQoubWVudS1oZWFkaW5nIHsKICBwYWRkaW5nOiA4cHggMjBweCA0cHggNDJweDsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmctMyk7Cn0KLm1lbnUtc2VwIHsgaGVpZ2h0OiAxcHg7IG1hcmdpbjogOHB4IDA7IGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7IH0KCi8qIOKUgOKUgCBUb2FzdHMg4pSA4pSAICovCgoudG9hc3RzIHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgei1pbmRleDogMzA7CiAgbGVmdDogNTAlOwogIGJvdHRvbTogMjRweDsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoLTUwJSk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwo",
"gIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwp9Ci50b2FzdCB7CiAgcG9pbnRlci1ldmVudHM6IGF1dG87CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNHB4OwogIG1pbi1oZWlnaHQ6IDQ4cHg7CiAgbWF4LXdpZHRoOiBtaW4oNjAwcHgsIGNhbGMoMTAwdncgLSAzMnB4KSk7CiAgcGFkZGluZzogNnB4IDZweCA2cHggMTZweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taW52ZXJzZSk7CiAgY29sb3I6IHZhcigtLW9uLWludmVyc2UpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LXNpemU6IDE0cHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7CiAgYW5pbWF0aW9uOiB0b2FzdC1pbiAuMThzIGVhc2Utb3V0Owp9Ci50b2FzdC1lcnJvciB7IGJvcmRlci1sZWZ0OiA0cHggc29saWQgI2YyOGI4MjsgcGFkZGluZy1sZWZ0OiAxMnB4OyB9Ci50b2FzdC10ZXh0IHsgZmxleDogMTsgcGFkZGluZy1yaWdodDogOHB4OyB9Ci50b2FzdC1hY3Rpb24gewogIGhlaWdodDogMzZweDsKICBwYWRkaW5nOiAwIDEycHg7CiAgYm9yZGVyLXJhZGl1czogMThweDsKICBjb2xvcjogdmFyKC0taW52ZXJzZS1hY2NlbnQpOwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQoudG9hc3QtYWN0aW9uOmhvdmVyIHsgYmFja2d",
"yb3VuZDogcmdiYSgxMjgsIDEyOCwgMTI4LCAuMTYpOyB9Ci50b2FzdC1jbG9zZSB7IGNvbG9yOiBpbmhlcml0OyBvcGFjaXR5OiAuODsgfQoudG9hc3QtY2xvc2U6aG92ZXIgeyBiYWNrZ3JvdW5kOiByZ2JhKDEyOCwgMTI4LCAxMjgsIC4xNik7IGNvbG9yOiBpbmhlcml0OyB9CkBrZXlmcmFtZXMgdG9hc3QtaW4geyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDhweCk7IH0gdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IG5vbmU7IH0gfQoKQG1lZGlhIChwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpIHsKICAqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYW5pbWF0aW9uOiBub25lICFpbXBvcnRhbnQ7IHRyYW5zaXRpb246IG5vbmUgIWltcG9ydGFudDsgfQp9CmA7CgogIC8vIOKUgOKUgCBCb2FyZCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgQk9BUkQgPSBgCi5vdmVybGF5IHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgaW5zZXQ6IDA7CiAgei1pbmRleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogIGNvbG9",
"yOiB2YXIoLS1mZyk7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwogIGZvbnQtc2l6ZTogMTRweDsKICBsaW5lLWhlaWdodDogMS40OwogIC13ZWJraXQtZm9udC1zbW9vdGhpbmc6IGFudGlhbGlhc2VkOwp9Ci5vdmVybGF5W2hpZGRlbl0geyBkaXNwbGF5OiBub25lOyB9CgouYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA0cHg7CiAgaGVpZ2h0OiA2NHB4OwogIHBhZGRpbmc6IDAgMTJweCAwIDIwcHg7CiAgZmxleDogbm9uZTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iYXIpOwp9Ci5icmFuZCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTBweDsKICBtYXJnaW46IDA7CiAgZm9udC1zaXplOiAyMnB4OwogIGZvbnQtd2VpZ2h0OiA0MDA7CiAgY29sb3I6IHZhcigtLWZnKTsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwp9Ci5icmFuZCAubG9nbyB7IGRpc3BsYXk6IGZsZXg7IH0KLmJyYW5kLWJ0biB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTBweDsKICBtYXJnaW4tbGVmdDogLTZweDsKICBwYWRkaW5nOiA0cHggMTBweCA0cHggNnB4OwogIGJvcmRlcjogMDsKICBib3JkZXItcmFkaXVzOiAyMHB4OwogIGJhY2tncm91bmQ6IG5vbmU7CiAgY29sb3I6IGluaGVyaXQ7CiAgZm9udDogaW5oZXJpdDsKICBjdXJzb3I6IHBvaW50ZXI7Cn0KLmJyYW5kLWJ0bjpob3ZlciwgLmJyYW5kLWJ0blt",
"hcmlhLWV4cGFuZGVkPSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLmJyYW5kIC5kaW0geyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmFjY291bnQgewogIG1hcmdpbi1sZWZ0OiAxNHB4OwogIHBhZGRpbmc6IDRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDE0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEzcHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIG1pbi13aWR0aDogMDsKfQouc3BhY2VyIHsgZmxleDogMTsgfQoudXBkYXRlZCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxMnB4OyB3aGl0ZS1zcGFjZTogbm93cmFwOyBtYXJnaW4tcmlnaHQ6IDJweDsgfQoKLyog4pSA4pSAIFRhYnM6IEJvYXJkIHwgTm90ZXMg4pSA4pSAICovCgoudGFicyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IDJweDsKICBtYXJnaW4tbGVmdDogMThweDsKICBwYWRkaW5nOiAzcHg7CiAgYm9yZGVyLXJhZGl1czogMjBweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7Cn0KLnRhYiB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCAxNHB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGNvbG9yOiB2YXIoLS1mZy0",
"yKTsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKfQoudGFiOmhvdmVyIHsgY29sb3I6IHZhcigtLWZnKTsgfQoudGFiW2FyaWEtc2VsZWN0ZWQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBjb2xvcjogdmFyKC0tZmcpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLnRhYlthcmlhLXNlbGVjdGVkPSJ0cnVlIl0gLmljb24geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouc3Bpbm5pbmcgLmljb24geyBhbmltYXRpb246IHNwaW4gLjlzIGxpbmVhciBpbmZpbml0ZTsgfQpAa2V5ZnJhbWVzIHNwaW4geyB0byB7IHRyYW5zZm9ybTogcm90YXRlKDM2MGRlZyk7IH0gfQoKLmJvZHkgeyBmbGV4OiAxOyBkaXNwbGF5OiBmbGV4OyBtaW4taGVpZ2h0OiAwOyB9CgouY29sdW1ucyB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMTJweDsKICBwYWRkaW5nOiA0cHggMjBweCAyMHB4OwogIG92ZXJmbG93LXg6IGF1dG87CiAgb3ZlcmZsb3cteTogaGlkZGVuOwogIG1pbi1oZWlnaHQ6IDA7Cn0KLmNvbHVtbiB7CiAgZmxleDogMSAwIDI4MHB4OwogIG1pbi13aWR0aDogMjgwcHg7CiAgbWF4LXdpZHRoOiA0MDBweDsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLWhlaWdodDogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJ",
"zOwp9Ci5jb2x1bW4uZHJvcC10YXJnZXQgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgfQouY29sLWhlYWQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMHB4IDZweCA2cHggMTZweDsKICBmbGV4OiBub25lOwp9Ci5jb2wtdGl0bGUgewogIG1hcmdpbjogMDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmcpOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouY29sLWNvdW50IHsKICBmbGV4OiBub25lOwogIG1pbi13aWR0aDogMjJweDsKICBwYWRkaW5nOiAwIDdweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9Ci5jb2wtZmxhZyB7CiAgZmxleDogbm9uZTsKICBwYWRkaW5nOiAwIDhweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDExcHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7Cn0KLmNvbC1oZWFkIC5zcGFjZXIgeyBtaW4td2lkdGg6IDRweDs",
"gfQouY29sLW5vdGUgeyBwYWRkaW5nOiAwIDE2cHggNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZmxleDogbm9uZTsgfQoKLmxpc3QgewogIGZsZXg6IDE7CiAgbWluLWhlaWdodDogNzJweDsKICBvdmVyZmxvdy15OiBhdXRvOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiA0cHggOHB4IDEycHg7CiAgc2Nyb2xsYmFyLXdpZHRoOiB0aGluOwp9Ci5saXN0OmVtcHR5OjphZnRlciB7CiAgY29udGVudDogYXR0cihkYXRhLWVtcHR5KTsKICBkaXNwbGF5OiBibG9jazsKICBtYXJnaW46IDJweCAwOwogIHBhZGRpbmc6IDIycHggMTJweDsKICBib3JkZXI6IDEuNXB4IGRhc2hlZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDEzcHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9CgovKiDilIDilIAgQ2FyZHMg4pSA4pSAICovCgouY2FyZCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGZsZXg6IG5vbmU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7CiAgY3Vyc29yOiBncmFiOwogIHRyYW5zaXRpb246IGJveC1zaGFkb3cgLjE1czsKfQouY2FyZDpob3ZlciB7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0yKTsgfQouY2FyZC5",
"kcmFnZ2luZyB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhcmQubGlmdGluZyB7IG9wYWNpdHk6IC41OyB9Ci5jYXJkLW1haW4gewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDEwcHggMTRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBjdXJzb3I6IGluaGVyaXQ7Cn0KLmNhcmQtbWFpbjpmb2N1cy12aXNpYmxlIHsgb3V0bGluZS1vZmZzZXQ6IC0ycHg7IH0KLmNhcmQtdG9wIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgbWluLWhlaWdodDogMjBweDsKICBmb250LXNpemU6IDEzcHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5kb3QgeyB3aWR0aDogOHB4OyBoZWlnaHQ6IDhweDsgYm9yZGVyLXJhZGl1czogNTAlOyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBmbGV4OiBub25lOyB9Ci5mcm9tIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZGF0ZSB7IGZsZXg6IG5vbmU7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jYXJkOmhvdmVyIC5kYXRlLCAuY2FyZDpmb2N1cy13aXRoaW4gLmRhdGUgeyB2aXNpYmlsaXR5OiBoaWRkZW47IH0KLnN1YmplY3Qtcm93IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg",
"7IG1hcmdpbi10b3A6IDNweDsgfQouc3ViamVjdCB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIGZvbnQtc2l6ZTogMTRweDsKICBjb2xvcjogdmFyKC0tZmcpOwp9Ci51bnJlYWQgLmZyb20sIC51bnJlYWQgLnN1YmplY3QgeyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5zdGFyIHsgY29sb3I6IHZhcigtLXN0YXIpOyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgZmxleDogbm9uZTsgfQouY291bnQgewogIGZsZXg6IG5vbmU7CiAgcGFkZGluZzogMCA2cHg7CiAgYm9yZGVyLXJhZGl1czogOXB4OwogIGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxMXB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGluZS1oZWlnaHQ6IDE4cHg7Cn0KLmRyYWZ0IHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTJweDsgfQouc25pcHBldCB7CiAgbWFyZ2luLXRvcDogM3B4OwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMThweDsKICBjb2xvcjogdmFyKC0tZmctMyk7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydGljYWw7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBvdmVyZmxvdy13cmF",
"wOiBhbnl3aGVyZTsKfQouY2FyZC1ub3RlIHsKICBtYXJnaW4tdG9wOiA0cHg7CiAgcGFkZGluZy1sZWZ0OiA4cHg7CiAgYm9yZGVyLWxlZnQ6IDJweCBzb2xpZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIHdoaXRlLXNwYWNlOiBwcmUtbGluZTsKICBkaXNwbGF5OiAtd2Via2l0LWJveDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDM7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICBvdmVyZmxvdzogaGlkZGVuOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9CgpbZGF0YS1jb2xvdXI9InJlZCJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcmVkKTsgfQpbZGF0YS1jb2xvdXI9Im9yYW5nZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtb3JhbmdlKTsgfQpbZGF0YS1jb2xvdXI9InllbGxvdyJdIHsgLS1zdHJpcGU6IHZhcigtLWMteWVsbG93KTsgfQpbZGF0YS1jb2xvdXI9ImdyZWVuIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ncmVlbik7IH0KW2RhdGEtY29sb3VyPSJibHVlIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ibHVlKTsgfQpbZGF0YS1jb2xvdXI9InB1cnBsZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcHVycGxlKTsgfQpbZGF0YS1jb2xvdXI9ImdyZXkiXSB7IC0tc3RyaXBlOiB2YXIoLS1jLWdyZXkpOyB9Ci5jYXJkW2RhdGEtY29sb3VyXTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjo",
"gYWJzb2x1dGU7CiAgdG9wOiAwOwogIGJvdHRvbTogMDsKICBsZWZ0OiAwOwogIHdpZHRoOiA2cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweCAwIDAgMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdHJpcGUpOwogIHBvaW50ZXItZXZlbnRzOiBub25lOwp9Ci5jYXJkW2RhdGEtY29sb3VyXSAuY2FyZC1tYWluIHsgcGFkZGluZy1sZWZ0OiAxOHB4OyB9CgouY2FyZC1tZW51IHsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiA0cHg7CiAgcmlnaHQ6IDRweDsKICB3aWR0aDogMzJweDsKICBoZWlnaHQ6IDMycHg7CiAgb3BhY2l0eTogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKfQouY2FyZC1tZW51OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5jYXJkOmhvdmVyIC5jYXJkLW1lbnUsIC5jYXJkOmZvY3VzLXdpdGhpbiAuY2FyZC1tZW51LCAuY2FyZC1tZW51W2FyaWEtZXhwYW5kZWQ9InRydWUiXSB7IG9wYWNpdHk6IDE7IH0KLyogTm8gaG92ZXIgb24gYSB0b3VjaCBzY3JlZW46IHRoZSDii68gaXMgYWx3YXlzIHRoZXJlLCBhbmQgdGhlIHRvcCBsaW5lCiAgIG1ha2VzIHJvb20gZm9yIGl0IHJhdGhlciB0aGFuIGhpZGluZyB0aGUgZGF0ZSB1bmRlciBpdC4gKi8KQG1lZGlhIChob3Zlcjogbm9uZSkgeyAuY2FyZC1tZW51IHsgb3BhY2l0eTogMTsgfSAuY2FyZCAuZGF0ZSB7IHZpc2liaWxpdHk6IHZpc2libGU7IH0gLmNhcmQtdG9wIHsgcGFkZGluZy1yaWdodDogMzBweDsgfSB9Cgo",
"ucGxhY2Vob2xkZXIgewogIGZsZXg6IG5vbmU7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3JkZXI6IDJweCBkYXNoZWQgdmFyKC0tYWNjZW50KTsKICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYWNjZW50KSAxMCUsIHRyYW5zcGFyZW50KTsKfQoKLnNrZWxldG9uIHsKICBmbGV4OiBub25lOwogIGhlaWdodDogOTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIG9wYWNpdHk6IC41NTsKICBhbmltYXRpb246IHB1bHNlIDEuNHMgZWFzZS1pbi1vdXQgaW5maW5pdGU7Cn0KQGtleWZyYW1lcyBwdWxzZSB7IDUwJSB7IG9wYWNpdHk6IC4zOyB9IH0KCi8qIOKUgOKUgCBDb2x1bW4gc2VhcmNoIOKUgOKUgCAqLwoKLnNlYXJjaCB7CiAgZmxleDogbm9uZTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiA2cHg7CiAgbWF4LWhlaWdodDogNTUlOwogIG1pbi1oZWlnaHQ6IDA7CiAgbWFyZ2luOiAwIDhweCA4cHg7CiAgcGFkZGluZzogOHB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTIpOwp9Ci5zZWFyY2gtYm94IHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgaGVpZ2h0OiA0MHB4OwogIHBhZGRpbmc6IDAgMnB4IDAgMTJweDsKICBib3JkZXItcmF",
"kaXVzOiAyMHB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZsZXg6IG5vbmU7Cn0KLnNlYXJjaC1ib3g6Zm9jdXMtd2l0aGluIHsgb3V0bGluZTogMnB4IHNvbGlkIHZhcigtLWZvY3VzKTsgfQouc2VhcmNoLWJveCBpbnB1dCB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgaGVpZ2h0OiAxMDAlOwogIGJvcmRlcjogMDsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQ6IGluaGVyaXQ7CiAgZm9udC1zaXplOiAxNHB4Owp9Ci5zZWFyY2gtYm94IGlucHV0OjpwbGFjZWhvbGRlciB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQouc2VhcmNoLWJveCBpbnB1dDpmb2N1cy12aXNpYmxlIHsgb3V0bGluZTogbm9uZTsgfQouc2VhcmNoLWhpbnQgeyBwYWRkaW5nOiAwIDhweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGZsZXg6IG5vbmU7IH0KLnJlc3VsdHMgeyBvdmVyZmxvdy15OiBhdXRvOyBtaW4taGVpZ2h0OiAwOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDJweDsgc2Nyb2xsYmFyLXdpZHRoOiB0aGluOyB9Ci5yZXN1bHQgewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDdweCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5yZXN1bHQ6aG92ZXI6bm90KDpkaXNhYmxlZCkgeyBiYWNrZ3J",
"vdW5kOiB2YXIoLS1ob3Zlcik7IH0KLnJlc3VsdDpkaXNhYmxlZCB7IG9wYWNpdHk6IC41NTsgfQouci10b3AgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDZweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IH0KLnItdG9wIC5mcm9tIHsgZm9udC13ZWlnaHQ6IDUwMDsgfQouci1zdWJqZWN0IHsKICBkaXNwbGF5OiBibG9jazsKICBmb250LXNpemU6IDEzcHg7CiAgY29sb3I6IHZhcigtLWZnKTsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLnItd2hlcmUgeyBkaXNwbGF5OiBibG9jazsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTsgbWFyZ2luLXRvcDogMXB4OyB9Ci5yZXN1bHQ6ZGlzYWJsZWQgLnItd2hlcmUgeyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLnJlc3VsdHMtZW1wdHkgeyBwYWRkaW5nOiAxMnB4IDhweDsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMyk7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoKLyog4pSA4pSAIFN0YXR1cyBwYW5lbHMg4pSA4pSAICovCgoucGFuZWwgewogIG1hcmdpbjogYXV0bzsKICB3aWR0aDogbWluKDQ2MHB4LCBjYWxjKDEwMHZ3IC0gNDhweCkpOwogIHBhZGRpbmc6IDM2cHggMzJweCAzMnB4OwogIGJvcmRlci1yYWRpdXM6IDI4cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOwo",
"gIHRleHQtYWxpZ246IGNlbnRlcjsKfQoucGFuZWwgLnBhbmVsLWljb24gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDU2cHg7CiAgaGVpZ2h0OiA1NnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7CiAgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsKfQoucGFuZWwgaDIgeyBtYXJnaW46IDE2cHggMCA4cHg7IGZvbnQtc2l6ZTogMjJweDsgZm9udC13ZWlnaHQ6IDQwMDsgY29sb3I6IHZhcigtLWZnKTsgfQoucGFuZWwgcCB7IG1hcmdpbjogMCAwIDIwcHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgbGluZS1oZWlnaHQ6IDEuNTsgfQoucGFuZWwgLmFjdGlvbnMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDhweDsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IH0KCi8qIOKUgOKUgCBOb3RlcyDilIDilIAgKi8KCi5ub3RlcyB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMTJweDsKICBtaW4td2lkdGg6IDA7CiAgbWluLWhlaWdodDogMDsKICBwYWRkaW5nOiA0cHggMjBweCAyMHB4Owp9Ci5ub3Rlcy1mb2xkZXJzIHsKICBmbGV4OiAwIDAgMjMwcHg7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIG1pbi1oZWlnaHQ6IDA7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwp",
"9Ci5mb2xkZXJzLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDRweDsgcGFkZGluZzogMTBweCA2cHggNHB4IDE2cHg7IGZsZXg6IG5vbmU7IH0KLmZvbGRlcnMtaGVhZCBoMiB7IG1hcmdpbjogMDsgZmxleDogMTsgZm9udC1zaXplOiAxM3B4OyBmb250LXdlaWdodDogNTAwOyBjb2xvcjogdmFyKC0tZmctMik7IGxldHRlci1zcGFjaW5nOiAuMDJlbTsgfQouZm9sZGVyLWl0ZW1zIHsgZmxleDogMTsgb3ZlcmZsb3cteTogYXV0bzsgcGFkZGluZzogMnB4IDhweCAxMHB4OyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDFweDsgfQouZm9sZGVyLXJvdyB7IHBvc2l0aW9uOiByZWxhdGl2ZTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZy1sZWZ0OiBjYWxjKHZhcigtLWRlcHRoLCAwKSAqIDE2cHgpOyB9Ci5mb2xkZXItcm93LmRyb3AgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWFjY2VudCkgMTAlLCB0cmFuc3BhcmVudCk7IH0KLmZvbGRlci1idG4gewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBoZWlnaHQ6IDM2cHg7CiAgcGFkZGluZzogMCAxMHB4OwogIGJvcmRlci1yYWRpdXM",
"6IDEwcHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQtc2l6ZTogMTRweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5mb2xkZXItYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5mb2xkZXItYnRuW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyBmb250LXdlaWdodDogNTAwOyB9Ci5mb2xkZXItYnRuIC5pY29uIHsgY29sb3I6IGluaGVyaXQ7IG9wYWNpdHk6IC44NTsgfQouZm9sZGVyLXRpdGxlIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZm9sZGVyLWNvdW50IHsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogaW5oZXJpdDsgb3BhY2l0eTogLjc1OyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9Ci5mb2xkZXItbWVudSB7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgcmlnaHQ6IDJweDsgd2lkdGg6IDMwcHg7IGhlaWdodDogMzBweDsgb3BhY2l0eTogMDsgYmFja2dyb3VuZDogdmFyKC0tY29sKTsgfQouZm9sZGVyLXJvdzpob3ZlciAuZm9sZGVyLW1lbnUsIC5mb2xkZXItcm93OmZvY3VzLXdpdGhpbiAuZm9sZGVyLW1lbnUsIC5mb2xkZXItbWVudVthcmlhLWV4cGFuZGVkPSJ0cnVlIl0geyBvcGFjaXR5OiAxOyB9Ci5mb2x",
"kZXItcm93OmhvdmVyIC5mb2xkZXItY291bnQsIC5mb2xkZXItcm93OmZvY3VzLXdpdGhpbiAuZm9sZGVyLWNvdW50IHsgdmlzaWJpbGl0eTogaGlkZGVuOyB9Ci5mb2xkZXItcm93OmhhcyguZm9sZGVyLWJ0blthcmlhLWN1cnJlbnQ9InRydWUiXSkgLmZvbGRlci1tZW51IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci5mb2xkZXItcm93LmVkaXRpbmcgeyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBhbGlnbi1pdGVtczogc3RyZXRjaDsgcGFkZGluZy10b3A6IDJweDsgcGFkZGluZy1ib3R0b206IDJweDsgfQouZm9sZGVyLWVkaXQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgcGFkZGluZy1sZWZ0OiAxMHB4OyBjb2xvcjogdmFyKC0tZmctMik7IH0KLmZvbGRlci1pbnB1dCB7IGhlaWdodDogMzRweDsgZmxleDogMTsgbWluLXdpZHRoOiAwOyB9Ci5mb2xkZXItZXJyb3IgeyBwYWRkaW5nOiA0cHggNHB4IDJweCAzNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci8qIFRoZSBhcnJvdyB0aGF0IGZvbGRzIGEgZm9sZGVyJ3Mgc3ViZm9sZGVycyBhd2F5OiBhIGNvbHVtbiBvZiBpdHMgb3duLAogICBvbmNlIHNvbWUgZm9sZGVyIGhhcyBzdWJmb2xkZXJzLCBzbyBldmVyeSBmb2xkZXIncyBpY29uIGxpbmVzIHVwLiAqLwouZm9sZGVyLXR3aXN0eSB7CiAgZmxleDogbm9uZTsKICB",
"kaXNwbGF5OiBub25lOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDIwcHg7CiAgaGVpZ2h0OiAzNnB4OwogIG1hcmdpbi1yaWdodDogMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmctMyk7Cn0KLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci10d2lzdHkgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgfQpidXR0b24uZm9sZGVyLXR3aXN0eTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQouZm9sZGVyLXR3aXN0eSAuaWNvbiB7IHRyYW5zaXRpb246IHRyYW5zZm9ybSAuMTVzIGVhc2U7IH0KLmZvbGRlci10d2lzdHlbYXJpYS1leHBhbmRlZD0iZmFsc2UiXSAuaWNvbiB7IHRyYW5zZm9ybTogcm90YXRlKC05MGRlZyk7IH0KLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci1lZGl0IHsgcGFkZGluZy1sZWZ0OiAzMnB4OyB9Ci5mb2xkZXItaXRlbXNbZGF0YS1uZXN0ZWRdIC5mb2xkZXItZXJyb3IgeyBwYWRkaW5nLWxlZnQ6IDU4cHg7IH0KLyogRm9sZGVkLCB3aXRoIHRoZSBmb2xkZXIgYmVpbmcgbG9va2VkIGF0IGluc2lkZSBpdC4gKi8KLmZvbGRlci1idG4uaG9sZHMtY3VycmVudCB7IGNvbG9yOiB2YXIoLS1mZyk7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLm5vdGVzLXNjb3BlIHsgZmxleDogbm9uZTsgcGFkZGluZzogMCAyMHB4IDZweDsgZm9udC1zaXplOiA",
"xMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IHdoaXRlLXNwYWNlOiBub3dyYXA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB9Ci5ub3Rlcy1saXN0IHsKICBmbGV4OiAwIDAgMzIwcHg7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIG1pbi1oZWlnaHQ6IDA7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwp9Ci5ub3Rlcy10b29scyB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nOiAxMnB4IDEycHggOHB4OyBmbGV4OiBub25lOyB9Ci5ub3Rlcy10b29scyAuc2VhcmNoLWJveCB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IH0KLm5vdGVzLXRvb2xzIC5idG4geyBoZWlnaHQ6IDQwcHg7IHBhZGRpbmc6IDAgMTZweCAwIDEycHg7IGZsZXg6IG5vbmU7IH0KLm5vdGVzLWl0ZW1zIHsgZmxleDogMTsgb3ZlcmZsb3cteTogYXV0bzsgcGFkZGluZzogMCA4cHggOHB4OyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDJweDsgfQoubm90ZS1pdGVtIHsKICBkaXNwbGF5OiBibG9jazsKICB3aWR0aDogMTAwJTsKICBwYWRkaW5nOiAxMHB4IDEycHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5ub3RlLWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1",
"ob3Zlcik7IH0KLm5vdGUtaXRlbVthcmlhLWN1cnJlbnQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLm5pLXRvcCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBiYXNlbGluZTsgZ2FwOiA4cHg7IH0KLm5pLXRpdGxlIHsKICBmbGV4OiAxOwogIG1pbi13aWR0aDogMDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgZm9udC1zaXplOiAxNHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgY29sb3I6IHZhcigtLWZnKTsKfQoubmktc25pcHBldCB7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydGljYWw7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKICBtYXJnaW4tdG9wOiAycHg7CiAgZm9udC1zaXplOiAxM3B4OwogIGxpbmUtaGVpZ2h0OiAxOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKfQoubmktbWV0YSB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiA0cHggMTBweDsgbWFyZ2luLXRvcDogM3B4OyB9Ci5uaS1tZXRhOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQoubmktZm9sZGVyIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogM3B4OyBmb250LXNpemU6IDExcHg",
"7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubmktbWFpbCB7IGZvbnQtc2l6ZTogMTFweDsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLmRyYWdnaW5nLW5vdGUgLm5vdGUtaXRlbVthcmlhLWN1cnJlbnQ9InRydWUiXSB7IGJveC1zaGFkb3c6IG5vbmU7IH0KLm5lLWZvbGRlciB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDRweDsKICBoZWlnaHQ6IDMycHg7CiAgbWF4LXdpZHRoOiAyNjBweDsKICBtYXJnaW4tcmlnaHQ6IDRweDsKICBwYWRkaW5nOiAwIDRweCAwIDEwcHg7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxM3B4OwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLm5lLWZvbGRlciBzcGFuIHsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IH0KLm5lLWZvbGRlcjpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQovKiBTZWFyY2g6IHRoZSB3b3JkcyBtYXJrZWQgaW4gcmVzdWx0cywgYW5kIGluIHRoZSBvcGVuIG5vdGUuICovCm1hcmsgeyBiYWNrZ3JvdW5kOiB2YXIoLS1tYXJrKTsgY29sb3I6IGluaGVyaXQ7IGJvcmRlci1yYWRpdXM6IDJweDsgcGFkZGluZzogMCAxcHg7IH0KLyogT25seSB0aGUgcGhvbmUgYXBwLCB3aGljaCBzaG93cyBvbmUgcGFuZSBhdCBhIHRpbWUsIG5lZWRzIGEgd2F5IGJhY2ssCiAgIGFuZCBhIGJ",
"1dHRvbiB0byBmb2xkIHRoZSBmb2xkZXIgdHJlZSBhd2F5LiAqLwoubmUtYmFjaywgLmZvbGRlcnMtdG9nZ2xlIHsgZGlzcGxheTogbm9uZTsgfQoubmktZXhjZXJwdHMgeyBkaXNwbGF5OiBibG9jazsgbWFyZ2luLXRvcDogM3B4OyB9Ci5uaS1leGNlcnB0IHsKICBkaXNwbGF5OiBibG9jazsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTMpOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9Ci5uaS1leGNlcnB0ICsgLm5pLWV4Y2VycHQgeyBtYXJnaW4tdG9wOiAzcHg7IH0KLm5pLWV4Y2VycHQgbWFyaywgLm5pLXNuaXBwZXQgbWFyaywgLm5pLXRpdGxlIG1hcmsgeyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5uaS1oaXRzIHsgZm9udC1zaXplOiAxMXB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQo6OmhpZ2hsaWdodChna2ItbWF0Y2gpIHsgYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tbWFyayk7IH0KOjpoaWdobGlnaHQoZ2tiLW1hdGNoLWN1cnJlbnQpIHsgYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tbWFyay1jdXJyZW50KTsgY29sb3I6IHZhcigtLW9uLW1hcmstY3VycmVudCk7IH0KLm5lLWZpbmQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBtYXJnaW46IDRweCAyMHB4IDA7CiAgcGFkZGluZzogMnB4IDRweCAycHggMTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJ",
"hY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQtc2l6ZTogMTNweDsKICBmbGV4OiBub25lOwp9Ci5uZS1maW5kIC5maW5kLXdvcmRzIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgY29sb3I6IHZhcigtLWZnKTsgfQoubmUtZmluZCAuZmluZC1wb3MgeyB3aGl0ZS1zcGFjZTogbm93cmFwOyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9Ci5uZS1maW5kIC5pY29uLWJ0biB7IHdpZHRoOiAzMnB4OyBoZWlnaHQ6IDMycHg7IH0KLm5vdGVzLWVtcHR5IHsgcGFkZGluZzogMjRweCAxMnB4OyB0ZXh0LWFsaWduOiBjZW50ZXI7IGZvbnQtc2l6ZTogMTNweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5ub3Rlcy1lbXB0eSBwIHsgbWFyZ2luOiAwIDAgOHB4OyB9Ci5ub3Rlcy1mb290IHsgZmxleDogbm9uZTsgcGFkZGluZzogOHB4IDE2cHggMTJweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLm5vdGVzLWZvb3Q6ZW1wdHkgeyBkaXNwbGF5OiBub25lOyB9Cgoubm90ZS1lZGl0b3IgewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGJveC1zaGFkb3c6IHZ",
"hcigtLXNoYWRvdy0xKTsKfQoubmUtYmFyIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA0cHg7IHBhZGRpbmc6IDhweCAxMHB4IDAgMjhweDsgZmxleDogbm9uZTsgbWluLWhlaWdodDogNDhweDsgfQoubmUtc3RhdHVzIHsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IHdoaXRlLXNwYWNlOiBub3dyYXA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyBtaW4td2lkdGg6IDA7IH0KLm5lLXN0YXR1cy5lcnJvciB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci5uZS1iYW5uZXIgewogIG1hcmdpbjogNHB4IDI4cHggMDsKICBwYWRkaW5nOiAxMHB4IDE0cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7CiAgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDEuNDU7CiAgZmxleDogbm9uZTsKfQoubmUtdGl0bGUgewogIGJvcmRlcjogMDsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKfQoubmUtdGl0bGUgeyBmbGV4OiBub25lOyBwYWRkaW5nOiA4cHggMjhweCA2cHg7IGZvbnQtc2l6ZTogMjRweDsgbGluZS1oZWlnaHQ6IDEuMzsgfQoubmUtYm9keSB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGZsZXg6IDE7CiAgbWluLWhlaWdodDo",
"gMDsKICBvdmVyZmxvdy15OiBhdXRvOwogIHBhZGRpbmc6IDEwcHggMjhweCAyOHB4OwogIGZvbnQtc2l6ZTogMTVweDsKICBsaW5lLWhlaWdodDogMS42OwogIHdoaXRlLXNwYWNlOiBwcmUtd3JhcDsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKICBvdXRsaW5lOiBub25lOwogIGNvdW50ZXItcmVzZXQ6IG9sMCBvbDEgb2wyIG9sMzsKfQoubmUtdGl0bGU6OnBsYWNlaG9sZGVyIHsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci8qIFRoZSBzY3JhdGNocGFkOiBpdHMgb3duIGNvbG91ciwgYSBmaXhlZCBuYW1lLCBhbmQgcGlubmVkIGluIHRoZSBsaXN0LiAqLwoubm90ZS1lZGl0b3Iuc2NyYXRjaCB7IGJhY2tncm91bmQ6IHZhcigtLXNjcmF0Y2gpOyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxcHggdmFyKC0tc2NyYXRjaC1lZGdlKSwgdmFyKC0tc2hhZG93LTEpOyB9Ci5ub3RlLWVkaXRvci5zY3JhdGNoIC5uZS10b29sYmFyIHsgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLXNjcmF0Y2gtZWRnZSkgNDUlLCB0cmFuc3BhcmVudCk7IH0KLm5vdGUtZWRpdG9yLnNjcmF0Y2ggLm5lLWJhcjplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KLnNjcmF0Y2gtdGl0bGUgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEwcHg7IG1hcmdpbjogMDsgcGFkZGluZy10b3A6IDE4cHg7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLnNjcmF0Y2gtdGl0bGUgLnN0LW5hbWUgeyBmbGV4OiAxOyBtaW4",
"td2lkdGg6IDA7IH0KLnNjcmF0Y2gtdGl0bGUgLm5lLXN0YXR1cyB7IGZvbnQtc2l6ZTogMTJweDsgfQouc2NyYXRjaC10aXRsZSAuaWNvbiB7IGNvbG9yOiB2YXIoLS1zY3JhdGNoLWluayk7IH0KLnNjcmF0Y2gtaXRlbSB7IG1hcmdpbi1ib3R0b206IDRweDsgYmFja2dyb3VuZDogdmFyKC0tc2NyYXRjaCk7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDFweCB2YXIoLS1zY3JhdGNoLWVkZ2UpOyB9Ci5zY3JhdGNoLWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc2NyYXRjaCkgODUlLCB2YXIoLS1zY3JhdGNoLWVkZ2UpKTsgfQouc2NyYXRjaC1pdGVtW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tc2NyYXRjaCk7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDJweCB2YXIoLS1zY3JhdGNoLWVkZ2UpLCB2YXIoLS1zaGFkb3ctMSk7IH0KLnNjcmF0Y2gtaXRlbSAubmktdGl0bGUgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDZweDsgZm9udC13ZWlnaHQ6IDUwMDsgfQouc2NyYXRjaC1pdGVtIC5uaS10aXRsZSAuaWNvbiB7IGZsZXg6IG5vbmU7IGNvbG9yOiB2YXIoLS1zY3JhdGNoLWluayk7IH0KLm5lLXRpdGxlOmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiBub25lOyB9Ci5uZS10aXRsZTpkaXNhYmxlZCwgLm5lLWJvZHlbYXJpYS1kaXNhYmxlZD0idHJ1ZSJdIHsgb3BhY2l0eTogLjY7IH0KLm5lLWJvZHlbZGF0YS1lbXB",
"0eT0iMSJdOjpiZWZvcmUgewogIGNvbnRlbnQ6IGF0dHIoZGF0YS1wbGFjZWhvbGRlcik7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHRvcDogMTBweDsKICBsZWZ0OiAyOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKfQoKLyogQmxvY2tzOiBvbmUgcGVyIHBhcmFncmFwaCwgaGVhZGluZyBvciBsaXN0IGl0ZW0uIEJ1bGxldHMsIG51bWJlcnMgYW5kCiAgIGJveGVzIGFyZSBkcmF3biBoZXJlLCBpbiBlYWNoIGJsb2NrJ3MgbGVmdCBwYWRkaW5nLiAqLwouYmxrIHsgcG9zaXRpb246IHJlbGF0aXZlOyBtaW4taGVpZ2h0OiAxLjZlbTsgLS1sdmw6IDA7IH0KLmJsa1tkYXRhLWxldmVsPSIxIl0geyAtLWx2bDogMTsgfQouYmxrW2RhdGEtbGV2ZWw9IjIiXSB7IC0tbHZsOiAyOyB9Ci5ibGtbZGF0YS1sZXZlbD0iMyJdIHsgLS1sdmw6IDM7IH0KLmJsa1tkYXRhLXR5cGU9ImgxIl0geyBmb250LXNpemU6IDI0cHg7IGxpbmUtaGVpZ2h0OiAxLjM7IGZvbnQtd2VpZ2h0OiA2MDA7IG1hcmdpbjogMTRweCAwIDRweDsgfQouYmxrW2RhdGEtdHlwZT0iaDIiXSB7IGZvbnQtc2l6ZTogMjBweDsgbGluZS1oZWlnaHQ6IDEuMzU7IGZvbnQtd2VpZ2h0OiA2MDA7IG1hcmdpbjogMTJweCAwIDJweDsgfQouYmxrW2RhdGEtdHlwZT0iaDMiXSB7IGZvbnQtc2l6ZTogMTdweDsgbGluZS1oZWlnaHQ6IDEuNDsgZm9udC13ZWlnaHQ6IDYwMDsgbWFyZ2luOiAxMHB4IDAgMnB4OyB9Ci5ibGs6Zmlyc3Q",
"tY2hpbGQgeyBtYXJnaW4tdG9wOiAwOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdLCAuYmxrW2RhdGEtdHlwZT0ib2wiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl0geyBwYWRkaW5nLWxlZnQ6IGNhbGMoMjhweCArIHZhcigtLWx2bCkgKiAyNHB4KTsgfQouYmxrW2RhdGEtdHlwZT0idWwiXTo6YmVmb3JlIHsKICBjb250ZW50OiAnXFwyMDIyJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgbGVmdDogY2FsYyg5cHggKyB2YXIoLS1sdmwpICogMjRweCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjEiXTo6YmVmb3JlIHsgY29udGVudDogJ1xcMjVFNic7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMiJdOjpiZWZvcmUsIC5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjMiXTo6YmVmb3JlIHsgY29udGVudDogJ1xcMjVBQSc7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl06OmJlZm9yZSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGModmFyKC0tbHZsKSAqIDI0cHgpOwogIHdpZHRoOiAyMnB4OwogIHRleHQtYWxpZ246IHJpZ2h0OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOwp9Ci8qIE51bWJlcmluZyByZXN0YXJ0cyB3aGVuZXZlciB0aGUgcnVuIG9mIG51bWJlcmVkIGl0ZW1zIGF0IGEgbGV2ZWwgaXMKICAgYnJva2VuIGJ5IGFueXRoaW5nIHNoYWxsb3dlciB",
"vciBieSBhIG5vbi1saXN0IGJsb2NrLiAqLwouYmxrOm5vdChbZGF0YS10eXBlPSJ1bCJdKTpub3QoW2RhdGEtdHlwZT0ib2wiXSk6bm90KFtkYXRhLXR5cGU9ImNoZWNrIl0pIHsgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjAiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMCJdIHsgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjEiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMSJdIHsgY291bnRlci1yZXNldDogb2wxIG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMiJdLCAuYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWxldmVsPSIyIl0geyBjb3VudGVyLXJlc2V0OiBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjMiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMyJdIHsgY291bnRlci1yZXNldDogb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjAiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDA7IGNvdW50ZXItcmVzZXQ6IG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjEiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDE7IGNvdW50ZXItcmVzZXQ6IG9sMiBvbDM7IH0",
"KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMiJdIHsgY291bnRlci1pbmNyZW1lbnQ6IG9sMjsgY291bnRlci1yZXNldDogb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjMiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMCJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMCkgJy4nOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjEiXTo6YmVmb3JlIHsgY29udGVudDogY291bnRlcihvbDEsIGxvd2VyLWFscGhhKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMiJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMiwgbG93ZXItcm9tYW4pICcuJzsgfQouYmxrW2RhdGEtdHlwZT0ib2wiXVtkYXRhLWxldmVsPSIzIl06OmJlZm9yZSB7IGNvbnRlbnQ6IGNvdW50ZXIob2wzKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl06OmJlZm9yZSB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGMoM3B4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOwogIHRvcDogY2FsYyguOGVtIC0gOXB4KTsKICB3aWR0aDogMTRweDsKICBoZWlnaHQ6IDE0cHg7CiAgYm9yZGVyOiAycHggc29saWQgdmFyKC0tZmctMyk7CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGN1cnNvcjogcG9pbnRlcjsKfQouYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXR",
"hLWNoZWNrZWQ9IjEiXTo6YmVmb3JlIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5ibGtbZGF0YS10eXBlPSJjaGVjayJdW2RhdGEtY2hlY2tlZD0iMSJdOjphZnRlciB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGMoOXB4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOwogIHRvcDogY2FsYyguOGVtIC0gN3B4KTsKICB3aWR0aDogNXB4OwogIGhlaWdodDogMTBweDsKICBib3JkZXI6IHNvbGlkIHZhcigtLW9uLWFjY2VudCk7CiAgYm9yZGVyLXdpZHRoOiAwIDJweCAycHggMDsKICB0cmFuc2Zvcm06IHJvdGF0ZSg0NWRlZyk7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7Cn0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1jaGVja2VkPSIxIl0geyBjb2xvcjogdmFyKC0tZmctMyk7IHRleHQtZGVjb3JhdGlvbjogbGluZS10aHJvdWdoOyB9Ci5uZS1ib2R5IGEgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7IGN1cnNvcjogdGV4dDsgfQoKLyogRm9ybWF0dGluZyB0b29sYmFyIGFuZCB0aGUgbGluayBmaWVsZCBiZW5lYXRoIGl0LiAqLwoubmUtdG9vbGJhciB7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LXdyYXA6IHdyYXA7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBtYXJnaW46IDJweCAyMHB4IDA7CiAgcGFkZGluZzogNHB4IDZweDsKICBib3JkZXI",
"tcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgZmxleDogbm9uZTsKfQoudGItYnRuIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIHdpZHRoOiAzMnB4OwogIGhlaWdodDogMzJweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci50Yi1idG46aG92ZXI6bm90KDpkaXNhYmxlZCksIC50Yi1zdHlsZTpob3Zlcjpub3QoOmRpc2FibGVkKSB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQoudGItYnRuW2FyaWEtcHJlc3NlZD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci50Yi1idG46ZGlzYWJsZWQsIC50Yi1zdHlsZTpkaXNhYmxlZCB7IG9wYWNpdHk6IC40OyB9Ci50Yi1zdHlsZSB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCA0cHggMCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNTAwOwp9Ci50Yi1zdHlsZS1sYWJlbCB7IG1pbi13aWR0aDogODRweDsgdGV4dC1hbGlnbjogbGVmdDsgfQoudGItc2VwIHsgd2lkdGg6IDFweDsgaGV",
"pZ2h0OiAyMHB4OyBtYXJnaW46IDAgNnB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1ib3JkZXItc3Ryb25nKTsgb3BhY2l0eTogLjY7IH0KLm5lLWxpbmtiYXIgewogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC13cmFwOiB3cmFwOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgbWFyZ2luOiA2cHggMjBweCAwOwogIHBhZGRpbmc6IDZweCA4cHggNnB4IDEycHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmbGV4OiBub25lOwp9Ci5uZS1saW5rYmFyIC50ZXh0LWlucHV0IHsgZmxleDogMTsgbWluLXdpZHRoOiAxODBweDsgaGVpZ2h0OiAzNHB4OyB9Ci5uZS1saW5rYmFyIC5idG4geyBoZWlnaHQ6IDM0cHg7IH0KLmxpbmstZXJyb3IgeyBmbGV4LWJhc2lzOiAxMDAlOyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgZm9udC1zaXplOiAxMnB4OyB9Ci5saW5rLWVycm9yOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQoKLyogVGFibGVzOiBhIGJsb2NrIHRoYXQgc2Nyb2xscyBzaWRld2F5cyB3aGVuIHdpZGVyIHRoYW4gdGhlIG5vdGUsIGl0cwogICBjZWxscyBlZGl0ZWQgb25lIGF0IGEgdGltZTsgdGhlIGhlYWRpbmcgcm93IHNoYWRlZC4gKi8KLmJsa1tkYXRhLXR5cGU9InRhYmxlIl0geyBvdmVyZmxvdy14OiBhdXRvOyBtYXJnaW46IDhweCAwOyBwYWRkaW5nOiAxcHggMXB4IDRweDsgfQouYmxrW2RhdGEtdHlwZT0",
"idGFibGUiXSB0YWJsZSB7IGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7IH0KLmJsa1tkYXRhLXR5cGU9InRhYmxlIl0gdGQgewogIG1pbi13aWR0aDogNzJweDsKICBtYXgtd2lkdGg6IDI4ZW07CiAgcGFkZGluZzogNHB4IDEwcHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN0cm9uZyk7CiAgdmVydGljYWwtYWxpZ246IHRvcDsKICBvdmVyZmxvdy13cmFwOiBub3JtYWw7CiAgd29yZC1icmVhazogbm9ybWFsOwogIG91dGxpbmU6IG5vbmU7CiAgY3Vyc29yOiB0ZXh0Owp9Ci5ibGtbZGF0YS10eXBlPSJ0YWJsZSJdIHRkOmZvY3VzIHsgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMnB4IHZhcigtLWFjY2VudCk7IH0KLmJsa1tkYXRhLXR5cGU9InRhYmxlIl1bZGF0YS1oZWFkPSIxIl0gdHI6Zmlyc3QtY2hpbGQgdGQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOyBmb250LXdlaWdodDogNjAwOyB9Ci5uZS10YWJsZWJhciB7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LXdyYXA6IHdyYXA7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBtYXJnaW46IDZweCAyMHB4IDA7CiAgcGFkZGluZzogNHB4IDZweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZmxleDogbm9uZTsKfQoubmUtdGFibGViYXIgLnRiLWxhYmVsIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IHBhZGRpbmc6IDAgNnB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTs",
"gfQoubmUtdGFibGViYXIgLnNwYWNlciB7IGZsZXg6IDE7IH0KLnRiLXRleHQgewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAycHg7CiAgaGVpZ2h0OiAzMnB4OwogIHBhZGRpbmc6IDAgNHB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgY29sb3I6IHZhcigtLWZnKTsKICBmb250LXNpemU6IDEzcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwp9Ci50Yi10ZXh0Om5vdChbYXJpYS1oYXNwb3B1cF0pIHsgcGFkZGluZy1yaWdodDogMTBweDsgfQoudGItdGV4dDpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQoudGItdGV4dFthcmlhLXByZXNzZWQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsgfQoKLyog4pSA4pSAIENvbHVtbiBzZXR0aW5ncyBkcmF3ZXIg4pSA4pSAICovCgouc2NyaW0geyBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOyB6LWluZGV4OiA1OyBiYWNrZ3JvdW5kOiB2YXIoLS1zY3JpbSk7IH0KLmRyYXdlciB7CiAgcG9zaXRpb246IGZpeGVkOwogIHotaW5kZXg6IDY7CiAgdG9wOiAwOwogIHJpZ2h0OiAwOwogIGJvdHRvbTogMDsKICB3aWR0aDogbWluKDQ2MHB4LCAxMDB2dyk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwo",
"gIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTMpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKICBmb250LXNpemU6IDE0cHg7CiAgYW5pbWF0aW9uOiBkcmF3ZXItaW4gLjE4cyBlYXNlLW91dDsKfQpAa2V5ZnJhbWVzIGRyYXdlci1pbiB7IGZyb20geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMjRweCk7IG9wYWNpdHk6IDA7IH0gdG8geyB0cmFuc2Zvcm06IG5vbmU7IG9wYWNpdHk6IDE7IH0gfQouZHJhd2VyLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgcGFkZGluZzogMTJweCAxMnB4IDRweCAyNHB4OyBmbGV4OiBub25lOyB9Ci5kcmF3ZXItaGVhZCBoMiB7IG1hcmdpbjogMDsgZmxleDogMTsgZm9udC1zaXplOiAyMHB4OyBmb250LXdlaWdodDogNDAwOyB9Ci5kcmF3ZXItaW50cm8geyBtYXJnaW46IDA7IHBhZGRpbmc6IDAgMjRweCAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IGZvbnQtc2l6ZTogMTNweDsgbGluZS1oZWlnaHQ6IDEuNTsgZmxleDogbm9uZTsgfQouZHJhd2VyLWJvZHkgeyBmbGV4OiAxOyBvdmVyZmxvdy15OiBhdXRvOyBwYWRkaW5nOiA0cHggMjRweCAxNnB4OyB9Ci5jb2wtcm93IHsKICBkaXNwbGF5OiBncmlkOwogIGdhcDogMTBweDsKICBtYXJnaW4tYm90dG9tOiAxMnB4OwogIHBhZGRpbmc6IDEycHggMTJweCAxMHB4IDE0cHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3J",
"kZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5yb3ctaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMnB4OyB9Ci5yb3ctaGVhZCAucm93LW51bSB7CiAgd2lkdGg6IDIycHg7CiAgaGVpZ2h0OiAyMnB4OwogIG1hcmdpbi1yaWdodDogOHB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwogIGZsZXg6IG5vbmU7Cn0KLnJvdy1oZWFkIC5yb3ctdGl0bGUgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IGZvbnQtd2VpZ2h0OiA1MDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9Ci5maWVsZCB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogNHB4OyB9Ci5maWVsZC1sYWJlbCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTIpOyB9Ci50ZXh0LWlucHV0IHsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDM4cHg7CiAgcGFkZGluZzogMCAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQ6IGluaGVyaXQ7CiAgZm9",
"udC1zaXplOiAxNHB4Owp9Ci50ZXh0LWlucHV0OmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogLTFweDsgYm9yZGVyLWNvbG9yOiB0cmFuc3BhcmVudDsgfQouZmllbGQtaGVscCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jaGVjayB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMik7IGN1cnNvcjogcG9pbnRlcjsgfQouY2hlY2sgaW5wdXQgeyB3aWR0aDogMThweDsgaGVpZ2h0OiAxOHB4OyBtYXJnaW46IDA7IGFjY2VudC1jb2xvcjogdmFyKC0tYWNjZW50KTsgfQouYWRkLWNvbCB7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDQ0cHg7IGJvcmRlci1yYWRpdXM6IDE2cHg7IGJvcmRlcjogMS41cHggZGFzaGVkIHZhcigtLWJvcmRlci1zdHJvbmcpOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQouYWRkLWNvbDpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQouZHJhd2VyLWZvb3QgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMnB4IDIwcHggMTZweCAyNHB4OwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGZsZXg6IG5vbmU7Cn0KLmRyYXdlci1mb290IC5ub3RlIHsgZmxleDogMTs",
"gZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGxpbmUtaGVpZ2h0OiAxLjQ1OyB9Ci5mb3JtLWVycm9yIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTNweDsgcGFkZGluZzogMCAyNHB4IDhweDsgZmxleDogbm9uZTsgfQouZm9ybS1lcnJvcjplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KCi8qIOKUgOKUgCBDYXJkIGVkaXRvciDilIDilIAgKi8KCi5kaWFsb2cgewogIHBvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiA2OwogIHRvcDogNTAlOwogIGxlZnQ6IDUwJTsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTAlLCAtNTAlKTsKICB3aWR0aDogbWluKDQ4MHB4LCBjYWxjKDEwMHZ3IC0gMzJweCkpOwogIG1heC1oZWlnaHQ6IGNhbGMoMTAwdmggLSAzMnB4KTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYm9yZGVyLXJhZGl1czogMjRweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmcpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGFuaW1hdGlvbjogZGlhbG9nLWluIC4xNnMgZWFzZS1vdXQ7Cn0KQGtleWZyYW1lcyBkaWFsb2ctaW4geyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGUoLTUwJSwgLTQ3JSk7IH0gdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTA",
"lLCAtNTAlKTsgfSB9Ci5kaWFsb2ctaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nOiAxNHB4IDEycHggMnB4IDI0cHg7IGZsZXg6IG5vbmU7IH0KLmRpYWxvZy1oZWFkIGgyIHsgbWFyZ2luOiAwOyBmbGV4OiAxOyBmb250LXNpemU6IDIwcHg7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLmRpYWxvZy1ib2R5IHsgZGlzcGxheTogZ3JpZDsgZ2FwOiAxOHB4OyBwYWRkaW5nOiAxMHB4IDI0cHggMThweDsgb3ZlcmZsb3cteTogYXV0bzsgfQouZGlhbG9nLWZvb3QgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMnB4IDIwcHggMTZweCAyNHB4OwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGZsZXg6IG5vbmU7Cn0KLmRpYWxvZy1mb290IC5ub3RlIHsgZmxleDogMTsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGxpbmUtaGVpZ2h0OiAxLjQ1OyB9Ci50ZXh0LWFyZWEgeyBoZWlnaHQ6IGF1dG87IG1pbi1oZWlnaHQ6IDgwcHg7IHBhZGRpbmc6IDlweCAxMnB4OyBsaW5lLWhlaWdodDogMS40NTsgcmVzaXplOiB2ZXJ0aWNhbDsgfQouaGVscC1yb3cgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogYmFzZWxpbmU7IGdhcDogNHB4IDEwcHg7IGZsZXgtd3JhcDogd3JhcDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmhlbHA",
"tcm93IC5zdWJqZWN0LXJlZiB7IGNvbG9yOiB2YXIoLS1mZy0yKTsgb3ZlcmZsb3ctd3JhcDogYW55d2hlcmU7IH0KLmxpbmstYnRuIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IGZvbnQtc2l6ZTogMTJweDsgZm9udC13ZWlnaHQ6IDUwMDsgYm9yZGVyLXJhZGl1czogNHB4OyB9Ci5saW5rLWJ0bjpob3ZlciB7IHRleHQtZGVjb3JhdGlvbjogdW5kZXJsaW5lOyB9Ci5zd2F0Y2hlcyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiAxMHB4OyBwYWRkaW5nOiAycHggMDsgfQouc3dhdGNoIHsgcG9zaXRpb246IHJlbGF0aXZlOyB3aWR0aDogMjhweDsgaGVpZ2h0OiAyOHB4OyBjdXJzb3I6IHBvaW50ZXI7IH0KLnN3YXRjaCBpbnB1dCB7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgaW5zZXQ6IDA7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDEwMCU7IG1hcmdpbjogMDsgb3BhY2l0eTogMDsgY3Vyc29yOiBwb2ludGVyOyB9Ci5zd2F0Y2gtZG90IHsKICBkaXNwbGF5OiBibG9jazsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDEwMCU7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLXN0cmlwZSk7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJzOwp9Ci5zd2F0Y2hbZGF0YS1jb2xvdXI9Im5vbmUiXSAuc3dhdGNoLWRvdCB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgdHJhbnNwYXJlbnQgNDUlLCB2YXIoLS1ib3JkZXItc3Ryb25nKSA0NSUsIHZhcigtLWJvcmR",
"lci1zdHJvbmcpIDU1JSwgdHJhbnNwYXJlbnQgNTUlKSwgdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMS41cHggdmFyKC0tYm9yZGVyLXN0cm9uZyk7Cn0KLnN3YXRjaCBpbnB1dDpjaGVja2VkICsgLnN3YXRjaC1kb3QgeyBib3gtc2hhZG93OiAwIDAgMCAycHggdmFyKC0tc3VyZmFjZSksIDAgMCAwIDRweCB2YXIoLS1mZy0yKTsgfQouc3dhdGNoW2RhdGEtY29sb3VyPSJub25lIl0gaW5wdXQ6Y2hlY2tlZCArIC5zd2F0Y2gtZG90IHsKICBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxLjVweCB2YXIoLS1ib3JkZXItc3Ryb25nKSwgMCAwIDAgMnB4IHZhcigtLXN1cmZhY2UpLCAwIDAgMCA0cHggdmFyKC0tZmctMik7Cn0KLnN3YXRjaCBpbnB1dDpmb2N1cy12aXNpYmxlICsgLnN3YXRjaC1kb3QgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogNXB4OyB9Cgouc3Itb25seSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHdpZHRoOiAxcHg7CiAgaGVpZ2h0OiAxcHg7CiAgcGFkZGluZzogMDsKICBtYXJnaW46IC0xcHg7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBjbGlwOiByZWN0KDAgMCAwIDApOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgYm9yZGVyOiAwOwp9CmA7CgogIC8vIOKUgOKUgCBDYWxlbmRhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIFdpZGU6IHRoZSB3ZWVrIGFzIHNldmVuIGNvbHVtbnMsIG9yIGFzIHR3byByb3dzIG9mIGZvdXIgYW5kIHRocmVlCiAgLy8gKGRhdGEtbGF5b3V0KSwgb3IgdGhlIG1vbnRoLCBvciB0aGUgYWdlbmRhLCBiZXNpZGUgYSBzaWRlYmFyLiBOYXJyb3cKICAvLyAoZGF0YS1uYXJyb3csIHNldCBmcm9tIHRoZSB2aWV3J3Mgb3duIHdpZHRoKTogdGhlCiAgLy8gd2VlayBhcyB0d28gY29sdW1ucyBvZiBkYXkgdGlsZXMsIHJlYWQgZG93biB0aGVuIGFjcm9zcywgd2l0aCB0aGUKICAvLyBzbWFsbCBtb250aCBhcyB0aGUgZWlnaHRoIHRpbGUgYW5kIHRoZSBzaWRlYmFyJ3MgcGFydHMgc3ByZWFkIGFib3ZlCiAgLy8gYW5kIGJlbG93LgoKICBjb25zdCBDQUxFTkRBUiA9IGAKLmNhbCB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLXdpZHRoOiAwOwogIG1pbi1oZWlnaHQ6IDA7CiAgcGFkZGluZzogMCAyMHB4IDIwcHg7Cn0KLmNhbC1oZWFkIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IGhlaWdodDogNTJweDsgZmxleDogbm9uZTsgfQouY2FsLW5hdiB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMnB4OyBmbGV4OiBub25",
"lOyB9Ci5jYWwtb3JkZXIgeyBkaXNwbGF5OiBub25lOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLW9yZGVyIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IH0KLmNhbC1sYXlvdXQgeyBkaXNwbGF5OiBub25lOyB9Ci5jYWxbZGF0YS1uYXJyb3c9ImZhbHNlIl1bZGF0YS12aWV3PSJ3ZWVrIl0gLmNhbC1sYXlvdXQgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgfQouYnRuLW91dGxpbmUgeyBoZWlnaHQ6IDM0cHg7IHBhZGRpbmc6IDAgMTZweDsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN0cm9uZyk7IGNvbG9yOiB2YXIoLS1mZyk7IG1hcmdpbi1yaWdodDogNHB4OyB9Ci5idG4tb3V0bGluZTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQouY2FsLXRpdGxlIHsKICBmbGV4OiAxOwogIG1pbi13aWR0aDogMDsKICBtYXJnaW46IDAgMCAwIDZweDsKICBmb250LXNpemU6IDIwcHg7CiAgZm9udC13ZWlnaHQ6IDQwMDsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7Cn0KLmNhbC12aWV3cyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogMnB4OyBwYWRkaW5nOiAzcHg7IGJvcmRlci1yYWRpdXM6IDIwcHg7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgZmxleDogbm9uZTsgfQouc2VnIHsgaGVpZ2h0OiAzMHB4OyBwYWRkaW5nOiAwIDE0cHg7IGJvcmRlci1yYWRpdXM6IDE1cHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZm9",
"udC13ZWlnaHQ6IDUwMDsgZm9udC1zaXplOiAxMy41cHg7IH0KLnNlZzpob3ZlciB7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLnNlZ1thcmlhLXNlbGVjdGVkPSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsgY29sb3I6IHZhcigtLWZnKTsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOyB9CgouY2FsLW5vdGUgewogIGZsZXg6IG5vbmU7CiAgbWFyZ2luOiAwIDAgMTBweDsKICBwYWRkaW5nOiA4cHggMTRweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMS40NTsKfQouY2FsLW5vdGUgcCB7IG1hcmdpbjogMDsgfQouY2FsLW5vdGUgcCArIHAgeyBtYXJnaW4tdG9wOiA0cHg7IH0KLmNhbC1ub3RlIHN0cm9uZyB7IGNvbG9yOiB2YXIoLS1mZyk7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLmNhbC1ub3RlIGEsIC5jYWwgLnBhbmVsIGEgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgd29yZC1icmVhazogYnJlYWstYWxsOyB9Ci5jYWwtbm90ZSAuYnRuIHsgaGVpZ2h0OiAyOHB4OyBtYXJnaW4tbGVmdDogNHB4OyB9Ci5jYWwtbm90ZSBhLmJ0biB7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsgd29yZC1icmVhazogbm9ybWFsOyB9CgouY2FsLWJvZHkgeyBmbGV4OiAxOyBkaXNwbGF5OiBmbGV4OyBnYXA6IDE",
"ycHg7IG1pbi1oZWlnaHQ6IDA7IH0KLmNhbC1zaWRlIHsgd2lkdGg6IDIyOHB4OyBmbGV4OiBub25lOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDEwcHg7IG92ZXJmbG93LXk6IGF1dG87IH0KLmNhbC1tYWluIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBtaW4taGVpZ2h0OiAwOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyB9Ci5jYWwtbWluaSwgLmNhbC1zb3VyY2VzLCAuY2FsLXRyYXkgewogIGZsZXg6IG5vbmU7CiAgcGFkZGluZzogMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7Cn0KCi8qIFRoZSBzbWFsbCBtb250aCAqLwoubWluaS1oZWFkIHsgbWFyZ2luOiAwIDAgNnB4IDRweDsgZm9udC1zaXplOiAxNHB4OyBmb250LXdlaWdodDogNTAwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5taW5pLWdyaWQgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg3LCBtaW5tYXgoMCwgMWZyKSk7IHJvdy1nYXA6IDJweDsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5taW5pLWRvdyB7IHBhZGRpbmc6IDJweCAwOyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubWluaS1kYXkgeyBoZWlnaHQ6IDI2cHg7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTIpOyBmb250LXZhcmlhbnQtbnV",
"tZXJpYzogdGFidWxhci1udW1zOyB9Ci5taW5pLWRheTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgYm9yZGVyLXJhZGl1czogOHB4OyB9Ci5taW5pLWRheS5vdGhlciB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubWluaS1kYXkuc2hvd24geyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLm1pbmktZGF5LnRvZGF5IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7IGJvcmRlci1yYWRpdXM6IDhweDsgZm9udC13ZWlnaHQ6IDYwMDsgfQoKLyogQ2FsZW5kYXJzIGFuZCB0YXNrIGxpc3RzICovCi5jYWwtc291cmNlcyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMXB4OyBwYWRkaW5nOiA2cHg7IH0KLnNyYyB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTBweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCA4cHg7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1zaXplOiAxMy41cHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKfQouc3JjOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5zcmMgLnN3YXRjaCB7CiAgZmxleDogbm9uZTsKICB3aWR0aDogMTRweDsKICBoZWlnaHQ6IDE0cHg7CiAgYm9yZGVyOiAycHggc29saWQgdmFyKC0tc3JjLCB2YXIoLS1",
"hY2NlbnQpKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zcmMsIHZhcigtLWFjY2VudCkpOwogIGJvcmRlci1yYWRpdXM6IDUwJTsKfQouc3JjLXRhc2tzIC5zd2F0Y2ggeyBib3JkZXItcmFkaXVzOiA0cHg7IH0KLnNyY1thcmlhLXByZXNzZWQ9ImZhbHNlIl0gLnN3YXRjaCB7IGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OyB9Ci5zcmNbYXJpYS1wcmVzc2VkPSJmYWxzZSJdIC5zcmMtbmFtZSB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQouc3JjLW5hbWUgeyBtaW4td2lkdGg6IDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9CgovKiBUYXNrcyB3aXRob3V0IGEgZGF5ICovCi5jYWwtdHJheSBoMyB7IG1hcmdpbjogMnB4IDRweCA2cHg7IGZvbnQtc2l6ZTogMTIuNXB4OyBmb250LXdlaWdodDogNTAwOyBjb2xvcjogdmFyKC0tZmctMik7IH0KLmNhbC10cmF5IGgzIC5jb3VudCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC13ZWlnaHQ6IDQwMDsgfQouY2FsLXRyYXkgLmNhbC1pdGVtcyArIGgzIHsgbWFyZ2luLXRvcDogMTJweDsgfQoKLyogRGF5cyAqLwouY2FsLXdlZWsgeyBmbGV4OiAxOyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg3LCBtaW5tYXgoMCwgMWZyKSk7IGdhcDogOHB4OyBtaW4taGVpZ2h0OiAwOyB9Ci5jYWxbZGF0YS1uYXJyb3c9ImZhbHNlIl1bZGF0YS1sYXlvdXQ9InJvd3MiXSAuY2FsLXdlZWsgewo",
"gIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDQsIG1pbm1heCgwLCAxZnIpKTsKICBncmlkLXRlbXBsYXRlLXJvd3M6IHJlcGVhdCgyLCBtaW5tYXgoMCwgMWZyKSk7Cn0KLmRheSB7CiAgbWluLXdpZHRoOiAwOwogIG1pbi1oZWlnaHQ6IDA7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIHBhZGRpbmc6IDhweDsKICBib3JkZXItcmFkaXVzOiAxNHB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7Cn0KLmRheS53ZWVrZW5kLCAubWNlbGwud2Vla2VuZCB7IGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1zdXJmYWNlKSA1NSUsIHZhcigtLWNvbCkpOyB9Ci5kYXkudG9kYXkgeyBwYWRkaW5nOiA3cHg7IGJvcmRlcjogMnB4IHNvbGlkIHZhcigtLWFjY2VudCk7IGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1zdXJmYWNlKSA5MiUsIHZhcigtLWFjY2VudCkpOyB9Ci5jYWwtd2VlayAuZGF5IC5jYWwtaXRlbXMgeyBmbGV4OiAxOyBtaW4taGVpZ2h0OiAwOyBvdmVyZmxvdy15OiBhdXRvOyB9Ci5kYXktaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogNnB4OyBtYXJnaW46IDAgMCA2cHggMnB4OyBmb250LXNpemU6IDE0cHg7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLmRheS1oZWFkIC5kbmFtZSB7IGNvbG9yOiB2YXIoLS1mZy0yKTsgfQouZGF",
"5LWhlYWQgLmRudW0geyBmb250LXdlaWdodDogNTAwOyB9Ci8qIFRoZSBzY3JhdGNocGFkIGluIHRoZSB3ZWVrJ3MgZWlnaHRoIHNwYWNlOiBpdHMgY29sb3VyIGZyb20gdGhlIG5vdGVzLAogICBhbmQgYSBzbWFsbGVyIGVkaXRvciB0aGF0IHNjcm9sbHMgaW5zaWRlIHRoZSB0aWxlLiAqLwouc2NyYXRjaC10aWxlIHsgYmFja2dyb3VuZDogdmFyKC0tc2NyYXRjaCk7IGJvcmRlci1jb2xvcjogdmFyKC0tc2NyYXRjaC1lZGdlKTsgfQouc2NyYXRjaC10aWxlIC5kYXktaGVhZCAuaWNvbiB7IGZsZXg6IG5vbmU7IGNvbG9yOiB2YXIoLS1zY3JhdGNoLWluayk7IH0KLnNjcmF0Y2gtdGlsZSAuZGF5LWhlYWQgLmRuYW1lIHsgY29sb3I6IHZhcigtLWZnKTsgZm9udC13ZWlnaHQ6IDUwMDsgfQouc2NyYXRjaC10aWxlIC5kYXktaGVhZCAubmUtc3RhdHVzIHsgbWFyZ2luLWxlZnQ6IGF1dG87IH0KLnNjcmF0Y2gtdGlsZS1ib2R5IHsgZmxleDogMTsgbWluLWhlaWdodDogMDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgfQouc2NyYXRjaC10aWxlIC5uZS1ib2R5IHsgcGFkZGluZzogMnB4IDRweCA4cHg7IGZvbnQtc2l6ZTogMTMuNXB4OyBsaW5lLWhlaWdodDogMS41OyB9Ci5zY3JhdGNoLXRpbGUgLm5lLWJvZHlbZGF0YS1lbXB0eT0iMSJdOjpiZWZvcmUgeyB0b3A6IDJweDsgbGVmdDogNHB4OyB9Ci5zY3JhdGNoLXRpbGUgLm5lLWxpbmtiYXIsIC5zY3JhdGNoLXRpbGUgLm5lLXRhYmxlYmFyIHsgbWF",
"yZ2luOiAwIDAgNnB4OyB9Ci5zY3JhdGNoLXRpbGUgLm5lLWxpbmtiYXIgLnRleHQtaW5wdXQgeyBtaW4td2lkdGg6IDA7IH0KLnN1bmRheSAuZGF5LWhlYWQsIC5zdW5kYXkgLmRheS1oZWFkIC5kbmFtZSwgLm1jZWxsLnN1bmRheTpub3QoLnRvZGF5KSAubWRheSwgLmFkYXkuc3VuZGF5IC5hZGF5LWRhdGUgeyBjb2xvcjogdmFyKC0tYy1yZWQpOyB9Ci5iYWRnZSB7IHBhZGRpbmc6IDFweCA3cHg7IGJvcmRlci1yYWRpdXM6IDlweDsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7IGZvbnQtc2l6ZTogMTFweDsgZm9udC13ZWlnaHQ6IDUwMDsgfQouZGF5LnBhc3QgLml0ZW0geyBvcGFjaXR5OiAuNzg7IH0KLm1pbmktdGlsZSB7IGRpc3BsYXk6IG5vbmU7IH0KLmxvYWRpbmcgLmNhbC1pdGVtczo6YmVmb3JlLAouY2FsLWFnZW5kYS5sb2FkaW5nOjpiZWZvcmUgewogIGNvbnRlbnQ6ICIiOwogIGRpc3BsYXk6IGJsb2NrOwogIGhlaWdodDogMjJweDsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOwogIGFuaW1hdGlvbjogY2FsLXB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGUgYWx0ZXJuYXRlOwp9CkBrZXlmcmFtZXMgY2FsLXB1bHNlIHsgZnJvbSB7IG9wYWNpdHk6IC40OyB9IHRvIHsgb3BhY2l0eTogMTsgfSB9CgovKiBFdmVudHMgYW5kIHRhc2tzICovCi5jYWwtaXRlbXMgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGl",
"vbjogY29sdW1uOyBnYXA6IDRweDsgbWluLXdpZHRoOiAwOyB9Ci5pdGVtIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgbWluLXdpZHRoOiAwOwogIGJvcmRlci1yYWRpdXM6IDZweDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtc2l6ZTogMTIuNXB4OwogIGxpbmUtaGVpZ2h0OiAxLjM7CiAgdGV4dC1kZWNvcmF0aW9uOiBub25lOwp9CmEuaXRlbTpob3ZlciB7IGJhY2tncm91bmQtaW1hZ2U6IGxpbmVhci1ncmFkaWVudCh2YXIoLS1ob3ZlciksIHZhcigtLWhvdmVyKSk7IH0KLml0ZW0gLnQgeyBtaW4td2lkdGg6IDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9Ci5ldiB7CiAgcGFkZGluZzogM3B4IDZweDsKICBib3JkZXItbGVmdDogM3B4IHNvbGlkIHZhcigtLWMsIHZhcigtLWFjY2VudCkpOwogIGJhY2tncm91bmQtY29sb3I6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jLCB2YXIoLS1hY2NlbnQpKSAxNCUsIHZhcigtLXN1cmZhY2UpKTsKfQouZXYuYWxsLWRheSB7IGJhY2tncm91bmQtY29sb3I6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jLCB2YXIoLS1hY2NlbnQpKSAzMiUsIHZhcigtLXN1cmZhY2UpKTsgfQouZXYgLnRpbWUgeyBmbGV4OiBub25lOyBjb2xvcjogdmFyKC0tZmctMik7IGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7IH0KLyogSW4gYSBkYXk",
"ncyBjb2x1bW4gb3IgdGlsZSwgYSB0aXRsZSBnZXRzIHR3byBsaW5lcyBiZWZvcmUgaXQgaXMgY3V0LAogICBhbmQgZ29lcyB1bmRlciBpdHMgdGltZSB3aGVuIHRoZSB0d28gd2lsbCBub3QgZml0IHNpZGUgYnkgc2lkZS4gKi8KLmNhbC13ZWVrIC5pdGVtIHsgYWxpZ24taXRlbXM6IGZsZXgtc3RhcnQ7IH0KLmNhbC13ZWVrIC5ldiB7IGZsZXgtd3JhcDogd3JhcDsgcm93LWdhcDogMDsgfQouY2FsLXdlZWsgLmV2IC50IHsgZmxleDogMSAxIDYuNWVtOyB9Ci5jYWwtd2VlayAuaXRlbSAudCwgLmNhbC10cmF5IC5pdGVtIC50IHsKICBkaXNwbGF5OiAtd2Via2l0LWJveDsKICAtd2Via2l0LWJveC1vcmllbnQ6IHZlcnRpY2FsOwogIC13ZWJraXQtbGluZS1jbGFtcDogMjsKICB3aGl0ZS1zcGFjZTogbm9ybWFsOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9Ci5jYWwtd2VlayAudGFzayAuYm94LCAuY2FsLXRyYXkgLnRhc2sgLmJveCB7IG1hcmdpbi10b3A6IDFweDsgfQoudGFzayB7IHBhZGRpbmc6IDJweCA0cHg7IH0KLnRhc2sgLmJveCB7CiAgZmxleDogbm9uZTsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIHdpZHRoOiAxNHB4OwogIGhlaWdodDogMTRweDsKICBib3JkZXI6IDEuNnB4IHNvbGlkIHZhcigtLWZnLTIpOwogIGJvcmRlci1yYWRpdXM6IDRweDsKfQoudGFzay5kb25lIC5ib3ggeyBiYWNrZ3JvdW5kOiB2YXI",
"oLS1hY2NlbnQpOyBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQpOyB9Ci50YXNrLmRvbmUgLnQgeyBjb2xvcjogdmFyKC0tZmctMyk7IHRleHQtZGVjb3JhdGlvbjogbGluZS10aHJvdWdoOyB9Ci50YXNrIC5kdWUgeyBmbGV4OiBub25lOyBtYXJnaW4tbGVmdDogYXV0bzsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTEuNXB4OyB9Ci50YXNrIC5tYWlsIHsgZmxleDogbm9uZTsgZGlzcGxheTogaW5saW5lLWZsZXg7IG1hcmdpbi1sZWZ0OiBhdXRvOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQoudGFzayAuZHVlICsgLm1haWwgeyBtYXJnaW4tbGVmdDogNHB4OyB9CgovKiBNb250aCAqLwouY2FsLW1vbnRoIHsgZmxleDogMTsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgbWluLWhlaWdodDogMDsgfQoubW9udGgtZG93cyB7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDcsIG1pbm1heCgwLCAxZnIpKTsgZ2FwOiA2cHg7IHBhZGRpbmctYm90dG9tOiA0cHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxMnB4OyB0ZXh0LWFsaWduOiBjZW50ZXI7IH0KLm1vbnRoLWdyaWQgewogIGZsZXg6IDE7CiAgZGlzcGxheTogZ3JpZDsKICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg3LCBtaW5tYXgoMCwgMWZyKSk7CiAgZ3JpZC10ZW1wbGF0ZS1yb3dzOiByZXBlYXQodmFyKC0tcm93cyw",
"gNSksIG1pbm1heCgwLCAxZnIpKTsKICBnYXA6IDZweDsKICBtaW4taGVpZ2h0OiAwOwp9Ci5tY2VsbCB7CiAgbWluLXdpZHRoOiAwOwogIG1pbi1oZWlnaHQ6IDA7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiAycHg7CiAgcGFkZGluZzogNHB4IDZweCA2cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5tY2VsbC5vdGhlciB7IG9wYWNpdHk6IC41NTsgfQoubWNlbGwudG9kYXkgeyBwYWRkaW5nOiAzcHggNXB4IDVweDsgYm9yZGVyOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsgfQoubWRheSB7IGFsaWduLXNlbGY6IGZsZXgtc3RhcnQ7IG1pbi13aWR0aDogMjRweDsgaGVpZ2h0OiAyNHB4OyBwYWRkaW5nOiAwIDZweDsgYm9yZGVyLXJhZGl1czogMTJweDsgZm9udC1zaXplOiAxMi41cHg7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLm1kYXk6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLm1jZWxsLnRvZGF5IC5tZGF5IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7IH0KLml0ZW0uY29tcGFjdCB7IGZvbnQtc2l6ZTogMTJweDsgfQouZXYuY29tcGFjdCB7IHBhZGRpbmc6IDFweCA1cHg7IH0KLm1vcmUgeyBhbGlnbi1zZWxmOiBmbGV4LXN0YXJ0OyBwYWRkaW5",
"nOiAxcHggNnB4OyBib3JkZXItcmFkaXVzOiA2cHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZm9udC1zaXplOiAxMnB4OyB9Ci5tb3JlOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9CgovKiBBZ2VuZGEgKi8KLmNhbC1hZ2VuZGEgeyBmbGV4OiAxOyBtaW4taGVpZ2h0OiAwOyBvdmVyZmxvdy15OiBhdXRvOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDhweDsgbWF4LXdpZHRoOiA4ODBweDsgfQouYWRheSB7IGZsZXg6IG5vbmU7IGRpc3BsYXk6IGZsZXg7IGdhcDogMTZweDsgcGFkZGluZzogMTBweCAxNHB4OyBib3JkZXItcmFkaXVzOiAxNHB4OyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsgfQouYWRheS50b2RheSB7IHBhZGRpbmc6IDlweCAxM3B4OyBib3JkZXI6IDJweCBzb2xpZCB2YXIoLS1hY2NlbnQpOyB9Ci5hZGF5LWRhdGUgeyBmbGV4OiBub25lOyB3aWR0aDogODRweDsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLmFkYXktZGF0ZSAuZG51bSB7IG1pbi13aWR0aDogMS40ZW07IGZvbnQtc2l6ZTogMjRweDsgbGluZS1oZWlnaHQ6IDE7IHRleHQtYWxpZ246IHJpZ2h0OyB9Ci5hZGF5LWRhdGUgLmRuYW1lIHsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZm9udC1zaXplOiAxMnB4OyBsaW5lLWhlaWd",
"odDogMS4yNTsgfQouYWRheS1kYXRlIC5tb24geyBvcGFjaXR5OiAuNzsgfQouYWRheSAuY2FsLWl0ZW1zIHsgZmxleDogMTsgZ2FwOiA0cHg7IGp1c3RpZnktY29udGVudDogY2VudGVyOyB9Ci5hZGF5IC5pdGVtIHsgZm9udC1zaXplOiAxMy41cHg7IH0KLyogVGhlIGFnZW5kYSBpcyBhIGxpc3Q6IGEgZG90IG9mIHRoZSBjYWxlbmRhcidzIGNvbG91ciwgbm90IGEgYmxvY2suICovCi5hZGF5IC5ldiB7IHBhZGRpbmc6IDNweCA2cHg7IGJvcmRlci1sZWZ0OiAwOyBiYWNrZ3JvdW5kOiBub25lOyB9Ci5hZGF5IC5ldjo6YmVmb3JlIHsgY29udGVudDogIiI7IGZsZXg6IG5vbmU7IHdpZHRoOiAxMHB4OyBoZWlnaHQ6IDEwcHg7IG1hcmdpbi1yaWdodDogNHB4OyBib3JkZXItcmFkaXVzOiA1MCU7IGJhY2tncm91bmQ6IHZhcigtLWMsIHZhcigtLWFjY2VudCkpOyB9Ci5hZGF5IC5ldiAudGltZSB7IG1pbi13aWR0aDogNy41ZW07IH0KLmFkYXkgLnRhc2sgeyBwYWRkaW5nLWxlZnQ6IDRweDsgfQouYWRheSAudGFzayAubWFpbCwgLmFkYXkgLnRhc2sgLmR1ZSB7IG1hcmdpbi1sZWZ0OiA2cHg7IH0KLmVtcHR5IHsgbWFyZ2luOiAwOyBjb2xvcjogdmFyKC0tZmctMyk7IGZvbnQtc2l6ZTogMTNweDsgfQouY2FsLWFnZW5kYSA-IC5lbXB0eSB7IG1hcmdpbjogMjRweCBhdXRvOyB9CgovKiBOYXJyb3c6IGEgcGhvbmUsIG9yIGEgbmFycm93IHdpbmRvdyAqLwouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0geyBwYWRkaW5nOiAwIDE",
"ycHggMTZweDsgb3ZlcmZsb3cteTogYXV0bzsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC12aWV3cyB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtaGVhZCB7IGhlaWdodDogNDhweDsgZ2FwOiA0cHg7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtdGl0bGUgeyBvcmRlcjogLTE7IG1hcmdpbjogMCA0cHggMCAycHg7IGZvbnQtc2l6ZTogMTYuNXB4OyBmb250LXdlaWdodDogNTAwOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuYnRuLW91dGxpbmUgeyBoZWlnaHQ6IDMycHg7IHBhZGRpbmc6IDAgMTJweDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1ib2R5IHsgZmxleDogbm9uZTsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAxMHB4OyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLXNpZGUgeyBkaXNwbGF5OiBjb250ZW50czsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1taW5pIHsgZGlzcGxheTogbm9uZTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1zb3VyY2VzIHsKICBvcmRlcjogMDsKICBmbGV4LWRpcmVjdGlvbjogcm93OwogIGdhcDogNnB4OwogIHBhZGRpbmc6IDAgMCAycHg7CiAgYm9yZGVyOiAwOwogIGJhY2tncm91bmQ6IG5vbmU7CiAgb3ZlcmZsb3cteDogYXV0bzsKICBzY3JvbGxiYXItd2lkdGg6IG5vbmU7Cn0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5zcmMgewogIGZ",
"sZXg6IG5vbmU7CiAgZ2FwOiA3cHg7CiAgaGVpZ2h0OiAzMnB4OwogIHBhZGRpbmc6IDAgMTJweCAwIDEwcHg7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBmb250LXNpemU6IDEzcHg7Cn0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5zcmMgLnN3YXRjaCB7IHdpZHRoOiAxMHB4OyBoZWlnaHQ6IDEwcHg7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtbWFpbiB7IG9yZGVyOiAxOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLXRyYXkgeyBvcmRlcjogMjsgYm9yZGVyLXN0eWxlOiBkYXNoZWQ7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtd2VlayB7CiAgZmxleDogbm9uZTsKICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCgyLCBtaW5tYXgoMCwgMWZyKSk7CiAgZ3JpZC10ZW1wbGF0ZS1yb3dzOiByZXBlYXQoNCwgYXV0byk7CiAgZ3JpZC1hdXRvLWZsb3c6IGNvbHVtbjsKfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl1bZGF0YS1vcmRlcj0iYWNyb3NzIl0gLmNhbC13ZWVrIHsgZ3JpZC10ZW1wbGF0ZS1yb3dzOiBub25lOyBncmlkLWF1dG8tZmxvdzogcm93OyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuZGF5IHsgbWluLWhlaWdodDogMTIwcHg7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtd2VlayAuZGF5IC5jYWwtaXRlbXM",
"geyBvdmVyZmxvdzogdmlzaWJsZTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLm1pbmktdGlsZSB7IGRpc3BsYXk6IGZsZXg7IH0KLm1pbmktdGlsZSAubWluaS1oZWFkIHsgbWFyZ2luLWJvdHRvbTogMnB4OyB9Ci5taW5pLXRpbGUgLm1pbmktZGF5IHsgaGVpZ2h0OiAyMHB4OyBmb250LXNpemU6IDExcHg7IH0KLm1pbmktdGlsZSAubWluaS1kb3cgeyBmb250LXNpemU6IDEwcHg7IHBhZGRpbmc6IDA7IH0KCi5jYWwuY2FsLXBhbmVsIC5jYWwtc2lkZSB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhbC1tYWluID4gLnBhbmVsIHsgbWFyZ2luOiBhdXRvOyB9CmA7CgogIC8vIOKUgOKUgCBEb2NrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBET0NLID0gYAo6aG9zdCB7IHotaW5kZXg6IDIxNDc0ODI5OTkgIWltcG9ydGFudDsgfQoKLmRvY2sgewogIHBvc2l0aW9uOiBmaXhlZDsKICBsZWZ0OiAxNnB4OwogIGJvdHRvbTogMTZweDsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwogIGZvbnQtc2l6ZTogMTRweDsKICAtd2Via2l0LWZ",
"vbnQtc21vb3RoaW5nOiBhbnRpYWxpYXNlZDsKfQouZG9jay5yaWdodCB7IGxlZnQ6IGF1dG87IHJpZ2h0OiA3MnB4OyB9Ci5kb2NrW2hpZGRlbl0geyBkaXNwbGF5OiBub25lOyB9Ci5waWxsIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNnB4OwogIGhlaWdodDogNDBweDsKICBwYWRkaW5nOiAwIDE2cHggMCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDIwcHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgY29sb3I6IHZhcigtLWZnKTsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMik7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIG1heC13aWR0aDogMzIwcHg7Cn0KLnBpbGw6aG92ZXIgeyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMyk7IGJhY2tncm91bmQtaW1hZ2U6IGxpbmVhci1ncmFkaWVudCh2YXIoLS1ob3ZlciksIHZhcigtLWhvdmVyKSk7IH0KLnBpbGwgLmljb24geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQoucGlsbC5vbiB7IGJhY2tncm91bmQtY29sb3I6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsgfQoucGlsbC5vbiAuaWNvbiB7IGNvbG9yOiBpbmhlcml0OyB9Ci5waWxsIC5waWxsLWxhYmVsIHsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IH0KLnBpbGwgLmNhcmV0IHsgbWFyZ2luOiAwIC02cHggMCAtMnB4OyBjb2x",
"vcjogaW5oZXJpdDsgfQoucGlsbC1jb21wYWN0IHsgcGFkZGluZzogMCAxNHB4IDAgMTBweDsgfQoucGlsbC5idXN5IHsgb3BhY2l0eTogLjc7IH0KYDsKCiAgbnMuc3R5bGVzID0geyBib2FyZDogQkFTRSArIEJPQVJEICsgQ0FMRU5EQVIsIGRvY2s6IEJBU0UgKyBET0NLIH07Cn0pKCk7Cg\"],[\"src/content/note-editor.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBmb3JtYXR0ZWQgbm90ZSBlZGl0b3IKLy8KLy8gQW4gZWRpdGFibGUgYXJlYSB3aXRoIGEgdG9vbGJhcjogdGV4dCBzdHlsZSAobm9ybWFsLCB0aHJlZSBoZWFkaW5ncyksCi8vIGJvbGQsIGl0YWxpYywgc3RyaWtlLXRocm91Z2gsIGJ1bGxldGVkLCBudW1iZXJlZCBhbmQgY2hlY2sgbGlzdHMgd2l0aAovLyB0aHJlZSBsZXZlbHMgb2YgbmVzdGluZywgdGFibGVzLCBsaW5rcywgYW5kIGNsZWFyIGZvcm1hdHRpbmcuCi8vCi8vIFRoZSBlZGl0YWJsZSBhcmVhIGlzIGEgZmxhdCBjb2x1bW4gb2YgYmxvY2tzIC0gb25lIDxkaXYgY2xhc3M9ImJsayI-Ci8vIHBlciBwYXJhZ3JhcGgsIGhlYWRpbmcgb3IgbGl",
"zdCBpdGVtLCBpdHMga2luZCBhbmQgaW5kZW50IGluIGRhdGEKLy8gYXR0cmlidXRlcywgYnVsbGV0cywgbnVtYmVycyBhbmQgYm94ZXMgZHJhd24gYnkgdGhlIHN0eWxlc2hlZXQuIEJvbGQsCi8vIGl0YWxpYywgc3RyaWtlLXRocm91Z2ggYW5kIGxpbmtzIHVzZSB0aGUgYnJvd3NlcidzIG93biBlZGl0aW5nCi8vIGNvbW1hbmRzLCB3aGljaCBoYW5kbGUgdGhlbSB3ZWxsLiBMaXN0cyBhbmQgaGVhZGluZ3MgZG8gbm90IHVzZSB0aGVtOgovLyB0aGUgYnJvd3NlcidzIGxpc3QgY29tbWFuZHMgbmVzdCBlbGVtZW50cyBpbiB3YXlzIHRoYXQgYXJlIGhhcmQgdG8gcmVhZAovLyBiYWNrLCBzbyBibG9ja3MgYXJlIHJlc3R5bGVkIGhlcmUgZGlyZWN0bHkgaW5zdGVhZC4gV2hhdCBpcyBzYXZlZCBpcwovLyBuZXZlciB0aGlzIG1hcmt1cDogaXQgaXMgcmVhZCBiYWNrIGludG8gdGhlIG5vdGUtZm9ybWF0IG1vZGVsLCB3aGljaAovLyBvbmx5IGtub3dzIHdoYXQgdGhlIHRvb2xiYXIgY2FuIG1ha2UuCi8vCi8vIFBhc3RlZCB0ZXh0IGtlZXBzIHRoZSBmb3JtYXR0aW5nIHRoZSBtb2RlbCBjYW4gaG9sZCAtIGZyb20gV29yZCwgR29vZ2xlCi8vIERvY3MsIGEgd2ViIHBhZ2UsIGFuIGVtYWlsLCBFeGNlbCwgb3IgTWFya2Rvd24gZnJvbSBhIGNoYXQgYXNzaXN0YW50IC0KLy8gcmVhZCBieSBub3RlLWZvcm1hdCdzIG93biByZWFkZXIsIHNvIGEgcGFnZSBjb3BpZWQgZnJvbSB0aGUgd2ViIGJyaW5ncwovLyBpdHMgYm9sZCBhbmQ",
"gbGlzdHMgYnV0IG5ldmVyIGl0cyBzdHlsZXMsIGltYWdlcyBvciBzY3JpcHRzLiBDdHJsK1NoaWZ0K1YKLy8gcGFzdGVzIHRoZSB0ZXh0IGFsb25lLiBEcm9wcGVkIHRleHQgaXMgbm90IHRha2VuIGF0IGFsbC4KLy8KLy8gQSB0YWJsZSBpcyBhbiBpc2xhbmQgdGhlIHRleHQgY2Fubm90IHJ1biBpbnRvOiBpdHMgYmxvY2sgaXMgbm90Ci8vIGVkaXRhYmxlLCBlYWNoIG9mIGl0cyBjZWxscyBpcywgb24gaXRzIG93biwgc28gdHlwaW5nLCBkZWxldGluZyBhbmQKLy8gcGFzdGluZyBjYW4gbmV2ZXIgYnJlYWsgdGhlIGdyaWQuIFRhYiBtb3ZlcyBmcm9tIGNlbGwgdG8gY2VsbCAoYW5kCi8vIGFkZHMgYSByb3cgYXQgdGhlIGVuZCksIHRoZSBhcnJvdyBrZXlzIGxlYXZlIGEgY2VsbCBhdCBpdHMgZWRnZXMsIGFuZAovLyB0aGUgdGFibGUgYmFyIC0gc2hvd24gd2hpbGUgdGhlIGN1cnNvciBpcyBpbiBhIGNlbGwgLSBhZGRzLCByZW1vdmVzLAovLyBhbGlnbnMgYW5kIHNvcnRzLiBDZWxscyBjb3BpZWQgZnJvbSBhIHNwcmVhZHNoZWV0IGFuZCBwYXN0ZWQgaW50byBhCi8vIGNlbGwgZmlsbCB0aGUgY2VsbHMgZnJvbSB0aGVyZSwgYXMgaW4gYSBzcHJlYWRzaGVldC4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLCBvcGVuTWVudSwgY2xvc2VNZW51IH0gPSBucy51aTsKICBjb25zdCBmbXQgPSBucy5ub3RlRm9ybWF0OwogIGNvbnN0IE5FV19UQUJMRSA9IHsgY29sczogMywgcm93czogMyB9OwoKICBjb25zdCBTVFlMRVMgPSBbWydwJywgJ05vcm1hbCB0ZXh0J10sIFsnaDEnLCAnSGVhZGluZyAxJ10sIFsnaDInLCAnSGVhZGluZyAyJ10sIFsnaDMnLCAnSGVhZGluZyAzJ11dOwogIGNvbnN0IFNUWUxFX0xBQkVMID0gT2JqZWN0LmZyb21FbnRyaWVzKFNUWUxFUyk7CiAgY29uc3QgSU5ERU5UX1BYID0gMjQ7CgogIC8vIFR5cGVkIGF0IHRoZSBzdGFydCBvZiBhIHBhcmFncmFwaCBhbmQgZm9sbG93ZWQgYnkgYSBzcGFjZSwgdGhlc2UgdHVybgogIC8vIGl0IGludG8gYSBsaXN0IG9yIGhlYWRpbmcgLSB0aGUgc2hvcnRjdXRzIG1vc3QgZWRpdG9ycyBzaGFyZS4KICBjb25zdCBBVVRPID0gWwogICAgWy9eWy0q4oCiXSQvLCB7IHR5cGU6ICd1bCcgfV0sCiAgICBbL14xWy4pXSQvLCB7IHR5cGU6ICdvbCcgfV0sCiAgICBbL15cWyA_XF0kLywgeyB0eXBlOiAnY2hlY2snIH1dLAogICAgWy9eXFtbeFhdXF0kLywgeyB0eXBlOiAnY2hlY2s",
"nLCBjaGVja2VkOiB0cnVlIH1dLAogICAgWy9eIyQvLCB7IHR5cGU6ICdoMScgfV0sCiAgICBbL14jIyQvLCB7IHR5cGU6ICdoMicgfV0sCiAgICBbL14jIyMkLywgeyB0eXBlOiAnaDMnIH1dLAogIF07CgogIC8vIOKUgOKUgCBNb2RlbCDihpQgbWFya3VwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBzZXRCbG9jayhlbCwgdHlwZSwgbGV2ZWwgPSAwLCBjaGVja2VkID0gZmFsc2UpIHsKICAgIGVsLmRhdGFzZXQudHlwZSA9IHR5cGU7CiAgICBpZiAoZm10LkxJU1RTLmhhcyh0eXBlKSkgZWwuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsZXZlbCk7CiAgICBlbHNlIGRlbGV0ZSBlbC5kYXRhc2V0LmxldmVsOwogICAgaWYgKHR5cGUgPT09ICdjaGVjaycpIGVsLmRhdGFzZXQuY2hlY2tlZCA9IGNoZWNrZWQgPyAnMScgOiAnMCc7CiAgICBlbHNlIGRlbGV0ZSBlbC5kYXRhc2V0LmNoZWNrZWQ7CiAgfQoKICBmdW5jdGlvbiBpbmxpbmVOb2RlcyhydW5zKSB7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcnVucy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IGhyZWYgPSBydW5zW2ldLmhyZWYgfHwgJyc7CiAgICAgIGNvbnN0IGdyb3VwID0gW107CiA",
"gICAgIGxldCBqID0gaTsKICAgICAgd2hpbGUgKGogPCBydW5zLmxlbmd0aCAmJiAocnVuc1tqXS5ocmVmIHx8ICcnKSA9PT0gaHJlZikgewogICAgICAgIGxldCBub2RlID0gZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUocnVuc1tqXS50ZXh0KTsKICAgICAgICBmb3IgKGNvbnN0IG0gb2YgWydzJywgJ2knLCAnYiddKSB7CiAgICAgICAgICBpZiAoIXJ1bnNbal1bbV0pIGNvbnRpbnVlOwogICAgICAgICAgY29uc3QgdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQobSk7CiAgICAgICAgICB3LmFwcGVuZENoaWxkKG5vZGUpOwogICAgICAgICAgbm9kZSA9IHc7CiAgICAgICAgfQogICAgICAgIGdyb3VwLnB1c2gobm9kZSk7CiAgICAgICAgaisrOwogICAgICB9CiAgICAgIGlmIChocmVmKSBvdXQucHVzaChoKCdhJywgeyBocmVmLCB0aXRsZTogaHJlZiB9LCBncm91cCkpOwogICAgICBlbHNlIG91dC5wdXNoKC4uLmdyb3VwKTsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gTGluZSBicmVha3MgaW4gYSBjZWxsJ3MgdGV4dCBhcyA8YnI-czsgYSBjZWxsIGVuZGluZyBpbiBvbmUgZ2V0cyBhCiAgLy8gc2Vjb25kLCBvciB0aGUgYnJvd3NlciB3b3VsZCBub3Qgc2hvdyB0aGUgZW1wdHkgbGluZS4KICBmdW5jdGlvbiBicmVha0xpbmVzKGVsKSB7CiAgICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKGVsLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7CiAgICBjb25zdCB",
"mb3VuZCA9IFtdOwogICAgZm9yIChsZXQgbiA9IHdhbGtlci5uZXh0Tm9kZSgpOyBuOyBuID0gd2Fsa2VyLm5leHROb2RlKCkpIGlmIChuLmRhdGEuaW5jbHVkZXMoJ1xuJykpIGZvdW5kLnB1c2gobik7CiAgICBmb3IgKGNvbnN0IG4gb2YgZm91bmQpIHsKICAgICAgY29uc3QgcGFydHMgPSBbXTsKICAgICAgbi5kYXRhLnNwbGl0KCdcbicpLmZvckVhY2goKHBpZWNlLCBpKSA9PiB7CiAgICAgICAgaWYgKGkpIHBhcnRzLnB1c2goZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnInKSk7CiAgICAgICAgaWYgKHBpZWNlKSBwYXJ0cy5wdXNoKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHBpZWNlKSk7CiAgICAgIH0pOwogICAgICBuLnJlcGxhY2VXaXRoKC4uLnBhcnRzKTsKICAgIH0KICAgIGlmIChlbC5sYXN0Q2hpbGQgJiYgZWwubGFzdENoaWxkLm5vZGVOYW1lID09PSAnQlInKSBlbC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdicicpKTsKICB9CgogIGZ1bmN0aW9uIGZpbGxDZWxsKHRkLCBydW5zKSB7CiAgICB0ZC5yZXBsYWNlQ2hpbGRyZW4oLi4uaW5saW5lTm9kZXMocnVucyB8fCBbXSkpOwogICAgYnJlYWtMaW5lcyh0ZCk7CiAgICBpZiAoIXRkLmZpcnN0Q2hpbGQpIHRkLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2JyJykpOwogIH0KCiAgZnVuY3Rpb24gY2VsbEVsKHJ1bnMsIGFsaWduKSB7CiAgICBjb25zdCB0ZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RkJyk7CiA",
"gICB0ZC5jb250ZW50RWRpdGFibGUgPSAndHJ1ZSc7CiAgICBpZiAoYWxpZ24pIHRkLnN0eWxlLnRleHRBbGlnbiA9IGFsaWduOwogICAgZmlsbENlbGwodGQsIHJ1bnMpOwogICAgcmV0dXJuIHRkOwogIH0KCiAgZnVuY3Rpb24gdGFibGVFbChiKSB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgZWwuY2xhc3NOYW1lID0gJ2Jsayc7CiAgICBlbC5kYXRhc2V0LnR5cGUgPSAndGFibGUnOwogICAgZWwuZGF0YXNldC5oZWFkID0gYi5oZWFkID8gJzEnIDogJzAnOwogICAgZWwuZGF0YXNldC5hbGlnbiA9IGIuYWxpZ24uam9pbignLCcpOwogICAgZWwuY29udGVudEVkaXRhYmxlID0gJ2ZhbHNlJzsKICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd0Ym9keScpOwogICAgZm9yIChjb25zdCByIG9mIGIucm93cykgewogICAgICBjb25zdCB0ciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RyJyk7CiAgICAgIHIuZm9yRWFjaCgoYywgaykgPT4gdHIuYXBwZW5kQ2hpbGQoY2VsbEVsKGMucnVucywgYi5hbGlnbltrXSkpKTsKICAgICAgYm9keS5hcHBlbmRDaGlsZCh0cik7CiAgICB9CiAgICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGFibGUnKTsKICAgIHQuYXBwZW5kQ2hpbGQoYm9keSk7CiAgICBlbC5hcHBlbmRDaGlsZCh0KTsKICAgIHJldHVybiBlbDsKICB9CgogIGZ1bmN0aW9uIGJsb2NrRWwoYikgewogICAgaWYgKGIudHlwZSA",
"9PT0gJ3RhYmxlJykgcmV0dXJuIHRhYmxlRWwoYik7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgZWwuY2xhc3NOYW1lID0gJ2Jsayc7CiAgICBzZXRCbG9jayhlbCwgYi50eXBlLCBiLmxldmVsLCBiLmNoZWNrZWQpOwogICAgY29uc3Qga2lkcyA9IGlubGluZU5vZGVzKGIucnVucyk7CiAgICBpZiAoa2lkcy5sZW5ndGgpIGVsLmFwcGVuZCguLi5raWRzKTsKICAgIGVsc2UgZWwuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnInKSk7CiAgICByZXR1cm4gZWw7CiAgfQoKICBmdW5jdGlvbiBzdHlsZU1hcmtzKHN0eWxlKSB7CiAgICBjb25zdCBzID0gU3RyaW5nKHN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgcmV0dXJuIHsKICAgICAgYjogL2ZvbnQtd2VpZ2h0XHMqOlxzKihib2xkfGJvbGRlcnxbNi05XTAwKS8udGVzdChzKSwKICAgICAgaTogL2ZvbnQtc3R5bGVccyo6XHMqaXRhbGljLy50ZXN0KHMpLAogICAgICBzOiAvdGV4dC1kZWNvcmF0aW9uKC1saW5lKT9ccyo6W147XSpsaW5lLXRocm91Z2gvLnRlc3QocyksCiAgICB9OwogIH0KCiAgY29uc3QgTkVTVEVEX0JMT0NLUyA9IG5ldyBTZXQoWydkaXYnLCAncCcsICdsaScsICd1bCcsICdvbCcsICdoMScsICdoMicsICdoMycsICdoNCcsICdoNScsICdoNicsICdibG9ja3F1b3RlJywgJ3ByZSddKTsKCiAgLy8gVGhlIG1hcmtzIGluc2lkZSBhbiBlbGVtZW50OiB0aG9zZSBhcm91bmQgaXQ",
"sIGFuZCBpdHMgb3duLgogIGZ1bmN0aW9uIG1hcmtzT2YoZWwsIHRhZywgbWFya3MpIHsKICAgIGNvbnN0IG0gPSB7IC4uLm1hcmtzIH07CiAgICBpZiAodGFnID09PSAnYicgfHwgdGFnID09PSAnc3Ryb25nJykgbS5iID0gdHJ1ZTsKICAgIGVsc2UgaWYgKHRhZyA9PT0gJ2knIHx8IHRhZyA9PT0gJ2VtJykgbS5pID0gdHJ1ZTsKICAgIGVsc2UgaWYgKHRhZyA9PT0gJ3MnIHx8IHRhZyA9PT0gJ3N0cmlrZScgfHwgdGFnID09PSAnZGVsJykgbS5zID0gdHJ1ZTsKICAgIGVsc2UgaWYgKHRhZyA9PT0gJ2EnKSB7CiAgICAgIGNvbnN0IGhyZWYgPSBmbXQuc2FmZUhyZWYoZWwuZ2V0QXR0cmlidXRlKCdocmVmJykpOwogICAgICBpZiAoaHJlZikgbS5ocmVmID0gaHJlZjsKICAgIH0gZWxzZSBpZiAodGFnID09PSAnc3BhbicgfHwgdGFnID09PSAnZm9udCcpIHsKICAgICAgY29uc3Qgc3QgPSBzdHlsZU1hcmtzKGVsLmdldEF0dHJpYnV0ZSgnc3R5bGUnKSk7CiAgICAgIGlmIChzdC5iKSBtLmIgPSB0cnVlOwogICAgICBpZiAoc3QuaSkgbS5pID0gdHJ1ZTsKICAgICAgaWYgKHN0LnMpIG0ucyA9IHRydWU7CiAgICB9CiAgICByZXR1cm4gbTsKICB9CgogIC8vIEEgY2VsbCdzIHJ1bnM6IGEgPGJyPiwgb3IgdGhlIHN0YXJ0IG9mIGEgYmxvY2sgdGhlIGJyb3dzZXIgcHV0IGluIGl0LAogIC8vIGlzIGEgbGluZSBicmVhazsgdGhlIG9uZXMgaXQgZW5kcyB3aXRoIGFyZSBpdHMgcGxhY2Vob2xkZXJzLgogIGZ1bmN0aW9uIHJlYWR",
"DZWxsKHRkKSB7CiAgICBjb25zdCBydW5zID0gW107CiAgICBjb25zdCBubCA9ICgpID0-IHsgaWYgKHJ1bnMubGVuZ3RoICYmICEvXG4kLy50ZXN0KHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0KSkgcnVucy5wdXNoKHsgdGV4dDogJ1xuJyB9KTsgfTsKICAgIChmdW5jdGlvbiB3YWxrKG5vZGUsIG1hcmtzKSB7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZE5vZGVzKSB7CiAgICAgICAgLy8gVGhlIGVkaXRvciBrZWVwcyBzcGFjZXMgYW5kIGxpbmUgYnJlYWtzIGFzIHR5cGVkIChwcmUtd3JhcCksIHNvCiAgICAgICAgLy8gQ2hyb21lIHdyaXRlcyBFbnRlciBpbiBhIGNlbGwgYXMgYSBsaW5lIGJyZWFrIGluIHRoZSB0ZXh0IGl0c2VsZi4KICAgICAgICBpZiAoY2hpbGQubm9kZVR5cGUgPT09IDMpIHsKICAgICAgICAgIGlmIChjaGlsZC5kYXRhKSBydW5zLnB1c2goeyB0ZXh0OiBjaGlsZC5kYXRhLnJlcGxhY2UoL1x1MDBhMC9nLCAnICcpLCAuLi5tYXJrcyB9KTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAoY2hpbGQubm9kZVR5cGUgIT09IDEpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IHRhZyA9IGNoaWxkLnRhZ05hbWUudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAodGFnID09PSAnYnInKSB7IHJ1bnMucHVzaCh7IHRleHQ6ICdcbicgfSk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKE5FU1RFRF9CTE9DS1MuaGFzKHRhZykpIHsgbmwoKTsgd2FsayhjaGlsZCw",
"gbWFya3MpOyBubCgpOyBjb250aW51ZTsgfQogICAgICAgIHdhbGsoY2hpbGQsIG1hcmtzT2YoY2hpbGQsIHRhZywgbWFya3MpKTsKICAgICAgfQogICAgfSkodGQsIHt9KTsKICAgIHdoaWxlIChydW5zLmxlbmd0aCAmJiAvXG4kLy50ZXN0KHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0KSkgewogICAgICBjb25zdCBsYXN0ID0gcnVuc1tydW5zLmxlbmd0aCAtIDFdOwogICAgICBsYXN0LnRleHQgPSBsYXN0LnRleHQucmVwbGFjZSgvXG4kLywgJycpOwogICAgICBpZiAoIWxhc3QudGV4dCkgcnVucy5wb3AoKTsKICAgIH0KICAgIHJldHVybiBydW5zOwogIH0KCiAgZnVuY3Rpb24gcmVhZFRhYmxlKGVsKSB7CiAgICBjb25zdCB0ID0gZWwucXVlcnlTZWxlY3RvcigndGFibGUnKTsKICAgIGNvbnN0IHJvd3MgPSB0ID8gWy4uLnQucm93c10ubWFwKHRyID0-IFsuLi50ci5jZWxsc10ubWFwKHRkID0-ICh7IHJ1bnM6IHJlYWRDZWxsKHRkKSB9KSkpIDogW107CiAgICByZXR1cm4gZm10LnRhYmxlKHJvd3MsIHsgaGVhZDogZWwuZGF0YXNldC5oZWFkID09PSAnMScsIGFsaWduOiBTdHJpbmcoZWwuZGF0YXNldC5hbGlnbiB8fCAnJykuc3BsaXQoJywnKSB9KTsKICB9CgogIC8vIFJlYWRzIG9uZSBibG9jayBlbGVtZW50IC0gYW5kIGFueXRoaW5nIHRoZSBicm93c2VyIG1heSBoYXZlIGxlZnQKICAvLyBpbnNpZGUgaXQsIHN1Y2ggYXMgYSA8YnI-IG9yIGEgbmVzdGVkIDxkaXY-IC0gaW50byBtb2RlbCBibG9ja3MuCiAgZnV",
"uY3Rpb24gcmVhZEJsb2NrKGVsLCBvdXQpIHsKICAgIGNvbnN0IHR5cGUgPSBmbXQuVFlQRVMuaGFzKGVsLmRhdGFzZXQudHlwZSkgPyBlbC5kYXRhc2V0LnR5cGUgOiAncCc7CiAgICBjb25zdCBsZXZlbCA9IE51bWJlcihlbC5kYXRhc2V0LmxldmVsKSB8fCAwOwogICAgY29uc3QgZmlyc3QgPSBvdXQubGVuZ3RoOwogICAgbGV0IGN1ciA9IGZtdC5ibG9jayh0eXBlLCBbXSwgeyBsZXZlbCwgY2hlY2tlZDogZWwuZGF0YXNldC5jaGVja2VkID09PSAnMScgfSk7CiAgICBvdXQucHVzaChjdXIpOwogICAgY29uc3QgbmV4dCA9ICgpID0-IHsKICAgICAgY3VyID0gZm10LmJsb2NrKHR5cGUsIFtdLCB7IGxldmVsIH0pOwogICAgICBvdXQucHVzaChjdXIpOwogICAgfTsKICAgIChmdW5jdGlvbiB3YWxrKG5vZGUsIG1hcmtzKSB7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZE5vZGVzKSB7CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlID09PSAzKSB7CiAgICAgICAgICBpZiAoY2hpbGQuZGF0YSkgY3VyLnJ1bnMucHVzaCh7IHRleHQ6IGNoaWxkLmRhdGEucmVwbGFjZSgvXHUwMGEwL2csICcgJykucmVwbGFjZSgvXG4vZywgJyAnKSwgLi4ubWFya3MgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlICE9PSAxKSBjb250aW51ZTsKICAgICAgICBjb25zdCB0YWcgPSBjaGlsZC50YWdOYW1lLnRvTG93ZXJDYXNlKCk7CiAgICAgICAgaWYgKHRhZyA",
"9PT0gJ2JyJykgeyBuZXh0KCk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKE5FU1RFRF9CTE9DS1MuaGFzKHRhZykpIHsKICAgICAgICAgIGlmIChjdXIucnVucy5sZW5ndGgpIG5leHQoKTsKICAgICAgICAgIHdhbGsoY2hpbGQsIG1hcmtzKTsKICAgICAgICAgIG5leHQoKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICB3YWxrKGNoaWxkLCBtYXJrc09mKGNoaWxkLCB0YWcsIG1hcmtzKSk7CiAgICAgIH0KICAgIH0pKGVsLCB7fSk7CiAgICAvLyBBIDxicj4gb3IgbmVzdGVkIGJsb2NrIGF0IHRoZSB2ZXJ5IGVuZCBsZWF2ZXMgYW4gZW1wdHkgYmxvY2sgYmVoaW5kOgogICAgLy8gdGhhdCBpcyB0aGUgYnJvd3NlcidzIHBsYWNlaG9sZGVyLCBub3QgYSBuZXcgbGluZS4KICAgIHdoaWxlIChvdXQubGVuZ3RoIC0gMSA-IGZpcnN0ICYmICFvdXRbb3V0Lmxlbmd0aCAtIDFdLnJ1bnMuc29tZShyID0-IHIudGV4dCkpIG91dC5wb3AoKTsKICB9CgogIGZ1bmN0aW9uIHJlYWREb2MoZWRpdG9yKSB7CiAgICBjb25zdCBibG9ja3MgPSBbXTsKICAgIGZvciAoY29uc3Qgbm9kZSBvZiBlZGl0b3IuY2hpbGROb2RlcykgewogICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiBub2RlLmRhdGFzZXQudHlwZSA9PT0gJ3RhYmxlJykgYmxvY2tzLnB1c2gocmVhZFRhYmxlKG5vZGUpKTsKICAgICAgZWxzZSBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiBub2RlLmNsYXNzTGlzdC5jb250YWlucygnYmxrJyk",
"pIHJlYWRCbG9jayhub2RlLCBibG9ja3MpOwogICAgICBlbHNlIGlmIChub2RlLm5vZGVUeXBlID09PSAzICYmIG5vZGUuZGF0YS50cmltKCkpIGJsb2Nrcy5wdXNoKGZtdC5ibG9jaygncCcsIFt7IHRleHQ6IG5vZGUuZGF0YS5yZXBsYWNlKC_CoC9nLCAnICcpIH1dKSk7CiAgICAgIGVsc2UgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS50YWdOYW1lICE9PSAnQlInKSByZWFkQmxvY2sobm9kZSwgYmxvY2tzKTsKICAgIH0KICAgIHJldHVybiBmbXQubm9ybWFsaXNlRG9jKGJsb2Nrcyk7CiAgfQoKICAvLyDilIDilIAgU2VsZWN0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBjcmVhdGUoeyByb290LCBvbkNoYW5nZSB9KSB7CiAgICBjb25zdCBlbHMgPSB7fTsKICAgIGxldCBzYXZlZCA9IG51bGw7ICAgICAvLyB0aGUgbGFzdCBzZWxlY3Rpb24gaW5zaWRlIHRoZSBlZGl0b3IKICAgIGxldCBlZGl0YWJsZSA9IGZhbHNlOwogICAgbGV0IHBsYWluTmV4dCA9IGZhbHNlOyAvLyBDdHJsK1NoaWZ0K1Y6IHRoZSBuZXh0IHBhc3RlIGlzIHRleHQgYWxvbmUKICAgIGxldCBwYXN0ZVVuZG8gPSBbXTsgICAgLy8gaG93IHRoZSB0ZXh0IHd",
"hcyBiZWZvcmUgZWFjaCBmb3JtYXR0ZWQgcGFzdGUsIGxhdGVzdCBsYXN0CgogICAgY29uc3Qgc2VsZWN0aW9uID0gKCkgPT4gKHJvb3QuZ2V0U2VsZWN0aW9uID8gcm9vdC5nZXRTZWxlY3Rpb24oKSA6IGRvY3VtZW50LmdldFNlbGVjdGlvbigpKTsKCiAgICBmdW5jdGlvbiByYW5nZSgpIHsKICAgICAgY29uc3Qgc2VsID0gc2VsZWN0aW9uKCk7CiAgICAgIGlmICghc2VsIHx8ICFzZWwucmFuZ2VDb3VudCkgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHIgPSBzZWwuZ2V0UmFuZ2VBdCgwKTsKICAgICAgcmV0dXJuIGVscy5lZGl0b3IuY29udGFpbnMoci5zdGFydENvbnRhaW5lcikgJiYgZWxzLmVkaXRvci5jb250YWlucyhyLmVuZENvbnRhaW5lcikgPyByIDogbnVsbDsKICAgIH0KCiAgICBmdW5jdGlvbiBzZWxlY3QocikgewogICAgICBjb25zdCBzZWwgPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7CiAgICAgIHNlbC5yZW1vdmVBbGxSYW5nZXMoKTsKICAgICAgc2VsLmFkZFJhbmdlKHIpOwogICAgfQoKICAgIC8vIFRvb2xiYXIgYnV0dG9ucyBkbyBub3QgdGFrZSBmb2N1cyBmcm9tIHRoZSB0ZXh0LCBidXQgdGhlIHN0eWxlIG1lbnUKICAgIC8vIGFuZCB0aGUgbGluayBmaWVsZCBkbzsgdGhlIHNlbGVjdGlvbiB0aGV5IHdlcmUgb3BlbmVkIG9uIGlzIHB1dAogICAgLy8gYmFjayBiZWZvcmUgdGhlIGNoYW5nZSBpcyBhcHBsaWVkLgogICAgZnVuY3Rpb24gcmVzdG9yZSgpIHsKICAgICAgLy8gVGhlIHNlbGVjdGlvbiB",
"jYW4gc3RpbGwgYmUgaW4gdGhlIHRleHQgd2hpbGUgdGhlIGZvY3VzIGlzIG5vdCAtCiAgICAgIC8vIG9uIHRoZSBzdHlsZSBidXR0b24gdGhlIG1lbnUgaGFuZGVkIGl0IGJhY2sgdG8sIHNheSAtIGFuZCB0eXBpbmcKICAgICAgLy8gd291bGQgdGhlbiBnbyBub3doZXJlLiBCb3RoIGFyZSBwdXQgYmFjay4KICAgICAgY29uc3Qga2VlcCA9IHJhbmdlKCkgfHwgKHNhdmVkICYmIGVscy5lZGl0b3IuY29udGFpbnMoc2F2ZWQuc3RhcnRDb250YWluZXIpID8gc2F2ZWQgOiBudWxsKTsKICAgICAgLy8gSW4gYSB0YWJsZSwgdGhlIGNlbGwgaXMgd2hhdCB0YWtlcyB0eXBpbmcuCiAgICAgIGNvbnN0IGhvc3QgPSAoa2VlcCAmJiBjZWxsT2Yoa2VlcC5zdGFydENvbnRhaW5lcikpIHx8IGVscy5lZGl0b3I7CiAgICAgIGlmIChyb290LmFjdGl2ZUVsZW1lbnQgIT09IGhvc3QpIGhvc3QuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBpZiAoa2VlcCkgewogICAgICAgIHRyeSB7IHNlbGVjdChrZWVwLmNsb25lUmFuZ2UgPyBrZWVwLmNsb25lUmFuZ2UoKSA6IGtlZXApOyB9IGNhdGNoIHsgLyogdGhlIHRleHQgY2hhbmdlZCB1bmRlcm5lYXRoICovIH0KICAgICAgfQogICAgfQoKICAgIGZ1bmN0aW9uIGJsb2NrT2Yobm9kZSkgewogICAgICBsZXQgbiA9IG5vZGU7CiAgICAgIGlmIChuID09PSBlbHMuZWRpdG9yKSByZXR1cm4gbnVsbDsKICAgICAgd2hpbGUgKG4gJiYgbi5wYXJlbnROb2RlICE9PSBlbHMuZWR",
"pdG9yKSBuID0gbi5wYXJlbnROb2RlOwogICAgICByZXR1cm4gbiAmJiBuLm5vZGVUeXBlID09PSAxID8gbiA6IG51bGw7CiAgICB9CgogICAgLy8g4pSA4pSAIFRhYmxlIGNlbGxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGZ1bmN0aW9uIGNlbGxPZihub2RlKSB7CiAgICAgIGZvciAobGV0IG4gPSBub2RlOyBuICYmIG4gIT09IGVscy5lZGl0b3I7IG4gPSBuLnBhcmVudE5vZGUpIHsKICAgICAgICBpZiAobi5ub2RlVHlwZSA9PT0gMSAmJiBuLnRhZ05hbWUgPT09ICdURCcpIHJldHVybiBuOwogICAgICB9CiAgICAgIHJldHVybiBudWxsOwogICAgfQogICAgY29uc3QgdGFibGVPZiA9IHRkID0-IHRkLmNsb3Nlc3QoJy5ibGtbZGF0YS10eXBlPSJ0YWJsZSJdJyk7CiAgICBjb25zdCBhbGlnbnMgPSBlbCA9PiB7CiAgICAgIGNvbnN0IGNvbHMgPSBlbC5xdWVyeVNlbGVjdG9yKCd0cicpID8gZWwucXVlcnlTZWxlY3RvcigndHInKS5jZWxscy5sZW5ndGggOiAwOwogICAgICBjb25zdCBhID0gU3RyaW5nKGVsLmRhdGFzZXQuYWxpZ24gfHwgJycpLnNwbGl0KCcsJyk7CiAgICAgIHJldHVybiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBjb2xzIH0sIChfLCBrKSA9PiBhW2tdIHx8ICc",
"nKTsKICAgIH07CiAgICBsZXQgbGFzdENlbGwgPSBudWxsOyAvLyB0aGUgY2VsbCBsYXN0IHR5cGVkIGluLCBmb3IgdGhlIHRhYmxlIGJhcidzIG1lbnVzCgogICAgLy8gVGhlIGN1cnNvciBpbnRvIGFuIGVsZW1lbnQ6IGl0cyBzdGFydCwgb3IgaXRzIGVuZCAtIGJlZm9yZSB0aGUgPGJyPgogICAgLy8gdGhhdCBvbmx5IGhvbGRzIGFuIGVtcHR5IGxpbmUgb3Blbi4KICAgIGZ1bmN0aW9uIGNhcmV0SW50byhlbCwgYXRFbmQpIHsKICAgICAgY29uc3QgciA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIGNvbnN0IGtpZHMgPSBlbC5jaGlsZE5vZGVzOwogICAgICBpZiAoIWF0RW5kIHx8ICFraWRzLmxlbmd0aCkgci5zZXRTdGFydChlbCwgMCk7CiAgICAgIGVsc2UgaWYgKGtpZHNba2lkcy5sZW5ndGggLSAxXS5ub2RlTmFtZSA9PT0gJ0JSJykgci5zZXRTdGFydChlbCwga2lkcy5sZW5ndGggLSAxKTsKICAgICAgZWxzZSB7IHIuc2VsZWN0Tm9kZUNvbnRlbnRzKGVsKTsgci5jb2xsYXBzZShmYWxzZSk7IH0KICAgICAgci5jb2xsYXBzZSh0cnVlKTsKICAgICAgc2VsZWN0KHIpOwogICAgfQoKICAgIGZ1bmN0aW9uIGZvY3VzQ2VsbCh0ZCwgYXRFbmQgPSBmYWxzZSkgewogICAgICBpZiAoIXRkKSByZXR1cm47CiAgICAgIHRkLmZvY3VzKHsgcHJldmVudFNjcm9sbDogdHJ1ZSB9KTsKICAgICAgY2FyZXRJbnRvKHRkLCBhdEVuZCk7CiAgICAgIGxhc3RDZWxsID0gdGQ7CiAgICAgIHRkLnNjcm9sbEludG9WaWV3KHs",
"gYmxvY2s6ICduZWFyZXN0JywgaW5saW5lOiAnbmVhcmVzdCcgfSk7CiAgICB9CgogICAgLy8gT3V0IG9mIGEgdGFibGUsIGFib3ZlIG9yIGJlbG93IGl0OiB0byB0aGUgYmxvY2sgdGhlcmUsIG9yIGEgbmV3CiAgICAvLyBlbXB0eSBsaW5lIGlmIHRoZXJlIGlzIG5vbmUgKG9yIG9ubHkgYW5vdGhlciB0YWJsZSkuCiAgICBmdW5jdGlvbiBsZWF2ZVRhYmxlKGVsLCBiZWxvdykgewogICAgICBsZXQgdGFyZ2V0ID0gYmVsb3cgPyBlbC5uZXh0RWxlbWVudFNpYmxpbmcgOiBlbC5wcmV2aW91c0VsZW1lbnRTaWJsaW5nOwogICAgICBpZiAoIXRhcmdldCB8fCB0YXJnZXQuZGF0YXNldC50eXBlID09PSAndGFibGUnKSB7CiAgICAgICAgdGFyZ2V0ID0gYmxvY2tFbChmbXQuYmxvY2soJ3AnKSk7CiAgICAgICAgaWYgKGJlbG93KSBlbC5hZnRlcih0YXJnZXQpOyBlbHNlIGVsLmJlZm9yZSh0YXJnZXQpOwogICAgICAgIGNoYW5nZWQoKTsKICAgICAgfQogICAgICBlbHMuZWRpdG9yLmZvY3VzKHsgcHJldmVudFNjcm9sbDogdHJ1ZSB9KTsKICAgICAgY2FyZXRJbnRvKHRhcmdldCwgIWJlbG93KTsKICAgIH0KCiAgICAvLyBXaGV0aGVyIHRoZSBjdXJzb3IgaXMgb24gdGhlIGZpcnN0IChvciBsYXN0KSBsaW5lIG9mIGFuIGVsZW1lbnQ6CiAgICAvLyBpdHMgYm94IGFnYWluc3QgdGhlIGVsZW1lbnQncyBmaXJzdCAob3IgbGFzdCkgcG9zaXRpb24uCiAgICBmdW5jdGlvbiBvbkVkZ2VMaW5lKGVsLCByLCBsYXN0KSB7CiAgICAgIGN",
"vbnN0IGF0ID0gci5nZXRDbGllbnRSZWN0cygpWzBdOwogICAgICBpZiAoIWF0KSByZXR1cm4gdHJ1ZTsKICAgICAgY29uc3QgcHJvYmUgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcm9iZS5zZWxlY3ROb2RlQ29udGVudHMoZWwpOwogICAgICBwcm9iZS5jb2xsYXBzZSghbGFzdCk7CiAgICAgIGNvbnN0IGVkZ2UgPSBwcm9iZS5nZXRDbGllbnRSZWN0cygpWzBdIHx8IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICByZXR1cm4gTWF0aC5hYnMoKGxhc3QgPyBhdC5ib3R0b20gLSBlZGdlLmJvdHRvbSA6IGF0LnRvcCAtIGVkZ2UudG9wKSkgPCBhdC5oZWlnaHQgLyAyICsgMTsKICAgIH0KCiAgICBmdW5jdGlvbiBjYXJldEF0RW5kKHIsIGVsKSB7CiAgICAgIGlmICghciB8fCAhci5jb2xsYXBzZWQpIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgcG9zdCA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIHBvc3Quc2VsZWN0Tm9kZUNvbnRlbnRzKGVsKTsKICAgICAgcG9zdC5zZXRTdGFydChyLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXQpOwogICAgICByZXR1cm4gcG9zdC50b1N0cmluZygpID09PSAnJzsKICAgIH0KCiAgICBmdW5jdGlvbiByYW5nZUJsb2NrcyhyKSB7CiAgICAgIGNvbnN0IGtpZHMgPSBbLi4uZWxzLmVkaXRvci5jaGlsZHJlbl07CiAgICAgIGNvbnN0IGVkZ2UgPSAoY29udGFpbmVyLCBvZmZzZXQsIGVuZCkgPT4gewogICAgICAgIGlmIChjb250YWluZXIgPT09IGV",
"scy5lZGl0b3IpIHJldHVybiBraWRzW01hdGgubWluKGtpZHMubGVuZ3RoIC0gMSwgTWF0aC5tYXgoMCwgb2Zmc2V0IC0gKGVuZCA_IDEgOiAwKSkpXTsKICAgICAgICByZXR1cm4gYmxvY2tPZihjb250YWluZXIpOwogICAgICB9OwogICAgICBjb25zdCBhID0gZWRnZShyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0LCBmYWxzZSk7CiAgICAgIGNvbnN0IGIgPSBlZGdlKHIuZW5kQ29udGFpbmVyLCByLmVuZE9mZnNldCwgdHJ1ZSk7CiAgICAgIGNvbnN0IGkgPSBraWRzLmluZGV4T2YoYSk7CiAgICAgIGNvbnN0IGogPSBraWRzLmluZGV4T2YoYik7CiAgICAgIGlmIChpIDwgMCB8fCBqIDwgMCkgcmV0dXJuIGEgPyBbYV0gOiBbXTsKICAgICAgcmV0dXJuIGtpZHMuc2xpY2UoTWF0aC5taW4oaSwgaiksIE1hdGgubWF4KGksIGopICsgMSk7CiAgICB9CgogICAgZnVuY3Rpb24gY2FyZXRBdEJsb2NrU3RhcnQociwgYmxrKSB7CiAgICAgIGlmICghciB8fCAhci5jb2xsYXBzZWQgfHwgIWJsaykgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCBwcmUgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcmUuc2VsZWN0Tm9kZUNvbnRlbnRzKGJsayk7CiAgICAgIHByZS5zZXRFbmQoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCk7CiAgICAgIHJldHVybiBwcmUudG9TdHJpbmcoKSA9PT0gJyc7CiAgICB9CgogICAgZnVuY3Rpb24gcGxhY2VDYXJldChub2RlLCBvZmZzZXQpIHsKICAgICAgY29uc3QgciA",
"9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIHIuc2V0U3RhcnQobm9kZSwgb2Zmc2V0KTsKICAgICAgci5jb2xsYXBzZSh0cnVlKTsKICAgICAgc2VsZWN0KHIpOwogICAgfQoKICAgIC8vIOKUgOKUgCBLZWVwaW5nIHRoZSBtYXJrdXAgdGlkeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICAvLyBFYWNoIGxpc3QgaXRlbSBtYXkgYmUgYXQgbW9zdCBvbmUgbGV2ZWwgZGVlcGVyIHRoYW4gdGhlIG9uZSBhYm92ZS4KICAgIGZ1bmN0aW9uIGZpeExldmVscygpIHsKICAgICAgbGV0IHByZXYgPSAtMTsKICAgICAgZm9yIChjb25zdCBibGsgb2YgZWxzLmVkaXRvci5jaGlsZHJlbikgewogICAgICAgIGlmIChmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V0LnR5cGUpKSB7CiAgICAgICAgICBjb25zdCBsdmwgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihmbXQuTUFYX0xFVkVMLCBOdW1iZXIoYmxrLmRhdGFzZXQubGV2ZWwpIHx8IDAsIHByZXYgKyAxKSk7CiAgICAgICAgICBibGsuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsdmwpOwogICAgICAgICAgcHJldiA9IGx2bDsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgcHJldiA9IC0xOwogICAgICAgIH0KICAgICAgfQogICAgfQoKICAgIC8vIFRoZSBicm93c2VyIHNvbWV0aW1lcyBsZWF",
"2ZXMgdGV4dCwgYSA8YnI-IG9yIGEgcGxhaW4gPGRpdj4gZGlyZWN0bHkKICAgIC8vIGluIHRoZSBlZGl0b3IgKGFmdGVyIHNlbGVjdC1hbGwgYW5kIGRlbGV0ZSwgc2F5KSwgYW5kIHdyYXBzIG1lcmdlZAogICAgLy8gdGV4dCBpbiA8c3BhbiBzdHlsZT0iZm9udC1zaXpl4oCmIj4gd2hlbiB0d28gYmxvY2tzIG9mIGRpZmZlcmVudCBzaXplcwogICAgLy8gam9pbi4gQm90aCBhcmUgcHV0IHJpZ2h0IGhlcmUsIGtlZXBpbmcgdGhlIGNhcmV0IHdoZXJlIGl0IHdhcy4KICAgIGZ1bmN0aW9uIHRpZHkoKSB7CiAgICAgIGNvbnN0IHNlbCA9IHNlbGVjdGlvbigpOwogICAgICBjb25zdCByID0gc2VsICYmIHNlbC5yYW5nZUNvdW50ID8gc2VsLmdldFJhbmdlQXQoMCkgOiBudWxsOwogICAgICBjb25zdCBrZWVwID0gciA_IFtyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0LCByLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXRdIDogbnVsbDsKICAgICAgbGV0IG1vdmVkID0gZmFsc2U7CgogICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgWy4uLmVscy5lZGl0b3IuY2hpbGROb2Rlc10pIHsKICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiBub2RlLmNsYXNzTGlzdC5jb250YWlucygnYmxrJykgJiYgbm9kZS5kYXRhc2V0LnR5cGUpIGNvbnRpbnVlOwogICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAxICYmIC9eKERJVnxQfEgxfEgyfEgzKSQvLnRlc3Qobm9kZS50YWdOYW1lKSkgewogICAgICAgICAgbm9kZS5",
"jbGFzc0xpc3QuYWRkKCdibGsnKTsKICAgICAgICAgIHNldEJsb2NrKG5vZGUsIC9eSFsxMjNdJC8udGVzdChub2RlLnRhZ05hbWUpID8gbm9kZS50YWdOYW1lLnRvTG93ZXJDYXNlKCkgOiAncCcpOwogICAgICAgICAgY29udGludWU7CiAgICAgICAgfQogICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAzICYmICFub2RlLmRhdGEudHJpbSgpICYmICEoa2VlcCAmJiAoa2VlcFswXSA9PT0gbm9kZSB8fCBrZWVwWzJdID09PSBub2RlKSkpIHsKICAgICAgICAgIG5vZGUucmVtb3ZlKCk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3QgYmxrID0gYmxvY2tFbChmbXQuYmxvY2soJ3AnKSk7CiAgICAgICAgYmxrLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICAgIGVscy5lZGl0b3IuaW5zZXJ0QmVmb3JlKGJsaywgbm9kZSk7CiAgICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS50YWdOYW1lID09PSAnQlInKSB7CiAgICAgICAgICBibGsuYXBwZW5kQ2hpbGQobm9kZSk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIC8vIEdhdGhlciB0aGlzIGFuZCBhbnkgZm9sbG93aW5nIGlubGluZSBuZWlnaGJvdXJzIGludG8gb25lIGJsb2NrLgogICAgICAgICAgbGV0IG4gPSBub2RlOwogICAgICAgICAgd2hpbGUgKG4gJiYgIShuLm5vZGVUeXBlID09PSAxICYmIChuLmNsYXNzTGlzdC5jb250YWlucygnYmxrJykgfHwgTkVTVEVEX0JMT0NLUy5oYXMobi50YWdOYW1lLnRvTG93ZXJ",
"DYXNlKCkpKSkpIHsKICAgICAgICAgICAgY29uc3QgZm9sbG93aW5nID0gbi5uZXh0U2libGluZzsKICAgICAgICAgICAgYmxrLmFwcGVuZENoaWxkKG4pOwogICAgICAgICAgICBuID0gZm9sbG93aW5nOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgICBtb3ZlZCA9IHRydWU7CiAgICAgIH0KCiAgICAgIGZvciAoY29uc3Qgc3BhbiBvZiBbLi4uZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yQWxsKCdzcGFuW3N0eWxlXSwgZm9udCcpXSkgewogICAgICAgIGNvbnN0IHN0ID0gc3R5bGVNYXJrcyhzcGFuLmdldEF0dHJpYnV0ZSgnc3R5bGUnKSk7CiAgICAgICAgaWYgKHN0LmIgfHwgc3QuaSB8fCBzdC5zKSBjb250aW51ZTsKICAgICAgICBzcGFuLnJlcGxhY2VXaXRoKC4uLnNwYW4uY2hpbGROb2Rlcyk7CiAgICAgICAgbW92ZWQgPSB0cnVlOwogICAgICB9CiAgICAgIGZvciAoY29uc3QgYSBvZiBlbHMuZWRpdG9yLnF1ZXJ5U2VsZWN0b3JBbGwoJ2FbaHJlZl0nKSkgewogICAgICAgIGNvbnN0IGhyZWYgPSBmbXQuc2FmZUhyZWYoYS5nZXRBdHRyaWJ1dGUoJ2hyZWYnKSk7CiAgICAgICAgaWYgKCFocmVmKSBhLnJlcGxhY2VXaXRoKC4uLmEuY2hpbGROb2Rlcyk7CiAgICAgICAgZWxzZSBpZiAoYS50aXRsZSAhPT0gaHJlZikgYS50aXRsZSA9IGhyZWY7CiAgICAgIH0KICAgICAgaWYgKCFlbHMuZWRpdG9yLmNoaWxkcmVuLmxlbmd0aCkgewogICAgICAgIGVscy5lZGl0b3IuYXBwZW5kQ2hpbGQoYmxvY2tFbChmbXQuYmx",
"vY2soJ3AnKSkpOwogICAgICAgIHBsYWNlQ2FyZXQoZWxzLmVkaXRvci5maXJzdENoaWxkLCAwKTsKICAgICAgICBtb3ZlZCA9IGZhbHNlOwogICAgICB9CiAgICAgIC8vIFNvbWV3aGVyZSB0byB0eXBlIGFmdGVyIGEgdGFibGUgYXQgdGhlIGVuZC4KICAgICAgY29uc3QgbGFzdEJsayA9IGVscy5lZGl0b3IubGFzdEVsZW1lbnRDaGlsZDsKICAgICAgaWYgKGxhc3RCbGsgJiYgbGFzdEJsay5kYXRhc2V0LnR5cGUgPT09ICd0YWJsZScpIGVscy5lZGl0b3IuYXBwZW5kQ2hpbGQoYmxvY2tFbChmbXQuYmxvY2soJ3AnKSkpOwogICAgICBpZiAobW92ZWQgJiYga2VlcCAmJiBrZWVwWzBdLmlzQ29ubmVjdGVkICYmIGtlZXBbMl0uaXNDb25uZWN0ZWQpIHsKICAgICAgICB0cnkgewogICAgICAgICAgY29uc3QgYmFjayA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgICBiYWNrLnNldFN0YXJ0KGtlZXBbMF0sIGtlZXBbMV0pOwogICAgICAgICAgYmFjay5zZXRFbmQoa2VlcFsyXSwga2VlcFszXSk7CiAgICAgICAgICBzZWxlY3QoYmFjayk7CiAgICAgICAgfSBjYXRjaCB7IC8qIHBvc2l0aW9ucyBubyBsb25nZXIgdmFsaWQgKi8gfQogICAgICB9CiAgICAgIGZpeExldmVscygpOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIGZ1bmN0aW9uIHVwZGF0ZUVtcHR5KCkgewogICAgICBjb25zdCBraWRzID0gZWxzLmVkaXRvci5jaGlsZHJlbjsKICAgICAgY29uc3QgZW1wdHkgPSBraWRzLmxlbmd0aCA8PSA",
"xICYmICgha2lkc1swXSB8fCAoa2lkc1swXS5kYXRhc2V0LnR5cGUgPT09ICdwJyAmJiAha2lkc1swXS50ZXh0Q29udGVudCkpOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQuZW1wdHkgPSBlbXB0eSA_ICcxJyA6ICcwJzsKICAgIH0KCiAgICBmdW5jdGlvbiBjaGFuZ2VkKCkgewogICAgICBwYXN0ZVVuZG8gPSBbXTsKICAgICAgdGlkeSgpOwogICAgICBvbkNoYW5nZSgpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIOKUgOKUgCBDb21tYW5kcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlvbiBpbmxpbmUoY21kKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgcmVzdG9yZSgpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZChjbWQpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIEFwcGxpZXMgYSBibG9jayB0eXBlIHRvIGV2ZXJ5IGJsb2NrIHRoZSBzZWxlY3Rpb24gdG91Y2hlcyAtIG9yLCBpZgogICAgLy8gdGhleSBhbGwgaGF2ZSBpdCBhbHJlYWR5LCB0dXJucyB0aGVtIGJhY2sgaW50byBwYXJhZ3JhcGhzLgogICAgZnVuY3Rpb24gYmxvY2tUeXBlKHR5cGUsIHsgY2h",
"lY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIHJlc3RvcmUoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghciB8fCBjZWxsT2Yoci5zdGFydENvbnRhaW5lcikpIHJldHVybjsgLy8gYSBjZWxsIGhvbGRzIHRleHQsIG5vdCBsaXN0cyBvciBoZWFkaW5ncwogICAgICBjb25zdCBibG9ja3MgPSByYW5nZUJsb2NrcyhyKTsKICAgICAgY29uc3Qgb2ZmID0gYmxvY2tzLmV2ZXJ5KGIgPT4gYi5kYXRhc2V0LnR5cGUgPT09IHR5cGUpICYmIHR5cGUgIT09ICdwJzsKICAgICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICAgIGNvbnN0IHdhcyA9IGIuZGF0YXNldC50eXBlOwogICAgICAgIGNvbnN0IGxldmVsID0gZm10LkxJU1RTLmhhcyh3YXMpID8gTnVtYmVyKGIuZGF0YXNldC5sZXZlbCkgfHwgMCA6IDA7CiAgICAgICAgc2V0QmxvY2soYiwgb2ZmID8gJ3AnIDogdHlwZSwgbGV2ZWwsIHR5cGUgPT09ICdjaGVjaycgJiYgd2FzID09PSAnY2hlY2snID8gYi5kYXRhc2V0LmNoZWNrZWQgPT09ICcxJyA6IGNoZWNrZWQpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBpbmRlbnQoZGVsdGEpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyIHx8IGNlbGxPZihyLnN0YXJ0Q29udGFpbmVyKSkgcmV0dXJuIGZhbHNlOwogICA",
"gICBjb25zdCBibG9ja3MgPSByYW5nZUJsb2NrcyhyKS5maWx0ZXIoYiA9PiBmbXQuTElTVFMuaGFzKGIuZGF0YXNldC50eXBlKSk7CiAgICAgIGlmICghYmxvY2tzLmxlbmd0aCkgcmV0dXJuIGZhbHNlOwogICAgICBmb3IgKGNvbnN0IGIgb2YgYmxvY2tzKSBiLmRhdGFzZXQubGV2ZWwgPSBTdHJpbmcoTWF0aC5tYXgoMCwgTWF0aC5taW4oZm10Lk1BWF9MRVZFTCwgKE51bWJlcihiLmRhdGFzZXQubGV2ZWwpIHx8IDApICsgZGVsdGEpKSk7CiAgICAgIGNoYW5nZWQoKTsKICAgICAgcmV0dXJuIHRydWU7CiAgICB9CgogICAgZnVuY3Rpb24gdG9nZ2xlQ2hlY2soYmxrKSB7CiAgICAgIGlmICghZWRpdGFibGUgfHwgIWJsayB8fCBibGsuZGF0YXNldC50eXBlICE9PSAnY2hlY2snKSByZXR1cm47CiAgICAgIGJsay5kYXRhc2V0LmNoZWNrZWQgPSBibGsuZGF0YXNldC5jaGVja2VkID09PSAnMScgPyAnMCcgOiAnMSc7CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBjbGVhckZvcm1hdHRpbmcoKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgcmVzdG9yZSgpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgncmVtb3ZlRm9ybWF0Jyk7CiAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCd1bmxpbmsnKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmIChyICYmICFjZWxsT2Yoci5zdGFydENvbnRhaW5lcikpIGZvciAoY29uc3QgYiBvZiByYW5nZUJsb2NrcyhyKSkgaWY",
"gKGIuZGF0YXNldC50eXBlICE9PSAndGFibGUnKSBzZXRCbG9jayhiLCAncCcpOwogICAgICBjaGFuZ2VkKCk7CiAgICB9CgogICAgZnVuY3Rpb24gYW5jaG9yQXQocikgewogICAgICBsZXQgbiA9IHIgJiYgci5zdGFydENvbnRhaW5lcjsKICAgICAgd2hpbGUgKG4gJiYgbiAhPT0gZWxzLmVkaXRvcikgewogICAgICAgIGlmIChuLm5vZGVUeXBlID09PSAxICYmIG4udGFnTmFtZSA9PT0gJ0EnKSByZXR1cm4gbjsKICAgICAgICBuID0gbi5wYXJlbnROb2RlOwogICAgICB9CiAgICAgIHJldHVybiBudWxsOwogICAgfQoKICAgIC8vIOKUgOKUgCBMaW5rcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlvbiBvcGVuTGluaygpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuOwogICAgICBjb25zdCByID0gcmFuZ2UoKSB8fCBzYXZlZDsKICAgICAgaWYgKCFyKSByZXR1cm47CiAgICAgIHNhdmVkID0gci5jbG9uZVJhbmdlKCk7CiAgICAgIGNvbnN0IGEgPSBhbmNob3JBdChyKTsKICAgICAgZWxzLmxpbmtJbnB1dC52YWx1ZSA9IGEgPyBhLmdldEF0dHJpYnV0ZSgnaHJlZicpIDogJyc7CiAgICAgIGVscy5saW5rRXJyb3IudGV",
"4dENvbnRlbnQgPSAnJzsKICAgICAgZWxzLmxpbmtSZW1vdmUuaGlkZGVuID0gIWE7CiAgICAgIGVscy5saW5rYmFyLmhpZGRlbiA9IGZhbHNlOwogICAgICBlbHMubGlua0lucHV0LmZvY3VzKCk7CiAgICAgIGVscy5saW5rSW5wdXQuc2VsZWN0KCk7CiAgICB9CgogICAgZnVuY3Rpb24gY2xvc2VMaW5rKHsgcmVmb2N1cyA9IHRydWUgfSA9IHt9KSB7CiAgICAgIGlmIChlbHMubGlua2Jhci5oaWRkZW4pIHJldHVybjsKICAgICAgZWxzLmxpbmtiYXIuaGlkZGVuID0gdHJ1ZTsKICAgICAgaWYgKHJlZm9jdXMpIHJlc3RvcmUoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBhcHBseUxpbmsoKSB7CiAgICAgIGNvbnN0IGhyZWYgPSBmbXQuc2FmZUhyZWYoZWxzLmxpbmtJbnB1dC52YWx1ZSk7CiAgICAgIGlmICghaHJlZikgewogICAgICAgIGVscy5saW5rRXJyb3IudGV4dENvbnRlbnQgPSAnVGhhdCBpcyBub3QgYSB3ZWIgb3IgZW1haWwgYWRkcmVzcy4nOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBjbG9zZUxpbmsoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCBhID0gYW5jaG9yQXQocik7CiAgICAgIGlmIChyLmNvbGxhcHNlZCAmJiBhKSB7CiAgICAgICAgYS5zZXRBdHRyaWJ1dGUoJ2hyZWYnLCBocmVmKTsKICAgICAgICBhLnRpdGxlID0gaHJlZjsKICAgICAgfSBlbHNlIGlmIChyLmNvbGxhcHNlZCkgewogICAgICAgIC8vIE5vdGhpbmcgc2VsZWN",
"0ZWQ6IHRoZSBhZGRyZXNzIGl0c2VsZiBiZWNvbWVzIHRoZSBsaW5rIHRleHQuCiAgICAgICAgY29uc3QgdGV4dCA9IGhyZWYucmVwbGFjZSgvXm1haWx0bzovLCAnJyk7CiAgICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2luc2VydFRleHQnLCBmYWxzZSwgdGV4dCk7CiAgICAgICAgY29uc3QgYWZ0ZXIgPSByYW5nZSgpOwogICAgICAgIGlmIChhZnRlcikgewogICAgICAgICAgY29uc3Qgc2VsID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICAgIHNlbC5zZXRTdGFydChhZnRlci5zdGFydENvbnRhaW5lciwgTWF0aC5tYXgoMCwgYWZ0ZXIuc3RhcnRPZmZzZXQgLSB0ZXh0Lmxlbmd0aCkpOwogICAgICAgICAgc2VsLnNldEVuZChhZnRlci5zdGFydENvbnRhaW5lciwgYWZ0ZXIuc3RhcnRPZmZzZXQpOwogICAgICAgICAgc2VsZWN0KHNlbCk7CiAgICAgICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnY3JlYXRlTGluaycsIGZhbHNlLCBocmVmKTsKICAgICAgICAgIGNvbnN0IGVuZCA9IHJhbmdlKCk7CiAgICAgICAgICBpZiAoZW5kKSB7IGVuZC5jb2xsYXBzZShmYWxzZSk7IHNlbGVjdChlbmQpOyB9CiAgICAgICAgfQogICAgICB9IGVsc2UgewogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdjcmVhdGVMaW5rJywgZmFsc2UsIGhyZWYpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiByZW1vdmVMaW5rKCkgewogICAgICBjbG9zZUxpbmsoKTsKICAgICAgY29uc3Q",
"gciA9IHJhbmdlKCk7CiAgICAgIGNvbnN0IGEgPSBhbmNob3JBdChyKTsKICAgICAgaWYgKGEpIHsKICAgICAgICBjb25zdCBzZWwgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICAgIHNlbC5zZWxlY3ROb2RlQ29udGVudHMoYSk7CiAgICAgICAgc2VsZWN0KHNlbCk7CiAgICAgIH0KICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ3VubGluaycpOwogICAgICBjaGFuZ2VkKCk7CiAgICB9CgogICAgLy8g4pSA4pSAIFRhYmxlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICAvLyBUaGUgY2VsbCBiZWluZyB3b3JrZWQgb246IHRoZSBvbmUgd2l0aCB0aGUgY3Vyc29yLCBvciAtIHdoaWxlIG9uZSBvZgogICAgLy8gdGhlIHRhYmxlIGJhcidzIG1lbnVzIGhhcyB0aGUgZm9jdXMgLSB0aGUgb25lIGl0IHdhcyBpbi4KICAgIGZ1bmN0aW9uIGNlbGxOb3coKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBjb25zdCB0ZCA9IHIgJiYgY2VsbE9mKHIuc3RhcnRDb250YWluZXIpOwogICAgICBpZiAodGQpIHJldHVybiB0ZDsKICAgICAgcmV0dXJuIGxhc3RDZWxsICYmIGxhc3RDZWxsLmlzQ29ubmVjdGVkICYmIGVscy5lZGl0b3I",
"uY29udGFpbnMobGFzdENlbGwpID8gbGFzdENlbGwgOiBudWxsOwogICAgfQoKICAgIC8vIEEgY2hhbmdlIHRvIGEgdGFibGUncyBzaGFwZSwgd2hpY2ggQ3RybCtaIHN0cmFpZ2h0IGFmdGVyd2FyZHMgdGFrZXMKICAgIC8vIGJhY2ssIGFzIGl0IGRvZXMgYSBmb3JtYXR0ZWQgcGFzdGUuIGBmbmAgZ2V0cyB0aGUgY2VsbCBhbmQgaXRzIHRhYmxlCiAgICAvLyBhbmQgcmV0dXJucyB0aGUgY2VsbCB0byBnbyB0byBuZXh0LgogICAgZnVuY3Rpb24gdGFibGVFZGl0KGZuKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgY29uc3QgdGQgPSBjZWxsTm93KCk7CiAgICAgIGlmICghdGQpIHJldHVybjsKICAgICAgY29uc3QgdW5kbyA9IHBhc3RlVW5kbzsKICAgICAgY29uc3QgYmVmb3JlID0gc25hcHNob3QoKTsKICAgICAgY29uc3QgbmV4dCA9IGZuKHRkLCB0YWJsZU9mKHRkKSk7CiAgICAgIGNoYW5nZWQoKTsKICAgICAgcGFzdGVVbmRvID0gWy4uLnVuZG8uc2xpY2UoLTE5KSwgYmVmb3JlXTsKICAgICAgaWYgKG5leHQpIGZvY3VzQ2VsbChuZXh0LCB0cnVlKTsKICAgICAgcmVmcmVzaFRvb2xiYXIoKTsKICAgIH0KCiAgICBjb25zdCByb3dzT2YgPSBlbCA9PiBlbC5xdWVyeVNlbGVjdG9yKCd0YWJsZScpLnJvd3M7CiAgICBmdW5jdGlvbiBuZXdSb3coZWwpIHsKICAgICAgY29uc3QgYSA9IGFsaWducyhlbCk7CiAgICAgIGNvbnN0IHRyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndHInKTsKICAgICA",
"gZm9yIChjb25zdCBhbCBvZiBhKSB0ci5hcHBlbmRDaGlsZChjZWxsRWwoW10sIGFsKSk7CiAgICAgIHJldHVybiB0cjsKICAgIH0KICAgIGNvbnN0IHRib2R5T2YgPSBlbCA9PiBlbC5xdWVyeVNlbGVjdG9yKCd0Ym9keScpIHx8IGVsLnF1ZXJ5U2VsZWN0b3IoJ3RhYmxlJyk7CgogICAgZnVuY3Rpb24gYWRkUm93KGJlbG93LCB7IGZpcnN0ID0gZmFsc2UgfSA9IHt9KSB7CiAgICAgIHRhYmxlRWRpdCgodGQsIGVsKSA9PiB7CiAgICAgICAgaWYgKHJvd3NPZihlbCkubGVuZ3RoID49IGZtdC5NQVhfUk9XUykgcmV0dXJuIHRkOwogICAgICAgIGNvbnN0IHRyID0gbmV3Um93KGVsKTsKICAgICAgICBpZiAoYmVsb3cpIHRkLnBhcmVudE5vZGUuYWZ0ZXIodHIpOwogICAgICAgIGVsc2UgdGQucGFyZW50Tm9kZS5iZWZvcmUodHIpOwogICAgICAgIHJldHVybiB0ci5jZWxsc1tmaXJzdCA_IDAgOiB0ZC5jZWxsSW5kZXhdOwogICAgICB9KTsKICAgIH0KCiAgICBmdW5jdGlvbiBhZGRDb2x1bW4ocmlnaHQpIHsKICAgICAgdGFibGVFZGl0KCh0ZCwgZWwpID0-IHsKICAgICAgICBjb25zdCByb3dzID0gcm93c09mKGVsKTsKICAgICAgICBpZiAocm93c1swXS5jZWxscy5sZW5ndGggPj0gZm10Lk1BWF9DT0xTKSByZXR1cm4gdGQ7CiAgICAgICAgY29uc3QgayA9IHRkLmNlbGxJbmRleCArIChyaWdodCA_IDEgOiAwKTsKICAgICAgICBjb25zdCBhID0gYWxpZ25zKGVsKTsKICAgICAgICBhLnNwbGljZShrLCAwLCAnJyk7CiAgICA",
"gICAgZm9yIChjb25zdCB0ciBvZiByb3dzKSB0ci5pbnNlcnRCZWZvcmUoY2VsbEVsKFtdLCAnJyksIHRyLmNlbGxzW2tdIHx8IG51bGwpOwogICAgICAgIGVsLmRhdGFzZXQuYWxpZ24gPSBhLmpvaW4oJywnKTsKICAgICAgICByZXR1cm4gdGQucGFyZW50Tm9kZS5jZWxsc1trXTsKICAgICAgfSk7CiAgICB9CgogICAgLy8gVGhlIHRhYmxlIGdvbmU6IHRoZSBjdXJzb3IgdG8gdGhlIGxpbmUgYWZ0ZXIgaXQuCiAgICBmdW5jdGlvbiByZW1vdmVUYWJsZShlbCkgewogICAgICBsZXQgbmV4dCA9IGVsLm5leHRFbGVtZW50U2libGluZzsKICAgICAgaWYgKCFuZXh0IHx8IG5leHQuZGF0YXNldC50eXBlID09PSAndGFibGUnKSB7CiAgICAgICAgbmV4dCA9IGJsb2NrRWwoZm10LmJsb2NrKCdwJykpOwogICAgICAgIGVsLmFmdGVyKG5leHQpOwogICAgICB9CiAgICAgIGVsLnJlbW92ZSgpOwogICAgICBsYXN0Q2VsbCA9IG51bGw7CiAgICAgIGVscy5lZGl0b3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBjYXJldEludG8obmV4dCwgZmFsc2UpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KCiAgICBmdW5jdGlvbiBkZWxldGVSb3coKSB7CiAgICAgIHRhYmxlRWRpdCgodGQsIGVsKSA9PiB7CiAgICAgICAgaWYgKHJvd3NPZihlbCkubGVuZ3RoID09PSAxKSByZXR1cm4gcmVtb3ZlVGFibGUoZWwpOwogICAgICAgIGNvbnN0IHRyID0gdGQucGFyZW50Tm9kZTsKICAgICAgICBjb25zdCBuZXh0ID0gdHI",
"ubmV4dEVsZW1lbnRTaWJsaW5nIHx8IHRyLnByZXZpb3VzRWxlbWVudFNpYmxpbmc7CiAgICAgICAgdHIucmVtb3ZlKCk7CiAgICAgICAgcmV0dXJuIG5leHQuY2VsbHNbTWF0aC5taW4odGQuY2VsbEluZGV4LCBuZXh0LmNlbGxzLmxlbmd0aCAtIDEpXTsKICAgICAgfSk7CiAgICB9CgogICAgZnVuY3Rpb24gZGVsZXRlQ29sdW1uKCkgewogICAgICB0YWJsZUVkaXQoKHRkLCBlbCkgPT4gewogICAgICAgIGNvbnN0IHJvd3MgPSByb3dzT2YoZWwpOwogICAgICAgIGlmIChyb3dzWzBdLmNlbGxzLmxlbmd0aCA9PT0gMSkgcmV0dXJuIHJlbW92ZVRhYmxlKGVsKTsKICAgICAgICBjb25zdCBrID0gdGQuY2VsbEluZGV4OwogICAgICAgIGNvbnN0IGEgPSBhbGlnbnMoZWwpOwogICAgICAgIGEuc3BsaWNlKGssIDEpOwogICAgICAgIGNvbnN0IHRyID0gdGQucGFyZW50Tm9kZTsKICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiByb3dzKSByb3cuY2VsbHNba10ucmVtb3ZlKCk7CiAgICAgICAgZWwuZGF0YXNldC5hbGlnbiA9IGEuam9pbignLCcpOwogICAgICAgIHJldHVybiB0ci5jZWxsc1tNYXRoLm1pbihrLCB0ci5jZWxscy5sZW5ndGggLSAxKV07CiAgICAgIH0pOwogICAgfQoKICAgIGZ1bmN0aW9uIHRvZ2dsZUhlYWQoKSB7CiAgICAgIHRhYmxlRWRpdCgodGQsIGVsKSA9PiB7CiAgICAgICAgZWwuZGF0YXNldC5oZWFkID0gZWwuZGF0YXNldC5oZWFkID09PSAnMScgPyAnMCcgOiAnMSc7CiAgICAgICAgcmV0dXJuIHRkOwo",
"gICAgICB9KTsKICAgIH0KCiAgICBmdW5jdGlvbiBhbGlnbkNvbHVtbih2YWx1ZSkgewogICAgICB0YWJsZUVkaXQoKHRkLCBlbCkgPT4gewogICAgICAgIGNvbnN0IGsgPSB0ZC5jZWxsSW5kZXg7CiAgICAgICAgY29uc3QgYSA9IGFsaWducyhlbCk7CiAgICAgICAgYVtrXSA9IHZhbHVlOwogICAgICAgIGVsLmRhdGFzZXQuYWxpZ24gPSBhLmpvaW4oJywnKTsKICAgICAgICBmb3IgKGNvbnN0IHRyIG9mIHJvd3NPZihlbCkpIGlmICh0ci5jZWxsc1trXSkgdHIuY2VsbHNba10uc3R5bGUudGV4dEFsaWduID0gdmFsdWU7CiAgICAgICAgcmV0dXJuIHRkOwogICAgICB9KTsKICAgIH0KCiAgICAvLyBUaGUgcm93cyBpbiBvcmRlciBvZiBvbmUgY29sdW1uIC0gbnVtYmVycyBhcyBudW1iZXJzLCBlbXB0eSBjZWxscwogICAgLy8gbGFzdCAtIHdpdGggYSBoZWFkaW5nIHJvdyBzdGF5aW5nIG9uIHRvcC4KICAgIGZ1bmN0aW9uIHNvcnRSb3dzKGRlc2MpIHsKICAgICAgdGFibGVFZGl0KCh0ZCwgZWwpID0-IHsKICAgICAgICBjb25zdCBrID0gdGQuY2VsbEluZGV4OwogICAgICAgIGNvbnN0IHJvd3MgPSBbLi4ucm93c09mKGVsKV07CiAgICAgICAgY29uc3QgaGVhZCA9IGVsLmRhdGFzZXQuaGVhZCA9PT0gJzEnID8gcm93cy5zaGlmdCgpIDogbnVsbDsKICAgICAgICBjb25zdCBrZXkgPSB0ciA9PiAodHIuY2VsbHNba10gPyB0ci5jZWxsc1trXS50ZXh0Q29udGVudC50cmltKCkgOiAnJyk7CiAgICAgICAgY29uc3Qgb3JkZXI",
"gPSBuZXcgSW50bC5Db2xsYXRvcih1bmRlZmluZWQsIHsgbnVtZXJpYzogdHJ1ZSwgc2Vuc2l0aXZpdHk6ICdiYXNlJyB9KTsKICAgICAgICByb3dzLnNvcnQoKHgsIHkpID0-IHsKICAgICAgICAgIGNvbnN0IGEgPSBrZXkoeCk7CiAgICAgICAgICBjb25zdCBiID0ga2V5KHkpOwogICAgICAgICAgaWYgKCFhICE9PSAhYikgcmV0dXJuIGEgPyAtMSA6IDE7CiAgICAgICAgICByZXR1cm4gZGVzYyA_IG9yZGVyLmNvbXBhcmUoYiwgYSkgOiBvcmRlci5jb21wYXJlKGEsIGIpOwogICAgICAgIH0pOwogICAgICAgIGNvbnN0IGJvZHkgPSB0Ym9keU9mKGVsKTsKICAgICAgICBpZiAoaGVhZCkgYm9keS5hcHBlbmRDaGlsZChoZWFkKTsKICAgICAgICBmb3IgKGNvbnN0IHRyIG9mIHJvd3MpIGJvZHkuYXBwZW5kQ2hpbGQodHIpOwogICAgICAgIHJldHVybiB0ZDsKICAgICAgfSk7CiAgICB9CgogICAgLy8gQSBuZXcgdGFibGUgd2hlcmUgdGhlIGN1cnNvciBpczogaW4gcGxhY2Ugb2YgYW4gZW1wdHkgbGluZSwgb3IgYWZ0ZXIKICAgIC8vIHRoZSBsaW5lIGl0IGlzIG9uOyB0aHJlZSBjb2x1bW5zLCBhIGhlYWRpbmcgcm93IGFuZCB0d28gbW9yZS4KICAgIGZ1bmN0aW9uIGluc2VydFRhYmxlKCkgewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIHJlc3RvcmUoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghciB8fCBjZWxsT2Yoci5zdGFydENvbnRhaW5lcikpIHJldHVybjsKICAgICAgY29",
"uc3QgYmxrID0gYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKSB8fCBlbHMuZWRpdG9yLmxhc3RFbGVtZW50Q2hpbGQ7CiAgICAgIGlmICghYmxrKSByZXR1cm47CiAgICAgIGNvbnN0IHVuZG8gPSBwYXN0ZVVuZG87CiAgICAgIGNvbnN0IGJlZm9yZSA9IHNuYXBzaG90KCk7CiAgICAgIGNvbnN0IHJvd3MgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiBORVdfVEFCTEUucm93cyB9LCAoKSA9PiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBORVdfVEFCTEUuY29scyB9LCAoKSA9PiAoeyBydW5zOiBbXSB9KSkpOwogICAgICBjb25zdCBlbCA9IHRhYmxlRWwoZm10LnRhYmxlKHJvd3MsIHsgaGVhZDogdHJ1ZSwgYWxpZ246IEFycmF5KE5FV19UQUJMRS5jb2xzKS5maWxsKCcnKSB9KSk7CiAgICAgIGlmIChibGsuZGF0YXNldC50eXBlID09PSAncCcgJiYgIWJsay50ZXh0Q29udGVudCkgYmxrLnJlcGxhY2VXaXRoKGVsKTsKICAgICAgZWxzZSBibGsuYWZ0ZXIoZWwpOwogICAgICBpZiAoIWVsLm5leHRFbGVtZW50U2libGluZyB8fCBlbC5uZXh0RWxlbWVudFNpYmxpbmcuZGF0YXNldC50eXBlID09PSAndGFibGUnKSBlbC5hZnRlcihibG9ja0VsKGZtdC5ibG9jaygncCcpKSk7CiAgICAgIGNoYW5nZWQoKTsKICAgICAgcGFzdGVVbmRvID0gWy4uLnVuZG8uc2xpY2UoLTE5KSwgYmVmb3JlXTsKICAgICAgZm9jdXNDZWxsKGVsLnF1ZXJ5U2VsZWN0b3IoJ3RkJykpOwogICAgfQoKICAgIC8vIEtleXMgaW4gYSBjZWxsOiBUYWIgYW5kIFNoaWZ",
"0K1RhYiBmcm9tIGNlbGwgdG8gY2VsbCAoVGFiIGluIHRoZSBsYXN0CiAgICAvLyBvbmUgYWRkcyBhIHJvdyksIEVudGVyIGEgbmV3IGxpbmUgaW4gdGhlIGNlbGwsIHRoZSBhcnJvd3Mgb3V0IG9mIGl0CiAgICAvLyBhdCBpdHMgZWRnZXMsIGFuZCBub3RoaW5nIGpvaW5pbmcgYSBjZWxsIHRvIGFub3RoZXIuCiAgICBmdW5jdGlvbiBjZWxsS2V5KGUsIHRkLCByLCBtb2QpIHsKICAgICAgY29uc3QgZWwgPSB0YWJsZU9mKHRkKTsKICAgICAgY29uc3QgY2VsbHMgPSBbLi4uZWwucXVlcnlTZWxlY3RvckFsbCgndGQnKV07CiAgICAgIGNvbnN0IGkgPSBjZWxscy5pbmRleE9mKHRkKTsKICAgICAgY29uc3QgdHIgPSB0ZC5wYXJlbnROb2RlOwogICAgICBjb25zdCBnbyA9IChjZWxsLCBhdEVuZCkgPT4geyBlLnByZXZlbnREZWZhdWx0KCk7IGZvY3VzQ2VsbChjZWxsLCBhdEVuZCk7IHJldHVybiB0cnVlOyB9OwogICAgICBjb25zdCBvdXQgPSBiZWxvdyA9PiB7IGUucHJldmVudERlZmF1bHQoKTsgbGVhdmVUYWJsZShlbCwgYmVsb3cpOyByZXR1cm4gdHJ1ZTsgfTsKICAgICAgaWYgKGUua2V5ID09PSAnVGFiJyAmJiAhbW9kICYmICFlLmFsdEtleSkgewogICAgICAgIGlmIChlLnNoaWZ0S2V5KSByZXR1cm4gaSA-IDAgPyBnbyhjZWxsc1tpIC0gMV0sIHRydWUpIDogKGUucHJldmVudERlZmF1bHQoKSwgdHJ1ZSk7CiAgICAgICAgaWYgKGkgPCBjZWxscy5sZW5ndGggLSAxKSByZXR1cm4gZ28oY2VsbHNbaSArIDFdLCB0cnV",
"lKTsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgYWRkUm93KHRydWUsIHsgZmlyc3Q6IHRydWUgfSk7CiAgICAgICAgcmV0dXJuIHRydWU7CiAgICAgIH0KICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFtb2QgJiYgIWUuYWx0S2V5ICYmICFlLmlzQ29tcG9zaW5nKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRMaW5lQnJlYWsnKTsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfQogICAgICBpZiAoIW1vZCAmJiAoKGUua2V5ID09PSAnQmFja3NwYWNlJyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCB0ZCkpIHx8IChlLmtleSA9PT0gJ0RlbGV0ZScgJiYgY2FyZXRBdEVuZChyLCB0ZCkpKSkgewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfQogICAgICBpZiAoIW1vZCAmJiAhZS5hbHRLZXkgJiYgIWUuc2hpZnRLZXkgJiYgci5jb2xsYXBzZWQpIHsKICAgICAgICBjb25zdCBrID0gdGQuY2VsbEluZGV4OwogICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93VXAnICYmIG9uRWRnZUxpbmUodGQsIHIsIGZhbHNlKSkgewogICAgICAgICAgY29uc3QgdXAgPSB0ci5wcmV2aW91c0VsZW1lbnRTaWJsaW5nOwogICAgICAgICAgcmV0dXJuIHVwID8gZ28odXAuY2VsbHNbTWF0aC5taW4oaywgdXAuY2VsbHMubGVuZ3RoIC0gMSldLCB0cnVlKSA6IG91dChmYWxzZSk7CiAgICA",
"gICAgfQogICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93RG93bicgJiYgb25FZGdlTGluZSh0ZCwgciwgdHJ1ZSkpIHsKICAgICAgICAgIGNvbnN0IGRvd24gPSB0ci5uZXh0RWxlbWVudFNpYmxpbmc7CiAgICAgICAgICByZXR1cm4gZG93biA_IGdvKGRvd24uY2VsbHNbTWF0aC5taW4oaywgZG93bi5jZWxscy5sZW5ndGggLSAxKV0sIGZhbHNlKSA6IG91dCh0cnVlKTsKICAgICAgICB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnQXJyb3dMZWZ0JyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCB0ZCkpIHJldHVybiBpID4gMCA_IGdvKGNlbGxzW2kgLSAxXSwgdHJ1ZSkgOiBvdXQoZmFsc2UpOwogICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93UmlnaHQnICYmIGNhcmV0QXRFbmQociwgdGQpKSByZXR1cm4gaSA8IGNlbGxzLmxlbmd0aCAtIDEgPyBnbyhjZWxsc1tpICsgMV0sIGZhbHNlKSA6IG91dCh0cnVlKTsKICAgICAgfQogICAgICAvLyBMaXN0cyBhbmQgaGVhZGluZ3MgYXJlIG5vdCBmb3IgY2VsbHMuCiAgICAgIGlmIChtb2QgJiYgZS5zaGlmdEtleSAmJiAvXkRpZ2l0Wzc4OV0kLy50ZXN0KGUuY29kZSkpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyByZXR1cm4gdHJ1ZTsgfQogICAgICByZXR1cm4gZmFsc2U7CiAgICB9CgogICAgLy8gS2V5cyBvbiBhIGxpbmUgYmVzaWRlIGEgdGFibGU6IHRoZSBhcnJvd3MgaW50byBpdCwgYW5kIEJhY2tzcGFjZSBvcgogICAgLy8gRGVsZXRlIGludG8gaXQgcmF0aGVyIHRoYW4gdGh",
"yb3VnaCBpdC4KICAgIGZ1bmN0aW9uIGJlc2lkZVRhYmxlKGUsIHIsIGJsaywgbW9kKSB7CiAgICAgIGlmIChtb2QgfHwgZS5hbHRLZXkgfHwgZS5zaGlmdEtleSB8fCAhci5jb2xsYXBzZWQpIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgcHJldiA9IGJsay5wcmV2aW91c0VsZW1lbnRTaWJsaW5nOwogICAgICBjb25zdCBuZXh0ID0gYmxrLm5leHRFbGVtZW50U2libGluZzsKICAgICAgY29uc3QgaW50byA9IChlbCwgbGFzdCkgPT4gewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBjZWxscyA9IGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ3RkJyk7CiAgICAgICAgZm9jdXNDZWxsKGxhc3QgPyBjZWxsc1tjZWxscy5sZW5ndGggLSAxXSA6IGNlbGxzWzBdLCBsYXN0KTsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfTsKICAgICAgaWYgKG5leHQgJiYgbmV4dC5kYXRhc2V0LnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICBpZiAoKGUua2V5ID09PSAnQXJyb3dEb3duJyAmJiBvbkVkZ2VMaW5lKGJsaywgciwgdHJ1ZSkpIHx8IChlLmtleSA9PT0gJ0Fycm93UmlnaHQnICYmIGNhcmV0QXRFbmQociwgYmxrKSkpIHJldHVybiBpbnRvKG5leHQsIGZhbHNlKTsKICAgICAgICBpZiAoZS5rZXkgPT09ICdEZWxldGUnICYmIGNhcmV0QXRFbmQociwgYmxrKSkgewogICAgICAgICAgaWYgKCFibGsudGV4dENvbnRlbnQgJiYgYmxrLnByZXZpb3VzRWxlbWVudFNpYmxpbmcpIHsgYmxrLnJlbW92ZSgpOyB",
"jaGFuZ2VkKCk7IH0KICAgICAgICAgIHJldHVybiBpbnRvKG5leHQsIGZhbHNlKTsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKHByZXYgJiYgcHJldi5kYXRhc2V0LnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICBpZiAoZS5rZXkgPT09ICdBcnJvd1VwJyAmJiBvbkVkZ2VMaW5lKGJsaywgciwgZmFsc2UpKSB7CiAgICAgICAgICAvLyBVcCBpbnRvIHRoZSBsYXN0IHJvdywgYXQgaXRzIHN0YXJ0LgogICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgICAgY29uc3Qgcm93cyA9IHByZXYucXVlcnlTZWxlY3RvcigndGFibGUnKS5yb3dzOwogICAgICAgICAgZm9jdXNDZWxsKHJvd3Nbcm93cy5sZW5ndGggLSAxXS5jZWxsc1swXSwgdHJ1ZSk7CiAgICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgICB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnQXJyb3dMZWZ0JyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCBibGspKSByZXR1cm4gaW50byhwcmV2LCB0cnVlKTsKICAgICAgICAvLyBBbiBlbXB0eSBsaW5lIGFmdGVyIGEgdGFibGUgZ29lcyAodW5sZXNzIGl0IGlzIHRoZSBsYXN0KTsgYSBsaW5lCiAgICAgICAgLy8gd2l0aCB0ZXh0IGtlZXBzIGl0LCBhbmQgdGhlIGN1cnNvciBnb2VzIGludG8gdGhlIHRhYmxlLgogICAgICAgIGlmIChlLmtleSA9PT0gJ0JhY2tzcGFjZScgJiYgYmxrLmRhdGFzZXQudHlwZSA9PT0gJ3AnICYmIGNhcmV0QXRCbG9ja1N0YXJ0KHIsIGJsaykpIHsKICAgICAgICAgIGlmICg",
"hYmxrLnRleHRDb250ZW50ICYmIGJsay5uZXh0RWxlbWVudFNpYmxpbmcpIHsgYmxrLnJlbW92ZSgpOyBjaGFuZ2VkKCk7IH0KICAgICAgICAgIHJldHVybiBpbnRvKHByZXYsIHRydWUpOwogICAgICAgIH0KICAgICAgfQogICAgICByZXR1cm4gZmFsc2U7CiAgICB9CgogICAgLy8gQSBwYXN0ZSBpbnRvIGEgY2VsbDogY2VsbHMgLSBhIHRhYmxlLCBvciB0YWItc2VwYXJhdGVkIHRleHQsIGFzIGEKICAgIC8vIHNwcmVhZHNoZWV0IGNvcGllcyB0aGVtIC0gZmlsbCB0aGUgY2VsbHMgZnJvbSB0aGlzIG9uZSBvbiwgYWRkaW5nCiAgICAvLyByb3dzIGFuZCBjb2x1bW5zIGFzIG5lZWRlZDsgYW55dGhpbmcgZWxzZSBnb2VzIGluIGFzIHRleHQuCiAgICBmdW5jdGlvbiBwYXN0ZUluQ2VsbChkb2MsIHRleHQpIHsKICAgICAgY29uc3QgdCA9IGRvYyAmJiBmbXQub25seVRhYmxlKGRvYyk7CiAgICAgIGxldCBncmlkID0gdCA_IHQucm93cy5tYXAocm93ID0-IHJvdy5tYXAoYyA9PiBjLnJ1bnMpKSA6IG51bGw7CiAgICAgIGlmICghZ3JpZCAmJiAvXHQvLnRlc3QodGV4dCB8fCAnJykpIHsKICAgICAgICBncmlkID0gU3RyaW5nKHRleHQpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnJlcGxhY2UoL1xuJC8sICcnKS5zcGxpdCgnXG4nKS5tYXAobGluZSA9PiBsaW5lLnNwbGl0KCdcdCcpLm1hcChjID0-IFt7IHRleHQ6IGMgfV0pKTsKICAgICAgfQogICAgICBpZiAoZ3JpZCAmJiAoZ3JpZC5sZW5ndGggPiAxIHx8IGdyaWRbMF0",
"ubGVuZ3RoID4gMSkpIHsKICAgICAgICB0YWJsZUVkaXQoKHRkLCBlbCkgPT4gewogICAgICAgICAgY29uc3Qgcm93cyA9IHJvd3NPZihlbCk7CiAgICAgICAgICBjb25zdCByMCA9IHRkLnBhcmVudE5vZGUucm93SW5kZXg7CiAgICAgICAgICBjb25zdCBjMCA9IHRkLmNlbGxJbmRleDsKICAgICAgICAgIGNvbnN0IHdpZGUgPSBNYXRoLm1pbihmbXQuTUFYX0NPTFMsIGMwICsgTWF0aC5tYXgoLi4uZ3JpZC5tYXAocm93ID0-IHJvdy5sZW5ndGgpKSk7CiAgICAgICAgICB3aGlsZSAocm93c1swXS5jZWxscy5sZW5ndGggPCB3aWRlKSBmb3IgKGNvbnN0IHRyIG9mIHJvd3MpIHRyLmFwcGVuZENoaWxkKGNlbGxFbChbXSwgJycpKTsKICAgICAgICAgIGVsLmRhdGFzZXQuYWxpZ24gPSBhbGlnbnMoZWwpLmpvaW4oJywnKTsKICAgICAgICAgIGNvbnN0IHRhbGwgPSBNYXRoLm1pbihmbXQuTUFYX1JPV1MsIHIwICsgZ3JpZC5sZW5ndGgpOwogICAgICAgICAgd2hpbGUgKHJvd3MubGVuZ3RoIDwgdGFsbCkgdGJvZHlPZihlbCkuYXBwZW5kQ2hpbGQobmV3Um93KGVsKSk7CiAgICAgICAgICBsZXQgbGFzdCA9IHRkOwogICAgICAgICAgZ3JpZC5mb3JFYWNoKChyb3csIGkpID0-IHJvdy5mb3JFYWNoKChydW5zLCBqKSA9PiB7CiAgICAgICAgICAgIGNvbnN0IGNlbGwgPSByb3dzW3IwICsgaV0gJiYgcm93c1tyMCArIGldLmNlbGxzW2MwICsgal07CiAgICAgICAgICAgIGlmICghY2VsbCkgcmV0dXJuOwogICAgICAgICAgICBmaWx",
"sQ2VsbChjZWxsLCBydW5zKTsKICAgICAgICAgICAgbGFzdCA9IGNlbGw7CiAgICAgICAgICB9KSk7CiAgICAgICAgICByZXR1cm4gbGFzdDsKICAgICAgICB9KTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY29uc3Qgb25lID0gZ3JpZCA_IGdyaWRbMF1bMF0ubWFwKHggPT4geC50ZXh0KS5qb2luKCcnKSA6IGRvYyA_IGZtdC5kb2NUZXh0KGRvYykgOiBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICAgIFN0cmluZyhvbmUpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnJlcGxhY2UoL1xuKyQvLCAnJykuc3BsaXQoJ1xuJykuZm9yRWFjaCgobGluZSwgaSkgPT4gewogICAgICAgIGlmIChpKSBkb2N1bWVudC5leGVjQ29tbWFuZCgnaW5zZXJ0TGluZUJyZWFrJyk7CiAgICAgICAgaWYgKGxpbmUpIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIGxpbmUpOwogICAgICB9KTsKICAgIH0KCiAgICAvLyDilIDilIAgVG9vbGJhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBjb25zdCBidXR0b25zID0ge307CiAgICBjb25zdCB0YkJ1dHRvbiA9IChrZXksIGxhYmVsLCBpY29uTmFtZSwgb25DbGljaywgdG9nZ2xlID0gdHJ",
"1ZSkgPT4gewogICAgICBjb25zdCBiID0gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAndGItYnRuJywgdHlwZTogJ2J1dHRvbicsIHRpdGxlOiBsYWJlbCwgJ2FyaWEtbGFiZWwnOiBsYWJlbCwKICAgICAgICAnYXJpYS1wcmVzc2VkJzogdG9nZ2xlID8gJ2ZhbHNlJyA6IG51bGwsIGRhdGFzZXQ6IHsga2V5OiBgZm10LSR7a2V5fWAgfSwKICAgICAgICAvLyBLZWVwcyB0aGUgZm9jdXMgLSBhbmQgc28gdGhlIHNlbGVjdGlvbiAtIGluIHRoZSB0ZXh0LgogICAgICAgIG9ubW91c2Vkb3duOiBlID0-IGUucHJldmVudERlZmF1bHQoKSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiBvbkNsaWNrKCksCiAgICAgIH0sIGljb24oaWNvbk5hbWUsIDIwKSk7CiAgICAgIGJ1dHRvbnNba2V5XSA9IGI7CiAgICAgIHJldHVybiBiOwogICAgfTsKICAgIGNvbnN0IHNlcCA9ICgpID0-IGgoJ3NwYW4nLCB7IGNsYXNzOiAndGItc2VwJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0pOwoKICAgIGVscy5zdHlsZUxhYmVsID0gaCgnc3BhbicsIHsgY2xhc3M6ICd0Yi1zdHlsZS1sYWJlbCcsIHRleHQ6ICdOb3JtYWwgdGV4dCcgfSk7CiAgICBlbHMuc3R5bGUgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAndGItc3R5bGUnLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywKICAgICAgJ2FyaWEtbGFiZWwnOiAnVGV4dCBzdHlsZScsIHRpdGxlOiAnVGV4dCBzdHl",
"sZScsIGRhdGFzZXQ6IHsga2V5OiAnZm10LXN0eWxlJyB9LAogICAgICBvbm1vdXNlZG93bjogZSA9PiBlLnByZXZlbnREZWZhdWx0KCksCiAgICAgIG9uY2xpY2s6ICgpID0-IHsKICAgICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgICAgaWYgKHIpIHNhdmVkID0gci5jbG9uZVJhbmdlKCk7CiAgICAgICAgY29uc3QgY3VyID0gY3VycmVudFR5cGUoKTsKICAgICAgICBvcGVuTWVudShyb290LCBlbHMuc3R5bGUsIFNUWUxFUy5tYXAoKFt0eXBlLCBsYWJlbF0pID0-ICh7CiAgICAgICAgICBsYWJlbCwga2V5OiBgc3R5bGU6JHt0eXBlfWAsIGNoZWNrZWQ6IGN1ciA9PT0gdHlwZSwKICAgICAgICAgIG9uU2VsZWN0OiAoKSA9PiBibG9ja1R5cGUodHlwZSksCiAgICAgICAgfSkpLCB7IGxhYmVsOiAnVGV4dCBzdHlsZScgfSk7CiAgICAgIH0sCiAgICB9LCBlbHMuc3R5bGVMYWJlbCwgaWNvbignY2FyZXQnLCAxOCkpOwoKICAgIGVscy50b29sYmFyID0gaCgnZGl2JywgeyBjbGFzczogJ25lLXRvb2xiYXInLCByb2xlOiAndG9vbGJhcicsICdhcmlhLWxhYmVsJzogJ0Zvcm1hdHRpbmcnIH0sCiAgICAgIGVscy5zdHlsZSwKICAgICAgc2VwKCksCiAgICAgIHRiQnV0dG9uKCdib2xkJywgJ0JvbGQgKEN0cmwrQiknLCAnYm9sZCcsICgpID0-IGlubGluZSgnYm9sZCcpKSwKICAgICAgdGJCdXR0b24oJ2l0YWxpYycsICdJdGFsaWMgKEN0cmwrSSknLCAnaXRhbGljJyw",
"gKCkgPT4gaW5saW5lKCdpdGFsaWMnKSksCiAgICAgIHRiQnV0dG9uKCdzdHJpa2UnLCAnU3RyaWtlLXRocm91Z2gnLCAnc3RyaWtlJywgKCkgPT4gaW5saW5lKCdzdHJpa2VUaHJvdWdoJykpLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ3VsJywgJ0J1bGxldGVkIGxpc3QgKEN0cmwrU2hpZnQrOCknLCAnYnVsbGV0cycsICgpID0-IGJsb2NrVHlwZSgndWwnKSksCiAgICAgIHRiQnV0dG9uKCdvbCcsICdOdW1iZXJlZCBsaXN0IChDdHJsK1NoaWZ0KzcpJywgJ251bWJlcnMnLCAoKSA9PiBibG9ja1R5cGUoJ29sJykpLAogICAgICB0YkJ1dHRvbignY2hlY2snLCAnQ2hlY2tsaXN0IChDdHJsK1NoaWZ0KzkpJywgJ2NoZWNrbGlzdCcsICgpID0-IGJsb2NrVHlwZSgnY2hlY2snKSksCiAgICAgIHRiQnV0dG9uKCdvdXRkZW50JywgJ0xlc3MgaW5kZW50IChTaGlmdCtUYWIpJywgJ291dGRlbnQnLCAoKSA9PiB7IHJlc3RvcmUoKTsgaW5kZW50KC0xKTsgfSwgZmFsc2UpLAogICAgICB0YkJ1dHRvbignaW5kZW50JywgJ01vcmUgaW5kZW50IChUYWIpJywgJ2luZGVudCcsICgpID0-IHsgcmVzdG9yZSgpOyBpbmRlbnQoMSk7IH0sIGZhbHNlKSwKICAgICAgdGJCdXR0b24oJ3RhYmxlJywgJ1RhYmxlJywgJ3RhYmxlJywgKCkgPT4gaW5zZXJ0VGFibGUoKSwgZmFsc2UpLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ2xpbmsnLCAnTGluayAoQ3RybCtLKScsICdsaW5rJywgKCkgPT4gb3BlbkxpbmsoKSksCiAgICA",
"gIHRiQnV0dG9uKCdjbGVhcicsICdDbGVhciBmb3JtYXR0aW5nJywgJ2NsZWFyJywgKCkgPT4gY2xlYXJGb3JtYXR0aW5nKCksIGZhbHNlKSk7CgogICAgZWxzLmxpbmtJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHBsYWNlaG9sZGVyOiAnV2ViIGFkZHJlc3Mgb3IgZW1haWwnLCAnYXJpYS1sYWJlbCc6ICdMaW5rIGFkZHJlc3MnLAogICAgICBzcGVsbGNoZWNrOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWlucHV0JyB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGFwcGx5TGluaygpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNsb3NlTGluaygpOyB9CiAgICAgIH0sCiAgICB9KTsKICAgIGVscy5saW5rRXJyb3IgPSBoKCdzcGFuJywgeyBjbGFzczogJ2xpbmstZXJyb3InLCByb2xlOiAnYWxlcnQnIH0pOwogICAgZWxzLmxpbmtSZW1vdmUgPSBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdSZW1vdmUgbGluaycsIGRhdGFzZXQ6IHsga2V5OiAnZm10LWxpbmstcmVtb3ZlJyB9LCBvbmNsaWNrOiByZW1vdmVMaW5rIH0pOwogICAgZWxzLmxpbmtiYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiA",
"nbmUtbGlua2JhcicsIGhpZGRlbjogdHJ1ZSB9LAogICAgICBpY29uKCdsaW5rJywgMTgpLCBlbHMubGlua0lucHV0LAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10b25hbCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQXBwbHknLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWFwcGx5JyB9LCBvbmNsaWNrOiBhcHBseUxpbmsgfSksCiAgICAgIGVscy5saW5rUmVtb3ZlLAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiAoKSA9PiBjbG9zZUxpbmsoKSB9KSwKICAgICAgZWxzLmxpbmtFcnJvcik7CgogICAgLy8gVGhlIHRhYmxlIGJhcjogdW5kZXIgdGhlIHRvb2xiYXIgd2hpbGUgdGhlIGN1cnNvciBpcyBpbiBhIGNlbGwuCiAgICBjb25zdCBrZWVwRm9jdXMgPSBlID0-IGUucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IG1lbnVCdXR0b24gPSAoa2V5LCBsYWJlbCwgaXRlbXMpID0-IHsKICAgICAgY29uc3QgYiA9IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ3RiLXRleHQnLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywgZGF0YXNldDogeyBrZXkgfSwKICAgICAgICBvbm1vdXNlZG93bjoga2VlcEZvY3VzLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgaWYgKGVkaXRhYmxlICYmIGNlbGxOb3coKSkgb3Blbk1",
"lbnUocm9vdCwgYiwgaXRlbXMoKSwgeyBsYWJlbCB9KTsgfSwKICAgICAgfSwgbGFiZWwsIGljb24oJ2NhcmV0JywgMTgpKTsKICAgICAgcmV0dXJuIGI7CiAgICB9OwogICAgZWxzLnRhYmxlSGVhZCA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICd0Yi10ZXh0JywgdHlwZTogJ2J1dHRvbicsICdhcmlhLXByZXNzZWQnOiAnZmFsc2UnLCB0aXRsZTogJ1RoZSBmaXJzdCByb3cgaXMgYSBoZWFkaW5nIHJvdycsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAndGFibGUtaGVhZCcgfSwgb25tb3VzZWRvd246IGtlZXBGb2N1cywgb25jbGljazogKCkgPT4gdG9nZ2xlSGVhZCgpLAogICAgfSwgJ0hlYWRpbmcgcm93Jyk7CiAgICBlbHMudGFibGViYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtdGFibGViYXInLCByb2xlOiAndG9vbGJhcicsICdhcmlhLWxhYmVsJzogJ1RhYmxlJywgaGlkZGVuOiB0cnVlIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndGItbGFiZWwnIH0sIGljb24oJ3RhYmxlJywgMTgpKSwKICAgICAgbWVudUJ1dHRvbigndGFibGUtcm93JywgJ1JvdycsICgpID0-IFsKICAgICAgICB7IGxhYmVsOiAnSW5zZXJ0IHJvdyBhYm92ZScsIGtleTogJ3Jvdy1hYm92ZScsIG9uU2VsZWN0OiAoKSA9PiBhZGRSb3coZmFsc2UpIH0sCiAgICAgICAgeyBsYWJlbDogJ0luc2VydCByb3cgYmVsb3cnLCBrZXk6ICdyb3ctYmVsb3cnLCBvblNlbGVjdDogKCkgPT4gYWRkUm93KHRydWUpIH0sCiAgICAgICAgeyBzZXB",
"hcmF0b3I6IHRydWUgfSwKICAgICAgICB7IGxhYmVsOiAnRGVsZXRlIHJvdycsIGtleTogJ3Jvdy1kZWxldGUnLCBkYW5nZXI6IHRydWUsIG9uU2VsZWN0OiAoKSA9PiBkZWxldGVSb3coKSB9LAogICAgICBdKSwKICAgICAgbWVudUJ1dHRvbigndGFibGUtY29sdW1uJywgJ0NvbHVtbicsICgpID0-IFsKICAgICAgICB7IGxhYmVsOiAnSW5zZXJ0IGNvbHVtbiBsZWZ0Jywga2V5OiAnY29sLWxlZnQnLCBvblNlbGVjdDogKCkgPT4gYWRkQ29sdW1uKGZhbHNlKSB9LAogICAgICAgIHsgbGFiZWw6ICdJbnNlcnQgY29sdW1uIHJpZ2h0Jywga2V5OiAnY29sLXJpZ2h0Jywgb25TZWxlY3Q6ICgpID0-IGFkZENvbHVtbih0cnVlKSB9LAogICAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgICAgeyBsYWJlbDogJ0RlbGV0ZSBjb2x1bW4nLCBrZXk6ICdjb2wtZGVsZXRlJywgZGFuZ2VyOiB0cnVlLCBvblNlbGVjdDogKCkgPT4gZGVsZXRlQ29sdW1uKCkgfSwKICAgICAgXSksCiAgICAgIGVscy50YWJsZUhlYWQsCiAgICAgIHNlcCgpLAogICAgICB0YkJ1dHRvbignYWxpZ24tbGVmdCcsICdBbGlnbiBjb2x1bW4gbGVmdCcsICdhbGlnbkxlZnQnLCAoKSA9PiBhbGlnbkNvbHVtbignJykpLAogICAgICB0YkJ1dHRvbignYWxpZ24tY2VudGVyJywgJ0NlbnRyZSBjb2x1bW4nLCAnYWxpZ25DZW50ZXInLCAoKSA9PiBhbGlnbkNvbHVtbignY2VudGVyJykpLAogICAgICB0YkJ1dHRvbignYWxpZ24tcmlnaHQnLCAnQWxpZ24gY29",
"sdW1uIHJpZ2h0JywgJ2FsaWduUmlnaHQnLCAoKSA9PiBhbGlnbkNvbHVtbigncmlnaHQnKSksCiAgICAgIHNlcCgpLAogICAgICBtZW51QnV0dG9uKCd0YWJsZS1zb3J0JywgJ1NvcnQnLCAoKSA9PiBbCiAgICAgICAgeyBsYWJlbDogJ1NvcnQgYnkgdGhpcyBjb2x1bW4sIEEgdG8gWicsIGtleTogJ3NvcnQtYXNjJywgb25TZWxlY3Q6ICgpID0-IHNvcnRSb3dzKGZhbHNlKSB9LAogICAgICAgIHsgbGFiZWw6ICdTb3J0IGJ5IHRoaXMgY29sdW1uLCBaIHRvIEEnLCBrZXk6ICdzb3J0LWRlc2MnLCBvblNlbGVjdDogKCkgPT4gc29ydFJvd3ModHJ1ZSkgfSwKICAgICAgXSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3BhY2VyJyB9KSwKICAgICAgdGJCdXR0b24oJ3RhYmxlLWRlbGV0ZScsICdEZWxldGUgdGFibGUnLCAnZGVsZXRlJywgKCkgPT4gZGVsZXRlVGFibGUoKSwgZmFsc2UpKTsKCiAgICBmdW5jdGlvbiBkZWxldGVUYWJsZSgpIHsKICAgICAgdGFibGVFZGl0KCh0ZCwgZWwpID0-IHJlbW92ZVRhYmxlKGVsKSk7CiAgICB9CgogICAgZnVuY3Rpb24gY3VycmVudFR5cGUoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpIHx8IHNhdmVkOwogICAgICBjb25zdCBibGsgPSByICYmIGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIHJldHVybiBibGsgPyBibGsuZGF0YXNldC50eXBlIHx8ICdwJyA6ICdwJzsKICAgIH0KCiAgICBmdW5jdGlvbiByZWZyZXNoVG9vbGJhcigpIHsKICAgICAgY29uc3QgciA",
"9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gY3VycmVudFR5cGUoKTsKICAgICAgZWxzLnN0eWxlTGFiZWwudGV4dENvbnRlbnQgPSBTVFlMRV9MQUJFTFt0eXBlXSB8fCAnTm9ybWFsIHRleHQnOwogICAgICBmb3IgKGNvbnN0IFtrZXksIGNtZF0gb2YgW1snYm9sZCcsICdib2xkJ10sIFsnaXRhbGljJywgJ2l0YWxpYyddLCBbJ3N0cmlrZScsICdzdHJpa2VUaHJvdWdoJ11dKSB7CiAgICAgICAgbGV0IG9uID0gZmFsc2U7CiAgICAgICAgdHJ5IHsgb24gPSBkb2N1bWVudC5xdWVyeUNvbW1hbmRTdGF0ZShjbWQpOyB9IGNhdGNoIHsgLyogbm90IHN1cHBvcnRlZCAqLyB9CiAgICAgICAgYnV0dG9uc1trZXldLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKG9uKSk7CiAgICAgIH0KICAgICAgZm9yIChjb25zdCB0IG9mIFsndWwnLCAnb2wnLCAnY2hlY2snXSkgYnV0dG9uc1t0XS5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyh0eXBlID09PSB0KSk7CiAgICAgIGJ1dHRvbnMubGluay5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyghIWFuY2hvckF0KHIpKSk7CiAgICAgIC8vIEluIGEgY2VsbDogdGhlIHRhYmxlIGJhciwgYW5kIG5vdGhpbmcgdGhhdCBtYWtlcyBsaXN0cyBvciBoZWFkaW5ncy4KICAgICAgY29uc3QgdGQgPSBjZWxsT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIGlmICh0ZCkgbGFzdENlbGwgPSB0ZDsKICA",
"gICAgZWxzLnRhYmxlYmFyLmhpZGRlbiA9ICF0ZCB8fCAhZWRpdGFibGU7CiAgICAgIGZvciAoY29uc3QgayBvZiBbJ3VsJywgJ29sJywgJ2NoZWNrJywgJ291dGRlbnQnLCAnaW5kZW50JywgJ3RhYmxlJ10pIGJ1dHRvbnNba10uZGlzYWJsZWQgPSAhZWRpdGFibGUgfHwgISF0ZDsKICAgICAgZWxzLnN0eWxlLmRpc2FibGVkID0gIWVkaXRhYmxlIHx8ICEhdGQ7CiAgICAgIGlmICh0ZCkgewogICAgICAgIGNvbnN0IGVsID0gdGFibGVPZih0ZCk7CiAgICAgICAgZWxzLnRhYmxlSGVhZC5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyhlbC5kYXRhc2V0LmhlYWQgPT09ICcxJykpOwogICAgICAgIGNvbnN0IGEgPSBhbGlnbnMoZWwpW3RkLmNlbGxJbmRleF0gfHwgJyc7CiAgICAgICAgYnV0dG9uc1snYWxpZ24tbGVmdCddLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKGEgPT09ICcnKSk7CiAgICAgICAgYnV0dG9uc1snYWxpZ24tY2VudGVyJ10uc2V0QXR0cmlidXRlKCdhcmlhLXByZXNzZWQnLCBTdHJpbmcoYSA9PT0gJ2NlbnRlcicpKTsKICAgICAgICBidXR0b25zWydhbGlnbi1yaWdodCddLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKGEgPT09ICdyaWdodCcpKTsKICAgICAgfQogICAgfQoKICAgIC8vIOKUgOKUgCBUaGUgZWRpdGFibGUgYXJlYSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBlbHMuZWRpdG9yID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ25lLWJvZHknLCByb2xlOiAndGV4dGJveCcsICdhcmlhLW11bHRpbGluZSc6ICd0cnVlJywgJ2FyaWEtbGFiZWwnOiAnTm90ZScsCiAgICAgIHNwZWxsY2hlY2s6ICd0cnVlJywgZGF0YXNldDogeyBrZXk6ICdub3RlLWJvZHknLCBlbXB0eTogJzEnIH0sCiAgICB9KTsKCiAgICBlbHMuZWRpdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBlID0-IHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuOwogICAgICBjb25zdCBtb2QgPSBlLmN0cmxLZXkgfHwgZS5tZXRhS2V5OwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgY29uc3QgYmxrID0gciAmJiBibG9ja09mKHIuc3RhcnRDb250YWluZXIpOwogICAgICBjb25zdCB0ZCA9IHIgJiYgY2VsbE9mKHIuc3RhcnRDb250YWluZXIpOwogICAgICBpZiAodGQgJiYgY2VsbEtleShlLCB0ZCwgciwgbW9kKSkgcmV0dXJuOwogICAgICBpZiAoIXRkICYmIGJsayAmJiBiZXNpZGVUYWJsZShlLCByLCBibGssIG1vZCkpIHJldHVybjsKCiAgICAgIGlmIChtb2QgJiYgIWUuYWx0S2V5ICYmICFlLnNoaWZ0S2V5ICYmIGUua2V5LnRvTG93ZXJDYXNlKCkgPT09ICd6JyAmJiBwYXN0ZVVuZG8ubGVuZ3RoKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCg",
"pOwogICAgICAgIHVuZG9QYXN0ZSgpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBpZiAobW9kICYmICFlLmFsdEtleSAmJiBlLnNoaWZ0S2V5ICYmIGUua2V5LnRvTG93ZXJDYXNlKCkgPT09ICd2JykgewogICAgICAgIC8vIFRoZSBwYXN0ZSBldmVudCBmb2xsb3dzIHN0cmFpZ2h0IGF3YXksIGluIHRoaXMgc2FtZSB0YXNrLgogICAgICAgIHBsYWluTmV4dCA9IHRydWU7CiAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7IHBsYWluTmV4dCA9IGZhbHNlOyB9LCAwKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKG1vZCAmJiAhZS5hbHRLZXkgJiYgZS5zaGlmdEtleSAmJiAvXkRpZ2l0Wzc4OV0kLy50ZXN0KGUuY29kZSkpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgYmxvY2tUeXBlKHsgRGlnaXQ3OiAnb2wnLCBEaWdpdDg6ICd1bCcsIERpZ2l0OTogJ2NoZWNrJyB9W2UuY29kZV0pOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBpZiAobW9kICYmICFlLnNoaWZ0S2V5ICYmICFlLmFsdEtleSkgewogICAgICAgIGNvbnN0IGsgPSBlLmtleS50b0xvd2VyQ2FzZSgpOwogICAgICAgIGlmIChrID09PSAnaycpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBvcGVuTGluaygpOyByZXR1cm47IH0KICAgICAgICBpZiAoayA9PT0gJ3UnKSB7IGUucHJldmVudERlZmF1bHQoKTsgcmV0dXJuOyB9IC8vIG5vIHVuZGVybGluZSBpbiB0aGUgbW9kZWwKICAgICAgICBpZiAoZS5rZXk",
"gPT09ICdFbnRlcicgJiYgYmxrICYmIGJsay5kYXRhc2V0LnR5cGUgPT09ICdjaGVjaycpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyB0b2dnbGVDaGVjayhibGspOyByZXR1cm47IH0KICAgICAgfQogICAgICBpZiAoZS5rZXkgPT09ICdUYWInICYmICFtb2QgJiYgIWUuYWx0S2V5ICYmIGJsayAmJiBmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V0LnR5cGUpKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGluZGVudChlLnNoaWZ0S2V5ID8gLTEgOiAxKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFtb2QgJiYgIWUuYWx0S2V5ICYmICFlLmlzQ29tcG9zaW5nKSB7CiAgICAgICAgLy8gQW4gZW1wdHkgbGlzdCBpdGVtIGVuZHMgdGhlIGxpc3Q7IFNoaWZ0K0VudGVyIGlzIGEgbmV3IGxpbmUgbGlrZQogICAgICAgIC8vIGFueSBvdGhlciwgc2luY2UgdGhlIG1vZGVsIGhhcyBubyBsaW5lIGJyZWFrcyBpbnNpZGUgYSBibG9jay4KICAgICAgICBpZiAoYmxrICYmIGZtdC5MSVNUUy5oYXMoYmxrLmRhdGFzZXQudHlwZSkgJiYgIWJsay50ZXh0Q29udGVudCkgewogICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgICAgY29uc3QgbHZsID0gTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwOwogICAgICAgICAgaWYgKGx2bCA-IDApIGJsay5kYXRhc2V0LmxldmVsID0gU3RyaW5nKGx2bCAtIDEpOwogICAgICAgICAgZWxzZSBzZXRCbG9",
"jayhibGssICdwJyk7CiAgICAgICAgICBjaGFuZ2VkKCk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGlmIChlLnNoaWZ0S2V5KSB7CiAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnaW5zZXJ0UGFyYWdyYXBoJyk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChlLmtleSA9PT0gJ0JhY2tzcGFjZScgJiYgIW1vZCAmJiBibGsgJiYgYmxrLmRhdGFzZXQudHlwZSAhPT0gJ3AnICYmIGNhcmV0QXRCbG9ja1N0YXJ0KHIsIGJsaykpIHsKICAgICAgICAvLyBBdCB0aGUgc3RhcnQgb2YgYSBsaXN0IGl0ZW0gb3IgaGVhZGluZywgQmFja3NwYWNlIHVuZG9lcyB0aGUKICAgICAgICAvLyBmb3JtYXR0aW5nIGJlZm9yZSBpdCBzdGFydHMgam9pbmluZyBsaW5lcy4KICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgY29uc3QgbHZsID0gTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwOwogICAgICAgIGlmIChmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V0LnR5cGUpICYmIGx2bCA-IDApIGJsay5kYXRhc2V0LmxldmVsID0gU3RyaW5nKGx2bCAtIDEpOwogICAgICAgIGVsc2Ugc2V0QmxvY2soYmxrLCAncCcpOwogICAgICAgIGNoYW5nZWQoKTsKICAgICAgfQogICAgfSk7CgogICAgZWxzLmVkaXRvci5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIGUgPT4gewogICAgICBpZiAoZS5pbnB1dFR5cGU",
"gPT09ICdpbnNlcnRUZXh0JyAmJiAoZS5kYXRhID09PSAnICcgfHwgZS5kYXRhID09PSAnwqAnKSkgYXV0b2Zvcm1hdCgpOwogICAgICBpZiAoZS5pbnB1dFR5cGUgPT09ICdpbnNlcnRQYXJhZ3JhcGgnKSB7CiAgICAgICAgLy8gVGhlIG5ldyBibG9jayBpcyBhIGNvcHkgb2YgdGhlIG9uZSBpdCB3YXMgc3BsaXQgZnJvbTogYSB0aWNrZWQKICAgICAgICAvLyBib3ggYW5kIGEgaGVhZGluZyBzaG91bGQgbm90IGNhcnJ5IG9uIGludG8gYW4gZW1wdHkgbmV3IGxpbmUuCiAgICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgICAgY29uc3QgYmxrID0gciAmJiBibG9ja09mKHIuc3RhcnRDb250YWluZXIpOwogICAgICAgIGlmIChibGsgJiYgIWJsay50ZXh0Q29udGVudCkgewogICAgICAgICAgaWYgKGJsay5kYXRhc2V0LnR5cGUgPT09ICdjaGVjaycpIGJsay5kYXRhc2V0LmNoZWNrZWQgPSAnMCc7CiAgICAgICAgICBpZiAoL15oWzEyM10kLy50ZXN0KGJsay5kYXRhc2V0LnR5cGUpKSBzZXRCbG9jayhibGssICdwJyk7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmICgvXmRlbGV0ZS8udGVzdChlLmlucHV0VHlwZSkgJiYgZWxzLmVkaXRvci5jaGlsZHJlbi5sZW5ndGggPT09IDEgJiYgIWVscy5lZGl0b3IudGV4dENvbnRlbnQpIHsKICAgICAgICAvLyBFdmVyeXRoaW5nIGRlbGV0ZWQ6IHRoZSBub3RlIHN0YXJ0cyBhZ2FpbiBmcm9tIG5vcm1hbCB0ZXh0LgogICAgICAgIHNldEJsb2NrKGVscy5lZGl0b3IuZmlyc3R",
"FbGVtZW50Q2hpbGQsICdwJyk7CiAgICAgIH0KICAgICAgY2hhbmdlZCgpOwogICAgfSk7CgogICAgZnVuY3Rpb24gYXV0b2Zvcm1hdCgpIHsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghciB8fCAhci5jb2xsYXBzZWQpIHJldHVybjsKICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKTsKICAgICAgaWYgKCFibGsgfHwgYmxrLmRhdGFzZXQudHlwZSAhPT0gJ3AnKSByZXR1cm47CiAgICAgIGNvbnN0IHByZSA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIHByZS5zZWxlY3ROb2RlQ29udGVudHMoYmxrKTsKICAgICAgcHJlLnNldEVuZChyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0KTsKICAgICAgY29uc3QgbSA9IC9eKFxTezEsM30pWyDCoF0kLy5leGVjKHByZS50b1N0cmluZygpKTsKICAgICAgY29uc3QgcnVsZSA9IG0gJiYgQVVUTy5maW5kKChbcmVdKSA9PiByZS50ZXN0KG1bMV0pKTsKICAgICAgaWYgKCFydWxlKSByZXR1cm47CiAgICAgIHNlbGVjdChwcmUpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnZGVsZXRlJyk7CiAgICAgIHNldEJsb2NrKGJsaywgcnVsZVsxXS50eXBlLCAwLCAhIXJ1bGVbMV0uY2hlY2tlZCk7CiAgICB9CgogICAgZWxzLmVkaXRvci5hZGRFdmVudExpc3RlbmVyKCdwYXN0ZScsIGUgPT4gewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgY29uc3QgZGF",
"0YSA9IGUuY2xpcGJvYXJkRGF0YTsKICAgICAgY29uc3QgdGV4dCA9IChkYXRhICYmIGRhdGEuZ2V0RGF0YSgndGV4dC9wbGFpbicpKSB8fCAnJzsKICAgICAgY29uc3QgcGxhaW4gPSBwbGFpbk5leHQ7CiAgICAgIHBsYWluTmV4dCA9IGZhbHNlOwogICAgICBjb25zdCBkb2MgPSBwbGFpbiA_IG51bGwgOiBmbXQucGFzdGVEb2MoeyBodG1sOiBkYXRhICYmIGRhdGEuZ2V0RGF0YSgndGV4dC9odG1sJyksIHRleHQgfSk7CiAgICAgIGNvbnN0IGF0ID0gcmFuZ2UoKTsKICAgICAgaWYgKGF0ICYmIGNlbGxPZihhdC5zdGFydENvbnRhaW5lcikpIHsKICAgICAgICBwYXN0ZUluQ2VsbChkb2MsIHRleHQpOwogICAgICAgIHJldmVhbENhcmV0KCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIC8vIFRleHQgd2l0aCBub3RoaW5nIHRvIGZvcm1hdCBnb2VzIGluIHRoZSB3YXkgdHlwaW5nIGRvZXMsIHNvIHRoZQogICAgICAvLyBicm93c2VyJ3Mgb3duIHVuZG8gdGFrZXMgaXQgYmFjazogYSBzaW5nbGUgbGluZSBhcyBjb3BpZWQsIHNwYWNlcwogICAgICAvLyBhbmQgYWxsOyBtb3JlIHRoYW4gdGhhdCBhcyB0aGUgSFRNTCByZWFkcyAoYSB0YWJsZSdzICIgfCAiLCBub3QKICAgICAgLy8gaXRzIHRhYnMpLgogICAgICBjb25zdCBsaW5lID0gdGV4dC5yZXBsYWNlKC9bXHJcbl0rJC8sICcnKTsKICAgICAgaWYgKGRvYyAmJiBmbXQuaGFzRm9ybWF0dGluZyhkb2MpKSBpbnNlcnREb2MoZG9jKTsKICAgICAgZWxzZSBpZiA",
"oZG9jICYmICEoZG9jLmxlbmd0aCA9PT0gMSAmJiBsaW5lICYmICEvW1xyXG5cdF0vLnRlc3QobGluZSkpKSBpbnNlcnRQbGFpbihmbXQuZG9jVGV4dChkb2MpKTsKICAgICAgZWxzZSBpbnNlcnRQbGFpbihkb2MgPyBsaW5lIDogdGV4dCk7CiAgICAgIHJldmVhbENhcmV0KCk7CiAgICB9KTsKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcignZHJvcCcsIGUgPT4gewogICAgICAvLyBEcm9wcGVkIEhUTUwgd291bGQgYnJpbmcgaXRzIG93biBtYXJrdXA7IGRyb3BwZWQgZmlsZXMgaGF2ZSBub3doZXJlIHRvIGdvLgogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICB9KTsKCiAgICBmdW5jdGlvbiBpbnNlcnRQbGFpbih0ZXh0KSB7CiAgICAgIGNvbnN0IGxpbmVzID0gU3RyaW5nKHRleHQpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNwbGl0KCdcbicpOwogICAgICBsaW5lcy5mb3JFYWNoKChsaW5lLCBpKSA9PiB7CiAgICAgICAgaWYgKGkpIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRQYXJhZ3JhcGgnKTsKICAgICAgICBpZiAobGluZSkgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2luc2VydFRleHQnLCBmYWxzZSwgbGluZSk7CiAgICAgIH0pOwogICAgfQoKICAgIC8vIOKUgOKUgCBGb3JtYXR0ZWQgcGFzdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAvLwogICAgLy8gVGhlIGJsb2NrcyBnbyBpbiBkaXJlY3RseSAtIHRoZSBicm93c2VyJ3MgZWRpdGluZyBjb21tYW5kcyB3b3VsZAogICAgLy8gbmVzdCBhbmQgcmVzdHlsZSB0aGVtIC0gd2l0aCB0aGUgdGV4dCBhZnRlciB0aGUgY2FyZXQgY2FycmllZCB0bwogICAgLy8gdGhlIGVuZCBvZiB3aGF0IHdhcyBwYXN0ZWQuIFRoZSBicm93c2VyJ3MgdW5kbyBkb2VzIG5vdCBrbm93IGFib3V0CiAgICAvLyB0aGF0LCBzbyBDdHJsK1ogc3RyYWlnaHQgYWZ0ZXJ3YXJkcyBwdXRzIGJhY2sgYSBjb3B5IHRha2VuIGZpcnN0IC0KICAgIC8vIG9uZSBwYXN0ZSBhdCBhIHRpbWUsIHVudGlsIGFueXRoaW5nIGVsc2UgY2hhbmdlcyB0aGUgdGV4dC4KCiAgICAvLyBFbXB0eSB0ZXh0IGFuZCBlbXB0eSBtYXJrcyBsZWZ0IGJlaGluZCBieSBjdXR0aW5nIGEgYmxvY2sgaW4gdHdvOwogICAgLy8gYWxzbyB0aGUgPGJyPiB0aGF0IGhvbGRzIGFuIGVtcHR5IGJsb2NrIG9wZW4sIHB1dCBiYWNrIGxhdGVyIGlmCiAgICAvLyB0aGUgYmxvY2sgaXMgc3RpbGwgZW1wdHkuCiAgICBmdW5jdGlvbiBwcnVuZShlbCkgewogICAgICBmb3IgKGNvbnN0IG4gb2YgWy4uLmVsLmNoaWxkTm9kZXNdKSB7CiAgICAgICAgaWYgKG4ubm9kZVR5cGUgPT09IDMpIHsgaWYgKCFuLmRhdGEpIG4ucmVtb3ZlKCk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKG4ubm9kZVR5cGUgIT09IDE",
"gfHwgbi50YWdOYW1lID09PSAnQlInKSB7IG4ucmVtb3ZlKCk7IGNvbnRpbnVlOyB9CiAgICAgICAgcHJ1bmUobik7CiAgICAgICAgaWYgKCFuLmZpcnN0Q2hpbGQpIG4ucmVtb3ZlKCk7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGhvbGRPcGVuID0gZWwgPT4geyBpZiAoIWVsLmZpcnN0Q2hpbGQpIGVsLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2JyJykpOyB9OwoKICAgIGZ1bmN0aW9uIGluc2VydERvYyhkb2MpIHsKICAgICAgaWYgKCFyYW5nZSgpKSByZXN0b3JlKCk7CiAgICAgIGlmICghcmFuZ2UoKSkgcmV0dXJuOwogICAgICBjb25zdCB1bmRvID0gcGFzdGVVbmRvOwogICAgICBjb25zdCBiZWZvcmUgPSBzbmFwc2hvdCgpOwogICAgICBpZiAoIXJhbmdlKCkuY29sbGFwc2VkKSBkb2N1bWVudC5leGVjQ29tbWFuZCgnZGVsZXRlJyk7CiAgICAgIHRpZHkoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwoKICAgICAgbGV0IG5vZGUgPSByLnN0YXJ0Q29udGFpbmVyOwogICAgICBsZXQgb2Zmc2V0ID0gci5zdGFydE9mZnNldDsKICAgICAgaWYgKG5vZGUgPT09IGVscy5lZGl0b3IpIHsKICAgICAgICBjb25zdCBraWRzID0gZWxzLmVkaXRvci5jaGlsZHJlbjsKICAgICAgICBjb25zdCBrID0gTWF0aC5taW4ob2Zmc2V0LCBraWRzLmxlbmd0aCAtIDEpOwogICAgICAgIG5vZGUgPSBraWRzW2tdOwogICAgICAgIG9mZnNldCA9IGsgPCBvZmZzZXQgPyBub2R",
"lLmNoaWxkTm9kZXMubGVuZ3RoIDogMDsKICAgICAgfQogICAgICBjb25zdCBibGsgPSBibG9ja09mKG5vZGUpOwogICAgICBpZiAoIWJsaykgcmV0dXJuOwoKICAgICAgLy8gQ3V0IHRoZSBibG9jayBhdCB0aGUgY2FyZXQuCiAgICAgIGNvbnN0IGN1dCA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIGN1dC5zZXRTdGFydChub2RlLCBvZmZzZXQpOwogICAgICBjdXQuc2V0RW5kKGJsaywgYmxrLmNoaWxkTm9kZXMubGVuZ3RoKTsKICAgICAgY29uc3QgYWZ0ZXIgPSBjdXQuZXh0cmFjdENvbnRlbnRzKCk7CiAgICAgIHBydW5lKGFmdGVyKTsKICAgICAgcHJ1bmUoYmxrKTsKCiAgICAgIGNvbnN0IG9yaWcgPSB7IHR5cGU6IGJsay5kYXRhc2V0LnR5cGUgfHwgJ3AnLCBsZXZlbDogTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwLCBjaGVja2VkOiBibGsuZGF0YXNldC5jaGVja2VkID09PSAnMScgfTsKICAgICAgLy8gTGlzdHMgcGFzdGVkIGludG8gYSBsaXN0IGdvIGluIGF0IGl0cyBsZXZlbC4KICAgICAgY29uc3QgYmFzZSA9IGZtdC5MSVNUUy5oYXMob3JpZy50eXBlKSA_IG9yaWcubGV2ZWwgOiAwOwogICAgICBjb25zdCBsZXZlbE9mID0gYiA9PiAoZm10LkxJU1RTLmhhcyhiLnR5cGUpID8gTWF0aC5taW4oZm10Lk1BWF9MRVZFTCwgYi5sZXZlbCArIGJhc2UpIDogMCk7CgogICAgICBsZXQgbGFzdCA9IGJsazsKICAgICAgbGV0IGkgPSAwOwogICAgICAvLyBUaGUgZmlyc3QgbGluZSBqb2lucyB0aGU",
"gdGV4dCBiZWZvcmUgdGhlIGNhcmV0OyBvbiBhbiBlbXB0eSBsaW5lCiAgICAgIC8vIGl0IGFsc28gYnJpbmdzIGl0cyBraW5kIChhIGhlYWRpbmcsIGEgbGlzdCBpdGVtKSB3aXRoIGl0LgogICAgICBpZiAoZG9jWzBdLnR5cGUgIT09ICd0YWJsZScgJiYgKGRvY1swXS50eXBlID09PSAncCcgfHwgIWJsay50ZXh0Q29udGVudCkpIHsKICAgICAgICBpZiAoIWJsay50ZXh0Q29udGVudCAmJiBkb2NbMF0udHlwZSAhPT0gJ3AnKSBzZXRCbG9jayhibGssIGRvY1swXS50eXBlLCBsZXZlbE9mKGRvY1swXSksIGRvY1swXS5jaGVja2VkKTsKICAgICAgICBibGsuYXBwZW5kKC4uLmlubGluZU5vZGVzKGRvY1swXS5ydW5zKSk7CiAgICAgICAgaSA9IDE7CiAgICAgIH0KICAgICAgZm9yICg7IGkgPCBkb2MubGVuZ3RoOyBpKyspIHsKICAgICAgICBjb25zdCBlbCA9IGJsb2NrRWwoeyAuLi5kb2NbaV0sIGxldmVsOiBsZXZlbE9mKGRvY1tpXSkgfSk7CiAgICAgICAgbGFzdC5hZnRlcihlbCk7CiAgICAgICAgbGFzdCA9IGVsOwogICAgICB9CgogICAgICAvLyBUaGUgdGV4dCBhZnRlciB0aGUgY2FyZXQgZm9sbG93cyB0aGUgcGFzdGVkIHRleHQgLSBvbiBhIGxpbmUgb2YKICAgICAgLy8gaXRzIG93biBraW5kIGlmIHRoZSBwYXN0ZSBlbmRlZCBvbiBhIGRpZmZlcmVudCBraW5kIG9mIGxpbmUuCiAgICAgIGNvbnN0IGtpbmQgPSBlbCA9PiBgJHtlbC5kYXRhc2V0LnR5cGV9OiR7ZWwuZGF0YXNldC5sZXZlbCB8fCAwfWA7CiAgICA",
"gIGxldCB0YXJnZXQgPSBsYXN0OwogICAgICBpZiAoYWZ0ZXIudGV4dENvbnRlbnQgJiYgbGFzdCAhPT0gYmxrICYmIGtpbmQobGFzdCkgIT09IGAke29yaWcudHlwZX06JHtiYXNlfWApIHsKICAgICAgICB0YXJnZXQgPSBibG9ja0VsKGZtdC5ibG9jayhvcmlnLnR5cGUsIFtdLCBvcmlnKSk7CiAgICAgICAgdGFyZ2V0LnJlcGxhY2VDaGlsZHJlbigpOwogICAgICAgIGxhc3QuYWZ0ZXIodGFyZ2V0KTsKICAgICAgfQogICAgICAvLyBOb3RoaW5nIGdvZXMgaW50byBhIHBhc3RlZCB0YWJsZTogdGhlIGN1cnNvciBnb2VzIHRvIGEgbGluZSBhZnRlciBpdC4KICAgICAgaWYgKGxhc3QuZGF0YXNldC50eXBlID09PSAndGFibGUnICYmIHRhcmdldCA9PT0gbGFzdCkgewogICAgICAgIHRhcmdldCA9IGJsb2NrRWwoZm10LmJsb2NrKCdwJykpOwogICAgICAgIHRhcmdldC5yZXBsYWNlQ2hpbGRyZW4oKTsKICAgICAgICBsYXN0LmFmdGVyKHRhcmdldCk7CiAgICAgIH0KICAgICAgaWYgKGxhc3QuZGF0YXNldC50eXBlICE9PSAndGFibGUnKSBwcnVuZShsYXN0KTsKICAgICAgY29uc3QgYXQgPSB0YXJnZXQgPT09IGxhc3QgPyBsYXN0LmNoaWxkTm9kZXMubGVuZ3RoIDogMDsKICAgICAgdGFyZ2V0LmFwcGVuZChhZnRlcik7CiAgICAgIGhvbGRPcGVuKGJsayk7CiAgICAgIGlmIChsYXN0LmRhdGFzZXQudHlwZSAhPT0gJ3RhYmxlJykgaG9sZE9wZW4obGFzdCk7CiAgICAgIGhvbGRPcGVuKHRhcmdldCk7CiAgICAgIC8vIEEgdGF",
"ibGUgcGFzdGVkIG9uIGFuIGVtcHR5IGxpbmUgdGFrZXMgaXRzIHBsYWNlLgogICAgICBpZiAoZG9jWzBdLnR5cGUgPT09ICd0YWJsZScgJiYgIWJsay50ZXh0Q29udGVudCAmJiBibGsgIT09IHRhcmdldCkgYmxrLnJlbW92ZSgpOwogICAgICBpZiAobGFzdC5kYXRhc2V0LnR5cGUgPT09ICd0YWJsZScpIGNhcmV0SW50byh0YXJnZXQsIGZhbHNlKTsKICAgICAgZWxzZSBpZiAodGFyZ2V0ID09PSBsYXN0KSBwbGFjZUNhcmV0KGxhc3QsIGF0KTsKICAgICAgZWxzZSBwbGFjZUNhcmV0KGxhc3QsIGxhc3QuZmlyc3RDaGlsZC5ub2RlTmFtZSA9PT0gJ0JSJyA_IDAgOiBsYXN0LmNoaWxkTm9kZXMubGVuZ3RoKTsKCiAgICAgIGNoYW5nZWQoKTsKICAgICAgcGFzdGVVbmRvID0gWy4uLnVuZG8uc2xpY2UoLTE5KSwgYmVmb3JlXTsKICAgIH0KCiAgICAvLyBUaGUgZWRpdG9yJ3MgYmxvY2tzLCBhbmQgdGhlIHNlbGVjdGlvbiBhcyB0ZXh0IG9mZnNldHMgd2l0aGluIHRoZW0uCiAgICBmdW5jdGlvbiBzbmFwc2hvdCgpIHsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIHJldHVybiB7CiAgICAgICAgbm9kZXM6IFsuLi5lbHMuZWRpdG9yLmNoaWxkTm9kZXNdLm1hcChuID0-IG4uY2xvbmVOb2RlKHRydWUpKSwKICAgICAgICBzdGFydDogciAmJiB3aGVyZShyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0KSwKICAgICAgICBlbmQ6IHIgJiYgd2hlcmUoci5lbmRDb250YWluZXIsIHIuZW5kT2Zmc2V0KSwKICAgICA",
"gfTsKICAgIH0KCiAgICBmdW5jdGlvbiB3aGVyZShub2RlLCBvZmZzZXQpIHsKICAgICAgY29uc3Qga2lkcyA9IFsuLi5lbHMuZWRpdG9yLmNoaWxkTm9kZXNdOwogICAgICBpZiAobm9kZSA9PT0gZWxzLmVkaXRvcikgewogICAgICAgIGNvbnN0IGsgPSBNYXRoLm1pbihvZmZzZXQsIGtpZHMubGVuZ3RoIC0gMSk7CiAgICAgICAgcmV0dXJuIGsgPCAwID8gbnVsbCA6IHsgYjogaywgbzogayA8IG9mZnNldCA_IGtpZHNba10udGV4dENvbnRlbnQubGVuZ3RoIDogMCB9OwogICAgICB9CiAgICAgIGNvbnN0IGJsayA9IGJsb2NrT2Yobm9kZSk7CiAgICAgIGlmICghYmxrKSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgcHJlLnNlbGVjdE5vZGVDb250ZW50cyhibGspOwogICAgICBwcmUuc2V0RW5kKG5vZGUsIG9mZnNldCk7CiAgICAgIHJldHVybiB7IGI6IGtpZHMuaW5kZXhPZihibGspLCBvOiBwcmUudG9TdHJpbmcoKS5sZW5ndGggfTsKICAgIH0KCiAgICBmdW5jdGlvbiBwb2ludEF0KHApIHsKICAgICAgY29uc3QgYmxrID0gcCAmJiBlbHMuZWRpdG9yLmNoaWxkTm9kZXNbcC5iXTsKICAgICAgaWYgKCFibGspIHJldHVybiBudWxsOwogICAgICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKGJsaywgTm9kZUZpbHRlci5TSE9XX1RFWFQpOwogICAgICBsZXQgbGVmdCA9IHAubzsKICAgICAgZm9yIChsZXQgbiA9IHdhbGtlci5uZXh",
"0Tm9kZSgpOyBuOyBuID0gd2Fsa2VyLm5leHROb2RlKCkpIHsKICAgICAgICBpZiAobGVmdCA8PSBuLmRhdGEubGVuZ3RoKSByZXR1cm4gW24sIGxlZnRdOwogICAgICAgIGxlZnQgLT0gbi5kYXRhLmxlbmd0aDsKICAgICAgfQogICAgICByZXR1cm4gW2JsaywgMF07CiAgICB9CgogICAgZnVuY3Rpb24gdW5kb1Bhc3RlKCkgewogICAgICBjb25zdCByZXN0ID0gcGFzdGVVbmRvLnNsaWNlKDAsIC0xKTsKICAgICAgY29uc3Qgc25hcCA9IHBhc3RlVW5kb1twYXN0ZVVuZG8ubGVuZ3RoIC0gMV07CiAgICAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKC4uLnNuYXAubm9kZXMpOwogICAgICBjb25zdCBhID0gcG9pbnRBdChzbmFwLnN0YXJ0KTsKICAgICAgY29uc3QgeiA9IHBvaW50QXQoc25hcC5lbmQpOwogICAgICBpZiAoYSAmJiB6KSB7CiAgICAgICAgY29uc3QgYmFjayA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgYmFjay5zZXRTdGFydCguLi5hKTsKICAgICAgICBiYWNrLnNldEVuZCguLi56KTsKICAgICAgICBzZWxlY3QoYmFjayk7CiAgICAgIH0KICAgICAgY2hhbmdlZCgpOwogICAgICBwYXN0ZVVuZG8gPSByZXN0OwogICAgICByZXZlYWxDYXJldCgpOwogICAgfQoKICAgIC8vIFNjcm9sbHMgdGhlIGVkaXRvciwgaWYgaXQgaGFzIHRvLCB0byBzaG93IHRoZSBjYXJldC4KICAgIGZ1bmN0aW9uIHJldmVhbENhcmV0KCkgewogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyKSB",
"yZXR1cm47CiAgICAgIGxldCBhdCA9IHIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICAgIGlmICghYXQuaGVpZ2h0KSB7CiAgICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKTsKICAgICAgICBpZiAoYmxrKSBhdCA9IGJsay5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgfQogICAgICBjb25zdCBib3ggPSBlbHMuZWRpdG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICBpZiAoYXQuYm90dG9tID4gYm94LmJvdHRvbSAtIDgpIGVscy5lZGl0b3Iuc2Nyb2xsVG9wICs9IGF0LmJvdHRvbSAtIGJveC5ib3R0b20gKyAyNDsKICAgICAgZWxzZSBpZiAoYXQudG9wIDwgYm94LnRvcCArIDgpIGVscy5lZGl0b3Iuc2Nyb2xsVG9wIC09IGJveC50b3AgLSBhdC50b3AgKyAyNDsKICAgIH0KCiAgICBlbHMuZWRpdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZSA9PiB7CiAgICAgIGNvbnN0IGEgPSBlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0LmNsb3Nlc3QoJ2FbaHJlZl0nKTsKICAgICAgaWYgKGEgJiYgKGUuY3RybEtleSB8fCBlLm1ldGFLZXkpKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIHdpbmRvdy5vcGVuKGEuaHJlZiwgJ19ibGFuaycsICdub29wZW5lcicpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICAvLyBUaGUgYm94IGlzIGRyYXduIGluIHRoZSBibG9jaydzIGxlZnQgcGFkZGluZywgYXQgaXRzIGluZGVudC4KICAgICA",
"gY29uc3QgYmxrID0gZS50YXJnZXQuY2xvc2VzdCAmJiBlLnRhcmdldC5jbG9zZXN0KCcuYmxrW2RhdGEtdHlwZT0iY2hlY2siXScpOwogICAgICBpZiAoYmxrICYmIGVkaXRhYmxlKSB7CiAgICAgICAgY29uc3QgeCA9IGUuY2xpZW50WCAtIGJsay5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5sZWZ0OwogICAgICAgIGNvbnN0IGF0ID0gKE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMCkgKiBJTkRFTlRfUFg7CiAgICAgICAgaWYgKHggPj0gYXQgJiYgeCA8IGF0ICsgMjYpIHRvZ2dsZUNoZWNrKGJsayk7CiAgICAgIH0KICAgIH0pOwoKICAgIGNvbnN0IG9uU2VsZWN0aW9uID0gKCkgPT4gewogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyKSByZXR1cm47CiAgICAgIHNhdmVkID0gci5jbG9uZVJhbmdlKCk7CiAgICAgIHJlZnJlc2hUb29sYmFyKCk7CiAgICB9OwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignc2VsZWN0aW9uY2hhbmdlJywgb25TZWxlY3Rpb24pOwoKICAgIC8vIOKUgOKUgCBTZWFyY2ggaGlnaGxpZ2h0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIC8vCiAgICAvLyBQYWludGVkIHdpdGggdGhlIENTUyBDdXN0b20gSGlnaGxpZ2h0IEFQSTogcmFuZ2V",
"zIG92ZXIgdGhlIHRleHQsCiAgICAvLyBjb2xvdXJlZCBieSB0aGUgc3R5bGVzaGVldCwgd2l0aCBub3RoaW5nIGFkZGVkIHRvIHRoZSBtYXJrdXAgLSBzbyBhCiAgICAvLyBoaWdobGlnaHQgY2FuIG5ldmVyIGVuZCB1cCBzYXZlZCBpbnRvIHRoZSBub3RlLgoKICAgIGxldCBtYXRjaFJhbmdlcyA9IFtdOwogICAgY29uc3QgY2FuSGlnaGxpZ2h0ID0gKCkgPT4gdHlwZW9mIENTUyAhPT0gJ3VuZGVmaW5lZCcgJiYgQ1NTLmhpZ2hsaWdodHMgJiYgdHlwZW9mIEhpZ2hsaWdodCA9PT0gJ2Z1bmN0aW9uJzsKCiAgICAvLyBUaGUgZWRpdG9yJ3MgdGV4dCB3aXRoIGEgbGluZSBicmVhayBiZXR3ZWVuIGJsb2NrcywgYW5kIHdoZXJlIGVhY2gKICAgIC8vIHRleHQgbm9kZSBzaXRzIGluIGl0LgogICAgZnVuY3Rpb24gdGV4dEluZGV4KCkgewogICAgICBjb25zdCBwYXJ0cyA9IFtdOwogICAgICBsZXQgdGV4dCA9ICcnOwogICAgICBlbHMuZWRpdG9yLmNoaWxkTm9kZXMuZm9yRWFjaCgoYmxrLCBiKSA9PiB7CiAgICAgICAgaWYgKGIpIHRleHQgKz0gJ1xuJzsKICAgICAgICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKGJsaywgTm9kZUZpbHRlci5TSE9XX1RFWFQpOwogICAgICAgIGZvciAobGV0IG4gPSB3YWxrZXIubmV4dE5vZGUoKTsgbjsgbiA9IHdhbGtlci5uZXh0Tm9kZSgpKSB7CiAgICAgICAgICBwYXJ0cy5wdXNoKHsgbm9kZTogbiwgc3RhcnQ6IHRleHQubGVuZ3RoLCBlbmQ6IHRleHQubGV",
"uZ3RoICsgbi5kYXRhLmxlbmd0aCB9KTsKICAgICAgICAgIHRleHQgKz0gbi5kYXRhOwogICAgICAgIH0KICAgICAgfSk7CiAgICAgIHJldHVybiB7IHRleHQsIHBhcnRzIH07CiAgICB9CgogICAgZnVuY3Rpb24gcmFuZ2VGb3IoaWR4LCBzdGFydCwgZW5kKSB7CiAgICAgIGNvbnN0IGEgPSBpZHgucGFydHMuZmluZChwID0-IHN0YXJ0ID49IHAuc3RhcnQgJiYgc3RhcnQgPCBwLmVuZCk7CiAgICAgIGNvbnN0IGIgPSBpZHgucGFydHMuZmluZChwID0-IGVuZCA-IHAuc3RhcnQgJiYgZW5kIDw9IHAuZW5kKTsKICAgICAgaWYgKCFhIHx8ICFiKSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgciA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIHIuc2V0U3RhcnQoYS5ub2RlLCBzdGFydCAtIGEuc3RhcnQpOwogICAgICByLnNldEVuZChiLm5vZGUsIGVuZCAtIGIuc3RhcnQpOwogICAgICByZXR1cm4gcjsKICAgIH0KCiAgICBmdW5jdGlvbiBoaWdobGlnaHQodGVybXMpIHsKICAgICAgY2xlYXJIaWdobGlnaHRzKCk7CiAgICAgIGlmICghdGVybXMgfHwgIXRlcm1zLmxlbmd0aCB8fCAhY2FuSGlnaGxpZ2h0KCkpIHJldHVybiAwOwogICAgICBjb25zdCBpZHggPSB0ZXh0SW5kZXgoKTsKICAgICAgbWF0Y2hSYW5nZXMgPSBucy5zZWFyY2hMb2dpYy5maW5kTWF0Y2hlcyhpZHgudGV4dCwgdGVybXMpLm1hcChtID0-IHJhbmdlRm9yKGlkeCwgbS5zdGFydCwgbS5lbmQpKS5maWx0ZXIoQm9vbGVhbik7CiAgICAgIGlmICh",
"tYXRjaFJhbmdlcy5sZW5ndGgpIENTUy5oaWdobGlnaHRzLnNldCgnZ2tiLW1hdGNoJywgbmV3IEhpZ2hsaWdodCguLi5tYXRjaFJhbmdlcykpOwogICAgICByZXR1cm4gbWF0Y2hSYW5nZXMubGVuZ3RoOwogICAgfQoKICAgIC8vIE1hcmtzIG9uZSBtYXRjaCBhcyB0aGUgY3VycmVudCBvbmUgYW5kIHNjcm9sbHMgaXQgaW50byB0aGUgbWlkZGxlCiAgICAvLyB0aGlyZCBvZiB0aGUgZWRpdG9yIGlmIGl0IGlzIG91dCBvZiB2aWV3LgogICAgZnVuY3Rpb24gc2hvd01hdGNoKGkpIHsKICAgICAgY29uc3QgciA9IG1hdGNoUmFuZ2VzW2ldOwogICAgICBpZiAoIXIgfHwgIWNhbkhpZ2hsaWdodCgpKSByZXR1cm47CiAgICAgIENTUy5oaWdobGlnaHRzLnNldCgnZ2tiLW1hdGNoLWN1cnJlbnQnLCBuZXcgSGlnaGxpZ2h0KHIpKTsKICAgICAgY29uc3QgYm94ID0gZWxzLmVkaXRvci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgY29uc3QgYXQgPSByLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICBpZiAoYXQudG9wIDwgYm94LnRvcCArIDI0IHx8IGF0LmJvdHRvbSA-IGJveC5ib3R0b20gLSAyNCkgewogICAgICAgIGVscy5lZGl0b3Iuc2Nyb2xsVG9wICs9IGF0LnRvcCAtIGJveC50b3AgLSBib3guaGVpZ2h0IC8gMzsKICAgICAgfQogICAgfQoKICAgIGZ1bmN0aW9uIGNsZWFySGlnaGxpZ2h0cygpIHsKICAgICAgbWF0Y2hSYW5nZXMgPSBbXTsKICAgICAgaWYgKCFjYW5IaWdobGlnaHQoKSkgcmV0dXJuOwo",
"gICAgICBDU1MuaGlnaGxpZ2h0cy5kZWxldGUoJ2drYi1tYXRjaCcpOwogICAgICBDU1MuaGlnaGxpZ2h0cy5kZWxldGUoJ2drYi1tYXRjaC1jdXJyZW50Jyk7CiAgICB9CgogICAgLy8g4pSA4pSAIEFQSSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlvbiBzZXREb2MoZG9jKSB7CiAgICAgIHBhc3RlVW5kbyA9IFtdOwogICAgICBsYXN0Q2VsbCA9IG51bGw7CiAgICAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKC4uLmZtdC5ub3JtYWxpc2VEb2MoZG9jKS5tYXAoYmxvY2tFbCkpOwogICAgICBmb3IgKGNvbnN0IHRkIG9mIGVscy5lZGl0b3IucXVlcnlTZWxlY3RvckFsbCgndGQnKSkgdGQuY29udGVudEVkaXRhYmxlID0gZWRpdGFibGUgPyAndHJ1ZScgOiAnZmFsc2UnOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIC8vIE5ldyB0ZXh0IHVuZGVyIHNvbWVvbmUgd2hvIG1heSBiZSB0eXBpbmcgLSBhIG5ld2VyIHZlcnNpb24gbWVyZ2VkCiAgICAvLyBpbjogdGhlIHNhbWUgdGV4dCBib3gsIHNvIHRoZSBmb2N1cyBhbmQgYSBwaG9uZSdzIGtleWJvYXJkIHN0YXksCiAgICAvLyBhbmQgdGhlIGN1cnN",
"vciBnb2VzIHRvIHdoZXJlIGl0cyBibG9jayB3ZW50IChgbWFwYCwgb2xkIGJsb2NrCiAgICAvLyBpbmRleCDihpIgbmV3KSwgYXMgZmFyIGFsb25nIGl0IGFzIGl0IHdhcy4KICAgIGZ1bmN0aW9uIHJlcGxhY2VEb2MoZG9jLCBtYXApIHsKICAgICAgY29uc3QgZm9jdXNlZCA9IHJvb3QuYWN0aXZlRWxlbWVudCA9PT0gZWxzLmVkaXRvciB8fCBlbHMuZWRpdG9yLmNvbnRhaW5zKHJvb3QuYWN0aXZlRWxlbWVudCk7CiAgICAgIGNvbnN0IHIgPSBmb2N1c2VkID8gcmFuZ2UoKSA6IG51bGw7CiAgICAgIGNvbnN0IGF0ID0gciAmJiBbd2hlcmUoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCksIHdoZXJlKHIuZW5kQ29udGFpbmVyLCByLmVuZE9mZnNldCldOwogICAgICBzZXREb2MoZG9jKTsKICAgICAgaWYgKCFhdCB8fCAhYXRbMF0gfHwgIWF0WzFdKSByZXR1cm47CiAgICAgIGNvbnN0IGtpZHMgPSBlbHMuZWRpdG9yLmNoaWxkTm9kZXM7CiAgICAgIGNvbnN0IG1vdmVkID0gcCA9PiB7CiAgICAgICAgY29uc3QgYiA9IE1hdGgubWF4KDAsIE1hdGgubWluKGtpZHMubGVuZ3RoIC0gMSwgbWFwICYmIG1hcFtwLmJdICE9PSB1bmRlZmluZWQgPyBtYXBbcC5iXSA6IHAuYikpOwogICAgICAgIHJldHVybiB7IGIsIG86IE1hdGgubWluKHAubywga2lkc1tiXSA_IGtpZHNbYl0udGV4dENvbnRlbnQubGVuZ3RoIDogMCkgfTsKICAgICAgfTsKICAgICAgY29uc3QgYSA9IHBvaW50QXQobW92ZWQoYXRbMF0pKTsKICAgICA",
"gY29uc3QgeiA9IHBvaW50QXQobW92ZWQoYXRbMV0pKTsKICAgICAgaWYgKCFhIHx8ICF6KSByZXR1cm47CiAgICAgIHRyeSB7CiAgICAgICAgLy8gSW4gYSB0YWJsZSwgdGhlIG5ldyBjZWxsIHRha2VzIHRoZSBmb2N1cyB0aGUgb2xkIG9uZSBoYWQuCiAgICAgICAgY29uc3QgaG9zdCA9IGNlbGxPZihhWzBdKSB8fCBlbHMuZWRpdG9yOwogICAgICAgIGlmIChyb290LmFjdGl2ZUVsZW1lbnQgIT09IGhvc3QpIGhvc3QuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICAgIGNvbnN0IGJhY2sgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICAgIGJhY2suc2V0U3RhcnQoLi4uYSk7CiAgICAgICAgYmFjay5zZXRFbmQoLi4ueik7CiAgICAgICAgc2VsZWN0KGJhY2spOwogICAgICB9IGNhdGNoIHsgLyogdGhlIGN1cnNvciBzdGF5cyB3aGVyZSB0aGUgYnJvd3NlciBwdXQgaXQgKi8gfQogICAgfQoKICAgIGZ1bmN0aW9uIHNldEVkaXRhYmxlKG9uLCBwbGFjZWhvbGRlcikgewogICAgICBlZGl0YWJsZSA9ICEhb247CiAgICAgIGVscy5lZGl0b3IuY29udGVudEVkaXRhYmxlID0gZWRpdGFibGUgPyAndHJ1ZScgOiAnZmFsc2UnOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQucGxhY2Vob2xkZXIgPSBwbGFjZWhvbGRlciB8fCAnV3JpdGUgaGVyZeKApic7CiAgICAgIGVscy5lZGl0b3Iuc2V0QXR0cmlidXRlKCdhcmlhLWRpc2FibGVkJywgU3RyaW5nKCFlZGl0YWJsZSkpOwogICAgICBmb3IgKGNvbnN",
"0IGIgb2YgWy4uLmVscy50b29sYmFyLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpXSkgYi5kaXNhYmxlZCA9ICFlZGl0YWJsZTsKICAgICAgZm9yIChjb25zdCB0ZCBvZiBlbHMuZWRpdG9yLnF1ZXJ5U2VsZWN0b3JBbGwoJ3RkJykpIHRkLmNvbnRlbnRFZGl0YWJsZSA9IGVkaXRhYmxlID8gJ3RydWUnIDogJ2ZhbHNlJzsKICAgICAgaWYgKCFlZGl0YWJsZSkgZWxzLnRhYmxlYmFyLmhpZGRlbiA9IHRydWU7CiAgICB9CgogICAgZnVuY3Rpb24gZm9jdXMoKSB7CiAgICAgIGVscy5lZGl0b3IuZm9jdXMoKTsKICAgICAgY29uc3QgZmlyc3QgPSBlbHMuZWRpdG9yLmZpcnN0Q2hpbGQ7CiAgICAgIGlmIChmaXJzdCkgcGxhY2VDYXJldChmaXJzdCwgMCk7CiAgICB9CgogICAgZnVuY3Rpb24gZGVzdHJveSgpIHsKICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcignc2VsZWN0aW9uY2hhbmdlJywgb25TZWxlY3Rpb24pOwogICAgICBjbGVhckhpZ2hsaWdodHMoKTsKICAgICAgY2xvc2VNZW51KHJvb3QpOwogICAgfQoKICAgIHJldHVybiB7CiAgICAgIGVsZW1lbnQ6IGVscy5lZGl0b3IsCiAgICAgIHRvb2xiYXI6IGVscy50b29sYmFyLAogICAgICBsaW5rYmFyOiBlbHMubGlua2JhciwKICAgICAgdGFibGViYXI6IGVscy50YWJsZWJhciwKICAgICAgc2V0RG9jLAogICAgICByZXBsYWNlRG9jLAogICAgICBnZXREb2M6ICgpID0-IHJlYWREb2MoZWxzLmVkaXRvciksCiAgICAgIHNldEVkaXRhYmxlLAogICAgICB",
"mb2N1cywKICAgICAgZGVzdHJveSwKICAgICAgaGlnaGxpZ2h0LAogICAgICBzaG93TWF0Y2gsCiAgICAgIGNsZWFySGlnaGxpZ2h0cywKICAgICAgbWF0Y2hDb3VudDogKCkgPT4gbWF0Y2hSYW5nZXMubGVuZ3RoLAogICAgfTsKICB9CgogIG5zLm5vdGVFZGl0b3IgPSB7IGNyZWF0ZSwgcmVhZERvYyB9Owp9KSgpOwo\"],[\"addon/app/remote.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyB3YXkgdG8gR21haWwKLy8KLy8gVGhlIE5vdGVzIHZpZXcgKHNyYy9jb250ZW50L25vdGVzLmpzKSB0YWxrcyB0byBhIG5vdGVzU3RvcmUsIGFuZCB0aGUKLy8gYm9hcmQncyBkYXRhIGxheWVyIChzcmMvY29udGVudC9zdG9yZS5qcykgdG8gYGFwaS5nbWFpbGAgYW5kCi8vIGBjaHJvbWUuc3RvcmFnZWAuIEluIHRoZSBleHRlbnNpb24gdGhvc2UgcmVhY2ggR21haWwgdGhyb3VnaCB0aGUKLy8gYmFja2dyb3VuZCB3b3JrZXI7IGhlcmUgdGhleSBhc2sgdGhlIHNjcmlwdCB0aGF0IHNlcnZlZCB0aGlzIHBhZ2UsCi8vIHRocm91Z2ggZ29vZ2xlLnNjcmlwdC5ydW4sI",
"HdoaWNoIGFza3MgR21haWwuIFNhbWUgc2hhcGVzLCBzYW1lIGFuc3dlcnMsCi8vIHNvIHRoZSB2aWV3cyBydW4gdW5jaGFuZ2VkLiBUaGUgY2FsZW5kYXIsIGxpa2V3aXNlLCB0aHJvdWdoCi8vIGBhcGkuZ29vZ2xlTWFueWAuIEFsc28gYGhvb2tzYDogdGhlIGFjY291bnQsIGFuZCBvcGVuaW5nIGEKLy8gY29udmVyc2F0aW9uIGluIEdtYWlsLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCBmbXQgPSBucy5ub3RlRm9ybWF0OwogIGNvbnN0IG5vdGVzTG9naWMgPSBucy5ub3Rlc0xvZ2ljOwoKICAvLyBnb29nbGUuc2NyaXB0LnJ1biBhcyBhIHByb21pc2UuIEEgcmVmdXNhbCBmcm9tIHRoZSBzY3JpcHQgYXJyaXZlcyBhcwogIC8vICJub3RfYWxsb3dlZDog4oCmIiwgd2hpY2ggdGhlIHZpZXcga25vd3MgdG8gZXhwbGFpbi4KICBmdW5jdGlvbiBjYWxsKGZuLCAuLi5hcmdzKSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc",
"29sdmUsIHJlamVjdCkgPT4gewogICAgICBnb29nbGUuc2NyaXB0LnJ1bgogICAgICAgIC53aXRoU3VjY2Vzc0hhbmRsZXIocmVzb2x2ZSkKICAgICAgICAud2l0aEZhaWx1cmVIYW5kbGVyKGVyciA9PiB7CiAgICAgICAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKChlcnIgJiYgZXJyLm1lc3NhZ2UpIHx8IGVyciB8fCAnU29tZXRoaW5nIHdlbnQgd3JvbmcnKS5yZXBsYWNlKC9eKEV4Y2VwdGlvbnxFcnJvcik6XHMqLywgJycpOwogICAgICAgICAgY29uc3QgZSA9IG5ldyBFcnJvcih0ZXh0LnJlcGxhY2UoL15ub3RfYWxsb3dlZDpccyovLCAnJykpOwogICAgICAgICAgaWYgKC9ebm90X2FsbG93ZWQ6Ly50ZXN0KHRleHQpKSBlLmNvZGUgPSAnbm90X2FsbG93ZWQnOwogICAgICAgICAgcmVqZWN0KGUpOwogICAgICAgIH0pW2ZuXSguLi5hcmdzKTsKICAgIH0pOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBwaG9uZSdzIG93biBjb3B5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gU28gdGhhdCB0aGUgYXBwIG9wZW5zIGF0IG9uY2UsIHRoaXMgYnJvd3NlciBrZWVwcyB3aGF0IHRoZSBub3RlcyBuZWVkCiAgLy8gYmVmb3JlIEdtYWlsIGhhcyBhbnN3ZXJlZDogd2hvc2UgdGhleSBhcmUsIHRoZSBsaXN0ICh0aXRsZXMgY",
"W5kIGZpcnN0CiAgLy8gbGluZXMpLCB0aGUgc2NyYXRjaHBhZCdzIHRleHQgYW5kIHRoZSBhcHAncyBzZXR0aW5ncyAtIGFuZCwgYXBhcnQsCiAgLy8gc2NyYXRjaHBhZCB0ZXh0IHR5cGVkIGJ1dCBub3QgeWV0IHNhdmVkLiBUaGUgcGFnZSBvcGVucyBvbiB0aGVzZSwgYW5kCiAgLy8gR21haWwncyBhbnN3ZXJzIHJlcGxhY2UgdGhlbSBhIG1vbWVudCBsYXRlci4gVGhleSBuZXZlciBsZWF2ZSB0aGUgcGhvbmUuCgogIGNvbnN0IENPUFkgPSAnbWVtZGVzay5jb3B5JzsKICBjb25zdCBEUkFGVCA9ICdtZW1kZXNrLmRyYWZ0JzsKICBjb25zdCByZWFkSnNvbiA9IGtleSA9PiB7CiAgICB0cnkgeyByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpIHx8ICdudWxsJyk7IH0gY2F0Y2ggKGVycikgeyByZXR1cm4gbnVsbDsgfQogIH07CiAgY29uc3Qgd3JpdGVKc29uID0gKGtleSwgdmFsdWUpID0-IHsKICAgIHRyeSB7CiAgICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oa2V5KTsKICAgICAgZWxzZSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7CiAgICB9IGNhdGNoIChlcnIpIHsgLyogc3RvcmFnZSBvZmYgb3IgZnVsbDogbm8gY29weSwgb25seSBhIHNsb3dlciBzdGFydCAqLyB9CiAgfTsKICBjb25zdCByZWFkID0gcmVhZEpzb24oQ09QWSk7CiAgLy8geyBhY2NvdW50LCBsYWJlbCwgZm9sZGVycywgbm90ZXMsIHRyd",
"W5jYXRlZCwgc2NyYXRjaCwgcHJlZnMsIGNvbHVtbnMgfTsKICAvLyBzY3JhdGNoIGlzIHsgbm90ZSwgZG9jIH0sIG9yIG51bGwgb25jZSBHbWFpbCBoYXMgc2FpZCB0aGVyZSBpcyBub25lLgogIGNvbnN0IGtlcHQgPSByZWFkICYmIHJlYWQudiA9PT0gMSAmJiByZWFkLmFjY291bnQgPyByZWFkIDogeyB2OiAxIH07CiAgbGV0IGtlZXBUaW1lciA9IDA7CiAgY29uc3Qga2VlcENvcHkgPSAoKSA9PiB7CiAgICBjbGVhclRpbWVvdXQoa2VlcFRpbWVyKTsKICAgIGtlZXBUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gd3JpdGVKc29uKENPUFksIGtlcHQpLCAxNTApOwogIH07CiAgY29uc3QgZm9yZ2V0Q29weSA9ICgpID0-IHsKICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhrZXB0KSkgZGVsZXRlIGtlcHRba107CiAgICBrZXB0LnYgPSAxOwogICAgd3JpdGVKc29uKENPUFksIG51bGwpOwogICAgd3JpdGVKc29uKERSQUZULCBudWxsKTsKICB9OwoKICAvLyBUaGUgbGlzdGluZydzIGZpZWxkcyBvZiBhIG5vdGUsIGFuZCBub3RoaW5nIGVsc2UuCiAgY29uc3QgcGxhaW5Ob3RlID0gbiA9PiBuICYmIHsKICAgIG1lc3NhZ2VJZDogbi5tZXNzYWdlSWQsIHRocmVhZElkOiBuLnRocmVhZElkLCBub3RlSWQ6IG4ubm90ZUlkLCBvd246IG4ub3duLCBrZXk6IG4ua2V5LAogICAgdGl0bGU6IG4udGl0bGUsIHVwZGF0ZWQ6IG4udXBkYXRlZCwgc25pcHBldDogbi5zbmlwcGV0LCBsYWJlbElkczogbi5sYWJlbElkcywgZm9sZ",
"GVySWQ6IG4uZm9sZGVySWQgfHwgJycsCiAgfTsKICBjb25zdCBpc1NjcmF0Y2ggPSBuID0-ICEhbiAmJiBuLm5vdGVJZCA9PT0gbm90ZXNMb2dpYy5TQ1JBVENIUEFEX0lEOwogIC8vIFRoZSBzY3JhdGNocGFkJ3MgdGV4dCwgd2hlbiBpdCBpcyB0aGUgbmV3ZXN0IHZlcnNpb24gc2Vlbi4KICBmdW5jdGlvbiBrZWVwU2NyYXRjaChub3RlLCBkb2MpIHsKICAgIGNvbnN0IGhhZCA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZTsKICAgIGlmIChoYWQgJiYgaGFkLm1lc3NhZ2VJZCAhPT0gbm90ZS5tZXNzYWdlSWQgJiYgaGFkLnVwZGF0ZWQgPiBub3RlLnVwZGF0ZWQpIHJldHVybjsKICAgIGtlcHQuc2NyYXRjaCA9IHsgbm90ZTogcGxhaW5Ob3RlKG5vdGUpLCBkb2MgfTsKICAgIGtlZXBDb3B5KCk7CiAgfQoKICBjb25zdCBTID0gewogICAgbGFiZWw6IGtlcHQubGFiZWwgfHwgJ19Ob3RlcycsCiAgICBmb2xkZXJzOiBrZXB0LmZvbGRlcnMgfHwgW10sCiAgICBkb2NzOiBuZXcgTWFwKCksIC8vIG1lc3NhZ2UgaWQg4oaSIGNvbnRlbnQsIGZyb20gYSBzZWFyY2ggb3IgYSBzYXZlCiAgfTsKICBpZiAoa2VwdC5zY3JhdGNoICYmIGtlcHQuc2NyYXRjaC5ub3RlKSBTLmRvY3Muc2V0KGtlcHQuc2NyYXRjaC5ub3RlLm1lc3NhZ2VJZCwga2VwdC5zY3JhdGNoLmRvYyk7CgogIG5zLm5vdGVzU3RvcmUgPSB7CiAgICBsYWJlbE5hbWU6ICgpID0-IFMubGFiZWwsCiAgICBmb2xkZXJzOiAoKSA9PiBTLmZvbGRlcnMsC",
"iAgICAvLyBBIHNhdmUgdGVsbHMgb2YgYSBuZXdlciB2ZXJzaW9uIHNhdmVkIGVsc2V3aGVyZSAoZXJyb3IgY29kZQogICAgLy8gImNvbmZsaWN0IiksIHNvIHRoZSB2aWV3IG1lcmdlcyByYXRoZXIgdGhhbiBvdmVyd3JpdGVzLgogICAgY2hlY2tzQ29uZmxpY3RzOiB0cnVlLAoKICAgIC8vIFdoYXQgdG8gc2hvdyBiZWZvcmUgR21haWwgYW5zd2VycyAobm90ZXMuanMgZnJvbUNvcHkpLCBvciBudWxsLgogICAgY2FjaGVkKCkgewogICAgICBpZiAoIWtlcHQuYWNjb3VudCkgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IGRyYWZ0ID0gcmVhZEpzb24oRFJBRlQpOwogICAgICByZXR1cm4gewogICAgICAgIG5vdGVzOiBrZXB0Lm5vdGVzIHx8IG51bGwsCiAgICAgICAgdHJ1bmNhdGVkOiAhIWtlcHQudHJ1bmNhdGVkLAogICAgICAgIGZvbGRlcnM6IGtlcHQuZm9sZGVycyB8fCBbXSwKICAgICAgICBzY3JhdGNoOiBrZXB0LnNjcmF0Y2ggPyBrZXB0LnNjcmF0Y2ggOiBrZXB0LnNjcmF0Y2ggPT09IG51bGwgPyB7IG5vdGU6IG51bGwsIGRvYzogbnVsbCB9IDogbnVsbCwKICAgICAgICBkcmFmdDogZHJhZnQgJiYgZHJhZnQuYWNjb3VudCA9PT0ga2VwdC5hY2NvdW50ID8gZHJhZnQgOiBudWxsLAogICAgICB9OwogICAgfSwKCiAgICAvLyBUaGUgc2NyYXRjaHBhZCdzIHVuc2F2ZWQgdGV4dCwgb3IgbnVsbCBvbmNlIGl0IGlzIHNhdmVkLgogICAga2VlcERyYWZ0KGQpIHsKICAgICAgd3JpdGVKc29uKERSQUZULCBkID8geyBhY",
"2NvdW50OiB3aG8uYWNjb3VudCwgbm90ZTogcGxhaW5Ob3RlKGQubm90ZSksIGJhc2U6IGQuYmFzZSwgZG9jOiBkLmRvYyB9IDogbnVsbCk7CiAgICB9LAoKICAgIGFzeW5jIGxpc3QoYWNjb3VudCwgcXVlcnkpIHsKICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGwoJ2FwcExpc3QnLCBxdWVyeSB8fCAnJyk7CiAgICAgIFMubGFiZWwgPSByLmxhYmVsOwogICAgICBTLmZvbGRlcnMgPSByLmZvbGRlcnMgfHwgW107CiAgICAgIE9iamVjdC5rZXlzKHIuZG9jcyB8fCB7fSkuZm9yRWFjaChpZCA9PiBTLmRvY3Muc2V0KGlkLCByLmRvY3NbaWRdKSk7CiAgICAgIGlmICghcXVlcnkpIHsKICAgICAgICBPYmplY3QuYXNzaWduKGtlcHQsIHsgbGFiZWw6IFMubGFiZWwsIGZvbGRlcnM6IFMuZm9sZGVycywgbm90ZXM6IHIubm90ZXMubWFwKHBsYWluTm90ZSksIHRydW5jYXRlZDogISFyLnRydW5jYXRlZCB9KTsKICAgICAgICBrZWVwQ29weSgpOwogICAgICB9CiAgICAgIHJldHVybiB7IG5vdGVzOiByLm5vdGVzLCB0cnVuY2F0ZWQ6IHIudHJ1bmNhdGVkLCBmb2xkZXJzOiBTLmZvbGRlcnMgfTsKICAgIH0sCgogICAgLy8gTWVzc2FnZXMgbmV2ZXIgY2hhbmdlLCBzbyBhIG5vdGUncyBjb250ZW50LCBvbmNlIHJlYWQsIGlzIGtlcHQuCiAgICBhc3luYyBib2R5KG5vdGUpIHsKICAgICAgaWYgKFMuZG9jcy5oYXMobm90ZS5tZXNzYWdlSWQpKSByZXR1cm4gUy5kb2NzLmdldChub3RlLm1lc3NhZ2VJZCk7CiAgICAgIGNvbnN0IGRvY",
"yA9IGF3YWl0IGNhbGwoJ2FwcEJvZHknLCBub3RlLm1lc3NhZ2VJZCk7CiAgICAgIFMuZG9jcy5zZXQobm90ZS5tZXNzYWdlSWQsIGRvYyk7CiAgICAgIGlmIChpc1NjcmF0Y2gobm90ZSkpIGtlZXBTY3JhdGNoKG5vdGUsIGRvYyk7CiAgICAgIHJldHVybiBkb2M7CiAgICB9LAoKICAgIGFzeW5jIHNhdmUoYWNjb3VudCwgcHJldmlvdXMsIHNuYXApIHsKICAgICAgY29uc3QgZG9jID0gZm10Lm5vcm1hbGlzZURvYyhzbmFwLmRvYyk7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBjYWxsKCdhcHBTYXZlJywgcHJldmlvdXMgPyBwcmV2aW91cy5tZXNzYWdlSWQgOiAnJywgewogICAgICAgIHRpdGxlOiBzbmFwLnRpdGxlLCBkb2MsIGZvbGRlcklkOiBzbmFwLmZvbGRlcklkIHx8ICcnLCBub3RlSWQ6IHNuYXAubm90ZUlkIHx8ICcnLAogICAgICB9KTsKICAgICAgaWYgKHIuY29uZmxpY3QpIHsKICAgICAgICBjb25zdCBlID0gbmV3IEVycm9yKCdTYXZlZCBvbiBhbm90aGVyIGRldmljZSBpbiB0aGUgbWVhbnRpbWUuJyk7CiAgICAgICAgZS5jb2RlID0gJ2NvbmZsaWN0JzsKICAgICAgICBlLm5ld2VyID0gci5jb25mbGljdDsKICAgICAgICB0aHJvdyBlOwogICAgICB9CiAgICAgIFMuZG9jcy5zZXQoci5ub3RlLm1lc3NhZ2VJZCwgZG9jKTsKICAgICAgaWYgKGlzU2NyYXRjaChyLm5vdGUpKSB7CiAgICAgICAga2VlcFNjcmF0Y2goci5ub3RlLCBkb2MpOwogICAgICAgIGlmIChrZXB0Lm5vdGVzKSBrZXB0Lm5vdGVzID0gW3BsY",
"WluTm90ZShyLm5vdGUpXS5jb25jYXQoa2VwdC5ub3Rlcy5maWx0ZXIobiA9PiBuLmtleSAhPT0gci5ub3RlLmtleSkpOwogICAgICB9CiAgICAgIHJldHVybiByLm5vdGU7CiAgICB9LAoKICAgIGFzeW5jIHJldGlyZShub3RlKSB7IGF3YWl0IGNhbGwoJ2FwcFJldGlyZScsIG5vdGUubWVzc2FnZUlkKTsgfSwKICAgIGFzeW5jIHJlc3RvcmUobm90ZSkgeyBhd2FpdCBjYWxsKCdhcHBSZXN0b3JlJywgbm90ZS5tZXNzYWdlSWQsIG5vdGUuZm9sZGVySWQgfHwgJycpOyB9LAoKICAgIGFzeW5jIG1vdmUobm90ZSwgZm9sZGVySWQpIHsKICAgICAgYXdhaXQgY2FsbCgnYXBwTW92ZScsIG5vdGUubWVzc2FnZUlkLCBmb2xkZXJJZCB8fCAnJyk7CiAgICAgIG5vdGUuZm9sZGVySWQgPSBmb2xkZXJJZCB8fCAnJzsKICAgIH0sCgogICAgYXN5bmMgY3JlYXRlRm9sZGVyKHBhcmVudCwgdGl0bGUpIHsKICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGwoJ2FwcENyZWF0ZUZvbGRlcicsIHBhcmVudCA_IHBhcmVudC5pZCA6ICcnLCB0aXRsZSk7CiAgICAgIFMuZm9sZGVycyA9IHIuZm9sZGVyczsKICAgICAgcmV0dXJuIHIuZm9sZGVyOwogICAgfSwKCiAgICBhc3luYyByZW5hbWVGb2xkZXIoZm9sZGVyLCB0aXRsZSkgewogICAgICBTLmZvbGRlcnMgPSAoYXdhaXQgY2FsbCgnYXBwUmVuYW1lRm9sZGVyJywgZm9sZGVyLmlkLCB0aXRsZSkpLmZvbGRlcnM7CiAgICB9LAoKICAgIGFzeW5jIGRlbGV0ZUZvbGRlcihmb2xkZXIpIHsKICAgI",
"CAgUy5mb2xkZXJzID0gKGF3YWl0IGNhbGwoJ2FwcERlbGV0ZUZvbGRlcicsIGZvbGRlci5pZCkpLmZvbGRlcnM7CiAgICB9LAogIH07CgogIC8vIOKUgOKUgCBXaG9zZSBtYWlsYm94LCBhbmQgb3BlbmluZyBhIGNvbnZlcnNhdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3Qgd2hvID0geyBhY2NvdW50OiAnJyB9OwoKICBpZiAoa2VwdC5hY2NvdW50KSB3aG8uYWNjb3VudCA9IGtlcHQuYWNjb3VudDsKCiAgLy8g4pSA4pSAIE9wZW5pbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBPbmUgY2FsbCBhcyB0aGUgYXBwIG9wZW5zIChhcHBTdGFydCksIHNlbnQgYmVmb3JlIGFueXRoaW5nIGlzIGRyYXduOgogIC8vIHRoZSBhY2NvdW50LCB0aGUgc2V0dGluZ3MsIHRoZSBib2FyZCdzIGZpcnN0IGNvbHVtbnMgaWYgaXQgaGFzIG5vbmUsCiAgLy8gYW5kIHRoZSBzY3JhdGNocGFkIC0ganVzdCB3aGV0aGVyIHRoZSBjb3B5IGhlcmUgaXMgc3RpbGwgY3VycmVudCwgaWYKICAvLyB0aGVyZSBpcyBvbmUuIFRoZSBwYWdlIG9wZW5zIG9uI",
"HRoZSBjb3B5IG1lYW53aGlsZSAoc2hlbGwuanMpLgoKICBsZXQgc3RhcnRlZCA9IG51bGw7CiAgbGV0IGNvbHVtbnMgPSAnY29sdW1ucycgaW4ga2VwdCA_IGtlcHQuY29sdW1ucyA6IHVuZGVmaW5lZDsKICBsZXQgcHJlZnNUb3VjaGVkID0gZmFsc2U7CgogIGZ1bmN0aW9uIHN0YXJ0KCkgewogICAgaWYgKHN0YXJ0ZWQpIHJldHVybiBzdGFydGVkOwogICAgY29uc3QgaGludCA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZSA_IGtlcHQuc2NyYXRjaC5ub3RlLm1lc3NhZ2VJZCA6ICcnOwogICAgc3RhcnRlZCA9IGNhbGwoJ2FwcFN0YXJ0JywgaGludCkudGhlbihyID0-IHsKICAgICAgY29uc3QgYWNjb3VudCA9IFN0cmluZyhyLmFjY291bnQgfHwgJycpOwogICAgICAvLyBBIGNvcHkga2VwdCBmb3IgYW5vdGhlciBHb29nbGUgYWNjb3VudCBpcyBubyB1c2UgdG8gdGhpcyBvbmUuCiAgICAgIGNvbnN0IG90aGVyQWNjb3VudCA9ICEha2VwdC5hY2NvdW50ICYmIGtlcHQuYWNjb3VudC50b0xvd2VyQ2FzZSgpICE9PSBhY2NvdW50LnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChvdGhlckFjY291bnQpIGZvcmdldENvcHkoKTsKICAgICAgd2hvLmFjY291bnQgPSBhY2NvdW50OwogICAgICBTLmxhYmVsID0gci5sYWJlbCB8fCBTLmxhYmVsOwogICAgICBTLmZvbGRlcnMgPSByLmZvbGRlcnMgfHwgW107CiAgICAgIGlmICghcHJlZnNUb3VjaGVkKSBzeW5jZWQgPSByLnByZWZzIHx8IHt9OwogICAgICBjb2x1b",
"W5zID0gci5jb2x1bW5zIHx8IG51bGw7CiAgICAgIE9iamVjdC5hc3NpZ24oa2VwdCwgeyBhY2NvdW50LCBsYWJlbDogUy5sYWJlbCwgZm9sZGVyczogUy5mb2xkZXJzLCBwcmVmczogc3luY2VkLCBjb2x1bW5zIH0pOwogICAgICBpZiAoci5zY3JhdGNoKSB7CiAgICAgICAgY29uc3Qgc2FtZSA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZSAmJiBrZXB0LnNjcmF0Y2gubm90ZS5tZXNzYWdlSWQgPT09IHIuc2NyYXRjaC5tZXNzYWdlSWQ7CiAgICAgICAgY29uc3QgZG9jID0gci5kb2MgfHwgKHNhbWUgPyBrZXB0LnNjcmF0Y2guZG9jIDogbnVsbCk7CiAgICAgICAgaWYgKGRvYykgewogICAgICAgICAgUy5kb2NzLnNldChyLnNjcmF0Y2gubWVzc2FnZUlkLCBkb2MpOwogICAgICAgICAga2VwdC5zY3JhdGNoID0geyBub3RlOiBwbGFpbk5vdGUoci5zY3JhdGNoKSwgZG9jIH07CiAgICAgICAgfQogICAgICB9IGVsc2UgewogICAgICAgIGtlcHQuc2NyYXRjaCA9IG51bGw7CiAgICAgIH0KICAgICAgd3JpdGVKc29uKENPUFksIGtlcHQpOwogICAgICByZXR1cm4geyBzY3JhdGNoOiByLnNjcmF0Y2ggfHwgbnVsbCwgb3RoZXJBY2NvdW50IH07CiAgICB9KTsKICAgIHJldHVybiBzdGFydGVkOwogIH0KCiAgY29uc3QgaGFzQ29weSA9ICgpID0-ICEha2VwdC5hY2NvdW50OwoKICAvLyBUaGUgYm9hcmQncyBmaXJzdCBjb2x1bW5zLCB3aGVuIGl0cyBzZXR0aW5ncyBoYXZlIG5vbmU6IGZyb20gdGhlCiAgLy8gZ",
"mlyc3QgY2FsbCwgb3IgdGhlIGNvcHkgLSBvciwgZmFpbGluZyB0aG9zZSwgYXNrZWQgZm9yLgogIGFzeW5jIGZ1bmN0aW9uIGZpcnN0Q29sdW1ucygpIHsKICAgIGlmIChjb2x1bW5zICE9PSB1bmRlZmluZWQpIHJldHVybiBjb2x1bW5zOwogICAgaWYgKHN0YXJ0ZWQpIHsKICAgICAgdHJ5IHsgYXdhaXQgc3RhcnRlZDsgfSBjYXRjaCAoZXJyKSB7IC8qIGFza2VkIGZvciBiZWxvdyAqLyB9CiAgICAgIGlmIChjb2x1bW5zICE9PSB1bmRlZmluZWQpIHJldHVybiBjb2x1bW5zOwogICAgfQogICAgcmV0dXJuIGNhbGwoJ2FwcEJvYXJkQ29sdW1ucycpOwogIH0KCiAgY29uc3QgdGhyZWFkVXJsID0gdGhyZWFkSWQgPT4KICAgIGBodHRwczovL21haWwuZ29vZ2xlLmNvbS9tYWlsLz9hdXRodXNlcj0ke2VuY29kZVVSSUNvbXBvbmVudCh3aG8uYWNjb3VudCl9I2FsbC8ke2VuY29kZVVSSUNvbXBvbmVudCh0aHJlYWRJZCl9YDsKCiAgbnMuaG9va3MgPSB7CiAgICBnZXRBY2NvdW50OiAoKSA9PiB3aG8uYWNjb3VudCwKICAgIHRocmVhZFVybCwKICAgIC8vIFRoZSBjb252ZXJzYXRpb24gaW4gR21haWwgLSB3aGljaCwgb24gYSBwaG9uZSwgdGhlIEdtYWlsIGFwcCBtYXkgb2ZmZXIgdG8gb3Blbi4KICAgIG9wZW5UaHJlYWQodGhyZWFkSWQpIHsKICAgICAgd2luZG93Lm9wZW4odGhyZWFkVXJsKHRocmVhZElkKSwgJ19ibGFuaycsICdub29wZW5lcicpOwogICAgfSwKICB9OwoKICAvLyDilIDilIAgVGhlIGJvYXJkJ3MgR21ha",
"Wwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBhcHBCb2FyZEdtYWlsIGFsbG93cyBvbmx5IHdoYXQgdGhlIGJvYXJkIGRvZXMgd2l0aCBHbWFpbC4gRXJyb3JzIGNvbWUKICAvLyBiYWNrIGFzIHRoZSBleHRlbnNpb24ncyBkbyAoImh0dHBfNDA5IiksIHNpbmNlIHRoZSBib2FyZCBhY3RzIG9uIHNvbWUuCgogIGZ1bmN0aW9uIGdtYWlsRXJyb3IobWVzc2FnZSwgc3RhdHVzKSB7CiAgICBjb25zdCBlID0gbmV3IEVycm9yKFN0cmluZyhtZXNzYWdlIHx8ICdHbWFpbCBkaWQgbm90IGFuc3dlci4nKSk7CiAgICBjb25zdCBtID0gL0dtYWlsIGFuc3dlcmVkIChcZHszfSkvLmV4ZWMoZS5tZXNzYWdlKTsKICAgIGUuY29kZSA9IHN0YXR1cyA_IGBodHRwXyR7c3RhdHVzfWAgOiBtID8gYGh0dHBfJHttWzFdfWAgOiAnZ21haWwnOwogICAgcmV0dXJuIGU7CiAgfQoKICBmdW5jdGlvbiBnbWFpbChtZXRob2QsIHBhdGgsIHF1ZXJ5LCBib2R5KSB7CiAgICByZXR1cm4gY2FsbCgnYXBwQm9hcmRHbWFpbCcsIG1ldGhvZCwgcGF0aCwgcXVlcnkgfHwgbnVsbCwgYm9keSB8fCBudWxsKS5jYXRjaChlcnIgPT4gewogICAgICBpZiAoIWVyci5jb2RlKSB0aHJvdyBnbWFpbEVycm9yKGVyci5tZXNzYWdlKTsKI",
"CAgICAgdGhyb3cgZXJyOwogICAgfSk7CiAgfQoKICAvLyBBIGJhdGNoIG9mIHJlYWRzIGluIG9uZSByb3VuZCB0cmlwOiBhIGJvYXJkJ3Mgd29ydGggb2YgY2FyZHMgYXQgb25jZS4KICBhc3luYyBmdW5jdGlvbiBnbWFpbE1hbnkobGlzdCkgewogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGNhbGwoJ2FwcEJvYXJkR21haWxNYW55JywgbGlzdCk7CiAgICByZXR1cm4gcmVzdWx0cy5tYXAociA9PiAociAmJiByLmVycm9yID8geyBlcnJvcjogZ21haWxFcnJvcihyLmVycm9yLm1lc3NhZ2UsIHIuZXJyb3Iuc3RhdHVzKSB9IDogcikpOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBjYWxlbmRhcidzIEdvb2dsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIENhbGVuZGFyIGFuZCBUYXNrcyByZWFkcywgaW4gb25lIHJvdW5kIHRyaXAsIGFzIHRoZSBleHRlbnNpb24ncwogIC8vIHdvcmtlciBhbnN3ZXJzIHRoZW06IGVhY2ggdGhlIHJlc3BvbnNlLCBvciB7IGVycm9yIH0gd2l0aCBhIGNvZGUuCgogIGZ1bmN0aW9uIGdvb2dsZUVycm9yKGUpIHsKICAgIGNvbnN0IGVyciA9IG5ldyBFcnJvcihTdHJpbmcoZS5tZXNzYWdlIHx8ICdHb29nbGUgZGlkIG5vdCBhbnN3ZXIuJykpOwogICAgZXJyLmNvZGUgPSBlLmNvZGUgfHwgK",
"GUuc3RhdHVzID8gYGh0dHBfJHtlLnN0YXR1c31gIDogJ2dvb2dsZScpOwogICAgaWYgKGUudXJsKSBlcnIuYWxsb3dVcmwgPSBTdHJpbmcoZS51cmwpOwogICAgcmV0dXJuIGVycjsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGdvb2dsZU1hbnkobGlzdCkgewogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGNhbGwoJ2FwcEdvb2dsZU1hbnknLCBsaXN0KTsKICAgIHJldHVybiByZXN1bHRzLm1hcChyID0-IChyICYmIHIuZXJyb3IgPyB7IGVycm9yOiBnb29nbGVFcnJvcihyLmVycm9yKSB9IDogcikpOwogIH0KCiAgbnMuYXBpID0geyBTVEFURV9DT0RFUzogbmV3IFNldCgpLCBnbWFpbCwgZ21haWxNYW55LCBnb29nbGVNYW55IH07CiAgbnMuYXBwUmVtb3RlID0geyBjYWxsLCBzdGFydCwgaGFzQ29weSwgZmlyc3RDb2x1bW5zIH07CgogIC8vIOKUgOKUgCBjaHJvbWUuc3RvcmFnZSwgYXMgdGhlIGJvYXJkIHVzZXMgaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyAic3luYyIgLSB0aGUgY29sdW1uIGxheW91dCBhbmQgY2FyZCB0aXRsZXMsIG5vdGVzIGFuZCBjb2xvdXJzIC0gaXMgdGhlCiAgLy8gc2NyaXB0J3MgcGVyLXVzZXIgcHJvcGVydGllczogdGhlIHNhbWUgb24gZXZlcnkgcGhvbmUgYW5kIGNvbXB1dGVyCiAgLy8gdGhlIGFwcCBpcyBvcGVuZWQgb24gKHRob3VnaCBub3Qgc2hhcmVkI",
"HdpdGggdGhlIGV4dGVuc2lvbiwgd2hvc2UKICAvLyBjb3B5IGlzIENocm9tZSdzKS4gImxvY2FsIiAtIGNhcmQgb3JkZXIgYW5kIHRoZSBsYXN0IHRhYiAtIGlzIHRoaXMKICAvLyBicm93c2VyJ3Mgb3duIHN0b3JhZ2UsIGFzIGluIHRoZSBleHRlbnNpb24uCgogIGZ1bmN0aW9uIHBpY2soYWxsLCBrZXlzKSB7CiAgICBpZiAoa2V5cyA9PT0gbnVsbCB8fCBrZXlzID09PSB1bmRlZmluZWQpIHJldHVybiB7IC4uLmFsbCB9OwogICAgaWYgKHR5cGVvZiBrZXlzID09PSAnc3RyaW5nJykga2V5cyA9IFtrZXlzXTsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5cykpIHsKICAgICAgZm9yIChjb25zdCBrIG9mIGtleXMpIGlmIChrIGluIGFsbCkgb3V0W2tdID0gYWxsW2tdOwogICAgICByZXR1cm4gb3V0OwogICAgfQogICAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKGtleXMpKSBvdXRba10gPSBrIGluIGFsbCA_IGFsbFtrXSA6IGtleXNba107CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gVGhlIGFwcCdzIG9sZCBuYW1lLCBrZXB0IHNvIHByZWZzIHNhdmVkIGJlZm9yZSB0aGUgcmVuYW1lIHN0aWxsIGNvdW50LgogIGNvbnN0IExPQ0FMID0gJ3N1cGVybWFpbC4nOwogIGZ1bmN0aW9uIGxvY2FsQWxsKCkgewogICAgY29uc3Qgb3V0ID0ge307CiAgICB0cnkgewogICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxvY2FsU3RvcmFnZS5sZW5ndGg7IGkrKykgewogICAgICAgIGNvbnN0I",
"GsgPSBsb2NhbFN0b3JhZ2Uua2V5KGkpOwogICAgICAgIGlmICghayB8fCAhay5zdGFydHNXaXRoKExPQ0FMKSkgY29udGludWU7CiAgICAgICAgdHJ5IHsgb3V0W2suc2xpY2UoTE9DQUwubGVuZ3RoKV0gPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKGspKTsgfSBjYXRjaCAoZXJyKSB7IC8qIG5vdCBvdXJzICovIH0KICAgICAgfQogICAgfSBjYXRjaCAoZXJyKSB7IC8qIHN0b3JhZ2Ugb2ZmOiBub3RoaW5nIGtlcHQgKi8gfQogICAgcmV0dXJuIG91dDsKICB9CiAgY29uc3QgbG9jYWwgPSB7CiAgICBhc3luYyBnZXQoa2V5cykgeyByZXR1cm4gcGljayhsb2NhbEFsbCgpLCBrZXlzKTsgfSwKICAgIGFzeW5jIHNldChpdGVtcykgewogICAgICB0cnkgeyBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMoaXRlbXMpKSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShMT0NBTCArIGssIEpTT04uc3RyaW5naWZ5KGl0ZW1zW2tdKSk7IH0gY2F0Y2ggKGVycikgeyAvKiBub3Qga2VwdCAqLyB9CiAgICB9LAogICAgYXN5bmMgcmVtb3ZlKGtleXMpIHsKICAgICAgdHJ5IHsgZm9yIChjb25zdCBrIG9mIFtdLmNvbmNhdChrZXlzKSkgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oTE9DQUwgKyBrKTsgfSBjYXRjaCAoZXJyKSB7IC8qIG5vdGhpbmcgdG8gcmVtb3ZlICovIH0KICAgIH0sCiAgfTsKCiAgLy8gRnJvbSB0aGUgZmlyc3QgY2FsbCAob3IgdGhlIGNvcHksIHVudGlsIGl0IGFuc3dlcnMpLCB0aGVuIGtlcHQgaGVyZQogI",
"C8vIGFuZCB3cml0dGVuIHRocm91Z2guCiAgbGV0IHN5bmNlZCA9IGtlcHQucHJlZnMgfHwgbnVsbDsKICBjb25zdCBzeW5jQWxsID0gYXN5bmMgKCkgPT4gewogICAgaWYgKCFzeW5jZWQgJiYgc3RhcnRlZCkgeyB0cnkgeyBhd2FpdCBzdGFydGVkOyB9IGNhdGNoIChlcnIpIHsgLyogYXNrZWQgZm9yIGJlbG93ICovIH0gfQogICAgcmV0dXJuIChzeW5jZWQgPSBzeW5jZWQgfHwgYXdhaXQgY2FsbCgnYXBwUHJlZnNHZXQnLCBudWxsKSk7CiAgfTsKICBjb25zdCBzeW5jID0gewogICAgYXN5bmMgZ2V0KGtleXMpIHsgcmV0dXJuIHBpY2soYXdhaXQgc3luY0FsbCgpLCBrZXlzKTsgfSwKICAgIGFzeW5jIHNldChpdGVtcykgewogICAgICBwcmVmc1RvdWNoZWQgPSB0cnVlOwogICAgICBhd2FpdCBjYWxsKCdhcHBQcmVmc1NldCcsIGl0ZW1zKTsKICAgICAgT2JqZWN0LmFzc2lnbihhd2FpdCBzeW5jQWxsKCksIEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkoaXRlbXMpKSk7CiAgICAgIGtlcHQucHJlZnMgPSBzeW5jZWQ7CiAgICAgIGtlZXBDb3B5KCk7CiAgICB9LAogICAgYXN5bmMgcmVtb3ZlKGtleXMpIHsKICAgICAgcHJlZnNUb3VjaGVkID0gdHJ1ZTsKICAgICAgY29uc3QgbGlzdCA9IFtdLmNvbmNhdChrZXlzKTsKICAgICAgYXdhaXQgY2FsbCgnYXBwUHJlZnNSZW1vdmUnLCBsaXN0KTsKICAgICAgY29uc3QgYWxsID0gYXdhaXQgc3luY0FsbCgpOwogICAgICBmb3IgKGNvbnN0IGsgb2YgbGlzdCkgZGVsZXRlIGFsb",
"FtrXTsKICAgICAga2VwdC5wcmVmcyA9IHN5bmNlZDsKICAgICAga2VlcENvcHkoKTsKICAgIH0sCiAgfTsKCiAgY29uc3QgY2hyb21lTGlrZSA9IChnbG9iYWxUaGlzLmNocm9tZSA9IGdsb2JhbFRoaXMuY2hyb21lIHx8IHt9KTsKICBpZiAoIWNocm9tZUxpa2Uuc3RvcmFnZSkgY2hyb21lTGlrZS5zdG9yYWdlID0geyBsb2NhbCwgc3luYywgb25DaGFuZ2VkOiB7IGFkZExpc3RlbmVyKCkge30gfSB9Owp9KSgpOwo\"],[\"src/content/store.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIEJvYXJkIGRhdGEKLy8KLy8gU2hhcmVkIGJ5IHRoZSBib2FyZCBhbmQgdGhlIGRvY2ssIHNvIGEgbW92ZSBtYWRlIGZyb20gZWl0aGVyIGlzIHNlZW4gYnkKLy8gYm90aC4gR21haWwgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aCBmb3Igd2hpY2ggY29sdW1uIGEgdGhyZWFkIGlzIGluOwovLyB3aGF0IGxpdmVzIGhlcmUgaXMgYSBjYWNoZSBvZiBsYWJlbCBpZHMgYW5kIHRocmVhZCBzdW1tYXJpZXMsIHBsdXMgdGhlCi8vIHNtYWxsIHRoaW5ncyBHbWFpbCBjYW5ub3QgaG9sZCAtIHRoZSBjb2x1bW",
"4gbGF5b3V0IGFuZCB0aGUgdXNlcidzIG93bgovLyBjYXJkIHRpdGxlcywgbm90ZXMgYW5kIGNvbG91cnMgKHN0b3JhZ2Uuc3luYywgc28gdGhleSBmb2xsb3cgdGhlIHVzZXIKLy8gYmV0d2VlbiBjb21wdXRlcnMpIGFuZCBjYXJkIG9yZGVyIHdpdGhpbiBlYWNoIGNvbHVtbiAoc3RvcmFnZS5sb2NhbCwKLy8gYmVjYXVzZSBpdCBjaGFuZ2VzIG9uIGV2ZXJ5IGRyYWcgYW5kIHN5bmMgaGFzIGEgdGlnaHQgd3JpdGUgcXVvdGEpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB7IGFwaSwgbG9naWMsIEtFWVMgfSA9IG5zOwoKICBjb25zdCBidXMgPSBuZXcgRXZlbnRUYXJnZXQoKTsKICBjb25zdCBlbWl0ID0gKHR5cGUsIGRldGFpbCkgPT4gYnVzLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KHR5cGUsIHsgZGV0YWlsIH0pKTsKCiAgY29uc3QgUyA9IHsKICAgIGxhYmVsczogbmV3IE1hcCgpLCAgIC8vIGxvd2VyLWNhc2",
"VkIG5hbWUg4oaSIGxhYmVsIHJlc291cmNlCiAgICBsYWJlbHNBdDogMCwKICAgIG1ldGE6IG5ldyBNYXAoKSwgICAgIC8vIHRocmVhZCBpZCDihpIgc3VtbWFyeSAoc2VlIGxvZ2ljLnN1bW1hcmlzZVRocmVhZCkKICAgIHBlbmRpbmc6IG5ldyBTZXQoKSwgIC8vIGluLWZsaWdodCB0aHJlYWRzLm1vZGlmeSBwcm9taXNlcwogIH07CgogIC8vIEVycm9ycyB0aGF0IG1lYW4gIm5vdGhpbmcgZWxzZSB3aWxsIHdvcmsgZWl0aGVyIiwgd2hpY2ggbXVzdCBzdG9wIGEKICAvLyBiYXRjaCByYXRoZXIgdGhhbiBiZWluZyBzd2FsbG93ZWQgcGVyIHRocmVhZC4KICBmdW5jdGlvbiBpc0ZhdGFsKGVycikgewogICAgcmV0dXJuIGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpIHx8IGVyci5jb2RlID09PSAnZXh0ZW5zaW9uX3JlbG9hZGVkJzsKICB9CgogIC8vIOKUgOKUgCBTZXR0aW5ncyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgYXN5bmMgZnVuY3Rpb24gbG9hZENvbHVtbnMoYWNjb3VudCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5jb2x1bW5zKGFjY291bnQpOwogICAgY29uc3QgZ290ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQoa2V5KTsKIC",
"AgIHJldHVybiBsb2dpYy5ub3JtYWxpc2VDb2x1bW5zKGdvdFtrZXldKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVDb2x1bW5zKGFjY291bnQsIGNvbHVtbnMpIHsKICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMuc2V0KHsgW0tFWVMuY29sdW1ucyhhY2NvdW50KV06IGNvbHVtbnMgfSk7CiAgICBlbWl0KCdjb2x1bW5zLWNoYW5nZWQnLCB7IGNvbHVtbnMgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBsb2FkT3JkZXIoYWNjb3VudCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5vcmRlcihhY2NvdW50KTsKICAgIGNvbnN0IGdvdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpOwogICAgcmV0dXJuIGdvdFtrZXldIHx8IHt9OwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZU9yZGVyKGFjY291bnQsIGxpc3RzLCBjb2x1bW5zKSB7CiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy5vcmRlcihhY2NvdW50KV06IGxvZ2ljLnBydW5lT3JkZXIobGlzdHMsIGNvbHVtbnMpIH0pOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgZWRpdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIGxvYWRDYXJkRW",
"RpdHMoYWNjb3VudCkgewogICAgY29uc3QgYWxsID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQobnVsbCk7CiAgICByZXR1cm4gbG9naWMuY2FyZEVkaXRzRnJvbShhbGwsIEtFWVMuY2FyZFByZWZpeChhY2NvdW50KSk7CiAgfQoKICAvLyBBIG51bGwgZWRpdCBkZWxldGVzIHRoZSByZWNvcmQuIFN5bmMncyBvd24gcXVvdGEgbWVzc2FnZSAoIlFVT1RBX0JZVEVTCiAgLy8gcXVvdGEgZXhjZWVkZWQiKSBzYXlzIG5vdGhpbmcgYWJvdXQgd2hhdCB0byBkbywgc28gaXQgaXMgcmVwaHJhc2VkLgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVDYXJkRWRpdChhY2NvdW50LCB0aHJlYWRJZCwgZWRpdCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5jYXJkKGFjY291bnQsIHRocmVhZElkKTsKICAgIHRyeSB7CiAgICAgIGlmIChlZGl0KSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLnNldCh7IFtrZXldOiBlZGl0IH0pOwogICAgICBlbHNlIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMucmVtb3ZlKGtleSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKC9xdW90YS9pLnRlc3QoKGVyciAmJiBlcnIubWVzc2FnZSkgfHwgJycpKSB7CiAgICAgICAgdGhyb3cgT2JqZWN0LmFzc2lnbihuZXcgRXJyb3IoCiAgICAgICAgICAnQ2hyb21l4oCZcyBzeW5jZWQgc3RvcmFnZSBpcyBmdWxsLiBDbGVhciB0aGUgbm90ZXMgb24gY2FyZHMgeW91IG5vIGxvbmdlciBuZWVkLCBvciB0YWtlIGZpbmlzaGVkIGNhcmRzIG9mZiB0aGUgYm",
"9hcmQuJwogICAgICAgICksIHsgY29kZTogJ3F1b3RhJyB9KTsKICAgICAgfQogICAgICB0aHJvdyBlcnI7CiAgICB9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBsb2FkRG9ja1Bvc2l0aW9uKCkgewogICAgY29uc3QgZ290ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQoS0VZUy5kb2NrUG9zaXRpb24pOwogICAgY29uc3QgdiA9IGdvdFtLRVlTLmRvY2tQb3NpdGlvbl07CiAgICByZXR1cm4gdiA9PT0gJ3JpZ2h0JyB8fCB2ID09PSAnaGlkZGVuJyA_IHYgOiAnbGVmdCc7CiAgfQoKICAvLyDilIDilIAgTGFiZWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBhc3luYyBmdW5jdGlvbiByZWZyZXNoTGFiZWxzKCkgewogICAgY29uc3QgciA9IGF3YWl0IGFwaS5nbWFpbCgnR0VUJywgJ2xhYmVscycpOwogICAgUy5sYWJlbHMgPSBuZXcgTWFwKChyLmxhYmVscyB8fCBbXSkubWFwKGwgPT4gW2wubmFtZS50b0xvd2VyQ2FzZSgpLCBsXSkpOwogICAgUy5sYWJlbHNBdCA9IERhdGUubm93KCk7CiAgfQoKICBmdW5jdGlvbiBhbGxMYWJlbHMoKSB7CiAgICByZXR1cm4gWy4uLlMubGFiZWxzLnZhbHVlcygpXTsKICB9CgogIC8vIEdtYWlsIGxhYm",
"VsIG5hbWVzIGFyZSB1bmlxdWUgY2FzZS1pbnNlbnNpdGl2ZWx5LCBzbyBsb29rdXBzIGFyZSB0b28uCiAgZnVuY3Rpb24gbGFiZWxJZChuYW1lKSB7CiAgICBjb25zdCBsID0gUy5sYWJlbHMuZ2V0KFN0cmluZyhuYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpKTsKICAgIHJldHVybiBsID8gbC5pZCA6ICcnOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZW5zdXJlTGFiZWxzKG5hbWVzLCB7IGZyZXNoID0gZmFsc2UgfSA9IHt9KSB7CiAgICBpZiAoZnJlc2ggfHwgIVMubGFiZWxzQXQpIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKCiAgICBjb25zdCB3YW50ZWQgPSBbXTsKICAgIGZvciAoY29uc3QgbiBvZiBuYW1lcykgd2FudGVkLnB1c2goLi4ubG9naWMubGFiZWxBbmNlc3RvcnMobiksIG4pOwoKICAgIC8vIFNlcXVlbnRpYWwsIHBhcmVudHMgZmlyc3QuIENyZWF0aW5nIGEgaGFuZGZ1bCBvZiBsYWJlbHMgaGFwcGVucyBvbmNlCiAgICAvLyBwZXIgYm9hcmQsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gZ2FpbiBmcm9tIHJhY2luZyB0aGVtLgogICAgZm9yIChjb25zdCBuYW1lIG9mIFsuLi5uZXcgU2V0KHdhbnRlZCldKSB7CiAgICAgIGlmIChsYWJlbElkKG5hbWUpKSBjb250aW51ZTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgYXBpLmdtYWlsKCdQT1NUJywgJ2xhYmVscycsIG51bGwsIHsKICAgICAgICAgIG5hbWUsCiAgICAgICAgICBsYWJlbExpc3RWaXNpYmlsaXR5OiAnbGFiZWxTaG93Jy",
"wKICAgICAgICAgIG1lc3NhZ2VMaXN0VmlzaWJpbGl0eTogJ3Nob3cnLAogICAgICAgIH0pOwogICAgICAgIFMubGFiZWxzLnNldChuYW1lLnRvTG93ZXJDYXNlKCksIGNyZWF0ZWQpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICAvLyA0MDk6IGl0IGV4aXN0cyBhZnRlciBhbGwgKGNyZWF0ZWQgaW4gYW5vdGhlciB0YWIsIG9yIGRpZmZlcmluZwogICAgICAgIC8vIG9ubHkgaW4gY2FzZSkuIFJlLXJlYWQgcmF0aGVyIHRoYW4gZmFpbC4KICAgICAgICBpZiAoZXJyLmNvZGUgPT09ICdodHRwXzQwOScpIHsKICAgICAgICAgIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKICAgICAgICAgIGlmIChsYWJlbElkKG5hbWUpKSBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgdGhyb3cgZXJyOwogICAgICB9CiAgICB9CiAgfQoKICAvLyBSZW5hbWVzIHRoZSBHbWFpbCBsYWJlbCBpbiBwbGFjZSwgc28gZXZlcnkgdGhyZWFkIHdlYXJpbmcgaXQgc3RheXMgcHV0LgogIC8vIElmIHRoZSBuZXcgbmFtZSBhbHJlYWR5IGV4aXN0cyBhcyBhIGRpZmZlcmVudCBsYWJlbCwgdGhlIGNvbHVtbiBzaW1wbHkKICAvLyBzd2l0Y2hlcyB0byB0aGF0IGxhYmVsIC0gcGF0Y2hpbmcgd291bGQgZmFpbCB3aXRoIGEgY29uZmxpY3QsIGFuZAogIC8vIHBvaW50aW5nIGEgY29sdW1uIGF0IGFuIGV4aXN0aW5nIGxhYmVsIGlzIGEgcmVhc29uYWJsZSB0aGluZyB0byB3YW50LgogIGFzeW5jIGZ1bmN0aW9uIHJlbmFtZUxhYmVsKG9sZE5hbWUsIG",
"5ld05hbWUpIHsKICAgIGlmIChvbGROYW1lID09PSBuZXdOYW1lKSByZXR1cm4gJ3VuY2hhbmdlZCc7CiAgICBhd2FpdCByZWZyZXNoTGFiZWxzKCk7CiAgICBjb25zdCBvbGRJZCA9IGxhYmVsSWQob2xkTmFtZSk7CiAgICBjb25zdCBleGlzdGluZyA9IGxhYmVsSWQobmV3TmFtZSk7CiAgICBpZiAoZXhpc3RpbmcgJiYgZXhpc3RpbmcgIT09IG9sZElkKSByZXR1cm4gJ3JlcG9pbnRlZCc7CiAgICBpZiAoIW9sZElkKSByZXR1cm4gJ2NyZWF0ZWQtbGF0ZXInOwogICAgY29uc3QgdXBkYXRlZCA9IGF3YWl0IGFwaS5nbWFpbCgnUEFUQ0gnLCBgbGFiZWxzLyR7b2xkSWR9YCwgbnVsbCwgeyBuYW1lOiBuZXdOYW1lIH0pOwogICAgUy5sYWJlbHMuZGVsZXRlKG9sZE5hbWUudG9Mb3dlckNhc2UoKSk7CiAgICBTLmxhYmVscy5zZXQobmV3TmFtZS50b0xvd2VyQ2FzZSgpLCB1cGRhdGVkKTsKICAgIHJldHVybiAncmVuYW1lZCc7CiAgfQoKICAvLyDilIDilIAgVGhyZWFkcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gdGhyZWFkKGlkKSB7CiAgICByZXR1cm4gUy5tZXRhLmdldChpZCkgfHwgbnVsbDsKICB9CgogIC8vIEZldGNoZXMgbWV0YW",
"RhdGEgb25seSBmb3IgdGhyZWFkcyB0aGF0IGFyZSBuZXcgdG8gdGhlIGNhY2hlIG9yIHdob3NlCiAgLy8gaGlzdG9yeUlkIG1vdmVkLiBPbiBhIHdhcm0gcmVmcmVzaCBvZiBhbiB1bmNoYW5nZWQgYm9hcmQgdGhhdCBpcyB6ZXJvCiAgLy8gY2FsbHMgYmV5b25kIHRoZSBvbmUgbGlzdCBwZXIgY29sdW1uLgogIGFzeW5jIGZ1bmN0aW9uIGh5ZHJhdGUocmVmcywgYWNjb3VudCkgewogICAgY29uc3QgbmVlZCA9IHJlZnMuZmlsdGVyKHQgPT4gewogICAgICBjb25zdCBtID0gUy5tZXRhLmdldCh0LmlkKTsKICAgICAgcmV0dXJuICFtIHx8ICh0Lmhpc3RvcnlJZCAmJiBtLmhpc3RvcnlJZCAhPT0gU3RyaW5nKHQuaGlzdG9yeUlkKSk7CiAgICB9KTsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBhcGkuZ21haWxNYW55KG5lZWQubWFwKHQgPT4gWydHRVQnLCBgdGhyZWFkcy8ke3QuaWR9YCwgewogICAgICBmb3JtYXQ6ICdtZXRhZGF0YScsCiAgICAgIG1ldGFkYXRhSGVhZGVyczogWydTdWJqZWN0JywgJ0Zyb20nLCAnRGF0ZSddLAogICAgfV0pKTsKICAgIHJlc3VsdHMuZm9yRWFjaCgoZnVsbCwgaSkgPT4gewogICAgICAvLyBPbmUgdGhyZWFkIGRlbGV0ZWQgYmV0d2VlbiBsaXN0IGFuZCBnZXQgbXVzdCBub3Qgc2luayB0aGUgYm9hcmQuCiAgICAgIGlmIChmdWxsICYmIGZ1bGwuZXJyb3IpIHsKICAgICAgICBpZiAoaXNGYXRhbChmdWxsLmVycm9yKSkgdGhyb3cgZnVsbC5lcnJvcjsKICAgICAgICByZXR1cm47CiAgIC",
"AgIH0KICAgICAgaWYgKGZ1bGwpIFMubWV0YS5zZXQobmVlZFtpXS5pZCwgbG9naWMuc3VtbWFyaXNlVGhyZWFkKGZ1bGwsIGFjY291bnQpKTsKICAgIH0pOwogIH0KCiAgLy8gQnJpbmdzIHRoZSBjb2x1bW5zJyBsYWJlbCBuYW1lcyBpbiBsaW5lIHdpdGggR21haWwgKGEgbGFiZWwgcmVuYW1lZAogIC8vIHRoZXJlIGlzIGZvbGxvd2VkIGJ5IGl0cyBpZCkgYW5kIHJlY29yZHMgaWRzIGZvciBsYWJlbHMgdGhhdCBoYXZlCiAgLy8gdGhlbS4gU2F2ZWQgb25seSB3aGVuIHNvbWV0aGluZyBjaGFuZ2VkLgogIGFzeW5jIGZ1bmN0aW9uIHN5bmNDb2x1bW5MYWJlbHMoYWNjb3VudCwgY29sdW1ucykgewogICAgY29uc3QgeyBjb2x1bW5zOiBuZXh0LCBjaGFuZ2VkIH0gPSBsb2dpYy5yZXNvbHZlQ29sdW1uTGFiZWxzKGNvbHVtbnMsIFsuLi5TLmxhYmVscy52YWx1ZXMoKV0pOwogICAgaWYgKGNoYW5nZWQpIGF3YWl0IHNhdmVDb2x1bW5zKGFjY291bnQsIG5leHQpOwogICAgcmV0dXJuIG5leHQ7CiAgfQoKICAvLyBFdmVyeXRoaW5nIHRoZSBib2FyZCBuZWVkcyBmb3Igb25lIHJlbmRlcjogcGVyLWNvbHVtbiB0aHJlYWQgaWRzCiAgLy8gKGVhY2ggdGhyZWFkIGluIGV4YWN0bHkgb25lIGNvbHVtbiksIHdoaWNoIGNvbHVtbnMgd2VyZSBjdXQgb2ZmLCBhbmQKICAvLyB0aGUgY29sdW1ucyB0aGVtc2VsdmVzLCBpbiBjYXNlIGEgbGFiZWwgd2FzIHJlbmFtZWQgaW4gR21haWwuCiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvYXJkKG",
"FjY291bnQsIGNvbHVtbnNJbikgewogICAgLy8gTGV0IGFueSBtb3ZlIHN0aWxsIGluIGZsaWdodCBsYW5kIGZpcnN0LCBvciB0aGUgbGlzdCBjb3VsZCBzaG93IHRoZQogICAgLy8gdGhyZWFkIGJhY2sgaW4gdGhlIGNvbHVtbiBpdCBpcyBsZWF2aW5nLgogICAgYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKFsuLi5TLnBlbmRpbmddKTsKICAgIC8vIFJlbmFtZXMgZmlyc3Q6IGVuc3VyaW5nIGxhYmVscyBieSB0aGVpciBzdGFsZSBuYW1lcyB3b3VsZCByZWNyZWF0ZQogICAgLy8gdGhlIG9sZCBvbmVzLCBlbXB0eS4KICAgIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKICAgIGxldCBjb2x1bW5zID0gYXdhaXQgc3luY0NvbHVtbkxhYmVscyhhY2NvdW50LCBjb2x1bW5zSW4pOwogICAgYXdhaXQgZW5zdXJlTGFiZWxzKGNvbHVtbnMubWFwKGMgPT4gYy5sYWJlbCkpOwogICAgY29sdW1ucyA9IGF3YWl0IHN5bmNDb2x1bW5MYWJlbHMoYWNjb3VudCwgY29sdW1ucyk7CgogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGFwaS5nbWFpbE1hbnkoY29sdW1ucy5tYXAoY29sID0-IFsnR0VUJywgJ3RocmVhZHMnLCB7IGxhYmVsSWRzOiBsYWJlbElkKGNvbC5sYWJlbCksIG1heFJlc3VsdHM6IDEwMCB9XSkpOwogICAgY29uc3QgZmFpbGVkID0gcmVzdWx0cy5maW5kKHIgPT4gciAmJiByLmVycm9yKTsKICAgIGlmIChmYWlsZWQpIHRocm93IGZhaWxlZC5lcnJvcjsKCiAgICBjb25zdCByYXcgPSB7fTsKICAgIGNvbnN0IHRydW5jYXRlZC",
"A9IHt9OwogICAgY29uc3QgcmVmcyA9IG5ldyBNYXAoKTsKICAgIGNvbHVtbnMuZm9yRWFjaCgoY29sLCBpKSA9PiB7CiAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2ldIHx8IHt9OwogICAgICBjb25zdCB0aHJlYWRzID0gci50aHJlYWRzIHx8IFtdOwogICAgICByYXdbY29sLmlkXSA9IHRocmVhZHMubWFwKHQgPT4gdC5pZCk7CiAgICAgIHRydW5jYXRlZFtjb2wuaWRdID0gISFyLm5leHRQYWdlVG9rZW47CiAgICAgIGZvciAoY29uc3QgdCBvZiB0aHJlYWRzKSByZWZzLnNldCh0LmlkLCB0KTsKICAgIH0pOwoKICAgIGF3YWl0IGh5ZHJhdGUoWy4uLnJlZnMudmFsdWVzKCldLCBhY2NvdW50KTsKICAgIGNvbnN0IGxpc3RzID0gbG9naWMuYXNzaWduQ29sdW1ucyhjb2x1bW5zLCByYXcpOwogICAgZm9yIChjb25zdCBpZCBvZiBPYmplY3Qua2V5cyhsaXN0cykpIGxpc3RzW2lkXSA9IGxpc3RzW2lkXS5maWx0ZXIodCA9PiBTLm1ldGEuaGFzKHQpKTsKICAgIGVtaXQoJ2JvYXJkLWxvYWRlZCcsIHt9KTsKICAgIHJldHVybiB7IGxpc3RzLCB0cnVuY2F0ZWQsIGNvbHVtbnMgfTsKICB9CgogIC8vIGBzb3VyY2VgIGxldHMgbGlzdGVuZXJzIGlnbm9yZSBlY2hvZXMgb2YgdGhlaXIgb3duIGNoYW5nZXM6IHRoZSBib2FyZAogIC8vIGhhcyBhbHJlYWR5IGRyYXduIGEgbW92ZSBpdCBtYWRlLCB0aGUgZG9jayBoYXMgbm90LgogIGFzeW5jIGZ1bmN0aW9uIG1vZGlmeSh0aHJlYWRJZCwgZGlmZiwgc291cmNlKSB7CiAgICBjb25zdC",
"BwID0gYXBpLmdtYWlsKCdQT1NUJywgYHRocmVhZHMvJHt0aHJlYWRJZH0vbW9kaWZ5YCwgbnVsbCwgZGlmZik7CiAgICBTLnBlbmRpbmcuYWRkKHApOwogICAgdHJ5IHsKICAgICAgYXdhaXQgcDsKICAgIH0gZmluYWxseSB7CiAgICAgIFMucGVuZGluZy5kZWxldGUocCk7CiAgICB9CiAgICAvLyBNYXJrIHRoZSBjYWNoZWQgc3VtbWFyeSBzdGFsZSBzbyB0aGUgbmV4dCByZWZyZXNoIHJlLXJlYWRzIGl0LCBhbmQKICAgIC8vIGtlZXAgaXRzIGxhYmVsIHNldCBob25lc3QgaW4gdGhlIG1lYW50aW1lLgogICAgY29uc3QgbSA9IFMubWV0YS5nZXQodGhyZWFkSWQpOwogICAgaWYgKG0pIHsKICAgICAgbS5oaXN0b3J5SWQgPSAnJzsKICAgICAgY29uc3QgbGFiZWxzID0gbmV3IFNldChtLmxhYmVsSWRzKTsKICAgICAgZGlmZi5yZW1vdmVMYWJlbElkcy5mb3JFYWNoKGlkID0-IGxhYmVscy5kZWxldGUoaWQpKTsKICAgICAgZGlmZi5hZGRMYWJlbElkcy5mb3JFYWNoKGlkID0-IGxhYmVscy5hZGQoaWQpKTsKICAgICAgbS5sYWJlbElkcyA9IFsuLi5sYWJlbHNdOwogICAgfQogICAgZW1pdCgndGhyZWFkLWNoYW5nZWQnLCB7IHRocmVhZElkLCBzb3VyY2UgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBtb3ZlVG9Db2x1bW4odGhyZWFkSWQsIGNvbHVtbnMsIGNvbHVtbklkLCBzb3VyY2UpIHsKICAgIGF3YWl0IGVuc3VyZUxhYmVscyhjb2x1bW5zLm1hcChjID0-IGMubGFiZWwpKTsKICAgIGF3YWl0IG1vZGlmeSh0aHJlYW",
"RJZCwgbG9naWMubW92ZUxhYmVsRGlmZihjb2x1bW5zLCBjb2x1bW5JZCwgbGFiZWxJZCksIHNvdXJjZSk7CiAgfQoKICAvLyBUYWtpbmcgYSBjYXJkIG9mZiB0aGUgYm9hcmQgYWxzbyBmb3JnZXRzIGl0cyB0aXRsZSwgbm90ZSBhbmQgY29sb3VyLgogIC8vIEVkaXRzIHdvdWxkIG90aGVyd2lzZSBvdXRsaXZlIHRoZWlyIGNhcmQsIGFuZCBzeW5jJ3MgcXVvdGEgaXMgc21hbGwKICAvLyBlbm91Z2ggdGhhdCBsZWZ0b3ZlcnMgd291bGQgZXZlbnR1YWxseSBjcm93ZCBvdXQgdGhlIG9uZXMgaW4gdXNlLiBBCiAgLy8gY2FyZCB0aGF0IG1lcmVseSBtb3ZlcyB0byBEb25lIGtlZXBzIHRoZW0uCiAgYXN5bmMgZnVuY3Rpb24gcmVtb3ZlRnJvbUJvYXJkKHRocmVhZElkLCBjb2x1bW5zLCBzb3VyY2UsIGFjY291bnQpIHsKICAgIGlmICghUy5sYWJlbHNBdCkgYXdhaXQgcmVmcmVzaExhYmVscygpOwogICAgYXdhaXQgbW9kaWZ5KHRocmVhZElkLCBsb2dpYy5yZW1vdmVMYWJlbERpZmYoY29sdW1ucywgbGFiZWxJZCksIHNvdXJjZSk7CiAgICBpZiAoYWNjb3VudCkgYXdhaXQgc2F2ZUNhcmRFZGl0KGFjY291bnQsIHRocmVhZElkLCBudWxsKS5jYXRjaCgoKSA9PiB7fSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBzZWFyY2godGV4dCwgYWNjb3VudCkgewogICAgY29uc3QgciA9IGF3YWl0IGFwaS5nbWFpbCgnR0VUJywgJ3RocmVhZHMnLCB7IHE6IGxvZ2ljLnNlYXJjaFF1ZXJ5KHRleHQpLCBtYXhSZXN1bHRzOiAxNSB9KTsKIC",
"AgIGNvbnN0IHJlZnMgPSByLnRocmVhZHMgfHwgW107CiAgICBhd2FpdCBoeWRyYXRlKHJlZnMsIGFjY291bnQpOwogICAgcmV0dXJuIHJlZnMubWFwKHQgPT4gdC5pZCkuZmlsdGVyKGlkID0-IFMubWV0YS5oYXMoaWQpKTsKICB9CgogIC8vIFdoaWNoIGNvbHVtbiAoaWYgYW55KSBhIHNpbmdsZSB0aHJlYWQgaXMgaW4gLSBmb3IgdGhlIGRvY2ssIHdoaWNoIGhhcwogIC8vIG5vIGJvYXJkIGxvYWRlZC4gZm9ybWF0PW1pbmltYWwgaXMgdGhlIGNoZWFwZXN0IGNhbGwgdGhhdCByZXR1cm5zCiAgLy8gbGFiZWwgaWRzLgogIGFzeW5jIGZ1bmN0aW9uIHRocmVhZENvbHVtbih0aHJlYWRJZCwgY29sdW1ucykgewogICAgaWYgKCFTLmxhYmVsc0F0KSBhd2FpdCByZWZyZXNoTGFiZWxzKCk7CiAgICBjb25zdCB0ID0gYXdhaXQgYXBpLmdtYWlsKCdHRVQnLCBgdGhyZWFkcy8ke3RocmVhZElkfWAsIHsgZm9ybWF0OiAnbWluaW1hbCcgfSk7CiAgICBjb25zdCBsYWJlbHMgPSAodC5tZXNzYWdlcyB8fCBbXSkuZmxhdE1hcChtID0-IG0ubGFiZWxJZHMgfHwgW10pOwogICAgcmV0dXJuIGxvZ2ljLmNvbHVtbkZvckxhYmVscyhjb2x1bW5zLCBsYWJlbHMsIGxhYmVsSWQpOwogIH0KCiAgbnMuc3RvcmUgPSB7CiAgICBidXMsIGxvYWRDb2x1bW5zLCBzYXZlQ29sdW1ucywgbG9hZE9yZGVyLCBzYXZlT3JkZXIsIGxvYWRDYXJkRWRpdHMsIHNhdmVDYXJkRWRpdCwgbG9hZERvY2tQb3NpdGlvbiwKICAgIHJlZnJlc2hMYWJlbHMsIGVuc3",
"VyZUxhYmVscywgcmVuYW1lTGFiZWwsIGxhYmVsSWQsIGFsbExhYmVscywKICAgIHRocmVhZCwgbG9hZEJvYXJkLCBtb3ZlVG9Db2x1bW4sIHJlbW92ZUZyb21Cb2FyZCwgc2VhcmNoLCB0aHJlYWRDb2x1bW4sCiAgfTsKfSkoKTsK\"],[\"addon/app/remote-board.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyBmaXJzdCBjb2x1bW4gbGF5b3V0Ci8vCi8vIFRoZSBib2FyZCBrZWVwcyBpdHMgY29sdW1uIGxheW91dCBpbiBpdHMgc3luY2VkIHNldHRpbmdzLCB3aGljaCBoZXJlCi8vIGFyZSB0aGUgYXBwJ3Mgb3duLiBVbnRpbCBpdCBoYXMgb25lLCB0aGUgZXh0ZW5zaW9uJ3MgZGVmYXVsdCBjb2x1bW5zCi8vIHdvdWxkIGJyaW5nIGJhY2sgIl9Cb2FyZC9XYWl0aW5nIiBhcyBhIGZyZXNoLCBlbXB0eSBsYWJlbCBmb3Igc29tZW9uZQovLyB3aG9zZSBjb2x1bW4gaXMgIl9Cb2FyZC9XYWl0aW5nIG9uIG90aGVycyI7IHNvIHRoZSBmaXJzdCBsYXlvdXQgaXMKLy8gdGhlIGJvYXJkJ3MgbGFiZWxzIGFzIEdtYWlsIGhhcyB0aGVtIC0gYXMgdGhlIHBob25lI",
"HBhbmVsIHJlYWRzIHRoZW0uCi8vIFdpdGggbm8gYm9hcmQgbGFiZWxzIGF0IGFsbCwgdGhlIHVzdWFsIGNvbHVtbnMsIG1hZGUgYXMgaW4gQ2hyb21lLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IGdsb2JhbFRoaXMuZ2tiOwogIGNvbnN0IHsgc3RvcmUsIGxvZ2ljLCBLRVlTIH0gPSBuczsKICBjb25zdCBzYXZlZCA9IHN0b3JlLmxvYWRDb2x1bW5zOwoKICBzdG9yZS5sb2FkQ29sdW1ucyA9IGFzeW5jIGFjY291bnQgPT4gewogICAgY29uc3Qga2V5ID0gS0VZUy5jb2x1bW5zKGFjY291bnQpOwogICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLmdldChrZXkpKVtrZXldKSByZXR1cm4gc2F2ZWQoYWNjb3VudCk7CiAgICBjb25zdCBmcm9tTGFiZWxzID0gYXdhaXQgbnMuYXBwUmVtb3RlLmZpcnN0Q29sdW1ucygpOwogICAgcmV0dXJuIGxvZ2ljLm5vcm1hbGlzZUNvbHVtbnMoZnJvbUxhYmVscyB8fCB1bmRlZmluZWQpOwogIH07Cn0pKCk7Cg\"],[\"src/content/notes.js\",\"Ly8g4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBub3RlcyB2aWV3Ci8vCi8vIFRoZSBib2FyZCdzIHNlY29uZCB0YWI6IGZvbGRlcnMgb24gdGhlIGxlZnQsIHRoZW4gdGhlIG5vdGVzIGluIHRoZQovLyBjaG9zZW4gZm9sZGVyLCB0aGVuIHRoZSBvcGVuIG5vdGUuIFR5cGluZyBzYXZlcyBieSBpdHNlbGYgYSBtb21lbnQgYWZ0ZXIKLy8geW91IHN0b3AsIGFuZCBhZ2FpbiBvbiBzd2l0Y2hpbmcgbm90ZXMsIHN3aXRjaGluZyB0YWJzIG9yIGNsb3Npbmc7Ci8vIEN0cmwrUyBzYXZlcyBhdCBvbmNlLiBBIG5vdGUgbW92ZXMgdG8gYW5vdGhlciBmb2xkZXIgYnkgZHJhZ2dpbmcgaXQgb250bwovLyBvbmUsIG9yIGZyb20gdGhlIGZvbGRlciBidXR0b24gYWJvdmUgdGhlIHRleHQuCi8vCi8vIFRoZSBib2FyZCBvd25zIHRoZSBvdmVybGF5LCB0aGUgaGVhZGVyIGFuZCB0aGUgYWNjb3VudCBwYW5lbHMgKHNldHVwLAovLyBjb25uZWN0KTsgdGhpcyBmaWxlIG93bnMgZXZlcnl0aGluZyBpbnNpZGUgdGhlIGJvZHkgd2hpbGUgdGhlIE5vdGVzIHRhYgovLyBpcyBzaG93aW5nLiBJdHMgZWxlbWVudCBpcyBidWlsdCB",
"vbmNlIGFuZCBrZXB0LCBzbyB0aGF0IGEgYm9hcmQgcmVkcmF3Ci8vIG5ldmVyIHB1bGxzIHRoZSB0ZXh0IGJveCBvdXQgZnJvbSB1bmRlciBzb21lb25lIHdobyBpcyB0eXBpbmcuCi8vCi8vIFRoZSBzY3JhdGNocGFkIGlzIHRoZSBub3RlIHRoYXQgaXMgb3BlbiB3aGVuZXZlciBubyBvdGhlciBvbmUgaXM6IG9uZQovLyBub3RlIHdpdGggYSBmaXhlZCBpZCwgc2hhcmVkIGJ5IGV2ZXJ5IGNvbXB1dGVyIGFuZCBwaG9uZSwgdGhlcmUgdG8gdHlwZQovLyBpbnRvIHRoZSBtb21lbnQgdGhlIG5vdGVzIGFwcGVhci4gSXQgaXMgcGlubmVkIGF0IHRoZSB0b3Agb2YgdGhlIGxpc3QsCi8vIGFuZCBjYW5ub3QgYmUgcmVuYW1lZCwgbW92ZWQgb3IgZGVsZXRlZC4gVGhlIGNhbGVuZGFyJ3Mgd2VlaywgaW4gdHdvCi8vIHJvd3MsIHNob3dzIGl0IHRvbywgaW4gYSB0aWxlIG9mIGl0cyBvd24gKHNjcmF0Y2hUaWxlKTogYSBzZWNvbmQgZWRpdG9yCi8vIG9uIHRoZSBzYW1lIHN0YXRlLCBzYXZlZCBhbmQgbWVyZ2VkIGJ5IHRoaXMgZmlsZS4KLy8KLy8gVGhlIHBob25lIGFwcCAoYWRkb24vYXBwKSBydW5zIHRoaXMgc2FtZSB2aWV3IGZ1bGwtc2NyZWVuIG9uIGEgcGhvbmUsCi8vIHdpdGggYSBkaWZmZXJlbnQgd2F5IHRvIEdtYWlsIGJlaGluZCBub3Rlc1N0b3JlLiBBIHBob25lIHNob3dzIG9uZQovLyB0aGluZyBhdCBhIHRpbWUsIGFuZCB0aGUgZWxlbWVudCBzYXlzIHdoaWNoIChkYXRhLXZpZXcpOiAiaG9tZSIsIHRoZQovLyB",
"zZWFyY2ggYm94IGFuZCB0aGUgc2NyYXRjaHBhZDsgImxpc3QiLCB0aGUgbm90ZXMgaW4gYSBmb2xkZXIgb3IgYQovLyBzZWFyY2g7IG9yICJub3RlIiwgYSBub3RlIGZ1bGwtc2NyZWVuLiBUaGUgbm90ZSdzIEJhY2sgYnV0dG9uIGFuZCB0aGUKLy8gZm9sZGVyIHRyZWUncyBidXR0b24gb25seSBzaG93IGluIHRoZSBwaG9uZSdzIHN0eWxlc2hlZXQuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgdG9hc3QsIG9wZW5NZW51IH0gPSBucy51aTsKICBjb25zdCB7IHV0aWwsIG5vdGVzTG9naWMsIG5vdGVzU3RvcmUsIGhvb2tzLCBhcGkgfSA9IG5zOwogIGNvbnN0IGZtdCA9IG5zLm5vdGVGb3JtYXQ7CiAgY29uc3Qgc2VhcmNoTG9naWMgPSBucy5zZWFyY2hMb2dpYzsKCiAgLy8gSG93IG1hbnkgc2VhcmNoIHJlc3VsdHMgZ2V0IGV4Y2VycHRzIGF0IG9uY2UuIEVhY2ggbmVlZHMgdGhlIG5vdGUncwogIC8vIGZ",
"1bGwgdGV4dCwgd2hpY2ggaXMgb25lIG1vcmUgcmVxdWVzdCB0aGUgZmlyc3QgdGltZS4KICBjb25zdCBFWENFUlBUX0xJTUlUID0gMzA7CgogIC8vIExvbmcgZW5vdWdoIG5vdCB0byBzYXZlIG1pZC1zZW50ZW5jZSAoZWFjaCBzYXZlIGlzIGEgbmV3IG1lc3NhZ2UgYW5kCiAgLy8gYSB0cmFzaGVkIG9sZCBvbmUpLCBzaG9ydCBlbm91Z2ggdGhhdCBsaXR0bGUgaXMgYXQgcmlzay4KICBjb25zdCBBVVRPU0FWRV9NUyA9IDI1MDA7CiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CgogIGNvbnN0IFNDUkFUQ0hfS0VZID0gYG46JHtub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfSUR9YDsKCiAgY29uc3QgTiA9IHsKICAgIGN0eDogbnVsbCwgICAgICAgICAgLy8geyByb290LCBvblN0YXRlRXJyb3IsIG9uTG9hZGVkLCBjbG9zZUJvYXJkLCBiYXJDaGFuZ2VkIH0KICAgIG5vdGVzOiBbXSwgICAgICAgICAgLy8gbGl2ZSBub3RlcywgbmV3ZXN0IGZpcnN0IChtZXRhZGF0YSBvbmx5KQogICAgdHJ1bmNhdGVkOiBmYWxzZSwKICAgIHF1ZXJ5OiAnJywKICAgIHN0YXR1czogJ2lkbGUnLCAgICAgLy8gaWRsZSB8IGxvYWRpbmcgfCByZWFkeSB8IGVycm9yCiAgICBlcnJvcjogJycsCiAgICBsb2FkZWRBdDogMCwKICAgIGxvYWRpbmc6IG51bGwsCiAgICBjdXJyZW50OiBudWxsLCAgICAgIC8vIHRoZSBub3RlIGJlaW5nIGVkaXRlZCAtIHNlZSBuZXdDdXJyZW50KCk7IHRoZSBzY3JhdGNocGFkIHdoZW4gbm8gb3RoZXIgaXMKICAgIHN",
"jcmF0Y2g6IG51bGwsICAgICAgLy8gdGhlIHNjcmF0Y2hwYWQgYmVpbmcgZWRpdGVkLCBoZXJlIG9yIGluIHRoZSBjYWxlbmRhcidzIHRpbGUsIG9wZW4gaGVyZSBvciBub3QKICAgIHNjcmF0Y2hOb3RlOiBudWxsLCAgLy8gdGhlIHNjcmF0Y2hwYWQncyBtZXNzYWdlLCBvbmNlIGxpc3RlZCAobnVsbDogbmV2ZXIgc2F2ZWQgeWV0KQogICAgc2NyYXRjaEtub3duOiBmYWxzZSwgLy8gd2hldGhlciB0aGUgbGlzdGluZyBoYXMgc2FpZCBpZiB0aGVyZSBpcyBvbmUKICAgIGJyb3dzaW5nOiBmYWxzZSwgICAgLy8gYSBwaG9uZTogdGhlIGxpc3QgaXMgc2hvd2luZywgcmF0aGVyIHRoYW4gdGhlIHNjcmF0Y2hwYWQKICAgIHdhbnRGb2N1czogZmFsc2UsICAgLy8gcHV0IHRoZSBjdXJzb3IgaW4gdGhlIHNjcmF0Y2hwYWQgb25jZSBpdCBpcyByZWFkeQogICAgY2hhaW46IFByb21pc2UucmVzb2x2ZSgpLCAvLyBzYXZlcyBhbmQgbW92ZXMgcnVuIG9uZSBhZnRlciBhbm90aGVyCiAgICBmb2xkZXJzOiBbXSwgICAgICAgIC8vIG5vdGVzTG9naWMuZm9sZGVyVHJlZSgpLCBmcm9tIHRoZSBsYXN0IGxpc3RpbmcKICAgIGZvbGRlcjogJycsICAgICAgICAgLy8gdGhlIGZvbGRlciBzaG93bjsgJycgZm9yIGFsbCBub3RlcwogICAgZm9sZGVyRWRpdDogbnVsbCwgICAvLyB7IG1vZGU6ICduZXcnIHwgJ3JlbmFtZScsIHBhcmVudElkLCBmb2xkZXJJZCwgdmFsdWUsIGVycm9yLCBidXN5IH0KICAgIGZvbGRlZDogbmV3IFNldCgpLCAgLy8",
"gZm9sZGVycyB3aG9zZSBzdWJmb2xkZXJzIGFyZSBmb2xkZWQgYXdheQogICAgZm9sZGVkUmVhZDogZmFsc2UsICAvLyB0aGUgc2F2ZWQgc2V0IGhhcyBiZWVuIGFza2VkIGZvcgogICAgZHJhZ0tleTogJycsICAgICAgICAvLyB0aGUgbm90ZSBiZWluZyBkcmFnZ2VkIG9udG8gYSBmb2xkZXIKICAgIHRlcm1zOiBbXSwgICAgICAgICAgLy8gc2VhcmNoTG9naWMucXVlcnlUZXJtcygpIG9mIHRoZSBzZWFyY2ggdGhhdCBpcyBzaG93aW5nCiAgICBoaXRzOiBuZXcgTWFwKCksICAgIC8vIGAke21lc3NhZ2VJZH18JHt0ZXJtc31gIOKGkiB7IGNvdW50LCBleGNlcnB0cyB9CiAgICBmaW5kSW5kZXg6IDAsICAgICAgIC8vIHdoaWNoIG1hdGNoIGluIHRoZSBvcGVuIG5vdGUgaXMgdGhlIGN1cnJlbnQgb25lCiAgfTsKCiAgbGV0IHNlYXJjaFRpbWVyID0gMDsKICBsZXQgZmluZFRpbWVyID0gMDsKICBjb25zdCBlbHMgPSB7fTsKICAvLyBUaGUgY2FsZW5kYXIncyBzY3JhdGNocGFkIHRpbGU6IGl0cyBlbGVtZW50LCBlZGl0b3IgYW5kIHN0YXR1cyBsaW5lLAogIC8vIHRoZSBzdGF0ZSBpdCBzaG93cywgYW5kIHdoZXRoZXIgdGhlIG5vdGVzJyBlZGl0b3IgY2hhbmdlZCB0aGF0IHNpbmNlLgogIGNvbnN0IFQgPSB7IGVsOiBudWxsLCBib2R5OiBudWxsLCBzdGF0dXM6IG51bGwsIGVkOiBudWxsLCBmb3I6IG51bGwsIHN0YWxlOiBmYWxzZSB9OwoKICAvLyDilIDilIAgU2V0dXAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGluaXQoY3R4KSB7CiAgICBOLmN0eCA9IGN0eDsKICAgIE4udmlldyA9ICcnOwogICAgLy8gQ2xvc2luZyB0aGUgdGFiIG1pZC1zZW50ZW5jZSB3b3VsZCBsb3NlIHRoZSBsYXN0IGZldyBzZWNvbmRzIG9mCiAgICAvLyB0eXBpbmc7IHRoZSBicm93c2VyJ3Mgb3duICJMZWF2ZSBzaXRlPyIgcHJvbXB0IGlzIHRoZSBvbmx5IGRlZmVuY2UuCiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JldW5sb2FkJywgZSA9PiB7CiAgICAgIGlmIChbTi5jdXJyZW50LCBOLnNjcmF0Y2hdLnNvbWUoYyA9PiBjICYmIChjLmRpcnR5IHx8IGMuc2F2aW5nKSkpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgZS5yZXR1cm5WYWx1ZSA9ICcnOwogICAgICB9CiAgICB9KTsKICB9CgogIC8vIEFjY291bnQgdHJvdWJsZSBnb2VzIHRvIHRoZSBib2FyZCwgd2hpY2ggc2hvd3MgaXRzIHBhbmVsIGluIHBsYWNlIG9mCiAgLy8gdGhlIG5vdGVzIC0gYnV0IG9ubHkgd2hpbGUgdGhlIG5vdGVzIGFyZSBzaG93aW5nLiBUaGUgY2FsZW5kYXIgd29ya3MKICAvLyB3aXRob3V0IEdtYWlsLCBhbmQgaXRzIHNjcmF0Y2hwYWQgdGlsZSB",
"zYXlzIHdoYXQgd2VudCB3cm9uZyBpdHNlbGYuCiAgZnVuY3Rpb24gc3RhdGVFcnJvcihlcnIpIHsKICAgIGlmIChlbHMud3JhcCAmJiBlbHMud3JhcC5pc0Nvbm5lY3RlZCkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgfQoKICBmdW5jdGlvbiBlbGVtZW50KCkgewogICAgaWYgKGVscy53cmFwKSB7CiAgICAgIC8vIFRoZSBzY3JhdGNocGFkIHdhcyB0eXBlZCBpbnRvIGluIHRoZSBjYWxlbmRhcidzIHRpbGUgbWVhbndoaWxlLgogICAgICBpZiAoZWxzLmVkU3RhbGUpIGRyYXdFZGl0b3IoKTsKICAgICAgcmV0dXJuIGVscy53cmFwOwogICAgfQoKICAgIGVscy5zZWFyY2ggPSBoKCdpbnB1dCcsIHsKICAgICAgdHlwZTogJ3NlYXJjaCcsIHBsYWNlaG9sZGVyOiAnU2VhcmNoIG5vdGVzJywgJ2FyaWEtbGFiZWwnOiAnU2VhcmNoIG5vdGVzJywKICAgICAgZGF0YXNldDogeyBrZXk6ICdub3Rlcy1zZWFyY2gnIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4gewogICAgICAgIE4ucXVlcnkgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgICAvLyBPbiBhIHBob25lLCBhIHNlYXJjaCBzaG93cyB0aGUgbGlzdCBpbiBwbGFjZSBvZiB0aGUgc2NyYXRjaHBhZC4KICAgICAgICBpZiAoTi5xdWVyeS50cmltKCkgJiYgIU4uYnJvd3NpbmcpIHsgTi5icm93c2luZyA9IHRydWU7IHNldFZpZXcoKTsgfQogICAgICAgIGNsZWFyVGltZW91dChzZWFyY2hUaW1lcik7CiAgICAgICAgc2VhcmNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0-IGxvYWQ",
"oeyBmb3JjZTogdHJ1ZSB9KSwgNDAwKTsKICAgICAgfSwKICAgICAgb25rZXlkb3duOiBlID0-IHsKICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOyBsb2FkKHsgZm9yY2U6IHRydWUgfSk7IH0KICAgICAgfSwKICAgIH0pOwogICAgZWxzLml0ZW1zID0gaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLWl0ZW1zJywgcm9sZTogJ2xpc3QnLCAnYXJpYS1sYWJlbCc6ICdOb3RlcycgfSk7CiAgICBlbHMuZm9vdCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1mb290JyB9KTsKICAgIGVscy5zY29wZSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1zY29wZScgfSk7CgogICAgZWxzLmxpc3QgPSBoKCdzZWN0aW9uJywgeyBjbGFzczogJ25vdGVzLWxpc3QnLCAnYXJpYS1sYWJlbCc6ICdOb3RlcycgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLXRvb2xzJyB9LAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdzZWFyY2gtYm94JyB9LCBpY29uKCdzZWFyY2gnLCAxOCksIGVscy5zZWFyY2gpLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnYnRuIGJ0bi10b25hbCcsIHR5cGU6ICdidXR0b24nLCBkYXRhc2V0OiB7IGtleTogJ25vdGUtbmV3JyB9LAogICAgICAgICAgdGl0bGU6ICdOZXcgbm90ZScsIG9uY2xpY2s6ICgpID0-IG5ld05vdGUoKSwKICAgICAgICB9LCBpY29uKCdhZGQnLCAxOCksICd",
"OZXcnKSksCiAgICAgIGVscy5zY29wZSwKICAgICAgZWxzLml0ZW1zLAogICAgICBlbHMuZm9vdCk7CgogICAgZWxzLmZvbGRlckl0ZW1zID0gaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlci1pdGVtcycsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiAnRm9sZGVycycgfSk7CiAgICAvLyBPbiBhIHBob25lIHRoZSB0cmVlIGZvbGRzIGF3YXkgYmVoaW5kIG9uZSBidXR0b24gdGhhdCBzYXlzIHdoZXJlCiAgICAvLyB5b3UgYXJlOyBvbmx5IHRoZSBwaG9uZSdzIHN0eWxlc2hlZXQgc2hvd3MgaXQuCiAgICBlbHMuZm9sZGVyc1RvZ2dsZSA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdmb2xkZXJzLXRvZ2dsZScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1leHBhbmRlZCc6ICdmYWxzZScsIGRhdGFzZXQ6IHsga2V5OiAnZm9sZGVycy10b2dnbGUnIH0sCiAgICAgIG9uY2xpY2s6ICgpID0-IHNldEZvbGRlcnNPcGVuKGVscy53cmFwLmRhdGFzZXQuZm9sZGVycyAhPT0gJ29wZW4nKSwKICAgIH0pOwogICAgZWxzLmZvbGRlcnNQYW5lID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdub3Rlcy1mb2xkZXJzJywgJ2FyaWEtbGFiZWwnOiAnRm9sZGVycycgfSwKICAgICAgZWxzLmZvbGRlcnNUb2dnbGUsCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmb2xkZXJzLWhlYWQnIH0sCiAgICAgICAgaCgnaDInLCB7IHRleHQ6ICdGb2xkZXJzJyB9KSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2ljb24",
"tYnRuJywgdHlwZTogJ2J1dHRvbicsIHRpdGxlOiAnTmV3IGZvbGRlcicsICdhcmlhLWxhYmVsJzogJ05ldyBmb2xkZXInLAogICAgICAgICAgZGF0YXNldDogeyBrZXk6ICdmb2xkZXItbmV3JyB9LCBvbmNsaWNrOiAoKSA9PiBzdGFydEZvbGRlckVkaXQoeyBtb2RlOiAnbmV3JywgcGFyZW50SWQ6ICcnIH0pLAogICAgICAgIH0sIGljb24oJ2FkZCcsIDIwKSkpLAogICAgICBlbHMuZm9sZGVySXRlbXMpOwoKICAgIGVscy5lZGl0b3IgPSBoKCdzZWN0aW9uJywgeyBjbGFzczogJ25vdGUtZWRpdG9yJywgJ2FyaWEtbGFiZWwnOiAnTm90ZScgfSk7CiAgICBlbHMud3JhcCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdub3RlcycsIGRhdGFzZXQ6IHsgZm9sZGVyczogJ2Nsb3NlZCcgfSB9LCBlbHMuZm9sZGVyc1BhbmUsIGVscy5saXN0LCBlbHMuZWRpdG9yKTsKICAgIGlmICghTi5jdXJyZW50KSBOLmN1cnJlbnQgPSBzY3JhdGNoU3RhdGUoKTsKICAgIGRyYXdGb2xkZXJzKCk7CiAgICBkcmF3TGlzdCgpOwogICAgZHJhd0VkaXRvcigpOwogICAgLy8gVGV4dCB0eXBlZCBsYXN0IHRpbWUgYW5kIG5vdCBzYXZlZCBiZWZvcmUgdGhlIHBhZ2Ugd2VudC4KICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoYyAmJiBjLmRpcnR5KSBsYXRlclNhdmUoYyk7CiAgICByZXR1cm4gZWxzLndyYXA7CiAgfQoKICAvLyBUaGUgc2NyYXRjaHBhZCdzIHN0YXRlLCBtYWRlIHRoZSBmaXJzdCB0aW1lIGFueXRoaW5nIHdhbnRzIGl0OiBmcm9",
"tCiAgLy8gdGhlIHBob25lIGFwcCdzIGNvcHkgaWYgdGhlcmUgaXMgb25lLCBvciB3YWl0aW5nIGZvciB0aGUgbGlzdC4KICBmdW5jdGlvbiBzY3JhdGNoU3RhdGUoKSB7CiAgICBpZiAoIU4uc2NyYXRjaCAmJiAhZnJvbUNvcHkoKSkgcGVuZGluZ1NjcmF0Y2goKTsKICAgIHJldHVybiBOLnNjcmF0Y2g7CiAgfQoKICAvLyBUaGUgcGhvbmUgYXBwJ3Mgb3duIGNvcHkgKG5vdGVzU3RvcmUuY2FjaGVkKTogdGhlIGxpc3QgYW5kIHRoZQogIC8vIHNjcmF0Y2hwYWQgYXMgdGhleSB3ZXJlIHdoZW4gaXQgbGFzdCBoZWFyZCBmcm9tIEdtYWlsLCBhbmQgYW55IHRleHQKICAvLyB0eXBlZCBhbmQgbm90IHlldCBzYXZlZC4gVGhlIHNjcmF0Y2hwYWQgdGFrZXMgdHlwaW5nIGF0IG9uY2U7IEdtYWlsJ3MKICAvLyBhbnN3ZXIgY2F0Y2hlcyB1cCB3aXRoIGl0IGFmdGVyIChjYXRjaFVwQ3VycmVudCwgYWRvcHROZXdlcikuCiAgZnVuY3Rpb24gZnJvbUNvcHkoKSB7CiAgICBjb25zdCBjb3B5ID0gbm90ZXNTdG9yZS5jYWNoZWQgPyBub3Rlc1N0b3JlLmNhY2hlZCgpIDogbnVsbDsKICAgIGlmICghY29weSkgcmV0dXJuIG51bGw7CiAgICBpZiAoY29weS5ub3RlcykgewogICAgICBOLm5vdGVzID0gY29weS5ub3RlczsKICAgICAgTi50cnVuY2F0ZWQgPSAhIWNvcHkudHJ1bmNhdGVkOwogICAgICBOLmZvbGRlcnMgPSBjb3B5LmZvbGRlcnMgfHwgW107CiAgICAgIE4uc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgTi5sb2FkZWRBdCA9IDA",
"7IC8vIHN0aWxsIHRvIGJlIGFza2VkIGZvcgogICAgfQogICAgaWYgKGNvcHkuc2NyYXRjaCkgewogICAgICBOLnNjcmF0Y2hOb3RlID0gY29weS5zY3JhdGNoLm5vdGUgfHwgbnVsbDsKICAgICAgTi5zY3JhdGNoS25vd24gPSB0cnVlOwogICAgfQogICAgY29uc3QgZnJvbSA9IGNvcHkuZHJhZnQgfHwgY29weS5zY3JhdGNoOwogICAgaWYgKCFmcm9tKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGMgPSBzY3JhdGNoQ3VycmVudChmcm9tLm5vdGUgfHwgbnVsbCk7CiAgICBjLmJhc2UgPSBjb3B5LmRyYWZ0ID8gY29weS5kcmFmdC5iYXNlIHx8IGZtdC5lbXB0eURvYygpIDogZnJvbS5kb2MgfHwgZm10LmVtcHR5RG9jKCk7CiAgICBjLmRvYyA9IGZyb20uZG9jIHx8IGZtdC5lbXB0eURvYygpOwogICAgYy5ib2R5U3RhdGUgPSAncmVhZHknOwogICAgYy5kaXJ0eSA9ICEhY29weS5kcmFmdDsKICAgIHJldHVybiBjOwogIH0KCiAgLy8gV2hhdCB0aGUgcGhvbmUgYXBwJ3MgZmlyc3QgY2FsbCBmb3VuZCB0aGUgc2NyYXRjaHBhZCB0byBiZTogaW4gR21haWwKICAvLyBhbHJlYWR5LCBwZXJoYXBzIG5ld2VyIHRoYW4gdGhlIGNvcHkgaXQgb3BlbmVkIHdpdGguCiAgZnVuY3Rpb24gc2NyYXRjaEZvdW5kKG5vdGUpIHsKICAgIGlmICghbm90ZSB8fCAhaXNOZXdlcihub3RlLCBOLnNjcmF0Y2hOb3RlKSkgcmV0dXJuOwogICAgTi5zY3JhdGNoTm90ZSA9IG5vdGU7CiAgICBOLnNjcmF0Y2hLbm93biA9IHRydWU7CiAgICBjYXRjaFV",
"wQ3VycmVudCgpOwogIH0KCiAgLy8g4pSA4pSAIExvYWRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGlzU3RhbGUoKSB7CiAgICByZXR1cm4gTi5zdGF0dXMgIT09ICdyZWFkeScgfHwgRGF0ZS5ub3coKSAtIE4ubG9hZGVkQXQgPiBTVEFMRV9NUzsKICB9CgogIGZ1bmN0aW9uIGxvYWQoeyBmb3JjZSA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKE4ubG9hZGluZykgcmV0dXJuIE4ubG9hZGluZzsKICAgIGlmICghZm9yY2UgJiYgIWlzU3RhbGUoKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOwogICAgY29uc3QgcXVlcnkgPSBOLnF1ZXJ5OwogICAgaWYgKCFOLm5vdGVzLmxlbmd0aCkgTi5zdGF0dXMgPSAnbG9hZGluZyc7CiAgICBkcmF3TGlzdCgpOwoKICAgIE4ubG9hZGluZyA9IChhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgZm9sZGVkID0gTi5mb2xkZWRSZWFkID8gbnVsbCA6IHJlYWRGb2xkZWQoKTsKICAgICAgICBjb25zdCByID0gYXdhaXQgbm90ZXNTdG9yZS5saXN0KGhvb2tzLmdldEFjY291bnQoKSwgcXVlcnkpOwogICAgICAgIGlmIChmb2xkZWQpIGF3YWl0IGZvbGRlZDsKICAgICAgICB",
"pZiAocXVlcnkgIT09IE4ucXVlcnkpIHJldHVybjsgLy8gYSBuZXdlciBzZWFyY2ggaGFzIHN0YXJ0ZWQKICAgICAgICBsZXQgc2NyYXRjaCA9IHIubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBTQ1JBVENIX0tFWSkgfHwgbnVsbDsKICAgICAgICAvLyBOb3QgYW1vbmcgdGhlIG5ld2VzdCBodW5kcmVkOiBhc2sgR21haWwgZm9yIGl0IGJ5IG5hbWUsIHJhdGhlcgogICAgICAgIC8vIHRoYW4gc3RhcnQgYSBzZWNvbmQgb25lIHRoYXQgd291bGQgcHVzaCB0aGUgZmlyc3QgaW50byBUcmFzaC4KICAgICAgICBpZiAoIXNjcmF0Y2ggJiYgIXF1ZXJ5ICYmIHIudHJ1bmNhdGVkKSB7CiAgICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IG5vdGVzU3RvcmUubGlzdChob29rcy5nZXRBY2NvdW50KCksIG5vdGVzTG9naWMuU0NSQVRDSFBBRF9USVRMRSk7CiAgICAgICAgICBzY3JhdGNoID0gZm91bmQubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBTQ1JBVENIX0tFWSkgfHwgbnVsbDsKICAgICAgICAgIGlmIChxdWVyeSAhPT0gTi5xdWVyeSkgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBpZiAoc2NyYXRjaCB8fCAhcXVlcnkpIHsKICAgICAgICAgIE4uc2NyYXRjaE5vdGUgPSBzY3JhdGNoOwogICAgICAgICAgTi5zY3JhdGNoS25vd24gPSB0cnVlOwogICAgICAgIH0KICAgICAgICBOLm5vdGVzID0gci5ub3RlczsKICAgICAgICBOLnRydW5jYXRlZCA9IHIudHJ1bmNhdGVkOwogICAgICAgIE4uZm9sZGVycyA9IHIuZm9sZGV",
"ycyB8fCBbXTsKICAgICAgICBjb25zdCB0ZXJtcyA9IHNlYXJjaExvZ2ljLnF1ZXJ5VGVybXMocXVlcnkpOwogICAgICAgIGlmIChKU09OLnN0cmluZ2lmeSh0ZXJtcykgIT09IEpTT04uc3RyaW5naWZ5KE4udGVybXMpKSBOLmZpbmRJbmRleCA9IDA7CiAgICAgICAgTi50ZXJtcyA9IHRlcm1zOwogICAgICAgIC8vIFRoZSBmb2xkZXIgc2hvd24gd2FzIGRlbGV0ZWQgb3IgcmVuYW1lZCBhd2F5IGluIEdtYWlsLgogICAgICAgIGlmIChOLmZvbGRlciAmJiAhTi5mb2xkZXJzLnNvbWUoZiA9PiBmLmlkID09PSBOLmZvbGRlcikpIE4uZm9sZGVyID0gJyc7CiAgICAgICAgTi5zdGF0dXMgPSAncmVhZHknOwogICAgICAgIE4uZXJyb3IgPSAnJzsKICAgICAgICBOLmxvYWRlZEF0ID0gRGF0ZS5ub3coKTsKICAgICAgICBjYXRjaFVwQ3VycmVudCgpOwogICAgICAgIHJlYWR5U2NyYXRjaCgpOwogICAgICAgIE4uY3R4Lm9uTG9hZGVkKCk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGNvbnN0IHMgPSBOLnNjcmF0Y2g7CiAgICAgICAgLy8gVGhlIHNjcmF0Y2hwYWQgd2FzIHdhaXRpbmcgZm9yIHRoaXMgbGlzdCB0byBzYXkgd2hldGhlciBpdCBleGlzdHMuCiAgICAgICAgaWYgKHMgJiYgcy5ib2R5U3RhdGUgPT09ICdsb2FkaW5nJyAmJiAhTi5zY3JhdGNoS25vd24pIHsKICAgICAgICAgIHMuYm9keVN0YXRlID0gJ2Vycm9yJzsKICAgICAgICAgIHMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgICAgIGlmIChzID0",
"9PSBOLmN1cnJlbnQpIGRyYXdFZGl0b3IoKTsKICAgICAgICAgIGRyYXdUaWxlKCk7CiAgICAgICAgfQogICAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgewogICAgICAgICAgTi5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgICBzdGF0ZUVycm9yKGVycik7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIE4uc3RhdHVzID0gTi5ub3Rlcy5sZW5ndGggPyAncmVhZHknIDogJ2Vycm9yJzsKICAgICAgICBOLmVycm9yID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgaWYgKE4ubm90ZXMubGVuZ3RoICYmIGVscy53cmFwICYmIGVscy53cmFwLmlzQ29ubmVjdGVkKSB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBsb2FkIG5vdGVzOiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBOLmxvYWRpbmcgPSBudWxsOwogICAgICAgIGRyYXdGb2xkZXJzKCk7CiAgICAgICAgZHJhd0xpc3QoKTsKICAgICAgICBkcmF3Rm9vdCgpOwogICAgICAgIGlmIChOLmN1cnJlbnQpIGRyYXdCYXIoKTsKICAgICAgICBhcHBseUhpZ2hsaWdodHMoKTsKICAgICAgICBmZXRjaEhpdHMoKTsKICAgICAgICBOLmN0eC5iYXJDaGFuZ2VkKCk7CiAgICAgIH0KICAgIH0pKCk7CiAgICAvLyBUaGUgc2VhcmNoIGJveCBjaGFuZ2VkIHdoaWxlIHRoaXMgd2FzIGluIGZsaWdodCwgYW5kIHRoZSBsb2FkIHRoYXQKICAgIC8vIGNoYW5nZSBhc2tlZCBmb3I",
"gd2FzIHR1cm5lZCBhd2F5IGFib3ZlOiBydW4gaXQgbm93LgogICAgY29uc3QgcCA9IE4ubG9hZGluZzsKICAgIHJldHVybiBwLnRoZW4oKCkgPT4gKHF1ZXJ5ICE9PSBOLnF1ZXJ5ID8gbG9hZCh7IGZvcmNlOiB0cnVlIH0pIDogdW5kZWZpbmVkKSk7CiAgfQoKICAvLyBXaGV0aGVyIGBmcmVzaGAgaXMgYSBsYXRlciB2ZXJzaW9uIHRoYW4gdGhlIG9uZSBgbm90ZWAgaXMgKG9yIHRoYW4KICAvLyBub25lIGF0IGFsbCkuIEdtYWlsJ3Mgb3duIGRhdGUgZm9yIGVhY2ggbWVzc2FnZSBkZWNpZGVzLgogIGNvbnN0IGlzTmV3ZXIgPSAoZnJlc2gsIG5vdGUpID0-ICEhZnJlc2ggJiYgKCFub3RlIHx8IChmcmVzaC5tZXNzYWdlSWQgIT09IG5vdGUubWVzc2FnZUlkICYmIGZyZXNoLnVwZGF0ZWQgPiBub3RlLnVwZGF0ZWQpKTsKCiAgLy8gVGhlIG9wZW4gbm90ZSB3YXMgc2F2ZWQgb24gYW5vdGhlciBjb21wdXRlciBvciBwaG9uZSBzaW5jZSBpdCB3YXMKICAvLyBvcGVuZWQgaGVyZSAob3IsIGZvciB0aGUgc2NyYXRjaHBhZCwgc3RhcnRlZCB0aGVyZSk6IHRoZSBuZXdlciB0ZXh0LAogIC8vIG1lcmdlZCB3aXRoIHdoYXRldmVyIHdhcyB0eXBlZCBoZXJlIG1lYW53aGlsZS4gVGhlIHNjcmF0Y2hwYWQgY2F0Y2hlcwogIC8vIHVwIGFzIHdlbGwgd2hlbiBhbm90aGVyIG5vdGUgaXMgb3BlbiwgZm9yIHRoZSBjYWxlbmRhcidzIHRpbGUuCiAgZnVuY3Rpb24gY2F0Y2hVcEN1cnJlbnQoKSB7CiAgICBmb3IgKGNvbnN0IGMgb2YgbmV",
"3IFNldChbTi5jdXJyZW50LCBOLnNjcmF0Y2hdKSkgewogICAgICBpZiAoIWMpIGNvbnRpbnVlOwogICAgICBjb25zdCBmcmVzaCA9IGMuc2NyYXRjaCA_IE4uc2NyYXRjaE5vdGUgOiBjLm5vdGUgPyBOLm5vdGVzLmZpbmQobiA9PiBuLmtleSA9PT0gYy5rZXkpIDogbnVsbDsKICAgICAgaWYgKCFpc05ld2VyKGZyZXNoLCBjLm5vdGUpKSBjb250aW51ZTsKICAgICAgaWYgKGMuYm9keVN0YXRlID09PSAncmVhZHknKSBhZG9wdE5ld2VyKGMsIGZyZXNoKTsKICAgICAgZWxzZSBpZiAoIWMuZGlydHkgJiYgIWMuc2F2aW5nKSB7CiAgICAgICAgaWYgKGMgPT09IE4uY3VycmVudCkgb3Blbk5vdGUoZnJlc2gsIHsgZm9yY2U6IHRydWUgfSk7CiAgICAgICAgZWxzZSBsb2FkQm9keShzY3JhdGNoQ3VycmVudChmcmVzaCkpOwogICAgICB9CiAgICB9CiAgfQoKICAvLyBPbmNlIHRoZSBsaXN0IGhhcyBzYWlkIHdoZXRoZXIgdGhlcmUgaXMgYSBzY3JhdGNocGFkOiB0aGUgb25lIHdhaXRpbmcKICAvLyBmb3IgdGhhdCBpcyBzaG93biwgaGVyZSBvciBpbiB0aGUgdGlsZSAtIGl0cyB0ZXh0IHJlYWQsIG9yIGVtcHR5IGlmCiAgLy8gdGhlcmUgaXMgbm9uZSB5ZXQuCiAgZnVuY3Rpb24gcmVhZHlTY3JhdGNoKCkgewogICAgY29uc3QgcyA9IE4uc2NyYXRjaDsKICAgIGlmICghcyB8fCAhTi5zY3JhdGNoS25vd24pIHJldHVybjsKICAgIGlmIChzID09PSBOLmN1cnJlbnQpIHsKICAgICAgaWYgKHMuYm9keVN0YXRlICE9PSAncmVhZHk",
"nKSBzaG93U2NyYXRjaCgpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAocy5ib2R5U3RhdGUgPT09ICdyZWFkeScgfHwgKHMuYm9keVN0YXRlID09PSAnbG9hZGluZycgJiYgcy5ub3RlKSkgcmV0dXJuOyAvLyByZWFkeSwgb3IgYmVpbmcgcmVhZAogICAgaWYgKE4uc2NyYXRjaE5vdGUpIGxvYWRCb2R5KHNjcmF0Y2hDdXJyZW50KE4uc2NyYXRjaE5vdGUpKTsKICAgIGVsc2UgewogICAgICBzY3JhdGNoQ3VycmVudChudWxsKTsKICAgICAgZHJhd1RpbGUoKTsKICAgIH0KICB9CgogIC8vIEEgbmV3ZXIgdmVyc2lvbiBvZiBhIG5vdGUgYmVpbmcgZWRpdGVkLCB0YWtlbiBpbiBwbGFjZTogdGhlIGVkaXRzCiAgLy8gbWFkZSBoZXJlIHNpbmNlIGBjLmJhc2VgIG1lcmdlZCBpbnRvIGl0IChub3RlRm9ybWF0Lm1lcmdlRG9jcyksIGluCiAgLy8gdGhlIHNhbWUgdGV4dCBib3gsIHNvIHRoZSBjdXJzb3IgYW5kIGEgcGhvbmUncyBrZXlib2FyZCBzdGF5IHB1dC4gSXQKICAvLyB3YWl0cyBmb3IgYSBzYXZlIGluIGZsaWdodCwgYW5kIHRoZSBtZXJnZWQgdGV4dCBpcyBzYXZlZCBpbiB0dXJuLgogIGZ1bmN0aW9uIGFkb3B0TmV3ZXIoYywgZnJlc2gpIHsKICAgIE4uY2hhaW4gPSBOLmNoYWluLnRoZW4oYXN5bmMgKCkgPT4gewogICAgICBpZiAoIWlzTmV3ZXIoZnJlc2gsIGMubm90ZSkpIHJldHVybjsKICAgICAgbGV0IHRoZWlyczsKICAgICAgdHJ5IHsKICAgICAgICB0aGVpcnMgPSBhd2FpdCBub3Rlc1N0b3JlLmJvZHk",
"oZnJlc2gpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICByZXR1cm47IC8vIHRoZSBuZXh0IGxpc3RpbmcgdHJpZXMgYWdhaW4KICAgICAgfQogICAgICBpZiAoIWlzTmV3ZXIoZnJlc2gsIGMubm90ZSkpIHJldHVybjsKICAgICAgY29uc3QgYmFzZSA9IGMuYmFzZSB8fCBmbXQuZW1wdHlEb2MoKTsKICAgICAgY29uc3QgbWluZSA9IGMuZG9jIHx8IGJhc2U7CiAgICAgIGNvbnN0IHR5cGVkID0gYy5kaXJ0eSAmJiAhZm10LnNhbWVEb2MobWluZSwgYmFzZSk7CiAgICAgIGNvbnN0IHRpdGxlZCA9ICFjLnNjcmF0Y2ggJiYgYy5kaXJ0eSAmJiBjLnRpdGxlICE9PSBjLmJhc2VUaXRsZTsKICAgICAgY29uc3QgbWVyZ2VkID0gdHlwZWQgPyBmbXQubWVyZ2VEb2NzKGJhc2UsIG1pbmUsIHRoZWlycykgOiB7IGRvYzogdGhlaXJzLCBtYXA6IG51bGwgfTsKICAgICAgYy5ub3RlID0gZnJlc2g7CiAgICAgIGMua2V5ID0gZnJlc2gua2V5OwogICAgICBjLmJhc2UgPSB0aGVpcnM7CiAgICAgIGMuYmFzZVRpdGxlID0gZnJlc2gudGl0bGU7CiAgICAgIGMuZG9jID0gbWVyZ2VkLmRvYzsKICAgICAgYy5zYXZlZEF0ID0gMDsKICAgICAgYy5lcnJvciA9ICcnOwogICAgICBpZiAoIXRpdGxlZCAmJiAhYy5zY3JhdGNoKSBjLnRpdGxlID0gZnJlc2gudGl0bGUgIT09ICdVbnRpdGxlZCBub3RlJyA_IGZyZXNoLnRpdGxlIDogJyc7CiAgICAgIGlmICghYy5zY3JhdGNoKSBjLmZvbGRlcklkID0gZnJlc2guZm9sZGVySWQgfHwgJyc",
"7CiAgICAgIGMuZGlydHkgPSAodHlwZWQgJiYgIWZtdC5zYW1lRG9jKG1lcmdlZC5kb2MsIHRoZWlycykpIHx8IHRpdGxlZDsKICAgICAgaWYgKGMuc2NyYXRjaCkgeyBOLnNjcmF0Y2hOb3RlID0gZnJlc2g7IE4uc2NyYXRjaEtub3duID0gdHJ1ZTsgfQogICAgICBpZiAoTi5jdXJyZW50ID09PSBjICYmIGVscy5lZCkgewogICAgICAgIGVscy5lZC5yZXBsYWNlRG9jKG1lcmdlZC5kb2MsIG1lcmdlZC5tYXApOwogICAgICAgIGNvbnN0IGlucHV0ID0gZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9Im5vdGUtdGl0bGUiXScpOwogICAgICAgIGlmIChpbnB1dCAmJiBpbnB1dC52YWx1ZSAhPT0gYy50aXRsZSAmJiBOLmN0eC5yb290LmFjdGl2ZUVsZW1lbnQgIT09IGlucHV0KSBpbnB1dC52YWx1ZSA9IGMudGl0bGU7CiAgICAgICAgYXBwbHlIaWdobGlnaHRzKCk7CiAgICAgIH0KICAgICAgaWYgKFQuZWQgJiYgVC5mb3IgPT09IGMpIFQuZWQucmVwbGFjZURvYyhtZXJnZWQuZG9jLCBtZXJnZWQubWFwKTsKICAgICAgaWYgKHR5cGVkKSB0b2FzdChOLmN0eC5yb290LCAnQWxzbyBjaGFuZ2VkIG9uIGFub3RoZXIgZGV2aWNlIGluIHRoZSBtZWFudGltZTogYm90aCBjaGFuZ2VzIGFyZSBrZXB0LicpOwogICAgICBrZWVwRHJhZnQoYyk7CiAgICAgIGlmIChjLmRpcnR5KSBsYXRlclNhdmUoYyk7CiAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMpIGRyYXdCYXIoKTsKICAgICAgZHJhd1N0YXR1cygpOwogICAgICB",
"kcmF3TGlzdCgpOwogICAgfSk7CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIEEgcGhvbmUgYXBwIGtlZXBzIHRoZSBzY3JhdGNocGFkJ3MgdW5zYXZlZCB0ZXh0IG9uIHRoZSBwaG9uZSwgc28gdGhhdAogIC8vIGEgcGFnZSB0aGUgcGhvbmUgY2xvc2VzIG1pZC1zZW50ZW5jZSBsb3NlcyBub3RoaW5nIChub3Rlc1N0b3JlLmtlZXBEcmFmdCkuCiAgbGV0IGRyYWZ0VGltZXIgPSAwOwogIGZ1bmN0aW9uIGtlZXBEcmFmdChjKSB7CiAgICBpZiAoIWMuc2NyYXRjaCB8fCAhbm90ZXNTdG9yZS5rZWVwRHJhZnQpIHJldHVybjsKICAgIGNsZWFyVGltZW91dChkcmFmdFRpbWVyKTsKICAgIG5vdGVzU3RvcmUua2VlcERyYWZ0KGMuZGlydHkgPyB7IG5vdGU6IGMubm90ZSwgYmFzZTogYy5iYXNlLCBkb2M6IGMuZG9jIH0gOiBudWxsKTsKICB9CgogIC8vIOKUgOKUgCBUaGUgbGlzdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gZm9sZGVyQnlJZChpZCkgewogICAgcmV0dXJuIE4uZm9sZGVycy5maW5kKGYgPT4gZi5pZCA9PT0gaWQpIHx8IG51bGw7CiAgfQoKICAvLyAiV29yayDigLogQ2xpZW50cyIKICBmdW5jdGlvbiBmb2xkZXJMYWJlbCh",
"pZCkgewogICAgY29uc3QgZiA9IGZvbGRlckJ5SWQoaWQpOwogICAgcmV0dXJuIGYgPyBmLnBhdGguc3BsaXQoJy8nKS5qb2luKCcgXHUyMDNhICcpIDogJyc7CiAgfQoKICBmdW5jdGlvbiB2aXNpYmxlTm90ZXMoKSB7CiAgICByZXR1cm4gTi5mb2xkZXIgPyBOLm5vdGVzLmZpbHRlcihuID0-IG4uZm9sZGVySWQgPT09IE4uZm9sZGVyKSA6IE4ubm90ZXM7CiAgfQoKICBmdW5jdGlvbiBkcmF3TGlzdCgpIHsKICAgIGlmICghZWxzLml0ZW1zKSByZXR1cm47CiAgICBjb25zdCBjdXJLZXkgPSBOLmN1cnJlbnQgJiYgTi5jdXJyZW50LmtleTsKICAgIGNvbnN0IHNob3duID0gdmlzaWJsZU5vdGVzKCk7CiAgICBjb25zdCBzZWFyY2hpbmcgPSAhIU4ucXVlcnkudHJpbSgpOwogICAgaWYgKGVscy5zY29wZSkgewogICAgICBjb25zdCB3aGVyZSA9IE4uZm9sZGVyID8gZm9sZGVyTGFiZWwoTi5mb2xkZXIpIDogJ0FsbCBub3Rlcyc7CiAgICAgIGVscy5zY29wZS50ZXh0Q29udGVudCA9IE4uc3RhdHVzID09PSAncmVhZHknCiAgICAgICAgPyBgJHt3aGVyZX0gXHUwMGI3ICR7c2hvd24ubGVuZ3RofSAke3NlYXJjaGluZyA_IChzaG93bi5sZW5ndGggPT09IDEgPyAnbWF0Y2gnIDogJ21hdGNoZXMnKSA6IChzaG93bi5sZW5ndGggPT09IDEgPyAnbm90ZScgOiAnbm90ZXMnKX1gCiAgICAgICAgOiB3aGVyZTsKICAgIH0KICAgIGlmIChlbHMuc2VhcmNoKSBlbHMuc2VhcmNoLnBsYWNlaG9sZGVyID0gTi5mb2xkZXIgPyBgU2VhcmN",
"oIGluICR7Zm9sZGVyQnlJZChOLmZvbGRlcikgPyBmb2xkZXJCeUlkKE4uZm9sZGVyKS50aXRsZSA6ICd0aGlzIGZvbGRlcid9YCA6ICdTZWFyY2ggbm90ZXMnOwoKICAgIGlmIChOLnN0YXR1cyA9PT0gJ2xvYWRpbmcnICYmICFOLm5vdGVzLmxlbmd0aCkgewogICAgICBlbHMuaXRlbXMucmVwbGFjZUNoaWxkcmVuKGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1lbXB0eScsIHRleHQ6ICdMb2FkaW5n4oCmJyB9KSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChOLnN0YXR1cyA9PT0gJ2Vycm9yJyAmJiAhTi5ub3Rlcy5sZW5ndGgpIHsKICAgICAgZWxzLml0ZW1zLnJlcGxhY2VDaGlsZHJlbigKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtZW1wdHknIH0sCiAgICAgICAgICBoKCdwJywgeyB0ZXh0OiBgQ291bGRu4oCZdCBsb2FkIG5vdGVzOiAke04uZXJyb3J9YCB9KSwKICAgICAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdidG4gYnRuLXRleHQnLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1RyeSBhZ2FpbicsIG9uY2xpY2s6ICgpID0-IGxvYWQoeyBmb3JjZTogdHJ1ZSB9KSB9KSkpOwogICAgICByZXR1cm47CiAgICB9CiAgICAvLyBUaGUgc2NyYXRjaHBhZCBmaXJzdDogaW4gIkFsbCBub3RlcyIsIGFsd2F5cywgc2F2ZWQgeWV0IG9yIG5vdDsKICAgIC8vIGVsc2V3aGVyZSwgd2hlcmUgaXQgaXMgbGlzdGVkIChhIHNlYXJjaCB0aGF0IGZpbmRzIGl0KS4KICAgIGNvbnN0IHNjcmF0Y2ggPSBzaG9",
"3bi5maW5kKG4gPT4gbi5rZXkgPT09IFNDUkFUQ0hfS0VZKSB8fCAoIU4uZm9sZGVyICYmICFzZWFyY2hpbmcgJiYgTi5zY3JhdGNoS25vd24gJiYgIU4uc2NyYXRjaE5vdGUgPyAnbmV3JyA6IG51bGwpOwogICAgY29uc3QgcmVzdCA9IHNob3duLmZpbHRlcihuID0-IG4ua2V5ICE9PSBTQ1JBVENIX0tFWSk7CiAgICBjb25zdCBwaW5uZWQgPSBzY3JhdGNoID8gW3NjcmF0Y2hJdGVtKHNjcmF0Y2ggPT09ICduZXcnID8gbnVsbCA6IHNjcmF0Y2gsIGN1cktleSldIDogW107CiAgICBpZiAoIXJlc3QubGVuZ3RoKSB7CiAgICAgIGxldCB0ZXh0ID0gc2VhcmNoaW5nID8gJ05vIG5vdGVzIG1hdGNoLicgOiAnTm8gbm90ZXMgeWV0Lic7CiAgICAgIGlmIChOLmZvbGRlcikgdGV4dCA9IHNlYXJjaGluZyA_ICdObyBub3RlcyBpbiB0aGlzIGZvbGRlciBtYXRjaC4nIDogJ05vIG5vdGVzIGluIHRoaXMgZm9sZGVyIHlldC4nOwogICAgICBlbHMuaXRlbXMucmVwbGFjZUNoaWxkcmVuKC4uLnBpbm5lZCwgaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLWVtcHR5JywgdGV4dCB9KSk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBlbHMuaXRlbXMucmVwbGFjZUNoaWxkcmVuKC4uLnBpbm5lZCwgLi4ucmVzdC5tYXAobiA9PiB7CiAgICAgIGNvbnN0IGl0ZW0gPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdub3RlLWl0ZW0nLCB0eXBlOiAnYnV0dG9uJywgcm9sZTogJ2xpc3RpdGVtJywgZHJhZ2dhYmxlOiAndHJ1ZScsCiAgICA",
"gICAgJ2FyaWEtY3VycmVudCc6IG4ua2V5ID09PSBjdXJLZXkgPyAndHJ1ZScgOiBudWxsLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgbm90ZToke24ua2V5fWAsIG5vdGU6IG4ua2V5IH0sCiAgICAgICAgb25jbGljazogKCkgPT4gb3Blbk5vdGUobiksCiAgICAgIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICduaS10b3AnIH0sCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ25pLXRpdGxlJyB9LCBtYXJrZWQobi50aXRsZSkpLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkYXRlJywgdGV4dDogdXRpbC5yZWxhdGl2ZURhdGUobi51cGRhdGVkKSwgdGl0bGU6IHV0aWwuZnVsbERhdGUobi51cGRhdGVkKSB9KSksCiAgICAgICAgaXRlbVByZXZpZXcobiksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICduaS1tZXRhJyB9LAogICAgICAgICAgaGl0Q291bnQobiksCiAgICAgICAgICAhTi5mb2xkZXIgJiYgbi5mb2xkZXJJZCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktZm9sZGVyJyB9LCBpY29uKCdmb2xkZXInLCAxNCksIGZvbGRlckxhYmVsKG4uZm9sZGVySWQpKSA6IG51bGwsCiAgICAgICAgICBuLm93biA_IG51bGwgOiBoKCdzcGFuJywgeyBjbGFzczogJ25pLW1haWwnLCB0ZXh0OiAnRnJvbSBhbiBlbWFpbCcgfSkpKTsKICAgICAgaXRlbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCBlID0-IHsKICAgICAgICBOLmRyYWdLZXkgPSBuLmtleTsKICAgICAgICBlLmRhdGFUcmF",
"uc2Zlci5lZmZlY3RBbGxvd2VkID0gJ21vdmUnOwogICAgICAgIGUuZGF0YVRyYW5zZmVyLnNldERhdGEoJ2FwcGxpY2F0aW9uL3gtZ2tiLW5vdGUnLCBuLmtleSk7CiAgICAgICAgZWxzLndyYXAuY2xhc3NMaXN0LmFkZCgnZHJhZ2dpbmctbm90ZScpOwogICAgICB9KTsKICAgICAgaXRlbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgKCkgPT4gewogICAgICAgIE4uZHJhZ0tleSA9ICcnOwogICAgICAgIGVscy53cmFwLmNsYXNzTGlzdC5yZW1vdmUoJ2RyYWdnaW5nLW5vdGUnKTsKICAgICAgICBmb3IgKGNvbnN0IHIgb2YgZWxzLmZvbGRlckl0ZW1zLnF1ZXJ5U2VsZWN0b3JBbGwoJy5kcm9wJykpIHIuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcCcpOwogICAgICB9KTsKICAgICAgcmV0dXJuIGl0ZW07CiAgICB9KSk7CiAgfQoKICAvLyBUaGUgc2NyYXRjaHBhZCdzIGVudHJ5OiBwaW5uZWQsIG5vdCBkcmFnZ2FibGUsIGFuZCBvbiBhIHBob25lIGl0IGdvZXMKICAvLyBiYWNrIHRvIHRoZSBzY3JhdGNocGFkIHJhdGhlciB0aGFuIG9wZW5pbmcgaXQgZnVsbC1zY3JlZW4uCiAgZnVuY3Rpb24gc2NyYXRjaEl0ZW0obiwgY3VyS2V5KSB7CiAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ25vdGUtaXRlbSBzY3JhdGNoLWl0ZW0nLCB0eXBlOiAnYnV0dG9uJywgcm9sZTogJ2xpc3RpdGVtJywKICAgICAgJ2FyaWEtY3VycmVudCc6IGN1cktleSA9PT0gU0NSQVRDSF9LRVkgPyAndHJ1ZScgOiBudWxsLAo",
"gICAgICBkYXRhc2V0OiB7IGtleTogJ25vdGU6c2NyYXRjaHBhZCcsIG5vdGU6IFNDUkFUQ0hfS0VZIH0sCiAgICAgIG9uY2xpY2s6ICgpID0-IHsKICAgICAgICBOLmJyb3dzaW5nID0gZmFsc2U7CiAgICAgICAgaWYgKG4pIG9wZW5Ob3RlKG4pOwogICAgICAgIGVsc2Ugc2hvd1NjcmF0Y2goKTsKICAgICAgICBzZXRWaWV3KCk7CiAgICAgIH0sCiAgICB9LAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ25pLXRvcCcgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ25pLXRpdGxlJyB9LCBpY29uKCdlZGl0JywgMTYpLCBoKCdzcGFuJywge30sIG1hcmtlZChub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUpKSksCiAgICAgICAgbiA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZGF0ZScsIHRleHQ6IHV0aWwucmVsYXRpdmVEYXRlKG4udXBkYXRlZCksIHRpdGxlOiB1dGlsLmZ1bGxEYXRlKG4udXBkYXRlZCkgfSkgOiBudWxsKSwKICAgICAgbiA_IGl0ZW1QcmV2aWV3KG4pIDogaCgnc3BhbicsIHsgY2xhc3M6ICduaS1zbmlwcGV0JywgdGV4dDogJ0VtcHR5IOKAkyB3cml0ZSBzb21ldGhpbmcgZG93bicgfSksCiAgICAgIG4gPyBoKCdzcGFuJywgeyBjbGFzczogJ25pLW1ldGEnIH0sIGhpdENvdW50KG4pKSA6IG51bGwpOwogIH0KCiAgLy8g4pSA4pSAIFNlYXJjaCByZXN1bHRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gR21haWwgZmluZHMgdGhlIG5vdGVzOyB0aGVzZSBzaG93IHdoZXJlIHRoZSB3b3JkcyBhcmUuIEVhY2ggcmVzdWx0CiAgLy8gZ2V0cyBleGNlcnB0cyBhcm91bmQgaXRzIG1hdGNoZXMgb25jZSBpdHMgdGV4dCBpcyBpbiwgd2l0aCB0aGUgd29yZHMKICAvLyBtYXJrZWQuIFVudGlsIHRoZW4gLSBvciBpZiBHbWFpbCBtYXRjaGVkIHNvbWV0aGluZyB0aGUgd29yZHMgZG8gbm90CiAgLy8gc2hvdywgc3VjaCBhcyBhIHN0ZW1tZWQgZm9ybSAtIGl0IHNob3dzIEdtYWlsJ3Mgb3duIHNuaXBwZXQuCgogIGNvbnN0IHRlcm1zS2V5ID0gKCkgPT4gSlNPTi5zdHJpbmdpZnkoTi50ZXJtcyk7CgogIC8vIFRleHQgd2l0aCB0aGUgc2VhcmNoIHdvcmRzIHdyYXBwZWQgaW4gPG1hcms-LCBidWlsdCBmcm9tIHRleHQgbm9kZXMuCiAgZnVuY3Rpb24gbWFya2VkKHRleHQsIG1hcmtzKSB7CiAgICBjb25zdCBzID0gU3RyaW5nKHRleHQgfHwgJycpOwogICAgY29uc3QgbSA9IG1hcmtzIHx8IChOLnRlcm1zLmxlbmd0aCA_IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKHMsIE4udGVybXMpIDogW10pOwogICAgaWYgKCFtLmxlbmd0aCkgcmV0dXJuIHM7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBhdCA9IDA7CiAgICBmb3IgKGNvbnN0IHsgc3RhcnQsIGVuZCB9IG9mIG0pIHsKICAgICA",
"gaWYgKHN0YXJ0ID4gYXQpIG91dC5wdXNoKHMuc2xpY2UoYXQsIHN0YXJ0KSk7CiAgICAgIG91dC5wdXNoKGgoJ21hcmsnLCB7IHRleHQ6IHMuc2xpY2Uoc3RhcnQsIGVuZCkgfSkpOwogICAgICBhdCA9IGVuZDsKICAgIH0KICAgIGlmIChhdCA8IHMubGVuZ3RoKSBvdXQucHVzaChzLnNsaWNlKGF0KSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gaXRlbVByZXZpZXcobikgewogICAgY29uc3QgaGl0ID0gTi50ZXJtcy5sZW5ndGggPyBOLmhpdHMuZ2V0KGAke24ubWVzc2FnZUlkfXwke3Rlcm1zS2V5KCl9YCkgOiBudWxsOwogICAgaWYgKGhpdCAmJiBoaXQuZXhjZXJwdHMubGVuZ3RoKSB7CiAgICAgIHJldHVybiBoKCdzcGFuJywgeyBjbGFzczogJ25pLWV4Y2VycHRzJyB9LCBoaXQuZXhjZXJwdHMubWFwKGV4ID0-IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktZXhjZXJwdCcgfSwKICAgICAgICBleC5jdXRCZWZvcmUgPyAnXHUyMDI2JyA6ICcnLCBtYXJrZWQoZXgudGV4dCwgZXgubWFya3MpLCBleC5jdXRBZnRlciA_ICdcdTIwMjYnIDogJycpKSk7CiAgICB9CiAgICByZXR1cm4gbi5zbmlwcGV0ID8gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1zbmlwcGV0JyB9LCBtYXJrZWQobi5zbmlwcGV0KSkgOiBudWxsOwogIH0KCiAgZnVuY3Rpb24gaGl0Q291bnQobikgewogICAgaWYgKCFOLnRlcm1zLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBoaXQgPSBOLmhpdHMuZ2V0KGAke24ubWVzc2FnZUlkfXw",
"ke3Rlcm1zS2V5KCl9YCk7CiAgICBpZiAoIWhpdCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1oaXRzJywgdGV4dDogYCR7aGl0LmNvdW50fSAke2hpdC5jb3VudCA9PT0gMSA_ICdtYXRjaCcgOiAnbWF0Y2hlcyd9YCB9KTsKICB9CgogIC8vIEZldGNoZXMgdGhlIHRleHQgb2YgdGhlIHJlc3VsdHMgb24gc2hvdyB0aGF0IGhhdmUgbm8gZXhjZXJwdHMgeWV0LAogIC8vIGEgZmV3IGF0IGEgdGltZSwgcmVkcmF3aW5nIHRoZSBsaXN0IGFzIHRoZXkgY29tZSBpbi4KICBsZXQgaGl0c1J1biA9IDA7CiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hIaXRzKCkgewogICAgaWYgKCFOLnRlcm1zLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgcnVuID0gKytoaXRzUnVuOwogICAgY29uc3Qga2V5ID0gdGVybXNLZXkoKTsKICAgIGNvbnN0IHRlcm1zID0gTi50ZXJtczsKICAgIGNvbnN0IHRvZG8gPSB2aXNpYmxlTm90ZXMoKS5zbGljZSgwLCBFWENFUlBUX0xJTUlUKS5maWx0ZXIobiA9PiAhTi5oaXRzLmhhcyhgJHtuLm1lc3NhZ2VJZH18JHtrZXl9YCkpOwogICAgbGV0IHJlZHJhdyA9IDA7CiAgICBhd2FpdCB1dGlsLm1hcFBvb2wodG9kbywgNCwgYXN5bmMgbiA9PiB7CiAgICAgIGlmIChydW4gIT09IGhpdHNSdW4pIHJldHVybjsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBkb2MgPSBhd2FpdCBub3Rlc1N0b3JlLmJvZHkobik7CiAgICAgICAgY29uc3QgdGV4dCA9IGZtdC5kb2NUZXh0KGR",
"vYyk7CiAgICAgICAgY29uc3QgYm9keSA9IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKHRleHQsIHRlcm1zKTsKICAgICAgICBjb25zdCB0aXRsZSA9IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKG4udGl0bGUsIHRlcm1zKTsKICAgICAgICBOLmhpdHMuc2V0KGAke24ubWVzc2FnZUlkfXwke2tleX1gLCB7CiAgICAgICAgICBjb3VudDogYm9keS5sZW5ndGggKyB0aXRsZS5sZW5ndGgsCiAgICAgICAgICBleGNlcnB0czogc2VhcmNoTG9naWMuZXhjZXJwdHModGV4dCwgYm9keSwgeyBjb250ZXh0OiA0NSwgbWF4OiAzIH0pLAogICAgICAgIH0pOwogICAgICB9IGNhdGNoIHsgLyogdGhlIHNuaXBwZXQgc3RhbmRzIGluICovIH0KICAgICAgaWYgKHJ1biA9PT0gaGl0c1J1biAmJiAhcmVkcmF3KSByZWRyYXcgPSBzZXRUaW1lb3V0KCgpID0-IHsgcmVkcmF3ID0gMDsgZHJhd0xpc3QoKTsgfSwgNjApOwogICAgfSk7CiAgICBpZiAocnVuID09PSBoaXRzUnVuKSBkcmF3TGlzdCgpOwogIH0KCiAgLy8g4pSA4pSAIEZpbmQgaW4gdGhlIG9wZW4gbm90ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYXBwbHlIaWdobGlnaHRzKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghZWxzLmVkIHx8ICFjIHx",
"8IGMuYm9keVN0YXRlICE9PSAncmVhZHknKSB7IGRyYXdGaW5kKCk7IHJldHVybjsgfQogICAgY29uc3QgY291bnQgPSBlbHMuZWQuaGlnaGxpZ2h0KE4udGVybXMpOwogICAgaWYgKE4uZmluZEluZGV4ID49IGNvdW50KSBOLmZpbmRJbmRleCA9IDA7CiAgICBpZiAoY291bnQpIGVscy5lZC5zaG93TWF0Y2goTi5maW5kSW5kZXgpOwogICAgZHJhd0ZpbmQoKTsKICB9CgogIGZ1bmN0aW9uIHN0ZXBNYXRjaChkZWx0YSkgewogICAgY29uc3QgY291bnQgPSBlbHMuZWQgPyBlbHMuZWQubWF0Y2hDb3VudCgpIDogMDsKICAgIGlmICghY291bnQpIHJldHVybjsKICAgIE4uZmluZEluZGV4ID0gKE4uZmluZEluZGV4ICsgZGVsdGEgKyBjb3VudCkgJSBjb3VudDsKICAgIGVscy5lZC5zaG93TWF0Y2goTi5maW5kSW5kZXgpOwogICAgZHJhd0ZpbmQoKTsKICB9CgogIGZ1bmN0aW9uIGNsZWFyU2VhcmNoKCkgewogICAgaWYgKCFlbHMuc2VhcmNoKSByZXR1cm47CiAgICBlbHMuc2VhcmNoLnZhbHVlID0gJyc7CiAgICBOLnF1ZXJ5ID0gJyc7CiAgICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgbG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogIH0KCiAgZnVuY3Rpb24gZHJhd0ZpbmQoKSB7CiAgICBpZiAoIWVscy5maW5kU2xvdCkgcmV0dXJuOwogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghTi50ZXJtcy5sZW5ndGggfHwgIWMgfHwgIWVscy5lZCB8fCBjLmJvZHlTdGF0ZSAhPT0gJ3JlYWR5JykgewogICAgICB",
"lbHMuZmluZFNsb3QucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGNvdW50ID0gZWxzLmVkLm1hdGNoQ291bnQoKTsKICAgIGNvbnN0IHdvcmRzID0gTi50ZXJtcy5tYXAodCA9PiB0LndvcmRzLmpvaW4oJyAnKSkuam9pbignLCAnKTsKICAgIC8vIEEgcmVkcmF3IHJlcGxhY2VzIHRoZSBhcnJvdyBqdXN0IHByZXNzZWQ7IGZvY3VzIGdvZXMgdG8gaXRzIHN1Y2Nlc3NvcgogICAgLy8gcmF0aGVyIHRoYW4gZmFsbGluZyBvdXQgb2YgdGhlIGJvYXJkLCB3aGVyZSBGMyB3b3VsZCBub3QgcmVhY2ggaXQuCiAgICBjb25zdCBhY3RpdmUgPSBOLmN0eC5yb290LmFjdGl2ZUVsZW1lbnQ7CiAgICBjb25zdCByZWZvY3VzID0gYWN0aXZlICYmIGVscy5maW5kU2xvdC5jb250YWlucyhhY3RpdmUpID8gYWN0aXZlLmRhdGFzZXQua2V5IDogJyc7CiAgICBlbHMuZmluZFNsb3QucmVwbGFjZUNoaWxkcmVuKGgoJ2RpdicsIHsgY2xhc3M6ICduZS1maW5kJywgcm9sZTogJ3NlYXJjaCcsICdhcmlhLWxhYmVsJzogJ01hdGNoZXMgaW4gdGhpcyBub3RlJyB9LAogICAgICBpY29uKCdzZWFyY2gnLCAxOCksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmluZC13b3JkcycsIHRleHQ6IHdvcmRzLCB0aXRsZTogd29yZHMgfSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmluZC1wb3MnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScsIHRleHQ6IGNvdW50ID8gYCR7Ti5maW5kSW5kZXggKyAxfSBvZiA",
"ke2NvdW50fWAgOiAnTm90IGluIHRoZSB0ZXh0JyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnUHJldmlvdXMgbWF0Y2ggKFNoaWZ0K0YzKScsIHRpdGxlOiAnUHJldmlvdXMgbWF0Y2ggKFNoaWZ0K0YzKScsCiAgICAgICAgZGlzYWJsZWQ6IGNvdW50IDwgMiwgZGF0YXNldDogeyBrZXk6ICdmaW5kLXByZXYnIH0sIG9uY2xpY2s6ICgpID0-IHN0ZXBNYXRjaCgtMSksCiAgICAgIH0sIGljb24oJ3VwJywgMTgpKSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnTmV4dCBtYXRjaCAoRjMpJywgdGl0bGU6ICdOZXh0IG1hdGNoIChGMyknLAogICAgICAgIGRpc2FibGVkOiBjb3VudCA8IDIsIGRhdGFzZXQ6IHsga2V5OiAnZmluZC1uZXh0JyB9LCBvbmNsaWNrOiAoKSA9PiBzdGVwTWF0Y2goMSksCiAgICAgIH0sIGljb24oJ2Rvd24nLCAxOCkpLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDbGVhciB0aGUgc2VhcmNoJywgdGl0bGU6ICdDbGVhciB0aGUgc2VhcmNoJywKICAgICAgICBkYXRhc2V0OiB7IGtleTogJ2ZpbmQtY2xlYXInIH0sIG9uY2xpY2s6IGNsZWFyU2VhcmNoLAogICAgICB9LCBpY29uKCdjbG9zZScsIDE4KSkpKTsKICA",
"gIGlmIChyZWZvY3VzKSB7CiAgICAgIGNvbnN0IGFnYWluID0gZWxzLmZpbmRTbG90LnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLWtleT0iJHtyZWZvY3VzfSJdYCk7CiAgICAgIGlmIChhZ2FpbiAmJiAhYWdhaW4uZGlzYWJsZWQpIGFnYWluLmZvY3VzKCk7CiAgICB9CiAgfQoKICAvLyDilIDilIAgRm9sZGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gY291bnRzKCkgewogICAgY29uc3Qgb3V0ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCBuIG9mIE4ubm90ZXMpIG91dC5zZXQobi5mb2xkZXJJZCB8fCAnJywgKG91dC5nZXQobi5mb2xkZXJJZCB8fCAnJykgfHwgMCkgKyAxKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBzZXRGb2xkZXJzT3BlbihvcGVuKSB7CiAgICBpZiAoIWVscy53cmFwKSByZXR1cm47CiAgICBlbHMud3JhcC5kYXRhc2V0LmZvbGRlcnMgPSBvcGVuID8gJ29wZW4nIDogJ2Nsb3NlZCc7CiAgICBlbHMuZm9sZGVyc1RvZ2dsZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnLCBTdHJpbmcob3BlbikpOwogIH0KCiAgLy8g4pSA4pSAIEZvbGRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGZvbGRlciB3aXRoIHN1YmZvbGRlcnMgaGFzIGFuIGFycm93IHRoYXQgZm9sZHMgdGhlbSBhd2F5LCBmb3IgYSB0cmVlCiAgLy8gdGhhdCBoYXMgZ3Jvd24gbG9uZy4gV2hpY2ggb25lcyBhcmUgZm9sZGVkIGlzIHJlbWVtYmVyZWQgd2hlcmUgdGhlCiAgLy8gaG9zdCBrZWVwcyBzdWNoIHRoaW5ncyAoY3R4LnByZWZzKSwgaWYgaXQgZG9lczogYSBuaWNldHksIHNvIGFueQogIC8vIHRyb3VibGUgd2l0aCBpdCBqdXN0IGxlYXZlcyBldmVyeSBmb2xkZXIgb3Blbi4KCiAgZnVuY3Rpb24gaGFzU3ViZm9sZGVycyhmKSB7CiAgICByZXR1cm4gTi5mb2xkZXJzLnNvbWUoeCA9PiB4Lm5hbWUuc3RhcnRzV2l0aChgJHtmLm5hbWV9L2ApKTsKICB9CgogIC8vIEluc2lkZSBhIGZvbGRlZCBmb2xkZXIsIGF0IGFueSBkZXB0aC4KICBmdW5jdGlvbiBpc1R1Y2tlZChmKSB7CiAgICByZXR1cm4gTi5mb2xkZXJzLnNvbWUoeCA9PiBOLmZvbGRlZC5oYXMoeC5pZCkgJiYgZi5uYW1lLnN0YXJ0c1dpdGgoYCR7eC5uYW1lfS9gKSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiByZWFkRm9sZGVkKCkgewogICAgTi5mb2xkZWRSZWFkID0gdHJ1ZTsKICAgIGNvbnN",
"0IHByZWZzID0gTi5jdHggJiYgTi5jdHgucHJlZnM7CiAgICBpZiAoIXByZWZzKSByZXR1cm47CiAgICB0cnkgewogICAgICBjb25zdCBpZHMgPSBhd2FpdCBwcmVmcy5nZXQoJ2ZvbGRlZEZvbGRlcnMnKTsKICAgICAgaWYgKEFycmF5LmlzQXJyYXkoaWRzKSkgTi5mb2xkZWQgPSBuZXcgU2V0KGlkcy5maWx0ZXIoaWQgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJykpOwogICAgfSBjYXRjaCAoZXJyKSB7IC8qIGV2ZXJ5IGZvbGRlciBvcGVuICovIH0KICB9CgogIGZ1bmN0aW9uIHNhdmVGb2xkZWQoKSB7CiAgICBjb25zdCBwcmVmcyA9IE4uY3R4ICYmIE4uY3R4LnByZWZzOwogICAgaWYgKCFwcmVmcykgcmV0dXJuOwogICAgLy8gT25seSBmb2xkZXJzIHRoYXQgYXJlIHN0aWxsIHRoZXJlLCBzbyBkZWxldGVkIG9uZXMgZG8gbm90IHBpbGUgdXAuCiAgICBjb25zdCBpZHMgPSBbLi4uTi5mb2xkZWRdLmZpbHRlcihpZCA9PiBmb2xkZXJCeUlkKGlkKSk7CiAgICB0cnkgewogICAgICBQcm9taXNlLnJlc29sdmUocHJlZnMuc2V0KCdmb2xkZWRGb2xkZXJzJywgaWRzKSkuY2F0Y2goKCkgPT4ge30pOwogICAgfSBjYXRjaCAoZXJyKSB7IC8qIG5vdCByZW1lbWJlcmVkLCB0aGF0IGlzIGFsbCAqLyB9CiAgfQoKICBmdW5jdGlvbiBzZXRGb2xkZWQoZiwgZm9sZGVkKSB7CiAgICBpZiAoZm9sZGVkID09PSBOLmZvbGRlZC5oYXMoZi5pZCkpIHJldHVybjsKICAgIGlmIChmb2xkZWQpIE4uZm9sZGVkLmFkZChmLmlkKTsKICAgIGV",
"sc2UgTi5mb2xkZWQuZGVsZXRlKGYuaWQpOwogICAgc2F2ZUZvbGRlZCgpOwogICAgLy8gVGhlIHJvd3MgYXJlIGRyYXduIGFmcmVzaDoga2VlcCB0aGUga2V5Ym9hcmQgd2hlcmUgaXQgd2FzLgogICAgY29uc3QgYWN0aXZlID0gTi5jdHgucm9vdC5hY3RpdmVFbGVtZW50OwogICAgY29uc3Qga2V5ID0gYWN0aXZlICYmIGVscy5mb2xkZXJJdGVtcy5jb250YWlucyhhY3RpdmUpID8gYWN0aXZlLmRhdGFzZXQua2V5IDogJyc7CiAgICBkcmF3Rm9sZGVycygpOwogICAgaWYgKGtleSkgewogICAgICBjb25zdCBhZ2FpbiA9IGVscy5mb2xkZXJJdGVtcy5xdWVyeVNlbGVjdG9yKGBbZGF0YS1rZXk9IiR7a2V5fSJdYCk7CiAgICAgIGlmIChhZ2FpbikgYWdhaW4uZm9jdXMoKTsKICAgIH0KICB9CgogIC8vIE9wZW5zIGV2ZXJ5IGZvbGRlciBhYm92ZSB0aGlzIG9uZSwgYW5kIHdpdGggc2VsZiwgdGhpcyBvbmUgdG9vLgogIGZ1bmN0aW9uIHVuZm9sZChmLCBzZWxmKSB7CiAgICBsZXQgY2hhbmdlZCA9IGZhbHNlOwogICAgZm9yIChjb25zdCB4IG9mIE4uZm9sZGVycykgewogICAgICBpZiAoTi5mb2xkZWQuaGFzKHguaWQpICYmICgoc2VsZiAmJiB4LmlkID09PSBmLmlkKSB8fCBmLm5hbWUuc3RhcnRzV2l0aChgJHt4Lm5hbWV9L2ApKSkgewogICAgICAgIE4uZm9sZGVkLmRlbGV0ZSh4LmlkKTsKICAgICAgICBjaGFuZ2VkID0gdHJ1ZTsKICAgICAgfQogICAgfQogICAgaWYgKGNoYW5nZWQpIHNhdmVGb2xkZWQoKTsKICB9Cgo",
"gIGZ1bmN0aW9uIHNlbGVjdEZvbGRlcihpZCkgewogICAgc2V0Rm9sZGVyc09wZW4oZmFsc2UpOwogICAgLy8gT24gYSBwaG9uZSwgY2hvb3NpbmcgYSBmb2xkZXIgLSAiQWxsIG5vdGVzIiB0b28gLSBzaG93cyBpdHMgbGlzdC4KICAgIGlmICghTi5icm93c2luZykgeyBOLmJyb3dzaW5nID0gdHJ1ZTsgc2V0VmlldygpOyB9CiAgICBpZiAoTi5mb2xkZXIgPT09IGlkKSByZXR1cm47CiAgICBOLmZvbGRlciA9IGlkOwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgICBmZXRjaEhpdHMoKTsKICB9CgogIGZ1bmN0aW9uIGRyYXdGb2xkZXJzKCkgewogICAgaWYgKCFlbHMuZm9sZGVySXRlbXMpIHJldHVybjsKICAgIGNvbnN0IHRhbGx5ID0gY291bnRzKCk7CiAgICBjb25zdCByb3dzID0gW2ZvbGRlclJvdyhudWxsLCBOLm5vdGVzLmxlbmd0aCldOwogICAgY29uc3QgZWRpdCA9IE4uZm9sZGVyRWRpdDsKICAgIGlmIChlZGl0ICYmIGVkaXQubW9kZSA9PT0gJ25ldycgJiYgIWVkaXQucGFyZW50SWQpIHJvd3MucHVzaChlZGl0Um93KDApKTsKICAgIGNvbnN0IGN1cnJlbnQgPSBOLmZvbGRlciA_IGZvbGRlckJ5SWQoTi5mb2xkZXIpIDogbnVsbDsKICAgIE4uZm9sZGVycy5mb3JFYWNoKChmLCBpKSA9PiB7CiAgICAgIGlmICghaXNUdWNrZWQoZikpIHsKICAgICAgICByb3dzLnB1c2goZWRpdCAmJiBlZGl0Lm1vZGUgPT09ICdyZW5hbWUnICYmIGVkaXQuZm9sZGVySWQgPT09IGYuaWQgPyBlZGl0Um93KGY",
"uZGVwdGgsIGYpCiAgICAgICAgICA6IGZvbGRlclJvdyhmLCB0YWxseS5nZXQoZi5pZCkgfHwgMCwgISFjdXJyZW50ICYmIE4uZm9sZGVkLmhhcyhmLmlkKSAmJiBjdXJyZW50Lm5hbWUuc3RhcnRzV2l0aChgJHtmLm5hbWV9L2ApKSk7CiAgICAgIH0KICAgICAgLy8gQSBuZXcgc3ViZm9sZGVyJ3MgZmllbGQgZ29lcyBhZnRlciB0aGUgd2hvbGUgYnJhbmNoIGl0IGpvaW5zLgogICAgICBjb25zdCBuZXh0ID0gTi5mb2xkZXJzW2kgKyAxXTsKICAgICAgY29uc3QgYnJhbmNoRW5kcyA9ICFuZXh0IHx8ICFuZXh0Lm5hbWUuc3RhcnRzV2l0aChgJHtmLm5hbWV9L2ApOwogICAgICBpZiAoZWRpdCAmJiBlZGl0Lm1vZGUgPT09ICduZXcnICYmIGVkaXQucGFyZW50SWQpIHsKICAgICAgICBjb25zdCBwYXJlbnQgPSBmb2xkZXJCeUlkKGVkaXQucGFyZW50SWQpOwogICAgICAgIGlmIChwYXJlbnQgJiYgKGYuaWQgPT09IHBhcmVudC5pZCB8fCBmLm5hbWUuc3RhcnRzV2l0aChgJHtwYXJlbnQubmFtZX0vYCkpICYmIGJyYW5jaEVuZHMpIHJvd3MucHVzaChlZGl0Um93KHBhcmVudC5kZXB0aCArIDEpKTsKICAgICAgfQogICAgfSk7CiAgICBlbHMuZm9sZGVySXRlbXMucmVwbGFjZUNoaWxkcmVuKC4uLnJvd3MpOwogICAgLy8gUm9vbSBmb3IgdGhlIGFycm93cyBvbmx5IG9uY2Ugc29tZSBmb2xkZXIgaGFzIHN1YmZvbGRlcnMuCiAgICBlbHMuZm9sZGVySXRlbXMudG9nZ2xlQXR0cmlidXRlKCdkYXRhLW5lc3RlZCcsIE4uZm9sZGV",
"ycy5zb21lKGYgPT4gZi5kZXB0aCA-IDApKTsKCiAgICBjb25zdCBzaG93biA9IE4uZm9sZGVyID8gZm9sZGVyQnlJZChOLmZvbGRlcikgOiBudWxsOwogICAgZWxzLmZvbGRlcnNUb2dnbGUucmVwbGFjZUNoaWxkcmVuKAogICAgICBpY29uKHNob3duID8gJ2ZvbGRlcicgOiAnbm90ZXMnLCAyMCksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZnQtbGFiZWwnLCB0ZXh0OiBzaG93biA_IGZvbGRlckxhYmVsKHNob3duLmlkKSA6ICdBbGwgbm90ZXMnIH0pLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2Z0LWNvdW50JywgdGV4dDogTi5zdGF0dXMgPT09ICdyZWFkeScgPyBTdHJpbmcoc2hvd24gPyB0YWxseS5nZXQoc2hvd24uaWQpIHx8IDAgOiBOLm5vdGVzLmxlbmd0aCkgOiAnJyB9KSwKICAgICAgaWNvbignY2FyZXQnLCAyMCkpOwogIH0KCiAgLy8gaG9sZHNDdXJyZW50OiBmb2xkZWQsIHdpdGggdGhlIGZvbGRlciBiZWluZyBsb29rZWQgYXQgc29tZXdoZXJlIGluc2lkZS4KICBmdW5jdGlvbiBmb2xkZXJSb3coZiwgY291bnQsIGhvbGRzQ3VycmVudCA9IGZhbHNlKSB7CiAgICBjb25zdCBpZCA9IGYgPyBmLmlkIDogJyc7CiAgICBjb25zdCBjaGlsZHJlbiA9IGYgPyBoYXNTdWJmb2xkZXJzKGYpIDogZmFsc2U7CiAgICBjb25zdCBmb2xkZWQgPSBjaGlsZHJlbiAmJiBOLmZvbGRlZC5oYXMoaWQpOwogICAgY29uc3Qgcm93ID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ2ZvbGRlci1yb3cnLCByb2xlOiAnbGl",
"zdGl0ZW0nLCBkYXRhc2V0OiB7IGZvbGRlcjogaWQgfHwgJ2FsbCcgfSwKICAgIH0sCiAgICAgIGNoaWxkcmVuID8gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnZm9sZGVyLXR3aXN0eScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1leHBhbmRlZCc6IFN0cmluZyghZm9sZGVkKSwKICAgICAgICAnYXJpYS1sYWJlbCc6IGAke2ZvbGRlZCA_ICdTaG93JyA6ICdIaWRlJ30gdGhlIGZvbGRlcnMgaW4gJHtmLnRpdGxlfWAsIHRpdGxlOiBmb2xkZWQgPyAnU2hvdyBzdWJmb2xkZXJzJyA6ICdIaWRlIHN1YmZvbGRlcnMnLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgZm9sZGVyLXR3aXN0eToke2lkfWAgfSwgb25jbGljazogKCkgPT4gc2V0Rm9sZGVkKGYsICFmb2xkZWQpLAogICAgICB9LCBpY29uKCdjYXJldCcsIDE4KSkgOiBoKCdzcGFuJywgeyBjbGFzczogJ2ZvbGRlci10d2lzdHknLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogYGZvbGRlci1idG4ke2hvbGRzQ3VycmVudCA_ICcgaG9sZHMtY3VycmVudCcgOiAnJ31gLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtY3VycmVudCc6IE4uZm9sZGVyID09PSBpZCA_ICd0cnVlJyA6IG51bGwsCiAgICAgICAgZGF0YXNldDogeyBrZXk6IGBmb2xkZXI6JHtpZCB8fCAnYWxsJ31gIH0sIHRpdGxlOiBmID8gZi5uYW1lIDogJ0V2ZXJ5IG5vdGUsIGluIGFueSBmb2xkZXInLAogICAgICAgIG9uY2xpY2s6ICgpID0",
"-IHNlbGVjdEZvbGRlcihpZCksCiAgICAgICAgLy8gQXMgaW4gYW55IHRyZWU6IHJpZ2h0IG9wZW5zIGEgZm9sZGVyJ3Mgc3ViZm9sZGVycywgbGVmdCBmb2xkcyB0aGVtLgogICAgICAgIG9ua2V5ZG93bjogZSA9PiB7CiAgICAgICAgICBpZiAoIWNoaWxkcmVuIHx8IGUuYWx0S2V5IHx8IGUuY3RybEtleSB8fCBlLm1ldGFLZXkgfHwgZS5zaGlmdEtleSkgcmV0dXJuOwogICAgICAgICAgaWYgKGUua2V5ID09PSAnQXJyb3dSaWdodCcgJiYgZm9sZGVkKSB7IGUucHJldmVudERlZmF1bHQoKTsgc2V0Rm9sZGVkKGYsIGZhbHNlKTsgfQogICAgICAgICAgaWYgKGUua2V5ID09PSAnQXJyb3dMZWZ0JyAmJiAhZm9sZGVkKSB7IGUucHJldmVudERlZmF1bHQoKTsgc2V0Rm9sZGVkKGYsIHRydWUpOyB9CiAgICAgICAgfSwKICAgICAgfSwKICAgICAgICBpY29uKGYgPyAnZm9sZGVyJyA6ICdub3RlcycsIDE4KSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2ZvbGRlci10aXRsZScsIHRleHQ6IGYgPyBmLnRpdGxlIDogJ0FsbCBub3RlcycgfSksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmb2xkZXItY291bnQnLCB0ZXh0OiBOLnN0YXR1cyA9PT0gJ3JlYWR5JyA_IFN0cmluZyhjb3VudCkgOiAnJyB9KSksCiAgICAgIGYgPyBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0biBmb2xkZXItbWVudScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6IGBNb3JlIGFjdGlvbnM6ICR7Zi50aXRsZX1",
"gLCB0aXRsZTogJ01vcmUgYWN0aW9ucycsCiAgICAgICAgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywgZGF0YXNldDogeyBrZXk6IGBmb2xkZXItbWVudToke2lkfWAgfSwKICAgICAgICBvbmNsaWNrOiBlID0-IG9wZW5NZW51KE4uY3R4LnJvb3QsIGUuY3VycmVudFRhcmdldCwgWwogICAgICAgICAgeyBsYWJlbDogJ1JlbmFtZScsIGljb246ICdlZGl0Jywga2V5OiAnZm9sZGVyLXJlbmFtZScsIG9uU2VsZWN0OiAoKSA9PiBzdGFydEZvbGRlckVkaXQoeyBtb2RlOiAncmVuYW1lJywgZm9sZGVySWQ6IGlkIH0pIH0sCiAgICAgICAgICB7IGxhYmVsOiAnTmV3IHN1YmZvbGRlcicsIGljb246ICdhZGQnLCBrZXk6ICdmb2xkZXItc3ViJywgb25TZWxlY3Q6ICgpID0-IHN0YXJ0Rm9sZGVyRWRpdCh7IG1vZGU6ICduZXcnLCBwYXJlbnRJZDogaWQgfSkgfSwKICAgICAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgICAgICB7CiAgICAgICAgICAgIGxhYmVsOiBjb3VudCB8fCBjaGlsZHJlbiA_ICdEZWxldGUgKGVtcHR5IGl0IGZpcnN0KScgOiAnRGVsZXRlJywgaWNvbjogJ2RlbGV0ZScsIGRhbmdlcjogdHJ1ZSwga2V5OiAnZm9sZGVyLWRlbGV0ZScsCiAgICAgICAgICAgIGRpc2FibGVkOiAhIShjb3VudCB8fCBjaGlsZHJlbiksIG9uU2VsZWN0OiAoKSA9PiByZW1vdmVGb2xkZXIoZiksCiAgICAgICAgICB9LAogICAgICAgIF0sIHsgbGFiZWw6IGBBY3Rpb25zIGZvciA",
"ke2YudGl0bGV9YCB9KSwKICAgICAgfSwgaWNvbignbW9yZScsIDE4KSkgOiBudWxsKTsKICAgIC8vIFRocm91Z2ggdGhlIHN0eWxlIEFQSSwgbm90IGEgc3R5bGUgYXR0cmlidXRlOiBhIHBhZ2UncyBzZWN1cml0eQogICAgLy8gcG9saWN5IG1heSByZWZ1c2UgaW5saW5lIHN0eWxlIGF0dHJpYnV0ZXMsIG5ldmVyIHRoaXMuCiAgICByb3cuc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZiA_IGYuZGVwdGggOiAwKSk7CgogICAgLy8gRHJvcHBpbmcgYSBub3RlIGhlcmUgZmlsZXMgaXQgaGVyZTsgb24gIkFsbCBub3RlcyIsIHRha2VzIGl0IG91dCBvZgogICAgLy8gaXRzIGZvbGRlci4KICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsIGUgPT4gewogICAgICBpZiAoIU4uZHJhZ0tleSkgcmV0dXJuOwogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGUuZGF0YVRyYW5zZmVyLmRyb3BFZmZlY3QgPSAnbW92ZSc7CiAgICAgIHJvdy5jbGFzc0xpc3QuYWRkKCdkcm9wJyk7CiAgICB9KTsKICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCdkcmFnbGVhdmUnLCAoKSA9PiByb3cuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcCcpKTsKICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCdkcm9wJywgZSA9PiB7CiAgICAgIGlmICghTi5kcmFnS2V5KSByZXR1cm47CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgcm93LmNsYXNzTGlzdC5yZW1vdmUoJ2Ryb3AnKTsKICAgICAgY29uc3Qgbm90ZSA",
"9IE4ubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBOLmRyYWdLZXkpOwogICAgICBOLmRyYWdLZXkgPSAnJzsKICAgICAgaWYgKG5vdGUpIG1vdmVOb3RlKG5vdGUsIGlkKTsKICAgIH0pOwogICAgcmV0dXJuIHJvdzsKICB9CgogIGZ1bmN0aW9uIGVkaXRSb3coZGVwdGgsIGZvbGRlcikgewogICAgY29uc3QgZWRpdCA9IE4uZm9sZGVyRWRpdDsKICAgIGNvbnN0IGlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCBmb2xkZXItaW5wdXQnLCB0eXBlOiAndGV4dCcsIHZhbHVlOiBlZGl0LnZhbHVlLCBtYXhsZW5ndGg6IFN0cmluZyhub3Rlc0xvZ2ljLkZPTERFUl9OQU1FX01BWCksCiAgICAgIHBsYWNlaG9sZGVyOiBlZGl0Lm1vZGUgPT09ICduZXcnID8gJ0ZvbGRlciBuYW1lLCB0aGVuIEVudGVyJyA6ICcnLCAnYXJpYS1sYWJlbCc6IGVkaXQubW9kZSA9PT0gJ25ldycgPyAnTmV3IGZvbGRlciBuYW1lJyA6IGBSZW5hbWUgJHtmb2xkZXIudGl0bGV9YCwKICAgICAgZGlzYWJsZWQ6ICEhZWRpdC5idXN5LCBkYXRhc2V0OiB7IGtleTogJ2ZvbGRlci1pbnB1dCcgfSwKICAgICAgb25pbnB1dDogZSA9PiB7IGVkaXQudmFsdWUgPSBlLnRhcmdldC52YWx1ZTsgfSwKICAgICAgb25rZXlkb3duOiBlID0-IHsKICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBjb21taXRGb2xkZXJFZGl0KCk7IH0KICAgICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB",
"7IGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgY2FuY2VsRm9sZGVyRWRpdCgpOyB9CiAgICAgIH0sCiAgICAgIG9uYmx1cjogKCkgPT4geyBpZiAoIWVkaXQuYnVzeSAmJiBOLmZvbGRlckVkaXQgPT09IGVkaXQpIHNldFRpbWVvdXQoKCkgPT4geyBpZiAoTi5mb2xkZXJFZGl0ID09PSBlZGl0ICYmICFlZGl0LmJ1c3kpIGNhbmNlbEZvbGRlckVkaXQoKTsgfSwgMTUwKTsgfSwKICAgIH0pOwogICAgY29uc3Qgcm93ID0gaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlci1yb3cgZWRpdGluZycgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlci1lZGl0JyB9LCBpY29uKCdmb2xkZXInLCAxOCksIGlucHV0KSwKICAgICAgZWRpdC5lcnJvciA_IGgoJ2RpdicsIHsgY2xhc3M6ICdmb2xkZXItZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBlZGl0LmVycm9yIH0pIDogbnVsbCk7CiAgICByb3cuc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZGVwdGgpKTsKICAgIHJldHVybiByb3c7CiAgfQoKICBmdW5jdGlvbiBzdGFydEZvbGRlckVkaXQoeyBtb2RlLCBwYXJlbnRJZCA9ICcnLCBmb2xkZXJJZCA9ICcnIH0pIHsKICAgIGNvbnN0IGYgPSBmb2xkZXJCeUlkKGZvbGRlcklkKTsKICAgIC8vIEEgbmV3IHN1YmZvbGRlcidzIGZpZWxkIHNob3dzIGluc2lkZSBpdHMgcGFyZW50LCBzbyB0aGF0IGhhcyB0byBiZSBvcGVuLgogICAgY29uc3QgcGFyZW50ID0gbW9kZSA9PT0gJ25",
"ldycgPyBmb2xkZXJCeUlkKHBhcmVudElkKSA6IG51bGw7CiAgICBpZiAocGFyZW50KSB1bmZvbGQocGFyZW50LCB0cnVlKTsKICAgIE4uZm9sZGVyRWRpdCA9IHsgbW9kZSwgcGFyZW50SWQsIGZvbGRlcklkLCB2YWx1ZTogbW9kZSA9PT0gJ3JlbmFtZScgJiYgZiA_IGYudGl0bGUgOiAnJywgZXJyb3I6ICcnLCBidXN5OiBmYWxzZSB9OwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGNvbnN0IGlucHV0ID0gZWxzLmZvbGRlckl0ZW1zLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0iZm9sZGVyLWlucHV0Il0nKTsKICAgIGlmIChpbnB1dCkgeyBpbnB1dC5mb2N1cygpOyBpbnB1dC5zZWxlY3QoKTsgfQogIH0KCiAgZnVuY3Rpb24gY2FuY2VsRm9sZGVyRWRpdCgpIHsKICAgIGlmICghTi5mb2xkZXJFZGl0KSByZXR1cm47CiAgICBOLmZvbGRlckVkaXQgPSBudWxsOwogICAgZHJhd0ZvbGRlcnMoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGNvbW1pdEZvbGRlckVkaXQoKSB7CiAgICBjb25zdCBlZGl0ID0gTi5mb2xkZXJFZGl0OwogICAgaWYgKCFlZGl0IHx8IGVkaXQuYnVzeSkgcmV0dXJuOwogICAgY29uc3QgdGFyZ2V0ID0gZWRpdC5tb2RlID09PSAncmVuYW1lJyA_IGZvbGRlckJ5SWQoZWRpdC5mb2xkZXJJZCkgOiBudWxsOwogICAgY29uc3QgcGFyZW50ID0gZWRpdC5tb2RlID09PSAnbmV3JyA_IGZvbGRlckJ5SWQoZWRpdC5wYXJlbnRJZCkgOiBudWxsOwogICAgY29uc3QgcGFyZW50UGF0aCA9IHRhcmdldCA_IHRhcmd",
"ldC5wYXJlbnRQYXRoIDogcGFyZW50ID8gcGFyZW50LnBhdGggOiAnJzsKICAgIGNvbnN0IHNpYmxpbmdzID0gTi5mb2xkZXJzLmZpbHRlcihmID0-IGYucGFyZW50UGF0aCA9PT0gcGFyZW50UGF0aCAmJiBmICE9PSB0YXJnZXQpLm1hcChmID0-IGYudGl0bGUpOwogICAgY29uc3QgcHJvYmxlbSA9IG5vdGVzTG9naWMudmFsaWRhdGVGb2xkZXJUaXRsZShlZGl0LnZhbHVlLCBzaWJsaW5ncyk7CiAgICBpZiAoZWRpdC5tb2RlID09PSAncmVuYW1lJyAmJiB0YXJnZXQgJiYgZWRpdC52YWx1ZS50cmltKCkgPT09IHRhcmdldC50aXRsZSkgeyBjYW5jZWxGb2xkZXJFZGl0KCk7IHJldHVybjsgfQogICAgaWYgKHByb2JsZW0pIHsKICAgICAgZWRpdC5lcnJvciA9IHByb2JsZW07CiAgICAgIGRyYXdGb2xkZXJzKCk7CiAgICAgIGNvbnN0IGlucHV0ID0gZWxzLmZvbGRlckl0ZW1zLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0iZm9sZGVyLWlucHV0Il0nKTsKICAgICAgaWYgKGlucHV0KSBpbnB1dC5mb2N1cygpOwogICAgICByZXR1cm47CiAgICB9CiAgICBlZGl0LmJ1c3kgPSB0cnVlOwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIHRyeSB7CiAgICAgIGlmIChlZGl0Lm1vZGUgPT09ICduZXcnKSB7CiAgICAgICAgY29uc3QgbWFkZSA9IGF3YWl0IG5vdGVzU3RvcmUuY3JlYXRlRm9sZGVyKHBhcmVudCwgZWRpdC52YWx1ZSk7CiAgICAgICAgTi5mb2xkZXJzID0gbm90ZXNTdG9yZS5mb2xkZXJzKCk7CiAgICAgICAgaWYgKG1hZGU",
"pIE4uZm9sZGVyID0gbWFkZS5pZDsKICAgICAgICB0b2FzdChOLmN0eC5yb290LCBgRm9sZGVyIOKAnCR7ZWRpdC52YWx1ZS50cmltKCl94oCdIGNyZWF0ZWQuYCk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgYXdhaXQgbm90ZXNTdG9yZS5yZW5hbWVGb2xkZXIodGFyZ2V0LCBlZGl0LnZhbHVlKTsKICAgICAgICBOLmZvbGRlcnMgPSBub3Rlc1N0b3JlLmZvbGRlcnMoKTsKICAgICAgfQogICAgICBOLmZvbGRlckVkaXQgPSBudWxsOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGVkaXQuYnVzeSA9IGZhbHNlOwogICAgICBlZGl0LmVycm9yID0gYENvdWxkbuKAmXQgc2F2ZTogJHtlcnIubWVzc2FnZX1gOwogICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIE4uY3R4Lm9uU3RhdGVFcnJvcihlcnIpOwogICAgfQogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgICBpZiAoTi5jdXJyZW50KSBkcmF3QmFyKCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiByZW1vdmVGb2xkZXIoZikgewogICAgdHJ5IHsKICAgICAgYXdhaXQgbm90ZXNTdG9yZS5kZWxldGVGb2xkZXIoZik7CiAgICAgIE4uZm9sZGVycyA9IG5vdGVzU3RvcmUuZm9sZGVycygpOwogICAgICBpZiAoTi5mb2xkZXIgPT09IGYuaWQpIE4uZm9sZGVyID0gJyc7CiAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBGb2xkZXIg4oCcJHtmLnRpdGxlfeKAnSBkZWxldGVkLmApOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGNvbnN0IG1",
"zZyA9IGVyci5jb2RlID09PSAnbm90X2FsbG93ZWQnID8gJ09ubHkgYW4gZW1wdHkgZm9sZGVyIGNhbiBiZSBkZWxldGVkLiBNb3ZlIGl0cyBub3RlcyBvdXQgZmlyc3QuJyA6IGVyci5tZXNzYWdlOwogICAgICB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBkZWxldGUg4oCcJHtmLnRpdGxlfeKAnTogJHttc2d9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogICAgfQogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgfQoKICAvLyBSdW5zIGFmdGVyIGFueSBzYXZlIGluIHByb2dyZXNzLCBzbyB0aGUgbW92ZSBsYW5kcyBvbiB0aGUgbmV3ZXN0CiAgLy8gdmVyc2lvbiByYXRoZXIgdGhhbiBvbmUgYWJvdXQgdG8gYmUgcmVwbGFjZWQuCiAgZnVuY3Rpb24gbW92ZU5vdGUobm90ZSwgZm9sZGVySWQpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQgJiYgTi5jdXJyZW50Lm5vdGUgPT09IG5vdGUgPyBOLmN1cnJlbnQgOiBudWxsOwogICAgaWYgKChub3RlLmZvbGRlcklkIHx8ICcnKSA9PT0gKGZvbGRlcklkIHx8ICcnKSkgcmV0dXJuIE4uY2hhaW47CiAgICBOLmNoYWluID0gTi5jaGFpbi50aGVuKGFzeW5jICgpID0-IHsKICAgICAgY29uc3QgbGF0ZXN0ID0gYyA_IGMubm90ZSA6IG5vdGU7CiAgICAgIGNvbnN0IHdhcyA9IGxhdGVzdC5mb2xkZXJJZCB8fCAnJzsKICAgICAgbGF0ZXN0LmZvbGRlcklkID0gZm9sZGVySWQ7CiAgICAgIGlmIChjKSBjLmZvbGRlcklkID0gZm9sZGVySWQ7CiAgICAgIGRyYXd",
"Gb2xkZXJzKCk7CiAgICAgIGRyYXdMaXN0KCk7CiAgICAgIGlmIChjKSBkcmF3QmFyKCk7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgbm90ZXNTdG9yZS5tb3ZlKGxhdGVzdCwgZm9sZGVySWQpOwogICAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGZvbGRlcklkID8gYE1vdmVkIHRvICR7Zm9sZGVyTGFiZWwoZm9sZGVySWQpfS5gIDogJ1Rha2VuIG91dCBvZiBpdHMgZm9sZGVyLicpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBsYXRlc3QuZm9sZGVySWQgPSB3YXM7CiAgICAgICAgaWYgKGMpIGMuZm9sZGVySWQgPSB3YXM7CiAgICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgbW92ZSDigJwke2xhdGVzdC50aXRsZX3igJ06ICR7ZXJyLm1lc3NhZ2V9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogICAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgIH0KICAgICAgZHJhd0ZvbGRlcnMoKTsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgaWYgKE4uY3VycmVudCA9PT0gYyAmJiBjKSBkcmF3QmFyKCk7CiAgICB9KTsKICAgIHJldHVybiBOLmNoYWluOwogIH0KCiAgLy8gVGhlIGZvbGRlciBidXR0b24gYWJvdmUgdGhlIG5vdGU6IHdoZXJlIGl0IGlzLCBhbmQgd2hlcmUgaXQgY2FuIGdvLgogIGZ1bmN0aW9uIGNob29zZUZvbGRlcihhbmNob3IpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMpIHJldHVybjs",
"KICAgIG9wZW5NZW51KE4uY3R4LnJvb3QsIGFuY2hvciwgWwogICAgICB7IGhlYWRpbmc6ICdNb3ZlIHRvJyB9LAogICAgICB7IGxhYmVsOiAnTm8gZm9sZGVyJywga2V5OiAnbW92ZS1mb2xkZXI6bm9uZScsIGNoZWNrZWQ6ICFjLmZvbGRlcklkLCBvblNlbGVjdDogKCkgPT4gc2V0Q3VycmVudEZvbGRlcignJykgfSwKICAgICAgLi4uTi5mb2xkZXJzLm1hcChmID0-ICh7CiAgICAgICAgbGFiZWw6IGAkeydcdTIwMDMnLnJlcGVhdChmLmRlcHRoKX0ke2YudGl0bGV9YCwga2V5OiBgbW92ZS1mb2xkZXI6JHtmLmlkfWAsIGNoZWNrZWQ6IGMuZm9sZGVySWQgPT09IGYuaWQsCiAgICAgICAgb25TZWxlY3Q6ICgpID0-IHNldEN1cnJlbnRGb2xkZXIoZi5pZCksCiAgICAgIH0pKSwKICAgIF0sIHsgbGFiZWw6ICdGb2xkZXInIH0pOwogIH0KCiAgZnVuY3Rpb24gc2V0Q3VycmVudEZvbGRlcihpZCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYykgcmV0dXJuOwogICAgLy8gTm90IHNhdmVkIHlldDogdGhlIGZvbGRlciBpcyBzaW1wbHkgd2hlcmUgdGhlIGZpcnN0IHNhdmUgcHV0cyBpdC4KICAgIGlmICghYy5ub3RlKSB7CiAgICAgIGMuZm9sZGVySWQgPSBpZDsKICAgICAgZHJhd0JhcigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBtb3ZlTm90ZShjLm5vdGUsIGlkKTsKICB9CgogIGZ1bmN0aW9uIGRyYXdGb290KCkgewogICAgaWYgKCFlbHMuZm9vdCkgcmV0dXJuOwogICAgZWxzLmZvb3QudGV4dEN",
"vbnRlbnQgPSBOLnRydW5jYXRlZAogICAgICA_ICdTaG93aW5nIHRoZSAxMDAgbW9zdCByZWNlbnQuIFNlYXJjaCB0byBmaW5kIG9sZGVyIG9uZXMuJwogICAgICA6IGBLZXB0IGluIEdtYWlsIHVuZGVyIOKAnCR7bm90ZXNTdG9yZS5sYWJlbE5hbWUoKX3igJ1gOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBlZGl0b3Ig4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG5ld0N1cnJlbnQobm90ZSkgewogICAgcmV0dXJuIHsKICAgICAga2V5OiBub3RlID8gbm90ZS5rZXkgOiBgbmV3OiR7RGF0ZS5ub3coKX1gLAogICAgICBub3RlLCAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gbnVsbCB1bnRpbCBmaXJzdCBzYXZlZAogICAgICB0aXRsZTogbm90ZSAmJiBub3RlLnRpdGxlICE9PSAnVW50aXRsZWQgbm90ZScgPyBub3RlLnRpdGxlIDogJycsCiAgICAgIGRvYzogbm90ZSA_IG51bGwgOiBmbXQuZW1wdHlEb2MoKSwgICAvLyBmb3JtYXR0ZWQgY29udGVudCwgb25jZSBsb2FkZWQKICAgICAgYm9keVN0YXRlOiBub3RlID8gJ2xvYWRpbmcnIDogJ3JlYWR5JywgLy8gbG9hZGluZyB8IHJlYWR5IHwgZXJyb3IKICAgICAgZGlydHk6IGZhbHNlLAogICAgICBzYXZ",
"pbmc6IGZhbHNlLAogICAgICBlcnJvcjogJycsCiAgICAgIHNhdmVkQXQ6IDAsCiAgICAgIC8vIEEgbmV3IG5vdGUgc3RhcnRzIGluIHRoZSBmb2xkZXIgYmVpbmcgbG9va2VkIGF0LgogICAgICBmb2xkZXJJZDogbm90ZSA_IG5vdGUuZm9sZGVySWQgfHwgJycgOiBOLmZvbGRlciwKICAgICAgLy8gVGhlIHZlcnNpb24gdGhlIGVkaXRzIGhlcmUgc3RhcnRlZCBmcm9tLCBmb3IgYSBtZXJnZS4KICAgICAgYmFzZTogbm90ZSA_IG51bGwgOiBmbXQuZW1wdHlEb2MoKSwKICAgICAgYmFzZVRpdGxlOiBub3RlID8gbm90ZS50aXRsZSA6ICcnLAogICAgfTsKICB9CgogIC8vIFRoZSBzY3JhdGNocGFkLCBhcyB0aGUgbm90ZSBiZWluZyBlZGl0ZWQ6IGl0cyBzYXZlZCBtZXNzYWdlLCBvciBudWxsCiAgLy8gd2hlbiB0aGVyZSBpcyBub25lIHlldC4gSXQga2VlcHMgaXRzIG5hbWUgYW5kIHN0YXlzIG91dCBvZiBmb2xkZXJzLgogIC8vIFRoZXJlIGlzIG9uZSBhdCBhIHRpbWU6IHRoZSBuZXdlc3QgbWFkZSBpcyBOLnNjcmF0Y2guCiAgZnVuY3Rpb24gc2NyYXRjaEN1cnJlbnQobm90ZSkgewogICAgTi5zY3JhdGNoID0gT2JqZWN0LmFzc2lnbihuZXdDdXJyZW50KG5vdGUpLCB7CiAgICAgIHNjcmF0Y2g6IHRydWUsIGtleTogU0NSQVRDSF9LRVksIHRpdGxlOiBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUsIGZvbGRlcklkOiAnJywKICAgIH0pOwogICAgcmV0dXJuIE4uc2NyYXRjaDsKICB9CgogIC8vIEJlZm9yZSB0aGUgbGl",
"zdCBpcyBpbiwgbm9ib2R5IGtub3dzIHlldCB3aGV0aGVyIHRoZXJlIGlzIG9uZS4KICBmdW5jdGlvbiBwZW5kaW5nU2NyYXRjaCgpIHsKICAgIHJldHVybiBPYmplY3QuYXNzaWduKHNjcmF0Y2hDdXJyZW50KG51bGwpLCB7IGRvYzogbnVsbCwgYm9keVN0YXRlOiAnbG9hZGluZycgfSk7CiAgfQoKICAvLyBXaGVuZXZlciBubyBvdGhlciBub3RlIGlzIG9wZW46IHRoZSBzY3JhdGNocGFkIC0gYXMgaXQgaXMsIGlmIGl0IGhhcwogIC8vIGJlZW4gcmVhZCBhbHJlYWR5ICh0aGUgY2FsZW5kYXIncyB0aWxlIG1heSBoYXZlIGVkaXRzIGluIGl0KSwgY2F1Z2h0CiAgLy8gdXAgaWYgdGhlcmUgaXMgYSBuZXdlciB2ZXJzaW9uLgogIGZ1bmN0aW9uIHNob3dTY3JhdGNoKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmIChjICYmIGMuc2NyYXRjaCAmJiBjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykgcmV0dXJuOwogICAgY29uc3QgcyA9IE4uc2NyYXRjaDsKICAgIGlmIChzICYmIHMuYm9keVN0YXRlID09PSAncmVhZHknKSB7CiAgICAgIGZsdXNoKCk7CiAgICAgIE4uY3VycmVudCA9IHM7CiAgICAgIE4uZmluZEluZGV4ID0gMDsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgZHJhd0VkaXRvcigpOwogICAgICBhcHBseUhpZ2hsaWdodHMoKTsKICAgICAgc2NyYXRjaFJlYWR5KCk7CiAgICAgIGNhdGNoVXBDdXJyZW50KCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChOLnNjcmF0Y2hOb3RlKSB7IG9wZW5Ob3R",
"lKE4uc2NyYXRjaE5vdGUsIHsgZm9yY2U6IHRydWUgfSk7IHJldHVybjsgfQogICAgZmx1c2goKTsKICAgIE4uY3VycmVudCA9IE4uc2NyYXRjaEtub3duID8gc2NyYXRjaEN1cnJlbnQobnVsbCkgOiBwZW5kaW5nU2NyYXRjaCgpOwogICAgZHJhd0xpc3QoKTsKICAgIGRyYXdFZGl0b3IoKTsKICAgIHNjcmF0Y2hSZWFkeSgpOwogIH0KCiAgLy8gVGhlIGN1cnNvciBnb2VzIGludG8gdGhlIHNjcmF0Y2hwYWQgb25jZSBpdCBjYW4gdGFrZSB0eXBpbmcsIGlmIGl0CiAgLy8gd2FzIGFza2VkIGZvciBiZWZvcmUgdGhlbi4KICBmdW5jdGlvbiBzY3JhdGNoUmVhZHkoKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFOLndhbnRGb2N1cyB8fCAhYyB8fCAhYy5zY3JhdGNoIHx8IGMuYm9keVN0YXRlICE9PSAncmVhZHknKSByZXR1cm47CiAgICBOLndhbnRGb2N1cyA9IGZhbHNlOwogICAgZm9jdXNGaWVsZCgnbm90ZS1ib2R5Jyk7CiAgfQoKICBmdW5jdGlvbiBuZXdOb3RlKCkgewogICAgZmx1c2goKTsKICAgIE4uY3VycmVudCA9IG5ld0N1cnJlbnQobnVsbCk7CiAgICBkcmF3TGlzdCgpOwogICAgZHJhd0VkaXRvcigpOwogICAgZm9jdXNGaWVsZCgnbm90ZS10aXRsZScpOwogIH0KCiAgZnVuY3Rpb24gb3Blbk5vdGUobm90ZSwgeyBmb3JjZSA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKCFmb3JjZSAmJiBOLmN1cnJlbnQgJiYgTi5jdXJyZW50LmtleSA9PT0gbm90ZS5rZXkpIHJldHVybjsKICAgIGlmICh",
"ub3RlLmtleSA9PT0gU0NSQVRDSF9LRVkgJiYgTi5zY3JhdGNoICYmIE4uc2NyYXRjaC5ib2R5U3RhdGUgPT09ICdyZWFkeScgJiYgTi5jdXJyZW50ICE9PSBOLnNjcmF0Y2gpIHsKICAgICAgc2hvd1NjcmF0Y2goKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgZmx1c2goKTsKICAgIGNvbnN0IGMgPSBub3RlLmtleSA9PT0gU0NSQVRDSF9LRVkgPyBzY3JhdGNoQ3VycmVudChub3RlKSA6IG5ld0N1cnJlbnQobm90ZSk7CiAgICBOLmN1cnJlbnQgPSBjOwogICAgTi5maW5kSW5kZXggPSAwOwogICAgZHJhd0xpc3QoKTsKICAgIGRyYXdFZGl0b3IoKTsKICAgIGxvYWRCb2R5KGMpOwogIH0KCiAgLy8gQSBub3RlJ3MgdGV4dCwgcmVhZCBmcm9tIEdtYWlsLiBUaGUgc2NyYXRjaHBhZCdzIGdvZXMgdG8gdGhlCiAgLy8gY2FsZW5kYXIncyB0aWxlIGFzIHdlbGwsIHdoZXRoZXIgb3Igbm90IGl0IGlzIG9wZW4gaGVyZS4KICBmdW5jdGlvbiBsb2FkQm9keShjKSB7CiAgICBjb25zdCB3YW50ZWQgPSAoKSA9PiBOLmN1cnJlbnQgPT09IGMgfHwgTi5zY3JhdGNoID09PSBjOwogICAgbm90ZXNTdG9yZS5ib2R5KGMubm90ZSkudGhlbihkb2MgPT4gewogICAgICBpZiAoIXdhbnRlZCgpKSByZXR1cm47CiAgICAgIGMuZG9jID0gZG9jOwogICAgICBjLmJhc2UgPSBkb2M7CiAgICAgIGMuYm9keVN0YXRlID0gJ3JlYWR5JzsKICAgICAgaWYgKE4uY3VycmVudCA9PT0gYykgewogICAgICAgIGRyYXdFZGl0b3IoKTsKICAgICAgICBhcHB",
"seUhpZ2hsaWdodHMoKTsKICAgICAgICBzY3JhdGNoUmVhZHkoKTsKICAgICAgfQogICAgICBpZiAoTi5zY3JhdGNoID09PSBjKSBkcmF3VGlsZSgpOwogICAgfSwgZXJyID0-IHsKICAgICAgaWYgKCF3YW50ZWQoKSkgcmV0dXJuOwogICAgICBjLmJvZHlTdGF0ZSA9ICdlcnJvcic7CiAgICAgIGMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSBzdGF0ZUVycm9yKGVycik7CiAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMpIGRyYXdFZGl0b3IoKTsKICAgICAgaWYgKE4uc2NyYXRjaCA9PT0gYykgZHJhd1RpbGUoKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZm9jdXNGaWVsZChrZXkpIHsKICAgIGlmIChrZXkgPT09ICdub3RlLWJvZHknICYmIGVscy5lZCkgeyBlbHMuZWQuZm9jdXMoKTsgcmV0dXJuOyB9CiAgICBjb25zdCBlbCA9IGVscy5lZGl0b3IgJiYgZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yKGBbZGF0YS1rZXk9IiR7a2V5fSJdYCk7CiAgICBpZiAoZWwpIGVsLmZvY3VzKCk7CiAgfQoKICAvLyBXaGF0IGEgcGhvbmUgc2hvd3M6IHRoZSBzY3JhdGNocGFkLCB0aGUgbGlzdCwgb3IgYSBub3RlLgogIGZ1bmN0aW9uIHNldFZpZXcoKSB7CiAgICBjb25zdCB2aWV3ID0gTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCA_ICdub3RlJyA6IE4uYnJvd3NpbmcgPyAnbGlzdCcgOiAnaG9tZSc7CiAgICBpZiAoZWxzLndyYXApIGVscy53cmFwLmRhdGF",
"zZXQudmlldyA9IHZpZXc7CiAgICBpZiAodmlldyAhPT0gTi52aWV3KSB7CiAgICAgIE4udmlldyA9IHZpZXc7CiAgICAgIGlmIChOLmN0eCAmJiBOLmN0eC5vblZpZXdDaGFuZ2UpIE4uY3R4Lm9uVmlld0NoYW5nZSh2aWV3KTsKICAgIH0KICB9CgogIC8vIEJhY2sgdG8gdGhlIGxpc3QsIG9uY2Ugd2hhdGV2ZXIgaXMgcGVuZGluZyBpcyBzYXZlZC4gQSBzYXZlIHRoYXQKICAvLyBmYWlsZWQga2VlcHMgdGhlIG5vdGUgb3Blbiwgd2l0aCBpdHMgZXJyb3Igc2hvd2luZywgcmF0aGVyIHRoYW4KICAvLyBsZWF2aW5nIHRoZSBlZGl0cyBiZWhpbmQuCiAgYXN5bmMgZnVuY3Rpb24gY2xvc2VOb3RlKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCBjLnNjcmF0Y2gpIHJldHVybjsKICAgIGF3YWl0IGZsdXNoKCk7CiAgICBpZiAoTi5jdXJyZW50ICE9PSBjKSByZXR1cm47CiAgICBpZiAoYy5kaXJ0eSkgewogICAgICB0b2FzdChOLmN0eC5yb290LCAnTm90IHNhdmVkIHlldCwgc28gdGhlIG5vdGUgc3RheXMgb3Blbi4gVHJ5IGFnYWluIGluIGEgbW9tZW50LicsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgcmV0dXJuOwogICAgfQogICAgc2hvd1NjcmF0Y2goKTsKICB9CgogIC8vIEEgcGhvbmUncyBCYWNrOiBhIG5vdGUgYmFjayB0byB3aGVyZSBpdCB3YXMgb3BlbmVkIGZyb20sIGFuZCB0aGUgbGlzdAogIC8vIGJhY2sgdG8gdGhlIHNjcmF0Y2hwYWQsIHdpdGggdGhlIHNlYXJjaCBhbmQgdGh",
"lIGZvbGRlciBjbGVhcmVkLgogIGFzeW5jIGZ1bmN0aW9uIGJhY2soKSB7CiAgICBpZiAoTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCkgcmV0dXJuIGNsb3NlTm90ZSgpOwogICAgaWYgKCFOLmJyb3dzaW5nKSByZXR1cm47CiAgICBOLmJyb3dzaW5nID0gZmFsc2U7CiAgICBzZXRGb2xkZXJzT3BlbihmYWxzZSk7CiAgICBpZiAoTi5mb2xkZXIpIHsgTi5mb2xkZXIgPSAnJzsgZHJhd0ZvbGRlcnMoKTsgZHJhd0xpc3QoKTsgfQogICAgaWYgKE4ucXVlcnkpIGNsZWFyU2VhcmNoKCk7CiAgICBzZXRWaWV3KCk7CiAgfQoKICAvLyBIb3cgZmFyIGZyb20gdGhlIHNjcmF0Y2hwYWQ6IDAgdGhlcmUsIDEgaW4gdGhlIGxpc3Qgb3IgYSBub3RlIG9wZW5lZAogIC8vIGZyb20gdGhlIHNjcmF0Y2hwYWQsIDIgaW4gYSBub3RlIG9wZW5lZCBmcm9tIHRoZSBsaXN0LgogIGZ1bmN0aW9uIGRlcHRoKCkgewogICAgY29uc3QgaW5Ob3RlID0gISEoTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCk7CiAgICByZXR1cm4gKE4uYnJvd3NpbmcgPyAxIDogMCkgKyAoaW5Ob3RlID8gMSA6IDApOwogIH0KCiAgZnVuY3Rpb24gZHJhd0VkaXRvcigpIHsKICAgIGlmICghZWxzLmVkaXRvcikgcmV0dXJuOwogICAgc2V0VmlldygpOwogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYykgcmV0dXJuOwogICAgZWxzLmVkaXRvci5jbGFzc0xpc3QudG9nZ2xlKCdzY3JhdGNoJywgISFjLnNjcmF0Y2gpOwoKICAgIGVscy5",
"iYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtYmFyJyB9KTsKICAgIGVscy5iYW5uZXJTbG90ID0gaCgnZGl2JywgeyBjbGFzczogJ25lLWJhbm5lci1zbG90JyB9KTsKICAgIGNvbnN0IHRpdGxlID0gYy5zY3JhdGNoID8gaCgnaDInLCB7IGNsYXNzOiAnbmUtdGl0bGUgc2NyYXRjaC10aXRsZScsIGRhdGFzZXQ6IHsga2V5OiAnc2NyYXRjaC10aXRsZScgfSB9LAogICAgICBpY29uKCdlZGl0JywgMjIpLCBoKCdzcGFuJywgeyBjbGFzczogJ3N0LW5hbWUnLCB0ZXh0OiBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUgfSkpIDogaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAnbmUtdGl0bGUnLCB0eXBlOiAndGV4dCcsIHBsYWNlaG9sZGVyOiAnVGl0bGUnLCAnYXJpYS1sYWJlbCc6ICdUaXRsZScsCiAgICAgIHZhbHVlOiBjLnRpdGxlLCBtYXhsZW5ndGg6IFN0cmluZyhub3Rlc0xvZ2ljLk1BWF9USVRMRSksIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS10aXRsZScgfSwKICAgICAgZGlzYWJsZWQ6IGMuYm9keVN0YXRlICE9PSAncmVhZHknLAogICAgICBvbmlucHV0OiBlID0-IGVkaXRlZChjLCB7IHRpdGxlOiBlLnRhcmdldC52YWx1ZSB9KSwKICAgICAgb25rZXlkb3duOiBlID0-IHsKICAgICAgICAvLyBFbnRlciBpbiB0aGUgdGl0bGUgY2FycmllcyBvbiBpbnRvIHRoZSBib2R5LCBhcyBpbiBtb3N0IGVkaXRvcnMuCiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFlLmlzQ29tcG9zaW5nKSB7IGUucHJldmV",
"udERlZmF1bHQoKTsgZm9jdXNGaWVsZCgnbm90ZS1ib2R5Jyk7IH0KICAgICAgfSwKICAgIH0pOwogICAgLy8gQSBmcmVzaCBlZGl0b3IgcGVyIG5vdGU6IGl0cyB1bmRvIGhpc3RvcnkgYmVsb25ncyB0byB0aGF0IG5vdGUuCiAgICBpZiAoZWxzLmVkKSBlbHMuZWQuZGVzdHJveSgpOwogICAgY29uc3QgZWQgPSBucy5ub3RlRWRpdG9yLmNyZWF0ZSh7CiAgICAgIHJvb3Q6IE4uY3R4LnJvb3QsCiAgICAgIG9uQ2hhbmdlOiAoKSA9PiB7CiAgICAgICAgZWRpdGVkKGMsIHsgZG9jOiBlZC5nZXREb2MoKSB9KTsKICAgICAgICBpZiAoYyA9PT0gTi5zY3JhdGNoKSBULnN0YWxlID0gdHJ1ZTsKICAgICAgfSwKICAgIH0pOwogICAgZWxzLmVkID0gZWQ7CiAgICBlbHMuZWRTdGFsZSA9IGZhbHNlOwogICAgZWQuc2V0RG9jKGMuZG9jIHx8IGZtdC5lbXB0eURvYygpKTsKICAgIGVkLnNldEVkaXRhYmxlKGMuYm9keVN0YXRlID09PSAncmVhZHknLAogICAgICBjLmJvZHlTdGF0ZSA9PT0gJ2xvYWRpbmcnID8gJ0xvYWRpbmfigKYnIDogYy5ib2R5U3RhdGUgPT09ICdlcnJvcicgPyAnQ291bGRu4oCZdCBsb2FkIHRoaXMgbm90ZS4nCiAgICAgICAgOiBjLnNjcmF0Y2ggPyBgSm90IGFueXRoaW5nIGRvd24uIEl0IHNhdmVzIGFzIHlvdSB0eXBlLCBhcyBhIG5vdGUgaW4gR21haWwgdW5kZXIg4oCcJHtub3Rlc1N0b3JlLmxhYmVsTmFtZSgpfeKAnS5gIDogJ1dyaXRlIGhlcmXigKYnKTsKCiAgICBlbHMuZmluZFNsb3QgPSBoKCdkaXY",
"nLCB7IGNsYXNzOiAnbmUtZmluZC1zbG90JyB9KTsKICAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKGVscy5iYXIsIGVscy5iYW5uZXJTbG90LCBlbHMuZmluZFNsb3QsIHRpdGxlLCBlZC50b29sYmFyLCBlZC5saW5rYmFyLCBlZC50YWJsZWJhciwgZWQuZWxlbWVudCk7CiAgICBkcmF3QmFyKCk7CiAgICBkcmF3RmluZCgpOwogIH0KCiAgLy8gVGhlIHN0cmlwIGFib3ZlIHRoZSB0ZXh0OiBzdGF0dXMsIGJ1dHRvbnMsIGFuZCB0aGUgYmFubmVyIGZvciBhbgogIC8vIGVtYWlsZWQgbm90ZS4gUmVkcmF3biBvbiBpdHMgb3duIGFmdGVyIGEgc2F2ZSAtIHRoZSBmaXJzdCBzYXZlIG9mIGEKICAvLyBuZXcgbm90ZSBnYWlucyBhbiAiT3BlbiBpbiBHbWFpbCIsIGFuIGVtYWlsZWQgb25lIGxvc2VzIGl0cyBiYW5uZXIgLQogIC8vIHdpdGhvdXQgdG91Y2hpbmcgdGhlIHRleHQgYm94ZXMgdGhlIHVzZXIgbWF5IHN0aWxsIGJlIHR5cGluZyBpbi4KICBmdW5jdGlvbiBkcmF3QmFyKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCAhZWxzLmJhcikgcmV0dXJuOwogICAgY29uc3QgZm9yZWlnbiA9ICEhKGMubm90ZSAmJiAhYy5ub3RlLm93bik7CiAgICBlbHMuc3RhdHVzID0gaCgnc3BhbicsIHsgY2xhc3M6ICduZS1zdGF0dXMnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScgfSk7CiAgICAvLyBUaGUgc2NyYXRjaHBhZCdzIHN0YXR1cyBzaXRzIG9uIGl0cyB0aXRsZSBsaW5lOiB0aGVyZSBpcyBub3R",
"oaW5nCiAgICAvLyBlbHNlIGZvciBhIGJhciB0byBob2xkLgogICAgaWYgKGMuc2NyYXRjaCkgewogICAgICBlbHMuYmFyLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICBlbHMuYmFubmVyU2xvdC5yZXBsYWNlQ2hpbGRyZW4oJycpOwogICAgICBjb25zdCBsaW5lID0gZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yKCcuc2NyYXRjaC10aXRsZScpOwogICAgICBjb25zdCBvbGQgPSBsaW5lICYmIGxpbmUucXVlcnlTZWxlY3RvcignLm5lLXN0YXR1cycpOwogICAgICBpZiAob2xkKSBvbGQucmVwbGFjZVdpdGgoZWxzLnN0YXR1cyk7CiAgICAgIGVsc2UgaWYgKGxpbmUpIGxpbmUuYXBwZW5kKGVscy5zdGF0dXMpOwogICAgICBkcmF3U3RhdHVzKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIC8vIChyZXBsYWNlQ2hpbGRyZW4gd291bGQgc2hvdyBhIG51bGwgYXMgdGhlIHdvcmQgIm51bGwiOiB0aGUgbWlzc2luZwogICAgLy8gYnV0dG9ucyBhcmUgbGVmdCBvdXQgaW5zdGVhZC4pCiAgICBlbHMuYmFyLnJlcGxhY2VDaGlsZHJlbiguLi5bCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuIG5lLWJhY2snLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQmFjayB0byB0aGUgbGlzdCcsIHRpdGxlOiAnQmFjayB0byB0aGUgbGlzdCcsCiAgICAgICAgZGF0YXNldDogeyBrZXk6ICdub3RlLWJhY2snIH0sIG9uY2xpY2s6ICgpID0-IGNsb3NlTm90ZSgpLAogICAgICB9LCBpY29uKCdiYWNrJyk",
"pLAogICAgICBlbHMuc3RhdHVzLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc3BhY2VyJyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnbmUtZm9sZGVyJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWhhc3BvcHVwJzogJ21lbnUnLCAnYXJpYS1leHBhbmRlZCc6ICdmYWxzZScsCiAgICAgICAgdGl0bGU6ICdNb3ZlIHRvIGFub3RoZXIgZm9sZGVyJywgZGF0YXNldDogeyBrZXk6ICdub3RlLWZvbGRlcicgfSwKICAgICAgICBvbmNsaWNrOiBlID0-IGNob29zZUZvbGRlcihlLmN1cnJlbnRUYXJnZXQpLAogICAgICB9LCBpY29uKCdmb2xkZXInLCAxOCksIGgoJ3NwYW4nLCB7IHRleHQ6IGMuZm9sZGVySWQgPyBmb2xkZXJMYWJlbChjLmZvbGRlcklkKSB8fCAnTm8gZm9sZGVyJyA6ICdObyBmb2xkZXInIH0pLCBpY29uKCdjYXJldCcsIDE4KSksCiAgICAgIGMubm90ZSA_IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ09wZW4gaW4gR21haWwnLCB0aXRsZTogJ09wZW4gaW4gR21haWwnLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS1vcGVuJyB9LCBvbmNsaWNrOiAoKSA9PiBvcGVuSW5HbWFpbChjKSwKICAgICAgfSwgaWNvbignb3BlbicpKSA6IG51bGwsCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogZm9yZWlnbiA",
"_ICdUYWtlIG9mZiB0aGUgbm90ZXMgbGlzdCcgOiAnRGVsZXRlIG5vdGUnLAogICAgICAgIHRpdGxlOiBmb3JlaWduID8gJ1Rha2Ugb2ZmIHRoZSBub3RlcyBsaXN0ICh0aGUgZW1haWwgc3RheXMpJyA6ICdEZWxldGUgKG1vdmVzIGl0IHRvIEdtYWls4oCZcyBUcmFzaCknLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS1kZWxldGUnIH0sIG9uY2xpY2s6ICgpID0-IGRlbGV0ZUN1cnJlbnQoKSwKICAgICAgfSwgaWNvbignZGVsZXRlJykpXS5maWx0ZXIoQm9vbGVhbikpOwogICAgZWxzLmJhbm5lclNsb3QucmVwbGFjZUNoaWxkcmVuKGZvcmVpZ24gPyBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbmUtYmFubmVyJywKICAgICAgdGV4dDogYFRoaXMgb25lIGlzIGFuIGVtYWlsIGZpbGVkIHVuZGVyIOKAnCR7bm90ZXNTdG9yZS5sYWJlbE5hbWUoKX3igJ0uIEVkaXRpbmcgaXQgc2F2ZXMgYSBuZXcgbm90ZSBpbiBpdHMgcGxhY2U7IGAgKwogICAgICAgICd0aGUgZW1haWwgaXRzZWxmIHN0YXlzIGluIEdtYWlsLCBqdXN0IG9mZiB0aGlzIGxpc3QuJywKICAgIH0pIDogJycpOwogICAgZHJhd1N0YXR1cygpOwogIH0KCiAgLy8gVGhlIHN0YXR1cyBsaW5lIGFib3ZlIHRoZSBvcGVuIG5vdGUsIGFuZCB0aGUgb25lIGluIHRoZSBjYWxlbmRhcidzCiAgLy8gc2NyYXRjaHBhZCB0aWxlLgogIGZ1bmN0aW9uIGRyYXdTdGF0dXMoKSB7CiAgICBpZiAoZWxzLnN0YXR1cyAmJiBOLmN1cnJlbnQpIHN0YXR1c0ludG8oZWxzLnN",
"0YXR1cywgTi5jdXJyZW50KTsKICAgIGlmIChULnN0YXR1cyAmJiBOLnNjcmF0Y2gpIHN0YXR1c0ludG8oVC5zdGF0dXMsIE4uc2NyYXRjaCk7CiAgfQoKICBmdW5jdGlvbiBzdGF0dXNJbnRvKGVsLCBjKSB7CiAgICBsZXQgdGV4dDsKICAgIGlmIChjLnNhdmluZykgdGV4dCA9ICdTYXZpbmfigKYnOwogICAgZWxzZSBpZiAoYy5lcnJvciAmJiBjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykgdGV4dCA9IGBDb3VsZG7igJl0IHNhdmU6ICR7Yy5lcnJvcn1gOwogICAgZWxzZSBpZiAoYy5kaXJ0eSkgdGV4dCA9ICdVbnNhdmVkIGNoYW5nZXMnOwogICAgZWxzZSBpZiAoYy5zYXZlZEF0KSB0ZXh0ID0gYFNhdmVkICR7dXRpbC5hZ29UZXh0KERhdGUubm93KCkgLSBjLnNhdmVkQXQpfWA7CiAgICBlbHNlIGlmIChjLm5vdGUpIHRleHQgPSBgTGFzdCBzYXZlZCAke3V0aWwucmVsYXRpdmVEYXRlKGMubm90ZS51cGRhdGVkKX1gOwogICAgZWxzZSB0ZXh0ID0gYy5zY3JhdGNoID8gJycgOiAnTmV3IG5vdGUnOwogICAgZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCAhIShjLmVycm9yICYmICFjLnNhdmluZyAmJiBjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykpOwogICAgZWwudGl0bGUgPSBjLm5vdGUgPyB1dGlsLmZ1bGxEYXRlKGMubm90ZS51cGRhdGVkKSA6ICcnOwogIH0KCiAgLy8g4pSA4pSAIFNhdmluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gZWRpdGVkKGMsIGNoYW5nZSkgewogICAgT2JqZWN0LmFzc2lnbihjLCBjaGFuZ2UpOwogICAgYy5kaXJ0eSA9IHRydWU7CiAgICBjLmVycm9yID0gJyc7CiAgICBkcmF3U3RhdHVzKCk7CiAgICBpZiAoY2hhbmdlLmRvYyAmJiBOLnRlcm1zLmxlbmd0aCkgewogICAgICBjbGVhclRpbWVvdXQoZmluZFRpbWVyKTsKICAgICAgZmluZFRpbWVyID0gc2V0VGltZW91dChhcHBseUhpZ2hsaWdodHMsIDMwMCk7CiAgICB9CiAgICBsYXRlclNhdmUoYyk7CiAgICBpZiAoYy5zY3JhdGNoICYmIG5vdGVzU3RvcmUua2VlcERyYWZ0KSB7CiAgICAgIGNsZWFyVGltZW91dChkcmFmdFRpbWVyKTsKICAgICAgZHJhZnRUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ga2VlcERyYWZ0KGMpLCAzMDApOwogICAgfQogIH0KCiAgLy8gQSBzYXZlIGEgbW9tZW50IGFmdGVyIHRoZSB0eXBpbmcgc3RvcHMuIEVhY2ggbm90ZSBrZWVwcyBpdHMgb3duIHRpbWVyOgogIC8vIHRoZSBzY3JhdGNocGFkLCB0eXBlZCBpbnRvIGluIHRoZSBjYWxlbmRhcidzIHRpbGUsIG11c3Qgbm90IHB1dCBvZmYKICAvLyB0aGUgc2F2ZSBvZiB0aGUgbm90ZSBvcGVuIGhlcmUsIG9yIHRoZSBvdGhlciB3YXkgcm9",
"1bmQuCiAgZnVuY3Rpb24gbGF0ZXJTYXZlKGMpIHsKICAgIGNsZWFyVGltZW91dChjLnRpbWVyKTsKICAgIGMudGltZXIgPSBzZXRUaW1lb3V0KCgpID0-IHNhdmUoYyksIEFVVE9TQVZFX01TKTsKICB9CgogIC8vIFNhdmVzIGFyZSBjaGFpbmVkOiBlYWNoIG9uZSByZXRpcmVzIHRoZSB2ZXJzaW9uIHRoZSBwcmV2aW91cyBvbmUKICAvLyB3cm90ZSwgc28gdHdvIGluIGZsaWdodCBhdCBvbmNlIHdvdWxkIGVhY2ggbGVhdmUgYSBzdHJheSBiZWhpbmQuCiAgZnVuY3Rpb24gc2F2ZShjKSB7CiAgICBOLmNoYWluID0gTi5jaGFpbi50aGVuKGFzeW5jICgpID0-IHsKICAgICAgaWYgKCFjLmRpcnR5KSByZXR1cm47CiAgICAgIC8vIEFuIHVudG91Y2hlZCBuZXcgbm90ZSBpcyBub3Qgd29ydGggYSBtZXNzYWdlLgogICAgICBpZiAoIWMubm90ZSAmJiAoYy5zY3JhdGNoIHx8ICFjLnRpdGxlLnRyaW0oKSkgJiYgZm10LmlzRW1wdHkoYy5kb2MpKSB7IGMuZGlydHkgPSBmYWxzZTsgcmV0dXJuOyB9CiAgICAgIGNvbnN0IHNuYXAgPSB7IHRpdGxlOiBjLnRpdGxlLCBkb2M6IGMuZG9jLCBmb2xkZXJJZDogYy5mb2xkZXJJZCwgbm90ZUlkOiBjLnNjcmF0Y2ggPyBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfSUQgOiAnJyB9OwogICAgICAvLyBBIHNjcmF0Y2hwYWQgc3RhcnRlZCBoZXJlIHdoaWxlIGFub3RoZXIgY29tcHV0ZXIgc3RhcnRlZCBvbmUgdG9vLgogICAgICAvLyBXaGVyZSB0aGUgc3RvcmUgY2hlY2tzIGZvciBuZXdlciB2ZXJ",
"zaW9ucyAodGhlIHBob25lIGFwcCksIGl0IHNheXMKICAgICAgLy8gc28gYW5kIHRoZSB0d28gYXJlIG1lcmdlZDsgb3RoZXJ3aXNlIHRoZSBvdGhlcidzIHZlcnNpb24gaXMKICAgICAgLy8gcmV0aXJlZCwgYXMgYW55IG9sZGVyIHZlcnNpb24gaXMuCiAgICAgIGNvbnN0IGJlZm9yZSA9IGMubm90ZSB8fCAoYy5zY3JhdGNoICYmICFub3Rlc1N0b3JlLmNoZWNrc0NvbmZsaWN0cyA_IE4uc2NyYXRjaE5vdGUgOiBudWxsKTsKICAgICAgYy5kaXJ0eSA9IGZhbHNlOwogICAgICBjLnNhdmluZyA9IHRydWU7CiAgICAgIGRyYXdTdGF0dXMoKTsKICAgICAgbGV0IG5ld2VyID0gbnVsbDsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBzYXZlZCA9IGF3YWl0IG5vdGVzU3RvcmUuc2F2ZShob29rcy5nZXRBY2NvdW50KCksIGJlZm9yZSwgc25hcCk7CiAgICAgICAgY29uc3Qgb2xkS2V5ID0gYy5rZXk7CiAgICAgICAgY29uc3Qgd2FzT3VycyA9ICEhKGJlZm9yZSAmJiBiZWZvcmUub3duKTsKICAgICAgICBjLm5vdGUgPSBzYXZlZDsKICAgICAgICBjLmtleSA9IHNhdmVkLmtleTsKICAgICAgICBjLmJhc2UgPSBzbmFwLmRvYzsKICAgICAgICBjLmJhc2VUaXRsZSA9IHNuYXAudGl0bGU7CiAgICAgICAgYy5zYXZlZEF0ID0gRGF0ZS5ub3coKTsKICAgICAgICBjLmNvbmZsaWN0cyA9IDA7CiAgICAgICAgaWYgKGMuc2NyYXRjaCkgeyBOLnNjcmF0Y2hOb3RlID0gc2F2ZWQ7IE4uc2NyYXRjaEtub3duID0gdHJ1ZTsgfQogICAgICA",
"gIGMuZXJyb3IgPSAnJzsKICAgICAgICBOLm5vdGVzID0gW3NhdmVkLCAuLi5OLm5vdGVzLmZpbHRlcihuID0-IG4ua2V5ICE9PSBvbGRLZXkgJiYgbi5rZXkgIT09IHNhdmVkLmtleSldOwogICAgICAgIC8vIEEgZmlyc3Qgc2F2ZSBpcyBvbmUgbW9yZSBub3RlOiB0aGUgY291bnRzIGJ5IHRoZSBmb2xkZXJzIGNoYW5nZS4KICAgICAgICBpZiAoIWJlZm9yZSkgZHJhd0ZvbGRlcnMoKTsKICAgICAgICBpZiAoIXdhc091cnMgJiYgTi5jdXJyZW50ID09PSBjKSBkcmF3QmFyKCk7CiAgICAgICAgaWYgKCFjLmRpcnR5KSBrZWVwRHJhZnQoYyk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGMuZGlydHkgPSB0cnVlOwogICAgICAgIC8vIFNhdmVkIG9uIGFub3RoZXIgZGV2aWNlIHNpbmNlOiBtZXJnZWQsIHRoZW4gc2F2ZWQgYWdhaW4gLSB1bmxlc3MKICAgICAgICAvLyBpdCBrZWVwcyBoYXBwZW5pbmcsIHdoaWNoIG5lZWRzIGEgcGVyc29uIHRvIGxvb2suCiAgICAgICAgaWYgKGVyci5jb2RlID09PSAnY29uZmxpY3QnICYmIGVyci5uZXdlciAmJiAoYy5jb25mbGljdHMgPSAoYy5jb25mbGljdHMgfHwgMCkgKyAxKSA8PSAzKSBuZXdlciA9IGVyci5uZXdlcjsKICAgICAgICBlbHNlIGMuZXJyb3IgPSBlcnIuY29kZSA9PT0gJ2NvbmZsaWN0JyA_ICdJdCBrZWVwcyBjaGFuZ2luZyBvbiBhbm90aGVyIGRldmljZS4gVHJ5IGFnYWluIGluIGEgbW9tZW50LicgOiBlcnIubWVzc2FnZTsKICAgICAgICBpZiAoYXBpLlN",
"UQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHN0YXRlRXJyb3IoZXJyKTsKICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBjLnNhdmluZyA9IGZhbHNlOwogICAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMgfHwgTi5zY3JhdGNoID09PSBjKSBkcmF3U3RhdHVzKCk7CiAgICAgICAgZHJhd0xpc3QoKTsKICAgICAgfQogICAgICBpZiAobmV3ZXIpIGFkb3B0TmV3ZXIoYywgbmV3ZXIpOwogICAgfSk7CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIFdoYXRldmVyIGlzIHBlbmRpbmcsIG5vdyAtIGluIHRoZSBvcGVuIG5vdGUgYW5kIGluIHRoZSBzY3JhdGNocGFkLAogIC8vIHdoaWNoIHRoZSBjYWxlbmRhcidzIHRpbGUgbWF5IGhhdmUgY2hhbmdlZC4gQ2FsbGVkIG9uIEN0cmwrUywgb24KICAvLyBzd2l0Y2hpbmcgbm90ZXMgb3IgdGFicywgYW5kIHdoZW4gdGhlIGJvYXJkIGNsb3Nlcy4KICBmdW5jdGlvbiBmbHVzaCgpIHsKICAgIGZvciAoY29uc3QgYyBvZiBuZXcgU2V0KFtOLmN1cnJlbnQsIE4uc2NyYXRjaF0pKSB7CiAgICAgIGlmICghYykgY29udGludWU7CiAgICAgIGNsZWFyVGltZW91dChjLnRpbWVyKTsKICAgICAgaWYgKGMuZGlydHkpIHNhdmUoYyk7CiAgICB9CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIOKUgOKUgCBUaGUgY2FsZW5kYXIncyBzY3JhdGNocGFkIHRpbGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUaGUgZWlnaHRoIHNwYWNlIGluIHRoZSBjYWxlbmRhcidzIHdlZWsgb2YgdHdvIHJvd3MuIFRoZSBzY3JhdGNocGFkCiAgLy8gaW4gYW4gZWRpdG9yIHdpdGggbm8gdG9vbGJhciAtIGl0cyBrZXlzIGFuZCB0eXBlZCBsaXN0cyBzdGlsbCB3b3JrIC0KICAvLyBlZGl0aW5nIE4uc2NyYXRjaCwgc28gdGhlIHNhdmluZywgbWVyZ2luZyBhbmQgZHJhZnRzIGFyZSB0aGUgb25lcwogIC8vIGFib3ZlLiBUaGUgdGlsZSBhbmQgdGhlIG5vdGVzIGFyZSBuZXZlciBvbiBzY3JlZW4gdG9nZXRoZXIsIHNvIGVhY2gKICAvLyB0YWtlcyB1cCB3aGF0IHRoZSBvdGhlciBjaGFuZ2VkIHdoZW4gaXQgaXMgc2hvd24gKFQuc3RhbGUsCiAgLy8gZWxzLmVkU3RhbGUpLiBCdWlsdCBvbmNlIGFuZCBrZXB0LCBsaWtlIHRoZSBub3RlcycgZWxlbWVudDogdGhlCiAgLy8gY2FsZW5kYXIgbW92ZXMgaXQgaW50byBlYWNoIHdlZWsgaXQgZHJhd3Mgd2l0aG91dCByZWJ1aWxkaW5nIGl0LCBzbwogIC8vIGEgcmVkcmF3IG5ldmVyIHRha2VzIHRoZSB0ZXh0IGJveCBmcm9tIHVuZGVyIHNvbWVvbmUgdHlwaW5nLgoKICBmdW5jdGlvbiBzY3JhdGNoVGlsZSgpIHsKICAgIGlmICghVC5lbCkgewogICAgICBULnN0YXR1cyA9IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmUtc3RhdHVzJyB9KTsKICAgICAgVC5ib2R5ID0gaCgnZGl2JywgeyBjbGFzczogJ3NjcmF0Y2gtdGlsZS1ib2R",
"5JyB9KTsKICAgICAgVC5lbCA9IGgoJ3NlY3Rpb24nLCB7CiAgICAgICAgY2xhc3M6ICdkYXkgc2NyYXRjaC10aWxlJywgcm9sZTogJ2xpc3RpdGVtJywgJ2FyaWEtbGFiZWwnOiBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUsCiAgICAgICAgLy8gQ3RybCtTIHNhdmVzIGhlcmUgdG9vLCByYXRoZXIgdGhhbiBDaHJvbWUncyAiU2F2ZSBwYWdlIGFzIi4KICAgICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgICAgaWYgKChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5KSAmJiAhZS5hbHRLZXkgJiYgZS5rZXkudG9Mb3dlckNhc2UoKSA9PT0gJ3MnKSB7CiAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICAgICAgZmx1c2goKTsKICAgICAgICAgIH0KICAgICAgICB9LAogICAgICB9LAogICAgICBoKCdoZWFkZXInLCB7IGNsYXNzOiAnZGF5LWhlYWQnIH0sCiAgICAgICAgaWNvbignZWRpdCcsIDE2KSwgaCgnc3BhbicsIHsgY2xhc3M6ICdkbmFtZScsIHRleHQ6IG5vdGVzTG9naWMuU0NSQVRDSFBBRF9USVRMRSB9KSwgVC5zdGF0dXMpLAogICAgICBULmJvZHkpOwogICAgfQogICAgc2NyYXRjaFN0YXRlKCk7CiAgICBsb2FkKCk7IC8vIG9ubHkgaWYgdGhlIGxpc3QgaXMgbW9yZSB0aGFuIGEgbWludXRlIG9sZDogbmV3ZXIgdmVyc2lvbnMgZnJvbSBlbHNld2hlcmUKICAgIHJlYWR5U2NyYXRjaCgpOwogICAgaWYgKFQuZm9yICE9PSBOLnNjcmF0Y2ggfHwgVC5zdGFsZSB8fCAhVC5lZCkgZHJhd1RpbGU",
"oKTsKICAgIGRyYXdTdGF0dXMoKTsKICAgIHJldHVybiBULmVsOwogIH0KCiAgZnVuY3Rpb24gZHJhd1RpbGUoKSB7CiAgICBjb25zdCBzID0gTi5zY3JhdGNoOwogICAgaWYgKCFULmVsIHx8ICFzKSByZXR1cm47CiAgICBpZiAoVC5lZCkgVC5lZC5kZXN0cm95KCk7CiAgICBjb25zdCBlZCA9IG5zLm5vdGVFZGl0b3IuY3JlYXRlKHsKICAgICAgcm9vdDogTi5jdHgucm9vdCwKICAgICAgb25DaGFuZ2U6ICgpID0-IHsKICAgICAgICBlZGl0ZWQocywgeyBkb2M6IGVkLmdldERvYygpIH0pOwogICAgICAgIGlmIChzID09PSBOLmN1cnJlbnQpIGVscy5lZFN0YWxlID0gdHJ1ZTsKICAgICAgfSwKICAgIH0pOwogICAgVC5lZCA9IGVkOwogICAgVC5mb3IgPSBzOwogICAgVC5zdGFsZSA9IGZhbHNlOwogICAgZWQuc2V0RG9jKHMuZG9jIHx8IGZtdC5lbXB0eURvYygpKTsKICAgIGVkLnNldEVkaXRhYmxlKHMuYm9keVN0YXRlID09PSAncmVhZHknLAogICAgICBzLmJvZHlTdGF0ZSA9PT0gJ2xvYWRpbmcnID8gJ0xvYWRpbmfigKYnIDogcy5ib2R5U3RhdGUgPT09ICdlcnJvcicgPyBgQ291bGRu4oCZdCBsb2FkIHRoZSBzY3JhdGNocGFkOiAke3MuZXJyb3J9YAogICAgICAgIDogJ0pvdCBhbnl0aGluZyBkb3duLiBJdCBzYXZlcyBhcyB5b3UgdHlwZS4nKTsKICAgIFQuYm9keS5yZXBsYWNlQ2hpbGRyZW4oZWQubGlua2JhciwgZWQudGFibGViYXIsIGVkLmVsZW1lbnQpOwogICAgZHJhd1N0YXR1cygpOwogIH0KCiAgLy8g4pS",
"A4pSAIE90aGVyIGFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIG9wZW5JbkdtYWlsKGMpIHsKICAgIGF3YWl0IGZsdXNoKCk7CiAgICBpZiAoIWMubm90ZSB8fCAhYy5ub3RlLnRocmVhZElkKSByZXR1cm47CiAgICBOLmN0eC5jbG9zZUJvYXJkKCk7CiAgICBob29rcy5vcGVuVGhyZWFkKGMubm90ZS50aHJlYWRJZCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBkZWxldGVDdXJyZW50KCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCBjLnNjcmF0Y2gpIHJldHVybjsKICAgIGNsZWFyVGltZW91dChjLnRpbWVyKTsKICAgIGF3YWl0IE4uY2hhaW47CiAgICBOLmN1cnJlbnQgPSBudWxsOwogICAgc2hvd1NjcmF0Y2goKTsKICAgIGNvbnN0IG5vdGUgPSBjLm5vdGU7CiAgICBpZiAoIW5vdGUpIHsgZHJhd0xpc3QoKTsgcmV0dXJuOyB9IC8vIG5ldmVyIHNhdmVkOiBub3RoaW5nIGluIEdtYWlsCgogICAgY29uc3QgYXQgPSBOLm5vdGVzLmZpbmRJbmRleChuID0-IG4ua2V5ID09PSBub3RlLmtleSk7CiAgICBOLm5vdGVzID0gTi5ub3Rlcy5maWx0ZXIobiA9PiBuLmtleSAhPT0gbm90ZS5rZXkpOwogICAgZHJhd0xpc3QoKTs",
"KICAgIHRyeSB7CiAgICAgIGF3YWl0IG5vdGVzU3RvcmUucmV0aXJlKG5vdGUpOwogICAgICB0b2FzdChOLmN0eC5yb290LCBub3RlLm93bgogICAgICAgID8gJ05vdGUgbW92ZWQgdG8gR21haWzigJlzIFRyYXNoLicKICAgICAgICA6IGBUYWtlbiBvZmYgdGhlIG5vdGVzIGxpc3QuIFRoZSBlbWFpbCBzdGF5cyBpbiBHbWFpbC5gLCB7CiAgICAgICAgYWN0aW9uOiB7IGxhYmVsOiAnVW5kbycsIG9uQ2xpY2s6ICgpID0-IHVuZG9EZWxldGUobm90ZSwgYXQpIH0sCiAgICAgICAgdGltZW91dDogODAwMCwKICAgICAgfSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgTi5ub3Rlcy5zcGxpY2UoTWF0aC5tYXgoMCwgYXQpLCAwLCBub3RlKTsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgZGVsZXRlIOKAnCR7bm90ZS50aXRsZX3igJ06ICR7ZXJyLm1lc3NhZ2V9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogICAgfQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gdW5kb0RlbGV0ZShub3RlLCBhdCkgewogICAgdHJ5IHsKICAgICAgYXdhaXQgbm90ZXNTdG9yZS5yZXN0b3JlKG5vdGUpOwogICAgICBOLm5vdGVzLnNwbGljZShNYXRoLm1heCgwLCBNYXRoLm1pbihhdCwgTi5ub3Rlcy5sZW5ndGgpKSwgMCwgbm90ZSk7CiAgICAgIGRyYXdMaXN0KCk7CiAgICAgIG9wZW5Ob3RlKG5vdGUsIHsgZm9yY2U6IHRydWUgfSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgdG9hc3QoTi5jdHg",
"ucm9vdCwgYENvdWxkbuKAmXQgYnJpbmcgaXQgYmFjazogJHtlcnIubWVzc2FnZX0uIEl0IGlzIHN0aWxsIGluIEdtYWls4oCZcyBUcmFzaC5gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICB9CiAgfQoKICAvLyBDdHJsK1MgKOKMmFMpIHNhdmVzIG5vdyBpbnN0ZWFkIG9mIENocm9tZSdzICJTYXZlIHBhZ2UgYXMiLgogIGZ1bmN0aW9uIGhhbmRsZUtleShlKSB7CiAgICBpZiAoKGUuY3RybEtleSB8fCBlLm1ldGFLZXkpICYmICFlLmFsdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAncycpIHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBmbHVzaCgpOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0KICAgIGlmIChlLmtleSA9PT0gJ0YzJyAmJiBOLnRlcm1zLmxlbmd0aCAmJiBlbHMuZWQpIHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBzdGVwTWF0Y2goZS5zaGlmdEtleSA_IC0xIDogMSk7CiAgICAgIHJldHVybiB0cnVlOwogICAgfQogICAgcmV0dXJuIGZhbHNlOwogIH0KCiAgLy8gQ2FsbGVkIGV2ZXJ5IGZldyBzZWNvbmRzIHdoaWxlIHRoZSBib2FyZCBpcyBvcGVuLCBmb3IgIlNhdmVkIDVzIGFnbyIuCiAgZnVuY3Rpb24gdGljaygpIHsKICAgIGRyYXdTdGF0dXMoKTsKICB9CgogIC8vIFR5cGluZyBnb2VzIHN0cmFpZ2h0IGludG8gdGhlIHNjcmF0Y2hwYWQgLSBvciwgd2l0aCBhbm90aGVyIG5vdGUKICAvLyBvcGVuLCBpbnRvIHRoYXQuCiAgZnVuY3Rpb24gZm9jdXNEZWZhdWx",
"0KCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmIChjICYmIGMuc2NyYXRjaCkgewogICAgICBOLndhbnRGb2N1cyA9IHRydWU7CiAgICAgIHNjcmF0Y2hSZWFkeSgpOwogICAgfSBlbHNlIGlmIChjKSBmb2N1c0ZpZWxkKGMuYm9keVN0YXRlID09PSAncmVhZHknICYmIGMudGl0bGUgPyAnbm90ZS1ib2R5JyA6ICdub3RlLXRpdGxlJyk7CiAgICBlbHNlIGlmIChlbHMuc2VhcmNoKSBlbHMuc2VhcmNoLmZvY3VzKCk7CiAgfQoKICBucy5ub3RlcyA9IHsKICAgIGluaXQsIGVsZW1lbnQsIGxvYWQsIGlzU3RhbGUsIGZsdXNoLCBoYW5kbGVLZXksIHRpY2ssIGZvY3VzRGVmYXVsdCwgY2xvc2VOb3RlLCBiYWNrLCBkZXB0aCwgc2NyYXRjaEZvdW5kLCBzY3JhdGNoVGlsZSwKICAgIC8vIEEgbm90ZSBvdGhlciB0aGFuIHRoZSBzY3JhdGNocGFkLgogICAgaXNPcGVuOiAoKSA9PiAhIShOLmN1cnJlbnQgJiYgIU4uY3VycmVudC5zY3JhdGNoKSwKICAgIGxvYWRlZEF0OiAoKSA9PiBOLmxvYWRlZEF0LAogICAgaXNMb2FkaW5nOiAoKSA9PiAhIU4ubG9hZGluZywKICB9Owp9KSgpOwo\"],[\"src/content/calendar-store.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIENhbGVuZGFyIGRhdGEKLy8KLy8gR29vZ2xlIENhbGVuZGFyJ3MgZXZlbnRzIGFuZCBHb29nbGUgVGFza3MnIHRhc2tzLCByZWFkIHRocm91Z2ggdGhlCi8vIGJhY2tncm91bmQgd29ya2VyIHdpdGggdGhlIGNhbGVuZGFyJ3Mgb3duIHNpZ24taW4gKG9yLCBpbiB0aGUgcGhvbmUKLy8gYXBwLCB0aHJvdWdoIGl0cyBzY3JpcHQpLiBUd28ga2luZHMgb2YgcmVhZDogdGhlIHNvdXJjZXMgLSB3aGljaAovLyBjYWxlbmRhcnMgYW5kIHRhc2sgbGlzdHMgdGhlcmUgYXJlIC0ga2VwdCBmb3IgdGVuIG1pbnV0ZXMsIGFuZCB3aGF0IGlzCi8vIG9uIGluIGEgcmFuZ2Ugb2YgZGF5cywgZm9yIHRoZSBzb3VyY2VzIHRoYXQgYXJlIHN3aXRjaGVkIG9uLgovLwovLyBUcm91YmxlIHdpdGggdGhlIHNpZ24taW4gaXMgdGhyb3duLCBmb3IgdGhlIHZpZXcncyBwYW5lbDsgdHJvdWJsZSB3aXRoCi8vIG9uZSBzZXJ2aWNlIChUYXNrcyBub3QgYWxsb3dlZCwgc2F5KSBjb21lcyBiYWNrIHdpdGggdGhlIHJlc3QsIHNvIGEKLy8gY2FsZW5kYXIgc3RpbGwgc2hvd3Mgd2hlbiB0aGUgdGFza3MgY2Fubm90LgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCBjYWwgPSBucy5jYWxlbmRhckxvZ2ljOwoKICBjb25zdCBTT1VSQ0VTX01TID0gMTAgKiA2MCAqIDEwMDA7CgogIC8vIENvZGVzIHRoYXQgYXJlIGFib3V0IHRoZSBzaWduLWluLCBub3QgYWJvdXQgb25lIGNhbGVuZGFyIG9yIGxpc3QuCiAgY29uc3QgU0lHTl9JTiA9IG5ldyBTZXQoWydub3RfY29uZmlndXJlZCcsICdjYWxlbmRhcl9hdXRoX3JlcXVpcmVkJywgJ2NhbGVuZGFyX21pc21hdGNoJywgJ2V4dGVuc2lvbl9yZWxvYWRlZCddKTsKCiAgY29uc3QgUyA9IHsKICAgIGFjY291bnQ6ICcnLAogICAgc291cmNlczogbnVsbCwgICAvLyBjYWxlbmRhckxvZ2ljLnNvdXJjZXMoKQogICAgZXJyb3JzOiB7fSwgICAgICAvLyBzZXJ2aWNlIOKGkiBlcnJvciwgZnJvbSB0aGUgbGFzdCBzb3VyY2VzIHJlYWQKICAgIGF0OiAwLAogIH07CgogIGZ1bmN0aW9uIHRocm93U2lnbkluKHJlc3VsdHMpIHsKICAgIGNvbnN0IGJhZCA9IHJlc3VsdHMuZmluZChyID0-IHIgJiYgci5lcnJvciAmJiBTSUdOX0lOLmhhcyhyLmVycm9yLmNvZGUpKTsKICAgIGlmIChiYWQpIHRocm93IGJhZC5lcnJvcjsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGx",
"vYWRTb3VyY2VzKGFjY291bnQsIHsgZm9yY2UgPSBmYWxzZSB9ID0ge30pIHsKICAgIGlmIChTLmFjY291bnQgIT09IGFjY291bnQpIHsKICAgICAgUy5hY2NvdW50ID0gYWNjb3VudDsKICAgICAgUy5zb3VyY2VzID0gbnVsbDsKICAgIH0KICAgIGlmICghZm9yY2UgJiYgUy5zb3VyY2VzICYmIERhdGUubm93KCkgLSBTLmF0IDwgU09VUkNFU19NUykgcmV0dXJuIHsgc291cmNlczogUy5zb3VyY2VzLCBlcnJvcnM6IFMuZXJyb3JzIH07CiAgICBjb25zdCBbY2FsZW5kYXJzLCBsaXN0c10gPSBhd2FpdCBucy5hcGkuZ29vZ2xlTWFueShjYWwuc291cmNlUmVxdWVzdHMoKSk7CiAgICB0aHJvd1NpZ25JbihbY2FsZW5kYXJzLCBsaXN0c10pOwogICAgY29uc3QgZXJyb3JzID0ge307CiAgICBpZiAoY2FsZW5kYXJzLmVycm9yKSBlcnJvcnMuY2FsZW5kYXIgPSBjYWxlbmRhcnMuZXJyb3I7CiAgICBpZiAobGlzdHMuZXJyb3IpIGVycm9ycy50YXNrcyA9IGxpc3RzLmVycm9yOwogICAgLy8gQSBzZXJ2aWNlIHRoYXQgZmFpbGVkIHRoaXMgdGltZSBrZWVwcyB0aGUgc291cmNlcyBpdCBoYWQuCiAgICBjb25zdCBrZXB0ID0ga2luZCA9PiAoUy5zb3VyY2VzIHx8IFtdKS5maWx0ZXIocyA9PiBzLmtpbmQgPT09IGtpbmQpOwogICAgY29uc3QgZnJlc2ggPSBjYWwuc291cmNlcyhjYWxlbmRhcnMuZXJyb3IgPyBbXSA6IGNhbGVuZGFycy5pdGVtcywgbGlzdHMuZXJyb3IgPyBbXSA6IGxpc3RzLml0ZW1zKTsKICAgIFMuc291cmNlcyA",
"9IFsKICAgICAgLi4uKGNhbGVuZGFycy5lcnJvciA_IGtlcHQoJ2NhbGVuZGFyJykgOiBmcmVzaC5maWx0ZXIocyA9PiBzLmtpbmQgPT09ICdjYWxlbmRhcicpKSwKICAgICAgLi4uKGxpc3RzLmVycm9yID8ga2VwdCgndGFza3MnKSA6IGZyZXNoLmZpbHRlcihzID0-IHMua2luZCA9PT0gJ3Rhc2tzJykpLAogICAgXTsKICAgIFMuZXJyb3JzID0gZXJyb3JzOwogICAgUy5hdCA9IERhdGUubm93KCk7CiAgICByZXR1cm4geyBzb3VyY2VzOiBTLnNvdXJjZXMsIGVycm9ycyB9OwogIH0KCiAgLy8gV2hhdCBpcyBvbiBmcm9tIHJhbmdlLnN0YXJ0IHVwIHRvIHJhbmdlLmVuZCwgZnJvbSB0aGUgZ2l2ZW4gc291cmNlcy4KICBhc3luYyBmdW5jdGlvbiBsb2FkUmFuZ2UocmFuZ2UsIHNvdXJjZXMpIHsKICAgIGNvbnN0IGNhbGVuZGFycyA9IHNvdXJjZXMuZmlsdGVyKHMgPT4gcy5raW5kID09PSAnY2FsZW5kYXInKTsKICAgIGNvbnN0IGxpc3RzID0gc291cmNlcy5maWx0ZXIocyA9PiBzLmtpbmQgPT09ICd0YXNrcycpOwogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IG5zLmFwaS5nb29nbGVNYW55KGNhbC5yYW5nZVJlcXVlc3RzKHJhbmdlLCBjYWxlbmRhcnMsIGxpc3RzKSk7CiAgICB0aHJvd1NpZ25JbihyZXN1bHRzKTsKCiAgICBjb25zdCBpdGVtcyA9IFtdOwogICAgY29uc3QgZXJyb3JzID0ge307CiAgICBsZXQgaSA9IDA7CiAgICBmb3IgKGNvbnN0IGMgb2YgY2FsZW5kYXJzKSB7CiAgICAgIGNvbnN0IHIgPSByZXN1bHR",
"zW2krK107CiAgICAgIGlmIChyLmVycm9yKSB7IGVycm9ycy5jYWxlbmRhciA9IGVycm9ycy5jYWxlbmRhciB8fCByLmVycm9yOyBjb250aW51ZTsgfQogICAgICBmb3IgKGNvbnN0IGV2IG9mIHIuaXRlbXMgfHwgW10pIHsKICAgICAgICBjb25zdCBpdGVtID0gY2FsLmV2ZW50SXRlbShldiwgYyk7CiAgICAgICAgaWYgKGl0ZW0pIGl0ZW1zLnB1c2goaXRlbSk7CiAgICAgIH0KICAgIH0KICAgIGZvciAoY29uc3QgbCBvZiBsaXN0cykgewogICAgICBmb3IgKGxldCBwYXNzID0gMDsgcGFzcyA8IDI7IHBhc3MrKykgewogICAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2krK107CiAgICAgICAgaWYgKHIuZXJyb3IpIHsgZXJyb3JzLnRhc2tzID0gZXJyb3JzLnRhc2tzIHx8IHIuZXJyb3I7IGNvbnRpbnVlOyB9CiAgICAgICAgZm9yIChjb25zdCB0IG9mIHIuaXRlbXMgfHwgW10pIHsKICAgICAgICAgIGNvbnN0IGl0ZW0gPSBjYWwudGFza0l0ZW0odCwgbCk7CiAgICAgICAgICBpZiAoaXRlbSkgaXRlbXMucHVzaChpdGVtKTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIHJldHVybiB7IGl0ZW1zOiBjYWwudW5pcXVlQnlJZChpdGVtcyksIGVycm9ycyB9OwogIH0KCiAgZnVuY3Rpb24gZm9yZ2V0KCkgewogICAgUy5zb3VyY2VzID0gbnVsbDsKICAgIFMuYXQgPSAwOwogIH0KCiAgbnMuY2FsZW5kYXJTdG9yZSA9IHsgbG9hZFNvdXJjZXMsIGxvYWRSYW5nZSwgZm9yZ2V0LCBTSUdOX0lOIH07Cn0pKCk7Cg\"],[\"src/cont",
"ent/calendar.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBjYWxlbmRhciB2aWV3Ci8vCi8vIFRoZSBib2FyZCdzIHRoaXJkIHRhYjogR29vZ2xlIENhbGVuZGFyJ3MgZXZlbnRzIHdpdGggR29vZ2xlIFRhc2tzJwovLyB0YXNrcyBhbW9uZyB0aGVtLCBkYXkgYnkgZGF5LiBSZWFkLW9ubHkgZm9yIG5vdzogYW4gZXZlbnQgb3BlbnMgaW4KLy8gR29vZ2xlIENhbGVuZGFyLCBhIHRhc2sgaW4gR29vZ2xlIFRhc2tzIChvciwgbWFkZSBmcm9tIGFuIGVtYWlsLCB0aGUKLy8gZW1haWwgaXRzZWxmKS4KLy8KLy8gT24gYSBjb21wdXRlciB0aGVyZSBhcmUgdGhyZWUgdmlld3MgLSBXZWVrIChzZXZlbiBjb2x1bW5zLCBvciB0d28gcm93czoKLy8gTW9uZGF5IHRvIFRodXJzZGF5IGFib3ZlIEZyaWRheSB0byBTdW5kYXkgYW5kIHRoZSBzY3JhdGNocGFkLCBhdCB0aGUKLy8gY2xpY2sgb2YgYSBidXR0b24gYmVzaWRlIHRoZSB2aWV3cyksIE1vbnRoIGFuZCBBZ2VuZGEgKGZvdXIgd2Vla3MgYXMgb25lCi8vIGxpc3QpIC0gYmVzaWRlIGEgc21hbGwgbW9udGgsIHRoZSBjYWxlbmRhcn",
"MgYW5kIHRhc2sgbGlzdHMgdG8gc2hvdyBvcgovLyBoaWRlLCBhbmQgdGhlIHRhc2tzIHdpdGggbm8gZGF0ZS4gTmFycm93LCBhcwovLyBvbiBhIHBob25lLCBpdCBpcyBhbHdheXMgdGhlIHdlZWs6IHR3byBjb2x1bW5zIG9mIGRheXMgd2l0aCB0aGUgbW9udGgKLy8gYXMgdGhlIGVpZ2h0aCB0aWxlLCB0aGUgc291cmNlcyBhcyBhIHJvdyBvZiBjaGlwcyBhYm92ZSwgYW5kIHRoZSB0YXNrcwovLyB3aXRoIG5vIGRhdGUgYmVsb3cuIEEgc3dpcGUgZ29lcyB0byB0aGUgbmV4dCBvciBwcmV2aW91cyB3ZWVrLCBhbmQgYQovLyBidXR0b24gdHVybnMgdGhlIG9yZGVyIG9mIHRoZSBkYXlzIGZyb20gZG93bi10aGVuLWFjcm9zcyB0bwovLyBhY3Jvc3MtdGhlbi1kb3duLgovLwovLyBLZXlzLCBhcyBpbiBHb29nbGUgQ2FsZW5kYXI6IHQgdG9kYXksIGogLyBuIG5leHQsIGsgLyBwIHByZXZpb3VzLAovLyB3IC8gbSAvIGEgZm9yIHRoZSB2aWV3cy4KLy8KLy8gVGhlIGJvYXJkIG93bnMgdGhlIG92ZXJsYXksIHRoZSBoZWFkZXIgYW5kIHRoZSBhY2NvdW50IHBhbmVsczsgdGhpcwovLyBmaWxlIG93bnMgdGhlIGJvZHkgd2hpbGUgdGhlIENhbGVuZGFyIHRhYiBpcyBzaG93aW5nLiBJdHMgZWxlbWVudCBpcwovLyBidWlsdCBvbmNlIGFuZCBrZXB0LCBsaWtlIHRoZSBub3RlcycuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgO",
"KUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgdG9hc3QgfSA9IG5zLnVpOwogIGNvbnN0IHsgY2FsZW5kYXJTdG9yZTogc3RvcmUsIGhvb2tzLCBBUFBfTkFNRSB9ID0gbnM7CiAgY29uc3QgY2FsID0gbnMuY2FsZW5kYXJMb2dpYzsKCiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CiAgY29uc3QgTkFSUk9XX1BYID0gNzIwOwogIC8vIEEgbW9udGggY2VsbCBzaG93cyB0aGlzIG1hbnksIHRoZW4gIisyIG1vcmUiLgogIGNvbnN0IE1PTlRIX1JPV1MgPSA0OwogIGNvbnN0IFNXSVBFX1BYID0gNjA7CgogIGNvbnN0IEMgPSB7CiAgICBjdHg6IG51bGwsICAgICAgICAgIC8vIHsgcm9vdCwgb25TdGF0ZUVycm9yLCBvbkxvYWRlZCwgYmFyQ2hhbmdlZCwgcHJlZnMsIGNvbm5lY3QgfQogICAgdmlldzogJ3dlZWsnLCAgICAgICAvLyB0aGUgdmlldyBjaG9zZW4gb24gYSB3aWRlIHNjcmVlbgogICAgb3JkZXI6ICdkb3duJywgICAgICAvLyBuYXJyb3c6IHRoZSBkYXlzIGRvd24gdGhlbiBhY3Jvc3MsIG9yICdhY3Jvc3MnIHRoZW4gZG93bgogICAgbGF5b3V0Oi",
"AnY29sdW1ucycsICAvLyB3aWRlLCB0aGUgd2Vlazogc2V2ZW4gY29sdW1ucywgb3IgdHdvICdyb3dzJwogICAgYW5jaG9yOiAnJywgICAgICAgICAvLyB0aGUgZGF5IGluIGZvY3VzCiAgICB0b2RheTogJycsCiAgICBuYXJyb3c6IGZhbHNlLAogICAgc291cmNlczogW10sCiAgICBvdmVycmlkZXM6IHt9LCAgICAgIC8vIHNvdXJjZSBpZCDihpIgc2hvd24gb3Igbm90LCB3aGVyZSBmbGlja2VkIGhlcmUKICAgIHByZWZzUmVhZDogZmFsc2UsCiAgICBzdGF0dXM6ICdpZGxlJywgICAgIC8vIGlkbGUgfCBsb2FkaW5nIHwgcmVhZHkgfCBlcnJvciB8IHNpZ25pbiB8IG1pc21hdGNoCiAgICBlcnJvcjogJycsCiAgICBlcnJvcnM6IHt9LCAgICAgICAgIC8vIHNlcnZpY2Ug4oaSIGVycm9yLCBmb3IgdGhlIG5vdGUgYWJvdmUgdGhlIGRheXMKICAgIHNob3duOiBudWxsLCAgICAgICAgLy8geyBrZXksIHJhbmdlLCBpdGVtcywgZmV0Y2hlZDogU2V0LCBlcnJvcnMsIGF0IH0gb24gc2NyZWVuCiAgICBjYWNoZTogbmV3IE1hcCgpLCAgIC8vIHJhbmdlIGtleSDihpIgdGhlIHNhbWUKICAgIGxvYWRpbmc6IG51bGwsCiAgICBsb2FkZWRBdDogMCwKICAgIHNlcTogMCwKICAgIHJlY2hlY2s6IGZhbHNlLCAgICAgLy8gQWxsb3cgd2FzIHByZXNzZWQ6IHJlYWQgZXZlcnl0aGluZyBhZ2FpbiBvbiByZXR1cm4KICB9OwoKICBjb25zdCBlbHMgPSB7fTsKICBsZXQgdGltZUZvcm1hdCA9IG51bGw7CgogIC8vIOKUgOKUgCBTZXR1cCDilI",
"DilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaW5pdChjdHgpIHsKICAgIEMuY3R4ID0gY3R4OwogICAgQy50b2RheSA9IGNhbC5kYXRlS2V5KG5ldyBEYXRlKCkpOwogICAgQy5hbmNob3IgPSBDLnRvZGF5OwogICAgLy8gQmFjayBmcm9tIEdvb2dsZSdzIHBlcm1pc3Npb24gcGFnZSAob3BlbmVkIGJ5IEFsbG93KTogcmVhZCBhZ2Fpbi4KICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdmb2N1cycsICgpID0-IHsgaWYgKEMucmVjaGVjaykgbG9hZCgpOyB9KTsKICB9CgogIGZ1bmN0aW9uIGVsZW1lbnQoKSB7CiAgICBpZiAoZWxzLndyYXApIHJldHVybiBlbHMud3JhcDsKCiAgICBjb25zdCBuYXYgPSAoZGlyLCBsYWJlbCwgbmFtZSkgPT4gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsIHRpdGxlOiBsYWJlbCwgJ2FyaWEtbGFiZWwnOiBsYWJlbCwKICAgICAgZGF0YXNldDogeyBrZXk6IGBjYWwtJHtuYW1lfWAgfSwgb25jbGljazogKCkgPT4gZ28oY2FsLnN0ZXAodmlldygpLCBDLmFuY2hvciwgZGlyKSksCiAgICB9LCBpY29uKG5hbWUsIDIwKSk7CgogICAgZWxzLnRpdGxlID",
"0gaCgnaDInLCB7IGNsYXNzOiAnY2FsLXRpdGxlJywgJ2FyaWEtbGl2ZSc6ICdwb2xpdGUnIH0pOwogICAgZWxzLnZpZXdzID0gaCgnZGl2JywgeyBjbGFzczogJ2NhbC12aWV3cycsIHJvbGU6ICd0YWJsaXN0JywgJ2FyaWEtbGFiZWwnOiAnQ2FsZW5kYXIgdmlldycgfSwKICAgICAgY2FsLlZJRVdTLm1hcCh2ID0-IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ3NlZycsIHR5cGU6ICdidXR0b24nLCByb2xlOiAndGFiJywgZGF0YXNldDogeyBrZXk6IGBjYWwtdmlldzoke3Z9YCwgdmlldzogdiB9LAogICAgICAgIHRleHQ6IHZbMF0udG9VcHBlckNhc2UoKSArIHYuc2xpY2UoMSksIG9uY2xpY2s6ICgpID0-IHNldFZpZXcodiksCiAgICAgIH0pKSk7CiAgICBlbHMuaGVhZCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtaGVhZCcgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2NhbC1uYXYnIH0sCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdidG4gYnRuLW91dGxpbmUgY2FsLXRvZGF5JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdUb2RheScsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLXRvZGF5JyB9LAogICAgICAgICAgdGl0bGU6ICdUb2RheSAoVCknLCBvbmNsaWNrOiAoKSA9PiBnbyhjYWwuZGF0ZUtleShuZXcgRGF0ZSgpKSksCiAgICAgICAgfSksCiAgICAgICAgbmF2KC0xLCAnUHJldmlvdXMnLCAncHJldicpLAogICAgICAgIG5hdigxLCAnTmV4dCcsICduZXh0JyksCiAgICAgIC",
"AgLy8gTmFycm93IG9ubHk6IHdoaWNoIHdheSB0aGUgZGF5cyBydW4gaW4gdGhlIHR3byBjb2x1bW5zLgogICAgICAgIGVscy5vcmRlciA9IGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4gY2FsLW9yZGVyJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLW9yZGVyJyB9LCBvbmNsaWNrOiB0b2dnbGVPcmRlciwKICAgICAgICB9KSksCiAgICAgIGVscy50aXRsZSwKICAgICAgLy8gV2lkZSwgaW4gdGhlIHdlZWs6IHNldmVuIGNvbHVtbnMgb3IgdHdvIHJvd3MuCiAgICAgIGVscy5sYXlvdXQgPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0biBjYWwtbGF5b3V0JywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWxheW91dCcgfSwgb25jbGljazogdG9nZ2xlTGF5b3V0LAogICAgICB9KSwKICAgICAgZWxzLnZpZXdzKTsKCiAgICBlbHMubm90ZSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtbm90ZScsIHJvbGU6ICdzdGF0dXMnIH0pOwogICAgZWxzLm1pbmkgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLW1pbmknIH0pOwogICAgZWxzLnNvdXJjZXMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLXNvdXJjZXMnLCByb2xlOiAnZ3JvdXAnLCAnYXJpYS1sYWJlbCc6ICdDYWxlbmRhcnMgYW5kIHRhc2sgbGlzdHMnIH0pOwogICAgZWxzLnRyYXkgPSBoKCdzZWN0aW9uJywgeyBjbGFzczogJ2NhbC10cmF5JywgJ2FyaWEtbGFiZWwnOiAnVGFza3",
"Mgd2l0aG91dCBhIGRheScgfSk7CiAgICBlbHMubWFpbiA9IGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiAnY2FsLW1haW4nIH0pOwogICAgZWxzLm1haW4uYWRkRXZlbnRMaXN0ZW5lcigndG91Y2hzdGFydCcsIG9uVG91Y2hTdGFydCwgeyBwYXNzaXZlOiB0cnVlIH0pOwogICAgZWxzLm1haW4uYWRkRXZlbnRMaXN0ZW5lcigndG91Y2hlbmQnLCBvblRvdWNoRW5kLCB7IHBhc3NpdmU6IHRydWUgfSk7CgogICAgZWxzLndyYXAgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsJyB9LAogICAgICBlbHMuaGVhZCwKICAgICAgZWxzLm5vdGUsCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtYm9keScgfSwKICAgICAgICBoKCdhc2lkZScsIHsgY2xhc3M6ICdjYWwtc2lkZScgfSwgZWxzLm1pbmksIGVscy5zb3VyY2VzLCBlbHMudHJheSksCiAgICAgICAgZWxzLm1haW4pKTsKCiAgICAvLyBOYXJyb3cgb3Igd2lkZSBpcyBhYm91dCB0aGUgc3BhY2UgdGhlIHZpZXcgaGFzLCBub3QgdGhlIHNjcmVlbi4KICAgIC8vIEdvaW5nIG5hcnJvdyBjYW4gY2hhbmdlIHRoZSB2aWV3ICh0byB0aGUgd2VlayksIGFuZCBzbyB0aGUgZGF5cy4KICAgIG5ldyBSZXNpemVPYnNlcnZlcihlbnRyaWVzID0-IHsKICAgICAgY29uc3QgbmFycm93ID0gZW50cmllc1swXS5jb250ZW50UmVjdC53aWR0aCA8IE5BUlJPV19QWDsKICAgICAgaWYgKG5hcnJvdyA9PT0gQy5uYXJyb3cpIHJldHVybjsKICAgICAgY29uc3QgYmVmb3JlID0gcmFuZ2VLZXkocmFuZ2",
"UoKSk7CiAgICAgIEMubmFycm93ID0gbmFycm93OwogICAgICBpZiAocmFuZ2VLZXkocmFuZ2UoKSkgIT09IGJlZm9yZSAmJiAoQy5zdGF0dXMgPT09ICdyZWFkeScgfHwgQy5zdGF0dXMgPT09ICdsb2FkaW5nJykpIGxvYWQoKTsKICAgICAgZWxzZSBkcmF3KCk7CiAgICB9KS5vYnNlcnZlKGVscy53cmFwKTsKCiAgICBkcmF3KCk7CiAgICByZXR1cm4gZWxzLndyYXA7CiAgfQoKICAvLyBBIG5hcnJvdyB2aWV3IGlzIGFsd2F5cyB0aGUgd2Vlay4KICBmdW5jdGlvbiB2aWV3KCkgewogICAgcmV0dXJuIEMubmFycm93ID8gJ3dlZWsnIDogQy52aWV3OwogIH0KCiAgZnVuY3Rpb24gcmFuZ2UoKSB7CiAgICByZXR1cm4gY2FsLnZpZXdSYW5nZSh2aWV3KCksIEMuYW5jaG9yKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJlYWRQcmVmcygpIHsKICAgIGlmIChDLnByZWZzUmVhZCkgcmV0dXJuOwogICAgQy5wcmVmc1JlYWQgPSB0cnVlOwogICAgdHJ5IHsKICAgICAgY29uc3QgbmFtZXMgPSBbJ2NhbGVuZGFyVmlldycsICdjYWxlbmRhclNvdXJjZXMnLCAnY2FsZW5kYXJPcmRlcicsICdjYWxlbmRhcldlZWtMYXlvdXQnXTsKICAgICAgY29uc3QgW3YsIG8sIG9yZGVyLCBsYXlvdXRdID0gYXdhaXQgUHJvbWlzZS5hbGwobmFtZXMubWFwKG4gPT4gQy5jdHgucHJlZnMuZ2V0KG4pKSk7CiAgICAgIGlmIChjYWwuVklFV1MuaW5jbHVkZXModikpIEMudmlldyA9IHY7CiAgICAgIGlmIChvICYmIHR5cGVvZiBvID09PSAnb2JqZWN0Jy",
"kgQy5vdmVycmlkZXMgPSBvOwogICAgICBpZiAob3JkZXIgPT09ICdhY3Jvc3MnIHx8IG9yZGVyID09PSAnZG93bicpIEMub3JkZXIgPSBvcmRlcjsKICAgICAgaWYgKGxheW91dCA9PT0gJ3Jvd3MnIHx8IGxheW91dCA9PT0gJ2NvbHVtbnMnKSBDLmxheW91dCA9IGxheW91dDsKICAgIH0gY2F0Y2ggeyAvKiBzdG9yYWdlIGdvbmUgKGV4dGVuc2lvbiByZWxvYWRlZCk7IGRlZmF1bHRzIHdpbGwgZG8gKi8gfQogIH0KCiAgZnVuY3Rpb24gc2F2ZVByZWYobmFtZSwgdmFsdWUpIHsKICAgIFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gQy5jdHgucHJlZnMuc2V0KG5hbWUsIHZhbHVlKSkuY2F0Y2goKCkgPT4ge30pOwogIH0KCiAgLy8g4pSA4pSAIExvYWRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IGlzT24gPSBzID0-IGNhbC5pc09uKHMsIEMub3ZlcnJpZGVzKTsKICBjb25zdCBvblNvdXJjZXMgPSAoKSA9PiBDLnNvdXJjZXMuZmlsdGVyKGlzT24pOwogIGNvbnN0IHJhbmdlS2V5ID0gciA9PiBgJHtyLnN0YXJ0fXwke3IuZW5kfWA7CgogIC8vIFdoYXQgaXMgb24gc2NyZWVuIGNvdmVycyB0aGUgcmFuZ2UgYW5kIGV2ZXJ5IHNvdX",
"JjZSB0aGF0IGlzIG9uLgogIGZ1bmN0aW9uIGNvdmVycyhlbnRyeSkgewogICAgcmV0dXJuICEhZW50cnkgJiYgb25Tb3VyY2VzKCkuZXZlcnkocyA9PiBlbnRyeS5mZXRjaGVkLmhhcyhzLmlkKSk7CiAgfQoKICBmdW5jdGlvbiBpc1N0YWxlKCkgewogICAgY29uc3QgZW50cnkgPSBDLmNhY2hlLmdldChyYW5nZUtleShyYW5nZSgpKSk7CiAgICByZXR1cm4gQy5yZWNoZWNrIHx8IEMuc3RhdHVzICE9PSAncmVhZHknIHx8ICFjb3ZlcnMoZW50cnkpIHx8IERhdGUubm93KCkgLSBlbnRyeS5hdCA-IFNUQUxFX01TOwogIH0KCiAgLy8gU2hvd3Mgd2hhdGV2ZXIgaXMgY2FjaGVkIGZvciB0aGUgcmFuZ2UgYXQgb25jZSwgdGhlbiByZWFkcyBHb29nbGUKICAvLyBpZiB0aGF0IGlzIG1pc3NpbmcsIG9sZCBvciBzaG9ydCBvZiBhIHNvdXJjZSB0aGF0IGhhcyBiZWVuIHN3aXRjaGVkCiAgLy8gb24uIEEgbmV3ZXIgbG9hZCAodGhlIG5leHQgd2VlaywgdGFwcGVkIHF1aWNrbHkpIG92ZXJ0YWtlcyB0aGlzIG9uZS4KICBmdW5jdGlvbiBsb2FkKHsgZm9yY2UgPSBmYWxzZSB9ID0ge30pIHsKICAgIGlmICghZWxzLndyYXApIGVsZW1lbnQoKTsKICAgIC8vIFRoZSB2aWV3IGNob3NlbiBsYXN0IHRpbWUgZGVjaWRlcyB3aGljaCBkYXlzIHRvIHJlYWQuCiAgICBpZiAoIUMucHJlZnNSZWFkKSByZXR1cm4gcmVhZFByZWZzKCkudGhlbigoKSA9PiBsb2FkKHsgZm9yY2UgfSkpOwogICAgLy8gUGVybWlzc2lvbiBtYXkgaGF2ZSBiZWVuIG",
"dpdmVuIHNpbmNlOiBub3RoaW5nIGNhY2hlZCBjb3VudHMuCiAgICBpZiAoQy5yZWNoZWNrKSB7CiAgICAgIEMucmVjaGVjayA9IGZhbHNlOwogICAgICBmb3JjZSA9IHRydWU7CiAgICAgIEMuY2FjaGUuY2xlYXIoKTsKICAgICAgc3RvcmUuZm9yZ2V0KCk7CiAgICB9CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IGtleSA9IHJhbmdlS2V5KHIpOwogICAgY29uc3QgY2FjaGVkID0gQy5jYWNoZS5nZXQoa2V5KTsKICAgIGlmIChjYWNoZWQpIHsKICAgICAgQy5zaG93biA9IGNhY2hlZDsKICAgICAgaWYgKEMuc3RhdHVzID09PSAnaWRsZScpIEMuc3RhdHVzID0gJ3JlYWR5JzsKICAgIH0KICAgIGRyYXcoKTsKICAgIGlmICghZm9yY2UgJiYgIWlzU3RhbGUoKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOwoKICAgIGNvbnN0IHNlcSA9ICsrQy5zZXE7CiAgICBpZiAoIUMuc2hvd24gfHwgQy5zaG93bi5rZXkgIT09IGtleSkgQy5zaG93biA9IG51bGw7CiAgICBpZiAoIUMuc2hvd24gJiYgQy5zdGF0dXMgIT09ICdzaWduaW4nICYmIEMuc3RhdHVzICE9PSAnbWlzbWF0Y2gnKSBDLnN0YXR1cyA9ICdsb2FkaW5nJzsKICAgIGRyYXcoKTsKCiAgICBjb25zdCBydW4gPSAoYXN5bmMgKCkgPT4gewogICAgICB0cnkgewogICAgICAgIGNvbnN0IGFjY291bnQgPSBob29rcy5nZXRBY2NvdW50KCk7CiAgICAgICAgY29uc3QgZ290ID0gYXdhaXQgc3RvcmUubG9hZFNvdXJjZXMoYWNjb3VudCwgeyBmb3JjZSB9KTsKIC",
"AgICAgICBDLnNvdXJjZXMgPSBnb3Quc291cmNlczsKICAgICAgICBjb25zdCB3YW50ZWQgPSBvblNvdXJjZXMoKTsKICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzdG9yZS5sb2FkUmFuZ2Uociwgd2FudGVkKTsKICAgICAgICBpZiAoc2VxICE9PSBDLnNlcSkgcmV0dXJuOwogICAgICAgIGNvbnN0IGVudHJ5ID0gewogICAgICAgICAga2V5LCByYW5nZTogciwgaXRlbXM6IHJlc3VsdC5pdGVtcywgYXQ6IERhdGUubm93KCksCiAgICAgICAgICBmZXRjaGVkOiBuZXcgU2V0KHdhbnRlZC5tYXAocyA9PiBzLmlkKSksCiAgICAgICAgICBlcnJvcnM6IE9iamVjdC5hc3NpZ24oe30sIGdvdC5lcnJvcnMsIHJlc3VsdC5lcnJvcnMpLAogICAgICAgIH07CiAgICAgICAgQy5jYWNoZS5zZXQoa2V5LCBlbnRyeSk7CiAgICAgICAgQy5zaG93biA9IGVudHJ5OwogICAgICAgIEMuZXJyb3JzID0gZW50cnkuZXJyb3JzOwogICAgICAgIEMuc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgICBDLmVycm9yID0gJyc7CiAgICAgICAgQy5sb2FkZWRBdCA9IERhdGUubm93KCk7CiAgICAgICAgaWYgKEMuY3R4Lm9uTG9hZGVkKSBDLmN0eC5vbkxvYWRlZCgpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoc2VxICE9PSBDLnNlcSkgcmV0dXJuOwogICAgICAgIGlmIChlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX2F1dGhfcmVxdWlyZWQnKSBDLnN0YXR1cyA9ICdzaWduaW4nOwogICAgICAgIGVsc2UgaWYgKGVyci5jb2RlID09PS",
"AnY2FsZW5kYXJfbWlzbWF0Y2gnKSB7IEMuc3RhdHVzID0gJ21pc21hdGNoJzsgQy5lcnJvciA9IGVyci5tZXNzYWdlOyB9CiAgICAgICAgZWxzZSBpZiAoZXJyLmNvZGUgPT09ICdub3RfY29uZmlndXJlZCcpIHsKICAgICAgICAgIC8vIE5vIGNsaWVudCBJRCBhdCBhbGw6IHRoZSBib2FyZCdzIHNldHVwIHBhbmVsIHNheXMgd2hhdCB0byBkby4KICAgICAgICAgIEMuc3RhdHVzID0gJ2lkbGUnOwogICAgICAgICAgQy5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgICAgfSBlbHNlIGlmIChDLnNob3duKSB7CiAgICAgICAgICBDLnN0YXR1cyA9ICdyZWFkeSc7CiAgICAgICAgICB0b2FzdChDLmN0eC5yb290LCBgQ291bGRu4oCZdCBsb2FkIHRoZSBjYWxlbmRhcjogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIEMuc3RhdHVzID0gJ2Vycm9yJzsKICAgICAgICAgIEMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgICB9CiAgICAgIH0gZmluYWxseSB7CiAgICAgICAgaWYgKEMubG9hZGluZyA9PT0gcnVuKSBDLmxvYWRpbmcgPSBudWxsOwogICAgICAgIGRyYXcoKTsKICAgICAgICBDLmN0eC5iYXJDaGFuZ2VkKCk7CiAgICAgIH0KICAgIH0pKCk7CiAgICBDLmxvYWRpbmcgPSBydW47CiAgICBDLmN0eC5iYXJDaGFuZ2VkKCk7CiAgICByZXR1cm4gcnVuOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gY29ubmVjdChidG4pIHsKICAgIGlmIChidG4pIGJ0bi",
"5kaXNhYmxlZCA9IHRydWU7CiAgICB0cnkgewogICAgICBhd2FpdCBDLmN0eC5jb25uZWN0KCk7CiAgICAgIEMuc3RhdHVzID0gJ2xvYWRpbmcnOwogICAgICBzdG9yZS5mb3JnZXQoKTsKICAgICAgYXdhaXQgbG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGlmIChlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX21pc21hdGNoJykgewogICAgICAgIEMuc3RhdHVzID0gJ21pc21hdGNoJzsKICAgICAgICBDLmVycm9yID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgZHJhdygpOwogICAgICB9IGVsc2UgaWYgKGVyci5jb2RlID09PSAnbm90X2NvbmZpZ3VyZWQnKSB7CiAgICAgICAgQy5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdG9hc3QoQy5jdHgucm9vdCwgYENvdWxkbuKAmXQgY29ubmVjdDogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgIH0KICAgIH0gZmluYWxseSB7CiAgICAgIGlmIChidG4gJiYgYnRuLmlzQ29ubmVjdGVkKSBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgIH0KICB9CgogIC8vIOKUgOKUgCBNb3ZpbmcgYWJvdXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bm",
"N0aW9uIGdvKGFuY2hvcikgewogICAgaWYgKCFjYWwuaXNLZXkoYW5jaG9yKSkgcmV0dXJuOwogICAgQy5hbmNob3IgPSBhbmNob3I7CiAgICBDLnRvZGF5ID0gY2FsLmRhdGVLZXkobmV3IERhdGUoKSk7CiAgICBsb2FkKCk7CiAgfQoKICAvLyBJbiB0d28gY29sdW1ucywgdGhlIGRheXMgcnVuIGRvd24gdGhlbiBhY3Jvc3MgKE1vbmRheSB0byBUaHVyc2RheSBvbgogIC8vIHRoZSBsZWZ0KSwgb3IgYWNyb3NzIHRoZW4gZG93biAoTW9uZGF5IGJlc2lkZSBUdWVzZGF5KS4KICBmdW5jdGlvbiB0b2dnbGVPcmRlcigpIHsKICAgIEMub3JkZXIgPSBDLm9yZGVyID09PSAnYWNyb3NzJyA_ICdkb3duJyA6ICdhY3Jvc3MnOwogICAgc2F2ZVByZWYoJ2NhbGVuZGFyT3JkZXInLCBDLm9yZGVyKTsKICAgIGRyYXcoKTsKICB9CgogIC8vIE9uIGEgY29tcHV0ZXIsIHRoZSB3ZWVrIGFzIHNldmVuIGNvbHVtbnMsIG9yIGFzIHR3byByb3dzOiBNb25kYXkgdG8KICAvLyBUaHVyc2RheSBhYm92ZSwgRnJpZGF5IHRvIFN1bmRheSBiZWxvdy4KICBmdW5jdGlvbiB0b2dnbGVMYXlvdXQoKSB7CiAgICBDLmxheW91dCA9IEMubGF5b3V0ID09PSAncm93cycgPyAnY29sdW1ucycgOiAncm93cyc7CiAgICBzYXZlUHJlZignY2FsZW5kYXJXZWVrTGF5b3V0JywgQy5sYXlvdXQpOwogICAgZHJhdygpOwogIH0KCiAgZnVuY3Rpb24gc2V0Vmlldyh2KSB7CiAgICBpZiAoIWNhbC5WSUVXUy5pbmNsdWRlcyh2KSkgcmV0dXJuOwogICAgQy52aWV3ID",
"0gdjsKICAgIHNhdmVQcmVmKCdjYWxlbmRhclZpZXcnLCB2KTsKICAgIGxvYWQoKTsKICB9CgogIGZ1bmN0aW9uIHRvZ2dsZVNvdXJjZShzKSB7CiAgICBDLm92ZXJyaWRlcyA9IE9iamVjdC5hc3NpZ24oe30sIEMub3ZlcnJpZGVzLCB7IFtzLmlkXTogIWlzT24ocykgfSk7CiAgICBzYXZlUHJlZignY2FsZW5kYXJTb3VyY2VzJywgQy5vdmVycmlkZXMpOwogICAgLy8gU3dpdGNoZWQgb2ZmOiBqdXN0IGhpZGRlbi4gU3dpdGNoZWQgb24gYW5kIG5vdCByZWFkIHlldDogcmVhZCBub3cuCiAgICBpZiAoY292ZXJzKEMuc2hvd24pKSBkcmF3KCk7CiAgICBlbHNlIGxvYWQoKTsKICB9CgogIGxldCB0b3VjaCA9IG51bGw7CiAgZnVuY3Rpb24gb25Ub3VjaFN0YXJ0KGUpIHsKICAgIGlmICghQy5uYXJyb3cgfHwgZS50b3VjaGVzLmxlbmd0aCAhPT0gMSkgeyB0b3VjaCA9IG51bGw7IHJldHVybjsgfQogICAgdG91Y2ggPSB7IHg6IGUudG91Y2hlc1swXS5jbGllbnRYLCB5OiBlLnRvdWNoZXNbMF0uY2xpZW50WSB9OwogIH0KICBmdW5jdGlvbiBvblRvdWNoRW5kKGUpIHsKICAgIGlmICghdG91Y2ggfHwgIWUuY2hhbmdlZFRvdWNoZXMubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBkeCA9IGUuY2hhbmdlZFRvdWNoZXNbMF0uY2xpZW50WCAtIHRvdWNoLng7CiAgICBjb25zdCBkeSA9IGUuY2hhbmdlZFRvdWNoZXNbMF0uY2xpZW50WSAtIHRvdWNoLnk7CiAgICB0b3VjaCA9IG51bGw7CiAgICBpZiAoTWF0aC5hYnMoZHgpID4gU1",
"dJUEVfUFggJiYgTWF0aC5hYnMoZHgpID4gMS41ICogTWF0aC5hYnMoZHkpKSBnbyhjYWwuc3RlcCgnd2VlaycsIEMuYW5jaG9yLCBkeCA8IDAgPyAxIDogLTEpKTsKICB9CgogIC8vIOKUgOKUgCBEcmF3aW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBUaHJvdWdoIHRoZSBzdHlsZSBBUEksIG5vdCBhIHN0eWxlIGF0dHJpYnV0ZTogYSBwYWdlJ3Mgc2VjdXJpdHkKICAvLyBwb2xpY3kgbWF5IHJlZnVzZSBpbmxpbmUgc3R5bGUgYXR0cmlidXRlcywgbmV2ZXIgdGhpcy4KICBmdW5jdGlvbiB0aW50KGVsLCBuYW1lLCB2YWx1ZSkgewogICAgaWYgKHZhbHVlKSBlbC5zdHlsZS5zZXRQcm9wZXJ0eShuYW1lLCB2YWx1ZSk7CiAgICByZXR1cm4gZWw7CiAgfQoKICBmdW5jdGlvbiBkcmF3KCkgewogICAgaWYgKCFlbHMud3JhcCkgcmV0dXJuOwogICAgLy8gUmVkcmF3aW5nIHJlcGxhY2VzIHRoZSBjaGlwcyBhbmQgdGhlIHNtYWxsIG1vbnRoOyB3aGljaGV2ZXIgb2YgdGhlbQogICAgLy8gaGFkIHRoZSBmb2N1cyBnZXRzIGl0IGJhY2ssIG9yIHRoZSBuZXh0IGtleSB3b3VsZCBnbyB0byBHbWFpbC4KICAgIGNvbnN0IGFjdGl2ZSA9IEMuY3R4LnJvb3",
"QuYWN0aXZlRWxlbWVudDsKICAgIGNvbnN0IGtleSA9IGFjdGl2ZSAmJiBlbHMud3JhcC5jb250YWlucyhhY3RpdmUpICYmIGFjdGl2ZS5kYXRhc2V0ID8gYWN0aXZlLmRhdGFzZXQua2V5IHx8ICcnIDogJyc7CiAgICBwYWludCgpOwogICAgaWYgKGtleSAmJiAhZWxzLndyYXAuY29udGFpbnMoQy5jdHgucm9vdC5hY3RpdmVFbGVtZW50KSkgewogICAgICBjb25zdCBhZ2FpbiA9IFsuLi5lbHMud3JhcC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1rZXldJyldLmZpbmQoeCA9PiB4LmRhdGFzZXQua2V5ID09PSBrZXkgJiYgeC5nZXRDbGllbnRSZWN0cygpLmxlbmd0aCk7CiAgICAgIGlmIChhZ2FpbikgYWdhaW4uZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcGFpbnQoKSB7CiAgICBjb25zdCB2ID0gdmlldygpOwogICAgZWxzLndyYXAuZGF0YXNldC5uYXJyb3cgPSBTdHJpbmcoQy5uYXJyb3cpOwogICAgZWxzLndyYXAuZGF0YXNldC52aWV3ID0gdjsKICAgIGVscy53cmFwLmRhdGFzZXQub3JkZXIgPSBDLm9yZGVyOwogICAgY29uc3QgYWNyb3NzID0gQy5vcmRlciA9PT0gJ2Fjcm9zcyc7CiAgICBlbHMub3JkZXIucmVwbGFjZUNoaWxkcmVuKGljb24oYWNyb3NzID8gJ3Jvd3MnIDogJ2NvbHVtbnMnLCAyMCkpOwogICAgZWxzLm9yZGVyLnRpdGxlID0gYWNyb3NzID8gJ0RheXMgcnVuIGFjcm9zcywgdGhlbiBkb3duLiBUYXAgZm9yIGRvd24sIHRoZW4gYWNyb3NzLicgOi",
"AnRGF5cyBydW4gZG93biwgdGhlbiBhY3Jvc3MuIFRhcCBmb3IgYWNyb3NzLCB0aGVuIGRvd24uJzsKICAgIGVscy5vcmRlci5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBlbHMub3JkZXIudGl0bGUpOwogICAgZWxzLndyYXAuZGF0YXNldC5sYXlvdXQgPSBDLmxheW91dDsKICAgIGNvbnN0IHJvd3MgPSBDLmxheW91dCA9PT0gJ3Jvd3MnOwogICAgZWxzLmxheW91dC5yZXBsYWNlQ2hpbGRyZW4oaWNvbihyb3dzID8gJ3Jvd3MnIDogJ2NvbHVtbnMnLCAyMCkpOwogICAgZWxzLmxheW91dC50aXRsZSA9IHJvd3MKICAgICAgPyAnVGhlIHdlZWsgaW4gdHdvIHJvd3MsIE1vbmRheSB0byBUaHVyc2RheSBhYm92ZSBGcmlkYXkgdG8gU3VuZGF5LiBDbGljayBmb3Igc2V2ZW4gY29sdW1ucy4nCiAgICAgIDogJ1RoZSB3ZWVrIGluIHNldmVuIGNvbHVtbnMuIENsaWNrIGZvciB0d28gcm93cywgTW9uZGF5IHRvIFRodXJzZGF5IGFib3ZlIEZyaWRheSB0byBTdW5kYXkuJzsKICAgIGVscy5sYXlvdXQuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgZWxzLmxheW91dC50aXRsZSk7CiAgICBlbHMudGl0bGUudGV4dENvbnRlbnQgPSBjYWwudGl0bGUodiwgQy5hbmNob3IsIEMudG9kYXkpOwogICAgZm9yIChjb25zdCBiIG9mIGVscy52aWV3cy5jaGlsZHJlbikgYi5zZXRBdHRyaWJ1dGUoJ2FyaWEtc2VsZWN0ZWQnLCBTdHJpbmcoYi5kYXRhc2V0LnZpZXcgPT09IHYpKTsKICAgIGNvbnN0IHBhbmVsID0gc3RhdHVzUGFuZWwoKT",
"sKICAgIGVscy53cmFwLmNsYXNzTGlzdC50b2dnbGUoJ2NhbC1wYW5lbCcsICEhcGFuZWwpOwogICAgZHJhd05vdGUoKTsKICAgIGRyYXdNaW5pKCk7CiAgICBkcmF3U291cmNlcygpOwogICAgZHJhd1RyYXkoKTsKICAgIGlmIChwYW5lbCkgZWxzLm1haW4ucmVwbGFjZUNoaWxkcmVuKHBhbmVsKTsKICAgIGVsc2UgaWYgKHYgPT09ICdtb250aCcpIGVscy5tYWluLnJlcGxhY2VDaGlsZHJlbihkcmF3TW9udGgoKSk7CiAgICBlbHNlIGlmICh2ID09PSAnYWdlbmRhJykgZWxzLm1haW4ucmVwbGFjZUNoaWxkcmVuKGRyYXdBZ2VuZGEoKSk7CiAgICBlbHNlIHsKICAgICAgY29uc3Qgd2VlayA9IGRyYXdXZWVrKCk7CiAgICAgIC8vIEFscmVhZHkgc2hvd2luZzogbGVmdCBpbiBwbGFjZSAoc2VlIGRyYXdXZWVrKS4KICAgICAgaWYgKGVscy5tYWluLmZpcnN0Q2hpbGQgIT09IHdlZWsgfHwgZWxzLm1haW4uY2hpbGROb2Rlcy5sZW5ndGggIT09IDEpIGVscy5tYWluLnJlcGxhY2VDaGlsZHJlbih3ZWVrKTsKICAgIH0KICB9CgogIC8vIFdoYXQgaXMgb24sIGZyb20gdGhlIHNvdXJjZXMgdGhhdCBhcmUgb24sIGJ5IGRheS4KICBmdW5jdGlvbiB2aXNpYmxlSXRlbXMoKSB7CiAgICBpZiAoIUMuc2hvd24pIHJldHVybiBbXTsKICAgIGNvbnN0IG9uID0gbmV3IFNldChvblNvdXJjZXMoKS5tYXAocyA9PiBzLmlkKSk7CiAgICByZXR1cm4gQy5zaG93bi5pdGVtcy5maWx0ZXIoeCA9PiBvbi5oYXMoeC5zb3VyY2UpKTsKICB9CgogIG",
"Z1bmN0aW9uIHN0YXR1c1BhbmVsKCkgewogICAgc3dpdGNoIChDLnN0YXR1cykgewogICAgICBjYXNlICdzaWduaW4nOgogICAgICAgIHJldHVybiBwYW5lbCgnY2FsZW5kYXInLCAnQ29ubmVjdCBHb29nbGUgQ2FsZW5kYXInLAogICAgICAgICAgYFNlZSB5b3VyIEdvb2dsZSBDYWxlbmRhciBhbmQgR29vZ2xlIFRhc2tzIGhlcmUsIGJlc2lkZSB0aGUgYm9hcmQgYW5kIHRoZSBub3Rlcy4gJHtBUFBfTkFNRX0gb25seSByZWFkcyB0aGVtLiBHb29nbGUgd2lsbCBhc2sgeW91IHRvIGFsbG93IGl0LmAsCiAgICAgICAgICBDLmN0eC5jb25uZWN0ID8gW2J1dHRvbignQ29ubmVjdCBHb29nbGUgQ2FsZW5kYXInLCAncHJpbWFyeScsIGNvbm5lY3QpXSA6IFtdKTsKICAgICAgY2FzZSAnbWlzbWF0Y2gnOgogICAgICAgIHJldHVybiBwYW5lbCgnY2FsZW5kYXInLCAnVGhhdCB3YXMgYSBkaWZmZXJlbnQgYWNjb3VudCcsIGAke0MuZXJyb3J9IENvbm5lY3QgYWdhaW4gYW5kIGNob29zZSAke2hvb2tzLmdldEFjY291bnQoKX0uYCwKICAgICAgICAgIEMuY3R4LmNvbm5lY3QgPyBbYnV0dG9uKCdDb25uZWN0IGFnYWluJywgJ3ByaW1hcnknLCBjb25uZWN0KV0gOiBbXSk7CiAgICAgIGNhc2UgJ2Vycm9yJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ3JlZnJlc2gnLCAnQ291bGRu4oCZdCBsb2FkIHRoZSBjYWxlbmRhcicsIEMuZXJyb3IsCiAgICAgICAgICBbYnV0dG9uKCdUcnkgYWdhaW4nLCAncHJpbWFyeScsICgpID0-IGxvYWQoey",
"Bmb3JjZTogdHJ1ZSB9KSldKTsKICAgICAgZGVmYXVsdDoKICAgICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHBhbmVsKGljb25OYW1lLCB0aXRsZSwgdGV4dCwgYWN0aW9ucykgewogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdwYW5lbCcsIHJvbGU6ICdyZWdpb24nLCAnYXJpYS1sYWJlbCc6IHRpdGxlIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncGFuZWwtaWNvbicgfSwgaWNvbihpY29uTmFtZSwgMjgpKSwKICAgICAgaCgnaDInLCB7IHRleHQ6IHRpdGxlIH0pLAogICAgICBoKCdwJywge30sIGxpbmtlZCh0ZXh0KSksCiAgICAgIGFjdGlvbnMubGVuZ3RoID8gaCgnZGl2JywgeyBjbGFzczogJ2FjdGlvbnMnIH0sIGFjdGlvbnMpIDogbnVsbCk7CiAgfQoKICBmdW5jdGlvbiBidXR0b24obGFiZWwsIGtpbmQsIG9uQ2xpY2spIHsKICAgIHJldHVybiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiBbJ2J0bicsIGBidG4tJHtraW5kfWBdLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogbGFiZWwsCiAgICAgIG9uY2xpY2s6IGUgPT4gb25DbGljayhlLmN1cnJlbnRUYXJnZXQpLAogICAgfSk7CiAgfQoKICAvLyBHb29nbGUncyBtZXNzYWdlcyBjYXJyeSB0aGUgbGluayB0aGF0IGZpeGVzIHRoZW0gKCJlbmFibGUgaXQgYnkKICAvLyB2aXNpdGluZyBodHRwczovL2NvbnNvbGXigKYiKTogbWFrZSBpdCBvbmUuCiAgZnVuY3Rpb24gbGlua2VkKHRleHQpIHsKICAgIGNvbnN0IG91dCA9IF",
"tdOwogICAgbGV0IGxhc3QgPSAwOwogICAgY29uc3QgcmUgPSAvaHR0cHM6XC9cL1teXHM8PiJdK1teXHM8PiIuLCldL2c7CiAgICBsZXQgbTsKICAgIHdoaWxlICgobSA9IHJlLmV4ZWMoU3RyaW5nKHRleHQpKSkpIHsKICAgICAgb3V0LnB1c2godGV4dC5zbGljZShsYXN0LCBtLmluZGV4KSwgaCgnYScsIHsgaHJlZjogbVswXSwgdGFyZ2V0OiAnX2JsYW5rJywgcmVsOiAnbm9vcGVuZXIgbm9yZWZlcnJlcicsIHRleHQ6IG1bMF0gfSkpOwogICAgICBsYXN0ID0gbS5pbmRleCArIG1bMF0ubGVuZ3RoOwogICAgfQogICAgb3V0LnB1c2goU3RyaW5nKHRleHQpLnNsaWNlKGxhc3QpKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBBIGxpbmUgYWJvdmUgdGhlIGRheXMgZm9yIGEgc2VydmljZSB0aGF0IGNvdWxkIG5vdCBiZSByZWFkLiBOb3QKICAvLyBhbGxvd2VkIGlzIG9uZSBsaW5lIGZvciBib3RoLCB3aXRoIHRoZSB3YXkgdG8gYWxsb3cgaXQ6IGluIENocm9tZSwKICAvLyBjb25uZWN0aW5nIGFnYWluOyBpbiB0aGUgcGhvbmUgYXBwLCBHb29nbGUncyBwYWdlIGZvciB0aGUgc2NyaXB0LgogIGZ1bmN0aW9uIGRyYXdOb3RlKCkgewogICAgY29uc3QgbGluZXMgPSBbXTsKICAgIGlmICghc3RhdHVzUGFuZWwoKSkgewogICAgICBjb25zdCBuYW1lID0gc2VydmljZSA9PiAoc2VydmljZSA9PT0gJ3Rhc2tzJyA_ICdHb29nbGUgVGFza3MnIDogJ0dvb2dsZSBDYWxlbmRhcicpOwogICAgICBjb25zdCBlcnJvcnMgPSBPYm",
"plY3QuZW50cmllcyhDLmVycm9ycyB8fCB7fSk7CiAgICAgIGNvbnN0IGRlbmllZCA9IGVycm9ycy5maWx0ZXIoKFssIGVycl0pID0-IGVyci5jb2RlID09PSAnY2FsZW5kYXJfc2NvcGUnKTsKICAgICAgaWYgKGRlbmllZC5sZW5ndGgpIHsKICAgICAgICBjb25zdCB1cmwgPSAoZGVuaWVkLmZpbmQoKFssIGVycl0pID0-IGVyci5hbGxvd1VybCkgfHwgW10pWzFdOwogICAgICAgIGNvbnN0IGZpeCA9IEMuY3R4LmNvbm5lY3QgPyBidXR0b24oJ0Nvbm5lY3QgYWdhaW4nLCAndGV4dCcsIGNvbm5lY3QpCiAgICAgICAgICA6IHVybCA_IGgoJ2EnLCB7CiAgICAgICAgICAgIGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgaHJlZjogdXJsLmFsbG93VXJsLCB0YXJnZXQ6ICdfYmxhbmsnLCByZWw6ICdub29wZW5lciBub3JlZmVycmVyJywgdGV4dDogJ0FsbG93JywKICAgICAgICAgICAgZGF0YXNldDogeyBrZXk6ICdjYWwtYWxsb3cnIH0sIG9uY2xpY2s6ICgpID0-IHsgQy5yZWNoZWNrID0gdHJ1ZTsgfSwKICAgICAgICAgIH0pCiAgICAgICAgICA6IGgoJ3NwYW4nLCB7IHRleHQ6ICcgSW4gdGhlIHNjcmlwdCBlZGl0b3IsIHJ1biBhbGxvd0NhbGVuZGFyIG9uY2UuJyB9KTsKICAgICAgICBsaW5lcy5wdXNoKGgoJ3AnLCB7fSwKICAgICAgICAgIGgoJ3N0cm9uZycsIHsgdGV4dDogZGVuaWVkLm1hcCgoW3NlcnZpY2VdKSA9PiBuYW1lKHNlcnZpY2UpKS5qb2luKCcgYW5kICcpIH0pLAogICAgICAgICAgYCAke2RlbmllZC5sZW5ndG",
"ggPiAxID8gJ25lZWQnIDogJ25lZWRzJ30geW91ciBwZXJtaXNzaW9uLiBgLCBmaXgpKTsKICAgICAgfQogICAgICBmb3IgKGNvbnN0IFtzZXJ2aWNlLCBlcnJdIG9mIGVycm9ycykgewogICAgICAgIGlmIChlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX3Njb3BlJykgY29udGludWU7CiAgICAgICAgbGluZXMucHVzaChoKCdwJywge30sIGgoJ3N0cm9uZycsIHsgdGV4dDogYCR7bmFtZShzZXJ2aWNlKX06IGAgfSksIGxpbmtlZChlcnIubWVzc2FnZSB8fCBTdHJpbmcoZXJyKSkpKTsKICAgICAgfQogICAgfQogICAgZWxzLm5vdGUucmVwbGFjZUNoaWxkcmVuKC4uLmxpbmVzKTsKICAgIGVscy5ub3RlLmhpZGRlbiA9ICFsaW5lcy5sZW5ndGg7CiAgfQoKICBmdW5jdGlvbiBkcmF3U291cmNlcygpIHsKICAgIGNvbnN0IGxpc3QgPSBDLnNvdXJjZXM7CiAgICBlbHMuc291cmNlcy5oaWRkZW4gPSAhbGlzdC5sZW5ndGggfHwgISFzdGF0dXNQYW5lbCgpOwogICAgZWxzLnNvdXJjZXMucmVwbGFjZUNoaWxkcmVuKC4uLmxpc3QubWFwKHMgPT4gdGludChoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiBbJ3NyYycsIGBzcmMtJHtzLmtpbmR9YF0sIHR5cGU6ICdidXR0b24nLCAnYXJpYS1wcmVzc2VkJzogU3RyaW5nKGlzT24ocykpLAogICAgICB0aXRsZTogYCR7aXNPbihzKSA_ICdIaWRlJyA6ICdTaG93J30gJHtzLm5hbWV9YCwgZGF0YXNldDogeyBrZXk6IGBjYWwtc3JjOiR7cy5pZH1gIH0sCiAgICAgIG9uY2xpY2s6ICgpID0-IH",
"RvZ2dsZVNvdXJjZShzKSwKICAgIH0sIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3dhdGNoJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0pLCBoKCdzcGFuJywgeyBjbGFzczogJ3NyYy1uYW1lJywgdGV4dDogcy5uYW1lIH0pKSwgJy0tc3JjJywgcy5jb2xvdXIpKSk7CiAgfQoKICAvLyBPdmVyZHVlIHRhc2tzIGFscmVhZHkgb24gYSBkYXkgb24gc2NyZWVuIGFyZSBub3QgbGlzdGVkIHR3aWNlLgogIGZ1bmN0aW9uIGRyYXdUcmF5KCkgewogICAgY29uc3QgcGFuZWxVcCA9ICEhc3RhdHVzUGFuZWwoKTsKICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgY29uc3QgdCA9IGNhbC50cmF5KHZpc2libGVJdGVtcygpLCBDLnRvZGF5KTsKICAgIHQub3ZlcmR1ZSA9IHQub3ZlcmR1ZS5maWx0ZXIoeCA9PiB4LmR1ZSA8IHIuc3RhcnQgfHwgeC5kdWUgPj0gci5lbmQpOwogICAgY29uc3QgZ3JvdXAgPSAobGFiZWwsIGxpc3QpID0-IChsaXN0Lmxlbmd0aCA_IFsKICAgICAgaCgnaDMnLCB7fSwgbGFiZWwsIGgoJ3NwYW4nLCB7IGNsYXNzOiAnY291bnQnLCB0ZXh0OiBgIMK3ICR7bGlzdC5sZW5ndGh9YCB9KSksCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtaXRlbXMnIH0sIGxpc3QubWFwKHggPT4gaXRlbUVsKHsgaXRlbTogeCwgY29udDogZmFsc2UgfSwgeyBkdWU6IGxhYmVsID09PSAnT3ZlcmR1ZScgfSkpKSwKICAgIF0gOiBbXSk7CiAgICBjb25zdCBraWRzID0gWy4uLmdyb3VwKCdPdmVyZHVlJywgdC5vdmVyZHVlKSwgLi",
"4uZ3JvdXAoJ05vIGRhdGUnLCB0LnVuZGF0ZWQpXTsKICAgIGVscy50cmF5LnJlcGxhY2VDaGlsZHJlbiguLi5raWRzKTsKICAgIGVscy50cmF5LmhpZGRlbiA9IHBhbmVsVXAgfHwgIWtpZHMubGVuZ3RoOwogIH0KCiAgZnVuY3Rpb24gZHJhd01pbmkoKSB7CiAgICBlbHMubWluaS5yZXBsYWNlQ2hpbGRyZW4obWluaU1vbnRoKCkpOwogIH0KCiAgLy8gVGhlIHNtYWxsIG1vbnRoOiB0aGUgbW9udGggaW4gZm9jdXMsIHRoZSBkYXlzIG9uIHNjcmVlbiBtYXJrZWQ7IGEKICAvLyB0YXAgb24gYSBkYXkgZ29lcyB0aGVyZS4KICBmdW5jdGlvbiBtaW5pTW9udGgoKSB7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IG0gPSBjYWwubW9udGhOYW1lKEMuYW5jaG9yKTsKICAgIGNvbnN0IHJvd3MgPSBjYWwubW9udGhXZWVrcyhDLmFuY2hvcik7CiAgICBjb25zdCBtb250aCA9IEMuYW5jaG9yLnNsaWNlKDAsIDcpOwogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdtaW5pJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbWluaS1oZWFkJywgdGV4dDogYCR7bS5sb25nfSR7bS55ZWFyICE9PSBOdW1iZXIoQy50b2RheS5zbGljZSgwLCA0KSkgPyBgICR7bS55ZWFyfWAgOiAnJ31gIH0pLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbWluaS1ncmlkJywgcm9sZTogJ2dyaWQnLCAnYXJpYS1sYWJlbCc6IGAke20ubG9uZ30gJHttLnllYXJ9YCB9LAogICAgICAgIGNhbC5EQVlfTkFNRVMubWFwKGQgPT4gaCgnc3",
"BhbicsIHsgY2xhc3M6ICdtaW5pLWRvdycsIHRleHQ6IGRbMF0sICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KSksCiAgICAgICAgcm93cy5mbGF0KCkubWFwKGsgPT4gaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6IFsnbWluaS1kYXknLCBrLnNsaWNlKDAsIDcpICE9PSBtb250aCAmJiAnb3RoZXInLCBrID09PSBDLnRvZGF5ICYmICd0b2RheScsCiAgICAgICAgICAgIGsgPj0gci5zdGFydCAmJiBrIDwgci5lbmQgJiYgJ3Nob3duJ10sCiAgICAgICAgICB0eXBlOiAnYnV0dG9uJywgdGV4dDogU3RyaW5nKE51bWJlcihrLnNsaWNlKDgpKSksICdhcmlhLWxhYmVsJzogbG9uZ0RhdGUoayksCiAgICAgICAgICBkYXRhc2V0OiB7IGtleTogYGNhbC1taW5pOiR7a31gIH0sIG9uY2xpY2s6ICgpID0-IGdvKGspLAogICAgICAgIH0pKSkpOwogIH0KCiAgZnVuY3Rpb24gbG9uZ0RhdGUoaykgewogICAgY29uc3QgbSA9IGNhbC5tb250aE5hbWUoayk7CiAgICByZXR1cm4gYCR7Y2FsLmRheU5hbWUoayl9ICR7TnVtYmVyKGsuc2xpY2UoOCkpfSAke20ubG9uZ30gJHttLnllYXJ9YDsKICB9CgogIGZ1bmN0aW9uIGRheUhlYWQoaykgewogICAgcmV0dXJuIGgoJ2hlYWRlcicsIHsgY2xhc3M6ICdkYXktaGVhZCcgfSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkbmFtZScsIHRleHQ6IGNhbC5kYXlOYW1lKGspIH0pLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RudW0nLCB0ZXh0OiBTdHJpbmcoTnVtYmVyKGsuc2xpY2",
"UoOCkpKSB9KSwKICAgICAgayA9PT0gQy50b2RheSA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnYmFkZ2UnLCB0ZXh0OiAndG9kYXknIH0pIDogbnVsbCk7CiAgfQoKICBmdW5jdGlvbiBkYXlDbGFzc2VzKGssIGJhc2UpIHsKICAgIGNvbnN0IHdkID0gY2FsLndlZWtkYXkoayk7CiAgICByZXR1cm4gW2Jhc2UsIGsgPT09IEMudG9kYXkgJiYgJ3RvZGF5Jywgd2QgPj0gNSAmJiAnd2Vla2VuZCcsIHdkID09PSA2ICYmICdzdW5kYXknLCBrIDwgQy50b2RheSAmJiAncGFzdCddOwogIH0KCiAgLy8gVGhlIHdlZWsgaXMgb25lIGVsZW1lbnQsIGtlcHQ6IGl0cyBkYXlzIGFyZSBkcmF3biBhZnJlc2ggZWFjaCB0aW1lLAogIC8vIGJ1dCB0aGUgc2NyYXRjaHBhZCB0aWxlIGluIHRoZSB0d28gcm93cycgZWlnaHRoIHNwYWNlIGlzIG9ubHkgZXZlcgogIC8vIG1vdmVkIGluIG9yIG91dCwgbmV2ZXIgdGFrZW4gb3V0IGFuZCBwdXQgYmFjayAtIHRoYXQgd291bGQgdGFrZSB0aGUKICAvLyBjdXJzb3Igb3V0IG9mIGl0IHdoZW5ldmVyIHRoZSB3ZWVrIHdhcyByZWRyYXduIG1pZC1zZW50ZW5jZS4KICBmdW5jdGlvbiBkcmF3V2VlaygpIHsKICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgY29uc3Qga2V5cyA9IGNhbC5kYXlzKHIuc3RhcnQsIHIuZW5kKTsKICAgIGNvbnN0IGJ5RGF5ID0gY2FsLmJ5RGF5KHZpc2libGVJdGVtcygpLCBrZXlzKTsKICAgIGNvbnN0IGxvYWRpbmcgPSBDLnN0YXR1cyA9PT0gJ2xvYWRpbmcnICYmICFDLnNob3",
"duOwogICAgY29uc3QgdGlsZSA9ICFDLm5hcnJvdyAmJiBDLmxheW91dCA9PT0gJ3Jvd3MnICYmIG5zLm5vdGVzID8gbnMubm90ZXMuc2NyYXRjaFRpbGUoKSA6IG51bGw7CiAgICBjb25zdCB3ZWVrID0gZWxzLndlZWsgfHwgKGVscy53ZWVrID0gaCgnZGl2JywgeyByb2xlOiAnbGlzdCcgfSkpOwogICAgd2Vlay5jbGFzc05hbWUgPSBsb2FkaW5nID8gJ2NhbC13ZWVrIGxvYWRpbmcnIDogJ2NhbC13ZWVrJzsKICAgIGZvciAoY29uc3Qga2lkIG9mIFsuLi53ZWVrLmNoaWxkcmVuXSkgaWYgKGtpZCAhPT0gdGlsZSkga2lkLnJlbW92ZSgpOwogICAgY29uc3QgZGF5cyA9IGtleXMubWFwKGsgPT4gaCgnc2VjdGlvbicsIHsgY2xhc3M6IGRheUNsYXNzZXMoaywgJ2RheScpLCByb2xlOiAnbGlzdGl0ZW0nLCAnYXJpYS1sYWJlbCc6IGxvbmdEYXRlKGspLCBkYXRhc2V0OiB7IGRheTogayB9IH0sCiAgICAgIGRheUhlYWQoayksCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtaXRlbXMnIH0sIGJ5RGF5LmdldChrKS5tYXAoZSA9PiBpdGVtRWwoZSkpKSkpOwogICAgLy8gVGhlIGVpZ2h0aCB0aWxlLCBpbiB0aGUgdHdvIGNvbHVtbnMgb2YgYSBuYXJyb3cgc2NyZWVuLgogICAgZGF5cy5wdXNoKGgoJ2RpdicsIHsgY2xhc3M6ICdkYXkgbWluaS10aWxlJywgJ2FyaWEtaGlkZGVuJzogQy5uYXJyb3cgPyBudWxsIDogJ3RydWUnIH0sIG1pbmlNb250aCgpKSk7CiAgICBpZiAodGlsZSAmJiB0aWxlLnBhcmVudE5vZGUgPT09IH",
"dlZWspIGRheXMuZm9yRWFjaChkID0-IHdlZWsuaW5zZXJ0QmVmb3JlKGQsIHRpbGUpKTsKICAgIGVsc2Ugd2Vlay5hcHBlbmQoLi4uZGF5cywgLi4uKHRpbGUgPyBbdGlsZV0gOiBbXSkpOwogICAgcmV0dXJuIHdlZWs7CiAgfQoKICBmdW5jdGlvbiBkcmF3TW9udGgoKSB7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IGtleXMgPSBjYWwuZGF5cyhyLnN0YXJ0LCByLmVuZCk7CiAgICBjb25zdCBieURheSA9IGNhbC5ieURheSh2aXNpYmxlSXRlbXMoKSwga2V5cyk7CiAgICBjb25zdCBtb250aCA9IEMuYW5jaG9yLnNsaWNlKDAsIDcpOwogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtbW9udGgnIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdtb250aC1kb3dzJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0sIGNhbC5EQVlfTkFNRVMubWFwKGQgPT4gaCgnc3BhbicsIHsgdGV4dDogZCB9KSkpLAogICAgICB0aW50KGgoJ2RpdicsIHsgY2xhc3M6ICdtb250aC1ncmlkJyB9LAogICAgICAgIGtleXMubWFwKGsgPT4gewogICAgICAgICAgY29uc3QgYWxsID0gYnlEYXkuZ2V0KGspOwogICAgICAgICAgY29uc3QgbW9yZSA9IGFsbC5sZW5ndGggLSBNT05USF9ST1dTOwogICAgICAgICAgcmV0dXJuIGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiBbLi4uZGF5Q2xhc3NlcyhrLCAnbWNlbGwnKSwgay5zbGljZSgwLCA3KSAhPT0gbW9udGggJiYgJ290aGVyJ10sICdhcmlhLWxhYmVsJzogbG9uZ0RhdGUoay",
"kgfSwKICAgICAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgICAgIGNsYXNzOiAnbWRheScsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiBTdHJpbmcoTnVtYmVyKGsuc2xpY2UoOCkpKSwgdGl0bGU6IGBXZWVrIG9mICR7bG9uZ0RhdGUoayl9YCwKICAgICAgICAgICAgICBkYXRhc2V0OiB7IGtleTogYGNhbC1kYXk6JHtrfWAgfSwgb25jbGljazogKCkgPT4gb3BlbldlZWsoayksCiAgICAgICAgICAgIH0pLAogICAgICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWl0ZW1zJyB9LCBhbGwuc2xpY2UoMCwgbW9yZSA-IDAgPyBNT05USF9ST1dTIC0gMSA6IE1PTlRIX1JPV1MpLm1hcChlID0-IGl0ZW1FbChlLCB7IGNvbXBhY3Q6IHRydWUgfSkpLAogICAgICAgICAgICAgIG1vcmUgPiAwID8gaCgnYnV0dG9uJywgeyBjbGFzczogJ21vcmUnLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYCske21vcmUgKyAxfSBtb3JlYCwgb25jbGljazogKCkgPT4gb3BlbldlZWsoaykgfSkgOiBudWxsKSk7CiAgICAgICAgfSkpLCAnLS1yb3dzJywgU3RyaW5nKGtleXMubGVuZ3RoIC8gNykpKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5XZWVrKGspIHsKICAgIEMuYW5jaG9yID0gazsKICAgIHNldFZpZXcoJ3dlZWsnKTsKICB9CgogIGZ1bmN0aW9uIGRyYXdBZ2VuZGEoKSB7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IGtleXMgPSBjYWwuZGF5cyhyLnN0YXJ0LCByLmVuZCk7CiAgICBjb25zdCBieURheSA9IGNhbC5ieU",
"RheSh2aXNpYmxlSXRlbXMoKSwga2V5cyk7CiAgICBjb25zdCBkYXlzID0ga2V5cy5maWx0ZXIoayA9PiBieURheS5nZXQoaykubGVuZ3RoIHx8IGsgPT09IEMudG9kYXkpOwogICAgaWYgKEMuc3RhdHVzID09PSAnbG9hZGluZycgJiYgIUMuc2hvd24pIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWFnZW5kYSBsb2FkaW5nJyB9KTsKICAgIGlmICghZGF5cy5sZW5ndGgpIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWFnZW5kYScgfSwgaCgncCcsIHsgY2xhc3M6ICdlbXB0eScsIHRleHQ6ICdOb3RoaW5nIG9uIGluIHRoZXNlIGZvdXIgd2Vla3MuJyB9KSk7CiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1hZ2VuZGEnIH0sIGRheXMubWFwKGsgPT4gewogICAgICBjb25zdCBtID0gY2FsLm1vbnRoTmFtZShrKTsKICAgICAgcmV0dXJuIGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiBkYXlDbGFzc2VzKGssICdhZGF5JyksICdhcmlhLWxhYmVsJzogbG9uZ0RhdGUoaykgfSwKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnYWRheS1kYXRlJyB9LAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkbnVtJywgdGV4dDogU3RyaW5nKE51bWJlcihrLnNsaWNlKDgpKSkgfSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RuYW1lJyB9LCBoKCdzcGFuJywgeyB0ZXh0OiBjYWwuZGF5TmFtZShrKSB9KSwgaCgnc3BhbicsIHsgY2xhc3M6ICdtb24nLCB0ZXh0OiBtLnNob3J0IH0pKSksCiAgIC",
"AgICAgaCgnZGl2JywgeyBjbGFzczogJ2NhbC1pdGVtcycgfSwgYnlEYXkuZ2V0KGspLmxlbmd0aAogICAgICAgICAgPyBieURheS5nZXQoaykubWFwKGUgPT4gaXRlbUVsKGUsIHsgYWdlbmRhOiB0cnVlIH0pKQogICAgICAgICAgOiBoKCdwJywgeyBjbGFzczogJ2VtcHR5JywgdGV4dDogJ05vdGhpbmcgb24gdG9kYXkuJyB9KSkpOwogICAgfSkpOwogIH0KCiAgZnVuY3Rpb24gdGltZVRleHQobXMpIHsKICAgIC8vIFRoZSAyNC1ob3VyIGNsb2NrLCB0d28gZGlnaXRzIGZvciB0aGUgaG91ciwgd2hhdGV2ZXIgdGhlIGJyb3dzZXIncwogICAgLy8gbGFuZ3VhZ2Ugd291bGQgaGF2ZSBjaG9zZW46ICIwOTozMCIsICIxOTozMCIuCiAgICBpZiAoIXRpbWVGb3JtYXQpIHRpbWVGb3JtYXQgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCh1bmRlZmluZWQsIHsgaG91cjogJzItZGlnaXQnLCBtaW51dGU6ICcyLWRpZ2l0JywgaG91ckN5Y2xlOiAnaDIzJyB9KTsKICAgIHJldHVybiB0aW1lRm9ybWF0LmZvcm1hdChuZXcgRGF0ZShtcykpOwogIH0KCiAgZnVuY3Rpb24gd2hlblRleHQoaXRlbSwgY29udCkgewogICAgaWYgKGl0ZW0uYWxsRGF5KSByZXR1cm4gaXRlbS5maXJzdCA9PT0gaXRlbS5sYXN0ID8gJ0FsbCBkYXknIDogYCR7c2hvcnREYXRlKGl0ZW0uZmlyc3QpfSDigJMgJHtzaG9ydERhdGUoaXRlbS5sYXN0KX1gOwogICAgY29uc3Qgc3BhbiA9IGAke3RpbWVUZXh0KGl0ZW0uc3RhcnQpfSDigJMgJHt0aW1lVGV4dChpdG",
"VtLmVuZCl9YDsKICAgIHJldHVybiBpdGVtLmZpcnN0ID09PSBpdGVtLmxhc3QgPyBzcGFuIDogYCR7c2hvcnREYXRlKGl0ZW0uZmlyc3QpfSAke3RpbWVUZXh0KGl0ZW0uc3RhcnQpfSDigJMgJHtzaG9ydERhdGUoaXRlbS5sYXN0KX0gJHt0aW1lVGV4dChpdGVtLmVuZCl9YDsKICB9CgogIGZ1bmN0aW9uIHNob3J0RGF0ZShrKSB7CiAgICByZXR1cm4gYCR7TnVtYmVyKGsuc2xpY2UoOCkpfSAke2NhbC5tb250aE5hbWUoaykuc2hvcnR9YDsKICB9CgogIC8vIEFuIGV2ZW50IG9yIGEgdGFzaywgYXMgYSBsaW5rIHRvIHdoZXJlIGl0IGxpdmVzIGluIEdvb2dsZS4KICBmdW5jdGlvbiBpdGVtRWwoeyBpdGVtLCBjb250IH0sIHsgY29tcGFjdCA9IGZhbHNlLCBhZ2VuZGEgPSBmYWxzZSwgZHVlID0gZmFsc2UgfSA9IHt9KSB7CiAgICBjb25zdCB0YWcgPSBpdGVtLmxpbmsgPyAnYScgOiAnZGl2JzsKICAgIGNvbnN0IGxpbmsgPSBpdGVtLmxpbmsgPyB7IGhyZWY6IGl0ZW0ubGluaywgdGFyZ2V0OiAnX2JsYW5rJywgcmVsOiAnbm9vcGVuZXIgbm9yZWZlcnJlcicgfSA6IHt9OwogICAgaWYgKGl0ZW0ua2luZCA9PT0gJ2V2ZW50JykgewogICAgICBjb25zdCB0aW1lID0gaXRlbS5hbGxEYXkgPyAoYWdlbmRhID8gJ0FsbCBkYXknIDogJycpIDogY29udCA_IChhZ2VuZGEgPyAndW50aWwgJyArIHRpbWVUZXh0KGl0ZW0uZW5kKSA6ICfigKYnKSA6IHRpbWVUZXh0KGl0ZW0uc3RhcnQpOwogICAgICBjb25zdCB0aXAgPSBbaXRlbS",
"50aXRsZSwgd2hlblRleHQoaXRlbSwgY29udCksIGl0ZW0ud2hlcmVdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcbicpOwogICAgICByZXR1cm4gdGludChoKHRhZywgT2JqZWN0LmFzc2lnbih7CiAgICAgICAgY2xhc3M6IFsnaXRlbScsICdldicsIGl0ZW0uYWxsRGF5ICYmICdhbGwtZGF5JywgY29tcGFjdCAmJiAnY29tcGFjdCddLCB0aXRsZTogdGlwLAogICAgICB9LCBsaW5rKSwKICAgICAgdGltZSA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAndGltZScsIHRleHQ6IHRpbWUgfSkgOiBudWxsLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3QnLCB0ZXh0OiBpdGVtLnRpdGxlIH0pKSwgJy0tYycsIGl0ZW0uY29sb3VyKTsKICAgIH0KICAgIGNvbnN0IHRpcCA9IFtpdGVtLnRpdGxlLCBpdGVtLmxpc3QgJiYgYEdvb2dsZSBUYXNrcyDCtyAke2l0ZW0ubGlzdH1gLCBkdWUgJiYgaXRlbS5kdWUgJiYgYER1ZSAke3Nob3J0RGF0ZShpdGVtLmR1ZSl9YCwKICAgICAgaXRlbS5lbWFpbCAmJiAnT3BlbnMgdGhlIGVtYWlsJ10uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJ1xuJyk7CiAgICByZXR1cm4gaCh0YWcsIE9iamVjdC5hc3NpZ24oeyBjbGFzczogWydpdGVtJywgJ3Rhc2snLCBpdGVtLmRvbmUgJiYgJ2RvbmUnLCBjb21wYWN0ICYmICdjb21wYWN0J10sIHRpdGxlOiB0aXAgfSwgbGluayksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnYm94JywgJ2FyaWEtbGFiZWwnOiBpdGVtLmRvbmUgPyAnRG9uZScgOiAnVG8gZG8nLCByb2",
"xlOiAnaW1nJyB9LCBpdGVtLmRvbmUgPyBpY29uKCdjaGVjaycsIDEyKSA6IG51bGwpLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3QnLCB0ZXh0OiBpdGVtLnRpdGxlIH0pLAogICAgICBkdWUgJiYgaXRlbS5kdWUgPyBoKCdzcGFuJywgeyBjbGFzczogJ2R1ZScsIHRleHQ6IHNob3J0RGF0ZShpdGVtLmR1ZSkgfSkgOiBudWxsLAogICAgICBpdGVtLmVtYWlsID8gaCgnc3BhbicsIHsgY2xhc3M6ICdtYWlsJywgdGl0bGU6ICdGcm9tIGFuIGVtYWlsJyB9LCBpY29uKCdtYWlsJywgMTQpKSA6IG51bGwpOwogIH0KCiAgLy8g4pSA4pSAIEtleXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGhhbmRsZUtleShlKSB7CiAgICBpZiAoZS5jdHJsS2V5IHx8IGUubWV0YUtleSB8fCBlLmFsdEtleSB8fCBlLmRlZmF1bHRQcmV2ZW50ZWQpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IHQgPSBlLmNvbXBvc2VkUGF0aCgpWzBdOwogICAgaWYgKHQgJiYgKHQuaXNDb250ZW50RWRpdGFibGUgfHwgL14oSU5QVVR8VEVYVEFSRUF8U0VMRUNUKSQvLnRlc3QodC50YWdOYW1lKSkpIHJldHVybiBmYWxzZTsKICAgIGlmIChDLnN0YXR1cy",
"A9PT0gJ3NpZ25pbicgfHwgQy5zdGF0dXMgPT09ICdtaXNtYXRjaCcpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IGsgPSBlLmtleS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgYWN0ID0gewogICAgICB0OiAoKSA9PiBnbyhjYWwuZGF0ZUtleShuZXcgRGF0ZSgpKSksCiAgICAgIGo6ICgpID0-IGdvKGNhbC5zdGVwKHZpZXcoKSwgQy5hbmNob3IsIDEpKSwKICAgICAgbjogKCkgPT4gZ28oY2FsLnN0ZXAodmlldygpLCBDLmFuY2hvciwgMSkpLAogICAgICBrOiAoKSA9PiBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCAtMSkpLAogICAgICBwOiAoKSA9PiBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCAtMSkpLAogICAgICB3OiAoKSA9PiBzZXRWaWV3KCd3ZWVrJyksCiAgICAgIG06ICgpID0-IHNldFZpZXcoJ21vbnRoJyksCiAgICAgIGE6ICgpID0-IHNldFZpZXcoJ2FnZW5kYScpLAogICAgfVtrXTsKICAgIGlmICghYWN0KSByZXR1cm4gZmFsc2U7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBhY3QoKTsKICAgIHJldHVybiB0cnVlOwogIH0KCiAgLy8gRXZlcnkgZmV3IHNlY29uZHMgd2hpbGUgb3BlbjogcGFzdCBtaWRuaWdodCwgdG9kYXkgbW92ZXMgb24uCiAgZnVuY3Rpb24gdGljaygpIHsKICAgIGNvbnN0IG5vdyA9IGNhbC5kYXRlS2V5KG5ldyBEYXRlKCkpOwogICAgaWYgKG5vdyA9PT0gQy50b2RheSkgcmV0dXJuOwogICAgaWYgKEMuYW5jaG9yID09PSBDLnRvZGF5KSBDLmFuY2hvciA9IG",
"5vdzsKICAgIEMudG9kYXkgPSBub3c7CiAgICBsb2FkKCk7CiAgfQoKICBucy5jYWxlbmRhciA9IHsKICAgIGluaXQsIGVsZW1lbnQsIGxvYWQsIGlzU3RhbGUsIGhhbmRsZUtleSwgdGljaywKICAgIGxvYWRlZEF0OiAoKSA9PiBDLmxvYWRlZEF0LAogICAgaXNMb2FkaW5nOiAoKSA9PiAhIUMubG9hZGluZywKICB9Owp9KSgpOwo\"],[\"src/content/board.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBib2FyZAovLwovLyBBIGZ1bGwtdmlld3BvcnQgb3ZlcmxheSBvdmVyIEdtYWlsLiBDb2x1bW5zIGFyZSBHbWFpbCBsYWJlbHMsIGNhcmRzIGFyZQovLyB0aHJlYWRzLCBhbmQgZXZlcnkgY2hhbmdlIGlzIGEgdGhyZWFkcy5tb2RpZnkgYXBwbGllZCBvcHRpbWlzdGljYWxseToKLy8gdGhlIGNhcmQgbW92ZXMgYXQgb25jZSwgYW5kIG1vdmVzIGJhY2sgd2l0aCBhIHRvYXN0IGlmIEdtYWlsIHJlZnVzZXMuCi8vIERyYWdnaW5nIGlzIHRoZSBxdWljayB3YXkgdG8gbW92ZSB0aGluZ3MsIGJ1dCBldmVyeSBhY3Rpb24gaXMgYWxzbyBvbgovLyB0aGUgY2FyZCdzICLii68iIG1",
"lbnUsIHNvIG5vdGhpbmcgbmVlZHMgYSBtb3VzZS4KLy8KLy8gVGhlIHBob25lIGFwcCAoYWRkb24vYXBwKSBydW5zIHRoaXMgc2FtZSBib2FyZCBhcyB0aGUgYXBwIGl0c2VsZiByYXRoZXIKLy8gdGhhbiBvdmVyIEdtYWlsOiBpdCBzZXRzIG5zLmJvYXJkRnJhbWUgLSB3aGVyZSB0byBkcmF3LCB0aGUgdGFiIHRvIHN0YXJ0Ci8vIG9uLCBhbmQgd2hhdCB0aGUgbm90ZXMgbmVlZCBmcm9tIGl0IC0gYW5kIHRoZXJlIGlzIHRoZW4gbm90aGluZyB0bwovLyBjbG9zZSwgYW5kIG5vIEdtYWlsIHBhZ2UgYmVoaW5kIHRvIGtlZXAgdGhlIGtleWJvYXJkIG91dCBvZi4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLCBsb2dvLCBtb3VudFNoYWRvdywgdG9hc3QsIG9wZW5NZW51LCBjbG9zZU1lbnUsIGlzTWVudU9wZW4gfSA9IG5zLnVpOwogIGNvbnN0IHsgdXRpbCwgbG9naWMsIHN0b3JlLCBob29rcywgYXBpLCBBUFB",
"fTkFNRSwgSE9TVF9JRFMsIEtFWVMgfSA9IG5zOwoKICAvLyBTdGF0ZXMgd2l0aCBhIHBhbmVsIG9mIHRoZWlyIG93biwgc2hvd24gd2hpY2hldmVyIHRhYiBpcyBvcGVuOiB0aGV5CiAgLy8gYXJlIGFib3V0IHRoZSBhY2NvdW50LCBub3QgYWJvdXQgdGhlIGJvYXJkIG9yIHRoZSBub3Rlcy4KICBjb25zdCBQQU5FTF9TVEFURVMgPSBuZXcgU2V0KFsnbm9fYWNjb3VudCcsICdub3RfY29uZmlndXJlZCcsICdhdXRoX3JlcXVpcmVkJywgJ2FjY291bnRfbWlzbWF0Y2gnXSk7CgogIC8vIE9wZW5pbmcgdGhlIGJvYXJkIHJlLXJlYWRzIEdtYWlsIGlmIHdoYXQgaXMgb24gc2NyZWVuIGlzIG9sZGVyIHRoYW4KICAvLyB0aGlzLiBTaG9ydCBlbm91Z2ggdGhhdCBhIGxhYmVsIGFkZGVkIG9uIHRoZSBwaG9uZSBzaG93cyB1cDsgbG9uZwogIC8vIGVub3VnaCB0aGF0IGZsaWNraW5nIHRoZSBib2FyZCBvcGVuIGFuZCBzaHV0IGNvc3RzIG5vdGhpbmcuCiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CgogIGNvbnN0IERSQUdfVFlQRSA9ICdhcHBsaWNhdGlvbi94LWdrYi10aHJlYWQnOwoKICBjb25zdCBWSUVXUyA9IFsnYm9hcmQnLCAnbm90ZXMnLCAnY2FsZW5kYXInXTsKCiAgLy8g4pSA4pSAIFN0YXRlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBTID0gewogICAgbW91bnRlZDogZmFsc2UsCiAgICBvcGVuOiBmYWxzZSwKICAgIHZpZXc6ICdib2FyZCcsICAgIC8vIGJvYXJkIHwgbm90ZXMgfCBjYWxlbmRhciAtIHRoZSBvdmVybGF5J3MgdGhyZWUgdGFicwogICAgdmlld0xvYWRlZDogZmFsc2UsCiAgICBhY2NvdW50OiAnJywKICAgIGNvbHVtbnM6IFtdLAogICAgbGlzdHM6IHt9LCAgICAgICAgLy8gY29sdW1uIGlkIOKGkiB0aHJlYWQgaWRzLCBpbiBkaXNwbGF5IG9yZGVyCiAgICB0cnVuY2F0ZWQ6IHt9LCAgICAvLyBjb2x1bW4gaWQg4oaSIHRydWUgd2hlbiBHbWFpbCBoYWQgbW9yZSB0aGFuIDEwMAogICAgbG9hZGVkQXQ6IDAsCiAgICBsb2FkaW5nOiBudWxsLCAgICAvLyBwcm9taXNlIG9mIHRoZSByZWZyZXNoIGluIHByb2dyZXNzCiAgICBzdGF0dXM6ICdpZGxlJywgICAvLyBpZGxlIHwgbG9hZGluZyB8IHJlYWR5IHwgZXJyb3IgfCBub19hY2NvdW50IHwgbm90X2NvbmZpZ3VyZWQgfCBhdXRoX3JlcXVpcmVkIHwgYWNjb3VudF9taXNtYXRjaAogICAgc3RhdHVzTWVzc2FnZTogJycsCiAgICBzZWFyY2g6IG51bGwsICAgICAvLyB7IGNvbElkLCBxdWVyeSwgaWRzLCBsb2FkaW5nLCBlcnJvciwgc2VxIH0KICAgIGRyYXdlcjogbnVsbCwgICAgIC8vIHsgZHJhZnQsIGVycm9yLCBzYXZpbmcgfQogICAgZWRpdHM6IG5ldyBNYXAoKSwgLy8gdGh",
"yZWFkIGlkIOKGkiB7IHRpdGxlPywgbm90ZT8sIGNvbG91cj8gfSAoc2VlIGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KQogICAgZWRpdG9yOiBudWxsLCAgICAgLy8geyBpZCwgc3ViamVjdCwgZHJhZnQsIGVycm9yLCBzYXZpbmcgfQogICAgZHJhZzogbnVsbCwgICAgICAgLy8geyBpZCwgZnJvbUNvbCwgY2FyZCwgcGxhY2Vob2xkZXIgfQogICAgbXV0YXRpb25zOiAwLCAgICAgLy8gbG9jYWwgbW92ZXMgbWFkZTsgYSByZWZyZXNoIHRoYXQgc3BhbnMgb25lIGlzIHN0YWxlCiAgICByZW5kZXJEZWZlcnJlZDogZmFsc2UsCiAgICByZXR1cm5Gb2N1czogbnVsbCwKICAgIHRpY2tlcjogMCwKICB9OwoKICBsZXQgcm9vdCA9IG51bGw7CiAgbGV0IGZyYW1lID0gbnVsbDsgLy8gbnMuYm9hcmRGcmFtZSwgaW4gdGhlIHBob25lIGFwcAogIGNvbnN0IGVscyA9IHt9OwoKICAvLyDilIDilIAgTW91bnRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG1vdW50KCkgewogICAgaWYgKFMubW91bnRlZCkgcmV0dXJuOwogICAgZnJhbWUgPSBucy5ib2FyZEZyYW1lIHx8IG51bGw7CiAgICAoeyByb290IH0gPSBmcmFtZSA_IHsgcm9vdDogZnJhbWUucm9",
"vdCB9IDogbW91bnRTaGFkb3coSE9TVF9JRFMuYm9hcmQsIG5zLnN0eWxlcy5ib2FyZCkpOwoKICAgIGVscy5hY2NvdW50ID0gaCgnc3BhbicsIHsgY2xhc3M6ICdhY2NvdW50JyB9KTsKICAgIGVscy51cGRhdGVkID0gaCgnc3BhbicsIHsgY2xhc3M6ICd1cGRhdGVkJyB9KTsKICAgIGVscy5yZWZyZXNoID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ1JlZnJlc2gnLCB0aXRsZTogJ1JlZnJlc2gnLAogICAgICBvbmNsaWNrOiAoKSA9PiAoUy52aWV3ID09PSAnbm90ZXMnID8gbnMubm90ZXMubG9hZCh7IGZvcmNlOiB0cnVlIH0pCiAgICAgICAgOiBTLnZpZXcgPT09ICdjYWxlbmRhcicgPyBucy5jYWxlbmRhci5sb2FkKHsgZm9yY2U6IHRydWUgfSkgOiByZWZyZXNoKCkpLAogICAgfSwgaWNvbigncmVmcmVzaCcpKTsKICAgIGVscy5zZXR0aW5ncyA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDb2x1bW4gc2V0dGluZ3MnLCB0aXRsZTogJ0NvbHVtbiBzZXR0aW5ncycsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAnc2V0dGluZ3MnIH0sIG9uY2xpY2s6IG9wZW5EcmF3ZXIsCiAgICB9LCBpY29uKCd0dW5lJykpOwogICAgZWxzLmNsb3NlID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzo",
"gJ0Nsb3NlIGJvYXJkJywgdGl0bGU6ICdDbG9zZSAoRXNjKScsCiAgICAgIGhpZGRlbjogISFmcmFtZSwgb25jbGljazogY2xvc2UsCiAgICB9LCBpY29uKCdjbG9zZScpKTsKCiAgICBjb25zdCB0YWIgPSAodmlldywgbGFiZWwsIGljb25OYW1lKSA9PiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAndGFiJywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICd0YWInLCAnYXJpYS1zZWxlY3RlZCc6IFN0cmluZyhTLnZpZXcgPT09IHZpZXcpLAogICAgICBkYXRhc2V0OiB7IGtleTogYHZpZXc6JHt2aWV3fWAsIHZpZXcgfSwgb25jbGljazogKCkgPT4gc3dpdGNoVmlldyh2aWV3KSwKICAgIH0sIGljb24oaWNvbk5hbWUsIDE4KSwgbGFiZWwpOwogICAgZWxzLnRhYnMgPSBoKCdkaXYnLCB7IGNsYXNzOiAndGFicycsIHJvbGU6ICd0YWJsaXN0JywgJ2FyaWEtbGFiZWwnOiAnVmlldycgfSwKICAgICAgdGFiKCdib2FyZCcsICdCb2FyZCcsICdib2FyZCcpLCB0YWIoJ25vdGVzJywgJ05vdGVzJywgJ25vdGUnKSwgdGFiKCdjYWxlbmRhcicsICdDYWxlbmRhcicsICdjYWxlbmRhcicpKTsKCiAgICAvLyBUaGUgbG9nbyBhbmQgbmFtZSBvcGVuIGEgc21hbGwgbWVudTogdGhlIHZlcnNpb24sIHRoZSB3ZWJzaXRlIGFuZAogICAgLy8gdGhlIHByaXZhY3kgcGFnZSwgYW5kIC0gaW4gdGhlIHBob25lIGFwcCAtIGhvdyBsb25nIGl0IHRvb2sgdG8gb3Blbi4KICAgIGNvbnN0IGJyYW5kID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczo",
"gJ2JyYW5kLWJ0bicsIHR5cGU6ICdidXR0b24nLCB0aXRsZTogYEFib3V0ICR7QVBQX05BTUV9YCwgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywKICAgICAgZGF0YXNldDogeyBrZXk6ICdhYm91dCcgfSwgb25jbGljazogZSA9PiBvcGVuQWJvdXQoZS5jdXJyZW50VGFyZ2V0KSwKICAgIH0sIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbG9nbycgfSwgbG9nbygyNikpLCBoKCdzcGFuJywgeyB0ZXh0OiBBUFBfTkFNRSB9KSk7CiAgICBjb25zdCBiYXIgPSBoKCdoZWFkZXInLCB7IGNsYXNzOiAnYmFyJyB9LAogICAgICBoKCdoMScsIHsgY2xhc3M6ICdicmFuZCcgfSwgYnJhbmQpLAogICAgICBlbHMudGFicywKICAgICAgZWxzLmFjY291bnQsCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICBlbHMudXBkYXRlZCwgZWxzLnJlZnJlc2gsIGVscy5zZXR0aW5ncywgZWxzLmNsb3NlKTsKCiAgICBlbHMuYm9keSA9IGgoJ21haW4nLCB7IGNsYXNzOiAnYm9keScgfSk7CiAgICBlbHMubGl2ZSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdzci1vbmx5JywgJ2FyaWEtbGl2ZSc6ICdwb2xpdGUnIH0pOwogICAgZWxzLmRyYXdlckxheWVyID0gaCgnZGl2JywgeyBjbGFzczogJ2RyYXdlci1sYXllcicgfSk7CiAgICBlbHMuZWRpdG9yTGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZWRpdG9yLWxheWVyJyB9KTsKCiAgICBlbHMub3ZlcmxheSA9IGgoJ2RpdicsIHsKICAgICA",
"gY2xhc3M6ICdvdmVybGF5Jywgcm9sZTogZnJhbWUgPyBudWxsIDogJ2RpYWxvZycsICdhcmlhLW1vZGFsJzogZnJhbWUgPyBudWxsIDogJ3RydWUnLCAnYXJpYS1sYWJlbCc6IGAke0FQUF9OQU1FfSBib2FyZGAsCiAgICAgIHRhYmluZGV4OiAnLTEnLCBoaWRkZW46IHRydWUsIG9ua2V5ZG93bjogb25PdmVybGF5S2V5LAogICAgfSwgYmFyLCBlbHMuYm9keSwgZWxzLmxpdmUsIGVscy5kcmF3ZXJMYXllciwgZWxzLmVkaXRvckxheWVyKTsKCiAgICByb290LmFwcGVuZENoaWxkKGVscy5vdmVybGF5KTsKICAgIFMubW91bnRlZCA9IHRydWU7CgogICAgLy8gU21hbGwgcGVyLWFjY291bnQgcHJlZmVyZW5jZXMgKGZvbGRlZCBmb2xkZXJzLCB0aGUgY2FsZW5kYXIncyB2aWV3KSwKICAgIC8vIG9uIHRoaXMgY29tcHV0ZXIuCiAgICBjb25zdCBwcmVmcyA9IHsKICAgICAgYXN5bmMgZ2V0KG5hbWUpIHsKICAgICAgICBjb25zdCBrZXkgPSBLRVlTLnByZWYoaG9va3MuZ2V0QWNjb3VudCgpLCBuYW1lKTsKICAgICAgICByZXR1cm4gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpKVtrZXldOwogICAgICB9LAogICAgICBzZXQ6IChuYW1lLCB2YWx1ZSkgPT4gY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW0tFWVMucHJlZihob29rcy5nZXRBY2NvdW50KCksIG5hbWUpXTogdmFsdWUgfSksCiAgICB9OwoKICAgIG5zLm5vdGVzLmluaXQoT2JqZWN0LmFzc2lnbih7CiAgICAgIHJvb3QsCiAgICAgIC8vIEFjY29",
"1bnQgdHJvdWJsZSBmb3VuZCBieSB0aGUgbm90ZXMgZ2V0cyB0aGUgc2FtZSBwYW5lbCBhcyB0aGUgYm9hcmQncy4KICAgICAgb25TdGF0ZUVycm9yOiBlcnIgPT4gewogICAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0sCiAgICAgIG9uTG9hZGVkOiAoKSA9PiB7CiAgICAgICAgaWYgKCFQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSkgcmV0dXJuOwogICAgICAgIFMuc3RhdHVzID0gJ2lkbGUnOwogICAgICAgIHJlbmRlcigpOwogICAgICB9LAogICAgICBjbG9zZUJvYXJkOiBjbG9zZSwKICAgICAgYmFyQ2hhbmdlZDogdXBkYXRlQmFyLAogICAgICAvLyBXaGljaCBmb2xkZXJzIGFyZSBmb2xkZWQsIG9uIHRoaXMgY29tcHV0ZXIsIGZvciB0aGlzIGFjY291bnQuCiAgICAgIHByZWZzLAogICAgfSwgZnJhbWUgJiYgZnJhbWUubm90ZXMpKTsKCiAgICBucy5jYWxlbmRhci5pbml0KE9iamVjdC5hc3NpZ24oewogICAgICByb290LAogICAgICAvLyBObyBjbGllbnQgSUQgeWV0OiB0aGUgYm9hcmQncyBvd24gc2V0dXAgcGFuZWwuIFRoZSBjYWxlbmRhcidzCiAgICAgIC8vIG93biBzaWduLWluIGhhcyBhIHBhbmVsIG9mIGl0cyBvd24sIGluc2lkZSB0aGUgY2FsZW5kYXIuCiAgICAgIG9uU3RhdGVFcnJvcjogZXJyID0-IHsKICAgICAgICBTLnN0YXR1cyA9IGVyci5jb2RlOwogICAgICAgIFMuc3RhdHVzTWV",
"zc2FnZSA9IGVyci5tZXNzYWdlOwogICAgICAgIHJlbmRlcigpOwogICAgICB9LAogICAgICBvbkxvYWRlZDogKCkgPT4gewogICAgICAgIGlmICghUEFORUxfU1RBVEVTLmhhcyhTLnN0YXR1cykpIHJldHVybjsKICAgICAgICBTLnN0YXR1cyA9ICdpZGxlJzsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSwKICAgICAgYmFyQ2hhbmdlZDogdXBkYXRlQmFyLAogICAgICBwcmVmcywKICAgICAgY29ubmVjdDogKCkgPT4gYXBpLmNvbm5lY3RDYWxlbmRhcigpLAogICAgfSwgZnJhbWUgJiYgZnJhbWUuY2FsZW5kYXIpKTsKCiAgICAvLyBBIG1vdmUgbWFkZSBmcm9tIHRoZSBkb2NrIChvciBhbm90aGVyIHRhYikgbWFrZXMgd2hhdCB0aGUgYm9hcmQgbGFzdAogICAgLy8gbG9hZGVkIHdyb25nOyB0aGUgYm9hcmQncyBvd24gbW92ZXMgYXJlIGFscmVhZHkgcmVmbGVjdGVkIG9uIHNjcmVlbi4KICAgIHN0b3JlLmJ1cy5hZGRFdmVudExpc3RlbmVyKCd0aHJlYWQtY2hhbmdlZCcsIGUgPT4gewogICAgICBpZiAoZS5kZXRhaWwgJiYgZS5kZXRhaWwuc291cmNlID09PSAnYm9hcmQnKSByZXR1cm47CiAgICAgIFMubG9hZGVkQXQgPSAwOwogICAgICBpZiAoUy5vcGVuICYmIFMudmlldyA9PT0gJ2JvYXJkJykgcmVmcmVzaCgpOwogICAgfSk7CiAgfQoKICAvLyDilIDilIAgT3BlbiAvIGNsb3NlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBhc3luYyBmdW5jdGlvbiBvcGVuKHsgdmlldyB9ID0ge30pIHsKICAgIG1vdW50KCk7CiAgICBpZiAoUy5vcGVuKSB7CiAgICAgIGlmICh2aWV3KSBzd2l0Y2hWaWV3KHZpZXcpOwogICAgICByZXR1cm47CiAgICB9CiAgICBTLm9wZW4gPSB0cnVlOwogICAgUy5yZXR1cm5Gb2N1cyA9IGZyYW1lID8gbnVsbCA6IGRlZXBBY3RpdmVFbGVtZW50KCk7CiAgICBlbHMub3ZlcmxheS5oaWRkZW4gPSBmYWxzZTsKICAgIGlmICghZnJhbWUpIGVscy5jbG9zZS5mb2N1cygpOwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uRG9jdW1lbnRLZXksIHRydWUpOwogICAgUy50aWNrZXIgPSBzZXRJbnRlcnZhbCh1cGRhdGVCYXIsIDUwMDApOwoKICAgIC8vIFRoZSB0YWIgbGFzdCB1c2VkLCB1bmxlc3MgdGhlIGNhbGxlciBhc2tlZCBmb3Igb25lLgogICAgaWYgKCFTLnZpZXdMb2FkZWQpIHsKICAgICAgUy52aWV3TG9hZGVkID0gdHJ1ZTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBnb3QgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoS0VZUy52aWV3KTsKICAgICAgICBpZiAoVklFV1MuaW5jbHVkZXMoZ290W0tFWVMudmlld10pKSBTLnZpZXcgPSBnb3RbS0VZUy52aWV3XTsKICAgICAgICBlbHNlIGlmIChmcmFtZSAmJiBmcmFtZS52aWV",
"3KSBTLnZpZXcgPSBmcmFtZS52aWV3OwogICAgICB9IGNhdGNoIHsgLyogZXh0ZW5zaW9uIHJlbG9hZGVkOyBoYW5kbGVkIGp1c3QgYmVsb3cgKi8gfQogICAgfQogICAgaWYgKHZpZXcpIFMudmlldyA9IHZpZXc7CgogICAgUy5hY2NvdW50ID0gaG9va3MuZ2V0QWNjb3VudCgpOwogICAgaWYgKCFTLmFjY291bnQpIHsKICAgICAgUy5zdGF0dXMgPSAnbm9fYWNjb3VudCc7CiAgICAgIHJlbmRlcigpOwogICAgICByZXR1cm47CiAgICB9CiAgICB0cnkgewogICAgICBpZiAoIVMuY29sdW1ucy5sZW5ndGgpIFMuY29sdW1ucyA9IGF3YWl0IHN0b3JlLmxvYWRDb2x1bW5zKFMuYWNjb3VudCk7CiAgICB9IGNhdGNoIHsKICAgICAgLy8gY2hyb21lLnN0b3JhZ2UgdGhyb3dzIG9uY2UgdGhlIGV4dGVuc2lvbiBoYXMgYmVlbiByZWxvYWRlZCB1bmRlcgogICAgICAvLyB0aGlzIHRhYjsgbm90aGluZyBlbHNlIHdpbGwgd29yayB1bnRpbCBHbWFpbCBpcyByZWxvYWRlZCBlaXRoZXIuCiAgICAgIFMuc3RhdHVzID0gJ2Vycm9yJzsKICAgICAgUy5zdGF0dXNNZXNzYWdlID0gJ1RoZSBleHRlbnNpb24gd2FzIHVwZGF0ZWQuIFJlbG9hZCB0aGlzIEdtYWlsIHRhYi4nOwogICAgICByZW5kZXIoKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKFMudmlldyA9PT0gJ25vdGVzJykgc2hvd05vdGVzKCk7CiAgICBlbHNlIGlmIChTLnZpZXcgPT09ICdjYWxlbmRhcicpIHNob3dDYWxlbmRhcigpOwogICAgZWxzZSBzaG93Qm9hcmQoKTs",
"KICB9CgogIGZ1bmN0aW9uIHNob3dCb2FyZCgpIHsKICAgIGNvbnN0IHN0YWxlID0gUy5zdGF0dXMgIT09ICdyZWFkeScgfHwgRGF0ZS5ub3coKSAtIFMubG9hZGVkQXQgPiBTVEFMRV9NUzsKICAgIC8vIFNrZWxldG9uIGNvbHVtbnMgd2hpbGUgYSBmaXJzdCAob3IgcmV0cmllZCkgbG9hZCBydW5zLCByYXRoZXIgdGhhbgogICAgLy8gbGVhdmluZyBhbiBvbGQgIkNvbm5lY3QgR21haWwiIHBhbmVsIHVwIGFmdGVyIHRoZSB1c2VyIGhhcyBjb25uZWN0ZWQuCiAgICBpZiAoUy5zdGF0dXMgIT09ICdyZWFkeScpIFMuc3RhdHVzID0gJ2xvYWRpbmcnOwogICAgcmVuZGVyKCk7CiAgICBpZiAoc3RhbGUpIHJlZnJlc2goKTsKICB9CgogIC8vIEFuIGFjY291bnQgcGFuZWwgbGVmdCBvdmVyIGZyb20gZWFybGllciBpcyByZXRyaWVkIHJhdGhlciB0aGFuIHNob3duCiAgLy8gYWdhaW47IGlmIHRoZSB0cm91YmxlIGlzIHN0aWxsIHRoZXJlLCB0aGUgbm90ZXMnIG93biBsb2FkIHNheXMgc28uCiAgZnVuY3Rpb24gc2hvd05vdGVzKCkgewogICAgaWYgKFBBTkVMX1NUQVRFUy5oYXMoUy5zdGF0dXMpKSBTLnN0YXR1cyA9ICdpZGxlJzsKICAgIHJlbmRlcigpOwogICAgbnMubm90ZXMubG9hZCgpOwogICAgaWYgKCFmcmFtZSB8fCBmcmFtZS5mb2N1cyAhPT0gZmFsc2UpIG5zLm5vdGVzLmZvY3VzRGVmYXVsdCgpOwogIH0KCiAgLy8gVGhlIGNhbGVuZGFyIG5lZWRzIG5vdGhpbmcgb2YgR21haWwncywgc28gYSBHbWFpbCBwYW5lbCB",
"pcyBubyByZWFzb24KICAvLyB0byBrZWVwIGl0IGhpZGRlbjsgb25seSBhIG1pc3NpbmcgY2xpZW50IElEIG9yIGFjY291bnQgc3RhbmRzIGluIGl0cyB3YXkuCiAgZnVuY3Rpb24gc2hvd0NhbGVuZGFyKCkgewogICAgaWYgKFBBTkVMX1NUQVRFUy5oYXMoUy5zdGF0dXMpICYmIFMuc3RhdHVzICE9PSAnbm90X2NvbmZpZ3VyZWQnICYmIFMuc3RhdHVzICE9PSAnbm9fYWNjb3VudCcpIFMuc3RhdHVzID0gJ2lkbGUnOwogICAgcmVuZGVyKCk7CiAgICBucy5jYWxlbmRhci5sb2FkKCk7CiAgfQoKICBjb25zdCBTSVRFID0gJ2h0dHBzOi8vbWVtZGVzay5hcHAvJzsKCiAgZnVuY3Rpb24gb3BlbkFib3V0KGFuY2hvcikgewogICAgY29uc3QgbGluayA9IChsYWJlbCwgdXJsKSA9PiAoeyBsYWJlbCwgaWNvbjogJ29wZW4nLCBrZXk6IGBhYm91dDoke2xhYmVsfWAsIG9uU2VsZWN0OiAoKSA9PiB3aW5kb3cub3Blbih1cmwsICdfYmxhbmsnLCAnbm9vcGVuZXInKSB9KTsKICAgIGNvbnN0IGl0ZW1zID0gWwogICAgICB7IGhlYWRpbmc6IGAke0FQUF9OQU1FfSAke25zLkFQUF9WRVJTSU9OfWAgfSwKICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgbGluaygnbWVtZGVzay5hcHAnLCBTSVRFKSwKICAgICAgbGluaygnUHJpdmFjeScsIGAke1NJVEV9cHJpdmFjeS9gKSwKICAgIF07CiAgICAvLyBGb3IgZmluZGluZyBvdXQgd2hhdCBpcyBzbG93LCBub3QgZm9yIGV2ZXJ5IGRheTogb3V0IG9mIHRoZSB3YXkuCiAgICBpZiA",
"oZnJhbWUgJiYgZnJhbWUudGltaW5ncykgewogICAgICBpdGVtcy5wdXNoKHsgc2VwYXJhdG9yOiB0cnVlIH0sIHsKICAgICAgICBsYWJlbDogJ0FkdmFuY2VkOiBzdGFydHVwIHRpbWluZ3MnLCBpY29uOiAndHVuZScsIGtleTogJ2Fib3V0OnRpbWluZ3MnLAogICAgICAgIG9uU2VsZWN0OiAoKSA9PiB0b2FzdChyb290LCBmcmFtZS50aW1pbmdzKCksIHsgdGltZW91dDogODAwMCB9KSwKICAgICAgfSk7CiAgICB9CiAgICBvcGVuTWVudShyb290LCBhbmNob3IsIGl0ZW1zLCB7IGxhYmVsOiBgQWJvdXQgJHtBUFBfTkFNRX1gIH0pOwogIH0KCiAgZnVuY3Rpb24gc3dpdGNoVmlldyh2aWV3KSB7CiAgICBpZiAodmlldyA9PT0gUy52aWV3IHx8ICFTLm9wZW4pIHJldHVybjsKICAgIC8vIFRoZSBub3Rlcywgb3IgdGhlIGNhbGVuZGFyJ3Mgc2NyYXRjaHBhZCB0aWxlLgogICAgbnMubm90ZXMuZmx1c2goKTsKICAgIGNsb3NlTWVudShyb290KTsKICAgIFMuc2VhcmNoID0gbnVsbDsKICAgIFMudmlldyA9IHZpZXc7CiAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy52aWV3XTogdmlldyB9KS5jYXRjaCgoKSA9PiB7fSk7CiAgICBpZiAodmlldyA9PT0gJ25vdGVzJykgc2hvd05vdGVzKCk7CiAgICBlbHNlIGlmICh2aWV3ID09PSAnY2FsZW5kYXInKSBzaG93Q2FsZW5kYXIoKTsKICAgIGVsc2Ugc2hvd0JvYXJkKCk7CiAgfQoKICAvLyBUaGUgZG9jaydzIGJ1dHRvbnM6IG9wZW4gb24gdGhhdCB0YWIsIHN3aXR",
"jaCB0byBpdCwgb3IgLSB3aGVuIGl0CiAgLy8gaXMgYWxyZWFkeSBzaG93aW5nIC0gY2xvc2UuCiAgZnVuY3Rpb24gdG9nZ2xlVmlldyh2aWV3KSB7CiAgICBpZiAoUy5vcGVuICYmIFMudmlldyA9PT0gdmlldykgY2xvc2UoKTsKICAgIGVsc2UgaWYgKFMub3Blbikgc3dpdGNoVmlldyh2aWV3KTsKICAgIGVsc2Ugb3Blbih7IHZpZXcgfSk7CiAgfQoKICBmdW5jdGlvbiBjbG9zZSgpIHsKICAgIC8vIEluIHRoZSBwaG9uZSBhcHAgdGhlIGJvYXJkIGlzIHRoZSBhcHA6IHRoZXJlIGlzIG5vdGhpbmcgdG8gY2xvc2UgdG8uCiAgICBpZiAoIVMub3BlbiB8fCBmcmFtZSkgcmV0dXJuOwogICAgLy8gV2hhdGV2ZXIgd2FzIHR5cGVkIGluIHRoZSBsYXN0IHNlY29uZCBvciB0d28gaXMgc2F2ZWQgb24gdGhlIHdheSBvdXQuCiAgICBucy5ub3Rlcy5mbHVzaCgpOwogICAgY2xvc2VNZW51KHJvb3QpOwogICAgUy5vcGVuID0gZmFsc2U7CiAgICBTLnNlYXJjaCA9IG51bGw7CiAgICBTLmRyYXdlciA9IG51bGw7CiAgICBTLmVkaXRvciA9IG51bGw7CiAgICByZW5kZXJEcmF3ZXIoKTsKICAgIHJlbmRlckVkaXRvcigpOwogICAgZWxzLm92ZXJsYXkuaGlkZGVuID0gdHJ1ZTsKICAgIC8vICJDb2x1bW5zIHNhdmVkIiBtZWFucyBub3RoaW5nIG9uY2UgdGhlIGJvYXJkIGlzIGdvbmU7IGVycm9ycyBzdGF5CiAgICAvLyB1bnRpbCByZWFkIG9yIHRpbWVkIG91dCwgc2luY2UgdGhleSBtYXkgZXhwbGFpbiBhIGNhcmQgdGhhdCBtb3ZlZCB",
"iYWNrLgogICAgZm9yIChjb25zdCB0IG9mIHJvb3QucXVlcnlTZWxlY3RvckFsbCgnLnRvYXN0Om5vdCgudG9hc3QtZXJyb3IpJykpIHQucmVtb3ZlKCk7CiAgICBjbGVhckludGVydmFsKFMudGlja2VyKTsKICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBvbkRvY3VtZW50S2V5LCB0cnVlKTsKICAgIGNvbnN0IGJhY2sgPSBTLnJldHVybkZvY3VzOwogICAgUy5yZXR1cm5Gb2N1cyA9IG51bGw7CiAgICBpZiAoYmFjayAmJiBiYWNrLmlzQ29ubmVjdGVkICYmIHR5cGVvZiBiYWNrLmZvY3VzID09PSAnZnVuY3Rpb24nKSBiYWNrLmZvY3VzKCk7CiAgfQoKICBmdW5jdGlvbiB0b2dnbGUoKSB7CiAgICBpZiAoUy5vcGVuKSBjbG9zZSgpOwogICAgZWxzZSBvcGVuKCk7CiAgfQoKICAvLyBkb2N1bWVudC5hY3RpdmVFbGVtZW50IHN0b3BzIGF0IGEgc2hhZG93IGhvc3QgLSB0aGUgZG9jaydzLCB3aGVuIHRoZQogIC8vIGJvYXJkIHdhcyBvcGVuZWQgZnJvbSBpdHMgYnV0dG9uIC0gYW5kIGEgaG9zdCBjYW5ub3QgdGFrZSBmb2N1cyBiYWNrLgogIGZ1bmN0aW9uIGRlZXBBY3RpdmVFbGVtZW50KCkgewogICAgbGV0IGEgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50OwogICAgd2hpbGUgKGEgJiYgYS5zaGFkb3dSb290ICYmIGEuc2hhZG93Um9vdC5hY3RpdmVFbGVtZW50KSBhID0gYS5zaGFkb3dSb290LmFjdGl2ZUVsZW1lbnQ7CiAgICByZXR1cm4gYTsKICB9CgogIC8vIOKUgOKUgCBLZXlib2FyZCD",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gRXNjIHBlZWxzIGJhY2sgb25lIGxheWVyIGF0IGEgdGltZTogY2FyZCBlZGl0b3Igb3IgZHJhd2VyLCB0aGVuCiAgLy8gc2VhcmNoLCB0aGVuIGJvYXJkLiBPcGVuIG1lbnVzIGhhbmRsZSB0aGVpciBvd24gRXNjIGJlZm9yZSBpdCBnZXRzIGhlcmUuCiAgZnVuY3Rpb24gb25PdmVybGF5S2V5KGUpIHsKICAgIGlmIChTLnZpZXcgPT09ICdub3RlcycgJiYgIVMuZWRpdG9yICYmIG5zLm5vdGVzLmhhbmRsZUtleShlKSkgcmV0dXJuOwogICAgaWYgKFMudmlldyA9PT0gJ2NhbGVuZGFyJyAmJiAhUy5lZGl0b3IgJiYgIVMuZHJhd2VyICYmICFpc01lbnVPcGVuKHJvb3QpICYmIG5zLmNhbGVuZGFyLmhhbmRsZUtleShlKSkgcmV0dXJuOwogICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgewogICAgICBpZiAoaXNNZW51T3Blbihyb290KSkgcmV0dXJuOwogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGlmIChTLmVkaXRvcikgY2xvc2VFZGl0b3IoKTsKICAgICAgZWxzZSBpZiAoUy5kcmF3ZXIpIGNsb3NlRHJhd2VyKCk7CiAgICAgIGVsc2UgaWYgKFMuc2VhcmNoKSBjbG9zZVNlYXJjaCgpOwogICAgICB",
"lbHNlIGNsb3NlKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChlLmtleSA9PT0gJ1RhYicgJiYgIWZyYW1lKSB0cmFwRm9jdXMoZSk7CiAgfQoKICAvLyBJZiBmb2N1cyBoYXMgZXNjYXBlZCB0byBHbWFpbCdzIHBhZ2UgKGEgY2xpY2sgb24gaXRzIGVkZ2UsIHNheSksIEVzYwogIC8vIHNob3VsZCBzdGlsbCBjbG9zZSB0aGUgYm9hcmQgcmF0aGVyIHRoYW4gcmVhY2ggR21haWwuCiAgZnVuY3Rpb24gb25Eb2N1bWVudEtleShlKSB7CiAgICAvLyBGMyBzdGVwcyB0aHJvdWdoIHNlYXJjaCBtYXRjaGVzIHdoZXJldmVyIHRoZSBmb2N1cyBoYXMgd2FuZGVyZWQuCiAgICBpZiAoZS5rZXkgPT09ICdGMycgJiYgUy5vcGVuICYmIFMudmlldyA9PT0gJ25vdGVzJyAmJiAhZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhlbHMub3ZlcmxheSkpIHsKICAgICAgbnMubm90ZXMuaGFuZGxlS2V5KGUpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoZS5rZXkgIT09ICdFc2NhcGUnIHx8ICFTLm9wZW4gfHwgZnJhbWUpIHJldHVybjsKICAgIGlmIChlLmNvbXBvc2VkUGF0aCgpLmluY2x1ZGVzKGVscy5vdmVybGF5KSkgcmV0dXJuOwogICAgaWYgKGlzTWVudU9wZW4ocm9vdCkpIHJldHVybjsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICBjbG9zZSgpOwogIH0KCiAgLy8gQSBtb2RhbCB0aGF0IGxldHMgVGFiIHdhbmRlciBpbnRvIHRoZSBwYWdlIGJlaGluZCBpdCBpcyBub3Q",
"gbW9kYWwuCiAgZnVuY3Rpb24gdHJhcEZvY3VzKGUpIHsKICAgIGNvbnN0IHNjb3BlID0gUy5lZGl0b3IgPyBlbHMuZWRpdG9yTGF5ZXIgOiBTLmRyYXdlciA_IGVscy5kcmF3ZXJMYXllciA6IGVscy5vdmVybGF5OwogICAgY29uc3QgZm9jdXNhYmxlID0gWy4uLnNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbjpub3QoW2Rpc2FibGVkXSksIGlucHV0Om5vdChbZGlzYWJsZWRdKSwgdGV4dGFyZWE6bm90KFtkaXNhYmxlZF0pJyldCiAgICAgIC5maWx0ZXIoZWwgPT4gZWwuZ2V0Q2xpZW50UmVjdHMoKS5sZW5ndGgpOwogICAgaWYgKCFmb2N1c2FibGUubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBmaXJzdCA9IGZvY3VzYWJsZVswXTsKICAgIGNvbnN0IGxhc3QgPSBmb2N1c2FibGVbZm9jdXNhYmxlLmxlbmd0aCAtIDFdOwogICAgY29uc3QgYWN0aXZlID0gcm9vdC5hY3RpdmVFbGVtZW50OwogICAgaWYgKGUuc2hpZnRLZXkgJiYgKGFjdGl2ZSA9PT0gZmlyc3QgfHwgIXNjb3BlLmNvbnRhaW5zKGFjdGl2ZSkpKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGFzdC5mb2N1cygpOyB9CiAgICBlbHNlIGlmICghZS5zaGlmdEtleSAmJiAoYWN0aXZlID09PSBsYXN0IHx8ICFzY29wZS5jb250YWlucyhhY3RpdmUpKSkgeyBlLnByZXZlbnREZWZhdWx0KCk7IGZpcnN0LmZvY3VzKCk7IH0KICB9CgogIC8vIOKUgOKUgCBMb2FkaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiByZWZyZXNoKCkgewogICAgaWYgKCFTLm1vdW50ZWQpIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTsKICAgIGlmIChTLmxvYWRpbmcpIHJldHVybiBTLmxvYWRpbmc7CiAgICBpZiAoIVMuYWNjb3VudCkgUy5hY2NvdW50ID0gaG9va3MuZ2V0QWNjb3VudCgpOwogICAgaWYgKCFTLmFjY291bnQpIHsKICAgICAgUy5zdGF0dXMgPSAnbm9fYWNjb3VudCc7CiAgICAgIHJlbmRlcigpOwogICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7CiAgICB9CgogICAgY29uc3Qgc3RhcnRlZEF0ID0gUy5tdXRhdGlvbnM7CiAgICBsZXQgb3ZlcnRha2VuID0gZmFsc2U7CgogICAgUy5sb2FkaW5nID0gKGFzeW5jICgpID0-IHsKICAgICAgdXBkYXRlQmFyKCk7CiAgICAgIHRyeSB7CiAgICAgICAgUy5jb2x1bW5zID0gYXdhaXQgc3RvcmUubG9hZENvbHVtbnMoUy5hY2NvdW50KTsKICAgICAgICBjb25zdCBbYm9hcmQsIHNhdmVkLCBlZGl0c10gPSBhd2FpdCBQcm9taXNlLmFsbChbCiAgICAgICAgICBzdG9yZS5sb2FkQm9hcmQoUy5hY2NvdW50LCBTLmNvbHVtbnMpLAogICAgICAgICAgc3RvcmUubG9hZE9yZGVyKFMuYWNjb3VudCksCiAgICAgICAgICBzdG9yZS5sb2FkQ2FyZEVkaXRzKFMuYWN",
"jb3VudCksCiAgICAgICAgXSk7CiAgICAgICAgUy5lZGl0cyA9IGVkaXRzOwogICAgICAgIC8vIExhYmVsIG5hbWVzIGFzIEdtYWlsIGhhcyB0aGVtIG5vdzsgYSBjb2x1bW4gZm9sbG93cyBhIHJlbmFtZS4KICAgICAgICBTLmNvbHVtbnMgPSBib2FyZC5jb2x1bW5zOwogICAgICAgIC8vIEEgY2FyZCBtb3ZlZCB3aGlsZSB0aGUgbGlzdHMgd2VyZSBpbiBmbGlnaHQ6IHdoYXQgY2FtZSBiYWNrIG1heQogICAgICAgIC8vIHByZWRhdGUgdGhhdCBtb3ZlIGFuZCB3b3VsZCBzbmFwIHRoZSBjYXJkIGJhY2suIFRocm93IGl0IGF3YXkgYW5kCiAgICAgICAgLy8gYXNrIGFnYWluOyBsb2FkQm9hcmQgd2FpdHMgZm9yIHRoZSBtb3ZlIHRvIGxhbmQgZmlyc3QuCiAgICAgICAgaWYgKFMubXV0YXRpb25zICE9PSBzdGFydGVkQXQpIHsKICAgICAgICAgIG92ZXJ0YWtlbiA9IHRydWU7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGNvbnN0IGxpc3RzID0ge307CiAgICAgICAgZm9yIChjb25zdCBjb2wgb2YgUy5jb2x1bW5zKSB7CiAgICAgICAgICBjb25zdCB0aHJlYWRzID0gKGJvYXJkLmxpc3RzW2NvbC5pZF0gfHwgW10pLm1hcChpZCA9PiAoeyBpZCwgdHM6IChzdG9yZS50aHJlYWQoaWQpIHx8IHt9KS50cyB9KSk7CiAgICAgICAgICBsaXN0c1tjb2wuaWRdID0gbG9naWMubWVyZ2VPcmRlcihzYXZlZFtjb2wuaWRdLCB0aHJlYWRzKTsKICAgICAgICB9CiAgICAgICAgUy5saXN0cyA9IGxpc3RzOwogICAgICA",
"gIFMudHJ1bmNhdGVkID0gYm9hcmQudHJ1bmNhdGVkOwogICAgICAgIFMubG9hZGVkQXQgPSBEYXRlLm5vdygpOwogICAgICAgIFMuc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgICBTLnN0YXR1c01lc3NhZ2UgPSAnJzsKICAgICAgICAvLyBTYXZlZCBkaXJlY3RseSwgbm90IHZpYSBwZXJzaXN0T3JkZXI6IHRoaXMgcHJ1bmVzIHZhbmlzaGVkIGlkcwogICAgICAgIC8vIGFuZCBpcyBub3QgYSBsb2NhbCBtb3ZlLgogICAgICAgIHN0b3JlLnNhdmVPcmRlcihTLmFjY291bnQsIFMubGlzdHMsIFMuY29sdW1ucykuY2F0Y2goKCkgPT4ge30pOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBoYW5kbGVFcnJvcihlcnIsICdDb3VsZG7igJl0IGxvYWQgdGhlIGJvYXJkJyk7CiAgICAgIH0gZmluYWxseSB7CiAgICAgICAgUy5sb2FkaW5nID0gbnVsbDsKICAgICAgICBpZiAoIW92ZXJ0YWtlbikgewogICAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgICBpZiAoUy5zZWFyY2ggJiYgUy5zZWFyY2guaWRzID09PSBudWxsKSBydW5TZWFyY2goKTsKICAgICAgICB9CiAgICAgIH0KICAgIH0pKCk7CiAgICBjb25zdCBwID0gUy5sb2FkaW5nOwogICAgcmV0dXJuIHAudGhlbigoKSA9PiAob3ZlcnRha2VuID8gcmVmcmVzaCgpIDogdW5kZWZpbmVkKSk7CiAgfQoKICAvLyBUaGUgdGhyZWUgYWNjb3VudCBzdGF0ZXMgZ2V0IGEgcGFuZWwgb2YgdGhlaXIgb3duOyBhbnl0aGluZyBlbHNlIGlzCiAgLy8gYSB0b2FzdCBvdmVyIHdoYXR",
"ldmVyIHdhcyBhbHJlYWR5IG9uIHNjcmVlbi4KICBmdW5jdGlvbiBoYW5kbGVFcnJvcihlcnIsIHByZWZpeCkgewogICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSB7CiAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgIFMuc3RhdHVzTWVzc2FnZSA9IGVyci5tZXNzYWdlOwogICAgICBTLnNlYXJjaCA9IG51bGw7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChTLnN0YXR1cyAhPT0gJ3JlYWR5JykgewogICAgICBTLnN0YXR1cyA9ICdlcnJvcic7CiAgICAgIFMuc3RhdHVzTWVzc2FnZSA9IGVyci5tZXNzYWdlOwogICAgICByZXR1cm47CiAgICB9CiAgICB0b2FzdChyb290LCBgJHtwcmVmaXh9OiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICB9CgogIC8vIEV2ZXJ5IGxvY2FsIGNoYW5nZSB0byB0aGUgbGlzdHMgZ29lcyB0aHJvdWdoIGhlcmUsIHdoaWNoIGlzIGFsc28gd2hhdAogIC8vIG1hcmtzIGFuIGluLWZsaWdodCByZWZyZXNoIGFzIG92ZXJ0YWtlbi4KICBmdW5jdGlvbiBwZXJzaXN0T3JkZXIoKSB7CiAgICBTLm11dGF0aW9ucysrOwogICAgc3RvcmUuc2F2ZU9yZGVyKFMuYWNjb3VudCwgUy5saXN0cywgUy5jb2x1bW5zKS5jYXRjaCgoKSA9PiB7fSk7CiAgfQoKICAvLyDilIDilIAgUmVuZGVyaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiB1cGRhdGVCYXIoKSB7CiAgICBpZiAoIVMubW91bnRlZCkgcmV0dXJuOwogICAgZWxzLmFjY291bnQudGV4dENvbnRlbnQgPSBTLmFjY291bnQgfHwgJ0FjY291bnQgbm90IGRldGVjdGVkJzsKICAgIGVscy5hY2NvdW50LnRpdGxlID0gUy5hY2NvdW50ID8gYEdtYWlsIGFjY291bnQ6ICR7Uy5hY2NvdW50fWAgOiAnJzsKICAgIC8vIFRoZSByZWZyZXNoIGJ1dHRvbiBhbmQgInVwZGF0ZWQg4oCmIiBzcGVhayBmb3Igd2hpY2hldmVyIHRhYiBpcyBvcGVuLgogICAgY29uc3Qgbm90ZXMgPSBTLnZpZXcgPT09ICdub3Rlcyc7CiAgICBjb25zdCBjYWxlbmRhciA9IFMudmlldyA9PT0gJ2NhbGVuZGFyJzsKICAgIGNvbnN0IGxvYWRpbmcgPSBub3RlcyA_IG5zLm5vdGVzLmlzTG9hZGluZygpIDogY2FsZW5kYXIgPyBucy5jYWxlbmRhci5pc0xvYWRpbmcoKSA6ICEhUy5sb2FkaW5nOwogICAgY29uc3QgbG9hZGVkQXQgPSBub3RlcyA_IG5zLm5vdGVzLmxvYWRlZEF0KCkgOiBjYWxlbmRhciA_IG5zLmNhbGVuZGFyLmxvYWRlZEF0KCkgOiBTLmxvYWRlZEF0OwogICAgZWxzLnVwZGF0ZWQudGV4dENvbnRlbnQgPSBsb2FkaW5nID8gJ1VwZGF0aW5n4oCmJwogICAgICA6IGxvYWRlZEF0ID8gYHVwZGF0ZWQgJHt1dGlsLmFnb1RleHQoRGF0ZS5ub3coKSAtIGxvYWRlZEF",
"0KX1gIDogJyc7CiAgICBlbHMucmVmcmVzaC5jbGFzc0xpc3QudG9nZ2xlKCdzcGlubmluZycsIGxvYWRpbmcpOwogICAgZWxzLnJlZnJlc2guZGlzYWJsZWQgPSBsb2FkaW5nIHx8ICFTLmFjY291bnQ7CiAgICBlbHMuc2V0dGluZ3MuaGlkZGVuID0gbm90ZXMgfHwgY2FsZW5kYXI7CiAgICBlbHMuc2V0dGluZ3MuZGlzYWJsZWQgPSBTLnN0YXR1cyAhPT0gJ3JlYWR5JzsKICAgIGZvciAoY29uc3QgdCBvZiBlbHMudGFicy5jaGlsZHJlbikgdC5zZXRBdHRyaWJ1dGUoJ2FyaWEtc2VsZWN0ZWQnLCBTdHJpbmcodC5kYXRhc2V0LnZpZXcgPT09IFMudmlldykpOwogICAgLy8gVGhlIGNhbGVuZGFyJ3Mgc2NyYXRjaHBhZCB0aWxlIGhhcyBhICJTYXZlZCA1cyBhZ28iIG9mIGl0cyBvd24uCiAgICBpZiAobm90ZXMgfHwgY2FsZW5kYXIpIG5zLm5vdGVzLnRpY2soKTsKICAgIGlmIChjYWxlbmRhcikgbnMuY2FsZW5kYXIudGljaygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyKCkgewogICAgaWYgKCFTLm1vdW50ZWQpIHJldHVybjsKICAgIC8vIFJlYnVpbGRpbmcgdGhlIGNvbHVtbnMgbWlkLWRyYWcgd291bGQgcHVsbCB0aGUgY2FyZCBvdXQgZnJvbSB1bmRlcgogICAgLy8gdGhlIHBvaW50ZXIuIFdoYXRldmVyIGNoYW5nZWQgaXMgZHJhd24gb25jZSB0aGUgZHJhZyBlbmRzLgogICAgaWYgKFMuZHJhZykgeyBTLnJlbmRlckRlZmVycmVkID0gdHJ1ZTsgcmV0dXJuOyB9CgogICAgdXBkYXRlQmFyKCk7CiAgICBjbG9zZU1lbnU",
"ocm9vdCk7CgogICAgY29uc3Qga2V5ID0gZm9jdXNLZXkoKTsKICAgIGNvbnN0IHNjcm9sbCA9IGNhcHR1cmVTY3JvbGwoKTsKICAgIC8vIFRoZSBub3RlcyB2aWV3IGhhbmRzIGJhY2sgdGhlIHNhbWUgZWxlbWVudCBldmVyeSB0aW1lOyBwdXR0aW5nIGl0CiAgICAvLyBiYWNrIHdvdWxkIGJsdXIgdGhlIHRleHQgYm94IG1pZC1zZW50ZW5jZSwgc28gaXQgaXMgbGVmdCBpbiBwbGFjZS4KICAgIGNvbnN0IG5leHQgPSByZW5kZXJCb2R5KCk7CiAgICBpZiAoZWxzLmJvZHkuZmlyc3RDaGlsZCAhPT0gbmV4dCB8fCBlbHMuYm9keS5jaGlsZE5vZGVzLmxlbmd0aCAhPT0gMSkgZWxzLmJvZHkucmVwbGFjZUNoaWxkcmVuKG5leHQpOwogICAgcmVzdG9yZVNjcm9sbChzY3JvbGwpOwogICAgcmVzdG9yZUZvY3VzKGtleSwgZWxzLmJvZHkpOwogICAgLy8gVGhlIGZvY3VzZWQgY2FyZCBtYXkgYmUgZ29uZSAocmVtb3ZlZCwgb3IgbW92ZWQgb2ZmIGEgY29sdW1uIHRoYXQKICAgIC8vIHJlLXJlbmRlcmVkKS4gS2VlcCBmb2N1cyBpbiB0aGUgZGlhbG9nIHJhdGhlciB0aGFuIGRyb3BwaW5nIGl0IG9uCiAgICAvLyBHbWFpbCdzIHBhZ2UsIHdoZXJlIHRoZSBuZXh0IGtleSBwcmVzcyB3b3VsZCBiZSBHbWFpbCdzLgogICAgaWYgKGtleSAmJiBTLm9wZW4gJiYgIWVscy5vdmVybGF5LmNvbnRhaW5zKHJvb3QuYWN0aXZlRWxlbWVudCkpIGVscy5vdmVybGF5LmZvY3VzKCk7CiAgfQoKICBmdW5jdGlvbiBmb2N1c0tleSgpIHsKICAgIGN",
"vbnN0IGEgPSByb290LmFjdGl2ZUVsZW1lbnQ7CiAgICByZXR1cm4gYSAmJiBhLmRhdGFzZXQgPyBhLmRhdGFzZXQua2V5IHx8ICcnIDogJyc7CiAgfQoKICBmdW5jdGlvbiByZXN0b3JlRm9jdXMoa2V5LCBzY29wZSkgewogICAgaWYgKCFrZXkpIHJldHVybjsKICAgIGNvbnN0IGVsID0gWy4uLnNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWtleV0nKV0uZmluZCh4ID0-IHguZGF0YXNldC5rZXkgPT09IGtleSk7CiAgICBpZiAoIWVsIHx8IGVsLmRpc2FibGVkKSByZXR1cm47CiAgICBlbC5mb2N1cyh7IHByZXZlbnRTY3JvbGw6IHRydWUgfSk7CiAgICBpZiAoZWwudGFnTmFtZSA9PT0gJ0lOUFVUJyAmJiBlbC50eXBlICE9PSAnY2hlY2tib3gnKSB7CiAgICAgIGNvbnN0IG4gPSBlbC52YWx1ZS5sZW5ndGg7CiAgICAgIHRyeSB7IGVsLnNldFNlbGVjdGlvblJhbmdlKG4sIG4pOyB9IGNhdGNoIHsgLyogbm90IGEgdGV4dCBpbnB1dCAqLyB9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBjYXB0dXJlU2Nyb2xsKCkgewogICAgY29uc3Qgb3V0ID0geyBsZWZ0OiAwLCBsaXN0czoge30gfTsKICAgIGNvbnN0IGNvbHMgPSBlbHMuYm9keS5xdWVyeVNlbGVjdG9yKCcuY29sdW1ucycpOwogICAgaWYgKCFjb2xzKSByZXR1cm4gb3V0OwogICAgb3V0LmxlZnQgPSBjb2xzLnNjcm9sbExlZnQ7CiAgICBmb3IgKGNvbnN0IHNlYyBvZiBjb2xzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2x1bW4nKSkgewogICAgICBjb25zdCBsaXN0ID0",
"gc2VjLnF1ZXJ5U2VsZWN0b3IoJy5saXN0Jyk7CiAgICAgIGlmIChsaXN0KSBvdXQubGlzdHNbc2VjLmRhdGFzZXQuY29sXSA9IGxpc3Quc2Nyb2xsVG9wOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIHJlc3RvcmVTY3JvbGwocykgewogICAgY29uc3QgY29scyA9IGVscy5ib2R5LnF1ZXJ5U2VsZWN0b3IoJy5jb2x1bW5zJyk7CiAgICBpZiAoIWNvbHMpIHJldHVybjsKICAgIGNvbHMuc2Nyb2xsTGVmdCA9IHMubGVmdDsKICAgIGZvciAoY29uc3Qgc2VjIG9mIGNvbHMucXVlcnlTZWxlY3RvckFsbCgnLmNvbHVtbicpKSB7CiAgICAgIGNvbnN0IGxpc3QgPSBzZWMucXVlcnlTZWxlY3RvcignLmxpc3QnKTsKICAgICAgaWYgKGxpc3QgJiYgcy5saXN0c1tzZWMuZGF0YXNldC5jb2xdKSBsaXN0LnNjcm9sbFRvcCA9IHMubGlzdHNbc2VjLmRhdGFzZXQuY29sXTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckJvZHkoKSB7CiAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnICYmICFQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSkgcmV0dXJuIG5zLm5vdGVzLmVsZW1lbnQoKTsKICAgIGlmIChTLnZpZXcgPT09ICdjYWxlbmRhcicgJiYgIVBBTkVMX1NUQVRFUy5oYXMoUy5zdGF0dXMpKSByZXR1cm4gbnMuY2FsZW5kYXIuZWxlbWVudCgpOwogICAgc3dpdGNoIChTLnN0YXR1cykgewogICAgICBjYXNlICdub19hY2NvdW50JzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2JvYXJkJywgJ1doaWNoIGFjY29",
"1bnQgaXMgdGhpcz8nLAogICAgICAgICAgYCR7QVBQX05BTUV9IGNvdWxkbuKAmXQgdGVsbCB3aGljaCBHb29nbGUgYWNjb3VudCB0aGlzIEdtYWlsIHRhYiBiZWxvbmdzIHRvLCBzbyBpdCBkb2VzbuKAmXQga25vdyB3aG9zZSBib2FyZCB0byBzaG93LiBSZWxvYWRpbmcgR21haWwgdXN1YWxseSBzb3J0cyBpdCBvdXQuYCwKICAgICAgICAgIFtdKTsKICAgICAgY2FzZSAnbm90X2NvbmZpZ3VyZWQnOgogICAgICAgIHJldHVybiBwYW5lbCgndHVuZScsICdGaW5pc2ggc2V0dGluZyB1cCcsCiAgICAgICAgICAnQWRkIHlvdXIgT0F1dGggY2xpZW50IElEIG9uIHRoZSBzZXR1cCBwYWdlLiBJdCBpcyBhIG9uZS1vZmYgYW5kIHRha2VzIGEgY291cGxlIG9mIG1pbnV0ZXMuJywKICAgICAgICAgIFtidXR0b24oJ09wZW4gc2V0dXAnLCAncHJpbWFyeScsICgpID0-IGFwaS5vcGVuT3B0aW9ucygpLmNhdGNoKGVyciA9PiB0b2FzdChyb290LCBlcnIubWVzc2FnZSwgeyBraW5kOiAnZXJyb3InIH0pKSldKTsKICAgICAgY2FzZSAnYXV0aF9yZXF1aXJlZCc6CiAgICAgICAgcmV0dXJuIHBhbmVsKCdib2FyZCcsICdDb25uZWN0IEdtYWlsJywKICAgICAgICAgIGBBbGxvdyAke0FQUF9OQU1FfSB0byByZWFkIGFuZCBsYWJlbCBtYWlsIGluICR7Uy5hY2NvdW50fS4gR29vZ2xlIHdpbGwgYXNrIHlvdSB0byBjb25maXJtLmAsCiAgICAgICAgICBbYnV0dG9uKCdDb25uZWN0IEdtYWlsJywgJ3ByaW1hcnknLCBjb25uZWN0KV0pOwogICA",
"gICBjYXNlICdhY2NvdW50X21pc21hdGNoJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2JvYXJkJywgJ1RoYXQgd2FzIGEgZGlmZmVyZW50IGFjY291bnQnLAogICAgICAgICAgYCR7Uy5zdGF0dXNNZXNzYWdlfSBUaGUgYm9hcmQgb25seSBldmVyIGFjdHMgb24gdGhlIG1haWxib3ggb3BlbiBpbiB0aGlzIHRhYi4gQ29ubmVjdCBhZ2FpbiBhbmQgY2hvb3NlICR7Uy5hY2NvdW50fS5gLAogICAgICAgICAgW2J1dHRvbignQ29ubmVjdCBhZ2FpbicsICdwcmltYXJ5JywgY29ubmVjdCldKTsKICAgICAgY2FzZSAnZXJyb3InOgogICAgICAgIHJldHVybiBwYW5lbCgncmVmcmVzaCcsICdDb3VsZG7igJl0IGxvYWQgdGhlIGJvYXJkJywgUy5zdGF0dXNNZXNzYWdlLAogICAgICAgICAgW2J1dHRvbignVHJ5IGFnYWluJywgJ3ByaW1hcnknLCAoKSA9PiByZWZyZXNoKCkpXSk7CiAgICAgIGRlZmF1bHQ6CiAgICAgICAgcmV0dXJuIHJlbmRlckNvbHVtbnMoKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHBhbmVsKGljb25OYW1lLCB0aXRsZSwgdGV4dCwgYWN0aW9ucykgewogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdwYW5lbCcsIHJvbGU6ICdyZWdpb24nLCAnYXJpYS1sYWJlbCc6IHRpdGxlIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncGFuZWwtaWNvbicgfSwgaWNvbihpY29uTmFtZSwgMjgpKSwKICAgICAgaCgnaDInLCB7IHRleHQ6IHRpdGxlIH0pLAogICAgICBoKCdwJywgeyB0ZXh0IH0pLAogICAgICBhY3R",
"pb25zLmxlbmd0aCA_IGgoJ2RpdicsIHsgY2xhc3M6ICdhY3Rpb25zJyB9LCBhY3Rpb25zKSA6IG51bGwpOwogIH0KCiAgZnVuY3Rpb24gYnV0dG9uKGxhYmVsLCBraW5kLCBvbkNsaWNrKSB7CiAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogWydidG4nLCBgYnRuLSR7a2luZH1gXSwgdHlwZTogJ2J1dHRvbicsIHRleHQ6IGxhYmVsLAogICAgICBvbmNsaWNrOiBlID0-IG9uQ2xpY2soZS5jdXJyZW50VGFyZ2V0KSwKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gY29ubmVjdChidG4pIHsKICAgIGlmIChidG4pIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkuY29ubmVjdCgpOwogICAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnKSB7CiAgICAgICAgUy5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgYXdhaXQgbnMubm90ZXMubG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBTLnN0YXR1cyA9ICdsb2FkaW5nJzsKICAgICAgcmVuZGVyKCk7CiAgICAgIGF3YWl0IHJlZnJlc2goKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAoZXJyLmNvZGUgPT09ICdhY2NvdW50X21pc21hdGNoJyB8fCBlcnIuY29kZSA9PT0gJ25vdF9jb25maWd1cmVkJykgewogICAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgICA",
"gcmVuZGVyKCk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdG9hc3Qocm9vdCwgYENvdWxkbuKAmXQgY29ubmVjdDogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgIH0KICAgIH0gZmluYWxseSB7CiAgICAgIGlmIChidG4gJiYgYnRuLmlzQ29ubmVjdGVkKSBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckNvbHVtbnMoKSB7CiAgICBjb25zdCBza2VsZXRvbiA9IFMuc3RhdHVzICE9PSAncmVhZHknOwogICAgY29uc3Qgd3JhcCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjb2x1bW5zJyB9KTsKICAgIGZvciAoY29uc3QgY29sIG9mIFMuY29sdW1ucykgd3JhcC5hcHBlbmRDaGlsZChyZW5kZXJDb2x1bW4oY29sLCBza2VsZXRvbikpOwogICAgd3JhcC5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsIG9uRHJhZ092ZXIpOwogICAgd3JhcC5hZGRFdmVudExpc3RlbmVyKCdkcm9wJywgb25Ecm9wKTsKICAgIHJldHVybiB3cmFwOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQ29sdW1uKGNvbCwgc2tlbGV0b24pIHsKICAgIGNvbnN0IGlkcyA9IFMubGlzdHNbY29sLmlkXSB8fCBbXTsKICAgIGNvbnN0IHNlYXJjaGluZyA9ICEhKFMuc2VhcmNoICYmIFMuc2VhcmNoLmNvbElkID09PSBjb2wuaWQpOwoKICAgIGNvbnN0IGxpc3QgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbGlzdCcsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiBgJHtjb2wudGl0bGV9OiB",
"0aHJlYWRzYCwKICAgICAgJ2RhdGEtZW1wdHknOiAnRHJhZyB0aHJlYWRzIGhlcmUsIG9yIHVzZSArIHRvIGZpbmQgb25lJywKICAgIH0pOwogICAgaWYgKHNrZWxldG9uKSB7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSBsaXN0LmFwcGVuZENoaWxkKGgoJ2RpdicsIHsgY2xhc3M6ICdza2VsZXRvbicsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KSk7CiAgICB9IGVsc2UgewogICAgICBmb3IgKGNvbnN0IGlkIG9mIGlkcykgewogICAgICAgIGNvbnN0IGNhcmQgPSByZW5kZXJDYXJkKGlkLCBjb2wpOwogICAgICAgIGlmIChjYXJkKSBsaXN0LmFwcGVuZENoaWxkKGNhcmQpOwogICAgICB9CiAgICB9CgogICAgY29uc3QgY291bnQgPSBTLnRydW5jYXRlZFtjb2wuaWRdID8gYCR7aWRzLmxlbmd0aH0rYCA6IFN0cmluZyhpZHMubGVuZ3RoKTsKICAgIGNvbnN0IGhlYWQgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY29sLWhlYWQnIH0sCiAgICAgIGgoJ2gyJywgeyBjbGFzczogJ2NvbC10aXRsZScsIHRleHQ6IGNvbC50aXRsZSwgdGl0bGU6IGBHbWFpbCBsYWJlbDogJHtjb2wubGFiZWx9YCB9KSwKICAgICAgc2tlbGV0b24gPyBudWxsIDogaCgnc3BhbicsIHsgY2xhc3M6ICdjb2wtY291bnQnLCB0ZXh0OiBjb3VudCwgJ2FyaWEtbGFiZWwnOiBgJHtjb3VudH0gdGhyZWFkc2AgfSksCiAgICAgIGNvbC5hcmNoaXZlT25Ecm9wID8gaCgnc3BhbicsIHsKICAgICAgICBjbGFzczogJ2NvbC1mbGFnJywgdGV4dDogJ0F",
"yY2hpdmVzJywKICAgICAgICB0aXRsZTogJ01vdmluZyBhIHRocmVhZCBoZXJlIGFsc28gYXJjaGl2ZXMgaXQgKHRha2VzIGl0IG91dCBvZiB0aGUgSW5ib3gpJywKICAgICAgfSkgOiBudWxsLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc3BhY2VyJyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywKICAgICAgICAnYXJpYS1sYWJlbCc6IGBGaW5kIGEgdGhyZWFkIHRvIGFkZCB0byAke2NvbC50aXRsZX1gLCB0aXRsZTogJ0FkZCBmcm9tIEdtYWlsJywKICAgICAgICAnYXJpYS1leHBhbmRlZCc6IFN0cmluZyhzZWFyY2hpbmcpLCBkaXNhYmxlZDogc2tlbGV0b24sCiAgICAgICAgZGF0YXNldDogeyBrZXk6IGBhZGQ6JHtjb2wuaWR9YCwgYWN0aW9uOiAnYWRkJyB9LAogICAgICAgIG9uY2xpY2s6ICgpID0-IHRvZ2dsZVNlYXJjaChjb2wuaWQpLAogICAgICB9LCBpY29uKHNlYXJjaGluZyA_ICdjbG9zZScgOiAnYWRkJykpKTsKCiAgICByZXR1cm4gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdjb2x1bW4nLCAnYXJpYS1sYWJlbCc6IGNvbC50aXRsZSwgZGF0YXNldDogeyBjb2w6IGNvbC5pZCB9IH0sCiAgICAgIGhlYWQsCiAgICAgIFMudHJ1bmNhdGVkW2NvbC5pZF0gPyBoKCdkaXYnLCB7IGNsYXNzOiAnY29sLW5vdGUnLCB0ZXh0OiAnU2hvd2luZyB0aGUgZmlyc3QgMTAwIHRocmVhZHMnIH0pIDogbnVsbCwKICAgICAgc2VhcmNoaW5nID8gcmVuZGV",
"yU2VhcmNoKGNvbCkgOiBudWxsLAogICAgICBsaXN0KTsKICB9CgogIC8vIEEgY2FyZCBzaG93cyB0aGUgdXNlcidzIG93biB0aXRsZSBhbmQgbm90ZSB3aGVuIGl0IGhhcyB0aGVtLiBUaGUKICAvLyBlbWFpbCdzIHN1YmplY3Qgc3RheXMgb25lIGhvdmVyIGF3YXksIHNvIGEgcmVuYW1lZCBjYXJkIGNhbiBhbHdheXMgYmUKICAvLyBtYXRjaGVkIHRvIHRoZSBtYWlsIGJlaGluZCBpdC4KICBmdW5jdGlvbiByZW5kZXJDYXJkKGlkLCBjb2wpIHsKICAgIGNvbnN0IHQgPSBzdG9yZS50aHJlYWQoaWQpOwogICAgaWYgKCF0KSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGRhdGUgPSB1dGlsLnJlbGF0aXZlRGF0ZSh0LnRzKTsKICAgIGNvbnN0IGVkaXQgPSBTLmVkaXRzLmdldChpZCkgfHwgbnVsbDsKICAgIGNvbnN0IHRpdGxlID0gbG9naWMuZGlzcGxheVRpdGxlKHQsIGVkaXQpOwoKICAgIGNvbnN0IG1haW4gPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnY2FyZC1tYWluJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiBgY2FyZDoke2lkfWAgfSwKICAgICAgdGl0bGU6IGVkaXQgJiYgZWRpdC50aXRsZQogICAgICAgID8gYEVtYWlsIHN1YmplY3Q6ICR7dC5zdWJqZWN0fVxuT3BlbiBpbiBHbWFpbCAoQ3RybC1jbGljayBmb3IgYSBuZXcgdGFiKWAKICAgICAgICA6ICdPcGVuIGluIEdtYWlsIChDdHJsLWNsaWNrIGZvciBhIG5ldyB0YWIpJywKICAgICAgb25jbGljazogZSA9PiBvcGVuVGhyZWFkKGlkLCB",
"lKSwKICAgICAgb25hdXhjbGljazogZSA9PiB7IGlmIChlLmJ1dHRvbiA9PT0gMSkgeyBlLnByZXZlbnREZWZhdWx0KCk7IG9wZW5UaHJlYWQoaWQsIHsgY3RybEtleTogdHJ1ZSB9KTsgfSB9LAogICAgfSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdjYXJkLXRvcCcgfSwKICAgICAgICB0LnVucmVhZCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZG90JywgdGl0bGU6ICdVbnJlYWQnIH0pIDogbnVsbCwKICAgICAgICB0LnVucmVhZCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3Itb25seScsIHRleHQ6ICdVbnJlYWQuICcgfSkgOiBudWxsLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZnJvbScsIHRleHQ6IHQuZnJvbSB9KSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RhdGUnLCB0ZXh0OiBkYXRlLCB0aXRsZTogdXRpbC5mdWxsRGF0ZSh0LnRzKSB9KSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3ViamVjdC1yb3cnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdzdWJqZWN0JywgdGV4dDogdGl0bGUgfSksCiAgICAgICAgdC5oYXNEcmFmdCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZHJhZnQnLCB0ZXh0OiAnRHJhZnQnIH0pIDogbnVsbCwKICAgICAgICB0LnN0YXJyZWQgPyBoKCdzcGFuJywgeyBjbGFzczogJ3N0YXInLCB0aXRsZTogJ1N0YXJyZWQnLCAnYXJpYS1sYWJlbCc6ICdTdGFycmVkJyB9LCBpY29uKCdzdGFyJywgMTYpKSA6IG51bGwsCiAgICAgICAgdC5jb3VudCA-IDEgPyBoKCd",
"zcGFuJywgeyBjbGFzczogJ2NvdW50JywgdGV4dDogU3RyaW5nKHQuY291bnQpLCB0aXRsZTogYCR7dC5jb3VudH0gbWVzc2FnZXNgIH0pIDogbnVsbCksCiAgICAgIGVkaXQgJiYgZWRpdC5ub3RlCiAgICAgICAgPyBoKCdzcGFuJywgeyBjbGFzczogJ2NhcmQtbm90ZScgfSwgaCgnc3BhbicsIHsgY2xhc3M6ICdzci1vbmx5JywgdGV4dDogJ05vdGU6ICcgfSksIGVkaXQubm90ZSkKICAgICAgICA6IHQuc25pcHBldCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnc25pcHBldCcsIHRleHQ6IHQuc25pcHBldCB9KSA6IG51bGwpOwoKICAgIGNvbnN0IG1vcmUgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnaWNvbi1idG4gY2FyZC1tZW51JywgdHlwZTogJ2J1dHRvbicsCiAgICAgICdhcmlhLWxhYmVsJzogYE1vcmUgYWN0aW9uczogJHt0aXRsZX1gLCB0aXRsZTogJ01vcmUgYWN0aW9ucycsCiAgICAgICdhcmlhLWhhc3BvcHVwJzogJ21lbnUnLCAnYXJpYS1leHBhbmRlZCc6ICdmYWxzZScsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgbWVudToke2lkfWAgfSwKICAgICAgb25jbGljazogZSA9PiBvcGVuQ2FyZE1lbnUoZS5jdXJyZW50VGFyZ2V0LCBpZCwgY29sLmlkKSwKICAgIH0sIGljb24oJ21vcmUnLCAyMCkpOwoKICAgIGNvbnN0IGNhcmQgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiBbJ2NhcmQnLCB0LnVucmVhZCAmJiAndW5yZWFkJ10sIHJvbGU6ICdsaXN0aXRlbScsIGRyYWdnYWJsZTogJ3RydWUnLAogICAgICB",
"kYXRhc2V0OiBlZGl0ICYmIGVkaXQuY29sb3VyID8geyBpZCwgY29sb3VyOiBlZGl0LmNvbG91ciB9IDogeyBpZCB9LAogICAgfSwgbWFpbiwgbW9yZSk7CiAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIGUgPT4gb25EcmFnU3RhcnQoZSwgaWQsIGNvbC5pZCwgY2FyZCkpOwogICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgb25EcmFnRW5kKTsKICAgIHJldHVybiBjYXJkOwogIH0KCiAgZnVuY3Rpb24gYW5ub3VuY2UobXNnKSB7CiAgICBlbHMubGl2ZS50ZXh0Q29udGVudCA9IG1zZzsKICB9CgogIC8vIOKUgOKUgCBDYXJkIGFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG9wZW5UaHJlYWQoaWQsIGUpIHsKICAgIGlmIChlICYmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuc2hpZnRLZXkpKSB7CiAgICAgIHdpbmRvdy5vcGVuKGhvb2tzLnRocmVhZFVybChpZCksICdfYmxhbmsnLCAnbm9vcGVuZXInKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY2xvc2UoKTsKICAgIGhvb2tzLm9wZW5UaHJlYWQoaWQpOwogIH0KCiAgZnVuY3Rpb24gY29sdW1uT2YoaWQpIHsKICAgIHJldHVybiBTLmNvbHVtbnMuZml",
"uZChjID0-IChTLmxpc3RzW2MuaWRdIHx8IFtdKS5pbmNsdWRlcyhpZCkpIHx8IG51bGw7CiAgfQoKICBmdW5jdGlvbiBjYXJkVGl0bGUoaWQpIHsKICAgIHJldHVybiBsb2dpYy5kaXNwbGF5VGl0bGUoc3RvcmUudGhyZWFkKGlkKSwgUy5lZGl0cy5nZXQoaWQpKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5DYXJkTWVudShhbmNob3IsIGlkLCBjb2xJZCkgewogICAgY29uc3QgbGlzdCA9IFMubGlzdHNbY29sSWRdIHx8IFtdOwogICAgY29uc3QgYXQgPSBsaXN0LmluZGV4T2YoaWQpOwogICAgb3Blbk1lbnUocm9vdCwgYW5jaG9yLCBbCiAgICAgIHsgbGFiZWw6ICdPcGVuIGluIEdtYWlsJywgaWNvbjogJ29wZW4nLCBrZXk6ICdvcGVuJywgb25TZWxlY3Q6ICgpID0-IG9wZW5UaHJlYWQoaWQpIH0sCiAgICAgIHsgbGFiZWw6ICdFZGl0IGNhcmTigKYnLCBpY29uOiAnZWRpdCcsIGtleTogJ2VkaXQnLCBvblNlbGVjdDogKCkgPT4gb3BlbkVkaXRvcihpZCkgfSwKICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgLy8gUmVvcmRlcmluZyBpcyBhIGRyYWcgb3RoZXJ3aXNlOyB0aGVzZSBrZWVwIGl0IHdpdGhpbiByZWFjaCBvZiB0aGUKICAgICAgLy8ga2V5Ym9hcmQuIEZvY3VzIHJldHVybnMgdG8gdGhpcyBjYXJkJ3MgbWVudSBidXR0b24gYWZ0ZXJ3YXJkcywgc28KICAgICAgLy8gcmVwZWF0ZWQgcHJlc3NlcyBrZWVwIG1vdmluZyB0aGUgc2FtZSBjYXJkLgogICAgICB7IGxhYmVsOiAnTW92ZSB1cCcsIGljb246ICd",
"1cCcsIGtleTogJ3VwJywgZGlzYWJsZWQ6IGF0IDw9IDAsIG9uU2VsZWN0OiAoKSA9PiBtb3ZlVGhyZWFkKGlkLCBjb2xJZCwgY29sSWQsIGF0IC0gMSkgfSwKICAgICAgeyBsYWJlbDogJ01vdmUgZG93bicsIGljb246ICdkb3duJywga2V5OiAnZG93bicsIGRpc2FibGVkOiBhdCA8IDAgfHwgYXQgPj0gbGlzdC5sZW5ndGggLSAxLCBvblNlbGVjdDogKCkgPT4gbW92ZVRocmVhZChpZCwgY29sSWQsIGNvbElkLCBhdCArIDEpIH0sCiAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgIHsgaGVhZGluZzogJ01vdmUgdG8nIH0sCiAgICAgIC4uLlMuY29sdW1ucy5tYXAoYyA9PiAoewogICAgICAgIGxhYmVsOiBjLnRpdGxlLAogICAgICAgIGNoZWNrZWQ6IGMuaWQgPT09IGNvbElkLAogICAgICAgIGRpc2FibGVkOiBjLmlkID09PSBjb2xJZCwKICAgICAgICBrZXk6IGBtb3ZlOiR7Yy5pZH1gLAogICAgICAgIG9uU2VsZWN0OiAoKSA9PiBtb3ZlVGhyZWFkKGlkLCBjb2xJZCwgYy5pZCwgMCksCiAgICAgIH0pKSwKICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgeyBsYWJlbDogJ1JlbW92ZSBmcm9tIGJvYXJkJywgaWNvbjogJ3JlbW92ZScsIGRhbmdlcjogdHJ1ZSwga2V5OiAncmVtb3ZlJywgb25TZWxlY3Q6ICgpID0-IHJlbW92ZVRocmVhZChpZCkgfSwKICAgIF0sIHsgbGFiZWw6IGBBY3Rpb25zIGZvciAke2NhcmRUaXRsZShpZCl9YCB9KTsKICB9CgogIC8vIE9wdGltaXN0aWM6IHRoZSBjYXJkIG1vdmV",
"zIG5vdywgYW5kIG9ubHkgdGhpcyBjYXJkIG1vdmVzIGJhY2sgaWYKICAvLyBHbWFpbCByZWZ1c2VzIC0gb3RoZXIgbW92ZXMgbWFkZSBpbiB0aGUgbWVhbnRpbWUgYXJlIGxlZnQgYWxvbmUuCiAgYXN5bmMgZnVuY3Rpb24gbW92ZVRocmVhZChpZCwgZnJvbUNvbCwgdG9Db2wsIGluZGV4KSB7CiAgICBjb25zdCBmcm9tID0gUy5saXN0c1tmcm9tQ29sXSB8fCBbXTsKICAgIGNvbnN0IG9yaWdpbmFsSW5kZXggPSBmcm9tLmluZGV4T2YoaWQpOwoKICAgIGlmIChmcm9tQ29sID09PSB0b0NvbCkgewogICAgICBTLmxpc3RzW3RvQ29sXSA9IGxvZ2ljLnBsYWNlSWQoZnJvbSwgaWQsIGluZGV4KTsKICAgICAgcGVyc2lzdE9yZGVyKCk7CiAgICAgIHJlbmRlcigpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3QgdGFyZ2V0ID0gUy5jb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSB0b0NvbCk7CiAgICBTLmxpc3RzW2Zyb21Db2xdID0gZnJvbS5maWx0ZXIoeCA9PiB4ICE9PSBpZCk7CiAgICBTLmxpc3RzW3RvQ29sXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1t0b0NvbF0sIGlkLCBpbmRleCk7CiAgICBwZXJzaXN0T3JkZXIoKTsKICAgIHJlbmRlcigpOwogICAgYW5ub3VuY2UoYE1vdmVkIHRvICR7dGFyZ2V0LnRpdGxlfSR7dGFyZ2V0LmFyY2hpdmVPbkRyb3AgPyAnIGFuZCBhcmNoaXZlZCcgOiAnJ30uYCk7CgogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUubW92ZVRvQ29sdW1uKGlkLCBTLmNvbHVtbnMsIHRvQ29",
"sLCAnYm9hcmQnKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW3RvQ29sXSA9IChTLmxpc3RzW3RvQ29sXSB8fCBbXSkuZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgICBpZiAoUy5saXN0c1tmcm9tQ29sXSkgUy5saXN0c1tmcm9tQ29sXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1tmcm9tQ29sXSwgaWQsIE1hdGgubWF4KDAsIG9yaWdpbmFsSW5kZXgpKTsKICAgICAgcGVyc2lzdE9yZGVyKCk7CiAgICAgIHJlbmRlcigpOwogICAgICBmYWlsVG9hc3QoJ21vdmUnLCBpZCwgZXJyKTsKICAgIH0KICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJlbW92ZVRocmVhZChpZCkgewogICAgY29uc3QgY29sID0gY29sdW1uT2YoaWQpOwogICAgaWYgKCFjb2wpIHJldHVybjsKICAgIGNvbnN0IG9yaWdpbmFsSW5kZXggPSBTLmxpc3RzW2NvbC5pZF0uaW5kZXhPZihpZCk7CiAgICBTLmxpc3RzW2NvbC5pZF0gPSBTLmxpc3RzW2NvbC5pZF0uZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgcGVyc2lzdE9yZGVyKCk7CiAgICByZW5kZXIoKTsKICAgIGFubm91bmNlKCdSZW1vdmVkIGZyb20gdGhlIGJvYXJkLicpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUucmVtb3ZlRnJvbUJvYXJkKGlkLCBTLmNvbHVtbnMsICdib2FyZCcsIFMuYWNjb3VudCk7CiAgICAgIFMuZWRpdHMuZGVsZXRlKGlkKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW2NvbC5pZF0gPSBsb2dpYy5wbGFjZUlkKFMubGlzdHNbY29",
"sLmlkXSwgaWQsIG9yaWdpbmFsSW5kZXgpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKICAgICAgcmVuZGVyKCk7CiAgICAgIGZhaWxUb2FzdCgncmVtb3ZlJywgaWQsIGVycik7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBmYWlsVG9hc3QodmVyYiwgaWQsIGVycikgewogICAgY29uc3Qgb3B0cyA9IHsga2luZDogJ2Vycm9yJyB9OwogICAgaWYgKGVyci5jb2RlID09PSAnYXV0aF9yZXF1aXJlZCcpIG9wdHMuYWN0aW9uID0geyBsYWJlbDogJ0Nvbm5lY3QnLCBvbkNsaWNrOiAoKSA9PiBjb25uZWN0KCkgfTsKICAgIHRvYXN0KHJvb3QsIGBDb3VsZG7igJl0ICR7dmVyYn0g4oCcJHtzdG9yZS50aHJlYWQoaWQpID8gY2FyZFRpdGxlKGlkKSA6ICd0aGF0IHRocmVhZCd94oCdOiAke2Vyci5tZXNzYWdlfWAsIG9wdHMpOwogIH0KCiAgLy8g4pSA4pSAIERyYWcgYW5kIGRyb3Ag4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG9uRHJhZ1N0YXJ0KGUsIGlkLCBjb2xJZCwgY2FyZCkgewogICAgY2xvc2VNZW51KHJvb3QpOwogICAgY29uc3QgcGxhY2Vob2xkZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAncGxhY2Vob2xkZXInLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSk7CiAgICBwbGF",
"jZWhvbGRlci5zdHlsZS5oZWlnaHQgPSBgJHtjYXJkLm9mZnNldEhlaWdodH1weGA7CiAgICBTLmRyYWcgPSB7IGlkLCBmcm9tQ29sOiBjb2xJZCwgY2FyZCwgcGxhY2Vob2xkZXIgfTsKICAgIGUuZGF0YVRyYW5zZmVyLmVmZmVjdEFsbG93ZWQgPSAnbW92ZSc7CiAgICAvLyBBIHByaXZhdGUgdHlwZSwgc28gZHJvcHBpbmcgYSBjYXJkIG9uIEdtYWlsJ3MgY29tcG9zZSBib3ggZG9lcyBub3QKICAgIC8vIHBhc3RlIGEgdGhyZWFkIGlkIGludG8gYW4gZW1haWwuCiAgICBlLmRhdGFUcmFuc2Zlci5zZXREYXRhKERSQUdfVFlQRSwgaWQpOwogICAgY2FyZC5jbGFzc0xpc3QuYWRkKCdsaWZ0aW5nJyk7CiAgICAvLyBIaWRlIHRoZSBjYXJkIG9ubHkgYWZ0ZXIgdGhlIGJyb3dzZXIgaGFzIGNhcHR1cmVkIGl0IGFzIHRoZSBkcmFnCiAgICAvLyBpbWFnZTsgaGlkaW5nIGl0IHN5bmNocm9ub3VzbHkgY2FuY2VscyB0aGUgZHJhZyBpbiBDaHJvbWUuCiAgICBzZXRUaW1lb3V0KCgpID0-IHsKICAgICAgaWYgKCFTLmRyYWcgfHwgUy5kcmFnLmNhcmQgIT09IGNhcmQpIHJldHVybjsKICAgICAgY2FyZC5wYXJlbnROb2RlLmluc2VydEJlZm9yZShwbGFjZWhvbGRlciwgY2FyZCk7CiAgICAgIGNhcmQuY2xhc3NMaXN0LmFkZCgnZHJhZ2dpbmcnKTsKICAgIH0sIDApOwogIH0KCiAgZnVuY3Rpb24gZHJvcEluZGV4KGxpc3QsIHkpIHsKICAgIGNvbnN0IGNhcmRzID0gWy4uLmxpc3QucXVlcnlTZWxlY3RvckFsbCgnOnNjb3BlID4gLmN",
"hcmQ6bm90KC5kcmFnZ2luZyknKV07CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNhcmRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGNvbnN0IHIgPSBjYXJkc1tpXS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgaWYgKHkgPCByLnRvcCArIHIuaGVpZ2h0IC8gMikgcmV0dXJuIGk7CiAgICB9CiAgICByZXR1cm4gY2FyZHMubGVuZ3RoOwogIH0KCiAgZnVuY3Rpb24gb25EcmFnT3ZlcihlKSB7CiAgICBpZiAoIVMuZHJhZykgcmV0dXJuOwogICAgY29uc3Qgc2VjdGlvbiA9IGUudGFyZ2V0LmNsb3Nlc3QgJiYgZS50YXJnZXQuY2xvc2VzdCgnLmNvbHVtbicpOwogICAgY29uc3QgcGggPSBTLmRyYWcucGxhY2Vob2xkZXI7CiAgICBpZiAoIXNlY3Rpb24pIHsKICAgICAgcGgucmVtb3ZlKCk7CiAgICAgIG1hcmtUYXJnZXQobnVsbCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGUuZGF0YVRyYW5zZmVyLmRyb3BFZmZlY3QgPSAnbW92ZSc7CiAgICBjb25zdCBsaXN0ID0gc2VjdGlvbi5xdWVyeVNlbGVjdG9yKCcubGlzdCcpOwogICAgY29uc3QgaWR4ID0gZHJvcEluZGV4KGxpc3QsIGUuY2xpZW50WSk7CiAgICBjb25zdCBjYXJkcyA9IFsuLi5saXN0LnF1ZXJ5U2VsZWN0b3JBbGwoJzpzY29wZSA-IC5jYXJkOm5vdCguZHJhZ2dpbmcpJyldOwogICAgY29uc3QgcmVmID0gY2FyZHNbaWR4XSB8fCBudWxsOwogICAgaWYgKHJlZikgewogICAgICBpZiAocmVmLnByZXZpb3VzRWx",
"lbWVudFNpYmxpbmcgIT09IHBoKSBsaXN0Lmluc2VydEJlZm9yZShwaCwgcmVmKTsKICAgIH0gZWxzZSBpZiAobGlzdC5sYXN0RWxlbWVudENoaWxkICE9PSBwaCkgewogICAgICBsaXN0LmFwcGVuZENoaWxkKHBoKTsKICAgIH0KICAgIG1hcmtUYXJnZXQoc2VjdGlvbik7CiAgfQoKICBmdW5jdGlvbiBvbkRyb3AoZSkgewogICAgaWYgKCFTLmRyYWcpIHJldHVybjsKICAgIGNvbnN0IHNlY3Rpb24gPSBlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0LmNsb3Nlc3QoJy5jb2x1bW4nKTsKICAgIGlmICghc2VjdGlvbikgcmV0dXJuOwogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgY29uc3QgaWR4ID0gZHJvcEluZGV4KHNlY3Rpb24ucXVlcnlTZWxlY3RvcignLmxpc3QnKSwgZS5jbGllbnRZKTsKICAgIGNvbnN0IHsgaWQsIGZyb21Db2wgfSA9IFMuZHJhZzsKICAgIGVuZERyYWcoZmFsc2UpOwogICAgbW92ZVRocmVhZChpZCwgZnJvbUNvbCwgc2VjdGlvbi5kYXRhc2V0LmNvbCwgaWR4KTsKICB9CgogIGZ1bmN0aW9uIG9uRHJhZ0VuZCgpIHsKICAgIGlmIChTLmRyYWcpIGVuZERyYWcodHJ1ZSk7CiAgfQoKICBmdW5jdGlvbiBlbmREcmFnKGNhbmNlbGxlZCkgewogICAgY29uc3QgZCA9IFMuZHJhZzsKICAgIFMuZHJhZyA9IG51bGw7CiAgICBkLnBsYWNlaG9sZGVyLnJlbW92ZSgpOwogICAgZC5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoJ2RyYWdnaW5nJywgJ2xpZnRpbmcnKTsKICAgIG1hcmtUYXJnZXQobnVsbCk7CiA",
"gICBpZiAoY2FuY2VsbGVkIHx8IFMucmVuZGVyRGVmZXJyZWQpIHsKICAgICAgUy5yZW5kZXJEZWZlcnJlZCA9IGZhbHNlOwogICAgICByZW5kZXIoKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIG1hcmtUYXJnZXQoc2VjdGlvbikgewogICAgZm9yIChjb25zdCBzIG9mIGVscy5ib2R5LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2x1bW4uZHJvcC10YXJnZXQnKSkgewogICAgICBpZiAocyAhPT0gc2VjdGlvbikgcy5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wLXRhcmdldCcpOwogICAgfQogICAgaWYgKHNlY3Rpb24pIHNlY3Rpb24uY2xhc3NMaXN0LmFkZCgnZHJvcC10YXJnZXQnKTsKICB9CgogIC8vIOKUgOKUgCBDb2x1bW4gc2VhcmNoICgiKyIpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBsZXQgc2VhcmNoVGltZXIgPSAwOwoKICBmdW5jdGlvbiB0b2dnbGVTZWFyY2goY29sSWQpIHsKICAgIGlmIChTLnNlYXJjaCAmJiBTLnNlYXJjaC5jb2xJZCA9PT0gY29sSWQpIHsKICAgICAgY2xvc2VTZWFyY2goKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgUy5zZWFyY2ggPSB7IGNvbElkLCBxdWVyeTogJycsIGlkczogbnVsbCwgbG9hZGluZzogZmFsc2UsIGVycm9yOiAnJywgc2VxOiAwIH07CiAgICByZW5kZXIoKTsKICAgIGN",
"vbnN0IGlucHV0ID0gZWxzLmJvZHkucXVlcnlTZWxlY3RvcignLnNlYXJjaCBpbnB1dCcpOwogICAgaWYgKGlucHV0KSBpbnB1dC5mb2N1cygpOwogICAgcnVuU2VhcmNoKCk7CiAgfQoKICBmdW5jdGlvbiBjbG9zZVNlYXJjaCgpIHsKICAgIGlmICghUy5zZWFyY2gpIHJldHVybjsKICAgIGNvbnN0IGNvbElkID0gUy5zZWFyY2guY29sSWQ7CiAgICBTLnNlYXJjaCA9IG51bGw7CiAgICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgcmVuZGVyKCk7CiAgICByZXN0b3JlRm9jdXMoYGFkZDoke2NvbElkfWAsIGVscy5ib2R5KTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclNlYXJjaChjb2wpIHsKICAgIGNvbnN0IHMgPSBTLnNlYXJjaDsKICAgIGNvbnN0IGlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIHR5cGU6ICdzZWFyY2gnLAogICAgICBwbGFjZWhvbGRlcjogJ1NlYXJjaCBtYWlsLCBlLmcuIGZyb206YW5uYSBpczp1bnJlYWQnLAogICAgICAnYXJpYS1sYWJlbCc6IGBTZWFyY2ggR21haWwgZm9yIGEgdGhyZWFkIHRvIGFkZCB0byAke2NvbC50aXRsZX1gLAogICAgICB2YWx1ZTogcy5xdWVyeSwKICAgICAgZGF0YXNldDogeyBrZXk6IGBzZWFyY2g6JHtjb2wuaWR9YCB9LAogICAgICBvbmlucHV0OiBlID0-IHsKICAgICAgICBzLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7CiAgICAgICAgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVyKTsKICAgICAgICBzZWFyY2hUaW1lciA9IHNldFRpbWVvdXQocnVuU2VhcmNoLCA",
"0NTApOwogICAgICB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGNsZWFyVGltZW91dChzZWFyY2hUaW1lcik7IHJ1blNlYXJjaCgpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNsb3NlU2VhcmNoKCk7IH0KICAgICAgfSwKICAgIH0pOwogICAgZWxzLnJlc3VsdHMgPSBoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cycsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiAnU2VhcmNoIHJlc3VsdHMnLCAnYXJpYS1idXN5JzogU3RyaW5nKHMubG9hZGluZykgfSk7CiAgICBmaWxsUmVzdWx0cyh0cnVlKTsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoJywgcm9sZTogJ3NlYXJjaCcgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3NlYXJjaC1ib3gnIH0sIGljb24oJ3NlYXJjaCcsIDE4KSwgaW5wdXQpLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoLWhpbnQnLCB0ZXh0OiAnR21haWwgc2VhcmNoIHN5bnRheC4gTGVhdmUgaXQgZW1wdHkgdG8gbGlzdCB5b3VyIEluYm94LicgfSksCiAgICAgIGVscy5yZXN1bHRzKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJ1blNlYXJjaCgpIHsKICAgIGNvbnN0IHMgPSBTLnNlYXJjaDsKICAgIGlmICghcykgcmV0dXJuOwogICAgY29uc3Qgc2VxID0gKytzLnNlcTs",
"KICAgIHMubG9hZGluZyA9IHRydWU7CiAgICBmaWxsUmVzdWx0cygpOwogICAgdHJ5IHsKICAgICAgY29uc3QgaWRzID0gYXdhaXQgc3RvcmUuc2VhcmNoKHMucXVlcnksIFMuYWNjb3VudCk7CiAgICAgIGlmIChTLnNlYXJjaCAhPT0gcyB8fCBzZXEgIT09IHMuc2VxKSByZXR1cm47CiAgICAgIHMuaWRzID0gaWRzOwogICAgICBzLmVycm9yID0gJyc7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKFMuc2VhcmNoICE9PSBzIHx8IHNlcSAhPT0gcy5zZXEpIHJldHVybjsKICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSB7CiAgICAgICAgaGFuZGxlRXJyb3IoZXJyKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgcy5pZHMgPSBbXTsKICAgICAgcy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgfQogICAgcy5sb2FkaW5nID0gZmFsc2U7CiAgICBmaWxsUmVzdWx0cygpOwogIH0KCiAgLy8gYGJ1aWxkaW5nYCBpcyB0cnVlIHdoaWxlIHRoZSBwYW5lbCBpcyBiZWluZyBjcmVhdGVkIGFuZCBpcyBub3QgeWV0IGluCiAgLy8gdGhlIGRvY3VtZW50OyBvdGhlcndpc2UgYSBkZXRhY2hlZCBib3ggbWVhbnMgYW4gYXN5bmMgc2VhcmNoIGZpbmlzaGVkCiAgLy8gYWZ0ZXIgaXRzIHBhbmVsIHdhcyBjbG9zZWQsIGFuZCB0aGVyZSBpcyBub3RoaW5nIHRvIGZpbGwuCiAgZnVuY3Rpb24gZmlsbFJlc3VsdHMoYnVpbGRpbmcgPSBmYWxzZSkgewogICAgY29uc3QgcyA",
"9IFMuc2VhcmNoOwogICAgY29uc3QgYm94ID0gZWxzLnJlc3VsdHM7CiAgICBpZiAoIXMgfHwgIWJveCB8fCAoIWJ1aWxkaW5nICYmICFib3guaXNDb25uZWN0ZWQpKSByZXR1cm47CiAgICBib3guc2V0QXR0cmlidXRlKCdhcmlhLWJ1c3knLCBTdHJpbmcocy5sb2FkaW5nKSk7CgogICAgaWYgKHMuaWRzID09PSBudWxsIHx8IChzLmxvYWRpbmcgJiYgIXMuaWRzLmxlbmd0aCkpIHsKICAgICAgYm94LnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cy1lbXB0eScsIHRleHQ6ICdTZWFyY2hpbmfigKYnIH0pKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKHMuZXJyb3IpIHsKICAgICAgYm94LnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cy1lbXB0eScsIHRleHQ6IGBTZWFyY2ggZmFpbGVkOiAke3MuZXJyb3J9YCB9KSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmICghcy5pZHMubGVuZ3RoKSB7CiAgICAgIGJveC5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ3Jlc3VsdHMtZW1wdHknLCB0ZXh0OiAnTm8gdGhyZWFkcyBtYXRjaC4nIH0pKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGNvbnN0IHRhcmdldCA9IFMuY29sdW1ucy5maW5kKGMgPT4gYy5pZCA9PT0gcy5jb2xJZCk7CiAgICBib3gucmVwbGFjZUNoaWxkcmVuKC4uLnMuaWRzLm1hcChpZCA9PiB7CiAgICAgIGNvbnN0IHQgPSBzdG9yZS50aHJlYWQoaWQpOwogICAgICBjb25zdCB",
"3aGVyZSA9IGNvbHVtbk9mKGlkKTsKICAgICAgY29uc3QgaGVyZSA9IHdoZXJlICYmIHdoZXJlLmlkID09PSBzLmNvbElkOwogICAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAncmVzdWx0JywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICdsaXN0aXRlbScsIGRpc2FibGVkOiBoZXJlLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgcmVzdWx0OiR7aWR9YCwgaWQgfSwKICAgICAgICB0aXRsZTogaGVyZSA_ICcnIDogYEFkZCB0byAke3RhcmdldCA_IHRhcmdldC50aXRsZSA6ICd0aGlzIGNvbHVtbid9YCwKICAgICAgICBvbmNsaWNrOiAoKSA9PiBhZGRGcm9tU2VhcmNoKGlkLCBzLmNvbElkKSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3ItdG9wJyB9LAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmcm9tJywgdGV4dDogdC5mcm9tIH0pLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkYXRlJywgdGV4dDogdXRpbC5yZWxhdGl2ZURhdGUodC50cykgfSkpLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnci1zdWJqZWN0JywgdGV4dDogbG9naWMuZGlzcGxheVRpdGxlKHQsIFMuZWRpdHMuZ2V0KGlkKSkgfSksCiAgICAgICAgd2hlcmUgPyBoKCdzcGFuJywgeyBjbGFzczogJ3Itd2hlcmUnLCB0ZXh0OiBoZXJlID8gJ0FscmVhZHkgaW4gdGhpcyBjb2x1bW4nIDogYEluICR7d2hlcmU",
"udGl0bGV9IMK3IG1vdmVzIGhlcmVgIH0pIDogbnVsbCk7CiAgICB9KSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBhZGRGcm9tU2VhcmNoKGlkLCBjb2xJZCkgewogICAgY29uc3Qgd2hlcmUgPSBjb2x1bW5PZihpZCk7CiAgICBpZiAod2hlcmUgJiYgd2hlcmUuaWQgPT09IGNvbElkKSByZXR1cm47CiAgICBpZiAod2hlcmUpIHsKICAgICAgbW92ZVRocmVhZChpZCwgd2hlcmUuaWQsIGNvbElkLCAwKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgdGFyZ2V0ID0gUy5jb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSBjb2xJZCk7CiAgICBTLmxpc3RzW2NvbElkXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1tjb2xJZF0sIGlkLCAwKTsKICAgIHBlcnNpc3RPcmRlcigpOwogICAgcmVuZGVyKCk7CiAgICBhbm5vdW5jZShgQWRkZWQgdG8gJHt0YXJnZXQudGl0bGV9LmApOwogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUubW92ZVRvQ29sdW1uKGlkLCBTLmNvbHVtbnMsIGNvbElkLCAnYm9hcmQnKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW2NvbElkXSA9IChTLmxpc3RzW2NvbElkXSB8fCBbXSkuZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKICAgICAgcmVuZGVyKCk7CiAgICAgIGZhaWxUb2FzdCgnYWRkJywgaWQsIGVycik7CiAgICB9CiAgfQoKICAvLyDilIDilIAgQ29sdW1uIHNldHRpbmdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBvcGVuRHJhd2VyKCkgewogICAgaWYgKFMuc3RhdHVzICE9PSAncmVhZHknKSByZXR1cm47CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBTLmRyYXdlciA9IHsKICAgICAgZHJhZnQ6IFMuY29sdW1ucy5tYXAoYyA9PiAoeyAuLi5jLCBvcmlnTGFiZWw6IGMubGFiZWwsIGlzTmV3OiBmYWxzZSwgbGFiZWxUb3VjaGVkOiB0cnVlIH0pKSwKICAgICAgZXJyb3I6ICcnLAogICAgICBzYXZpbmc6IGZhbHNlLAogICAgfTsKICAgIHJlbmRlckRyYXdlcigndGl0bGU6MCcpOwogIH0KCiAgZnVuY3Rpb24gY2xvc2VEcmF3ZXIoKSB7CiAgICBpZiAoIVMuZHJhd2VyKSByZXR1cm47CiAgICBTLmRyYXdlciA9IG51bGw7CiAgICByZW5kZXJEcmF3ZXIoKTsKICAgIGlmIChTLm9wZW4pIGVscy5zZXR0aW5ncy5mb2N1cygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRHJhd2VyKGZvY3VzKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXI7CiAgICBpZiAoIWQpIHsKICAgICAgZWxzLmRyYXdlckxheWVyLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBrZXkgPSBmb2N1cyB8fCBmb2N1c0tleSgpOwoKICAgIGNvbnN0IGRyYXdlciA9IGgoJ2FzaWRlJywgewogICAgICBjbGFzczogJ2R",
"yYXdlcicsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1tb2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6ICdna2ItZHJhd2VyLXRpdGxlJywKICAgIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkcmF3ZXItaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItZHJhd2VyLXRpdGxlJywgdGV4dDogJ0NvbHVtbnMnIH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQ2xvc2UgY29sdW1uIHNldHRpbmdzJywgb25jbGljazogY2xvc2VEcmF3ZXIsCiAgICAgICAgfSwgaWNvbignY2xvc2UnKSkpLAogICAgICBoKCdwJywgewogICAgICAgIGNsYXNzOiAnZHJhd2VyLWludHJvJywKICAgICAgICB0ZXh0OiAnRWFjaCBjb2x1bW4gaXMgYSBHbWFpbCBsYWJlbC4gUmVuYW1pbmcgYSBsYWJlbCBoZXJlIHJlbmFtZXMgaXQgaW4gR21haWwsIHNvIHRoZSBtYWlsIGZpbGVkIHVuZGVyIGl0IHN0YXlzIHB1dC4nLAogICAgICB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RyYXdlci1ib2R5JyB9LAogICAgICAgIGQuZHJhZnQubWFwKChjLCBpKSA9PiByZW5kZXJEcmFmdFJvdyhjLCBpKSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdhZGQtY29sJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiAnYWRkLWNvbCcgfSwgb25jbGljazogYWRkRHJhZnRDb2x1bW4sCiA",
"gICAgICAgfSwgJysgQWRkIGNvbHVtbicpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2Zvcm0tZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBkLmVycm9yIH0pLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZHJhd2VyLWZvb3QnIH0sCiAgICAgICAgaCgnc3BhbicsIHsKICAgICAgICAgIGNsYXNzOiAnbm90ZScsCiAgICAgICAgICB0ZXh0OiAnUmVtb3ZpbmcgYSBjb2x1bW4gb25seSB0YWtlcyBpdCBvZmYgdGhlIGJvYXJkLiBJdHMgR21haWwgbGFiZWwsIGFuZCB0aGUgbWFpbCBpbiBpdCwgYXJlIGxlZnQgdW50b3VjaGVkLicsCiAgICAgICAgfSksCiAgICAgICAgaCgnYnV0dG9uJywgeyBjbGFzczogJ2J0biBidG4tdGV4dCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQ2FuY2VsJywgb25jbGljazogY2xvc2VEcmF3ZXIgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdidG4gYnRuLXByaW1hcnknLCB0eXBlOiAnYnV0dG9uJywgZGlzYWJsZWQ6IGQuc2F2aW5nLCBkYXRhc2V0OiB7IGtleTogJ3NhdmUnIH0sCiAgICAgICAgICB0ZXh0OiBkLnNhdmluZyA_ICdTYXZpbmfigKYnIDogJ1NhdmUnLCBvbmNsaWNrOiBzYXZlRHJhd2VyLAogICAgICAgIH0pKSk7CgogICAgZWxzLmRyYXdlckxheWVyLnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAnc2NyaW0nLCBvbmNsaWNrOiBjbG9zZURyYXdlciB9KSwgZHJhd2VyKTsKICAgIHJlc3RvcmVGb2N1cyhrZXksIGVscy5",
"kcmF3ZXJMYXllcik7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJEcmFmdFJvdyhjLCBpKSB7CiAgICBjb25zdCBuID0gUy5kcmF3ZXIuZHJhZnQubGVuZ3RoOwogICAgY29uc3Qgcm93VGl0bGUgPSBoKCdzcGFuJywgeyBjbGFzczogJ3Jvdy10aXRsZScsIHRleHQ6IGMudGl0bGUgfHwgJ05ldyBjb2x1bW4nIH0pOwogICAgY29uc3QgaGVscCA9IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtaGVscCcgfSk7CiAgICBjb25zdCBzZXRIZWxwID0gKCkgPT4gewogICAgICBoZWxwLnRleHRDb250ZW50ID0gYy5pc05ldwogICAgICAgID8gJ0NyZWF0ZWQgaW4gR21haWwgd2hlbiB5b3Ugc2F2ZS4nCiAgICAgICAgOiBjLmxhYmVsLnRyaW0oKSAhPT0gYy5vcmlnTGFiZWwgPyBgUmVuYW1lcyDigJwke2Mub3JpZ0xhYmVsfeKAnSBpbiBHbWFpbCB3aGVuIHlvdSBzYXZlLmAgOiAnJzsKICAgIH07CiAgICBzZXRIZWxwKCk7CgogICAgY29uc3QgbGFiZWxJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHZhbHVlOiBjLmxhYmVsLCBzcGVsbGNoZWNrOiAnZmFsc2UnLAogICAgICBkYXRhc2V0OiB7IGtleTogYGxhYmVsOiR7aX1gIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBjLmxhYmVsID0gZS50YXJnZXQudmFsdWU7IGMubGFiZWxUb3VjaGVkID0gdHJ1ZTsgc2V0SGVscCgpOyB9LAogICAgfSk7CiAgICBjb25zdCB0aXRsZUlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGN",
"sYXNzOiAndGV4dC1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGMudGl0bGUsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgdGl0bGU6JHtpfWAgfSwKICAgICAgb25pbnB1dDogZSA9PiB7CiAgICAgICAgYy50aXRsZSA9IGUudGFyZ2V0LnZhbHVlOwogICAgICAgIHJvd1RpdGxlLnRleHRDb250ZW50ID0gYy50aXRsZSB8fCAnTmV3IGNvbHVtbic7CiAgICAgICAgLy8gQSBuZXcgY29sdW1uJ3MgbGFiZWwgZm9sbG93cyBpdHMgdGl0bGUgdW50aWwgZWRpdGVkIGJ5IGhhbmQuCiAgICAgICAgaWYgKGMuaXNOZXcgJiYgIWMubGFiZWxUb3VjaGVkKSB7CiAgICAgICAgICBjLmxhYmVsID0gYCR7Yy5yb290fS8ke2MudGl0bGUudHJpbSgpfWA7CiAgICAgICAgICBsYWJlbElucHV0LnZhbHVlID0gYy5sYWJlbDsKICAgICAgICB9CiAgICAgIH0sCiAgICB9KTsKCiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NvbC1yb3cnLCBkYXRhc2V0OiB7IHJvdzogU3RyaW5nKGkpIH0gfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3Jvdy1oZWFkJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncm93LW51bScsIHRleHQ6IFN0cmluZyhpICsgMSkgfSksCiAgICAgICAgcm93VGl0bGUsCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6IGBNb3ZlICR7Yy50aXRsZSB8fCAnY29sdW1uJ30gdXBgLCB0aXRsZTogJ01vdmUgdXA",
"gKGZ1cnRoZXIgbGVmdCBvbiB0aGUgYm9hcmQpJywKICAgICAgICAgIGRpc2FibGVkOiBpID09PSAwLCBkYXRhc2V0OiB7IGtleTogYHVwOiR7aX1gIH0sIG9uY2xpY2s6ICgpID0-IG1vdmVEcmFmdChpLCAtMSksCiAgICAgICAgfSwgaWNvbigndXAnLCAxOCkpLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiBgTW92ZSAke2MudGl0bGUgfHwgJ2NvbHVtbid9IGRvd25gLCB0aXRsZTogJ01vdmUgZG93biAoZnVydGhlciByaWdodCBvbiB0aGUgYm9hcmQpJywKICAgICAgICAgIGRpc2FibGVkOiBpID09PSBuIC0gMSwgZGF0YXNldDogeyBrZXk6IGBkb3duOiR7aX1gIH0sIG9uY2xpY2s6ICgpID0-IG1vdmVEcmFmdChpLCAxKSwKICAgICAgICB9LCBpY29uKCdkb3duJywgMTgpKSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogYFJlbW92ZSAke2MudGl0bGUgfHwgJ2NvbHVtbid9IGZyb20gdGhlIGJvYXJkYCwKICAgICAgICAgIHRpdGxlOiAnUmVtb3ZlIGZyb20gYm9hcmQgKGtlZXBzIHRoZSBHbWFpbCBsYWJlbCknLCBkYXRhc2V0OiB7IGtleTogYHJlbW92ZToke2l9YCB9LAogICAgICAgICAgb25jbGljazogKCkgPT4gcmVtb3ZlRHJhZnQoaSksCiAgICAgICAgfSwgaWNvbignY2xvc2UnLCAxOCkpKSwKICAgICAgaCgnbGF",
"iZWwnLCB7IGNsYXNzOiAnZmllbGQnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmaWVsZC1sYWJlbCcsIHRleHQ6ICdUaXRsZScgfSksCiAgICAgICAgdGl0bGVJbnB1dCksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCB0ZXh0OiAnR21haWwgbGFiZWwnIH0pLAogICAgICAgIGxhYmVsSW5wdXQsCiAgICAgICAgaGVscCksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2NoZWNrJyB9LAogICAgICAgIGgoJ2lucHV0JywgewogICAgICAgICAgdHlwZTogJ2NoZWNrYm94JywgY2hlY2tlZDogISFjLmFyY2hpdmVPbkRyb3AsIGRhdGFzZXQ6IHsga2V5OiBgYXJjaGl2ZToke2l9YCB9LAogICAgICAgICAgb25jaGFuZ2U6IGUgPT4geyBjLmFyY2hpdmVPbkRyb3AgPSBlLnRhcmdldC5jaGVja2VkOyB9LAogICAgICAgIH0pLAogICAgICAgICdBcmNoaXZlIHRocmVhZHMgbW92ZWQgaGVyZSAodGFrZSB0aGVtIG91dCBvZiB0aGUgSW5ib3gpJykpOwogIH0KCiAgZnVuY3Rpb24gbW92ZURyYWZ0KGksIGRlbHRhKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXIuZHJhZnQ7CiAgICBjb25zdCBqID0gaSArIGRlbHRhOwogICAgaWYgKGogPCAwIHx8IGogPj0gZC5sZW5ndGgpIHJldHVybjsKICAgIFtkW2ldLCBkW2pdXSA9IFtkW2pdLCBkW2ldXTsKICAgIC8vIEtlZXAgZm9jdXMgb24gdGhlIHNhbWUgYXJyb3csIG5vdyBvbiB",
"0aGUgcm93J3MgbmV3IHBvc2l0aW9uLCBzbwogICAgLy8gcmVwZWF0ZWQgcHJlc3NlcyBrZWVwIG1vdmluZyB0aGUgc2FtZSBjb2x1bW4uCiAgICBjb25zdCBrZXkgPSBkZWx0YSA8IDAgPyAoaiA9PT0gMCA_IGBkb3duOiR7an1gIDogYHVwOiR7an1gKSA6IChqID09PSBkLmxlbmd0aCAtIDEgPyBgdXA6JHtqfWAgOiBgZG93bjoke2p9YCk7CiAgICByZW5kZXJEcmF3ZXIoa2V5KTsKICB9CgogIGZ1bmN0aW9uIHJlbW92ZURyYWZ0KGkpIHsKICAgIFMuZHJhd2VyLmRyYWZ0LnNwbGljZShpLCAxKTsKICAgIGNvbnN0IG4gPSBTLmRyYXdlci5kcmFmdC5sZW5ndGg7CiAgICByZW5kZXJEcmF3ZXIobiA_IGB0aXRsZToke01hdGgubWluKGksIG4gLSAxKX1gIDogJ2FkZC1jb2wnKTsKICB9CgogIGZ1bmN0aW9uIGFkZERyYWZ0Q29sdW1uKCkgewogICAgY29uc3QgZCA9IFMuZHJhd2VyLmRyYWZ0OwogICAgLy8gVW5kZXIgd2hhdGV2ZXIgcGFyZW50IHRoZSBjb2x1bW5zIGFscmVhZHkgc2hhcmUgKCJfQm9hcmQiLCBvciBvbmUKICAgIC8vIHRoZSB1c2VyIG1vdmVkIHRoZW0gdG8pLCBub3QgYSBoYXJkLWNvZGVkIG9uZS4KICAgIGNvbnN0IHJvb3QgPSBsb2dpYy5sYWJlbFJvb3QoUy5jb2x1bW5zKTsKICAgIGQucHVzaCh7CiAgICAgIGlkOiBsb2dpYy5uZXdDb2x1bW5JZChkKSwKICAgICAgdGl0bGU6ICdOZXcgY29sdW1uJywKICAgICAgbGFiZWw6IGAke3Jvb3R9L05ldyBjb2x1bW5gLAogICAgICByb290LAogICAgICBhcmN",
"oaXZlT25Ecm9wOiBmYWxzZSwKICAgICAgb3JpZ0xhYmVsOiAnJywKICAgICAgaXNOZXc6IHRydWUsCiAgICAgIGxhYmVsVG91Y2hlZDogZmFsc2UsCiAgICB9KTsKICAgIHJlbmRlckRyYXdlcihgdGl0bGU6JHtkLmxlbmd0aCAtIDF9YCk7CiAgICBjb25zdCBpbnB1dCA9IFsuLi5lbHMuZHJhd2VyTGF5ZXIucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEta2V5XScpXS5maW5kKHggPT4geC5kYXRhc2V0LmtleSA9PT0gYHRpdGxlOiR7ZC5sZW5ndGggLSAxfWApOwogICAgaWYgKGlucHV0KSBpbnB1dC5zZWxlY3QoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVEcmF3ZXIoKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXI7CiAgICBjb25zdCB0aWR5ID0gcyA9PiBTdHJpbmcocyB8fCAnJykuc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRyaW0oKSkuam9pbignLycpOwogICAgY29uc3QgY29scyA9IGQuZHJhZnQubWFwKGMgPT4gKHsKICAgICAgaWQ6IGMuaWQsCiAgICAgIHRpdGxlOiBTdHJpbmcoYy50aXRsZSB8fCAnJykudHJpbSgpLAogICAgICBsYWJlbDogdGlkeShjLmxhYmVsKSwKICAgICAgYXJjaGl2ZU9uRHJvcDogISFjLmFyY2hpdmVPbkRyb3AsCiAgICB9KSk7CgogICAgY29uc3QgcHJvYmxlbSA9IGxvZ2ljLnZhbGlkYXRlQ29sdW1ucyhjb2xzKTsKICAgIGlmIChwcm9ibGVtKSB7CiAgICAgIGQuZXJyb3IgPSBwcm9ibGVtOwogICAgICByZW5kZXJEcmF3ZXIoKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGQuc2F",
"2aW5nID0gdHJ1ZTsKICAgIGQuZXJyb3IgPSAnJzsKICAgIHJlbmRlckRyYXdlcignc2F2ZScpOwogICAgY29uc3Qgbm90ZXMgPSBbXTsKCiAgICB0cnkgewogICAgICAvLyBMYWJlbCByZW5hbWVzIGZpcnN0LCBwZXJzaXN0aW5nIGFmdGVyIGVhY2ggb25lLiBJZiBhIGxhdGVyIHN0ZXAKICAgICAgLy8gZmFpbHMsIHRoZSBzYXZlZCBsYXlvdXQgc3RpbGwgbWF0Y2hlcyB3aGF0IEdtYWlsIG5vdyBoYXMsIGluc3RlYWQKICAgICAgLy8gb2YgcG9pbnRpbmcgYXQgYSBsYWJlbCBuYW1lIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cy4KICAgICAgbGV0IHBlcnNpc3RlZCA9IFMuY29sdW1ucy5tYXAoYyA9PiAoeyAuLi5jIH0pKTsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBkLmRyYWZ0Lmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3Qgcm93ID0gZC5kcmFmdFtpXTsKICAgICAgICBjb25zdCBuZXh0ID0gY29sc1tpXTsKICAgICAgICBpZiAocm93LmlzTmV3IHx8ICFyb3cub3JpZ0xhYmVsIHx8IHJvdy5vcmlnTGFiZWwgPT09IG5leHQubGFiZWwpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN0b3JlLnJlbmFtZUxhYmVsKHJvdy5vcmlnTGFiZWwsIG5leHQubGFiZWwpOwogICAgICAgIGlmIChyZXN1bHQgPT09ICdyZXBvaW50ZWQnKSBub3Rlcy5wdXNoKGDigJwke25leHQudGl0bGV94oCdIG5vdyB1c2VzIHRoZSBleGlzdGluZyBsYWJlbCDigJwke25leHQubGFiZWx94oCdLmApOwogICAgICAgIHB",
"lcnNpc3RlZCA9IHBlcnNpc3RlZC5tYXAoYyA9PiAoYy5pZCA9PT0gbmV4dC5pZCA_IHsgLi4uYywgbGFiZWw6IG5leHQubGFiZWwgfSA6IGMpKTsKICAgICAgICBhd2FpdCBzdG9yZS5zYXZlQ29sdW1ucyhTLmFjY291bnQsIHBlcnNpc3RlZCk7CiAgICAgICAgUy5jb2x1bW5zID0gcGVyc2lzdGVkOwogICAgICB9CgogICAgICBhd2FpdCBzdG9yZS5lbnN1cmVMYWJlbHMoY29scy5tYXAoYyA9PiBjLmxhYmVsKSwgeyBmcmVzaDogdHJ1ZSB9KTsKICAgICAgYXdhaXQgc3RvcmUuc2F2ZUNvbHVtbnMoUy5hY2NvdW50LCBjb2xzKTsKICAgICAgUy5jb2x1bW5zID0gY29sczsKICAgICAgUy5kcmF3ZXIgPSBudWxsOwogICAgICByZW5kZXJEcmF3ZXIoKTsKICAgICAgZWxzLnNldHRpbmdzLmZvY3VzKCk7CiAgICAgIHRvYXN0KHJvb3QsIFsnQ29sdW1ucyBzYXZlZC4nLCAuLi5ub3Rlc10uam9pbignICcpKTsKICAgICAgUy5sb2FkZWRBdCA9IDA7CiAgICAgIGF3YWl0IHJlZnJlc2goKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHsKICAgICAgICBTLmRyYXdlciA9IG51bGw7CiAgICAgICAgcmVuZGVyRHJhd2VyKCk7CiAgICAgICAgaGFuZGxlRXJyb3IoZXJyKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgZC5zYXZpbmcgPSBmYWxzZTsKICAgICAgZC5lcnJvciA9IGBDb3VsZG7igJl0IHNhdmU6ICR7ZXJyLm1lc3N",
"hZ2V9YDsKICAgICAgcmVuZGVyRHJhd2VyKCk7CiAgICB9CiAgfQoKICAvLyDilIDilIAgQ2FyZCBlZGl0b3Ig4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUaGUgdXNlcidzIG93biB0aXRsZSwgbm90ZSBhbmQgY29sb3VyIGZvciBvbmUgY2FyZC4gTm9uZSBvZiBpdCByZWFjaGVzCiAgLy8gR21haWw6IHRoZSByZWNvcmQgbGl2ZXMgaW4gc3RvcmFnZS5zeW5jLCBhbmQgdGhlIGVtYWlsIC0gaXRzIHN1YmplY3QsCiAgLy8gaXRzIGxhYmVscywgd2hhdCBjb3JyZXNwb25kZW50cyBzZWUgLSBpcyBleGFjdGx5IGFzIGl0IHdhcy4KCiAgY29uc3QgQ09MT1VSX05BTUVTID0gewogICAgcmVkOiAnUmVkJywgb3JhbmdlOiAnT3JhbmdlJywgeWVsbG93OiAnWWVsbG93JywgZ3JlZW46ICdHcmVlbicsCiAgICBibHVlOiAnQmx1ZScsIHB1cnBsZTogJ1B1cnBsZScsIGdyZXk6ICdHcmV5JywKICB9OwoKICBmdW5jdGlvbiBvcGVuRWRpdG9yKGlkKSB7CiAgICBjb25zdCB0ID0gc3RvcmUudGhyZWFkKGlkKTsKICAgIGlmICghdCB8fCBTLnN0YXR1cyAhPT0gJ3JlYWR5JykgcmV0dXJuOwogICAgY2xvc2VNZW51KHJvb3QpOwogICAgY29uc3QgZWRpdCA9IFMuZWRpdHMuZ2V",
"0KGlkKSB8fCB7fTsKICAgIFMuZWRpdG9yID0gewogICAgICBpZCwKICAgICAgc3ViamVjdDogdC5zdWJqZWN0LAogICAgICAvLyBQcmUtZmlsbGVkIHdpdGggdGhlIHN1YmplY3QgcmF0aGVyIHRoYW4gbGVmdCBibGFuaywgYmVjYXVzZSB0aGUKICAgICAgLy8gdXN1YWwgZWRpdCBpcyB0cmltbWluZyBhIGxvbmcgc3ViamVjdCBkb3duLCBub3Qgc3RhcnRpbmcgYWZyZXNoLgogICAgICBkcmFmdDogeyB0aXRsZTogZWRpdC50aXRsZSB8fCB0LnN1YmplY3QsIG5vdGU6IGVkaXQubm90ZSB8fCAnJywgY29sb3VyOiBlZGl0LmNvbG91ciB8fCAnJyB9LAogICAgICBlcnJvcjogJycsCiAgICAgIHNhdmluZzogZmFsc2UsCiAgICB9OwogICAgcmVuZGVyRWRpdG9yKCdlZGl0LXRpdGxlJyk7CiAgICBjb25zdCBpbnB1dCA9IGVscy5lZGl0b3JMYXllci5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9ImVkaXQtdGl0bGUiXScpOwogICAgaWYgKGlucHV0KSBpbnB1dC5zZWxlY3QoKTsKICB9CgogIGZ1bmN0aW9uIGNsb3NlRWRpdG9yKCkgewogICAgaWYgKCFTLmVkaXRvcikgcmV0dXJuOwogICAgY29uc3QgaWQgPSBTLmVkaXRvci5pZDsKICAgIFMuZWRpdG9yID0gbnVsbDsKICAgIHJlbmRlckVkaXRvcigpOwogICAgaWYgKFMub3BlbikgcmVzdG9yZUZvY3VzKGBtZW51OiR7aWR9YCwgZWxzLmJvZHkpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRWRpdG9yKGZvY3VzKSB7CiAgICBjb25zdCBlZCA9IFMuZWRpdG9yOwogICAgaWYgKCF",
"lZCkgewogICAgICBlbHMuZWRpdG9yTGF5ZXIucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGtleSA9IGZvY3VzIHx8IGZvY3VzS2V5KCk7CiAgICBjb25zdCBkID0gZWQuZHJhZnQ7CgogICAgY29uc3QgcmVzZXQgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnbGluay1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1VzZSB0aGUgZW1haWwgc3ViamVjdCcsIGRhdGFzZXQ6IHsga2V5OiAnZWRpdC1yZXNldCcgfSwKICAgICAgb25jbGljazogKCkgPT4gewogICAgICAgIGQudGl0bGUgPSBlZC5zdWJqZWN0OwogICAgICAgIHRpdGxlSW5wdXQudmFsdWUgPSBlZC5zdWJqZWN0OwogICAgICAgIHN5bmNSZXNldCgpOwogICAgICAgIHRpdGxlSW5wdXQuZm9jdXMoKTsKICAgICAgfSwKICAgIH0pOwogICAgY29uc3Qgc3luY1Jlc2V0ID0gKCkgPT4gewogICAgICBjb25zdCB2ID0gZC50aXRsZS50cmltKCk7CiAgICAgIHJlc2V0LmhpZGRlbiA9ICF2IHx8IHYgPT09IGVkLnN1YmplY3QudHJpbSgpOwogICAgfTsKCiAgICBjb25zdCB0aXRsZUlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGQudGl0bGUsIG1heGxlbmd0aDogU3RyaW5nKGxvZ2ljLk1BWF9USVRMRSksCiAgICAgIHBsYWNlaG9sZGVyOiBlZC5zdWJqZWN0LCAnYXJpYS1kZXNjcmliZWRieSc6ICdna2ItZWRpdC1zdWJqZWN0JywgZGF0YXN",
"ldDogeyBrZXk6ICdlZGl0LXRpdGxlJyB9LAogICAgICBvbmlucHV0OiBlID0-IHsgZC50aXRsZSA9IGUudGFyZ2V0LnZhbHVlOyBzeW5jUmVzZXQoKTsgfSwKICAgICAgb25rZXlkb3duOiBlID0-IHsgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFlLmlzQ29tcG9zaW5nKSB7IGUucHJldmVudERlZmF1bHQoKTsgc2F2ZUVkaXRvcigpOyB9IH0sCiAgICB9KTsKICAgIHN5bmNSZXNldCgpOwoKICAgIGNvbnN0IG5vdGVJbnB1dCA9IGgoJ3RleHRhcmVhJywgewogICAgICBjbGFzczogWyd0ZXh0LWlucHV0JywgJ3RleHQtYXJlYSddLCByb3dzOiAnMycsIG1heGxlbmd0aDogU3RyaW5nKGxvZ2ljLk1BWF9OT1RFKSwgdmFsdWU6IGQubm90ZSwKICAgICAgcGxhY2Vob2xkZXI6ICdPcHRpb25hbC4gU2hvd24gb24gdGhlIGNhcmQgaW4gcGxhY2Ugb2YgdGhlIGVtYWlsIHByZXZpZXcuJywKICAgICAgZGF0YXNldDogeyBrZXk6ICdlZGl0LW5vdGUnIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBkLm5vdGUgPSBlLnRhcmdldC52YWx1ZTsgfSwKICAgICAgLy8gRW50ZXIgaXMgYSBuZXcgbGluZSBpbiBhIG5vdGU7IEN0cmwrRW50ZXIgc2F2ZXMsIGFzIGluIEdtYWlsJ3MgY29tcG9zZS4KICAgICAgb25rZXlkb3duOiBlID0-IHsgaWYgKGUua2V5ID09PSAnRW50ZXInICYmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5KSkgeyBlLnByZXZlbnREZWZhdWx0KCk7IHNhdmVFZGl0b3IoKTsgfSB9LAogICAgfSk7CgogICAgY29uc3Qgc3d",
"hdGNoZXMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnc3dhdGNoZXMnLCByb2xlOiAncmFkaW9ncm91cCcsICdhcmlhLWxhYmVsbGVkYnknOiAnZ2tiLWVkaXQtY29sb3VyJyB9LAogICAgICBbJycsIC4uLmxvZ2ljLkNBUkRfQ09MT1VSU10ubWFwKGMgPT4gewogICAgICAgIGNvbnN0IG5hbWUgPSBjID8gQ09MT1VSX05BTUVTW2NdIDogJ05vIGNvbG91cic7CiAgICAgICAgcmV0dXJuIGgoJ2xhYmVsJywgeyBjbGFzczogJ3N3YXRjaCcsIHRpdGxlOiBuYW1lLCBkYXRhc2V0OiB7IGNvbG91cjogYyB8fCAnbm9uZScgfSB9LAogICAgICAgICAgaCgnaW5wdXQnLCB7CiAgICAgICAgICAgIHR5cGU6ICdyYWRpbycsIG5hbWU6ICdna2ItY2FyZC1jb2xvdXInLCB2YWx1ZTogYywgY2hlY2tlZDogZC5jb2xvdXIgPT09IGMsICdhcmlhLWxhYmVsJzogbmFtZSwKICAgICAgICAgICAgZGF0YXNldDogeyBrZXk6IGBlZGl0LWNvbG91cjoke2MgfHwgJ25vbmUnfWAgfSwKICAgICAgICAgICAgb25jaGFuZ2U6ICgpID0-IHsgZC5jb2xvdXIgPSBjOyB9LAogICAgICAgICAgfSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3N3YXRjaC1kb3QnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSkpOwogICAgICB9KSk7CgogICAgY29uc3QgZGlhbG9nID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ2RpYWxvZycsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1tb2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6ICdna2ItZWRpdC1oZWF",
"kaW5nJywKICAgIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2ctaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItZWRpdC1oZWFkaW5nJywgdGV4dDogJ0VkaXQgY2FyZCcgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDbG9zZSB3aXRob3V0IHNhdmluZycsIG9uY2xpY2s6IGNsb3NlRWRpdG9yLAogICAgICAgIH0sIGljb24oJ2Nsb3NlJykpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1ib2R5JyB9LAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWVkaXQtdGl0bGUnLCB0ZXh0OiAnVGl0bGUgb24gdGhlIGJvYXJkJyB9KSwKICAgICAgICAgIE9iamVjdC5hc3NpZ24odGl0bGVJbnB1dCwgeyBpZDogJ2drYi1lZGl0LXRpdGxlJyB9KSwKICAgICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdoZWxwLXJvdycsIGlkOiAnZ2tiLWVkaXQtc3ViamVjdCcgfSwKICAgICAgICAgICAgaCgnc3BhbicsIHt9LCAnRW1haWwgc3ViamVjdDogJywgaCgnc3BhbicsIHsgY2xhc3M6ICdzdWJqZWN0LXJlZicsIHRleHQ6IGVkLnN1YmplY3QgfSkpLAogICAgICAgICAgICByZXNldCkpLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGg",
"oJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWVkaXQtbm90ZScsIHRleHQ6ICdOb3RlJyB9KSwKICAgICAgICAgIE9iamVjdC5hc3NpZ24obm90ZUlucHV0LCB7IGlkOiAnZ2tiLWVkaXQtbm90ZScgfSkpLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCBpZDogJ2drYi1lZGl0LWNvbG91cicsIHRleHQ6ICdDb2xvdXInIH0pLAogICAgICAgICAgc3dhdGNoZXMpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2Zvcm0tZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBlZC5lcnJvciB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1mb290JyB9LAogICAgICAgIGgoJ3NwYW4nLCB7CiAgICAgICAgICBjbGFzczogJ25vdGUnLAogICAgICAgICAgdGV4dDogJ09ubHkgdGhlIGJvYXJkIGNoYW5nZXMuIFRoZSBlbWFpbCBpdHNlbGYsIGFuZCB3aGF0IG90aGVycyBzZWUsIHN0YXkgYXMgdGhleSBhcmUuJywKICAgICAgICB9KSwKICAgICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiBjbG9zZUVkaXRvciB9KSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2J0biBidG4tcHJpbWFyeScsIHR5cGU6ICdidXR0b24nLCBkaXNhYmxlZDogZWQuc2F2aW5nLCBkYXR",
"hc2V0OiB7IGtleTogJ2VkaXQtc2F2ZScgfSwKICAgICAgICAgIHRleHQ6ICdTYXZlJywgb25jbGljazogc2F2ZUVkaXRvciwKICAgICAgICB9KSkpOwoKICAgIGVscy5lZGl0b3JMYXllci5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ3NjcmltJywgb25jbGljazogY2xvc2VFZGl0b3IgfSksIGRpYWxvZyk7CiAgICByZXN0b3JlRm9jdXMoa2V5LCBlbHMuZWRpdG9yTGF5ZXIpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUVkaXRvcigpIHsKICAgIGNvbnN0IGVkID0gUy5lZGl0b3I7CiAgICBpZiAoIWVkIHx8IGVkLnNhdmluZykgcmV0dXJuOwogICAgY29uc3QgZWRpdCA9IGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KGVkLmRyYWZ0LCBlZC5zdWJqZWN0KTsKICAgIGVkLnNhdmluZyA9IHRydWU7CiAgICBjb25zdCBzYXZlID0gZWxzLmVkaXRvckxheWVyLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0iZWRpdC1zYXZlIl0nKTsKICAgIGlmIChzYXZlKSBzYXZlLmRpc2FibGVkID0gdHJ1ZTsKCiAgICB0cnkgewogICAgICBhd2FpdCBzdG9yZS5zYXZlQ2FyZEVkaXQoUy5hY2NvdW50LCBlZC5pZCwgZWRpdCk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKFMuZWRpdG9yICE9PSBlZCkgcmV0dXJuOwogICAgICBlZC5zYXZpbmcgPSBmYWxzZTsKICAgICAgZWQuZXJyb3IgPSBgQ291bGRu4oCZdCBzYXZlOiAke2Vyci5tZXNzYWdlfWA7CiAgICAgIHJlbmRlckVkaXRvcignZWRpdC1zYXZlJyk7CiA",
"gICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAoZWRpdCkgUy5lZGl0cy5zZXQoZWQuaWQsIGVkaXQpOwogICAgZWxzZSBTLmVkaXRzLmRlbGV0ZShlZC5pZCk7CiAgICBpZiAoUy5lZGl0b3IgPT09IGVkKSBTLmVkaXRvciA9IG51bGw7CiAgICByZW5kZXJFZGl0b3IoKTsKICAgIHJlbmRlcigpOwogICAgcmVzdG9yZUZvY3VzKGBtZW51OiR7ZWQuaWR9YCwgZWxzLmJvZHkpOwogICAgYW5ub3VuY2UoZWRpdCA_ICdDYXJkIHVwZGF0ZWQuJyA6ICdDYXJkIGJhY2sgdG8gc2hvd2luZyB0aGUgZW1haWwuJyk7CiAgfQoKICAvLyDilIDilIAgRXh0ZXJuYWwgY2hhbmdlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gQ29sdW1ucyBlZGl0ZWQgaW4gYW5vdGhlciB0YWIgb3Igb24gYW5vdGhlciBjb21wdXRlciAoc3RvcmFnZS5zeW5jKS4KICAvLyBUaGlzIHRhYidzIG93biBzYXZlcyBlY2hvIGJhY2sgaGVyZSB0b287IHRob3NlIGFyZSBhbHJlYWR5IG9uIHNjcmVlbi4KICBmdW5jdGlvbiBjb2x1bW5zQ2hhbmdlZChuZXh0KSB7CiAgICBpZiAobmV4dCAmJiBKU09OLnN0cmluZ2lmeShuZXh0KSA9PT0gSlNPTi5zdHJpbmdpZnkoUy5jb2x1bW5zKSkgcmV0dXJuOwogICAgUy5sb2FkZWRBdCA9IDA7CiA",
"gICBpZiAoUy5vcGVuICYmICFTLmRyYXdlciAmJiBTLnZpZXcgPT09ICdib2FyZCcpIHJlZnJlc2goKTsKICB9CgogIC8vIENhcmQgZWRpdHMgc2F2ZWQgaW4gYW5vdGhlciB0YWIsIG9yIHN5bmNlZCBmcm9tIGFub3RoZXIgY29tcHV0ZXIuCiAgLy8gVGhpcyB0YWIncyBvd24gc2F2ZXMgZWNobyBiYWNrIGhlcmUgYXMgd2VsbDsgdGhvc2UgYXJlIGFscmVhZHkgZHJhd24sCiAgLy8gYW5kIHJlZHJhd2luZyBmb3IgdGhlbSB3b3VsZCBjbG9zZSBhIG1lbnUgb3BlbmVkIGluIHRoZSBtZWFudGltZS4KICBmdW5jdGlvbiBjYXJkRWRpdHNDaGFuZ2VkKGNoYW5nZXMsIHByZWZpeCkgewogICAgbGV0IGNoYW5nZWQgPSBmYWxzZTsKICAgIGZvciAoY29uc3QgW2tleSwgY2hhbmdlXSBvZiBPYmplY3QuZW50cmllcyhjaGFuZ2VzKSkgewogICAgICBpZiAoIWtleS5zdGFydHNXaXRoKHByZWZpeCkpIGNvbnRpbnVlOwogICAgICBjb25zdCBpZCA9IGtleS5zbGljZShwcmVmaXgubGVuZ3RoKTsKICAgICAgY29uc3QgbmV4dCA9IGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KGNoYW5nZSAmJiBjaGFuZ2UubmV3VmFsdWUpOwogICAgICBpZiAoSlNPTi5zdHJpbmdpZnkobmV4dCkgPT09IEpTT04uc3RyaW5naWZ5KFMuZWRpdHMuZ2V0KGlkKSB8fCBudWxsKSkgY29udGludWU7CiAgICAgIGlmIChuZXh0KSBTLmVkaXRzLnNldChpZCwgbmV4dCk7CiAgICAgIGVsc2UgUy5lZGl0cy5kZWxldGUoaWQpOwogICAgICBjaGFuZ2VkID0gdHJ1ZTs",
"KICAgIH0KICAgIGlmIChjaGFuZ2VkICYmIFMub3BlbiAmJiBTLnN0YXR1cyA9PT0gJ3JlYWR5JyAmJiBTLnZpZXcgPT09ICdib2FyZCcpIHJlbmRlcigpOwogIH0KCiAgbnMuYm9hcmQgPSB7CiAgICBvcGVuLCBjbG9zZSwgdG9nZ2xlLCB0b2dnbGVWaWV3LCBjb2x1bW5zQ2hhbmdlZCwgY2FyZEVkaXRzQ2hhbmdlZCwKICAgIGlzT3BlbjogKCkgPT4gUy5vcGVuLAogICAgLy8gRm9yIHRoZSBwaG9uZSBhcHA6IHdoYXQgaXMgc2hvd2luZywgYW5kIGEgcmVmcmVzaCBpZiBpdCBpcyBzdGFsZS4KICAgIHZpZXc6ICgpID0-IFMudmlldywKICAgIHJlZnJlc2hJZlN0YWxlKCkgewogICAgICBpZiAoUy5vcGVuICYmIFMudmlldyA9PT0gJ2JvYXJkJyAmJiBEYXRlLm5vdygpIC0gUy5sb2FkZWRBdCA-IFNUQUxFX01TKSByZWZyZXNoKCk7CiAgICB9LAogIH07Cn0pKCk7Cg\"],[\"addon/app/shell.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAKLy8KLy8gVGhlIGV4dGVuc2lvbidzIGJvYXJkLCBOb3RlcyBhbmQgQ2FsZW5kYXIsIGZ1bGwtc2NyZWVuLCBhcyB0aGU",
"gYXBwCi8vIGl0c2VsZjogdGhlIHNhbWUgdGFicywgY29sdW1ucywgY2FyZHMsIG5vdGVzLCBzZWFyY2gsIGVkaXRvciwgYXV0b3NhdmUKLy8gYW5kIGNhbGVuZGFyLCB3aXRoIHRoZSBib2FyZCdzIHN0eWxlcyBhbmQgYSBwaG9uZSBsYXlvdXQgb24gdG9wLiBPbiBhCi8vIHBob25lIHRoZSBib2FyZCBzaG93cyBvbmUgY29sdW1uIGF0IGEgdGltZSwgc3dpcGVkIHNpZGV3YXlzOyB0aGUgbm90ZXMKLy8gb3BlbiBvbiB0aGUgU2NyYXRjaHBhZCwgdW5kZXIgdGhlIHNlYXJjaCBib3g7IGEgZm9sZGVyIG9yIGEgc2VhcmNoCi8vIHNob3dzIHRoZSBsaXN0IGluc3RlYWQsIGFuZCBhIG5vdGUgb3BlbnMgZnVsbC1zY3JlZW47IHRoZSBjYWxlbmRhciBpcwovLyB0aGUgd2VlayBhcyB0d28gY29sdW1ucyBvZiBkYXlzLCBzd2lwZWQgdG8gdGhlIG5leHQgd2Vlay4gQSBmaXJzdCB2aXNpdCBvcGVucyBvbiB0aGUKLy8gbm90ZXM7IGFmdGVyIHRoYXQsIG9uIHdoaWNoZXZlciB0YWIgd2FzIHVzZWQgbGFzdC4KLy8KLy8gQSBwaG9uZSBsZWF2ZXMgcGFnZXMgd2l0aG91dCBjbG9zaW5nIHRoZW0sIHNvIHdoYXRldmVyIGlzIHBlbmRpbmcgaXMKLy8gc2F2ZWQgd2hlbmV2ZXIgdGhlIHBhZ2UgaXMgaGlkZGVuOyBhbmQgQW5kcm9pZCdzIGJhY2sgZ2VzdHVyZSBzdGVwcwovLyBiYWNrIHRocm91Z2ggdGhlIG5vdGVzIC0gYSBub3RlIHRvIHRoZSBsaXN0LCB0aGUgbGlzdCB0byB0aGUKLy8gU2NyYXRjaHBhZCAtIHRocm91Z2ggZ29vZ2x",
"lLnNjcmlwdC5oaXN0b3J5LgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB7IG1vdW50U2hhZG93IH0gPSBucy51aTsKCiAgLy8gSG93IGxvbmcgb3BlbmluZyB0b29rLCBmb3IgZmluZGluZyBvdXQgd2hhdCBpcyBzbG93ICh0aGUgbG9nbydzIG1lbnUsCiAgLy8gdW5kZXIgQWR2YW5jZWQpOiBmcm9tIHRoaXMgcGFnZSdzIHN0YXJ0LCB3aGljaCBjb21lcyBhZnRlciBHb29nbGUncwogIC8vIG93biBwYWdlIGFyb3VuZCBpdC4KICBjb25zdCBtYXJrcyA9IHsgY29kZTogcGVyZm9ybWFuY2Uubm93KCkgfTsKICBjb25zdCBtYXJrID0gbmFtZSA9PiB7IGlmICghKG5hbWUgaW4gbWFya3MpKSBtYXJrc1tuYW1lXSA9IHBlcmZvcm1hbmNlLm5vdygpOyB9OwogIGNvbnN0IHNlY3MgPSBtcyA9PiBgJHsobXMgLyAxMDAwKS50b0ZpeGVkKDEpfSBzYDsKICBmdW5jdGlvbiB0aW1pbmdUZXh0KCkgewogICAgY29uc3QgcGFydHMgPSBbYHB",
"hZ2UgYW5kIGNvZGUgJHtzZWNzKG1hcmtzLmNvZGUpfWBdOwogICAgaWYgKCdyZWFkeScgaW4gbWFya3MpIHBhcnRzLnB1c2goYHJlYWR5IHRvIHR5cGUgJHtzZWNzKG1hcmtzLnJlYWR5KX1gKTsKICAgIGlmICgnY2hlY2tlZCcgaW4gbWFya3MpIHBhcnRzLnB1c2goYGNoZWNrZWQgd2l0aCBHbWFpbCAke3NlY3MobWFya3MuY2hlY2tlZCl9YCk7CiAgICBpZiAoJ2xpc3RlZCcgaW4gbWFya3MpIHBhcnRzLnB1c2goYGxpc3QgdXAgdG8gZGF0ZSAke3NlY3MobWFya3MubGlzdGVkKX1gKTsKICAgIHJldHVybiBgT3BlbmVkIGluICR7c2VjcyhtYXJrcy5yZWFkeSB8fCBtYXJrcy5jb2RlKX06ICR7cGFydHMuam9pbignLCAnKX0uYDsKICB9CgogIGNvbnN0IFBIT05FID0gYAo6aG9zdCB7IHBvc2l0aW9uOiBmaXhlZCAhaW1wb3J0YW50OyBpbnNldDogMCAhaW1wb3J0YW50OyB9Ci5vdmVybGF5IHsgcGFkZGluZzogZW52KHNhZmUtYXJlYS1pbnNldC10b3ApIGVudihzYWZlLWFyZWEtaW5zZXQtcmlnaHQpIGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSBlbnYoc2FmZS1hcmVhLWluc2V0LWxlZnQpOyB9CgpAbWVkaWEgKG1heC13aWR0aDogNzYwcHgpIHsKICAvKiBUaGUgaGVhZGVyOiB0aGUgbWFyaywgdGhlIHRocmVlIHRhYnMsIHJlZnJlc2ggYW5kIHRoZSBjb2x1bW4KICAgICBzZXR0aW5nczsgZ29uZSB3aGlsZSBhIG5vdGUgaGFzIHRoZSB3aG9sZSBzY3JlZW4uIE9uIGEgc21hbGwgcGhvbmUKICAgICBvbmx5IHRoZSB",
"vcGVuIHRhYiBzYXlzIGl0cyBuYW1lLiAqLwogIC5iYXIgeyBoZWlnaHQ6IDU2cHg7IHBhZGRpbmc6IDAgNHB4IDAgMTJweDsgZ2FwOiAycHg7IH0KICAuYnJhbmQtYnRuID4gc3Bhbjpub3QoLmxvZ28pLCAuYWNjb3VudCwgLnVwZGF0ZWQgeyBkaXNwbGF5OiBub25lOyB9CiAgLnRhYnMgeyBtYXJnaW4tbGVmdDogMTBweDsgbWluLXdpZHRoOiAwOyB9CiAgLnRhYiB7IHBhZGRpbmc6IDAgMTJweCAwIDEwcHg7IH0KICA6aG9zdChbZGF0YS12aWV3PSJub3RlIl0pIC5iYXIgeyBkaXNwbGF5OiBub25lOyB9CgogIC8qIFRoZSBib2FyZDogb25lIGNvbHVtbiB0byBhIHNjcmVlbiwgc3dpcGVkIHNpZGV3YXlzLiBDYXJkcyBtb3ZlIHdpdGgKICAgICB0aGVpciDii68gbWVudSwgc2luY2UgYSBmaW5nZXIgY2Fubm90IGRyYWcgdGhlbS4gKi8KICAuY29sdW1ucyB7IHNjcm9sbC1zbmFwLXR5cGU6IHggbWFuZGF0b3J5OyBnYXA6IDEwcHg7IHBhZGRpbmc6IDRweCAxNnB4IDEycHg7IHNjcm9sbC1wYWRkaW5nOiAwIDE2cHg7IH0KICAuY29sdW1uIHsgZmxleDogMCAwIGNhbGMoMTAwdncgLSA0NHB4KTsgbWluLXdpZHRoOiAwOyBtYXgtd2lkdGg6IG5vbmU7IHNjcm9sbC1zbmFwLWFsaWduOiBjZW50ZXI7IH0KCiAgLm5vdGVzIHsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAwOyBwYWRkaW5nOiAwOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0ibm90ZSJdIC5ub3Rlcy1mb2xkZXJzLCAubm90ZXNbZGF0YS12aWV3PSJub3RlIl0",
"gLm5vdGVzLWxpc3QgeyBkaXNwbGF5OiBub25lOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0ibGlzdCJdIC5ub3RlLWVkaXRvciB7IGRpc3BsYXk6IG5vbmU7IH0KCiAgLyogSG9tZTogdGhlIHNlYXJjaCBib3gsIGFuZCB0aGUgc2NyYXRjaHBhZCBmaWxsaW5nIHRoZSByZXN0LiAqLwogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubm90ZXMtbGlzdCB7IGZsZXg6IG5vbmU7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5vdGVzLXNjb3BlLCAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5vdGVzLWl0ZW1zLCAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5vdGVzLWZvb3QgeyBkaXNwbGF5OiBub25lOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5ub3RlLWVkaXRvciB7IG1hcmdpbjogMCAxMnB4IDEycHg7IGJvcmRlci1yYWRpdXM6IDIycHg7IG1pbi1oZWlnaHQ6IDA7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5lLXRpdGxlIHsgcGFkZGluZzogMTRweCAxOHB4IDZweDsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubmUtdG9vbGJhciB7IG1hcmdpbjogMCAxMHB4OyB9CiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5uZS1ib2R5IHsgcGFkZGluZzogMTBweCAxOHB4IDIwdmg7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5lLWJvZHlbZGF0YS1lbXB0eT0iMSJdOjpiZWZvcmUgeyBsZWZ0OiAxOHB4OyByaWdodDogMThweDsgfQoKICAvKiBGb2xkZXJzOiB0aGUgdHJ",
"lZSwgZm9sZGVkIGF3YXkgYmVoaW5kIGEgYnV0dG9uIHRoYXQgc2F5cyB3aGVyZSB5b3UKICAgICBhcmU7IG9wZW4sIGl0IGlzIHRoZSBzYW1lIHRyZWUgYXMgb24gYSBjb21wdXRlciwgbmVzdGluZyBhbmQgYWxsLiAqLwogIC5ub3Rlcy1mb2xkZXJzIHsgZmxleDogbm9uZTsgYmFja2dyb3VuZDogbm9uZTsgYm9yZGVyLXJhZGl1czogMDsgcGFkZGluZzogMnB4IDEycHggNHB4OyB9CiAgLmZvbGRlcnMtdG9nZ2xlIHsKICAgIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgd2lkdGg6IDEwMCU7IGhlaWdodDogNDZweDsgcGFkZGluZzogMCAxMHB4IDAgMTRweDsKICAgIGJvcmRlci1yYWRpdXM6IDE0cHg7IGJhY2tncm91bmQ6IHZhcigtLWNvbCk7IGNvbG9yOiB2YXIoLS1mZyk7IGZvbnQtc2l6ZTogMTVweDsgdGV4dC1hbGlnbjogbGVmdDsKICB9CiAgLmZvbGRlcnMtdG9nZ2xlIC5pY29uIHsgY29sb3I6IHZhcigtLWZnLTIpOyBmbGV4OiBub25lOyB9CiAgLmZ0LWxhYmVsIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQogIC5mdC1jb3VudCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxM3B4OyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9CiAgLm5vdGVzW2RhdGEtZm9sZGVycz0ib3BlbiJdIC5mb2xkZXJzLXRvZ2dsZSB7IGJvcmR",
"lci1yYWRpdXM6IDE0cHggMTRweCAwIDA7IH0KICAubm90ZXNbZGF0YS1mb2xkZXJzPSJvcGVuIl0gLmZvbGRlcnMtdG9nZ2xlIC5pY29uOmxhc3QtY2hpbGQgeyB0cmFuc2Zvcm06IHJvdGF0ZSgxODBkZWcpOyB9CiAgLm5vdGVzOm5vdChbZGF0YS1mb2xkZXJzPSJvcGVuIl0pIC5mb2xkZXJzLWhlYWQsIC5ub3Rlczpub3QoW2RhdGEtZm9sZGVycz0ib3BlbiJdKSAuZm9sZGVyLWl0ZW1zIHsgZGlzcGxheTogbm9uZTsgfQogIC5mb2xkZXJzLWhlYWQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOyBwYWRkaW5nOiAwIDZweCAwIDE2cHg7IH0KICAuZm9sZGVyLWl0ZW1zIHsgZmxleDogbm9uZTsgbWF4LWhlaWdodDogNTV2aDsgYmFja2dyb3VuZDogdmFyKC0tY29sKTsgYm9yZGVyLXJhZGl1czogMCAwIDE0cHggMTRweDsgcGFkZGluZzogMnB4IDhweCAxMHB4OyB9CiAgLmZvbGRlci1idG4geyBoZWlnaHQ6IDQ0cHg7IH0KICAuZm9sZGVyLXR3aXN0eSB7IHdpZHRoOiAzNHB4OyBoZWlnaHQ6IDQ0cHg7IG1hcmdpbi1yaWdodDogMDsgfQogIC5mb2xkZXItaXRlbXNbZGF0YS1uZXN0ZWRdIC5mb2xkZXItZWRpdCB7IHBhZGRpbmctbGVmdDogNDRweDsgfQogIC5mb2xkZXItaXRlbXNbZGF0YS1uZXN0ZWRdIC5mb2xkZXItZXJyb3IgeyBwYWRkaW5nLWxlZnQ6IDcwcHg7IH0KICAvKiBObyBob3ZlciBvbiBhIHBob25lOiBlYWNoIGZvbGRlcidzIOKLryBpcyBhbHdheXMgdGhlcmUsIG5leHQgdG8gaXRzIGNvdW50LiAqLwogIC5",
"mb2xkZXItbWVudSB7IG9wYWNpdHk6IDE7IHJpZ2h0OiA0cHg7IH0KICAuZm9sZGVyLXJvdyAuZm9sZGVyLWNvdW50LCAuZm9sZGVyLXJvdzpob3ZlciAuZm9sZGVyLWNvdW50LCAuZm9sZGVyLXJvdzpmb2N1cy13aXRoaW4gLmZvbGRlci1jb3VudCB7IHZpc2liaWxpdHk6IHZpc2libGU7IG1hcmdpbi1yaWdodDogMzRweDsgfQoKICAubm90ZXMtbGlzdCB7IGZsZXg6IDE7IGJvcmRlci1yYWRpdXM6IDA7IGJhY2tncm91bmQ6IG5vbmU7IH0KICAubm90ZXMtdG9vbHMgeyBwYWRkaW5nOiA0cHggMTJweCA4cHg7IH0KICAubm90ZXMtaXRlbXMgeyBwYWRkaW5nOiAwIDRweCAxMnB4OyB9CiAgLm5vdGUtaXRlbSB7IHBhZGRpbmc6IDEycHg7IH0KCiAgLm5vdGUtZWRpdG9yIHsgZmxleDogMTsgYm9yZGVyLXJhZGl1czogMDsgYm94LXNoYWRvdzogbm9uZTsgfQogIC5uZS1iYWNrIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IG1hcmdpbi1yaWdodDogMnB4OyB9CiAgLm5lLWJhciB7IHBhZGRpbmc6IDZweCA2cHggMCA0cHg7IH0KICAubmUtdGl0bGUgeyBwYWRkaW5nOiA2cHggMTZweCA0cHg7IGZvbnQtc2l6ZTogMjJweDsgfQogIC5uZS10b29sYmFyIHsgbWFyZ2luOiAwIDhweDsgb3ZlcmZsb3cteDogYXV0bzsgZmxleC13cmFwOiBub3dyYXA7IHNjcm9sbGJhci13aWR0aDogbm9uZTsgfQogIC5uZS1saW5rYmFyIHsgbWFyZ2luOiA0cHggOHB4IDA7IH0KICAubmUtdGFibGViYXIgeyBtYXJnaW46IDRweCA4cHggMDsgb3ZlcmZ",
"sb3cteDogYXV0bzsgZmxleC13cmFwOiBub3dyYXA7IHNjcm9sbGJhci13aWR0aDogbm9uZTsgfQogIC5uZS10YWJsZWJhciAuc3BhY2VyIHsgZGlzcGxheTogbm9uZTsgfQogIC5uZS1iYW5uZXIgeyBtYXJnaW46IDRweCAxMnB4IDA7IH0KICAubmUtZmluZCB7IG1hcmdpbjogNHB4IDEycHggMDsgfQogIC5uZS1ib2R5IHsgcGFkZGluZzogMTBweCAxNnB4IDQwdmg7IGZvbnQtc2l6ZTogMTZweDsgfQogIC5uZS1ib2R5W2RhdGEtZW1wdHk9IjEiXTo6YmVmb3JlIHsgbGVmdDogMTZweDsgfQp9CkBtZWRpYSAobWF4LXdpZHRoOiA0ODBweCkgewogIC50YWJbYXJpYS1zZWxlY3RlZD0iZmFsc2UiXSB7IGdhcDogMDsgcGFkZGluZzogMCAxMHB4OyBmb250LXNpemU6IDA7IH0KfQpgOwoKICAvLyBBcHBzIFNjcmlwdCdzIGhpc3RvcnksIGlmIHRoZXJlIGlzIG9uZSwgdXNlZCBzbyB0aGF0IG5vdGhpbmcgaXQgZG9lcyAtCiAgLy8gb3IgZmFpbHMgdG8gZG8gLSBjYW4gc3RvcCB0aGUgYXBwOiB0aGUgYmFjayBnZXN0dXJlIGlzIGEgbmljZXR5LgogIGZ1bmN0aW9uIGhpc3RvcnlBcGkoKSB7CiAgICBjb25zdCBhcGkgPSB0eXBlb2YgZ29vZ2xlICE9PSAndW5kZWZpbmVkJyAmJiBnb29nbGUuc2NyaXB0ICYmIGdvb2dsZS5zY3JpcHQuaGlzdG9yeTsKICAgIGlmICghYXBpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHNhZmUgPSBmbiA9PiAoLi4uYXJncykgPT4gewogICAgICB0cnkgeyByZXR1cm4gYXBpW2ZuXSguLi5hcmdzKTs",
"gfSBjYXRjaCAoZXJyKSB7IGNvbnNvbGUud2FybihgZ29vZ2xlLnNjcmlwdC5oaXN0b3J5LiR7Zm59OiAke2Vyci5tZXNzYWdlfWApOyByZXR1cm4gdW5kZWZpbmVkOyB9CiAgICB9OwogICAgcmV0dXJuIHsgcHVzaDogc2FmZSgncHVzaCcpLCByZXBsYWNlOiBzYWZlKCdyZXBsYWNlJyksIHNldENoYW5nZUhhbmRsZXI6IHNhZmUoJ3NldENoYW5nZUhhbmRsZXInKSB9OwogIH0KCiAgY29uc3Qgd2lkZSA9ICgpID0-ICEhKHdpbmRvdy5tYXRjaE1lZGlhICYmIHdpbmRvdy5tYXRjaE1lZGlhKCcobWluLXdpZHRoOiA3NjFweCknKS5tYXRjaGVzKTsKCiAgZnVuY3Rpb24gc3RhcnQoKSB7CiAgICAvLyBXaXRob3V0IGFsbCBpdHMgcGFydHMgdGhlIGFwcCBjYW5ub3Qgd29yazogdGhlIGxvYWRlcidzIGxpc3Qgb2YKICAgIC8vIHdoYXQgZGlkIG5vdCBsb2FkIHN0YXlzIG9uIHRoZSBzY3JlZW4gaW5zdGVhZC4KICAgIGlmICh3aW5kb3cuX19wYXJ0c0ZhaWxlZCAmJiB3aW5kb3cuX19wYXJ0c0ZhaWxlZC5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IHsgaG9zdCwgcm9vdCB9ID0gbW91bnRTaGFkb3coJ2drYi1hcHAtaG9zdCcsIG5zLnN0eWxlcy5ib2FyZCArIFBIT05FKTsKICAgIGNvbnN0IGhpc3RvcnkgPSBoaXN0b3J5QXBpKCk7CiAgICAvLyBIb3cgbWFueSBzdGVwcyBpbiBmcm9tIHRoZSBTY3JhdGNocGFkIHRoZSBoaXN0b3J5IGhvbGRzLCBhbmQgd2hldGhlcgogICAgLy8gdGhlIGJhY2sgZ2VzdHVyZSBpcyBiZWluZyB",
"mb2xsb3dlZCByaWdodCBub3cuCiAgICBsZXQgZGVwdGggPSAwOwogICAgbGV0IHN0ZXBwaW5nID0gZmFsc2U7CgogICAgLy8gV2hpY2ggZm9sZGVycyBhcmUgZm9sZGVkLCB3aGljaCBjYWxlbmRhcnMgc2hvdywgb24gdGhpcyBwaG9uZS4gVGhlCiAgICAvLyBwYWdlIGlzIG9ubHkgZXZlciBvcGVuZWQgYnkgaXRzIG93bmVyLCBzbyB0aGVyZSBpcyBubyBhY2NvdW50IHRvCiAgICAvLyBrZXkgdGhlbSBieS4gVGhlICdzdXBlcm1haWwuJyBwcmVmaXggaXMgdGhlIGFwcCdzIG9sZCBuYW1lLCBrZXB0IHNvCiAgICAvLyBwcmVmcyBzYXZlZCBiZWZvcmUgdGhlIHJlbmFtZSBzdGlsbCBjb3VudC4KICAgIGNvbnN0IHByZWZzID0gewogICAgICBnZXQobmFtZSkgewogICAgICAgIHRyeSB7IHJldHVybiBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKGBzdXBlcm1haWwuJHtuYW1lfWApIHx8ICdudWxsJyk7IH0gY2F0Y2ggKGVycikgeyByZXR1cm4gbnVsbDsgfQogICAgICB9LAogICAgICBzZXQobmFtZSwgdmFsdWUpIHsKICAgICAgICB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShgc3VwZXJtYWlsLiR7bmFtZX1gLCBKU09OLnN0cmluZ2lmeSh2YWx1ZSkpOyB9IGNhdGNoIChlcnIpIHsgLyogc3RvcmFnZSBvZmY6IG5vdCByZW1lbWJlcmVkICovIH0KICAgICAgfSwKICAgIH07CgogICAgbnMuYm9hcmRGcmFtZSA9IHsKICAgICAgcm9vdCwKICAgICAgdmlldzogJ25vdGVzJywKICAgICAgdGltaW5nczogdGltaW5",
"nVGV4dCwKICAgICAgLy8gT24gYSBjb21wdXRlciwgdHlwaW5nIGdvZXMgc3RyYWlnaHQgaW50byB0aGUgU2NyYXRjaHBhZC4gKEEgcGhvbmUKICAgICAgLy8gd291bGQgb25seSBwb3AgaXRzIGtleWJvYXJkIHVwIG92ZXIgaXQsIHNvIHRoZXJlIGl0IHdhaXRzIGZvciBhIHRhcC4pCiAgICAgIGZvY3VzOiB3aWRlKCksCiAgICAgIC8vIFRoZSBzY3JpcHQncyBvd24gYWNjZXNzIGNvdmVycyB0aGUgY2FsZW5kYXI6IG5vdGhpbmcgdG8gY29ubmVjdC4KICAgICAgY2FsZW5kYXI6IHsgcHJlZnMsIGNvbm5lY3Q6IG51bGwgfSwKICAgICAgbm90ZXM6IHsKICAgICAgICBwcmVmcywKICAgICAgICAvLyBFYWNoIHN0ZXAgaW4gZ29lcyBvbiB0aGUgaGlzdG9yeSwgc28gdGhlIGJhY2sgZ2VzdHVyZSBjYW4gdW5kbyBpdDsKICAgICAgICAvLyBhIHN0ZXAgb3V0IHRha2VuIGluIHRoZSBhcHAgaXRzZWxmIHJld3JpdGVzIHRoZSB0b3AgZW50cnkgaW5zdGVhZCwKICAgICAgICAvLyBzaW5jZSBub3RoaW5nIGhlcmUgY2FuIHRha2UgYW4gZW50cnkgb2ZmLgogICAgICAgIG9uVmlld0NoYW5nZSh2aWV3KSB7CiAgICAgICAgICBob3N0LmRhdGFzZXQudmlldyA9IHZpZXc7CiAgICAgICAgICBjb25zdCBkID0gbnMubm90ZXMuZGVwdGgoKTsKICAgICAgICAgIGlmIChoaXN0b3J5ICYmICFzdGVwcGluZykgewogICAgICAgICAgICBpZiAoZCA-IGRlcHRoKSBmb3IgKGxldCBpID0gZGVwdGggKyAxOyBpIDw9IGQ7IGkrKykgaGlzdG9yeS5",
"wdXNoKHsgZGVwdGg6IGkgfSwge30sICcnKTsKICAgICAgICAgICAgZWxzZSBpZiAoZCA8IGRlcHRoKSBoaXN0b3J5LnJlcGxhY2UoeyBkZXB0aDogZCB9LCB7fSwgJycpOwogICAgICAgICAgfQogICAgICAgICAgZGVwdGggPSBkOwogICAgICAgIH0sCiAgICAgIH0sCiAgICB9OwoKICAgIGlmIChoaXN0b3J5KSB7CiAgICAgIGhpc3Rvcnkuc2V0Q2hhbmdlSGFuZGxlcihhc3luYyBlID0-IHsKICAgICAgICBjb25zdCB0YXJnZXQgPSAoZSAmJiBlLnN0YXRlICYmIE51bWJlcihlLnN0YXRlLmRlcHRoKSkgfHwgMDsKICAgICAgICBzdGVwcGluZyA9IHRydWU7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHdoaWxlIChucy5ub3Rlcy5kZXB0aCgpID4gdGFyZ2V0KSB7CiAgICAgICAgICAgIGNvbnN0IGJlZm9yZSA9IG5zLm5vdGVzLmRlcHRoKCk7CiAgICAgICAgICAgIGF3YWl0IG5zLm5vdGVzLmJhY2soKTsKICAgICAgICAgICAgaWYgKG5zLm5vdGVzLmRlcHRoKCkgPj0gYmVmb3JlKSBicmVhazsgLy8gYW4gdW5zYXZlZCBlZGl0IGtlcHQgdGhlIG5vdGUgb3BlbgogICAgICAgICAgfQogICAgICAgIH0gZmluYWxseSB7CiAgICAgICAgICBzdGVwcGluZyA9IGZhbHNlOwogICAgICAgIH0KICAgICAgICAvLyBOb3QgYXMgZmFyIGJhY2sgYXMgdGhlIGdlc3R1cmUgd2VudDogdGhvc2Ugc3RlcHMgZ28gYmFjayBvbi4KICAgICAgICBkZXB0aCA9IG5zLm5vdGVzLmRlcHRoKCk7CiAgICAgICAgZm9yIChsZXQgaSA9IHRhcmdldCA",
"rIDE7IGkgPD0gZGVwdGg7IGkrKykgaGlzdG9yeS5wdXNoKHsgZGVwdGg6IGkgfSwge30sICcnKTsKICAgICAgfSk7CiAgICB9CgogICAgLy8gQSBwaG9uZSBzd2l0Y2hlcyBhd2F5IHdpdGhvdXQgY2xvc2luZyB0aGUgcGFnZS4KICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3Zpc2liaWxpdHljaGFuZ2UnLCAoKSA9PiB7CiAgICAgIGlmIChkb2N1bWVudC52aXNpYmlsaXR5U3RhdGUgPT09ICdoaWRkZW4nKSBucy5ub3Rlcy5mbHVzaCgpOwogICAgICBlbHNlIGlmIChucy5ib2FyZC52aWV3KCkgPT09ICdub3RlcycpIHsgaWYgKG5zLm5vdGVzLmlzU3RhbGUoKSkgbnMubm90ZXMubG9hZCgpOyB9CiAgICAgIGVsc2UgaWYgKG5zLmJvYXJkLnZpZXcoKSA9PT0gJ2NhbGVuZGFyJykgeyBpZiAobnMuY2FsZW5kYXIuaXNTdGFsZSgpKSBucy5jYWxlbmRhci5sb2FkKCk7IH0KICAgICAgZWxzZSBucy5ib2FyZC5yZWZyZXNoSWZTdGFsZSgpOwogICAgfSk7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncGFnZWhpZGUnLCAoKSA9PiBucy5ub3Rlcy5mbHVzaCgpKTsKCiAgICAvLyBPbmUgY2FsbCB0byB0aGUgc2NyaXB0LCBzZW50IGJlZm9yZSBhbnl0aGluZyBlbHNlIChyZW1vdGUuanMpLiBXaXRoCiAgICAvLyB0aGUgcGhvbmUncyBjb3B5IG9mIHRoZSBub3RlcywgdGhlIGFwcCBvcGVucyBvbiB0aGF0IGF0IG9uY2UgYW5kIHRoZQogICAgLy8gY2FsbCBjYXRjaGVzIGl0IHVwOyB3aXRob3V0IG9uZSAoYSBmaXJ",
"zdCB2aXNpdCksIGl0IHdhaXRzIGZvciBpdC4KICAgIGNvbnN0IHJlbW90ZSA9IG5zLmFwcFJlbW90ZTsKICAgIGNvbnN0IGJlZ3VuID0gcmVtb3RlLnN0YXJ0KCk7CiAgICBjb25zdCBzaG93ID0gKCkgPT4gewogICAgICBucy5ib2FyZC5vcGVuKCk7CiAgICAgIGNvbnN0IGJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYm9vdCcpOwogICAgICBpZiAoYm9vdCkgYm9vdC5yZW1vdmUoKTsKICAgICAgbWFyaygncmVhZHknKTsKICAgIH07CiAgICBjb25zdCBjYXVnaHRVcCA9IHIgPT4gewogICAgICBtYXJrKCdjaGVja2VkJyk7CiAgICAgIGlmIChyLm90aGVyQWNjb3VudCAmJiB3aW5kb3cuX19ib290RmFpbGVkKSB7CiAgICAgICAgd2luZG93Ll9fYm9vdEZhaWxlZCgnVGhpcyBwaG9uZSBoYWQgbm90ZXMgZnJvbSBhbm90aGVyIEdvb2dsZSBhY2NvdW50LCBub3cgY2xlYXJlZC4gQ2xvc2UgdGhlIGFwcCBhbmQgb3BlbiBpdCBhZ2Fpbi4nKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgbnMubm90ZXMuc2NyYXRjaEZvdW5kKHIuc2NyYXRjaCk7CiAgICB9OwogICAgbGV0IHBvbGxzID0gMDsKICAgIGNvbnN0IGxpc3RlZCA9ICgpID0-IHsKICAgICAgaWYgKG5zLm5vdGVzLmxvYWRlZEF0KCkpIG1hcmsoJ2xpc3RlZCcpOwogICAgICBlbHNlIGlmICgrK3BvbGxzIDwgMzAwKSBzZXRUaW1lb3V0KGxpc3RlZCwgMjAwKTsKICAgIH07CiAgICBsaXN0ZWQoKTsKICAgIGlmIChyZW1vdGUuaGFzQ29weSgpKSB",
"7CiAgICAgIHNob3coKTsKICAgICAgLy8gT2ZmbGluZSwgb3IgdGhlIHNjcmlwdCB1bnJlYWNoYWJsZTogdGhlIGNvcHkgY2FycmllcyBvbiwgYW5kIHRoZQogICAgICAvLyBub3Rlcycgb3duIGxvYWRpbmcgc2F5cyB3aGF0IGlzIHdyb25nLgogICAgICByZXR1cm4gYmVndW4udGhlbihjYXVnaHRVcCwgZXJyID0-IGNvbnNvbGUud2FybihgVGhlIGZpcnN0IGNhbGwgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWApKTsKICAgIH0KICAgIHJldHVybiBiZWd1bi50aGVuKHIgPT4gewogICAgICBzaG93KCk7CiAgICAgIGNhdWdodFVwKHIpOwogICAgfSwgZXJyID0-IHsKICAgICAgaWYgKHdpbmRvdy5fX2Jvb3RGYWlsZWQpIHdpbmRvdy5fX2Jvb3RGYWlsZWQoYEdtYWlsIGNvdWxkIG5vdCBiZSByZWFjaGVkOiAke2Vyci5tZXNzYWdlfWApOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBydW4oKSB7CiAgICB0cnkgewogICAgICBzdGFydCgpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoZXJyKTsKICAgICAgaWYgKHdpbmRvdy5fX2Jvb3RGYWlsZWQpIHdpbmRvdy5fX2Jvb3RGYWlsZWQoZXJyLm1lc3NhZ2UsIGVyci5zdGFjayk7CiAgICB9CiAgfQoKICBucy5waG9uZUFwcCA9IHsgc3RhcnQgfTsKICBpZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gJ2xvYWRpbmcnKSBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdET01Db250ZW50TG9hZGVkJywgcnVuKTsKICBlbHNlIHJ1bigpOwp9KSgpOwo\"]];",
"\n  var SOURCE = String.fromCharCode(10, 47, 47) + '# sourceURL=app/';\n  function decode(text) {\n    var bin = atob(text.replace(/-/g, '+').replace(/_/g, String.fromCharCode(47)));\n    var bytes = new Uint8Array(bin.length);\n    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n    return new TextDecoder('utf-8').decode(bytes);\n  }\n  function run(name, code) {\n    try {\n      (0, eval)(code + SOURCE + name);\n    } catch (err) {\n      if (!(err instanceof EvalError)) throw err;\n      var el = document.createElement('script');\n      el.text = code + SOURCE + name;\n      document.head.appendChild(el);\n    }\n  }\n  var failed = [];\n  for (var i = 0; i < MODULES.length; i++) {\n    try {\n      run(MODULES[i][0], decode(MODULES[i][1]));\n    } catch (err) {\n      failed.push(MODULES[i][0] + ': ' + err.message);\n    }\n  }\n  if (failed.length) {\n    window.__partsFailed = failed;\n    if (window.__bootFailed) window.__bootFailed('Parts that did not load: ' + failed.join('; '));\n  }",
"\n})();\n</script>\n</body>\n</html>\n",
].join('');
