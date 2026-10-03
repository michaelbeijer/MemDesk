// The phone panel and phone app 0.19.0: a Gmail add-on and a web app, in Apps Script.
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
//   src/lib/search-logic.js
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

var MEMDESK_VERSION = '0.19.0';

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
  ns.BUILT_IN_CLIENT_ID = BUILT_IN_CLIENT_ID;
  ns.KEYS = KEYS;
  ns.HOST_IDS = HOST_IDS;

  if (typeof module === 'object' && module.exports) {
    module.exports = { APP_NAME, KEYS, HOST_IDS };
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
// sizes, bulleted, numbered and check lists nested up to three deep -
// each holding runs of text that may be bold, italic, struck through or
// a link. That is the whole model; nothing outside it survives a save.
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

  const TYPES = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'check']);
  const LISTS = new Set(['ul', 'ol', 'check']);
  const MAX_LEVEL = 3;
  const BOX = '☐';     // ☐
  const TICKED = '☑';  // ☑
  const BULLET = '•';  // •

  // ── The model ────────────────────────────────────────────────────────

  function block(type = 'p', runs = [], { level = 0, checked = false } = {}) {
    return { type, level: LISTS.has(type) ? level : 0, checked: type === 'check' ? !!checked : false, runs };
  }

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

  // Unknown types become paragraphs; a list item may sit at most one level
  // deeper than the list item before it, which is what keeps the HTML a
  // properly nested list and the editor's indents meaningful.
  function normaliseDoc(doc) {
    const out = [];
    let prevLevel = -1;
    for (const b of Array.isArray(doc) ? doc : []) {
      if (!b || typeof b !== 'object') continue;
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
    return out.length ? out : emptyDoc();
  }

  const blockText = b => b.runs.map(r => r.text).join('');

  function docText(doc) {
    return doc.map(blockText).join('\n');
  }

  function isEmpty(doc) {
    return doc.every(b => !blockText(b).trim());
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
        let t = escHtml(raw).replace(/ {2}/g, ' &nbsp;');
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
  };

  function toHtml(docIn) {
    const doc = normaliseDoc(docIn);
    const stack = []; // open lists, one per level: { tag, check }
    let out = `<div data-gkb-note="1" style="${STYLE.doc}">`;
    const close = () => { out += `</li></${stack.pop().tag}>`; };

    for (const b of doc) {
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

  function toPlain(docIn) {
    const doc = normaliseDoc(docIn);
    const counters = [0, 0, 0, 0];
    return doc.map(b => {
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
    return normaliseDoc(lines.map(line => {
      const m = /^( *)(?:([-*•])|(\d{1,3})[.)]|([☐☑])) (.*)$/.exec(line);
      if (!m) return block('p', [{ text: line }]);
      const level = Math.floor(m[1].length / 2);
      if (m[4]) return block('check', [{ text: m[5] }], { level, checked: m[4] === TICKED });
      return block(m[3] ? 'ol' : 'ul', [{ text: m[5] }], { level });
    }));
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
    let row = null;           // an open table row: { cells, th }
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
        if (cur) end();
        else { context(); end(); }
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
      // A table row is one line, its cells separated by " | ": there are
      // no tables in a note, and this keeps a pasted row readable.
      // A heading cell is bold, as a browser shows it.
      const headCell = on => {
        if (!row || row.th === on) return;
        row.th = on;
        marks.b += on ? 1 : -1;
      };
      if (name === 'tr') {
        end();
        headCell(false);
        row = isClose ? null : { cells: 0, th: false };
        continue;
      }
      if (name === 'td' || name === 'th') {
        if (!row) { end(); continue; }
        headCell(false);
        if (!isClose && !selfClosing) {
          if (row.cells > 0) {
            if (!cur) context();
            cur.runs.push({ text: ' | ', b: false, i: false, s: false, href: '' });
          }
          row.cells++;
          headCell(name === 'th');
        }
        continue;
      }
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
      if (name === 'div' && !isClose && TYPES.has(a['data-type'])) {
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
          para = { gap: !ours && !row && !(top && top.liOpen) && paraGap(a) };
        }
      }
      if (PARA.has(name)) {
        // Inside a table cell, or straight inside a list item that has no
        // text yet (Google Docs wraps every item in a <p>), the line goes on.
        if (row) continue;
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
    for (const k of Object.keys(marks)) marks[k] = Math.max(0, marks[k]);

    // Tidy each block: collapse the whitespace HTML would collapse, then
    // turn the &nbsp;s that held deliberate spaces back into spaces.
    for (const b of blocks) {
      const runs = b.runs;
      if (runs.length) {
        runs[0].text = runs[0].text.replace(/^ +/, '');
        runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/ +$/, '');
        for (let i = 1; i < runs.length; i++) {
          if (/ $/.test(runs[i - 1].text)) runs[i].text = runs[i].text.replace(/^ +/, '');
        }
        for (const r of runs) r.text = r.text.replace(/ /g, ' ');
      }
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
    if (/^\|.*\|\s*$/.test(s)) return { type: 'p', cells: s.trim().slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim()) };
    return { type: 'p', text: s };
  }

  const MD_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const MD_TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

  function fromMarkdown(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const out = [];
    const indents = [];   // the indent of each open list level
    let fence = false;
    const last = () => out[out.length - 1];
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) { out.push(block('p', [{ text: line }])); continue; }
      // The |---|---| line under a table's heading row makes that row bold.
      if (MD_TABLE_RULE.test(line)) {
        const head = last();
        if (head && head.table) for (const r of head.runs) if (!r.sep) r.b = true;
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
      if (l.cells) {
        const runs = [];
        l.cells.forEach((c, k) => {
          if (k) runs.push({ text: ' | ', sep: true });
          runs.push(...mdInline(c.replace(/\\\|/g, '|')));
        });
        const b = block('p', runs);
        b.table = true;
        out.push(b);
        continue;
      }
      out.push(block(l.type, mdInline(l.text.trim())));
    }
    while (out.length > 1 && fmtBlank(last())) out.pop();
    while (out.length > 1 && fmtBlank(out[0])) out.shift();
    return normaliseDoc(out);
  }

  const fmtBlank = b => b.type === 'p' && !b.runs.some(r => r.text.trim());

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
    mergeDocs, sameDoc,
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

// ════ src/lib/search-logic.js ═════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Search highlighting (pure)
//
// Gmail does the searching; this only shows where the words are. It takes
// the words out of a Gmail query - leaving out operators such as from: or
// before:, and anything excluded with a minus - and finds them in a
// note's text the way a person would read a match: ignoring case and
// accents ("cafe" finds "Café"), at the start of a word ("gloss" finds
// "glossary", not "xgloss"), and phrases in quotes as phrases.
//
// From those matches come the excerpts shown in the results list, with
// their offsets, so the list can mark them without parsing any HTML.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  // Operators whose value is a word to look for in the note itself.
  const TEXT_OPS = new Set(['subject', 'intitle']);
  const KEYWORDS = new Set(['or', 'and', 'around']);

  // ── The words in a query ─────────────────────────────────────────────

  // Returns [{ words: ['stent', 'coating'] }, …]: one entry per term, a
  // phrase being several words in a row.
  function queryTerms(query) {
    const out = [];
    const seen = new Set();
    const add = text => {
      const words = String(text).split(/[\s"()[\]{}<>]+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
      if (!words.length) return;
      if (words.length === 1 && words[0].length < 2 && /^[\p{L}\p{N}]$/u.test(words[0]) && /[a-z0-9]/i.test(words[0])) return;
      const key = words.join(' ').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ words });
    };
    const tokens = String(query || '').match(/-?[\p{L}\p{N}_]+:\([^)]*\)|-?[\p{L}\p{N}_]+:"[^"]*"|-?"[^"]*"|\S+/gu) || [];
    for (const raw of tokens) {
      if (raw.startsWith('-')) continue; // excluded: not in the note
      const op = /^([\p{L}\p{N}_]+):(.*)$/u.exec(raw);
      if (op) {
        if (TEXT_OPS.has(op[1].toLowerCase())) {
          const v = op[2].replace(/^[("]|[)"]$/g, '');
          if (/^\(/.test(op[2])) v.split(/\s+/).forEach(add);
          else add(v);
        }
        continue;
      }
      if (raw.startsWith('"')) { add(raw.replace(/"/g, '')); continue; }
      const word = raw.replace(/^[+(){}]+|[(){}]+$/g, '');
      if (KEYWORDS.has(word.toLowerCase())) continue;
      add(word);
    }
    return out;
  }

  // ── Finding them ─────────────────────────────────────────────────────

  // Lower case, accents off - one character at a time, with a map back to
  // where each folded character came from, so a match in the folded text
  // is a match at known offsets in the real one.
  function fold(text) {
    let folded = '';
    const map = [];
    const s = String(text || '');
    for (let i = 0; i < s.length;) {
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const f = ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
      for (let k = 0; k < f.length; k++) map.push(i);
      folded += f;
      i += ch.length;
    }
    map.push(s.length);
    return { folded, map };
  }

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Every place the terms occur, as [start, end) offsets into `text`,
  // in order, with overlaps merged.
  function findMatches(text, terms) {
    if (!terms || !terms.length || !text) return [];
    const { folded, map } = fold(text);
    const found = [];
    for (const t of terms) {
      const pattern = t.words.map(w => escapeRe(fold(w).folded)).join('[\\s\\u00a0]+');
      if (!pattern) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}`, 'gu');
      let m;
      while ((m = re.exec(folded))) {
        found.push([map[m.index], map[m.index + m[0].length]]);
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [s, e] of found) {
      const last = merged[merged.length - 1];
      if (last && s <= last.end) last.end = Math.max(last.end, e);
      else merged.push({ start: s, end: e });
    }
    return merged;
  }

  // ── Excerpts ─────────────────────────────────────────────────────────

  // Up to `max` stretches of text around the matches, each with the
  // matches inside it at offsets relative to the stretch. Stretches start
  // and end on a space where one is near, and say whether text was cut.
  function excerpts(text, matches, { context = 50, max = 3 } = {}) {
    const s = String(text || '');
    const out = [];
    let i = 0;
    while (i < matches.length && out.length < max) {
      let start = Math.max(0, matches[i].start - context);
      let end = Math.min(s.length, matches[i].end + context);
      // Matches close enough share an excerpt.
      let j = i + 1;
      while (j < matches.length && matches[j].start < end) {
        end = Math.min(s.length, Math.max(end, matches[j].end + Math.floor(context / 2)));
        j++;
      }
      if (start > 0) {
        const sp = s.slice(start, matches[i].start).search(/\s/);
        if (sp >= 0) start += sp + 1;
      }
      if (end < s.length) {
        const tail = s.slice(matches[j - 1].end, end);
        const sp = tail.search(/\s\S*$/);
        if (sp > 0) end = matches[j - 1].end + sp;
      }
      out.push({
        text: s.slice(start, end).replace(/\s/g, ' '),
        marks: matches.slice(i, j).map(m => ({ start: Math.max(m.start, start) - start, end: Math.min(m.end, end) - start })),
        cutBefore: start > 0,
        cutAfter: end < s.length,
      });
      i = j;
    }
    return out;
  }

  const api = { queryTerms, fold, findMatches, excerpts };

  ns.searchLogic = api;
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
// What the Gmail add-on shows of a note, and what its controls do to
// one, without any of Apps Script's services - so it is tested in Node
// like the rest of the shared code.
//
// A card cannot hold an editor. It can show text with bold, italic,
// strike-through and links, and it can show check boxes. So a note is
// shown as runs of text, lists drawn with bullets and numbers, and each
// checklist item as a real check box; and what the panel can change is
// what a phone is good for: ticking boxes, adding lines at the end,
// moving the note to another folder, and starting a new note.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const node = typeof module === 'object' && module.exports;
  const fmt = node ? require('../../src/lib/note-format.js') : ns.noteFormat;
  const util = node ? require('../../src/lib/util.js') : ns.util;
  const board = node ? require('../../src/lib/board-logic.js') : ns.logic;
  const search = node ? require('../../src/lib/search-logic.js') : ns.searchLogic;

  const INDENT = '  '; // two em spaces a level, which cards do not collapse
  const GREY = '#5f6368';

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── Showing a note ───────────────────────────────────────────────────

  // A search match: cards cannot colour a background, so matches are
  // bold and orange instead, which reads on light and dark alike.
  const HIT_OPEN = '<font color="#e8710a"><b>';
  const HIT_CLOSE = '</b></font>';

  // Cuts runs where matches begin and end, so each piece is wholly inside
  // a match or wholly outside one. `matches` are offsets into the text of
  // all the runs together.
  function splitRuns(runs, matches) {
    if (!matches || !matches.length) return runs.map(r => Object.assign({}, r, { hit: false }));
    const out = [];
    let pos = 0;
    for (const r of runs) {
      const start = pos;
      const end = pos + r.text.length;
      const cuts = [start, end];
      for (const m of matches) {
        if (m.start > start && m.start < end) cuts.push(m.start);
        if (m.end > start && m.end < end) cuts.push(m.end);
      }
      cuts.sort((x, y) => x - y);
      for (let k = 0; k < cuts.length - 1; k++) {
        const from = cuts[k];
        const to = cuts[k + 1];
        if (from === to) continue;
        const hit = matches.some(m => m.start <= from && m.end >= to);
        out.push(Object.assign({}, r, { text: r.text.slice(from - start, to - start), hit }));
      }
      pos = end;
    }
    return out;
  }

  // Runs as the HTML a card understands: <b>, <i>, <s> and <a>, with any
  // search matches marked.
  function runsHtml(runsIn, matches) {
    const runs = splitRuns(runsIn, matches);
    let out = '';
    for (let i = 0; i < runs.length;) {
      const href = runs[i].href || '';
      let j = i;
      let inner = '';
      while (j < runs.length && (runs[j].href || '') === href) {
        let t = esc(runs[j].text).replace(/ {2}/g, ' \u00a0');
        if (runs[j].hit) t = HIT_OPEN + t + HIT_CLOSE;
        if (runs[j].s) t = `<s>${t}</s>`;
        if (runs[j].i) t = `<i>${t}</i>`;
        if (runs[j].b) t = `<b>${t}</b>`;
        inner += t;
        j++;
      }
      out += href ? `<a href="${esc(href)}">${inner}</a>` : inner;
      i = j;
    }
    return out;
  }

  // Plain text with its matches marked.
  const highlight = (text, matches) => runsHtml([{ text: String(text || '') }], matches);

  const grey = text => `<font color="${GREY}">${esc(text)}</font>`;

  // The note as a column of card items: { kind: 'text', html } for a run
  // of ordinary lines, { kind: 'check', index, html, checked } for each
  // checklist item, `index` being its block's place in the note. Past
  // `maxBlocks` nothing is shown, and `hidden` says how much that was.
  // With search `terms`, their matches are marked, and `hits` counts them
  // in the whole note; with `only` as well, just the lines that have a
  // match are shown, a "⋯" standing for each stretch left out - a card
  // cannot scroll to a match, so this is how a long note gets to one.
  function cardItems(docIn, { maxBlocks = 80, terms = null, only = false } = {}) {
    const doc = fmt.normaliseDoc(docIn);
    const searching = !!(terms && terms.length);
    const matches = doc.map(b => (searching ? search.findMatches(b.runs.map(r => r.text).join(''), terms) : []));
    const hits = matches.reduce((n, m) => n + m.length, 0);
    const filter = only && searching;
    const items = [];
    const counters = [0, 0, 0, 0];
    let lines = [];
    const flush = () => {
      // Empty lines at either end of a stretch of text add nothing.
      while (lines.length && !lines[0]) lines.shift();
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      if (lines.length) items.push({ kind: 'text', html: lines.join('<br>') });
      lines = [];
    };
    let shown = 0;
    let wanted = 0;
    let last = -1;
    for (let i = 0; i < doc.length; i++) {
      const b = doc[i];
      // Numbers are counted over the whole note, shown or not.
      let number = 0;
      if (!fmt.LISTS.has(b.type)) counters.fill(0);
      else {
        for (let l = b.level + 1; l < counters.length; l++) counters[l] = 0;
        if (b.type === 'ol') number = ++counters[b.level];
        else counters[b.level] = 0;
      }
      if (filter && !matches[i].length) continue;
      wanted++;
      if (shown >= maxBlocks) continue;
      shown++;
      if (filter && last >= 0 && i > last + 1) lines.push(grey('\u22ef'));
      last = i;
      const inner = runsHtml(b.runs, matches[i]);
      const pad = INDENT.repeat(b.level);
      if (b.type === 'check') {
        flush();
        items.push({ kind: 'check', index: i, html: pad + (inner || grey('(empty)')), checked: b.checked });
      } else if (b.type === 'ol') {
        lines.push(`${pad}${number}.\u2002${inner}`);
      } else if (b.type === 'ul') {
        lines.push(`${pad}\u2022\u2002${inner}`);
      } else {
        lines.push(/^h[123]$/.test(b.type) && inner ? `<b>${inner}</b>` : inner);
      }
    }
    flush();
    return { items, hidden: wanted - shown, hits, filtered: filter };
  }

  // ── Search results ───────────────────────────────────────────────────

  // One note in a list of search results: its title and up to `max`
  // stretches of its text around the matches, all with the matches
  // marked, and how many matches there are. Gmail finds a note by words
  // anywhere in it, so a note can come back with nothing to mark.
  function searchResult(title, docIn, terms, { context = 40, max = 2 } = {}) {
    const text = fmt.docText(fmt.normaliseDoc(docIn));
    const inTitle = search.findMatches(title, terms);
    const inText = search.findMatches(text, terms);
    const excerpts = search.excerpts(text, inText, { context, max })
      .map(e => `${e.cutBefore ? '\u2026' : ''}${highlight(e.text, e.marks)}${e.cutAfter ? '\u2026' : ''}`);
    return { titleHtml: highlight(title, inTitle), excerpts, count: inTitle.length + inText.length };
  }

  const matchCount = n => `${n} match${n === 1 ? '' : 'es'}`;

  // ── Changing a note ──────────────────────────────────────────────────

  // Ticks from the card's boxes. Only the boxes that were on the card
  // (`indices`) are read: an item past the end of a long note keeps its
  // state, rather than reading as unticked because it had no box.
  function applyTicks(docIn, indices, ticked) {
    const doc = fmt.normaliseDoc(docIn).map(b => ({ ...b }));
    for (const i of indices || []) {
      if (doc[i] && doc[i].type === 'check') doc[i].checked = ticked.has(i);
    }
    return doc;
  }

  // Typed lines as blocks: each line a checklist item or a bullet, or -
  // as text - read like a paste, so "- milk" or "**bold**" still mean
  // what they would on a computer. Leading spaces indent list items.
  function linesToBlocks(text, as = 'p') {
    const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && !lines[0].trim()) lines.shift();
    if (!lines.length) return [];
    if (as === 'check' || as === 'ul' || as === 'ol') {
      return fmt.normaliseDoc(lines.filter(l => l.trim()).map(l => {
        const m = /^( *)(?:[-*+•]\s+|\d{1,3}[.)]\s+)?(?:\[([ xX]?)\]\s*|([☐☑])\s*)?(.*)$/.exec(l);
        const level = Math.floor(m[1].length / 2);
        const checked = m[2] === 'x' || m[2] === 'X' || m[3] === '☑';
        return fmt.block(as, [{ text: m[4].trim() }], { level, checked: as === 'check' && checked });
      }));
    }
    const joined = lines.join('\n');
    return fmt.looksLikeMarkdown(joined) ? fmt.fromMarkdown(joined) : fmt.normaliseDoc(lines.map(l => fmt.block('p', [{ text: l }])));
  }

  const blank = b => b.type === 'p' && !b.runs.some(r => r.text.trim());

  // New blocks at the end, in place of any empty lines the note ends with.
  function appendBlocks(docIn, blocks) {
    const doc = fmt.normaliseDoc(docIn).slice();
    if (!blocks.length) return doc;
    while (doc.length && blank(doc[doc.length - 1])) doc.pop();
    return fmt.normaliseDoc(doc.concat(blocks));
  }

  // Ticks not saved yet, carried from one card to the next as "3.1,5.0"
  // (block index, ticked or not) when the card is redrawn - by Find, say -
  // so redrawing never quietly drops one.
  function encodeTicks(map) {
    return Object.keys(map || {}).map(Number).sort((x, y) => x - y).map(i => `${i}.${map[i] ? 1 : 0}`).join(',');
  }

  function decodeTicks(s) {
    const out = {};
    String(s || '').split(',').forEach(part => {
      const m = /^(\d+)\.([01])$/.exec(part);
      if (m) out[Number(m[1])] = m[2] === '1';
    });
    return out;
  }

  // A doc with ticks applied from such a map.
  function withTicks(doc, map) {
    const indices = Object.keys(map || {}).map(Number);
    return applyTicks(doc, indices, new Set(indices.filter(i => map[i])));
  }

  function docsEqual(a, b) {
    return JSON.stringify(fmt.normaliseDoc(a)) === JSON.stringify(fmt.normaliseDoc(b));
  }

  // ── Folders and the list ─────────────────────────────────────────────

  const folderPath = f => f.path.split('/').join(' › ');

  function folderName(folderId, folders) {
    const f = (folders || []).find(x => x.id === folderId);
    return f ? folderPath(f) : '';
  }

  // Dropdown items: a first one standing for no folder (or every folder,
  // in the list's filter), then the tree. Dropdown values must not be
  // empty, so the first has a value of its own.
  function folderOptions(folders, selected, { first = 'No folder', firstValue = 'none' } = {}) {
    const known = (folders || []).some(f => f.id === selected);
    return [{ text: first, value: firstValue, selected: !known }]
      .concat((folders || []).map(f => ({ text: folderPath(f), value: f.id, selected: f.id === selected })));
  }

  // One line under a note's title in the list: where it is and when it
  // last changed.
  function noteSubtitle(note, folders, now = Date.now()) {
    const where = folderName(note.folderId, folders);
    const when = util.relativeDate(note.updated, now);
    return [where, when ? `edited ${when}` : ''].filter(Boolean).join(' · ');
  }

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

  function boardOptions(columns, currentId) {
    const known = columns.some(c => c.id === currentId);
    return [{ text: 'Not on the board', value: 'none', selected: !known }]
      .concat(columns.map(c => ({ text: c.title, value: c.id, selected: c.id === currentId })));
  }

  // ── Message ids ──────────────────────────────────────────────────────

  // Gmail's API names a message by a hexadecimal id. Gmail's own pages
  // name it in decimal ("msg-f:1849…"); should one arrive that way, it is
  // the same number.
  function apiMessageId(id) {
    const s = String(id || '').trim();
    const m = /^msg-[af]:(\d+)$/.exec(s) || /^(\d{18,})$/.exec(s);
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

  const api = {
    esc, runsHtml, highlight, cardItems, searchResult, matchCount, applyTicks, encodeTicks, decodeTicks, withTicks, linesToBlocks, appendBlocks, docsEqual,
    folderName, folderOptions, noteSubtitle, apiMessageId,
    boardColumns, currentColumn, boardDiff, boardOptions,
  };

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

// ════ addon/src/cards.js ══════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// The phone panel's cards
//
// Gmail shows an add-on at the bottom of an open message on a phone,
// and beside it on a computer. Opened on a note, the panel shows that
// note: its text, a real check box for each checklist item, a box for
// lines to add at the end, and its folder - with one Save for the lot.
// Opened on any other email, it starts with that email's place on the
// board - a column to choose, applied at once, as the button next to
// Board does in Chrome - and then, as from Gmail's side panel with
// nothing open, the newest notes, a search, and New note.
//
// Saving works as in the extension: a new version is inserted and the
// old one goes to Trash. If the note changed elsewhere since the card
// was drawn, nothing is saved and the latest version is shown instead,
// with the lines that were being added still in their box.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const store = ns.addonStore;
  const panel = ns.panelLogic;
  const fmt = ns.noteFormat;

  const NAME = ns.APP_NAME;
  const LIST_SIZE = 20;
  const MAX_BLOCKS = 80;
  const GREY = '#5f6368';
  const LINE_KINDS = { check: 'Checklist items', ul: 'Bullets', p: 'Text' };

  // ── Event objects ────────────────────────────────────────────────────

  function formValues(e) {
    const out = {};
    const inputs = (e && e.commonEventObject && e.commonEventObject.formInputs) || {};
    Object.keys(inputs).forEach(k => {
      const v = inputs[k] && inputs[k].stringInputs && inputs[k].stringInputs.value;
      out[k] = Array.isArray(v) ? v.map(String) : [];
    });
    // The older shape of the same thing.
    const legacy = (e && e.formInputs) || {};
    Object.keys(legacy).forEach(k => { if (!(k in out)) out[k] = [].concat(legacy[k]).map(String); });
    return out;
  }

  function value(e, name) {
    const v = formValues(e)[name];
    return v && v.length ? v[0] : '';
  }

  const params = e => (e && e.commonEventObject && e.commonEventObject.parameters) || (e && e.parameters) || {};

  // A folder chosen in a dropdown: its label id, or '' for none.
  const chosenFolder = (ctx, v) => (ctx.folders.some(f => f.id === v) ? v : '');

  // ── Building blocks ──────────────────────────────────────────────────

  const html = s => CardService.newTextParagraph().setText(s);
  const greyText = s => html(`<font color="${GREY}">${panel.esc(s)}</font>`);

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

  function dropdown(name, title, options, onChange) {
    const s = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setTitle(title)
      .setFieldName(name);
    options.forEach(o => s.addItem(o.text, o.value, o.selected));
    if (onChange) s.setOnChangeAction(onChange);
    return s;
  }

  function textInput(name, title, { hint = '', multiline = false, value: v = '' } = {}) {
    const t = CardService.newTextInput().setFieldName(name).setTitle(title);
    if (hint) t.setHint(hint);
    if (multiline) t.setMultiline(true);
    if (v) t.setValue(v);
    return t;
  }

  function lineKinds(selected) {
    return Object.keys(LINE_KINDS).map(v => ({ text: LINE_KINDS[v], value: v, selected: v === selected }));
  }

  function respond({ card, push = false, notify = '', changed = false }) {
    const r = CardService.newActionResponseBuilder();
    if (card) r.setNavigation(push ? CardService.newNavigation().pushCard(card) : CardService.newNavigation().updateCard(card));
    if (notify) r.setNotification(CardService.newNotification().setText(notify));
    if (changed) r.setStateChanged(true);
    return r.build();
  }

  // ── The list ─────────────────────────────────────────────────────────

  // The open email's column. Choosing another moves it straight away.
  function boardSection(ctx, thread) {
    const cur = panel.currentColumn(ctx.board, thread.labelIds);
    return CardService.newCardSection()
      .setHeader('This email on the board')
      .addWidget(dropdown('boardColumn', 'Column', panel.boardOptions(ctx.board, cur ? cur.id : ''),
        action('onMoveThread', { threadId: thread.id })));
  }

  // `thread`: the open email's conversation, if there is one - its place on
  // the board comes first.
  function homeCard(ctx, { folderId = '', query = '', thread = null } = {}) {
    const { notes, more } = store.list(ctx, { folderId, query, max: LIST_SIZE });
    const where = (folderId && panel.folderName(folderId, ctx.folders)) || 'All notes';
    const keep = { threadId: thread ? thread.id : '' };

    const find = CardService.newCardSection()
      .setHeader('Notes')
      .addWidget(textInput('q', 'Search notes', { value: query }))
      .addWidget(dropdown('folderFilter', 'Folder',
        panel.folderOptions(ctx.folders, folderId, { first: 'All notes', firstValue: 'all' }), action('onFilterNotes', keep)))
      .addWidget(CardService.newButtonSet().addButton(button('Search', 'onSearchNotes', keep)));

    const list = CardService.newCardSection().setHeader(query ? `${where}: “${query}”` : where);
    if (!notes.length) list.addWidget(greyText(query ? 'No notes match that search.' : 'No notes here yet.'));
    const terms = query ? ns.searchLogic.queryTerms(query) : [];
    notes.forEach(n => {
      const item = CardService.newDecoratedText()
        .setWrapText(true)
        .setOnClickAction(action('onOpenNote', { messageId: n.messageId, q: query }));
      let sub = panel.noteSubtitle(n, ctx.folders);
      const snippet = String(n.snippet || '').replace(/\s+/g, ' ').trim();
      if (terms.length && n.doc) {
        // A search result: where the words are, as in Chrome.
        const r = panel.searchResult(n.title, n.doc, terms);
        item.setText(r.excerpts.length ? `${r.titleHtml}<br>${r.excerpts.join('<br>')}` : r.titleHtml);
        if (r.count) sub = [sub, panel.matchCount(r.count)].filter(Boolean).join(' \u00b7 ');
        else if (snippet) item.setBottomLabel(snippet.length > 90 ? `${snippet.slice(0, 89)}…` : snippet);
      } else {
        item.setText(panel.esc(n.title));
        if (snippet) item.setBottomLabel(snippet.length > 90 ? `${snippet.slice(0, 89)}…` : snippet);
      }
      if (sub) item.setTopLabel(sub);
      list.addWidget(item);
    });
    if (more) list.addWidget(greyText(`The newest ${LIST_SIZE} are shown. Search to find older notes.`));

    const card = CardService.newCardBuilder()
      .setName('home')
      .setHeader(CardService.newCardHeader().setTitle(thread && ctx.board.length ? 'Board and notes' : 'Notes').setSubtitle(NAME));
    if (thread && ctx.board.length) card.addSection(boardSection(ctx, thread));
    return card
      .addSection(find)
      .addSection(list)
      .setFixedFooter(CardService.newFixedFooter().setPrimaryButton(button('New note', 'onNewNote', { folderId }, true)))
      .build();
  }

  // ── One note ─────────────────────────────────────────────────────────

  // `query`: the words marked - from the search the note was opened
  // from, or typed into Find; `only`: just the lines with them. `pending`
  // ({ index: ticked }) and the other state are what the person had done
  // on the card before it was redrawn, kept so a Find loses nothing.
  function noteCard(ctx, opened, { addText = '', addAs = '', notice = '', query = '', only = false, pending = {}, folderId = null } = {}) {
    const { note } = opened;
    const doc = panel.withTicks(opened.doc, pending);
    const terms = query ? ns.searchLogic.queryTerms(query) : [];
    const { items, hidden, hits, filtered } = panel.cardItems(doc, { maxBlocks: MAX_BLOCKS, terms, only });
    const checks = items.filter(it => it.kind === 'check').map(it => it.index);
    // Unsaved ticks on lines this card does not show travel with Save.
    const offCard = {};
    Object.keys(pending).forEach(i => { if (checks.indexOf(Number(i)) < 0) offCard[i] = pending[i]; });
    const state = { messageId: note.messageId, checks: checks.join(','), pending: panel.encodeTicks(offCard) };

    const find = CardService.newCardSection()
      .addWidget(textInput('find', 'Find in this note', { value: query }));
    const findButtons = CardService.newButtonSet().addButton(button('Find', 'onFindInNote', Object.assign({ only: only ? '1' : '' }, state)));
    if (terms.length) {
      findButtons
        .addButton(button(only ? 'Whole note' : 'Only lines with it', 'onFindInNote', Object.assign({ only: only ? '' : '1' }, state)))
        .addButton(button('Clear', 'onFindInNote', Object.assign({ clear: '1' }, state)));
    }
    find.addWidget(findButtons);

    const body = CardService.newCardSection();
    if (notice) body.addWidget(html(`<font color="${GREY}"><i>${panel.esc(notice)}</i></font>`));
    if (terms.length) {
      // The title is the card's header, which cannot be marked, so it is
      // only mentioned.
      const inTitle = ns.searchLogic.findMatches(note.title, terms).length > 0;
      const q = `\u201c${query}\u201d`;
      let what = `${q} is not in the text itself`;
      if (hits) what = `${panel.matchCount(hits)} for ${q}${inTitle ? ', and in the title' : ''}${filtered ? ' \u00b7 only the lines with them' : ''}`;
      else if (inTitle) what = `${q} is in the title only`;
      body.addWidget(greyText(what));
    }
    items.forEach(it => {
      if (it.kind === 'text') {
        body.addWidget(html(it.html));
        return;
      }
      body.addWidget(CardService.newDecoratedText()
        .setText(it.html)
        .setWrapText(true)
        .setSwitchControl(CardService.newSwitch()
          .setFieldName(`c${it.index}`)
          .setValue('1')
          .setSelected(it.checked)
          .setControlType(CardService.SwitchControlType.CHECK_BOX)));
    });
    if (!items.length && !terms.length) body.addWidget(greyText('This note is empty.'));
    if (!items.length && terms.length && filtered) body.addWidget(greyText('No line has it.'));
    if (hidden) body.addWidget(greyText(`…and ${hidden} more line${hidden === 1 ? '' : 's'}. Open the note in Gmail to see the rest.`));

    const add = CardService.newCardSection()
      .setHeader('Add to the end')
      .addWidget(textInput('add', 'New lines', { hint: 'One item per line', multiline: true, value: addText }))
      .addWidget(dropdown('addAs', 'Add as', lineKinds(addAs || (checks.length ? 'check' : 'p'))));

    const where = CardService.newCardSection()
      .setHeader('Folder')
      .addWidget(dropdown('folder', 'Folder', panel.folderOptions(ctx.folders, folderId === null ? note.folderId : folderId)))
      .addWidget(CardService.newButtonSet()
        .addButton(button('All notes', 'onAllNotes'))
        .addButton(button('New note', 'onNewNote', { folderId: note.folderId || '' })));

    const subtitle = [panel.noteSubtitle(note, ctx.folders), note.own ? '' : 'an email kept as a note'].filter(Boolean).join(' \u00b7 ');
    return CardService.newCardBuilder()
      .setName('note')
      .setHeader(CardService.newCardHeader().setTitle(note.title).setSubtitle(subtitle || 'No folder'))
      .addSection(find)
      .addSection(body)
      .addSection(add)
      .addSection(where)
      .setFixedFooter(CardService.newFixedFooter()
        .setPrimaryButton(button('Save', 'onSaveNote', Object.assign({ q: query, only: only ? '1' : '' }, state), true)))
      .build();
  }

  // Everything done on a note's card and not saved yet: ticks (those on
  // the card, and those carried from an earlier card), lines to add, and
  // the folder chosen.
  function cardState(e, ctx) {
    const p = params(e);
    const pending = panel.decodeTicks(p.pending);
    String(p.checks || '').split(',').filter(Boolean).forEach(i => { pending[Number(i)] = value(e, `c${i}`) !== ''; });
    return { pending, addText: value(e, 'add'), addAs: value(e, 'addAs') || 'p', folderId: chosenFolder(ctx, value(e, 'folder')) };
  }

  // The note behind a message as it is now: the message itself while it
  // is the current version, otherwise the version that replaced it.
  function current(ctx, messageId) {
    const opened = store.open(ctx, messageId);
    const newer = store.newerVersion(ctx, opened.note);
    if (newer) return { opened: store.open(ctx, newer.messageId), replaced: true, gone: false };
    return { opened, replaced: false, gone: !(opened.note.inNotes && !opened.note.trashed) };
  }

  function noticeFor(c) {
    if (c.replaced) return 'This is the latest version of this note.';
    if (c.gone && c.opened.note.trashed) return 'This note is in Trash. Saving it brings it back.';
    if (c.gone) return 'This email is no longer kept as a note. Saving it makes it one again.';
    return '';
  }

  function newNoteCard(ctx, folderId) {
    const section = CardService.newCardSection()
      .addWidget(textInput('title', 'Title'))
      .addWidget(textInput('body', 'Note', { hint: 'One item per line for a list', multiline: true }))
      .addWidget(dropdown('bodyAs', 'Lines are', lineKinds('p')))
      .addWidget(dropdown('folder', 'Folder', panel.folderOptions(ctx.folders, folderId || '')));
    return CardService.newCardBuilder()
      .setName('new')
      .setHeader(CardService.newCardHeader().setTitle('New note').setSubtitle(NAME))
      .addSection(section)
      .setFixedFooter(CardService.newFixedFooter().setPrimaryButton(button('Save note', 'onCreateNote', null, true)))
      .build();
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
    return CardService.newCardBuilder()
      .setName('error')
      .setHeader(CardService.newCardHeader().setTitle(NAME).setSubtitle('Something went wrong'))
      .addSection(CardService.newCardSection().addWidget(greyText(explain(err))))
      .build();
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
  const universal = fn => e => {
    let card;
    try { card = fn(e); } catch (err) { log(err); card = errorCard(err); }
    return CardService.newUniversalActionResponseBuilder().displayAddOnCards([card]).build();
  };

  // ── Triggers and buttons ─────────────────────────────────────────────

  const onHomepage = cards(() => [homeCard(store.context())]);

  // A message was opened: its note if it is one, the list if not.
  const onGmailMessage = cards(e => {
    const ctx = store.context();
    const g = (e && e.gmail) || (e && e.messageMetadata) || {};
    const id = panel.apiMessageId(g.messageId);
    let peeked = null;
    if (id) {
      try { peeked = store.peek(ctx, id); } catch (err) { log(err); }
    }
    if (peeked && (peeked.own || peeked.inNotes)) {
      const c = current(ctx, id);
      return [noteCard(ctx, c.opened, { notice: noticeFor(c) })];
    }
    let thread = null;
    if (peeked && peeked.threadId && ctx.board.length) {
      try { thread = store.thread(ctx, peeked.threadId); } catch (err) { log(err); }
    }
    return [homeCard(ctx, { thread })];
  });

  const onOpenNote = act(e => {
    const ctx = store.context();
    const p = params(e);
    const c = current(ctx, p.messageId);
    return respond({ card: noteCard(ctx, c.opened, { notice: noticeFor(c), query: p.q || '' }), push: true });
  });

  const onAllNotes = act(() => respond({ card: homeCard(store.context()), push: true }));

  const onNewNote = act(e => {
    const ctx = store.context();
    return respond({ card: newNoteCard(ctx, chosenFolder(ctx, params(e).folderId)), push: true });
  });

  const onSearchNotes = act(e => {
    const ctx = store.context();
    const threadId = params(e).threadId;
    return respond({
      card: homeCard(ctx, {
        folderId: chosenFolder(ctx, value(e, 'folderFilter')),
        query: value(e, 'q').trim(),
        thread: threadId && ctx.board.length ? store.thread(ctx, threadId) : null,
      }),
    });
  });

  // A column chosen for the open email. The dropdown already shows the
  // choice, so only a confirmation comes back - which keeps it quick.
  const onMoveThread = act(e => {
    const ctx = store.context();
    const threadId = params(e).threadId;
    if (!threadId) return respond({ notify: 'Open an email first.' });
    const target = ctx.board.find(c => c.id === value(e, 'boardColumn')) || null;
    store.moveThread(ctx, threadId, target ? target.id : '');
    let said = 'Taken off the board.';
    if (target) said = target.archiveOnDrop ? `Moved to ${target.title} and archived.` : `Moved to ${target.title}.`;
    return respond({ notify: said, changed: true });
  });

  // Find in the open note: mark the words typed, show only the lines with
  // them, or clear - redrawing the card with nothing that was done on it
  // lost.
  const onFindInNote = act(e => {
    const ctx = store.context();
    const p = params(e);
    const st = cardState(e, ctx);
    const c = current(ctx, p.messageId);
    const query = p.clear ? '' : value(e, 'find').trim();
    const keep = c.replaced ? {} : st.pending; // ticks belong to the version they were made on
    return respond({
      card: noteCard(ctx, c.opened, {
        query, only: !!query && p.only === '1', pending: keep, addText: st.addText, addAs: st.addAs, folderId: st.folderId,
        notice: c.replaced ? 'This note was changed somewhere else in the meantime. This is the latest version.' : noticeFor(c),
      }),
    });
  });

  const onSaveNote = act(e => {
    const ctx = store.context();
    const p = params(e);
    const { pending, addText, addAs, folderId } = cardState(e, ctx);
    const query = p.q || '';
    const only = p.only === '1';

    const c = current(ctx, p.messageId);
    if (c.replaced) {
      return respond({
        card: noteCard(ctx, c.opened, {
          addText, addAs, query, only,
          notice: 'This note was changed somewhere else in the meantime. Here is the latest version: tick again, then save.',
        }),
        notify: 'Not saved: the note had changed.',
      });
    }

    const { note, doc } = c.opened;
    const next = panel.appendBlocks(panel.withTicks(doc, pending), panel.linesToBlocks(addText, addAs));
    const contentChanged = !panel.docsEqual(next, doc);
    const folderChanged = folderId !== note.folderId;
    if (!contentChanged && !folderChanged && !c.gone) return respond({ notify: 'Nothing to save.' });

    let id = note.messageId;
    let said;
    if (contentChanged || c.gone) {
      id = store.save(ctx, note, { title: note.title, doc: next, folderId });
      said = 'Saved.';
    } else {
      store.move(ctx, id, folderId);
      said = folderId ? `Moved to ${panel.folderName(folderId, ctx.folders)}.` : 'Taken out of its folder.';
    }
    return respond({ card: noteCard(ctx, store.open(ctx, id), { query, only }), notify: said, changed: true });
  });

  const onCreateNote = act(e => {
    const ctx = store.context();
    const title = value(e, 'title').trim();
    const blocks = panel.linesToBlocks(value(e, 'body'), value(e, 'bodyAs') || 'p');
    if (!title && !blocks.length) return respond({ notify: 'Write a title or some text first.' });
    const id = store.save(ctx, null, { title, doc: blocks.length ? blocks : fmt.emptyDoc(), folderId: chosenFolder(ctx, value(e, 'folder')) });
    return respond({ card: noteCard(ctx, store.open(ctx, id)), notify: 'Note saved.', changed: true });
  });

  const onUniversalAllNotes = universal(() => homeCard(store.context()));
  const onUniversalNewNote = universal(() => newNoteCard(store.context(), ''));

  ns.panel = {
    onHomepage, onGmailMessage, onOpenNote, onAllNotes, onNewNote, onSearchNotes,
    onFilterNotes: onSearchNotes, onSaveNote, onFindInNote, onCreateNote, onMoveThread, onUniversalAllNotes, onUniversalNewNote,
  };
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
// cards' buttons - so they are plain top-level functions. Each one
// hands over to the panel.
// ─────────────────────────────────────────────────────────────────────

function onHomepage(e) { return gkb.panel.onHomepage(e); }
function onGmailMessage(e) { return gkb.panel.onGmailMessage(e); }
function onOpenNote(e) { return gkb.panel.onOpenNote(e); }
function onAllNotes(e) { return gkb.panel.onAllNotes(e); }
function onNewNote(e) { return gkb.panel.onNewNote(e); }
function onSearchNotes(e) { return gkb.panel.onSearchNotes(e); }
function onFilterNotes(e) { return gkb.panel.onFilterNotes(e); }
function onSaveNote(e) { return gkb.panel.onSaveNote(e); }
function onFindInNote(e) { return gkb.panel.onFindInNote(e); }
function onCreateNote(e) { return gkb.panel.onCreateNote(e); }
function onMoveThread(e) { return gkb.panel.onMoveThread(e); }
function onUniversalAllNotes(e) { return gkb.panel.onUniversalAllNotes(e); }
function onUniversalNewNote(e) { return gkb.panel.onUniversalNewNote(e); }

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
"LmdrYiB8fCB7fSk7CgogIGNvbnN0IEFQUF9OQU1FID0gJ01lbURlc2snOwoKICAvLyDilIDilIAgU3RvcmFnZSBrZXlzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gS2V5ZWQgYnkgbG93ZXItY2FzZWQgYWNjb3VudCBlbWFpbCwgYmVjYXVzZSBhIEdtYWlsIHRhYiBhdCAvdS8xLyBpcyBhCiAgLy8gZGlmZmVyZW50IG1haWxib3ggd2l0aCBkaWZmZXJlbnQgbGFiZWxzLCBhbmQgb25lIHBlcnNvbidzIGNvbHVtbgogIC8vIGxheW91dCBtdXN0IG5vdCBsZWFrIGludG8gYW5vdGhlciBhY2NvdW50J3MgYm9hcmQuCgogIGNvbnN0IEtFWVMgPSB7CiAgICBjbGllbnRJZDogJ2NsaWVudElkJywgICAgICAgICAgICAgICAgICAgICAgICAvLyBzdG9yYWdlLnN5bmMKICAgIGRvY2tQb3NpdGlvbjogJ2RvY2tQb3NpdGlvbicsICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgY29sdW1uczogZW1haWwgPT4gYGNvbHVtbnM6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgLy8gc3RvcmFnZS5zeW5jCiAgICBvcmRlcjogZW1haWwgPT4gYG9yZGVyOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsICAgICAvLyBzdG9yYWdlLmxvY2FsCiAgICAv",
"LyBDYXJkIGVkaXRzIGdldCBvbmUga2V5IHBlciBjYXJkIHJhdGhlciB0aGFuIG9uZSBtYXAgcGVyIGFjY291bnQ6CiAgICAvLyBzeW5jIGNhcHMgZWFjaCBpdGVtIGF0IDggS0IsIHdoaWNoIGEgc2luZ2xlIG1hcCB3b3VsZCBvdXRncm93IGFmdGVyCiAgICAvLyBhIGZldyBkb3plbiBub3Rlcywgd2hpbGUgdGhlIDUxMi1pdGVtIGNhcCBsZWF2ZXMgcm9vbSBmb3IgaHVuZHJlZHMuCiAgICBjYXJkUHJlZml4OiBlbWFpbCA9PiBgY2FyZDoke1N0cmluZyhlbWFpbCkudG9Mb3dlckNhc2UoKX06YCwgICAgICAgICAgICAgICAgICAvLyBzdG9yYWdlLnN5bmMKICAgIGNhcmQ6IChlbWFpbCwgdGhyZWFkSWQpID0-IGBjYXJkOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfToke3RocmVhZElkfWAsIC8vIHN0b3JhZ2Uuc3luYwogICAgbm90ZXM6IGVtYWlsID0-IGBub3Rlczoke1N0cmluZyhlbWFpbCkudG9Mb3dlckNhc2UoKX1gLCAgICAgLy8gc3RvcmFnZS5zeW5jOiB7IGxhYmVsLCBsYWJlbElkIH0KICAgIHZpZXc6ICd2aWV3JywgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2UubG9jYWw6ICdib2FyZCcgfCAnbm90ZXMnCiAgICBwcmVmOiAoZW1haWwsIG5hbWUpID0-IGBwcmVmOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfToke25hbWV9YCwgLy8gc3RvcmFnZS5sb2NhbDogdGhlIG5vdGVzJyBzbWFsbCBwcmVmZXJlbmNlcwogICAgdG9rZW46IGVtYWlsID0-IGB0b2tlbjoke1N0",
"cmluZyhlbWFpbCkudG9Mb3dlckNhc2UoKX1gLCAgICAgLy8gc3RvcmFnZS5zZXNzaW9uCiAgICBjYWxlbmRhclRva2VuOiBlbWFpbCA9PiBgY3Rva2VuOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsIC8vIHN0b3JhZ2Uuc2Vzc2lvbjogdGhlIGNhbGVuZGFyJ3Mgb3duIHNpZ24taW4KICAgIGdtYWlsVGFiczogJ2dtYWlsVGFicycsICAgICAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc2Vzc2lvbgogIH07CgogIC8vIEVsZW1lbnQgaWRzIGZvciB0aGUgdHdvIHNoYWRvdyBob3N0cy4gU2hvcnQgYW5kIG5hbWVzcGFjZWQgcmF0aGVyIHRoYW4KICAvLyBicmFuZGVkLCBzbyB0aGV5IHN1cnZpdmUgYSByZW5hbWUgYW5kIGFyZSB1bmxpa2VseSB0byBjbGFzaCB3aXRoIEdtYWlsLgogIGNvbnN0IEhPU1RfSURTID0gewogICAgYm9hcmQ6ICdna2ItYm9hcmQtaG9zdCcsCiAgICBkb2NrOiAnZ2tiLWRvY2staG9zdCcsCiAgfTsKCiAgLy8gVGhlIHB1Ymxpc2hlcidzIG93biBPQXV0aCBjbGllbnQsIGZvciB0aGUgYnVpbGQgdGhhdCBnb2VzIHRvIHRoZQogIC8vIENocm9tZSBXZWIgU3RvcmU6IHdpdGggaXQsIGEgdXNlciBqdXN0IGNsaWNrcyAiQ29ubmVjdCBHbWFpbCIgYW5kIG5lZWRzCiAgLy8gbm8gR29vZ2xlIENsb3VkIHByb2plY3Qgb2YgdGhlaXIgb3duLiBFbXB0eSBoZXJlLCBvbiBwdXJwb3NlOgogIC8vIHRvb2xzL3BhY2thZ2UtZXh0ZW5zaW9uLm1qcyB3cml0ZXMgaXQgaW50byB0aGUgc3RvcmUg",
"YnVpbGQgb25seSwgc28gYQogIC8vIGNvcHkgbG9hZGVkIGZyb20gdGhpcyByZXBvc2l0b3J5IChvciBhIGZvcmspIGJyaW5ncyBpdHMgb3duIGNsaWVudCwKICAvLyBhcyBTRVRVUC5tZCBkZXNjcmliZXMsIHJhdGhlciB0aGFuIHVzaW5nIHVwIHRoZSBwdWJsaXNoZXIncyBxdW90YSBvZgogIC8vIHVzZXJzLiBBIGNsaWVudCBJRCBzYXZlZCBvbiB0aGUgc2V0dXAgcGFnZSBhbHdheXMgd2lucy4KICBjb25zdCBCVUlMVF9JTl9DTElFTlRfSUQgPSAnJzsKCiAgbnMuQVBQX05BTUUgPSBBUFBfTkFNRTsKICBucy5CVUlMVF9JTl9DTElFTlRfSUQgPSBCVUlMVF9JTl9DTElFTlRfSUQ7CiAgbnMuS0VZUyA9IEtFWVM7CiAgbnMuSE9TVF9JRFMgPSBIT1NUX0lEUzsKCiAgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSB7CiAgICBtb2R1bGUuZXhwb3J0cyA9IHsgQVBQX05BTUUsIEtFWVMsIEhPU1RfSURTIH07CiAgfQp9KSgpOwo\"],[\"src/lib/util.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNtYWxsIHB1cmUgaGVscGVycwovLwovLyBOb3",
"RoaW5nIGluIGhlcmUgdG91Y2hlcyB0aGUgRE9NLCBjaHJvbWUuKiBvciB0aGUgbmV0d29yaywgd2hpY2ggaXMgd2hhdAovLyBsZXRzIHRoZSBOb2RlIHRlc3RzIHJlcXVpcmUgdGhpcyBmaWxlIGRpcmVjdGx5LiBUaGUgY29udGVudCBzY3JpcHRzIGFuZAovLyB0aGUgc2VydmljZSB3b3JrZXIgcmVhY2ggdGhlIHNhbWUgZnVuY3Rpb25zIHRocm91Z2ggdGhlIHNoYXJlZAovLyBuYW1lc3BhY2UgKG5zLnV0aWwpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8g4pSA4pSAIEhlYWRlciBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBoZWFkZXJNYXAobWVzc2FnZSkgewogIC",
"AgY29uc3Qgb3V0ID0ge307CiAgICBjb25zdCBoZWFkZXJzID0gKG1lc3NhZ2UgJiYgbWVzc2FnZS5wYXlsb2FkICYmIG1lc3NhZ2UucGF5bG9hZC5oZWFkZXJzKSB8fCBbXTsKICAgIGZvciAoY29uc3QgaCBvZiBoZWFkZXJzKSBvdXRbaC5uYW1lLnRvTG93ZXJDYXNlKCldID0gaC52YWx1ZSB8fCAnJzsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyAiQW5uYSBWb3MgPGFubmFAZXhhbXBsZS5jb20-IiDihpIgeyBuYW1lLCBlbWFpbCB9CiAgZnVuY3Rpb24gcGFyc2VBZGRyZXNzKHJhdykgewogICAgaWYgKCFyYXcpIHJldHVybiB7IG5hbWU6ICcnLCBlbWFpbDogJycgfTsKICAgIGNvbnN0IGFuZ2xlZCA9IHJhdy5tYXRjaCgvXlxzKiguKj8pXHMqPChbXj5dKyk-XHMqJC8pOwogICAgaWYgKGFuZ2xlZCkgewogICAgICByZXR1cm4gewogICAgICAgIG5hbWU6IGFuZ2xlZFsxXS5yZXBsYWNlKC9eWyInXXxbIiddJC9nLCAnJykudHJpbSgpLAogICAgICAgIGVtYWlsOiBhbmdsZWRbMl0udHJpbSgpLnRvTG93ZXJDYXNlKCksCiAgICAgIH07CiAgICB9CiAgICByZXR1cm4geyBuYW1lOiAnJywgZW1haWw6IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKSB9OwogIH0KCiAgLy8gV2hhdCB0byBjYWxsIGEgc2VuZGVyIG9uIGEgY2FyZC4gQSBiYXJlIGFkZHJlc3MgaXMgc2hvcnRlbmVkIHRvIGl0cwogIC8vIGxvY2FsIHBhcnQsIGJlY2F1c2UgImFjY291bnRzIiByZWFkcyBiZXR0ZXIgaW4gYSBuYXJyb3cgY29sdW1uIHRoYW4KIC",
"AvLyAiYWNjb3VudHNAYnJpZ2h0d2F0ZXItbGFuZ3VhZ2UuZXhhbXBsZSIuCiAgZnVuY3Rpb24gZGlzcGxheU5hbWUoYWRkcikgewogICAgaWYgKCFhZGRyKSByZXR1cm4gJyc7CiAgICBpZiAoYWRkci5uYW1lKSByZXR1cm4gYWRkci5uYW1lOwogICAgcmV0dXJuIChhZGRyLmVtYWlsIHx8ICcnKS5zcGxpdCgnQCcpWzBdOwogIH0KCiAgLy8g4pSA4pSAIEVudGl0aWVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gR21haWwgcmV0dXJucyBzbmlwcGV0cyBIVE1MLWVuY29kZWQuIFRoZSBvYnZpb3VzIGRlY29kZXIgLSBhc3NpZ24gdG8gYQogIC8vIGRldGFjaGVkIGVsZW1lbnQncyBpbm5lckhUTUwgYW5kIHJlYWQgdGV4dENvbnRlbnQgYmFjayAtIGlzIHdoYXQKICAvLyBHbWFpbCdzIFRydXN0ZWQgVHlwZXMgcG9saWN5IGZvcmJpZHMsIGFuZCBpdCB3b3VsZCBhbHNvIG1lYW4gZmVlZGluZwogIC8vIHVudHJ1c3RlZCBtYWlsIHRleHQgdG8gdGhlIEhUTUwgcGFyc2VyLiBBIGxvb2t1cCB0YWJsZSBkb2VzIHRoZSBqb2IuCgogIC8vIFRoZSBoYW5kZnVsIGV2ZXJ5IG1haWwgbmVlZHMsIHBsdXMgdGhlIHR5cG9ncmFwaGljIG9uZXMgdGhhdCBIVE",
"1MCiAgLy8gbWFpbCB3cml0dGVuIGluIEdtYWlsIG9yIE91dGxvb2sgaXMgZnVsbCBvZi4KICBjb25zdCBOQU1FRCA9IHsKICAgIGFtcDogJyYnLCBsdDogJzwnLCBndDogJz4nLCBxdW90OiAnIicsIGFwb3M6ICInIiwgbmJzcDogJ1x1MDBhMCcsCiAgICBsc3F1bzogJ1x1MjAxOCcsIHJzcXVvOiAnXHUyMDE5JywgbGRxdW86ICdcdTIwMWMnLCByZHF1bzogJ1x1MjAxZCcsCiAgICBuZGFzaDogJ1x1MjAxMycsIG1kYXNoOiAnXHUyMDE0JywgaGVsbGlwOiAnXHUyMDI2JywgYnVsbDogJ1x1MjAyMicsIG1pZGRvdDogJ1x1MDBiNycsCiAgICBsYXF1bzogJ1x1MDBhYicsIHJhcXVvOiAnXHUwMGJiJywgZXVybzogJ1x1MjBhYycsIHBvdW5kOiAnXHUwMGEzJywgY29weTogJ1x1MDBhOScsIHJlZzogJ1x1MDBhZScsIHRyYWRlOiAnXHUyMTIyJywKICB9OwoKICBmdW5jdGlvbiBkZWNvZGVFbnRpdGllcyhpbnB1dCkgewogICAgLy8gU2luZ2xlIHBhc3MsIHNvICImYW1wO2x0OyIgYmVjb21lcyB0aGUgbGl0ZXJhbCB0ZXh0ICImbHQ7IiBhbmQgaXMKICAgIC8vIG5vdCBkZWNvZGVkIGEgc2Vjb25kIHRpbWUgaW50byAiPCIuCiAgICByZXR1cm4gU3RyaW5nKGlucHV0ID09IG51bGwgPyAnJyA6IGlucHV0KS5yZXBsYWNlKAogICAgICAvJigjW3hYXVswLTlhLWZBLUZdezEsNn18I1swLTldezEsN318W2EtekEtWl0rKTsvZywKICAgICAgKHdob2xlLCBib2R5KSA9PiB7CiAgICAgICAgaWYgKGJvZHlbMF0gPT09ICcjJykgewogIC",
"AgICAgICAgY29uc3QgaGV4ID0gYm9keVsxXSA9PT0gJ3gnIHx8IGJvZHlbMV0gPT09ICdYJzsKICAgICAgICAgIGNvbnN0IGNvZGUgPSBwYXJzZUludChib2R5LnNsaWNlKGhleCA_IDIgOiAxKSwgaGV4ID8gMTYgOiAxMCk7CiAgICAgICAgICAvLyBPdXQtb2YtcmFuZ2UgYW5kIHN1cnJvZ2F0ZSBjb2RlIHBvaW50cyB3b3VsZCB0aHJvdyBvciBwcm9kdWNlCiAgICAgICAgICAvLyBnYXJiYWdlOyBsZWF2ZSB0aGUgb3JpZ2luYWwgdGV4dCBhbG9uZSBpbnN0ZWFkLgogICAgICAgICAgaWYgKCFpc0Zpbml0ZShjb2RlKSB8fCBjb2RlIDwgMSB8fCBjb2RlID4gMHgxMGZmZmYgfHwKICAgICAgICAgICAgICAoY29kZSA-PSAweGQ4MDAgJiYgY29kZSA8PSAweGRmZmYpKSByZXR1cm4gd2hvbGU7CiAgICAgICAgICByZXR1cm4gU3RyaW5nLmZyb21Db2RlUG9pbnQoY29kZSk7CiAgICAgICAgfQogICAgICAgIGNvbnN0IG5hbWVkID0gTkFNRURbYm9keS50b0xvd2VyQ2FzZSgpXTsKICAgICAgICByZXR1cm4gbmFtZWQgPT09IHVuZGVmaW5lZCA_IHdob2xlIDogbmFtZWQ7CiAgICAgIH0KICAgICk7CiAgfQoKICAvLyDilIDilIAgQWNjb3VudCBkZXRlY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbn",
"N0IEVNQUlMX09OTFlfUkUgPSAvXlteXHNAPD4oKSJdK0BbXlxzQDw-KCkiXStcLlteXHNAPD4oKSJdKyQvOwogIGNvbnN0IEVNQUlMX0FOWV9SRSA9IC9bXlxzQDw-KCkiXStAW15cc0A8PigpIl0rXC5bXlxzQDw-KCkiXSsvOwoKICAvLyBHbWFpbCdzIHRpdGxlIGlzICI8dmlldyBvciBzdWJqZWN0PiAtIDxhY2NvdW50PiAtIDxwcm9kdWN0PiIsIGUuZy4KICAvLyAiSW5ib3ggKDMsNTkxKSAtIHNvbWVvbmVAZXhhbXBsZS5jb20gLSBHbWFpbCIuIFdvcmtzcGFjZSBhY2NvdW50cyBjYW4KICAvLyByZXBsYWNlICJHbWFpbCIgd2l0aCB0aGUgb3JnYW5pc2F0aW9uJ3Mgb3duIG5hbWUsIHNvIHRoZSBwcm9kdWN0IHBhcnQKICAvLyBpcyBub3QgbWF0Y2hlZC4gU2Nhbm5pbmcgZnJvbSB0aGUgcmlnaHQgZmluZHMgdGhlIGFjY291bnQgZXZlbiB3aGVuIGEKICAvLyBzdWJqZWN0IGxpbmUgY29udGFpbnMgYW4gYWRkcmVzcyBvciBhIGRhc2ggb2YgaXRzIG93bi4KICBmdW5jdGlvbiBhY2NvdW50RnJvbVRpdGxlKHRpdGxlKSB7CiAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyh0aXRsZSB8fCAnJykuc3BsaXQoL1xzWy3igJPigJRdXHMvKTsKICAgIGZvciAobGV0IGkgPSBwYXJ0cy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkgewogICAgICBjb25zdCBwID0gcGFydHNbaV0udHJpbSgpOwogICAgICBpZiAoRU1BSUxfT05MWV9SRS50ZXN0KHApKSByZXR1cm4gcC50b0xvd2VyQ2FzZSgpOwogICAgfQogICAgcmV0dXJuICcnOwogIH",
"0KCiAgLy8gIkdvb2dsZSBBY2NvdW50OiBBbm5hIFZvcyAgKGFubmFAZXhhbXBsZS5jb20pIiDihpIgImFubmFAZXhhbXBsZS5jb20iCiAgZnVuY3Rpb24gYWNjb3VudEZyb21BcmlhTGFiZWwobGFiZWwpIHsKICAgIGNvbnN0IG0gPSBTdHJpbmcobGFiZWwgfHwgJycpLm1hdGNoKEVNQUlMX0FOWV9SRSk7CiAgICByZXR1cm4gbSA_IG1bMF0ucmVwbGFjZSgvWykuLDtdKyQvLCAnJykudG9Mb3dlckNhc2UoKSA6ICcnOwogIH0KCiAgLy8gIi9tYWlsL3UvMS8iIOKGkiAxLiBEZWZhdWx0cyB0byAwLCB3aGljaCBpcyB3aGF0IC9tYWlsLyBhbG9uZSBtZWFucy4KICBmdW5jdGlvbiBhY2NvdW50SW5kZXhGcm9tUGF0aChwYXRobmFtZSkgewogICAgY29uc3QgbSA9IFN0cmluZyhwYXRobmFtZSB8fCAnJykubWF0Y2goL1wvbWFpbFwvdVwvKFxkKylcLy8pOwogICAgcmV0dXJuIG0gPyBOdW1iZXIobVsxXSkgOiAwOwogIH0KCiAgLy8g4pSA4pSAIERhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTW9udGggYW5kIGRheSBuYW1lcyBhcmUgc3BlbGxlZCBvdXQgaGVyZSByYXRoZXIgdGhhbiB0YWtlbiBmcm9tCiAgLy8gSW50bCwgc2",
"8gYSBjYXJkIHJlYWRzIHRoZSBzYW1lIHdoYXRldmVyIHRoZSBicm93c2VyIGxvY2FsZSBpcyBhbmQKICAvLyB0aGUgdGVzdHMgZG8gbm90IGRlcGVuZCBvbiB0aGUgbWFjaGluZSB0aGV5IHJ1biBvbi4KCiAgY29uc3QgTU9OVEhTID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsCiAgICAgICAgICAgICAgICAgICdKdWwnLCAnQXVnJywgJ1NlcCcsICdPY3QnLCAnTm92JywgJ0RlYyddOwogIGNvbnN0IERBWVMgPSBbJ1N1bicsICdNb24nLCAnVHVlJywgJ1dlZCcsICdUaHUnLCAnRnJpJywgJ1NhdCddOwoKICBmdW5jdGlvbiBzdGFydE9mRGF5KG1zKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUobXMpOwogICAgcmV0dXJuIG5ldyBEYXRlKGQuZ2V0RnVsbFllYXIoKSwgZC5nZXRNb250aCgpLCBkLmdldERhdGUoKSkuZ2V0VGltZSgpOwogIH0KCiAgLy8gQ29tcGFjdCBhZ2UgZm9yIGEgY2FyZDogImp1c3Qgbm93IiwgIjEyIG1pbiIsICIzIGgiLCAiWWVzdGVyZGF5IiwKICAvLyAiTW9uIiwgIjMgU2VwIiwgIjMgU2VwIDIwMjQiLiBIb3VycyB3aW4gb3ZlciAiWWVzdGVyZGF5IiBmb3IgYW55dGhpbmcKICAvLyB1bmRlciBhIGRheSBvbGQsIGJlY2F1c2UgIjIgaCIgaXMgbW9yZSB1c2VmdWwgYXQgMWFtIHRoYW4gIlllc3RlcmRheSIuCiAgZnVuY3Rpb24gcmVsYXRpdmVEYXRlKHRzLCBub3cgPSBEYXRlLm5vdygpKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fC",
"AhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBub3cgLSB0KTsKICAgIGNvbnN0IG1pbiA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgIGlmIChtaW4gPCAxKSByZXR1cm4gJ2p1c3Qgbm93JzsKICAgIGlmIChtaW4gPCA2MCkgcmV0dXJuIGAke21pbn0gbWluYDsKICAgIGNvbnN0IGhvdXJzID0gTWF0aC5mbG9vcihtaW4gLyA2MCk7CiAgICBpZiAoaG91cnMgPCAyNCkgcmV0dXJuIGAke2hvdXJzfSBoYDsKCiAgICAvLyBDYWxlbmRhciBkYXlzLCBub3QgMjQtaG91ciBibG9ja3MsIHNvICJZZXN0ZXJkYXkiIG1lYW5zIHllc3RlcmRheS4KICAgIGNvbnN0IGRheXMgPSBNYXRoLnJvdW5kKChzdGFydE9mRGF5KG5vdykgLSBzdGFydE9mRGF5KHQpKSAvIDg2NDAwMDAwKTsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGlmIChkYXlzIDw9IDEpIHJldHVybiAnWWVzdGVyZGF5JzsKICAgIGlmIChkYXlzIDwgNykgcmV0dXJuIERBWVNbZC5nZXREYXkoKV07CiAgICBjb25zdCBkbSA9IGAke2QuZ2V0RGF0ZSgpfSAke01PTlRIU1tkLmdldE1vbnRoKCldfWA7CiAgICByZXR1cm4gZC5nZXRGdWxsWWVhcigpID09PSBuZXcgRGF0ZShub3cpLmdldEZ1bGxZZWFyKCkgPyBkbSA6IGAke2RtfSAke2QuZ2V0RnVsbFllYXIoKX1gOwogIH0KCiAgLy8gRnVsbCBkYXRlIGZvciBhIHRvb2x0aXA6ICJUdWUgMyBTZXAgMjAyNiwgMTQ6MDUiLgogIGZ1bmN0aW9uIGZ1bGxEYX",
"RlKHRzKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fCAhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGNvbnN0IHBhZCA9IG4gPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgICByZXR1cm4gYCR7REFZU1tkLmdldERheSgpXX0gJHtkLmdldERhdGUoKX0gJHtNT05USFNbZC5nZXRNb250aCgpXX0gJHtkLmdldEZ1bGxZZWFyKCl9LCBgICsKICAgICAgICAgICBgJHtwYWQoZC5nZXRIb3VycygpKX06JHtwYWQoZC5nZXRNaW51dGVzKCkpfWA7CiAgfQoKICAvLyBGb3IgInVwZGF0ZWQgWHMgYWdvIiBpbiB0aGUgYm9hcmQgaGVhZGVyLgogIGZ1bmN0aW9uIGFnb1RleHQobXMpIHsKICAgIGNvbnN0IHMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKE51bWJlcihtcykgLyAxMDAwKSk7CiAgICBpZiAocyA8IDUpIHJldHVybiAnanVzdCBub3cnOwogICAgaWYgKHMgPCA2MCkgcmV0dXJuIGAke3N9cyBhZ29gOwogICAgY29uc3QgbSA9IE1hdGguZmxvb3IocyAvIDYwKTsKICAgIGlmIChtIDwgNjApIHJldHVybiBgJHttfSBtaW4gYWdvYDsKICAgIHJldHVybiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9IGggYWdvYDsKICB9CgogIC8vIOKUgOKUgCBDb25jdXJyZW5jeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilI",
"DilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUnVucyBmbiBvdmVyIGl0ZW1zIHdpdGggYXQgbW9zdCBgbGltaXRgIGluIGZsaWdodC4gR21haWwncyBwZXItdXNlcgogIC8vIHF1b3RhIGlzIGdlbmVyb3VzLCBidXQgYSBib2FyZCBvZiAxMDAgY2hhbmdlZCB0aHJlYWRzIGZpcmVkIGF0IG9uY2UKICAvLyBzdGlsbCB0cmlwcyBpdHMgYnVyc3QgbGltaXRlcjsgc2l4IGF0IGEgdGltZSBrZWVwcyBhIGNvbGQgbG9hZCBxdWljawogIC8vIHdpdGhvdXQgcHJvdm9raW5nIDQyOXMuIFRoZSBmaXJzdCByZWplY3Rpb24gc3RvcHMgbmV3IHdvcmsgc3RhcnRpbmcKICAvLyBhbmQgaXMgcmUtdGhyb3duLCBzbyBhbiBhdXRoIGZhaWx1cmUgZG9lcyBub3QgZmFuIG91dCBpbnRvIDEwMCBtb3JlLgogIGFzeW5jIGZ1bmN0aW9uIG1hcFBvb2woaXRlbXMsIGxpbWl0LCBmbikgewogICAgY29uc3QgcmVzdWx0cyA9IG5ldyBBcnJheShpdGVtcy5sZW5ndGgpOwogICAgbGV0IG5leHQgPSAwOwogICAgbGV0IGZhaWxlZCA9IG51bGw7CiAgICBhc3luYyBmdW5jdGlvbiB3b3JrZXIoKSB7CiAgICAgIHdoaWxlIChmYWlsZWQgPT09IG51bGwgJiYgbmV4dCA8IGl0ZW1zLmxlbmd0aCkgewogICAgICAgIGNvbnN0IGkgPSBuZXh0Kys7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHJlc3VsdHNbaV0gPSBhd2FpdCBmbihpdGVtc1tpXSwgaSk7CiAgICAgICAgfSBjYXRjaC",
"AoZXJyKSB7CiAgICAgICAgICBpZiAoZmFpbGVkID09PSBudWxsKSBmYWlsZWQgPSBlcnI7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBjb25zdCBuID0gTWF0aC5tYXgoMSwgTWF0aC5taW4obGltaXQsIGl0ZW1zLmxlbmd0aCkpOwogICAgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogbiB9LCB3b3JrZXIpKTsKICAgIGlmIChmYWlsZWQgIT09IG51bGwpIHRocm93IGZhaWxlZDsKICAgIHJldHVybiByZXN1bHRzOwogIH0KCiAgY29uc3QgYXBpID0gewogICAgaGVhZGVyTWFwLCBwYXJzZUFkZHJlc3MsIGRpc3BsYXlOYW1lLCBkZWNvZGVFbnRpdGllcywKICAgIGFjY291bnRGcm9tVGl0bGUsIGFjY291bnRGcm9tQXJpYUxhYmVsLCBhY2NvdW50SW5kZXhGcm9tUGF0aCwKICAgIHJlbGF0aXZlRGF0ZSwgZnVsbERhdGUsIGFnb1RleHQsIG1hcFBvb2wsCiAgfTsKCiAgbnMudXRpbCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/notes-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4",
"pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGVzIGxvZ2ljIChwdXJlKQovLwovLyBBIG5vdGUgaXMgYW4gZW1haWwgdGhhdCB3YXMgbmV2ZXIgc2VudDogYSBtZXNzYWdlIHBsYWNlZCBzdHJhaWdodCBpbnRvCi8vIHRoZSB1c2VyJ3Mgb3duIG1haWxib3ggd2l0aCBtZXNzYWdlcy5pbnNlcnQsIGNhcnJ5aW5nIHRoZSBOb3RlcyBsYWJlbAovLyBhbmQgbm90aGluZyBlbHNlIC0gbm90IElOQk9YLCBub3QgVU5SRUFEIC0gc28gaXQgc3RheXMgb3V0IG9mIHRoZSB3YXkKLy8gdW50aWwgbG9va2VkIGZvciwgYW5kIEdtYWlsJ3Mgb3duIHNlYXJjaCBmaW5kcyBpdC4KLy8KLy8gR21haWwgbWVzc2FnZXMgY2Fubm90IGJlIGNoYW5nZWQgb25jZSBzdG9yZWQsIHNvIHNhdmluZyBhIG5vdGUgaW5zZXJ0cwovLyBhIG5ldyBtZXNzYWdlIGFuZCBtb3ZlcyB0aGUgcHJldmlvdXMgb25lIHRvIFRyYXNoLiBFYWNoIG5vdGUgY2FycmllcyBhCi8vIHN0YWJsZSBpZCBpbiBhbiBYLUdrYi1Ob3RlIGhlYWRlciwgd2hpY2ggaXMgaG93IGl0cyB2ZXJzaW9ucyBhcmUgdGllZAovLyB0b2dldGhlciBhbmQgLSBqdXN0IGFzIGltcG9ydGFudCAtIGhvdyB0aGUgYmFja2dyb3VuZCB3b3JrZXIgdGVsbHMgYQovLyBub3RlIGZyb20gcmVhbCBtYWlsOiBpdCB3aWxsIG9ubHkgaW5zZXJ0IG1lc3NhZ2VzIHRoYXQgY2FycnkgdGhlIGhlYWRlcgovLyBhbmQgb25seSB0cmFzaCBtZXNzYWdlcyB0aGF0IGFscmVhZHkgZG8uCi8vCi8vI",
"ExvYWRlZCBieSB0aGUgY29udGVudCBzY3JpcHRzLCB0aGUgc2VydmljZSB3b3JrZXIgYW5kIE5vZGUncyB0ZXN0cy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IE5PVEVfSEVBREVSID0gJ1gtR2tiLU5vdGUnOwogIGNvbnN0IERFRkFVTFRfTEFCRUwgPSAnX05vdGVzJzsKICAvLyAuaW52YWxpZCBpcyByZXNlcnZlZCBhbmQgY2FuIG5ldmVyIGJlIGRlbGl2ZXJlZCB0bywgc28gbm90aGluZyBjYW4KICAvLyBldmVyIGFycml2ZSBmcm9tIG9yIGdvIHRvIHRoaXMgYWRkcmVzcy4KICBjb25zdCBOT1RFX1NFTkRFUiA9ICciTm90ZXMiIDxub3Rlc0Bub3Rlcy5pbnZhbGlkPic7CgogIC8vIEdlbmVyb3VzIGZvciB0eXBlZCBub3RlcywgYW5kIGtlZXBzIG9uZ",
"SBzYXZlIGNvbWZvcnRhYmx5IGluc2lkZSB3aGF0CiAgLy8gdGhlIG5vbi11cGxvYWQgaW5zZXJ0IGVuZHBvaW50IGFuZCBhIHJ1bnRpbWUgbWVzc2FnZSB3aWxsIGNhcnJ5LgogIGNvbnN0IE1BWF9CT0RZID0gMTAwMDAwOwogIGNvbnN0IE1BWF9USVRMRSA9IDMwMDsKCiAgLy8gTGFiZWxzIGEgbm90ZSBtYXkgbmV2ZXIgYmUgaW5zZXJ0ZWQgd2l0aC4gQSBub3RlIGluIHRoZSBJbmJveCwgb3IKICAvLyBkcmVzc2VkIHVwIGFzIHNlbnQgb3IgZHJhZnQgbWFpbCwgaXMgbm8gbG9uZ2VyIG91dCBvZiB0aGUgd2F5IC0gYW5kCiAgLy8gbm90aGluZyBoZXJlIHNob3VsZCBldmVyIGJlIGFibGUgdG8gcHV0IG1haWwgaW50byBTcGFtIG9yIFRyYXNoLgogIGNvbnN0IEZPUkJJRERFTl9JTlNFUlRfTEFCRUxTID0gbmV3IFNldChbJ0lOQk9YJywgJ1NFTlQnLCAnRFJBRlQnLCAnU1BBTScsICdUUkFTSCcsICdVTlJFQUQnXSk7CgogIC8vIOKUgOKUgCBJZHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IElEX1JFID0gL15bYS16MC05XXsxMiw0MH0kLzsKCiAgZnVuY3Rpb24gbmV3Tm90ZUlkKHJhbmQgPSBuID0-IGNyeXB0by5nZ",
"XRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKSB7CiAgICByZXR1cm4gQXJyYXkuZnJvbShyYW5kKDEyKSwgYiA9PiBiLnRvU3RyaW5nKDM2KS5wYWRTdGFydCgyLCAnMCcpLnNsaWNlKC0yKSkuam9pbignJykuc2xpY2UoMCwgMjApOwogIH0KCiAgLy8gVGhlIHNjcmF0Y2hwYWQ6IG9uZSBub3RlIHdpdGggYSBmaXhlZCBpZCwgc28gdGhhdCBldmVyeSBjb21wdXRlciBhbmQKICAvLyBwaG9uZSBmaW5kcyAtIGFuZCBzYXZlcyBpbnRvIC0gdGhlIHNhbWUgb25lLgogIGNvbnN0IFNDUkFUQ0hQQURfSUQgPSAnc2NyYXRjaHBhZDAwMDAwMCc7CiAgY29uc3QgU0NSQVRDSFBBRF9USVRMRSA9ICdTY3JhdGNocGFkJzsKCiAgLy8gVGhlIGlkIGEgc2F2ZSB3cml0ZXMgdW5kZXI6IHRoZSBub3RlJ3Mgb3duLCBvbmNlIGl0IGhhcyBvbmU7IGZvciBhCiAgLy8gZmlyc3Qgc2F2ZSwgdGhlIHNjcmF0Y2hwYWQncyBpZiB0aGF0IGlzIHdoYXQgaXMgYmVpbmcgc2F2ZWQsIGFuZAogIC8vIG90aGVyd2lzZSBhIG5ldyBvbmUuIE5vIG90aGVyIGlkIGNhbiBiZSBhc2tlZCBmb3IuCiAgZnVuY3Rpb24gbm90ZUlkRm9yKHByZXZpb3VzLCB3YW50ZWQpIHsKICAgIGlmIChwcmV2aW91cyAmJiBwcmV2aW91cy5vd24gJiYgSURfUkUudGVzdChTdHJpbmcocHJldmlvdXMubm90ZUlkIHx8ICcnKSkpIHJldHVybiBwcmV2aW91cy5ub3RlSWQ7CiAgICByZXR1cm4gd2FudGVkID09PSBTQ1JBVENIUEFEX0lEID8gU0NSQVRDSFBBRF9JRCA6I",
"G5ld05vdGVJZCgpOwogIH0KCiAgLy8g4pSA4pSAIEVuY29kaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBieXRlc1RvQmluYXJ5KGJ5dGVzKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIHsKICAgICAgb3V0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCwgYnl0ZXMuc3ViYXJyYXkoaSwgaSArIDB4ODAwMCkpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJpbmFyeVRvQnl0ZXMoYmluKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmluLmxlbmd0aDsgaSsrKSBvdXRbaV0gPSBiaW4uY2hhckNvZGVBdChpKSAmIDB4ZmY7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgdXRmOFRvQmFzZTY0ID0gcyA9PiBidG9hKGJ5dGVzVG9CaW5hcnkobmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHMpKSk7CgogIGZ1bmN0aW9uIGJhc2U2NFVybEVuY29kZShiaW5hcnkpIHsKICAgIHJldHVybiBidG9hKGJpbmFyeSkucmVwbGFjZSgvXCsvZywgJ",
"y0nKS5yZXBsYWNlKC9cLy9nLCAnXycpLnJlcGxhY2UoLz0rJC8sICcnKTsKICB9CgogIGZ1bmN0aW9uIGJhc2U2NFVybERlY29kZShzKSB7CiAgICBjb25zdCBiNjQgPSBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvLS9nLCAnKycpLnJlcGxhY2UoL18vZywgJy8nKS5yZXBsYWNlKC9ccysvZywgJycpOwogICAgcmV0dXJuIGF0b2IoYjY0ICsgJz0nLnJlcGVhdCgoNCAtIChiNjQubGVuZ3RoICUgNCkpICUgNCkpOwogIH0KCiAgLy8gVGV4dCBpbiB3aGF0ZXZlciBjaGFyc2V0IHRoZSBwYXJ0IGRlY2xhcmVkLiBBbiB1bmtub3duIG9yIG1pc2xhYmVsbGVkCiAgLy8gY2hhcnNldCBmYWxscyBiYWNrIHRvIFVURi04IHJhdGhlciB0aGFuIGZhaWxpbmcgdGhlIHdob2xlIG5vdGUuCiAgZnVuY3Rpb24gZGVjb2RlQnl0ZXMoYnl0ZXMsIGNoYXJzZXQpIHsKICAgIHRyeSB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoY2hhcnNldCB8fCAndXRmLTgnKS5kZWNvZGUoYnl0ZXMpOwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoJ3V0Zi04JykuZGVjb2RlKGJ5dGVzKTsKICAgIH0KICB9CgogIC8vIFJGQyAyMDQ3IGVuY29kZWQgd29yZHMsIGZvciBhIHN1YmplY3QgdGhhdCBpcyBub3QgcGxhaW4gQVNDSUkuIEF0IDM5CiAgLy8gYnl0ZXMgYSB3b3JkLCBldmVuIHRoZSBmaXJzdCBsaW5lICgiU3ViamVjdDogIiBhbmQgb25lIHdvcmQpIHN0YXlzCiAgLy8gdW5kZXIgNzggY2hhcmFjdGVycywgY",
"W5kIG5vIGNoYXJhY3RlciBpcyBzcGxpdCBhY3Jvc3MgdHdvIHdvcmRzLAogIC8vIHdoaWNoIHNvbWUgcmVhZGVycyB3b3VsZCBzaG93IGFzIHR3byBicm9rZW4gaGFsdmVzLgogIGZ1bmN0aW9uIGVuY29kZUhlYWRlclRleHQodGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICgvXltceDIwLVx4N2VdKiQvLnRlc3QocykpIHJldHVybiBzOwogICAgY29uc3Qgd29yZHMgPSBbXTsKICAgIGxldCBjaHVuayA9ICcnOwogICAgbGV0IGJ5dGVzID0gMDsKICAgIGZvciAoY29uc3QgY2ggb2YgcykgewogICAgICBjb25zdCBuID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGNoKS5sZW5ndGg7CiAgICAgIGlmIChieXRlcyArIG4gPiAzOSAmJiBjaHVuaykgewogICAgICAgIHdvcmRzLnB1c2goY2h1bmspOwogICAgICAgIGNodW5rID0gJyc7CiAgICAgICAgYnl0ZXMgPSAwOwogICAgICB9CiAgICAgIGNodW5rICs9IGNoOwogICAgICBieXRlcyArPSBuOwogICAgfQogICAgaWYgKGNodW5rKSB3b3Jkcy5wdXNoKGNodW5rKTsKICAgIHJldHVybiB3b3Jkcy5tYXAodyA9PiBgPT9VVEYtOD9CPyR7dXRmOFRvQmFzZTY0KHcpfT89YCkuam9pbignXHJcbiAnKTsKICB9CgogIC8vIFRoZSBpbnZlcnNlLCBmb3IgdGhlIHByZXZpZXcncyBmYWtlIEdtYWlsIGFuZCBmb3IgdGhlIHRlc3RzLiAoVGhlIHJlYWwKICAvLyBBUEkgaGFuZHMgaGVhZGVycyBiYWNrIGFscmVhZHkgZGVjb2RlZC4pCiAgZnVuY",
"3Rpb24gZGVjb2RlSGVhZGVyVGV4dCh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCAnJykKICAgICAgLnJlcGxhY2UoLyg9XD9bXj9dK1w_W0JiUXFdXD9bXj9dKlw_PSlccysoPz09XD8pL2csICckMScpCiAgICAgIC5yZXBsYWNlKC89XD8oW14_XSspXD8oW0JiUXFdKVw_KFteP10qKVw_PS9nLCAoXywgY2hhcnNldCwgZW5jLCB0ZXh0KSA9PiB7CiAgICAgICAgY29uc3QgYmluID0gZW5jLnRvVXBwZXJDYXNlKCkgPT09ICdCJwogICAgICAgICAgPyBhdG9iKHRleHQpCiAgICAgICAgICA6IHRleHQucmVwbGFjZSgvXy9nLCAnICcpLnJlcGxhY2UoLz0oWzAtOUEtRmEtZl17Mn0pL2csIChtLCBoZXgpID0-IFN0cmluZy5mcm9tQ2hhckNvZGUocGFyc2VJbnQoaGV4LCAxNikpKTsKICAgICAgICByZXR1cm4gZGVjb2RlQnl0ZXMoYmluYXJ5VG9CeXRlcyhiaW4pLCBjaGFyc2V0KTsKICAgICAgfSk7CiAgfQoKICAvLyBIZWFkZXIgdmFsdWVzIG5ldmVyIGNhcnJ5IGxpbmUgYnJlYWtzIG9mIHRoZWlyIG93bjogb25lIGluIGEgdGl0bGUKICAvLyB3b3VsZCBlbmQgdGhlIGhlYWRlciBlYXJseSBhbmQgc3RhcnQgYW5vdGhlciBvZiB0aGUgdXNlcidzIGNob29zaW5nLgogIGNvbnN0IG9uZUxpbmUgPSBzID0-IFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9bXHJcblx0XSsvZywgJyAnKS5yZXBsYWNlKC9cc3syLH0vZywgJyAnKS50cmltKCk7CgogIC8vIOKUgOKUgCBCdWlsZGluZyBhIG5vdGUg4pSA4pSA4pSA4",
"pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIEEgbm90ZSB3aXRoIG5vIHRpdGxlIGlzIGZpbGVkIHVuZGVyIGl0cyBmaXJzdCBsaW5lLCBhcyBtb3N0IG5vdGVzCiAgLy8gYXBwcyBkbywgc28gaXQgc3RpbGwgcmVhZHMgYXMgc29tZXRoaW5nIGluIEdtYWlsJ3MgbWVzc2FnZSBsaXN0LgogIGZ1bmN0aW9uIHRpdGxlRm9yKHRpdGxlLCBib2R5KSB7CiAgICBjb25zdCB0ID0gb25lTGluZSh0aXRsZSkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGlmICh0KSByZXR1cm4gdDsKICAgIGNvbnN0IGZpcnN0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnNwbGl0KCdcbicpLm1hcChsID0-IGwudHJpbSgpKS5maW5kKEJvb2xlYW4pIHx8ICcnOwogICAgcmV0dXJuIG9uZUxpbmUoZmlyc3QpLnNsaWNlKDAsIDgwKTsKICB9CgogIGZ1bmN0aW9uIHdyYXA3NihzKSB7CiAgICByZXR1cm4gcy5yZXBsYWNlKC8uezEsNzZ9L2csICckJlxyXG4nKS50cmltRW5kKCk7CiAgfQoKICBjb25zdCB0ZXh0UGFydCA9ICh0eXBlLCBzKSA9PiBbCiAgICBgQ29udGVudC1UeXBlOiAke3R5cGV9OyBjaGFyc2V0PVVURi04YCwKICAgICdDb250ZW50LVRyYW5zZmVyLUVuY29kaW5nOiBiYXNlNjQnLAogICAgJycsCiAgICB3cmFwNzYodXRmOFRvQ",
"mFzZTY0KHMucmVwbGFjZSgvXG4vZywgJ1xyXG4nKSkpLAogIF07CgogIC8vIGBib2R5YCBpcyB0aGUgcGxhaW4gdGV4dC4gV2l0aCBgaHRtbGAgYXMgd2VsbCwgdGhlIG5vdGUgaXMgYQogIC8vIG11bHRpcGFydC9hbHRlcm5hdGl2ZSBtZXNzYWdlOiBHbWFpbCBzaG93cyB0aGUgSFRNTCwgYW5kIGl0cyBwcmV2aWV3cwogIC8vIGFuZCBwbGFpbi10ZXh0IHJlYWRlcnMgZ2V0IHRoZSB0ZXh0LgogIGZ1bmN0aW9uIGJ1aWxkTm90ZVJhdyh7IG5vdGVJZCwgdGl0bGUsIGJvZHksIGh0bWwsIGFjY291bnQsIGRhdGUgPSBuZXcgRGF0ZSgpIH0pIHsKICAgIGlmICghSURfUkUudGVzdChTdHJpbmcobm90ZUlkIHx8ICcnKSkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBub3RlIGlkJyk7CiAgICBjb25zdCBtZSA9IG9uZUxpbmUoYWNjb3VudCk7CiAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNsaWNlKDAsIE1BWF9CT0RZKTsKICAgIGNvbnN0IGhlYWQgPSBbCiAgICAgIC8vIE5vdCBmcm9tIHRoZSBhY2NvdW50J3Mgb3duIGFkZHJlc3M6IEdtYWlsIGZpbGVzIGFueXRoaW5nIGZyb20geW91CiAgICAgIC8vIHVuZGVyIFNlbnQsIHdoYXRldmVyIGxhYmVscyBpdCB3YXMgZ2l2ZW4uIFJlcGxpZXMgc3RpbGwgcmVhY2ggeW91LgogICAgICBgRnJvbTogJHtOT1RFX1NFTkRFUn1gLAogICAgICBgVG86ICR7bWV9YCwKICAgICAgYFJlcGx5LVRvOiAke21lfWAsCiAgICAgI",
"GBTdWJqZWN0OiAke2VuY29kZUhlYWRlclRleHQodGl0bGVGb3IodGl0bGUsIHRleHQpIHx8ICdVbnRpdGxlZCBub3RlJyl9YCwKICAgICAgYERhdGU6ICR7ZGF0ZS50b1VUQ1N0cmluZygpfWAsCiAgICAgIGBNZXNzYWdlLUlEOiA8JHtub3RlSWR9LiR7ZGF0ZS5nZXRUaW1lKCl9QG5vdGVzLmludmFsaWQ-YCwKICAgICAgYCR7Tk9URV9IRUFERVJ9OiAke25vdGVJZH1gLAogICAgICAnTUlNRS1WZXJzaW9uOiAxLjAnLAogICAgXTsKICAgIGxldCBsaW5lczsKICAgIGlmIChodG1sKSB7CiAgICAgIC8vIEJhc2U2NCBuZXZlciBjb250YWlucyAiLSIsIHNvIHRoaXMgYm91bmRhcnkgY2Fubm90IG9jY3VyIGluIGEgcGFydC4KICAgICAgY29uc3QgYm91bmRhcnkgPSBgZ2tiLSR7bm90ZUlkfS0ke2RhdGUuZ2V0VGltZSgpfWA7CiAgICAgIGxpbmVzID0gWwogICAgICAgIC4uLmhlYWQsCiAgICAgICAgYENvbnRlbnQtVHlwZTogbXVsdGlwYXJ0L2FsdGVybmF0aXZlOyBib3VuZGFyeT0iJHtib3VuZGFyeX0iYCwKICAgICAgICAnJywKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvcGxhaW4nLCB0ZXh0KSwKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvaHRtbCcsIFN0cmluZyhodG1sKSksCiAgICAgICAgYC0tJHtib3VuZGFyeX0tLWAsCiAgICAgICAgJycsCiAgICAgIF07CiAgICB9IGVsc2UgewogICAgICBsaW5lcyA9IFsuLi5oZWFkL",
"CAuLi50ZXh0UGFydCgndGV4dC9wbGFpbicsIHRleHQpLCAnJ107CiAgICB9CiAgICByZXR1cm4gYmFzZTY0VXJsRW5jb2RlKGxpbmVzLmpvaW4oJ1xyXG4nKSk7CiAgfQoKICAvLyDilIDilIAgV2hhdCB0aGUgd29ya2VyIGFsbG93cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaGVhZGVyQmxvY2soYmluYXJ5KSB7CiAgICBjb25zdCBlbmQgPSBiaW5hcnkuc2VhcmNoKC9ccj9cblxyP1xuLyk7CiAgICByZXR1cm4gZW5kIDwgMCA_IGJpbmFyeSA6IGJpbmFyeS5zbGljZSgwLCBlbmQpOwogIH0KCiAgLy8gVGhlIG5vdGUgaWQgYSByYXcgbWVzc2FnZSBjYXJyaWVzLCBvciAnJyBpZiBpdCBpcyBub3QgYSBub3RlLgogIGZ1bmN0aW9uIG5vdGVJZE9mUmF3KHJhdykgewogICAgbGV0IGJpbjsKICAgIHRyeSB7IGJpbiA9IGJhc2U2NFVybERlY29kZShyYXcpOyB9IGNhdGNoIHsgcmV0dXJuICcnOyB9CiAgICBjb25zdCBtID0gaGVhZGVyQmxvY2soYmluKS5tYXRjaChuZXcgUmVnRXhwKGBeJHtOT1RFX0hFQURFUn06WyBcXHRdKihbXlxcclxcbl0qKSRgLCAnbWknKSk7CiAgICBjb25zdCBpZCA9IG0gPyBtWzFdLnRyaW0oKSA6ICcnOwogICAgcmV0dXJuIElEX1JFLnRlc3QoaWQpID8gaWQgOiAnJzsKICB9CgogIC8vI",
"FRoZSBib2R5IG9mIGEgbWVzc2FnZXMuaW5zZXJ0IHRoZSB3b3JrZXIgd2lsbCBwYXNzIG9uOiBhIG5vdGUsIGZpbGVkCiAgLy8gdW5kZXIgdXNlciBsYWJlbHMgb25seSwgYW5kIG5vdGhpbmcgZWxzZSBpbiB0aGUgcmVxdWVzdC4KICBmdW5jdGlvbiBpc05vdGVJbnNlcnQoYm9keSkgewogICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgYm9keS5yYXcgIT09ICdzdHJpbmcnKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBleHRyYSA9IE9iamVjdC5rZXlzKGJvZHkpLmZpbHRlcihrID0-IGsgIT09ICdyYXcnICYmIGsgIT09ICdsYWJlbElkcycpOwogICAgaWYgKGV4dHJhLmxlbmd0aCkgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgbGFiZWxzID0gYm9keS5sYWJlbElkcyA9PT0gdW5kZWZpbmVkID8gW10gOiBib2R5LmxhYmVsSWRzOwogICAgaWYgKCFBcnJheS5pc0FycmF5KGxhYmVscykpIHJldHVybiBmYWxzZTsKICAgIGlmIChsYWJlbHMuc29tZShpZCA9PiBGT1JCSURERU5fSU5TRVJUX0xBQkVMUy5oYXMoU3RyaW5nKGlkKS50b1VwcGVyQ2FzZSgpKSkpIHJldHVybiBmYWxzZTsKICAgIHJldHVybiAhIW5vdGVJZE9mUmF3KGJvZHkucmF3KTsKICB9CgogIC8vIOKUgOKUgCBSZWFkaW5nIG5vdGVzIGJhY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4",
"pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGhlYWRlck9mKG1lc3NhZ2UsIG5hbWUpIHsKICAgIHJldHVybiB1dGlsLmhlYWRlck1hcChtZXNzYWdlKVtuYW1lLnRvTG93ZXJDYXNlKCldIHx8ICcnOwogIH0KCiAgZnVuY3Rpb24gY2hhcnNldE9mKHBhcnQpIHsKICAgIGNvbnN0IGN0ID0gKHBhcnQuaGVhZGVycyB8fCBbXSkuZmluZChoID0-IGgubmFtZS50b0xvd2VyQ2FzZSgpID09PSAnY29udGVudC10eXBlJyk7CiAgICBjb25zdCBtID0gY3QgJiYgL2NoYXJzZXQ9Ij8oW14iO1xzXSspIj8vaS5leGVjKGN0LnZhbHVlKTsKICAgIHJldHVybiBtID8gbVsxXSA6ICd1dGYtOCc7CiAgfQoKICBmdW5jdGlvbiBwYXJ0VGV4dChwYXJ0KSB7CiAgICBpZiAoIXBhcnQgfHwgIXBhcnQuYm9keSB8fCAhcGFydC5ib2R5LmRhdGEpIHJldHVybiAnJzsKICAgIHJldHVybiBkZWNvZGVCeXRlcyhiaW5hcnlUb0J5dGVzKGJhc2U2NFVybERlY29kZShwYXJ0LmJvZHkuZGF0YSkpLCBjaGFyc2V0T2YocGFydCkpOwogIH0KCiAgLy8gQSByb3VnaCB0ZXh0IHJlbmRlcmluZyBvZiBhbiBIVE1MIGVtYWlsLCBmb3Igbm90ZXMgdGhhdCBhcnJpdmVkIGFzCiAgLy8gbWFpbCAoc2F5LCBzZW50IHRvIHlvdXJzZWxmIGZyb20gYSBwaG9uZSkuIERvbmUgd2l0aCBwYXR0ZXJucyByYXRoZXIKICAvLyB0aGFuIHRoZSBET006IHBhcnNpbmcgSFRNTCBpbnRvIGEgZG9jdW1lbnQgaXMgYSBUcnVzd",
"GVkIFR5cGVzIHNpbmsgb24KICAvLyBHbWFpbCdzIHBhZ2UsIGFuZCBvbmx5IHRoZSB3b3JkcyBhcmUgd2FudGVkIGFueXdheS4KICBmdW5jdGlvbiBodG1sVG9UZXh0KGh0bWwpIHsKICAgIGNvbnN0IHRleHQgPSBTdHJpbmcoaHRtbCB8fCAnJykKICAgICAgLnJlcGxhY2UoLzwoc2NyaXB0fHN0eWxlfGhlYWR8dGl0bGUpXGJbXj5dKj5bXHNcU10qPzxcL1wxXHMqPi9naSwgJycpCiAgICAgIC5yZXBsYWNlKC88YnJccypcLz8-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPGxpXGJbXj5dKj4vZ2ksICdcbuKAoiAnKQogICAgICAucmVwbGFjZSgvPFwvKHB8ZGl2fHVsfG9sfHRyfGhbMS02XXxibG9ja3F1b3RlfHByZXx0YWJsZSlccyo-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPFtePl0rPi9nLCAnJyk7CiAgICByZXR1cm4gdXRpbC5kZWNvZGVFbnRpdGllcyh0ZXh0KQogICAgICAucmVwbGFjZSgvXHUwMGEwL2csICcgJykKICAgICAgLnJlcGxhY2UoL1sgXHRdK1xuL2csICdcbicpCiAgICAgIC5yZXBsYWNlKC9cbnszLH0vZywgJ1xuXG4nKQogICAgICAudHJpbSgpOwogIH0KCiAgZnVuY3Rpb24gdGV4dFBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHBsYWluID0gW107CiAgICBjb25zdCBodG1sID0gW107CiAgICAoZnVuY3Rpb24gd2FsayhwKSB7CiAgICAgIGlmICghcCkgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gU3RyaW5nKHAubWltZVR5cGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmI",
"Ch0eXBlID09PSAndGV4dC9wbGFpbicpIHBsYWluLnB1c2gocCk7CiAgICAgIGVsc2UgaWYgKHR5cGUgPT09ICd0ZXh0L2h0bWwnKSBodG1sLnB1c2gocCk7CiAgICAgIChwLnBhcnRzIHx8IFtdKS5mb3JFYWNoKHdhbGspOwogICAgfSkocGF5bG9hZCk7CiAgICByZXR1cm4geyBwbGFpbiwgaHRtbCB9OwogIH0KCiAgLy8gUHJlZmVycyBhIHRleHQvcGxhaW4gcGFydCBhbnl3aGVyZSBpbiB0aGUgdHJlZSwgdGhlbiBIVE1MLgogIGZ1bmN0aW9uIGV4dHJhY3RUZXh0KHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIGlmIChwbGFpbi5sZW5ndGgpIHJldHVybiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKTsKICAgIGlmIChodG1sLmxlbmd0aCkgcmV0dXJuIGh0bWxUb1RleHQoaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykpOwogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gQm90aCByZW5kZXJpbmdzLCBkZWNvZGVkLCBmb3IgdGhlIGZvcm1hdHRlZCByZWFkZXI6IHRoZSBIVE1MIGlzIHRoZQogIC8vIHJlY29yZCwgdGhlIHBsYWluIHRleHQgdGhlIGZhbGxiYWNrIGZvciBtYWlsIHRoYXQgaGFzIG5vIEhUTUwuCiAgZnVuY3Rpb24gbWVzc2FnZVBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIHJld",
"HVybiB7CiAgICAgIHBsYWluOiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKSwKICAgICAgaHRtbDogaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJyksCiAgICB9OwogIH0KCiAgLy8gT25lIG5vdGUgZnJvbSBhIG1lc3NhZ2VzLmdldC4gV2l0aCBmb3JtYXQ9bWV0YWRhdGEgdGhlcmUgaXMgbm8gYm9keQogIC8vIChib2R5IHN0YXlzIG51bGwpOyB3aXRoIGZvcm1hdD1mdWxsIHRoZXJlIGlzLgogIGZ1bmN0aW9uIG5vdGVGcm9tTWVzc2FnZShtc2cpIHsKICAgIGNvbnN0IG5vdGVJZCA9IGhlYWRlck9mKG1zZywgTk9URV9IRUFERVIpLnRyaW0oKTsKICAgIGNvbnN0IG93biA9IElEX1JFLnRlc3Qobm90ZUlkKTsKICAgIGNvbnN0IGZ1bGwgPSAhIShtc2cucGF5bG9hZCAmJiAobXNnLnBheWxvYWQuYm9keSB8fCBtc2cucGF5bG9hZC5wYXJ0cykpOwogICAgcmV0dXJuIHsKICAgICAgbWVzc2FnZUlkOiBtc2cuaWQsCiAgICAgIHRocmVhZElkOiBtc2cudGhyZWFkSWQgfHwgJycsCiAgICAgIG5vdGVJZDogb3duID8gbm90ZUlkIDogJycsCiAgICAgIG93biwKICAgICAga2V5OiBvd24gPyBgbjoke25vdGVJZH1gIDogYG06JHttc2cuaWR9YCwKICAgICAgdGl0bGU6IG9uZUxpbmUoaGVhZGVyT2YobXNnLCAnU3ViamVjdCcpKSB8fCAnVW50aXRsZWQgbm90ZScsCiAgICAgIHVwZGF0ZWQ6IE51bWJlcihtc2cuaW50ZXJuYWxEYXRlKSB8f",
"CBEYXRlLnBhcnNlKGhlYWRlck9mKG1zZywgJ0RhdGUnKSkgfHwgMCwKICAgICAgc25pcHBldDogdXRpbC5kZWNvZGVFbnRpdGllcyhtc2cuc25pcHBldCB8fCAnJyksCiAgICAgIGJvZHk6IGZ1bGwgPyBleHRyYWN0VGV4dChtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBwYXJ0czogZnVsbCA_IG1lc3NhZ2VQYXJ0cyhtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBsYWJlbElkczogbXNnLmxhYmVsSWRzIHx8IFtdLAogICAgfTsKICB9CgogIC8vIFR3byBsaXZlIHZlcnNpb25zIG9mIG9uZSBub3RlIG1lYW4gYSBzYXZlIGluc2VydGVkIHRoZSBuZXcgb25lIGJ1dAogIC8vIGNvdWxkIG5vdCB0cmFzaCB0aGUgb2xkIChvZmZsaW5lLCBjbG9zZWQgdGFiKSwgb3IgdHdvIGNvbXB1dGVycyBzYXZlZAogIC8vIGF0IG9uY2UuIFRoZSBuZXdlc3Qgd2luczsgdGhlIHJlc3QgYXJlIHJlcG9ydGVkIHNvIHRoZXkgY2FuIGJlCiAgLy8gdGlkaWVkIGludG8gVHJhc2gsIHdoZXJlIHRoZXkgc3RheSByZWNvdmVyYWJsZSBmb3IgdGhpcnR5IGRheXMuCiAgZnVuY3Rpb24gZGVkdXBlTm90ZXMobm90ZXMpIHsKICAgIGNvbnN0IGxpdmUgPSBbXTsKICAgIGNvbnN0IHN0YWxlID0gW107CiAgICBjb25zdCBiZXN0ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSB7CiAgICAgIGNvbnN0IGN1ciA9IGJlc3QuZ2V0KG4ua2V5KTsKICAgICAgaWYgKCFjdXIpIHsgYmVzdC5zZXQobi5rZXksIG4pOyBjb250aW51ZTsgf",
"QogICAgICBpZiAobi51cGRhdGVkID4gY3VyLnVwZGF0ZWQpIHsgc3RhbGUucHVzaChjdXIpOyBiZXN0LnNldChuLmtleSwgbik7IH0KICAgICAgZWxzZSBzdGFsZS5wdXNoKG4pOwogICAgfQogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSBpZiAoYmVzdC5nZXQobi5rZXkpID09PSBuKSBsaXZlLnB1c2gobik7CiAgICBsaXZlLnNvcnQoKGEsIGIpID0-IGIudXBkYXRlZCAtIGEudXBkYXRlZCk7CiAgICByZXR1cm4geyBsaXZlLCBzdGFsZSB9OwogIH0KCiAgLy8g4pSA4pSAIEZvbGRlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGZvbGRlciBpcyBhIEdtYWlsIGxhYmVsIHVuZGVyIHRoZSBub3RlcyBsYWJlbDogIl9Ob3Rlcy9Xb3JrIiwKICAvLyAiX05vdGVzL1dvcmsvQ2xpZW50cyIuIEV2ZXJ5IG5vdGUgY2FycmllcyB0aGUgbm90ZXMgbGFiZWwgaXRzZWxmLCBwbHVzCiAgLy8gdGhlIGxhYmVsIG9mIGF0IG1vc3Qgb25lIGZvbGRlciAtIHNvICJBbGwgbm90ZXMiIGlzIG9uZSBsYWJlbCwgYW5kIHRoZQogIC8vIGZvbGRlcnMgc2hvdyB1cCBuZXN0ZWQgdW5kZXIgX05vdGVzIGluIEdtYWlsJ3Mgb3duIGxhYmVsIGxpc3QuCgogI",
"GNvbnN0IEZPTERFUl9OQU1FX01BWCA9IDYwOwoKICAvLyBUaGUgZm9sZGVycyB1bmRlciBgcm9vdGAsIGluIHRyZWUgb3JkZXI6IGVhY2ggcGFyZW50IGZvbGxvd2VkIGJ5IGl0cwogIC8vIGNoaWxkcmVuLCBhbHBoYWJldGljYWxseSwgd2l0aCBpdHMgZGVwdGguIEEgbGFiZWwgd2hvc2UgcGFyZW50IGxhYmVsCiAgLy8gaXMgbWlzc2luZyAobWFkZSBieSBoYW5kIGluIEdtYWlsKSBzdGlsbCBhcHBlYXJzLCBhdCBpdHMgb3duIGRlcHRoLgogIGZ1bmN0aW9uIGZvbGRlclRyZWUobGFiZWxzLCByb290KSB7CiAgICBjb25zdCBwcmVmaXggPSBgJHtyb290fS9gOwogICAgY29uc3QgbGlzdCA9IChsYWJlbHMgfHwgW10pCiAgICAgIC5maWx0ZXIobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKHByZWZpeCkgJiYgbC5uYW1lLmxlbmd0aCA-IHByZWZpeC5sZW5ndGgpCiAgICAgIC5tYXAobCA9PiB7CiAgICAgICAgY29uc3QgcGF0aCA9IGwubmFtZS5zbGljZShwcmVmaXgubGVuZ3RoKTsKICAgICAgICBjb25zdCBwYXJ0cyA9IHBhdGguc3BsaXQoJy8nKTsKICAgICAgICByZXR1cm4geyBpZDogbC5pZCwgbmFtZTogbC5uYW1lLCBwYXRoLCB0aXRsZTogcGFydHNbcGFydHMubGVuZ3RoIC0gMV0sIGRlcHRoOiBwYXJ0cy5sZW5ndGggLSAxLCBwYXJlbnRQYXRoOiBwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpIH07CiAgICAgIH0pOwogICAgLy8gU29ydGluZyBieSBwY",
"XRoIHNlZ21lbnQgYnkgc2VnbWVudCBrZWVwcyBldmVyeSBjaGlsZCB1bmRlciBpdHMgcGFyZW50LgogICAgY29uc3Qga2V5ID0gZiA9PiBmLnBhdGguc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRvTG93ZXJDYXNlKCkpOwogICAgbGlzdC5zb3J0KChhLCBiKSA9PiB7CiAgICAgIGNvbnN0IHggPSBrZXkoYSk7CiAgICAgIGNvbnN0IHkgPSBrZXkoYik7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5taW4oeC5sZW5ndGgsIHkubGVuZ3RoKTsgaSsrKSB7CiAgICAgICAgaWYgKHhbaV0gIT09IHlbaV0pIHJldHVybiB4W2ldIDwgeVtpXSA_IC0xIDogMTsKICAgICAgfQogICAgICByZXR1cm4geC5sZW5ndGggLSB5Lmxlbmd0aDsKICAgIH0pOwogICAgcmV0dXJuIGxpc3Q7CiAgfQoKICAvLyBUaGUgZm9sZGVyIGEgbm90ZSBpcyBpbiwgZnJvbSBpdHMgbGFiZWxzOyAnJyBmb3Igbm9uZS4gVHdvIGZvbGRlcgogIC8vIGxhYmVscyAoYXBwbGllZCBieSBoYW5kKSByZXNvbHZlIHRvIHRoZSBmaXJzdCBpbiB0cmVlIG9yZGVyLgogIGZ1bmN0aW9uIGZvbGRlck9mKGxhYmVsSWRzLCBmb2xkZXJzKSB7CiAgICBjb25zdCBoYXZlID0gbmV3IFNldChsYWJlbElkcyB8fCBbXSk7CiAgICBjb25zdCBmID0gKGZvbGRlcnMgfHwgW10pLmZpbmQoeCA9PiBoYXZlLmhhcyh4LmlkKSk7CiAgICByZXR1cm4gZiA_IGYuaWQgOiAnJzsKICB9CgogIC8vIE1vdmluZyBhIG5vdGU6IGtlZXAgKG9yIHJlc3RvcmUpIHRoZSBub3RlcyBsYWJlb",
"CwgYWRkIHRoZSB0YXJnZXQncywKICAvLyBkcm9wIGV2ZXJ5IG90aGVyIGZvbGRlcidzLgogIGZ1bmN0aW9uIG1vdmVGb2xkZXJEaWZmKHJvb3RJZCwgZm9sZGVycywgdGFyZ2V0SWQpIHsKICAgIGNvbnN0IGFkZCA9IFtyb290SWRdOwogICAgaWYgKHRhcmdldElkKSBhZGQucHVzaCh0YXJnZXRJZCk7CiAgICBjb25zdCByZW1vdmUgPSAoZm9sZGVycyB8fCBbXSkubWFwKGYgPT4gZi5pZCkuZmlsdGVyKGlkID0-IGlkICE9PSB0YXJnZXRJZCk7CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogYWRkLCByZW1vdmVMYWJlbElkczogcmVtb3ZlIH07CiAgfQoKICBmdW5jdGlvbiB2YWxpZGF0ZUZvbGRlclRpdGxlKHRpdGxlLCBzaWJsaW5ncyA9IFtdKSB7CiAgICBjb25zdCB0ID0gU3RyaW5nKHRpdGxlIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXQpIHJldHVybiAnR2l2ZSB0aGUgZm9sZGVyIGEgbmFtZS4nOwogICAgaWYgKHQuaW5jbHVkZXMoJy8nKSkgcmV0dXJuICdBIGZvbGRlciBuYW1lIGNhbm5vdCBjb250YWluIOKAnC_igJ0uIE1ha2UgYSBzdWJmb2xkZXIgaW5zdGVhZC4nOwogICAgaWYgKHQubGVuZ3RoID4gRk9MREVSX05BTUVfTUFYKSByZXR1cm4gYEtlZXAgZm9sZGVyIG5hbWVzIHVuZGVyICR7Rk9MREVSX05BTUVfTUFYfSBjaGFyYWN0ZXJzLmA7CiAgICBpZiAoc2libGluZ3Muc29tZShzID0-IHMudG9Mb3dlckNhc2UoKSA9PT0gdC50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuIGBUaGVyZSBpcyBhbHJlYWR5IGEgZ",
"m9sZGVyIGNhbGxlZCDigJwke3R94oCdIGhlcmUuYDsKICAgIHJldHVybiAnJzsKICB9CgogIC8vIFJlbmFtaW5nIGEgZm9sZGVyIHJlbmFtZXMgaXRzIGxhYmVsIGFuZCBldmVyeSBsYWJlbCBiZWxvdyBpdCwgc2luY2UKICAvLyBHbWFpbCdzIEFQSSByZW5hbWVzIG9ubHkgdGhlIG9uZSBsYWJlbCBpdCBpcyBnaXZlbi4KICBmdW5jdGlvbiByZW5hbWVQbGFuKGZvbGRlciwgbmV3VGl0bGUsIGZvbGRlcnMpIHsKICAgIGNvbnN0IHBhcmVudCA9IGZvbGRlci5uYW1lLnNsaWNlKDAsIGZvbGRlci5uYW1lLmxlbmd0aCAtIGZvbGRlci50aXRsZS5sZW5ndGgpOwogICAgY29uc3QgbmV3TmFtZSA9IGAke3BhcmVudH0ke1N0cmluZyhuZXdUaXRsZSkudHJpbSgpfWA7CiAgICByZXR1cm4gKGZvbGRlcnMgfHwgW10pCiAgICAgIC5maWx0ZXIoZiA9PiBmLm5hbWUgPT09IGZvbGRlci5uYW1lIHx8IGYubmFtZS5zdGFydHNXaXRoKGAke2ZvbGRlci5uYW1lfS9gKSkKICAgICAgLm1hcChmID0-ICh7IGlkOiBmLmlkLCBuYW1lOiBuZXdOYW1lICsgZi5uYW1lLnNsaWNlKGZvbGRlci5uYW1lLmxlbmd0aCkgfSkpOwogIH0KCiAgLy8gV2hldGhlciB0aGUgd29ya2VyIG1heSBkZWxldGUgYSBsYWJlbDogYSBmb2xkZXIgdW5kZXIgdGhlIG5vdGVzIGxhYmVsCiAgLy8gd2l0aCBubyBub3RlcyBpbiBpdCBhbmQgbm8gZm9sZGVycyB1bmRlciBpdC4gYGxpdmVNZXNzYWdlc2AgaXMgd2hhdCBhCiAgLy8gbWVzc2FnZXMubGlzdCBvbiB0aGUgb",
"GFiZWwgZm91bmQgLSBub3QgdGhlIGxhYmVsJ3Mgb3duIGNvdW50LCB3aGljaAogIC8vIGFsc28gY291bnRzIG9sZCB2ZXJzaW9ucyB3YWl0aW5nIGluIFRyYXNoIGFuZCB3b3VsZCBrZWVwIGFuIGVtcHRpZWQKICAvLyBmb2xkZXIgdW5kZWxldGFibGUgZm9yIGEgbW9udGguCiAgZnVuY3Rpb24gaXNEZWxldGFibGVGb2xkZXIobGFiZWwsIHJvb3QsIGFsbExhYmVscywgbGl2ZU1lc3NhZ2VzKSB7CiAgICBpZiAoIWxhYmVsIHx8IHR5cGVvZiBsYWJlbC5uYW1lICE9PSAnc3RyaW5nJyB8fCAhcm9vdCkgcmV0dXJuIGZhbHNlOwogICAgaWYgKCFsYWJlbC5uYW1lLnN0YXJ0c1dpdGgoYCR7cm9vdH0vYCkgfHwgbGFiZWwubmFtZS5sZW5ndGggPD0gcm9vdC5sZW5ndGggKyAxKSByZXR1cm4gZmFsc2U7CiAgICBpZiAobGl2ZU1lc3NhZ2VzICE9PSAwKSByZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gIShhbGxMYWJlbHMgfHwgW10pLnNvbWUobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKGAke2xhYmVsLm5hbWV9L2ApKTsKICB9CgogIGNvbnN0IGFwaSA9IHsKICAgIE5PVEVfSEVBREVSLCBOT1RFX1NFTkRFUiwgREVGQVVMVF9MQUJFTCwgTUFYX0JPRFksIE1BWF9USVRMRSwgRk9SQklEREVOX0lOU0VSVF9MQUJFTFMsIEZPTERFUl9OQU1FX01BWCwKICAgIGZvbGRlclRyZWUsIGZvbGRlck9mLCBtb3ZlRm9sZGVyRGlmZiwgdmFsaWRhdGVGb2xkZXJUaXRsZSwgcmVuYW1lU",
"GxhbiwgaXNEZWxldGFibGVGb2xkZXIsCiAgICBTQ1JBVENIUEFEX0lELCBTQ1JBVENIUEFEX1RJVExFLCBuZXdOb3RlSWQsIG5vdGVJZEZvciwgZW5jb2RlSGVhZGVyVGV4dCwgZGVjb2RlSGVhZGVyVGV4dCwgYmFzZTY0VXJsRW5jb2RlLCBiYXNlNjRVcmxEZWNvZGUsCiAgICB0aXRsZUZvciwgYnVpbGROb3RlUmF3LCBub3RlSWRPZlJhdywgaXNOb3RlSW5zZXJ0LAogICAgaHRtbFRvVGV4dCwgZXh0cmFjdFRleHQsIG1lc3NhZ2VQYXJ0cywgbm90ZUZyb21NZXNzYWdlLCBkZWR1cGVOb3RlcywKICB9OwoKICBucy5ub3Rlc0xvZ2ljID0gYXBpOwogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgbW9kdWxlLmV4cG9ydHMgPSBhcGk7Cn0pKCk7Cg\"],[\"src/lib/note-format.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGUgZm9ybWF0dGluZyAocHVyZSkKLy8KLy8gQSBmb3JtYXR0ZWQgbm90ZSBpcyBhIGxpc3Qgb2YgYmxvY2tzIC0gcGFyYWdyYXBocywgdGhyZWUgaGVhZGluZwovLyBzaXplcywgYnVsbGV0ZWQsIG51bWJlcmVkI",
"GFuZCBjaGVjayBsaXN0cyBuZXN0ZWQgdXAgdG8gdGhyZWUgZGVlcCAtCi8vIGVhY2ggaG9sZGluZyBydW5zIG9mIHRleHQgdGhhdCBtYXkgYmUgYm9sZCwgaXRhbGljLCBzdHJ1Y2sgdGhyb3VnaCBvcgovLyBhIGxpbmsuIFRoYXQgaXMgdGhlIHdob2xlIG1vZGVsOyBub3RoaW5nIG91dHNpZGUgaXQgc3Vydml2ZXMgYSBzYXZlLgovLwovLyBJdCBpcyBzdG9yZWQgaW4gdGhlIG5vdGUncyBtZXNzYWdlIHR3aWNlLiBUaGUgSFRNTCBwYXJ0IGlzIHRoZSByZWFsCi8vIHJlY29yZDogR21haWwgc2hvd3MgaXQgKG9uIHRoZSBwaG9uZSB0b28pLCBhbmQgdGhpcyBmaWxlIHJlYWRzIGl0IGJhY2sKLy8gd2l0aCBhIHNtYWxsIHRva2VuaXplciBvZiBpdHMgb3duIHJhdGhlciB0aGFuIHRoZSBicm93c2VyJ3MgSFRNTAovLyBwYXJzZXIsIHdoaWNoIGlzIGEgVHJ1c3RlZCBUeXBlcyBzaW5rIG9uIEdtYWlsJ3MgcGFnZSBhbmQgd291bGQgYWNjZXB0Ci8vIGZhciBtb3JlIHRoYW4gdGhlIG1vZGVsIGNhbiBob2xkLiBUaGUgcGxhaW4tdGV4dCBwYXJ0IGlzIGEgcmVhZGFibGUKLy8gcmVuZGVyaW5nIC0gYnVsbGV0cywg4piQIGFuZCDimJEgLSBmb3IgR21haWwncyBwcmV2aWV3cyBhbmQgZm9yIGFueSBtYWlsCi8vIGNsaWVudCB0aGF0IHNob3dzIHRleHQuCi8vCi8vIE1haWwgdGhhdCBhcnJpdmVkIGFzIGEgbm90ZSAod3JpdHRlbiBpbiBHbWFpbCwgc2F5KSBnb2VzIHRocm91Z2ggdGhlCi8vIHNhbWUgcmVhZGVyLCBzbyBpdHMgY",
"m9sZCwgbGlzdHMgYW5kIGxpbmtzIGNvbWUgYWNyb3NzIHdoZXJlIHRoZXkgZml0Ci8vIHRoZSBtb2RlbCBhbmQgZXZlcnl0aGluZyBlbHNlIGlzIHJlZHVjZWQgdG8gdGV4dC4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IFRZUEVTID0gbmV3IFNldChbJ3AnLCAnaDEnLCAnaDInLCAnaDMnLCAndWwnLCAnb2wnLCAnY2hlY2snXSk7CiAgY29uc3QgTElTVFMgPSBuZXcgU2V0KFsndWwnLCAnb2wnLCAnY2hlY2snXSk7CiAgY29uc3QgTUFYX0xFVkVMID0gMzsKICBjb25zdCBCT1ggPSAn4piQJzsgICAgIC8vIOKYkAogIGNvbnN0IFRJQ0tFRCA9ICfimJEnOyAgLy8g4piRCiAgY29uc3QgQlVMTEVUID0gJ-KAoic7ICAvLyDigKIKCiAgLy8g4pSA4pSAIFRoZ",
"SBtb2RlbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYmxvY2sodHlwZSA9ICdwJywgcnVucyA9IFtdLCB7IGxldmVsID0gMCwgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgcmV0dXJuIHsgdHlwZSwgbGV2ZWw6IExJU1RTLmhhcyh0eXBlKSA_IGxldmVsIDogMCwgY2hlY2tlZDogdHlwZSA9PT0gJ2NoZWNrJyA_ICEhY2hlY2tlZCA6IGZhbHNlLCBydW5zIH07CiAgfQoKICBmdW5jdGlvbiBlbXB0eURvYygpIHsKICAgIHJldHVybiBbYmxvY2soJ3AnKV07CiAgfQoKICBjb25zdCBzYW1lTWFya3MgPSAoYSwgYikgPT4gISFhLmIgPT09ICEhYi5iICYmICEhYS5pID09PSAhIWIuaSAmJiAhIWEucyA9PT0gISFiLnMgJiYgKGEuaHJlZiB8fCAnJykgPT09IChiLmhyZWYgfHwgJycpOwoKICBmdW5jdGlvbiBjbGVhblJ1bihyKSB7CiAgICBjb25zdCBvdXQgPSB7IHRleHQ6IFN0cmluZyhyLnRleHQgfHwgJycpIH07CiAgICBpZiAoci5iKSBvdXQuYiA9IHRydWU7CiAgICBpZiAoci5pKSBvdXQuaSA9IHRydWU7CiAgICBpZiAoci5zKSBvdXQucyA9IHRydWU7CiAgICBjb25zdCBocmVmID0gci5ocmVmID8gc2FmZUhyZWYoci5ocmVmKSA6ICcnO",
"wogICAgaWYgKGhyZWYpIG91dC5ocmVmID0gaHJlZjsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBEcm9wcyBlbXB0eSBydW5zIGFuZCBqb2lucyBuZWlnaGJvdXJzIHRoYXQgbG9vayB0aGUgc2FtZSwgc28gdHdvCiAgLy8gZG9jdW1lbnRzIHRoYXQgcmVhZCBhbGlrZSBjb21wYXJlIGFsaWtlLgogIGZ1bmN0aW9uIG5vcm1hbGlzZVJ1bnMocnVucykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGNvbnN0IHIgb2YgcnVucyB8fCBbXSkgewogICAgICBpZiAoIXIgfHwgIXIudGV4dCkgY29udGludWU7CiAgICAgIGNvbnN0IGxhc3QgPSBvdXRbb3V0Lmxlbmd0aCAtIDFdOwogICAgICBpZiAobGFzdCAmJiBzYW1lTWFya3MobGFzdCwgcikpIGxhc3QudGV4dCArPSByLnRleHQ7CiAgICAgIGVsc2Ugb3V0LnB1c2goY2xlYW5SdW4ocikpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIFVua25vd24gdHlwZXMgYmVjb21lIHBhcmFncmFwaHM7IGEgbGlzdCBpdGVtIG1heSBzaXQgYXQgbW9zdCBvbmUgbGV2ZWwKICAvLyBkZWVwZXIgdGhhbiB0aGUgbGlzdCBpdGVtIGJlZm9yZSBpdCwgd2hpY2ggaXMgd2hhdCBrZWVwcyB0aGUgSFRNTCBhCiAgLy8gcHJvcGVybHkgbmVzdGVkIGxpc3QgYW5kIHRoZSBlZGl0b3IncyBpbmRlbnRzIG1lYW5pbmdmdWwuCiAgZnVuY3Rpb24gbm9ybWFsaXNlRG9jKGRvYykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBsZXQgcHJldkxldmVsID0gLTE7CiAgICBmb3IgKGNvb",
"nN0IGIgb2YgQXJyYXkuaXNBcnJheShkb2MpID8gZG9jIDogW10pIHsKICAgICAgaWYgKCFiIHx8IHR5cGVvZiBiICE9PSAnb2JqZWN0JykgY29udGludWU7CiAgICAgIGNvbnN0IHR5cGUgPSBUWVBFUy5oYXMoYi50eXBlKSA_IGIudHlwZSA6ICdwJzsKICAgICAgbGV0IGxldmVsID0gMDsKICAgICAgaWYgKExJU1RTLmhhcyh0eXBlKSkgewogICAgICAgIGxldmVsID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oTUFYX0xFVkVMLCBOdW1iZXIoYi5sZXZlbCkgfHwgMCwgcHJldkxldmVsICsgMSkpOwogICAgICAgIHByZXZMZXZlbCA9IGxldmVsOwogICAgICB9IGVsc2UgewogICAgICAgIHByZXZMZXZlbCA9IC0xOwogICAgICB9CiAgICAgIG91dC5wdXNoKGJsb2NrKHR5cGUsIG5vcm1hbGlzZVJ1bnMoYi5ydW5zKSwgeyBsZXZlbCwgY2hlY2tlZDogYi5jaGVja2VkIH0pKTsKICAgIH0KICAgIHJldHVybiBvdXQubGVuZ3RoID8gb3V0IDogZW1wdHlEb2MoKTsKICB9CgogIGNvbnN0IGJsb2NrVGV4dCA9IGIgPT4gYi5ydW5zLm1hcChyID0-IHIudGV4dCkuam9pbignJyk7CgogIGZ1bmN0aW9uIGRvY1RleHQoZG9jKSB7CiAgICByZXR1cm4gZG9jLm1hcChibG9ja1RleHQpLmpvaW4oJ1xuJyk7CiAgfQoKICBmdW5jdGlvbiBpc0VtcHR5KGRvYykgewogICAgcmV0dXJuIGRvYy5ldmVyeShiID0-ICFibG9ja1RleHQoYikudHJpbSgpKTsKICB9CgogIC8vIOKUgOKUgCBMaW5rcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDil",
"IDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gV2ViIGFuZCBtYWlsIGxpbmtzIG9ubHkuICJleGFtcGxlLmNvbS94IiBnZXRzIGh0dHBzOi8vIGluIGZyb250LCBhCiAgLy8gYmFyZSBhZGRyZXNzIGdldHMgbWFpbHRvOiwgYW5kIGFueXRoaW5nIGVsc2UgLSBqYXZhc2NyaXB0OiwgZGF0YTosCiAgLy8gZmlsZTogLSBpcyBub3QgYSBsaW5rIGF0IGFsbC4KICBmdW5jdGlvbiBzYWZlSHJlZih1cmwpIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodXJsIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXMgfHwgL1tcczw-Il0vLnRlc3QocykpIHJldHVybiAnJzsKICAgIGlmICgvXm1haWx0bzovaS50ZXN0KHMpKSByZXR1cm4gL15tYWlsdG86W15AXHNdK0BbXkBcc10rJC9pLnRlc3QocykgPyBzIDogJyc7CiAgICBpZiAoL15bXlxzQC86XStAW15cc0AvOl0rXC5bXlxzQC86XSskLy50ZXN0KHMpKSByZXR1cm4gYG1haWx0bzoke3N9YDsKICAgIGxldCBjYW5kaWRhdGUgPSBzOwogICAgaWYgKCEvXlthLXpdW2EtejAtOSsuLV0qOi9pLnRlc3QocykpIHsKICAgICAgaWYgKCEvXltcdy1dKyhcLltcdy1dKykrKDpcZCspPyhbLz8jXXwkKS8udGVzdChzKSkgcmV0dXJuICcnOwogICAgICBjYW5kaWRhdGUgP",
"SBgaHR0cHM6Ly8ke3N9YDsKICAgIH0KICAgIHRyeSB7CiAgICAgIGNvbnN0IHUgPSBuZXcgVVJMKGNhbmRpZGF0ZSk7CiAgICAgIHJldHVybiB1LnByb3RvY29sID09PSAnaHR0cDonIHx8IHUucHJvdG9jb2wgPT09ICdodHRwczonID8gdS5ocmVmIDogJyc7CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuICcnOwogICAgfQogIH0KCiAgLy8g4pSA4pSAIEhUTUwgb3V0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBlc2NIdG1sID0gcyA9PiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpLnJlcGxhY2UoLyIvZywgJyZxdW90OycpOwoKICAvLyBTcGFjZXMgSFRNTCB3b3VsZCBjb2xsYXBzZSAtIGRvdWJsZWQsIGF0IGVpdGhlciBlbmQgb2YgYSBibG9jaywgb3IKICAvLyBtZWV0aW5nIGFjcm9zcyBhIHRhZyAtIGFyZSB3cml0dGVuIGFzICZuYnNwOyBzbyB0aGV5IGNvbWUgYmFjayBhcwogIC8vIHR5cGVkLgogIGZ1bmN0aW9uIHJ1bnNIdG1sKHJ1bnMpIHsKICAgIGxldCBvdXQgPSAnJzsKICAgIGxldCBwcmV2U3BhY2UgPSBmYWxzZTsKICAgIGZvciAobGV0I",
"GkgPSAwOyBpIDwgcnVucy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IGhyZWYgPSBydW5zW2ldLmhyZWYgfHwgJyc7CiAgICAgIGxldCBqID0gaTsKICAgICAgbGV0IGlubmVyID0gJyc7CiAgICAgIHdoaWxlIChqIDwgcnVucy5sZW5ndGggJiYgKHJ1bnNbal0uaHJlZiB8fCAnJykgPT09IGhyZWYpIHsKICAgICAgICBjb25zdCByYXcgPSBydW5zW2pdLnRleHQ7CiAgICAgICAgbGV0IHQgPSBlc2NIdG1sKHJhdykucmVwbGFjZSgvIHsyfS9nLCAnICZuYnNwOycpOwogICAgICAgIGlmIChwcmV2U3BhY2UgJiYgdFswXSA9PT0gJyAnKSB0ID0gYCZuYnNwOyR7dC5zbGljZSgxKX1gOwogICAgICAgIHByZXZTcGFjZSA9IC8gJC8udGVzdChyYXcpOwogICAgICAgIGlmIChydW5zW2pdLnMpIHQgPSBgPHM-JHt0fTwvcz5gOwogICAgICAgIGlmIChydW5zW2pdLmkpIHQgPSBgPGk-JHt0fTwvaT5gOwogICAgICAgIGlmIChydW5zW2pdLmIpIHQgPSBgPGI-JHt0fTwvYj5gOwogICAgICAgIGlubmVyICs9IHQ7CiAgICAgICAgaisrOwogICAgICB9CiAgICAgIG91dCArPSBocmVmID8gYDxhIGhyZWY9IiR7ZXNjSHRtbChocmVmKX0iPiR7aW5uZXJ9PC9hPmAgOiBpbm5lcjsKICAgICAgaSA9IGo7CiAgICB9CiAgICAvLyBFZGdlIHNwYWNlcyBvZiB0aGUgd2hvbGUgYmxvY2ssIGFmdGVyIHRoZSB0YWdzIGFyZSBpbiBwbGFjZS4KICAgIHJldHVybiBvdXQucmVwbGFjZSgvXigoPzo8W14-XSs-KSopIC8sICckMSZuYnNwOycpLnJlcGxhY",
"2UoLyAoKD86PFwvW14-XSs-KSopJC8sICcmbmJzcDskMScpOwogIH0KCiAgY29uc3QgU1RZTEUgPSB7CiAgICBkb2M6ICdmb250LWZhbWlseTpBcmlhbCxIZWx2ZXRpY2Esc2Fucy1zZXJpZjtmb250LXNpemU6MTRweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOiMxZjFmMWYnLAogICAgcDogJ21hcmdpbjowJywKICAgIGgxOiAnbWFyZ2luOjE0cHggMCA0cHg7Zm9udC1zaXplOjIycHg7bGluZS1oZWlnaHQ6MS4zO2ZvbnQtd2VpZ2h0OmJvbGQnLAogICAgaDI6ICdtYXJnaW46MTJweCAwIDJweDtmb250LXNpemU6MThweDtsaW5lLWhlaWdodDoxLjM7Zm9udC13ZWlnaHQ6Ym9sZCcsCiAgICBoMzogJ21hcmdpbjoxMHB4IDAgMnB4O2ZvbnQtc2l6ZToxNXB4O2xpbmUtaGVpZ2h0OjEuMztmb250LXdlaWdodDpib2xkJywKICAgIGxpc3Q6ICdtYXJnaW46MDtwYWRkaW5nLWxlZnQ6MjZweCcsCiAgICBjaGVjazogJ21hcmdpbjowO3BhZGRpbmctbGVmdDo0cHg7bGlzdC1zdHlsZTpub25lJywKICAgIGxpOiAnbWFyZ2luOjFweCAwJywKICB9OwoKICBmdW5jdGlvbiB0b0h0bWwoZG9jSW4pIHsKICAgIGNvbnN0IGRvYyA9IG5vcm1hbGlzZURvYyhkb2NJbik7CiAgICBjb25zdCBzdGFjayA9IFtdOyAvLyBvcGVuIGxpc3RzLCBvbmUgcGVyIGxldmVsOiB7IHRhZywgY2hlY2sgfQogICAgbGV0IG91dCA9IGA8ZGl2IGRhdGEtZ2tiLW5vdGU9IjEiIHN0eWxlPSIke1NUWUxFLmRvY30iPmA7CiAgICBjb25zdCBjbG9zZSA9ICgpID0-I",
"Hsgb3V0ICs9IGA8L2xpPjwvJHtzdGFjay5wb3AoKS50YWd9PmA7IH07CgogICAgZm9yIChjb25zdCBiIG9mIGRvYykgewogICAgICBjb25zdCBpbm5lciA9IHJ1bnNIdG1sKGIucnVucyk7CiAgICAgIGlmICghTElTVFMuaGFzKGIudHlwZSkpIHsKICAgICAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSBjbG9zZSgpOwogICAgICAgIG91dCArPSBgPCR7Yi50eXBlfSBzdHlsZT0iJHtTVFlMRVtiLnR5cGVdfSI-JHtpbm5lciB8fCAnPGJyPid9PC8ke2IudHlwZX0-XG5gOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IHRhZyA9IGIudHlwZSA9PT0gJ29sJyA_ICdvbCcgOiAndWwnOwogICAgICBjb25zdCBjaGVjayA9IGIudHlwZSA9PT0gJ2NoZWNrJzsKICAgICAgd2hpbGUgKHN0YWNrLmxlbmd0aCA-IGIubGV2ZWwgKyAxKSBjbG9zZSgpOwogICAgICBpZiAoc3RhY2subGVuZ3RoID09PSBiLmxldmVsICsgMSkgewogICAgICAgIGNvbnN0IHRvcCA9IHN0YWNrW3N0YWNrLmxlbmd0aCAtIDFdOwogICAgICAgIGlmICh0b3AudGFnICE9PSB0YWcgfHwgdG9wLmNoZWNrICE9PSBjaGVjaykgY2xvc2UoKTsKICAgICAgICBlbHNlIG91dCArPSAnPC9saT4nOwogICAgICB9CiAgICAgIGlmIChzdGFjay5sZW5ndGggPT09IGIubGV2ZWwpIHsKICAgICAgICBvdXQgKz0gY2hlY2sgPyBgPHVsIGRhdGEtY2hlY2s9IjEiIHN0eWxlPSIke1NUWUxFLmNoZWNrfSI-YCA6IGA8JHt0YWd9IHN0eWxlPSIke1NUWUxFLmxpc",
"3R9Ij5gOwogICAgICAgIHN0YWNrLnB1c2goeyB0YWcsIGNoZWNrIH0pOwogICAgICB9CiAgICAgIGNvbnN0IGdseXBoID0gY2hlY2sgPyBgPHNwYW4gZGF0YS1nbHlwaD0iMSI-JHtiLmNoZWNrZWQgPyBUSUNLRUQgOiBCT1h9Jm5ic3A7PC9zcGFuPmAgOiAnJzsKICAgICAgb3V0ICs9IGA8bGkgc3R5bGU9IiR7U1RZTEUubGl9IiR7Y2hlY2sgPyBgIGRhdGEtY2hlY2tlZD0iJHtiLmNoZWNrZWQgPyAxIDogMH0iYCA6ICcnfT4ke2dseXBofSR7aW5uZXIgfHwgKGNoZWNrID8gJycgOiAnPGJyPicpfWA7CiAgICB9CiAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSBjbG9zZSgpOwogICAgcmV0dXJuIGAke291dH08L2Rpdj5gOwogIH0KCiAgLy8g4pSA4pSAIFBsYWluIHRleHQgb3V0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBydW5zUGxhaW4ocnVucykgewogICAgbGV0IG91dCA9ICcnOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBydW5zLmxlbmd0aDspIHsKICAgICAgY29uc3QgaHJlZiA9IHJ1bnNbaV0uaHJlZiB8fCAnJzsKICAgICAgbGV0IGogPSBpOwogICAgICBsZXQgdGV4dCA9ICcnOwogICAgICB3aGlsZSAoaiA8IHJ1bnMubGVuZ3RoICYmIChydW5zW2pdLmhyZWYgf",
"HwgJycpID09PSBocmVmKSB0ZXh0ICs9IHJ1bnNbaisrXS50ZXh0OwogICAgICBjb25zdCBiYXJlID0gaHJlZi5yZXBsYWNlKC9ebWFpbHRvOi8sICcnKTsKICAgICAgY29uc3Qgc2FtZSA9IHMgPT4gcy50cmltKCkucmVwbGFjZSgvXihodHRwcz86XC9cL3xtYWlsdG86KS8sICcnKS5yZXBsYWNlKC9cLyQvLCAnJyk7CiAgICAgIG91dCArPSBocmVmICYmIHNhbWUodGV4dCkgIT09IHNhbWUoaHJlZikgPyBgJHt0ZXh0fSAoJHtiYXJlfSlgIDogdGV4dDsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gdG9QbGFpbihkb2NJbikgewogICAgY29uc3QgZG9jID0gbm9ybWFsaXNlRG9jKGRvY0luKTsKICAgIGNvbnN0IGNvdW50ZXJzID0gWzAsIDAsIDAsIDBdOwogICAgcmV0dXJuIGRvYy5tYXAoYiA9PiB7CiAgICAgIGNvbnN0IHRleHQgPSBydW5zUGxhaW4oYi5ydW5zKTsKICAgICAgaWYgKCFMSVNUUy5oYXMoYi50eXBlKSkgewogICAgICAgIGNvdW50ZXJzLmZpbGwoMCk7CiAgICAgICAgcmV0dXJuIHRleHQ7CiAgICAgIH0KICAgICAgY29uc3QgcGFkID0gJyAgJy5yZXBlYXQoYi5sZXZlbCk7CiAgICAgIGZvciAobGV0IGwgPSBiLmxldmVsICsgMTsgbCA8IGNvdW50ZXJzLmxlbmd0aDsgbCsrKSBjb3VudGVyc1tsXSA9IDA7CiAgICAgIGlmIChiLnR5cGUgPT09ICdvbCcpIHJldHVybiBgJHtwYWR9JHsrK2NvdW50ZXJzW2IubGV2ZWxdfS4gJHt0ZXh0fWA7CiAgICAgIGNvdW50Z",
"XJzW2IubGV2ZWxdID0gMDsKICAgICAgaWYgKGIudHlwZSA9PT0gJ2NoZWNrJykgcmV0dXJuIGAke3BhZH0ke2IuY2hlY2tlZCA_IFRJQ0tFRCA6IEJPWH0gJHt0ZXh0fWA7CiAgICAgIHJldHVybiBgJHtwYWR9JHtCVUxMRVR9ICR7dGV4dH1gOwogICAgfSkuam9pbignXG4nKTsKICB9CgogIC8vIOKUgOKUgCBQbGFpbiB0ZXh0IGluIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBBIHBsYWluIG5vdGUgKGZyb20gYmVmb3JlIGZvcm1hdHRpbmcgZXhpc3RlZCwgb3IgcGxhaW4gbWFpbCkgYmVjb21lcwogIC8vIG9uZSBibG9jayBwZXIgbGluZS4gTGluZXMgdGhhdCBhbHJlYWR5IGxvb2sgbGlrZSBsaXN0cyAtICItICIsICLigKIgIiwKICAvLyAiMS4gIiwgIuKYkCAiIC0gYmVjb21lIGxpc3RzLCBpbmRlbnRlZCB0d28gc3BhY2VzIGEgbGV2ZWwuCiAgZnVuY3Rpb24gZnJvbVBsYWluKHRleHQpIHsKICAgIGNvbnN0IGxpbmVzID0gU3RyaW5nKHRleHQgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNwbGl0KCdcbicpOwogICAgcmV0dXJuIG5vcm1hbGlzZURvYyhsaW5lcy5tYXAobGluZSA9PiB7CiAgICAgIGNvbnN0IG0gPSAvXiggKikoPzooWy0q4oCiXSl8KFxkezEsM",
"30pWy4pXXwoW-KYkOKYkV0pKSAoLiopJC8uZXhlYyhsaW5lKTsKICAgICAgaWYgKCFtKSByZXR1cm4gYmxvY2soJ3AnLCBbeyB0ZXh0OiBsaW5lIH1dKTsKICAgICAgY29uc3QgbGV2ZWwgPSBNYXRoLmZsb29yKG1bMV0ubGVuZ3RoIC8gMik7CiAgICAgIGlmIChtWzRdKSByZXR1cm4gYmxvY2soJ2NoZWNrJywgW3sgdGV4dDogbVs1XSB9XSwgeyBsZXZlbCwgY2hlY2tlZDogbVs0XSA9PT0gVElDS0VEIH0pOwogICAgICByZXR1cm4gYmxvY2sobVszXSA_ICdvbCcgOiAndWwnLCBbeyB0ZXh0OiBtWzVdIH1dLCB7IGxldmVsIH0pOwogICAgfSkpOwogIH0KCiAgLy8g4pSA4pSAIEhUTUwgaW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IFRPS0VOX1JFID0gLzwhLS1bXHNcU10qPy0tPnw8IVxbQ0RBVEFcW1tcc1xTXSo_XF1cXT58PCFbXj5dKj58PFw_W14-XSo-fDwoXC8_KShbYS16QS1aXVthLXpBLVowLTk6LV0qKSgoPzpccytbXlxzIic-Lz1dKyg_OlxzKj1ccyooPzoiW14iXSoifCdbXiddKid8W15ccyInPTw-YF0rKSk_KSopXHMqKFwvPyk-fFtePF0rfDwvZzsKICBjb25zdCBBVFRSX1JFID0gLyhbXlxzIic-Lz1dKykoPzpccyo9XHMqK",
"D86IihbXiJdKikifCcoW14nXSopJ3woW15ccyInPTw-YF0rKSkpPy9nOwogIGNvbnN0IFNLSVAgPSBuZXcgU2V0KFsnc2NyaXB0JywgJ3N0eWxlJywgJ2hlYWQnLCAndGl0bGUnLCAndGVtcGxhdGUnLCAnc3ZnJywgJ21hdGgnLCAnbm9zY3JpcHQnLCAnaWZyYW1lJywgJ29iamVjdCcsICd4bWwnXSk7CiAgY29uc3QgUEFSQSA9IG5ldyBTZXQoWydwJywgJ2RpdicsICdibG9ja3F1b3RlJywgJ3ByZScsICdzZWN0aW9uJywgJ2FydGljbGUnLCAnaGVhZGVyJywgJ2Zvb3RlcicsICdtYWluJywgJ2FzaWRlJywKICAgICduYXYnLCAndGFibGUnLCAndGJvZHknLCAndGhlYWQnLCAndGZvb3QnLCAnY2VudGVyJywgJ2RsJywgJ2R0JywgJ2RkJywgJ2ZpZ3VyZScsICdmaWdjYXB0aW9uJywKICAgICdmb3JtJywgJ2ZpZWxkc2V0JywgJ2FkZHJlc3MnLCAnaHInLCAnYm9keScsICdodG1sJywgJ2NhcHRpb24nXSk7CiAgLy8gVGFncyB0aGF0IG1hcmsgdGV4dCwgYW5kIHRoZSBtYXJrcyB0aGV5IHN0YW5kIGZvci4gc3BhbiBhbmQgZm9udAogIC8vIGNhcnJ5IHRoZWlycyBpbiBhIHN0eWxlIGF0dHJpYnV0ZSwgaWYgYXQgYWxsLgogIGNvbnN0IElOTElORSA9IHsKICAgIGI6IFsnYiddLCBzdHJvbmc6IFsnYiddLCBpOiBbJ2knXSwgZW06IFsnaSddLCBjaXRlOiBbJ2knXSwgczogWydzJ10sIHN0cmlrZTogWydzJ10sIGRlbDogWydzJ10sIHNwYW46IFtdLCBmb250OiBbXSwKICB9OwogIGNvbnN0IEhFQURJTkdTID0geyBoMTogJ2gxJ",
"ywgaDI6ICdoMicsIGgzOiAnaDMnLCBoNDogJ2gzJywgaDU6ICdoMycsIGg2OiAnaDMnIH07CgogIGZ1bmN0aW9uIGF0dHJzT2YocykgewogICAgY29uc3Qgb3V0ID0ge307CiAgICBsZXQgbTsKICAgIEFUVFJfUkUubGFzdEluZGV4ID0gMDsKICAgIHdoaWxlICgobSA9IEFUVFJfUkUuZXhlYyhzIHx8ICcnKSkpIHsKICAgICAgb3V0W21bMV0udG9Mb3dlckNhc2UoKV0gPSB1dGlsLmRlY29kZUVudGl0aWVzKG1bMl0gIT09IHVuZGVmaW5lZCA_IG1bMl0gOiBtWzNdICE9PSB1bmRlZmluZWQgPyBtWzNdIDogbVs0XSB8fCAnJyk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gQm9sZCwgaXRhbGljIGFuZCBzdHJpa2UtdGhyb3VnaCB3cml0dGVuIGFzIGlubGluZSBzdHlsZXMsIGFzIE91dGxvb2sKICAvLyBhbmQgcGFzdGVkIHdlYiB0ZXh0IG9mdGVuIGRvLCBjb3VudCB0aGUgc2FtZSBhcyB0aGUgdGFncy4KICBmdW5jdGlvbiBzdHlsZU1hcmtzKHN0eWxlKSB7CiAgICBjb25zdCBzID0gU3RyaW5nKHN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgbWFya3MgPSBbXTsKICAgIGlmICgvZm9udC13ZWlnaHRccyo6XHMqKGJvbGR8Ym9sZGVyfFs2LTldMDApLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdiJyk7CiAgICBpZiAoL2ZvbnQtc3R5bGVccyo6XHMqaXRhbGljLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdpJyk7CiAgICBpZiAoL3RleHQtZGVjb3JhdGlvbigtbGluZSk_XHMqOlteO10qbGluZS10a",
"HJvdWdoLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdzJyk7CiAgICByZXR1cm4gbWFya3M7CiAgfQoKICAvLyBXaGV0aGVyIGEgYnJvd3NlciB3b3VsZCBzaG93IHNwYWNlIGJlbG93IGEgPHA-OiBpdCBkb2VzIHVubGVzcyBpdHMKICAvLyBzdHlsZSBzYXlzIG90aGVyd2lzZS4gV29yZCBhbmQgT3V0bG9vayBwYXJhZ3JhcGhzIChNc29Ob3JtYWwpIGFyZQogIC8vIGxpbmVzLCBhbmQgc28gYXJlIHRoZSBlZGl0b3IncyBvd24gYW5kIEdvb2dsZSBEb2NzJy4KICBmdW5jdGlvbiBwYXJhR2FwKGEpIHsKICAgIGlmICgvXGJNc28vLnRlc3QoYS5jbGFzcyB8fCAnJykpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IHN0eWxlID0gU3RyaW5nKGEuc3R5bGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCB6ZXJvID0gdiA9PiAvXi0_MChcLjArKT8oW2Etel0rfCUpPyQvLnRlc3QodiB8fCAnJyk7CiAgICBjb25zdCBib3R0b20gPSAvKD86Xnw7KVxzKm1hcmdpbi1ib3R0b21ccyo6XHMqKFteOyFdKykvLmV4ZWMoc3R5bGUpOwogICAgaWYgKGJvdHRvbSkgcmV0dXJuICF6ZXJvKGJvdHRvbVsxXS50cmltKCkpOwogICAgY29uc3QgYWxsID0gLyg_Ol58OylccyptYXJnaW5ccyo6XHMqKFteOyFdKykvLmV4ZWMoc3R5bGUpOwogICAgaWYgKGFsbCkgewogICAgICBjb25zdCB2ID0gYWxsWzFdLnRyaW0oKS5zcGxpdCgvXHMrLyk7CiAgICAgIHJldHVybiAhemVybyh2Lmxlbmd0aCA-PSAzID8gdlsyXSA6IHZbMF0pOwogICAgfQogI",
"CAgcmV0dXJuIHRydWU7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUh0bWwoaHRtbCkgewogICAgY29uc3QgYmxvY2tzID0gW107CiAgICBjb25zdCBsaXN0cyA9IFtdOyAgICAgICAgIC8vIG9wZW4gbGlzdHM6IHsgdHlwZSwgbGlPcGVuIH0KICAgIGNvbnN0IG1hcmtzID0geyBiOiAwLCBpOiAwLCBzOiAwIH07CiAgICBjb25zdCBocmVmcyA9IFtdOwogICAgY29uc3QgaW5saW5lID0gW107ICAgICAgICAvLyBvcGVuIGlubGluZSB0YWdzOiB7IG5hbWUsIG1hcmtzIH0gb3IgeyBuYW1lLCBnbHlwaDogdHJ1ZSB9CiAgICBsZXQgc2tpcCA9IDA7CiAgICBsZXQgZ2x5cGggPSAwOwogICAgbGV0IGN1ciA9IG51bGw7CiAgICBsZXQgcm93ID0gbnVsbDsgICAgICAgICAgIC8vIGFuIG9wZW4gdGFibGUgcm93OiB7IGNlbGxzLCB0aCB9CiAgICBsZXQgcHJlID0gMDsgICAgICAgICAgICAgIC8vIGluc2lkZSA8cHJlPjogbGluZSBicmVha3MgYW5kIHNwYWNlcyBhcmUgdGV4dAogICAgbGV0IHBhcmEgPSBudWxsOyAgICAgICAgICAvLyB0aGUgb3BlbiA8cD46IHsgZ2FwIH0KICAgIGxldCBnYXAgPSBmYWxzZTsgICAgICAgICAgLy8gYSA8cD4ganVzdCBjbG9zZWQgd2l0aCBzcGFjZSBiZWxvdyBpdAogICAgbGV0IG91cnMgPSBmYWxzZTsgICAgICAgICAvLyBpbnNpZGUgYSBub3RlJ3Mgb3duIEhUTUwsIHdoZXJlIHBhcmFncmFwaHMgYXJlIGxpbmVzCgogICAgY29uc3QgbGV2ZWwgPSAoKSA9PiBNYXRoLm1heCgwLCBsaXN0cy5sZW5nd",
"GggLSAxKTsKICAgIGNvbnN0IG9wZW4gPSAodHlwZSwgZXh0cmEpID0-IHsKICAgICAgLy8gVGhlIHNwYWNlIGEgYnJvd3NlciBzaG93cyBhZnRlciBhIHBhcmFncmFwaCBpcyBhbiBlbXB0eSBsaW5lIGluIGEKICAgICAgLy8gbm90ZSAtIHdoaWNoIGhhcyBubyBzcGFjZSBiZXR3ZWVuIHBhcmFncmFwaHMgLSBleGNlcHQgYmVmb3JlIGEKICAgICAgLy8gaGVhZGluZywgd2hpY2ggaGFzIGl0cyBvd24uCiAgICAgIGlmIChnYXApIHsKICAgICAgICBnYXAgPSBmYWxzZTsKICAgICAgICBjb25zdCBsYXN0ID0gYmxvY2tzW2Jsb2Nrcy5sZW5ndGggLSAxXTsKICAgICAgICBpZiAobGFzdCAmJiAhSEVBRElOR1NbdHlwZV0gJiYgbGFzdC5ydW5zLnNvbWUociA9PiAvXFMvLnRlc3Qoci50ZXh0KSkpIGJsb2Nrcy5wdXNoKGJsb2NrKCdwJykpOwogICAgICB9CiAgICAgIGN1ciA9IGJsb2NrKHR5cGUsIFtdLCBleHRyYSk7CiAgICAgIGJsb2Nrcy5wdXNoKGN1cik7CiAgICAgIHJldHVybiBjdXI7CiAgICB9OwogICAgY29uc3QgZW5kID0gKCkgPT4geyBjdXIgPSBudWxsOyB9OwogICAgLy8gV2hlcmUgdGV4dCBsYW5kcyB3aGVuIG5vIGJsb2NrIGlzIG9wZW46IGluc2lkZSBhIGxpc3QgaXRlbSwgYQogICAgLy8gY29udGludWF0aW9uIG9mIHRoYXQgaXRlbTsgb3RoZXJ3aXNlIGEgbmV3IHBhcmFncmFwaC4KICAgIGNvbnN0IGNvbnRleHQgPSAoKSA9PiB7CiAgICAgIGNvbnN0IHRvcCA9IGxpc3RzW2xpc3RzLmxlbmd0aCAtIDFdO",
"wogICAgICBpZiAodG9wICYmIHRvcC5saU9wZW4pIHJldHVybiBvcGVuKHRvcC50eXBlLCB7IGxldmVsOiBsZXZlbCgpLCBjaGVja2VkOiBmYWxzZSB9KTsKICAgICAgcmV0dXJuIG9wZW4oJ3AnKTsKICAgIH07CiAgICBjb25zdCBhcHBseSA9IChsaXN0LCBkZWx0YSkgPT4gbGlzdC5mb3JFYWNoKG0gPT4geyBtYXJrc1ttXSArPSBkZWx0YTsgfSk7CgogICAgbGV0IG07CiAgICBUT0tFTl9SRS5sYXN0SW5kZXggPSAwOwogICAgd2hpbGUgKChtID0gVE9LRU5fUkUuZXhlYyhTdHJpbmcoaHRtbCB8fCAnJykpKSkgewogICAgICBjb25zdCBbd2hvbGUsIGNsb3NpbmcsIHJhd05hbWUsIHJhd0F0dHJzLCBzZWxmQ2xvc2luZ10gPSBtOwogICAgICBpZiAocmF3TmFtZSA9PT0gdW5kZWZpbmVkKSB7CiAgICAgICAgaWYgKHdob2xlWzBdID09PSAnPCcgJiYgd2hvbGUubGVuZ3RoID4gMSkgY29udGludWU7IC8vIGNvbW1lbnQsIGRvY3R5cGUsIENEQVRBCiAgICAgICAgaWYgKHNraXApIGNvbnRpbnVlOwogICAgICAgIGlmIChnbHlwaCkgewogICAgICAgICAgLy8gV29yZCdzIGxpc3QgbWFya2VyICgiwrciLCAiMS4iLCAiYSkiKTogbm90IHRleHQsIGJ1dCBpdCBzYXlzCiAgICAgICAgICAvLyB3aGV0aGVyIHRoZSBsaXN0IGlzIGJ1bGxldGVkIG9yIG51bWJlcmVkLgogICAgICAgICAgaWYgKGN1ciAmJiBjdXIud29yZExpc3QpIGN1ci5tYXJrZXIgKz0gdXRpbC5kZWNvZGVFbnRpdGllcyh3aG9sZSk7CiAgICAgICAgICBjb250a",
"W51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKHByZSkgewogICAgICAgICAgLy8gRWFjaCBsaW5lIG9mIHByZWZvcm1hdHRlZCB0ZXh0IGlzIGEgbGluZSBvZiB0aGUgbm90ZSwgaXRzCiAgICAgICAgICAvLyBzcGFjZXMga2VwdCAoYXMgJm5ic3A7LCB3aGljaCB0aGUgdGlkeWluZyBiZWxvdyBsZWF2ZXMgYWxvbmUpLgogICAgICAgICAgbGV0IHJhdyA9IHV0aWwuZGVjb2RlRW50aXRpZXMod2hvbGUpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpOwogICAgICAgICAgaWYgKHByZS5mcmVzaCkgcmF3ID0gcmF3LnJlcGxhY2UoL15cbi8sICcnKTsKICAgICAgICAgIHByZS5mcmVzaCA9IGZhbHNlOwogICAgICAgICAgcmF3LnNwbGl0KCdcbicpLmZvckVhY2goKGxpbmUsIGspID0-IHsKICAgICAgICAgICAgaWYgKGspIHsKICAgICAgICAgICAgICBlbmQoKTsKICAgICAgICAgICAgICBvcGVuKCdwJykucHJlTGluZSA9IHRydWU7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgaWYgKCFsaW5lKSByZXR1cm47CiAgICAgICAgICAgIGlmICghY3VyKSBjb250ZXh0KCk7CiAgICAgICAgICAgIGN1ci5ydW5zLnB1c2goewogICAgICAgICAgICAgIHRleHQ6IGxpbmUucmVwbGFjZSgvXHQvZywgJyAgICAnKS5yZXBsYWNlKC8gL2csICdcdTAwYTAnKSwKICAgICAgICAgICAgICBiOiBtYXJrcy5iID4gMCwgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLAogICAgICAgICAgICAgIGhyZWY6IGhyZWZzLmxlbmd0aCA_IGhyZWZzW",
"2hyZWZzLmxlbmd0aCAtIDFdIDogJycsCiAgICAgICAgICAgIH0pOwogICAgICAgICAgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3QgdGV4dCA9IHV0aWwuZGVjb2RlRW50aXRpZXMod2hvbGUgPT09ICc8JyA_ICc8JyA6IHdob2xlKS5yZXBsYWNlKC9bIFx0XHJcblxmXSsvZywgJyAnKTsKICAgICAgICBpZiAoIWN1cikgewogICAgICAgICAgLy8gT25seSBIVE1MJ3Mgb3duIHdoaXRlc3BhY2UgaXMgbm90aGluZzsgYW4gJm5ic3A7IGlzIGEgc3BhY2Ugc29tZW9uZSB0eXBlZC4KICAgICAgICAgIGlmICghL1teIFx0XHJcblxmXS8udGVzdCh0ZXh0KSkgY29udGludWU7CiAgICAgICAgICBjb250ZXh0KCk7CiAgICAgICAgfQogICAgICAgIGN1ci5ydW5zLnB1c2goewogICAgICAgICAgdGV4dCwKICAgICAgICAgIGI6IG1hcmtzLmIgPiAwLCBpOiBtYXJrcy5pID4gMCwgczogbWFya3MucyA-IDAsCiAgICAgICAgICBocmVmOiBocmVmcy5sZW5ndGggPyBocmVmc1tocmVmcy5sZW5ndGggLSAxXSA6ICcnLAogICAgICAgIH0pOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CgogICAgICBjb25zdCBuYW1lID0gcmF3TmFtZS50b0xvd2VyQ2FzZSgpOwogICAgICBjb25zdCBpc0Nsb3NlID0gY2xvc2luZyA9PT0gJy8nOwogICAgICBpZiAoU0tJUC5oYXMobmFtZSkpIHsKICAgICAgICBpZiAoIXNlbGZDbG9zaW5nKSBza2lwID0gTWF0aC5tYXgoMCwgc2tpcCArIChpc0Nsb3NlID8gLTEgO",
"iAxKSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKHNraXApIGNvbnRpbnVlOwogICAgICBjb25zdCBhID0gaXNDbG9zZSA_IHt9IDogYXR0cnNPZihyYXdBdHRycyk7CgogICAgICBpZiAobmFtZSA9PT0gJ2JyJykgewogICAgICAgIGlmIChjdXIpIGVuZCgpOwogICAgICAgIGVsc2UgeyBjb250ZXh0KCk7IGVuZCgpOyB9CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKEhFQURJTkdTW25hbWVdKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSBvcGVuKEhFQURJTkdTW25hbWVdKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3VsJyB8fCBuYW1lID09PSAnb2wnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UpIGxpc3RzLnBvcCgpOwogICAgICAgIGVsc2UgbGlzdHMucHVzaCh7IHR5cGU6IGFbJ2RhdGEtY2hlY2snXSA_ICdjaGVjaycgOiBuYW1lLCBsaU9wZW46IGZhbHNlIH0pOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnbGknKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFsaXN0cy5sZW5ndGgpIGxpc3RzLnB1c2goeyB0eXBlOiAndWwnLCBsaU9wZW46IGZhbHNlLCBpbXBsaWVkOiB0cnVlIH0pOwogICAgICAgIGNvbnN0IHRvcCA9IGxpc3RzW2xpc3RzLmxlbmd0aCAtIDFdOwogICAgICAgIHRvcC5saU9wZW4gPSAhaXNDbG9zZTsKICAgICAgICBpZ",
"iAoIWlzQ2xvc2UpIHsKICAgICAgICAgIG9wZW4odG9wLnR5cGUsIHsgbGV2ZWw6IGxldmVsKCksIGNoZWNrZWQ6IGFbJ2RhdGEtY2hlY2tlZCddID09PSAnMScgfSk7CiAgICAgICAgICAvLyBPbmUgb2Ygb3VyczogaXRzIGJveCBpcyBpbiB0aGUgYXR0cmlidXRlLCBhbmQgYSDimJAgYXQgdGhlIHN0YXJ0CiAgICAgICAgICAvLyBvZiBpdHMgdGV4dCBpcyB0ZXh0LgogICAgICAgICAgaWYgKGFbJ2RhdGEtY2hlY2tlZCddICE9PSB1bmRlZmluZWQpIGN1ci5vdXJzID0gdHJ1ZTsKICAgICAgICAgIC8vIEEgY2hlY2tsaXN0IGl0ZW0gbWFya2VkIHVwIGZvciBzY3JlZW4gcmVhZGVycyAoR29vZ2xlIERvY3MpLgogICAgICAgICAgZWxzZSBpZiAoYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJyB8fCBhWydhcmlhLWNoZWNrZWQnXSA9PT0gJ2ZhbHNlJykgewogICAgICAgICAgICBjdXIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICAgIGN1ci5jaGVja2VkID0gYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJzsKICAgICAgICAgICAgY3VyLm91cnMgPSB0cnVlOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgICBlbHNlIGlmICh0b3AuaW1wbGllZCkgbGlzdHMucG9wKCk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQSB0YWJsZSByb3cgaXMgb25lIGxpbmUsIGl0cyBjZWxscyBzZXBhcmF0ZWQgYnkgIiB8ICI6IHRoZXJlIGFyZQogICAgICAvLyBubyB0YWJsZXMgaW4gYSBub3RlLCBhbmQgdGhpc",
"yBrZWVwcyBhIHBhc3RlZCByb3cgcmVhZGFibGUuCiAgICAgIC8vIEEgaGVhZGluZyBjZWxsIGlzIGJvbGQsIGFzIGEgYnJvd3NlciBzaG93cyBpdC4KICAgICAgY29uc3QgaGVhZENlbGwgPSBvbiA9PiB7CiAgICAgICAgaWYgKCFyb3cgfHwgcm93LnRoID09PSBvbikgcmV0dXJuOwogICAgICAgIHJvdy50aCA9IG9uOwogICAgICAgIG1hcmtzLmIgKz0gb24gPyAxIDogLTE7CiAgICAgIH07CiAgICAgIGlmIChuYW1lID09PSAndHInKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaGVhZENlbGwoZmFsc2UpOwogICAgICAgIHJvdyA9IGlzQ2xvc2UgPyBudWxsIDogeyBjZWxsczogMCwgdGg6IGZhbHNlIH07CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKG5hbWUgPT09ICd0ZCcgfHwgbmFtZSA9PT0gJ3RoJykgewogICAgICAgIGlmICghcm93KSB7IGVuZCgpOyBjb250aW51ZTsgfQogICAgICAgIGhlYWRDZWxsKGZhbHNlKTsKICAgICAgICBpZiAoIWlzQ2xvc2UgJiYgIXNlbGZDbG9zaW5nKSB7CiAgICAgICAgICBpZiAocm93LmNlbGxzID4gMCkgewogICAgICAgICAgICBpZiAoIWN1cikgY29udGV4dCgpOwogICAgICAgICAgICBjdXIucnVucy5wdXNoKHsgdGV4dDogJyB8ICcsIGI6IGZhbHNlLCBpOiBmYWxzZSwgczogZmFsc2UsIGhyZWY6ICcnIH0pOwogICAgICAgICAgfQogICAgICAgICAgcm93LmNlbGxzKys7CiAgICAgICAgICBoZWFkQ2VsbChuYW1lID09PSAndGgnKTsKICAgICAgICB9CiAgI",
"CAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKG5hbWUgPT09ICdwcmUnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UpIHsKICAgICAgICAgIC8vIFRoZSBsaW5lIGJyZWFrIGJlZm9yZSA8L3ByZT4gZW5kcyB0aGUgbGFzdCBsaW5lOyBpdCBpcyBub3Qgb25lIG1vcmUuCiAgICAgICAgICBjb25zdCBsYXN0ID0gYmxvY2tzW2Jsb2Nrcy5sZW5ndGggLSAxXTsKICAgICAgICAgIGlmIChsYXN0ICYmIGxhc3QucHJlTGluZSAmJiAhbGFzdC5ydW5zLmxlbmd0aCkgYmxvY2tzLnBvcCgpOwogICAgICAgICAgcHJlID0gMDsKICAgICAgICB9IGVsc2UgaWYgKCFzZWxmQ2xvc2luZykgewogICAgICAgICAgcHJlID0geyBmcmVzaDogdHJ1ZSB9OwogICAgICAgIH0KICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICAvLyBBIHRpY2tlZCBvciBlbXB0eSBib3ggYXQgdGhlIHN0YXJ0IG9mIGEgbGluZSAtIGEgdGFzayBsaXN0IG9uIGEKICAgICAgLy8gd2ViIHBhZ2UgKEdpdEh1YikgLSBtYWtlcyBpdCBhIGNoZWNrbGlzdCBpdGVtLgogICAgICBpZiAobmFtZSA9PT0gJ2lucHV0JyAmJiBTdHJpbmcoYS50eXBlIHx8ICcnKS50b0xvd2VyQ2FzZSgpID09PSAnY2hlY2tib3gnKSB7CiAgICAgICAgaWYgKCFjdXIpIGNvbnRleHQoKTsKICAgICAgICBpZiAoIWN1ci5ydW5zLnNvbWUociA9PiAvXFMvLnRlc3Qoci50ZXh0KSkpIHsKICAgICAgICAgIGN1ci50eXBlID0gJ2NoZWNrJzsKICAgICAgICAgI",
"GN1ci5jaGVja2VkID0gJ2NoZWNrZWQnIGluIGE7CiAgICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiBhWydkYXRhLWdrYi1ub3RlJ10gIT09IHVuZGVmaW5lZCkgb3VycyA9IHRydWU7CiAgICAgIC8vIEEgYmxvY2sgY29waWVkIG91dCBvZiBhIG5vdGUncyBlZGl0b3Iga2VlcHMgaXRzIGtpbmQuCiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiAhaXNDbG9zZSAmJiBUWVBFUy5oYXMoYVsnZGF0YS10eXBlJ10pKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgb3BlbihhWydkYXRhLXR5cGUnXSwgeyBsZXZlbDogTnVtYmVyKGFbJ2RhdGEtbGV2ZWwnXSkgfHwgMCwgY2hlY2tlZDogYVsnZGF0YS1jaGVja2VkJ10gPT09ICcxJyB9KTsKICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gV29yZCB3cml0ZXMgYSBsaXN0IGFzIHBhcmFncmFwaHMgc3R5bGVkICJtc28tbGlzdDogbDAgbGV2ZWwxIi4KICAgICAgaWYgKG5hbWUgPT09ICdwJyAmJiAhaXNDbG9zZSkgewogICAgICAgIGNvbnN0IHdsID0gL21zby1saXN0XHMqOlxzKmxcZCtccytsZXZlbChcZCkvaS5leGVjKGEuc3R5bGUgfHwgJycpOwogICAgICAgIGlmICh3bCkgewogICAgICAgICAgZW5kKCk7CiAgICAgICAgICBvcGVuKCd1bCcsIHsgbGV2ZWw6IE51bWJlcih3bFsxXSkgLSAxIH0pOwogICAgI",
"CAgICAgY3VyLndvcmRMaXN0ID0gdHJ1ZTsKICAgICAgICAgIGN1ci5tYXJrZXIgPSAnJzsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3AnKSB7CiAgICAgICAgaWYgKHBhcmEgJiYgcGFyYS5nYXApIGdhcCA9IHRydWU7CiAgICAgICAgcGFyYSA9IG51bGw7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSB7CiAgICAgICAgICBjb25zdCB0b3AgPSBsaXN0c1tsaXN0cy5sZW5ndGggLSAxXTsKICAgICAgICAgIHBhcmEgPSB7IGdhcDogIW91cnMgJiYgIXJvdyAmJiAhKHRvcCAmJiB0b3AubGlPcGVuKSAmJiBwYXJhR2FwKGEpIH07CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChQQVJBLmhhcyhuYW1lKSkgewogICAgICAgIC8vIEluc2lkZSBhIHRhYmxlIGNlbGwsIG9yIHN0cmFpZ2h0IGluc2lkZSBhIGxpc3QgaXRlbSB0aGF0IGhhcyBubwogICAgICAgIC8vIHRleHQgeWV0IChHb29nbGUgRG9jcyB3cmFwcyBldmVyeSBpdGVtIGluIGEgPHA-KSwgdGhlIGxpbmUgZ29lcyBvbi4KICAgICAgICBpZiAocm93KSBjb250aW51ZTsKICAgICAgICBpZiAoY3VyICYmICFjdXIucnVucy5sZW5ndGggJiYgIWlzQ2xvc2UpIGNvbnRpbnVlOwogICAgICAgIGVuZCgpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnYScpIHsKICAgICAgICBpZiAoaXNDbG9zZSkgaHJlZnMucG9wKCk7CiAgICAgICAgZWxzZSBpZiAoIXNlbGZDbG9zaW5nKSBoc",
"mVmcy5wdXNoKHNhZmVIcmVmKGEuaHJlZikpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChJTkxJTkVbbmFtZV0pIHsKICAgICAgICBpZiAoc2VsZkNsb3NpbmcpIGNvbnRpbnVlOwogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgICAvLyBUaGUgaW5uZXJtb3N0IG9wZW4gdGFnIG9mIHRoYXQgbmFtZSAtIG1haWwgaXMgbm90IGFsd2F5cyB0aWRpbHkgbmVzdGVkLgogICAgICAgICAgZm9yIChsZXQgayA9IGlubGluZS5sZW5ndGggLSAxOyBrID49IDA7IGstLSkgewogICAgICAgICAgICBpZiAoaW5saW5lW2tdLm5hbWUgIT09IG5hbWUpIGNvbnRpbnVlOwogICAgICAgICAgICBjb25zdCBbZ290XSA9IGlubGluZS5zcGxpY2UoaywgMSk7CiAgICAgICAgICAgIGlmIChnb3QuZ2x5cGgpIGdseXBoID0gTWF0aC5tYXgoMCwgZ2x5cGggLSAxKTsKICAgICAgICAgICAgZWxzZSBhcHBseShnb3QubWFya3MsIC0xKTsKICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICB9CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3Qgc3R5bGUgPSBTdHJpbmcoYS5zdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAoYVsnZGF0YS1nbHlwaCddIHx8IC9tc28tbGlzdFxzKjpccyppZ25vcmUvLnRlc3Qoc3R5bGUpKSB7CiAgICAgICAgICBpbmxpbmUucHVzaCh7IG5hbWUsIGdseXBoOiB0cnVlIH0pOwogICAgICAgICAgZ2x5cGgrKzsKICAgICAgICAgIGNvbnRpbnVlO",
"wogICAgICAgIH0KICAgICAgICBsZXQgZ290ID0gWy4uLklOTElORVtuYW1lXSwgLi4uc3R5bGVNYXJrcyhzdHlsZSldOwogICAgICAgIC8vIEdvb2dsZSBEb2NzIHdyYXBzIGEgd2hvbGUgcGFzdGUgaW4gPGIgc3R5bGU9ImZvbnQtd2VpZ2h0Om5vcm1hbCI-LgogICAgICAgIGlmICgvZm9udC13ZWlnaHRccyo6XHMqKG5vcm1hbHxsaWdodGVyfFsxLTVdMDApXGIvLnRlc3Qoc3R5bGUpKSBnb3QgPSBnb3QuZmlsdGVyKHggPT4geCAhPT0gJ2InKTsKICAgICAgICBpZiAoL2ZvbnQtc3R5bGVccyo6XHMqbm9ybWFsLy50ZXN0KHN0eWxlKSkgZ290ID0gZ290LmZpbHRlcih4ID0-IHggIT09ICdpJyk7CiAgICAgICAgZ290ID0gWy4uLm5ldyBTZXQoZ290KV07CiAgICAgICAgaW5saW5lLnB1c2goeyBuYW1lLCBtYXJrczogZ290IH0pOwogICAgICAgIGFwcGx5KGdvdCwgMSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQW55dGhpbmcgZWxzZSAoaW1nLCB1LCBzdXAsIGNvZGUsIOKApik6IGl0cyB0ZXh0IGlzIGtlcHQsIHRoZSB0YWcgaXMgbm90LgogICAgfQogICAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKG1hcmtzKSkgbWFya3Nba10gPSBNYXRoLm1heCgwLCBtYXJrc1trXSk7CgogICAgLy8gVGlkeSBlYWNoIGJsb2NrOiBjb2xsYXBzZSB0aGUgd2hpdGVzcGFjZSBIVE1MIHdvdWxkIGNvbGxhcHNlLCB0aGVuCiAgICAvLyB0dXJuIHRoZSAmbmJzcDtzIHRoYXQgaGVsZCBkZWxpYmVyYXRlIHNwY",
"WNlcyBiYWNrIGludG8gc3BhY2VzLgogICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICBjb25zdCBydW5zID0gYi5ydW5zOwogICAgICBpZiAocnVucy5sZW5ndGgpIHsKICAgICAgICBydW5zWzBdLnRleHQgPSBydW5zWzBdLnRleHQucmVwbGFjZSgvXiArLywgJycpOwogICAgICAgIHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0ID0gcnVuc1tydW5zLmxlbmd0aCAtIDFdLnRleHQucmVwbGFjZSgvICskLywgJycpOwogICAgICAgIGZvciAobGV0IGkgPSAxOyBpIDwgcnVucy5sZW5ndGg7IGkrKykgewogICAgICAgICAgaWYgKC8gJC8udGVzdChydW5zW2kgLSAxXS50ZXh0KSkgcnVuc1tpXS50ZXh0ID0gcnVuc1tpXS50ZXh0LnJlcGxhY2UoL14gKy8sICcnKTsKICAgICAgICB9CiAgICAgICAgZm9yIChjb25zdCByIG9mIHJ1bnMpIHIudGV4dCA9IHIudGV4dC5yZXBsYWNlKC_CoC9nLCAnICcpOwogICAgICB9CiAgICAgIGlmIChiLndvcmRMaXN0ICYmIC9eXHMqKFxkK3xbYS16XXxbaXZ4bGNdKylbLildXHMqJC9pLnRlc3QoYi5tYXJrZXIgfHwgJycpKSBiLnR5cGUgPSAnb2wnOwogICAgICAvLyBBIGNoZWNrIGJveCBkcmF3biBhcyB0ZXh0IChtYWlsIGZyb20gZWxzZXdoZXJlLCBvciBhIGxpc3Qgd2hvc2UKICAgICAgLy8gbWFya2VycyB3ZXJlIGxvc3QpIHN0aWxsIGNvdW50cyBhcyBhIGNoZWNrIGJveC4KICAgICAgaWYgKExJU1RTLmhhcyhiLnR5cGUpICYmIHJ1bnMubGVuZ3RoICYmICFiLm91cnMpI",
"HsKICAgICAgICBjb25zdCBnID0gL14oW-KYkOKYkV0pID8vLmV4ZWMocnVuc1swXS50ZXh0KTsKICAgICAgICBpZiAoZykgewogICAgICAgICAgcnVuc1swXS50ZXh0ID0gcnVuc1swXS50ZXh0LnNsaWNlKGdbMF0ubGVuZ3RoKTsKICAgICAgICAgIGlmIChiLnR5cGUgPT09ICd1bCcpIGIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICBpZiAoYi50eXBlID09PSAnY2hlY2snKSBiLmNoZWNrZWQgPSBnWzFdID09PSBUSUNLRUQ7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICByZXR1cm4gbm9ybWFsaXNlRG9jKGJsb2Nrcyk7CiAgfQoKICAvLyDilIDilIAgTWFya2Rvd24gaW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUZXh0IGNvcGllZCBmcm9tIGEgY2hhdCBhc3Npc3RhbnQsIGEgUkVBRE1FIG9yIGEgTWFya2Rvd24gZWRpdG9yCiAgLy8gYXJyaXZlcyBhcyBwbGFpbiB0ZXh0IGZ1bGwgb2YgKipzdGFycyoqIGFuZCAiLSAiIGxpbmVzLiBUaGUgY29tbW9uCiAgLy8gcGFydCBvZiBNYXJrZG93biBiZWNvbWVzIGZvcm1hdHRpbmc7IHRoZSByZXN0IHN0YXlzIGFzIHR5cGVkLgoKICBmdW5jdGlvbiBtZElubGluZShzcmMsIG1hcmtzID0ge30pIHsKICAgI",
"GNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgcyA9IFN0cmluZyhzcmMgfHwgJycpOwogICAgbGV0IGJ1ZiA9ICcnOwogICAgY29uc3QgZmx1c2ggPSAoKSA9PiB7CiAgICAgIGlmIChidWYpIG91dC5wdXNoKHsgdGV4dDogYnVmLCAuLi5tYXJrcyB9KTsKICAgICAgYnVmID0gJyc7CiAgICB9OwogICAgY29uc3QgbmVzdGVkID0gKGlubmVyLCBleHRyYSkgPT4gewogICAgICBmbHVzaCgpOwogICAgICBvdXQucHVzaCguLi5tZElubGluZShpbm5lciwgeyAuLi5tYXJrcywgLi4uZXh0cmEgfSkpOwogICAgfTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IHJlc3QgPSBzLnNsaWNlKGkpOwogICAgICBjb25zdCBwcmV2ID0gaSA_IHNbaSAtIDFdIDogJyc7CiAgICAgIGxldCBtOwogICAgICBpZiAoKG0gPSAvXlxcKFtcXGAqX3t9W1xdKCkjK1wtLiF-fD5dKS8uZXhlYyhyZXN0KSkpIHsgYnVmICs9IG1bMV07IGkgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICgobSA9IC9eYChbXmBcbl0rKWAvLmV4ZWMocmVzdCkpKSB7IGJ1ZiArPSBtWzFdOyBpICs9IG1bMF0ubGVuZ3RoOyBjb250aW51ZTsgfQogICAgICBpZiAoKG0gPSAvXlxbKFteXF1cbl0rKVxdXChccyo8PyhbXilccz5dKyk-Pyg_OlxzKyJbXiJdKiIpP1xzKlwpLy5leGVjKHJlc3QpKSkgewogICAgICAgIGNvbnN0IGhyZWYgPSBzYWZlSHJlZihtWzJdKTsKICAgICAgICBuZXN0ZWQobVsxXSwgaHJlZiA_I",
"HsgaHJlZiB9IDoge30pOwogICAgICAgIGkgKz0gbVswXS5sZW5ndGg7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKChtID0gL148KCg_Omh0dHBzPzpcL1wvfG1haWx0bzopW14-XHNdKyk-Ly5leGVjKHJlc3QpKSkgewogICAgICAgIGZsdXNoKCk7CiAgICAgICAgY29uc3QgaHJlZiA9IHNhZmVIcmVmKG1bMV0pOwogICAgICAgIG91dC5wdXNoKHsgdGV4dDogbVsxXS5yZXBsYWNlKC9ebWFpbHRvOi8sICcnKSwgLi4ubWFya3MsIC4uLihocmVmID8geyBocmVmIH0gOiB7fSkgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoKG0gPSAvXihcKlwqfF9fKSg_PVxTKShbXHNcU10qP1xTKVwxLy5leGVjKHJlc3QpKSAmJiAhKG1bMV0gPT09ICdfXycgJiYgL1tccHtMfVxwe059XS91LnRlc3QocHJldikpKSB7CiAgICAgICAgbmVzdGVkKG1bMl0sIHsgYjogdHJ1ZSB9KTsKICAgICAgICBpICs9IG1bMF0ubGVuZ3RoOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICgobSA9IC9efn4oPz1cUykoW1xzXFNdKj9cUyl-fi8uZXhlYyhyZXN0KSkpIHsgbmVzdGVkKG1bMV0sIHsgczogdHJ1ZSB9KTsgaSArPSBtWzBdLmxlbmd0aDsgY29udGludWU7IH0KICAgICAgaWYgKChtID0gL15cKig_PVteXHMqXSkoW1xzXFNdKj9bXlxzKl0pXCooPyFcKikvLmV4ZWMocmVzdCkpKSB7IG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7IGkgK",
"z0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICghL1tccHtMfVxwe059X10vdS50ZXN0KHByZXYpICYmIChtID0gL15fKD89W15cc19dKShbXHNcU10qP1teXHNfXSlfKD8hW1xwe0x9XHB7Tn1fXSkvdS5leGVjKHJlc3QpKSkgewogICAgICAgIG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBidWYgKz0gc1tpXTsKICAgICAgaSsrOwogICAgfQogICAgZmx1c2goKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBPbmUgbGluZSBvZiBNYXJrZG93bjogd2hhdCBraW5kIG9mIGJsb2NrIGl0IGlzLCBpdHMgaW5kZW50IGFuZCB0ZXh0LgogIGZ1bmN0aW9uIG1kTGluZShsaW5lKSB7CiAgICBjb25zdCBbLCBwYWQsIHNdID0gL14oICopKC4qKSQvLmV4ZWMobGluZSk7CiAgICBjb25zdCBpbmRlbnQgPSBwYWQubGVuZ3RoOwogICAgbGV0IHg7CiAgICBpZiAoKHggPSAvXigjezEsNn0pXHMrKC4qPykoPzpccysjKyk_XHMqJC8uZXhlYyhzKSkpIHJldHVybiB7IHR5cGU6IFsnaDEnLCAnaDInLCAnaDMnXVtNYXRoLm1pbigyLCB4WzFdLmxlbmd0aCAtIDEpXSwgdGV4dDogeFsyXSB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzK1xbKFsgeFhdKVxdXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdICE9PSAnICcsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogI",
"CAgaWYgKCh4ID0gL14oW-KYkOKYkV0pXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdID09PSBUSUNLRUQsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzKyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3VsJywgdGV4dDogeFsxXSwgaW5kZW50IH07CiAgICBpZiAoKHggPSAvXlxkezEsM31bLildXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnb2wnLCB0ZXh0OiB4WzFdLCBpbmRlbnQgfTsKICAgIGlmICgoeCA9IC9ePlxzPyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3AnLCB0ZXh0OiB4WzFdLnJlcGxhY2UoL14oPlxzPykrLywgJycpIH07CiAgICBpZiAoL15cfC4qXHxccyokLy50ZXN0KHMpKSByZXR1cm4geyB0eXBlOiAncCcsIGNlbGxzOiBzLnRyaW0oKS5zbGljZSgxLCAtMSkuc3BsaXQoLyg_PCFcXClcfC8pLm1hcChjID0-IGMudHJpbSgpKSB9OwogICAgcmV0dXJuIHsgdHlwZTogJ3AnLCB0ZXh0OiBzIH07CiAgfQoKICBjb25zdCBNRF9SVUxFID0gL15ccyooWy0qX10pKFxzKlwxKXsyLH1ccyokLzsKICBjb25zdCBNRF9UQUJMRV9SVUxFID0gL15ccypcfD9ccyo6Py17Myx9Oj9ccyooXHxccyo6Py17Myx9Oj9ccyopK1x8P1xzKiQvOwoKICBmdW5jdGlvbiBmcm9tTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgbGluZXMgPSBTdHJpbmcodGV4dCB8fCAnJykucmVwbGFjZSgvX",
"HJcbj8vZywgJ1xuJykucmVwbGFjZSgvXHQvZywgJyAgICAnKS5zcGxpdCgnXG4nKTsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgaW5kZW50cyA9IFtdOyAgIC8vIHRoZSBpbmRlbnQgb2YgZWFjaCBvcGVuIGxpc3QgbGV2ZWwKICAgIGxldCBmZW5jZSA9IGZhbHNlOwogICAgY29uc3QgbGFzdCA9ICgpID0-IG91dFtvdXQubGVuZ3RoIC0gMV07CiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHsKICAgICAgaWYgKC9eXHMqKGBgYHx-fn4pLy50ZXN0KGxpbmUpKSB7IGZlbmNlID0gIWZlbmNlOyBjb250aW51ZTsgfQogICAgICBpZiAoZmVuY2UpIHsgb3V0LnB1c2goYmxvY2soJ3AnLCBbeyB0ZXh0OiBsaW5lIH1dKSk7IGNvbnRpbnVlOyB9CiAgICAgIC8vIFRoZSB8LS0tfC0tLXwgbGluZSB1bmRlciBhIHRhYmxlJ3MgaGVhZGluZyByb3cgbWFrZXMgdGhhdCByb3cgYm9sZC4KICAgICAgaWYgKE1EX1RBQkxFX1JVTEUudGVzdChsaW5lKSkgewogICAgICAgIGNvbnN0IGhlYWQgPSBsYXN0KCk7CiAgICAgICAgaWYgKGhlYWQgJiYgaGVhZC50YWJsZSkgZm9yIChjb25zdCByIG9mIGhlYWQucnVucykgaWYgKCFyLnNlcCkgci5iID0gdHJ1ZTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoTURfUlVMRS50ZXN0KGxpbmUpKSBjb250aW51ZTsKICAgICAgLy8gT25lIGVtcHR5IGxpbmUgaXMgYSBnYXA7IG1vcmUgYXJlIG5vdCwgYW5kIG5vciBpcyBvbmUgYmVzaWRlIGEKICAgICAgLy8gaGVhZ",
"GluZywgd2hpY2ggaGFzIHNwYWNlIG9mIGl0cyBvd24uCiAgICAgIGlmICghbGluZS50cmltKCkpIHsKICAgICAgICBpZiAoIW91dC5sZW5ndGggfHwgIShmbXRCbGFuayhsYXN0KCkpIHx8IEhFQURJTkdTW2xhc3QoKS50eXBlXSkpIG91dC5wdXNoKGJsb2NrKCdwJykpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IGwgPSBtZExpbmUobGluZS5yZXBsYWNlKC9ccyskLywgJycpKTsKICAgICAgaWYgKEhFQURJTkdTW2wudHlwZV0gJiYgb3V0Lmxlbmd0aCAmJiBmbXRCbGFuayhsYXN0KCkpKSBvdXQucG9wKCk7CiAgICAgIGlmIChMSVNUUy5oYXMobC50eXBlKSkgewogICAgICAgIC8vIEEgYmxhbmsgbGluZSBiZXR3ZWVuIHR3byBpdGVtcyBvZiBhIGxpc3QgaXMgbm90IGEgZ2FwIGluIGl0LgogICAgICAgIGlmIChvdXQubGVuZ3RoID4gMSAmJiBmbXRCbGFuayhsYXN0KCkpICYmIExJU1RTLmhhcyhvdXRbb3V0Lmxlbmd0aCAtIDJdLnR5cGUpKSBvdXQucG9wKCk7CiAgICAgICAgd2hpbGUgKGluZGVudHMubGVuZ3RoICYmIGwuaW5kZW50IDwgaW5kZW50c1tpbmRlbnRzLmxlbmd0aCAtIDFdKSBpbmRlbnRzLnBvcCgpOwogICAgICAgIGlmICghaW5kZW50cy5sZW5ndGggfHwgbC5pbmRlbnQgPiBpbmRlbnRzW2luZGVudHMubGVuZ3RoIC0gMV0pIGluZGVudHMucHVzaChsLmluZGVudCk7CiAgICAgICAgb3V0LnB1c2goYmxvY2sobC50eXBlLCBtZElubGluZShsLnRleHQpLCB7IGxldmVsOiBpbmRlb",
"nRzLmxlbmd0aCAtIDEsIGNoZWNrZWQ6IGwuY2hlY2tlZCB9KSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaW5kZW50cy5sZW5ndGggPSAwOwogICAgICBpZiAobC5jZWxscykgewogICAgICAgIGNvbnN0IHJ1bnMgPSBbXTsKICAgICAgICBsLmNlbGxzLmZvckVhY2goKGMsIGspID0-IHsKICAgICAgICAgIGlmIChrKSBydW5zLnB1c2goeyB0ZXh0OiAnIHwgJywgc2VwOiB0cnVlIH0pOwogICAgICAgICAgcnVucy5wdXNoKC4uLm1kSW5saW5lKGMucmVwbGFjZSgvXFxcfC9nLCAnfCcpKSk7CiAgICAgICAgfSk7CiAgICAgICAgY29uc3QgYiA9IGJsb2NrKCdwJywgcnVucyk7CiAgICAgICAgYi50YWJsZSA9IHRydWU7CiAgICAgICAgb3V0LnB1c2goYik7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgb3V0LnB1c2goYmxvY2sobC50eXBlLCBtZElubGluZShsLnRleHQudHJpbSgpKSkpOwogICAgfQogICAgd2hpbGUgKG91dC5sZW5ndGggPiAxICYmIGZtdEJsYW5rKGxhc3QoKSkpIG91dC5wb3AoKTsKICAgIHdoaWxlIChvdXQubGVuZ3RoID4gMSAmJiBmbXRCbGFuayhvdXRbMF0pKSBvdXQuc2hpZnQoKTsKICAgIHJldHVybiBub3JtYWxpc2VEb2Mob3V0KTsKICB9CgogIGNvbnN0IGZtdEJsYW5rID0gYiA9PiBiLnR5cGUgPT09ICdwJyAmJiAhYi5ydW5zLnNvbWUociA9PiByLnRleHQudHJpbSgpKTsKCiAgLy8gV2hldGhlciBwbGFpbiB0ZXh0IGlzIHdvcnRoIHJlYWRpbmcgYXMgTWFya2Rvd",
"246IGEgaGVhZGluZywgbGlzdCwKICAvLyBxdW90ZSwgdGFibGUgb3IgY29kZSBsaW5lLCBvciBib2xkLCBzdHJ1Y2ssIGxpbmtlZCBvciBjb2RlIHRleHQuCiAgZnVuY3Rpb24gbG9va3NMaWtlTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIHJldHVybiAvXiB7MCwzfSgjezEsNn1ccytcU3xbLSor4oCiXVxzK1xTfFvimJDimJFdXHMrXFN8XGR7MSwzfVsuKV1ccytcU3w-XHN8YGBgKS9tLnRlc3QocykgfHwKICAgICAgL15ccypcfD9ccyo6Py17Myx9Oj9ccyooXHxccyo6Py17Myx9Oj9ccyopK1x8P1xzKiQvbS50ZXN0KHMpIHx8CiAgICAgIC9cKlwqW14qXG5dK1wqXCp8X19bXl9cbl0rX198fn5bXn5cbl0rfn58XFtbXlxdXG5dK1xdXChbXilcc10rXCl8YFteYFxuXStgLy50ZXN0KHMpOwogIH0KCiAgLy8g4pSA4pSAIFBhc3Rpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFdoZXRoZXIgYSBkb2N1bWVudCBoYXMgYW55dGhpbmcgcGxhaW4gdGV4dCB3b3VsZCBub3Q6IGEgaGVhZGluZywgYQogIC8vIGxpc3QsIGEgbWFyayBvciBhIGxpbmsuCiAgZnVuY3Rpb24gaGFzRm9ybWF0dGluZyhkb",
"2MpIHsKICAgIHJldHVybiBkb2Muc29tZShiID0-IGIudHlwZSAhPT0gJ3AnIHx8IGIucnVucy5zb21lKHIgPT4gci5iIHx8IHIuaSB8fCByLnMgfHwgci5ocmVmKSk7CiAgfQoKICAvLyBXaGF0IGEgcGFzdGUgYmVjb21lczogdGhlIGNsaXBib2FyZCdzIEhUTUwsIHJlYWQgbGlrZSBtYWlsOyBvciwgd2hlbgogIC8vIHRoYXQgYnJpbmdzIG5vIGZvcm1hdHRpbmcgYW5kIHRoZSB0ZXh0IGlzIE1hcmtkb3duIChmcm9tIGEgY2hhdAogIC8vIGFzc2lzdGFudCwgc2F5KSwgdGhlIE1hcmtkb3duIHJlYWQgYXMgZm9ybWF0dGluZy4gRW1wdHkgbGluZXMgYXQKICAvLyBlaXRoZXIgZW5kIGdvLiBudWxsIG1lYW5zIHRoZXJlIGlzIG5vdGhpbmcgdG8gZm9ybWF0OiB0aGUgdGV4dCBpcwogIC8vIHBhc3RlZCBhcyBpdCBpcy4KICBmdW5jdGlvbiBwYXN0ZURvYyh7IGh0bWwsIHRleHQgfSA9IHt9KSB7CiAgICBsZXQgZG9jID0gaHRtbCAmJiAvXFMvLnRlc3QoaHRtbCkgPyBwYXJzZUh0bWwoaHRtbCkgOiBudWxsOwogICAgaWYgKGRvYyAmJiBpc0VtcHR5KGRvYykpIGRvYyA9IG51bGw7CiAgICBpZiAoKCFkb2MgfHwgIWhhc0Zvcm1hdHRpbmcoZG9jKSkgJiYgbG9va3NMaWtlTWFya2Rvd24odGV4dCkpIGRvYyA9IGZyb21NYXJrZG93bih0ZXh0KTsKICAgIGlmICghZG9jKSByZXR1cm4gbnVsbDsKICAgIGxldCBpID0gMDsKICAgIGxldCBqID0gZG9jLmxlbmd0aDsKICAgIHdoaWxlIChpIDwgaiAmJiBmbXRCbGFuayhkb2NbaV0pK",
"SBpKys7CiAgICB3aGlsZSAoaiA-IGkgJiYgZm10QmxhbmsoZG9jW2ogLSAxXSkpIGotLTsKICAgIHJldHVybiBpIDwgaiA_IGRvYy5zbGljZShpLCBqKSA6IG51bGw7CiAgfQoKICAvLyBUaGUgbm90ZSdzIGNvbnRlbnQgZnJvbSBpdHMgbWVzc2FnZSBwYXJ0czogSFRNTCB3aGVuIHRoZXJlIGlzIGFueSwKICAvLyB0aGUgcGxhaW4gdGV4dCBvdGhlcndpc2UuCiAgZnVuY3Rpb24gZG9jRnJvbVBhcnRzKHsgcGxhaW4sIGh0bWwgfSA9IHt9KSB7CiAgICBpZiAoaHRtbCAmJiBTdHJpbmcoaHRtbCkudHJpbSgpKSByZXR1cm4gcGFyc2VIdG1sKGh0bWwpOwogICAgcmV0dXJuIGZyb21QbGFpbihwbGFpbiB8fCAnJyk7CiAgfQoKICAvLyDilIDilIAgTWVyZ2luZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIEEgbm90ZSBlZGl0ZWQgaGVyZSB3aGlsZSBhbm90aGVyIGNvbXB1dGVyIG9yIHBob25lIHNhdmVkIGEgbmV3ZXIKICAvLyB2ZXJzaW9uIG9mIGl0OiBib3RoIHNldHMgb2YgY2hhbmdlcywgYmxvY2sgYnkgYmxvY2suIGBiYXNlYCBpcyB0aGUKICAvLyB2ZXJzaW9uIHRoZSBlZGl0cyBoZXJlIHN0YXJ0ZWQgZnJvbSwgYG1pbmVgIHRoZSB0Z",
"Xh0IGhlcmUgbm93LCBhbmQKICAvLyBgdGhlaXJzYCB0aGUgbmV3ZXIgdmVyc2lvbi4gQSBzdHJldGNoIG9ubHkgb25lIHNpZGUgY2hhbmdlZCB0YWtlcwogIC8vIHRoYXQgc2lkZSdzIGJsb2NrczsgYSBzdHJldGNoIGJvdGggY2hhbmdlZCBrZWVwcyB0aGVpcnMgYW5kIHRoZW4KICAvLyB3aGF0ZXZlciBvZiBtaW5lIHRoZXkgZG8gbm90IGFscmVhZHkgaGF2ZSwgc28gbm90aGluZyB0eXBlZCBvbgogIC8vIGVpdGhlciBpcyBsb3N0IC0gYXQgd29yc3QgYSBwYXJhZ3JhcGggYXBwZWFycyB0d2ljZS4KCiAgY29uc3QgYmxvY2tLZXkgPSBiID0-IEpTT04uc3RyaW5naWZ5KGIpOwogIGNvbnN0IHNhbWVEb2MgPSAoYSwgYikgPT4gSlNPTi5zdHJpbmdpZnkobm9ybWFsaXNlRG9jKGEpKSA9PT0gSlNPTi5zdHJpbmdpZnkobm9ybWFsaXNlRG9jKGIpKTsKCiAgLy8gVGhlIGxvbmdlc3QgY29tbW9uIHN1YnNlcXVlbmNlIG9mIHR3byBsaXN0cyBvZiBrZXlzLCBhcyBwYWlycyBvZgogIC8vIGluZGljZXMgW2kgaW4gYSwgaiBpbiBiXSwgaW4gb3JkZXIuIFRoZSBlbmRzIGJvdGggbGlzdHMgc2hhcmUgYXJlCiAgLy8gbWF0Y2hlZCBmaXJzdCwgc28gdGhlIHRhYmxlIG9ubHkgc3BhbnMgdGhlIHN0cmV0Y2ggdGhhdCBkaWZmZXJzLgogIGZ1bmN0aW9uIGNvbW1vblBhaXJzKGEsIGIpIHsKICAgIGxldCBsbyA9IDA7CiAgICB3aGlsZSAobG8gPCBhLmxlbmd0aCAmJiBsbyA8IGIubGVuZ3RoICYmIGFbbG9dID09PSBiW2xvXSkgbG8rK",
"zsKICAgIGxldCBlYSA9IGEubGVuZ3RoOwogICAgbGV0IGViID0gYi5sZW5ndGg7CiAgICB3aGlsZSAoZWEgPiBsbyAmJiBlYiA-IGxvICYmIGFbZWEgLSAxXSA9PT0gYltlYiAtIDFdKSB7IGVhLS07IGViLS07IH0KICAgIGNvbnN0IHBhaXJzID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxvOyBpKyspIHBhaXJzLnB1c2goW2ksIGldKTsKICAgIGNvbnN0IG4gPSBlYSAtIGxvOwogICAgY29uc3QgbSA9IGViIC0gbG87CiAgICAvLyBUb28gYmlnIGEgdGFibGUgdG8gYmUgd29ydGggaXQ6IG5vIG1hdGNoZXMgaW4gdGhlIG1pZGRsZSwgd2hpY2gKICAgIC8vIG9ubHkgbWFrZXMgdGhlIG1lcmdlIGtlZXAgbW9yZSBvZiBib3RoIHNpZGVzLgogICAgaWYgKG4gJiYgbSAmJiBuICogbSA8PSA0ZTYpIHsKICAgICAgY29uc3QgbGVuID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogbiArIDEgfSwgKCkgPT4gbmV3IFVpbnQzMkFycmF5KG0gKyAxKSk7CiAgICAgIGZvciAobGV0IGkgPSBuIC0gMTsgaSA-PSAwOyBpLS0pIHsKICAgICAgICBmb3IgKGxldCBqID0gbSAtIDE7IGogPj0gMDsgai0tKSB7CiAgICAgICAgICBsZW5baV1bal0gPSBhW2xvICsgaV0gPT09IGJbbG8gKyBqXSA_IGxlbltpICsgMV1baiArIDFdICsgMSA6IE1hdGgubWF4KGxlbltpICsgMV1bal0sIGxlbltpXVtqICsgMV0pOwogICAgICAgIH0KICAgICAgfQogICAgICBsZXQgaSA9IDA7CiAgICAgIGxldCBqID0gMDsKICAgICAgd2hpbGUgKGkgPCBuICYmI",
"GogPCBtKSB7CiAgICAgICAgaWYgKGFbbG8gKyBpXSA9PT0gYltsbyArIGpdKSB7IHBhaXJzLnB1c2goW2xvICsgaSwgbG8gKyBqXSk7IGkrKzsgaisrOyB9IGVsc2UgaWYgKGxlbltpICsgMV1bal0gPj0gbGVuW2ldW2ogKyAxXSkgaSsrOyBlbHNlIGorKzsKICAgICAgfQogICAgfQogICAgZm9yIChsZXQgayA9IDA7IGsgPCBhLmxlbmd0aCAtIGVhOyBrKyspIHBhaXJzLnB1c2goW2VhICsgaywgZWIgKyBrXSk7CiAgICByZXR1cm4gcGFpcnM7CiAgfQoKICAvLyB7IGRvYywgbWFwLCBjbGVhbiB9OiB0aGUgbWVyZ2VkIGJsb2NrczsgZm9yIGVhY2ggb2YgbWluZSdzIGJsb2NrcywKICAvLyB3aGVyZSBpdCBpcyBpbiB0aGVtIChzbyBhIGN1cnNvciBjYW4gc3RheSBwdXQpOyBhbmQgd2hldGhlciBubwogIC8vIHN0cmV0Y2ggd2FzIGNoYW5nZWQgb24gYm90aCBzaWRlcy4KICBmdW5jdGlvbiBtZXJnZURvY3MoYmFzZUluLCBtaW5lSW4sIHRoZWlyc0luKSB7CiAgICBjb25zdCBiYXNlID0gbm9ybWFsaXNlRG9jKGJhc2VJbik7CiAgICBjb25zdCBtaW5lID0gbm9ybWFsaXNlRG9jKG1pbmVJbik7CiAgICBjb25zdCB0aGVpcnMgPSBub3JtYWxpc2VEb2ModGhlaXJzSW4pOwogICAgY29uc3Qga2IgPSBiYXNlLm1hcChibG9ja0tleSk7CiAgICBjb25zdCBrbSA9IG1pbmUubWFwKGJsb2NrS2V5KTsKICAgIGNvbnN0IGt0ID0gdGhlaXJzLm1hcChibG9ja0tleSk7CiAgICBjb25zdCB0b01pbmUgPSBuZXcgTWFwKGNvbW1vblBha",
"XJzKGtiLCBrbSkpOwogICAgY29uc3QgdG9UaGVpcnMgPSBuZXcgTWFwKGNvbW1vblBhaXJzKGtiLCBrdCkpOwogICAgLy8gVGhlIGJsb2NrcyBuZWl0aGVyIHNpZGUgdG91Y2hlZCwgaW4gb3JkZXIgb24gYWxsIHRocmVlLgogICAgY29uc3QgYW5jaG9ycyA9IFtdOwogICAgbGV0IGxhc3RNID0gLTE7CiAgICBsZXQgbGFzdFQgPSAtMTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwga2IubGVuZ3RoOyBpKyspIHsKICAgICAgaWYgKCF0b01pbmUuaGFzKGkpIHx8ICF0b1RoZWlycy5oYXMoaSkpIGNvbnRpbnVlOwogICAgICBjb25zdCBtID0gdG9NaW5lLmdldChpKTsKICAgICAgY29uc3QgdCA9IHRvVGhlaXJzLmdldChpKTsKICAgICAgaWYgKG0gPiBsYXN0TSAmJiB0ID4gbGFzdFQpIHsgYW5jaG9ycy5wdXNoKGkpOyBsYXN0TSA9IG07IGxhc3RUID0gdDsgfQogICAgfQogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBtYXAgPSBuZXcgQXJyYXkobWluZS5sZW5ndGgpLmZpbGwoLTEpOwogICAgbGV0IGNsZWFuID0gdHJ1ZTsKICAgIGNvbnN0IHNhbWUgPSAoeCwgeSkgPT4geC5sZW5ndGggPT09IHkubGVuZ3RoICYmIHguZXZlcnkoKHYsIGspID0-IHYgPT09IHlba10pOwogICAgbGV0IGIwID0gMDsKICAgIGxldCBtMCA9IDA7CiAgICBsZXQgdDAgPSAwOwogICAgZm9yIChjb25zdCBhIG9mIGFuY2hvcnMuY29uY2F0KFtrYi5sZW5ndGhdKSkgewogICAgICBjb25zdCBtMSA9IGEgPCBrYi5sZW5ndGggPyB0b01pbmUuZ",
"2V0KGEpIDoga20ubGVuZ3RoOwogICAgICBjb25zdCB0MSA9IGEgPCBrYi5sZW5ndGggPyB0b1RoZWlycy5nZXQoYSkgOiBrdC5sZW5ndGg7CiAgICAgIGNvbnN0IEIgPSBrYi5zbGljZShiMCwgYSk7CiAgICAgIGNvbnN0IE0gPSBrbS5zbGljZShtMCwgbTEpOwogICAgICBjb25zdCBUID0ga3Quc2xpY2UodDAsIHQxKTsKICAgICAgY29uc3Qgc3RhcnQgPSBvdXQubGVuZ3RoOwogICAgICBpZiAoc2FtZShNLCBCKSAmJiAhc2FtZShULCBCKSkgewogICAgICAgIC8vIE9ubHkgdGhleSBjaGFuZ2VkIHRoaXMgc3RyZXRjaC4KICAgICAgICBmb3IgKGxldCBrID0gdDA7IGsgPCB0MTsgaysrKSBvdXQucHVzaCh0aGVpcnNba10pOwogICAgICAgIGZvciAobGV0IGsgPSBtMDsgayA8IG0xOyBrKyspIG1hcFtrXSA9IE1hdGgubWluKHN0YXJ0ICsgKGsgLSBtMCksIE1hdGgubWF4KHN0YXJ0LCBvdXQubGVuZ3RoIC0gMSkpOwogICAgICB9IGVsc2UgaWYgKHNhbWUoVCwgQikgfHwgc2FtZShNLCBUKSkgewogICAgICAgIC8vIE9ubHkgdGhpcyBzaWRlIGNoYW5nZWQgaXQsIG9yIGJvdGggdGhlIHNhbWUgd2F5LgogICAgICAgIGZvciAobGV0IGsgPSBtMDsgayA8IG0xOyBrKyspIHsgbWFwW2tdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVtrXSk7IH0KICAgICAgfSBlbHNlIGlmIChCLmxlbmd0aCAmJiAoc2FtZShULnNsaWNlKDAsIEIubGVuZ3RoKSwgQikgfHwgc2FtZShULnNsaWNlKFQubGVuZ3RoIC0gQi5sZW5ndGgpLCBCK",
"SkpIHsKICAgICAgICAvLyBUaGV5IG9ubHkgYWRkZWQgYmVmb3JlIG9yIGFmdGVyIGl0LCBhbmQgdGhpcyBzaWRlIGNoYW5nZWQgaXQuCiAgICAgICAgY29uc3QgYWZ0ZXIgPSBzYW1lKFQuc2xpY2UoMCwgQi5sZW5ndGgpLCBCKTsKICAgICAgICBpZiAoIWFmdGVyKSBmb3IgKGxldCBrID0gdDA7IGsgPCB0MSAtIEIubGVuZ3RoOyBrKyspIG91dC5wdXNoKHRoZWlyc1trXSk7CiAgICAgICAgZm9yIChsZXQgayA9IG0wOyBrIDwgbTE7IGsrKykgeyBtYXBba10gPSBvdXQubGVuZ3RoOyBvdXQucHVzaChtaW5lW2tdKTsgfQogICAgICAgIGlmIChhZnRlcikgZm9yIChsZXQgayA9IHQwICsgQi5sZW5ndGg7IGsgPCB0MTsgaysrKSBvdXQucHVzaCh0aGVpcnNba10pOwogICAgICB9IGVsc2UgaWYgKEIubGVuZ3RoICYmIChzYW1lKE0uc2xpY2UoMCwgQi5sZW5ndGgpLCBCKSB8fCBzYW1lKE0uc2xpY2UoTS5sZW5ndGggLSBCLmxlbmd0aCksIEIpKSkgewogICAgICAgIC8vIFRoaXMgc2lkZSBvbmx5IGFkZGVkIGJlZm9yZSBvciBhZnRlciBpdCwgYW5kIHRoZXkgY2hhbmdlZCBpdC4KICAgICAgICBjb25zdCBhZnRlciA9IHNhbWUoTS5zbGljZSgwLCBCLmxlbmd0aCksIEIpOwogICAgICAgIGlmICghYWZ0ZXIpIGZvciAobGV0IGsgPSBtMDsgayA8IG0xIC0gQi5sZW5ndGg7IGsrKykgeyBtYXBba10gPSBvdXQubGVuZ3RoOyBvdXQucHVzaChtaW5lW2tdKTsgfQogICAgICAgIGNvbnN0IHRoZWlyc0F0ID0gb3V0Lmxlbmd0aDsKI",
"CAgICAgICBmb3IgKGxldCBrID0gdDA7IGsgPCB0MTsgaysrKSBvdXQucHVzaCh0aGVpcnNba10pOwogICAgICAgIGNvbnN0IGtlcHQgPSBhZnRlciA_IFttMCwgbTAgKyBCLmxlbmd0aF0gOiBbbTEgLSBCLmxlbmd0aCwgbTFdOwogICAgICAgIGZvciAobGV0IGsgPSBrZXB0WzBdOyBrIDwga2VwdFsxXTsgaysrKSBtYXBba10gPSBNYXRoLm1pbih0aGVpcnNBdCArIChrIC0ga2VwdFswXSksIE1hdGgubWF4KHRoZWlyc0F0LCBvdXQubGVuZ3RoIC0gMSkpOwogICAgICAgIGlmIChhZnRlcikgZm9yIChsZXQgayA9IG0wICsgQi5sZW5ndGg7IGsgPCBtMTsgaysrKSB7IG1hcFtrXSA9IG91dC5sZW5ndGg7IG91dC5wdXNoKG1pbmVba10pOyB9CiAgICAgIH0gZWxzZSB7CiAgICAgICAgLy8gQm90aCBjaGFuZ2VkIGl0OiB0aGVpcnMsIHRoZW4gd2hhdCBvZiBtaW5lIGlzIG5ldyB0byBpdC4KICAgICAgICBjbGVhbiA9IGZhbHNlOwogICAgICAgIGZvciAobGV0IGsgPSB0MDsgayA8IHQxOyBrKyspIG91dC5wdXNoKHRoZWlyc1trXSk7CiAgICAgICAgZm9yIChsZXQgayA9IG0wOyBrIDwgbTE7IGsrKykgewogICAgICAgICAgY29uc3QgdGhlcmUgPSBULmluZGV4T2Yoa21ba10pOwogICAgICAgICAgaWYgKHRoZXJlID49IDApIG1hcFtrXSA9IHN0YXJ0ICsgdGhlcmU7CiAgICAgICAgICBlbHNlIHsgbWFwW2tdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVtrXSk7IH0KICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKGEgP",
"CBrYi5sZW5ndGgpIHsgbWFwW20xXSA9IG91dC5sZW5ndGg7IG91dC5wdXNoKG1pbmVbbTFdKTsgfQogICAgICBiMCA9IGEgKyAxOwogICAgICBtMCA9IG0xICsgMTsKICAgICAgdDAgPSB0MSArIDE7CiAgICB9CiAgICBpZiAoIW91dC5sZW5ndGgpIG91dC5wdXNoKGJsb2NrKCdwJykpOwogICAgZm9yIChsZXQgayA9IDA7IGsgPCBtYXAubGVuZ3RoOyBrKyspIG1hcFtrXSA9IE1hdGgubWF4KDAsIE1hdGgubWluKG91dC5sZW5ndGggLSAxLCBtYXBba10pKTsKICAgIHJldHVybiB7IGRvYzogb3V0LCBtYXAsIGNsZWFuIH07CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBUWVBFUywgTElTVFMsIE1BWF9MRVZFTCwKICAgIGJsb2NrLCBlbXB0eURvYywgbm9ybWFsaXNlUnVucywgbm9ybWFsaXNlRG9jLCBkb2NUZXh0LCBpc0VtcHR5LCBzYWZlSHJlZiwKICAgIHRvSHRtbCwgdG9QbGFpbiwgZnJvbVBsYWluLCBwYXJzZUh0bWwsIGRvY0Zyb21QYXJ0cywgZnJvbU1hcmtkb3duLCBsb29rc0xpa2VNYXJrZG93biwgaGFzRm9ybWF0dGluZywgcGFzdGVEb2MsCiAgICBtZXJnZURvY3MsIHNhbWVEb2MsCiAgfTsKCiAgbnMubm90ZUZvcm1hdCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/search-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNlYXJjaCBoaWdobGlnaHRpbmcgKHB1cmUpCi8vCi8vIEdtYWlsIGRvZXMgdGhlIHNlYXJjaGluZzsgdGhpcyBvbmx5IHNob3dzIHdoZXJlIHRoZSB3b3JkcyBhcmUuIEl0IHRha2VzCi8vIHRoZSB3b3JkcyBvdXQgb2YgYSBHbWFpbCBxdWVyeSAtIGxlYXZpbmcgb3V0IG9wZXJhdG9ycyBzdWNoIGFzIGZyb206IG9yCi8vIGJlZm9yZTosIGFuZCBhbnl0aGluZyBleGNsdWRlZCB3aXRoIGEgbWludXMgLSBhbmQgZmluZHMgdGhlbSBpbiBhCi8vIG5vdGUncyB0ZXh0IHRoZSB3YXkgYSBwZXJzb24gd291bGQgcmVhZCBhIG1hdGNoOiBpZ25vcmluZyBjYXNlIGFuZAovLyBhY2NlbnRzICgiY2FmZSIgZmluZHMgIkNhZsOpIiksIGF0IHRoZSBzdGFydCBvZiBhIHdvcmQgKCJnbG9zcyIgZmluZHMKLy8gImdsb3NzYXJ5Iiwgbm90ICJ4Z2xvc3MiKSwgYW5kIHBocmFzZXMgaW4gcXVvdGVzIGFzIHBocmFzZXMuCi8vCi8vIEZyb20gdGhvc2UgbWF0Y2hlcyBjb21lIHRoZSBleGNlcnB0cyBzaG93biBpbiB0aGUgcmVzdWx0cyBsaXN0LCB3aXRoCi8vIHRoZWlyIG9mZnNldHMsIHNvIHRoZSBsaXN0IGNhbiBtYXJrIHRoZW0gd2l0aG91dCBwYXJzaW5",
"nIGFueSBIVE1MLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8gT3BlcmF0b3JzIHdob3NlIHZhbHVlIGlzIGEgd29yZCB0byBsb29rIGZvciBpbiB0aGUgbm90ZSBpdHNlbGYuCiAgY29uc3QgVEVYVF9PUFMgPSBuZXcgU2V0KFsnc3ViamVjdCcsICdpbnRpdGxlJ10pOwogIGNvbnN0IEtFWVdPUkRTID0gbmV3IFNldChbJ29yJywgJ2FuZCcsICdhcm91bmQnXSk7CgogIC8vIOKUgOKUgCBUaGUgd29yZHMgaW4gYSBxdWVyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmV0dXJucyBbeyB3b3JkczogWydzdGVudCcsICdjb2F0aW5nJ10gfSwg4oCmXTogb25lIGVudHJ5IHBlciB0ZXJtLCBhCiAgLy8gcGhyYXNlIGJlaW5nIHN",
"ldmVyYWwgd29yZHMgaW4gYSByb3cuCiAgZnVuY3Rpb24gcXVlcnlUZXJtcyhxdWVyeSkgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3QgYWRkID0gdGV4dCA9PiB7CiAgICAgIGNvbnN0IHdvcmRzID0gU3RyaW5nKHRleHQpLnNwbGl0KC9bXHMiKClbXF17fTw-XSsvKS5tYXAodyA9PiB3LnJlcGxhY2UoL15bXlxwe0x9XHB7Tn1dK3xbXlxwe0x9XHB7Tn1dKyQvZ3UsICcnKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgICBpZiAoIXdvcmRzLmxlbmd0aCkgcmV0dXJuOwogICAgICBpZiAod29yZHMubGVuZ3RoID09PSAxICYmIHdvcmRzWzBdLmxlbmd0aCA8IDIgJiYgL15bXHB7TH1ccHtOfV0kL3UudGVzdCh3b3Jkc1swXSkgJiYgL1thLXowLTldL2kudGVzdCh3b3Jkc1swXSkpIHJldHVybjsKICAgICAgY29uc3Qga2V5ID0gd29yZHMuam9pbignICcpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm47CiAgICAgIHNlZW4uYWRkKGtleSk7CiAgICAgIG91dC5wdXNoKHsgd29yZHMgfSk7CiAgICB9OwogICAgY29uc3QgdG9rZW5zID0gU3RyaW5nKHF1ZXJ5IHx8ICcnKS5tYXRjaCgvLT9bXHB7TH1ccHtOfV9dKzpcKFteKV0qXCl8LT9bXHB7TH1ccHtOfV9dKzoiW14iXSoifC0_IlteIl0qInxcUysvZ3UpIHx8IFtdOwogICAgZm9yIChjb25zdCByYXcgb2YgdG9rZW5zKSB7CiAgICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnLScpKSBjb25",
"0aW51ZTsgLy8gZXhjbHVkZWQ6IG5vdCBpbiB0aGUgbm90ZQogICAgICBjb25zdCBvcCA9IC9eKFtccHtMfVxwe059X10rKTooLiopJC91LmV4ZWMocmF3KTsKICAgICAgaWYgKG9wKSB7CiAgICAgICAgaWYgKFRFWFRfT1BTLmhhcyhvcFsxXS50b0xvd2VyQ2FzZSgpKSkgewogICAgICAgICAgY29uc3QgdiA9IG9wWzJdLnJlcGxhY2UoL15bKCJdfFspIl0kL2csICcnKTsKICAgICAgICAgIGlmICgvXlwoLy50ZXN0KG9wWzJdKSkgdi5zcGxpdCgvXHMrLykuZm9yRWFjaChhZGQpOwogICAgICAgICAgZWxzZSBhZGQodik7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnIicpKSB7IGFkZChyYXcucmVwbGFjZSgvIi9nLCAnJykpOyBjb250aW51ZTsgfQogICAgICBjb25zdCB3b3JkID0gcmF3LnJlcGxhY2UoL15bKygpe31dK3xbKCl7fV0rJC9nLCAnJyk7CiAgICAgIGlmIChLRVlXT1JEUy5oYXMod29yZC50b0xvd2VyQ2FzZSgpKSkgY29udGludWU7CiAgICAgIGFkZCh3b3JkKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgRmluZGluZyB0aGVtIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICA",
"vLyBMb3dlciBjYXNlLCBhY2NlbnRzIG9mZiAtIG9uZSBjaGFyYWN0ZXIgYXQgYSB0aW1lLCB3aXRoIGEgbWFwIGJhY2sgdG8KICAvLyB3aGVyZSBlYWNoIGZvbGRlZCBjaGFyYWN0ZXIgY2FtZSBmcm9tLCBzbyBhIG1hdGNoIGluIHRoZSBmb2xkZWQgdGV4dAogIC8vIGlzIGEgbWF0Y2ggYXQga25vd24gb2Zmc2V0cyBpbiB0aGUgcmVhbCBvbmUuCiAgZnVuY3Rpb24gZm9sZCh0ZXh0KSB7CiAgICBsZXQgZm9sZGVkID0gJyc7CiAgICBjb25zdCBtYXAgPSBbXTsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHMubGVuZ3RoOykgewogICAgICBjb25zdCBjcCA9IHMuY29kZVBvaW50QXQoaSk7CiAgICAgIGNvbnN0IGNoID0gU3RyaW5nLmZyb21Db2RlUG9pbnQoY3ApOwogICAgICBjb25zdCBmID0gY2gubm9ybWFsaXplKCdORkQnKS5yZXBsYWNlKC9ccHtNfSsvZ3UsICcnKS50b0xvd2VyQ2FzZSgpOwogICAgICBmb3IgKGxldCBrID0gMDsgayA8IGYubGVuZ3RoOyBrKyspIG1hcC5wdXNoKGkpOwogICAgICBmb2xkZWQgKz0gZjsKICAgICAgaSArPSBjaC5sZW5ndGg7CiAgICB9CiAgICBtYXAucHVzaChzLmxlbmd0aCk7CiAgICByZXR1cm4geyBmb2xkZWQsIG1hcCB9OwogIH0KCiAgY29uc3QgZXNjYXBlUmUgPSBzID0-IHMucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xdXFxdL2csICdcXCQmJyk7CgogIC8vIEV2ZXJ5IHBsYWNlIHRoZSB0ZXJtcyBvY2N1ciwgYXMgW3N",
"0YXJ0LCBlbmQpIG9mZnNldHMgaW50byBgdGV4dGAsCiAgLy8gaW4gb3JkZXIsIHdpdGggb3ZlcmxhcHMgbWVyZ2VkLgogIGZ1bmN0aW9uIGZpbmRNYXRjaGVzKHRleHQsIHRlcm1zKSB7CiAgICBpZiAoIXRlcm1zIHx8ICF0ZXJtcy5sZW5ndGggfHwgIXRleHQpIHJldHVybiBbXTsKICAgIGNvbnN0IHsgZm9sZGVkLCBtYXAgfSA9IGZvbGQodGV4dCk7CiAgICBjb25zdCBmb3VuZCA9IFtdOwogICAgZm9yIChjb25zdCB0IG9mIHRlcm1zKSB7CiAgICAgIGNvbnN0IHBhdHRlcm4gPSB0LndvcmRzLm1hcCh3ID0-IGVzY2FwZVJlKGZvbGQodykuZm9sZGVkKSkuam9pbignW1xcc1xcdTAwYTBdKycpOwogICAgICBpZiAoIXBhdHRlcm4pIGNvbnRpbnVlOwogICAgICBjb25zdCByZSA9IG5ldyBSZWdFeHAoYCg_PCFbXFxwe0x9XFxwe059XSkke3BhdHRlcm59YCwgJ2d1Jyk7CiAgICAgIGxldCBtOwogICAgICB3aGlsZSAoKG0gPSByZS5leGVjKGZvbGRlZCkpKSB7CiAgICAgICAgZm91bmQucHVzaChbbWFwW20uaW5kZXhdLCBtYXBbbS5pbmRleCArIG1bMF0ubGVuZ3RoXV0pOwogICAgICAgIGlmIChtWzBdLmxlbmd0aCA9PT0gMCkgcmUubGFzdEluZGV4Kys7CiAgICAgIH0KICAgIH0KICAgIGZvdW5kLnNvcnQoKGEsIGIpID0-IGFbMF0gLSBiWzBdIHx8IGFbMV0gLSBiWzFdKTsKICAgIGNvbnN0IG1lcmdlZCA9IFtdOwogICAgZm9yIChjb25zdCBbcywgZV0gb2YgZm91bmQpIHsKICAgICAgY29uc3QgbGFzdCA9IG1lcmdlZFt",
"tZXJnZWQubGVuZ3RoIC0gMV07CiAgICAgIGlmIChsYXN0ICYmIHMgPD0gbGFzdC5lbmQpIGxhc3QuZW5kID0gTWF0aC5tYXgobGFzdC5lbmQsIGUpOwogICAgICBlbHNlIG1lcmdlZC5wdXNoKHsgc3RhcnQ6IHMsIGVuZDogZSB9KTsKICAgIH0KICAgIHJldHVybiBtZXJnZWQ7CiAgfQoKICAvLyDilIDilIAgRXhjZXJwdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFVwIHRvIGBtYXhgIHN0cmV0Y2hlcyBvZiB0ZXh0IGFyb3VuZCB0aGUgbWF0Y2hlcywgZWFjaCB3aXRoIHRoZQogIC8vIG1hdGNoZXMgaW5zaWRlIGl0IGF0IG9mZnNldHMgcmVsYXRpdmUgdG8gdGhlIHN0cmV0Y2guIFN0cmV0Y2hlcyBzdGFydAogIC8vIGFuZCBlbmQgb24gYSBzcGFjZSB3aGVyZSBvbmUgaXMgbmVhciwgYW5kIHNheSB3aGV0aGVyIHRleHQgd2FzIGN1dC4KICBmdW5jdGlvbiBleGNlcnB0cyh0ZXh0LCBtYXRjaGVzLCB7IGNvbnRleHQgPSA1MCwgbWF4ID0gMyB9ID0ge30pIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBpID0gMDsKICAgIHdoaWxlIChpIDwgbWF0Y2hlcy5sZW5ndGggJiYgb3V0Lmx",
"lbmd0aCA8IG1heCkgewogICAgICBsZXQgc3RhcnQgPSBNYXRoLm1heCgwLCBtYXRjaGVzW2ldLnN0YXJ0IC0gY29udGV4dCk7CiAgICAgIGxldCBlbmQgPSBNYXRoLm1pbihzLmxlbmd0aCwgbWF0Y2hlc1tpXS5lbmQgKyBjb250ZXh0KTsKICAgICAgLy8gTWF0Y2hlcyBjbG9zZSBlbm91Z2ggc2hhcmUgYW4gZXhjZXJwdC4KICAgICAgbGV0IGogPSBpICsgMTsKICAgICAgd2hpbGUgKGogPCBtYXRjaGVzLmxlbmd0aCAmJiBtYXRjaGVzW2pdLnN0YXJ0IDwgZW5kKSB7CiAgICAgICAgZW5kID0gTWF0aC5taW4ocy5sZW5ndGgsIE1hdGgubWF4KGVuZCwgbWF0Y2hlc1tqXS5lbmQgKyBNYXRoLmZsb29yKGNvbnRleHQgLyAyKSkpOwogICAgICAgIGorKzsKICAgICAgfQogICAgICBpZiAoc3RhcnQgPiAwKSB7CiAgICAgICAgY29uc3Qgc3AgPSBzLnNsaWNlKHN0YXJ0LCBtYXRjaGVzW2ldLnN0YXJ0KS5zZWFyY2goL1xzLyk7CiAgICAgICAgaWYgKHNwID49IDApIHN0YXJ0ICs9IHNwICsgMTsKICAgICAgfQogICAgICBpZiAoZW5kIDwgcy5sZW5ndGgpIHsKICAgICAgICBjb25zdCB0YWlsID0gcy5zbGljZShtYXRjaGVzW2ogLSAxXS5lbmQsIGVuZCk7CiAgICAgICAgY29uc3Qgc3AgPSB0YWlsLnNlYXJjaCgvXHNcUyokLyk7CiAgICAgICAgaWYgKHNwID4gMCkgZW5kID0gbWF0Y2hlc1tqIC0gMV0uZW5kICsgc3A7CiAgICAgIH0KICAgICAgb3V0LnB1c2goewogICAgICAgIHRleHQ6IHMuc2xpY2Uoc3RhcnQsIGVuZCkucmV",
"wbGFjZSgvXHMvZywgJyAnKSwKICAgICAgICBtYXJrczogbWF0Y2hlcy5zbGljZShpLCBqKS5tYXAobSA9PiAoeyBzdGFydDogTWF0aC5tYXgobS5zdGFydCwgc3RhcnQpIC0gc3RhcnQsIGVuZDogTWF0aC5taW4obS5lbmQsIGVuZCkgLSBzdGFydCB9KSksCiAgICAgICAgY3V0QmVmb3JlOiBzdGFydCA-IDAsCiAgICAgICAgY3V0QWZ0ZXI6IGVuZCA8IHMubGVuZ3RoLAogICAgICB9KTsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgYXBpID0geyBxdWVyeVRlcm1zLCBmb2xkLCBmaW5kTWF0Y2hlcywgZXhjZXJwdHMgfTsKCiAgbnMuc2VhcmNoTG9naWMgPSBhcGk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKfSkoKTsK\"],[\"src/lib/board-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIEJvYXJkIGxvZ2ljIChwdXJlKQovLwovLyBUaGUgYm9hcmQgaGFzIG5vIGRhdGEgb2YgaXRzIG93bi4gQSBjYXJkIGlzIGEgR21haWwgdGhyZWFkLCBhIGNvb",
"HVtbiBpcwovLyBhIEdtYWlsIGxhYmVsLCBhbmQgdGhlIG9ubHkgdGhpbmdzIHN0b3JlZCBvdXRzaWRlIEdtYWlsIGFyZSB0aGUgb3JkZXIgb2YKLy8gY2FyZHMgd2l0aGluIGEgY29sdW1uIGFuZCB0aGUgdXNlcidzIG93biBlZGl0cyB0byBhIGNhcmQuIEV2ZXJ5dGhpbmcKLy8gaGVyZSBpcyB0aGUgYXJpdGhtZXRpYyBiZXR3ZWVuIHRob3NlOiB3aGljaCBsYWJlbHMgYSBtb3ZlIGFkZHMgYW5kCi8vIHJlbW92ZXMsIHdoZXJlIGEgdGhyZWFkIHNob3dzIHVwIHdoZW4gaXQgY2FycmllcyB0d28gY29sdW1uIGxhYmVscywgaG93Ci8vIGEgc2F2ZWQgb3JkZXIgbWVldHMgYSBmcmVzaCB0aHJlYWQgbGlzdCwgYW5kIHdoYXQgYW4gZWRpdCBsb29rcyBsaWtlLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB1dGlsID0gKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSA_IHJlcXVpcmUoJy4vdXRpb",
"C5qcycpIDogbnMudXRpbDsKCiAgLy8g4pSA4pSAIENvbHVtbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRoZSBsZWFkaW5nIHVuZGVyc2NvcmUgc29ydHMgdGhlIGJvYXJkJ3MgbGFiZWxzIGFib3ZlIGV2ZXJ5dGhpbmcgZWxzZQogIC8vIGluIEdtYWlsJ3MgbG9uZywgYWxwaGFiZXRpY2FsIGxhYmVsIGxpc3QgLSBvbiB0aGUgcGhvbmUgZXNwZWNpYWxseS4KICBjb25zdCBERUZBVUxUX1JPT1QgPSAnX0JvYXJkJzsKCiAgLy8gRG9uZSBhcmNoaXZlcyBvbiBkcm9wIGJlY2F1c2UgdGhhdCBpcyB3aGF0IGZpbmlzaGluZyBzb21ldGhpbmcgaW4KICAvLyBHbWFpbCB1c3VhbGx5IG1lYW5zOiBvdXQgb2YgdGhlIEluYm94LCBzdGlsbCBmaW5kYWJsZSB1bmRlciBpdHMgbGFiZWwuCiAgY29uc3QgREVGQVVMVF9DT0xVTU5TID0gWwogICAgeyBpZDogJ3RvZG8nLCB0aXRsZTogJ1RvIGRvJywgbGFiZWw6IGAke0RFRkFVTFRfUk9PVH0vVG8gZG9gLCBhcmNoaXZlT25Ecm9wOiBmYWxzZSB9LAogICAgeyBpZDogJ2RvaW5nJywgdGl0bGU6ICdEb2luZycsIGxhYmVsOiBgJHtERUZBVUxUX1JPT1R9L0RvaW5nYCwgYXJjaGl2ZU9uRHJvcDogZmFsc2Ugf",
"SwKICAgIHsgaWQ6ICd3YWl0aW5nJywgdGl0bGU6ICdXYWl0aW5nJywgbGFiZWw6IGAke0RFRkFVTFRfUk9PVH0vV2FpdGluZ2AsIGFyY2hpdmVPbkRyb3A6IGZhbHNlIH0sCiAgICB7IGlkOiAnZG9uZScsIHRpdGxlOiAnRG9uZScsIGxhYmVsOiBgJHtERUZBVUxUX1JPT1R9L0RvbmVgLCBhcmNoaXZlT25Ecm9wOiB0cnVlIH0sCiAgXTsKCiAgZnVuY3Rpb24gZGVmYXVsdENvbHVtbnMoKSB7CiAgICByZXR1cm4gREVGQVVMVF9DT0xVTU5TLm1hcChjID0-ICh7IC4uLmMgfSkpOwogIH0KCiAgLy8gc3RvcmFnZS5zeW5jIGNhbiBob2xkIGFueXRoaW5nIGFuIG9sZGVyIHZlcnNpb24gLSBvciBhIGhhbmQgZWRpdCAtCiAgLy8gcHV0IHRoZXJlLiBBbnl0aGluZyB1bnVzYWJsZSBmYWxscyBiYWNrIHRvIHRoZSBkZWZhdWx0cyByYXRoZXIgdGhhbgogIC8vIGxlYXZpbmcgYW4gZW1wdHkgYm9hcmQgd2l0aCBubyBvYnZpb3VzIHdheSBiYWNrLgogIGZ1bmN0aW9uIG5vcm1hbGlzZUNvbHVtbnMocmF3KSB7CiAgICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkgcmV0dXJuIGRlZmF1bHRDb2x1bW5zKCk7CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGNvbnN0IGMgb2YgcmF3KSB7CiAgICAgIGlmICghYyB8fCB0eXBlb2YgYyAhPT0gJ29iamVjdCcpIGNvbnRpbnVlOwogICAgICBjb25zdCBpZCA9IFN0cmluZyhjLmlkIHx8ICcnKS50cmltKCk7CiAgICAgIGNvbnN0IGxhYmVsI",
"D0gU3RyaW5nKGMubGFiZWwgfHwgJycpLnRyaW0oKTsKICAgICAgaWYgKCFpZCB8fCAhbGFiZWwgfHwgc2Vlbi5oYXMoaWQpKSBjb250aW51ZTsKICAgICAgc2Vlbi5hZGQoaWQpOwogICAgICBjb25zdCBjb2wgPSB7CiAgICAgICAgaWQsCiAgICAgICAgdGl0bGU6IFN0cmluZyhjLnRpdGxlIHx8ICcnKS50cmltKCkgfHwgbGFiZWwuc3BsaXQoJy8nKS5wb3AoKSwKICAgICAgICBsYWJlbCwKICAgICAgICBhcmNoaXZlT25Ecm9wOiAhIWMuYXJjaGl2ZU9uRHJvcCwKICAgICAgfTsKICAgICAgaWYgKGMubGFiZWxJZCAmJiB0eXBlb2YgYy5sYWJlbElkID09PSAnc3RyaW5nJykgY29sLmxhYmVsSWQgPSBjLmxhYmVsSWQ7CiAgICAgIG91dC5wdXNoKGNvbCk7CiAgICB9CiAgICByZXR1cm4gb3V0Lmxlbmd0aCA_IG91dCA6IGRlZmF1bHRDb2x1bW5zKCk7CiAgfQoKICAvLyBXaGVyZSBhIG5ldyBjb2x1bW4ncyBsYWJlbCBnb2VzOiB1bmRlciB0aGUgcGFyZW50IHRoZSBleGlzdGluZyBjb2x1bW5zCiAgLy8gc2hhcmUsIHNvIGEgYm9hcmQgbW92ZWQgdG8gIl9Cb2FyZC_igKYiIGtlZXBzIGdyb3dpbmcgdGhlcmUgcmF0aGVyIHRoYW4KICAvLyBxdWlldGx5IHJlY3JlYXRpbmcgdGhlIG9sZCAiQm9hcmQiIHBhcmVudC4KICBmdW5jdGlvbiBsYWJlbFJvb3QoY29sdW1ucykgewogICAgY29uc3QgcGFyZW50cyA9IG5ldyBTZXQoKGNvbHVtbnMgfHwgW10pLm1hcChjID0-IHsKICAgICAgY29uc3QgcGFydHMgPSBTdHJpbmcoYy5sY",
"WJlbCB8fCAnJykuc3BsaXQoJy8nKTsKICAgICAgcmV0dXJuIHBhcnRzLmxlbmd0aCA-IDEgPyBwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpIDogJyc7CiAgICB9KSk7CiAgICBpZiAocGFyZW50cy5zaXplID09PSAxKSB7CiAgICAgIGNvbnN0IFtvbmx5XSA9IHBhcmVudHM7CiAgICAgIGlmIChvbmx5KSByZXR1cm4gb25seTsKICAgIH0KICAgIHJldHVybiBERUZBVUxUX1JPT1Q7CiAgfQoKICAvLyBDb2x1bW5zIHJlbWVtYmVyIHRoZWlyIGxhYmVsJ3MgaWQgYXMgd2VsbCBhcyBpdHMgbmFtZSwgYmVjYXVzZSBHbWFpbAogIC8vIGxldHMgYSBsYWJlbCBiZSByZW5hbWVkIC0gYW5kIHJlbmFtaW5nICJCb2FyZCIgdG8gIl9Cb2FyZCIgcmVuYW1lcwogIC8vIGV2ZXJ5IGNvbHVtbiBsYWJlbCB1bmRlciBpdC4gRm9sbG93aW5nIHRoZSBpZCBrZWVwcyBhIGNvbHVtbiBvbiB0aGUKICAvLyBzYW1lIG1haWw7IGZvbGxvd2luZyB0aGUgbmFtZSBhbG9uZSB3b3VsZCBjcmVhdGUgYSBmcmVzaCwgZW1wdHkgbGFiZWwKICAvLyB3aXRoIHRoZSBvbGQgbmFtZS4gUmV0dXJucyB0aGUgY29sdW1ucyB3aXRoIG5hbWVzIGJyb3VnaHQgdXAgdG8gZGF0ZQogIC8vIGFuZCBpZHMgZmlsbGVkIGluLCBhbmQgd2hldGhlciBhbnl0aGluZyBjaGFuZ2VkIChzbyBpdCBjYW4gYmUgc2F2ZWQpLgogIGZ1bmN0aW9uIHJlc29sdmVDb2x1bW5MYWJlbHMoY29sdW1ucywgbGFiZWxzKSB7CiAgICBjb25zdCBieUlkID0gbmV3IE1hcCgobGFiZWxzI",
"Hx8IFtdKS5tYXAobCA9PiBbbC5pZCwgbF0pKTsKICAgIGNvbnN0IGJ5TmFtZSA9IG5ldyBNYXAoKGxhYmVscyB8fCBbXSkubWFwKGwgPT4gW1N0cmluZyhsLm5hbWUpLnRvTG93ZXJDYXNlKCksIGxdKSk7CiAgICBsZXQgY2hhbmdlZCA9IGZhbHNlOwogICAgY29uc3Qgb3V0ID0gY29sdW1ucy5tYXAoYyA9PiB7CiAgICAgIGNvbnN0IHZpYUlkID0gYy5sYWJlbElkICYmIGJ5SWQuZ2V0KGMubGFiZWxJZCk7CiAgICAgIGlmICh2aWFJZCkgewogICAgICAgIGlmICh2aWFJZC5uYW1lID09PSBjLmxhYmVsKSByZXR1cm4gYzsKICAgICAgICBjaGFuZ2VkID0gdHJ1ZTsKICAgICAgICByZXR1cm4geyAuLi5jLCBsYWJlbDogdmlhSWQubmFtZSB9OwogICAgICB9CiAgICAgIC8vIEdtYWlsJ3Mgb3duIHNwZWxsaW5nIHdpbnMsIHNvIGEgY2FzZS1vbmx5IGRpZmZlcmVuY2Ugc2V0dGxlcyBoZXJlCiAgICAgIC8vIHJhdGhlciB0aGFuIGNvdW50aW5nIGFzIGEgcmVuYW1lIG9uIHRoZSBuZXh0IHBhc3MuCiAgICAgIGNvbnN0IHZpYU5hbWUgPSBieU5hbWUuZ2V0KFN0cmluZyhjLmxhYmVsKS50b0xvd2VyQ2FzZSgpKTsKICAgICAgaWYgKHZpYU5hbWUpIHsKICAgICAgICBpZiAoYy5sYWJlbElkID09PSB2aWFOYW1lLmlkICYmIGMubGFiZWwgPT09IHZpYU5hbWUubmFtZSkgcmV0dXJuIGM7CiAgICAgICAgY2hhbmdlZCA9IHRydWU7CiAgICAgICAgcmV0dXJuIHsgLi4uYywgbGFiZWw6IHZpYU5hbWUubmFtZSwgbGFiZWxJZDogdmlhT",
"mFtZS5pZCB9OwogICAgICB9CiAgICAgIC8vIE5vdCBpbiBHbWFpbCAoeWV0KTogaXQgaXMgY3JlYXRlZCB1bmRlciB0aGlzIG5hbWUsIGFuZCBpdHMgaWQgaXMKICAgICAgLy8gcmVjb3JkZWQgb24gdGhlIG5leHQgcGFzcy4KICAgICAgaWYgKGMubGFiZWxJZCkgewogICAgICAgIGNoYW5nZWQgPSB0cnVlOwogICAgICAgIGNvbnN0IHsgbGFiZWxJZCwgLi4ucmVzdCB9ID0gYzsKICAgICAgICByZXR1cm4gcmVzdDsKICAgICAgfQogICAgICByZXR1cm4gYzsKICAgIH0pOwogICAgcmV0dXJuIHsgY29sdW1uczogb3V0LCBjaGFuZ2VkIH07CiAgfQoKICBmdW5jdGlvbiBuZXdDb2x1bW5JZChleGlzdGluZywgcmFuZCA9IE1hdGgucmFuZG9tKSB7CiAgICBjb25zdCB0YWtlbiA9IG5ldyBTZXQoKGV4aXN0aW5nIHx8IFtdKS5tYXAoYyA9PiBjLmlkKSk7CiAgICBsZXQgaWQ7CiAgICBkbyB7CiAgICAgIGlkID0gJ2MnICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyBNYXRoLmZsb29yKHJhbmQoKSAqIDFlNikudG9TdHJpbmcoMzYpOwogICAgfSB3aGlsZSAodGFrZW4uaGFzKGlkKSk7CiAgICByZXR1cm4gaWQ7CiAgfQoKICAvLyBHbWFpbCByZXNlcnZlcyBpdHMgc3lzdGVtIGxhYmVsIG5hbWVzIChjYXNlLWluc2Vuc2l0aXZlbHkpIGFuZCByZWplY3RzCiAgLy8gZW1wdHkgcGF0aCBzZWdtZW50cywgc28gYm90aCBhcmUgY2F1Z2h0IGhlcmUgd2l0aCBhIHJlYWRhYmxlIG1lc3NhZ2UKICAvLyBpbnN0ZWFkIG9mIGEgYmFyZ",
"SA0MDAgZnJvbSB0aGUgQVBJLgogIGNvbnN0IFJFU0VSVkVEID0gbmV3IFNldChbCiAgICAnaW5ib3gnLCAnc2VudCcsICdkcmFmdHMnLCAnc3BhbScsICd0cmFzaCcsICdzdGFycmVkJywgJ2ltcG9ydGFudCcsCiAgICAndW5yZWFkJywgJ2NoYXQnLCAnc25vb3plZCcsICdzY2hlZHVsZWQnLCAnYWxsIG1haWwnLCAnb3V0Ym94JywKICBdKTsKCiAgZnVuY3Rpb24gdmFsaWRhdGVDb2x1bW5zKGNvbHMpIHsKICAgIGlmICghY29scy5sZW5ndGgpIHJldHVybiAnS2VlcCBhdCBsZWFzdCBvbmUgY29sdW1uLic7CiAgICBjb25zdCBsYWJlbHMgPSBuZXcgU2V0KCk7CiAgICBmb3IgKGNvbnN0IGMgb2YgY29scykgewogICAgICBjb25zdCB0aXRsZSA9IChjLnRpdGxlIHx8ICcnKS50cmltKCk7CiAgICAgIGNvbnN0IGxhYmVsID0gKGMubGFiZWwgfHwgJycpLnRyaW0oKTsKICAgICAgaWYgKCF0aXRsZSkgcmV0dXJuICdFdmVyeSBjb2x1bW4gbmVlZHMgYSB0aXRsZS4nOwogICAgICBpZiAoIWxhYmVsKSByZXR1cm4gYOKAnCR7dGl0bGV94oCdIG5lZWRzIGEgR21haWwgbGFiZWwuYDsKICAgICAgaWYgKGxhYmVsLnNwbGl0KCcvJykuc29tZShzZWcgPT4gIXNlZy50cmltKCkpKSB7CiAgICAgICAgcmV0dXJuIGDigJwke2xhYmVsfeKAnSBoYXMgYW4gZW1wdHkgcGFydCBiZXR3ZWVuIHNsYXNoZXMuYDsKICAgICAgfQogICAgICBpZiAoUkVTRVJWRUQuaGFzKGxhYmVsLnRvTG93ZXJDYXNlKCkpKSByZXR1cm4gYOKAnCR7bGFiZWx94",
"oCdIGlzIGEgR21haWwgc3lzdGVtIGxhYmVsIGFuZCBjYW5ub3QgYmUgdXNlZC5gOwogICAgICBjb25zdCBrZXkgPSBsYWJlbC50b0xvd2VyQ2FzZSgpOwogICAgICBpZiAobGFiZWxzLmhhcyhrZXkpKSByZXR1cm4gYFR3byBjb2x1bW5zIHVzZSB0aGUgbGFiZWwg4oCcJHtsYWJlbH3igJ0uYDsKICAgICAgbGFiZWxzLmFkZChrZXkpOwogICAgfQogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gIl9Cb2FyZC9UbyBkbyIg4oaSIFsiX0JvYXJkIl0uIEdtYWlsIG9ubHkgbmVzdHMgYSBsYWJlbCBpbiBpdHMgc2lkZWJhcgogIC8vIHdoZW4gdGhlIHBhcmVudCBleGlzdHMsIHNvIHRoZSBwYXJlbnRzIGFyZSBjcmVhdGVkIHRvby4KICBmdW5jdGlvbiBsYWJlbEFuY2VzdG9ycyhuYW1lKSB7CiAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyhuYW1lKS5zcGxpdCgnLycpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID0gMTsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSBvdXQucHVzaChwYXJ0cy5zbGljZSgwLCBpKS5qb2luKCcvJykpOwogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIOKUgOKUgCBQbGFjZW1lbnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vI",
"EEgdGhyZWFkIGNhcnJ5aW5nIHR3byBjb2x1bW4gbGFiZWxzIChtb3ZlZCBvbiB0aGUgcGhvbmUsIHNheSkgaXMgc2hvd24KICAvLyBvbmNlLCBpbiB0aGUgbGVmdC1tb3N0IG9mIGl0cyBjb2x1bW5zLiBTaG93aW5nIGl0IHR3aWNlIHdvdWxkIG1ha2UgYQogIC8vIGRyYWcgYW1iaWd1b3VzIGFib3V0IHdoaWNoIGxhYmVsIGl0IGlzIGxlYXZpbmcuCiAgZnVuY3Rpb24gYXNzaWduQ29sdW1ucyhjb2x1bW5zLCBsaXN0c0J5Q29sdW1uKSB7CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3Qgb3V0ID0ge307CiAgICBmb3IgKGNvbnN0IGNvbCBvZiBjb2x1bW5zKSB7CiAgICAgIG91dFtjb2wuaWRdID0gW107CiAgICAgIGZvciAoY29uc3QgaWQgb2YgKGxpc3RzQnlDb2x1bW5bY29sLmlkXSB8fCBbXSkpIHsKICAgICAgICBpZiAoc2Vlbi5oYXMoaWQpKSBjb250aW51ZTsKICAgICAgICBzZWVuLmFkZChpZCk7CiAgICAgICAgb3V0W2NvbC5pZF0ucHVzaChpZCk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBTYXZlZCBvcmRlciB3aW5zIGZvciBldmVyeSB0aHJlYWQgaXQgbWVudGlvbnMuIFRocmVhZHMgaXQgZG9lcyBub3QKICAvLyBrbm93IGFib3V0IGFyZSBuZXcgdG8gdGhlIGNvbHVtbiwgc28gdGhleSBnbyBvbiB0b3AgLSBuZXdlc3QgZmlyc3QgLQogIC8vIHdoZXJlIHRoZXkgd2lsbCBiZSBub3RpY2VkLiBJZHMgdGhhdCBoYXZlIGxlZnQgdGhlIGNvbHVtbiBkcm9wIG91d",
"C4KICBmdW5jdGlvbiBtZXJnZU9yZGVyKHNhdmVkSWRzLCB0aHJlYWRzKSB7CiAgICBjb25zdCBwcmVzZW50ID0gbmV3IE1hcCh0aHJlYWRzLm1hcCh0ID0-IFt0LmlkLCB0XSkpOwogICAgY29uc3Qga2VwdCA9IFtdOwogICAgY29uc3Qga2VwdFNldCA9IG5ldyBTZXQoKTsKICAgIGZvciAoY29uc3QgaWQgb2YgKHNhdmVkSWRzIHx8IFtdKSkgewogICAgICBpZiAocHJlc2VudC5oYXMoaWQpICYmICFrZXB0U2V0LmhhcyhpZCkpIHsga2VwdC5wdXNoKGlkKTsga2VwdFNldC5hZGQoaWQpOyB9CiAgICB9CiAgICBjb25zdCBmcmVzaCA9IHRocmVhZHMKICAgICAgLmZpbHRlcih0ID0-ICFrZXB0U2V0Lmhhcyh0LmlkKSkKICAgICAgLnNvcnQoKGEsIGIpID0-IChOdW1iZXIoYi50cykgfHwgMCkgLSAoTnVtYmVyKGEudHMpIHx8IDApKQogICAgICAubWFwKHQgPT4gdC5pZCk7CiAgICByZXR1cm4gZnJlc2guY29uY2F0KGtlcHQpOwogIH0KCiAgLy8gSW5kZXggaXMgYSBwb3NpdGlvbiBpbiB0aGUgbGlzdCBhcyBpdCBsb29rcyBXSVRIT1VUIHRoZSB0aHJlYWQgYmVpbmcKICAvLyBwbGFjZWQgLSB3aGljaCBpcyB3aGF0IHRoZSBkcm9wIHpvbmUgbWVhc3VyZXMsIHNpbmNlIHRoZSBkcmFnZ2VkIGNhcmQKICAvLyBpcyBoaWRkZW4gd2hpbGUgaXQgaXMgaW4gZmxpZ2h0LgogIGZ1bmN0aW9uIHBsYWNlSWQobGlzdCwgaWQsIGluZGV4KSB7CiAgICBjb25zdCByZXN0ID0gKGxpc3QgfHwgW10pLmZpbHRlcih4ID0-IHggIT09IGlkK",
"TsKICAgIGNvbnN0IGkgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihOdW1iZXIoaW5kZXgpIHx8IDAsIHJlc3QubGVuZ3RoKSk7CiAgICByZXN0LnNwbGljZShpLCAwLCBpZCk7CiAgICByZXR1cm4gcmVzdDsKICB9CgogIC8vIERyb3BzIGlkcyB0aGF0IGFyZSBub3Qgb24gdGhlIGJvYXJkIGFueSBtb3JlLCBhbmQgY29sdW1ucyB0aGF0IG5vCiAgLy8gbG9uZ2VyIGV4aXN0LCBzbyBzdG9yYWdlLmxvY2FsIGRvZXMgbm90IHNsb3dseSBmaWxsIHdpdGggZGVhZCB0aHJlYWRzLgogIGZ1bmN0aW9uIHBydW5lT3JkZXIobGlzdHMsIGNvbHVtbnMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgZm9yIChjb25zdCBjb2wgb2YgY29sdW1ucykgb3V0W2NvbC5pZF0gPSAobGlzdHNbY29sLmlkXSB8fCBbXSkuc2xpY2UoKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgTGFiZWwgYXJpdGhtZXRpYyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYXNMb29rdXAobGFiZWxJZE9mKSB7CiAgICBpZiAodHlwZW9mIGxhYmVsSWRPZiA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIGxhYmVsSWRPZjsKICAgIGlmIChsYWJlbElkT2YgaW5zdGFuY2VvZiBNYXApIHJldHVybiBuYW1lID0-IGxhYmVsS",
"WRPZi5nZXQobmFtZSk7CiAgICByZXR1cm4gbmFtZSA9PiAobGFiZWxJZE9mIHx8IHt9KVtuYW1lXTsKICB9CgogIC8vIE1vdmluZyBhIGNhcmQgaXMgb25lIHRocmVhZHMubW9kaWZ5OiBhZGQgdGhlIHRhcmdldCdzIGxhYmVsLCBzdHJpcAogIC8vIGV2ZXJ5IG90aGVyIGNvbHVtbiBsYWJlbCAoc28gYSB0aHJlYWQgaXMgb25seSBldmVyIGluIG9uZSBjb2x1bW4sIGV2ZW4KICAvLyBpZiBpdCBoYWQgZHJpZnRlZCBpbnRvIHR3byksIGFuZCBkcm9wIElOQk9YIHdoZW4gdGhlIHRhcmdldCBhcmNoaXZlcy4KICBmdW5jdGlvbiBtb3ZlTGFiZWxEaWZmKGNvbHVtbnMsIHRhcmdldENvbHVtbklkLCBsYWJlbElkT2YpIHsKICAgIGNvbnN0IGxvb2t1cCA9IGFzTG9va3VwKGxhYmVsSWRPZik7CiAgICBjb25zdCB0YXJnZXQgPSBjb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSB0YXJnZXRDb2x1bW5JZCk7CiAgICBpZiAoIXRhcmdldCkgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGNvbHVtbiAke3RhcmdldENvbHVtbklkfWApOwogICAgY29uc3QgYWRkSWQgPSBsb29rdXAodGFyZ2V0LmxhYmVsKTsKICAgIGlmICghYWRkSWQpIHRocm93IG5ldyBFcnJvcihgTm8gR21haWwgbGFiZWwgaWQgZm9yIOKAnCR7dGFyZ2V0LmxhYmVsfeKAnWApOwoKICAgIGNvbnN0IHJlbW92ZSA9IG5ldyBTZXQoKTsKICAgIGZvciAoY29uc3QgYyBvZiBjb2x1bW5zKSB7CiAgICAgIGlmIChjLmlkID09PSB0YXJnZXRDb2x1bW5JZCkgY29udGludWU7C",
"iAgICAgIGNvbnN0IGlkID0gbG9va3VwKGMubGFiZWwpOwogICAgICBpZiAoaWQgJiYgaWQgIT09IGFkZElkKSByZW1vdmUuYWRkKGlkKTsKICAgIH0KICAgIGlmICh0YXJnZXQuYXJjaGl2ZU9uRHJvcCkgcmVtb3ZlLmFkZCgnSU5CT1gnKTsKICAgIHJldHVybiB7IGFkZExhYmVsSWRzOiBbYWRkSWRdLCByZW1vdmVMYWJlbElkczogWy4uLnJlbW92ZV0gfTsKICB9CgogIC8vIFRha2luZyBhIGNhcmQgb2ZmIHRoZSBib2FyZCBzdHJpcHMgZXZlcnkgY29sdW1uIGxhYmVsIGFuZCBub3RoaW5nCiAgLy8gZWxzZTogdGhlIHRocmVhZCBzdGF5cyBleGFjdGx5IHdoZXJlIGl0IHdhcyBpbiBHbWFpbC4KICBmdW5jdGlvbiByZW1vdmVMYWJlbERpZmYoY29sdW1ucywgbGFiZWxJZE9mKSB7CiAgICBjb25zdCBsb29rdXAgPSBhc0xvb2t1cChsYWJlbElkT2YpOwogICAgY29uc3QgcmVtb3ZlID0gbmV3IFNldCgpOwogICAgZm9yIChjb25zdCBjIG9mIGNvbHVtbnMpIHsKICAgICAgY29uc3QgaWQgPSBsb29rdXAoYy5sYWJlbCk7CiAgICAgIGlmIChpZCkgcmVtb3ZlLmFkZChpZCk7CiAgICB9CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogW10sIHJlbW92ZUxhYmVsSWRzOiBbLi4ucmVtb3ZlXSB9OwogIH0KCiAgLy8gV2hpY2ggY29sdW1uIGEgdGhyZWFkIGJlbG9uZ3MgaW4sIGdpdmVuIHRoZSB1bmlvbiBvZiBpdHMgbGFiZWwgaWRzLgogIGZ1bmN0aW9uIGNvbHVtbkZvckxhYmVscyhjb2x1bW5zLCBsYWJlbElkcywgbGFiZWxJZ",
"E9mKSB7CiAgICBjb25zdCBsb29rdXAgPSBhc0xvb2t1cChsYWJlbElkT2YpOwogICAgY29uc3QgaGF2ZSA9IG5ldyBTZXQobGFiZWxJZHMgfHwgW10pOwogICAgZm9yIChjb25zdCBjIG9mIGNvbHVtbnMpIHsKICAgICAgY29uc3QgaWQgPSBsb29rdXAoYy5sYWJlbCk7CiAgICAgIGlmIChpZCAmJiBoYXZlLmhhcyhpZCkpIHJldHVybiBjOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQoKICAvLyDilIDilIAgVGhyZWFkcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmVkdWNlcyBhIHRocmVhZHMuZ2V0KGZvcm1hdD1tZXRhZGF0YSkgcmVzcG9uc2UgdG8gd2hhdCBhIGNhcmQgc2hvd3MuCiAgLy8gU3ViamVjdCBjb21lcyBmcm9tIHRoZSBmaXJzdCBtZXNzYWdlIChyZXBsaWVzIHByZWZpeCAiUmU6IiksIHNlbmRlcgogIC8vIGFuZCBkYXRlIGZyb20gdGhlIGxhdGVzdCByZWFsIG1lc3NhZ2UgKGEgcGVuZGluZyBkcmFmdCBpcyBub3QgbmV3cykuCiAgZnVuY3Rpb24gc3VtbWFyaXNlVGhyZWFkKHRocmVhZCwgYWNjb3VudCkgewogICAgY29uc3QgbXNncyA9ICh0aHJlYWQgJiYgdGhyZWFkLm1lc3NhZ2VzKSB8fCBbXTsKICAgIGNvbnN0IGlkI",
"D0gdGhyZWFkICYmIHRocmVhZC5pZDsKICAgIGNvbnN0IGhpc3RvcnlJZCA9IFN0cmluZygodGhyZWFkICYmIHRocmVhZC5oaXN0b3J5SWQpIHx8ICcnKTsKICAgIGlmICghbXNncy5sZW5ndGgpIHsKICAgICAgcmV0dXJuIHsKICAgICAgICBpZCwgaGlzdG9yeUlkLCBzdWJqZWN0OiAnKG5vIHN1YmplY3QpJywgZnJvbTogJycsIGZyb21FbWFpbDogJycsIHRzOiAwLAogICAgICAgIHNuaXBwZXQ6IHV0aWwuZGVjb2RlRW50aXRpZXMoKHRocmVhZCAmJiB0aHJlYWQuc25pcHBldCkgfHwgJycpLAogICAgICAgIGNvdW50OiAwLCB1bnJlYWQ6IGZhbHNlLCBzdGFycmVkOiBmYWxzZSwgaGFzRHJhZnQ6IGZhbHNlLCBsYWJlbElkczogW10sCiAgICAgIH07CiAgICB9CgogICAgY29uc3QgaXNEcmFmdCA9IG0gPT4gKG0ubGFiZWxJZHMgfHwgW10pLmluY2x1ZGVzKCdEUkFGVCcpOwogICAgY29uc3QgcmVhbCA9IG1zZ3MuZmlsdGVyKG0gPT4gIWlzRHJhZnQobSkpOwogICAgY29uc3QgYmFzaXMgPSByZWFsLmxlbmd0aCA_IHJlYWwgOiBtc2dzOwogICAgY29uc3QgbGF0ZXN0ID0gYmFzaXNbYmFzaXMubGVuZ3RoIC0gMV07CiAgICBjb25zdCBmaXJzdEhlYWRlcnMgPSB1dGlsLmhlYWRlck1hcChtc2dzWzBdKTsKICAgIGNvbnN0IGxhdGVzdEhlYWRlcnMgPSB1dGlsLmhlYWRlck1hcChsYXRlc3QpOwoKICAgIGNvbnN0IGZyb20gPSB1dGlsLnBhcnNlQWRkcmVzcyhsYXRlc3RIZWFkZXJzLmZyb20pOwogICAgY29uc3QgbWUgPSAhI",
"WFjY291bnQgJiYgZnJvbS5lbWFpbCA9PT0gU3RyaW5nKGFjY291bnQpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBsYWJlbHMgPSBuZXcgU2V0KG1zZ3MuZmxhdE1hcChtID0-IG0ubGFiZWxJZHMgfHwgW10pKTsKCiAgICByZXR1cm4gewogICAgICBpZCwKICAgICAgaGlzdG9yeUlkLAogICAgICBzdWJqZWN0OiAoZmlyc3RIZWFkZXJzLnN1YmplY3QgfHwgJycpLnRyaW0oKSB8fCAnKG5vIHN1YmplY3QpJywKICAgICAgZnJvbTogbWUgPyAnbWUnIDogKHV0aWwuZGlzcGxheU5hbWUoZnJvbSkgfHwgJyh1bmtub3duIHNlbmRlciknKSwKICAgICAgZnJvbUVtYWlsOiBmcm9tLmVtYWlsLAogICAgICB0czogTnVtYmVyKGxhdGVzdC5pbnRlcm5hbERhdGUpIHx8IERhdGUucGFyc2UobGF0ZXN0SGVhZGVycy5kYXRlKSB8fCAwLAogICAgICBzbmlwcGV0OiB1dGlsLmRlY29kZUVudGl0aWVzKGxhdGVzdC5zbmlwcGV0IHx8IHRocmVhZC5zbmlwcGV0IHx8ICcnKSwKICAgICAgY291bnQ6IGJhc2lzLmxlbmd0aCwKICAgICAgdW5yZWFkOiBsYWJlbHMuaGFzKCdVTlJFQUQnKSwKICAgICAgc3RhcnJlZDogbGFiZWxzLmhhcygnU1RBUlJFRCcpLAogICAgICBoYXNEcmFmdDogbXNncy5zb21lKGlzRHJhZnQpLAogICAgICBsYWJlbElkczogWy4uLmxhYmVsc10sCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gc2VhcmNoUXVlcnkodGV4dCkgewogICAgY29uc3QgcSA9IFN0cmluZyh0ZXh0IHx8ICcnKS50cmltKCk7CiAgICByZXR1cm4gc",
"SB8fCAnaW46aW5ib3gnOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgZWRpdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGNhcmQgY2FuIGNhcnJ5IHRoZSB1c2VyJ3Mgb3duIHRpdGxlLCBhIHNob3J0IG5vdGUgYW5kIGEgY29sb3VyLiBUaGV5CiAgLy8gbGl2ZSBpbiBzdG9yYWdlLnN5bmMgYmVzaWRlIHRoZSBjb2x1bW4gbGF5b3V0IGFuZCBuZXZlciB0b3VjaCB0aGUgbWFpbDoKICAvLyBHbWFpbCBoYXMgbm93aGVyZSB0byBwdXQgYSBwcml2YXRlIHRpdGxlIG9uIGEgdGhyZWFkLCBhbmQgcmV3cml0aW5nIGEKICAvLyBzdWJqZWN0IHdvdWxkIGNoYW5nZSB3aGF0IGNvcnJlc3BvbmRlbnRzIHNlZSBpbiB0aGVpciByZXBsaWVzLgoKICBjb25zdCBDQVJEX0NPTE9VUlMgPSBbJ3JlZCcsICdvcmFuZ2UnLCAneWVsbG93JywgJ2dyZWVuJywgJ2JsdWUnLCAncHVycGxlJywgJ2dyZXknXTsKCiAgLy8gTG9uZyBlbm91Z2ggZm9yIGEgd29ya2luZyB0aXRsZSBvciBhICI0LDIwMCB3b3JkcywgZHVlIEZyaSIgbm90ZSwgc2hvcnQKICAvLyBlbm91Z2ggdGhhdCBodW5kcmVkcyBvZiBjYXJkcyBmaXQgc3luYydzIDEwMCBLQi4KICBjb25zdCBNQVhfVElUTEUgP",
"SAyMDA7CiAgY29uc3QgTUFYX05PVEUgPSA1MDA7CgogIC8vIFJldHVybnMgdGhlIGVkaXQgdG8gc3RvcmUsIG9yIG51bGwgd2hlbiBub3RoaW5nIGRpZmZlcnMgZnJvbSB0aGUKICAvLyBlbWFpbCAtIHNvIGNsZWFyaW5nIGV2ZXJ5IGZpZWxkIGRlbGV0ZXMgdGhlIHJlY29yZCBpbnN0ZWFkIG9mIGxlYXZpbmcKICAvLyBhbiBlbXB0eSBvbmUgdG8gY291bnQgYWdhaW5zdCB0aGUgcXVvdGEuIEEgdGl0bGUgaWRlbnRpY2FsIHRvIHRoZQogIC8vIHN1YmplY3QgaXMgbm90IGFuIGVkaXQgZWl0aGVyOiB0aGUgZWRpdG9yIG9wZW5zIHByZS1maWxsZWQgd2l0aCBpdC4KICBmdW5jdGlvbiBub3JtYWxpc2VDYXJkRWRpdChyYXcsIHN1YmplY3QgPSAnJykgewogICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsOwogICAgY29uc3QgdGl0bGUgPSBTdHJpbmcocmF3LnRpdGxlIHx8ICcnKS5yZXBsYWNlKC9ccysvZywgJyAnKS50cmltKCkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGNvbnN0IG5vdGUgPSBTdHJpbmcocmF3Lm5vdGUgfHwgJycpCiAgICAgIC5yZXBsYWNlKC9cclxuPy9nLCAnXG4nKQogICAgICAucmVwbGFjZSgvXG57Myx9L2csICdcblxuJykKICAgICAgLnRyaW0oKQogICAgICAuc2xpY2UoMCwgTUFYX05PVEUpOwogICAgY29uc3QgY29sb3VyID0gQ0FSRF9DT0xPVVJTLmluY2x1ZGVzKHJhdy5jb2xvdXIpID8gcmF3LmNvbG91ciA6ICcnOwoKICAgIGNvbnN0IG91dCA9I",
"Ht9OwogICAgaWYgKHRpdGxlICYmIHRpdGxlICE9PSBTdHJpbmcoc3ViamVjdCB8fCAnJykudHJpbSgpKSBvdXQudGl0bGUgPSB0aXRsZTsKICAgIGlmIChub3RlKSBvdXQubm90ZSA9IG5vdGU7CiAgICBpZiAoY29sb3VyKSBvdXQuY29sb3VyID0gY29sb3VyOwogICAgcmV0dXJuIE9iamVjdC5rZXlzKG91dCkubGVuZ3RoID8gb3V0IDogbnVsbDsKICB9CgogIGZ1bmN0aW9uIGRpc3BsYXlUaXRsZSh0aHJlYWQsIGVkaXQpIHsKICAgIHJldHVybiAoZWRpdCAmJiBlZGl0LnRpdGxlKSB8fCAodGhyZWFkICYmIHRocmVhZC5zdWJqZWN0KSB8fCAnKG5vIHN1YmplY3QpJzsKICB9CgogIC8vIFBpY2tzIG9uZSBhY2NvdW50J3MgY2FyZCBlZGl0cyBvdXQgb2YgYSBzdG9yYWdlLnN5bmMgZHVtcCwga2V5ZWQgYnkKICAvLyB0aHJlYWQgaWQuIFJlY29yZHMgdGhhdCBubyBsb25nZXIgbm9ybWFsaXNlIHRvIGFueXRoaW5nIGFyZSBkcm9wcGVkLgogIGZ1bmN0aW9uIGNhcmRFZGl0c0Zyb20oYWxsLCBwcmVmaXgpIHsKICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTsKICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGFsbCB8fCB7fSkpIHsKICAgICAgaWYgKCFrZXkuc3RhcnRzV2l0aChwcmVmaXgpKSBjb250aW51ZTsKICAgICAgY29uc3QgaWQgPSBrZXkuc2xpY2UocHJlZml4Lmxlbmd0aCk7CiAgICAgIGNvbnN0IGVkaXQgPSBub3JtYWxpc2VDYXJkRWRpdCh2YWx1ZSk7CiAgICAgIGlmIChpZCAmJ",
"iBlZGl0KSBvdXQuc2V0KGlkLCBlZGl0KTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBERUZBVUxUX1JPT1QsIERFRkFVTFRfQ09MVU1OUywgZGVmYXVsdENvbHVtbnMsIG5vcm1hbGlzZUNvbHVtbnMsIGxhYmVsUm9vdCwgcmVzb2x2ZUNvbHVtbkxhYmVscywKICAgIG5ld0NvbHVtbklkLCB2YWxpZGF0ZUNvbHVtbnMsCiAgICBsYWJlbEFuY2VzdG9ycywgYXNzaWduQ29sdW1ucywgbWVyZ2VPcmRlciwgcGxhY2VJZCwgcHJ1bmVPcmRlciwKICAgIG1vdmVMYWJlbERpZmYsIHJlbW92ZUxhYmVsRGlmZiwgY29sdW1uRm9yTGFiZWxzLCBzdW1tYXJpc2VUaHJlYWQsIHNlYXJjaFF1ZXJ5LAogICAgQ0FSRF9DT0xPVVJTLCBNQVhfVElUTEUsIE1BWF9OT1RFLCBub3JtYWxpc2VDYXJkRWRpdCwgZGlzcGxheVRpdGxlLCBjYXJkRWRpdHNGcm9tLAogIH07CgogIG5zLmxvZ2ljID0gYXBpOwogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgbW9kdWxlLmV4cG9ydHMgPSBhcGk7Cn0pKCk7Cg\"],[\"src/lib/calendar-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIENhbGVuZGFyIGxvZ2ljIChwdXJlKQovLwovLyBUaGUgQ2FsZW5kYXIgdGFiIHNob3dzIEdvb2dsZSBDYWxlbmRhcidzIGV2ZW50cyBhbmQgR29vZ2xlIFRhc2tzJwovLyB0YXNrcyBzaWRlIGJ5IHNpZGUsIGRheSBieSBkYXkuIFRoaXMgZmlsZSBob2xkcyB0aGUgcGFydHMgdGhhdCBuZWVkIG5vCi8vIGJyb3dzZXI6IGRhdGVzIGFzICJZWVlZLU1NLUREIiBrZXlzIGluIGxvY2FsIHRpbWUsIHRoZSByYW5nZXMgZWFjaAovLyB2aWV3IHNob3dzLCB0dXJuaW5nIHRoZSB0d28gQVBJcycgYW5zd2VycyBpbnRvIG9uZSBraW5kIG9mIGRheSBpdGVtLAovLyBhbmQgd2hpY2ggcmVxdWVzdHMgdG8gR29vZ2xlIGFyZSBhbGxvd2VkIGF0IGFsbC4KLy8KLy8gSXQgaXMgcmVhZC1vbmx5IGZvciBub3cuIFRoZSBzZWNvbmQgc2lnbi1pbiBhc2tzIGZvciByZWFkLW9ubHkgYWNjZXNzIHRvCi8vIENhbGVuZGFyIGFuZCBUYXNrcywgYW5kIHRoZSByZXF1ZXN0IHBvbGljeSBiZWxvdyBvbmx5IGxldHMgR0VUcyB0aHJvdWdoOgovLyB0aGUgY2FsZW5kYXIgbGlzdCwgYSBjYWxlbmRhcidzIGV2ZW50cywgdGhlIHRhc2sgbGlzdHMgYW5kIGEgbGlzdCdzCi8vIHRhc2tzLgovLwovLyBMb2FkZWQgYnkgdGhlIGNvbnRlbnQgc2NyaXB0cywgdGhlIHNlcnZpY2Ugd29ya2VyLCB0aGUgcGhvbmUgYXBwJ3MKLy8gc2NyaXB0IGFuZCBOb2RlJ3MgdGVzdHMuCi8vIOKUgOKUgOKUgOKUgO",
"KUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgR29vZ2xlLCBhbmQgd2hhdCBtYXkgYmUgYXNrZWQgb2YgaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRoZSBzZWNvbmQgc2lnbi1pbiwgc2VwYXJhdGUgZnJvbSBHbWFpbCdzLCBzbyB0aGF0IHRoZSBib2FyZCBhbmQgdGhlCiAgLy8gbm90ZXMgbmV2ZXIgc3RvcCB3b3JraW5nIGZvciBzb21lb25lIHdobyBoYXMgbm90IGFsbG93ZWQgdGhlIGNhbGVuZGFyLgogIC8vICJlbWFpbCIgbGV0cyB0aGUgd29ya2VyIGNoZWNrIHdob3NlIGNhbGVuZGFyIGl0IGlzLgogIGNvbnN0IFNDT1BFUyA9IFsKICAgICdlbWFpbCcsCiAgICAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC9jYWxlbmRhci5yZWFkb25seScsCiAgICAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb2",
"0vYXV0aC90YXNrcy5yZWFkb25seScsCiAgXTsKCiAgY29uc3QgQkFTRVMgPSB7CiAgICBjYWxlbmRhcjogJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2NhbGVuZGFyL3YzLycsCiAgICB0YXNrczogJ2h0dHBzOi8vdGFza3MuZ29vZ2xlYXBpcy5jb20vdGFza3MvdjEvJywKICB9OwoKICBjb25zdCBVU0VSSU5GT19VUkwgPSAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vb2F1dGgyL3YzL3VzZXJpbmZvJzsKCiAgLy8gT25lIHBhdGggc2VnbWVudDogYW4gaWQsIGVuY29kZWQgd2l0aCBlbmNvZGVVUklDb21wb25lbnQuIE5ldmVyIG9uZQogIC8vIHRoYXQgdGhlIFVSTCBwYXJzZXIgd291bGQgcmVhZCBhcyAiLiIgb3IgIi4uIiwgZW5jb2RlZCBvciBub3QuCiAgZnVuY3Rpb24gaXNTZWdtZW50KHMpIHsKICAgIGlmICghL15bQS1aYS16MC05JS5ffi1dKyQvLnRlc3QocykpIHJldHVybiBmYWxzZTsKICAgIGxldCBwbGFpbjsKICAgIHRyeSB7IHBsYWluID0gZGVjb2RlVVJJQ29tcG9uZW50KHMpOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9CiAgICByZXR1cm4gIS9eXC4rJC8udGVzdChwbGFpbikgJiYgIXBsYWluLmluY2x1ZGVzKCcvJyk7CiAgfQoKICBjb25zdCBBTExPV0VEID0gewogICAgY2FsZW5kYXI6IFsKICAgICAgcCA9PiBwID09PSAndXNlcnMvbWUvY2FsZW5kYXJMaXN0JywKICAgICAgcCA9PiB7IGNvbnN0IG0gPSAvXmNhbGVuZGFyc1wvKFteL10rKVwvZXZlbnRzJC8uZXhlYyhwKTsgcmV0dXJuIC",
"EhbSAmJiBpc1NlZ21lbnQobVsxXSk7IH0sCiAgICBdLAogICAgdGFza3M6IFsKICAgICAgcCA9PiBwID09PSAndXNlcnMvQG1lL2xpc3RzJywKICAgICAgcCA9PiB7IGNvbnN0IG0gPSAvXmxpc3RzXC8oW14vXSspXC90YXNrcyQvLmV4ZWMocCk7IHJldHVybiAhIW0gJiYgaXNTZWdtZW50KG1bMV0pOyB9LAogICAgXSwKICB9OwoKICBmdW5jdGlvbiBpc0FsbG93ZWRSZXF1ZXN0KHNlcnZpY2UsIG1ldGhvZCwgcGF0aCkgewogICAgaWYgKFN0cmluZyhtZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCkgIT09ICdHRVQnKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBydWxlcyA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChBTExPV0VELCBzZXJ2aWNlKSA_IEFMTE9XRURbc2VydmljZV0gOiBudWxsOwogICAgcmV0dXJuICEhcnVsZXMgJiYgcnVsZXMuc29tZShvayA9PiBvayhTdHJpbmcocGF0aCB8fCAnJykpKTsKICB9CgogIC8vIFF1ZXJ5IHZhbHVlcyBtYXkgYmUgYXJyYXlzLCBhcyBmb3IgR21haWwuCiAgZnVuY3Rpb24gYnVpbGRVcmwoc2VydmljZSwgcGF0aCwgcXVlcnkpIHsKICAgIGNvbnN0IHBhcnRzID0gW107CiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhxdWVyeSB8fCB7fSkpIHsKICAgICAgY29uc3QgdiA9IHF1ZXJ5W2tleV07CiAgICAgIGlmICh2ID09PSB1bmRlZmluZWQgfHwgdiA9PT0gbnVsbCB8fCB2ID09PSAnJykgY29udGludWU7CiAgICAgIGZvciAoY29uc3",
"Qgb25lIG9mIFtdLmNvbmNhdCh2KSkgcGFydHMucHVzaChgJHtlbmNvZGVVUklDb21wb25lbnQoa2V5KX09JHtlbmNvZGVVUklDb21wb25lbnQob25lKX1gKTsKICAgIH0KICAgIHJldHVybiBCQVNFU1tzZXJ2aWNlXSArIHBhdGggKyAocGFydHMubGVuZ3RoID8gYD8ke3BhcnRzLmpvaW4oJyYnKX1gIDogJycpOwogIH0KCiAgLy8g4pSA4pSAIERhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gQSBkYXkgaXMgYSAiWVlZWS1NTS1ERCIgc3RyaW5nIGluIGxvY2FsIHRpbWU6IGl0IHNvcnRzIGFuZCBjb21wYXJlcyBhcwogIC8vIHRleHQsIGFuZCBzdXJ2aXZlcyBzdG9yYWdlIGFuZCBtZXNzYWdlcyB1bmNoYW5nZWQuIFdlZWtzIHN0YXJ0IG9uCiAgLy8gTW9uZGF5IGFuZCBhcmUgbnVtYmVyZWQgYXMgSVNPIDg2MDEgbnVtYmVycyB0aGVtLgoKICBjb25zdCBEQVlfTkFNRVMgPSBbJ01vbicsICdUdWUnLCAnV2VkJywgJ1RodScsICdGcmknLCAnU2F0JywgJ1N1biddOwogIGNvbnN0IE1PTlRIUyA9IFsnSmFuJywgJ0ZlYicsICdNYXInLCAnQXByJywgJ01heScsICdKdW4nLCAnSnVsJywgJ0F1ZycsICdTZXAnLCAnT2N0JywgJ0",
"5vdicsICdEZWMnXTsKICBjb25zdCBNT05USFNfTE9ORyA9IFsnSmFudWFyeScsICdGZWJydWFyeScsICdNYXJjaCcsICdBcHJpbCcsICdNYXknLCAnSnVuZScsICdKdWx5JywKICAgICAgICAgICAgICAgICAgICAgICAnQXVndXN0JywgJ1NlcHRlbWJlcicsICdPY3RvYmVyJywgJ05vdmVtYmVyJywgJ0RlY2VtYmVyJ107CgogIC8vIEhvdyBmYXIgdGhlIGFnZW5kYSBsb29rcyBhaGVhZCwgYW5kIGhvdyBmYXIgb25lIHN0ZXAgbW92ZXMgaXQuCiAgY29uc3QgQUdFTkRBX0RBWVMgPSAyODsKCiAgY29uc3QgcGFkID0gbiA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgJzAnKTsKCiAgZnVuY3Rpb24gZGF0ZUtleShkKSB7CiAgICBjb25zdCB4ID0gZCBpbnN0YW5jZW9mIERhdGUgPyBkIDogbmV3IERhdGUoZCk7CiAgICByZXR1cm4gYCR7eC5nZXRGdWxsWWVhcigpfS0ke3BhZCh4LmdldE1vbnRoKCkgKyAxKX0tJHtwYWQoeC5nZXREYXRlKCkpfWA7CiAgfQoKICBmdW5jdGlvbiBpc0tleShrZXkpIHsKICAgIHJldHVybiAvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChTdHJpbmcoa2V5IHx8ICcnKSk7CiAgfQoKICBmdW5jdGlvbiBmcm9tS2V5KGtleSkgewogICAgY29uc3QgW3ksIG0sIGRdID0gU3RyaW5nKGtleSkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIHJldHVybiBuZXcgRGF0ZSh5LCBtIC0gMSwgZCk7CiAgfQoKICBmdW5jdGlvbiBhZGREYXlzKGtleSwgbikgewogICAgY29uc3QgZCA9IGZyb21LZXkoa2V5KT",
"sKICAgIGQuc2V0RGF0ZShkLmdldERhdGUoKSArIG4pOwogICAgcmV0dXJuIGRhdGVLZXkoZCk7CiAgfQoKICAvLyBXaG9sZSBkYXlzIGZyb20gYSB0byBiLiBSb3VuZGVkLCBiZWNhdXNlIGEgZGF5IHdpdGggYSBjbG9jayBjaGFuZ2UKICAvLyBpbiBpdCBpcyBhbiBob3VyIGxvbmdlciBvciBzaG9ydGVyIHRoYW4gMjQuCiAgZnVuY3Rpb24gZGF5c0JldHdlZW4oYSwgYikgewogICAgcmV0dXJuIE1hdGgucm91bmQoKGZyb21LZXkoYikgLSBmcm9tS2V5KGEpKSAvIDg2NDAwMDAwKTsKICB9CgogIC8vIDAgZm9yIE1vbmRheSDigKYgNiBmb3IgU3VuZGF5LgogIGZ1bmN0aW9uIHdlZWtkYXkoa2V5KSB7CiAgICByZXR1cm4gKGZyb21LZXkoa2V5KS5nZXREYXkoKSArIDYpICUgNzsKICB9CgogIGZ1bmN0aW9uIHdlZWtTdGFydChrZXkpIHsKICAgIHJldHVybiBhZGREYXlzKGtleSwgLXdlZWtkYXkoa2V5KSk7CiAgfQoKICAvLyBUaGUgSVNPIHdlZWs6IHRoZSBvbmUgd2l0aCB0aGUgeWVhcidzIGZpcnN0IFRodXJzZGF5IGluIGl0IGlzIHdlZWsgMS4KICBmdW5jdGlvbiBpc29XZWVrKGtleSkgewogICAgY29uc3QgdGh1cnNkYXkgPSBhZGREYXlzKHdlZWtTdGFydChrZXkpLCAzKTsKICAgIGNvbnN0IGZpcnN0VGh1cnNkYXkgPSBhZGREYXlzKHdlZWtTdGFydChgJHt0aHVyc2RheS5zbGljZSgwLCA0KX0tMDEtMDRgKSwgMyk7CiAgICByZXR1cm4gMSArIGRheXNCZXR3ZWVuKGZpcnN0VGh1cnNkYXksIHRodXJzZGF5KSAvID",
"c7CiAgfQoKICBmdW5jdGlvbiBtb250aFN0YXJ0KGtleSkgewogICAgcmV0dXJuIGAke1N0cmluZyhrZXkpLnNsaWNlKDAsIDcpfS0wMWA7CiAgfQoKICAvLyBUaGUgc2FtZSBkYXkgbiBtb250aHMgb24sIG9yIHRoZSBtb250aCdzIGxhc3QgZGF5IGlmIGl0IGlzIHNob3J0ZXIuCiAgZnVuY3Rpb24gYWRkTW9udGhzKGtleSwgbikgewogICAgY29uc3QgW3ksIG0sIGRdID0gU3RyaW5nKGtleSkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIGNvbnN0IGZpcnN0ID0gbmV3IERhdGUoeSwgbSAtIDEgKyBuLCAxKTsKICAgIGNvbnN0IGxhc3QgPSBuZXcgRGF0ZShmaXJzdC5nZXRGdWxsWWVhcigpLCBmaXJzdC5nZXRNb250aCgpICsgMSwgMCkuZ2V0RGF0ZSgpOwogICAgcmV0dXJuIGRhdGVLZXkobmV3IERhdGUoZmlyc3QuZ2V0RnVsbFllYXIoKSwgZmlyc3QuZ2V0TW9udGgoKSwgTWF0aC5taW4oZCwgbGFzdCkpKTsKICB9CgogIC8vIFRoZSBkYXlzIGZyb20gc3RhcnQgdXAgdG8sIG5vdCBpbmNsdWRpbmcsIGVuZC4KICBmdW5jdGlvbiBkYXlzKHN0YXJ0LCBlbmQpIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgZm9yIChsZXQgayA9IHN0YXJ0OyBrIDwgZW5kOyBrID0gYWRkRGF5cyhrLCAxKSkgb3V0LnB1c2goayk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g4pSA4pSAIFZpZXdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgO",
"KUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBWSUVXUyA9IFsnd2VlaycsICdtb250aCcsICdhZ2VuZGEnXTsKCiAgLy8gV2hhdCBhIHZpZXcgc2hvd3MgYXJvdW5kIHRoZSBkYXkgaW4gZm9jdXM6IHRoZSB3ZWVrIGl0IGlzIGluOyBpdHMKICAvLyBtb250aCwgYXMgd2hvbGUgd2Vla3M7IG9yLCBmb3IgdGhlIGFnZW5kYSwgZm91ciB3ZWVrcyBmcm9tIHRoYXQgZGF5LgogIC8vIGVuZCBpcyB0aGUgZGF5IGFmdGVyIHRoZSBsYXN0LgogIGZ1bmN0aW9uIHZpZXdSYW5nZSh2aWV3LCBhbmNob3IpIHsKICAgIGlmICh2aWV3ID09PSAnbW9udGgnKSB7CiAgICAgIGNvbnN0IGZpcnN0ID0gbW9udGhTdGFydChhbmNob3IpOwogICAgICBjb25zdCBsYXN0ID0gYWRkRGF5cyhhZGRNb250aHMoZmlyc3QsIDEpLCAtMSk7CiAgICAgIHJldHVybiB7IHN0YXJ0OiB3ZWVrU3RhcnQoZmlyc3QpLCBlbmQ6IGFkZERheXMod2Vla1N0YXJ0KGxhc3QpLCA3KSB9OwogICAgfQogICAgaWYgKHZpZXcgPT09ICdhZ2VuZGEnKSByZXR1cm4geyBzdGFydDogYW5jaG9yLCBlbmQ6IGFkZERheXMoYW5jaG9yLCBBR0VOREFfREFZUykgfTsKICAgIGNvbnN0IHN0YXJ0ID0gd2Vla1N0YXJ0KGFuY2hvcik7CiAgICByZXR1cm4geyBzdGFydCwgZW5kOiBhZGREYXlzKHN0YXJ0LCA3KSB9OwogIH0KCi",
"AgZnVuY3Rpb24gc3RlcCh2aWV3LCBhbmNob3IsIGRpcikgewogICAgaWYgKHZpZXcgPT09ICdtb250aCcpIHJldHVybiBhZGRNb250aHMoYW5jaG9yLCBkaXIpOwogICAgaWYgKHZpZXcgPT09ICdhZ2VuZGEnKSByZXR1cm4gYWRkRGF5cyhhbmNob3IsIGRpciAqIEFHRU5EQV9EQVlTKTsKICAgIHJldHVybiBhZGREYXlzKGFuY2hvciwgZGlyICogNyk7CiAgfQoKICAvLyBUaGUgbW9udGggYXMgcm93cyBvZiBzZXZlbiBkYXlzLCBmb3IgdGhlIHNtYWxsIGNhbGVuZGFyLgogIGZ1bmN0aW9uIG1vbnRoV2Vla3MoYW5jaG9yKSB7CiAgICBjb25zdCB7IHN0YXJ0LCBlbmQgfSA9IHZpZXdSYW5nZSgnbW9udGgnLCBhbmNob3IpOwogICAgY29uc3QgYWxsID0gZGF5cyhzdGFydCwgZW5kKTsKICAgIGNvbnN0IHJvd3MgPSBbXTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYWxsLmxlbmd0aDsgaSArPSA3KSByb3dzLnB1c2goYWxsLnNsaWNlKGksIGkgKyA3KSk7CiAgICByZXR1cm4gcm93czsKICB9CgogIC8vICIyOCBTZXAg4oCTIDQgT2N0IiwgIjUg4oCTIDExIE9jdCIsIHdpdGggdGhlIHllYXIgd2hlbiBpdCBpcyBub3QgdGhpcyBvbmUuCiAgZnVuY3Rpb24gc3BhblRleHQoZmlyc3QsIGxhc3QsIHRvZGF5KSB7CiAgICBjb25zdCBbeTEsIG0xLCBkMV0gPSBmaXJzdC5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgY29uc3QgW3kyLCBtMiwgZDJdID0gbGFzdC5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgY29uc3QgdG",
"hpc1llYXIgPSBOdW1iZXIoU3RyaW5nKHRvZGF5KS5zbGljZSgwLCA0KSk7CiAgICBjb25zdCB5ZWFyID0geSA9PiAoeSAhPT0gdGhpc1llYXIgPyBgICR7eX1gIDogJycpOwogICAgaWYgKGZpcnN0ID09PSBsYXN0KSByZXR1cm4gYCR7ZDF9ICR7TU9OVEhTW20xIC0gMV19JHt5ZWFyKHkxKX1gOwogICAgaWYgKHkxICE9PSB5MikgcmV0dXJuIGAke2QxfSAke01PTlRIU1ttMSAtIDFdfSAke3kxfSDigJMgJHtkMn0gJHtNT05USFNbbTIgLSAxXX0gJHt5Mn1gOwogICAgaWYgKG0xID09PSBtMikgcmV0dXJuIGAke2QxfSDigJMgJHtkMn0gJHtNT05USFNbbTIgLSAxXX0ke3llYXIoeTIpfWA7CiAgICByZXR1cm4gYCR7ZDF9ICR7TU9OVEhTW20xIC0gMV19IOKAkyAke2QyfSAke01PTlRIU1ttMiAtIDFdfSR7eWVhcih5Mil9YDsKICB9CgogIGZ1bmN0aW9uIHRpdGxlKHZpZXcsIGFuY2hvciwgdG9kYXkpIHsKICAgIGlmICh2aWV3ID09PSAnbW9udGgnKSB7CiAgICAgIGNvbnN0IFt5LCBtXSA9IGFuY2hvci5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgICByZXR1cm4gYCR7TU9OVEhTX0xPTkdbbSAtIDFdfSAke3l9YDsKICAgIH0KICAgIGNvbnN0IHsgc3RhcnQsIGVuZCB9ID0gdmlld1JhbmdlKHZpZXcsIGFuY2hvcik7CiAgICBjb25zdCBzcGFuID0gc3BhblRleHQoc3RhcnQsIGFkZERheXMoZW5kLCAtMSksIHRvZGF5KTsKICAgIHJldHVybiB2aWV3ID09PSAnd2VlaycgPyBgV2VlayAke2lzb1dlZWsoYW5jaG9yKX",
"0gwrcgJHtzcGFufWAgOiBzcGFuOwogIH0KCiAgZnVuY3Rpb24gbW9udGhOYW1lKGtleSkgewogICAgY29uc3QgW3ksIG1dID0ga2V5LnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4geyBsb25nOiBNT05USFNfTE9OR1ttIC0gMV0sIHNob3J0OiBNT05USFNbbSAtIDFdLCB5ZWFyOiB5IH07CiAgfQoKICBmdW5jdGlvbiBkYXlOYW1lKGtleSkgewogICAgcmV0dXJuIERBWV9OQU1FU1t3ZWVrZGF5KGtleSldOwogIH0KCiAgLy8g4pSA4pSAIFNvdXJjZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHNhZmVDb2xvdXIoYykgewogICAgcmV0dXJuIC9eI1swLTlhLWZdezZ9JC9pLnRlc3QoU3RyaW5nKGMgfHwgJycpKSA_IFN0cmluZyhjKS50b0xvd2VyQ2FzZSgpIDogJyc7CiAgfQoKICAvLyBPbmx5IHBsYWluIGh0dHBzIGxpbmtzIGFyZSBldmVyIHB1dCBvbiB0aGUgcGFnZS4KICBmdW5jdGlvbiBzYWZlTGluayh1cmwpIHsKICAgIHJldHVybiAvXmh0dHBzOlwvXC9bXlxzXSskL2kudGVzdChTdHJpbmcodXJsIHx8ICcnKSkgPyBTdHJpbmcodXJsKSA6ICcnOwogIH0KCiAgLy8gQSBjYWxlbmRhciBmcm9tIGNhbGVuZGFyTG",
"lzdC4gR29vZ2xlJ3Mgb3duICJzaG93IGluIHRoZSBsaXN0IiBjaG9pY2UKICAvLyAoc2VsZWN0ZWQpIGRlY2lkZXMgd2hldGhlciBpdCBpcyBvbiB1bnRpbCBzb21lb25lIHNheXMgb3RoZXJ3aXNlIGhlcmU7CiAgLy8gY2FsZW5kYXJzIGhpZGRlbiBmcm9tIEdvb2dsZSdzIGxpc3QgYXJlIGxlZnQgb3V0LiBUaGUgbWFpbiBjYWxlbmRhcgogIC8vIGlzIHVzdWFsbHkgbmFtZWQgYWZ0ZXIgdGhlIGFkZHJlc3MsIG9mIHdoaWNoIHRoZSBuYW1lIHBhcnQgd2lsbCBkby4KICBmdW5jdGlvbiBjYWxlbmRhclNvdXJjZShjKSB7CiAgICBpZiAoIWMgfHwgIWMuaWQgfHwgYy5oaWRkZW4pIHJldHVybiBudWxsOwogICAgbGV0IG5hbWUgPSBTdHJpbmcoYy5zdW1tYXJ5T3ZlcnJpZGUgfHwgYy5zdW1tYXJ5IHx8IGMuaWQpLnRyaW0oKTsKICAgIGlmIChjLnByaW1hcnkgJiYgbmFtZS5pbmNsdWRlcygnQCcpKSBuYW1lID0gbmFtZS5zcGxpdCgnQCcpWzBdOwogICAgcmV0dXJuIHsKICAgICAga2luZDogJ2NhbGVuZGFyJywgaWQ6IFN0cmluZyhjLmlkKSwgbmFtZSwKICAgICAgY29sb3VyOiBzYWZlQ29sb3VyKGMuYmFja2dyb3VuZENvbG9yKSB8fCAnIzFhNzNlOCcsCiAgICAgIHByaW1hcnk6ICEhYy5wcmltYXJ5LCBvbjogYy5zZWxlY3RlZCAhPT0gZmFsc2UsCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gbGlzdFNvdXJjZShsKSB7CiAgICBpZiAoIWwgfHwgIWwuaWQpIHJldHVybiBudWxsOwogICAgcmV0dXJuIHsga2luZDogJ3Rhc2",
"tzJywgaWQ6IFN0cmluZyhsLmlkKSwgbmFtZTogU3RyaW5nKGwudGl0bGUgfHwgJycpLnRyaW0oKSB8fCAnVGFza3MnLCBvbjogdHJ1ZSB9OwogIH0KCiAgLy8gVGhlIG1haW4gY2FsZW5kYXIgZmlyc3QsIHRoZW4gdGhlIHJlc3QgYXMgR29vZ2xlIGxpc3RzIHRoZW0sIHRoZW4KICAvLyB0aGUgdGFzayBsaXN0cy4KICBmdW5jdGlvbiBzb3VyY2VzKGNhbGVuZGFySXRlbXMsIGxpc3RJdGVtcykgewogICAgY29uc3QgY2FscyA9IChjYWxlbmRhckl0ZW1zIHx8IFtdKS5tYXAoY2FsZW5kYXJTb3VyY2UpLmZpbHRlcihCb29sZWFuKTsKICAgIGNhbHMuc29ydCgoYSwgYikgPT4gTnVtYmVyKGIucHJpbWFyeSkgLSBOdW1iZXIoYS5wcmltYXJ5KSk7CiAgICByZXR1cm4gY2Fscy5jb25jYXQoKGxpc3RJdGVtcyB8fCBbXSkubWFwKGxpc3RTb3VyY2UpLmZpbHRlcihCb29sZWFuKSk7CiAgfQoKICAvLyBUaGUgc3dpdGNoIHNvbWVvbmUgZmxpY2tlZCBoZXJlIHdpbnMgb3ZlciBHb29nbGUncyBkZWZhdWx0LgogIGZ1bmN0aW9uIGlzT24oc291cmNlLCBvdmVycmlkZXMpIHsKICAgIGNvbnN0IG8gPSBvdmVycmlkZXMgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG92ZXJyaWRlcywgc291cmNlLmlkKSA_IG92ZXJyaWRlc1tzb3VyY2UuaWRdIDogdW5kZWZpbmVkOwogICAgcmV0dXJuIHR5cGVvZiBvID09PSAnYm9vbGVhbicgPyBvIDogc291cmNlLm9uOwogIH0KCiAgLy8g4pSA4pSAIFJlcXVlc3RzIOKUgO",
"KUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBDQUxFTkRBUl9MSVNUX0ZJRUxEUyA9ICdpdGVtcyhpZCxzdW1tYXJ5LHN1bW1hcnlPdmVycmlkZSxiYWNrZ3JvdW5kQ29sb3Isc2VsZWN0ZWQsaGlkZGVuLHByaW1hcnksYWNjZXNzUm9sZSknOwogIGNvbnN0IEVWRU5UX0ZJRUxEUyA9ICdpdGVtcyhpZCxzdGF0dXMsc3VtbWFyeSxzdGFydCxlbmQsaHRtbExpbmssY29sb3JJZCxldmVudFR5cGUsbG9jYXRpb24pLG5leHRQYWdlVG9rZW4nOwoKICBmdW5jdGlvbiBzb3VyY2VSZXF1ZXN0cygpIHsKICAgIHJldHVybiBbCiAgICAgIFsnY2FsZW5kYXInLCAndXNlcnMvbWUvY2FsZW5kYXJMaXN0JywgeyBtaW5BY2Nlc3NSb2xlOiAncmVhZGVyJywgbWF4UmVzdWx0czogMjUwLCBmaWVsZHM6IENBTEVOREFSX0xJU1RfRklFTERTIH1dLAogICAgICBbJ3Rhc2tzJywgJ3VzZXJzL0BtZS9saXN0cycsIHsgbWF4UmVzdWx0czogMTAwIH1dLAogICAgXTsKICB9CgogIC8vIEZvciBlYWNoIGNhbGVuZGFyLCBpdHMgZXZlbnRzIGluIHRoZSByYW5nZSAoYSBkYXkgZWl0aGVyIHNpZGUsIGZvcgogIC8vIGNhbGVuZGFycyBpbiBhbm90aGVyIHRpbWUgem9uZTsgdGhlIGRheX",
"MgYXJlIHNvcnRlZCBvdXQgaGVyZSkuIEZvcgogIC8vIGVhY2ggdGFzayBsaXN0LCBpdHMgb3BlbiB0YXNrcyAtIGRhdGVkIG9yIG5vdCwgZm9yIHRoZSAiTm8gZGF0ZSIgdHJheQogIC8vIGFuZCBhbnl0aGluZyBvdmVyZHVlIC0gYW5kIHRoZSBvbmVzIGRvbmUgd2l0aGluIHRoZSByYW5nZS4gR29vZ2xlJ3MKICAvLyBvd24gYXBwcyBoaWRlIGEgdGFzayB3aGVuIGl0IGlzIHRpY2tlZCwgaGVuY2Ugc2hvd0hpZGRlbi4KICBmdW5jdGlvbiByYW5nZVJlcXVlc3RzKHJhbmdlLCBjYWxlbmRhcnMsIGxpc3RzKSB7CiAgICBjb25zdCBmcm9tID0gYWRkRGF5cyhyYW5nZS5zdGFydCwgLTEpOwogICAgY29uc3QgdG8gPSBhZGREYXlzKHJhbmdlLmVuZCwgMSk7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAoY29uc3QgYyBvZiBjYWxlbmRhcnMpIHsKICAgICAgb3V0LnB1c2goWydjYWxlbmRhcicsIGBjYWxlbmRhcnMvJHtlbmNvZGVVUklDb21wb25lbnQoYy5pZCl9L2V2ZW50c2AsIHsKICAgICAgICB0aW1lTWluOiBmcm9tS2V5KGZyb20pLnRvSVNPU3RyaW5nKCksIHRpbWVNYXg6IGZyb21LZXkodG8pLnRvSVNPU3RyaW5nKCksCiAgICAgICAgc2luZ2xlRXZlbnRzOiAndHJ1ZScsIG9yZGVyQnk6ICdzdGFydFRpbWUnLCBtYXhSZXN1bHRzOiAyNTAwLCBmaWVsZHM6IEVWRU5UX0ZJRUxEUywKICAgICAgfV0pOwogICAgfQogICAgZm9yIChjb25zdCBsIG9mIGxpc3RzKSB7CiAgICAgIGNvbnN0IHBhdGggPSBgbGlzdHMvJH",
"tlbmNvZGVVUklDb21wb25lbnQobC5pZCl9L3Rhc2tzYDsKICAgICAgb3V0LnB1c2goWyd0YXNrcycsIHBhdGgsIHsgc2hvd0NvbXBsZXRlZDogJ2ZhbHNlJywgbWF4UmVzdWx0czogMTAwIH1dKTsKICAgICAgb3V0LnB1c2goWyd0YXNrcycsIHBhdGgsIHsKICAgICAgICBzaG93Q29tcGxldGVkOiAndHJ1ZScsIHNob3dIaWRkZW46ICd0cnVlJywgbWF4UmVzdWx0czogMTAwLAogICAgICAgIGR1ZU1pbjogYCR7ZnJvbX1UMDA6MDA6MDAuMDAwWmAsIGR1ZU1heDogYCR7dG99VDAwOjAwOjAwLjAwMFpgLAogICAgICB9XSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g4pSA4pSAIEl0ZW1zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBHb29nbGUgQ2FsZW5kYXIncyBvd24gZXZlbnQgY29sb3VycywgYnkgY29sb3JJZC4KICBjb25zdCBFVkVOVF9DT0xPVVJTID0gewogICAgMTogJyM3OTg2Y2InLCAyOiAnIzMzYjY3OScsIDM6ICcjOGUyNGFhJywgNDogJyNlNjdjNzMnLCA1OiAnI2Y2YmYyNicsIDY6ICcjZjQ1MTFlJywKICAgIDc6ICcjMDM5YmU1JywgODogJyM2MTYxNjEnLCA5OiAnIzNmNTFiNScsIDEwOiAnIzBiODA0My",
"csIDExOiAnI2Q1MDAwMCcsCiAgfTsKCiAgLy8gQW4gZXZlbnQsIG9uIGV2ZXJ5IGRheSBpdCBjb3ZlcnMgKGZpcnN0IHRvIGxhc3QsIGJvdGggaW5jbHVkZWQpLgogIC8vIFdvcmtpbmctbG9jYXRpb24gZW50cmllcyAoIkhvbWUiLCAiT2ZmaWNlIikgYXJlIGxlZnQgb3V0OiB0aGV5IGFyZQogIC8vIG9uIGV2ZXJ5IGRheSBhbmQgc2F5IG5vdGhpbmcgYSBnbGFuY2UgbmVlZHMuCiAgZnVuY3Rpb24gZXZlbnRJdGVtKGV2LCBjYWwpIHsKICAgIGlmICghZXYgfHwgZXYuc3RhdHVzID09PSAnY2FuY2VsbGVkJyB8fCBldi5ldmVudFR5cGUgPT09ICd3b3JraW5nTG9jYXRpb24nKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHMgPSBldi5zdGFydCB8fCB7fTsKICAgIGNvbnN0IGUgPSBldi5lbmQgfHwge307CiAgICBjb25zdCBiYXNlID0gewogICAgICBraW5kOiAnZXZlbnQnLCBpZDogYCR7Y2FsLmlkfXwke2V2LmlkfWAsIHNvdXJjZTogY2FsLmlkLAogICAgICB0aXRsZTogU3RyaW5nKGV2LnN1bW1hcnkgfHwgJycpLnRyaW0oKSB8fCAnKE5vIHRpdGxlKScsCiAgICAgIGNvbG91cjogRVZFTlRfQ09MT1VSU1tldi5jb2xvcklkXSB8fCBjYWwuY29sb3VyLAogICAgICBsaW5rOiBzYWZlTGluayhldi5odG1sTGluayksIHdoZXJlOiBTdHJpbmcoZXYubG9jYXRpb24gfHwgJycpLnRyaW0oKSwKICAgIH07CiAgICBpZiAoaXNLZXkocy5kYXRlKSkgewogICAgICBjb25zdCBsYXN0ID0gaXNLZXkoZS5kYXRlKSA_IGFkZERheXMoZS",
"5kYXRlLCAtMSkgOiBzLmRhdGU7CiAgICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJhc2UsIHsgYWxsRGF5OiB0cnVlLCBmaXJzdDogcy5kYXRlLCBsYXN0OiBsYXN0IDwgcy5kYXRlID8gcy5kYXRlIDogbGFzdCwgc3RhcnQ6IDAsIGVuZDogMCB9KTsKICAgIH0KICAgIGNvbnN0IHN0YXJ0ID0gRGF0ZS5wYXJzZShzLmRhdGVUaW1lKTsKICAgIGlmICghaXNGaW5pdGUoc3RhcnQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGVuZE1zID0gRGF0ZS5wYXJzZShlLmRhdGVUaW1lKTsKICAgIGNvbnN0IGVuZCA9IGlzRmluaXRlKGVuZE1zKSAmJiBlbmRNcyA-IHN0YXJ0ID8gZW5kTXMgOiBzdGFydDsKICAgIC8vIEFuIGV2ZW50IGVuZGluZyBhdCBtaWRuaWdodCBkb2VzIG5vdCBzcGlsbCBpbnRvIHRoZSBuZXh0IGRheS4KICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJhc2UsIHsKICAgICAgYWxsRGF5OiBmYWxzZSwgc3RhcnQsIGVuZCwgZmlyc3Q6IGRhdGVLZXkoc3RhcnQpLCBsYXN0OiBkYXRlS2V5KE1hdGgubWF4KHN0YXJ0LCBlbmQgLSAxKSksCiAgICB9KTsKICB9CgogIC8vIEEgdGFzaywgb24gaXRzIGR1ZSBkYXkuIEdvb2dsZSBrZWVwcyBvbmx5IHRoZSBkYXRlIG9mIGEgZHVlIGRhdGUgKHRoZQogIC8vIHRpbWUgaXMgYWx3YXlzIG1pZG5pZ2h0IFVUQyksIHNvIHRoZSBkYXRlIGlzIHJlYWQgYXMgd3JpdHRlbiwgbm90CiAgLy8gbW92ZWQgaW50byB0aGUgbG9jYWwgdGltZSB6b25lLiBBIHRhc2sgbWFkZSBmcm9tIG",
"FuIGVtYWlsIGluIEdtYWlsCiAgLy8gbGlua3MgYmFjayB0byBpdC4KICBmdW5jdGlvbiB0YXNrSXRlbSh0LCBsaXN0KSB7CiAgICBpZiAoIXQgfHwgIXQuaWQgfHwgdC5kZWxldGVkKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHRpdGxlID0gU3RyaW5nKHQudGl0bGUgfHwgJycpLnRyaW0oKTsKICAgIGlmICghdGl0bGUpIHJldHVybiBudWxsOwogICAgY29uc3QgZHVlID0gL15cZHs0fS1cZHsyfS1cZHsyfS8udGVzdChTdHJpbmcodC5kdWUgfHwgJycpKSA_IFN0cmluZyh0LmR1ZSkuc2xpY2UoMCwgMTApIDogJyc7CiAgICBjb25zdCBtYWlsID0gKHQubGlua3MgfHwgW10pLmZpbmQobCA9PiBsICYmIGwudHlwZSA9PT0gJ2VtYWlsJyAmJiAvXmh0dHBzOlwvXC9tYWlsXC5nb29nbGVcLmNvbVwvLy50ZXN0KFN0cmluZyhsLmxpbmsgfHwgJycpKSk7CiAgICByZXR1cm4gewogICAgICBraW5kOiAndGFzaycsIGlkOiBgJHtsaXN0LmlkfXwke3QuaWR9YCwgc291cmNlOiBsaXN0LmlkLCB0aXRsZSwgZHVlLAogICAgICBkb25lOiB0LnN0YXR1cyA9PT0gJ2NvbXBsZXRlZCcsIGVtYWlsOiAhIW1haWwsCiAgICAgIGxpbms6IHNhZmVMaW5rKG1haWwgPyBtYWlsLmxpbmsgOiB0LndlYlZpZXdMaW5rKSwgbGlzdDogbGlzdC5uYW1lLAogICAgfTsKICB9CgogIC8vIFRhc2tzIGFycml2ZSB0d2ljZSB3aGVuIG9uZSBpcyBib3RoIG9wZW4gYW5kIGR1ZSBpbiB0aGUgcmFuZ2UuCiAgZnVuY3Rpb24gdW5pcXVlQnlJZChpdGVtcykgew",
"ogICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoKTsKICAgIHJldHVybiBpdGVtcy5maWx0ZXIoeCA9PiAhc2Vlbi5oYXMoeC5pZCkgJiYgc2Vlbi5hZGQoeC5pZCkpOwogIH0KCiAgLy8gQWxsLWRheSBmaXJzdCwgdGhlbiBieSB0aW1lLCB0aGVuIHRoZSB0YXNrczogb3BlbiBiZWZvcmUgZG9uZS4KICBmdW5jdGlvbiBjb21wYXJlSXRlbXMoYSwgYikgewogICAgY29uc3QgcmFuayA9IHggPT4gKHgua2luZCA9PT0gJ2V2ZW50JyA_ICh4LmFsbERheSA_IDAgOiAxKSA6ICh4LmRvbmUgPyAzIDogMikpOwogICAgcmV0dXJuIHJhbmsoYSkgLSByYW5rKGIpIHx8IChhLnN0YXJ0IHx8IDApIC0gKGIuc3RhcnQgfHwgMCkgfHwgYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpOwogIH0KCiAgLy8gRGF5IGtleSDihpIgd2hhdCBpcyBvbiBpdCwgZWFjaCBlbnRyeSB7IGl0ZW0sIGNvbnQgfTogY29udCB3aGVuIGEKICAvLyB0aW1lZCBldmVudCBzdGFydGVkIG9uIGFuIGVhcmxpZXIgZGF5LgogIGZ1bmN0aW9uIGJ5RGF5KGl0ZW1zLCBkYXlLZXlzKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgTWFwKGRheUtleXMubWFwKGsgPT4gW2ssIFtdXSkpOwogICAgaWYgKCFkYXlLZXlzLmxlbmd0aCkgcmV0dXJuIG91dDsKICAgIGNvbnN0IGZpcnN0ID0gZGF5S2V5c1swXTsKICAgIGNvbnN0IGxhc3QgPSBkYXlLZXlzW2RheUtleXMubGVuZ3RoIC0gMV07CiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHsKICAgICAgaWYgKGl0ZW0ua2",
"luZCA9PT0gJ3Rhc2snKSB7CiAgICAgICAgaWYgKGl0ZW0uZHVlICYmIG91dC5oYXMoaXRlbS5kdWUpKSBvdXQuZ2V0KGl0ZW0uZHVlKS5wdXNoKHsgaXRlbSwgY29udDogZmFsc2UgfSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKGl0ZW0ubGFzdCA8IGZpcnN0IHx8IGl0ZW0uZmlyc3QgPiBsYXN0KSBjb250aW51ZTsKICAgICAgY29uc3QgZnJvbSA9IGl0ZW0uZmlyc3QgPCBmaXJzdCA_IGZpcnN0IDogaXRlbS5maXJzdDsKICAgICAgY29uc3QgdG8gPSBpdGVtLmxhc3QgPiBsYXN0ID8gbGFzdCA6IGl0ZW0ubGFzdDsKICAgICAgZm9yIChsZXQgayA9IGZyb207IGsgPD0gdG87IGsgPSBhZGREYXlzKGssIDEpKSB7CiAgICAgICAgaWYgKG91dC5oYXMoaykpIG91dC5nZXQoaykucHVzaCh7IGl0ZW0sIGNvbnQ6IGsgIT09IGl0ZW0uZmlyc3QgfSk7CiAgICAgIH0KICAgIH0KICAgIGZvciAoY29uc3QgbGlzdCBvZiBvdXQudmFsdWVzKCkpIGxpc3Quc29ydCgoYSwgYikgPT4gY29tcGFyZUl0ZW1zKGEuaXRlbSwgYi5pdGVtKSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gV2hhdCB3YWl0cyB1bmRlciB0aGUgd2Vlazogb3BlbiB0YXNrcyB3aXRoIG5vIGRhdGUsIGFuZCBvcGVuIHRhc2tzCiAgLy8gd2hvc2UgZGF5IGhhcyBnb25lIGJ5LgogIGZ1bmN0aW9uIHRyYXkoaXRlbXMsIHRvZGF5KSB7CiAgICBjb25zdCBvcGVuID0gaXRlbXMuZmlsdGVyKHggPT4geC5raW5kID09PSAndGFzaycgJiYgIX",
"guZG9uZSk7CiAgICByZXR1cm4gewogICAgICBvdmVyZHVlOiBvcGVuLmZpbHRlcih4ID0-IHguZHVlICYmIHguZHVlIDwgdG9kYXkpLnNvcnQoKGEsIGIpID0-IGEuZHVlLmxvY2FsZUNvbXBhcmUoYi5kdWUpIHx8IGEudGl0bGUubG9jYWxlQ29tcGFyZShiLnRpdGxlKSksCiAgICAgIHVuZGF0ZWQ6IG9wZW4uZmlsdGVyKHggPT4gIXguZHVlKSwKICAgIH07CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBTQ09QRVMsIEJBU0VTLCBVU0VSSU5GT19VUkwsIFZJRVdTLCBBR0VOREFfREFZUywgREFZX05BTUVTLCBNT05USFMsIE1PTlRIU19MT05HLCBFVkVOVF9DT0xPVVJTLAogICAgaXNBbGxvd2VkUmVxdWVzdCwgYnVpbGRVcmwsCiAgICBkYXRlS2V5LCBpc0tleSwgZnJvbUtleSwgYWRkRGF5cywgZGF5c0JldHdlZW4sIHdlZWtkYXksIHdlZWtTdGFydCwgaXNvV2VlaywgbW9udGhTdGFydCwgYWRkTW9udGhzLCBkYXlzLAogICAgdmlld1JhbmdlLCBzdGVwLCBtb250aFdlZWtzLCBzcGFuVGV4dCwgdGl0bGUsIG1vbnRoTmFtZSwgZGF5TmFtZSwKICAgIHNhZmVDb2xvdXIsIHNhZmVMaW5rLCBjYWxlbmRhclNvdXJjZSwgbGlzdFNvdXJjZSwgc291cmNlcywgaXNPbiwKICAgIHNvdXJjZVJlcXVlc3RzLCByYW5nZVJlcXVlc3RzLCBldmVudEl0ZW0sIHRhc2tJdGVtLCB1bmlxdWVCeUlkLCBjb21wYXJlSXRlbXMsIGJ5RGF5LCB0cmF5LAogIH07CgogIG5zLmNhbGVuZGFyTG9naWMgPSBhcGk7CiAgaWYgKHR5cGVvZiBtb2R1bG",
"UgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKfSkoKTsK\"],[\"src/content/ui.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIERPTSB0b29sa2l0IGZvciB0aGUgaW5qZWN0ZWQgVUkKLy8KLy8gR21haWwgZW5mb3JjZXMgVHJ1c3RlZCBUeXBlcyBvbiBpdHMgcGFnZSwgdW5kZXIgd2hpY2ggaW5uZXJIVE1MIGFuZAovLyBmcmllbmRzIHRocm93LiBDaHJvbWl1bSBjdXJyZW50bHkgZXhlbXB0cyBhIGNvbnRlbnQgc2NyaXB0J3MgaXNvbGF0ZWQKLy8gd29ybGQgZnJvbSB0aGF0IHBvbGljeSwgYnV0IG5vdGhpbmcgcHJvbWlzZXMgaXQgYWx3YXlzIHdpbGwgLSBhbmQgbWFpbAovLyBzdWJqZWN0cyBhcmUgdW50cnVzdGVkIHRleHQgcmVnYXJkbGVzcy4gU28gZXZlcnkgbm9kZSBoZXJlIGlzIGJ1aWx0Ci8vIHdpdGggY3JlYXRlRWxlbWVudCAvIGNyZWF0ZUVsZW1lbnROUyBhbmQgZmlsbGVkIHdpdGggdGV4dENvbnRlbnQuIEFsbAovLyBvZiBpdCBsaXZlcyBpbiBzaGFkb3cgcm9vdHMgc28gR21haWwncyBzdHlsZXNoZWV0IGFuZCBvd",
"XJzIG5ldmVyIG1lZXQuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgRWxlbWVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFByb3BlcnRpZXMgdGhhdCBtdXN0IGJlIHNldCBhcyBwcm9wZXJ0aWVzLCBub3QgYXR0cmlidXRlcywgdG8gdGFrZQogIC8vIGVmZmVjdCBhZnRlciBmaXJzdCByZW5kZXIgKGFuIGlucHV0J3MgdmFsdWUsIGEgY2hlY2tib3gncyBzdGF0ZSkuCiAgY29uc3QgUFJPUFMgPSBuZXcgU2V0KFsndmFsdWUnLCAnY2hlY2tlZCcsICdkaXNhYmxlZCcsICdoaWRkZW4nXSk7CgogIGZ1bmN0aW9uIGgodGFnLCBwcm9wcywgLi4ua",
"2lkcykgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7CiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhwcm9wcyB8fCB7fSkpIHsKICAgICAgaWYgKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsIHx8IHYgPT09IGZhbHNlKSBjb250aW51ZTsKICAgICAgaWYgKGsgPT09ICdjbGFzcycpIGVsLmNsYXNzTmFtZSA9IEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcihCb29sZWFuKS5qb2luKCcgJykgOiB2OwogICAgICBlbHNlIGlmIChrID09PSAndGV4dCcpIGVsLnRleHRDb250ZW50ID0gU3RyaW5nKHYpOwogICAgICBlbHNlIGlmIChrID09PSAnZGF0YXNldCcpIE9iamVjdC5hc3NpZ24oZWwuZGF0YXNldCwgdik7CiAgICAgIGVsc2UgaWYgKGsuc3RhcnRzV2l0aCgnb24nKSAmJiB0eXBlb2YgdiA9PT0gJ2Z1bmN0aW9uJykgZWwuYWRkRXZlbnRMaXN0ZW5lcihrLnNsaWNlKDIpLCB2KTsKICAgICAgZWxzZSBpZiAoUFJPUFMuaGFzKGspKSBlbFtrXSA9IHY7CiAgICAgIGVsc2UgZWwuc2V0QXR0cmlidXRlKGssIHYgPT09IHRydWUgPyAnJyA6IFN0cmluZyh2KSk7CiAgICB9CiAgICBhcHBlbmQoZWwsIGtpZHMpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgZnVuY3Rpb24gYXBwZW5kKGVsLCBraWRzKSB7CiAgICBmb3IgKGNvbnN0IGtpZCBvZiBraWRzLmZsYXQoSW5maW5pdHkpKSB7CiAgICAgIGlmIChraWQgPT09IG51bGwgfHwga2lkID09PSB1bmRlZmluZWQgf",
"Hwga2lkID09PSBmYWxzZSkgY29udGludWU7CiAgICAgIGVsLmFwcGVuZENoaWxkKHR5cGVvZiBraWQgPT09ICdzdHJpbmcnIHx8IHR5cGVvZiBraWQgPT09ICdudW1iZXInCiAgICAgICAgPyBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShTdHJpbmcoa2lkKSkgOiBraWQpOwogICAgfQogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIEljb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTWF0ZXJpYWwgU3ltYm9scyBwYXRocyAoQXBhY2hlIDIuMCksIHBsdXMgdGhlIGJvYXJkIGdseXBoIGRyYXduIHRvCiAgLy8gbWF0Y2ggdGhlIHRvb2xiYXIgaWNvbi4KCiAgY29uc3QgYmFyID0gKHgsIHksIHcsIGh0KSA9PgogICAgYE0ke3ggKyAxfSAke3l9aCR7dyAtIDJ9YTEgMSAwIDAgMSAxIDF2JHtodCAtIDJ9YTEgMSAwIDAgMS0xIDFoLSR7dyAtIDJ9YTEgMSAwIDAgMS0xLTF2LSR7aHQgLSAyfWExIDEgMCAwIDEgMS0xemA7CgogIGNvbnN0IElDT05TID0gewogICAgYm9hcmQ6IGJhcigzLCA0LCA1LCAxNikgKyBiYXIoOS41LCA0LCA1LCAxMCkgKyBiYXIoMTYsIDQsIDUsIDEzKSwKICAgIGNsb3NlOiAnTTE5IDYuNDEgMTcuN",
"TkgNSAxMiAxMC41OSA2LjQxIDUgNSA2LjQxIDEwLjU5IDEyIDUgMTcuNTkgNi40MSAxOSAxMiAxMy40MSAxNy41OSAxOSAxOSAxNy41OSAxMy40MSAxMnonLAogICAgcmVmcmVzaDogJ00xNy42NSA2LjM1QTcuOTYgNy45NiAwIDAgMCAxMiA0YTggOCAwIDEgMCA3LjczIDEwaC0yLjA4QTYgNiAwIDEgMSAxMiA2YzEuNjYgMCAzLjE0LjY5IDQuMjIgMS43OEwxMyAxMWg3VjRsLTIuMzUgMi4zNXonLAogICAgYWRkOiAnTTE5IDEzaC02djZoLTJ2LTZINXYtMmg2VjVoMnY2aDZ2MnonLAogICAgbW9yZTogJ002IDEwYTIgMiAwIDEgMCAwIDQgMiAyIDAgMCAwIDAtNHptMTIgMGEyIDIgMCAxIDAgMCA0IDIgMiAwIDAgMCAwLTR6bS02IDBhMiAyIDAgMSAwIDAgNCAyIDIgMCAwIDAgMC00eicsCiAgICBzdGFyOiAnTTEyIDE3LjI3IDE4LjE4IDIxbC0xLjY0LTcuMDNMMjIgOS4yNGwtNy4xOS0uNjFMMTIgMiA5LjE5IDguNjMgMiA5LjI0bDUuNDYgNC43M0w1LjgyIDIxeicsCiAgICB0dW5lOiAnTTMgMTd2Mmg2di0ySDN6TTMgNXYyaDEwVjVIM3ptMTAgMTZ2LTJoOHYtMmgtOHYtMmgtMnY2aDJ6TTcgOXYySDN2Mmg0djJoMlY5SDd6bTE0IDR2LTJIMTF2MmgxMHptLTYtNGgyVjdoNFY1aC00VjNoLTJ2NnonLAogICAgdXA6ICdNNCAxMmwxLjQxIDEuNDFMMTEgNy44M1YyMGgyVjcuODNsNS41OCA1LjU5TDIwIDEybC04LTgtOCA4eicsCiAgICBkb3duOiAnTTIwIDEybC0xLjQxLTEuNDFMMTMgMTYuMTdWNGgtMnYxMi4xN2wtNS41O",
"C01LjU5TDQgMTJsOCA4IDgtOHonLAogICAgc2VhcmNoOiAnTTE1LjUgMTRoLS43OWwtLjI4LS4yN0E2LjQ3IDYuNDcgMCAwIDAgMTYgOS41IDYuNSA2LjUgMCAxIDAgOS41IDE2YzEuNjEgMCAzLjA5LS41OSA0LjIzLTEuNTdsLjI3LjI4di43OWw1IDQuOTlMMjAuNDkgMTlsLTQuOTktNXptLTYgMEM3LjAxIDE0IDUgMTEuOTkgNSA5LjVTNy4wMSA1IDkuNSA1IDE0IDcuMDEgMTQgOS41IDExLjk5IDE0IDkuNSAxNHonLAogICAgY2hlY2s6ICdNOSAxNi4xNyA0LjgzIDEybC0xLjQyIDEuNDFMOSAxOSAyMSA3bC0xLjQxLTEuNDF6JywKICAgIGNhcmV0OiAnTTcgMTBsNSA1IDUtNXonLAogICAgb3BlbjogJ00xOSAxOUg1VjVoN1YzSDVhMiAyIDAgMCAwLTIgMnYxNGEyIDIgMCAwIDAgMiAyaDE0YzEuMSAwIDItLjkgMi0ydi03aC0ydjd6TTE0IDN2MmgzLjU5bC05LjgzIDkuODMgMS40MSAxLjQxTDE5IDYuNDFWMTBoMlYzaC03eicsCiAgICBjYWxlbmRhcjogJ00yMCAzaC0xVjFoLTJ2Mkg3VjFINXYySDRjLTEuMSAwLTIgLjktMiAydjE2YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNWMwLTEuMS0uOS0yLTItMnptMCAxOEg0VjEwaDE2djExem0wLTEzSDRWNWgxNnYzeicsCiAgICBwcmV2OiAnTTE1LjQxIDcuNDEgMTQgNmwtNiA2IDYgNiAxLjQxLTEuNDFMMTAuODMgMTJ6JywKICAgIGNvbHVtbnM6ICdNMTAgMThoNVY1aC01djEzem0tNiAwaDVWNUg0djEzek0xNiA1djEzaDVWNWgtNXonLAogICAgcm93czogJ",
"00yMSA4SDNWNGgxOHY0em0wIDJIM3Y0aDE4di00em0wIDZIM3Y0aDE4di00eicsCiAgICBuZXh0OiAnTTEwIDYgOC41OSA3LjQxIDEzLjE3IDEybC00LjU4IDQuNTlMMTAgMThsNi02eicsCiAgICBtYWlsOiAnTTIwIDRINGMtMS4xIDAtMS45OS45LTEuOTkgMkwyIDE4YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNmMwLTEuMS0uOS0yLTItMnptMCA0LTggNS04LTVWNmw4IDUgOC01djJ6JywKICAgIGJhY2s6ICdNMjAgMTFINy44M2w1LjU5LTUuNTlMMTIgNGwtOCA4IDggOCAxLjQxLTEuNDFMNy44MyAxM0gyMHYtMnonLAogICAgYXJyb3c6ICdNMTIgNGwtMS40MSAxLjQxTDE2LjE3IDExSDR2MmgxMi4xN2wtNS41OCA1LjU5TDEyIDIwbDgtOHonLAogICAgcmVtb3ZlOiAnTTE5IDEzSDV2LTJoMTR2MnonLAogICAgbm90ZTogJ00xNCAySDZjLTEuMSAwLTEuOTkuOS0xLjk5IDJMNCAyMGMwIDEuMS44OSAyIDEuOTkgMkgxOGMxLjEgMCAyLS45IDItMlY4bC02LTZ6bTIgMTZIOHYtMmg4djJ6bTAtNEg4di0yaDh2MnptLTMtNVYzLjVMMTguNSA5SDEzeicsCiAgICBkZWxldGU6ICdNNiAxOWMwIDEuMS45IDIgMiAyaDhjMS4xIDAgMi0uOSAyLTJWN0g2djEyek0xOSA0aC0zLjVsLTEtMWgtNWwtMSAxSDV2MmgxNFY0eicsCiAgICBlZGl0OiAnTTMgMTcuMjVWMjFoMy43NUwxNy44MSA5Ljk0bC0zLjc1LTMuNzVMMyAxNy4yNXpNMjAuNzEgNy4wNGExIDEgMCAwIDAgMC0xLjQxbC0yLjM0LTIuMzRhMSAxIDAgMCAwL",
"TEuNDEgMGwtMS44MyAxLjgzIDMuNzUgMy43NSAxLjgzLTEuODN6JywKICAgIGZvbGRlcjogJ00xMCA0SDRjLTEuMSAwLTEuOTkuOS0xLjk5IDJMMiAxOGMwIDEuMS45IDIgMiAyaDE2YzEuMSAwIDItLjkgMi0yVjhjMC0xLjEtLjktMi0yLTJoLThsLTItMnonLAogICAgbm90ZXM6ICdNMyAxOGgxMnYtMkgzdjJ6TTMgNnYyaDE4VjZIM3ptMCA3aDE4di0ySDN2MnonLAogICAgLy8gRm9ybWF0dGluZyB0b29sYmFyLgogICAgYm9sZDogJ00xNS42IDEwLjc5Yy45Ny0uNjcgMS42NS0xLjc3IDEuNjUtMi43OSAwLTIuMjYtMS43NS00LTQtNEg3djE0aDcuMDRjMi4wOSAwIDMuNzEtMS43IDMuNzEtMy43OSAwLTEuNTItLjg2LTIuODItMi4xNS0zLjQyek0xMCA2LjVoM2MuODMgMCAxLjUuNjcgMS41IDEuNXMtLjY3IDEuNS0xLjUgMS41aC0zdi0zem0zLjUgOUgxMHYtM2gzLjVjLjgzIDAgMS41LjY3IDEuNSAxLjVzLS42NyAxLjUtMS41IDEuNXonLAogICAgaXRhbGljOiAnTTEwIDR2M2gyLjIxbC0zLjQyIDhINnYzaDh2LTNoLTIuMjFsMy40Mi04SDE4VjR6JywKICAgIHN0cmlrZTogJ00xMCAxOWg0di0zaC00djN6TTUgNHYzaDV2M2g0VjdoNVY0SDV6TTMgMTRoMTh2LTJIM3YyeicsCiAgICBidWxsZXRzOiAnTTQgMTAuNWMtLjgzIDAtMS41LjY3LTEuNSAxLjVzLjY3IDEuNSAxLjUgMS41IDEuNS0uNjcgMS41LTEuNS0uNjctMS41LTEuNS0xLjV6bTAtNmMtLjgzIDAtMS41LjY3LTEuNSAxLjVTMy4xNyA3LjUgNCA3LjUgNS41I",
"DYuODMgNS41IDYgNC44MyA0LjUgNCA0LjV6bTAgMTJjLS44MyAwLTEuNS42OC0xLjUgMS41cy42OCAxLjUgMS41IDEuNSAxLjUtLjY4IDEuNS0xLjUtLjY3LTEuNS0xLjUtMS41ek03IDE5aDE0di0ySDd2MnptMC02aDE0di0ySDd2MnptMC04djJoMTRWNUg3eicsCiAgICBudW1iZXJzOiAnTTIgMTdoMnYuNUgzdjFoMXYuNUgydjFoM3YtNEgydjF6bTEtOWgxVjRIMnYxaDF2M3ptLTEgM2gxLjhMMiAxMy4xdi45aDN2LTFIMy4yTDUgMTAuOVYxMEgydjF6bTUtNnYyaDE0VjVIN3ptMCAxNGgxNHYtMkg3djJ6bTAtNmgxNHYtMkg3djJ6JywKICAgIGNoZWNrbGlzdDogJ00yMiA3aC05djJoOVY3em0wIDhoLTl2Mmg5di0yek01LjU0IDExIDIgNy40NmwxLjQxLTEuNDEgMi4xMiAyLjEyIDQuMjQtNC4yNCAxLjQxIDEuNDFMNS41NCAxMXptMCA4TDIgMTUuNDZsMS40MS0xLjQxIDIuMTIgMi4xMiA0LjI0LTQuMjQgMS40MSAxLjQxTDUuNTQgMTl6JywKICAgIGluZGVudDogJ00zIDIxaDE4di0ySDN2MnpNMyA4djhsNC00LTQtNHptOCA5aDEwdi0ySDExdjJ6TTMgM3YyaDE4VjNIM3ptOCA2aDEwVjdIMTF2MnptMCA0aDEwdi0ySDExdjJ6JywKICAgIG91dGRlbnQ6ICdNMTEgMTdoMTB2LTJIMTF2MnptLTgtNSA0IDRWOGwtNCA0em0wIDloMTh2LTJIM3Yyek0zIDN2MmgxOFYzSDN6bTggNmgxMFY3SDExdjJ6bTAgNGgxMHYtMkgxMXYyeicsCiAgICBsaW5rOiAnTTMuOSAxMmMwLTEuNzEgMS4zOS0zLjEgMy4xLTMuMWg0VjdIN2MtM",
"i43NiAwLTUgMi4yNC01IDVzMi4yNCA1IDUgNWg0di0xLjlIN2MtMS43MSAwLTMuMS0xLjM5LTMuMS0zLjF6TTggMTNoOHYtMkg4djJ6bTktNmgtNHYxLjloNGMxLjcxIDAgMy4xIDEuMzkgMy4xIDMuMXMtMS4zOSAzLjEtMy4xIDMuMWgtNFYxN2g0YzIuNzYgMCA1LTIuMjQgNS01cy0yLjI0LTUtNS01eicsCiAgICBjbGVhcjogJ00zLjI3IDUgMiA2LjI3bDYuOTcgNi45N0w2LjUgMTloM2wxLjU3LTMuNjZMMTYuNzMgMjEgMTggMTkuNzMgMy41NSA1LjI3IDMuMjcgNXpNNiA1di4xOEw4LjgyIDhoMi40bC0uNzIgMS42OCAyLjEgMi4xTDE0LjIxIDhIMjBWNUg2eicsCiAgfTsKCiAgY29uc3QgU1ZHX05TID0gJ2h0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnJzsKCiAgZnVuY3Rpb24gaWNvbihuYW1lLCBzaXplID0gMjApIHsKICAgIGNvbnN0IHN2ZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhTVkdfTlMsICdzdmcnKTsKICAgIHN2Zy5zZXRBdHRyaWJ1dGUoJ3ZpZXdCb3gnLCAnMCAwIDI0IDI0Jyk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCd3aWR0aCcsIFN0cmluZyhzaXplKSk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCdoZWlnaHQnLCBTdHJpbmcoc2l6ZSkpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnYXJpYS1oaWRkZW4nLCAndHJ1ZScpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnZm9jdXNhYmxlJywgJ2ZhbHNlJyk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCdjbGFzcycsICdpY29uJyk7CiAgICBjb25zdCBwYXRoID0gZ",
"G9jdW1lbnQuY3JlYXRlRWxlbWVudE5TKFNWR19OUywgJ3BhdGgnKTsKICAgIHBhdGguc2V0QXR0cmlidXRlKCdkJywgSUNPTlNbbmFtZV0gfHwgJycpOwogICAgcGF0aC5zZXRBdHRyaWJ1dGUoJ2ZpbGwnLCAnY3VycmVudENvbG9yJyk7CiAgICBzdmcuYXBwZW5kQ2hpbGQocGF0aCk7CiAgICByZXR1cm4gc3ZnOwogIH0KCiAgLy8gVGhlIGFwcCdzIG1hcms6ICJNZCIgb24gYSB2aW9sZXQgY2lyY2xlLCBhcyBpY29ucy9pY29uLnN2ZyBkcmF3cwogIC8vIGl0IChhIHRlc3Qga2VlcHMgdGhlIHR3byB0aGUgc2FtZSkuCiAgY29uc3QgTE9HTyA9IHsKICAgIGNvbG91cnM6IFsnIzZEMjhEOScsICcjOUY2N0ZBJ10sCiAgICBsZXR0ZXJzOiAnTTYxLjQ1IDg5VjYwLjkzUTYxLjQ1IDU5Ljk4IDYxLjQ3IDU5LjAyUTYxLjQ5IDU4LjA3IDYxLjc4IDUwLjg0UTU5LjQ1IDU5LjY4IDU4LjMzIDYzLjE3TDQ5Ljk4IDg5SDQzLjA4TDM0LjczIDYzLjE3TDMxLjIyIDUwLjg0UTMxLjYxIDU4LjQ3IDMxLjYxIDYwLjkzVjg5SDIzVjQyLjY5SDM1Ljk4TDQ0LjI3IDY4LjU5TDQ0Ljk5IDcxLjA5TDQ2LjU3IDc3LjNMNDguNjQgNjkuODdMNTcuMTUgNDIuNjlINzAuMDdWODlaIE05Ny41OCA5MFE5Ny40NyA4OS41OSA5Ny4zMiA4Ny45NFE5Ny4xNyA4Ni4yOSA5Ny4xNyA4NS4ySDk3LjA3UTk0LjU4IDkwLjU0IDg3LjYzIDkwLjU0UTgyLjQ4IDkwLjU0IDc5LjY3IDg2LjUyUTc2Ljg2IDgyLjUgNzYuODYgNzUuMjdRNzYuODYgNjcuOTQgNzkuO",
"DIgNjMuOTRRODIuNzggNTkuOTUgODguMiA1OS45NVE5MS4zNCA1OS45NSA5My42MiA2MS4yNlE5NS44OSA2Mi41NyA5Ny4xMiA2NS4xNkg5Ny4xN0w5Ny4xMiA2MC4zVjQ5LjUzSDEwNC43OFY4My41NlExMDQuNzggODYuMjkgMTA1IDkwWk05Ny4yMyA3NS4wOFE5Ny4yMyA3MC4zMSA5NS42MyA2Ny43M1E5NC4wNCA2NS4xNiA5MC45MyA2NS4xNlE4Ny44NSA2NS4xNiA4Ni4zNSA2Ny42NVE4NC44NSA3MC4xNSA4NC44NSA3NS4yN1E4NC44NSA4NS4zMSA5MC44OCA4NS4zMVE5My45IDg1LjMxIDk1LjU3IDgyLjY1UTk3LjIzIDc5Ljk5IDk3LjIzIDc1LjA4WicsCiAgfTsKICBsZXQgbG9nb0NvdW50ID0gMDsKCiAgZnVuY3Rpb24gbG9nbyhzaXplID0gMjgpIHsKICAgIGNvbnN0IGVsID0gKHRhZywgYXR0cnMpID0-IHsKICAgICAgY29uc3QgbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhTVkdfTlMsIHRhZyk7CiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGF0dHJzKSkgbi5zZXRBdHRyaWJ1dGUoaywgdik7CiAgICAgIHJldHVybiBuOwogICAgfTsKICAgIC8vIEVhY2ggY29weSBpdHMgb3duIGdyYWRpZW50IGlkOiB0d28gbWFya3MgaW4gb25lIHBhZ2UgbXVzdCBub3Qgc2hhcmUuCiAgICBjb25zdCBpZCA9IGBna2ItbG9nby0keysrbG9nb0NvdW50fWA7CiAgICBjb25zdCBncmFkID0gZWwoJ2xpbmVhckdyYWRpZW50JywgeyBpZCwgeDE6ICcwJywgeTE6ICcwJywgeDI6ICcxJywgeTI6I",
"CcxJyB9KTsKICAgIGdyYWQuYXBwZW5kKGVsKCdzdG9wJywgeyBvZmZzZXQ6ICcwJywgJ3N0b3AtY29sb3InOiBMT0dPLmNvbG91cnNbMF0gfSksIGVsKCdzdG9wJywgeyBvZmZzZXQ6ICcxJywgJ3N0b3AtY29sb3InOiBMT0dPLmNvbG91cnNbMV0gfSkpOwogICAgY29uc3QgZGVmcyA9IGVsKCdkZWZzJywge30pOwogICAgZGVmcy5hcHBlbmQoZ3JhZCk7CiAgICBjb25zdCBzdmcgPSBlbCgnc3ZnJywgeyB2aWV3Qm94OiAnOCA4IDExMiAxMTInLCB3aWR0aDogU3RyaW5nKHNpemUpLCBoZWlnaHQ6IFN0cmluZyhzaXplKSwgJ2FyaWEtaGlkZGVuJzogJ3RydWUnLCBmb2N1c2FibGU6ICdmYWxzZScsIGNsYXNzOiAnbG9nby1tYXJrJyB9KTsKICAgIHN2Zy5hcHBlbmQoZGVmcywgZWwoJ2NpcmNsZScsIHsgY3g6ICc2NCcsIGN5OiAnNjQnLCByOiAnNTYnLCBmaWxsOiBgdXJsKCMke2lkfSlgIH0pLCBlbCgncGF0aCcsIHsgZDogTE9HTy5sZXR0ZXJzLCBmaWxsOiAnI2ZmZicgfSkpOwogICAgcmV0dXJuIHN2ZzsKICB9CgogIC8vIOKUgOKUgCBTaGFkb3cgaG9zdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGFkb3B0U3R5bGVzKHJvb3QsIGNzc1RleHQpIHsKICAgI",
"HRyeSB7CiAgICAgIGNvbnN0IHNoZWV0ID0gbmV3IENTU1N0eWxlU2hlZXQoKTsKICAgICAgc2hlZXQucmVwbGFjZVN5bmMoY3NzVGV4dCk7CiAgICAgIHJvb3QuYWRvcHRlZFN0eWxlU2hlZXRzID0gW3NoZWV0XTsKICAgICAgcmV0dXJuOwogICAgfSBjYXRjaCB7IC8qIG9sZGVyIGVuZ2luZSBvciBhIGhvc3RpbGUgQ1NQOiBmYWxsIHRocm91Z2ggKi8gfQogICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpOwogICAgc3R5bGUudGV4dENvbnRlbnQgPSBjc3NUZXh0OwogICAgcm9vdC5hcHBlbmRDaGlsZChzdHlsZSk7CiAgfQoKICBmdW5jdGlvbiBtb3VudFNoYWRvdyhpZCwgY3NzVGV4dCkgewogICAgLy8gQSBwcmV2aW91cyBpbmplY3Rpb24gKGV4dGVuc2lvbiByZWxvYWRlZCB3aXRob3V0IHJlbG9hZGluZyBHbWFpbCkKICAgIC8vIGxlYXZlcyBhbiBvcnBoYW5lZCBob3N0IGJlaGluZDsgcmVwbGFjZSBpdCByYXRoZXIgdGhhbiBzdGFjayBhIHNlY29uZC4KICAgIGNvbnN0IHN0YWxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgaWYgKHN0YWxlKSBzdGFsZS5yZW1vdmUoKTsKCiAgICBjb25zdCBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBob3N0LmlkID0gaWQ7CiAgICBjb25zdCByb290ID0gaG9zdC5hdHRhY2hTaGFkb3coeyBtb2RlOiAnb3BlbicgfSk7CiAgICBhZG9wdFN0eWxlcyhyb290LCBjc3NUZXh0KTsKCiAgICAvLyBLZ",
"XkgZXZlbnRzIGZyb20gaW5zaWRlIGEgc2hhZG93IHJvb3QgcmVhY2ggR21haWwgcmV0YXJnZXRlZCB0byB0aGUKICAgIC8vIGhvc3QsIHdoaWNoIGlzIG5vdCBhbiBpbnB1dCAtIHNvIHR5cGluZyAiYyIgaW4gb3VyIHNlYXJjaCBib3ggd291bGQKICAgIC8vIG9wZW4gR21haWwncyBDb21wb3NlLiBPdXIgb3duIGhhbmRsZXJzIGluc2lkZSB0aGUgcm9vdCBydW4gZmlyc3Q7CiAgICAvLyBzdG9wcGluZyBwcm9wYWdhdGlvbiBoZXJlIGtlZXBzIEdtYWlsJ3Mgc2hvcnRjdXRzIG91dCBvZiBpdC4KICAgIGZvciAoY29uc3QgdHlwZSBvZiBbJ2tleWRvd24nLCAna2V5cHJlc3MnLCAna2V5dXAnXSkgewogICAgICBob3N0LmFkZEV2ZW50TGlzdGVuZXIodHlwZSwgZSA9PiBlLnN0b3BQcm9wYWdhdGlvbigpKTsKICAgIH0KCiAgICAoZG9jdW1lbnQuYm9keSB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQpLmFwcGVuZENoaWxkKGhvc3QpOwogICAgcmV0dXJuIHsgaG9zdCwgcm9vdCB9OwogIH0KCiAgLy8g4pSA4pSAIFRvYXN0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gdG9hc3RMYXllcihyb290KSB7CiAgICBsZXQgbGF5ZXIgP",
"SByb290LnF1ZXJ5U2VsZWN0b3IoJy50b2FzdHMnKTsKICAgIGlmICghbGF5ZXIpIHsKICAgICAgbGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAndG9hc3RzJywgcm9sZTogJ3N0YXR1cycsICdhcmlhLWxpdmUnOiAncG9saXRlJyB9KTsKICAgICAgcm9vdC5hcHBlbmRDaGlsZChsYXllcik7CiAgICB9CiAgICByZXR1cm4gbGF5ZXI7CiAgfQoKICBmdW5jdGlvbiB0b2FzdChyb290LCBtZXNzYWdlLCB7IGtpbmQgPSAnaW5mbycsIGFjdGlvbiA9IG51bGwsIHRpbWVvdXQgfSA9IHt9KSB7CiAgICBjb25zdCBsYXllciA9IHRvYXN0TGF5ZXIocm9vdCk7CiAgICAvLyBBIG5ldyBjb25maXJtYXRpb24gcmVwbGFjZXMgdGhlIGxhc3Qgb25lIHJhdGhlciB0aGFuIHN0YWNraW5nIHVwOwogICAgLy8gZXJyb3JzIHN0YXkgdW50aWwgcmVhZCBvciB0aW1lZCBvdXQuIE9uZSBzdGlsbCBvZmZlcmluZyBhbiBhY3Rpb24KICAgIC8vIChVbmRvKSBpcyBrZXB0IHRvbywgc2luY2UgaXRzIGJ1dHRvbiBtYXkgYmUgYWJvdXQgdG8gYmUgY2xpY2tlZC4KICAgIGlmIChraW5kICE9PSAnZXJyb3InKSB7CiAgICAgIGZvciAoY29uc3Qgb2xkIG9mIGxheWVyLnF1ZXJ5U2VsZWN0b3JBbGwoJy50b2FzdDpub3QoLnRvYXN0LWVycm9yKScpKSB7CiAgICAgICAgaWYgKCFvbGQucXVlcnlTZWxlY3RvcignLnRvYXN0LWFjdGlvbicpKSBvbGQucmVtb3ZlKCk7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGNsb3NlID0gKCkgPT4gZWwucmVtb3ZlKCk7C",
"iAgICBjb25zdCBlbCA9IGgoJ2RpdicsIHsgY2xhc3M6IFsndG9hc3QnLCBraW5kID09PSAnZXJyb3InICYmICd0b2FzdC1lcnJvciddIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndG9hc3QtdGV4dCcsIHRleHQ6IG1lc3NhZ2UgfSksCiAgICAgIGFjdGlvbiAmJiBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICd0b2FzdC1hY3Rpb24nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYWN0aW9uLmxhYmVsLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgYWN0aW9uLm9uQ2xpY2soKTsgfSwKICAgICAgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICd0b2FzdC1jbG9zZSBpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdEaXNtaXNzJywgb25jbGljazogY2xvc2UgfSwKICAgICAgICBpY29uKCdjbG9zZScsIDE4KSkKICAgICk7CiAgICBsYXllci5hcHBlbmRDaGlsZChlbCk7CiAgICAvLyBFcnJvcnMgc3RheSBhIGxpdHRsZSBsb25nZXI6IHRoZXkgdXN1YWxseSBuZWVkIHJlYWRpbmcsIG5vdCBnbGFuY2luZy4KICAgIHNldFRpbWVvdXQoY2xvc2UsIHRpbWVvdXQgfHwgKGtpbmQgPT09ICdlcnJvcicgPyA5MDAwIDogNTAwMCkpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIE1lbnVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUg",
"OKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gaXRlbXM6IHsgbGFiZWwsIG9uU2VsZWN0LCBpY29uPywgY2hlY2tlZD8sIGRpc2FibGVkPywgZGFuZ2VyPyB9CiAgLy8gICAgICB8IHsgaGVhZGluZyB9IHwgeyBzZXBhcmF0b3I6IHRydWUgfQoKICBjb25zdCBvcGVuTWVudXMgPSBuZXcgV2Vha01hcCgpOyAvLyByb290IOKGkiBjbG9zZSBmdW5jdGlvbgoKICBmdW5jdGlvbiBjbG9zZU1lbnUocm9vdCkgewogICAgY29uc3QgY2xvc2UgPSBvcGVuTWVudXMuZ2V0KHJvb3QpOwogICAgaWYgKGNsb3NlKSBjbG9zZSgpOwogIH0KCiAgZnVuY3Rpb24gaXNNZW51T3Blbihyb290KSB7CiAgICByZXR1cm4gb3Blbk1lbnVzLmhhcyhyb290KTsKICB9CgogIGZ1bmN0aW9uIG9wZW5NZW51KHJvb3QsIGFuY2hvciwgaXRlbXMsIHsgbGFiZWwgPSAnQWN0aW9ucycsIHBsYWNlbWVudCA9ICdiZWxvdycgfSA9IHt9KSB7CiAgICBjbG9zZU1lbnUocm9vdCk7CgogICAgY29uc3QgbWVudSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51Jywgcm9sZTogJ21lbnUnLCAnYXJpYS1sYWJlbCc6IGxhYmVsIH0pOwogICAgZm9yIChjb25zdCBpdCBvZiBpdGVtcykgewogICAgICBpZiAoaXQuc2VwYXJhdG9yKSB7IG1lbnUuYXBwZW5kQ2hpbGQoaCgnZGl2JywgeyBjbGFzczogJ21lbnUtc2VwJywgcm9sZTogJ3NlcGFyYXRvcicgf",
"SkpOyBjb250aW51ZTsgfQogICAgICBpZiAoaXQuaGVhZGluZykgeyBtZW51LmFwcGVuZENoaWxkKGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51LWhlYWRpbmcnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScsIHRleHQ6IGl0LmhlYWRpbmcgfSkpOyBjb250aW51ZTsgfQogICAgICBjb25zdCByb2xlID0gaXQuY2hlY2tlZCA9PT0gdW5kZWZpbmVkID8gJ21lbnVpdGVtJyA6ICdtZW51aXRlbXJhZGlvJzsKICAgICAgbWVudS5hcHBlbmRDaGlsZChoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6IFsnbWVudS1pdGVtJywgaXQuZGFuZ2VyICYmICdkYW5nZXInXSwKICAgICAgICB0eXBlOiAnYnV0dG9uJywKICAgICAgICByb2xlLAogICAgICAgICdhcmlhLWNoZWNrZWQnOiBpdC5jaGVja2VkID09PSB1bmRlZmluZWQgPyBudWxsIDogU3RyaW5nKCEhaXQuY2hlY2tlZCksCiAgICAgICAgZGlzYWJsZWQ6ICEhaXQuZGlzYWJsZWQsCiAgICAgICAgZGF0YXNldDogaXQua2V5ID8geyBrZXk6IGl0LmtleSB9IDogdW5kZWZpbmVkLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgaXQub25TZWxlY3QoKTsgfSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtaWNvbicgfSwgaXQuY2hlY2tlZCA_IGljb24oJ2NoZWNrJywgMTgpIDogKGl0Lmljb24gPyBpY29uKGl0Lmljb24sIDE4KSA6IG51bGwpKSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtbGFiZWwnLCB0ZXh0OiBpdC5sYWJlb",
"CB9KQogICAgICApKTsKICAgIH0KCiAgICByb290LmFwcGVuZENoaWxkKG1lbnUpOwogICAgYW5jaG9yLnNldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsICd0cnVlJyk7CgogICAgLy8gRml4ZWQgcG9zaXRpb25pbmcgYWdhaW5zdCB0aGUgYW5jaG9yLCBmbGlwcGVkIG9yIG51ZGdlZCBzbyB0aGUgbWVudQogICAgLy8gbmV2ZXIgcnVucyBvZmYgdGhlIHZpZXdwb3J0IGVkZ2UuCiAgICBjb25zdCByID0gYW5jaG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgbXcgPSBtZW51Lm9mZnNldFdpZHRoOwogICAgY29uc3QgbWggPSBtZW51Lm9mZnNldEhlaWdodDsKICAgIGxldCBsZWZ0ID0gTWF0aC5taW4oci5sZWZ0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIG13IC0gOCk7CiAgICBpZiAoci5yaWdodCAtIG13ID4gOCAmJiBsZWZ0ICsgbXcgPiB3aW5kb3cuaW5uZXJXaWR0aCAtIDgpIGxlZnQgPSByLnJpZ2h0IC0gbXc7CiAgICBsZWZ0ID0gTWF0aC5tYXgoOCwgbGVmdCk7CiAgICBsZXQgdG9wID0gcGxhY2VtZW50ID09PSAnYWJvdmUnID8gci50b3AgLSBtaCAtIDYgOiByLmJvdHRvbSArIDY7CiAgICBpZiAodG9wICsgbWggPiB3aW5kb3cuaW5uZXJIZWlnaHQgLSA4KSB0b3AgPSByLnRvcCAtIG1oIC0gNjsKICAgIGlmICh0b3AgPCA4KSB0b3AgPSA4OwogICAgbWVudS5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5yb3VuZChsZWZ0KX1weGA7CiAgICBtZW51LnN0eWxlLnRvcCA9IGAke01hdGgucm91bmQodG9wK",
"X1weGA7CgogICAgY29uc3QgYnV0dG9ucyA9ICgpID0-IFsuLi5tZW51LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tZW51LWl0ZW06bm90KFtkaXNhYmxlZF0pJyldOwogICAgY29uc3Qgb25LZXkgPSBlID0-IHsKICAgICAgY29uc3QgbGlzdCA9IGJ1dHRvbnMoKTsKICAgICAgY29uc3QgaSA9IGxpc3QuaW5kZXhPZihyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgY2xvc2UoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93RG93bicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyAobGlzdFtpICsgMV0gfHwgbGlzdFswXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93VXAnKSB7IGUucHJldmVudERlZmF1bHQoKTsgKGxpc3RbaSAtIDFdIHx8IGxpc3RbbGlzdC5sZW5ndGggLSAxXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0hvbWUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFswXSAmJiBsaXN0WzBdLmZvY3VzKCk7IH0KICAgICAgZWxzZSBpZiAoZS5rZXkgPT09ICdFbmQnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFtsaXN0Lmxlbmd0aCAtIDFdICYmIGxpc3RbbGlzdC5sZW5ndGggLSAxXS5mb2N1cygpOyB9CiAgICAgIGVsc2UgaWYgKGUua2V5ID09PSAnVGFiJykgeyBjbG9zZSgpOyB9CiAgICB9OwogICAgLy8gQ2xpY2tzIGFue",
"XdoZXJlIGVsc2UgLSBpbiBvdXIgcm9vdCBvciBvbiBHbWFpbCBpdHNlbGYgLSBkaXNtaXNzIGl0LgogICAgY29uc3Qgb25Qb2ludGVyID0gZSA9PiB7CiAgICAgIGlmICghZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhtZW51KSAmJiAhZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhhbmNob3IpKSBjbG9zZSgpOwogICAgfTsKCiAgICAvLyBJZiB0aGUgbWVudSBoZWxkIGZvY3VzLCBpdCBnb2VzIGJhY2sgdG8gdGhlIGFuY2hvciAtIG9uIEVzYywgb24KICAgIC8vIGNob29zaW5nIGFuIGl0ZW0gKGJlZm9yZSB0aGUgYWN0aW9uIHJ1bnMsIHNvIGFuIGFjdGlvbiB0aGF0CiAgICAvLyByZS1yZW5kZXJzIGNhbiBmaW5kIHRoZSBhbmNob3IgYWdhaW4gYnkgaXRzIGRhdGEta2V5KSwgYW5kIHdoZW4gYQogICAgLy8gcmUtcmVuZGVyIGNsb3NlcyB0aGUgbWVudSBmcm9tIHVuZGVybmVhdGguCiAgICBmdW5jdGlvbiBjbG9zZSgpIHsKICAgICAgaWYgKG9wZW5NZW51cy5nZXQocm9vdCkgIT09IGNsb3NlKSByZXR1cm47CiAgICAgIGNvbnN0IGhhZEZvY3VzID0gbWVudS5jb250YWlucyhyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBvcGVuTWVudXMuZGVsZXRlKHJvb3QpOwogICAgICBtZW51LnJlbW92ZSgpOwogICAgICBpZiAoaGFkRm9jdXMgJiYgYW5jaG9yLmlzQ29ubmVjdGVkKSBhbmNob3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBhbmNob3Iuc2V0QXR0cmlidXRlKCdhcmlhLWV4cGFuZGVkJ",
"ywgJ2ZhbHNlJyk7CiAgICAgIG1lbnUucmVtb3ZlRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCBvblBvaW50ZXIsIHRydWUpOwogICAgfQoKICAgIG1lbnUuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgb25Qb2ludGVyLCB0cnVlKTsKICAgIG9wZW5NZW51cy5zZXQocm9vdCwgY2xvc2UpOwoKICAgIGNvbnN0IGZpcnN0ID0gYnV0dG9ucygpWzBdOwogICAgaWYgKGZpcnN0KSBmaXJzdC5mb2N1cygpOwogICAgcmV0dXJuIGNsb3NlOwogIH0KCiAgbnMudWkgPSB7IGgsIGFwcGVuZCwgaWNvbiwgbG9nbywgTE9HTywgbW91bnRTaGFkb3csIHRvYXN0LCBvcGVuTWVudSwgY2xvc2VNZW51LCBpc01lbnVPcGVuIH07Cn0pKCk7Cg\"],[\"src/content/styles.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFN0eWxlcyBmb3IgdGhlIGluamVjdGVkIFVJCi8vCi8vIFBsYWluIHN0cmluZ3MsIG",
"Fkb3B0ZWQgaW50byBlYWNoIHNoYWRvdyByb290LiBUaGUgbG9vayBib3Jyb3dzIEdtYWlsJ3MKLy8gb3duIHZvY2FidWxhcnkgLSBHb29nbGUgU2FucywgaXRzIGJsdWUsIGl0cyBlbGV2YXRpb24gc2hhZG93cywgcGlsbAovLyBidXR0b25zIC0gc28gdGhlIGJvYXJkIHJlYWRzIGFzIHBhcnQgb2YgR21haWwgcmF0aGVyIHRoYW4gc29tZXRoaW5nCi8vIGJvbHRlZCBvbi4gRGFyayBtb2RlIGZvbGxvd3MgdGhlIG9wZXJhdGluZyBzeXN0ZW0sIGFzIGFza2VkOyBHbWFpbCdzCi8vIG93biB0aGVtZSBzZXR0aW5nIGlzIG5vdCB2aXNpYmxlIHRvIGEgY29udGVudCBzY3JpcHQgd2l0aG91dCBzY3JhcGluZy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CgogIC8vIOKUgOKUgCBTaGFyZWQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IEJBU0UgPSBgCjpob3N0IHsKICBhbGw6IGluaXRpYWwgIWltcG9ydGFudDsKICAvKiBBIHBvc2l0aW9uZWQgaG9zdCB3aXRoIGEgei1pbmRleCBpcyBpdHMgb3duIHN0YWNraW5nIGNvbnRleHQsIHNvCiAgICAgbWVudXMgYW5kIHRvYXN0cyBpbnNpZGUgaXQgY2FuIGxheWVyIG92ZXIgdGhlIGJvYXJkIHdpdGggc21hbGwKICAgICBudW1iZXJzIGluc3RlYWQgb2YgY29tcGV0aW5nIHdpdGggR21haWwncy4gKi8KICBwb3NpdGlvbjogcmVsYXRpdmUgIWltcG9ydGFudDsKICB6LWluZGV4OiAyMTQ3NDgzMDAwICFpbXBvcnRhbnQ7CgogIC0tYmc6ICNmNmY4ZmM7CiAgLS1iYXI6ICNmNmY4ZmM7CiAgLS1jb2w6ICNlOWVlZjY7CiAgLS1zdXJmYWNlOiAjZmZmZmZmOwogIC0tbWVudTogI2ZmZmZmZjsKICAtLWZnOiAjMWYxZjFmOwogIC0tZmctMjogIzQ0NDc0NjsKICAtLWZnLTM6ICM1ZTYwNjI7CiAgLS1hY2NlbnQ6ICMwYjU3ZDA7CiAgLS1vbi1hY2NlbnQ6ICNmZmZmZmY7CiAgLS1hY2NlbnQtc29mdDogI2QzZTNmZDsKICAtLW9uLWFjY2VudC1zb2Z0OiAjMDQxZTQ5OwogIC0tYm9yZGVyOiAjZTFlM2UxOwogIC0tYm9yZGVyLXN0cm9uZzogI2M0YzdjNTsKICAtLWhvdmVyOiByZ2JhKDY4LCA3MSwgNzAsIC4wOCk7CiAgLS1wcmVzczogcmdiYSg2OC",
"wgNzEsIDcwLCAuMTQpOwogIC0tZm9jdXM6ICMwYjU3ZDA7CiAgLS1kYW5nZXI6ICNiMzI2MWU7CiAgLS1zdGFyOiAjZThhNDAwOwogIC0taW52ZXJzZTogIzMwMzAzMDsKICAtLW9uLWludmVyc2U6ICNmMmYyZjI7CiAgLS1pbnZlcnNlLWFjY2VudDogI2E4YzdmYTsKICAtLXNjcmltOiByZ2JhKDMyLCAzMywgMzYsIC40KTsKICAtLXNoYWRvdy0xOiAwIDFweCAycHggcmdiYSg2MCwgNjQsIDY3LCAuMiksIDAgMXB4IDNweCAxcHggcmdiYSg2MCwgNjQsIDY3LCAuMSk7CiAgLS1zaGFkb3ctMjogMCAxcHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjMpLCAwIDJweCA2cHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjE1KTsKICAtLXNoYWRvdy0zOiAwIDRweCA4cHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjE1KSwgMCAxcHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjMpOwogIC0tZm9udDogIkdvb2dsZSBTYW5zIiwgUm9ib3RvLCBBcmlhbCwgc2Fucy1zZXJpZjsKICAvKiBDYXJkIGNvbG91cnM6IEdvb2dsZSdzIG93biBwYWxldHRlLCBhIHN0ZXAgbGlnaHRlciBpbiBkYXJrIG1vZGUgc28KICAgICB0aGUgc3RyaXBlIHN0aWxsIHJlYWRzIGFnYWluc3QgYSBkYXJrIGNhcmQuICovCiAgLS1jLXJlZDogI2Q5MzAyNTsKICAtLWMtb3JhbmdlOiAjZTg3MTBhOwogIC0tYy15ZWxsb3c6ICNmOWFiMDA7CiAgLS1jLWdyZWVuOiAjMWU4ZTNlOwogIC0tYy1ibHVlOiAjMWE3M2U4OwogIC0tYy1wdXJwbGU6ICM5MzM0ZTY7CiAgLS1jLWdyZX",
"k6ICM4MDg2OGI7CiAgLS1tYXJrOiAjZmRlMjkzOwogIC0tbWFyay1jdXJyZW50OiAjZjlhYjAwOwogIC0tb24tbWFyay1jdXJyZW50OiAjMWYxZjFmOwogIC8qIFRoZSBzY3JhdGNocGFkOiBwYXBlciBvZiBpdHMgb3duIGNvbG91ci4gKi8KICAtLXNjcmF0Y2g6ICNmZmY4ZGM7CiAgLS1zY3JhdGNoLWVkZ2U6ICNmMGUxYTA7CiAgLS1zY3JhdGNoLWluazogIzlhNmIwMDsKfQoKQG1lZGlhIChwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaykgewogIDpob3N0IHsKICAgIC0tYmc6ICMxMzEzMTQ7CiAgICAtLWJhcjogIzEzMTMxNDsKICAgIC0tY29sOiAjMWUxZjIwOwogICAgLS1zdXJmYWNlOiAjMmEyYjJkOwogICAgLS1tZW51OiAjMmQyZTMwOwogICAgLS1mZzogI2UzZTNlMzsKICAgIC0tZmctMjogI2M0YzdjNTsKICAgIC0tZmctMzogI2EyYTVhMzsKICAgIC0tYWNjZW50OiAjYThjN2ZhOwogICAgLS1vbi1hY2NlbnQ6ICMwNjJlNmY7CiAgICAtLWFjY2VudC1zb2Z0OiAjMDA0YTc3OwogICAgLS1vbi1hY2NlbnQtc29mdDogI2MyZTdmZjsKICAgIC0tYm9yZGVyOiAjM2EzYjNkOwogICAgLS1ib3JkZXItc3Ryb25nOiAjNWM1ZTYwOwogICAgLS1ob3ZlcjogcmdiYSgyMjcsIDIyNywgMjI3LCAuMDgpOwogICAgLS1wcmVzczogcmdiYSgyMjcsIDIyNywgMjI3LCAuMTQpOwogICAgLS1mb2N1czogI2E4YzdmYTsKICAgIC0tZGFuZ2VyOiAjZjJiOGI1OwogICAgLS1zdGFyOiAjZmRkNjYzOwogICAgLS1pbnZlcnNlOiAjZT",
"NlM2UzOwogICAgLS1vbi1pbnZlcnNlOiAjMWYxZjFmOwogICAgLS1pbnZlcnNlLWFjY2VudDogIzBiNTdkMDsKICAgIC0tc2NyaW06IHJnYmEoMCwgMCwgMCwgLjU1KTsKICAgIC0tc2hhZG93LTE6IDAgMXB4IDJweCByZ2JhKDAsIDAsIDAsIC41KSwgMCAxcHggM3B4IDFweCByZ2JhKDAsIDAsIDAsIC4yNSk7CiAgICAtLXNoYWRvdy0yOiAwIDFweCAzcHggcmdiYSgwLCAwLCAwLCAuNiksIDAgMnB4IDhweCAycHggcmdiYSgwLCAwLCAwLCAuMyk7CiAgICAtLXNoYWRvdy0zOiAwIDRweCAxMHB4IDNweCByZ2JhKDAsIDAsIDAsIC40NSksIDAgMXB4IDNweCByZ2JhKDAsIDAsIDAsIC42KTsKICAgIC0tYy1yZWQ6ICNmMjhiODI7CiAgICAtLWMtb3JhbmdlOiAjZmNhZDcwOwogICAgLS1jLXllbGxvdzogI2ZkZDY2MzsKICAgIC0tYy1ncmVlbjogIzgxYzk5NTsKICAgIC0tYy1ibHVlOiAjOGFiNGY4OwogICAgLS1jLXB1cnBsZTogI2M1OGFmOTsKICAgIC0tYy1ncmV5OiAjOWFhMGE2OwogICAgLS1tYXJrOiAjNmI1ODAwOwogICAgLS1tYXJrLWN1cnJlbnQ6ICNmZGQ2NjM7CiAgICAtLW9uLW1hcmstY3VycmVudDogIzFmMWYxZjsKICAgIC0tc2NyYXRjaDogIzJhMjYxNzsKICAgIC0tc2NyYXRjaC1lZGdlOiAjNGE0MTIyOwogICAgLS1zY3JhdGNoLWluazogI2ZkZDY2MzsKICB9Cn0KCiosICo6OmJlZm9yZSwgKjo6YWZ0ZXIgeyBib3gtc2l6aW5nOiBib3JkZXItYm94OyB9CgovKiBBdXRob3IgZGlzcGxheSBydWxlcyAoLn",
"BpbGwsIC5vdmVybGF54oCmKSB3b3VsZCBvdGhlcndpc2UgYmVhdCB0aGUKICAgYnJvd3NlcidzIG93biBbaGlkZGVuXSB7IGRpc3BsYXk6IG5vbmUgfS4gKi8KW2hpZGRlbl0geyBkaXNwbGF5OiBub25lICFpbXBvcnRhbnQ7IH0KCmJ1dHRvbiB7CiAgZm9udDogaW5oZXJpdDsKICBjb2xvcjogaW5oZXJpdDsKICBiYWNrZ3JvdW5kOiBub25lOwogIGJvcmRlcjogMDsKICBtYXJnaW46IDA7CiAgcGFkZGluZzogMDsKICBjdXJzb3I6IHBvaW50ZXI7CiAgLXdlYmtpdC10YXAtaGlnaGxpZ2h0LWNvbG9yOiB0cmFuc3BhcmVudDsKfQpidXR0b246ZGlzYWJsZWQgeyBjdXJzb3I6IGRlZmF1bHQ7IH0KCjpmb2N1cyB7IG91dGxpbmU6IG5vbmU7IH0KOmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogMnB4OyB9CgouaWNvbiB7IGRpc3BsYXk6IGJsb2NrOyBmbGV4OiBub25lOyB9CgouaWNvbi1idG4gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDM2cHg7CiAgaGVpZ2h0OiAzNnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZmxleDogbm9uZTsKfQouaWNvbi1idG46aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLmljb24tYnRuOmFjdGl2ZSB7IGJhY2tncm91bmQ6IH",
"ZhcigtLXByZXNzKTsgfQouaWNvbi1idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNDsgYmFja2dyb3VuZDogbm9uZTsgfQoKLmJ0biB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDM2cHg7CiAgcGFkZGluZzogMCAxOHB4OwogIGJvcmRlci1yYWRpdXM6IDE4cHg7CiAgZm9udC1zaXplOiAxNHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wMWVtOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmJ0bi1wcmltYXJ5IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7IH0KLmJ0bi1wcmltYXJ5OmhvdmVyIHsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOyB9Ci5idG4tdG9uYWwgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLmJ0bi10ZXh0IHsgY29sb3I6IHZhcigtLWFjY2VudCk7IHBhZGRpbmc6IDAgMTJweDsgfQouYnRuLXRleHQ6aG92ZXIsIC5idG4tdG9uYWw6aG92ZXIgeyBiYWNrZ3JvdW5kLWltYWdlOiBsaW5lYXItZ3JhZGllbnQodmFyKC0taG92ZXIpLCB2YXIoLS1ob3ZlcikpOyB9Ci5idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNTsgYm94LXNoYWRvdzogbm9uZTsgfQoKLyog4pSA4pSAIE1lbnVzIOKUgOKUgCAqLwoKLm1lbnUgewogIH",
"Bvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiAyMDsKICBtaW4td2lkdGg6IDIwOHB4OwogIG1heC13aWR0aDogMzIwcHg7CiAgbWF4LWhlaWdodDogNzB2aDsKICBvdmVyZmxvdy15OiBhdXRvOwogIHBhZGRpbmc6IDhweCAwOwogIGJhY2tncm91bmQ6IHZhcigtLW1lbnUpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGxpbmUtaGVpZ2h0OiAyMHB4Owp9Ci5tZW51LWl0ZW0gewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDEycHg7CiAgd2lkdGg6IDEwMCU7CiAgbWluLWhlaWdodDogMzZweDsKICBwYWRkaW5nOiA2cHggMjBweCA2cHggMTJweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5tZW51LWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLm1lbnUtaXRlbTpmb2N1cy12aXNpYmxlIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogLTJweDsgfQoubWVudS1pdGVtOmRpc2FibGVkIHsgb3BhY2l0eTogLjQ1OyBiYWNrZ3JvdW5kOiBub25lOyB9Ci5tZW51LWl0ZW0uZGFuZ2VyIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KLm1lbnUtaWNvbiB7IHdpZHRoOiAxOHB4OyBoZWlnaHQ6IDE4cHg7IG",
"Rpc3BsYXk6IGlubGluZS1mbGV4OyBjb2xvcjogdmFyKC0tZmctMik7IGZsZXg6IG5vbmU7IH0KLm1lbnUtaXRlbS5kYW5nZXIgLm1lbnUtaWNvbiB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci5tZW51LWl0ZW1bYXJpYS1jaGVja2VkPSJ0cnVlIl0gLm1lbnUtaWNvbiB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5tZW51LWxhYmVsIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQoubWVudS1oZWFkaW5nIHsKICBwYWRkaW5nOiA4cHggMjBweCA0cHggNDJweDsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmctMyk7Cn0KLm1lbnUtc2VwIHsgaGVpZ2h0OiAxcHg7IG1hcmdpbjogOHB4IDA7IGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7IH0KCi8qIOKUgOKUgCBUb2FzdHMg4pSA4pSAICovCgoudG9hc3RzIHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgei1pbmRleDogMzA7CiAgbGVmdDogNTAlOwogIGJvdHRvbTogMjRweDsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoLTUwJSk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwp9Ci50b2FzdCB7CiAgcG9pbnRlci1ldmVudH",
"M6IGF1dG87CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNHB4OwogIG1pbi1oZWlnaHQ6IDQ4cHg7CiAgbWF4LXdpZHRoOiBtaW4oNjAwcHgsIGNhbGMoMTAwdncgLSAzMnB4KSk7CiAgcGFkZGluZzogNnB4IDZweCA2cHggMTZweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taW52ZXJzZSk7CiAgY29sb3I6IHZhcigtLW9uLWludmVyc2UpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LXNpemU6IDE0cHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7CiAgYW5pbWF0aW9uOiB0b2FzdC1pbiAuMThzIGVhc2Utb3V0Owp9Ci50b2FzdC1lcnJvciB7IGJvcmRlci1sZWZ0OiA0cHggc29saWQgI2YyOGI4MjsgcGFkZGluZy1sZWZ0OiAxMnB4OyB9Ci50b2FzdC10ZXh0IHsgZmxleDogMTsgcGFkZGluZy1yaWdodDogOHB4OyB9Ci50b2FzdC1hY3Rpb24gewogIGhlaWdodDogMzZweDsKICBwYWRkaW5nOiAwIDEycHg7CiAgYm9yZGVyLXJhZGl1czogMThweDsKICBjb2xvcjogdmFyKC0taW52ZXJzZS1hY2NlbnQpOwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQoudG9hc3QtYWN0aW9uOmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgxMjgsIDEyOCwgMTI4LCAuMTYpOyB9Ci50b2FzdC1jbG9zZSB7IGNvbG9yOiBpbmhlcml0OyBvcGFjaXR5OiAuODsgfQoudG9hc3QtY2xvc2U6aG92ZXIgeyBiYWNrZ3JvdW5kOi",
"ByZ2JhKDEyOCwgMTI4LCAxMjgsIC4xNik7IGNvbG9yOiBpbmhlcml0OyB9CkBrZXlmcmFtZXMgdG9hc3QtaW4geyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDhweCk7IH0gdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IG5vbmU7IH0gfQoKQG1lZGlhIChwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpIHsKICAqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYW5pbWF0aW9uOiBub25lICFpbXBvcnRhbnQ7IHRyYW5zaXRpb246IG5vbmUgIWltcG9ydGFudDsgfQp9CmA7CgogIC8vIOKUgOKUgCBCb2FyZCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgQk9BUkQgPSBgCi5vdmVybGF5IHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgaW5zZXQ6IDA7CiAgei1pbmRleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwogIGZvbnQtc2l6ZTogMTRweDsKICBsaW5lLWhlaWdodDogMS40OwogIC13ZWJraXQtZm9udC1zbW9vdGhpbmc6IGFudGlhbG",
"lhc2VkOwp9Ci5vdmVybGF5W2hpZGRlbl0geyBkaXNwbGF5OiBub25lOyB9CgouYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA0cHg7CiAgaGVpZ2h0OiA2NHB4OwogIHBhZGRpbmc6IDAgMTJweCAwIDIwcHg7CiAgZmxleDogbm9uZTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iYXIpOwp9Ci5icmFuZCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTBweDsKICBtYXJnaW46IDA7CiAgZm9udC1zaXplOiAyMnB4OwogIGZvbnQtd2VpZ2h0OiA0MDA7CiAgY29sb3I6IHZhcigtLWZnKTsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwp9Ci5icmFuZCAubG9nbyB7IGRpc3BsYXk6IGZsZXg7IH0KLmJyYW5kIC5kaW0geyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmFjY291bnQgewogIG1hcmdpbi1sZWZ0OiAxNHB4OwogIHBhZGRpbmc6IDRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDE0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEzcHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIG1pbi13aWR0aDogMDsKfQouc3BhY2VyIHsgZmxleDogMTsgfQoudXBkYXRlZCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxMnB4OyB3aGl0ZS1zcGFjZTogbm93cmFwOyBtYXJnaW4tcmlnaH",
"Q6IDJweDsgfQoKLyog4pSA4pSAIFRhYnM6IEJvYXJkIHwgTm90ZXMg4pSA4pSAICovCgoudGFicyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IDJweDsKICBtYXJnaW4tbGVmdDogMThweDsKICBwYWRkaW5nOiAzcHg7CiAgYm9yZGVyLXJhZGl1czogMjBweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7Cn0KLnRhYiB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCAxNHB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKfQoudGFiOmhvdmVyIHsgY29sb3I6IHZhcigtLWZnKTsgfQoudGFiW2FyaWEtc2VsZWN0ZWQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBjb2xvcjogdmFyKC0tZmcpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLnRhYlthcmlhLXNlbGVjdGVkPSJ0cnVlIl0gLmljb24geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouc3Bpbm5pbmcgLmljb24geyBhbmltYXRpb246IHNwaW4gLjlzIGxpbmVhciBpbmZpbml0ZTsgfQpAa2V5ZnJhbWVzIHNwaW4geyB0byB7IHRyYW5zZm9ybTogcm90YXRlKDM2MGRlZyk7IH0gfQoKLmJvZHkgeyBmbGV4OiAxOyBkaXNwbGF5OiBmbGV4OyBtaW4taGVpZ2h0OiAwOyB9CgouY29sdW1ucyB7CiAgZmxleD",
"ogMTsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMTJweDsKICBwYWRkaW5nOiA0cHggMjBweCAyMHB4OwogIG92ZXJmbG93LXg6IGF1dG87CiAgb3ZlcmZsb3cteTogaGlkZGVuOwogIG1pbi1oZWlnaHQ6IDA7Cn0KLmNvbHVtbiB7CiAgZmxleDogMSAwIDI4MHB4OwogIG1pbi13aWR0aDogMjgwcHg7CiAgbWF4LXdpZHRoOiA0MDBweDsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLWhlaWdodDogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJzOwp9Ci5jb2x1bW4uZHJvcC10YXJnZXQgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgfQouY29sLWhlYWQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMHB4IDZweCA2cHggMTZweDsKICBmbGV4OiBub25lOwp9Ci5jb2wtdGl0bGUgewogIG1hcmdpbjogMDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmcpOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouY29sLWNvdW50IHsKICBmbGV4OiBub25lOwogIG1pbi13aWR0aDogMjJweDsKICBwYWRkaW5nOiAwIDdweDsKICBib3JkZXItcmFkaXVzOiAxMX",
"B4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9Ci5jb2wtZmxhZyB7CiAgZmxleDogbm9uZTsKICBwYWRkaW5nOiAwIDhweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDExcHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7Cn0KLmNvbC1oZWFkIC5zcGFjZXIgeyBtaW4td2lkdGg6IDRweDsgfQouY29sLW5vdGUgeyBwYWRkaW5nOiAwIDE2cHggNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZmxleDogbm9uZTsgfQoKLmxpc3QgewogIGZsZXg6IDE7CiAgbWluLWhlaWdodDogNzJweDsKICBvdmVyZmxvdy15OiBhdXRvOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiA0cHggOHB4IDEycHg7CiAgc2Nyb2xsYmFyLXdpZHRoOiB0aGluOwp9Ci5saXN0OmVtcHR5OjphZnRlciB7CiAgY29udGVudDogYXR0cihkYXRhLWVtcHR5KTsKICBkaXNwbGF5OiBibG9jazsKICBtYXJnaW46IDJweCAwOwogIHBhZGRpbmc6IDIycHggMTJweDsKICBib3JkZXI6IDEuNXB4IGRhc2hlZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBib3JkZXItcmFkaXVzOi",
"AxMnB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDEzcHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9CgovKiDilIDilIAgQ2FyZHMg4pSA4pSAICovCgouY2FyZCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGZsZXg6IG5vbmU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7CiAgY3Vyc29yOiBncmFiOwogIHRyYW5zaXRpb246IGJveC1zaGFkb3cgLjE1czsKfQouY2FyZDpob3ZlciB7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0yKTsgfQouY2FyZC5kcmFnZ2luZyB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhcmQubGlmdGluZyB7IG9wYWNpdHk6IC41OyB9Ci5jYXJkLW1haW4gewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDEwcHggMTRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBjdXJzb3I6IGluaGVyaXQ7Cn0KLmNhcmQtbWFpbjpmb2N1cy12aXNpYmxlIHsgb3V0bGluZS1vZmZzZXQ6IC0ycHg7IH0KLmNhcmQtdG9wIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgbWluLWhlaWdodDogMjBweDsKICBmb250LXNpemU6IDEzcHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5kb3QgeyB3aWR0aDogOHB4OyBoZWlnaHQ6IDhweDsgYm9yZGVyLXJhZGl1czogNT",
"AlOyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBmbGV4OiBub25lOyB9Ci5mcm9tIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZGF0ZSB7IGZsZXg6IG5vbmU7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jYXJkOmhvdmVyIC5kYXRlLCAuY2FyZDpmb2N1cy13aXRoaW4gLmRhdGUgeyB2aXNpYmlsaXR5OiBoaWRkZW47IH0KLnN1YmplY3Qtcm93IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg7IG1hcmdpbi10b3A6IDNweDsgfQouc3ViamVjdCB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIGZvbnQtc2l6ZTogMTRweDsKICBjb2xvcjogdmFyKC0tZmcpOwp9Ci51bnJlYWQgLmZyb20sIC51bnJlYWQgLnN1YmplY3QgeyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5zdGFyIHsgY29sb3I6IHZhcigtLXN0YXIpOyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgZmxleDogbm9uZTsgfQouY291bnQgewogIGZsZXg6IG5vbmU7CiAgcGFkZGluZzogMCA2cHg7CiAgYm9yZGVyLXJhZGl1czogOXB4OwogIGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm",
"9udC1zaXplOiAxMXB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGluZS1oZWlnaHQ6IDE4cHg7Cn0KLmRyYWZ0IHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTJweDsgfQouc25pcHBldCB7CiAgbWFyZ2luLXRvcDogM3B4OwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMThweDsKICBjb2xvcjogdmFyKC0tZmctMyk7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydGljYWw7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKfQouY2FyZC1ub3RlIHsKICBtYXJnaW4tdG9wOiA0cHg7CiAgcGFkZGluZy1sZWZ0OiA4cHg7CiAgYm9yZGVyLWxlZnQ6IDJweCBzb2xpZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIHdoaXRlLXNwYWNlOiBwcmUtbGluZTsKICBkaXNwbGF5OiAtd2Via2l0LWJveDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDM7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICBvdmVyZmxvdzogaGlkZGVuOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9CgpbZGF0YS1jb2xvdXI9InJlZCJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcmVkKTsgfQpbZGF0YS1jb2xvdXI9Im9yYW5nZSJdIHsgLS1zdHJpcGU6IHZhcigtLW",
"Mtb3JhbmdlKTsgfQpbZGF0YS1jb2xvdXI9InllbGxvdyJdIHsgLS1zdHJpcGU6IHZhcigtLWMteWVsbG93KTsgfQpbZGF0YS1jb2xvdXI9ImdyZWVuIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ncmVlbik7IH0KW2RhdGEtY29sb3VyPSJibHVlIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ibHVlKTsgfQpbZGF0YS1jb2xvdXI9InB1cnBsZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcHVycGxlKTsgfQpbZGF0YS1jb2xvdXI9ImdyZXkiXSB7IC0tc3RyaXBlOiB2YXIoLS1jLWdyZXkpOyB9Ci5jYXJkW2RhdGEtY29sb3VyXTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiAwOwogIGJvdHRvbTogMDsKICBsZWZ0OiAwOwogIHdpZHRoOiA2cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweCAwIDAgMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdHJpcGUpOwogIHBvaW50ZXItZXZlbnRzOiBub25lOwp9Ci5jYXJkW2RhdGEtY29sb3VyXSAuY2FyZC1tYWluIHsgcGFkZGluZy1sZWZ0OiAxOHB4OyB9CgouY2FyZC1tZW51IHsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiA0cHg7CiAgcmlnaHQ6IDRweDsKICB3aWR0aDogMzJweDsKICBoZWlnaHQ6IDMycHg7CiAgb3BhY2l0eTogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKfQouY2FyZC1tZW51OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5jYXJkOmhvdmVyIC5jYXJkLW1lbnUsIC5jYXJkOmZvY3VzLX",
"dpdGhpbiAuY2FyZC1tZW51LCAuY2FyZC1tZW51W2FyaWEtZXhwYW5kZWQ9InRydWUiXSB7IG9wYWNpdHk6IDE7IH0KLyogTm8gaG92ZXIgb24gYSB0b3VjaCBzY3JlZW46IHRoZSDii68gaXMgYWx3YXlzIHRoZXJlLCBhbmQgdGhlIHRvcCBsaW5lCiAgIG1ha2VzIHJvb20gZm9yIGl0IHJhdGhlciB0aGFuIGhpZGluZyB0aGUgZGF0ZSB1bmRlciBpdC4gKi8KQG1lZGlhIChob3Zlcjogbm9uZSkgeyAuY2FyZC1tZW51IHsgb3BhY2l0eTogMTsgfSAuY2FyZCAuZGF0ZSB7IHZpc2liaWxpdHk6IHZpc2libGU7IH0gLmNhcmQtdG9wIHsgcGFkZGluZy1yaWdodDogMzBweDsgfSB9CgoucGxhY2Vob2xkZXIgewogIGZsZXg6IG5vbmU7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3JkZXI6IDJweCBkYXNoZWQgdmFyKC0tYWNjZW50KTsKICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYWNjZW50KSAxMCUsIHRyYW5zcGFyZW50KTsKfQoKLnNrZWxldG9uIHsKICBmbGV4OiBub25lOwogIGhlaWdodDogOTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIG9wYWNpdHk6IC41NTsKICBhbmltYXRpb246IHB1bHNlIDEuNHMgZWFzZS1pbi1vdXQgaW5maW5pdGU7Cn0KQGtleWZyYW1lcyBwdWxzZSB7IDUwJSB7IG9wYWNpdHk6IC4zOyB9IH0KCi8qIOKUgOKUgCBDb2x1bW4gc2VhcmNoIOKUgOKUgCAqLwoKLnNlYXJjaCB7CiAgZmxleDogbm9uZTsKICBkaX",
"NwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiA2cHg7CiAgbWF4LWhlaWdodDogNTUlOwogIG1pbi1oZWlnaHQ6IDA7CiAgbWFyZ2luOiAwIDhweCA4cHg7CiAgcGFkZGluZzogOHB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTIpOwp9Ci5zZWFyY2gtYm94IHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgaGVpZ2h0OiA0MHB4OwogIHBhZGRpbmc6IDAgMnB4IDAgMTJweDsKICBib3JkZXItcmFkaXVzOiAyMHB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZsZXg6IG5vbmU7Cn0KLnNlYXJjaC1ib3g6Zm9jdXMtd2l0aGluIHsgb3V0bGluZTogMnB4IHNvbGlkIHZhcigtLWZvY3VzKTsgfQouc2VhcmNoLWJveCBpbnB1dCB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgaGVpZ2h0OiAxMDAlOwogIGJvcmRlcjogMDsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQ6IGluaGVyaXQ7CiAgZm9udC1zaXplOiAxNHB4Owp9Ci5zZWFyY2gtYm94IGlucHV0OjpwbGFjZWhvbGRlciB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQouc2VhcmNoLWJveCBpbnB1dDpmb2N1cy12aXNpYmxlIHsgb3V0bGluZTogbm9uZTsgfQouc2VhcmNoLWhpbnQgeyBwYW",
"RkaW5nOiAwIDhweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGZsZXg6IG5vbmU7IH0KLnJlc3VsdHMgeyBvdmVyZmxvdy15OiBhdXRvOyBtaW4taGVpZ2h0OiAwOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDJweDsgc2Nyb2xsYmFyLXdpZHRoOiB0aGluOyB9Ci5yZXN1bHQgewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDdweCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5yZXN1bHQ6aG92ZXI6bm90KDpkaXNhYmxlZCkgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLnJlc3VsdDpkaXNhYmxlZCB7IG9wYWNpdHk6IC41NTsgfQouci10b3AgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDZweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IH0KLnItdG9wIC5mcm9tIHsgZm9udC13ZWlnaHQ6IDUwMDsgfQouci1zdWJqZWN0IHsKICBkaXNwbGF5OiBibG9jazsKICBmb250LXNpemU6IDEzcHg7CiAgY29sb3I6IHZhcigtLWZnKTsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLnItd2hlcmUgeyBkaXNwbGF5OiBibG9jazsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTsgbWFyZ2luLXRvcDogMXB4OyB9Ci5yZXN1bHQ6ZGlzYWJsZWQgLnItd2hlcmUgeyBjb2",
"xvcjogdmFyKC0tZmctMyk7IH0KLnJlc3VsdHMtZW1wdHkgeyBwYWRkaW5nOiAxMnB4IDhweDsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMyk7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoKLyog4pSA4pSAIFN0YXR1cyBwYW5lbHMg4pSA4pSAICovCgoucGFuZWwgewogIG1hcmdpbjogYXV0bzsKICB3aWR0aDogbWluKDQ2MHB4LCBjYWxjKDEwMHZ3IC0gNDhweCkpOwogIHBhZGRpbmc6IDM2cHggMzJweCAzMnB4OwogIGJvcmRlci1yYWRpdXM6IDI4cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOwogIHRleHQtYWxpZ246IGNlbnRlcjsKfQoucGFuZWwgLnBhbmVsLWljb24gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDU2cHg7CiAgaGVpZ2h0OiA1NnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7CiAgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsKfQoucGFuZWwgaDIgeyBtYXJnaW46IDE2cHggMCA4cHg7IGZvbnQtc2l6ZTogMjJweDsgZm9udC13ZWlnaHQ6IDQwMDsgY29sb3I6IHZhcigtLWZnKTsgfQoucGFuZWwgcCB7IG1hcmdpbjogMCAwIDIwcHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgbGluZS1oZWlnaHQ6IDEuNTsgfQoucGFuZWwgLmFjdGlvbnMgeyBkaXNwbGF5Oi",
"BmbGV4OyBnYXA6IDhweDsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IH0KCi8qIOKUgOKUgCBOb3RlcyDilIDilIAgKi8KCi5ub3RlcyB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMTJweDsKICBtaW4td2lkdGg6IDA7CiAgbWluLWhlaWdodDogMDsKICBwYWRkaW5nOiA0cHggMjBweCAyMHB4Owp9Ci5ub3Rlcy1mb2xkZXJzIHsKICBmbGV4OiAwIDAgMjMwcHg7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIG1pbi1oZWlnaHQ6IDA7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwp9Ci5mb2xkZXJzLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDRweDsgcGFkZGluZzogMTBweCA2cHggNHB4IDE2cHg7IGZsZXg6IG5vbmU7IH0KLmZvbGRlcnMtaGVhZCBoMiB7IG1hcmdpbjogMDsgZmxleDogMTsgZm9udC1zaXplOiAxM3B4OyBmb250LXdlaWdodDogNTAwOyBjb2xvcjogdmFyKC0tZmctMik7IGxldHRlci1zcGFjaW5nOiAuMDJlbTsgfQouZm9sZGVyLWl0ZW1zIHsgZmxleDogMTsgb3ZlcmZsb3cteTogYXV0bzsgcGFkZGluZzogMnB4IDhweCAxMHB4OyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDFweDsgfQouZm9sZGVyLXJvdyB7IHBvc2l0aW9uOiByZWxhdGl2ZTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgYm9yZGVyLXJhZG",
"l1czogMTBweDsgcGFkZGluZy1sZWZ0OiBjYWxjKHZhcigtLWRlcHRoLCAwKSAqIDE2cHgpOyB9Ci5mb2xkZXItcm93LmRyb3AgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWFjY2VudCkgMTAlLCB0cmFuc3BhcmVudCk7IH0KLmZvbGRlci1idG4gewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBoZWlnaHQ6IDM2cHg7CiAgcGFkZGluZzogMCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDEwcHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQtc2l6ZTogMTRweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5mb2xkZXItYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5mb2xkZXItYnRuW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyBmb250LXdlaWdodDogNTAwOyB9Ci5mb2xkZXItYnRuIC5pY29uIHsgY29sb3I6IGluaGVyaXQ7IG9wYWNpdHk6IC44NTsgfQouZm9sZGVyLXRpdGxlIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZm9sZGVyLWNvdW",
"50IHsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogaW5oZXJpdDsgb3BhY2l0eTogLjc1OyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9Ci5mb2xkZXItbWVudSB7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgcmlnaHQ6IDJweDsgd2lkdGg6IDMwcHg7IGhlaWdodDogMzBweDsgb3BhY2l0eTogMDsgYmFja2dyb3VuZDogdmFyKC0tY29sKTsgfQouZm9sZGVyLXJvdzpob3ZlciAuZm9sZGVyLW1lbnUsIC5mb2xkZXItcm93OmZvY3VzLXdpdGhpbiAuZm9sZGVyLW1lbnUsIC5mb2xkZXItbWVudVthcmlhLWV4cGFuZGVkPSJ0cnVlIl0geyBvcGFjaXR5OiAxOyB9Ci5mb2xkZXItcm93OmhvdmVyIC5mb2xkZXItY291bnQsIC5mb2xkZXItcm93OmZvY3VzLXdpdGhpbiAuZm9sZGVyLWNvdW50IHsgdmlzaWJpbGl0eTogaGlkZGVuOyB9Ci5mb2xkZXItcm93OmhhcyguZm9sZGVyLWJ0blthcmlhLWN1cnJlbnQ9InRydWUiXSkgLmZvbGRlci1tZW51IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci5mb2xkZXItcm93LmVkaXRpbmcgeyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBhbGlnbi1pdGVtczogc3RyZXRjaDsgcGFkZGluZy10b3A6IDJweDsgcGFkZGluZy1ib3R0b206IDJweDsgfQouZm9sZGVyLWVkaXQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgcGFkZGluZy1sZWZ0OiAxMHB4OyBjb2xvcjogdmFyKC",
"0tZmctMik7IH0KLmZvbGRlci1pbnB1dCB7IGhlaWdodDogMzRweDsgZmxleDogMTsgbWluLXdpZHRoOiAwOyB9Ci5mb2xkZXItZXJyb3IgeyBwYWRkaW5nOiA0cHggNHB4IDJweCAzNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci8qIFRoZSBhcnJvdyB0aGF0IGZvbGRzIGEgZm9sZGVyJ3Mgc3ViZm9sZGVycyBhd2F5OiBhIGNvbHVtbiBvZiBpdHMgb3duLAogICBvbmNlIHNvbWUgZm9sZGVyIGhhcyBzdWJmb2xkZXJzLCBzbyBldmVyeSBmb2xkZXIncyBpY29uIGxpbmVzIHVwLiAqLwouZm9sZGVyLXR3aXN0eSB7CiAgZmxleDogbm9uZTsKICBkaXNwbGF5OiBub25lOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDIwcHg7CiAgaGVpZ2h0OiAzNnB4OwogIG1hcmdpbi1yaWdodDogMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmctMyk7Cn0KLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci10d2lzdHkgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgfQpidXR0b24uZm9sZGVyLXR3aXN0eTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQouZm9sZGVyLXR3aXN0eSAuaWNvbiB7IHRyYW5zaXRpb246IHRyYW5zZm9ybSAuMTVzIGVhc2U7IH0KLmZvbGRlci10d2lzdHlbYXJpYS1leHBhbmRlZD0iZmFsc2UiXSAuaWNvbiB7IHRyYW5zZm9ybTogcm",
"90YXRlKC05MGRlZyk7IH0KLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci1lZGl0IHsgcGFkZGluZy1sZWZ0OiAzMnB4OyB9Ci5mb2xkZXItaXRlbXNbZGF0YS1uZXN0ZWRdIC5mb2xkZXItZXJyb3IgeyBwYWRkaW5nLWxlZnQ6IDU4cHg7IH0KLyogRm9sZGVkLCB3aXRoIHRoZSBmb2xkZXIgYmVpbmcgbG9va2VkIGF0IGluc2lkZSBpdC4gKi8KLmZvbGRlci1idG4uaG9sZHMtY3VycmVudCB7IGNvbG9yOiB2YXIoLS1mZyk7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLm5vdGVzLXNjb3BlIHsgZmxleDogbm9uZTsgcGFkZGluZzogMCAyMHB4IDZweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IHdoaXRlLXNwYWNlOiBub3dyYXA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB9Ci5ub3Rlcy1saXN0IHsKICBmbGV4OiAwIDAgMzIwcHg7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIG1pbi1oZWlnaHQ6IDA7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwp9Ci5ub3Rlcy10b29scyB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nOiAxMnB4IDEycHggOHB4OyBmbGV4OiBub25lOyB9Ci5ub3Rlcy10b29scyAuc2VhcmNoLWJveCB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IH0KLm5vdGVzLX",
"Rvb2xzIC5idG4geyBoZWlnaHQ6IDQwcHg7IHBhZGRpbmc6IDAgMTZweCAwIDEycHg7IGZsZXg6IG5vbmU7IH0KLm5vdGVzLWl0ZW1zIHsgZmxleDogMTsgb3ZlcmZsb3cteTogYXV0bzsgcGFkZGluZzogMCA4cHggOHB4OyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDJweDsgfQoubm90ZS1pdGVtIHsKICBkaXNwbGF5OiBibG9jazsKICB3aWR0aDogMTAwJTsKICBwYWRkaW5nOiAxMHB4IDEycHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5ub3RlLWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLm5vdGUtaXRlbVthcmlhLWN1cnJlbnQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLm5pLXRvcCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBiYXNlbGluZTsgZ2FwOiA4cHg7IH0KLm5pLXRpdGxlIHsKICBmbGV4OiAxOwogIG1pbi13aWR0aDogMDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgZm9udC1zaXplOiAxNHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgY29sb3I6IHZhcigtLWZnKTsKfQoubmktc25pcHBldCB7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydG",
"ljYWw7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKICBtYXJnaW4tdG9wOiAycHg7CiAgZm9udC1zaXplOiAxM3B4OwogIGxpbmUtaGVpZ2h0OiAxOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKfQoubmktbWV0YSB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiA0cHggMTBweDsgbWFyZ2luLXRvcDogM3B4OyB9Ci5uaS1tZXRhOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQoubmktZm9sZGVyIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogM3B4OyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubmktbWFpbCB7IGZvbnQtc2l6ZTogMTFweDsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLmRyYWdnaW5nLW5vdGUgLm5vdGUtaXRlbVthcmlhLWN1cnJlbnQ9InRydWUiXSB7IGJveC1zaGFkb3c6IG5vbmU7IH0KLm5lLWZvbGRlciB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDRweDsKICBoZWlnaHQ6IDMycHg7CiAgbWF4LXdpZHRoOiAyNjBweDsKICBtYXJnaW4tcmlnaHQ6IDRweDsKICBwYWRkaW5nOiAwIDRweCAwIDEwcHg7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxM3B4OwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLm5lLWZvbGRlciBzcGFuIHsgb3ZlcmZsb3c6IGhpZGRlbj",
"sgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IH0KLm5lLWZvbGRlcjpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQovKiBTZWFyY2g6IHRoZSB3b3JkcyBtYXJrZWQgaW4gcmVzdWx0cywgYW5kIGluIHRoZSBvcGVuIG5vdGUuICovCm1hcmsgeyBiYWNrZ3JvdW5kOiB2YXIoLS1tYXJrKTsgY29sb3I6IGluaGVyaXQ7IGJvcmRlci1yYWRpdXM6IDJweDsgcGFkZGluZzogMCAxcHg7IH0KLyogT25seSB0aGUgcGhvbmUgYXBwLCB3aGljaCBzaG93cyBvbmUgcGFuZSBhdCBhIHRpbWUsIG5lZWRzIGEgd2F5IGJhY2ssCiAgIGFuZCBhIGJ1dHRvbiB0byBmb2xkIHRoZSBmb2xkZXIgdHJlZSBhd2F5LiAqLwoubmUtYmFjaywgLmZvbGRlcnMtdG9nZ2xlIHsgZGlzcGxheTogbm9uZTsgfQoubmktZXhjZXJwdHMgeyBkaXNwbGF5OiBibG9jazsgbWFyZ2luLXRvcDogM3B4OyB9Ci5uaS1leGNlcnB0IHsKICBkaXNwbGF5OiBibG9jazsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTMpOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9Ci5uaS1leGNlcnB0ICsgLm5pLWV4Y2VycHQgeyBtYXJnaW4tdG9wOiAzcHg7IH0KLm5pLWV4Y2VycHQgbWFyaywgLm5pLXNuaXBwZXQgbWFyaywgLm5pLXRpdGxlIG1hcmsgeyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5uaS1oaXRzIHsgZm9udC1zaXplOiAxMXB4OyBjb2xvcjogdmFyKC0tYWNjZW",
"50KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQo6OmhpZ2hsaWdodChna2ItbWF0Y2gpIHsgYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tbWFyayk7IH0KOjpoaWdobGlnaHQoZ2tiLW1hdGNoLWN1cnJlbnQpIHsgYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tbWFyay1jdXJyZW50KTsgY29sb3I6IHZhcigtLW9uLW1hcmstY3VycmVudCk7IH0KLm5lLWZpbmQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBtYXJnaW46IDRweCAyMHB4IDA7CiAgcGFkZGluZzogMnB4IDRweCAycHggMTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQtc2l6ZTogMTNweDsKICBmbGV4OiBub25lOwp9Ci5uZS1maW5kIC5maW5kLXdvcmRzIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgY29sb3I6IHZhcigtLWZnKTsgfQoubmUtZmluZCAuZmluZC1wb3MgeyB3aGl0ZS1zcGFjZTogbm93cmFwOyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9Ci5uZS1maW5kIC5pY29uLWJ0biB7IHdpZHRoOiAzMnB4OyBoZWlnaHQ6IDMycHg7IH0KLm5vdGVzLWVtcHR5IHsgcGFkZGluZzogMjRweCAxMnB4OyB0ZXh0LWFsaWduOiBjZW50ZXI7IGZvbnQtc2l6ZTogMTNweDsgY29sb3I6IHZhci",
"gtLWZnLTMpOyB9Ci5ub3Rlcy1lbXB0eSBwIHsgbWFyZ2luOiAwIDAgOHB4OyB9Ci5ub3Rlcy1mb290IHsgZmxleDogbm9uZTsgcGFkZGluZzogOHB4IDE2cHggMTJweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLm5vdGVzLWZvb3Q6ZW1wdHkgeyBkaXNwbGF5OiBub25lOyB9Cgoubm90ZS1lZGl0b3IgewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0xKTsKfQoubmUtYmFyIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA0cHg7IHBhZGRpbmc6IDhweCAxMHB4IDAgMjhweDsgZmxleDogbm9uZTsgbWluLWhlaWdodDogNDhweDsgfQoubmUtc3RhdHVzIHsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IHdoaXRlLXNwYWNlOiBub3dyYXA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyBtaW4td2lkdGg6IDA7IH0KLm5lLXN0YXR1cy5lcnJvciB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci5uZS1iYW5uZXIgewogIG1hcmdpbjogNHB4IDI4cHggMDsKICBwYWRkaW5nOiAxMHB4IDE0cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7CiAgY2",
"9sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDEuNDU7CiAgZmxleDogbm9uZTsKfQoubmUtdGl0bGUgewogIGJvcmRlcjogMDsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKfQoubmUtdGl0bGUgeyBmbGV4OiBub25lOyBwYWRkaW5nOiA4cHggMjhweCA2cHg7IGZvbnQtc2l6ZTogMjRweDsgbGluZS1oZWlnaHQ6IDEuMzsgfQoubmUtYm9keSB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGZsZXg6IDE7CiAgbWluLWhlaWdodDogMDsKICBvdmVyZmxvdy15OiBhdXRvOwogIHBhZGRpbmc6IDEwcHggMjhweCAyOHB4OwogIGZvbnQtc2l6ZTogMTVweDsKICBsaW5lLWhlaWdodDogMS42OwogIHdoaXRlLXNwYWNlOiBwcmUtd3JhcDsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKICBvdXRsaW5lOiBub25lOwogIGNvdW50ZXItcmVzZXQ6IG9sMCBvbDEgb2wyIG9sMzsKfQoubmUtdGl0bGU6OnBsYWNlaG9sZGVyIHsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci8qIFRoZSBzY3JhdGNocGFkOiBpdHMgb3duIGNvbG91ciwgYSBmaXhlZCBuYW1lLCBhbmQgcGlubmVkIGluIHRoZSBsaXN0LiAqLwoubm90ZS1lZGl0b3Iuc2NyYXRjaCB7IGJhY2tncm91bmQ6IHZhcigtLXNjcmF0Y2gpOyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxcHggdmFyKC0tc2NyYXRjaC1lZGdlKSwgdmFyKC",
"0tc2hhZG93LTEpOyB9Ci5ub3RlLWVkaXRvci5zY3JhdGNoIC5uZS10b29sYmFyIHsgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLXNjcmF0Y2gtZWRnZSkgNDUlLCB0cmFuc3BhcmVudCk7IH0KLm5vdGUtZWRpdG9yLnNjcmF0Y2ggLm5lLWJhcjplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KLnNjcmF0Y2gtdGl0bGUgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEwcHg7IG1hcmdpbjogMDsgcGFkZGluZy10b3A6IDE4cHg7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLnNjcmF0Y2gtdGl0bGUgLnN0LW5hbWUgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IH0KLnNjcmF0Y2gtdGl0bGUgLm5lLXN0YXR1cyB7IGZvbnQtc2l6ZTogMTJweDsgfQouc2NyYXRjaC10aXRsZSAuaWNvbiB7IGNvbG9yOiB2YXIoLS1zY3JhdGNoLWluayk7IH0KLnNjcmF0Y2gtaXRlbSB7IG1hcmdpbi1ib3R0b206IDRweDsgYmFja2dyb3VuZDogdmFyKC0tc2NyYXRjaCk7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDFweCB2YXIoLS1zY3JhdGNoLWVkZ2UpOyB9Ci5zY3JhdGNoLWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc2NyYXRjaCkgODUlLCB2YXIoLS1zY3JhdGNoLWVkZ2UpKTsgfQouc2NyYXRjaC1pdGVtW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tc2NyYXRjaCk7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDJweCB2YXIoLS",
"1zY3JhdGNoLWVkZ2UpLCB2YXIoLS1zaGFkb3ctMSk7IH0KLnNjcmF0Y2gtaXRlbSAubmktdGl0bGUgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDZweDsgZm9udC13ZWlnaHQ6IDUwMDsgfQouc2NyYXRjaC1pdGVtIC5uaS10aXRsZSAuaWNvbiB7IGZsZXg6IG5vbmU7IGNvbG9yOiB2YXIoLS1zY3JhdGNoLWluayk7IH0KLm5lLXRpdGxlOmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiBub25lOyB9Ci5uZS10aXRsZTpkaXNhYmxlZCwgLm5lLWJvZHlbYXJpYS1kaXNhYmxlZD0idHJ1ZSJdIHsgb3BhY2l0eTogLjY7IH0KLm5lLWJvZHlbZGF0YS1lbXB0eT0iMSJdOjpiZWZvcmUgewogIGNvbnRlbnQ6IGF0dHIoZGF0YS1wbGFjZWhvbGRlcik7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHRvcDogMTBweDsKICBsZWZ0OiAyOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKfQoKLyogQmxvY2tzOiBvbmUgcGVyIHBhcmFncmFwaCwgaGVhZGluZyBvciBsaXN0IGl0ZW0uIEJ1bGxldHMsIG51bWJlcnMgYW5kCiAgIGJveGVzIGFyZSBkcmF3biBoZXJlLCBpbiBlYWNoIGJsb2NrJ3MgbGVmdCBwYWRkaW5nLiAqLwouYmxrIHsgcG9zaXRpb246IHJlbGF0aXZlOyBtaW4taGVpZ2h0OiAxLjZlbTsgLS1sdmw6IDA7IH0KLmJsa1tkYXRhLWxldmVsPSIxIl0geyAtLWx2bDogMTsgfQouYmxrW2RhdGEtbGV2ZWw9IjIiXSB7IC0tbHZsOiAyOyB9Ci5ibGtbZGF0YS1sZX",
"ZlbD0iMyJdIHsgLS1sdmw6IDM7IH0KLmJsa1tkYXRhLXR5cGU9ImgxIl0geyBmb250LXNpemU6IDI0cHg7IGxpbmUtaGVpZ2h0OiAxLjM7IGZvbnQtd2VpZ2h0OiA2MDA7IG1hcmdpbjogMTRweCAwIDRweDsgfQouYmxrW2RhdGEtdHlwZT0iaDIiXSB7IGZvbnQtc2l6ZTogMjBweDsgbGluZS1oZWlnaHQ6IDEuMzU7IGZvbnQtd2VpZ2h0OiA2MDA7IG1hcmdpbjogMTJweCAwIDJweDsgfQouYmxrW2RhdGEtdHlwZT0iaDMiXSB7IGZvbnQtc2l6ZTogMTdweDsgbGluZS1oZWlnaHQ6IDEuNDsgZm9udC13ZWlnaHQ6IDYwMDsgbWFyZ2luOiAxMHB4IDAgMnB4OyB9Ci5ibGs6Zmlyc3QtY2hpbGQgeyBtYXJnaW4tdG9wOiAwOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdLCAuYmxrW2RhdGEtdHlwZT0ib2wiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl0geyBwYWRkaW5nLWxlZnQ6IGNhbGMoMjhweCArIHZhcigtLWx2bCkgKiAyNHB4KTsgfQouYmxrW2RhdGEtdHlwZT0idWwiXTo6YmVmb3JlIHsKICBjb250ZW50OiAnXFwyMDIyJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgbGVmdDogY2FsYyg5cHggKyB2YXIoLS1sdmwpICogMjRweCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjEiXTo6YmVmb3JlIHsgY29udGVudDogJ1xcMjVFNic7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMiJdOjpiZWZvcmUsIC5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbG",
"V2ZWw9IjMiXTo6YmVmb3JlIHsgY29udGVudDogJ1xcMjVBQSc7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl06OmJlZm9yZSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGModmFyKC0tbHZsKSAqIDI0cHgpOwogIHdpZHRoOiAyMnB4OwogIHRleHQtYWxpZ246IHJpZ2h0OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOwp9Ci8qIE51bWJlcmluZyByZXN0YXJ0cyB3aGVuZXZlciB0aGUgcnVuIG9mIG51bWJlcmVkIGl0ZW1zIGF0IGEgbGV2ZWwgaXMKICAgYnJva2VuIGJ5IGFueXRoaW5nIHNoYWxsb3dlciBvciBieSBhIG5vbi1saXN0IGJsb2NrLiAqLwouYmxrOm5vdChbZGF0YS10eXBlPSJ1bCJdKTpub3QoW2RhdGEtdHlwZT0ib2wiXSk6bm90KFtkYXRhLXR5cGU9ImNoZWNrIl0pIHsgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjAiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMCJdIHsgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjEiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMSJdIHsgY291bnRlci1yZXNldDogb2wxIG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMiJdLCAuYmxrW2RhdGEtdHlwZT0iY2hlY2siXV",
"tkYXRhLWxldmVsPSIyIl0geyBjb3VudGVyLXJlc2V0OiBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjMiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMyJdIHsgY291bnRlci1yZXNldDogb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjAiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDA7IGNvdW50ZXItcmVzZXQ6IG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjEiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDE7IGNvdW50ZXItcmVzZXQ6IG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMiJdIHsgY291bnRlci1pbmNyZW1lbnQ6IG9sMjsgY291bnRlci1yZXNldDogb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjMiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMCJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMCkgJy4nOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjEiXTo6YmVmb3JlIHsgY29udGVudDogY291bnRlcihvbDEsIGxvd2VyLWFscGhhKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMiJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMiwgbG93ZXItcm9tYW4pICcuJzsgfQouYmxrW2RhdGEtdHlwZT0ib2",
"wiXVtkYXRhLWxldmVsPSIzIl06OmJlZm9yZSB7IGNvbnRlbnQ6IGNvdW50ZXIob2wzKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl06OmJlZm9yZSB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGMoM3B4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOwogIHRvcDogY2FsYyguOGVtIC0gOXB4KTsKICB3aWR0aDogMTRweDsKICBoZWlnaHQ6IDE0cHg7CiAgYm9yZGVyOiAycHggc29saWQgdmFyKC0tZmctMyk7CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGN1cnNvcjogcG9pbnRlcjsKfQouYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWNoZWNrZWQ9IjEiXTo6YmVmb3JlIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5ibGtbZGF0YS10eXBlPSJjaGVjayJdW2RhdGEtY2hlY2tlZD0iMSJdOjphZnRlciB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGMoOXB4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOwogIHRvcDogY2FsYyguOGVtIC0gN3B4KTsKICB3aWR0aDogNXB4OwogIGhlaWdodDogMTBweDsKICBib3JkZXI6IHNvbGlkIHZhcigtLW9uLWFjY2VudCk7CiAgYm9yZGVyLXdpZHRoOiAwIDJweCAycHggMDsKICB0cmFuc2Zvcm06IHJvdGF0ZSg0NWRlZyk7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7Cn0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1jaGVja2VkPSIxIl",
"0geyBjb2xvcjogdmFyKC0tZmctMyk7IHRleHQtZGVjb3JhdGlvbjogbGluZS10aHJvdWdoOyB9Ci5uZS1ib2R5IGEgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7IGN1cnNvcjogdGV4dDsgfQoKLyogRm9ybWF0dGluZyB0b29sYmFyIGFuZCB0aGUgbGluayBmaWVsZCBiZW5lYXRoIGl0LiAqLwoubmUtdG9vbGJhciB7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LXdyYXA6IHdyYXA7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBtYXJnaW46IDJweCAyMHB4IDA7CiAgcGFkZGluZzogNHB4IDZweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgZmxleDogbm9uZTsKfQoudGItYnRuIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIHdpZHRoOiAzMnB4OwogIGhlaWdodDogMzJweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci50Yi1idG46aG92ZXI6bm90KDpkaXNhYmxlZCksIC50Yi1zdHlsZTpob3Zlcjpub3QoOmRpc2FibGVkKSB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQoudGItYnRuW2FyaWEtcHJlc3NlZD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci",
"50Yi1idG46ZGlzYWJsZWQsIC50Yi1zdHlsZTpkaXNhYmxlZCB7IG9wYWNpdHk6IC40OyB9Ci50Yi1zdHlsZSB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCA0cHggMCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNTAwOwp9Ci50Yi1zdHlsZS1sYWJlbCB7IG1pbi13aWR0aDogODRweDsgdGV4dC1hbGlnbjogbGVmdDsgfQoudGItc2VwIHsgd2lkdGg6IDFweDsgaGVpZ2h0OiAyMHB4OyBtYXJnaW46IDAgNnB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1ib3JkZXItc3Ryb25nKTsgb3BhY2l0eTogLjY7IH0KLm5lLWxpbmtiYXIgewogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC13cmFwOiB3cmFwOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgbWFyZ2luOiA2cHggMjBweCAwOwogIHBhZGRpbmc6IDZweCA4cHggNnB4IDEycHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmbGV4OiBub25lOwp9Ci5uZS1saW5rYmFyIC50ZXh0LWlucHV0IHsgZmxleDogMTsgbWluLXdpZHRoOiAxODBweDsgaGVpZ2h0OiAzNHB4OyB9Ci5uZS1saW5rYmFyIC5idG4geyBoZWlnaHQ6IDM0cHg7IH0KLmxpbmstZXJyb3",
"IgeyBmbGV4LWJhc2lzOiAxMDAlOyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgZm9udC1zaXplOiAxMnB4OyB9Ci5saW5rLWVycm9yOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQoKLyog4pSA4pSAIENvbHVtbiBzZXR0aW5ncyBkcmF3ZXIg4pSA4pSAICovCgouc2NyaW0geyBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOyB6LWluZGV4OiA1OyBiYWNrZ3JvdW5kOiB2YXIoLS1zY3JpbSk7IH0KLmRyYXdlciB7CiAgcG9zaXRpb246IGZpeGVkOwogIHotaW5kZXg6IDY7CiAgdG9wOiAwOwogIHJpZ2h0OiAwOwogIGJvdHRvbTogMDsKICB3aWR0aDogbWluKDQ2MHB4LCAxMDB2dyk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTMpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKICBmb250LXNpemU6IDE0cHg7CiAgYW5pbWF0aW9uOiBkcmF3ZXItaW4gLjE4cyBlYXNlLW91dDsKfQpAa2V5ZnJhbWVzIGRyYXdlci1pbiB7IGZyb20geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMjRweCk7IG9wYWNpdHk6IDA7IH0gdG8geyB0cmFuc2Zvcm06IG5vbmU7IG9wYWNpdHk6IDE7IH0gfQouZHJhd2VyLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgcGFkZGluZzogMTJweCAxMnB4IDRweCAyNHB4OyBmbGV4OiBub25lOy",
"B9Ci5kcmF3ZXItaGVhZCBoMiB7IG1hcmdpbjogMDsgZmxleDogMTsgZm9udC1zaXplOiAyMHB4OyBmb250LXdlaWdodDogNDAwOyB9Ci5kcmF3ZXItaW50cm8geyBtYXJnaW46IDA7IHBhZGRpbmc6IDAgMjRweCAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IGZvbnQtc2l6ZTogMTNweDsgbGluZS1oZWlnaHQ6IDEuNTsgZmxleDogbm9uZTsgfQouZHJhd2VyLWJvZHkgeyBmbGV4OiAxOyBvdmVyZmxvdy15OiBhdXRvOyBwYWRkaW5nOiA0cHggMjRweCAxNnB4OyB9Ci5jb2wtcm93IHsKICBkaXNwbGF5OiBncmlkOwogIGdhcDogMTBweDsKICBtYXJnaW4tYm90dG9tOiAxMnB4OwogIHBhZGRpbmc6IDEycHggMTJweCAxMHB4IDE0cHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5yb3ctaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMnB4OyB9Ci5yb3ctaGVhZCAucm93LW51bSB7CiAgd2lkdGg6IDIycHg7CiAgaGVpZ2h0OiAyMnB4OwogIG1hcmdpbi1yaWdodDogOHB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwogIGZsZXg6IG5vbmU7Cn0KLnJvdy1oZWFkIC5yb3ctdGl0bG",
"UgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IGZvbnQtd2VpZ2h0OiA1MDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9Ci5maWVsZCB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogNHB4OyB9Ci5maWVsZC1sYWJlbCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTIpOyB9Ci50ZXh0LWlucHV0IHsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDM4cHg7CiAgcGFkZGluZzogMCAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQ6IGluaGVyaXQ7CiAgZm9udC1zaXplOiAxNHB4Owp9Ci50ZXh0LWlucHV0OmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogLTFweDsgYm9yZGVyLWNvbG9yOiB0cmFuc3BhcmVudDsgfQouZmllbGQtaGVscCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jaGVjayB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMik7IGN1cnNvcjogcG9pbnRlcjsgfQouY2hlY2sgaW5wdXQgeyB3aWR0aDogMThweDsgaGVpZ2h0OiAxOHB4OyBtYXJnaW46IDA7IGFjY2",
"VudC1jb2xvcjogdmFyKC0tYWNjZW50KTsgfQouYWRkLWNvbCB7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDQ0cHg7IGJvcmRlci1yYWRpdXM6IDE2cHg7IGJvcmRlcjogMS41cHggZGFzaGVkIHZhcigtLWJvcmRlci1zdHJvbmcpOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQouYWRkLWNvbDpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQouZHJhd2VyLWZvb3QgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMnB4IDIwcHggMTZweCAyNHB4OwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGZsZXg6IG5vbmU7Cn0KLmRyYXdlci1mb290IC5ub3RlIHsgZmxleDogMTsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGxpbmUtaGVpZ2h0OiAxLjQ1OyB9Ci5mb3JtLWVycm9yIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTNweDsgcGFkZGluZzogMCAyNHB4IDhweDsgZmxleDogbm9uZTsgfQouZm9ybS1lcnJvcjplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KCi8qIOKUgOKUgCBDYXJkIGVkaXRvciDilIDilIAgKi8KCi5kaWFsb2cgewogIHBvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiA2OwogIHRvcDogNTAlOwogIGxlZnQ6IDUwJTsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTAlLCAtNTAlKTsKICB3aWR0aDogbWluKDQ4MHB4LCBjYWxjKDEwMH",
"Z3IC0gMzJweCkpOwogIG1heC1oZWlnaHQ6IGNhbGMoMTAwdmggLSAzMnB4KTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYm9yZGVyLXJhZGl1czogMjRweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmcpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGFuaW1hdGlvbjogZGlhbG9nLWluIC4xNnMgZWFzZS1vdXQ7Cn0KQGtleWZyYW1lcyBkaWFsb2ctaW4geyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGUoLTUwJSwgLTQ3JSk7IH0gdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTAlLCAtNTAlKTsgfSB9Ci5kaWFsb2ctaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nOiAxNHB4IDEycHggMnB4IDI0cHg7IGZsZXg6IG5vbmU7IH0KLmRpYWxvZy1oZWFkIGgyIHsgbWFyZ2luOiAwOyBmbGV4OiAxOyBmb250LXNpemU6IDIwcHg7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLmRpYWxvZy1ib2R5IHsgZGlzcGxheTogZ3JpZDsgZ2FwOiAxOHB4OyBwYWRkaW5nOiAxMHB4IDI0cHggMThweDsgb3ZlcmZsb3cteTogYXV0bzsgfQouZGlhbG9nLWZvb3QgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYW",
"RkaW5nOiAxMnB4IDIwcHggMTZweCAyNHB4OwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGZsZXg6IG5vbmU7Cn0KLmRpYWxvZy1mb290IC5ub3RlIHsgZmxleDogMTsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGxpbmUtaGVpZ2h0OiAxLjQ1OyB9Ci50ZXh0LWFyZWEgeyBoZWlnaHQ6IGF1dG87IG1pbi1oZWlnaHQ6IDgwcHg7IHBhZGRpbmc6IDlweCAxMnB4OyBsaW5lLWhlaWdodDogMS40NTsgcmVzaXplOiB2ZXJ0aWNhbDsgfQouaGVscC1yb3cgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogYmFzZWxpbmU7IGdhcDogNHB4IDEwcHg7IGZsZXgtd3JhcDogd3JhcDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmhlbHAtcm93IC5zdWJqZWN0LXJlZiB7IGNvbG9yOiB2YXIoLS1mZy0yKTsgb3ZlcmZsb3ctd3JhcDogYW55d2hlcmU7IH0KLmxpbmstYnRuIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IGZvbnQtc2l6ZTogMTJweDsgZm9udC13ZWlnaHQ6IDUwMDsgYm9yZGVyLXJhZGl1czogNHB4OyB9Ci5saW5rLWJ0bjpob3ZlciB7IHRleHQtZGVjb3JhdGlvbjogdW5kZXJsaW5lOyB9Ci5zd2F0Y2hlcyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiAxMHB4OyBwYWRkaW5nOiAycHggMDsgfQouc3dhdGNoIHsgcG9zaXRpb246IHJlbGF0aXZlOyB3aWR0aDogMjhweDsgaGVpZ2h0OiAyOHB4OyBjdXJzb3I6IHBvaW50ZX",
"I7IH0KLnN3YXRjaCBpbnB1dCB7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgaW5zZXQ6IDA7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDEwMCU7IG1hcmdpbjogMDsgb3BhY2l0eTogMDsgY3Vyc29yOiBwb2ludGVyOyB9Ci5zd2F0Y2gtZG90IHsKICBkaXNwbGF5OiBibG9jazsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDEwMCU7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLXN0cmlwZSk7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJzOwp9Ci5zd2F0Y2hbZGF0YS1jb2xvdXI9Im5vbmUiXSAuc3dhdGNoLWRvdCB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgdHJhbnNwYXJlbnQgNDUlLCB2YXIoLS1ib3JkZXItc3Ryb25nKSA0NSUsIHZhcigtLWJvcmRlci1zdHJvbmcpIDU1JSwgdHJhbnNwYXJlbnQgNTUlKSwgdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMS41cHggdmFyKC0tYm9yZGVyLXN0cm9uZyk7Cn0KLnN3YXRjaCBpbnB1dDpjaGVja2VkICsgLnN3YXRjaC1kb3QgeyBib3gtc2hhZG93OiAwIDAgMCAycHggdmFyKC0tc3VyZmFjZSksIDAgMCAwIDRweCB2YXIoLS1mZy0yKTsgfQouc3dhdGNoW2RhdGEtY29sb3VyPSJub25lIl0gaW5wdXQ6Y2hlY2tlZCArIC5zd2F0Y2gtZG90IHsKICBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxLjVweCB2YXIoLS1ib3JkZXItc3Ryb25nKSwgMCAwIDAgMnB4IHZhcigtLXN1cmZhY2UpLCAwIDAgMC",
"A0cHggdmFyKC0tZmctMik7Cn0KLnN3YXRjaCBpbnB1dDpmb2N1cy12aXNpYmxlICsgLnN3YXRjaC1kb3QgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogNXB4OyB9Cgouc3Itb25seSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHdpZHRoOiAxcHg7CiAgaGVpZ2h0OiAxcHg7CiAgcGFkZGluZzogMDsKICBtYXJnaW46IC0xcHg7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBjbGlwOiByZWN0KDAgMCAwIDApOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgYm9yZGVyOiAwOwp9CmA7CgogIC8vIOKUgOKUgCBDYWxlbmRhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIFdpZGU6IHRoZSB3ZWVrIGFzIHNldmVuIGNvbHVtbnMgKG9yIHRoZSBtb250aCwgb3IgdGhlIGFnZW5kYSkgYmVzaWRlCiAgLy8gYSBzaWRlYmFyLiBOYXJyb3cgKGRhdGEtbmFycm93LCBzZXQgZnJvbSB0aGUgdmlldydzIG93biB3aWR0aCk6IHRoZQogIC8vIHdlZWsgYXMgdHdvIGNvbHVtbnMgb2YgZGF5IHRpbGVzLCByZWFkIGRvd24gdGhlbiBhY3Jvc3MsIHdpdGggdGhlCiAgLy8gc21hbGwgbW9udGggYXMgdGhlIGVpZ2h0aCB0aWxlIG",
"FuZCB0aGUgc2lkZWJhcidzIHBhcnRzIHNwcmVhZCBhYm92ZQogIC8vIGFuZCBiZWxvdy4KCiAgY29uc3QgQ0FMRU5EQVIgPSBgCi5jYWwgewogIGZsZXg6IDE7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIG1pbi13aWR0aDogMDsKICBtaW4taGVpZ2h0OiAwOwogIHBhZGRpbmc6IDAgMjBweCAyMHB4Owp9Ci5jYWwtaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBoZWlnaHQ6IDUycHg7IGZsZXg6IG5vbmU7IH0KLmNhbC1uYXYgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDJweDsgZmxleDogbm9uZTsgfQouY2FsLW9yZGVyIHsgZGlzcGxheTogbm9uZTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1vcmRlciB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyB9Ci5idG4tb3V0bGluZSB7IGhlaWdodDogMzRweDsgcGFkZGluZzogMCAxNnB4OyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsgY29sb3I6IHZhcigtLWZnKTsgbWFyZ2luLXJpZ2h0OiA0cHg7IH0KLmJ0bi1vdXRsaW5lOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5jYWwtdGl0bGUgewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIG1hcmdpbjogMCAwIDAgNnB4OwogIGZvbnQtc2l6ZTogMjBweDsKICBmb250LXdlaWdodDogNDAwOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgb3ZlcmZsb3",
"c6IGhpZGRlbjsKICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsKfQouY2FsLXZpZXdzIHsgZGlzcGxheTogZmxleDsgZ2FwOiAycHg7IHBhZGRpbmc6IDNweDsgYm9yZGVyLXJhZGl1czogMjBweDsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBmbGV4OiBub25lOyB9Ci5zZWcgeyBoZWlnaHQ6IDMwcHg7IHBhZGRpbmc6IDAgMTRweDsgYm9yZGVyLXJhZGl1czogMTVweDsgY29sb3I6IHZhcigtLWZnLTIpOyBmb250LXdlaWdodDogNTAwOyBmb250LXNpemU6IDEzLjVweDsgfQouc2VnOmhvdmVyIHsgY29sb3I6IHZhcigtLWZnKTsgfQouc2VnW2FyaWEtc2VsZWN0ZWQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBjb2xvcjogdmFyKC0tZmcpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KCi5jYWwtbm90ZSB7CiAgZmxleDogbm9uZTsKICBtYXJnaW46IDAgMCAxMHB4OwogIHBhZGRpbmc6IDhweCAxNHB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxM3B4OwogIGxpbmUtaGVpZ2h0OiAxLjQ1Owp9Ci5jYWwtbm90ZSBwIHsgbWFyZ2luOiAwOyB9Ci5jYWwtbm90ZSBwICsgcCB7IG1hcmdpbi10b3A6IDRweDsgfQouY2FsLW5vdGUgc3Ryb25nIHsgY29sb3I6IHZhcigtLWZnKTsgZm9udC13ZWlnaHQ6IDUwMDsgfQ",
"ouY2FsLW5vdGUgYSwgLmNhbCAucGFuZWwgYSB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB3b3JkLWJyZWFrOiBicmVhay1hbGw7IH0KLmNhbC1ub3RlIC5idG4geyBoZWlnaHQ6IDI4cHg7IG1hcmdpbi1sZWZ0OiA0cHg7IH0KLmNhbC1ub3RlIGEuYnRuIHsgdGV4dC1kZWNvcmF0aW9uOiBub25lOyB3b3JkLWJyZWFrOiBub3JtYWw7IH0KCi5jYWwtYm9keSB7IGZsZXg6IDE7IGRpc3BsYXk6IGZsZXg7IGdhcDogMTJweDsgbWluLWhlaWdodDogMDsgfQouY2FsLXNpZGUgeyB3aWR0aDogMjI4cHg7IGZsZXg6IG5vbmU7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMTBweDsgb3ZlcmZsb3cteTogYXV0bzsgfQouY2FsLW1haW4geyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IG1pbi1oZWlnaHQ6IDA7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IH0KLmNhbC1taW5pLCAuY2FsLXNvdXJjZXMsIC5jYWwtdHJheSB7CiAgZmxleDogbm9uZTsKICBwYWRkaW5nOiAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKfQoKLyogVGhlIHNtYWxsIG1vbnRoICovCi5taW5pLWhlYWQgeyBtYXJnaW46IDAgMCA2cHggNHB4OyBmb250LXNpemU6IDE0cHg7IGZvbnQtd2VpZ2h0OiA1MDA7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLm1pbmktZ3JpZCB7IGRpc3BsYXk6IGdyaW",
"Q7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDcsIG1pbm1heCgwLCAxZnIpKTsgcm93LWdhcDogMnB4OyB0ZXh0LWFsaWduOiBjZW50ZXI7IH0KLm1pbmktZG93IHsgcGFkZGluZzogMnB4IDA7IGZvbnQtc2l6ZTogMTFweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5taW5pLWRheSB7IGhlaWdodDogMjZweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7IH0KLm1pbmktZGF5OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBib3JkZXItcmFkaXVzOiA4cHg7IH0KLm1pbmktZGF5Lm90aGVyIHsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5taW5pLWRheS5zaG93biB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsgfQoubWluaS1kYXkudG9kYXkgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50KTsgYm9yZGVyLXJhZGl1czogOHB4OyBmb250LXdlaWdodDogNjAwOyB9CgovKiBDYWxlbmRhcnMgYW5kIHRhc2sgbGlzdHMgKi8KLmNhbC1zb3VyY2VzIHsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAxcHg7IHBhZGRpbmc6IDZweDsgfQouc3JjIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAxMHB4OwogIGhlaWdodDogMzJweDsKICBwYWRkaW",
"5nOiAwIDhweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgY29sb3I6IHZhcigtLWZnKTsKICBmb250LXNpemU6IDEzLjVweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5zcmM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLnNyYyAuc3dhdGNoIHsKICBmbGV4OiBub25lOwogIHdpZHRoOiAxNHB4OwogIGhlaWdodDogMTRweDsKICBib3JkZXI6IDJweCBzb2xpZCB2YXIoLS1zcmMsIHZhcigtLWFjY2VudCkpOwogIGJhY2tncm91bmQ6IHZhcigtLXNyYywgdmFyKC0tYWNjZW50KSk7CiAgYm9yZGVyLXJhZGl1czogNTAlOwp9Ci5zcmMtdGFza3MgLnN3YXRjaCB7IGJvcmRlci1yYWRpdXM6IDRweDsgfQouc3JjW2FyaWEtcHJlc3NlZD0iZmFsc2UiXSAuc3dhdGNoIHsgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7IH0KLnNyY1thcmlhLXByZXNzZWQ9ImZhbHNlIl0gLnNyYy1uYW1lIHsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5zcmMtbmFtZSB7IG1pbi13aWR0aDogMDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IHdoaXRlLXNwYWNlOiBub3dyYXA7IH0KCi8qIFRhc2tzIHdpdGhvdXQgYSBkYXkgKi8KLmNhbC10cmF5IGgzIHsgbWFyZ2luOiAycHggNHB4IDZweDsgZm9udC1zaXplOiAxMi41cHg7IGZvbnQtd2VpZ2h0OiA1MDA7IGNvbG9yOiB2YXIoLS1mZy0yKTsgfQouY2FsLXRyYXkgaDMgLmNvdW50IHsgY29sb3I6IHZhcigtLWZnLTMpOyBmb250LXdlaWdodDogNDAwOy",
"B9Ci5jYWwtdHJheSAuY2FsLWl0ZW1zICsgaDMgeyBtYXJnaW4tdG9wOiAxMnB4OyB9CgovKiBEYXlzICovCi5jYWwtd2VlayB7IGZsZXg6IDE7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDcsIG1pbm1heCgwLCAxZnIpKTsgZ2FwOiA4cHg7IG1pbi1oZWlnaHQ6IDA7IH0KLmRheSB7CiAgbWluLXdpZHRoOiAwOwogIG1pbi1oZWlnaHQ6IDA7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIHBhZGRpbmc6IDhweDsKICBib3JkZXItcmFkaXVzOiAxNHB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7Cn0KLmRheS53ZWVrZW5kLCAubWNlbGwud2Vla2VuZCB7IGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1zdXJmYWNlKSA1NSUsIHZhcigtLWNvbCkpOyB9Ci5kYXkudG9kYXkgeyBwYWRkaW5nOiA3cHg7IGJvcmRlcjogMnB4IHNvbGlkIHZhcigtLWFjY2VudCk7IGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1zdXJmYWNlKSA5MiUsIHZhcigtLWFjY2VudCkpOyB9Ci5jYWwtd2VlayAuZGF5IC5jYWwtaXRlbXMgeyBmbGV4OiAxOyBtaW4taGVpZ2h0OiAwOyBvdmVyZmxvdy15OiBhdXRvOyB9Ci5kYXktaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogNnB4OyBtYXJnaW46IDAgMCA2cHggMnB4OyBmb250LXNpem",
"U6IDE0cHg7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLmRheS1oZWFkIC5kbmFtZSB7IGNvbG9yOiB2YXIoLS1mZy0yKTsgfQouZGF5LWhlYWQgLmRudW0geyBmb250LXdlaWdodDogNTAwOyB9Ci5zdW5kYXkgLmRheS1oZWFkLCAuc3VuZGF5IC5kYXktaGVhZCAuZG5hbWUsIC5tY2VsbC5zdW5kYXk6bm90KC50b2RheSkgLm1kYXksIC5hZGF5LnN1bmRheSAuYWRheS1kYXRlIHsgY29sb3I6IHZhcigtLWMtcmVkKTsgfQouYmFkZ2UgeyBwYWRkaW5nOiAxcHggN3B4OyBib3JkZXItcmFkaXVzOiA5cHg7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQpOyBmb250LXNpemU6IDExcHg7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLmRheS5wYXN0IC5pdGVtIHsgb3BhY2l0eTogLjc4OyB9Ci5taW5pLXRpbGUgeyBkaXNwbGF5OiBub25lOyB9Ci5sb2FkaW5nIC5jYWwtaXRlbXM6OmJlZm9yZSwKLmNhbC1hZ2VuZGEubG9hZGluZzo6YmVmb3JlIHsKICBjb250ZW50OiAiIjsKICBkaXNwbGF5OiBibG9jazsKICBoZWlnaHQ6IDIycHg7CiAgYm9yZGVyLXJhZGl1czogNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsKICBhbmltYXRpb246IGNhbC1wdWxzZSAxLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlIGFsdGVybmF0ZTsKfQpAa2V5ZnJhbWVzIGNhbC1wdWxzZSB7IGZyb20geyBvcGFjaXR5OiAuNDsgfSB0byB7IG9wYWNpdHk6IDE7IH0gfQoKLyogRXZlbnRzIGFuZCB0YXNrcyAqLwouY2FsLW",
"l0ZW1zIHsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiA0cHg7IG1pbi13aWR0aDogMDsgfQouaXRlbSB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNnB4OwogIG1pbi13aWR0aDogMDsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgY29sb3I6IHZhcigtLWZnKTsKICBmb250LXNpemU6IDEyLjVweDsKICBsaW5lLWhlaWdodDogMS4zOwogIHRleHQtZGVjb3JhdGlvbjogbm9uZTsKfQphLml0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kLWltYWdlOiBsaW5lYXItZ3JhZGllbnQodmFyKC0taG92ZXIpLCB2YXIoLS1ob3ZlcikpOyB9Ci5pdGVtIC50IHsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZXYgewogIHBhZGRpbmc6IDNweCA2cHg7CiAgYm9yZGVyLWxlZnQ6IDNweCBzb2xpZCB2YXIoLS1jLCB2YXIoLS1hY2NlbnQpKTsKICBiYWNrZ3JvdW5kLWNvbG9yOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYywgdmFyKC0tYWNjZW50KSkgMTQlLCB2YXIoLS1zdXJmYWNlKSk7Cn0KLmV2LmFsbC1kYXkgeyBiYWNrZ3JvdW5kLWNvbG9yOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYywgdmFyKC0tYWNjZW50KSkgMzIlLCB2YXIoLS1zdXJmYWNlKSk7IH0KLmV2IC50aW1lIHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLWZnLTIpOyBmb250LXZhcmlhbnQtbn",
"VtZXJpYzogdGFidWxhci1udW1zOyB9Ci8qIEluIGEgZGF5J3MgY29sdW1uIG9yIHRpbGUsIGEgdGl0bGUgZ2V0cyB0d28gbGluZXMgYmVmb3JlIGl0IGlzIGN1dCwKICAgYW5kIGdvZXMgdW5kZXIgaXRzIHRpbWUgd2hlbiB0aGUgdHdvIHdpbGwgbm90IGZpdCBzaWRlIGJ5IHNpZGUuICovCi5jYWwtd2VlayAuaXRlbSB7IGFsaWduLWl0ZW1zOiBmbGV4LXN0YXJ0OyB9Ci5jYWwtd2VlayAuZXYgeyBmbGV4LXdyYXA6IHdyYXA7IHJvdy1nYXA6IDA7IH0KLmNhbC13ZWVrIC5ldiAudCB7IGZsZXg6IDEgMSA2LjVlbTsgfQouY2FsLXdlZWsgLml0ZW0gLnQsIC5jYWwtdHJheSAuaXRlbSAudCB7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDI7CiAgd2hpdGUtc3BhY2U6IG5vcm1hbDsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKfQouY2FsLXdlZWsgLnRhc2sgLmJveCwgLmNhbC10cmF5IC50YXNrIC5ib3ggeyBtYXJnaW4tdG9wOiAxcHg7IH0KLnRhc2sgeyBwYWRkaW5nOiAycHggNHB4OyB9Ci50YXNrIC5ib3ggewogIGZsZXg6IG5vbmU7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICB3aWR0aDogMTRweDsKICBoZWlnaHQ6IDE0cHg7CiAgYm9yZGVyOiAxLjZweCBzb2xpZCB2YXIoLS1mZy0yKTsKICBib3JkZXItcmFkaXVzOiA0cHg7Cn",
"0KLnRhc2suZG9uZSAuYm94IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50KTsgfQoudGFzay5kb25lIC50IHsgY29sb3I6IHZhcigtLWZnLTMpOyB0ZXh0LWRlY29yYXRpb246IGxpbmUtdGhyb3VnaDsgfQoudGFzayAuZHVlIHsgZmxleDogbm9uZTsgbWFyZ2luLWxlZnQ6IGF1dG87IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyBmb250LXNpemU6IDExLjVweDsgfQoudGFzayAubWFpbCB7IGZsZXg6IG5vbmU7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBtYXJnaW4tbGVmdDogYXV0bzsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLnRhc2sgLmR1ZSArIC5tYWlsIHsgbWFyZ2luLWxlZnQ6IDRweDsgfQoKLyogTW9udGggKi8KLmNhbC1tb250aCB7IGZsZXg6IDE7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IG1pbi1oZWlnaHQ6IDA7IH0KLm1vbnRoLWRvd3MgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg3LCBtaW5tYXgoMCwgMWZyKSk7IGdhcDogNnB4OyBwYWRkaW5nLWJvdHRvbTogNHB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGZvbnQtc2l6ZTogMTJweDsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5tb250aC1ncmlkIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoNywgbWlubWF4KDAsIDFmcikpOwogIGdyaW",
"QtdGVtcGxhdGUtcm93czogcmVwZWF0KHZhcigtLXJvd3MsIDUpLCBtaW5tYXgoMCwgMWZyKSk7CiAgZ2FwOiA2cHg7CiAgbWluLWhlaWdodDogMDsKfQoubWNlbGwgewogIG1pbi13aWR0aDogMDsKICBtaW4taGVpZ2h0OiAwOwogIG92ZXJmbG93OiBoaWRkZW47CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGdhcDogMnB4OwogIHBhZGRpbmc6IDRweCA2cHggNnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKfQoubWNlbGwub3RoZXIgeyBvcGFjaXR5OiAuNTU7IH0KLm1jZWxsLnRvZGF5IHsgcGFkZGluZzogM3B4IDVweCA1cHg7IGJvcmRlcjogMnB4IHNvbGlkIHZhcigtLWFjY2VudCk7IH0KLm1kYXkgeyBhbGlnbi1zZWxmOiBmbGV4LXN0YXJ0OyBtaW4td2lkdGg6IDI0cHg7IGhlaWdodDogMjRweDsgcGFkZGluZzogMCA2cHg7IGJvcmRlci1yYWRpdXM6IDEycHg7IGZvbnQtc2l6ZTogMTIuNXB4OyBmb250LXdlaWdodDogNTAwOyB9Ci5tZGF5OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5tY2VsbC50b2RheSAubWRheSB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQpOyB9Ci5pdGVtLmNvbXBhY3QgeyBmb250LXNpemU6IDEycHg7IH0KLmV2LmNvbXBhY3QgeyBwYWRkaW5nOiAxcHggNXB4OyB9Ci5tb3",
"JlIHsgYWxpZ24tc2VsZjogZmxleC1zdGFydDsgcGFkZGluZzogMXB4IDZweDsgYm9yZGVyLXJhZGl1czogNnB4OyBjb2xvcjogdmFyKC0tZmctMik7IGZvbnQtc2l6ZTogMTJweDsgfQoubW9yZTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQoKLyogQWdlbmRhICovCi5jYWwtYWdlbmRhIHsgZmxleDogMTsgbWluLWhlaWdodDogMDsgb3ZlcmZsb3cteTogYXV0bzsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiA4cHg7IG1heC13aWR0aDogODgwcHg7IH0KLmFkYXkgeyBmbGV4OiBub25lOyBkaXNwbGF5OiBmbGV4OyBnYXA6IDE2cHg7IHBhZGRpbmc6IDEwcHggMTRweDsgYm9yZGVyLXJhZGl1czogMTRweDsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IH0KLmFkYXkudG9kYXkgeyBwYWRkaW5nOiA5cHggMTNweDsgYm9yZGVyOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsgfQouYWRheS1kYXRlIHsgZmxleDogbm9uZTsgd2lkdGg6IDg0cHg7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5hZGF5LWRhdGUgLmRudW0geyBtaW4td2lkdGg6IDEuNGVtOyBmb250LXNpemU6IDI0cHg7IGxpbmUtaGVpZ2h0OiAxOyB0ZXh0LWFsaWduOiByaWdodDsgfQouYWRheS1kYXRlIC5kbmFtZSB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOi",
"Bjb2x1bW47IGZvbnQtc2l6ZTogMTJweDsgbGluZS1oZWlnaHQ6IDEuMjU7IH0KLmFkYXktZGF0ZSAubW9uIHsgb3BhY2l0eTogLjc7IH0KLmFkYXkgLmNhbC1pdGVtcyB7IGZsZXg6IDE7IGdhcDogNHB4OyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsgfQouYWRheSAuaXRlbSB7IGZvbnQtc2l6ZTogMTMuNXB4OyB9Ci8qIFRoZSBhZ2VuZGEgaXMgYSBsaXN0OiBhIGRvdCBvZiB0aGUgY2FsZW5kYXIncyBjb2xvdXIsIG5vdCBhIGJsb2NrLiAqLwouYWRheSAuZXYgeyBwYWRkaW5nOiAzcHggNnB4OyBib3JkZXItbGVmdDogMDsgYmFja2dyb3VuZDogbm9uZTsgfQouYWRheSAuZXY6OmJlZm9yZSB7IGNvbnRlbnQ6ICIiOyBmbGV4OiBub25lOyB3aWR0aDogMTBweDsgaGVpZ2h0OiAxMHB4OyBtYXJnaW4tcmlnaHQ6IDRweDsgYm9yZGVyLXJhZGl1czogNTAlOyBiYWNrZ3JvdW5kOiB2YXIoLS1jLCB2YXIoLS1hY2NlbnQpKTsgfQouYWRheSAuZXYgLnRpbWUgeyBtaW4td2lkdGg6IDcuNWVtOyB9Ci5hZGF5IC50YXNrIHsgcGFkZGluZy1sZWZ0OiA0cHg7IH0KLmFkYXkgLnRhc2sgLm1haWwsIC5hZGF5IC50YXNrIC5kdWUgeyBtYXJnaW4tbGVmdDogNnB4OyB9Ci5lbXB0eSB7IG1hcmdpbjogMDsgY29sb3I6IHZhcigtLWZnLTMpOyBmb250LXNpemU6IDEzcHg7IH0KLmNhbC1hZ2VuZGEgPiAuZW1wdHkgeyBtYXJnaW46IDI0cHggYXV0bzsgfQoKLyogTmFycm93OiBhIHBob25lLCBvciBhIG5hcnJvdyB3aW5kb3cgKi8KLmNhbF",
"tkYXRhLW5hcnJvdz0idHJ1ZSJdIHsgcGFkZGluZzogMCAxMnB4IDE2cHg7IG92ZXJmbG93LXk6IGF1dG87IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtdmlld3MgeyBkaXNwbGF5OiBub25lOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLWhlYWQgeyBoZWlnaHQ6IDQ4cHg7IGdhcDogNHB4OyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLXRpdGxlIHsgb3JkZXI6IC0xOyBtYXJnaW46IDAgNHB4IDAgMnB4OyBmb250LXNpemU6IDE2LjVweDsgZm9udC13ZWlnaHQ6IDUwMDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmJ0bi1vdXRsaW5lIHsgaGVpZ2h0OiAzMnB4OyBwYWRkaW5nOiAwIDEycHg7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtYm9keSB7IGZsZXg6IG5vbmU7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMTBweDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1zaWRlIHsgZGlzcGxheTogY29udGVudHM7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtbWluaSB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtc291cmNlcyB7CiAgb3JkZXI6IDA7CiAgZmxleC1kaXJlY3Rpb246IHJvdzsKICBnYXA6IDZweDsKICBwYWRkaW5nOiAwIDAgMnB4OwogIGJvcmRlcjogMDsKICBiYWNrZ3JvdW5kOiBub25lOwogIG92ZXJmbG93LXg6IGF1dG87CiAgc2Nyb2xsYmFyLXdpZHRoOiBub25lOwp9Ci",
"5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuc3JjIHsKICBmbGV4OiBub25lOwogIGdhcDogN3B4OwogIGhlaWdodDogMzJweDsKICBwYWRkaW5nOiAwIDEycHggMCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN0cm9uZyk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgZm9udC1zaXplOiAxM3B4Owp9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuc3JjIC5zd2F0Y2ggeyB3aWR0aDogMTBweDsgaGVpZ2h0OiAxMHB4OyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLW1haW4geyBvcmRlcjogMTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC10cmF5IHsgb3JkZXI6IDI7IGJvcmRlci1zdHlsZTogZGFzaGVkOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLXdlZWsgewogIGZsZXg6IG5vbmU7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoMiwgbWlubWF4KDAsIDFmcikpOwogIGdyaWQtdGVtcGxhdGUtcm93czogcmVwZWF0KDQsIGF1dG8pOwogIGdyaWQtYXV0by1mbG93OiBjb2x1bW47Cn0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdW2RhdGEtb3JkZXI9ImFjcm9zcyJdIC5jYWwtd2VlayB7IGdyaWQtdGVtcGxhdGUtcm93czogbm9uZTsgZ3JpZC1hdXRvLWZsb3c6IHJvdzsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmRheSB7IG1pbi1oZWlnaHQ6IDEyMHB4OyB9Ci5jYWxbZGF0YS1uYXJyb3",
"c9InRydWUiXSAuY2FsLXdlZWsgLmRheSAuY2FsLWl0ZW1zIHsgb3ZlcmZsb3c6IHZpc2libGU7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5taW5pLXRpbGUgeyBkaXNwbGF5OiBmbGV4OyB9Ci5taW5pLXRpbGUgLm1pbmktaGVhZCB7IG1hcmdpbi1ib3R0b206IDJweDsgfQoubWluaS10aWxlIC5taW5pLWRheSB7IGhlaWdodDogMjBweDsgZm9udC1zaXplOiAxMXB4OyB9Ci5taW5pLXRpbGUgLm1pbmktZG93IHsgZm9udC1zaXplOiAxMHB4OyBwYWRkaW5nOiAwOyB9CgouY2FsLmNhbC1wYW5lbCAuY2FsLXNpZGUgeyBkaXNwbGF5OiBub25lOyB9Ci5jYWwtbWFpbiA-IC5wYW5lbCB7IG1hcmdpbjogYXV0bzsgfQpgOwoKICAvLyDilIDilIAgRG9jayDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgRE9DSyA9IGAKOmhvc3QgeyB6LWluZGV4OiAyMTQ3NDgyOTk5ICFpbXBvcnRhbnQ7IH0KCi5kb2NrIHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgbGVmdDogMTZweDsKICBib3R0b206IDE2cHg7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogOHB4OwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb2",
"50KTsKICBmb250LXNpemU6IDE0cHg7CiAgLXdlYmtpdC1mb250LXNtb290aGluZzogYW50aWFsaWFzZWQ7Cn0KLmRvY2sucmlnaHQgeyBsZWZ0OiBhdXRvOyByaWdodDogNzJweDsgfQouZG9ja1toaWRkZW5dIHsgZGlzcGxheTogbm9uZTsgfQoucGlsbCB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDQwcHg7CiAgcGFkZGluZzogMCAxNnB4IDAgMTJweDsKICBib3JkZXItcmFkaXVzOiAyMHB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTIpOwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBtYXgtd2lkdGg6IDMyMHB4Owp9Ci5waWxsOmhvdmVyIHsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTMpOyBiYWNrZ3JvdW5kLWltYWdlOiBsaW5lYXItZ3JhZGllbnQodmFyKC0taG92ZXIpLCB2YXIoLS1ob3ZlcikpOyB9Ci5waWxsIC5pY29uIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLnBpbGwub24geyBiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLnBpbGwub24gLmljb24geyBjb2xvcjogaW5oZXJpdDsgfQoucGlsbCAucGlsbC1sYWJlbCB7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB9Ci5waWxsIC",
"5jYXJldCB7IG1hcmdpbjogMCAtNnB4IDAgLTJweDsgY29sb3I6IGluaGVyaXQ7IH0KLnBpbGwtY29tcGFjdCB7IHBhZGRpbmc6IDAgMTRweCAwIDEwcHg7IH0KLnBpbGwuYnVzeSB7IG9wYWNpdHk6IC43OyB9CmA7CgogIG5zLnN0eWxlcyA9IHsgYm9hcmQ6IEJBU0UgKyBCT0FSRCArIENBTEVOREFSLCBkb2NrOiBCQVNFICsgRE9DSyB9Owp9KSgpOwo\"],[\"src/content/note-editor.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBmb3JtYXR0ZWQgbm90ZSBlZGl0b3IKLy8KLy8gQW4gZWRpdGFibGUgYXJlYSB3aXRoIGEgdG9vbGJhcjogdGV4dCBzdHlsZSAobm9ybWFsLCB0aHJlZSBoZWFkaW5ncyksCi8vIGJvbGQsIGl0YWxpYywgc3RyaWtlLXRocm91Z2gsIGJ1bGxldGVkLCBudW1iZXJlZCBhbmQgY2hlY2sgbGlzdHMgd2l0aAovLyB0aHJlZSBsZXZlbHMgb2YgbmVzdGluZywgbGlua3MsIGFuZCBjbGVhciBmb3JtYXR0aW5nLgovLwovLyBUaGUgZWRpdGFibGUgYXJlYSBpcyBhIGZsYXQgY29sdW1uIG9mIGJsb2NrcyAtIG9uZSA8ZGl2IGNsYXNzPSJibGsiPgovLyBwZ",
"XIgcGFyYWdyYXBoLCBoZWFkaW5nIG9yIGxpc3QgaXRlbSwgaXRzIGtpbmQgYW5kIGluZGVudCBpbiBkYXRhCi8vIGF0dHJpYnV0ZXMsIGJ1bGxldHMsIG51bWJlcnMgYW5kIGJveGVzIGRyYXduIGJ5IHRoZSBzdHlsZXNoZWV0LiBCb2xkLAovLyBpdGFsaWMsIHN0cmlrZS10aHJvdWdoIGFuZCBsaW5rcyB1c2UgdGhlIGJyb3dzZXIncyBvd24gZWRpdGluZwovLyBjb21tYW5kcywgd2hpY2ggaGFuZGxlIHRoZW0gd2VsbC4gTGlzdHMgYW5kIGhlYWRpbmdzIGRvIG5vdCB1c2UgdGhlbToKLy8gdGhlIGJyb3dzZXIncyBsaXN0IGNvbW1hbmRzIG5lc3QgZWxlbWVudHMgaW4gd2F5cyB0aGF0IGFyZSBoYXJkIHRvIHJlYWQKLy8gYmFjaywgc28gYmxvY2tzIGFyZSByZXN0eWxlZCBoZXJlIGRpcmVjdGx5IGluc3RlYWQuIFdoYXQgaXMgc2F2ZWQgaXMKLy8gbmV2ZXIgdGhpcyBtYXJrdXA6IGl0IGlzIHJlYWQgYmFjayBpbnRvIHRoZSBub3RlLWZvcm1hdCBtb2RlbCwgd2hpY2gKLy8gb25seSBrbm93cyB3aGF0IHRoZSB0b29sYmFyIGNhbiBtYWtlLgovLwovLyBQYXN0ZWQgdGV4dCBrZWVwcyB0aGUgZm9ybWF0dGluZyB0aGUgbW9kZWwgY2FuIGhvbGQgLSBmcm9tIFdvcmQsIEdvb2dsZQovLyBEb2NzLCBhIHdlYiBwYWdlLCBhbiBlbWFpbCwgRXhjZWwsIG9yIE1hcmtkb3duIGZyb20gYSBjaGF0IGFzc2lzdGFudCAtCi8vIHJlYWQgYnkgbm90ZS1mb3JtYXQncyBvd24gcmVhZGVyLCBzbyBhIHBhZ2UgY29waWVkIGZyb20gdGhlI",
"HdlYiBicmluZ3MKLy8gaXRzIGJvbGQgYW5kIGxpc3RzIGJ1dCBuZXZlciBpdHMgc3R5bGVzLCBpbWFnZXMgb3Igc2NyaXB0cy4gQ3RybCtTaGlmdCtWCi8vIHBhc3RlcyB0aGUgdGV4dCBhbG9uZS4gRHJvcHBlZCB0ZXh0IGlzIG5vdCB0YWtlbiBhdCBhbGwuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgb3Blbk1lbnUsIGNsb3NlTWVudSB9ID0gbnMudWk7CiAgY29uc3QgZm10ID0gbnMubm90ZUZvcm1hdDsKCiAgY29uc3QgU1RZTEVTID0gW1sncCcsICdOb3JtYWwgdGV4dCddLCBbJ2gxJywgJ0hlYWRpbmcgMSddLCBbJ2gyJywgJ0hlYWRpbmcgMiddLCBbJ2gzJywgJ0hlYWRpbmcgMyddXTsKICBjb25zdCBTVFlMRV9MQUJFTCA9IE9iamVjdC5mcm9tRW50cmllcyhTVFlMRVMpOwogIGNvbnN0IElOREVOVF9QWCA9IDI0OwoKICAvLyBUeXBlZCBhdCB0aGUgc3RhcnQgb2YgYSBwYXJhZ3JhcGggYW5kIGZvb",
"Gxvd2VkIGJ5IGEgc3BhY2UsIHRoZXNlIHR1cm4KICAvLyBpdCBpbnRvIGEgbGlzdCBvciBoZWFkaW5nIC0gdGhlIHNob3J0Y3V0cyBtb3N0IGVkaXRvcnMgc2hhcmUuCiAgY29uc3QgQVVUTyA9IFsKICAgIFsvXlstKuKAol0kLywgeyB0eXBlOiAndWwnIH1dLAogICAgWy9eMVsuKV0kLywgeyB0eXBlOiAnb2wnIH1dLAogICAgWy9eXFsgP1xdJC8sIHsgdHlwZTogJ2NoZWNrJyB9XSwKICAgIFsvXlxbW3hYXVxdJC8sIHsgdHlwZTogJ2NoZWNrJywgY2hlY2tlZDogdHJ1ZSB9XSwKICAgIFsvXiMkLywgeyB0eXBlOiAnaDEnIH1dLAogICAgWy9eIyMkLywgeyB0eXBlOiAnaDInIH1dLAogICAgWy9eIyMjJC8sIHsgdHlwZTogJ2gzJyB9XSwKICBdOwoKICAvLyDilIDilIAgTW9kZWwg4oaUIG1hcmt1cCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gc2V0QmxvY2soZWwsIHR5cGUsIGxldmVsID0gMCwgY2hlY2tlZCA9IGZhbHNlKSB7CiAgICBlbC5kYXRhc2V0LnR5cGUgPSB0eXBlOwogICAgaWYgKGZtdC5MSVNUUy5oYXModHlwZSkpIGVsLmRhdGFzZXQubGV2ZWwgPSBTdHJpbmcobGV2ZWwpOwogICAgZWxzZSBkZWxldGUgZWwuZGF0YXNldC5sZXZlbDsKICAgIGlmICh0eXBlI",
"D09PSAnY2hlY2snKSBlbC5kYXRhc2V0LmNoZWNrZWQgPSBjaGVja2VkID8gJzEnIDogJzAnOwogICAgZWxzZSBkZWxldGUgZWwuZGF0YXNldC5jaGVja2VkOwogIH0KCiAgZnVuY3Rpb24gaW5saW5lTm9kZXMocnVucykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJ1bnMubGVuZ3RoOykgewogICAgICBjb25zdCBocmVmID0gcnVuc1tpXS5ocmVmIHx8ICcnOwogICAgICBjb25zdCBncm91cCA9IFtdOwogICAgICBsZXQgaiA9IGk7CiAgICAgIHdoaWxlIChqIDwgcnVucy5sZW5ndGggJiYgKHJ1bnNbal0uaHJlZiB8fCAnJykgPT09IGhyZWYpIHsKICAgICAgICBsZXQgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHJ1bnNbal0udGV4dCk7CiAgICAgICAgZm9yIChjb25zdCBtIG9mIFsncycsICdpJywgJ2InXSkgewogICAgICAgICAgaWYgKCFydW5zW2pdW21dKSBjb250aW51ZTsKICAgICAgICAgIGNvbnN0IHcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KG0pOwogICAgICAgICAgdy5hcHBlbmRDaGlsZChub2RlKTsKICAgICAgICAgIG5vZGUgPSB3OwogICAgICAgIH0KICAgICAgICBncm91cC5wdXNoKG5vZGUpOwogICAgICAgIGorKzsKICAgICAgfQogICAgICBpZiAoaHJlZikgb3V0LnB1c2goaCgnYScsIHsgaHJlZiwgdGl0bGU6IGhyZWYgfSwgZ3JvdXApKTsKICAgICAgZWxzZSBvdXQucHVzaCguLi5ncm91cCk7CiAgICAgIGkgPSBqOwogICAgfQogICAgcmV0dXJuI",
"G91dDsKICB9CgogIGZ1bmN0aW9uIGJsb2NrRWwoYikgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIGVsLmNsYXNzTmFtZSA9ICdibGsnOwogICAgc2V0QmxvY2soZWwsIGIudHlwZSwgYi5sZXZlbCwgYi5jaGVja2VkKTsKICAgIGNvbnN0IGtpZHMgPSBpbmxpbmVOb2RlcyhiLnJ1bnMpOwogICAgaWYgKGtpZHMubGVuZ3RoKSBlbC5hcHBlbmQoLi4ua2lkcyk7CiAgICBlbHNlIGVsLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2JyJykpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgZnVuY3Rpb24gc3R5bGVNYXJrcyhzdHlsZSkgewogICAgY29uc3QgcyA9IFN0cmluZyhzdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgIHJldHVybiB7CiAgICAgIGI6IC9mb250LXdlaWdodFxzKjpccyooYm9sZHxib2xkZXJ8WzYtOV0wMCkvLnRlc3QocyksCiAgICAgIGk6IC9mb250LXN0eWxlXHMqOlxzKml0YWxpYy8udGVzdChzKSwKICAgICAgczogL3RleHQtZGVjb3JhdGlvbigtbGluZSk_XHMqOlteO10qbGluZS10aHJvdWdoLy50ZXN0KHMpLAogICAgfTsKICB9CgogIGNvbnN0IE5FU1RFRF9CTE9DS1MgPSBuZXcgU2V0KFsnZGl2JywgJ3AnLCAnbGknLCAndWwnLCAnb2wnLCAnaDEnLCAnaDInLCAnaDMnLCAnaDQnLCAnaDUnLCAnaDYnLCAnYmxvY2txdW90ZScsICdwcmUnXSk7CgogIC8vIFJlYWRzIG9uZSBibG9jayBlbGVtZW50IC0gYW5kIGFueXRoaW5nIHRoZ",
"SBicm93c2VyIG1heSBoYXZlIGxlZnQKICAvLyBpbnNpZGUgaXQsIHN1Y2ggYXMgYSA8YnI-IG9yIGEgbmVzdGVkIDxkaXY-IC0gaW50byBtb2RlbCBibG9ja3MuCiAgZnVuY3Rpb24gcmVhZEJsb2NrKGVsLCBvdXQpIHsKICAgIGNvbnN0IHR5cGUgPSBmbXQuVFlQRVMuaGFzKGVsLmRhdGFzZXQudHlwZSkgPyBlbC5kYXRhc2V0LnR5cGUgOiAncCc7CiAgICBjb25zdCBsZXZlbCA9IE51bWJlcihlbC5kYXRhc2V0LmxldmVsKSB8fCAwOwogICAgY29uc3QgZmlyc3QgPSBvdXQubGVuZ3RoOwogICAgbGV0IGN1ciA9IGZtdC5ibG9jayh0eXBlLCBbXSwgeyBsZXZlbCwgY2hlY2tlZDogZWwuZGF0YXNldC5jaGVja2VkID09PSAnMScgfSk7CiAgICBvdXQucHVzaChjdXIpOwogICAgY29uc3QgbmV4dCA9ICgpID0-IHsKICAgICAgY3VyID0gZm10LmJsb2NrKHR5cGUsIFtdLCB7IGxldmVsIH0pOwogICAgICBvdXQucHVzaChjdXIpOwogICAgfTsKICAgIChmdW5jdGlvbiB3YWxrKG5vZGUsIG1hcmtzKSB7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZE5vZGVzKSB7CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlID09PSAzKSB7CiAgICAgICAgICBpZiAoY2hpbGQuZGF0YSkgY3VyLnJ1bnMucHVzaCh7IHRleHQ6IGNoaWxkLmRhdGEucmVwbGFjZSgvXHUwMGEwL2csICcgJykucmVwbGFjZSgvXG4vZywgJyAnKSwgLi4ubWFya3MgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgK",
"GNoaWxkLm5vZGVUeXBlICE9PSAxKSBjb250aW51ZTsKICAgICAgICBjb25zdCB0YWcgPSBjaGlsZC50YWdOYW1lLnRvTG93ZXJDYXNlKCk7CiAgICAgICAgaWYgKHRhZyA9PT0gJ2JyJykgeyBuZXh0KCk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKE5FU1RFRF9CTE9DS1MuaGFzKHRhZykpIHsKICAgICAgICAgIGlmIChjdXIucnVucy5sZW5ndGgpIG5leHQoKTsKICAgICAgICAgIHdhbGsoY2hpbGQsIG1hcmtzKTsKICAgICAgICAgIG5leHQoKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBjb25zdCBtID0geyAuLi5tYXJrcyB9OwogICAgICAgIGlmICh0YWcgPT09ICdiJyB8fCB0YWcgPT09ICdzdHJvbmcnKSBtLmIgPSB0cnVlOwogICAgICAgIGVsc2UgaWYgKHRhZyA9PT0gJ2knIHx8IHRhZyA9PT0gJ2VtJykgbS5pID0gdHJ1ZTsKICAgICAgICBlbHNlIGlmICh0YWcgPT09ICdzJyB8fCB0YWcgPT09ICdzdHJpa2UnIHx8IHRhZyA9PT0gJ2RlbCcpIG0ucyA9IHRydWU7CiAgICAgICAgZWxzZSBpZiAodGFnID09PSAnYScpIHsKICAgICAgICAgIGNvbnN0IGhyZWYgPSBmbXQuc2FmZUhyZWYoY2hpbGQuZ2V0QXR0cmlidXRlKCdocmVmJykpOwogICAgICAgICAgaWYgKGhyZWYpIG0uaHJlZiA9IGhyZWY7CiAgICAgICAgfSBlbHNlIGlmICh0YWcgPT09ICdzcGFuJyB8fCB0YWcgPT09ICdmb250JykgewogICAgICAgICAgY29uc3Qgc3QgPSBzdHlsZU1hcmtzKGNoaWxkLmdldEF0dHJpYnV0ZSgnc",
"3R5bGUnKSk7CiAgICAgICAgICBpZiAoc3QuYikgbS5iID0gdHJ1ZTsKICAgICAgICAgIGlmIChzdC5pKSBtLmkgPSB0cnVlOwogICAgICAgICAgaWYgKHN0LnMpIG0ucyA9IHRydWU7CiAgICAgICAgfQogICAgICAgIHdhbGsoY2hpbGQsIG0pOwogICAgICB9CiAgICB9KShlbCwge30pOwogICAgLy8gQSA8YnI-IG9yIG5lc3RlZCBibG9jayBhdCB0aGUgdmVyeSBlbmQgbGVhdmVzIGFuIGVtcHR5IGJsb2NrIGJlaGluZDoKICAgIC8vIHRoYXQgaXMgdGhlIGJyb3dzZXIncyBwbGFjZWhvbGRlciwgbm90IGEgbmV3IGxpbmUuCiAgICB3aGlsZSAob3V0Lmxlbmd0aCAtIDEgPiBmaXJzdCAmJiAhb3V0W291dC5sZW5ndGggLSAxXS5ydW5zLnNvbWUociA9PiByLnRleHQpKSBvdXQucG9wKCk7CiAgfQoKICBmdW5jdGlvbiByZWFkRG9jKGVkaXRvcikgewogICAgY29uc3QgYmxvY2tzID0gW107CiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZWRpdG9yLmNoaWxkTm9kZXMpIHsKICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS5jbGFzc0xpc3QuY29udGFpbnMoJ2JsaycpKSByZWFkQmxvY2sobm9kZSwgYmxvY2tzKTsKICAgICAgZWxzZSBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMyAmJiBub2RlLmRhdGEudHJpbSgpKSBibG9ja3MucHVzaChmbXQuYmxvY2soJ3AnLCBbeyB0ZXh0OiBub2RlLmRhdGEucmVwbGFjZSgvwqAvZywgJyAnKSB9XSkpOwogICAgICBlbHNlIGlmIChub2RlLm5vZGVUeXBlID09PSAxICYmIG5vZ",
"GUudGFnTmFtZSAhPT0gJ0JSJykgcmVhZEJsb2NrKG5vZGUsIGJsb2Nrcyk7CiAgICB9CiAgICByZXR1cm4gZm10Lm5vcm1hbGlzZURvYyhibG9ja3MpOwogIH0KCiAgLy8g4pSA4pSAIFNlbGVjdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gY3JlYXRlKHsgcm9vdCwgb25DaGFuZ2UgfSkgewogICAgY29uc3QgZWxzID0ge307CiAgICBsZXQgc2F2ZWQgPSBudWxsOyAgICAgLy8gdGhlIGxhc3Qgc2VsZWN0aW9uIGluc2lkZSB0aGUgZWRpdG9yCiAgICBsZXQgZWRpdGFibGUgPSBmYWxzZTsKICAgIGxldCBwbGFpbk5leHQgPSBmYWxzZTsgLy8gQ3RybCtTaGlmdCtWOiB0aGUgbmV4dCBwYXN0ZSBpcyB0ZXh0IGFsb25lCiAgICBsZXQgcGFzdGVVbmRvID0gW107ICAgIC8vIGhvdyB0aGUgdGV4dCB3YXMgYmVmb3JlIGVhY2ggZm9ybWF0dGVkIHBhc3RlLCBsYXRlc3QgbGFzdAoKICAgIGNvbnN0IHNlbGVjdGlvbiA9ICgpID0-IChyb290LmdldFNlbGVjdGlvbiA_IHJvb3QuZ2V0U2VsZWN0aW9uKCkgOiBkb2N1bWVudC5nZXRTZWxlY3Rpb24oKSk7CgogICAgZnVuY3Rpb24gcmFuZ2UoKSB7CiAgICAgIGNvbnN0IHNlbCA9IHNlbGVjdGlvbigpO",
"wogICAgICBpZiAoIXNlbCB8fCAhc2VsLnJhbmdlQ291bnQpIHJldHVybiBudWxsOwogICAgICBjb25zdCByID0gc2VsLmdldFJhbmdlQXQoMCk7CiAgICAgIHJldHVybiBlbHMuZWRpdG9yLmNvbnRhaW5zKHIuc3RhcnRDb250YWluZXIpICYmIGVscy5lZGl0b3IuY29udGFpbnMoci5lbmRDb250YWluZXIpID8gciA6IG51bGw7CiAgICB9CgogICAgZnVuY3Rpb24gc2VsZWN0KHIpIHsKICAgICAgY29uc3Qgc2VsID0gd2luZG93LmdldFNlbGVjdGlvbigpOwogICAgICBzZWwucmVtb3ZlQWxsUmFuZ2VzKCk7CiAgICAgIHNlbC5hZGRSYW5nZShyKTsKICAgIH0KCiAgICAvLyBUb29sYmFyIGJ1dHRvbnMgZG8gbm90IHRha2UgZm9jdXMgZnJvbSB0aGUgdGV4dCwgYnV0IHRoZSBzdHlsZSBtZW51CiAgICAvLyBhbmQgdGhlIGxpbmsgZmllbGQgZG87IHRoZSBzZWxlY3Rpb24gdGhleSB3ZXJlIG9wZW5lZCBvbiBpcyBwdXQKICAgIC8vIGJhY2sgYmVmb3JlIHRoZSBjaGFuZ2UgaXMgYXBwbGllZC4KICAgIGZ1bmN0aW9uIHJlc3RvcmUoKSB7CiAgICAgIC8vIFRoZSBzZWxlY3Rpb24gY2FuIHN0aWxsIGJlIGluIHRoZSB0ZXh0IHdoaWxlIHRoZSBmb2N1cyBpcyBub3QgLQogICAgICAvLyBvbiB0aGUgc3R5bGUgYnV0dG9uIHRoZSBtZW51IGhhbmRlZCBpdCBiYWNrIHRvLCBzYXkgLSBhbmQgdHlwaW5nCiAgICAgIC8vIHdvdWxkIHRoZW4gZ28gbm93aGVyZS4gQm90aCBhcmUgcHV0IGJhY2suCiAgICAgIGNvbnN0IGtlZXAgPSByY",
"W5nZSgpIHx8IChzYXZlZCAmJiBlbHMuZWRpdG9yLmNvbnRhaW5zKHNhdmVkLnN0YXJ0Q29udGFpbmVyKSA_IHNhdmVkIDogbnVsbCk7CiAgICAgIGlmIChyb290LmFjdGl2ZUVsZW1lbnQgIT09IGVscy5lZGl0b3IpIGVscy5lZGl0b3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBpZiAoa2VlcCkgewogICAgICAgIHRyeSB7IHNlbGVjdChrZWVwLmNsb25lUmFuZ2UgPyBrZWVwLmNsb25lUmFuZ2UoKSA6IGtlZXApOyB9IGNhdGNoIHsgLyogdGhlIHRleHQgY2hhbmdlZCB1bmRlcm5lYXRoICovIH0KICAgICAgfQogICAgfQoKICAgIGZ1bmN0aW9uIGJsb2NrT2Yobm9kZSkgewogICAgICBsZXQgbiA9IG5vZGU7CiAgICAgIGlmIChuID09PSBlbHMuZWRpdG9yKSByZXR1cm4gbnVsbDsKICAgICAgd2hpbGUgKG4gJiYgbi5wYXJlbnROb2RlICE9PSBlbHMuZWRpdG9yKSBuID0gbi5wYXJlbnROb2RlOwogICAgICByZXR1cm4gbiAmJiBuLm5vZGVUeXBlID09PSAxID8gbiA6IG51bGw7CiAgICB9CgogICAgZnVuY3Rpb24gcmFuZ2VCbG9ja3MocikgewogICAgICBjb25zdCBraWRzID0gWy4uLmVscy5lZGl0b3IuY2hpbGRyZW5dOwogICAgICBjb25zdCBlZGdlID0gKGNvbnRhaW5lciwgb2Zmc2V0LCBlbmQpID0-IHsKICAgICAgICBpZiAoY29udGFpbmVyID09PSBlbHMuZWRpdG9yKSByZXR1cm4ga2lkc1tNYXRoLm1pbihraWRzLmxlbmd0aCAtIDEsIE1hdGgubWF4KDAsIG9mZnNldCAtIChlbmQgPyAxI",
"DogMCkpKV07CiAgICAgICAgcmV0dXJuIGJsb2NrT2YoY29udGFpbmVyKTsKICAgICAgfTsKICAgICAgY29uc3QgYSA9IGVkZ2Uoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCwgZmFsc2UpOwogICAgICBjb25zdCBiID0gZWRnZShyLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXQsIHRydWUpOwogICAgICBjb25zdCBpID0ga2lkcy5pbmRleE9mKGEpOwogICAgICBjb25zdCBqID0ga2lkcy5pbmRleE9mKGIpOwogICAgICBpZiAoaSA8IDAgfHwgaiA8IDApIHJldHVybiBhID8gW2FdIDogW107CiAgICAgIHJldHVybiBraWRzLnNsaWNlKE1hdGgubWluKGksIGopLCBNYXRoLm1heChpLCBqKSArIDEpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNhcmV0QXRCbG9ja1N0YXJ0KHIsIGJsaykgewogICAgICBpZiAoIXIgfHwgIXIuY29sbGFwc2VkIHx8ICFibGspIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgcHJlLnNlbGVjdE5vZGVDb250ZW50cyhibGspOwogICAgICBwcmUuc2V0RW5kKHIuc3RhcnRDb250YWluZXIsIHIuc3RhcnRPZmZzZXQpOwogICAgICByZXR1cm4gcHJlLnRvU3RyaW5nKCkgPT09ICcnOwogICAgfQoKICAgIGZ1bmN0aW9uIHBsYWNlQ2FyZXQobm9kZSwgb2Zmc2V0KSB7CiAgICAgIGNvbnN0IHIgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICByLnNldFN0YXJ0KG5vZGUsIG9mZnNldCk7CiAgICAgIHIuY29sbGFwc2UodHJ1Z",
"Sk7CiAgICAgIHNlbGVjdChyKTsKICAgIH0KCiAgICAvLyDilIDilIAgS2VlcGluZyB0aGUgbWFya3VwIHRpZHkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogICAgLy8gRWFjaCBsaXN0IGl0ZW0gbWF5IGJlIGF0IG1vc3Qgb25lIGxldmVsIGRlZXBlciB0aGFuIHRoZSBvbmUgYWJvdmUuCiAgICBmdW5jdGlvbiBmaXhMZXZlbHMoKSB7CiAgICAgIGxldCBwcmV2ID0gLTE7CiAgICAgIGZvciAoY29uc3QgYmxrIG9mIGVscy5lZGl0b3IuY2hpbGRyZW4pIHsKICAgICAgICBpZiAoZm10LkxJU1RTLmhhcyhibGsuZGF0YXNldC50eXBlKSkgewogICAgICAgICAgY29uc3QgbHZsID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oZm10Lk1BWF9MRVZFTCwgTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwLCBwcmV2ICsgMSkpOwogICAgICAgICAgYmxrLmRhdGFzZXQubGV2ZWwgPSBTdHJpbmcobHZsKTsKICAgICAgICAgIHByZXYgPSBsdmw7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHByZXYgPSAtMTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KCiAgICAvLyBUaGUgYnJvd3NlciBzb21ldGltZXMgbGVhdmVzIHRleHQsIGEgPGJyPiBvciBhIHBsYWluIDxkaXY-IGRpcmVjdGx5CiAgICAvLyBpbiB0aGUgZWRpdG9yIChhZnRlciBzZWxlY3QtY",
"WxsIGFuZCBkZWxldGUsIHNheSksIGFuZCB3cmFwcyBtZXJnZWQKICAgIC8vIHRleHQgaW4gPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZeKApiI-IHdoZW4gdHdvIGJsb2NrcyBvZiBkaWZmZXJlbnQgc2l6ZXMKICAgIC8vIGpvaW4uIEJvdGggYXJlIHB1dCByaWdodCBoZXJlLCBrZWVwaW5nIHRoZSBjYXJldCB3aGVyZSBpdCB3YXMuCiAgICBmdW5jdGlvbiB0aWR5KCkgewogICAgICBjb25zdCBzZWwgPSBzZWxlY3Rpb24oKTsKICAgICAgY29uc3QgciA9IHNlbCAmJiBzZWwucmFuZ2VDb3VudCA_IHNlbC5nZXRSYW5nZUF0KDApIDogbnVsbDsKICAgICAgY29uc3Qga2VlcCA9IHIgPyBbci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCwgci5lbmRDb250YWluZXIsIHIuZW5kT2Zmc2V0XSA6IG51bGw7CiAgICAgIGxldCBtb3ZlZCA9IGZhbHNlOwoKICAgICAgZm9yIChjb25zdCBub2RlIG9mIFsuLi5lbHMuZWRpdG9yLmNoaWxkTm9kZXNdKSB7CiAgICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS5jbGFzc0xpc3QuY29udGFpbnMoJ2JsaycpICYmIG5vZGUuZGF0YXNldC50eXBlKSBjb250aW51ZTsKICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiAvXihESVZ8UHxIMXxIMnxIMykkLy50ZXN0KG5vZGUudGFnTmFtZSkpIHsKICAgICAgICAgIG5vZGUuY2xhc3NMaXN0LmFkZCgnYmxrJyk7CiAgICAgICAgICBzZXRCbG9jayhub2RlLCAvXkhbMTIzXSQvLnRlc3Qobm9kZS50YWdOYW1lKSA_I",
"G5vZGUudGFnTmFtZS50b0xvd2VyQ2FzZSgpIDogJ3AnKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMyAmJiAhbm9kZS5kYXRhLnRyaW0oKSAmJiAhKGtlZXAgJiYgKGtlZXBbMF0gPT09IG5vZGUgfHwga2VlcFsyXSA9PT0gbm9kZSkpKSB7CiAgICAgICAgICBub2RlLnJlbW92ZSgpOwogICAgICAgICAgY29udGludWU7CiAgICAgICAgfQogICAgICAgIGNvbnN0IGJsayA9IGJsb2NrRWwoZm10LmJsb2NrKCdwJykpOwogICAgICAgIGJsay5yZXBsYWNlQ2hpbGRyZW4oKTsKICAgICAgICBlbHMuZWRpdG9yLmluc2VydEJlZm9yZShibGssIG5vZGUpOwogICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAxICYmIG5vZGUudGFnTmFtZSA9PT0gJ0JSJykgewogICAgICAgICAgYmxrLmFwcGVuZENoaWxkKG5vZGUpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAvLyBHYXRoZXIgdGhpcyBhbmQgYW55IGZvbGxvd2luZyBpbmxpbmUgbmVpZ2hib3VycyBpbnRvIG9uZSBibG9jay4KICAgICAgICAgIGxldCBuID0gbm9kZTsKICAgICAgICAgIHdoaWxlIChuICYmICEobi5ub2RlVHlwZSA9PT0gMSAmJiAobi5jbGFzc0xpc3QuY29udGFpbnMoJ2JsaycpIHx8IE5FU1RFRF9CTE9DS1MuaGFzKG4udGFnTmFtZS50b0xvd2VyQ2FzZSgpKSkpKSB7CiAgICAgICAgICAgIGNvbnN0IGZvbGxvd2luZyA9IG4ubmV4dFNpYmxpbmc7CiAgICAgICAgICAgIGJsay5hcHBlb",
"mRDaGlsZChuKTsKICAgICAgICAgICAgbiA9IGZvbGxvd2luZzsKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgICAgbW92ZWQgPSB0cnVlOwogICAgICB9CgogICAgICBmb3IgKGNvbnN0IHNwYW4gb2YgWy4uLmVscy5lZGl0b3IucXVlcnlTZWxlY3RvckFsbCgnc3BhbltzdHlsZV0sIGZvbnQnKV0pIHsKICAgICAgICBjb25zdCBzdCA9IHN0eWxlTWFya3Moc3Bhbi5nZXRBdHRyaWJ1dGUoJ3N0eWxlJykpOwogICAgICAgIGlmIChzdC5iIHx8IHN0LmkgfHwgc3QucykgY29udGludWU7CiAgICAgICAgc3Bhbi5yZXBsYWNlV2l0aCguLi5zcGFuLmNoaWxkTm9kZXMpOwogICAgICAgIG1vdmVkID0gdHJ1ZTsKICAgICAgfQogICAgICBmb3IgKGNvbnN0IGEgb2YgZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yQWxsKCdhW2hyZWZdJykpIHsKICAgICAgICBjb25zdCBocmVmID0gZm10LnNhZmVIcmVmKGEuZ2V0QXR0cmlidXRlKCdocmVmJykpOwogICAgICAgIGlmICghaHJlZikgYS5yZXBsYWNlV2l0aCguLi5hLmNoaWxkTm9kZXMpOwogICAgICAgIGVsc2UgaWYgKGEudGl0bGUgIT09IGhyZWYpIGEudGl0bGUgPSBocmVmOwogICAgICB9CiAgICAgIGlmICghZWxzLmVkaXRvci5jaGlsZHJlbi5sZW5ndGgpIHsKICAgICAgICBlbHMuZWRpdG9yLmFwcGVuZENoaWxkKGJsb2NrRWwoZm10LmJsb2NrKCdwJykpKTsKICAgICAgICBwbGFjZUNhcmV0KGVscy5lZGl0b3IuZmlyc3RDaGlsZCwgMCk7CiAgICAgICAgbW92ZWQgPSBmYWxzZ",
"TsKICAgICAgfQogICAgICBpZiAobW92ZWQgJiYga2VlcCAmJiBrZWVwWzBdLmlzQ29ubmVjdGVkICYmIGtlZXBbMl0uaXNDb25uZWN0ZWQpIHsKICAgICAgICB0cnkgewogICAgICAgICAgY29uc3QgYmFjayA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgICBiYWNrLnNldFN0YXJ0KGtlZXBbMF0sIGtlZXBbMV0pOwogICAgICAgICAgYmFjay5zZXRFbmQoa2VlcFsyXSwga2VlcFszXSk7CiAgICAgICAgICBzZWxlY3QoYmFjayk7CiAgICAgICAgfSBjYXRjaCB7IC8qIHBvc2l0aW9ucyBubyBsb25nZXIgdmFsaWQgKi8gfQogICAgICB9CiAgICAgIGZpeExldmVscygpOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIGZ1bmN0aW9uIHVwZGF0ZUVtcHR5KCkgewogICAgICBjb25zdCBraWRzID0gZWxzLmVkaXRvci5jaGlsZHJlbjsKICAgICAgY29uc3QgZW1wdHkgPSBraWRzLmxlbmd0aCA8PSAxICYmICgha2lkc1swXSB8fCAoa2lkc1swXS5kYXRhc2V0LnR5cGUgPT09ICdwJyAmJiAha2lkc1swXS50ZXh0Q29udGVudCkpOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQuZW1wdHkgPSBlbXB0eSA_ICcxJyA6ICcwJzsKICAgIH0KCiAgICBmdW5jdGlvbiBjaGFuZ2VkKCkgewogICAgICBwYXN0ZVVuZG8gPSBbXTsKICAgICAgdGlkeSgpOwogICAgICBvbkNoYW5nZSgpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIOKUgOKUgCBDb21tYW5kcyDilIDilIDilIDilIDilIDilIDil",
"IDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlvbiBpbmxpbmUoY21kKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgcmVzdG9yZSgpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZChjbWQpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIEFwcGxpZXMgYSBibG9jayB0eXBlIHRvIGV2ZXJ5IGJsb2NrIHRoZSBzZWxlY3Rpb24gdG91Y2hlcyAtIG9yLCBpZgogICAgLy8gdGhleSBhbGwgaGF2ZSBpdCBhbHJlYWR5LCB0dXJucyB0aGVtIGJhY2sgaW50byBwYXJhZ3JhcGhzLgogICAgZnVuY3Rpb24gYmxvY2tUeXBlKHR5cGUsIHsgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIHJlc3RvcmUoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCBibG9ja3MgPSByYW5nZUJsb2NrcyhyKTsKICAgICAgY29uc3Qgb2ZmID0gYmxvY2tzLmV2ZXJ5KGIgPT4gYi5kYXRhc2V0LnR5cGUgPT09IHR5cGUpICYmIHR5cGUgIT09ICdwJzsKICAgICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICAgIGNvbnN0IHdhcyA9IGIuZ",
"GF0YXNldC50eXBlOwogICAgICAgIGNvbnN0IGxldmVsID0gZm10LkxJU1RTLmhhcyh3YXMpID8gTnVtYmVyKGIuZGF0YXNldC5sZXZlbCkgfHwgMCA6IDA7CiAgICAgICAgc2V0QmxvY2soYiwgb2ZmID8gJ3AnIDogdHlwZSwgbGV2ZWwsIHR5cGUgPT09ICdjaGVjaycgJiYgd2FzID09PSAnY2hlY2snID8gYi5kYXRhc2V0LmNoZWNrZWQgPT09ICcxJyA6IGNoZWNrZWQpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBpbmRlbnQoZGVsdGEpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyKSByZXR1cm4gZmFsc2U7CiAgICAgIGNvbnN0IGJsb2NrcyA9IHJhbmdlQmxvY2tzKHIpLmZpbHRlcihiID0-IGZtdC5MSVNUUy5oYXMoYi5kYXRhc2V0LnR5cGUpKTsKICAgICAgaWYgKCFibG9ja3MubGVuZ3RoKSByZXR1cm4gZmFsc2U7CiAgICAgIGZvciAoY29uc3QgYiBvZiBibG9ja3MpIGIuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhNYXRoLm1heCgwLCBNYXRoLm1pbihmbXQuTUFYX0xFVkVMLCAoTnVtYmVyKGIuZGF0YXNldC5sZXZlbCkgfHwgMCkgKyBkZWx0YSkpKTsKICAgICAgY2hhbmdlZCgpOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0KCiAgICBmdW5jdGlvbiB0b2dnbGVDaGVjayhibGspIHsKICAgICAgaWYgKCFlZGl0YWJsZSB8fCAhYmxrIHx8IGJsay5kYXRhc2V0LnR5cGUgIT09ICdjaGVjaycpI",
"HJldHVybjsKICAgICAgYmxrLmRhdGFzZXQuY2hlY2tlZCA9IGJsay5kYXRhc2V0LmNoZWNrZWQgPT09ICcxJyA_ICcwJyA6ICcxJzsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNsZWFyRm9ybWF0dGluZygpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuOwogICAgICByZXN0b3JlKCk7CiAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdyZW1vdmVGb3JtYXQnKTsKICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ3VubGluaycpOwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKHIpIGZvciAoY29uc3QgYiBvZiByYW5nZUJsb2NrcyhyKSkgc2V0QmxvY2soYiwgJ3AnKTsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGFuY2hvckF0KHIpIHsKICAgICAgbGV0IG4gPSByICYmIHIuc3RhcnRDb250YWluZXI7CiAgICAgIHdoaWxlIChuICYmIG4gIT09IGVscy5lZGl0b3IpIHsKICAgICAgICBpZiAobi5ub2RlVHlwZSA9PT0gMSAmJiBuLnRhZ05hbWUgPT09ICdBJykgcmV0dXJuIG47CiAgICAgICAgbiA9IG4ucGFyZW50Tm9kZTsKICAgICAgfQogICAgICByZXR1cm4gbnVsbDsKICAgIH0KCiAgICAvLyDilIDilIAgTGlua3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4",
"pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogICAgZnVuY3Rpb24gb3BlbkxpbmsoKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgY29uc3QgciA9IHJhbmdlKCkgfHwgc2F2ZWQ7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBzYXZlZCA9IHIuY2xvbmVSYW5nZSgpOwogICAgICBjb25zdCBhID0gYW5jaG9yQXQocik7CiAgICAgIGVscy5saW5rSW5wdXQudmFsdWUgPSBhID8gYS5nZXRBdHRyaWJ1dGUoJ2hyZWYnKSA6ICcnOwogICAgICBlbHMubGlua0Vycm9yLnRleHRDb250ZW50ID0gJyc7CiAgICAgIGVscy5saW5rUmVtb3ZlLmhpZGRlbiA9ICFhOwogICAgICBlbHMubGlua2Jhci5oaWRkZW4gPSBmYWxzZTsKICAgICAgZWxzLmxpbmtJbnB1dC5mb2N1cygpOwogICAgICBlbHMubGlua0lucHV0LnNlbGVjdCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNsb3NlTGluayh7IHJlZm9jdXMgPSB0cnVlIH0gPSB7fSkgewogICAgICBpZiAoZWxzLmxpbmtiYXIuaGlkZGVuKSByZXR1cm47CiAgICAgIGVscy5saW5rYmFyLmhpZGRlbiA9IHRydWU7CiAgICAgIGlmIChyZWZvY3VzKSByZXN0b3JlKCk7CiAgICB9CgogICAgZnVuY3Rpb24gYXBwbHlMaW5rKCkgewogICAgICBjb25zdCBocmVmID0gZm10LnNhZmVIcmVmKGVscy5saW5rSW5wdXQudmFsdWUpOwogICAgICBpZiAoIWhyZWYpIHsKICAgICAgICBlbHMubGlua0Vycm9yLnRleHRDb250ZW50ID0gJ1RoY",
"XQgaXMgbm90IGEgd2ViIG9yIGVtYWlsIGFkZHJlc3MuJzsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY2xvc2VMaW5rKCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgY29uc3QgYSA9IGFuY2hvckF0KHIpOwogICAgICBpZiAoci5jb2xsYXBzZWQgJiYgYSkgewogICAgICAgIGEuc2V0QXR0cmlidXRlKCdocmVmJywgaHJlZik7CiAgICAgICAgYS50aXRsZSA9IGhyZWY7CiAgICAgIH0gZWxzZSBpZiAoci5jb2xsYXBzZWQpIHsKICAgICAgICAvLyBOb3RoaW5nIHNlbGVjdGVkOiB0aGUgYWRkcmVzcyBpdHNlbGYgYmVjb21lcyB0aGUgbGluayB0ZXh0LgogICAgICAgIGNvbnN0IHRleHQgPSBocmVmLnJlcGxhY2UoL15tYWlsdG86LywgJycpOwogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIHRleHQpOwogICAgICAgIGNvbnN0IGFmdGVyID0gcmFuZ2UoKTsKICAgICAgICBpZiAoYWZ0ZXIpIHsKICAgICAgICAgIGNvbnN0IHNlbCA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgICBzZWwuc2V0U3RhcnQoYWZ0ZXIuc3RhcnRDb250YWluZXIsIE1hdGgubWF4KDAsIGFmdGVyLnN0YXJ0T2Zmc2V0IC0gdGV4dC5sZW5ndGgpKTsKICAgICAgICAgIHNlbC5zZXRFbmQoYWZ0ZXIuc3RhcnRDb250YWluZXIsIGFmdGVyLnN0YXJ0T2Zmc2V0KTsKICAgICAgICAgIHNlbGVjdChzZWwpOwogICAgICAgICAgZG9jdW1lb",
"nQuZXhlY0NvbW1hbmQoJ2NyZWF0ZUxpbmsnLCBmYWxzZSwgaHJlZik7CiAgICAgICAgICBjb25zdCBlbmQgPSByYW5nZSgpOwogICAgICAgICAgaWYgKGVuZCkgeyBlbmQuY29sbGFwc2UoZmFsc2UpOyBzZWxlY3QoZW5kKTsgfQogICAgICAgIH0KICAgICAgfSBlbHNlIHsKICAgICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnY3JlYXRlTGluaycsIGZhbHNlLCBocmVmKTsKICAgICAgfQogICAgICBjaGFuZ2VkKCk7CiAgICB9CgogICAgZnVuY3Rpb24gcmVtb3ZlTGluaygpIHsKICAgICAgY2xvc2VMaW5rKCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBjb25zdCBhID0gYW5jaG9yQXQocik7CiAgICAgIGlmIChhKSB7CiAgICAgICAgY29uc3Qgc2VsID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICBzZWwuc2VsZWN0Tm9kZUNvbnRlbnRzKGEpOwogICAgICAgIHNlbGVjdChzZWwpOwogICAgICB9CiAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCd1bmxpbmsnKTsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIC8vIOKUgOKUgCBUb29sYmFyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGNvbnN0IGJ1dHRvbnMgPSB7f",
"TsKICAgIGNvbnN0IHRiQnV0dG9uID0gKGtleSwgbGFiZWwsIGljb25OYW1lLCBvbkNsaWNrLCB0b2dnbGUgPSB0cnVlKSA9PiB7CiAgICAgIGNvbnN0IGIgPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICd0Yi1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGl0bGU6IGxhYmVsLCAnYXJpYS1sYWJlbCc6IGxhYmVsLAogICAgICAgICdhcmlhLXByZXNzZWQnOiB0b2dnbGUgPyAnZmFsc2UnIDogbnVsbCwgZGF0YXNldDogeyBrZXk6IGBmbXQtJHtrZXl9YCB9LAogICAgICAgIC8vIEtlZXBzIHRoZSBmb2N1cyAtIGFuZCBzbyB0aGUgc2VsZWN0aW9uIC0gaW4gdGhlIHRleHQuCiAgICAgICAgb25tb3VzZWRvd246IGUgPT4gZS5wcmV2ZW50RGVmYXVsdCgpLAogICAgICAgIG9uY2xpY2s6ICgpID0-IG9uQ2xpY2soKSwKICAgICAgfSwgaWNvbihpY29uTmFtZSwgMjApKTsKICAgICAgYnV0dG9uc1trZXldID0gYjsKICAgICAgcmV0dXJuIGI7CiAgICB9OwogICAgY29uc3Qgc2VwID0gKCkgPT4gaCgnc3BhbicsIHsgY2xhc3M6ICd0Yi1zZXAnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSk7CgogICAgZWxzLnN0eWxlTGFiZWwgPSBoKCdzcGFuJywgeyBjbGFzczogJ3RiLXN0eWxlLWxhYmVsJywgdGV4dDogJ05vcm1hbCB0ZXh0JyB9KTsKICAgIGVscy5zdHlsZSA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICd0Yi1zdHlsZScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1oYXNwb3B1cCc6ICdtZW51JywgJ2FyaWEtZXhwY",
"W5kZWQnOiAnZmFsc2UnLAogICAgICAnYXJpYS1sYWJlbCc6ICdUZXh0IHN0eWxlJywgdGl0bGU6ICdUZXh0IHN0eWxlJywgZGF0YXNldDogeyBrZXk6ICdmbXQtc3R5bGUnIH0sCiAgICAgIG9ubW91c2Vkb3duOiBlID0-IGUucHJldmVudERlZmF1bHQoKSwKICAgICAgb25jbGljazogKCkgPT4gewogICAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgICBpZiAocikgc2F2ZWQgPSByLmNsb25lUmFuZ2UoKTsKICAgICAgICBjb25zdCBjdXIgPSBjdXJyZW50VHlwZSgpOwogICAgICAgIG9wZW5NZW51KHJvb3QsIGVscy5zdHlsZSwgU1RZTEVTLm1hcCgoW3R5cGUsIGxhYmVsXSkgPT4gKHsKICAgICAgICAgIGxhYmVsLCBrZXk6IGBzdHlsZToke3R5cGV9YCwgY2hlY2tlZDogY3VyID09PSB0eXBlLAogICAgICAgICAgb25TZWxlY3Q6ICgpID0-IGJsb2NrVHlwZSh0eXBlKSwKICAgICAgICB9KSksIHsgbGFiZWw6ICdUZXh0IHN0eWxlJyB9KTsKICAgICAgfSwKICAgIH0sIGVscy5zdHlsZUxhYmVsLCBpY29uKCdjYXJldCcsIDE4KSk7CgogICAgZWxzLnRvb2xiYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtdG9vbGJhcicsIHJvbGU6ICd0b29sYmFyJywgJ2FyaWEtbGFiZWwnOiAnRm9ybWF0dGluZycgfSwKICAgICAgZWxzLnN0eWxlLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ2JvbGQnLCAnQm9sZCAoQ3RybCtCKScsICdib2xkJywgKCkgPT4gaW5sa",
"W5lKCdib2xkJykpLAogICAgICB0YkJ1dHRvbignaXRhbGljJywgJ0l0YWxpYyAoQ3RybCtJKScsICdpdGFsaWMnLCAoKSA9PiBpbmxpbmUoJ2l0YWxpYycpKSwKICAgICAgdGJCdXR0b24oJ3N0cmlrZScsICdTdHJpa2UtdGhyb3VnaCcsICdzdHJpa2UnLCAoKSA9PiBpbmxpbmUoJ3N0cmlrZVRocm91Z2gnKSksCiAgICAgIHNlcCgpLAogICAgICB0YkJ1dHRvbigndWwnLCAnQnVsbGV0ZWQgbGlzdCAoQ3RybCtTaGlmdCs4KScsICdidWxsZXRzJywgKCkgPT4gYmxvY2tUeXBlKCd1bCcpKSwKICAgICAgdGJCdXR0b24oJ29sJywgJ051bWJlcmVkIGxpc3QgKEN0cmwrU2hpZnQrNyknLCAnbnVtYmVycycsICgpID0-IGJsb2NrVHlwZSgnb2wnKSksCiAgICAgIHRiQnV0dG9uKCdjaGVjaycsICdDaGVja2xpc3QgKEN0cmwrU2hpZnQrOSknLCAnY2hlY2tsaXN0JywgKCkgPT4gYmxvY2tUeXBlKCdjaGVjaycpKSwKICAgICAgdGJCdXR0b24oJ291dGRlbnQnLCAnTGVzcyBpbmRlbnQgKFNoaWZ0K1RhYiknLCAnb3V0ZGVudCcsICgpID0-IHsgcmVzdG9yZSgpOyBpbmRlbnQoLTEpOyB9LCBmYWxzZSksCiAgICAgIHRiQnV0dG9uKCdpbmRlbnQnLCAnTW9yZSBpbmRlbnQgKFRhYiknLCAnaW5kZW50JywgKCkgPT4geyByZXN0b3JlKCk7IGluZGVudCgxKTsgfSwgZmFsc2UpLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ2xpbmsnLCAnTGluayAoQ3RybCtLKScsICdsaW5rJywgKCkgPT4gb3BlbkxpbmsoKSksCiAgICAgIHRiQ",
"nV0dG9uKCdjbGVhcicsICdDbGVhciBmb3JtYXR0aW5nJywgJ2NsZWFyJywgKCkgPT4gY2xlYXJGb3JtYXR0aW5nKCksIGZhbHNlKSk7CgogICAgZWxzLmxpbmtJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHBsYWNlaG9sZGVyOiAnV2ViIGFkZHJlc3Mgb3IgZW1haWwnLCAnYXJpYS1sYWJlbCc6ICdMaW5rIGFkZHJlc3MnLAogICAgICBzcGVsbGNoZWNrOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWlucHV0JyB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGFwcGx5TGluaygpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNsb3NlTGluaygpOyB9CiAgICAgIH0sCiAgICB9KTsKICAgIGVscy5saW5rRXJyb3IgPSBoKCdzcGFuJywgeyBjbGFzczogJ2xpbmstZXJyb3InLCByb2xlOiAnYWxlcnQnIH0pOwogICAgZWxzLmxpbmtSZW1vdmUgPSBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdSZW1vdmUgbGluaycsIGRhdGFzZXQ6IHsga2V5OiAnZm10LWxpbmstcmVtb3ZlJyB9LCBvbmNsaWNrOiByZW1vdmVMaW5rIH0pOwogICAgZWxzLmxpbmtiYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtb",
"Glua2JhcicsIGhpZGRlbjogdHJ1ZSB9LAogICAgICBpY29uKCdsaW5rJywgMTgpLCBlbHMubGlua0lucHV0LAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10b25hbCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQXBwbHknLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWFwcGx5JyB9LCBvbmNsaWNrOiBhcHBseUxpbmsgfSksCiAgICAgIGVscy5saW5rUmVtb3ZlLAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiAoKSA9PiBjbG9zZUxpbmsoKSB9KSwKICAgICAgZWxzLmxpbmtFcnJvcik7CgogICAgZnVuY3Rpb24gY3VycmVudFR5cGUoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpIHx8IHNhdmVkOwogICAgICBjb25zdCBibGsgPSByICYmIGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIHJldHVybiBibGsgPyBibGsuZGF0YXNldC50eXBlIHx8ICdwJyA6ICdwJzsKICAgIH0KCiAgICBmdW5jdGlvbiByZWZyZXNoVG9vbGJhcigpIHsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gY3VycmVudFR5cGUoKTsKICAgICAgZWxzLnN0eWxlTGFiZWwudGV4dENvbnRlbnQgPSBTVFlMRV9MQUJFTFt0eXBlXSB8fCAnTm9ybWFsIHRleHQnOwogICAgICBmb3IgKGNvbnN0IFtrZXksIGNtZF0gb2YgW1snYm9sZCcsICdib2xkJ",
"10sIFsnaXRhbGljJywgJ2l0YWxpYyddLCBbJ3N0cmlrZScsICdzdHJpa2VUaHJvdWdoJ11dKSB7CiAgICAgICAgbGV0IG9uID0gZmFsc2U7CiAgICAgICAgdHJ5IHsgb24gPSBkb2N1bWVudC5xdWVyeUNvbW1hbmRTdGF0ZShjbWQpOyB9IGNhdGNoIHsgLyogbm90IHN1cHBvcnRlZCAqLyB9CiAgICAgICAgYnV0dG9uc1trZXldLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKG9uKSk7CiAgICAgIH0KICAgICAgZm9yIChjb25zdCB0IG9mIFsndWwnLCAnb2wnLCAnY2hlY2snXSkgYnV0dG9uc1t0XS5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyh0eXBlID09PSB0KSk7CiAgICAgIGJ1dHRvbnMubGluay5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyghIWFuY2hvckF0KHIpKSk7CiAgICB9CgogICAgLy8g4pSA4pSAIFRoZSBlZGl0YWJsZSBhcmVhIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGVscy5lZGl0b3IgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbmUtYm9keScsIHJvbGU6ICd0ZXh0Ym94JywgJ2FyaWEtbXVsdGlsaW5lJzogJ3RydWUnLCAnYXJpYS1sYWJlbCc6ICdOb3RlJywKICAgICAgc3BlbGxjaGVjazogJ3RydWUnLCBkYXRhc2V0O",
"iB7IGtleTogJ25vdGUtYm9keScsIGVtcHR5OiAnMScgfSwKICAgIH0pOwoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIGUgPT4gewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIGNvbnN0IG1vZCA9IGUuY3RybEtleSB8fCBlLm1ldGFLZXk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBjb25zdCBibGsgPSByICYmIGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CgogICAgICBpZiAobW9kICYmICFlLmFsdEtleSAmJiAhZS5zaGlmdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAneicgJiYgcGFzdGVVbmRvLmxlbmd0aCkgewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICB1bmRvUGFzdGUoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKG1vZCAmJiAhZS5hbHRLZXkgJiYgZS5zaGlmdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAndicpIHsKICAgICAgICAvLyBUaGUgcGFzdGUgZXZlbnQgZm9sbG93cyBzdHJhaWdodCBhd2F5LCBpbiB0aGlzIHNhbWUgdGFzay4KICAgICAgICBwbGFpbk5leHQgPSB0cnVlOwogICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBwbGFpbk5leHQgPSBmYWxzZTsgfSwgMCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChtb2QgJiYgIWUuYWx0S2V5ICYmIGUuc2hpZnRLZXkgJiYgL15EaWdpdFs3ODldJC8udGVzdChlLmNvZGUpKSB7CiAgICAgICAgZS5wcmV2ZW50R",
"GVmYXVsdCgpOwogICAgICAgIGJsb2NrVHlwZSh7IERpZ2l0NzogJ29sJywgRGlnaXQ4OiAndWwnLCBEaWdpdDk6ICdjaGVjaycgfVtlLmNvZGVdKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKG1vZCAmJiAhZS5zaGlmdEtleSAmJiAhZS5hbHRLZXkpIHsKICAgICAgICBjb25zdCBrID0gZS5rZXkudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAoayA9PT0gJ2snKSB7IGUucHJldmVudERlZmF1bHQoKTsgb3BlbkxpbmsoKTsgcmV0dXJuOyB9CiAgICAgICAgaWYgKGsgPT09ICd1JykgeyBlLnByZXZlbnREZWZhdWx0KCk7IHJldHVybjsgfSAvLyBubyB1bmRlcmxpbmUgaW4gdGhlIG1vZGVsCiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmIGJsayAmJiBibGsuZGF0YXNldC50eXBlID09PSAnY2hlY2snKSB7IGUucHJldmVudERlZmF1bHQoKTsgdG9nZ2xlQ2hlY2soYmxrKTsgcmV0dXJuOyB9CiAgICAgIH0KICAgICAgaWYgKGUua2V5ID09PSAnVGFiJyAmJiAhbW9kICYmICFlLmFsdEtleSAmJiBibGsgJiYgZm10LkxJU1RTLmhhcyhibGsuZGF0YXNldC50eXBlKSkgewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBpbmRlbnQoZS5zaGlmdEtleSA_IC0xIDogMSk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJyAmJiAhbW9kICYmICFlLmFsdEtleSAmJiAhZS5pc0NvbXBvc2luZykgewogICAgICAgIC8vIEFuIGVtcHR5IGxpc3Qga",
"XRlbSBlbmRzIHRoZSBsaXN0OyBTaGlmdCtFbnRlciBpcyBhIG5ldyBsaW5lIGxpa2UKICAgICAgICAvLyBhbnkgb3RoZXIsIHNpbmNlIHRoZSBtb2RlbCBoYXMgbm8gbGluZSBicmVha3MgaW5zaWRlIGEgYmxvY2suCiAgICAgICAgaWYgKGJsayAmJiBmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V0LnR5cGUpICYmICFibGsudGV4dENvbnRlbnQpIHsKICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICAgIGNvbnN0IGx2bCA9IE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMDsKICAgICAgICAgIGlmIChsdmwgPiAwKSBibGsuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsdmwgLSAxKTsKICAgICAgICAgIGVsc2Ugc2V0QmxvY2soYmxrLCAncCcpOwogICAgICAgICAgY2hhbmdlZCgpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBpZiAoZS5zaGlmdEtleSkgewogICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2luc2VydFBhcmFncmFwaCcpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoZS5rZXkgPT09ICdCYWNrc3BhY2UnICYmICFtb2QgJiYgYmxrICYmIGJsay5kYXRhc2V0LnR5cGUgIT09ICdwJyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCBibGspKSB7CiAgICAgICAgLy8gQXQgdGhlIHN0YXJ0IG9mIGEgbGlzdCBpdGVtIG9yIGhlYWRpbmcsIEJhY2tzcGFjZSB1bmRvZXMgdGhlCiAgI",
"CAgICAgLy8gZm9ybWF0dGluZyBiZWZvcmUgaXQgc3RhcnRzIGpvaW5pbmcgbGluZXMuCiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGx2bCA9IE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMDsKICAgICAgICBpZiAoZm10LkxJU1RTLmhhcyhibGsuZGF0YXNldC50eXBlKSAmJiBsdmwgPiAwKSBibGsuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsdmwgLSAxKTsKICAgICAgICBlbHNlIHNldEJsb2NrKGJsaywgJ3AnKTsKICAgICAgICBjaGFuZ2VkKCk7CiAgICAgIH0KICAgIH0pOwoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBlID0-IHsKICAgICAgaWYgKGUuaW5wdXRUeXBlID09PSAnaW5zZXJ0VGV4dCcgJiYgKGUuZGF0YSA9PT0gJyAnIHx8IGUuZGF0YSA9PT0gJ8KgJykpIGF1dG9mb3JtYXQoKTsKICAgICAgaWYgKGUuaW5wdXRUeXBlID09PSAnaW5zZXJ0UGFyYWdyYXBoJykgewogICAgICAgIC8vIFRoZSBuZXcgYmxvY2sgaXMgYSBjb3B5IG9mIHRoZSBvbmUgaXQgd2FzIHNwbGl0IGZyb206IGEgdGlja2VkCiAgICAgICAgLy8gYm94IGFuZCBhIGhlYWRpbmcgc2hvdWxkIG5vdCBjYXJyeSBvbiBpbnRvIGFuIGVtcHR5IG5ldyBsaW5lLgogICAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICAgIGNvbnN0IGJsayA9IHIgJiYgYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKTsKICAgICAgICBpZiAoYmxrICYmICFibGsudGV4dENvbnRlbnQpIHsKICAgI",
"CAgICAgIGlmIChibGsuZGF0YXNldC50eXBlID09PSAnY2hlY2snKSBibGsuZGF0YXNldC5jaGVja2VkID0gJzAnOwogICAgICAgICAgaWYgKC9eaFsxMjNdJC8udGVzdChibGsuZGF0YXNldC50eXBlKSkgc2V0QmxvY2soYmxrLCAncCcpOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoL15kZWxldGUvLnRlc3QoZS5pbnB1dFR5cGUpICYmIGVscy5lZGl0b3IuY2hpbGRyZW4ubGVuZ3RoID09PSAxICYmICFlbHMuZWRpdG9yLnRleHRDb250ZW50KSB7CiAgICAgICAgLy8gRXZlcnl0aGluZyBkZWxldGVkOiB0aGUgbm90ZSBzdGFydHMgYWdhaW4gZnJvbSBub3JtYWwgdGV4dC4KICAgICAgICBzZXRCbG9jayhlbHMuZWRpdG9yLmZpcnN0RWxlbWVudENoaWxkLCAncCcpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0pOwoKICAgIGZ1bmN0aW9uIGF1dG9mb3JtYXQoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIgfHwgIXIuY29sbGFwc2VkKSByZXR1cm47CiAgICAgIGNvbnN0IGJsayA9IGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIGlmICghYmxrIHx8IGJsay5kYXRhc2V0LnR5cGUgIT09ICdwJykgcmV0dXJuOwogICAgICBjb25zdCBwcmUgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcmUuc2VsZWN0Tm9kZUNvbnRlbnRzKGJsayk7CiAgICAgIHByZS5zZXRFbmQoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCk7CiAgICAgIGNvbnN0IG0gPSAvX",
"ihcU3sxLDN9KVsgwqBdJC8uZXhlYyhwcmUudG9TdHJpbmcoKSk7CiAgICAgIGNvbnN0IHJ1bGUgPSBtICYmIEFVVE8uZmluZCgoW3JlXSkgPT4gcmUudGVzdChtWzFdKSk7CiAgICAgIGlmICghcnVsZSkgcmV0dXJuOwogICAgICBzZWxlY3QocHJlKTsKICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2RlbGV0ZScpOwogICAgICBzZXRCbG9jayhibGssIHJ1bGVbMV0udHlwZSwgMCwgISFydWxlWzFdLmNoZWNrZWQpOwogICAgfQoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcigncGFzdGUnLCBlID0-IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIGNvbnN0IGRhdGEgPSBlLmNsaXBib2FyZERhdGE7CiAgICAgIGNvbnN0IHRleHQgPSAoZGF0YSAmJiBkYXRhLmdldERhdGEoJ3RleHQvcGxhaW4nKSkgfHwgJyc7CiAgICAgIGNvbnN0IHBsYWluID0gcGxhaW5OZXh0OwogICAgICBwbGFpbk5leHQgPSBmYWxzZTsKICAgICAgY29uc3QgZG9jID0gcGxhaW4gPyBudWxsIDogZm10LnBhc3RlRG9jKHsgaHRtbDogZGF0YSAmJiBkYXRhLmdldERhdGEoJ3RleHQvaHRtbCcpLCB0ZXh0IH0pOwogICAgICAvLyBUZXh0IHdpdGggbm90aGluZyB0byBmb3JtYXQgZ29lcyBpbiB0aGUgd2F5IHR5cGluZyBkb2VzLCBzbyB0aGUKICAgICAgLy8gYnJvd3NlcidzIG93biB1bmRvIHRha2VzIGl0IGJhY2s6IGEgc2luZ2xlIGxpbmUgYXMgY29waWVkLCBzcGFjZXMKI",
"CAgICAgLy8gYW5kIGFsbDsgbW9yZSB0aGFuIHRoYXQgYXMgdGhlIEhUTUwgcmVhZHMgKGEgdGFibGUncyAiIHwgIiwgbm90CiAgICAgIC8vIGl0cyB0YWJzKS4KICAgICAgY29uc3QgbGluZSA9IHRleHQucmVwbGFjZSgvW1xyXG5dKyQvLCAnJyk7CiAgICAgIGlmIChkb2MgJiYgZm10Lmhhc0Zvcm1hdHRpbmcoZG9jKSkgaW5zZXJ0RG9jKGRvYyk7CiAgICAgIGVsc2UgaWYgKGRvYyAmJiAhKGRvYy5sZW5ndGggPT09IDEgJiYgbGluZSAmJiAhL1tcclxuXHRdLy50ZXN0KGxpbmUpKSkgaW5zZXJ0UGxhaW4oZm10LmRvY1RleHQoZG9jKSk7CiAgICAgIGVsc2UgaW5zZXJ0UGxhaW4oZG9jID8gbGluZSA6IHRleHQpOwogICAgICByZXZlYWxDYXJldCgpOwogICAgfSk7CiAgICBlbHMuZWRpdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCBlID0-IHsKICAgICAgLy8gRHJvcHBlZCBIVE1MIHdvdWxkIGJyaW5nIGl0cyBvd24gbWFya3VwOyBkcm9wcGVkIGZpbGVzIGhhdmUgbm93aGVyZSB0byBnby4KICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgfSk7CgogICAgZnVuY3Rpb24gaW5zZXJ0UGxhaW4odGV4dCkgewogICAgICBjb25zdCBsaW5lcyA9IFN0cmluZyh0ZXh0KS5yZXBsYWNlKC9cclxuPy9nLCAnXG4nKS5zcGxpdCgnXG4nKTsKICAgICAgbGluZXMuZm9yRWFjaCgobGluZSwgaSkgPT4gewogICAgICAgIGlmIChpKSBkb2N1bWVudC5leGVjQ29tbWFuZCgnaW5zZXJ0UGFyYWdyYXBoJyk7CiAgICAgICAgaWYgK",
"GxpbmUpIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIGxpbmUpOwogICAgICB9KTsKICAgIH0KCiAgICAvLyDilIDilIAgRm9ybWF0dGVkIHBhc3RlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgLy8KICAgIC8vIFRoZSBibG9ja3MgZ28gaW4gZGlyZWN0bHkgLSB0aGUgYnJvd3NlcidzIGVkaXRpbmcgY29tbWFuZHMgd291bGQKICAgIC8vIG5lc3QgYW5kIHJlc3R5bGUgdGhlbSAtIHdpdGggdGhlIHRleHQgYWZ0ZXIgdGhlIGNhcmV0IGNhcnJpZWQgdG8KICAgIC8vIHRoZSBlbmQgb2Ygd2hhdCB3YXMgcGFzdGVkLiBUaGUgYnJvd3NlcidzIHVuZG8gZG9lcyBub3Qga25vdyBhYm91dAogICAgLy8gdGhhdCwgc28gQ3RybCtaIHN0cmFpZ2h0IGFmdGVyd2FyZHMgcHV0cyBiYWNrIGEgY29weSB0YWtlbiBmaXJzdCAtCiAgICAvLyBvbmUgcGFzdGUgYXQgYSB0aW1lLCB1bnRpbCBhbnl0aGluZyBlbHNlIGNoYW5nZXMgdGhlIHRleHQuCgogICAgLy8gRW1wdHkgdGV4dCBhbmQgZW1wdHkgbWFya3MgbGVmdCBiZWhpbmQgYnkgY3V0dGluZyBhIGJsb2NrIGluIHR3bzsKICAgIC8vIGFsc28gdGhlIDxicj4gdGhhdCBob2xkcyBhbiBlbXB0eSBibG9jayBvcGVuLCBwdXQgY",
"mFjayBsYXRlciBpZgogICAgLy8gdGhlIGJsb2NrIGlzIHN0aWxsIGVtcHR5LgogICAgZnVuY3Rpb24gcHJ1bmUoZWwpIHsKICAgICAgZm9yIChjb25zdCBuIG9mIFsuLi5lbC5jaGlsZE5vZGVzXSkgewogICAgICAgIGlmIChuLm5vZGVUeXBlID09PSAzKSB7IGlmICghbi5kYXRhKSBuLnJlbW92ZSgpOyBjb250aW51ZTsgfQogICAgICAgIGlmIChuLm5vZGVUeXBlICE9PSAxIHx8IG4udGFnTmFtZSA9PT0gJ0JSJykgeyBuLnJlbW92ZSgpOyBjb250aW51ZTsgfQogICAgICAgIHBydW5lKG4pOwogICAgICAgIGlmICghbi5maXJzdENoaWxkKSBuLnJlbW92ZSgpOwogICAgICB9CiAgICB9CiAgICBjb25zdCBob2xkT3BlbiA9IGVsID0-IHsgaWYgKCFlbC5maXJzdENoaWxkKSBlbC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdicicpKTsgfTsKCiAgICBmdW5jdGlvbiBpbnNlcnREb2MoZG9jKSB7CiAgICAgIGlmICghcmFuZ2UoKSkgcmVzdG9yZSgpOwogICAgICBpZiAoIXJhbmdlKCkpIHJldHVybjsKICAgICAgY29uc3QgdW5kbyA9IHBhc3RlVW5kbzsKICAgICAgY29uc3QgYmVmb3JlID0gc25hcHNob3QoKTsKICAgICAgaWYgKCFyYW5nZSgpLmNvbGxhcHNlZCkgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2RlbGV0ZScpOwogICAgICB0aWR5KCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKCiAgICAgIGxldCBub2RlID0gci5zdGFydENvbnRhaW5lcjsKICAgICAgb",
"GV0IG9mZnNldCA9IHIuc3RhcnRPZmZzZXQ7CiAgICAgIGlmIChub2RlID09PSBlbHMuZWRpdG9yKSB7CiAgICAgICAgY29uc3Qga2lkcyA9IGVscy5lZGl0b3IuY2hpbGRyZW47CiAgICAgICAgY29uc3QgayA9IE1hdGgubWluKG9mZnNldCwga2lkcy5sZW5ndGggLSAxKTsKICAgICAgICBub2RlID0ga2lkc1trXTsKICAgICAgICBvZmZzZXQgPSBrIDwgb2Zmc2V0ID8gbm9kZS5jaGlsZE5vZGVzLmxlbmd0aCA6IDA7CiAgICAgIH0KICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihub2RlKTsKICAgICAgaWYgKCFibGspIHJldHVybjsKCiAgICAgIC8vIEN1dCB0aGUgYmxvY2sgYXQgdGhlIGNhcmV0LgogICAgICBjb25zdCBjdXQgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBjdXQuc2V0U3RhcnQobm9kZSwgb2Zmc2V0KTsKICAgICAgY3V0LnNldEVuZChibGssIGJsay5jaGlsZE5vZGVzLmxlbmd0aCk7CiAgICAgIGNvbnN0IGFmdGVyID0gY3V0LmV4dHJhY3RDb250ZW50cygpOwogICAgICBwcnVuZShhZnRlcik7CiAgICAgIHBydW5lKGJsayk7CgogICAgICBjb25zdCBvcmlnID0geyB0eXBlOiBibGsuZGF0YXNldC50eXBlIHx8ICdwJywgbGV2ZWw6IE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMCwgY2hlY2tlZDogYmxrLmRhdGFzZXQuY2hlY2tlZCA9PT0gJzEnIH07CiAgICAgIC8vIExpc3RzIHBhc3RlZCBpbnRvIGEgbGlzdCBnbyBpbiBhdCBpdHMgbGV2ZWwuCiAgICAgIGNvbnN0IGJhc2UgPSBmb",
"XQuTElTVFMuaGFzKG9yaWcudHlwZSkgPyBvcmlnLmxldmVsIDogMDsKICAgICAgY29uc3QgbGV2ZWxPZiA9IGIgPT4gKGZtdC5MSVNUUy5oYXMoYi50eXBlKSA_IE1hdGgubWluKGZtdC5NQVhfTEVWRUwsIGIubGV2ZWwgKyBiYXNlKSA6IDApOwoKICAgICAgbGV0IGxhc3QgPSBibGs7CiAgICAgIGxldCBpID0gMDsKICAgICAgLy8gVGhlIGZpcnN0IGxpbmUgam9pbnMgdGhlIHRleHQgYmVmb3JlIHRoZSBjYXJldDsgb24gYW4gZW1wdHkgbGluZQogICAgICAvLyBpdCBhbHNvIGJyaW5ncyBpdHMga2luZCAoYSBoZWFkaW5nLCBhIGxpc3QgaXRlbSkgd2l0aCBpdC4KICAgICAgaWYgKGRvY1swXS50eXBlID09PSAncCcgfHwgIWJsay50ZXh0Q29udGVudCkgewogICAgICAgIGlmICghYmxrLnRleHRDb250ZW50ICYmIGRvY1swXS50eXBlICE9PSAncCcpIHNldEJsb2NrKGJsaywgZG9jWzBdLnR5cGUsIGxldmVsT2YoZG9jWzBdKSwgZG9jWzBdLmNoZWNrZWQpOwogICAgICAgIGJsay5hcHBlbmQoLi4uaW5saW5lTm9kZXMoZG9jWzBdLnJ1bnMpKTsKICAgICAgICBpID0gMTsKICAgICAgfQogICAgICBmb3IgKDsgaSA8IGRvYy5sZW5ndGg7IGkrKykgewogICAgICAgIGNvbnN0IGVsID0gYmxvY2tFbCh7IC4uLmRvY1tpXSwgbGV2ZWw6IGxldmVsT2YoZG9jW2ldKSB9KTsKICAgICAgICBsYXN0LmFmdGVyKGVsKTsKICAgICAgICBsYXN0ID0gZWw7CiAgICAgIH0KCiAgICAgIC8vIFRoZSB0ZXh0IGFmdGVyIHRoZSBjYXJldCBmb",
"2xsb3dzIHRoZSBwYXN0ZWQgdGV4dCAtIG9uIGEgbGluZSBvZgogICAgICAvLyBpdHMgb3duIGtpbmQgaWYgdGhlIHBhc3RlIGVuZGVkIG9uIGEgZGlmZmVyZW50IGtpbmQgb2YgbGluZS4KICAgICAgY29uc3Qga2luZCA9IGVsID0-IGAke2VsLmRhdGFzZXQudHlwZX06JHtlbC5kYXRhc2V0LmxldmVsIHx8IDB9YDsKICAgICAgbGV0IHRhcmdldCA9IGxhc3Q7CiAgICAgIGlmIChhZnRlci50ZXh0Q29udGVudCAmJiBsYXN0ICE9PSBibGsgJiYga2luZChsYXN0KSAhPT0gYCR7b3JpZy50eXBlfToke2Jhc2V9YCkgewogICAgICAgIHRhcmdldCA9IGJsb2NrRWwoZm10LmJsb2NrKG9yaWcudHlwZSwgW10sIG9yaWcpKTsKICAgICAgICB0YXJnZXQucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgICAgbGFzdC5hZnRlcih0YXJnZXQpOwogICAgICB9CiAgICAgIHBydW5lKGxhc3QpOwogICAgICBjb25zdCBhdCA9IHRhcmdldCA9PT0gbGFzdCA_IGxhc3QuY2hpbGROb2Rlcy5sZW5ndGggOiAwOwogICAgICB0YXJnZXQuYXBwZW5kKGFmdGVyKTsKICAgICAgaG9sZE9wZW4oYmxrKTsKICAgICAgaG9sZE9wZW4obGFzdCk7CiAgICAgIGhvbGRPcGVuKHRhcmdldCk7CiAgICAgIGlmICh0YXJnZXQgPT09IGxhc3QpIHBsYWNlQ2FyZXQobGFzdCwgYXQpOwogICAgICBlbHNlIHBsYWNlQ2FyZXQobGFzdCwgbGFzdC5maXJzdENoaWxkLm5vZGVOYW1lID09PSAnQlInID8gMCA6IGxhc3QuY2hpbGROb2Rlcy5sZW5ndGgpOwoKICAgICAgY2hhb",
"mdlZCgpOwogICAgICBwYXN0ZVVuZG8gPSBbLi4udW5kby5zbGljZSgtMTkpLCBiZWZvcmVdOwogICAgfQoKICAgIC8vIFRoZSBlZGl0b3IncyBibG9ja3MsIGFuZCB0aGUgc2VsZWN0aW9uIGFzIHRleHQgb2Zmc2V0cyB3aXRoaW4gdGhlbS4KICAgIGZ1bmN0aW9uIHNuYXBzaG90KCkgewogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgcmV0dXJuIHsKICAgICAgICBub2RlczogWy4uLmVscy5lZGl0b3IuY2hpbGROb2Rlc10ubWFwKG4gPT4gbi5jbG9uZU5vZGUodHJ1ZSkpLAogICAgICAgIHN0YXJ0OiByICYmIHdoZXJlKHIuc3RhcnRDb250YWluZXIsIHIuc3RhcnRPZmZzZXQpLAogICAgICAgIGVuZDogciAmJiB3aGVyZShyLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXQpLAogICAgICB9OwogICAgfQoKICAgIGZ1bmN0aW9uIHdoZXJlKG5vZGUsIG9mZnNldCkgewogICAgICBjb25zdCBraWRzID0gWy4uLmVscy5lZGl0b3IuY2hpbGROb2Rlc107CiAgICAgIGlmIChub2RlID09PSBlbHMuZWRpdG9yKSB7CiAgICAgICAgY29uc3QgayA9IE1hdGgubWluKG9mZnNldCwga2lkcy5sZW5ndGggLSAxKTsKICAgICAgICByZXR1cm4gayA8IDAgPyBudWxsIDogeyBiOiBrLCBvOiBrIDwgb2Zmc2V0ID8ga2lkc1trXS50ZXh0Q29udGVudC5sZW5ndGggOiAwIH07CiAgICAgIH0KICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihub2RlKTsKICAgICAgaWYgKCFibGspIHJldHVybiBudWxsOwogICAgICBjb25zdCBwcmUgPSBkb",
"2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcmUuc2VsZWN0Tm9kZUNvbnRlbnRzKGJsayk7CiAgICAgIHByZS5zZXRFbmQobm9kZSwgb2Zmc2V0KTsKICAgICAgcmV0dXJuIHsgYjoga2lkcy5pbmRleE9mKGJsayksIG86IHByZS50b1N0cmluZygpLmxlbmd0aCB9OwogICAgfQoKICAgIGZ1bmN0aW9uIHBvaW50QXQocCkgewogICAgICBjb25zdCBibGsgPSBwICYmIGVscy5lZGl0b3IuY2hpbGROb2Rlc1twLmJdOwogICAgICBpZiAoIWJsaykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIoYmxrLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7CiAgICAgIGxldCBsZWZ0ID0gcC5vOwogICAgICBmb3IgKGxldCBuID0gd2Fsa2VyLm5leHROb2RlKCk7IG47IG4gPSB3YWxrZXIubmV4dE5vZGUoKSkgewogICAgICAgIGlmIChsZWZ0IDw9IG4uZGF0YS5sZW5ndGgpIHJldHVybiBbbiwgbGVmdF07CiAgICAgICAgbGVmdCAtPSBuLmRhdGEubGVuZ3RoOwogICAgICB9CiAgICAgIHJldHVybiBbYmxrLCAwXTsKICAgIH0KCiAgICBmdW5jdGlvbiB1bmRvUGFzdGUoKSB7CiAgICAgIGNvbnN0IHJlc3QgPSBwYXN0ZVVuZG8uc2xpY2UoMCwgLTEpOwogICAgICBjb25zdCBzbmFwID0gcGFzdGVVbmRvW3Bhc3RlVW5kby5sZW5ndGggLSAxXTsKICAgICAgZWxzLmVkaXRvci5yZXBsYWNlQ2hpbGRyZW4oLi4uc25hcC5ub2Rlcyk7CiAgICAgIGNvbnN0IGEgPSBwb2ludEF0KHNuY",
"XAuc3RhcnQpOwogICAgICBjb25zdCB6ID0gcG9pbnRBdChzbmFwLmVuZCk7CiAgICAgIGlmIChhICYmIHopIHsKICAgICAgICBjb25zdCBiYWNrID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICBiYWNrLnNldFN0YXJ0KC4uLmEpOwogICAgICAgIGJhY2suc2V0RW5kKC4uLnopOwogICAgICAgIHNlbGVjdChiYWNrKTsKICAgICAgfQogICAgICBjaGFuZ2VkKCk7CiAgICAgIHBhc3RlVW5kbyA9IHJlc3Q7CiAgICAgIHJldmVhbENhcmV0KCk7CiAgICB9CgogICAgLy8gU2Nyb2xscyB0aGUgZWRpdG9yLCBpZiBpdCBoYXMgdG8sIHRvIHNob3cgdGhlIGNhcmV0LgogICAgZnVuY3Rpb24gcmV2ZWFsQ2FyZXQoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgbGV0IGF0ID0gci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgaWYgKCFhdC5oZWlnaHQpIHsKICAgICAgICBjb25zdCBibGsgPSBibG9ja09mKHIuc3RhcnRDb250YWluZXIpOwogICAgICAgIGlmIChibGspIGF0ID0gYmxrLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICB9CiAgICAgIGNvbnN0IGJveCA9IGVscy5lZGl0b3IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICAgIGlmIChhdC5ib3R0b20gPiBib3guYm90dG9tIC0gOCkgZWxzLmVkaXRvci5zY3JvbGxUb3AgKz0gYXQuYm90dG9tIC0gYm94LmJvdHRvbSArIDI0OwogICAgICBlbHNlIGlmIChhdC50b3AgPCBib3gudG9wI",
"CsgOCkgZWxzLmVkaXRvci5zY3JvbGxUb3AgLT0gYm94LnRvcCAtIGF0LnRvcCArIDI0OwogICAgfQoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBlID0-IHsKICAgICAgY29uc3QgYSA9IGUudGFyZ2V0LmNsb3Nlc3QgJiYgZS50YXJnZXQuY2xvc2VzdCgnYVtocmVmXScpOwogICAgICBpZiAoYSAmJiAoZS5jdHJsS2V5IHx8IGUubWV0YUtleSkpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgd2luZG93Lm9wZW4oYS5ocmVmLCAnX2JsYW5rJywgJ25vb3BlbmVyJyk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIC8vIFRoZSBib3ggaXMgZHJhd24gaW4gdGhlIGJsb2NrJ3MgbGVmdCBwYWRkaW5nLCBhdCBpdHMgaW5kZW50LgogICAgICBjb25zdCBibGsgPSBlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0LmNsb3Nlc3QoJy5ibGtbZGF0YS10eXBlPSJjaGVjayJdJyk7CiAgICAgIGlmIChibGsgJiYgZWRpdGFibGUpIHsKICAgICAgICBjb25zdCB4ID0gZS5jbGllbnRYIC0gYmxrLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmxlZnQ7CiAgICAgICAgY29uc3QgYXQgPSAoTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwKSAqIElOREVOVF9QWDsKICAgICAgICBpZiAoeCA-PSBhdCAmJiB4IDwgYXQgKyAyNikgdG9nZ2xlQ2hlY2soYmxrKTsKICAgICAgfQogICAgfSk7CgogICAgY29uc3Qgb25TZWxlY3Rpb24gPSAoKSA9PiB7CiAgICAgIGNvbnN0IHIgPSByY",
"W5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgc2F2ZWQgPSByLmNsb25lUmFuZ2UoKTsKICAgICAgcmVmcmVzaFRvb2xiYXIoKTsKICAgIH07CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdzZWxlY3Rpb25jaGFuZ2UnLCBvblNlbGVjdGlvbik7CgogICAgLy8g4pSA4pSAIFNlYXJjaCBoaWdobGlnaHRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgLy8KICAgIC8vIFBhaW50ZWQgd2l0aCB0aGUgQ1NTIEN1c3RvbSBIaWdobGlnaHQgQVBJOiByYW5nZXMgb3ZlciB0aGUgdGV4dCwKICAgIC8vIGNvbG91cmVkIGJ5IHRoZSBzdHlsZXNoZWV0LCB3aXRoIG5vdGhpbmcgYWRkZWQgdG8gdGhlIG1hcmt1cCAtIHNvIGEKICAgIC8vIGhpZ2hsaWdodCBjYW4gbmV2ZXIgZW5kIHVwIHNhdmVkIGludG8gdGhlIG5vdGUuCgogICAgbGV0IG1hdGNoUmFuZ2VzID0gW107CiAgICBjb25zdCBjYW5IaWdobGlnaHQgPSAoKSA9PiB0eXBlb2YgQ1NTICE9PSAndW5kZWZpbmVkJyAmJiBDU1MuaGlnaGxpZ2h0cyAmJiB0eXBlb2YgSGlnaGxpZ2h0ID09PSAnZnVuY3Rpb24nOwoKICAgIC8vIFRoZSBlZGl0b3IncyB0ZXh0IHdpdGggYSBsaW5lIGJyZWFrIGJldHdlZW4gYmxvY2tzLCBhbmQgd2hlcmUgZ",
"WFjaAogICAgLy8gdGV4dCBub2RlIHNpdHMgaW4gaXQuCiAgICBmdW5jdGlvbiB0ZXh0SW5kZXgoKSB7CiAgICAgIGNvbnN0IHBhcnRzID0gW107CiAgICAgIGxldCB0ZXh0ID0gJyc7CiAgICAgIGVscy5lZGl0b3IuY2hpbGROb2Rlcy5mb3JFYWNoKChibGssIGIpID0-IHsKICAgICAgICBpZiAoYikgdGV4dCArPSAnXG4nOwogICAgICAgIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIoYmxrLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7CiAgICAgICAgZm9yIChsZXQgbiA9IHdhbGtlci5uZXh0Tm9kZSgpOyBuOyBuID0gd2Fsa2VyLm5leHROb2RlKCkpIHsKICAgICAgICAgIHBhcnRzLnB1c2goeyBub2RlOiBuLCBzdGFydDogdGV4dC5sZW5ndGgsIGVuZDogdGV4dC5sZW5ndGggKyBuLmRhdGEubGVuZ3RoIH0pOwogICAgICAgICAgdGV4dCArPSBuLmRhdGE7CiAgICAgICAgfQogICAgICB9KTsKICAgICAgcmV0dXJuIHsgdGV4dCwgcGFydHMgfTsKICAgIH0KCiAgICBmdW5jdGlvbiByYW5nZUZvcihpZHgsIHN0YXJ0LCBlbmQpIHsKICAgICAgY29uc3QgYSA9IGlkeC5wYXJ0cy5maW5kKHAgPT4gc3RhcnQgPj0gcC5zdGFydCAmJiBzdGFydCA8IHAuZW5kKTsKICAgICAgY29uc3QgYiA9IGlkeC5wYXJ0cy5maW5kKHAgPT4gZW5kID4gcC5zdGFydCAmJiBlbmQgPD0gcC5lbmQpOwogICAgICBpZiAoIWEgfHwgIWIpIHJldHVybiBudWxsOwogICAgICBjb25zdCByID0gZG9jdW1lbnQuY3JlYXRlUmFuZ",
"2UoKTsKICAgICAgci5zZXRTdGFydChhLm5vZGUsIHN0YXJ0IC0gYS5zdGFydCk7CiAgICAgIHIuc2V0RW5kKGIubm9kZSwgZW5kIC0gYi5zdGFydCk7CiAgICAgIHJldHVybiByOwogICAgfQoKICAgIGZ1bmN0aW9uIGhpZ2hsaWdodCh0ZXJtcykgewogICAgICBjbGVhckhpZ2hsaWdodHMoKTsKICAgICAgaWYgKCF0ZXJtcyB8fCAhdGVybXMubGVuZ3RoIHx8ICFjYW5IaWdobGlnaHQoKSkgcmV0dXJuIDA7CiAgICAgIGNvbnN0IGlkeCA9IHRleHRJbmRleCgpOwogICAgICBtYXRjaFJhbmdlcyA9IG5zLnNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKGlkeC50ZXh0LCB0ZXJtcykubWFwKG0gPT4gcmFuZ2VGb3IoaWR4LCBtLnN0YXJ0LCBtLmVuZCkpLmZpbHRlcihCb29sZWFuKTsKICAgICAgaWYgKG1hdGNoUmFuZ2VzLmxlbmd0aCkgQ1NTLmhpZ2hsaWdodHMuc2V0KCdna2ItbWF0Y2gnLCBuZXcgSGlnaGxpZ2h0KC4uLm1hdGNoUmFuZ2VzKSk7CiAgICAgIHJldHVybiBtYXRjaFJhbmdlcy5sZW5ndGg7CiAgICB9CgogICAgLy8gTWFya3Mgb25lIG1hdGNoIGFzIHRoZSBjdXJyZW50IG9uZSBhbmQgc2Nyb2xscyBpdCBpbnRvIHRoZSBtaWRkbGUKICAgIC8vIHRoaXJkIG9mIHRoZSBlZGl0b3IgaWYgaXQgaXMgb3V0IG9mIHZpZXcuCiAgICBmdW5jdGlvbiBzaG93TWF0Y2goaSkgewogICAgICBjb25zdCByID0gbWF0Y2hSYW5nZXNbaV07CiAgICAgIGlmICghciB8fCAhY2FuSGlnaGxpZ2h0KCkpIHJldHVybjsKICAgICAgQ1NTL",
"mhpZ2hsaWdodHMuc2V0KCdna2ItbWF0Y2gtY3VycmVudCcsIG5ldyBIaWdobGlnaHQocikpOwogICAgICBjb25zdCBib3ggPSBlbHMuZWRpdG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICBjb25zdCBhdCA9IHIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICAgIGlmIChhdC50b3AgPCBib3gudG9wICsgMjQgfHwgYXQuYm90dG9tID4gYm94LmJvdHRvbSAtIDI0KSB7CiAgICAgICAgZWxzLmVkaXRvci5zY3JvbGxUb3AgKz0gYXQudG9wIC0gYm94LnRvcCAtIGJveC5oZWlnaHQgLyAzOwogICAgICB9CiAgICB9CgogICAgZnVuY3Rpb24gY2xlYXJIaWdobGlnaHRzKCkgewogICAgICBtYXRjaFJhbmdlcyA9IFtdOwogICAgICBpZiAoIWNhbkhpZ2hsaWdodCgpKSByZXR1cm47CiAgICAgIENTUy5oaWdobGlnaHRzLmRlbGV0ZSgnZ2tiLW1hdGNoJyk7CiAgICAgIENTUy5oaWdobGlnaHRzLmRlbGV0ZSgnZ2tiLW1hdGNoLWN1cnJlbnQnKTsKICAgIH0KCiAgICAvLyDilIDilIAgQVBJIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGZ1bmN0aW9uIHNldERvYyhkb2MpIHsKICAgICAgcGFzdGVVbmRvID0gW107CiAgI",
"CAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKC4uLmZtdC5ub3JtYWxpc2VEb2MoZG9jKS5tYXAoYmxvY2tFbCkpOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIC8vIE5ldyB0ZXh0IHVuZGVyIHNvbWVvbmUgd2hvIG1heSBiZSB0eXBpbmcgLSBhIG5ld2VyIHZlcnNpb24gbWVyZ2VkCiAgICAvLyBpbjogdGhlIHNhbWUgdGV4dCBib3gsIHNvIHRoZSBmb2N1cyBhbmQgYSBwaG9uZSdzIGtleWJvYXJkIHN0YXksCiAgICAvLyBhbmQgdGhlIGN1cnNvciBnb2VzIHRvIHdoZXJlIGl0cyBibG9jayB3ZW50IChgbWFwYCwgb2xkIGJsb2NrCiAgICAvLyBpbmRleCDihpIgbmV3KSwgYXMgZmFyIGFsb25nIGl0IGFzIGl0IHdhcy4KICAgIGZ1bmN0aW9uIHJlcGxhY2VEb2MoZG9jLCBtYXApIHsKICAgICAgY29uc3QgZm9jdXNlZCA9IHJvb3QuYWN0aXZlRWxlbWVudCA9PT0gZWxzLmVkaXRvcjsKICAgICAgY29uc3QgciA9IGZvY3VzZWQgPyByYW5nZSgpIDogbnVsbDsKICAgICAgY29uc3QgYXQgPSByICYmIFt3aGVyZShyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0KSwgd2hlcmUoci5lbmRDb250YWluZXIsIHIuZW5kT2Zmc2V0KV07CiAgICAgIHNldERvYyhkb2MpOwogICAgICBpZiAoIWF0IHx8ICFhdFswXSB8fCAhYXRbMV0pIHJldHVybjsKICAgICAgY29uc3Qga2lkcyA9IGVscy5lZGl0b3IuY2hpbGROb2RlczsKICAgICAgY29uc3QgbW92ZWQgPSBwID0-IHsKICAgICAgICBjb25zdCBiID0gTWF0a",
"C5tYXgoMCwgTWF0aC5taW4oa2lkcy5sZW5ndGggLSAxLCBtYXAgJiYgbWFwW3AuYl0gIT09IHVuZGVmaW5lZCA_IG1hcFtwLmJdIDogcC5iKSk7CiAgICAgICAgcmV0dXJuIHsgYiwgbzogTWF0aC5taW4ocC5vLCBraWRzW2JdID8ga2lkc1tiXS50ZXh0Q29udGVudC5sZW5ndGggOiAwKSB9OwogICAgICB9OwogICAgICBjb25zdCBhID0gcG9pbnRBdChtb3ZlZChhdFswXSkpOwogICAgICBjb25zdCB6ID0gcG9pbnRBdChtb3ZlZChhdFsxXSkpOwogICAgICBpZiAoIWEgfHwgIXopIHJldHVybjsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBiYWNrID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICBiYWNrLnNldFN0YXJ0KC4uLmEpOwogICAgICAgIGJhY2suc2V0RW5kKC4uLnopOwogICAgICAgIHNlbGVjdChiYWNrKTsKICAgICAgfSBjYXRjaCB7IC8qIHRoZSBjdXJzb3Igc3RheXMgd2hlcmUgdGhlIGJyb3dzZXIgcHV0IGl0ICovIH0KICAgIH0KCiAgICBmdW5jdGlvbiBzZXRFZGl0YWJsZShvbiwgcGxhY2Vob2xkZXIpIHsKICAgICAgZWRpdGFibGUgPSAhIW9uOwogICAgICBlbHMuZWRpdG9yLmNvbnRlbnRFZGl0YWJsZSA9IGVkaXRhYmxlID8gJ3RydWUnIDogJ2ZhbHNlJzsKICAgICAgZWxzLmVkaXRvci5kYXRhc2V0LnBsYWNlaG9sZGVyID0gcGxhY2Vob2xkZXIgfHwgJ1dyaXRlIGhlcmXigKYnOwogICAgICBlbHMuZWRpdG9yLnNldEF0dHJpYnV0ZSgnYXJpYS1kaXNhYmxlZCcsIFN0cmluZyghZWRpd",
"GFibGUpKTsKICAgICAgZm9yIChjb25zdCBiIG9mIFsuLi5lbHMudG9vbGJhci5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKV0pIGIuZGlzYWJsZWQgPSAhZWRpdGFibGU7CiAgICB9CgogICAgZnVuY3Rpb24gZm9jdXMoKSB7CiAgICAgIGVscy5lZGl0b3IuZm9jdXMoKTsKICAgICAgY29uc3QgZmlyc3QgPSBlbHMuZWRpdG9yLmZpcnN0Q2hpbGQ7CiAgICAgIGlmIChmaXJzdCkgcGxhY2VDYXJldChmaXJzdCwgMCk7CiAgICB9CgogICAgZnVuY3Rpb24gZGVzdHJveSgpIHsKICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcignc2VsZWN0aW9uY2hhbmdlJywgb25TZWxlY3Rpb24pOwogICAgICBjbGVhckhpZ2hsaWdodHMoKTsKICAgICAgY2xvc2VNZW51KHJvb3QpOwogICAgfQoKICAgIHJldHVybiB7CiAgICAgIGVsZW1lbnQ6IGVscy5lZGl0b3IsCiAgICAgIHRvb2xiYXI6IGVscy50b29sYmFyLAogICAgICBsaW5rYmFyOiBlbHMubGlua2JhciwKICAgICAgc2V0RG9jLAogICAgICByZXBsYWNlRG9jLAogICAgICBnZXREb2M6ICgpID0-IHJlYWREb2MoZWxzLmVkaXRvciksCiAgICAgIHNldEVkaXRhYmxlLAogICAgICBmb2N1cywKICAgICAgZGVzdHJveSwKICAgICAgaGlnaGxpZ2h0LAogICAgICBzaG93TWF0Y2gsCiAgICAgIGNsZWFySGlnaGxpZ2h0cywKICAgICAgbWF0Y2hDb3VudDogKCkgPT4gbWF0Y2hSYW5nZXMubGVuZ3RoLAogICAgfTsKICB9CgogIG5zLm5vdGVFZGl0b3IgPSB7IGNyZWF0ZSwgc",
"mVhZERvYyB9Owp9KSgpOwo\"],[\"addon/app/remote.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyB3YXkgdG8gR21haWwKLy8KLy8gVGhlIE5vdGVzIHZpZXcgKHNyYy9jb250ZW50L25vdGVzLmpzKSB0YWxrcyB0byBhIG5vdGVzU3RvcmUsIGFuZCB0aGUKLy8gYm9hcmQncyBkYXRhIGxheWVyIChzcmMvY29udGVudC9zdG9yZS5qcykgdG8gYGFwaS5nbWFpbGAgYW5kCi8vIGBjaHJvbWUuc3RvcmFnZWAuIEluIHRoZSBleHRlbnNpb24gdGhvc2UgcmVhY2ggR21haWwgdGhyb3VnaCB0aGUKLy8gYmFja2dyb3VuZCB3b3JrZXI7IGhlcmUgdGhleSBhc2sgdGhlIHNjcmlwdCB0aGF0IHNlcnZlZCB0aGlzIHBhZ2UsCi8vIHRocm91Z2ggZ29vZ2xlLnNjcmlwdC5ydW4sIHdoaWNoIGFza3MgR21haWwuIFNhbWUgc2hhcGVzLCBzYW1lIGFuc3dlcnMsCi8vIHNvIHRoZSB2aWV3cyBydW4gdW5jaGFuZ2VkLiBUaGUgY2FsZW5kYXIsIGxpa2V3aXNlLCB0aHJvdWdoCi8vIGBhcGkuZ29vZ2xlTWFueWAuIEFsc28gYGhvb2tzYDogdGhlIGFjY291bnQsIGFuZCBvcGV",
"uaW5nIGEKLy8gY29udmVyc2F0aW9uIGluIEdtYWlsLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCBmbXQgPSBucy5ub3RlRm9ybWF0OwogIGNvbnN0IG5vdGVzTG9naWMgPSBucy5ub3Rlc0xvZ2ljOwoKICAvLyBnb29nbGUuc2NyaXB0LnJ1biBhcyBhIHByb21pc2UuIEEgcmVmdXNhbCBmcm9tIHRoZSBzY3JpcHQgYXJyaXZlcyBhcwogIC8vICJub3RfYWxsb3dlZDog4oCmIiwgd2hpY2ggdGhlIHZpZXcga25vd3MgdG8gZXhwbGFpbi4KICBmdW5jdGlvbiBjYWxsKGZuLCAuLi5hcmdzKSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgICBnb29nbGUuc2NyaXB0LnJ1bgogICAgICAgIC53aXRoU3VjY2Vzc0hhbmRsZXIocmVzb2x2ZSkKICAgICAgICAud2l0aEZhaWx1cmVIYW5kbGVyKGVyciA9PiB7CiAgICAgICAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKChlcnIgJiYgZXJyLm1lc3N",
"hZ2UpIHx8IGVyciB8fCAnU29tZXRoaW5nIHdlbnQgd3JvbmcnKS5yZXBsYWNlKC9eKEV4Y2VwdGlvbnxFcnJvcik6XHMqLywgJycpOwogICAgICAgICAgY29uc3QgZSA9IG5ldyBFcnJvcih0ZXh0LnJlcGxhY2UoL15ub3RfYWxsb3dlZDpccyovLCAnJykpOwogICAgICAgICAgaWYgKC9ebm90X2FsbG93ZWQ6Ly50ZXN0KHRleHQpKSBlLmNvZGUgPSAnbm90X2FsbG93ZWQnOwogICAgICAgICAgcmVqZWN0KGUpOwogICAgICAgIH0pW2ZuXSguLi5hcmdzKTsKICAgIH0pOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBwaG9uZSdzIG93biBjb3B5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gU28gdGhhdCB0aGUgYXBwIG9wZW5zIGF0IG9uY2UsIHRoaXMgYnJvd3NlciBrZWVwcyB3aGF0IHRoZSBub3RlcyBuZWVkCiAgLy8gYmVmb3JlIEdtYWlsIGhhcyBhbnN3ZXJlZDogd2hvc2UgdGhleSBhcmUsIHRoZSBsaXN0ICh0aXRsZXMgYW5kIGZpcnN0CiAgLy8gbGluZXMpLCB0aGUgc2NyYXRjaHBhZCdzIHRleHQgYW5kIHRoZSBhcHAncyBzZXR0aW5ncyAtIGFuZCwgYXBhcnQsCiAgLy8gc2NyYXRjaHBhZCB0ZXh0IHR5cGVkIGJ1dCBub3QgeWV0IHNhdmVkLiBUaGUgcGFnZSBvcGVucyBvbiB0aGVzZSwgYW5kCiAgLy8gR21",
"haWwncyBhbnN3ZXJzIHJlcGxhY2UgdGhlbSBhIG1vbWVudCBsYXRlci4gVGhleSBuZXZlciBsZWF2ZSB0aGUgcGhvbmUuCgogIGNvbnN0IENPUFkgPSAnbWVtZGVzay5jb3B5JzsKICBjb25zdCBEUkFGVCA9ICdtZW1kZXNrLmRyYWZ0JzsKICBjb25zdCByZWFkSnNvbiA9IGtleSA9PiB7CiAgICB0cnkgeyByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpIHx8ICdudWxsJyk7IH0gY2F0Y2ggKGVycikgeyByZXR1cm4gbnVsbDsgfQogIH07CiAgY29uc3Qgd3JpdGVKc29uID0gKGtleSwgdmFsdWUpID0-IHsKICAgIHRyeSB7CiAgICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oa2V5KTsKICAgICAgZWxzZSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7CiAgICB9IGNhdGNoIChlcnIpIHsgLyogc3RvcmFnZSBvZmYgb3IgZnVsbDogbm8gY29weSwgb25seSBhIHNsb3dlciBzdGFydCAqLyB9CiAgfTsKICBjb25zdCByZWFkID0gcmVhZEpzb24oQ09QWSk7CiAgLy8geyBhY2NvdW50LCBsYWJlbCwgZm9sZGVycywgbm90ZXMsIHRydW5jYXRlZCwgc2NyYXRjaCwgcHJlZnMsIGNvbHVtbnMgfTsKICAvLyBzY3JhdGNoIGlzIHsgbm90ZSwgZG9jIH0sIG9yIG51bGwgb25jZSBHbWFpbCBoYXMgc2FpZCB0aGVyZSBpcyBub25lLgogIGNvbnN0IGtlcHQgPSByZWFkICYmIHJlYWQudiA9PT0gMSAmJiByZWFkLmFjY291bnQgPyB",
"yZWFkIDogeyB2OiAxIH07CiAgbGV0IGtlZXBUaW1lciA9IDA7CiAgY29uc3Qga2VlcENvcHkgPSAoKSA9PiB7CiAgICBjbGVhclRpbWVvdXQoa2VlcFRpbWVyKTsKICAgIGtlZXBUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gd3JpdGVKc29uKENPUFksIGtlcHQpLCAxNTApOwogIH07CiAgY29uc3QgZm9yZ2V0Q29weSA9ICgpID0-IHsKICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhrZXB0KSkgZGVsZXRlIGtlcHRba107CiAgICBrZXB0LnYgPSAxOwogICAgd3JpdGVKc29uKENPUFksIG51bGwpOwogICAgd3JpdGVKc29uKERSQUZULCBudWxsKTsKICB9OwoKICAvLyBUaGUgbGlzdGluZydzIGZpZWxkcyBvZiBhIG5vdGUsIGFuZCBub3RoaW5nIGVsc2UuCiAgY29uc3QgcGxhaW5Ob3RlID0gbiA9PiBuICYmIHsKICAgIG1lc3NhZ2VJZDogbi5tZXNzYWdlSWQsIHRocmVhZElkOiBuLnRocmVhZElkLCBub3RlSWQ6IG4ubm90ZUlkLCBvd246IG4ub3duLCBrZXk6IG4ua2V5LAogICAgdGl0bGU6IG4udGl0bGUsIHVwZGF0ZWQ6IG4udXBkYXRlZCwgc25pcHBldDogbi5zbmlwcGV0LCBsYWJlbElkczogbi5sYWJlbElkcywgZm9sZGVySWQ6IG4uZm9sZGVySWQgfHwgJycsCiAgfTsKICBjb25zdCBpc1NjcmF0Y2ggPSBuID0-ICEhbiAmJiBuLm5vdGVJZCA9PT0gbm90ZXNMb2dpYy5TQ1JBVENIUEFEX0lEOwogIC8vIFRoZSBzY3JhdGNocGFkJ3MgdGV4dCwgd2hlbiBpdCBpcyB0aGUgbmV3ZXN0IHZlcnNpb24gc2Vlbi4",
"KICBmdW5jdGlvbiBrZWVwU2NyYXRjaChub3RlLCBkb2MpIHsKICAgIGNvbnN0IGhhZCA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZTsKICAgIGlmIChoYWQgJiYgaGFkLm1lc3NhZ2VJZCAhPT0gbm90ZS5tZXNzYWdlSWQgJiYgaGFkLnVwZGF0ZWQgPiBub3RlLnVwZGF0ZWQpIHJldHVybjsKICAgIGtlcHQuc2NyYXRjaCA9IHsgbm90ZTogcGxhaW5Ob3RlKG5vdGUpLCBkb2MgfTsKICAgIGtlZXBDb3B5KCk7CiAgfQoKICBjb25zdCBTID0gewogICAgbGFiZWw6IGtlcHQubGFiZWwgfHwgJ19Ob3RlcycsCiAgICBmb2xkZXJzOiBrZXB0LmZvbGRlcnMgfHwgW10sCiAgICBkb2NzOiBuZXcgTWFwKCksIC8vIG1lc3NhZ2UgaWQg4oaSIGNvbnRlbnQsIGZyb20gYSBzZWFyY2ggb3IgYSBzYXZlCiAgfTsKICBpZiAoa2VwdC5zY3JhdGNoICYmIGtlcHQuc2NyYXRjaC5ub3RlKSBTLmRvY3Muc2V0KGtlcHQuc2NyYXRjaC5ub3RlLm1lc3NhZ2VJZCwga2VwdC5zY3JhdGNoLmRvYyk7CgogIG5zLm5vdGVzU3RvcmUgPSB7CiAgICBsYWJlbE5hbWU6ICgpID0-IFMubGFiZWwsCiAgICBmb2xkZXJzOiAoKSA9PiBTLmZvbGRlcnMsCiAgICAvLyBBIHNhdmUgdGVsbHMgb2YgYSBuZXdlciB2ZXJzaW9uIHNhdmVkIGVsc2V3aGVyZSAoZXJyb3IgY29kZQogICAgLy8gImNvbmZsaWN0IiksIHNvIHRoZSB2aWV3IG1lcmdlcyByYXRoZXIgdGhhbiBvdmVyd3JpdGVzLgogICAgY2hlY2tzQ29uZmxpY3RzOiB0cnVlLAoKICAgIC8",
"vIFdoYXQgdG8gc2hvdyBiZWZvcmUgR21haWwgYW5zd2VycyAobm90ZXMuanMgZnJvbUNvcHkpLCBvciBudWxsLgogICAgY2FjaGVkKCkgewogICAgICBpZiAoIWtlcHQuYWNjb3VudCkgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IGRyYWZ0ID0gcmVhZEpzb24oRFJBRlQpOwogICAgICByZXR1cm4gewogICAgICAgIG5vdGVzOiBrZXB0Lm5vdGVzIHx8IG51bGwsCiAgICAgICAgdHJ1bmNhdGVkOiAhIWtlcHQudHJ1bmNhdGVkLAogICAgICAgIGZvbGRlcnM6IGtlcHQuZm9sZGVycyB8fCBbXSwKICAgICAgICBzY3JhdGNoOiBrZXB0LnNjcmF0Y2ggPyBrZXB0LnNjcmF0Y2ggOiBrZXB0LnNjcmF0Y2ggPT09IG51bGwgPyB7IG5vdGU6IG51bGwsIGRvYzogbnVsbCB9IDogbnVsbCwKICAgICAgICBkcmFmdDogZHJhZnQgJiYgZHJhZnQuYWNjb3VudCA9PT0ga2VwdC5hY2NvdW50ID8gZHJhZnQgOiBudWxsLAogICAgICB9OwogICAgfSwKCiAgICAvLyBUaGUgc2NyYXRjaHBhZCdzIHVuc2F2ZWQgdGV4dCwgb3IgbnVsbCBvbmNlIGl0IGlzIHNhdmVkLgogICAga2VlcERyYWZ0KGQpIHsKICAgICAgd3JpdGVKc29uKERSQUZULCBkID8geyBhY2NvdW50OiB3aG8uYWNjb3VudCwgbm90ZTogcGxhaW5Ob3RlKGQubm90ZSksIGJhc2U6IGQuYmFzZSwgZG9jOiBkLmRvYyB9IDogbnVsbCk7CiAgICB9LAoKICAgIGFzeW5jIGxpc3QoYWNjb3VudCwgcXVlcnkpIHsKICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGwoJ2FwcExpc3QnLCBxdWV",
"yeSB8fCAnJyk7CiAgICAgIFMubGFiZWwgPSByLmxhYmVsOwogICAgICBTLmZvbGRlcnMgPSByLmZvbGRlcnMgfHwgW107CiAgICAgIE9iamVjdC5rZXlzKHIuZG9jcyB8fCB7fSkuZm9yRWFjaChpZCA9PiBTLmRvY3Muc2V0KGlkLCByLmRvY3NbaWRdKSk7CiAgICAgIGlmICghcXVlcnkpIHsKICAgICAgICBPYmplY3QuYXNzaWduKGtlcHQsIHsgbGFiZWw6IFMubGFiZWwsIGZvbGRlcnM6IFMuZm9sZGVycywgbm90ZXM6IHIubm90ZXMubWFwKHBsYWluTm90ZSksIHRydW5jYXRlZDogISFyLnRydW5jYXRlZCB9KTsKICAgICAgICBrZWVwQ29weSgpOwogICAgICB9CiAgICAgIHJldHVybiB7IG5vdGVzOiByLm5vdGVzLCB0cnVuY2F0ZWQ6IHIudHJ1bmNhdGVkLCBmb2xkZXJzOiBTLmZvbGRlcnMgfTsKICAgIH0sCgogICAgLy8gTWVzc2FnZXMgbmV2ZXIgY2hhbmdlLCBzbyBhIG5vdGUncyBjb250ZW50LCBvbmNlIHJlYWQsIGlzIGtlcHQuCiAgICBhc3luYyBib2R5KG5vdGUpIHsKICAgICAgaWYgKFMuZG9jcy5oYXMobm90ZS5tZXNzYWdlSWQpKSByZXR1cm4gUy5kb2NzLmdldChub3RlLm1lc3NhZ2VJZCk7CiAgICAgIGNvbnN0IGRvYyA9IGF3YWl0IGNhbGwoJ2FwcEJvZHknLCBub3RlLm1lc3NhZ2VJZCk7CiAgICAgIFMuZG9jcy5zZXQobm90ZS5tZXNzYWdlSWQsIGRvYyk7CiAgICAgIGlmIChpc1NjcmF0Y2gobm90ZSkpIGtlZXBTY3JhdGNoKG5vdGUsIGRvYyk7CiAgICAgIHJldHVybiBkb2M7CiAgICB9LAoKICAgIGF",
"zeW5jIHNhdmUoYWNjb3VudCwgcHJldmlvdXMsIHNuYXApIHsKICAgICAgY29uc3QgZG9jID0gZm10Lm5vcm1hbGlzZURvYyhzbmFwLmRvYyk7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBjYWxsKCdhcHBTYXZlJywgcHJldmlvdXMgPyBwcmV2aW91cy5tZXNzYWdlSWQgOiAnJywgewogICAgICAgIHRpdGxlOiBzbmFwLnRpdGxlLCBkb2MsIGZvbGRlcklkOiBzbmFwLmZvbGRlcklkIHx8ICcnLCBub3RlSWQ6IHNuYXAubm90ZUlkIHx8ICcnLAogICAgICB9KTsKICAgICAgaWYgKHIuY29uZmxpY3QpIHsKICAgICAgICBjb25zdCBlID0gbmV3IEVycm9yKCdTYXZlZCBvbiBhbm90aGVyIGRldmljZSBpbiB0aGUgbWVhbnRpbWUuJyk7CiAgICAgICAgZS5jb2RlID0gJ2NvbmZsaWN0JzsKICAgICAgICBlLm5ld2VyID0gci5jb25mbGljdDsKICAgICAgICB0aHJvdyBlOwogICAgICB9CiAgICAgIFMuZG9jcy5zZXQoci5ub3RlLm1lc3NhZ2VJZCwgZG9jKTsKICAgICAgaWYgKGlzU2NyYXRjaChyLm5vdGUpKSB7CiAgICAgICAga2VlcFNjcmF0Y2goci5ub3RlLCBkb2MpOwogICAgICAgIGlmIChrZXB0Lm5vdGVzKSBrZXB0Lm5vdGVzID0gW3BsYWluTm90ZShyLm5vdGUpXS5jb25jYXQoa2VwdC5ub3Rlcy5maWx0ZXIobiA9PiBuLmtleSAhPT0gci5ub3RlLmtleSkpOwogICAgICB9CiAgICAgIHJldHVybiByLm5vdGU7CiAgICB9LAoKICAgIGFzeW5jIHJldGlyZShub3RlKSB7IGF3YWl0IGNhbGwoJ2FwcFJldGlyZScsIG5vdGUubWV",
"zc2FnZUlkKTsgfSwKICAgIGFzeW5jIHJlc3RvcmUobm90ZSkgeyBhd2FpdCBjYWxsKCdhcHBSZXN0b3JlJywgbm90ZS5tZXNzYWdlSWQsIG5vdGUuZm9sZGVySWQgfHwgJycpOyB9LAoKICAgIGFzeW5jIG1vdmUobm90ZSwgZm9sZGVySWQpIHsKICAgICAgYXdhaXQgY2FsbCgnYXBwTW92ZScsIG5vdGUubWVzc2FnZUlkLCBmb2xkZXJJZCB8fCAnJyk7CiAgICAgIG5vdGUuZm9sZGVySWQgPSBmb2xkZXJJZCB8fCAnJzsKICAgIH0sCgogICAgYXN5bmMgY3JlYXRlRm9sZGVyKHBhcmVudCwgdGl0bGUpIHsKICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGwoJ2FwcENyZWF0ZUZvbGRlcicsIHBhcmVudCA_IHBhcmVudC5pZCA6ICcnLCB0aXRsZSk7CiAgICAgIFMuZm9sZGVycyA9IHIuZm9sZGVyczsKICAgICAgcmV0dXJuIHIuZm9sZGVyOwogICAgfSwKCiAgICBhc3luYyByZW5hbWVGb2xkZXIoZm9sZGVyLCB0aXRsZSkgewogICAgICBTLmZvbGRlcnMgPSAoYXdhaXQgY2FsbCgnYXBwUmVuYW1lRm9sZGVyJywgZm9sZGVyLmlkLCB0aXRsZSkpLmZvbGRlcnM7CiAgICB9LAoKICAgIGFzeW5jIGRlbGV0ZUZvbGRlcihmb2xkZXIpIHsKICAgICAgUy5mb2xkZXJzID0gKGF3YWl0IGNhbGwoJ2FwcERlbGV0ZUZvbGRlcicsIGZvbGRlci5pZCkpLmZvbGRlcnM7CiAgICB9LAogIH07CgogIC8vIOKUgOKUgCBXaG9zZSBtYWlsYm94LCBhbmQgb3BlbmluZyBhIGNvbnZlcnNhdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3Qgd2hvID0geyBhY2NvdW50OiAnJyB9OwoKICBpZiAoa2VwdC5hY2NvdW50KSB3aG8uYWNjb3VudCA9IGtlcHQuYWNjb3VudDsKCiAgLy8g4pSA4pSAIE9wZW5pbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBPbmUgY2FsbCBhcyB0aGUgYXBwIG9wZW5zIChhcHBTdGFydCksIHNlbnQgYmVmb3JlIGFueXRoaW5nIGlzIGRyYXduOgogIC8vIHRoZSBhY2NvdW50LCB0aGUgc2V0dGluZ3MsIHRoZSBib2FyZCdzIGZpcnN0IGNvbHVtbnMgaWYgaXQgaGFzIG5vbmUsCiAgLy8gYW5kIHRoZSBzY3JhdGNocGFkIC0ganVzdCB3aGV0aGVyIHRoZSBjb3B5IGhlcmUgaXMgc3RpbGwgY3VycmVudCwgaWYKICAvLyB0aGVyZSBpcyBvbmUuIFRoZSBwYWdlIG9wZW5zIG9uIHRoZSBjb3B5IG1lYW53aGlsZSAoc2hlbGwuanMpLgoKICBsZXQgc3RhcnRlZCA9IG51bGw7CiAgbGV0IGNvbHVtbnMgPSAnY29sdW1ucycgaW4ga2VwdCA_IGtlcHQuY29sdW1ucyA6IHVuZGVmaW5lZDsKICBsZXQgcHJlZnNUb3VjaGVkID0gZmFsc2U7CgogIGZ1bmN0aW9uIHN0YXJ0KCk",
"gewogICAgaWYgKHN0YXJ0ZWQpIHJldHVybiBzdGFydGVkOwogICAgY29uc3QgaGludCA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZSA_IGtlcHQuc2NyYXRjaC5ub3RlLm1lc3NhZ2VJZCA6ICcnOwogICAgc3RhcnRlZCA9IGNhbGwoJ2FwcFN0YXJ0JywgaGludCkudGhlbihyID0-IHsKICAgICAgY29uc3QgYWNjb3VudCA9IFN0cmluZyhyLmFjY291bnQgfHwgJycpOwogICAgICAvLyBBIGNvcHkga2VwdCBmb3IgYW5vdGhlciBHb29nbGUgYWNjb3VudCBpcyBubyB1c2UgdG8gdGhpcyBvbmUuCiAgICAgIGNvbnN0IG90aGVyQWNjb3VudCA9ICEha2VwdC5hY2NvdW50ICYmIGtlcHQuYWNjb3VudC50b0xvd2VyQ2FzZSgpICE9PSBhY2NvdW50LnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChvdGhlckFjY291bnQpIGZvcmdldENvcHkoKTsKICAgICAgd2hvLmFjY291bnQgPSBhY2NvdW50OwogICAgICBTLmxhYmVsID0gci5sYWJlbCB8fCBTLmxhYmVsOwogICAgICBTLmZvbGRlcnMgPSByLmZvbGRlcnMgfHwgW107CiAgICAgIGlmICghcHJlZnNUb3VjaGVkKSBzeW5jZWQgPSByLnByZWZzIHx8IHt9OwogICAgICBjb2x1bW5zID0gci5jb2x1bW5zIHx8IG51bGw7CiAgICAgIE9iamVjdC5hc3NpZ24oa2VwdCwgeyBhY2NvdW50LCBsYWJlbDogUy5sYWJlbCwgZm9sZGVyczogUy5mb2xkZXJzLCBwcmVmczogc3luY2VkLCBjb2x1bW5zIH0pOwogICAgICBpZiAoci5zY3JhdGNoKSB7CiAgICAgICAgY29uc3Qgc2F",
"tZSA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZSAmJiBrZXB0LnNjcmF0Y2gubm90ZS5tZXNzYWdlSWQgPT09IHIuc2NyYXRjaC5tZXNzYWdlSWQ7CiAgICAgICAgY29uc3QgZG9jID0gci5kb2MgfHwgKHNhbWUgPyBrZXB0LnNjcmF0Y2guZG9jIDogbnVsbCk7CiAgICAgICAgaWYgKGRvYykgewogICAgICAgICAgUy5kb2NzLnNldChyLnNjcmF0Y2gubWVzc2FnZUlkLCBkb2MpOwogICAgICAgICAga2VwdC5zY3JhdGNoID0geyBub3RlOiBwbGFpbk5vdGUoci5zY3JhdGNoKSwgZG9jIH07CiAgICAgICAgfQogICAgICB9IGVsc2UgewogICAgICAgIGtlcHQuc2NyYXRjaCA9IG51bGw7CiAgICAgIH0KICAgICAgd3JpdGVKc29uKENPUFksIGtlcHQpOwogICAgICByZXR1cm4geyBzY3JhdGNoOiByLnNjcmF0Y2ggfHwgbnVsbCwgb3RoZXJBY2NvdW50IH07CiAgICB9KTsKICAgIHJldHVybiBzdGFydGVkOwogIH0KCiAgY29uc3QgaGFzQ29weSA9ICgpID0-ICEha2VwdC5hY2NvdW50OwoKICAvLyBUaGUgYm9hcmQncyBmaXJzdCBjb2x1bW5zLCB3aGVuIGl0cyBzZXR0aW5ncyBoYXZlIG5vbmU6IGZyb20gdGhlCiAgLy8gZmlyc3QgY2FsbCwgb3IgdGhlIGNvcHkgLSBvciwgZmFpbGluZyB0aG9zZSwgYXNrZWQgZm9yLgogIGFzeW5jIGZ1bmN0aW9uIGZpcnN0Q29sdW1ucygpIHsKICAgIGlmIChjb2x1bW5zICE9PSB1bmRlZmluZWQpIHJldHVybiBjb2x1bW5zOwogICAgaWYgKHN0YXJ0ZWQpIHsKICAgICAgdHJ",
"5IHsgYXdhaXQgc3RhcnRlZDsgfSBjYXRjaCAoZXJyKSB7IC8qIGFza2VkIGZvciBiZWxvdyAqLyB9CiAgICAgIGlmIChjb2x1bW5zICE9PSB1bmRlZmluZWQpIHJldHVybiBjb2x1bW5zOwogICAgfQogICAgcmV0dXJuIGNhbGwoJ2FwcEJvYXJkQ29sdW1ucycpOwogIH0KCiAgY29uc3QgdGhyZWFkVXJsID0gdGhyZWFkSWQgPT4KICAgIGBodHRwczovL21haWwuZ29vZ2xlLmNvbS9tYWlsLz9hdXRodXNlcj0ke2VuY29kZVVSSUNvbXBvbmVudCh3aG8uYWNjb3VudCl9I2FsbC8ke2VuY29kZVVSSUNvbXBvbmVudCh0aHJlYWRJZCl9YDsKCiAgbnMuaG9va3MgPSB7CiAgICBnZXRBY2NvdW50OiAoKSA9PiB3aG8uYWNjb3VudCwKICAgIHRocmVhZFVybCwKICAgIC8vIFRoZSBjb252ZXJzYXRpb24gaW4gR21haWwgLSB3aGljaCwgb24gYSBwaG9uZSwgdGhlIEdtYWlsIGFwcCBtYXkgb2ZmZXIgdG8gb3Blbi4KICAgIG9wZW5UaHJlYWQodGhyZWFkSWQpIHsKICAgICAgd2luZG93Lm9wZW4odGhyZWFkVXJsKHRocmVhZElkKSwgJ19ibGFuaycsICdub29wZW5lcicpOwogICAgfSwKICB9OwoKICAvLyDilIDilIAgVGhlIGJvYXJkJ3MgR21haWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBhcHBCb2F",
"yZEdtYWlsIGFsbG93cyBvbmx5IHdoYXQgdGhlIGJvYXJkIGRvZXMgd2l0aCBHbWFpbC4gRXJyb3JzIGNvbWUKICAvLyBiYWNrIGFzIHRoZSBleHRlbnNpb24ncyBkbyAoImh0dHBfNDA5IiksIHNpbmNlIHRoZSBib2FyZCBhY3RzIG9uIHNvbWUuCgogIGZ1bmN0aW9uIGdtYWlsRXJyb3IobWVzc2FnZSwgc3RhdHVzKSB7CiAgICBjb25zdCBlID0gbmV3IEVycm9yKFN0cmluZyhtZXNzYWdlIHx8ICdHbWFpbCBkaWQgbm90IGFuc3dlci4nKSk7CiAgICBjb25zdCBtID0gL0dtYWlsIGFuc3dlcmVkIChcZHszfSkvLmV4ZWMoZS5tZXNzYWdlKTsKICAgIGUuY29kZSA9IHN0YXR1cyA_IGBodHRwXyR7c3RhdHVzfWAgOiBtID8gYGh0dHBfJHttWzFdfWAgOiAnZ21haWwnOwogICAgcmV0dXJuIGU7CiAgfQoKICBmdW5jdGlvbiBnbWFpbChtZXRob2QsIHBhdGgsIHF1ZXJ5LCBib2R5KSB7CiAgICByZXR1cm4gY2FsbCgnYXBwQm9hcmRHbWFpbCcsIG1ldGhvZCwgcGF0aCwgcXVlcnkgfHwgbnVsbCwgYm9keSB8fCBudWxsKS5jYXRjaChlcnIgPT4gewogICAgICBpZiAoIWVyci5jb2RlKSB0aHJvdyBnbWFpbEVycm9yKGVyci5tZXNzYWdlKTsKICAgICAgdGhyb3cgZXJyOwogICAgfSk7CiAgfQoKICAvLyBBIGJhdGNoIG9mIHJlYWRzIGluIG9uZSByb3VuZCB0cmlwOiBhIGJvYXJkJ3Mgd29ydGggb2YgY2FyZHMgYXQgb25jZS4KICBhc3luYyBmdW5jdGlvbiBnbWFpbE1hbnkobGlzdCkgewogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl",
"0IGNhbGwoJ2FwcEJvYXJkR21haWxNYW55JywgbGlzdCk7CiAgICByZXR1cm4gcmVzdWx0cy5tYXAociA9PiAociAmJiByLmVycm9yID8geyBlcnJvcjogZ21haWxFcnJvcihyLmVycm9yLm1lc3NhZ2UsIHIuZXJyb3Iuc3RhdHVzKSB9IDogcikpOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBjYWxlbmRhcidzIEdvb2dsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIENhbGVuZGFyIGFuZCBUYXNrcyByZWFkcywgaW4gb25lIHJvdW5kIHRyaXAsIGFzIHRoZSBleHRlbnNpb24ncwogIC8vIHdvcmtlciBhbnN3ZXJzIHRoZW06IGVhY2ggdGhlIHJlc3BvbnNlLCBvciB7IGVycm9yIH0gd2l0aCBhIGNvZGUuCgogIGZ1bmN0aW9uIGdvb2dsZUVycm9yKGUpIHsKICAgIGNvbnN0IGVyciA9IG5ldyBFcnJvcihTdHJpbmcoZS5tZXNzYWdlIHx8ICdHb29nbGUgZGlkIG5vdCBhbnN3ZXIuJykpOwogICAgZXJyLmNvZGUgPSBlLmNvZGUgfHwgKGUuc3RhdHVzID8gYGh0dHBfJHtlLnN0YXR1c31gIDogJ2dvb2dsZScpOwogICAgaWYgKGUudXJsKSBlcnIuYWxsb3dVcmwgPSBTdHJpbmcoZS51cmwpOwogICAgcmV0dXJuIGVycjsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGdvb2dsZU1hbnkobGlzdCkgewogICAgY29uc3QgcmVzdWx0cyA",
"9IGF3YWl0IGNhbGwoJ2FwcEdvb2dsZU1hbnknLCBsaXN0KTsKICAgIHJldHVybiByZXN1bHRzLm1hcChyID0-IChyICYmIHIuZXJyb3IgPyB7IGVycm9yOiBnb29nbGVFcnJvcihyLmVycm9yKSB9IDogcikpOwogIH0KCiAgbnMuYXBpID0geyBTVEFURV9DT0RFUzogbmV3IFNldCgpLCBnbWFpbCwgZ21haWxNYW55LCBnb29nbGVNYW55IH07CiAgbnMuYXBwUmVtb3RlID0geyBjYWxsLCBzdGFydCwgaGFzQ29weSwgZmlyc3RDb2x1bW5zIH07CgogIC8vIOKUgOKUgCBjaHJvbWUuc3RvcmFnZSwgYXMgdGhlIGJvYXJkIHVzZXMgaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyAic3luYyIgLSB0aGUgY29sdW1uIGxheW91dCBhbmQgY2FyZCB0aXRsZXMsIG5vdGVzIGFuZCBjb2xvdXJzIC0gaXMgdGhlCiAgLy8gc2NyaXB0J3MgcGVyLXVzZXIgcHJvcGVydGllczogdGhlIHNhbWUgb24gZXZlcnkgcGhvbmUgYW5kIGNvbXB1dGVyCiAgLy8gdGhlIGFwcCBpcyBvcGVuZWQgb24gKHRob3VnaCBub3Qgc2hhcmVkIHdpdGggdGhlIGV4dGVuc2lvbiwgd2hvc2UKICAvLyBjb3B5IGlzIENocm9tZSdzKS4gImxvY2FsIiAtIGNhcmQgb3JkZXIgYW5kIHRoZSBsYXN0IHRhYiAtIGlzIHRoaXMKICAvLyBicm93c2VyJ3Mgb3duIHN0b3JhZ2UsIGFzIGluIHRoZSBleHRlbnNpb24uCgogIGZ1bmN0aW9uIHBpY2s",
"oYWxsLCBrZXlzKSB7CiAgICBpZiAoa2V5cyA9PT0gbnVsbCB8fCBrZXlzID09PSB1bmRlZmluZWQpIHJldHVybiB7IC4uLmFsbCB9OwogICAgaWYgKHR5cGVvZiBrZXlzID09PSAnc3RyaW5nJykga2V5cyA9IFtrZXlzXTsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5cykpIHsKICAgICAgZm9yIChjb25zdCBrIG9mIGtleXMpIGlmIChrIGluIGFsbCkgb3V0W2tdID0gYWxsW2tdOwogICAgICByZXR1cm4gb3V0OwogICAgfQogICAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKGtleXMpKSBvdXRba10gPSBrIGluIGFsbCA_IGFsbFtrXSA6IGtleXNba107CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gVGhlIGFwcCdzIG9sZCBuYW1lLCBrZXB0IHNvIHByZWZzIHNhdmVkIGJlZm9yZSB0aGUgcmVuYW1lIHN0aWxsIGNvdW50LgogIGNvbnN0IExPQ0FMID0gJ3N1cGVybWFpbC4nOwogIGZ1bmN0aW9uIGxvY2FsQWxsKCkgewogICAgY29uc3Qgb3V0ID0ge307CiAgICB0cnkgewogICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxvY2FsU3RvcmFnZS5sZW5ndGg7IGkrKykgewogICAgICAgIGNvbnN0IGsgPSBsb2NhbFN0b3JhZ2Uua2V5KGkpOwogICAgICAgIGlmICghayB8fCAhay5zdGFydHNXaXRoKExPQ0FMKSkgY29udGludWU7CiAgICAgICAgdHJ5IHsgb3V0W2suc2xpY2UoTE9DQUwubGVuZ3RoKV0gPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKGspKTsgfSBjYXRjaCA",
"oZXJyKSB7IC8qIG5vdCBvdXJzICovIH0KICAgICAgfQogICAgfSBjYXRjaCAoZXJyKSB7IC8qIHN0b3JhZ2Ugb2ZmOiBub3RoaW5nIGtlcHQgKi8gfQogICAgcmV0dXJuIG91dDsKICB9CiAgY29uc3QgbG9jYWwgPSB7CiAgICBhc3luYyBnZXQoa2V5cykgeyByZXR1cm4gcGljayhsb2NhbEFsbCgpLCBrZXlzKTsgfSwKICAgIGFzeW5jIHNldChpdGVtcykgewogICAgICB0cnkgeyBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMoaXRlbXMpKSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShMT0NBTCArIGssIEpTT04uc3RyaW5naWZ5KGl0ZW1zW2tdKSk7IH0gY2F0Y2ggKGVycikgeyAvKiBub3Qga2VwdCAqLyB9CiAgICB9LAogICAgYXN5bmMgcmVtb3ZlKGtleXMpIHsKICAgICAgdHJ5IHsgZm9yIChjb25zdCBrIG9mIFtdLmNvbmNhdChrZXlzKSkgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oTE9DQUwgKyBrKTsgfSBjYXRjaCAoZXJyKSB7IC8qIG5vdGhpbmcgdG8gcmVtb3ZlICovIH0KICAgIH0sCiAgfTsKCiAgLy8gRnJvbSB0aGUgZmlyc3QgY2FsbCAob3IgdGhlIGNvcHksIHVudGlsIGl0IGFuc3dlcnMpLCB0aGVuIGtlcHQgaGVyZQogIC8vIGFuZCB3cml0dGVuIHRocm91Z2guCiAgbGV0IHN5bmNlZCA9IGtlcHQucHJlZnMgfHwgbnVsbDsKICBjb25zdCBzeW5jQWxsID0gYXN5bmMgKCkgPT4gewogICAgaWYgKCFzeW5jZWQgJiYgc3RhcnRlZCkgeyB0cnkgeyBhd2FpdCBzdGFydGVkOyB9IGNhdGNoIChlcnIpIHsgLyogYXN",
"rZWQgZm9yIGJlbG93ICovIH0gfQogICAgcmV0dXJuIChzeW5jZWQgPSBzeW5jZWQgfHwgYXdhaXQgY2FsbCgnYXBwUHJlZnNHZXQnLCBudWxsKSk7CiAgfTsKICBjb25zdCBzeW5jID0gewogICAgYXN5bmMgZ2V0KGtleXMpIHsgcmV0dXJuIHBpY2soYXdhaXQgc3luY0FsbCgpLCBrZXlzKTsgfSwKICAgIGFzeW5jIHNldChpdGVtcykgewogICAgICBwcmVmc1RvdWNoZWQgPSB0cnVlOwogICAgICBhd2FpdCBjYWxsKCdhcHBQcmVmc1NldCcsIGl0ZW1zKTsKICAgICAgT2JqZWN0LmFzc2lnbihhd2FpdCBzeW5jQWxsKCksIEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkoaXRlbXMpKSk7CiAgICAgIGtlcHQucHJlZnMgPSBzeW5jZWQ7CiAgICAgIGtlZXBDb3B5KCk7CiAgICB9LAogICAgYXN5bmMgcmVtb3ZlKGtleXMpIHsKICAgICAgcHJlZnNUb3VjaGVkID0gdHJ1ZTsKICAgICAgY29uc3QgbGlzdCA9IFtdLmNvbmNhdChrZXlzKTsKICAgICAgYXdhaXQgY2FsbCgnYXBwUHJlZnNSZW1vdmUnLCBsaXN0KTsKICAgICAgY29uc3QgYWxsID0gYXdhaXQgc3luY0FsbCgpOwogICAgICBmb3IgKGNvbnN0IGsgb2YgbGlzdCkgZGVsZXRlIGFsbFtrXTsKICAgICAga2VwdC5wcmVmcyA9IHN5bmNlZDsKICAgICAga2VlcENvcHkoKTsKICAgIH0sCiAgfTsKCiAgY29uc3QgY2hyb21lTGlrZSA9IChnbG9iYWxUaGlzLmNocm9tZSA9IGdsb2JhbFRoaXMuY2hyb21lIHx8IHt9KTsKICBpZiAoIWNocm9tZUxpa2Uuc3RvcmFnZSkgY2hyb21",
"lTGlrZS5zdG9yYWdlID0geyBsb2NhbCwgc3luYywgb25DaGFuZ2VkOiB7IGFkZExpc3RlbmVyKCkge30gfSB9Owp9KSgpOwo\"],[\"src/content/store.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIEJvYXJkIGRhdGEKLy8KLy8gU2hhcmVkIGJ5IHRoZSBib2FyZCBhbmQgdGhlIGRvY2ssIHNvIGEgbW92ZSBtYWRlIGZyb20gZWl0aGVyIGlzIHNlZW4gYnkKLy8gYm90aC4gR21haWwgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aCBmb3Igd2hpY2ggY29sdW1uIGEgdGhyZWFkIGlzIGluOwovLyB3aGF0IGxpdmVzIGhlcmUgaXMgYSBjYWNoZSBvZiBsYWJlbCBpZHMgYW5kIHRocmVhZCBzdW1tYXJpZXMsIHBsdXMgdGhlCi8vIHNtYWxsIHRoaW5ncyBHbWFpbCBjYW5ub3QgaG9sZCAtIHRoZSBjb2x1bW4gbGF5b3V0IGFuZCB0aGUgdXNlcidzIG93bgovLyBjYXJkIHRpdGxlcywgbm90ZXMgYW5kIGNvbG91cnMgKHN0b3JhZ2Uuc3luYywgc28gdGhleSBmb2xsb3cgdGhlIHVzZXIKLy8gYmV0d2VlbiBjb21wdXRlcnMpIGFuZCBjYXJkIG9yZGVyIHdpdGhpbiBlYWNoIGNvbHVtbiAoc3RvcmFn",
"ZS5sb2NhbCwKLy8gYmVjYXVzZSBpdCBjaGFuZ2VzIG9uIGV2ZXJ5IGRyYWcgYW5kIHN5bmMgaGFzIGEgdGlnaHQgd3JpdGUgcXVvdGEpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB7IGFwaSwgbG9naWMsIEtFWVMgfSA9IG5zOwoKICBjb25zdCBidXMgPSBuZXcgRXZlbnRUYXJnZXQoKTsKICBjb25zdCBlbWl0ID0gKHR5cGUsIGRldGFpbCkgPT4gYnVzLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KHR5cGUsIHsgZGV0YWlsIH0pKTsKCiAgY29uc3QgUyA9IHsKICAgIGxhYmVsczogbmV3IE1hcCgpLCAgIC8vIGxvd2VyLWNhc2VkIG5hbWUg4oaSIGxhYmVsIHJlc291cmNlCiAgICBsYWJlbHNBdDogMCwKICAgIG1ldGE6IG5ldyBNYXAoKSwgICAgIC8vIHRocmVhZCBpZCDihpIgc3VtbWFyeSAoc2VlIGxvZ2ljLnN1bW1hcmlzZVRocmVhZCkKICAgIHBlbmRpbmc6IG5ldyBTZXQoKSwgIC8vIGluLWZsaWdodCB0aHJl",
"YWRzLm1vZGlmeSBwcm9taXNlcwogIH07CgogIC8vIEVycm9ycyB0aGF0IG1lYW4gIm5vdGhpbmcgZWxzZSB3aWxsIHdvcmsgZWl0aGVyIiwgd2hpY2ggbXVzdCBzdG9wIGEKICAvLyBiYXRjaCByYXRoZXIgdGhhbiBiZWluZyBzd2FsbG93ZWQgcGVyIHRocmVhZC4KICBmdW5jdGlvbiBpc0ZhdGFsKGVycikgewogICAgcmV0dXJuIGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpIHx8IGVyci5jb2RlID09PSAnZXh0ZW5zaW9uX3JlbG9hZGVkJzsKICB9CgogIC8vIOKUgOKUgCBTZXR0aW5ncyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgYXN5bmMgZnVuY3Rpb24gbG9hZENvbHVtbnMoYWNjb3VudCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5jb2x1bW5zKGFjY291bnQpOwogICAgY29uc3QgZ290ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQoa2V5KTsKICAgIHJldHVybiBsb2dpYy5ub3JtYWxpc2VDb2x1bW5zKGdvdFtrZXldKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVDb2x1bW5zKGFjY291bnQsIGNvbHVtbnMpIHsKICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMuc2V0KHsgW0tFWVMuY29sdW1ucyhhY2NvdW50KV06IGNvbHVt",
"bnMgfSk7CiAgICBlbWl0KCdjb2x1bW5zLWNoYW5nZWQnLCB7IGNvbHVtbnMgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBsb2FkT3JkZXIoYWNjb3VudCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5vcmRlcihhY2NvdW50KTsKICAgIGNvbnN0IGdvdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpOwogICAgcmV0dXJuIGdvdFtrZXldIHx8IHt9OwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZU9yZGVyKGFjY291bnQsIGxpc3RzLCBjb2x1bW5zKSB7CiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy5vcmRlcihhY2NvdW50KV06IGxvZ2ljLnBydW5lT3JkZXIobGlzdHMsIGNvbHVtbnMpIH0pOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgZWRpdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIGxvYWRDYXJkRWRpdHMoYWNjb3VudCkgewogICAgY29uc3QgYWxsID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQobnVsbCk7CiAgICByZXR1cm4gbG9naWMuY2FyZEVkaXRzRnJvbShhbGwsIEtFWVMuY2FyZFByZWZpeChhY2NvdW50KSk7CiAgfQoKICAvLyBBIG51bGwgZWRpdCBkZWxldGVzIHRo",
"ZSByZWNvcmQuIFN5bmMncyBvd24gcXVvdGEgbWVzc2FnZSAoIlFVT1RBX0JZVEVTCiAgLy8gcXVvdGEgZXhjZWVkZWQiKSBzYXlzIG5vdGhpbmcgYWJvdXQgd2hhdCB0byBkbywgc28gaXQgaXMgcmVwaHJhc2VkLgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVDYXJkRWRpdChhY2NvdW50LCB0aHJlYWRJZCwgZWRpdCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5jYXJkKGFjY291bnQsIHRocmVhZElkKTsKICAgIHRyeSB7CiAgICAgIGlmIChlZGl0KSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLnNldCh7IFtrZXldOiBlZGl0IH0pOwogICAgICBlbHNlIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMucmVtb3ZlKGtleSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKC9xdW90YS9pLnRlc3QoKGVyciAmJiBlcnIubWVzc2FnZSkgfHwgJycpKSB7CiAgICAgICAgdGhyb3cgT2JqZWN0LmFzc2lnbihuZXcgRXJyb3IoCiAgICAgICAgICAnQ2hyb21l4oCZcyBzeW5jZWQgc3RvcmFnZSBpcyBmdWxsLiBDbGVhciB0aGUgbm90ZXMgb24gY2FyZHMgeW91IG5vIGxvbmdlciBuZWVkLCBvciB0YWtlIGZpbmlzaGVkIGNhcmRzIG9mZiB0aGUgYm9hcmQuJwogICAgICAgICksIHsgY29kZTogJ3F1b3RhJyB9KTsKICAgICAgfQogICAgICB0aHJvdyBlcnI7CiAgICB9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBsb2FkRG9ja1Bvc2l0aW9uKCkgewogICAgY29uc3QgZ290ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQoS0VZUy5k",
"b2NrUG9zaXRpb24pOwogICAgY29uc3QgdiA9IGdvdFtLRVlTLmRvY2tQb3NpdGlvbl07CiAgICByZXR1cm4gdiA9PT0gJ3JpZ2h0JyB8fCB2ID09PSAnaGlkZGVuJyA_IHYgOiAnbGVmdCc7CiAgfQoKICAvLyDilIDilIAgTGFiZWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBhc3luYyBmdW5jdGlvbiByZWZyZXNoTGFiZWxzKCkgewogICAgY29uc3QgciA9IGF3YWl0IGFwaS5nbWFpbCgnR0VUJywgJ2xhYmVscycpOwogICAgUy5sYWJlbHMgPSBuZXcgTWFwKChyLmxhYmVscyB8fCBbXSkubWFwKGwgPT4gW2wubmFtZS50b0xvd2VyQ2FzZSgpLCBsXSkpOwogICAgUy5sYWJlbHNBdCA9IERhdGUubm93KCk7CiAgfQoKICBmdW5jdGlvbiBhbGxMYWJlbHMoKSB7CiAgICByZXR1cm4gWy4uLlMubGFiZWxzLnZhbHVlcygpXTsKICB9CgogIC8vIEdtYWlsIGxhYmVsIG5hbWVzIGFyZSB1bmlxdWUgY2FzZS1pbnNlbnNpdGl2ZWx5LCBzbyBsb29rdXBzIGFyZSB0b28uCiAgZnVuY3Rpb24gbGFiZWxJZChuYW1lKSB7CiAgICBjb25zdCBsID0gUy5sYWJlbHMuZ2V0KFN0cmluZyhuYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpKTsKICAgIHJldHVybiBsID8g",
"bC5pZCA6ICcnOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZW5zdXJlTGFiZWxzKG5hbWVzLCB7IGZyZXNoID0gZmFsc2UgfSA9IHt9KSB7CiAgICBpZiAoZnJlc2ggfHwgIVMubGFiZWxzQXQpIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKCiAgICBjb25zdCB3YW50ZWQgPSBbXTsKICAgIGZvciAoY29uc3QgbiBvZiBuYW1lcykgd2FudGVkLnB1c2goLi4ubG9naWMubGFiZWxBbmNlc3RvcnMobiksIG4pOwoKICAgIC8vIFNlcXVlbnRpYWwsIHBhcmVudHMgZmlyc3QuIENyZWF0aW5nIGEgaGFuZGZ1bCBvZiBsYWJlbHMgaGFwcGVucyBvbmNlCiAgICAvLyBwZXIgYm9hcmQsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gZ2FpbiBmcm9tIHJhY2luZyB0aGVtLgogICAgZm9yIChjb25zdCBuYW1lIG9mIFsuLi5uZXcgU2V0KHdhbnRlZCldKSB7CiAgICAgIGlmIChsYWJlbElkKG5hbWUpKSBjb250aW51ZTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgYXBpLmdtYWlsKCdQT1NUJywgJ2xhYmVscycsIG51bGwsIHsKICAgICAgICAgIG5hbWUsCiAgICAgICAgICBsYWJlbExpc3RWaXNpYmlsaXR5OiAnbGFiZWxTaG93JywKICAgICAgICAgIG1lc3NhZ2VMaXN0VmlzaWJpbGl0eTogJ3Nob3cnLAogICAgICAgIH0pOwogICAgICAgIFMubGFiZWxzLnNldChuYW1lLnRvTG93ZXJDYXNlKCksIGNyZWF0ZWQpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICAvLyA0MDk6IGl0IGV4aXN0cyBhZnRlciBhbGwg",
"KGNyZWF0ZWQgaW4gYW5vdGhlciB0YWIsIG9yIGRpZmZlcmluZwogICAgICAgIC8vIG9ubHkgaW4gY2FzZSkuIFJlLXJlYWQgcmF0aGVyIHRoYW4gZmFpbC4KICAgICAgICBpZiAoZXJyLmNvZGUgPT09ICdodHRwXzQwOScpIHsKICAgICAgICAgIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKICAgICAgICAgIGlmIChsYWJlbElkKG5hbWUpKSBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgdGhyb3cgZXJyOwogICAgICB9CiAgICB9CiAgfQoKICAvLyBSZW5hbWVzIHRoZSBHbWFpbCBsYWJlbCBpbiBwbGFjZSwgc28gZXZlcnkgdGhyZWFkIHdlYXJpbmcgaXQgc3RheXMgcHV0LgogIC8vIElmIHRoZSBuZXcgbmFtZSBhbHJlYWR5IGV4aXN0cyBhcyBhIGRpZmZlcmVudCBsYWJlbCwgdGhlIGNvbHVtbiBzaW1wbHkKICAvLyBzd2l0Y2hlcyB0byB0aGF0IGxhYmVsIC0gcGF0Y2hpbmcgd291bGQgZmFpbCB3aXRoIGEgY29uZmxpY3QsIGFuZAogIC8vIHBvaW50aW5nIGEgY29sdW1uIGF0IGFuIGV4aXN0aW5nIGxhYmVsIGlzIGEgcmVhc29uYWJsZSB0aGluZyB0byB3YW50LgogIGFzeW5jIGZ1bmN0aW9uIHJlbmFtZUxhYmVsKG9sZE5hbWUsIG5ld05hbWUpIHsKICAgIGlmIChvbGROYW1lID09PSBuZXdOYW1lKSByZXR1cm4gJ3VuY2hhbmdlZCc7CiAgICBhd2FpdCByZWZyZXNoTGFiZWxzKCk7CiAgICBjb25zdCBvbGRJZCA9IGxhYmVsSWQob2xkTmFtZSk7CiAgICBjb25zdCBleGlzdGluZyA9IGxhYmVsSWQobmV3TmFtZSk7CiAg",
"ICBpZiAoZXhpc3RpbmcgJiYgZXhpc3RpbmcgIT09IG9sZElkKSByZXR1cm4gJ3JlcG9pbnRlZCc7CiAgICBpZiAoIW9sZElkKSByZXR1cm4gJ2NyZWF0ZWQtbGF0ZXInOwogICAgY29uc3QgdXBkYXRlZCA9IGF3YWl0IGFwaS5nbWFpbCgnUEFUQ0gnLCBgbGFiZWxzLyR7b2xkSWR9YCwgbnVsbCwgeyBuYW1lOiBuZXdOYW1lIH0pOwogICAgUy5sYWJlbHMuZGVsZXRlKG9sZE5hbWUudG9Mb3dlckNhc2UoKSk7CiAgICBTLmxhYmVscy5zZXQobmV3TmFtZS50b0xvd2VyQ2FzZSgpLCB1cGRhdGVkKTsKICAgIHJldHVybiAncmVuYW1lZCc7CiAgfQoKICAvLyDilIDilIAgVGhyZWFkcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gdGhyZWFkKGlkKSB7CiAgICByZXR1cm4gUy5tZXRhLmdldChpZCkgfHwgbnVsbDsKICB9CgogIC8vIEZldGNoZXMgbWV0YWRhdGEgb25seSBmb3IgdGhyZWFkcyB0aGF0IGFyZSBuZXcgdG8gdGhlIGNhY2hlIG9yIHdob3NlCiAgLy8gaGlzdG9yeUlkIG1vdmVkLiBPbiBhIHdhcm0gcmVmcmVzaCBvZiBhbiB1bmNoYW5nZWQgYm9hcmQgdGhhdCBpcyB6ZXJvCiAgLy8gY2FsbHMgYmV5b25kIHRoZSBvbmUgbGlzdCBw",
"ZXIgY29sdW1uLgogIGFzeW5jIGZ1bmN0aW9uIGh5ZHJhdGUocmVmcywgYWNjb3VudCkgewogICAgY29uc3QgbmVlZCA9IHJlZnMuZmlsdGVyKHQgPT4gewogICAgICBjb25zdCBtID0gUy5tZXRhLmdldCh0LmlkKTsKICAgICAgcmV0dXJuICFtIHx8ICh0Lmhpc3RvcnlJZCAmJiBtLmhpc3RvcnlJZCAhPT0gU3RyaW5nKHQuaGlzdG9yeUlkKSk7CiAgICB9KTsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBhcGkuZ21haWxNYW55KG5lZWQubWFwKHQgPT4gWydHRVQnLCBgdGhyZWFkcy8ke3QuaWR9YCwgewogICAgICBmb3JtYXQ6ICdtZXRhZGF0YScsCiAgICAgIG1ldGFkYXRhSGVhZGVyczogWydTdWJqZWN0JywgJ0Zyb20nLCAnRGF0ZSddLAogICAgfV0pKTsKICAgIHJlc3VsdHMuZm9yRWFjaCgoZnVsbCwgaSkgPT4gewogICAgICAvLyBPbmUgdGhyZWFkIGRlbGV0ZWQgYmV0d2VlbiBsaXN0IGFuZCBnZXQgbXVzdCBub3Qgc2luayB0aGUgYm9hcmQuCiAgICAgIGlmIChmdWxsICYmIGZ1bGwuZXJyb3IpIHsKICAgICAgICBpZiAoaXNGYXRhbChmdWxsLmVycm9yKSkgdGhyb3cgZnVsbC5lcnJvcjsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKGZ1bGwpIFMubWV0YS5zZXQobmVlZFtpXS5pZCwgbG9naWMuc3VtbWFyaXNlVGhyZWFkKGZ1bGwsIGFjY291bnQpKTsKICAgIH0pOwogIH0KCiAgLy8gQnJpbmdzIHRoZSBjb2x1bW5zJyBsYWJlbCBuYW1lcyBpbiBsaW5lIHdpdGggR21haWwgKGEgbGFiZWwgcmVu",
"YW1lZAogIC8vIHRoZXJlIGlzIGZvbGxvd2VkIGJ5IGl0cyBpZCkgYW5kIHJlY29yZHMgaWRzIGZvciBsYWJlbHMgdGhhdCBoYXZlCiAgLy8gdGhlbS4gU2F2ZWQgb25seSB3aGVuIHNvbWV0aGluZyBjaGFuZ2VkLgogIGFzeW5jIGZ1bmN0aW9uIHN5bmNDb2x1bW5MYWJlbHMoYWNjb3VudCwgY29sdW1ucykgewogICAgY29uc3QgeyBjb2x1bW5zOiBuZXh0LCBjaGFuZ2VkIH0gPSBsb2dpYy5yZXNvbHZlQ29sdW1uTGFiZWxzKGNvbHVtbnMsIFsuLi5TLmxhYmVscy52YWx1ZXMoKV0pOwogICAgaWYgKGNoYW5nZWQpIGF3YWl0IHNhdmVDb2x1bW5zKGFjY291bnQsIG5leHQpOwogICAgcmV0dXJuIG5leHQ7CiAgfQoKICAvLyBFdmVyeXRoaW5nIHRoZSBib2FyZCBuZWVkcyBmb3Igb25lIHJlbmRlcjogcGVyLWNvbHVtbiB0aHJlYWQgaWRzCiAgLy8gKGVhY2ggdGhyZWFkIGluIGV4YWN0bHkgb25lIGNvbHVtbiksIHdoaWNoIGNvbHVtbnMgd2VyZSBjdXQgb2ZmLCBhbmQKICAvLyB0aGUgY29sdW1ucyB0aGVtc2VsdmVzLCBpbiBjYXNlIGEgbGFiZWwgd2FzIHJlbmFtZWQgaW4gR21haWwuCiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvYXJkKGFjY291bnQsIGNvbHVtbnNJbikgewogICAgLy8gTGV0IGFueSBtb3ZlIHN0aWxsIGluIGZsaWdodCBsYW5kIGZpcnN0LCBvciB0aGUgbGlzdCBjb3VsZCBzaG93IHRoZQogICAgLy8gdGhyZWFkIGJhY2sgaW4gdGhlIGNvbHVtbiBpdCBpcyBsZWF2aW5nLgogICAgYXdhaXQgUHJvbWlzZS5h",
"bGxTZXR0bGVkKFsuLi5TLnBlbmRpbmddKTsKICAgIC8vIFJlbmFtZXMgZmlyc3Q6IGVuc3VyaW5nIGxhYmVscyBieSB0aGVpciBzdGFsZSBuYW1lcyB3b3VsZCByZWNyZWF0ZQogICAgLy8gdGhlIG9sZCBvbmVzLCBlbXB0eS4KICAgIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKICAgIGxldCBjb2x1bW5zID0gYXdhaXQgc3luY0NvbHVtbkxhYmVscyhhY2NvdW50LCBjb2x1bW5zSW4pOwogICAgYXdhaXQgZW5zdXJlTGFiZWxzKGNvbHVtbnMubWFwKGMgPT4gYy5sYWJlbCkpOwogICAgY29sdW1ucyA9IGF3YWl0IHN5bmNDb2x1bW5MYWJlbHMoYWNjb3VudCwgY29sdW1ucyk7CgogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGFwaS5nbWFpbE1hbnkoY29sdW1ucy5tYXAoY29sID0-IFsnR0VUJywgJ3RocmVhZHMnLCB7IGxhYmVsSWRzOiBsYWJlbElkKGNvbC5sYWJlbCksIG1heFJlc3VsdHM6IDEwMCB9XSkpOwogICAgY29uc3QgZmFpbGVkID0gcmVzdWx0cy5maW5kKHIgPT4gciAmJiByLmVycm9yKTsKICAgIGlmIChmYWlsZWQpIHRocm93IGZhaWxlZC5lcnJvcjsKCiAgICBjb25zdCByYXcgPSB7fTsKICAgIGNvbnN0IHRydW5jYXRlZCA9IHt9OwogICAgY29uc3QgcmVmcyA9IG5ldyBNYXAoKTsKICAgIGNvbHVtbnMuZm9yRWFjaCgoY29sLCBpKSA9PiB7CiAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2ldIHx8IHt9OwogICAgICBjb25zdCB0aHJlYWRzID0gci50aHJlYWRzIHx8IFtdOwogICAgICByYXdbY29sLmlkXSA9IHRo",
"cmVhZHMubWFwKHQgPT4gdC5pZCk7CiAgICAgIHRydW5jYXRlZFtjb2wuaWRdID0gISFyLm5leHRQYWdlVG9rZW47CiAgICAgIGZvciAoY29uc3QgdCBvZiB0aHJlYWRzKSByZWZzLnNldCh0LmlkLCB0KTsKICAgIH0pOwoKICAgIGF3YWl0IGh5ZHJhdGUoWy4uLnJlZnMudmFsdWVzKCldLCBhY2NvdW50KTsKICAgIGNvbnN0IGxpc3RzID0gbG9naWMuYXNzaWduQ29sdW1ucyhjb2x1bW5zLCByYXcpOwogICAgZm9yIChjb25zdCBpZCBvZiBPYmplY3Qua2V5cyhsaXN0cykpIGxpc3RzW2lkXSA9IGxpc3RzW2lkXS5maWx0ZXIodCA9PiBTLm1ldGEuaGFzKHQpKTsKICAgIGVtaXQoJ2JvYXJkLWxvYWRlZCcsIHt9KTsKICAgIHJldHVybiB7IGxpc3RzLCB0cnVuY2F0ZWQsIGNvbHVtbnMgfTsKICB9CgogIC8vIGBzb3VyY2VgIGxldHMgbGlzdGVuZXJzIGlnbm9yZSBlY2hvZXMgb2YgdGhlaXIgb3duIGNoYW5nZXM6IHRoZSBib2FyZAogIC8vIGhhcyBhbHJlYWR5IGRyYXduIGEgbW92ZSBpdCBtYWRlLCB0aGUgZG9jayBoYXMgbm90LgogIGFzeW5jIGZ1bmN0aW9uIG1vZGlmeSh0aHJlYWRJZCwgZGlmZiwgc291cmNlKSB7CiAgICBjb25zdCBwID0gYXBpLmdtYWlsKCdQT1NUJywgYHRocmVhZHMvJHt0aHJlYWRJZH0vbW9kaWZ5YCwgbnVsbCwgZGlmZik7CiAgICBTLnBlbmRpbmcuYWRkKHApOwogICAgdHJ5IHsKICAgICAgYXdhaXQgcDsKICAgIH0gZmluYWxseSB7CiAgICAgIFMucGVuZGluZy5kZWxldGUocCk7CiAgICB9CiAg",
"ICAvLyBNYXJrIHRoZSBjYWNoZWQgc3VtbWFyeSBzdGFsZSBzbyB0aGUgbmV4dCByZWZyZXNoIHJlLXJlYWRzIGl0LCBhbmQKICAgIC8vIGtlZXAgaXRzIGxhYmVsIHNldCBob25lc3QgaW4gdGhlIG1lYW50aW1lLgogICAgY29uc3QgbSA9IFMubWV0YS5nZXQodGhyZWFkSWQpOwogICAgaWYgKG0pIHsKICAgICAgbS5oaXN0b3J5SWQgPSAnJzsKICAgICAgY29uc3QgbGFiZWxzID0gbmV3IFNldChtLmxhYmVsSWRzKTsKICAgICAgZGlmZi5yZW1vdmVMYWJlbElkcy5mb3JFYWNoKGlkID0-IGxhYmVscy5kZWxldGUoaWQpKTsKICAgICAgZGlmZi5hZGRMYWJlbElkcy5mb3JFYWNoKGlkID0-IGxhYmVscy5hZGQoaWQpKTsKICAgICAgbS5sYWJlbElkcyA9IFsuLi5sYWJlbHNdOwogICAgfQogICAgZW1pdCgndGhyZWFkLWNoYW5nZWQnLCB7IHRocmVhZElkLCBzb3VyY2UgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBtb3ZlVG9Db2x1bW4odGhyZWFkSWQsIGNvbHVtbnMsIGNvbHVtbklkLCBzb3VyY2UpIHsKICAgIGF3YWl0IGVuc3VyZUxhYmVscyhjb2x1bW5zLm1hcChjID0-IGMubGFiZWwpKTsKICAgIGF3YWl0IG1vZGlmeSh0aHJlYWRJZCwgbG9naWMubW92ZUxhYmVsRGlmZihjb2x1bW5zLCBjb2x1bW5JZCwgbGFiZWxJZCksIHNvdXJjZSk7CiAgfQoKICAvLyBUYWtpbmcgYSBjYXJkIG9mZiB0aGUgYm9hcmQgYWxzbyBmb3JnZXRzIGl0cyB0aXRsZSwgbm90ZSBhbmQgY29sb3VyLgogIC8vIEVkaXRzIHdvdWxkIG90aGVy",
"d2lzZSBvdXRsaXZlIHRoZWlyIGNhcmQsIGFuZCBzeW5jJ3MgcXVvdGEgaXMgc21hbGwKICAvLyBlbm91Z2ggdGhhdCBsZWZ0b3ZlcnMgd291bGQgZXZlbnR1YWxseSBjcm93ZCBvdXQgdGhlIG9uZXMgaW4gdXNlLiBBCiAgLy8gY2FyZCB0aGF0IG1lcmVseSBtb3ZlcyB0byBEb25lIGtlZXBzIHRoZW0uCiAgYXN5bmMgZnVuY3Rpb24gcmVtb3ZlRnJvbUJvYXJkKHRocmVhZElkLCBjb2x1bW5zLCBzb3VyY2UsIGFjY291bnQpIHsKICAgIGlmICghUy5sYWJlbHNBdCkgYXdhaXQgcmVmcmVzaExhYmVscygpOwogICAgYXdhaXQgbW9kaWZ5KHRocmVhZElkLCBsb2dpYy5yZW1vdmVMYWJlbERpZmYoY29sdW1ucywgbGFiZWxJZCksIHNvdXJjZSk7CiAgICBpZiAoYWNjb3VudCkgYXdhaXQgc2F2ZUNhcmRFZGl0KGFjY291bnQsIHRocmVhZElkLCBudWxsKS5jYXRjaCgoKSA9PiB7fSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBzZWFyY2godGV4dCwgYWNjb3VudCkgewogICAgY29uc3QgciA9IGF3YWl0IGFwaS5nbWFpbCgnR0VUJywgJ3RocmVhZHMnLCB7IHE6IGxvZ2ljLnNlYXJjaFF1ZXJ5KHRleHQpLCBtYXhSZXN1bHRzOiAxNSB9KTsKICAgIGNvbnN0IHJlZnMgPSByLnRocmVhZHMgfHwgW107CiAgICBhd2FpdCBoeWRyYXRlKHJlZnMsIGFjY291bnQpOwogICAgcmV0dXJuIHJlZnMubWFwKHQgPT4gdC5pZCkuZmlsdGVyKGlkID0-IFMubWV0YS5oYXMoaWQpKTsKICB9CgogIC8vIFdoaWNoIGNvbHVtbiAoaWYgYW55KSBhIHNp",
"bmdsZSB0aHJlYWQgaXMgaW4gLSBmb3IgdGhlIGRvY2ssIHdoaWNoIGhhcwogIC8vIG5vIGJvYXJkIGxvYWRlZC4gZm9ybWF0PW1pbmltYWwgaXMgdGhlIGNoZWFwZXN0IGNhbGwgdGhhdCByZXR1cm5zCiAgLy8gbGFiZWwgaWRzLgogIGFzeW5jIGZ1bmN0aW9uIHRocmVhZENvbHVtbih0aHJlYWRJZCwgY29sdW1ucykgewogICAgaWYgKCFTLmxhYmVsc0F0KSBhd2FpdCByZWZyZXNoTGFiZWxzKCk7CiAgICBjb25zdCB0ID0gYXdhaXQgYXBpLmdtYWlsKCdHRVQnLCBgdGhyZWFkcy8ke3RocmVhZElkfWAsIHsgZm9ybWF0OiAnbWluaW1hbCcgfSk7CiAgICBjb25zdCBsYWJlbHMgPSAodC5tZXNzYWdlcyB8fCBbXSkuZmxhdE1hcChtID0-IG0ubGFiZWxJZHMgfHwgW10pOwogICAgcmV0dXJuIGxvZ2ljLmNvbHVtbkZvckxhYmVscyhjb2x1bW5zLCBsYWJlbHMsIGxhYmVsSWQpOwogIH0KCiAgbnMuc3RvcmUgPSB7CiAgICBidXMsIGxvYWRDb2x1bW5zLCBzYXZlQ29sdW1ucywgbG9hZE9yZGVyLCBzYXZlT3JkZXIsIGxvYWRDYXJkRWRpdHMsIHNhdmVDYXJkRWRpdCwgbG9hZERvY2tQb3NpdGlvbiwKICAgIHJlZnJlc2hMYWJlbHMsIGVuc3VyZUxhYmVscywgcmVuYW1lTGFiZWwsIGxhYmVsSWQsIGFsbExhYmVscywKICAgIHRocmVhZCwgbG9hZEJvYXJkLCBtb3ZlVG9Db2x1bW4sIHJlbW92ZUZyb21Cb2FyZCwgc2VhcmNoLCB0aHJlYWRDb2x1bW4sCiAgfTsKfSkoKTsK\"],[\"addon/app/remote-board.js\",\"Ly8g4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyBmaXJzdCBjb2x1bW4gbGF5b3V0Ci8vCi8vIFRoZSBib2FyZCBrZWVwcyBpdHMgY29sdW1uIGxheW91dCBpbiBpdHMgc3luY2VkIHNldHRpbmdzLCB3aGljaCBoZXJlCi8vIGFyZSB0aGUgYXBwJ3Mgb3duLiBVbnRpbCBpdCBoYXMgb25lLCB0aGUgZXh0ZW5zaW9uJ3MgZGVmYXVsdCBjb2x1bW5zCi8vIHdvdWxkIGJyaW5nIGJhY2sgIl9Cb2FyZC9XYWl0aW5nIiBhcyBhIGZyZXNoLCBlbXB0eSBsYWJlbCBmb3Igc29tZW9uZQovLyB3aG9zZSBjb2x1bW4gaXMgIl9Cb2FyZC9XYWl0aW5nIG9uIG90aGVycyI7IHNvIHRoZSBmaXJzdCBsYXlvdXQgaXMKLy8gdGhlIGJvYXJkJ3MgbGFiZWxzIGFzIEdtYWlsIGhhcyB0aGVtIC0gYXMgdGhlIHBob25lIHBhbmVsIHJlYWRzIHRoZW0uCi8vIFdpdGggbm8gYm9hcmQgbGFiZWxzIGF0IGFsbCwgdGhlIHVzdWFsIGNvbHVtbnMsIG1hZGUgYXMgaW4gQ2hyb21lLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IGdsb2JhbFRoaXMuZ2tiOwogIGNvbnN0IHsgc3RvcmUsIGxvZ2ljLCBLRVlTIH0gPSBuczsKICBjb25zdCBzYXZlZCA9IHN0b3JlLmxvYWRDb2x1bW5zOwoKICBzdG9yZS5sb2FkQ29sdW1ucyA9IGFzeW5jIGFjY291bnQgPT4gewogICAgY29uc3Qga2V5ID0gS0VZUy5jb2x1bW5zKGFjY291bnQpOwogICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLmdldChrZXkpKVtrZXldKSByZXR1cm4gc2F2ZWQoYWNjb3VudCk7CiAgICBjb25zdCBmcm9tTGFiZWxzID0gYXdhaXQgbnMuYXBwUmVtb3RlLmZpcnN0Q29sdW1ucygpOwogICAgcmV0dXJuIGxvZ2ljLm5vcm1hbGlzZUNvbHVtbnMoZnJvbUxhYmVscyB8fCB1bmRlZmluZWQpOwogIH07Cn0pKCk7Cg\"],[\"src/content/notes.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4",
"pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBub3RlcyB2aWV3Ci8vCi8vIFRoZSBib2FyZCdzIHNlY29uZCB0YWI6IGZvbGRlcnMgb24gdGhlIGxlZnQsIHRoZW4gdGhlIG5vdGVzIGluIHRoZQovLyBjaG9zZW4gZm9sZGVyLCB0aGVuIHRoZSBvcGVuIG5vdGUuIFR5cGluZyBzYXZlcyBieSBpdHNlbGYgYSBtb21lbnQgYWZ0ZXIKLy8geW91IHN0b3AsIGFuZCBhZ2FpbiBvbiBzd2l0Y2hpbmcgbm90ZXMsIHN3aXRjaGluZyB0YWJzIG9yIGNsb3Npbmc7Ci8vIEN0cmwrUyBzYXZlcyBhdCBvbmNlLiBBIG5vdGUgbW92ZXMgdG8gYW5vdGhlciBmb2xkZXIgYnkgZHJhZ2dpbmcgaXQgb250bwovLyBvbmUsIG9yIGZyb20gdGhlIGZvbGRlciBidXR0b24gYWJvdmUgdGhlIHRleHQuCi8vCi8vIFRoZSBib2FyZCBvd25zIHRoZSBvdmVybGF5LCB0aGUgaGVhZGVyIGFuZCB0aGUgYWNjb3VudCBwYW5lbHMgKHNldHVwLAovLyBjb25uZWN0KTsgdGhpcyBmaWxlIG93bnMgZXZlcnl0aGluZyBpbnNpZGUgdGhlIGJvZHkgd2hpbGUgdGhlIE5vdGVzIHRhYgovLyBpcyBzaG93aW5nLiBJdHMgZWxlbWVudCBpcyBidWlsdCBvbmNlIGFuZCBrZXB0LCBzbyB0aGF0IGEgYm9hcmQgcmVkcmF3Ci8vIG5ldmVyIHB1bGxzIHRoZSB0ZXh0IGJveCBvdXQgZnJvbSB1bmRlciBzb21lb25lIHdobyBpcyB0eXBpbmcuCi8vCi8vIFRoZSBzY3JhdGNocGFkIGlzIHRoZSBub3RlIHRoYXQgaXMgb3BlbiB3aGVuZXZlciBubyBvd",
"GhlciBvbmUgaXM6IG9uZQovLyBub3RlIHdpdGggYSBmaXhlZCBpZCwgc2hhcmVkIGJ5IGV2ZXJ5IGNvbXB1dGVyIGFuZCBwaG9uZSwgdGhlcmUgdG8gdHlwZQovLyBpbnRvIHRoZSBtb21lbnQgdGhlIG5vdGVzIGFwcGVhci4gSXQgaXMgcGlubmVkIGF0IHRoZSB0b3Agb2YgdGhlIGxpc3QsCi8vIGFuZCBjYW5ub3QgYmUgcmVuYW1lZCwgbW92ZWQgb3IgZGVsZXRlZC4KLy8KLy8gVGhlIHBob25lIGFwcCAoYWRkb24vYXBwKSBydW5zIHRoaXMgc2FtZSB2aWV3IGZ1bGwtc2NyZWVuIG9uIGEgcGhvbmUsCi8vIHdpdGggYSBkaWZmZXJlbnQgd2F5IHRvIEdtYWlsIGJlaGluZCBub3Rlc1N0b3JlLiBBIHBob25lIHNob3dzIG9uZQovLyB0aGluZyBhdCBhIHRpbWUsIGFuZCB0aGUgZWxlbWVudCBzYXlzIHdoaWNoIChkYXRhLXZpZXcpOiAiaG9tZSIsIHRoZQovLyBzZWFyY2ggYm94IGFuZCB0aGUgc2NyYXRjaHBhZDsgImxpc3QiLCB0aGUgbm90ZXMgaW4gYSBmb2xkZXIgb3IgYQovLyBzZWFyY2g7IG9yICJub3RlIiwgYSBub3RlIGZ1bGwtc2NyZWVuLiBUaGUgbm90ZSdzIEJhY2sgYnV0dG9uIGFuZCB0aGUKLy8gZm9sZGVyIHRyZWUncyBidXR0b24gb25seSBzaG93IGluIHRoZSBwaG9uZSdzIHN0eWxlc2hlZXQuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUg",
"OKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgdG9hc3QsIG9wZW5NZW51IH0gPSBucy51aTsKICBjb25zdCB7IHV0aWwsIG5vdGVzTG9naWMsIG5vdGVzU3RvcmUsIGhvb2tzLCBhcGkgfSA9IG5zOwogIGNvbnN0IGZtdCA9IG5zLm5vdGVGb3JtYXQ7CiAgY29uc3Qgc2VhcmNoTG9naWMgPSBucy5zZWFyY2hMb2dpYzsKCiAgLy8gSG93IG1hbnkgc2VhcmNoIHJlc3VsdHMgZ2V0IGV4Y2VycHRzIGF0IG9uY2UuIEVhY2ggbmVlZHMgdGhlIG5vdGUncwogIC8vIGZ1bGwgdGV4dCwgd2hpY2ggaXMgb25lIG1vcmUgcmVxdWVzdCB0aGUgZmlyc3QgdGltZS4KICBjb25zdCBFWENFUlBUX0xJTUlUID0gMzA7CgogIC8vIExvbmcgZW5vdWdoIG5vdCB0byBzYXZlIG1pZC1zZW50ZW5jZSAoZWFjaCBzYXZlIGlzIGEgbmV3IG1lc3NhZ2UgYW5kCiAgLy8gYSB0cmFzaGVkIG9sZCBvbmUpLCBzaG9ydCBlbm91Z2ggdGhhdCBsaXR0bGUgaXMgYXQgcmlzay4KICBjb25zdCBBVVRPU0FWRV9NUyA9IDI1MDA7CiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CgogIGNvbnN0IFNDUkFUQ0hfS0VZID0gYG46JHtub3Rlc0xvZ2ljLlNDUkFUQ",
"0hQQURfSUR9YDsKCiAgY29uc3QgTiA9IHsKICAgIGN0eDogbnVsbCwgICAgICAgICAgLy8geyByb290LCBvblN0YXRlRXJyb3IsIG9uTG9hZGVkLCBjbG9zZUJvYXJkLCBiYXJDaGFuZ2VkIH0KICAgIG5vdGVzOiBbXSwgICAgICAgICAgLy8gbGl2ZSBub3RlcywgbmV3ZXN0IGZpcnN0IChtZXRhZGF0YSBvbmx5KQogICAgdHJ1bmNhdGVkOiBmYWxzZSwKICAgIHF1ZXJ5OiAnJywKICAgIHN0YXR1czogJ2lkbGUnLCAgICAgLy8gaWRsZSB8IGxvYWRpbmcgfCByZWFkeSB8IGVycm9yCiAgICBlcnJvcjogJycsCiAgICBsb2FkZWRBdDogMCwKICAgIGxvYWRpbmc6IG51bGwsCiAgICBjdXJyZW50OiBudWxsLCAgICAgIC8vIHRoZSBub3RlIGJlaW5nIGVkaXRlZCAtIHNlZSBuZXdDdXJyZW50KCk7IHRoZSBzY3JhdGNocGFkIHdoZW4gbm8gb3RoZXIgaXMKICAgIHNjcmF0Y2hOb3RlOiBudWxsLCAgLy8gdGhlIHNjcmF0Y2hwYWQncyBtZXNzYWdlLCBvbmNlIGxpc3RlZCAobnVsbDogbmV2ZXIgc2F2ZWQgeWV0KQogICAgc2NyYXRjaEtub3duOiBmYWxzZSwgLy8gd2hldGhlciB0aGUgbGlzdGluZyBoYXMgc2FpZCBpZiB0aGVyZSBpcyBvbmUKICAgIGJyb3dzaW5nOiBmYWxzZSwgICAgLy8gYSBwaG9uZTogdGhlIGxpc3QgaXMgc2hvd2luZywgcmF0aGVyIHRoYW4gdGhlIHNjcmF0Y2hwYWQKICAgIHdhbnRGb2N1czogZmFsc2UsICAgLy8gcHV0IHRoZSBjdXJzb3IgaW4gdGhlIHNjcmF0Y2hwYWQgb25jZSBpdCBpcyByZWFkeQogI",
"CAgY2hhaW46IFByb21pc2UucmVzb2x2ZSgpLCAvLyBzYXZlcyBhbmQgbW92ZXMgcnVuIG9uZSBhZnRlciBhbm90aGVyCiAgICBmb2xkZXJzOiBbXSwgICAgICAgIC8vIG5vdGVzTG9naWMuZm9sZGVyVHJlZSgpLCBmcm9tIHRoZSBsYXN0IGxpc3RpbmcKICAgIGZvbGRlcjogJycsICAgICAgICAgLy8gdGhlIGZvbGRlciBzaG93bjsgJycgZm9yIGFsbCBub3RlcwogICAgZm9sZGVyRWRpdDogbnVsbCwgICAvLyB7IG1vZGU6ICduZXcnIHwgJ3JlbmFtZScsIHBhcmVudElkLCBmb2xkZXJJZCwgdmFsdWUsIGVycm9yLCBidXN5IH0KICAgIGZvbGRlZDogbmV3IFNldCgpLCAgLy8gZm9sZGVycyB3aG9zZSBzdWJmb2xkZXJzIGFyZSBmb2xkZWQgYXdheQogICAgZm9sZGVkUmVhZDogZmFsc2UsICAvLyB0aGUgc2F2ZWQgc2V0IGhhcyBiZWVuIGFza2VkIGZvcgogICAgZHJhZ0tleTogJycsICAgICAgICAvLyB0aGUgbm90ZSBiZWluZyBkcmFnZ2VkIG9udG8gYSBmb2xkZXIKICAgIHRlcm1zOiBbXSwgICAgICAgICAgLy8gc2VhcmNoTG9naWMucXVlcnlUZXJtcygpIG9mIHRoZSBzZWFyY2ggdGhhdCBpcyBzaG93aW5nCiAgICBoaXRzOiBuZXcgTWFwKCksICAgIC8vIGAke21lc3NhZ2VJZH18JHt0ZXJtc31gIOKGkiB7IGNvdW50LCBleGNlcnB0cyB9CiAgICBmaW5kSW5kZXg6IDAsICAgICAgIC8vIHdoaWNoIG1hdGNoIGluIHRoZSBvcGVuIG5vdGUgaXMgdGhlIGN1cnJlbnQgb25lCiAgfTsKCiAgbGV0IHNhdmVUaW1lciA9IDA7C",
"iAgbGV0IHNlYXJjaFRpbWVyID0gMDsKICBsZXQgZmluZFRpbWVyID0gMDsKICBjb25zdCBlbHMgPSB7fTsKCiAgLy8g4pSA4pSAIFNldHVwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBpbml0KGN0eCkgewogICAgTi5jdHggPSBjdHg7CiAgICBOLnZpZXcgPSAnJzsKICAgIC8vIENsb3NpbmcgdGhlIHRhYiBtaWQtc2VudGVuY2Ugd291bGQgbG9zZSB0aGUgbGFzdCBmZXcgc2Vjb25kcyBvZgogICAgLy8gdHlwaW5nOyB0aGUgYnJvd3NlcidzIG93biAiTGVhdmUgc2l0ZT8iIHByb21wdCBpcyB0aGUgb25seSBkZWZlbmNlLgogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2JlZm9yZXVubG9hZCcsIGUgPT4gewogICAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgICBpZiAoYyAmJiAoYy5kaXJ0eSB8fCBjLnNhdmluZykpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgZS5yZXR1cm5WYWx1ZSA9ICcnOwogICAgICB9CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGVsZW1lbnQoKSB7CiAgICBpZiAoZWxzLndyYXApIHJldHVybiBlbHMud3JhcDsKCiAgICBlbHMuc2VhcmNoID0gaCgnaW5wdXQnLCB7C",
"iAgICAgIHR5cGU6ICdzZWFyY2gnLCBwbGFjZWhvbGRlcjogJ1NlYXJjaCBub3RlcycsICdhcmlhLWxhYmVsJzogJ1NlYXJjaCBub3RlcycsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZXMtc2VhcmNoJyB9LAogICAgICBvbmlucHV0OiBlID0-IHsKICAgICAgICBOLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7CiAgICAgICAgLy8gT24gYSBwaG9uZSwgYSBzZWFyY2ggc2hvd3MgdGhlIGxpc3QgaW4gcGxhY2Ugb2YgdGhlIHNjcmF0Y2hwYWQuCiAgICAgICAgaWYgKE4ucXVlcnkudHJpbSgpICYmICFOLmJyb3dzaW5nKSB7IE4uYnJvd3NpbmcgPSB0cnVlOyBzZXRWaWV3KCk7IH0KICAgICAgICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgICAgIHNlYXJjaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBsb2FkKHsgZm9yY2U6IHRydWUgfSksIDQwMCk7CiAgICAgIH0sCiAgICAgIG9ua2V5ZG93bjogZSA9PiB7CiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInKSB7IGUucHJldmVudERlZmF1bHQoKTsgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVyKTsgbG9hZCh7IGZvcmNlOiB0cnVlIH0pOyB9CiAgICAgIH0sCiAgICB9KTsKICAgIGVscy5pdGVtcyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1pdGVtcycsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiAnTm90ZXMnIH0pOwogICAgZWxzLmZvb3QgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtZm9vdCcgfSk7CiAgICBlbHMuc2NvcGUgPSBoKCdkaXYnL",
"CB7IGNsYXNzOiAnbm90ZXMtc2NvcGUnIH0pOwoKICAgIGVscy5saXN0ID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdub3Rlcy1saXN0JywgJ2FyaWEtbGFiZWwnOiAnTm90ZXMnIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy10b29scycgfSwKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoLWJveCcgfSwgaWNvbignc2VhcmNoJywgMTgpLCBlbHMuc2VhcmNoKSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2J0biBidG4tdG9uYWwnLCB0eXBlOiAnYnV0dG9uJywgZGF0YXNldDogeyBrZXk6ICdub3RlLW5ldycgfSwKICAgICAgICAgIHRpdGxlOiAnTmV3IG5vdGUnLCBvbmNsaWNrOiAoKSA9PiBuZXdOb3RlKCksCiAgICAgICAgfSwgaWNvbignYWRkJywgMTgpLCAnTmV3JykpLAogICAgICBlbHMuc2NvcGUsCiAgICAgIGVscy5pdGVtcywKICAgICAgZWxzLmZvb3QpOwoKICAgIGVscy5mb2xkZXJJdGVtcyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdmb2xkZXItaXRlbXMnLCByb2xlOiAnbGlzdCcsICdhcmlhLWxhYmVsJzogJ0ZvbGRlcnMnIH0pOwogICAgLy8gT24gYSBwaG9uZSB0aGUgdHJlZSBmb2xkcyBhd2F5IGJlaGluZCBvbmUgYnV0dG9uIHRoYXQgc2F5cyB3aGVyZQogICAgLy8geW91IGFyZTsgb25seSB0aGUgcGhvbmUncyBzdHlsZXNoZWV0IHNob3dzIGl0LgogICAgZWxzLmZvbGRlcnNUb2dnbGUgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnZm9sZGVyc",
"y10b2dnbGUnLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtZXhwYW5kZWQnOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogJ2ZvbGRlcnMtdG9nZ2xlJyB9LAogICAgICBvbmNsaWNrOiAoKSA9PiBzZXRGb2xkZXJzT3BlbihlbHMud3JhcC5kYXRhc2V0LmZvbGRlcnMgIT09ICdvcGVuJyksCiAgICB9KTsKICAgIGVscy5mb2xkZXJzUGFuZSA9IGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiAnbm90ZXMtZm9sZGVycycsICdhcmlhLWxhYmVsJzogJ0ZvbGRlcnMnIH0sCiAgICAgIGVscy5mb2xkZXJzVG9nZ2xlLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZm9sZGVycy1oZWFkJyB9LAogICAgICAgIGgoJ2gyJywgeyB0ZXh0OiAnRm9sZGVycycgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCB0aXRsZTogJ05ldyBmb2xkZXInLCAnYXJpYS1sYWJlbCc6ICdOZXcgZm9sZGVyJywKICAgICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnZm9sZGVyLW5ldycgfSwgb25jbGljazogKCkgPT4gc3RhcnRGb2xkZXJFZGl0KHsgbW9kZTogJ25ldycsIHBhcmVudElkOiAnJyB9KSwKICAgICAgICB9LCBpY29uKCdhZGQnLCAyMCkpKSwKICAgICAgZWxzLmZvbGRlckl0ZW1zKTsKCiAgICBlbHMuZWRpdG9yID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdub3RlLWVkaXRvcicsICdhcmlhLWxhYmVsJzogJ05vdGUnIH0pOwogICAgZWxzLndyYXAgPSBoKCdkaXYnLCB7IGNsYXNzO",
"iAnbm90ZXMnLCBkYXRhc2V0OiB7IGZvbGRlcnM6ICdjbG9zZWQnIH0gfSwgZWxzLmZvbGRlcnNQYW5lLCBlbHMubGlzdCwgZWxzLmVkaXRvcik7CiAgICBpZiAoIU4uY3VycmVudCkgTi5jdXJyZW50ID0gZnJvbUNvcHkoKSB8fCBwZW5kaW5nU2NyYXRjaCgpOwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgICBkcmF3RWRpdG9yKCk7CiAgICAvLyBUZXh0IHR5cGVkIGxhc3QgdGltZSBhbmQgbm90IHNhdmVkIGJlZm9yZSB0aGUgcGFnZSB3ZW50LgogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmIChjICYmIGMuZGlydHkpIHNhdmVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gc2F2ZShjKSwgQVVUT1NBVkVfTVMpOwogICAgcmV0dXJuIGVscy53cmFwOwogIH0KCiAgLy8gVGhlIHBob25lIGFwcCdzIG93biBjb3B5IChub3Rlc1N0b3JlLmNhY2hlZCk6IHRoZSBsaXN0IGFuZCB0aGUKICAvLyBzY3JhdGNocGFkIGFzIHRoZXkgd2VyZSB3aGVuIGl0IGxhc3QgaGVhcmQgZnJvbSBHbWFpbCwgYW5kIGFueSB0ZXh0CiAgLy8gdHlwZWQgYW5kIG5vdCB5ZXQgc2F2ZWQuIFRoZSBzY3JhdGNocGFkIHRha2VzIHR5cGluZyBhdCBvbmNlOyBHbWFpbCdzCiAgLy8gYW5zd2VyIGNhdGNoZXMgdXAgd2l0aCBpdCBhZnRlciAoY2F0Y2hVcEN1cnJlbnQsIGFkb3B0TmV3ZXIpLgogIGZ1bmN0aW9uIGZyb21Db3B5KCkgewogICAgY29uc3QgY29weSA9IG5vdGVzU3RvcmUuY2FjaGVkID8gbm90ZXNTdG9yZS5jYWNoZ",
"WQoKSA6IG51bGw7CiAgICBpZiAoIWNvcHkpIHJldHVybiBudWxsOwogICAgaWYgKGNvcHkubm90ZXMpIHsKICAgICAgTi5ub3RlcyA9IGNvcHkubm90ZXM7CiAgICAgIE4udHJ1bmNhdGVkID0gISFjb3B5LnRydW5jYXRlZDsKICAgICAgTi5mb2xkZXJzID0gY29weS5mb2xkZXJzIHx8IFtdOwogICAgICBOLnN0YXR1cyA9ICdyZWFkeSc7CiAgICAgIE4ubG9hZGVkQXQgPSAwOyAvLyBzdGlsbCB0byBiZSBhc2tlZCBmb3IKICAgIH0KICAgIGlmIChjb3B5LnNjcmF0Y2gpIHsKICAgICAgTi5zY3JhdGNoTm90ZSA9IGNvcHkuc2NyYXRjaC5ub3RlIHx8IG51bGw7CiAgICAgIE4uc2NyYXRjaEtub3duID0gdHJ1ZTsKICAgIH0KICAgIGNvbnN0IGZyb20gPSBjb3B5LmRyYWZ0IHx8IGNvcHkuc2NyYXRjaDsKICAgIGlmICghZnJvbSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBjID0gc2NyYXRjaEN1cnJlbnQoZnJvbS5ub3RlIHx8IG51bGwpOwogICAgYy5iYXNlID0gY29weS5kcmFmdCA_IGNvcHkuZHJhZnQuYmFzZSB8fCBmbXQuZW1wdHlEb2MoKSA6IGZyb20uZG9jIHx8IGZtdC5lbXB0eURvYygpOwogICAgYy5kb2MgPSBmcm9tLmRvYyB8fCBmbXQuZW1wdHlEb2MoKTsKICAgIGMuYm9keVN0YXRlID0gJ3JlYWR5JzsKICAgIGMuZGlydHkgPSAhIWNvcHkuZHJhZnQ7CiAgICByZXR1cm4gYzsKICB9CgogIC8vIFdoYXQgdGhlIHBob25lIGFwcCdzIGZpcnN0IGNhbGwgZm91bmQgdGhlIHNjcmF0Y2hwYWQgdG8gYmU6IGluIEdtY",
"WlsCiAgLy8gYWxyZWFkeSwgcGVyaGFwcyBuZXdlciB0aGFuIHRoZSBjb3B5IGl0IG9wZW5lZCB3aXRoLgogIGZ1bmN0aW9uIHNjcmF0Y2hGb3VuZChub3RlKSB7CiAgICBpZiAoIW5vdGUgfHwgIWlzTmV3ZXIobm90ZSwgTi5zY3JhdGNoTm90ZSkpIHJldHVybjsKICAgIE4uc2NyYXRjaE5vdGUgPSBub3RlOwogICAgTi5zY3JhdGNoS25vd24gPSB0cnVlOwogICAgY2F0Y2hVcEN1cnJlbnQoKTsKICB9CgogIC8vIOKUgOKUgCBMb2FkaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBpc1N0YWxlKCkgewogICAgcmV0dXJuIE4uc3RhdHVzICE9PSAncmVhZHknIHx8IERhdGUubm93KCkgLSBOLmxvYWRlZEF0ID4gU1RBTEVfTVM7CiAgfQoKICBmdW5jdGlvbiBsb2FkKHsgZm9yY2UgPSBmYWxzZSB9ID0ge30pIHsKICAgIGlmIChOLmxvYWRpbmcpIHJldHVybiBOLmxvYWRpbmc7CiAgICBpZiAoIWZvcmNlICYmICFpc1N0YWxlKCkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTsKICAgIGNvbnN0IHF1ZXJ5ID0gTi5xdWVyeTsKICAgIGlmICghTi5ub3Rlcy5sZW5ndGgpIE4uc3RhdHVzID0gJ2xvYWRpbmcnOwogICAgZHJhd0xpc3QoKTsKC",
"iAgICBOLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4gewogICAgICB0cnkgewogICAgICAgIGNvbnN0IGZvbGRlZCA9IE4uZm9sZGVkUmVhZCA_IG51bGwgOiByZWFkRm9sZGVkKCk7CiAgICAgICAgY29uc3QgciA9IGF3YWl0IG5vdGVzU3RvcmUubGlzdChob29rcy5nZXRBY2NvdW50KCksIHF1ZXJ5KTsKICAgICAgICBpZiAoZm9sZGVkKSBhd2FpdCBmb2xkZWQ7CiAgICAgICAgaWYgKHF1ZXJ5ICE9PSBOLnF1ZXJ5KSByZXR1cm47IC8vIGEgbmV3ZXIgc2VhcmNoIGhhcyBzdGFydGVkCiAgICAgICAgbGV0IHNjcmF0Y2ggPSByLm5vdGVzLmZpbmQobiA9PiBuLmtleSA9PT0gU0NSQVRDSF9LRVkpIHx8IG51bGw7CiAgICAgICAgLy8gTm90IGFtb25nIHRoZSBuZXdlc3QgaHVuZHJlZDogYXNrIEdtYWlsIGZvciBpdCBieSBuYW1lLCByYXRoZXIKICAgICAgICAvLyB0aGFuIHN0YXJ0IGEgc2Vjb25kIG9uZSB0aGF0IHdvdWxkIHB1c2ggdGhlIGZpcnN0IGludG8gVHJhc2guCiAgICAgICAgaWYgKCFzY3JhdGNoICYmICFxdWVyeSAmJiByLnRydW5jYXRlZCkgewogICAgICAgICAgY29uc3QgZm91bmQgPSBhd2FpdCBub3Rlc1N0b3JlLmxpc3QoaG9va3MuZ2V0QWNjb3VudCgpLCBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUpOwogICAgICAgICAgc2NyYXRjaCA9IGZvdW5kLm5vdGVzLmZpbmQobiA9PiBuLmtleSA9PT0gU0NSQVRDSF9LRVkpIHx8IG51bGw7CiAgICAgICAgICBpZiAocXVlcnkgIT09IE4ucXVlcnkpIHJldHVyb",
"jsKICAgICAgICB9CiAgICAgICAgaWYgKHNjcmF0Y2ggfHwgIXF1ZXJ5KSB7CiAgICAgICAgICBOLnNjcmF0Y2hOb3RlID0gc2NyYXRjaDsKICAgICAgICAgIE4uc2NyYXRjaEtub3duID0gdHJ1ZTsKICAgICAgICB9CiAgICAgICAgTi5ub3RlcyA9IHIubm90ZXM7CiAgICAgICAgTi50cnVuY2F0ZWQgPSByLnRydW5jYXRlZDsKICAgICAgICBOLmZvbGRlcnMgPSByLmZvbGRlcnMgfHwgW107CiAgICAgICAgY29uc3QgdGVybXMgPSBzZWFyY2hMb2dpYy5xdWVyeVRlcm1zKHF1ZXJ5KTsKICAgICAgICBpZiAoSlNPTi5zdHJpbmdpZnkodGVybXMpICE9PSBKU09OLnN0cmluZ2lmeShOLnRlcm1zKSkgTi5maW5kSW5kZXggPSAwOwogICAgICAgIE4udGVybXMgPSB0ZXJtczsKICAgICAgICAvLyBUaGUgZm9sZGVyIHNob3duIHdhcyBkZWxldGVkIG9yIHJlbmFtZWQgYXdheSBpbiBHbWFpbC4KICAgICAgICBpZiAoTi5mb2xkZXIgJiYgIU4uZm9sZGVycy5zb21lKGYgPT4gZi5pZCA9PT0gTi5mb2xkZXIpKSBOLmZvbGRlciA9ICcnOwogICAgICAgIE4uc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgICBOLmVycm9yID0gJyc7CiAgICAgICAgTi5sb2FkZWRBdCA9IERhdGUubm93KCk7CiAgICAgICAgY2F0Y2hVcEN1cnJlbnQoKTsKICAgICAgICAvLyBUaGUgc2NyYXRjaHBhZCB3YXMgd2FpdGluZyBmb3IgdGhlIGxpc3QgdG8gc2F5IHdoZXRoZXIgaXQgZXhpc3RzLgogICAgICAgIGlmIChOLmN1cnJlbnQgJiYgTi5jdXJyZW50LnNjc",
"mF0Y2ggJiYgTi5jdXJyZW50LmJvZHlTdGF0ZSAhPT0gJ3JlYWR5JyAmJiBOLnNjcmF0Y2hLbm93bikgc2hvd1NjcmF0Y2goKTsKICAgICAgICBOLmN0eC5vbkxvYWRlZCgpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHsKICAgICAgICAgIE4uc3RhdHVzID0gJ2lkbGUnOwogICAgICAgICAgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIE4uc3RhdHVzID0gTi5ub3Rlcy5sZW5ndGggPyAncmVhZHknIDogJ2Vycm9yJzsKICAgICAgICBOLmVycm9yID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgICAgICBpZiAoYyAmJiBjLnNjcmF0Y2ggJiYgYy5ib2R5U3RhdGUgPT09ICdsb2FkaW5nJyAmJiAhTi5zY3JhdGNoS25vd24pIHsKICAgICAgICAgIGMuYm9keVN0YXRlID0gJ2Vycm9yJzsKICAgICAgICAgIGMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgICAgIGRyYXdFZGl0b3IoKTsKICAgICAgICB9CiAgICAgICAgaWYgKE4ubm90ZXMubGVuZ3RoKSB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBsb2FkIG5vdGVzOiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBOLmxvYWRpbmcgPSBudWxsOwogICAgICAgIGRyYXdGb2xkZXJzKCk7CiAgICAgICAgZHJhd0xpc3QoKTsKICAgI",
"CAgICBkcmF3Rm9vdCgpOwogICAgICAgIGlmIChOLmN1cnJlbnQpIGRyYXdCYXIoKTsKICAgICAgICBhcHBseUhpZ2hsaWdodHMoKTsKICAgICAgICBmZXRjaEhpdHMoKTsKICAgICAgICBOLmN0eC5iYXJDaGFuZ2VkKCk7CiAgICAgIH0KICAgIH0pKCk7CiAgICAvLyBUaGUgc2VhcmNoIGJveCBjaGFuZ2VkIHdoaWxlIHRoaXMgd2FzIGluIGZsaWdodCwgYW5kIHRoZSBsb2FkIHRoYXQKICAgIC8vIGNoYW5nZSBhc2tlZCBmb3Igd2FzIHR1cm5lZCBhd2F5IGFib3ZlOiBydW4gaXQgbm93LgogICAgY29uc3QgcCA9IE4ubG9hZGluZzsKICAgIHJldHVybiBwLnRoZW4oKCkgPT4gKHF1ZXJ5ICE9PSBOLnF1ZXJ5ID8gbG9hZCh7IGZvcmNlOiB0cnVlIH0pIDogdW5kZWZpbmVkKSk7CiAgfQoKICAvLyBXaGV0aGVyIGBmcmVzaGAgaXMgYSBsYXRlciB2ZXJzaW9uIHRoYW4gdGhlIG9uZSBgbm90ZWAgaXMgKG9yIHRoYW4KICAvLyBub25lIGF0IGFsbCkuIEdtYWlsJ3Mgb3duIGRhdGUgZm9yIGVhY2ggbWVzc2FnZSBkZWNpZGVzLgogIGNvbnN0IGlzTmV3ZXIgPSAoZnJlc2gsIG5vdGUpID0-ICEhZnJlc2ggJiYgKCFub3RlIHx8IChmcmVzaC5tZXNzYWdlSWQgIT09IG5vdGUubWVzc2FnZUlkICYmIGZyZXNoLnVwZGF0ZWQgPiBub3RlLnVwZGF0ZWQpKTsKCiAgLy8gVGhlIG9wZW4gbm90ZSB3YXMgc2F2ZWQgb24gYW5vdGhlciBjb21wdXRlciBvciBwaG9uZSBzaW5jZSBpdCB3YXMKICAvLyBvcGVuZWQgaGVyZSAob3IsIGZvciB0a",
"GUgc2NyYXRjaHBhZCwgc3RhcnRlZCB0aGVyZSk6IHRoZSBuZXdlciB0ZXh0LAogIC8vIG1lcmdlZCB3aXRoIHdoYXRldmVyIHdhcyB0eXBlZCBoZXJlIG1lYW53aGlsZS4KICBmdW5jdGlvbiBjYXRjaFVwQ3VycmVudCgpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMpIHJldHVybjsKICAgIGNvbnN0IGZyZXNoID0gYy5zY3JhdGNoID8gTi5zY3JhdGNoTm90ZSA6IGMubm90ZSA_IE4ubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBjLmtleSkgOiBudWxsOwogICAgaWYgKCFpc05ld2VyKGZyZXNoLCBjLm5vdGUpKSByZXR1cm47CiAgICBpZiAoYy5ib2R5U3RhdGUgIT09ICdyZWFkeScpIHsKICAgICAgaWYgKCFjLmRpcnR5ICYmICFjLnNhdmluZykgb3Blbk5vdGUoZnJlc2gsIHsgZm9yY2U6IHRydWUgfSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGFkb3B0TmV3ZXIoYywgZnJlc2gpOwogIH0KCiAgLy8gQSBuZXdlciB2ZXJzaW9uIG9mIGEgbm90ZSBiZWluZyBlZGl0ZWQsIHRha2VuIGluIHBsYWNlOiB0aGUgZWRpdHMKICAvLyBtYWRlIGhlcmUgc2luY2UgYGMuYmFzZWAgbWVyZ2VkIGludG8gaXQgKG5vdGVGb3JtYXQubWVyZ2VEb2NzKSwgaW4KICAvLyB0aGUgc2FtZSB0ZXh0IGJveCwgc28gdGhlIGN1cnNvciBhbmQgYSBwaG9uZSdzIGtleWJvYXJkIHN0YXkgcHV0LiBJdAogIC8vIHdhaXRzIGZvciBhIHNhdmUgaW4gZmxpZ2h0LCBhbmQgdGhlIG1lcmdlZCB0ZXh0IGlzIHNhdmVkIGluIHR1c",
"m4uCiAgZnVuY3Rpb24gYWRvcHROZXdlcihjLCBmcmVzaCkgewogICAgTi5jaGFpbiA9IE4uY2hhaW4udGhlbihhc3luYyAoKSA9PiB7CiAgICAgIGlmICghaXNOZXdlcihmcmVzaCwgYy5ub3RlKSkgcmV0dXJuOwogICAgICBsZXQgdGhlaXJzOwogICAgICB0cnkgewogICAgICAgIHRoZWlycyA9IGF3YWl0IG5vdGVzU3RvcmUuYm9keShmcmVzaCk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIHJldHVybjsgLy8gdGhlIG5leHQgbGlzdGluZyB0cmllcyBhZ2FpbgogICAgICB9CiAgICAgIGlmICghaXNOZXdlcihmcmVzaCwgYy5ub3RlKSkgcmV0dXJuOwogICAgICBjb25zdCBiYXNlID0gYy5iYXNlIHx8IGZtdC5lbXB0eURvYygpOwogICAgICBjb25zdCBtaW5lID0gYy5kb2MgfHwgYmFzZTsKICAgICAgY29uc3QgdHlwZWQgPSBjLmRpcnR5ICYmICFmbXQuc2FtZURvYyhtaW5lLCBiYXNlKTsKICAgICAgY29uc3QgdGl0bGVkID0gIWMuc2NyYXRjaCAmJiBjLmRpcnR5ICYmIGMudGl0bGUgIT09IGMuYmFzZVRpdGxlOwogICAgICBjb25zdCBtZXJnZWQgPSB0eXBlZCA_IGZtdC5tZXJnZURvY3MoYmFzZSwgbWluZSwgdGhlaXJzKSA6IHsgZG9jOiB0aGVpcnMsIG1hcDogbnVsbCB9OwogICAgICBjLm5vdGUgPSBmcmVzaDsKICAgICAgYy5rZXkgPSBmcmVzaC5rZXk7CiAgICAgIGMuYmFzZSA9IHRoZWlyczsKICAgICAgYy5iYXNlVGl0bGUgPSBmcmVzaC50aXRsZTsKICAgICAgYy5kb2MgPSBtZXJnZWQuZG9jOwogI",
"CAgICBjLnNhdmVkQXQgPSAwOwogICAgICBjLmVycm9yID0gJyc7CiAgICAgIGlmICghdGl0bGVkICYmICFjLnNjcmF0Y2gpIGMudGl0bGUgPSBmcmVzaC50aXRsZSAhPT0gJ1VudGl0bGVkIG5vdGUnID8gZnJlc2gudGl0bGUgOiAnJzsKICAgICAgaWYgKCFjLnNjcmF0Y2gpIGMuZm9sZGVySWQgPSBmcmVzaC5mb2xkZXJJZCB8fCAnJzsKICAgICAgYy5kaXJ0eSA9ICh0eXBlZCAmJiAhZm10LnNhbWVEb2MobWVyZ2VkLmRvYywgdGhlaXJzKSkgfHwgdGl0bGVkOwogICAgICBpZiAoYy5zY3JhdGNoKSB7IE4uc2NyYXRjaE5vdGUgPSBmcmVzaDsgTi5zY3JhdGNoS25vd24gPSB0cnVlOyB9CiAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMgJiYgZWxzLmVkKSB7CiAgICAgICAgZWxzLmVkLnJlcGxhY2VEb2MobWVyZ2VkLmRvYywgbWVyZ2VkLm1hcCk7CiAgICAgICAgY29uc3QgaW5wdXQgPSBlbHMuZWRpdG9yLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0ibm90ZS10aXRsZSJdJyk7CiAgICAgICAgaWYgKGlucHV0ICYmIGlucHV0LnZhbHVlICE9PSBjLnRpdGxlICYmIE4uY3R4LnJvb3QuYWN0aXZlRWxlbWVudCAhPT0gaW5wdXQpIGlucHV0LnZhbHVlID0gYy50aXRsZTsKICAgICAgICBhcHBseUhpZ2hsaWdodHMoKTsKICAgICAgfQogICAgICBpZiAodHlwZWQpIHRvYXN0KE4uY3R4LnJvb3QsICdBbHNvIGNoYW5nZWQgb24gYW5vdGhlciBkZXZpY2UgaW4gdGhlIG1lYW50aW1lOiBib3RoIGNoYW5nZXMgYXJlIGtlcHQuJyk7C",
"iAgICAgIGtlZXBEcmFmdChjKTsKICAgICAgaWYgKGMuZGlydHkpIHsKICAgICAgICBjbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTsKICAgICAgICBzYXZlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0-IHNhdmUoYyksIEFVVE9TQVZFX01TKTsKICAgICAgfQogICAgICBpZiAoTi5jdXJyZW50ID09PSBjKSBkcmF3QmFyKCk7CiAgICAgIGRyYXdMaXN0KCk7CiAgICB9KTsKICAgIHJldHVybiBOLmNoYWluOwogIH0KCiAgLy8gQSBwaG9uZSBhcHAga2VlcHMgdGhlIHNjcmF0Y2hwYWQncyB1bnNhdmVkIHRleHQgb24gdGhlIHBob25lLCBzbyB0aGF0CiAgLy8gYSBwYWdlIHRoZSBwaG9uZSBjbG9zZXMgbWlkLXNlbnRlbmNlIGxvc2VzIG5vdGhpbmcgKG5vdGVzU3RvcmUua2VlcERyYWZ0KS4KICBsZXQgZHJhZnRUaW1lciA9IDA7CiAgZnVuY3Rpb24ga2VlcERyYWZ0KGMpIHsKICAgIGlmICghYy5zY3JhdGNoIHx8ICFub3Rlc1N0b3JlLmtlZXBEcmFmdCkgcmV0dXJuOwogICAgY2xlYXJUaW1lb3V0KGRyYWZ0VGltZXIpOwogICAgbm90ZXNTdG9yZS5rZWVwRHJhZnQoYy5kaXJ0eSA_IHsgbm90ZTogYy5ub3RlLCBiYXNlOiBjLmJhc2UsIGRvYzogYy5kb2MgfSA6IG51bGwpOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBsaXN0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUg",
"OKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBmb2xkZXJCeUlkKGlkKSB7CiAgICByZXR1cm4gTi5mb2xkZXJzLmZpbmQoZiA9PiBmLmlkID09PSBpZCkgfHwgbnVsbDsKICB9CgogIC8vICJXb3JrIOKAuiBDbGllbnRzIgogIGZ1bmN0aW9uIGZvbGRlckxhYmVsKGlkKSB7CiAgICBjb25zdCBmID0gZm9sZGVyQnlJZChpZCk7CiAgICByZXR1cm4gZiA_IGYucGF0aC5zcGxpdCgnLycpLmpvaW4oJyBcdTIwM2EgJykgOiAnJzsKICB9CgogIGZ1bmN0aW9uIHZpc2libGVOb3RlcygpIHsKICAgIHJldHVybiBOLmZvbGRlciA_IE4ubm90ZXMuZmlsdGVyKG4gPT4gbi5mb2xkZXJJZCA9PT0gTi5mb2xkZXIpIDogTi5ub3RlczsKICB9CgogIGZ1bmN0aW9uIGRyYXdMaXN0KCkgewogICAgaWYgKCFlbHMuaXRlbXMpIHJldHVybjsKICAgIGNvbnN0IGN1cktleSA9IE4uY3VycmVudCAmJiBOLmN1cnJlbnQua2V5OwogICAgY29uc3Qgc2hvd24gPSB2aXNpYmxlTm90ZXMoKTsKICAgIGNvbnN0IHNlYXJjaGluZyA9ICEhTi5xdWVyeS50cmltKCk7CiAgICBpZiAoZWxzLnNjb3BlKSB7CiAgICAgIGNvbnN0IHdoZXJlID0gTi5mb2xkZXIgPyBmb2xkZXJMYWJlbChOLmZvbGRlcikgOiAnQWxsIG5vdGVzJzsKICAgICAgZWxzLnNjb3BlLnRleHRDb250ZW50ID0gTi5zdGF0dXMgPT09ICdyZWFkeScKICAgICAgICA_IGAke3doZXJlfSBcdTAwYjcgJHtzaG93bi5sZW5ndGh9I",
"CR7c2VhcmNoaW5nID8gKHNob3duLmxlbmd0aCA9PT0gMSA_ICdtYXRjaCcgOiAnbWF0Y2hlcycpIDogKHNob3duLmxlbmd0aCA9PT0gMSA_ICdub3RlJyA6ICdub3RlcycpfWAKICAgICAgICA6IHdoZXJlOwogICAgfQogICAgaWYgKGVscy5zZWFyY2gpIGVscy5zZWFyY2gucGxhY2Vob2xkZXIgPSBOLmZvbGRlciA_IGBTZWFyY2ggaW4gJHtmb2xkZXJCeUlkKE4uZm9sZGVyKSA_IGZvbGRlckJ5SWQoTi5mb2xkZXIpLnRpdGxlIDogJ3RoaXMgZm9sZGVyJ31gIDogJ1NlYXJjaCBub3Rlcyc7CgogICAgaWYgKE4uc3RhdHVzID09PSAnbG9hZGluZycgJiYgIU4ubm90ZXMubGVuZ3RoKSB7CiAgICAgIGVscy5pdGVtcy5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLWVtcHR5JywgdGV4dDogJ0xvYWRpbmfigKYnIH0pKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKE4uc3RhdHVzID09PSAnZXJyb3InICYmICFOLm5vdGVzLmxlbmd0aCkgewogICAgICBlbHMuaXRlbXMucmVwbGFjZUNoaWxkcmVuKAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1lbXB0eScgfSwKICAgICAgICAgIGgoJ3AnLCB7IHRleHQ6IGBDb3VsZG7igJl0IGxvYWQgbm90ZXM6ICR7Ti5lcnJvcn1gIH0pLAogICAgICAgICAgaCgnYnV0dG9uJywgeyBjbGFzczogJ2J0biBidG4tdGV4dCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnVHJ5IGFnYWluJywgb25jbGljazogKCkgPT4gbG9hZCh7IGZvcmNlOiB0cnVlI",
"H0pIH0pKSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIC8vIFRoZSBzY3JhdGNocGFkIGZpcnN0OiBpbiAiQWxsIG5vdGVzIiwgYWx3YXlzLCBzYXZlZCB5ZXQgb3Igbm90OwogICAgLy8gZWxzZXdoZXJlLCB3aGVyZSBpdCBpcyBsaXN0ZWQgKGEgc2VhcmNoIHRoYXQgZmluZHMgaXQpLgogICAgY29uc3Qgc2NyYXRjaCA9IHNob3duLmZpbmQobiA9PiBuLmtleSA9PT0gU0NSQVRDSF9LRVkpIHx8ICghTi5mb2xkZXIgJiYgIXNlYXJjaGluZyAmJiBOLnNjcmF0Y2hLbm93biAmJiAhTi5zY3JhdGNoTm90ZSA_ICduZXcnIDogbnVsbCk7CiAgICBjb25zdCByZXN0ID0gc2hvd24uZmlsdGVyKG4gPT4gbi5rZXkgIT09IFNDUkFUQ0hfS0VZKTsKICAgIGNvbnN0IHBpbm5lZCA9IHNjcmF0Y2ggPyBbc2NyYXRjaEl0ZW0oc2NyYXRjaCA9PT0gJ25ldycgPyBudWxsIDogc2NyYXRjaCwgY3VyS2V5KV0gOiBbXTsKICAgIGlmICghcmVzdC5sZW5ndGgpIHsKICAgICAgbGV0IHRleHQgPSBzZWFyY2hpbmcgPyAnTm8gbm90ZXMgbWF0Y2guJyA6ICdObyBub3RlcyB5ZXQuJzsKICAgICAgaWYgKE4uZm9sZGVyKSB0ZXh0ID0gc2VhcmNoaW5nID8gJ05vIG5vdGVzIGluIHRoaXMgZm9sZGVyIG1hdGNoLicgOiAnTm8gbm90ZXMgaW4gdGhpcyBmb2xkZXIgeWV0Lic7CiAgICAgIGVscy5pdGVtcy5yZXBsYWNlQ2hpbGRyZW4oLi4ucGlubmVkLCBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtZW1wdHknLCB0ZXh0IH0pKTsKICAgICAgcmV0dXJuO",
"wogICAgfQoKICAgIGVscy5pdGVtcy5yZXBsYWNlQ2hpbGRyZW4oLi4ucGlubmVkLCAuLi5yZXN0Lm1hcChuID0-IHsKICAgICAgY29uc3QgaXRlbSA9IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ25vdGUtaXRlbScsIHR5cGU6ICdidXR0b24nLCByb2xlOiAnbGlzdGl0ZW0nLCBkcmFnZ2FibGU6ICd0cnVlJywKICAgICAgICAnYXJpYS1jdXJyZW50Jzogbi5rZXkgPT09IGN1cktleSA_ICd0cnVlJyA6IG51bGwsCiAgICAgICAgZGF0YXNldDogeyBrZXk6IGBub3RlOiR7bi5rZXl9YCwgbm90ZTogbi5rZXkgfSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiBvcGVuTm90ZShuKSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ25pLXRvcCcgfSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktdGl0bGUnIH0sIG1hcmtlZChuLnRpdGxlKSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RhdGUnLCB0ZXh0OiB1dGlsLnJlbGF0aXZlRGF0ZShuLnVwZGF0ZWQpLCB0aXRsZTogdXRpbC5mdWxsRGF0ZShuLnVwZGF0ZWQpIH0pKSwKICAgICAgICBpdGVtUHJldmlldyhuKSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ25pLW1ldGEnIH0sCiAgICAgICAgICBoaXRDb3VudChuKSwKICAgICAgICAgICFOLmZvbGRlciAmJiBuLmZvbGRlcklkID8gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1mb2xkZXInIH0sIGljb24oJ2ZvbGRlcicsIDE0KSwgZm9sZGVyTGFiZWwobi5mb2xkZXJJZ",
"CkpIDogbnVsbCwKICAgICAgICAgIG4ub3duID8gbnVsbCA6IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktbWFpbCcsIHRleHQ6ICdGcm9tIGFuIGVtYWlsJyB9KSkpOwogICAgICBpdGVtLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIGUgPT4gewogICAgICAgIE4uZHJhZ0tleSA9IG4ua2V5OwogICAgICAgIGUuZGF0YVRyYW5zZmVyLmVmZmVjdEFsbG93ZWQgPSAnbW92ZSc7CiAgICAgICAgZS5kYXRhVHJhbnNmZXIuc2V0RGF0YSgnYXBwbGljYXRpb24veC1na2Itbm90ZScsIG4ua2V5KTsKICAgICAgICBlbHMud3JhcC5jbGFzc0xpc3QuYWRkKCdkcmFnZ2luZy1ub3RlJyk7CiAgICAgIH0pOwogICAgICBpdGVtLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdlbmQnLCAoKSA9PiB7CiAgICAgICAgTi5kcmFnS2V5ID0gJyc7CiAgICAgICAgZWxzLndyYXAuY2xhc3NMaXN0LnJlbW92ZSgnZHJhZ2dpbmctbm90ZScpOwogICAgICAgIGZvciAoY29uc3QgciBvZiBlbHMuZm9sZGVySXRlbXMucXVlcnlTZWxlY3RvckFsbCgnLmRyb3AnKSkgci5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wJyk7CiAgICAgIH0pOwogICAgICByZXR1cm4gaXRlbTsKICAgIH0pKTsKICB9CgogIC8vIFRoZSBzY3JhdGNocGFkJ3MgZW50cnk6IHBpbm5lZCwgbm90IGRyYWdnYWJsZSwgYW5kIG9uIGEgcGhvbmUgaXQgZ29lcwogIC8vIGJhY2sgdG8gdGhlIHNjcmF0Y2hwYWQgcmF0aGVyIHRoYW4gb3BlbmluZyBpdCBmdWxsLXNjcmVlbi4KICBmdW5jdGlvb",
"iBzY3JhdGNoSXRlbShuLCBjdXJLZXkpIHsKICAgIHJldHVybiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnbm90ZS1pdGVtIHNjcmF0Y2gtaXRlbScsIHR5cGU6ICdidXR0b24nLCByb2xlOiAnbGlzdGl0ZW0nLAogICAgICAnYXJpYS1jdXJyZW50JzogY3VyS2V5ID09PSBTQ1JBVENIX0tFWSA_ICd0cnVlJyA6IG51bGwsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZTpzY3JhdGNocGFkJywgbm90ZTogU0NSQVRDSF9LRVkgfSwKICAgICAgb25jbGljazogKCkgPT4gewogICAgICAgIE4uYnJvd3NpbmcgPSBmYWxzZTsKICAgICAgICBpZiAobikgb3Blbk5vdGUobik7CiAgICAgICAgZWxzZSBzaG93U2NyYXRjaCgpOwogICAgICAgIHNldFZpZXcoKTsKICAgICAgfSwKICAgIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktdG9wJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktdGl0bGUnIH0sIGljb24oJ2VkaXQnLCAxNiksIGgoJ3NwYW4nLCB7fSwgbWFya2VkKG5vdGVzTG9naWMuU0NSQVRDSFBBRF9USVRMRSkpKSwKICAgICAgICBuID8gaCgnc3BhbicsIHsgY2xhc3M6ICdkYXRlJywgdGV4dDogdXRpbC5yZWxhdGl2ZURhdGUobi51cGRhdGVkKSwgdGl0bGU6IHV0aWwuZnVsbERhdGUobi51cGRhdGVkKSB9KSA6IG51bGwpLAogICAgICBuID8gaXRlbVByZXZpZXcobikgOiBoKCdzcGFuJywgeyBjbGFzczogJ25pLXNuaXBwZXQnLCB0ZXh0OiAnRW1wdHkg4oCTIHdyaXRlIHNvbWV0aGluZ",
"yBkb3duJyB9KSwKICAgICAgbiA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktbWV0YScgfSwgaGl0Q291bnQobikpIDogbnVsbCk7CiAgfQoKICAvLyDilIDilIAgU2VhcmNoIHJlc3VsdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBHbWFpbCBmaW5kcyB0aGUgbm90ZXM7IHRoZXNlIHNob3cgd2hlcmUgdGhlIHdvcmRzIGFyZS4gRWFjaCByZXN1bHQKICAvLyBnZXRzIGV4Y2VycHRzIGFyb3VuZCBpdHMgbWF0Y2hlcyBvbmNlIGl0cyB0ZXh0IGlzIGluLCB3aXRoIHRoZSB3b3JkcwogIC8vIG1hcmtlZC4gVW50aWwgdGhlbiAtIG9yIGlmIEdtYWlsIG1hdGNoZWQgc29tZXRoaW5nIHRoZSB3b3JkcyBkbyBub3QKICAvLyBzaG93LCBzdWNoIGFzIGEgc3RlbW1lZCBmb3JtIC0gaXQgc2hvd3MgR21haWwncyBvd24gc25pcHBldC4KCiAgY29uc3QgdGVybXNLZXkgPSAoKSA9PiBKU09OLnN0cmluZ2lmeShOLnRlcm1zKTsKCiAgLy8gVGV4dCB3aXRoIHRoZSBzZWFyY2ggd29yZHMgd3JhcHBlZCBpbiA8bWFyaz4sIGJ1aWx0IGZyb20gdGV4dCBub2Rlcy4KICBmdW5jdGlvbiBtYXJrZWQodGV4dCwgbWFya3MpIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBjb",
"25zdCBtID0gbWFya3MgfHwgKE4udGVybXMubGVuZ3RoID8gc2VhcmNoTG9naWMuZmluZE1hdGNoZXMocywgTi50ZXJtcykgOiBbXSk7CiAgICBpZiAoIW0ubGVuZ3RoKSByZXR1cm4gczsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgbGV0IGF0ID0gMDsKICAgIGZvciAoY29uc3QgeyBzdGFydCwgZW5kIH0gb2YgbSkgewogICAgICBpZiAoc3RhcnQgPiBhdCkgb3V0LnB1c2gocy5zbGljZShhdCwgc3RhcnQpKTsKICAgICAgb3V0LnB1c2goaCgnbWFyaycsIHsgdGV4dDogcy5zbGljZShzdGFydCwgZW5kKSB9KSk7CiAgICAgIGF0ID0gZW5kOwogICAgfQogICAgaWYgKGF0IDwgcy5sZW5ndGgpIG91dC5wdXNoKHMuc2xpY2UoYXQpKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBpdGVtUHJldmlldyhuKSB7CiAgICBjb25zdCBoaXQgPSBOLnRlcm1zLmxlbmd0aCA_IE4uaGl0cy5nZXQoYCR7bi5tZXNzYWdlSWR9fCR7dGVybXNLZXkoKX1gKSA6IG51bGw7CiAgICBpZiAoaGl0ICYmIGhpdC5leGNlcnB0cy5sZW5ndGgpIHsKICAgICAgcmV0dXJuIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktZXhjZXJwdHMnIH0sIGhpdC5leGNlcnB0cy5tYXAoZXggPT4gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1leGNlcnB0JyB9LAogICAgICAgIGV4LmN1dEJlZm9yZSA_ICdcdTIwMjYnIDogJycsIG1hcmtlZChleC50ZXh0LCBleC5tYXJrcyksIGV4LmN1dEFmdGVyID8gJ1x1MjAyNicgOiAnJykpKTsKICAgIH0KICAgIHJldHVyb",
"iBuLnNuaXBwZXQgPyBoKCdzcGFuJywgeyBjbGFzczogJ25pLXNuaXBwZXQnIH0sIG1hcmtlZChuLnNuaXBwZXQpKSA6IG51bGw7CiAgfQoKICBmdW5jdGlvbiBoaXRDb3VudChuKSB7CiAgICBpZiAoIU4udGVybXMubGVuZ3RoKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGhpdCA9IE4uaGl0cy5nZXQoYCR7bi5tZXNzYWdlSWR9fCR7dGVybXNLZXkoKX1gKTsKICAgIGlmICghaGl0KSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBoKCdzcGFuJywgeyBjbGFzczogJ25pLWhpdHMnLCB0ZXh0OiBgJHtoaXQuY291bnR9ICR7aGl0LmNvdW50ID09PSAxID8gJ21hdGNoJyA6ICdtYXRjaGVzJ31gIH0pOwogIH0KCiAgLy8gRmV0Y2hlcyB0aGUgdGV4dCBvZiB0aGUgcmVzdWx0cyBvbiBzaG93IHRoYXQgaGF2ZSBubyBleGNlcnB0cyB5ZXQsCiAgLy8gYSBmZXcgYXQgYSB0aW1lLCByZWRyYXdpbmcgdGhlIGxpc3QgYXMgdGhleSBjb21lIGluLgogIGxldCBoaXRzUnVuID0gMDsKICBhc3luYyBmdW5jdGlvbiBmZXRjaEhpdHMoKSB7CiAgICBpZiAoIU4udGVybXMubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBydW4gPSArK2hpdHNSdW47CiAgICBjb25zdCBrZXkgPSB0ZXJtc0tleSgpOwogICAgY29uc3QgdGVybXMgPSBOLnRlcm1zOwogICAgY29uc3QgdG9kbyA9IHZpc2libGVOb3RlcygpLnNsaWNlKDAsIEVYQ0VSUFRfTElNSVQpLmZpbHRlcihuID0-ICFOLmhpdHMuaGFzKGAke24ubWVzc2FnZUlkfXwke2tleX1gKSk7CiAgICBsZ",
"XQgcmVkcmF3ID0gMDsKICAgIGF3YWl0IHV0aWwubWFwUG9vbCh0b2RvLCA0LCBhc3luYyBuID0-IHsKICAgICAgaWYgKHJ1biAhPT0gaGl0c1J1bikgcmV0dXJuOwogICAgICB0cnkgewogICAgICAgIGNvbnN0IGRvYyA9IGF3YWl0IG5vdGVzU3RvcmUuYm9keShuKTsKICAgICAgICBjb25zdCB0ZXh0ID0gZm10LmRvY1RleHQoZG9jKTsKICAgICAgICBjb25zdCBib2R5ID0gc2VhcmNoTG9naWMuZmluZE1hdGNoZXModGV4dCwgdGVybXMpOwogICAgICAgIGNvbnN0IHRpdGxlID0gc2VhcmNoTG9naWMuZmluZE1hdGNoZXMobi50aXRsZSwgdGVybXMpOwogICAgICAgIE4uaGl0cy5zZXQoYCR7bi5tZXNzYWdlSWR9fCR7a2V5fWAsIHsKICAgICAgICAgIGNvdW50OiBib2R5Lmxlbmd0aCArIHRpdGxlLmxlbmd0aCwKICAgICAgICAgIGV4Y2VycHRzOiBzZWFyY2hMb2dpYy5leGNlcnB0cyh0ZXh0LCBib2R5LCB7IGNvbnRleHQ6IDQ1LCBtYXg6IDMgfSksCiAgICAgICAgfSk7CiAgICAgIH0gY2F0Y2ggeyAvKiB0aGUgc25pcHBldCBzdGFuZHMgaW4gKi8gfQogICAgICBpZiAocnVuID09PSBoaXRzUnVuICYmICFyZWRyYXcpIHJlZHJhdyA9IHNldFRpbWVvdXQoKCkgPT4geyByZWRyYXcgPSAwOyBkcmF3TGlzdCgpOyB9LCA2MCk7CiAgICB9KTsKICAgIGlmIChydW4gPT09IGhpdHNSdW4pIGRyYXdMaXN0KCk7CiAgfQoKICAvLyDilIDilIAgRmluZCBpbiB0aGUgb3BlbiBub3RlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUg",
"OKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBhcHBseUhpZ2hsaWdodHMoKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFlbHMuZWQgfHwgIWMgfHwgYy5ib2R5U3RhdGUgIT09ICdyZWFkeScpIHsgZHJhd0ZpbmQoKTsgcmV0dXJuOyB9CiAgICBjb25zdCBjb3VudCA9IGVscy5lZC5oaWdobGlnaHQoTi50ZXJtcyk7CiAgICBpZiAoTi5maW5kSW5kZXggPj0gY291bnQpIE4uZmluZEluZGV4ID0gMDsKICAgIGlmIChjb3VudCkgZWxzLmVkLnNob3dNYXRjaChOLmZpbmRJbmRleCk7CiAgICBkcmF3RmluZCgpOwogIH0KCiAgZnVuY3Rpb24gc3RlcE1hdGNoKGRlbHRhKSB7CiAgICBjb25zdCBjb3VudCA9IGVscy5lZCA_IGVscy5lZC5tYXRjaENvdW50KCkgOiAwOwogICAgaWYgKCFjb3VudCkgcmV0dXJuOwogICAgTi5maW5kSW5kZXggPSAoTi5maW5kSW5kZXggKyBkZWx0YSArIGNvdW50KSAlIGNvdW50OwogICAgZWxzLmVkLnNob3dNYXRjaChOLmZpbmRJbmRleCk7CiAgICBkcmF3RmluZCgpOwogIH0KCiAgZnVuY3Rpb24gY2xlYXJTZWFyY2goKSB7CiAgICBpZiAoIWVscy5zZWFyY2gpIHJldHVybjsKICAgIGVscy5zZWFyY2gudmFsdWUgPSAnJzsKICAgIE4ucXVlcnkgPSAnJzsKICAgIGNsZWFyVGltZW91dChzZWFyY2hUaW1lcik7CiAgI",
"CBsb2FkKHsgZm9yY2U6IHRydWUgfSk7CiAgfQoKICBmdW5jdGlvbiBkcmF3RmluZCgpIHsKICAgIGlmICghZWxzLmZpbmRTbG90KSByZXR1cm47CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFOLnRlcm1zLmxlbmd0aCB8fCAhYyB8fCAhZWxzLmVkIHx8IGMuYm9keVN0YXRlICE9PSAncmVhZHknKSB7CiAgICAgIGVscy5maW5kU2xvdC5yZXBsYWNlQ2hpbGRyZW4oKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgY291bnQgPSBlbHMuZWQubWF0Y2hDb3VudCgpOwogICAgY29uc3Qgd29yZHMgPSBOLnRlcm1zLm1hcCh0ID0-IHQud29yZHMuam9pbignICcpKS5qb2luKCcsICcpOwogICAgLy8gQSByZWRyYXcgcmVwbGFjZXMgdGhlIGFycm93IGp1c3QgcHJlc3NlZDsgZm9jdXMgZ29lcyB0byBpdHMgc3VjY2Vzc29yCiAgICAvLyByYXRoZXIgdGhhbiBmYWxsaW5nIG91dCBvZiB0aGUgYm9hcmQsIHdoZXJlIEYzIHdvdWxkIG5vdCByZWFjaCBpdC4KICAgIGNvbnN0IGFjdGl2ZSA9IE4uY3R4LnJvb3QuYWN0aXZlRWxlbWVudDsKICAgIGNvbnN0IHJlZm9jdXMgPSBhY3RpdmUgJiYgZWxzLmZpbmRTbG90LmNvbnRhaW5zKGFjdGl2ZSkgPyBhY3RpdmUuZGF0YXNldC5rZXkgOiAnJzsKICAgIGVscy5maW5kU2xvdC5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ25lLWZpbmQnLCByb2xlOiAnc2VhcmNoJywgJ2FyaWEtbGFiZWwnOiAnTWF0Y2hlcyBpbiB0aGlzIG5vdGUnIH0sCiAgICAgI",
"Gljb24oJ3NlYXJjaCcsIDE4KSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmaW5kLXdvcmRzJywgdGV4dDogd29yZHMsIHRpdGxlOiB3b3JkcyB9KSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmaW5kLXBvcycsICdhcmlhLWxpdmUnOiAncG9saXRlJywgdGV4dDogY291bnQgPyBgJHtOLmZpbmRJbmRleCArIDF9IG9mICR7Y291bnR9YCA6ICdOb3QgaW4gdGhlIHRleHQnIH0pLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdQcmV2aW91cyBtYXRjaCAoU2hpZnQrRjMpJywgdGl0bGU6ICdQcmV2aW91cyBtYXRjaCAoU2hpZnQrRjMpJywKICAgICAgICBkaXNhYmxlZDogY291bnQgPCAyLCBkYXRhc2V0OiB7IGtleTogJ2ZpbmQtcHJldicgfSwgb25jbGljazogKCkgPT4gc3RlcE1hdGNoKC0xKSwKICAgICAgfSwgaWNvbigndXAnLCAxOCkpLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdOZXh0IG1hdGNoIChGMyknLCB0aXRsZTogJ05leHQgbWF0Y2ggKEYzKScsCiAgICAgICAgZGlzYWJsZWQ6IGNvdW50IDwgMiwgZGF0YXNldDogeyBrZXk6ICdmaW5kLW5leHQnIH0sIG9uY2xpY2s6ICgpID0-IHN0ZXBNYXRjaCgxKSwKICAgICAgfSwgaWNvbignZG93bicsIDE4KSksCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzc",
"zogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ0NsZWFyIHRoZSBzZWFyY2gnLCB0aXRsZTogJ0NsZWFyIHRoZSBzZWFyY2gnLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnZmluZC1jbGVhcicgfSwgb25jbGljazogY2xlYXJTZWFyY2gsCiAgICAgIH0sIGljb24oJ2Nsb3NlJywgMTgpKSkpOwogICAgaWYgKHJlZm9jdXMpIHsKICAgICAgY29uc3QgYWdhaW4gPSBlbHMuZmluZFNsb3QucXVlcnlTZWxlY3RvcihgW2RhdGEta2V5PSIke3JlZm9jdXN9Il1gKTsKICAgICAgaWYgKGFnYWluICYmICFhZ2Fpbi5kaXNhYmxlZCkgYWdhaW4uZm9jdXMoKTsKICAgIH0KICB9CgogIC8vIOKUgOKUgCBGb2xkZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBjb3VudHMoKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgTWFwKCk7CiAgICBmb3IgKGNvbnN0IG4gb2YgTi5ub3Rlcykgb3V0LnNldChuLmZvbGRlcklkIHx8ICcnLCAob3V0LmdldChuLmZvbGRlcklkIHx8ICcnKSB8fCAwKSArIDEpOwogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIHNldEZvbGRlcnNPcGVuKG9wZW4pIHsKICAgIGlmICghZWxzLndyY",
"XApIHJldHVybjsKICAgIGVscy53cmFwLmRhdGFzZXQuZm9sZGVycyA9IG9wZW4gPyAnb3BlbicgOiAnY2xvc2VkJzsKICAgIGVscy5mb2xkZXJzVG9nZ2xlLnNldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsIFN0cmluZyhvcGVuKSk7CiAgfQoKICAvLyDilIDilIAgRm9sZGluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIEEgZm9sZGVyIHdpdGggc3ViZm9sZGVycyBoYXMgYW4gYXJyb3cgdGhhdCBmb2xkcyB0aGVtIGF3YXksIGZvciBhIHRyZWUKICAvLyB0aGF0IGhhcyBncm93biBsb25nLiBXaGljaCBvbmVzIGFyZSBmb2xkZWQgaXMgcmVtZW1iZXJlZCB3aGVyZSB0aGUKICAvLyBob3N0IGtlZXBzIHN1Y2ggdGhpbmdzIChjdHgucHJlZnMpLCBpZiBpdCBkb2VzOiBhIG5pY2V0eSwgc28gYW55CiAgLy8gdHJvdWJsZSB3aXRoIGl0IGp1c3QgbGVhdmVzIGV2ZXJ5IGZvbGRlciBvcGVuLgoKICBmdW5jdGlvbiBoYXNTdWJmb2xkZXJzKGYpIHsKICAgIHJldHVybiBOLmZvbGRlcnMuc29tZSh4ID0-IHgubmFtZS5zdGFydHNXaXRoKGAke2YubmFtZX0vYCkpOwogIH0KCiAgLy8gSW5zaWRlIGEgZm9sZGVkIGZvbGRlciwgYXQgYW55IGRlc",
"HRoLgogIGZ1bmN0aW9uIGlzVHVja2VkKGYpIHsKICAgIHJldHVybiBOLmZvbGRlcnMuc29tZSh4ID0-IE4uZm9sZGVkLmhhcyh4LmlkKSAmJiBmLm5hbWUuc3RhcnRzV2l0aChgJHt4Lm5hbWV9L2ApKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJlYWRGb2xkZWQoKSB7CiAgICBOLmZvbGRlZFJlYWQgPSB0cnVlOwogICAgY29uc3QgcHJlZnMgPSBOLmN0eCAmJiBOLmN0eC5wcmVmczsKICAgIGlmICghcHJlZnMpIHJldHVybjsKICAgIHRyeSB7CiAgICAgIGNvbnN0IGlkcyA9IGF3YWl0IHByZWZzLmdldCgnZm9sZGVkRm9sZGVycycpOwogICAgICBpZiAoQXJyYXkuaXNBcnJheShpZHMpKSBOLmZvbGRlZCA9IG5ldyBTZXQoaWRzLmZpbHRlcihpZCA9PiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnKSk7CiAgICB9IGNhdGNoIChlcnIpIHsgLyogZXZlcnkgZm9sZGVyIG9wZW4gKi8gfQogIH0KCiAgZnVuY3Rpb24gc2F2ZUZvbGRlZCgpIHsKICAgIGNvbnN0IHByZWZzID0gTi5jdHggJiYgTi5jdHgucHJlZnM7CiAgICBpZiAoIXByZWZzKSByZXR1cm47CiAgICAvLyBPbmx5IGZvbGRlcnMgdGhhdCBhcmUgc3RpbGwgdGhlcmUsIHNvIGRlbGV0ZWQgb25lcyBkbyBub3QgcGlsZSB1cC4KICAgIGNvbnN0IGlkcyA9IFsuLi5OLmZvbGRlZF0uZmlsdGVyKGlkID0-IGZvbGRlckJ5SWQoaWQpKTsKICAgIHRyeSB7CiAgICAgIFByb21pc2UucmVzb2x2ZShwcmVmcy5zZXQoJ2ZvbGRlZEZvbGRlcnMnLCBpZHMpKS5jYXRjaCgoKSA9PiB7f",
"Sk7CiAgICB9IGNhdGNoIChlcnIpIHsgLyogbm90IHJlbWVtYmVyZWQsIHRoYXQgaXMgYWxsICovIH0KICB9CgogIGZ1bmN0aW9uIHNldEZvbGRlZChmLCBmb2xkZWQpIHsKICAgIGlmIChmb2xkZWQgPT09IE4uZm9sZGVkLmhhcyhmLmlkKSkgcmV0dXJuOwogICAgaWYgKGZvbGRlZCkgTi5mb2xkZWQuYWRkKGYuaWQpOwogICAgZWxzZSBOLmZvbGRlZC5kZWxldGUoZi5pZCk7CiAgICBzYXZlRm9sZGVkKCk7CiAgICAvLyBUaGUgcm93cyBhcmUgZHJhd24gYWZyZXNoOiBrZWVwIHRoZSBrZXlib2FyZCB3aGVyZSBpdCB3YXMuCiAgICBjb25zdCBhY3RpdmUgPSBOLmN0eC5yb290LmFjdGl2ZUVsZW1lbnQ7CiAgICBjb25zdCBrZXkgPSBhY3RpdmUgJiYgZWxzLmZvbGRlckl0ZW1zLmNvbnRhaW5zKGFjdGl2ZSkgPyBhY3RpdmUuZGF0YXNldC5rZXkgOiAnJzsKICAgIGRyYXdGb2xkZXJzKCk7CiAgICBpZiAoa2V5KSB7CiAgICAgIGNvbnN0IGFnYWluID0gZWxzLmZvbGRlckl0ZW1zLnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLWtleT0iJHtrZXl9Il1gKTsKICAgICAgaWYgKGFnYWluKSBhZ2Fpbi5mb2N1cygpOwogICAgfQogIH0KCiAgLy8gT3BlbnMgZXZlcnkgZm9sZGVyIGFib3ZlIHRoaXMgb25lLCBhbmQgd2l0aCBzZWxmLCB0aGlzIG9uZSB0b28uCiAgZnVuY3Rpb24gdW5mb2xkKGYsIHNlbGYpIHsKICAgIGxldCBjaGFuZ2VkID0gZmFsc2U7CiAgICBmb3IgKGNvbnN0IHggb2YgTi5mb2xkZXJzKSB7CiAgICAgIGlmIChOLmZvb",
"GRlZC5oYXMoeC5pZCkgJiYgKChzZWxmICYmIHguaWQgPT09IGYuaWQpIHx8IGYubmFtZS5zdGFydHNXaXRoKGAke3gubmFtZX0vYCkpKSB7CiAgICAgICAgTi5mb2xkZWQuZGVsZXRlKHguaWQpOwogICAgICAgIGNoYW5nZWQgPSB0cnVlOwogICAgICB9CiAgICB9CiAgICBpZiAoY2hhbmdlZCkgc2F2ZUZvbGRlZCgpOwogIH0KCiAgZnVuY3Rpb24gc2VsZWN0Rm9sZGVyKGlkKSB7CiAgICBzZXRGb2xkZXJzT3BlbihmYWxzZSk7CiAgICAvLyBPbiBhIHBob25lLCBjaG9vc2luZyBhIGZvbGRlciAtICJBbGwgbm90ZXMiIHRvbyAtIHNob3dzIGl0cyBsaXN0LgogICAgaWYgKCFOLmJyb3dzaW5nKSB7IE4uYnJvd3NpbmcgPSB0cnVlOyBzZXRWaWV3KCk7IH0KICAgIGlmIChOLmZvbGRlciA9PT0gaWQpIHJldHVybjsKICAgIE4uZm9sZGVyID0gaWQ7CiAgICBkcmF3Rm9sZGVycygpOwogICAgZHJhd0xpc3QoKTsKICAgIGZldGNoSGl0cygpOwogIH0KCiAgZnVuY3Rpb24gZHJhd0ZvbGRlcnMoKSB7CiAgICBpZiAoIWVscy5mb2xkZXJJdGVtcykgcmV0dXJuOwogICAgY29uc3QgdGFsbHkgPSBjb3VudHMoKTsKICAgIGNvbnN0IHJvd3MgPSBbZm9sZGVyUm93KG51bGwsIE4ubm90ZXMubGVuZ3RoKV07CiAgICBjb25zdCBlZGl0ID0gTi5mb2xkZXJFZGl0OwogICAgaWYgKGVkaXQgJiYgZWRpdC5tb2RlID09PSAnbmV3JyAmJiAhZWRpdC5wYXJlbnRJZCkgcm93cy5wdXNoKGVkaXRSb3coMCkpOwogICAgY29uc3QgY3VycmVudCA9I",
"E4uZm9sZGVyID8gZm9sZGVyQnlJZChOLmZvbGRlcikgOiBudWxsOwogICAgTi5mb2xkZXJzLmZvckVhY2goKGYsIGkpID0-IHsKICAgICAgaWYgKCFpc1R1Y2tlZChmKSkgewogICAgICAgIHJvd3MucHVzaChlZGl0ICYmIGVkaXQubW9kZSA9PT0gJ3JlbmFtZScgJiYgZWRpdC5mb2xkZXJJZCA9PT0gZi5pZCA_IGVkaXRSb3coZi5kZXB0aCwgZikKICAgICAgICAgIDogZm9sZGVyUm93KGYsIHRhbGx5LmdldChmLmlkKSB8fCAwLCAhIWN1cnJlbnQgJiYgTi5mb2xkZWQuaGFzKGYuaWQpICYmIGN1cnJlbnQubmFtZS5zdGFydHNXaXRoKGAke2YubmFtZX0vYCkpKTsKICAgICAgfQogICAgICAvLyBBIG5ldyBzdWJmb2xkZXIncyBmaWVsZCBnb2VzIGFmdGVyIHRoZSB3aG9sZSBicmFuY2ggaXQgam9pbnMuCiAgICAgIGNvbnN0IG5leHQgPSBOLmZvbGRlcnNbaSArIDFdOwogICAgICBjb25zdCBicmFuY2hFbmRzID0gIW5leHQgfHwgIW5leHQubmFtZS5zdGFydHNXaXRoKGAke2YubmFtZX0vYCk7CiAgICAgIGlmIChlZGl0ICYmIGVkaXQubW9kZSA9PT0gJ25ldycgJiYgZWRpdC5wYXJlbnRJZCkgewogICAgICAgIGNvbnN0IHBhcmVudCA9IGZvbGRlckJ5SWQoZWRpdC5wYXJlbnRJZCk7CiAgICAgICAgaWYgKHBhcmVudCAmJiAoZi5pZCA9PT0gcGFyZW50LmlkIHx8IGYubmFtZS5zdGFydHNXaXRoKGAke3BhcmVudC5uYW1lfS9gKSkgJiYgYnJhbmNoRW5kcykgcm93cy5wdXNoKGVkaXRSb3cocGFyZW50LmRlcHRoICsgMSkpO",
"wogICAgICB9CiAgICB9KTsKICAgIGVscy5mb2xkZXJJdGVtcy5yZXBsYWNlQ2hpbGRyZW4oLi4ucm93cyk7CiAgICAvLyBSb29tIGZvciB0aGUgYXJyb3dzIG9ubHkgb25jZSBzb21lIGZvbGRlciBoYXMgc3ViZm9sZGVycy4KICAgIGVscy5mb2xkZXJJdGVtcy50b2dnbGVBdHRyaWJ1dGUoJ2RhdGEtbmVzdGVkJywgTi5mb2xkZXJzLnNvbWUoZiA9PiBmLmRlcHRoID4gMCkpOwoKICAgIGNvbnN0IHNob3duID0gTi5mb2xkZXIgPyBmb2xkZXJCeUlkKE4uZm9sZGVyKSA6IG51bGw7CiAgICBlbHMuZm9sZGVyc1RvZ2dsZS5yZXBsYWNlQ2hpbGRyZW4oCiAgICAgIGljb24oc2hvd24gPyAnZm9sZGVyJyA6ICdub3RlcycsIDIwKSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmdC1sYWJlbCcsIHRleHQ6IHNob3duID8gZm9sZGVyTGFiZWwoc2hvd24uaWQpIDogJ0FsbCBub3RlcycgfSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZnQtY291bnQnLCB0ZXh0OiBOLnN0YXR1cyA9PT0gJ3JlYWR5JyA_IFN0cmluZyhzaG93biA_IHRhbGx5LmdldChzaG93bi5pZCkgfHwgMCA6IE4ubm90ZXMubGVuZ3RoKSA6ICcnIH0pLAogICAgICBpY29uKCdjYXJldCcsIDIwKSk7CiAgfQoKICAvLyBob2xkc0N1cnJlbnQ6IGZvbGRlZCwgd2l0aCB0aGUgZm9sZGVyIGJlaW5nIGxvb2tlZCBhdCBzb21ld2hlcmUgaW5zaWRlLgogIGZ1bmN0aW9uIGZvbGRlclJvdyhmLCBjb3VudCwgaG9sZHNDdXJyZW50ID0gZmFsc2UpIHsKICAgIGNvb",
"nN0IGlkID0gZiA_IGYuaWQgOiAnJzsKICAgIGNvbnN0IGNoaWxkcmVuID0gZiA_IGhhc1N1YmZvbGRlcnMoZikgOiBmYWxzZTsKICAgIGNvbnN0IGZvbGRlZCA9IGNoaWxkcmVuICYmIE4uZm9sZGVkLmhhcyhpZCk7CiAgICBjb25zdCByb3cgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnZm9sZGVyLXJvdycsIHJvbGU6ICdsaXN0aXRlbScsIGRhdGFzZXQ6IHsgZm9sZGVyOiBpZCB8fCAnYWxsJyB9LAogICAgfSwKICAgICAgY2hpbGRyZW4gPyBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdmb2xkZXItdHdpc3R5JywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWV4cGFuZGVkJzogU3RyaW5nKCFmb2xkZWQpLAogICAgICAgICdhcmlhLWxhYmVsJzogYCR7Zm9sZGVkID8gJ1Nob3cnIDogJ0hpZGUnfSB0aGUgZm9sZGVycyBpbiAke2YudGl0bGV9YCwgdGl0bGU6IGZvbGRlZCA_ICdTaG93IHN1YmZvbGRlcnMnIDogJ0hpZGUgc3ViZm9sZGVycycsCiAgICAgICAgZGF0YXNldDogeyBrZXk6IGBmb2xkZXItdHdpc3R5OiR7aWR9YCB9LCBvbmNsaWNrOiAoKSA9PiBzZXRGb2xkZWQoZiwgIWZvbGRlZCksCiAgICAgIH0sIGljb24oJ2NhcmV0JywgMTgpKSA6IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZm9sZGVyLXR3aXN0eScsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiBgZm9sZGVyLWJ0biR7aG9sZHNDdXJyZW50ID8gJyBob2xkcy1jdXJyZW50JyA6ICcnfWAsI",
"HR5cGU6ICdidXR0b24nLCAnYXJpYS1jdXJyZW50JzogTi5mb2xkZXIgPT09IGlkID8gJ3RydWUnIDogbnVsbCwKICAgICAgICBkYXRhc2V0OiB7IGtleTogYGZvbGRlcjoke2lkIHx8ICdhbGwnfWAgfSwgdGl0bGU6IGYgPyBmLm5hbWUgOiAnRXZlcnkgbm90ZSwgaW4gYW55IGZvbGRlcicsCiAgICAgICAgb25jbGljazogKCkgPT4gc2VsZWN0Rm9sZGVyKGlkKSwKICAgICAgICAvLyBBcyBpbiBhbnkgdHJlZTogcmlnaHQgb3BlbnMgYSBmb2xkZXIncyBzdWJmb2xkZXJzLCBsZWZ0IGZvbGRzIHRoZW0uCiAgICAgICAgb25rZXlkb3duOiBlID0-IHsKICAgICAgICAgIGlmICghY2hpbGRyZW4gfHwgZS5hbHRLZXkgfHwgZS5jdHJsS2V5IHx8IGUubWV0YUtleSB8fCBlLnNoaWZ0S2V5KSByZXR1cm47CiAgICAgICAgICBpZiAoZS5rZXkgPT09ICdBcnJvd1JpZ2h0JyAmJiBmb2xkZWQpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBzZXRGb2xkZWQoZiwgZmFsc2UpOyB9CiAgICAgICAgICBpZiAoZS5rZXkgPT09ICdBcnJvd0xlZnQnICYmICFmb2xkZWQpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBzZXRGb2xkZWQoZiwgdHJ1ZSk7IH0KICAgICAgICB9LAogICAgICB9LAogICAgICAgIGljb24oZiA_ICdmb2xkZXInIDogJ25vdGVzJywgMTgpLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZm9sZGVyLXRpdGxlJywgdGV4dDogZiA_IGYudGl0bGUgOiAnQWxsIG5vdGVzJyB9KSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ",
"2ZvbGRlci1jb3VudCcsIHRleHQ6IE4uc3RhdHVzID09PSAncmVhZHknID8gU3RyaW5nKGNvdW50KSA6ICcnIH0pKSwKICAgICAgZiA_IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuIGZvbGRlci1tZW51JywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogYE1vcmUgYWN0aW9uczogJHtmLnRpdGxlfWAsIHRpdGxlOiAnTW9yZSBhY3Rpb25zJywKICAgICAgICAnYXJpYS1oYXNwb3B1cCc6ICdtZW51JywgJ2FyaWEtZXhwYW5kZWQnOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogYGZvbGRlci1tZW51OiR7aWR9YCB9LAogICAgICAgIG9uY2xpY2s6IGUgPT4gb3Blbk1lbnUoTi5jdHgucm9vdCwgZS5jdXJyZW50VGFyZ2V0LCBbCiAgICAgICAgICB7IGxhYmVsOiAnUmVuYW1lJywgaWNvbjogJ2VkaXQnLCBrZXk6ICdmb2xkZXItcmVuYW1lJywgb25TZWxlY3Q6ICgpID0-IHN0YXJ0Rm9sZGVyRWRpdCh7IG1vZGU6ICdyZW5hbWUnLCBmb2xkZXJJZDogaWQgfSkgfSwKICAgICAgICAgIHsgbGFiZWw6ICdOZXcgc3ViZm9sZGVyJywgaWNvbjogJ2FkZCcsIGtleTogJ2ZvbGRlci1zdWInLCBvblNlbGVjdDogKCkgPT4gc3RhcnRGb2xkZXJFZGl0KHsgbW9kZTogJ25ldycsIHBhcmVudElkOiBpZCB9KSB9LAogICAgICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgICAgIHsKICAgICAgICAgICAgbGFiZWw6IGNvdW50IHx8IGNoaWxkcmVuID8gJ0RlbGV0ZSAoZW1wdHkgaXQgZmlyc3QpJyA6I",
"CdEZWxldGUnLCBpY29uOiAnZGVsZXRlJywgZGFuZ2VyOiB0cnVlLCBrZXk6ICdmb2xkZXItZGVsZXRlJywKICAgICAgICAgICAgZGlzYWJsZWQ6ICEhKGNvdW50IHx8IGNoaWxkcmVuKSwgb25TZWxlY3Q6ICgpID0-IHJlbW92ZUZvbGRlcihmKSwKICAgICAgICAgIH0sCiAgICAgICAgXSwgeyBsYWJlbDogYEFjdGlvbnMgZm9yICR7Zi50aXRsZX1gIH0pLAogICAgICB9LCBpY29uKCdtb3JlJywgMTgpKSA6IG51bGwpOwogICAgLy8gVGhyb3VnaCB0aGUgc3R5bGUgQVBJLCBub3QgYSBzdHlsZSBhdHRyaWJ1dGU6IGEgcGFnZSdzIHNlY3VyaXR5CiAgICAvLyBwb2xpY3kgbWF5IHJlZnVzZSBpbmxpbmUgc3R5bGUgYXR0cmlidXRlcywgbmV2ZXIgdGhpcy4KICAgIHJvdy5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kZXB0aCcsIFN0cmluZyhmID8gZi5kZXB0aCA6IDApKTsKCiAgICAvLyBEcm9wcGluZyBhIG5vdGUgaGVyZSBmaWxlcyBpdCBoZXJlOyBvbiAiQWxsIG5vdGVzIiwgdGFrZXMgaXQgb3V0IG9mCiAgICAvLyBpdHMgZm9sZGVyLgogICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdvdmVyJywgZSA9PiB7CiAgICAgIGlmICghTi5kcmFnS2V5KSByZXR1cm47CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgZS5kYXRhVHJhbnNmZXIuZHJvcEVmZmVjdCA9ICdtb3ZlJzsKICAgICAgcm93LmNsYXNzTGlzdC5hZGQoJ2Ryb3AnKTsKICAgIH0pOwogICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdsZWF2ZScsI",
"CgpID0-IHJvdy5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wJykpOwogICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCBlID0-IHsKICAgICAgaWYgKCFOLmRyYWdLZXkpIHJldHVybjsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICByb3cuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcCcpOwogICAgICBjb25zdCBub3RlID0gTi5ub3Rlcy5maW5kKG4gPT4gbi5rZXkgPT09IE4uZHJhZ0tleSk7CiAgICAgIE4uZHJhZ0tleSA9ICcnOwogICAgICBpZiAobm90ZSkgbW92ZU5vdGUobm90ZSwgaWQpOwogICAgfSk7CiAgICByZXR1cm4gcm93OwogIH0KCiAgZnVuY3Rpb24gZWRpdFJvdyhkZXB0aCwgZm9sZGVyKSB7CiAgICBjb25zdCBlZGl0ID0gTi5mb2xkZXJFZGl0OwogICAgY29uc3QgaW5wdXQgPSBoKCdpbnB1dCcsIHsKICAgICAgY2xhc3M6ICd0ZXh0LWlucHV0IGZvbGRlci1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGVkaXQudmFsdWUsIG1heGxlbmd0aDogU3RyaW5nKG5vdGVzTG9naWMuRk9MREVSX05BTUVfTUFYKSwKICAgICAgcGxhY2Vob2xkZXI6IGVkaXQubW9kZSA9PT0gJ25ldycgPyAnRm9sZGVyIG5hbWUsIHRoZW4gRW50ZXInIDogJycsICdhcmlhLWxhYmVsJzogZWRpdC5tb2RlID09PSAnbmV3JyA_ICdOZXcgZm9sZGVyIG5hbWUnIDogYFJlbmFtZSAke2ZvbGRlci50aXRsZX1gLAogICAgICBkaXNhYmxlZDogISFlZGl0LmJ1c3ksIGRhdGFzZXQ6IHsga2V5OiAnZm9sZGVyLWlucHV0JyB9L",
"AogICAgICBvbmlucHV0OiBlID0-IHsgZWRpdC52YWx1ZSA9IGUudGFyZ2V0LnZhbHVlOyB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGNvbW1pdEZvbGRlckVkaXQoKTsgfQogICAgICAgIGlmIChlLmtleSA9PT0gJ0VzY2FwZScpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBlLnN0b3BQcm9wYWdhdGlvbigpOyBjYW5jZWxGb2xkZXJFZGl0KCk7IH0KICAgICAgfSwKICAgICAgb25ibHVyOiAoKSA9PiB7IGlmICghZWRpdC5idXN5ICYmIE4uZm9sZGVyRWRpdCA9PT0gZWRpdCkgc2V0VGltZW91dCgoKSA9PiB7IGlmIChOLmZvbGRlckVkaXQgPT09IGVkaXQgJiYgIWVkaXQuYnVzeSkgY2FuY2VsRm9sZGVyRWRpdCgpOyB9LCAxNTApOyB9LAogICAgfSk7CiAgICBjb25zdCByb3cgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZm9sZGVyLXJvdyBlZGl0aW5nJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZm9sZGVyLWVkaXQnIH0sIGljb24oJ2ZvbGRlcicsIDE4KSwgaW5wdXQpLAogICAgICBlZGl0LmVycm9yID8gaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlci1lcnJvcicsIHJvbGU6ICdhbGVydCcsIHRleHQ6IGVkaXQuZXJyb3IgfSkgOiBudWxsKTsKICAgIHJvdy5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kZXB0aCcsIFN0cmluZyhkZXB0aCkpOwogICAgcmV0dXJuIHJvdzsKICB9CgogIGZ1bmN0aW9uIHN0YXJ0Rm9sZGVyRWRpdCh7I",
"G1vZGUsIHBhcmVudElkID0gJycsIGZvbGRlcklkID0gJycgfSkgewogICAgY29uc3QgZiA9IGZvbGRlckJ5SWQoZm9sZGVySWQpOwogICAgLy8gQSBuZXcgc3ViZm9sZGVyJ3MgZmllbGQgc2hvd3MgaW5zaWRlIGl0cyBwYXJlbnQsIHNvIHRoYXQgaGFzIHRvIGJlIG9wZW4uCiAgICBjb25zdCBwYXJlbnQgPSBtb2RlID09PSAnbmV3JyA_IGZvbGRlckJ5SWQocGFyZW50SWQpIDogbnVsbDsKICAgIGlmIChwYXJlbnQpIHVuZm9sZChwYXJlbnQsIHRydWUpOwogICAgTi5mb2xkZXJFZGl0ID0geyBtb2RlLCBwYXJlbnRJZCwgZm9sZGVySWQsIHZhbHVlOiBtb2RlID09PSAncmVuYW1lJyAmJiBmID8gZi50aXRsZSA6ICcnLCBlcnJvcjogJycsIGJ1c3k6IGZhbHNlIH07CiAgICBkcmF3Rm9sZGVycygpOwogICAgY29uc3QgaW5wdXQgPSBlbHMuZm9sZGVySXRlbXMucXVlcnlTZWxlY3RvcignW2RhdGEta2V5PSJmb2xkZXItaW5wdXQiXScpOwogICAgaWYgKGlucHV0KSB7IGlucHV0LmZvY3VzKCk7IGlucHV0LnNlbGVjdCgpOyB9CiAgfQoKICBmdW5jdGlvbiBjYW5jZWxGb2xkZXJFZGl0KCkgewogICAgaWYgKCFOLmZvbGRlckVkaXQpIHJldHVybjsKICAgIE4uZm9sZGVyRWRpdCA9IG51bGw7CiAgICBkcmF3Rm9sZGVycygpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gY29tbWl0Rm9sZGVyRWRpdCgpIHsKICAgIGNvbnN0IGVkaXQgPSBOLmZvbGRlckVkaXQ7CiAgICBpZiAoIWVkaXQgfHwgZWRpdC5idXN5KSByZXR1cm47CiAgI",
"CBjb25zdCB0YXJnZXQgPSBlZGl0Lm1vZGUgPT09ICdyZW5hbWUnID8gZm9sZGVyQnlJZChlZGl0LmZvbGRlcklkKSA6IG51bGw7CiAgICBjb25zdCBwYXJlbnQgPSBlZGl0Lm1vZGUgPT09ICduZXcnID8gZm9sZGVyQnlJZChlZGl0LnBhcmVudElkKSA6IG51bGw7CiAgICBjb25zdCBwYXJlbnRQYXRoID0gdGFyZ2V0ID8gdGFyZ2V0LnBhcmVudFBhdGggOiBwYXJlbnQgPyBwYXJlbnQucGF0aCA6ICcnOwogICAgY29uc3Qgc2libGluZ3MgPSBOLmZvbGRlcnMuZmlsdGVyKGYgPT4gZi5wYXJlbnRQYXRoID09PSBwYXJlbnRQYXRoICYmIGYgIT09IHRhcmdldCkubWFwKGYgPT4gZi50aXRsZSk7CiAgICBjb25zdCBwcm9ibGVtID0gbm90ZXNMb2dpYy52YWxpZGF0ZUZvbGRlclRpdGxlKGVkaXQudmFsdWUsIHNpYmxpbmdzKTsKICAgIGlmIChlZGl0Lm1vZGUgPT09ICdyZW5hbWUnICYmIHRhcmdldCAmJiBlZGl0LnZhbHVlLnRyaW0oKSA9PT0gdGFyZ2V0LnRpdGxlKSB7IGNhbmNlbEZvbGRlckVkaXQoKTsgcmV0dXJuOyB9CiAgICBpZiAocHJvYmxlbSkgewogICAgICBlZGl0LmVycm9yID0gcHJvYmxlbTsKICAgICAgZHJhd0ZvbGRlcnMoKTsKICAgICAgY29uc3QgaW5wdXQgPSBlbHMuZm9sZGVySXRlbXMucXVlcnlTZWxlY3RvcignW2RhdGEta2V5PSJmb2xkZXItaW5wdXQiXScpOwogICAgICBpZiAoaW5wdXQpIGlucHV0LmZvY3VzKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGVkaXQuYnVzeSA9IHRydWU7CiAgICBkc",
"mF3Rm9sZGVycygpOwogICAgdHJ5IHsKICAgICAgaWYgKGVkaXQubW9kZSA9PT0gJ25ldycpIHsKICAgICAgICBjb25zdCBtYWRlID0gYXdhaXQgbm90ZXNTdG9yZS5jcmVhdGVGb2xkZXIocGFyZW50LCBlZGl0LnZhbHVlKTsKICAgICAgICBOLmZvbGRlcnMgPSBub3Rlc1N0b3JlLmZvbGRlcnMoKTsKICAgICAgICBpZiAobWFkZSkgTi5mb2xkZXIgPSBtYWRlLmlkOwogICAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBGb2xkZXIg4oCcJHtlZGl0LnZhbHVlLnRyaW0oKX3igJ0gY3JlYXRlZC5gKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBhd2FpdCBub3Rlc1N0b3JlLnJlbmFtZUZvbGRlcih0YXJnZXQsIGVkaXQudmFsdWUpOwogICAgICAgIE4uZm9sZGVycyA9IG5vdGVzU3RvcmUuZm9sZGVycygpOwogICAgICB9CiAgICAgIE4uZm9sZGVyRWRpdCA9IG51bGw7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgZWRpdC5idXN5ID0gZmFsc2U7CiAgICAgIGVkaXQuZXJyb3IgPSBgQ291bGRu4oCZdCBzYXZlOiAke2Vyci5tZXNzYWdlfWA7CiAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICB9CiAgICBkcmF3Rm9sZGVycygpOwogICAgZHJhd0xpc3QoKTsKICAgIGlmIChOLmN1cnJlbnQpIGRyYXdCYXIoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJlbW92ZUZvbGRlcihmKSB7CiAgICB0cnkgewogICAgICBhd2FpdCBub3Rlc1N0b3JlLmRlbGV0ZUZvb",
"GRlcihmKTsKICAgICAgTi5mb2xkZXJzID0gbm90ZXNTdG9yZS5mb2xkZXJzKCk7CiAgICAgIGlmIChOLmZvbGRlciA9PT0gZi5pZCkgTi5mb2xkZXIgPSAnJzsKICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYEZvbGRlciDigJwke2YudGl0bGV94oCdIGRlbGV0ZWQuYCk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgY29uc3QgbXNnID0gZXJyLmNvZGUgPT09ICdub3RfYWxsb3dlZCcgPyAnT25seSBhbiBlbXB0eSBmb2xkZXIgY2FuIGJlIGRlbGV0ZWQuIE1vdmUgaXRzIG5vdGVzIG91dCBmaXJzdC4nIDogZXJyLm1lc3NhZ2U7CiAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBDb3VsZG7igJl0IGRlbGV0ZSDigJwke2YudGl0bGV94oCdOiAke21zZ31gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICB9CiAgICBkcmF3Rm9sZGVycygpOwogICAgZHJhd0xpc3QoKTsKICB9CgogIC8vIFJ1bnMgYWZ0ZXIgYW55IHNhdmUgaW4gcHJvZ3Jlc3MsIHNvIHRoZSBtb3ZlIGxhbmRzIG9uIHRoZSBuZXdlc3QKICAvLyB2ZXJzaW9uIHJhdGhlciB0aGFuIG9uZSBhYm91dCB0byBiZSByZXBsYWNlZC4KICBmdW5jdGlvbiBtb3ZlTm90ZShub3RlLCBmb2xkZXJJZCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudCAmJiBOLmN1cnJlbnQubm90ZSA9PT0gbm90ZSA_IE4uY3VycmVudCA6IG51bGw7CiAgICBpZiAoKG5vdGUuZm9sZGVySWQgfHwgJycpID09PSAoZm9sZGVySWQgfHwgJycpKSByZXR1cm4gTi5jaGFpbjsKICAgIE4uY2hhaW4gPSBOL",
"mNoYWluLnRoZW4oYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBsYXRlc3QgPSBjID8gYy5ub3RlIDogbm90ZTsKICAgICAgY29uc3Qgd2FzID0gbGF0ZXN0LmZvbGRlcklkIHx8ICcnOwogICAgICBsYXRlc3QuZm9sZGVySWQgPSBmb2xkZXJJZDsKICAgICAgaWYgKGMpIGMuZm9sZGVySWQgPSBmb2xkZXJJZDsKICAgICAgZHJhd0ZvbGRlcnMoKTsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgaWYgKGMpIGRyYXdCYXIoKTsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCBub3Rlc1N0b3JlLm1vdmUobGF0ZXN0LCBmb2xkZXJJZCk7CiAgICAgICAgdG9hc3QoTi5jdHgucm9vdCwgZm9sZGVySWQgPyBgTW92ZWQgdG8gJHtmb2xkZXJMYWJlbChmb2xkZXJJZCl9LmAgOiAnVGFrZW4gb3V0IG9mIGl0cyBmb2xkZXIuJyk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGxhdGVzdC5mb2xkZXJJZCA9IHdhczsKICAgICAgICBpZiAoYykgYy5mb2xkZXJJZCA9IHdhczsKICAgICAgICB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBtb3ZlIOKAnCR7bGF0ZXN0LnRpdGxlfeKAnTogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSBOLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgICAgfQogICAgICBkcmF3Rm9sZGVycygpOwogICAgICBkcmF3TGlzdCgpOwogICAgICBpZiAoTi5jdXJyZW50ID09PSBjICYmIGMpIGRyYXdCYXIoK",
"TsKICAgIH0pOwogICAgcmV0dXJuIE4uY2hhaW47CiAgfQoKICAvLyBUaGUgZm9sZGVyIGJ1dHRvbiBhYm92ZSB0aGUgbm90ZTogd2hlcmUgaXQgaXMsIGFuZCB3aGVyZSBpdCBjYW4gZ28uCiAgZnVuY3Rpb24gY2hvb3NlRm9sZGVyKGFuY2hvcikgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYykgcmV0dXJuOwogICAgb3Blbk1lbnUoTi5jdHgucm9vdCwgYW5jaG9yLCBbCiAgICAgIHsgaGVhZGluZzogJ01vdmUgdG8nIH0sCiAgICAgIHsgbGFiZWw6ICdObyBmb2xkZXInLCBrZXk6ICdtb3ZlLWZvbGRlcjpub25lJywgY2hlY2tlZDogIWMuZm9sZGVySWQsIG9uU2VsZWN0OiAoKSA9PiBzZXRDdXJyZW50Rm9sZGVyKCcnKSB9LAogICAgICAuLi5OLmZvbGRlcnMubWFwKGYgPT4gKHsKICAgICAgICBsYWJlbDogYCR7J1x1MjAwMycucmVwZWF0KGYuZGVwdGgpfSR7Zi50aXRsZX1gLCBrZXk6IGBtb3ZlLWZvbGRlcjoke2YuaWR9YCwgY2hlY2tlZDogYy5mb2xkZXJJZCA9PT0gZi5pZCwKICAgICAgICBvblNlbGVjdDogKCkgPT4gc2V0Q3VycmVudEZvbGRlcihmLmlkKSwKICAgICAgfSkpLAogICAgXSwgeyBsYWJlbDogJ0ZvbGRlcicgfSk7CiAgfQoKICBmdW5jdGlvbiBzZXRDdXJyZW50Rm9sZGVyKGlkKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFjKSByZXR1cm47CiAgICAvLyBOb3Qgc2F2ZWQgeWV0OiB0aGUgZm9sZGVyIGlzIHNpbXBseSB3aGVyZSB0aGUgZmlyc3Qgc2F2ZSBwd",
"XRzIGl0LgogICAgaWYgKCFjLm5vdGUpIHsKICAgICAgYy5mb2xkZXJJZCA9IGlkOwogICAgICBkcmF3QmFyKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIG1vdmVOb3RlKGMubm90ZSwgaWQpOwogIH0KCiAgZnVuY3Rpb24gZHJhd0Zvb3QoKSB7CiAgICBpZiAoIWVscy5mb290KSByZXR1cm47CiAgICBlbHMuZm9vdC50ZXh0Q29udGVudCA9IE4udHJ1bmNhdGVkCiAgICAgID8gJ1Nob3dpbmcgdGhlIDEwMCBtb3N0IHJlY2VudC4gU2VhcmNoIHRvIGZpbmQgb2xkZXIgb25lcy4nCiAgICAgIDogYEtlcHQgaW4gR21haWwgdW5kZXIg4oCcJHtub3Rlc1N0b3JlLmxhYmVsTmFtZSgpfeKAnWA7CiAgfQoKICAvLyDilIDilIAgVGhlIGVkaXRvciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gbmV3Q3VycmVudChub3RlKSB7CiAgICByZXR1cm4gewogICAgICBrZXk6IG5vdGUgPyBub3RlLmtleSA6IGBuZXc6JHtEYXRlLm5vdygpfWAsCiAgICAgIG5vdGUsICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBudWxsIHVudGlsIGZpcnN0IHNhdmVkCiAgICAgIHRpdGxlOiBub3RlICYmIG5vdGUudGl0bGUgIT09ICdVbnRpdGxlZCBub3RlJyA_IG5vdGUudGl0b",
"GUgOiAnJywKICAgICAgZG9jOiBub3RlID8gbnVsbCA6IGZtdC5lbXB0eURvYygpLCAgIC8vIGZvcm1hdHRlZCBjb250ZW50LCBvbmNlIGxvYWRlZAogICAgICBib2R5U3RhdGU6IG5vdGUgPyAnbG9hZGluZycgOiAncmVhZHknLCAvLyBsb2FkaW5nIHwgcmVhZHkgfCBlcnJvcgogICAgICBkaXJ0eTogZmFsc2UsCiAgICAgIHNhdmluZzogZmFsc2UsCiAgICAgIGVycm9yOiAnJywKICAgICAgc2F2ZWRBdDogMCwKICAgICAgLy8gQSBuZXcgbm90ZSBzdGFydHMgaW4gdGhlIGZvbGRlciBiZWluZyBsb29rZWQgYXQuCiAgICAgIGZvbGRlcklkOiBub3RlID8gbm90ZS5mb2xkZXJJZCB8fCAnJyA6IE4uZm9sZGVyLAogICAgICAvLyBUaGUgdmVyc2lvbiB0aGUgZWRpdHMgaGVyZSBzdGFydGVkIGZyb20sIGZvciBhIG1lcmdlLgogICAgICBiYXNlOiBub3RlID8gbnVsbCA6IGZtdC5lbXB0eURvYygpLAogICAgICBiYXNlVGl0bGU6IG5vdGUgPyBub3RlLnRpdGxlIDogJycsCiAgICB9OwogIH0KCiAgLy8gVGhlIHNjcmF0Y2hwYWQsIGFzIHRoZSBub3RlIGJlaW5nIGVkaXRlZDogaXRzIHNhdmVkIG1lc3NhZ2UsIG9yIG51bGwKICAvLyB3aGVuIHRoZXJlIGlzIG5vbmUgeWV0LiBJdCBrZWVwcyBpdHMgbmFtZSBhbmQgc3RheXMgb3V0IG9mIGZvbGRlcnMuCiAgZnVuY3Rpb24gc2NyYXRjaEN1cnJlbnQobm90ZSkgewogICAgcmV0dXJuIE9iamVjdC5hc3NpZ24obmV3Q3VycmVudChub3RlKSwgewogICAgICBzY3JhdGNoOiB0cnVlL",
"CBrZXk6IFNDUkFUQ0hfS0VZLCB0aXRsZTogbm90ZXNMb2dpYy5TQ1JBVENIUEFEX1RJVExFLCBmb2xkZXJJZDogJycsCiAgICB9KTsKICB9CgogIC8vIEJlZm9yZSB0aGUgbGlzdCBpcyBpbiwgbm9ib2R5IGtub3dzIHlldCB3aGV0aGVyIHRoZXJlIGlzIG9uZS4KICBmdW5jdGlvbiBwZW5kaW5nU2NyYXRjaCgpIHsKICAgIHJldHVybiBPYmplY3QuYXNzaWduKHNjcmF0Y2hDdXJyZW50KG51bGwpLCB7IGRvYzogbnVsbCwgYm9keVN0YXRlOiAnbG9hZGluZycgfSk7CiAgfQoKICAvLyBXaGVuZXZlciBubyBvdGhlciBub3RlIGlzIG9wZW46IHRoZSBzY3JhdGNocGFkLgogIGZ1bmN0aW9uIHNob3dTY3JhdGNoKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmIChjICYmIGMuc2NyYXRjaCAmJiBjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykgcmV0dXJuOwogICAgaWYgKE4uc2NyYXRjaE5vdGUpIHsgb3Blbk5vdGUoTi5zY3JhdGNoTm90ZSwgeyBmb3JjZTogdHJ1ZSB9KTsgcmV0dXJuOyB9CiAgICBmbHVzaCgpOwogICAgTi5jdXJyZW50ID0gTi5zY3JhdGNoS25vd24gPyBzY3JhdGNoQ3VycmVudChudWxsKSA6IHBlbmRpbmdTY3JhdGNoKCk7CiAgICBkcmF3TGlzdCgpOwogICAgZHJhd0VkaXRvcigpOwogICAgc2NyYXRjaFJlYWR5KCk7CiAgfQoKICAvLyBUaGUgY3Vyc29yIGdvZXMgaW50byB0aGUgc2NyYXRjaHBhZCBvbmNlIGl0IGNhbiB0YWtlIHR5cGluZywgaWYgaXQKICAvLyB3YXMgYXNrZWQgZm9yIGJlZ",
"m9yZSB0aGVuLgogIGZ1bmN0aW9uIHNjcmF0Y2hSZWFkeSgpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIU4ud2FudEZvY3VzIHx8ICFjIHx8ICFjLnNjcmF0Y2ggfHwgYy5ib2R5U3RhdGUgIT09ICdyZWFkeScpIHJldHVybjsKICAgIE4ud2FudEZvY3VzID0gZmFsc2U7CiAgICBmb2N1c0ZpZWxkKCdub3RlLWJvZHknKTsKICB9CgogIGZ1bmN0aW9uIG5ld05vdGUoKSB7CiAgICBmbHVzaCgpOwogICAgTi5jdXJyZW50ID0gbmV3Q3VycmVudChudWxsKTsKICAgIGRyYXdMaXN0KCk7CiAgICBkcmF3RWRpdG9yKCk7CiAgICBmb2N1c0ZpZWxkKCdub3RlLXRpdGxlJyk7CiAgfQoKICBmdW5jdGlvbiBvcGVuTm90ZShub3RlLCB7IGZvcmNlID0gZmFsc2UgfSA9IHt9KSB7CiAgICBpZiAoIWZvcmNlICYmIE4uY3VycmVudCAmJiBOLmN1cnJlbnQua2V5ID09PSBub3RlLmtleSkgcmV0dXJuOwogICAgZmx1c2goKTsKICAgIGNvbnN0IGMgPSBub3RlLmtleSA9PT0gU0NSQVRDSF9LRVkgPyBzY3JhdGNoQ3VycmVudChub3RlKSA6IG5ld0N1cnJlbnQobm90ZSk7CiAgICBOLmN1cnJlbnQgPSBjOwogICAgTi5maW5kSW5kZXggPSAwOwogICAgZHJhd0xpc3QoKTsKICAgIGRyYXdFZGl0b3IoKTsKICAgIG5vdGVzU3RvcmUuYm9keShub3RlKS50aGVuKGRvYyA9PiB7CiAgICAgIGlmIChOLmN1cnJlbnQgIT09IGMpIHJldHVybjsKICAgICAgYy5kb2MgPSBkb2M7CiAgICAgIGMuYmFzZSA9IGRvYzsKICAgICAgYy5ib",
"2R5U3RhdGUgPSAncmVhZHknOwogICAgICBkcmF3RWRpdG9yKCk7CiAgICAgIGFwcGx5SGlnaGxpZ2h0cygpOwogICAgICBzY3JhdGNoUmVhZHkoKTsKICAgIH0sIGVyciA9PiB7CiAgICAgIGlmIChOLmN1cnJlbnQgIT09IGMpIHJldHVybjsKICAgICAgYy5ib2R5U3RhdGUgPSAnZXJyb3InOwogICAgICBjLmVycm9yID0gZXJyLm1lc3NhZ2U7CiAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgIGVsc2UgZHJhd0VkaXRvcigpOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBmb2N1c0ZpZWxkKGtleSkgewogICAgaWYgKGtleSA9PT0gJ25vdGUtYm9keScgJiYgZWxzLmVkKSB7IGVscy5lZC5mb2N1cygpOyByZXR1cm47IH0KICAgIGNvbnN0IGVsID0gZWxzLmVkaXRvciAmJiBlbHMuZWRpdG9yLnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLWtleT0iJHtrZXl9Il1gKTsKICAgIGlmIChlbCkgZWwuZm9jdXMoKTsKICB9CgogIC8vIFdoYXQgYSBwaG9uZSBzaG93czogdGhlIHNjcmF0Y2hwYWQsIHRoZSBsaXN0LCBvciBhIG5vdGUuCiAgZnVuY3Rpb24gc2V0VmlldygpIHsKICAgIGNvbnN0IHZpZXcgPSBOLmN1cnJlbnQgJiYgIU4uY3VycmVudC5zY3JhdGNoID8gJ25vdGUnIDogTi5icm93c2luZyA_ICdsaXN0JyA6ICdob21lJzsKICAgIGlmIChlbHMud3JhcCkgZWxzLndyYXAuZGF0YXNldC52aWV3ID0gdmlldzsKICAgIGlmICh2aWV3ICE9PSBOLnZpZXcpI",
"HsKICAgICAgTi52aWV3ID0gdmlldzsKICAgICAgaWYgKE4uY3R4ICYmIE4uY3R4Lm9uVmlld0NoYW5nZSkgTi5jdHgub25WaWV3Q2hhbmdlKHZpZXcpOwogICAgfQogIH0KCiAgLy8gQmFjayB0byB0aGUgbGlzdCwgb25jZSB3aGF0ZXZlciBpcyBwZW5kaW5nIGlzIHNhdmVkLiBBIHNhdmUgdGhhdAogIC8vIGZhaWxlZCBrZWVwcyB0aGUgbm90ZSBvcGVuLCB3aXRoIGl0cyBlcnJvciBzaG93aW5nLCByYXRoZXIgdGhhbgogIC8vIGxlYXZpbmcgdGhlIGVkaXRzIGJlaGluZC4KICBhc3luYyBmdW5jdGlvbiBjbG9zZU5vdGUoKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFjIHx8IGMuc2NyYXRjaCkgcmV0dXJuOwogICAgYXdhaXQgZmx1c2goKTsKICAgIGlmIChOLmN1cnJlbnQgIT09IGMpIHJldHVybjsKICAgIGlmIChjLmRpcnR5KSB7CiAgICAgIHRvYXN0KE4uY3R4LnJvb3QsICdOb3Qgc2F2ZWQgeWV0LCBzbyB0aGUgbm90ZSBzdGF5cyBvcGVuLiBUcnkgYWdhaW4gaW4gYSBtb21lbnQuJywgeyBraW5kOiAnZXJyb3InIH0pOwogICAgICByZXR1cm47CiAgICB9CiAgICBzaG93U2NyYXRjaCgpOwogIH0KCiAgLy8gQSBwaG9uZSdzIEJhY2s6IGEgbm90ZSBiYWNrIHRvIHdoZXJlIGl0IHdhcyBvcGVuZWQgZnJvbSwgYW5kIHRoZSBsaXN0CiAgLy8gYmFjayB0byB0aGUgc2NyYXRjaHBhZCwgd2l0aCB0aGUgc2VhcmNoIGFuZCB0aGUgZm9sZGVyIGNsZWFyZWQuCiAgYXN5bmMgZnVuY3Rpb24gYmFjaygpI",
"HsKICAgIGlmIChOLmN1cnJlbnQgJiYgIU4uY3VycmVudC5zY3JhdGNoKSByZXR1cm4gY2xvc2VOb3RlKCk7CiAgICBpZiAoIU4uYnJvd3NpbmcpIHJldHVybjsKICAgIE4uYnJvd3NpbmcgPSBmYWxzZTsKICAgIHNldEZvbGRlcnNPcGVuKGZhbHNlKTsKICAgIGlmIChOLmZvbGRlcikgeyBOLmZvbGRlciA9ICcnOyBkcmF3Rm9sZGVycygpOyBkcmF3TGlzdCgpOyB9CiAgICBpZiAoTi5xdWVyeSkgY2xlYXJTZWFyY2goKTsKICAgIHNldFZpZXcoKTsKICB9CgogIC8vIEhvdyBmYXIgZnJvbSB0aGUgc2NyYXRjaHBhZDogMCB0aGVyZSwgMSBpbiB0aGUgbGlzdCBvciBhIG5vdGUgb3BlbmVkCiAgLy8gZnJvbSB0aGUgc2NyYXRjaHBhZCwgMiBpbiBhIG5vdGUgb3BlbmVkIGZyb20gdGhlIGxpc3QuCiAgZnVuY3Rpb24gZGVwdGgoKSB7CiAgICBjb25zdCBpbk5vdGUgPSAhIShOLmN1cnJlbnQgJiYgIU4uY3VycmVudC5zY3JhdGNoKTsKICAgIHJldHVybiAoTi5icm93c2luZyA_IDEgOiAwKSArIChpbk5vdGUgPyAxIDogMCk7CiAgfQoKICBmdW5jdGlvbiBkcmF3RWRpdG9yKCkgewogICAgaWYgKCFlbHMuZWRpdG9yKSByZXR1cm47CiAgICBzZXRWaWV3KCk7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFjKSByZXR1cm47CiAgICBlbHMuZWRpdG9yLmNsYXNzTGlzdC50b2dnbGUoJ3NjcmF0Y2gnLCAhIWMuc2NyYXRjaCk7CgogICAgZWxzLmJhciA9IGgoJ2RpdicsIHsgY2xhc3M6ICduZS1iYXInIH0pOwogICAgZ",
"WxzLmJhbm5lclNsb3QgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtYmFubmVyLXNsb3QnIH0pOwogICAgY29uc3QgdGl0bGUgPSBjLnNjcmF0Y2ggPyBoKCdoMicsIHsgY2xhc3M6ICduZS10aXRsZSBzY3JhdGNoLXRpdGxlJywgZGF0YXNldDogeyBrZXk6ICdzY3JhdGNoLXRpdGxlJyB9IH0sCiAgICAgIGljb24oJ2VkaXQnLCAyMiksIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3QtbmFtZScsIHRleHQ6IG5vdGVzTG9naWMuU0NSQVRDSFBBRF9USVRMRSB9KSkgOiBoKCdpbnB1dCcsIHsKICAgICAgY2xhc3M6ICduZS10aXRsZScsIHR5cGU6ICd0ZXh0JywgcGxhY2Vob2xkZXI6ICdUaXRsZScsICdhcmlhLWxhYmVsJzogJ1RpdGxlJywKICAgICAgdmFsdWU6IGMudGl0bGUsIG1heGxlbmd0aDogU3RyaW5nKG5vdGVzTG9naWMuTUFYX1RJVExFKSwgZGF0YXNldDogeyBrZXk6ICdub3RlLXRpdGxlJyB9LAogICAgICBkaXNhYmxlZDogYy5ib2R5U3RhdGUgIT09ICdyZWFkeScsCiAgICAgIG9uaW5wdXQ6IGUgPT4gZWRpdGVkKGMsIHsgdGl0bGU6IGUudGFyZ2V0LnZhbHVlIH0pLAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIC8vIEVudGVyIGluIHRoZSB0aXRsZSBjYXJyaWVzIG9uIGludG8gdGhlIGJvZHksIGFzIGluIG1vc3QgZWRpdG9ycy4KICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicgJiYgIWUuaXNDb21wb3NpbmcpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBmb2N1c0ZpZWxkKCdub3RlLWJvZHknKTsgfQogI",
"CAgICB9LAogICAgfSk7CiAgICAvLyBBIGZyZXNoIGVkaXRvciBwZXIgbm90ZTogaXRzIHVuZG8gaGlzdG9yeSBiZWxvbmdzIHRvIHRoYXQgbm90ZS4KICAgIGlmIChlbHMuZWQpIGVscy5lZC5kZXN0cm95KCk7CiAgICBjb25zdCBlZCA9IG5zLm5vdGVFZGl0b3IuY3JlYXRlKHsgcm9vdDogTi5jdHgucm9vdCwgb25DaGFuZ2U6ICgpID0-IGVkaXRlZChjLCB7IGRvYzogZWQuZ2V0RG9jKCkgfSkgfSk7CiAgICBlbHMuZWQgPSBlZDsKICAgIGVkLnNldERvYyhjLmRvYyB8fCBmbXQuZW1wdHlEb2MoKSk7CiAgICBlZC5zZXRFZGl0YWJsZShjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JywKICAgICAgYy5ib2R5U3RhdGUgPT09ICdsb2FkaW5nJyA_ICdMb2FkaW5n4oCmJyA6IGMuYm9keVN0YXRlID09PSAnZXJyb3InID8gJ0NvdWxkbuKAmXQgbG9hZCB0aGlzIG5vdGUuJwogICAgICAgIDogYy5zY3JhdGNoID8gYEpvdCBhbnl0aGluZyBkb3duLiBJdCBzYXZlcyBhcyB5b3UgdHlwZSwgYXMgYSBub3RlIGluIEdtYWlsIHVuZGVyIOKAnCR7bm90ZXNTdG9yZS5sYWJlbE5hbWUoKX3igJ0uYCA6ICdXcml0ZSBoZXJl4oCmJyk7CgogICAgZWxzLmZpbmRTbG90ID0gaCgnZGl2JywgeyBjbGFzczogJ25lLWZpbmQtc2xvdCcgfSk7CiAgICBlbHMuZWRpdG9yLnJlcGxhY2VDaGlsZHJlbihlbHMuYmFyLCBlbHMuYmFubmVyU2xvdCwgZWxzLmZpbmRTbG90LCB0aXRsZSwgZWQudG9vbGJhciwgZWQubGlua2JhciwgZWQuZWxlbWVudCk7CiAgI",
"CBkcmF3QmFyKCk7CiAgICBkcmF3RmluZCgpOwogIH0KCiAgLy8gVGhlIHN0cmlwIGFib3ZlIHRoZSB0ZXh0OiBzdGF0dXMsIGJ1dHRvbnMsIGFuZCB0aGUgYmFubmVyIGZvciBhbgogIC8vIGVtYWlsZWQgbm90ZS4gUmVkcmF3biBvbiBpdHMgb3duIGFmdGVyIGEgc2F2ZSAtIHRoZSBmaXJzdCBzYXZlIG9mIGEKICAvLyBuZXcgbm90ZSBnYWlucyBhbiAiT3BlbiBpbiBHbWFpbCIsIGFuIGVtYWlsZWQgb25lIGxvc2VzIGl0cyBiYW5uZXIgLQogIC8vIHdpdGhvdXQgdG91Y2hpbmcgdGhlIHRleHQgYm94ZXMgdGhlIHVzZXIgbWF5IHN0aWxsIGJlIHR5cGluZyBpbi4KICBmdW5jdGlvbiBkcmF3QmFyKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCAhZWxzLmJhcikgcmV0dXJuOwogICAgY29uc3QgZm9yZWlnbiA9ICEhKGMubm90ZSAmJiAhYy5ub3RlLm93bik7CiAgICBlbHMuc3RhdHVzID0gaCgnc3BhbicsIHsgY2xhc3M6ICduZS1zdGF0dXMnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScgfSk7CiAgICAvLyBUaGUgc2NyYXRjaHBhZCdzIHN0YXR1cyBzaXRzIG9uIGl0cyB0aXRsZSBsaW5lOiB0aGVyZSBpcyBub3RoaW5nCiAgICAvLyBlbHNlIGZvciBhIGJhciB0byBob2xkLgogICAgaWYgKGMuc2NyYXRjaCkgewogICAgICBlbHMuYmFyLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICBlbHMuYmFubmVyU2xvdC5yZXBsYWNlQ2hpbGRyZW4oJycpOwogICAgICBjb25zdCBsaW5lID0gZWxzLmVkaXRvc",
"i5xdWVyeVNlbGVjdG9yKCcuc2NyYXRjaC10aXRsZScpOwogICAgICBjb25zdCBvbGQgPSBsaW5lICYmIGxpbmUucXVlcnlTZWxlY3RvcignLm5lLXN0YXR1cycpOwogICAgICBpZiAob2xkKSBvbGQucmVwbGFjZVdpdGgoZWxzLnN0YXR1cyk7CiAgICAgIGVsc2UgaWYgKGxpbmUpIGxpbmUuYXBwZW5kKGVscy5zdGF0dXMpOwogICAgICBkcmF3U3RhdHVzKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGVscy5iYXIucmVwbGFjZUNoaWxkcmVuKAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0biBuZS1iYWNrJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ0JhY2sgdG8gdGhlIGxpc3QnLCB0aXRsZTogJ0JhY2sgdG8gdGhlIGxpc3QnLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS1iYWNrJyB9LCBvbmNsaWNrOiAoKSA9PiBjbG9zZU5vdGUoKSwKICAgICAgfSwgaWNvbignYmFjaycpKSwKICAgICAgZWxzLnN0YXR1cywKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3NwYWNlcicgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ25lLWZvbGRlcicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1oYXNwb3B1cCc6ICdtZW51JywgJ2FyaWEtZXhwYW5kZWQnOiAnZmFsc2UnLAogICAgICAgIHRpdGxlOiAnTW92ZSB0byBhbm90aGVyIGZvbGRlcicsIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS1mb2xkZXInIH0sCiAgICAgICAgb25jbGljazogZSA9PiBjaG9vc2VGb",
"2xkZXIoZS5jdXJyZW50VGFyZ2V0KSwKICAgICAgfSwgaWNvbignZm9sZGVyJywgMTgpLCBoKCdzcGFuJywgeyB0ZXh0OiBjLmZvbGRlcklkID8gZm9sZGVyTGFiZWwoYy5mb2xkZXJJZCkgfHwgJ05vIGZvbGRlcicgOiAnTm8gZm9sZGVyJyB9KSwgaWNvbignY2FyZXQnLCAxOCkpLAogICAgICBjLm5vdGUgPyBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdPcGVuIGluIEdtYWlsJywgdGl0bGU6ICdPcGVuIGluIEdtYWlsJywKICAgICAgICBkYXRhc2V0OiB7IGtleTogJ25vdGUtb3BlbicgfSwgb25jbGljazogKCkgPT4gb3BlbkluR21haWwoYyksCiAgICAgIH0sIGljb24oJ29wZW4nKSkgOiBudWxsLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6IGZvcmVpZ24gPyAnVGFrZSBvZmYgdGhlIG5vdGVzIGxpc3QnIDogJ0RlbGV0ZSBub3RlJywKICAgICAgICB0aXRsZTogZm9yZWlnbiA_ICdUYWtlIG9mZiB0aGUgbm90ZXMgbGlzdCAodGhlIGVtYWlsIHN0YXlzKScgOiAnRGVsZXRlIChtb3ZlcyBpdCB0byBHbWFpbOKAmXMgVHJhc2gpJywKICAgICAgICBkYXRhc2V0OiB7IGtleTogJ25vdGUtZGVsZXRlJyB9LCBvbmNsaWNrOiAoKSA9PiBkZWxldGVDdXJyZW50KCksCiAgICAgIH0sIGljb24oJ2RlbGV0ZScpKSk7CiAgICBlbHMuYmFubmVyU2xvdC5yZ",
"XBsYWNlQ2hpbGRyZW4oZm9yZWlnbiA_IGgoJ2RpdicsIHsKICAgICAgY2xhc3M6ICduZS1iYW5uZXInLAogICAgICB0ZXh0OiBgVGhpcyBvbmUgaXMgYW4gZW1haWwgZmlsZWQgdW5kZXIg4oCcJHtub3Rlc1N0b3JlLmxhYmVsTmFtZSgpfeKAnS4gRWRpdGluZyBpdCBzYXZlcyBhIG5ldyBub3RlIGluIGl0cyBwbGFjZTsgYCArCiAgICAgICAgJ3RoZSBlbWFpbCBpdHNlbGYgc3RheXMgaW4gR21haWwsIGp1c3Qgb2ZmIHRoaXMgbGlzdC4nLAogICAgfSkgOiAnJyk7CiAgICBkcmF3U3RhdHVzKCk7CiAgfQoKICBmdW5jdGlvbiBkcmF3U3RhdHVzKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghZWxzLnN0YXR1cyB8fCAhYykgcmV0dXJuOwogICAgbGV0IHRleHQ7CiAgICBpZiAoYy5zYXZpbmcpIHRleHQgPSAnU2F2aW5n4oCmJzsKICAgIGVsc2UgaWYgKGMuZXJyb3IgJiYgYy5ib2R5U3RhdGUgPT09ICdyZWFkeScpIHRleHQgPSBgQ291bGRu4oCZdCBzYXZlOiAke2MuZXJyb3J9YDsKICAgIGVsc2UgaWYgKGMuZGlydHkpIHRleHQgPSAnVW5zYXZlZCBjaGFuZ2VzJzsKICAgIGVsc2UgaWYgKGMuc2F2ZWRBdCkgdGV4dCA9IGBTYXZlZCAke3V0aWwuYWdvVGV4dChEYXRlLm5vdygpIC0gYy5zYXZlZEF0KX1gOwogICAgZWxzZSBpZiAoYy5ub3RlKSB0ZXh0ID0gYExhc3Qgc2F2ZWQgJHt1dGlsLnJlbGF0aXZlRGF0ZShjLm5vdGUudXBkYXRlZCl9YDsKICAgIGVsc2UgdGV4dCA9IGMuc2NyYXRjaCA_ICcnI",
"DogJ05ldyBub3RlJzsKICAgIGVscy5zdGF0dXMudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgZWxzLnN0YXR1cy5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsICEhKGMuZXJyb3IgJiYgIWMuc2F2aW5nICYmIGMuYm9keVN0YXRlID09PSAncmVhZHknKSk7CiAgICBlbHMuc3RhdHVzLnRpdGxlID0gYy5ub3RlID8gdXRpbC5mdWxsRGF0ZShjLm5vdGUudXBkYXRlZCkgOiAnJzsKICB9CgogIC8vIOKUgOKUgCBTYXZpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGVkaXRlZChjLCBjaGFuZ2UpIHsKICAgIE9iamVjdC5hc3NpZ24oYywgY2hhbmdlKTsKICAgIGMuZGlydHkgPSB0cnVlOwogICAgYy5lcnJvciA9ICcnOwogICAgZHJhd1N0YXR1cygpOwogICAgaWYgKGNoYW5nZS5kb2MgJiYgTi50ZXJtcy5sZW5ndGgpIHsKICAgICAgY2xlYXJUaW1lb3V0KGZpbmRUaW1lcik7CiAgICAgIGZpbmRUaW1lciA9IHNldFRpbWVvdXQoYXBwbHlIaWdobGlnaHRzLCAzMDApOwogICAgfQogICAgY2xlYXJUaW1lb3V0KHNhdmVUaW1lcik7CiAgICBzYXZlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0-IHNhdmUoYyksIEFVVE9TQVZFX01TKTsKICAgI",
"GlmIChjLnNjcmF0Y2ggJiYgbm90ZXNTdG9yZS5rZWVwRHJhZnQpIHsKICAgICAgY2xlYXJUaW1lb3V0KGRyYWZ0VGltZXIpOwogICAgICBkcmFmdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBrZWVwRHJhZnQoYyksIDMwMCk7CiAgICB9CiAgfQoKICAvLyBTYXZlcyBhcmUgY2hhaW5lZDogZWFjaCBvbmUgcmV0aXJlcyB0aGUgdmVyc2lvbiB0aGUgcHJldmlvdXMgb25lCiAgLy8gd3JvdGUsIHNvIHR3byBpbiBmbGlnaHQgYXQgb25jZSB3b3VsZCBlYWNoIGxlYXZlIGEgc3RyYXkgYmVoaW5kLgogIGZ1bmN0aW9uIHNhdmUoYykgewogICAgTi5jaGFpbiA9IE4uY2hhaW4udGhlbihhc3luYyAoKSA9PiB7CiAgICAgIGlmICghYy5kaXJ0eSkgcmV0dXJuOwogICAgICAvLyBBbiB1bnRvdWNoZWQgbmV3IG5vdGUgaXMgbm90IHdvcnRoIGEgbWVzc2FnZS4KICAgICAgaWYgKCFjLm5vdGUgJiYgKGMuc2NyYXRjaCB8fCAhYy50aXRsZS50cmltKCkpICYmIGZtdC5pc0VtcHR5KGMuZG9jKSkgeyBjLmRpcnR5ID0gZmFsc2U7IHJldHVybjsgfQogICAgICBjb25zdCBzbmFwID0geyB0aXRsZTogYy50aXRsZSwgZG9jOiBjLmRvYywgZm9sZGVySWQ6IGMuZm9sZGVySWQsIG5vdGVJZDogYy5zY3JhdGNoID8gbm90ZXNMb2dpYy5TQ1JBVENIUEFEX0lEIDogJycgfTsKICAgICAgLy8gQSBzY3JhdGNocGFkIHN0YXJ0ZWQgaGVyZSB3aGlsZSBhbm90aGVyIGNvbXB1dGVyIHN0YXJ0ZWQgb25lIHRvby4KICAgICAgLy8gV2hlcmUgdGhlIHN0b",
"3JlIGNoZWNrcyBmb3IgbmV3ZXIgdmVyc2lvbnMgKHRoZSBwaG9uZSBhcHApLCBpdCBzYXlzCiAgICAgIC8vIHNvIGFuZCB0aGUgdHdvIGFyZSBtZXJnZWQ7IG90aGVyd2lzZSB0aGUgb3RoZXIncyB2ZXJzaW9uIGlzCiAgICAgIC8vIHJldGlyZWQsIGFzIGFueSBvbGRlciB2ZXJzaW9uIGlzLgogICAgICBjb25zdCBiZWZvcmUgPSBjLm5vdGUgfHwgKGMuc2NyYXRjaCAmJiAhbm90ZXNTdG9yZS5jaGVja3NDb25mbGljdHMgPyBOLnNjcmF0Y2hOb3RlIDogbnVsbCk7CiAgICAgIGMuZGlydHkgPSBmYWxzZTsKICAgICAgYy5zYXZpbmcgPSB0cnVlOwogICAgICBkcmF3U3RhdHVzKCk7CiAgICAgIGxldCBuZXdlciA9IG51bGw7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBub3Rlc1N0b3JlLnNhdmUoaG9va3MuZ2V0QWNjb3VudCgpLCBiZWZvcmUsIHNuYXApOwogICAgICAgIGNvbnN0IG9sZEtleSA9IGMua2V5OwogICAgICAgIGNvbnN0IHdhc091cnMgPSAhIShiZWZvcmUgJiYgYmVmb3JlLm93bik7CiAgICAgICAgYy5ub3RlID0gc2F2ZWQ7CiAgICAgICAgYy5rZXkgPSBzYXZlZC5rZXk7CiAgICAgICAgYy5iYXNlID0gc25hcC5kb2M7CiAgICAgICAgYy5iYXNlVGl0bGUgPSBzbmFwLnRpdGxlOwogICAgICAgIGMuc2F2ZWRBdCA9IERhdGUubm93KCk7CiAgICAgICAgYy5jb25mbGljdHMgPSAwOwogICAgICAgIGlmIChjLnNjcmF0Y2gpIHsgTi5zY3JhdGNoTm90ZSA9IHNhdmVkOyBOLnNjcmF0Y",
"2hLbm93biA9IHRydWU7IH0KICAgICAgICBjLmVycm9yID0gJyc7CiAgICAgICAgTi5ub3RlcyA9IFtzYXZlZCwgLi4uTi5ub3Rlcy5maWx0ZXIobiA9PiBuLmtleSAhPT0gb2xkS2V5ICYmIG4ua2V5ICE9PSBzYXZlZC5rZXkpXTsKICAgICAgICAvLyBBIGZpcnN0IHNhdmUgaXMgb25lIG1vcmUgbm90ZTogdGhlIGNvdW50cyBieSB0aGUgZm9sZGVycyBjaGFuZ2UuCiAgICAgICAgaWYgKCFiZWZvcmUpIGRyYXdGb2xkZXJzKCk7CiAgICAgICAgaWYgKCF3YXNPdXJzICYmIE4uY3VycmVudCA9PT0gYykgZHJhd0JhcigpOwogICAgICAgIGlmICghYy5kaXJ0eSkga2VlcERyYWZ0KGMpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBjLmRpcnR5ID0gdHJ1ZTsKICAgICAgICAvLyBTYXZlZCBvbiBhbm90aGVyIGRldmljZSBzaW5jZTogbWVyZ2VkLCB0aGVuIHNhdmVkIGFnYWluIC0gdW5sZXNzCiAgICAgICAgLy8gaXQga2VlcHMgaGFwcGVuaW5nLCB3aGljaCBuZWVkcyBhIHBlcnNvbiB0byBsb29rLgogICAgICAgIGlmIChlcnIuY29kZSA9PT0gJ2NvbmZsaWN0JyAmJiBlcnIubmV3ZXIgJiYgKGMuY29uZmxpY3RzID0gKGMuY29uZmxpY3RzIHx8IDApICsgMSkgPD0gMykgbmV3ZXIgPSBlcnIubmV3ZXI7CiAgICAgICAgZWxzZSBjLmVycm9yID0gZXJyLmNvZGUgPT09ICdjb25mbGljdCcgPyAnSXQga2VlcHMgY2hhbmdpbmcgb24gYW5vdGhlciBkZXZpY2UuIFRyeSBhZ2FpbiBpbiBhIG1vbWVudC4nIDogZXJyLm1lc",
"3NhZ2U7CiAgICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSBOLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBjLnNhdmluZyA9IGZhbHNlOwogICAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMpIGRyYXdTdGF0dXMoKTsKICAgICAgICBkcmF3TGlzdCgpOwogICAgICB9CiAgICAgIGlmIChuZXdlcikgYWRvcHROZXdlcihjLCBuZXdlcik7CiAgICB9KTsKICAgIHJldHVybiBOLmNoYWluOwogIH0KCiAgLy8gV2hhdGV2ZXIgaXMgcGVuZGluZywgbm93LiBDYWxsZWQgb24gQ3RybCtTLCBvbiBzd2l0Y2hpbmcgbm90ZXMgb3IKICAvLyB0YWJzLCBhbmQgd2hlbiB0aGUgYm9hcmQgY2xvc2VzLgogIGZ1bmN0aW9uIGZsdXNoKCkgewogICAgY2xlYXJUaW1lb3V0KHNhdmVUaW1lcik7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgcmV0dXJuIGMgJiYgYy5kaXJ0eSA_IHNhdmUoYykgOiBOLmNoYWluOwogIH0KCiAgLy8g4pSA4pSAIE90aGVyIGFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIG9wZW5JbkdtYWlsKGMpIHsKICAgIGF3YWl0IGZsdXNoKCk7CiAgICBpZiAoIWMubm90ZSB8f",
"CAhYy5ub3RlLnRocmVhZElkKSByZXR1cm47CiAgICBOLmN0eC5jbG9zZUJvYXJkKCk7CiAgICBob29rcy5vcGVuVGhyZWFkKGMubm90ZS50aHJlYWRJZCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBkZWxldGVDdXJyZW50KCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCBjLnNjcmF0Y2gpIHJldHVybjsKICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpOwogICAgYXdhaXQgTi5jaGFpbjsKICAgIE4uY3VycmVudCA9IG51bGw7CiAgICBzaG93U2NyYXRjaCgpOwogICAgY29uc3Qgbm90ZSA9IGMubm90ZTsKICAgIGlmICghbm90ZSkgeyBkcmF3TGlzdCgpOyByZXR1cm47IH0gLy8gbmV2ZXIgc2F2ZWQ6IG5vdGhpbmcgaW4gR21haWwKCiAgICBjb25zdCBhdCA9IE4ubm90ZXMuZmluZEluZGV4KG4gPT4gbi5rZXkgPT09IG5vdGUua2V5KTsKICAgIE4ubm90ZXMgPSBOLm5vdGVzLmZpbHRlcihuID0-IG4ua2V5ICE9PSBub3RlLmtleSk7CiAgICBkcmF3TGlzdCgpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgbm90ZXNTdG9yZS5yZXRpcmUobm90ZSk7CiAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIG5vdGUub3duCiAgICAgICAgPyAnTm90ZSBtb3ZlZCB0byBHbWFpbOKAmXMgVHJhc2guJwogICAgICAgIDogYFRha2VuIG9mZiB0aGUgbm90ZXMgbGlzdC4gVGhlIGVtYWlsIHN0YXlzIGluIEdtYWlsLmAsIHsKICAgICAgICBhY3Rpb246IHsgbGFiZWw6ICdVbmRvJywgb25DbGljazogKCkgPT4gdW5kb0Rlb",
"GV0ZShub3RlLCBhdCkgfSwKICAgICAgICB0aW1lb3V0OiA4MDAwLAogICAgICB9KTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBOLm5vdGVzLnNwbGljZShNYXRoLm1heCgwLCBhdCksIDAsIG5vdGUpOwogICAgICBkcmF3TGlzdCgpOwogICAgICB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBkZWxldGUg4oCcJHtub3RlLnRpdGxlfeKAnTogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICB9CiAgfQoKICBhc3luYyBmdW5jdGlvbiB1bmRvRGVsZXRlKG5vdGUsIGF0KSB7CiAgICB0cnkgewogICAgICBhd2FpdCBub3Rlc1N0b3JlLnJlc3RvcmUobm90ZSk7CiAgICAgIE4ubm90ZXMuc3BsaWNlKE1hdGgubWF4KDAsIE1hdGgubWluKGF0LCBOLm5vdGVzLmxlbmd0aCkpLCAwLCBub3RlKTsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgb3Blbk5vdGUobm90ZSwgeyBmb3JjZTogdHJ1ZSB9KTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBicmluZyBpdCBiYWNrOiAke2Vyci5tZXNzYWdlfS4gSXQgaXMgc3RpbGwgaW4gR21haWzigJlzIFRyYXNoLmAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgIH0KICB9CgogIC8vIEN0cmwrUyAo4oyYUykgc2F2ZXMgbm93IGluc3RlYWQgb2YgQ2hyb21lJ3MgIlNhdmUgcGFnZSBhcyIuCiAgZnVuY3Rpb24gaGFuZGxlS2V5KGUpIHsKICAgIGlmICgoZS5jdHJsS2V5IHx8IGUubWV0YUtleSkgJiYgIWUuY",
"Wx0S2V5ICYmIGUua2V5LnRvTG93ZXJDYXNlKCkgPT09ICdzJykgewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGZsdXNoKCk7CiAgICAgIHJldHVybiB0cnVlOwogICAgfQogICAgaWYgKGUua2V5ID09PSAnRjMnICYmIE4udGVybXMubGVuZ3RoICYmIGVscy5lZCkgewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIHN0ZXBNYXRjaChlLnNoaWZ0S2V5ID8gLTEgOiAxKTsKICAgICAgcmV0dXJuIHRydWU7CiAgICB9CiAgICByZXR1cm4gZmFsc2U7CiAgfQoKICAvLyBDYWxsZWQgZXZlcnkgZmV3IHNlY29uZHMgd2hpbGUgdGhlIGJvYXJkIGlzIG9wZW4sIGZvciAiU2F2ZWQgNXMgYWdvIi4KICBmdW5jdGlvbiB0aWNrKCkgewogICAgZHJhd1N0YXR1cygpOwogIH0KCiAgLy8gVHlwaW5nIGdvZXMgc3RyYWlnaHQgaW50byB0aGUgc2NyYXRjaHBhZCAtIG9yLCB3aXRoIGFub3RoZXIgbm90ZQogIC8vIG9wZW4sIGludG8gdGhhdC4KICBmdW5jdGlvbiBmb2N1c0RlZmF1bHQoKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKGMgJiYgYy5zY3JhdGNoKSB7CiAgICAgIE4ud2FudEZvY3VzID0gdHJ1ZTsKICAgICAgc2NyYXRjaFJlYWR5KCk7CiAgICB9IGVsc2UgaWYgKGMpIGZvY3VzRmllbGQoYy5ib2R5U3RhdGUgPT09ICdyZWFkeScgJiYgYy50aXRsZSA_ICdub3RlLWJvZHknIDogJ25vdGUtdGl0bGUnKTsKICAgIGVsc2UgaWYgKGVscy5zZWFyY2gpIGVscy5zZWFyY2guZm9jdXMoKTsKI",
"CB9CgogIG5zLm5vdGVzID0gewogICAgaW5pdCwgZWxlbWVudCwgbG9hZCwgaXNTdGFsZSwgZmx1c2gsIGhhbmRsZUtleSwgdGljaywgZm9jdXNEZWZhdWx0LCBjbG9zZU5vdGUsIGJhY2ssIGRlcHRoLCBzY3JhdGNoRm91bmQsCiAgICAvLyBBIG5vdGUgb3RoZXIgdGhhbiB0aGUgc2NyYXRjaHBhZC4KICAgIGlzT3BlbjogKCkgPT4gISEoTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCksCiAgICBsb2FkZWRBdDogKCkgPT4gTi5sb2FkZWRBdCwKICAgIGlzTG9hZGluZzogKCkgPT4gISFOLmxvYWRpbmcsCiAgfTsKfSkoKTsK\"],[\"src/content/calendar-store.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIENhbGVuZGFyIGRhdGEKLy8KLy8gR29vZ2xlIENhbGVuZGFyJ3MgZXZlbnRzIGFuZCBHb29nbGUgVGFza3MnIHRhc2tzLCByZWFkIHRocm91Z2ggdGhlCi8vIGJhY2tncm91bmQgd29ya2VyIHdpdGggdGhlIGNhbGVuZGFyJ3Mgb3duIHNpZ24taW4gKG9yLCBpbiB0aGUgcGhvbmUKLy8gYXBwLCB0aHJvdWdoIGl0cyBzY3JpcHQpLiBUd28ga2luZHMgb2YgcmVhZDog",
"dGhlIHNvdXJjZXMgLSB3aGljaAovLyBjYWxlbmRhcnMgYW5kIHRhc2sgbGlzdHMgdGhlcmUgYXJlIC0ga2VwdCBmb3IgdGVuIG1pbnV0ZXMsIGFuZCB3aGF0IGlzCi8vIG9uIGluIGEgcmFuZ2Ugb2YgZGF5cywgZm9yIHRoZSBzb3VyY2VzIHRoYXQgYXJlIHN3aXRjaGVkIG9uLgovLwovLyBUcm91YmxlIHdpdGggdGhlIHNpZ24taW4gaXMgdGhyb3duLCBmb3IgdGhlIHZpZXcncyBwYW5lbDsgdHJvdWJsZSB3aXRoCi8vIG9uZSBzZXJ2aWNlIChUYXNrcyBub3QgYWxsb3dlZCwgc2F5KSBjb21lcyBiYWNrIHdpdGggdGhlIHJlc3QsIHNvIGEKLy8gY2FsZW5kYXIgc3RpbGwgc2hvd3Mgd2hlbiB0aGUgdGFza3MgY2Fubm90LgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCBjYWwgPSBucy5jYWxlbmRhckxvZ2ljOwoKICBjb25zdCBTT1VSQ0VTX01TID0gMTAgKiA2MCAqIDEwMDA7CgogIC8vIENvZGVzIHRoYXQgYXJlIGFib3V0IHRo",
"ZSBzaWduLWluLCBub3QgYWJvdXQgb25lIGNhbGVuZGFyIG9yIGxpc3QuCiAgY29uc3QgU0lHTl9JTiA9IG5ldyBTZXQoWydub3RfY29uZmlndXJlZCcsICdjYWxlbmRhcl9hdXRoX3JlcXVpcmVkJywgJ2NhbGVuZGFyX21pc21hdGNoJywgJ2V4dGVuc2lvbl9yZWxvYWRlZCddKTsKCiAgY29uc3QgUyA9IHsKICAgIGFjY291bnQ6ICcnLAogICAgc291cmNlczogbnVsbCwgICAvLyBjYWxlbmRhckxvZ2ljLnNvdXJjZXMoKQogICAgZXJyb3JzOiB7fSwgICAgICAvLyBzZXJ2aWNlIOKGkiBlcnJvciwgZnJvbSB0aGUgbGFzdCBzb3VyY2VzIHJlYWQKICAgIGF0OiAwLAogIH07CgogIGZ1bmN0aW9uIHRocm93U2lnbkluKHJlc3VsdHMpIHsKICAgIGNvbnN0IGJhZCA9IHJlc3VsdHMuZmluZChyID0-IHIgJiYgci5lcnJvciAmJiBTSUdOX0lOLmhhcyhyLmVycm9yLmNvZGUpKTsKICAgIGlmIChiYWQpIHRocm93IGJhZC5lcnJvcjsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKGFjY291bnQsIHsgZm9yY2UgPSBmYWxzZSB9ID0ge30pIHsKICAgIGlmIChTLmFjY291bnQgIT09IGFjY291bnQpIHsKICAgICAgUy5hY2NvdW50ID0gYWNjb3VudDsKICAgICAgUy5zb3VyY2VzID0gbnVsbDsKICAgIH0KICAgIGlmICghZm9yY2UgJiYgUy5zb3VyY2VzICYmIERhdGUubm93KCkgLSBTLmF0IDwgU09VUkNFU19NUykgcmV0dXJuIHsgc291cmNlczogUy5zb3VyY2VzLCBlcnJvcnM6IFMuZXJyb3JzIH07CiAgICBjb25zdCBb",
"Y2FsZW5kYXJzLCBsaXN0c10gPSBhd2FpdCBucy5hcGkuZ29vZ2xlTWFueShjYWwuc291cmNlUmVxdWVzdHMoKSk7CiAgICB0aHJvd1NpZ25JbihbY2FsZW5kYXJzLCBsaXN0c10pOwogICAgY29uc3QgZXJyb3JzID0ge307CiAgICBpZiAoY2FsZW5kYXJzLmVycm9yKSBlcnJvcnMuY2FsZW5kYXIgPSBjYWxlbmRhcnMuZXJyb3I7CiAgICBpZiAobGlzdHMuZXJyb3IpIGVycm9ycy50YXNrcyA9IGxpc3RzLmVycm9yOwogICAgLy8gQSBzZXJ2aWNlIHRoYXQgZmFpbGVkIHRoaXMgdGltZSBrZWVwcyB0aGUgc291cmNlcyBpdCBoYWQuCiAgICBjb25zdCBrZXB0ID0ga2luZCA9PiAoUy5zb3VyY2VzIHx8IFtdKS5maWx0ZXIocyA9PiBzLmtpbmQgPT09IGtpbmQpOwogICAgY29uc3QgZnJlc2ggPSBjYWwuc291cmNlcyhjYWxlbmRhcnMuZXJyb3IgPyBbXSA6IGNhbGVuZGFycy5pdGVtcywgbGlzdHMuZXJyb3IgPyBbXSA6IGxpc3RzLml0ZW1zKTsKICAgIFMuc291cmNlcyA9IFsKICAgICAgLi4uKGNhbGVuZGFycy5lcnJvciA_IGtlcHQoJ2NhbGVuZGFyJykgOiBmcmVzaC5maWx0ZXIocyA9PiBzLmtpbmQgPT09ICdjYWxlbmRhcicpKSwKICAgICAgLi4uKGxpc3RzLmVycm9yID8ga2VwdCgndGFza3MnKSA6IGZyZXNoLmZpbHRlcihzID0-IHMua2luZCA9PT0gJ3Rhc2tzJykpLAogICAgXTsKICAgIFMuZXJyb3JzID0gZXJyb3JzOwogICAgUy5hdCA9IERhdGUubm93KCk7CiAgICByZXR1cm4geyBzb3VyY2VzOiBTLnNvdXJjZXMs",
"IGVycm9ycyB9OwogIH0KCiAgLy8gV2hhdCBpcyBvbiBmcm9tIHJhbmdlLnN0YXJ0IHVwIHRvIHJhbmdlLmVuZCwgZnJvbSB0aGUgZ2l2ZW4gc291cmNlcy4KICBhc3luYyBmdW5jdGlvbiBsb2FkUmFuZ2UocmFuZ2UsIHNvdXJjZXMpIHsKICAgIGNvbnN0IGNhbGVuZGFycyA9IHNvdXJjZXMuZmlsdGVyKHMgPT4gcy5raW5kID09PSAnY2FsZW5kYXInKTsKICAgIGNvbnN0IGxpc3RzID0gc291cmNlcy5maWx0ZXIocyA9PiBzLmtpbmQgPT09ICd0YXNrcycpOwogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IG5zLmFwaS5nb29nbGVNYW55KGNhbC5yYW5nZVJlcXVlc3RzKHJhbmdlLCBjYWxlbmRhcnMsIGxpc3RzKSk7CiAgICB0aHJvd1NpZ25JbihyZXN1bHRzKTsKCiAgICBjb25zdCBpdGVtcyA9IFtdOwogICAgY29uc3QgZXJyb3JzID0ge307CiAgICBsZXQgaSA9IDA7CiAgICBmb3IgKGNvbnN0IGMgb2YgY2FsZW5kYXJzKSB7CiAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2krK107CiAgICAgIGlmIChyLmVycm9yKSB7IGVycm9ycy5jYWxlbmRhciA9IGVycm9ycy5jYWxlbmRhciB8fCByLmVycm9yOyBjb250aW51ZTsgfQogICAgICBmb3IgKGNvbnN0IGV2IG9mIHIuaXRlbXMgfHwgW10pIHsKICAgICAgICBjb25zdCBpdGVtID0gY2FsLmV2ZW50SXRlbShldiwgYyk7CiAgICAgICAgaWYgKGl0ZW0pIGl0ZW1zLnB1c2goaXRlbSk7CiAgICAgIH0KICAgIH0KICAgIGZvciAoY29uc3QgbCBvZiBsaXN0cykgewogICAgICBmb3Ig",
"KGxldCBwYXNzID0gMDsgcGFzcyA8IDI7IHBhc3MrKykgewogICAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2krK107CiAgICAgICAgaWYgKHIuZXJyb3IpIHsgZXJyb3JzLnRhc2tzID0gZXJyb3JzLnRhc2tzIHx8IHIuZXJyb3I7IGNvbnRpbnVlOyB9CiAgICAgICAgZm9yIChjb25zdCB0IG9mIHIuaXRlbXMgfHwgW10pIHsKICAgICAgICAgIGNvbnN0IGl0ZW0gPSBjYWwudGFza0l0ZW0odCwgbCk7CiAgICAgICAgICBpZiAoaXRlbSkgaXRlbXMucHVzaChpdGVtKTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIHJldHVybiB7IGl0ZW1zOiBjYWwudW5pcXVlQnlJZChpdGVtcyksIGVycm9ycyB9OwogIH0KCiAgZnVuY3Rpb24gZm9yZ2V0KCkgewogICAgUy5zb3VyY2VzID0gbnVsbDsKICAgIFMuYXQgPSAwOwogIH0KCiAgbnMuY2FsZW5kYXJTdG9yZSA9IHsgbG9hZFNvdXJjZXMsIGxvYWRSYW5nZSwgZm9yZ2V0LCBTSUdOX0lOIH07Cn0pKCk7Cg\"],[\"src/content/calendar.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBjYWxlbmRhciB2aWV3Ci8vCi8vIFRoZSBib2F",
"yZCdzIHRoaXJkIHRhYjogR29vZ2xlIENhbGVuZGFyJ3MgZXZlbnRzIHdpdGggR29vZ2xlIFRhc2tzJwovLyB0YXNrcyBhbW9uZyB0aGVtLCBkYXkgYnkgZGF5LiBSZWFkLW9ubHkgZm9yIG5vdzogYW4gZXZlbnQgb3BlbnMgaW4KLy8gR29vZ2xlIENhbGVuZGFyLCBhIHRhc2sgaW4gR29vZ2xlIFRhc2tzIChvciwgbWFkZSBmcm9tIGFuIGVtYWlsLCB0aGUKLy8gZW1haWwgaXRzZWxmKS4KLy8KLy8gT24gYSBjb21wdXRlciB0aGVyZSBhcmUgdGhyZWUgdmlld3MgLSBXZWVrIChzZXZlbiBjb2x1bW5zKSwgTW9udGggYW5kCi8vIEFnZW5kYSAoZm91ciB3ZWVrcyBhcyBvbmUgbGlzdCkgLSBiZXNpZGUgYSBzbWFsbCBtb250aCwgdGhlIGNhbGVuZGFycwovLyBhbmQgdGFzayBsaXN0cyB0byBzaG93IG9yIGhpZGUsIGFuZCB0aGUgdGFza3Mgd2l0aCBubyBkYXRlLiBOYXJyb3csIGFzCi8vIG9uIGEgcGhvbmUsIGl0IGlzIGFsd2F5cyB0aGUgd2VlazogdHdvIGNvbHVtbnMgb2YgZGF5cyB3aXRoIHRoZSBtb250aAovLyBhcyB0aGUgZWlnaHRoIHRpbGUsIHRoZSBzb3VyY2VzIGFzIGEgcm93IG9mIGNoaXBzIGFib3ZlLCBhbmQgdGhlIHRhc2tzCi8vIHdpdGggbm8gZGF0ZSBiZWxvdy4gQSBzd2lwZSBnb2VzIHRvIHRoZSBuZXh0IG9yIHByZXZpb3VzIHdlZWssIGFuZCBhCi8vIGJ1dHRvbiB0dXJucyB0aGUgb3JkZXIgb2YgdGhlIGRheXMgZnJvbSBkb3duLXRoZW4tYWNyb3NzIHRvCi8vIGFjcm9zcy10aGVuLWRvd24uCi8vCi8",
"vIEtleXMsIGFzIGluIEdvb2dsZSBDYWxlbmRhcjogdCB0b2RheSwgaiAvIG4gbmV4dCwgayAvIHAgcHJldmlvdXMsCi8vIHcgLyBtIC8gYSBmb3IgdGhlIHZpZXdzLgovLwovLyBUaGUgYm9hcmQgb3ducyB0aGUgb3ZlcmxheSwgdGhlIGhlYWRlciBhbmQgdGhlIGFjY291bnQgcGFuZWxzOyB0aGlzCi8vIGZpbGUgb3ducyB0aGUgYm9keSB3aGlsZSB0aGUgQ2FsZW5kYXIgdGFiIGlzIHNob3dpbmcuIEl0cyBlbGVtZW50IGlzCi8vIGJ1aWx0IG9uY2UgYW5kIGtlcHQsIGxpa2UgdGhlIG5vdGVzJy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLCB0b2FzdCB9ID0gbnMudWk7CiAgY29uc3QgeyBjYWxlbmRhclN0b3JlOiBzdG9yZSwgaG9va3MsIEFQUF9OQU1FIH0gPSBuczsKICBjb25zdCBjYWwgPSBucy5jYWxlbmRhckxvZ2ljOwoKICBjb25zdCBTVEFMRV9NUyA9IDYwICogMTAwMDsKICBjb25zdCBOQVJST1d",
"fUFggPSA3MjA7CiAgLy8gQSBtb250aCBjZWxsIHNob3dzIHRoaXMgbWFueSwgdGhlbiAiKzIgbW9yZSIuCiAgY29uc3QgTU9OVEhfUk9XUyA9IDQ7CiAgY29uc3QgU1dJUEVfUFggPSA2MDsKCiAgY29uc3QgQyA9IHsKICAgIGN0eDogbnVsbCwgICAgICAgICAgLy8geyByb290LCBvblN0YXRlRXJyb3IsIG9uTG9hZGVkLCBiYXJDaGFuZ2VkLCBwcmVmcywgY29ubmVjdCB9CiAgICB2aWV3OiAnd2VlaycsICAgICAgIC8vIHRoZSB2aWV3IGNob3NlbiBvbiBhIHdpZGUgc2NyZWVuCiAgICBvcmRlcjogJ2Rvd24nLCAgICAgIC8vIG5hcnJvdzogdGhlIGRheXMgZG93biB0aGVuIGFjcm9zcywgb3IgJ2Fjcm9zcycgdGhlbiBkb3duCiAgICBhbmNob3I6ICcnLCAgICAgICAgIC8vIHRoZSBkYXkgaW4gZm9jdXMKICAgIHRvZGF5OiAnJywKICAgIG5hcnJvdzogZmFsc2UsCiAgICBzb3VyY2VzOiBbXSwKICAgIG92ZXJyaWRlczoge30sICAgICAgLy8gc291cmNlIGlkIOKGkiBzaG93biBvciBub3QsIHdoZXJlIGZsaWNrZWQgaGVyZQogICAgcHJlZnNSZWFkOiBmYWxzZSwKICAgIHN0YXR1czogJ2lkbGUnLCAgICAgLy8gaWRsZSB8IGxvYWRpbmcgfCByZWFkeSB8IGVycm9yIHwgc2lnbmluIHwgbWlzbWF0Y2gKICAgIGVycm9yOiAnJywKICAgIGVycm9yczoge30sICAgICAgICAgLy8gc2VydmljZSDihpIgZXJyb3IsIGZvciB0aGUgbm90ZSBhYm92ZSB0aGUgZGF5cwogICAgc2hvd246IG51bGwsICAgICAgICAvLyB7IGtleSwgcmF",
"uZ2UsIGl0ZW1zLCBmZXRjaGVkOiBTZXQsIGVycm9ycywgYXQgfSBvbiBzY3JlZW4KICAgIGNhY2hlOiBuZXcgTWFwKCksICAgLy8gcmFuZ2Uga2V5IOKGkiB0aGUgc2FtZQogICAgbG9hZGluZzogbnVsbCwKICAgIGxvYWRlZEF0OiAwLAogICAgc2VxOiAwLAogICAgcmVjaGVjazogZmFsc2UsICAgICAvLyBBbGxvdyB3YXMgcHJlc3NlZDogcmVhZCBldmVyeXRoaW5nIGFnYWluIG9uIHJldHVybgogIH07CgogIGNvbnN0IGVscyA9IHt9OwogIGxldCB0aW1lRm9ybWF0ID0gbnVsbDsKCiAgLy8g4pSA4pSAIFNldHVwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBpbml0KGN0eCkgewogICAgQy5jdHggPSBjdHg7CiAgICBDLnRvZGF5ID0gY2FsLmRhdGVLZXkobmV3IERhdGUoKSk7CiAgICBDLmFuY2hvciA9IEMudG9kYXk7CiAgICAvLyBCYWNrIGZyb20gR29vZ2xlJ3MgcGVybWlzc2lvbiBwYWdlIChvcGVuZWQgYnkgQWxsb3cpOiByZWFkIGFnYWluLgogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2ZvY3VzJywgKCkgPT4geyBpZiAoQy5yZWNoZWNrKSBsb2FkKCk7IH0pOwogIH0KCiAgZnVuY3Rpb24gZWxlbWVudCgpIHs",
"KICAgIGlmIChlbHMud3JhcCkgcmV0dXJuIGVscy53cmFwOwoKICAgIGNvbnN0IG5hdiA9IChkaXIsIGxhYmVsLCBuYW1lKSA9PiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGl0bGU6IGxhYmVsLCAnYXJpYS1sYWJlbCc6IGxhYmVsLAogICAgICBkYXRhc2V0OiB7IGtleTogYGNhbC0ke25hbWV9YCB9LCBvbmNsaWNrOiAoKSA9PiBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCBkaXIpKSwKICAgIH0sIGljb24obmFtZSwgMjApKTsKCiAgICBlbHMudGl0bGUgPSBoKCdoMicsIHsgY2xhc3M6ICdjYWwtdGl0bGUnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScgfSk7CiAgICBlbHMudmlld3MgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLXZpZXdzJywgcm9sZTogJ3RhYmxpc3QnLCAnYXJpYS1sYWJlbCc6ICdDYWxlbmRhciB2aWV3JyB9LAogICAgICBjYWwuVklFV1MubWFwKHYgPT4gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnc2VnJywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICd0YWInLCBkYXRhc2V0OiB7IGtleTogYGNhbC12aWV3OiR7dn1gLCB2aWV3OiB2IH0sCiAgICAgICAgdGV4dDogdlswXS50b1VwcGVyQ2FzZSgpICsgdi5zbGljZSgxKSwgb25jbGljazogKCkgPT4gc2V0Vmlldyh2KSwKICAgICAgfSkpKTsKICAgIGVscy5oZWFkID0gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1oZWFkJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLW5hdic",
"gfSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2J0biBidG4tb3V0bGluZSBjYWwtdG9kYXknLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1RvZGF5JywgZGF0YXNldDogeyBrZXk6ICdjYWwtdG9kYXknIH0sCiAgICAgICAgICB0aXRsZTogJ1RvZGF5IChUKScsIG9uY2xpY2s6ICgpID0-IGdvKGNhbC5kYXRlS2V5KG5ldyBEYXRlKCkpKSwKICAgICAgICB9KSwKICAgICAgICBuYXYoLTEsICdQcmV2aW91cycsICdwcmV2JyksCiAgICAgICAgbmF2KDEsICdOZXh0JywgJ25leHQnKSwKICAgICAgICAvLyBOYXJyb3cgb25seTogd2hpY2ggd2F5IHRoZSBkYXlzIHJ1biBpbiB0aGUgdHdvIGNvbHVtbnMuCiAgICAgICAgZWxzLm9yZGVyID0gaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0biBjYWwtb3JkZXInLCB0eXBlOiAnYnV0dG9uJywgZGF0YXNldDogeyBrZXk6ICdjYWwtb3JkZXInIH0sIG9uY2xpY2s6IHRvZ2dsZU9yZGVyLAogICAgICAgIH0pKSwKICAgICAgZWxzLnRpdGxlLAogICAgICBlbHMudmlld3MpOwoKICAgIGVscy5ub3RlID0gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1ub3RlJywgcm9sZTogJ3N0YXR1cycgfSk7CiAgICBlbHMubWluaSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtbWluaScgfSk7CiAgICBlbHMuc291cmNlcyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtc291cmNlcycsIHJvbGU6ICdncm91cCcsICdhcmlhLWxhYmVsJzogJ0NhbGVuZGFycyB",
"hbmQgdGFzayBsaXN0cycgfSk7CiAgICBlbHMudHJheSA9IGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiAnY2FsLXRyYXknLCAnYXJpYS1sYWJlbCc6ICdUYXNrcyB3aXRob3V0IGEgZGF5JyB9KTsKICAgIGVscy5tYWluID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdjYWwtbWFpbicgfSk7CiAgICBlbHMubWFpbi5hZGRFdmVudExpc3RlbmVyKCd0b3VjaHN0YXJ0Jywgb25Ub3VjaFN0YXJ0LCB7IHBhc3NpdmU6IHRydWUgfSk7CiAgICBlbHMubWFpbi5hZGRFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIG9uVG91Y2hFbmQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTsKCiAgICBlbHMud3JhcCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwnIH0sCiAgICAgIGVscy5oZWFkLAogICAgICBlbHMubm90ZSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2NhbC1ib2R5JyB9LAogICAgICAgIGgoJ2FzaWRlJywgeyBjbGFzczogJ2NhbC1zaWRlJyB9LCBlbHMubWluaSwgZWxzLnNvdXJjZXMsIGVscy50cmF5KSwKICAgICAgICBlbHMubWFpbikpOwoKICAgIC8vIE5hcnJvdyBvciB3aWRlIGlzIGFib3V0IHRoZSBzcGFjZSB0aGUgdmlldyBoYXMsIG5vdCB0aGUgc2NyZWVuLgogICAgLy8gR29pbmcgbmFycm93IGNhbiBjaGFuZ2UgdGhlIHZpZXcgKHRvIHRoZSB3ZWVrKSwgYW5kIHNvIHRoZSBkYXlzLgogICAgbmV3IFJlc2l6ZU9ic2VydmVyKGVudHJpZXMgPT4gewogICAgICBjb25zdCBuYXJyb3cgPSBlbnRyaWVzWzBdLmNvbnRlbnRSZWN0LndpZHR",
"oIDwgTkFSUk9XX1BYOwogICAgICBpZiAobmFycm93ID09PSBDLm5hcnJvdykgcmV0dXJuOwogICAgICBjb25zdCBiZWZvcmUgPSByYW5nZUtleShyYW5nZSgpKTsKICAgICAgQy5uYXJyb3cgPSBuYXJyb3c7CiAgICAgIGlmIChyYW5nZUtleShyYW5nZSgpKSAhPT0gYmVmb3JlICYmIChDLnN0YXR1cyA9PT0gJ3JlYWR5JyB8fCBDLnN0YXR1cyA9PT0gJ2xvYWRpbmcnKSkgbG9hZCgpOwogICAgICBlbHNlIGRyYXcoKTsKICAgIH0pLm9ic2VydmUoZWxzLndyYXApOwoKICAgIGRyYXcoKTsKICAgIHJldHVybiBlbHMud3JhcDsKICB9CgogIC8vIEEgbmFycm93IHZpZXcgaXMgYWx3YXlzIHRoZSB3ZWVrLgogIGZ1bmN0aW9uIHZpZXcoKSB7CiAgICByZXR1cm4gQy5uYXJyb3cgPyAnd2VlaycgOiBDLnZpZXc7CiAgfQoKICBmdW5jdGlvbiByYW5nZSgpIHsKICAgIHJldHVybiBjYWwudmlld1JhbmdlKHZpZXcoKSwgQy5hbmNob3IpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFByZWZzKCkgewogICAgaWYgKEMucHJlZnNSZWFkKSByZXR1cm47CiAgICBDLnByZWZzUmVhZCA9IHRydWU7CiAgICB0cnkgewogICAgICBjb25zdCBbdiwgbywgb3JkZXJdID0gYXdhaXQgUHJvbWlzZS5hbGwoWydjYWxlbmRhclZpZXcnLCAnY2FsZW5kYXJTb3VyY2VzJywgJ2NhbGVuZGFyT3JkZXInXS5tYXAobiA9PiBDLmN0eC5wcmVmcy5nZXQobikpKTsKICAgICAgaWYgKGNhbC5WSUVXUy5pbmNsdWRlcyh2KSkgQy52aWV3ID0gdjsKICAgICA",
"gaWYgKG8gJiYgdHlwZW9mIG8gPT09ICdvYmplY3QnKSBDLm92ZXJyaWRlcyA9IG87CiAgICAgIGlmIChvcmRlciA9PT0gJ2Fjcm9zcycgfHwgb3JkZXIgPT09ICdkb3duJykgQy5vcmRlciA9IG9yZGVyOwogICAgfSBjYXRjaCB7IC8qIHN0b3JhZ2UgZ29uZSAoZXh0ZW5zaW9uIHJlbG9hZGVkKTsgZGVmYXVsdHMgd2lsbCBkbyAqLyB9CiAgfQoKICBmdW5jdGlvbiBzYXZlUHJlZihuYW1lLCB2YWx1ZSkgewogICAgUHJvbWlzZS5yZXNvbHZlKCkudGhlbigoKSA9PiBDLmN0eC5wcmVmcy5zZXQobmFtZSwgdmFsdWUpKS5jYXRjaCgoKSA9PiB7fSk7CiAgfQoKICAvLyDilIDilIAgTG9hZGluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgaXNPbiA9IHMgPT4gY2FsLmlzT24ocywgQy5vdmVycmlkZXMpOwogIGNvbnN0IG9uU291cmNlcyA9ICgpID0-IEMuc291cmNlcy5maWx0ZXIoaXNPbik7CiAgY29uc3QgcmFuZ2VLZXkgPSByID0-IGAke3Iuc3RhcnR9fCR7ci5lbmR9YDsKCiAgLy8gV2hhdCBpcyBvbiBzY3JlZW4gY292ZXJzIHRoZSByYW5nZSBhbmQgZXZlcnkgc291cmNlIHRoYXQgaXMgb24uCiAgZnVuY3Rpb24gY292ZXJzKGVudHJ5KSB",
"7CiAgICByZXR1cm4gISFlbnRyeSAmJiBvblNvdXJjZXMoKS5ldmVyeShzID0-IGVudHJ5LmZldGNoZWQuaGFzKHMuaWQpKTsKICB9CgogIGZ1bmN0aW9uIGlzU3RhbGUoKSB7CiAgICBjb25zdCBlbnRyeSA9IEMuY2FjaGUuZ2V0KHJhbmdlS2V5KHJhbmdlKCkpKTsKICAgIHJldHVybiBDLnJlY2hlY2sgfHwgQy5zdGF0dXMgIT09ICdyZWFkeScgfHwgIWNvdmVycyhlbnRyeSkgfHwgRGF0ZS5ub3coKSAtIGVudHJ5LmF0ID4gU1RBTEVfTVM7CiAgfQoKICAvLyBTaG93cyB3aGF0ZXZlciBpcyBjYWNoZWQgZm9yIHRoZSByYW5nZSBhdCBvbmNlLCB0aGVuIHJlYWRzIEdvb2dsZQogIC8vIGlmIHRoYXQgaXMgbWlzc2luZywgb2xkIG9yIHNob3J0IG9mIGEgc291cmNlIHRoYXQgaGFzIGJlZW4gc3dpdGNoZWQKICAvLyBvbi4gQSBuZXdlciBsb2FkICh0aGUgbmV4dCB3ZWVrLCB0YXBwZWQgcXVpY2tseSkgb3ZlcnRha2VzIHRoaXMgb25lLgogIGZ1bmN0aW9uIGxvYWQoeyBmb3JjZSA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKCFlbHMud3JhcCkgZWxlbWVudCgpOwogICAgLy8gVGhlIHZpZXcgY2hvc2VuIGxhc3QgdGltZSBkZWNpZGVzIHdoaWNoIGRheXMgdG8gcmVhZC4KICAgIGlmICghQy5wcmVmc1JlYWQpIHJldHVybiByZWFkUHJlZnMoKS50aGVuKCgpID0-IGxvYWQoeyBmb3JjZSB9KSk7CiAgICAvLyBQZXJtaXNzaW9uIG1heSBoYXZlIGJlZW4gZ2l2ZW4gc2luY2U6IG5vdGhpbmcgY2FjaGVkIGNvdW50cy4KICAgIGl",
"mIChDLnJlY2hlY2spIHsKICAgICAgQy5yZWNoZWNrID0gZmFsc2U7CiAgICAgIGZvcmNlID0gdHJ1ZTsKICAgICAgQy5jYWNoZS5jbGVhcigpOwogICAgICBzdG9yZS5mb3JnZXQoKTsKICAgIH0KICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgY29uc3Qga2V5ID0gcmFuZ2VLZXkocik7CiAgICBjb25zdCBjYWNoZWQgPSBDLmNhY2hlLmdldChrZXkpOwogICAgaWYgKGNhY2hlZCkgewogICAgICBDLnNob3duID0gY2FjaGVkOwogICAgICBpZiAoQy5zdGF0dXMgPT09ICdpZGxlJykgQy5zdGF0dXMgPSAncmVhZHknOwogICAgfQogICAgZHJhdygpOwogICAgaWYgKCFmb3JjZSAmJiAhaXNTdGFsZSgpKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7CgogICAgY29uc3Qgc2VxID0gKytDLnNlcTsKICAgIGlmICghQy5zaG93biB8fCBDLnNob3duLmtleSAhPT0ga2V5KSBDLnNob3duID0gbnVsbDsKICAgIGlmICghQy5zaG93biAmJiBDLnN0YXR1cyAhPT0gJ3NpZ25pbicgJiYgQy5zdGF0dXMgIT09ICdtaXNtYXRjaCcpIEMuc3RhdHVzID0gJ2xvYWRpbmcnOwogICAgZHJhdygpOwoKICAgIGNvbnN0IHJ1biA9IChhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgYWNjb3VudCA9IGhvb2tzLmdldEFjY291bnQoKTsKICAgICAgICBjb25zdCBnb3QgPSBhd2FpdCBzdG9yZS5sb2FkU291cmNlcyhhY2NvdW50LCB7IGZvcmNlIH0pOwogICAgICAgIEMuc291cmNlcyA9IGdvdC5zb3VyY2VzOwogICAgICAgIGN",
"vbnN0IHdhbnRlZCA9IG9uU291cmNlcygpOwogICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN0b3JlLmxvYWRSYW5nZShyLCB3YW50ZWQpOwogICAgICAgIGlmIChzZXEgIT09IEMuc2VxKSByZXR1cm47CiAgICAgICAgY29uc3QgZW50cnkgPSB7CiAgICAgICAgICBrZXksIHJhbmdlOiByLCBpdGVtczogcmVzdWx0Lml0ZW1zLCBhdDogRGF0ZS5ub3coKSwKICAgICAgICAgIGZldGNoZWQ6IG5ldyBTZXQod2FudGVkLm1hcChzID0-IHMuaWQpKSwKICAgICAgICAgIGVycm9yczogT2JqZWN0LmFzc2lnbih7fSwgZ290LmVycm9ycywgcmVzdWx0LmVycm9ycyksCiAgICAgICAgfTsKICAgICAgICBDLmNhY2hlLnNldChrZXksIGVudHJ5KTsKICAgICAgICBDLnNob3duID0gZW50cnk7CiAgICAgICAgQy5lcnJvcnMgPSBlbnRyeS5lcnJvcnM7CiAgICAgICAgQy5zdGF0dXMgPSAncmVhZHknOwogICAgICAgIEMuZXJyb3IgPSAnJzsKICAgICAgICBDLmxvYWRlZEF0ID0gRGF0ZS5ub3coKTsKICAgICAgICBpZiAoQy5jdHgub25Mb2FkZWQpIEMuY3R4Lm9uTG9hZGVkKCk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGlmIChzZXEgIT09IEMuc2VxKSByZXR1cm47CiAgICAgICAgaWYgKGVyci5jb2RlID09PSAnY2FsZW5kYXJfYXV0aF9yZXF1aXJlZCcpIEMuc3RhdHVzID0gJ3NpZ25pbic7CiAgICAgICAgZWxzZSBpZiAoZXJyLmNvZGUgPT09ICdjYWxlbmRhcl9taXNtYXRjaCcpIHsgQy5zdGF0dXMgPSAnbWlzbWF",
"0Y2gnOyBDLmVycm9yID0gZXJyLm1lc3NhZ2U7IH0KICAgICAgICBlbHNlIGlmIChlcnIuY29kZSA9PT0gJ25vdF9jb25maWd1cmVkJykgewogICAgICAgICAgLy8gTm8gY2xpZW50IElEIGF0IGFsbDogdGhlIGJvYXJkJ3Mgc2V0dXAgcGFuZWwgc2F5cyB3aGF0IHRvIGRvLgogICAgICAgICAgQy5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgICBDLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgICAgICB9IGVsc2UgaWYgKEMuc2hvd24pIHsKICAgICAgICAgIEMuc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgICAgIHRvYXN0KEMuY3R4LnJvb3QsIGBDb3VsZG7igJl0IGxvYWQgdGhlIGNhbGVuZGFyOiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgQy5zdGF0dXMgPSAnZXJyb3InOwogICAgICAgICAgQy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgICAgIH0KICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBpZiAoQy5sb2FkaW5nID09PSBydW4pIEMubG9hZGluZyA9IG51bGw7CiAgICAgICAgZHJhdygpOwogICAgICAgIEMuY3R4LmJhckNoYW5nZWQoKTsKICAgICAgfQogICAgfSkoKTsKICAgIEMubG9hZGluZyA9IHJ1bjsKICAgIEMuY3R4LmJhckNoYW5nZWQoKTsKICAgIHJldHVybiBydW47CiAgfQoKICBhc3luYyBmdW5jdGlvbiBjb25uZWN0KGJ0bikgewogICAgaWYgKGJ0bikgYnRuLmRpc2FibGVkID0gdHJ1ZTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IEM",
"uY3R4LmNvbm5lY3QoKTsKICAgICAgQy5zdGF0dXMgPSAnbG9hZGluZyc7CiAgICAgIHN0b3JlLmZvcmdldCgpOwogICAgICBhd2FpdCBsb2FkKHsgZm9yY2U6IHRydWUgfSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKGVyci5jb2RlID09PSAnY2FsZW5kYXJfbWlzbWF0Y2gnKSB7CiAgICAgICAgQy5zdGF0dXMgPSAnbWlzbWF0Y2gnOwogICAgICAgIEMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgICBkcmF3KCk7CiAgICAgIH0gZWxzZSBpZiAoZXJyLmNvZGUgPT09ICdub3RfY29uZmlndXJlZCcpIHsKICAgICAgICBDLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgICAgfSBlbHNlIHsKICAgICAgICB0b2FzdChDLmN0eC5yb290LCBgQ291bGRu4oCZdCBjb25uZWN0OiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgfQogICAgfSBmaW5hbGx5IHsKICAgICAgaWYgKGJ0biAmJiBidG4uaXNDb25uZWN0ZWQpIGJ0bi5kaXNhYmxlZCA9IGZhbHNlOwogICAgfQogIH0KCiAgLy8g4pSA4pSAIE1vdmluZyBhYm91dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gZ28oYW5jaG9yKSB7CiAgICBpZiAoIWNhbC5pc0tleShhbmN",
"ob3IpKSByZXR1cm47CiAgICBDLmFuY2hvciA9IGFuY2hvcjsKICAgIEMudG9kYXkgPSBjYWwuZGF0ZUtleShuZXcgRGF0ZSgpKTsKICAgIGxvYWQoKTsKICB9CgogIC8vIEluIHR3byBjb2x1bW5zLCB0aGUgZGF5cyBydW4gZG93biB0aGVuIGFjcm9zcyAoTW9uZGF5IHRvIFRodXJzZGF5IG9uCiAgLy8gdGhlIGxlZnQpLCBvciBhY3Jvc3MgdGhlbiBkb3duIChNb25kYXkgYmVzaWRlIFR1ZXNkYXkpLgogIGZ1bmN0aW9uIHRvZ2dsZU9yZGVyKCkgewogICAgQy5vcmRlciA9IEMub3JkZXIgPT09ICdhY3Jvc3MnID8gJ2Rvd24nIDogJ2Fjcm9zcyc7CiAgICBzYXZlUHJlZignY2FsZW5kYXJPcmRlcicsIEMub3JkZXIpOwogICAgZHJhdygpOwogIH0KCiAgZnVuY3Rpb24gc2V0Vmlldyh2KSB7CiAgICBpZiAoIWNhbC5WSUVXUy5pbmNsdWRlcyh2KSkgcmV0dXJuOwogICAgQy52aWV3ID0gdjsKICAgIHNhdmVQcmVmKCdjYWxlbmRhclZpZXcnLCB2KTsKICAgIGxvYWQoKTsKICB9CgogIGZ1bmN0aW9uIHRvZ2dsZVNvdXJjZShzKSB7CiAgICBDLm92ZXJyaWRlcyA9IE9iamVjdC5hc3NpZ24oe30sIEMub3ZlcnJpZGVzLCB7IFtzLmlkXTogIWlzT24ocykgfSk7CiAgICBzYXZlUHJlZignY2FsZW5kYXJTb3VyY2VzJywgQy5vdmVycmlkZXMpOwogICAgLy8gU3dpdGNoZWQgb2ZmOiBqdXN0IGhpZGRlbi4gU3dpdGNoZWQgb24gYW5kIG5vdCByZWFkIHlldDogcmVhZCBub3cuCiAgICBpZiAoY292ZXJzKEMuc2hvd24pKSBkcmF3KCk",
"7CiAgICBlbHNlIGxvYWQoKTsKICB9CgogIGxldCB0b3VjaCA9IG51bGw7CiAgZnVuY3Rpb24gb25Ub3VjaFN0YXJ0KGUpIHsKICAgIGlmICghQy5uYXJyb3cgfHwgZS50b3VjaGVzLmxlbmd0aCAhPT0gMSkgeyB0b3VjaCA9IG51bGw7IHJldHVybjsgfQogICAgdG91Y2ggPSB7IHg6IGUudG91Y2hlc1swXS5jbGllbnRYLCB5OiBlLnRvdWNoZXNbMF0uY2xpZW50WSB9OwogIH0KICBmdW5jdGlvbiBvblRvdWNoRW5kKGUpIHsKICAgIGlmICghdG91Y2ggfHwgIWUuY2hhbmdlZFRvdWNoZXMubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBkeCA9IGUuY2hhbmdlZFRvdWNoZXNbMF0uY2xpZW50WCAtIHRvdWNoLng7CiAgICBjb25zdCBkeSA9IGUuY2hhbmdlZFRvdWNoZXNbMF0uY2xpZW50WSAtIHRvdWNoLnk7CiAgICB0b3VjaCA9IG51bGw7CiAgICBpZiAoTWF0aC5hYnMoZHgpID4gU1dJUEVfUFggJiYgTWF0aC5hYnMoZHgpID4gMS41ICogTWF0aC5hYnMoZHkpKSBnbyhjYWwuc3RlcCgnd2VlaycsIEMuYW5jaG9yLCBkeCA8IDAgPyAxIDogLTEpKTsKICB9CgogIC8vIOKUgOKUgCBEcmF3aW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBUaHJvdWd",
"oIHRoZSBzdHlsZSBBUEksIG5vdCBhIHN0eWxlIGF0dHJpYnV0ZTogYSBwYWdlJ3Mgc2VjdXJpdHkKICAvLyBwb2xpY3kgbWF5IHJlZnVzZSBpbmxpbmUgc3R5bGUgYXR0cmlidXRlcywgbmV2ZXIgdGhpcy4KICBmdW5jdGlvbiB0aW50KGVsLCBuYW1lLCB2YWx1ZSkgewogICAgaWYgKHZhbHVlKSBlbC5zdHlsZS5zZXRQcm9wZXJ0eShuYW1lLCB2YWx1ZSk7CiAgICByZXR1cm4gZWw7CiAgfQoKICBmdW5jdGlvbiBkcmF3KCkgewogICAgaWYgKCFlbHMud3JhcCkgcmV0dXJuOwogICAgLy8gUmVkcmF3aW5nIHJlcGxhY2VzIHRoZSBjaGlwcyBhbmQgdGhlIHNtYWxsIG1vbnRoOyB3aGljaGV2ZXIgb2YgdGhlbQogICAgLy8gaGFkIHRoZSBmb2N1cyBnZXRzIGl0IGJhY2ssIG9yIHRoZSBuZXh0IGtleSB3b3VsZCBnbyB0byBHbWFpbC4KICAgIGNvbnN0IGFjdGl2ZSA9IEMuY3R4LnJvb3QuYWN0aXZlRWxlbWVudDsKICAgIGNvbnN0IGtleSA9IGFjdGl2ZSAmJiBlbHMud3JhcC5jb250YWlucyhhY3RpdmUpICYmIGFjdGl2ZS5kYXRhc2V0ID8gYWN0aXZlLmRhdGFzZXQua2V5IHx8ICcnIDogJyc7CiAgICBwYWludCgpOwogICAgaWYgKGtleSAmJiAhZWxzLndyYXAuY29udGFpbnMoQy5jdHgucm9vdC5hY3RpdmVFbGVtZW50KSkgewogICAgICBjb25zdCBhZ2FpbiA9IFsuLi5lbHMud3JhcC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1rZXldJyldLmZpbmQoeCA9PiB4LmRhdGFzZXQua2V5ID09PSBrZXkgJiYgeC5nZXRDbGllbnR",
"SZWN0cygpLmxlbmd0aCk7CiAgICAgIGlmIChhZ2FpbikgYWdhaW4uZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcGFpbnQoKSB7CiAgICBjb25zdCB2ID0gdmlldygpOwogICAgZWxzLndyYXAuZGF0YXNldC5uYXJyb3cgPSBTdHJpbmcoQy5uYXJyb3cpOwogICAgZWxzLndyYXAuZGF0YXNldC52aWV3ID0gdjsKICAgIGVscy53cmFwLmRhdGFzZXQub3JkZXIgPSBDLm9yZGVyOwogICAgY29uc3QgYWNyb3NzID0gQy5vcmRlciA9PT0gJ2Fjcm9zcyc7CiAgICBlbHMub3JkZXIucmVwbGFjZUNoaWxkcmVuKGljb24oYWNyb3NzID8gJ3Jvd3MnIDogJ2NvbHVtbnMnLCAyMCkpOwogICAgZWxzLm9yZGVyLnRpdGxlID0gYWNyb3NzID8gJ0RheXMgcnVuIGFjcm9zcywgdGhlbiBkb3duLiBUYXAgZm9yIGRvd24sIHRoZW4gYWNyb3NzLicgOiAnRGF5cyBydW4gZG93biwgdGhlbiBhY3Jvc3MuIFRhcCBmb3IgYWNyb3NzLCB0aGVuIGRvd24uJzsKICAgIGVscy5vcmRlci5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBlbHMub3JkZXIudGl0bGUpOwogICAgZWxzLnRpdGxlLnRleHRDb250ZW50ID0gY2FsLnRpdGxlKHYsIEMuYW5jaG9yLCBDLnRvZGF5KTsKICAgIGZvciAoY29uc3QgYiBvZiBlbHMudmlld3MuY2hpbGRyZW4pIGIuc2V0QXR0cmlidXRlKCdhcmlhLXNlbGVjdGVkJywgU3RyaW5nKGIuZGF0YXNldC52aWV3ID09PSB2KSk7CiAgICBjb25zdCBwYW5lbCA9IHN0YXR1c1B",
"hbmVsKCk7CiAgICBlbHMud3JhcC5jbGFzc0xpc3QudG9nZ2xlKCdjYWwtcGFuZWwnLCAhIXBhbmVsKTsKICAgIGRyYXdOb3RlKCk7CiAgICBkcmF3TWluaSgpOwogICAgZHJhd1NvdXJjZXMoKTsKICAgIGRyYXdUcmF5KCk7CiAgICBpZiAocGFuZWwpIGVscy5tYWluLnJlcGxhY2VDaGlsZHJlbihwYW5lbCk7CiAgICBlbHNlIGlmICh2ID09PSAnbW9udGgnKSBlbHMubWFpbi5yZXBsYWNlQ2hpbGRyZW4oZHJhd01vbnRoKCkpOwogICAgZWxzZSBpZiAodiA9PT0gJ2FnZW5kYScpIGVscy5tYWluLnJlcGxhY2VDaGlsZHJlbihkcmF3QWdlbmRhKCkpOwogICAgZWxzZSBlbHMubWFpbi5yZXBsYWNlQ2hpbGRyZW4oZHJhd1dlZWsoKSk7CiAgfQoKICAvLyBXaGF0IGlzIG9uLCBmcm9tIHRoZSBzb3VyY2VzIHRoYXQgYXJlIG9uLCBieSBkYXkuCiAgZnVuY3Rpb24gdmlzaWJsZUl0ZW1zKCkgewogICAgaWYgKCFDLnNob3duKSByZXR1cm4gW107CiAgICBjb25zdCBvbiA9IG5ldyBTZXQob25Tb3VyY2VzKCkubWFwKHMgPT4gcy5pZCkpOwogICAgcmV0dXJuIEMuc2hvd24uaXRlbXMuZmlsdGVyKHggPT4gb24uaGFzKHguc291cmNlKSk7CiAgfQoKICBmdW5jdGlvbiBzdGF0dXNQYW5lbCgpIHsKICAgIHN3aXRjaCAoQy5zdGF0dXMpIHsKICAgICAgY2FzZSAnc2lnbmluJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2NhbGVuZGFyJywgJ0Nvbm5lY3QgR29vZ2xlIENhbGVuZGFyJywKICAgICAgICAgIGBTZWUgeW91ciBHb29nbGUgQ2F",
"sZW5kYXIgYW5kIEdvb2dsZSBUYXNrcyBoZXJlLCBiZXNpZGUgdGhlIGJvYXJkIGFuZCB0aGUgbm90ZXMuICR7QVBQX05BTUV9IG9ubHkgcmVhZHMgdGhlbS4gR29vZ2xlIHdpbGwgYXNrIHlvdSB0byBhbGxvdyBpdC5gLAogICAgICAgICAgQy5jdHguY29ubmVjdCA_IFtidXR0b24oJ0Nvbm5lY3QgR29vZ2xlIENhbGVuZGFyJywgJ3ByaW1hcnknLCBjb25uZWN0KV0gOiBbXSk7CiAgICAgIGNhc2UgJ21pc21hdGNoJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2NhbGVuZGFyJywgJ1RoYXQgd2FzIGEgZGlmZmVyZW50IGFjY291bnQnLCBgJHtDLmVycm9yfSBDb25uZWN0IGFnYWluIGFuZCBjaG9vc2UgJHtob29rcy5nZXRBY2NvdW50KCl9LmAsCiAgICAgICAgICBDLmN0eC5jb25uZWN0ID8gW2J1dHRvbignQ29ubmVjdCBhZ2FpbicsICdwcmltYXJ5JywgY29ubmVjdCldIDogW10pOwogICAgICBjYXNlICdlcnJvcic6CiAgICAgICAgcmV0dXJuIHBhbmVsKCdyZWZyZXNoJywgJ0NvdWxkbuKAmXQgbG9hZCB0aGUgY2FsZW5kYXInLCBDLmVycm9yLAogICAgICAgICAgW2J1dHRvbignVHJ5IGFnYWluJywgJ3ByaW1hcnknLCAoKSA9PiBsb2FkKHsgZm9yY2U6IHRydWUgfSkpXSk7CiAgICAgIGRlZmF1bHQ6CiAgICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBwYW5lbChpY29uTmFtZSwgdGl0bGUsIHRleHQsIGFjdGlvbnMpIHsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAncGFuZWwnLCByb2x",
"lOiAncmVnaW9uJywgJ2FyaWEtbGFiZWwnOiB0aXRsZSB9LAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3BhbmVsLWljb24nIH0sIGljb24oaWNvbk5hbWUsIDI4KSksCiAgICAgIGgoJ2gyJywgeyB0ZXh0OiB0aXRsZSB9KSwKICAgICAgaCgncCcsIHt9LCBsaW5rZWQodGV4dCkpLAogICAgICBhY3Rpb25zLmxlbmd0aCA_IGgoJ2RpdicsIHsgY2xhc3M6ICdhY3Rpb25zJyB9LCBhY3Rpb25zKSA6IG51bGwpOwogIH0KCiAgZnVuY3Rpb24gYnV0dG9uKGxhYmVsLCBraW5kLCBvbkNsaWNrKSB7CiAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogWydidG4nLCBgYnRuLSR7a2luZH1gXSwgdHlwZTogJ2J1dHRvbicsIHRleHQ6IGxhYmVsLAogICAgICBvbmNsaWNrOiBlID0-IG9uQ2xpY2soZS5jdXJyZW50VGFyZ2V0KSwKICAgIH0pOwogIH0KCiAgLy8gR29vZ2xlJ3MgbWVzc2FnZXMgY2FycnkgdGhlIGxpbmsgdGhhdCBmaXhlcyB0aGVtICgiZW5hYmxlIGl0IGJ5CiAgLy8gdmlzaXRpbmcgaHR0cHM6Ly9jb25zb2xl4oCmIik6IG1ha2UgaXQgb25lLgogIGZ1bmN0aW9uIGxpbmtlZCh0ZXh0KSB7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBsYXN0ID0gMDsKICAgIGNvbnN0IHJlID0gL2h0dHBzOlwvXC9bXlxzPD4iXStbXlxzPD4iLiwpXS9nOwogICAgbGV0IG07CiAgICB3aGlsZSAoKG0gPSByZS5leGVjKFN0cmluZyh0ZXh0KSkpKSB7CiAgICAgIG91dC5wdXNoKHRleHQuc2xpY2UobGFzdCwgbS5",
"pbmRleCksIGgoJ2EnLCB7IGhyZWY6IG1bMF0sIHRhcmdldDogJ19ibGFuaycsIHJlbDogJ25vb3BlbmVyIG5vcmVmZXJyZXInLCB0ZXh0OiBtWzBdIH0pKTsKICAgICAgbGFzdCA9IG0uaW5kZXggKyBtWzBdLmxlbmd0aDsKICAgIH0KICAgIG91dC5wdXNoKFN0cmluZyh0ZXh0KS5zbGljZShsYXN0KSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gQSBsaW5lIGFib3ZlIHRoZSBkYXlzIGZvciBhIHNlcnZpY2UgdGhhdCBjb3VsZCBub3QgYmUgcmVhZC4gTm90CiAgLy8gYWxsb3dlZCBpcyBvbmUgbGluZSBmb3IgYm90aCwgd2l0aCB0aGUgd2F5IHRvIGFsbG93IGl0OiBpbiBDaHJvbWUsCiAgLy8gY29ubmVjdGluZyBhZ2FpbjsgaW4gdGhlIHBob25lIGFwcCwgR29vZ2xlJ3MgcGFnZSBmb3IgdGhlIHNjcmlwdC4KICBmdW5jdGlvbiBkcmF3Tm90ZSgpIHsKICAgIGNvbnN0IGxpbmVzID0gW107CiAgICBpZiAoIXN0YXR1c1BhbmVsKCkpIHsKICAgICAgY29uc3QgbmFtZSA9IHNlcnZpY2UgPT4gKHNlcnZpY2UgPT09ICd0YXNrcycgPyAnR29vZ2xlIFRhc2tzJyA6ICdHb29nbGUgQ2FsZW5kYXInKTsKICAgICAgY29uc3QgZXJyb3JzID0gT2JqZWN0LmVudHJpZXMoQy5lcnJvcnMgfHwge30pOwogICAgICBjb25zdCBkZW5pZWQgPSBlcnJvcnMuZmlsdGVyKChbLCBlcnJdKSA9PiBlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX3Njb3BlJyk7CiAgICAgIGlmIChkZW5pZWQubGVuZ3RoKSB7CiAgICAgICAgY29uc3QgdXJsID0gKGR",
"lbmllZC5maW5kKChbLCBlcnJdKSA9PiBlcnIuYWxsb3dVcmwpIHx8IFtdKVsxXTsKICAgICAgICBjb25zdCBmaXggPSBDLmN0eC5jb25uZWN0ID8gYnV0dG9uKCdDb25uZWN0IGFnYWluJywgJ3RleHQnLCBjb25uZWN0KQogICAgICAgICAgOiB1cmwgPyBoKCdhJywgewogICAgICAgICAgICBjbGFzczogJ2J0biBidG4tdGV4dCcsIGhyZWY6IHVybC5hbGxvd1VybCwgdGFyZ2V0OiAnX2JsYW5rJywgcmVsOiAnbm9vcGVuZXIgbm9yZWZlcnJlcicsIHRleHQ6ICdBbGxvdycsCiAgICAgICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWFsbG93JyB9LCBvbmNsaWNrOiAoKSA9PiB7IEMucmVjaGVjayA9IHRydWU7IH0sCiAgICAgICAgICB9KQogICAgICAgICAgOiBoKCdzcGFuJywgeyB0ZXh0OiAnIEluIHRoZSBzY3JpcHQgZWRpdG9yLCBydW4gYWxsb3dDYWxlbmRhciBvbmNlLicgfSk7CiAgICAgICAgbGluZXMucHVzaChoKCdwJywge30sCiAgICAgICAgICBoKCdzdHJvbmcnLCB7IHRleHQ6IGRlbmllZC5tYXAoKFtzZXJ2aWNlXSkgPT4gbmFtZShzZXJ2aWNlKSkuam9pbignIGFuZCAnKSB9KSwKICAgICAgICAgIGAgJHtkZW5pZWQubGVuZ3RoID4gMSA_ICduZWVkJyA6ICduZWVkcyd9IHlvdXIgcGVybWlzc2lvbi4gYCwgZml4KSk7CiAgICAgIH0KICAgICAgZm9yIChjb25zdCBbc2VydmljZSwgZXJyXSBvZiBlcnJvcnMpIHsKICAgICAgICBpZiAoZXJyLmNvZGUgPT09ICdjYWxlbmRhcl9zY29wZScpIGNvbnRpbnVlOwo",
"gICAgICAgIGxpbmVzLnB1c2goaCgncCcsIHt9LCBoKCdzdHJvbmcnLCB7IHRleHQ6IGAke25hbWUoc2VydmljZSl9OiBgIH0pLCBsaW5rZWQoZXJyLm1lc3NhZ2UgfHwgU3RyaW5nKGVycikpKSk7CiAgICAgIH0KICAgIH0KICAgIGVscy5ub3RlLnJlcGxhY2VDaGlsZHJlbiguLi5saW5lcyk7CiAgICBlbHMubm90ZS5oaWRkZW4gPSAhbGluZXMubGVuZ3RoOwogIH0KCiAgZnVuY3Rpb24gZHJhd1NvdXJjZXMoKSB7CiAgICBjb25zdCBsaXN0ID0gQy5zb3VyY2VzOwogICAgZWxzLnNvdXJjZXMuaGlkZGVuID0gIWxpc3QubGVuZ3RoIHx8ICEhc3RhdHVzUGFuZWwoKTsKICAgIGVscy5zb3VyY2VzLnJlcGxhY2VDaGlsZHJlbiguLi5saXN0Lm1hcChzID0-IHRpbnQoaCgnYnV0dG9uJywgewogICAgICBjbGFzczogWydzcmMnLCBgc3JjLSR7cy5raW5kfWBdLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtcHJlc3NlZCc6IFN0cmluZyhpc09uKHMpKSwKICAgICAgdGl0bGU6IGAke2lzT24ocykgPyAnSGlkZScgOiAnU2hvdyd9ICR7cy5uYW1lfWAsIGRhdGFzZXQ6IHsga2V5OiBgY2FsLXNyYzoke3MuaWR9YCB9LAogICAgICBvbmNsaWNrOiAoKSA9PiB0b2dnbGVTb3VyY2UocyksCiAgICB9LCBoKCdzcGFuJywgeyBjbGFzczogJ3N3YXRjaCcsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KSwgaCgnc3BhbicsIHsgY2xhc3M6ICdzcmMtbmFtZScsIHRleHQ6IHMubmFtZSB9KSksICctLXNyYycsIHMuY29sb3VyKSkpOwogIH0KCiAgLy8",
"gT3ZlcmR1ZSB0YXNrcyBhbHJlYWR5IG9uIGEgZGF5IG9uIHNjcmVlbiBhcmUgbm90IGxpc3RlZCB0d2ljZS4KICBmdW5jdGlvbiBkcmF3VHJheSgpIHsKICAgIGNvbnN0IHBhbmVsVXAgPSAhIXN0YXR1c1BhbmVsKCk7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IHQgPSBjYWwudHJheSh2aXNpYmxlSXRlbXMoKSwgQy50b2RheSk7CiAgICB0Lm92ZXJkdWUgPSB0Lm92ZXJkdWUuZmlsdGVyKHggPT4geC5kdWUgPCByLnN0YXJ0IHx8IHguZHVlID49IHIuZW5kKTsKICAgIGNvbnN0IGdyb3VwID0gKGxhYmVsLCBsaXN0KSA9PiAobGlzdC5sZW5ndGggPyBbCiAgICAgIGgoJ2gzJywge30sIGxhYmVsLCBoKCdzcGFuJywgeyBjbGFzczogJ2NvdW50JywgdGV4dDogYCDCtyAke2xpc3QubGVuZ3RofWAgfSkpLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWl0ZW1zJyB9LCBsaXN0Lm1hcCh4ID0-IGl0ZW1FbCh7IGl0ZW06IHgsIGNvbnQ6IGZhbHNlIH0sIHsgZHVlOiBsYWJlbCA9PT0gJ092ZXJkdWUnIH0pKSksCiAgICBdIDogW10pOwogICAgY29uc3Qga2lkcyA9IFsuLi5ncm91cCgnT3ZlcmR1ZScsIHQub3ZlcmR1ZSksIC4uLmdyb3VwKCdObyBkYXRlJywgdC51bmRhdGVkKV07CiAgICBlbHMudHJheS5yZXBsYWNlQ2hpbGRyZW4oLi4ua2lkcyk7CiAgICBlbHMudHJheS5oaWRkZW4gPSBwYW5lbFVwIHx8ICFraWRzLmxlbmd0aDsKICB9CgogIGZ1bmN0aW9uIGRyYXdNaW5pKCkgewogICAgZWxzLm1pbmk",
"ucmVwbGFjZUNoaWxkcmVuKG1pbmlNb250aCgpKTsKICB9CgogIC8vIFRoZSBzbWFsbCBtb250aDogdGhlIG1vbnRoIGluIGZvY3VzLCB0aGUgZGF5cyBvbiBzY3JlZW4gbWFya2VkOyBhCiAgLy8gdGFwIG9uIGEgZGF5IGdvZXMgdGhlcmUuCiAgZnVuY3Rpb24gbWluaU1vbnRoKCkgewogICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICBjb25zdCBtID0gY2FsLm1vbnRoTmFtZShDLmFuY2hvcik7CiAgICBjb25zdCByb3dzID0gY2FsLm1vbnRoV2Vla3MoQy5hbmNob3IpOwogICAgY29uc3QgbW9udGggPSBDLmFuY2hvci5zbGljZSgwLCA3KTsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnbWluaScgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ21pbmktaGVhZCcsIHRleHQ6IGAke20ubG9uZ30ke20ueWVhciAhPT0gTnVtYmVyKEMudG9kYXkuc2xpY2UoMCwgNCkpID8gYCAke20ueWVhcn1gIDogJyd9YCB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ21pbmktZ3JpZCcsIHJvbGU6ICdncmlkJywgJ2FyaWEtbGFiZWwnOiBgJHttLmxvbmd9ICR7bS55ZWFyfWAgfSwKICAgICAgICBjYWwuREFZX05BTUVTLm1hcChkID0-IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbWluaS1kb3cnLCB0ZXh0OiBkWzBdLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSkpLAogICAgICAgIHJvd3MuZmxhdCgpLm1hcChrID0-IGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiBbJ21pbmktZGF5Jywgay5zbGljZSgwLCA3KSAhPT0gbW9",
"udGggJiYgJ290aGVyJywgayA9PT0gQy50b2RheSAmJiAndG9kYXknLAogICAgICAgICAgICBrID49IHIuc3RhcnQgJiYgayA8IHIuZW5kICYmICdzaG93biddLAogICAgICAgICAgdHlwZTogJ2J1dHRvbicsIHRleHQ6IFN0cmluZyhOdW1iZXIoay5zbGljZSg4KSkpLCAnYXJpYS1sYWJlbCc6IGxvbmdEYXRlKGspLAogICAgICAgICAgZGF0YXNldDogeyBrZXk6IGBjYWwtbWluaToke2t9YCB9LCBvbmNsaWNrOiAoKSA9PiBnbyhrKSwKICAgICAgICB9KSkpKTsKICB9CgogIGZ1bmN0aW9uIGxvbmdEYXRlKGspIHsKICAgIGNvbnN0IG0gPSBjYWwubW9udGhOYW1lKGspOwogICAgcmV0dXJuIGAke2NhbC5kYXlOYW1lKGspfSAke051bWJlcihrLnNsaWNlKDgpKX0gJHttLmxvbmd9ICR7bS55ZWFyfWA7CiAgfQoKICBmdW5jdGlvbiBkYXlIZWFkKGspIHsKICAgIHJldHVybiBoKCdoZWFkZXInLCB7IGNsYXNzOiAnZGF5LWhlYWQnIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZG5hbWUnLCB0ZXh0OiBjYWwuZGF5TmFtZShrKSB9KSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkbnVtJywgdGV4dDogU3RyaW5nKE51bWJlcihrLnNsaWNlKDgpKSkgfSksCiAgICAgIGsgPT09IEMudG9kYXkgPyBoKCdzcGFuJywgeyBjbGFzczogJ2JhZGdlJywgdGV4dDogJ3RvZGF5JyB9KSA6IG51bGwpOwogIH0KCiAgZnVuY3Rpb24gZGF5Q2xhc3NlcyhrLCBiYXNlKSB7CiAgICBjb25zdCB3ZCA9IGNhbC53ZWVrZGF5KGspOwogICA",
"gcmV0dXJuIFtiYXNlLCBrID09PSBDLnRvZGF5ICYmICd0b2RheScsIHdkID49IDUgJiYgJ3dlZWtlbmQnLCB3ZCA9PT0gNiAmJiAnc3VuZGF5JywgayA8IEMudG9kYXkgJiYgJ3Bhc3QnXTsKICB9CgogIGZ1bmN0aW9uIGRyYXdXZWVrKCkgewogICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICBjb25zdCBrZXlzID0gY2FsLmRheXMoci5zdGFydCwgci5lbmQpOwogICAgY29uc3QgYnlEYXkgPSBjYWwuYnlEYXkodmlzaWJsZUl0ZW1zKCksIGtleXMpOwogICAgY29uc3QgbG9hZGluZyA9IEMuc3RhdHVzID09PSAnbG9hZGluZycgJiYgIUMuc2hvd247CiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogWydjYWwtd2VlaycsIGxvYWRpbmcgJiYgJ2xvYWRpbmcnXSwgcm9sZTogJ2xpc3QnIH0sCiAgICAgIGtleXMubWFwKGsgPT4gaCgnc2VjdGlvbicsIHsgY2xhc3M6IGRheUNsYXNzZXMoaywgJ2RheScpLCByb2xlOiAnbGlzdGl0ZW0nLCAnYXJpYS1sYWJlbCc6IGxvbmdEYXRlKGspLCBkYXRhc2V0OiB7IGRheTogayB9IH0sCiAgICAgICAgZGF5SGVhZChrKSwKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWl0ZW1zJyB9LCBieURheS5nZXQoaykubWFwKGUgPT4gaXRlbUVsKGUpKSkpKSwKICAgICAgLy8gVGhlIGVpZ2h0aCB0aWxlLCBpbiB0aGUgdHdvIGNvbHVtbnMgb2YgYSBuYXJyb3cgc2NyZWVuLgogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZGF5IG1pbmktdGlsZScsICdhcmlhLWhpZGRlbic6IEMubmFycm9",
"3ID8gbnVsbCA6ICd0cnVlJyB9LCBtaW5pTW9udGgoKSkpOwogIH0KCiAgZnVuY3Rpb24gZHJhd01vbnRoKCkgewogICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICBjb25zdCBrZXlzID0gY2FsLmRheXMoci5zdGFydCwgci5lbmQpOwogICAgY29uc3QgYnlEYXkgPSBjYWwuYnlEYXkodmlzaWJsZUl0ZW1zKCksIGtleXMpOwogICAgY29uc3QgbW9udGggPSBDLmFuY2hvci5zbGljZSgwLCA3KTsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLW1vbnRoJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbW9udGgtZG93cycsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9LCBjYWwuREFZX05BTUVTLm1hcChkID0-IGgoJ3NwYW4nLCB7IHRleHQ6IGQgfSkpKSwKICAgICAgdGludChoKCdkaXYnLCB7IGNsYXNzOiAnbW9udGgtZ3JpZCcgfSwKICAgICAgICBrZXlzLm1hcChrID0-IHsKICAgICAgICAgIGNvbnN0IGFsbCA9IGJ5RGF5LmdldChrKTsKICAgICAgICAgIGNvbnN0IG1vcmUgPSBhbGwubGVuZ3RoIC0gTU9OVEhfUk9XUzsKICAgICAgICAgIHJldHVybiBoKCdzZWN0aW9uJywgeyBjbGFzczogWy4uLmRheUNsYXNzZXMoaywgJ21jZWxsJyksIGsuc2xpY2UoMCwgNykgIT09IG1vbnRoICYmICdvdGhlciddLCAnYXJpYS1sYWJlbCc6IGxvbmdEYXRlKGspIH0sCiAgICAgICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgICAgICBjbGFzczogJ21kYXknLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogU3RyaW5nKE5",
"1bWJlcihrLnNsaWNlKDgpKSksIHRpdGxlOiBgV2VlayBvZiAke2xvbmdEYXRlKGspfWAsCiAgICAgICAgICAgICAgZGF0YXNldDogeyBrZXk6IGBjYWwtZGF5OiR7a31gIH0sIG9uY2xpY2s6ICgpID0-IG9wZW5XZWVrKGspLAogICAgICAgICAgICB9KSwKICAgICAgICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2NhbC1pdGVtcycgfSwgYWxsLnNsaWNlKDAsIG1vcmUgPiAwID8gTU9OVEhfUk9XUyAtIDEgOiBNT05USF9ST1dTKS5tYXAoZSA9PiBpdGVtRWwoZSwgeyBjb21wYWN0OiB0cnVlIH0pKSwKICAgICAgICAgICAgICBtb3JlID4gMCA_IGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdtb3JlJywgdHlwZTogJ2J1dHRvbicsIHRleHQ6IGArJHttb3JlICsgMX0gbW9yZWAsIG9uY2xpY2s6ICgpID0-IG9wZW5XZWVrKGspIH0pIDogbnVsbCkpOwogICAgICAgIH0pKSwgJy0tcm93cycsIFN0cmluZyhrZXlzLmxlbmd0aCAvIDcpKSk7CiAgfQoKICBmdW5jdGlvbiBvcGVuV2VlayhrKSB7CiAgICBDLmFuY2hvciA9IGs7CiAgICBzZXRWaWV3KCd3ZWVrJyk7CiAgfQoKICBmdW5jdGlvbiBkcmF3QWdlbmRhKCkgewogICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICBjb25zdCBrZXlzID0gY2FsLmRheXMoci5zdGFydCwgci5lbmQpOwogICAgY29uc3QgYnlEYXkgPSBjYWwuYnlEYXkodmlzaWJsZUl0ZW1zKCksIGtleXMpOwogICAgY29uc3QgZGF5cyA9IGtleXMuZmlsdGVyKGsgPT4gYnlEYXkuZ2V0KGspLmxlbmd0aCB8fCBrID09PSB",
"DLnRvZGF5KTsKICAgIGlmIChDLnN0YXR1cyA9PT0gJ2xvYWRpbmcnICYmICFDLnNob3duKSByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1hZ2VuZGEgbG9hZGluZycgfSk7CiAgICBpZiAoIWRheXMubGVuZ3RoKSByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1hZ2VuZGEnIH0sIGgoJ3AnLCB7IGNsYXNzOiAnZW1wdHknLCB0ZXh0OiAnTm90aGluZyBvbiBpbiB0aGVzZSBmb3VyIHdlZWtzLicgfSkpOwogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtYWdlbmRhJyB9LCBkYXlzLm1hcChrID0-IHsKICAgICAgY29uc3QgbSA9IGNhbC5tb250aE5hbWUoayk7CiAgICAgIHJldHVybiBoKCdzZWN0aW9uJywgeyBjbGFzczogZGF5Q2xhc3NlcyhrLCAnYWRheScpLCAnYXJpYS1sYWJlbCc6IGxvbmdEYXRlKGspIH0sCiAgICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2FkYXktZGF0ZScgfSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZG51bScsIHRleHQ6IFN0cmluZyhOdW1iZXIoay5zbGljZSg4KSkpIH0pLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkbmFtZScgfSwgaCgnc3BhbicsIHsgdGV4dDogY2FsLmRheU5hbWUoaykgfSksIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbW9uJywgdGV4dDogbS5zaG9ydCB9KSkpLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtaXRlbXMnIH0sIGJ5RGF5LmdldChrKS5sZW5ndGgKICAgICAgICAgID8gYnlEYXkuZ2V0KGspLm1hcChlID0",
"-IGl0ZW1FbChlLCB7IGFnZW5kYTogdHJ1ZSB9KSkKICAgICAgICAgIDogaCgncCcsIHsgY2xhc3M6ICdlbXB0eScsIHRleHQ6ICdOb3RoaW5nIG9uIHRvZGF5LicgfSkpKTsKICAgIH0pKTsKICB9CgogIGZ1bmN0aW9uIHRpbWVUZXh0KG1zKSB7CiAgICBpZiAoIXRpbWVGb3JtYXQpIHRpbWVGb3JtYXQgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCh1bmRlZmluZWQsIHsgaG91cjogJ251bWVyaWMnLCBtaW51dGU6ICcyLWRpZ2l0JyB9KTsKICAgIHJldHVybiB0aW1lRm9ybWF0LmZvcm1hdChuZXcgRGF0ZShtcykpOwogIH0KCiAgZnVuY3Rpb24gd2hlblRleHQoaXRlbSwgY29udCkgewogICAgaWYgKGl0ZW0uYWxsRGF5KSByZXR1cm4gaXRlbS5maXJzdCA9PT0gaXRlbS5sYXN0ID8gJ0FsbCBkYXknIDogYCR7c2hvcnREYXRlKGl0ZW0uZmlyc3QpfSDigJMgJHtzaG9ydERhdGUoaXRlbS5sYXN0KX1gOwogICAgY29uc3Qgc3BhbiA9IGAke3RpbWVUZXh0KGl0ZW0uc3RhcnQpfSDigJMgJHt0aW1lVGV4dChpdGVtLmVuZCl9YDsKICAgIHJldHVybiBpdGVtLmZpcnN0ID09PSBpdGVtLmxhc3QgPyBzcGFuIDogYCR7c2hvcnREYXRlKGl0ZW0uZmlyc3QpfSAke3RpbWVUZXh0KGl0ZW0uc3RhcnQpfSDigJMgJHtzaG9ydERhdGUoaXRlbS5sYXN0KX0gJHt0aW1lVGV4dChpdGVtLmVuZCl9YDsKICB9CgogIGZ1bmN0aW9uIHNob3J0RGF0ZShrKSB7CiAgICByZXR1cm4gYCR7TnVtYmVyKGsuc2xpY2UoOCkpfSAke2NhbC5tb250aE5",
"hbWUoaykuc2hvcnR9YDsKICB9CgogIC8vIEFuIGV2ZW50IG9yIGEgdGFzaywgYXMgYSBsaW5rIHRvIHdoZXJlIGl0IGxpdmVzIGluIEdvb2dsZS4KICBmdW5jdGlvbiBpdGVtRWwoeyBpdGVtLCBjb250IH0sIHsgY29tcGFjdCA9IGZhbHNlLCBhZ2VuZGEgPSBmYWxzZSwgZHVlID0gZmFsc2UgfSA9IHt9KSB7CiAgICBjb25zdCB0YWcgPSBpdGVtLmxpbmsgPyAnYScgOiAnZGl2JzsKICAgIGNvbnN0IGxpbmsgPSBpdGVtLmxpbmsgPyB7IGhyZWY6IGl0ZW0ubGluaywgdGFyZ2V0OiAnX2JsYW5rJywgcmVsOiAnbm9vcGVuZXIgbm9yZWZlcnJlcicgfSA6IHt9OwogICAgaWYgKGl0ZW0ua2luZCA9PT0gJ2V2ZW50JykgewogICAgICBjb25zdCB0aW1lID0gaXRlbS5hbGxEYXkgPyAoYWdlbmRhID8gJ0FsbCBkYXknIDogJycpIDogY29udCA_IChhZ2VuZGEgPyAndW50aWwgJyArIHRpbWVUZXh0KGl0ZW0uZW5kKSA6ICfigKYnKSA6IHRpbWVUZXh0KGl0ZW0uc3RhcnQpOwogICAgICBjb25zdCB0aXAgPSBbaXRlbS50aXRsZSwgd2hlblRleHQoaXRlbSwgY29udCksIGl0ZW0ud2hlcmVdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcbicpOwogICAgICByZXR1cm4gdGludChoKHRhZywgT2JqZWN0LmFzc2lnbih7CiAgICAgICAgY2xhc3M6IFsnaXRlbScsICdldicsIGl0ZW0uYWxsRGF5ICYmICdhbGwtZGF5JywgY29tcGFjdCAmJiAnY29tcGFjdCddLCB0aXRsZTogdGlwLAogICAgICB9LCBsaW5rKSwKICAgICAgdGltZSA_IGgoJ3N",
"wYW4nLCB7IGNsYXNzOiAndGltZScsIHRleHQ6IHRpbWUgfSkgOiBudWxsLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3QnLCB0ZXh0OiBpdGVtLnRpdGxlIH0pKSwgJy0tYycsIGl0ZW0uY29sb3VyKTsKICAgIH0KICAgIGNvbnN0IHRpcCA9IFtpdGVtLnRpdGxlLCBpdGVtLmxpc3QgJiYgYEdvb2dsZSBUYXNrcyDCtyAke2l0ZW0ubGlzdH1gLCBkdWUgJiYgaXRlbS5kdWUgJiYgYER1ZSAke3Nob3J0RGF0ZShpdGVtLmR1ZSl9YCwKICAgICAgaXRlbS5lbWFpbCAmJiAnT3BlbnMgdGhlIGVtYWlsJ10uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJ1xuJyk7CiAgICByZXR1cm4gaCh0YWcsIE9iamVjdC5hc3NpZ24oeyBjbGFzczogWydpdGVtJywgJ3Rhc2snLCBpdGVtLmRvbmUgJiYgJ2RvbmUnLCBjb21wYWN0ICYmICdjb21wYWN0J10sIHRpdGxlOiB0aXAgfSwgbGluayksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnYm94JywgJ2FyaWEtbGFiZWwnOiBpdGVtLmRvbmUgPyAnRG9uZScgOiAnVG8gZG8nLCByb2xlOiAnaW1nJyB9LCBpdGVtLmRvbmUgPyBpY29uKCdjaGVjaycsIDEyKSA6IG51bGwpLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3QnLCB0ZXh0OiBpdGVtLnRpdGxlIH0pLAogICAgICBkdWUgJiYgaXRlbS5kdWUgPyBoKCdzcGFuJywgeyBjbGFzczogJ2R1ZScsIHRleHQ6IHNob3J0RGF0ZShpdGVtLmR1ZSkgfSkgOiBudWxsLAogICAgICBpdGVtLmVtYWlsID8gaCgnc3BhbicsIHsgY2xhc3M6ICdtYWlsJyw",
"gdGl0bGU6ICdGcm9tIGFuIGVtYWlsJyB9LCBpY29uKCdtYWlsJywgMTQpKSA6IG51bGwpOwogIH0KCiAgLy8g4pSA4pSAIEtleXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGhhbmRsZUtleShlKSB7CiAgICBpZiAoZS5jdHJsS2V5IHx8IGUubWV0YUtleSB8fCBlLmFsdEtleSB8fCBlLmRlZmF1bHRQcmV2ZW50ZWQpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IHQgPSBlLmNvbXBvc2VkUGF0aCgpWzBdOwogICAgaWYgKHQgJiYgKHQuaXNDb250ZW50RWRpdGFibGUgfHwgL14oSU5QVVR8VEVYVEFSRUF8U0VMRUNUKSQvLnRlc3QodC50YWdOYW1lKSkpIHJldHVybiBmYWxzZTsKICAgIGlmIChDLnN0YXR1cyA9PT0gJ3NpZ25pbicgfHwgQy5zdGF0dXMgPT09ICdtaXNtYXRjaCcpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IGsgPSBlLmtleS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgYWN0ID0gewogICAgICB0OiAoKSA9PiBnbyhjYWwuZGF0ZUtleShuZXcgRGF0ZSgpKSksCiAgICAgIGo6ICgpID0-IGdvKGNhbC5zdGVwKHZpZXcoKSwgQy5hbmNob3IsIDEpKSwKICAgICAgbjogKCkgPT4gZ28oY2FsLnN0ZXAodmlldyg",
"pLCBDLmFuY2hvciwgMSkpLAogICAgICBrOiAoKSA9PiBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCAtMSkpLAogICAgICBwOiAoKSA9PiBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCAtMSkpLAogICAgICB3OiAoKSA9PiBzZXRWaWV3KCd3ZWVrJyksCiAgICAgIG06ICgpID0-IHNldFZpZXcoJ21vbnRoJyksCiAgICAgIGE6ICgpID0-IHNldFZpZXcoJ2FnZW5kYScpLAogICAgfVtrXTsKICAgIGlmICghYWN0KSByZXR1cm4gZmFsc2U7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBhY3QoKTsKICAgIHJldHVybiB0cnVlOwogIH0KCiAgLy8gRXZlcnkgZmV3IHNlY29uZHMgd2hpbGUgb3BlbjogcGFzdCBtaWRuaWdodCwgdG9kYXkgbW92ZXMgb24uCiAgZnVuY3Rpb24gdGljaygpIHsKICAgIGNvbnN0IG5vdyA9IGNhbC5kYXRlS2V5KG5ldyBEYXRlKCkpOwogICAgaWYgKG5vdyA9PT0gQy50b2RheSkgcmV0dXJuOwogICAgaWYgKEMuYW5jaG9yID09PSBDLnRvZGF5KSBDLmFuY2hvciA9IG5vdzsKICAgIEMudG9kYXkgPSBub3c7CiAgICBsb2FkKCk7CiAgfQoKICBucy5jYWxlbmRhciA9IHsKICAgIGluaXQsIGVsZW1lbnQsIGxvYWQsIGlzU3RhbGUsIGhhbmRsZUtleSwgdGljaywKICAgIGxvYWRlZEF0OiAoKSA9PiBDLmxvYWRlZEF0LAogICAgaXNMb2FkaW5nOiAoKSA9PiAhIUMubG9hZGluZywKICB9Owp9KSgpOwo\"],[\"src/content/board.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA",
"4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBib2FyZAovLwovLyBBIGZ1bGwtdmlld3BvcnQgb3ZlcmxheSBvdmVyIEdtYWlsLiBDb2x1bW5zIGFyZSBHbWFpbCBsYWJlbHMsIGNhcmRzIGFyZQovLyB0aHJlYWRzLCBhbmQgZXZlcnkgY2hhbmdlIGlzIGEgdGhyZWFkcy5tb2RpZnkgYXBwbGllZCBvcHRpbWlzdGljYWxseToKLy8gdGhlIGNhcmQgbW92ZXMgYXQgb25jZSwgYW5kIG1vdmVzIGJhY2sgd2l0aCBhIHRvYXN0IGlmIEdtYWlsIHJlZnVzZXMuCi8vIERyYWdnaW5nIGlzIHRoZSBxdWljayB3YXkgdG8gbW92ZSB0aGluZ3MsIGJ1dCBldmVyeSBhY3Rpb24gaXMgYWxzbyBvbgovLyB0aGUgY2FyZCdzICLii68iIG1lbnUsIHNvIG5vdGhpbmcgbmVlZHMgYSBtb3VzZS4KLy8KLy8gVGhlIHBob25lIGFwcCAoYWRkb24vYXBwKSBydW5zIHRoaXMgc2FtZSBib2FyZCBhcyB0aGUgYXBwIGl0c2VsZiByYXRoZXIKLy8gdGhhbiBvdmVyIEdtYWlsOiBpdCBzZXRzIG5zLmJvYXJkRnJhbWUgLSB3aGVyZSB0byBkcmF3LCB0aGUgdGFiIHRvIHN0YXJ0Ci8vIG9uLCBhbmQgd2hhdCB0aGUgbm90ZXMgbmVlZCBmcm9tIGl0IC0gYW5kIHRoZXJl",
"IGlzIHRoZW4gbm90aGluZyB0bwovLyBjbG9zZSwgYW5kIG5vIEdtYWlsIHBhZ2UgYmVoaW5kIHRvIGtlZXAgdGhlIGtleWJvYXJkIG91dCBvZi4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLCBsb2dvLCBtb3VudFNoYWRvdywgdG9hc3QsIG9wZW5NZW51LCBjbG9zZU1lbnUsIGlzTWVudU9wZW4gfSA9IG5zLnVpOwogIGNvbnN0IHsgdXRpbCwgbG9naWMsIHN0b3JlLCBob29rcywgYXBpLCBBUFBfTkFNRSwgSE9TVF9JRFMsIEtFWVMgfSA9IG5zOwoKICAvLyBTdGF0ZXMgd2l0aCBhIHBhbmVsIG9mIHRoZWlyIG93biwgc2hvd24gd2hpY2hldmVyIHRhYiBpcyBvcGVuOiB0aGV5CiAgLy8gYXJlIGFib3V0IHRoZSBhY2NvdW50LCBub3QgYWJvdXQgdGhlIGJvYXJkIG9yIHRoZSBub3Rlcy4KICBjb25zdCBQQU5FTF9TVEFURVMgPSBuZXcgU2V0KFsnbm9fYWNjb3VudCcsICdub3RfY29uZmlndXJlZCcsICdhdXRo",
"X3JlcXVpcmVkJywgJ2FjY291bnRfbWlzbWF0Y2gnXSk7CgogIC8vIE9wZW5pbmcgdGhlIGJvYXJkIHJlLXJlYWRzIEdtYWlsIGlmIHdoYXQgaXMgb24gc2NyZWVuIGlzIG9sZGVyIHRoYW4KICAvLyB0aGlzLiBTaG9ydCBlbm91Z2ggdGhhdCBhIGxhYmVsIGFkZGVkIG9uIHRoZSBwaG9uZSBzaG93cyB1cDsgbG9uZwogIC8vIGVub3VnaCB0aGF0IGZsaWNraW5nIHRoZSBib2FyZCBvcGVuIGFuZCBzaHV0IGNvc3RzIG5vdGhpbmcuCiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CgogIGNvbnN0IERSQUdfVFlQRSA9ICdhcHBsaWNhdGlvbi94LWdrYi10aHJlYWQnOwoKICBjb25zdCBWSUVXUyA9IFsnYm9hcmQnLCAnbm90ZXMnLCAnY2FsZW5kYXInXTsKCiAgLy8g4pSA4pSAIFN0YXRlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBTID0gewogICAgbW91bnRlZDogZmFsc2UsCiAgICBvcGVuOiBmYWxzZSwKICAgIHZpZXc6ICdib2FyZCcsICAgIC8vIGJvYXJkIHwgbm90ZXMgfCBjYWxlbmRhciAtIHRoZSBvdmVybGF5J3MgdGhyZWUgdGFicwogICAgdmlld0xvYWRlZDogZmFsc2UsCiAgICBhY2NvdW50OiAnJywKICAgIGNvbHVt",
"bnM6IFtdLAogICAgbGlzdHM6IHt9LCAgICAgICAgLy8gY29sdW1uIGlkIOKGkiB0aHJlYWQgaWRzLCBpbiBkaXNwbGF5IG9yZGVyCiAgICB0cnVuY2F0ZWQ6IHt9LCAgICAvLyBjb2x1bW4gaWQg4oaSIHRydWUgd2hlbiBHbWFpbCBoYWQgbW9yZSB0aGFuIDEwMAogICAgbG9hZGVkQXQ6IDAsCiAgICBsb2FkaW5nOiBudWxsLCAgICAvLyBwcm9taXNlIG9mIHRoZSByZWZyZXNoIGluIHByb2dyZXNzCiAgICBzdGF0dXM6ICdpZGxlJywgICAvLyBpZGxlIHwgbG9hZGluZyB8IHJlYWR5IHwgZXJyb3IgfCBub19hY2NvdW50IHwgbm90X2NvbmZpZ3VyZWQgfCBhdXRoX3JlcXVpcmVkIHwgYWNjb3VudF9taXNtYXRjaAogICAgc3RhdHVzTWVzc2FnZTogJycsCiAgICBzZWFyY2g6IG51bGwsICAgICAvLyB7IGNvbElkLCBxdWVyeSwgaWRzLCBsb2FkaW5nLCBlcnJvciwgc2VxIH0KICAgIGRyYXdlcjogbnVsbCwgICAgIC8vIHsgZHJhZnQsIGVycm9yLCBzYXZpbmcgfQogICAgZWRpdHM6IG5ldyBNYXAoKSwgLy8gdGhyZWFkIGlkIOKGkiB7IHRpdGxlPywgbm90ZT8sIGNvbG91cj8gfSAoc2VlIGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KQogICAgZWRpdG9yOiBudWxsLCAgICAgLy8geyBpZCwgc3ViamVjdCwgZHJhZnQsIGVycm9yLCBzYXZpbmcgfQogICAgZHJhZzogbnVsbCwgICAgICAgLy8geyBpZCwgZnJvbUNvbCwgY2FyZCwgcGxhY2Vob2xkZXIgfQogICAgbXV0YXRpb25zOiAwLCAgICAgLy8gbG9jYWwgbW92ZXMgbWFkZTsg",
"YSByZWZyZXNoIHRoYXQgc3BhbnMgb25lIGlzIHN0YWxlCiAgICByZW5kZXJEZWZlcnJlZDogZmFsc2UsCiAgICByZXR1cm5Gb2N1czogbnVsbCwKICAgIHRpY2tlcjogMCwKICB9OwoKICBsZXQgcm9vdCA9IG51bGw7CiAgbGV0IGZyYW1lID0gbnVsbDsgLy8gbnMuYm9hcmRGcmFtZSwgaW4gdGhlIHBob25lIGFwcAogIGNvbnN0IGVscyA9IHt9OwoKICAvLyDilIDilIAgTW91bnRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG1vdW50KCkgewogICAgaWYgKFMubW91bnRlZCkgcmV0dXJuOwogICAgZnJhbWUgPSBucy5ib2FyZEZyYW1lIHx8IG51bGw7CiAgICAoeyByb290IH0gPSBmcmFtZSA_IHsgcm9vdDogZnJhbWUucm9vdCB9IDogbW91bnRTaGFkb3coSE9TVF9JRFMuYm9hcmQsIG5zLnN0eWxlcy5ib2FyZCkpOwoKICAgIGVscy5hY2NvdW50ID0gaCgnc3BhbicsIHsgY2xhc3M6ICdhY2NvdW50JyB9KTsKICAgIGVscy51cGRhdGVkID0gaCgnc3BhbicsIHsgY2xhc3M6ICd1cGRhdGVkJyB9KTsKICAgIGVscy5yZWZyZXNoID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlh",
"LWxhYmVsJzogJ1JlZnJlc2gnLCB0aXRsZTogJ1JlZnJlc2gnLAogICAgICBvbmNsaWNrOiAoKSA9PiAoUy52aWV3ID09PSAnbm90ZXMnID8gbnMubm90ZXMubG9hZCh7IGZvcmNlOiB0cnVlIH0pCiAgICAgICAgOiBTLnZpZXcgPT09ICdjYWxlbmRhcicgPyBucy5jYWxlbmRhci5sb2FkKHsgZm9yY2U6IHRydWUgfSkgOiByZWZyZXNoKCkpLAogICAgfSwgaWNvbigncmVmcmVzaCcpKTsKICAgIGVscy5zZXR0aW5ncyA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDb2x1bW4gc2V0dGluZ3MnLCB0aXRsZTogJ0NvbHVtbiBzZXR0aW5ncycsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAnc2V0dGluZ3MnIH0sIG9uY2xpY2s6IG9wZW5EcmF3ZXIsCiAgICB9LCBpY29uKCd0dW5lJykpOwogICAgZWxzLmNsb3NlID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ0Nsb3NlIGJvYXJkJywgdGl0bGU6ICdDbG9zZSAoRXNjKScsCiAgICAgIGhpZGRlbjogISFmcmFtZSwgb25jbGljazogY2xvc2UsCiAgICB9LCBpY29uKCdjbG9zZScpKTsKCiAgICBjb25zdCB0YWIgPSAodmlldywgbGFiZWwsIGljb25OYW1lKSA9PiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAndGFiJywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICd0YWInLCAnYXJpYS1zZWxlY3RlZCc6IFN0cmluZyhTLnZp",
"ZXcgPT09IHZpZXcpLAogICAgICBkYXRhc2V0OiB7IGtleTogYHZpZXc6JHt2aWV3fWAsIHZpZXcgfSwgb25jbGljazogKCkgPT4gc3dpdGNoVmlldyh2aWV3KSwKICAgIH0sIGljb24oaWNvbk5hbWUsIDE4KSwgbGFiZWwpOwogICAgZWxzLnRhYnMgPSBoKCdkaXYnLCB7IGNsYXNzOiAndGFicycsIHJvbGU6ICd0YWJsaXN0JywgJ2FyaWEtbGFiZWwnOiAnVmlldycgfSwKICAgICAgdGFiKCdib2FyZCcsICdCb2FyZCcsICdib2FyZCcpLCB0YWIoJ25vdGVzJywgJ05vdGVzJywgJ25vdGUnKSwgdGFiKCdjYWxlbmRhcicsICdDYWxlbmRhcicsICdjYWxlbmRhcicpKTsKCiAgICBjb25zdCBiYXIgPSBoKCdoZWFkZXInLCB7IGNsYXNzOiAnYmFyJyB9LAogICAgICBoKCdoMScsIHsgY2xhc3M6ICdicmFuZCcgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2xvZ28nIH0sIGxvZ28oMjYpKSwKICAgICAgICBoKCdzcGFuJywgeyB0ZXh0OiBBUFBfTkFNRSB9KSksCiAgICAgIGVscy50YWJzLAogICAgICBlbHMuYWNjb3VudCwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3NwYWNlcicgfSksCiAgICAgIGVscy51cGRhdGVkLCBlbHMucmVmcmVzaCwgZWxzLnNldHRpbmdzLCBlbHMuY2xvc2UpOwoKICAgIGVscy5ib2R5ID0gaCgnbWFpbicsIHsgY2xhc3M6ICdib2R5JyB9KTsKICAgIGVscy5saXZlID0gaCgnZGl2JywgeyBjbGFzczogJ3NyLW9ubHknLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScgfSk7CiAgICBlbHMuZHJhd2Vy",
"TGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZHJhd2VyLWxheWVyJyB9KTsKICAgIGVscy5lZGl0b3JMYXllciA9IGgoJ2RpdicsIHsgY2xhc3M6ICdlZGl0b3ItbGF5ZXInIH0pOwoKICAgIGVscy5vdmVybGF5ID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ292ZXJsYXknLCByb2xlOiBmcmFtZSA_IG51bGwgOiAnZGlhbG9nJywgJ2FyaWEtbW9kYWwnOiBmcmFtZSA_IG51bGwgOiAndHJ1ZScsICdhcmlhLWxhYmVsJzogYCR7QVBQX05BTUV9IGJvYXJkYCwKICAgICAgdGFiaW5kZXg6ICctMScsIGhpZGRlbjogdHJ1ZSwgb25rZXlkb3duOiBvbk92ZXJsYXlLZXksCiAgICB9LCBiYXIsIGVscy5ib2R5LCBlbHMubGl2ZSwgZWxzLmRyYXdlckxheWVyLCBlbHMuZWRpdG9yTGF5ZXIpOwoKICAgIHJvb3QuYXBwZW5kQ2hpbGQoZWxzLm92ZXJsYXkpOwogICAgUy5tb3VudGVkID0gdHJ1ZTsKCiAgICAvLyBTbWFsbCBwZXItYWNjb3VudCBwcmVmZXJlbmNlcyAoZm9sZGVkIGZvbGRlcnMsIHRoZSBjYWxlbmRhcidzIHZpZXcpLAogICAgLy8gb24gdGhpcyBjb21wdXRlci4KICAgIGNvbnN0IHByZWZzID0gewogICAgICBhc3luYyBnZXQobmFtZSkgewogICAgICAgIGNvbnN0IGtleSA9IEtFWVMucHJlZihob29rcy5nZXRBY2NvdW50KCksIG5hbWUpOwogICAgICAgIHJldHVybiAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV07CiAgICAgIH0sCiAgICAgIHNldDogKG5hbWUsIHZhbHVlKSA9PiBjaHJv",
"bWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy5wcmVmKGhvb2tzLmdldEFjY291bnQoKSwgbmFtZSldOiB2YWx1ZSB9KSwKICAgIH07CgogICAgbnMubm90ZXMuaW5pdChPYmplY3QuYXNzaWduKHsKICAgICAgcm9vdCwKICAgICAgLy8gQWNjb3VudCB0cm91YmxlIGZvdW5kIGJ5IHRoZSBub3RlcyBnZXRzIHRoZSBzYW1lIHBhbmVsIGFzIHRoZSBib2FyZCdzLgogICAgICBvblN0YXRlRXJyb3I6IGVyciA9PiB7CiAgICAgICAgUy5zdGF0dXMgPSBlcnIuY29kZTsKICAgICAgICBTLnN0YXR1c01lc3NhZ2UgPSBlcnIubWVzc2FnZTsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSwKICAgICAgb25Mb2FkZWQ6ICgpID0-IHsKICAgICAgICBpZiAoIVBBTkVMX1NUQVRFUy5oYXMoUy5zdGF0dXMpKSByZXR1cm47CiAgICAgICAgUy5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0sCiAgICAgIGNsb3NlQm9hcmQ6IGNsb3NlLAogICAgICBiYXJDaGFuZ2VkOiB1cGRhdGVCYXIsCiAgICAgIC8vIFdoaWNoIGZvbGRlcnMgYXJlIGZvbGRlZCwgb24gdGhpcyBjb21wdXRlciwgZm9yIHRoaXMgYWNjb3VudC4KICAgICAgcHJlZnMsCiAgICB9LCBmcmFtZSAmJiBmcmFtZS5ub3RlcykpOwoKICAgIG5zLmNhbGVuZGFyLmluaXQoT2JqZWN0LmFzc2lnbih7CiAgICAgIHJvb3QsCiAgICAgIC8vIE5vIGNsaWVudCBJRCB5ZXQ6IHRoZSBib2FyZCdzIG93biBzZXR1cCBwYW5lbC4gVGhlIGNhbGVuZGFyJ3MKICAg",
"ICAgLy8gb3duIHNpZ24taW4gaGFzIGEgcGFuZWwgb2YgaXRzIG93biwgaW5zaWRlIHRoZSBjYWxlbmRhci4KICAgICAgb25TdGF0ZUVycm9yOiBlcnIgPT4gewogICAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0sCiAgICAgIG9uTG9hZGVkOiAoKSA9PiB7CiAgICAgICAgaWYgKCFQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSkgcmV0dXJuOwogICAgICAgIFMuc3RhdHVzID0gJ2lkbGUnOwogICAgICAgIHJlbmRlcigpOwogICAgICB9LAogICAgICBiYXJDaGFuZ2VkOiB1cGRhdGVCYXIsCiAgICAgIHByZWZzLAogICAgICBjb25uZWN0OiAoKSA9PiBhcGkuY29ubmVjdENhbGVuZGFyKCksCiAgICB9LCBmcmFtZSAmJiBmcmFtZS5jYWxlbmRhcikpOwoKICAgIC8vIEEgbW92ZSBtYWRlIGZyb20gdGhlIGRvY2sgKG9yIGFub3RoZXIgdGFiKSBtYWtlcyB3aGF0IHRoZSBib2FyZCBsYXN0CiAgICAvLyBsb2FkZWQgd3Jvbmc7IHRoZSBib2FyZCdzIG93biBtb3ZlcyBhcmUgYWxyZWFkeSByZWZsZWN0ZWQgb24gc2NyZWVuLgogICAgc3RvcmUuYnVzLmFkZEV2ZW50TGlzdGVuZXIoJ3RocmVhZC1jaGFuZ2VkJywgZSA9PiB7CiAgICAgIGlmIChlLmRldGFpbCAmJiBlLmRldGFpbC5zb3VyY2UgPT09ICdib2FyZCcpIHJldHVybjsKICAgICAgUy5sb2FkZWRBdCA9IDA7CiAgICAgIGlmIChTLm9wZW4gJiYgUy52aWV3",
"ID09PSAnYm9hcmQnKSByZWZyZXNoKCk7CiAgICB9KTsKICB9CgogIC8vIOKUgOKUgCBPcGVuIC8gY2xvc2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIG9wZW4oeyB2aWV3IH0gPSB7fSkgewogICAgbW91bnQoKTsKICAgIGlmIChTLm9wZW4pIHsKICAgICAgaWYgKHZpZXcpIHN3aXRjaFZpZXcodmlldyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIFMub3BlbiA9IHRydWU7CiAgICBTLnJldHVybkZvY3VzID0gZnJhbWUgPyBudWxsIDogZGVlcEFjdGl2ZUVsZW1lbnQoKTsKICAgIGVscy5vdmVybGF5LmhpZGRlbiA9IGZhbHNlOwogICAgaWYgKCFmcmFtZSkgZWxzLmNsb3NlLmZvY3VzKCk7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgb25Eb2N1bWVudEtleSwgdHJ1ZSk7CiAgICBTLnRpY2tlciA9IHNldEludGVydmFsKHVwZGF0ZUJhciwgNTAwMCk7CgogICAgLy8gVGhlIHRhYiBsYXN0IHVzZWQsIHVubGVzcyB0aGUgY2FsbGVyIGFza2VkIGZvciBvbmUuCiAgICBpZiAoIVMudmlld0xvYWRlZCkgewogICAgICBTLnZpZXdMb2FkZWQgPSB0cnVlOwogICAgICB0cnkgewogICAgICAgIGNvbnN0IGdvdCA9IGF3YWl0IGNo",
"cm9tZS5zdG9yYWdlLmxvY2FsLmdldChLRVlTLnZpZXcpOwogICAgICAgIGlmIChWSUVXUy5pbmNsdWRlcyhnb3RbS0VZUy52aWV3XSkpIFMudmlldyA9IGdvdFtLRVlTLnZpZXddOwogICAgICAgIGVsc2UgaWYgKGZyYW1lICYmIGZyYW1lLnZpZXcpIFMudmlldyA9IGZyYW1lLnZpZXc7CiAgICAgIH0gY2F0Y2ggeyAvKiBleHRlbnNpb24gcmVsb2FkZWQ7IGhhbmRsZWQganVzdCBiZWxvdyAqLyB9CiAgICB9CiAgICBpZiAodmlldykgUy52aWV3ID0gdmlldzsKCiAgICBTLmFjY291bnQgPSBob29rcy5nZXRBY2NvdW50KCk7CiAgICBpZiAoIVMuYWNjb3VudCkgewogICAgICBTLnN0YXR1cyA9ICdub19hY2NvdW50JzsKICAgICAgcmVuZGVyKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRyeSB7CiAgICAgIGlmICghUy5jb2x1bW5zLmxlbmd0aCkgUy5jb2x1bW5zID0gYXdhaXQgc3RvcmUubG9hZENvbHVtbnMoUy5hY2NvdW50KTsKICAgIH0gY2F0Y2ggewogICAgICAvLyBjaHJvbWUuc3RvcmFnZSB0aHJvd3Mgb25jZSB0aGUgZXh0ZW5zaW9uIGhhcyBiZWVuIHJlbG9hZGVkIHVuZGVyCiAgICAgIC8vIHRoaXMgdGFiOyBub3RoaW5nIGVsc2Ugd2lsbCB3b3JrIHVudGlsIEdtYWlsIGlzIHJlbG9hZGVkIGVpdGhlci4KICAgICAgUy5zdGF0dXMgPSAnZXJyb3InOwogICAgICBTLnN0YXR1c01lc3NhZ2UgPSAnVGhlIGV4dGVuc2lvbiB3YXMgdXBkYXRlZC4gUmVsb2FkIHRoaXMgR21haWwgdGFiLic7CiAgICAgIHJlbmRl",
"cigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnKSBzaG93Tm90ZXMoKTsKICAgIGVsc2UgaWYgKFMudmlldyA9PT0gJ2NhbGVuZGFyJykgc2hvd0NhbGVuZGFyKCk7CiAgICBlbHNlIHNob3dCb2FyZCgpOwogIH0KCiAgZnVuY3Rpb24gc2hvd0JvYXJkKCkgewogICAgY29uc3Qgc3RhbGUgPSBTLnN0YXR1cyAhPT0gJ3JlYWR5JyB8fCBEYXRlLm5vdygpIC0gUy5sb2FkZWRBdCA-IFNUQUxFX01TOwogICAgLy8gU2tlbGV0b24gY29sdW1ucyB3aGlsZSBhIGZpcnN0IChvciByZXRyaWVkKSBsb2FkIHJ1bnMsIHJhdGhlciB0aGFuCiAgICAvLyBsZWF2aW5nIGFuIG9sZCAiQ29ubmVjdCBHbWFpbCIgcGFuZWwgdXAgYWZ0ZXIgdGhlIHVzZXIgaGFzIGNvbm5lY3RlZC4KICAgIGlmIChTLnN0YXR1cyAhPT0gJ3JlYWR5JykgUy5zdGF0dXMgPSAnbG9hZGluZyc7CiAgICByZW5kZXIoKTsKICAgIGlmIChzdGFsZSkgcmVmcmVzaCgpOwogIH0KCiAgLy8gQW4gYWNjb3VudCBwYW5lbCBsZWZ0IG92ZXIgZnJvbSBlYXJsaWVyIGlzIHJldHJpZWQgcmF0aGVyIHRoYW4gc2hvd24KICAvLyBhZ2FpbjsgaWYgdGhlIHRyb3VibGUgaXMgc3RpbGwgdGhlcmUsIHRoZSBub3Rlcycgb3duIGxvYWQgc2F5cyBzby4KICBmdW5jdGlvbiBzaG93Tm90ZXMoKSB7CiAgICBpZiAoUEFORUxfU1RBVEVTLmhhcyhTLnN0YXR1cykpIFMuc3RhdHVzID0gJ2lkbGUnOwogICAgcmVuZGVyKCk7CiAgICBucy5ub3Rlcy5s",
"b2FkKCk7CiAgICBpZiAoIWZyYW1lIHx8IGZyYW1lLmZvY3VzICE9PSBmYWxzZSkgbnMubm90ZXMuZm9jdXNEZWZhdWx0KCk7CiAgfQoKICAvLyBUaGUgY2FsZW5kYXIgbmVlZHMgbm90aGluZyBvZiBHbWFpbCdzLCBzbyBhIEdtYWlsIHBhbmVsIGlzIG5vIHJlYXNvbgogIC8vIHRvIGtlZXAgaXQgaGlkZGVuOyBvbmx5IGEgbWlzc2luZyBjbGllbnQgSUQgb3IgYWNjb3VudCBzdGFuZHMgaW4gaXRzIHdheS4KICBmdW5jdGlvbiBzaG93Q2FsZW5kYXIoKSB7CiAgICBpZiAoUEFORUxfU1RBVEVTLmhhcyhTLnN0YXR1cykgJiYgUy5zdGF0dXMgIT09ICdub3RfY29uZmlndXJlZCcgJiYgUy5zdGF0dXMgIT09ICdub19hY2NvdW50JykgUy5zdGF0dXMgPSAnaWRsZSc7CiAgICByZW5kZXIoKTsKICAgIG5zLmNhbGVuZGFyLmxvYWQoKTsKICB9CgogIGZ1bmN0aW9uIHN3aXRjaFZpZXcodmlldykgewogICAgaWYgKHZpZXcgPT09IFMudmlldyB8fCAhUy5vcGVuKSByZXR1cm47CiAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnKSBucy5ub3Rlcy5mbHVzaCgpOwogICAgY2xvc2VNZW51KHJvb3QpOwogICAgUy5zZWFyY2ggPSBudWxsOwogICAgUy52aWV3ID0gdmlldzsKICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtLRVlTLnZpZXddOiB2aWV3IH0pLmNhdGNoKCgpID0-IHt9KTsKICAgIGlmICh2aWV3ID09PSAnbm90ZXMnKSBzaG93Tm90ZXMoKTsKICAgIGVsc2UgaWYgKHZpZXcgPT09ICdjYWxlbmRhcicpIHNob3dDYWxl",
"bmRhcigpOwogICAgZWxzZSBzaG93Qm9hcmQoKTsKICB9CgogIC8vIFRoZSBkb2NrJ3MgYnV0dG9uczogb3BlbiBvbiB0aGF0IHRhYiwgc3dpdGNoIHRvIGl0LCBvciAtIHdoZW4gaXQKICAvLyBpcyBhbHJlYWR5IHNob3dpbmcgLSBjbG9zZS4KICBmdW5jdGlvbiB0b2dnbGVWaWV3KHZpZXcpIHsKICAgIGlmIChTLm9wZW4gJiYgUy52aWV3ID09PSB2aWV3KSBjbG9zZSgpOwogICAgZWxzZSBpZiAoUy5vcGVuKSBzd2l0Y2hWaWV3KHZpZXcpOwogICAgZWxzZSBvcGVuKHsgdmlldyB9KTsKICB9CgogIGZ1bmN0aW9uIGNsb3NlKCkgewogICAgLy8gSW4gdGhlIHBob25lIGFwcCB0aGUgYm9hcmQgaXMgdGhlIGFwcDogdGhlcmUgaXMgbm90aGluZyB0byBjbG9zZSB0by4KICAgIGlmICghUy5vcGVuIHx8IGZyYW1lKSByZXR1cm47CiAgICAvLyBXaGF0ZXZlciB3YXMgdHlwZWQgaW4gdGhlIGxhc3Qgc2Vjb25kIG9yIHR3byBpcyBzYXZlZCBvbiB0aGUgd2F5IG91dC4KICAgIG5zLm5vdGVzLmZsdXNoKCk7CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBTLm9wZW4gPSBmYWxzZTsKICAgIFMuc2VhcmNoID0gbnVsbDsKICAgIFMuZHJhd2VyID0gbnVsbDsKICAgIFMuZWRpdG9yID0gbnVsbDsKICAgIHJlbmRlckRyYXdlcigpOwogICAgcmVuZGVyRWRpdG9yKCk7CiAgICBlbHMub3ZlcmxheS5oaWRkZW4gPSB0cnVlOwogICAgLy8gIkNvbHVtbnMgc2F2ZWQiIG1lYW5zIG5vdGhpbmcgb25jZSB0aGUgYm9hcmQgaXMgZ29uZTsgZXJy",
"b3JzIHN0YXkKICAgIC8vIHVudGlsIHJlYWQgb3IgdGltZWQgb3V0LCBzaW5jZSB0aGV5IG1heSBleHBsYWluIGEgY2FyZCB0aGF0IG1vdmVkIGJhY2suCiAgICBmb3IgKGNvbnN0IHQgb2Ygcm9vdC5xdWVyeVNlbGVjdG9yQWxsKCcudG9hc3Q6bm90KC50b2FzdC1lcnJvciknKSkgdC5yZW1vdmUoKTsKICAgIGNsZWFySW50ZXJ2YWwoUy50aWNrZXIpOwogICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uRG9jdW1lbnRLZXksIHRydWUpOwogICAgY29uc3QgYmFjayA9IFMucmV0dXJuRm9jdXM7CiAgICBTLnJldHVybkZvY3VzID0gbnVsbDsKICAgIGlmIChiYWNrICYmIGJhY2suaXNDb25uZWN0ZWQgJiYgdHlwZW9mIGJhY2suZm9jdXMgPT09ICdmdW5jdGlvbicpIGJhY2suZm9jdXMoKTsKICB9CgogIGZ1bmN0aW9uIHRvZ2dsZSgpIHsKICAgIGlmIChTLm9wZW4pIGNsb3NlKCk7CiAgICBlbHNlIG9wZW4oKTsKICB9CgogIC8vIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgc3RvcHMgYXQgYSBzaGFkb3cgaG9zdCAtIHRoZSBkb2NrJ3MsIHdoZW4gdGhlCiAgLy8gYm9hcmQgd2FzIG9wZW5lZCBmcm9tIGl0cyBidXR0b24gLSBhbmQgYSBob3N0IGNhbm5vdCB0YWtlIGZvY3VzIGJhY2suCiAgZnVuY3Rpb24gZGVlcEFjdGl2ZUVsZW1lbnQoKSB7CiAgICBsZXQgYSA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7CiAgICB3aGlsZSAoYSAmJiBhLnNoYWRvd1Jvb3QgJiYgYS5zaGFkb3dSb290LmFjdGl2",
"ZUVsZW1lbnQpIGEgPSBhLnNoYWRvd1Jvb3QuYWN0aXZlRWxlbWVudDsKICAgIHJldHVybiBhOwogIH0KCiAgLy8g4pSA4pSAIEtleWJvYXJkIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBFc2MgcGVlbHMgYmFjayBvbmUgbGF5ZXIgYXQgYSB0aW1lOiBjYXJkIGVkaXRvciBvciBkcmF3ZXIsIHRoZW4KICAvLyBzZWFyY2gsIHRoZW4gYm9hcmQuIE9wZW4gbWVudXMgaGFuZGxlIHRoZWlyIG93biBFc2MgYmVmb3JlIGl0IGdldHMgaGVyZS4KICBmdW5jdGlvbiBvbk92ZXJsYXlLZXkoZSkgewogICAgaWYgKFMudmlldyA9PT0gJ25vdGVzJyAmJiAhUy5lZGl0b3IgJiYgbnMubm90ZXMuaGFuZGxlS2V5KGUpKSByZXR1cm47CiAgICBpZiAoUy52aWV3ID09PSAnY2FsZW5kYXInICYmICFTLmVkaXRvciAmJiAhUy5kcmF3ZXIgJiYgIWlzTWVudU9wZW4ocm9vdCkgJiYgbnMuY2FsZW5kYXIuaGFuZGxlS2V5KGUpKSByZXR1cm47CiAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7CiAgICAgIGlmIChpc01lbnVPcGVuKHJvb3QpKSByZXR1cm47CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgaWYgKFMuZWRpdG9yKSBjbG9zZUVkaXRvcigpOwogICAg",
"ICBlbHNlIGlmIChTLmRyYXdlcikgY2xvc2VEcmF3ZXIoKTsKICAgICAgZWxzZSBpZiAoUy5zZWFyY2gpIGNsb3NlU2VhcmNoKCk7CiAgICAgIGVsc2UgY2xvc2UoKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKGUua2V5ID09PSAnVGFiJyAmJiAhZnJhbWUpIHRyYXBGb2N1cyhlKTsKICB9CgogIC8vIElmIGZvY3VzIGhhcyBlc2NhcGVkIHRvIEdtYWlsJ3MgcGFnZSAoYSBjbGljayBvbiBpdHMgZWRnZSwgc2F5KSwgRXNjCiAgLy8gc2hvdWxkIHN0aWxsIGNsb3NlIHRoZSBib2FyZCByYXRoZXIgdGhhbiByZWFjaCBHbWFpbC4KICBmdW5jdGlvbiBvbkRvY3VtZW50S2V5KGUpIHsKICAgIC8vIEYzIHN0ZXBzIHRocm91Z2ggc2VhcmNoIG1hdGNoZXMgd2hlcmV2ZXIgdGhlIGZvY3VzIGhhcyB3YW5kZXJlZC4KICAgIGlmIChlLmtleSA9PT0gJ0YzJyAmJiBTLm9wZW4gJiYgUy52aWV3ID09PSAnbm90ZXMnICYmICFlLmNvbXBvc2VkUGF0aCgpLmluY2x1ZGVzKGVscy5vdmVybGF5KSkgewogICAgICBucy5ub3Rlcy5oYW5kbGVLZXkoZSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChlLmtleSAhPT0gJ0VzY2FwZScgfHwgIVMub3BlbiB8fCBmcmFtZSkgcmV0dXJuOwogICAgaWYgKGUuY29tcG9zZWRQYXRoKCkuaW5jbHVkZXMoZWxzLm92ZXJsYXkpKSByZXR1cm47CiAgICBpZiAoaXNNZW51T3Blbihyb290KSkgcmV0dXJuOwogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgZS5zdG9wUHJvcGFnYXRpb24oKTsK",
"ICAgIGNsb3NlKCk7CiAgfQoKICAvLyBBIG1vZGFsIHRoYXQgbGV0cyBUYWIgd2FuZGVyIGludG8gdGhlIHBhZ2UgYmVoaW5kIGl0IGlzIG5vdCBtb2RhbC4KICBmdW5jdGlvbiB0cmFwRm9jdXMoZSkgewogICAgY29uc3Qgc2NvcGUgPSBTLmVkaXRvciA_IGVscy5lZGl0b3JMYXllciA6IFMuZHJhd2VyID8gZWxzLmRyYXdlckxheWVyIDogZWxzLm92ZXJsYXk7CiAgICBjb25zdCBmb2N1c2FibGUgPSBbLi4uc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uOm5vdChbZGlzYWJsZWRdKSwgaW5wdXQ6bm90KFtkaXNhYmxlZF0pLCB0ZXh0YXJlYTpub3QoW2Rpc2FibGVkXSknKV0KICAgICAgLmZpbHRlcihlbCA9PiBlbC5nZXRDbGllbnRSZWN0cygpLmxlbmd0aCk7CiAgICBpZiAoIWZvY3VzYWJsZS5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IGZpcnN0ID0gZm9jdXNhYmxlWzBdOwogICAgY29uc3QgbGFzdCA9IGZvY3VzYWJsZVtmb2N1c2FibGUubGVuZ3RoIC0gMV07CiAgICBjb25zdCBhY3RpdmUgPSByb290LmFjdGl2ZUVsZW1lbnQ7CiAgICBpZiAoZS5zaGlmdEtleSAmJiAoYWN0aXZlID09PSBmaXJzdCB8fCAhc2NvcGUuY29udGFpbnMoYWN0aXZlKSkpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBsYXN0LmZvY3VzKCk7IH0KICAgIGVsc2UgaWYgKCFlLnNoaWZ0S2V5ICYmIChhY3RpdmUgPT09IGxhc3QgfHwgIXNjb3BlLmNvbnRhaW5zKGFjdGl2ZSkpKSB7IGUucHJldmVudERlZmF1bHQoKTsgZmlyc3QuZm9jdXMo",
"KTsgfQogIH0KCiAgLy8g4pSA4pSAIExvYWRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHJlZnJlc2goKSB7CiAgICBpZiAoIVMubW91bnRlZCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOwogICAgaWYgKFMubG9hZGluZykgcmV0dXJuIFMubG9hZGluZzsKICAgIGlmICghUy5hY2NvdW50KSBTLmFjY291bnQgPSBob29rcy5nZXRBY2NvdW50KCk7CiAgICBpZiAoIVMuYWNjb3VudCkgewogICAgICBTLnN0YXR1cyA9ICdub19hY2NvdW50JzsKICAgICAgcmVuZGVyKCk7CiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTsKICAgIH0KCiAgICBjb25zdCBzdGFydGVkQXQgPSBTLm11dGF0aW9uczsKICAgIGxldCBvdmVydGFrZW4gPSBmYWxzZTsKCiAgICBTLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4gewogICAgICB1cGRhdGVCYXIoKTsKICAgICAgdHJ5IHsKICAgICAgICBTLmNvbHVtbnMgPSBhd2FpdCBzdG9yZS5sb2FkQ29sdW1ucyhTLmFjY291bnQpOwogICAgICAgIGNvbnN0IFtib2FyZCwgc2F2ZWQsIGVkaXRzXSA9IGF3YWl0IFByb21pc2UuYWxsKFsKICAgICAgICAgIHN0b3JlLmxvYWRCb2FyZChTLmFjY291bnQsIFMu",
"Y29sdW1ucyksCiAgICAgICAgICBzdG9yZS5sb2FkT3JkZXIoUy5hY2NvdW50KSwKICAgICAgICAgIHN0b3JlLmxvYWRDYXJkRWRpdHMoUy5hY2NvdW50KSwKICAgICAgICBdKTsKICAgICAgICBTLmVkaXRzID0gZWRpdHM7CiAgICAgICAgLy8gTGFiZWwgbmFtZXMgYXMgR21haWwgaGFzIHRoZW0gbm93OyBhIGNvbHVtbiBmb2xsb3dzIGEgcmVuYW1lLgogICAgICAgIFMuY29sdW1ucyA9IGJvYXJkLmNvbHVtbnM7CiAgICAgICAgLy8gQSBjYXJkIG1vdmVkIHdoaWxlIHRoZSBsaXN0cyB3ZXJlIGluIGZsaWdodDogd2hhdCBjYW1lIGJhY2sgbWF5CiAgICAgICAgLy8gcHJlZGF0ZSB0aGF0IG1vdmUgYW5kIHdvdWxkIHNuYXAgdGhlIGNhcmQgYmFjay4gVGhyb3cgaXQgYXdheSBhbmQKICAgICAgICAvLyBhc2sgYWdhaW47IGxvYWRCb2FyZCB3YWl0cyBmb3IgdGhlIG1vdmUgdG8gbGFuZCBmaXJzdC4KICAgICAgICBpZiAoUy5tdXRhdGlvbnMgIT09IHN0YXJ0ZWRBdCkgewogICAgICAgICAgb3ZlcnRha2VuID0gdHJ1ZTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgY29uc3QgbGlzdHMgPSB7fTsKICAgICAgICBmb3IgKGNvbnN0IGNvbCBvZiBTLmNvbHVtbnMpIHsKICAgICAgICAgIGNvbnN0IHRocmVhZHMgPSAoYm9hcmQubGlzdHNbY29sLmlkXSB8fCBbXSkubWFwKGlkID0-ICh7IGlkLCB0czogKHN0b3JlLnRocmVhZChpZCkgfHwge30pLnRzIH0pKTsKICAgICAgICAgIGxpc3RzW2NvbC5pZF0gPSBs",
"b2dpYy5tZXJnZU9yZGVyKHNhdmVkW2NvbC5pZF0sIHRocmVhZHMpOwogICAgICAgIH0KICAgICAgICBTLmxpc3RzID0gbGlzdHM7CiAgICAgICAgUy50cnVuY2F0ZWQgPSBib2FyZC50cnVuY2F0ZWQ7CiAgICAgICAgUy5sb2FkZWRBdCA9IERhdGUubm93KCk7CiAgICAgICAgUy5zdGF0dXMgPSAncmVhZHknOwogICAgICAgIFMuc3RhdHVzTWVzc2FnZSA9ICcnOwogICAgICAgIC8vIFNhdmVkIGRpcmVjdGx5LCBub3QgdmlhIHBlcnNpc3RPcmRlcjogdGhpcyBwcnVuZXMgdmFuaXNoZWQgaWRzCiAgICAgICAgLy8gYW5kIGlzIG5vdCBhIGxvY2FsIG1vdmUuCiAgICAgICAgc3RvcmUuc2F2ZU9yZGVyKFMuYWNjb3VudCwgUy5saXN0cywgUy5jb2x1bW5zKS5jYXRjaCgoKSA9PiB7fSk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGhhbmRsZUVycm9yKGVyciwgJ0NvdWxkbuKAmXQgbG9hZCB0aGUgYm9hcmQnKTsKICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBTLmxvYWRpbmcgPSBudWxsOwogICAgICAgIGlmICghb3ZlcnRha2VuKSB7CiAgICAgICAgICByZW5kZXIoKTsKICAgICAgICAgIGlmIChTLnNlYXJjaCAmJiBTLnNlYXJjaC5pZHMgPT09IG51bGwpIHJ1blNlYXJjaCgpOwogICAgICAgIH0KICAgICAgfQogICAgfSkoKTsKICAgIGNvbnN0IHAgPSBTLmxvYWRpbmc7CiAgICByZXR1cm4gcC50aGVuKCgpID0-IChvdmVydGFrZW4gPyByZWZyZXNoKCkgOiB1bmRlZmluZWQpKTsKICB9CgogIC8vIFRoZSB0aHJl",
"ZSBhY2NvdW50IHN0YXRlcyBnZXQgYSBwYW5lbCBvZiB0aGVpciBvd247IGFueXRoaW5nIGVsc2UgaXMKICAvLyBhIHRvYXN0IG92ZXIgd2hhdGV2ZXIgd2FzIGFscmVhZHkgb24gc2NyZWVuLgogIGZ1bmN0aW9uIGhhbmRsZUVycm9yKGVyciwgcHJlZml4KSB7CiAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHsKICAgICAgUy5zdGF0dXMgPSBlcnIuY29kZTsKICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgIFMuc2VhcmNoID0gbnVsbDsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKFMuc3RhdHVzICE9PSAncmVhZHknKSB7CiAgICAgIFMuc3RhdHVzID0gJ2Vycm9yJzsKICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRvYXN0KHJvb3QsIGAke3ByZWZpeH06ICR7ZXJyLm1lc3NhZ2V9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogIH0KCiAgLy8gRXZlcnkgbG9jYWwgY2hhbmdlIHRvIHRoZSBsaXN0cyBnb2VzIHRocm91Z2ggaGVyZSwgd2hpY2ggaXMgYWxzbyB3aGF0CiAgLy8gbWFya3MgYW4gaW4tZmxpZ2h0IHJlZnJlc2ggYXMgb3ZlcnRha2VuLgogIGZ1bmN0aW9uIHBlcnNpc3RPcmRlcigpIHsKICAgIFMubXV0YXRpb25zKys7CiAgICBzdG9yZS5zYXZlT3JkZXIoUy5hY2NvdW50LCBTLmxpc3RzLCBTLmNvbHVtbnMpLmNhdGNoKCgpID0-IHt9KTsKICB9CgogIC8vIOKUgOKUgCBSZW5kZXJpbmcg4pSA4pSA",
"4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHVwZGF0ZUJhcigpIHsKICAgIGlmICghUy5tb3VudGVkKSByZXR1cm47CiAgICBlbHMuYWNjb3VudC50ZXh0Q29udGVudCA9IFMuYWNjb3VudCB8fCAnQWNjb3VudCBub3QgZGV0ZWN0ZWQnOwogICAgZWxzLmFjY291bnQudGl0bGUgPSBTLmFjY291bnQgPyBgR21haWwgYWNjb3VudDogJHtTLmFjY291bnR9YCA6ICcnOwogICAgLy8gVGhlIHJlZnJlc2ggYnV0dG9uIGFuZCAidXBkYXRlZCDigKYiIHNwZWFrIGZvciB3aGljaGV2ZXIgdGFiIGlzIG9wZW4uCiAgICBjb25zdCBub3RlcyA9IFMudmlldyA9PT0gJ25vdGVzJzsKICAgIGNvbnN0IGNhbGVuZGFyID0gUy52aWV3ID09PSAnY2FsZW5kYXInOwogICAgY29uc3QgbG9hZGluZyA9IG5vdGVzID8gbnMubm90ZXMuaXNMb2FkaW5nKCkgOiBjYWxlbmRhciA_IG5zLmNhbGVuZGFyLmlzTG9hZGluZygpIDogISFTLmxvYWRpbmc7CiAgICBjb25zdCBsb2FkZWRBdCA9IG5vdGVzID8gbnMubm90ZXMubG9hZGVkQXQoKSA6IGNhbGVuZGFyID8gbnMuY2FsZW5kYXIubG9hZGVkQXQoKSA6IFMubG9hZGVkQXQ7CiAgICBlbHMudXBkYXRlZC50ZXh0Q29udGVudCA9IGxvYWRp",
"bmcgPyAnVXBkYXRpbmfigKYnCiAgICAgIDogbG9hZGVkQXQgPyBgdXBkYXRlZCAke3V0aWwuYWdvVGV4dChEYXRlLm5vdygpIC0gbG9hZGVkQXQpfWAgOiAnJzsKICAgIGVscy5yZWZyZXNoLmNsYXNzTGlzdC50b2dnbGUoJ3NwaW5uaW5nJywgbG9hZGluZyk7CiAgICBlbHMucmVmcmVzaC5kaXNhYmxlZCA9IGxvYWRpbmcgfHwgIVMuYWNjb3VudDsKICAgIGVscy5zZXR0aW5ncy5oaWRkZW4gPSBub3RlcyB8fCBjYWxlbmRhcjsKICAgIGVscy5zZXR0aW5ncy5kaXNhYmxlZCA9IFMuc3RhdHVzICE9PSAncmVhZHknOwogICAgZm9yIChjb25zdCB0IG9mIGVscy50YWJzLmNoaWxkcmVuKSB0LnNldEF0dHJpYnV0ZSgnYXJpYS1zZWxlY3RlZCcsIFN0cmluZyh0LmRhdGFzZXQudmlldyA9PT0gUy52aWV3KSk7CiAgICBpZiAobm90ZXMpIG5zLm5vdGVzLnRpY2soKTsKICAgIGlmIChjYWxlbmRhcikgbnMuY2FsZW5kYXIudGljaygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyKCkgewogICAgaWYgKCFTLm1vdW50ZWQpIHJldHVybjsKICAgIC8vIFJlYnVpbGRpbmcgdGhlIGNvbHVtbnMgbWlkLWRyYWcgd291bGQgcHVsbCB0aGUgY2FyZCBvdXQgZnJvbSB1bmRlcgogICAgLy8gdGhlIHBvaW50ZXIuIFdoYXRldmVyIGNoYW5nZWQgaXMgZHJhd24gb25jZSB0aGUgZHJhZyBlbmRzLgogICAgaWYgKFMuZHJhZykgeyBTLnJlbmRlckRlZmVycmVkID0gdHJ1ZTsgcmV0dXJuOyB9CgogICAgdXBkYXRlQmFyKCk7CiAgICBjbG9zZU1lbnUo",
"cm9vdCk7CgogICAgY29uc3Qga2V5ID0gZm9jdXNLZXkoKTsKICAgIGNvbnN0IHNjcm9sbCA9IGNhcHR1cmVTY3JvbGwoKTsKICAgIC8vIFRoZSBub3RlcyB2aWV3IGhhbmRzIGJhY2sgdGhlIHNhbWUgZWxlbWVudCBldmVyeSB0aW1lOyBwdXR0aW5nIGl0CiAgICAvLyBiYWNrIHdvdWxkIGJsdXIgdGhlIHRleHQgYm94IG1pZC1zZW50ZW5jZSwgc28gaXQgaXMgbGVmdCBpbiBwbGFjZS4KICAgIGNvbnN0IG5leHQgPSByZW5kZXJCb2R5KCk7CiAgICBpZiAoZWxzLmJvZHkuZmlyc3RDaGlsZCAhPT0gbmV4dCB8fCBlbHMuYm9keS5jaGlsZE5vZGVzLmxlbmd0aCAhPT0gMSkgZWxzLmJvZHkucmVwbGFjZUNoaWxkcmVuKG5leHQpOwogICAgcmVzdG9yZVNjcm9sbChzY3JvbGwpOwogICAgcmVzdG9yZUZvY3VzKGtleSwgZWxzLmJvZHkpOwogICAgLy8gVGhlIGZvY3VzZWQgY2FyZCBtYXkgYmUgZ29uZSAocmVtb3ZlZCwgb3IgbW92ZWQgb2ZmIGEgY29sdW1uIHRoYXQKICAgIC8vIHJlLXJlbmRlcmVkKS4gS2VlcCBmb2N1cyBpbiB0aGUgZGlhbG9nIHJhdGhlciB0aGFuIGRyb3BwaW5nIGl0IG9uCiAgICAvLyBHbWFpbCdzIHBhZ2UsIHdoZXJlIHRoZSBuZXh0IGtleSBwcmVzcyB3b3VsZCBiZSBHbWFpbCdzLgogICAgaWYgKGtleSAmJiBTLm9wZW4gJiYgIWVscy5vdmVybGF5LmNvbnRhaW5zKHJvb3QuYWN0aXZlRWxlbWVudCkpIGVscy5vdmVybGF5LmZvY3VzKCk7CiAgfQoKICBmdW5jdGlvbiBmb2N1c0tleSgpIHsKICAgIGNv",
"bnN0IGEgPSByb290LmFjdGl2ZUVsZW1lbnQ7CiAgICByZXR1cm4gYSAmJiBhLmRhdGFzZXQgPyBhLmRhdGFzZXQua2V5IHx8ICcnIDogJyc7CiAgfQoKICBmdW5jdGlvbiByZXN0b3JlRm9jdXMoa2V5LCBzY29wZSkgewogICAgaWYgKCFrZXkpIHJldHVybjsKICAgIGNvbnN0IGVsID0gWy4uLnNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWtleV0nKV0uZmluZCh4ID0-IHguZGF0YXNldC5rZXkgPT09IGtleSk7CiAgICBpZiAoIWVsIHx8IGVsLmRpc2FibGVkKSByZXR1cm47CiAgICBlbC5mb2N1cyh7IHByZXZlbnRTY3JvbGw6IHRydWUgfSk7CiAgICBpZiAoZWwudGFnTmFtZSA9PT0gJ0lOUFVUJyAmJiBlbC50eXBlICE9PSAnY2hlY2tib3gnKSB7CiAgICAgIGNvbnN0IG4gPSBlbC52YWx1ZS5sZW5ndGg7CiAgICAgIHRyeSB7IGVsLnNldFNlbGVjdGlvblJhbmdlKG4sIG4pOyB9IGNhdGNoIHsgLyogbm90IGEgdGV4dCBpbnB1dCAqLyB9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBjYXB0dXJlU2Nyb2xsKCkgewogICAgY29uc3Qgb3V0ID0geyBsZWZ0OiAwLCBsaXN0czoge30gfTsKICAgIGNvbnN0IGNvbHMgPSBlbHMuYm9keS5xdWVyeVNlbGVjdG9yKCcuY29sdW1ucycpOwogICAgaWYgKCFjb2xzKSByZXR1cm4gb3V0OwogICAgb3V0LmxlZnQgPSBjb2xzLnNjcm9sbExlZnQ7CiAgICBmb3IgKGNvbnN0IHNlYyBvZiBjb2xzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2x1bW4nKSkgewogICAgICBjb25zdCBsaXN0ID0g",
"c2VjLnF1ZXJ5U2VsZWN0b3IoJy5saXN0Jyk7CiAgICAgIGlmIChsaXN0KSBvdXQubGlzdHNbc2VjLmRhdGFzZXQuY29sXSA9IGxpc3Quc2Nyb2xsVG9wOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIHJlc3RvcmVTY3JvbGwocykgewogICAgY29uc3QgY29scyA9IGVscy5ib2R5LnF1ZXJ5U2VsZWN0b3IoJy5jb2x1bW5zJyk7CiAgICBpZiAoIWNvbHMpIHJldHVybjsKICAgIGNvbHMuc2Nyb2xsTGVmdCA9IHMubGVmdDsKICAgIGZvciAoY29uc3Qgc2VjIG9mIGNvbHMucXVlcnlTZWxlY3RvckFsbCgnLmNvbHVtbicpKSB7CiAgICAgIGNvbnN0IGxpc3QgPSBzZWMucXVlcnlTZWxlY3RvcignLmxpc3QnKTsKICAgICAgaWYgKGxpc3QgJiYgcy5saXN0c1tzZWMuZGF0YXNldC5jb2xdKSBsaXN0LnNjcm9sbFRvcCA9IHMubGlzdHNbc2VjLmRhdGFzZXQuY29sXTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckJvZHkoKSB7CiAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnICYmICFQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSkgcmV0dXJuIG5zLm5vdGVzLmVsZW1lbnQoKTsKICAgIGlmIChTLnZpZXcgPT09ICdjYWxlbmRhcicgJiYgIVBBTkVMX1NUQVRFUy5oYXMoUy5zdGF0dXMpKSByZXR1cm4gbnMuY2FsZW5kYXIuZWxlbWVudCgpOwogICAgc3dpdGNoIChTLnN0YXR1cykgewogICAgICBjYXNlICdub19hY2NvdW50JzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2JvYXJkJywgJ1doaWNoIGFjY291",
"bnQgaXMgdGhpcz8nLAogICAgICAgICAgYCR7QVBQX05BTUV9IGNvdWxkbuKAmXQgdGVsbCB3aGljaCBHb29nbGUgYWNjb3VudCB0aGlzIEdtYWlsIHRhYiBiZWxvbmdzIHRvLCBzbyBpdCBkb2VzbuKAmXQga25vdyB3aG9zZSBib2FyZCB0byBzaG93LiBSZWxvYWRpbmcgR21haWwgdXN1YWxseSBzb3J0cyBpdCBvdXQuYCwKICAgICAgICAgIFtdKTsKICAgICAgY2FzZSAnbm90X2NvbmZpZ3VyZWQnOgogICAgICAgIHJldHVybiBwYW5lbCgndHVuZScsICdGaW5pc2ggc2V0dGluZyB1cCcsCiAgICAgICAgICAnQWRkIHlvdXIgT0F1dGggY2xpZW50IElEIG9uIHRoZSBzZXR1cCBwYWdlLiBJdCBpcyBhIG9uZS1vZmYgYW5kIHRha2VzIGEgY291cGxlIG9mIG1pbnV0ZXMuJywKICAgICAgICAgIFtidXR0b24oJ09wZW4gc2V0dXAnLCAncHJpbWFyeScsICgpID0-IGFwaS5vcGVuT3B0aW9ucygpLmNhdGNoKGVyciA9PiB0b2FzdChyb290LCBlcnIubWVzc2FnZSwgeyBraW5kOiAnZXJyb3InIH0pKSldKTsKICAgICAgY2FzZSAnYXV0aF9yZXF1aXJlZCc6CiAgICAgICAgcmV0dXJuIHBhbmVsKCdib2FyZCcsICdDb25uZWN0IEdtYWlsJywKICAgICAgICAgIGBBbGxvdyAke0FQUF9OQU1FfSB0byByZWFkIGFuZCBsYWJlbCBtYWlsIGluICR7Uy5hY2NvdW50fS4gR29vZ2xlIHdpbGwgYXNrIHlvdSB0byBjb25maXJtLmAsCiAgICAgICAgICBbYnV0dG9uKCdDb25uZWN0IEdtYWlsJywgJ3ByaW1hcnknLCBjb25uZWN0KV0pOwogICAg",
"ICBjYXNlICdhY2NvdW50X21pc21hdGNoJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2JvYXJkJywgJ1RoYXQgd2FzIGEgZGlmZmVyZW50IGFjY291bnQnLAogICAgICAgICAgYCR7Uy5zdGF0dXNNZXNzYWdlfSBUaGUgYm9hcmQgb25seSBldmVyIGFjdHMgb24gdGhlIG1haWxib3ggb3BlbiBpbiB0aGlzIHRhYi4gQ29ubmVjdCBhZ2FpbiBhbmQgY2hvb3NlICR7Uy5hY2NvdW50fS5gLAogICAgICAgICAgW2J1dHRvbignQ29ubmVjdCBhZ2FpbicsICdwcmltYXJ5JywgY29ubmVjdCldKTsKICAgICAgY2FzZSAnZXJyb3InOgogICAgICAgIHJldHVybiBwYW5lbCgncmVmcmVzaCcsICdDb3VsZG7igJl0IGxvYWQgdGhlIGJvYXJkJywgUy5zdGF0dXNNZXNzYWdlLAogICAgICAgICAgW2J1dHRvbignVHJ5IGFnYWluJywgJ3ByaW1hcnknLCAoKSA9PiByZWZyZXNoKCkpXSk7CiAgICAgIGRlZmF1bHQ6CiAgICAgICAgcmV0dXJuIHJlbmRlckNvbHVtbnMoKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHBhbmVsKGljb25OYW1lLCB0aXRsZSwgdGV4dCwgYWN0aW9ucykgewogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdwYW5lbCcsIHJvbGU6ICdyZWdpb24nLCAnYXJpYS1sYWJlbCc6IHRpdGxlIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncGFuZWwtaWNvbicgfSwgaWNvbihpY29uTmFtZSwgMjgpKSwKICAgICAgaCgnaDInLCB7IHRleHQ6IHRpdGxlIH0pLAogICAgICBoKCdwJywgeyB0ZXh0IH0pLAogICAgICBhY3Rp",
"b25zLmxlbmd0aCA_IGgoJ2RpdicsIHsgY2xhc3M6ICdhY3Rpb25zJyB9LCBhY3Rpb25zKSA6IG51bGwpOwogIH0KCiAgZnVuY3Rpb24gYnV0dG9uKGxhYmVsLCBraW5kLCBvbkNsaWNrKSB7CiAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogWydidG4nLCBgYnRuLSR7a2luZH1gXSwgdHlwZTogJ2J1dHRvbicsIHRleHQ6IGxhYmVsLAogICAgICBvbmNsaWNrOiBlID0-IG9uQ2xpY2soZS5jdXJyZW50VGFyZ2V0KSwKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gY29ubmVjdChidG4pIHsKICAgIGlmIChidG4pIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkuY29ubmVjdCgpOwogICAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnKSB7CiAgICAgICAgUy5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgYXdhaXQgbnMubm90ZXMubG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBTLnN0YXR1cyA9ICdsb2FkaW5nJzsKICAgICAgcmVuZGVyKCk7CiAgICAgIGF3YWl0IHJlZnJlc2goKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAoZXJyLmNvZGUgPT09ICdhY2NvdW50X21pc21hdGNoJyB8fCBlcnIuY29kZSA9PT0gJ25vdF9jb25maWd1cmVkJykgewogICAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgICAg",
"cmVuZGVyKCk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdG9hc3Qocm9vdCwgYENvdWxkbuKAmXQgY29ubmVjdDogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgIH0KICAgIH0gZmluYWxseSB7CiAgICAgIGlmIChidG4gJiYgYnRuLmlzQ29ubmVjdGVkKSBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckNvbHVtbnMoKSB7CiAgICBjb25zdCBza2VsZXRvbiA9IFMuc3RhdHVzICE9PSAncmVhZHknOwogICAgY29uc3Qgd3JhcCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjb2x1bW5zJyB9KTsKICAgIGZvciAoY29uc3QgY29sIG9mIFMuY29sdW1ucykgd3JhcC5hcHBlbmRDaGlsZChyZW5kZXJDb2x1bW4oY29sLCBza2VsZXRvbikpOwogICAgd3JhcC5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsIG9uRHJhZ092ZXIpOwogICAgd3JhcC5hZGRFdmVudExpc3RlbmVyKCdkcm9wJywgb25Ecm9wKTsKICAgIHJldHVybiB3cmFwOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQ29sdW1uKGNvbCwgc2tlbGV0b24pIHsKICAgIGNvbnN0IGlkcyA9IFMubGlzdHNbY29sLmlkXSB8fCBbXTsKICAgIGNvbnN0IHNlYXJjaGluZyA9ICEhKFMuc2VhcmNoICYmIFMuc2VhcmNoLmNvbElkID09PSBjb2wuaWQpOwoKICAgIGNvbnN0IGxpc3QgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbGlzdCcsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiBgJHtjb2wudGl0bGV9OiB0",
"aHJlYWRzYCwKICAgICAgJ2RhdGEtZW1wdHknOiAnRHJhZyB0aHJlYWRzIGhlcmUsIG9yIHVzZSArIHRvIGZpbmQgb25lJywKICAgIH0pOwogICAgaWYgKHNrZWxldG9uKSB7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSBsaXN0LmFwcGVuZENoaWxkKGgoJ2RpdicsIHsgY2xhc3M6ICdza2VsZXRvbicsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KSk7CiAgICB9IGVsc2UgewogICAgICBmb3IgKGNvbnN0IGlkIG9mIGlkcykgewogICAgICAgIGNvbnN0IGNhcmQgPSByZW5kZXJDYXJkKGlkLCBjb2wpOwogICAgICAgIGlmIChjYXJkKSBsaXN0LmFwcGVuZENoaWxkKGNhcmQpOwogICAgICB9CiAgICB9CgogICAgY29uc3QgY291bnQgPSBTLnRydW5jYXRlZFtjb2wuaWRdID8gYCR7aWRzLmxlbmd0aH0rYCA6IFN0cmluZyhpZHMubGVuZ3RoKTsKICAgIGNvbnN0IGhlYWQgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY29sLWhlYWQnIH0sCiAgICAgIGgoJ2gyJywgeyBjbGFzczogJ2NvbC10aXRsZScsIHRleHQ6IGNvbC50aXRsZSwgdGl0bGU6IGBHbWFpbCBsYWJlbDogJHtjb2wubGFiZWx9YCB9KSwKICAgICAgc2tlbGV0b24gPyBudWxsIDogaCgnc3BhbicsIHsgY2xhc3M6ICdjb2wtY291bnQnLCB0ZXh0OiBjb3VudCwgJ2FyaWEtbGFiZWwnOiBgJHtjb3VudH0gdGhyZWFkc2AgfSksCiAgICAgIGNvbC5hcmNoaXZlT25Ecm9wID8gaCgnc3BhbicsIHsKICAgICAgICBjbGFzczogJ2NvbC1mbGFnJywgdGV4dDogJ0Fy",
"Y2hpdmVzJywKICAgICAgICB0aXRsZTogJ01vdmluZyBhIHRocmVhZCBoZXJlIGFsc28gYXJjaGl2ZXMgaXQgKHRha2VzIGl0IG91dCBvZiB0aGUgSW5ib3gpJywKICAgICAgfSkgOiBudWxsLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc3BhY2VyJyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywKICAgICAgICAnYXJpYS1sYWJlbCc6IGBGaW5kIGEgdGhyZWFkIHRvIGFkZCB0byAke2NvbC50aXRsZX1gLCB0aXRsZTogJ0FkZCBmcm9tIEdtYWlsJywKICAgICAgICAnYXJpYS1leHBhbmRlZCc6IFN0cmluZyhzZWFyY2hpbmcpLCBkaXNhYmxlZDogc2tlbGV0b24sCiAgICAgICAgZGF0YXNldDogeyBrZXk6IGBhZGQ6JHtjb2wuaWR9YCwgYWN0aW9uOiAnYWRkJyB9LAogICAgICAgIG9uY2xpY2s6ICgpID0-IHRvZ2dsZVNlYXJjaChjb2wuaWQpLAogICAgICB9LCBpY29uKHNlYXJjaGluZyA_ICdjbG9zZScgOiAnYWRkJykpKTsKCiAgICByZXR1cm4gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdjb2x1bW4nLCAnYXJpYS1sYWJlbCc6IGNvbC50aXRsZSwgZGF0YXNldDogeyBjb2w6IGNvbC5pZCB9IH0sCiAgICAgIGhlYWQsCiAgICAgIFMudHJ1bmNhdGVkW2NvbC5pZF0gPyBoKCdkaXYnLCB7IGNsYXNzOiAnY29sLW5vdGUnLCB0ZXh0OiAnU2hvd2luZyB0aGUgZmlyc3QgMTAwIHRocmVhZHMnIH0pIDogbnVsbCwKICAgICAgc2VhcmNoaW5nID8gcmVuZGVy",
"U2VhcmNoKGNvbCkgOiBudWxsLAogICAgICBsaXN0KTsKICB9CgogIC8vIEEgY2FyZCBzaG93cyB0aGUgdXNlcidzIG93biB0aXRsZSBhbmQgbm90ZSB3aGVuIGl0IGhhcyB0aGVtLiBUaGUKICAvLyBlbWFpbCdzIHN1YmplY3Qgc3RheXMgb25lIGhvdmVyIGF3YXksIHNvIGEgcmVuYW1lZCBjYXJkIGNhbiBhbHdheXMgYmUKICAvLyBtYXRjaGVkIHRvIHRoZSBtYWlsIGJlaGluZCBpdC4KICBmdW5jdGlvbiByZW5kZXJDYXJkKGlkLCBjb2wpIHsKICAgIGNvbnN0IHQgPSBzdG9yZS50aHJlYWQoaWQpOwogICAgaWYgKCF0KSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGRhdGUgPSB1dGlsLnJlbGF0aXZlRGF0ZSh0LnRzKTsKICAgIGNvbnN0IGVkaXQgPSBTLmVkaXRzLmdldChpZCkgfHwgbnVsbDsKICAgIGNvbnN0IHRpdGxlID0gbG9naWMuZGlzcGxheVRpdGxlKHQsIGVkaXQpOwoKICAgIGNvbnN0IG1haW4gPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnY2FyZC1tYWluJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiBgY2FyZDoke2lkfWAgfSwKICAgICAgdGl0bGU6IGVkaXQgJiYgZWRpdC50aXRsZQogICAgICAgID8gYEVtYWlsIHN1YmplY3Q6ICR7dC5zdWJqZWN0fVxuT3BlbiBpbiBHbWFpbCAoQ3RybC1jbGljayBmb3IgYSBuZXcgdGFiKWAKICAgICAgICA6ICdPcGVuIGluIEdtYWlsIChDdHJsLWNsaWNrIGZvciBhIG5ldyB0YWIpJywKICAgICAgb25jbGljazogZSA9PiBvcGVuVGhyZWFkKGlkLCBl",
"KSwKICAgICAgb25hdXhjbGljazogZSA9PiB7IGlmIChlLmJ1dHRvbiA9PT0gMSkgeyBlLnByZXZlbnREZWZhdWx0KCk7IG9wZW5UaHJlYWQoaWQsIHsgY3RybEtleTogdHJ1ZSB9KTsgfSB9LAogICAgfSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdjYXJkLXRvcCcgfSwKICAgICAgICB0LnVucmVhZCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZG90JywgdGl0bGU6ICdVbnJlYWQnIH0pIDogbnVsbCwKICAgICAgICB0LnVucmVhZCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3Itb25seScsIHRleHQ6ICdVbnJlYWQuICcgfSkgOiBudWxsLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZnJvbScsIHRleHQ6IHQuZnJvbSB9KSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RhdGUnLCB0ZXh0OiBkYXRlLCB0aXRsZTogdXRpbC5mdWxsRGF0ZSh0LnRzKSB9KSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3ViamVjdC1yb3cnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdzdWJqZWN0JywgdGV4dDogdGl0bGUgfSksCiAgICAgICAgdC5oYXNEcmFmdCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZHJhZnQnLCB0ZXh0OiAnRHJhZnQnIH0pIDogbnVsbCwKICAgICAgICB0LnN0YXJyZWQgPyBoKCdzcGFuJywgeyBjbGFzczogJ3N0YXInLCB0aXRsZTogJ1N0YXJyZWQnLCAnYXJpYS1sYWJlbCc6ICdTdGFycmVkJyB9LCBpY29uKCdzdGFyJywgMTYpKSA6IG51bGwsCiAgICAgICAgdC5jb3VudCA-IDEgPyBoKCdz",
"cGFuJywgeyBjbGFzczogJ2NvdW50JywgdGV4dDogU3RyaW5nKHQuY291bnQpLCB0aXRsZTogYCR7dC5jb3VudH0gbWVzc2FnZXNgIH0pIDogbnVsbCksCiAgICAgIGVkaXQgJiYgZWRpdC5ub3RlCiAgICAgICAgPyBoKCdzcGFuJywgeyBjbGFzczogJ2NhcmQtbm90ZScgfSwgaCgnc3BhbicsIHsgY2xhc3M6ICdzci1vbmx5JywgdGV4dDogJ05vdGU6ICcgfSksIGVkaXQubm90ZSkKICAgICAgICA6IHQuc25pcHBldCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnc25pcHBldCcsIHRleHQ6IHQuc25pcHBldCB9KSA6IG51bGwpOwoKICAgIGNvbnN0IG1vcmUgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnaWNvbi1idG4gY2FyZC1tZW51JywgdHlwZTogJ2J1dHRvbicsCiAgICAgICdhcmlhLWxhYmVsJzogYE1vcmUgYWN0aW9uczogJHt0aXRsZX1gLCB0aXRsZTogJ01vcmUgYWN0aW9ucycsCiAgICAgICdhcmlhLWhhc3BvcHVwJzogJ21lbnUnLCAnYXJpYS1leHBhbmRlZCc6ICdmYWxzZScsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgbWVudToke2lkfWAgfSwKICAgICAgb25jbGljazogZSA9PiBvcGVuQ2FyZE1lbnUoZS5jdXJyZW50VGFyZ2V0LCBpZCwgY29sLmlkKSwKICAgIH0sIGljb24oJ21vcmUnLCAyMCkpOwoKICAgIGNvbnN0IGNhcmQgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiBbJ2NhcmQnLCB0LnVucmVhZCAmJiAndW5yZWFkJ10sIHJvbGU6ICdsaXN0aXRlbScsIGRyYWdnYWJsZTogJ3RydWUnLAogICAgICBk",
"YXRhc2V0OiBlZGl0ICYmIGVkaXQuY29sb3VyID8geyBpZCwgY29sb3VyOiBlZGl0LmNvbG91ciB9IDogeyBpZCB9LAogICAgfSwgbWFpbiwgbW9yZSk7CiAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIGUgPT4gb25EcmFnU3RhcnQoZSwgaWQsIGNvbC5pZCwgY2FyZCkpOwogICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgb25EcmFnRW5kKTsKICAgIHJldHVybiBjYXJkOwogIH0KCiAgZnVuY3Rpb24gYW5ub3VuY2UobXNnKSB7CiAgICBlbHMubGl2ZS50ZXh0Q29udGVudCA9IG1zZzsKICB9CgogIC8vIOKUgOKUgCBDYXJkIGFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG9wZW5UaHJlYWQoaWQsIGUpIHsKICAgIGlmIChlICYmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuc2hpZnRLZXkpKSB7CiAgICAgIHdpbmRvdy5vcGVuKGhvb2tzLnRocmVhZFVybChpZCksICdfYmxhbmsnLCAnbm9vcGVuZXInKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY2xvc2UoKTsKICAgIGhvb2tzLm9wZW5UaHJlYWQoaWQpOwogIH0KCiAgZnVuY3Rpb24gY29sdW1uT2YoaWQpIHsKICAgIHJldHVybiBTLmNvbHVtbnMuZmlu",
"ZChjID0-IChTLmxpc3RzW2MuaWRdIHx8IFtdKS5pbmNsdWRlcyhpZCkpIHx8IG51bGw7CiAgfQoKICBmdW5jdGlvbiBjYXJkVGl0bGUoaWQpIHsKICAgIHJldHVybiBsb2dpYy5kaXNwbGF5VGl0bGUoc3RvcmUudGhyZWFkKGlkKSwgUy5lZGl0cy5nZXQoaWQpKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5DYXJkTWVudShhbmNob3IsIGlkLCBjb2xJZCkgewogICAgY29uc3QgbGlzdCA9IFMubGlzdHNbY29sSWRdIHx8IFtdOwogICAgY29uc3QgYXQgPSBsaXN0LmluZGV4T2YoaWQpOwogICAgb3Blbk1lbnUocm9vdCwgYW5jaG9yLCBbCiAgICAgIHsgbGFiZWw6ICdPcGVuIGluIEdtYWlsJywgaWNvbjogJ29wZW4nLCBrZXk6ICdvcGVuJywgb25TZWxlY3Q6ICgpID0-IG9wZW5UaHJlYWQoaWQpIH0sCiAgICAgIHsgbGFiZWw6ICdFZGl0IGNhcmTigKYnLCBpY29uOiAnZWRpdCcsIGtleTogJ2VkaXQnLCBvblNlbGVjdDogKCkgPT4gb3BlbkVkaXRvcihpZCkgfSwKICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgLy8gUmVvcmRlcmluZyBpcyBhIGRyYWcgb3RoZXJ3aXNlOyB0aGVzZSBrZWVwIGl0IHdpdGhpbiByZWFjaCBvZiB0aGUKICAgICAgLy8ga2V5Ym9hcmQuIEZvY3VzIHJldHVybnMgdG8gdGhpcyBjYXJkJ3MgbWVudSBidXR0b24gYWZ0ZXJ3YXJkcywgc28KICAgICAgLy8gcmVwZWF0ZWQgcHJlc3NlcyBrZWVwIG1vdmluZyB0aGUgc2FtZSBjYXJkLgogICAgICB7IGxhYmVsOiAnTW92ZSB1cCcsIGljb246ICd1",
"cCcsIGtleTogJ3VwJywgZGlzYWJsZWQ6IGF0IDw9IDAsIG9uU2VsZWN0OiAoKSA9PiBtb3ZlVGhyZWFkKGlkLCBjb2xJZCwgY29sSWQsIGF0IC0gMSkgfSwKICAgICAgeyBsYWJlbDogJ01vdmUgZG93bicsIGljb246ICdkb3duJywga2V5OiAnZG93bicsIGRpc2FibGVkOiBhdCA8IDAgfHwgYXQgPj0gbGlzdC5sZW5ndGggLSAxLCBvblNlbGVjdDogKCkgPT4gbW92ZVRocmVhZChpZCwgY29sSWQsIGNvbElkLCBhdCArIDEpIH0sCiAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgIHsgaGVhZGluZzogJ01vdmUgdG8nIH0sCiAgICAgIC4uLlMuY29sdW1ucy5tYXAoYyA9PiAoewogICAgICAgIGxhYmVsOiBjLnRpdGxlLAogICAgICAgIGNoZWNrZWQ6IGMuaWQgPT09IGNvbElkLAogICAgICAgIGRpc2FibGVkOiBjLmlkID09PSBjb2xJZCwKICAgICAgICBrZXk6IGBtb3ZlOiR7Yy5pZH1gLAogICAgICAgIG9uU2VsZWN0OiAoKSA9PiBtb3ZlVGhyZWFkKGlkLCBjb2xJZCwgYy5pZCwgMCksCiAgICAgIH0pKSwKICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgeyBsYWJlbDogJ1JlbW92ZSBmcm9tIGJvYXJkJywgaWNvbjogJ3JlbW92ZScsIGRhbmdlcjogdHJ1ZSwga2V5OiAncmVtb3ZlJywgb25TZWxlY3Q6ICgpID0-IHJlbW92ZVRocmVhZChpZCkgfSwKICAgIF0sIHsgbGFiZWw6IGBBY3Rpb25zIGZvciAke2NhcmRUaXRsZShpZCl9YCB9KTsKICB9CgogIC8vIE9wdGltaXN0aWM6IHRoZSBjYXJkIG1vdmVz",
"IG5vdywgYW5kIG9ubHkgdGhpcyBjYXJkIG1vdmVzIGJhY2sgaWYKICAvLyBHbWFpbCByZWZ1c2VzIC0gb3RoZXIgbW92ZXMgbWFkZSBpbiB0aGUgbWVhbnRpbWUgYXJlIGxlZnQgYWxvbmUuCiAgYXN5bmMgZnVuY3Rpb24gbW92ZVRocmVhZChpZCwgZnJvbUNvbCwgdG9Db2wsIGluZGV4KSB7CiAgICBjb25zdCBmcm9tID0gUy5saXN0c1tmcm9tQ29sXSB8fCBbXTsKICAgIGNvbnN0IG9yaWdpbmFsSW5kZXggPSBmcm9tLmluZGV4T2YoaWQpOwoKICAgIGlmIChmcm9tQ29sID09PSB0b0NvbCkgewogICAgICBTLmxpc3RzW3RvQ29sXSA9IGxvZ2ljLnBsYWNlSWQoZnJvbSwgaWQsIGluZGV4KTsKICAgICAgcGVyc2lzdE9yZGVyKCk7CiAgICAgIHJlbmRlcigpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3QgdGFyZ2V0ID0gUy5jb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSB0b0NvbCk7CiAgICBTLmxpc3RzW2Zyb21Db2xdID0gZnJvbS5maWx0ZXIoeCA9PiB4ICE9PSBpZCk7CiAgICBTLmxpc3RzW3RvQ29sXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1t0b0NvbF0sIGlkLCBpbmRleCk7CiAgICBwZXJzaXN0T3JkZXIoKTsKICAgIHJlbmRlcigpOwogICAgYW5ub3VuY2UoYE1vdmVkIHRvICR7dGFyZ2V0LnRpdGxlfSR7dGFyZ2V0LmFyY2hpdmVPbkRyb3AgPyAnIGFuZCBhcmNoaXZlZCcgOiAnJ30uYCk7CgogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUubW92ZVRvQ29sdW1uKGlkLCBTLmNvbHVtbnMsIHRvQ29s",
"LCAnYm9hcmQnKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW3RvQ29sXSA9IChTLmxpc3RzW3RvQ29sXSB8fCBbXSkuZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgICBpZiAoUy5saXN0c1tmcm9tQ29sXSkgUy5saXN0c1tmcm9tQ29sXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1tmcm9tQ29sXSwgaWQsIE1hdGgubWF4KDAsIG9yaWdpbmFsSW5kZXgpKTsKICAgICAgcGVyc2lzdE9yZGVyKCk7CiAgICAgIHJlbmRlcigpOwogICAgICBmYWlsVG9hc3QoJ21vdmUnLCBpZCwgZXJyKTsKICAgIH0KICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJlbW92ZVRocmVhZChpZCkgewogICAgY29uc3QgY29sID0gY29sdW1uT2YoaWQpOwogICAgaWYgKCFjb2wpIHJldHVybjsKICAgIGNvbnN0IG9yaWdpbmFsSW5kZXggPSBTLmxpc3RzW2NvbC5pZF0uaW5kZXhPZihpZCk7CiAgICBTLmxpc3RzW2NvbC5pZF0gPSBTLmxpc3RzW2NvbC5pZF0uZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgcGVyc2lzdE9yZGVyKCk7CiAgICByZW5kZXIoKTsKICAgIGFubm91bmNlKCdSZW1vdmVkIGZyb20gdGhlIGJvYXJkLicpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUucmVtb3ZlRnJvbUJvYXJkKGlkLCBTLmNvbHVtbnMsICdib2FyZCcsIFMuYWNjb3VudCk7CiAgICAgIFMuZWRpdHMuZGVsZXRlKGlkKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW2NvbC5pZF0gPSBsb2dpYy5wbGFjZUlkKFMubGlzdHNbY29s",
"LmlkXSwgaWQsIG9yaWdpbmFsSW5kZXgpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKICAgICAgcmVuZGVyKCk7CiAgICAgIGZhaWxUb2FzdCgncmVtb3ZlJywgaWQsIGVycik7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBmYWlsVG9hc3QodmVyYiwgaWQsIGVycikgewogICAgY29uc3Qgb3B0cyA9IHsga2luZDogJ2Vycm9yJyB9OwogICAgaWYgKGVyci5jb2RlID09PSAnYXV0aF9yZXF1aXJlZCcpIG9wdHMuYWN0aW9uID0geyBsYWJlbDogJ0Nvbm5lY3QnLCBvbkNsaWNrOiAoKSA9PiBjb25uZWN0KCkgfTsKICAgIHRvYXN0KHJvb3QsIGBDb3VsZG7igJl0ICR7dmVyYn0g4oCcJHtzdG9yZS50aHJlYWQoaWQpID8gY2FyZFRpdGxlKGlkKSA6ICd0aGF0IHRocmVhZCd94oCdOiAke2Vyci5tZXNzYWdlfWAsIG9wdHMpOwogIH0KCiAgLy8g4pSA4pSAIERyYWcgYW5kIGRyb3Ag4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG9uRHJhZ1N0YXJ0KGUsIGlkLCBjb2xJZCwgY2FyZCkgewogICAgY2xvc2VNZW51KHJvb3QpOwogICAgY29uc3QgcGxhY2Vob2xkZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAncGxhY2Vob2xkZXInLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSk7CiAgICBwbGFj",
"ZWhvbGRlci5zdHlsZS5oZWlnaHQgPSBgJHtjYXJkLm9mZnNldEhlaWdodH1weGA7CiAgICBTLmRyYWcgPSB7IGlkLCBmcm9tQ29sOiBjb2xJZCwgY2FyZCwgcGxhY2Vob2xkZXIgfTsKICAgIGUuZGF0YVRyYW5zZmVyLmVmZmVjdEFsbG93ZWQgPSAnbW92ZSc7CiAgICAvLyBBIHByaXZhdGUgdHlwZSwgc28gZHJvcHBpbmcgYSBjYXJkIG9uIEdtYWlsJ3MgY29tcG9zZSBib3ggZG9lcyBub3QKICAgIC8vIHBhc3RlIGEgdGhyZWFkIGlkIGludG8gYW4gZW1haWwuCiAgICBlLmRhdGFUcmFuc2Zlci5zZXREYXRhKERSQUdfVFlQRSwgaWQpOwogICAgY2FyZC5jbGFzc0xpc3QuYWRkKCdsaWZ0aW5nJyk7CiAgICAvLyBIaWRlIHRoZSBjYXJkIG9ubHkgYWZ0ZXIgdGhlIGJyb3dzZXIgaGFzIGNhcHR1cmVkIGl0IGFzIHRoZSBkcmFnCiAgICAvLyBpbWFnZTsgaGlkaW5nIGl0IHN5bmNocm9ub3VzbHkgY2FuY2VscyB0aGUgZHJhZyBpbiBDaHJvbWUuCiAgICBzZXRUaW1lb3V0KCgpID0-IHsKICAgICAgaWYgKCFTLmRyYWcgfHwgUy5kcmFnLmNhcmQgIT09IGNhcmQpIHJldHVybjsKICAgICAgY2FyZC5wYXJlbnROb2RlLmluc2VydEJlZm9yZShwbGFjZWhvbGRlciwgY2FyZCk7CiAgICAgIGNhcmQuY2xhc3NMaXN0LmFkZCgnZHJhZ2dpbmcnKTsKICAgIH0sIDApOwogIH0KCiAgZnVuY3Rpb24gZHJvcEluZGV4KGxpc3QsIHkpIHsKICAgIGNvbnN0IGNhcmRzID0gWy4uLmxpc3QucXVlcnlTZWxlY3RvckFsbCgnOnNjb3BlID4gLmNh",
"cmQ6bm90KC5kcmFnZ2luZyknKV07CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNhcmRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGNvbnN0IHIgPSBjYXJkc1tpXS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgaWYgKHkgPCByLnRvcCArIHIuaGVpZ2h0IC8gMikgcmV0dXJuIGk7CiAgICB9CiAgICByZXR1cm4gY2FyZHMubGVuZ3RoOwogIH0KCiAgZnVuY3Rpb24gb25EcmFnT3ZlcihlKSB7CiAgICBpZiAoIVMuZHJhZykgcmV0dXJuOwogICAgY29uc3Qgc2VjdGlvbiA9IGUudGFyZ2V0LmNsb3Nlc3QgJiYgZS50YXJnZXQuY2xvc2VzdCgnLmNvbHVtbicpOwogICAgY29uc3QgcGggPSBTLmRyYWcucGxhY2Vob2xkZXI7CiAgICBpZiAoIXNlY3Rpb24pIHsKICAgICAgcGgucmVtb3ZlKCk7CiAgICAgIG1hcmtUYXJnZXQobnVsbCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGUuZGF0YVRyYW5zZmVyLmRyb3BFZmZlY3QgPSAnbW92ZSc7CiAgICBjb25zdCBsaXN0ID0gc2VjdGlvbi5xdWVyeVNlbGVjdG9yKCcubGlzdCcpOwogICAgY29uc3QgaWR4ID0gZHJvcEluZGV4KGxpc3QsIGUuY2xpZW50WSk7CiAgICBjb25zdCBjYXJkcyA9IFsuLi5saXN0LnF1ZXJ5U2VsZWN0b3JBbGwoJzpzY29wZSA-IC5jYXJkOm5vdCguZHJhZ2dpbmcpJyldOwogICAgY29uc3QgcmVmID0gY2FyZHNbaWR4XSB8fCBudWxsOwogICAgaWYgKHJlZikgewogICAgICBpZiAocmVmLnByZXZpb3VzRWxl",
"bWVudFNpYmxpbmcgIT09IHBoKSBsaXN0Lmluc2VydEJlZm9yZShwaCwgcmVmKTsKICAgIH0gZWxzZSBpZiAobGlzdC5sYXN0RWxlbWVudENoaWxkICE9PSBwaCkgewogICAgICBsaXN0LmFwcGVuZENoaWxkKHBoKTsKICAgIH0KICAgIG1hcmtUYXJnZXQoc2VjdGlvbik7CiAgfQoKICBmdW5jdGlvbiBvbkRyb3AoZSkgewogICAgaWYgKCFTLmRyYWcpIHJldHVybjsKICAgIGNvbnN0IHNlY3Rpb24gPSBlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0LmNsb3Nlc3QoJy5jb2x1bW4nKTsKICAgIGlmICghc2VjdGlvbikgcmV0dXJuOwogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgY29uc3QgaWR4ID0gZHJvcEluZGV4KHNlY3Rpb24ucXVlcnlTZWxlY3RvcignLmxpc3QnKSwgZS5jbGllbnRZKTsKICAgIGNvbnN0IHsgaWQsIGZyb21Db2wgfSA9IFMuZHJhZzsKICAgIGVuZERyYWcoZmFsc2UpOwogICAgbW92ZVRocmVhZChpZCwgZnJvbUNvbCwgc2VjdGlvbi5kYXRhc2V0LmNvbCwgaWR4KTsKICB9CgogIGZ1bmN0aW9uIG9uRHJhZ0VuZCgpIHsKICAgIGlmIChTLmRyYWcpIGVuZERyYWcodHJ1ZSk7CiAgfQoKICBmdW5jdGlvbiBlbmREcmFnKGNhbmNlbGxlZCkgewogICAgY29uc3QgZCA9IFMuZHJhZzsKICAgIFMuZHJhZyA9IG51bGw7CiAgICBkLnBsYWNlaG9sZGVyLnJlbW92ZSgpOwogICAgZC5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoJ2RyYWdnaW5nJywgJ2xpZnRpbmcnKTsKICAgIG1hcmtUYXJnZXQobnVsbCk7CiAg",
"ICBpZiAoY2FuY2VsbGVkIHx8IFMucmVuZGVyRGVmZXJyZWQpIHsKICAgICAgUy5yZW5kZXJEZWZlcnJlZCA9IGZhbHNlOwogICAgICByZW5kZXIoKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIG1hcmtUYXJnZXQoc2VjdGlvbikgewogICAgZm9yIChjb25zdCBzIG9mIGVscy5ib2R5LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2x1bW4uZHJvcC10YXJnZXQnKSkgewogICAgICBpZiAocyAhPT0gc2VjdGlvbikgcy5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wLXRhcmdldCcpOwogICAgfQogICAgaWYgKHNlY3Rpb24pIHNlY3Rpb24uY2xhc3NMaXN0LmFkZCgnZHJvcC10YXJnZXQnKTsKICB9CgogIC8vIOKUgOKUgCBDb2x1bW4gc2VhcmNoICgiKyIpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBsZXQgc2VhcmNoVGltZXIgPSAwOwoKICBmdW5jdGlvbiB0b2dnbGVTZWFyY2goY29sSWQpIHsKICAgIGlmIChTLnNlYXJjaCAmJiBTLnNlYXJjaC5jb2xJZCA9PT0gY29sSWQpIHsKICAgICAgY2xvc2VTZWFyY2goKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgUy5zZWFyY2ggPSB7IGNvbElkLCBxdWVyeTogJycsIGlkczogbnVsbCwgbG9hZGluZzogZmFsc2UsIGVycm9yOiAnJywgc2VxOiAwIH07CiAgICByZW5kZXIoKTsKICAgIGNv",
"bnN0IGlucHV0ID0gZWxzLmJvZHkucXVlcnlTZWxlY3RvcignLnNlYXJjaCBpbnB1dCcpOwogICAgaWYgKGlucHV0KSBpbnB1dC5mb2N1cygpOwogICAgcnVuU2VhcmNoKCk7CiAgfQoKICBmdW5jdGlvbiBjbG9zZVNlYXJjaCgpIHsKICAgIGlmICghUy5zZWFyY2gpIHJldHVybjsKICAgIGNvbnN0IGNvbElkID0gUy5zZWFyY2guY29sSWQ7CiAgICBTLnNlYXJjaCA9IG51bGw7CiAgICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgcmVuZGVyKCk7CiAgICByZXN0b3JlRm9jdXMoYGFkZDoke2NvbElkfWAsIGVscy5ib2R5KTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclNlYXJjaChjb2wpIHsKICAgIGNvbnN0IHMgPSBTLnNlYXJjaDsKICAgIGNvbnN0IGlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIHR5cGU6ICdzZWFyY2gnLAogICAgICBwbGFjZWhvbGRlcjogJ1NlYXJjaCBtYWlsLCBlLmcuIGZyb206YW5uYSBpczp1bnJlYWQnLAogICAgICAnYXJpYS1sYWJlbCc6IGBTZWFyY2ggR21haWwgZm9yIGEgdGhyZWFkIHRvIGFkZCB0byAke2NvbC50aXRsZX1gLAogICAgICB2YWx1ZTogcy5xdWVyeSwKICAgICAgZGF0YXNldDogeyBrZXk6IGBzZWFyY2g6JHtjb2wuaWR9YCB9LAogICAgICBvbmlucHV0OiBlID0-IHsKICAgICAgICBzLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7CiAgICAgICAgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVyKTsKICAgICAgICBzZWFyY2hUaW1lciA9IHNldFRpbWVvdXQocnVuU2VhcmNoLCA0",
"NTApOwogICAgICB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGNsZWFyVGltZW91dChzZWFyY2hUaW1lcik7IHJ1blNlYXJjaCgpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNsb3NlU2VhcmNoKCk7IH0KICAgICAgfSwKICAgIH0pOwogICAgZWxzLnJlc3VsdHMgPSBoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cycsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiAnU2VhcmNoIHJlc3VsdHMnLCAnYXJpYS1idXN5JzogU3RyaW5nKHMubG9hZGluZykgfSk7CiAgICBmaWxsUmVzdWx0cyh0cnVlKTsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoJywgcm9sZTogJ3NlYXJjaCcgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3NlYXJjaC1ib3gnIH0sIGljb24oJ3NlYXJjaCcsIDE4KSwgaW5wdXQpLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoLWhpbnQnLCB0ZXh0OiAnR21haWwgc2VhcmNoIHN5bnRheC4gTGVhdmUgaXQgZW1wdHkgdG8gbGlzdCB5b3VyIEluYm94LicgfSksCiAgICAgIGVscy5yZXN1bHRzKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJ1blNlYXJjaCgpIHsKICAgIGNvbnN0IHMgPSBTLnNlYXJjaDsKICAgIGlmICghcykgcmV0dXJuOwogICAgY29uc3Qgc2VxID0gKytzLnNlcTsK",
"ICAgIHMubG9hZGluZyA9IHRydWU7CiAgICBmaWxsUmVzdWx0cygpOwogICAgdHJ5IHsKICAgICAgY29uc3QgaWRzID0gYXdhaXQgc3RvcmUuc2VhcmNoKHMucXVlcnksIFMuYWNjb3VudCk7CiAgICAgIGlmIChTLnNlYXJjaCAhPT0gcyB8fCBzZXEgIT09IHMuc2VxKSByZXR1cm47CiAgICAgIHMuaWRzID0gaWRzOwogICAgICBzLmVycm9yID0gJyc7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKFMuc2VhcmNoICE9PSBzIHx8IHNlcSAhPT0gcy5zZXEpIHJldHVybjsKICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSB7CiAgICAgICAgaGFuZGxlRXJyb3IoZXJyKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgcy5pZHMgPSBbXTsKICAgICAgcy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgfQogICAgcy5sb2FkaW5nID0gZmFsc2U7CiAgICBmaWxsUmVzdWx0cygpOwogIH0KCiAgLy8gYGJ1aWxkaW5nYCBpcyB0cnVlIHdoaWxlIHRoZSBwYW5lbCBpcyBiZWluZyBjcmVhdGVkIGFuZCBpcyBub3QgeWV0IGluCiAgLy8gdGhlIGRvY3VtZW50OyBvdGhlcndpc2UgYSBkZXRhY2hlZCBib3ggbWVhbnMgYW4gYXN5bmMgc2VhcmNoIGZpbmlzaGVkCiAgLy8gYWZ0ZXIgaXRzIHBhbmVsIHdhcyBjbG9zZWQsIGFuZCB0aGVyZSBpcyBub3RoaW5nIHRvIGZpbGwuCiAgZnVuY3Rpb24gZmlsbFJlc3VsdHMoYnVpbGRpbmcgPSBmYWxzZSkgewogICAgY29uc3QgcyA9",
"IFMuc2VhcmNoOwogICAgY29uc3QgYm94ID0gZWxzLnJlc3VsdHM7CiAgICBpZiAoIXMgfHwgIWJveCB8fCAoIWJ1aWxkaW5nICYmICFib3guaXNDb25uZWN0ZWQpKSByZXR1cm47CiAgICBib3guc2V0QXR0cmlidXRlKCdhcmlhLWJ1c3knLCBTdHJpbmcocy5sb2FkaW5nKSk7CgogICAgaWYgKHMuaWRzID09PSBudWxsIHx8IChzLmxvYWRpbmcgJiYgIXMuaWRzLmxlbmd0aCkpIHsKICAgICAgYm94LnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cy1lbXB0eScsIHRleHQ6ICdTZWFyY2hpbmfigKYnIH0pKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKHMuZXJyb3IpIHsKICAgICAgYm94LnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cy1lbXB0eScsIHRleHQ6IGBTZWFyY2ggZmFpbGVkOiAke3MuZXJyb3J9YCB9KSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmICghcy5pZHMubGVuZ3RoKSB7CiAgICAgIGJveC5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ3Jlc3VsdHMtZW1wdHknLCB0ZXh0OiAnTm8gdGhyZWFkcyBtYXRjaC4nIH0pKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGNvbnN0IHRhcmdldCA9IFMuY29sdW1ucy5maW5kKGMgPT4gYy5pZCA9PT0gcy5jb2xJZCk7CiAgICBib3gucmVwbGFjZUNoaWxkcmVuKC4uLnMuaWRzLm1hcChpZCA9PiB7CiAgICAgIGNvbnN0IHQgPSBzdG9yZS50aHJlYWQoaWQpOwogICAgICBjb25zdCB3",
"aGVyZSA9IGNvbHVtbk9mKGlkKTsKICAgICAgY29uc3QgaGVyZSA9IHdoZXJlICYmIHdoZXJlLmlkID09PSBzLmNvbElkOwogICAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAncmVzdWx0JywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICdsaXN0aXRlbScsIGRpc2FibGVkOiBoZXJlLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgcmVzdWx0OiR7aWR9YCwgaWQgfSwKICAgICAgICB0aXRsZTogaGVyZSA_ICcnIDogYEFkZCB0byAke3RhcmdldCA_IHRhcmdldC50aXRsZSA6ICd0aGlzIGNvbHVtbid9YCwKICAgICAgICBvbmNsaWNrOiAoKSA9PiBhZGRGcm9tU2VhcmNoKGlkLCBzLmNvbElkKSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3ItdG9wJyB9LAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmcm9tJywgdGV4dDogdC5mcm9tIH0pLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkYXRlJywgdGV4dDogdXRpbC5yZWxhdGl2ZURhdGUodC50cykgfSkpLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnci1zdWJqZWN0JywgdGV4dDogbG9naWMuZGlzcGxheVRpdGxlKHQsIFMuZWRpdHMuZ2V0KGlkKSkgfSksCiAgICAgICAgd2hlcmUgPyBoKCdzcGFuJywgeyBjbGFzczogJ3Itd2hlcmUnLCB0ZXh0OiBoZXJlID8gJ0FscmVhZHkgaW4gdGhpcyBjb2x1bW4nIDogYEluICR7d2hlcmUu",
"dGl0bGV9IMK3IG1vdmVzIGhlcmVgIH0pIDogbnVsbCk7CiAgICB9KSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBhZGRGcm9tU2VhcmNoKGlkLCBjb2xJZCkgewogICAgY29uc3Qgd2hlcmUgPSBjb2x1bW5PZihpZCk7CiAgICBpZiAod2hlcmUgJiYgd2hlcmUuaWQgPT09IGNvbElkKSByZXR1cm47CiAgICBpZiAod2hlcmUpIHsKICAgICAgbW92ZVRocmVhZChpZCwgd2hlcmUuaWQsIGNvbElkLCAwKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgdGFyZ2V0ID0gUy5jb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSBjb2xJZCk7CiAgICBTLmxpc3RzW2NvbElkXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1tjb2xJZF0sIGlkLCAwKTsKICAgIHBlcnNpc3RPcmRlcigpOwogICAgcmVuZGVyKCk7CiAgICBhbm5vdW5jZShgQWRkZWQgdG8gJHt0YXJnZXQudGl0bGV9LmApOwogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUubW92ZVRvQ29sdW1uKGlkLCBTLmNvbHVtbnMsIGNvbElkLCAnYm9hcmQnKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW2NvbElkXSA9IChTLmxpc3RzW2NvbElkXSB8fCBbXSkuZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKICAgICAgcmVuZGVyKCk7CiAgICAgIGZhaWxUb2FzdCgnYWRkJywgaWQsIGVycik7CiAgICB9CiAgfQoKICAvLyDilIDilIAgQ29sdW1uIHNldHRpbmdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU",
"gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBvcGVuRHJhd2VyKCkgewogICAgaWYgKFMuc3RhdHVzICE9PSAncmVhZHknKSByZXR1cm47CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBTLmRyYXdlciA9IHsKICAgICAgZHJhZnQ6IFMuY29sdW1ucy5tYXAoYyA9PiAoeyAuLi5jLCBvcmlnTGFiZWw6IGMubGFiZWwsIGlzTmV3OiBmYWxzZSwgbGFiZWxUb3VjaGVkOiB0cnVlIH0pKSwKICAgICAgZXJyb3I6ICcnLAogICAgICBzYXZpbmc6IGZhbHNlLAogICAgfTsKICAgIHJlbmRlckRyYXdlcigndGl0bGU6MCcpOwogIH0KCiAgZnVuY3Rpb24gY2xvc2VEcmF3ZXIoKSB7CiAgICBpZiAoIVMuZHJhd2VyKSByZXR1cm47CiAgICBTLmRyYXdlciA9IG51bGw7CiAgICByZW5kZXJEcmF3ZXIoKTsKICAgIGlmIChTLm9wZW4pIGVscy5zZXR0aW5ncy5mb2N1cygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRHJhd2VyKGZvY3VzKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXI7CiAgICBpZiAoIWQpIHsKICAgICAgZWxzLmRyYXdlckxheWVyLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBrZXkgPSBmb2N1cyB8fCBmb2N1c0tleSgpOwoKICAgIGNvbnN0IGRyYXdlciA9IGgoJ2FzaWRlJywgewogICAgICBjbGFzczogJ2Ry",
"YXdlcicsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1tb2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6ICdna2ItZHJhd2VyLXRpdGxlJywKICAgIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkcmF3ZXItaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItZHJhd2VyLXRpdGxlJywgdGV4dDogJ0NvbHVtbnMnIH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQ2xvc2UgY29sdW1uIHNldHRpbmdzJywgb25jbGljazogY2xvc2VEcmF3ZXIsCiAgICAgICAgfSwgaWNvbignY2xvc2UnKSkpLAogICAgICBoKCdwJywgewogICAgICAgIGNsYXNzOiAnZHJhd2VyLWludHJvJywKICAgICAgICB0ZXh0OiAnRWFjaCBjb2x1bW4gaXMgYSBHbWFpbCBsYWJlbC4gUmVuYW1pbmcgYSBsYWJlbCBoZXJlIHJlbmFtZXMgaXQgaW4gR21haWwsIHNvIHRoZSBtYWlsIGZpbGVkIHVuZGVyIGl0IHN0YXlzIHB1dC4nLAogICAgICB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RyYXdlci1ib2R5JyB9LAogICAgICAgIGQuZHJhZnQubWFwKChjLCBpKSA9PiByZW5kZXJEcmFmdFJvdyhjLCBpKSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdhZGQtY29sJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiAnYWRkLWNvbCcgfSwgb25jbGljazogYWRkRHJhZnRDb2x1bW4sCiAg",
"ICAgICAgfSwgJysgQWRkIGNvbHVtbicpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2Zvcm0tZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBkLmVycm9yIH0pLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZHJhd2VyLWZvb3QnIH0sCiAgICAgICAgaCgnc3BhbicsIHsKICAgICAgICAgIGNsYXNzOiAnbm90ZScsCiAgICAgICAgICB0ZXh0OiAnUmVtb3ZpbmcgYSBjb2x1bW4gb25seSB0YWtlcyBpdCBvZmYgdGhlIGJvYXJkLiBJdHMgR21haWwgbGFiZWwsIGFuZCB0aGUgbWFpbCBpbiBpdCwgYXJlIGxlZnQgdW50b3VjaGVkLicsCiAgICAgICAgfSksCiAgICAgICAgaCgnYnV0dG9uJywgeyBjbGFzczogJ2J0biBidG4tdGV4dCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQ2FuY2VsJywgb25jbGljazogY2xvc2VEcmF3ZXIgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdidG4gYnRuLXByaW1hcnknLCB0eXBlOiAnYnV0dG9uJywgZGlzYWJsZWQ6IGQuc2F2aW5nLCBkYXRhc2V0OiB7IGtleTogJ3NhdmUnIH0sCiAgICAgICAgICB0ZXh0OiBkLnNhdmluZyA_ICdTYXZpbmfigKYnIDogJ1NhdmUnLCBvbmNsaWNrOiBzYXZlRHJhd2VyLAogICAgICAgIH0pKSk7CgogICAgZWxzLmRyYXdlckxheWVyLnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAnc2NyaW0nLCBvbmNsaWNrOiBjbG9zZURyYXdlciB9KSwgZHJhd2VyKTsKICAgIHJlc3RvcmVGb2N1cyhrZXksIGVscy5k",
"cmF3ZXJMYXllcik7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJEcmFmdFJvdyhjLCBpKSB7CiAgICBjb25zdCBuID0gUy5kcmF3ZXIuZHJhZnQubGVuZ3RoOwogICAgY29uc3Qgcm93VGl0bGUgPSBoKCdzcGFuJywgeyBjbGFzczogJ3Jvdy10aXRsZScsIHRleHQ6IGMudGl0bGUgfHwgJ05ldyBjb2x1bW4nIH0pOwogICAgY29uc3QgaGVscCA9IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtaGVscCcgfSk7CiAgICBjb25zdCBzZXRIZWxwID0gKCkgPT4gewogICAgICBoZWxwLnRleHRDb250ZW50ID0gYy5pc05ldwogICAgICAgID8gJ0NyZWF0ZWQgaW4gR21haWwgd2hlbiB5b3Ugc2F2ZS4nCiAgICAgICAgOiBjLmxhYmVsLnRyaW0oKSAhPT0gYy5vcmlnTGFiZWwgPyBgUmVuYW1lcyDigJwke2Mub3JpZ0xhYmVsfeKAnSBpbiBHbWFpbCB3aGVuIHlvdSBzYXZlLmAgOiAnJzsKICAgIH07CiAgICBzZXRIZWxwKCk7CgogICAgY29uc3QgbGFiZWxJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHZhbHVlOiBjLmxhYmVsLCBzcGVsbGNoZWNrOiAnZmFsc2UnLAogICAgICBkYXRhc2V0OiB7IGtleTogYGxhYmVsOiR7aX1gIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBjLmxhYmVsID0gZS50YXJnZXQudmFsdWU7IGMubGFiZWxUb3VjaGVkID0gdHJ1ZTsgc2V0SGVscCgpOyB9LAogICAgfSk7CiAgICBjb25zdCB0aXRsZUlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNs",
"YXNzOiAndGV4dC1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGMudGl0bGUsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgdGl0bGU6JHtpfWAgfSwKICAgICAgb25pbnB1dDogZSA9PiB7CiAgICAgICAgYy50aXRsZSA9IGUudGFyZ2V0LnZhbHVlOwogICAgICAgIHJvd1RpdGxlLnRleHRDb250ZW50ID0gYy50aXRsZSB8fCAnTmV3IGNvbHVtbic7CiAgICAgICAgLy8gQSBuZXcgY29sdW1uJ3MgbGFiZWwgZm9sbG93cyBpdHMgdGl0bGUgdW50aWwgZWRpdGVkIGJ5IGhhbmQuCiAgICAgICAgaWYgKGMuaXNOZXcgJiYgIWMubGFiZWxUb3VjaGVkKSB7CiAgICAgICAgICBjLmxhYmVsID0gYCR7Yy5yb290fS8ke2MudGl0bGUudHJpbSgpfWA7CiAgICAgICAgICBsYWJlbElucHV0LnZhbHVlID0gYy5sYWJlbDsKICAgICAgICB9CiAgICAgIH0sCiAgICB9KTsKCiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NvbC1yb3cnLCBkYXRhc2V0OiB7IHJvdzogU3RyaW5nKGkpIH0gfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3Jvdy1oZWFkJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncm93LW51bScsIHRleHQ6IFN0cmluZyhpICsgMSkgfSksCiAgICAgICAgcm93VGl0bGUsCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6IGBNb3ZlICR7Yy50aXRsZSB8fCAnY29sdW1uJ30gdXBgLCB0aXRsZTogJ01vdmUgdXAg",
"KGZ1cnRoZXIgbGVmdCBvbiB0aGUgYm9hcmQpJywKICAgICAgICAgIGRpc2FibGVkOiBpID09PSAwLCBkYXRhc2V0OiB7IGtleTogYHVwOiR7aX1gIH0sIG9uY2xpY2s6ICgpID0-IG1vdmVEcmFmdChpLCAtMSksCiAgICAgICAgfSwgaWNvbigndXAnLCAxOCkpLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiBgTW92ZSAke2MudGl0bGUgfHwgJ2NvbHVtbid9IGRvd25gLCB0aXRsZTogJ01vdmUgZG93biAoZnVydGhlciByaWdodCBvbiB0aGUgYm9hcmQpJywKICAgICAgICAgIGRpc2FibGVkOiBpID09PSBuIC0gMSwgZGF0YXNldDogeyBrZXk6IGBkb3duOiR7aX1gIH0sIG9uY2xpY2s6ICgpID0-IG1vdmVEcmFmdChpLCAxKSwKICAgICAgICB9LCBpY29uKCdkb3duJywgMTgpKSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogYFJlbW92ZSAke2MudGl0bGUgfHwgJ2NvbHVtbid9IGZyb20gdGhlIGJvYXJkYCwKICAgICAgICAgIHRpdGxlOiAnUmVtb3ZlIGZyb20gYm9hcmQgKGtlZXBzIHRoZSBHbWFpbCBsYWJlbCknLCBkYXRhc2V0OiB7IGtleTogYHJlbW92ZToke2l9YCB9LAogICAgICAgICAgb25jbGljazogKCkgPT4gcmVtb3ZlRHJhZnQoaSksCiAgICAgICAgfSwgaWNvbignY2xvc2UnLCAxOCkpKSwKICAgICAgaCgnbGFi",
"ZWwnLCB7IGNsYXNzOiAnZmllbGQnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmaWVsZC1sYWJlbCcsIHRleHQ6ICdUaXRsZScgfSksCiAgICAgICAgdGl0bGVJbnB1dCksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCB0ZXh0OiAnR21haWwgbGFiZWwnIH0pLAogICAgICAgIGxhYmVsSW5wdXQsCiAgICAgICAgaGVscCksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2NoZWNrJyB9LAogICAgICAgIGgoJ2lucHV0JywgewogICAgICAgICAgdHlwZTogJ2NoZWNrYm94JywgY2hlY2tlZDogISFjLmFyY2hpdmVPbkRyb3AsIGRhdGFzZXQ6IHsga2V5OiBgYXJjaGl2ZToke2l9YCB9LAogICAgICAgICAgb25jaGFuZ2U6IGUgPT4geyBjLmFyY2hpdmVPbkRyb3AgPSBlLnRhcmdldC5jaGVja2VkOyB9LAogICAgICAgIH0pLAogICAgICAgICdBcmNoaXZlIHRocmVhZHMgbW92ZWQgaGVyZSAodGFrZSB0aGVtIG91dCBvZiB0aGUgSW5ib3gpJykpOwogIH0KCiAgZnVuY3Rpb24gbW92ZURyYWZ0KGksIGRlbHRhKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXIuZHJhZnQ7CiAgICBjb25zdCBqID0gaSArIGRlbHRhOwogICAgaWYgKGogPCAwIHx8IGogPj0gZC5sZW5ndGgpIHJldHVybjsKICAgIFtkW2ldLCBkW2pdXSA9IFtkW2pdLCBkW2ldXTsKICAgIC8vIEtlZXAgZm9jdXMgb24gdGhlIHNhbWUgYXJyb3csIG5vdyBvbiB0",
"aGUgcm93J3MgbmV3IHBvc2l0aW9uLCBzbwogICAgLy8gcmVwZWF0ZWQgcHJlc3NlcyBrZWVwIG1vdmluZyB0aGUgc2FtZSBjb2x1bW4uCiAgICBjb25zdCBrZXkgPSBkZWx0YSA8IDAgPyAoaiA9PT0gMCA_IGBkb3duOiR7an1gIDogYHVwOiR7an1gKSA6IChqID09PSBkLmxlbmd0aCAtIDEgPyBgdXA6JHtqfWAgOiBgZG93bjoke2p9YCk7CiAgICByZW5kZXJEcmF3ZXIoa2V5KTsKICB9CgogIGZ1bmN0aW9uIHJlbW92ZURyYWZ0KGkpIHsKICAgIFMuZHJhd2VyLmRyYWZ0LnNwbGljZShpLCAxKTsKICAgIGNvbnN0IG4gPSBTLmRyYXdlci5kcmFmdC5sZW5ndGg7CiAgICByZW5kZXJEcmF3ZXIobiA_IGB0aXRsZToke01hdGgubWluKGksIG4gLSAxKX1gIDogJ2FkZC1jb2wnKTsKICB9CgogIGZ1bmN0aW9uIGFkZERyYWZ0Q29sdW1uKCkgewogICAgY29uc3QgZCA9IFMuZHJhd2VyLmRyYWZ0OwogICAgLy8gVW5kZXIgd2hhdGV2ZXIgcGFyZW50IHRoZSBjb2x1bW5zIGFscmVhZHkgc2hhcmUgKCJfQm9hcmQiLCBvciBvbmUKICAgIC8vIHRoZSB1c2VyIG1vdmVkIHRoZW0gdG8pLCBub3QgYSBoYXJkLWNvZGVkIG9uZS4KICAgIGNvbnN0IHJvb3QgPSBsb2dpYy5sYWJlbFJvb3QoUy5jb2x1bW5zKTsKICAgIGQucHVzaCh7CiAgICAgIGlkOiBsb2dpYy5uZXdDb2x1bW5JZChkKSwKICAgICAgdGl0bGU6ICdOZXcgY29sdW1uJywKICAgICAgbGFiZWw6IGAke3Jvb3R9L05ldyBjb2x1bW5gLAogICAgICByb290LAogICAgICBhcmNo",
"aXZlT25Ecm9wOiBmYWxzZSwKICAgICAgb3JpZ0xhYmVsOiAnJywKICAgICAgaXNOZXc6IHRydWUsCiAgICAgIGxhYmVsVG91Y2hlZDogZmFsc2UsCiAgICB9KTsKICAgIHJlbmRlckRyYXdlcihgdGl0bGU6JHtkLmxlbmd0aCAtIDF9YCk7CiAgICBjb25zdCBpbnB1dCA9IFsuLi5lbHMuZHJhd2VyTGF5ZXIucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEta2V5XScpXS5maW5kKHggPT4geC5kYXRhc2V0LmtleSA9PT0gYHRpdGxlOiR7ZC5sZW5ndGggLSAxfWApOwogICAgaWYgKGlucHV0KSBpbnB1dC5zZWxlY3QoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVEcmF3ZXIoKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXI7CiAgICBjb25zdCB0aWR5ID0gcyA9PiBTdHJpbmcocyB8fCAnJykuc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRyaW0oKSkuam9pbignLycpOwogICAgY29uc3QgY29scyA9IGQuZHJhZnQubWFwKGMgPT4gKHsKICAgICAgaWQ6IGMuaWQsCiAgICAgIHRpdGxlOiBTdHJpbmcoYy50aXRsZSB8fCAnJykudHJpbSgpLAogICAgICBsYWJlbDogdGlkeShjLmxhYmVsKSwKICAgICAgYXJjaGl2ZU9uRHJvcDogISFjLmFyY2hpdmVPbkRyb3AsCiAgICB9KSk7CgogICAgY29uc3QgcHJvYmxlbSA9IGxvZ2ljLnZhbGlkYXRlQ29sdW1ucyhjb2xzKTsKICAgIGlmIChwcm9ibGVtKSB7CiAgICAgIGQuZXJyb3IgPSBwcm9ibGVtOwogICAgICByZW5kZXJEcmF3ZXIoKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGQuc2F2",
"aW5nID0gdHJ1ZTsKICAgIGQuZXJyb3IgPSAnJzsKICAgIHJlbmRlckRyYXdlcignc2F2ZScpOwogICAgY29uc3Qgbm90ZXMgPSBbXTsKCiAgICB0cnkgewogICAgICAvLyBMYWJlbCByZW5hbWVzIGZpcnN0LCBwZXJzaXN0aW5nIGFmdGVyIGVhY2ggb25lLiBJZiBhIGxhdGVyIHN0ZXAKICAgICAgLy8gZmFpbHMsIHRoZSBzYXZlZCBsYXlvdXQgc3RpbGwgbWF0Y2hlcyB3aGF0IEdtYWlsIG5vdyBoYXMsIGluc3RlYWQKICAgICAgLy8gb2YgcG9pbnRpbmcgYXQgYSBsYWJlbCBuYW1lIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cy4KICAgICAgbGV0IHBlcnNpc3RlZCA9IFMuY29sdW1ucy5tYXAoYyA9PiAoeyAuLi5jIH0pKTsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBkLmRyYWZ0Lmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3Qgcm93ID0gZC5kcmFmdFtpXTsKICAgICAgICBjb25zdCBuZXh0ID0gY29sc1tpXTsKICAgICAgICBpZiAocm93LmlzTmV3IHx8ICFyb3cub3JpZ0xhYmVsIHx8IHJvdy5vcmlnTGFiZWwgPT09IG5leHQubGFiZWwpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN0b3JlLnJlbmFtZUxhYmVsKHJvdy5vcmlnTGFiZWwsIG5leHQubGFiZWwpOwogICAgICAgIGlmIChyZXN1bHQgPT09ICdyZXBvaW50ZWQnKSBub3Rlcy5wdXNoKGDigJwke25leHQudGl0bGV94oCdIG5vdyB1c2VzIHRoZSBleGlzdGluZyBsYWJlbCDigJwke25leHQubGFiZWx94oCdLmApOwogICAgICAgIHBl",
"cnNpc3RlZCA9IHBlcnNpc3RlZC5tYXAoYyA9PiAoYy5pZCA9PT0gbmV4dC5pZCA_IHsgLi4uYywgbGFiZWw6IG5leHQubGFiZWwgfSA6IGMpKTsKICAgICAgICBhd2FpdCBzdG9yZS5zYXZlQ29sdW1ucyhTLmFjY291bnQsIHBlcnNpc3RlZCk7CiAgICAgICAgUy5jb2x1bW5zID0gcGVyc2lzdGVkOwogICAgICB9CgogICAgICBhd2FpdCBzdG9yZS5lbnN1cmVMYWJlbHMoY29scy5tYXAoYyA9PiBjLmxhYmVsKSwgeyBmcmVzaDogdHJ1ZSB9KTsKICAgICAgYXdhaXQgc3RvcmUuc2F2ZUNvbHVtbnMoUy5hY2NvdW50LCBjb2xzKTsKICAgICAgUy5jb2x1bW5zID0gY29sczsKICAgICAgUy5kcmF3ZXIgPSBudWxsOwogICAgICByZW5kZXJEcmF3ZXIoKTsKICAgICAgZWxzLnNldHRpbmdzLmZvY3VzKCk7CiAgICAgIHRvYXN0KHJvb3QsIFsnQ29sdW1ucyBzYXZlZC4nLCAuLi5ub3Rlc10uam9pbignICcpKTsKICAgICAgUy5sb2FkZWRBdCA9IDA7CiAgICAgIGF3YWl0IHJlZnJlc2goKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHsKICAgICAgICBTLmRyYXdlciA9IG51bGw7CiAgICAgICAgcmVuZGVyRHJhd2VyKCk7CiAgICAgICAgaGFuZGxlRXJyb3IoZXJyKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgZC5zYXZpbmcgPSBmYWxzZTsKICAgICAgZC5lcnJvciA9IGBDb3VsZG7igJl0IHNhdmU6ICR7ZXJyLm1lc3Nh",
"Z2V9YDsKICAgICAgcmVuZGVyRHJhd2VyKCk7CiAgICB9CiAgfQoKICAvLyDilIDilIAgQ2FyZCBlZGl0b3Ig4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUaGUgdXNlcidzIG93biB0aXRsZSwgbm90ZSBhbmQgY29sb3VyIGZvciBvbmUgY2FyZC4gTm9uZSBvZiBpdCByZWFjaGVzCiAgLy8gR21haWw6IHRoZSByZWNvcmQgbGl2ZXMgaW4gc3RvcmFnZS5zeW5jLCBhbmQgdGhlIGVtYWlsIC0gaXRzIHN1YmplY3QsCiAgLy8gaXRzIGxhYmVscywgd2hhdCBjb3JyZXNwb25kZW50cyBzZWUgLSBpcyBleGFjdGx5IGFzIGl0IHdhcy4KCiAgY29uc3QgQ09MT1VSX05BTUVTID0gewogICAgcmVkOiAnUmVkJywgb3JhbmdlOiAnT3JhbmdlJywgeWVsbG93OiAnWWVsbG93JywgZ3JlZW46ICdHcmVlbicsCiAgICBibHVlOiAnQmx1ZScsIHB1cnBsZTogJ1B1cnBsZScsIGdyZXk6ICdHcmV5JywKICB9OwoKICBmdW5jdGlvbiBvcGVuRWRpdG9yKGlkKSB7CiAgICBjb25zdCB0ID0gc3RvcmUudGhyZWFkKGlkKTsKICAgIGlmICghdCB8fCBTLnN0YXR1cyAhPT0gJ3JlYWR5JykgcmV0dXJuOwogICAgY2xvc2VNZW51KHJvb3QpOwogICAgY29uc3QgZWRpdCA9IFMuZWRpdHMuZ2V0",
"KGlkKSB8fCB7fTsKICAgIFMuZWRpdG9yID0gewogICAgICBpZCwKICAgICAgc3ViamVjdDogdC5zdWJqZWN0LAogICAgICAvLyBQcmUtZmlsbGVkIHdpdGggdGhlIHN1YmplY3QgcmF0aGVyIHRoYW4gbGVmdCBibGFuaywgYmVjYXVzZSB0aGUKICAgICAgLy8gdXN1YWwgZWRpdCBpcyB0cmltbWluZyBhIGxvbmcgc3ViamVjdCBkb3duLCBub3Qgc3RhcnRpbmcgYWZyZXNoLgogICAgICBkcmFmdDogeyB0aXRsZTogZWRpdC50aXRsZSB8fCB0LnN1YmplY3QsIG5vdGU6IGVkaXQubm90ZSB8fCAnJywgY29sb3VyOiBlZGl0LmNvbG91ciB8fCAnJyB9LAogICAgICBlcnJvcjogJycsCiAgICAgIHNhdmluZzogZmFsc2UsCiAgICB9OwogICAgcmVuZGVyRWRpdG9yKCdlZGl0LXRpdGxlJyk7CiAgICBjb25zdCBpbnB1dCA9IGVscy5lZGl0b3JMYXllci5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9ImVkaXQtdGl0bGUiXScpOwogICAgaWYgKGlucHV0KSBpbnB1dC5zZWxlY3QoKTsKICB9CgogIGZ1bmN0aW9uIGNsb3NlRWRpdG9yKCkgewogICAgaWYgKCFTLmVkaXRvcikgcmV0dXJuOwogICAgY29uc3QgaWQgPSBTLmVkaXRvci5pZDsKICAgIFMuZWRpdG9yID0gbnVsbDsKICAgIHJlbmRlckVkaXRvcigpOwogICAgaWYgKFMub3BlbikgcmVzdG9yZUZvY3VzKGBtZW51OiR7aWR9YCwgZWxzLmJvZHkpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRWRpdG9yKGZvY3VzKSB7CiAgICBjb25zdCBlZCA9IFMuZWRpdG9yOwogICAgaWYgKCFl",
"ZCkgewogICAgICBlbHMuZWRpdG9yTGF5ZXIucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGtleSA9IGZvY3VzIHx8IGZvY3VzS2V5KCk7CiAgICBjb25zdCBkID0gZWQuZHJhZnQ7CgogICAgY29uc3QgcmVzZXQgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnbGluay1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1VzZSB0aGUgZW1haWwgc3ViamVjdCcsIGRhdGFzZXQ6IHsga2V5OiAnZWRpdC1yZXNldCcgfSwKICAgICAgb25jbGljazogKCkgPT4gewogICAgICAgIGQudGl0bGUgPSBlZC5zdWJqZWN0OwogICAgICAgIHRpdGxlSW5wdXQudmFsdWUgPSBlZC5zdWJqZWN0OwogICAgICAgIHN5bmNSZXNldCgpOwogICAgICAgIHRpdGxlSW5wdXQuZm9jdXMoKTsKICAgICAgfSwKICAgIH0pOwogICAgY29uc3Qgc3luY1Jlc2V0ID0gKCkgPT4gewogICAgICBjb25zdCB2ID0gZC50aXRsZS50cmltKCk7CiAgICAgIHJlc2V0LmhpZGRlbiA9ICF2IHx8IHYgPT09IGVkLnN1YmplY3QudHJpbSgpOwogICAgfTsKCiAgICBjb25zdCB0aXRsZUlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGQudGl0bGUsIG1heGxlbmd0aDogU3RyaW5nKGxvZ2ljLk1BWF9USVRMRSksCiAgICAgIHBsYWNlaG9sZGVyOiBlZC5zdWJqZWN0LCAnYXJpYS1kZXNjcmliZWRieSc6ICdna2ItZWRpdC1zdWJqZWN0JywgZGF0YXNl",
"dDogeyBrZXk6ICdlZGl0LXRpdGxlJyB9LAogICAgICBvbmlucHV0OiBlID0-IHsgZC50aXRsZSA9IGUudGFyZ2V0LnZhbHVlOyBzeW5jUmVzZXQoKTsgfSwKICAgICAgb25rZXlkb3duOiBlID0-IHsgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFlLmlzQ29tcG9zaW5nKSB7IGUucHJldmVudERlZmF1bHQoKTsgc2F2ZUVkaXRvcigpOyB9IH0sCiAgICB9KTsKICAgIHN5bmNSZXNldCgpOwoKICAgIGNvbnN0IG5vdGVJbnB1dCA9IGgoJ3RleHRhcmVhJywgewogICAgICBjbGFzczogWyd0ZXh0LWlucHV0JywgJ3RleHQtYXJlYSddLCByb3dzOiAnMycsIG1heGxlbmd0aDogU3RyaW5nKGxvZ2ljLk1BWF9OT1RFKSwgdmFsdWU6IGQubm90ZSwKICAgICAgcGxhY2Vob2xkZXI6ICdPcHRpb25hbC4gU2hvd24gb24gdGhlIGNhcmQgaW4gcGxhY2Ugb2YgdGhlIGVtYWlsIHByZXZpZXcuJywKICAgICAgZGF0YXNldDogeyBrZXk6ICdlZGl0LW5vdGUnIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBkLm5vdGUgPSBlLnRhcmdldC52YWx1ZTsgfSwKICAgICAgLy8gRW50ZXIgaXMgYSBuZXcgbGluZSBpbiBhIG5vdGU7IEN0cmwrRW50ZXIgc2F2ZXMsIGFzIGluIEdtYWlsJ3MgY29tcG9zZS4KICAgICAgb25rZXlkb3duOiBlID0-IHsgaWYgKGUua2V5ID09PSAnRW50ZXInICYmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5KSkgeyBlLnByZXZlbnREZWZhdWx0KCk7IHNhdmVFZGl0b3IoKTsgfSB9LAogICAgfSk7CgogICAgY29uc3Qgc3dh",
"dGNoZXMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnc3dhdGNoZXMnLCByb2xlOiAncmFkaW9ncm91cCcsICdhcmlhLWxhYmVsbGVkYnknOiAnZ2tiLWVkaXQtY29sb3VyJyB9LAogICAgICBbJycsIC4uLmxvZ2ljLkNBUkRfQ09MT1VSU10ubWFwKGMgPT4gewogICAgICAgIGNvbnN0IG5hbWUgPSBjID8gQ09MT1VSX05BTUVTW2NdIDogJ05vIGNvbG91cic7CiAgICAgICAgcmV0dXJuIGgoJ2xhYmVsJywgeyBjbGFzczogJ3N3YXRjaCcsIHRpdGxlOiBuYW1lLCBkYXRhc2V0OiB7IGNvbG91cjogYyB8fCAnbm9uZScgfSB9LAogICAgICAgICAgaCgnaW5wdXQnLCB7CiAgICAgICAgICAgIHR5cGU6ICdyYWRpbycsIG5hbWU6ICdna2ItY2FyZC1jb2xvdXInLCB2YWx1ZTogYywgY2hlY2tlZDogZC5jb2xvdXIgPT09IGMsICdhcmlhLWxhYmVsJzogbmFtZSwKICAgICAgICAgICAgZGF0YXNldDogeyBrZXk6IGBlZGl0LWNvbG91cjoke2MgfHwgJ25vbmUnfWAgfSwKICAgICAgICAgICAgb25jaGFuZ2U6ICgpID0-IHsgZC5jb2xvdXIgPSBjOyB9LAogICAgICAgICAgfSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3N3YXRjaC1kb3QnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSkpOwogICAgICB9KSk7CgogICAgY29uc3QgZGlhbG9nID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ2RpYWxvZycsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1tb2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6ICdna2ItZWRpdC1oZWFk",
"aW5nJywKICAgIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2ctaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItZWRpdC1oZWFkaW5nJywgdGV4dDogJ0VkaXQgY2FyZCcgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDbG9zZSB3aXRob3V0IHNhdmluZycsIG9uY2xpY2s6IGNsb3NlRWRpdG9yLAogICAgICAgIH0sIGljb24oJ2Nsb3NlJykpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1ib2R5JyB9LAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWVkaXQtdGl0bGUnLCB0ZXh0OiAnVGl0bGUgb24gdGhlIGJvYXJkJyB9KSwKICAgICAgICAgIE9iamVjdC5hc3NpZ24odGl0bGVJbnB1dCwgeyBpZDogJ2drYi1lZGl0LXRpdGxlJyB9KSwKICAgICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdoZWxwLXJvdycsIGlkOiAnZ2tiLWVkaXQtc3ViamVjdCcgfSwKICAgICAgICAgICAgaCgnc3BhbicsIHt9LCAnRW1haWwgc3ViamVjdDogJywgaCgnc3BhbicsIHsgY2xhc3M6ICdzdWJqZWN0LXJlZicsIHRleHQ6IGVkLnN1YmplY3QgfSkpLAogICAgICAgICAgICByZXNldCkpLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgo",
"J2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWVkaXQtbm90ZScsIHRleHQ6ICdOb3RlJyB9KSwKICAgICAgICAgIE9iamVjdC5hc3NpZ24obm90ZUlucHV0LCB7IGlkOiAnZ2tiLWVkaXQtbm90ZScgfSkpLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCBpZDogJ2drYi1lZGl0LWNvbG91cicsIHRleHQ6ICdDb2xvdXInIH0pLAogICAgICAgICAgc3dhdGNoZXMpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2Zvcm0tZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBlZC5lcnJvciB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1mb290JyB9LAogICAgICAgIGgoJ3NwYW4nLCB7CiAgICAgICAgICBjbGFzczogJ25vdGUnLAogICAgICAgICAgdGV4dDogJ09ubHkgdGhlIGJvYXJkIGNoYW5nZXMuIFRoZSBlbWFpbCBpdHNlbGYsIGFuZCB3aGF0IG90aGVycyBzZWUsIHN0YXkgYXMgdGhleSBhcmUuJywKICAgICAgICB9KSwKICAgICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiBjbG9zZUVkaXRvciB9KSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2J0biBidG4tcHJpbWFyeScsIHR5cGU6ICdidXR0b24nLCBkaXNhYmxlZDogZWQuc2F2aW5nLCBkYXRh",
"c2V0OiB7IGtleTogJ2VkaXQtc2F2ZScgfSwKICAgICAgICAgIHRleHQ6ICdTYXZlJywgb25jbGljazogc2F2ZUVkaXRvciwKICAgICAgICB9KSkpOwoKICAgIGVscy5lZGl0b3JMYXllci5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ3NjcmltJywgb25jbGljazogY2xvc2VFZGl0b3IgfSksIGRpYWxvZyk7CiAgICByZXN0b3JlRm9jdXMoa2V5LCBlbHMuZWRpdG9yTGF5ZXIpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUVkaXRvcigpIHsKICAgIGNvbnN0IGVkID0gUy5lZGl0b3I7CiAgICBpZiAoIWVkIHx8IGVkLnNhdmluZykgcmV0dXJuOwogICAgY29uc3QgZWRpdCA9IGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KGVkLmRyYWZ0LCBlZC5zdWJqZWN0KTsKICAgIGVkLnNhdmluZyA9IHRydWU7CiAgICBjb25zdCBzYXZlID0gZWxzLmVkaXRvckxheWVyLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0iZWRpdC1zYXZlIl0nKTsKICAgIGlmIChzYXZlKSBzYXZlLmRpc2FibGVkID0gdHJ1ZTsKCiAgICB0cnkgewogICAgICBhd2FpdCBzdG9yZS5zYXZlQ2FyZEVkaXQoUy5hY2NvdW50LCBlZC5pZCwgZWRpdCk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKFMuZWRpdG9yICE9PSBlZCkgcmV0dXJuOwogICAgICBlZC5zYXZpbmcgPSBmYWxzZTsKICAgICAgZWQuZXJyb3IgPSBgQ291bGRu4oCZdCBzYXZlOiAke2Vyci5tZXNzYWdlfWA7CiAgICAgIHJlbmRlckVkaXRvcignZWRpdC1zYXZlJyk7CiAg",
"ICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAoZWRpdCkgUy5lZGl0cy5zZXQoZWQuaWQsIGVkaXQpOwogICAgZWxzZSBTLmVkaXRzLmRlbGV0ZShlZC5pZCk7CiAgICBpZiAoUy5lZGl0b3IgPT09IGVkKSBTLmVkaXRvciA9IG51bGw7CiAgICByZW5kZXJFZGl0b3IoKTsKICAgIHJlbmRlcigpOwogICAgcmVzdG9yZUZvY3VzKGBtZW51OiR7ZWQuaWR9YCwgZWxzLmJvZHkpOwogICAgYW5ub3VuY2UoZWRpdCA_ICdDYXJkIHVwZGF0ZWQuJyA6ICdDYXJkIGJhY2sgdG8gc2hvd2luZyB0aGUgZW1haWwuJyk7CiAgfQoKICAvLyDilIDilIAgRXh0ZXJuYWwgY2hhbmdlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gQ29sdW1ucyBlZGl0ZWQgaW4gYW5vdGhlciB0YWIgb3Igb24gYW5vdGhlciBjb21wdXRlciAoc3RvcmFnZS5zeW5jKS4KICAvLyBUaGlzIHRhYidzIG93biBzYXZlcyBlY2hvIGJhY2sgaGVyZSB0b287IHRob3NlIGFyZSBhbHJlYWR5IG9uIHNjcmVlbi4KICBmdW5jdGlvbiBjb2x1bW5zQ2hhbmdlZChuZXh0KSB7CiAgICBpZiAobmV4dCAmJiBKU09OLnN0cmluZ2lmeShuZXh0KSA9PT0gSlNPTi5zdHJpbmdpZnkoUy5jb2x1bW5zKSkgcmV0dXJuOwogICAgUy5sb2FkZWRBdCA9IDA7CiAg",
"ICBpZiAoUy5vcGVuICYmICFTLmRyYXdlciAmJiBTLnZpZXcgPT09ICdib2FyZCcpIHJlZnJlc2goKTsKICB9CgogIC8vIENhcmQgZWRpdHMgc2F2ZWQgaW4gYW5vdGhlciB0YWIsIG9yIHN5bmNlZCBmcm9tIGFub3RoZXIgY29tcHV0ZXIuCiAgLy8gVGhpcyB0YWIncyBvd24gc2F2ZXMgZWNobyBiYWNrIGhlcmUgYXMgd2VsbDsgdGhvc2UgYXJlIGFscmVhZHkgZHJhd24sCiAgLy8gYW5kIHJlZHJhd2luZyBmb3IgdGhlbSB3b3VsZCBjbG9zZSBhIG1lbnUgb3BlbmVkIGluIHRoZSBtZWFudGltZS4KICBmdW5jdGlvbiBjYXJkRWRpdHNDaGFuZ2VkKGNoYW5nZXMsIHByZWZpeCkgewogICAgbGV0IGNoYW5nZWQgPSBmYWxzZTsKICAgIGZvciAoY29uc3QgW2tleSwgY2hhbmdlXSBvZiBPYmplY3QuZW50cmllcyhjaGFuZ2VzKSkgewogICAgICBpZiAoIWtleS5zdGFydHNXaXRoKHByZWZpeCkpIGNvbnRpbnVlOwogICAgICBjb25zdCBpZCA9IGtleS5zbGljZShwcmVmaXgubGVuZ3RoKTsKICAgICAgY29uc3QgbmV4dCA9IGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KGNoYW5nZSAmJiBjaGFuZ2UubmV3VmFsdWUpOwogICAgICBpZiAoSlNPTi5zdHJpbmdpZnkobmV4dCkgPT09IEpTT04uc3RyaW5naWZ5KFMuZWRpdHMuZ2V0KGlkKSB8fCBudWxsKSkgY29udGludWU7CiAgICAgIGlmIChuZXh0KSBTLmVkaXRzLnNldChpZCwgbmV4dCk7CiAgICAgIGVsc2UgUy5lZGl0cy5kZWxldGUoaWQpOwogICAgICBjaGFuZ2VkID0gdHJ1ZTsK",
"ICAgIH0KICAgIGlmIChjaGFuZ2VkICYmIFMub3BlbiAmJiBTLnN0YXR1cyA9PT0gJ3JlYWR5JyAmJiBTLnZpZXcgPT09ICdib2FyZCcpIHJlbmRlcigpOwogIH0KCiAgbnMuYm9hcmQgPSB7CiAgICBvcGVuLCBjbG9zZSwgdG9nZ2xlLCB0b2dnbGVWaWV3LCBjb2x1bW5zQ2hhbmdlZCwgY2FyZEVkaXRzQ2hhbmdlZCwKICAgIGlzT3BlbjogKCkgPT4gUy5vcGVuLAogICAgLy8gRm9yIHRoZSBwaG9uZSBhcHA6IHdoYXQgaXMgc2hvd2luZywgYW5kIGEgcmVmcmVzaCBpZiBpdCBpcyBzdGFsZS4KICAgIHZpZXc6ICgpID0-IFMudmlldywKICAgIHJlZnJlc2hJZlN0YWxlKCkgewogICAgICBpZiAoUy5vcGVuICYmIFMudmlldyA9PT0gJ2JvYXJkJyAmJiBEYXRlLm5vdygpIC0gUy5sb2FkZWRBdCA-IFNUQUxFX01TKSByZWZyZXNoKCk7CiAgICB9LAogIH07Cn0pKCk7Cg\"],[\"addon/app/shell.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAKLy8KLy8gVGhlIGV4dGVuc2lvbidzIGJvYXJkLCBOb3RlcyBhbmQgQ2FsZW5kYXIsIGZ1bGwtc2NyZWVuLCBhcyB0aGUg",
"YXBwCi8vIGl0c2VsZjogdGhlIHNhbWUgdGFicywgY29sdW1ucywgY2FyZHMsIG5vdGVzLCBzZWFyY2gsIGVkaXRvciwgYXV0b3NhdmUKLy8gYW5kIGNhbGVuZGFyLCB3aXRoIHRoZSBib2FyZCdzIHN0eWxlcyBhbmQgYSBwaG9uZSBsYXlvdXQgb24gdG9wLiBPbiBhCi8vIHBob25lIHRoZSBib2FyZCBzaG93cyBvbmUgY29sdW1uIGF0IGEgdGltZSwgc3dpcGVkIHNpZGV3YXlzOyB0aGUgbm90ZXMKLy8gb3BlbiBvbiB0aGUgU2NyYXRjaHBhZCwgdW5kZXIgdGhlIHNlYXJjaCBib3g7IGEgZm9sZGVyIG9yIGEgc2VhcmNoCi8vIHNob3dzIHRoZSBsaXN0IGluc3RlYWQsIGFuZCBhIG5vdGUgb3BlbnMgZnVsbC1zY3JlZW47IHRoZSBjYWxlbmRhciBpcwovLyB0aGUgd2VlayBhcyB0d28gY29sdW1ucyBvZiBkYXlzLCBzd2lwZWQgdG8gdGhlIG5leHQgd2Vlay4gQSBmaXJzdCB2aXNpdCBvcGVucyBvbiB0aGUKLy8gbm90ZXM7IGFmdGVyIHRoYXQsIG9uIHdoaWNoZXZlciB0YWIgd2FzIHVzZWQgbGFzdC4KLy8KLy8gQSBwaG9uZSBsZWF2ZXMgcGFnZXMgd2l0aG91dCBjbG9zaW5nIHRoZW0sIHNvIHdoYXRldmVyIGlzIHBlbmRpbmcgaXMKLy8gc2F2ZWQgd2hlbmV2ZXIgdGhlIHBhZ2UgaXMgaGlkZGVuOyBhbmQgQW5kcm9pZCdzIGJhY2sgZ2VzdHVyZSBzdGVwcwovLyBiYWNrIHRocm91Z2ggdGhlIG5vdGVzIC0gYSBub3RlIHRvIHRoZSBsaXN0LCB0aGUgbGlzdCB0byB0aGUKLy8gU2NyYXRjaHBhZCAtIHRocm91Z2ggZ29vZ2xl",
"LnNjcmlwdC5oaXN0b3J5LgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB7IG1vdW50U2hhZG93LCB0b2FzdCB9ID0gbnMudWk7CgogIC8vIEhvdyBsb25nIG9wZW5pbmcgdG9vaywgZm9yIGFueW9uZSBjdXJpb3VzICh0YXAgdGhlIGxvZ28pOiBmcm9tIHRoaXMKICAvLyBwYWdlJ3Mgc3RhcnQsIHdoaWNoIGNvbWVzIGFmdGVyIEdvb2dsZSdzIG93biBwYWdlIGFyb3VuZCBpdC4KICBjb25zdCBtYXJrcyA9IHsgY29kZTogcGVyZm9ybWFuY2Uubm93KCkgfTsKICBjb25zdCBtYXJrID0gbmFtZSA9PiB7IGlmICghKG5hbWUgaW4gbWFya3MpKSBtYXJrc1tuYW1lXSA9IHBlcmZvcm1hbmNlLm5vdygpOyB9OwogIGNvbnN0IHNlY3MgPSBtcyA9PiBgJHsobXMgLyAxMDAwKS50b0ZpeGVkKDEpfSBzYDsKICBmdW5jdGlvbiB0aW1pbmdUZXh0KCkgewogICAgY29uc3QgcGFydHMgPSBbYHBhZ2UgYW5kIGNvZGUgJHtzZWNzKG1hcmtzLmNv",
"ZGUpfWBdOwogICAgaWYgKCdyZWFkeScgaW4gbWFya3MpIHBhcnRzLnB1c2goYHJlYWR5IHRvIHR5cGUgJHtzZWNzKG1hcmtzLnJlYWR5KX1gKTsKICAgIGlmICgnY2hlY2tlZCcgaW4gbWFya3MpIHBhcnRzLnB1c2goYGNoZWNrZWQgd2l0aCBHbWFpbCAke3NlY3MobWFya3MuY2hlY2tlZCl9YCk7CiAgICBpZiAoJ2xpc3RlZCcgaW4gbWFya3MpIHBhcnRzLnB1c2goYGxpc3QgdXAgdG8gZGF0ZSAke3NlY3MobWFya3MubGlzdGVkKX1gKTsKICAgIHJldHVybiBgT3BlbmVkIGluICR7c2VjcyhtYXJrcy5yZWFkeSB8fCBtYXJrcy5jb2RlKX06ICR7cGFydHMuam9pbignLCAnKX0uYDsKICB9CgogIGNvbnN0IFBIT05FID0gYAo6aG9zdCB7IHBvc2l0aW9uOiBmaXhlZCAhaW1wb3J0YW50OyBpbnNldDogMCAhaW1wb3J0YW50OyB9Ci5vdmVybGF5IHsgcGFkZGluZzogZW52KHNhZmUtYXJlYS1pbnNldC10b3ApIGVudihzYWZlLWFyZWEtaW5zZXQtcmlnaHQpIGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSBlbnYoc2FmZS1hcmVhLWluc2V0LWxlZnQpOyB9CgpAbWVkaWEgKG1heC13aWR0aDogNzYwcHgpIHsKICAvKiBUaGUgaGVhZGVyOiB0aGUgbWFyaywgdGhlIHRocmVlIHRhYnMsIHJlZnJlc2ggYW5kIHRoZSBjb2x1bW4KICAgICBzZXR0aW5nczsgZ29uZSB3aGlsZSBhIG5vdGUgaGFzIHRoZSB3aG9sZSBzY3JlZW4uIE9uIGEgc21hbGwgcGhvbmUKICAgICBvbmx5IHRoZSBvcGVuIHRhYiBzYXlzIGl0cyBuYW1lLiAqLwog",
"IC5iYXIgeyBoZWlnaHQ6IDU2cHg7IHBhZGRpbmc6IDAgNHB4IDAgMTJweDsgZ2FwOiAycHg7IH0KICAuYnJhbmQgPiBzcGFuOm5vdCgubG9nbyksIC5hY2NvdW50LCAudXBkYXRlZCB7IGRpc3BsYXk6IG5vbmU7IH0KICAudGFicyB7IG1hcmdpbi1sZWZ0OiAxMHB4OyBtaW4td2lkdGg6IDA7IH0KICAudGFiIHsgcGFkZGluZzogMCAxMnB4IDAgMTBweDsgfQogIDpob3N0KFtkYXRhLXZpZXc9Im5vdGUiXSkgLmJhciB7IGRpc3BsYXk6IG5vbmU7IH0KCiAgLyogVGhlIGJvYXJkOiBvbmUgY29sdW1uIHRvIGEgc2NyZWVuLCBzd2lwZWQgc2lkZXdheXMuIENhcmRzIG1vdmUgd2l0aAogICAgIHRoZWlyIOKLryBtZW51LCBzaW5jZSBhIGZpbmdlciBjYW5ub3QgZHJhZyB0aGVtLiAqLwogIC5jb2x1bW5zIHsgc2Nyb2xsLXNuYXAtdHlwZTogeCBtYW5kYXRvcnk7IGdhcDogMTBweDsgcGFkZGluZzogNHB4IDE2cHggMTJweDsgc2Nyb2xsLXBhZGRpbmc6IDAgMTZweDsgfQogIC5jb2x1bW4geyBmbGV4OiAwIDAgY2FsYygxMDB2dyAtIDQ0cHgpOyBtaW4td2lkdGg6IDA7IG1heC13aWR0aDogbm9uZTsgc2Nyb2xsLXNuYXAtYWxpZ246IGNlbnRlcjsgfQoKICAubm90ZXMgeyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDA7IHBhZGRpbmc6IDA7IH0KICAubm90ZXNbZGF0YS12aWV3PSJub3RlIl0gLm5vdGVzLWZvbGRlcnMsIC5ub3Rlc1tkYXRhLXZpZXc9Im5vdGUiXSAubm90ZXMtbGlzdCB7IGRpc3BsYXk6IG5vbmU7IH0K",
"ICAubm90ZXNbZGF0YS12aWV3PSJsaXN0Il0gLm5vdGUtZWRpdG9yIHsgZGlzcGxheTogbm9uZTsgfQoKICAvKiBIb21lOiB0aGUgc2VhcmNoIGJveCwgYW5kIHRoZSBzY3JhdGNocGFkIGZpbGxpbmcgdGhlIHJlc3QuICovCiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5ub3Rlcy1saXN0IHsgZmxleDogbm9uZTsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubm90ZXMtc2NvcGUsIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubm90ZXMtaXRlbXMsIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubm90ZXMtZm9vdCB7IGRpc3BsYXk6IG5vbmU7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5vdGUtZWRpdG9yIHsgbWFyZ2luOiAwIDEycHggMTJweDsgYm9yZGVyLXJhZGl1czogMjJweDsgbWluLWhlaWdodDogMDsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubmUtdGl0bGUgeyBwYWRkaW5nOiAxNHB4IDE4cHggNnB4OyB9CiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5uZS10b29sYmFyIHsgbWFyZ2luOiAwIDEwcHg7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5lLWJvZHkgeyBwYWRkaW5nOiAxMHB4IDE4cHggMjB2aDsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubmUtYm9keVtkYXRhLWVtcHR5PSIxIl06OmJlZm9yZSB7IGxlZnQ6IDE4cHg7IHJpZ2h0OiAxOHB4OyB9CgogIC8qIEZvbGRlcnM6IHRoZSB0cmVlLCBmb2xkZWQgYXdheSBiZWhpbmQgYSBidXR0b24g",
"dGhhdCBzYXlzIHdoZXJlIHlvdQogICAgIGFyZTsgb3BlbiwgaXQgaXMgdGhlIHNhbWUgdHJlZSBhcyBvbiBhIGNvbXB1dGVyLCBuZXN0aW5nIGFuZCBhbGwuICovCiAgLm5vdGVzLWZvbGRlcnMgeyBmbGV4OiBub25lOyBiYWNrZ3JvdW5kOiBub25lOyBib3JkZXItcmFkaXVzOiAwOyBwYWRkaW5nOiAycHggMTJweCA0cHg7IH0KICAuZm9sZGVycy10b2dnbGUgewogICAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAxMHB4OyB3aWR0aDogMTAwJTsgaGVpZ2h0OiA0NnB4OyBwYWRkaW5nOiAwIDEwcHggMCAxNHB4OwogICAgYm9yZGVyLXJhZGl1czogMTRweDsgYmFja2dyb3VuZDogdmFyKC0tY29sKTsgY29sb3I6IHZhcigtLWZnKTsgZm9udC1zaXplOiAxNXB4OyB0ZXh0LWFsaWduOiBsZWZ0OwogIH0KICAuZm9sZGVycy10b2dnbGUgLmljb24geyBjb2xvcjogdmFyKC0tZmctMik7IGZsZXg6IG5vbmU7IH0KICAuZnQtbGFiZWwgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9CiAgLmZ0LWNvdW50IHsgY29sb3I6IHZhcigtLWZnLTMpOyBmb250LXNpemU6IDEzcHg7IGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7IH0KICAubm90ZXNbZGF0YS1mb2xkZXJzPSJvcGVuIl0gLmZvbGRlcnMtdG9nZ2xlIHsgYm9yZGVyLXJhZGl1czogMTRweCAxNHB4IDAgMDsgfQogIC5u",
"b3Rlc1tkYXRhLWZvbGRlcnM9Im9wZW4iXSAuZm9sZGVycy10b2dnbGUgLmljb246bGFzdC1jaGlsZCB7IHRyYW5zZm9ybTogcm90YXRlKDE4MGRlZyk7IH0KICAubm90ZXM6bm90KFtkYXRhLWZvbGRlcnM9Im9wZW4iXSkgLmZvbGRlcnMtaGVhZCwgLm5vdGVzOm5vdChbZGF0YS1mb2xkZXJzPSJvcGVuIl0pIC5mb2xkZXItaXRlbXMgeyBkaXNwbGF5OiBub25lOyB9CiAgLmZvbGRlcnMtaGVhZCB7IGJhY2tncm91bmQ6IHZhcigtLWNvbCk7IHBhZGRpbmc6IDAgNnB4IDAgMTZweDsgfQogIC5mb2xkZXItaXRlbXMgeyBmbGV4OiBub25lOyBtYXgtaGVpZ2h0OiA1NXZoOyBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOyBib3JkZXItcmFkaXVzOiAwIDAgMTRweCAxNHB4OyBwYWRkaW5nOiAycHggOHB4IDEwcHg7IH0KICAuZm9sZGVyLWJ0biB7IGhlaWdodDogNDRweDsgfQogIC5mb2xkZXItdHdpc3R5IHsgd2lkdGg6IDM0cHg7IGhlaWdodDogNDRweDsgbWFyZ2luLXJpZ2h0OiAwOyB9CiAgLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci1lZGl0IHsgcGFkZGluZy1sZWZ0OiA0NHB4OyB9CiAgLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci1lcnJvciB7IHBhZGRpbmctbGVmdDogNzBweDsgfQogIC8qIE5vIGhvdmVyIG9uIGEgcGhvbmU6IGVhY2ggZm9sZGVyJ3Mg4ouvIGlzIGFsd2F5cyB0aGVyZSwgbmV4dCB0byBpdHMgY291bnQuICovCiAgLmZvbGRlci1tZW51IHsgb3BhY2l0eTogMTsgcmlnaHQ6",
"IDRweDsgfQogIC5mb2xkZXItcm93IC5mb2xkZXItY291bnQsIC5mb2xkZXItcm93OmhvdmVyIC5mb2xkZXItY291bnQsIC5mb2xkZXItcm93OmZvY3VzLXdpdGhpbiAuZm9sZGVyLWNvdW50IHsgdmlzaWJpbGl0eTogdmlzaWJsZTsgbWFyZ2luLXJpZ2h0OiAzNHB4OyB9CgogIC5ub3Rlcy1saXN0IHsgZmxleDogMTsgYm9yZGVyLXJhZGl1czogMDsgYmFja2dyb3VuZDogbm9uZTsgfQogIC5ub3Rlcy10b29scyB7IHBhZGRpbmc6IDRweCAxMnB4IDhweDsgfQogIC5ub3Rlcy1pdGVtcyB7IHBhZGRpbmc6IDAgNHB4IDEycHg7IH0KICAubm90ZS1pdGVtIHsgcGFkZGluZzogMTJweDsgfQoKICAubm90ZS1lZGl0b3IgeyBmbGV4OiAxOyBib3JkZXItcmFkaXVzOiAwOyBib3gtc2hhZG93OiBub25lOyB9CiAgLm5lLWJhY2sgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgbWFyZ2luLXJpZ2h0OiAycHg7IH0KICAubmUtYmFyIHsgcGFkZGluZzogNnB4IDZweCAwIDRweDsgfQogIC5uZS10aXRsZSB7IHBhZGRpbmc6IDZweCAxNnB4IDRweDsgZm9udC1zaXplOiAyMnB4OyB9CiAgLm5lLXRvb2xiYXIgeyBtYXJnaW46IDAgOHB4OyBvdmVyZmxvdy14OiBhdXRvOyBmbGV4LXdyYXA6IG5vd3JhcDsgc2Nyb2xsYmFyLXdpZHRoOiBub25lOyB9CiAgLm5lLWxpbmtiYXIgeyBtYXJnaW46IDRweCA4cHggMDsgfQogIC5uZS1iYW5uZXIgeyBtYXJnaW46IDRweCAxMnB4IDA7IH0KICAubmUtZmluZCB7IG1hcmdpbjogNHB4IDEycHggMDsgfQog",
"IC5uZS1ib2R5IHsgcGFkZGluZzogMTBweCAxNnB4IDQwdmg7IGZvbnQtc2l6ZTogMTZweDsgfQogIC5uZS1ib2R5W2RhdGEtZW1wdHk9IjEiXTo6YmVmb3JlIHsgbGVmdDogMTZweDsgfQp9CkBtZWRpYSAobWF4LXdpZHRoOiA0ODBweCkgewogIC50YWJbYXJpYS1zZWxlY3RlZD0iZmFsc2UiXSB7IGdhcDogMDsgcGFkZGluZzogMCAxMHB4OyBmb250LXNpemU6IDA7IH0KfQpgOwoKICAvLyBBcHBzIFNjcmlwdCdzIGhpc3RvcnksIGlmIHRoZXJlIGlzIG9uZSwgdXNlZCBzbyB0aGF0IG5vdGhpbmcgaXQgZG9lcyAtCiAgLy8gb3IgZmFpbHMgdG8gZG8gLSBjYW4gc3RvcCB0aGUgYXBwOiB0aGUgYmFjayBnZXN0dXJlIGlzIGEgbmljZXR5LgogIGZ1bmN0aW9uIGhpc3RvcnlBcGkoKSB7CiAgICBjb25zdCBhcGkgPSB0eXBlb2YgZ29vZ2xlICE9PSAndW5kZWZpbmVkJyAmJiBnb29nbGUuc2NyaXB0ICYmIGdvb2dsZS5zY3JpcHQuaGlzdG9yeTsKICAgIGlmICghYXBpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHNhZmUgPSBmbiA9PiAoLi4uYXJncykgPT4gewogICAgICB0cnkgeyByZXR1cm4gYXBpW2ZuXSguLi5hcmdzKTsgfSBjYXRjaCAoZXJyKSB7IGNvbnNvbGUud2FybihgZ29vZ2xlLnNjcmlwdC5oaXN0b3J5LiR7Zm59OiAke2Vyci5tZXNzYWdlfWApOyByZXR1cm4gdW5kZWZpbmVkOyB9CiAgICB9OwogICAgcmV0dXJuIHsgcHVzaDogc2FmZSgncHVzaCcpLCByZXBsYWNlOiBzYWZlKCdyZXBsYWNlJyksIHNldENoYW5n",
"ZUhhbmRsZXI6IHNhZmUoJ3NldENoYW5nZUhhbmRsZXInKSB9OwogIH0KCiAgY29uc3Qgd2lkZSA9ICgpID0-ICEhKHdpbmRvdy5tYXRjaE1lZGlhICYmIHdpbmRvdy5tYXRjaE1lZGlhKCcobWluLXdpZHRoOiA3NjFweCknKS5tYXRjaGVzKTsKCiAgZnVuY3Rpb24gc3RhcnQoKSB7CiAgICAvLyBXaXRob3V0IGFsbCBpdHMgcGFydHMgdGhlIGFwcCBjYW5ub3Qgd29yazogdGhlIGxvYWRlcidzIGxpc3Qgb2YKICAgIC8vIHdoYXQgZGlkIG5vdCBsb2FkIHN0YXlzIG9uIHRoZSBzY3JlZW4gaW5zdGVhZC4KICAgIGlmICh3aW5kb3cuX19wYXJ0c0ZhaWxlZCAmJiB3aW5kb3cuX19wYXJ0c0ZhaWxlZC5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IHsgaG9zdCwgcm9vdCB9ID0gbW91bnRTaGFkb3coJ2drYi1hcHAtaG9zdCcsIG5zLnN0eWxlcy5ib2FyZCArIFBIT05FKTsKICAgIGNvbnN0IGhpc3RvcnkgPSBoaXN0b3J5QXBpKCk7CiAgICAvLyBIb3cgbWFueSBzdGVwcyBpbiBmcm9tIHRoZSBTY3JhdGNocGFkIHRoZSBoaXN0b3J5IGhvbGRzLCBhbmQgd2hldGhlcgogICAgLy8gdGhlIGJhY2sgZ2VzdHVyZSBpcyBiZWluZyBmb2xsb3dlZCByaWdodCBub3cuCiAgICBsZXQgZGVwdGggPSAwOwogICAgbGV0IHN0ZXBwaW5nID0gZmFsc2U7CgogICAgLy8gV2hpY2ggZm9sZGVycyBhcmUgZm9sZGVkLCB3aGljaCBjYWxlbmRhcnMgc2hvdywgb24gdGhpcyBwaG9uZS4gVGhlCiAgICAvLyBwYWdlIGlzIG9ubHkgZXZlciBvcGVuZWQg",
"YnkgaXRzIG93bmVyLCBzbyB0aGVyZSBpcyBubyBhY2NvdW50IHRvCiAgICAvLyBrZXkgdGhlbSBieS4gVGhlICdzdXBlcm1haWwuJyBwcmVmaXggaXMgdGhlIGFwcCdzIG9sZCBuYW1lLCBrZXB0IHNvCiAgICAvLyBwcmVmcyBzYXZlZCBiZWZvcmUgdGhlIHJlbmFtZSBzdGlsbCBjb3VudC4KICAgIGNvbnN0IHByZWZzID0gewogICAgICBnZXQobmFtZSkgewogICAgICAgIHRyeSB7IHJldHVybiBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKGBzdXBlcm1haWwuJHtuYW1lfWApIHx8ICdudWxsJyk7IH0gY2F0Y2ggKGVycikgeyByZXR1cm4gbnVsbDsgfQogICAgICB9LAogICAgICBzZXQobmFtZSwgdmFsdWUpIHsKICAgICAgICB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShgc3VwZXJtYWlsLiR7bmFtZX1gLCBKU09OLnN0cmluZ2lmeSh2YWx1ZSkpOyB9IGNhdGNoIChlcnIpIHsgLyogc3RvcmFnZSBvZmY6IG5vdCByZW1lbWJlcmVkICovIH0KICAgICAgfSwKICAgIH07CgogICAgbnMuYm9hcmRGcmFtZSA9IHsKICAgICAgcm9vdCwKICAgICAgdmlldzogJ25vdGVzJywKICAgICAgLy8gT24gYSBjb21wdXRlciwgdHlwaW5nIGdvZXMgc3RyYWlnaHQgaW50byB0aGUgU2NyYXRjaHBhZC4gKEEgcGhvbmUKICAgICAgLy8gd291bGQgb25seSBwb3AgaXRzIGtleWJvYXJkIHVwIG92ZXIgaXQsIHNvIHRoZXJlIGl0IHdhaXRzIGZvciBhIHRhcC4pCiAgICAgIGZvY3VzOiB3aWRlKCksCiAgICAgIC8vIFRoZSBzY3Jp",
"cHQncyBvd24gYWNjZXNzIGNvdmVycyB0aGUgY2FsZW5kYXI6IG5vdGhpbmcgdG8gY29ubmVjdC4KICAgICAgY2FsZW5kYXI6IHsgcHJlZnMsIGNvbm5lY3Q6IG51bGwgfSwKICAgICAgbm90ZXM6IHsKICAgICAgICBwcmVmcywKICAgICAgICAvLyBFYWNoIHN0ZXAgaW4gZ29lcyBvbiB0aGUgaGlzdG9yeSwgc28gdGhlIGJhY2sgZ2VzdHVyZSBjYW4gdW5kbyBpdDsKICAgICAgICAvLyBhIHN0ZXAgb3V0IHRha2VuIGluIHRoZSBhcHAgaXRzZWxmIHJld3JpdGVzIHRoZSB0b3AgZW50cnkgaW5zdGVhZCwKICAgICAgICAvLyBzaW5jZSBub3RoaW5nIGhlcmUgY2FuIHRha2UgYW4gZW50cnkgb2ZmLgogICAgICAgIG9uVmlld0NoYW5nZSh2aWV3KSB7CiAgICAgICAgICBob3N0LmRhdGFzZXQudmlldyA9IHZpZXc7CiAgICAgICAgICBjb25zdCBkID0gbnMubm90ZXMuZGVwdGgoKTsKICAgICAgICAgIGlmIChoaXN0b3J5ICYmICFzdGVwcGluZykgewogICAgICAgICAgICBpZiAoZCA-IGRlcHRoKSBmb3IgKGxldCBpID0gZGVwdGggKyAxOyBpIDw9IGQ7IGkrKykgaGlzdG9yeS5wdXNoKHsgZGVwdGg6IGkgfSwge30sICcnKTsKICAgICAgICAgICAgZWxzZSBpZiAoZCA8IGRlcHRoKSBoaXN0b3J5LnJlcGxhY2UoeyBkZXB0aDogZCB9LCB7fSwgJycpOwogICAgICAgICAgfQogICAgICAgICAgZGVwdGggPSBkOwogICAgICAgIH0sCiAgICAgIH0sCiAgICB9OwoKICAgIGlmIChoaXN0b3J5KSB7CiAgICAgIGhpc3Rvcnkuc2V0Q2hh",
"bmdlSGFuZGxlcihhc3luYyBlID0-IHsKICAgICAgICBjb25zdCB0YXJnZXQgPSAoZSAmJiBlLnN0YXRlICYmIE51bWJlcihlLnN0YXRlLmRlcHRoKSkgfHwgMDsKICAgICAgICBzdGVwcGluZyA9IHRydWU7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHdoaWxlIChucy5ub3Rlcy5kZXB0aCgpID4gdGFyZ2V0KSB7CiAgICAgICAgICAgIGNvbnN0IGJlZm9yZSA9IG5zLm5vdGVzLmRlcHRoKCk7CiAgICAgICAgICAgIGF3YWl0IG5zLm5vdGVzLmJhY2soKTsKICAgICAgICAgICAgaWYgKG5zLm5vdGVzLmRlcHRoKCkgPj0gYmVmb3JlKSBicmVhazsgLy8gYW4gdW5zYXZlZCBlZGl0IGtlcHQgdGhlIG5vdGUgb3BlbgogICAgICAgICAgfQogICAgICAgIH0gZmluYWxseSB7CiAgICAgICAgICBzdGVwcGluZyA9IGZhbHNlOwogICAgICAgIH0KICAgICAgICAvLyBOb3QgYXMgZmFyIGJhY2sgYXMgdGhlIGdlc3R1cmUgd2VudDogdGhvc2Ugc3RlcHMgZ28gYmFjayBvbi4KICAgICAgICBkZXB0aCA9IG5zLm5vdGVzLmRlcHRoKCk7CiAgICAgICAgZm9yIChsZXQgaSA9IHRhcmdldCArIDE7IGkgPD0gZGVwdGg7IGkrKykgaGlzdG9yeS5wdXNoKHsgZGVwdGg6IGkgfSwge30sICcnKTsKICAgICAgfSk7CiAgICB9CgogICAgLy8gQSBwaG9uZSBzd2l0Y2hlcyBhd2F5IHdpdGhvdXQgY2xvc2luZyB0aGUgcGFnZS4KICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3Zpc2liaWxpdHljaGFuZ2UnLCAoKSA9PiB7CiAgICAgIGlmIChk",
"b2N1bWVudC52aXNpYmlsaXR5U3RhdGUgPT09ICdoaWRkZW4nKSBucy5ub3Rlcy5mbHVzaCgpOwogICAgICBlbHNlIGlmIChucy5ib2FyZC52aWV3KCkgPT09ICdub3RlcycpIHsgaWYgKG5zLm5vdGVzLmlzU3RhbGUoKSkgbnMubm90ZXMubG9hZCgpOyB9CiAgICAgIGVsc2UgaWYgKG5zLmJvYXJkLnZpZXcoKSA9PT0gJ2NhbGVuZGFyJykgeyBpZiAobnMuY2FsZW5kYXIuaXNTdGFsZSgpKSBucy5jYWxlbmRhci5sb2FkKCk7IH0KICAgICAgZWxzZSBucy5ib2FyZC5yZWZyZXNoSWZTdGFsZSgpOwogICAgfSk7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncGFnZWhpZGUnLCAoKSA9PiBucy5ub3Rlcy5mbHVzaCgpKTsKCiAgICByb290LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZSA9PiB7CiAgICAgIGlmIChlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0LmNsb3Nlc3QoJy5icmFuZCAubG9nbycpKSB0b2FzdChyb290LCB0aW1pbmdUZXh0KCksIHsgdGltZW91dDogODAwMCB9KTsKICAgIH0pOwoKICAgIC8vIE9uZSBjYWxsIHRvIHRoZSBzY3JpcHQsIHNlbnQgYmVmb3JlIGFueXRoaW5nIGVsc2UgKHJlbW90ZS5qcykuIFdpdGgKICAgIC8vIHRoZSBwaG9uZSdzIGNvcHkgb2YgdGhlIG5vdGVzLCB0aGUgYXBwIG9wZW5zIG9uIHRoYXQgYXQgb25jZSBhbmQgdGhlCiAgICAvLyBjYWxsIGNhdGNoZXMgaXQgdXA7IHdpdGhvdXQgb25lIChhIGZpcnN0IHZpc2l0KSwgaXQgd2FpdHMgZm9yIGl0LgogICAgY29uc3Qg",
"cmVtb3RlID0gbnMuYXBwUmVtb3RlOwogICAgY29uc3QgYmVndW4gPSByZW1vdGUuc3RhcnQoKTsKICAgIGNvbnN0IHNob3cgPSAoKSA9PiB7CiAgICAgIG5zLmJvYXJkLm9wZW4oKTsKICAgICAgY29uc3QgYm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdib290Jyk7CiAgICAgIGlmIChib290KSBib290LnJlbW92ZSgpOwogICAgICBtYXJrKCdyZWFkeScpOwogICAgfTsKICAgIGNvbnN0IGNhdWdodFVwID0gciA9PiB7CiAgICAgIG1hcmsoJ2NoZWNrZWQnKTsKICAgICAgaWYgKHIub3RoZXJBY2NvdW50ICYmIHdpbmRvdy5fX2Jvb3RGYWlsZWQpIHsKICAgICAgICB3aW5kb3cuX19ib290RmFpbGVkKCdUaGlzIHBob25lIGhhZCBub3RlcyBmcm9tIGFub3RoZXIgR29vZ2xlIGFjY291bnQsIG5vdyBjbGVhcmVkLiBDbG9zZSB0aGUgYXBwIGFuZCBvcGVuIGl0IGFnYWluLicpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBucy5ub3Rlcy5zY3JhdGNoRm91bmQoci5zY3JhdGNoKTsKICAgIH07CiAgICBsZXQgcG9sbHMgPSAwOwogICAgY29uc3QgbGlzdGVkID0gKCkgPT4gewogICAgICBpZiAobnMubm90ZXMubG9hZGVkQXQoKSkgbWFyaygnbGlzdGVkJyk7CiAgICAgIGVsc2UgaWYgKCsrcG9sbHMgPCAzMDApIHNldFRpbWVvdXQobGlzdGVkLCAyMDApOwogICAgfTsKICAgIGxpc3RlZCgpOwogICAgaWYgKHJlbW90ZS5oYXNDb3B5KCkpIHsKICAgICAgc2hvdygpOwogICAgICAvLyBPZmZsaW5lLCBvciB0",
"aGUgc2NyaXB0IHVucmVhY2hhYmxlOiB0aGUgY29weSBjYXJyaWVzIG9uLCBhbmQgdGhlCiAgICAgIC8vIG5vdGVzJyBvd24gbG9hZGluZyBzYXlzIHdoYXQgaXMgd3JvbmcuCiAgICAgIHJldHVybiBiZWd1bi50aGVuKGNhdWdodFVwLCBlcnIgPT4gY29uc29sZS53YXJuKGBUaGUgZmlyc3QgY2FsbCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCkpOwogICAgfQogICAgcmV0dXJuIGJlZ3VuLnRoZW4ociA9PiB7CiAgICAgIHNob3coKTsKICAgICAgY2F1Z2h0VXAocik7CiAgICB9LCBlcnIgPT4gewogICAgICBpZiAod2luZG93Ll9fYm9vdEZhaWxlZCkgd2luZG93Ll9fYm9vdEZhaWxlZChgR21haWwgY291bGQgbm90IGJlIHJlYWNoZWQ6ICR7ZXJyLm1lc3NhZ2V9YCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHJ1bigpIHsKICAgIHRyeSB7CiAgICAgIHN0YXJ0KCk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgY29uc29sZS5lcnJvcihlcnIpOwogICAgICBpZiAod2luZG93Ll9fYm9vdEZhaWxlZCkgd2luZG93Ll9fYm9vdEZhaWxlZChlcnIubWVzc2FnZSwgZXJyLnN0YWNrKTsKICAgIH0KICB9CgogIG5zLnBob25lQXBwID0geyBzdGFydCB9OwogIGlmIChkb2N1bWVudC5yZWFkeVN0YXRlID09PSAnbG9hZGluZycpIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCBydW4pOwogIGVsc2UgcnVuKCk7Cn0pKCk7Cg\"]];\n  var SOURCE = String.fromCharCode(10, 47, 47) + ",
"'# sourceURL=app/';\n  function decode(text) {\n    var bin = atob(text.replace(/-/g, '+').replace(/_/g, String.fromCharCode(47)));\n    var bytes = new Uint8Array(bin.length);\n    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n    return new TextDecoder('utf-8').decode(bytes);\n  }\n  function run(name, code) {\n    try {\n      (0, eval)(code + SOURCE + name);\n    } catch (err) {\n      if (!(err instanceof EvalError)) throw err;\n      var el = document.createElement('script');\n      el.text = code + SOURCE + name;\n      document.head.appendChild(el);\n    }\n  }\n  var failed = [];\n  for (var i = 0; i < MODULES.length; i++) {\n    try {\n      run(MODULES[i][0], decode(MODULES[i][1]));\n    } catch (err) {\n      failed.push(MODULES[i][0] + ': ' + err.message);\n    }\n  }\n  if (failed.length) {\n    window.__partsFailed = failed;\n    if (window.__bootFailed) window.__bootFailed('Parts that did not load: ' + failed.join('; '));\n  }\n})();\n</script>\n</body>\n</html>\n",
].join('');
