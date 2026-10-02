// The phone panel and phone app 0.17.0: a Gmail add-on and a web app, in Apps Script.
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
var SUPERMAIL_NOTES_LABEL = '_Notes';
var SUPERMAIL_BOARD_LABEL = '_Board';

// The phone app's icon, in the browser tab and on the home screen.
var SUPERMAIL_ICON_URL = 'https://raw.githubusercontent.com/michaelbeijer/Supermail/main/icons/icon-192.png';

var SUPERMAIL_VERSION = '0.17.0';

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

  const APP_NAME = 'Supermail';

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

  const api = {
    TYPES, LISTS, MAX_LEVEL,
    block, emptyDoc, normaliseRuns, normaliseDoc, docText, isEmpty, safeHref,
    toHtml, toPlain, fromPlain, parseHtml, docFromParts, fromMarkdown, looksLikeMarkdown, hasFormatting, pasteDoc,
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
  const rootName = () => String(globalThis.SUPERMAIL_NOTES_LABEL || notesLogic.DEFAULT_LABEL).trim();
  const boardName = () => String(globalThis.SUPERMAIL_BOARD_LABEL || ns.logic.DEFAULT_ROOT).trim();

  // What one card needs to know about the mailbox, read once per trigger
  // or button press: the notes label (made if it is missing), its
  // folders, the board's columns, and - only if a save needs it - the
  // account's address.
  function context() {
    const name = rootName();
    let all = gmail.call('GET', 'labels').labels || [];
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

  // A new version (or a new note), and the old one retired. What the page
  // says about the previous version is not taken on trust: it is read.
  function save(previousId, snap) {
    const ctx = store.context();
    const previous = previousId ? store.peek(ctx, previousId) : null;
    const s = snap || {};
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
    const html = globalThis.SUPERMAIL_APP_HTML || '';
    if (e && e.parameter && e.parameter.ping) {
      return HtmlService.createHtmlOutput(`<p style="font: 16px/1.5 Arial, sans-serif; padding: 24px">${ns.APP_NAME} ${globalThis.SUPERMAIL_VERSION || ''}: ` +
        `the script runs, and its page is ${html.length} characters long.</p>`).setTitle(`${ns.APP_NAME} notes`);
    }
    const out = HtmlService.createHtmlOutput(html || '<p>The app is not built into this Code.gs.</p>')
      .setTitle(ns.APP_NAME)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
    // Our icon rather than Apps Script's, in the tab and on the home screen.
    // Only a nicety: a refused address must not cost the page.
    try {
      if (globalThis.SUPERMAIL_ICON_URL) out.setFaviconUrl(globalThis.SUPERMAIL_ICON_URL);
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
  function boardColumns() {
    const labels = gmail.call('GET', 'labels').labels || [];
    const cols = ns.panelLogic.boardColumns(labels, String(globalThis.SUPERMAIL_BOARD_LABEL || ns.logic.DEFAULT_ROOT).trim());
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
    return gmail.getAll(urls).map(r => {
      if (!r || !r.error) return r;
      const e = r.error;
      // Google's consent screen lets people untick Calendar or Tasks.
      if (e.status === 403 && /insufficient.*scope/i.test(e.detail || e.message)) {
        return { error: { code: 'calendar_scope', status: 403, message: 'It was not allowed when the app was authorised. Open the app again, and allow it when Google asks.' } };
      }
      return { error: { message: e.detail || e.message, status: e.status || 0 } };
    });
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
    page, list, body, save, retire, restore, move, createFolder, renameFolder, deleteFolder,
    account, boardGmail, boardGmailMany, boardColumns, googleMany, prefsGet, prefsSet, prefsRemove,
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
function appPrefsGet(keys) { return gkb.app.prefsGet(keys); }
function appPrefsSet(items) { return gkb.app.prefsSet(items); }
function appPrefsRemove(keys) { return gkb.app.prefsRemove(keys); }

// ════ the phone app's page (addon/app, built) ════════════════════

var SUPERMAIL_APP_HTML = [
"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<base target=\"_top\">\n<style>\n  html, body { margin: 0; height: 100%; background: #f6f8fc; }\n  @media (prefers-color-scheme: dark) { html, body { background: #131314; } }\n</style>\n</head>\n<body>\n<div id=\"boot\" style=\"font: 16px/1.5 Roboto, Arial, sans-serif; color: #444746; padding: 24px;\">Loading&hellip;</div>\n<script>\n  (function () {\n    var problems = [];\n    function show(message, stack) {\n      var boot = document.getElementById('boot');\n      if (!boot) return;\n      problems.push(String(message) + (stack ? '\\n' + String(stack).split('\\n').slice(0, 6).join('\\n') : ''));\n      boot.style.color = '#b3261e';\n      boot.textContent = 'The app could not start.';\n      var pre = document.createElement('pre');\n      pre.style.cssText = 'white-space: pre-wrap; font-size: 12px; color: #444746;';\n      pre.textContent = problems.join('\\n\\n'",
");\n      boot.appendChild(pre);\n    }\n    window.addEventListener('error', function (e) {\n      show((e.message || 'unknown error') + (e.lineno ? ' (line ' + e.lineno + ')' : ''), e.error && e.error.stack);\n    });\n    window.addEventListener('unhandledrejection', function (e) {\n      show(String((e.reason && e.reason.message) || e.reason), e.reason && e.reason.stack);\n    });\n    window.__bootFailed = show;\n  })();\n</script>\n<script>\n(function () {\n  var MODULES = [[\"src/shared/ns.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNoYXJlZCBuYW1lc3BhY2UKLy8KLy8gQ29udGVudCBzY3JpcHRzIGFyZSBjbGFzc2ljIHNjcmlwdHMgdGhhdCBhbGwgcnVuIGluIG9uZSBpc29sYXRlZCB3b3JsZC4KLy8gVHdvIGZpbGVzIHRoYXQgZWFjaCBkZWNsYXJlZCBhIHRvcC1sZXZlbCBgY29uc3RgIG9mIHRoZSBzYW1lIG5hbWUgd291",
"bGQKLy8gY29sbGlkZSwgc28gZXZlcnkgZmlsZSB3cmFwcyBpdHNlbGYgaW4gYW4gSUlGRSBhbmQgaGFuZ3Mgd2hhdCBpdCBleHBvcnRzCi8vIG9mZiB0aGlzIG9uZSBvYmplY3QgaW5zdGVhZC4gVGhlIHNlcnZpY2Ugd29ya2VyIGFuZCB0aGUgb3B0aW9ucyBwYWdlCi8vIGxvYWQgdGhlIHNhbWUgZmlsZXMgYW5kIHNlZSB0aGUgc2FtZSBzaGFwZS4KLy8KLy8gQVBQX05BTUUgaXMgdGhlIG9ubHkgcGxhY2UgdGhlIGRpc3BsYXkgbmFtZSBsaXZlcyBpbiBjb2RlLiBOb3RoaW5nCi8vIGludGVybmFsIC0gdGhlIG5hbWVzcGFjZSwgc3RvcmFnZSBrZXlzLCBDU1MgY2xhc3NlcywgZWxlbWVudCBpZHMgLSBpcwovLyBkZXJpdmVkIGZyb20gaXQsIHNvIGEgcmVuYW1lIG5ldmVyIGhhcyB0byB0b3VjaCBzdG9yZWQgZGF0YS4gVGhlIFJFQURNRQovLyBsaXN0cyBldmVyeSBzcG90IHRoYXQgZG9lcyBjYXJyeSB0aGUgbmFtZS4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlz",
"LmdrYiB8fCB7fSk7CgogIGNvbnN0IEFQUF9OQU1FID0gJ1N1cGVybWFpbCc7CgogIC8vIOKUgOKUgCBTdG9yYWdlIGtleXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBLZXllZCBieSBsb3dlci1jYXNlZCBhY2NvdW50IGVtYWlsLCBiZWNhdXNlIGEgR21haWwgdGFiIGF0IC91LzEvIGlzIGEKICAvLyBkaWZmZXJlbnQgbWFpbGJveCB3aXRoIGRpZmZlcmVudCBsYWJlbHMsIGFuZCBvbmUgcGVyc29uJ3MgY29sdW1uCiAgLy8gbGF5b3V0IG11c3Qgbm90IGxlYWsgaW50byBhbm90aGVyIGFjY291bnQncyBib2FyZC4KCiAgY29uc3QgS0VZUyA9IHsKICAgIGNsaWVudElkOiAnY2xpZW50SWQnLCAgICAgICAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgZG9ja1Bvc2l0aW9uOiAnZG9ja1Bvc2l0aW9uJywgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5zeW5jCiAgICBjb2x1bW5zOiBlbWFpbCA9PiBgY29sdW1uczoke1N0cmluZyhlbWFpbCkudG9Mb3dlckNhc2UoKX1gLCAvLyBzdG9yYWdlLnN5bmMKICAgIG9yZGVyOiBlbWFpbCA9PiBgb3JkZXI6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgICAgIC8vIHN0b3JhZ2UubG9jYWwKICAg",
"IC8vIENhcmQgZWRpdHMgZ2V0IG9uZSBrZXkgcGVyIGNhcmQgcmF0aGVyIHRoYW4gb25lIG1hcCBwZXIgYWNjb3VudDoKICAgIC8vIHN5bmMgY2FwcyBlYWNoIGl0ZW0gYXQgOCBLQiwgd2hpY2ggYSBzaW5nbGUgbWFwIHdvdWxkIG91dGdyb3cgYWZ0ZXIKICAgIC8vIGEgZmV3IGRvemVuIG5vdGVzLCB3aGlsZSB0aGUgNTEyLWl0ZW0gY2FwIGxlYXZlcyByb29tIGZvciBodW5kcmVkcy4KICAgIGNhcmRQcmVmaXg6IGVtYWlsID0-IGBjYXJkOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfTpgLCAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgY2FyZDogKGVtYWlsLCB0aHJlYWRJZCkgPT4gYGNhcmQ6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9OiR7dGhyZWFkSWR9YCwgLy8gc3RvcmFnZS5zeW5jCiAgICBub3RlczogZW1haWwgPT4gYG5vdGVzOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsICAgICAvLyBzdG9yYWdlLnN5bmM6IHsgbGFiZWwsIGxhYmVsSWQgfQogICAgdmlldzogJ3ZpZXcnLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5sb2NhbDogJ2JvYXJkJyB8ICdub3RlcycKICAgIHByZWY6IChlbWFpbCwgbmFtZSkgPT4gYHByZWY6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9OiR7bmFtZX1gLCAvLyBzdG9yYWdlLmxvY2FsOiB0aGUgbm90ZXMnIHNtYWxsIHByZWZlcmVuY2VzCiAgICB0b2tlbjogZW1haWwgPT4gYHRva2VuOiR7",
"U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsICAgICAvLyBzdG9yYWdlLnNlc3Npb24KICAgIGNhbGVuZGFyVG9rZW46IGVtYWlsID0-IGBjdG9rZW46JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgLy8gc3RvcmFnZS5zZXNzaW9uOiB0aGUgY2FsZW5kYXIncyBvd24gc2lnbi1pbgogICAgZ21haWxUYWJzOiAnZ21haWxUYWJzJywgICAgICAgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5zZXNzaW9uCiAgfTsKCiAgLy8gRWxlbWVudCBpZHMgZm9yIHRoZSB0d28gc2hhZG93IGhvc3RzLiBTaG9ydCBhbmQgbmFtZXNwYWNlZCByYXRoZXIgdGhhbgogIC8vIGJyYW5kZWQsIHNvIHRoZXkgc3Vydml2ZSBhIHJlbmFtZSBhbmQgYXJlIHVubGlrZWx5IHRvIGNsYXNoIHdpdGggR21haWwuCiAgY29uc3QgSE9TVF9JRFMgPSB7CiAgICBib2FyZDogJ2drYi1ib2FyZC1ob3N0JywKICAgIGRvY2s6ICdna2ItZG9jay1ob3N0JywKICB9OwoKICAvLyBUaGUgcHVibGlzaGVyJ3Mgb3duIE9BdXRoIGNsaWVudCwgZm9yIHRoZSBidWlsZCB0aGF0IGdvZXMgdG8gdGhlCiAgLy8gQ2hyb21lIFdlYiBTdG9yZTogd2l0aCBpdCwgYSB1c2VyIGp1c3QgY2xpY2tzICJDb25uZWN0IEdtYWlsIiBhbmQgbmVlZHMKICAvLyBubyBHb29nbGUgQ2xvdWQgcHJvamVjdCBvZiB0aGVpciBvd24uIEVtcHR5IGhlcmUsIG9uIHB1cnBvc2U6CiAgLy8gdG9vbHMvcGFja2FnZS1leHRlbnNpb24ubWpzIHdyaXRlcyBpdCBpbnRvIHRoZSBzdG9y",
"ZSBidWlsZCBvbmx5LCBzbyBhCiAgLy8gY29weSBsb2FkZWQgZnJvbSB0aGlzIHJlcG9zaXRvcnkgKG9yIGEgZm9yaykgYnJpbmdzIGl0cyBvd24gY2xpZW50LAogIC8vIGFzIFNFVFVQLm1kIGRlc2NyaWJlcywgcmF0aGVyIHRoYW4gdXNpbmcgdXAgdGhlIHB1Ymxpc2hlcidzIHF1b3RhIG9mCiAgLy8gdXNlcnMuIEEgY2xpZW50IElEIHNhdmVkIG9uIHRoZSBzZXR1cCBwYWdlIGFsd2F5cyB3aW5zLgogIGNvbnN0IEJVSUxUX0lOX0NMSUVOVF9JRCA9ICcnOwoKICBucy5BUFBfTkFNRSA9IEFQUF9OQU1FOwogIG5zLkJVSUxUX0lOX0NMSUVOVF9JRCA9IEJVSUxUX0lOX0NMSUVOVF9JRDsKICBucy5LRVlTID0gS0VZUzsKICBucy5IT1NUX0lEUyA9IEhPU1RfSURTOwoKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIHsKICAgIG1vZHVsZS5leHBvcnRzID0geyBBUFBfTkFNRSwgS0VZUywgSE9TVF9JRFMgfTsKICB9Cn0pKCk7Cg\"],[\"src/lib/util.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNtYWxsIHB1cmUgaGVscGVycwovLwovLyB",
"Ob3RoaW5nIGluIGhlcmUgdG91Y2hlcyB0aGUgRE9NLCBjaHJvbWUuKiBvciB0aGUgbmV0d29yaywgd2hpY2ggaXMgd2hhdAovLyBsZXRzIHRoZSBOb2RlIHRlc3RzIHJlcXVpcmUgdGhpcyBmaWxlIGRpcmVjdGx5LiBUaGUgY29udGVudCBzY3JpcHRzIGFuZAovLyB0aGUgc2VydmljZSB3b3JrZXIgcmVhY2ggdGhlIHNhbWUgZnVuY3Rpb25zIHRocm91Z2ggdGhlIHNoYXJlZAovLyBuYW1lc3BhY2UgKG5zLnV0aWwpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8g4pSA4pSAIEhlYWRlciBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBoZWFkZXJNYXAobWVzc2FnZSkgewo",
"gICAgY29uc3Qgb3V0ID0ge307CiAgICBjb25zdCBoZWFkZXJzID0gKG1lc3NhZ2UgJiYgbWVzc2FnZS5wYXlsb2FkICYmIG1lc3NhZ2UucGF5bG9hZC5oZWFkZXJzKSB8fCBbXTsKICAgIGZvciAoY29uc3QgaCBvZiBoZWFkZXJzKSBvdXRbaC5uYW1lLnRvTG93ZXJDYXNlKCldID0gaC52YWx1ZSB8fCAnJzsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyAiQW5uYSBWb3MgPGFubmFAZXhhbXBsZS5jb20-IiDihpIgeyBuYW1lLCBlbWFpbCB9CiAgZnVuY3Rpb24gcGFyc2VBZGRyZXNzKHJhdykgewogICAgaWYgKCFyYXcpIHJldHVybiB7IG5hbWU6ICcnLCBlbWFpbDogJycgfTsKICAgIGNvbnN0IGFuZ2xlZCA9IHJhdy5tYXRjaCgvXlxzKiguKj8pXHMqPChbXj5dKyk-XHMqJC8pOwogICAgaWYgKGFuZ2xlZCkgewogICAgICByZXR1cm4gewogICAgICAgIG5hbWU6IGFuZ2xlZFsxXS5yZXBsYWNlKC9eWyInXXxbIiddJC9nLCAnJykudHJpbSgpLAogICAgICAgIGVtYWlsOiBhbmdsZWRbMl0udHJpbSgpLnRvTG93ZXJDYXNlKCksCiAgICAgIH07CiAgICB9CiAgICByZXR1cm4geyBuYW1lOiAnJywgZW1haWw6IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKSB9OwogIH0KCiAgLy8gV2hhdCB0byBjYWxsIGEgc2VuZGVyIG9uIGEgY2FyZC4gQSBiYXJlIGFkZHJlc3MgaXMgc2hvcnRlbmVkIHRvIGl0cwogIC8vIGxvY2FsIHBhcnQsIGJlY2F1c2UgImFjY291bnRzIiByZWFkcyBiZXR0ZXIgaW4gYSBuYXJyb3cgY29sdW1uIHRoYW4",
"KICAvLyAiYWNjb3VudHNAYnJpZ2h0d2F0ZXItbGFuZ3VhZ2UuZXhhbXBsZSIuCiAgZnVuY3Rpb24gZGlzcGxheU5hbWUoYWRkcikgewogICAgaWYgKCFhZGRyKSByZXR1cm4gJyc7CiAgICBpZiAoYWRkci5uYW1lKSByZXR1cm4gYWRkci5uYW1lOwogICAgcmV0dXJuIChhZGRyLmVtYWlsIHx8ICcnKS5zcGxpdCgnQCcpWzBdOwogIH0KCiAgLy8g4pSA4pSAIEVudGl0aWVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gR21haWwgcmV0dXJucyBzbmlwcGV0cyBIVE1MLWVuY29kZWQuIFRoZSBvYnZpb3VzIGRlY29kZXIgLSBhc3NpZ24gdG8gYQogIC8vIGRldGFjaGVkIGVsZW1lbnQncyBpbm5lckhUTUwgYW5kIHJlYWQgdGV4dENvbnRlbnQgYmFjayAtIGlzIHdoYXQKICAvLyBHbWFpbCdzIFRydXN0ZWQgVHlwZXMgcG9saWN5IGZvcmJpZHMsIGFuZCBpdCB3b3VsZCBhbHNvIG1lYW4gZmVlZGluZwogIC8vIHVudHJ1c3RlZCBtYWlsIHRleHQgdG8gdGhlIEhUTUwgcGFyc2VyLiBBIGxvb2t1cCB0YWJsZSBkb2VzIHRoZSBqb2IuCgogIC8vIFRoZSBoYW5kZnVsIGV2ZXJ5IG1haWwgbmVlZHMsIHBsdXMgdGhlIHR5cG9ncmFwaGljIG9uZXMgdGhhdCB",
"IVE1MCiAgLy8gbWFpbCB3cml0dGVuIGluIEdtYWlsIG9yIE91dGxvb2sgaXMgZnVsbCBvZi4KICBjb25zdCBOQU1FRCA9IHsKICAgIGFtcDogJyYnLCBsdDogJzwnLCBndDogJz4nLCBxdW90OiAnIicsIGFwb3M6ICInIiwgbmJzcDogJ1x1MDBhMCcsCiAgICBsc3F1bzogJ1x1MjAxOCcsIHJzcXVvOiAnXHUyMDE5JywgbGRxdW86ICdcdTIwMWMnLCByZHF1bzogJ1x1MjAxZCcsCiAgICBuZGFzaDogJ1x1MjAxMycsIG1kYXNoOiAnXHUyMDE0JywgaGVsbGlwOiAnXHUyMDI2JywgYnVsbDogJ1x1MjAyMicsIG1pZGRvdDogJ1x1MDBiNycsCiAgICBsYXF1bzogJ1x1MDBhYicsIHJhcXVvOiAnXHUwMGJiJywgZXVybzogJ1x1MjBhYycsIHBvdW5kOiAnXHUwMGEzJywgY29weTogJ1x1MDBhOScsIHJlZzogJ1x1MDBhZScsIHRyYWRlOiAnXHUyMTIyJywKICB9OwoKICBmdW5jdGlvbiBkZWNvZGVFbnRpdGllcyhpbnB1dCkgewogICAgLy8gU2luZ2xlIHBhc3MsIHNvICImYW1wO2x0OyIgYmVjb21lcyB0aGUgbGl0ZXJhbCB0ZXh0ICImbHQ7IiBhbmQgaXMKICAgIC8vIG5vdCBkZWNvZGVkIGEgc2Vjb25kIHRpbWUgaW50byAiPCIuCiAgICByZXR1cm4gU3RyaW5nKGlucHV0ID09IG51bGwgPyAnJyA6IGlucHV0KS5yZXBsYWNlKAogICAgICAvJigjW3hYXVswLTlhLWZBLUZdezEsNn18I1swLTldezEsN318W2EtekEtWl0rKTsvZywKICAgICAgKHdob2xlLCBib2R5KSA9PiB7CiAgICAgICAgaWYgKGJvZHlbMF0gPT09ICcjJykgewo",
"gICAgICAgICAgY29uc3QgaGV4ID0gYm9keVsxXSA9PT0gJ3gnIHx8IGJvZHlbMV0gPT09ICdYJzsKICAgICAgICAgIGNvbnN0IGNvZGUgPSBwYXJzZUludChib2R5LnNsaWNlKGhleCA_IDIgOiAxKSwgaGV4ID8gMTYgOiAxMCk7CiAgICAgICAgICAvLyBPdXQtb2YtcmFuZ2UgYW5kIHN1cnJvZ2F0ZSBjb2RlIHBvaW50cyB3b3VsZCB0aHJvdyBvciBwcm9kdWNlCiAgICAgICAgICAvLyBnYXJiYWdlOyBsZWF2ZSB0aGUgb3JpZ2luYWwgdGV4dCBhbG9uZSBpbnN0ZWFkLgogICAgICAgICAgaWYgKCFpc0Zpbml0ZShjb2RlKSB8fCBjb2RlIDwgMSB8fCBjb2RlID4gMHgxMGZmZmYgfHwKICAgICAgICAgICAgICAoY29kZSA-PSAweGQ4MDAgJiYgY29kZSA8PSAweGRmZmYpKSByZXR1cm4gd2hvbGU7CiAgICAgICAgICByZXR1cm4gU3RyaW5nLmZyb21Db2RlUG9pbnQoY29kZSk7CiAgICAgICAgfQogICAgICAgIGNvbnN0IG5hbWVkID0gTkFNRURbYm9keS50b0xvd2VyQ2FzZSgpXTsKICAgICAgICByZXR1cm4gbmFtZWQgPT09IHVuZGVmaW5lZCA_IHdob2xlIDogbmFtZWQ7CiAgICAgIH0KICAgICk7CiAgfQoKICAvLyDilIDilIAgQWNjb3VudCBkZXRlY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGN",
"vbnN0IEVNQUlMX09OTFlfUkUgPSAvXlteXHNAPD4oKSJdK0BbXlxzQDw-KCkiXStcLlteXHNAPD4oKSJdKyQvOwogIGNvbnN0IEVNQUlMX0FOWV9SRSA9IC9bXlxzQDw-KCkiXStAW15cc0A8PigpIl0rXC5bXlxzQDw-KCkiXSsvOwoKICAvLyBHbWFpbCdzIHRpdGxlIGlzICI8dmlldyBvciBzdWJqZWN0PiAtIDxhY2NvdW50PiAtIDxwcm9kdWN0PiIsIGUuZy4KICAvLyAiSW5ib3ggKDMsNTkxKSAtIHNvbWVvbmVAZXhhbXBsZS5jb20gLSBHbWFpbCIuIFdvcmtzcGFjZSBhY2NvdW50cyBjYW4KICAvLyByZXBsYWNlICJHbWFpbCIgd2l0aCB0aGUgb3JnYW5pc2F0aW9uJ3Mgb3duIG5hbWUsIHNvIHRoZSBwcm9kdWN0IHBhcnQKICAvLyBpcyBub3QgbWF0Y2hlZC4gU2Nhbm5pbmcgZnJvbSB0aGUgcmlnaHQgZmluZHMgdGhlIGFjY291bnQgZXZlbiB3aGVuIGEKICAvLyBzdWJqZWN0IGxpbmUgY29udGFpbnMgYW4gYWRkcmVzcyBvciBhIGRhc2ggb2YgaXRzIG93bi4KICBmdW5jdGlvbiBhY2NvdW50RnJvbVRpdGxlKHRpdGxlKSB7CiAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyh0aXRsZSB8fCAnJykuc3BsaXQoL1xzWy3igJPigJRdXHMvKTsKICAgIGZvciAobGV0IGkgPSBwYXJ0cy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkgewogICAgICBjb25zdCBwID0gcGFydHNbaV0udHJpbSgpOwogICAgICBpZiAoRU1BSUxfT05MWV9SRS50ZXN0KHApKSByZXR1cm4gcC50b0xvd2VyQ2FzZSgpOwogICAgfQogICAgcmV0dXJuICcnOwo",
"gIH0KCiAgLy8gIkdvb2dsZSBBY2NvdW50OiBBbm5hIFZvcyAgKGFubmFAZXhhbXBsZS5jb20pIiDihpIgImFubmFAZXhhbXBsZS5jb20iCiAgZnVuY3Rpb24gYWNjb3VudEZyb21BcmlhTGFiZWwobGFiZWwpIHsKICAgIGNvbnN0IG0gPSBTdHJpbmcobGFiZWwgfHwgJycpLm1hdGNoKEVNQUlMX0FOWV9SRSk7CiAgICByZXR1cm4gbSA_IG1bMF0ucmVwbGFjZSgvWykuLDtdKyQvLCAnJykudG9Mb3dlckNhc2UoKSA6ICcnOwogIH0KCiAgLy8gIi9tYWlsL3UvMS8iIOKGkiAxLiBEZWZhdWx0cyB0byAwLCB3aGljaCBpcyB3aGF0IC9tYWlsLyBhbG9uZSBtZWFucy4KICBmdW5jdGlvbiBhY2NvdW50SW5kZXhGcm9tUGF0aChwYXRobmFtZSkgewogICAgY29uc3QgbSA9IFN0cmluZyhwYXRobmFtZSB8fCAnJykubWF0Y2goL1wvbWFpbFwvdVwvKFxkKylcLy8pOwogICAgcmV0dXJuIG0gPyBOdW1iZXIobVsxXSkgOiAwOwogIH0KCiAgLy8g4pSA4pSAIERhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTW9udGggYW5kIGRheSBuYW1lcyBhcmUgc3BlbGxlZCBvdXQgaGVyZSByYXRoZXIgdGhhbiB0YWtlbiBmcm9tCiAgLy8gSW50bCw",
"gc28gYSBjYXJkIHJlYWRzIHRoZSBzYW1lIHdoYXRldmVyIHRoZSBicm93c2VyIGxvY2FsZSBpcyBhbmQKICAvLyB0aGUgdGVzdHMgZG8gbm90IGRlcGVuZCBvbiB0aGUgbWFjaGluZSB0aGV5IHJ1biBvbi4KCiAgY29uc3QgTU9OVEhTID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsCiAgICAgICAgICAgICAgICAgICdKdWwnLCAnQXVnJywgJ1NlcCcsICdPY3QnLCAnTm92JywgJ0RlYyddOwogIGNvbnN0IERBWVMgPSBbJ1N1bicsICdNb24nLCAnVHVlJywgJ1dlZCcsICdUaHUnLCAnRnJpJywgJ1NhdCddOwoKICBmdW5jdGlvbiBzdGFydE9mRGF5KG1zKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUobXMpOwogICAgcmV0dXJuIG5ldyBEYXRlKGQuZ2V0RnVsbFllYXIoKSwgZC5nZXRNb250aCgpLCBkLmdldERhdGUoKSkuZ2V0VGltZSgpOwogIH0KCiAgLy8gQ29tcGFjdCBhZ2UgZm9yIGEgY2FyZDogImp1c3Qgbm93IiwgIjEyIG1pbiIsICIzIGgiLCAiWWVzdGVyZGF5IiwKICAvLyAiTW9uIiwgIjMgU2VwIiwgIjMgU2VwIDIwMjQiLiBIb3VycyB3aW4gb3ZlciAiWWVzdGVyZGF5IiBmb3IgYW55dGhpbmcKICAvLyB1bmRlciBhIGRheSBvbGQsIGJlY2F1c2UgIjIgaCIgaXMgbW9yZSB1c2VmdWwgYXQgMWFtIHRoYW4gIlllc3RlcmRheSIuCiAgZnVuY3Rpb24gcmVsYXRpdmVEYXRlKHRzLCBub3cgPSBEYXRlLm5vdygpKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB",
"8fCAhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBub3cgLSB0KTsKICAgIGNvbnN0IG1pbiA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgIGlmIChtaW4gPCAxKSByZXR1cm4gJ2p1c3Qgbm93JzsKICAgIGlmIChtaW4gPCA2MCkgcmV0dXJuIGAke21pbn0gbWluYDsKICAgIGNvbnN0IGhvdXJzID0gTWF0aC5mbG9vcihtaW4gLyA2MCk7CiAgICBpZiAoaG91cnMgPCAyNCkgcmV0dXJuIGAke2hvdXJzfSBoYDsKCiAgICAvLyBDYWxlbmRhciBkYXlzLCBub3QgMjQtaG91ciBibG9ja3MsIHNvICJZZXN0ZXJkYXkiIG1lYW5zIHllc3RlcmRheS4KICAgIGNvbnN0IGRheXMgPSBNYXRoLnJvdW5kKChzdGFydE9mRGF5KG5vdykgLSBzdGFydE9mRGF5KHQpKSAvIDg2NDAwMDAwKTsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGlmIChkYXlzIDw9IDEpIHJldHVybiAnWWVzdGVyZGF5JzsKICAgIGlmIChkYXlzIDwgNykgcmV0dXJuIERBWVNbZC5nZXREYXkoKV07CiAgICBjb25zdCBkbSA9IGAke2QuZ2V0RGF0ZSgpfSAke01PTlRIU1tkLmdldE1vbnRoKCldfWA7CiAgICByZXR1cm4gZC5nZXRGdWxsWWVhcigpID09PSBuZXcgRGF0ZShub3cpLmdldEZ1bGxZZWFyKCkgPyBkbSA6IGAke2RtfSAke2QuZ2V0RnVsbFllYXIoKX1gOwogIH0KCiAgLy8gRnVsbCBkYXRlIGZvciBhIHRvb2x0aXA6ICJUdWUgMyBTZXAgMjAyNiwgMTQ6MDUiLgogIGZ1bmN0aW9uIGZ1bGx",
"EYXRlKHRzKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fCAhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGNvbnN0IHBhZCA9IG4gPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgICByZXR1cm4gYCR7REFZU1tkLmdldERheSgpXX0gJHtkLmdldERhdGUoKX0gJHtNT05USFNbZC5nZXRNb250aCgpXX0gJHtkLmdldEZ1bGxZZWFyKCl9LCBgICsKICAgICAgICAgICBgJHtwYWQoZC5nZXRIb3VycygpKX06JHtwYWQoZC5nZXRNaW51dGVzKCkpfWA7CiAgfQoKICAvLyBGb3IgInVwZGF0ZWQgWHMgYWdvIiBpbiB0aGUgYm9hcmQgaGVhZGVyLgogIGZ1bmN0aW9uIGFnb1RleHQobXMpIHsKICAgIGNvbnN0IHMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKE51bWJlcihtcykgLyAxMDAwKSk7CiAgICBpZiAocyA8IDUpIHJldHVybiAnanVzdCBub3cnOwogICAgaWYgKHMgPCA2MCkgcmV0dXJuIGAke3N9cyBhZ29gOwogICAgY29uc3QgbSA9IE1hdGguZmxvb3IocyAvIDYwKTsKICAgIGlmIChtIDwgNjApIHJldHVybiBgJHttfSBtaW4gYWdvYDsKICAgIHJldHVybiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9IGggYWdvYDsKICB9CgogIC8vIOKUgOKUgCBDb25jdXJyZW5jeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUnVucyBmbiBvdmVyIGl0ZW1zIHdpdGggYXQgbW9zdCBgbGltaXRgIGluIGZsaWdodC4gR21haWwncyBwZXItdXNlcgogIC8vIHF1b3RhIGlzIGdlbmVyb3VzLCBidXQgYSBib2FyZCBvZiAxMDAgY2hhbmdlZCB0aHJlYWRzIGZpcmVkIGF0IG9uY2UKICAvLyBzdGlsbCB0cmlwcyBpdHMgYnVyc3QgbGltaXRlcjsgc2l4IGF0IGEgdGltZSBrZWVwcyBhIGNvbGQgbG9hZCBxdWljawogIC8vIHdpdGhvdXQgcHJvdm9raW5nIDQyOXMuIFRoZSBmaXJzdCByZWplY3Rpb24gc3RvcHMgbmV3IHdvcmsgc3RhcnRpbmcKICAvLyBhbmQgaXMgcmUtdGhyb3duLCBzbyBhbiBhdXRoIGZhaWx1cmUgZG9lcyBub3QgZmFuIG91dCBpbnRvIDEwMCBtb3JlLgogIGFzeW5jIGZ1bmN0aW9uIG1hcFBvb2woaXRlbXMsIGxpbWl0LCBmbikgewogICAgY29uc3QgcmVzdWx0cyA9IG5ldyBBcnJheShpdGVtcy5sZW5ndGgpOwogICAgbGV0IG5leHQgPSAwOwogICAgbGV0IGZhaWxlZCA9IG51bGw7CiAgICBhc3luYyBmdW5jdGlvbiB3b3JrZXIoKSB7CiAgICAgIHdoaWxlIChmYWlsZWQgPT09IG51bGwgJiYgbmV4dCA8IGl0ZW1zLmxlbmd0aCkgewogICAgICAgIGNvbnN0IGkgPSBuZXh0Kys7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHJlc3VsdHNbaV0gPSBhd2FpdCBmbihpdGVtc1tpXSwgaSk7CiAgICAgICAgfSBjYXR",
"jaCAoZXJyKSB7CiAgICAgICAgICBpZiAoZmFpbGVkID09PSBudWxsKSBmYWlsZWQgPSBlcnI7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBjb25zdCBuID0gTWF0aC5tYXgoMSwgTWF0aC5taW4obGltaXQsIGl0ZW1zLmxlbmd0aCkpOwogICAgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogbiB9LCB3b3JrZXIpKTsKICAgIGlmIChmYWlsZWQgIT09IG51bGwpIHRocm93IGZhaWxlZDsKICAgIHJldHVybiByZXN1bHRzOwogIH0KCiAgY29uc3QgYXBpID0gewogICAgaGVhZGVyTWFwLCBwYXJzZUFkZHJlc3MsIGRpc3BsYXlOYW1lLCBkZWNvZGVFbnRpdGllcywKICAgIGFjY291bnRGcm9tVGl0bGUsIGFjY291bnRGcm9tQXJpYUxhYmVsLCBhY2NvdW50SW5kZXhGcm9tUGF0aCwKICAgIHJlbGF0aXZlRGF0ZSwgZnVsbERhdGUsIGFnb1RleHQsIG1hcFBvb2wsCiAgfTsKCiAgbnMudXRpbCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/notes-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGVzIGxvZ2ljIChwdXJlKQovLwovLyBBIG5vdGUgaXMgYW4gZW1haWwgdGhhdCB3YXMgbmV2ZXIgc2VudDogYSBtZXNzYWdlIHBsYWNlZCBzdHJhaWdodCBpbnRvCi8vIHRoZSB1c2VyJ3Mgb3duIG1haWxib3ggd2l0aCBtZXNzYWdlcy5pbnNlcnQsIGNhcnJ5aW5nIHRoZSBOb3RlcyBsYWJlbAovLyBhbmQgbm90aGluZyBlbHNlIC0gbm90IElOQk9YLCBub3QgVU5SRUFEIC0gc28gaXQgc3RheXMgb3V0IG9mIHRoZSB3YXkKLy8gdW50aWwgbG9va2VkIGZvciwgYW5kIEdtYWlsJ3Mgb3duIHNlYXJjaCBmaW5kcyBpdC4KLy8KLy8gR21haWwgbWVzc2FnZXMgY2Fubm90IGJlIGNoYW5nZWQgb25jZSBzdG9yZWQsIHNvIHNhdmluZyBhIG5vdGUgaW5zZXJ0cwovLyBhIG5ldyBtZXNzYWdlIGFuZCBtb3ZlcyB0aGUgcHJldmlvdXMgb25lIHRvIFRyYXNoLiBFYWNoIG5vdGUgY2FycmllcyBhCi8vIHN0YWJsZSBpZCBpbiBhbiBYLUdrYi1Ob3RlIGhlYWRlciwgd2hpY2ggaXMgaG93IGl0cyB2ZXJzaW9ucyBhcmUgdGllZAovLyB0b2dldGhlciBhbmQgLSBqdXN0IGFzIGltcG9ydGFudCAtIGhvdyB0aGUgYmFja2dyb3VuZCB3b3JrZXIgdGVsbHMgYQovLyBub3RlIGZyb20gcmVhbCBtYWlsOiBpdCB3aWxsIG9ubHkgaW5zZXJ0IG1lc3NhZ2VzIHRoYXQgY2FycnkgdGhlIGhlYWRlcgovLyBhbmQgb25seSB0cmFzaCBtZXNzYWdlcyB0aGF0IGFscmVhZHkgZG8uCi8vCi",
"8vIExvYWRlZCBieSB0aGUgY29udGVudCBzY3JpcHRzLCB0aGUgc2VydmljZSB3b3JrZXIgYW5kIE5vZGUncyB0ZXN0cy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IE5PVEVfSEVBREVSID0gJ1gtR2tiLU5vdGUnOwogIGNvbnN0IERFRkFVTFRfTEFCRUwgPSAnX05vdGVzJzsKICAvLyAuaW52YWxpZCBpcyByZXNlcnZlZCBhbmQgY2FuIG5ldmVyIGJlIGRlbGl2ZXJlZCB0bywgc28gbm90aGluZyBjYW4KICAvLyBldmVyIGFycml2ZSBmcm9tIG9yIGdvIHRvIHRoaXMgYWRkcmVzcy4KICBjb25zdCBOT1RFX1NFTkRFUiA9ICciTm90ZXMiIDxub3Rlc0Bub3Rlcy5pbnZhbGlkPic7CgogIC8vIEdlbmVyb3VzIGZvciB0eXBlZCBub3RlcywgYW5kIGtlZXBzIG",
"9uZSBzYXZlIGNvbWZvcnRhYmx5IGluc2lkZSB3aGF0CiAgLy8gdGhlIG5vbi11cGxvYWQgaW5zZXJ0IGVuZHBvaW50IGFuZCBhIHJ1bnRpbWUgbWVzc2FnZSB3aWxsIGNhcnJ5LgogIGNvbnN0IE1BWF9CT0RZID0gMTAwMDAwOwogIGNvbnN0IE1BWF9USVRMRSA9IDMwMDsKCiAgLy8gTGFiZWxzIGEgbm90ZSBtYXkgbmV2ZXIgYmUgaW5zZXJ0ZWQgd2l0aC4gQSBub3RlIGluIHRoZSBJbmJveCwgb3IKICAvLyBkcmVzc2VkIHVwIGFzIHNlbnQgb3IgZHJhZnQgbWFpbCwgaXMgbm8gbG9uZ2VyIG91dCBvZiB0aGUgd2F5IC0gYW5kCiAgLy8gbm90aGluZyBoZXJlIHNob3VsZCBldmVyIGJlIGFibGUgdG8gcHV0IG1haWwgaW50byBTcGFtIG9yIFRyYXNoLgogIGNvbnN0IEZPUkJJRERFTl9JTlNFUlRfTEFCRUxTID0gbmV3IFNldChbJ0lOQk9YJywgJ1NFTlQnLCAnRFJBRlQnLCAnU1BBTScsICdUUkFTSCcsICdVTlJFQUQnXSk7CgogIC8vIOKUgOKUgCBJZHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IElEX1JFID0gL15bYS16MC05XXsxMiw0MH0kLzsKCiAgZnVuY3Rpb24gbmV3Tm90ZUlkKHJhbmQgPSBuID0-IGNyeXB0by",
"5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKSB7CiAgICByZXR1cm4gQXJyYXkuZnJvbShyYW5kKDEyKSwgYiA9PiBiLnRvU3RyaW5nKDM2KS5wYWRTdGFydCgyLCAnMCcpLnNsaWNlKC0yKSkuam9pbignJykuc2xpY2UoMCwgMjApOwogIH0KCiAgLy8gVGhlIHNjcmF0Y2hwYWQ6IG9uZSBub3RlIHdpdGggYSBmaXhlZCBpZCwgc28gdGhhdCBldmVyeSBjb21wdXRlciBhbmQKICAvLyBwaG9uZSBmaW5kcyAtIGFuZCBzYXZlcyBpbnRvIC0gdGhlIHNhbWUgb25lLgogIGNvbnN0IFNDUkFUQ0hQQURfSUQgPSAnc2NyYXRjaHBhZDAwMDAwMCc7CiAgY29uc3QgU0NSQVRDSFBBRF9USVRMRSA9ICdTY3JhdGNocGFkJzsKCiAgLy8gVGhlIGlkIGEgc2F2ZSB3cml0ZXMgdW5kZXI6IHRoZSBub3RlJ3Mgb3duLCBvbmNlIGl0IGhhcyBvbmU7IGZvciBhCiAgLy8gZmlyc3Qgc2F2ZSwgdGhlIHNjcmF0Y2hwYWQncyBpZiB0aGF0IGlzIHdoYXQgaXMgYmVpbmcgc2F2ZWQsIGFuZAogIC8vIG90aGVyd2lzZSBhIG5ldyBvbmUuIE5vIG90aGVyIGlkIGNhbiBiZSBhc2tlZCBmb3IuCiAgZnVuY3Rpb24gbm90ZUlkRm9yKHByZXZpb3VzLCB3YW50ZWQpIHsKICAgIGlmIChwcmV2aW91cyAmJiBwcmV2aW91cy5vd24gJiYgSURfUkUudGVzdChTdHJpbmcocHJldmlvdXMubm90ZUlkIHx8ICcnKSkpIHJldHVybiBwcmV2aW91cy5ub3RlSWQ7CiAgICByZXR1cm4gd2FudGVkID09PSBTQ1JBVENIUEFEX0lEID8gU0NSQVRDSFBBRF9JRC",
"A6IG5ld05vdGVJZCgpOwogIH0KCiAgLy8g4pSA4pSAIEVuY29kaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBieXRlc1RvQmluYXJ5KGJ5dGVzKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIHsKICAgICAgb3V0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCwgYnl0ZXMuc3ViYXJyYXkoaSwgaSArIDB4ODAwMCkpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJpbmFyeVRvQnl0ZXMoYmluKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmluLmxlbmd0aDsgaSsrKSBvdXRbaV0gPSBiaW4uY2hhckNvZGVBdChpKSAmIDB4ZmY7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgdXRmOFRvQmFzZTY0ID0gcyA9PiBidG9hKGJ5dGVzVG9CaW5hcnkobmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHMpKSk7CgogIGZ1bmN0aW9uIGJhc2U2NFVybEVuY29kZShiaW5hcnkpIHsKICAgIHJldHVybiBidG9hKGJpbmFyeSkucmVwbGFjZSgvXCsvZy",
"wgJy0nKS5yZXBsYWNlKC9cLy9nLCAnXycpLnJlcGxhY2UoLz0rJC8sICcnKTsKICB9CgogIGZ1bmN0aW9uIGJhc2U2NFVybERlY29kZShzKSB7CiAgICBjb25zdCBiNjQgPSBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvLS9nLCAnKycpLnJlcGxhY2UoL18vZywgJy8nKS5yZXBsYWNlKC9ccysvZywgJycpOwogICAgcmV0dXJuIGF0b2IoYjY0ICsgJz0nLnJlcGVhdCgoNCAtIChiNjQubGVuZ3RoICUgNCkpICUgNCkpOwogIH0KCiAgLy8gVGV4dCBpbiB3aGF0ZXZlciBjaGFyc2V0IHRoZSBwYXJ0IGRlY2xhcmVkLiBBbiB1bmtub3duIG9yIG1pc2xhYmVsbGVkCiAgLy8gY2hhcnNldCBmYWxscyBiYWNrIHRvIFVURi04IHJhdGhlciB0aGFuIGZhaWxpbmcgdGhlIHdob2xlIG5vdGUuCiAgZnVuY3Rpb24gZGVjb2RlQnl0ZXMoYnl0ZXMsIGNoYXJzZXQpIHsKICAgIHRyeSB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoY2hhcnNldCB8fCAndXRmLTgnKS5kZWNvZGUoYnl0ZXMpOwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoJ3V0Zi04JykuZGVjb2RlKGJ5dGVzKTsKICAgIH0KICB9CgogIC8vIFJGQyAyMDQ3IGVuY29kZWQgd29yZHMsIGZvciBhIHN1YmplY3QgdGhhdCBpcyBub3QgcGxhaW4gQVNDSUkuIEF0IDM5CiAgLy8gYnl0ZXMgYSB3b3JkLCBldmVuIHRoZSBmaXJzdCBsaW5lICgiU3ViamVjdDogIiBhbmQgb25lIHdvcmQpIHN0YXlzCiAgLy8gdW5kZXIgNzggY2hhcmFjdGVycy",
"wgYW5kIG5vIGNoYXJhY3RlciBpcyBzcGxpdCBhY3Jvc3MgdHdvIHdvcmRzLAogIC8vIHdoaWNoIHNvbWUgcmVhZGVycyB3b3VsZCBzaG93IGFzIHR3byBicm9rZW4gaGFsdmVzLgogIGZ1bmN0aW9uIGVuY29kZUhlYWRlclRleHQodGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICgvXltceDIwLVx4N2VdKiQvLnRlc3QocykpIHJldHVybiBzOwogICAgY29uc3Qgd29yZHMgPSBbXTsKICAgIGxldCBjaHVuayA9ICcnOwogICAgbGV0IGJ5dGVzID0gMDsKICAgIGZvciAoY29uc3QgY2ggb2YgcykgewogICAgICBjb25zdCBuID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGNoKS5sZW5ndGg7CiAgICAgIGlmIChieXRlcyArIG4gPiAzOSAmJiBjaHVuaykgewogICAgICAgIHdvcmRzLnB1c2goY2h1bmspOwogICAgICAgIGNodW5rID0gJyc7CiAgICAgICAgYnl0ZXMgPSAwOwogICAgICB9CiAgICAgIGNodW5rICs9IGNoOwogICAgICBieXRlcyArPSBuOwogICAgfQogICAgaWYgKGNodW5rKSB3b3Jkcy5wdXNoKGNodW5rKTsKICAgIHJldHVybiB3b3Jkcy5tYXAodyA9PiBgPT9VVEYtOD9CPyR7dXRmOFRvQmFzZTY0KHcpfT89YCkuam9pbignXHJcbiAnKTsKICB9CgogIC8vIFRoZSBpbnZlcnNlLCBmb3IgdGhlIHByZXZpZXcncyBmYWtlIEdtYWlsIGFuZCBmb3IgdGhlIHRlc3RzLiAoVGhlIHJlYWwKICAvLyBBUEkgaGFuZHMgaGVhZGVycyBiYWNrIGFscmVhZHkgZGVjb2RlZC4pCiAgZn",
"VuY3Rpb24gZGVjb2RlSGVhZGVyVGV4dCh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCAnJykKICAgICAgLnJlcGxhY2UoLyg9XD9bXj9dK1w_W0JiUXFdXD9bXj9dKlw_PSlccysoPz09XD8pL2csICckMScpCiAgICAgIC5yZXBsYWNlKC89XD8oW14_XSspXD8oW0JiUXFdKVw_KFteP10qKVw_PS9nLCAoXywgY2hhcnNldCwgZW5jLCB0ZXh0KSA9PiB7CiAgICAgICAgY29uc3QgYmluID0gZW5jLnRvVXBwZXJDYXNlKCkgPT09ICdCJwogICAgICAgICAgPyBhdG9iKHRleHQpCiAgICAgICAgICA6IHRleHQucmVwbGFjZSgvXy9nLCAnICcpLnJlcGxhY2UoLz0oWzAtOUEtRmEtZl17Mn0pL2csIChtLCBoZXgpID0-IFN0cmluZy5mcm9tQ2hhckNvZGUocGFyc2VJbnQoaGV4LCAxNikpKTsKICAgICAgICByZXR1cm4gZGVjb2RlQnl0ZXMoYmluYXJ5VG9CeXRlcyhiaW4pLCBjaGFyc2V0KTsKICAgICAgfSk7CiAgfQoKICAvLyBIZWFkZXIgdmFsdWVzIG5ldmVyIGNhcnJ5IGxpbmUgYnJlYWtzIG9mIHRoZWlyIG93bjogb25lIGluIGEgdGl0bGUKICAvLyB3b3VsZCBlbmQgdGhlIGhlYWRlciBlYXJseSBhbmQgc3RhcnQgYW5vdGhlciBvZiB0aGUgdXNlcidzIGNob29zaW5nLgogIGNvbnN0IG9uZUxpbmUgPSBzID0-IFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9bXHJcblx0XSsvZywgJyAnKS5yZXBsYWNlKC9cc3syLH0vZywgJyAnKS50cmltKCk7CgogIC8vIOKUgOKUgCBCdWlsZGluZyBhIG5vdGUg4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIEEgbm90ZSB3aXRoIG5vIHRpdGxlIGlzIGZpbGVkIHVuZGVyIGl0cyBmaXJzdCBsaW5lLCBhcyBtb3N0IG5vdGVzCiAgLy8gYXBwcyBkbywgc28gaXQgc3RpbGwgcmVhZHMgYXMgc29tZXRoaW5nIGluIEdtYWlsJ3MgbWVzc2FnZSBsaXN0LgogIGZ1bmN0aW9uIHRpdGxlRm9yKHRpdGxlLCBib2R5KSB7CiAgICBjb25zdCB0ID0gb25lTGluZSh0aXRsZSkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGlmICh0KSByZXR1cm4gdDsKICAgIGNvbnN0IGZpcnN0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnNwbGl0KCdcbicpLm1hcChsID0-IGwudHJpbSgpKS5maW5kKEJvb2xlYW4pIHx8ICcnOwogICAgcmV0dXJuIG9uZUxpbmUoZmlyc3QpLnNsaWNlKDAsIDgwKTsKICB9CgogIGZ1bmN0aW9uIHdyYXA3NihzKSB7CiAgICByZXR1cm4gcy5yZXBsYWNlKC8uezEsNzZ9L2csICckJlxyXG4nKS50cmltRW5kKCk7CiAgfQoKICBjb25zdCB0ZXh0UGFydCA9ICh0eXBlLCBzKSA9PiBbCiAgICBgQ29udGVudC1UeXBlOiAke3R5cGV9OyBjaGFyc2V0PVVURi04YCwKICAgICdDb250ZW50LVRyYW5zZmVyLUVuY29kaW5nOiBiYXNlNjQnLAogICAgJycsCiAgICB3cmFwNzYodXRmOF",
"RvQmFzZTY0KHMucmVwbGFjZSgvXG4vZywgJ1xyXG4nKSkpLAogIF07CgogIC8vIGBib2R5YCBpcyB0aGUgcGxhaW4gdGV4dC4gV2l0aCBgaHRtbGAgYXMgd2VsbCwgdGhlIG5vdGUgaXMgYQogIC8vIG11bHRpcGFydC9hbHRlcm5hdGl2ZSBtZXNzYWdlOiBHbWFpbCBzaG93cyB0aGUgSFRNTCwgYW5kIGl0cyBwcmV2aWV3cwogIC8vIGFuZCBwbGFpbi10ZXh0IHJlYWRlcnMgZ2V0IHRoZSB0ZXh0LgogIGZ1bmN0aW9uIGJ1aWxkTm90ZVJhdyh7IG5vdGVJZCwgdGl0bGUsIGJvZHksIGh0bWwsIGFjY291bnQsIGRhdGUgPSBuZXcgRGF0ZSgpIH0pIHsKICAgIGlmICghSURfUkUudGVzdChTdHJpbmcobm90ZUlkIHx8ICcnKSkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBub3RlIGlkJyk7CiAgICBjb25zdCBtZSA9IG9uZUxpbmUoYWNjb3VudCk7CiAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNsaWNlKDAsIE1BWF9CT0RZKTsKICAgIGNvbnN0IGhlYWQgPSBbCiAgICAgIC8vIE5vdCBmcm9tIHRoZSBhY2NvdW50J3Mgb3duIGFkZHJlc3M6IEdtYWlsIGZpbGVzIGFueXRoaW5nIGZyb20geW91CiAgICAgIC8vIHVuZGVyIFNlbnQsIHdoYXRldmVyIGxhYmVscyBpdCB3YXMgZ2l2ZW4uIFJlcGxpZXMgc3RpbGwgcmVhY2ggeW91LgogICAgICBgRnJvbTogJHtOT1RFX1NFTkRFUn1gLAogICAgICBgVG86ICR7bWV9YCwKICAgICAgYFJlcGx5LVRvOiAke21lfWAsCiAgIC",
"AgIGBTdWJqZWN0OiAke2VuY29kZUhlYWRlclRleHQodGl0bGVGb3IodGl0bGUsIHRleHQpIHx8ICdVbnRpdGxlZCBub3RlJyl9YCwKICAgICAgYERhdGU6ICR7ZGF0ZS50b1VUQ1N0cmluZygpfWAsCiAgICAgIGBNZXNzYWdlLUlEOiA8JHtub3RlSWR9LiR7ZGF0ZS5nZXRUaW1lKCl9QG5vdGVzLmludmFsaWQ-YCwKICAgICAgYCR7Tk9URV9IRUFERVJ9OiAke25vdGVJZH1gLAogICAgICAnTUlNRS1WZXJzaW9uOiAxLjAnLAogICAgXTsKICAgIGxldCBsaW5lczsKICAgIGlmIChodG1sKSB7CiAgICAgIC8vIEJhc2U2NCBuZXZlciBjb250YWlucyAiLSIsIHNvIHRoaXMgYm91bmRhcnkgY2Fubm90IG9jY3VyIGluIGEgcGFydC4KICAgICAgY29uc3QgYm91bmRhcnkgPSBgZ2tiLSR7bm90ZUlkfS0ke2RhdGUuZ2V0VGltZSgpfWA7CiAgICAgIGxpbmVzID0gWwogICAgICAgIC4uLmhlYWQsCiAgICAgICAgYENvbnRlbnQtVHlwZTogbXVsdGlwYXJ0L2FsdGVybmF0aXZlOyBib3VuZGFyeT0iJHtib3VuZGFyeX0iYCwKICAgICAgICAnJywKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvcGxhaW4nLCB0ZXh0KSwKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvaHRtbCcsIFN0cmluZyhodG1sKSksCiAgICAgICAgYC0tJHtib3VuZGFyeX0tLWAsCiAgICAgICAgJycsCiAgICAgIF07CiAgICB9IGVsc2UgewogICAgICBsaW5lcyA9IFsuLi5oZW",
"FkLCAuLi50ZXh0UGFydCgndGV4dC9wbGFpbicsIHRleHQpLCAnJ107CiAgICB9CiAgICByZXR1cm4gYmFzZTY0VXJsRW5jb2RlKGxpbmVzLmpvaW4oJ1xyXG4nKSk7CiAgfQoKICAvLyDilIDilIAgV2hhdCB0aGUgd29ya2VyIGFsbG93cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaGVhZGVyQmxvY2soYmluYXJ5KSB7CiAgICBjb25zdCBlbmQgPSBiaW5hcnkuc2VhcmNoKC9ccj9cblxyP1xuLyk7CiAgICByZXR1cm4gZW5kIDwgMCA_IGJpbmFyeSA6IGJpbmFyeS5zbGljZSgwLCBlbmQpOwogIH0KCiAgLy8gVGhlIG5vdGUgaWQgYSByYXcgbWVzc2FnZSBjYXJyaWVzLCBvciAnJyBpZiBpdCBpcyBub3QgYSBub3RlLgogIGZ1bmN0aW9uIG5vdGVJZE9mUmF3KHJhdykgewogICAgbGV0IGJpbjsKICAgIHRyeSB7IGJpbiA9IGJhc2U2NFVybERlY29kZShyYXcpOyB9IGNhdGNoIHsgcmV0dXJuICcnOyB9CiAgICBjb25zdCBtID0gaGVhZGVyQmxvY2soYmluKS5tYXRjaChuZXcgUmVnRXhwKGBeJHtOT1RFX0hFQURFUn06WyBcXHRdKihbXlxcclxcbl0qKSRgLCAnbWknKSk7CiAgICBjb25zdCBpZCA9IG0gPyBtWzFdLnRyaW0oKSA6ICcnOwogICAgcmV0dXJuIElEX1JFLnRlc3QoaWQpID8gaWQgOiAnJzsKICB9CgogIC",
"8vIFRoZSBib2R5IG9mIGEgbWVzc2FnZXMuaW5zZXJ0IHRoZSB3b3JrZXIgd2lsbCBwYXNzIG9uOiBhIG5vdGUsIGZpbGVkCiAgLy8gdW5kZXIgdXNlciBsYWJlbHMgb25seSwgYW5kIG5vdGhpbmcgZWxzZSBpbiB0aGUgcmVxdWVzdC4KICBmdW5jdGlvbiBpc05vdGVJbnNlcnQoYm9keSkgewogICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgYm9keS5yYXcgIT09ICdzdHJpbmcnKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBleHRyYSA9IE9iamVjdC5rZXlzKGJvZHkpLmZpbHRlcihrID0-IGsgIT09ICdyYXcnICYmIGsgIT09ICdsYWJlbElkcycpOwogICAgaWYgKGV4dHJhLmxlbmd0aCkgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgbGFiZWxzID0gYm9keS5sYWJlbElkcyA9PT0gdW5kZWZpbmVkID8gW10gOiBib2R5LmxhYmVsSWRzOwogICAgaWYgKCFBcnJheS5pc0FycmF5KGxhYmVscykpIHJldHVybiBmYWxzZTsKICAgIGlmIChsYWJlbHMuc29tZShpZCA9PiBGT1JCSURERU5fSU5TRVJUX0xBQkVMUy5oYXMoU3RyaW5nKGlkKS50b1VwcGVyQ2FzZSgpKSkpIHJldHVybiBmYWxzZTsKICAgIHJldHVybiAhIW5vdGVJZE9mUmF3KGJvZHkucmF3KTsKICB9CgogIC8vIOKUgOKUgCBSZWFkaW5nIG5vdGVzIGJhY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGhlYWRlck9mKG1lc3NhZ2UsIG5hbWUpIHsKICAgIHJldHVybiB1dGlsLmhlYWRlck1hcChtZXNzYWdlKVtuYW1lLnRvTG93ZXJDYXNlKCldIHx8ICcnOwogIH0KCiAgZnVuY3Rpb24gY2hhcnNldE9mKHBhcnQpIHsKICAgIGNvbnN0IGN0ID0gKHBhcnQuaGVhZGVycyB8fCBbXSkuZmluZChoID0-IGgubmFtZS50b0xvd2VyQ2FzZSgpID09PSAnY29udGVudC10eXBlJyk7CiAgICBjb25zdCBtID0gY3QgJiYgL2NoYXJzZXQ9Ij8oW14iO1xzXSspIj8vaS5leGVjKGN0LnZhbHVlKTsKICAgIHJldHVybiBtID8gbVsxXSA6ICd1dGYtOCc7CiAgfQoKICBmdW5jdGlvbiBwYXJ0VGV4dChwYXJ0KSB7CiAgICBpZiAoIXBhcnQgfHwgIXBhcnQuYm9keSB8fCAhcGFydC5ib2R5LmRhdGEpIHJldHVybiAnJzsKICAgIHJldHVybiBkZWNvZGVCeXRlcyhiaW5hcnlUb0J5dGVzKGJhc2U2NFVybERlY29kZShwYXJ0LmJvZHkuZGF0YSkpLCBjaGFyc2V0T2YocGFydCkpOwogIH0KCiAgLy8gQSByb3VnaCB0ZXh0IHJlbmRlcmluZyBvZiBhbiBIVE1MIGVtYWlsLCBmb3Igbm90ZXMgdGhhdCBhcnJpdmVkIGFzCiAgLy8gbWFpbCAoc2F5LCBzZW50IHRvIHlvdXJzZWxmIGZyb20gYSBwaG9uZSkuIERvbmUgd2l0aCBwYXR0ZXJucyByYXRoZXIKICAvLyB0aGFuIHRoZSBET006IHBhcnNpbmcgSFRNTCBpbnRvIGEgZG9jdW1lbnQgaXMgYSBUcn",
"VzdGVkIFR5cGVzIHNpbmsgb24KICAvLyBHbWFpbCdzIHBhZ2UsIGFuZCBvbmx5IHRoZSB3b3JkcyBhcmUgd2FudGVkIGFueXdheS4KICBmdW5jdGlvbiBodG1sVG9UZXh0KGh0bWwpIHsKICAgIGNvbnN0IHRleHQgPSBTdHJpbmcoaHRtbCB8fCAnJykKICAgICAgLnJlcGxhY2UoLzwoc2NyaXB0fHN0eWxlfGhlYWR8dGl0bGUpXGJbXj5dKj5bXHNcU10qPzxcL1wxXHMqPi9naSwgJycpCiAgICAgIC5yZXBsYWNlKC88YnJccypcLz8-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPGxpXGJbXj5dKj4vZ2ksICdcbuKAoiAnKQogICAgICAucmVwbGFjZSgvPFwvKHB8ZGl2fHVsfG9sfHRyfGhbMS02XXxibG9ja3F1b3RlfHByZXx0YWJsZSlccyo-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPFtePl0rPi9nLCAnJyk7CiAgICByZXR1cm4gdXRpbC5kZWNvZGVFbnRpdGllcyh0ZXh0KQogICAgICAucmVwbGFjZSgvXHUwMGEwL2csICcgJykKICAgICAgLnJlcGxhY2UoL1sgXHRdK1xuL2csICdcbicpCiAgICAgIC5yZXBsYWNlKC9cbnszLH0vZywgJ1xuXG4nKQogICAgICAudHJpbSgpOwogIH0KCiAgZnVuY3Rpb24gdGV4dFBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHBsYWluID0gW107CiAgICBjb25zdCBodG1sID0gW107CiAgICAoZnVuY3Rpb24gd2FsayhwKSB7CiAgICAgIGlmICghcCkgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gU3RyaW5nKHAubWltZVR5cGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7CiAgICAgIG",
"lmICh0eXBlID09PSAndGV4dC9wbGFpbicpIHBsYWluLnB1c2gocCk7CiAgICAgIGVsc2UgaWYgKHR5cGUgPT09ICd0ZXh0L2h0bWwnKSBodG1sLnB1c2gocCk7CiAgICAgIChwLnBhcnRzIHx8IFtdKS5mb3JFYWNoKHdhbGspOwogICAgfSkocGF5bG9hZCk7CiAgICByZXR1cm4geyBwbGFpbiwgaHRtbCB9OwogIH0KCiAgLy8gUHJlZmVycyBhIHRleHQvcGxhaW4gcGFydCBhbnl3aGVyZSBpbiB0aGUgdHJlZSwgdGhlbiBIVE1MLgogIGZ1bmN0aW9uIGV4dHJhY3RUZXh0KHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIGlmIChwbGFpbi5sZW5ndGgpIHJldHVybiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKTsKICAgIGlmIChodG1sLmxlbmd0aCkgcmV0dXJuIGh0bWxUb1RleHQoaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykpOwogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gQm90aCByZW5kZXJpbmdzLCBkZWNvZGVkLCBmb3IgdGhlIGZvcm1hdHRlZCByZWFkZXI6IHRoZSBIVE1MIGlzIHRoZQogIC8vIHJlY29yZCwgdGhlIHBsYWluIHRleHQgdGhlIGZhbGxiYWNrIGZvciBtYWlsIHRoYXQgaGFzIG5vIEhUTUwuCiAgZnVuY3Rpb24gbWVzc2FnZVBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIH",
"JldHVybiB7CiAgICAgIHBsYWluOiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKSwKICAgICAgaHRtbDogaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJyksCiAgICB9OwogIH0KCiAgLy8gT25lIG5vdGUgZnJvbSBhIG1lc3NhZ2VzLmdldC4gV2l0aCBmb3JtYXQ9bWV0YWRhdGEgdGhlcmUgaXMgbm8gYm9keQogIC8vIChib2R5IHN0YXlzIG51bGwpOyB3aXRoIGZvcm1hdD1mdWxsIHRoZXJlIGlzLgogIGZ1bmN0aW9uIG5vdGVGcm9tTWVzc2FnZShtc2cpIHsKICAgIGNvbnN0IG5vdGVJZCA9IGhlYWRlck9mKG1zZywgTk9URV9IRUFERVIpLnRyaW0oKTsKICAgIGNvbnN0IG93biA9IElEX1JFLnRlc3Qobm90ZUlkKTsKICAgIGNvbnN0IGZ1bGwgPSAhIShtc2cucGF5bG9hZCAmJiAobXNnLnBheWxvYWQuYm9keSB8fCBtc2cucGF5bG9hZC5wYXJ0cykpOwogICAgcmV0dXJuIHsKICAgICAgbWVzc2FnZUlkOiBtc2cuaWQsCiAgICAgIHRocmVhZElkOiBtc2cudGhyZWFkSWQgfHwgJycsCiAgICAgIG5vdGVJZDogb3duID8gbm90ZUlkIDogJycsCiAgICAgIG93biwKICAgICAga2V5OiBvd24gPyBgbjoke25vdGVJZH1gIDogYG06JHttc2cuaWR9YCwKICAgICAgdGl0bGU6IG9uZUxpbmUoaGVhZGVyT2YobXNnLCAnU3ViamVjdCcpKSB8fCAnVW50aXRsZWQgbm90ZScsCiAgICAgIHVwZGF0ZWQ6IE51bWJlcihtc2cuaW50ZXJuYWxEYXRlKS",
"B8fCBEYXRlLnBhcnNlKGhlYWRlck9mKG1zZywgJ0RhdGUnKSkgfHwgMCwKICAgICAgc25pcHBldDogdXRpbC5kZWNvZGVFbnRpdGllcyhtc2cuc25pcHBldCB8fCAnJyksCiAgICAgIGJvZHk6IGZ1bGwgPyBleHRyYWN0VGV4dChtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBwYXJ0czogZnVsbCA_IG1lc3NhZ2VQYXJ0cyhtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBsYWJlbElkczogbXNnLmxhYmVsSWRzIHx8IFtdLAogICAgfTsKICB9CgogIC8vIFR3byBsaXZlIHZlcnNpb25zIG9mIG9uZSBub3RlIG1lYW4gYSBzYXZlIGluc2VydGVkIHRoZSBuZXcgb25lIGJ1dAogIC8vIGNvdWxkIG5vdCB0cmFzaCB0aGUgb2xkIChvZmZsaW5lLCBjbG9zZWQgdGFiKSwgb3IgdHdvIGNvbXB1dGVycyBzYXZlZAogIC8vIGF0IG9uY2UuIFRoZSBuZXdlc3Qgd2luczsgdGhlIHJlc3QgYXJlIHJlcG9ydGVkIHNvIHRoZXkgY2FuIGJlCiAgLy8gdGlkaWVkIGludG8gVHJhc2gsIHdoZXJlIHRoZXkgc3RheSByZWNvdmVyYWJsZSBmb3IgdGhpcnR5IGRheXMuCiAgZnVuY3Rpb24gZGVkdXBlTm90ZXMobm90ZXMpIHsKICAgIGNvbnN0IGxpdmUgPSBbXTsKICAgIGNvbnN0IHN0YWxlID0gW107CiAgICBjb25zdCBiZXN0ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSB7CiAgICAgIGNvbnN0IGN1ciA9IGJlc3QuZ2V0KG4ua2V5KTsKICAgICAgaWYgKCFjdXIpIHsgYmVzdC5zZXQobi5rZXksIG4pOyBjb250aW51ZT",
"sgfQogICAgICBpZiAobi51cGRhdGVkID4gY3VyLnVwZGF0ZWQpIHsgc3RhbGUucHVzaChjdXIpOyBiZXN0LnNldChuLmtleSwgbik7IH0KICAgICAgZWxzZSBzdGFsZS5wdXNoKG4pOwogICAgfQogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSBpZiAoYmVzdC5nZXQobi5rZXkpID09PSBuKSBsaXZlLnB1c2gobik7CiAgICBsaXZlLnNvcnQoKGEsIGIpID0-IGIudXBkYXRlZCAtIGEudXBkYXRlZCk7CiAgICByZXR1cm4geyBsaXZlLCBzdGFsZSB9OwogIH0KCiAgLy8g4pSA4pSAIEZvbGRlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGZvbGRlciBpcyBhIEdtYWlsIGxhYmVsIHVuZGVyIHRoZSBub3RlcyBsYWJlbDogIl9Ob3Rlcy9Xb3JrIiwKICAvLyAiX05vdGVzL1dvcmsvQ2xpZW50cyIuIEV2ZXJ5IG5vdGUgY2FycmllcyB0aGUgbm90ZXMgbGFiZWwgaXRzZWxmLCBwbHVzCiAgLy8gdGhlIGxhYmVsIG9mIGF0IG1vc3Qgb25lIGZvbGRlciAtIHNvICJBbGwgbm90ZXMiIGlzIG9uZSBsYWJlbCwgYW5kIHRoZQogIC8vIGZvbGRlcnMgc2hvdyB1cCBuZXN0ZWQgdW5kZXIgX05vdGVzIGluIEdtYWlsJ3Mgb3duIGxhYmVsIGxpc3QuCg",
"ogIGNvbnN0IEZPTERFUl9OQU1FX01BWCA9IDYwOwoKICAvLyBUaGUgZm9sZGVycyB1bmRlciBgcm9vdGAsIGluIHRyZWUgb3JkZXI6IGVhY2ggcGFyZW50IGZvbGxvd2VkIGJ5IGl0cwogIC8vIGNoaWxkcmVuLCBhbHBoYWJldGljYWxseSwgd2l0aCBpdHMgZGVwdGguIEEgbGFiZWwgd2hvc2UgcGFyZW50IGxhYmVsCiAgLy8gaXMgbWlzc2luZyAobWFkZSBieSBoYW5kIGluIEdtYWlsKSBzdGlsbCBhcHBlYXJzLCBhdCBpdHMgb3duIGRlcHRoLgogIGZ1bmN0aW9uIGZvbGRlclRyZWUobGFiZWxzLCByb290KSB7CiAgICBjb25zdCBwcmVmaXggPSBgJHtyb290fS9gOwogICAgY29uc3QgbGlzdCA9IChsYWJlbHMgfHwgW10pCiAgICAgIC5maWx0ZXIobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKHByZWZpeCkgJiYgbC5uYW1lLmxlbmd0aCA-IHByZWZpeC5sZW5ndGgpCiAgICAgIC5tYXAobCA9PiB7CiAgICAgICAgY29uc3QgcGF0aCA9IGwubmFtZS5zbGljZShwcmVmaXgubGVuZ3RoKTsKICAgICAgICBjb25zdCBwYXJ0cyA9IHBhdGguc3BsaXQoJy8nKTsKICAgICAgICByZXR1cm4geyBpZDogbC5pZCwgbmFtZTogbC5uYW1lLCBwYXRoLCB0aXRsZTogcGFydHNbcGFydHMubGVuZ3RoIC0gMV0sIGRlcHRoOiBwYXJ0cy5sZW5ndGggLSAxLCBwYXJlbnRQYXRoOiBwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpIH07CiAgICAgIH0pOwogICAgLy8gU29ydGluZyBieS",
"BwYXRoIHNlZ21lbnQgYnkgc2VnbWVudCBrZWVwcyBldmVyeSBjaGlsZCB1bmRlciBpdHMgcGFyZW50LgogICAgY29uc3Qga2V5ID0gZiA9PiBmLnBhdGguc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRvTG93ZXJDYXNlKCkpOwogICAgbGlzdC5zb3J0KChhLCBiKSA9PiB7CiAgICAgIGNvbnN0IHggPSBrZXkoYSk7CiAgICAgIGNvbnN0IHkgPSBrZXkoYik7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5taW4oeC5sZW5ndGgsIHkubGVuZ3RoKTsgaSsrKSB7CiAgICAgICAgaWYgKHhbaV0gIT09IHlbaV0pIHJldHVybiB4W2ldIDwgeVtpXSA_IC0xIDogMTsKICAgICAgfQogICAgICByZXR1cm4geC5sZW5ndGggLSB5Lmxlbmd0aDsKICAgIH0pOwogICAgcmV0dXJuIGxpc3Q7CiAgfQoKICAvLyBUaGUgZm9sZGVyIGEgbm90ZSBpcyBpbiwgZnJvbSBpdHMgbGFiZWxzOyAnJyBmb3Igbm9uZS4gVHdvIGZvbGRlcgogIC8vIGxhYmVscyAoYXBwbGllZCBieSBoYW5kKSByZXNvbHZlIHRvIHRoZSBmaXJzdCBpbiB0cmVlIG9yZGVyLgogIGZ1bmN0aW9uIGZvbGRlck9mKGxhYmVsSWRzLCBmb2xkZXJzKSB7CiAgICBjb25zdCBoYXZlID0gbmV3IFNldChsYWJlbElkcyB8fCBbXSk7CiAgICBjb25zdCBmID0gKGZvbGRlcnMgfHwgW10pLmZpbmQoeCA9PiBoYXZlLmhhcyh4LmlkKSk7CiAgICByZXR1cm4gZiA_IGYuaWQgOiAnJzsKICB9CgogIC8vIE1vdmluZyBhIG5vdGU6IGtlZXAgKG9yIHJlc3RvcmUpIHRoZSBub3RlcyBsYW",
"JlbCwgYWRkIHRoZSB0YXJnZXQncywKICAvLyBkcm9wIGV2ZXJ5IG90aGVyIGZvbGRlcidzLgogIGZ1bmN0aW9uIG1vdmVGb2xkZXJEaWZmKHJvb3RJZCwgZm9sZGVycywgdGFyZ2V0SWQpIHsKICAgIGNvbnN0IGFkZCA9IFtyb290SWRdOwogICAgaWYgKHRhcmdldElkKSBhZGQucHVzaCh0YXJnZXRJZCk7CiAgICBjb25zdCByZW1vdmUgPSAoZm9sZGVycyB8fCBbXSkubWFwKGYgPT4gZi5pZCkuZmlsdGVyKGlkID0-IGlkICE9PSB0YXJnZXRJZCk7CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogYWRkLCByZW1vdmVMYWJlbElkczogcmVtb3ZlIH07CiAgfQoKICBmdW5jdGlvbiB2YWxpZGF0ZUZvbGRlclRpdGxlKHRpdGxlLCBzaWJsaW5ncyA9IFtdKSB7CiAgICBjb25zdCB0ID0gU3RyaW5nKHRpdGxlIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXQpIHJldHVybiAnR2l2ZSB0aGUgZm9sZGVyIGEgbmFtZS4nOwogICAgaWYgKHQuaW5jbHVkZXMoJy8nKSkgcmV0dXJuICdBIGZvbGRlciBuYW1lIGNhbm5vdCBjb250YWluIOKAnC_igJ0uIE1ha2UgYSBzdWJmb2xkZXIgaW5zdGVhZC4nOwogICAgaWYgKHQubGVuZ3RoID4gRk9MREVSX05BTUVfTUFYKSByZXR1cm4gYEtlZXAgZm9sZGVyIG5hbWVzIHVuZGVyICR7Rk9MREVSX05BTUVfTUFYfSBjaGFyYWN0ZXJzLmA7CiAgICBpZiAoc2libGluZ3Muc29tZShzID0-IHMudG9Mb3dlckNhc2UoKSA9PT0gdC50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuIGBUaGVyZSBpcyBhbHJlYWR5IG",
"EgZm9sZGVyIGNhbGxlZCDigJwke3R94oCdIGhlcmUuYDsKICAgIHJldHVybiAnJzsKICB9CgogIC8vIFJlbmFtaW5nIGEgZm9sZGVyIHJlbmFtZXMgaXRzIGxhYmVsIGFuZCBldmVyeSBsYWJlbCBiZWxvdyBpdCwgc2luY2UKICAvLyBHbWFpbCdzIEFQSSByZW5hbWVzIG9ubHkgdGhlIG9uZSBsYWJlbCBpdCBpcyBnaXZlbi4KICBmdW5jdGlvbiByZW5hbWVQbGFuKGZvbGRlciwgbmV3VGl0bGUsIGZvbGRlcnMpIHsKICAgIGNvbnN0IHBhcmVudCA9IGZvbGRlci5uYW1lLnNsaWNlKDAsIGZvbGRlci5uYW1lLmxlbmd0aCAtIGZvbGRlci50aXRsZS5sZW5ndGgpOwogICAgY29uc3QgbmV3TmFtZSA9IGAke3BhcmVudH0ke1N0cmluZyhuZXdUaXRsZSkudHJpbSgpfWA7CiAgICByZXR1cm4gKGZvbGRlcnMgfHwgW10pCiAgICAgIC5maWx0ZXIoZiA9PiBmLm5hbWUgPT09IGZvbGRlci5uYW1lIHx8IGYubmFtZS5zdGFydHNXaXRoKGAke2ZvbGRlci5uYW1lfS9gKSkKICAgICAgLm1hcChmID0-ICh7IGlkOiBmLmlkLCBuYW1lOiBuZXdOYW1lICsgZi5uYW1lLnNsaWNlKGZvbGRlci5uYW1lLmxlbmd0aCkgfSkpOwogIH0KCiAgLy8gV2hldGhlciB0aGUgd29ya2VyIG1heSBkZWxldGUgYSBsYWJlbDogYSBmb2xkZXIgdW5kZXIgdGhlIG5vdGVzIGxhYmVsCiAgLy8gd2l0aCBubyBub3RlcyBpbiBpdCBhbmQgbm8gZm9sZGVycyB1bmRlciBpdC4gYGxpdmVNZXNzYWdlc2AgaXMgd2hhdCBhCiAgLy8gbWVzc2FnZXMubGlzdCBvbiB0aG",
"UgbGFiZWwgZm91bmQgLSBub3QgdGhlIGxhYmVsJ3Mgb3duIGNvdW50LCB3aGljaAogIC8vIGFsc28gY291bnRzIG9sZCB2ZXJzaW9ucyB3YWl0aW5nIGluIFRyYXNoIGFuZCB3b3VsZCBrZWVwIGFuIGVtcHRpZWQKICAvLyBmb2xkZXIgdW5kZWxldGFibGUgZm9yIGEgbW9udGguCiAgZnVuY3Rpb24gaXNEZWxldGFibGVGb2xkZXIobGFiZWwsIHJvb3QsIGFsbExhYmVscywgbGl2ZU1lc3NhZ2VzKSB7CiAgICBpZiAoIWxhYmVsIHx8IHR5cGVvZiBsYWJlbC5uYW1lICE9PSAnc3RyaW5nJyB8fCAhcm9vdCkgcmV0dXJuIGZhbHNlOwogICAgaWYgKCFsYWJlbC5uYW1lLnN0YXJ0c1dpdGgoYCR7cm9vdH0vYCkgfHwgbGFiZWwubmFtZS5sZW5ndGggPD0gcm9vdC5sZW5ndGggKyAxKSByZXR1cm4gZmFsc2U7CiAgICBpZiAobGl2ZU1lc3NhZ2VzICE9PSAwKSByZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gIShhbGxMYWJlbHMgfHwgW10pLnNvbWUobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKGAke2xhYmVsLm5hbWV9L2ApKTsKICB9CgogIGNvbnN0IGFwaSA9IHsKICAgIE5PVEVfSEVBREVSLCBOT1RFX1NFTkRFUiwgREVGQVVMVF9MQUJFTCwgTUFYX0JPRFksIE1BWF9USVRMRSwgRk9SQklEREVOX0lOU0VSVF9MQUJFTFMsIEZPTERFUl9OQU1FX01BWCwKICAgIGZvbGRlclRyZWUsIGZvbGRlck9mLCBtb3ZlRm9sZGVyRGlmZiwgdmFsaWRhdGVGb2xkZXJUaXRsZSwgcmVuYW",
"1lUGxhbiwgaXNEZWxldGFibGVGb2xkZXIsCiAgICBTQ1JBVENIUEFEX0lELCBTQ1JBVENIUEFEX1RJVExFLCBuZXdOb3RlSWQsIG5vdGVJZEZvciwgZW5jb2RlSGVhZGVyVGV4dCwgZGVjb2RlSGVhZGVyVGV4dCwgYmFzZTY0VXJsRW5jb2RlLCBiYXNlNjRVcmxEZWNvZGUsCiAgICB0aXRsZUZvciwgYnVpbGROb3RlUmF3LCBub3RlSWRPZlJhdywgaXNOb3RlSW5zZXJ0LAogICAgaHRtbFRvVGV4dCwgZXh0cmFjdFRleHQsIG1lc3NhZ2VQYXJ0cywgbm90ZUZyb21NZXNzYWdlLCBkZWR1cGVOb3RlcywKICB9OwoKICBucy5ub3Rlc0xvZ2ljID0gYXBpOwogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgbW9kdWxlLmV4cG9ydHMgPSBhcGk7Cn0pKCk7Cg\"],[\"src/lib/note-format.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGUgZm9ybWF0dGluZyAocHVyZSkKLy8KLy8gQSBmb3JtYXR0ZWQgbm90ZSBpcyBhIGxpc3Qgb2YgYmxvY2tzIC0gcGFyYWdyYXBocywgdGhyZWUgaGVhZGluZwovLyBzaXplcywgYnVsbGV0ZWQsIG51bWJlcm",
"VkIGFuZCBjaGVjayBsaXN0cyBuZXN0ZWQgdXAgdG8gdGhyZWUgZGVlcCAtCi8vIGVhY2ggaG9sZGluZyBydW5zIG9mIHRleHQgdGhhdCBtYXkgYmUgYm9sZCwgaXRhbGljLCBzdHJ1Y2sgdGhyb3VnaCBvcgovLyBhIGxpbmsuIFRoYXQgaXMgdGhlIHdob2xlIG1vZGVsOyBub3RoaW5nIG91dHNpZGUgaXQgc3Vydml2ZXMgYSBzYXZlLgovLwovLyBJdCBpcyBzdG9yZWQgaW4gdGhlIG5vdGUncyBtZXNzYWdlIHR3aWNlLiBUaGUgSFRNTCBwYXJ0IGlzIHRoZSByZWFsCi8vIHJlY29yZDogR21haWwgc2hvd3MgaXQgKG9uIHRoZSBwaG9uZSB0b28pLCBhbmQgdGhpcyBmaWxlIHJlYWRzIGl0IGJhY2sKLy8gd2l0aCBhIHNtYWxsIHRva2VuaXplciBvZiBpdHMgb3duIHJhdGhlciB0aGFuIHRoZSBicm93c2VyJ3MgSFRNTAovLyBwYXJzZXIsIHdoaWNoIGlzIGEgVHJ1c3RlZCBUeXBlcyBzaW5rIG9uIEdtYWlsJ3MgcGFnZSBhbmQgd291bGQgYWNjZXB0Ci8vIGZhciBtb3JlIHRoYW4gdGhlIG1vZGVsIGNhbiBob2xkLiBUaGUgcGxhaW4tdGV4dCBwYXJ0IGlzIGEgcmVhZGFibGUKLy8gcmVuZGVyaW5nIC0gYnVsbGV0cywg4piQIGFuZCDimJEgLSBmb3IgR21haWwncyBwcmV2aWV3cyBhbmQgZm9yIGFueSBtYWlsCi8vIGNsaWVudCB0aGF0IHNob3dzIHRleHQuCi8vCi8vIE1haWwgdGhhdCBhcnJpdmVkIGFzIGEgbm90ZSAod3JpdHRlbiBpbiBHbWFpbCwgc2F5KSBnb2VzIHRocm91Z2ggdGhlCi8vIHNhbWUgcmVhZGVyLCBzbyBpdH",
"MgYm9sZCwgbGlzdHMgYW5kIGxpbmtzIGNvbWUgYWNyb3NzIHdoZXJlIHRoZXkgZml0Ci8vIHRoZSBtb2RlbCBhbmQgZXZlcnl0aGluZyBlbHNlIGlzIHJlZHVjZWQgdG8gdGV4dC4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IFRZUEVTID0gbmV3IFNldChbJ3AnLCAnaDEnLCAnaDInLCAnaDMnLCAndWwnLCAnb2wnLCAnY2hlY2snXSk7CiAgY29uc3QgTElTVFMgPSBuZXcgU2V0KFsndWwnLCAnb2wnLCAnY2hlY2snXSk7CiAgY29uc3QgTUFYX0xFVkVMID0gMzsKICBjb25zdCBCT1ggPSAn4piQJzsgICAgIC8vIOKYkAogIGNvbnN0IFRJQ0tFRCA9ICfimJEnOyAgLy8g4piRCiAgY29uc3QgQlVMTEVUID0gJ-KAoic7ICAvLyDigKIKCiAgLy8g4pSA4pSAIF",
"RoZSBtb2RlbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYmxvY2sodHlwZSA9ICdwJywgcnVucyA9IFtdLCB7IGxldmVsID0gMCwgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgcmV0dXJuIHsgdHlwZSwgbGV2ZWw6IExJU1RTLmhhcyh0eXBlKSA_IGxldmVsIDogMCwgY2hlY2tlZDogdHlwZSA9PT0gJ2NoZWNrJyA_ICEhY2hlY2tlZCA6IGZhbHNlLCBydW5zIH07CiAgfQoKICBmdW5jdGlvbiBlbXB0eURvYygpIHsKICAgIHJldHVybiBbYmxvY2soJ3AnKV07CiAgfQoKICBjb25zdCBzYW1lTWFya3MgPSAoYSwgYikgPT4gISFhLmIgPT09ICEhYi5iICYmICEhYS5pID09PSAhIWIuaSAmJiAhIWEucyA9PT0gISFiLnMgJiYgKGEuaHJlZiB8fCAnJykgPT09IChiLmhyZWYgfHwgJycpOwoKICBmdW5jdGlvbiBjbGVhblJ1bihyKSB7CiAgICBjb25zdCBvdXQgPSB7IHRleHQ6IFN0cmluZyhyLnRleHQgfHwgJycpIH07CiAgICBpZiAoci5iKSBvdXQuYiA9IHRydWU7CiAgICBpZiAoci5pKSBvdXQuaSA9IHRydWU7CiAgICBpZiAoci5zKSBvdXQucyA9IHRydWU7CiAgICBjb25zdCBocmVmID0gci5ocmVmID8gc2FmZUhyZWYoci5ocmVmKSA6IC",
"cnOwogICAgaWYgKGhyZWYpIG91dC5ocmVmID0gaHJlZjsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBEcm9wcyBlbXB0eSBydW5zIGFuZCBqb2lucyBuZWlnaGJvdXJzIHRoYXQgbG9vayB0aGUgc2FtZSwgc28gdHdvCiAgLy8gZG9jdW1lbnRzIHRoYXQgcmVhZCBhbGlrZSBjb21wYXJlIGFsaWtlLgogIGZ1bmN0aW9uIG5vcm1hbGlzZVJ1bnMocnVucykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGNvbnN0IHIgb2YgcnVucyB8fCBbXSkgewogICAgICBpZiAoIXIgfHwgIXIudGV4dCkgY29udGludWU7CiAgICAgIGNvbnN0IGxhc3QgPSBvdXRbb3V0Lmxlbmd0aCAtIDFdOwogICAgICBpZiAobGFzdCAmJiBzYW1lTWFya3MobGFzdCwgcikpIGxhc3QudGV4dCArPSByLnRleHQ7CiAgICAgIGVsc2Ugb3V0LnB1c2goY2xlYW5SdW4ocikpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIFVua25vd24gdHlwZXMgYmVjb21lIHBhcmFncmFwaHM7IGEgbGlzdCBpdGVtIG1heSBzaXQgYXQgbW9zdCBvbmUgbGV2ZWwKICAvLyBkZWVwZXIgdGhhbiB0aGUgbGlzdCBpdGVtIGJlZm9yZSBpdCwgd2hpY2ggaXMgd2hhdCBrZWVwcyB0aGUgSFRNTCBhCiAgLy8gcHJvcGVybHkgbmVzdGVkIGxpc3QgYW5kIHRoZSBlZGl0b3IncyBpbmRlbnRzIG1lYW5pbmdmdWwuCiAgZnVuY3Rpb24gbm9ybWFsaXNlRG9jKGRvYykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBsZXQgcHJldkxldmVsID0gLTE7CiAgICBmb3IgKG",
"NvbnN0IGIgb2YgQXJyYXkuaXNBcnJheShkb2MpID8gZG9jIDogW10pIHsKICAgICAgaWYgKCFiIHx8IHR5cGVvZiBiICE9PSAnb2JqZWN0JykgY29udGludWU7CiAgICAgIGNvbnN0IHR5cGUgPSBUWVBFUy5oYXMoYi50eXBlKSA_IGIudHlwZSA6ICdwJzsKICAgICAgbGV0IGxldmVsID0gMDsKICAgICAgaWYgKExJU1RTLmhhcyh0eXBlKSkgewogICAgICAgIGxldmVsID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oTUFYX0xFVkVMLCBOdW1iZXIoYi5sZXZlbCkgfHwgMCwgcHJldkxldmVsICsgMSkpOwogICAgICAgIHByZXZMZXZlbCA9IGxldmVsOwogICAgICB9IGVsc2UgewogICAgICAgIHByZXZMZXZlbCA9IC0xOwogICAgICB9CiAgICAgIG91dC5wdXNoKGJsb2NrKHR5cGUsIG5vcm1hbGlzZVJ1bnMoYi5ydW5zKSwgeyBsZXZlbCwgY2hlY2tlZDogYi5jaGVja2VkIH0pKTsKICAgIH0KICAgIHJldHVybiBvdXQubGVuZ3RoID8gb3V0IDogZW1wdHlEb2MoKTsKICB9CgogIGNvbnN0IGJsb2NrVGV4dCA9IGIgPT4gYi5ydW5zLm1hcChyID0-IHIudGV4dCkuam9pbignJyk7CgogIGZ1bmN0aW9uIGRvY1RleHQoZG9jKSB7CiAgICByZXR1cm4gZG9jLm1hcChibG9ja1RleHQpLmpvaW4oJ1xuJyk7CiAgfQoKICBmdW5jdGlvbiBpc0VtcHR5KGRvYykgewogICAgcmV0dXJuIGRvYy5ldmVyeShiID0-ICFibG9ja1RleHQoYikudHJpbSgpKTsKICB9CgogIC8vIOKUgOKUgCBMaW5rcyDilIDilIDilIDilIDilIDilIDilIDilIDilI",
"DilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gV2ViIGFuZCBtYWlsIGxpbmtzIG9ubHkuICJleGFtcGxlLmNvbS94IiBnZXRzIGh0dHBzOi8vIGluIGZyb250LCBhCiAgLy8gYmFyZSBhZGRyZXNzIGdldHMgbWFpbHRvOiwgYW5kIGFueXRoaW5nIGVsc2UgLSBqYXZhc2NyaXB0OiwgZGF0YTosCiAgLy8gZmlsZTogLSBpcyBub3QgYSBsaW5rIGF0IGFsbC4KICBmdW5jdGlvbiBzYWZlSHJlZih1cmwpIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodXJsIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXMgfHwgL1tcczw-Il0vLnRlc3QocykpIHJldHVybiAnJzsKICAgIGlmICgvXm1haWx0bzovaS50ZXN0KHMpKSByZXR1cm4gL15tYWlsdG86W15AXHNdK0BbXkBcc10rJC9pLnRlc3QocykgPyBzIDogJyc7CiAgICBpZiAoL15bXlxzQC86XStAW15cc0AvOl0rXC5bXlxzQC86XSskLy50ZXN0KHMpKSByZXR1cm4gYG1haWx0bzoke3N9YDsKICAgIGxldCBjYW5kaWRhdGUgPSBzOwogICAgaWYgKCEvXlthLXpdW2EtejAtOSsuLV0qOi9pLnRlc3QocykpIHsKICAgICAgaWYgKCEvXltcdy1dKyhcLltcdy1dKykrKDpcZCspPyhbLz8jXXwkKS8udGVzdChzKSkgcmV0dXJuICcnOwogICAgICBjYW5kaWRhdG",
"UgPSBgaHR0cHM6Ly8ke3N9YDsKICAgIH0KICAgIHRyeSB7CiAgICAgIGNvbnN0IHUgPSBuZXcgVVJMKGNhbmRpZGF0ZSk7CiAgICAgIHJldHVybiB1LnByb3RvY29sID09PSAnaHR0cDonIHx8IHUucHJvdG9jb2wgPT09ICdodHRwczonID8gdS5ocmVmIDogJyc7CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuICcnOwogICAgfQogIH0KCiAgLy8g4pSA4pSAIEhUTUwgb3V0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBlc2NIdG1sID0gcyA9PiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpLnJlcGxhY2UoLyIvZywgJyZxdW90OycpOwoKICAvLyBTcGFjZXMgSFRNTCB3b3VsZCBjb2xsYXBzZSAtIGRvdWJsZWQsIGF0IGVpdGhlciBlbmQgb2YgYSBibG9jaywgb3IKICAvLyBtZWV0aW5nIGFjcm9zcyBhIHRhZyAtIGFyZSB3cml0dGVuIGFzICZuYnNwOyBzbyB0aGV5IGNvbWUgYmFjayBhcwogIC8vIHR5cGVkLgogIGZ1bmN0aW9uIHJ1bnNIdG1sKHJ1bnMpIHsKICAgIGxldCBvdXQgPSAnJzsKICAgIGxldCBwcmV2U3BhY2UgPSBmYWxzZTsKICAgIGZvciAobG",
"V0IGkgPSAwOyBpIDwgcnVucy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IGhyZWYgPSBydW5zW2ldLmhyZWYgfHwgJyc7CiAgICAgIGxldCBqID0gaTsKICAgICAgbGV0IGlubmVyID0gJyc7CiAgICAgIHdoaWxlIChqIDwgcnVucy5sZW5ndGggJiYgKHJ1bnNbal0uaHJlZiB8fCAnJykgPT09IGhyZWYpIHsKICAgICAgICBjb25zdCByYXcgPSBydW5zW2pdLnRleHQ7CiAgICAgICAgbGV0IHQgPSBlc2NIdG1sKHJhdykucmVwbGFjZSgvIHsyfS9nLCAnICZuYnNwOycpOwogICAgICAgIGlmIChwcmV2U3BhY2UgJiYgdFswXSA9PT0gJyAnKSB0ID0gYCZuYnNwOyR7dC5zbGljZSgxKX1gOwogICAgICAgIHByZXZTcGFjZSA9IC8gJC8udGVzdChyYXcpOwogICAgICAgIGlmIChydW5zW2pdLnMpIHQgPSBgPHM-JHt0fTwvcz5gOwogICAgICAgIGlmIChydW5zW2pdLmkpIHQgPSBgPGk-JHt0fTwvaT5gOwogICAgICAgIGlmIChydW5zW2pdLmIpIHQgPSBgPGI-JHt0fTwvYj5gOwogICAgICAgIGlubmVyICs9IHQ7CiAgICAgICAgaisrOwogICAgICB9CiAgICAgIG91dCArPSBocmVmID8gYDxhIGhyZWY9IiR7ZXNjSHRtbChocmVmKX0iPiR7aW5uZXJ9PC9hPmAgOiBpbm5lcjsKICAgICAgaSA9IGo7CiAgICB9CiAgICAvLyBFZGdlIHNwYWNlcyBvZiB0aGUgd2hvbGUgYmxvY2ssIGFmdGVyIHRoZSB0YWdzIGFyZSBpbiBwbGFjZS4KICAgIHJldHVybiBvdXQucmVwbGFjZSgvXigoPzo8W14-XSs-KSopIC8sICckMSZuYnNwOycpLnJlcG",
"xhY2UoLyAoKD86PFwvW14-XSs-KSopJC8sICcmbmJzcDskMScpOwogIH0KCiAgY29uc3QgU1RZTEUgPSB7CiAgICBkb2M6ICdmb250LWZhbWlseTpBcmlhbCxIZWx2ZXRpY2Esc2Fucy1zZXJpZjtmb250LXNpemU6MTRweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOiMxZjFmMWYnLAogICAgcDogJ21hcmdpbjowJywKICAgIGgxOiAnbWFyZ2luOjE0cHggMCA0cHg7Zm9udC1zaXplOjIycHg7bGluZS1oZWlnaHQ6MS4zO2ZvbnQtd2VpZ2h0OmJvbGQnLAogICAgaDI6ICdtYXJnaW46MTJweCAwIDJweDtmb250LXNpemU6MThweDtsaW5lLWhlaWdodDoxLjM7Zm9udC13ZWlnaHQ6Ym9sZCcsCiAgICBoMzogJ21hcmdpbjoxMHB4IDAgMnB4O2ZvbnQtc2l6ZToxNXB4O2xpbmUtaGVpZ2h0OjEuMztmb250LXdlaWdodDpib2xkJywKICAgIGxpc3Q6ICdtYXJnaW46MDtwYWRkaW5nLWxlZnQ6MjZweCcsCiAgICBjaGVjazogJ21hcmdpbjowO3BhZGRpbmctbGVmdDo0cHg7bGlzdC1zdHlsZTpub25lJywKICAgIGxpOiAnbWFyZ2luOjFweCAwJywKICB9OwoKICBmdW5jdGlvbiB0b0h0bWwoZG9jSW4pIHsKICAgIGNvbnN0IGRvYyA9IG5vcm1hbGlzZURvYyhkb2NJbik7CiAgICBjb25zdCBzdGFjayA9IFtdOyAvLyBvcGVuIGxpc3RzLCBvbmUgcGVyIGxldmVsOiB7IHRhZywgY2hlY2sgfQogICAgbGV0IG91dCA9IGA8ZGl2IGRhdGEtZ2tiLW5vdGU9IjEiIHN0eWxlPSIke1NUWUxFLmRvY30iPmA7CiAgICBjb25zdCBjbG9zZSA9ICgpID",
"0-IHsgb3V0ICs9IGA8L2xpPjwvJHtzdGFjay5wb3AoKS50YWd9PmA7IH07CgogICAgZm9yIChjb25zdCBiIG9mIGRvYykgewogICAgICBjb25zdCBpbm5lciA9IHJ1bnNIdG1sKGIucnVucyk7CiAgICAgIGlmICghTElTVFMuaGFzKGIudHlwZSkpIHsKICAgICAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSBjbG9zZSgpOwogICAgICAgIG91dCArPSBgPCR7Yi50eXBlfSBzdHlsZT0iJHtTVFlMRVtiLnR5cGVdfSI-JHtpbm5lciB8fCAnPGJyPid9PC8ke2IudHlwZX0-XG5gOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IHRhZyA9IGIudHlwZSA9PT0gJ29sJyA_ICdvbCcgOiAndWwnOwogICAgICBjb25zdCBjaGVjayA9IGIudHlwZSA9PT0gJ2NoZWNrJzsKICAgICAgd2hpbGUgKHN0YWNrLmxlbmd0aCA-IGIubGV2ZWwgKyAxKSBjbG9zZSgpOwogICAgICBpZiAoc3RhY2subGVuZ3RoID09PSBiLmxldmVsICsgMSkgewogICAgICAgIGNvbnN0IHRvcCA9IHN0YWNrW3N0YWNrLmxlbmd0aCAtIDFdOwogICAgICAgIGlmICh0b3AudGFnICE9PSB0YWcgfHwgdG9wLmNoZWNrICE9PSBjaGVjaykgY2xvc2UoKTsKICAgICAgICBlbHNlIG91dCArPSAnPC9saT4nOwogICAgICB9CiAgICAgIGlmIChzdGFjay5sZW5ndGggPT09IGIubGV2ZWwpIHsKICAgICAgICBvdXQgKz0gY2hlY2sgPyBgPHVsIGRhdGEtY2hlY2s9IjEiIHN0eWxlPSIke1NUWUxFLmNoZWNrfSI-YCA6IGA8JHt0YWd9IHN0eWxlPSIke1NUWUxFLm",
"xpc3R9Ij5gOwogICAgICAgIHN0YWNrLnB1c2goeyB0YWcsIGNoZWNrIH0pOwogICAgICB9CiAgICAgIGNvbnN0IGdseXBoID0gY2hlY2sgPyBgPHNwYW4gZGF0YS1nbHlwaD0iMSI-JHtiLmNoZWNrZWQgPyBUSUNLRUQgOiBCT1h9Jm5ic3A7PC9zcGFuPmAgOiAnJzsKICAgICAgb3V0ICs9IGA8bGkgc3R5bGU9IiR7U1RZTEUubGl9IiR7Y2hlY2sgPyBgIGRhdGEtY2hlY2tlZD0iJHtiLmNoZWNrZWQgPyAxIDogMH0iYCA6ICcnfT4ke2dseXBofSR7aW5uZXIgfHwgKGNoZWNrID8gJycgOiAnPGJyPicpfWA7CiAgICB9CiAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSBjbG9zZSgpOwogICAgcmV0dXJuIGAke291dH08L2Rpdj5gOwogIH0KCiAgLy8g4pSA4pSAIFBsYWluIHRleHQgb3V0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBydW5zUGxhaW4ocnVucykgewogICAgbGV0IG91dCA9ICcnOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBydW5zLmxlbmd0aDspIHsKICAgICAgY29uc3QgaHJlZiA9IHJ1bnNbaV0uaHJlZiB8fCAnJzsKICAgICAgbGV0IGogPSBpOwogICAgICBsZXQgdGV4dCA9ICcnOwogICAgICB3aGlsZSAoaiA8IHJ1bnMubGVuZ3RoICYmIChydW5zW2pdLmhyZW",
"YgfHwgJycpID09PSBocmVmKSB0ZXh0ICs9IHJ1bnNbaisrXS50ZXh0OwogICAgICBjb25zdCBiYXJlID0gaHJlZi5yZXBsYWNlKC9ebWFpbHRvOi8sICcnKTsKICAgICAgY29uc3Qgc2FtZSA9IHMgPT4gcy50cmltKCkucmVwbGFjZSgvXihodHRwcz86XC9cL3xtYWlsdG86KS8sICcnKS5yZXBsYWNlKC9cLyQvLCAnJyk7CiAgICAgIG91dCArPSBocmVmICYmIHNhbWUodGV4dCkgIT09IHNhbWUoaHJlZikgPyBgJHt0ZXh0fSAoJHtiYXJlfSlgIDogdGV4dDsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gdG9QbGFpbihkb2NJbikgewogICAgY29uc3QgZG9jID0gbm9ybWFsaXNlRG9jKGRvY0luKTsKICAgIGNvbnN0IGNvdW50ZXJzID0gWzAsIDAsIDAsIDBdOwogICAgcmV0dXJuIGRvYy5tYXAoYiA9PiB7CiAgICAgIGNvbnN0IHRleHQgPSBydW5zUGxhaW4oYi5ydW5zKTsKICAgICAgaWYgKCFMSVNUUy5oYXMoYi50eXBlKSkgewogICAgICAgIGNvdW50ZXJzLmZpbGwoMCk7CiAgICAgICAgcmV0dXJuIHRleHQ7CiAgICAgIH0KICAgICAgY29uc3QgcGFkID0gJyAgJy5yZXBlYXQoYi5sZXZlbCk7CiAgICAgIGZvciAobGV0IGwgPSBiLmxldmVsICsgMTsgbCA8IGNvdW50ZXJzLmxlbmd0aDsgbCsrKSBjb3VudGVyc1tsXSA9IDA7CiAgICAgIGlmIChiLnR5cGUgPT09ICdvbCcpIHJldHVybiBgJHtwYWR9JHsrK2NvdW50ZXJzW2IubGV2ZWxdfS4gJHt0ZXh0fWA7CiAgICAgIGNvdW",
"50ZXJzW2IubGV2ZWxdID0gMDsKICAgICAgaWYgKGIudHlwZSA9PT0gJ2NoZWNrJykgcmV0dXJuIGAke3BhZH0ke2IuY2hlY2tlZCA_IFRJQ0tFRCA6IEJPWH0gJHt0ZXh0fWA7CiAgICAgIHJldHVybiBgJHtwYWR9JHtCVUxMRVR9ICR7dGV4dH1gOwogICAgfSkuam9pbignXG4nKTsKICB9CgogIC8vIOKUgOKUgCBQbGFpbiB0ZXh0IGluIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBBIHBsYWluIG5vdGUgKGZyb20gYmVmb3JlIGZvcm1hdHRpbmcgZXhpc3RlZCwgb3IgcGxhaW4gbWFpbCkgYmVjb21lcwogIC8vIG9uZSBibG9jayBwZXIgbGluZS4gTGluZXMgdGhhdCBhbHJlYWR5IGxvb2sgbGlrZSBsaXN0cyAtICItICIsICLigKIgIiwKICAvLyAiMS4gIiwgIuKYkCAiIC0gYmVjb21lIGxpc3RzLCBpbmRlbnRlZCB0d28gc3BhY2VzIGEgbGV2ZWwuCiAgZnVuY3Rpb24gZnJvbVBsYWluKHRleHQpIHsKICAgIGNvbnN0IGxpbmVzID0gU3RyaW5nKHRleHQgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNwbGl0KCdcbicpOwogICAgcmV0dXJuIG5vcm1hbGlzZURvYyhsaW5lcy5tYXAobGluZSA9PiB7CiAgICAgIGNvbnN0IG0gPSAvXiggKikoPzooWy0q4oCiXSl8KFxkez",
"EsM30pWy4pXXwoW-KYkOKYkV0pKSAoLiopJC8uZXhlYyhsaW5lKTsKICAgICAgaWYgKCFtKSByZXR1cm4gYmxvY2soJ3AnLCBbeyB0ZXh0OiBsaW5lIH1dKTsKICAgICAgY29uc3QgbGV2ZWwgPSBNYXRoLmZsb29yKG1bMV0ubGVuZ3RoIC8gMik7CiAgICAgIGlmIChtWzRdKSByZXR1cm4gYmxvY2soJ2NoZWNrJywgW3sgdGV4dDogbVs1XSB9XSwgeyBsZXZlbCwgY2hlY2tlZDogbVs0XSA9PT0gVElDS0VEIH0pOwogICAgICByZXR1cm4gYmxvY2sobVszXSA_ICdvbCcgOiAndWwnLCBbeyB0ZXh0OiBtWzVdIH1dLCB7IGxldmVsIH0pOwogICAgfSkpOwogIH0KCiAgLy8g4pSA4pSAIEhUTUwgaW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IFRPS0VOX1JFID0gLzwhLS1bXHNcU10qPy0tPnw8IVxbQ0RBVEFcW1tcc1xTXSo_XF1cXT58PCFbXj5dKj58PFw_W14-XSo-fDwoXC8_KShbYS16QS1aXVthLXpBLVowLTk6LV0qKSgoPzpccytbXlxzIic-Lz1dKyg_OlxzKj1ccyooPzoiW14iXSoifCdbXiddKid8W15ccyInPTw-YF0rKSk_KSopXHMqKFwvPyk-fFtePF0rfDwvZzsKICBjb25zdCBBVFRSX1JFID0gLyhbXlxzIic-Lz1dKykoPzpccyo9XH",
"MqKD86IihbXiJdKikifCcoW14nXSopJ3woW15ccyInPTw-YF0rKSkpPy9nOwogIGNvbnN0IFNLSVAgPSBuZXcgU2V0KFsnc2NyaXB0JywgJ3N0eWxlJywgJ2hlYWQnLCAndGl0bGUnLCAndGVtcGxhdGUnLCAnc3ZnJywgJ21hdGgnLCAnbm9zY3JpcHQnLCAnaWZyYW1lJywgJ29iamVjdCcsICd4bWwnXSk7CiAgY29uc3QgUEFSQSA9IG5ldyBTZXQoWydwJywgJ2RpdicsICdibG9ja3F1b3RlJywgJ3ByZScsICdzZWN0aW9uJywgJ2FydGljbGUnLCAnaGVhZGVyJywgJ2Zvb3RlcicsICdtYWluJywgJ2FzaWRlJywKICAgICduYXYnLCAndGFibGUnLCAndGJvZHknLCAndGhlYWQnLCAndGZvb3QnLCAnY2VudGVyJywgJ2RsJywgJ2R0JywgJ2RkJywgJ2ZpZ3VyZScsICdmaWdjYXB0aW9uJywKICAgICdmb3JtJywgJ2ZpZWxkc2V0JywgJ2FkZHJlc3MnLCAnaHInLCAnYm9keScsICdodG1sJywgJ2NhcHRpb24nXSk7CiAgLy8gVGFncyB0aGF0IG1hcmsgdGV4dCwgYW5kIHRoZSBtYXJrcyB0aGV5IHN0YW5kIGZvci4gc3BhbiBhbmQgZm9udAogIC8vIGNhcnJ5IHRoZWlycyBpbiBhIHN0eWxlIGF0dHJpYnV0ZSwgaWYgYXQgYWxsLgogIGNvbnN0IElOTElORSA9IHsKICAgIGI6IFsnYiddLCBzdHJvbmc6IFsnYiddLCBpOiBbJ2knXSwgZW06IFsnaSddLCBjaXRlOiBbJ2knXSwgczogWydzJ10sIHN0cmlrZTogWydzJ10sIGRlbDogWydzJ10sIHNwYW46IFtdLCBmb250OiBbXSwKICB9OwogIGNvbnN0IEhFQURJTkdTID0geyBoMTogJ2",
"gxJywgaDI6ICdoMicsIGgzOiAnaDMnLCBoNDogJ2gzJywgaDU6ICdoMycsIGg2OiAnaDMnIH07CgogIGZ1bmN0aW9uIGF0dHJzT2YocykgewogICAgY29uc3Qgb3V0ID0ge307CiAgICBsZXQgbTsKICAgIEFUVFJfUkUubGFzdEluZGV4ID0gMDsKICAgIHdoaWxlICgobSA9IEFUVFJfUkUuZXhlYyhzIHx8ICcnKSkpIHsKICAgICAgb3V0W21bMV0udG9Mb3dlckNhc2UoKV0gPSB1dGlsLmRlY29kZUVudGl0aWVzKG1bMl0gIT09IHVuZGVmaW5lZCA_IG1bMl0gOiBtWzNdICE9PSB1bmRlZmluZWQgPyBtWzNdIDogbVs0XSB8fCAnJyk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gQm9sZCwgaXRhbGljIGFuZCBzdHJpa2UtdGhyb3VnaCB3cml0dGVuIGFzIGlubGluZSBzdHlsZXMsIGFzIE91dGxvb2sKICAvLyBhbmQgcGFzdGVkIHdlYiB0ZXh0IG9mdGVuIGRvLCBjb3VudCB0aGUgc2FtZSBhcyB0aGUgdGFncy4KICBmdW5jdGlvbiBzdHlsZU1hcmtzKHN0eWxlKSB7CiAgICBjb25zdCBzID0gU3RyaW5nKHN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgbWFya3MgPSBbXTsKICAgIGlmICgvZm9udC13ZWlnaHRccyo6XHMqKGJvbGR8Ym9sZGVyfFs2LTldMDApLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdiJyk7CiAgICBpZiAoL2ZvbnQtc3R5bGVccyo6XHMqaXRhbGljLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdpJyk7CiAgICBpZiAoL3RleHQtZGVjb3JhdGlvbigtbGluZSk_XHMqOlteO10qbGluZS",
"10aHJvdWdoLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdzJyk7CiAgICByZXR1cm4gbWFya3M7CiAgfQoKICAvLyBXaGV0aGVyIGEgYnJvd3NlciB3b3VsZCBzaG93IHNwYWNlIGJlbG93IGEgPHA-OiBpdCBkb2VzIHVubGVzcyBpdHMKICAvLyBzdHlsZSBzYXlzIG90aGVyd2lzZS4gV29yZCBhbmQgT3V0bG9vayBwYXJhZ3JhcGhzIChNc29Ob3JtYWwpIGFyZQogIC8vIGxpbmVzLCBhbmQgc28gYXJlIHRoZSBlZGl0b3IncyBvd24gYW5kIEdvb2dsZSBEb2NzJy4KICBmdW5jdGlvbiBwYXJhR2FwKGEpIHsKICAgIGlmICgvXGJNc28vLnRlc3QoYS5jbGFzcyB8fCAnJykpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IHN0eWxlID0gU3RyaW5nKGEuc3R5bGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCB6ZXJvID0gdiA9PiAvXi0_MChcLjArKT8oW2Etel0rfCUpPyQvLnRlc3QodiB8fCAnJyk7CiAgICBjb25zdCBib3R0b20gPSAvKD86Xnw7KVxzKm1hcmdpbi1ib3R0b21ccyo6XHMqKFteOyFdKykvLmV4ZWMoc3R5bGUpOwogICAgaWYgKGJvdHRvbSkgcmV0dXJuICF6ZXJvKGJvdHRvbVsxXS50cmltKCkpOwogICAgY29uc3QgYWxsID0gLyg_Ol58OylccyptYXJnaW5ccyo6XHMqKFteOyFdKykvLmV4ZWMoc3R5bGUpOwogICAgaWYgKGFsbCkgewogICAgICBjb25zdCB2ID0gYWxsWzFdLnRyaW0oKS5zcGxpdCgvXHMrLyk7CiAgICAgIHJldHVybiAhemVybyh2Lmxlbmd0aCA-PSAzID8gdlsyXSA6IHZbMF0pOwogICAgfQ",
"ogICAgcmV0dXJuIHRydWU7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUh0bWwoaHRtbCkgewogICAgY29uc3QgYmxvY2tzID0gW107CiAgICBjb25zdCBsaXN0cyA9IFtdOyAgICAgICAgIC8vIG9wZW4gbGlzdHM6IHsgdHlwZSwgbGlPcGVuIH0KICAgIGNvbnN0IG1hcmtzID0geyBiOiAwLCBpOiAwLCBzOiAwIH07CiAgICBjb25zdCBocmVmcyA9IFtdOwogICAgY29uc3QgaW5saW5lID0gW107ICAgICAgICAvLyBvcGVuIGlubGluZSB0YWdzOiB7IG5hbWUsIG1hcmtzIH0gb3IgeyBuYW1lLCBnbHlwaDogdHJ1ZSB9CiAgICBsZXQgc2tpcCA9IDA7CiAgICBsZXQgZ2x5cGggPSAwOwogICAgbGV0IGN1ciA9IG51bGw7CiAgICBsZXQgcm93ID0gbnVsbDsgICAgICAgICAgIC8vIGFuIG9wZW4gdGFibGUgcm93OiB7IGNlbGxzLCB0aCB9CiAgICBsZXQgcHJlID0gMDsgICAgICAgICAgICAgIC8vIGluc2lkZSA8cHJlPjogbGluZSBicmVha3MgYW5kIHNwYWNlcyBhcmUgdGV4dAogICAgbGV0IHBhcmEgPSBudWxsOyAgICAgICAgICAvLyB0aGUgb3BlbiA8cD46IHsgZ2FwIH0KICAgIGxldCBnYXAgPSBmYWxzZTsgICAgICAgICAgLy8gYSA8cD4ganVzdCBjbG9zZWQgd2l0aCBzcGFjZSBiZWxvdyBpdAogICAgbGV0IG91cnMgPSBmYWxzZTsgICAgICAgICAvLyBpbnNpZGUgYSBub3RlJ3Mgb3duIEhUTUwsIHdoZXJlIHBhcmFncmFwaHMgYXJlIGxpbmVzCgogICAgY29uc3QgbGV2ZWwgPSAoKSA9PiBNYXRoLm1heCgwLCBsaXN0cy5sZW",
"5ndGggLSAxKTsKICAgIGNvbnN0IG9wZW4gPSAodHlwZSwgZXh0cmEpID0-IHsKICAgICAgLy8gVGhlIHNwYWNlIGEgYnJvd3NlciBzaG93cyBhZnRlciBhIHBhcmFncmFwaCBpcyBhbiBlbXB0eSBsaW5lIGluIGEKICAgICAgLy8gbm90ZSAtIHdoaWNoIGhhcyBubyBzcGFjZSBiZXR3ZWVuIHBhcmFncmFwaHMgLSBleGNlcHQgYmVmb3JlIGEKICAgICAgLy8gaGVhZGluZywgd2hpY2ggaGFzIGl0cyBvd24uCiAgICAgIGlmIChnYXApIHsKICAgICAgICBnYXAgPSBmYWxzZTsKICAgICAgICBjb25zdCBsYXN0ID0gYmxvY2tzW2Jsb2Nrcy5sZW5ndGggLSAxXTsKICAgICAgICBpZiAobGFzdCAmJiAhSEVBRElOR1NbdHlwZV0gJiYgbGFzdC5ydW5zLnNvbWUociA9PiAvXFMvLnRlc3Qoci50ZXh0KSkpIGJsb2Nrcy5wdXNoKGJsb2NrKCdwJykpOwogICAgICB9CiAgICAgIGN1ciA9IGJsb2NrKHR5cGUsIFtdLCBleHRyYSk7CiAgICAgIGJsb2Nrcy5wdXNoKGN1cik7CiAgICAgIHJldHVybiBjdXI7CiAgICB9OwogICAgY29uc3QgZW5kID0gKCkgPT4geyBjdXIgPSBudWxsOyB9OwogICAgLy8gV2hlcmUgdGV4dCBsYW5kcyB3aGVuIG5vIGJsb2NrIGlzIG9wZW46IGluc2lkZSBhIGxpc3QgaXRlbSwgYQogICAgLy8gY29udGludWF0aW9uIG9mIHRoYXQgaXRlbTsgb3RoZXJ3aXNlIGEgbmV3IHBhcmFncmFwaC4KICAgIGNvbnN0IGNvbnRleHQgPSAoKSA9PiB7CiAgICAgIGNvbnN0IHRvcCA9IGxpc3RzW2xpc3RzLmxlbmd0aCAtID",
"FdOwogICAgICBpZiAodG9wICYmIHRvcC5saU9wZW4pIHJldHVybiBvcGVuKHRvcC50eXBlLCB7IGxldmVsOiBsZXZlbCgpLCBjaGVja2VkOiBmYWxzZSB9KTsKICAgICAgcmV0dXJuIG9wZW4oJ3AnKTsKICAgIH07CiAgICBjb25zdCBhcHBseSA9IChsaXN0LCBkZWx0YSkgPT4gbGlzdC5mb3JFYWNoKG0gPT4geyBtYXJrc1ttXSArPSBkZWx0YTsgfSk7CgogICAgbGV0IG07CiAgICBUT0tFTl9SRS5sYXN0SW5kZXggPSAwOwogICAgd2hpbGUgKChtID0gVE9LRU5fUkUuZXhlYyhTdHJpbmcoaHRtbCB8fCAnJykpKSkgewogICAgICBjb25zdCBbd2hvbGUsIGNsb3NpbmcsIHJhd05hbWUsIHJhd0F0dHJzLCBzZWxmQ2xvc2luZ10gPSBtOwogICAgICBpZiAocmF3TmFtZSA9PT0gdW5kZWZpbmVkKSB7CiAgICAgICAgaWYgKHdob2xlWzBdID09PSAnPCcgJiYgd2hvbGUubGVuZ3RoID4gMSkgY29udGludWU7IC8vIGNvbW1lbnQsIGRvY3R5cGUsIENEQVRBCiAgICAgICAgaWYgKHNraXApIGNvbnRpbnVlOwogICAgICAgIGlmIChnbHlwaCkgewogICAgICAgICAgLy8gV29yZCdzIGxpc3QgbWFya2VyICgiwrciLCAiMS4iLCAiYSkiKTogbm90IHRleHQsIGJ1dCBpdCBzYXlzCiAgICAgICAgICAvLyB3aGV0aGVyIHRoZSBsaXN0IGlzIGJ1bGxldGVkIG9yIG51bWJlcmVkLgogICAgICAgICAgaWYgKGN1ciAmJiBjdXIud29yZExpc3QpIGN1ci5tYXJrZXIgKz0gdXRpbC5kZWNvZGVFbnRpdGllcyh3aG9sZSk7CiAgICAgICAgICBjb2",
"50aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKHByZSkgewogICAgICAgICAgLy8gRWFjaCBsaW5lIG9mIHByZWZvcm1hdHRlZCB0ZXh0IGlzIGEgbGluZSBvZiB0aGUgbm90ZSwgaXRzCiAgICAgICAgICAvLyBzcGFjZXMga2VwdCAoYXMgJm5ic3A7LCB3aGljaCB0aGUgdGlkeWluZyBiZWxvdyBsZWF2ZXMgYWxvbmUpLgogICAgICAgICAgbGV0IHJhdyA9IHV0aWwuZGVjb2RlRW50aXRpZXMod2hvbGUpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpOwogICAgICAgICAgaWYgKHByZS5mcmVzaCkgcmF3ID0gcmF3LnJlcGxhY2UoL15cbi8sICcnKTsKICAgICAgICAgIHByZS5mcmVzaCA9IGZhbHNlOwogICAgICAgICAgcmF3LnNwbGl0KCdcbicpLmZvckVhY2goKGxpbmUsIGspID0-IHsKICAgICAgICAgICAgaWYgKGspIHsKICAgICAgICAgICAgICBlbmQoKTsKICAgICAgICAgICAgICBvcGVuKCdwJykucHJlTGluZSA9IHRydWU7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgaWYgKCFsaW5lKSByZXR1cm47CiAgICAgICAgICAgIGlmICghY3VyKSBjb250ZXh0KCk7CiAgICAgICAgICAgIGN1ci5ydW5zLnB1c2goewogICAgICAgICAgICAgIHRleHQ6IGxpbmUucmVwbGFjZSgvXHQvZywgJyAgICAnKS5yZXBsYWNlKC8gL2csICdcdTAwYTAnKSwKICAgICAgICAgICAgICBiOiBtYXJrcy5iID4gMCwgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLAogICAgICAgICAgICAgIGhyZWY6IGhyZWZzLmxlbmd0aCA_IGhyZW",
"ZzW2hyZWZzLmxlbmd0aCAtIDFdIDogJycsCiAgICAgICAgICAgIH0pOwogICAgICAgICAgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3QgdGV4dCA9IHV0aWwuZGVjb2RlRW50aXRpZXMod2hvbGUgPT09ICc8JyA_ICc8JyA6IHdob2xlKS5yZXBsYWNlKC9bIFx0XHJcblxmXSsvZywgJyAnKTsKICAgICAgICBpZiAoIWN1cikgewogICAgICAgICAgLy8gT25seSBIVE1MJ3Mgb3duIHdoaXRlc3BhY2UgaXMgbm90aGluZzsgYW4gJm5ic3A7IGlzIGEgc3BhY2Ugc29tZW9uZSB0eXBlZC4KICAgICAgICAgIGlmICghL1teIFx0XHJcblxmXS8udGVzdCh0ZXh0KSkgY29udGludWU7CiAgICAgICAgICBjb250ZXh0KCk7CiAgICAgICAgfQogICAgICAgIGN1ci5ydW5zLnB1c2goewogICAgICAgICAgdGV4dCwKICAgICAgICAgIGI6IG1hcmtzLmIgPiAwLCBpOiBtYXJrcy5pID4gMCwgczogbWFya3MucyA-IDAsCiAgICAgICAgICBocmVmOiBocmVmcy5sZW5ndGggPyBocmVmc1tocmVmcy5sZW5ndGggLSAxXSA6ICcnLAogICAgICAgIH0pOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CgogICAgICBjb25zdCBuYW1lID0gcmF3TmFtZS50b0xvd2VyQ2FzZSgpOwogICAgICBjb25zdCBpc0Nsb3NlID0gY2xvc2luZyA9PT0gJy8nOwogICAgICBpZiAoU0tJUC5oYXMobmFtZSkpIHsKICAgICAgICBpZiAoIXNlbGZDbG9zaW5nKSBza2lwID0gTWF0aC5tYXgoMCwgc2tpcCArIChpc0Nsb3NlID8gLT",
"EgOiAxKSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKHNraXApIGNvbnRpbnVlOwogICAgICBjb25zdCBhID0gaXNDbG9zZSA_IHt9IDogYXR0cnNPZihyYXdBdHRycyk7CgogICAgICBpZiAobmFtZSA9PT0gJ2JyJykgewogICAgICAgIGlmIChjdXIpIGVuZCgpOwogICAgICAgIGVsc2UgeyBjb250ZXh0KCk7IGVuZCgpOyB9CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKEhFQURJTkdTW25hbWVdKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSBvcGVuKEhFQURJTkdTW25hbWVdKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3VsJyB8fCBuYW1lID09PSAnb2wnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UpIGxpc3RzLnBvcCgpOwogICAgICAgIGVsc2UgbGlzdHMucHVzaCh7IHR5cGU6IGFbJ2RhdGEtY2hlY2snXSA_ICdjaGVjaycgOiBuYW1lLCBsaU9wZW46IGZhbHNlIH0pOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnbGknKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFsaXN0cy5sZW5ndGgpIGxpc3RzLnB1c2goeyB0eXBlOiAndWwnLCBsaU9wZW46IGZhbHNlLCBpbXBsaWVkOiB0cnVlIH0pOwogICAgICAgIGNvbnN0IHRvcCA9IGxpc3RzW2xpc3RzLmxlbmd0aCAtIDFdOwogICAgICAgIHRvcC5saU9wZW4gPSAhaXNDbG9zZTsKICAgICAgIC",
"BpZiAoIWlzQ2xvc2UpIHsKICAgICAgICAgIG9wZW4odG9wLnR5cGUsIHsgbGV2ZWw6IGxldmVsKCksIGNoZWNrZWQ6IGFbJ2RhdGEtY2hlY2tlZCddID09PSAnMScgfSk7CiAgICAgICAgICAvLyBPbmUgb2Ygb3VyczogaXRzIGJveCBpcyBpbiB0aGUgYXR0cmlidXRlLCBhbmQgYSDimJAgYXQgdGhlIHN0YXJ0CiAgICAgICAgICAvLyBvZiBpdHMgdGV4dCBpcyB0ZXh0LgogICAgICAgICAgaWYgKGFbJ2RhdGEtY2hlY2tlZCddICE9PSB1bmRlZmluZWQpIGN1ci5vdXJzID0gdHJ1ZTsKICAgICAgICAgIC8vIEEgY2hlY2tsaXN0IGl0ZW0gbWFya2VkIHVwIGZvciBzY3JlZW4gcmVhZGVycyAoR29vZ2xlIERvY3MpLgogICAgICAgICAgZWxzZSBpZiAoYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJyB8fCBhWydhcmlhLWNoZWNrZWQnXSA9PT0gJ2ZhbHNlJykgewogICAgICAgICAgICBjdXIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICAgIGN1ci5jaGVja2VkID0gYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJzsKICAgICAgICAgICAgY3VyLm91cnMgPSB0cnVlOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgICBlbHNlIGlmICh0b3AuaW1wbGllZCkgbGlzdHMucG9wKCk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQSB0YWJsZSByb3cgaXMgb25lIGxpbmUsIGl0cyBjZWxscyBzZXBhcmF0ZWQgYnkgIiB8ICI6IHRoZXJlIGFyZQogICAgICAvLyBubyB0YWJsZXMgaW4gYSBub3RlLCBhbmQgdG",
"hpcyBrZWVwcyBhIHBhc3RlZCByb3cgcmVhZGFibGUuCiAgICAgIC8vIEEgaGVhZGluZyBjZWxsIGlzIGJvbGQsIGFzIGEgYnJvd3NlciBzaG93cyBpdC4KICAgICAgY29uc3QgaGVhZENlbGwgPSBvbiA9PiB7CiAgICAgICAgaWYgKCFyb3cgfHwgcm93LnRoID09PSBvbikgcmV0dXJuOwogICAgICAgIHJvdy50aCA9IG9uOwogICAgICAgIG1hcmtzLmIgKz0gb24gPyAxIDogLTE7CiAgICAgIH07CiAgICAgIGlmIChuYW1lID09PSAndHInKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaGVhZENlbGwoZmFsc2UpOwogICAgICAgIHJvdyA9IGlzQ2xvc2UgPyBudWxsIDogeyBjZWxsczogMCwgdGg6IGZhbHNlIH07CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKG5hbWUgPT09ICd0ZCcgfHwgbmFtZSA9PT0gJ3RoJykgewogICAgICAgIGlmICghcm93KSB7IGVuZCgpOyBjb250aW51ZTsgfQogICAgICAgIGhlYWRDZWxsKGZhbHNlKTsKICAgICAgICBpZiAoIWlzQ2xvc2UgJiYgIXNlbGZDbG9zaW5nKSB7CiAgICAgICAgICBpZiAocm93LmNlbGxzID4gMCkgewogICAgICAgICAgICBpZiAoIWN1cikgY29udGV4dCgpOwogICAgICAgICAgICBjdXIucnVucy5wdXNoKHsgdGV4dDogJyB8ICcsIGI6IGZhbHNlLCBpOiBmYWxzZSwgczogZmFsc2UsIGhyZWY6ICcnIH0pOwogICAgICAgICAgfQogICAgICAgICAgcm93LmNlbGxzKys7CiAgICAgICAgICBoZWFkQ2VsbChuYW1lID09PSAndGgnKTsKICAgICAgICB9Ci",
"AgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKG5hbWUgPT09ICdwcmUnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UpIHsKICAgICAgICAgIC8vIFRoZSBsaW5lIGJyZWFrIGJlZm9yZSA8L3ByZT4gZW5kcyB0aGUgbGFzdCBsaW5lOyBpdCBpcyBub3Qgb25lIG1vcmUuCiAgICAgICAgICBjb25zdCBsYXN0ID0gYmxvY2tzW2Jsb2Nrcy5sZW5ndGggLSAxXTsKICAgICAgICAgIGlmIChsYXN0ICYmIGxhc3QucHJlTGluZSAmJiAhbGFzdC5ydW5zLmxlbmd0aCkgYmxvY2tzLnBvcCgpOwogICAgICAgICAgcHJlID0gMDsKICAgICAgICB9IGVsc2UgaWYgKCFzZWxmQ2xvc2luZykgewogICAgICAgICAgcHJlID0geyBmcmVzaDogdHJ1ZSB9OwogICAgICAgIH0KICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICAvLyBBIHRpY2tlZCBvciBlbXB0eSBib3ggYXQgdGhlIHN0YXJ0IG9mIGEgbGluZSAtIGEgdGFzayBsaXN0IG9uIGEKICAgICAgLy8gd2ViIHBhZ2UgKEdpdEh1YikgLSBtYWtlcyBpdCBhIGNoZWNrbGlzdCBpdGVtLgogICAgICBpZiAobmFtZSA9PT0gJ2lucHV0JyAmJiBTdHJpbmcoYS50eXBlIHx8ICcnKS50b0xvd2VyQ2FzZSgpID09PSAnY2hlY2tib3gnKSB7CiAgICAgICAgaWYgKCFjdXIpIGNvbnRleHQoKTsKICAgICAgICBpZiAoIWN1ci5ydW5zLnNvbWUociA9PiAvXFMvLnRlc3Qoci50ZXh0KSkpIHsKICAgICAgICAgIGN1ci50eXBlID0gJ2NoZWNrJzsKICAgICAgIC",
"AgIGN1ci5jaGVja2VkID0gJ2NoZWNrZWQnIGluIGE7CiAgICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiBhWydkYXRhLWdrYi1ub3RlJ10gIT09IHVuZGVmaW5lZCkgb3VycyA9IHRydWU7CiAgICAgIC8vIEEgYmxvY2sgY29waWVkIG91dCBvZiBhIG5vdGUncyBlZGl0b3Iga2VlcHMgaXRzIGtpbmQuCiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiAhaXNDbG9zZSAmJiBUWVBFUy5oYXMoYVsnZGF0YS10eXBlJ10pKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgb3BlbihhWydkYXRhLXR5cGUnXSwgeyBsZXZlbDogTnVtYmVyKGFbJ2RhdGEtbGV2ZWwnXSkgfHwgMCwgY2hlY2tlZDogYVsnZGF0YS1jaGVja2VkJ10gPT09ICcxJyB9KTsKICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gV29yZCB3cml0ZXMgYSBsaXN0IGFzIHBhcmFncmFwaHMgc3R5bGVkICJtc28tbGlzdDogbDAgbGV2ZWwxIi4KICAgICAgaWYgKG5hbWUgPT09ICdwJyAmJiAhaXNDbG9zZSkgewogICAgICAgIGNvbnN0IHdsID0gL21zby1saXN0XHMqOlxzKmxcZCtccytsZXZlbChcZCkvaS5leGVjKGEuc3R5bGUgfHwgJycpOwogICAgICAgIGlmICh3bCkgewogICAgICAgICAgZW5kKCk7CiAgICAgICAgICBvcGVuKCd1bCcsIHsgbGV2ZWw6IE51bWJlcih3bFsxXSkgLSAxIH0pOwogIC",
"AgICAgICAgY3VyLndvcmRMaXN0ID0gdHJ1ZTsKICAgICAgICAgIGN1ci5tYXJrZXIgPSAnJzsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3AnKSB7CiAgICAgICAgaWYgKHBhcmEgJiYgcGFyYS5nYXApIGdhcCA9IHRydWU7CiAgICAgICAgcGFyYSA9IG51bGw7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSB7CiAgICAgICAgICBjb25zdCB0b3AgPSBsaXN0c1tsaXN0cy5sZW5ndGggLSAxXTsKICAgICAgICAgIHBhcmEgPSB7IGdhcDogIW91cnMgJiYgIXJvdyAmJiAhKHRvcCAmJiB0b3AubGlPcGVuKSAmJiBwYXJhR2FwKGEpIH07CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChQQVJBLmhhcyhuYW1lKSkgewogICAgICAgIC8vIEluc2lkZSBhIHRhYmxlIGNlbGwsIG9yIHN0cmFpZ2h0IGluc2lkZSBhIGxpc3QgaXRlbSB0aGF0IGhhcyBubwogICAgICAgIC8vIHRleHQgeWV0IChHb29nbGUgRG9jcyB3cmFwcyBldmVyeSBpdGVtIGluIGEgPHA-KSwgdGhlIGxpbmUgZ29lcyBvbi4KICAgICAgICBpZiAocm93KSBjb250aW51ZTsKICAgICAgICBpZiAoY3VyICYmICFjdXIucnVucy5sZW5ndGggJiYgIWlzQ2xvc2UpIGNvbnRpbnVlOwogICAgICAgIGVuZCgpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnYScpIHsKICAgICAgICBpZiAoaXNDbG9zZSkgaHJlZnMucG9wKCk7CiAgICAgICAgZWxzZSBpZiAoIXNlbGZDbG9zaW5nKS",
"BocmVmcy5wdXNoKHNhZmVIcmVmKGEuaHJlZikpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChJTkxJTkVbbmFtZV0pIHsKICAgICAgICBpZiAoc2VsZkNsb3NpbmcpIGNvbnRpbnVlOwogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgICAvLyBUaGUgaW5uZXJtb3N0IG9wZW4gdGFnIG9mIHRoYXQgbmFtZSAtIG1haWwgaXMgbm90IGFsd2F5cyB0aWRpbHkgbmVzdGVkLgogICAgICAgICAgZm9yIChsZXQgayA9IGlubGluZS5sZW5ndGggLSAxOyBrID49IDA7IGstLSkgewogICAgICAgICAgICBpZiAoaW5saW5lW2tdLm5hbWUgIT09IG5hbWUpIGNvbnRpbnVlOwogICAgICAgICAgICBjb25zdCBbZ290XSA9IGlubGluZS5zcGxpY2UoaywgMSk7CiAgICAgICAgICAgIGlmIChnb3QuZ2x5cGgpIGdseXBoID0gTWF0aC5tYXgoMCwgZ2x5cGggLSAxKTsKICAgICAgICAgICAgZWxzZSBhcHBseShnb3QubWFya3MsIC0xKTsKICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICB9CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3Qgc3R5bGUgPSBTdHJpbmcoYS5zdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAoYVsnZGF0YS1nbHlwaCddIHx8IC9tc28tbGlzdFxzKjpccyppZ25vcmUvLnRlc3Qoc3R5bGUpKSB7CiAgICAgICAgICBpbmxpbmUucHVzaCh7IG5hbWUsIGdseXBoOiB0cnVlIH0pOwogICAgICAgICAgZ2x5cGgrKzsKICAgICAgICAgIGNvbnRpbn",
"VlOwogICAgICAgIH0KICAgICAgICBsZXQgZ290ID0gWy4uLklOTElORVtuYW1lXSwgLi4uc3R5bGVNYXJrcyhzdHlsZSldOwogICAgICAgIC8vIEdvb2dsZSBEb2NzIHdyYXBzIGEgd2hvbGUgcGFzdGUgaW4gPGIgc3R5bGU9ImZvbnQtd2VpZ2h0Om5vcm1hbCI-LgogICAgICAgIGlmICgvZm9udC13ZWlnaHRccyo6XHMqKG5vcm1hbHxsaWdodGVyfFsxLTVdMDApXGIvLnRlc3Qoc3R5bGUpKSBnb3QgPSBnb3QuZmlsdGVyKHggPT4geCAhPT0gJ2InKTsKICAgICAgICBpZiAoL2ZvbnQtc3R5bGVccyo6XHMqbm9ybWFsLy50ZXN0KHN0eWxlKSkgZ290ID0gZ290LmZpbHRlcih4ID0-IHggIT09ICdpJyk7CiAgICAgICAgZ290ID0gWy4uLm5ldyBTZXQoZ290KV07CiAgICAgICAgaW5saW5lLnB1c2goeyBuYW1lLCBtYXJrczogZ290IH0pOwogICAgICAgIGFwcGx5KGdvdCwgMSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQW55dGhpbmcgZWxzZSAoaW1nLCB1LCBzdXAsIGNvZGUsIOKApik6IGl0cyB0ZXh0IGlzIGtlcHQsIHRoZSB0YWcgaXMgbm90LgogICAgfQogICAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKG1hcmtzKSkgbWFya3Nba10gPSBNYXRoLm1heCgwLCBtYXJrc1trXSk7CgogICAgLy8gVGlkeSBlYWNoIGJsb2NrOiBjb2xsYXBzZSB0aGUgd2hpdGVzcGFjZSBIVE1MIHdvdWxkIGNvbGxhcHNlLCB0aGVuCiAgICAvLyB0dXJuIHRoZSAmbmJzcDtzIHRoYXQgaGVsZCBkZWxpYmVyYXRlIH",
"NwYWNlcyBiYWNrIGludG8gc3BhY2VzLgogICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICBjb25zdCBydW5zID0gYi5ydW5zOwogICAgICBpZiAocnVucy5sZW5ndGgpIHsKICAgICAgICBydW5zWzBdLnRleHQgPSBydW5zWzBdLnRleHQucmVwbGFjZSgvXiArLywgJycpOwogICAgICAgIHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0ID0gcnVuc1tydW5zLmxlbmd0aCAtIDFdLnRleHQucmVwbGFjZSgvICskLywgJycpOwogICAgICAgIGZvciAobGV0IGkgPSAxOyBpIDwgcnVucy5sZW5ndGg7IGkrKykgewogICAgICAgICAgaWYgKC8gJC8udGVzdChydW5zW2kgLSAxXS50ZXh0KSkgcnVuc1tpXS50ZXh0ID0gcnVuc1tpXS50ZXh0LnJlcGxhY2UoL14gKy8sICcnKTsKICAgICAgICB9CiAgICAgICAgZm9yIChjb25zdCByIG9mIHJ1bnMpIHIudGV4dCA9IHIudGV4dC5yZXBsYWNlKC_CoC9nLCAnICcpOwogICAgICB9CiAgICAgIGlmIChiLndvcmRMaXN0ICYmIC9eXHMqKFxkK3xbYS16XXxbaXZ4bGNdKylbLildXHMqJC9pLnRlc3QoYi5tYXJrZXIgfHwgJycpKSBiLnR5cGUgPSAnb2wnOwogICAgICAvLyBBIGNoZWNrIGJveCBkcmF3biBhcyB0ZXh0IChtYWlsIGZyb20gZWxzZXdoZXJlLCBvciBhIGxpc3Qgd2hvc2UKICAgICAgLy8gbWFya2VycyB3ZXJlIGxvc3QpIHN0aWxsIGNvdW50cyBhcyBhIGNoZWNrIGJveC4KICAgICAgaWYgKExJU1RTLmhhcyhiLnR5cGUpICYmIHJ1bnMubGVuZ3RoICYmICFiLm91cn",
"MpIHsKICAgICAgICBjb25zdCBnID0gL14oW-KYkOKYkV0pID8vLmV4ZWMocnVuc1swXS50ZXh0KTsKICAgICAgICBpZiAoZykgewogICAgICAgICAgcnVuc1swXS50ZXh0ID0gcnVuc1swXS50ZXh0LnNsaWNlKGdbMF0ubGVuZ3RoKTsKICAgICAgICAgIGlmIChiLnR5cGUgPT09ICd1bCcpIGIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICBpZiAoYi50eXBlID09PSAnY2hlY2snKSBiLmNoZWNrZWQgPSBnWzFdID09PSBUSUNLRUQ7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICByZXR1cm4gbm9ybWFsaXNlRG9jKGJsb2Nrcyk7CiAgfQoKICAvLyDilIDilIAgTWFya2Rvd24gaW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUZXh0IGNvcGllZCBmcm9tIGEgY2hhdCBhc3Npc3RhbnQsIGEgUkVBRE1FIG9yIGEgTWFya2Rvd24gZWRpdG9yCiAgLy8gYXJyaXZlcyBhcyBwbGFpbiB0ZXh0IGZ1bGwgb2YgKipzdGFycyoqIGFuZCAiLSAiIGxpbmVzLiBUaGUgY29tbW9uCiAgLy8gcGFydCBvZiBNYXJrZG93biBiZWNvbWVzIGZvcm1hdHRpbmc7IHRoZSByZXN0IHN0YXlzIGFzIHR5cGVkLgoKICBmdW5jdGlvbiBtZElubGluZShzcmMsIG1hcmtzID0ge30pIHsKIC",
"AgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgcyA9IFN0cmluZyhzcmMgfHwgJycpOwogICAgbGV0IGJ1ZiA9ICcnOwogICAgY29uc3QgZmx1c2ggPSAoKSA9PiB7CiAgICAgIGlmIChidWYpIG91dC5wdXNoKHsgdGV4dDogYnVmLCAuLi5tYXJrcyB9KTsKICAgICAgYnVmID0gJyc7CiAgICB9OwogICAgY29uc3QgbmVzdGVkID0gKGlubmVyLCBleHRyYSkgPT4gewogICAgICBmbHVzaCgpOwogICAgICBvdXQucHVzaCguLi5tZElubGluZShpbm5lciwgeyAuLi5tYXJrcywgLi4uZXh0cmEgfSkpOwogICAgfTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IHJlc3QgPSBzLnNsaWNlKGkpOwogICAgICBjb25zdCBwcmV2ID0gaSA_IHNbaSAtIDFdIDogJyc7CiAgICAgIGxldCBtOwogICAgICBpZiAoKG0gPSAvXlxcKFtcXGAqX3t9W1xdKCkjK1wtLiF-fD5dKS8uZXhlYyhyZXN0KSkpIHsgYnVmICs9IG1bMV07IGkgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICgobSA9IC9eYChbXmBcbl0rKWAvLmV4ZWMocmVzdCkpKSB7IGJ1ZiArPSBtWzFdOyBpICs9IG1bMF0ubGVuZ3RoOyBjb250aW51ZTsgfQogICAgICBpZiAoKG0gPSAvXlxbKFteXF1cbl0rKVxdXChccyo8PyhbXilccz5dKyk-Pyg_OlxzKyJbXiJdKiIpP1xzKlwpLy5leGVjKHJlc3QpKSkgewogICAgICAgIGNvbnN0IGhyZWYgPSBzYWZlSHJlZihtWzJdKTsKICAgICAgICBuZXN0ZWQobVsxXSwgaHJlZi",
"A_IHsgaHJlZiB9IDoge30pOwogICAgICAgIGkgKz0gbVswXS5sZW5ndGg7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKChtID0gL148KCg_Omh0dHBzPzpcL1wvfG1haWx0bzopW14-XHNdKyk-Ly5leGVjKHJlc3QpKSkgewogICAgICAgIGZsdXNoKCk7CiAgICAgICAgY29uc3QgaHJlZiA9IHNhZmVIcmVmKG1bMV0pOwogICAgICAgIG91dC5wdXNoKHsgdGV4dDogbVsxXS5yZXBsYWNlKC9ebWFpbHRvOi8sICcnKSwgLi4ubWFya3MsIC4uLihocmVmID8geyBocmVmIH0gOiB7fSkgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoKG0gPSAvXihcKlwqfF9fKSg_PVxTKShbXHNcU10qP1xTKVwxLy5leGVjKHJlc3QpKSAmJiAhKG1bMV0gPT09ICdfXycgJiYgL1tccHtMfVxwe059XS91LnRlc3QocHJldikpKSB7CiAgICAgICAgbmVzdGVkKG1bMl0sIHsgYjogdHJ1ZSB9KTsKICAgICAgICBpICs9IG1bMF0ubGVuZ3RoOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICgobSA9IC9efn4oPz1cUykoW1xzXFNdKj9cUyl-fi8uZXhlYyhyZXN0KSkpIHsgbmVzdGVkKG1bMV0sIHsgczogdHJ1ZSB9KTsgaSArPSBtWzBdLmxlbmd0aDsgY29udGludWU7IH0KICAgICAgaWYgKChtID0gL15cKig_PVteXHMqXSkoW1xzXFNdKj9bXlxzKl0pXCooPyFcKikvLmV4ZWMocmVzdCkpKSB7IG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7IG",
"kgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICghL1tccHtMfVxwe059X10vdS50ZXN0KHByZXYpICYmIChtID0gL15fKD89W15cc19dKShbXHNcU10qP1teXHNfXSlfKD8hW1xwe0x9XHB7Tn1fXSkvdS5leGVjKHJlc3QpKSkgewogICAgICAgIG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBidWYgKz0gc1tpXTsKICAgICAgaSsrOwogICAgfQogICAgZmx1c2goKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBPbmUgbGluZSBvZiBNYXJrZG93bjogd2hhdCBraW5kIG9mIGJsb2NrIGl0IGlzLCBpdHMgaW5kZW50IGFuZCB0ZXh0LgogIGZ1bmN0aW9uIG1kTGluZShsaW5lKSB7CiAgICBjb25zdCBbLCBwYWQsIHNdID0gL14oICopKC4qKSQvLmV4ZWMobGluZSk7CiAgICBjb25zdCBpbmRlbnQgPSBwYWQubGVuZ3RoOwogICAgbGV0IHg7CiAgICBpZiAoKHggPSAvXigjezEsNn0pXHMrKC4qPykoPzpccysjKyk_XHMqJC8uZXhlYyhzKSkpIHJldHVybiB7IHR5cGU6IFsnaDEnLCAnaDInLCAnaDMnXVtNYXRoLm1pbigyLCB4WzFdLmxlbmd0aCAtIDEpXSwgdGV4dDogeFsyXSB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzK1xbKFsgeFhdKVxdXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdICE9PSAnICcsIHRleHQ6IHhbMl0sIGluZGVudCB9Ow",
"ogICAgaWYgKCh4ID0gL14oW-KYkOKYkV0pXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdID09PSBUSUNLRUQsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzKyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3VsJywgdGV4dDogeFsxXSwgaW5kZW50IH07CiAgICBpZiAoKHggPSAvXlxkezEsM31bLildXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnb2wnLCB0ZXh0OiB4WzFdLCBpbmRlbnQgfTsKICAgIGlmICgoeCA9IC9ePlxzPyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3AnLCB0ZXh0OiB4WzFdLnJlcGxhY2UoL14oPlxzPykrLywgJycpIH07CiAgICBpZiAoL15cfC4qXHxccyokLy50ZXN0KHMpKSByZXR1cm4geyB0eXBlOiAncCcsIGNlbGxzOiBzLnRyaW0oKS5zbGljZSgxLCAtMSkuc3BsaXQoLyg_PCFcXClcfC8pLm1hcChjID0-IGMudHJpbSgpKSB9OwogICAgcmV0dXJuIHsgdHlwZTogJ3AnLCB0ZXh0OiBzIH07CiAgfQoKICBjb25zdCBNRF9SVUxFID0gL15ccyooWy0qX10pKFxzKlwxKXsyLH1ccyokLzsKICBjb25zdCBNRF9UQUJMRV9SVUxFID0gL15ccypcfD9ccyo6Py17Myx9Oj9ccyooXHxccyo6Py17Myx9Oj9ccyopK1x8P1xzKiQvOwoKICBmdW5jdGlvbiBmcm9tTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgbGluZXMgPSBTdHJpbmcodGV4dCB8fCAnJykucmVwbGFjZS",
"gvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXHQvZywgJyAgICAnKS5zcGxpdCgnXG4nKTsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgaW5kZW50cyA9IFtdOyAgIC8vIHRoZSBpbmRlbnQgb2YgZWFjaCBvcGVuIGxpc3QgbGV2ZWwKICAgIGxldCBmZW5jZSA9IGZhbHNlOwogICAgY29uc3QgbGFzdCA9ICgpID0-IG91dFtvdXQubGVuZ3RoIC0gMV07CiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHsKICAgICAgaWYgKC9eXHMqKGBgYHx-fn4pLy50ZXN0KGxpbmUpKSB7IGZlbmNlID0gIWZlbmNlOyBjb250aW51ZTsgfQogICAgICBpZiAoZmVuY2UpIHsgb3V0LnB1c2goYmxvY2soJ3AnLCBbeyB0ZXh0OiBsaW5lIH1dKSk7IGNvbnRpbnVlOyB9CiAgICAgIC8vIFRoZSB8LS0tfC0tLXwgbGluZSB1bmRlciBhIHRhYmxlJ3MgaGVhZGluZyByb3cgbWFrZXMgdGhhdCByb3cgYm9sZC4KICAgICAgaWYgKE1EX1RBQkxFX1JVTEUudGVzdChsaW5lKSkgewogICAgICAgIGNvbnN0IGhlYWQgPSBsYXN0KCk7CiAgICAgICAgaWYgKGhlYWQgJiYgaGVhZC50YWJsZSkgZm9yIChjb25zdCByIG9mIGhlYWQucnVucykgaWYgKCFyLnNlcCkgci5iID0gdHJ1ZTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoTURfUlVMRS50ZXN0KGxpbmUpKSBjb250aW51ZTsKICAgICAgLy8gT25lIGVtcHR5IGxpbmUgaXMgYSBnYXA7IG1vcmUgYXJlIG5vdCwgYW5kIG5vciBpcyBvbmUgYmVzaWRlIGEKICAgICAgLy8gaG",
"VhZGluZywgd2hpY2ggaGFzIHNwYWNlIG9mIGl0cyBvd24uCiAgICAgIGlmICghbGluZS50cmltKCkpIHsKICAgICAgICBpZiAoIW91dC5sZW5ndGggfHwgIShmbXRCbGFuayhsYXN0KCkpIHx8IEhFQURJTkdTW2xhc3QoKS50eXBlXSkpIG91dC5wdXNoKGJsb2NrKCdwJykpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IGwgPSBtZExpbmUobGluZS5yZXBsYWNlKC9ccyskLywgJycpKTsKICAgICAgaWYgKEhFQURJTkdTW2wudHlwZV0gJiYgb3V0Lmxlbmd0aCAmJiBmbXRCbGFuayhsYXN0KCkpKSBvdXQucG9wKCk7CiAgICAgIGlmIChMSVNUUy5oYXMobC50eXBlKSkgewogICAgICAgIC8vIEEgYmxhbmsgbGluZSBiZXR3ZWVuIHR3byBpdGVtcyBvZiBhIGxpc3QgaXMgbm90IGEgZ2FwIGluIGl0LgogICAgICAgIGlmIChvdXQubGVuZ3RoID4gMSAmJiBmbXRCbGFuayhsYXN0KCkpICYmIExJU1RTLmhhcyhvdXRbb3V0Lmxlbmd0aCAtIDJdLnR5cGUpKSBvdXQucG9wKCk7CiAgICAgICAgd2hpbGUgKGluZGVudHMubGVuZ3RoICYmIGwuaW5kZW50IDwgaW5kZW50c1tpbmRlbnRzLmxlbmd0aCAtIDFdKSBpbmRlbnRzLnBvcCgpOwogICAgICAgIGlmICghaW5kZW50cy5sZW5ndGggfHwgbC5pbmRlbnQgPiBpbmRlbnRzW2luZGVudHMubGVuZ3RoIC0gMV0pIGluZGVudHMucHVzaChsLmluZGVudCk7CiAgICAgICAgb3V0LnB1c2goYmxvY2sobC50eXBlLCBtZElubGluZShsLnRleHQpLCB7IGxldmVsOiBpbm",
"RlbnRzLmxlbmd0aCAtIDEsIGNoZWNrZWQ6IGwuY2hlY2tlZCB9KSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaW5kZW50cy5sZW5ndGggPSAwOwogICAgICBpZiAobC5jZWxscykgewogICAgICAgIGNvbnN0IHJ1bnMgPSBbXTsKICAgICAgICBsLmNlbGxzLmZvckVhY2goKGMsIGspID0-IHsKICAgICAgICAgIGlmIChrKSBydW5zLnB1c2goeyB0ZXh0OiAnIHwgJywgc2VwOiB0cnVlIH0pOwogICAgICAgICAgcnVucy5wdXNoKC4uLm1kSW5saW5lKGMucmVwbGFjZSgvXFxcfC9nLCAnfCcpKSk7CiAgICAgICAgfSk7CiAgICAgICAgY29uc3QgYiA9IGJsb2NrKCdwJywgcnVucyk7CiAgICAgICAgYi50YWJsZSA9IHRydWU7CiAgICAgICAgb3V0LnB1c2goYik7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgb3V0LnB1c2goYmxvY2sobC50eXBlLCBtZElubGluZShsLnRleHQudHJpbSgpKSkpOwogICAgfQogICAgd2hpbGUgKG91dC5sZW5ndGggPiAxICYmIGZtdEJsYW5rKGxhc3QoKSkpIG91dC5wb3AoKTsKICAgIHdoaWxlIChvdXQubGVuZ3RoID4gMSAmJiBmbXRCbGFuayhvdXRbMF0pKSBvdXQuc2hpZnQoKTsKICAgIHJldHVybiBub3JtYWxpc2VEb2Mob3V0KTsKICB9CgogIGNvbnN0IGZtdEJsYW5rID0gYiA9PiBiLnR5cGUgPT09ICdwJyAmJiAhYi5ydW5zLnNvbWUociA9PiByLnRleHQudHJpbSgpKTsKCiAgLy8gV2hldGhlciBwbGFpbiB0ZXh0IGlzIHdvcnRoIHJlYWRpbmcgYXMgTWFya2",
"Rvd246IGEgaGVhZGluZywgbGlzdCwKICAvLyBxdW90ZSwgdGFibGUgb3IgY29kZSBsaW5lLCBvciBib2xkLCBzdHJ1Y2ssIGxpbmtlZCBvciBjb2RlIHRleHQuCiAgZnVuY3Rpb24gbG9va3NMaWtlTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIHJldHVybiAvXiB7MCwzfSgjezEsNn1ccytcU3xbLSor4oCiXVxzK1xTfFvimJDimJFdXHMrXFN8XGR7MSwzfVsuKV1ccytcU3w-XHN8YGBgKS9tLnRlc3QocykgfHwKICAgICAgL15ccypcfD9ccyo6Py17Myx9Oj9ccyooXHxccyo6Py17Myx9Oj9ccyopK1x8P1xzKiQvbS50ZXN0KHMpIHx8CiAgICAgIC9cKlwqW14qXG5dK1wqXCp8X19bXl9cbl0rX198fn5bXn5cbl0rfn58XFtbXlxdXG5dK1xdXChbXilcc10rXCl8YFteYFxuXStgLy50ZXN0KHMpOwogIH0KCiAgLy8g4pSA4pSAIFBhc3Rpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFdoZXRoZXIgYSBkb2N1bWVudCBoYXMgYW55dGhpbmcgcGxhaW4gdGV4dCB3b3VsZCBub3Q6IGEgaGVhZGluZywgYQogIC8vIGxpc3QsIGEgbWFyayBvciBhIGxpbmsuCiAgZnVuY3Rpb24gaGFzRm9ybWF0dGluZy",
"hkb2MpIHsKICAgIHJldHVybiBkb2Muc29tZShiID0-IGIudHlwZSAhPT0gJ3AnIHx8IGIucnVucy5zb21lKHIgPT4gci5iIHx8IHIuaSB8fCByLnMgfHwgci5ocmVmKSk7CiAgfQoKICAvLyBXaGF0IGEgcGFzdGUgYmVjb21lczogdGhlIGNsaXBib2FyZCdzIEhUTUwsIHJlYWQgbGlrZSBtYWlsOyBvciwgd2hlbgogIC8vIHRoYXQgYnJpbmdzIG5vIGZvcm1hdHRpbmcgYW5kIHRoZSB0ZXh0IGlzIE1hcmtkb3duIChmcm9tIGEgY2hhdAogIC8vIGFzc2lzdGFudCwgc2F5KSwgdGhlIE1hcmtkb3duIHJlYWQgYXMgZm9ybWF0dGluZy4gRW1wdHkgbGluZXMgYXQKICAvLyBlaXRoZXIgZW5kIGdvLiBudWxsIG1lYW5zIHRoZXJlIGlzIG5vdGhpbmcgdG8gZm9ybWF0OiB0aGUgdGV4dCBpcwogIC8vIHBhc3RlZCBhcyBpdCBpcy4KICBmdW5jdGlvbiBwYXN0ZURvYyh7IGh0bWwsIHRleHQgfSA9IHt9KSB7CiAgICBsZXQgZG9jID0gaHRtbCAmJiAvXFMvLnRlc3QoaHRtbCkgPyBwYXJzZUh0bWwoaHRtbCkgOiBudWxsOwogICAgaWYgKGRvYyAmJiBpc0VtcHR5KGRvYykpIGRvYyA9IG51bGw7CiAgICBpZiAoKCFkb2MgfHwgIWhhc0Zvcm1hdHRpbmcoZG9jKSkgJiYgbG9va3NMaWtlTWFya2Rvd24odGV4dCkpIGRvYyA9IGZyb21NYXJrZG93bih0ZXh0KTsKICAgIGlmICghZG9jKSByZXR1cm4gbnVsbDsKICAgIGxldCBpID0gMDsKICAgIGxldCBqID0gZG9jLmxlbmd0aDsKICAgIHdoaWxlIChpIDwgaiAmJiBmbXRCbGFuayhkb2NbaV",
"0pKSBpKys7CiAgICB3aGlsZSAoaiA-IGkgJiYgZm10QmxhbmsoZG9jW2ogLSAxXSkpIGotLTsKICAgIHJldHVybiBpIDwgaiA_IGRvYy5zbGljZShpLCBqKSA6IG51bGw7CiAgfQoKICAvLyBUaGUgbm90ZSdzIGNvbnRlbnQgZnJvbSBpdHMgbWVzc2FnZSBwYXJ0czogSFRNTCB3aGVuIHRoZXJlIGlzIGFueSwKICAvLyB0aGUgcGxhaW4gdGV4dCBvdGhlcndpc2UuCiAgZnVuY3Rpb24gZG9jRnJvbVBhcnRzKHsgcGxhaW4sIGh0bWwgfSA9IHt9KSB7CiAgICBpZiAoaHRtbCAmJiBTdHJpbmcoaHRtbCkudHJpbSgpKSByZXR1cm4gcGFyc2VIdG1sKGh0bWwpOwogICAgcmV0dXJuIGZyb21QbGFpbihwbGFpbiB8fCAnJyk7CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBUWVBFUywgTElTVFMsIE1BWF9MRVZFTCwKICAgIGJsb2NrLCBlbXB0eURvYywgbm9ybWFsaXNlUnVucywgbm9ybWFsaXNlRG9jLCBkb2NUZXh0LCBpc0VtcHR5LCBzYWZlSHJlZiwKICAgIHRvSHRtbCwgdG9QbGFpbiwgZnJvbVBsYWluLCBwYXJzZUh0bWwsIGRvY0Zyb21QYXJ0cywgZnJvbU1hcmtkb3duLCBsb29rc0xpa2VNYXJrZG93biwgaGFzRm9ybWF0dGluZywgcGFzdGVEb2MsCiAgfTsKCiAgbnMubm90ZUZvcm1hdCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/search-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA",
"4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNlYXJjaCBoaWdobGlnaHRpbmcgKHB1cmUpCi8vCi8vIEdtYWlsIGRvZXMgdGhlIHNlYXJjaGluZzsgdGhpcyBvbmx5IHNob3dzIHdoZXJlIHRoZSB3b3JkcyBhcmUuIEl0IHRha2VzCi8vIHRoZSB3b3JkcyBvdXQgb2YgYSBHbWFpbCBxdWVyeSAtIGxlYXZpbmcgb3V0IG9wZXJhdG9ycyBzdWNoIGFzIGZyb206IG9yCi8vIGJlZm9yZTosIGFuZCBhbnl0aGluZyBleGNsdWRlZCB3aXRoIGEgbWludXMgLSBhbmQgZmluZHMgdGhlbSBpbiBhCi8vIG5vdGUncyB0ZXh0IHRoZSB3YXkgYSBwZXJzb24gd291bGQgcmVhZCBhIG1hdGNoOiBpZ25vcmluZyBjYXNlIGFuZAovLyBhY2NlbnRzICgiY2FmZSIgZmluZHMgIkNhZsOpIiksIGF0IHRoZSBzdGFydCBvZiBhIHdvcmQgKCJnbG9zcyIgZmluZHMKLy8gImdsb3NzYXJ5Iiwgbm90ICJ4Z2xvc3MiKSwgYW5kIHBocmFzZXMgaW4gcXVvdGVzIGFzIHBocmFzZXMuCi8vCi8vIEZyb20gdGhvc2UgbWF0Y2hlcyBjb21lIHRoZSBleGNlcnB0cyBzaG93biBpbiB0aGUgcmVzdWx0cyBsaXN0LCB3aXRoCi8vIHRoZWlyIG9mZnNldHMsIHNvIHRoZSBsaXN0",
"IGNhbiBtYXJrIHRoZW0gd2l0aG91dCBwYXJzaW5nIGFueSBIVE1MLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8gT3BlcmF0b3JzIHdob3NlIHZhbHVlIGlzIGEgd29yZCB0byBsb29rIGZvciBpbiB0aGUgbm90ZSBpdHNlbGYuCiAgY29uc3QgVEVYVF9PUFMgPSBuZXcgU2V0KFsnc3ViamVjdCcsICdpbnRpdGxlJ10pOwogIGNvbnN0IEtFWVdPUkRTID0gbmV3IFNldChbJ29yJywgJ2FuZCcsICdhcm91bmQnXSk7CgogIC8vIOKUgOKUgCBUaGUgd29yZHMgaW4gYSBxdWVyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmV0dXJucyBbeyB3b3JkczogWydzdGVudCcsICdjb2F0aW5nJ10gfSwg4oCmXTogb25lIGVudHJ5IHBl",
"ciB0ZXJtLCBhCiAgLy8gcGhyYXNlIGJlaW5nIHNldmVyYWwgd29yZHMgaW4gYSByb3cuCiAgZnVuY3Rpb24gcXVlcnlUZXJtcyhxdWVyeSkgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3QgYWRkID0gdGV4dCA9PiB7CiAgICAgIGNvbnN0IHdvcmRzID0gU3RyaW5nKHRleHQpLnNwbGl0KC9bXHMiKClbXF17fTw-XSsvKS5tYXAodyA9PiB3LnJlcGxhY2UoL15bXlxwe0x9XHB7Tn1dK3xbXlxwe0x9XHB7Tn1dKyQvZ3UsICcnKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgICBpZiAoIXdvcmRzLmxlbmd0aCkgcmV0dXJuOwogICAgICBpZiAod29yZHMubGVuZ3RoID09PSAxICYmIHdvcmRzWzBdLmxlbmd0aCA8IDIgJiYgL15bXHB7TH1ccHtOfV0kL3UudGVzdCh3b3Jkc1swXSkgJiYgL1thLXowLTldL2kudGVzdCh3b3Jkc1swXSkpIHJldHVybjsKICAgICAgY29uc3Qga2V5ID0gd29yZHMuam9pbignICcpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm47CiAgICAgIHNlZW4uYWRkKGtleSk7CiAgICAgIG91dC5wdXNoKHsgd29yZHMgfSk7CiAgICB9OwogICAgY29uc3QgdG9rZW5zID0gU3RyaW5nKHF1ZXJ5IHx8ICcnKS5tYXRjaCgvLT9bXHB7TH1ccHtOfV9dKzpcKFteKV0qXCl8LT9bXHB7TH1ccHtOfV9dKzoiW14iXSoifC0_IlteIl0qInxcUysvZ3UpIHx8IFtdOwogICAgZm9yIChjb25zdCByYXcgb2YgdG9rZW5zKSB7CiAgICAg",
"IGlmIChyYXcuc3RhcnRzV2l0aCgnLScpKSBjb250aW51ZTsgLy8gZXhjbHVkZWQ6IG5vdCBpbiB0aGUgbm90ZQogICAgICBjb25zdCBvcCA9IC9eKFtccHtMfVxwe059X10rKTooLiopJC91LmV4ZWMocmF3KTsKICAgICAgaWYgKG9wKSB7CiAgICAgICAgaWYgKFRFWFRfT1BTLmhhcyhvcFsxXS50b0xvd2VyQ2FzZSgpKSkgewogICAgICAgICAgY29uc3QgdiA9IG9wWzJdLnJlcGxhY2UoL15bKCJdfFspIl0kL2csICcnKTsKICAgICAgICAgIGlmICgvXlwoLy50ZXN0KG9wWzJdKSkgdi5zcGxpdCgvXHMrLykuZm9yRWFjaChhZGQpOwogICAgICAgICAgZWxzZSBhZGQodik7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnIicpKSB7IGFkZChyYXcucmVwbGFjZSgvIi9nLCAnJykpOyBjb250aW51ZTsgfQogICAgICBjb25zdCB3b3JkID0gcmF3LnJlcGxhY2UoL15bKygpe31dK3xbKCl7fV0rJC9nLCAnJyk7CiAgICAgIGlmIChLRVlXT1JEUy5oYXMod29yZC50b0xvd2VyQ2FzZSgpKSkgY29udGludWU7CiAgICAgIGFkZCh3b3JkKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgRmluZGluZyB0aGVtIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU",
"gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBMb3dlciBjYXNlLCBhY2NlbnRzIG9mZiAtIG9uZSBjaGFyYWN0ZXIgYXQgYSB0aW1lLCB3aXRoIGEgbWFwIGJhY2sgdG8KICAvLyB3aGVyZSBlYWNoIGZvbGRlZCBjaGFyYWN0ZXIgY2FtZSBmcm9tLCBzbyBhIG1hdGNoIGluIHRoZSBmb2xkZWQgdGV4dAogIC8vIGlzIGEgbWF0Y2ggYXQga25vd24gb2Zmc2V0cyBpbiB0aGUgcmVhbCBvbmUuCiAgZnVuY3Rpb24gZm9sZCh0ZXh0KSB7CiAgICBsZXQgZm9sZGVkID0gJyc7CiAgICBjb25zdCBtYXAgPSBbXTsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHMubGVuZ3RoOykgewogICAgICBjb25zdCBjcCA9IHMuY29kZVBvaW50QXQoaSk7CiAgICAgIGNvbnN0IGNoID0gU3RyaW5nLmZyb21Db2RlUG9pbnQoY3ApOwogICAgICBjb25zdCBmID0gY2gubm9ybWFsaXplKCdORkQnKS5yZXBsYWNlKC9ccHtNfSsvZ3UsICcnKS50b0xvd2VyQ2FzZSgpOwogICAgICBmb3IgKGxldCBrID0gMDsgayA8IGYubGVuZ3RoOyBrKyspIG1hcC5wdXNoKGkpOwogICAgICBmb2xkZWQgKz0gZjsKICAgICAgaSArPSBjaC5sZW5ndGg7CiAgICB9CiAgICBtYXAucHVzaChzLmxlbmd0aCk7CiAgICByZXR1cm4geyBmb2xkZWQsIG1hcCB9OwogIH0KCiAgY29uc3QgZXNjYXBlUmUgPSBzID0-IHMucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xdXFxdL2csICdcXCQmJyk7CgogIC8vIEV2ZXJ5",
"IHBsYWNlIHRoZSB0ZXJtcyBvY2N1ciwgYXMgW3N0YXJ0LCBlbmQpIG9mZnNldHMgaW50byBgdGV4dGAsCiAgLy8gaW4gb3JkZXIsIHdpdGggb3ZlcmxhcHMgbWVyZ2VkLgogIGZ1bmN0aW9uIGZpbmRNYXRjaGVzKHRleHQsIHRlcm1zKSB7CiAgICBpZiAoIXRlcm1zIHx8ICF0ZXJtcy5sZW5ndGggfHwgIXRleHQpIHJldHVybiBbXTsKICAgIGNvbnN0IHsgZm9sZGVkLCBtYXAgfSA9IGZvbGQodGV4dCk7CiAgICBjb25zdCBmb3VuZCA9IFtdOwogICAgZm9yIChjb25zdCB0IG9mIHRlcm1zKSB7CiAgICAgIGNvbnN0IHBhdHRlcm4gPSB0LndvcmRzLm1hcCh3ID0-IGVzY2FwZVJlKGZvbGQodykuZm9sZGVkKSkuam9pbignW1xcc1xcdTAwYTBdKycpOwogICAgICBpZiAoIXBhdHRlcm4pIGNvbnRpbnVlOwogICAgICBjb25zdCByZSA9IG5ldyBSZWdFeHAoYCg_PCFbXFxwe0x9XFxwe059XSkke3BhdHRlcm59YCwgJ2d1Jyk7CiAgICAgIGxldCBtOwogICAgICB3aGlsZSAoKG0gPSByZS5leGVjKGZvbGRlZCkpKSB7CiAgICAgICAgZm91bmQucHVzaChbbWFwW20uaW5kZXhdLCBtYXBbbS5pbmRleCArIG1bMF0ubGVuZ3RoXV0pOwogICAgICAgIGlmIChtWzBdLmxlbmd0aCA9PT0gMCkgcmUubGFzdEluZGV4Kys7CiAgICAgIH0KICAgIH0KICAgIGZvdW5kLnNvcnQoKGEsIGIpID0-IGFbMF0gLSBiWzBdIHx8IGFbMV0gLSBiWzFdKTsKICAgIGNvbnN0IG1lcmdlZCA9IFtdOwogICAgZm9yIChjb25zdCBbcywgZV0gb2YgZm91bmQp",
"IHsKICAgICAgY29uc3QgbGFzdCA9IG1lcmdlZFttZXJnZWQubGVuZ3RoIC0gMV07CiAgICAgIGlmIChsYXN0ICYmIHMgPD0gbGFzdC5lbmQpIGxhc3QuZW5kID0gTWF0aC5tYXgobGFzdC5lbmQsIGUpOwogICAgICBlbHNlIG1lcmdlZC5wdXNoKHsgc3RhcnQ6IHMsIGVuZDogZSB9KTsKICAgIH0KICAgIHJldHVybiBtZXJnZWQ7CiAgfQoKICAvLyDilIDilIAgRXhjZXJwdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFVwIHRvIGBtYXhgIHN0cmV0Y2hlcyBvZiB0ZXh0IGFyb3VuZCB0aGUgbWF0Y2hlcywgZWFjaCB3aXRoIHRoZQogIC8vIG1hdGNoZXMgaW5zaWRlIGl0IGF0IG9mZnNldHMgcmVsYXRpdmUgdG8gdGhlIHN0cmV0Y2guIFN0cmV0Y2hlcyBzdGFydAogIC8vIGFuZCBlbmQgb24gYSBzcGFjZSB3aGVyZSBvbmUgaXMgbmVhciwgYW5kIHNheSB3aGV0aGVyIHRleHQgd2FzIGN1dC4KICBmdW5jdGlvbiBleGNlcnB0cyh0ZXh0LCBtYXRjaGVzLCB7IGNvbnRleHQgPSA1MCwgbWF4ID0gMyB9ID0ge30pIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBpID0gMDsKICAgIHdoaWxl",
"IChpIDwgbWF0Y2hlcy5sZW5ndGggJiYgb3V0Lmxlbmd0aCA8IG1heCkgewogICAgICBsZXQgc3RhcnQgPSBNYXRoLm1heCgwLCBtYXRjaGVzW2ldLnN0YXJ0IC0gY29udGV4dCk7CiAgICAgIGxldCBlbmQgPSBNYXRoLm1pbihzLmxlbmd0aCwgbWF0Y2hlc1tpXS5lbmQgKyBjb250ZXh0KTsKICAgICAgLy8gTWF0Y2hlcyBjbG9zZSBlbm91Z2ggc2hhcmUgYW4gZXhjZXJwdC4KICAgICAgbGV0IGogPSBpICsgMTsKICAgICAgd2hpbGUgKGogPCBtYXRjaGVzLmxlbmd0aCAmJiBtYXRjaGVzW2pdLnN0YXJ0IDwgZW5kKSB7CiAgICAgICAgZW5kID0gTWF0aC5taW4ocy5sZW5ndGgsIE1hdGgubWF4KGVuZCwgbWF0Y2hlc1tqXS5lbmQgKyBNYXRoLmZsb29yKGNvbnRleHQgLyAyKSkpOwogICAgICAgIGorKzsKICAgICAgfQogICAgICBpZiAoc3RhcnQgPiAwKSB7CiAgICAgICAgY29uc3Qgc3AgPSBzLnNsaWNlKHN0YXJ0LCBtYXRjaGVzW2ldLnN0YXJ0KS5zZWFyY2goL1xzLyk7CiAgICAgICAgaWYgKHNwID49IDApIHN0YXJ0ICs9IHNwICsgMTsKICAgICAgfQogICAgICBpZiAoZW5kIDwgcy5sZW5ndGgpIHsKICAgICAgICBjb25zdCB0YWlsID0gcy5zbGljZShtYXRjaGVzW2ogLSAxXS5lbmQsIGVuZCk7CiAgICAgICAgY29uc3Qgc3AgPSB0YWlsLnNlYXJjaCgvXHNcUyokLyk7CiAgICAgICAgaWYgKHNwID4gMCkgZW5kID0gbWF0Y2hlc1tqIC0gMV0uZW5kICsgc3A7CiAgICAgIH0KICAgICAgb3V0LnB1c2goewogICAgICAg",
"IHRleHQ6IHMuc2xpY2Uoc3RhcnQsIGVuZCkucmVwbGFjZSgvXHMvZywgJyAnKSwKICAgICAgICBtYXJrczogbWF0Y2hlcy5zbGljZShpLCBqKS5tYXAobSA9PiAoeyBzdGFydDogTWF0aC5tYXgobS5zdGFydCwgc3RhcnQpIC0gc3RhcnQsIGVuZDogTWF0aC5taW4obS5lbmQsIGVuZCkgLSBzdGFydCB9KSksCiAgICAgICAgY3V0QmVmb3JlOiBzdGFydCA-IDAsCiAgICAgICAgY3V0QWZ0ZXI6IGVuZCA8IHMubGVuZ3RoLAogICAgICB9KTsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgYXBpID0geyBxdWVyeVRlcm1zLCBmb2xkLCBmaW5kTWF0Y2hlcywgZXhjZXJwdHMgfTsKCiAgbnMuc2VhcmNoTG9naWMgPSBhcGk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKfSkoKTsK\"],[\"src/lib/board-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIEJvYXJkIGxvZ2ljIChwdXJlKQovLwovLyBUaGUgYm9hcmQgaGFzIG5vIGRhdGEgb2YgaXRzIG93bi4gQS",
"BjYXJkIGlzIGEgR21haWwgdGhyZWFkLCBhIGNvbHVtbiBpcwovLyBhIEdtYWlsIGxhYmVsLCBhbmQgdGhlIG9ubHkgdGhpbmdzIHN0b3JlZCBvdXRzaWRlIEdtYWlsIGFyZSB0aGUgb3JkZXIgb2YKLy8gY2FyZHMgd2l0aGluIGEgY29sdW1uIGFuZCB0aGUgdXNlcidzIG93biBlZGl0cyB0byBhIGNhcmQuIEV2ZXJ5dGhpbmcKLy8gaGVyZSBpcyB0aGUgYXJpdGhtZXRpYyBiZXR3ZWVuIHRob3NlOiB3aGljaCBsYWJlbHMgYSBtb3ZlIGFkZHMgYW5kCi8vIHJlbW92ZXMsIHdoZXJlIGEgdGhyZWFkIHNob3dzIHVwIHdoZW4gaXQgY2FycmllcyB0d28gY29sdW1uIGxhYmVscywgaG93Ci8vIGEgc2F2ZWQgb3JkZXIgbWVldHMgYSBmcmVzaCB0aHJlYWQgbGlzdCwgYW5kIHdoYXQgYW4gZWRpdCBsb29rcyBsaWtlLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB1dGlsID0gKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZH",
"VsZS5leHBvcnRzKSA_IHJlcXVpcmUoJy4vdXRpbC5qcycpIDogbnMudXRpbDsKCiAgLy8g4pSA4pSAIENvbHVtbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRoZSBsZWFkaW5nIHVuZGVyc2NvcmUgc29ydHMgdGhlIGJvYXJkJ3MgbGFiZWxzIGFib3ZlIGV2ZXJ5dGhpbmcgZWxzZQogIC8vIGluIEdtYWlsJ3MgbG9uZywgYWxwaGFiZXRpY2FsIGxhYmVsIGxpc3QgLSBvbiB0aGUgcGhvbmUgZXNwZWNpYWxseS4KICBjb25zdCBERUZBVUxUX1JPT1QgPSAnX0JvYXJkJzsKCiAgLy8gRG9uZSBhcmNoaXZlcyBvbiBkcm9wIGJlY2F1c2UgdGhhdCBpcyB3aGF0IGZpbmlzaGluZyBzb21ldGhpbmcgaW4KICAvLyBHbWFpbCB1c3VhbGx5IG1lYW5zOiBvdXQgb2YgdGhlIEluYm94LCBzdGlsbCBmaW5kYWJsZSB1bmRlciBpdHMgbGFiZWwuCiAgY29uc3QgREVGQVVMVF9DT0xVTU5TID0gWwogICAgeyBpZDogJ3RvZG8nLCB0aXRsZTogJ1RvIGRvJywgbGFiZWw6IGAke0RFRkFVTFRfUk9PVH0vVG8gZG9gLCBhcmNoaXZlT25Ecm9wOiBmYWxzZSB9LAogICAgeyBpZDogJ2RvaW5nJywgdGl0bGU6ICdEb2luZycsIGxhYmVsOiBgJHtERUZBVUxUX1JPT1R9L0",
"RvaW5nYCwgYXJjaGl2ZU9uRHJvcDogZmFsc2UgfSwKICAgIHsgaWQ6ICd3YWl0aW5nJywgdGl0bGU6ICdXYWl0aW5nJywgbGFiZWw6IGAke0RFRkFVTFRfUk9PVH0vV2FpdGluZ2AsIGFyY2hpdmVPbkRyb3A6IGZhbHNlIH0sCiAgICB7IGlkOiAnZG9uZScsIHRpdGxlOiAnRG9uZScsIGxhYmVsOiBgJHtERUZBVUxUX1JPT1R9L0RvbmVgLCBhcmNoaXZlT25Ecm9wOiB0cnVlIH0sCiAgXTsKCiAgZnVuY3Rpb24gZGVmYXVsdENvbHVtbnMoKSB7CiAgICByZXR1cm4gREVGQVVMVF9DT0xVTU5TLm1hcChjID0-ICh7IC4uLmMgfSkpOwogIH0KCiAgLy8gc3RvcmFnZS5zeW5jIGNhbiBob2xkIGFueXRoaW5nIGFuIG9sZGVyIHZlcnNpb24gLSBvciBhIGhhbmQgZWRpdCAtCiAgLy8gcHV0IHRoZXJlLiBBbnl0aGluZyB1bnVzYWJsZSBmYWxscyBiYWNrIHRvIHRoZSBkZWZhdWx0cyByYXRoZXIgdGhhbgogIC8vIGxlYXZpbmcgYW4gZW1wdHkgYm9hcmQgd2l0aCBubyBvYnZpb3VzIHdheSBiYWNrLgogIGZ1bmN0aW9uIG5vcm1hbGlzZUNvbHVtbnMocmF3KSB7CiAgICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkgcmV0dXJuIGRlZmF1bHRDb2x1bW5zKCk7CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGNvbnN0IGMgb2YgcmF3KSB7CiAgICAgIGlmICghYyB8fCB0eXBlb2YgYyAhPT0gJ29iamVjdCcpIGNvbnRpbnVlOwogICAgICBjb25zdCBpZCA9IFN0cmluZyhjLmlkIHx8IC",
"cnKS50cmltKCk7CiAgICAgIGNvbnN0IGxhYmVsID0gU3RyaW5nKGMubGFiZWwgfHwgJycpLnRyaW0oKTsKICAgICAgaWYgKCFpZCB8fCAhbGFiZWwgfHwgc2Vlbi5oYXMoaWQpKSBjb250aW51ZTsKICAgICAgc2Vlbi5hZGQoaWQpOwogICAgICBjb25zdCBjb2wgPSB7CiAgICAgICAgaWQsCiAgICAgICAgdGl0bGU6IFN0cmluZyhjLnRpdGxlIHx8ICcnKS50cmltKCkgfHwgbGFiZWwuc3BsaXQoJy8nKS5wb3AoKSwKICAgICAgICBsYWJlbCwKICAgICAgICBhcmNoaXZlT25Ecm9wOiAhIWMuYXJjaGl2ZU9uRHJvcCwKICAgICAgfTsKICAgICAgaWYgKGMubGFiZWxJZCAmJiB0eXBlb2YgYy5sYWJlbElkID09PSAnc3RyaW5nJykgY29sLmxhYmVsSWQgPSBjLmxhYmVsSWQ7CiAgICAgIG91dC5wdXNoKGNvbCk7CiAgICB9CiAgICByZXR1cm4gb3V0Lmxlbmd0aCA_IG91dCA6IGRlZmF1bHRDb2x1bW5zKCk7CiAgfQoKICAvLyBXaGVyZSBhIG5ldyBjb2x1bW4ncyBsYWJlbCBnb2VzOiB1bmRlciB0aGUgcGFyZW50IHRoZSBleGlzdGluZyBjb2x1bW5zCiAgLy8gc2hhcmUsIHNvIGEgYm9hcmQgbW92ZWQgdG8gIl9Cb2FyZC_igKYiIGtlZXBzIGdyb3dpbmcgdGhlcmUgcmF0aGVyIHRoYW4KICAvLyBxdWlldGx5IHJlY3JlYXRpbmcgdGhlIG9sZCAiQm9hcmQiIHBhcmVudC4KICBmdW5jdGlvbiBsYWJlbFJvb3QoY29sdW1ucykgewogICAgY29uc3QgcGFyZW50cyA9IG5ldyBTZXQoKGNvbHVtbnMgfHwgW10pLm1hcChjID0-IHsKIC",
"AgICAgY29uc3QgcGFydHMgPSBTdHJpbmcoYy5sYWJlbCB8fCAnJykuc3BsaXQoJy8nKTsKICAgICAgcmV0dXJuIHBhcnRzLmxlbmd0aCA-IDEgPyBwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpIDogJyc7CiAgICB9KSk7CiAgICBpZiAocGFyZW50cy5zaXplID09PSAxKSB7CiAgICAgIGNvbnN0IFtvbmx5XSA9IHBhcmVudHM7CiAgICAgIGlmIChvbmx5KSByZXR1cm4gb25seTsKICAgIH0KICAgIHJldHVybiBERUZBVUxUX1JPT1Q7CiAgfQoKICAvLyBDb2x1bW5zIHJlbWVtYmVyIHRoZWlyIGxhYmVsJ3MgaWQgYXMgd2VsbCBhcyBpdHMgbmFtZSwgYmVjYXVzZSBHbWFpbAogIC8vIGxldHMgYSBsYWJlbCBiZSByZW5hbWVkIC0gYW5kIHJlbmFtaW5nICJCb2FyZCIgdG8gIl9Cb2FyZCIgcmVuYW1lcwogIC8vIGV2ZXJ5IGNvbHVtbiBsYWJlbCB1bmRlciBpdC4gRm9sbG93aW5nIHRoZSBpZCBrZWVwcyBhIGNvbHVtbiBvbiB0aGUKICAvLyBzYW1lIG1haWw7IGZvbGxvd2luZyB0aGUgbmFtZSBhbG9uZSB3b3VsZCBjcmVhdGUgYSBmcmVzaCwgZW1wdHkgbGFiZWwKICAvLyB3aXRoIHRoZSBvbGQgbmFtZS4gUmV0dXJucyB0aGUgY29sdW1ucyB3aXRoIG5hbWVzIGJyb3VnaHQgdXAgdG8gZGF0ZQogIC8vIGFuZCBpZHMgZmlsbGVkIGluLCBhbmQgd2hldGhlciBhbnl0aGluZyBjaGFuZ2VkIChzbyBpdCBjYW4gYmUgc2F2ZWQpLgogIGZ1bmN0aW9uIHJlc29sdmVDb2x1bW5MYWJlbHMoY29sdW1ucywgbGFiZWxzKSB7CiAgIC",
"Bjb25zdCBieUlkID0gbmV3IE1hcCgobGFiZWxzIHx8IFtdKS5tYXAobCA9PiBbbC5pZCwgbF0pKTsKICAgIGNvbnN0IGJ5TmFtZSA9IG5ldyBNYXAoKGxhYmVscyB8fCBbXSkubWFwKGwgPT4gW1N0cmluZyhsLm5hbWUpLnRvTG93ZXJDYXNlKCksIGxdKSk7CiAgICBsZXQgY2hhbmdlZCA9IGZhbHNlOwogICAgY29uc3Qgb3V0ID0gY29sdW1ucy5tYXAoYyA9PiB7CiAgICAgIGNvbnN0IHZpYUlkID0gYy5sYWJlbElkICYmIGJ5SWQuZ2V0KGMubGFiZWxJZCk7CiAgICAgIGlmICh2aWFJZCkgewogICAgICAgIGlmICh2aWFJZC5uYW1lID09PSBjLmxhYmVsKSByZXR1cm4gYzsKICAgICAgICBjaGFuZ2VkID0gdHJ1ZTsKICAgICAgICByZXR1cm4geyAuLi5jLCBsYWJlbDogdmlhSWQubmFtZSB9OwogICAgICB9CiAgICAgIC8vIEdtYWlsJ3Mgb3duIHNwZWxsaW5nIHdpbnMsIHNvIGEgY2FzZS1vbmx5IGRpZmZlcmVuY2Ugc2V0dGxlcyBoZXJlCiAgICAgIC8vIHJhdGhlciB0aGFuIGNvdW50aW5nIGFzIGEgcmVuYW1lIG9uIHRoZSBuZXh0IHBhc3MuCiAgICAgIGNvbnN0IHZpYU5hbWUgPSBieU5hbWUuZ2V0KFN0cmluZyhjLmxhYmVsKS50b0xvd2VyQ2FzZSgpKTsKICAgICAgaWYgKHZpYU5hbWUpIHsKICAgICAgICBpZiAoYy5sYWJlbElkID09PSB2aWFOYW1lLmlkICYmIGMubGFiZWwgPT09IHZpYU5hbWUubmFtZSkgcmV0dXJuIGM7CiAgICAgICAgY2hhbmdlZCA9IHRydWU7CiAgICAgICAgcmV0dXJuIHsgLi4uYywgbGFiZW",
"w6IHZpYU5hbWUubmFtZSwgbGFiZWxJZDogdmlhTmFtZS5pZCB9OwogICAgICB9CiAgICAgIC8vIE5vdCBpbiBHbWFpbCAoeWV0KTogaXQgaXMgY3JlYXRlZCB1bmRlciB0aGlzIG5hbWUsIGFuZCBpdHMgaWQgaXMKICAgICAgLy8gcmVjb3JkZWQgb24gdGhlIG5leHQgcGFzcy4KICAgICAgaWYgKGMubGFiZWxJZCkgewogICAgICAgIGNoYW5nZWQgPSB0cnVlOwogICAgICAgIGNvbnN0IHsgbGFiZWxJZCwgLi4ucmVzdCB9ID0gYzsKICAgICAgICByZXR1cm4gcmVzdDsKICAgICAgfQogICAgICByZXR1cm4gYzsKICAgIH0pOwogICAgcmV0dXJuIHsgY29sdW1uczogb3V0LCBjaGFuZ2VkIH07CiAgfQoKICBmdW5jdGlvbiBuZXdDb2x1bW5JZChleGlzdGluZywgcmFuZCA9IE1hdGgucmFuZG9tKSB7CiAgICBjb25zdCB0YWtlbiA9IG5ldyBTZXQoKGV4aXN0aW5nIHx8IFtdKS5tYXAoYyA9PiBjLmlkKSk7CiAgICBsZXQgaWQ7CiAgICBkbyB7CiAgICAgIGlkID0gJ2MnICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyBNYXRoLmZsb29yKHJhbmQoKSAqIDFlNikudG9TdHJpbmcoMzYpOwogICAgfSB3aGlsZSAodGFrZW4uaGFzKGlkKSk7CiAgICByZXR1cm4gaWQ7CiAgfQoKICAvLyBHbWFpbCByZXNlcnZlcyBpdHMgc3lzdGVtIGxhYmVsIG5hbWVzIChjYXNlLWluc2Vuc2l0aXZlbHkpIGFuZCByZWplY3RzCiAgLy8gZW1wdHkgcGF0aCBzZWdtZW50cywgc28gYm90aCBhcmUgY2F1Z2h0IGhlcmUgd2l0aCBhIHJlYWRhYmxlIG",
"1lc3NhZ2UKICAvLyBpbnN0ZWFkIG9mIGEgYmFyZSA0MDAgZnJvbSB0aGUgQVBJLgogIGNvbnN0IFJFU0VSVkVEID0gbmV3IFNldChbCiAgICAnaW5ib3gnLCAnc2VudCcsICdkcmFmdHMnLCAnc3BhbScsICd0cmFzaCcsICdzdGFycmVkJywgJ2ltcG9ydGFudCcsCiAgICAndW5yZWFkJywgJ2NoYXQnLCAnc25vb3plZCcsICdzY2hlZHVsZWQnLCAnYWxsIG1haWwnLCAnb3V0Ym94JywKICBdKTsKCiAgZnVuY3Rpb24gdmFsaWRhdGVDb2x1bW5zKGNvbHMpIHsKICAgIGlmICghY29scy5sZW5ndGgpIHJldHVybiAnS2VlcCBhdCBsZWFzdCBvbmUgY29sdW1uLic7CiAgICBjb25zdCBsYWJlbHMgPSBuZXcgU2V0KCk7CiAgICBmb3IgKGNvbnN0IGMgb2YgY29scykgewogICAgICBjb25zdCB0aXRsZSA9IChjLnRpdGxlIHx8ICcnKS50cmltKCk7CiAgICAgIGNvbnN0IGxhYmVsID0gKGMubGFiZWwgfHwgJycpLnRyaW0oKTsKICAgICAgaWYgKCF0aXRsZSkgcmV0dXJuICdFdmVyeSBjb2x1bW4gbmVlZHMgYSB0aXRsZS4nOwogICAgICBpZiAoIWxhYmVsKSByZXR1cm4gYOKAnCR7dGl0bGV94oCdIG5lZWRzIGEgR21haWwgbGFiZWwuYDsKICAgICAgaWYgKGxhYmVsLnNwbGl0KCcvJykuc29tZShzZWcgPT4gIXNlZy50cmltKCkpKSB7CiAgICAgICAgcmV0dXJuIGDigJwke2xhYmVsfeKAnSBoYXMgYW4gZW1wdHkgcGFydCBiZXR3ZWVuIHNsYXNoZXMuYDsKICAgICAgfQogICAgICBpZiAoUkVTRVJWRUQuaGFzKGxhYmVsLnRvTG93ZX",
"JDYXNlKCkpKSByZXR1cm4gYOKAnCR7bGFiZWx94oCdIGlzIGEgR21haWwgc3lzdGVtIGxhYmVsIGFuZCBjYW5ub3QgYmUgdXNlZC5gOwogICAgICBjb25zdCBrZXkgPSBsYWJlbC50b0xvd2VyQ2FzZSgpOwogICAgICBpZiAobGFiZWxzLmhhcyhrZXkpKSByZXR1cm4gYFR3byBjb2x1bW5zIHVzZSB0aGUgbGFiZWwg4oCcJHtsYWJlbH3igJ0uYDsKICAgICAgbGFiZWxzLmFkZChrZXkpOwogICAgfQogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gIl9Cb2FyZC9UbyBkbyIg4oaSIFsiX0JvYXJkIl0uIEdtYWlsIG9ubHkgbmVzdHMgYSBsYWJlbCBpbiBpdHMgc2lkZWJhcgogIC8vIHdoZW4gdGhlIHBhcmVudCBleGlzdHMsIHNvIHRoZSBwYXJlbnRzIGFyZSBjcmVhdGVkIHRvby4KICBmdW5jdGlvbiBsYWJlbEFuY2VzdG9ycyhuYW1lKSB7CiAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyhuYW1lKS5zcGxpdCgnLycpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID0gMTsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSBvdXQucHVzaChwYXJ0cy5zbGljZSgwLCBpKS5qb2luKCcvJykpOwogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIOKUgOKUgCBQbGFjZW1lbnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIEEgdGhyZWFkIGNhcnJ5aW5nIHR3byBjb2x1bW4gbGFiZWxzIChtb3ZlZCBvbiB0aGUgcGhvbmUsIHNheSkgaXMgc2hvd24KICAvLyBvbmNlLCBpbiB0aGUgbGVmdC1tb3N0IG9mIGl0cyBjb2x1bW5zLiBTaG93aW5nIGl0IHR3aWNlIHdvdWxkIG1ha2UgYQogIC8vIGRyYWcgYW1iaWd1b3VzIGFib3V0IHdoaWNoIGxhYmVsIGl0IGlzIGxlYXZpbmcuCiAgZnVuY3Rpb24gYXNzaWduQ29sdW1ucyhjb2x1bW5zLCBsaXN0c0J5Q29sdW1uKSB7CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3Qgb3V0ID0ge307CiAgICBmb3IgKGNvbnN0IGNvbCBvZiBjb2x1bW5zKSB7CiAgICAgIG91dFtjb2wuaWRdID0gW107CiAgICAgIGZvciAoY29uc3QgaWQgb2YgKGxpc3RzQnlDb2x1bW5bY29sLmlkXSB8fCBbXSkpIHsKICAgICAgICBpZiAoc2Vlbi5oYXMoaWQpKSBjb250aW51ZTsKICAgICAgICBzZWVuLmFkZChpZCk7CiAgICAgICAgb3V0W2NvbC5pZF0ucHVzaChpZCk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBTYXZlZCBvcmRlciB3aW5zIGZvciBldmVyeSB0aHJlYWQgaXQgbWVudGlvbnMuIFRocmVhZHMgaXQgZG9lcyBub3QKICAvLyBrbm93IGFib3V0IGFyZSBuZXcgdG8gdGhlIGNvbHVtbiwgc28gdGhleSBnbyBvbiB0b3AgLSBuZXdlc3QgZmlyc3QgLQogIC8vIHdoZXJlIHRoZXkgd2lsbCBiZSBub3RpY2VkLiBJZHMgdGhhdC",
"BoYXZlIGxlZnQgdGhlIGNvbHVtbiBkcm9wIG91dC4KICBmdW5jdGlvbiBtZXJnZU9yZGVyKHNhdmVkSWRzLCB0aHJlYWRzKSB7CiAgICBjb25zdCBwcmVzZW50ID0gbmV3IE1hcCh0aHJlYWRzLm1hcCh0ID0-IFt0LmlkLCB0XSkpOwogICAgY29uc3Qga2VwdCA9IFtdOwogICAgY29uc3Qga2VwdFNldCA9IG5ldyBTZXQoKTsKICAgIGZvciAoY29uc3QgaWQgb2YgKHNhdmVkSWRzIHx8IFtdKSkgewogICAgICBpZiAocHJlc2VudC5oYXMoaWQpICYmICFrZXB0U2V0LmhhcyhpZCkpIHsga2VwdC5wdXNoKGlkKTsga2VwdFNldC5hZGQoaWQpOyB9CiAgICB9CiAgICBjb25zdCBmcmVzaCA9IHRocmVhZHMKICAgICAgLmZpbHRlcih0ID0-ICFrZXB0U2V0Lmhhcyh0LmlkKSkKICAgICAgLnNvcnQoKGEsIGIpID0-IChOdW1iZXIoYi50cykgfHwgMCkgLSAoTnVtYmVyKGEudHMpIHx8IDApKQogICAgICAubWFwKHQgPT4gdC5pZCk7CiAgICByZXR1cm4gZnJlc2guY29uY2F0KGtlcHQpOwogIH0KCiAgLy8gSW5kZXggaXMgYSBwb3NpdGlvbiBpbiB0aGUgbGlzdCBhcyBpdCBsb29rcyBXSVRIT1VUIHRoZSB0aHJlYWQgYmVpbmcKICAvLyBwbGFjZWQgLSB3aGljaCBpcyB3aGF0IHRoZSBkcm9wIHpvbmUgbWVhc3VyZXMsIHNpbmNlIHRoZSBkcmFnZ2VkIGNhcmQKICAvLyBpcyBoaWRkZW4gd2hpbGUgaXQgaXMgaW4gZmxpZ2h0LgogIGZ1bmN0aW9uIHBsYWNlSWQobGlzdCwgaWQsIGluZGV4KSB7CiAgICBjb25zdCByZXN0ID0gKGxpc3",
"QgfHwgW10pLmZpbHRlcih4ID0-IHggIT09IGlkKTsKICAgIGNvbnN0IGkgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihOdW1iZXIoaW5kZXgpIHx8IDAsIHJlc3QubGVuZ3RoKSk7CiAgICByZXN0LnNwbGljZShpLCAwLCBpZCk7CiAgICByZXR1cm4gcmVzdDsKICB9CgogIC8vIERyb3BzIGlkcyB0aGF0IGFyZSBub3Qgb24gdGhlIGJvYXJkIGFueSBtb3JlLCBhbmQgY29sdW1ucyB0aGF0IG5vCiAgLy8gbG9uZ2VyIGV4aXN0LCBzbyBzdG9yYWdlLmxvY2FsIGRvZXMgbm90IHNsb3dseSBmaWxsIHdpdGggZGVhZCB0aHJlYWRzLgogIGZ1bmN0aW9uIHBydW5lT3JkZXIobGlzdHMsIGNvbHVtbnMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgZm9yIChjb25zdCBjb2wgb2YgY29sdW1ucykgb3V0W2NvbC5pZF0gPSAobGlzdHNbY29sLmlkXSB8fCBbXSkuc2xpY2UoKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgTGFiZWwgYXJpdGhtZXRpYyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYXNMb29rdXAobGFiZWxJZE9mKSB7CiAgICBpZiAodHlwZW9mIGxhYmVsSWRPZiA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIGxhYmVsSWRPZjsKICAgIGlmIChsYWJlbElkT2YgaW5zdGFuY2",
"VvZiBNYXApIHJldHVybiBuYW1lID0-IGxhYmVsSWRPZi5nZXQobmFtZSk7CiAgICByZXR1cm4gbmFtZSA9PiAobGFiZWxJZE9mIHx8IHt9KVtuYW1lXTsKICB9CgogIC8vIE1vdmluZyBhIGNhcmQgaXMgb25lIHRocmVhZHMubW9kaWZ5OiBhZGQgdGhlIHRhcmdldCdzIGxhYmVsLCBzdHJpcAogIC8vIGV2ZXJ5IG90aGVyIGNvbHVtbiBsYWJlbCAoc28gYSB0aHJlYWQgaXMgb25seSBldmVyIGluIG9uZSBjb2x1bW4sIGV2ZW4KICAvLyBpZiBpdCBoYWQgZHJpZnRlZCBpbnRvIHR3byksIGFuZCBkcm9wIElOQk9YIHdoZW4gdGhlIHRhcmdldCBhcmNoaXZlcy4KICBmdW5jdGlvbiBtb3ZlTGFiZWxEaWZmKGNvbHVtbnMsIHRhcmdldENvbHVtbklkLCBsYWJlbElkT2YpIHsKICAgIGNvbnN0IGxvb2t1cCA9IGFzTG9va3VwKGxhYmVsSWRPZik7CiAgICBjb25zdCB0YXJnZXQgPSBjb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSB0YXJnZXRDb2x1bW5JZCk7CiAgICBpZiAoIXRhcmdldCkgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGNvbHVtbiAke3RhcmdldENvbHVtbklkfWApOwogICAgY29uc3QgYWRkSWQgPSBsb29rdXAodGFyZ2V0LmxhYmVsKTsKICAgIGlmICghYWRkSWQpIHRocm93IG5ldyBFcnJvcihgTm8gR21haWwgbGFiZWwgaWQgZm9yIOKAnCR7dGFyZ2V0LmxhYmVsfeKAnWApOwoKICAgIGNvbnN0IHJlbW92ZSA9IG5ldyBTZXQoKTsKICAgIGZvciAoY29uc3QgYyBvZiBjb2x1bW5zKSB7CiAgICAgIGlmIChjLmlkID",
"09PSB0YXJnZXRDb2x1bW5JZCkgY29udGludWU7CiAgICAgIGNvbnN0IGlkID0gbG9va3VwKGMubGFiZWwpOwogICAgICBpZiAoaWQgJiYgaWQgIT09IGFkZElkKSByZW1vdmUuYWRkKGlkKTsKICAgIH0KICAgIGlmICh0YXJnZXQuYXJjaGl2ZU9uRHJvcCkgcmVtb3ZlLmFkZCgnSU5CT1gnKTsKICAgIHJldHVybiB7IGFkZExhYmVsSWRzOiBbYWRkSWRdLCByZW1vdmVMYWJlbElkczogWy4uLnJlbW92ZV0gfTsKICB9CgogIC8vIFRha2luZyBhIGNhcmQgb2ZmIHRoZSBib2FyZCBzdHJpcHMgZXZlcnkgY29sdW1uIGxhYmVsIGFuZCBub3RoaW5nCiAgLy8gZWxzZTogdGhlIHRocmVhZCBzdGF5cyBleGFjdGx5IHdoZXJlIGl0IHdhcyBpbiBHbWFpbC4KICBmdW5jdGlvbiByZW1vdmVMYWJlbERpZmYoY29sdW1ucywgbGFiZWxJZE9mKSB7CiAgICBjb25zdCBsb29rdXAgPSBhc0xvb2t1cChsYWJlbElkT2YpOwogICAgY29uc3QgcmVtb3ZlID0gbmV3IFNldCgpOwogICAgZm9yIChjb25zdCBjIG9mIGNvbHVtbnMpIHsKICAgICAgY29uc3QgaWQgPSBsb29rdXAoYy5sYWJlbCk7CiAgICAgIGlmIChpZCkgcmVtb3ZlLmFkZChpZCk7CiAgICB9CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogW10sIHJlbW92ZUxhYmVsSWRzOiBbLi4ucmVtb3ZlXSB9OwogIH0KCiAgLy8gV2hpY2ggY29sdW1uIGEgdGhyZWFkIGJlbG9uZ3MgaW4sIGdpdmVuIHRoZSB1bmlvbiBvZiBpdHMgbGFiZWwgaWRzLgogIGZ1bmN0aW9uIGNvbHVtbkZvckxhYm",
"Vscyhjb2x1bW5zLCBsYWJlbElkcywgbGFiZWxJZE9mKSB7CiAgICBjb25zdCBsb29rdXAgPSBhc0xvb2t1cChsYWJlbElkT2YpOwogICAgY29uc3QgaGF2ZSA9IG5ldyBTZXQobGFiZWxJZHMgfHwgW10pOwogICAgZm9yIChjb25zdCBjIG9mIGNvbHVtbnMpIHsKICAgICAgY29uc3QgaWQgPSBsb29rdXAoYy5sYWJlbCk7CiAgICAgIGlmIChpZCAmJiBoYXZlLmhhcyhpZCkpIHJldHVybiBjOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQoKICAvLyDilIDilIAgVGhyZWFkcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmVkdWNlcyBhIHRocmVhZHMuZ2V0KGZvcm1hdD1tZXRhZGF0YSkgcmVzcG9uc2UgdG8gd2hhdCBhIGNhcmQgc2hvd3MuCiAgLy8gU3ViamVjdCBjb21lcyBmcm9tIHRoZSBmaXJzdCBtZXNzYWdlIChyZXBsaWVzIHByZWZpeCAiUmU6IiksIHNlbmRlcgogIC8vIGFuZCBkYXRlIGZyb20gdGhlIGxhdGVzdCByZWFsIG1lc3NhZ2UgKGEgcGVuZGluZyBkcmFmdCBpcyBub3QgbmV3cykuCiAgZnVuY3Rpb24gc3VtbWFyaXNlVGhyZWFkKHRocmVhZCwgYWNjb3VudCkgewogICAgY29uc3QgbXNncyA9ICh0aHJlYWQgJiYgdGhyZWFkLm",
"1lc3NhZ2VzKSB8fCBbXTsKICAgIGNvbnN0IGlkID0gdGhyZWFkICYmIHRocmVhZC5pZDsKICAgIGNvbnN0IGhpc3RvcnlJZCA9IFN0cmluZygodGhyZWFkICYmIHRocmVhZC5oaXN0b3J5SWQpIHx8ICcnKTsKICAgIGlmICghbXNncy5sZW5ndGgpIHsKICAgICAgcmV0dXJuIHsKICAgICAgICBpZCwgaGlzdG9yeUlkLCBzdWJqZWN0OiAnKG5vIHN1YmplY3QpJywgZnJvbTogJycsIGZyb21FbWFpbDogJycsIHRzOiAwLAogICAgICAgIHNuaXBwZXQ6IHV0aWwuZGVjb2RlRW50aXRpZXMoKHRocmVhZCAmJiB0aHJlYWQuc25pcHBldCkgfHwgJycpLAogICAgICAgIGNvdW50OiAwLCB1bnJlYWQ6IGZhbHNlLCBzdGFycmVkOiBmYWxzZSwgaGFzRHJhZnQ6IGZhbHNlLCBsYWJlbElkczogW10sCiAgICAgIH07CiAgICB9CgogICAgY29uc3QgaXNEcmFmdCA9IG0gPT4gKG0ubGFiZWxJZHMgfHwgW10pLmluY2x1ZGVzKCdEUkFGVCcpOwogICAgY29uc3QgcmVhbCA9IG1zZ3MuZmlsdGVyKG0gPT4gIWlzRHJhZnQobSkpOwogICAgY29uc3QgYmFzaXMgPSByZWFsLmxlbmd0aCA_IHJlYWwgOiBtc2dzOwogICAgY29uc3QgbGF0ZXN0ID0gYmFzaXNbYmFzaXMubGVuZ3RoIC0gMV07CiAgICBjb25zdCBmaXJzdEhlYWRlcnMgPSB1dGlsLmhlYWRlck1hcChtc2dzWzBdKTsKICAgIGNvbnN0IGxhdGVzdEhlYWRlcnMgPSB1dGlsLmhlYWRlck1hcChsYXRlc3QpOwoKICAgIGNvbnN0IGZyb20gPSB1dGlsLnBhcnNlQWRkcmVzcyhsYXRlc3RIZW",
"FkZXJzLmZyb20pOwogICAgY29uc3QgbWUgPSAhIWFjY291bnQgJiYgZnJvbS5lbWFpbCA9PT0gU3RyaW5nKGFjY291bnQpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBsYWJlbHMgPSBuZXcgU2V0KG1zZ3MuZmxhdE1hcChtID0-IG0ubGFiZWxJZHMgfHwgW10pKTsKCiAgICByZXR1cm4gewogICAgICBpZCwKICAgICAgaGlzdG9yeUlkLAogICAgICBzdWJqZWN0OiAoZmlyc3RIZWFkZXJzLnN1YmplY3QgfHwgJycpLnRyaW0oKSB8fCAnKG5vIHN1YmplY3QpJywKICAgICAgZnJvbTogbWUgPyAnbWUnIDogKHV0aWwuZGlzcGxheU5hbWUoZnJvbSkgfHwgJyh1bmtub3duIHNlbmRlciknKSwKICAgICAgZnJvbUVtYWlsOiBmcm9tLmVtYWlsLAogICAgICB0czogTnVtYmVyKGxhdGVzdC5pbnRlcm5hbERhdGUpIHx8IERhdGUucGFyc2UobGF0ZXN0SGVhZGVycy5kYXRlKSB8fCAwLAogICAgICBzbmlwcGV0OiB1dGlsLmRlY29kZUVudGl0aWVzKGxhdGVzdC5zbmlwcGV0IHx8IHRocmVhZC5zbmlwcGV0IHx8ICcnKSwKICAgICAgY291bnQ6IGJhc2lzLmxlbmd0aCwKICAgICAgdW5yZWFkOiBsYWJlbHMuaGFzKCdVTlJFQUQnKSwKICAgICAgc3RhcnJlZDogbGFiZWxzLmhhcygnU1RBUlJFRCcpLAogICAgICBoYXNEcmFmdDogbXNncy5zb21lKGlzRHJhZnQpLAogICAgICBsYWJlbElkczogWy4uLmxhYmVsc10sCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gc2VhcmNoUXVlcnkodGV4dCkgewogICAgY29uc3QgcSA9IFN0cmluZyh0ZX",
"h0IHx8ICcnKS50cmltKCk7CiAgICByZXR1cm4gcSB8fCAnaW46aW5ib3gnOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgZWRpdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGNhcmQgY2FuIGNhcnJ5IHRoZSB1c2VyJ3Mgb3duIHRpdGxlLCBhIHNob3J0IG5vdGUgYW5kIGEgY29sb3VyLiBUaGV5CiAgLy8gbGl2ZSBpbiBzdG9yYWdlLnN5bmMgYmVzaWRlIHRoZSBjb2x1bW4gbGF5b3V0IGFuZCBuZXZlciB0b3VjaCB0aGUgbWFpbDoKICAvLyBHbWFpbCBoYXMgbm93aGVyZSB0byBwdXQgYSBwcml2YXRlIHRpdGxlIG9uIGEgdGhyZWFkLCBhbmQgcmV3cml0aW5nIGEKICAvLyBzdWJqZWN0IHdvdWxkIGNoYW5nZSB3aGF0IGNvcnJlc3BvbmRlbnRzIHNlZSBpbiB0aGVpciByZXBsaWVzLgoKICBjb25zdCBDQVJEX0NPTE9VUlMgPSBbJ3JlZCcsICdvcmFuZ2UnLCAneWVsbG93JywgJ2dyZWVuJywgJ2JsdWUnLCAncHVycGxlJywgJ2dyZXknXTsKCiAgLy8gTG9uZyBlbm91Z2ggZm9yIGEgd29ya2luZyB0aXRsZSBvciBhICI0LDIwMCB3b3JkcywgZHVlIEZyaSIgbm90ZSwgc2hvcnQKICAvLyBlbm91Z2ggdGhhdCBodW5kcmVkcyBvZiBjYXJkcyBmaXQgc3luYy",
"dzIDEwMCBLQi4KICBjb25zdCBNQVhfVElUTEUgPSAyMDA7CiAgY29uc3QgTUFYX05PVEUgPSA1MDA7CgogIC8vIFJldHVybnMgdGhlIGVkaXQgdG8gc3RvcmUsIG9yIG51bGwgd2hlbiBub3RoaW5nIGRpZmZlcnMgZnJvbSB0aGUKICAvLyBlbWFpbCAtIHNvIGNsZWFyaW5nIGV2ZXJ5IGZpZWxkIGRlbGV0ZXMgdGhlIHJlY29yZCBpbnN0ZWFkIG9mIGxlYXZpbmcKICAvLyBhbiBlbXB0eSBvbmUgdG8gY291bnQgYWdhaW5zdCB0aGUgcXVvdGEuIEEgdGl0bGUgaWRlbnRpY2FsIHRvIHRoZQogIC8vIHN1YmplY3QgaXMgbm90IGFuIGVkaXQgZWl0aGVyOiB0aGUgZWRpdG9yIG9wZW5zIHByZS1maWxsZWQgd2l0aCBpdC4KICBmdW5jdGlvbiBub3JtYWxpc2VDYXJkRWRpdChyYXcsIHN1YmplY3QgPSAnJykgewogICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsOwogICAgY29uc3QgdGl0bGUgPSBTdHJpbmcocmF3LnRpdGxlIHx8ICcnKS5yZXBsYWNlKC9ccysvZywgJyAnKS50cmltKCkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGNvbnN0IG5vdGUgPSBTdHJpbmcocmF3Lm5vdGUgfHwgJycpCiAgICAgIC5yZXBsYWNlKC9cclxuPy9nLCAnXG4nKQogICAgICAucmVwbGFjZSgvXG57Myx9L2csICdcblxuJykKICAgICAgLnRyaW0oKQogICAgICAuc2xpY2UoMCwgTUFYX05PVEUpOwogICAgY29uc3QgY29sb3VyID0gQ0FSRF9DT0xPVVJTLmluY2x1ZGVzKHJhdy5jb2xvdXIpID8gcmF3Lm",
"NvbG91ciA6ICcnOwoKICAgIGNvbnN0IG91dCA9IHt9OwogICAgaWYgKHRpdGxlICYmIHRpdGxlICE9PSBTdHJpbmcoc3ViamVjdCB8fCAnJykudHJpbSgpKSBvdXQudGl0bGUgPSB0aXRsZTsKICAgIGlmIChub3RlKSBvdXQubm90ZSA9IG5vdGU7CiAgICBpZiAoY29sb3VyKSBvdXQuY29sb3VyID0gY29sb3VyOwogICAgcmV0dXJuIE9iamVjdC5rZXlzKG91dCkubGVuZ3RoID8gb3V0IDogbnVsbDsKICB9CgogIGZ1bmN0aW9uIGRpc3BsYXlUaXRsZSh0aHJlYWQsIGVkaXQpIHsKICAgIHJldHVybiAoZWRpdCAmJiBlZGl0LnRpdGxlKSB8fCAodGhyZWFkICYmIHRocmVhZC5zdWJqZWN0KSB8fCAnKG5vIHN1YmplY3QpJzsKICB9CgogIC8vIFBpY2tzIG9uZSBhY2NvdW50J3MgY2FyZCBlZGl0cyBvdXQgb2YgYSBzdG9yYWdlLnN5bmMgZHVtcCwga2V5ZWQgYnkKICAvLyB0aHJlYWQgaWQuIFJlY29yZHMgdGhhdCBubyBsb25nZXIgbm9ybWFsaXNlIHRvIGFueXRoaW5nIGFyZSBkcm9wcGVkLgogIGZ1bmN0aW9uIGNhcmRFZGl0c0Zyb20oYWxsLCBwcmVmaXgpIHsKICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTsKICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGFsbCB8fCB7fSkpIHsKICAgICAgaWYgKCFrZXkuc3RhcnRzV2l0aChwcmVmaXgpKSBjb250aW51ZTsKICAgICAgY29uc3QgaWQgPSBrZXkuc2xpY2UocHJlZml4Lmxlbmd0aCk7CiAgICAgIGNvbnN0IGVkaXQgPSBub3JtYWxpc2VDYX",
"JkRWRpdCh2YWx1ZSk7CiAgICAgIGlmIChpZCAmJiBlZGl0KSBvdXQuc2V0KGlkLCBlZGl0KTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBERUZBVUxUX1JPT1QsIERFRkFVTFRfQ09MVU1OUywgZGVmYXVsdENvbHVtbnMsIG5vcm1hbGlzZUNvbHVtbnMsIGxhYmVsUm9vdCwgcmVzb2x2ZUNvbHVtbkxhYmVscywKICAgIG5ld0NvbHVtbklkLCB2YWxpZGF0ZUNvbHVtbnMsCiAgICBsYWJlbEFuY2VzdG9ycywgYXNzaWduQ29sdW1ucywgbWVyZ2VPcmRlciwgcGxhY2VJZCwgcHJ1bmVPcmRlciwKICAgIG1vdmVMYWJlbERpZmYsIHJlbW92ZUxhYmVsRGlmZiwgY29sdW1uRm9yTGFiZWxzLCBzdW1tYXJpc2VUaHJlYWQsIHNlYXJjaFF1ZXJ5LAogICAgQ0FSRF9DT0xPVVJTLCBNQVhfVElUTEUsIE1BWF9OT1RFLCBub3JtYWxpc2VDYXJkRWRpdCwgZGlzcGxheVRpdGxlLCBjYXJkRWRpdHNGcm9tLAogIH07CgogIG5zLmxvZ2ljID0gYXBpOwogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgbW9kdWxlLmV4cG9ydHMgPSBhcGk7Cn0pKCk7Cg\"],[\"src/lib/calendar-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIENhbGVuZGFyIGxvZ2ljIChwdXJlKQovLwovLyBUaGUgQ2FsZW5kYXIgdGFiIHNob3dzIEdvb2dsZSBDYWxlbmRhcidzIGV2ZW50cyBhbmQgR29vZ2xlIFRhc2tzJwovLyB0YXNrcyBzaWRlIGJ5IHNpZGUsIGRheSBieSBkYXkuIFRoaXMgZmlsZSBob2xkcyB0aGUgcGFydHMgdGhhdCBuZWVkIG5vCi8vIGJyb3dzZXI6IGRhdGVzIGFzICJZWVlZLU1NLUREIiBrZXlzIGluIGxvY2FsIHRpbWUsIHRoZSByYW5nZXMgZWFjaAovLyB2aWV3IHNob3dzLCB0dXJuaW5nIHRoZSB0d28gQVBJcycgYW5zd2VycyBpbnRvIG9uZSBraW5kIG9mIGRheSBpdGVtLAovLyBhbmQgd2hpY2ggcmVxdWVzdHMgdG8gR29vZ2xlIGFyZSBhbGxvd2VkIGF0IGFsbC4KLy8KLy8gSXQgaXMgcmVhZC1vbmx5IGZvciBub3cuIFRoZSBzZWNvbmQgc2lnbi1pbiBhc2tzIGZvciByZWFkLW9ubHkgYWNjZXNzIHRvCi8vIENhbGVuZGFyIGFuZCBUYXNrcywgYW5kIHRoZSByZXF1ZXN0IHBvbGljeSBiZWxvdyBvbmx5IGxldHMgR0VUcyB0aHJvdWdoOgovLyB0aGUgY2FsZW5kYXIgbGlzdCwgYSBjYWxlbmRhcidzIGV2ZW50cywgdGhlIHRhc2sgbGlzdHMgYW5kIGEgbGlzdCdzCi8vIHRhc2tzLgovLwovLyBMb2FkZWQgYnkgdGhlIGNvbnRlbnQgc2NyaXB0cywgdGhlIHNlcnZpY2Ugd29ya2VyLCB0aGUgcGhvbmUgYXBwJ3MKLy8gc2NyaXB0IGFuZCB",
"Ob2RlJ3MgdGVzdHMuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgR29vZ2xlLCBhbmQgd2hhdCBtYXkgYmUgYXNrZWQgb2YgaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRoZSBzZWNvbmQgc2lnbi1pbiwgc2VwYXJhdGUgZnJvbSBHbWFpbCdzLCBzbyB0aGF0IHRoZSBib2FyZCBhbmQgdGhlCiAgLy8gbm90ZXMgbmV2ZXIgc3RvcCB3b3JraW5nIGZvciBzb21lb25lIHdobyBoYXMgbm90IGFsbG93ZWQgdGhlIGNhbGVuZGFyLgogIC8vICJlbWFpbCIgbGV0cyB0aGUgd29ya2VyIGNoZWNrIHdob3NlIGNhbGVuZGFyIGl0IGlzLgogIGNvbnN0IFNDT1BFUyA9IFsKICAgICdlbWFpbCcsCiAgICAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC9jYWxlbmRhci5yZWFkb25seScsCiA",
"gICAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC90YXNrcy5yZWFkb25seScsCiAgXTsKCiAgY29uc3QgQkFTRVMgPSB7CiAgICBjYWxlbmRhcjogJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2NhbGVuZGFyL3YzLycsCiAgICB0YXNrczogJ2h0dHBzOi8vdGFza3MuZ29vZ2xlYXBpcy5jb20vdGFza3MvdjEvJywKICB9OwoKICBjb25zdCBVU0VSSU5GT19VUkwgPSAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vb2F1dGgyL3YzL3VzZXJpbmZvJzsKCiAgLy8gT25lIHBhdGggc2VnbWVudDogYW4gaWQsIGVuY29kZWQgd2l0aCBlbmNvZGVVUklDb21wb25lbnQuIE5ldmVyIG9uZQogIC8vIHRoYXQgdGhlIFVSTCBwYXJzZXIgd291bGQgcmVhZCBhcyAiLiIgb3IgIi4uIiwgZW5jb2RlZCBvciBub3QuCiAgZnVuY3Rpb24gaXNTZWdtZW50KHMpIHsKICAgIGlmICghL15bQS1aYS16MC05JS5ffi1dKyQvLnRlc3QocykpIHJldHVybiBmYWxzZTsKICAgIGxldCBwbGFpbjsKICAgIHRyeSB7IHBsYWluID0gZGVjb2RlVVJJQ29tcG9uZW50KHMpOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9CiAgICByZXR1cm4gIS9eXC4rJC8udGVzdChwbGFpbikgJiYgIXBsYWluLmluY2x1ZGVzKCcvJyk7CiAgfQoKICBjb25zdCBBTExPV0VEID0gewogICAgY2FsZW5kYXI6IFsKICAgICAgcCA9PiBwID09PSAndXNlcnMvbWUvY2FsZW5kYXJMaXN0JywKICAgICAgcCA9PiB7IGNvbnN0IG0gPSAvXmNhbGVuZGFyc1wvKFteL10",
"rKVwvZXZlbnRzJC8uZXhlYyhwKTsgcmV0dXJuICEhbSAmJiBpc1NlZ21lbnQobVsxXSk7IH0sCiAgICBdLAogICAgdGFza3M6IFsKICAgICAgcCA9PiBwID09PSAndXNlcnMvQG1lL2xpc3RzJywKICAgICAgcCA9PiB7IGNvbnN0IG0gPSAvXmxpc3RzXC8oW14vXSspXC90YXNrcyQvLmV4ZWMocCk7IHJldHVybiAhIW0gJiYgaXNTZWdtZW50KG1bMV0pOyB9LAogICAgXSwKICB9OwoKICBmdW5jdGlvbiBpc0FsbG93ZWRSZXF1ZXN0KHNlcnZpY2UsIG1ldGhvZCwgcGF0aCkgewogICAgaWYgKFN0cmluZyhtZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCkgIT09ICdHRVQnKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBydWxlcyA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChBTExPV0VELCBzZXJ2aWNlKSA_IEFMTE9XRURbc2VydmljZV0gOiBudWxsOwogICAgcmV0dXJuICEhcnVsZXMgJiYgcnVsZXMuc29tZShvayA9PiBvayhTdHJpbmcocGF0aCB8fCAnJykpKTsKICB9CgogIC8vIFF1ZXJ5IHZhbHVlcyBtYXkgYmUgYXJyYXlzLCBhcyBmb3IgR21haWwuCiAgZnVuY3Rpb24gYnVpbGRVcmwoc2VydmljZSwgcGF0aCwgcXVlcnkpIHsKICAgIGNvbnN0IHBhcnRzID0gW107CiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhxdWVyeSB8fCB7fSkpIHsKICAgICAgY29uc3QgdiA9IHF1ZXJ5W2tleV07CiAgICAgIGlmICh2ID09PSB1bmRlZmluZWQgfHwgdiA9PT0gbnVsbCB8fCB2ID09PSA",
"nJykgY29udGludWU7CiAgICAgIGZvciAoY29uc3Qgb25lIG9mIFtdLmNvbmNhdCh2KSkgcGFydHMucHVzaChgJHtlbmNvZGVVUklDb21wb25lbnQoa2V5KX09JHtlbmNvZGVVUklDb21wb25lbnQob25lKX1gKTsKICAgIH0KICAgIHJldHVybiBCQVNFU1tzZXJ2aWNlXSArIHBhdGggKyAocGFydHMubGVuZ3RoID8gYD8ke3BhcnRzLmpvaW4oJyYnKX1gIDogJycpOwogIH0KCiAgLy8g4pSA4pSAIERhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gQSBkYXkgaXMgYSAiWVlZWS1NTS1ERCIgc3RyaW5nIGluIGxvY2FsIHRpbWU6IGl0IHNvcnRzIGFuZCBjb21wYXJlcyBhcwogIC8vIHRleHQsIGFuZCBzdXJ2aXZlcyBzdG9yYWdlIGFuZCBtZXNzYWdlcyB1bmNoYW5nZWQuIFdlZWtzIHN0YXJ0IG9uCiAgLy8gTW9uZGF5IGFuZCBhcmUgbnVtYmVyZWQgYXMgSVNPIDg2MDEgbnVtYmVycyB0aGVtLgoKICBjb25zdCBEQVlfTkFNRVMgPSBbJ01vbicsICdUdWUnLCAnV2VkJywgJ1RodScsICdGcmknLCAnU2F0JywgJ1N1biddOwogIGNvbnN0IE1PTlRIUyA9IFsnSmFuJywgJ0ZlYicsICdNYXInLCAnQXByJywgJ01heScsICdKdW4nLCA",
"nSnVsJywgJ0F1ZycsICdTZXAnLCAnT2N0JywgJ05vdicsICdEZWMnXTsKICBjb25zdCBNT05USFNfTE9ORyA9IFsnSmFudWFyeScsICdGZWJydWFyeScsICdNYXJjaCcsICdBcHJpbCcsICdNYXknLCAnSnVuZScsICdKdWx5JywKICAgICAgICAgICAgICAgICAgICAgICAnQXVndXN0JywgJ1NlcHRlbWJlcicsICdPY3RvYmVyJywgJ05vdmVtYmVyJywgJ0RlY2VtYmVyJ107CgogIC8vIEhvdyBmYXIgdGhlIGFnZW5kYSBsb29rcyBhaGVhZCwgYW5kIGhvdyBmYXIgb25lIHN0ZXAgbW92ZXMgaXQuCiAgY29uc3QgQUdFTkRBX0RBWVMgPSAyODsKCiAgY29uc3QgcGFkID0gbiA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgJzAnKTsKCiAgZnVuY3Rpb24gZGF0ZUtleShkKSB7CiAgICBjb25zdCB4ID0gZCBpbnN0YW5jZW9mIERhdGUgPyBkIDogbmV3IERhdGUoZCk7CiAgICByZXR1cm4gYCR7eC5nZXRGdWxsWWVhcigpfS0ke3BhZCh4LmdldE1vbnRoKCkgKyAxKX0tJHtwYWQoeC5nZXREYXRlKCkpfWA7CiAgfQoKICBmdW5jdGlvbiBpc0tleShrZXkpIHsKICAgIHJldHVybiAvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChTdHJpbmcoa2V5IHx8ICcnKSk7CiAgfQoKICBmdW5jdGlvbiBmcm9tS2V5KGtleSkgewogICAgY29uc3QgW3ksIG0sIGRdID0gU3RyaW5nKGtleSkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIHJldHVybiBuZXcgRGF0ZSh5LCBtIC0gMSwgZCk7CiAgfQoKICBmdW5jdGlvbiBhZGREYXlzKGtleSwgbik",
"gewogICAgY29uc3QgZCA9IGZyb21LZXkoa2V5KTsKICAgIGQuc2V0RGF0ZShkLmdldERhdGUoKSArIG4pOwogICAgcmV0dXJuIGRhdGVLZXkoZCk7CiAgfQoKICAvLyBXaG9sZSBkYXlzIGZyb20gYSB0byBiLiBSb3VuZGVkLCBiZWNhdXNlIGEgZGF5IHdpdGggYSBjbG9jayBjaGFuZ2UKICAvLyBpbiBpdCBpcyBhbiBob3VyIGxvbmdlciBvciBzaG9ydGVyIHRoYW4gMjQuCiAgZnVuY3Rpb24gZGF5c0JldHdlZW4oYSwgYikgewogICAgcmV0dXJuIE1hdGgucm91bmQoKGZyb21LZXkoYikgLSBmcm9tS2V5KGEpKSAvIDg2NDAwMDAwKTsKICB9CgogIC8vIDAgZm9yIE1vbmRheSDigKYgNiBmb3IgU3VuZGF5LgogIGZ1bmN0aW9uIHdlZWtkYXkoa2V5KSB7CiAgICByZXR1cm4gKGZyb21LZXkoa2V5KS5nZXREYXkoKSArIDYpICUgNzsKICB9CgogIGZ1bmN0aW9uIHdlZWtTdGFydChrZXkpIHsKICAgIHJldHVybiBhZGREYXlzKGtleSwgLXdlZWtkYXkoa2V5KSk7CiAgfQoKICAvLyBUaGUgSVNPIHdlZWs6IHRoZSBvbmUgd2l0aCB0aGUgeWVhcidzIGZpcnN0IFRodXJzZGF5IGluIGl0IGlzIHdlZWsgMS4KICBmdW5jdGlvbiBpc29XZWVrKGtleSkgewogICAgY29uc3QgdGh1cnNkYXkgPSBhZGREYXlzKHdlZWtTdGFydChrZXkpLCAzKTsKICAgIGNvbnN0IGZpcnN0VGh1cnNkYXkgPSBhZGREYXlzKHdlZWtTdGFydChgJHt0aHVyc2RheS5zbGljZSgwLCA0KX0tMDEtMDRgKSwgMyk7CiAgICByZXR1cm4gMSArIGRheXNCZXR3ZWV",
"uKGZpcnN0VGh1cnNkYXksIHRodXJzZGF5KSAvIDc7CiAgfQoKICBmdW5jdGlvbiBtb250aFN0YXJ0KGtleSkgewogICAgcmV0dXJuIGAke1N0cmluZyhrZXkpLnNsaWNlKDAsIDcpfS0wMWA7CiAgfQoKICAvLyBUaGUgc2FtZSBkYXkgbiBtb250aHMgb24sIG9yIHRoZSBtb250aCdzIGxhc3QgZGF5IGlmIGl0IGlzIHNob3J0ZXIuCiAgZnVuY3Rpb24gYWRkTW9udGhzKGtleSwgbikgewogICAgY29uc3QgW3ksIG0sIGRdID0gU3RyaW5nKGtleSkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIGNvbnN0IGZpcnN0ID0gbmV3IERhdGUoeSwgbSAtIDEgKyBuLCAxKTsKICAgIGNvbnN0IGxhc3QgPSBuZXcgRGF0ZShmaXJzdC5nZXRGdWxsWWVhcigpLCBmaXJzdC5nZXRNb250aCgpICsgMSwgMCkuZ2V0RGF0ZSgpOwogICAgcmV0dXJuIGRhdGVLZXkobmV3IERhdGUoZmlyc3QuZ2V0RnVsbFllYXIoKSwgZmlyc3QuZ2V0TW9udGgoKSwgTWF0aC5taW4oZCwgbGFzdCkpKTsKICB9CgogIC8vIFRoZSBkYXlzIGZyb20gc3RhcnQgdXAgdG8sIG5vdCBpbmNsdWRpbmcsIGVuZC4KICBmdW5jdGlvbiBkYXlzKHN0YXJ0LCBlbmQpIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgZm9yIChsZXQgayA9IHN0YXJ0OyBrIDwgZW5kOyBrID0gYWRkRGF5cyhrLCAxKSkgb3V0LnB1c2goayk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g4pSA4pSAIFZpZXdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBWSUVXUyA9IFsnd2VlaycsICdtb250aCcsICdhZ2VuZGEnXTsKCiAgLy8gV2hhdCBhIHZpZXcgc2hvd3MgYXJvdW5kIHRoZSBkYXkgaW4gZm9jdXM6IHRoZSB3ZWVrIGl0IGlzIGluOyBpdHMKICAvLyBtb250aCwgYXMgd2hvbGUgd2Vla3M7IG9yLCBmb3IgdGhlIGFnZW5kYSwgZm91ciB3ZWVrcyBmcm9tIHRoYXQgZGF5LgogIC8vIGVuZCBpcyB0aGUgZGF5IGFmdGVyIHRoZSBsYXN0LgogIGZ1bmN0aW9uIHZpZXdSYW5nZSh2aWV3LCBhbmNob3IpIHsKICAgIGlmICh2aWV3ID09PSAnbW9udGgnKSB7CiAgICAgIGNvbnN0IGZpcnN0ID0gbW9udGhTdGFydChhbmNob3IpOwogICAgICBjb25zdCBsYXN0ID0gYWRkRGF5cyhhZGRNb250aHMoZmlyc3QsIDEpLCAtMSk7CiAgICAgIHJldHVybiB7IHN0YXJ0OiB3ZWVrU3RhcnQoZmlyc3QpLCBlbmQ6IGFkZERheXMod2Vla1N0YXJ0KGxhc3QpLCA3KSB9OwogICAgfQogICAgaWYgKHZpZXcgPT09ICdhZ2VuZGEnKSByZXR1cm4geyBzdGFydDogYW5jaG9yLCBlbmQ6IGFkZERheXMoYW5jaG9yLCBBR0VOREFfREFZUykgfTsKICAgIGNvbnN0IHN0YXJ0ID0gd2Vla1N0YXJ0KGFuY2hvcik7CiAgICByZXR1cm4geyBzdGFydCwgZW5",
"kOiBhZGREYXlzKHN0YXJ0LCA3KSB9OwogIH0KCiAgZnVuY3Rpb24gc3RlcCh2aWV3LCBhbmNob3IsIGRpcikgewogICAgaWYgKHZpZXcgPT09ICdtb250aCcpIHJldHVybiBhZGRNb250aHMoYW5jaG9yLCBkaXIpOwogICAgaWYgKHZpZXcgPT09ICdhZ2VuZGEnKSByZXR1cm4gYWRkRGF5cyhhbmNob3IsIGRpciAqIEFHRU5EQV9EQVlTKTsKICAgIHJldHVybiBhZGREYXlzKGFuY2hvciwgZGlyICogNyk7CiAgfQoKICAvLyBUaGUgbW9udGggYXMgcm93cyBvZiBzZXZlbiBkYXlzLCBmb3IgdGhlIHNtYWxsIGNhbGVuZGFyLgogIGZ1bmN0aW9uIG1vbnRoV2Vla3MoYW5jaG9yKSB7CiAgICBjb25zdCB7IHN0YXJ0LCBlbmQgfSA9IHZpZXdSYW5nZSgnbW9udGgnLCBhbmNob3IpOwogICAgY29uc3QgYWxsID0gZGF5cyhzdGFydCwgZW5kKTsKICAgIGNvbnN0IHJvd3MgPSBbXTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYWxsLmxlbmd0aDsgaSArPSA3KSByb3dzLnB1c2goYWxsLnNsaWNlKGksIGkgKyA3KSk7CiAgICByZXR1cm4gcm93czsKICB9CgogIC8vICIyOCBTZXAg4oCTIDQgT2N0IiwgIjUg4oCTIDExIE9jdCIsIHdpdGggdGhlIHllYXIgd2hlbiBpdCBpcyBub3QgdGhpcyBvbmUuCiAgZnVuY3Rpb24gc3BhblRleHQoZmlyc3QsIGxhc3QsIHRvZGF5KSB7CiAgICBjb25zdCBbeTEsIG0xLCBkMV0gPSBmaXJzdC5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgY29uc3QgW3kyLCBtMiwgZDJdID0gbGFzdC5zcGxpdCg",
"nLScpLm1hcChOdW1iZXIpOwogICAgY29uc3QgdGhpc1llYXIgPSBOdW1iZXIoU3RyaW5nKHRvZGF5KS5zbGljZSgwLCA0KSk7CiAgICBjb25zdCB5ZWFyID0geSA9PiAoeSAhPT0gdGhpc1llYXIgPyBgICR7eX1gIDogJycpOwogICAgaWYgKGZpcnN0ID09PSBsYXN0KSByZXR1cm4gYCR7ZDF9ICR7TU9OVEhTW20xIC0gMV19JHt5ZWFyKHkxKX1gOwogICAgaWYgKHkxICE9PSB5MikgcmV0dXJuIGAke2QxfSAke01PTlRIU1ttMSAtIDFdfSAke3kxfSDigJMgJHtkMn0gJHtNT05USFNbbTIgLSAxXX0gJHt5Mn1gOwogICAgaWYgKG0xID09PSBtMikgcmV0dXJuIGAke2QxfSDigJMgJHtkMn0gJHtNT05USFNbbTIgLSAxXX0ke3llYXIoeTIpfWA7CiAgICByZXR1cm4gYCR7ZDF9ICR7TU9OVEhTW20xIC0gMV19IOKAkyAke2QyfSAke01PTlRIU1ttMiAtIDFdfSR7eWVhcih5Mil9YDsKICB9CgogIGZ1bmN0aW9uIHRpdGxlKHZpZXcsIGFuY2hvciwgdG9kYXkpIHsKICAgIGlmICh2aWV3ID09PSAnbW9udGgnKSB7CiAgICAgIGNvbnN0IFt5LCBtXSA9IGFuY2hvci5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgICByZXR1cm4gYCR7TU9OVEhTX0xPTkdbbSAtIDFdfSAke3l9YDsKICAgIH0KICAgIGNvbnN0IHsgc3RhcnQsIGVuZCB9ID0gdmlld1JhbmdlKHZpZXcsIGFuY2hvcik7CiAgICBjb25zdCBzcGFuID0gc3BhblRleHQoc3RhcnQsIGFkZERheXMoZW5kLCAtMSksIHRvZGF5KTsKICAgIHJldHVybiB2aWV3ID09PSAnd2V",
"laycgPyBgV2VlayAke2lzb1dlZWsoYW5jaG9yKX0gwrcgJHtzcGFufWAgOiBzcGFuOwogIH0KCiAgZnVuY3Rpb24gbW9udGhOYW1lKGtleSkgewogICAgY29uc3QgW3ksIG1dID0ga2V5LnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4geyBsb25nOiBNT05USFNfTE9OR1ttIC0gMV0sIHNob3J0OiBNT05USFNbbSAtIDFdLCB5ZWFyOiB5IH07CiAgfQoKICBmdW5jdGlvbiBkYXlOYW1lKGtleSkgewogICAgcmV0dXJuIERBWV9OQU1FU1t3ZWVrZGF5KGtleSldOwogIH0KCiAgLy8g4pSA4pSAIFNvdXJjZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHNhZmVDb2xvdXIoYykgewogICAgcmV0dXJuIC9eI1swLTlhLWZdezZ9JC9pLnRlc3QoU3RyaW5nKGMgfHwgJycpKSA_IFN0cmluZyhjKS50b0xvd2VyQ2FzZSgpIDogJyc7CiAgfQoKICAvLyBPbmx5IHBsYWluIGh0dHBzIGxpbmtzIGFyZSBldmVyIHB1dCBvbiB0aGUgcGFnZS4KICBmdW5jdGlvbiBzYWZlTGluayh1cmwpIHsKICAgIHJldHVybiAvXmh0dHBzOlwvXC9bXlxzXSskL2kudGVzdChTdHJpbmcodXJsIHx8ICcnKSkgPyBTdHJpbmcodXJsKSA6ICcnOwogIH0KCiA",
"gLy8gQSBjYWxlbmRhciBmcm9tIGNhbGVuZGFyTGlzdC4gR29vZ2xlJ3Mgb3duICJzaG93IGluIHRoZSBsaXN0IiBjaG9pY2UKICAvLyAoc2VsZWN0ZWQpIGRlY2lkZXMgd2hldGhlciBpdCBpcyBvbiB1bnRpbCBzb21lb25lIHNheXMgb3RoZXJ3aXNlIGhlcmU7CiAgLy8gY2FsZW5kYXJzIGhpZGRlbiBmcm9tIEdvb2dsZSdzIGxpc3QgYXJlIGxlZnQgb3V0LiBUaGUgbWFpbiBjYWxlbmRhcgogIC8vIGlzIHVzdWFsbHkgbmFtZWQgYWZ0ZXIgdGhlIGFkZHJlc3MsIG9mIHdoaWNoIHRoZSBuYW1lIHBhcnQgd2lsbCBkby4KICBmdW5jdGlvbiBjYWxlbmRhclNvdXJjZShjKSB7CiAgICBpZiAoIWMgfHwgIWMuaWQgfHwgYy5oaWRkZW4pIHJldHVybiBudWxsOwogICAgbGV0IG5hbWUgPSBTdHJpbmcoYy5zdW1tYXJ5T3ZlcnJpZGUgfHwgYy5zdW1tYXJ5IHx8IGMuaWQpLnRyaW0oKTsKICAgIGlmIChjLnByaW1hcnkgJiYgbmFtZS5pbmNsdWRlcygnQCcpKSBuYW1lID0gbmFtZS5zcGxpdCgnQCcpWzBdOwogICAgcmV0dXJuIHsKICAgICAga2luZDogJ2NhbGVuZGFyJywgaWQ6IFN0cmluZyhjLmlkKSwgbmFtZSwKICAgICAgY29sb3VyOiBzYWZlQ29sb3VyKGMuYmFja2dyb3VuZENvbG9yKSB8fCAnIzFhNzNlOCcsCiAgICAgIHByaW1hcnk6ICEhYy5wcmltYXJ5LCBvbjogYy5zZWxlY3RlZCAhPT0gZmFsc2UsCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gbGlzdFNvdXJjZShsKSB7CiAgICBpZiAoIWwgfHwgIWwuaWQpIHJldHVybiB",
"udWxsOwogICAgcmV0dXJuIHsga2luZDogJ3Rhc2tzJywgaWQ6IFN0cmluZyhsLmlkKSwgbmFtZTogU3RyaW5nKGwudGl0bGUgfHwgJycpLnRyaW0oKSB8fCAnVGFza3MnLCBvbjogdHJ1ZSB9OwogIH0KCiAgLy8gVGhlIG1haW4gY2FsZW5kYXIgZmlyc3QsIHRoZW4gdGhlIHJlc3QgYXMgR29vZ2xlIGxpc3RzIHRoZW0sIHRoZW4KICAvLyB0aGUgdGFzayBsaXN0cy4KICBmdW5jdGlvbiBzb3VyY2VzKGNhbGVuZGFySXRlbXMsIGxpc3RJdGVtcykgewogICAgY29uc3QgY2FscyA9IChjYWxlbmRhckl0ZW1zIHx8IFtdKS5tYXAoY2FsZW5kYXJTb3VyY2UpLmZpbHRlcihCb29sZWFuKTsKICAgIGNhbHMuc29ydCgoYSwgYikgPT4gTnVtYmVyKGIucHJpbWFyeSkgLSBOdW1iZXIoYS5wcmltYXJ5KSk7CiAgICByZXR1cm4gY2Fscy5jb25jYXQoKGxpc3RJdGVtcyB8fCBbXSkubWFwKGxpc3RTb3VyY2UpLmZpbHRlcihCb29sZWFuKSk7CiAgfQoKICAvLyBUaGUgc3dpdGNoIHNvbWVvbmUgZmxpY2tlZCBoZXJlIHdpbnMgb3ZlciBHb29nbGUncyBkZWZhdWx0LgogIGZ1bmN0aW9uIGlzT24oc291cmNlLCBvdmVycmlkZXMpIHsKICAgIGNvbnN0IG8gPSBvdmVycmlkZXMgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG92ZXJyaWRlcywgc291cmNlLmlkKSA_IG92ZXJyaWRlc1tzb3VyY2UuaWRdIDogdW5kZWZpbmVkOwogICAgcmV0dXJuIHR5cGVvZiBvID09PSAnYm9vbGVhbicgPyBvIDogc291cmNlLm9uOwo",
"gIH0KCiAgLy8g4pSA4pSAIFJlcXVlc3RzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBDQUxFTkRBUl9MSVNUX0ZJRUxEUyA9ICdpdGVtcyhpZCxzdW1tYXJ5LHN1bW1hcnlPdmVycmlkZSxiYWNrZ3JvdW5kQ29sb3Isc2VsZWN0ZWQsaGlkZGVuLHByaW1hcnksYWNjZXNzUm9sZSknOwogIGNvbnN0IEVWRU5UX0ZJRUxEUyA9ICdpdGVtcyhpZCxzdGF0dXMsc3VtbWFyeSxzdGFydCxlbmQsaHRtbExpbmssY29sb3JJZCxldmVudFR5cGUsbG9jYXRpb24pLG5leHRQYWdlVG9rZW4nOwoKICBmdW5jdGlvbiBzb3VyY2VSZXF1ZXN0cygpIHsKICAgIHJldHVybiBbCiAgICAgIFsnY2FsZW5kYXInLCAndXNlcnMvbWUvY2FsZW5kYXJMaXN0JywgeyBtaW5BY2Nlc3NSb2xlOiAncmVhZGVyJywgbWF4UmVzdWx0czogMjUwLCBmaWVsZHM6IENBTEVOREFSX0xJU1RfRklFTERTIH1dLAogICAgICBbJ3Rhc2tzJywgJ3VzZXJzL0BtZS9saXN0cycsIHsgbWF4UmVzdWx0czogMTAwIH1dLAogICAgXTsKICB9CgogIC8vIEZvciBlYWNoIGNhbGVuZGFyLCBpdHMgZXZlbnRzIGluIHRoZSByYW5nZSAoYSBkYXkgZWl0aGVyIHNpZGUsIGZvcgogIC8vIGNhbGVuZGFycyB",
"pbiBhbm90aGVyIHRpbWUgem9uZTsgdGhlIGRheXMgYXJlIHNvcnRlZCBvdXQgaGVyZSkuIEZvcgogIC8vIGVhY2ggdGFzayBsaXN0LCBpdHMgb3BlbiB0YXNrcyAtIGRhdGVkIG9yIG5vdCwgZm9yIHRoZSAiTm8gZGF0ZSIgdHJheQogIC8vIGFuZCBhbnl0aGluZyBvdmVyZHVlIC0gYW5kIHRoZSBvbmVzIGRvbmUgd2l0aGluIHRoZSByYW5nZS4gR29vZ2xlJ3MKICAvLyBvd24gYXBwcyBoaWRlIGEgdGFzayB3aGVuIGl0IGlzIHRpY2tlZCwgaGVuY2Ugc2hvd0hpZGRlbi4KICBmdW5jdGlvbiByYW5nZVJlcXVlc3RzKHJhbmdlLCBjYWxlbmRhcnMsIGxpc3RzKSB7CiAgICBjb25zdCBmcm9tID0gYWRkRGF5cyhyYW5nZS5zdGFydCwgLTEpOwogICAgY29uc3QgdG8gPSBhZGREYXlzKHJhbmdlLmVuZCwgMSk7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAoY29uc3QgYyBvZiBjYWxlbmRhcnMpIHsKICAgICAgb3V0LnB1c2goWydjYWxlbmRhcicsIGBjYWxlbmRhcnMvJHtlbmNvZGVVUklDb21wb25lbnQoYy5pZCl9L2V2ZW50c2AsIHsKICAgICAgICB0aW1lTWluOiBmcm9tS2V5KGZyb20pLnRvSVNPU3RyaW5nKCksIHRpbWVNYXg6IGZyb21LZXkodG8pLnRvSVNPU3RyaW5nKCksCiAgICAgICAgc2luZ2xlRXZlbnRzOiAndHJ1ZScsIG9yZGVyQnk6ICdzdGFydFRpbWUnLCBtYXhSZXN1bHRzOiAyNTAwLCBmaWVsZHM6IEVWRU5UX0ZJRUxEUywKICAgICAgfV0pOwogICAgfQogICAgZm9yIChjb25zdCBsIG9mIGxpc3RzKSB",
"7CiAgICAgIGNvbnN0IHBhdGggPSBgbGlzdHMvJHtlbmNvZGVVUklDb21wb25lbnQobC5pZCl9L3Rhc2tzYDsKICAgICAgb3V0LnB1c2goWyd0YXNrcycsIHBhdGgsIHsgc2hvd0NvbXBsZXRlZDogJ2ZhbHNlJywgbWF4UmVzdWx0czogMTAwIH1dKTsKICAgICAgb3V0LnB1c2goWyd0YXNrcycsIHBhdGgsIHsKICAgICAgICBzaG93Q29tcGxldGVkOiAndHJ1ZScsIHNob3dIaWRkZW46ICd0cnVlJywgbWF4UmVzdWx0czogMTAwLAogICAgICAgIGR1ZU1pbjogYCR7ZnJvbX1UMDA6MDA6MDAuMDAwWmAsIGR1ZU1heDogYCR7dG99VDAwOjAwOjAwLjAwMFpgLAogICAgICB9XSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8g4pSA4pSAIEl0ZW1zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBHb29nbGUgQ2FsZW5kYXIncyBvd24gZXZlbnQgY29sb3VycywgYnkgY29sb3JJZC4KICBjb25zdCBFVkVOVF9DT0xPVVJTID0gewogICAgMTogJyM3OTg2Y2InLCAyOiAnIzMzYjY3OScsIDM6ICcjOGUyNGFhJywgNDogJyNlNjdjNzMnLCA1OiAnI2Y2YmYyNicsIDY6ICcjZjQ1MTFlJywKICAgIDc6ICcjMDM5YmU1JywgODogJyM2MTYxNjE",
"nLCA5OiAnIzNmNTFiNScsIDEwOiAnIzBiODA0MycsIDExOiAnI2Q1MDAwMCcsCiAgfTsKCiAgLy8gQW4gZXZlbnQsIG9uIGV2ZXJ5IGRheSBpdCBjb3ZlcnMgKGZpcnN0IHRvIGxhc3QsIGJvdGggaW5jbHVkZWQpLgogIC8vIFdvcmtpbmctbG9jYXRpb24gZW50cmllcyAoIkhvbWUiLCAiT2ZmaWNlIikgYXJlIGxlZnQgb3V0OiB0aGV5IGFyZQogIC8vIG9uIGV2ZXJ5IGRheSBhbmQgc2F5IG5vdGhpbmcgYSBnbGFuY2UgbmVlZHMuCiAgZnVuY3Rpb24gZXZlbnRJdGVtKGV2LCBjYWwpIHsKICAgIGlmICghZXYgfHwgZXYuc3RhdHVzID09PSAnY2FuY2VsbGVkJyB8fCBldi5ldmVudFR5cGUgPT09ICd3b3JraW5nTG9jYXRpb24nKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHMgPSBldi5zdGFydCB8fCB7fTsKICAgIGNvbnN0IGUgPSBldi5lbmQgfHwge307CiAgICBjb25zdCBiYXNlID0gewogICAgICBraW5kOiAnZXZlbnQnLCBpZDogYCR7Y2FsLmlkfXwke2V2LmlkfWAsIHNvdXJjZTogY2FsLmlkLAogICAgICB0aXRsZTogU3RyaW5nKGV2LnN1bW1hcnkgfHwgJycpLnRyaW0oKSB8fCAnKE5vIHRpdGxlKScsCiAgICAgIGNvbG91cjogRVZFTlRfQ09MT1VSU1tldi5jb2xvcklkXSB8fCBjYWwuY29sb3VyLAogICAgICBsaW5rOiBzYWZlTGluayhldi5odG1sTGluayksIHdoZXJlOiBTdHJpbmcoZXYubG9jYXRpb24gfHwgJycpLnRyaW0oKSwKICAgIH07CiAgICBpZiAoaXNLZXkocy5kYXRlKSkgewogICAgICBjb25zdCBsYXN",
"0ID0gaXNLZXkoZS5kYXRlKSA_IGFkZERheXMoZS5kYXRlLCAtMSkgOiBzLmRhdGU7CiAgICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJhc2UsIHsgYWxsRGF5OiB0cnVlLCBmaXJzdDogcy5kYXRlLCBsYXN0OiBsYXN0IDwgcy5kYXRlID8gcy5kYXRlIDogbGFzdCwgc3RhcnQ6IDAsIGVuZDogMCB9KTsKICAgIH0KICAgIGNvbnN0IHN0YXJ0ID0gRGF0ZS5wYXJzZShzLmRhdGVUaW1lKTsKICAgIGlmICghaXNGaW5pdGUoc3RhcnQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGVuZE1zID0gRGF0ZS5wYXJzZShlLmRhdGVUaW1lKTsKICAgIGNvbnN0IGVuZCA9IGlzRmluaXRlKGVuZE1zKSAmJiBlbmRNcyA-IHN0YXJ0ID8gZW5kTXMgOiBzdGFydDsKICAgIC8vIEFuIGV2ZW50IGVuZGluZyBhdCBtaWRuaWdodCBkb2VzIG5vdCBzcGlsbCBpbnRvIHRoZSBuZXh0IGRheS4KICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJhc2UsIHsKICAgICAgYWxsRGF5OiBmYWxzZSwgc3RhcnQsIGVuZCwgZmlyc3Q6IGRhdGVLZXkoc3RhcnQpLCBsYXN0OiBkYXRlS2V5KE1hdGgubWF4KHN0YXJ0LCBlbmQgLSAxKSksCiAgICB9KTsKICB9CgogIC8vIEEgdGFzaywgb24gaXRzIGR1ZSBkYXkuIEdvb2dsZSBrZWVwcyBvbmx5IHRoZSBkYXRlIG9mIGEgZHVlIGRhdGUgKHRoZQogIC8vIHRpbWUgaXMgYWx3YXlzIG1pZG5pZ2h0IFVUQyksIHNvIHRoZSBkYXRlIGlzIHJlYWQgYXMgd3JpdHRlbiwgbm90CiAgLy8gbW92ZWQgaW50byB0aGUgbG9jYWw",
"gdGltZSB6b25lLiBBIHRhc2sgbWFkZSBmcm9tIGFuIGVtYWlsIGluIEdtYWlsCiAgLy8gbGlua3MgYmFjayB0byBpdC4KICBmdW5jdGlvbiB0YXNrSXRlbSh0LCBsaXN0KSB7CiAgICBpZiAoIXQgfHwgIXQuaWQgfHwgdC5kZWxldGVkKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHRpdGxlID0gU3RyaW5nKHQudGl0bGUgfHwgJycpLnRyaW0oKTsKICAgIGlmICghdGl0bGUpIHJldHVybiBudWxsOwogICAgY29uc3QgZHVlID0gL15cZHs0fS1cZHsyfS1cZHsyfS8udGVzdChTdHJpbmcodC5kdWUgfHwgJycpKSA_IFN0cmluZyh0LmR1ZSkuc2xpY2UoMCwgMTApIDogJyc7CiAgICBjb25zdCBtYWlsID0gKHQubGlua3MgfHwgW10pLmZpbmQobCA9PiBsICYmIGwudHlwZSA9PT0gJ2VtYWlsJyAmJiAvXmh0dHBzOlwvXC9tYWlsXC5nb29nbGVcLmNvbVwvLy50ZXN0KFN0cmluZyhsLmxpbmsgfHwgJycpKSk7CiAgICByZXR1cm4gewogICAgICBraW5kOiAndGFzaycsIGlkOiBgJHtsaXN0LmlkfXwke3QuaWR9YCwgc291cmNlOiBsaXN0LmlkLCB0aXRsZSwgZHVlLAogICAgICBkb25lOiB0LnN0YXR1cyA9PT0gJ2NvbXBsZXRlZCcsIGVtYWlsOiAhIW1haWwsCiAgICAgIGxpbms6IHNhZmVMaW5rKG1haWwgPyBtYWlsLmxpbmsgOiB0LndlYlZpZXdMaW5rKSwgbGlzdDogbGlzdC5uYW1lLAogICAgfTsKICB9CgogIC8vIFRhc2tzIGFycml2ZSB0d2ljZSB3aGVuIG9uZSBpcyBib3RoIG9wZW4gYW5kIGR1ZSBpbiB0aGUgcmFuZ2UuCiA",
"gZnVuY3Rpb24gdW5pcXVlQnlJZChpdGVtcykgewogICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoKTsKICAgIHJldHVybiBpdGVtcy5maWx0ZXIoeCA9PiAhc2Vlbi5oYXMoeC5pZCkgJiYgc2Vlbi5hZGQoeC5pZCkpOwogIH0KCiAgLy8gQWxsLWRheSBmaXJzdCwgdGhlbiBieSB0aW1lLCB0aGVuIHRoZSB0YXNrczogb3BlbiBiZWZvcmUgZG9uZS4KICBmdW5jdGlvbiBjb21wYXJlSXRlbXMoYSwgYikgewogICAgY29uc3QgcmFuayA9IHggPT4gKHgua2luZCA9PT0gJ2V2ZW50JyA_ICh4LmFsbERheSA_IDAgOiAxKSA6ICh4LmRvbmUgPyAzIDogMikpOwogICAgcmV0dXJuIHJhbmsoYSkgLSByYW5rKGIpIHx8IChhLnN0YXJ0IHx8IDApIC0gKGIuc3RhcnQgfHwgMCkgfHwgYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpOwogIH0KCiAgLy8gRGF5IGtleSDihpIgd2hhdCBpcyBvbiBpdCwgZWFjaCBlbnRyeSB7IGl0ZW0sIGNvbnQgfTogY29udCB3aGVuIGEKICAvLyB0aW1lZCBldmVudCBzdGFydGVkIG9uIGFuIGVhcmxpZXIgZGF5LgogIGZ1bmN0aW9uIGJ5RGF5KGl0ZW1zLCBkYXlLZXlzKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgTWFwKGRheUtleXMubWFwKGsgPT4gW2ssIFtdXSkpOwogICAgaWYgKCFkYXlLZXlzLmxlbmd0aCkgcmV0dXJuIG91dDsKICAgIGNvbnN0IGZpcnN0ID0gZGF5S2V5c1swXTsKICAgIGNvbnN0IGxhc3QgPSBkYXlLZXlzW2RheUtleXMubGVuZ3RoIC0gMV07CiAgICBmb3IgKGNvbnN0IGl0ZW0",
"gb2YgaXRlbXMpIHsKICAgICAgaWYgKGl0ZW0ua2luZCA9PT0gJ3Rhc2snKSB7CiAgICAgICAgaWYgKGl0ZW0uZHVlICYmIG91dC5oYXMoaXRlbS5kdWUpKSBvdXQuZ2V0KGl0ZW0uZHVlKS5wdXNoKHsgaXRlbSwgY29udDogZmFsc2UgfSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKGl0ZW0ubGFzdCA8IGZpcnN0IHx8IGl0ZW0uZmlyc3QgPiBsYXN0KSBjb250aW51ZTsKICAgICAgY29uc3QgZnJvbSA9IGl0ZW0uZmlyc3QgPCBmaXJzdCA_IGZpcnN0IDogaXRlbS5maXJzdDsKICAgICAgY29uc3QgdG8gPSBpdGVtLmxhc3QgPiBsYXN0ID8gbGFzdCA6IGl0ZW0ubGFzdDsKICAgICAgZm9yIChsZXQgayA9IGZyb207IGsgPD0gdG87IGsgPSBhZGREYXlzKGssIDEpKSB7CiAgICAgICAgaWYgKG91dC5oYXMoaykpIG91dC5nZXQoaykucHVzaCh7IGl0ZW0sIGNvbnQ6IGsgIT09IGl0ZW0uZmlyc3QgfSk7CiAgICAgIH0KICAgIH0KICAgIGZvciAoY29uc3QgbGlzdCBvZiBvdXQudmFsdWVzKCkpIGxpc3Quc29ydCgoYSwgYikgPT4gY29tcGFyZUl0ZW1zKGEuaXRlbSwgYi5pdGVtKSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gV2hhdCB3YWl0cyB1bmRlciB0aGUgd2Vlazogb3BlbiB0YXNrcyB3aXRoIG5vIGRhdGUsIGFuZCBvcGVuIHRhc2tzCiAgLy8gd2hvc2UgZGF5IGhhcyBnb25lIGJ5LgogIGZ1bmN0aW9uIHRyYXkoaXRlbXMsIHRvZGF5KSB7CiAgICBjb25zdCBvcGVuID0gaXRlbXMuZmlsdGV",
"yKHggPT4geC5raW5kID09PSAndGFzaycgJiYgIXguZG9uZSk7CiAgICByZXR1cm4gewogICAgICBvdmVyZHVlOiBvcGVuLmZpbHRlcih4ID0-IHguZHVlICYmIHguZHVlIDwgdG9kYXkpLnNvcnQoKGEsIGIpID0-IGEuZHVlLmxvY2FsZUNvbXBhcmUoYi5kdWUpIHx8IGEudGl0bGUubG9jYWxlQ29tcGFyZShiLnRpdGxlKSksCiAgICAgIHVuZGF0ZWQ6IG9wZW4uZmlsdGVyKHggPT4gIXguZHVlKSwKICAgIH07CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBTQ09QRVMsIEJBU0VTLCBVU0VSSU5GT19VUkwsIFZJRVdTLCBBR0VOREFfREFZUywgREFZX05BTUVTLCBNT05USFMsIE1PTlRIU19MT05HLCBFVkVOVF9DT0xPVVJTLAogICAgaXNBbGxvd2VkUmVxdWVzdCwgYnVpbGRVcmwsCiAgICBkYXRlS2V5LCBpc0tleSwgZnJvbUtleSwgYWRkRGF5cywgZGF5c0JldHdlZW4sIHdlZWtkYXksIHdlZWtTdGFydCwgaXNvV2VlaywgbW9udGhTdGFydCwgYWRkTW9udGhzLCBkYXlzLAogICAgdmlld1JhbmdlLCBzdGVwLCBtb250aFdlZWtzLCBzcGFuVGV4dCwgdGl0bGUsIG1vbnRoTmFtZSwgZGF5TmFtZSwKICAgIHNhZmVDb2xvdXIsIHNhZmVMaW5rLCBjYWxlbmRhclNvdXJjZSwgbGlzdFNvdXJjZSwgc291cmNlcywgaXNPbiwKICAgIHNvdXJjZVJlcXVlc3RzLCByYW5nZVJlcXVlc3RzLCBldmVudEl0ZW0sIHRhc2tJdGVtLCB1bmlxdWVCeUlkLCBjb21wYXJlSXRlbXMsIGJ5RGF5LCB0cmF5LAogIH07CgogIG5zLmNhbGVuZGFyTG9",
"naWMgPSBhcGk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKfSkoKTsK\"],[\"src/content/ui.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIERPTSB0b29sa2l0IGZvciB0aGUgaW5qZWN0ZWQgVUkKLy8KLy8gR21haWwgZW5mb3JjZXMgVHJ1c3RlZCBUeXBlcyBvbiBpdHMgcGFnZSwgdW5kZXIgd2hpY2ggaW5uZXJIVE1MIGFuZAovLyBmcmllbmRzIHRocm93LiBDaHJvbWl1bSBjdXJyZW50bHkgZXhlbXB0cyBhIGNvbnRlbnQgc2NyaXB0J3MgaXNvbGF0ZWQKLy8gd29ybGQgZnJvbSB0aGF0IHBvbGljeSwgYnV0IG5vdGhpbmcgcHJvbWlzZXMgaXQgYWx3YXlzIHdpbGwgLSBhbmQgbWFpbAovLyBzdWJqZWN0cyBhcmUgdW50cnVzdGVkIHRleHQgcmVnYXJkbGVzcy4gU28gZXZlcnkgbm9kZSBoZXJlIGlzIGJ1aWx0Ci8vIHdpdGggY3JlYXRlRWxlbWVudCAvIGNyZWF0ZUVsZW1lbnROUyBhbmQgZmlsbGVkIHdpdGggdGV4dENvbnRlbnQuIEFsbAovLyBvZiBpdCBsaXZlcyBpbiBzaGFkb3cgcm9vdH",
"Mgc28gR21haWwncyBzdHlsZXNoZWV0IGFuZCBvdXJzIG5ldmVyIG1lZXQuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgRWxlbWVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFByb3BlcnRpZXMgdGhhdCBtdXN0IGJlIHNldCBhcyBwcm9wZXJ0aWVzLCBub3QgYXR0cmlidXRlcywgdG8gdGFrZQogIC8vIGVmZmVjdCBhZnRlciBmaXJzdCByZW5kZXIgKGFuIGlucHV0J3MgdmFsdWUsIGEgY2hlY2tib3gncyBzdGF0ZSkuCiAgY29uc3QgUFJPUFMgPSBuZXcgU2V0KFsndmFsdWUnLCAnY2hlY2tlZCcsICdkaXNhYmxlZCcsICdoaWRkZW4nXSk7Cg",
"ogIGZ1bmN0aW9uIGgodGFnLCBwcm9wcywgLi4ua2lkcykgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7CiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhwcm9wcyB8fCB7fSkpIHsKICAgICAgaWYgKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsIHx8IHYgPT09IGZhbHNlKSBjb250aW51ZTsKICAgICAgaWYgKGsgPT09ICdjbGFzcycpIGVsLmNsYXNzTmFtZSA9IEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcihCb29sZWFuKS5qb2luKCcgJykgOiB2OwogICAgICBlbHNlIGlmIChrID09PSAndGV4dCcpIGVsLnRleHRDb250ZW50ID0gU3RyaW5nKHYpOwogICAgICBlbHNlIGlmIChrID09PSAnZGF0YXNldCcpIE9iamVjdC5hc3NpZ24oZWwuZGF0YXNldCwgdik7CiAgICAgIGVsc2UgaWYgKGsuc3RhcnRzV2l0aCgnb24nKSAmJiB0eXBlb2YgdiA9PT0gJ2Z1bmN0aW9uJykgZWwuYWRkRXZlbnRMaXN0ZW5lcihrLnNsaWNlKDIpLCB2KTsKICAgICAgZWxzZSBpZiAoUFJPUFMuaGFzKGspKSBlbFtrXSA9IHY7CiAgICAgIGVsc2UgZWwuc2V0QXR0cmlidXRlKGssIHYgPT09IHRydWUgPyAnJyA6IFN0cmluZyh2KSk7CiAgICB9CiAgICBhcHBlbmQoZWwsIGtpZHMpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgZnVuY3Rpb24gYXBwZW5kKGVsLCBraWRzKSB7CiAgICBmb3IgKGNvbnN0IGtpZCBvZiBraWRzLmZsYXQoSW5maW5pdHkpKSB7CiAgICAgIGlmIChraWQgPT",
"09IG51bGwgfHwga2lkID09PSB1bmRlZmluZWQgfHwga2lkID09PSBmYWxzZSkgY29udGludWU7CiAgICAgIGVsLmFwcGVuZENoaWxkKHR5cGVvZiBraWQgPT09ICdzdHJpbmcnIHx8IHR5cGVvZiBraWQgPT09ICdudW1iZXInCiAgICAgICAgPyBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShTdHJpbmcoa2lkKSkgOiBraWQpOwogICAgfQogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIEljb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTWF0ZXJpYWwgU3ltYm9scyBwYXRocyAoQXBhY2hlIDIuMCksIHBsdXMgdGhlIGJvYXJkIGdseXBoIGRyYXduIHRvCiAgLy8gbWF0Y2ggdGhlIHRvb2xiYXIgaWNvbi4KCiAgY29uc3QgYmFyID0gKHgsIHksIHcsIGh0KSA9PgogICAgYE0ke3ggKyAxfSAke3l9aCR7dyAtIDJ9YTEgMSAwIDAgMSAxIDF2JHtodCAtIDJ9YTEgMSAwIDAgMS0xIDFoLSR7dyAtIDJ9YTEgMSAwIDAgMS0xLTF2LSR7aHQgLSAyfWExIDEgMCAwIDEgMS0xemA7CgogIGNvbnN0IElDT05TID0gewogICAgYm9hcmQ6IGJhcigzLCA0LCA1LCAxNikgKyBiYXIoOS41LCA0LCA1LCAxMCkgKyBiYXIoMTYsIDQsIDUsID",
"EzKSwKICAgIGNsb3NlOiAnTTE5IDYuNDEgMTcuNTkgNSAxMiAxMC41OSA2LjQxIDUgNSA2LjQxIDEwLjU5IDEyIDUgMTcuNTkgNi40MSAxOSAxMiAxMy40MSAxNy41OSAxOSAxOSAxNy41OSAxMy40MSAxMnonLAogICAgcmVmcmVzaDogJ00xNy42NSA2LjM1QTcuOTYgNy45NiAwIDAgMCAxMiA0YTggOCAwIDEgMCA3LjczIDEwaC0yLjA4QTYgNiAwIDEgMSAxMiA2YzEuNjYgMCAzLjE0LjY5IDQuMjIgMS43OEwxMyAxMWg3VjRsLTIuMzUgMi4zNXonLAogICAgYWRkOiAnTTE5IDEzaC02djZoLTJ2LTZINXYtMmg2VjVoMnY2aDZ2MnonLAogICAgbW9yZTogJ002IDEwYTIgMiAwIDEgMCAwIDQgMiAyIDAgMCAwIDAtNHptMTIgMGEyIDIgMCAxIDAgMCA0IDIgMiAwIDAgMCAwLTR6bS02IDBhMiAyIDAgMSAwIDAgNCAyIDIgMCAwIDAgMC00eicsCiAgICBzdGFyOiAnTTEyIDE3LjI3IDE4LjE4IDIxbC0xLjY0LTcuMDNMMjIgOS4yNGwtNy4xOS0uNjFMMTIgMiA5LjE5IDguNjMgMiA5LjI0bDUuNDYgNC43M0w1LjgyIDIxeicsCiAgICB0dW5lOiAnTTMgMTd2Mmg2di0ySDN6TTMgNXYyaDEwVjVIM3ptMTAgMTZ2LTJoOHYtMmgtOHYtMmgtMnY2aDJ6TTcgOXYySDN2Mmg0djJoMlY5SDd6bTE0IDR2LTJIMTF2MmgxMHptLTYtNGgyVjdoNFY1aC00VjNoLTJ2NnonLAogICAgdXA6ICdNNCAxMmwxLjQxIDEuNDFMMTEgNy44M1YyMGgyVjcuODNsNS41OCA1LjU5TDIwIDEybC04LTgtOCA4eicsCiAgICBkb3duOiAnTTIwIDEybC0xLjQxLT",
"EuNDFMMTMgMTYuMTdWNGgtMnYxMi4xN2wtNS41OC01LjU5TDQgMTJsOCA4IDgtOHonLAogICAgc2VhcmNoOiAnTTE1LjUgMTRoLS43OWwtLjI4LS4yN0E2LjQ3IDYuNDcgMCAwIDAgMTYgOS41IDYuNSA2LjUgMCAxIDAgOS41IDE2YzEuNjEgMCAzLjA5LS41OSA0LjIzLTEuNTdsLjI3LjI4di43OWw1IDQuOTlMMjAuNDkgMTlsLTQuOTktNXptLTYgMEM3LjAxIDE0IDUgMTEuOTkgNSA5LjVTNy4wMSA1IDkuNSA1IDE0IDcuMDEgMTQgOS41IDExLjk5IDE0IDkuNSAxNHonLAogICAgY2hlY2s6ICdNOSAxNi4xNyA0LjgzIDEybC0xLjQyIDEuNDFMOSAxOSAyMSA3bC0xLjQxLTEuNDF6JywKICAgIGNhcmV0OiAnTTcgMTBsNSA1IDUtNXonLAogICAgb3BlbjogJ00xOSAxOUg1VjVoN1YzSDVhMiAyIDAgMCAwLTIgMnYxNGEyIDIgMCAwIDAgMiAyaDE0YzEuMSAwIDItLjkgMi0ydi03aC0ydjd6TTE0IDN2MmgzLjU5bC05LjgzIDkuODMgMS40MSAxLjQxTDE5IDYuNDFWMTBoMlYzaC03eicsCiAgICBjYWxlbmRhcjogJ00yMCAzaC0xVjFoLTJ2Mkg3VjFINXYySDRjLTEuMSAwLTIgLjktMiAydjE2YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNWMwLTEuMS0uOS0yLTItMnptMCAxOEg0VjEwaDE2djExem0wLTEzSDRWNWgxNnYzeicsCiAgICBwcmV2OiAnTTE1LjQxIDcuNDEgMTQgNmwtNiA2IDYgNiAxLjQxLTEuNDFMMTAuODMgMTJ6JywKICAgIG5leHQ6ICdNMTAgNiA4LjU5IDcuNDEgMTMuMTcgMTJsLTQuNTggNC41OU",
"wxMCAxOGw2LTZ6JywKICAgIG1haWw6ICdNMjAgNEg0Yy0xLjEgMC0xLjk5LjktMS45OSAyTDIgMThjMCAxLjEuOSAyIDIgMmgxNmMxLjEgMCAyLS45IDItMlY2YzAtMS4xLS45LTItMi0yem0wIDQtOCA1LTgtNVY2bDggNSA4LTV2MnonLAogICAgYmFjazogJ00yMCAxMUg3LjgzbDUuNTktNS41OUwxMiA0bC04IDggOCA4IDEuNDEtMS40MUw3LjgzIDEzSDIwdi0yeicsCiAgICBhcnJvdzogJ00xMiA0bC0xLjQxIDEuNDFMMTYuMTcgMTFINHYyaDEyLjE3bC01LjU4IDUuNTlMMTIgMjBsOC04eicsCiAgICByZW1vdmU6ICdNMTkgMTNINXYtMmgxNHYyeicsCiAgICBub3RlOiAnTTE0IDJINmMtMS4xIDAtMS45OS45LTEuOTkgMkw0IDIwYzAgMS4xLjg5IDIgMS45OSAySDE4YzEuMSAwIDItLjkgMi0yVjhsLTYtNnptMiAxNkg4di0yaDh2MnptMC00SDh2LTJoOHYyem0tMy01VjMuNUwxOC41IDlIMTN6JywKICAgIGRlbGV0ZTogJ002IDE5YzAgMS4xLjkgMiAyIDJoOGMxLjEgMCAyLS45IDItMlY3SDZ2MTJ6TTE5IDRoLTMuNWwtMS0xaC01bC0xIDFINXYyaDE0VjR6JywKICAgIGVkaXQ6ICdNMyAxNy4yNVYyMWgzLjc1TDE3LjgxIDkuOTRsLTMuNzUtMy43NUwzIDE3LjI1ek0yMC43MSA3LjA0YTEgMSAwIDAgMCAwLTEuNDFsLTIuMzQtMi4zNGExIDEgMCAwIDAtMS40MSAwbC0xLjgzIDEuODMgMy43NSAzLjc1IDEuODMtMS44M3onLAogICAgZm9sZGVyOiAnTTEwIDRINGMtMS4xIDAtMS45OS45LTEuOTkgMkwyIDE4YzAgMS4xLj",
"kgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWOGMwLTEuMS0uOS0yLTItMmgtOGwtMi0yeicsCiAgICBub3RlczogJ00zIDE4aDEydi0ySDN2MnpNMyA2djJoMThWNkgzem0wIDdoMTh2LTJIM3YyeicsCiAgICAvLyBGb3JtYXR0aW5nIHRvb2xiYXIuCiAgICBib2xkOiAnTTE1LjYgMTAuNzljLjk3LS42NyAxLjY1LTEuNzcgMS42NS0yLjc5IDAtMi4yNi0xLjc1LTQtNC00SDd2MTRoNy4wNGMyLjA5IDAgMy43MS0xLjcgMy43MS0zLjc5IDAtMS41Mi0uODYtMi44Mi0yLjE1LTMuNDJ6TTEwIDYuNWgzYy44MyAwIDEuNS42NyAxLjUgMS41cy0uNjcgMS41LTEuNSAxLjVoLTN2LTN6bTMuNSA5SDEwdi0zaDMuNWMuODMgMCAxLjUuNjcgMS41IDEuNXMtLjY3IDEuNS0xLjUgMS41eicsCiAgICBpdGFsaWM6ICdNMTAgNHYzaDIuMjFsLTMuNDIgOEg2djNoOHYtM2gtMi4yMWwzLjQyLThIMThWNHonLAogICAgc3RyaWtlOiAnTTEwIDE5aDR2LTNoLTR2M3pNNSA0djNoNXYzaDRWN2g1VjRINXpNMyAxNGgxOHYtMkgzdjJ6JywKICAgIGJ1bGxldHM6ICdNNCAxMC41Yy0uODMgMC0xLjUuNjctMS41IDEuNXMuNjcgMS41IDEuNSAxLjUgMS41LS42NyAxLjUtMS41LS42Ny0xLjUtMS41LTEuNXptMC02Yy0uODMgMC0xLjUuNjctMS41IDEuNVMzLjE3IDcuNSA0IDcuNSA1LjUgNi44MyA1LjUgNiA0LjgzIDQuNSA0IDQuNXptMCAxMmMtLjgzIDAtMS41LjY4LTEuNSAxLjVzLjY4IDEuNSAxLjUgMS41IDEuNS0uNjggMS41LTEuNS0uNjctMS41LT",
"EuNS0xLjV6TTcgMTloMTR2LTJIN3Yyem0wLTZoMTR2LTJIN3Yyem0wLTh2MmgxNFY1SDd6JywKICAgIG51bWJlcnM6ICdNMiAxN2gydi41SDN2MWgxdi41SDJ2MWgzdi00SDJ2MXptMS05aDFWNEgydjFoMXYzem0tMSAzaDEuOEwyIDEzLjF2LjloM3YtMUgzLjJMNSAxMC45VjEwSDJ2MXptNS02djJoMTRWNUg3em0wIDE0aDE0di0ySDd2MnptMC02aDE0di0ySDd2MnonLAogICAgY2hlY2tsaXN0OiAnTTIyIDdoLTl2Mmg5Vjd6bTAgOGgtOXYyaDl2LTJ6TTUuNTQgMTEgMiA3LjQ2bDEuNDEtMS40MSAyLjEyIDIuMTIgNC4yNC00LjI0IDEuNDEgMS40MUw1LjU0IDExem0wIDhMMiAxNS40NmwxLjQxLTEuNDEgMi4xMiAyLjEyIDQuMjQtNC4yNCAxLjQxIDEuNDFMNS41NCAxOXonLAogICAgaW5kZW50OiAnTTMgMjFoMTh2LTJIM3Yyek0zIDh2OGw0LTQtNC00em04IDloMTB2LTJIMTF2MnpNMyAzdjJoMThWM0gzem04IDZoMTBWN0gxMXYyem0wIDRoMTB2LTJIMTF2MnonLAogICAgb3V0ZGVudDogJ00xMSAxN2gxMHYtMkgxMXYyem0tOC01IDQgNFY4bC00IDR6bTAgOWgxOHYtMkgzdjJ6TTMgM3YyaDE4VjNIM3ptOCA2aDEwVjdIMTF2MnptMCA0aDEwdi0ySDExdjJ6JywKICAgIGxpbms6ICdNMy45IDEyYzAtMS43MSAxLjM5LTMuMSAzLjEtMy4xaDRWN0g3Yy0yLjc2IDAtNSAyLjI0LTUgNXMyLjI0IDUgNSA1aDR2LTEuOUg3Yy0xLjcxIDAtMy4xLTEuMzktMy4xLTMuMXpNOCAxM2g4di0ySDh2MnptOS02aC00djEuOWg0YzEuNz",
"EgMCAzLjEgMS4zOSAzLjEgMy4xcy0xLjM5IDMuMS0zLjEgMy4xaC00VjE3aDRjMi43NiAwIDUtMi4yNCA1LTVzLTIuMjQtNS01LTV6JywKICAgIGNsZWFyOiAnTTMuMjcgNSAyIDYuMjdsNi45NyA2Ljk3TDYuNSAxOWgzbDEuNTctMy42NkwxNi43MyAyMSAxOCAxOS43MyAzLjU1IDUuMjcgMy4yNyA1ek02IDV2LjE4TDguODIgOGgyLjRsLS43MiAxLjY4IDIuMSAyLjFMMTQuMjEgOEgyMFY1SDZ6JywKICB9OwoKICBjb25zdCBTVkdfTlMgPSAnaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnOwoKICBmdW5jdGlvbiBpY29uKG5hbWUsIHNpemUgPSAyMCkgewogICAgY29uc3Qgc3ZnID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudE5TKFNWR19OUywgJ3N2ZycpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgndmlld0JveCcsICcwIDAgMjQgMjQnKTsKICAgIHN2Zy5zZXRBdHRyaWJ1dGUoJ3dpZHRoJywgU3RyaW5nKHNpemUpKTsKICAgIHN2Zy5zZXRBdHRyaWJ1dGUoJ2hlaWdodCcsIFN0cmluZyhzaXplKSk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCdhcmlhLWhpZGRlbicsICd0cnVlJyk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCdmb2N1c2FibGUnLCAnZmFsc2UnKTsKICAgIHN2Zy5zZXRBdHRyaWJ1dGUoJ2NsYXNzJywgJ2ljb24nKTsKICAgIGNvbnN0IHBhdGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50TlMoU1ZHX05TLCAncGF0aCcpOwogICAgcGF0aC5zZXRBdHRyaWJ1dGUoJ2QnLCBJQ09OU1tuYW1lXSB8fCAnJyk7CiAgICBwYX",
"RoLnNldEF0dHJpYnV0ZSgnZmlsbCcsICdjdXJyZW50Q29sb3InKTsKICAgIHN2Zy5hcHBlbmRDaGlsZChwYXRoKTsKICAgIHJldHVybiBzdmc7CiAgfQoKICAvLyBUaGUgYXBwJ3MgbWFyazogIlNtIiBvbiBhIHZpb2xldCBjaXJjbGUsIGFzIGljb25zL2ljb24uc3ZnIGRyYXdzCiAgLy8gaXQgKGEgdGVzdCBrZWVwcyB0aGUgdHdvIHRoZSBzYW1lKS4KICBjb25zdCBMT0dPID0gewogICAgY29sb3VyczogWycjNkQyOEQ5JywgJyM5RjY3RkEnXSwKICAgIGxldHRlcnM6ICdNNjAuMDkgNzYuNzNRNjAuMDkgODIuOTggNTUuNDUgODYuMjlRNTAuODEgODkuNiA0MS44MyA4OS42UTMzLjY0IDg5LjYgMjguOTkgODYuN1EyNC4zMyA4My44IDIzIDc3LjlMMzEuNjIgNzYuNDhRMzIuNDkgNzkuODcgMzUuMDMgODEuNFEzNy41NyA4Mi45MiA0Mi4wOCA4Mi45MlE1MS40MiA4Mi45MiA1MS40MiA3Ny4yNFE1MS40MiA3NS40MyA1MC4zNCA3NC4yNVE0OS4yNyA3My4wNyA0Ny4zMiA3Mi4yOFE0NS4zNyA3MS41IDM5Ljg0IDcwLjM4UTM1LjA2IDY5LjI2IDMzLjE5IDY4LjU4UTMxLjMxIDY3LjkgMjkuOCA2Ni45OFEyOC4yOSA2Ni4wNSAyNy4yMyA2NC43NVEyNi4xNyA2My40NSAyNS41OCA2MS43UTI1IDU5Ljk1IDI1IDU3LjY4UTI1IDUxLjkxIDI5LjMzIDQ4Ljg0UTMzLjY3IDQ1Ljc3IDQxLjk2IDQ1Ljc3UTQ5Ljg4IDQ1Ljc3IDUzLjg1IDQ4LjI1UTU3LjgzIDUwLjczIDU4Ljk4IDU2LjQ0TDUwLjMzIDU3LjYyUTQ5LjY2IDU0Ljg3ID",
"Q3LjYyIDUzLjQ4UTQ1LjU4IDUyLjA5IDQxLjc3IDUyLjA5UTMzLjY3IDUyLjA5IDMzLjY3IDU3LjE3UTMzLjY3IDU4LjgzIDM0LjUzIDU5Ljg5UTM1LjM5IDYwLjk1IDM3LjA5IDYxLjY5UTM4Ljc4IDYyLjQzIDQzLjk1IDYzLjU0UTUwLjA5IDY0Ljg0IDUyLjczIDY1Ljk1UTU1LjM4IDY3LjA1IDU2LjkyIDY4LjUyUTU4LjQ2IDY5Ljk4IDU5LjI4IDcyLjAyUTYwLjA5IDc0LjA3IDYwLjA5IDc2LjczWiBNODIuMDggODkuOTJWNzQuNjlRODIuMDggNjcuNTQgNzcuOTYgNjcuNTRRNzUuODMgNjcuNTQgNzQuNDkgNjkuNzNRNzMuMTUgNzEuOTEgNzMuMTUgNzUuMzdWODkuOTJINjYuMVY2OC44NVE2Ni4xIDY2LjY3IDY2LjA0IDY1LjI4UTY1Ljk3IDYzLjg4IDY1LjkgNjIuNzhINzIuNjJRNzIuNyA2My4yNiA3Mi44MiA2NS4zM1E3Mi45NSA2Ny4zOSA3Mi45NSA2OC4xN0g3My4wNVE3NC4zNSA2NS4wNiA3Ni4yOSA2My42NlE3OC4yNCA2Mi4yNSA4MC45NSA2Mi4yNVE4Ny4xNyA2Mi4yNSA4OC41IDY4LjE3SDg4LjY1UTkwLjAzIDY1LjAxIDkxLjk2IDYzLjYzUTkzLjg5IDYyLjI1IDk2Ljg3IDYyLjI1UTEwMC44NCA2Mi4yNSAxMDIuOTIgNjQuOTVRMTA1IDY3LjY1IDEwNSA3Mi42OVY4OS45Mkg5OFY3NC42OVE5OCA2Ny41NCA5My44OSA2Ny41NFE5MS44MyA2Ny41NCA5MC41MiA2OS41NFE4OS4yIDcxLjUzIDg5LjA3IDc1LjA0Vjg5LjkyWicsCiAgfTsKICBsZXQgbG9nb0NvdW50ID0gMDsKCiAgZnVuY3Rpb24gbG9nbyhzaX",
"plID0gMjgpIHsKICAgIGNvbnN0IGVsID0gKHRhZywgYXR0cnMpID0-IHsKICAgICAgY29uc3QgbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhTVkdfTlMsIHRhZyk7CiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGF0dHJzKSkgbi5zZXRBdHRyaWJ1dGUoaywgdik7CiAgICAgIHJldHVybiBuOwogICAgfTsKICAgIC8vIEVhY2ggY29weSBpdHMgb3duIGdyYWRpZW50IGlkOiB0d28gbWFya3MgaW4gb25lIHBhZ2UgbXVzdCBub3Qgc2hhcmUuCiAgICBjb25zdCBpZCA9IGBna2ItbG9nby0keysrbG9nb0NvdW50fWA7CiAgICBjb25zdCBncmFkID0gZWwoJ2xpbmVhckdyYWRpZW50JywgeyBpZCwgeDE6ICcwJywgeTE6ICcwJywgeDI6ICcxJywgeTI6ICcxJyB9KTsKICAgIGdyYWQuYXBwZW5kKGVsKCdzdG9wJywgeyBvZmZzZXQ6ICcwJywgJ3N0b3AtY29sb3InOiBMT0dPLmNvbG91cnNbMF0gfSksIGVsKCdzdG9wJywgeyBvZmZzZXQ6ICcxJywgJ3N0b3AtY29sb3InOiBMT0dPLmNvbG91cnNbMV0gfSkpOwogICAgY29uc3QgZGVmcyA9IGVsKCdkZWZzJywge30pOwogICAgZGVmcy5hcHBlbmQoZ3JhZCk7CiAgICBjb25zdCBzdmcgPSBlbCgnc3ZnJywgeyB2aWV3Qm94OiAnOCA4IDExMiAxMTInLCB3aWR0aDogU3RyaW5nKHNpemUpLCBoZWlnaHQ6IFN0cmluZyhzaXplKSwgJ2FyaWEtaGlkZGVuJzogJ3RydWUnLCBmb2N1c2FibGU6ICdmYWxzZScsIGNsYXNzOiAnbG9nby1tYXJrJyB9KTsKIC",
"AgIHN2Zy5hcHBlbmQoZGVmcywgZWwoJ2NpcmNsZScsIHsgY3g6ICc2NCcsIGN5OiAnNjQnLCByOiAnNTYnLCBmaWxsOiBgdXJsKCMke2lkfSlgIH0pLCBlbCgncGF0aCcsIHsgZDogTE9HTy5sZXR0ZXJzLCBmaWxsOiAnI2ZmZicgfSkpOwogICAgcmV0dXJuIHN2ZzsKICB9CgogIC8vIOKUgOKUgCBTaGFkb3cgaG9zdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGFkb3B0U3R5bGVzKHJvb3QsIGNzc1RleHQpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHNoZWV0ID0gbmV3IENTU1N0eWxlU2hlZXQoKTsKICAgICAgc2hlZXQucmVwbGFjZVN5bmMoY3NzVGV4dCk7CiAgICAgIHJvb3QuYWRvcHRlZFN0eWxlU2hlZXRzID0gW3NoZWV0XTsKICAgICAgcmV0dXJuOwogICAgfSBjYXRjaCB7IC8qIG9sZGVyIGVuZ2luZSBvciBhIGhvc3RpbGUgQ1NQOiBmYWxsIHRocm91Z2ggKi8gfQogICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpOwogICAgc3R5bGUudGV4dENvbnRlbnQgPSBjc3NUZXh0OwogICAgcm9vdC5hcHBlbmRDaGlsZChzdHlsZSk7CiAgfQoKICBmdW5jdGlvbiBtb3VudFNoYWRvdyhpZCwgY3NzVGV4dCkgewogICAgLy",
"8gQSBwcmV2aW91cyBpbmplY3Rpb24gKGV4dGVuc2lvbiByZWxvYWRlZCB3aXRob3V0IHJlbG9hZGluZyBHbWFpbCkKICAgIC8vIGxlYXZlcyBhbiBvcnBoYW5lZCBob3N0IGJlaGluZDsgcmVwbGFjZSBpdCByYXRoZXIgdGhhbiBzdGFjayBhIHNlY29uZC4KICAgIGNvbnN0IHN0YWxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgaWYgKHN0YWxlKSBzdGFsZS5yZW1vdmUoKTsKCiAgICBjb25zdCBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBob3N0LmlkID0gaWQ7CiAgICBjb25zdCByb290ID0gaG9zdC5hdHRhY2hTaGFkb3coeyBtb2RlOiAnb3BlbicgfSk7CiAgICBhZG9wdFN0eWxlcyhyb290LCBjc3NUZXh0KTsKCiAgICAvLyBLZXkgZXZlbnRzIGZyb20gaW5zaWRlIGEgc2hhZG93IHJvb3QgcmVhY2ggR21haWwgcmV0YXJnZXRlZCB0byB0aGUKICAgIC8vIGhvc3QsIHdoaWNoIGlzIG5vdCBhbiBpbnB1dCAtIHNvIHR5cGluZyAiYyIgaW4gb3VyIHNlYXJjaCBib3ggd291bGQKICAgIC8vIG9wZW4gR21haWwncyBDb21wb3NlLiBPdXIgb3duIGhhbmRsZXJzIGluc2lkZSB0aGUgcm9vdCBydW4gZmlyc3Q7CiAgICAvLyBzdG9wcGluZyBwcm9wYWdhdGlvbiBoZXJlIGtlZXBzIEdtYWlsJ3Mgc2hvcnRjdXRzIG91dCBvZiBpdC4KICAgIGZvciAoY29uc3QgdHlwZSBvZiBbJ2tleWRvd24nLCAna2V5cHJlc3MnLCAna2V5dXAnXSkgewogICAgICBob3N0LmFkZEV2ZW50TGlzdG",
"VuZXIodHlwZSwgZSA9PiBlLnN0b3BQcm9wYWdhdGlvbigpKTsKICAgIH0KCiAgICAoZG9jdW1lbnQuYm9keSB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQpLmFwcGVuZENoaWxkKGhvc3QpOwogICAgcmV0dXJuIHsgaG9zdCwgcm9vdCB9OwogIH0KCiAgLy8g4pSA4pSAIFRvYXN0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gdG9hc3RMYXllcihyb290KSB7CiAgICBsZXQgbGF5ZXIgPSByb290LnF1ZXJ5U2VsZWN0b3IoJy50b2FzdHMnKTsKICAgIGlmICghbGF5ZXIpIHsKICAgICAgbGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAndG9hc3RzJywgcm9sZTogJ3N0YXR1cycsICdhcmlhLWxpdmUnOiAncG9saXRlJyB9KTsKICAgICAgcm9vdC5hcHBlbmRDaGlsZChsYXllcik7CiAgICB9CiAgICByZXR1cm4gbGF5ZXI7CiAgfQoKICBmdW5jdGlvbiB0b2FzdChyb290LCBtZXNzYWdlLCB7IGtpbmQgPSAnaW5mbycsIGFjdGlvbiA9IG51bGwsIHRpbWVvdXQgfSA9IHt9KSB7CiAgICBjb25zdCBsYXllciA9IHRvYXN0TGF5ZXIocm9vdCk7CiAgICAvLyBBIG5ldyBjb25maXJtYXRpb24gcmVwbGFjZXMgdGhlIGxhc3Qgb25lIHJhdG",
"hlciB0aGFuIHN0YWNraW5nIHVwOwogICAgLy8gZXJyb3JzIHN0YXkgdW50aWwgcmVhZCBvciB0aW1lZCBvdXQuIE9uZSBzdGlsbCBvZmZlcmluZyBhbiBhY3Rpb24KICAgIC8vIChVbmRvKSBpcyBrZXB0IHRvbywgc2luY2UgaXRzIGJ1dHRvbiBtYXkgYmUgYWJvdXQgdG8gYmUgY2xpY2tlZC4KICAgIGlmIChraW5kICE9PSAnZXJyb3InKSB7CiAgICAgIGZvciAoY29uc3Qgb2xkIG9mIGxheWVyLnF1ZXJ5U2VsZWN0b3JBbGwoJy50b2FzdDpub3QoLnRvYXN0LWVycm9yKScpKSB7CiAgICAgICAgaWYgKCFvbGQucXVlcnlTZWxlY3RvcignLnRvYXN0LWFjdGlvbicpKSBvbGQucmVtb3ZlKCk7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGNsb3NlID0gKCkgPT4gZWwucmVtb3ZlKCk7CiAgICBjb25zdCBlbCA9IGgoJ2RpdicsIHsgY2xhc3M6IFsndG9hc3QnLCBraW5kID09PSAnZXJyb3InICYmICd0b2FzdC1lcnJvciddIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndG9hc3QtdGV4dCcsIHRleHQ6IG1lc3NhZ2UgfSksCiAgICAgIGFjdGlvbiAmJiBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICd0b2FzdC1hY3Rpb24nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYWN0aW9uLmxhYmVsLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgYWN0aW9uLm9uQ2xpY2soKTsgfSwKICAgICAgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICd0b2FzdC1jbG9zZSBpY29uLWJ0bicsIHR5cGU6ICdidXR0b2",
"4nLCAnYXJpYS1sYWJlbCc6ICdEaXNtaXNzJywgb25jbGljazogY2xvc2UgfSwKICAgICAgICBpY29uKCdjbG9zZScsIDE4KSkKICAgICk7CiAgICBsYXllci5hcHBlbmRDaGlsZChlbCk7CiAgICAvLyBFcnJvcnMgc3RheSBhIGxpdHRsZSBsb25nZXI6IHRoZXkgdXN1YWxseSBuZWVkIHJlYWRpbmcsIG5vdCBnbGFuY2luZy4KICAgIHNldFRpbWVvdXQoY2xvc2UsIHRpbWVvdXQgfHwgKGtpbmQgPT09ICdlcnJvcicgPyA5MDAwIDogNTAwMCkpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIE1lbnVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gaXRlbXM6IHsgbGFiZWwsIG9uU2VsZWN0LCBpY29uPywgY2hlY2tlZD8sIGRpc2FibGVkPywgZGFuZ2VyPyB9CiAgLy8gICAgICB8IHsgaGVhZGluZyB9IHwgeyBzZXBhcmF0b3I6IHRydWUgfQoKICBjb25zdCBvcGVuTWVudXMgPSBuZXcgV2Vha01hcCgpOyAvLyByb290IOKGkiBjbG9zZSBmdW5jdGlvbgoKICBmdW5jdGlvbiBjbG9zZU1lbnUocm9vdCkgewogICAgY29uc3QgY2xvc2UgPSBvcGVuTWVudXMuZ2V0KHJvb3QpOwogICAgaWYgKGNsb3NlKSBjbG9zZSgpOwogIH",
"0KCiAgZnVuY3Rpb24gaXNNZW51T3Blbihyb290KSB7CiAgICByZXR1cm4gb3Blbk1lbnVzLmhhcyhyb290KTsKICB9CgogIGZ1bmN0aW9uIG9wZW5NZW51KHJvb3QsIGFuY2hvciwgaXRlbXMsIHsgbGFiZWwgPSAnQWN0aW9ucycsIHBsYWNlbWVudCA9ICdiZWxvdycgfSA9IHt9KSB7CiAgICBjbG9zZU1lbnUocm9vdCk7CgogICAgY29uc3QgbWVudSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51Jywgcm9sZTogJ21lbnUnLCAnYXJpYS1sYWJlbCc6IGxhYmVsIH0pOwogICAgZm9yIChjb25zdCBpdCBvZiBpdGVtcykgewogICAgICBpZiAoaXQuc2VwYXJhdG9yKSB7IG1lbnUuYXBwZW5kQ2hpbGQoaCgnZGl2JywgeyBjbGFzczogJ21lbnUtc2VwJywgcm9sZTogJ3NlcGFyYXRvcicgfSkpOyBjb250aW51ZTsgfQogICAgICBpZiAoaXQuaGVhZGluZykgeyBtZW51LmFwcGVuZENoaWxkKGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51LWhlYWRpbmcnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScsIHRleHQ6IGl0LmhlYWRpbmcgfSkpOyBjb250aW51ZTsgfQogICAgICBjb25zdCByb2xlID0gaXQuY2hlY2tlZCA9PT0gdW5kZWZpbmVkID8gJ21lbnVpdGVtJyA6ICdtZW51aXRlbXJhZGlvJzsKICAgICAgbWVudS5hcHBlbmRDaGlsZChoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6IFsnbWVudS1pdGVtJywgaXQuZGFuZ2VyICYmICdkYW5nZXInXSwKICAgICAgICB0eXBlOiAnYnV0dG9uJywKICAgICAgICByb2xlLAogICAgICAgICdhcm",
"lhLWNoZWNrZWQnOiBpdC5jaGVja2VkID09PSB1bmRlZmluZWQgPyBudWxsIDogU3RyaW5nKCEhaXQuY2hlY2tlZCksCiAgICAgICAgZGlzYWJsZWQ6ICEhaXQuZGlzYWJsZWQsCiAgICAgICAgZGF0YXNldDogaXQua2V5ID8geyBrZXk6IGl0LmtleSB9IDogdW5kZWZpbmVkLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgaXQub25TZWxlY3QoKTsgfSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtaWNvbicgfSwgaXQuY2hlY2tlZCA_IGljb24oJ2NoZWNrJywgMTgpIDogKGl0Lmljb24gPyBpY29uKGl0Lmljb24sIDE4KSA6IG51bGwpKSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtbGFiZWwnLCB0ZXh0OiBpdC5sYWJlbCB9KQogICAgICApKTsKICAgIH0KCiAgICByb290LmFwcGVuZENoaWxkKG1lbnUpOwogICAgYW5jaG9yLnNldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsICd0cnVlJyk7CgogICAgLy8gRml4ZWQgcG9zaXRpb25pbmcgYWdhaW5zdCB0aGUgYW5jaG9yLCBmbGlwcGVkIG9yIG51ZGdlZCBzbyB0aGUgbWVudQogICAgLy8gbmV2ZXIgcnVucyBvZmYgdGhlIHZpZXdwb3J0IGVkZ2UuCiAgICBjb25zdCByID0gYW5jaG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgbXcgPSBtZW51Lm9mZnNldFdpZHRoOwogICAgY29uc3QgbWggPSBtZW51Lm9mZnNldEhlaWdodDsKICAgIGxldCBsZWZ0ID0gTWF0aC5taW4oci5sZWZ0LCB3aW",
"5kb3cuaW5uZXJXaWR0aCAtIG13IC0gOCk7CiAgICBpZiAoci5yaWdodCAtIG13ID4gOCAmJiBsZWZ0ICsgbXcgPiB3aW5kb3cuaW5uZXJXaWR0aCAtIDgpIGxlZnQgPSByLnJpZ2h0IC0gbXc7CiAgICBsZWZ0ID0gTWF0aC5tYXgoOCwgbGVmdCk7CiAgICBsZXQgdG9wID0gcGxhY2VtZW50ID09PSAnYWJvdmUnID8gci50b3AgLSBtaCAtIDYgOiByLmJvdHRvbSArIDY7CiAgICBpZiAodG9wICsgbWggPiB3aW5kb3cuaW5uZXJIZWlnaHQgLSA4KSB0b3AgPSByLnRvcCAtIG1oIC0gNjsKICAgIGlmICh0b3AgPCA4KSB0b3AgPSA4OwogICAgbWVudS5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5yb3VuZChsZWZ0KX1weGA7CiAgICBtZW51LnN0eWxlLnRvcCA9IGAke01hdGgucm91bmQodG9wKX1weGA7CgogICAgY29uc3QgYnV0dG9ucyA9ICgpID0-IFsuLi5tZW51LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tZW51LWl0ZW06bm90KFtkaXNhYmxlZF0pJyldOwogICAgY29uc3Qgb25LZXkgPSBlID0-IHsKICAgICAgY29uc3QgbGlzdCA9IGJ1dHRvbnMoKTsKICAgICAgY29uc3QgaSA9IGxpc3QuaW5kZXhPZihyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgY2xvc2UoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93RG93bicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyAobGlzdFtpICsgMV0gfHwgbGlzdFswXS",
"kuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93VXAnKSB7IGUucHJldmVudERlZmF1bHQoKTsgKGxpc3RbaSAtIDFdIHx8IGxpc3RbbGlzdC5sZW5ndGggLSAxXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0hvbWUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFswXSAmJiBsaXN0WzBdLmZvY3VzKCk7IH0KICAgICAgZWxzZSBpZiAoZS5rZXkgPT09ICdFbmQnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFtsaXN0Lmxlbmd0aCAtIDFdICYmIGxpc3RbbGlzdC5sZW5ndGggLSAxXS5mb2N1cygpOyB9CiAgICAgIGVsc2UgaWYgKGUua2V5ID09PSAnVGFiJykgeyBjbG9zZSgpOyB9CiAgICB9OwogICAgLy8gQ2xpY2tzIGFueXdoZXJlIGVsc2UgLSBpbiBvdXIgcm9vdCBvciBvbiBHbWFpbCBpdHNlbGYgLSBkaXNtaXNzIGl0LgogICAgY29uc3Qgb25Qb2ludGVyID0gZSA9PiB7CiAgICAgIGlmICghZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhtZW51KSAmJiAhZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhhbmNob3IpKSBjbG9zZSgpOwogICAgfTsKCiAgICAvLyBJZiB0aGUgbWVudSBoZWxkIGZvY3VzLCBpdCBnb2VzIGJhY2sgdG8gdGhlIGFuY2hvciAtIG9uIEVzYywgb24KICAgIC8vIGNob29zaW5nIGFuIGl0ZW0gKGJlZm9yZSB0aGUgYWN0aW9uIHJ1bnMsIHNvIGFuIGFjdGlvbiB0aGF0CiAgICAvLyByZS1yZW5kZXJzIGNhbiBmaW5kIHRoZSBhbmNob3IgYW",
"dhaW4gYnkgaXRzIGRhdGEta2V5KSwgYW5kIHdoZW4gYQogICAgLy8gcmUtcmVuZGVyIGNsb3NlcyB0aGUgbWVudSBmcm9tIHVuZGVybmVhdGguCiAgICBmdW5jdGlvbiBjbG9zZSgpIHsKICAgICAgaWYgKG9wZW5NZW51cy5nZXQocm9vdCkgIT09IGNsb3NlKSByZXR1cm47CiAgICAgIGNvbnN0IGhhZEZvY3VzID0gbWVudS5jb250YWlucyhyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBvcGVuTWVudXMuZGVsZXRlKHJvb3QpOwogICAgICBtZW51LnJlbW92ZSgpOwogICAgICBpZiAoaGFkRm9jdXMgJiYgYW5jaG9yLmlzQ29ubmVjdGVkKSBhbmNob3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBhbmNob3Iuc2V0QXR0cmlidXRlKCdhcmlhLWV4cGFuZGVkJywgJ2ZhbHNlJyk7CiAgICAgIG1lbnUucmVtb3ZlRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCBvblBvaW50ZXIsIHRydWUpOwogICAgfQoKICAgIG1lbnUuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgb25Qb2ludGVyLCB0cnVlKTsKICAgIG9wZW5NZW51cy5zZXQocm9vdCwgY2xvc2UpOwoKICAgIGNvbnN0IGZpcnN0ID0gYnV0dG9ucygpWzBdOwogICAgaWYgKGZpcnN0KSBmaXJzdC5mb2N1cygpOwogICAgcmV0dXJuIGNsb3NlOwogIH0KCi",
"AgbnMudWkgPSB7IGgsIGFwcGVuZCwgaWNvbiwgbG9nbywgTE9HTywgbW91bnRTaGFkb3csIHRvYXN0LCBvcGVuTWVudSwgY2xvc2VNZW51LCBpc01lbnVPcGVuIH07Cn0pKCk7Cg\"],[\"src/content/styles.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFN0eWxlcyBmb3IgdGhlIGluamVjdGVkIFVJCi8vCi8vIFBsYWluIHN0cmluZ3MsIGFkb3B0ZWQgaW50byBlYWNoIHNoYWRvdyByb290LiBUaGUgbG9vayBib3Jyb3dzIEdtYWlsJ3MKLy8gb3duIHZvY2FidWxhcnkgLSBHb29nbGUgU2FucywgaXRzIGJsdWUsIGl0cyBlbGV2YXRpb24gc2hhZG93cywgcGlsbAovLyBidXR0b25zIC0gc28gdGhlIGJvYXJkIHJlYWRzIGFzIHBhcnQgb2YgR21haWwgcmF0aGVyIHRoYW4gc29tZXRoaW5nCi8vIGJvbHRlZCBvbi4gRGFyayBtb2RlIGZvbGxvd3MgdGhlIG9wZXJhdGluZyBzeXN0ZW0sIGFzIGFza2VkOyBHbWFpbCdzCi8vIG93biB0aGVtZSBzZXR0aW5nIGlzIG5vdCB2aXNpYmxlIHRvIGEgY29udGVudCBzY3JpcHQgd2l0aG91dCBzY3JhcGluZy4KLy8g4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CgogIC8vIOKUgOKUgCBTaGFyZWQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IEJBU0UgPSBgCjpob3N0IHsKICBhbGw6IGluaXRpYWwgIWltcG9ydGFudDsKICAvKiBBIHBvc2l0aW9uZWQgaG9zdCB3aXRoIGEgei1pbmRleCBpcyBpdHMgb3duIHN0YWNraW5nIGNvbnRleHQsIHNvCiAgICAgbWVudXMgYW5kIHRvYXN0cyBpbnNpZGUgaXQgY2FuIGxheWVyIG92ZXIgdGhlIGJvYXJkIHdpdGggc21hbGwKICAgICBudW1iZXJzIGluc3RlYWQgb2YgY29tcGV0aW5nIHdpdGggR21haWwncy4gKi8KICBwb3NpdGlvbjogcmVsYXRpdmUgIWltcG9ydGFudDs",
"KICB6LWluZGV4OiAyMTQ3NDgzMDAwICFpbXBvcnRhbnQ7CgogIC0tYmc6ICNmNmY4ZmM7CiAgLS1iYXI6ICNmNmY4ZmM7CiAgLS1jb2w6ICNlOWVlZjY7CiAgLS1zdXJmYWNlOiAjZmZmZmZmOwogIC0tbWVudTogI2ZmZmZmZjsKICAtLWZnOiAjMWYxZjFmOwogIC0tZmctMjogIzQ0NDc0NjsKICAtLWZnLTM6ICM1ZTYwNjI7CiAgLS1hY2NlbnQ6ICMwYjU3ZDA7CiAgLS1vbi1hY2NlbnQ6ICNmZmZmZmY7CiAgLS1hY2NlbnQtc29mdDogI2QzZTNmZDsKICAtLW9uLWFjY2VudC1zb2Z0OiAjMDQxZTQ5OwogIC0tYm9yZGVyOiAjZTFlM2UxOwogIC0tYm9yZGVyLXN0cm9uZzogI2M0YzdjNTsKICAtLWhvdmVyOiByZ2JhKDY4LCA3MSwgNzAsIC4wOCk7CiAgLS1wcmVzczogcmdiYSg2OCwgNzEsIDcwLCAuMTQpOwogIC0tZm9jdXM6ICMwYjU3ZDA7CiAgLS1kYW5nZXI6ICNiMzI2MWU7CiAgLS1zdGFyOiAjZThhNDAwOwogIC0taW52ZXJzZTogIzMwMzAzMDsKICAtLW9uLWludmVyc2U6ICNmMmYyZjI7CiAgLS1pbnZlcnNlLWFjY2VudDogI2E4YzdmYTsKICAtLXNjcmltOiByZ2JhKDMyLCAzMywgMzYsIC40KTsKICAtLXNoYWRvdy0xOiAwIDFweCAycHggcmdiYSg2MCwgNjQsIDY3LCAuMiksIDAgMXB4IDNweCAxcHggcmdiYSg2MCwgNjQsIDY3LCAuMSk7CiAgLS1zaGFkb3ctMjogMCAxcHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjMpLCAwIDJweCA2cHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjE1KTsKICAtLXNoYWRvdy0zOiA",
"wIDRweCA4cHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjE1KSwgMCAxcHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjMpOwogIC0tZm9udDogIkdvb2dsZSBTYW5zIiwgUm9ib3RvLCBBcmlhbCwgc2Fucy1zZXJpZjsKICAvKiBDYXJkIGNvbG91cnM6IEdvb2dsZSdzIG93biBwYWxldHRlLCBhIHN0ZXAgbGlnaHRlciBpbiBkYXJrIG1vZGUgc28KICAgICB0aGUgc3RyaXBlIHN0aWxsIHJlYWRzIGFnYWluc3QgYSBkYXJrIGNhcmQuICovCiAgLS1jLXJlZDogI2Q5MzAyNTsKICAtLWMtb3JhbmdlOiAjZTg3MTBhOwogIC0tYy15ZWxsb3c6ICNmOWFiMDA7CiAgLS1jLWdyZWVuOiAjMWU4ZTNlOwogIC0tYy1ibHVlOiAjMWE3M2U4OwogIC0tYy1wdXJwbGU6ICM5MzM0ZTY7CiAgLS1jLWdyZXk6ICM4MDg2OGI7CiAgLS1tYXJrOiAjZmRlMjkzOwogIC0tbWFyay1jdXJyZW50OiAjZjlhYjAwOwogIC0tb24tbWFyay1jdXJyZW50OiAjMWYxZjFmOwogIC8qIFRoZSBzY3JhdGNocGFkOiBwYXBlciBvZiBpdHMgb3duIGNvbG91ci4gKi8KICAtLXNjcmF0Y2g6ICNmZmY4ZGM7CiAgLS1zY3JhdGNoLWVkZ2U6ICNmMGUxYTA7CiAgLS1zY3JhdGNoLWluazogIzlhNmIwMDsKfQoKQG1lZGlhIChwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaykgewogIDpob3N0IHsKICAgIC0tYmc6ICMxMzEzMTQ7CiAgICAtLWJhcjogIzEzMTMxNDsKICAgIC0tY29sOiAjMWUxZjIwOwogICAgLS1zdXJmYWNlOiAjMmEyYjJkOwogICAgLS1tZW51OiAjMmQyZTM",
"wOwogICAgLS1mZzogI2UzZTNlMzsKICAgIC0tZmctMjogI2M0YzdjNTsKICAgIC0tZmctMzogI2EyYTVhMzsKICAgIC0tYWNjZW50OiAjYThjN2ZhOwogICAgLS1vbi1hY2NlbnQ6ICMwNjJlNmY7CiAgICAtLWFjY2VudC1zb2Z0OiAjMDA0YTc3OwogICAgLS1vbi1hY2NlbnQtc29mdDogI2MyZTdmZjsKICAgIC0tYm9yZGVyOiAjM2EzYjNkOwogICAgLS1ib3JkZXItc3Ryb25nOiAjNWM1ZTYwOwogICAgLS1ob3ZlcjogcmdiYSgyMjcsIDIyNywgMjI3LCAuMDgpOwogICAgLS1wcmVzczogcmdiYSgyMjcsIDIyNywgMjI3LCAuMTQpOwogICAgLS1mb2N1czogI2E4YzdmYTsKICAgIC0tZGFuZ2VyOiAjZjJiOGI1OwogICAgLS1zdGFyOiAjZmRkNjYzOwogICAgLS1pbnZlcnNlOiAjZTNlM2UzOwogICAgLS1vbi1pbnZlcnNlOiAjMWYxZjFmOwogICAgLS1pbnZlcnNlLWFjY2VudDogIzBiNTdkMDsKICAgIC0tc2NyaW06IHJnYmEoMCwgMCwgMCwgLjU1KTsKICAgIC0tc2hhZG93LTE6IDAgMXB4IDJweCByZ2JhKDAsIDAsIDAsIC41KSwgMCAxcHggM3B4IDFweCByZ2JhKDAsIDAsIDAsIC4yNSk7CiAgICAtLXNoYWRvdy0yOiAwIDFweCAzcHggcmdiYSgwLCAwLCAwLCAuNiksIDAgMnB4IDhweCAycHggcmdiYSgwLCAwLCAwLCAuMyk7CiAgICAtLXNoYWRvdy0zOiAwIDRweCAxMHB4IDNweCByZ2JhKDAsIDAsIDAsIC40NSksIDAgMXB4IDNweCByZ2JhKDAsIDAsIDAsIC42KTsKICAgIC0tYy1yZWQ6ICNmMjhiODI7CiAgICAtLWM",
"tb3JhbmdlOiAjZmNhZDcwOwogICAgLS1jLXllbGxvdzogI2ZkZDY2MzsKICAgIC0tYy1ncmVlbjogIzgxYzk5NTsKICAgIC0tYy1ibHVlOiAjOGFiNGY4OwogICAgLS1jLXB1cnBsZTogI2M1OGFmOTsKICAgIC0tYy1ncmV5OiAjOWFhMGE2OwogICAgLS1tYXJrOiAjNmI1ODAwOwogICAgLS1tYXJrLWN1cnJlbnQ6ICNmZGQ2NjM7CiAgICAtLW9uLW1hcmstY3VycmVudDogIzFmMWYxZjsKICAgIC0tc2NyYXRjaDogIzJhMjYxNzsKICAgIC0tc2NyYXRjaC1lZGdlOiAjNGE0MTIyOwogICAgLS1zY3JhdGNoLWluazogI2ZkZDY2MzsKICB9Cn0KCiosICo6OmJlZm9yZSwgKjo6YWZ0ZXIgeyBib3gtc2l6aW5nOiBib3JkZXItYm94OyB9CgovKiBBdXRob3IgZGlzcGxheSBydWxlcyAoLnBpbGwsIC5vdmVybGF54oCmKSB3b3VsZCBvdGhlcndpc2UgYmVhdCB0aGUKICAgYnJvd3NlcidzIG93biBbaGlkZGVuXSB7IGRpc3BsYXk6IG5vbmUgfS4gKi8KW2hpZGRlbl0geyBkaXNwbGF5OiBub25lICFpbXBvcnRhbnQ7IH0KCmJ1dHRvbiB7CiAgZm9udDogaW5oZXJpdDsKICBjb2xvcjogaW5oZXJpdDsKICBiYWNrZ3JvdW5kOiBub25lOwogIGJvcmRlcjogMDsKICBtYXJnaW46IDA7CiAgcGFkZGluZzogMDsKICBjdXJzb3I6IHBvaW50ZXI7CiAgLXdlYmtpdC10YXAtaGlnaGxpZ2h0LWNvbG9yOiB0cmFuc3BhcmVudDsKfQpidXR0b246ZGlzYWJsZWQgeyBjdXJzb3I6IGRlZmF1bHQ7IH0KCjpmb2N1cyB7IG91dGxpbmU6IG5vbmU7IH0",
"KOmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogMnB4OyB9CgouaWNvbiB7IGRpc3BsYXk6IGJsb2NrOyBmbGV4OiBub25lOyB9CgouaWNvbi1idG4gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDM2cHg7CiAgaGVpZ2h0OiAzNnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZmxleDogbm9uZTsKfQouaWNvbi1idG46aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLmljb24tYnRuOmFjdGl2ZSB7IGJhY2tncm91bmQ6IHZhcigtLXByZXNzKTsgfQouaWNvbi1idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNDsgYmFja2dyb3VuZDogbm9uZTsgfQoKLmJ0biB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDM2cHg7CiAgcGFkZGluZzogMCAxOHB4OwogIGJvcmRlci1yYWRpdXM6IDE4cHg7CiAgZm9udC1zaXplOiAxNHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wMWVtOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmJ0bi1wcmltYXJ5IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcig",
"tLW9uLWFjY2VudCk7IH0KLmJ0bi1wcmltYXJ5OmhvdmVyIHsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOyB9Ci5idG4tdG9uYWwgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLmJ0bi10ZXh0IHsgY29sb3I6IHZhcigtLWFjY2VudCk7IHBhZGRpbmc6IDAgMTJweDsgfQouYnRuLXRleHQ6aG92ZXIsIC5idG4tdG9uYWw6aG92ZXIgeyBiYWNrZ3JvdW5kLWltYWdlOiBsaW5lYXItZ3JhZGllbnQodmFyKC0taG92ZXIpLCB2YXIoLS1ob3ZlcikpOyB9Ci5idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNTsgYm94LXNoYWRvdzogbm9uZTsgfQoKLyog4pSA4pSAIE1lbnVzIOKUgOKUgCAqLwoKLm1lbnUgewogIHBvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiAyMDsKICBtaW4td2lkdGg6IDIwOHB4OwogIG1heC13aWR0aDogMzIwcHg7CiAgbWF4LWhlaWdodDogNzB2aDsKICBvdmVyZmxvdy15OiBhdXRvOwogIHBhZGRpbmc6IDhweCAwOwogIGJhY2tncm91bmQ6IHZhcigtLW1lbnUpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGxpbmUtaGVpZ2h0OiAyMHB4Owp9Ci5tZW51LWl0ZW0gewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDEycHg",
"7CiAgd2lkdGg6IDEwMCU7CiAgbWluLWhlaWdodDogMzZweDsKICBwYWRkaW5nOiA2cHggMjBweCA2cHggMTJweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5tZW51LWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLm1lbnUtaXRlbTpmb2N1cy12aXNpYmxlIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogLTJweDsgfQoubWVudS1pdGVtOmRpc2FibGVkIHsgb3BhY2l0eTogLjQ1OyBiYWNrZ3JvdW5kOiBub25lOyB9Ci5tZW51LWl0ZW0uZGFuZ2VyIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KLm1lbnUtaWNvbiB7IHdpZHRoOiAxOHB4OyBoZWlnaHQ6IDE4cHg7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBjb2xvcjogdmFyKC0tZmctMik7IGZsZXg6IG5vbmU7IH0KLm1lbnUtaXRlbS5kYW5nZXIgLm1lbnUtaWNvbiB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci5tZW51LWl0ZW1bYXJpYS1jaGVja2VkPSJ0cnVlIl0gLm1lbnUtaWNvbiB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5tZW51LWxhYmVsIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQoubWVudS1oZWFkaW5nIHsKICBwYWRkaW5nOiA4cHggMjBweCA0cHggNDJweDsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDU",
"wMDsKICBjb2xvcjogdmFyKC0tZmctMyk7Cn0KLm1lbnUtc2VwIHsgaGVpZ2h0OiAxcHg7IG1hcmdpbjogOHB4IDA7IGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7IH0KCi8qIOKUgOKUgCBUb2FzdHMg4pSA4pSAICovCgoudG9hc3RzIHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgei1pbmRleDogMzA7CiAgbGVmdDogNTAlOwogIGJvdHRvbTogMjRweDsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoLTUwJSk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwp9Ci50b2FzdCB7CiAgcG9pbnRlci1ldmVudHM6IGF1dG87CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNHB4OwogIG1pbi1oZWlnaHQ6IDQ4cHg7CiAgbWF4LXdpZHRoOiBtaW4oNjAwcHgsIGNhbGMoMTAwdncgLSAzMnB4KSk7CiAgcGFkZGluZzogNnB4IDZweCA2cHggMTZweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taW52ZXJzZSk7CiAgY29sb3I6IHZhcigtLW9uLWludmVyc2UpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LXNpemU6IDE0cHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7CiAgYW5pbWF0aW9uOiB0b2FzdC1pbiAuMThzIGVhc2Utb3V0Owp9Ci50b2FzdC1lcnJvciB7IGJvcmR",
"lci1sZWZ0OiA0cHggc29saWQgI2YyOGI4MjsgcGFkZGluZy1sZWZ0OiAxMnB4OyB9Ci50b2FzdC10ZXh0IHsgZmxleDogMTsgcGFkZGluZy1yaWdodDogOHB4OyB9Ci50b2FzdC1hY3Rpb24gewogIGhlaWdodDogMzZweDsKICBwYWRkaW5nOiAwIDEycHg7CiAgYm9yZGVyLXJhZGl1czogMThweDsKICBjb2xvcjogdmFyKC0taW52ZXJzZS1hY2NlbnQpOwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQoudG9hc3QtYWN0aW9uOmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgxMjgsIDEyOCwgMTI4LCAuMTYpOyB9Ci50b2FzdC1jbG9zZSB7IGNvbG9yOiBpbmhlcml0OyBvcGFjaXR5OiAuODsgfQoudG9hc3QtY2xvc2U6aG92ZXIgeyBiYWNrZ3JvdW5kOiByZ2JhKDEyOCwgMTI4LCAxMjgsIC4xNik7IGNvbG9yOiBpbmhlcml0OyB9CkBrZXlmcmFtZXMgdG9hc3QtaW4geyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDhweCk7IH0gdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IG5vbmU7IH0gfQoKQG1lZGlhIChwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpIHsKICAqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYW5pbWF0aW9uOiBub25lICFpbXBvcnRhbnQ7IHRyYW5zaXRpb246IG5vbmUgIWltcG9ydGFudDsgfQp9CmA7CgogIC8vIOKUgOKUgCBCb2FyZCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgQk9BUkQgPSBgCi5vdmVybGF5IHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgaW5zZXQ6IDA7CiAgei1pbmRleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwogIGZvbnQtc2l6ZTogMTRweDsKICBsaW5lLWhlaWdodDogMS40OwogIC13ZWJraXQtZm9udC1zbW9vdGhpbmc6IGFudGlhbGlhc2VkOwp9Ci5vdmVybGF5W2hpZGRlbl0geyBkaXNwbGF5OiBub25lOyB9CgouYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA0cHg7CiAgaGVpZ2h0OiA2NHB4OwogIHBhZGRpbmc6IDAgMTJweCAwIDIwcHg7CiAgZmxleDogbm9uZTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iYXIpOwp9Ci5icmFuZCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTBweDsKICBtYXJnaW46IDA7CiAgZm9udC1zaXplOiAyMnB4OwogIGZvbnQtd2VpZ2h0OiA0MDA7CiAgY29sb3I6IHZhcigtLWZnKTsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwp9Ci5icmFuZCAubG9nbyB7IGR",
"pc3BsYXk6IGZsZXg7IH0KLmJyYW5kIC5kaW0geyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmFjY291bnQgewogIG1hcmdpbi1sZWZ0OiAxNHB4OwogIHBhZGRpbmc6IDRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDE0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEzcHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIG1pbi13aWR0aDogMDsKfQouc3BhY2VyIHsgZmxleDogMTsgfQoudXBkYXRlZCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxMnB4OyB3aGl0ZS1zcGFjZTogbm93cmFwOyBtYXJnaW4tcmlnaHQ6IDJweDsgfQoKLyog4pSA4pSAIFRhYnM6IEJvYXJkIHwgTm90ZXMg4pSA4pSAICovCgoudGFicyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IDJweDsKICBtYXJnaW4tbGVmdDogMThweDsKICBwYWRkaW5nOiAzcHg7CiAgYm9yZGVyLXJhZGl1czogMjBweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7Cn0KLnRhYiB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCAxNHB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ",
"6IDUwMDsKfQoudGFiOmhvdmVyIHsgY29sb3I6IHZhcigtLWZnKTsgfQoudGFiW2FyaWEtc2VsZWN0ZWQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBjb2xvcjogdmFyKC0tZmcpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLnRhYlthcmlhLXNlbGVjdGVkPSJ0cnVlIl0gLmljb24geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouc3Bpbm5pbmcgLmljb24geyBhbmltYXRpb246IHNwaW4gLjlzIGxpbmVhciBpbmZpbml0ZTsgfQpAa2V5ZnJhbWVzIHNwaW4geyB0byB7IHRyYW5zZm9ybTogcm90YXRlKDM2MGRlZyk7IH0gfQoKLmJvZHkgeyBmbGV4OiAxOyBkaXNwbGF5OiBmbGV4OyBtaW4taGVpZ2h0OiAwOyB9CgouY29sdW1ucyB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMTJweDsKICBwYWRkaW5nOiA0cHggMjBweCAyMHB4OwogIG92ZXJmbG93LXg6IGF1dG87CiAgb3ZlcmZsb3cteTogaGlkZGVuOwogIG1pbi1oZWlnaHQ6IDA7Cn0KLmNvbHVtbiB7CiAgZmxleDogMSAwIDI4MHB4OwogIG1pbi13aWR0aDogMjgwcHg7CiAgbWF4LXdpZHRoOiA0MDBweDsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLWhlaWdodDogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJzOwp9Ci5jb2x1bW4uZHJvcC10YXJnZXQgeyBib3gtc2hhZG9",
"3OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgfQouY29sLWhlYWQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMHB4IDZweCA2cHggMTZweDsKICBmbGV4OiBub25lOwp9Ci5jb2wtdGl0bGUgewogIG1hcmdpbjogMDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmcpOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouY29sLWNvdW50IHsKICBmbGV4OiBub25lOwogIG1pbi13aWR0aDogMjJweDsKICBwYWRkaW5nOiAwIDdweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9Ci5jb2wtZmxhZyB7CiAgZmxleDogbm9uZTsKICBwYWRkaW5nOiAwIDhweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDExcHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7Cn0KLmNvbC1oZWFkIC5zcGFjZXIgeyBtaW4td2lkdGg6IDRweDsgfQouY29sLW5vdGUgeyBwYWRkaW5nOiAwIDE2cHggNnB4OyB",
"mb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZmxleDogbm9uZTsgfQoKLmxpc3QgewogIGZsZXg6IDE7CiAgbWluLWhlaWdodDogNzJweDsKICBvdmVyZmxvdy15OiBhdXRvOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiA0cHggOHB4IDEycHg7CiAgc2Nyb2xsYmFyLXdpZHRoOiB0aGluOwp9Ci5saXN0OmVtcHR5OjphZnRlciB7CiAgY29udGVudDogYXR0cihkYXRhLWVtcHR5KTsKICBkaXNwbGF5OiBibG9jazsKICBtYXJnaW46IDJweCAwOwogIHBhZGRpbmc6IDIycHggMTJweDsKICBib3JkZXI6IDEuNXB4IGRhc2hlZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDEzcHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9CgovKiDilIDilIAgQ2FyZHMg4pSA4pSAICovCgouY2FyZCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGZsZXg6IG5vbmU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7CiAgY3Vyc29yOiBncmFiOwogIHRyYW5zaXRpb246IGJveC1zaGFkb3cgLjE1czsKfQouY2FyZDpob3ZlciB7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0yKTsgfQouY2FyZC5kcmFnZ2luZyB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhcmQubGl",
"mdGluZyB7IG9wYWNpdHk6IC41OyB9Ci5jYXJkLW1haW4gewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDEwcHggMTRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBjdXJzb3I6IGluaGVyaXQ7Cn0KLmNhcmQtbWFpbjpmb2N1cy12aXNpYmxlIHsgb3V0bGluZS1vZmZzZXQ6IC0ycHg7IH0KLmNhcmQtdG9wIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgbWluLWhlaWdodDogMjBweDsKICBmb250LXNpemU6IDEzcHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5kb3QgeyB3aWR0aDogOHB4OyBoZWlnaHQ6IDhweDsgYm9yZGVyLXJhZGl1czogNTAlOyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBmbGV4OiBub25lOyB9Ci5mcm9tIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZGF0ZSB7IGZsZXg6IG5vbmU7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jYXJkOmhvdmVyIC5kYXRlLCAuY2FyZDpmb2N1cy13aXRoaW4gLmRhdGUgeyB2aXNpYmlsaXR5OiBoaWRkZW47IH0KLnN1YmplY3Qtcm93IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg7IG1hcmdpbi10b3A6IDNweDsgfQouc3ViamVjdCB7CiAgZmx",
"leDogMTsKICBtaW4td2lkdGg6IDA7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIGZvbnQtc2l6ZTogMTRweDsKICBjb2xvcjogdmFyKC0tZmcpOwp9Ci51bnJlYWQgLmZyb20sIC51bnJlYWQgLnN1YmplY3QgeyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5zdGFyIHsgY29sb3I6IHZhcigtLXN0YXIpOyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgZmxleDogbm9uZTsgfQouY291bnQgewogIGZsZXg6IG5vbmU7CiAgcGFkZGluZzogMCA2cHg7CiAgYm9yZGVyLXJhZGl1czogOXB4OwogIGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxMXB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGluZS1oZWlnaHQ6IDE4cHg7Cn0KLmRyYWZ0IHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTJweDsgfQouc25pcHBldCB7CiAgbWFyZ2luLXRvcDogM3B4OwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMThweDsKICBjb2xvcjogdmFyKC0tZmctMyk7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydGljYWw7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKfQouY2FyZC1ub3RlIHsKICBtYXJnaW4",
"tdG9wOiA0cHg7CiAgcGFkZGluZy1sZWZ0OiA4cHg7CiAgYm9yZGVyLWxlZnQ6IDJweCBzb2xpZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIHdoaXRlLXNwYWNlOiBwcmUtbGluZTsKICBkaXNwbGF5OiAtd2Via2l0LWJveDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDM7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICBvdmVyZmxvdzogaGlkZGVuOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9CgpbZGF0YS1jb2xvdXI9InJlZCJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcmVkKTsgfQpbZGF0YS1jb2xvdXI9Im9yYW5nZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtb3JhbmdlKTsgfQpbZGF0YS1jb2xvdXI9InllbGxvdyJdIHsgLS1zdHJpcGU6IHZhcigtLWMteWVsbG93KTsgfQpbZGF0YS1jb2xvdXI9ImdyZWVuIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ncmVlbik7IH0KW2RhdGEtY29sb3VyPSJibHVlIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ibHVlKTsgfQpbZGF0YS1jb2xvdXI9InB1cnBsZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcHVycGxlKTsgfQpbZGF0YS1jb2xvdXI9ImdyZXkiXSB7IC0tc3RyaXBlOiB2YXIoLS1jLWdyZXkpOyB9Ci5jYXJkW2RhdGEtY29sb3VyXTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiAwOwogIGJvdHRvbTogMDsKICB",
"sZWZ0OiAwOwogIHdpZHRoOiA2cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweCAwIDAgMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdHJpcGUpOwogIHBvaW50ZXItZXZlbnRzOiBub25lOwp9Ci5jYXJkW2RhdGEtY29sb3VyXSAuY2FyZC1tYWluIHsgcGFkZGluZy1sZWZ0OiAxOHB4OyB9CgouY2FyZC1tZW51IHsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiA0cHg7CiAgcmlnaHQ6IDRweDsKICB3aWR0aDogMzJweDsKICBoZWlnaHQ6IDMycHg7CiAgb3BhY2l0eTogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKfQouY2FyZC1tZW51OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5jYXJkOmhvdmVyIC5jYXJkLW1lbnUsIC5jYXJkOmZvY3VzLXdpdGhpbiAuY2FyZC1tZW51LCAuY2FyZC1tZW51W2FyaWEtZXhwYW5kZWQ9InRydWUiXSB7IG9wYWNpdHk6IDE7IH0KLyogTm8gaG92ZXIgb24gYSB0b3VjaCBzY3JlZW46IHRoZSDii68gaXMgYWx3YXlzIHRoZXJlLCBhbmQgdGhlIHRvcCBsaW5lCiAgIG1ha2VzIHJvb20gZm9yIGl0IHJhdGhlciB0aGFuIGhpZGluZyB0aGUgZGF0ZSB1bmRlciBpdC4gKi8KQG1lZGlhIChob3Zlcjogbm9uZSkgeyAuY2FyZC1tZW51IHsgb3BhY2l0eTogMTsgfSAuY2FyZCAuZGF0ZSB7IHZpc2liaWxpdHk6IHZpc2libGU7IH0gLmNhcmQtdG9wIHsgcGFkZGluZy1yaWdodDogMzBweDsgfSB9CgoucGxhY2Vob2xkZXIgewogIGZsZXg6IG5vbmU7CiAgYm9yZGV",
"yLXJhZGl1czogMTJweDsKICBib3JkZXI6IDJweCBkYXNoZWQgdmFyKC0tYWNjZW50KTsKICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYWNjZW50KSAxMCUsIHRyYW5zcGFyZW50KTsKfQoKLnNrZWxldG9uIHsKICBmbGV4OiBub25lOwogIGhlaWdodDogOTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIG9wYWNpdHk6IC41NTsKICBhbmltYXRpb246IHB1bHNlIDEuNHMgZWFzZS1pbi1vdXQgaW5maW5pdGU7Cn0KQGtleWZyYW1lcyBwdWxzZSB7IDUwJSB7IG9wYWNpdHk6IC4zOyB9IH0KCi8qIOKUgOKUgCBDb2x1bW4gc2VhcmNoIOKUgOKUgCAqLwoKLnNlYXJjaCB7CiAgZmxleDogbm9uZTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiA2cHg7CiAgbWF4LWhlaWdodDogNTUlOwogIG1pbi1oZWlnaHQ6IDA7CiAgbWFyZ2luOiAwIDhweCA4cHg7CiAgcGFkZGluZzogOHB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTIpOwp9Ci5zZWFyY2gtYm94IHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgaGVpZ2h0OiA0MHB4OwogIHBhZGRpbmc6IDAgMnB4IDAgMTJweDsKICBib3JkZXItcmFkaXVzOiAyMHB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk",
"7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZsZXg6IG5vbmU7Cn0KLnNlYXJjaC1ib3g6Zm9jdXMtd2l0aGluIHsgb3V0bGluZTogMnB4IHNvbGlkIHZhcigtLWZvY3VzKTsgfQouc2VhcmNoLWJveCBpbnB1dCB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgaGVpZ2h0OiAxMDAlOwogIGJvcmRlcjogMDsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQ6IGluaGVyaXQ7CiAgZm9udC1zaXplOiAxNHB4Owp9Ci5zZWFyY2gtYm94IGlucHV0OjpwbGFjZWhvbGRlciB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQouc2VhcmNoLWJveCBpbnB1dDpmb2N1cy12aXNpYmxlIHsgb3V0bGluZTogbm9uZTsgfQouc2VhcmNoLWhpbnQgeyBwYWRkaW5nOiAwIDhweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGZsZXg6IG5vbmU7IH0KLnJlc3VsdHMgeyBvdmVyZmxvdy15OiBhdXRvOyBtaW4taGVpZ2h0OiAwOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDJweDsgc2Nyb2xsYmFyLXdpZHRoOiB0aGluOyB9Ci5yZXN1bHQgewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDdweCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5yZXN1bHQ6aG92ZXI6bm90KDpkaXNhYmxlZCkgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLnJlc3VsdDpkaXNhYmx",
"lZCB7IG9wYWNpdHk6IC41NTsgfQouci10b3AgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDZweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IH0KLnItdG9wIC5mcm9tIHsgZm9udC13ZWlnaHQ6IDUwMDsgfQouci1zdWJqZWN0IHsKICBkaXNwbGF5OiBibG9jazsKICBmb250LXNpemU6IDEzcHg7CiAgY29sb3I6IHZhcigtLWZnKTsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLnItd2hlcmUgeyBkaXNwbGF5OiBibG9jazsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTsgbWFyZ2luLXRvcDogMXB4OyB9Ci5yZXN1bHQ6ZGlzYWJsZWQgLnItd2hlcmUgeyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLnJlc3VsdHMtZW1wdHkgeyBwYWRkaW5nOiAxMnB4IDhweDsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMyk7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoKLyog4pSA4pSAIFN0YXR1cyBwYW5lbHMg4pSA4pSAICovCgoucGFuZWwgewogIG1hcmdpbjogYXV0bzsKICB3aWR0aDogbWluKDQ2MHB4LCBjYWxjKDEwMHZ3IC0gNDhweCkpOwogIHBhZGRpbmc6IDM2cHggMzJweCAzMnB4OwogIGJvcmRlci1yYWRpdXM6IDI4cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOwogIHRleHQtYWxpZ246IGNlbnRlcjsKfQoucGFuZWwgLnBhbmV",
"sLWljb24gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDU2cHg7CiAgaGVpZ2h0OiA1NnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7CiAgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsKfQoucGFuZWwgaDIgeyBtYXJnaW46IDE2cHggMCA4cHg7IGZvbnQtc2l6ZTogMjJweDsgZm9udC13ZWlnaHQ6IDQwMDsgY29sb3I6IHZhcigtLWZnKTsgfQoucGFuZWwgcCB7IG1hcmdpbjogMCAwIDIwcHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgbGluZS1oZWlnaHQ6IDEuNTsgfQoucGFuZWwgLmFjdGlvbnMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDhweDsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IH0KCi8qIOKUgOKUgCBOb3RlcyDilIDilIAgKi8KCi5ub3RlcyB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMTJweDsKICBtaW4td2lkdGg6IDA7CiAgbWluLWhlaWdodDogMDsKICBwYWRkaW5nOiA0cHggMjBweCAyMHB4Owp9Ci5ub3Rlcy1mb2xkZXJzIHsKICBmbGV4OiAwIDAgMjMwcHg7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIG1pbi1oZWlnaHQ6IDA7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwp9Ci5mb2xkZXJzLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGl",
"nbi1pdGVtczogY2VudGVyOyBnYXA6IDRweDsgcGFkZGluZzogMTBweCA2cHggNHB4IDE2cHg7IGZsZXg6IG5vbmU7IH0KLmZvbGRlcnMtaGVhZCBoMiB7IG1hcmdpbjogMDsgZmxleDogMTsgZm9udC1zaXplOiAxM3B4OyBmb250LXdlaWdodDogNTAwOyBjb2xvcjogdmFyKC0tZmctMik7IGxldHRlci1zcGFjaW5nOiAuMDJlbTsgfQouZm9sZGVyLWl0ZW1zIHsgZmxleDogMTsgb3ZlcmZsb3cteTogYXV0bzsgcGFkZGluZzogMnB4IDhweCAxMHB4OyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDFweDsgfQouZm9sZGVyLXJvdyB7IHBvc2l0aW9uOiByZWxhdGl2ZTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZy1sZWZ0OiBjYWxjKHZhcigtLWRlcHRoLCAwKSAqIDE2cHgpOyB9Ci5mb2xkZXItcm93LmRyb3AgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWFjY2VudCkgMTAlLCB0cmFuc3BhcmVudCk7IH0KLmZvbGRlci1idG4gewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBoZWlnaHQ6IDM2cHg7CiAgcGFkZGluZzogMCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDEwcHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQ",
"tc2l6ZTogMTRweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5mb2xkZXItYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5mb2xkZXItYnRuW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyBmb250LXdlaWdodDogNTAwOyB9Ci5mb2xkZXItYnRuIC5pY29uIHsgY29sb3I6IGluaGVyaXQ7IG9wYWNpdHk6IC44NTsgfQouZm9sZGVyLXRpdGxlIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZm9sZGVyLWNvdW50IHsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogaW5oZXJpdDsgb3BhY2l0eTogLjc1OyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9Ci5mb2xkZXItbWVudSB7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgcmlnaHQ6IDJweDsgd2lkdGg6IDMwcHg7IGhlaWdodDogMzBweDsgb3BhY2l0eTogMDsgYmFja2dyb3VuZDogdmFyKC0tY29sKTsgfQouZm9sZGVyLXJvdzpob3ZlciAuZm9sZGVyLW1lbnUsIC5mb2xkZXItcm93OmZvY3VzLXdpdGhpbiAuZm9sZGVyLW1lbnUsIC5mb2xkZXItbWVudVthcmlhLWV4cGFuZGVkPSJ0cnVlIl0geyBvcGFjaXR5OiAxOyB9Ci5mb2xkZXItcm93OmhvdmVyIC5mb2xkZXItY291bnQsIC5mb2xkZXI",
"tcm93OmZvY3VzLXdpdGhpbiAuZm9sZGVyLWNvdW50IHsgdmlzaWJpbGl0eTogaGlkZGVuOyB9Ci5mb2xkZXItcm93OmhhcyguZm9sZGVyLWJ0blthcmlhLWN1cnJlbnQ9InRydWUiXSkgLmZvbGRlci1tZW51IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci5mb2xkZXItcm93LmVkaXRpbmcgeyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBhbGlnbi1pdGVtczogc3RyZXRjaDsgcGFkZGluZy10b3A6IDJweDsgcGFkZGluZy1ib3R0b206IDJweDsgfQouZm9sZGVyLWVkaXQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgcGFkZGluZy1sZWZ0OiAxMHB4OyBjb2xvcjogdmFyKC0tZmctMik7IH0KLmZvbGRlci1pbnB1dCB7IGhlaWdodDogMzRweDsgZmxleDogMTsgbWluLXdpZHRoOiAwOyB9Ci5mb2xkZXItZXJyb3IgeyBwYWRkaW5nOiA0cHggNHB4IDJweCAzNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci8qIFRoZSBhcnJvdyB0aGF0IGZvbGRzIGEgZm9sZGVyJ3Mgc3ViZm9sZGVycyBhd2F5OiBhIGNvbHVtbiBvZiBpdHMgb3duLAogICBvbmNlIHNvbWUgZm9sZGVyIGhhcyBzdWJmb2xkZXJzLCBzbyBldmVyeSBmb2xkZXIncyBpY29uIGxpbmVzIHVwLiAqLwouZm9sZGVyLXR3aXN0eSB7CiAgZmxleDogbm9uZTsKICBkaXNwbGF5OiBub25lOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI",
"7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDIwcHg7CiAgaGVpZ2h0OiAzNnB4OwogIG1hcmdpbi1yaWdodDogMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmctMyk7Cn0KLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci10d2lzdHkgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgfQpidXR0b24uZm9sZGVyLXR3aXN0eTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQouZm9sZGVyLXR3aXN0eSAuaWNvbiB7IHRyYW5zaXRpb246IHRyYW5zZm9ybSAuMTVzIGVhc2U7IH0KLmZvbGRlci10d2lzdHlbYXJpYS1leHBhbmRlZD0iZmFsc2UiXSAuaWNvbiB7IHRyYW5zZm9ybTogcm90YXRlKC05MGRlZyk7IH0KLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci1lZGl0IHsgcGFkZGluZy1sZWZ0OiAzMnB4OyB9Ci5mb2xkZXItaXRlbXNbZGF0YS1uZXN0ZWRdIC5mb2xkZXItZXJyb3IgeyBwYWRkaW5nLWxlZnQ6IDU4cHg7IH0KLyogRm9sZGVkLCB3aXRoIHRoZSBmb2xkZXIgYmVpbmcgbG9va2VkIGF0IGluc2lkZSBpdC4gKi8KLmZvbGRlci1idG4uaG9sZHMtY3VycmVudCB7IGNvbG9yOiB2YXIoLS1mZyk7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLm5vdGVzLXNjb3BlIHsgZmxleDogbm9uZTsgcGFkZGluZzogMCAyMHB4IDZweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IHdoaXRlLXNwYWN",
"lOiBub3dyYXA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB9Ci5ub3Rlcy1saXN0IHsKICBmbGV4OiAwIDAgMzIwcHg7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIG1pbi1oZWlnaHQ6IDA7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwp9Ci5ub3Rlcy10b29scyB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nOiAxMnB4IDEycHggOHB4OyBmbGV4OiBub25lOyB9Ci5ub3Rlcy10b29scyAuc2VhcmNoLWJveCB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IH0KLm5vdGVzLXRvb2xzIC5idG4geyBoZWlnaHQ6IDQwcHg7IHBhZGRpbmc6IDAgMTZweCAwIDEycHg7IGZsZXg6IG5vbmU7IH0KLm5vdGVzLWl0ZW1zIHsgZmxleDogMTsgb3ZlcmZsb3cteTogYXV0bzsgcGFkZGluZzogMCA4cHggOHB4OyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDJweDsgfQoubm90ZS1pdGVtIHsKICBkaXNwbGF5OiBibG9jazsKICB3aWR0aDogMTAwJTsKICBwYWRkaW5nOiAxMHB4IDEycHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5ub3RlLWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLm5vdGUtaXRlbVthcmlhLWN1cnJlbnQ9InR",
"ydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLm5pLXRvcCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBiYXNlbGluZTsgZ2FwOiA4cHg7IH0KLm5pLXRpdGxlIHsKICBmbGV4OiAxOwogIG1pbi13aWR0aDogMDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgZm9udC1zaXplOiAxNHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgY29sb3I6IHZhcigtLWZnKTsKfQoubmktc25pcHBldCB7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydGljYWw7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKICBtYXJnaW4tdG9wOiAycHg7CiAgZm9udC1zaXplOiAxM3B4OwogIGxpbmUtaGVpZ2h0OiAxOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKfQoubmktbWV0YSB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiA0cHggMTBweDsgbWFyZ2luLXRvcDogM3B4OyB9Ci5uaS1tZXRhOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQoubmktZm9sZGVyIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogM3B4OyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubmktbWFpbCB7IGZ",
"vbnQtc2l6ZTogMTFweDsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLmRyYWdnaW5nLW5vdGUgLm5vdGUtaXRlbVthcmlhLWN1cnJlbnQ9InRydWUiXSB7IGJveC1zaGFkb3c6IG5vbmU7IH0KLm5lLWZvbGRlciB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDRweDsKICBoZWlnaHQ6IDMycHg7CiAgbWF4LXdpZHRoOiAyNjBweDsKICBtYXJnaW4tcmlnaHQ6IDRweDsKICBwYWRkaW5nOiAwIDRweCAwIDEwcHg7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxM3B4OwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLm5lLWZvbGRlciBzcGFuIHsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IH0KLm5lLWZvbGRlcjpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQovKiBTZWFyY2g6IHRoZSB3b3JkcyBtYXJrZWQgaW4gcmVzdWx0cywgYW5kIGluIHRoZSBvcGVuIG5vdGUuICovCm1hcmsgeyBiYWNrZ3JvdW5kOiB2YXIoLS1tYXJrKTsgY29sb3I6IGluaGVyaXQ7IGJvcmRlci1yYWRpdXM6IDJweDsgcGFkZGluZzogMCAxcHg7IH0KLyogT25seSB0aGUgcGhvbmUgYXBwLCB3aGljaCBzaG93cyBvbmUgcGFuZSBhdCBhIHRpbWUsIG5lZWRzIGEgd2F5IGJhY2ssCiAgIGFuZCBhIGJ1dHRvbiB0byBmb2xkIHRoZSBmb2xkZXIgdHJlZSBhd2F5LiA",
"qLwoubmUtYmFjaywgLmZvbGRlcnMtdG9nZ2xlIHsgZGlzcGxheTogbm9uZTsgfQoubmktZXhjZXJwdHMgeyBkaXNwbGF5OiBibG9jazsgbWFyZ2luLXRvcDogM3B4OyB9Ci5uaS1leGNlcnB0IHsKICBkaXNwbGF5OiBibG9jazsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTMpOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9Ci5uaS1leGNlcnB0ICsgLm5pLWV4Y2VycHQgeyBtYXJnaW4tdG9wOiAzcHg7IH0KLm5pLWV4Y2VycHQgbWFyaywgLm5pLXNuaXBwZXQgbWFyaywgLm5pLXRpdGxlIG1hcmsgeyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5uaS1oaXRzIHsgZm9udC1zaXplOiAxMXB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQo6OmhpZ2hsaWdodChna2ItbWF0Y2gpIHsgYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tbWFyayk7IH0KOjpoaWdobGlnaHQoZ2tiLW1hdGNoLWN1cnJlbnQpIHsgYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tbWFyay1jdXJyZW50KTsgY29sb3I6IHZhcigtLW9uLW1hcmstY3VycmVudCk7IH0KLm5lLWZpbmQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBtYXJnaW46IDRweCAyMHB4IDA7CiAgcGFkZGluZzogMnB4IDRweCAycHggMTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgY29sb3I6IHZhcig",
"tLWZnLTIpOwogIGZvbnQtc2l6ZTogMTNweDsKICBmbGV4OiBub25lOwp9Ci5uZS1maW5kIC5maW5kLXdvcmRzIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgY29sb3I6IHZhcigtLWZnKTsgfQoubmUtZmluZCAuZmluZC1wb3MgeyB3aGl0ZS1zcGFjZTogbm93cmFwOyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9Ci5uZS1maW5kIC5pY29uLWJ0biB7IHdpZHRoOiAzMnB4OyBoZWlnaHQ6IDMycHg7IH0KLm5vdGVzLWVtcHR5IHsgcGFkZGluZzogMjRweCAxMnB4OyB0ZXh0LWFsaWduOiBjZW50ZXI7IGZvbnQtc2l6ZTogMTNweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5ub3Rlcy1lbXB0eSBwIHsgbWFyZ2luOiAwIDAgOHB4OyB9Ci5ub3Rlcy1mb290IHsgZmxleDogbm9uZTsgcGFkZGluZzogOHB4IDE2cHggMTJweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLm5vdGVzLWZvb3Q6ZW1wdHkgeyBkaXNwbGF5OiBub25lOyB9Cgoubm90ZS1lZGl0b3IgewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0xKTsKfQoubmUtYmFyIHsgZGlzcGxheTo",
"gZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA0cHg7IHBhZGRpbmc6IDhweCAxMHB4IDAgMjhweDsgZmxleDogbm9uZTsgbWluLWhlaWdodDogNDhweDsgfQoubmUtc3RhdHVzIHsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IHdoaXRlLXNwYWNlOiBub3dyYXA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyBtaW4td2lkdGg6IDA7IH0KLm5lLXN0YXR1cy5lcnJvciB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci5uZS1iYW5uZXIgewogIG1hcmdpbjogNHB4IDI4cHggMDsKICBwYWRkaW5nOiAxMHB4IDE0cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7CiAgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDEuNDU7CiAgZmxleDogbm9uZTsKfQoubmUtdGl0bGUgewogIGJvcmRlcjogMDsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKfQoubmUtdGl0bGUgeyBmbGV4OiBub25lOyBwYWRkaW5nOiA4cHggMjhweCA2cHg7IGZvbnQtc2l6ZTogMjRweDsgbGluZS1oZWlnaHQ6IDEuMzsgfQoubmUtYm9keSB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGZsZXg6IDE7CiAgbWluLWhlaWdodDogMDsKICBvdmVyZmxvdy15OiBhdXRvOwogIHBhZGRpbmc6IDE",
"wcHggMjhweCAyOHB4OwogIGZvbnQtc2l6ZTogMTVweDsKICBsaW5lLWhlaWdodDogMS42OwogIHdoaXRlLXNwYWNlOiBwcmUtd3JhcDsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKICBvdXRsaW5lOiBub25lOwogIGNvdW50ZXItcmVzZXQ6IG9sMCBvbDEgb2wyIG9sMzsKfQoubmUtdGl0bGU6OnBsYWNlaG9sZGVyIHsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci8qIFRoZSBzY3JhdGNocGFkOiBpdHMgb3duIGNvbG91ciwgYSBmaXhlZCBuYW1lLCBhbmQgcGlubmVkIGluIHRoZSBsaXN0LiAqLwoubm90ZS1lZGl0b3Iuc2NyYXRjaCB7IGJhY2tncm91bmQ6IHZhcigtLXNjcmF0Y2gpOyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxcHggdmFyKC0tc2NyYXRjaC1lZGdlKSwgdmFyKC0tc2hhZG93LTEpOyB9Ci5ub3RlLWVkaXRvci5zY3JhdGNoIC5uZS10b29sYmFyIHsgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLXNjcmF0Y2gtZWRnZSkgNDUlLCB0cmFuc3BhcmVudCk7IH0KLm5vdGUtZWRpdG9yLnNjcmF0Y2ggLm5lLWJhcjplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KLnNjcmF0Y2gtdGl0bGUgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEwcHg7IG1hcmdpbjogMDsgcGFkZGluZy10b3A6IDE4cHg7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLnNjcmF0Y2gtdGl0bGUgLnN0LW5hbWUgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IH0KLnNjcmF0Y2gtdGl0bGUgLm5lLXN0YXR",
"1cyB7IGZvbnQtc2l6ZTogMTJweDsgfQouc2NyYXRjaC10aXRsZSAuaWNvbiB7IGNvbG9yOiB2YXIoLS1zY3JhdGNoLWluayk7IH0KLnNjcmF0Y2gtaXRlbSB7IG1hcmdpbi1ib3R0b206IDRweDsgYmFja2dyb3VuZDogdmFyKC0tc2NyYXRjaCk7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDFweCB2YXIoLS1zY3JhdGNoLWVkZ2UpOyB9Ci5zY3JhdGNoLWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc2NyYXRjaCkgODUlLCB2YXIoLS1zY3JhdGNoLWVkZ2UpKTsgfQouc2NyYXRjaC1pdGVtW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tc2NyYXRjaCk7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDJweCB2YXIoLS1zY3JhdGNoLWVkZ2UpLCB2YXIoLS1zaGFkb3ctMSk7IH0KLnNjcmF0Y2gtaXRlbSAubmktdGl0bGUgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDZweDsgZm9udC13ZWlnaHQ6IDUwMDsgfQouc2NyYXRjaC1pdGVtIC5uaS10aXRsZSAuaWNvbiB7IGZsZXg6IG5vbmU7IGNvbG9yOiB2YXIoLS1zY3JhdGNoLWluayk7IH0KLm5lLXRpdGxlOmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiBub25lOyB9Ci5uZS10aXRsZTpkaXNhYmxlZCwgLm5lLWJvZHlbYXJpYS1kaXNhYmxlZD0idHJ1ZSJdIHsgb3BhY2l0eTogLjY7IH0KLm5lLWJvZHlbZGF0YS1lbXB0eT0iMSJdOjpiZWZvcmUgewogIGNvbnRlbnQ6IGF0dHIoZGF",
"0YS1wbGFjZWhvbGRlcik7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHRvcDogMTBweDsKICBsZWZ0OiAyOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKfQoKLyogQmxvY2tzOiBvbmUgcGVyIHBhcmFncmFwaCwgaGVhZGluZyBvciBsaXN0IGl0ZW0uIEJ1bGxldHMsIG51bWJlcnMgYW5kCiAgIGJveGVzIGFyZSBkcmF3biBoZXJlLCBpbiBlYWNoIGJsb2NrJ3MgbGVmdCBwYWRkaW5nLiAqLwouYmxrIHsgcG9zaXRpb246IHJlbGF0aXZlOyBtaW4taGVpZ2h0OiAxLjZlbTsgLS1sdmw6IDA7IH0KLmJsa1tkYXRhLWxldmVsPSIxIl0geyAtLWx2bDogMTsgfQouYmxrW2RhdGEtbGV2ZWw9IjIiXSB7IC0tbHZsOiAyOyB9Ci5ibGtbZGF0YS1sZXZlbD0iMyJdIHsgLS1sdmw6IDM7IH0KLmJsa1tkYXRhLXR5cGU9ImgxIl0geyBmb250LXNpemU6IDI0cHg7IGxpbmUtaGVpZ2h0OiAxLjM7IGZvbnQtd2VpZ2h0OiA2MDA7IG1hcmdpbjogMTRweCAwIDRweDsgfQouYmxrW2RhdGEtdHlwZT0iaDIiXSB7IGZvbnQtc2l6ZTogMjBweDsgbGluZS1oZWlnaHQ6IDEuMzU7IGZvbnQtd2VpZ2h0OiA2MDA7IG1hcmdpbjogMTJweCAwIDJweDsgfQouYmxrW2RhdGEtdHlwZT0iaDMiXSB7IGZvbnQtc2l6ZTogMTdweDsgbGluZS1oZWlnaHQ6IDEuNDsgZm9udC13ZWlnaHQ6IDYwMDsgbWFyZ2luOiAxMHB4IDAgMnB4OyB9Ci5ibGs6Zmlyc3QtY2hpbGQgeyBtYXJnaW4tdG9wOiAwOyB9Ci5ibGtbZGF0YS1",
"0eXBlPSJ1bCJdLCAuYmxrW2RhdGEtdHlwZT0ib2wiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl0geyBwYWRkaW5nLWxlZnQ6IGNhbGMoMjhweCArIHZhcigtLWx2bCkgKiAyNHB4KTsgfQouYmxrW2RhdGEtdHlwZT0idWwiXTo6YmVmb3JlIHsKICBjb250ZW50OiAnXFwyMDIyJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgbGVmdDogY2FsYyg5cHggKyB2YXIoLS1sdmwpICogMjRweCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjEiXTo6YmVmb3JlIHsgY29udGVudDogJ1xcMjVFNic7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMiJdOjpiZWZvcmUsIC5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjMiXTo6YmVmb3JlIHsgY29udGVudDogJ1xcMjVBQSc7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl06OmJlZm9yZSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGModmFyKC0tbHZsKSAqIDI0cHgpOwogIHdpZHRoOiAyMnB4OwogIHRleHQtYWxpZ246IHJpZ2h0OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOwp9Ci8qIE51bWJlcmluZyByZXN0YXJ0cyB3aGVuZXZlciB0aGUgcnVuIG9mIG51bWJlcmVkIGl0ZW1zIGF0IGEgbGV2ZWwgaXMKICAgYnJva2VuIGJ5IGFueXRoaW5nIHNoYWxsb3dlciBvciBieSBhIG5vbi1saXN0IGJsb2NrLiAqLwouYmxrOm5vdCh",
"bZGF0YS10eXBlPSJ1bCJdKTpub3QoW2RhdGEtdHlwZT0ib2wiXSk6bm90KFtkYXRhLXR5cGU9ImNoZWNrIl0pIHsgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjAiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMCJdIHsgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjEiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMSJdIHsgY291bnRlci1yZXNldDogb2wxIG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMiJdLCAuYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWxldmVsPSIyIl0geyBjb3VudGVyLXJlc2V0OiBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjMiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMyJdIHsgY291bnRlci1yZXNldDogb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjAiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDA7IGNvdW50ZXItcmVzZXQ6IG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjEiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDE7IGNvdW50ZXItcmVzZXQ6IG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMiJ",
"dIHsgY291bnRlci1pbmNyZW1lbnQ6IG9sMjsgY291bnRlci1yZXNldDogb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjMiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMCJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMCkgJy4nOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjEiXTo6YmVmb3JlIHsgY29udGVudDogY291bnRlcihvbDEsIGxvd2VyLWFscGhhKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMiJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMiwgbG93ZXItcm9tYW4pICcuJzsgfQouYmxrW2RhdGEtdHlwZT0ib2wiXVtkYXRhLWxldmVsPSIzIl06OmJlZm9yZSB7IGNvbnRlbnQ6IGNvdW50ZXIob2wzKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl06OmJlZm9yZSB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGMoM3B4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOwogIHRvcDogY2FsYyguOGVtIC0gOXB4KTsKICB3aWR0aDogMTRweDsKICBoZWlnaHQ6IDE0cHg7CiAgYm9yZGVyOiAycHggc29saWQgdmFyKC0tZmctMyk7CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGN1cnNvcjogcG9pbnRlcjsKfQouYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWNoZWNrZWQ9IjEiXTo6YmVmb3JlIHsgYmFja2dyb3VuZDo",
"gdmFyKC0tYWNjZW50KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5ibGtbZGF0YS10eXBlPSJjaGVjayJdW2RhdGEtY2hlY2tlZD0iMSJdOjphZnRlciB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGMoOXB4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOwogIHRvcDogY2FsYyguOGVtIC0gN3B4KTsKICB3aWR0aDogNXB4OwogIGhlaWdodDogMTBweDsKICBib3JkZXI6IHNvbGlkIHZhcigtLW9uLWFjY2VudCk7CiAgYm9yZGVyLXdpZHRoOiAwIDJweCAycHggMDsKICB0cmFuc2Zvcm06IHJvdGF0ZSg0NWRlZyk7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7Cn0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1jaGVja2VkPSIxIl0geyBjb2xvcjogdmFyKC0tZmctMyk7IHRleHQtZGVjb3JhdGlvbjogbGluZS10aHJvdWdoOyB9Ci5uZS1ib2R5IGEgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7IGN1cnNvcjogdGV4dDsgfQoKLyogRm9ybWF0dGluZyB0b29sYmFyIGFuZCB0aGUgbGluayBmaWVsZCBiZW5lYXRoIGl0LiAqLwoubmUtdG9vbGJhciB7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LXdyYXA6IHdyYXA7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBtYXJnaW46IDJweCAyMHB4IDA7CiAgcGFkZGluZzogNHB4IDZweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWN",
"vbCk7CiAgZmxleDogbm9uZTsKfQoudGItYnRuIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIHdpZHRoOiAzMnB4OwogIGhlaWdodDogMzJweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci50Yi1idG46aG92ZXI6bm90KDpkaXNhYmxlZCksIC50Yi1zdHlsZTpob3Zlcjpub3QoOmRpc2FibGVkKSB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQoudGItYnRuW2FyaWEtcHJlc3NlZD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci50Yi1idG46ZGlzYWJsZWQsIC50Yi1zdHlsZTpkaXNhYmxlZCB7IG9wYWNpdHk6IC40OyB9Ci50Yi1zdHlsZSB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCA0cHggMCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNTAwOwp9Ci50Yi1zdHlsZS1sYWJlbCB7IG1pbi13aWR0aDogODRweDsgdGV4dC1hbGlnbjogbGVmdDsgfQoudGItc2VwIHsgd2lkdGg6IDFweDsgaGVpZ2h0OiAyMHB4OyBtYXJnaW46IDAgNnB4OyBiYWNrZ3JvdW5",
"kOiB2YXIoLS1ib3JkZXItc3Ryb25nKTsgb3BhY2l0eTogLjY7IH0KLm5lLWxpbmtiYXIgewogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC13cmFwOiB3cmFwOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgbWFyZ2luOiA2cHggMjBweCAwOwogIHBhZGRpbmc6IDZweCA4cHggNnB4IDEycHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmbGV4OiBub25lOwp9Ci5uZS1saW5rYmFyIC50ZXh0LWlucHV0IHsgZmxleDogMTsgbWluLXdpZHRoOiAxODBweDsgaGVpZ2h0OiAzNHB4OyB9Ci5uZS1saW5rYmFyIC5idG4geyBoZWlnaHQ6IDM0cHg7IH0KLmxpbmstZXJyb3IgeyBmbGV4LWJhc2lzOiAxMDAlOyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgZm9udC1zaXplOiAxMnB4OyB9Ci5saW5rLWVycm9yOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQoKLyog4pSA4pSAIENvbHVtbiBzZXR0aW5ncyBkcmF3ZXIg4pSA4pSAICovCgouc2NyaW0geyBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOyB6LWluZGV4OiA1OyBiYWNrZ3JvdW5kOiB2YXIoLS1zY3JpbSk7IH0KLmRyYXdlciB7CiAgcG9zaXRpb246IGZpeGVkOwogIHotaW5kZXg6IDY7CiAgdG9wOiAwOwogIHJpZ2h0OiAwOwogIGJvdHRvbTogMDsKICB3aWR0aDogbWluKDQ2MHB4LCAxMDB2dyk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29",
"sdW1uOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTMpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKICBmb250LXNpemU6IDE0cHg7CiAgYW5pbWF0aW9uOiBkcmF3ZXItaW4gLjE4cyBlYXNlLW91dDsKfQpAa2V5ZnJhbWVzIGRyYXdlci1pbiB7IGZyb20geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMjRweCk7IG9wYWNpdHk6IDA7IH0gdG8geyB0cmFuc2Zvcm06IG5vbmU7IG9wYWNpdHk6IDE7IH0gfQouZHJhd2VyLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgcGFkZGluZzogMTJweCAxMnB4IDRweCAyNHB4OyBmbGV4OiBub25lOyB9Ci5kcmF3ZXItaGVhZCBoMiB7IG1hcmdpbjogMDsgZmxleDogMTsgZm9udC1zaXplOiAyMHB4OyBmb250LXdlaWdodDogNDAwOyB9Ci5kcmF3ZXItaW50cm8geyBtYXJnaW46IDA7IHBhZGRpbmc6IDAgMjRweCAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IGZvbnQtc2l6ZTogMTNweDsgbGluZS1oZWlnaHQ6IDEuNTsgZmxleDogbm9uZTsgfQouZHJhd2VyLWJvZHkgeyBmbGV4OiAxOyBvdmVyZmxvdy15OiBhdXRvOyBwYWRkaW5nOiA0cHggMjRweCAxNnB4OyB9Ci5jb2wtcm93IHsKICBkaXNwbGF5OiBncmlkOwogIGdhcDogMTBweDsKICBtYXJnaW4tYm90dG9tOiAxMnB4OwogIHBhZGRpbmc6IDEycHggMTJweCAxMHB4IDE0cHg7CiAgYm9",
"yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5yb3ctaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMnB4OyB9Ci5yb3ctaGVhZCAucm93LW51bSB7CiAgd2lkdGg6IDIycHg7CiAgaGVpZ2h0OiAyMnB4OwogIG1hcmdpbi1yaWdodDogOHB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwogIGZsZXg6IG5vbmU7Cn0KLnJvdy1oZWFkIC5yb3ctdGl0bGUgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IGZvbnQtd2VpZ2h0OiA1MDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9Ci5maWVsZCB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogNHB4OyB9Ci5maWVsZC1sYWJlbCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTIpOyB9Ci50ZXh0LWlucHV0IHsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDM4cHg7CiAgcGFkZGluZzogMCAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2x",
"vcjogdmFyKC0tZmcpOwogIGZvbnQ6IGluaGVyaXQ7CiAgZm9udC1zaXplOiAxNHB4Owp9Ci50ZXh0LWlucHV0OmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogLTFweDsgYm9yZGVyLWNvbG9yOiB0cmFuc3BhcmVudDsgfQouZmllbGQtaGVscCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jaGVjayB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMik7IGN1cnNvcjogcG9pbnRlcjsgfQouY2hlY2sgaW5wdXQgeyB3aWR0aDogMThweDsgaGVpZ2h0OiAxOHB4OyBtYXJnaW46IDA7IGFjY2VudC1jb2xvcjogdmFyKC0tYWNjZW50KTsgfQouYWRkLWNvbCB7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDQ0cHg7IGJvcmRlci1yYWRpdXM6IDE2cHg7IGJvcmRlcjogMS41cHggZGFzaGVkIHZhcigtLWJvcmRlci1zdHJvbmcpOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQouYWRkLWNvbDpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQouZHJhd2VyLWZvb3QgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMnB4IDIwcHggMTZweCAyNHB4OwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGZsZXg6IG5",
"vbmU7Cn0KLmRyYXdlci1mb290IC5ub3RlIHsgZmxleDogMTsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGxpbmUtaGVpZ2h0OiAxLjQ1OyB9Ci5mb3JtLWVycm9yIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTNweDsgcGFkZGluZzogMCAyNHB4IDhweDsgZmxleDogbm9uZTsgfQouZm9ybS1lcnJvcjplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KCi8qIOKUgOKUgCBDYXJkIGVkaXRvciDilIDilIAgKi8KCi5kaWFsb2cgewogIHBvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiA2OwogIHRvcDogNTAlOwogIGxlZnQ6IDUwJTsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTAlLCAtNTAlKTsKICB3aWR0aDogbWluKDQ4MHB4LCBjYWxjKDEwMHZ3IC0gMzJweCkpOwogIG1heC1oZWlnaHQ6IGNhbGMoMTAwdmggLSAzMnB4KTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYm9yZGVyLXJhZGl1czogMjRweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmcpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGFuaW1hdGlvbjogZGlhbG9nLWluIC4xNnMgZWFzZS1vdXQ7Cn0KQGtleWZyYW1lcyBkaWFsb2ctaW4geyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGUoLTUwJSwgLTQ3JSk7IH0gdG8geyB",
"vcGFjaXR5OiAxOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTAlLCAtNTAlKTsgfSB9Ci5kaWFsb2ctaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nOiAxNHB4IDEycHggMnB4IDI0cHg7IGZsZXg6IG5vbmU7IH0KLmRpYWxvZy1oZWFkIGgyIHsgbWFyZ2luOiAwOyBmbGV4OiAxOyBmb250LXNpemU6IDIwcHg7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLmRpYWxvZy1ib2R5IHsgZGlzcGxheTogZ3JpZDsgZ2FwOiAxOHB4OyBwYWRkaW5nOiAxMHB4IDI0cHggMThweDsgb3ZlcmZsb3cteTogYXV0bzsgfQouZGlhbG9nLWZvb3QgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMnB4IDIwcHggMTZweCAyNHB4OwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGZsZXg6IG5vbmU7Cn0KLmRpYWxvZy1mb290IC5ub3RlIHsgZmxleDogMTsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGxpbmUtaGVpZ2h0OiAxLjQ1OyB9Ci50ZXh0LWFyZWEgeyBoZWlnaHQ6IGF1dG87IG1pbi1oZWlnaHQ6IDgwcHg7IHBhZGRpbmc6IDlweCAxMnB4OyBsaW5lLWhlaWdodDogMS40NTsgcmVzaXplOiB2ZXJ0aWNhbDsgfQouaGVscC1yb3cgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogYmFzZWxpbmU7IGdhcDogNHB4IDEwcHg7IGZsZXgtd3JhcDogd3JhcDsgZm9udC1zaXp",
"lOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmhlbHAtcm93IC5zdWJqZWN0LXJlZiB7IGNvbG9yOiB2YXIoLS1mZy0yKTsgb3ZlcmZsb3ctd3JhcDogYW55d2hlcmU7IH0KLmxpbmstYnRuIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IGZvbnQtc2l6ZTogMTJweDsgZm9udC13ZWlnaHQ6IDUwMDsgYm9yZGVyLXJhZGl1czogNHB4OyB9Ci5saW5rLWJ0bjpob3ZlciB7IHRleHQtZGVjb3JhdGlvbjogdW5kZXJsaW5lOyB9Ci5zd2F0Y2hlcyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiAxMHB4OyBwYWRkaW5nOiAycHggMDsgfQouc3dhdGNoIHsgcG9zaXRpb246IHJlbGF0aXZlOyB3aWR0aDogMjhweDsgaGVpZ2h0OiAyOHB4OyBjdXJzb3I6IHBvaW50ZXI7IH0KLnN3YXRjaCBpbnB1dCB7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgaW5zZXQ6IDA7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDEwMCU7IG1hcmdpbjogMDsgb3BhY2l0eTogMDsgY3Vyc29yOiBwb2ludGVyOyB9Ci5zd2F0Y2gtZG90IHsKICBkaXNwbGF5OiBibG9jazsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDEwMCU7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLXN0cmlwZSk7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJzOwp9Ci5zd2F0Y2hbZGF0YS1jb2xvdXI9Im5vbmUiXSAuc3dhdGNoLWRvdCB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgdHJhbnNwYXJlbnQgNDUlLCB",
"2YXIoLS1ib3JkZXItc3Ryb25nKSA0NSUsIHZhcigtLWJvcmRlci1zdHJvbmcpIDU1JSwgdHJhbnNwYXJlbnQgNTUlKSwgdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMS41cHggdmFyKC0tYm9yZGVyLXN0cm9uZyk7Cn0KLnN3YXRjaCBpbnB1dDpjaGVja2VkICsgLnN3YXRjaC1kb3QgeyBib3gtc2hhZG93OiAwIDAgMCAycHggdmFyKC0tc3VyZmFjZSksIDAgMCAwIDRweCB2YXIoLS1mZy0yKTsgfQouc3dhdGNoW2RhdGEtY29sb3VyPSJub25lIl0gaW5wdXQ6Y2hlY2tlZCArIC5zd2F0Y2gtZG90IHsKICBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxLjVweCB2YXIoLS1ib3JkZXItc3Ryb25nKSwgMCAwIDAgMnB4IHZhcigtLXN1cmZhY2UpLCAwIDAgMCA0cHggdmFyKC0tZmctMik7Cn0KLnN3YXRjaCBpbnB1dDpmb2N1cy12aXNpYmxlICsgLnN3YXRjaC1kb3QgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogNXB4OyB9Cgouc3Itb25seSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHdpZHRoOiAxcHg7CiAgaGVpZ2h0OiAxcHg7CiAgcGFkZGluZzogMDsKICBtYXJnaW46IC0xcHg7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBjbGlwOiByZWN0KDAgMCAwIDApOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgYm9yZGVyOiAwOwp9CmA7CgogIC8vIOKUgOKUgCBDYWxlbmRhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIFdpZGU6IHRoZSB3ZWVrIGFzIHNldmVuIGNvbHVtbnMgKG9yIHRoZSBtb250aCwgb3IgdGhlIGFnZW5kYSkgYmVzaWRlCiAgLy8gYSBzaWRlYmFyLiBOYXJyb3cgKGRhdGEtbmFycm93LCBzZXQgZnJvbSB0aGUgdmlldydzIG93biB3aWR0aCk6IHRoZQogIC8vIHdlZWsgYXMgdHdvIGNvbHVtbnMgb2YgZGF5IHRpbGVzLCByZWFkIGRvd24gdGhlbiBhY3Jvc3MsIHdpdGggdGhlCiAgLy8gc21hbGwgbW9udGggYXMgdGhlIGVpZ2h0aCB0aWxlIGFuZCB0aGUgc2lkZWJhcidzIHBhcnRzIHNwcmVhZCBhYm92ZQogIC8vIGFuZCBiZWxvdy4KCiAgY29uc3QgQ0FMRU5EQVIgPSBgCi5jYWwgewogIGZsZXg6IDE7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIG1pbi13aWR0aDogMDsKICBtaW4taGVpZ2h0OiAwOwogIHBhZGRpbmc6IDAgMjBweCAyMHB4Owp9Ci5jYWwtaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBoZWlnaHQ6IDUycHg7IGZsZXg6IG5vbmU7IH0KLmNhbC1uYXYgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDJweDsgZmxleDogbm9uZTsgfQouYnRuLW91dGxpbmU",
"geyBoZWlnaHQ6IDM0cHg7IHBhZGRpbmc6IDAgMTZweDsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN0cm9uZyk7IGNvbG9yOiB2YXIoLS1mZyk7IG1hcmdpbi1yaWdodDogNHB4OyB9Ci5idG4tb3V0bGluZTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQouY2FsLXRpdGxlIHsKICBmbGV4OiAxOwogIG1pbi13aWR0aDogMDsKICBtYXJnaW46IDAgMCAwIDZweDsKICBmb250LXNpemU6IDIwcHg7CiAgZm9udC13ZWlnaHQ6IDQwMDsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7Cn0KLmNhbC12aWV3cyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogMnB4OyBwYWRkaW5nOiAzcHg7IGJvcmRlci1yYWRpdXM6IDIwcHg7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgZmxleDogbm9uZTsgfQouc2VnIHsgaGVpZ2h0OiAzMHB4OyBwYWRkaW5nOiAwIDE0cHg7IGJvcmRlci1yYWRpdXM6IDE1cHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZm9udC13ZWlnaHQ6IDUwMDsgZm9udC1zaXplOiAxMy41cHg7IH0KLnNlZzpob3ZlciB7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLnNlZ1thcmlhLXNlbGVjdGVkPSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsgY29sb3I6IHZhcigtLWZnKTsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOyB9CgouY2FsLW5vdGUgewogIGZsZXg6IG5vbmU7CiAgbWFyZ2luOiAwIDAgMTBweDs",
"KICBwYWRkaW5nOiA4cHggMTRweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMS40NTsKfQouY2FsLW5vdGUgcCB7IG1hcmdpbjogMDsgfQouY2FsLW5vdGUgcCArIHAgeyBtYXJnaW4tdG9wOiA0cHg7IH0KLmNhbC1ub3RlIHN0cm9uZyB7IGNvbG9yOiB2YXIoLS1mZyk7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLmNhbC1ub3RlIGEsIC5jYWwgLnBhbmVsIGEgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgd29yZC1icmVhazogYnJlYWstYWxsOyB9Ci5jYWwtbm90ZSAuYnRuIHsgaGVpZ2h0OiAyOHB4OyBtYXJnaW4tbGVmdDogNHB4OyB9CgouY2FsLWJvZHkgeyBmbGV4OiAxOyBkaXNwbGF5OiBmbGV4OyBnYXA6IDEycHg7IG1pbi1oZWlnaHQ6IDA7IH0KLmNhbC1zaWRlIHsgd2lkdGg6IDIyOHB4OyBmbGV4OiBub25lOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDEwcHg7IG92ZXJmbG93LXk6IGF1dG87IH0KLmNhbC1tYWluIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBtaW4taGVpZ2h0OiAwOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyB9Ci5jYWwtbWluaSwgLmNhbC1zb3VyY2VzLCAuY2FsLXRyYXkgewogIGZsZXg6IG5vbmU7CiAgcGFkZGluZzogMTB",
"weDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7Cn0KCi8qIFRoZSBzbWFsbCBtb250aCAqLwoubWluaS1oZWFkIHsgbWFyZ2luOiAwIDAgNnB4IDRweDsgZm9udC1zaXplOiAxNHB4OyBmb250LXdlaWdodDogNTAwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5taW5pLWdyaWQgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg3LCBtaW5tYXgoMCwgMWZyKSk7IHJvdy1nYXA6IDJweDsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5taW5pLWRvdyB7IHBhZGRpbmc6IDJweCAwOyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubWluaS1kYXkgeyBoZWlnaHQ6IDI2cHg7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTIpOyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9Ci5taW5pLWRheTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgYm9yZGVyLXJhZGl1czogOHB4OyB9Ci5taW5pLWRheS5vdGhlciB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubWluaS1kYXkuc2hvd24geyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLm1pbmktZGF5LnRvZGF5IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7IGJvcmR",
"lci1yYWRpdXM6IDhweDsgZm9udC13ZWlnaHQ6IDYwMDsgfQoKLyogQ2FsZW5kYXJzIGFuZCB0YXNrIGxpc3RzICovCi5jYWwtc291cmNlcyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMXB4OyBwYWRkaW5nOiA2cHg7IH0KLnNyYyB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTBweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCA4cHg7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1zaXplOiAxMy41cHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKfQouc3JjOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5zcmMgLnN3YXRjaCB7CiAgZmxleDogbm9uZTsKICB3aWR0aDogMTRweDsKICBoZWlnaHQ6IDE0cHg7CiAgYm9yZGVyOiAycHggc29saWQgdmFyKC0tc3JjLCB2YXIoLS1hY2NlbnQpKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zcmMsIHZhcigtLWFjY2VudCkpOwogIGJvcmRlci1yYWRpdXM6IDUwJTsKfQouc3JjLXRhc2tzIC5zd2F0Y2ggeyBib3JkZXItcmFkaXVzOiA0cHg7IH0KLnNyY1thcmlhLXByZXNzZWQ9ImZhbHNlIl0gLnN3YXRjaCB7IGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OyB9Ci5zcmNbYXJpYS1wcmVzc2VkPSJmYWxzZSJdIC5zcmMtbmFtZSB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQouc3JjLW5hbWUgeyBtaW4td2lkdGg6IDA7IG92ZXJmbG93OiBoaWRkZW4",
"7IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9CgovKiBUYXNrcyB3aXRob3V0IGEgZGF5ICovCi5jYWwtdHJheSBoMyB7IG1hcmdpbjogMnB4IDRweCA2cHg7IGZvbnQtc2l6ZTogMTIuNXB4OyBmb250LXdlaWdodDogNTAwOyBjb2xvcjogdmFyKC0tZmctMik7IH0KLmNhbC10cmF5IGgzIC5jb3VudCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC13ZWlnaHQ6IDQwMDsgfQouY2FsLXRyYXkgLmNhbC1pdGVtcyArIGgzIHsgbWFyZ2luLXRvcDogMTJweDsgfQoKLyogRGF5cyAqLwouY2FsLXdlZWsgeyBmbGV4OiAxOyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg3LCBtaW5tYXgoMCwgMWZyKSk7IGdhcDogOHB4OyBtaW4taGVpZ2h0OiAwOyB9Ci5kYXkgewogIG1pbi13aWR0aDogMDsKICBtaW4taGVpZ2h0OiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBwYWRkaW5nOiA4cHg7CiAgYm9yZGVyLXJhZGl1czogMTRweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5kYXkud2Vla2VuZCwgLm1jZWxsLndlZWtlbmQgeyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc3VyZmFjZSkgNTUlLCB2YXIoLS1jb2wpKTsgfQouZGF5LnRvZGF5IHsgcGFkZGluZzogN3B4OyBib3JkZXI6IDJweCBzb2xpZCB2YXIoLS1hY2NlbnQ",
"pOyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc3VyZmFjZSkgOTIlLCB2YXIoLS1hY2NlbnQpKTsgfQouY2FsLXdlZWsgLmRheSAuY2FsLWl0ZW1zIHsgZmxleDogMTsgbWluLWhlaWdodDogMDsgb3ZlcmZsb3cteTogYXV0bzsgfQouZGF5LWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDZweDsgbWFyZ2luOiAwIDAgNnB4IDJweDsgZm9udC1zaXplOiAxNHB4OyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5kYXktaGVhZCAuZG5hbWUgeyBjb2xvcjogdmFyKC0tZmctMik7IH0KLmRheS1oZWFkIC5kbnVtIHsgZm9udC13ZWlnaHQ6IDUwMDsgfQouc3VuZGF5IC5kYXktaGVhZCwgLnN1bmRheSAuZGF5LWhlYWQgLmRuYW1lLCAubWNlbGwuc3VuZGF5Om5vdCgudG9kYXkpIC5tZGF5LCAuYWRheS5zdW5kYXkgLmFkYXktZGF0ZSB7IGNvbG9yOiB2YXIoLS1jLXJlZCk7IH0KLmJhZGdlIHsgcGFkZGluZzogMXB4IDdweDsgYm9yZGVyLXJhZGl1czogOXB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50KTsgZm9udC1zaXplOiAxMXB4OyBmb250LXdlaWdodDogNTAwOyB9Ci5kYXkucGFzdCAuaXRlbSB7IG9wYWNpdHk6IC43ODsgfQoubWluaS10aWxlIHsgZGlzcGxheTogbm9uZTsgfQoubG9hZGluZyAuY2FsLWl0ZW1zOjpiZWZvcmUsCi5jYWwtYWdlbmRhLmxvYWRpbmc6OmJlZm9yZSB7CiAgY29udGVudDogIiI7CiAgZGlzcGxheTo",
"gYmxvY2s7CiAgaGVpZ2h0OiAyMnB4OwogIGJvcmRlci1yYWRpdXM6IDZweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7CiAgYW5pbWF0aW9uOiBjYWwtcHVsc2UgMS4ycyBlYXNlLWluLW91dCBpbmZpbml0ZSBhbHRlcm5hdGU7Cn0KQGtleWZyYW1lcyBjYWwtcHVsc2UgeyBmcm9tIHsgb3BhY2l0eTogLjQ7IH0gdG8geyBvcGFjaXR5OiAxOyB9IH0KCi8qIEV2ZW50cyBhbmQgdGFza3MgKi8KLmNhbC1pdGVtcyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogNHB4OyBtaW4td2lkdGg6IDA7IH0KLml0ZW0gewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBtaW4td2lkdGg6IDA7CiAgYm9yZGVyLXJhZGl1czogNnB4OwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1zaXplOiAxMi41cHg7CiAgbGluZS1oZWlnaHQ6IDEuMzsKICB0ZXh0LWRlY29yYXRpb246IG5vbmU7Cn0KYS5pdGVtOmhvdmVyIHsgYmFja2dyb3VuZC1pbWFnZTogbGluZWFyLWdyYWRpZW50KHZhcigtLWhvdmVyKSwgdmFyKC0taG92ZXIpKTsgfQouaXRlbSAudCB7IG1pbi13aWR0aDogMDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IHdoaXRlLXNwYWNlOiBub3dyYXA7IH0KLmV2IHsKICBwYWRkaW5nOiAzcHggNnB4OwogIGJvcmRlci1sZWZ0OiAzcHggc29saWQgdmFyKC0tYywgdmFyKC0tYWNjZW50KSk7CiAgYmFja2dyb3VuZC1",
"jb2xvcjogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWMsIHZhcigtLWFjY2VudCkpIDE0JSwgdmFyKC0tc3VyZmFjZSkpOwp9Ci5ldi5hbGwtZGF5IHsgYmFja2dyb3VuZC1jb2xvcjogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWMsIHZhcigtLWFjY2VudCkpIDMyJSwgdmFyKC0tc3VyZmFjZSkpOyB9Ci5ldiAudGltZSB7IGZsZXg6IG5vbmU7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZm9udC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtczsgfQovKiBJbiBhIGRheSdzIGNvbHVtbiBvciB0aWxlLCBhIHRpdGxlIGdldHMgdHdvIGxpbmVzIGJlZm9yZSBpdCBpcyBjdXQsCiAgIGFuZCBnb2VzIHVuZGVyIGl0cyB0aW1lIHdoZW4gdGhlIHR3byB3aWxsIG5vdCBmaXQgc2lkZSBieSBzaWRlLiAqLwouY2FsLXdlZWsgLml0ZW0geyBhbGlnbi1pdGVtczogZmxleC1zdGFydDsgfQouY2FsLXdlZWsgLmV2IHsgZmxleC13cmFwOiB3cmFwOyByb3ctZ2FwOiAwOyB9Ci5jYWwtd2VlayAuZXYgLnQgeyBmbGV4OiAxIDEgNi41ZW07IH0KLmNhbC13ZWVrIC5pdGVtIC50LCAuY2FsLXRyYXkgLml0ZW0gLnQgewogIGRpc3BsYXk6IC13ZWJraXQtYm94OwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydGljYWw7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIHdoaXRlLXNwYWNlOiBub3JtYWw7CiAgb3ZlcmZsb3ctd3JhcDogYW55d2hlcmU7Cn0KLmNhbC13ZWVrIC50YXNrIC5ib3gsIC5jYWwtdHJheSAudGFzayAuYm94IHsgbWFyZ2l",
"uLXRvcDogMXB4OyB9Ci50YXNrIHsgcGFkZGluZzogMnB4IDRweDsgfQoudGFzayAuYm94IHsKICBmbGV4OiBub25lOwogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDE0cHg7CiAgaGVpZ2h0OiAxNHB4OwogIGJvcmRlcjogMS42cHggc29saWQgdmFyKC0tZmctMik7CiAgYm9yZGVyLXJhZGl1czogNHB4Owp9Ci50YXNrLmRvbmUgLmJveCB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7IGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7IH0KLnRhc2suZG9uZSAudCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgdGV4dC1kZWNvcmF0aW9uOiBsaW5lLXRocm91Z2g7IH0KLnRhc2sgLmR1ZSB7IGZsZXg6IG5vbmU7IG1hcmdpbi1sZWZ0OiBhdXRvOyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgZm9udC1zaXplOiAxMS41cHg7IH0KLnRhc2sgLm1haWwgeyBmbGV4OiBub25lOyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgbWFyZ2luLWxlZnQ6IGF1dG87IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci50YXNrIC5kdWUgKyAubWFpbCB7IG1hcmdpbi1sZWZ0OiA0cHg7IH0KCi8qIE1vbnRoICovCi5jYWwtbW9udGggeyBmbGV4OiAxOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBtaW4taGVpZ2h0OiAwOyB9Ci5tb250aC1kb3dzIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1",
"wbGF0ZS1jb2x1bW5zOiByZXBlYXQoNywgbWlubWF4KDAsIDFmcikpOyBnYXA6IDZweDsgcGFkZGluZy1ib3R0b206IDRweDsgY29sb3I6IHZhcigtLWZnLTMpOyBmb250LXNpemU6IDEycHg7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoubW9udGgtZ3JpZCB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBncmlkOwogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDcsIG1pbm1heCgwLCAxZnIpKTsKICBncmlkLXRlbXBsYXRlLXJvd3M6IHJlcGVhdCh2YXIoLS1yb3dzLCA1KSwgbWlubWF4KDAsIDFmcikpOwogIGdhcDogNnB4OwogIG1pbi1oZWlnaHQ6IDA7Cn0KLm1jZWxsIHsKICBtaW4td2lkdGg6IDA7CiAgbWluLWhlaWdodDogMDsKICBvdmVyZmxvdzogaGlkZGVuOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDJweDsKICBwYWRkaW5nOiA0cHggNnB4IDZweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7Cn0KLm1jZWxsLm90aGVyIHsgb3BhY2l0eTogLjU1OyB9Ci5tY2VsbC50b2RheSB7IHBhZGRpbmc6IDNweCA1cHggNXB4OyBib3JkZXI6IDJweCBzb2xpZCB2YXIoLS1hY2NlbnQpOyB9Ci5tZGF5IHsgYWxpZ24tc2VsZjogZmxleC1zdGFydDsgbWluLXdpZHRoOiAyNHB4OyBoZWlnaHQ6IDI0cHg7IHBhZGRpbmc6IDAgNnB4OyBib3JkZXItcmFkaXVzOiAxMnB",
"4OyBmb250LXNpemU6IDEyLjVweDsgZm9udC13ZWlnaHQ6IDUwMDsgfQoubWRheTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQoubWNlbGwudG9kYXkgLm1kYXkgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50KTsgfQouaXRlbS5jb21wYWN0IHsgZm9udC1zaXplOiAxMnB4OyB9Ci5ldi5jb21wYWN0IHsgcGFkZGluZzogMXB4IDVweDsgfQoubW9yZSB7IGFsaWduLXNlbGY6IGZsZXgtc3RhcnQ7IHBhZGRpbmc6IDFweCA2cHg7IGJvcmRlci1yYWRpdXM6IDZweDsgY29sb3I6IHZhcigtLWZnLTIpOyBmb250LXNpemU6IDEycHg7IH0KLm1vcmU6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KCi8qIEFnZW5kYSAqLwouY2FsLWFnZW5kYSB7IGZsZXg6IDE7IG1pbi1oZWlnaHQ6IDA7IG92ZXJmbG93LXk6IGF1dG87IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogOHB4OyBtYXgtd2lkdGg6IDg4MHB4OyB9Ci5hZGF5IHsgZmxleDogbm9uZTsgZGlzcGxheTogZmxleDsgZ2FwOiAxNnB4OyBwYWRkaW5nOiAxMHB4IDE0cHg7IGJvcmRlci1yYWRpdXM6IDE0cHg7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyB9Ci5hZGF5LnRvZGF5IHsgcGFkZGluZzogOXB4IDEzcHg7IGJvcmRlcjogMnB4IHNvbGlkIHZhcigtLWFjY2VudCk7IH0KLmFkYXktZGF0ZSB7IGZ",
"sZXg6IG5vbmU7IHdpZHRoOiA4NHB4OyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgY29sb3I6IHZhcigtLWZnKTsgfQouYWRheS1kYXRlIC5kbnVtIHsgbWluLXdpZHRoOiAxLjRlbTsgZm9udC1zaXplOiAyNHB4OyBsaW5lLWhlaWdodDogMTsgdGV4dC1hbGlnbjogcmlnaHQ7IH0KLmFkYXktZGF0ZSAuZG5hbWUgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBmb250LXNpemU6IDEycHg7IGxpbmUtaGVpZ2h0OiAxLjI1OyB9Ci5hZGF5LWRhdGUgLm1vbiB7IG9wYWNpdHk6IC43OyB9Ci5hZGF5IC5jYWwtaXRlbXMgeyBmbGV4OiAxOyBnYXA6IDRweDsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IH0KLmFkYXkgLml0ZW0geyBmb250LXNpemU6IDEzLjVweDsgfQovKiBUaGUgYWdlbmRhIGlzIGEgbGlzdDogYSBkb3Qgb2YgdGhlIGNhbGVuZGFyJ3MgY29sb3VyLCBub3QgYSBibG9jay4gKi8KLmFkYXkgLmV2IHsgcGFkZGluZzogM3B4IDZweDsgYm9yZGVyLWxlZnQ6IDA7IGJhY2tncm91bmQ6IG5vbmU7IH0KLmFkYXkgLmV2OjpiZWZvcmUgeyBjb250ZW50OiAiIjsgZmxleDogbm9uZTsgd2lkdGg6IDEwcHg7IGhlaWdodDogMTBweDsgbWFyZ2luLXJpZ2h0OiA0cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsgYmFja2dyb3VuZDogdmFyKC0tYywgdmFyKC0tYWNjZW50KSk7IH0KLmFkYXkgLmV2IC50aW1lIHsgbWluLXdpZHRoOiA3LjVlbTsgfQouYWRheSAudGFzayB",
"7IHBhZGRpbmctbGVmdDogNHB4OyB9Ci5hZGF5IC50YXNrIC5tYWlsLCAuYWRheSAudGFzayAuZHVlIHsgbWFyZ2luLWxlZnQ6IDZweDsgfQouZW1wdHkgeyBtYXJnaW46IDA7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxM3B4OyB9Ci5jYWwtYWdlbmRhID4gLmVtcHR5IHsgbWFyZ2luOiAyNHB4IGF1dG87IH0KCi8qIE5hcnJvdzogYSBwaG9uZSwgb3IgYSBuYXJyb3cgd2luZG93ICovCi5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSB7IHBhZGRpbmc6IDAgMTJweCAxNnB4OyBvdmVyZmxvdy15OiBhdXRvOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLXZpZXdzIHsgZGlzcGxheTogbm9uZTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1oZWFkIHsgaGVpZ2h0OiA0OHB4OyBnYXA6IDRweDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC10aXRsZSB7IG9yZGVyOiAtMTsgbWFyZ2luOiAwIDRweCAwIDJweDsgZm9udC1zaXplOiAxNi41cHg7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5idG4tb3V0bGluZSB7IGhlaWdodDogMzJweDsgcGFkZGluZzogMCAxMnB4OyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLWJvZHkgeyBmbGV4OiBub25lOyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDEwcHg7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtc2lkZSB7IGRpc3BsYXk6IGNvbnRlbnRzOyB9Ci5jYWxbZGF0YS1",
"uYXJyb3c9InRydWUiXSAuY2FsLW1pbmkgeyBkaXNwbGF5OiBub25lOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLXNvdXJjZXMgewogIG9yZGVyOiAwOwogIGZsZXgtZGlyZWN0aW9uOiByb3c7CiAgZ2FwOiA2cHg7CiAgcGFkZGluZzogMCAwIDJweDsKICBib3JkZXI6IDA7CiAgYmFja2dyb3VuZDogbm9uZTsKICBvdmVyZmxvdy14OiBhdXRvOwogIHNjcm9sbGJhci13aWR0aDogbm9uZTsKfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLnNyYyB7CiAgZmxleDogbm9uZTsKICBnYXA6IDdweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCAxMnB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGZvbnQtc2l6ZTogMTNweDsKfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLnNyYyAuc3dhdGNoIHsgd2lkdGg6IDEwcHg7IGhlaWdodDogMTBweDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1tYWluIHsgb3JkZXI6IDE7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtdHJheSB7IG9yZGVyOiAyOyBib3JkZXItc3R5bGU6IGRhc2hlZDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC13ZWVrIHsKICBmbGV4OiBub25lOwogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDIsIG1pbm1heCgwLCAxZnIpKTsKICBncmlkLXRlbXB",
"sYXRlLXJvd3M6IHJlcGVhdCg0LCBhdXRvKTsKICBncmlkLWF1dG8tZmxvdzogY29sdW1uOwp9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuZGF5IHsgbWluLWhlaWdodDogMTIwcHg7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtd2VlayAuZGF5IC5jYWwtaXRlbXMgeyBvdmVyZmxvdzogdmlzaWJsZTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLm1pbmktdGlsZSB7IGRpc3BsYXk6IGZsZXg7IH0KLm1pbmktdGlsZSAubWluaS1oZWFkIHsgbWFyZ2luLWJvdHRvbTogMnB4OyB9Ci5taW5pLXRpbGUgLm1pbmktZGF5IHsgaGVpZ2h0OiAyMHB4OyBmb250LXNpemU6IDExcHg7IH0KLm1pbmktdGlsZSAubWluaS1kb3cgeyBmb250LXNpemU6IDEwcHg7IHBhZGRpbmc6IDA7IH0KCi5jYWwuY2FsLXBhbmVsIC5jYWwtc2lkZSB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhbC1tYWluID4gLnBhbmVsIHsgbWFyZ2luOiBhdXRvOyB9CmA7CgogIC8vIOKUgOKUgCBEb2NrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBET0NLID0gYAo6aG9zdCB7IHotaW5kZXg6IDIxNDc0ODI5OTkgIWltcG9ydGFudDsgfQoKLmRvY2sgewo",
"gIHBvc2l0aW9uOiBmaXhlZDsKICBsZWZ0OiAxNnB4OwogIGJvdHRvbTogMTZweDsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwogIGZvbnQtc2l6ZTogMTRweDsKICAtd2Via2l0LWZvbnQtc21vb3RoaW5nOiBhbnRpYWxpYXNlZDsKfQouZG9jay5yaWdodCB7IGxlZnQ6IGF1dG87IHJpZ2h0OiA3MnB4OyB9Ci5kb2NrW2hpZGRlbl0geyBkaXNwbGF5OiBub25lOyB9Ci5waWxsIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNnB4OwogIGhlaWdodDogNDBweDsKICBwYWRkaW5nOiAwIDE2cHggMCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDIwcHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgY29sb3I6IHZhcigtLWZnKTsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMik7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIG1heC13aWR0aDogMzIwcHg7Cn0KLnBpbGw6aG92ZXIgeyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMyk7IGJhY2tncm91bmQtaW1hZ2U6IGxpbmVhci1ncmFkaWVudCh2YXIoLS1ob3ZlciksIHZhcigtLWhvdmVyKSk7IH0KLnBpbGwgLmljb24geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQoucGlsbC5vbiB7IGJhY2tncm91bmQtY29sb3I6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9",
"uLWFjY2VudC1zb2Z0KTsgfQoucGlsbC5vbiAuaWNvbiB7IGNvbG9yOiBpbmhlcml0OyB9Ci5waWxsIC5waWxsLWxhYmVsIHsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IH0KLnBpbGwgLmNhcmV0IHsgbWFyZ2luOiAwIC02cHggMCAtMnB4OyBjb2xvcjogaW5oZXJpdDsgfQoucGlsbC1jb21wYWN0IHsgcGFkZGluZzogMCAxNHB4IDAgMTBweDsgfQoucGlsbC5idXN5IHsgb3BhY2l0eTogLjc7IH0KYDsKCiAgbnMuc3R5bGVzID0geyBib2FyZDogQkFTRSArIEJPQVJEICsgQ0FMRU5EQVIsIGRvY2s6IEJBU0UgKyBET0NLIH07Cn0pKCk7Cg\"],[\"src/content/note-editor.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBmb3JtYXR0ZWQgbm90ZSBlZGl0b3IKLy8KLy8gQW4gZWRpdGFibGUgYXJlYSB3aXRoIGEgdG9vbGJhcjogdGV4dCBzdHlsZSAobm9ybWFsLCB0aHJlZSBoZWFkaW5ncyksCi8vIGJvbGQsIGl0YWxpYywgc3RyaWtlLXRocm91Z2gsIGJ1bGxldGVkLCBudW1iZXJlZCBhbmQgY2hlY2sgbGlzdHMgd2l0aAovLyB0aHJlZSBsZXZ",
"lbHMgb2YgbmVzdGluZywgbGlua3MsIGFuZCBjbGVhciBmb3JtYXR0aW5nLgovLwovLyBUaGUgZWRpdGFibGUgYXJlYSBpcyBhIGZsYXQgY29sdW1uIG9mIGJsb2NrcyAtIG9uZSA8ZGl2IGNsYXNzPSJibGsiPgovLyBwZXIgcGFyYWdyYXBoLCBoZWFkaW5nIG9yIGxpc3QgaXRlbSwgaXRzIGtpbmQgYW5kIGluZGVudCBpbiBkYXRhCi8vIGF0dHJpYnV0ZXMsIGJ1bGxldHMsIG51bWJlcnMgYW5kIGJveGVzIGRyYXduIGJ5IHRoZSBzdHlsZXNoZWV0LiBCb2xkLAovLyBpdGFsaWMsIHN0cmlrZS10aHJvdWdoIGFuZCBsaW5rcyB1c2UgdGhlIGJyb3dzZXIncyBvd24gZWRpdGluZwovLyBjb21tYW5kcywgd2hpY2ggaGFuZGxlIHRoZW0gd2VsbC4gTGlzdHMgYW5kIGhlYWRpbmdzIGRvIG5vdCB1c2UgdGhlbToKLy8gdGhlIGJyb3dzZXIncyBsaXN0IGNvbW1hbmRzIG5lc3QgZWxlbWVudHMgaW4gd2F5cyB0aGF0IGFyZSBoYXJkIHRvIHJlYWQKLy8gYmFjaywgc28gYmxvY2tzIGFyZSByZXN0eWxlZCBoZXJlIGRpcmVjdGx5IGluc3RlYWQuIFdoYXQgaXMgc2F2ZWQgaXMKLy8gbmV2ZXIgdGhpcyBtYXJrdXA6IGl0IGlzIHJlYWQgYmFjayBpbnRvIHRoZSBub3RlLWZvcm1hdCBtb2RlbCwgd2hpY2gKLy8gb25seSBrbm93cyB3aGF0IHRoZSB0b29sYmFyIGNhbiBtYWtlLgovLwovLyBQYXN0ZWQgdGV4dCBrZWVwcyB0aGUgZm9ybWF0dGluZyB0aGUgbW9kZWwgY2FuIGhvbGQgLSBmcm9tIFdvcmQsIEdvb2dsZQovLyBEb2NzLCBhIHd",
"lYiBwYWdlLCBhbiBlbWFpbCwgRXhjZWwsIG9yIE1hcmtkb3duIGZyb20gYSBjaGF0IGFzc2lzdGFudCAtCi8vIHJlYWQgYnkgbm90ZS1mb3JtYXQncyBvd24gcmVhZGVyLCBzbyBhIHBhZ2UgY29waWVkIGZyb20gdGhlIHdlYiBicmluZ3MKLy8gaXRzIGJvbGQgYW5kIGxpc3RzIGJ1dCBuZXZlciBpdHMgc3R5bGVzLCBpbWFnZXMgb3Igc2NyaXB0cy4gQ3RybCtTaGlmdCtWCi8vIHBhc3RlcyB0aGUgdGV4dCBhbG9uZS4gRHJvcHBlZCB0ZXh0IGlzIG5vdCB0YWtlbiBhdCBhbGwuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgb3Blbk1lbnUsIGNsb3NlTWVudSB9ID0gbnMudWk7CiAgY29uc3QgZm10ID0gbnMubm90ZUZvcm1hdDsKCiAgY29uc3QgU1RZTEVTID0gW1sncCcsICdOb3JtYWwgdGV4dCddLCBbJ2gxJywgJ0hlYWRpbmcgMSddLCBbJ2gyJywgJ0hlYWRpbmcgMiddLCBbJ2gzJywgJ0hlYWRpbmcgMyd",
"dXTsKICBjb25zdCBTVFlMRV9MQUJFTCA9IE9iamVjdC5mcm9tRW50cmllcyhTVFlMRVMpOwogIGNvbnN0IElOREVOVF9QWCA9IDI0OwoKICAvLyBUeXBlZCBhdCB0aGUgc3RhcnQgb2YgYSBwYXJhZ3JhcGggYW5kIGZvbGxvd2VkIGJ5IGEgc3BhY2UsIHRoZXNlIHR1cm4KICAvLyBpdCBpbnRvIGEgbGlzdCBvciBoZWFkaW5nIC0gdGhlIHNob3J0Y3V0cyBtb3N0IGVkaXRvcnMgc2hhcmUuCiAgY29uc3QgQVVUTyA9IFsKICAgIFsvXlstKuKAol0kLywgeyB0eXBlOiAndWwnIH1dLAogICAgWy9eMVsuKV0kLywgeyB0eXBlOiAnb2wnIH1dLAogICAgWy9eXFsgP1xdJC8sIHsgdHlwZTogJ2NoZWNrJyB9XSwKICAgIFsvXlxbW3hYXVxdJC8sIHsgdHlwZTogJ2NoZWNrJywgY2hlY2tlZDogdHJ1ZSB9XSwKICAgIFsvXiMkLywgeyB0eXBlOiAnaDEnIH1dLAogICAgWy9eIyMkLywgeyB0eXBlOiAnaDInIH1dLAogICAgWy9eIyMjJC8sIHsgdHlwZTogJ2gzJyB9XSwKICBdOwoKICAvLyDilIDilIAgTW9kZWwg4oaUIG1hcmt1cCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gc2V0QmxvY2soZWwsIHR5cGUsIGxldmVsID0gMCwgY2hlY2tlZCA9IGZhbHNlKSB7CiAgICBlbC5kYXRhc2V",
"0LnR5cGUgPSB0eXBlOwogICAgaWYgKGZtdC5MSVNUUy5oYXModHlwZSkpIGVsLmRhdGFzZXQubGV2ZWwgPSBTdHJpbmcobGV2ZWwpOwogICAgZWxzZSBkZWxldGUgZWwuZGF0YXNldC5sZXZlbDsKICAgIGlmICh0eXBlID09PSAnY2hlY2snKSBlbC5kYXRhc2V0LmNoZWNrZWQgPSBjaGVja2VkID8gJzEnIDogJzAnOwogICAgZWxzZSBkZWxldGUgZWwuZGF0YXNldC5jaGVja2VkOwogIH0KCiAgZnVuY3Rpb24gaW5saW5lTm9kZXMocnVucykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJ1bnMubGVuZ3RoOykgewogICAgICBjb25zdCBocmVmID0gcnVuc1tpXS5ocmVmIHx8ICcnOwogICAgICBjb25zdCBncm91cCA9IFtdOwogICAgICBsZXQgaiA9IGk7CiAgICAgIHdoaWxlIChqIDwgcnVucy5sZW5ndGggJiYgKHJ1bnNbal0uaHJlZiB8fCAnJykgPT09IGhyZWYpIHsKICAgICAgICBsZXQgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHJ1bnNbal0udGV4dCk7CiAgICAgICAgZm9yIChjb25zdCBtIG9mIFsncycsICdpJywgJ2InXSkgewogICAgICAgICAgaWYgKCFydW5zW2pdW21dKSBjb250aW51ZTsKICAgICAgICAgIGNvbnN0IHcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KG0pOwogICAgICAgICAgdy5hcHBlbmRDaGlsZChub2RlKTsKICAgICAgICAgIG5vZGUgPSB3OwogICAgICAgIH0KICAgICAgICBncm91cC5wdXNoKG5vZGUpOwogICAgICAgIGorKzsKICAgICAgfQo",
"gICAgICBpZiAoaHJlZikgb3V0LnB1c2goaCgnYScsIHsgaHJlZiwgdGl0bGU6IGhyZWYgfSwgZ3JvdXApKTsKICAgICAgZWxzZSBvdXQucHVzaCguLi5ncm91cCk7CiAgICAgIGkgPSBqOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJsb2NrRWwoYikgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIGVsLmNsYXNzTmFtZSA9ICdibGsnOwogICAgc2V0QmxvY2soZWwsIGIudHlwZSwgYi5sZXZlbCwgYi5jaGVja2VkKTsKICAgIGNvbnN0IGtpZHMgPSBpbmxpbmVOb2RlcyhiLnJ1bnMpOwogICAgaWYgKGtpZHMubGVuZ3RoKSBlbC5hcHBlbmQoLi4ua2lkcyk7CiAgICBlbHNlIGVsLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2JyJykpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgZnVuY3Rpb24gc3R5bGVNYXJrcyhzdHlsZSkgewogICAgY29uc3QgcyA9IFN0cmluZyhzdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgIHJldHVybiB7CiAgICAgIGI6IC9mb250LXdlaWdodFxzKjpccyooYm9sZHxib2xkZXJ8WzYtOV0wMCkvLnRlc3QocyksCiAgICAgIGk6IC9mb250LXN0eWxlXHMqOlxzKml0YWxpYy8udGVzdChzKSwKICAgICAgczogL3RleHQtZGVjb3JhdGlvbigtbGluZSk_XHMqOlteO10qbGluZS10aHJvdWdoLy50ZXN0KHMpLAogICAgfTsKICB9CgogIGNvbnN0IE5FU1RFRF9CTE9DS1MgPSBuZXcgU2V0KFsnZGl2JywgJ3AnLCA",
"nbGknLCAndWwnLCAnb2wnLCAnaDEnLCAnaDInLCAnaDMnLCAnaDQnLCAnaDUnLCAnaDYnLCAnYmxvY2txdW90ZScsICdwcmUnXSk7CgogIC8vIFJlYWRzIG9uZSBibG9jayBlbGVtZW50IC0gYW5kIGFueXRoaW5nIHRoZSBicm93c2VyIG1heSBoYXZlIGxlZnQKICAvLyBpbnNpZGUgaXQsIHN1Y2ggYXMgYSA8YnI-IG9yIGEgbmVzdGVkIDxkaXY-IC0gaW50byBtb2RlbCBibG9ja3MuCiAgZnVuY3Rpb24gcmVhZEJsb2NrKGVsLCBvdXQpIHsKICAgIGNvbnN0IHR5cGUgPSBmbXQuVFlQRVMuaGFzKGVsLmRhdGFzZXQudHlwZSkgPyBlbC5kYXRhc2V0LnR5cGUgOiAncCc7CiAgICBjb25zdCBsZXZlbCA9IE51bWJlcihlbC5kYXRhc2V0LmxldmVsKSB8fCAwOwogICAgY29uc3QgZmlyc3QgPSBvdXQubGVuZ3RoOwogICAgbGV0IGN1ciA9IGZtdC5ibG9jayh0eXBlLCBbXSwgeyBsZXZlbCwgY2hlY2tlZDogZWwuZGF0YXNldC5jaGVja2VkID09PSAnMScgfSk7CiAgICBvdXQucHVzaChjdXIpOwogICAgY29uc3QgbmV4dCA9ICgpID0-IHsKICAgICAgY3VyID0gZm10LmJsb2NrKHR5cGUsIFtdLCB7IGxldmVsIH0pOwogICAgICBvdXQucHVzaChjdXIpOwogICAgfTsKICAgIChmdW5jdGlvbiB3YWxrKG5vZGUsIG1hcmtzKSB7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZE5vZGVzKSB7CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlID09PSAzKSB7CiAgICAgICAgICBpZiAoY2hpbGQuZGF0YSkgY3VyLnJ1bnM",
"ucHVzaCh7IHRleHQ6IGNoaWxkLmRhdGEucmVwbGFjZSgvXHUwMGEwL2csICcgJykucmVwbGFjZSgvXG4vZywgJyAnKSwgLi4ubWFya3MgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlICE9PSAxKSBjb250aW51ZTsKICAgICAgICBjb25zdCB0YWcgPSBjaGlsZC50YWdOYW1lLnRvTG93ZXJDYXNlKCk7CiAgICAgICAgaWYgKHRhZyA9PT0gJ2JyJykgeyBuZXh0KCk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKE5FU1RFRF9CTE9DS1MuaGFzKHRhZykpIHsKICAgICAgICAgIGlmIChjdXIucnVucy5sZW5ndGgpIG5leHQoKTsKICAgICAgICAgIHdhbGsoY2hpbGQsIG1hcmtzKTsKICAgICAgICAgIG5leHQoKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBjb25zdCBtID0geyAuLi5tYXJrcyB9OwogICAgICAgIGlmICh0YWcgPT09ICdiJyB8fCB0YWcgPT09ICdzdHJvbmcnKSBtLmIgPSB0cnVlOwogICAgICAgIGVsc2UgaWYgKHRhZyA9PT0gJ2knIHx8IHRhZyA9PT0gJ2VtJykgbS5pID0gdHJ1ZTsKICAgICAgICBlbHNlIGlmICh0YWcgPT09ICdzJyB8fCB0YWcgPT09ICdzdHJpa2UnIHx8IHRhZyA9PT0gJ2RlbCcpIG0ucyA9IHRydWU7CiAgICAgICAgZWxzZSBpZiAodGFnID09PSAnYScpIHsKICAgICAgICAgIGNvbnN0IGhyZWYgPSBmbXQuc2FmZUhyZWYoY2hpbGQuZ2V0QXR0cmlidXRlKCdocmVmJykpOwogICAgICAgICAgaWYgKGhyZWY",
"pIG0uaHJlZiA9IGhyZWY7CiAgICAgICAgfSBlbHNlIGlmICh0YWcgPT09ICdzcGFuJyB8fCB0YWcgPT09ICdmb250JykgewogICAgICAgICAgY29uc3Qgc3QgPSBzdHlsZU1hcmtzKGNoaWxkLmdldEF0dHJpYnV0ZSgnc3R5bGUnKSk7CiAgICAgICAgICBpZiAoc3QuYikgbS5iID0gdHJ1ZTsKICAgICAgICAgIGlmIChzdC5pKSBtLmkgPSB0cnVlOwogICAgICAgICAgaWYgKHN0LnMpIG0ucyA9IHRydWU7CiAgICAgICAgfQogICAgICAgIHdhbGsoY2hpbGQsIG0pOwogICAgICB9CiAgICB9KShlbCwge30pOwogICAgLy8gQSA8YnI-IG9yIG5lc3RlZCBibG9jayBhdCB0aGUgdmVyeSBlbmQgbGVhdmVzIGFuIGVtcHR5IGJsb2NrIGJlaGluZDoKICAgIC8vIHRoYXQgaXMgdGhlIGJyb3dzZXIncyBwbGFjZWhvbGRlciwgbm90IGEgbmV3IGxpbmUuCiAgICB3aGlsZSAob3V0Lmxlbmd0aCAtIDEgPiBmaXJzdCAmJiAhb3V0W291dC5sZW5ndGggLSAxXS5ydW5zLnNvbWUociA9PiByLnRleHQpKSBvdXQucG9wKCk7CiAgfQoKICBmdW5jdGlvbiByZWFkRG9jKGVkaXRvcikgewogICAgY29uc3QgYmxvY2tzID0gW107CiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZWRpdG9yLmNoaWxkTm9kZXMpIHsKICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS5jbGFzc0xpc3QuY29udGFpbnMoJ2JsaycpKSByZWFkQmxvY2sobm9kZSwgYmxvY2tzKTsKICAgICAgZWxzZSBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMyAmJiBub2RlLmR",
"hdGEudHJpbSgpKSBibG9ja3MucHVzaChmbXQuYmxvY2soJ3AnLCBbeyB0ZXh0OiBub2RlLmRhdGEucmVwbGFjZSgvwqAvZywgJyAnKSB9XSkpOwogICAgICBlbHNlIGlmIChub2RlLm5vZGVUeXBlID09PSAxICYmIG5vZGUudGFnTmFtZSAhPT0gJ0JSJykgcmVhZEJsb2NrKG5vZGUsIGJsb2Nrcyk7CiAgICB9CiAgICByZXR1cm4gZm10Lm5vcm1hbGlzZURvYyhibG9ja3MpOwogIH0KCiAgLy8g4pSA4pSAIFNlbGVjdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gY3JlYXRlKHsgcm9vdCwgb25DaGFuZ2UgfSkgewogICAgY29uc3QgZWxzID0ge307CiAgICBsZXQgc2F2ZWQgPSBudWxsOyAgICAgLy8gdGhlIGxhc3Qgc2VsZWN0aW9uIGluc2lkZSB0aGUgZWRpdG9yCiAgICBsZXQgZWRpdGFibGUgPSBmYWxzZTsKICAgIGxldCBwbGFpbk5leHQgPSBmYWxzZTsgLy8gQ3RybCtTaGlmdCtWOiB0aGUgbmV4dCBwYXN0ZSBpcyB0ZXh0IGFsb25lCiAgICBsZXQgcGFzdGVVbmRvID0gW107ICAgIC8vIGhvdyB0aGUgdGV4dCB3YXMgYmVmb3JlIGVhY2ggZm9ybWF0dGVkIHBhc3RlLCBsYXRlc3QgbGFzdAoKICAgIGNvbnN0IHNlbGVjdGlvbiA9ICgpID0",
"-IChyb290LmdldFNlbGVjdGlvbiA_IHJvb3QuZ2V0U2VsZWN0aW9uKCkgOiBkb2N1bWVudC5nZXRTZWxlY3Rpb24oKSk7CgogICAgZnVuY3Rpb24gcmFuZ2UoKSB7CiAgICAgIGNvbnN0IHNlbCA9IHNlbGVjdGlvbigpOwogICAgICBpZiAoIXNlbCB8fCAhc2VsLnJhbmdlQ291bnQpIHJldHVybiBudWxsOwogICAgICBjb25zdCByID0gc2VsLmdldFJhbmdlQXQoMCk7CiAgICAgIHJldHVybiBlbHMuZWRpdG9yLmNvbnRhaW5zKHIuc3RhcnRDb250YWluZXIpICYmIGVscy5lZGl0b3IuY29udGFpbnMoci5lbmRDb250YWluZXIpID8gciA6IG51bGw7CiAgICB9CgogICAgZnVuY3Rpb24gc2VsZWN0KHIpIHsKICAgICAgY29uc3Qgc2VsID0gd2luZG93LmdldFNlbGVjdGlvbigpOwogICAgICBzZWwucmVtb3ZlQWxsUmFuZ2VzKCk7CiAgICAgIHNlbC5hZGRSYW5nZShyKTsKICAgIH0KCiAgICAvLyBUb29sYmFyIGJ1dHRvbnMgZG8gbm90IHRha2UgZm9jdXMgZnJvbSB0aGUgdGV4dCwgYnV0IHRoZSBzdHlsZSBtZW51CiAgICAvLyBhbmQgdGhlIGxpbmsgZmllbGQgZG87IHRoZSBzZWxlY3Rpb24gdGhleSB3ZXJlIG9wZW5lZCBvbiBpcyBwdXQKICAgIC8vIGJhY2sgYmVmb3JlIHRoZSBjaGFuZ2UgaXMgYXBwbGllZC4KICAgIGZ1bmN0aW9uIHJlc3RvcmUoKSB7CiAgICAgIC8vIFRoZSBzZWxlY3Rpb24gY2FuIHN0aWxsIGJlIGluIHRoZSB0ZXh0IHdoaWxlIHRoZSBmb2N1cyBpcyBub3QgLQogICAgICAvLyBvbiB0aGUgc3R5bGU",
"gYnV0dG9uIHRoZSBtZW51IGhhbmRlZCBpdCBiYWNrIHRvLCBzYXkgLSBhbmQgdHlwaW5nCiAgICAgIC8vIHdvdWxkIHRoZW4gZ28gbm93aGVyZS4gQm90aCBhcmUgcHV0IGJhY2suCiAgICAgIGNvbnN0IGtlZXAgPSByYW5nZSgpIHx8IChzYXZlZCAmJiBlbHMuZWRpdG9yLmNvbnRhaW5zKHNhdmVkLnN0YXJ0Q29udGFpbmVyKSA_IHNhdmVkIDogbnVsbCk7CiAgICAgIGlmIChyb290LmFjdGl2ZUVsZW1lbnQgIT09IGVscy5lZGl0b3IpIGVscy5lZGl0b3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBpZiAoa2VlcCkgewogICAgICAgIHRyeSB7IHNlbGVjdChrZWVwLmNsb25lUmFuZ2UgPyBrZWVwLmNsb25lUmFuZ2UoKSA6IGtlZXApOyB9IGNhdGNoIHsgLyogdGhlIHRleHQgY2hhbmdlZCB1bmRlcm5lYXRoICovIH0KICAgICAgfQogICAgfQoKICAgIGZ1bmN0aW9uIGJsb2NrT2Yobm9kZSkgewogICAgICBsZXQgbiA9IG5vZGU7CiAgICAgIGlmIChuID09PSBlbHMuZWRpdG9yKSByZXR1cm4gbnVsbDsKICAgICAgd2hpbGUgKG4gJiYgbi5wYXJlbnROb2RlICE9PSBlbHMuZWRpdG9yKSBuID0gbi5wYXJlbnROb2RlOwogICAgICByZXR1cm4gbiAmJiBuLm5vZGVUeXBlID09PSAxID8gbiA6IG51bGw7CiAgICB9CgogICAgZnVuY3Rpb24gcmFuZ2VCbG9ja3MocikgewogICAgICBjb25zdCBraWRzID0gWy4uLmVscy5lZGl0b3IuY2hpbGRyZW5dOwogICAgICBjb25zdCBlZGdlID0gKGNvbnRhaW5lciw",
"gb2Zmc2V0LCBlbmQpID0-IHsKICAgICAgICBpZiAoY29udGFpbmVyID09PSBlbHMuZWRpdG9yKSByZXR1cm4ga2lkc1tNYXRoLm1pbihraWRzLmxlbmd0aCAtIDEsIE1hdGgubWF4KDAsIG9mZnNldCAtIChlbmQgPyAxIDogMCkpKV07CiAgICAgICAgcmV0dXJuIGJsb2NrT2YoY29udGFpbmVyKTsKICAgICAgfTsKICAgICAgY29uc3QgYSA9IGVkZ2Uoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCwgZmFsc2UpOwogICAgICBjb25zdCBiID0gZWRnZShyLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXQsIHRydWUpOwogICAgICBjb25zdCBpID0ga2lkcy5pbmRleE9mKGEpOwogICAgICBjb25zdCBqID0ga2lkcy5pbmRleE9mKGIpOwogICAgICBpZiAoaSA8IDAgfHwgaiA8IDApIHJldHVybiBhID8gW2FdIDogW107CiAgICAgIHJldHVybiBraWRzLnNsaWNlKE1hdGgubWluKGksIGopLCBNYXRoLm1heChpLCBqKSArIDEpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNhcmV0QXRCbG9ja1N0YXJ0KHIsIGJsaykgewogICAgICBpZiAoIXIgfHwgIXIuY29sbGFwc2VkIHx8ICFibGspIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgcHJlLnNlbGVjdE5vZGVDb250ZW50cyhibGspOwogICAgICBwcmUuc2V0RW5kKHIuc3RhcnRDb250YWluZXIsIHIuc3RhcnRPZmZzZXQpOwogICAgICByZXR1cm4gcHJlLnRvU3RyaW5nKCkgPT09ICcnOwogICAgfQoKICAgIGZ1bmN",
"0aW9uIHBsYWNlQ2FyZXQobm9kZSwgb2Zmc2V0KSB7CiAgICAgIGNvbnN0IHIgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICByLnNldFN0YXJ0KG5vZGUsIG9mZnNldCk7CiAgICAgIHIuY29sbGFwc2UodHJ1ZSk7CiAgICAgIHNlbGVjdChyKTsKICAgIH0KCiAgICAvLyDilIDilIAgS2VlcGluZyB0aGUgbWFya3VwIHRpZHkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogICAgLy8gRWFjaCBsaXN0IGl0ZW0gbWF5IGJlIGF0IG1vc3Qgb25lIGxldmVsIGRlZXBlciB0aGFuIHRoZSBvbmUgYWJvdmUuCiAgICBmdW5jdGlvbiBmaXhMZXZlbHMoKSB7CiAgICAgIGxldCBwcmV2ID0gLTE7CiAgICAgIGZvciAoY29uc3QgYmxrIG9mIGVscy5lZGl0b3IuY2hpbGRyZW4pIHsKICAgICAgICBpZiAoZm10LkxJU1RTLmhhcyhibGsuZGF0YXNldC50eXBlKSkgewogICAgICAgICAgY29uc3QgbHZsID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oZm10Lk1BWF9MRVZFTCwgTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwLCBwcmV2ICsgMSkpOwogICAgICAgICAgYmxrLmRhdGFzZXQubGV2ZWwgPSBTdHJpbmcobHZsKTsKICAgICAgICAgIHByZXYgPSBsdmw7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHByZXYgPSAtMTsKICAgICAgICB9CiA",
"gICAgIH0KICAgIH0KCiAgICAvLyBUaGUgYnJvd3NlciBzb21ldGltZXMgbGVhdmVzIHRleHQsIGEgPGJyPiBvciBhIHBsYWluIDxkaXY-IGRpcmVjdGx5CiAgICAvLyBpbiB0aGUgZWRpdG9yIChhZnRlciBzZWxlY3QtYWxsIGFuZCBkZWxldGUsIHNheSksIGFuZCB3cmFwcyBtZXJnZWQKICAgIC8vIHRleHQgaW4gPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZeKApiI-IHdoZW4gdHdvIGJsb2NrcyBvZiBkaWZmZXJlbnQgc2l6ZXMKICAgIC8vIGpvaW4uIEJvdGggYXJlIHB1dCByaWdodCBoZXJlLCBrZWVwaW5nIHRoZSBjYXJldCB3aGVyZSBpdCB3YXMuCiAgICBmdW5jdGlvbiB0aWR5KCkgewogICAgICBjb25zdCBzZWwgPSBzZWxlY3Rpb24oKTsKICAgICAgY29uc3QgciA9IHNlbCAmJiBzZWwucmFuZ2VDb3VudCA_IHNlbC5nZXRSYW5nZUF0KDApIDogbnVsbDsKICAgICAgY29uc3Qga2VlcCA9IHIgPyBbci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCwgci5lbmRDb250YWluZXIsIHIuZW5kT2Zmc2V0XSA6IG51bGw7CiAgICAgIGxldCBtb3ZlZCA9IGZhbHNlOwoKICAgICAgZm9yIChjb25zdCBub2RlIG9mIFsuLi5lbHMuZWRpdG9yLmNoaWxkTm9kZXNdKSB7CiAgICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS5jbGFzc0xpc3QuY29udGFpbnMoJ2JsaycpICYmIG5vZGUuZGF0YXNldC50eXBlKSBjb250aW51ZTsKICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiAvXihESVZ8UHxIMXx",
"IMnxIMykkLy50ZXN0KG5vZGUudGFnTmFtZSkpIHsKICAgICAgICAgIG5vZGUuY2xhc3NMaXN0LmFkZCgnYmxrJyk7CiAgICAgICAgICBzZXRCbG9jayhub2RlLCAvXkhbMTIzXSQvLnRlc3Qobm9kZS50YWdOYW1lKSA_IG5vZGUudGFnTmFtZS50b0xvd2VyQ2FzZSgpIDogJ3AnKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMyAmJiAhbm9kZS5kYXRhLnRyaW0oKSAmJiAhKGtlZXAgJiYgKGtlZXBbMF0gPT09IG5vZGUgfHwga2VlcFsyXSA9PT0gbm9kZSkpKSB7CiAgICAgICAgICBub2RlLnJlbW92ZSgpOwogICAgICAgICAgY29udGludWU7CiAgICAgICAgfQogICAgICAgIGNvbnN0IGJsayA9IGJsb2NrRWwoZm10LmJsb2NrKCdwJykpOwogICAgICAgIGJsay5yZXBsYWNlQ2hpbGRyZW4oKTsKICAgICAgICBlbHMuZWRpdG9yLmluc2VydEJlZm9yZShibGssIG5vZGUpOwogICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAxICYmIG5vZGUudGFnTmFtZSA9PT0gJ0JSJykgewogICAgICAgICAgYmxrLmFwcGVuZENoaWxkKG5vZGUpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAvLyBHYXRoZXIgdGhpcyBhbmQgYW55IGZvbGxvd2luZyBpbmxpbmUgbmVpZ2hib3VycyBpbnRvIG9uZSBibG9jay4KICAgICAgICAgIGxldCBuID0gbm9kZTsKICAgICAgICAgIHdoaWxlIChuICYmICEobi5ub2RlVHlwZSA9PT0gMSAmJiAobi5jbGFzc0xpc3QuY29udGFpbnM",
"oJ2JsaycpIHx8IE5FU1RFRF9CTE9DS1MuaGFzKG4udGFnTmFtZS50b0xvd2VyQ2FzZSgpKSkpKSB7CiAgICAgICAgICAgIGNvbnN0IGZvbGxvd2luZyA9IG4ubmV4dFNpYmxpbmc7CiAgICAgICAgICAgIGJsay5hcHBlbmRDaGlsZChuKTsKICAgICAgICAgICAgbiA9IGZvbGxvd2luZzsKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgICAgbW92ZWQgPSB0cnVlOwogICAgICB9CgogICAgICBmb3IgKGNvbnN0IHNwYW4gb2YgWy4uLmVscy5lZGl0b3IucXVlcnlTZWxlY3RvckFsbCgnc3BhbltzdHlsZV0sIGZvbnQnKV0pIHsKICAgICAgICBjb25zdCBzdCA9IHN0eWxlTWFya3Moc3Bhbi5nZXRBdHRyaWJ1dGUoJ3N0eWxlJykpOwogICAgICAgIGlmIChzdC5iIHx8IHN0LmkgfHwgc3QucykgY29udGludWU7CiAgICAgICAgc3Bhbi5yZXBsYWNlV2l0aCguLi5zcGFuLmNoaWxkTm9kZXMpOwogICAgICAgIG1vdmVkID0gdHJ1ZTsKICAgICAgfQogICAgICBmb3IgKGNvbnN0IGEgb2YgZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yQWxsKCdhW2hyZWZdJykpIHsKICAgICAgICBjb25zdCBocmVmID0gZm10LnNhZmVIcmVmKGEuZ2V0QXR0cmlidXRlKCdocmVmJykpOwogICAgICAgIGlmICghaHJlZikgYS5yZXBsYWNlV2l0aCguLi5hLmNoaWxkTm9kZXMpOwogICAgICAgIGVsc2UgaWYgKGEudGl0bGUgIT09IGhyZWYpIGEudGl0bGUgPSBocmVmOwogICAgICB9CiAgICAgIGlmICghZWxzLmVkaXRvci5jaGlsZHJlbi5sZW5ndGgpIHs",
"KICAgICAgICBlbHMuZWRpdG9yLmFwcGVuZENoaWxkKGJsb2NrRWwoZm10LmJsb2NrKCdwJykpKTsKICAgICAgICBwbGFjZUNhcmV0KGVscy5lZGl0b3IuZmlyc3RDaGlsZCwgMCk7CiAgICAgICAgbW92ZWQgPSBmYWxzZTsKICAgICAgfQogICAgICBpZiAobW92ZWQgJiYga2VlcCAmJiBrZWVwWzBdLmlzQ29ubmVjdGVkICYmIGtlZXBbMl0uaXNDb25uZWN0ZWQpIHsKICAgICAgICB0cnkgewogICAgICAgICAgY29uc3QgYmFjayA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgICBiYWNrLnNldFN0YXJ0KGtlZXBbMF0sIGtlZXBbMV0pOwogICAgICAgICAgYmFjay5zZXRFbmQoa2VlcFsyXSwga2VlcFszXSk7CiAgICAgICAgICBzZWxlY3QoYmFjayk7CiAgICAgICAgfSBjYXRjaCB7IC8qIHBvc2l0aW9ucyBubyBsb25nZXIgdmFsaWQgKi8gfQogICAgICB9CiAgICAgIGZpeExldmVscygpOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIGZ1bmN0aW9uIHVwZGF0ZUVtcHR5KCkgewogICAgICBjb25zdCBraWRzID0gZWxzLmVkaXRvci5jaGlsZHJlbjsKICAgICAgY29uc3QgZW1wdHkgPSBraWRzLmxlbmd0aCA8PSAxICYmICgha2lkc1swXSB8fCAoa2lkc1swXS5kYXRhc2V0LnR5cGUgPT09ICdwJyAmJiAha2lkc1swXS50ZXh0Q29udGVudCkpOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQuZW1wdHkgPSBlbXB0eSA_ICcxJyA6ICcwJzsKICAgIH0KCiAgICBmdW5jdGlvbiBjaGFuZ2VkKCkgewogICA",
"gICBwYXN0ZVVuZG8gPSBbXTsKICAgICAgdGlkeSgpOwogICAgICBvbkNoYW5nZSgpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIOKUgOKUgCBDb21tYW5kcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlvbiBpbmxpbmUoY21kKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgcmVzdG9yZSgpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZChjbWQpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIEFwcGxpZXMgYSBibG9jayB0eXBlIHRvIGV2ZXJ5IGJsb2NrIHRoZSBzZWxlY3Rpb24gdG91Y2hlcyAtIG9yLCBpZgogICAgLy8gdGhleSBhbGwgaGF2ZSBpdCBhbHJlYWR5LCB0dXJucyB0aGVtIGJhY2sgaW50byBwYXJhZ3JhcGhzLgogICAgZnVuY3Rpb24gYmxvY2tUeXBlKHR5cGUsIHsgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIHJlc3RvcmUoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCBibG9ja3MgPSByYW5nZUJsb2NrcyhyKTsKICAgICAgY29",
"uc3Qgb2ZmID0gYmxvY2tzLmV2ZXJ5KGIgPT4gYi5kYXRhc2V0LnR5cGUgPT09IHR5cGUpICYmIHR5cGUgIT09ICdwJzsKICAgICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICAgIGNvbnN0IHdhcyA9IGIuZGF0YXNldC50eXBlOwogICAgICAgIGNvbnN0IGxldmVsID0gZm10LkxJU1RTLmhhcyh3YXMpID8gTnVtYmVyKGIuZGF0YXNldC5sZXZlbCkgfHwgMCA6IDA7CiAgICAgICAgc2V0QmxvY2soYiwgb2ZmID8gJ3AnIDogdHlwZSwgbGV2ZWwsIHR5cGUgPT09ICdjaGVjaycgJiYgd2FzID09PSAnY2hlY2snID8gYi5kYXRhc2V0LmNoZWNrZWQgPT09ICcxJyA6IGNoZWNrZWQpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBpbmRlbnQoZGVsdGEpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyKSByZXR1cm4gZmFsc2U7CiAgICAgIGNvbnN0IGJsb2NrcyA9IHJhbmdlQmxvY2tzKHIpLmZpbHRlcihiID0-IGZtdC5MSVNUUy5oYXMoYi5kYXRhc2V0LnR5cGUpKTsKICAgICAgaWYgKCFibG9ja3MubGVuZ3RoKSByZXR1cm4gZmFsc2U7CiAgICAgIGZvciAoY29uc3QgYiBvZiBibG9ja3MpIGIuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhNYXRoLm1heCgwLCBNYXRoLm1pbihmbXQuTUFYX0xFVkVMLCAoTnVtYmVyKGIuZGF0YXNldC5sZXZlbCkgfHwgMCkgKyBkZWx0YSkpKTsKICAgICAgY2hhbmd",
"lZCgpOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0KCiAgICBmdW5jdGlvbiB0b2dnbGVDaGVjayhibGspIHsKICAgICAgaWYgKCFlZGl0YWJsZSB8fCAhYmxrIHx8IGJsay5kYXRhc2V0LnR5cGUgIT09ICdjaGVjaycpIHJldHVybjsKICAgICAgYmxrLmRhdGFzZXQuY2hlY2tlZCA9IGJsay5kYXRhc2V0LmNoZWNrZWQgPT09ICcxJyA_ICcwJyA6ICcxJzsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNsZWFyRm9ybWF0dGluZygpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuOwogICAgICByZXN0b3JlKCk7CiAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdyZW1vdmVGb3JtYXQnKTsKICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ3VubGluaycpOwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKHIpIGZvciAoY29uc3QgYiBvZiByYW5nZUJsb2NrcyhyKSkgc2V0QmxvY2soYiwgJ3AnKTsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGFuY2hvckF0KHIpIHsKICAgICAgbGV0IG4gPSByICYmIHIuc3RhcnRDb250YWluZXI7CiAgICAgIHdoaWxlIChuICYmIG4gIT09IGVscy5lZGl0b3IpIHsKICAgICAgICBpZiAobi5ub2RlVHlwZSA9PT0gMSAmJiBuLnRhZ05hbWUgPT09ICdBJykgcmV0dXJuIG47CiAgICAgICAgbiA9IG4ucGFyZW50Tm9kZTsKICAgICAgfQogICAgICByZXR1cm4gbnVsbDsKICAgIH0KCiAgICAvLyDilIDilIAgTGlua3Mg4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogICAgZnVuY3Rpb24gb3BlbkxpbmsoKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgY29uc3QgciA9IHJhbmdlKCkgfHwgc2F2ZWQ7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBzYXZlZCA9IHIuY2xvbmVSYW5nZSgpOwogICAgICBjb25zdCBhID0gYW5jaG9yQXQocik7CiAgICAgIGVscy5saW5rSW5wdXQudmFsdWUgPSBhID8gYS5nZXRBdHRyaWJ1dGUoJ2hyZWYnKSA6ICcnOwogICAgICBlbHMubGlua0Vycm9yLnRleHRDb250ZW50ID0gJyc7CiAgICAgIGVscy5saW5rUmVtb3ZlLmhpZGRlbiA9ICFhOwogICAgICBlbHMubGlua2Jhci5oaWRkZW4gPSBmYWxzZTsKICAgICAgZWxzLmxpbmtJbnB1dC5mb2N1cygpOwogICAgICBlbHMubGlua0lucHV0LnNlbGVjdCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNsb3NlTGluayh7IHJlZm9jdXMgPSB0cnVlIH0gPSB7fSkgewogICAgICBpZiAoZWxzLmxpbmtiYXIuaGlkZGVuKSByZXR1cm47CiAgICAgIGVscy5saW5rYmFyLmhpZGRlbiA9IHRydWU7CiAgICAgIGlmIChyZWZvY3VzKSByZXN0b3JlKCk7CiAgICB9CgogICAgZnVuY3Rpb24gYXB",
"wbHlMaW5rKCkgewogICAgICBjb25zdCBocmVmID0gZm10LnNhZmVIcmVmKGVscy5saW5rSW5wdXQudmFsdWUpOwogICAgICBpZiAoIWhyZWYpIHsKICAgICAgICBlbHMubGlua0Vycm9yLnRleHRDb250ZW50ID0gJ1RoYXQgaXMgbm90IGEgd2ViIG9yIGVtYWlsIGFkZHJlc3MuJzsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY2xvc2VMaW5rKCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgY29uc3QgYSA9IGFuY2hvckF0KHIpOwogICAgICBpZiAoci5jb2xsYXBzZWQgJiYgYSkgewogICAgICAgIGEuc2V0QXR0cmlidXRlKCdocmVmJywgaHJlZik7CiAgICAgICAgYS50aXRsZSA9IGhyZWY7CiAgICAgIH0gZWxzZSBpZiAoci5jb2xsYXBzZWQpIHsKICAgICAgICAvLyBOb3RoaW5nIHNlbGVjdGVkOiB0aGUgYWRkcmVzcyBpdHNlbGYgYmVjb21lcyB0aGUgbGluayB0ZXh0LgogICAgICAgIGNvbnN0IHRleHQgPSBocmVmLnJlcGxhY2UoL15tYWlsdG86LywgJycpOwogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIHRleHQpOwogICAgICAgIGNvbnN0IGFmdGVyID0gcmFuZ2UoKTsKICAgICAgICBpZiAoYWZ0ZXIpIHsKICAgICAgICAgIGNvbnN0IHNlbCA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgICBzZWwuc2V0U3RhcnQoYWZ0ZXIuc3RhcnRDb250YWluZXIsIE1hdGgubWF4KDAsIGFmdGVyLnN0YXJ0T2Z",
"mc2V0IC0gdGV4dC5sZW5ndGgpKTsKICAgICAgICAgIHNlbC5zZXRFbmQoYWZ0ZXIuc3RhcnRDb250YWluZXIsIGFmdGVyLnN0YXJ0T2Zmc2V0KTsKICAgICAgICAgIHNlbGVjdChzZWwpOwogICAgICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2NyZWF0ZUxpbmsnLCBmYWxzZSwgaHJlZik7CiAgICAgICAgICBjb25zdCBlbmQgPSByYW5nZSgpOwogICAgICAgICAgaWYgKGVuZCkgeyBlbmQuY29sbGFwc2UoZmFsc2UpOyBzZWxlY3QoZW5kKTsgfQogICAgICAgIH0KICAgICAgfSBlbHNlIHsKICAgICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnY3JlYXRlTGluaycsIGZhbHNlLCBocmVmKTsKICAgICAgfQogICAgICBjaGFuZ2VkKCk7CiAgICB9CgogICAgZnVuY3Rpb24gcmVtb3ZlTGluaygpIHsKICAgICAgY2xvc2VMaW5rKCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBjb25zdCBhID0gYW5jaG9yQXQocik7CiAgICAgIGlmIChhKSB7CiAgICAgICAgY29uc3Qgc2VsID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICBzZWwuc2VsZWN0Tm9kZUNvbnRlbnRzKGEpOwogICAgICAgIHNlbGVjdChzZWwpOwogICAgICB9CiAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCd1bmxpbmsnKTsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIC8vIOKUgOKUgCBUb29sYmFyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGNvbnN0IGJ1dHRvbnMgPSB7fTsKICAgIGNvbnN0IHRiQnV0dG9uID0gKGtleSwgbGFiZWwsIGljb25OYW1lLCBvbkNsaWNrLCB0b2dnbGUgPSB0cnVlKSA9PiB7CiAgICAgIGNvbnN0IGIgPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICd0Yi1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGl0bGU6IGxhYmVsLCAnYXJpYS1sYWJlbCc6IGxhYmVsLAogICAgICAgICdhcmlhLXByZXNzZWQnOiB0b2dnbGUgPyAnZmFsc2UnIDogbnVsbCwgZGF0YXNldDogeyBrZXk6IGBmbXQtJHtrZXl9YCB9LAogICAgICAgIC8vIEtlZXBzIHRoZSBmb2N1cyAtIGFuZCBzbyB0aGUgc2VsZWN0aW9uIC0gaW4gdGhlIHRleHQuCiAgICAgICAgb25tb3VzZWRvd246IGUgPT4gZS5wcmV2ZW50RGVmYXVsdCgpLAogICAgICAgIG9uY2xpY2s6ICgpID0-IG9uQ2xpY2soKSwKICAgICAgfSwgaWNvbihpY29uTmFtZSwgMjApKTsKICAgICAgYnV0dG9uc1trZXldID0gYjsKICAgICAgcmV0dXJuIGI7CiAgICB9OwogICAgY29uc3Qgc2VwID0gKCkgPT4gaCgnc3BhbicsIHsgY2xhc3M6ICd0Yi1zZXAnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSk7CgogICAgZWxzLnN0eWxlTGFiZWwgPSBoKCdzcGFuJywgeyBjbGFzczogJ3RiLXN0eWxlLWxhYmVsJywgdGV4dDo",
"gJ05vcm1hbCB0ZXh0JyB9KTsKICAgIGVscy5zdHlsZSA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICd0Yi1zdHlsZScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1oYXNwb3B1cCc6ICdtZW51JywgJ2FyaWEtZXhwYW5kZWQnOiAnZmFsc2UnLAogICAgICAnYXJpYS1sYWJlbCc6ICdUZXh0IHN0eWxlJywgdGl0bGU6ICdUZXh0IHN0eWxlJywgZGF0YXNldDogeyBrZXk6ICdmbXQtc3R5bGUnIH0sCiAgICAgIG9ubW91c2Vkb3duOiBlID0-IGUucHJldmVudERlZmF1bHQoKSwKICAgICAgb25jbGljazogKCkgPT4gewogICAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgICBpZiAocikgc2F2ZWQgPSByLmNsb25lUmFuZ2UoKTsKICAgICAgICBjb25zdCBjdXIgPSBjdXJyZW50VHlwZSgpOwogICAgICAgIG9wZW5NZW51KHJvb3QsIGVscy5zdHlsZSwgU1RZTEVTLm1hcCgoW3R5cGUsIGxhYmVsXSkgPT4gKHsKICAgICAgICAgIGxhYmVsLCBrZXk6IGBzdHlsZToke3R5cGV9YCwgY2hlY2tlZDogY3VyID09PSB0eXBlLAogICAgICAgICAgb25TZWxlY3Q6ICgpID0-IGJsb2NrVHlwZSh0eXBlKSwKICAgICAgICB9KSksIHsgbGFiZWw6ICdUZXh0IHN0eWxlJyB9KTsKICAgICAgfSwKICAgIH0sIGVscy5zdHlsZUxhYmVsLCBpY29uKCdjYXJldCcsIDE4KSk7CgogICAgZWxzLnRvb2xiYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtdG9vbGJhcicsIHJvbGU6ICd0b29",
"sYmFyJywgJ2FyaWEtbGFiZWwnOiAnRm9ybWF0dGluZycgfSwKICAgICAgZWxzLnN0eWxlLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ2JvbGQnLCAnQm9sZCAoQ3RybCtCKScsICdib2xkJywgKCkgPT4gaW5saW5lKCdib2xkJykpLAogICAgICB0YkJ1dHRvbignaXRhbGljJywgJ0l0YWxpYyAoQ3RybCtJKScsICdpdGFsaWMnLCAoKSA9PiBpbmxpbmUoJ2l0YWxpYycpKSwKICAgICAgdGJCdXR0b24oJ3N0cmlrZScsICdTdHJpa2UtdGhyb3VnaCcsICdzdHJpa2UnLCAoKSA9PiBpbmxpbmUoJ3N0cmlrZVRocm91Z2gnKSksCiAgICAgIHNlcCgpLAogICAgICB0YkJ1dHRvbigndWwnLCAnQnVsbGV0ZWQgbGlzdCAoQ3RybCtTaGlmdCs4KScsICdidWxsZXRzJywgKCkgPT4gYmxvY2tUeXBlKCd1bCcpKSwKICAgICAgdGJCdXR0b24oJ29sJywgJ051bWJlcmVkIGxpc3QgKEN0cmwrU2hpZnQrNyknLCAnbnVtYmVycycsICgpID0-IGJsb2NrVHlwZSgnb2wnKSksCiAgICAgIHRiQnV0dG9uKCdjaGVjaycsICdDaGVja2xpc3QgKEN0cmwrU2hpZnQrOSknLCAnY2hlY2tsaXN0JywgKCkgPT4gYmxvY2tUeXBlKCdjaGVjaycpKSwKICAgICAgdGJCdXR0b24oJ291dGRlbnQnLCAnTGVzcyBpbmRlbnQgKFNoaWZ0K1RhYiknLCAnb3V0ZGVudCcsICgpID0-IHsgcmVzdG9yZSgpOyBpbmRlbnQoLTEpOyB9LCBmYWxzZSksCiAgICAgIHRiQnV0dG9uKCdpbmRlbnQnLCAnTW9yZSBpbmRlbnQgKFRhYiknLCAnaW5kZW50JywgKCkgPT4",
"geyByZXN0b3JlKCk7IGluZGVudCgxKTsgfSwgZmFsc2UpLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ2xpbmsnLCAnTGluayAoQ3RybCtLKScsICdsaW5rJywgKCkgPT4gb3BlbkxpbmsoKSksCiAgICAgIHRiQnV0dG9uKCdjbGVhcicsICdDbGVhciBmb3JtYXR0aW5nJywgJ2NsZWFyJywgKCkgPT4gY2xlYXJGb3JtYXR0aW5nKCksIGZhbHNlKSk7CgogICAgZWxzLmxpbmtJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHBsYWNlaG9sZGVyOiAnV2ViIGFkZHJlc3Mgb3IgZW1haWwnLCAnYXJpYS1sYWJlbCc6ICdMaW5rIGFkZHJlc3MnLAogICAgICBzcGVsbGNoZWNrOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWlucHV0JyB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGFwcGx5TGluaygpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNsb3NlTGluaygpOyB9CiAgICAgIH0sCiAgICB9KTsKICAgIGVscy5saW5rRXJyb3IgPSBoKCdzcGFuJywgeyBjbGFzczogJ2xpbmstZXJyb3InLCByb2xlOiAnYWxlcnQnIH0pOwogICAgZWxzLmxpbmtSZW1vdmUgPSBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbic",
"sIHRleHQ6ICdSZW1vdmUgbGluaycsIGRhdGFzZXQ6IHsga2V5OiAnZm10LWxpbmstcmVtb3ZlJyB9LCBvbmNsaWNrOiByZW1vdmVMaW5rIH0pOwogICAgZWxzLmxpbmtiYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtbGlua2JhcicsIGhpZGRlbjogdHJ1ZSB9LAogICAgICBpY29uKCdsaW5rJywgMTgpLCBlbHMubGlua0lucHV0LAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10b25hbCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQXBwbHknLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWFwcGx5JyB9LCBvbmNsaWNrOiBhcHBseUxpbmsgfSksCiAgICAgIGVscy5saW5rUmVtb3ZlLAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiAoKSA9PiBjbG9zZUxpbmsoKSB9KSwKICAgICAgZWxzLmxpbmtFcnJvcik7CgogICAgZnVuY3Rpb24gY3VycmVudFR5cGUoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpIHx8IHNhdmVkOwogICAgICBjb25zdCBibGsgPSByICYmIGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIHJldHVybiBibGsgPyBibGsuZGF0YXNldC50eXBlIHx8ICdwJyA6ICdwJzsKICAgIH0KCiAgICBmdW5jdGlvbiByZWZyZXNoVG9vbGJhcigpIHsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gY3VycmVudFR",
"5cGUoKTsKICAgICAgZWxzLnN0eWxlTGFiZWwudGV4dENvbnRlbnQgPSBTVFlMRV9MQUJFTFt0eXBlXSB8fCAnTm9ybWFsIHRleHQnOwogICAgICBmb3IgKGNvbnN0IFtrZXksIGNtZF0gb2YgW1snYm9sZCcsICdib2xkJ10sIFsnaXRhbGljJywgJ2l0YWxpYyddLCBbJ3N0cmlrZScsICdzdHJpa2VUaHJvdWdoJ11dKSB7CiAgICAgICAgbGV0IG9uID0gZmFsc2U7CiAgICAgICAgdHJ5IHsgb24gPSBkb2N1bWVudC5xdWVyeUNvbW1hbmRTdGF0ZShjbWQpOyB9IGNhdGNoIHsgLyogbm90IHN1cHBvcnRlZCAqLyB9CiAgICAgICAgYnV0dG9uc1trZXldLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKG9uKSk7CiAgICAgIH0KICAgICAgZm9yIChjb25zdCB0IG9mIFsndWwnLCAnb2wnLCAnY2hlY2snXSkgYnV0dG9uc1t0XS5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyh0eXBlID09PSB0KSk7CiAgICAgIGJ1dHRvbnMubGluay5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyghIWFuY2hvckF0KHIpKSk7CiAgICB9CgogICAgLy8g4pSA4pSAIFRoZSBlZGl0YWJsZSBhcmVhIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGVscy5lZGl0b3IgPSBoKCdkaXYnLCB",
"7CiAgICAgIGNsYXNzOiAnbmUtYm9keScsIHJvbGU6ICd0ZXh0Ym94JywgJ2FyaWEtbXVsdGlsaW5lJzogJ3RydWUnLCAnYXJpYS1sYWJlbCc6ICdOb3RlJywKICAgICAgc3BlbGxjaGVjazogJ3RydWUnLCBkYXRhc2V0OiB7IGtleTogJ25vdGUtYm9keScsIGVtcHR5OiAnMScgfSwKICAgIH0pOwoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIGUgPT4gewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIGNvbnN0IG1vZCA9IGUuY3RybEtleSB8fCBlLm1ldGFLZXk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBjb25zdCBibGsgPSByICYmIGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CgogICAgICBpZiAobW9kICYmICFlLmFsdEtleSAmJiAhZS5zaGlmdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAneicgJiYgcGFzdGVVbmRvLmxlbmd0aCkgewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICB1bmRvUGFzdGUoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKG1vZCAmJiAhZS5hbHRLZXkgJiYgZS5zaGlmdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAndicpIHsKICAgICAgICAvLyBUaGUgcGFzdGUgZXZlbnQgZm9sbG93cyBzdHJhaWdodCBhd2F5LCBpbiB0aGlzIHNhbWUgdGFzay4KICAgICAgICBwbGFpbk5leHQgPSB0cnVlOwogICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBwbGFpbk5leHQgPSBmYWxzZTs",
"gfSwgMCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChtb2QgJiYgIWUuYWx0S2V5ICYmIGUuc2hpZnRLZXkgJiYgL15EaWdpdFs3ODldJC8udGVzdChlLmNvZGUpKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGJsb2NrVHlwZSh7IERpZ2l0NzogJ29sJywgRGlnaXQ4OiAndWwnLCBEaWdpdDk6ICdjaGVjaycgfVtlLmNvZGVdKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKG1vZCAmJiAhZS5zaGlmdEtleSAmJiAhZS5hbHRLZXkpIHsKICAgICAgICBjb25zdCBrID0gZS5rZXkudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAoayA9PT0gJ2snKSB7IGUucHJldmVudERlZmF1bHQoKTsgb3BlbkxpbmsoKTsgcmV0dXJuOyB9CiAgICAgICAgaWYgKGsgPT09ICd1JykgeyBlLnByZXZlbnREZWZhdWx0KCk7IHJldHVybjsgfSAvLyBubyB1bmRlcmxpbmUgaW4gdGhlIG1vZGVsCiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmIGJsayAmJiBibGsuZGF0YXNldC50eXBlID09PSAnY2hlY2snKSB7IGUucHJldmVudERlZmF1bHQoKTsgdG9nZ2xlQ2hlY2soYmxrKTsgcmV0dXJuOyB9CiAgICAgIH0KICAgICAgaWYgKGUua2V5ID09PSAnVGFiJyAmJiAhbW9kICYmICFlLmFsdEtleSAmJiBibGsgJiYgZm10LkxJU1RTLmhhcyhibGsuZGF0YXNldC50eXBlKSkgewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBpbmRlbnQoZS5zaGlmdEtleSA_IC0xIDo",
"gMSk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJyAmJiAhbW9kICYmICFlLmFsdEtleSAmJiAhZS5pc0NvbXBvc2luZykgewogICAgICAgIC8vIEFuIGVtcHR5IGxpc3QgaXRlbSBlbmRzIHRoZSBsaXN0OyBTaGlmdCtFbnRlciBpcyBhIG5ldyBsaW5lIGxpa2UKICAgICAgICAvLyBhbnkgb3RoZXIsIHNpbmNlIHRoZSBtb2RlbCBoYXMgbm8gbGluZSBicmVha3MgaW5zaWRlIGEgYmxvY2suCiAgICAgICAgaWYgKGJsayAmJiBmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V0LnR5cGUpICYmICFibGsudGV4dENvbnRlbnQpIHsKICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICAgIGNvbnN0IGx2bCA9IE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMDsKICAgICAgICAgIGlmIChsdmwgPiAwKSBibGsuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsdmwgLSAxKTsKICAgICAgICAgIGVsc2Ugc2V0QmxvY2soYmxrLCAncCcpOwogICAgICAgICAgY2hhbmdlZCgpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBpZiAoZS5zaGlmdEtleSkgewogICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2luc2VydFBhcmFncmFwaCcpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoZS5rZXkgPT09ICdCYWNrc3BhY2UnICYmICFtb2QgJiYgYmxrICYmIGJsay5kYXR",
"hc2V0LnR5cGUgIT09ICdwJyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCBibGspKSB7CiAgICAgICAgLy8gQXQgdGhlIHN0YXJ0IG9mIGEgbGlzdCBpdGVtIG9yIGhlYWRpbmcsIEJhY2tzcGFjZSB1bmRvZXMgdGhlCiAgICAgICAgLy8gZm9ybWF0dGluZyBiZWZvcmUgaXQgc3RhcnRzIGpvaW5pbmcgbGluZXMuCiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGx2bCA9IE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMDsKICAgICAgICBpZiAoZm10LkxJU1RTLmhhcyhibGsuZGF0YXNldC50eXBlKSAmJiBsdmwgPiAwKSBibGsuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsdmwgLSAxKTsKICAgICAgICBlbHNlIHNldEJsb2NrKGJsaywgJ3AnKTsKICAgICAgICBjaGFuZ2VkKCk7CiAgICAgIH0KICAgIH0pOwoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBlID0-IHsKICAgICAgaWYgKGUuaW5wdXRUeXBlID09PSAnaW5zZXJ0VGV4dCcgJiYgKGUuZGF0YSA9PT0gJyAnIHx8IGUuZGF0YSA9PT0gJ8KgJykpIGF1dG9mb3JtYXQoKTsKICAgICAgaWYgKGUuaW5wdXRUeXBlID09PSAnaW5zZXJ0UGFyYWdyYXBoJykgewogICAgICAgIC8vIFRoZSBuZXcgYmxvY2sgaXMgYSBjb3B5IG9mIHRoZSBvbmUgaXQgd2FzIHNwbGl0IGZyb206IGEgdGlja2VkCiAgICAgICAgLy8gYm94IGFuZCBhIGhlYWRpbmcgc2hvdWxkIG5vdCBjYXJyeSBvbiBpbnRvIGFuIGVtcHR5IG5ldyBsaW5",
"lLgogICAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICAgIGNvbnN0IGJsayA9IHIgJiYgYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKTsKICAgICAgICBpZiAoYmxrICYmICFibGsudGV4dENvbnRlbnQpIHsKICAgICAgICAgIGlmIChibGsuZGF0YXNldC50eXBlID09PSAnY2hlY2snKSBibGsuZGF0YXNldC5jaGVja2VkID0gJzAnOwogICAgICAgICAgaWYgKC9eaFsxMjNdJC8udGVzdChibGsuZGF0YXNldC50eXBlKSkgc2V0QmxvY2soYmxrLCAncCcpOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoL15kZWxldGUvLnRlc3QoZS5pbnB1dFR5cGUpICYmIGVscy5lZGl0b3IuY2hpbGRyZW4ubGVuZ3RoID09PSAxICYmICFlbHMuZWRpdG9yLnRleHRDb250ZW50KSB7CiAgICAgICAgLy8gRXZlcnl0aGluZyBkZWxldGVkOiB0aGUgbm90ZSBzdGFydHMgYWdhaW4gZnJvbSBub3JtYWwgdGV4dC4KICAgICAgICBzZXRCbG9jayhlbHMuZWRpdG9yLmZpcnN0RWxlbWVudENoaWxkLCAncCcpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0pOwoKICAgIGZ1bmN0aW9uIGF1dG9mb3JtYXQoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIgfHwgIXIuY29sbGFwc2VkKSByZXR1cm47CiAgICAgIGNvbnN0IGJsayA9IGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIGlmICghYmxrIHx8IGJsay5kYXRhc2V0LnR5cGUgIT09ICdwJykgcmV0dXJuOwogICAgICBjb25zdCBwcmUgPSBkb2N",
"1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcmUuc2VsZWN0Tm9kZUNvbnRlbnRzKGJsayk7CiAgICAgIHByZS5zZXRFbmQoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCk7CiAgICAgIGNvbnN0IG0gPSAvXihcU3sxLDN9KVsgwqBdJC8uZXhlYyhwcmUudG9TdHJpbmcoKSk7CiAgICAgIGNvbnN0IHJ1bGUgPSBtICYmIEFVVE8uZmluZCgoW3JlXSkgPT4gcmUudGVzdChtWzFdKSk7CiAgICAgIGlmICghcnVsZSkgcmV0dXJuOwogICAgICBzZWxlY3QocHJlKTsKICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2RlbGV0ZScpOwogICAgICBzZXRCbG9jayhibGssIHJ1bGVbMV0udHlwZSwgMCwgISFydWxlWzFdLmNoZWNrZWQpOwogICAgfQoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcigncGFzdGUnLCBlID0-IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIGNvbnN0IGRhdGEgPSBlLmNsaXBib2FyZERhdGE7CiAgICAgIGNvbnN0IHRleHQgPSAoZGF0YSAmJiBkYXRhLmdldERhdGEoJ3RleHQvcGxhaW4nKSkgfHwgJyc7CiAgICAgIGNvbnN0IHBsYWluID0gcGxhaW5OZXh0OwogICAgICBwbGFpbk5leHQgPSBmYWxzZTsKICAgICAgY29uc3QgZG9jID0gcGxhaW4gPyBudWxsIDogZm10LnBhc3RlRG9jKHsgaHRtbDogZGF0YSAmJiBkYXRhLmdldERhdGEoJ3RleHQvaHRtbCcpLCB0ZXh0IH0pOwogICAgICAvLyBUZXh0IHdpdGggbm90aGl",
"uZyB0byBmb3JtYXQgZ29lcyBpbiB0aGUgd2F5IHR5cGluZyBkb2VzLCBzbyB0aGUKICAgICAgLy8gYnJvd3NlcidzIG93biB1bmRvIHRha2VzIGl0IGJhY2s6IGEgc2luZ2xlIGxpbmUgYXMgY29waWVkLCBzcGFjZXMKICAgICAgLy8gYW5kIGFsbDsgbW9yZSB0aGFuIHRoYXQgYXMgdGhlIEhUTUwgcmVhZHMgKGEgdGFibGUncyAiIHwgIiwgbm90CiAgICAgIC8vIGl0cyB0YWJzKS4KICAgICAgY29uc3QgbGluZSA9IHRleHQucmVwbGFjZSgvW1xyXG5dKyQvLCAnJyk7CiAgICAgIGlmIChkb2MgJiYgZm10Lmhhc0Zvcm1hdHRpbmcoZG9jKSkgaW5zZXJ0RG9jKGRvYyk7CiAgICAgIGVsc2UgaWYgKGRvYyAmJiAhKGRvYy5sZW5ndGggPT09IDEgJiYgbGluZSAmJiAhL1tcclxuXHRdLy50ZXN0KGxpbmUpKSkgaW5zZXJ0UGxhaW4oZm10LmRvY1RleHQoZG9jKSk7CiAgICAgIGVsc2UgaW5zZXJ0UGxhaW4oZG9jID8gbGluZSA6IHRleHQpOwogICAgICByZXZlYWxDYXJldCgpOwogICAgfSk7CiAgICBlbHMuZWRpdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCBlID0-IHsKICAgICAgLy8gRHJvcHBlZCBIVE1MIHdvdWxkIGJyaW5nIGl0cyBvd24gbWFya3VwOyBkcm9wcGVkIGZpbGVzIGhhdmUgbm93aGVyZSB0byBnby4KICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgfSk7CgogICAgZnVuY3Rpb24gaW5zZXJ0UGxhaW4odGV4dCkgewogICAgICBjb25zdCBsaW5lcyA9IFN0cmluZyh0ZXh0KS5yZXBsYWNlKC9cclxuPy9",
"nLCAnXG4nKS5zcGxpdCgnXG4nKTsKICAgICAgbGluZXMuZm9yRWFjaCgobGluZSwgaSkgPT4gewogICAgICAgIGlmIChpKSBkb2N1bWVudC5leGVjQ29tbWFuZCgnaW5zZXJ0UGFyYWdyYXBoJyk7CiAgICAgICAgaWYgKGxpbmUpIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIGxpbmUpOwogICAgICB9KTsKICAgIH0KCiAgICAvLyDilIDilIAgRm9ybWF0dGVkIHBhc3RlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgLy8KICAgIC8vIFRoZSBibG9ja3MgZ28gaW4gZGlyZWN0bHkgLSB0aGUgYnJvd3NlcidzIGVkaXRpbmcgY29tbWFuZHMgd291bGQKICAgIC8vIG5lc3QgYW5kIHJlc3R5bGUgdGhlbSAtIHdpdGggdGhlIHRleHQgYWZ0ZXIgdGhlIGNhcmV0IGNhcnJpZWQgdG8KICAgIC8vIHRoZSBlbmQgb2Ygd2hhdCB3YXMgcGFzdGVkLiBUaGUgYnJvd3NlcidzIHVuZG8gZG9lcyBub3Qga25vdyBhYm91dAogICAgLy8gdGhhdCwgc28gQ3RybCtaIHN0cmFpZ2h0IGFmdGVyd2FyZHMgcHV0cyBiYWNrIGEgY29weSB0YWtlbiBmaXJzdCAtCiAgICAvLyBvbmUgcGFzdGUgYXQgYSB0aW1lLCB1bnRpbCBhbnl0aGluZyBlbHNlIGNoYW5nZXMgdGhlIHRleHQuCgogICAgLy8",
"gRW1wdHkgdGV4dCBhbmQgZW1wdHkgbWFya3MgbGVmdCBiZWhpbmQgYnkgY3V0dGluZyBhIGJsb2NrIGluIHR3bzsKICAgIC8vIGFsc28gdGhlIDxicj4gdGhhdCBob2xkcyBhbiBlbXB0eSBibG9jayBvcGVuLCBwdXQgYmFjayBsYXRlciBpZgogICAgLy8gdGhlIGJsb2NrIGlzIHN0aWxsIGVtcHR5LgogICAgZnVuY3Rpb24gcHJ1bmUoZWwpIHsKICAgICAgZm9yIChjb25zdCBuIG9mIFsuLi5lbC5jaGlsZE5vZGVzXSkgewogICAgICAgIGlmIChuLm5vZGVUeXBlID09PSAzKSB7IGlmICghbi5kYXRhKSBuLnJlbW92ZSgpOyBjb250aW51ZTsgfQogICAgICAgIGlmIChuLm5vZGVUeXBlICE9PSAxIHx8IG4udGFnTmFtZSA9PT0gJ0JSJykgeyBuLnJlbW92ZSgpOyBjb250aW51ZTsgfQogICAgICAgIHBydW5lKG4pOwogICAgICAgIGlmICghbi5maXJzdENoaWxkKSBuLnJlbW92ZSgpOwogICAgICB9CiAgICB9CiAgICBjb25zdCBob2xkT3BlbiA9IGVsID0-IHsgaWYgKCFlbC5maXJzdENoaWxkKSBlbC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdicicpKTsgfTsKCiAgICBmdW5jdGlvbiBpbnNlcnREb2MoZG9jKSB7CiAgICAgIGlmICghcmFuZ2UoKSkgcmVzdG9yZSgpOwogICAgICBpZiAoIXJhbmdlKCkpIHJldHVybjsKICAgICAgY29uc3QgdW5kbyA9IHBhc3RlVW5kbzsKICAgICAgY29uc3QgYmVmb3JlID0gc25hcHNob3QoKTsKICAgICAgaWYgKCFyYW5nZSgpLmNvbGxhcHNlZCkgZG9jdW1lbnQuZXh",
"lY0NvbW1hbmQoJ2RlbGV0ZScpOwogICAgICB0aWR5KCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKCiAgICAgIGxldCBub2RlID0gci5zdGFydENvbnRhaW5lcjsKICAgICAgbGV0IG9mZnNldCA9IHIuc3RhcnRPZmZzZXQ7CiAgICAgIGlmIChub2RlID09PSBlbHMuZWRpdG9yKSB7CiAgICAgICAgY29uc3Qga2lkcyA9IGVscy5lZGl0b3IuY2hpbGRyZW47CiAgICAgICAgY29uc3QgayA9IE1hdGgubWluKG9mZnNldCwga2lkcy5sZW5ndGggLSAxKTsKICAgICAgICBub2RlID0ga2lkc1trXTsKICAgICAgICBvZmZzZXQgPSBrIDwgb2Zmc2V0ID8gbm9kZS5jaGlsZE5vZGVzLmxlbmd0aCA6IDA7CiAgICAgIH0KICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihub2RlKTsKICAgICAgaWYgKCFibGspIHJldHVybjsKCiAgICAgIC8vIEN1dCB0aGUgYmxvY2sgYXQgdGhlIGNhcmV0LgogICAgICBjb25zdCBjdXQgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBjdXQuc2V0U3RhcnQobm9kZSwgb2Zmc2V0KTsKICAgICAgY3V0LnNldEVuZChibGssIGJsay5jaGlsZE5vZGVzLmxlbmd0aCk7CiAgICAgIGNvbnN0IGFmdGVyID0gY3V0LmV4dHJhY3RDb250ZW50cygpOwogICAgICBwcnVuZShhZnRlcik7CiAgICAgIHBydW5lKGJsayk7CgogICAgICBjb25zdCBvcmlnID0geyB0eXBlOiBibGsuZGF0YXNldC50eXBlIHx8ICdwJywgbGV2ZWw6IE51bWJlcihibGsuZGF0YXNldC5sZXZ",
"lbCkgfHwgMCwgY2hlY2tlZDogYmxrLmRhdGFzZXQuY2hlY2tlZCA9PT0gJzEnIH07CiAgICAgIC8vIExpc3RzIHBhc3RlZCBpbnRvIGEgbGlzdCBnbyBpbiBhdCBpdHMgbGV2ZWwuCiAgICAgIGNvbnN0IGJhc2UgPSBmbXQuTElTVFMuaGFzKG9yaWcudHlwZSkgPyBvcmlnLmxldmVsIDogMDsKICAgICAgY29uc3QgbGV2ZWxPZiA9IGIgPT4gKGZtdC5MSVNUUy5oYXMoYi50eXBlKSA_IE1hdGgubWluKGZtdC5NQVhfTEVWRUwsIGIubGV2ZWwgKyBiYXNlKSA6IDApOwoKICAgICAgbGV0IGxhc3QgPSBibGs7CiAgICAgIGxldCBpID0gMDsKICAgICAgLy8gVGhlIGZpcnN0IGxpbmUgam9pbnMgdGhlIHRleHQgYmVmb3JlIHRoZSBjYXJldDsgb24gYW4gZW1wdHkgbGluZQogICAgICAvLyBpdCBhbHNvIGJyaW5ncyBpdHMga2luZCAoYSBoZWFkaW5nLCBhIGxpc3QgaXRlbSkgd2l0aCBpdC4KICAgICAgaWYgKGRvY1swXS50eXBlID09PSAncCcgfHwgIWJsay50ZXh0Q29udGVudCkgewogICAgICAgIGlmICghYmxrLnRleHRDb250ZW50ICYmIGRvY1swXS50eXBlICE9PSAncCcpIHNldEJsb2NrKGJsaywgZG9jWzBdLnR5cGUsIGxldmVsT2YoZG9jWzBdKSwgZG9jWzBdLmNoZWNrZWQpOwogICAgICAgIGJsay5hcHBlbmQoLi4uaW5saW5lTm9kZXMoZG9jWzBdLnJ1bnMpKTsKICAgICAgICBpID0gMTsKICAgICAgfQogICAgICBmb3IgKDsgaSA8IGRvYy5sZW5ndGg7IGkrKykgewogICAgICAgIGNvbnN0IGVsID0gYmxvY2tFbCh7IC4",
"uLmRvY1tpXSwgbGV2ZWw6IGxldmVsT2YoZG9jW2ldKSB9KTsKICAgICAgICBsYXN0LmFmdGVyKGVsKTsKICAgICAgICBsYXN0ID0gZWw7CiAgICAgIH0KCiAgICAgIC8vIFRoZSB0ZXh0IGFmdGVyIHRoZSBjYXJldCBmb2xsb3dzIHRoZSBwYXN0ZWQgdGV4dCAtIG9uIGEgbGluZSBvZgogICAgICAvLyBpdHMgb3duIGtpbmQgaWYgdGhlIHBhc3RlIGVuZGVkIG9uIGEgZGlmZmVyZW50IGtpbmQgb2YgbGluZS4KICAgICAgY29uc3Qga2luZCA9IGVsID0-IGAke2VsLmRhdGFzZXQudHlwZX06JHtlbC5kYXRhc2V0LmxldmVsIHx8IDB9YDsKICAgICAgbGV0IHRhcmdldCA9IGxhc3Q7CiAgICAgIGlmIChhZnRlci50ZXh0Q29udGVudCAmJiBsYXN0ICE9PSBibGsgJiYga2luZChsYXN0KSAhPT0gYCR7b3JpZy50eXBlfToke2Jhc2V9YCkgewogICAgICAgIHRhcmdldCA9IGJsb2NrRWwoZm10LmJsb2NrKG9yaWcudHlwZSwgW10sIG9yaWcpKTsKICAgICAgICB0YXJnZXQucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgICAgbGFzdC5hZnRlcih0YXJnZXQpOwogICAgICB9CiAgICAgIHBydW5lKGxhc3QpOwogICAgICBjb25zdCBhdCA9IHRhcmdldCA9PT0gbGFzdCA_IGxhc3QuY2hpbGROb2Rlcy5sZW5ndGggOiAwOwogICAgICB0YXJnZXQuYXBwZW5kKGFmdGVyKTsKICAgICAgaG9sZE9wZW4oYmxrKTsKICAgICAgaG9sZE9wZW4obGFzdCk7CiAgICAgIGhvbGRPcGVuKHRhcmdldCk7CiAgICAgIGlmICh0YXJnZXQgPT09IGxhc3QpIHB",
"sYWNlQ2FyZXQobGFzdCwgYXQpOwogICAgICBlbHNlIHBsYWNlQ2FyZXQobGFzdCwgbGFzdC5maXJzdENoaWxkLm5vZGVOYW1lID09PSAnQlInID8gMCA6IGxhc3QuY2hpbGROb2Rlcy5sZW5ndGgpOwoKICAgICAgY2hhbmdlZCgpOwogICAgICBwYXN0ZVVuZG8gPSBbLi4udW5kby5zbGljZSgtMTkpLCBiZWZvcmVdOwogICAgfQoKICAgIC8vIFRoZSBlZGl0b3IncyBibG9ja3MsIGFuZCB0aGUgc2VsZWN0aW9uIGFzIHRleHQgb2Zmc2V0cyB3aXRoaW4gdGhlbS4KICAgIGZ1bmN0aW9uIHNuYXBzaG90KCkgewogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgcmV0dXJuIHsKICAgICAgICBub2RlczogWy4uLmVscy5lZGl0b3IuY2hpbGROb2Rlc10ubWFwKG4gPT4gbi5jbG9uZU5vZGUodHJ1ZSkpLAogICAgICAgIHN0YXJ0OiByICYmIHdoZXJlKHIuc3RhcnRDb250YWluZXIsIHIuc3RhcnRPZmZzZXQpLAogICAgICAgIGVuZDogciAmJiB3aGVyZShyLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXQpLAogICAgICB9OwogICAgfQoKICAgIGZ1bmN0aW9uIHdoZXJlKG5vZGUsIG9mZnNldCkgewogICAgICBjb25zdCBraWRzID0gWy4uLmVscy5lZGl0b3IuY2hpbGROb2Rlc107CiAgICAgIGlmIChub2RlID09PSBlbHMuZWRpdG9yKSB7CiAgICAgICAgY29uc3QgayA9IE1hdGgubWluKG9mZnNldCwga2lkcy5sZW5ndGggLSAxKTsKICAgICAgICByZXR1cm4gayA8IDAgPyBudWxsIDogeyBiOiBrLCBvOiBrIDwgb2Zmc2V0ID8",
"ga2lkc1trXS50ZXh0Q29udGVudC5sZW5ndGggOiAwIH07CiAgICAgIH0KICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihub2RlKTsKICAgICAgaWYgKCFibGspIHJldHVybiBudWxsOwogICAgICBjb25zdCBwcmUgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcmUuc2VsZWN0Tm9kZUNvbnRlbnRzKGJsayk7CiAgICAgIHByZS5zZXRFbmQobm9kZSwgb2Zmc2V0KTsKICAgICAgcmV0dXJuIHsgYjoga2lkcy5pbmRleE9mKGJsayksIG86IHByZS50b1N0cmluZygpLmxlbmd0aCB9OwogICAgfQoKICAgIGZ1bmN0aW9uIHBvaW50QXQocCkgewogICAgICBjb25zdCBibGsgPSBwICYmIGVscy5lZGl0b3IuY2hpbGROb2Rlc1twLmJdOwogICAgICBpZiAoIWJsaykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIoYmxrLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7CiAgICAgIGxldCBsZWZ0ID0gcC5vOwogICAgICBmb3IgKGxldCBuID0gd2Fsa2VyLm5leHROb2RlKCk7IG47IG4gPSB3YWxrZXIubmV4dE5vZGUoKSkgewogICAgICAgIGlmIChsZWZ0IDw9IG4uZGF0YS5sZW5ndGgpIHJldHVybiBbbiwgbGVmdF07CiAgICAgICAgbGVmdCAtPSBuLmRhdGEubGVuZ3RoOwogICAgICB9CiAgICAgIHJldHVybiBbYmxrLCAwXTsKICAgIH0KCiAgICBmdW5jdGlvbiB1bmRvUGFzdGUoKSB7CiAgICAgIGNvbnN0IHJlc3QgPSBwYXN0ZVVuZG8uc2xpY2UoMCwgLTEpOwogICA",
"gICBjb25zdCBzbmFwID0gcGFzdGVVbmRvW3Bhc3RlVW5kby5sZW5ndGggLSAxXTsKICAgICAgZWxzLmVkaXRvci5yZXBsYWNlQ2hpbGRyZW4oLi4uc25hcC5ub2Rlcyk7CiAgICAgIGNvbnN0IGEgPSBwb2ludEF0KHNuYXAuc3RhcnQpOwogICAgICBjb25zdCB6ID0gcG9pbnRBdChzbmFwLmVuZCk7CiAgICAgIGlmIChhICYmIHopIHsKICAgICAgICBjb25zdCBiYWNrID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICBiYWNrLnNldFN0YXJ0KC4uLmEpOwogICAgICAgIGJhY2suc2V0RW5kKC4uLnopOwogICAgICAgIHNlbGVjdChiYWNrKTsKICAgICAgfQogICAgICBjaGFuZ2VkKCk7CiAgICAgIHBhc3RlVW5kbyA9IHJlc3Q7CiAgICAgIHJldmVhbENhcmV0KCk7CiAgICB9CgogICAgLy8gU2Nyb2xscyB0aGUgZWRpdG9yLCBpZiBpdCBoYXMgdG8sIHRvIHNob3cgdGhlIGNhcmV0LgogICAgZnVuY3Rpb24gcmV2ZWFsQ2FyZXQoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgbGV0IGF0ID0gci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgaWYgKCFhdC5oZWlnaHQpIHsKICAgICAgICBjb25zdCBibGsgPSBibG9ja09mKHIuc3RhcnRDb250YWluZXIpOwogICAgICAgIGlmIChibGspIGF0ID0gYmxrLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICB9CiAgICAgIGNvbnN0IGJveCA9IGVscy5lZGl0b3IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk",
"7CiAgICAgIGlmIChhdC5ib3R0b20gPiBib3guYm90dG9tIC0gOCkgZWxzLmVkaXRvci5zY3JvbGxUb3AgKz0gYXQuYm90dG9tIC0gYm94LmJvdHRvbSArIDI0OwogICAgICBlbHNlIGlmIChhdC50b3AgPCBib3gudG9wICsgOCkgZWxzLmVkaXRvci5zY3JvbGxUb3AgLT0gYm94LnRvcCAtIGF0LnRvcCArIDI0OwogICAgfQoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBlID0-IHsKICAgICAgY29uc3QgYSA9IGUudGFyZ2V0LmNsb3Nlc3QgJiYgZS50YXJnZXQuY2xvc2VzdCgnYVtocmVmXScpOwogICAgICBpZiAoYSAmJiAoZS5jdHJsS2V5IHx8IGUubWV0YUtleSkpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgd2luZG93Lm9wZW4oYS5ocmVmLCAnX2JsYW5rJywgJ25vb3BlbmVyJyk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIC8vIFRoZSBib3ggaXMgZHJhd24gaW4gdGhlIGJsb2NrJ3MgbGVmdCBwYWRkaW5nLCBhdCBpdHMgaW5kZW50LgogICAgICBjb25zdCBibGsgPSBlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0LmNsb3Nlc3QoJy5ibGtbZGF0YS10eXBlPSJjaGVjayJdJyk7CiAgICAgIGlmIChibGsgJiYgZWRpdGFibGUpIHsKICAgICAgICBjb25zdCB4ID0gZS5jbGllbnRYIC0gYmxrLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmxlZnQ7CiAgICAgICAgY29uc3QgYXQgPSAoTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwKSAqIElOREVOVF9",
"QWDsKICAgICAgICBpZiAoeCA-PSBhdCAmJiB4IDwgYXQgKyAyNikgdG9nZ2xlQ2hlY2soYmxrKTsKICAgICAgfQogICAgfSk7CgogICAgY29uc3Qgb25TZWxlY3Rpb24gPSAoKSA9PiB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgc2F2ZWQgPSByLmNsb25lUmFuZ2UoKTsKICAgICAgcmVmcmVzaFRvb2xiYXIoKTsKICAgIH07CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdzZWxlY3Rpb25jaGFuZ2UnLCBvblNlbGVjdGlvbik7CgogICAgLy8g4pSA4pSAIFNlYXJjaCBoaWdobGlnaHRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgLy8KICAgIC8vIFBhaW50ZWQgd2l0aCB0aGUgQ1NTIEN1c3RvbSBIaWdobGlnaHQgQVBJOiByYW5nZXMgb3ZlciB0aGUgdGV4dCwKICAgIC8vIGNvbG91cmVkIGJ5IHRoZSBzdHlsZXNoZWV0LCB3aXRoIG5vdGhpbmcgYWRkZWQgdG8gdGhlIG1hcmt1cCAtIHNvIGEKICAgIC8vIGhpZ2hsaWdodCBjYW4gbmV2ZXIgZW5kIHVwIHNhdmVkIGludG8gdGhlIG5vdGUuCgogICAgbGV0IG1hdGNoUmFuZ2VzID0gW107CiAgICBjb25zdCBjYW5IaWdobGlnaHQgPSAoKSA9PiB0eXBlb2YgQ1NTICE9PSAndW5kZWZpbmVkJyA",
"mJiBDU1MuaGlnaGxpZ2h0cyAmJiB0eXBlb2YgSGlnaGxpZ2h0ID09PSAnZnVuY3Rpb24nOwoKICAgIC8vIFRoZSBlZGl0b3IncyB0ZXh0IHdpdGggYSBsaW5lIGJyZWFrIGJldHdlZW4gYmxvY2tzLCBhbmQgd2hlcmUgZWFjaAogICAgLy8gdGV4dCBub2RlIHNpdHMgaW4gaXQuCiAgICBmdW5jdGlvbiB0ZXh0SW5kZXgoKSB7CiAgICAgIGNvbnN0IHBhcnRzID0gW107CiAgICAgIGxldCB0ZXh0ID0gJyc7CiAgICAgIGVscy5lZGl0b3IuY2hpbGROb2Rlcy5mb3JFYWNoKChibGssIGIpID0-IHsKICAgICAgICBpZiAoYikgdGV4dCArPSAnXG4nOwogICAgICAgIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIoYmxrLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7CiAgICAgICAgZm9yIChsZXQgbiA9IHdhbGtlci5uZXh0Tm9kZSgpOyBuOyBuID0gd2Fsa2VyLm5leHROb2RlKCkpIHsKICAgICAgICAgIHBhcnRzLnB1c2goeyBub2RlOiBuLCBzdGFydDogdGV4dC5sZW5ndGgsIGVuZDogdGV4dC5sZW5ndGggKyBuLmRhdGEubGVuZ3RoIH0pOwogICAgICAgICAgdGV4dCArPSBuLmRhdGE7CiAgICAgICAgfQogICAgICB9KTsKICAgICAgcmV0dXJuIHsgdGV4dCwgcGFydHMgfTsKICAgIH0KCiAgICBmdW5jdGlvbiByYW5nZUZvcihpZHgsIHN0YXJ0LCBlbmQpIHsKICAgICAgY29uc3QgYSA9IGlkeC5wYXJ0cy5maW5kKHAgPT4gc3RhcnQgPj0gcC5zdGFydCAmJiBzdGFydCA8IHAuZW5kKTsKICAgICAgY29uc3Q",
"gYiA9IGlkeC5wYXJ0cy5maW5kKHAgPT4gZW5kID4gcC5zdGFydCAmJiBlbmQgPD0gcC5lbmQpOwogICAgICBpZiAoIWEgfHwgIWIpIHJldHVybiBudWxsOwogICAgICBjb25zdCByID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgci5zZXRTdGFydChhLm5vZGUsIHN0YXJ0IC0gYS5zdGFydCk7CiAgICAgIHIuc2V0RW5kKGIubm9kZSwgZW5kIC0gYi5zdGFydCk7CiAgICAgIHJldHVybiByOwogICAgfQoKICAgIGZ1bmN0aW9uIGhpZ2hsaWdodCh0ZXJtcykgewogICAgICBjbGVhckhpZ2hsaWdodHMoKTsKICAgICAgaWYgKCF0ZXJtcyB8fCAhdGVybXMubGVuZ3RoIHx8ICFjYW5IaWdobGlnaHQoKSkgcmV0dXJuIDA7CiAgICAgIGNvbnN0IGlkeCA9IHRleHRJbmRleCgpOwogICAgICBtYXRjaFJhbmdlcyA9IG5zLnNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKGlkeC50ZXh0LCB0ZXJtcykubWFwKG0gPT4gcmFuZ2VGb3IoaWR4LCBtLnN0YXJ0LCBtLmVuZCkpLmZpbHRlcihCb29sZWFuKTsKICAgICAgaWYgKG1hdGNoUmFuZ2VzLmxlbmd0aCkgQ1NTLmhpZ2hsaWdodHMuc2V0KCdna2ItbWF0Y2gnLCBuZXcgSGlnaGxpZ2h0KC4uLm1hdGNoUmFuZ2VzKSk7CiAgICAgIHJldHVybiBtYXRjaFJhbmdlcy5sZW5ndGg7CiAgICB9CgogICAgLy8gTWFya3Mgb25lIG1hdGNoIGFzIHRoZSBjdXJyZW50IG9uZSBhbmQgc2Nyb2xscyBpdCBpbnRvIHRoZSBtaWRkbGUKICAgIC8vIHRoaXJkIG9mIHRoZSBlZGl0b3IgaWYgaXQgaXM",
"gb3V0IG9mIHZpZXcuCiAgICBmdW5jdGlvbiBzaG93TWF0Y2goaSkgewogICAgICBjb25zdCByID0gbWF0Y2hSYW5nZXNbaV07CiAgICAgIGlmICghciB8fCAhY2FuSGlnaGxpZ2h0KCkpIHJldHVybjsKICAgICAgQ1NTLmhpZ2hsaWdodHMuc2V0KCdna2ItbWF0Y2gtY3VycmVudCcsIG5ldyBIaWdobGlnaHQocikpOwogICAgICBjb25zdCBib3ggPSBlbHMuZWRpdG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICBjb25zdCBhdCA9IHIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICAgIGlmIChhdC50b3AgPCBib3gudG9wICsgMjQgfHwgYXQuYm90dG9tID4gYm94LmJvdHRvbSAtIDI0KSB7CiAgICAgICAgZWxzLmVkaXRvci5zY3JvbGxUb3AgKz0gYXQudG9wIC0gYm94LnRvcCAtIGJveC5oZWlnaHQgLyAzOwogICAgICB9CiAgICB9CgogICAgZnVuY3Rpb24gY2xlYXJIaWdobGlnaHRzKCkgewogICAgICBtYXRjaFJhbmdlcyA9IFtdOwogICAgICBpZiAoIWNhbkhpZ2hsaWdodCgpKSByZXR1cm47CiAgICAgIENTUy5oaWdobGlnaHRzLmRlbGV0ZSgnZ2tiLW1hdGNoJyk7CiAgICAgIENTUy5oaWdobGlnaHRzLmRlbGV0ZSgnZ2tiLW1hdGNoLWN1cnJlbnQnKTsKICAgIH0KCiAgICAvLyDilIDilIAgQVBJIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGZ1bmN0aW9uIHNldERvYyhkb2MpIHsKICAgICAgcGFzdGVVbmRvID0gW107CiAgICAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKC4uLmZtdC5ub3JtYWxpc2VEb2MoZG9jKS5tYXAoYmxvY2tFbCkpOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIGZ1bmN0aW9uIHNldEVkaXRhYmxlKG9uLCBwbGFjZWhvbGRlcikgewogICAgICBlZGl0YWJsZSA9ICEhb247CiAgICAgIGVscy5lZGl0b3IuY29udGVudEVkaXRhYmxlID0gZWRpdGFibGUgPyAndHJ1ZScgOiAnZmFsc2UnOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQucGxhY2Vob2xkZXIgPSBwbGFjZWhvbGRlciB8fCAnV3JpdGUgaGVyZeKApic7CiAgICAgIGVscy5lZGl0b3Iuc2V0QXR0cmlidXRlKCdhcmlhLWRpc2FibGVkJywgU3RyaW5nKCFlZGl0YWJsZSkpOwogICAgICBmb3IgKGNvbnN0IGIgb2YgWy4uLmVscy50b29sYmFyLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpXSkgYi5kaXNhYmxlZCA9ICFlZGl0YWJsZTsKICAgIH0KCiAgICBmdW5jdGlvbiBmb2N1cygpIHsKICAgICAgZWxzLmVkaXRvci5mb2N1cygpOwogICAgICBjb25zdCBmaXJzdCA9IGVscy5lZGl0b3IuZmlyc3RDaGlsZDsKICAgICAgaWYgKGZpcnN0KSBwbGFjZUNhcmV0KGZpcnN0LCAwKTsKICAgIH0KCiAgICBmdW5jdGlvbiBkZXN0cm95KCk",
"gewogICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKCdzZWxlY3Rpb25jaGFuZ2UnLCBvblNlbGVjdGlvbik7CiAgICAgIGNsZWFySGlnaGxpZ2h0cygpOwogICAgICBjbG9zZU1lbnUocm9vdCk7CiAgICB9CgogICAgcmV0dXJuIHsKICAgICAgZWxlbWVudDogZWxzLmVkaXRvciwKICAgICAgdG9vbGJhcjogZWxzLnRvb2xiYXIsCiAgICAgIGxpbmtiYXI6IGVscy5saW5rYmFyLAogICAgICBzZXREb2MsCiAgICAgIGdldERvYzogKCkgPT4gcmVhZERvYyhlbHMuZWRpdG9yKSwKICAgICAgc2V0RWRpdGFibGUsCiAgICAgIGZvY3VzLAogICAgICBkZXN0cm95LAogICAgICBoaWdobGlnaHQsCiAgICAgIHNob3dNYXRjaCwKICAgICAgY2xlYXJIaWdobGlnaHRzLAogICAgICBtYXRjaENvdW50OiAoKSA9PiBtYXRjaFJhbmdlcy5sZW5ndGgsCiAgICB9OwogIH0KCiAgbnMubm90ZUVkaXRvciA9IHsgY3JlYXRlLCByZWFkRG9jIH07Cn0pKCk7Cg\"],[\"addon/app/remote.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyB3YXkgdG8gR21haWwKLy8KLy",
"8gVGhlIE5vdGVzIHZpZXcgKHNyYy9jb250ZW50L25vdGVzLmpzKSB0YWxrcyB0byBhIG5vdGVzU3RvcmUsIGFuZCB0aGUKLy8gYm9hcmQncyBkYXRhIGxheWVyIChzcmMvY29udGVudC9zdG9yZS5qcykgdG8gYGFwaS5nbWFpbGAgYW5kCi8vIGBjaHJvbWUuc3RvcmFnZWAuIEluIHRoZSBleHRlbnNpb24gdGhvc2UgcmVhY2ggR21haWwgdGhyb3VnaCB0aGUKLy8gYmFja2dyb3VuZCB3b3JrZXI7IGhlcmUgdGhleSBhc2sgdGhlIHNjcmlwdCB0aGF0IHNlcnZlZCB0aGlzIHBhZ2UsCi8vIHRocm91Z2ggZ29vZ2xlLnNjcmlwdC5ydW4sIHdoaWNoIGFza3MgR21haWwuIFNhbWUgc2hhcGVzLCBzYW1lIGFuc3dlcnMsCi8vIHNvIHRoZSB2aWV3cyBydW4gdW5jaGFuZ2VkLiBUaGUgY2FsZW5kYXIsIGxpa2V3aXNlLCB0aHJvdWdoCi8vIGBhcGkuZ29vZ2xlTWFueWAuIEFsc28gYGhvb2tzYDogdGhlIGFjY291bnQsIGFuZCBvcGVuaW5nIGEKLy8gY29udmVyc2F0aW9uIGluIEdtYWlsLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdC",
"BucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCBmbXQgPSBucy5ub3RlRm9ybWF0OwoKICAvLyBnb29nbGUuc2NyaXB0LnJ1biBhcyBhIHByb21pc2UuIEEgcmVmdXNhbCBmcm9tIHRoZSBzY3JpcHQgYXJyaXZlcyBhcwogIC8vICJub3RfYWxsb3dlZDog4oCmIiwgd2hpY2ggdGhlIHZpZXcga25vd3MgdG8gZXhwbGFpbi4KICBmdW5jdGlvbiBjYWxsKGZuLCAuLi5hcmdzKSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgICBnb29nbGUuc2NyaXB0LnJ1bgogICAgICAgIC53aXRoU3VjY2Vzc0hhbmRsZXIocmVzb2x2ZSkKICAgICAgICAud2l0aEZhaWx1cmVIYW5kbGVyKGVyciA9PiB7CiAgICAgICAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKChlcnIgJiYgZXJyLm1lc3NhZ2UpIHx8IGVyciB8fCAnU29tZXRoaW5nIHdlbnQgd3JvbmcnKS5yZXBsYWNlKC9eKEV4Y2VwdGlvbnxFcnJvcik6XHMqLywgJycpOwogICAgICAgICAgY29uc3QgZSA9IG5ldyBFcnJvcih0ZXh0LnJlcGxhY2UoL15ub3RfYWxsb3dlZDpccyovLCAnJykpOwogICAgICAgICAgaWYgKC9ebm90X2FsbG93ZWQ6Ly50ZXN0KHRleHQpKSBlLmNvZGUgPSAnbm90X2FsbG93ZWQnOwogICAgICAgICAgcmVqZWN0KGUpOwogICAgICAgIH0pW2ZuXSguLi5hcmdzKTsKICAgIH0pOwogIH0KCiAgY29uc3QgUyA9IHsKICAgIGxhYmVsOiAnX05vdGVzJywKICAgIGZvbGRlcnM6IF",
"tdLAogICAgZG9jczogbmV3IE1hcCgpLCAvLyBtZXNzYWdlIGlkIOKGkiBjb250ZW50LCBmcm9tIGEgc2VhcmNoIG9yIGEgc2F2ZQogIH07CgogIG5zLm5vdGVzU3RvcmUgPSB7CiAgICBsYWJlbE5hbWU6ICgpID0-IFMubGFiZWwsCiAgICBmb2xkZXJzOiAoKSA9PiBTLmZvbGRlcnMsCgogICAgYXN5bmMgbGlzdChhY2NvdW50LCBxdWVyeSkgewogICAgICBjb25zdCByID0gYXdhaXQgY2FsbCgnYXBwTGlzdCcsIHF1ZXJ5IHx8ICcnKTsKICAgICAgUy5sYWJlbCA9IHIubGFiZWw7CiAgICAgIFMuZm9sZGVycyA9IHIuZm9sZGVycyB8fCBbXTsKICAgICAgT2JqZWN0LmtleXMoci5kb2NzIHx8IHt9KS5mb3JFYWNoKGlkID0-IFMuZG9jcy5zZXQoaWQsIHIuZG9jc1tpZF0pKTsKICAgICAgcmV0dXJuIHsgbm90ZXM6IHIubm90ZXMsIHRydW5jYXRlZDogci50cnVuY2F0ZWQsIGZvbGRlcnM6IFMuZm9sZGVycyB9OwogICAgfSwKCiAgICAvLyBNZXNzYWdlcyBuZXZlciBjaGFuZ2UsIHNvIGEgbm90ZSdzIGNvbnRlbnQsIG9uY2UgcmVhZCwgaXMga2VwdC4KICAgIGFzeW5jIGJvZHkobm90ZSkgewogICAgICBpZiAoUy5kb2NzLmhhcyhub3RlLm1lc3NhZ2VJZCkpIHJldHVybiBTLmRvY3MuZ2V0KG5vdGUubWVzc2FnZUlkKTsKICAgICAgY29uc3QgZG9jID0gYXdhaXQgY2FsbCgnYXBwQm9keScsIG5vdGUubWVzc2FnZUlkKTsKICAgICAgUy5kb2NzLnNldChub3RlLm1lc3NhZ2VJZCwgZG9jKTsKICAgICAgcmV0dXJuIGRvYzsKIC",
"AgIH0sCgogICAgYXN5bmMgc2F2ZShhY2NvdW50LCBwcmV2aW91cywgc25hcCkgewogICAgICBjb25zdCByID0gYXdhaXQgY2FsbCgnYXBwU2F2ZScsIHByZXZpb3VzID8gcHJldmlvdXMubWVzc2FnZUlkIDogJycsIHsKICAgICAgICB0aXRsZTogc25hcC50aXRsZSwgZG9jOiBmbXQubm9ybWFsaXNlRG9jKHNuYXAuZG9jKSwgZm9sZGVySWQ6IHNuYXAuZm9sZGVySWQgfHwgJycsIG5vdGVJZDogc25hcC5ub3RlSWQgfHwgJycsCiAgICAgIH0pOwogICAgICBTLmRvY3Muc2V0KHIubm90ZS5tZXNzYWdlSWQsIGZtdC5ub3JtYWxpc2VEb2Moc25hcC5kb2MpKTsKICAgICAgcmV0dXJuIHIubm90ZTsKICAgIH0sCgogICAgYXN5bmMgcmV0aXJlKG5vdGUpIHsgYXdhaXQgY2FsbCgnYXBwUmV0aXJlJywgbm90ZS5tZXNzYWdlSWQpOyB9LAogICAgYXN5bmMgcmVzdG9yZShub3RlKSB7IGF3YWl0IGNhbGwoJ2FwcFJlc3RvcmUnLCBub3RlLm1lc3NhZ2VJZCwgbm90ZS5mb2xkZXJJZCB8fCAnJyk7IH0sCgogICAgYXN5bmMgbW92ZShub3RlLCBmb2xkZXJJZCkgewogICAgICBhd2FpdCBjYWxsKCdhcHBNb3ZlJywgbm90ZS5tZXNzYWdlSWQsIGZvbGRlcklkIHx8ICcnKTsKICAgICAgbm90ZS5mb2xkZXJJZCA9IGZvbGRlcklkIHx8ICcnOwogICAgfSwKCiAgICBhc3luYyBjcmVhdGVGb2xkZXIocGFyZW50LCB0aXRsZSkgewogICAgICBjb25zdCByID0gYXdhaXQgY2FsbCgnYXBwQ3JlYXRlRm9sZGVyJywgcGFyZW50ID8gcGFyZW50Lm",
"lkIDogJycsIHRpdGxlKTsKICAgICAgUy5mb2xkZXJzID0gci5mb2xkZXJzOwogICAgICByZXR1cm4gci5mb2xkZXI7CiAgICB9LAoKICAgIGFzeW5jIHJlbmFtZUZvbGRlcihmb2xkZXIsIHRpdGxlKSB7CiAgICAgIFMuZm9sZGVycyA9IChhd2FpdCBjYWxsKCdhcHBSZW5hbWVGb2xkZXInLCBmb2xkZXIuaWQsIHRpdGxlKSkuZm9sZGVyczsKICAgIH0sCgogICAgYXN5bmMgZGVsZXRlRm9sZGVyKGZvbGRlcikgewogICAgICBTLmZvbGRlcnMgPSAoYXdhaXQgY2FsbCgnYXBwRGVsZXRlRm9sZGVyJywgZm9sZGVyLmlkKSkuZm9sZGVyczsKICAgIH0sCiAgfTsKCiAgLy8g4pSA4pSAIFdob3NlIG1haWxib3gsIGFuZCBvcGVuaW5nIGEgY29udmVyc2F0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCB3aG8gPSB7IGFjY291bnQ6ICcnIH07CgogIC8vIEFza2VkIG9uY2UsIGFzIHRoZSBhcHAgc3RhcnRzOiB0aGUgYm9hcmQga2VlcHMgaXRzIHNldHRpbmdzIHBlciBhY2NvdW50LgogIGZ1bmN0aW9uIGxvYWRBY2NvdW50KCkgewogICAgcmV0dXJuIGNhbGwoJ2FwcEFjY291bnQnKS50aGVuKGEgPT4geyB3aG8uYWNjb3VudCA9IFN0cmluZyhhIHx8ICcnKTsgcmV0dXJuIHdoby5hY2NvdW50OyB9KTsKICB9CgogIGNvbnN0IHRocmVhZFVybCA9IHRocmVhZElkID0-CiAgICBgaHR0cHM6Ly9tYWlsLmdvb2dsZS5jb20vbW",
"FpbC8_YXV0aHVzZXI9JHtlbmNvZGVVUklDb21wb25lbnQod2hvLmFjY291bnQpfSNhbGwvJHtlbmNvZGVVUklDb21wb25lbnQodGhyZWFkSWQpfWA7CgogIG5zLmhvb2tzID0gewogICAgZ2V0QWNjb3VudDogKCkgPT4gd2hvLmFjY291bnQsCiAgICB0aHJlYWRVcmwsCiAgICAvLyBUaGUgY29udmVyc2F0aW9uIGluIEdtYWlsIC0gd2hpY2gsIG9uIGEgcGhvbmUsIHRoZSBHbWFpbCBhcHAgbWF5IG9mZmVyIHRvIG9wZW4uCiAgICBvcGVuVGhyZWFkKHRocmVhZElkKSB7CiAgICAgIHdpbmRvdy5vcGVuKHRocmVhZFVybCh0aHJlYWRJZCksICdfYmxhbmsnLCAnbm9vcGVuZXInKTsKICAgIH0sCiAgfTsKCiAgLy8g4pSA4pSAIFRoZSBib2FyZCdzIEdtYWlsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gYXBwQm9hcmRHbWFpbCBhbGxvd3Mgb25seSB3aGF0IHRoZSBib2FyZCBkb2VzIHdpdGggR21haWwuIEVycm9ycyBjb21lCiAgLy8gYmFjayBhcyB0aGUgZXh0ZW5zaW9uJ3MgZG8gKCJodHRwXzQwOSIpLCBzaW5jZSB0aGUgYm9hcmQgYWN0cyBvbiBzb21lLgoKICBmdW5jdGlvbiBnbWFpbEVycm9yKG1lc3NhZ2UsIHN0YXR1cykgewogICAgY29uc3QgZSA9IG5ldyBFcnJvcihTdHJpbmcobWVzc2",
"FnZSB8fCAnR21haWwgZGlkIG5vdCBhbnN3ZXIuJykpOwogICAgY29uc3QgbSA9IC9HbWFpbCBhbnN3ZXJlZCAoXGR7M30pLy5leGVjKGUubWVzc2FnZSk7CiAgICBlLmNvZGUgPSBzdGF0dXMgPyBgaHR0cF8ke3N0YXR1c31gIDogbSA_IGBodHRwXyR7bVsxXX1gIDogJ2dtYWlsJzsKICAgIHJldHVybiBlOwogIH0KCiAgZnVuY3Rpb24gZ21haWwobWV0aG9kLCBwYXRoLCBxdWVyeSwgYm9keSkgewogICAgcmV0dXJuIGNhbGwoJ2FwcEJvYXJkR21haWwnLCBtZXRob2QsIHBhdGgsIHF1ZXJ5IHx8IG51bGwsIGJvZHkgfHwgbnVsbCkuY2F0Y2goZXJyID0-IHsKICAgICAgaWYgKCFlcnIuY29kZSkgdGhyb3cgZ21haWxFcnJvcihlcnIubWVzc2FnZSk7CiAgICAgIHRocm93IGVycjsKICAgIH0pOwogIH0KCiAgLy8gQSBiYXRjaCBvZiByZWFkcyBpbiBvbmUgcm91bmQgdHJpcDogYSBib2FyZCdzIHdvcnRoIG9mIGNhcmRzIGF0IG9uY2UuCiAgYXN5bmMgZnVuY3Rpb24gZ21haWxNYW55KGxpc3QpIHsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBjYWxsKCdhcHBCb2FyZEdtYWlsTWFueScsIGxpc3QpOwogICAgcmV0dXJuIHJlc3VsdHMubWFwKHIgPT4gKHIgJiYgci5lcnJvciA_IHsgZXJyb3I6IGdtYWlsRXJyb3Ioci5lcnJvci5tZXNzYWdlLCByLmVycm9yLnN0YXR1cykgfSA6IHIpKTsKICB9CgogIC8vIOKUgOKUgCBUaGUgY2FsZW5kYXIncyBHb29nbGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBDYWxlbmRhciBhbmQgVGFza3MgcmVhZHMsIGluIG9uZSByb3VuZCB0cmlwLCBhcyB0aGUgZXh0ZW5zaW9uJ3MKICAvLyB3b3JrZXIgYW5zd2VycyB0aGVtOiBlYWNoIHRoZSByZXNwb25zZSwgb3IgeyBlcnJvciB9IHdpdGggYSBjb2RlLgoKICBmdW5jdGlvbiBnb29nbGVFcnJvcihlKSB7CiAgICBjb25zdCBlcnIgPSBuZXcgRXJyb3IoU3RyaW5nKGUubWVzc2FnZSB8fCAnR29vZ2xlIGRpZCBub3QgYW5zd2VyLicpKTsKICAgIGVyci5jb2RlID0gZS5jb2RlIHx8IChlLnN0YXR1cyA_IGBodHRwXyR7ZS5zdGF0dXN9YCA6ICdnb29nbGUnKTsKICAgIHJldHVybiBlcnI7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBnb29nbGVNYW55KGxpc3QpIHsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBjYWxsKCdhcHBHb29nbGVNYW55JywgbGlzdCk7CiAgICByZXR1cm4gcmVzdWx0cy5tYXAociA9PiAociAmJiByLmVycm9yID8geyBlcnJvcjogZ29vZ2xlRXJyb3Ioci5lcnJvcikgfSA6IHIpKTsKICB9CgogIG5zLmFwaSA9IHsgU1RBVEVfQ09ERVM6IG5ldyBTZXQoKSwgZ21haWwsIGdtYWlsTWFueSwgZ29vZ2xlTWFueSB9OwogIG5zLmFwcFJlbW90ZSA9IHsgY2FsbCwgbG9hZEFjY291bnQgfTsKCiAgLy8g4pSA4pSAIGNocm9tZS5zdG9yYWdlLC",
"BhcyB0aGUgYm9hcmQgdXNlcyBpdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vICJzeW5jIiAtIHRoZSBjb2x1bW4gbGF5b3V0IGFuZCBjYXJkIHRpdGxlcywgbm90ZXMgYW5kIGNvbG91cnMgLSBpcyB0aGUKICAvLyBzY3JpcHQncyBwZXItdXNlciBwcm9wZXJ0aWVzOiB0aGUgc2FtZSBvbiBldmVyeSBwaG9uZSBhbmQgY29tcHV0ZXIKICAvLyB0aGUgYXBwIGlzIG9wZW5lZCBvbiAodGhvdWdoIG5vdCBzaGFyZWQgd2l0aCB0aGUgZXh0ZW5zaW9uLCB3aG9zZQogIC8vIGNvcHkgaXMgQ2hyb21lJ3MpLiAibG9jYWwiIC0gY2FyZCBvcmRlciBhbmQgdGhlIGxhc3QgdGFiIC0gaXMgdGhpcwogIC8vIGJyb3dzZXIncyBvd24gc3RvcmFnZSwgYXMgaW4gdGhlIGV4dGVuc2lvbi4KCiAgZnVuY3Rpb24gcGljayhhbGwsIGtleXMpIHsKICAgIGlmIChrZXlzID09PSBudWxsIHx8IGtleXMgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgLi4uYWxsIH07CiAgICBpZiAodHlwZW9mIGtleXMgPT09ICdzdHJpbmcnKSBrZXlzID0gW2tleXNdOwogICAgY29uc3Qgb3V0ID0ge307CiAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlzKSkgewogICAgICBmb3IgKGNvbnN0IGsgb2Yga2V5cykgaWYgKGsgaW4gYWxsKSBvdXRba10gPSBhbGxba107CiAgICAgIHJldHVybiBvdXQ7CiAgICB9CiAgICBmb3IgKGNvbnN0IGsgb2",
"YgT2JqZWN0LmtleXMoa2V5cykpIG91dFtrXSA9IGsgaW4gYWxsID8gYWxsW2tdIDoga2V5c1trXTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICBjb25zdCBMT0NBTCA9ICdzdXBlcm1haWwuJzsKICBmdW5jdGlvbiBsb2NhbEFsbCgpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgdHJ5IHsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBsb2NhbFN0b3JhZ2UubGVuZ3RoOyBpKyspIHsKICAgICAgICBjb25zdCBrID0gbG9jYWxTdG9yYWdlLmtleShpKTsKICAgICAgICBpZiAoIWsgfHwgIWsuc3RhcnRzV2l0aChMT0NBTCkpIGNvbnRpbnVlOwogICAgICAgIHRyeSB7IG91dFtrLnNsaWNlKExPQ0FMLmxlbmd0aCldID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrKSk7IH0gY2F0Y2ggKGVycikgeyAvKiBub3Qgb3VycyAqLyB9CiAgICAgIH0KICAgIH0gY2F0Y2ggKGVycikgeyAvKiBzdG9yYWdlIG9mZjogbm90aGluZyBrZXB0ICovIH0KICAgIHJldHVybiBvdXQ7CiAgfQogIGNvbnN0IGxvY2FsID0gewogICAgYXN5bmMgZ2V0KGtleXMpIHsgcmV0dXJuIHBpY2sobG9jYWxBbGwoKSwga2V5cyk7IH0sCiAgICBhc3luYyBzZXQoaXRlbXMpIHsKICAgICAgdHJ5IHsgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKGl0ZW1zKSkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTE9DQUwgKyBrLCBKU09OLnN0cmluZ2lmeShpdGVtc1trXSkpOyB9IGNhdGNoIChlcnIpIHsgLyogbm90IGtlcHQgKi8gfQogICAgfSwKICAgIG",
"FzeW5jIHJlbW92ZShrZXlzKSB7CiAgICAgIHRyeSB7IGZvciAoY29uc3QgayBvZiBbXS5jb25jYXQoa2V5cykpIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKExPQ0FMICsgayk7IH0gY2F0Y2ggKGVycikgeyAvKiBub3RoaW5nIHRvIHJlbW92ZSAqLyB9CiAgICB9LAogIH07CgogIC8vIFJlYWQgZnJvbSB0aGUgc2NyaXB0IG9uY2UsIHRoZW4ga2VwdCBoZXJlIGFuZCB3cml0dGVuIHRocm91Z2guCiAgbGV0IHN5bmNlZCA9IG51bGw7CiAgY29uc3Qgc3luY0FsbCA9IGFzeW5jICgpID0-IChzeW5jZWQgPSBzeW5jZWQgfHwgYXdhaXQgY2FsbCgnYXBwUHJlZnNHZXQnLCBudWxsKSk7CiAgY29uc3Qgc3luYyA9IHsKICAgIGFzeW5jIGdldChrZXlzKSB7IHJldHVybiBwaWNrKGF3YWl0IHN5bmNBbGwoKSwga2V5cyk7IH0sCiAgICBhc3luYyBzZXQoaXRlbXMpIHsKICAgICAgYXdhaXQgY2FsbCgnYXBwUHJlZnNTZXQnLCBpdGVtcyk7CiAgICAgIE9iamVjdC5hc3NpZ24oYXdhaXQgc3luY0FsbCgpLCBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KGl0ZW1zKSkpOwogICAgfSwKICAgIGFzeW5jIHJlbW92ZShrZXlzKSB7CiAgICAgIGNvbnN0IGxpc3QgPSBbXS5jb25jYXQoa2V5cyk7CiAgICAgIGF3YWl0IGNhbGwoJ2FwcFByZWZzUmVtb3ZlJywgbGlzdCk7CiAgICAgIGNvbnN0IGFsbCA9IGF3YWl0IHN5bmNBbGwoKTsKICAgICAgZm9yIChjb25zdCBrIG9mIGxpc3QpIGRlbGV0ZSBhbGxba107CiAgICB9LAogIH07CgogIGNvbn",
"N0IGNocm9tZUxpa2UgPSAoZ2xvYmFsVGhpcy5jaHJvbWUgPSBnbG9iYWxUaGlzLmNocm9tZSB8fCB7fSk7CiAgaWYgKCFjaHJvbWVMaWtlLnN0b3JhZ2UpIGNocm9tZUxpa2Uuc3RvcmFnZSA9IHsgbG9jYWwsIHN5bmMsIG9uQ2hhbmdlZDogeyBhZGRMaXN0ZW5lcigpIHt9IH0gfTsKfSkoKTsK\"],[\"src/content/store.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIEJvYXJkIGRhdGEKLy8KLy8gU2hhcmVkIGJ5IHRoZSBib2FyZCBhbmQgdGhlIGRvY2ssIHNvIGEgbW92ZSBtYWRlIGZyb20gZWl0aGVyIGlzIHNlZW4gYnkKLy8gYm90aC4gR21haWwgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aCBmb3Igd2hpY2ggY29sdW1uIGEgdGhyZWFkIGlzIGluOwovLyB3aGF0IGxpdmVzIGhlcmUgaXMgYSBjYWNoZSBvZiBsYWJlbCBpZHMgYW5kIHRocmVhZCBzdW1tYXJpZXMsIHBsdXMgdGhlCi8vIHNtYWxsIHRoaW5ncyBHbWFpbCBjYW5ub3QgaG9sZCAtIHRoZSBjb2x1bW4gbGF5b3V0IGFuZCB0aGUgdXNlcidzIG93bgovLyBjYXJkIHRpdGxlcywgbm90ZXMgYW5kIGNvbG91cnMgKHN0b3JhZ2",
"Uuc3luYywgc28gdGhleSBmb2xsb3cgdGhlIHVzZXIKLy8gYmV0d2VlbiBjb21wdXRlcnMpIGFuZCBjYXJkIG9yZGVyIHdpdGhpbiBlYWNoIGNvbHVtbiAoc3RvcmFnZS5sb2NhbCwKLy8gYmVjYXVzZSBpdCBjaGFuZ2VzIG9uIGV2ZXJ5IGRyYWcgYW5kIHN5bmMgaGFzIGEgdGlnaHQgd3JpdGUgcXVvdGEpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB7IGFwaSwgbG9naWMsIEtFWVMgfSA9IG5zOwoKICBjb25zdCBidXMgPSBuZXcgRXZlbnRUYXJnZXQoKTsKICBjb25zdCBlbWl0ID0gKHR5cGUsIGRldGFpbCkgPT4gYnVzLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KHR5cGUsIHsgZGV0YWlsIH0pKTsKCiAgY29uc3QgUyA9IHsKICAgIGxhYmVsczogbmV3IE1hcCgpLCAgIC8vIGxvd2VyLWNhc2VkIG5hbWUg4oaSIGxhYmVsIHJlc291cmNlCiAgICBsYWJlbHNBdDogMCwKICAgIG1ldGE6IG5ldyBNYXAoKSwgICAgIC",
"8vIHRocmVhZCBpZCDihpIgc3VtbWFyeSAoc2VlIGxvZ2ljLnN1bW1hcmlzZVRocmVhZCkKICAgIHBlbmRpbmc6IG5ldyBTZXQoKSwgIC8vIGluLWZsaWdodCB0aHJlYWRzLm1vZGlmeSBwcm9taXNlcwogIH07CgogIC8vIEVycm9ycyB0aGF0IG1lYW4gIm5vdGhpbmcgZWxzZSB3aWxsIHdvcmsgZWl0aGVyIiwgd2hpY2ggbXVzdCBzdG9wIGEKICAvLyBiYXRjaCByYXRoZXIgdGhhbiBiZWluZyBzd2FsbG93ZWQgcGVyIHRocmVhZC4KICBmdW5jdGlvbiBpc0ZhdGFsKGVycikgewogICAgcmV0dXJuIGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpIHx8IGVyci5jb2RlID09PSAnZXh0ZW5zaW9uX3JlbG9hZGVkJzsKICB9CgogIC8vIOKUgOKUgCBTZXR0aW5ncyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgYXN5bmMgZnVuY3Rpb24gbG9hZENvbHVtbnMoYWNjb3VudCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5jb2x1bW5zKGFjY291bnQpOwogICAgY29uc3QgZ290ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQoa2V5KTsKICAgIHJldHVybiBsb2dpYy5ub3JtYWxpc2VDb2x1bW5zKGdvdFtrZXldKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdm",
"VDb2x1bW5zKGFjY291bnQsIGNvbHVtbnMpIHsKICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMuc2V0KHsgW0tFWVMuY29sdW1ucyhhY2NvdW50KV06IGNvbHVtbnMgfSk7CiAgICBlbWl0KCdjb2x1bW5zLWNoYW5nZWQnLCB7IGNvbHVtbnMgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBsb2FkT3JkZXIoYWNjb3VudCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5vcmRlcihhY2NvdW50KTsKICAgIGNvbnN0IGdvdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpOwogICAgcmV0dXJuIGdvdFtrZXldIHx8IHt9OwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZU9yZGVyKGFjY291bnQsIGxpc3RzLCBjb2x1bW5zKSB7CiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy5vcmRlcihhY2NvdW50KV06IGxvZ2ljLnBydW5lT3JkZXIobGlzdHMsIGNvbHVtbnMpIH0pOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgZWRpdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIGxvYWRDYXJkRWRpdHMoYWNjb3VudCkgewogICAgY29uc3QgYWxsID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQobnVsbCk7Ci",
"AgICByZXR1cm4gbG9naWMuY2FyZEVkaXRzRnJvbShhbGwsIEtFWVMuY2FyZFByZWZpeChhY2NvdW50KSk7CiAgfQoKICAvLyBBIG51bGwgZWRpdCBkZWxldGVzIHRoZSByZWNvcmQuIFN5bmMncyBvd24gcXVvdGEgbWVzc2FnZSAoIlFVT1RBX0JZVEVTCiAgLy8gcXVvdGEgZXhjZWVkZWQiKSBzYXlzIG5vdGhpbmcgYWJvdXQgd2hhdCB0byBkbywgc28gaXQgaXMgcmVwaHJhc2VkLgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVDYXJkRWRpdChhY2NvdW50LCB0aHJlYWRJZCwgZWRpdCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5jYXJkKGFjY291bnQsIHRocmVhZElkKTsKICAgIHRyeSB7CiAgICAgIGlmIChlZGl0KSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLnNldCh7IFtrZXldOiBlZGl0IH0pOwogICAgICBlbHNlIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMucmVtb3ZlKGtleSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKC9xdW90YS9pLnRlc3QoKGVyciAmJiBlcnIubWVzc2FnZSkgfHwgJycpKSB7CiAgICAgICAgdGhyb3cgT2JqZWN0LmFzc2lnbihuZXcgRXJyb3IoCiAgICAgICAgICAnQ2hyb21l4oCZcyBzeW5jZWQgc3RvcmFnZSBpcyBmdWxsLiBDbGVhciB0aGUgbm90ZXMgb24gY2FyZHMgeW91IG5vIGxvbmdlciBuZWVkLCBvciB0YWtlIGZpbmlzaGVkIGNhcmRzIG9mZiB0aGUgYm9hcmQuJwogICAgICAgICksIHsgY29kZTogJ3F1b3RhJyB9KTsKICAgICAgfQogICAgICB0aHJvdyBlcnI7CiAgICB9Ci",
"AgfQoKICBhc3luYyBmdW5jdGlvbiBsb2FkRG9ja1Bvc2l0aW9uKCkgewogICAgY29uc3QgZ290ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQoS0VZUy5kb2NrUG9zaXRpb24pOwogICAgY29uc3QgdiA9IGdvdFtLRVlTLmRvY2tQb3NpdGlvbl07CiAgICByZXR1cm4gdiA9PT0gJ3JpZ2h0JyB8fCB2ID09PSAnaGlkZGVuJyA_IHYgOiAnbGVmdCc7CiAgfQoKICAvLyDilIDilIAgTGFiZWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBhc3luYyBmdW5jdGlvbiByZWZyZXNoTGFiZWxzKCkgewogICAgY29uc3QgciA9IGF3YWl0IGFwaS5nbWFpbCgnR0VUJywgJ2xhYmVscycpOwogICAgUy5sYWJlbHMgPSBuZXcgTWFwKChyLmxhYmVscyB8fCBbXSkubWFwKGwgPT4gW2wubmFtZS50b0xvd2VyQ2FzZSgpLCBsXSkpOwogICAgUy5sYWJlbHNBdCA9IERhdGUubm93KCk7CiAgfQoKICBmdW5jdGlvbiBhbGxMYWJlbHMoKSB7CiAgICByZXR1cm4gWy4uLlMubGFiZWxzLnZhbHVlcygpXTsKICB9CgogIC8vIEdtYWlsIGxhYmVsIG5hbWVzIGFyZSB1bmlxdWUgY2FzZS1pbnNlbnNpdGl2ZWx5LCBzbyBsb29rdXBzIGFyZSB0b28uCiAgZnVuY3Rpb2",
"4gbGFiZWxJZChuYW1lKSB7CiAgICBjb25zdCBsID0gUy5sYWJlbHMuZ2V0KFN0cmluZyhuYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpKTsKICAgIHJldHVybiBsID8gbC5pZCA6ICcnOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZW5zdXJlTGFiZWxzKG5hbWVzLCB7IGZyZXNoID0gZmFsc2UgfSA9IHt9KSB7CiAgICBpZiAoZnJlc2ggfHwgIVMubGFiZWxzQXQpIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKCiAgICBjb25zdCB3YW50ZWQgPSBbXTsKICAgIGZvciAoY29uc3QgbiBvZiBuYW1lcykgd2FudGVkLnB1c2goLi4ubG9naWMubGFiZWxBbmNlc3RvcnMobiksIG4pOwoKICAgIC8vIFNlcXVlbnRpYWwsIHBhcmVudHMgZmlyc3QuIENyZWF0aW5nIGEgaGFuZGZ1bCBvZiBsYWJlbHMgaGFwcGVucyBvbmNlCiAgICAvLyBwZXIgYm9hcmQsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gZ2FpbiBmcm9tIHJhY2luZyB0aGVtLgogICAgZm9yIChjb25zdCBuYW1lIG9mIFsuLi5uZXcgU2V0KHdhbnRlZCldKSB7CiAgICAgIGlmIChsYWJlbElkKG5hbWUpKSBjb250aW51ZTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgYXBpLmdtYWlsKCdQT1NUJywgJ2xhYmVscycsIG51bGwsIHsKICAgICAgICAgIG5hbWUsCiAgICAgICAgICBsYWJlbExpc3RWaXNpYmlsaXR5OiAnbGFiZWxTaG93JywKICAgICAgICAgIG1lc3NhZ2VMaXN0VmlzaWJpbGl0eTogJ3Nob3cnLAogICAgICAgIH0pOwogICAgICAgIFMubGFiZW",
"xzLnNldChuYW1lLnRvTG93ZXJDYXNlKCksIGNyZWF0ZWQpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICAvLyA0MDk6IGl0IGV4aXN0cyBhZnRlciBhbGwgKGNyZWF0ZWQgaW4gYW5vdGhlciB0YWIsIG9yIGRpZmZlcmluZwogICAgICAgIC8vIG9ubHkgaW4gY2FzZSkuIFJlLXJlYWQgcmF0aGVyIHRoYW4gZmFpbC4KICAgICAgICBpZiAoZXJyLmNvZGUgPT09ICdodHRwXzQwOScpIHsKICAgICAgICAgIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKICAgICAgICAgIGlmIChsYWJlbElkKG5hbWUpKSBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgdGhyb3cgZXJyOwogICAgICB9CiAgICB9CiAgfQoKICAvLyBSZW5hbWVzIHRoZSBHbWFpbCBsYWJlbCBpbiBwbGFjZSwgc28gZXZlcnkgdGhyZWFkIHdlYXJpbmcgaXQgc3RheXMgcHV0LgogIC8vIElmIHRoZSBuZXcgbmFtZSBhbHJlYWR5IGV4aXN0cyBhcyBhIGRpZmZlcmVudCBsYWJlbCwgdGhlIGNvbHVtbiBzaW1wbHkKICAvLyBzd2l0Y2hlcyB0byB0aGF0IGxhYmVsIC0gcGF0Y2hpbmcgd291bGQgZmFpbCB3aXRoIGEgY29uZmxpY3QsIGFuZAogIC8vIHBvaW50aW5nIGEgY29sdW1uIGF0IGFuIGV4aXN0aW5nIGxhYmVsIGlzIGEgcmVhc29uYWJsZSB0aGluZyB0byB3YW50LgogIGFzeW5jIGZ1bmN0aW9uIHJlbmFtZUxhYmVsKG9sZE5hbWUsIG5ld05hbWUpIHsKICAgIGlmIChvbGROYW1lID09PSBuZXdOYW1lKSByZXR1cm4gJ3VuY2hhbmdlZCc7CiAgICBhd2FpdC",
"ByZWZyZXNoTGFiZWxzKCk7CiAgICBjb25zdCBvbGRJZCA9IGxhYmVsSWQob2xkTmFtZSk7CiAgICBjb25zdCBleGlzdGluZyA9IGxhYmVsSWQobmV3TmFtZSk7CiAgICBpZiAoZXhpc3RpbmcgJiYgZXhpc3RpbmcgIT09IG9sZElkKSByZXR1cm4gJ3JlcG9pbnRlZCc7CiAgICBpZiAoIW9sZElkKSByZXR1cm4gJ2NyZWF0ZWQtbGF0ZXInOwogICAgY29uc3QgdXBkYXRlZCA9IGF3YWl0IGFwaS5nbWFpbCgnUEFUQ0gnLCBgbGFiZWxzLyR7b2xkSWR9YCwgbnVsbCwgeyBuYW1lOiBuZXdOYW1lIH0pOwogICAgUy5sYWJlbHMuZGVsZXRlKG9sZE5hbWUudG9Mb3dlckNhc2UoKSk7CiAgICBTLmxhYmVscy5zZXQobmV3TmFtZS50b0xvd2VyQ2FzZSgpLCB1cGRhdGVkKTsKICAgIHJldHVybiAncmVuYW1lZCc7CiAgfQoKICAvLyDilIDilIAgVGhyZWFkcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gdGhyZWFkKGlkKSB7CiAgICByZXR1cm4gUy5tZXRhLmdldChpZCkgfHwgbnVsbDsKICB9CgogIC8vIEZldGNoZXMgbWV0YWRhdGEgb25seSBmb3IgdGhyZWFkcyB0aGF0IGFyZSBuZXcgdG8gdGhlIGNhY2hlIG9yIHdob3NlCiAgLy8gaGlzdG9yeU",
"lkIG1vdmVkLiBPbiBhIHdhcm0gcmVmcmVzaCBvZiBhbiB1bmNoYW5nZWQgYm9hcmQgdGhhdCBpcyB6ZXJvCiAgLy8gY2FsbHMgYmV5b25kIHRoZSBvbmUgbGlzdCBwZXIgY29sdW1uLgogIGFzeW5jIGZ1bmN0aW9uIGh5ZHJhdGUocmVmcywgYWNjb3VudCkgewogICAgY29uc3QgbmVlZCA9IHJlZnMuZmlsdGVyKHQgPT4gewogICAgICBjb25zdCBtID0gUy5tZXRhLmdldCh0LmlkKTsKICAgICAgcmV0dXJuICFtIHx8ICh0Lmhpc3RvcnlJZCAmJiBtLmhpc3RvcnlJZCAhPT0gU3RyaW5nKHQuaGlzdG9yeUlkKSk7CiAgICB9KTsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBhcGkuZ21haWxNYW55KG5lZWQubWFwKHQgPT4gWydHRVQnLCBgdGhyZWFkcy8ke3QuaWR9YCwgewogICAgICBmb3JtYXQ6ICdtZXRhZGF0YScsCiAgICAgIG1ldGFkYXRhSGVhZGVyczogWydTdWJqZWN0JywgJ0Zyb20nLCAnRGF0ZSddLAogICAgfV0pKTsKICAgIHJlc3VsdHMuZm9yRWFjaCgoZnVsbCwgaSkgPT4gewogICAgICAvLyBPbmUgdGhyZWFkIGRlbGV0ZWQgYmV0d2VlbiBsaXN0IGFuZCBnZXQgbXVzdCBub3Qgc2luayB0aGUgYm9hcmQuCiAgICAgIGlmIChmdWxsICYmIGZ1bGwuZXJyb3IpIHsKICAgICAgICBpZiAoaXNGYXRhbChmdWxsLmVycm9yKSkgdGhyb3cgZnVsbC5lcnJvcjsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKGZ1bGwpIFMubWV0YS5zZXQobmVlZFtpXS5pZCwgbG9naWMuc3VtbWFyaXNlVGhyZWFkKGZ1bG",
"wsIGFjY291bnQpKTsKICAgIH0pOwogIH0KCiAgLy8gQnJpbmdzIHRoZSBjb2x1bW5zJyBsYWJlbCBuYW1lcyBpbiBsaW5lIHdpdGggR21haWwgKGEgbGFiZWwgcmVuYW1lZAogIC8vIHRoZXJlIGlzIGZvbGxvd2VkIGJ5IGl0cyBpZCkgYW5kIHJlY29yZHMgaWRzIGZvciBsYWJlbHMgdGhhdCBoYXZlCiAgLy8gdGhlbS4gU2F2ZWQgb25seSB3aGVuIHNvbWV0aGluZyBjaGFuZ2VkLgogIGFzeW5jIGZ1bmN0aW9uIHN5bmNDb2x1bW5MYWJlbHMoYWNjb3VudCwgY29sdW1ucykgewogICAgY29uc3QgeyBjb2x1bW5zOiBuZXh0LCBjaGFuZ2VkIH0gPSBsb2dpYy5yZXNvbHZlQ29sdW1uTGFiZWxzKGNvbHVtbnMsIFsuLi5TLmxhYmVscy52YWx1ZXMoKV0pOwogICAgaWYgKGNoYW5nZWQpIGF3YWl0IHNhdmVDb2x1bW5zKGFjY291bnQsIG5leHQpOwogICAgcmV0dXJuIG5leHQ7CiAgfQoKICAvLyBFdmVyeXRoaW5nIHRoZSBib2FyZCBuZWVkcyBmb3Igb25lIHJlbmRlcjogcGVyLWNvbHVtbiB0aHJlYWQgaWRzCiAgLy8gKGVhY2ggdGhyZWFkIGluIGV4YWN0bHkgb25lIGNvbHVtbiksIHdoaWNoIGNvbHVtbnMgd2VyZSBjdXQgb2ZmLCBhbmQKICAvLyB0aGUgY29sdW1ucyB0aGVtc2VsdmVzLCBpbiBjYXNlIGEgbGFiZWwgd2FzIHJlbmFtZWQgaW4gR21haWwuCiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvYXJkKGFjY291bnQsIGNvbHVtbnNJbikgewogICAgLy8gTGV0IGFueSBtb3ZlIHN0aWxsIGluIGZsaWdodCBsYW5kIGZpcnN0LC",
"BvciB0aGUgbGlzdCBjb3VsZCBzaG93IHRoZQogICAgLy8gdGhyZWFkIGJhY2sgaW4gdGhlIGNvbHVtbiBpdCBpcyBsZWF2aW5nLgogICAgYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKFsuLi5TLnBlbmRpbmddKTsKICAgIC8vIFJlbmFtZXMgZmlyc3Q6IGVuc3VyaW5nIGxhYmVscyBieSB0aGVpciBzdGFsZSBuYW1lcyB3b3VsZCByZWNyZWF0ZQogICAgLy8gdGhlIG9sZCBvbmVzLCBlbXB0eS4KICAgIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKICAgIGxldCBjb2x1bW5zID0gYXdhaXQgc3luY0NvbHVtbkxhYmVscyhhY2NvdW50LCBjb2x1bW5zSW4pOwogICAgYXdhaXQgZW5zdXJlTGFiZWxzKGNvbHVtbnMubWFwKGMgPT4gYy5sYWJlbCkpOwogICAgY29sdW1ucyA9IGF3YWl0IHN5bmNDb2x1bW5MYWJlbHMoYWNjb3VudCwgY29sdW1ucyk7CgogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGFwaS5nbWFpbE1hbnkoY29sdW1ucy5tYXAoY29sID0-IFsnR0VUJywgJ3RocmVhZHMnLCB7IGxhYmVsSWRzOiBsYWJlbElkKGNvbC5sYWJlbCksIG1heFJlc3VsdHM6IDEwMCB9XSkpOwogICAgY29uc3QgZmFpbGVkID0gcmVzdWx0cy5maW5kKHIgPT4gciAmJiByLmVycm9yKTsKICAgIGlmIChmYWlsZWQpIHRocm93IGZhaWxlZC5lcnJvcjsKCiAgICBjb25zdCByYXcgPSB7fTsKICAgIGNvbnN0IHRydW5jYXRlZCA9IHt9OwogICAgY29uc3QgcmVmcyA9IG5ldyBNYXAoKTsKICAgIGNvbHVtbnMuZm9yRWFjaCgoY29sLCBpKSA9PiB7Ci",
"AgICAgIGNvbnN0IHIgPSByZXN1bHRzW2ldIHx8IHt9OwogICAgICBjb25zdCB0aHJlYWRzID0gci50aHJlYWRzIHx8IFtdOwogICAgICByYXdbY29sLmlkXSA9IHRocmVhZHMubWFwKHQgPT4gdC5pZCk7CiAgICAgIHRydW5jYXRlZFtjb2wuaWRdID0gISFyLm5leHRQYWdlVG9rZW47CiAgICAgIGZvciAoY29uc3QgdCBvZiB0aHJlYWRzKSByZWZzLnNldCh0LmlkLCB0KTsKICAgIH0pOwoKICAgIGF3YWl0IGh5ZHJhdGUoWy4uLnJlZnMudmFsdWVzKCldLCBhY2NvdW50KTsKICAgIGNvbnN0IGxpc3RzID0gbG9naWMuYXNzaWduQ29sdW1ucyhjb2x1bW5zLCByYXcpOwogICAgZm9yIChjb25zdCBpZCBvZiBPYmplY3Qua2V5cyhsaXN0cykpIGxpc3RzW2lkXSA9IGxpc3RzW2lkXS5maWx0ZXIodCA9PiBTLm1ldGEuaGFzKHQpKTsKICAgIGVtaXQoJ2JvYXJkLWxvYWRlZCcsIHt9KTsKICAgIHJldHVybiB7IGxpc3RzLCB0cnVuY2F0ZWQsIGNvbHVtbnMgfTsKICB9CgogIC8vIGBzb3VyY2VgIGxldHMgbGlzdGVuZXJzIGlnbm9yZSBlY2hvZXMgb2YgdGhlaXIgb3duIGNoYW5nZXM6IHRoZSBib2FyZAogIC8vIGhhcyBhbHJlYWR5IGRyYXduIGEgbW92ZSBpdCBtYWRlLCB0aGUgZG9jayBoYXMgbm90LgogIGFzeW5jIGZ1bmN0aW9uIG1vZGlmeSh0aHJlYWRJZCwgZGlmZiwgc291cmNlKSB7CiAgICBjb25zdCBwID0gYXBpLmdtYWlsKCdQT1NUJywgYHRocmVhZHMvJHt0aHJlYWRJZH0vbW9kaWZ5YCwgbnVsbCwgZGlmZik7CiAgIC",
"BTLnBlbmRpbmcuYWRkKHApOwogICAgdHJ5IHsKICAgICAgYXdhaXQgcDsKICAgIH0gZmluYWxseSB7CiAgICAgIFMucGVuZGluZy5kZWxldGUocCk7CiAgICB9CiAgICAvLyBNYXJrIHRoZSBjYWNoZWQgc3VtbWFyeSBzdGFsZSBzbyB0aGUgbmV4dCByZWZyZXNoIHJlLXJlYWRzIGl0LCBhbmQKICAgIC8vIGtlZXAgaXRzIGxhYmVsIHNldCBob25lc3QgaW4gdGhlIG1lYW50aW1lLgogICAgY29uc3QgbSA9IFMubWV0YS5nZXQodGhyZWFkSWQpOwogICAgaWYgKG0pIHsKICAgICAgbS5oaXN0b3J5SWQgPSAnJzsKICAgICAgY29uc3QgbGFiZWxzID0gbmV3IFNldChtLmxhYmVsSWRzKTsKICAgICAgZGlmZi5yZW1vdmVMYWJlbElkcy5mb3JFYWNoKGlkID0-IGxhYmVscy5kZWxldGUoaWQpKTsKICAgICAgZGlmZi5hZGRMYWJlbElkcy5mb3JFYWNoKGlkID0-IGxhYmVscy5hZGQoaWQpKTsKICAgICAgbS5sYWJlbElkcyA9IFsuLi5sYWJlbHNdOwogICAgfQogICAgZW1pdCgndGhyZWFkLWNoYW5nZWQnLCB7IHRocmVhZElkLCBzb3VyY2UgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBtb3ZlVG9Db2x1bW4odGhyZWFkSWQsIGNvbHVtbnMsIGNvbHVtbklkLCBzb3VyY2UpIHsKICAgIGF3YWl0IGVuc3VyZUxhYmVscyhjb2x1bW5zLm1hcChjID0-IGMubGFiZWwpKTsKICAgIGF3YWl0IG1vZGlmeSh0aHJlYWRJZCwgbG9naWMubW92ZUxhYmVsRGlmZihjb2x1bW5zLCBjb2x1bW5JZCwgbGFiZWxJZCksIHNvdXJjZSk7CiAgfQoKIC",
"AvLyBUYWtpbmcgYSBjYXJkIG9mZiB0aGUgYm9hcmQgYWxzbyBmb3JnZXRzIGl0cyB0aXRsZSwgbm90ZSBhbmQgY29sb3VyLgogIC8vIEVkaXRzIHdvdWxkIG90aGVyd2lzZSBvdXRsaXZlIHRoZWlyIGNhcmQsIGFuZCBzeW5jJ3MgcXVvdGEgaXMgc21hbGwKICAvLyBlbm91Z2ggdGhhdCBsZWZ0b3ZlcnMgd291bGQgZXZlbnR1YWxseSBjcm93ZCBvdXQgdGhlIG9uZXMgaW4gdXNlLiBBCiAgLy8gY2FyZCB0aGF0IG1lcmVseSBtb3ZlcyB0byBEb25lIGtlZXBzIHRoZW0uCiAgYXN5bmMgZnVuY3Rpb24gcmVtb3ZlRnJvbUJvYXJkKHRocmVhZElkLCBjb2x1bW5zLCBzb3VyY2UsIGFjY291bnQpIHsKICAgIGlmICghUy5sYWJlbHNBdCkgYXdhaXQgcmVmcmVzaExhYmVscygpOwogICAgYXdhaXQgbW9kaWZ5KHRocmVhZElkLCBsb2dpYy5yZW1vdmVMYWJlbERpZmYoY29sdW1ucywgbGFiZWxJZCksIHNvdXJjZSk7CiAgICBpZiAoYWNjb3VudCkgYXdhaXQgc2F2ZUNhcmRFZGl0KGFjY291bnQsIHRocmVhZElkLCBudWxsKS5jYXRjaCgoKSA9PiB7fSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBzZWFyY2godGV4dCwgYWNjb3VudCkgewogICAgY29uc3QgciA9IGF3YWl0IGFwaS5nbWFpbCgnR0VUJywgJ3RocmVhZHMnLCB7IHE6IGxvZ2ljLnNlYXJjaFF1ZXJ5KHRleHQpLCBtYXhSZXN1bHRzOiAxNSB9KTsKICAgIGNvbnN0IHJlZnMgPSByLnRocmVhZHMgfHwgW107CiAgICBhd2FpdCBoeWRyYXRlKHJlZnMsIGFjY291bnQpOwogIC",
"AgcmV0dXJuIHJlZnMubWFwKHQgPT4gdC5pZCkuZmlsdGVyKGlkID0-IFMubWV0YS5oYXMoaWQpKTsKICB9CgogIC8vIFdoaWNoIGNvbHVtbiAoaWYgYW55KSBhIHNpbmdsZSB0aHJlYWQgaXMgaW4gLSBmb3IgdGhlIGRvY2ssIHdoaWNoIGhhcwogIC8vIG5vIGJvYXJkIGxvYWRlZC4gZm9ybWF0PW1pbmltYWwgaXMgdGhlIGNoZWFwZXN0IGNhbGwgdGhhdCByZXR1cm5zCiAgLy8gbGFiZWwgaWRzLgogIGFzeW5jIGZ1bmN0aW9uIHRocmVhZENvbHVtbih0aHJlYWRJZCwgY29sdW1ucykgewogICAgaWYgKCFTLmxhYmVsc0F0KSBhd2FpdCByZWZyZXNoTGFiZWxzKCk7CiAgICBjb25zdCB0ID0gYXdhaXQgYXBpLmdtYWlsKCdHRVQnLCBgdGhyZWFkcy8ke3RocmVhZElkfWAsIHsgZm9ybWF0OiAnbWluaW1hbCcgfSk7CiAgICBjb25zdCBsYWJlbHMgPSAodC5tZXNzYWdlcyB8fCBbXSkuZmxhdE1hcChtID0-IG0ubGFiZWxJZHMgfHwgW10pOwogICAgcmV0dXJuIGxvZ2ljLmNvbHVtbkZvckxhYmVscyhjb2x1bW5zLCBsYWJlbHMsIGxhYmVsSWQpOwogIH0KCiAgbnMuc3RvcmUgPSB7CiAgICBidXMsIGxvYWRDb2x1bW5zLCBzYXZlQ29sdW1ucywgbG9hZE9yZGVyLCBzYXZlT3JkZXIsIGxvYWRDYXJkRWRpdHMsIHNhdmVDYXJkRWRpdCwgbG9hZERvY2tQb3NpdGlvbiwKICAgIHJlZnJlc2hMYWJlbHMsIGVuc3VyZUxhYmVscywgcmVuYW1lTGFiZWwsIGxhYmVsSWQsIGFsbExhYmVscywKICAgIHRocmVhZCwgbG9hZEJvYXJkLCBtb3",
"ZlVG9Db2x1bW4sIHJlbW92ZUZyb21Cb2FyZCwgc2VhcmNoLCB0aHJlYWRDb2x1bW4sCiAgfTsKfSkoKTsK\"],[\"addon/app/remote-board.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyBmaXJzdCBjb2x1bW4gbGF5b3V0Ci8vCi8vIFRoZSBib2FyZCBrZWVwcyBpdHMgY29sdW1uIGxheW91dCBpbiBpdHMgc3luY2VkIHNldHRpbmdzLCB3aGljaCBoZXJlCi8vIGFyZSB0aGUgYXBwJ3Mgb3duLiBVbnRpbCBpdCBoYXMgb25lLCB0aGUgZXh0ZW5zaW9uJ3MgZGVmYXVsdCBjb2x1bW5zCi8vIHdvdWxkIGJyaW5nIGJhY2sgIl9Cb2FyZC9XYWl0aW5nIiBhcyBhIGZyZXNoLCBlbXB0eSBsYWJlbCBmb3Igc29tZW9uZQovLyB3aG9zZSBjb2x1bW4gaXMgIl9Cb2FyZC9XYWl0aW5nIG9uIG90aGVycyI7IHNvIHRoZSBmaXJzdCBsYXlvdXQgaXMKLy8gdGhlIGJvYXJkJ3MgbGFiZWxzIGFzIEdtYWlsIGhhcyB0aGVtIC0gYXMgdGhlIHBob25lIHBhbmVsIHJlYWRzIHRoZW0uCi8vIFdpdGggbm8gYm9hcmQgbGFiZWxzIGF0IGFsbCwgdGhlIHVzdWFsIGNvbHVtbnMsI",
"G1hZGUgYXMgaW4gQ2hyb21lLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IGdsb2JhbFRoaXMuZ2tiOwogIGNvbnN0IHsgc3RvcmUsIGxvZ2ljLCBLRVlTIH0gPSBuczsKICBjb25zdCBzYXZlZCA9IHN0b3JlLmxvYWRDb2x1bW5zOwoKICBzdG9yZS5sb2FkQ29sdW1ucyA9IGFzeW5jIGFjY291bnQgPT4gewogICAgY29uc3Qga2V5ID0gS0VZUy5jb2x1bW5zKGFjY291bnQpOwogICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLmdldChrZXkpKVtrZXldKSByZXR1cm4gc2F2ZWQoYWNjb3VudCk7CiAgICBjb25zdCBmcm9tTGFiZWxzID0gYXdhaXQgbnMuYXBwUmVtb3RlLmNhbGwoJ2FwcEJvYXJkQ29sdW1ucycpOwogICAgcmV0dXJuIGxvZ2ljLm5vcm1hbGlzZUNvbHVtbnMoZnJvbUxhYmVscyB8fCB1bmRlZmluZWQpOwogIH07Cn0pKCk7Cg\"],[\"src/content/notes.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBub3RlcyB2aWV3Ci8vCi8vIFRoZSBib2FyZCdzIHNlY29uZCB0YWI6IGZvbGRlcnMgb24gdGhlIGxlZnQsIHRoZW4gdGhlIG5vdGVzIGluIHRoZQovLyBjaG9zZW4gZm9sZGVyLCB0aGVuIHRoZSBvcGVuIG5vdGUuIFR5cGluZyBzYXZlcyBieSBpdHNlbGYgYSBtb21lbnQgYWZ0ZXIKLy8geW91IHN0b3AsIGFuZCBhZ2FpbiBvbiBzd2l0Y2hpbmcgbm90ZXMsIHN3aXRjaGluZyB0YWJzIG9yIGNsb3Npbmc7Ci8vIEN0cmwrUyBzYXZlcyBhdCBvbmNlLiBBIG5vdGUgbW92ZXMgdG8gYW5vdGhlciBmb2xkZXIgYnkgZHJhZ2dpbmcgaXQgb250bwovLyBvbmUsIG9yIGZyb20gdGhlIGZvbGRlciBidXR0b24gYWJvdmUgdGhlIHRleHQuCi8vCi8vIFRoZSBib2FyZCBvd25zIHRoZSBvdmVybGF5LCB0aGUgaGVhZGVyIGFuZCB0aGUgYWNjb3VudCBwYW5lbHMgKHNldHVwLAovLyBjb25uZWN0KTsgdGhpcyBmaWxlIG93bnMgZXZlcnl0aGluZyBpbnNpZGUgdGhlIGJvZHkgd2hpbGUgdGhlIE5vdGVzIHRhYgovLyBpcyBzaG93aW5nLiBJdHMgZWxlbWVudCBpcyBidWlsdCBvbmNlIGFuZCBrZXB0LCBzbyB0aGF0IGEgYm9hcmQgcmVkcmF3Ci8vIG5ldmVyIHB1bGxzIHRoZSB0ZXh",
"0IGJveCBvdXQgZnJvbSB1bmRlciBzb21lb25lIHdobyBpcyB0eXBpbmcuCi8vCi8vIFRoZSBzY3JhdGNocGFkIGlzIHRoZSBub3RlIHRoYXQgaXMgb3BlbiB3aGVuZXZlciBubyBvdGhlciBvbmUgaXM6IG9uZQovLyBub3RlIHdpdGggYSBmaXhlZCBpZCwgc2hhcmVkIGJ5IGV2ZXJ5IGNvbXB1dGVyIGFuZCBwaG9uZSwgdGhlcmUgdG8gdHlwZQovLyBpbnRvIHRoZSBtb21lbnQgdGhlIG5vdGVzIGFwcGVhci4gSXQgaXMgcGlubmVkIGF0IHRoZSB0b3Agb2YgdGhlIGxpc3QsCi8vIGFuZCBjYW5ub3QgYmUgcmVuYW1lZCwgbW92ZWQgb3IgZGVsZXRlZC4KLy8KLy8gVGhlIHBob25lIGFwcCAoYWRkb24vYXBwKSBydW5zIHRoaXMgc2FtZSB2aWV3IGZ1bGwtc2NyZWVuIG9uIGEgcGhvbmUsCi8vIHdpdGggYSBkaWZmZXJlbnQgd2F5IHRvIEdtYWlsIGJlaGluZCBub3Rlc1N0b3JlLiBBIHBob25lIHNob3dzIG9uZQovLyB0aGluZyBhdCBhIHRpbWUsIGFuZCB0aGUgZWxlbWVudCBzYXlzIHdoaWNoIChkYXRhLXZpZXcpOiAiaG9tZSIsIHRoZQovLyBzZWFyY2ggYm94IGFuZCB0aGUgc2NyYXRjaHBhZDsgImxpc3QiLCB0aGUgbm90ZXMgaW4gYSBmb2xkZXIgb3IgYQovLyBzZWFyY2g7IG9yICJub3RlIiwgYSBub3RlIGZ1bGwtc2NyZWVuLiBUaGUgbm90ZSdzIEJhY2sgYnV0dG9uIGFuZCB0aGUKLy8gZm9sZGVyIHRyZWUncyBidXR0b24gb25seSBzaG93IGluIHRoZSBwaG9uZSdzIHN0eWxlc2hlZXQuCi8vIOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgdG9hc3QsIG9wZW5NZW51IH0gPSBucy51aTsKICBjb25zdCB7IHV0aWwsIG5vdGVzTG9naWMsIG5vdGVzU3RvcmUsIGhvb2tzLCBhcGkgfSA9IG5zOwogIGNvbnN0IGZtdCA9IG5zLm5vdGVGb3JtYXQ7CiAgY29uc3Qgc2VhcmNoTG9naWMgPSBucy5zZWFyY2hMb2dpYzsKCiAgLy8gSG93IG1hbnkgc2VhcmNoIHJlc3VsdHMgZ2V0IGV4Y2VycHRzIGF0IG9uY2UuIEVhY2ggbmVlZHMgdGhlIG5vdGUncwogIC8vIGZ1bGwgdGV4dCwgd2hpY2ggaXMgb25lIG1vcmUgcmVxdWVzdCB0aGUgZmlyc3QgdGltZS4KICBjb25zdCBFWENFUlBUX0xJTUlUID0gMzA7CgogIC8vIExvbmcgZW5vdWdoIG5vdCB0byBzYXZlIG1pZC1zZW50ZW5jZSAoZWFjaCBzYXZlIGlzIGEgbmV3IG1lc3NhZ2UgYW5kCiAgLy8gYSB0cmFzaGVkIG9sZCBvbmUpLCBzaG9ydCBlbm91Z2ggdGhhdCBsaXR0bGUgaXMgYXQgcmlzay4",
"KICBjb25zdCBBVVRPU0FWRV9NUyA9IDI1MDA7CiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CgogIGNvbnN0IFNDUkFUQ0hfS0VZID0gYG46JHtub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfSUR9YDsKCiAgY29uc3QgTiA9IHsKICAgIGN0eDogbnVsbCwgICAgICAgICAgLy8geyByb290LCBvblN0YXRlRXJyb3IsIG9uTG9hZGVkLCBjbG9zZUJvYXJkLCBiYXJDaGFuZ2VkIH0KICAgIG5vdGVzOiBbXSwgICAgICAgICAgLy8gbGl2ZSBub3RlcywgbmV3ZXN0IGZpcnN0IChtZXRhZGF0YSBvbmx5KQogICAgdHJ1bmNhdGVkOiBmYWxzZSwKICAgIHF1ZXJ5OiAnJywKICAgIHN0YXR1czogJ2lkbGUnLCAgICAgLy8gaWRsZSB8IGxvYWRpbmcgfCByZWFkeSB8IGVycm9yCiAgICBlcnJvcjogJycsCiAgICBsb2FkZWRBdDogMCwKICAgIGxvYWRpbmc6IG51bGwsCiAgICBjdXJyZW50OiBudWxsLCAgICAgIC8vIHRoZSBub3RlIGJlaW5nIGVkaXRlZCAtIHNlZSBuZXdDdXJyZW50KCk7IHRoZSBzY3JhdGNocGFkIHdoZW4gbm8gb3RoZXIgaXMKICAgIHNjcmF0Y2hOb3RlOiBudWxsLCAgLy8gdGhlIHNjcmF0Y2hwYWQncyBtZXNzYWdlLCBvbmNlIGxpc3RlZCAobnVsbDogbmV2ZXIgc2F2ZWQgeWV0KQogICAgc2NyYXRjaEtub3duOiBmYWxzZSwgLy8gd2hldGhlciB0aGUgbGlzdGluZyBoYXMgc2FpZCBpZiB0aGVyZSBpcyBvbmUKICAgIGJyb3dzaW5nOiBmYWxzZSwgICAgLy8gYSBwaG9uZTogdGhlIGxpc3QgaXMgc2hvd2luZywgcmF",
"0aGVyIHRoYW4gdGhlIHNjcmF0Y2hwYWQKICAgIHdhbnRGb2N1czogZmFsc2UsICAgLy8gcHV0IHRoZSBjdXJzb3IgaW4gdGhlIHNjcmF0Y2hwYWQgb25jZSBpdCBpcyByZWFkeQogICAgY2hhaW46IFByb21pc2UucmVzb2x2ZSgpLCAvLyBzYXZlcyBhbmQgbW92ZXMgcnVuIG9uZSBhZnRlciBhbm90aGVyCiAgICBmb2xkZXJzOiBbXSwgICAgICAgIC8vIG5vdGVzTG9naWMuZm9sZGVyVHJlZSgpLCBmcm9tIHRoZSBsYXN0IGxpc3RpbmcKICAgIGZvbGRlcjogJycsICAgICAgICAgLy8gdGhlIGZvbGRlciBzaG93bjsgJycgZm9yIGFsbCBub3RlcwogICAgZm9sZGVyRWRpdDogbnVsbCwgICAvLyB7IG1vZGU6ICduZXcnIHwgJ3JlbmFtZScsIHBhcmVudElkLCBmb2xkZXJJZCwgdmFsdWUsIGVycm9yLCBidXN5IH0KICAgIGZvbGRlZDogbmV3IFNldCgpLCAgLy8gZm9sZGVycyB3aG9zZSBzdWJmb2xkZXJzIGFyZSBmb2xkZWQgYXdheQogICAgZm9sZGVkUmVhZDogZmFsc2UsICAvLyB0aGUgc2F2ZWQgc2V0IGhhcyBiZWVuIGFza2VkIGZvcgogICAgZHJhZ0tleTogJycsICAgICAgICAvLyB0aGUgbm90ZSBiZWluZyBkcmFnZ2VkIG9udG8gYSBmb2xkZXIKICAgIHRlcm1zOiBbXSwgICAgICAgICAgLy8gc2VhcmNoTG9naWMucXVlcnlUZXJtcygpIG9mIHRoZSBzZWFyY2ggdGhhdCBpcyBzaG93aW5nCiAgICBoaXRzOiBuZXcgTWFwKCksICAgIC8vIGAke21lc3NhZ2VJZH18JHt0ZXJtc31gIOKGkiB7IGNvdW50LCBleGNlcnB0cyB",
"9CiAgICBmaW5kSW5kZXg6IDAsICAgICAgIC8vIHdoaWNoIG1hdGNoIGluIHRoZSBvcGVuIG5vdGUgaXMgdGhlIGN1cnJlbnQgb25lCiAgfTsKCiAgbGV0IHNhdmVUaW1lciA9IDA7CiAgbGV0IHNlYXJjaFRpbWVyID0gMDsKICBsZXQgZmluZFRpbWVyID0gMDsKICBjb25zdCBlbHMgPSB7fTsKCiAgLy8g4pSA4pSAIFNldHVwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBpbml0KGN0eCkgewogICAgTi5jdHggPSBjdHg7CiAgICBOLnZpZXcgPSAnJzsKICAgIC8vIENsb3NpbmcgdGhlIHRhYiBtaWQtc2VudGVuY2Ugd291bGQgbG9zZSB0aGUgbGFzdCBmZXcgc2Vjb25kcyBvZgogICAgLy8gdHlwaW5nOyB0aGUgYnJvd3NlcidzIG93biAiTGVhdmUgc2l0ZT8iIHByb21wdCBpcyB0aGUgb25seSBkZWZlbmNlLgogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2JlZm9yZXVubG9hZCcsIGUgPT4gewogICAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgICBpZiAoYyAmJiAoYy5kaXJ0eSB8fCBjLnNhdmluZykpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgZS5yZXR1cm5WYWx1ZSA9ICcnOwogICAgICB",
"9CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGVsZW1lbnQoKSB7CiAgICBpZiAoZWxzLndyYXApIHJldHVybiBlbHMud3JhcDsKCiAgICBlbHMuc2VhcmNoID0gaCgnaW5wdXQnLCB7CiAgICAgIHR5cGU6ICdzZWFyY2gnLCBwbGFjZWhvbGRlcjogJ1NlYXJjaCBub3RlcycsICdhcmlhLWxhYmVsJzogJ1NlYXJjaCBub3RlcycsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZXMtc2VhcmNoJyB9LAogICAgICBvbmlucHV0OiBlID0-IHsKICAgICAgICBOLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7CiAgICAgICAgLy8gT24gYSBwaG9uZSwgYSBzZWFyY2ggc2hvd3MgdGhlIGxpc3QgaW4gcGxhY2Ugb2YgdGhlIHNjcmF0Y2hwYWQuCiAgICAgICAgaWYgKE4ucXVlcnkudHJpbSgpICYmICFOLmJyb3dzaW5nKSB7IE4uYnJvd3NpbmcgPSB0cnVlOyBzZXRWaWV3KCk7IH0KICAgICAgICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgICAgIHNlYXJjaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBsb2FkKHsgZm9yY2U6IHRydWUgfSksIDQwMCk7CiAgICAgIH0sCiAgICAgIG9ua2V5ZG93bjogZSA9PiB7CiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInKSB7IGUucHJldmVudERlZmF1bHQoKTsgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVyKTsgbG9hZCh7IGZvcmNlOiB0cnVlIH0pOyB9CiAgICAgIH0sCiAgICB9KTsKICAgIGVscy5pdGVtcyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1pdGVtcycsIHJvbGU6ICdsaXN",
"0JywgJ2FyaWEtbGFiZWwnOiAnTm90ZXMnIH0pOwogICAgZWxzLmZvb3QgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtZm9vdCcgfSk7CiAgICBlbHMuc2NvcGUgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtc2NvcGUnIH0pOwoKICAgIGVscy5saXN0ID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdub3Rlcy1saXN0JywgJ2FyaWEtbGFiZWwnOiAnTm90ZXMnIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy10b29scycgfSwKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoLWJveCcgfSwgaWNvbignc2VhcmNoJywgMTgpLCBlbHMuc2VhcmNoKSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2J0biBidG4tdG9uYWwnLCB0eXBlOiAnYnV0dG9uJywgZGF0YXNldDogeyBrZXk6ICdub3RlLW5ldycgfSwKICAgICAgICAgIHRpdGxlOiAnTmV3IG5vdGUnLCBvbmNsaWNrOiAoKSA9PiBuZXdOb3RlKCksCiAgICAgICAgfSwgaWNvbignYWRkJywgMTgpLCAnTmV3JykpLAogICAgICBlbHMuc2NvcGUsCiAgICAgIGVscy5pdGVtcywKICAgICAgZWxzLmZvb3QpOwoKICAgIGVscy5mb2xkZXJJdGVtcyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdmb2xkZXItaXRlbXMnLCByb2xlOiAnbGlzdCcsICdhcmlhLWxhYmVsJzogJ0ZvbGRlcnMnIH0pOwogICAgLy8gT24gYSBwaG9uZSB0aGUgdHJlZSBmb2xkcyBhd2F5IGJlaGluZCBvbmUgYnV0dG9uIHRoYXQgc2F5cyB3aGVyZQogICAgLy8geW9",
"1IGFyZTsgb25seSB0aGUgcGhvbmUncyBzdHlsZXNoZWV0IHNob3dzIGl0LgogICAgZWxzLmZvbGRlcnNUb2dnbGUgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnZm9sZGVycy10b2dnbGUnLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtZXhwYW5kZWQnOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogJ2ZvbGRlcnMtdG9nZ2xlJyB9LAogICAgICBvbmNsaWNrOiAoKSA9PiBzZXRGb2xkZXJzT3BlbihlbHMud3JhcC5kYXRhc2V0LmZvbGRlcnMgIT09ICdvcGVuJyksCiAgICB9KTsKICAgIGVscy5mb2xkZXJzUGFuZSA9IGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiAnbm90ZXMtZm9sZGVycycsICdhcmlhLWxhYmVsJzogJ0ZvbGRlcnMnIH0sCiAgICAgIGVscy5mb2xkZXJzVG9nZ2xlLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZm9sZGVycy1oZWFkJyB9LAogICAgICAgIGgoJ2gyJywgeyB0ZXh0OiAnRm9sZGVycycgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCB0aXRsZTogJ05ldyBmb2xkZXInLCAnYXJpYS1sYWJlbCc6ICdOZXcgZm9sZGVyJywKICAgICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnZm9sZGVyLW5ldycgfSwgb25jbGljazogKCkgPT4gc3RhcnRGb2xkZXJFZGl0KHsgbW9kZTogJ25ldycsIHBhcmVudElkOiAnJyB9KSwKICAgICAgICB9LCBpY29uKCdhZGQnLCAyMCkpKSwKICAgICAgZWxzLmZvbGRlckl0ZW1zKTsKCiAgICBlbHM",
"uZWRpdG9yID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdub3RlLWVkaXRvcicsICdhcmlhLWxhYmVsJzogJ05vdGUnIH0pOwogICAgZWxzLndyYXAgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMnLCBkYXRhc2V0OiB7IGZvbGRlcnM6ICdjbG9zZWQnIH0gfSwgZWxzLmZvbGRlcnNQYW5lLCBlbHMubGlzdCwgZWxzLmVkaXRvcik7CiAgICBpZiAoIU4uY3VycmVudCkgTi5jdXJyZW50ID0gcGVuZGluZ1NjcmF0Y2goKTsKICAgIGRyYXdGb2xkZXJzKCk7CiAgICBkcmF3TGlzdCgpOwogICAgZHJhd0VkaXRvcigpOwogICAgcmV0dXJuIGVscy53cmFwOwogIH0KCiAgLy8g4pSA4pSAIExvYWRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGlzU3RhbGUoKSB7CiAgICByZXR1cm4gTi5zdGF0dXMgIT09ICdyZWFkeScgfHwgRGF0ZS5ub3coKSAtIE4ubG9hZGVkQXQgPiBTVEFMRV9NUzsKICB9CgogIGZ1bmN0aW9uIGxvYWQoeyBmb3JjZSA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKE4ubG9hZGluZykgcmV0dXJuIE4ubG9hZGluZzsKICAgIGlmICghZm9yY2UgJiYgIWlzU3RhbGUoKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOwogICA",
"gY29uc3QgcXVlcnkgPSBOLnF1ZXJ5OwogICAgaWYgKCFOLm5vdGVzLmxlbmd0aCkgTi5zdGF0dXMgPSAnbG9hZGluZyc7CiAgICBkcmF3TGlzdCgpOwoKICAgIE4ubG9hZGluZyA9IChhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgZm9sZGVkID0gTi5mb2xkZWRSZWFkID8gbnVsbCA6IHJlYWRGb2xkZWQoKTsKICAgICAgICBjb25zdCByID0gYXdhaXQgbm90ZXNTdG9yZS5saXN0KGhvb2tzLmdldEFjY291bnQoKSwgcXVlcnkpOwogICAgICAgIGlmIChmb2xkZWQpIGF3YWl0IGZvbGRlZDsKICAgICAgICBpZiAocXVlcnkgIT09IE4ucXVlcnkpIHJldHVybjsgLy8gYSBuZXdlciBzZWFyY2ggaGFzIHN0YXJ0ZWQKICAgICAgICBsZXQgc2NyYXRjaCA9IHIubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBTQ1JBVENIX0tFWSkgfHwgbnVsbDsKICAgICAgICAvLyBOb3QgYW1vbmcgdGhlIG5ld2VzdCBodW5kcmVkOiBhc2sgR21haWwgZm9yIGl0IGJ5IG5hbWUsIHJhdGhlcgogICAgICAgIC8vIHRoYW4gc3RhcnQgYSBzZWNvbmQgb25lIHRoYXQgd291bGQgcHVzaCB0aGUgZmlyc3QgaW50byBUcmFzaC4KICAgICAgICBpZiAoIXNjcmF0Y2ggJiYgIXF1ZXJ5ICYmIHIudHJ1bmNhdGVkKSB7CiAgICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IG5vdGVzU3RvcmUubGlzdChob29rcy5nZXRBY2NvdW50KCksIG5vdGVzTG9naWMuU0NSQVRDSFBBRF9USVRMRSk7CiAgICAgICAgICBzY3JhdGNoID0gZm91bmQ",
"ubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBTQ1JBVENIX0tFWSkgfHwgbnVsbDsKICAgICAgICAgIGlmIChxdWVyeSAhPT0gTi5xdWVyeSkgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBpZiAoc2NyYXRjaCB8fCAhcXVlcnkpIHsKICAgICAgICAgIE4uc2NyYXRjaE5vdGUgPSBzY3JhdGNoOwogICAgICAgICAgTi5zY3JhdGNoS25vd24gPSB0cnVlOwogICAgICAgIH0KICAgICAgICBOLm5vdGVzID0gci5ub3RlczsKICAgICAgICBOLnRydW5jYXRlZCA9IHIudHJ1bmNhdGVkOwogICAgICAgIE4uZm9sZGVycyA9IHIuZm9sZGVycyB8fCBbXTsKICAgICAgICBjb25zdCB0ZXJtcyA9IHNlYXJjaExvZ2ljLnF1ZXJ5VGVybXMocXVlcnkpOwogICAgICAgIGlmIChKU09OLnN0cmluZ2lmeSh0ZXJtcykgIT09IEpTT04uc3RyaW5naWZ5KE4udGVybXMpKSBOLmZpbmRJbmRleCA9IDA7CiAgICAgICAgTi50ZXJtcyA9IHRlcm1zOwogICAgICAgIC8vIFRoZSBmb2xkZXIgc2hvd24gd2FzIGRlbGV0ZWQgb3IgcmVuYW1lZCBhd2F5IGluIEdtYWlsLgogICAgICAgIGlmIChOLmZvbGRlciAmJiAhTi5mb2xkZXJzLnNvbWUoZiA9PiBmLmlkID09PSBOLmZvbGRlcikpIE4uZm9sZGVyID0gJyc7CiAgICAgICAgTi5zdGF0dXMgPSAncmVhZHknOwogICAgICAgIE4uZXJyb3IgPSAnJzsKICAgICAgICBOLmxvYWRlZEF0ID0gRGF0ZS5ub3coKTsKICAgICAgICBjYXRjaFVwQ3VycmVudCgpOwogICAgICAgIC8vIFRoZSBzY3JhdGNocGFkIHd",
"hcyB3YWl0aW5nIGZvciB0aGUgbGlzdCB0byBzYXkgd2hldGhlciBpdCBleGlzdHMuCiAgICAgICAgaWYgKE4uY3VycmVudCAmJiBOLmN1cnJlbnQuc2NyYXRjaCAmJiBOLmN1cnJlbnQuYm9keVN0YXRlICE9PSAncmVhZHknICYmIE4uc2NyYXRjaEtub3duKSBzaG93U2NyYXRjaCgpOwogICAgICAgIE4uY3R4Lm9uTG9hZGVkKCk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgewogICAgICAgICAgTi5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgICBOLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgTi5zdGF0dXMgPSBOLm5vdGVzLmxlbmd0aCA_ICdyZWFkeScgOiAnZXJyb3InOwogICAgICAgIE4uZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgICAgIGlmIChjICYmIGMuc2NyYXRjaCAmJiBjLmJvZHlTdGF0ZSA9PT0gJ2xvYWRpbmcnICYmICFOLnNjcmF0Y2hLbm93bikgewogICAgICAgICAgYy5ib2R5U3RhdGUgPSAnZXJyb3InOwogICAgICAgICAgYy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgICAgICAgZHJhd0VkaXRvcigpOwogICAgICAgIH0KICAgICAgICBpZiAoTi5ub3Rlcy5sZW5ndGgpIHRvYXN0KE4uY3R4LnJvb3QsIGBDb3VsZG7igJl0IGxvYWQgbm90ZXM6ICR7ZXJyLm1lc3NhZ2V9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogICA",
"gICB9IGZpbmFsbHkgewogICAgICAgIE4ubG9hZGluZyA9IG51bGw7CiAgICAgICAgZHJhd0ZvbGRlcnMoKTsKICAgICAgICBkcmF3TGlzdCgpOwogICAgICAgIGRyYXdGb290KCk7CiAgICAgICAgaWYgKE4uY3VycmVudCkgZHJhd0JhcigpOwogICAgICAgIGFwcGx5SGlnaGxpZ2h0cygpOwogICAgICAgIGZldGNoSGl0cygpOwogICAgICAgIE4uY3R4LmJhckNoYW5nZWQoKTsKICAgICAgfQogICAgfSkoKTsKICAgIC8vIFRoZSBzZWFyY2ggYm94IGNoYW5nZWQgd2hpbGUgdGhpcyB3YXMgaW4gZmxpZ2h0LCBhbmQgdGhlIGxvYWQgdGhhdAogICAgLy8gY2hhbmdlIGFza2VkIGZvciB3YXMgdHVybmVkIGF3YXkgYWJvdmU6IHJ1biBpdCBub3cuCiAgICBjb25zdCBwID0gTi5sb2FkaW5nOwogICAgcmV0dXJuIHAudGhlbigoKSA9PiAocXVlcnkgIT09IE4ucXVlcnkgPyBsb2FkKHsgZm9yY2U6IHRydWUgfSkgOiB1bmRlZmluZWQpKTsKICB9CgogIC8vIFRoZSBvcGVuIG5vdGUgd2FzIHNhdmVkIG9uIGFub3RoZXIgY29tcHV0ZXIgc2luY2UgaXQgd2FzIG9wZW5lZCBoZXJlOgogIC8vIHNob3cgdGhlIG5ld2VyIHRleHQsIHVubGVzcyB0aGVyZSBhcmUgZWRpdHMgaGVyZSB0aGF0IHdvdWxkIGJlIGxvc3QuCiAgZnVuY3Rpb24gY2F0Y2hVcEN1cnJlbnQoKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFjIHx8IGMuZGlydHkgfHwgYy5zYXZpbmcpIHJldHVybjsKICAgIC8vIEEgc2NyYXRjaHBhZCBuZXZlciB",
"zYXZlZCBoZXJlLCB3aGljaCBhbm90aGVyIGNvbXB1dGVyIGhhcyBzaW5jZSBzdGFydGVkLgogICAgaWYgKGMuc2NyYXRjaCAmJiAhYy5ub3RlICYmIGMuYm9keVN0YXRlID09PSAncmVhZHknICYmIE4uc2NyYXRjaE5vdGUpIHsgb3Blbk5vdGUoTi5zY3JhdGNoTm90ZSwgeyBmb3JjZTogdHJ1ZSB9KTsgcmV0dXJuOyB9CiAgICBpZiAoIWMubm90ZSkgcmV0dXJuOwogICAgY29uc3QgZnJlc2ggPSBOLm5vdGVzLmZpbmQobiA9PiBuLmtleSA9PT0gYy5rZXkpOwogICAgaWYgKGZyZXNoICYmIGZyZXNoLm1lc3NhZ2VJZCAhPT0gYy5ub3RlLm1lc3NhZ2VJZCkgb3Blbk5vdGUoZnJlc2gsIHsgZm9yY2U6IHRydWUgfSk7CiAgfQoKICAvLyDilIDilIAgVGhlIGxpc3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGZvbGRlckJ5SWQoaWQpIHsKICAgIHJldHVybiBOLmZvbGRlcnMuZmluZChmID0-IGYuaWQgPT09IGlkKSB8fCBudWxsOwogIH0KCiAgLy8gIldvcmsg4oC6IENsaWVudHMiCiAgZnVuY3Rpb24gZm9sZGVyTGFiZWwoaWQpIHsKICAgIGNvbnN0IGYgPSBmb2xkZXJCeUlkKGlkKTsKICAgIHJldHVybiBmID8gZi5wYXRoLnNwbGl0KCcvJyk",
"uam9pbignIFx1MjAzYSAnKSA6ICcnOwogIH0KCiAgZnVuY3Rpb24gdmlzaWJsZU5vdGVzKCkgewogICAgcmV0dXJuIE4uZm9sZGVyID8gTi5ub3Rlcy5maWx0ZXIobiA9PiBuLmZvbGRlcklkID09PSBOLmZvbGRlcikgOiBOLm5vdGVzOwogIH0KCiAgZnVuY3Rpb24gZHJhd0xpc3QoKSB7CiAgICBpZiAoIWVscy5pdGVtcykgcmV0dXJuOwogICAgY29uc3QgY3VyS2V5ID0gTi5jdXJyZW50ICYmIE4uY3VycmVudC5rZXk7CiAgICBjb25zdCBzaG93biA9IHZpc2libGVOb3RlcygpOwogICAgY29uc3Qgc2VhcmNoaW5nID0gISFOLnF1ZXJ5LnRyaW0oKTsKICAgIGlmIChlbHMuc2NvcGUpIHsKICAgICAgY29uc3Qgd2hlcmUgPSBOLmZvbGRlciA_IGZvbGRlckxhYmVsKE4uZm9sZGVyKSA6ICdBbGwgbm90ZXMnOwogICAgICBlbHMuc2NvcGUudGV4dENvbnRlbnQgPSBOLnN0YXR1cyA9PT0gJ3JlYWR5JwogICAgICAgID8gYCR7d2hlcmV9IFx1MDBiNyAke3Nob3duLmxlbmd0aH0gJHtzZWFyY2hpbmcgPyAoc2hvd24ubGVuZ3RoID09PSAxID8gJ21hdGNoJyA6ICdtYXRjaGVzJykgOiAoc2hvd24ubGVuZ3RoID09PSAxID8gJ25vdGUnIDogJ25vdGVzJyl9YAogICAgICAgIDogd2hlcmU7CiAgICB9CiAgICBpZiAoZWxzLnNlYXJjaCkgZWxzLnNlYXJjaC5wbGFjZWhvbGRlciA9IE4uZm9sZGVyID8gYFNlYXJjaCBpbiAke2ZvbGRlckJ5SWQoTi5mb2xkZXIpID8gZm9sZGVyQnlJZChOLmZvbGRlcikudGl0bGUgOiAndGhpcyBmb2x",
"kZXInfWAgOiAnU2VhcmNoIG5vdGVzJzsKCiAgICBpZiAoTi5zdGF0dXMgPT09ICdsb2FkaW5nJyAmJiAhTi5ub3Rlcy5sZW5ndGgpIHsKICAgICAgZWxzLml0ZW1zLnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtZW1wdHknLCB0ZXh0OiAnTG9hZGluZ-KApicgfSkpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoTi5zdGF0dXMgPT09ICdlcnJvcicgJiYgIU4ubm90ZXMubGVuZ3RoKSB7CiAgICAgIGVscy5pdGVtcy5yZXBsYWNlQ2hpbGRyZW4oCiAgICAgICAgaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLWVtcHR5JyB9LAogICAgICAgICAgaCgncCcsIHsgdGV4dDogYENvdWxkbuKAmXQgbG9hZCBub3RlczogJHtOLmVycm9yfWAgfSksCiAgICAgICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdUcnkgYWdhaW4nLCBvbmNsaWNrOiAoKSA9PiBsb2FkKHsgZm9yY2U6IHRydWUgfSkgfSkpKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgLy8gVGhlIHNjcmF0Y2hwYWQgZmlyc3Q6IGluICJBbGwgbm90ZXMiLCBhbHdheXMsIHNhdmVkIHlldCBvciBub3Q7CiAgICAvLyBlbHNld2hlcmUsIHdoZXJlIGl0IGlzIGxpc3RlZCAoYSBzZWFyY2ggdGhhdCBmaW5kcyBpdCkuCiAgICBjb25zdCBzY3JhdGNoID0gc2hvd24uZmluZChuID0-IG4ua2V5ID09PSBTQ1JBVENIX0tFWSkgfHwgKCFOLmZvbGRlciAmJiAhc2VhcmNoaW5nICYmIE4",
"uc2NyYXRjaEtub3duICYmICFOLnNjcmF0Y2hOb3RlID8gJ25ldycgOiBudWxsKTsKICAgIGNvbnN0IHJlc3QgPSBzaG93bi5maWx0ZXIobiA9PiBuLmtleSAhPT0gU0NSQVRDSF9LRVkpOwogICAgY29uc3QgcGlubmVkID0gc2NyYXRjaCA_IFtzY3JhdGNoSXRlbShzY3JhdGNoID09PSAnbmV3JyA_IG51bGwgOiBzY3JhdGNoLCBjdXJLZXkpXSA6IFtdOwogICAgaWYgKCFyZXN0Lmxlbmd0aCkgewogICAgICBsZXQgdGV4dCA9IHNlYXJjaGluZyA_ICdObyBub3RlcyBtYXRjaC4nIDogJ05vIG5vdGVzIHlldC4nOwogICAgICBpZiAoTi5mb2xkZXIpIHRleHQgPSBzZWFyY2hpbmcgPyAnTm8gbm90ZXMgaW4gdGhpcyBmb2xkZXIgbWF0Y2guJyA6ICdObyBub3RlcyBpbiB0aGlzIGZvbGRlciB5ZXQuJzsKICAgICAgZWxzLml0ZW1zLnJlcGxhY2VDaGlsZHJlbiguLi5waW5uZWQsIGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1lbXB0eScsIHRleHQgfSkpOwogICAgICByZXR1cm47CiAgICB9CgogICAgZWxzLml0ZW1zLnJlcGxhY2VDaGlsZHJlbiguLi5waW5uZWQsIC4uLnJlc3QubWFwKG4gPT4gewogICAgICBjb25zdCBpdGVtID0gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnbm90ZS1pdGVtJywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICdsaXN0aXRlbScsIGRyYWdnYWJsZTogJ3RydWUnLAogICAgICAgICdhcmlhLWN1cnJlbnQnOiBuLmtleSA9PT0gY3VyS2V5ID8gJ3RydWUnIDogbnVsbCwKICAgICAgICBkYXRhc2V",
"0OiB7IGtleTogYG5vdGU6JHtuLmtleX1gLCBub3RlOiBuLmtleSB9LAogICAgICAgIG9uY2xpY2s6ICgpID0-IG9wZW5Ob3RlKG4pLAogICAgICB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktdG9wJyB9LAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICduaS10aXRsZScgfSwgbWFya2VkKG4udGl0bGUpKSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZGF0ZScsIHRleHQ6IHV0aWwucmVsYXRpdmVEYXRlKG4udXBkYXRlZCksIHRpdGxlOiB1dGlsLmZ1bGxEYXRlKG4udXBkYXRlZCkgfSkpLAogICAgICAgIGl0ZW1QcmV2aWV3KG4pLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktbWV0YScgfSwKICAgICAgICAgIGhpdENvdW50KG4pLAogICAgICAgICAgIU4uZm9sZGVyICYmIG4uZm9sZGVySWQgPyBoKCdzcGFuJywgeyBjbGFzczogJ25pLWZvbGRlcicgfSwgaWNvbignZm9sZGVyJywgMTQpLCBmb2xkZXJMYWJlbChuLmZvbGRlcklkKSkgOiBudWxsLAogICAgICAgICAgbi5vd24gPyBudWxsIDogaCgnc3BhbicsIHsgY2xhc3M6ICduaS1tYWlsJywgdGV4dDogJ0Zyb20gYW4gZW1haWwnIH0pKSk7CiAgICAgIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ3N0YXJ0JywgZSA9PiB7CiAgICAgICAgTi5kcmFnS2V5ID0gbi5rZXk7CiAgICAgICAgZS5kYXRhVHJhbnNmZXIuZWZmZWN0QWxsb3dlZCA9ICdtb3ZlJzsKICAgICAgICBlLmRhdGFUcmFuc2Zlci5zZXREYXRhKCdhcHBsaWN",
"hdGlvbi94LWdrYi1ub3RlJywgbi5rZXkpOwogICAgICAgIGVscy53cmFwLmNsYXNzTGlzdC5hZGQoJ2RyYWdnaW5nLW5vdGUnKTsKICAgICAgfSk7CiAgICAgIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsICgpID0-IHsKICAgICAgICBOLmRyYWdLZXkgPSAnJzsKICAgICAgICBlbHMud3JhcC5jbGFzc0xpc3QucmVtb3ZlKCdkcmFnZ2luZy1ub3RlJyk7CiAgICAgICAgZm9yIChjb25zdCByIG9mIGVscy5mb2xkZXJJdGVtcy5xdWVyeVNlbGVjdG9yQWxsKCcuZHJvcCcpKSByLmNsYXNzTGlzdC5yZW1vdmUoJ2Ryb3AnKTsKICAgICAgfSk7CiAgICAgIHJldHVybiBpdGVtOwogICAgfSkpOwogIH0KCiAgLy8gVGhlIHNjcmF0Y2hwYWQncyBlbnRyeTogcGlubmVkLCBub3QgZHJhZ2dhYmxlLCBhbmQgb24gYSBwaG9uZSBpdCBnb2VzCiAgLy8gYmFjayB0byB0aGUgc2NyYXRjaHBhZCByYXRoZXIgdGhhbiBvcGVuaW5nIGl0IGZ1bGwtc2NyZWVuLgogIGZ1bmN0aW9uIHNjcmF0Y2hJdGVtKG4sIGN1cktleSkgewogICAgcmV0dXJuIGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdub3RlLWl0ZW0gc2NyYXRjaC1pdGVtJywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICdsaXN0aXRlbScsCiAgICAgICdhcmlhLWN1cnJlbnQnOiBjdXJLZXkgPT09IFNDUkFUQ0hfS0VZID8gJ3RydWUnIDogbnVsbCwKICAgICAgZGF0YXNldDogeyBrZXk6ICdub3RlOnNjcmF0Y2hwYWQnLCBub3RlOiBTQ1JBVENIX0tFWSB9LAogICAgICB",
"vbmNsaWNrOiAoKSA9PiB7CiAgICAgICAgTi5icm93c2luZyA9IGZhbHNlOwogICAgICAgIGlmIChuKSBvcGVuTm90ZShuKTsKICAgICAgICBlbHNlIHNob3dTY3JhdGNoKCk7CiAgICAgICAgc2V0VmlldygpOwogICAgICB9LAogICAgfSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICduaS10b3AnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICduaS10aXRsZScgfSwgaWNvbignZWRpdCcsIDE2KSwgaCgnc3BhbicsIHt9LCBtYXJrZWQobm90ZXNMb2dpYy5TQ1JBVENIUEFEX1RJVExFKSkpLAogICAgICAgIG4gPyBoKCdzcGFuJywgeyBjbGFzczogJ2RhdGUnLCB0ZXh0OiB1dGlsLnJlbGF0aXZlRGF0ZShuLnVwZGF0ZWQpLCB0aXRsZTogdXRpbC5mdWxsRGF0ZShuLnVwZGF0ZWQpIH0pIDogbnVsbCksCiAgICAgIG4gPyBpdGVtUHJldmlldyhuKSA6IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktc25pcHBldCcsIHRleHQ6ICdFbXB0eSDigJMgd3JpdGUgc29tZXRoaW5nIGRvd24nIH0pLAogICAgICBuID8gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1tZXRhJyB9LCBoaXRDb3VudChuKSkgOiBudWxsKTsKICB9CgogIC8vIOKUgOKUgCBTZWFyY2ggcmVzdWx0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIAKICAvLwogIC8vIEdtYWlsIGZpbmRzIHRoZSBub3RlczsgdGhlc2Ugc2hvdyB3aGVyZSB0aGUgd29yZHMgYXJlLiBFYWNoIHJlc3VsdAogIC8vIGdldHMgZXhjZXJwdHMgYXJvdW5kIGl0cyBtYXRjaGVzIG9uY2UgaXRzIHRleHQgaXMgaW4sIHdpdGggdGhlIHdvcmRzCiAgLy8gbWFya2VkLiBVbnRpbCB0aGVuIC0gb3IgaWYgR21haWwgbWF0Y2hlZCBzb21ldGhpbmcgdGhlIHdvcmRzIGRvIG5vdAogIC8vIHNob3csIHN1Y2ggYXMgYSBzdGVtbWVkIGZvcm0gLSBpdCBzaG93cyBHbWFpbCdzIG93biBzbmlwcGV0LgoKICBjb25zdCB0ZXJtc0tleSA9ICgpID0-IEpTT04uc3RyaW5naWZ5KE4udGVybXMpOwoKICAvLyBUZXh0IHdpdGggdGhlIHNlYXJjaCB3b3JkcyB3cmFwcGVkIGluIDxtYXJrPiwgYnVpbHQgZnJvbSB0ZXh0IG5vZGVzLgogIGZ1bmN0aW9uIG1hcmtlZCh0ZXh0LCBtYXJrcykgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGNvbnN0IG0gPSBtYXJrcyB8fCAoTi50ZXJtcy5sZW5ndGggPyBzZWFyY2hMb2dpYy5maW5kTWF0Y2hlcyhzLCBOLnRlcm1zKSA6IFtdKTsKICAgIGlmICghbS5sZW5ndGgpIHJldHVybiBzOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBsZXQgYXQgPSAwOwogICAgZm9yIChjb25zdCB7IHN0YXJ0LCBlbmQgfSBvZiBtKSB7CiAgICAgIGlmIChzdGFydCA-IGF0KSBvdXQucHVzaChzLnNsaWNlKGF0LCBzdGFydCkpOwogICAgICBvdXQucHVzaChoKCdtYXJ",
"rJywgeyB0ZXh0OiBzLnNsaWNlKHN0YXJ0LCBlbmQpIH0pKTsKICAgICAgYXQgPSBlbmQ7CiAgICB9CiAgICBpZiAoYXQgPCBzLmxlbmd0aCkgb3V0LnB1c2gocy5zbGljZShhdCkpOwogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGl0ZW1QcmV2aWV3KG4pIHsKICAgIGNvbnN0IGhpdCA9IE4udGVybXMubGVuZ3RoID8gTi5oaXRzLmdldChgJHtuLm1lc3NhZ2VJZH18JHt0ZXJtc0tleSgpfWApIDogbnVsbDsKICAgIGlmIChoaXQgJiYgaGl0LmV4Y2VycHRzLmxlbmd0aCkgewogICAgICByZXR1cm4gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1leGNlcnB0cycgfSwgaGl0LmV4Y2VycHRzLm1hcChleCA9PiBoKCdzcGFuJywgeyBjbGFzczogJ25pLWV4Y2VycHQnIH0sCiAgICAgICAgZXguY3V0QmVmb3JlID8gJ1x1MjAyNicgOiAnJywgbWFya2VkKGV4LnRleHQsIGV4Lm1hcmtzKSwgZXguY3V0QWZ0ZXIgPyAnXHUyMDI2JyA6ICcnKSkpOwogICAgfQogICAgcmV0dXJuIG4uc25pcHBldCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktc25pcHBldCcgfSwgbWFya2VkKG4uc25pcHBldCkpIDogbnVsbDsKICB9CgogIGZ1bmN0aW9uIGhpdENvdW50KG4pIHsKICAgIGlmICghTi50ZXJtcy5sZW5ndGgpIHJldHVybiBudWxsOwogICAgY29uc3QgaGl0ID0gTi5oaXRzLmdldChgJHtuLm1lc3NhZ2VJZH18JHt0ZXJtc0tleSgpfWApOwogICAgaWYgKCFoaXQpIHJldHVybiBudWxsOwogICAgcmV0dXJuIGgoJ3NwYW4nLCB7IGN",
"sYXNzOiAnbmktaGl0cycsIHRleHQ6IGAke2hpdC5jb3VudH0gJHtoaXQuY291bnQgPT09IDEgPyAnbWF0Y2gnIDogJ21hdGNoZXMnfWAgfSk7CiAgfQoKICAvLyBGZXRjaGVzIHRoZSB0ZXh0IG9mIHRoZSByZXN1bHRzIG9uIHNob3cgdGhhdCBoYXZlIG5vIGV4Y2VycHRzIHlldCwKICAvLyBhIGZldyBhdCBhIHRpbWUsIHJlZHJhd2luZyB0aGUgbGlzdCBhcyB0aGV5IGNvbWUgaW4uCiAgbGV0IGhpdHNSdW4gPSAwOwogIGFzeW5jIGZ1bmN0aW9uIGZldGNoSGl0cygpIHsKICAgIGlmICghTi50ZXJtcy5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IHJ1biA9ICsraGl0c1J1bjsKICAgIGNvbnN0IGtleSA9IHRlcm1zS2V5KCk7CiAgICBjb25zdCB0ZXJtcyA9IE4udGVybXM7CiAgICBjb25zdCB0b2RvID0gdmlzaWJsZU5vdGVzKCkuc2xpY2UoMCwgRVhDRVJQVF9MSU1JVCkuZmlsdGVyKG4gPT4gIU4uaGl0cy5oYXMoYCR7bi5tZXNzYWdlSWR9fCR7a2V5fWApKTsKICAgIGxldCByZWRyYXcgPSAwOwogICAgYXdhaXQgdXRpbC5tYXBQb29sKHRvZG8sIDQsIGFzeW5jIG4gPT4gewogICAgICBpZiAocnVuICE9PSBoaXRzUnVuKSByZXR1cm47CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgZG9jID0gYXdhaXQgbm90ZXNTdG9yZS5ib2R5KG4pOwogICAgICAgIGNvbnN0IHRleHQgPSBmbXQuZG9jVGV4dChkb2MpOwogICAgICAgIGNvbnN0IGJvZHkgPSBzZWFyY2hMb2dpYy5maW5kTWF0Y2hlcyh0ZXh0LCB0ZXJtcyk7CiAgICA",
"gICAgY29uc3QgdGl0bGUgPSBzZWFyY2hMb2dpYy5maW5kTWF0Y2hlcyhuLnRpdGxlLCB0ZXJtcyk7CiAgICAgICAgTi5oaXRzLnNldChgJHtuLm1lc3NhZ2VJZH18JHtrZXl9YCwgewogICAgICAgICAgY291bnQ6IGJvZHkubGVuZ3RoICsgdGl0bGUubGVuZ3RoLAogICAgICAgICAgZXhjZXJwdHM6IHNlYXJjaExvZ2ljLmV4Y2VycHRzKHRleHQsIGJvZHksIHsgY29udGV4dDogNDUsIG1heDogMyB9KSwKICAgICAgICB9KTsKICAgICAgfSBjYXRjaCB7IC8qIHRoZSBzbmlwcGV0IHN0YW5kcyBpbiAqLyB9CiAgICAgIGlmIChydW4gPT09IGhpdHNSdW4gJiYgIXJlZHJhdykgcmVkcmF3ID0gc2V0VGltZW91dCgoKSA9PiB7IHJlZHJhdyA9IDA7IGRyYXdMaXN0KCk7IH0sIDYwKTsKICAgIH0pOwogICAgaWYgKHJ1biA9PT0gaGl0c1J1bikgZHJhd0xpc3QoKTsKICB9CgogIC8vIOKUgOKUgCBGaW5kIGluIHRoZSBvcGVuIG5vdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGFwcGx5SGlnaGxpZ2h0cygpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWVscy5lZCB8fCAhYyB8fCBjLmJvZHlTdGF0ZSAhPT0gJ3JlYWR5JykgeyBkcmF3RmluZCgpOyByZXR1cm47IH0KICAgIGNvbnN0IGNvdW50ID0",
"gZWxzLmVkLmhpZ2hsaWdodChOLnRlcm1zKTsKICAgIGlmIChOLmZpbmRJbmRleCA-PSBjb3VudCkgTi5maW5kSW5kZXggPSAwOwogICAgaWYgKGNvdW50KSBlbHMuZWQuc2hvd01hdGNoKE4uZmluZEluZGV4KTsKICAgIGRyYXdGaW5kKCk7CiAgfQoKICBmdW5jdGlvbiBzdGVwTWF0Y2goZGVsdGEpIHsKICAgIGNvbnN0IGNvdW50ID0gZWxzLmVkID8gZWxzLmVkLm1hdGNoQ291bnQoKSA6IDA7CiAgICBpZiAoIWNvdW50KSByZXR1cm47CiAgICBOLmZpbmRJbmRleCA9IChOLmZpbmRJbmRleCArIGRlbHRhICsgY291bnQpICUgY291bnQ7CiAgICBlbHMuZWQuc2hvd01hdGNoKE4uZmluZEluZGV4KTsKICAgIGRyYXdGaW5kKCk7CiAgfQoKICBmdW5jdGlvbiBjbGVhclNlYXJjaCgpIHsKICAgIGlmICghZWxzLnNlYXJjaCkgcmV0dXJuOwogICAgZWxzLnNlYXJjaC52YWx1ZSA9ICcnOwogICAgTi5xdWVyeSA9ICcnOwogICAgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVyKTsKICAgIGxvYWQoeyBmb3JjZTogdHJ1ZSB9KTsKICB9CgogIGZ1bmN0aW9uIGRyYXdGaW5kKCkgewogICAgaWYgKCFlbHMuZmluZFNsb3QpIHJldHVybjsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIU4udGVybXMubGVuZ3RoIHx8ICFjIHx8ICFlbHMuZWQgfHwgYy5ib2R5U3RhdGUgIT09ICdyZWFkeScpIHsKICAgICAgZWxzLmZpbmRTbG90LnJlcGxhY2VDaGlsZHJlbigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBjb3VudCA",
"9IGVscy5lZC5tYXRjaENvdW50KCk7CiAgICBjb25zdCB3b3JkcyA9IE4udGVybXMubWFwKHQgPT4gdC53b3Jkcy5qb2luKCcgJykpLmpvaW4oJywgJyk7CiAgICAvLyBBIHJlZHJhdyByZXBsYWNlcyB0aGUgYXJyb3cganVzdCBwcmVzc2VkOyBmb2N1cyBnb2VzIHRvIGl0cyBzdWNjZXNzb3IKICAgIC8vIHJhdGhlciB0aGFuIGZhbGxpbmcgb3V0IG9mIHRoZSBib2FyZCwgd2hlcmUgRjMgd291bGQgbm90IHJlYWNoIGl0LgogICAgY29uc3QgYWN0aXZlID0gTi5jdHgucm9vdC5hY3RpdmVFbGVtZW50OwogICAgY29uc3QgcmVmb2N1cyA9IGFjdGl2ZSAmJiBlbHMuZmluZFNsb3QuY29udGFpbnMoYWN0aXZlKSA_IGFjdGl2ZS5kYXRhc2V0LmtleSA6ICcnOwogICAgZWxzLmZpbmRTbG90LnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAnbmUtZmluZCcsIHJvbGU6ICdzZWFyY2gnLCAnYXJpYS1sYWJlbCc6ICdNYXRjaGVzIGluIHRoaXMgbm90ZScgfSwKICAgICAgaWNvbignc2VhcmNoJywgMTgpLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2ZpbmQtd29yZHMnLCB0ZXh0OiB3b3JkcywgdGl0bGU6IHdvcmRzIH0pLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2ZpbmQtcG9zJywgJ2FyaWEtbGl2ZSc6ICdwb2xpdGUnLCB0ZXh0OiBjb3VudCA_IGAke04uZmluZEluZGV4ICsgMX0gb2YgJHtjb3VudH1gIDogJ05vdCBpbiB0aGUgdGV4dCcgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczo",
"gJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ1ByZXZpb3VzIG1hdGNoIChTaGlmdCtGMyknLCB0aXRsZTogJ1ByZXZpb3VzIG1hdGNoIChTaGlmdCtGMyknLAogICAgICAgIGRpc2FibGVkOiBjb3VudCA8IDIsIGRhdGFzZXQ6IHsga2V5OiAnZmluZC1wcmV2JyB9LCBvbmNsaWNrOiAoKSA9PiBzdGVwTWF0Y2goLTEpLAogICAgICB9LCBpY29uKCd1cCcsIDE4KSksCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ05leHQgbWF0Y2ggKEYzKScsIHRpdGxlOiAnTmV4dCBtYXRjaCAoRjMpJywKICAgICAgICBkaXNhYmxlZDogY291bnQgPCAyLCBkYXRhc2V0OiB7IGtleTogJ2ZpbmQtbmV4dCcgfSwgb25jbGljazogKCkgPT4gc3RlcE1hdGNoKDEpLAogICAgICB9LCBpY29uKCdkb3duJywgMTgpKSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQ2xlYXIgdGhlIHNlYXJjaCcsIHRpdGxlOiAnQ2xlYXIgdGhlIHNlYXJjaCcsCiAgICAgICAgZGF0YXNldDogeyBrZXk6ICdmaW5kLWNsZWFyJyB9LCBvbmNsaWNrOiBjbGVhclNlYXJjaCwKICAgICAgfSwgaWNvbignY2xvc2UnLCAxOCkpKSk7CiAgICBpZiAocmVmb2N1cykgewogICAgICBjb25zdCBhZ2FpbiA9IGVscy5maW5kU2xvdC5xdWVyeVNlbGVjdG9yKGBbZGF",
"0YS1rZXk9IiR7cmVmb2N1c30iXWApOwogICAgICBpZiAoYWdhaW4gJiYgIWFnYWluLmRpc2FibGVkKSBhZ2Fpbi5mb2N1cygpOwogICAgfQogIH0KCiAgLy8g4pSA4pSAIEZvbGRlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGNvdW50cygpIHsKICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTsKICAgIGZvciAoY29uc3QgbiBvZiBOLm5vdGVzKSBvdXQuc2V0KG4uZm9sZGVySWQgfHwgJycsIChvdXQuZ2V0KG4uZm9sZGVySWQgfHwgJycpIHx8IDApICsgMSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gc2V0Rm9sZGVyc09wZW4ob3BlbikgewogICAgaWYgKCFlbHMud3JhcCkgcmV0dXJuOwogICAgZWxzLndyYXAuZGF0YXNldC5mb2xkZXJzID0gb3BlbiA_ICdvcGVuJyA6ICdjbG9zZWQnOwogICAgZWxzLmZvbGRlcnNUb2dnbGUuc2V0QXR0cmlidXRlKCdhcmlhLWV4cGFuZGVkJywgU3RyaW5nKG9wZW4pKTsKICB9CgogIC8vIOKUgOKUgCBGb2xkaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gQSBmb2xkZXIgd2l0aCBzdWJmb2xkZXJzIGhhcyBhbiBhcnJvdyB0aGF0IGZvbGRzIHRoZW0gYXdheSwgZm9yIGEgdHJlZQogIC8vIHRoYXQgaGFzIGdyb3duIGxvbmcuIFdoaWNoIG9uZXMgYXJlIGZvbGRlZCBpcyByZW1lbWJlcmVkIHdoZXJlIHRoZQogIC8vIGhvc3Qga2VlcHMgc3VjaCB0aGluZ3MgKGN0eC5wcmVmcyksIGlmIGl0IGRvZXM6IGEgbmljZXR5LCBzbyBhbnkKICAvLyB0cm91YmxlIHdpdGggaXQganVzdCBsZWF2ZXMgZXZlcnkgZm9sZGVyIG9wZW4uCgogIGZ1bmN0aW9uIGhhc1N1YmZvbGRlcnMoZikgewogICAgcmV0dXJuIE4uZm9sZGVycy5zb21lKHggPT4geC5uYW1lLnN0YXJ0c1dpdGgoYCR7Zi5uYW1lfS9gKSk7CiAgfQoKICAvLyBJbnNpZGUgYSBmb2xkZWQgZm9sZGVyLCBhdCBhbnkgZGVwdGguCiAgZnVuY3Rpb24gaXNUdWNrZWQoZikgewogICAgcmV0dXJuIE4uZm9sZGVycy5zb21lKHggPT4gTi5mb2xkZWQuaGFzKHguaWQpICYmIGYubmFtZS5zdGFydHNXaXRoKGAke3gubmFtZX0vYCkpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVhZEZvbGRlZCgpIHsKICAgIE4uZm9sZGVkUmVhZCA9IHRydWU7CiAgICBjb25zdCBwcmVmcyA9IE4uY3R4ICYmIE4uY3R4LnByZWZzOwogICAgaWYgKCFwcmVmcykgcmV0dXJuOwogICAgdHJ5IHsKICA",
"gICAgY29uc3QgaWRzID0gYXdhaXQgcHJlZnMuZ2V0KCdmb2xkZWRGb2xkZXJzJyk7CiAgICAgIGlmIChBcnJheS5pc0FycmF5KGlkcykpIE4uZm9sZGVkID0gbmV3IFNldChpZHMuZmlsdGVyKGlkID0-IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycpKTsKICAgIH0gY2F0Y2ggKGVycikgeyAvKiBldmVyeSBmb2xkZXIgb3BlbiAqLyB9CiAgfQoKICBmdW5jdGlvbiBzYXZlRm9sZGVkKCkgewogICAgY29uc3QgcHJlZnMgPSBOLmN0eCAmJiBOLmN0eC5wcmVmczsKICAgIGlmICghcHJlZnMpIHJldHVybjsKICAgIC8vIE9ubHkgZm9sZGVycyB0aGF0IGFyZSBzdGlsbCB0aGVyZSwgc28gZGVsZXRlZCBvbmVzIGRvIG5vdCBwaWxlIHVwLgogICAgY29uc3QgaWRzID0gWy4uLk4uZm9sZGVkXS5maWx0ZXIoaWQgPT4gZm9sZGVyQnlJZChpZCkpOwogICAgdHJ5IHsKICAgICAgUHJvbWlzZS5yZXNvbHZlKHByZWZzLnNldCgnZm9sZGVkRm9sZGVycycsIGlkcykpLmNhdGNoKCgpID0-IHt9KTsKICAgIH0gY2F0Y2ggKGVycikgeyAvKiBub3QgcmVtZW1iZXJlZCwgdGhhdCBpcyBhbGwgKi8gfQogIH0KCiAgZnVuY3Rpb24gc2V0Rm9sZGVkKGYsIGZvbGRlZCkgewogICAgaWYgKGZvbGRlZCA9PT0gTi5mb2xkZWQuaGFzKGYuaWQpKSByZXR1cm47CiAgICBpZiAoZm9sZGVkKSBOLmZvbGRlZC5hZGQoZi5pZCk7CiAgICBlbHNlIE4uZm9sZGVkLmRlbGV0ZShmLmlkKTsKICAgIHNhdmVGb2xkZWQoKTsKICAgIC8vIFRoZSByb3dzIGFyZSBkcmF",
"3biBhZnJlc2g6IGtlZXAgdGhlIGtleWJvYXJkIHdoZXJlIGl0IHdhcy4KICAgIGNvbnN0IGFjdGl2ZSA9IE4uY3R4LnJvb3QuYWN0aXZlRWxlbWVudDsKICAgIGNvbnN0IGtleSA9IGFjdGl2ZSAmJiBlbHMuZm9sZGVySXRlbXMuY29udGFpbnMoYWN0aXZlKSA_IGFjdGl2ZS5kYXRhc2V0LmtleSA6ICcnOwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGlmIChrZXkpIHsKICAgICAgY29uc3QgYWdhaW4gPSBlbHMuZm9sZGVySXRlbXMucXVlcnlTZWxlY3RvcihgW2RhdGEta2V5PSIke2tleX0iXWApOwogICAgICBpZiAoYWdhaW4pIGFnYWluLmZvY3VzKCk7CiAgICB9CiAgfQoKICAvLyBPcGVucyBldmVyeSBmb2xkZXIgYWJvdmUgdGhpcyBvbmUsIGFuZCB3aXRoIHNlbGYsIHRoaXMgb25lIHRvby4KICBmdW5jdGlvbiB1bmZvbGQoZiwgc2VsZikgewogICAgbGV0IGNoYW5nZWQgPSBmYWxzZTsKICAgIGZvciAoY29uc3QgeCBvZiBOLmZvbGRlcnMpIHsKICAgICAgaWYgKE4uZm9sZGVkLmhhcyh4LmlkKSAmJiAoKHNlbGYgJiYgeC5pZCA9PT0gZi5pZCkgfHwgZi5uYW1lLnN0YXJ0c1dpdGgoYCR7eC5uYW1lfS9gKSkpIHsKICAgICAgICBOLmZvbGRlZC5kZWxldGUoeC5pZCk7CiAgICAgICAgY2hhbmdlZCA9IHRydWU7CiAgICAgIH0KICAgIH0KICAgIGlmIChjaGFuZ2VkKSBzYXZlRm9sZGVkKCk7CiAgfQoKICBmdW5jdGlvbiBzZWxlY3RGb2xkZXIoaWQpIHsKICAgIHNldEZvbGRlcnNPcGVuKGZhbHNlKTsKICAgIC8vIE9uIGE",
"gcGhvbmUsIGNob29zaW5nIGEgZm9sZGVyIC0gIkFsbCBub3RlcyIgdG9vIC0gc2hvd3MgaXRzIGxpc3QuCiAgICBpZiAoIU4uYnJvd3NpbmcpIHsgTi5icm93c2luZyA9IHRydWU7IHNldFZpZXcoKTsgfQogICAgaWYgKE4uZm9sZGVyID09PSBpZCkgcmV0dXJuOwogICAgTi5mb2xkZXIgPSBpZDsKICAgIGRyYXdGb2xkZXJzKCk7CiAgICBkcmF3TGlzdCgpOwogICAgZmV0Y2hIaXRzKCk7CiAgfQoKICBmdW5jdGlvbiBkcmF3Rm9sZGVycygpIHsKICAgIGlmICghZWxzLmZvbGRlckl0ZW1zKSByZXR1cm47CiAgICBjb25zdCB0YWxseSA9IGNvdW50cygpOwogICAgY29uc3Qgcm93cyA9IFtmb2xkZXJSb3cobnVsbCwgTi5ub3Rlcy5sZW5ndGgpXTsKICAgIGNvbnN0IGVkaXQgPSBOLmZvbGRlckVkaXQ7CiAgICBpZiAoZWRpdCAmJiBlZGl0Lm1vZGUgPT09ICduZXcnICYmICFlZGl0LnBhcmVudElkKSByb3dzLnB1c2goZWRpdFJvdygwKSk7CiAgICBjb25zdCBjdXJyZW50ID0gTi5mb2xkZXIgPyBmb2xkZXJCeUlkKE4uZm9sZGVyKSA6IG51bGw7CiAgICBOLmZvbGRlcnMuZm9yRWFjaCgoZiwgaSkgPT4gewogICAgICBpZiAoIWlzVHVja2VkKGYpKSB7CiAgICAgICAgcm93cy5wdXNoKGVkaXQgJiYgZWRpdC5tb2RlID09PSAncmVuYW1lJyAmJiBlZGl0LmZvbGRlcklkID09PSBmLmlkID8gZWRpdFJvdyhmLmRlcHRoLCBmKQogICAgICAgICAgOiBmb2xkZXJSb3coZiwgdGFsbHkuZ2V0KGYuaWQpIHx8IDAsICEhY3VycmVudCA",
"mJiBOLmZvbGRlZC5oYXMoZi5pZCkgJiYgY3VycmVudC5uYW1lLnN0YXJ0c1dpdGgoYCR7Zi5uYW1lfS9gKSkpOwogICAgICB9CiAgICAgIC8vIEEgbmV3IHN1YmZvbGRlcidzIGZpZWxkIGdvZXMgYWZ0ZXIgdGhlIHdob2xlIGJyYW5jaCBpdCBqb2lucy4KICAgICAgY29uc3QgbmV4dCA9IE4uZm9sZGVyc1tpICsgMV07CiAgICAgIGNvbnN0IGJyYW5jaEVuZHMgPSAhbmV4dCB8fCAhbmV4dC5uYW1lLnN0YXJ0c1dpdGgoYCR7Zi5uYW1lfS9gKTsKICAgICAgaWYgKGVkaXQgJiYgZWRpdC5tb2RlID09PSAnbmV3JyAmJiBlZGl0LnBhcmVudElkKSB7CiAgICAgICAgY29uc3QgcGFyZW50ID0gZm9sZGVyQnlJZChlZGl0LnBhcmVudElkKTsKICAgICAgICBpZiAocGFyZW50ICYmIChmLmlkID09PSBwYXJlbnQuaWQgfHwgZi5uYW1lLnN0YXJ0c1dpdGgoYCR7cGFyZW50Lm5hbWV9L2ApKSAmJiBicmFuY2hFbmRzKSByb3dzLnB1c2goZWRpdFJvdyhwYXJlbnQuZGVwdGggKyAxKSk7CiAgICAgIH0KICAgIH0pOwogICAgZWxzLmZvbGRlckl0ZW1zLnJlcGxhY2VDaGlsZHJlbiguLi5yb3dzKTsKICAgIC8vIFJvb20gZm9yIHRoZSBhcnJvd3Mgb25seSBvbmNlIHNvbWUgZm9sZGVyIGhhcyBzdWJmb2xkZXJzLgogICAgZWxzLmZvbGRlckl0ZW1zLnRvZ2dsZUF0dHJpYnV0ZSgnZGF0YS1uZXN0ZWQnLCBOLmZvbGRlcnMuc29tZShmID0-IGYuZGVwdGggPiAwKSk7CgogICAgY29uc3Qgc2hvd24gPSBOLmZvbGRlciA_IGZvbGRlckJ5SWQ",
"oTi5mb2xkZXIpIDogbnVsbDsKICAgIGVscy5mb2xkZXJzVG9nZ2xlLnJlcGxhY2VDaGlsZHJlbigKICAgICAgaWNvbihzaG93biA_ICdmb2xkZXInIDogJ25vdGVzJywgMjApLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2Z0LWxhYmVsJywgdGV4dDogc2hvd24gPyBmb2xkZXJMYWJlbChzaG93bi5pZCkgOiAnQWxsIG5vdGVzJyB9KSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmdC1jb3VudCcsIHRleHQ6IE4uc3RhdHVzID09PSAncmVhZHknID8gU3RyaW5nKHNob3duID8gdGFsbHkuZ2V0KHNob3duLmlkKSB8fCAwIDogTi5ub3Rlcy5sZW5ndGgpIDogJycgfSksCiAgICAgIGljb24oJ2NhcmV0JywgMjApKTsKICB9CgogIC8vIGhvbGRzQ3VycmVudDogZm9sZGVkLCB3aXRoIHRoZSBmb2xkZXIgYmVpbmcgbG9va2VkIGF0IHNvbWV3aGVyZSBpbnNpZGUuCiAgZnVuY3Rpb24gZm9sZGVyUm93KGYsIGNvdW50LCBob2xkc0N1cnJlbnQgPSBmYWxzZSkgewogICAgY29uc3QgaWQgPSBmID8gZi5pZCA6ICcnOwogICAgY29uc3QgY2hpbGRyZW4gPSBmID8gaGFzU3ViZm9sZGVycyhmKSA6IGZhbHNlOwogICAgY29uc3QgZm9sZGVkID0gY2hpbGRyZW4gJiYgTi5mb2xkZWQuaGFzKGlkKTsKICAgIGNvbnN0IHJvdyA9IGgoJ2RpdicsIHsKICAgICAgY2xhc3M6ICdmb2xkZXItcm93Jywgcm9sZTogJ2xpc3RpdGVtJywgZGF0YXNldDogeyBmb2xkZXI6IGlkIHx8ICdhbGwnIH0sCiAgICB9LAogICAgICBjaGlsZHJlbiA_IGg",
"oJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ZvbGRlci10d2lzdHknLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtZXhwYW5kZWQnOiBTdHJpbmcoIWZvbGRlZCksCiAgICAgICAgJ2FyaWEtbGFiZWwnOiBgJHtmb2xkZWQgPyAnU2hvdycgOiAnSGlkZSd9IHRoZSBmb2xkZXJzIGluICR7Zi50aXRsZX1gLCB0aXRsZTogZm9sZGVkID8gJ1Nob3cgc3ViZm9sZGVycycgOiAnSGlkZSBzdWJmb2xkZXJzJywKICAgICAgICBkYXRhc2V0OiB7IGtleTogYGZvbGRlci10d2lzdHk6JHtpZH1gIH0sIG9uY2xpY2s6ICgpID0-IHNldEZvbGRlZChmLCAhZm9sZGVkKSwKICAgICAgfSwgaWNvbignY2FyZXQnLCAxOCkpIDogaCgnc3BhbicsIHsgY2xhc3M6ICdmb2xkZXItdHdpc3R5JywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0pLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6IGBmb2xkZXItYnRuJHtob2xkc0N1cnJlbnQgPyAnIGhvbGRzLWN1cnJlbnQnIDogJyd9YCwgdHlwZTogJ2J1dHRvbicsICdhcmlhLWN1cnJlbnQnOiBOLmZvbGRlciA9PT0gaWQgPyAndHJ1ZScgOiBudWxsLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgZm9sZGVyOiR7aWQgfHwgJ2FsbCd9YCB9LCB0aXRsZTogZiA_IGYubmFtZSA6ICdFdmVyeSBub3RlLCBpbiBhbnkgZm9sZGVyJywKICAgICAgICBvbmNsaWNrOiAoKSA9PiBzZWxlY3RGb2xkZXIoaWQpLAogICAgICAgIC8vIEFzIGluIGFueSB0cmVlOiByaWdodCBvcGVucyBhIGZvbGRlcid",
"zIHN1YmZvbGRlcnMsIGxlZnQgZm9sZHMgdGhlbS4KICAgICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgICAgaWYgKCFjaGlsZHJlbiB8fCBlLmFsdEtleSB8fCBlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuc2hpZnRLZXkpIHJldHVybjsKICAgICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93UmlnaHQnICYmIGZvbGRlZCkgeyBlLnByZXZlbnREZWZhdWx0KCk7IHNldEZvbGRlZChmLCBmYWxzZSk7IH0KICAgICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93TGVmdCcgJiYgIWZvbGRlZCkgeyBlLnByZXZlbnREZWZhdWx0KCk7IHNldEZvbGRlZChmLCB0cnVlKTsgfQogICAgICAgIH0sCiAgICAgIH0sCiAgICAgICAgaWNvbihmID8gJ2ZvbGRlcicgOiAnbm90ZXMnLCAxOCksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmb2xkZXItdGl0bGUnLCB0ZXh0OiBmID8gZi50aXRsZSA6ICdBbGwgbm90ZXMnIH0pLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZm9sZGVyLWNvdW50JywgdGV4dDogTi5zdGF0dXMgPT09ICdyZWFkeScgPyBTdHJpbmcoY291bnQpIDogJycgfSkpLAogICAgICBmID8gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4gZm9sZGVyLW1lbnUnLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiBgTW9yZSBhY3Rpb25zOiAke2YudGl0bGV9YCwgdGl0bGU6ICdNb3JlIGFjdGlvbnMnLAogICAgICAgICdhcmlhLWhhc3BvcHVwJzogJ21lbnUnLCAnYXJpYS1leHB",
"hbmRlZCc6ICdmYWxzZScsIGRhdGFzZXQ6IHsga2V5OiBgZm9sZGVyLW1lbnU6JHtpZH1gIH0sCiAgICAgICAgb25jbGljazogZSA9PiBvcGVuTWVudShOLmN0eC5yb290LCBlLmN1cnJlbnRUYXJnZXQsIFsKICAgICAgICAgIHsgbGFiZWw6ICdSZW5hbWUnLCBpY29uOiAnZWRpdCcsIGtleTogJ2ZvbGRlci1yZW5hbWUnLCBvblNlbGVjdDogKCkgPT4gc3RhcnRGb2xkZXJFZGl0KHsgbW9kZTogJ3JlbmFtZScsIGZvbGRlcklkOiBpZCB9KSB9LAogICAgICAgICAgeyBsYWJlbDogJ05ldyBzdWJmb2xkZXInLCBpY29uOiAnYWRkJywga2V5OiAnZm9sZGVyLXN1YicsIG9uU2VsZWN0OiAoKSA9PiBzdGFydEZvbGRlckVkaXQoeyBtb2RlOiAnbmV3JywgcGFyZW50SWQ6IGlkIH0pIH0sCiAgICAgICAgICB7IHNlcGFyYXRvcjogdHJ1ZSB9LAogICAgICAgICAgewogICAgICAgICAgICBsYWJlbDogY291bnQgfHwgY2hpbGRyZW4gPyAnRGVsZXRlIChlbXB0eSBpdCBmaXJzdCknIDogJ0RlbGV0ZScsIGljb246ICdkZWxldGUnLCBkYW5nZXI6IHRydWUsIGtleTogJ2ZvbGRlci1kZWxldGUnLAogICAgICAgICAgICBkaXNhYmxlZDogISEoY291bnQgfHwgY2hpbGRyZW4pLCBvblNlbGVjdDogKCkgPT4gcmVtb3ZlRm9sZGVyKGYpLAogICAgICAgICAgfSwKICAgICAgICBdLCB7IGxhYmVsOiBgQWN0aW9ucyBmb3IgJHtmLnRpdGxlfWAgfSksCiAgICAgIH0sIGljb24oJ21vcmUnLCAxOCkpIDogbnVsbCk7CiAgICAvLyBUaHJvdWdoIHR",
"oZSBzdHlsZSBBUEksIG5vdCBhIHN0eWxlIGF0dHJpYnV0ZTogYSBwYWdlJ3Mgc2VjdXJpdHkKICAgIC8vIHBvbGljeSBtYXkgcmVmdXNlIGlubGluZSBzdHlsZSBhdHRyaWJ1dGVzLCBuZXZlciB0aGlzLgogICAgcm93LnN0eWxlLnNldFByb3BlcnR5KCctLWRlcHRoJywgU3RyaW5nKGYgPyBmLmRlcHRoIDogMCkpOwoKICAgIC8vIERyb3BwaW5nIGEgbm90ZSBoZXJlIGZpbGVzIGl0IGhlcmU7IG9uICJBbGwgbm90ZXMiLCB0YWtlcyBpdCBvdXQgb2YKICAgIC8vIGl0cyBmb2xkZXIuCiAgICByb3cuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLCBlID0-IHsKICAgICAgaWYgKCFOLmRyYWdLZXkpIHJldHVybjsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBlLmRhdGFUcmFuc2Zlci5kcm9wRWZmZWN0ID0gJ21vdmUnOwogICAgICByb3cuY2xhc3NMaXN0LmFkZCgnZHJvcCcpOwogICAgfSk7CiAgICByb3cuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2xlYXZlJywgKCkgPT4gcm93LmNsYXNzTGlzdC5yZW1vdmUoJ2Ryb3AnKSk7CiAgICByb3cuYWRkRXZlbnRMaXN0ZW5lcignZHJvcCcsIGUgPT4gewogICAgICBpZiAoIU4uZHJhZ0tleSkgcmV0dXJuOwogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIHJvdy5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wJyk7CiAgICAgIGNvbnN0IG5vdGUgPSBOLm5vdGVzLmZpbmQobiA9PiBuLmtleSA9PT0gTi5kcmFnS2V5KTsKICAgICAgTi5kcmFnS2V5ID0gJyc7CiAgICA",
"gIGlmIChub3RlKSBtb3ZlTm90ZShub3RlLCBpZCk7CiAgICB9KTsKICAgIHJldHVybiByb3c7CiAgfQoKICBmdW5jdGlvbiBlZGl0Um93KGRlcHRoLCBmb2xkZXIpIHsKICAgIGNvbnN0IGVkaXQgPSBOLmZvbGRlckVkaXQ7CiAgICBjb25zdCBpbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQgZm9sZGVyLWlucHV0JywgdHlwZTogJ3RleHQnLCB2YWx1ZTogZWRpdC52YWx1ZSwgbWF4bGVuZ3RoOiBTdHJpbmcobm90ZXNMb2dpYy5GT0xERVJfTkFNRV9NQVgpLAogICAgICBwbGFjZWhvbGRlcjogZWRpdC5tb2RlID09PSAnbmV3JyA_ICdGb2xkZXIgbmFtZSwgdGhlbiBFbnRlcicgOiAnJywgJ2FyaWEtbGFiZWwnOiBlZGl0Lm1vZGUgPT09ICduZXcnID8gJ05ldyBmb2xkZXIgbmFtZScgOiBgUmVuYW1lICR7Zm9sZGVyLnRpdGxlfWAsCiAgICAgIGRpc2FibGVkOiAhIWVkaXQuYnVzeSwgZGF0YXNldDogeyBrZXk6ICdmb2xkZXItaW5wdXQnIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBlZGl0LnZhbHVlID0gZS50YXJnZXQudmFsdWU7IH0sCiAgICAgIG9ua2V5ZG93bjogZSA9PiB7CiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInKSB7IGUucHJldmVudERlZmF1bHQoKTsgY29tbWl0Rm9sZGVyRWRpdCgpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNhbmNlbEZvbGRlckVkaXQoKTsgfQogICA",
"gICB9LAogICAgICBvbmJsdXI6ICgpID0-IHsgaWYgKCFlZGl0LmJ1c3kgJiYgTi5mb2xkZXJFZGl0ID09PSBlZGl0KSBzZXRUaW1lb3V0KCgpID0-IHsgaWYgKE4uZm9sZGVyRWRpdCA9PT0gZWRpdCAmJiAhZWRpdC5idXN5KSBjYW5jZWxGb2xkZXJFZGl0KCk7IH0sIDE1MCk7IH0sCiAgICB9KTsKICAgIGNvbnN0IHJvdyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdmb2xkZXItcm93IGVkaXRpbmcnIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmb2xkZXItZWRpdCcgfSwgaWNvbignZm9sZGVyJywgMTgpLCBpbnB1dCksCiAgICAgIGVkaXQuZXJyb3IgPyBoKCdkaXYnLCB7IGNsYXNzOiAnZm9sZGVyLWVycm9yJywgcm9sZTogJ2FsZXJ0JywgdGV4dDogZWRpdC5lcnJvciB9KSA6IG51bGwpOwogICAgcm93LnN0eWxlLnNldFByb3BlcnR5KCctLWRlcHRoJywgU3RyaW5nKGRlcHRoKSk7CiAgICByZXR1cm4gcm93OwogIH0KCiAgZnVuY3Rpb24gc3RhcnRGb2xkZXJFZGl0KHsgbW9kZSwgcGFyZW50SWQgPSAnJywgZm9sZGVySWQgPSAnJyB9KSB7CiAgICBjb25zdCBmID0gZm9sZGVyQnlJZChmb2xkZXJJZCk7CiAgICAvLyBBIG5ldyBzdWJmb2xkZXIncyBmaWVsZCBzaG93cyBpbnNpZGUgaXRzIHBhcmVudCwgc28gdGhhdCBoYXMgdG8gYmUgb3Blbi4KICAgIGNvbnN0IHBhcmVudCA9IG1vZGUgPT09ICduZXcnID8gZm9sZGVyQnlJZChwYXJlbnRJZCkgOiBudWxsOwogICAgaWYgKHBhcmVudCkgdW5mb2xkKHBhcmVudCwgdHJ",
"1ZSk7CiAgICBOLmZvbGRlckVkaXQgPSB7IG1vZGUsIHBhcmVudElkLCBmb2xkZXJJZCwgdmFsdWU6IG1vZGUgPT09ICdyZW5hbWUnICYmIGYgPyBmLnRpdGxlIDogJycsIGVycm9yOiAnJywgYnVzeTogZmFsc2UgfTsKICAgIGRyYXdGb2xkZXJzKCk7CiAgICBjb25zdCBpbnB1dCA9IGVscy5mb2xkZXJJdGVtcy5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9ImZvbGRlci1pbnB1dCJdJyk7CiAgICBpZiAoaW5wdXQpIHsgaW5wdXQuZm9jdXMoKTsgaW5wdXQuc2VsZWN0KCk7IH0KICB9CgogIGZ1bmN0aW9uIGNhbmNlbEZvbGRlckVkaXQoKSB7CiAgICBpZiAoIU4uZm9sZGVyRWRpdCkgcmV0dXJuOwogICAgTi5mb2xkZXJFZGl0ID0gbnVsbDsKICAgIGRyYXdGb2xkZXJzKCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBjb21taXRGb2xkZXJFZGl0KCkgewogICAgY29uc3QgZWRpdCA9IE4uZm9sZGVyRWRpdDsKICAgIGlmICghZWRpdCB8fCBlZGl0LmJ1c3kpIHJldHVybjsKICAgIGNvbnN0IHRhcmdldCA9IGVkaXQubW9kZSA9PT0gJ3JlbmFtZScgPyBmb2xkZXJCeUlkKGVkaXQuZm9sZGVySWQpIDogbnVsbDsKICAgIGNvbnN0IHBhcmVudCA9IGVkaXQubW9kZSA9PT0gJ25ldycgPyBmb2xkZXJCeUlkKGVkaXQucGFyZW50SWQpIDogbnVsbDsKICAgIGNvbnN0IHBhcmVudFBhdGggPSB0YXJnZXQgPyB0YXJnZXQucGFyZW50UGF0aCA6IHBhcmVudCA_IHBhcmVudC5wYXRoIDogJyc7CiAgICBjb25zdCBzaWJsaW5ncyA9IE4uZm9",
"sZGVycy5maWx0ZXIoZiA9PiBmLnBhcmVudFBhdGggPT09IHBhcmVudFBhdGggJiYgZiAhPT0gdGFyZ2V0KS5tYXAoZiA9PiBmLnRpdGxlKTsKICAgIGNvbnN0IHByb2JsZW0gPSBub3Rlc0xvZ2ljLnZhbGlkYXRlRm9sZGVyVGl0bGUoZWRpdC52YWx1ZSwgc2libGluZ3MpOwogICAgaWYgKGVkaXQubW9kZSA9PT0gJ3JlbmFtZScgJiYgdGFyZ2V0ICYmIGVkaXQudmFsdWUudHJpbSgpID09PSB0YXJnZXQudGl0bGUpIHsgY2FuY2VsRm9sZGVyRWRpdCgpOyByZXR1cm47IH0KICAgIGlmIChwcm9ibGVtKSB7CiAgICAgIGVkaXQuZXJyb3IgPSBwcm9ibGVtOwogICAgICBkcmF3Rm9sZGVycygpOwogICAgICBjb25zdCBpbnB1dCA9IGVscy5mb2xkZXJJdGVtcy5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9ImZvbGRlci1pbnB1dCJdJyk7CiAgICAgIGlmIChpbnB1dCkgaW5wdXQuZm9jdXMoKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgZWRpdC5idXN5ID0gdHJ1ZTsKICAgIGRyYXdGb2xkZXJzKCk7CiAgICB0cnkgewogICAgICBpZiAoZWRpdC5tb2RlID09PSAnbmV3JykgewogICAgICAgIGNvbnN0IG1hZGUgPSBhd2FpdCBub3Rlc1N0b3JlLmNyZWF0ZUZvbGRlcihwYXJlbnQsIGVkaXQudmFsdWUpOwogICAgICAgIE4uZm9sZGVycyA9IG5vdGVzU3RvcmUuZm9sZGVycygpOwogICAgICAgIGlmIChtYWRlKSBOLmZvbGRlciA9IG1hZGUuaWQ7CiAgICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYEZvbGRlciDigJwke2VkaXQudmF",
"sdWUudHJpbSgpfeKAnSBjcmVhdGVkLmApOwogICAgICB9IGVsc2UgewogICAgICAgIGF3YWl0IG5vdGVzU3RvcmUucmVuYW1lRm9sZGVyKHRhcmdldCwgZWRpdC52YWx1ZSk7CiAgICAgICAgTi5mb2xkZXJzID0gbm90ZXNTdG9yZS5mb2xkZXJzKCk7CiAgICAgIH0KICAgICAgTi5mb2xkZXJFZGl0ID0gbnVsbDsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBlZGl0LmJ1c3kgPSBmYWxzZTsKICAgICAgZWRpdC5lcnJvciA9IGBDb3VsZG7igJl0IHNhdmU6ICR7ZXJyLm1lc3NhZ2V9YDsKICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSBOLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgIH0KICAgIGRyYXdGb2xkZXJzKCk7CiAgICBkcmF3TGlzdCgpOwogICAgaWYgKE4uY3VycmVudCkgZHJhd0JhcigpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVtb3ZlRm9sZGVyKGYpIHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IG5vdGVzU3RvcmUuZGVsZXRlRm9sZGVyKGYpOwogICAgICBOLmZvbGRlcnMgPSBub3Rlc1N0b3JlLmZvbGRlcnMoKTsKICAgICAgaWYgKE4uZm9sZGVyID09PSBmLmlkKSBOLmZvbGRlciA9ICcnOwogICAgICB0b2FzdChOLmN0eC5yb290LCBgRm9sZGVyIOKAnCR7Zi50aXRsZX3igJ0gZGVsZXRlZC5gKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBjb25zdCBtc2cgPSBlcnIuY29kZSA9PT0gJ25vdF9hbGxvd2VkJyA_ICdPbmx5IGFuIGVtcHR5IGZvbGRlciBjYW4gYmUgZGVsZXR",
"lZC4gTW92ZSBpdHMgbm90ZXMgb3V0IGZpcnN0LicgOiBlcnIubWVzc2FnZTsKICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgZGVsZXRlIOKAnCR7Zi50aXRsZX3igJ06ICR7bXNnfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgIH0KICAgIGRyYXdGb2xkZXJzKCk7CiAgICBkcmF3TGlzdCgpOwogIH0KCiAgLy8gUnVucyBhZnRlciBhbnkgc2F2ZSBpbiBwcm9ncmVzcywgc28gdGhlIG1vdmUgbGFuZHMgb24gdGhlIG5ld2VzdAogIC8vIHZlcnNpb24gcmF0aGVyIHRoYW4gb25lIGFib3V0IHRvIGJlIHJlcGxhY2VkLgogIGZ1bmN0aW9uIG1vdmVOb3RlKG5vdGUsIGZvbGRlcklkKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50ICYmIE4uY3VycmVudC5ub3RlID09PSBub3RlID8gTi5jdXJyZW50IDogbnVsbDsKICAgIGlmICgobm90ZS5mb2xkZXJJZCB8fCAnJykgPT09IChmb2xkZXJJZCB8fCAnJykpIHJldHVybiBOLmNoYWluOwogICAgTi5jaGFpbiA9IE4uY2hhaW4udGhlbihhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGxhdGVzdCA9IGMgPyBjLm5vdGUgOiBub3RlOwogICAgICBjb25zdCB3YXMgPSBsYXRlc3QuZm9sZGVySWQgfHwgJyc7CiAgICAgIGxhdGVzdC5mb2xkZXJJZCA9IGZvbGRlcklkOwogICAgICBpZiAoYykgYy5mb2xkZXJJZCA9IGZvbGRlcklkOwogICAgICBkcmF3Rm9sZGVycygpOwogICAgICBkcmF3TGlzdCgpOwogICAgICBpZiAoYykgZHJhd0JhcigpOwogICAgICB0cnkgewogICA",
"gICAgIGF3YWl0IG5vdGVzU3RvcmUubW92ZShsYXRlc3QsIGZvbGRlcklkKTsKICAgICAgICB0b2FzdChOLmN0eC5yb290LCBmb2xkZXJJZCA_IGBNb3ZlZCB0byAke2ZvbGRlckxhYmVsKGZvbGRlcklkKX0uYCA6ICdUYWtlbiBvdXQgb2YgaXRzIGZvbGRlci4nKTsKICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgbGF0ZXN0LmZvbGRlcklkID0gd2FzOwogICAgICAgIGlmIChjKSBjLmZvbGRlcklkID0gd2FzOwogICAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBDb3VsZG7igJl0IG1vdmUg4oCcJHtsYXRlc3QudGl0bGV94oCdOiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIE4uY3R4Lm9uU3RhdGVFcnJvcihlcnIpOwogICAgICB9CiAgICAgIGRyYXdGb2xkZXJzKCk7CiAgICAgIGRyYXdMaXN0KCk7CiAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMgJiYgYykgZHJhd0JhcigpOwogICAgfSk7CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIFRoZSBmb2xkZXIgYnV0dG9uIGFib3ZlIHRoZSBub3RlOiB3aGVyZSBpdCBpcywgYW5kIHdoZXJlIGl0IGNhbiBnby4KICBmdW5jdGlvbiBjaG9vc2VGb2xkZXIoYW5jaG9yKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFjKSByZXR1cm47CiAgICBvcGVuTWVudShOLmN0eC5yb290LCBhbmNob3IsIFsKICAgICAgeyBoZWFkaW5nOiAnTW92ZSB0bycgfSwKICA",
"gICAgeyBsYWJlbDogJ05vIGZvbGRlcicsIGtleTogJ21vdmUtZm9sZGVyOm5vbmUnLCBjaGVja2VkOiAhYy5mb2xkZXJJZCwgb25TZWxlY3Q6ICgpID0-IHNldEN1cnJlbnRGb2xkZXIoJycpIH0sCiAgICAgIC4uLk4uZm9sZGVycy5tYXAoZiA9PiAoewogICAgICAgIGxhYmVsOiBgJHsnXHUyMDAzJy5yZXBlYXQoZi5kZXB0aCl9JHtmLnRpdGxlfWAsIGtleTogYG1vdmUtZm9sZGVyOiR7Zi5pZH1gLCBjaGVja2VkOiBjLmZvbGRlcklkID09PSBmLmlkLAogICAgICAgIG9uU2VsZWN0OiAoKSA9PiBzZXRDdXJyZW50Rm9sZGVyKGYuaWQpLAogICAgICB9KSksCiAgICBdLCB7IGxhYmVsOiAnRm9sZGVyJyB9KTsKICB9CgogIGZ1bmN0aW9uIHNldEN1cnJlbnRGb2xkZXIoaWQpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMpIHJldHVybjsKICAgIC8vIE5vdCBzYXZlZCB5ZXQ6IHRoZSBmb2xkZXIgaXMgc2ltcGx5IHdoZXJlIHRoZSBmaXJzdCBzYXZlIHB1dHMgaXQuCiAgICBpZiAoIWMubm90ZSkgewogICAgICBjLmZvbGRlcklkID0gaWQ7CiAgICAgIGRyYXdCYXIoKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgbW92ZU5vdGUoYy5ub3RlLCBpZCk7CiAgfQoKICBmdW5jdGlvbiBkcmF3Rm9vdCgpIHsKICAgIGlmICghZWxzLmZvb3QpIHJldHVybjsKICAgIGVscy5mb290LnRleHRDb250ZW50ID0gTi50cnVuY2F0ZWQKICAgICAgPyAnU2hvd2luZyB0aGUgMTAwIG1vc3QgcmVjZW50LiBTZWFyY2ggdG8",
"gZmluZCBvbGRlciBvbmVzLicKICAgICAgOiBgS2VwdCBpbiBHbWFpbCB1bmRlciDigJwke25vdGVzU3RvcmUubGFiZWxOYW1lKCl94oCdYDsKICB9CgogIC8vIOKUgOKUgCBUaGUgZWRpdG9yIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBuZXdDdXJyZW50KG5vdGUpIHsKICAgIHJldHVybiB7CiAgICAgIGtleTogbm90ZSA_IG5vdGUua2V5IDogYG5ldzoke0RhdGUubm93KCl9YCwKICAgICAgbm90ZSwgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIG51bGwgdW50aWwgZmlyc3Qgc2F2ZWQKICAgICAgdGl0bGU6IG5vdGUgJiYgbm90ZS50aXRsZSAhPT0gJ1VudGl0bGVkIG5vdGUnID8gbm90ZS50aXRsZSA6ICcnLAogICAgICBkb2M6IG5vdGUgPyBudWxsIDogZm10LmVtcHR5RG9jKCksICAgLy8gZm9ybWF0dGVkIGNvbnRlbnQsIG9uY2UgbG9hZGVkCiAgICAgIGJvZHlTdGF0ZTogbm90ZSA_ICdsb2FkaW5nJyA6ICdyZWFkeScsIC8vIGxvYWRpbmcgfCByZWFkeSB8IGVycm9yCiAgICAgIGRpcnR5OiBmYWxzZSwKICAgICAgc2F2aW5nOiBmYWxzZSwKICAgICAgZXJyb3I6ICcnLAogICAgICBzYXZlZEF0OiAwLAogICAgICAvLyBBIG5ldyBub3RlIHN",
"0YXJ0cyBpbiB0aGUgZm9sZGVyIGJlaW5nIGxvb2tlZCBhdC4KICAgICAgZm9sZGVySWQ6IG5vdGUgPyBub3RlLmZvbGRlcklkIHx8ICcnIDogTi5mb2xkZXIsCiAgICB9OwogIH0KCiAgLy8gVGhlIHNjcmF0Y2hwYWQsIGFzIHRoZSBub3RlIGJlaW5nIGVkaXRlZDogaXRzIHNhdmVkIG1lc3NhZ2UsIG9yIG51bGwKICAvLyB3aGVuIHRoZXJlIGlzIG5vbmUgeWV0LiBJdCBrZWVwcyBpdHMgbmFtZSBhbmQgc3RheXMgb3V0IG9mIGZvbGRlcnMuCiAgZnVuY3Rpb24gc2NyYXRjaEN1cnJlbnQobm90ZSkgewogICAgcmV0dXJuIE9iamVjdC5hc3NpZ24obmV3Q3VycmVudChub3RlKSwgewogICAgICBzY3JhdGNoOiB0cnVlLCBrZXk6IFNDUkFUQ0hfS0VZLCB0aXRsZTogbm90ZXNMb2dpYy5TQ1JBVENIUEFEX1RJVExFLCBmb2xkZXJJZDogJycsCiAgICB9KTsKICB9CgogIC8vIEJlZm9yZSB0aGUgbGlzdCBpcyBpbiwgbm9ib2R5IGtub3dzIHlldCB3aGV0aGVyIHRoZXJlIGlzIG9uZS4KICBmdW5jdGlvbiBwZW5kaW5nU2NyYXRjaCgpIHsKICAgIHJldHVybiBPYmplY3QuYXNzaWduKHNjcmF0Y2hDdXJyZW50KG51bGwpLCB7IGRvYzogbnVsbCwgYm9keVN0YXRlOiAnbG9hZGluZycgfSk7CiAgfQoKICAvLyBXaGVuZXZlciBubyBvdGhlciBub3RlIGlzIG9wZW46IHRoZSBzY3JhdGNocGFkLgogIGZ1bmN0aW9uIHNob3dTY3JhdGNoKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmIChjICYmIGMuc2NyYXRjaCAmJiB",
"jLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykgcmV0dXJuOwogICAgaWYgKE4uc2NyYXRjaE5vdGUpIHsgb3Blbk5vdGUoTi5zY3JhdGNoTm90ZSwgeyBmb3JjZTogdHJ1ZSB9KTsgcmV0dXJuOyB9CiAgICBmbHVzaCgpOwogICAgTi5jdXJyZW50ID0gTi5zY3JhdGNoS25vd24gPyBzY3JhdGNoQ3VycmVudChudWxsKSA6IHBlbmRpbmdTY3JhdGNoKCk7CiAgICBkcmF3TGlzdCgpOwogICAgZHJhd0VkaXRvcigpOwogICAgc2NyYXRjaFJlYWR5KCk7CiAgfQoKICAvLyBUaGUgY3Vyc29yIGdvZXMgaW50byB0aGUgc2NyYXRjaHBhZCBvbmNlIGl0IGNhbiB0YWtlIHR5cGluZywgaWYgaXQKICAvLyB3YXMgYXNrZWQgZm9yIGJlZm9yZSB0aGVuLgogIGZ1bmN0aW9uIHNjcmF0Y2hSZWFkeSgpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIU4ud2FudEZvY3VzIHx8ICFjIHx8ICFjLnNjcmF0Y2ggfHwgYy5ib2R5U3RhdGUgIT09ICdyZWFkeScpIHJldHVybjsKICAgIE4ud2FudEZvY3VzID0gZmFsc2U7CiAgICBmb2N1c0ZpZWxkKCdub3RlLWJvZHknKTsKICB9CgogIGZ1bmN0aW9uIG5ld05vdGUoKSB7CiAgICBmbHVzaCgpOwogICAgTi5jdXJyZW50ID0gbmV3Q3VycmVudChudWxsKTsKICAgIGRyYXdMaXN0KCk7CiAgICBkcmF3RWRpdG9yKCk7CiAgICBmb2N1c0ZpZWxkKCdub3RlLXRpdGxlJyk7CiAgfQoKICBmdW5jdGlvbiBvcGVuTm90ZShub3RlLCB7IGZvcmNlID0gZmFsc2UgfSA9IHt9KSB7CiAgICBpZiAoIWZ",
"vcmNlICYmIE4uY3VycmVudCAmJiBOLmN1cnJlbnQua2V5ID09PSBub3RlLmtleSkgcmV0dXJuOwogICAgZmx1c2goKTsKICAgIGNvbnN0IGMgPSBub3RlLmtleSA9PT0gU0NSQVRDSF9LRVkgPyBzY3JhdGNoQ3VycmVudChub3RlKSA6IG5ld0N1cnJlbnQobm90ZSk7CiAgICBOLmN1cnJlbnQgPSBjOwogICAgTi5maW5kSW5kZXggPSAwOwogICAgZHJhd0xpc3QoKTsKICAgIGRyYXdFZGl0b3IoKTsKICAgIG5vdGVzU3RvcmUuYm9keShub3RlKS50aGVuKGRvYyA9PiB7CiAgICAgIGlmIChOLmN1cnJlbnQgIT09IGMpIHJldHVybjsKICAgICAgYy5kb2MgPSBkb2M7CiAgICAgIGMuYm9keVN0YXRlID0gJ3JlYWR5JzsKICAgICAgZHJhd0VkaXRvcigpOwogICAgICBhcHBseUhpZ2hsaWdodHMoKTsKICAgICAgc2NyYXRjaFJlYWR5KCk7CiAgICB9LCBlcnIgPT4gewogICAgICBpZiAoTi5jdXJyZW50ICE9PSBjKSByZXR1cm47CiAgICAgIGMuYm9keVN0YXRlID0gJ2Vycm9yJzsKICAgICAgYy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIE4uY3R4Lm9uU3RhdGVFcnJvcihlcnIpOwogICAgICBlbHNlIGRyYXdFZGl0b3IoKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZm9jdXNGaWVsZChrZXkpIHsKICAgIGlmIChrZXkgPT09ICdub3RlLWJvZHknICYmIGVscy5lZCkgeyBlbHMuZWQuZm9jdXMoKTsgcmV0dXJuOyB9CiAgICBjb25zdCBlbCA9IGVscy5lZGl0b3I",
"gJiYgZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yKGBbZGF0YS1rZXk9IiR7a2V5fSJdYCk7CiAgICBpZiAoZWwpIGVsLmZvY3VzKCk7CiAgfQoKICAvLyBXaGF0IGEgcGhvbmUgc2hvd3M6IHRoZSBzY3JhdGNocGFkLCB0aGUgbGlzdCwgb3IgYSBub3RlLgogIGZ1bmN0aW9uIHNldFZpZXcoKSB7CiAgICBjb25zdCB2aWV3ID0gTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCA_ICdub3RlJyA6IE4uYnJvd3NpbmcgPyAnbGlzdCcgOiAnaG9tZSc7CiAgICBpZiAoZWxzLndyYXApIGVscy53cmFwLmRhdGFzZXQudmlldyA9IHZpZXc7CiAgICBpZiAodmlldyAhPT0gTi52aWV3KSB7CiAgICAgIE4udmlldyA9IHZpZXc7CiAgICAgIGlmIChOLmN0eCAmJiBOLmN0eC5vblZpZXdDaGFuZ2UpIE4uY3R4Lm9uVmlld0NoYW5nZSh2aWV3KTsKICAgIH0KICB9CgogIC8vIEJhY2sgdG8gdGhlIGxpc3QsIG9uY2Ugd2hhdGV2ZXIgaXMgcGVuZGluZyBpcyBzYXZlZC4gQSBzYXZlIHRoYXQKICAvLyBmYWlsZWQga2VlcHMgdGhlIG5vdGUgb3Blbiwgd2l0aCBpdHMgZXJyb3Igc2hvd2luZywgcmF0aGVyIHRoYW4KICAvLyBsZWF2aW5nIHRoZSBlZGl0cyBiZWhpbmQuCiAgYXN5bmMgZnVuY3Rpb24gY2xvc2VOb3RlKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCBjLnNjcmF0Y2gpIHJldHVybjsKICAgIGF3YWl0IGZsdXNoKCk7CiAgICBpZiAoTi5jdXJyZW50ICE9PSBjKSByZXR1cm47CiAgICBpZiAoYy5",
"kaXJ0eSkgewogICAgICB0b2FzdChOLmN0eC5yb290LCAnTm90IHNhdmVkIHlldCwgc28gdGhlIG5vdGUgc3RheXMgb3Blbi4gVHJ5IGFnYWluIGluIGEgbW9tZW50LicsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgcmV0dXJuOwogICAgfQogICAgc2hvd1NjcmF0Y2goKTsKICB9CgogIC8vIEEgcGhvbmUncyBCYWNrOiBhIG5vdGUgYmFjayB0byB3aGVyZSBpdCB3YXMgb3BlbmVkIGZyb20sIGFuZCB0aGUgbGlzdAogIC8vIGJhY2sgdG8gdGhlIHNjcmF0Y2hwYWQsIHdpdGggdGhlIHNlYXJjaCBhbmQgdGhlIGZvbGRlciBjbGVhcmVkLgogIGFzeW5jIGZ1bmN0aW9uIGJhY2soKSB7CiAgICBpZiAoTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCkgcmV0dXJuIGNsb3NlTm90ZSgpOwogICAgaWYgKCFOLmJyb3dzaW5nKSByZXR1cm47CiAgICBOLmJyb3dzaW5nID0gZmFsc2U7CiAgICBzZXRGb2xkZXJzT3BlbihmYWxzZSk7CiAgICBpZiAoTi5mb2xkZXIpIHsgTi5mb2xkZXIgPSAnJzsgZHJhd0ZvbGRlcnMoKTsgZHJhd0xpc3QoKTsgfQogICAgaWYgKE4ucXVlcnkpIGNsZWFyU2VhcmNoKCk7CiAgICBzZXRWaWV3KCk7CiAgfQoKICAvLyBIb3cgZmFyIGZyb20gdGhlIHNjcmF0Y2hwYWQ6IDAgdGhlcmUsIDEgaW4gdGhlIGxpc3Qgb3IgYSBub3RlIG9wZW5lZAogIC8vIGZyb20gdGhlIHNjcmF0Y2hwYWQsIDIgaW4gYSBub3RlIG9wZW5lZCBmcm9tIHRoZSBsaXN0LgogIGZ1bmN0aW9uIGRlcHRoKCkgewogICAgY29",
"uc3QgaW5Ob3RlID0gISEoTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCk7CiAgICByZXR1cm4gKE4uYnJvd3NpbmcgPyAxIDogMCkgKyAoaW5Ob3RlID8gMSA6IDApOwogIH0KCiAgZnVuY3Rpb24gZHJhd0VkaXRvcigpIHsKICAgIGlmICghZWxzLmVkaXRvcikgcmV0dXJuOwogICAgc2V0VmlldygpOwogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYykgcmV0dXJuOwogICAgZWxzLmVkaXRvci5jbGFzc0xpc3QudG9nZ2xlKCdzY3JhdGNoJywgISFjLnNjcmF0Y2gpOwoKICAgIGVscy5iYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtYmFyJyB9KTsKICAgIGVscy5iYW5uZXJTbG90ID0gaCgnZGl2JywgeyBjbGFzczogJ25lLWJhbm5lci1zbG90JyB9KTsKICAgIGNvbnN0IHRpdGxlID0gYy5zY3JhdGNoID8gaCgnaDInLCB7IGNsYXNzOiAnbmUtdGl0bGUgc2NyYXRjaC10aXRsZScsIGRhdGFzZXQ6IHsga2V5OiAnc2NyYXRjaC10aXRsZScgfSB9LAogICAgICBpY29uKCdlZGl0JywgMjIpLCBoKCdzcGFuJywgeyBjbGFzczogJ3N0LW5hbWUnLCB0ZXh0OiBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUgfSkpIDogaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAnbmUtdGl0bGUnLCB0eXBlOiAndGV4dCcsIHBsYWNlaG9sZGVyOiAnVGl0bGUnLCAnYXJpYS1sYWJlbCc6ICdUaXRsZScsCiAgICAgIHZhbHVlOiBjLnRpdGxlLCBtYXhsZW5ndGg6IFN0cmluZyhub3Rlc0xvZ2ljLk1BWF9USVRMRSksIGR",
"hdGFzZXQ6IHsga2V5OiAnbm90ZS10aXRsZScgfSwKICAgICAgZGlzYWJsZWQ6IGMuYm9keVN0YXRlICE9PSAncmVhZHknLAogICAgICBvbmlucHV0OiBlID0-IGVkaXRlZChjLCB7IHRpdGxlOiBlLnRhcmdldC52YWx1ZSB9KSwKICAgICAgb25rZXlkb3duOiBlID0-IHsKICAgICAgICAvLyBFbnRlciBpbiB0aGUgdGl0bGUgY2FycmllcyBvbiBpbnRvIHRoZSBib2R5LCBhcyBpbiBtb3N0IGVkaXRvcnMuCiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFlLmlzQ29tcG9zaW5nKSB7IGUucHJldmVudERlZmF1bHQoKTsgZm9jdXNGaWVsZCgnbm90ZS1ib2R5Jyk7IH0KICAgICAgfSwKICAgIH0pOwogICAgLy8gQSBmcmVzaCBlZGl0b3IgcGVyIG5vdGU6IGl0cyB1bmRvIGhpc3RvcnkgYmVsb25ncyB0byB0aGF0IG5vdGUuCiAgICBpZiAoZWxzLmVkKSBlbHMuZWQuZGVzdHJveSgpOwogICAgY29uc3QgZWQgPSBucy5ub3RlRWRpdG9yLmNyZWF0ZSh7IHJvb3Q6IE4uY3R4LnJvb3QsIG9uQ2hhbmdlOiAoKSA9PiBlZGl0ZWQoYywgeyBkb2M6IGVkLmdldERvYygpIH0pIH0pOwogICAgZWxzLmVkID0gZWQ7CiAgICBlZC5zZXREb2MoYy5kb2MgfHwgZm10LmVtcHR5RG9jKCkpOwogICAgZWQuc2V0RWRpdGFibGUoYy5ib2R5U3RhdGUgPT09ICdyZWFkeScsCiAgICAgIGMuYm9keVN0YXRlID09PSAnbG9hZGluZycgPyAnTG9hZGluZ-KApicgOiBjLmJvZHlTdGF0ZSA9PT0gJ2Vycm9yJyA_ICdDb3VsZG7igJl0IGxvYWQ",
"gdGhpcyBub3RlLicKICAgICAgICA6IGMuc2NyYXRjaCA_IGBKb3QgYW55dGhpbmcgZG93bi4gSXQgc2F2ZXMgYXMgeW91IHR5cGUsIGFzIGEgbm90ZSBpbiBHbWFpbCB1bmRlciDigJwke25vdGVzU3RvcmUubGFiZWxOYW1lKCl94oCdLmAgOiAnV3JpdGUgaGVyZeKApicpOwoKICAgIGVscy5maW5kU2xvdCA9IGgoJ2RpdicsIHsgY2xhc3M6ICduZS1maW5kLXNsb3QnIH0pOwogICAgZWxzLmVkaXRvci5yZXBsYWNlQ2hpbGRyZW4oZWxzLmJhciwgZWxzLmJhbm5lclNsb3QsIGVscy5maW5kU2xvdCwgdGl0bGUsIGVkLnRvb2xiYXIsIGVkLmxpbmtiYXIsIGVkLmVsZW1lbnQpOwogICAgZHJhd0JhcigpOwogICAgZHJhd0ZpbmQoKTsKICB9CgogIC8vIFRoZSBzdHJpcCBhYm92ZSB0aGUgdGV4dDogc3RhdHVzLCBidXR0b25zLCBhbmQgdGhlIGJhbm5lciBmb3IgYW4KICAvLyBlbWFpbGVkIG5vdGUuIFJlZHJhd24gb24gaXRzIG93biBhZnRlciBhIHNhdmUgLSB0aGUgZmlyc3Qgc2F2ZSBvZiBhCiAgLy8gbmV3IG5vdGUgZ2FpbnMgYW4gIk9wZW4gaW4gR21haWwiLCBhbiBlbWFpbGVkIG9uZSBsb3NlcyBpdHMgYmFubmVyIC0KICAvLyB3aXRob3V0IHRvdWNoaW5nIHRoZSB0ZXh0IGJveGVzIHRoZSB1c2VyIG1heSBzdGlsbCBiZSB0eXBpbmcgaW4uCiAgZnVuY3Rpb24gZHJhd0JhcigpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMgfHwgIWVscy5iYXIpIHJldHVybjsKICAgIGNvbnN0IGZvcmVpZ24gPSA",
"hIShjLm5vdGUgJiYgIWMubm90ZS5vd24pOwogICAgZWxzLnN0YXR1cyA9IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmUtc3RhdHVzJywgJ2FyaWEtbGl2ZSc6ICdwb2xpdGUnIH0pOwogICAgLy8gVGhlIHNjcmF0Y2hwYWQncyBzdGF0dXMgc2l0cyBvbiBpdHMgdGl0bGUgbGluZTogdGhlcmUgaXMgbm90aGluZwogICAgLy8gZWxzZSBmb3IgYSBiYXIgdG8gaG9sZC4KICAgIGlmIChjLnNjcmF0Y2gpIHsKICAgICAgZWxzLmJhci5yZXBsYWNlQ2hpbGRyZW4oKTsKICAgICAgZWxzLmJhbm5lclNsb3QucmVwbGFjZUNoaWxkcmVuKCcnKTsKICAgICAgY29uc3QgbGluZSA9IGVscy5lZGl0b3IucXVlcnlTZWxlY3RvcignLnNjcmF0Y2gtdGl0bGUnKTsKICAgICAgY29uc3Qgb2xkID0gbGluZSAmJiBsaW5lLnF1ZXJ5U2VsZWN0b3IoJy5uZS1zdGF0dXMnKTsKICAgICAgaWYgKG9sZCkgb2xkLnJlcGxhY2VXaXRoKGVscy5zdGF0dXMpOwogICAgICBlbHNlIGlmIChsaW5lKSBsaW5lLmFwcGVuZChlbHMuc3RhdHVzKTsKICAgICAgZHJhd1N0YXR1cygpOwogICAgICByZXR1cm47CiAgICB9CiAgICBlbHMuYmFyLnJlcGxhY2VDaGlsZHJlbigKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4gbmUtYmFjaycsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdCYWNrIHRvIHRoZSBsaXN0JywgdGl0bGU6ICdCYWNrIHRvIHRoZSBsaXN0JywKICAgICAgICBkYXRhc2V0OiB7IGtleTogJ25vdGUtYmFjayc",
"gfSwgb25jbGljazogKCkgPT4gY2xvc2VOb3RlKCksCiAgICAgIH0sIGljb24oJ2JhY2snKSksCiAgICAgIGVscy5zdGF0dXMsCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICduZS1mb2xkZXInLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywKICAgICAgICB0aXRsZTogJ01vdmUgdG8gYW5vdGhlciBmb2xkZXInLCBkYXRhc2V0OiB7IGtleTogJ25vdGUtZm9sZGVyJyB9LAogICAgICAgIG9uY2xpY2s6IGUgPT4gY2hvb3NlRm9sZGVyKGUuY3VycmVudFRhcmdldCksCiAgICAgIH0sIGljb24oJ2ZvbGRlcicsIDE4KSwgaCgnc3BhbicsIHsgdGV4dDogYy5mb2xkZXJJZCA_IGZvbGRlckxhYmVsKGMuZm9sZGVySWQpIHx8ICdObyBmb2xkZXInIDogJ05vIGZvbGRlcicgfSksIGljb24oJ2NhcmV0JywgMTgpKSwKICAgICAgYy5ub3RlID8gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnT3BlbiBpbiBHbWFpbCcsIHRpdGxlOiAnT3BlbiBpbiBHbWFpbCcsCiAgICAgICAgZGF0YXNldDogeyBrZXk6ICdub3RlLW9wZW4nIH0sIG9uY2xpY2s6ICgpID0-IG9wZW5JbkdtYWlsKGMpLAogICAgICB9LCBpY29uKCdvcGVuJykpIDogbnVsbCwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXN",
"zOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiBmb3JlaWduID8gJ1Rha2Ugb2ZmIHRoZSBub3RlcyBsaXN0JyA6ICdEZWxldGUgbm90ZScsCiAgICAgICAgdGl0bGU6IGZvcmVpZ24gPyAnVGFrZSBvZmYgdGhlIG5vdGVzIGxpc3QgKHRoZSBlbWFpbCBzdGF5cyknIDogJ0RlbGV0ZSAobW92ZXMgaXQgdG8gR21haWzigJlzIFRyYXNoKScsCiAgICAgICAgZGF0YXNldDogeyBrZXk6ICdub3RlLWRlbGV0ZScgfSwgb25jbGljazogKCkgPT4gZGVsZXRlQ3VycmVudCgpLAogICAgICB9LCBpY29uKCdkZWxldGUnKSkpOwogICAgZWxzLmJhbm5lclNsb3QucmVwbGFjZUNoaWxkcmVuKGZvcmVpZ24gPyBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbmUtYmFubmVyJywKICAgICAgdGV4dDogYFRoaXMgb25lIGlzIGFuIGVtYWlsIGZpbGVkIHVuZGVyIOKAnCR7bm90ZXNTdG9yZS5sYWJlbE5hbWUoKX3igJ0uIEVkaXRpbmcgaXQgc2F2ZXMgYSBuZXcgbm90ZSBpbiBpdHMgcGxhY2U7IGAgKwogICAgICAgICd0aGUgZW1haWwgaXRzZWxmIHN0YXlzIGluIEdtYWlsLCBqdXN0IG9mZiB0aGlzIGxpc3QuJywKICAgIH0pIDogJycpOwogICAgZHJhd1N0YXR1cygpOwogIH0KCiAgZnVuY3Rpb24gZHJhd1N0YXR1cygpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWVscy5zdGF0dXMgfHwgIWMpIHJldHVybjsKICAgIGxldCB0ZXh0OwogICAgaWYgKGMuc2F2aW5nKSB0ZXh0ID0gJ1NhdmluZ-K",
"Apic7CiAgICBlbHNlIGlmIChjLmVycm9yICYmIGMuYm9keVN0YXRlID09PSAncmVhZHknKSB0ZXh0ID0gYENvdWxkbuKAmXQgc2F2ZTogJHtjLmVycm9yfWA7CiAgICBlbHNlIGlmIChjLmRpcnR5KSB0ZXh0ID0gJ1Vuc2F2ZWQgY2hhbmdlcyc7CiAgICBlbHNlIGlmIChjLnNhdmVkQXQpIHRleHQgPSBgU2F2ZWQgJHt1dGlsLmFnb1RleHQoRGF0ZS5ub3coKSAtIGMuc2F2ZWRBdCl9YDsKICAgIGVsc2UgaWYgKGMubm90ZSkgdGV4dCA9IGBMYXN0IHNhdmVkICR7dXRpbC5yZWxhdGl2ZURhdGUoYy5ub3RlLnVwZGF0ZWQpfWA7CiAgICBlbHNlIHRleHQgPSBjLnNjcmF0Y2ggPyAnJyA6ICdOZXcgbm90ZSc7CiAgICBlbHMuc3RhdHVzLnRleHRDb250ZW50ID0gdGV4dDsKICAgIGVscy5zdGF0dXMuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCAhIShjLmVycm9yICYmICFjLnNhdmluZyAmJiBjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykpOwogICAgZWxzLnN0YXR1cy50aXRsZSA9IGMubm90ZSA_IHV0aWwuZnVsbERhdGUoYy5ub3RlLnVwZGF0ZWQpIDogJyc7CiAgfQoKICAvLyDilIDilIAgU2F2aW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5",
"jdGlvbiBlZGl0ZWQoYywgY2hhbmdlKSB7CiAgICBPYmplY3QuYXNzaWduKGMsIGNoYW5nZSk7CiAgICBjLmRpcnR5ID0gdHJ1ZTsKICAgIGMuZXJyb3IgPSAnJzsKICAgIGRyYXdTdGF0dXMoKTsKICAgIGlmIChjaGFuZ2UuZG9jICYmIE4udGVybXMubGVuZ3RoKSB7CiAgICAgIGNsZWFyVGltZW91dChmaW5kVGltZXIpOwogICAgICBmaW5kVGltZXIgPSBzZXRUaW1lb3V0KGFwcGx5SGlnaGxpZ2h0cywgMzAwKTsKICAgIH0KICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpOwogICAgc2F2ZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBzYXZlKGMpLCBBVVRPU0FWRV9NUyk7CiAgfQoKICAvLyBTYXZlcyBhcmUgY2hhaW5lZDogZWFjaCBvbmUgcmV0aXJlcyB0aGUgdmVyc2lvbiB0aGUgcHJldmlvdXMgb25lCiAgLy8gd3JvdGUsIHNvIHR3byBpbiBmbGlnaHQgYXQgb25jZSB3b3VsZCBlYWNoIGxlYXZlIGEgc3RyYXkgYmVoaW5kLgogIGZ1bmN0aW9uIHNhdmUoYykgewogICAgTi5jaGFpbiA9IE4uY2hhaW4udGhlbihhc3luYyAoKSA9PiB7CiAgICAgIGlmICghYy5kaXJ0eSkgcmV0dXJuOwogICAgICAvLyBBbiB1bnRvdWNoZWQgbmV3IG5vdGUgaXMgbm90IHdvcnRoIGEgbWVzc2FnZS4KICAgICAgaWYgKCFjLm5vdGUgJiYgKGMuc2NyYXRjaCB8fCAhYy50aXRsZS50cmltKCkpICYmIGZtdC5pc0VtcHR5KGMuZG9jKSkgeyBjLmRpcnR5ID0gZmFsc2U7IHJldHVybjsgfQogICAgICBjb25zdCBzbmFwID0geyB0aXRsZTogYy5",
"0aXRsZSwgZG9jOiBjLmRvYywgZm9sZGVySWQ6IGMuZm9sZGVySWQsIG5vdGVJZDogYy5zY3JhdGNoID8gbm90ZXNMb2dpYy5TQ1JBVENIUEFEX0lEIDogJycgfTsKICAgICAgLy8gQSBzY3JhdGNocGFkIHN0YXJ0ZWQgaGVyZSB3aGlsZSBhbm90aGVyIGNvbXB1dGVyIHN0YXJ0ZWQgb25lIHRvbzoKICAgICAgLy8gdGhlIG90aGVyJ3MgdmVyc2lvbiBpcyByZXRpcmVkLCBhcyBhbnkgb2xkZXIgdmVyc2lvbiBpcy4KICAgICAgY29uc3QgYmVmb3JlID0gYy5ub3RlIHx8IChjLnNjcmF0Y2ggPyBOLnNjcmF0Y2hOb3RlIDogbnVsbCk7CiAgICAgIGMuZGlydHkgPSBmYWxzZTsKICAgICAgYy5zYXZpbmcgPSB0cnVlOwogICAgICBkcmF3U3RhdHVzKCk7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBub3Rlc1N0b3JlLnNhdmUoaG9va3MuZ2V0QWNjb3VudCgpLCBiZWZvcmUsIHNuYXApOwogICAgICAgIGNvbnN0IG9sZEtleSA9IGMua2V5OwogICAgICAgIGNvbnN0IHdhc091cnMgPSAhIShiZWZvcmUgJiYgYmVmb3JlLm93bik7CiAgICAgICAgYy5ub3RlID0gc2F2ZWQ7CiAgICAgICAgYy5rZXkgPSBzYXZlZC5rZXk7CiAgICAgICAgYy5zYXZlZEF0ID0gRGF0ZS5ub3coKTsKICAgICAgICBpZiAoYy5zY3JhdGNoKSB7IE4uc2NyYXRjaE5vdGUgPSBzYXZlZDsgTi5zY3JhdGNoS25vd24gPSB0cnVlOyB9CiAgICAgICAgYy5lcnJvciA9ICcnOwogICAgICAgIE4ubm90ZXMgPSBbc2F2ZWQsIC4uLk4ubm9",
"0ZXMuZmlsdGVyKG4gPT4gbi5rZXkgIT09IG9sZEtleSAmJiBuLmtleSAhPT0gc2F2ZWQua2V5KV07CiAgICAgICAgLy8gQSBmaXJzdCBzYXZlIGlzIG9uZSBtb3JlIG5vdGU6IHRoZSBjb3VudHMgYnkgdGhlIGZvbGRlcnMgY2hhbmdlLgogICAgICAgIGlmICghYmVmb3JlKSBkcmF3Rm9sZGVycygpOwogICAgICAgIGlmICghd2FzT3VycyAmJiBOLmN1cnJlbnQgPT09IGMpIGRyYXdCYXIoKTsKICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgYy5kaXJ0eSA9IHRydWU7CiAgICAgICAgYy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgIH0gZmluYWxseSB7CiAgICAgICAgYy5zYXZpbmcgPSBmYWxzZTsKICAgICAgICBpZiAoTi5jdXJyZW50ID09PSBjKSBkcmF3U3RhdHVzKCk7CiAgICAgICAgZHJhd0xpc3QoKTsKICAgICAgfQogICAgfSk7CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIFdoYXRldmVyIGlzIHBlbmRpbmcsIG5vdy4gQ2FsbGVkIG9uIEN0cmwrUywgb24gc3dpdGNoaW5nIG5vdGVzIG9yCiAgLy8gdGFicywgYW5kIHdoZW4gdGhlIGJvYXJkIGNsb3Nlcy4KICBmdW5jdGlvbiBmbHVzaCgpIHsKICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpOwogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIHJldHVybiBjICYmIGMuZGlydHkgPyBzYXZlKGMpIDogTi5jaGFpbjsKICB9Cgo",
"gIC8vIOKUgOKUgCBPdGhlciBhY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBhc3luYyBmdW5jdGlvbiBvcGVuSW5HbWFpbChjKSB7CiAgICBhd2FpdCBmbHVzaCgpOwogICAgaWYgKCFjLm5vdGUgfHwgIWMubm90ZS50aHJlYWRJZCkgcmV0dXJuOwogICAgTi5jdHguY2xvc2VCb2FyZCgpOwogICAgaG9va3Mub3BlblRocmVhZChjLm5vdGUudGhyZWFkSWQpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZGVsZXRlQ3VycmVudCgpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMgfHwgYy5zY3JhdGNoKSByZXR1cm47CiAgICBjbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTsKICAgIGF3YWl0IE4uY2hhaW47CiAgICBOLmN1cnJlbnQgPSBudWxsOwogICAgc2hvd1NjcmF0Y2goKTsKICAgIGNvbnN0IG5vdGUgPSBjLm5vdGU7CiAgICBpZiAoIW5vdGUpIHsgZHJhd0xpc3QoKTsgcmV0dXJuOyB9IC8vIG5ldmVyIHNhdmVkOiBub3RoaW5nIGluIEdtYWlsCgogICAgY29uc3QgYXQgPSBOLm5vdGVzLmZpbmRJbmRleChuID0-IG4ua2V5ID09PSBub3RlLmtleSk7CiAgICBOLm5vdGVzID0gTi5ub3Rlcy5maWx0ZXIobiA9PiBuLmtleSAhPT0gbm90ZS5rZXkpOwogICAgZHJ",
"hd0xpc3QoKTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IG5vdGVzU3RvcmUucmV0aXJlKG5vdGUpOwogICAgICB0b2FzdChOLmN0eC5yb290LCBub3RlLm93bgogICAgICAgID8gJ05vdGUgbW92ZWQgdG8gR21haWzigJlzIFRyYXNoLicKICAgICAgICA6IGBUYWtlbiBvZmYgdGhlIG5vdGVzIGxpc3QuIFRoZSBlbWFpbCBzdGF5cyBpbiBHbWFpbC5gLCB7CiAgICAgICAgYWN0aW9uOiB7IGxhYmVsOiAnVW5kbycsIG9uQ2xpY2s6ICgpID0-IHVuZG9EZWxldGUobm90ZSwgYXQpIH0sCiAgICAgICAgdGltZW91dDogODAwMCwKICAgICAgfSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgTi5ub3Rlcy5zcGxpY2UoTWF0aC5tYXgoMCwgYXQpLCAwLCBub3RlKTsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgZGVsZXRlIOKAnCR7bm90ZS50aXRsZX3igJ06ICR7ZXJyLm1lc3NhZ2V9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogICAgfQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gdW5kb0RlbGV0ZShub3RlLCBhdCkgewogICAgdHJ5IHsKICAgICAgYXdhaXQgbm90ZXNTdG9yZS5yZXN0b3JlKG5vdGUpOwogICAgICBOLm5vdGVzLnNwbGljZShNYXRoLm1heCgwLCBNYXRoLm1pbihhdCwgTi5ub3Rlcy5sZW5ndGgpKSwgMCwgbm90ZSk7CiAgICAgIGRyYXdMaXN0KCk7CiAgICAgIG9wZW5Ob3RlKG5vdGUsIHsgZm9yY2U6IHRydWUgfSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgdG9",
"hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgYnJpbmcgaXQgYmFjazogJHtlcnIubWVzc2FnZX0uIEl0IGlzIHN0aWxsIGluIEdtYWls4oCZcyBUcmFzaC5gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICB9CiAgfQoKICAvLyBDdHJsK1MgKOKMmFMpIHNhdmVzIG5vdyBpbnN0ZWFkIG9mIENocm9tZSdzICJTYXZlIHBhZ2UgYXMiLgogIGZ1bmN0aW9uIGhhbmRsZUtleShlKSB7CiAgICBpZiAoKGUuY3RybEtleSB8fCBlLm1ldGFLZXkpICYmICFlLmFsdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAncycpIHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBmbHVzaCgpOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0KICAgIGlmIChlLmtleSA9PT0gJ0YzJyAmJiBOLnRlcm1zLmxlbmd0aCAmJiBlbHMuZWQpIHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBzdGVwTWF0Y2goZS5zaGlmdEtleSA_IC0xIDogMSk7CiAgICAgIHJldHVybiB0cnVlOwogICAgfQogICAgcmV0dXJuIGZhbHNlOwogIH0KCiAgLy8gQ2FsbGVkIGV2ZXJ5IGZldyBzZWNvbmRzIHdoaWxlIHRoZSBib2FyZCBpcyBvcGVuLCBmb3IgIlNhdmVkIDVzIGFnbyIuCiAgZnVuY3Rpb24gdGljaygpIHsKICAgIGRyYXdTdGF0dXMoKTsKICB9CgogIC8vIFR5cGluZyBnb2VzIHN0cmFpZ2h0IGludG8gdGhlIHNjcmF0Y2hwYWQgLSBvciwgd2l0aCBhbm90aGVyIG5vdGUKICAvLyBvcGVuLCBpbnRvIHRoYXQuCiAgZnVuY3Rpb24gZm9",
"jdXNEZWZhdWx0KCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmIChjICYmIGMuc2NyYXRjaCkgewogICAgICBOLndhbnRGb2N1cyA9IHRydWU7CiAgICAgIHNjcmF0Y2hSZWFkeSgpOwogICAgfSBlbHNlIGlmIChjKSBmb2N1c0ZpZWxkKGMuYm9keVN0YXRlID09PSAncmVhZHknICYmIGMudGl0bGUgPyAnbm90ZS1ib2R5JyA6ICdub3RlLXRpdGxlJyk7CiAgICBlbHNlIGlmIChlbHMuc2VhcmNoKSBlbHMuc2VhcmNoLmZvY3VzKCk7CiAgfQoKICBucy5ub3RlcyA9IHsKICAgIGluaXQsIGVsZW1lbnQsIGxvYWQsIGlzU3RhbGUsIGZsdXNoLCBoYW5kbGVLZXksIHRpY2ssIGZvY3VzRGVmYXVsdCwgY2xvc2VOb3RlLCBiYWNrLCBkZXB0aCwKICAgIC8vIEEgbm90ZSBvdGhlciB0aGFuIHRoZSBzY3JhdGNocGFkLgogICAgaXNPcGVuOiAoKSA9PiAhIShOLmN1cnJlbnQgJiYgIU4uY3VycmVudC5zY3JhdGNoKSwKICAgIGxvYWRlZEF0OiAoKSA9PiBOLmxvYWRlZEF0LAogICAgaXNMb2FkaW5nOiAoKSA9PiAhIU4ubG9hZGluZywKICB9Owp9KSgpOwo\"],[\"src/content/calendar-store.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIENhbGVuZGFyIGRhdGEKLy8KLy8gR29vZ2xlIENhbGVuZGFyJ3MgZXZlbnRzIGFuZCBHb29nbGUgVGFza3MnIHRhc2tzLCByZWFkIHRocm91Z2ggdGhlCi8vIGJhY2tncm91bmQgd29ya2VyIHdpdGggdGhlIGNhbGVuZGFyJ3Mgb3duIHNpZ24taW4gKG9yLCBpbiB0aGUgcGhvbmUKLy8gYXBwLCB0aHJvdWdoIGl0cyBzY3JpcHQpLiBUd28ga2luZHMgb2YgcmVhZDogdGhlIHNvdXJjZXMgLSB3aGljaAovLyBjYWxlbmRhcnMgYW5kIHRhc2sgbGlzdHMgdGhlcmUgYXJlIC0ga2VwdCBmb3IgdGVuIG1pbnV0ZXMsIGFuZCB3aGF0IGlzCi8vIG9uIGluIGEgcmFuZ2Ugb2YgZGF5cywgZm9yIHRoZSBzb3VyY2VzIHRoYXQgYXJlIHN3aXRjaGVkIG9uLgovLwovLyBUcm91YmxlIHdpdGggdGhlIHNpZ24taW4gaXMgdGhyb3duLCBmb3IgdGhlIHZpZXcncyBwYW5lbDsgdHJvdWJsZSB3aXRoCi8vIG9uZSBzZXJ2aWNlIChUYXNrcyBub3QgYWxsb3dlZCwgc2F5KSBjb21lcyBiYWNrIHdpdGggdGhlIHJlc3QsIHNvIGEKLy8gY2FsZW5kYXIgc3RpbGwgc2hvd3Mgd2hlbiB0aGUgdGFza3MgY2Fubm90LgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCBjYWwgPSBucy5jYWxlbmRhckxvZ2ljOwoKICBjb25zdCBTT1VSQ0VTX01TID0gMTAgKiA2MCAqIDEwMDA7CgogIC8vIENvZGVzIHRoYXQgYXJlIGFib3V0IHRoZSBzaWduLWluLCBub3QgYWJvdXQgb25lIGNhbGVuZGFyIG9yIGxpc3QuCiAgY29uc3QgU0lHTl9JTiA9IG5ldyBTZXQoWydub3RfY29uZmlndXJlZCcsICdjYWxlbmRhcl9hdXRoX3JlcXVpcmVkJywgJ2NhbGVuZGFyX21pc21hdGNoJywgJ2V4dGVuc2lvbl9yZWxvYWRlZCddKTsKCiAgY29uc3QgUyA9IHsKICAgIGFjY291bnQ6ICcnLAogICAgc291cmNlczogbnVsbCwgICAvLyBjYWxlbmRhckxvZ2ljLnNvdXJjZXMoKQogICAgZXJyb3JzOiB7fSwgICAgICAvLyBzZXJ2aWNlIOKGkiBlcnJvciwgZnJvbSB0aGUgbGFzdCBzb3VyY2VzIHJlYWQKICAgIGF0OiAwLAogIH07CgogIGZ1bmN0aW9uIHRocm93U2lnbkluKHJlc3VsdHMpIHsKICAgIGNvbnN0IGJhZCA9IHJlc3VsdHMuZmluZChyID0-IHIgJiYgci5lcnJvciAmJiBTSUdOX0lOLmhhcyhyLmVycm9yLmNvZGUpKTsKICAgIGlmIChiYWQpIHRocm93IGJhZC5lcnJvcjsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKGFjY291bnQ",
"sIHsgZm9yY2UgPSBmYWxzZSB9ID0ge30pIHsKICAgIGlmIChTLmFjY291bnQgIT09IGFjY291bnQpIHsKICAgICAgUy5hY2NvdW50ID0gYWNjb3VudDsKICAgICAgUy5zb3VyY2VzID0gbnVsbDsKICAgIH0KICAgIGlmICghZm9yY2UgJiYgUy5zb3VyY2VzICYmIERhdGUubm93KCkgLSBTLmF0IDwgU09VUkNFU19NUykgcmV0dXJuIHsgc291cmNlczogUy5zb3VyY2VzLCBlcnJvcnM6IFMuZXJyb3JzIH07CiAgICBjb25zdCBbY2FsZW5kYXJzLCBsaXN0c10gPSBhd2FpdCBucy5hcGkuZ29vZ2xlTWFueShjYWwuc291cmNlUmVxdWVzdHMoKSk7CiAgICB0aHJvd1NpZ25JbihbY2FsZW5kYXJzLCBsaXN0c10pOwogICAgY29uc3QgZXJyb3JzID0ge307CiAgICBpZiAoY2FsZW5kYXJzLmVycm9yKSBlcnJvcnMuY2FsZW5kYXIgPSBjYWxlbmRhcnMuZXJyb3I7CiAgICBpZiAobGlzdHMuZXJyb3IpIGVycm9ycy50YXNrcyA9IGxpc3RzLmVycm9yOwogICAgLy8gQSBzZXJ2aWNlIHRoYXQgZmFpbGVkIHRoaXMgdGltZSBrZWVwcyB0aGUgc291cmNlcyBpdCBoYWQuCiAgICBjb25zdCBrZXB0ID0ga2luZCA9PiAoUy5zb3VyY2VzIHx8IFtdKS5maWx0ZXIocyA9PiBzLmtpbmQgPT09IGtpbmQpOwogICAgY29uc3QgZnJlc2ggPSBjYWwuc291cmNlcyhjYWxlbmRhcnMuZXJyb3IgPyBbXSA6IGNhbGVuZGFycy5pdGVtcywgbGlzdHMuZXJyb3IgPyBbXSA6IGxpc3RzLml0ZW1zKTsKICAgIFMuc291cmNlcyA9IFsKICAgICAgLi4uKGNhbGV",
"uZGFycy5lcnJvciA_IGtlcHQoJ2NhbGVuZGFyJykgOiBmcmVzaC5maWx0ZXIocyA9PiBzLmtpbmQgPT09ICdjYWxlbmRhcicpKSwKICAgICAgLi4uKGxpc3RzLmVycm9yID8ga2VwdCgndGFza3MnKSA6IGZyZXNoLmZpbHRlcihzID0-IHMua2luZCA9PT0gJ3Rhc2tzJykpLAogICAgXTsKICAgIFMuZXJyb3JzID0gZXJyb3JzOwogICAgUy5hdCA9IERhdGUubm93KCk7CiAgICByZXR1cm4geyBzb3VyY2VzOiBTLnNvdXJjZXMsIGVycm9ycyB9OwogIH0KCiAgLy8gV2hhdCBpcyBvbiBmcm9tIHJhbmdlLnN0YXJ0IHVwIHRvIHJhbmdlLmVuZCwgZnJvbSB0aGUgZ2l2ZW4gc291cmNlcy4KICBhc3luYyBmdW5jdGlvbiBsb2FkUmFuZ2UocmFuZ2UsIHNvdXJjZXMpIHsKICAgIGNvbnN0IGNhbGVuZGFycyA9IHNvdXJjZXMuZmlsdGVyKHMgPT4gcy5raW5kID09PSAnY2FsZW5kYXInKTsKICAgIGNvbnN0IGxpc3RzID0gc291cmNlcy5maWx0ZXIocyA9PiBzLmtpbmQgPT09ICd0YXNrcycpOwogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IG5zLmFwaS5nb29nbGVNYW55KGNhbC5yYW5nZVJlcXVlc3RzKHJhbmdlLCBjYWxlbmRhcnMsIGxpc3RzKSk7CiAgICB0aHJvd1NpZ25JbihyZXN1bHRzKTsKCiAgICBjb25zdCBpdGVtcyA9IFtdOwogICAgY29uc3QgZXJyb3JzID0ge307CiAgICBsZXQgaSA9IDA7CiAgICBmb3IgKGNvbnN0IGMgb2YgY2FsZW5kYXJzKSB7CiAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2krK107CiAgICAgIGlmICh",
"yLmVycm9yKSB7IGVycm9ycy5jYWxlbmRhciA9IGVycm9ycy5jYWxlbmRhciB8fCByLmVycm9yOyBjb250aW51ZTsgfQogICAgICBmb3IgKGNvbnN0IGV2IG9mIHIuaXRlbXMgfHwgW10pIHsKICAgICAgICBjb25zdCBpdGVtID0gY2FsLmV2ZW50SXRlbShldiwgYyk7CiAgICAgICAgaWYgKGl0ZW0pIGl0ZW1zLnB1c2goaXRlbSk7CiAgICAgIH0KICAgIH0KICAgIGZvciAoY29uc3QgbCBvZiBsaXN0cykgewogICAgICBmb3IgKGxldCBwYXNzID0gMDsgcGFzcyA8IDI7IHBhc3MrKykgewogICAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2krK107CiAgICAgICAgaWYgKHIuZXJyb3IpIHsgZXJyb3JzLnRhc2tzID0gZXJyb3JzLnRhc2tzIHx8IHIuZXJyb3I7IGNvbnRpbnVlOyB9CiAgICAgICAgZm9yIChjb25zdCB0IG9mIHIuaXRlbXMgfHwgW10pIHsKICAgICAgICAgIGNvbnN0IGl0ZW0gPSBjYWwudGFza0l0ZW0odCwgbCk7CiAgICAgICAgICBpZiAoaXRlbSkgaXRlbXMucHVzaChpdGVtKTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIHJldHVybiB7IGl0ZW1zOiBjYWwudW5pcXVlQnlJZChpdGVtcyksIGVycm9ycyB9OwogIH0KCiAgZnVuY3Rpb24gZm9yZ2V0KCkgewogICAgUy5zb3VyY2VzID0gbnVsbDsKICAgIFMuYXQgPSAwOwogIH0KCiAgbnMuY2FsZW5kYXJTdG9yZSA9IHsgbG9hZFNvdXJjZXMsIGxvYWRSYW5nZSwgZm9yZ2V0LCBTSUdOX0lOIH07Cn0pKCk7Cg\"],[\"src/content/calendar.js\",\"Ly8g4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBjYWxlbmRhciB2aWV3Ci8vCi8vIFRoZSBib2FyZCdzIHRoaXJkIHRhYjogR29vZ2xlIENhbGVuZGFyJ3MgZXZlbnRzIHdpdGggR29vZ2xlIFRhc2tzJwovLyB0YXNrcyBhbW9uZyB0aGVtLCBkYXkgYnkgZGF5LiBSZWFkLW9ubHkgZm9yIG5vdzogYW4gZXZlbnQgb3BlbnMgaW4KLy8gR29vZ2xlIENhbGVuZGFyLCBhIHRhc2sgaW4gR29vZ2xlIFRhc2tzIChvciwgbWFkZSBmcm9tIGFuIGVtYWlsLCB0aGUKLy8gZW1haWwgaXRzZWxmKS4KLy8KLy8gT24gYSBjb21wdXRlciB0aGVyZSBhcmUgdGhyZWUgdmlld3MgLSBXZWVrIChzZXZlbiBjb2x1bW5zKSwgTW9udGggYW5kCi8vIEFnZW5kYSAoZm91ciB3ZWVrcyBhcyBvbmUgbGlzdCkgLSBiZXNpZGUgYSBzbWFsbCBtb250aCwgdGhlIGNhbGVuZGFycwovLyBhbmQgdGFzayBsaXN0cyB0byBzaG93IG9yIGhpZGUsIGFuZCB0aGUgdGFza3Mgd2l0aCBubyBkYXRlLiBOYXJyb3csIGFzCi8vIG9uIGEgcGhvbmUsIGl0IGlzIGFsd2F5cyB0aGUgd2VlazogdHdvIGNvbHVtbnMgb2YgZGF5cyB3aXRoIHRoZS",
"Btb250aAovLyBhcyB0aGUgZWlnaHRoIHRpbGUsIHRoZSBzb3VyY2VzIGFzIGEgcm93IG9mIGNoaXBzIGFib3ZlLCBhbmQgdGhlIHRhc2tzCi8vIHdpdGggbm8gZGF0ZSBiZWxvdy4gQSBzd2lwZSBnb2VzIHRvIHRoZSBuZXh0IG9yIHByZXZpb3VzIHdlZWsuCi8vCi8vIEtleXMsIGFzIGluIEdvb2dsZSBDYWxlbmRhcjogdCB0b2RheSwgaiAvIG4gbmV4dCwgayAvIHAgcHJldmlvdXMsCi8vIHcgLyBtIC8gYSBmb3IgdGhlIHZpZXdzLgovLwovLyBUaGUgYm9hcmQgb3ducyB0aGUgb3ZlcmxheSwgdGhlIGhlYWRlciBhbmQgdGhlIGFjY291bnQgcGFuZWxzOyB0aGlzCi8vIGZpbGUgb3ducyB0aGUgYm9keSB3aGlsZSB0aGUgQ2FsZW5kYXIgdGFiIGlzIHNob3dpbmcuIEl0cyBlbGVtZW50IGlzCi8vIGJ1aWx0IG9uY2UgYW5kIGtlcHQsIGxpa2UgdGhlIG5vdGVzJy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLC",
"B0b2FzdCB9ID0gbnMudWk7CiAgY29uc3QgeyBjYWxlbmRhclN0b3JlOiBzdG9yZSwgaG9va3MsIEFQUF9OQU1FIH0gPSBuczsKICBjb25zdCBjYWwgPSBucy5jYWxlbmRhckxvZ2ljOwoKICBjb25zdCBTVEFMRV9NUyA9IDYwICogMTAwMDsKICBjb25zdCBOQVJST1dfUFggPSA3MjA7CiAgLy8gQSBtb250aCBjZWxsIHNob3dzIHRoaXMgbWFueSwgdGhlbiAiKzIgbW9yZSIuCiAgY29uc3QgTU9OVEhfUk9XUyA9IDQ7CiAgY29uc3QgU1dJUEVfUFggPSA2MDsKCiAgY29uc3QgQyA9IHsKICAgIGN0eDogbnVsbCwgICAgICAgICAgLy8geyByb290LCBvblN0YXRlRXJyb3IsIG9uTG9hZGVkLCBiYXJDaGFuZ2VkLCBwcmVmcywgY29ubmVjdCB9CiAgICB2aWV3OiAnd2VlaycsICAgICAgIC8vIHRoZSB2aWV3IGNob3NlbiBvbiBhIHdpZGUgc2NyZWVuCiAgICBhbmNob3I6ICcnLCAgICAgICAgIC8vIHRoZSBkYXkgaW4gZm9jdXMKICAgIHRvZGF5OiAnJywKICAgIG5hcnJvdzogZmFsc2UsCiAgICBzb3VyY2VzOiBbXSwKICAgIG92ZXJyaWRlczoge30sICAgICAgLy8gc291cmNlIGlkIOKGkiBzaG93biBvciBub3QsIHdoZXJlIGZsaWNrZWQgaGVyZQogICAgcHJlZnNSZWFkOiBmYWxzZSwKICAgIHN0YXR1czogJ2lkbGUnLCAgICAgLy8gaWRsZSB8IGxvYWRpbmcgfCByZWFkeSB8IGVycm9yIHwgc2lnbmluIHwgbWlzbWF0Y2gKICAgIGVycm9yOiAnJywKICAgIGVycm9yczoge30sICAgICAgICAgLy8gc2VydmljZSDihpIgZXJyb3",
"IsIGZvciB0aGUgbm90ZSBhYm92ZSB0aGUgZGF5cwogICAgc2hvd246IG51bGwsICAgICAgICAvLyB7IGtleSwgcmFuZ2UsIGl0ZW1zLCBmZXRjaGVkOiBTZXQsIGVycm9ycywgYXQgfSBvbiBzY3JlZW4KICAgIGNhY2hlOiBuZXcgTWFwKCksICAgLy8gcmFuZ2Uga2V5IOKGkiB0aGUgc2FtZQogICAgbG9hZGluZzogbnVsbCwKICAgIGxvYWRlZEF0OiAwLAogICAgc2VxOiAwLAogIH07CgogIGNvbnN0IGVscyA9IHt9OwogIGxldCB0aW1lRm9ybWF0ID0gbnVsbDsKCiAgLy8g4pSA4pSAIFNldHVwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBpbml0KGN0eCkgewogICAgQy5jdHggPSBjdHg7CiAgICBDLnRvZGF5ID0gY2FsLmRhdGVLZXkobmV3IERhdGUoKSk7CiAgICBDLmFuY2hvciA9IEMudG9kYXk7CiAgfQoKICBmdW5jdGlvbiBlbGVtZW50KCkgewogICAgaWYgKGVscy53cmFwKSByZXR1cm4gZWxzLndyYXA7CgogICAgY29uc3QgbmF2ID0gKGRpciwgbGFiZWwsIG5hbWUpID0-IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCB0aXRsZTogbGFiZWwsICdhcmlhLWxhYmVsJz",
"ogbGFiZWwsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgY2FsLSR7bmFtZX1gIH0sIG9uY2xpY2s6ICgpID0-IGdvKGNhbC5zdGVwKHZpZXcoKSwgQy5hbmNob3IsIGRpcikpLAogICAgfSwgaWNvbihuYW1lLCAyMCkpOwoKICAgIGVscy50aXRsZSA9IGgoJ2gyJywgeyBjbGFzczogJ2NhbC10aXRsZScsICdhcmlhLWxpdmUnOiAncG9saXRlJyB9KTsKICAgIGVscy52aWV3cyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtdmlld3MnLCByb2xlOiAndGFibGlzdCcsICdhcmlhLWxhYmVsJzogJ0NhbGVuZGFyIHZpZXcnIH0sCiAgICAgIGNhbC5WSUVXUy5tYXAodiA9PiBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdzZWcnLCB0eXBlOiAnYnV0dG9uJywgcm9sZTogJ3RhYicsIGRhdGFzZXQ6IHsga2V5OiBgY2FsLXZpZXc6JHt2fWAsIHZpZXc6IHYgfSwKICAgICAgICB0ZXh0OiB2WzBdLnRvVXBwZXJDYXNlKCkgKyB2LnNsaWNlKDEpLCBvbmNsaWNrOiAoKSA9PiBzZXRWaWV3KHYpLAogICAgICB9KSkpOwogICAgZWxzLmhlYWQgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWhlYWQnIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtbmF2JyB9LAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnYnRuIGJ0bi1vdXRsaW5lIGNhbC10b2RheScsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnVG9kYXknLCBkYXRhc2V0OiB7IGtleTogJ2NhbC10b2RheScgfSwKICAgICAgICAgIHRpdGxlOiAnVG9kYX",
"kgKFQpJywgb25jbGljazogKCkgPT4gZ28oY2FsLmRhdGVLZXkobmV3IERhdGUoKSkpLAogICAgICAgIH0pLAogICAgICAgIG5hdigtMSwgJ1ByZXZpb3VzJywgJ3ByZXYnKSwKICAgICAgICBuYXYoMSwgJ05leHQnLCAnbmV4dCcpKSwKICAgICAgZWxzLnRpdGxlLAogICAgICBlbHMudmlld3MpOwoKICAgIGVscy5ub3RlID0gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1ub3RlJywgcm9sZTogJ3N0YXR1cycgfSk7CiAgICBlbHMubWluaSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtbWluaScgfSk7CiAgICBlbHMuc291cmNlcyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtc291cmNlcycsIHJvbGU6ICdncm91cCcsICdhcmlhLWxhYmVsJzogJ0NhbGVuZGFycyBhbmQgdGFzayBsaXN0cycgfSk7CiAgICBlbHMudHJheSA9IGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiAnY2FsLXRyYXknLCAnYXJpYS1sYWJlbCc6ICdUYXNrcyB3aXRob3V0IGEgZGF5JyB9KTsKICAgIGVscy5tYWluID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdjYWwtbWFpbicgfSk7CiAgICBlbHMubWFpbi5hZGRFdmVudExpc3RlbmVyKCd0b3VjaHN0YXJ0Jywgb25Ub3VjaFN0YXJ0LCB7IHBhc3NpdmU6IHRydWUgfSk7CiAgICBlbHMubWFpbi5hZGRFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIG9uVG91Y2hFbmQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTsKCiAgICBlbHMud3JhcCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwnIH0sCiAgICAgIGVscy5oZWFkLAogICAgIC",
"BlbHMubm90ZSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2NhbC1ib2R5JyB9LAogICAgICAgIGgoJ2FzaWRlJywgeyBjbGFzczogJ2NhbC1zaWRlJyB9LCBlbHMubWluaSwgZWxzLnNvdXJjZXMsIGVscy50cmF5KSwKICAgICAgICBlbHMubWFpbikpOwoKICAgIC8vIE5hcnJvdyBvciB3aWRlIGlzIGFib3V0IHRoZSBzcGFjZSB0aGUgdmlldyBoYXMsIG5vdCB0aGUgc2NyZWVuLgogICAgLy8gR29pbmcgbmFycm93IGNhbiBjaGFuZ2UgdGhlIHZpZXcgKHRvIHRoZSB3ZWVrKSwgYW5kIHNvIHRoZSBkYXlzLgogICAgbmV3IFJlc2l6ZU9ic2VydmVyKGVudHJpZXMgPT4gewogICAgICBjb25zdCBuYXJyb3cgPSBlbnRyaWVzWzBdLmNvbnRlbnRSZWN0LndpZHRoIDwgTkFSUk9XX1BYOwogICAgICBpZiAobmFycm93ID09PSBDLm5hcnJvdykgcmV0dXJuOwogICAgICBjb25zdCBiZWZvcmUgPSByYW5nZUtleShyYW5nZSgpKTsKICAgICAgQy5uYXJyb3cgPSBuYXJyb3c7CiAgICAgIGlmIChyYW5nZUtleShyYW5nZSgpKSAhPT0gYmVmb3JlICYmIChDLnN0YXR1cyA9PT0gJ3JlYWR5JyB8fCBDLnN0YXR1cyA9PT0gJ2xvYWRpbmcnKSkgbG9hZCgpOwogICAgICBlbHNlIGRyYXcoKTsKICAgIH0pLm9ic2VydmUoZWxzLndyYXApOwoKICAgIGRyYXcoKTsKICAgIHJldHVybiBlbHMud3JhcDsKICB9CgogIC8vIEEgbmFycm93IHZpZXcgaXMgYWx3YXlzIHRoZSB3ZWVrLgogIGZ1bmN0aW9uIHZpZXcoKSB7CiAgICByZXR1cm4gQy5uYX",
"Jyb3cgPyAnd2VlaycgOiBDLnZpZXc7CiAgfQoKICBmdW5jdGlvbiByYW5nZSgpIHsKICAgIHJldHVybiBjYWwudmlld1JhbmdlKHZpZXcoKSwgQy5hbmNob3IpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVhZFByZWZzKCkgewogICAgaWYgKEMucHJlZnNSZWFkKSByZXR1cm47CiAgICBDLnByZWZzUmVhZCA9IHRydWU7CiAgICB0cnkgewogICAgICBjb25zdCBbdiwgb10gPSBhd2FpdCBQcm9taXNlLmFsbChbQy5jdHgucHJlZnMuZ2V0KCdjYWxlbmRhclZpZXcnKSwgQy5jdHgucHJlZnMuZ2V0KCdjYWxlbmRhclNvdXJjZXMnKV0pOwogICAgICBpZiAoY2FsLlZJRVdTLmluY2x1ZGVzKHYpKSBDLnZpZXcgPSB2OwogICAgICBpZiAobyAmJiB0eXBlb2YgbyA9PT0gJ29iamVjdCcpIEMub3ZlcnJpZGVzID0gbzsKICAgIH0gY2F0Y2ggeyAvKiBzdG9yYWdlIGdvbmUgKGV4dGVuc2lvbiByZWxvYWRlZCk7IGRlZmF1bHRzIHdpbGwgZG8gKi8gfQogIH0KCiAgZnVuY3Rpb24gc2F2ZVByZWYobmFtZSwgdmFsdWUpIHsKICAgIFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gQy5jdHgucHJlZnMuc2V0KG5hbWUsIHZhbHVlKSkuY2F0Y2goKCkgPT4ge30pOwogIH0KCiAgLy8g4pSA4pSAIExvYWRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IGlzT24gPSBzID0-IGNhbC5pc09uKHMsIEMub3ZlcnJpZGVzKTsKICBjb25zdCBvblNvdXJjZXMgPSAoKSA9PiBDLnNvdXJjZXMuZmlsdGVyKGlzT24pOwogIGNvbnN0IHJhbmdlS2V5ID0gciA9PiBgJHtyLnN0YXJ0fXwke3IuZW5kfWA7CgogIC8vIFdoYXQgaXMgb24gc2NyZWVuIGNvdmVycyB0aGUgcmFuZ2UgYW5kIGV2ZXJ5IHNvdXJjZSB0aGF0IGlzIG9uLgogIGZ1bmN0aW9uIGNvdmVycyhlbnRyeSkgewogICAgcmV0dXJuICEhZW50cnkgJiYgb25Tb3VyY2VzKCkuZXZlcnkocyA9PiBlbnRyeS5mZXRjaGVkLmhhcyhzLmlkKSk7CiAgfQoKICBmdW5jdGlvbiBpc1N0YWxlKCkgewogICAgY29uc3QgZW50cnkgPSBDLmNhY2hlLmdldChyYW5nZUtleShyYW5nZSgpKSk7CiAgICByZXR1cm4gQy5zdGF0dXMgIT09ICdyZWFkeScgfHwgIWNvdmVycyhlbnRyeSkgfHwgRGF0ZS5ub3coKSAtIGVudHJ5LmF0ID4gU1RBTEVfTVM7CiAgfQoKICAvLyBTaG93cyB3aGF0ZXZlciBpcyBjYWNoZWQgZm9yIHRoZSByYW5nZSBhdCBvbmNlLCB0aGVuIHJlYWRzIEdvb2dsZQogIC8vIGlmIHRoYXQgaXMgbWlzc2luZywgb2xkIG9yIHNob3J0IG9mIGEgc291cmNlIHRoYXQgaGFzIGJlZW4gc3dpdGNoZWQKICAvLyBvbi4gQSBuZXdlciBsb2FkICh0aGUgbmV4dCB3ZWVrLCB0YXBwZWQgcXVpY2tseSkgb3ZlcnRha2VzIHRoaXMgb25lLgogIG",
"Z1bmN0aW9uIGxvYWQoeyBmb3JjZSA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKCFlbHMud3JhcCkgZWxlbWVudCgpOwogICAgLy8gVGhlIHZpZXcgY2hvc2VuIGxhc3QgdGltZSBkZWNpZGVzIHdoaWNoIGRheXMgdG8gcmVhZC4KICAgIGlmICghQy5wcmVmc1JlYWQpIHJldHVybiByZWFkUHJlZnMoKS50aGVuKCgpID0-IGxvYWQoeyBmb3JjZSB9KSk7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IGtleSA9IHJhbmdlS2V5KHIpOwogICAgY29uc3QgY2FjaGVkID0gQy5jYWNoZS5nZXQoa2V5KTsKICAgIGlmIChjYWNoZWQpIHsKICAgICAgQy5zaG93biA9IGNhY2hlZDsKICAgICAgaWYgKEMuc3RhdHVzID09PSAnaWRsZScpIEMuc3RhdHVzID0gJ3JlYWR5JzsKICAgIH0KICAgIGRyYXcoKTsKICAgIGlmICghZm9yY2UgJiYgIWlzU3RhbGUoKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOwoKICAgIGNvbnN0IHNlcSA9ICsrQy5zZXE7CiAgICBpZiAoIUMuc2hvd24gfHwgQy5zaG93bi5rZXkgIT09IGtleSkgQy5zaG93biA9IG51bGw7CiAgICBpZiAoIUMuc2hvd24gJiYgQy5zdGF0dXMgIT09ICdzaWduaW4nICYmIEMuc3RhdHVzICE9PSAnbWlzbWF0Y2gnKSBDLnN0YXR1cyA9ICdsb2FkaW5nJzsKICAgIGRyYXcoKTsKCiAgICBjb25zdCBydW4gPSAoYXN5bmMgKCkgPT4gewogICAgICB0cnkgewogICAgICAgIGNvbnN0IGFjY291bnQgPSBob29rcy5nZXRBY2NvdW50KCk7CiAgICAgICAgY29uc3QgZ290ID",
"0gYXdhaXQgc3RvcmUubG9hZFNvdXJjZXMoYWNjb3VudCwgeyBmb3JjZSB9KTsKICAgICAgICBDLnNvdXJjZXMgPSBnb3Quc291cmNlczsKICAgICAgICBjb25zdCB3YW50ZWQgPSBvblNvdXJjZXMoKTsKICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzdG9yZS5sb2FkUmFuZ2Uociwgd2FudGVkKTsKICAgICAgICBpZiAoc2VxICE9PSBDLnNlcSkgcmV0dXJuOwogICAgICAgIGNvbnN0IGVudHJ5ID0gewogICAgICAgICAga2V5LCByYW5nZTogciwgaXRlbXM6IHJlc3VsdC5pdGVtcywgYXQ6IERhdGUubm93KCksCiAgICAgICAgICBmZXRjaGVkOiBuZXcgU2V0KHdhbnRlZC5tYXAocyA9PiBzLmlkKSksCiAgICAgICAgICBlcnJvcnM6IE9iamVjdC5hc3NpZ24oe30sIGdvdC5lcnJvcnMsIHJlc3VsdC5lcnJvcnMpLAogICAgICAgIH07CiAgICAgICAgQy5jYWNoZS5zZXQoa2V5LCBlbnRyeSk7CiAgICAgICAgQy5zaG93biA9IGVudHJ5OwogICAgICAgIEMuZXJyb3JzID0gZW50cnkuZXJyb3JzOwogICAgICAgIEMuc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgICBDLmVycm9yID0gJyc7CiAgICAgICAgQy5sb2FkZWRBdCA9IERhdGUubm93KCk7CiAgICAgICAgaWYgKEMuY3R4Lm9uTG9hZGVkKSBDLmN0eC5vbkxvYWRlZCgpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoc2VxICE9PSBDLnNlcSkgcmV0dXJuOwogICAgICAgIGlmIChlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX2F1dGhfcmVxdWlyZWQnKSBDLn",
"N0YXR1cyA9ICdzaWduaW4nOwogICAgICAgIGVsc2UgaWYgKGVyci5jb2RlID09PSAnY2FsZW5kYXJfbWlzbWF0Y2gnKSB7IEMuc3RhdHVzID0gJ21pc21hdGNoJzsgQy5lcnJvciA9IGVyci5tZXNzYWdlOyB9CiAgICAgICAgZWxzZSBpZiAoZXJyLmNvZGUgPT09ICdub3RfY29uZmlndXJlZCcpIHsKICAgICAgICAgIC8vIE5vIGNsaWVudCBJRCBhdCBhbGw6IHRoZSBib2FyZCdzIHNldHVwIHBhbmVsIHNheXMgd2hhdCB0byBkby4KICAgICAgICAgIEMuc3RhdHVzID0gJ2lkbGUnOwogICAgICAgICAgQy5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgICAgfSBlbHNlIGlmIChDLnNob3duKSB7CiAgICAgICAgICBDLnN0YXR1cyA9ICdyZWFkeSc7CiAgICAgICAgICB0b2FzdChDLmN0eC5yb290LCBgQ291bGRu4oCZdCBsb2FkIHRoZSBjYWxlbmRhcjogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIEMuc3RhdHVzID0gJ2Vycm9yJzsKICAgICAgICAgIEMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgICB9CiAgICAgIH0gZmluYWxseSB7CiAgICAgICAgaWYgKEMubG9hZGluZyA9PT0gcnVuKSBDLmxvYWRpbmcgPSBudWxsOwogICAgICAgIGRyYXcoKTsKICAgICAgICBDLmN0eC5iYXJDaGFuZ2VkKCk7CiAgICAgIH0KICAgIH0pKCk7CiAgICBDLmxvYWRpbmcgPSBydW47CiAgICBDLmN0eC5iYXJDaGFuZ2VkKCk7CiAgICByZXR1cm4gcnVuOwogIH0KCi",
"AgYXN5bmMgZnVuY3Rpb24gY29ubmVjdChidG4pIHsKICAgIGlmIChidG4pIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICB0cnkgewogICAgICBhd2FpdCBDLmN0eC5jb25uZWN0KCk7CiAgICAgIEMuc3RhdHVzID0gJ2xvYWRpbmcnOwogICAgICBzdG9yZS5mb3JnZXQoKTsKICAgICAgYXdhaXQgbG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGlmIChlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX21pc21hdGNoJykgewogICAgICAgIEMuc3RhdHVzID0gJ21pc21hdGNoJzsKICAgICAgICBDLmVycm9yID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgZHJhdygpOwogICAgICB9IGVsc2UgaWYgKGVyci5jb2RlID09PSAnbm90X2NvbmZpZ3VyZWQnKSB7CiAgICAgICAgQy5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdG9hc3QoQy5jdHgucm9vdCwgYENvdWxkbuKAmXQgY29ubmVjdDogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgIH0KICAgIH0gZmluYWxseSB7CiAgICAgIGlmIChidG4gJiYgYnRuLmlzQ29ubmVjdGVkKSBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgIH0KICB9CgogIC8vIOKUgOKUgCBNb3ZpbmcgYWJvdXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGdvKGFuY2hvcikgewogICAgaWYgKCFjYWwuaXNLZXkoYW5jaG9yKSkgcmV0dXJuOwogICAgQy5hbmNob3IgPSBhbmNob3I7CiAgICBDLnRvZGF5ID0gY2FsLmRhdGVLZXkobmV3IERhdGUoKSk7CiAgICBsb2FkKCk7CiAgfQoKICBmdW5jdGlvbiBzZXRWaWV3KHYpIHsKICAgIGlmICghY2FsLlZJRVdTLmluY2x1ZGVzKHYpKSByZXR1cm47CiAgICBDLnZpZXcgPSB2OwogICAgc2F2ZVByZWYoJ2NhbGVuZGFyVmlldycsIHYpOwogICAgbG9hZCgpOwogIH0KCiAgZnVuY3Rpb24gdG9nZ2xlU291cmNlKHMpIHsKICAgIEMub3ZlcnJpZGVzID0gT2JqZWN0LmFzc2lnbih7fSwgQy5vdmVycmlkZXMsIHsgW3MuaWRdOiAhaXNPbihzKSB9KTsKICAgIHNhdmVQcmVmKCdjYWxlbmRhclNvdXJjZXMnLCBDLm92ZXJyaWRlcyk7CiAgICAvLyBTd2l0Y2hlZCBvZmY6IGp1c3QgaGlkZGVuLiBTd2l0Y2hlZCBvbiBhbmQgbm90IHJlYWQgeWV0OiByZWFkIG5vdy4KICAgIGlmIChjb3ZlcnMoQy5zaG93bikpIGRyYXcoKTsKICAgIGVsc2UgbG9hZCgpOwogIH0KCiAgbGV0IHRvdWNoID0gbnVsbDsKICBmdW5jdGlvbiBvblRvdWNoU3RhcnQoZSkgewogICAgaWYgKCFDLm5hcnJvdyB8fCBlLnRvdWNoZXMubGVuZ3RoICE9PSAxKSB7IHRvdWNoID0gbnVsbDsgcmV0dXJuOyB9CiAgICB0b3VjaCA9IHsgeDogZS50b3VjaGVzWzBdLmNsaWVudFgsIHk6IG",
"UudG91Y2hlc1swXS5jbGllbnRZIH07CiAgfQogIGZ1bmN0aW9uIG9uVG91Y2hFbmQoZSkgewogICAgaWYgKCF0b3VjaCB8fCAhZS5jaGFuZ2VkVG91Y2hlcy5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IGR4ID0gZS5jaGFuZ2VkVG91Y2hlc1swXS5jbGllbnRYIC0gdG91Y2gueDsKICAgIGNvbnN0IGR5ID0gZS5jaGFuZ2VkVG91Y2hlc1swXS5jbGllbnRZIC0gdG91Y2gueTsKICAgIHRvdWNoID0gbnVsbDsKICAgIGlmIChNYXRoLmFicyhkeCkgPiBTV0lQRV9QWCAmJiBNYXRoLmFicyhkeCkgPiAxLjUgKiBNYXRoLmFicyhkeSkpIGdvKGNhbC5zdGVwKCd3ZWVrJywgQy5hbmNob3IsIGR4IDwgMCA_IDEgOiAtMSkpOwogIH0KCiAgLy8g4pSA4pSAIERyYXdpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRocm91Z2ggdGhlIHN0eWxlIEFQSSwgbm90IGEgc3R5bGUgYXR0cmlidXRlOiBhIHBhZ2UncyBzZWN1cml0eQogIC8vIHBvbGljeSBtYXkgcmVmdXNlIGlubGluZSBzdHlsZSBhdHRyaWJ1dGVzLCBuZXZlciB0aGlzLgogIGZ1bmN0aW9uIHRpbnQoZWwsIG5hbWUsIHZhbHVlKSB7CiAgICBpZiAodmFsdWUpIGVsLnN0eWxlLnNldFByb3Blcn",
"R5KG5hbWUsIHZhbHVlKTsKICAgIHJldHVybiBlbDsKICB9CgogIGZ1bmN0aW9uIGRyYXcoKSB7CiAgICBpZiAoIWVscy53cmFwKSByZXR1cm47CiAgICAvLyBSZWRyYXdpbmcgcmVwbGFjZXMgdGhlIGNoaXBzIGFuZCB0aGUgc21hbGwgbW9udGg7IHdoaWNoZXZlciBvZiB0aGVtCiAgICAvLyBoYWQgdGhlIGZvY3VzIGdldHMgaXQgYmFjaywgb3IgdGhlIG5leHQga2V5IHdvdWxkIGdvIHRvIEdtYWlsLgogICAgY29uc3QgYWN0aXZlID0gQy5jdHgucm9vdC5hY3RpdmVFbGVtZW50OwogICAgY29uc3Qga2V5ID0gYWN0aXZlICYmIGVscy53cmFwLmNvbnRhaW5zKGFjdGl2ZSkgJiYgYWN0aXZlLmRhdGFzZXQgPyBhY3RpdmUuZGF0YXNldC5rZXkgfHwgJycgOiAnJzsKICAgIHBhaW50KCk7CiAgICBpZiAoa2V5ICYmICFlbHMud3JhcC5jb250YWlucyhDLmN0eC5yb290LmFjdGl2ZUVsZW1lbnQpKSB7CiAgICAgIGNvbnN0IGFnYWluID0gWy4uLmVscy53cmFwLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWtleV0nKV0uZmluZCh4ID0-IHguZGF0YXNldC5rZXkgPT09IGtleSAmJiB4LmdldENsaWVudFJlY3RzKCkubGVuZ3RoKTsKICAgICAgaWYgKGFnYWluKSBhZ2Fpbi5mb2N1cyh7IHByZXZlbnRTY3JvbGw6IHRydWUgfSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBwYWludCgpIHsKICAgIGNvbnN0IHYgPSB2aWV3KCk7CiAgICBlbHMud3JhcC5kYXRhc2V0Lm5hcnJvdyA9IFN0cmluZyhDLm5hcnJvdyk7CiAgICBlbHMud3JhcC",
"5kYXRhc2V0LnZpZXcgPSB2OwogICAgZWxzLnRpdGxlLnRleHRDb250ZW50ID0gY2FsLnRpdGxlKHYsIEMuYW5jaG9yLCBDLnRvZGF5KTsKICAgIGZvciAoY29uc3QgYiBvZiBlbHMudmlld3MuY2hpbGRyZW4pIGIuc2V0QXR0cmlidXRlKCdhcmlhLXNlbGVjdGVkJywgU3RyaW5nKGIuZGF0YXNldC52aWV3ID09PSB2KSk7CiAgICBjb25zdCBwYW5lbCA9IHN0YXR1c1BhbmVsKCk7CiAgICBlbHMud3JhcC5jbGFzc0xpc3QudG9nZ2xlKCdjYWwtcGFuZWwnLCAhIXBhbmVsKTsKICAgIGRyYXdOb3RlKCk7CiAgICBkcmF3TWluaSgpOwogICAgZHJhd1NvdXJjZXMoKTsKICAgIGRyYXdUcmF5KCk7CiAgICBpZiAocGFuZWwpIGVscy5tYWluLnJlcGxhY2VDaGlsZHJlbihwYW5lbCk7CiAgICBlbHNlIGlmICh2ID09PSAnbW9udGgnKSBlbHMubWFpbi5yZXBsYWNlQ2hpbGRyZW4oZHJhd01vbnRoKCkpOwogICAgZWxzZSBpZiAodiA9PT0gJ2FnZW5kYScpIGVscy5tYWluLnJlcGxhY2VDaGlsZHJlbihkcmF3QWdlbmRhKCkpOwogICAgZWxzZSBlbHMubWFpbi5yZXBsYWNlQ2hpbGRyZW4oZHJhd1dlZWsoKSk7CiAgfQoKICAvLyBXaGF0IGlzIG9uLCBmcm9tIHRoZSBzb3VyY2VzIHRoYXQgYXJlIG9uLCBieSBkYXkuCiAgZnVuY3Rpb24gdmlzaWJsZUl0ZW1zKCkgewogICAgaWYgKCFDLnNob3duKSByZXR1cm4gW107CiAgICBjb25zdCBvbiA9IG5ldyBTZXQob25Tb3VyY2VzKCkubWFwKHMgPT4gcy5pZCkpOwogICAgcmV0dXJuIEMuc2",
"hvd24uaXRlbXMuZmlsdGVyKHggPT4gb24uaGFzKHguc291cmNlKSk7CiAgfQoKICBmdW5jdGlvbiBzdGF0dXNQYW5lbCgpIHsKICAgIHN3aXRjaCAoQy5zdGF0dXMpIHsKICAgICAgY2FzZSAnc2lnbmluJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2NhbGVuZGFyJywgJ0Nvbm5lY3QgR29vZ2xlIENhbGVuZGFyJywKICAgICAgICAgIGBTZWUgeW91ciBHb29nbGUgQ2FsZW5kYXIgYW5kIEdvb2dsZSBUYXNrcyBoZXJlLCBiZXNpZGUgdGhlIGJvYXJkIGFuZCB0aGUgbm90ZXMuICR7QVBQX05BTUV9IG9ubHkgcmVhZHMgdGhlbS4gR29vZ2xlIHdpbGwgYXNrIHlvdSB0byBhbGxvdyBpdC5gLAogICAgICAgICAgQy5jdHguY29ubmVjdCA_IFtidXR0b24oJ0Nvbm5lY3QgR29vZ2xlIENhbGVuZGFyJywgJ3ByaW1hcnknLCBjb25uZWN0KV0gOiBbXSk7CiAgICAgIGNhc2UgJ21pc21hdGNoJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2NhbGVuZGFyJywgJ1RoYXQgd2FzIGEgZGlmZmVyZW50IGFjY291bnQnLCBgJHtDLmVycm9yfSBDb25uZWN0IGFnYWluIGFuZCBjaG9vc2UgJHtob29rcy5nZXRBY2NvdW50KCl9LmAsCiAgICAgICAgICBDLmN0eC5jb25uZWN0ID8gW2J1dHRvbignQ29ubmVjdCBhZ2FpbicsICdwcmltYXJ5JywgY29ubmVjdCldIDogW10pOwogICAgICBjYXNlICdlcnJvcic6CiAgICAgICAgcmV0dXJuIHBhbmVsKCdyZWZyZXNoJywgJ0NvdWxkbuKAmXQgbG9hZCB0aGUgY2FsZW5kYXInLCBDLmVycm9yLAogICAgIC",
"AgICAgW2J1dHRvbignVHJ5IGFnYWluJywgJ3ByaW1hcnknLCAoKSA9PiBsb2FkKHsgZm9yY2U6IHRydWUgfSkpXSk7CiAgICAgIGRlZmF1bHQ6CiAgICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBwYW5lbChpY29uTmFtZSwgdGl0bGUsIHRleHQsIGFjdGlvbnMpIHsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAncGFuZWwnLCByb2xlOiAncmVnaW9uJywgJ2FyaWEtbGFiZWwnOiB0aXRsZSB9LAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3BhbmVsLWljb24nIH0sIGljb24oaWNvbk5hbWUsIDI4KSksCiAgICAgIGgoJ2gyJywgeyB0ZXh0OiB0aXRsZSB9KSwKICAgICAgaCgncCcsIHt9LCBsaW5rZWQodGV4dCkpLAogICAgICBhY3Rpb25zLmxlbmd0aCA_IGgoJ2RpdicsIHsgY2xhc3M6ICdhY3Rpb25zJyB9LCBhY3Rpb25zKSA6IG51bGwpOwogIH0KCiAgZnVuY3Rpb24gYnV0dG9uKGxhYmVsLCBraW5kLCBvbkNsaWNrKSB7CiAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogWydidG4nLCBgYnRuLSR7a2luZH1gXSwgdHlwZTogJ2J1dHRvbicsIHRleHQ6IGxhYmVsLAogICAgICBvbmNsaWNrOiBlID0-IG9uQ2xpY2soZS5jdXJyZW50VGFyZ2V0KSwKICAgIH0pOwogIH0KCiAgLy8gR29vZ2xlJ3MgbWVzc2FnZXMgY2FycnkgdGhlIGxpbmsgdGhhdCBmaXhlcyB0aGVtICgiZW5hYmxlIGl0IGJ5CiAgLy8gdmlzaXRpbmcgaHR0cHM6Ly9jb25zb2xl4oCmIik6IG1ha2UgaX",
"Qgb25lLgogIGZ1bmN0aW9uIGxpbmtlZCh0ZXh0KSB7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBsYXN0ID0gMDsKICAgIGNvbnN0IHJlID0gL2h0dHBzOlwvXC9bXlxzPD4iXStbXlxzPD4iLiwpXS9nOwogICAgbGV0IG07CiAgICB3aGlsZSAoKG0gPSByZS5leGVjKFN0cmluZyh0ZXh0KSkpKSB7CiAgICAgIG91dC5wdXNoKHRleHQuc2xpY2UobGFzdCwgbS5pbmRleCksIGgoJ2EnLCB7IGhyZWY6IG1bMF0sIHRhcmdldDogJ19ibGFuaycsIHJlbDogJ25vb3BlbmVyIG5vcmVmZXJyZXInLCB0ZXh0OiBtWzBdIH0pKTsKICAgICAgbGFzdCA9IG0uaW5kZXggKyBtWzBdLmxlbmd0aDsKICAgIH0KICAgIG91dC5wdXNoKFN0cmluZyh0ZXh0KS5zbGljZShsYXN0KSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gT25lIGxpbmUgYWJvdmUgdGhlIGRheXMgZm9yIGEgc2VydmljZSB0aGF0IGNvdWxkIG5vdCBiZSByZWFkLgogIGZ1bmN0aW9uIGRyYXdOb3RlKCkgewogICAgY29uc3QgbGluZXMgPSBbXTsKICAgIGlmICghc3RhdHVzUGFuZWwoKSkgewogICAgICBmb3IgKGNvbnN0IFtzZXJ2aWNlLCBlcnJdIG9mIE9iamVjdC5lbnRyaWVzKEMuZXJyb3JzIHx8IHt9KSkgewogICAgICAgIGNvbnN0IHdoYXQgPSBzZXJ2aWNlID09PSAndGFza3MnID8gJ0dvb2dsZSBUYXNrcycgOiAnR29vZ2xlIENhbGVuZGFyJzsKICAgICAgICBsaW5lcy5wdXNoKGgoJ3AnLCB7fSwKICAgICAgICAgIGgoJ3N0cm9uZycsIHsgdGV4dDogYC",
"R7d2hhdH06IGAgfSksIGxpbmtlZChlcnIubWVzc2FnZSB8fCBTdHJpbmcoZXJyKSksCiAgICAgICAgICBlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX3Njb3BlJyAmJiBDLmN0eC5jb25uZWN0ID8gYnV0dG9uKCdDb25uZWN0IGFnYWluJywgJ3RleHQnLCBjb25uZWN0KSA6IG51bGwpKTsKICAgICAgfQogICAgfQogICAgZWxzLm5vdGUucmVwbGFjZUNoaWxkcmVuKC4uLmxpbmVzKTsKICAgIGVscy5ub3RlLmhpZGRlbiA9ICFsaW5lcy5sZW5ndGg7CiAgfQoKICBmdW5jdGlvbiBkcmF3U291cmNlcygpIHsKICAgIGNvbnN0IGxpc3QgPSBDLnNvdXJjZXM7CiAgICBlbHMuc291cmNlcy5oaWRkZW4gPSAhbGlzdC5sZW5ndGggfHwgISFzdGF0dXNQYW5lbCgpOwogICAgZWxzLnNvdXJjZXMucmVwbGFjZUNoaWxkcmVuKC4uLmxpc3QubWFwKHMgPT4gdGludChoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiBbJ3NyYycsIGBzcmMtJHtzLmtpbmR9YF0sIHR5cGU6ICdidXR0b24nLCAnYXJpYS1wcmVzc2VkJzogU3RyaW5nKGlzT24ocykpLAogICAgICB0aXRsZTogYCR7aXNPbihzKSA_ICdIaWRlJyA6ICdTaG93J30gJHtzLm5hbWV9YCwgZGF0YXNldDogeyBrZXk6IGBjYWwtc3JjOiR7cy5pZH1gIH0sCiAgICAgIG9uY2xpY2s6ICgpID0-IHRvZ2dsZVNvdXJjZShzKSwKICAgIH0sIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3dhdGNoJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0pLCBoKCdzcGFuJywgeyBjbGFzczogJ3NyYy1uYW1lJywgdG",
"V4dDogcy5uYW1lIH0pKSwgJy0tc3JjJywgcy5jb2xvdXIpKSk7CiAgfQoKICAvLyBPdmVyZHVlIHRhc2tzIGFscmVhZHkgb24gYSBkYXkgb24gc2NyZWVuIGFyZSBub3QgbGlzdGVkIHR3aWNlLgogIGZ1bmN0aW9uIGRyYXdUcmF5KCkgewogICAgY29uc3QgcGFuZWxVcCA9ICEhc3RhdHVzUGFuZWwoKTsKICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgY29uc3QgdCA9IGNhbC50cmF5KHZpc2libGVJdGVtcygpLCBDLnRvZGF5KTsKICAgIHQub3ZlcmR1ZSA9IHQub3ZlcmR1ZS5maWx0ZXIoeCA9PiB4LmR1ZSA8IHIuc3RhcnQgfHwgeC5kdWUgPj0gci5lbmQpOwogICAgY29uc3QgZ3JvdXAgPSAobGFiZWwsIGxpc3QpID0-IChsaXN0Lmxlbmd0aCA_IFsKICAgICAgaCgnaDMnLCB7fSwgbGFiZWwsIGgoJ3NwYW4nLCB7IGNsYXNzOiAnY291bnQnLCB0ZXh0OiBgIMK3ICR7bGlzdC5sZW5ndGh9YCB9KSksCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtaXRlbXMnIH0sIGxpc3QubWFwKHggPT4gaXRlbUVsKHsgaXRlbTogeCwgY29udDogZmFsc2UgfSwgeyBkdWU6IGxhYmVsID09PSAnT3ZlcmR1ZScgfSkpKSwKICAgIF0gOiBbXSk7CiAgICBjb25zdCBraWRzID0gWy4uLmdyb3VwKCdPdmVyZHVlJywgdC5vdmVyZHVlKSwgLi4uZ3JvdXAoJ05vIGRhdGUnLCB0LnVuZGF0ZWQpXTsKICAgIGVscy50cmF5LnJlcGxhY2VDaGlsZHJlbiguLi5raWRzKTsKICAgIGVscy50cmF5LmhpZGRlbiA9IHBhbmVsVXAgfHwgIWtpZHMubG",
"VuZ3RoOwogIH0KCiAgZnVuY3Rpb24gZHJhd01pbmkoKSB7CiAgICBlbHMubWluaS5yZXBsYWNlQ2hpbGRyZW4obWluaU1vbnRoKCkpOwogIH0KCiAgLy8gVGhlIHNtYWxsIG1vbnRoOiB0aGUgbW9udGggaW4gZm9jdXMsIHRoZSBkYXlzIG9uIHNjcmVlbiBtYXJrZWQ7IGEKICAvLyB0YXAgb24gYSBkYXkgZ29lcyB0aGVyZS4KICBmdW5jdGlvbiBtaW5pTW9udGgoKSB7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IG0gPSBjYWwubW9udGhOYW1lKEMuYW5jaG9yKTsKICAgIGNvbnN0IHJvd3MgPSBjYWwubW9udGhXZWVrcyhDLmFuY2hvcik7CiAgICBjb25zdCBtb250aCA9IEMuYW5jaG9yLnNsaWNlKDAsIDcpOwogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdtaW5pJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbWluaS1oZWFkJywgdGV4dDogYCR7bS5sb25nfSR7bS55ZWFyICE9PSBOdW1iZXIoQy50b2RheS5zbGljZSgwLCA0KSkgPyBgICR7bS55ZWFyfWAgOiAnJ31gIH0pLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbWluaS1ncmlkJywgcm9sZTogJ2dyaWQnLCAnYXJpYS1sYWJlbCc6IGAke20ubG9uZ30gJHttLnllYXJ9YCB9LAogICAgICAgIGNhbC5EQVlfTkFNRVMubWFwKGQgPT4gaCgnc3BhbicsIHsgY2xhc3M6ICdtaW5pLWRvdycsIHRleHQ6IGRbMF0sICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KSksCiAgICAgICAgcm93cy5mbGF0KCkubWFwKGsgPT4gaCgnYnV0dG9uJywgewogIC",
"AgICAgICAgY2xhc3M6IFsnbWluaS1kYXknLCBrLnNsaWNlKDAsIDcpICE9PSBtb250aCAmJiAnb3RoZXInLCBrID09PSBDLnRvZGF5ICYmICd0b2RheScsCiAgICAgICAgICAgIGsgPj0gci5zdGFydCAmJiBrIDwgci5lbmQgJiYgJ3Nob3duJ10sCiAgICAgICAgICB0eXBlOiAnYnV0dG9uJywgdGV4dDogU3RyaW5nKE51bWJlcihrLnNsaWNlKDgpKSksICdhcmlhLWxhYmVsJzogbG9uZ0RhdGUoayksCiAgICAgICAgICBkYXRhc2V0OiB7IGtleTogYGNhbC1taW5pOiR7a31gIH0sIG9uY2xpY2s6ICgpID0-IGdvKGspLAogICAgICAgIH0pKSkpOwogIH0KCiAgZnVuY3Rpb24gbG9uZ0RhdGUoaykgewogICAgY29uc3QgbSA9IGNhbC5tb250aE5hbWUoayk7CiAgICByZXR1cm4gYCR7Y2FsLmRheU5hbWUoayl9ICR7TnVtYmVyKGsuc2xpY2UoOCkpfSAke20ubG9uZ30gJHttLnllYXJ9YDsKICB9CgogIGZ1bmN0aW9uIGRheUhlYWQoaykgewogICAgcmV0dXJuIGgoJ2hlYWRlcicsIHsgY2xhc3M6ICdkYXktaGVhZCcgfSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkbmFtZScsIHRleHQ6IGNhbC5kYXlOYW1lKGspIH0pLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RudW0nLCB0ZXh0OiBTdHJpbmcoTnVtYmVyKGsuc2xpY2UoOCkpKSB9KSwKICAgICAgayA9PT0gQy50b2RheSA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnYmFkZ2UnLCB0ZXh0OiAndG9kYXknIH0pIDogbnVsbCk7CiAgfQoKICBmdW5jdGlvbiBkYXlDbGFzc2",
"VzKGssIGJhc2UpIHsKICAgIGNvbnN0IHdkID0gY2FsLndlZWtkYXkoayk7CiAgICByZXR1cm4gW2Jhc2UsIGsgPT09IEMudG9kYXkgJiYgJ3RvZGF5Jywgd2QgPj0gNSAmJiAnd2Vla2VuZCcsIHdkID09PSA2ICYmICdzdW5kYXknLCBrIDwgQy50b2RheSAmJiAncGFzdCddOwogIH0KCiAgZnVuY3Rpb24gZHJhd1dlZWsoKSB7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IGtleXMgPSBjYWwuZGF5cyhyLnN0YXJ0LCByLmVuZCk7CiAgICBjb25zdCBieURheSA9IGNhbC5ieURheSh2aXNpYmxlSXRlbXMoKSwga2V5cyk7CiAgICBjb25zdCBsb2FkaW5nID0gQy5zdGF0dXMgPT09ICdsb2FkaW5nJyAmJiAhQy5zaG93bjsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiBbJ2NhbC13ZWVrJywgbG9hZGluZyAmJiAnbG9hZGluZyddLCByb2xlOiAnbGlzdCcgfSwKICAgICAga2V5cy5tYXAoayA9PiBoKCdzZWN0aW9uJywgeyBjbGFzczogZGF5Q2xhc3NlcyhrLCAnZGF5JyksIHJvbGU6ICdsaXN0aXRlbScsICdhcmlhLWxhYmVsJzogbG9uZ0RhdGUoayksIGRhdGFzZXQ6IHsgZGF5OiBrIH0gfSwKICAgICAgICBkYXlIZWFkKGspLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtaXRlbXMnIH0sIGJ5RGF5LmdldChrKS5tYXAoZSA9PiBpdGVtRWwoZSkpKSkpLAogICAgICAvLyBUaGUgZWlnaHRoIHRpbGUsIGluIHRoZSB0d28gY29sdW1ucyBvZiBhIG5hcnJvdyBzY3JlZW4uCiAgICAgIGgoJ2RpdicsIH",
"sgY2xhc3M6ICdkYXkgbWluaS10aWxlJywgJ2FyaWEtaGlkZGVuJzogQy5uYXJyb3cgPyBudWxsIDogJ3RydWUnIH0sIG1pbmlNb250aCgpKSk7CiAgfQoKICBmdW5jdGlvbiBkcmF3TW9udGgoKSB7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IGtleXMgPSBjYWwuZGF5cyhyLnN0YXJ0LCByLmVuZCk7CiAgICBjb25zdCBieURheSA9IGNhbC5ieURheSh2aXNpYmxlSXRlbXMoKSwga2V5cyk7CiAgICBjb25zdCBtb250aCA9IEMuYW5jaG9yLnNsaWNlKDAsIDcpOwogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtbW9udGgnIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdtb250aC1kb3dzJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0sIGNhbC5EQVlfTkFNRVMubWFwKGQgPT4gaCgnc3BhbicsIHsgdGV4dDogZCB9KSkpLAogICAgICB0aW50KGgoJ2RpdicsIHsgY2xhc3M6ICdtb250aC1ncmlkJyB9LAogICAgICAgIGtleXMubWFwKGsgPT4gewogICAgICAgICAgY29uc3QgYWxsID0gYnlEYXkuZ2V0KGspOwogICAgICAgICAgY29uc3QgbW9yZSA9IGFsbC5sZW5ndGggLSBNT05USF9ST1dTOwogICAgICAgICAgcmV0dXJuIGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiBbLi4uZGF5Q2xhc3NlcyhrLCAnbWNlbGwnKSwgay5zbGljZSgwLCA3KSAhPT0gbW9udGggJiYgJ290aGVyJ10sICdhcmlhLWxhYmVsJzogbG9uZ0RhdGUoaykgfSwKICAgICAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgIC",
"AgIGNsYXNzOiAnbWRheScsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiBTdHJpbmcoTnVtYmVyKGsuc2xpY2UoOCkpKSwgdGl0bGU6IGBXZWVrIG9mICR7bG9uZ0RhdGUoayl9YCwKICAgICAgICAgICAgICBkYXRhc2V0OiB7IGtleTogYGNhbC1kYXk6JHtrfWAgfSwgb25jbGljazogKCkgPT4gb3BlbldlZWsoayksCiAgICAgICAgICAgIH0pLAogICAgICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWl0ZW1zJyB9LCBhbGwuc2xpY2UoMCwgbW9yZSA-IDAgPyBNT05USF9ST1dTIC0gMSA6IE1PTlRIX1JPV1MpLm1hcChlID0-IGl0ZW1FbChlLCB7IGNvbXBhY3Q6IHRydWUgfSkpLAogICAgICAgICAgICAgIG1vcmUgPiAwID8gaCgnYnV0dG9uJywgeyBjbGFzczogJ21vcmUnLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYCske21vcmUgKyAxfSBtb3JlYCwgb25jbGljazogKCkgPT4gb3BlbldlZWsoaykgfSkgOiBudWxsKSk7CiAgICAgICAgfSkpLCAnLS1yb3dzJywgU3RyaW5nKGtleXMubGVuZ3RoIC8gNykpKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5XZWVrKGspIHsKICAgIEMuYW5jaG9yID0gazsKICAgIHNldFZpZXcoJ3dlZWsnKTsKICB9CgogIGZ1bmN0aW9uIGRyYXdBZ2VuZGEoKSB7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IGtleXMgPSBjYWwuZGF5cyhyLnN0YXJ0LCByLmVuZCk7CiAgICBjb25zdCBieURheSA9IGNhbC5ieURheSh2aXNpYmxlSXRlbXMoKSwga2V5cyk7CiAgICBjb25zdCBkYXlzID",
"0ga2V5cy5maWx0ZXIoayA9PiBieURheS5nZXQoaykubGVuZ3RoIHx8IGsgPT09IEMudG9kYXkpOwogICAgaWYgKEMuc3RhdHVzID09PSAnbG9hZGluZycgJiYgIUMuc2hvd24pIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWFnZW5kYSBsb2FkaW5nJyB9KTsKICAgIGlmICghZGF5cy5sZW5ndGgpIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWFnZW5kYScgfSwgaCgncCcsIHsgY2xhc3M6ICdlbXB0eScsIHRleHQ6ICdOb3RoaW5nIG9uIGluIHRoZXNlIGZvdXIgd2Vla3MuJyB9KSk7CiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1hZ2VuZGEnIH0sIGRheXMubWFwKGsgPT4gewogICAgICBjb25zdCBtID0gY2FsLm1vbnRoTmFtZShrKTsKICAgICAgcmV0dXJuIGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiBkYXlDbGFzc2VzKGssICdhZGF5JyksICdhcmlhLWxhYmVsJzogbG9uZ0RhdGUoaykgfSwKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnYWRheS1kYXRlJyB9LAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkbnVtJywgdGV4dDogU3RyaW5nKE51bWJlcihrLnNsaWNlKDgpKSkgfSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RuYW1lJyB9LCBoKCdzcGFuJywgeyB0ZXh0OiBjYWwuZGF5TmFtZShrKSB9KSwgaCgnc3BhbicsIHsgY2xhc3M6ICdtb24nLCB0ZXh0OiBtLnNob3J0IH0pKSksCiAgICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2NhbC1pdGVtcycgfSwgYnlEYX",
"kuZ2V0KGspLmxlbmd0aAogICAgICAgICAgPyBieURheS5nZXQoaykubWFwKGUgPT4gaXRlbUVsKGUsIHsgYWdlbmRhOiB0cnVlIH0pKQogICAgICAgICAgOiBoKCdwJywgeyBjbGFzczogJ2VtcHR5JywgdGV4dDogJ05vdGhpbmcgb24gdG9kYXkuJyB9KSkpOwogICAgfSkpOwogIH0KCiAgZnVuY3Rpb24gdGltZVRleHQobXMpIHsKICAgIGlmICghdGltZUZvcm1hdCkgdGltZUZvcm1hdCA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KHVuZGVmaW5lZCwgeyBob3VyOiAnbnVtZXJpYycsIG1pbnV0ZTogJzItZGlnaXQnIH0pOwogICAgcmV0dXJuIHRpbWVGb3JtYXQuZm9ybWF0KG5ldyBEYXRlKG1zKSk7CiAgfQoKICBmdW5jdGlvbiB3aGVuVGV4dChpdGVtLCBjb250KSB7CiAgICBpZiAoaXRlbS5hbGxEYXkpIHJldHVybiBpdGVtLmZpcnN0ID09PSBpdGVtLmxhc3QgPyAnQWxsIGRheScgOiBgJHtzaG9ydERhdGUoaXRlbS5maXJzdCl9IOKAkyAke3Nob3J0RGF0ZShpdGVtLmxhc3QpfWA7CiAgICBjb25zdCBzcGFuID0gYCR7dGltZVRleHQoaXRlbS5zdGFydCl9IOKAkyAke3RpbWVUZXh0KGl0ZW0uZW5kKX1gOwogICAgcmV0dXJuIGl0ZW0uZmlyc3QgPT09IGl0ZW0ubGFzdCA_IHNwYW4gOiBgJHtzaG9ydERhdGUoaXRlbS5maXJzdCl9ICR7dGltZVRleHQoaXRlbS5zdGFydCl9IOKAkyAke3Nob3J0RGF0ZShpdGVtLmxhc3QpfSAke3RpbWVUZXh0KGl0ZW0uZW5kKX1gOwogIH0KCiAgZnVuY3Rpb24gc2hvcnREYXRlKGspIH",
"sKICAgIHJldHVybiBgJHtOdW1iZXIoay5zbGljZSg4KSl9ICR7Y2FsLm1vbnRoTmFtZShrKS5zaG9ydH1gOwogIH0KCiAgLy8gQW4gZXZlbnQgb3IgYSB0YXNrLCBhcyBhIGxpbmsgdG8gd2hlcmUgaXQgbGl2ZXMgaW4gR29vZ2xlLgogIGZ1bmN0aW9uIGl0ZW1FbCh7IGl0ZW0sIGNvbnQgfSwgeyBjb21wYWN0ID0gZmFsc2UsIGFnZW5kYSA9IGZhbHNlLCBkdWUgPSBmYWxzZSB9ID0ge30pIHsKICAgIGNvbnN0IHRhZyA9IGl0ZW0ubGluayA_ICdhJyA6ICdkaXYnOwogICAgY29uc3QgbGluayA9IGl0ZW0ubGluayA_IHsgaHJlZjogaXRlbS5saW5rLCB0YXJnZXQ6ICdfYmxhbmsnLCByZWw6ICdub29wZW5lciBub3JlZmVycmVyJyB9IDoge307CiAgICBpZiAoaXRlbS5raW5kID09PSAnZXZlbnQnKSB7CiAgICAgIGNvbnN0IHRpbWUgPSBpdGVtLmFsbERheSA_IChhZ2VuZGEgPyAnQWxsIGRheScgOiAnJykgOiBjb250ID8gKGFnZW5kYSA_ICd1bnRpbCAnICsgdGltZVRleHQoaXRlbS5lbmQpIDogJ-KApicpIDogdGltZVRleHQoaXRlbS5zdGFydCk7CiAgICAgIGNvbnN0IHRpcCA9IFtpdGVtLnRpdGxlLCB3aGVuVGV4dChpdGVtLCBjb250KSwgaXRlbS53aGVyZV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJ1xuJyk7CiAgICAgIHJldHVybiB0aW50KGgodGFnLCBPYmplY3QuYXNzaWduKHsKICAgICAgICBjbGFzczogWydpdGVtJywgJ2V2JywgaXRlbS5hbGxEYXkgJiYgJ2FsbC1kYXknLCBjb21wYWN0ICYmICdjb21wYWN0J1",
"0sIHRpdGxlOiB0aXAsCiAgICAgIH0sIGxpbmspLAogICAgICB0aW1lID8gaCgnc3BhbicsIHsgY2xhc3M6ICd0aW1lJywgdGV4dDogdGltZSB9KSA6IG51bGwsCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndCcsIHRleHQ6IGl0ZW0udGl0bGUgfSkpLCAnLS1jJywgaXRlbS5jb2xvdXIpOwogICAgfQogICAgY29uc3QgdGlwID0gW2l0ZW0udGl0bGUsIGl0ZW0ubGlzdCAmJiBgR29vZ2xlIFRhc2tzIMK3ICR7aXRlbS5saXN0fWAsIGR1ZSAmJiBpdGVtLmR1ZSAmJiBgRHVlICR7c2hvcnREYXRlKGl0ZW0uZHVlKX1gLAogICAgICBpdGVtLmVtYWlsICYmICdPcGVucyB0aGUgZW1haWwnXS5maWx0ZXIoQm9vbGVhbikuam9pbignXG4nKTsKICAgIHJldHVybiBoKHRhZywgT2JqZWN0LmFzc2lnbih7IGNsYXNzOiBbJ2l0ZW0nLCAndGFzaycsIGl0ZW0uZG9uZSAmJiAnZG9uZScsIGNvbXBhY3QgJiYgJ2NvbXBhY3QnXSwgdGl0bGU6IHRpcCB9LCBsaW5rKSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdib3gnLCAnYXJpYS1sYWJlbCc6IGl0ZW0uZG9uZSA_ICdEb25lJyA6ICdUbyBkbycsIHJvbGU6ICdpbWcnIH0sIGl0ZW0uZG9uZSA_IGljb24oJ2NoZWNrJywgMTIpIDogbnVsbCksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndCcsIHRleHQ6IGl0ZW0udGl0bGUgfSksCiAgICAgIGR1ZSAmJiBpdGVtLmR1ZSA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZHVlJywgdGV4dDogc2hvcnREYXRlKGl0ZW0uZHVlKSB9KSA6IG51bG",
"wsCiAgICAgIGl0ZW0uZW1haWwgPyBoKCdzcGFuJywgeyBjbGFzczogJ21haWwnLCB0aXRsZTogJ0Zyb20gYW4gZW1haWwnIH0sIGljb24oJ21haWwnLCAxNCkpIDogbnVsbCk7CiAgfQoKICAvLyDilIDilIAgS2V5cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaGFuZGxlS2V5KGUpIHsKICAgIGlmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuYWx0S2V5IHx8IGUuZGVmYXVsdFByZXZlbnRlZCkgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgdCA9IGUuY29tcG9zZWRQYXRoKClbMF07CiAgICBpZiAodCAmJiAodC5pc0NvbnRlbnRFZGl0YWJsZSB8fCAvXihJTlBVVHxURVhUQVJFQXxTRUxFQ1QpJC8udGVzdCh0LnRhZ05hbWUpKSkgcmV0dXJuIGZhbHNlOwogICAgaWYgKEMuc3RhdHVzID09PSAnc2lnbmluJyB8fCBDLnN0YXR1cyA9PT0gJ21pc21hdGNoJykgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgayA9IGUua2V5LnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBhY3QgPSB7CiAgICAgIHQ6ICgpID0-IGdvKGNhbC5kYXRlS2V5KG5ldyBEYXRlKCkpKSwKICAgICAgajogKCkgPT4gZ28oY2FsLnN0ZXAodmlldygpLC",
"BDLmFuY2hvciwgMSkpLAogICAgICBuOiAoKSA9PiBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCAxKSksCiAgICAgIGs6ICgpID0-IGdvKGNhbC5zdGVwKHZpZXcoKSwgQy5hbmNob3IsIC0xKSksCiAgICAgIHA6ICgpID0-IGdvKGNhbC5zdGVwKHZpZXcoKSwgQy5hbmNob3IsIC0xKSksCiAgICAgIHc6ICgpID0-IHNldFZpZXcoJ3dlZWsnKSwKICAgICAgbTogKCkgPT4gc2V0VmlldygnbW9udGgnKSwKICAgICAgYTogKCkgPT4gc2V0VmlldygnYWdlbmRhJyksCiAgICB9W2tdOwogICAgaWYgKCFhY3QpIHJldHVybiBmYWxzZTsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGFjdCgpOwogICAgcmV0dXJuIHRydWU7CiAgfQoKICAvLyBFdmVyeSBmZXcgc2Vjb25kcyB3aGlsZSBvcGVuOiBwYXN0IG1pZG5pZ2h0LCB0b2RheSBtb3ZlcyBvbi4KICBmdW5jdGlvbiB0aWNrKCkgewogICAgY29uc3Qgbm93ID0gY2FsLmRhdGVLZXkobmV3IERhdGUoKSk7CiAgICBpZiAobm93ID09PSBDLnRvZGF5KSByZXR1cm47CiAgICBpZiAoQy5hbmNob3IgPT09IEMudG9kYXkpIEMuYW5jaG9yID0gbm93OwogICAgQy50b2RheSA9IG5vdzsKICAgIGxvYWQoKTsKICB9CgogIG5zLmNhbGVuZGFyID0gewogICAgaW5pdCwgZWxlbWVudCwgbG9hZCwgaXNTdGFsZSwgaGFuZGxlS2V5LCB0aWNrLAogICAgbG9hZGVkQXQ6ICgpID0-IEMubG9hZGVkQXQsCiAgICBpc0xvYWRpbmc6ICgpID0-ICEhQy5sb2FkaW5nLAogIH07Cn0pKCk7Cg",
"\"],[\"src/content/board.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBib2FyZAovLwovLyBBIGZ1bGwtdmlld3BvcnQgb3ZlcmxheSBvdmVyIEdtYWlsLiBDb2x1bW5zIGFyZSBHbWFpbCBsYWJlbHMsIGNhcmRzIGFyZQovLyB0aHJlYWRzLCBhbmQgZXZlcnkgY2hhbmdlIGlzIGEgdGhyZWFkcy5tb2RpZnkgYXBwbGllZCBvcHRpbWlzdGljYWxseToKLy8gdGhlIGNhcmQgbW92ZXMgYXQgb25jZSwgYW5kIG1vdmVzIGJhY2sgd2l0aCBhIHRvYXN0IGlmIEdtYWlsIHJlZnVzZXMuCi8vIERyYWdnaW5nIGlzIHRoZSBxdWljayB3YXkgdG8gbW92ZSB0aGluZ3MsIGJ1dCBldmVyeSBhY3Rpb24gaXMgYWxzbyBvbgovLyB0aGUgY2FyZCdzICLii68iIG1lbnUsIHNvIG5vdGhpbmcgbmVlZHMgYSBtb3VzZS4KLy8KLy8gVGhlIHBob25lIGFwcCAoYWRkb24vYXBwKSBydW5zIHRoaXMgc2FtZSBib2FyZCBhcyB0aGUgYXBwIGl0c2VsZiByYXRoZXIKLy8gdGhhbiBvdmVyIEdtYWlsOiBpdCBzZXRzIG5zLmJvYXJkRnJhbWUgLSB3aGVyZSB0byBkcmF3LCB0aGUgdGFiIHRvIHN0YXJ0Ci8v",
"IG9uLCBhbmQgd2hhdCB0aGUgbm90ZXMgbmVlZCBmcm9tIGl0IC0gYW5kIHRoZXJlIGlzIHRoZW4gbm90aGluZyB0bwovLyBjbG9zZSwgYW5kIG5vIEdtYWlsIHBhZ2UgYmVoaW5kIHRvIGtlZXAgdGhlIGtleWJvYXJkIG91dCBvZi4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLCBsb2dvLCBtb3VudFNoYWRvdywgdG9hc3QsIG9wZW5NZW51LCBjbG9zZU1lbnUsIGlzTWVudU9wZW4gfSA9IG5zLnVpOwogIGNvbnN0IHsgdXRpbCwgbG9naWMsIHN0b3JlLCBob29rcywgYXBpLCBBUFBfTkFNRSwgSE9TVF9JRFMsIEtFWVMgfSA9IG5zOwoKICAvLyBTdGF0ZXMgd2l0aCBhIHBhbmVsIG9mIHRoZWlyIG93biwgc2hvd24gd2hpY2hldmVyIHRhYiBpcyBvcGVuOiB0aGV5CiAgLy8gYXJlIGFib3V0IHRoZSBhY2NvdW50LCBub3QgYWJvdXQgdGhlIGJvYXJkIG9yIHRoZSBub3Rlcy4KICBjb25zdCBQQU5FTF9TVEFURVMg",
"PSBuZXcgU2V0KFsnbm9fYWNjb3VudCcsICdub3RfY29uZmlndXJlZCcsICdhdXRoX3JlcXVpcmVkJywgJ2FjY291bnRfbWlzbWF0Y2gnXSk7CgogIC8vIE9wZW5pbmcgdGhlIGJvYXJkIHJlLXJlYWRzIEdtYWlsIGlmIHdoYXQgaXMgb24gc2NyZWVuIGlzIG9sZGVyIHRoYW4KICAvLyB0aGlzLiBTaG9ydCBlbm91Z2ggdGhhdCBhIGxhYmVsIGFkZGVkIG9uIHRoZSBwaG9uZSBzaG93cyB1cDsgbG9uZwogIC8vIGVub3VnaCB0aGF0IGZsaWNraW5nIHRoZSBib2FyZCBvcGVuIGFuZCBzaHV0IGNvc3RzIG5vdGhpbmcuCiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CgogIGNvbnN0IERSQUdfVFlQRSA9ICdhcHBsaWNhdGlvbi94LWdrYi10aHJlYWQnOwoKICBjb25zdCBWSUVXUyA9IFsnYm9hcmQnLCAnbm90ZXMnLCAnY2FsZW5kYXInXTsKCiAgLy8g4pSA4pSAIFN0YXRlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBTID0gewogICAgbW91bnRlZDogZmFsc2UsCiAgICBvcGVuOiBmYWxzZSwKICAgIHZpZXc6ICdib2FyZCcsICAgIC8vIGJvYXJkIHwgbm90ZXMgfCBjYWxlbmRhciAtIHRoZSBvdmVybGF5J3MgdGhyZWUgdGFicwog",
"ICAgdmlld0xvYWRlZDogZmFsc2UsCiAgICBhY2NvdW50OiAnJywKICAgIGNvbHVtbnM6IFtdLAogICAgbGlzdHM6IHt9LCAgICAgICAgLy8gY29sdW1uIGlkIOKGkiB0aHJlYWQgaWRzLCBpbiBkaXNwbGF5IG9yZGVyCiAgICB0cnVuY2F0ZWQ6IHt9LCAgICAvLyBjb2x1bW4gaWQg4oaSIHRydWUgd2hlbiBHbWFpbCBoYWQgbW9yZSB0aGFuIDEwMAogICAgbG9hZGVkQXQ6IDAsCiAgICBsb2FkaW5nOiBudWxsLCAgICAvLyBwcm9taXNlIG9mIHRoZSByZWZyZXNoIGluIHByb2dyZXNzCiAgICBzdGF0dXM6ICdpZGxlJywgICAvLyBpZGxlIHwgbG9hZGluZyB8IHJlYWR5IHwgZXJyb3IgfCBub19hY2NvdW50IHwgbm90X2NvbmZpZ3VyZWQgfCBhdXRoX3JlcXVpcmVkIHwgYWNjb3VudF9taXNtYXRjaAogICAgc3RhdHVzTWVzc2FnZTogJycsCiAgICBzZWFyY2g6IG51bGwsICAgICAvLyB7IGNvbElkLCBxdWVyeSwgaWRzLCBsb2FkaW5nLCBlcnJvciwgc2VxIH0KICAgIGRyYXdlcjogbnVsbCwgICAgIC8vIHsgZHJhZnQsIGVycm9yLCBzYXZpbmcgfQogICAgZWRpdHM6IG5ldyBNYXAoKSwgLy8gdGhyZWFkIGlkIOKGkiB7IHRpdGxlPywgbm90ZT8sIGNvbG91cj8gfSAoc2VlIGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KQogICAgZWRpdG9yOiBudWxsLCAgICAgLy8geyBpZCwgc3ViamVjdCwgZHJhZnQsIGVycm9yLCBzYXZpbmcgfQogICAgZHJhZzogbnVsbCwgICAgICAgLy8geyBpZCwgZnJvbUNvbCwgY2FyZCwgcGxhY2Vob2xk",
"ZXIgfQogICAgbXV0YXRpb25zOiAwLCAgICAgLy8gbG9jYWwgbW92ZXMgbWFkZTsgYSByZWZyZXNoIHRoYXQgc3BhbnMgb25lIGlzIHN0YWxlCiAgICByZW5kZXJEZWZlcnJlZDogZmFsc2UsCiAgICByZXR1cm5Gb2N1czogbnVsbCwKICAgIHRpY2tlcjogMCwKICB9OwoKICBsZXQgcm9vdCA9IG51bGw7CiAgbGV0IGZyYW1lID0gbnVsbDsgLy8gbnMuYm9hcmRGcmFtZSwgaW4gdGhlIHBob25lIGFwcAogIGNvbnN0IGVscyA9IHt9OwoKICAvLyDilIDilIAgTW91bnRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG1vdW50KCkgewogICAgaWYgKFMubW91bnRlZCkgcmV0dXJuOwogICAgZnJhbWUgPSBucy5ib2FyZEZyYW1lIHx8IG51bGw7CiAgICAoeyByb290IH0gPSBmcmFtZSA_IHsgcm9vdDogZnJhbWUucm9vdCB9IDogbW91bnRTaGFkb3coSE9TVF9JRFMuYm9hcmQsIG5zLnN0eWxlcy5ib2FyZCkpOwoKICAgIGVscy5hY2NvdW50ID0gaCgnc3BhbicsIHsgY2xhc3M6ICdhY2NvdW50JyB9KTsKICAgIGVscy51cGRhdGVkID0gaCgnc3BhbicsIHsgY2xhc3M6ICd1cGRhdGVkJyB9KTsKICAgIGVscy5yZWZyZXNoID0gaCgnYnV0dG9uJywg",
"ewogICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ1JlZnJlc2gnLCB0aXRsZTogJ1JlZnJlc2gnLAogICAgICBvbmNsaWNrOiAoKSA9PiAoUy52aWV3ID09PSAnbm90ZXMnID8gbnMubm90ZXMubG9hZCh7IGZvcmNlOiB0cnVlIH0pCiAgICAgICAgOiBTLnZpZXcgPT09ICdjYWxlbmRhcicgPyBucy5jYWxlbmRhci5sb2FkKHsgZm9yY2U6IHRydWUgfSkgOiByZWZyZXNoKCkpLAogICAgfSwgaWNvbigncmVmcmVzaCcpKTsKICAgIGVscy5zZXR0aW5ncyA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDb2x1bW4gc2V0dGluZ3MnLCB0aXRsZTogJ0NvbHVtbiBzZXR0aW5ncycsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAnc2V0dGluZ3MnIH0sIG9uY2xpY2s6IG9wZW5EcmF3ZXIsCiAgICB9LCBpY29uKCd0dW5lJykpOwogICAgZWxzLmNsb3NlID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ0Nsb3NlIGJvYXJkJywgdGl0bGU6ICdDbG9zZSAoRXNjKScsCiAgICAgIGhpZGRlbjogISFmcmFtZSwgb25jbGljazogY2xvc2UsCiAgICB9LCBpY29uKCdjbG9zZScpKTsKCiAgICBjb25zdCB0YWIgPSAodmlldywgbGFiZWwsIGljb25OYW1lKSA9PiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAndGFiJywgdHlwZTogJ2J1",
"dHRvbicsIHJvbGU6ICd0YWInLCAnYXJpYS1zZWxlY3RlZCc6IFN0cmluZyhTLnZpZXcgPT09IHZpZXcpLAogICAgICBkYXRhc2V0OiB7IGtleTogYHZpZXc6JHt2aWV3fWAsIHZpZXcgfSwgb25jbGljazogKCkgPT4gc3dpdGNoVmlldyh2aWV3KSwKICAgIH0sIGljb24oaWNvbk5hbWUsIDE4KSwgbGFiZWwpOwogICAgZWxzLnRhYnMgPSBoKCdkaXYnLCB7IGNsYXNzOiAndGFicycsIHJvbGU6ICd0YWJsaXN0JywgJ2FyaWEtbGFiZWwnOiAnVmlldycgfSwKICAgICAgdGFiKCdib2FyZCcsICdCb2FyZCcsICdib2FyZCcpLCB0YWIoJ25vdGVzJywgJ05vdGVzJywgJ25vdGUnKSwgdGFiKCdjYWxlbmRhcicsICdDYWxlbmRhcicsICdjYWxlbmRhcicpKTsKCiAgICBjb25zdCBiYXIgPSBoKCdoZWFkZXInLCB7IGNsYXNzOiAnYmFyJyB9LAogICAgICBoKCdoMScsIHsgY2xhc3M6ICdicmFuZCcgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2xvZ28nIH0sIGxvZ28oMjYpKSwKICAgICAgICBoKCdzcGFuJywgeyB0ZXh0OiBBUFBfTkFNRSB9KSksCiAgICAgIGVscy50YWJzLAogICAgICBlbHMuYWNjb3VudCwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3NwYWNlcicgfSksCiAgICAgIGVscy51cGRhdGVkLCBlbHMucmVmcmVzaCwgZWxzLnNldHRpbmdzLCBlbHMuY2xvc2UpOwoKICAgIGVscy5ib2R5ID0gaCgnbWFpbicsIHsgY2xhc3M6ICdib2R5JyB9KTsKICAgIGVscy5saXZlID0gaCgnZGl2JywgeyBjbGFzczogJ3Ny",
"LW9ubHknLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScgfSk7CiAgICBlbHMuZHJhd2VyTGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZHJhd2VyLWxheWVyJyB9KTsKICAgIGVscy5lZGl0b3JMYXllciA9IGgoJ2RpdicsIHsgY2xhc3M6ICdlZGl0b3ItbGF5ZXInIH0pOwoKICAgIGVscy5vdmVybGF5ID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ292ZXJsYXknLCByb2xlOiBmcmFtZSA_IG51bGwgOiAnZGlhbG9nJywgJ2FyaWEtbW9kYWwnOiBmcmFtZSA_IG51bGwgOiAndHJ1ZScsICdhcmlhLWxhYmVsJzogYCR7QVBQX05BTUV9IGJvYXJkYCwKICAgICAgdGFiaW5kZXg6ICctMScsIGhpZGRlbjogdHJ1ZSwgb25rZXlkb3duOiBvbk92ZXJsYXlLZXksCiAgICB9LCBiYXIsIGVscy5ib2R5LCBlbHMubGl2ZSwgZWxzLmRyYXdlckxheWVyLCBlbHMuZWRpdG9yTGF5ZXIpOwoKICAgIHJvb3QuYXBwZW5kQ2hpbGQoZWxzLm92ZXJsYXkpOwogICAgUy5tb3VudGVkID0gdHJ1ZTsKCiAgICAvLyBTbWFsbCBwZXItYWNjb3VudCBwcmVmZXJlbmNlcyAoZm9sZGVkIGZvbGRlcnMsIHRoZSBjYWxlbmRhcidzIHZpZXcpLAogICAgLy8gb24gdGhpcyBjb21wdXRlci4KICAgIGNvbnN0IHByZWZzID0gewogICAgICBhc3luYyBnZXQobmFtZSkgewogICAgICAgIGNvbnN0IGtleSA9IEtFWVMucHJlZihob29rcy5nZXRBY2NvdW50KCksIG5hbWUpOwogICAgICAgIHJldHVybiAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkp",
"W2tleV07CiAgICAgIH0sCiAgICAgIHNldDogKG5hbWUsIHZhbHVlKSA9PiBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy5wcmVmKGhvb2tzLmdldEFjY291bnQoKSwgbmFtZSldOiB2YWx1ZSB9KSwKICAgIH07CgogICAgbnMubm90ZXMuaW5pdChPYmplY3QuYXNzaWduKHsKICAgICAgcm9vdCwKICAgICAgLy8gQWNjb3VudCB0cm91YmxlIGZvdW5kIGJ5IHRoZSBub3RlcyBnZXRzIHRoZSBzYW1lIHBhbmVsIGFzIHRoZSBib2FyZCdzLgogICAgICBvblN0YXRlRXJyb3I6IGVyciA9PiB7CiAgICAgICAgUy5zdGF0dXMgPSBlcnIuY29kZTsKICAgICAgICBTLnN0YXR1c01lc3NhZ2UgPSBlcnIubWVzc2FnZTsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSwKICAgICAgb25Mb2FkZWQ6ICgpID0-IHsKICAgICAgICBpZiAoIVBBTkVMX1NUQVRFUy5oYXMoUy5zdGF0dXMpKSByZXR1cm47CiAgICAgICAgUy5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0sCiAgICAgIGNsb3NlQm9hcmQ6IGNsb3NlLAogICAgICBiYXJDaGFuZ2VkOiB1cGRhdGVCYXIsCiAgICAgIC8vIFdoaWNoIGZvbGRlcnMgYXJlIGZvbGRlZCwgb24gdGhpcyBjb21wdXRlciwgZm9yIHRoaXMgYWNjb3VudC4KICAgICAgcHJlZnMsCiAgICB9LCBmcmFtZSAmJiBmcmFtZS5ub3RlcykpOwoKICAgIG5zLmNhbGVuZGFyLmluaXQoT2JqZWN0LmFzc2lnbih7CiAgICAgIHJvb3QsCiAgICAgIC8vIE5vIGNsaWVudCBJRCB5ZXQ6",
"IHRoZSBib2FyZCdzIG93biBzZXR1cCBwYW5lbC4gVGhlIGNhbGVuZGFyJ3MKICAgICAgLy8gb3duIHNpZ24taW4gaGFzIGEgcGFuZWwgb2YgaXRzIG93biwgaW5zaWRlIHRoZSBjYWxlbmRhci4KICAgICAgb25TdGF0ZUVycm9yOiBlcnIgPT4gewogICAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0sCiAgICAgIG9uTG9hZGVkOiAoKSA9PiB7CiAgICAgICAgaWYgKCFQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSkgcmV0dXJuOwogICAgICAgIFMuc3RhdHVzID0gJ2lkbGUnOwogICAgICAgIHJlbmRlcigpOwogICAgICB9LAogICAgICBiYXJDaGFuZ2VkOiB1cGRhdGVCYXIsCiAgICAgIHByZWZzLAogICAgICBjb25uZWN0OiAoKSA9PiBhcGkuY29ubmVjdENhbGVuZGFyKCksCiAgICB9LCBmcmFtZSAmJiBmcmFtZS5jYWxlbmRhcikpOwoKICAgIC8vIEEgbW92ZSBtYWRlIGZyb20gdGhlIGRvY2sgKG9yIGFub3RoZXIgdGFiKSBtYWtlcyB3aGF0IHRoZSBib2FyZCBsYXN0CiAgICAvLyBsb2FkZWQgd3Jvbmc7IHRoZSBib2FyZCdzIG93biBtb3ZlcyBhcmUgYWxyZWFkeSByZWZsZWN0ZWQgb24gc2NyZWVuLgogICAgc3RvcmUuYnVzLmFkZEV2ZW50TGlzdGVuZXIoJ3RocmVhZC1jaGFuZ2VkJywgZSA9PiB7CiAgICAgIGlmIChlLmRldGFpbCAmJiBlLmRldGFpbC5zb3VyY2UgPT09ICdib2FyZCcpIHJldHVybjsK",
"ICAgICAgUy5sb2FkZWRBdCA9IDA7CiAgICAgIGlmIChTLm9wZW4gJiYgUy52aWV3ID09PSAnYm9hcmQnKSByZWZyZXNoKCk7CiAgICB9KTsKICB9CgogIC8vIOKUgOKUgCBPcGVuIC8gY2xvc2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIG9wZW4oeyB2aWV3IH0gPSB7fSkgewogICAgbW91bnQoKTsKICAgIGlmIChTLm9wZW4pIHsKICAgICAgaWYgKHZpZXcpIHN3aXRjaFZpZXcodmlldyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIFMub3BlbiA9IHRydWU7CiAgICBTLnJldHVybkZvY3VzID0gZnJhbWUgPyBudWxsIDogZGVlcEFjdGl2ZUVsZW1lbnQoKTsKICAgIGVscy5vdmVybGF5LmhpZGRlbiA9IGZhbHNlOwogICAgaWYgKCFmcmFtZSkgZWxzLmNsb3NlLmZvY3VzKCk7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgb25Eb2N1bWVudEtleSwgdHJ1ZSk7CiAgICBTLnRpY2tlciA9IHNldEludGVydmFsKHVwZGF0ZUJhciwgNTAwMCk7CgogICAgLy8gVGhlIHRhYiBsYXN0IHVzZWQsIHVubGVzcyB0aGUgY2FsbGVyIGFza2VkIGZvciBvbmUuCiAgICBpZiAoIVMudmlld0xvYWRlZCkgewogICAgICBTLnZpZXdMb2FkZWQg",
"PSB0cnVlOwogICAgICB0cnkgewogICAgICAgIGNvbnN0IGdvdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChLRVlTLnZpZXcpOwogICAgICAgIGlmIChWSUVXUy5pbmNsdWRlcyhnb3RbS0VZUy52aWV3XSkpIFMudmlldyA9IGdvdFtLRVlTLnZpZXddOwogICAgICAgIGVsc2UgaWYgKGZyYW1lICYmIGZyYW1lLnZpZXcpIFMudmlldyA9IGZyYW1lLnZpZXc7CiAgICAgIH0gY2F0Y2ggeyAvKiBleHRlbnNpb24gcmVsb2FkZWQ7IGhhbmRsZWQganVzdCBiZWxvdyAqLyB9CiAgICB9CiAgICBpZiAodmlldykgUy52aWV3ID0gdmlldzsKCiAgICBTLmFjY291bnQgPSBob29rcy5nZXRBY2NvdW50KCk7CiAgICBpZiAoIVMuYWNjb3VudCkgewogICAgICBTLnN0YXR1cyA9ICdub19hY2NvdW50JzsKICAgICAgcmVuZGVyKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRyeSB7CiAgICAgIGlmICghUy5jb2x1bW5zLmxlbmd0aCkgUy5jb2x1bW5zID0gYXdhaXQgc3RvcmUubG9hZENvbHVtbnMoUy5hY2NvdW50KTsKICAgIH0gY2F0Y2ggewogICAgICAvLyBjaHJvbWUuc3RvcmFnZSB0aHJvd3Mgb25jZSB0aGUgZXh0ZW5zaW9uIGhhcyBiZWVuIHJlbG9hZGVkIHVuZGVyCiAgICAgIC8vIHRoaXMgdGFiOyBub3RoaW5nIGVsc2Ugd2lsbCB3b3JrIHVudGlsIEdtYWlsIGlzIHJlbG9hZGVkIGVpdGhlci4KICAgICAgUy5zdGF0dXMgPSAnZXJyb3InOwogICAgICBTLnN0YXR1c01lc3NhZ2UgPSAnVGhlIGV4dGVuc2lvbiB3",
"YXMgdXBkYXRlZC4gUmVsb2FkIHRoaXMgR21haWwgdGFiLic7CiAgICAgIHJlbmRlcigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnKSBzaG93Tm90ZXMoKTsKICAgIGVsc2UgaWYgKFMudmlldyA9PT0gJ2NhbGVuZGFyJykgc2hvd0NhbGVuZGFyKCk7CiAgICBlbHNlIHNob3dCb2FyZCgpOwogIH0KCiAgZnVuY3Rpb24gc2hvd0JvYXJkKCkgewogICAgY29uc3Qgc3RhbGUgPSBTLnN0YXR1cyAhPT0gJ3JlYWR5JyB8fCBEYXRlLm5vdygpIC0gUy5sb2FkZWRBdCA-IFNUQUxFX01TOwogICAgLy8gU2tlbGV0b24gY29sdW1ucyB3aGlsZSBhIGZpcnN0IChvciByZXRyaWVkKSBsb2FkIHJ1bnMsIHJhdGhlciB0aGFuCiAgICAvLyBsZWF2aW5nIGFuIG9sZCAiQ29ubmVjdCBHbWFpbCIgcGFuZWwgdXAgYWZ0ZXIgdGhlIHVzZXIgaGFzIGNvbm5lY3RlZC4KICAgIGlmIChTLnN0YXR1cyAhPT0gJ3JlYWR5JykgUy5zdGF0dXMgPSAnbG9hZGluZyc7CiAgICByZW5kZXIoKTsKICAgIGlmIChzdGFsZSkgcmVmcmVzaCgpOwogIH0KCiAgLy8gQW4gYWNjb3VudCBwYW5lbCBsZWZ0IG92ZXIgZnJvbSBlYXJsaWVyIGlzIHJldHJpZWQgcmF0aGVyIHRoYW4gc2hvd24KICAvLyBhZ2FpbjsgaWYgdGhlIHRyb3VibGUgaXMgc3RpbGwgdGhlcmUsIHRoZSBub3Rlcycgb3duIGxvYWQgc2F5cyBzby4KICBmdW5jdGlvbiBzaG93Tm90ZXMoKSB7CiAgICBpZiAoUEFORUxfU1RBVEVTLmhhcyhTLnN0YXR1cykp",
"IFMuc3RhdHVzID0gJ2lkbGUnOwogICAgcmVuZGVyKCk7CiAgICBucy5ub3Rlcy5sb2FkKCk7CiAgICBpZiAoIWZyYW1lIHx8IGZyYW1lLmZvY3VzICE9PSBmYWxzZSkgbnMubm90ZXMuZm9jdXNEZWZhdWx0KCk7CiAgfQoKICAvLyBUaGUgY2FsZW5kYXIgbmVlZHMgbm90aGluZyBvZiBHbWFpbCdzLCBzbyBhIEdtYWlsIHBhbmVsIGlzIG5vIHJlYXNvbgogIC8vIHRvIGtlZXAgaXQgaGlkZGVuOyBvbmx5IGEgbWlzc2luZyBjbGllbnQgSUQgb3IgYWNjb3VudCBzdGFuZHMgaW4gaXRzIHdheS4KICBmdW5jdGlvbiBzaG93Q2FsZW5kYXIoKSB7CiAgICBpZiAoUEFORUxfU1RBVEVTLmhhcyhTLnN0YXR1cykgJiYgUy5zdGF0dXMgIT09ICdub3RfY29uZmlndXJlZCcgJiYgUy5zdGF0dXMgIT09ICdub19hY2NvdW50JykgUy5zdGF0dXMgPSAnaWRsZSc7CiAgICByZW5kZXIoKTsKICAgIG5zLmNhbGVuZGFyLmxvYWQoKTsKICB9CgogIGZ1bmN0aW9uIHN3aXRjaFZpZXcodmlldykgewogICAgaWYgKHZpZXcgPT09IFMudmlldyB8fCAhUy5vcGVuKSByZXR1cm47CiAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnKSBucy5ub3Rlcy5mbHVzaCgpOwogICAgY2xvc2VNZW51KHJvb3QpOwogICAgUy5zZWFyY2ggPSBudWxsOwogICAgUy52aWV3ID0gdmlldzsKICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtLRVlTLnZpZXddOiB2aWV3IH0pLmNhdGNoKCgpID0-IHt9KTsKICAgIGlmICh2aWV3ID09PSAnbm90ZXMnKSBzaG93Tm90",
"ZXMoKTsKICAgIGVsc2UgaWYgKHZpZXcgPT09ICdjYWxlbmRhcicpIHNob3dDYWxlbmRhcigpOwogICAgZWxzZSBzaG93Qm9hcmQoKTsKICB9CgogIC8vIFRoZSBkb2NrJ3MgYnV0dG9uczogb3BlbiBvbiB0aGF0IHRhYiwgc3dpdGNoIHRvIGl0LCBvciAtIHdoZW4gaXQKICAvLyBpcyBhbHJlYWR5IHNob3dpbmcgLSBjbG9zZS4KICBmdW5jdGlvbiB0b2dnbGVWaWV3KHZpZXcpIHsKICAgIGlmIChTLm9wZW4gJiYgUy52aWV3ID09PSB2aWV3KSBjbG9zZSgpOwogICAgZWxzZSBpZiAoUy5vcGVuKSBzd2l0Y2hWaWV3KHZpZXcpOwogICAgZWxzZSBvcGVuKHsgdmlldyB9KTsKICB9CgogIGZ1bmN0aW9uIGNsb3NlKCkgewogICAgLy8gSW4gdGhlIHBob25lIGFwcCB0aGUgYm9hcmQgaXMgdGhlIGFwcDogdGhlcmUgaXMgbm90aGluZyB0byBjbG9zZSB0by4KICAgIGlmICghUy5vcGVuIHx8IGZyYW1lKSByZXR1cm47CiAgICAvLyBXaGF0ZXZlciB3YXMgdHlwZWQgaW4gdGhlIGxhc3Qgc2Vjb25kIG9yIHR3byBpcyBzYXZlZCBvbiB0aGUgd2F5IG91dC4KICAgIG5zLm5vdGVzLmZsdXNoKCk7CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBTLm9wZW4gPSBmYWxzZTsKICAgIFMuc2VhcmNoID0gbnVsbDsKICAgIFMuZHJhd2VyID0gbnVsbDsKICAgIFMuZWRpdG9yID0gbnVsbDsKICAgIHJlbmRlckRyYXdlcigpOwogICAgcmVuZGVyRWRpdG9yKCk7CiAgICBlbHMub3ZlcmxheS5oaWRkZW4gPSB0cnVlOwogICAgLy8gIkNvbHVtbnMg",
"c2F2ZWQiIG1lYW5zIG5vdGhpbmcgb25jZSB0aGUgYm9hcmQgaXMgZ29uZTsgZXJyb3JzIHN0YXkKICAgIC8vIHVudGlsIHJlYWQgb3IgdGltZWQgb3V0LCBzaW5jZSB0aGV5IG1heSBleHBsYWluIGEgY2FyZCB0aGF0IG1vdmVkIGJhY2suCiAgICBmb3IgKGNvbnN0IHQgb2Ygcm9vdC5xdWVyeVNlbGVjdG9yQWxsKCcudG9hc3Q6bm90KC50b2FzdC1lcnJvciknKSkgdC5yZW1vdmUoKTsKICAgIGNsZWFySW50ZXJ2YWwoUy50aWNrZXIpOwogICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uRG9jdW1lbnRLZXksIHRydWUpOwogICAgY29uc3QgYmFjayA9IFMucmV0dXJuRm9jdXM7CiAgICBTLnJldHVybkZvY3VzID0gbnVsbDsKICAgIGlmIChiYWNrICYmIGJhY2suaXNDb25uZWN0ZWQgJiYgdHlwZW9mIGJhY2suZm9jdXMgPT09ICdmdW5jdGlvbicpIGJhY2suZm9jdXMoKTsKICB9CgogIGZ1bmN0aW9uIHRvZ2dsZSgpIHsKICAgIGlmIChTLm9wZW4pIGNsb3NlKCk7CiAgICBlbHNlIG9wZW4oKTsKICB9CgogIC8vIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgc3RvcHMgYXQgYSBzaGFkb3cgaG9zdCAtIHRoZSBkb2NrJ3MsIHdoZW4gdGhlCiAgLy8gYm9hcmQgd2FzIG9wZW5lZCBmcm9tIGl0cyBidXR0b24gLSBhbmQgYSBob3N0IGNhbm5vdCB0YWtlIGZvY3VzIGJhY2suCiAgZnVuY3Rpb24gZGVlcEFjdGl2ZUVsZW1lbnQoKSB7CiAgICBsZXQgYSA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7CiAg",
"ICB3aGlsZSAoYSAmJiBhLnNoYWRvd1Jvb3QgJiYgYS5zaGFkb3dSb290LmFjdGl2ZUVsZW1lbnQpIGEgPSBhLnNoYWRvd1Jvb3QuYWN0aXZlRWxlbWVudDsKICAgIHJldHVybiBhOwogIH0KCiAgLy8g4pSA4pSAIEtleWJvYXJkIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBFc2MgcGVlbHMgYmFjayBvbmUgbGF5ZXIgYXQgYSB0aW1lOiBjYXJkIGVkaXRvciBvciBkcmF3ZXIsIHRoZW4KICAvLyBzZWFyY2gsIHRoZW4gYm9hcmQuIE9wZW4gbWVudXMgaGFuZGxlIHRoZWlyIG93biBFc2MgYmVmb3JlIGl0IGdldHMgaGVyZS4KICBmdW5jdGlvbiBvbk92ZXJsYXlLZXkoZSkgewogICAgaWYgKFMudmlldyA9PT0gJ25vdGVzJyAmJiAhUy5lZGl0b3IgJiYgbnMubm90ZXMuaGFuZGxlS2V5KGUpKSByZXR1cm47CiAgICBpZiAoUy52aWV3ID09PSAnY2FsZW5kYXInICYmICFTLmVkaXRvciAmJiAhUy5kcmF3ZXIgJiYgIWlzTWVudU9wZW4ocm9vdCkgJiYgbnMuY2FsZW5kYXIuaGFuZGxlS2V5KGUpKSByZXR1cm47CiAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7CiAgICAgIGlmIChpc01lbnVPcGVuKHJvb3QpKSByZXR1cm47CiAgICAgIGUucHJldmVudERl",
"ZmF1bHQoKTsKICAgICAgaWYgKFMuZWRpdG9yKSBjbG9zZUVkaXRvcigpOwogICAgICBlbHNlIGlmIChTLmRyYXdlcikgY2xvc2VEcmF3ZXIoKTsKICAgICAgZWxzZSBpZiAoUy5zZWFyY2gpIGNsb3NlU2VhcmNoKCk7CiAgICAgIGVsc2UgY2xvc2UoKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKGUua2V5ID09PSAnVGFiJyAmJiAhZnJhbWUpIHRyYXBGb2N1cyhlKTsKICB9CgogIC8vIElmIGZvY3VzIGhhcyBlc2NhcGVkIHRvIEdtYWlsJ3MgcGFnZSAoYSBjbGljayBvbiBpdHMgZWRnZSwgc2F5KSwgRXNjCiAgLy8gc2hvdWxkIHN0aWxsIGNsb3NlIHRoZSBib2FyZCByYXRoZXIgdGhhbiByZWFjaCBHbWFpbC4KICBmdW5jdGlvbiBvbkRvY3VtZW50S2V5KGUpIHsKICAgIC8vIEYzIHN0ZXBzIHRocm91Z2ggc2VhcmNoIG1hdGNoZXMgd2hlcmV2ZXIgdGhlIGZvY3VzIGhhcyB3YW5kZXJlZC4KICAgIGlmIChlLmtleSA9PT0gJ0YzJyAmJiBTLm9wZW4gJiYgUy52aWV3ID09PSAnbm90ZXMnICYmICFlLmNvbXBvc2VkUGF0aCgpLmluY2x1ZGVzKGVscy5vdmVybGF5KSkgewogICAgICBucy5ub3Rlcy5oYW5kbGVLZXkoZSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChlLmtleSAhPT0gJ0VzY2FwZScgfHwgIVMub3BlbiB8fCBmcmFtZSkgcmV0dXJuOwogICAgaWYgKGUuY29tcG9zZWRQYXRoKCkuaW5jbHVkZXMoZWxzLm92ZXJsYXkpKSByZXR1cm47CiAgICBpZiAoaXNNZW51T3Blbihyb290KSkgcmV0dXJuOwog",
"ICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgZS5zdG9wUHJvcGFnYXRpb24oKTsKICAgIGNsb3NlKCk7CiAgfQoKICAvLyBBIG1vZGFsIHRoYXQgbGV0cyBUYWIgd2FuZGVyIGludG8gdGhlIHBhZ2UgYmVoaW5kIGl0IGlzIG5vdCBtb2RhbC4KICBmdW5jdGlvbiB0cmFwRm9jdXMoZSkgewogICAgY29uc3Qgc2NvcGUgPSBTLmVkaXRvciA_IGVscy5lZGl0b3JMYXllciA6IFMuZHJhd2VyID8gZWxzLmRyYXdlckxheWVyIDogZWxzLm92ZXJsYXk7CiAgICBjb25zdCBmb2N1c2FibGUgPSBbLi4uc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uOm5vdChbZGlzYWJsZWRdKSwgaW5wdXQ6bm90KFtkaXNhYmxlZF0pLCB0ZXh0YXJlYTpub3QoW2Rpc2FibGVkXSknKV0KICAgICAgLmZpbHRlcihlbCA9PiBlbC5nZXRDbGllbnRSZWN0cygpLmxlbmd0aCk7CiAgICBpZiAoIWZvY3VzYWJsZS5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IGZpcnN0ID0gZm9jdXNhYmxlWzBdOwogICAgY29uc3QgbGFzdCA9IGZvY3VzYWJsZVtmb2N1c2FibGUubGVuZ3RoIC0gMV07CiAgICBjb25zdCBhY3RpdmUgPSByb290LmFjdGl2ZUVsZW1lbnQ7CiAgICBpZiAoZS5zaGlmdEtleSAmJiAoYWN0aXZlID09PSBmaXJzdCB8fCAhc2NvcGUuY29udGFpbnMoYWN0aXZlKSkpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBsYXN0LmZvY3VzKCk7IH0KICAgIGVsc2UgaWYgKCFlLnNoaWZ0S2V5ICYmIChhY3RpdmUgPT09IGxhc3QgfHwgIXNjb3BlLmNvbnRh",
"aW5zKGFjdGl2ZSkpKSB7IGUucHJldmVudERlZmF1bHQoKTsgZmlyc3QuZm9jdXMoKTsgfQogIH0KCiAgLy8g4pSA4pSAIExvYWRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHJlZnJlc2goKSB7CiAgICBpZiAoIVMubW91bnRlZCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOwogICAgaWYgKFMubG9hZGluZykgcmV0dXJuIFMubG9hZGluZzsKICAgIGlmICghUy5hY2NvdW50KSBTLmFjY291bnQgPSBob29rcy5nZXRBY2NvdW50KCk7CiAgICBpZiAoIVMuYWNjb3VudCkgewogICAgICBTLnN0YXR1cyA9ICdub19hY2NvdW50JzsKICAgICAgcmVuZGVyKCk7CiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTsKICAgIH0KCiAgICBjb25zdCBzdGFydGVkQXQgPSBTLm11dGF0aW9uczsKICAgIGxldCBvdmVydGFrZW4gPSBmYWxzZTsKCiAgICBTLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4gewogICAgICB1cGRhdGVCYXIoKTsKICAgICAgdHJ5IHsKICAgICAgICBTLmNvbHVtbnMgPSBhd2FpdCBzdG9yZS5sb2FkQ29sdW1ucyhTLmFjY291bnQpOwogICAgICAgIGNvbnN0IFtib2FyZCwgc2F2ZWQsIGVkaXRzXSA9IGF3YWl0IFByb21p",
"c2UuYWxsKFsKICAgICAgICAgIHN0b3JlLmxvYWRCb2FyZChTLmFjY291bnQsIFMuY29sdW1ucyksCiAgICAgICAgICBzdG9yZS5sb2FkT3JkZXIoUy5hY2NvdW50KSwKICAgICAgICAgIHN0b3JlLmxvYWRDYXJkRWRpdHMoUy5hY2NvdW50KSwKICAgICAgICBdKTsKICAgICAgICBTLmVkaXRzID0gZWRpdHM7CiAgICAgICAgLy8gTGFiZWwgbmFtZXMgYXMgR21haWwgaGFzIHRoZW0gbm93OyBhIGNvbHVtbiBmb2xsb3dzIGEgcmVuYW1lLgogICAgICAgIFMuY29sdW1ucyA9IGJvYXJkLmNvbHVtbnM7CiAgICAgICAgLy8gQSBjYXJkIG1vdmVkIHdoaWxlIHRoZSBsaXN0cyB3ZXJlIGluIGZsaWdodDogd2hhdCBjYW1lIGJhY2sgbWF5CiAgICAgICAgLy8gcHJlZGF0ZSB0aGF0IG1vdmUgYW5kIHdvdWxkIHNuYXAgdGhlIGNhcmQgYmFjay4gVGhyb3cgaXQgYXdheSBhbmQKICAgICAgICAvLyBhc2sgYWdhaW47IGxvYWRCb2FyZCB3YWl0cyBmb3IgdGhlIG1vdmUgdG8gbGFuZCBmaXJzdC4KICAgICAgICBpZiAoUy5tdXRhdGlvbnMgIT09IHN0YXJ0ZWRBdCkgewogICAgICAgICAgb3ZlcnRha2VuID0gdHJ1ZTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgY29uc3QgbGlzdHMgPSB7fTsKICAgICAgICBmb3IgKGNvbnN0IGNvbCBvZiBTLmNvbHVtbnMpIHsKICAgICAgICAgIGNvbnN0IHRocmVhZHMgPSAoYm9hcmQubGlzdHNbY29sLmlkXSB8fCBbXSkubWFwKGlkID0-ICh7IGlkLCB0czogKHN0b3JlLnRocmVh",
"ZChpZCkgfHwge30pLnRzIH0pKTsKICAgICAgICAgIGxpc3RzW2NvbC5pZF0gPSBsb2dpYy5tZXJnZU9yZGVyKHNhdmVkW2NvbC5pZF0sIHRocmVhZHMpOwogICAgICAgIH0KICAgICAgICBTLmxpc3RzID0gbGlzdHM7CiAgICAgICAgUy50cnVuY2F0ZWQgPSBib2FyZC50cnVuY2F0ZWQ7CiAgICAgICAgUy5sb2FkZWRBdCA9IERhdGUubm93KCk7CiAgICAgICAgUy5zdGF0dXMgPSAncmVhZHknOwogICAgICAgIFMuc3RhdHVzTWVzc2FnZSA9ICcnOwogICAgICAgIC8vIFNhdmVkIGRpcmVjdGx5LCBub3QgdmlhIHBlcnNpc3RPcmRlcjogdGhpcyBwcnVuZXMgdmFuaXNoZWQgaWRzCiAgICAgICAgLy8gYW5kIGlzIG5vdCBhIGxvY2FsIG1vdmUuCiAgICAgICAgc3RvcmUuc2F2ZU9yZGVyKFMuYWNjb3VudCwgUy5saXN0cywgUy5jb2x1bW5zKS5jYXRjaCgoKSA9PiB7fSk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGhhbmRsZUVycm9yKGVyciwgJ0NvdWxkbuKAmXQgbG9hZCB0aGUgYm9hcmQnKTsKICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBTLmxvYWRpbmcgPSBudWxsOwogICAgICAgIGlmICghb3ZlcnRha2VuKSB7CiAgICAgICAgICByZW5kZXIoKTsKICAgICAgICAgIGlmIChTLnNlYXJjaCAmJiBTLnNlYXJjaC5pZHMgPT09IG51bGwpIHJ1blNlYXJjaCgpOwogICAgICAgIH0KICAgICAgfQogICAgfSkoKTsKICAgIGNvbnN0IHAgPSBTLmxvYWRpbmc7CiAgICByZXR1cm4gcC50aGVuKCgpID0-IChvdmVydGFr",
"ZW4gPyByZWZyZXNoKCkgOiB1bmRlZmluZWQpKTsKICB9CgogIC8vIFRoZSB0aHJlZSBhY2NvdW50IHN0YXRlcyBnZXQgYSBwYW5lbCBvZiB0aGVpciBvd247IGFueXRoaW5nIGVsc2UgaXMKICAvLyBhIHRvYXN0IG92ZXIgd2hhdGV2ZXIgd2FzIGFscmVhZHkgb24gc2NyZWVuLgogIGZ1bmN0aW9uIGhhbmRsZUVycm9yKGVyciwgcHJlZml4KSB7CiAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHsKICAgICAgUy5zdGF0dXMgPSBlcnIuY29kZTsKICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgIFMuc2VhcmNoID0gbnVsbDsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKFMuc3RhdHVzICE9PSAncmVhZHknKSB7CiAgICAgIFMuc3RhdHVzID0gJ2Vycm9yJzsKICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRvYXN0KHJvb3QsIGAke3ByZWZpeH06ICR7ZXJyLm1lc3NhZ2V9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogIH0KCiAgLy8gRXZlcnkgbG9jYWwgY2hhbmdlIHRvIHRoZSBsaXN0cyBnb2VzIHRocm91Z2ggaGVyZSwgd2hpY2ggaXMgYWxzbyB3aGF0CiAgLy8gbWFya3MgYW4gaW4tZmxpZ2h0IHJlZnJlc2ggYXMgb3ZlcnRha2VuLgogIGZ1bmN0aW9uIHBlcnNpc3RPcmRlcigpIHsKICAgIFMubXV0YXRpb25zKys7CiAgICBzdG9yZS5zYXZlT3JkZXIoUy5hY2NvdW50LCBTLmxpc3RzLCBTLmNvbHVtbnMpLmNh",
"dGNoKCgpID0-IHt9KTsKICB9CgogIC8vIOKUgOKUgCBSZW5kZXJpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHVwZGF0ZUJhcigpIHsKICAgIGlmICghUy5tb3VudGVkKSByZXR1cm47CiAgICBlbHMuYWNjb3VudC50ZXh0Q29udGVudCA9IFMuYWNjb3VudCB8fCAnQWNjb3VudCBub3QgZGV0ZWN0ZWQnOwogICAgZWxzLmFjY291bnQudGl0bGUgPSBTLmFjY291bnQgPyBgR21haWwgYWNjb3VudDogJHtTLmFjY291bnR9YCA6ICcnOwogICAgLy8gVGhlIHJlZnJlc2ggYnV0dG9uIGFuZCAidXBkYXRlZCDigKYiIHNwZWFrIGZvciB3aGljaGV2ZXIgdGFiIGlzIG9wZW4uCiAgICBjb25zdCBub3RlcyA9IFMudmlldyA9PT0gJ25vdGVzJzsKICAgIGNvbnN0IGNhbGVuZGFyID0gUy52aWV3ID09PSAnY2FsZW5kYXInOwogICAgY29uc3QgbG9hZGluZyA9IG5vdGVzID8gbnMubm90ZXMuaXNMb2FkaW5nKCkgOiBjYWxlbmRhciA_IG5zLmNhbGVuZGFyLmlzTG9hZGluZygpIDogISFTLmxvYWRpbmc7CiAgICBjb25zdCBsb2FkZWRBdCA9IG5vdGVzID8gbnMubm90ZXMubG9hZGVkQXQoKSA6IGNhbGVuZGFyID8gbnMuY2FsZW5kYXIubG9hZGVkQXQoKSA6",
"IFMubG9hZGVkQXQ7CiAgICBlbHMudXBkYXRlZC50ZXh0Q29udGVudCA9IGxvYWRpbmcgPyAnVXBkYXRpbmfigKYnCiAgICAgIDogbG9hZGVkQXQgPyBgdXBkYXRlZCAke3V0aWwuYWdvVGV4dChEYXRlLm5vdygpIC0gbG9hZGVkQXQpfWAgOiAnJzsKICAgIGVscy5yZWZyZXNoLmNsYXNzTGlzdC50b2dnbGUoJ3NwaW5uaW5nJywgbG9hZGluZyk7CiAgICBlbHMucmVmcmVzaC5kaXNhYmxlZCA9IGxvYWRpbmcgfHwgIVMuYWNjb3VudDsKICAgIGVscy5zZXR0aW5ncy5oaWRkZW4gPSBub3RlcyB8fCBjYWxlbmRhcjsKICAgIGVscy5zZXR0aW5ncy5kaXNhYmxlZCA9IFMuc3RhdHVzICE9PSAncmVhZHknOwogICAgZm9yIChjb25zdCB0IG9mIGVscy50YWJzLmNoaWxkcmVuKSB0LnNldEF0dHJpYnV0ZSgnYXJpYS1zZWxlY3RlZCcsIFN0cmluZyh0LmRhdGFzZXQudmlldyA9PT0gUy52aWV3KSk7CiAgICBpZiAobm90ZXMpIG5zLm5vdGVzLnRpY2soKTsKICAgIGlmIChjYWxlbmRhcikgbnMuY2FsZW5kYXIudGljaygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyKCkgewogICAgaWYgKCFTLm1vdW50ZWQpIHJldHVybjsKICAgIC8vIFJlYnVpbGRpbmcgdGhlIGNvbHVtbnMgbWlkLWRyYWcgd291bGQgcHVsbCB0aGUgY2FyZCBvdXQgZnJvbSB1bmRlcgogICAgLy8gdGhlIHBvaW50ZXIuIFdoYXRldmVyIGNoYW5nZWQgaXMgZHJhd24gb25jZSB0aGUgZHJhZyBlbmRzLgogICAgaWYgKFMuZHJhZykgeyBTLnJlbmRlckRlZmVycmVkID0g",
"dHJ1ZTsgcmV0dXJuOyB9CgogICAgdXBkYXRlQmFyKCk7CiAgICBjbG9zZU1lbnUocm9vdCk7CgogICAgY29uc3Qga2V5ID0gZm9jdXNLZXkoKTsKICAgIGNvbnN0IHNjcm9sbCA9IGNhcHR1cmVTY3JvbGwoKTsKICAgIC8vIFRoZSBub3RlcyB2aWV3IGhhbmRzIGJhY2sgdGhlIHNhbWUgZWxlbWVudCBldmVyeSB0aW1lOyBwdXR0aW5nIGl0CiAgICAvLyBiYWNrIHdvdWxkIGJsdXIgdGhlIHRleHQgYm94IG1pZC1zZW50ZW5jZSwgc28gaXQgaXMgbGVmdCBpbiBwbGFjZS4KICAgIGNvbnN0IG5leHQgPSByZW5kZXJCb2R5KCk7CiAgICBpZiAoZWxzLmJvZHkuZmlyc3RDaGlsZCAhPT0gbmV4dCB8fCBlbHMuYm9keS5jaGlsZE5vZGVzLmxlbmd0aCAhPT0gMSkgZWxzLmJvZHkucmVwbGFjZUNoaWxkcmVuKG5leHQpOwogICAgcmVzdG9yZVNjcm9sbChzY3JvbGwpOwogICAgcmVzdG9yZUZvY3VzKGtleSwgZWxzLmJvZHkpOwogICAgLy8gVGhlIGZvY3VzZWQgY2FyZCBtYXkgYmUgZ29uZSAocmVtb3ZlZCwgb3IgbW92ZWQgb2ZmIGEgY29sdW1uIHRoYXQKICAgIC8vIHJlLXJlbmRlcmVkKS4gS2VlcCBmb2N1cyBpbiB0aGUgZGlhbG9nIHJhdGhlciB0aGFuIGRyb3BwaW5nIGl0IG9uCiAgICAvLyBHbWFpbCdzIHBhZ2UsIHdoZXJlIHRoZSBuZXh0IGtleSBwcmVzcyB3b3VsZCBiZSBHbWFpbCdzLgogICAgaWYgKGtleSAmJiBTLm9wZW4gJiYgIWVscy5vdmVybGF5LmNvbnRhaW5zKHJvb3QuYWN0aXZlRWxlbWVudCkpIGVscy5vdmVy",
"bGF5LmZvY3VzKCk7CiAgfQoKICBmdW5jdGlvbiBmb2N1c0tleSgpIHsKICAgIGNvbnN0IGEgPSByb290LmFjdGl2ZUVsZW1lbnQ7CiAgICByZXR1cm4gYSAmJiBhLmRhdGFzZXQgPyBhLmRhdGFzZXQua2V5IHx8ICcnIDogJyc7CiAgfQoKICBmdW5jdGlvbiByZXN0b3JlRm9jdXMoa2V5LCBzY29wZSkgewogICAgaWYgKCFrZXkpIHJldHVybjsKICAgIGNvbnN0IGVsID0gWy4uLnNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWtleV0nKV0uZmluZCh4ID0-IHguZGF0YXNldC5rZXkgPT09IGtleSk7CiAgICBpZiAoIWVsIHx8IGVsLmRpc2FibGVkKSByZXR1cm47CiAgICBlbC5mb2N1cyh7IHByZXZlbnRTY3JvbGw6IHRydWUgfSk7CiAgICBpZiAoZWwudGFnTmFtZSA9PT0gJ0lOUFVUJyAmJiBlbC50eXBlICE9PSAnY2hlY2tib3gnKSB7CiAgICAgIGNvbnN0IG4gPSBlbC52YWx1ZS5sZW5ndGg7CiAgICAgIHRyeSB7IGVsLnNldFNlbGVjdGlvblJhbmdlKG4sIG4pOyB9IGNhdGNoIHsgLyogbm90IGEgdGV4dCBpbnB1dCAqLyB9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBjYXB0dXJlU2Nyb2xsKCkgewogICAgY29uc3Qgb3V0ID0geyBsZWZ0OiAwLCBsaXN0czoge30gfTsKICAgIGNvbnN0IGNvbHMgPSBlbHMuYm9keS5xdWVyeVNlbGVjdG9yKCcuY29sdW1ucycpOwogICAgaWYgKCFjb2xzKSByZXR1cm4gb3V0OwogICAgb3V0LmxlZnQgPSBjb2xzLnNjcm9sbExlZnQ7CiAgICBmb3IgKGNvbnN0IHNlYyBvZiBjb2xzLnF1",
"ZXJ5U2VsZWN0b3JBbGwoJy5jb2x1bW4nKSkgewogICAgICBjb25zdCBsaXN0ID0gc2VjLnF1ZXJ5U2VsZWN0b3IoJy5saXN0Jyk7CiAgICAgIGlmIChsaXN0KSBvdXQubGlzdHNbc2VjLmRhdGFzZXQuY29sXSA9IGxpc3Quc2Nyb2xsVG9wOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIHJlc3RvcmVTY3JvbGwocykgewogICAgY29uc3QgY29scyA9IGVscy5ib2R5LnF1ZXJ5U2VsZWN0b3IoJy5jb2x1bW5zJyk7CiAgICBpZiAoIWNvbHMpIHJldHVybjsKICAgIGNvbHMuc2Nyb2xsTGVmdCA9IHMubGVmdDsKICAgIGZvciAoY29uc3Qgc2VjIG9mIGNvbHMucXVlcnlTZWxlY3RvckFsbCgnLmNvbHVtbicpKSB7CiAgICAgIGNvbnN0IGxpc3QgPSBzZWMucXVlcnlTZWxlY3RvcignLmxpc3QnKTsKICAgICAgaWYgKGxpc3QgJiYgcy5saXN0c1tzZWMuZGF0YXNldC5jb2xdKSBsaXN0LnNjcm9sbFRvcCA9IHMubGlzdHNbc2VjLmRhdGFzZXQuY29sXTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckJvZHkoKSB7CiAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnICYmICFQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSkgcmV0dXJuIG5zLm5vdGVzLmVsZW1lbnQoKTsKICAgIGlmIChTLnZpZXcgPT09ICdjYWxlbmRhcicgJiYgIVBBTkVMX1NUQVRFUy5oYXMoUy5zdGF0dXMpKSByZXR1cm4gbnMuY2FsZW5kYXIuZWxlbWVudCgpOwogICAgc3dpdGNoIChTLnN0YXR1cykgewogICAgICBjYXNlICdub19hY2Nv",
"dW50JzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2JvYXJkJywgJ1doaWNoIGFjY291bnQgaXMgdGhpcz8nLAogICAgICAgICAgYCR7QVBQX05BTUV9IGNvdWxkbuKAmXQgdGVsbCB3aGljaCBHb29nbGUgYWNjb3VudCB0aGlzIEdtYWlsIHRhYiBiZWxvbmdzIHRvLCBzbyBpdCBkb2VzbuKAmXQga25vdyB3aG9zZSBib2FyZCB0byBzaG93LiBSZWxvYWRpbmcgR21haWwgdXN1YWxseSBzb3J0cyBpdCBvdXQuYCwKICAgICAgICAgIFtdKTsKICAgICAgY2FzZSAnbm90X2NvbmZpZ3VyZWQnOgogICAgICAgIHJldHVybiBwYW5lbCgndHVuZScsICdGaW5pc2ggc2V0dGluZyB1cCcsCiAgICAgICAgICAnQWRkIHlvdXIgT0F1dGggY2xpZW50IElEIG9uIHRoZSBzZXR1cCBwYWdlLiBJdCBpcyBhIG9uZS1vZmYgYW5kIHRha2VzIGEgY291cGxlIG9mIG1pbnV0ZXMuJywKICAgICAgICAgIFtidXR0b24oJ09wZW4gc2V0dXAnLCAncHJpbWFyeScsICgpID0-IGFwaS5vcGVuT3B0aW9ucygpLmNhdGNoKGVyciA9PiB0b2FzdChyb290LCBlcnIubWVzc2FnZSwgeyBraW5kOiAnZXJyb3InIH0pKSldKTsKICAgICAgY2FzZSAnYXV0aF9yZXF1aXJlZCc6CiAgICAgICAgcmV0dXJuIHBhbmVsKCdib2FyZCcsICdDb25uZWN0IEdtYWlsJywKICAgICAgICAgIGBBbGxvdyAke0FQUF9OQU1FfSB0byByZWFkIGFuZCBsYWJlbCBtYWlsIGluICR7Uy5hY2NvdW50fS4gR29vZ2xlIHdpbGwgYXNrIHlvdSB0byBjb25maXJtLmAsCiAgICAgICAgICBbYnV0",
"dG9uKCdDb25uZWN0IEdtYWlsJywgJ3ByaW1hcnknLCBjb25uZWN0KV0pOwogICAgICBjYXNlICdhY2NvdW50X21pc21hdGNoJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2JvYXJkJywgJ1RoYXQgd2FzIGEgZGlmZmVyZW50IGFjY291bnQnLAogICAgICAgICAgYCR7Uy5zdGF0dXNNZXNzYWdlfSBUaGUgYm9hcmQgb25seSBldmVyIGFjdHMgb24gdGhlIG1haWxib3ggb3BlbiBpbiB0aGlzIHRhYi4gQ29ubmVjdCBhZ2FpbiBhbmQgY2hvb3NlICR7Uy5hY2NvdW50fS5gLAogICAgICAgICAgW2J1dHRvbignQ29ubmVjdCBhZ2FpbicsICdwcmltYXJ5JywgY29ubmVjdCldKTsKICAgICAgY2FzZSAnZXJyb3InOgogICAgICAgIHJldHVybiBwYW5lbCgncmVmcmVzaCcsICdDb3VsZG7igJl0IGxvYWQgdGhlIGJvYXJkJywgUy5zdGF0dXNNZXNzYWdlLAogICAgICAgICAgW2J1dHRvbignVHJ5IGFnYWluJywgJ3ByaW1hcnknLCAoKSA9PiByZWZyZXNoKCkpXSk7CiAgICAgIGRlZmF1bHQ6CiAgICAgICAgcmV0dXJuIHJlbmRlckNvbHVtbnMoKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHBhbmVsKGljb25OYW1lLCB0aXRsZSwgdGV4dCwgYWN0aW9ucykgewogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdwYW5lbCcsIHJvbGU6ICdyZWdpb24nLCAnYXJpYS1sYWJlbCc6IHRpdGxlIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncGFuZWwtaWNvbicgfSwgaWNvbihpY29uTmFtZSwgMjgpKSwKICAgICAgaCgnaDInLCB7IHRl",
"eHQ6IHRpdGxlIH0pLAogICAgICBoKCdwJywgeyB0ZXh0IH0pLAogICAgICBhY3Rpb25zLmxlbmd0aCA_IGgoJ2RpdicsIHsgY2xhc3M6ICdhY3Rpb25zJyB9LCBhY3Rpb25zKSA6IG51bGwpOwogIH0KCiAgZnVuY3Rpb24gYnV0dG9uKGxhYmVsLCBraW5kLCBvbkNsaWNrKSB7CiAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogWydidG4nLCBgYnRuLSR7a2luZH1gXSwgdHlwZTogJ2J1dHRvbicsIHRleHQ6IGxhYmVsLAogICAgICBvbmNsaWNrOiBlID0-IG9uQ2xpY2soZS5jdXJyZW50VGFyZ2V0KSwKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gY29ubmVjdChidG4pIHsKICAgIGlmIChidG4pIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkuY29ubmVjdCgpOwogICAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnKSB7CiAgICAgICAgUy5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgYXdhaXQgbnMubm90ZXMubG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBTLnN0YXR1cyA9ICdsb2FkaW5nJzsKICAgICAgcmVuZGVyKCk7CiAgICAgIGF3YWl0IHJlZnJlc2goKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAoZXJyLmNvZGUgPT09ICdhY2NvdW50X21pc21hdGNoJyB8fCBlcnIuY29kZSA9PT0gJ25vdF9jb25maWd1cmVkJykgewogICAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7",
"CiAgICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdG9hc3Qocm9vdCwgYENvdWxkbuKAmXQgY29ubmVjdDogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgIH0KICAgIH0gZmluYWxseSB7CiAgICAgIGlmIChidG4gJiYgYnRuLmlzQ29ubmVjdGVkKSBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckNvbHVtbnMoKSB7CiAgICBjb25zdCBza2VsZXRvbiA9IFMuc3RhdHVzICE9PSAncmVhZHknOwogICAgY29uc3Qgd3JhcCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjb2x1bW5zJyB9KTsKICAgIGZvciAoY29uc3QgY29sIG9mIFMuY29sdW1ucykgd3JhcC5hcHBlbmRDaGlsZChyZW5kZXJDb2x1bW4oY29sLCBza2VsZXRvbikpOwogICAgd3JhcC5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsIG9uRHJhZ092ZXIpOwogICAgd3JhcC5hZGRFdmVudExpc3RlbmVyKCdkcm9wJywgb25Ecm9wKTsKICAgIHJldHVybiB3cmFwOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQ29sdW1uKGNvbCwgc2tlbGV0b24pIHsKICAgIGNvbnN0IGlkcyA9IFMubGlzdHNbY29sLmlkXSB8fCBbXTsKICAgIGNvbnN0IHNlYXJjaGluZyA9ICEhKFMuc2VhcmNoICYmIFMuc2VhcmNoLmNvbElkID09PSBjb2wuaWQpOwoKICAgIGNvbnN0IGxpc3QgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbGlz",
"dCcsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiBgJHtjb2wudGl0bGV9OiB0aHJlYWRzYCwKICAgICAgJ2RhdGEtZW1wdHknOiAnRHJhZyB0aHJlYWRzIGhlcmUsIG9yIHVzZSArIHRvIGZpbmQgb25lJywKICAgIH0pOwogICAgaWYgKHNrZWxldG9uKSB7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSBsaXN0LmFwcGVuZENoaWxkKGgoJ2RpdicsIHsgY2xhc3M6ICdza2VsZXRvbicsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KSk7CiAgICB9IGVsc2UgewogICAgICBmb3IgKGNvbnN0IGlkIG9mIGlkcykgewogICAgICAgIGNvbnN0IGNhcmQgPSByZW5kZXJDYXJkKGlkLCBjb2wpOwogICAgICAgIGlmIChjYXJkKSBsaXN0LmFwcGVuZENoaWxkKGNhcmQpOwogICAgICB9CiAgICB9CgogICAgY29uc3QgY291bnQgPSBTLnRydW5jYXRlZFtjb2wuaWRdID8gYCR7aWRzLmxlbmd0aH0rYCA6IFN0cmluZyhpZHMubGVuZ3RoKTsKICAgIGNvbnN0IGhlYWQgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY29sLWhlYWQnIH0sCiAgICAgIGgoJ2gyJywgeyBjbGFzczogJ2NvbC10aXRsZScsIHRleHQ6IGNvbC50aXRsZSwgdGl0bGU6IGBHbWFpbCBsYWJlbDogJHtjb2wubGFiZWx9YCB9KSwKICAgICAgc2tlbGV0b24gPyBudWxsIDogaCgnc3BhbicsIHsgY2xhc3M6ICdjb2wtY291bnQnLCB0ZXh0OiBjb3VudCwgJ2FyaWEtbGFiZWwnOiBgJHtjb3VudH0gdGhyZWFkc2AgfSksCiAgICAgIGNvbC5hcmNoaXZlT25Ecm9wID8g",
"aCgnc3BhbicsIHsKICAgICAgICBjbGFzczogJ2NvbC1mbGFnJywgdGV4dDogJ0FyY2hpdmVzJywKICAgICAgICB0aXRsZTogJ01vdmluZyBhIHRocmVhZCBoZXJlIGFsc28gYXJjaGl2ZXMgaXQgKHRha2VzIGl0IG91dCBvZiB0aGUgSW5ib3gpJywKICAgICAgfSkgOiBudWxsLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc3BhY2VyJyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywKICAgICAgICAnYXJpYS1sYWJlbCc6IGBGaW5kIGEgdGhyZWFkIHRvIGFkZCB0byAke2NvbC50aXRsZX1gLCB0aXRsZTogJ0FkZCBmcm9tIEdtYWlsJywKICAgICAgICAnYXJpYS1leHBhbmRlZCc6IFN0cmluZyhzZWFyY2hpbmcpLCBkaXNhYmxlZDogc2tlbGV0b24sCiAgICAgICAgZGF0YXNldDogeyBrZXk6IGBhZGQ6JHtjb2wuaWR9YCwgYWN0aW9uOiAnYWRkJyB9LAogICAgICAgIG9uY2xpY2s6ICgpID0-IHRvZ2dsZVNlYXJjaChjb2wuaWQpLAogICAgICB9LCBpY29uKHNlYXJjaGluZyA_ICdjbG9zZScgOiAnYWRkJykpKTsKCiAgICByZXR1cm4gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdjb2x1bW4nLCAnYXJpYS1sYWJlbCc6IGNvbC50aXRsZSwgZGF0YXNldDogeyBjb2w6IGNvbC5pZCB9IH0sCiAgICAgIGhlYWQsCiAgICAgIFMudHJ1bmNhdGVkW2NvbC5pZF0gPyBoKCdkaXYnLCB7IGNsYXNzOiAnY29sLW5vdGUnLCB0ZXh0OiAnU2hvd2luZyB0aGUgZmlyc3Qg",
"MTAwIHRocmVhZHMnIH0pIDogbnVsbCwKICAgICAgc2VhcmNoaW5nID8gcmVuZGVyU2VhcmNoKGNvbCkgOiBudWxsLAogICAgICBsaXN0KTsKICB9CgogIC8vIEEgY2FyZCBzaG93cyB0aGUgdXNlcidzIG93biB0aXRsZSBhbmQgbm90ZSB3aGVuIGl0IGhhcyB0aGVtLiBUaGUKICAvLyBlbWFpbCdzIHN1YmplY3Qgc3RheXMgb25lIGhvdmVyIGF3YXksIHNvIGEgcmVuYW1lZCBjYXJkIGNhbiBhbHdheXMgYmUKICAvLyBtYXRjaGVkIHRvIHRoZSBtYWlsIGJlaGluZCBpdC4KICBmdW5jdGlvbiByZW5kZXJDYXJkKGlkLCBjb2wpIHsKICAgIGNvbnN0IHQgPSBzdG9yZS50aHJlYWQoaWQpOwogICAgaWYgKCF0KSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGRhdGUgPSB1dGlsLnJlbGF0aXZlRGF0ZSh0LnRzKTsKICAgIGNvbnN0IGVkaXQgPSBTLmVkaXRzLmdldChpZCkgfHwgbnVsbDsKICAgIGNvbnN0IHRpdGxlID0gbG9naWMuZGlzcGxheVRpdGxlKHQsIGVkaXQpOwoKICAgIGNvbnN0IG1haW4gPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnY2FyZC1tYWluJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiBgY2FyZDoke2lkfWAgfSwKICAgICAgdGl0bGU6IGVkaXQgJiYgZWRpdC50aXRsZQogICAgICAgID8gYEVtYWlsIHN1YmplY3Q6ICR7dC5zdWJqZWN0fVxuT3BlbiBpbiBHbWFpbCAoQ3RybC1jbGljayBmb3IgYSBuZXcgdGFiKWAKICAgICAgICA6ICdPcGVuIGluIEdtYWlsIChDdHJsLWNsaWNrIGZvciBh",
"IG5ldyB0YWIpJywKICAgICAgb25jbGljazogZSA9PiBvcGVuVGhyZWFkKGlkLCBlKSwKICAgICAgb25hdXhjbGljazogZSA9PiB7IGlmIChlLmJ1dHRvbiA9PT0gMSkgeyBlLnByZXZlbnREZWZhdWx0KCk7IG9wZW5UaHJlYWQoaWQsIHsgY3RybEtleTogdHJ1ZSB9KTsgfSB9LAogICAgfSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdjYXJkLXRvcCcgfSwKICAgICAgICB0LnVucmVhZCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZG90JywgdGl0bGU6ICdVbnJlYWQnIH0pIDogbnVsbCwKICAgICAgICB0LnVucmVhZCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3Itb25seScsIHRleHQ6ICdVbnJlYWQuICcgfSkgOiBudWxsLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZnJvbScsIHRleHQ6IHQuZnJvbSB9KSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RhdGUnLCB0ZXh0OiBkYXRlLCB0aXRsZTogdXRpbC5mdWxsRGF0ZSh0LnRzKSB9KSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3ViamVjdC1yb3cnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdzdWJqZWN0JywgdGV4dDogdGl0bGUgfSksCiAgICAgICAgdC5oYXNEcmFmdCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZHJhZnQnLCB0ZXh0OiAnRHJhZnQnIH0pIDogbnVsbCwKICAgICAgICB0LnN0YXJyZWQgPyBoKCdzcGFuJywgeyBjbGFzczogJ3N0YXInLCB0aXRsZTogJ1N0YXJyZWQnLCAnYXJpYS1sYWJlbCc6ICdTdGFycmVkJyB9LCBpY29u",
"KCdzdGFyJywgMTYpKSA6IG51bGwsCiAgICAgICAgdC5jb3VudCA-IDEgPyBoKCdzcGFuJywgeyBjbGFzczogJ2NvdW50JywgdGV4dDogU3RyaW5nKHQuY291bnQpLCB0aXRsZTogYCR7dC5jb3VudH0gbWVzc2FnZXNgIH0pIDogbnVsbCksCiAgICAgIGVkaXQgJiYgZWRpdC5ub3RlCiAgICAgICAgPyBoKCdzcGFuJywgeyBjbGFzczogJ2NhcmQtbm90ZScgfSwgaCgnc3BhbicsIHsgY2xhc3M6ICdzci1vbmx5JywgdGV4dDogJ05vdGU6ICcgfSksIGVkaXQubm90ZSkKICAgICAgICA6IHQuc25pcHBldCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnc25pcHBldCcsIHRleHQ6IHQuc25pcHBldCB9KSA6IG51bGwpOwoKICAgIGNvbnN0IG1vcmUgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnaWNvbi1idG4gY2FyZC1tZW51JywgdHlwZTogJ2J1dHRvbicsCiAgICAgICdhcmlhLWxhYmVsJzogYE1vcmUgYWN0aW9uczogJHt0aXRsZX1gLCB0aXRsZTogJ01vcmUgYWN0aW9ucycsCiAgICAgICdhcmlhLWhhc3BvcHVwJzogJ21lbnUnLCAnYXJpYS1leHBhbmRlZCc6ICdmYWxzZScsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgbWVudToke2lkfWAgfSwKICAgICAgb25jbGljazogZSA9PiBvcGVuQ2FyZE1lbnUoZS5jdXJyZW50VGFyZ2V0LCBpZCwgY29sLmlkKSwKICAgIH0sIGljb24oJ21vcmUnLCAyMCkpOwoKICAgIGNvbnN0IGNhcmQgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiBbJ2NhcmQnLCB0LnVucmVhZCAmJiAndW5yZWFk",
"J10sIHJvbGU6ICdsaXN0aXRlbScsIGRyYWdnYWJsZTogJ3RydWUnLAogICAgICBkYXRhc2V0OiBlZGl0ICYmIGVkaXQuY29sb3VyID8geyBpZCwgY29sb3VyOiBlZGl0LmNvbG91ciB9IDogeyBpZCB9LAogICAgfSwgbWFpbiwgbW9yZSk7CiAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIGUgPT4gb25EcmFnU3RhcnQoZSwgaWQsIGNvbC5pZCwgY2FyZCkpOwogICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgb25EcmFnRW5kKTsKICAgIHJldHVybiBjYXJkOwogIH0KCiAgZnVuY3Rpb24gYW5ub3VuY2UobXNnKSB7CiAgICBlbHMubGl2ZS50ZXh0Q29udGVudCA9IG1zZzsKICB9CgogIC8vIOKUgOKUgCBDYXJkIGFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG9wZW5UaHJlYWQoaWQsIGUpIHsKICAgIGlmIChlICYmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuc2hpZnRLZXkpKSB7CiAgICAgIHdpbmRvdy5vcGVuKGhvb2tzLnRocmVhZFVybChpZCksICdfYmxhbmsnLCAnbm9vcGVuZXInKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY2xvc2UoKTsKICAgIGhvb2tzLm9wZW5UaHJlYWQoaWQpOwogIH0KCiAg",
"ZnVuY3Rpb24gY29sdW1uT2YoaWQpIHsKICAgIHJldHVybiBTLmNvbHVtbnMuZmluZChjID0-IChTLmxpc3RzW2MuaWRdIHx8IFtdKS5pbmNsdWRlcyhpZCkpIHx8IG51bGw7CiAgfQoKICBmdW5jdGlvbiBjYXJkVGl0bGUoaWQpIHsKICAgIHJldHVybiBsb2dpYy5kaXNwbGF5VGl0bGUoc3RvcmUudGhyZWFkKGlkKSwgUy5lZGl0cy5nZXQoaWQpKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5DYXJkTWVudShhbmNob3IsIGlkLCBjb2xJZCkgewogICAgY29uc3QgbGlzdCA9IFMubGlzdHNbY29sSWRdIHx8IFtdOwogICAgY29uc3QgYXQgPSBsaXN0LmluZGV4T2YoaWQpOwogICAgb3Blbk1lbnUocm9vdCwgYW5jaG9yLCBbCiAgICAgIHsgbGFiZWw6ICdPcGVuIGluIEdtYWlsJywgaWNvbjogJ29wZW4nLCBrZXk6ICdvcGVuJywgb25TZWxlY3Q6ICgpID0-IG9wZW5UaHJlYWQoaWQpIH0sCiAgICAgIHsgbGFiZWw6ICdFZGl0IGNhcmTigKYnLCBpY29uOiAnZWRpdCcsIGtleTogJ2VkaXQnLCBvblNlbGVjdDogKCkgPT4gb3BlbkVkaXRvcihpZCkgfSwKICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgLy8gUmVvcmRlcmluZyBpcyBhIGRyYWcgb3RoZXJ3aXNlOyB0aGVzZSBrZWVwIGl0IHdpdGhpbiByZWFjaCBvZiB0aGUKICAgICAgLy8ga2V5Ym9hcmQuIEZvY3VzIHJldHVybnMgdG8gdGhpcyBjYXJkJ3MgbWVudSBidXR0b24gYWZ0ZXJ3YXJkcywgc28KICAgICAgLy8gcmVwZWF0ZWQgcHJlc3NlcyBrZWVwIG1vdmluZyB0",
"aGUgc2FtZSBjYXJkLgogICAgICB7IGxhYmVsOiAnTW92ZSB1cCcsIGljb246ICd1cCcsIGtleTogJ3VwJywgZGlzYWJsZWQ6IGF0IDw9IDAsIG9uU2VsZWN0OiAoKSA9PiBtb3ZlVGhyZWFkKGlkLCBjb2xJZCwgY29sSWQsIGF0IC0gMSkgfSwKICAgICAgeyBsYWJlbDogJ01vdmUgZG93bicsIGljb246ICdkb3duJywga2V5OiAnZG93bicsIGRpc2FibGVkOiBhdCA8IDAgfHwgYXQgPj0gbGlzdC5sZW5ndGggLSAxLCBvblNlbGVjdDogKCkgPT4gbW92ZVRocmVhZChpZCwgY29sSWQsIGNvbElkLCBhdCArIDEpIH0sCiAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgIHsgaGVhZGluZzogJ01vdmUgdG8nIH0sCiAgICAgIC4uLlMuY29sdW1ucy5tYXAoYyA9PiAoewogICAgICAgIGxhYmVsOiBjLnRpdGxlLAogICAgICAgIGNoZWNrZWQ6IGMuaWQgPT09IGNvbElkLAogICAgICAgIGRpc2FibGVkOiBjLmlkID09PSBjb2xJZCwKICAgICAgICBrZXk6IGBtb3ZlOiR7Yy5pZH1gLAogICAgICAgIG9uU2VsZWN0OiAoKSA9PiBtb3ZlVGhyZWFkKGlkLCBjb2xJZCwgYy5pZCwgMCksCiAgICAgIH0pKSwKICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgeyBsYWJlbDogJ1JlbW92ZSBmcm9tIGJvYXJkJywgaWNvbjogJ3JlbW92ZScsIGRhbmdlcjogdHJ1ZSwga2V5OiAncmVtb3ZlJywgb25TZWxlY3Q6ICgpID0-IHJlbW92ZVRocmVhZChpZCkgfSwKICAgIF0sIHsgbGFiZWw6IGBBY3Rpb25zIGZvciAke2NhcmRUaXRs",
"ZShpZCl9YCB9KTsKICB9CgogIC8vIE9wdGltaXN0aWM6IHRoZSBjYXJkIG1vdmVzIG5vdywgYW5kIG9ubHkgdGhpcyBjYXJkIG1vdmVzIGJhY2sgaWYKICAvLyBHbWFpbCByZWZ1c2VzIC0gb3RoZXIgbW92ZXMgbWFkZSBpbiB0aGUgbWVhbnRpbWUgYXJlIGxlZnQgYWxvbmUuCiAgYXN5bmMgZnVuY3Rpb24gbW92ZVRocmVhZChpZCwgZnJvbUNvbCwgdG9Db2wsIGluZGV4KSB7CiAgICBjb25zdCBmcm9tID0gUy5saXN0c1tmcm9tQ29sXSB8fCBbXTsKICAgIGNvbnN0IG9yaWdpbmFsSW5kZXggPSBmcm9tLmluZGV4T2YoaWQpOwoKICAgIGlmIChmcm9tQ29sID09PSB0b0NvbCkgewogICAgICBTLmxpc3RzW3RvQ29sXSA9IGxvZ2ljLnBsYWNlSWQoZnJvbSwgaWQsIGluZGV4KTsKICAgICAgcGVyc2lzdE9yZGVyKCk7CiAgICAgIHJlbmRlcigpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3QgdGFyZ2V0ID0gUy5jb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSB0b0NvbCk7CiAgICBTLmxpc3RzW2Zyb21Db2xdID0gZnJvbS5maWx0ZXIoeCA9PiB4ICE9PSBpZCk7CiAgICBTLmxpc3RzW3RvQ29sXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1t0b0NvbF0sIGlkLCBpbmRleCk7CiAgICBwZXJzaXN0T3JkZXIoKTsKICAgIHJlbmRlcigpOwogICAgYW5ub3VuY2UoYE1vdmVkIHRvICR7dGFyZ2V0LnRpdGxlfSR7dGFyZ2V0LmFyY2hpdmVPbkRyb3AgPyAnIGFuZCBhcmNoaXZlZCcgOiAnJ30uYCk7CgogICAgdHJ5IHsKICAg",
"ICAgYXdhaXQgc3RvcmUubW92ZVRvQ29sdW1uKGlkLCBTLmNvbHVtbnMsIHRvQ29sLCAnYm9hcmQnKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW3RvQ29sXSA9IChTLmxpc3RzW3RvQ29sXSB8fCBbXSkuZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgICBpZiAoUy5saXN0c1tmcm9tQ29sXSkgUy5saXN0c1tmcm9tQ29sXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1tmcm9tQ29sXSwgaWQsIE1hdGgubWF4KDAsIG9yaWdpbmFsSW5kZXgpKTsKICAgICAgcGVyc2lzdE9yZGVyKCk7CiAgICAgIHJlbmRlcigpOwogICAgICBmYWlsVG9hc3QoJ21vdmUnLCBpZCwgZXJyKTsKICAgIH0KICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJlbW92ZVRocmVhZChpZCkgewogICAgY29uc3QgY29sID0gY29sdW1uT2YoaWQpOwogICAgaWYgKCFjb2wpIHJldHVybjsKICAgIGNvbnN0IG9yaWdpbmFsSW5kZXggPSBTLmxpc3RzW2NvbC5pZF0uaW5kZXhPZihpZCk7CiAgICBTLmxpc3RzW2NvbC5pZF0gPSBTLmxpc3RzW2NvbC5pZF0uZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgcGVyc2lzdE9yZGVyKCk7CiAgICByZW5kZXIoKTsKICAgIGFubm91bmNlKCdSZW1vdmVkIGZyb20gdGhlIGJvYXJkLicpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUucmVtb3ZlRnJvbUJvYXJkKGlkLCBTLmNvbHVtbnMsICdib2FyZCcsIFMuYWNjb3VudCk7CiAgICAgIFMuZWRpdHMuZGVsZXRlKGlkKTsKICAgIH0gY2F0Y2ggKGVycikgewog",
"ICAgICBTLmxpc3RzW2NvbC5pZF0gPSBsb2dpYy5wbGFjZUlkKFMubGlzdHNbY29sLmlkXSwgaWQsIG9yaWdpbmFsSW5kZXgpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKICAgICAgcmVuZGVyKCk7CiAgICAgIGZhaWxUb2FzdCgncmVtb3ZlJywgaWQsIGVycik7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBmYWlsVG9hc3QodmVyYiwgaWQsIGVycikgewogICAgY29uc3Qgb3B0cyA9IHsga2luZDogJ2Vycm9yJyB9OwogICAgaWYgKGVyci5jb2RlID09PSAnYXV0aF9yZXF1aXJlZCcpIG9wdHMuYWN0aW9uID0geyBsYWJlbDogJ0Nvbm5lY3QnLCBvbkNsaWNrOiAoKSA9PiBjb25uZWN0KCkgfTsKICAgIHRvYXN0KHJvb3QsIGBDb3VsZG7igJl0ICR7dmVyYn0g4oCcJHtzdG9yZS50aHJlYWQoaWQpID8gY2FyZFRpdGxlKGlkKSA6ICd0aGF0IHRocmVhZCd94oCdOiAke2Vyci5tZXNzYWdlfWAsIG9wdHMpOwogIH0KCiAgLy8g4pSA4pSAIERyYWcgYW5kIGRyb3Ag4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG9uRHJhZ1N0YXJ0KGUsIGlkLCBjb2xJZCwgY2FyZCkgewogICAgY2xvc2VNZW51KHJvb3QpOwogICAgY29uc3QgcGxhY2Vob2xkZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAn",
"cGxhY2Vob2xkZXInLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSk7CiAgICBwbGFjZWhvbGRlci5zdHlsZS5oZWlnaHQgPSBgJHtjYXJkLm9mZnNldEhlaWdodH1weGA7CiAgICBTLmRyYWcgPSB7IGlkLCBmcm9tQ29sOiBjb2xJZCwgY2FyZCwgcGxhY2Vob2xkZXIgfTsKICAgIGUuZGF0YVRyYW5zZmVyLmVmZmVjdEFsbG93ZWQgPSAnbW92ZSc7CiAgICAvLyBBIHByaXZhdGUgdHlwZSwgc28gZHJvcHBpbmcgYSBjYXJkIG9uIEdtYWlsJ3MgY29tcG9zZSBib3ggZG9lcyBub3QKICAgIC8vIHBhc3RlIGEgdGhyZWFkIGlkIGludG8gYW4gZW1haWwuCiAgICBlLmRhdGFUcmFuc2Zlci5zZXREYXRhKERSQUdfVFlQRSwgaWQpOwogICAgY2FyZC5jbGFzc0xpc3QuYWRkKCdsaWZ0aW5nJyk7CiAgICAvLyBIaWRlIHRoZSBjYXJkIG9ubHkgYWZ0ZXIgdGhlIGJyb3dzZXIgaGFzIGNhcHR1cmVkIGl0IGFzIHRoZSBkcmFnCiAgICAvLyBpbWFnZTsgaGlkaW5nIGl0IHN5bmNocm9ub3VzbHkgY2FuY2VscyB0aGUgZHJhZyBpbiBDaHJvbWUuCiAgICBzZXRUaW1lb3V0KCgpID0-IHsKICAgICAgaWYgKCFTLmRyYWcgfHwgUy5kcmFnLmNhcmQgIT09IGNhcmQpIHJldHVybjsKICAgICAgY2FyZC5wYXJlbnROb2RlLmluc2VydEJlZm9yZShwbGFjZWhvbGRlciwgY2FyZCk7CiAgICAgIGNhcmQuY2xhc3NMaXN0LmFkZCgnZHJhZ2dpbmcnKTsKICAgIH0sIDApOwogIH0KCiAgZnVuY3Rpb24gZHJvcEluZGV4KGxpc3QsIHkpIHsKICAgIGNvbnN0",
"IGNhcmRzID0gWy4uLmxpc3QucXVlcnlTZWxlY3RvckFsbCgnOnNjb3BlID4gLmNhcmQ6bm90KC5kcmFnZ2luZyknKV07CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNhcmRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGNvbnN0IHIgPSBjYXJkc1tpXS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgaWYgKHkgPCByLnRvcCArIHIuaGVpZ2h0IC8gMikgcmV0dXJuIGk7CiAgICB9CiAgICByZXR1cm4gY2FyZHMubGVuZ3RoOwogIH0KCiAgZnVuY3Rpb24gb25EcmFnT3ZlcihlKSB7CiAgICBpZiAoIVMuZHJhZykgcmV0dXJuOwogICAgY29uc3Qgc2VjdGlvbiA9IGUudGFyZ2V0LmNsb3Nlc3QgJiYgZS50YXJnZXQuY2xvc2VzdCgnLmNvbHVtbicpOwogICAgY29uc3QgcGggPSBTLmRyYWcucGxhY2Vob2xkZXI7CiAgICBpZiAoIXNlY3Rpb24pIHsKICAgICAgcGgucmVtb3ZlKCk7CiAgICAgIG1hcmtUYXJnZXQobnVsbCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGUuZGF0YVRyYW5zZmVyLmRyb3BFZmZlY3QgPSAnbW92ZSc7CiAgICBjb25zdCBsaXN0ID0gc2VjdGlvbi5xdWVyeVNlbGVjdG9yKCcubGlzdCcpOwogICAgY29uc3QgaWR4ID0gZHJvcEluZGV4KGxpc3QsIGUuY2xpZW50WSk7CiAgICBjb25zdCBjYXJkcyA9IFsuLi5saXN0LnF1ZXJ5U2VsZWN0b3JBbGwoJzpzY29wZSA-IC5jYXJkOm5vdCguZHJhZ2dpbmcpJyldOwogICAgY29uc3QgcmVmID0gY2FyZHNbaWR4XSB8",
"fCBudWxsOwogICAgaWYgKHJlZikgewogICAgICBpZiAocmVmLnByZXZpb3VzRWxlbWVudFNpYmxpbmcgIT09IHBoKSBsaXN0Lmluc2VydEJlZm9yZShwaCwgcmVmKTsKICAgIH0gZWxzZSBpZiAobGlzdC5sYXN0RWxlbWVudENoaWxkICE9PSBwaCkgewogICAgICBsaXN0LmFwcGVuZENoaWxkKHBoKTsKICAgIH0KICAgIG1hcmtUYXJnZXQoc2VjdGlvbik7CiAgfQoKICBmdW5jdGlvbiBvbkRyb3AoZSkgewogICAgaWYgKCFTLmRyYWcpIHJldHVybjsKICAgIGNvbnN0IHNlY3Rpb24gPSBlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0LmNsb3Nlc3QoJy5jb2x1bW4nKTsKICAgIGlmICghc2VjdGlvbikgcmV0dXJuOwogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgY29uc3QgaWR4ID0gZHJvcEluZGV4KHNlY3Rpb24ucXVlcnlTZWxlY3RvcignLmxpc3QnKSwgZS5jbGllbnRZKTsKICAgIGNvbnN0IHsgaWQsIGZyb21Db2wgfSA9IFMuZHJhZzsKICAgIGVuZERyYWcoZmFsc2UpOwogICAgbW92ZVRocmVhZChpZCwgZnJvbUNvbCwgc2VjdGlvbi5kYXRhc2V0LmNvbCwgaWR4KTsKICB9CgogIGZ1bmN0aW9uIG9uRHJhZ0VuZCgpIHsKICAgIGlmIChTLmRyYWcpIGVuZERyYWcodHJ1ZSk7CiAgfQoKICBmdW5jdGlvbiBlbmREcmFnKGNhbmNlbGxlZCkgewogICAgY29uc3QgZCA9IFMuZHJhZzsKICAgIFMuZHJhZyA9IG51bGw7CiAgICBkLnBsYWNlaG9sZGVyLnJlbW92ZSgpOwogICAgZC5jYXJkLmNsYXNzTGlzdC5yZW1vdmUo",
"J2RyYWdnaW5nJywgJ2xpZnRpbmcnKTsKICAgIG1hcmtUYXJnZXQobnVsbCk7CiAgICBpZiAoY2FuY2VsbGVkIHx8IFMucmVuZGVyRGVmZXJyZWQpIHsKICAgICAgUy5yZW5kZXJEZWZlcnJlZCA9IGZhbHNlOwogICAgICByZW5kZXIoKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIG1hcmtUYXJnZXQoc2VjdGlvbikgewogICAgZm9yIChjb25zdCBzIG9mIGVscy5ib2R5LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2x1bW4uZHJvcC10YXJnZXQnKSkgewogICAgICBpZiAocyAhPT0gc2VjdGlvbikgcy5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wLXRhcmdldCcpOwogICAgfQogICAgaWYgKHNlY3Rpb24pIHNlY3Rpb24uY2xhc3NMaXN0LmFkZCgnZHJvcC10YXJnZXQnKTsKICB9CgogIC8vIOKUgOKUgCBDb2x1bW4gc2VhcmNoICgiKyIpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBsZXQgc2VhcmNoVGltZXIgPSAwOwoKICBmdW5jdGlvbiB0b2dnbGVTZWFyY2goY29sSWQpIHsKICAgIGlmIChTLnNlYXJjaCAmJiBTLnNlYXJjaC5jb2xJZCA9PT0gY29sSWQpIHsKICAgICAgY2xvc2VTZWFyY2goKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgUy5zZWFyY2ggPSB7IGNvbElkLCBxdWVyeTogJycsIGlkczogbnVsbCwgbG9hZGluZzog",
"ZmFsc2UsIGVycm9yOiAnJywgc2VxOiAwIH07CiAgICByZW5kZXIoKTsKICAgIGNvbnN0IGlucHV0ID0gZWxzLmJvZHkucXVlcnlTZWxlY3RvcignLnNlYXJjaCBpbnB1dCcpOwogICAgaWYgKGlucHV0KSBpbnB1dC5mb2N1cygpOwogICAgcnVuU2VhcmNoKCk7CiAgfQoKICBmdW5jdGlvbiBjbG9zZVNlYXJjaCgpIHsKICAgIGlmICghUy5zZWFyY2gpIHJldHVybjsKICAgIGNvbnN0IGNvbElkID0gUy5zZWFyY2guY29sSWQ7CiAgICBTLnNlYXJjaCA9IG51bGw7CiAgICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgcmVuZGVyKCk7CiAgICByZXN0b3JlRm9jdXMoYGFkZDoke2NvbElkfWAsIGVscy5ib2R5KTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclNlYXJjaChjb2wpIHsKICAgIGNvbnN0IHMgPSBTLnNlYXJjaDsKICAgIGNvbnN0IGlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIHR5cGU6ICdzZWFyY2gnLAogICAgICBwbGFjZWhvbGRlcjogJ1NlYXJjaCBtYWlsLCBlLmcuIGZyb206YW5uYSBpczp1bnJlYWQnLAogICAgICAnYXJpYS1sYWJlbCc6IGBTZWFyY2ggR21haWwgZm9yIGEgdGhyZWFkIHRvIGFkZCB0byAke2NvbC50aXRsZX1gLAogICAgICB2YWx1ZTogcy5xdWVyeSwKICAgICAgZGF0YXNldDogeyBrZXk6IGBzZWFyY2g6JHtjb2wuaWR9YCB9LAogICAgICBvbmlucHV0OiBlID0-IHsKICAgICAgICBzLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7CiAgICAgICAgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVy",
"KTsKICAgICAgICBzZWFyY2hUaW1lciA9IHNldFRpbWVvdXQocnVuU2VhcmNoLCA0NTApOwogICAgICB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGNsZWFyVGltZW91dChzZWFyY2hUaW1lcik7IHJ1blNlYXJjaCgpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNsb3NlU2VhcmNoKCk7IH0KICAgICAgfSwKICAgIH0pOwogICAgZWxzLnJlc3VsdHMgPSBoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cycsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiAnU2VhcmNoIHJlc3VsdHMnLCAnYXJpYS1idXN5JzogU3RyaW5nKHMubG9hZGluZykgfSk7CiAgICBmaWxsUmVzdWx0cyh0cnVlKTsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoJywgcm9sZTogJ3NlYXJjaCcgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3NlYXJjaC1ib3gnIH0sIGljb24oJ3NlYXJjaCcsIDE4KSwgaW5wdXQpLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoLWhpbnQnLCB0ZXh0OiAnR21haWwgc2VhcmNoIHN5bnRheC4gTGVhdmUgaXQgZW1wdHkgdG8gbGlzdCB5b3VyIEluYm94LicgfSksCiAgICAgIGVscy5yZXN1bHRzKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJ1blNlYXJjaCgpIHsKICAgIGNvbnN0IHMgPSBTLnNlYXJj",
"aDsKICAgIGlmICghcykgcmV0dXJuOwogICAgY29uc3Qgc2VxID0gKytzLnNlcTsKICAgIHMubG9hZGluZyA9IHRydWU7CiAgICBmaWxsUmVzdWx0cygpOwogICAgdHJ5IHsKICAgICAgY29uc3QgaWRzID0gYXdhaXQgc3RvcmUuc2VhcmNoKHMucXVlcnksIFMuYWNjb3VudCk7CiAgICAgIGlmIChTLnNlYXJjaCAhPT0gcyB8fCBzZXEgIT09IHMuc2VxKSByZXR1cm47CiAgICAgIHMuaWRzID0gaWRzOwogICAgICBzLmVycm9yID0gJyc7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKFMuc2VhcmNoICE9PSBzIHx8IHNlcSAhPT0gcy5zZXEpIHJldHVybjsKICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSB7CiAgICAgICAgaGFuZGxlRXJyb3IoZXJyKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgcy5pZHMgPSBbXTsKICAgICAgcy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgfQogICAgcy5sb2FkaW5nID0gZmFsc2U7CiAgICBmaWxsUmVzdWx0cygpOwogIH0KCiAgLy8gYGJ1aWxkaW5nYCBpcyB0cnVlIHdoaWxlIHRoZSBwYW5lbCBpcyBiZWluZyBjcmVhdGVkIGFuZCBpcyBub3QgeWV0IGluCiAgLy8gdGhlIGRvY3VtZW50OyBvdGhlcndpc2UgYSBkZXRhY2hlZCBib3ggbWVhbnMgYW4gYXN5bmMgc2VhcmNoIGZpbmlzaGVkCiAgLy8gYWZ0ZXIgaXRzIHBhbmVsIHdhcyBjbG9zZWQsIGFuZCB0aGVyZSBpcyBub3RoaW5nIHRvIGZpbGwuCiAgZnVuY3Rp",
"b24gZmlsbFJlc3VsdHMoYnVpbGRpbmcgPSBmYWxzZSkgewogICAgY29uc3QgcyA9IFMuc2VhcmNoOwogICAgY29uc3QgYm94ID0gZWxzLnJlc3VsdHM7CiAgICBpZiAoIXMgfHwgIWJveCB8fCAoIWJ1aWxkaW5nICYmICFib3guaXNDb25uZWN0ZWQpKSByZXR1cm47CiAgICBib3guc2V0QXR0cmlidXRlKCdhcmlhLWJ1c3knLCBTdHJpbmcocy5sb2FkaW5nKSk7CgogICAgaWYgKHMuaWRzID09PSBudWxsIHx8IChzLmxvYWRpbmcgJiYgIXMuaWRzLmxlbmd0aCkpIHsKICAgICAgYm94LnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cy1lbXB0eScsIHRleHQ6ICdTZWFyY2hpbmfigKYnIH0pKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKHMuZXJyb3IpIHsKICAgICAgYm94LnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cy1lbXB0eScsIHRleHQ6IGBTZWFyY2ggZmFpbGVkOiAke3MuZXJyb3J9YCB9KSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmICghcy5pZHMubGVuZ3RoKSB7CiAgICAgIGJveC5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ3Jlc3VsdHMtZW1wdHknLCB0ZXh0OiAnTm8gdGhyZWFkcyBtYXRjaC4nIH0pKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGNvbnN0IHRhcmdldCA9IFMuY29sdW1ucy5maW5kKGMgPT4gYy5pZCA9PT0gcy5jb2xJZCk7CiAgICBib3gucmVwbGFjZUNoaWxkcmVuKC4uLnMuaWRzLm1hcChpZCA9PiB7",
"CiAgICAgIGNvbnN0IHQgPSBzdG9yZS50aHJlYWQoaWQpOwogICAgICBjb25zdCB3aGVyZSA9IGNvbHVtbk9mKGlkKTsKICAgICAgY29uc3QgaGVyZSA9IHdoZXJlICYmIHdoZXJlLmlkID09PSBzLmNvbElkOwogICAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAncmVzdWx0JywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICdsaXN0aXRlbScsIGRpc2FibGVkOiBoZXJlLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgcmVzdWx0OiR7aWR9YCwgaWQgfSwKICAgICAgICB0aXRsZTogaGVyZSA_ICcnIDogYEFkZCB0byAke3RhcmdldCA_IHRhcmdldC50aXRsZSA6ICd0aGlzIGNvbHVtbid9YCwKICAgICAgICBvbmNsaWNrOiAoKSA9PiBhZGRGcm9tU2VhcmNoKGlkLCBzLmNvbElkKSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3ItdG9wJyB9LAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmcm9tJywgdGV4dDogdC5mcm9tIH0pLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkYXRlJywgdGV4dDogdXRpbC5yZWxhdGl2ZURhdGUodC50cykgfSkpLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnci1zdWJqZWN0JywgdGV4dDogbG9naWMuZGlzcGxheVRpdGxlKHQsIFMuZWRpdHMuZ2V0KGlkKSkgfSksCiAgICAgICAgd2hlcmUgPyBoKCdzcGFuJywgeyBjbGFzczogJ3Itd2hlcmUnLCB0ZXh0",
"OiBoZXJlID8gJ0FscmVhZHkgaW4gdGhpcyBjb2x1bW4nIDogYEluICR7d2hlcmUudGl0bGV9IMK3IG1vdmVzIGhlcmVgIH0pIDogbnVsbCk7CiAgICB9KSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBhZGRGcm9tU2VhcmNoKGlkLCBjb2xJZCkgewogICAgY29uc3Qgd2hlcmUgPSBjb2x1bW5PZihpZCk7CiAgICBpZiAod2hlcmUgJiYgd2hlcmUuaWQgPT09IGNvbElkKSByZXR1cm47CiAgICBpZiAod2hlcmUpIHsKICAgICAgbW92ZVRocmVhZChpZCwgd2hlcmUuaWQsIGNvbElkLCAwKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgdGFyZ2V0ID0gUy5jb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSBjb2xJZCk7CiAgICBTLmxpc3RzW2NvbElkXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1tjb2xJZF0sIGlkLCAwKTsKICAgIHBlcnNpc3RPcmRlcigpOwogICAgcmVuZGVyKCk7CiAgICBhbm5vdW5jZShgQWRkZWQgdG8gJHt0YXJnZXQudGl0bGV9LmApOwogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUubW92ZVRvQ29sdW1uKGlkLCBTLmNvbHVtbnMsIGNvbElkLCAnYm9hcmQnKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW2NvbElkXSA9IChTLmxpc3RzW2NvbElkXSB8fCBbXSkuZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKICAgICAgcmVuZGVyKCk7CiAgICAgIGZhaWxUb2FzdCgnYWRkJywgaWQsIGVycik7CiAgICB9CiAgfQoKICAvLyDilIDilIAgQ29sdW1u",
"IHNldHRpbmdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBvcGVuRHJhd2VyKCkgewogICAgaWYgKFMuc3RhdHVzICE9PSAncmVhZHknKSByZXR1cm47CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBTLmRyYXdlciA9IHsKICAgICAgZHJhZnQ6IFMuY29sdW1ucy5tYXAoYyA9PiAoeyAuLi5jLCBvcmlnTGFiZWw6IGMubGFiZWwsIGlzTmV3OiBmYWxzZSwgbGFiZWxUb3VjaGVkOiB0cnVlIH0pKSwKICAgICAgZXJyb3I6ICcnLAogICAgICBzYXZpbmc6IGZhbHNlLAogICAgfTsKICAgIHJlbmRlckRyYXdlcigndGl0bGU6MCcpOwogIH0KCiAgZnVuY3Rpb24gY2xvc2VEcmF3ZXIoKSB7CiAgICBpZiAoIVMuZHJhd2VyKSByZXR1cm47CiAgICBTLmRyYXdlciA9IG51bGw7CiAgICByZW5kZXJEcmF3ZXIoKTsKICAgIGlmIChTLm9wZW4pIGVscy5zZXR0aW5ncy5mb2N1cygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRHJhd2VyKGZvY3VzKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXI7CiAgICBpZiAoIWQpIHsKICAgICAgZWxzLmRyYXdlckxheWVyLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBrZXkgPSBmb2N1cyB8fCBmb2N1c0tleSgpOwoK",
"ICAgIGNvbnN0IGRyYXdlciA9IGgoJ2FzaWRlJywgewogICAgICBjbGFzczogJ2RyYXdlcicsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1tb2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6ICdna2ItZHJhd2VyLXRpdGxlJywKICAgIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkcmF3ZXItaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItZHJhd2VyLXRpdGxlJywgdGV4dDogJ0NvbHVtbnMnIH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQ2xvc2UgY29sdW1uIHNldHRpbmdzJywgb25jbGljazogY2xvc2VEcmF3ZXIsCiAgICAgICAgfSwgaWNvbignY2xvc2UnKSkpLAogICAgICBoKCdwJywgewogICAgICAgIGNsYXNzOiAnZHJhd2VyLWludHJvJywKICAgICAgICB0ZXh0OiAnRWFjaCBjb2x1bW4gaXMgYSBHbWFpbCBsYWJlbC4gUmVuYW1pbmcgYSBsYWJlbCBoZXJlIHJlbmFtZXMgaXQgaW4gR21haWwsIHNvIHRoZSBtYWlsIGZpbGVkIHVuZGVyIGl0IHN0YXlzIHB1dC4nLAogICAgICB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RyYXdlci1ib2R5JyB9LAogICAgICAgIGQuZHJhZnQubWFwKChjLCBpKSA9PiByZW5kZXJEcmFmdFJvdyhjLCBpKSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdhZGQtY29sJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6",
"IHsga2V5OiAnYWRkLWNvbCcgfSwgb25jbGljazogYWRkRHJhZnRDb2x1bW4sCiAgICAgICAgfSwgJysgQWRkIGNvbHVtbicpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2Zvcm0tZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBkLmVycm9yIH0pLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZHJhd2VyLWZvb3QnIH0sCiAgICAgICAgaCgnc3BhbicsIHsKICAgICAgICAgIGNsYXNzOiAnbm90ZScsCiAgICAgICAgICB0ZXh0OiAnUmVtb3ZpbmcgYSBjb2x1bW4gb25seSB0YWtlcyBpdCBvZmYgdGhlIGJvYXJkLiBJdHMgR21haWwgbGFiZWwsIGFuZCB0aGUgbWFpbCBpbiBpdCwgYXJlIGxlZnQgdW50b3VjaGVkLicsCiAgICAgICAgfSksCiAgICAgICAgaCgnYnV0dG9uJywgeyBjbGFzczogJ2J0biBidG4tdGV4dCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQ2FuY2VsJywgb25jbGljazogY2xvc2VEcmF3ZXIgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdidG4gYnRuLXByaW1hcnknLCB0eXBlOiAnYnV0dG9uJywgZGlzYWJsZWQ6IGQuc2F2aW5nLCBkYXRhc2V0OiB7IGtleTogJ3NhdmUnIH0sCiAgICAgICAgICB0ZXh0OiBkLnNhdmluZyA_ICdTYXZpbmfigKYnIDogJ1NhdmUnLCBvbmNsaWNrOiBzYXZlRHJhd2VyLAogICAgICAgIH0pKSk7CgogICAgZWxzLmRyYXdlckxheWVyLnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAnc2NyaW0nLCBvbmNsaWNrOiBjbG9z",
"ZURyYXdlciB9KSwgZHJhd2VyKTsKICAgIHJlc3RvcmVGb2N1cyhrZXksIGVscy5kcmF3ZXJMYXllcik7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJEcmFmdFJvdyhjLCBpKSB7CiAgICBjb25zdCBuID0gUy5kcmF3ZXIuZHJhZnQubGVuZ3RoOwogICAgY29uc3Qgcm93VGl0bGUgPSBoKCdzcGFuJywgeyBjbGFzczogJ3Jvdy10aXRsZScsIHRleHQ6IGMudGl0bGUgfHwgJ05ldyBjb2x1bW4nIH0pOwogICAgY29uc3QgaGVscCA9IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtaGVscCcgfSk7CiAgICBjb25zdCBzZXRIZWxwID0gKCkgPT4gewogICAgICBoZWxwLnRleHRDb250ZW50ID0gYy5pc05ldwogICAgICAgID8gJ0NyZWF0ZWQgaW4gR21haWwgd2hlbiB5b3Ugc2F2ZS4nCiAgICAgICAgOiBjLmxhYmVsLnRyaW0oKSAhPT0gYy5vcmlnTGFiZWwgPyBgUmVuYW1lcyDigJwke2Mub3JpZ0xhYmVsfeKAnSBpbiBHbWFpbCB3aGVuIHlvdSBzYXZlLmAgOiAnJzsKICAgIH07CiAgICBzZXRIZWxwKCk7CgogICAgY29uc3QgbGFiZWxJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHZhbHVlOiBjLmxhYmVsLCBzcGVsbGNoZWNrOiAnZmFsc2UnLAogICAgICBkYXRhc2V0OiB7IGtleTogYGxhYmVsOiR7aX1gIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBjLmxhYmVsID0gZS50YXJnZXQudmFsdWU7IGMubGFiZWxUb3VjaGVkID0gdHJ1ZTsgc2V0SGVscCgpOyB9LAogICAg",
"fSk7CiAgICBjb25zdCB0aXRsZUlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGMudGl0bGUsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgdGl0bGU6JHtpfWAgfSwKICAgICAgb25pbnB1dDogZSA9PiB7CiAgICAgICAgYy50aXRsZSA9IGUudGFyZ2V0LnZhbHVlOwogICAgICAgIHJvd1RpdGxlLnRleHRDb250ZW50ID0gYy50aXRsZSB8fCAnTmV3IGNvbHVtbic7CiAgICAgICAgLy8gQSBuZXcgY29sdW1uJ3MgbGFiZWwgZm9sbG93cyBpdHMgdGl0bGUgdW50aWwgZWRpdGVkIGJ5IGhhbmQuCiAgICAgICAgaWYgKGMuaXNOZXcgJiYgIWMubGFiZWxUb3VjaGVkKSB7CiAgICAgICAgICBjLmxhYmVsID0gYCR7Yy5yb290fS8ke2MudGl0bGUudHJpbSgpfWA7CiAgICAgICAgICBsYWJlbElucHV0LnZhbHVlID0gYy5sYWJlbDsKICAgICAgICB9CiAgICAgIH0sCiAgICB9KTsKCiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NvbC1yb3cnLCBkYXRhc2V0OiB7IHJvdzogU3RyaW5nKGkpIH0gfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3Jvdy1oZWFkJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncm93LW51bScsIHRleHQ6IFN0cmluZyhpICsgMSkgfSksCiAgICAgICAgcm93VGl0bGUsCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6IGBN",
"b3ZlICR7Yy50aXRsZSB8fCAnY29sdW1uJ30gdXBgLCB0aXRsZTogJ01vdmUgdXAgKGZ1cnRoZXIgbGVmdCBvbiB0aGUgYm9hcmQpJywKICAgICAgICAgIGRpc2FibGVkOiBpID09PSAwLCBkYXRhc2V0OiB7IGtleTogYHVwOiR7aX1gIH0sIG9uY2xpY2s6ICgpID0-IG1vdmVEcmFmdChpLCAtMSksCiAgICAgICAgfSwgaWNvbigndXAnLCAxOCkpLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiBgTW92ZSAke2MudGl0bGUgfHwgJ2NvbHVtbid9IGRvd25gLCB0aXRsZTogJ01vdmUgZG93biAoZnVydGhlciByaWdodCBvbiB0aGUgYm9hcmQpJywKICAgICAgICAgIGRpc2FibGVkOiBpID09PSBuIC0gMSwgZGF0YXNldDogeyBrZXk6IGBkb3duOiR7aX1gIH0sIG9uY2xpY2s6ICgpID0-IG1vdmVEcmFmdChpLCAxKSwKICAgICAgICB9LCBpY29uKCdkb3duJywgMTgpKSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogYFJlbW92ZSAke2MudGl0bGUgfHwgJ2NvbHVtbid9IGZyb20gdGhlIGJvYXJkYCwKICAgICAgICAgIHRpdGxlOiAnUmVtb3ZlIGZyb20gYm9hcmQgKGtlZXBzIHRoZSBHbWFpbCBsYWJlbCknLCBkYXRhc2V0OiB7IGtleTogYHJlbW92ZToke2l9YCB9LAogICAgICAgICAgb25jbGljazogKCkgPT4gcmVtb3ZlRHJhZnQo",
"aSksCiAgICAgICAgfSwgaWNvbignY2xvc2UnLCAxOCkpKSwKICAgICAgaCgnbGFiZWwnLCB7IGNsYXNzOiAnZmllbGQnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmaWVsZC1sYWJlbCcsIHRleHQ6ICdUaXRsZScgfSksCiAgICAgICAgdGl0bGVJbnB1dCksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCB0ZXh0OiAnR21haWwgbGFiZWwnIH0pLAogICAgICAgIGxhYmVsSW5wdXQsCiAgICAgICAgaGVscCksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2NoZWNrJyB9LAogICAgICAgIGgoJ2lucHV0JywgewogICAgICAgICAgdHlwZTogJ2NoZWNrYm94JywgY2hlY2tlZDogISFjLmFyY2hpdmVPbkRyb3AsIGRhdGFzZXQ6IHsga2V5OiBgYXJjaGl2ZToke2l9YCB9LAogICAgICAgICAgb25jaGFuZ2U6IGUgPT4geyBjLmFyY2hpdmVPbkRyb3AgPSBlLnRhcmdldC5jaGVja2VkOyB9LAogICAgICAgIH0pLAogICAgICAgICdBcmNoaXZlIHRocmVhZHMgbW92ZWQgaGVyZSAodGFrZSB0aGVtIG91dCBvZiB0aGUgSW5ib3gpJykpOwogIH0KCiAgZnVuY3Rpb24gbW92ZURyYWZ0KGksIGRlbHRhKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXIuZHJhZnQ7CiAgICBjb25zdCBqID0gaSArIGRlbHRhOwogICAgaWYgKGogPCAwIHx8IGogPj0gZC5sZW5ndGgpIHJldHVybjsKICAgIFtkW2ldLCBkW2pdXSA9IFtkW2pdLCBkW2ld",
"XTsKICAgIC8vIEtlZXAgZm9jdXMgb24gdGhlIHNhbWUgYXJyb3csIG5vdyBvbiB0aGUgcm93J3MgbmV3IHBvc2l0aW9uLCBzbwogICAgLy8gcmVwZWF0ZWQgcHJlc3NlcyBrZWVwIG1vdmluZyB0aGUgc2FtZSBjb2x1bW4uCiAgICBjb25zdCBrZXkgPSBkZWx0YSA8IDAgPyAoaiA9PT0gMCA_IGBkb3duOiR7an1gIDogYHVwOiR7an1gKSA6IChqID09PSBkLmxlbmd0aCAtIDEgPyBgdXA6JHtqfWAgOiBgZG93bjoke2p9YCk7CiAgICByZW5kZXJEcmF3ZXIoa2V5KTsKICB9CgogIGZ1bmN0aW9uIHJlbW92ZURyYWZ0KGkpIHsKICAgIFMuZHJhd2VyLmRyYWZ0LnNwbGljZShpLCAxKTsKICAgIGNvbnN0IG4gPSBTLmRyYXdlci5kcmFmdC5sZW5ndGg7CiAgICByZW5kZXJEcmF3ZXIobiA_IGB0aXRsZToke01hdGgubWluKGksIG4gLSAxKX1gIDogJ2FkZC1jb2wnKTsKICB9CgogIGZ1bmN0aW9uIGFkZERyYWZ0Q29sdW1uKCkgewogICAgY29uc3QgZCA9IFMuZHJhd2VyLmRyYWZ0OwogICAgLy8gVW5kZXIgd2hhdGV2ZXIgcGFyZW50IHRoZSBjb2x1bW5zIGFscmVhZHkgc2hhcmUgKCJfQm9hcmQiLCBvciBvbmUKICAgIC8vIHRoZSB1c2VyIG1vdmVkIHRoZW0gdG8pLCBub3QgYSBoYXJkLWNvZGVkIG9uZS4KICAgIGNvbnN0IHJvb3QgPSBsb2dpYy5sYWJlbFJvb3QoUy5jb2x1bW5zKTsKICAgIGQucHVzaCh7CiAgICAgIGlkOiBsb2dpYy5uZXdDb2x1bW5JZChkKSwKICAgICAgdGl0bGU6ICdOZXcgY29sdW1uJywKICAgICAgbGFi",
"ZWw6IGAke3Jvb3R9L05ldyBjb2x1bW5gLAogICAgICByb290LAogICAgICBhcmNoaXZlT25Ecm9wOiBmYWxzZSwKICAgICAgb3JpZ0xhYmVsOiAnJywKICAgICAgaXNOZXc6IHRydWUsCiAgICAgIGxhYmVsVG91Y2hlZDogZmFsc2UsCiAgICB9KTsKICAgIHJlbmRlckRyYXdlcihgdGl0bGU6JHtkLmxlbmd0aCAtIDF9YCk7CiAgICBjb25zdCBpbnB1dCA9IFsuLi5lbHMuZHJhd2VyTGF5ZXIucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEta2V5XScpXS5maW5kKHggPT4geC5kYXRhc2V0LmtleSA9PT0gYHRpdGxlOiR7ZC5sZW5ndGggLSAxfWApOwogICAgaWYgKGlucHV0KSBpbnB1dC5zZWxlY3QoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVEcmF3ZXIoKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXI7CiAgICBjb25zdCB0aWR5ID0gcyA9PiBTdHJpbmcocyB8fCAnJykuc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRyaW0oKSkuam9pbignLycpOwogICAgY29uc3QgY29scyA9IGQuZHJhZnQubWFwKGMgPT4gKHsKICAgICAgaWQ6IGMuaWQsCiAgICAgIHRpdGxlOiBTdHJpbmcoYy50aXRsZSB8fCAnJykudHJpbSgpLAogICAgICBsYWJlbDogdGlkeShjLmxhYmVsKSwKICAgICAgYXJjaGl2ZU9uRHJvcDogISFjLmFyY2hpdmVPbkRyb3AsCiAgICB9KSk7CgogICAgY29uc3QgcHJvYmxlbSA9IGxvZ2ljLnZhbGlkYXRlQ29sdW1ucyhjb2xzKTsKICAgIGlmIChwcm9ibGVtKSB7CiAgICAgIGQuZXJyb3IgPSBwcm9ibGVtOwogICAg",
"ICByZW5kZXJEcmF3ZXIoKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGQuc2F2aW5nID0gdHJ1ZTsKICAgIGQuZXJyb3IgPSAnJzsKICAgIHJlbmRlckRyYXdlcignc2F2ZScpOwogICAgY29uc3Qgbm90ZXMgPSBbXTsKCiAgICB0cnkgewogICAgICAvLyBMYWJlbCByZW5hbWVzIGZpcnN0LCBwZXJzaXN0aW5nIGFmdGVyIGVhY2ggb25lLiBJZiBhIGxhdGVyIHN0ZXAKICAgICAgLy8gZmFpbHMsIHRoZSBzYXZlZCBsYXlvdXQgc3RpbGwgbWF0Y2hlcyB3aGF0IEdtYWlsIG5vdyBoYXMsIGluc3RlYWQKICAgICAgLy8gb2YgcG9pbnRpbmcgYXQgYSBsYWJlbCBuYW1lIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cy4KICAgICAgbGV0IHBlcnNpc3RlZCA9IFMuY29sdW1ucy5tYXAoYyA9PiAoeyAuLi5jIH0pKTsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBkLmRyYWZ0Lmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3Qgcm93ID0gZC5kcmFmdFtpXTsKICAgICAgICBjb25zdCBuZXh0ID0gY29sc1tpXTsKICAgICAgICBpZiAocm93LmlzTmV3IHx8ICFyb3cub3JpZ0xhYmVsIHx8IHJvdy5vcmlnTGFiZWwgPT09IG5leHQubGFiZWwpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN0b3JlLnJlbmFtZUxhYmVsKHJvdy5vcmlnTGFiZWwsIG5leHQubGFiZWwpOwogICAgICAgIGlmIChyZXN1bHQgPT09ICdyZXBvaW50ZWQnKSBub3Rlcy5wdXNoKGDigJwke25leHQudGl0bGV94oCdIG5vdyB1c2VzIHRoZSBl",
"eGlzdGluZyBsYWJlbCDigJwke25leHQubGFiZWx94oCdLmApOwogICAgICAgIHBlcnNpc3RlZCA9IHBlcnNpc3RlZC5tYXAoYyA9PiAoYy5pZCA9PT0gbmV4dC5pZCA_IHsgLi4uYywgbGFiZWw6IG5leHQubGFiZWwgfSA6IGMpKTsKICAgICAgICBhd2FpdCBzdG9yZS5zYXZlQ29sdW1ucyhTLmFjY291bnQsIHBlcnNpc3RlZCk7CiAgICAgICAgUy5jb2x1bW5zID0gcGVyc2lzdGVkOwogICAgICB9CgogICAgICBhd2FpdCBzdG9yZS5lbnN1cmVMYWJlbHMoY29scy5tYXAoYyA9PiBjLmxhYmVsKSwgeyBmcmVzaDogdHJ1ZSB9KTsKICAgICAgYXdhaXQgc3RvcmUuc2F2ZUNvbHVtbnMoUy5hY2NvdW50LCBjb2xzKTsKICAgICAgUy5jb2x1bW5zID0gY29sczsKICAgICAgUy5kcmF3ZXIgPSBudWxsOwogICAgICByZW5kZXJEcmF3ZXIoKTsKICAgICAgZWxzLnNldHRpbmdzLmZvY3VzKCk7CiAgICAgIHRvYXN0KHJvb3QsIFsnQ29sdW1ucyBzYXZlZC4nLCAuLi5ub3Rlc10uam9pbignICcpKTsKICAgICAgUy5sb2FkZWRBdCA9IDA7CiAgICAgIGF3YWl0IHJlZnJlc2goKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHsKICAgICAgICBTLmRyYXdlciA9IG51bGw7CiAgICAgICAgcmVuZGVyRHJhd2VyKCk7CiAgICAgICAgaGFuZGxlRXJyb3IoZXJyKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgZC5zYXZpbmcgPSBmYWxz",
"ZTsKICAgICAgZC5lcnJvciA9IGBDb3VsZG7igJl0IHNhdmU6ICR7ZXJyLm1lc3NhZ2V9YDsKICAgICAgcmVuZGVyRHJhd2VyKCk7CiAgICB9CiAgfQoKICAvLyDilIDilIAgQ2FyZCBlZGl0b3Ig4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUaGUgdXNlcidzIG93biB0aXRsZSwgbm90ZSBhbmQgY29sb3VyIGZvciBvbmUgY2FyZC4gTm9uZSBvZiBpdCByZWFjaGVzCiAgLy8gR21haWw6IHRoZSByZWNvcmQgbGl2ZXMgaW4gc3RvcmFnZS5zeW5jLCBhbmQgdGhlIGVtYWlsIC0gaXRzIHN1YmplY3QsCiAgLy8gaXRzIGxhYmVscywgd2hhdCBjb3JyZXNwb25kZW50cyBzZWUgLSBpcyBleGFjdGx5IGFzIGl0IHdhcy4KCiAgY29uc3QgQ09MT1VSX05BTUVTID0gewogICAgcmVkOiAnUmVkJywgb3JhbmdlOiAnT3JhbmdlJywgeWVsbG93OiAnWWVsbG93JywgZ3JlZW46ICdHcmVlbicsCiAgICBibHVlOiAnQmx1ZScsIHB1cnBsZTogJ1B1cnBsZScsIGdyZXk6ICdHcmV5JywKICB9OwoKICBmdW5jdGlvbiBvcGVuRWRpdG9yKGlkKSB7CiAgICBjb25zdCB0ID0gc3RvcmUudGhyZWFkKGlkKTsKICAgIGlmICghdCB8fCBTLnN0YXR1cyAhPT0gJ3JlYWR5JykgcmV0dXJuOwog",
"ICAgY2xvc2VNZW51KHJvb3QpOwogICAgY29uc3QgZWRpdCA9IFMuZWRpdHMuZ2V0KGlkKSB8fCB7fTsKICAgIFMuZWRpdG9yID0gewogICAgICBpZCwKICAgICAgc3ViamVjdDogdC5zdWJqZWN0LAogICAgICAvLyBQcmUtZmlsbGVkIHdpdGggdGhlIHN1YmplY3QgcmF0aGVyIHRoYW4gbGVmdCBibGFuaywgYmVjYXVzZSB0aGUKICAgICAgLy8gdXN1YWwgZWRpdCBpcyB0cmltbWluZyBhIGxvbmcgc3ViamVjdCBkb3duLCBub3Qgc3RhcnRpbmcgYWZyZXNoLgogICAgICBkcmFmdDogeyB0aXRsZTogZWRpdC50aXRsZSB8fCB0LnN1YmplY3QsIG5vdGU6IGVkaXQubm90ZSB8fCAnJywgY29sb3VyOiBlZGl0LmNvbG91ciB8fCAnJyB9LAogICAgICBlcnJvcjogJycsCiAgICAgIHNhdmluZzogZmFsc2UsCiAgICB9OwogICAgcmVuZGVyRWRpdG9yKCdlZGl0LXRpdGxlJyk7CiAgICBjb25zdCBpbnB1dCA9IGVscy5lZGl0b3JMYXllci5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9ImVkaXQtdGl0bGUiXScpOwogICAgaWYgKGlucHV0KSBpbnB1dC5zZWxlY3QoKTsKICB9CgogIGZ1bmN0aW9uIGNsb3NlRWRpdG9yKCkgewogICAgaWYgKCFTLmVkaXRvcikgcmV0dXJuOwogICAgY29uc3QgaWQgPSBTLmVkaXRvci5pZDsKICAgIFMuZWRpdG9yID0gbnVsbDsKICAgIHJlbmRlckVkaXRvcigpOwogICAgaWYgKFMub3BlbikgcmVzdG9yZUZvY3VzKGBtZW51OiR7aWR9YCwgZWxzLmJvZHkpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRWRp",
"dG9yKGZvY3VzKSB7CiAgICBjb25zdCBlZCA9IFMuZWRpdG9yOwogICAgaWYgKCFlZCkgewogICAgICBlbHMuZWRpdG9yTGF5ZXIucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGtleSA9IGZvY3VzIHx8IGZvY3VzS2V5KCk7CiAgICBjb25zdCBkID0gZWQuZHJhZnQ7CgogICAgY29uc3QgcmVzZXQgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnbGluay1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1VzZSB0aGUgZW1haWwgc3ViamVjdCcsIGRhdGFzZXQ6IHsga2V5OiAnZWRpdC1yZXNldCcgfSwKICAgICAgb25jbGljazogKCkgPT4gewogICAgICAgIGQudGl0bGUgPSBlZC5zdWJqZWN0OwogICAgICAgIHRpdGxlSW5wdXQudmFsdWUgPSBlZC5zdWJqZWN0OwogICAgICAgIHN5bmNSZXNldCgpOwogICAgICAgIHRpdGxlSW5wdXQuZm9jdXMoKTsKICAgICAgfSwKICAgIH0pOwogICAgY29uc3Qgc3luY1Jlc2V0ID0gKCkgPT4gewogICAgICBjb25zdCB2ID0gZC50aXRsZS50cmltKCk7CiAgICAgIHJlc2V0LmhpZGRlbiA9ICF2IHx8IHYgPT09IGVkLnN1YmplY3QudHJpbSgpOwogICAgfTsKCiAgICBjb25zdCB0aXRsZUlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGQudGl0bGUsIG1heGxlbmd0aDogU3RyaW5nKGxvZ2ljLk1BWF9USVRMRSksCiAgICAgIHBsYWNlaG9sZGVyOiBlZC5zdWJqZWN0",
"LCAnYXJpYS1kZXNjcmliZWRieSc6ICdna2ItZWRpdC1zdWJqZWN0JywgZGF0YXNldDogeyBrZXk6ICdlZGl0LXRpdGxlJyB9LAogICAgICBvbmlucHV0OiBlID0-IHsgZC50aXRsZSA9IGUudGFyZ2V0LnZhbHVlOyBzeW5jUmVzZXQoKTsgfSwKICAgICAgb25rZXlkb3duOiBlID0-IHsgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFlLmlzQ29tcG9zaW5nKSB7IGUucHJldmVudERlZmF1bHQoKTsgc2F2ZUVkaXRvcigpOyB9IH0sCiAgICB9KTsKICAgIHN5bmNSZXNldCgpOwoKICAgIGNvbnN0IG5vdGVJbnB1dCA9IGgoJ3RleHRhcmVhJywgewogICAgICBjbGFzczogWyd0ZXh0LWlucHV0JywgJ3RleHQtYXJlYSddLCByb3dzOiAnMycsIG1heGxlbmd0aDogU3RyaW5nKGxvZ2ljLk1BWF9OT1RFKSwgdmFsdWU6IGQubm90ZSwKICAgICAgcGxhY2Vob2xkZXI6ICdPcHRpb25hbC4gU2hvd24gb24gdGhlIGNhcmQgaW4gcGxhY2Ugb2YgdGhlIGVtYWlsIHByZXZpZXcuJywKICAgICAgZGF0YXNldDogeyBrZXk6ICdlZGl0LW5vdGUnIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBkLm5vdGUgPSBlLnRhcmdldC52YWx1ZTsgfSwKICAgICAgLy8gRW50ZXIgaXMgYSBuZXcgbGluZSBpbiBhIG5vdGU7IEN0cmwrRW50ZXIgc2F2ZXMsIGFzIGluIEdtYWlsJ3MgY29tcG9zZS4KICAgICAgb25rZXlkb3duOiBlID0-IHsgaWYgKGUua2V5ID09PSAnRW50ZXInICYmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5KSkgeyBlLnByZXZlbnREZWZh",
"dWx0KCk7IHNhdmVFZGl0b3IoKTsgfSB9LAogICAgfSk7CgogICAgY29uc3Qgc3dhdGNoZXMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnc3dhdGNoZXMnLCByb2xlOiAncmFkaW9ncm91cCcsICdhcmlhLWxhYmVsbGVkYnknOiAnZ2tiLWVkaXQtY29sb3VyJyB9LAogICAgICBbJycsIC4uLmxvZ2ljLkNBUkRfQ09MT1VSU10ubWFwKGMgPT4gewogICAgICAgIGNvbnN0IG5hbWUgPSBjID8gQ09MT1VSX05BTUVTW2NdIDogJ05vIGNvbG91cic7CiAgICAgICAgcmV0dXJuIGgoJ2xhYmVsJywgeyBjbGFzczogJ3N3YXRjaCcsIHRpdGxlOiBuYW1lLCBkYXRhc2V0OiB7IGNvbG91cjogYyB8fCAnbm9uZScgfSB9LAogICAgICAgICAgaCgnaW5wdXQnLCB7CiAgICAgICAgICAgIHR5cGU6ICdyYWRpbycsIG5hbWU6ICdna2ItY2FyZC1jb2xvdXInLCB2YWx1ZTogYywgY2hlY2tlZDogZC5jb2xvdXIgPT09IGMsICdhcmlhLWxhYmVsJzogbmFtZSwKICAgICAgICAgICAgZGF0YXNldDogeyBrZXk6IGBlZGl0LWNvbG91cjoke2MgfHwgJ25vbmUnfWAgfSwKICAgICAgICAgICAgb25jaGFuZ2U6ICgpID0-IHsgZC5jb2xvdXIgPSBjOyB9LAogICAgICAgICAgfSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3N3YXRjaC1kb3QnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSkpOwogICAgICB9KSk7CgogICAgY29uc3QgZGlhbG9nID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ2RpYWxvZycsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1t",
"b2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6ICdna2ItZWRpdC1oZWFkaW5nJywKICAgIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2ctaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItZWRpdC1oZWFkaW5nJywgdGV4dDogJ0VkaXQgY2FyZCcgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDbG9zZSB3aXRob3V0IHNhdmluZycsIG9uY2xpY2s6IGNsb3NlRWRpdG9yLAogICAgICAgIH0sIGljb24oJ2Nsb3NlJykpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1ib2R5JyB9LAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWVkaXQtdGl0bGUnLCB0ZXh0OiAnVGl0bGUgb24gdGhlIGJvYXJkJyB9KSwKICAgICAgICAgIE9iamVjdC5hc3NpZ24odGl0bGVJbnB1dCwgeyBpZDogJ2drYi1lZGl0LXRpdGxlJyB9KSwKICAgICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdoZWxwLXJvdycsIGlkOiAnZ2tiLWVkaXQtc3ViamVjdCcgfSwKICAgICAgICAgICAgaCgnc3BhbicsIHt9LCAnRW1haWwgc3ViamVjdDogJywgaCgnc3BhbicsIHsgY2xhc3M6ICdzdWJqZWN0LXJlZicsIHRleHQ6IGVkLnN1YmplY3QgfSkpLAogICAgICAgICAgICByZXNldCkpLAog",
"ICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWVkaXQtbm90ZScsIHRleHQ6ICdOb3RlJyB9KSwKICAgICAgICAgIE9iamVjdC5hc3NpZ24obm90ZUlucHV0LCB7IGlkOiAnZ2tiLWVkaXQtbm90ZScgfSkpLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCBpZDogJ2drYi1lZGl0LWNvbG91cicsIHRleHQ6ICdDb2xvdXInIH0pLAogICAgICAgICAgc3dhdGNoZXMpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2Zvcm0tZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBlZC5lcnJvciB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1mb290JyB9LAogICAgICAgIGgoJ3NwYW4nLCB7CiAgICAgICAgICBjbGFzczogJ25vdGUnLAogICAgICAgICAgdGV4dDogJ09ubHkgdGhlIGJvYXJkIGNoYW5nZXMuIFRoZSBlbWFpbCBpdHNlbGYsIGFuZCB3aGF0IG90aGVycyBzZWUsIHN0YXkgYXMgdGhleSBhcmUuJywKICAgICAgICB9KSwKICAgICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiBjbG9zZUVkaXRvciB9KSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2J0biBidG4tcHJp",
"bWFyeScsIHR5cGU6ICdidXR0b24nLCBkaXNhYmxlZDogZWQuc2F2aW5nLCBkYXRhc2V0OiB7IGtleTogJ2VkaXQtc2F2ZScgfSwKICAgICAgICAgIHRleHQ6ICdTYXZlJywgb25jbGljazogc2F2ZUVkaXRvciwKICAgICAgICB9KSkpOwoKICAgIGVscy5lZGl0b3JMYXllci5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ3NjcmltJywgb25jbGljazogY2xvc2VFZGl0b3IgfSksIGRpYWxvZyk7CiAgICByZXN0b3JlRm9jdXMoa2V5LCBlbHMuZWRpdG9yTGF5ZXIpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUVkaXRvcigpIHsKICAgIGNvbnN0IGVkID0gUy5lZGl0b3I7CiAgICBpZiAoIWVkIHx8IGVkLnNhdmluZykgcmV0dXJuOwogICAgY29uc3QgZWRpdCA9IGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KGVkLmRyYWZ0LCBlZC5zdWJqZWN0KTsKICAgIGVkLnNhdmluZyA9IHRydWU7CiAgICBjb25zdCBzYXZlID0gZWxzLmVkaXRvckxheWVyLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0iZWRpdC1zYXZlIl0nKTsKICAgIGlmIChzYXZlKSBzYXZlLmRpc2FibGVkID0gdHJ1ZTsKCiAgICB0cnkgewogICAgICBhd2FpdCBzdG9yZS5zYXZlQ2FyZEVkaXQoUy5hY2NvdW50LCBlZC5pZCwgZWRpdCk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKFMuZWRpdG9yICE9PSBlZCkgcmV0dXJuOwogICAgICBlZC5zYXZpbmcgPSBmYWxzZTsKICAgICAgZWQuZXJyb3IgPSBgQ291bGRu4oCZdCBzYXZlOiAke2Vy",
"ci5tZXNzYWdlfWA7CiAgICAgIHJlbmRlckVkaXRvcignZWRpdC1zYXZlJyk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAoZWRpdCkgUy5lZGl0cy5zZXQoZWQuaWQsIGVkaXQpOwogICAgZWxzZSBTLmVkaXRzLmRlbGV0ZShlZC5pZCk7CiAgICBpZiAoUy5lZGl0b3IgPT09IGVkKSBTLmVkaXRvciA9IG51bGw7CiAgICByZW5kZXJFZGl0b3IoKTsKICAgIHJlbmRlcigpOwogICAgcmVzdG9yZUZvY3VzKGBtZW51OiR7ZWQuaWR9YCwgZWxzLmJvZHkpOwogICAgYW5ub3VuY2UoZWRpdCA_ICdDYXJkIHVwZGF0ZWQuJyA6ICdDYXJkIGJhY2sgdG8gc2hvd2luZyB0aGUgZW1haWwuJyk7CiAgfQoKICAvLyDilIDilIAgRXh0ZXJuYWwgY2hhbmdlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gQ29sdW1ucyBlZGl0ZWQgaW4gYW5vdGhlciB0YWIgb3Igb24gYW5vdGhlciBjb21wdXRlciAoc3RvcmFnZS5zeW5jKS4KICAvLyBUaGlzIHRhYidzIG93biBzYXZlcyBlY2hvIGJhY2sgaGVyZSB0b287IHRob3NlIGFyZSBhbHJlYWR5IG9uIHNjcmVlbi4KICBmdW5jdGlvbiBjb2x1bW5zQ2hhbmdlZChuZXh0KSB7CiAgICBpZiAobmV4dCAmJiBKU09OLnN0cmluZ2lmeShuZXh0KSA9PT0gSlNPTi5zdHJp",
"bmdpZnkoUy5jb2x1bW5zKSkgcmV0dXJuOwogICAgUy5sb2FkZWRBdCA9IDA7CiAgICBpZiAoUy5vcGVuICYmICFTLmRyYXdlciAmJiBTLnZpZXcgPT09ICdib2FyZCcpIHJlZnJlc2goKTsKICB9CgogIC8vIENhcmQgZWRpdHMgc2F2ZWQgaW4gYW5vdGhlciB0YWIsIG9yIHN5bmNlZCBmcm9tIGFub3RoZXIgY29tcHV0ZXIuCiAgLy8gVGhpcyB0YWIncyBvd24gc2F2ZXMgZWNobyBiYWNrIGhlcmUgYXMgd2VsbDsgdGhvc2UgYXJlIGFscmVhZHkgZHJhd24sCiAgLy8gYW5kIHJlZHJhd2luZyBmb3IgdGhlbSB3b3VsZCBjbG9zZSBhIG1lbnUgb3BlbmVkIGluIHRoZSBtZWFudGltZS4KICBmdW5jdGlvbiBjYXJkRWRpdHNDaGFuZ2VkKGNoYW5nZXMsIHByZWZpeCkgewogICAgbGV0IGNoYW5nZWQgPSBmYWxzZTsKICAgIGZvciAoY29uc3QgW2tleSwgY2hhbmdlXSBvZiBPYmplY3QuZW50cmllcyhjaGFuZ2VzKSkgewogICAgICBpZiAoIWtleS5zdGFydHNXaXRoKHByZWZpeCkpIGNvbnRpbnVlOwogICAgICBjb25zdCBpZCA9IGtleS5zbGljZShwcmVmaXgubGVuZ3RoKTsKICAgICAgY29uc3QgbmV4dCA9IGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KGNoYW5nZSAmJiBjaGFuZ2UubmV3VmFsdWUpOwogICAgICBpZiAoSlNPTi5zdHJpbmdpZnkobmV4dCkgPT09IEpTT04uc3RyaW5naWZ5KFMuZWRpdHMuZ2V0KGlkKSB8fCBudWxsKSkgY29udGludWU7CiAgICAgIGlmIChuZXh0KSBTLmVkaXRzLnNldChpZCwgbmV4dCk7CiAgICAg",
"IGVsc2UgUy5lZGl0cy5kZWxldGUoaWQpOwogICAgICBjaGFuZ2VkID0gdHJ1ZTsKICAgIH0KICAgIGlmIChjaGFuZ2VkICYmIFMub3BlbiAmJiBTLnN0YXR1cyA9PT0gJ3JlYWR5JyAmJiBTLnZpZXcgPT09ICdib2FyZCcpIHJlbmRlcigpOwogIH0KCiAgbnMuYm9hcmQgPSB7CiAgICBvcGVuLCBjbG9zZSwgdG9nZ2xlLCB0b2dnbGVWaWV3LCBjb2x1bW5zQ2hhbmdlZCwgY2FyZEVkaXRzQ2hhbmdlZCwKICAgIGlzT3BlbjogKCkgPT4gUy5vcGVuLAogICAgLy8gRm9yIHRoZSBwaG9uZSBhcHA6IHdoYXQgaXMgc2hvd2luZywgYW5kIGEgcmVmcmVzaCBpZiBpdCBpcyBzdGFsZS4KICAgIHZpZXc6ICgpID0-IFMudmlldywKICAgIHJlZnJlc2hJZlN0YWxlKCkgewogICAgICBpZiAoUy5vcGVuICYmIFMudmlldyA9PT0gJ2JvYXJkJyAmJiBEYXRlLm5vdygpIC0gUy5sb2FkZWRBdCA-IFNUQUxFX01TKSByZWZyZXNoKCk7CiAgICB9LAogIH07Cn0pKCk7Cg\"],[\"addon/app/shell.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAKLy8KLy8gVGhlIGV4dGVuc2lvbidz",
"IGJvYXJkLCBOb3RlcyBhbmQgQ2FsZW5kYXIsIGZ1bGwtc2NyZWVuLCBhcyB0aGUgYXBwCi8vIGl0c2VsZjogdGhlIHNhbWUgdGFicywgY29sdW1ucywgY2FyZHMsIG5vdGVzLCBzZWFyY2gsIGVkaXRvciwgYXV0b3NhdmUKLy8gYW5kIGNhbGVuZGFyLCB3aXRoIHRoZSBib2FyZCdzIHN0eWxlcyBhbmQgYSBwaG9uZSBsYXlvdXQgb24gdG9wLiBPbiBhCi8vIHBob25lIHRoZSBib2FyZCBzaG93cyBvbmUgY29sdW1uIGF0IGEgdGltZSwgc3dpcGVkIHNpZGV3YXlzOyB0aGUgbm90ZXMKLy8gb3BlbiBvbiB0aGUgU2NyYXRjaHBhZCwgdW5kZXIgdGhlIHNlYXJjaCBib3g7IGEgZm9sZGVyIG9yIGEgc2VhcmNoCi8vIHNob3dzIHRoZSBsaXN0IGluc3RlYWQsIGFuZCBhIG5vdGUgb3BlbnMgZnVsbC1zY3JlZW47IHRoZSBjYWxlbmRhciBpcwovLyB0aGUgd2VlayBhcyB0d28gY29sdW1ucyBvZiBkYXlzLCBzd2lwZWQgdG8gdGhlIG5leHQgd2Vlay4gQSBmaXJzdCB2aXNpdCBvcGVucyBvbiB0aGUKLy8gbm90ZXM7IGFmdGVyIHRoYXQsIG9uIHdoaWNoZXZlciB0YWIgd2FzIHVzZWQgbGFzdC4KLy8KLy8gQSBwaG9uZSBsZWF2ZXMgcGFnZXMgd2l0aG91dCBjbG9zaW5nIHRoZW0sIHNvIHdoYXRldmVyIGlzIHBlbmRpbmcgaXMKLy8gc2F2ZWQgd2hlbmV2ZXIgdGhlIHBhZ2UgaXMgaGlkZGVuOyBhbmQgQW5kcm9pZCdzIGJhY2sgZ2VzdHVyZSBzdGVwcwovLyBiYWNrIHRocm91Z2ggdGhlIG5vdGVzIC0gYSBub3RlIHRvIHRoZSBsaXN0",
"LCB0aGUgbGlzdCB0byB0aGUKLy8gU2NyYXRjaHBhZCAtIHRocm91Z2ggZ29vZ2xlLnNjcmlwdC5oaXN0b3J5LgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB7IG1vdW50U2hhZG93IH0gPSBucy51aTsKCiAgY29uc3QgUEhPTkUgPSBgCjpob3N0IHsgcG9zaXRpb246IGZpeGVkICFpbXBvcnRhbnQ7IGluc2V0OiAwICFpbXBvcnRhbnQ7IH0KLm92ZXJsYXkgeyBwYWRkaW5nOiBlbnYoc2FmZS1hcmVhLWluc2V0LXRvcCkgZW52KHNhZmUtYXJlYS1pbnNldC1yaWdodCkgZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pIGVudihzYWZlLWFyZWEtaW5zZXQtbGVmdCk7IH0KCkBtZWRpYSAobWF4LXdpZHRoOiA3NjBweCkgewogIC8qIFRoZSBoZWFkZXI6IHRoZSBtYXJrLCB0aGUgdGhyZWUgdGFicywgcmVmcmVzaCBhbmQgdGhlIGNvbHVtbgogICAgIHNldHRpbmdzOyBnb25lIHdoaWxlIGEgbm90ZSBoYXMgdGhlIHdob2xlIHNjcmVl",
"bi4gT24gYSBzbWFsbCBwaG9uZQogICAgIG9ubHkgdGhlIG9wZW4gdGFiIHNheXMgaXRzIG5hbWUuICovCiAgLmJhciB7IGhlaWdodDogNTZweDsgcGFkZGluZzogMCA0cHggMCAxMnB4OyBnYXA6IDJweDsgfQogIC5icmFuZCA-IHNwYW46bm90KC5sb2dvKSwgLmFjY291bnQsIC51cGRhdGVkIHsgZGlzcGxheTogbm9uZTsgfQogIC50YWJzIHsgbWFyZ2luLWxlZnQ6IDEwcHg7IG1pbi13aWR0aDogMDsgfQogIC50YWIgeyBwYWRkaW5nOiAwIDEycHggMCAxMHB4OyB9CiAgOmhvc3QoW2RhdGEtdmlldz0ibm90ZSJdKSAuYmFyIHsgZGlzcGxheTogbm9uZTsgfQoKICAvKiBUaGUgYm9hcmQ6IG9uZSBjb2x1bW4gdG8gYSBzY3JlZW4sIHN3aXBlZCBzaWRld2F5cy4gQ2FyZHMgbW92ZSB3aXRoCiAgICAgdGhlaXIg4ouvIG1lbnUsIHNpbmNlIGEgZmluZ2VyIGNhbm5vdCBkcmFnIHRoZW0uICovCiAgLmNvbHVtbnMgeyBzY3JvbGwtc25hcC10eXBlOiB4IG1hbmRhdG9yeTsgZ2FwOiAxMHB4OyBwYWRkaW5nOiA0cHggMTZweCAxMnB4OyBzY3JvbGwtcGFkZGluZzogMCAxNnB4OyB9CiAgLmNvbHVtbiB7IGZsZXg6IDAgMCBjYWxjKDEwMHZ3IC0gNDRweCk7IG1pbi13aWR0aDogMDsgbWF4LXdpZHRoOiBub25lOyBzY3JvbGwtc25hcC1hbGlnbjogY2VudGVyOyB9CgogIC5ub3RlcyB7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMDsgcGFkZGluZzogMDsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9Im5vdGUiXSAubm90ZXMtZm9s",
"ZGVycywgLm5vdGVzW2RhdGEtdmlldz0ibm90ZSJdIC5ub3Rlcy1saXN0IHsgZGlzcGxheTogbm9uZTsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9Imxpc3QiXSAubm90ZS1lZGl0b3IgeyBkaXNwbGF5OiBub25lOyB9CgogIC8qIEhvbWU6IHRoZSBzZWFyY2ggYm94LCBhbmQgdGhlIHNjcmF0Y2hwYWQgZmlsbGluZyB0aGUgcmVzdC4gKi8KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5vdGVzLWxpc3QgeyBmbGV4OiBub25lOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5ub3Rlcy1zY29wZSwgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5ub3Rlcy1pdGVtcywgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5ub3Rlcy1mb290IHsgZGlzcGxheTogbm9uZTsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubm90ZS1lZGl0b3IgeyBtYXJnaW46IDAgMTJweCAxMnB4OyBib3JkZXItcmFkaXVzOiAyMnB4OyBtaW4taGVpZ2h0OiAwOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5uZS10aXRsZSB7IHBhZGRpbmc6IDE0cHggMThweCA2cHg7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5lLXRvb2xiYXIgeyBtYXJnaW46IDAgMTBweDsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubmUtYm9keSB7IHBhZGRpbmc6IDEwcHggMThweCAyMHZoOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5uZS1ib2R5W2RhdGEtZW1wdHk9IjEiXTo6YmVmb3JlIHsgbGVmdDogMThweDsgcmlnaHQ6",
"IDE4cHg7IH0KCiAgLyogRm9sZGVyczogdGhlIHRyZWUsIGZvbGRlZCBhd2F5IGJlaGluZCBhIGJ1dHRvbiB0aGF0IHNheXMgd2hlcmUgeW91CiAgICAgYXJlOyBvcGVuLCBpdCBpcyB0aGUgc2FtZSB0cmVlIGFzIG9uIGEgY29tcHV0ZXIsIG5lc3RpbmcgYW5kIGFsbC4gKi8KICAubm90ZXMtZm9sZGVycyB7IGZsZXg6IG5vbmU7IGJhY2tncm91bmQ6IG5vbmU7IGJvcmRlci1yYWRpdXM6IDA7IHBhZGRpbmc6IDJweCAxMnB4IDRweDsgfQogIC5mb2xkZXJzLXRvZ2dsZSB7CiAgICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEwcHg7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDQ2cHg7IHBhZGRpbmc6IDAgMTBweCAwIDE0cHg7CiAgICBib3JkZXItcmFkaXVzOiAxNHB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOyBjb2xvcjogdmFyKC0tZmcpOyBmb250LXNpemU6IDE1cHg7IHRleHQtYWxpZ246IGxlZnQ7CiAgfQogIC5mb2xkZXJzLXRvZ2dsZSAuaWNvbiB7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZmxleDogbm9uZTsgfQogIC5mdC1sYWJlbCB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IHdoaXRlLXNwYWNlOiBub3dyYXA7IH0KICAuZnQtY291bnQgeyBjb2xvcjogdmFyKC0tZmctMyk7IGZvbnQtc2l6ZTogMTNweDsgZm9udC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtczsgfQogIC5ub3Rlc1tkYXRhLWZvbGRlcnM9",
"Im9wZW4iXSAuZm9sZGVycy10b2dnbGUgeyBib3JkZXItcmFkaXVzOiAxNHB4IDE0cHggMCAwOyB9CiAgLm5vdGVzW2RhdGEtZm9sZGVycz0ib3BlbiJdIC5mb2xkZXJzLXRvZ2dsZSAuaWNvbjpsYXN0LWNoaWxkIHsgdHJhbnNmb3JtOiByb3RhdGUoMTgwZGVnKTsgfQogIC5ub3Rlczpub3QoW2RhdGEtZm9sZGVycz0ib3BlbiJdKSAuZm9sZGVycy1oZWFkLCAubm90ZXM6bm90KFtkYXRhLWZvbGRlcnM9Im9wZW4iXSkgLmZvbGRlci1pdGVtcyB7IGRpc3BsYXk6IG5vbmU7IH0KICAuZm9sZGVycy1oZWFkIHsgYmFja2dyb3VuZDogdmFyKC0tY29sKTsgcGFkZGluZzogMCA2cHggMCAxNnB4OyB9CiAgLmZvbGRlci1pdGVtcyB7IGZsZXg6IG5vbmU7IG1heC1oZWlnaHQ6IDU1dmg7IGJhY2tncm91bmQ6IHZhcigtLWNvbCk7IGJvcmRlci1yYWRpdXM6IDAgMCAxNHB4IDE0cHg7IHBhZGRpbmc6IDJweCA4cHggMTBweDsgfQogIC5mb2xkZXItYnRuIHsgaGVpZ2h0OiA0NHB4OyB9CiAgLmZvbGRlci10d2lzdHkgeyB3aWR0aDogMzRweDsgaGVpZ2h0OiA0NHB4OyBtYXJnaW4tcmlnaHQ6IDA7IH0KICAuZm9sZGVyLWl0ZW1zW2RhdGEtbmVzdGVkXSAuZm9sZGVyLWVkaXQgeyBwYWRkaW5nLWxlZnQ6IDQ0cHg7IH0KICAuZm9sZGVyLWl0ZW1zW2RhdGEtbmVzdGVkXSAuZm9sZGVyLWVycm9yIHsgcGFkZGluZy1sZWZ0OiA3MHB4OyB9CiAgLyogTm8gaG92ZXIgb24gYSBwaG9uZTogZWFjaCBmb2xkZXIncyDii68gaXMgYWx3YXlzIHRo",
"ZXJlLCBuZXh0IHRvIGl0cyBjb3VudC4gKi8KICAuZm9sZGVyLW1lbnUgeyBvcGFjaXR5OiAxOyByaWdodDogNHB4OyB9CiAgLmZvbGRlci1yb3cgLmZvbGRlci1jb3VudCwgLmZvbGRlci1yb3c6aG92ZXIgLmZvbGRlci1jb3VudCwgLmZvbGRlci1yb3c6Zm9jdXMtd2l0aGluIC5mb2xkZXItY291bnQgeyB2aXNpYmlsaXR5OiB2aXNpYmxlOyBtYXJnaW4tcmlnaHQ6IDM0cHg7IH0KCiAgLm5vdGVzLWxpc3QgeyBmbGV4OiAxOyBib3JkZXItcmFkaXVzOiAwOyBiYWNrZ3JvdW5kOiBub25lOyB9CiAgLm5vdGVzLXRvb2xzIHsgcGFkZGluZzogNHB4IDEycHggOHB4OyB9CiAgLm5vdGVzLWl0ZW1zIHsgcGFkZGluZzogMCA0cHggMTJweDsgfQogIC5ub3RlLWl0ZW0geyBwYWRkaW5nOiAxMnB4OyB9CgogIC5ub3RlLWVkaXRvciB7IGZsZXg6IDE7IGJvcmRlci1yYWRpdXM6IDA7IGJveC1zaGFkb3c6IG5vbmU7IH0KICAubmUtYmFjayB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBtYXJnaW4tcmlnaHQ6IDJweDsgfQogIC5uZS1iYXIgeyBwYWRkaW5nOiA2cHggNnB4IDAgNHB4OyB9CiAgLm5lLXRpdGxlIHsgcGFkZGluZzogNnB4IDE2cHggNHB4OyBmb250LXNpemU6IDIycHg7IH0KICAubmUtdG9vbGJhciB7IG1hcmdpbjogMCA4cHg7IG92ZXJmbG93LXg6IGF1dG87IGZsZXgtd3JhcDogbm93cmFwOyBzY3JvbGxiYXItd2lkdGg6IG5vbmU7IH0KICAubmUtbGlua2JhciB7IG1hcmdpbjogNHB4IDhweCAwOyB9CiAgLm5lLWJhbm5l",
"ciB7IG1hcmdpbjogNHB4IDEycHggMDsgfQogIC5uZS1maW5kIHsgbWFyZ2luOiA0cHggMTJweCAwOyB9CiAgLm5lLWJvZHkgeyBwYWRkaW5nOiAxMHB4IDE2cHggNDB2aDsgZm9udC1zaXplOiAxNnB4OyB9CiAgLm5lLWJvZHlbZGF0YS1lbXB0eT0iMSJdOjpiZWZvcmUgeyBsZWZ0OiAxNnB4OyB9Cn0KQG1lZGlhIChtYXgtd2lkdGg6IDQ4MHB4KSB7CiAgLnRhYlthcmlhLXNlbGVjdGVkPSJmYWxzZSJdIHsgZ2FwOiAwOyBwYWRkaW5nOiAwIDEwcHg7IGZvbnQtc2l6ZTogMDsgfQp9CmA7CgogIC8vIEFwcHMgU2NyaXB0J3MgaGlzdG9yeSwgaWYgdGhlcmUgaXMgb25lLCB1c2VkIHNvIHRoYXQgbm90aGluZyBpdCBkb2VzIC0KICAvLyBvciBmYWlscyB0byBkbyAtIGNhbiBzdG9wIHRoZSBhcHA6IHRoZSBiYWNrIGdlc3R1cmUgaXMgYSBuaWNldHkuCiAgZnVuY3Rpb24gaGlzdG9yeUFwaSgpIHsKICAgIGNvbnN0IGFwaSA9IHR5cGVvZiBnb29nbGUgIT09ICd1bmRlZmluZWQnICYmIGdvb2dsZS5zY3JpcHQgJiYgZ29vZ2xlLnNjcmlwdC5oaXN0b3J5OwogICAgaWYgKCFhcGkpIHJldHVybiBudWxsOwogICAgY29uc3Qgc2FmZSA9IGZuID0-ICguLi5hcmdzKSA9PiB7CiAgICAgIHRyeSB7IHJldHVybiBhcGlbZm5dKC4uLmFyZ3MpOyB9IGNhdGNoIChlcnIpIHsgY29uc29sZS53YXJuKGBnb29nbGUuc2NyaXB0Lmhpc3RvcnkuJHtmbn06ICR7ZXJyLm1lc3NhZ2V9YCk7IHJldHVybiB1bmRlZmluZWQ7IH0KICAgIH07CiAgICBy",
"ZXR1cm4geyBwdXNoOiBzYWZlKCdwdXNoJyksIHJlcGxhY2U6IHNhZmUoJ3JlcGxhY2UnKSwgc2V0Q2hhbmdlSGFuZGxlcjogc2FmZSgnc2V0Q2hhbmdlSGFuZGxlcicpIH07CiAgfQoKICBjb25zdCB3aWRlID0gKCkgPT4gISEod2luZG93Lm1hdGNoTWVkaWEgJiYgd2luZG93Lm1hdGNoTWVkaWEoJyhtaW4td2lkdGg6IDc2MXB4KScpLm1hdGNoZXMpOwoKICBmdW5jdGlvbiBzdGFydCgpIHsKICAgIC8vIFdpdGhvdXQgYWxsIGl0cyBwYXJ0cyB0aGUgYXBwIGNhbm5vdCB3b3JrOiB0aGUgbG9hZGVyJ3MgbGlzdCBvZgogICAgLy8gd2hhdCBkaWQgbm90IGxvYWQgc3RheXMgb24gdGhlIHNjcmVlbiBpbnN0ZWFkLgogICAgaWYgKHdpbmRvdy5fX3BhcnRzRmFpbGVkICYmIHdpbmRvdy5fX3BhcnRzRmFpbGVkLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgeyBob3N0LCByb290IH0gPSBtb3VudFNoYWRvdygnZ2tiLWFwcC1ob3N0JywgbnMuc3R5bGVzLmJvYXJkICsgUEhPTkUpOwogICAgY29uc3QgaGlzdG9yeSA9IGhpc3RvcnlBcGkoKTsKICAgIC8vIEhvdyBtYW55IHN0ZXBzIGluIGZyb20gdGhlIFNjcmF0Y2hwYWQgdGhlIGhpc3RvcnkgaG9sZHMsIGFuZCB3aGV0aGVyCiAgICAvLyB0aGUgYmFjayBnZXN0dXJlIGlzIGJlaW5nIGZvbGxvd2VkIHJpZ2h0IG5vdy4KICAgIGxldCBkZXB0aCA9IDA7CiAgICBsZXQgc3RlcHBpbmcgPSBmYWxzZTsKCiAgICAvLyBXaGljaCBmb2xkZXJzIGFyZSBmb2xkZWQsIHdoaWNoIGNhbGVu",
"ZGFycyBzaG93LCBvbiB0aGlzIHBob25lLiBUaGUKICAgIC8vIHBhZ2UgaXMgb25seSBldmVyIG9wZW5lZCBieSBpdHMgb3duZXIsIHNvIHRoZXJlIGlzIG5vIGFjY291bnQgdG8KICAgIC8vIGtleSB0aGVtIGJ5LgogICAgY29uc3QgcHJlZnMgPSB7CiAgICAgIGdldChuYW1lKSB7CiAgICAgICAgdHJ5IHsgcmV0dXJuIEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oYHN1cGVybWFpbC4ke25hbWV9YCkgfHwgJ251bGwnKTsgfSBjYXRjaCAoZXJyKSB7IHJldHVybiBudWxsOyB9CiAgICAgIH0sCiAgICAgIHNldChuYW1lLCB2YWx1ZSkgewogICAgICAgIHRyeSB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKGBzdXBlcm1haWwuJHtuYW1lfWAsIEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7IH0gY2F0Y2ggKGVycikgeyAvKiBzdG9yYWdlIG9mZjogbm90IHJlbWVtYmVyZWQgKi8gfQogICAgICB9LAogICAgfTsKCiAgICBucy5ib2FyZEZyYW1lID0gewogICAgICByb290LAogICAgICB2aWV3OiAnbm90ZXMnLAogICAgICAvLyBPbiBhIGNvbXB1dGVyLCB0eXBpbmcgZ29lcyBzdHJhaWdodCBpbnRvIHRoZSBTY3JhdGNocGFkLiAoQSBwaG9uZQogICAgICAvLyB3b3VsZCBvbmx5IHBvcCBpdHMga2V5Ym9hcmQgdXAgb3ZlciBpdCwgc28gdGhlcmUgaXQgd2FpdHMgZm9yIGEgdGFwLikKICAgICAgZm9jdXM6IHdpZGUoKSwKICAgICAgLy8gVGhlIHNjcmlwdCdzIG93biBhY2Nlc3MgY292ZXJzIHRoZSBjYWxlbmRhcjogbm90aGlu",
"ZyB0byBjb25uZWN0LgogICAgICBjYWxlbmRhcjogeyBwcmVmcywgY29ubmVjdDogbnVsbCB9LAogICAgICBub3RlczogewogICAgICAgIHByZWZzLAogICAgICAgIC8vIEVhY2ggc3RlcCBpbiBnb2VzIG9uIHRoZSBoaXN0b3J5LCBzbyB0aGUgYmFjayBnZXN0dXJlIGNhbiB1bmRvIGl0OwogICAgICAgIC8vIGEgc3RlcCBvdXQgdGFrZW4gaW4gdGhlIGFwcCBpdHNlbGYgcmV3cml0ZXMgdGhlIHRvcCBlbnRyeSBpbnN0ZWFkLAogICAgICAgIC8vIHNpbmNlIG5vdGhpbmcgaGVyZSBjYW4gdGFrZSBhbiBlbnRyeSBvZmYuCiAgICAgICAgb25WaWV3Q2hhbmdlKHZpZXcpIHsKICAgICAgICAgIGhvc3QuZGF0YXNldC52aWV3ID0gdmlldzsKICAgICAgICAgIGNvbnN0IGQgPSBucy5ub3Rlcy5kZXB0aCgpOwogICAgICAgICAgaWYgKGhpc3RvcnkgJiYgIXN0ZXBwaW5nKSB7CiAgICAgICAgICAgIGlmIChkID4gZGVwdGgpIGZvciAobGV0IGkgPSBkZXB0aCArIDE7IGkgPD0gZDsgaSsrKSBoaXN0b3J5LnB1c2goeyBkZXB0aDogaSB9LCB7fSwgJycpOwogICAgICAgICAgICBlbHNlIGlmIChkIDwgZGVwdGgpIGhpc3RvcnkucmVwbGFjZSh7IGRlcHRoOiBkIH0sIHt9LCAnJyk7CiAgICAgICAgICB9CiAgICAgICAgICBkZXB0aCA9IGQ7CiAgICAgICAgfSwKICAgICAgfSwKICAgIH07CgogICAgaWYgKGhpc3RvcnkpIHsKICAgICAgaGlzdG9yeS5zZXRDaGFuZ2VIYW5kbGVyKGFzeW5jIGUgPT4gewogICAgICAgIGNvbnN0IHRhcmdl",
"dCA9IChlICYmIGUuc3RhdGUgJiYgTnVtYmVyKGUuc3RhdGUuZGVwdGgpKSB8fCAwOwogICAgICAgIHN0ZXBwaW5nID0gdHJ1ZTsKICAgICAgICB0cnkgewogICAgICAgICAgd2hpbGUgKG5zLm5vdGVzLmRlcHRoKCkgPiB0YXJnZXQpIHsKICAgICAgICAgICAgY29uc3QgYmVmb3JlID0gbnMubm90ZXMuZGVwdGgoKTsKICAgICAgICAgICAgYXdhaXQgbnMubm90ZXMuYmFjaygpOwogICAgICAgICAgICBpZiAobnMubm90ZXMuZGVwdGgoKSA-PSBiZWZvcmUpIGJyZWFrOyAvLyBhbiB1bnNhdmVkIGVkaXQga2VwdCB0aGUgbm90ZSBvcGVuCiAgICAgICAgICB9CiAgICAgICAgfSBmaW5hbGx5IHsKICAgICAgICAgIHN0ZXBwaW5nID0gZmFsc2U7CiAgICAgICAgfQogICAgICAgIC8vIE5vdCBhcyBmYXIgYmFjayBhcyB0aGUgZ2VzdHVyZSB3ZW50OiB0aG9zZSBzdGVwcyBnbyBiYWNrIG9uLgogICAgICAgIGRlcHRoID0gbnMubm90ZXMuZGVwdGgoKTsKICAgICAgICBmb3IgKGxldCBpID0gdGFyZ2V0ICsgMTsgaSA8PSBkZXB0aDsgaSsrKSBoaXN0b3J5LnB1c2goeyBkZXB0aDogaSB9LCB7fSwgJycpOwogICAgICB9KTsKICAgIH0KCiAgICAvLyBBIHBob25lIHN3aXRjaGVzIGF3YXkgd2l0aG91dCBjbG9zaW5nIHRoZSBwYWdlLgogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndmlzaWJpbGl0eWNoYW5nZScsICgpID0-IHsKICAgICAgaWYgKGRvY3VtZW50LnZpc2liaWxpdHlTdGF0ZSA9PT0gJ2hpZGRlbicpIG5zLm5v",
"dGVzLmZsdXNoKCk7CiAgICAgIGVsc2UgaWYgKG5zLmJvYXJkLnZpZXcoKSA9PT0gJ25vdGVzJykgeyBpZiAobnMubm90ZXMuaXNTdGFsZSgpKSBucy5ub3Rlcy5sb2FkKCk7IH0KICAgICAgZWxzZSBpZiAobnMuYm9hcmQudmlldygpID09PSAnY2FsZW5kYXInKSB7IGlmIChucy5jYWxlbmRhci5pc1N0YWxlKCkpIG5zLmNhbGVuZGFyLmxvYWQoKTsgfQogICAgICBlbHNlIG5zLmJvYXJkLnJlZnJlc2hJZlN0YWxlKCk7CiAgICB9KTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwYWdlaGlkZScsICgpID0-IG5zLm5vdGVzLmZsdXNoKCkpOwoKICAgIC8vIFRoZSBib2FyZCBrZWVwcyBpdHMgc2V0dGluZ3MgcGVyIGFjY291bnQ6IHdob3NlLCBmaXJzdC4KICAgIHJldHVybiBucy5hcHBSZW1vdGUubG9hZEFjY291bnQoKS50aGVuKCgpID0-IHsKICAgICAgbnMuYm9hcmQub3BlbigpOwogICAgICBjb25zdCBib290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Jvb3QnKTsKICAgICAgaWYgKGJvb3QpIGJvb3QucmVtb3ZlKCk7CiAgICB9LCBlcnIgPT4gewogICAgICBpZiAod2luZG93Ll9fYm9vdEZhaWxlZCkgd2luZG93Ll9fYm9vdEZhaWxlZChgR21haWwgY291bGQgbm90IGJlIHJlYWNoZWQ6ICR7ZXJyLm1lc3NhZ2V9YCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHJ1bigpIHsKICAgIHRyeSB7CiAgICAgIHN0YXJ0KCk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgY29uc29sZS5lcnJvcihlcnIpOwog",
"ICAgICBpZiAod2luZG93Ll9fYm9vdEZhaWxlZCkgd2luZG93Ll9fYm9vdEZhaWxlZChlcnIubWVzc2FnZSwgZXJyLnN0YWNrKTsKICAgIH0KICB9CgogIG5zLnBob25lQXBwID0geyBzdGFydCB9OwogIGlmIChkb2N1bWVudC5yZWFkeVN0YXRlID09PSAnbG9hZGluZycpIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCBydW4pOwogIGVsc2UgcnVuKCk7Cn0pKCk7Cg\"]];\n  var SOURCE = String.fromCharCode(10, 47, 47) + '# sourceURL=app/';\n  function decode(text) {\n    var bin = atob(text.replace(/-/g, '+').replace(/_/g, String.fromCharCode(47)));\n    var bytes = new Uint8Array(bin.length);\n    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n    return new TextDecoder('utf-8').decode(bytes);\n  }\n  function run(name, code) {\n    try {\n      (0, eval)(code + SOURCE + name);\n    } catch (err) {\n      if (!(err instanceof EvalError)) throw err;\n      var el = document.createElement('script');\n      el.text = code + SOURCE + name;\n      document.head.appendChild(el);\n    }\n  }\n  var failed = [];\n  for (var i = 0; i < MODULES.length; i++) ",
"{\n    try {\n      run(MODULES[i][0], decode(MODULES[i][1]));\n    } catch (err) {\n      failed.push(MODULES[i][0] + ': ' + err.message);\n    }\n  }\n  if (failed.length) {\n    window.__partsFailed = failed;\n    if (window.__bootFailed) window.__bootFailed('Parts that did not load: ' + failed.join('; '));\n  }\n})();\n</script>\n</body>\n</html>\n",
].join('');
