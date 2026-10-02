// The phone panel and phone app 0.12.0: a Gmail add-on and a web app, in Apps Script.
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
    token: email => `token:${String(email).toLowerCase()}`,     // storage.session
    gmailTabs: 'gmailTabs',                      // storage.session
  };

  // Element ids for the two shadow hosts. Short and namespaced rather than
  // branded, so they survive a rename and are unlikely to clash with Gmail.
  const HOST_IDS = {
    board: 'gkb-board-host',
    dock: 'gkb-dock-host',
  };

  ns.APP_NAME = APP_NAME;
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
    newNoteId, encodeHeaderText, decodeHeaderText, base64UrlEncode, base64UrlDecode,
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

  function parse(res, method, path) {
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
    let message = text;
    try { message = JSON.parse(text).error.message || text; } catch (e) { /* not JSON */ }
    const err = new Error(`Gmail answered ${code} to ${method} ${path}: ${message}`);
    err.status = code;
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

  ns.addonGmail = { call, callAll, insertNote, modifyLabels, modifyThread, trashNote, untrashNote, queryString };
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
  function save(ctx, previous, { title, doc, folderId = '' }) {
    const folder = folderId && ctx.folders.some(f => f.id === folderId) ? folderId : '';
    const noteId = previous && previous.own ? previous.noteId : notesLogic.newNoteId();
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
// The phone app (addon/app) is the extension's own Notes view, served as
// a full-screen web page by this same script. Where the extension's
// notes store asks Gmail through the background worker, the app's asks
// these functions through google.script.run - and they keep the worker's
// rules: only notes are inserted, only notes go to Trash or come back out
// of it, mail kept as a note just leaves the list, and only an empty
// notes folder is ever deleted.
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
    const id = store.save(ctx, previous, { title: String(s.title || ''), doc: s.doc, folderId });
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

  // The page itself, built into Code.gs by tools/build-addon.mjs.
  function page() {
    return HtmlService.createHtmlOutput(globalThis.SUPERMAIL_APP_HTML || '<p>The app is not built into this Code.gs.</p>')
      .setTitle(`${ns.APP_NAME} notes`)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  }

  ns.app = { page, list, body, save, retire, restore, move, createFolder, renameFolder, deleteFolder };
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

// ════ the phone app's page (addon/app, built) ════════════════════

var SUPERMAIL_APP_HTML = [
"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<base target=\"_top\">\n<style>\n  html, body { margin: 0; height: 100%; background: #f6f8fc; }\n  @media (prefers-color-scheme: dark) { html, body { background: #131314; } }\n</style>\n</head>\n<body>\n<script>\n// src/shared/ns.js\n// ─────────────────────────────────────────────────────────────────────\n// Shared namespace\n//\n// Content scripts are classic scripts that all run in one isolated world.\n// Two files that each declared a top-level `const` of the same name would\n// collide, so every file wraps itself in an IIFE and hangs what it exports\n// off this one object instead. The service worker and the options page\n// load the same files and see the same shape.\n//\n// APP_NAME is the only place the display name lives in code. Nothing\n// internal - the namespace, storage keys, CSS classes, element ids - is\n// derived from it, so a rename never ",
"has to touch stored data. The README\n// lists every spot that does carry the name.\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n\n  const APP_NAME = 'Supermail';\n\n  // ── Storage keys ─────────────────────────────────────────────────────\n  //\n  // Keyed by lower-cased account email, because a Gmail tab at /u/1/ is a\n  // different mailbox with different labels, and one person's column\n  // layout must not leak into another account's board.\n\n  const KEYS = {\n    clientId: 'clientId',                        // storage.sync\n    dockPosition: 'dockPosition',                // storage.sync\n    columns: email => `columns:${String(email).toLowerCase()}`, // storage.sync\n    order: email => `order:${String(email).toLowerCase()}`,     // storage.local\n    // Card edits get one key per card rather than one map per account:\n    // sync caps each item at 8 KB, which a single map would ",
"outgrow after\n    // a few dozen notes, while the 512-item cap leaves room for hundreds.\n    cardPrefix: email => `card:${String(email).toLowerCase()}:`,                  // storage.sync\n    card: (email, threadId) => `card:${String(email).toLowerCase()}:${threadId}`, // storage.sync\n    notes: email => `notes:${String(email).toLowerCase()}`,     // storage.sync: { label, labelId }\n    view: 'view',                                // storage.local: 'board' | 'notes'\n    token: email => `token:${String(email).toLowerCase()}`,     // storage.session\n    gmailTabs: 'gmailTabs',                      // storage.session\n  };\n\n  // Element ids for the two shadow hosts. Short and namespaced rather than\n  // branded, so they survive a rename and are unlikely to clash with Gmail.\n  const HOST_IDS = {\n    board: 'gkb-board-host',\n    dock: 'gkb-dock-host',\n  };\n\n  ns.APP_NAME = APP_NAME;\n  ns.KEYS = KEYS;\n  ns.HOST_IDS = HOST_IDS;\n\n  if (typeof module === 'object' && module.exports) {\n    module.e",
"xports = { APP_NAME, KEYS, HOST_IDS };\n  }\n})();\n</script>\n<script>\n// src/lib/util.js\n// ─────────────────────────────────────────────────────────────────────\n// Small pure helpers\n//\n// Nothing in here touches the DOM, chrome.* or the network, which is what\n// lets the Node tests require this file directly. The content scripts and\n// the service worker reach the same functions through the shared\n// namespace (ns.util).\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n\n  // ── Header helpers ───────────────────────────────────────────────────\n\n  function headerMap(message) {\n    const out = {};\n    const headers = (message && message.payload && message.payload.headers) || [];\n    for (const h of headers) out[h.name.toLowerCase()] = h.value || '';\n    return out;\n  }\n\n  // \"Anna Vos <anna@example.com>\" → { name, email }\n  function parseAddress(raw) {\n    if (!raw) return { nam",
"e: '', email: '' };\n    const angled = raw.match(/^\\s*(.*?)\\s*<([^>]+)>\\s*$/);\n    if (angled) {\n      return {\n        name: angled[1].replace(/^[\"']|[\"']$/g, '').trim(),\n        email: angled[2].trim().toLowerCase(),\n      };\n    }\n    return { name: '', email: raw.trim().toLowerCase() };\n  }\n\n  // What to call a sender on a card. A bare address is shortened to its\n  // local part, because \"accounts\" reads better in a narrow column than\n  // \"accounts@brightwater-language.example\".\n  function displayName(addr) {\n    if (!addr) return '';\n    if (addr.name) return addr.name;\n    return (addr.email || '').split('@')[0];\n  }\n\n  // ── Entities ─────────────────────────────────────────────────────────\n  //\n  // Gmail returns snippets HTML-encoded. The obvious decoder - assign to a\n  // detached element's innerHTML and read textContent back - is what\n  // Gmail's Trusted Types policy forbids, and it would also mean feeding\n  // untrusted mail text to the HTML parser. A lookup table does th",
"e job.\n\n  // The handful every mail needs, plus the typographic ones that HTML\n  // mail written in Gmail or Outlook is full of.\n  const NAMED = {\n    amp: '&', lt: '<', gt: '>', quot: '\"', apos: \"'\", nbsp: '\\u00a0',\n    lsquo: '\\u2018', rsquo: '\\u2019', ldquo: '\\u201c', rdquo: '\\u201d',\n    ndash: '\\u2013', mdash: '\\u2014', hellip: '\\u2026', bull: '\\u2022', middot: '\\u00b7',\n    laquo: '\\u00ab', raquo: '\\u00bb', euro: '\\u20ac', pound: '\\u00a3', copy: '\\u00a9', reg: '\\u00ae', trade: '\\u2122',\n  };\n\n  function decodeEntities(input) {\n    // Single pass, so \"&amp;lt;\" becomes the literal text \"&lt;\" and is\n    // not decoded a second time into \"<\".\n    return String(input == null ? '' : input).replace(\n      /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g,\n      (whole, body) => {\n        if (body[0] === '#') {\n          const hex = body[1] === 'x' || body[1] === 'X';\n          const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);\n          // Out-of-range and surrogate code ",
"points would throw or produce\n          // garbage; leave the original text alone instead.\n          if (!isFinite(code) || code < 1 || code > 0x10ffff ||\n              (code >= 0xd800 && code <= 0xdfff)) return whole;\n          return String.fromCodePoint(code);\n        }\n        const named = NAMED[body.toLowerCase()];\n        return named === undefined ? whole : named;\n      }\n    );\n  }\n\n  // ── Account detection ────────────────────────────────────────────────\n\n  const EMAIL_ONLY_RE = /^[^\\s@<>()\"]+@[^\\s@<>()\"]+\\.[^\\s@<>()\"]+$/;\n  const EMAIL_ANY_RE = /[^\\s@<>()\"]+@[^\\s@<>()\"]+\\.[^\\s@<>()\"]+/;\n\n  // Gmail's title is \"<view or subject> - <account> - <product>\", e.g.\n  // \"Inbox (3,591) - someone@example.com - Gmail\". Workspace accounts can\n  // replace \"Gmail\" with the organisation's own name, so the product part\n  // is not matched. Scanning from the right finds the account even when a\n  // subject line contains an address or a dash of its own.\n  function accountFromTitle(title) {",
"\n    const parts = String(title || '').split(/\\s[-–—]\\s/);\n    for (let i = parts.length - 1; i >= 0; i--) {\n      const p = parts[i].trim();\n      if (EMAIL_ONLY_RE.test(p)) return p.toLowerCase();\n    }\n    return '';\n  }\n\n  // \"Google Account: Anna Vos  (anna@example.com)\" → \"anna@example.com\"\n  function accountFromAriaLabel(label) {\n    const m = String(label || '').match(EMAIL_ANY_RE);\n    return m ? m[0].replace(/[).,;]+$/, '').toLowerCase() : '';\n  }\n\n  // \"/mail/u/1/\" → 1. Defaults to 0, which is what /mail/ alone means.\n  function accountIndexFromPath(pathname) {\n    const m = String(pathname || '').match(/\\/mail\\/u\\/(\\d+)\\//);\n    return m ? Number(m[1]) : 0;\n  }\n\n  // ── Dates ────────────────────────────────────────────────────────────\n  //\n  // Month and day names are spelled out here rather than taken from\n  // Intl, so a card reads the same whatever the browser locale is and\n  // the tests do not depend on the machine they run on.\n\n  const MONTHS = ['Jan', 'Feb', 'Mar', ",
"'Apr', 'May', 'Jun',\n                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];\n  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];\n\n  function startOfDay(ms) {\n    const d = new Date(ms);\n    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();\n  }\n\n  // Compact age for a card: \"just now\", \"12 min\", \"3 h\", \"Yesterday\",\n  // \"Mon\", \"3 Sep\", \"3 Sep 2024\". Hours win over \"Yesterday\" for anything\n  // under a day old, because \"2 h\" is more useful at 1am than \"Yesterday\".\n  function relativeDate(ts, now = Date.now()) {\n    const t = Number(ts);\n    if (!t || !isFinite(t)) return '';\n    const diff = Math.max(0, now - t);\n    const min = Math.floor(diff / 60000);\n    if (min < 1) return 'just now';\n    if (min < 60) return `${min} min`;\n    const hours = Math.floor(min / 60);\n    if (hours < 24) return `${hours} h`;\n\n    // Calendar days, not 24-hour blocks, so \"Yesterday\" means yesterday.\n    const days = Math.round((startOfDay(now) - startOfDay(t)) / 8640",
"0000);\n    const d = new Date(t);\n    if (days <= 1) return 'Yesterday';\n    if (days < 7) return DAYS[d.getDay()];\n    const dm = `${d.getDate()} ${MONTHS[d.getMonth()]}`;\n    return d.getFullYear() === new Date(now).getFullYear() ? dm : `${dm} ${d.getFullYear()}`;\n  }\n\n  // Full date for a tooltip: \"Tue 3 Sep 2026, 14:05\".\n  function fullDate(ts) {\n    const t = Number(ts);\n    if (!t || !isFinite(t)) return '';\n    const d = new Date(t);\n    const pad = n => String(n).padStart(2, '0');\n    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ` +\n           `${pad(d.getHours())}:${pad(d.getMinutes())}`;\n  }\n\n  // For \"updated Xs ago\" in the board header.\n  function agoText(ms) {\n    const s = Math.max(0, Math.floor(Number(ms) / 1000));\n    if (s < 5) return 'just now';\n    if (s < 60) return `${s}s ago`;\n    const m = Math.floor(s / 60);\n    if (m < 60) return `${m} min ago`;\n    return `${Math.floor(m / 60)} h ago`;\n  }\n\n  // ── Concurrency ────────",
"──────────────────────────────────────────────\n\n  // Runs fn over items with at most `limit` in flight. Gmail's per-user\n  // quota is generous, but a board of 100 changed threads fired at once\n  // still trips its burst limiter; six at a time keeps a cold load quick\n  // without provoking 429s. The first rejection stops new work starting\n  // and is re-thrown, so an auth failure does not fan out into 100 more.\n  async function mapPool(items, limit, fn) {\n    const results = new Array(items.length);\n    let next = 0;\n    let failed = null;\n    async function worker() {\n      while (failed === null && next < items.length) {\n        const i = next++;\n        try {\n          results[i] = await fn(items[i], i);\n        } catch (err) {\n          if (failed === null) failed = err;\n        }\n      }\n    }\n    const n = Math.max(1, Math.min(limit, items.length));\n    await Promise.all(Array.from({ length: n }, worker));\n    if (failed !== null) throw failed;\n    return results;\n  }\n\n  const ap",
"i = {\n    headerMap, parseAddress, displayName, decodeEntities,\n    accountFromTitle, accountFromAriaLabel, accountIndexFromPath,\n    relativeDate, fullDate, agoText, mapPool,\n  };\n\n  ns.util = api;\n  if (typeof module === 'object' && module.exports) module.exports = api;\n})();\n</script>\n<script>\n// src/lib/notes-logic.js\n// ─────────────────────────────────────────────────────────────────────\n// Notes logic (pure)\n//\n// A note is an email that was never sent: a message placed straight into\n// the user's own mailbox with messages.insert, carrying the Notes label\n// and nothing else - not INBOX, not UNREAD - so it stays out of the way\n// until looked for, and Gmail's own search finds it.\n//\n// Gmail messages cannot be changed once stored, so saving a note inserts\n// a new message and moves the previous one to Trash. Each note carries a\n// stable id in an X-Gkb-Note header, which is how its versions are tied\n// together and - just as important - how the background worker tells a\n// note ",
"from real mail: it will only insert messages that carry the header\n// and only trash messages that already do.\n//\n// Loaded by the content scripts, the service worker and Node's tests.\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n  const util = (typeof module === 'object' && module.exports) ? require('./util.js') : ns.util;\n\n  const NOTE_HEADER = 'X-Gkb-Note';\n  const DEFAULT_LABEL = '_Notes';\n  // .invalid is reserved and can never be delivered to, so nothing can\n  // ever arrive from or go to this address.\n  const NOTE_SENDER = '\"Notes\" <notes@notes.invalid>';\n\n  // Generous for typed notes, and keeps one save comfortably inside what\n  // the non-upload insert endpoint and a runtime message will carry.\n  const MAX_BODY = 100000;\n  const MAX_TITLE = 300;\n\n  // Labels a note may never be inserted with. A note in the Inbox, or\n  // dressed up as sent or draft mail, is no lo",
"nger out of the way - and\n  // nothing here should ever be able to put mail into Spam or Trash.\n  const FORBIDDEN_INSERT_LABELS = new Set(['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD']);\n\n  // ── Ids ──────────────────────────────────────────────────────────────\n\n  const ID_RE = /^[a-z0-9]{12,40}$/;\n\n  function newNoteId(rand = n => crypto.getRandomValues(new Uint8Array(n))) {\n    return Array.from(rand(12), b => b.toString(36).padStart(2, '0').slice(-2)).join('').slice(0, 20);\n  }\n\n  // ── Encoding ─────────────────────────────────────────────────────────\n\n  function bytesToBinary(bytes) {\n    let out = '';\n    for (let i = 0; i < bytes.length; i += 0x8000) {\n      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));\n    }\n    return out;\n  }\n\n  function binaryToBytes(bin) {\n    const out = new Uint8Array(bin.length);\n    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;\n    return out;\n  }\n\n  const utf8ToBase64 = s => btoa(bytesToBinary(",
"new TextEncoder().encode(s)));\n\n  function base64UrlEncode(binary) {\n    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');\n  }\n\n  function base64UrlDecode(s) {\n    const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\\s+/g, '');\n    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));\n  }\n\n  // Text in whatever charset the part declared. An unknown or mislabelled\n  // charset falls back to UTF-8 rather than failing the whole note.\n  function decodeBytes(bytes, charset) {\n    try {\n      return new TextDecoder(charset || 'utf-8').decode(bytes);\n    } catch {\n      return new TextDecoder('utf-8').decode(bytes);\n    }\n  }\n\n  // RFC 2047 encoded words, for a subject that is not plain ASCII. At 39\n  // bytes a word, even the first line (\"Subject: \" and one word) stays\n  // under 78 characters, and no character is split across two words,\n  // which some readers would show as two broken halves.\n  function encodeHeaderText(text) {\n    c",
"onst s = String(text || '');\n    if (/^[\\x20-\\x7e]*$/.test(s)) return s;\n    const words = [];\n    let chunk = '';\n    let bytes = 0;\n    for (const ch of s) {\n      const n = new TextEncoder().encode(ch).length;\n      if (bytes + n > 39 && chunk) {\n        words.push(chunk);\n        chunk = '';\n        bytes = 0;\n      }\n      chunk += ch;\n      bytes += n;\n    }\n    if (chunk) words.push(chunk);\n    return words.map(w => `=?UTF-8?B?${utf8ToBase64(w)}?=`).join('\\r\\n ');\n  }\n\n  // The inverse, for the preview's fake Gmail and for the tests. (The real\n  // API hands headers back already decoded.)\n  function decodeHeaderText(value) {\n    return String(value || '')\n      .replace(/(=\\?[^?]+\\?[BbQq]\\?[^?]*\\?=)\\s+(?==\\?)/g, '$1')\n      .replace(/=\\?([^?]+)\\?([BbQq])\\?([^?]*)\\?=/g, (_, charset, enc, text) => {\n        const bin = enc.toUpperCase() === 'B'\n          ? atob(text)\n          : text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)",
"));\n        return decodeBytes(binaryToBytes(bin), charset);\n      });\n  }\n\n  // Header values never carry line breaks of their own: one in a title\n  // would end the header early and start another of the user's choosing.\n  const oneLine = s => String(s || '').replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s{2,}/g, ' ').trim();\n\n  // ── Building a note ──────────────────────────────────────────────────\n\n  // A note with no title is filed under its first line, as most notes\n  // apps do, so it still reads as something in Gmail's message list.\n  function titleFor(title, body) {\n    const t = oneLine(title).slice(0, MAX_TITLE);\n    if (t) return t;\n    const first = String(body || '').split('\\n').map(l => l.trim()).find(Boolean) || '';\n    return oneLine(first).slice(0, 80);\n  }\n\n  function wrap76(s) {\n    return s.replace(/.{1,76}/g, '$&\\r\\n').trimEnd();\n  }\n\n  const textPart = (type, s) => [\n    `Content-Type: ${type}; charset=UTF-8`,\n    'Content-Transfer-Encoding: base64',\n    '',\n    wrap76(ut",
"f8ToBase64(s.replace(/\\n/g, '\\r\\n'))),\n  ];\n\n  // `body` is the plain text. With `html` as well, the note is a\n  // multipart/alternative message: Gmail shows the HTML, and its previews\n  // and plain-text readers get the text.\n  function buildNoteRaw({ noteId, title, body, html, account, date = new Date() }) {\n    if (!ID_RE.test(String(noteId || ''))) throw new Error('Invalid note id');\n    const me = oneLine(account);\n    const text = String(body || '').replace(/\\r\\n?/g, '\\n').slice(0, MAX_BODY);\n    const head = [\n      // Not from the account's own address: Gmail files anything from you\n      // under Sent, whatever labels it was given. Replies still reach you.\n      `From: ${NOTE_SENDER}`,\n      `To: ${me}`,\n      `Reply-To: ${me}`,\n      `Subject: ${encodeHeaderText(titleFor(title, text) || 'Untitled note')}`,\n      `Date: ${date.toUTCString()}`,\n      `Message-ID: <${noteId}.${date.getTime()}@notes.invalid>`,\n      `${NOTE_HEADER}: ${noteId}`,\n      'MIME-Version: 1.0',\n    ];\n",
"    let lines;\n    if (html) {\n      // Base64 never contains \"-\", so this boundary cannot occur in a part.\n      const boundary = `gkb-${noteId}-${date.getTime()}`;\n      lines = [\n        ...head,\n        `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,\n        '',\n        `--${boundary}`,\n        ...textPart('text/plain', text),\n        `--${boundary}`,\n        ...textPart('text/html', String(html)),\n        `--${boundary}--`,\n        '',\n      ];\n    } else {\n      lines = [...head, ...textPart('text/plain', text), ''];\n    }\n    return base64UrlEncode(lines.join('\\r\\n'));\n  }\n\n  // ── What the worker allows ───────────────────────────────────────────\n\n  function headerBlock(binary) {\n    const end = binary.search(/\\r?\\n\\r?\\n/);\n    return end < 0 ? binary : binary.slice(0, end);\n  }\n\n  // The note id a raw message carries, or '' if it is not a note.\n  function noteIdOfRaw(raw) {\n    let bin;\n    try { bin = base64UrlDecode(raw); } catch { return ''; }\n    const m = h",
"eaderBlock(bin).match(new RegExp(`^${NOTE_HEADER}:[ \\\\t]*([^\\\\r\\\\n]*)$`, 'mi'));\n    const id = m ? m[1].trim() : '';\n    return ID_RE.test(id) ? id : '';\n  }\n\n  // The body of a messages.insert the worker will pass on: a note, filed\n  // under user labels only, and nothing else in the request.\n  function isNoteInsert(body) {\n    if (!body || typeof body !== 'object' || typeof body.raw !== 'string') return false;\n    const extra = Object.keys(body).filter(k => k !== 'raw' && k !== 'labelIds');\n    if (extra.length) return false;\n    const labels = body.labelIds === undefined ? [] : body.labelIds;\n    if (!Array.isArray(labels)) return false;\n    if (labels.some(id => FORBIDDEN_INSERT_LABELS.has(String(id).toUpperCase()))) return false;\n    return !!noteIdOfRaw(body.raw);\n  }\n\n  // ── Reading notes back ───────────────────────────────────────────────\n\n  function headerOf(message, name) {\n    return util.headerMap(message)[name.toLowerCase()] || '';\n  }\n\n  function charsetOf(part) {\n    ",
"const ct = (part.headers || []).find(h => h.name.toLowerCase() === 'content-type');\n    const m = ct && /charset=\"?([^\";\\s]+)\"?/i.exec(ct.value);\n    return m ? m[1] : 'utf-8';\n  }\n\n  function partText(part) {\n    if (!part || !part.body || !part.body.data) return '';\n    return decodeBytes(binaryToBytes(base64UrlDecode(part.body.data)), charsetOf(part));\n  }\n\n  // A rough text rendering of an HTML email, for notes that arrived as\n  // mail (say, sent to yourself from a phone). Done with patterns rather\n  // than the DOM: parsing HTML into a document is a Trusted Types sink on\n  // Gmail's page, and only the words are wanted anyway.\n  function htmlToText(html) {\n    const text = String(html || '')\n      .replace(/<(script|style|head|title)\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>/gi, '')\n      .replace(/<br\\s*\\/?>/gi, '\\n')\n      .replace(/<li\\b[^>]*>/gi, '\\n• ')\n      .replace(/<\\/(p|div|ul|ol|tr|h[1-6]|blockquote|pre|table)\\s*>/gi, '\\n')\n      .replace(/<[^>]+>/g, '');\n    return util.decodeEntities",
"(text)\n      .replace(/\\u00a0/g, ' ')\n      .replace(/[ \\t]+\\n/g, '\\n')\n      .replace(/\\n{3,}/g, '\\n\\n')\n      .trim();\n  }\n\n  function textParts(payload) {\n    const plain = [];\n    const html = [];\n    (function walk(p) {\n      if (!p) return;\n      const type = String(p.mimeType || '').toLowerCase();\n      if (type === 'text/plain') plain.push(p);\n      else if (type === 'text/html') html.push(p);\n      (p.parts || []).forEach(walk);\n    })(payload);\n    return { plain, html };\n  }\n\n  // Prefers a text/plain part anywhere in the tree, then HTML.\n  function extractText(payload) {\n    const { plain, html } = textParts(payload);\n    if (plain.length) return plain.map(partText).join('\\n').replace(/\\r\\n?/g, '\\n').replace(/\\n+$/, '');\n    if (html.length) return htmlToText(html.map(partText).join('\\n'));\n    return '';\n  }\n\n  // Both renderings, decoded, for the formatted reader: the HTML is the\n  // record, the plain text the fallback for mail that has no HTML.\n  function messageParts(p",
"ayload) {\n    const { plain, html } = textParts(payload);\n    return {\n      plain: plain.map(partText).join('\\n').replace(/\\r\\n?/g, '\\n').replace(/\\n+$/, ''),\n      html: html.map(partText).join('\\n'),\n    };\n  }\n\n  // One note from a messages.get. With format=metadata there is no body\n  // (body stays null); with format=full there is.\n  function noteFromMessage(msg) {\n    const noteId = headerOf(msg, NOTE_HEADER).trim();\n    const own = ID_RE.test(noteId);\n    const full = !!(msg.payload && (msg.payload.body || msg.payload.parts));\n    return {\n      messageId: msg.id,\n      threadId: msg.threadId || '',\n      noteId: own ? noteId : '',\n      own,\n      key: own ? `n:${noteId}` : `m:${msg.id}`,\n      title: oneLine(headerOf(msg, 'Subject')) || 'Untitled note',\n      updated: Number(msg.internalDate) || Date.parse(headerOf(msg, 'Date')) || 0,\n      snippet: util.decodeEntities(msg.snippet || ''),\n      body: full ? extractText(msg.payload) : null,\n      parts: full ? messageParts(msg.",
"payload) : null,\n      labelIds: msg.labelIds || [],\n    };\n  }\n\n  // Two live versions of one note mean a save inserted the new one but\n  // could not trash the old (offline, closed tab), or two computers saved\n  // at once. The newest wins; the rest are reported so they can be\n  // tidied into Trash, where they stay recoverable for thirty days.\n  function dedupeNotes(notes) {\n    const live = [];\n    const stale = [];\n    const best = new Map();\n    for (const n of notes) {\n      const cur = best.get(n.key);\n      if (!cur) { best.set(n.key, n); continue; }\n      if (n.updated > cur.updated) { stale.push(cur); best.set(n.key, n); }\n      else stale.push(n);\n    }\n    for (const n of notes) if (best.get(n.key) === n) live.push(n);\n    live.sort((a, b) => b.updated - a.updated);\n    return { live, stale };\n  }\n\n  // ── Folders ──────────────────────────────────────────────────────────\n  //\n  // A folder is a Gmail label under the notes label: \"_Notes/Work\",\n  // \"_Notes/Work/Clients\". ",
"Every note carries the notes label itself, plus\n  // the label of at most one folder - so \"All notes\" is one label, and the\n  // folders show up nested under _Notes in Gmail's own label list.\n\n  const FOLDER_NAME_MAX = 60;\n\n  // The folders under `root`, in tree order: each parent followed by its\n  // children, alphabetically, with its depth. A label whose parent label\n  // is missing (made by hand in Gmail) still appears, at its own depth.\n  function folderTree(labels, root) {\n    const prefix = `${root}/`;\n    const list = (labels || [])\n      .filter(l => l && typeof l.name === 'string' && l.name.startsWith(prefix) && l.name.length > prefix.length)\n      .map(l => {\n        const path = l.name.slice(prefix.length);\n        const parts = path.split('/');\n        return { id: l.id, name: l.name, path, title: parts[parts.length - 1], depth: parts.length - 1, parentPath: parts.slice(0, -1).join('/') };\n      });\n    // Sorting by path segment by segment keeps every child under its paren",
"t.\n    const key = f => f.path.split('/').map(p => p.toLowerCase());\n    list.sort((a, b) => {\n      const x = key(a);\n      const y = key(b);\n      for (let i = 0; i < Math.min(x.length, y.length); i++) {\n        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;\n      }\n      return x.length - y.length;\n    });\n    return list;\n  }\n\n  // The folder a note is in, from its labels; '' for none. Two folder\n  // labels (applied by hand) resolve to the first in tree order.\n  function folderOf(labelIds, folders) {\n    const have = new Set(labelIds || []);\n    const f = (folders || []).find(x => have.has(x.id));\n    return f ? f.id : '';\n  }\n\n  // Moving a note: keep (or restore) the notes label, add the target's,\n  // drop every other folder's.\n  function moveFolderDiff(rootId, folders, targetId) {\n    const add = [rootId];\n    if (targetId) add.push(targetId);\n    const remove = (folders || []).map(f => f.id).filter(id => id !== targetId);\n    return { addLabelIds: add, removeLabelIds: remove",
" };\n  }\n\n  function validateFolderTitle(title, siblings = []) {\n    const t = String(title || '').trim();\n    if (!t) return 'Give the folder a name.';\n    if (t.includes('/')) return 'A folder name cannot contain “/”. Make a subfolder instead.';\n    if (t.length > FOLDER_NAME_MAX) return `Keep folder names under ${FOLDER_NAME_MAX} characters.`;\n    if (siblings.some(s => s.toLowerCase() === t.toLowerCase())) return `There is already a folder called “${t}” here.`;\n    return '';\n  }\n\n  // Renaming a folder renames its label and every label below it, since\n  // Gmail's API renames only the one label it is given.\n  function renamePlan(folder, newTitle, folders) {\n    const parent = folder.name.slice(0, folder.name.length - folder.title.length);\n    const newName = `${parent}${String(newTitle).trim()}`;\n    return (folders || [])\n      .filter(f => f.name === folder.name || f.name.startsWith(`${folder.name}/`))\n      .map(f => ({ id: f.id, name: newName + f.name.slice(folder.name.length) ",
"}));\n  }\n\n  // Whether the worker may delete a label: a folder under the notes label\n  // with no notes in it and no folders under it. `liveMessages` is what a\n  // messages.list on the label found - not the label's own count, which\n  // also counts old versions waiting in Trash and would keep an emptied\n  // folder undeletable for a month.\n  function isDeletableFolder(label, root, allLabels, liveMessages) {\n    if (!label || typeof label.name !== 'string' || !root) return false;\n    if (!label.name.startsWith(`${root}/`) || label.name.length <= root.length + 1) return false;\n    if (liveMessages !== 0) return false;\n    return !(allLabels || []).some(l => l && typeof l.name === 'string' && l.name.startsWith(`${label.name}/`));\n  }\n\n  const api = {\n    NOTE_HEADER, NOTE_SENDER, DEFAULT_LABEL, MAX_BODY, MAX_TITLE, FORBIDDEN_INSERT_LABELS, FOLDER_NAME_MAX,\n    folderTree, folderOf, moveFolderDiff, validateFolderTitle, renamePlan, isDeletableFolder,\n    newNoteId, encodeHeaderText, decode",
"HeaderText, base64UrlEncode, base64UrlDecode,\n    titleFor, buildNoteRaw, noteIdOfRaw, isNoteInsert,\n    htmlToText, extractText, messageParts, noteFromMessage, dedupeNotes,\n  };\n\n  ns.notesLogic = api;\n  if (typeof module === 'object' && module.exports) module.exports = api;\n})();\n</script>\n<script>\n// src/lib/note-format.js\n// ─────────────────────────────────────────────────────────────────────\n// Note formatting (pure)\n//\n// A formatted note is a list of blocks - paragraphs, three heading\n// sizes, bulleted, numbered and check lists nested up to three deep -\n// each holding runs of text that may be bold, italic, struck through or\n// a link. That is the whole model; nothing outside it survives a save.\n//\n// It is stored in the note's message twice. The HTML part is the real\n// record: Gmail shows it (on the phone too), and this file reads it back\n// with a small tokenizer of its own rather than the browser's HTML\n// parser, which is a Trusted Types sink on Gmail's page and would acc",
"ept\n// far more than the model can hold. The plain-text part is a readable\n// rendering - bullets, ☐ and ☑ - for Gmail's previews and for any mail\n// client that shows text.\n//\n// Mail that arrived as a note (written in Gmail, say) goes through the\n// same reader, so its bold, lists and links come across where they fit\n// the model and everything else is reduced to text.\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n  const util = (typeof module === 'object' && module.exports) ? require('./util.js') : ns.util;\n\n  const TYPES = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'check']);\n  const LISTS = new Set(['ul', 'ol', 'check']);\n  const MAX_LEVEL = 3;\n  const BOX = '☐';     // ☐\n  const TICKED = '☑';  // ☑\n  const BULLET = '•';  // •\n\n  // ── The model ────────────────────────────────────────────────────────\n\n  function block(type = 'p', runs = [], { level = 0, checked = fal",
"se } = {}) {\n    return { type, level: LISTS.has(type) ? level : 0, checked: type === 'check' ? !!checked : false, runs };\n  }\n\n  function emptyDoc() {\n    return [block('p')];\n  }\n\n  const sameMarks = (a, b) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.s === !!b.s && (a.href || '') === (b.href || '');\n\n  function cleanRun(r) {\n    const out = { text: String(r.text || '') };\n    if (r.b) out.b = true;\n    if (r.i) out.i = true;\n    if (r.s) out.s = true;\n    const href = r.href ? safeHref(r.href) : '';\n    if (href) out.href = href;\n    return out;\n  }\n\n  // Drops empty runs and joins neighbours that look the same, so two\n  // documents that read alike compare alike.\n  function normaliseRuns(runs) {\n    const out = [];\n    for (const r of runs || []) {\n      if (!r || !r.text) continue;\n      const last = out[out.length - 1];\n      if (last && sameMarks(last, r)) last.text += r.text;\n      else out.push(cleanRun(r));\n    }\n    return out;\n  }\n\n  // Unknown types become paragraphs; a li",
"st item may sit at most one level\n  // deeper than the list item before it, which is what keeps the HTML a\n  // properly nested list and the editor's indents meaningful.\n  function normaliseDoc(doc) {\n    const out = [];\n    let prevLevel = -1;\n    for (const b of Array.isArray(doc) ? doc : []) {\n      if (!b || typeof b !== 'object') continue;\n      const type = TYPES.has(b.type) ? b.type : 'p';\n      let level = 0;\n      if (LISTS.has(type)) {\n        level = Math.max(0, Math.min(MAX_LEVEL, Number(b.level) || 0, prevLevel + 1));\n        prevLevel = level;\n      } else {\n        prevLevel = -1;\n      }\n      out.push(block(type, normaliseRuns(b.runs), { level, checked: b.checked }));\n    }\n    return out.length ? out : emptyDoc();\n  }\n\n  const blockText = b => b.runs.map(r => r.text).join('');\n\n  function docText(doc) {\n    return doc.map(blockText).join('\\n');\n  }\n\n  function isEmpty(doc) {\n    return doc.every(b => !blockText(b).trim());\n  }\n\n  // ── Links ──────────────────────────",
"──────────────────────────────────\n\n  // Web and mail links only. \"example.com/x\" gets https:// in front, a\n  // bare address gets mailto:, and anything else - javascript:, data:,\n  // file: - is not a link at all.\n  function safeHref(url) {\n    const s = String(url || '').trim();\n    if (!s || /[\\s<>\"]/.test(s)) return '';\n    if (/^mailto:/i.test(s)) return /^mailto:[^@\\s]+@[^@\\s]+$/i.test(s) ? s : '';\n    if (/^[^\\s@/:]+@[^\\s@/:]+\\.[^\\s@/:]+$/.test(s)) return `mailto:${s}`;\n    let candidate = s;\n    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {\n      if (!/^[\\w-]+(\\.[\\w-]+)+(:\\d+)?([/?#]|$)/.test(s)) return '';\n      candidate = `https://${s}`;\n    }\n    try {\n      const u = new URL(candidate);\n      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';\n    } catch {\n      return '';\n    }\n  }\n\n  // ── HTML out ─────────────────────────────────────────────────────────\n\n  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').re",
"place(/\"/g, '&quot;');\n\n  // Spaces HTML would collapse - doubled, at either end of a block, or\n  // meeting across a tag - are written as &nbsp; so they come back as\n  // typed.\n  function runsHtml(runs) {\n    let out = '';\n    let prevSpace = false;\n    for (let i = 0; i < runs.length;) {\n      const href = runs[i].href || '';\n      let j = i;\n      let inner = '';\n      while (j < runs.length && (runs[j].href || '') === href) {\n        const raw = runs[j].text;\n        let t = escHtml(raw).replace(/ {2}/g, ' &nbsp;');\n        if (prevSpace && t[0] === ' ') t = `&nbsp;${t.slice(1)}`;\n        prevSpace = / $/.test(raw);\n        if (runs[j].s) t = `<s>${t}</s>`;\n        if (runs[j].i) t = `<i>${t}</i>`;\n        if (runs[j].b) t = `<b>${t}</b>`;\n        inner += t;\n        j++;\n      }\n      out += href ? `<a href=\"${escHtml(href)}\">${inner}</a>` : inner;\n      i = j;\n    }\n    // Edge spaces of the whole block, after the tags are in place.\n    return out.replace(/^((?:<[^>]+>)*) /, '$1",
"&nbsp;').replace(/ ((?:<\\/[^>]+>)*)$/, '&nbsp;$1');\n  }\n\n  const STYLE = {\n    doc: 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f1f1f',\n    p: 'margin:0',\n    h1: 'margin:14px 0 4px;font-size:22px;line-height:1.3;font-weight:bold',\n    h2: 'margin:12px 0 2px;font-size:18px;line-height:1.3;font-weight:bold',\n    h3: 'margin:10px 0 2px;font-size:15px;line-height:1.3;font-weight:bold',\n    list: 'margin:0;padding-left:26px',\n    check: 'margin:0;padding-left:4px;list-style:none',\n    li: 'margin:1px 0',\n  };\n\n  function toHtml(docIn) {\n    const doc = normaliseDoc(docIn);\n    const stack = []; // open lists, one per level: { tag, check }\n    let out = `<div data-gkb-note=\"1\" style=\"${STYLE.doc}\">`;\n    const close = () => { out += `</li></${stack.pop().tag}>`; };\n\n    for (const b of doc) {\n      const inner = runsHtml(b.runs);\n      if (!LISTS.has(b.type)) {\n        while (stack.length) close();\n        out += `<${b.type} style=\"${STYLE[b.type]}\">${inn",
"er || '<br>'}</${b.type}>\\n`;\n        continue;\n      }\n      const tag = b.type === 'ol' ? 'ol' : 'ul';\n      const check = b.type === 'check';\n      while (stack.length > b.level + 1) close();\n      if (stack.length === b.level + 1) {\n        const top = stack[stack.length - 1];\n        if (top.tag !== tag || top.check !== check) close();\n        else out += '</li>';\n      }\n      if (stack.length === b.level) {\n        out += check ? `<ul data-check=\"1\" style=\"${STYLE.check}\">` : `<${tag} style=\"${STYLE.list}\">`;\n        stack.push({ tag, check });\n      }\n      const glyph = check ? `<span data-glyph=\"1\">${b.checked ? TICKED : BOX}&nbsp;</span>` : '';\n      out += `<li style=\"${STYLE.li}\"${check ? ` data-checked=\"${b.checked ? 1 : 0}\"` : ''}>${glyph}${inner || (check ? '' : '<br>')}`;\n    }\n    while (stack.length) close();\n    return `${out}</div>`;\n  }\n\n  // ── Plain text out ───────────────────────────────────────────────────\n\n  function runsPlain(runs) {\n    let out = '';\n    f",
"or (let i = 0; i < runs.length;) {\n      const href = runs[i].href || '';\n      let j = i;\n      let text = '';\n      while (j < runs.length && (runs[j].href || '') === href) text += runs[j++].text;\n      const bare = href.replace(/^mailto:/, '');\n      const same = s => s.trim().replace(/^(https?:\\/\\/|mailto:)/, '').replace(/\\/$/, '');\n      out += href && same(text) !== same(href) ? `${text} (${bare})` : text;\n      i = j;\n    }\n    return out;\n  }\n\n  function toPlain(docIn) {\n    const doc = normaliseDoc(docIn);\n    const counters = [0, 0, 0, 0];\n    return doc.map(b => {\n      const text = runsPlain(b.runs);\n      if (!LISTS.has(b.type)) {\n        counters.fill(0);\n        return text;\n      }\n      const pad = '  '.repeat(b.level);\n      for (let l = b.level + 1; l < counters.length; l++) counters[l] = 0;\n      if (b.type === 'ol') return `${pad}${++counters[b.level]}. ${text}`;\n      counters[b.level] = 0;\n      if (b.type === 'check') return `${pad}${b.checked ? TICKED : BOX} ${",
"text}`;\n      return `${pad}${BULLET} ${text}`;\n    }).join('\\n');\n  }\n\n  // ── Plain text in ────────────────────────────────────────────────────\n\n  // A plain note (from before formatting existed, or plain mail) becomes\n  // one block per line. Lines that already look like lists - \"- \", \"• \",\n  // \"1. \", \"☐ \" - become lists, indented two spaces a level.\n  function fromPlain(text) {\n    const lines = String(text || '').replace(/\\r\\n?/g, '\\n').split('\\n');\n    return normaliseDoc(lines.map(line => {\n      const m = /^( *)(?:([-*•])|(\\d{1,3})[.)]|([☐☑])) (.*)$/.exec(line);\n      if (!m) return block('p', [{ text: line }]);\n      const level = Math.floor(m[1].length / 2);\n      if (m[4]) return block('check', [{ text: m[5] }], { level, checked: m[4] === TICKED });\n      return block(m[3] ? 'ol' : 'ul', [{ text: m[5] }], { level });\n    }));\n  }\n\n  // ── HTML in ──────────────────────────────────────────────────────────\n\n  const TOKEN_RE = /<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<![^>]*",
">|<\\?[^>]*>|<(\\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\\s+[^\\s\"'>/=]+(?:\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s\"'=<>`]+))?)*)\\s*(\\/?)>|[^<]+|</g;\n  const ATTR_RE = /([^\\s\"'>/=]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?/g;\n  const SKIP = new Set(['script', 'style', 'head', 'title', 'template', 'svg', 'math', 'noscript', 'iframe', 'object', 'xml']);\n  const PARA = new Set(['p', 'div', 'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'main', 'aside',\n    'nav', 'table', 'tbody', 'thead', 'tfoot', 'center', 'dl', 'dt', 'dd', 'figure', 'figcaption',\n    'form', 'fieldset', 'address', 'hr', 'body', 'html', 'caption']);\n  // Tags that mark text, and the marks they stand for. span and font\n  // carry theirs in a style attribute, if at all.\n  const INLINE = {\n    b: ['b'], strong: ['b'], i: ['i'], em: ['i'], cite: ['i'], s: ['s'], strike: ['s'], del: ['s'], span: [], font: [],\n  };\n  const HEADINGS = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };\n\n  function attrsOf(s) {\n",
"    const out = {};\n    let m;\n    ATTR_RE.lastIndex = 0;\n    while ((m = ATTR_RE.exec(s || ''))) {\n      out[m[1].toLowerCase()] = util.decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '');\n    }\n    return out;\n  }\n\n  // Bold, italic and strike-through written as inline styles, as Outlook\n  // and pasted web text often do, count the same as the tags.\n  function styleMarks(style) {\n    const s = String(style || '').toLowerCase();\n    const marks = [];\n    if (/font-weight\\s*:\\s*(bold|bolder|[6-9]00)/.test(s)) marks.push('b');\n    if (/font-style\\s*:\\s*italic/.test(s)) marks.push('i');\n    if (/text-decoration(-line)?\\s*:[^;]*line-through/.test(s)) marks.push('s');\n    return marks;\n  }\n\n  // Whether a browser would show space below a <p>: it does unless its\n  // style says otherwise. Word and Outlook paragraphs (MsoNormal) are\n  // lines, and so are the editor's own and Google Docs'.\n  function paraGap(a) {\n    if (/\\bMso/.test(a.class || '')) return fals",
"e;\n    const style = String(a.style || '').toLowerCase();\n    const zero = v => /^-?0(\\.0+)?([a-z]+|%)?$/.test(v || '');\n    const bottom = /(?:^|;)\\s*margin-bottom\\s*:\\s*([^;!]+)/.exec(style);\n    if (bottom) return !zero(bottom[1].trim());\n    const all = /(?:^|;)\\s*margin\\s*:\\s*([^;!]+)/.exec(style);\n    if (all) {\n      const v = all[1].trim().split(/\\s+/);\n      return !zero(v.length >= 3 ? v[2] : v[0]);\n    }\n    return true;\n  }\n\n  function parseHtml(html) {\n    const blocks = [];\n    const lists = [];         // open lists: { type, liOpen }\n    const marks = { b: 0, i: 0, s: 0 };\n    const hrefs = [];\n    const inline = [];        // open inline tags: { name, marks } or { name, glyph: true }\n    let skip = 0;\n    let glyph = 0;\n    let cur = null;\n    let row = null;           // an open table row: { cells, th }\n    let pre = 0;              // inside <pre>: line breaks and spaces are text\n    let para = null;          // the open <p>: { gap }\n    let gap = false;          // a",
" <p> just closed with space below it\n    let ours = false;         // inside a note's own HTML, where paragraphs are lines\n\n    const level = () => Math.max(0, lists.length - 1);\n    const open = (type, extra) => {\n      // The space a browser shows after a paragraph is an empty line in a\n      // note - which has no space between paragraphs - except before a\n      // heading, which has its own.\n      if (gap) {\n        gap = false;\n        const last = blocks[blocks.length - 1];\n        if (last && !HEADINGS[type] && last.runs.some(r => /\\S/.test(r.text))) blocks.push(block('p'));\n      }\n      cur = block(type, [], extra);\n      blocks.push(cur);\n      return cur;\n    };\n    const end = () => { cur = null; };\n    // Where text lands when no block is open: inside a list item, a\n    // continuation of that item; otherwise a new paragraph.\n    const context = () => {\n      const top = lists[lists.length - 1];\n      if (top && top.liOpen) return open(top.type, { level: level(), checked: ",
"false });\n      return open('p');\n    };\n    const apply = (list, delta) => list.forEach(m => { marks[m] += delta; });\n\n    let m;\n    TOKEN_RE.lastIndex = 0;\n    while ((m = TOKEN_RE.exec(String(html || '')))) {\n      const [whole, closing, rawName, rawAttrs, selfClosing] = m;\n      if (rawName === undefined) {\n        if (whole[0] === '<' && whole.length > 1) continue; // comment, doctype, CDATA\n        if (skip) continue;\n        if (glyph) {\n          // Word's list marker (\"·\", \"1.\", \"a)\"): not text, but it says\n          // whether the list is bulleted or numbered.\n          if (cur && cur.wordList) cur.marker += util.decodeEntities(whole);\n          continue;\n        }\n        if (pre) {\n          // Each line of preformatted text is a line of the note, its\n          // spaces kept (as &nbsp;, which the tidying below leaves alone).\n          let raw = util.decodeEntities(whole).replace(/\\r\\n?/g, '\\n');\n          if (pre.fresh) raw = raw.replace(/^\\n/, '');\n          pre.fresh = ",
"false;\n          raw.split('\\n').forEach((line, k) => {\n            if (k) {\n              end();\n              open('p').preLine = true;\n            }\n            if (!line) return;\n            if (!cur) context();\n            cur.runs.push({\n              text: line.replace(/\\t/g, '    ').replace(/ /g, '\\u00a0'),\n              b: marks.b > 0, i: marks.i > 0, s: marks.s > 0,\n              href: hrefs.length ? hrefs[hrefs.length - 1] : '',\n            });\n          });\n          continue;\n        }\n        const text = util.decodeEntities(whole === '<' ? '<' : whole).replace(/[ \\t\\r\\n\\f]+/g, ' ');\n        if (!cur) {\n          // Only HTML's own whitespace is nothing; an &nbsp; is a space someone typed.\n          if (!/[^ \\t\\r\\n\\f]/.test(text)) continue;\n          context();\n        }\n        cur.runs.push({\n          text,\n          b: marks.b > 0, i: marks.i > 0, s: marks.s > 0,\n          href: hrefs.length ? hrefs[hrefs.length - 1] : '',\n        });\n        continue;\n      }\n\n      ",
"const name = rawName.toLowerCase();\n      const isClose = closing === '/';\n      if (SKIP.has(name)) {\n        if (!selfClosing) skip = Math.max(0, skip + (isClose ? -1 : 1));\n        continue;\n      }\n      if (skip) continue;\n      const a = isClose ? {} : attrsOf(rawAttrs);\n\n      if (name === 'br') {\n        if (cur) end();\n        else { context(); end(); }\n        continue;\n      }\n      if (HEADINGS[name]) {\n        end();\n        if (!isClose) open(HEADINGS[name]);\n        continue;\n      }\n      if (name === 'ul' || name === 'ol') {\n        end();\n        if (isClose) lists.pop();\n        else lists.push({ type: a['data-check'] ? 'check' : name, liOpen: false });\n        continue;\n      }\n      if (name === 'li') {\n        end();\n        if (!lists.length) lists.push({ type: 'ul', liOpen: false, implied: true });\n        const top = lists[lists.length - 1];\n        top.liOpen = !isClose;\n        if (!isClose) {\n          open(top.type, { level: level(), checked: a['data-checke",
"d'] === '1' });\n          // One of ours: its box is in the attribute, and a ☐ at the start\n          // of its text is text.\n          if (a['data-checked'] !== undefined) cur.ours = true;\n          // A checklist item marked up for screen readers (Google Docs).\n          else if (a['aria-checked'] === 'true' || a['aria-checked'] === 'false') {\n            cur.type = 'check';\n            cur.checked = a['aria-checked'] === 'true';\n            cur.ours = true;\n          }\n        }\n        else if (top.implied) lists.pop();\n        continue;\n      }\n      // A table row is one line, its cells separated by \" | \": there are\n      // no tables in a note, and this keeps a pasted row readable.\n      // A heading cell is bold, as a browser shows it.\n      const headCell = on => {\n        if (!row || row.th === on) return;\n        row.th = on;\n        marks.b += on ? 1 : -1;\n      };\n      if (name === 'tr') {\n        end();\n        headCell(false);\n        row = isClose ? null : { cells: 0, ",
"th: false };\n        continue;\n      }\n      if (name === 'td' || name === 'th') {\n        if (!row) { end(); continue; }\n        headCell(false);\n        if (!isClose && !selfClosing) {\n          if (row.cells > 0) {\n            if (!cur) context();\n            cur.runs.push({ text: ' | ', b: false, i: false, s: false, href: '' });\n          }\n          row.cells++;\n          headCell(name === 'th');\n        }\n        continue;\n      }\n      if (name === 'pre') {\n        end();\n        if (isClose) {\n          // The line break before </pre> ends the last line; it is not one more.\n          const last = blocks[blocks.length - 1];\n          if (last && last.preLine && !last.runs.length) blocks.pop();\n          pre = 0;\n        } else if (!selfClosing) {\n          pre = { fresh: true };\n        }\n        continue;\n      }\n      // A ticked or empty box at the start of a line - a task list on a\n      // web page (GitHub) - makes it a checklist item.\n      if (name === 'input' && String(a",
".type || '').toLowerCase() === 'checkbox') {\n        if (!cur) context();\n        if (!cur.runs.some(r => /\\S/.test(r.text))) {\n          cur.type = 'check';\n          cur.checked = 'checked' in a;\n          cur.ours = true;\n        }\n        continue;\n      }\n      if (name === 'div' && a['data-gkb-note'] !== undefined) ours = true;\n      // A block copied out of a note's editor keeps its kind.\n      if (name === 'div' && !isClose && TYPES.has(a['data-type'])) {\n        end();\n        open(a['data-type'], { level: Number(a['data-level']) || 0, checked: a['data-checked'] === '1' });\n        cur.ours = true;\n        continue;\n      }\n      // Word writes a list as paragraphs styled \"mso-list: l0 level1\".\n      if (name === 'p' && !isClose) {\n        const wl = /mso-list\\s*:\\s*l\\d+\\s+level(\\d)/i.exec(a.style || '');\n        if (wl) {\n          end();\n          open('ul', { level: Number(wl[1]) - 1 });\n          cur.wordList = true;\n          cur.marker = '';\n          continue;\n        }",
"\n      }\n      if (name === 'p') {\n        if (para && para.gap) gap = true;\n        para = null;\n        if (!isClose) {\n          const top = lists[lists.length - 1];\n          para = { gap: !ours && !row && !(top && top.liOpen) && paraGap(a) };\n        }\n      }\n      if (PARA.has(name)) {\n        // Inside a table cell, or straight inside a list item that has no\n        // text yet (Google Docs wraps every item in a <p>), the line goes on.\n        if (row) continue;\n        if (cur && !cur.runs.length && !isClose) continue;\n        end();\n        continue;\n      }\n      if (name === 'a') {\n        if (isClose) hrefs.pop();\n        else if (!selfClosing) hrefs.push(safeHref(a.href));\n        continue;\n      }\n      if (INLINE[name]) {\n        if (selfClosing) continue;\n        if (isClose) {\n          // The innermost open tag of that name - mail is not always tidily nested.\n          for (let k = inline.length - 1; k >= 0; k--) {\n            if (inline[k].name !== name) continue;\n ",
"           const [got] = inline.splice(k, 1);\n            if (got.glyph) glyph = Math.max(0, glyph - 1);\n            else apply(got.marks, -1);\n            break;\n          }\n          continue;\n        }\n        const style = String(a.style || '').toLowerCase();\n        if (a['data-glyph'] || /mso-list\\s*:\\s*ignore/.test(style)) {\n          inline.push({ name, glyph: true });\n          glyph++;\n          continue;\n        }\n        let got = [...INLINE[name], ...styleMarks(style)];\n        // Google Docs wraps a whole paste in <b style=\"font-weight:normal\">.\n        if (/font-weight\\s*:\\s*(normal|lighter|[1-5]00)\\b/.test(style)) got = got.filter(x => x !== 'b');\n        if (/font-style\\s*:\\s*normal/.test(style)) got = got.filter(x => x !== 'i');\n        got = [...new Set(got)];\n        inline.push({ name, marks: got });\n        apply(got, 1);\n        continue;\n      }\n      // Anything else (img, u, sup, code, …): its text is kept, the tag is not.\n    }\n    for (const k of Object.keys",
"(marks)) marks[k] = Math.max(0, marks[k]);\n\n    // Tidy each block: collapse the whitespace HTML would collapse, then\n    // turn the &nbsp;s that held deliberate spaces back into spaces.\n    for (const b of blocks) {\n      const runs = b.runs;\n      if (runs.length) {\n        runs[0].text = runs[0].text.replace(/^ +/, '');\n        runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/ +$/, '');\n        for (let i = 1; i < runs.length; i++) {\n          if (/ $/.test(runs[i - 1].text)) runs[i].text = runs[i].text.replace(/^ +/, '');\n        }\n        for (const r of runs) r.text = r.text.replace(/ /g, ' ');\n      }\n      if (b.wordList && /^\\s*(\\d+|[a-z]|[ivxlc]+)[.)]\\s*$/i.test(b.marker || '')) b.type = 'ol';\n      // A check box drawn as text (mail from elsewhere, or a list whose\n      // markers were lost) still counts as a check box.\n      if (LISTS.has(b.type) && runs.length && !b.ours) {\n        const g = /^([☐☑]) ?/.exec(runs[0].text);\n        if (g) {\n          runs[0",
"].text = runs[0].text.slice(g[0].length);\n          if (b.type === 'ul') b.type = 'check';\n          if (b.type === 'check') b.checked = g[1] === TICKED;\n        }\n      }\n    }\n    return normaliseDoc(blocks);\n  }\n\n  // ── Markdown in ──────────────────────────────────────────────────────\n  //\n  // Text copied from a chat assistant, a README or a Markdown editor\n  // arrives as plain text full of **stars** and \"- \" lines. The common\n  // part of Markdown becomes formatting; the rest stays as typed.\n\n  function mdInline(src, marks = {}) {\n    const out = [];\n    const s = String(src || '');\n    let buf = '';\n    const flush = () => {\n      if (buf) out.push({ text: buf, ...marks });\n      buf = '';\n    };\n    const nested = (inner, extra) => {\n      flush();\n      out.push(...mdInline(inner, { ...marks, ...extra }));\n    };\n    for (let i = 0; i < s.length;) {\n      const rest = s.slice(i);\n      const prev = i ? s[i - 1] : '';\n      let m;\n      if ((m = /^\\\\([\\\\`*_{}[\\]()#+\\-.!~|>])/",
".exec(rest))) { buf += m[1]; i += m[0].length; continue; }\n      if ((m = /^`([^`\\n]+)`/.exec(rest))) { buf += m[1]; i += m[0].length; continue; }\n      if ((m = /^\\[([^\\]\\n]+)\\]\\(\\s*<?([^)\\s>]+)>?(?:\\s+\"[^\"]*\")?\\s*\\)/.exec(rest))) {\n        const href = safeHref(m[2]);\n        nested(m[1], href ? { href } : {});\n        i += m[0].length;\n        continue;\n      }\n      if ((m = /^<((?:https?:\\/\\/|mailto:)[^>\\s]+)>/.exec(rest))) {\n        flush();\n        const href = safeHref(m[1]);\n        out.push({ text: m[1].replace(/^mailto:/, ''), ...marks, ...(href ? { href } : {}) });\n        i += m[0].length;\n        continue;\n      }\n      if ((m = /^(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\1/.exec(rest)) && !(m[1] === '__' && /[\\p{L}\\p{N}]/u.test(prev))) {\n        nested(m[2], { b: true });\n        i += m[0].length;\n        continue;\n      }\n      if ((m = /^~~(?=\\S)([\\s\\S]*?\\S)~~/.exec(rest))) { nested(m[1], { s: true }); i += m[0].length; continue; }\n      if ((m = /^\\*(?=[^\\s*])([\\s\\S]*?[^\\s*])\\*(?!\\",
"*)/.exec(rest))) { nested(m[1], { i: true }); i += m[0].length; continue; }\n      if (!/[\\p{L}\\p{N}_]/u.test(prev) && (m = /^_(?=[^\\s_])([\\s\\S]*?[^\\s_])_(?![\\p{L}\\p{N}_])/u.exec(rest))) {\n        nested(m[1], { i: true });\n        i += m[0].length;\n        continue;\n      }\n      buf += s[i];\n      i++;\n    }\n    flush();\n    return out;\n  }\n\n  // One line of Markdown: what kind of block it is, its indent and text.\n  function mdLine(line) {\n    const [, pad, s] = /^( *)(.*)$/.exec(line);\n    const indent = pad.length;\n    let x;\n    if ((x = /^(#{1,6})\\s+(.*?)(?:\\s+#+)?\\s*$/.exec(s))) return { type: ['h1', 'h2', 'h3'][Math.min(2, x[1].length - 1)], text: x[2] };\n    if ((x = /^[-*+•]\\s+\\[([ xX])\\]\\s+(.*)$/.exec(s))) return { type: 'check', checked: x[1] !== ' ', text: x[2], indent };\n    if ((x = /^([☐☑])\\s+(.*)$/.exec(s))) return { type: 'check', checked: x[1] === TICKED, text: x[2], indent };\n    if ((x = /^[-*+•]\\s+(.*)$/.exec(s))) return { type: 'ul', text: x[1], indent };\n    if (",
"(x = /^\\d{1,3}[.)]\\s+(.*)$/.exec(s))) return { type: 'ol', text: x[1], indent };\n    if ((x = /^>\\s?(.*)$/.exec(s))) return { type: 'p', text: x[1].replace(/^(>\\s?)+/, '') };\n    if (/^\\|.*\\|\\s*$/.test(s)) return { type: 'p', cells: s.trim().slice(1, -1).split(/(?<!\\\\)\\|/).map(c => c.trim()) };\n    return { type: 'p', text: s };\n  }\n\n  const MD_RULE = /^\\s*([-*_])(\\s*\\1){2,}\\s*$/;\n  const MD_TABLE_RULE = /^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/;\n\n  function fromMarkdown(text) {\n    const lines = String(text || '').replace(/\\r\\n?/g, '\\n').replace(/\\t/g, '    ').split('\\n');\n    const out = [];\n    const indents = [];   // the indent of each open list level\n    let fence = false;\n    const last = () => out[out.length - 1];\n    for (const line of lines) {\n      if (/^\\s*(```|~~~)/.test(line)) { fence = !fence; continue; }\n      if (fence) { out.push(block('p', [{ text: line }])); continue; }\n      // The |---|---| line under a table's heading row makes that row bold.\n      if (",
"MD_TABLE_RULE.test(line)) {\n        const head = last();\n        if (head && head.table) for (const r of head.runs) if (!r.sep) r.b = true;\n        continue;\n      }\n      if (MD_RULE.test(line)) continue;\n      // One empty line is a gap; more are not, and nor is one beside a\n      // heading, which has space of its own.\n      if (!line.trim()) {\n        if (!out.length || !(fmtBlank(last()) || HEADINGS[last().type])) out.push(block('p'));\n        continue;\n      }\n      const l = mdLine(line.replace(/\\s+$/, ''));\n      if (HEADINGS[l.type] && out.length && fmtBlank(last())) out.pop();\n      if (LISTS.has(l.type)) {\n        // A blank line between two items of a list is not a gap in it.\n        if (out.length > 1 && fmtBlank(last()) && LISTS.has(out[out.length - 2].type)) out.pop();\n        while (indents.length && l.indent < indents[indents.length - 1]) indents.pop();\n        if (!indents.length || l.indent > indents[indents.length - 1]) indents.push(l.indent);\n        out.push(block",
"(l.type, mdInline(l.text), { level: indents.length - 1, checked: l.checked }));\n        continue;\n      }\n      indents.length = 0;\n      if (l.cells) {\n        const runs = [];\n        l.cells.forEach((c, k) => {\n          if (k) runs.push({ text: ' | ', sep: true });\n          runs.push(...mdInline(c.replace(/\\\\\\|/g, '|')));\n        });\n        const b = block('p', runs);\n        b.table = true;\n        out.push(b);\n        continue;\n      }\n      out.push(block(l.type, mdInline(l.text.trim())));\n    }\n    while (out.length > 1 && fmtBlank(last())) out.pop();\n    while (out.length > 1 && fmtBlank(out[0])) out.shift();\n    return normaliseDoc(out);\n  }\n\n  const fmtBlank = b => b.type === 'p' && !b.runs.some(r => r.text.trim());\n\n  // Whether plain text is worth reading as Markdown: a heading, list,\n  // quote, table or code line, or bold, struck, linked or code text.\n  function looksLikeMarkdown(text) {\n    const s = String(text || '');\n    return /^ {0,3}(#{1,6}\\s+\\S|[-*+•]\\s+\\S|[☐☑]",
"\\s+\\S|\\d{1,3}[.)]\\s+\\S|>\\s|```)/m.test(s) ||\n      /^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/m.test(s) ||\n      /\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__|~~[^~\\n]+~~|\\[[^\\]\\n]+\\]\\([^)\\s]+\\)|`[^`\\n]+`/.test(s);\n  }\n\n  // ── Pasting ──────────────────────────────────────────────────────────\n\n  // Whether a document has anything plain text would not: a heading, a\n  // list, a mark or a link.\n  function hasFormatting(doc) {\n    return doc.some(b => b.type !== 'p' || b.runs.some(r => r.b || r.i || r.s || r.href));\n  }\n\n  // What a paste becomes: the clipboard's HTML, read like mail; or, when\n  // that brings no formatting and the text is Markdown (from a chat\n  // assistant, say), the Markdown read as formatting. Empty lines at\n  // either end go. null means there is nothing to format: the text is\n  // pasted as it is.\n  function pasteDoc({ html, text } = {}) {\n    let doc = html && /\\S/.test(html) ? parseHtml(html) : null;\n    if (doc && isEmpty(doc)) doc = null;\n    if ((!doc || !hasFormattin",
"g(doc)) && looksLikeMarkdown(text)) doc = fromMarkdown(text);\n    if (!doc) return null;\n    let i = 0;\n    let j = doc.length;\n    while (i < j && fmtBlank(doc[i])) i++;\n    while (j > i && fmtBlank(doc[j - 1])) j--;\n    return i < j ? doc.slice(i, j) : null;\n  }\n\n  // The note's content from its message parts: HTML when there is any,\n  // the plain text otherwise.\n  function docFromParts({ plain, html } = {}) {\n    if (html && String(html).trim()) return parseHtml(html);\n    return fromPlain(plain || '');\n  }\n\n  const api = {\n    TYPES, LISTS, MAX_LEVEL,\n    block, emptyDoc, normaliseRuns, normaliseDoc, docText, isEmpty, safeHref,\n    toHtml, toPlain, fromPlain, parseHtml, docFromParts, fromMarkdown, looksLikeMarkdown, hasFormatting, pasteDoc,\n  };\n\n  ns.noteFormat = api;\n  if (typeof module === 'object' && module.exports) module.exports = api;\n})();\n</script>\n<script>\n// src/lib/search-logic.js\n// ─────────────────────────────────────────────────────────────────────\n// Search highli",
"ghting (pure)\n//\n// Gmail does the searching; this only shows where the words are. It takes\n// the words out of a Gmail query - leaving out operators such as from: or\n// before:, and anything excluded with a minus - and finds them in a\n// note's text the way a person would read a match: ignoring case and\n// accents (\"cafe\" finds \"Café\"), at the start of a word (\"gloss\" finds\n// \"glossary\", not \"xgloss\"), and phrases in quotes as phrases.\n//\n// From those matches come the excerpts shown in the results list, with\n// their offsets, so the list can mark them without parsing any HTML.\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n\n  // Operators whose value is a word to look for in the note itself.\n  const TEXT_OPS = new Set(['subject', 'intitle']);\n  const KEYWORDS = new Set(['or', 'and', 'around']);\n\n  // ── The words in a query ─────────────────────────────────────────────\n\n ",
" // Returns [{ words: ['stent', 'coating'] }, …]: one entry per term, a\n  // phrase being several words in a row.\n  function queryTerms(query) {\n    const out = [];\n    const seen = new Set();\n    const add = text => {\n      const words = String(text).split(/[\\s\"()[\\]{}<>]+/).map(w => w.replace(/^[^\\p{L}\\p{N}]+|[^\\p{L}\\p{N}]+$/gu, '')).filter(Boolean);\n      if (!words.length) return;\n      if (words.length === 1 && words[0].length < 2 && /^[\\p{L}\\p{N}]$/u.test(words[0]) && /[a-z0-9]/i.test(words[0])) return;\n      const key = words.join(' ').toLowerCase();\n      if (seen.has(key)) return;\n      seen.add(key);\n      out.push({ words });\n    };\n    const tokens = String(query || '').match(/-?[\\p{L}\\p{N}_]+:\\([^)]*\\)|-?[\\p{L}\\p{N}_]+:\"[^\"]*\"|-?\"[^\"]*\"|\\S+/gu) || [];\n    for (const raw of tokens) {\n      if (raw.startsWith('-')) continue; // excluded: not in the note\n      const op = /^([\\p{L}\\p{N}_]+):(.*)$/u.exec(raw);\n      if (op) {\n        if (TEXT_OPS.has(op[1].toLowerCase())) {\n   ",
"       const v = op[2].replace(/^[(\"]|[)\"]$/g, '');\n          if (/^\\(/.test(op[2])) v.split(/\\s+/).forEach(add);\n          else add(v);\n        }\n        continue;\n      }\n      if (raw.startsWith('\"')) { add(raw.replace(/\"/g, '')); continue; }\n      const word = raw.replace(/^[+(){}]+|[(){}]+$/g, '');\n      if (KEYWORDS.has(word.toLowerCase())) continue;\n      add(word);\n    }\n    return out;\n  }\n\n  // ── Finding them ─────────────────────────────────────────────────────\n\n  // Lower case, accents off - one character at a time, with a map back to\n  // where each folded character came from, so a match in the folded text\n  // is a match at known offsets in the real one.\n  function fold(text) {\n    let folded = '';\n    const map = [];\n    const s = String(text || '');\n    for (let i = 0; i < s.length;) {\n      const cp = s.codePointAt(i);\n      const ch = String.fromCodePoint(cp);\n      const f = ch.normalize('NFD').replace(/\\p{M}+/gu, '').toLowerCase();\n      for (let k = 0; k < f.lengt",
"h; k++) map.push(i);\n      folded += f;\n      i += ch.length;\n    }\n    map.push(s.length);\n    return { folded, map };\n  }\n\n  const escapeRe = s => s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');\n\n  // Every place the terms occur, as [start, end) offsets into `text`,\n  // in order, with overlaps merged.\n  function findMatches(text, terms) {\n    if (!terms || !terms.length || !text) return [];\n    const { folded, map } = fold(text);\n    const found = [];\n    for (const t of terms) {\n      const pattern = t.words.map(w => escapeRe(fold(w).folded)).join('[\\\\s\\\\u00a0]+');\n      if (!pattern) continue;\n      const re = new RegExp(`(?<![\\\\p{L}\\\\p{N}])${pattern}`, 'gu');\n      let m;\n      while ((m = re.exec(folded))) {\n        found.push([map[m.index], map[m.index + m[0].length]]);\n        if (m[0].length === 0) re.lastIndex++;\n      }\n    }\n    found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);\n    const merged = [];\n    for (const [s, e] of found) {\n      const last = merged[merged.length - 1];",
"\n      if (last && s <= last.end) last.end = Math.max(last.end, e);\n      else merged.push({ start: s, end: e });\n    }\n    return merged;\n  }\n\n  // ── Excerpts ─────────────────────────────────────────────────────────\n\n  // Up to `max` stretches of text around the matches, each with the\n  // matches inside it at offsets relative to the stretch. Stretches start\n  // and end on a space where one is near, and say whether text was cut.\n  function excerpts(text, matches, { context = 50, max = 3 } = {}) {\n    const s = String(text || '');\n    const out = [];\n    let i = 0;\n    while (i < matches.length && out.length < max) {\n      let start = Math.max(0, matches[i].start - context);\n      let end = Math.min(s.length, matches[i].end + context);\n      // Matches close enough share an excerpt.\n      let j = i + 1;\n      while (j < matches.length && matches[j].start < end) {\n        end = Math.min(s.length, Math.max(end, matches[j].end + Math.floor(context / 2)));\n        j++;\n      }\n      if ",
"(start > 0) {\n        const sp = s.slice(start, matches[i].start).search(/\\s/);\n        if (sp >= 0) start += sp + 1;\n      }\n      if (end < s.length) {\n        const tail = s.slice(matches[j - 1].end, end);\n        const sp = tail.search(/\\s\\S*$/);\n        if (sp > 0) end = matches[j - 1].end + sp;\n      }\n      out.push({\n        text: s.slice(start, end).replace(/\\s/g, ' '),\n        marks: matches.slice(i, j).map(m => ({ start: Math.max(m.start, start) - start, end: Math.min(m.end, end) - start })),\n        cutBefore: start > 0,\n        cutAfter: end < s.length,\n      });\n      i = j;\n    }\n    return out;\n  }\n\n  const api = { queryTerms, fold, findMatches, excerpts };\n\n  ns.searchLogic = api;\n  if (typeof module === 'object' && module.exports) module.exports = api;\n})();\n</script>\n<script>\n// src/content/ui.js\n// ─────────────────────────────────────────────────────────────────────\n// DOM toolkit for the injected UI\n//\n// Gmail enforces Trusted Types on its page, under which inner",
"HTML and\n// friends throw. Chromium currently exempts a content script's isolated\n// world from that policy, but nothing promises it always will - and mail\n// subjects are untrusted text regardless. So every node here is built\n// with createElement / createElementNS and filled with textContent. All\n// of it lives in shadow roots so Gmail's stylesheet and ours never meet.\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n\n  // ── Elements ─────────────────────────────────────────────────────────\n\n  // Properties that must be set as properties, not attributes, to take\n  // effect after first render (an input's value, a checkbox's state).\n  const PROPS = new Set(['value', 'checked', 'disabled', 'hidden']);\n\n  function h(tag, props, ...kids) {\n    const el = document.createElement(tag);\n    for (const [k, v] of Object.entries(props || {})) {\n      if (v === undefined || v === null ",
"|| v === false) continue;\n      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;\n      else if (k === 'text') el.textContent = String(v);\n      else if (k === 'dataset') Object.assign(el.dataset, v);\n      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);\n      else if (PROPS.has(k)) el[k] = v;\n      else el.setAttribute(k, v === true ? '' : String(v));\n    }\n    append(el, kids);\n    return el;\n  }\n\n  function append(el, kids) {\n    for (const kid of kids.flat(Infinity)) {\n      if (kid === null || kid === undefined || kid === false) continue;\n      el.appendChild(typeof kid === 'string' || typeof kid === 'number'\n        ? document.createTextNode(String(kid)) : kid);\n    }\n    return el;\n  }\n\n  // ── Icons ────────────────────────────────────────────────────────────\n  //\n  // Material Symbols paths (Apache 2.0), plus the board glyph drawn to\n  // match the toolbar icon.\n\n  const bar = (x, y, w, ht) =>\n    ",
"`M${x + 1} ${y}h${w - 2}a1 1 0 0 1 1 1v${ht - 2}a1 1 0 0 1-1 1h-${w - 2}a1 1 0 0 1-1-1v-${ht - 2}a1 1 0 0 1 1-1z`;\n\n  const ICONS = {\n    board: bar(3, 4, 5, 16) + bar(9.5, 4, 5, 10) + bar(16, 4, 5, 13),\n    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',\n    refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',\n    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',\n    more: 'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',\n    star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',\n    tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',\n    up: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',\n    down: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',",
"\n    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',\n    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',\n    caret: 'M7 10l5 5 5-5z',\n    open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',\n    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',\n    arrow: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',\n    remove: 'M19 13H5v-2h14v2z',\n    note: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',\n    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',\n    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.",
"83-1.83z',\n    folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',\n    notes: 'M3 18h12v-2H3v2zM3 6v2h18V6H3zm0 7h18v-2H3v2z',\n    // Formatting toolbar.\n    bold: 'M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z',\n    italic: 'M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z',\n    strike: 'M10 19h4v-3h-4v3zM5 4v3h5v3h4V7h5V4H5zM3 14h18v-2H3v2z',\n    bullets: 'M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z',\n    numbers: 'M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v",
"-2H7v2zm0-6h14v-2H7v2z',\n    checklist: 'M22 7h-9v2h9V7zm0 8h-9v2h9v-2zM5.54 11 2 7.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 11zm0 8L2 15.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 19z',\n    indent: 'M3 21h18v-2H3v2zM3 8v8l4-4-4-4zm8 9h10v-2H11v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z',\n    outdent: 'M11 17h10v-2H11v2zm-8-5 4 4V8l-4 4zm0 9h18v-2H3v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z',\n    link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',\n    clear: 'M3.27 5 2 6.27l6.97 6.97L6.5 19h3l1.57-3.66L16.73 21 18 19.73 3.55 5.27 3.27 5zM6 5v.18L8.82 8h2.4l-.72 1.68 2.1 2.1L14.21 8H20V5H6z',\n  };\n\n  const SVG_NS = 'http://www.w3.org/2000/svg';\n\n  function icon(name, size = 20) {\n    const svg = document.createElementNS(SVG_NS, 'svg');\n    svg.setAttribute('viewBox', '0 0 24 24');\n    svg.setAttrib",
"ute('width', String(size));\n    svg.setAttribute('height', String(size));\n    svg.setAttribute('aria-hidden', 'true');\n    svg.setAttribute('focusable', 'false');\n    svg.setAttribute('class', 'icon');\n    const path = document.createElementNS(SVG_NS, 'path');\n    path.setAttribute('d', ICONS[name] || '');\n    path.setAttribute('fill', 'currentColor');\n    svg.appendChild(path);\n    return svg;\n  }\n\n  // ── Shadow hosts ─────────────────────────────────────────────────────\n\n  function adoptStyles(root, cssText) {\n    try {\n      const sheet = new CSSStyleSheet();\n      sheet.replaceSync(cssText);\n      root.adoptedStyleSheets = [sheet];\n      return;\n    } catch { /* older engine or a hostile CSP: fall through */ }\n    const style = document.createElement('style');\n    style.textContent = cssText;\n    root.appendChild(style);\n  }\n\n  function mountShadow(id, cssText) {\n    // A previous injection (extension reloaded without reloading Gmail)\n    // leaves an orphaned host behind; replace",
" it rather than stack a second.\n    const stale = document.getElementById(id);\n    if (stale) stale.remove();\n\n    const host = document.createElement('div');\n    host.id = id;\n    const root = host.attachShadow({ mode: 'open' });\n    adoptStyles(root, cssText);\n\n    // Key events from inside a shadow root reach Gmail retargeted to the\n    // host, which is not an input - so typing \"c\" in our search box would\n    // open Gmail's Compose. Our own handlers inside the root run first;\n    // stopping propagation here keeps Gmail's shortcuts out of it.\n    for (const type of ['keydown', 'keypress', 'keyup']) {\n      host.addEventListener(type, e => e.stopPropagation());\n    }\n\n    (document.body || document.documentElement).appendChild(host);\n    return { host, root };\n  }\n\n  // ── Toasts ───────────────────────────────────────────────────────────\n\n  function toastLayer(root) {\n    let layer = root.querySelector('.toasts');\n    if (!layer) {\n      layer = h('div', { class: 'toasts', role: '",
"status', 'aria-live': 'polite' });\n      root.appendChild(layer);\n    }\n    return layer;\n  }\n\n  function toast(root, message, { kind = 'info', action = null, timeout } = {}) {\n    const layer = toastLayer(root);\n    // A new confirmation replaces the last one rather than stacking up;\n    // errors stay until read or timed out. One still offering an action\n    // (Undo) is kept too, since its button may be about to be clicked.\n    if (kind !== 'error') {\n      for (const old of layer.querySelectorAll('.toast:not(.toast-error)')) {\n        if (!old.querySelector('.toast-action')) old.remove();\n      }\n    }\n    const close = () => el.remove();\n    const el = h('div', { class: ['toast', kind === 'error' && 'toast-error'] },\n      h('span', { class: 'toast-text', text: message }),\n      action && h('button', {\n        class: 'toast-action', type: 'button', text: action.label,\n        onclick: () => { close(); action.onClick(); },\n      }),\n      h('button', { class: 'toast-close icon-btn'",
", type: 'button', 'aria-label': 'Dismiss', onclick: close },\n        icon('close', 18))\n    );\n    layer.appendChild(el);\n    // Errors stay a little longer: they usually need reading, not glancing.\n    setTimeout(close, timeout || (kind === 'error' ? 9000 : 5000));\n    return el;\n  }\n\n  // ── Menus ────────────────────────────────────────────────────────────\n  //\n  // items: { label, onSelect, icon?, checked?, disabled?, danger? }\n  //      | { heading } | { separator: true }\n\n  const openMenus = new WeakMap(); // root → close function\n\n  function closeMenu(root) {\n    const close = openMenus.get(root);\n    if (close) close();\n  }\n\n  function isMenuOpen(root) {\n    return openMenus.has(root);\n  }\n\n  function openMenu(root, anchor, items, { label = 'Actions', placement = 'below' } = {}) {\n    closeMenu(root);\n\n    const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label });\n    for (const it of items) {\n      if (it.separator) { menu.appendChild(h('div', { class: 'menu-",
"sep', role: 'separator' })); continue; }\n      if (it.heading) { menu.appendChild(h('div', { class: 'menu-heading', 'aria-hidden': 'true', text: it.heading })); continue; }\n      const role = it.checked === undefined ? 'menuitem' : 'menuitemradio';\n      menu.appendChild(h('button', {\n        class: ['menu-item', it.danger && 'danger'],\n        type: 'button',\n        role,\n        'aria-checked': it.checked === undefined ? null : String(!!it.checked),\n        disabled: !!it.disabled,\n        dataset: it.key ? { key: it.key } : undefined,\n        onclick: () => { close(); it.onSelect(); },\n      },\n        h('span', { class: 'menu-icon' }, it.checked ? icon('check', 18) : (it.icon ? icon(it.icon, 18) : null)),\n        h('span', { class: 'menu-label', text: it.label })\n      ));\n    }\n\n    root.appendChild(menu);\n    anchor.setAttribute('aria-expanded', 'true');\n\n    // Fixed positioning against the anchor, flipped or nudged so the menu\n    // never runs off the viewport edge.\n    const",
" r = anchor.getBoundingClientRect();\n    const mw = menu.offsetWidth;\n    const mh = menu.offsetHeight;\n    let left = Math.min(r.left, window.innerWidth - mw - 8);\n    if (r.right - mw > 8 && left + mw > window.innerWidth - 8) left = r.right - mw;\n    left = Math.max(8, left);\n    let top = placement === 'above' ? r.top - mh - 6 : r.bottom + 6;\n    if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;\n    if (top < 8) top = 8;\n    menu.style.left = `${Math.round(left)}px`;\n    menu.style.top = `${Math.round(top)}px`;\n\n    const buttons = () => [...menu.querySelectorAll('.menu-item:not([disabled])')];\n    const onKey = e => {\n      const list = buttons();\n      const i = list.indexOf(root.activeElement);\n      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }\n      else if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }\n      else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).fo",
"cus(); }\n      else if (e.key === 'Home') { e.preventDefault(); list[0] && list[0].focus(); }\n      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1] && list[list.length - 1].focus(); }\n      else if (e.key === 'Tab') { close(); }\n    };\n    // Clicks anywhere else - in our root or on Gmail itself - dismiss it.\n    const onPointer = e => {\n      if (!e.composedPath().includes(menu) && !e.composedPath().includes(anchor)) close();\n    };\n\n    // If the menu held focus, it goes back to the anchor - on Esc, on\n    // choosing an item (before the action runs, so an action that\n    // re-renders can find the anchor again by its data-key), and when a\n    // re-render closes the menu from underneath.\n    function close() {\n      if (openMenus.get(root) !== close) return;\n      const hadFocus = menu.contains(root.activeElement);\n      openMenus.delete(root);\n      menu.remove();\n      if (hadFocus && anchor.isConnected) anchor.focus({ preventScroll: true });\n      anchor.set",
"Attribute('aria-expanded', 'false');\n      menu.removeEventListener('keydown', onKey);\n      document.removeEventListener('pointerdown', onPointer, true);\n    }\n\n    menu.addEventListener('keydown', onKey);\n    document.addEventListener('pointerdown', onPointer, true);\n    openMenus.set(root, close);\n\n    const first = buttons()[0];\n    if (first) first.focus();\n    return close;\n  }\n\n  ns.ui = { h, append, icon, mountShadow, toast, openMenu, closeMenu, isMenuOpen };\n})();\n</script>\n<script>\n// src/content/styles.js\n// ─────────────────────────────────────────────────────────────────────\n// Styles for the injected UI\n//\n// Plain strings, adopted into each shadow root. The look borrows Gmail's\n// own vocabulary - Google Sans, its blue, its elevation shadows, pill\n// buttons - so the board reads as part of Gmail rather than something\n// bolted on. Dark mode follows the operating system, as asked; Gmail's\n// own theme setting is not visible to a content script without scraping.\n// ───────",
"──────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n\n  // ── Shared ───────────────────────────────────────────────────────────\n\n  const BASE = `\n:host {\n  all: initial !important;\n  /* A positioned host with a z-index is its own stacking context, so\n     menus and toasts inside it can layer over the board with small\n     numbers instead of competing with Gmail's. */\n  position: relative !important;\n  z-index: 2147483000 !important;\n\n  --bg: #f6f8fc;\n  --bar: #f6f8fc;\n  --col: #e9eef6;\n  --surface: #ffffff;\n  --menu: #ffffff;\n  --fg: #1f1f1f;\n  --fg-2: #444746;\n  --fg-3: #5e6062;\n  --accent: #0b57d0;\n  --on-accent: #ffffff;\n  --accent-soft: #d3e3fd;\n  --on-accent-soft: #041e49;\n  --border: #e1e3e1;\n  --border-strong: #c4c7c5;\n  --hover: rgba(68, 71, 70, .08);\n  --press: rgba(68, 71, 70, .14);\n  --focus: #0b57d0;\n  --danger: #b3261e;\n  --star: #e8a400;\n  --inverse: #303030;\n  --on-inverse: ",
"#f2f2f2;\n  --inverse-accent: #a8c7fa;\n  --scrim: rgba(32, 33, 36, .4);\n  --shadow-1: 0 1px 2px rgba(60, 64, 67, .2), 0 1px 3px 1px rgba(60, 64, 67, .1);\n  --shadow-2: 0 1px 2px rgba(60, 64, 67, .3), 0 2px 6px 2px rgba(60, 64, 67, .15);\n  --shadow-3: 0 4px 8px 3px rgba(60, 64, 67, .15), 0 1px 3px rgba(60, 64, 67, .3);\n  --font: \"Google Sans\", Roboto, Arial, sans-serif;\n  /* Card colours: Google's own palette, a step lighter in dark mode so\n     the stripe still reads against a dark card. */\n  --c-red: #d93025;\n  --c-orange: #e8710a;\n  --c-yellow: #f9ab00;\n  --c-green: #1e8e3e;\n  --c-blue: #1a73e8;\n  --c-purple: #9334e6;\n  --c-grey: #80868b;\n  --mark: #fde293;\n  --mark-current: #f9ab00;\n  --on-mark-current: #1f1f1f;\n}\n\n@media (prefers-color-scheme: dark) {\n  :host {\n    --bg: #131314;\n    --bar: #131314;\n    --col: #1e1f20;\n    --surface: #2a2b2d;\n    --menu: #2d2e30;\n    --fg: #e3e3e3;\n    --fg-2: #c4c7c5;\n    --fg-3: #a2a5a3;\n    --accent: #a8c7fa;\n    --on-accent: #062e6f;\n    --accen",
"t-soft: #004a77;\n    --on-accent-soft: #c2e7ff;\n    --border: #3a3b3d;\n    --border-strong: #5c5e60;\n    --hover: rgba(227, 227, 227, .08);\n    --press: rgba(227, 227, 227, .14);\n    --focus: #a8c7fa;\n    --danger: #f2b8b5;\n    --star: #fdd663;\n    --inverse: #e3e3e3;\n    --on-inverse: #1f1f1f;\n    --inverse-accent: #0b57d0;\n    --scrim: rgba(0, 0, 0, .55);\n    --shadow-1: 0 1px 2px rgba(0, 0, 0, .5), 0 1px 3px 1px rgba(0, 0, 0, .25);\n    --shadow-2: 0 1px 3px rgba(0, 0, 0, .6), 0 2px 8px 2px rgba(0, 0, 0, .3);\n    --shadow-3: 0 4px 10px 3px rgba(0, 0, 0, .45), 0 1px 3px rgba(0, 0, 0, .6);\n    --c-red: #f28b82;\n    --c-orange: #fcad70;\n    --c-yellow: #fdd663;\n    --c-green: #81c995;\n    --c-blue: #8ab4f8;\n    --c-purple: #c58af9;\n    --c-grey: #9aa0a6;\n    --mark: #6b5800;\n    --mark-current: #fdd663;\n    --on-mark-current: #1f1f1f;\n  }\n}\n\n*, *::before, *::after { box-sizing: border-box; }\n\n/* Author display rules (.pill, .overlay…) would otherwise beat the\n   browser's own [hidden] {",
" display: none }. */\n[hidden] { display: none !important; }\n\nbutton {\n  font: inherit;\n  color: inherit;\n  background: none;\n  border: 0;\n  margin: 0;\n  padding: 0;\n  cursor: pointer;\n  -webkit-tap-highlight-color: transparent;\n}\nbutton:disabled { cursor: default; }\n\n:focus { outline: none; }\n:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }\n\n.icon { display: block; flex: none; }\n\n.icon-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 36px;\n  height: 36px;\n  border-radius: 50%;\n  color: var(--fg-2);\n  flex: none;\n}\n.icon-btn:hover { background: var(--hover); color: var(--fg); }\n.icon-btn:active { background: var(--press); }\n.icon-btn:disabled { opacity: .4; background: none; }\n\n.btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  height: 36px;\n  padding: 0 18px;\n  border-radius: 18px;\n  font-size: 14px;\n  font-weight: 500;\n  letter-spacing: .01em;\n  white-space: nowrap;\n}\n.btn-prima",
"ry { background: var(--accent); color: var(--on-accent); }\n.btn-primary:hover { box-shadow: var(--shadow-1); }\n.btn-tonal { background: var(--accent-soft); color: var(--on-accent-soft); }\n.btn-text { color: var(--accent); padding: 0 12px; }\n.btn-text:hover, .btn-tonal:hover { background-image: linear-gradient(var(--hover), var(--hover)); }\n.btn:disabled { opacity: .5; box-shadow: none; }\n\n/* ── Menus ── */\n\n.menu {\n  position: fixed;\n  z-index: 20;\n  min-width: 208px;\n  max-width: 320px;\n  max-height: 70vh;\n  overflow-y: auto;\n  padding: 8px 0;\n  background: var(--menu);\n  color: var(--fg);\n  border-radius: 8px;\n  box-shadow: var(--shadow-3);\n  font-family: var(--font);\n  font-size: 14px;\n  line-height: 20px;\n}\n.menu-item {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  width: 100%;\n  min-height: 36px;\n  padding: 6px 20px 6px 12px;\n  text-align: left;\n}\n.menu-item:hover { background: var(--hover); }\n.menu-item:focus-visible { background: var(--hover); outline: 2px solid var(--f",
"ocus); outline-offset: -2px; }\n.menu-item:disabled { opacity: .45; background: none; }\n.menu-item.danger { color: var(--danger); }\n.menu-icon { width: 18px; height: 18px; display: inline-flex; color: var(--fg-2); flex: none; }\n.menu-item.danger .menu-icon { color: var(--danger); }\n.menu-item[aria-checked=\"true\"] .menu-icon { color: var(--accent); }\n.menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.menu-heading {\n  padding: 8px 20px 4px 42px;\n  font-size: 12px;\n  font-weight: 500;\n  color: var(--fg-3);\n}\n.menu-sep { height: 1px; margin: 8px 0; background: var(--border); }\n\n/* ── Toasts ── */\n\n.toasts {\n  position: fixed;\n  z-index: 30;\n  left: 50%;\n  bottom: 24px;\n  transform: translateX(-50%);\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 8px;\n  pointer-events: none;\n  font-family: var(--font);\n}\n.toast {\n  pointer-events: auto;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  min-height: 48px;\n  max-",
"width: min(600px, calc(100vw - 32px));\n  padding: 6px 6px 6px 16px;\n  border-radius: 8px;\n  background: var(--inverse);\n  color: var(--on-inverse);\n  box-shadow: var(--shadow-3);\n  font-size: 14px;\n  line-height: 20px;\n  animation: toast-in .18s ease-out;\n}\n.toast-error { border-left: 4px solid #f28b82; padding-left: 12px; }\n.toast-text { flex: 1; padding-right: 8px; }\n.toast-action {\n  height: 36px;\n  padding: 0 12px;\n  border-radius: 18px;\n  color: var(--inverse-accent);\n  font-weight: 500;\n  white-space: nowrap;\n}\n.toast-action:hover { background: rgba(128, 128, 128, .16); }\n.toast-close { color: inherit; opacity: .8; }\n.toast-close:hover { background: rgba(128, 128, 128, .16); color: inherit; }\n@keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }\n\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { animation: none !important; transition: none !important; }\n}\n`;\n\n  // ── Board ──────────────────────────────────",
"──────────────────────────\n\n  const BOARD = `\n.overlay {\n  position: fixed;\n  inset: 0;\n  z-index: 1;\n  display: flex;\n  flex-direction: column;\n  background: var(--bg);\n  color: var(--fg);\n  font-family: var(--font);\n  font-size: 14px;\n  line-height: 1.4;\n  -webkit-font-smoothing: antialiased;\n}\n.overlay[hidden] { display: none; }\n\n.bar {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  height: 64px;\n  padding: 0 12px 0 20px;\n  flex: none;\n  background: var(--bar);\n}\n.brand {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  margin: 0;\n  font-size: 22px;\n  font-weight: 400;\n  color: var(--fg);\n  white-space: nowrap;\n}\n.brand .logo { color: var(--accent); }\n.brand .dim { color: var(--fg-3); }\n.account {\n  margin-left: 14px;\n  padding: 4px 12px;\n  border-radius: 14px;\n  background: var(--hover);\n  color: var(--fg-2);\n  font-size: 13px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  min-width: 0;\n}\n.spacer { flex: 1; }\n.updated { color: var(--fg-3); fon",
"t-size: 12px; white-space: nowrap; margin-right: 2px; }\n\n/* ── Tabs: Board | Notes ── */\n\n.tabs {\n  display: flex;\n  gap: 2px;\n  margin-left: 18px;\n  padding: 3px;\n  border-radius: 20px;\n  background: var(--hover);\n}\n.tab {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  height: 32px;\n  padding: 0 14px 0 10px;\n  border-radius: 16px;\n  color: var(--fg-2);\n  font-size: 14px;\n  font-weight: 500;\n}\n.tab:hover { color: var(--fg); }\n.tab[aria-selected=\"true\"] { background: var(--surface); color: var(--fg); box-shadow: var(--shadow-1); }\n.tab[aria-selected=\"true\"] .icon { color: var(--accent); }\n.spinning .icon { animation: spin .9s linear infinite; }\n@keyframes spin { to { transform: rotate(360deg); } }\n\n.body { flex: 1; display: flex; min-height: 0; }\n\n.columns {\n  flex: 1;\n  display: flex;\n  gap: 12px;\n  padding: 4px 20px 20px;\n  overflow-x: auto;\n  overflow-y: hidden;\n  min-height: 0;\n}\n.column {\n  flex: 1 0 280px;\n  min-width: 280px;\n  max-width: 400px;\n  display: flex;\n  fl",
"ex-direction: column;\n  min-height: 0;\n  background: var(--col);\n  border-radius: 16px;\n  transition: box-shadow .12s;\n}\n.column.drop-target { box-shadow: inset 0 0 0 2px var(--accent); }\n.col-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 10px 6px 6px 16px;\n  flex: none;\n}\n.col-title {\n  margin: 0;\n  font-size: 14px;\n  font-weight: 500;\n  color: var(--fg);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.col-count {\n  flex: none;\n  min-width: 22px;\n  padding: 0 7px;\n  border-radius: 11px;\n  background: var(--surface);\n  color: var(--fg-2);\n  font-size: 12px;\n  line-height: 22px;\n  text-align: center;\n}\n.col-flag {\n  flex: none;\n  padding: 0 8px;\n  border-radius: 11px;\n  border: 1px solid var(--border-strong);\n  color: var(--fg-3);\n  font-size: 11px;\n  line-height: 20px;\n}\n.col-head .spacer { min-width: 4px; }\n.col-note { padding: 0 16px 6px; font-size: 12px; color: var(--fg-3); flex: none; }\n\n.list {\n  flex: 1;\n  min-height: 72px;\n  overf",
"low-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 4px 8px 12px;\n  scrollbar-width: thin;\n}\n.list:empty::after {\n  content: attr(data-empty);\n  display: block;\n  margin: 2px 0;\n  padding: 22px 12px;\n  border: 1.5px dashed var(--border-strong);\n  border-radius: 12px;\n  color: var(--fg-3);\n  font-size: 13px;\n  text-align: center;\n}\n\n/* ── Cards ── */\n\n.card {\n  position: relative;\n  flex: none;\n  background: var(--surface);\n  border-radius: 12px;\n  box-shadow: var(--shadow-1);\n  cursor: grab;\n  transition: box-shadow .15s;\n}\n.card:hover { box-shadow: var(--shadow-2); }\n.card.dragging { display: none; }\n.card.lifting { opacity: .5; }\n.card-main {\n  display: block;\n  width: 100%;\n  padding: 10px 14px 12px;\n  border-radius: 12px;\n  text-align: left;\n  cursor: inherit;\n}\n.card-main:focus-visible { outline-offset: -2px; }\n.card-top {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-height: 20px;\n  font-size: 13px;\n  color: var(--fg-2);\n}\n.dot { width: 8px;",
" height: 8px; border-radius: 50%; background: var(--accent); flex: none; }\n.from { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.date { flex: none; font-size: 12px; color: var(--fg-3); }\n.card:hover .date, .card:focus-within .date { visibility: hidden; }\n.subject-row { display: flex; align-items: center; gap: 6px; margin-top: 3px; }\n.subject {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  color: var(--fg);\n}\n.unread .from, .unread .subject { font-weight: 700; color: var(--fg); }\n.star { color: var(--star); display: inline-flex; flex: none; }\n.count {\n  flex: none;\n  padding: 0 6px;\n  border-radius: 9px;\n  background: var(--hover);\n  color: var(--fg-2);\n  font-size: 11px;\n  font-weight: 500;\n  line-height: 18px;\n}\n.draft { flex: none; color: var(--danger); font-size: 12px; }\n.snippet {\n  margin-top: 3px;\n  font-size: 13px;\n  line-height: 18px;\n  color: var(--fg-3);\n  displ",
"ay: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  overflow-wrap: anywhere;\n}\n.card-note {\n  margin-top: 4px;\n  padding-left: 8px;\n  border-left: 2px solid var(--border-strong);\n  font-size: 13px;\n  line-height: 18px;\n  color: var(--fg-2);\n  white-space: pre-line;\n  display: -webkit-box;\n  -webkit-line-clamp: 3;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  overflow-wrap: anywhere;\n}\n\n[data-colour=\"red\"] { --stripe: var(--c-red); }\n[data-colour=\"orange\"] { --stripe: var(--c-orange); }\n[data-colour=\"yellow\"] { --stripe: var(--c-yellow); }\n[data-colour=\"green\"] { --stripe: var(--c-green); }\n[data-colour=\"blue\"] { --stripe: var(--c-blue); }\n[data-colour=\"purple\"] { --stripe: var(--c-purple); }\n[data-colour=\"grey\"] { --stripe: var(--c-grey); }\n.card[data-colour]::before {\n  content: '';\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: 0;\n  width: 6px;\n  border-radius: 12px 0 0 12px;\n  background: var(--stripe);\n  pointer-events: none",
";\n}\n.card[data-colour] .card-main { padding-left: 18px; }\n\n.card-menu {\n  position: absolute;\n  top: 4px;\n  right: 4px;\n  width: 32px;\n  height: 32px;\n  opacity: 0;\n  background: var(--surface);\n}\n.card-menu:hover { background: var(--hover); }\n.card:hover .card-menu, .card:focus-within .card-menu, .card-menu[aria-expanded=\"true\"] { opacity: 1; }\n@media (hover: none) { .card-menu { opacity: 1; } .card .date { visibility: visible; } }\n\n.placeholder {\n  flex: none;\n  border-radius: 12px;\n  border: 2px dashed var(--accent);\n  background: color-mix(in srgb, var(--accent) 10%, transparent);\n}\n\n.skeleton {\n  flex: none;\n  height: 92px;\n  border-radius: 12px;\n  background: var(--surface);\n  opacity: .55;\n  animation: pulse 1.4s ease-in-out infinite;\n}\n@keyframes pulse { 50% { opacity: .3; } }\n\n/* ── Column search ── */\n\n.search {\n  flex: none;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  max-height: 55%;\n  min-height: 0;\n  margin: 0 8px 8px;\n  padding: 8px;\n  border-radius: 12px;\n ",
" background: var(--surface);\n  box-shadow: var(--shadow-2);\n}\n.search-box {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  height: 40px;\n  padding: 0 2px 0 12px;\n  border-radius: 20px;\n  background: var(--col);\n  color: var(--fg-2);\n  flex: none;\n}\n.search-box:focus-within { outline: 2px solid var(--focus); }\n.search-box input {\n  flex: 1;\n  min-width: 0;\n  height: 100%;\n  border: 0;\n  background: transparent;\n  color: var(--fg);\n  font: inherit;\n  font-size: 14px;\n}\n.search-box input::placeholder { color: var(--fg-3); }\n.search-box input:focus-visible { outline: none; }\n.search-hint { padding: 0 8px; font-size: 12px; color: var(--fg-3); flex: none; }\n.results { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; scrollbar-width: thin; }\n.result {\n  display: block;\n  width: 100%;\n  padding: 7px 10px;\n  border-radius: 8px;\n  text-align: left;\n}\n.result:hover:not(:disabled) { background: var(--hover); }\n.result:disabled { opacity: .55; }\n.r-top { disp",
"lay: flex; gap: 6px; font-size: 12px; color: var(--fg-2); }\n.r-top .from { font-weight: 500; }\n.r-subject {\n  display: block;\n  font-size: 13px;\n  color: var(--fg);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.r-where { display: block; font-size: 12px; color: var(--accent); margin-top: 1px; }\n.result:disabled .r-where { color: var(--fg-3); }\n.results-empty { padding: 12px 8px; font-size: 13px; color: var(--fg-3); text-align: center; }\n\n/* ── Status panels ── */\n\n.panel {\n  margin: auto;\n  width: min(460px, calc(100vw - 48px));\n  padding: 36px 32px 32px;\n  border-radius: 28px;\n  background: var(--surface);\n  box-shadow: var(--shadow-1);\n  text-align: center;\n}\n.panel .panel-icon {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 56px;\n  height: 56px;\n  border-radius: 50%;\n  background: var(--accent-soft);\n  color: var(--on-accent-soft);\n}\n.panel h2 { margin: 16px 0 8px; font-size: 22px; font-weight: 400; color: var(--fg); }\n.",
"panel p { margin: 0 0 20px; color: var(--fg-2); line-height: 1.5; }\n.panel .actions { display: flex; gap: 8px; justify-content: center; }\n\n/* ── Notes ── */\n\n.notes {\n  flex: 1;\n  display: flex;\n  gap: 12px;\n  min-width: 0;\n  min-height: 0;\n  padding: 4px 20px 20px;\n}\n.notes-folders {\n  flex: 0 0 230px;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  border-radius: 16px;\n  background: var(--col);\n}\n.folders-head { display: flex; align-items: center; gap: 4px; padding: 10px 6px 4px 16px; flex: none; }\n.folders-head h2 { margin: 0; flex: 1; font-size: 13px; font-weight: 500; color: var(--fg-2); letter-spacing: .02em; }\n.folder-items { flex: 1; overflow-y: auto; padding: 2px 8px 10px; display: flex; flex-direction: column; gap: 1px; }\n.folder-row { position: relative; display: flex; align-items: center; border-radius: 10px; padding-left: calc(var(--depth, 0) * 16px); }\n.folder-row.drop { box-shadow: inset 0 0 0 2px var(--accent); background: color-mix(in srgb, var(--accent) ",
"10%, transparent); }\n.folder-btn {\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  height: 36px;\n  padding: 0 10px;\n  border-radius: 10px;\n  color: var(--fg-2);\n  font-size: 14px;\n  text-align: left;\n}\n.folder-btn:hover { background: var(--hover); color: var(--fg); }\n.folder-btn[aria-current=\"true\"] { background: var(--accent-soft); color: var(--on-accent-soft); font-weight: 500; }\n.folder-btn .icon { color: inherit; opacity: .85; }\n.folder-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.folder-count { font-size: 12px; color: inherit; opacity: .75; font-variant-numeric: tabular-nums; }\n.folder-menu { position: absolute; right: 2px; width: 30px; height: 30px; opacity: 0; background: var(--col); }\n.folder-row:hover .folder-menu, .folder-row:focus-within .folder-menu, .folder-menu[aria-expanded=\"true\"] { opacity: 1; }\n.folder-row:hover .folder-count, .folder-row:focus-within .folder-count { visibility: hidd",
"en; }\n.folder-row:has(.folder-btn[aria-current=\"true\"]) .folder-menu { background: var(--accent-soft); color: var(--on-accent-soft); }\n.folder-row.editing { flex-direction: column; align-items: stretch; padding-top: 2px; padding-bottom: 2px; }\n.folder-edit { display: flex; align-items: center; gap: 8px; padding-left: 10px; color: var(--fg-2); }\n.folder-input { height: 34px; flex: 1; min-width: 0; }\n.folder-error { padding: 4px 4px 2px 36px; font-size: 12px; color: var(--danger); }\n.notes-scope { flex: none; padding: 0 20px 6px; font-size: 12px; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.notes-list {\n  flex: 0 0 320px;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  border-radius: 16px;\n  background: var(--col);\n}\n.notes-tools { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; flex: none; }\n.notes-tools .search-box { flex: 1; min-width: 0; background: var(--surface); }\n.notes-tools .btn { height: 40px; paddin",
"g: 0 16px 0 12px; flex: none; }\n.notes-items { flex: 1; overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 2px; }\n.note-item {\n  display: block;\n  width: 100%;\n  padding: 10px 12px;\n  border-radius: 12px;\n  text-align: left;\n}\n.note-item:hover { background: var(--hover); }\n.note-item[aria-current=\"true\"] { background: var(--surface); box-shadow: var(--shadow-1); }\n.ni-top { display: flex; align-items: baseline; gap: 8px; }\n.ni-title {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  font-weight: 500;\n  color: var(--fg);\n}\n.ni-snippet {\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  overflow-wrap: anywhere;\n  margin-top: 2px;\n  font-size: 13px;\n  line-height: 18px;\n  color: var(--fg-3);\n}\n.ni-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 3px; }\n.ni-meta:empty { display: none; }\n.ni-folder { display: inline-flex; a",
"lign-items: center; gap: 3px; font-size: 11px; color: var(--fg-3); }\n.ni-mail { font-size: 11px; color: var(--accent); }\n.dragging-note .note-item[aria-current=\"true\"] { box-shadow: none; }\n.ne-folder {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 32px;\n  max-width: 260px;\n  margin-right: 4px;\n  padding: 0 4px 0 10px;\n  border-radius: 16px;\n  color: var(--fg-2);\n  font-size: 13px;\n  white-space: nowrap;\n}\n.ne-folder span { overflow: hidden; text-overflow: ellipsis; }\n.ne-folder:hover { background: var(--hover); color: var(--fg); }\n/* Search: the words marked in results, and in the open note. */\nmark { background: var(--mark); color: inherit; border-radius: 2px; padding: 0 1px; }\n/* Only the phone app, which shows one pane at a time, needs a way back. */\n.ne-back { display: none; }\n.ni-excerpts { display: block; margin-top: 3px; }\n.ni-excerpt {\n  display: block;\n  font-size: 13px;\n  line-height: 18px;\n  color: var(--fg-3);\n  overflow-wrap: anywhere;\n}\n.ni-excerpt",
" + .ni-excerpt { margin-top: 3px; }\n.ni-excerpt mark, .ni-snippet mark, .ni-title mark { color: var(--fg); }\n.ni-hits { font-size: 11px; color: var(--accent); font-weight: 500; }\n::highlight(gkb-match) { background-color: var(--mark); }\n::highlight(gkb-match-current) { background-color: var(--mark-current); color: var(--on-mark-current); }\n.ne-find {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  margin: 4px 20px 0;\n  padding: 2px 4px 2px 12px;\n  border-radius: 12px;\n  background: var(--col);\n  color: var(--fg-2);\n  font-size: 13px;\n  flex: none;\n}\n.ne-find .find-words { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }\n.ne-find .find-pos { white-space: nowrap; font-variant-numeric: tabular-nums; }\n.ne-find .icon-btn { width: 32px; height: 32px; }\n.notes-empty { padding: 24px 12px; text-align: center; font-size: 13px; color: var(--fg-3); }\n.notes-empty p { margin: 0 0 8px; }\n.notes-foot { flex: none; padding: 8px 16px 12px",
"; font-size: 12px; color: var(--fg-3); }\n.notes-foot:empty { display: none; }\n\n.note-editor {\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  border-radius: 16px;\n  background: var(--surface);\n  box-shadow: var(--shadow-1);\n}\n.ne-bar { display: flex; align-items: center; gap: 4px; padding: 8px 10px 0 28px; flex: none; min-height: 48px; }\n.ne-status { font-size: 12px; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }\n.ne-status.error { color: var(--danger); }\n.ne-banner {\n  margin: 4px 28px 0;\n  padding: 10px 14px;\n  border-radius: 12px;\n  background: var(--accent-soft);\n  color: var(--on-accent-soft);\n  font-size: 13px;\n  line-height: 1.45;\n  flex: none;\n}\n.ne-title {\n  border: 0;\n  background: transparent;\n  color: var(--fg);\n  font-family: var(--font);\n}\n.ne-title { flex: none; padding: 8px 28px 6px; font-size: 24px; line-height: 1.3; }\n.ne-body {\n  position: relative;\n  flex: 1;\n  min-height: 0;\n  overflow-y: ",
"auto;\n  padding: 10px 28px 28px;\n  font-size: 15px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  outline: none;\n  counter-reset: ol0 ol1 ol2 ol3;\n}\n.ne-title::placeholder { color: var(--fg-3); }\n.ne-title:focus-visible { outline: none; }\n.ne-title:disabled, .ne-body[aria-disabled=\"true\"] { opacity: .6; }\n.ne-body[data-empty=\"1\"]::before {\n  content: attr(data-placeholder);\n  position: absolute;\n  top: 10px;\n  left: 28px;\n  color: var(--fg-3);\n  pointer-events: none;\n}\n\n/* Blocks: one per paragraph, heading or list item. Bullets, numbers and\n   boxes are drawn here, in each block's left padding. */\n.blk { position: relative; min-height: 1.6em; --lvl: 0; }\n.blk[data-level=\"1\"] { --lvl: 1; }\n.blk[data-level=\"2\"] { --lvl: 2; }\n.blk[data-level=\"3\"] { --lvl: 3; }\n.blk[data-type=\"h1\"] { font-size: 24px; line-height: 1.3; font-weight: 600; margin: 14px 0 4px; }\n.blk[data-type=\"h2\"] { font-size: 20px; line-height: 1.35; font-weight: 600; margin: 12px 0 2px; }\n.blk[d",
"ata-type=\"h3\"] { font-size: 17px; line-height: 1.4; font-weight: 600; margin: 10px 0 2px; }\n.blk:first-child { margin-top: 0; }\n.blk[data-type=\"ul\"], .blk[data-type=\"ol\"], .blk[data-type=\"check\"] { padding-left: calc(28px + var(--lvl) * 24px); }\n.blk[data-type=\"ul\"]::before {\n  content: '\\\\2022';\n  position: absolute;\n  left: calc(9px + var(--lvl) * 24px);\n  color: var(--fg-2);\n}\n.blk[data-type=\"ul\"][data-level=\"1\"]::before { content: '\\\\25E6'; }\n.blk[data-type=\"ul\"][data-level=\"2\"]::before, .blk[data-type=\"ul\"][data-level=\"3\"]::before { content: '\\\\25AA'; }\n.blk[data-type=\"ol\"]::before {\n  position: absolute;\n  left: calc(var(--lvl) * 24px);\n  width: 22px;\n  text-align: right;\n  color: var(--fg-2);\n  font-variant-numeric: tabular-nums;\n}\n/* Numbering restarts whenever the run of numbered items at a level is\n   broken by anything shallower or by a non-list block. */\n.blk:not([data-type=\"ul\"]):not([data-type=\"ol\"]):not([data-type=\"check\"]) { counter-reset: ol0 ol1 ol2 ol3; }\n.blk[data-t",
"ype=\"ul\"][data-level=\"0\"], .blk[data-type=\"check\"][data-level=\"0\"] { counter-reset: ol0 ol1 ol2 ol3; }\n.blk[data-type=\"ul\"][data-level=\"1\"], .blk[data-type=\"check\"][data-level=\"1\"] { counter-reset: ol1 ol2 ol3; }\n.blk[data-type=\"ul\"][data-level=\"2\"], .blk[data-type=\"check\"][data-level=\"2\"] { counter-reset: ol2 ol3; }\n.blk[data-type=\"ul\"][data-level=\"3\"], .blk[data-type=\"check\"][data-level=\"3\"] { counter-reset: ol3; }\n.blk[data-type=\"ol\"][data-level=\"0\"] { counter-increment: ol0; counter-reset: ol1 ol2 ol3; }\n.blk[data-type=\"ol\"][data-level=\"1\"] { counter-increment: ol1; counter-reset: ol2 ol3; }\n.blk[data-type=\"ol\"][data-level=\"2\"] { counter-increment: ol2; counter-reset: ol3; }\n.blk[data-type=\"ol\"][data-level=\"3\"] { counter-increment: ol3; }\n.blk[data-type=\"ol\"][data-level=\"0\"]::before { content: counter(ol0) '.'; }\n.blk[data-type=\"ol\"][data-level=\"1\"]::before { content: counter(ol1, lower-alpha) '.'; }\n.blk[data-type=\"ol\"][data-level=\"2\"]::before { content: counter(ol2, lower-roman) ",
"'.'; }\n.blk[data-type=\"ol\"][data-level=\"3\"]::before { content: counter(ol3) '.'; }\n.blk[data-type=\"check\"]::before {\n  content: '';\n  position: absolute;\n  left: calc(3px + var(--lvl) * 24px);\n  top: calc(.8em - 9px);\n  width: 14px;\n  height: 14px;\n  border: 2px solid var(--fg-3);\n  border-radius: 4px;\n  cursor: pointer;\n}\n.blk[data-type=\"check\"][data-checked=\"1\"]::before { background: var(--accent); border-color: var(--accent); }\n.blk[data-type=\"check\"][data-checked=\"1\"]::after {\n  content: '';\n  position: absolute;\n  left: calc(9px + var(--lvl) * 24px);\n  top: calc(.8em - 7px);\n  width: 5px;\n  height: 10px;\n  border: solid var(--on-accent);\n  border-width: 0 2px 2px 0;\n  transform: rotate(45deg);\n  pointer-events: none;\n}\n.blk[data-type=\"check\"][data-checked=\"1\"] { color: var(--fg-3); text-decoration: line-through; }\n.ne-body a { color: var(--accent); text-decoration: underline; cursor: text; }\n\n/* Formatting toolbar and the link field beneath it. */\n.ne-toolbar {\n  display: flex;\n  ",
"flex-wrap: wrap;\n  align-items: center;\n  gap: 2px;\n  margin: 2px 20px 0;\n  padding: 4px 6px;\n  border-radius: 12px;\n  background: var(--col);\n  flex: none;\n}\n.tb-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 32px;\n  height: 32px;\n  border-radius: 8px;\n  color: var(--fg-2);\n}\n.tb-btn:hover:not(:disabled), .tb-style:hover:not(:disabled) { background: var(--hover); color: var(--fg); }\n.tb-btn[aria-pressed=\"true\"] { background: var(--accent-soft); color: var(--on-accent-soft); }\n.tb-btn:disabled, .tb-style:disabled { opacity: .4; }\n.tb-style {\n  display: inline-flex;\n  align-items: center;\n  gap: 2px;\n  height: 32px;\n  padding: 0 4px 0 10px;\n  border-radius: 8px;\n  color: var(--fg);\n  font-size: 13px;\n  font-weight: 500;\n}\n.tb-style-label { min-width: 84px; text-align: left; }\n.tb-sep { width: 1px; height: 20px; margin: 0 6px; background: var(--border-strong); opacity: .6; }\n.ne-linkbar {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;",
"\n  gap: 8px;\n  margin: 6px 20px 0;\n  padding: 6px 8px 6px 12px;\n  border-radius: 12px;\n  border: 1px solid var(--border);\n  color: var(--fg-2);\n  flex: none;\n}\n.ne-linkbar .text-input { flex: 1; min-width: 180px; height: 34px; }\n.ne-linkbar .btn { height: 34px; }\n.link-error { flex-basis: 100%; color: var(--danger); font-size: 12px; }\n.link-error:empty { display: none; }\n.notes-intro { margin: auto; max-width: 440px; padding: 32px; text-align: center; }\n.notes-intro .panel-icon {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 56px;\n  height: 56px;\n  border-radius: 50%;\n  background: var(--accent-soft);\n  color: var(--on-accent-soft);\n}\n.notes-intro h2 { margin: 16px 0 8px; font-size: 22px; font-weight: 400; }\n.notes-intro p { margin: 0 0 20px; color: var(--fg-2); line-height: 1.5; }\n\n/* ── Column settings drawer ── */\n\n.scrim { position: fixed; inset: 0; z-index: 5; background: var(--scrim); }\n.drawer {\n  position: fixed;\n  z-index: 6;\n  top: 0;\n  ri",
"ght: 0;\n  bottom: 0;\n  width: min(460px, 100vw);\n  display: flex;\n  flex-direction: column;\n  background: var(--surface);\n  color: var(--fg);\n  box-shadow: var(--shadow-3);\n  font-family: var(--font);\n  font-size: 14px;\n  animation: drawer-in .18s ease-out;\n}\n@keyframes drawer-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }\n.drawer-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 4px 24px; flex: none; }\n.drawer-head h2 { margin: 0; flex: 1; font-size: 20px; font-weight: 400; }\n.drawer-intro { margin: 0; padding: 0 24px 12px; color: var(--fg-2); font-size: 13px; line-height: 1.5; flex: none; }\n.drawer-body { flex: 1; overflow-y: auto; padding: 4px 24px 16px; }\n.col-row {\n  display: grid;\n  gap: 10px;\n  margin-bottom: 12px;\n  padding: 12px 12px 10px 14px;\n  border: 1px solid var(--border);\n  border-radius: 16px;\n  background: var(--surface);\n}\n.row-head { display: flex; align-items: center; gap: 2px; }\n.row-head .row-num",
" {\n  width: 22px;\n  height: 22px;\n  margin-right: 8px;\n  border-radius: 50%;\n  background: var(--col);\n  color: var(--fg-2);\n  font-size: 12px;\n  line-height: 22px;\n  text-align: center;\n  flex: none;\n}\n.row-head .row-title { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.field { display: grid; gap: 4px; }\n.field-label { font-size: 12px; color: var(--fg-2); }\n.text-input {\n  width: 100%;\n  height: 38px;\n  padding: 0 12px;\n  border: 1px solid var(--border-strong);\n  border-radius: 8px;\n  background: var(--surface);\n  color: var(--fg);\n  font: inherit;\n  font-size: 14px;\n}\n.text-input:focus-visible { outline: 2px solid var(--focus); outline-offset: -1px; border-color: transparent; }\n.field-help { font-size: 12px; color: var(--fg-3); }\n.check { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--fg-2); cursor: pointer; }\n.check input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }\n",
".add-col { width: 100%; height: 44px; border-radius: 16px; border: 1.5px dashed var(--border-strong); color: var(--accent); font-weight: 500; }\n.add-col:hover { background: var(--hover); }\n.drawer-foot {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 12px 20px 16px 24px;\n  border-top: 1px solid var(--border);\n  flex: none;\n}\n.drawer-foot .note { flex: 1; font-size: 12px; color: var(--fg-3); line-height: 1.45; }\n.form-error { color: var(--danger); font-size: 13px; padding: 0 24px 8px; flex: none; }\n.form-error:empty { display: none; }\n\n/* ── Card editor ── */\n\n.dialog {\n  position: fixed;\n  z-index: 6;\n  top: 50%;\n  left: 50%;\n  transform: translate(-50%, -50%);\n  width: min(480px, calc(100vw - 32px));\n  max-height: calc(100vh - 32px);\n  display: flex;\n  flex-direction: column;\n  border-radius: 24px;\n  background: var(--surface);\n  color: var(--fg);\n  box-shadow: var(--shadow-3);\n  font-family: var(--font);\n  font-size: 14px;\n  animation: dialog-in .16s ease-out;\n}\n@keyf",
"rames dialog-in { from { opacity: 0; transform: translate(-50%, -47%); } to { opacity: 1; transform: translate(-50%, -50%); } }\n.dialog-head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 2px 24px; flex: none; }\n.dialog-head h2 { margin: 0; flex: 1; font-size: 20px; font-weight: 400; }\n.dialog-body { display: grid; gap: 18px; padding: 10px 24px 18px; overflow-y: auto; }\n.dialog-foot {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 12px 20px 16px 24px;\n  border-top: 1px solid var(--border);\n  flex: none;\n}\n.dialog-foot .note { flex: 1; font-size: 12px; color: var(--fg-3); line-height: 1.45; }\n.text-area { height: auto; min-height: 80px; padding: 9px 12px; line-height: 1.45; resize: vertical; }\n.help-row { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; font-size: 12px; color: var(--fg-3); }\n.help-row .subject-ref { color: var(--fg-2); overflow-wrap: anywhere; }\n.link-btn { color: var(--accent); font-size: 12px; font-weight: 500; ",
"border-radius: 4px; }\n.link-btn:hover { text-decoration: underline; }\n.swatches { display: flex; flex-wrap: wrap; gap: 10px; padding: 2px 0; }\n.swatch { position: relative; width: 28px; height: 28px; cursor: pointer; }\n.swatch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }\n.swatch-dot {\n  display: block;\n  width: 100%;\n  height: 100%;\n  border-radius: 50%;\n  background: var(--stripe);\n  transition: box-shadow .12s;\n}\n.swatch[data-colour=\"none\"] .swatch-dot {\n  background: linear-gradient(135deg, transparent 45%, var(--border-strong) 45%, var(--border-strong) 55%, transparent 55%), var(--surface);\n  box-shadow: inset 0 0 0 1.5px var(--border-strong);\n}\n.swatch input:checked + .swatch-dot { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--fg-2); }\n.swatch[data-colour=\"none\"] input:checked + .swatch-dot {\n  box-shadow: inset 0 0 0 1.5px var(--border-strong), 0 0 0 2px var(--surface), 0 0 0 4px var(--fg-2);\n}\n.swatch input:fo",
"cus-visible + .swatch-dot { outline: 2px solid var(--focus); outline-offset: 5px; }\n\n.sr-only {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  padding: 0;\n  margin: -1px;\n  overflow: hidden;\n  clip: rect(0 0 0 0);\n  white-space: nowrap;\n  border: 0;\n}\n`;\n\n  // ── Dock ─────────────────────────────────────────────────────────────\n\n  const DOCK = `\n:host { z-index: 2147482999 !important; }\n\n.dock {\n  position: fixed;\n  left: 16px;\n  bottom: 16px;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-family: var(--font);\n  font-size: 14px;\n  -webkit-font-smoothing: antialiased;\n}\n.dock.right { left: auto; right: 72px; }\n.dock[hidden] { display: none; }\n.pill {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  height: 40px;\n  padding: 0 16px 0 12px;\n  border-radius: 20px;\n  background: var(--surface);\n  color: var(--fg);\n  box-shadow: var(--shadow-2);\n  font-weight: 500;\n  white-space: nowrap;\n  max-width: 320px;\n}\n.pill:hover { box-shadow: var(--shadow-3); background",
"-image: linear-gradient(var(--hover), var(--hover)); }\n.pill .icon { color: var(--accent); }\n.pill.on { background-color: var(--accent-soft); color: var(--on-accent-soft); }\n.pill.on .icon { color: inherit; }\n.pill .pill-label { overflow: hidden; text-overflow: ellipsis; }\n.pill .caret { margin: 0 -6px 0 -2px; color: inherit; }\n.pill-compact { padding: 0 14px 0 10px; }\n.pill.busy { opacity: .7; }\n`;\n\n  ns.styles = { board: BASE + BOARD, dock: BASE + DOCK };\n})();\n</script>\n<script>\n// src/content/note-editor.js\n// ─────────────────────────────────────────────────────────────────────\n// The formatted note editor\n//\n// An editable area with a toolbar: text style (normal, three headings),\n// bold, italic, strike-through, bulleted, numbered and check lists with\n// three levels of nesting, links, and clear formatting.\n//\n// The editable area is a flat column of blocks - one <div class=\"blk\">\n// per paragraph, heading or list item, its kind and indent in data\n// attributes, bullets, numbers ",
"and boxes drawn by the stylesheet. Bold,\n// italic, strike-through and links use the browser's own editing\n// commands, which handle them well. Lists and headings do not use them:\n// the browser's list commands nest elements in ways that are hard to read\n// back, so blocks are restyled here directly instead. What is saved is\n// never this markup: it is read back into the note-format model, which\n// only knows what the toolbar can make.\n//\n// Pasted text keeps the formatting the model can hold - from Word, Google\n// Docs, a web page, an email, Excel, or Markdown from a chat assistant -\n// read by note-format's own reader, so a page copied from the web brings\n// its bold and lists but never its styles, images or scripts. Ctrl+Shift+V\n// pastes the text alone. Dropped text is not taken at all.\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n  const { h, icon, openMenu, closeMenu",
" } = ns.ui;\n  const fmt = ns.noteFormat;\n\n  const STYLES = [['p', 'Normal text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3']];\n  const STYLE_LABEL = Object.fromEntries(STYLES);\n  const INDENT_PX = 24;\n\n  // Typed at the start of a paragraph and followed by a space, these turn\n  // it into a list or heading - the shortcuts most editors share.\n  const AUTO = [\n    [/^[-*•]$/, { type: 'ul' }],\n    [/^1[.)]$/, { type: 'ol' }],\n    [/^\\[ ?\\]$/, { type: 'check' }],\n    [/^\\[[xX]\\]$/, { type: 'check', checked: true }],\n    [/^#$/, { type: 'h1' }],\n    [/^##$/, { type: 'h2' }],\n    [/^###$/, { type: 'h3' }],\n  ];\n\n  // ── Model ↔ markup ───────────────────────────────────────────────────\n\n  function setBlock(el, type, level = 0, checked = false) {\n    el.dataset.type = type;\n    if (fmt.LISTS.has(type)) el.dataset.level = String(level);\n    else delete el.dataset.level;\n    if (type === 'check') el.dataset.checked = checked ? '1' : '0';\n    else delete el.dataset.checked;\n  ",
"}\n\n  function inlineNodes(runs) {\n    const out = [];\n    for (let i = 0; i < runs.length;) {\n      const href = runs[i].href || '';\n      const group = [];\n      let j = i;\n      while (j < runs.length && (runs[j].href || '') === href) {\n        let node = document.createTextNode(runs[j].text);\n        for (const m of ['s', 'i', 'b']) {\n          if (!runs[j][m]) continue;\n          const w = document.createElement(m);\n          w.appendChild(node);\n          node = w;\n        }\n        group.push(node);\n        j++;\n      }\n      if (href) out.push(h('a', { href, title: href }, group));\n      else out.push(...group);\n      i = j;\n    }\n    return out;\n  }\n\n  function blockEl(b) {\n    const el = document.createElement('div');\n    el.className = 'blk';\n    setBlock(el, b.type, b.level, b.checked);\n    const kids = inlineNodes(b.runs);\n    if (kids.length) el.append(...kids);\n    else el.appendChild(document.createElement('br'));\n    return el;\n  }\n\n  function styleMarks(style) {\n    co",
"nst s = String(style || '').toLowerCase();\n    return {\n      b: /font-weight\\s*:\\s*(bold|bolder|[6-9]00)/.test(s),\n      i: /font-style\\s*:\\s*italic/.test(s),\n      s: /text-decoration(-line)?\\s*:[^;]*line-through/.test(s),\n    };\n  }\n\n  const NESTED_BLOCKS = new Set(['div', 'p', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']);\n\n  // Reads one block element - and anything the browser may have left\n  // inside it, such as a <br> or a nested <div> - into model blocks.\n  function readBlock(el, out) {\n    const type = fmt.TYPES.has(el.dataset.type) ? el.dataset.type : 'p';\n    const level = Number(el.dataset.level) || 0;\n    const first = out.length;\n    let cur = fmt.block(type, [], { level, checked: el.dataset.checked === '1' });\n    out.push(cur);\n    const next = () => {\n      cur = fmt.block(type, [], { level });\n      out.push(cur);\n    };\n    (function walk(node, marks) {\n      for (const child of node.childNodes) {\n        if (child.nodeType === 3) {\n  ",
"        if (child.data) cur.runs.push({ text: child.data.replace(/\\u00a0/g, ' ').replace(/\\n/g, ' '), ...marks });\n          continue;\n        }\n        if (child.nodeType !== 1) continue;\n        const tag = child.tagName.toLowerCase();\n        if (tag === 'br') { next(); continue; }\n        if (NESTED_BLOCKS.has(tag)) {\n          if (cur.runs.length) next();\n          walk(child, marks);\n          next();\n          continue;\n        }\n        const m = { ...marks };\n        if (tag === 'b' || tag === 'strong') m.b = true;\n        else if (tag === 'i' || tag === 'em') m.i = true;\n        else if (tag === 's' || tag === 'strike' || tag === 'del') m.s = true;\n        else if (tag === 'a') {\n          const href = fmt.safeHref(child.getAttribute('href'));\n          if (href) m.href = href;\n        } else if (tag === 'span' || tag === 'font') {\n          const st = styleMarks(child.getAttribute('style'));\n          if (st.b) m.b = true;\n          if (st.i) m.i = true;\n          if (st.s) ",
"m.s = true;\n        }\n        walk(child, m);\n      }\n    })(el, {});\n    // A <br> or nested block at the very end leaves an empty block behind:\n    // that is the browser's placeholder, not a new line.\n    while (out.length - 1 > first && !out[out.length - 1].runs.some(r => r.text)) out.pop();\n  }\n\n  function readDoc(editor) {\n    const blocks = [];\n    for (const node of editor.childNodes) {\n      if (node.nodeType === 1 && node.classList.contains('blk')) readBlock(node, blocks);\n      else if (node.nodeType === 3 && node.data.trim()) blocks.push(fmt.block('p', [{ text: node.data.replace(/ /g, ' ') }]));\n      else if (node.nodeType === 1 && node.tagName !== 'BR') readBlock(node, blocks);\n    }\n    return fmt.normaliseDoc(blocks);\n  }\n\n  // ── Selection ────────────────────────────────────────────────────────\n\n  function create({ root, onChange }) {\n    const els = {};\n    let saved = null;     // the last selection inside the editor\n    let editable = false;\n    let plainNext = fal",
"se; // Ctrl+Shift+V: the next paste is text alone\n    let pasteUndo = [];    // how the text was before each formatted paste, latest last\n\n    const selection = () => (root.getSelection ? root.getSelection() : document.getSelection());\n\n    function range() {\n      const sel = selection();\n      if (!sel || !sel.rangeCount) return null;\n      const r = sel.getRangeAt(0);\n      return els.editor.contains(r.startContainer) && els.editor.contains(r.endContainer) ? r : null;\n    }\n\n    function select(r) {\n      const sel = window.getSelection();\n      sel.removeAllRanges();\n      sel.addRange(r);\n    }\n\n    // Toolbar buttons do not take focus from the text, but the style menu\n    // and the link field do; the selection they were opened on is put\n    // back before the change is applied.\n    function restore() {\n      // The selection can still be in the text while the focus is not -\n      // on the style button the menu handed it back to, say - and typing\n      // would then go nowhere. ",
"Both are put back.\n      const keep = range() || (saved && els.editor.contains(saved.startContainer) ? saved : null);\n      if (root.activeElement !== els.editor) els.editor.focus({ preventScroll: true });\n      if (keep) {\n        try { select(keep.cloneRange ? keep.cloneRange() : keep); } catch { /* the text changed underneath */ }\n      }\n    }\n\n    function blockOf(node) {\n      let n = node;\n      if (n === els.editor) return null;\n      while (n && n.parentNode !== els.editor) n = n.parentNode;\n      return n && n.nodeType === 1 ? n : null;\n    }\n\n    function rangeBlocks(r) {\n      const kids = [...els.editor.children];\n      const edge = (container, offset, end) => {\n        if (container === els.editor) return kids[Math.min(kids.length - 1, Math.max(0, offset - (end ? 1 : 0)))];\n        return blockOf(container);\n      };\n      const a = edge(r.startContainer, r.startOffset, false);\n      const b = edge(r.endContainer, r.endOffset, true);\n      const i = kids.indexOf(a);\n     ",
" const j = kids.indexOf(b);\n      if (i < 0 || j < 0) return a ? [a] : [];\n      return kids.slice(Math.min(i, j), Math.max(i, j) + 1);\n    }\n\n    function caretAtBlockStart(r, blk) {\n      if (!r || !r.collapsed || !blk) return false;\n      const pre = document.createRange();\n      pre.selectNodeContents(blk);\n      pre.setEnd(r.startContainer, r.startOffset);\n      return pre.toString() === '';\n    }\n\n    function placeCaret(node, offset) {\n      const r = document.createRange();\n      r.setStart(node, offset);\n      r.collapse(true);\n      select(r);\n    }\n\n    // ── Keeping the markup tidy ──────────────────────────────────────────\n\n    // Each list item may be at most one level deeper than the one above.\n    function fixLevels() {\n      let prev = -1;\n      for (const blk of els.editor.children) {\n        if (fmt.LISTS.has(blk.dataset.type)) {\n          const lvl = Math.max(0, Math.min(fmt.MAX_LEVEL, Number(blk.dataset.level) || 0, prev + 1));\n          blk.dataset.level = String(",
"lvl);\n          prev = lvl;\n        } else {\n          prev = -1;\n        }\n      }\n    }\n\n    // The browser sometimes leaves text, a <br> or a plain <div> directly\n    // in the editor (after select-all and delete, say), and wraps merged\n    // text in <span style=\"font-size…\"> when two blocks of different sizes\n    // join. Both are put right here, keeping the caret where it was.\n    function tidy() {\n      const sel = selection();\n      const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;\n      const keep = r ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : null;\n      let moved = false;\n\n      for (const node of [...els.editor.childNodes]) {\n        if (node.nodeType === 1 && node.classList.contains('blk') && node.dataset.type) continue;\n        if (node.nodeType === 1 && /^(DIV|P|H1|H2|H3)$/.test(node.tagName)) {\n          node.classList.add('blk');\n          setBlock(node, /^H[123]$/.test(node.tagName) ? node.tagName.toLowerCase() : 'p');\n          conti",
"nue;\n        }\n        if (node.nodeType === 3 && !node.data.trim() && !(keep && (keep[0] === node || keep[2] === node))) {\n          node.remove();\n          continue;\n        }\n        const blk = blockEl(fmt.block('p'));\n        blk.replaceChildren();\n        els.editor.insertBefore(blk, node);\n        if (node.nodeType === 1 && node.tagName === 'BR') {\n          blk.appendChild(node);\n        } else {\n          // Gather this and any following inline neighbours into one block.\n          let n = node;\n          while (n && !(n.nodeType === 1 && (n.classList.contains('blk') || NESTED_BLOCKS.has(n.tagName.toLowerCase())))) {\n            const following = n.nextSibling;\n            blk.appendChild(n);\n            n = following;\n          }\n        }\n        moved = true;\n      }\n\n      for (const span of [...els.editor.querySelectorAll('span[style], font')]) {\n        const st = styleMarks(span.getAttribute('style'));\n        if (st.b || st.i || st.s) continue;\n        span.replaceWith",
"(...span.childNodes);\n        moved = true;\n      }\n      for (const a of els.editor.querySelectorAll('a[href]')) {\n        const href = fmt.safeHref(a.getAttribute('href'));\n        if (!href) a.replaceWith(...a.childNodes);\n        else if (a.title !== href) a.title = href;\n      }\n      if (!els.editor.children.length) {\n        els.editor.appendChild(blockEl(fmt.block('p')));\n        placeCaret(els.editor.firstChild, 0);\n        moved = false;\n      }\n      if (moved && keep && keep[0].isConnected && keep[2].isConnected) {\n        try {\n          const back = document.createRange();\n          back.setStart(keep[0], keep[1]);\n          back.setEnd(keep[2], keep[3]);\n          select(back);\n        } catch { /* positions no longer valid */ }\n      }\n      fixLevels();\n      updateEmpty();\n    }\n\n    function updateEmpty() {\n      const kids = els.editor.children;\n      const empty = kids.length <= 1 && (!kids[0] || (kids[0].dataset.type === 'p' && !kids[0].textContent));\n      els.ed",
"itor.dataset.empty = empty ? '1' : '0';\n    }\n\n    function changed() {\n      pasteUndo = [];\n      tidy();\n      onChange();\n      refreshToolbar();\n    }\n\n    // ── Commands ─────────────────────────────────────────────────────────\n\n    function inline(cmd) {\n      if (!editable) return;\n      restore();\n      document.execCommand(cmd);\n      refreshToolbar();\n    }\n\n    // Applies a block type to every block the selection touches - or, if\n    // they all have it already, turns them back into paragraphs.\n    function blockType(type, { checked = false } = {}) {\n      if (!editable) return;\n      restore();\n      const r = range();\n      if (!r) return;\n      const blocks = rangeBlocks(r);\n      const off = blocks.every(b => b.dataset.type === type) && type !== 'p';\n      for (const b of blocks) {\n        const was = b.dataset.type;\n        const level = fmt.LISTS.has(was) ? Number(b.dataset.level) || 0 : 0;\n        setBlock(b, off ? 'p' : type, level, type === 'check' && was === 'chec",
"k' ? b.dataset.checked === '1' : checked);\n      }\n      changed();\n    }\n\n    function indent(delta) {\n      if (!editable) return false;\n      const r = range();\n      if (!r) return false;\n      const blocks = rangeBlocks(r).filter(b => fmt.LISTS.has(b.dataset.type));\n      if (!blocks.length) return false;\n      for (const b of blocks) b.dataset.level = String(Math.max(0, Math.min(fmt.MAX_LEVEL, (Number(b.dataset.level) || 0) + delta)));\n      changed();\n      return true;\n    }\n\n    function toggleCheck(blk) {\n      if (!editable || !blk || blk.dataset.type !== 'check') return;\n      blk.dataset.checked = blk.dataset.checked === '1' ? '0' : '1';\n      changed();\n    }\n\n    function clearFormatting() {\n      if (!editable) return;\n      restore();\n      document.execCommand('removeFormat');\n      document.execCommand('unlink');\n      const r = range();\n      if (r) for (const b of rangeBlocks(r)) setBlock(b, 'p');\n      changed();\n    }\n\n    function anchorAt(r) {\n      let n = r &",
"& r.startContainer;\n      while (n && n !== els.editor) {\n        if (n.nodeType === 1 && n.tagName === 'A') return n;\n        n = n.parentNode;\n      }\n      return null;\n    }\n\n    // ── Links ────────────────────────────────────────────────────────────\n\n    function openLink() {\n      if (!editable) return;\n      const r = range() || saved;\n      if (!r) return;\n      saved = r.cloneRange();\n      const a = anchorAt(r);\n      els.linkInput.value = a ? a.getAttribute('href') : '';\n      els.linkError.textContent = '';\n      els.linkRemove.hidden = !a;\n      els.linkbar.hidden = false;\n      els.linkInput.focus();\n      els.linkInput.select();\n    }\n\n    function closeLink({ refocus = true } = {}) {\n      if (els.linkbar.hidden) return;\n      els.linkbar.hidden = true;\n      if (refocus) restore();\n    }\n\n    function applyLink() {\n      const href = fmt.safeHref(els.linkInput.value);\n      if (!href) {\n        els.linkError.textContent = 'That is not a web or email address.';\n       ",
" return;\n      }\n      closeLink();\n      const r = range();\n      if (!r) return;\n      const a = anchorAt(r);\n      if (r.collapsed && a) {\n        a.setAttribute('href', href);\n        a.title = href;\n      } else if (r.collapsed) {\n        // Nothing selected: the address itself becomes the link text.\n        const text = href.replace(/^mailto:/, '');\n        document.execCommand('insertText', false, text);\n        const after = range();\n        if (after) {\n          const sel = document.createRange();\n          sel.setStart(after.startContainer, Math.max(0, after.startOffset - text.length));\n          sel.setEnd(after.startContainer, after.startOffset);\n          select(sel);\n          document.execCommand('createLink', false, href);\n          const end = range();\n          if (end) { end.collapse(false); select(end); }\n        }\n      } else {\n        document.execCommand('createLink', false, href);\n      }\n      changed();\n    }\n\n    function removeLink() {\n      closeLink();\n ",
"     const r = range();\n      const a = anchorAt(r);\n      if (a) {\n        const sel = document.createRange();\n        sel.selectNodeContents(a);\n        select(sel);\n      }\n      document.execCommand('unlink');\n      changed();\n    }\n\n    // ── Toolbar ──────────────────────────────────────────────────────────\n\n    const buttons = {};\n    const tbButton = (key, label, iconName, onClick, toggle = true) => {\n      const b = h('button', {\n        class: 'tb-btn', type: 'button', title: label, 'aria-label': label,\n        'aria-pressed': toggle ? 'false' : null, dataset: { key: `fmt-${key}` },\n        // Keeps the focus - and so the selection - in the text.\n        onmousedown: e => e.preventDefault(),\n        onclick: () => onClick(),\n      }, icon(iconName, 20));\n      buttons[key] = b;\n      return b;\n    };\n    const sep = () => h('span', { class: 'tb-sep', 'aria-hidden': 'true' });\n\n    els.styleLabel = h('span', { class: 'tb-style-label', text: 'Normal text' });\n    els.style = h(",
"'button', {\n      class: 'tb-style', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',\n      'aria-label': 'Text style', title: 'Text style', dataset: { key: 'fmt-style' },\n      onmousedown: e => e.preventDefault(),\n      onclick: () => {\n        if (!editable) return;\n        const r = range();\n        if (r) saved = r.cloneRange();\n        const cur = currentType();\n        openMenu(root, els.style, STYLES.map(([type, label]) => ({\n          label, key: `style:${type}`, checked: cur === type,\n          onSelect: () => blockType(type),\n        })), { label: 'Text style' });\n      },\n    }, els.styleLabel, icon('caret', 18));\n\n    els.toolbar = h('div', { class: 'ne-toolbar', role: 'toolbar', 'aria-label': 'Formatting' },\n      els.style,\n      sep(),\n      tbButton('bold', 'Bold (Ctrl+B)', 'bold', () => inline('bold')),\n      tbButton('italic', 'Italic (Ctrl+I)', 'italic', () => inline('italic')),\n      tbButton('strike', 'Strike-through', 'strike', () => inline('str",
"ikeThrough')),\n      sep(),\n      tbButton('ul', 'Bulleted list (Ctrl+Shift+8)', 'bullets', () => blockType('ul')),\n      tbButton('ol', 'Numbered list (Ctrl+Shift+7)', 'numbers', () => blockType('ol')),\n      tbButton('check', 'Checklist (Ctrl+Shift+9)', 'checklist', () => blockType('check')),\n      tbButton('outdent', 'Less indent (Shift+Tab)', 'outdent', () => { restore(); indent(-1); }, false),\n      tbButton('indent', 'More indent (Tab)', 'indent', () => { restore(); indent(1); }, false),\n      sep(),\n      tbButton('link', 'Link (Ctrl+K)', 'link', () => openLink()),\n      tbButton('clear', 'Clear formatting', 'clear', () => clearFormatting(), false));\n\n    els.linkInput = h('input', {\n      class: 'text-input', type: 'text', placeholder: 'Web address or email', 'aria-label': 'Link address',\n      spellcheck: 'false', dataset: { key: 'fmt-link-input' },\n      onkeydown: e => {\n        if (e.key === 'Enter') { e.preventDefault(); applyLink(); }\n        if (e.key === 'Escape') { e.p",
"reventDefault(); e.stopPropagation(); closeLink(); }\n      },\n    });\n    els.linkError = h('span', { class: 'link-error', role: 'alert' });\n    els.linkRemove = h('button', { class: 'btn btn-text', type: 'button', text: 'Remove link', dataset: { key: 'fmt-link-remove' }, onclick: removeLink });\n    els.linkbar = h('div', { class: 'ne-linkbar', hidden: true },\n      icon('link', 18), els.linkInput,\n      h('button', { class: 'btn btn-tonal', type: 'button', text: 'Apply', dataset: { key: 'fmt-link-apply' }, onclick: applyLink }),\n      els.linkRemove,\n      h('button', { class: 'btn btn-text', type: 'button', text: 'Cancel', onclick: () => closeLink() }),\n      els.linkError);\n\n    function currentType() {\n      const r = range() || saved;\n      const blk = r && blockOf(r.startContainer);\n      return blk ? blk.dataset.type || 'p' : 'p';\n    }\n\n    function refreshToolbar() {\n      const r = range();\n      if (!r) return;\n      const type = currentType();\n      els.styleLabel.textConte",
"nt = STYLE_LABEL[type] || 'Normal text';\n      for (const [key, cmd] of [['bold', 'bold'], ['italic', 'italic'], ['strike', 'strikeThrough']]) {\n        let on = false;\n        try { on = document.queryCommandState(cmd); } catch { /* not supported */ }\n        buttons[key].setAttribute('aria-pressed', String(on));\n      }\n      for (const t of ['ul', 'ol', 'check']) buttons[t].setAttribute('aria-pressed', String(type === t));\n      buttons.link.setAttribute('aria-pressed', String(!!anchorAt(r)));\n    }\n\n    // ── The editable area ────────────────────────────────────────────────\n\n    els.editor = h('div', {\n      class: 'ne-body', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Note',\n      spellcheck: 'true', dataset: { key: 'note-body', empty: '1' },\n    });\n\n    els.editor.addEventListener('keydown', e => {\n      if (!editable) return;\n      const mod = e.ctrlKey || e.metaKey;\n      const r = range();\n      const blk = r && blockOf(r.startContainer);\n\n      if (mod && !e.a",
"ltKey && !e.shiftKey && e.key.toLowerCase() === 'z' && pasteUndo.length) {\n        e.preventDefault();\n        undoPaste();\n        return;\n      }\n      if (mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'v') {\n        // The paste event follows straight away, in this same task.\n        plainNext = true;\n        setTimeout(() => { plainNext = false; }, 0);\n        return;\n      }\n      if (mod && !e.altKey && e.shiftKey && /^Digit[789]$/.test(e.code)) {\n        e.preventDefault();\n        blockType({ Digit7: 'ol', Digit8: 'ul', Digit9: 'check' }[e.code]);\n        return;\n      }\n      if (mod && !e.shiftKey && !e.altKey) {\n        const k = e.key.toLowerCase();\n        if (k === 'k') { e.preventDefault(); openLink(); return; }\n        if (k === 'u') { e.preventDefault(); return; } // no underline in the model\n        if (e.key === 'Enter' && blk && blk.dataset.type === 'check') { e.preventDefault(); toggleCheck(blk); return; }\n      }\n      if (e.key === 'Tab' && !mod && !e",
".altKey && blk && fmt.LISTS.has(blk.dataset.type)) {\n        e.preventDefault();\n        indent(e.shiftKey ? -1 : 1);\n        return;\n      }\n      if (e.key === 'Enter' && !mod && !e.altKey && !e.isComposing) {\n        // An empty list item ends the list; Shift+Enter is a new line like\n        // any other, since the model has no line breaks inside a block.\n        if (blk && fmt.LISTS.has(blk.dataset.type) && !blk.textContent) {\n          e.preventDefault();\n          const lvl = Number(blk.dataset.level) || 0;\n          if (lvl > 0) blk.dataset.level = String(lvl - 1);\n          else setBlock(blk, 'p');\n          changed();\n          return;\n        }\n        if (e.shiftKey) {\n          e.preventDefault();\n          document.execCommand('insertParagraph');\n          return;\n        }\n      }\n      if (e.key === 'Backspace' && !mod && blk && blk.dataset.type !== 'p' && caretAtBlockStart(r, blk)) {\n        // At the start of a list item or heading, Backspace undoes the\n        // form",
"atting before it starts joining lines.\n        e.preventDefault();\n        const lvl = Number(blk.dataset.level) || 0;\n        if (fmt.LISTS.has(blk.dataset.type) && lvl > 0) blk.dataset.level = String(lvl - 1);\n        else setBlock(blk, 'p');\n        changed();\n      }\n    });\n\n    els.editor.addEventListener('input', e => {\n      if (e.inputType === 'insertText' && (e.data === ' ' || e.data === ' ')) autoformat();\n      if (e.inputType === 'insertParagraph') {\n        // The new block is a copy of the one it was split from: a ticked\n        // box and a heading should not carry on into an empty new line.\n        const r = range();\n        const blk = r && blockOf(r.startContainer);\n        if (blk && !blk.textContent) {\n          if (blk.dataset.type === 'check') blk.dataset.checked = '0';\n          if (/^h[123]$/.test(blk.dataset.type)) setBlock(blk, 'p');\n        }\n      }\n      if (/^delete/.test(e.inputType) && els.editor.children.length === 1 && !els.editor.textContent) {\n     ",
"   // Everything deleted: the note starts again from normal text.\n        setBlock(els.editor.firstElementChild, 'p');\n      }\n      changed();\n    });\n\n    function autoformat() {\n      const r = range();\n      if (!r || !r.collapsed) return;\n      const blk = blockOf(r.startContainer);\n      if (!blk || blk.dataset.type !== 'p') return;\n      const pre = document.createRange();\n      pre.selectNodeContents(blk);\n      pre.setEnd(r.startContainer, r.startOffset);\n      const m = /^(\\S{1,3})[  ]$/.exec(pre.toString());\n      const rule = m && AUTO.find(([re]) => re.test(m[1]));\n      if (!rule) return;\n      select(pre);\n      document.execCommand('delete');\n      setBlock(blk, rule[1].type, 0, !!rule[1].checked);\n    }\n\n    els.editor.addEventListener('paste', e => {\n      e.preventDefault();\n      if (!editable) return;\n      const data = e.clipboardData;\n      const text = (data && data.getData('text/plain')) || '';\n      const plain = plainNext;\n      plainNext = false;\n      const",
" doc = plain ? null : fmt.pasteDoc({ html: data && data.getData('text/html'), text });\n      // Text with nothing to format goes in the way typing does, so the\n      // browser's own undo takes it back: a single line as copied, spaces\n      // and all; more than that as the HTML reads (a table's \" | \", not\n      // its tabs).\n      const line = text.replace(/[\\r\\n]+$/, '');\n      if (doc && fmt.hasFormatting(doc)) insertDoc(doc);\n      else if (doc && !(doc.length === 1 && line && !/[\\r\\n\\t]/.test(line))) insertPlain(fmt.docText(doc));\n      else insertPlain(doc ? line : text);\n      revealCaret();\n    });\n    els.editor.addEventListener('drop', e => {\n      // Dropped HTML would bring its own markup; dropped files have nowhere to go.\n      e.preventDefault();\n    });\n\n    function insertPlain(text) {\n      const lines = String(text).replace(/\\r\\n?/g, '\\n').split('\\n');\n      lines.forEach((line, i) => {\n        if (i) document.execCommand('insertParagraph');\n        if (line) document",
".execCommand('insertText', false, line);\n      });\n    }\n\n    // ── Formatted paste ──────────────────────────────────────────────────\n    //\n    // The blocks go in directly - the browser's editing commands would\n    // nest and restyle them - with the text after the caret carried to\n    // the end of what was pasted. The browser's undo does not know about\n    // that, so Ctrl+Z straight afterwards puts back a copy taken first -\n    // one paste at a time, until anything else changes the text.\n\n    // Empty text and empty marks left behind by cutting a block in two;\n    // also the <br> that holds an empty block open, put back later if\n    // the block is still empty.\n    function prune(el) {\n      for (const n of [...el.childNodes]) {\n        if (n.nodeType === 3) { if (!n.data) n.remove(); continue; }\n        if (n.nodeType !== 1 || n.tagName === 'BR') { n.remove(); continue; }\n        prune(n);\n        if (!n.firstChild) n.remove();\n      }\n    }\n    const holdOpen = el => { if (!e",
"l.firstChild) el.appendChild(document.createElement('br')); };\n\n    function insertDoc(doc) {\n      if (!range()) restore();\n      if (!range()) return;\n      const undo = pasteUndo;\n      const before = snapshot();\n      if (!range().collapsed) document.execCommand('delete');\n      tidy();\n      const r = range();\n      if (!r) return;\n\n      let node = r.startContainer;\n      let offset = r.startOffset;\n      if (node === els.editor) {\n        const kids = els.editor.children;\n        const k = Math.min(offset, kids.length - 1);\n        node = kids[k];\n        offset = k < offset ? node.childNodes.length : 0;\n      }\n      const blk = blockOf(node);\n      if (!blk) return;\n\n      // Cut the block at the caret.\n      const cut = document.createRange();\n      cut.setStart(node, offset);\n      cut.setEnd(blk, blk.childNodes.length);\n      const after = cut.extractContents();\n      prune(after);\n      prune(blk);\n\n      const orig = { type: blk.dataset.type || 'p', level: Number(blk.data",
"set.level) || 0, checked: blk.dataset.checked === '1' };\n      // Lists pasted into a list go in at its level.\n      const base = fmt.LISTS.has(orig.type) ? orig.level : 0;\n      const levelOf = b => (fmt.LISTS.has(b.type) ? Math.min(fmt.MAX_LEVEL, b.level + base) : 0);\n\n      let last = blk;\n      let i = 0;\n      // The first line joins the text before the caret; on an empty line\n      // it also brings its kind (a heading, a list item) with it.\n      if (doc[0].type === 'p' || !blk.textContent) {\n        if (!blk.textContent && doc[0].type !== 'p') setBlock(blk, doc[0].type, levelOf(doc[0]), doc[0].checked);\n        blk.append(...inlineNodes(doc[0].runs));\n        i = 1;\n      }\n      for (; i < doc.length; i++) {\n        const el = blockEl({ ...doc[i], level: levelOf(doc[i]) });\n        last.after(el);\n        last = el;\n      }\n\n      // The text after the caret follows the pasted text - on a line of\n      // its own kind if the paste ended on a different kind of line.\n      const",
" kind = el => `${el.dataset.type}:${el.dataset.level || 0}`;\n      let target = last;\n      if (after.textContent && last !== blk && kind(last) !== `${orig.type}:${base}`) {\n        target = blockEl(fmt.block(orig.type, [], orig));\n        target.replaceChildren();\n        last.after(target);\n      }\n      prune(last);\n      const at = target === last ? last.childNodes.length : 0;\n      target.append(after);\n      holdOpen(blk);\n      holdOpen(last);\n      holdOpen(target);\n      if (target === last) placeCaret(last, at);\n      else placeCaret(last, last.firstChild.nodeName === 'BR' ? 0 : last.childNodes.length);\n\n      changed();\n      pasteUndo = [...undo.slice(-19), before];\n    }\n\n    // The editor's blocks, and the selection as text offsets within them.\n    function snapshot() {\n      const r = range();\n      return {\n        nodes: [...els.editor.childNodes].map(n => n.cloneNode(true)),\n        start: r && where(r.startContainer, r.startOffset),\n        end: r && where(r.endConta",
"iner, r.endOffset),\n      };\n    }\n\n    function where(node, offset) {\n      const kids = [...els.editor.childNodes];\n      if (node === els.editor) {\n        const k = Math.min(offset, kids.length - 1);\n        return k < 0 ? null : { b: k, o: k < offset ? kids[k].textContent.length : 0 };\n      }\n      const blk = blockOf(node);\n      if (!blk) return null;\n      const pre = document.createRange();\n      pre.selectNodeContents(blk);\n      pre.setEnd(node, offset);\n      return { b: kids.indexOf(blk), o: pre.toString().length };\n    }\n\n    function pointAt(p) {\n      const blk = p && els.editor.childNodes[p.b];\n      if (!blk) return null;\n      const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);\n      let left = p.o;\n      for (let n = walker.nextNode(); n; n = walker.nextNode()) {\n        if (left <= n.data.length) return [n, left];\n        left -= n.data.length;\n      }\n      return [blk, 0];\n    }\n\n    function undoPaste() {\n      const rest = pasteUndo.slice(0, -",
"1);\n      const snap = pasteUndo[pasteUndo.length - 1];\n      els.editor.replaceChildren(...snap.nodes);\n      const a = pointAt(snap.start);\n      const z = pointAt(snap.end);\n      if (a && z) {\n        const back = document.createRange();\n        back.setStart(...a);\n        back.setEnd(...z);\n        select(back);\n      }\n      changed();\n      pasteUndo = rest;\n      revealCaret();\n    }\n\n    // Scrolls the editor, if it has to, to show the caret.\n    function revealCaret() {\n      const r = range();\n      if (!r) return;\n      let at = r.getBoundingClientRect();\n      if (!at.height) {\n        const blk = blockOf(r.startContainer);\n        if (blk) at = blk.getBoundingClientRect();\n      }\n      const box = els.editor.getBoundingClientRect();\n      if (at.bottom > box.bottom - 8) els.editor.scrollTop += at.bottom - box.bottom + 24;\n      else if (at.top < box.top + 8) els.editor.scrollTop -= box.top - at.top + 24;\n    }\n\n    els.editor.addEventListener('click', e => {\n      const",
" a = e.target.closest && e.target.closest('a[href]');\n      if (a && (e.ctrlKey || e.metaKey)) {\n        e.preventDefault();\n        window.open(a.href, '_blank', 'noopener');\n        return;\n      }\n      // The box is drawn in the block's left padding, at its indent.\n      const blk = e.target.closest && e.target.closest('.blk[data-type=\"check\"]');\n      if (blk && editable) {\n        const x = e.clientX - blk.getBoundingClientRect().left;\n        const at = (Number(blk.dataset.level) || 0) * INDENT_PX;\n        if (x >= at && x < at + 26) toggleCheck(blk);\n      }\n    });\n\n    const onSelection = () => {\n      const r = range();\n      if (!r) return;\n      saved = r.cloneRange();\n      refreshToolbar();\n    };\n    document.addEventListener('selectionchange', onSelection);\n\n    // ── Search highlights ────────────────────────────────────────────────\n    //\n    // Painted with the CSS Custom Highlight API: ranges over the text,\n    // coloured by the stylesheet, with nothing added to t",
"he markup - so a\n    // highlight can never end up saved into the note.\n\n    let matchRanges = [];\n    const canHighlight = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';\n\n    // The editor's text with a line break between blocks, and where each\n    // text node sits in it.\n    function textIndex() {\n      const parts = [];\n      let text = '';\n      els.editor.childNodes.forEach((blk, b) => {\n        if (b) text += '\\n';\n        const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);\n        for (let n = walker.nextNode(); n; n = walker.nextNode()) {\n          parts.push({ node: n, start: text.length, end: text.length + n.data.length });\n          text += n.data;\n        }\n      });\n      return { text, parts };\n    }\n\n    function rangeFor(idx, start, end) {\n      const a = idx.parts.find(p => start >= p.start && start < p.end);\n      const b = idx.parts.find(p => end > p.start && end <= p.end);\n      if (!a || !b) return null;\n   ",
"   const r = document.createRange();\n      r.setStart(a.node, start - a.start);\n      r.setEnd(b.node, end - b.start);\n      return r;\n    }\n\n    function highlight(terms) {\n      clearHighlights();\n      if (!terms || !terms.length || !canHighlight()) return 0;\n      const idx = textIndex();\n      matchRanges = ns.searchLogic.findMatches(idx.text, terms).map(m => rangeFor(idx, m.start, m.end)).filter(Boolean);\n      if (matchRanges.length) CSS.highlights.set('gkb-match', new Highlight(...matchRanges));\n      return matchRanges.length;\n    }\n\n    // Marks one match as the current one and scrolls it into the middle\n    // third of the editor if it is out of view.\n    function showMatch(i) {\n      const r = matchRanges[i];\n      if (!r || !canHighlight()) return;\n      CSS.highlights.set('gkb-match-current', new Highlight(r));\n      const box = els.editor.getBoundingClientRect();\n      const at = r.getBoundingClientRect();\n      if (at.top < box.top + 24 || at.bottom > box.bottom - 24) {",
"\n        els.editor.scrollTop += at.top - box.top - box.height / 3;\n      }\n    }\n\n    function clearHighlights() {\n      matchRanges = [];\n      if (!canHighlight()) return;\n      CSS.highlights.delete('gkb-match');\n      CSS.highlights.delete('gkb-match-current');\n    }\n\n    // ── API ──────────────────────────────────────────────────────────────\n\n    function setDoc(doc) {\n      pasteUndo = [];\n      els.editor.replaceChildren(...fmt.normaliseDoc(doc).map(blockEl));\n      updateEmpty();\n    }\n\n    function setEditable(on, placeholder) {\n      editable = !!on;\n      els.editor.contentEditable = editable ? 'true' : 'false';\n      els.editor.dataset.placeholder = placeholder || 'Write here…';\n      els.editor.setAttribute('aria-disabled', String(!editable));\n      for (const b of [...els.toolbar.querySelectorAll('button')]) b.disabled = !editable;\n    }\n\n    function focus() {\n      els.editor.focus();\n      const first = els.editor.firstChild;\n      if (first) placeCaret(first, 0);\n  ",
"  }\n\n    function destroy() {\n      document.removeEventListener('selectionchange', onSelection);\n      clearHighlights();\n      closeMenu(root);\n    }\n\n    return {\n      element: els.editor,\n      toolbar: els.toolbar,\n      linkbar: els.linkbar,\n      setDoc,\n      getDoc: () => readDoc(els.editor),\n      setEditable,\n      focus,\n      destroy,\n      highlight,\n      showMatch,\n      clearHighlights,\n      matchCount: () => matchRanges.length,\n    };\n  }\n\n  ns.noteEditor = { create, readDoc };\n})();\n</script>\n<script>\n// addon/app/remote.js\n// ─────────────────────────────────────────────────────────────────────\n// The phone app's way to Gmail\n//\n// The Notes view (src/content/notes.js) talks to a notesStore. In the\n// extension that store asks Gmail through the background worker; here it\n// asks the script that served this page, through google.script.run, which\n// asks Gmail. Same shape, same answers, so the view runs unchanged.\n// Also the two other things the view expects to fin",
"d: `hooks` (the\n// account, and opening a message in Gmail) and `api` (which errors mean\n// the account needs attention - none do here).\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n  const fmt = ns.noteFormat;\n\n  // google.script.run as a promise. A refusal from the script arrives as\n  // \"not_allowed: …\", which the view knows to explain.\n  function call(fn, ...args) {\n    return new Promise((resolve, reject) => {\n      google.script.run\n        .withSuccessHandler(resolve)\n        .withFailureHandler(err => {\n          const text = String((err && err.message) || err || 'Something went wrong').replace(/^(Exception|Error):\\s*/, '');\n          const e = new Error(text.replace(/^not_allowed:\\s*/, ''));\n          if (/^not_allowed:/.test(text)) e.code = 'not_allowed';\n          reject(e);\n        })[fn](...args);\n    });\n  }\n\n  const S = {\n    label: '_Notes',\n    folders: []",
",\n    docs: new Map(), // message id → content, from a search or a save\n  };\n\n  ns.notesStore = {\n    labelName: () => S.label,\n    folders: () => S.folders,\n\n    async list(account, query) {\n      const r = await call('appList', query || '');\n      S.label = r.label;\n      S.folders = r.folders || [];\n      Object.keys(r.docs || {}).forEach(id => S.docs.set(id, r.docs[id]));\n      return { notes: r.notes, truncated: r.truncated, folders: S.folders };\n    },\n\n    // Messages never change, so a note's content, once read, is kept.\n    async body(note) {\n      if (S.docs.has(note.messageId)) return S.docs.get(note.messageId);\n      const doc = await call('appBody', note.messageId);\n      S.docs.set(note.messageId, doc);\n      return doc;\n    },\n\n    async save(account, previous, snap) {\n      const r = await call('appSave', previous ? previous.messageId : '', {\n        title: snap.title, doc: fmt.normaliseDoc(snap.doc), folderId: snap.folderId || '',\n      });\n      S.docs.set(r.note.mess",
"ageId, fmt.normaliseDoc(snap.doc));\n      return r.note;\n    },\n\n    async retire(note) { await call('appRetire', note.messageId); },\n    async restore(note) { await call('appRestore', note.messageId, note.folderId || ''); },\n\n    async move(note, folderId) {\n      await call('appMove', note.messageId, folderId || '');\n      note.folderId = folderId || '';\n    },\n\n    async createFolder(parent, title) {\n      const r = await call('appCreateFolder', parent ? parent.id : '', title);\n      S.folders = r.folders;\n      return r.folder;\n    },\n\n    async renameFolder(folder, title) {\n      S.folders = (await call('appRenameFolder', folder.id, title)).folders;\n    },\n\n    async deleteFolder(folder) {\n      S.folders = (await call('appDeleteFolder', folder.id)).folders;\n    },\n  };\n\n  ns.hooks = {\n    getAccount: () => '',\n    // The message in Gmail - which, on a phone, the Gmail app may offer to open.\n    openThread(threadId) {\n      window.open(`https://mail.google.com/mail/u/0/#all/${enco",
"deURIComponent(threadId)}`, '_blank', 'noopener');\n    },\n  };\n\n  ns.api = { STATE_CODES: new Set() };\n})();\n</script>\n<script>\n// src/content/notes.js\n// ─────────────────────────────────────────────────────────────────────\n// The notes view\n//\n// The board's second tab: folders on the left, then the notes in the\n// chosen folder, then the open note. Typing saves by itself a moment after\n// you stop, and again on switching notes, switching tabs or closing;\n// Ctrl+S saves at once. A note moves to another folder by dragging it onto\n// one, or from the folder button above the text.\n//\n// The board owns the overlay, the header and the account panels (setup,\n// connect); this file owns everything inside the body while the Notes tab\n// is showing. Its element is built once and kept, so that a board redraw\n// never pulls the text box out from under someone who is typing.\n//\n// The phone app (addon/app) runs this same view full-screen on a phone,\n// with a different way to Gmail behind notes",
"Store. A phone shows one pane\n// at a time - the list, or the open note - so the element says which\n// (data-view) and the note has a Back button, which only the phone's\n// stylesheet shows.\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (globalThis.gkb = globalThis.gkb || {});\n  const { h, icon, toast, openMenu } = ns.ui;\n  const { util, notesLogic, notesStore, hooks, api } = ns;\n  const fmt = ns.noteFormat;\n  const searchLogic = ns.searchLogic;\n\n  // How many search results get excerpts at once. Each needs the note's\n  // full text, which is one more request the first time.\n  const EXCERPT_LIMIT = 30;\n\n  // Long enough not to save mid-sentence (each save is a new message and\n  // a trashed old one), short enough that little is at risk.\n  const AUTOSAVE_MS = 2500;\n  const STALE_MS = 60 * 1000;\n\n  const N = {\n    ctx: null,          // { root, onStateError, onLoaded, closeBoard, barChanged }\n    notes: [],         ",
" // live notes, newest first (metadata only)\n    truncated: false,\n    query: '',\n    status: 'idle',     // idle | loading | ready | error\n    error: '',\n    loadedAt: 0,\n    loading: null,\n    current: null,      // the note being edited - see newCurrent()\n    chain: Promise.resolve(), // saves and moves run one after another\n    folders: [],        // notesLogic.folderTree(), from the last listing\n    folder: '',         // the folder shown; '' for all notes\n    folderEdit: null,   // { mode: 'new' | 'rename', parentId, folderId, value, error, busy }\n    dragKey: '',        // the note being dragged onto a folder\n    terms: [],          // searchLogic.queryTerms() of the search that is showing\n    hits: new Map(),    // `${messageId}|${terms}` → { count, excerpts }\n    findIndex: 0,       // which match in the open note is the current one\n  };\n\n  let saveTimer = 0;\n  let searchTimer = 0;\n  let findTimer = 0;\n  const els = {};\n\n  // ── Setup ──────────────────────────────────────────",
"──────────────────\n\n  function init(ctx) {\n    N.ctx = ctx;\n    N.view = '';\n    // Closing the tab mid-sentence would lose the last few seconds of\n    // typing; the browser's own \"Leave site?\" prompt is the only defence.\n    window.addEventListener('beforeunload', e => {\n      const c = N.current;\n      if (c && (c.dirty || c.saving)) {\n        e.preventDefault();\n        e.returnValue = '';\n      }\n    });\n  }\n\n  function element() {\n    if (els.wrap) return els.wrap;\n\n    els.search = h('input', {\n      type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes',\n      dataset: { key: 'notes-search' },\n      oninput: e => {\n        N.query = e.target.value;\n        clearTimeout(searchTimer);\n        searchTimer = setTimeout(() => load({ force: true }), 400);\n      },\n      onkeydown: e => {\n        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); load({ force: true }); }\n      },\n    });\n    els.items = h('div', { class: 'notes-items', role: 'li",
"st', 'aria-label': 'Notes' });\n    els.foot = h('div', { class: 'notes-foot' });\n    els.scope = h('div', { class: 'notes-scope' });\n\n    els.list = h('section', { class: 'notes-list', 'aria-label': 'Notes' },\n      h('div', { class: 'notes-tools' },\n        h('div', { class: 'search-box' }, icon('search', 18), els.search),\n        h('button', {\n          class: 'btn btn-tonal', type: 'button', dataset: { key: 'note-new' },\n          title: 'New note', onclick: () => newNote(),\n        }, icon('add', 18), 'New')),\n      els.scope,\n      els.items,\n      els.foot);\n\n    els.folderItems = h('div', { class: 'folder-items', role: 'list', 'aria-label': 'Folders' });\n    els.foldersPane = h('section', { class: 'notes-folders', 'aria-label': 'Folders' },\n      h('div', { class: 'folders-head' },\n        h('h2', { text: 'Folders' }),\n        h('button', {\n          class: 'icon-btn', type: 'button', title: 'New folder', 'aria-label': 'New folder',\n          dataset: { key: 'folder-new' }, oncl",
"ick: () => startFolderEdit({ mode: 'new', parentId: '' }),\n        }, icon('add', 20))),\n      els.folderItems);\n\n    els.editor = h('section', { class: 'note-editor', 'aria-label': 'Note' });\n    els.wrap = h('div', { class: 'notes' }, els.foldersPane, els.list, els.editor);\n    drawFolders();\n    drawList();\n    drawEditor();\n    return els.wrap;\n  }\n\n  // ── Loading ──────────────────────────────────────────────────────────\n\n  function isStale() {\n    return N.status !== 'ready' || Date.now() - N.loadedAt > STALE_MS;\n  }\n\n  function load({ force = false } = {}) {\n    if (N.loading) return N.loading;\n    if (!force && !isStale()) return Promise.resolve();\n    const query = N.query;\n    if (!N.notes.length) N.status = 'loading';\n    drawList();\n\n    N.loading = (async () => {\n      try {\n        const r = await notesStore.list(hooks.getAccount(), query);\n        if (query !== N.query) return; // a newer search has started\n        N.notes = r.notes;\n        N.truncated = r.truncated;\n ",
"       N.folders = r.folders || [];\n        const terms = searchLogic.queryTerms(query);\n        if (JSON.stringify(terms) !== JSON.stringify(N.terms)) N.findIndex = 0;\n        N.terms = terms;\n        // The folder shown was deleted or renamed away in Gmail.\n        if (N.folder && !N.folders.some(f => f.id === N.folder)) N.folder = '';\n        N.status = 'ready';\n        N.error = '';\n        N.loadedAt = Date.now();\n        catchUpCurrent();\n        N.ctx.onLoaded();\n      } catch (err) {\n        if (api.STATE_CODES.has(err.code)) {\n          N.status = 'idle';\n          N.ctx.onStateError(err);\n          return;\n        }\n        N.status = N.notes.length ? 'ready' : 'error';\n        N.error = err.message;\n        if (N.notes.length) toast(N.ctx.root, `Couldn’t load notes: ${err.message}`, { kind: 'error' });\n      } finally {\n        N.loading = null;\n        drawFolders();\n        drawList();\n        drawFoot();\n        if (N.current) drawBar();\n        applyHighlights();\n       ",
" fetchHits();\n        N.ctx.barChanged();\n      }\n    })();\n    // The search box changed while this was in flight, and the load that\n    // change asked for was turned away above: run it now.\n    const p = N.loading;\n    return p.then(() => (query !== N.query ? load({ force: true }) : undefined));\n  }\n\n  // The open note was saved on another computer since it was opened here:\n  // show the newer text, unless there are edits here that would be lost.\n  function catchUpCurrent() {\n    const c = N.current;\n    if (!c || !c.note || c.dirty || c.saving) return;\n    const fresh = N.notes.find(n => n.key === c.key);\n    if (fresh && fresh.messageId !== c.note.messageId) openNote(fresh, { force: true });\n  }\n\n  // ── The list ─────────────────────────────────────────────────────────\n\n  function folderById(id) {\n    return N.folders.find(f => f.id === id) || null;\n  }\n\n  // \"Work › Clients\"\n  function folderLabel(id) {\n    const f = folderById(id);\n    return f ? f.path.split('/').join(' \\u203a",
" ') : '';\n  }\n\n  function visibleNotes() {\n    return N.folder ? N.notes.filter(n => n.folderId === N.folder) : N.notes;\n  }\n\n  function drawList() {\n    if (!els.items) return;\n    const curKey = N.current && N.current.key;\n    const shown = visibleNotes();\n    const searching = !!N.query.trim();\n    if (els.scope) {\n      const where = N.folder ? folderLabel(N.folder) : 'All notes';\n      els.scope.textContent = N.status === 'ready'\n        ? `${where} \\u00b7 ${shown.length} ${searching ? (shown.length === 1 ? 'match' : 'matches') : (shown.length === 1 ? 'note' : 'notes')}`\n        : where;\n    }\n    if (els.search) els.search.placeholder = N.folder ? `Search in ${folderById(N.folder) ? folderById(N.folder).title : 'this folder'}` : 'Search notes';\n\n    if (N.status === 'loading' && !N.notes.length) {\n      els.items.replaceChildren(h('div', { class: 'notes-empty', text: 'Loading…' }));\n      return;\n    }\n    if (N.status === 'error' && !N.notes.length) {\n      els.items.replaceChil",
"dren(\n        h('div', { class: 'notes-empty' },\n          h('p', { text: `Couldn’t load notes: ${N.error}` }),\n          h('button', { class: 'btn btn-text', type: 'button', text: 'Try again', onclick: () => load({ force: true }) })));\n      return;\n    }\n    if (!shown.length) {\n      let text = searching ? 'No notes match.' : 'No notes yet.';\n      if (N.folder) text = searching ? 'No notes in this folder match.' : 'No notes in this folder yet.';\n      els.items.replaceChildren(h('div', { class: 'notes-empty', text }));\n      return;\n    }\n\n    els.items.replaceChildren(...shown.map(n => {\n      const item = h('button', {\n        class: 'note-item', type: 'button', role: 'listitem', draggable: 'true',\n        'aria-current': n.key === curKey ? 'true' : null,\n        dataset: { key: `note:${n.key}`, note: n.key },\n        onclick: () => openNote(n),\n      },\n        h('span', { class: 'ni-top' },\n          h('span', { class: 'ni-title' }, marked(n.title)),\n          h('span', { class",
": 'date', text: util.relativeDate(n.updated), title: util.fullDate(n.updated) })),\n        itemPreview(n),\n        h('span', { class: 'ni-meta' },\n          hitCount(n),\n          !N.folder && n.folderId ? h('span', { class: 'ni-folder' }, icon('folder', 14), folderLabel(n.folderId)) : null,\n          n.own ? null : h('span', { class: 'ni-mail', text: 'From an email' })));\n      item.addEventListener('dragstart', e => {\n        N.dragKey = n.key;\n        e.dataTransfer.effectAllowed = 'move';\n        e.dataTransfer.setData('application/x-gkb-note', n.key);\n        els.wrap.classList.add('dragging-note');\n      });\n      item.addEventListener('dragend', () => {\n        N.dragKey = '';\n        els.wrap.classList.remove('dragging-note');\n        for (const r of els.folderItems.querySelectorAll('.drop')) r.classList.remove('drop');\n      });\n      return item;\n    }));\n  }\n\n  // ── Search results ───────────────────────────────────────────────────\n  //\n  // Gmail finds the notes; these sho",
"w where the words are. Each result\n  // gets excerpts around its matches once its text is in, with the words\n  // marked. Until then - or if Gmail matched something the words do not\n  // show, such as a stemmed form - it shows Gmail's own snippet.\n\n  const termsKey = () => JSON.stringify(N.terms);\n\n  // Text with the search words wrapped in <mark>, built from text nodes.\n  function marked(text, marks) {\n    const s = String(text || '');\n    const m = marks || (N.terms.length ? searchLogic.findMatches(s, N.terms) : []);\n    if (!m.length) return s;\n    const out = [];\n    let at = 0;\n    for (const { start, end } of m) {\n      if (start > at) out.push(s.slice(at, start));\n      out.push(h('mark', { text: s.slice(start, end) }));\n      at = end;\n    }\n    if (at < s.length) out.push(s.slice(at));\n    return out;\n  }\n\n  function itemPreview(n) {\n    const hit = N.terms.length ? N.hits.get(`${n.messageId}|${termsKey()}`) : null;\n    if (hit && hit.excerpts.length) {\n      return h('span', ",
"{ class: 'ni-excerpts' }, hit.excerpts.map(ex => h('span', { class: 'ni-excerpt' },\n        ex.cutBefore ? '\\u2026' : '', marked(ex.text, ex.marks), ex.cutAfter ? '\\u2026' : '')));\n    }\n    return n.snippet ? h('span', { class: 'ni-snippet' }, marked(n.snippet)) : null;\n  }\n\n  function hitCount(n) {\n    if (!N.terms.length) return null;\n    const hit = N.hits.get(`${n.messageId}|${termsKey()}`);\n    if (!hit) return null;\n    return h('span', { class: 'ni-hits', text: `${hit.count} ${hit.count === 1 ? 'match' : 'matches'}` });\n  }\n\n  // Fetches the text of the results on show that have no excerpts yet,\n  // a few at a time, redrawing the list as they come in.\n  let hitsRun = 0;\n  async function fetchHits() {\n    if (!N.terms.length) return;\n    const run = ++hitsRun;\n    const key = termsKey();\n    const terms = N.terms;\n    const todo = visibleNotes().slice(0, EXCERPT_LIMIT).filter(n => !N.hits.has(`${n.messageId}|${key}`));\n    let redraw = 0;\n    await util.mapPool(todo, 4, async n",
" => {\n      if (run !== hitsRun) return;\n      try {\n        const doc = await notesStore.body(n);\n        const text = fmt.docText(doc);\n        const body = searchLogic.findMatches(text, terms);\n        const title = searchLogic.findMatches(n.title, terms);\n        N.hits.set(`${n.messageId}|${key}`, {\n          count: body.length + title.length,\n          excerpts: searchLogic.excerpts(text, body, { context: 45, max: 3 }),\n        });\n      } catch { /* the snippet stands in */ }\n      if (run === hitsRun && !redraw) redraw = setTimeout(() => { redraw = 0; drawList(); }, 60);\n    });\n    if (run === hitsRun) drawList();\n  }\n\n  // ── Find in the open note ────────────────────────────────────────────\n\n  function applyHighlights() {\n    const c = N.current;\n    if (!els.ed || !c || c.bodyState !== 'ready') { drawFind(); return; }\n    const count = els.ed.highlight(N.terms);\n    if (N.findIndex >= count) N.findIndex = 0;\n    if (count) els.ed.showMatch(N.findIndex);\n    drawFind();\n  }\n",
"\n  function stepMatch(delta) {\n    const count = els.ed ? els.ed.matchCount() : 0;\n    if (!count) return;\n    N.findIndex = (N.findIndex + delta + count) % count;\n    els.ed.showMatch(N.findIndex);\n    drawFind();\n  }\n\n  function clearSearch() {\n    if (!els.search) return;\n    els.search.value = '';\n    N.query = '';\n    clearTimeout(searchTimer);\n    load({ force: true });\n  }\n\n  function drawFind() {\n    if (!els.findSlot) return;\n    const c = N.current;\n    if (!N.terms.length || !c || !els.ed || c.bodyState !== 'ready') {\n      els.findSlot.replaceChildren();\n      return;\n    }\n    const count = els.ed.matchCount();\n    const words = N.terms.map(t => t.words.join(' ')).join(', ');\n    // A redraw replaces the arrow just pressed; focus goes to its successor\n    // rather than falling out of the board, where F3 would not reach it.\n    const active = N.ctx.root.activeElement;\n    const refocus = active && els.findSlot.contains(active) ? active.dataset.key : '';\n    els.findSlot.re",
"placeChildren(h('div', { class: 'ne-find', role: 'search', 'aria-label': 'Matches in this note' },\n      icon('search', 18),\n      h('span', { class: 'find-words', text: words, title: words }),\n      h('span', { class: 'find-pos', 'aria-live': 'polite', text: count ? `${N.findIndex + 1} of ${count}` : 'Not in the text' }),\n      h('button', {\n        class: 'icon-btn', type: 'button', 'aria-label': 'Previous match (Shift+F3)', title: 'Previous match (Shift+F3)',\n        disabled: count < 2, dataset: { key: 'find-prev' }, onclick: () => stepMatch(-1),\n      }, icon('up', 18)),\n      h('button', {\n        class: 'icon-btn', type: 'button', 'aria-label': 'Next match (F3)', title: 'Next match (F3)',\n        disabled: count < 2, dataset: { key: 'find-next' }, onclick: () => stepMatch(1),\n      }, icon('down', 18)),\n      h('button', {\n        class: 'icon-btn', type: 'button', 'aria-label': 'Clear the search', title: 'Clear the search',\n        dataset: { key: 'find-clear' }, onclick: clear",
"Search,\n      }, icon('close', 18))));\n    if (refocus) {\n      const again = els.findSlot.querySelector(`[data-key=\"${refocus}\"]`);\n      if (again && !again.disabled) again.focus();\n    }\n  }\n\n  // ── Folders ──────────────────────────────────────────────────────────\n\n  function counts() {\n    const out = new Map();\n    for (const n of N.notes) out.set(n.folderId || '', (out.get(n.folderId || '') || 0) + 1);\n    return out;\n  }\n\n  function selectFolder(id) {\n    if (N.folder === id) return;\n    N.folder = id;\n    drawFolders();\n    drawList();\n    fetchHits();\n  }\n\n  function drawFolders() {\n    if (!els.folderItems) return;\n    const tally = counts();\n    const rows = [folderRow(null, N.notes.length)];\n    const edit = N.folderEdit;\n    if (edit && edit.mode === 'new' && !edit.parentId) rows.push(editRow(0));\n    N.folders.forEach((f, i) => {\n      rows.push(edit && edit.mode === 'rename' && edit.folderId === f.id ? editRow(f.depth, f) : folderRow(f, tally.get(f.id) || 0));\n      //",
" A new subfolder's field goes after the whole branch it joins.\n      const next = N.folders[i + 1];\n      const branchEnds = !next || !next.name.startsWith(`${f.name}/`);\n      if (edit && edit.mode === 'new' && edit.parentId) {\n        const parent = folderById(edit.parentId);\n        if (parent && (f.id === parent.id || f.name.startsWith(`${parent.name}/`)) && branchEnds) rows.push(editRow(parent.depth + 1));\n      }\n    });\n    els.folderItems.replaceChildren(...rows);\n  }\n\n  function folderRow(f, count) {\n    const id = f ? f.id : '';\n    const children = f ? N.folders.some(x => x.name.startsWith(`${f.name}/`)) : false;\n    const row = h('div', {\n      class: 'folder-row', role: 'listitem', dataset: { folder: id || 'all' },\n    },\n      h('button', {\n        class: 'folder-btn', type: 'button', 'aria-current': N.folder === id ? 'true' : null,\n        dataset: { key: `folder:${id || 'all'}` }, title: f ? f.name : 'Every note, in any folder',\n        onclick: () => selectFolder(id),\n",
"      },\n        icon(f ? 'folder' : 'notes', 18),\n        h('span', { class: 'folder-title', text: f ? f.title : 'All notes' }),\n        h('span', { class: 'folder-count', text: N.status === 'ready' ? String(count) : '' })),\n      f ? h('button', {\n        class: 'icon-btn folder-menu', type: 'button', 'aria-label': `More actions: ${f.title}`, title: 'More actions',\n        'aria-haspopup': 'menu', 'aria-expanded': 'false', dataset: { key: `folder-menu:${id}` },\n        onclick: e => openMenu(N.ctx.root, e.currentTarget, [\n          { label: 'Rename', icon: 'edit', key: 'folder-rename', onSelect: () => startFolderEdit({ mode: 'rename', folderId: id }) },\n          { label: 'New subfolder', icon: 'add', key: 'folder-sub', onSelect: () => startFolderEdit({ mode: 'new', parentId: id }) },\n          { separator: true },\n          {\n            label: count || children ? 'Delete (empty it first)' : 'Delete', icon: 'delete', danger: true, key: 'folder-delete',\n            disabled: !!(count",
" || children), onSelect: () => removeFolder(f),\n          },\n        ], { label: `Actions for ${f.title}` }),\n      }, icon('more', 18)) : null);\n    // Through the style API, not a style attribute: a page's security\n    // policy may refuse inline style attributes, never this.\n    row.style.setProperty('--depth', String(f ? f.depth : 0));\n\n    // Dropping a note here files it here; on \"All notes\", takes it out of\n    // its folder.\n    row.addEventListener('dragover', e => {\n      if (!N.dragKey) return;\n      e.preventDefault();\n      e.dataTransfer.dropEffect = 'move';\n      row.classList.add('drop');\n    });\n    row.addEventListener('dragleave', () => row.classList.remove('drop'));\n    row.addEventListener('drop', e => {\n      if (!N.dragKey) return;\n      e.preventDefault();\n      row.classList.remove('drop');\n      const note = N.notes.find(n => n.key === N.dragKey);\n      N.dragKey = '';\n      if (note) moveNote(note, id);\n    });\n    return row;\n  }\n\n  function editRow(depth, f",
"older) {\n    const edit = N.folderEdit;\n    const input = h('input', {\n      class: 'text-input folder-input', type: 'text', value: edit.value, maxlength: String(notesLogic.FOLDER_NAME_MAX),\n      placeholder: edit.mode === 'new' ? 'Folder name, then Enter' : '', 'aria-label': edit.mode === 'new' ? 'New folder name' : `Rename ${folder.title}`,\n      disabled: !!edit.busy, dataset: { key: 'folder-input' },\n      oninput: e => { edit.value = e.target.value; },\n      onkeydown: e => {\n        if (e.key === 'Enter') { e.preventDefault(); commitFolderEdit(); }\n        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelFolderEdit(); }\n      },\n      onblur: () => { if (!edit.busy && N.folderEdit === edit) setTimeout(() => { if (N.folderEdit === edit && !edit.busy) cancelFolderEdit(); }, 150); },\n    });\n    const row = h('div', { class: 'folder-row editing' },\n      h('div', { class: 'folder-edit' }, icon('folder', 18), input),\n      edit.error ? h('div', { class: 'fold",
"er-error', role: 'alert', text: edit.error }) : null);\n    row.style.setProperty('--depth', String(depth));\n    return row;\n  }\n\n  function startFolderEdit({ mode, parentId = '', folderId = '' }) {\n    const f = folderById(folderId);\n    N.folderEdit = { mode, parentId, folderId, value: mode === 'rename' && f ? f.title : '', error: '', busy: false };\n    drawFolders();\n    const input = els.folderItems.querySelector('[data-key=\"folder-input\"]');\n    if (input) { input.focus(); input.select(); }\n  }\n\n  function cancelFolderEdit() {\n    if (!N.folderEdit) return;\n    N.folderEdit = null;\n    drawFolders();\n  }\n\n  async function commitFolderEdit() {\n    const edit = N.folderEdit;\n    if (!edit || edit.busy) return;\n    const target = edit.mode === 'rename' ? folderById(edit.folderId) : null;\n    const parent = edit.mode === 'new' ? folderById(edit.parentId) : null;\n    const parentPath = target ? target.parentPath : parent ? parent.path : '';\n    const siblings = N.folders.filter(f => f.p",
"arentPath === parentPath && f !== target).map(f => f.title);\n    const problem = notesLogic.validateFolderTitle(edit.value, siblings);\n    if (edit.mode === 'rename' && target && edit.value.trim() === target.title) { cancelFolderEdit(); return; }\n    if (problem) {\n      edit.error = problem;\n      drawFolders();\n      const input = els.folderItems.querySelector('[data-key=\"folder-input\"]');\n      if (input) input.focus();\n      return;\n    }\n    edit.busy = true;\n    drawFolders();\n    try {\n      if (edit.mode === 'new') {\n        const made = await notesStore.createFolder(parent, edit.value);\n        N.folders = notesStore.folders();\n        if (made) N.folder = made.id;\n        toast(N.ctx.root, `Folder “${edit.value.trim()}” created.`);\n      } else {\n        await notesStore.renameFolder(target, edit.value);\n        N.folders = notesStore.folders();\n      }\n      N.folderEdit = null;\n    } catch (err) {\n      edit.busy = false;\n      edit.error = `Couldn’t save: ${err.message}`;\n",
"      if (api.STATE_CODES.has(err.code)) N.ctx.onStateError(err);\n    }\n    drawFolders();\n    drawList();\n    if (N.current) drawBar();\n  }\n\n  async function removeFolder(f) {\n    try {\n      await notesStore.deleteFolder(f);\n      N.folders = notesStore.folders();\n      if (N.folder === f.id) N.folder = '';\n      toast(N.ctx.root, `Folder “${f.title}” deleted.`);\n    } catch (err) {\n      const msg = err.code === 'not_allowed' ? 'Only an empty folder can be deleted. Move its notes out first.' : err.message;\n      toast(N.ctx.root, `Couldn’t delete “${f.title}”: ${msg}`, { kind: 'error' });\n    }\n    drawFolders();\n    drawList();\n  }\n\n  // Runs after any save in progress, so the move lands on the newest\n  // version rather than one about to be replaced.\n  function moveNote(note, folderId) {\n    const c = N.current && N.current.note === note ? N.current : null;\n    if ((note.folderId || '') === (folderId || '')) return N.chain;\n    N.chain = N.chain.then(async () => {\n      const late",
"st = c ? c.note : note;\n      const was = latest.folderId || '';\n      latest.folderId = folderId;\n      if (c) c.folderId = folderId;\n      drawFolders();\n      drawList();\n      if (c) drawBar();\n      try {\n        await notesStore.move(latest, folderId);\n        toast(N.ctx.root, folderId ? `Moved to ${folderLabel(folderId)}.` : 'Taken out of its folder.');\n      } catch (err) {\n        latest.folderId = was;\n        if (c) c.folderId = was;\n        toast(N.ctx.root, `Couldn’t move “${latest.title}”: ${err.message}`, { kind: 'error' });\n        if (api.STATE_CODES.has(err.code)) N.ctx.onStateError(err);\n      }\n      drawFolders();\n      drawList();\n      if (N.current === c && c) drawBar();\n    });\n    return N.chain;\n  }\n\n  // The folder button above the note: where it is, and where it can go.\n  function chooseFolder(anchor) {\n    const c = N.current;\n    if (!c) return;\n    openMenu(N.ctx.root, anchor, [\n      { heading: 'Move to' },\n      { label: 'No folder', key: 'move-folder",
":none', checked: !c.folderId, onSelect: () => setCurrentFolder('') },\n      ...N.folders.map(f => ({\n        label: `${'\\u2003'.repeat(f.depth)}${f.title}`, key: `move-folder:${f.id}`, checked: c.folderId === f.id,\n        onSelect: () => setCurrentFolder(f.id),\n      })),\n    ], { label: 'Folder' });\n  }\n\n  function setCurrentFolder(id) {\n    const c = N.current;\n    if (!c) return;\n    // Not saved yet: the folder is simply where the first save puts it.\n    if (!c.note) {\n      c.folderId = id;\n      drawBar();\n      return;\n    }\n    moveNote(c.note, id);\n  }\n\n  function drawFoot() {\n    if (!els.foot) return;\n    els.foot.textContent = N.truncated\n      ? 'Showing the 100 most recent. Search to find older ones.'\n      : `Kept in Gmail under “${notesStore.labelName()}”`;\n  }\n\n  // ── The editor ───────────────────────────────────────────────────────\n\n  function newCurrent(note) {\n    return {\n      key: note ? note.key : `new:${Date.now()}`,\n      note,                          // n",
"ull until first saved\n      title: note && note.title !== 'Untitled note' ? note.title : '',\n      doc: note ? null : fmt.emptyDoc(),   // formatted content, once loaded\n      bodyState: note ? 'loading' : 'ready', // loading | ready | error\n      dirty: false,\n      saving: false,\n      error: '',\n      savedAt: 0,\n      // A new note starts in the folder being looked at.\n      folderId: note ? note.folderId || '' : N.folder,\n    };\n  }\n\n  function newNote() {\n    flush();\n    N.current = newCurrent(null);\n    drawList();\n    drawEditor();\n    focusField('note-title');\n  }\n\n  function openNote(note, { force = false } = {}) {\n    if (!force && N.current && N.current.key === note.key) return;\n    flush();\n    const c = newCurrent(note);\n    N.current = c;\n    N.findIndex = 0;\n    drawList();\n    drawEditor();\n    notesStore.body(note).then(doc => {\n      if (N.current !== c) return;\n      c.doc = doc;\n      c.bodyState = 'ready';\n      drawEditor();\n      applyHighlights();\n    }, err =",
"> {\n      if (N.current !== c) return;\n      c.bodyState = 'error';\n      c.error = err.message;\n      if (api.STATE_CODES.has(err.code)) N.ctx.onStateError(err);\n      else drawEditor();\n    });\n  }\n\n  function focusField(key) {\n    if (key === 'note-body' && els.ed) { els.ed.focus(); return; }\n    const el = els.editor && els.editor.querySelector(`[data-key=\"${key}\"]`);\n    if (el) el.focus();\n  }\n\n  // Which pane a phone shows: the list, or the open note.\n  function setView() {\n    const view = N.current ? 'note' : 'list';\n    if (els.wrap) els.wrap.dataset.view = view;\n    if (view !== N.view) {\n      N.view = view;\n      if (N.ctx && N.ctx.onViewChange) N.ctx.onViewChange(view);\n    }\n  }\n\n  // Back to the list, once whatever is pending is saved. A save that\n  // failed keeps the note open, with its error showing, rather than\n  // leaving the edits behind.\n  async function closeNote() {\n    const c = N.current;\n    if (!c) return;\n    await flush();\n    if (N.current !== c) return",
";\n    if (c.dirty) {\n      toast(N.ctx.root, 'Not saved yet, so the note stays open. Try again in a moment.', { kind: 'error' });\n      return;\n    }\n    N.current = null;\n    drawEditor();\n    drawList();\n  }\n\n  function drawEditor() {\n    if (!els.editor) return;\n    setView();\n    const c = N.current;\n    if (!c) {\n      if (els.ed) { els.ed.destroy(); els.ed = null; }\n      els.editor.replaceChildren(h('div', { class: 'notes-intro' },\n        h('span', { class: 'panel-icon' }, icon('note', 28)),\n        h('h2', { text: 'Notes, kept in Gmail' }),\n        h('p', {\n          text: `Each note is saved as a message under “${notesStore.labelName()}”, out of your Inbox. ` +\n            'Gmail’s search finds it, your phone shows it, and every earlier version waits in Gmail’s Trash for 30 days.',\n        }),\n        h('button', { class: 'btn btn-primary', type: 'button', text: 'New note', dataset: { key: 'note-new-intro' }, onclick: () => newNote() })));\n      return;\n    }\n\n    els.bar = h",
"('div', { class: 'ne-bar' });\n    els.bannerSlot = h('div', { class: 'ne-banner-slot' });\n    const title = h('input', {\n      class: 'ne-title', type: 'text', placeholder: 'Title', 'aria-label': 'Title',\n      value: c.title, maxlength: String(notesLogic.MAX_TITLE), dataset: { key: 'note-title' },\n      disabled: c.bodyState !== 'ready',\n      oninput: e => edited(c, { title: e.target.value }),\n      onkeydown: e => {\n        // Enter in the title carries on into the body, as in most editors.\n        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); focusField('note-body'); }\n      },\n    });\n    // A fresh editor per note: its undo history belongs to that note.\n    if (els.ed) els.ed.destroy();\n    const ed = ns.noteEditor.create({ root: N.ctx.root, onChange: () => edited(c, { doc: ed.getDoc() }) });\n    els.ed = ed;\n    ed.setDoc(c.doc || fmt.emptyDoc());\n    ed.setEditable(c.bodyState === 'ready',\n      c.bodyState === 'loading' ? 'Loading…' : c.bodyState === 'error' ?",
" 'Couldn’t load this note.' : 'Write here…');\n\n    els.findSlot = h('div', { class: 'ne-find-slot' });\n    els.editor.replaceChildren(els.bar, els.bannerSlot, els.findSlot, title, ed.toolbar, ed.linkbar, ed.element);\n    drawBar();\n    drawFind();\n  }\n\n  // The strip above the text: status, buttons, and the banner for an\n  // emailed note. Redrawn on its own after a save - the first save of a\n  // new note gains an \"Open in Gmail\", an emailed one loses its banner -\n  // without touching the text boxes the user may still be typing in.\n  function drawBar() {\n    const c = N.current;\n    if (!c || !els.bar) return;\n    const foreign = !!(c.note && !c.note.own);\n    els.status = h('span', { class: 'ne-status', 'aria-live': 'polite' });\n    els.bar.replaceChildren(\n      h('button', {\n        class: 'icon-btn ne-back', type: 'button', 'aria-label': 'Back to the list', title: 'Back to the list',\n        dataset: { key: 'note-back' }, onclick: () => closeNote(),\n      }, icon('back')),\n      ",
"els.status,\n      h('div', { class: 'spacer' }),\n      h('button', {\n        class: 'ne-folder', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',\n        title: 'Move to another folder', dataset: { key: 'note-folder' },\n        onclick: e => chooseFolder(e.currentTarget),\n      }, icon('folder', 18), h('span', { text: c.folderId ? folderLabel(c.folderId) || 'No folder' : 'No folder' }), icon('caret', 18)),\n      c.note ? h('button', {\n        class: 'icon-btn', type: 'button', 'aria-label': 'Open in Gmail', title: 'Open in Gmail',\n        dataset: { key: 'note-open' }, onclick: () => openInGmail(c),\n      }, icon('open')) : null,\n      h('button', {\n        class: 'icon-btn', type: 'button', 'aria-label': foreign ? 'Take off the notes list' : 'Delete note',\n        title: foreign ? 'Take off the notes list (the email stays)' : 'Delete (moves it to Gmail’s Trash)',\n        dataset: { key: 'note-delete' }, onclick: () => deleteCurrent(),\n      }, icon('delete')));\n    e",
"ls.bannerSlot.replaceChildren(foreign ? h('div', {\n      class: 'ne-banner',\n      text: `This one is an email filed under “${notesStore.labelName()}”. Editing it saves a new note in its place; ` +\n        'the email itself stays in Gmail, just off this list.',\n    }) : '');\n    drawStatus();\n  }\n\n  function drawStatus() {\n    const c = N.current;\n    if (!els.status || !c) return;\n    let text;\n    if (c.saving) text = 'Saving…';\n    else if (c.error && c.bodyState === 'ready') text = `Couldn’t save: ${c.error}`;\n    else if (c.dirty) text = 'Unsaved changes';\n    else if (c.savedAt) text = `Saved ${util.agoText(Date.now() - c.savedAt)}`;\n    else if (c.note) text = `Last saved ${util.relativeDate(c.note.updated)}`;\n    else text = 'New note';\n    els.status.textContent = text;\n    els.status.classList.toggle('error', !!(c.error && !c.saving && c.bodyState === 'ready'));\n    els.status.title = c.note ? util.fullDate(c.note.updated) : '';\n  }\n\n  // ── Saving ───────────────────────────",
"────────────────────────────────\n\n  function edited(c, change) {\n    Object.assign(c, change);\n    c.dirty = true;\n    c.error = '';\n    drawStatus();\n    if (change.doc && N.terms.length) {\n      clearTimeout(findTimer);\n      findTimer = setTimeout(applyHighlights, 300);\n    }\n    clearTimeout(saveTimer);\n    saveTimer = setTimeout(() => save(c), AUTOSAVE_MS);\n  }\n\n  // Saves are chained: each one retires the version the previous one\n  // wrote, so two in flight at once would each leave a stray behind.\n  function save(c) {\n    N.chain = N.chain.then(async () => {\n      if (!c.dirty) return;\n      // An untouched new note is not worth a message.\n      if (!c.note && !c.title.trim() && fmt.isEmpty(c.doc)) { c.dirty = false; return; }\n      const snap = { title: c.title, doc: c.doc, folderId: c.folderId };\n      const before = c.note;\n      c.dirty = false;\n      c.saving = true;\n      drawStatus();\n      try {\n        const saved = await notesStore.save(hooks.getAccount(), before, snap",
");\n        const oldKey = c.key;\n        const wasOurs = !!(before && before.own);\n        c.note = saved;\n        c.key = saved.key;\n        c.savedAt = Date.now();\n        c.error = '';\n        N.notes = [saved, ...N.notes.filter(n => n.key !== oldKey && n.key !== saved.key)];\n        if (!wasOurs && N.current === c) drawBar();\n      } catch (err) {\n        c.dirty = true;\n        c.error = err.message;\n        if (api.STATE_CODES.has(err.code)) N.ctx.onStateError(err);\n      } finally {\n        c.saving = false;\n        if (N.current === c) drawStatus();\n        drawList();\n      }\n    });\n    return N.chain;\n  }\n\n  // Whatever is pending, now. Called on Ctrl+S, on switching notes or\n  // tabs, and when the board closes.\n  function flush() {\n    clearTimeout(saveTimer);\n    const c = N.current;\n    return c && c.dirty ? save(c) : N.chain;\n  }\n\n  // ── Other actions ────────────────────────────────────────────────────\n\n  async function openInGmail(c) {\n    await flush();\n    if (!c.n",
"ote || !c.note.threadId) return;\n    N.ctx.closeBoard();\n    hooks.openThread(c.note.threadId);\n  }\n\n  async function deleteCurrent() {\n    const c = N.current;\n    if (!c) return;\n    clearTimeout(saveTimer);\n    await N.chain;\n    N.current = null;\n    drawEditor();\n    const note = c.note;\n    if (!note) { drawList(); return; } // never saved: nothing in Gmail\n\n    const at = N.notes.findIndex(n => n.key === note.key);\n    N.notes = N.notes.filter(n => n.key !== note.key);\n    drawList();\n    try {\n      await notesStore.retire(note);\n      toast(N.ctx.root, note.own\n        ? 'Note moved to Gmail’s Trash.'\n        : `Taken off the notes list. The email stays in Gmail.`, {\n        action: { label: 'Undo', onClick: () => undoDelete(note, at) },\n        timeout: 8000,\n      });\n    } catch (err) {\n      N.notes.splice(Math.max(0, at), 0, note);\n      drawList();\n      toast(N.ctx.root, `Couldn’t delete “${note.title}”: ${err.message}`, { kind: 'error' });\n    }\n  }\n\n  async function u",
"ndoDelete(note, at) {\n    try {\n      await notesStore.restore(note);\n      N.notes.splice(Math.max(0, Math.min(at, N.notes.length)), 0, note);\n      drawList();\n      openNote(note, { force: true });\n    } catch (err) {\n      toast(N.ctx.root, `Couldn’t bring it back: ${err.message}. It is still in Gmail’s Trash.`, { kind: 'error' });\n    }\n  }\n\n  // Ctrl+S (⌘S) saves now instead of Chrome's \"Save page as\".\n  function handleKey(e) {\n    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {\n      e.preventDefault();\n      flush();\n      return true;\n    }\n    if (e.key === 'F3' && N.terms.length && els.ed) {\n      e.preventDefault();\n      stepMatch(e.shiftKey ? -1 : 1);\n      return true;\n    }\n    return false;\n  }\n\n  // Called every few seconds while the board is open, for \"Saved 5s ago\".\n  function tick() {\n    drawStatus();\n  }\n\n  function focusDefault() {\n    if (N.current) focusField(N.current.bodyState === 'ready' && N.current.title ? 'note-body' : 'note-t",
"itle');\n    else if (els.search) els.search.focus();\n  }\n\n  ns.notes = {\n    init, element, load, isStale, flush, handleKey, tick, focusDefault, closeNote,\n    isOpen: () => !!N.current,\n    loadedAt: () => N.loadedAt,\n    isLoading: () => !!N.loading,\n  };\n})();\n</script>\n<script>\n// addon/app/shell.js\n// ─────────────────────────────────────────────────────────────────────\n// The phone app\n//\n// The extension's Notes view, full-screen: the same list, folders,\n// search with the words marked, formatting editor, autosave and find,\n// with the board's styles and a phone layout on top - one pane at a time,\n// the list or the open note, folders as a row of chips.\n//\n// A phone leaves pages without closing them, so whatever is pending is\n// saved whenever the page is hidden; and Android's back gesture goes from\n// a note back to the list, through google.script.history.\n// ─────────────────────────────────────────────────────────────────────\n\n(function () {\n  'use strict';\n\n  const ns = (gl",
"obalThis.gkb = globalThis.gkb || {});\n  const { h, icon, mountShadow, toast } = ns.ui;\n\n  const PHONE = `\n:host { position: fixed !important; inset: 0 !important; }\n.overlay { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }\n.app-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 4px 20px; flex: none; }\n.app-title { flex: 1; font-size: 20px; color: var(--fg); }\n\n@media (max-width: 760px) {\n  .app[data-view=\"note\"] .app-head { display: none; }\n  .notes { flex-direction: column; gap: 0; padding: 0; }\n  .notes[data-view=\"note\"] .notes-folders, .notes[data-view=\"note\"] .notes-list { display: none; }\n  .notes[data-view=\"list\"] .note-editor { display: none; }\n\n  /* Folders: a row of chips above the list. */\n  .notes-folders { flex: none; flex-direction: row; align-items: center; gap: 4px; padding: 2px 8px 6px; background: none; border-radius: 0; overflow-x: auto; scrollbar-width: none; }\n  .folders-head {",
" order: 2; padding: 0; }\n  .folders-head h2 { display: none; }\n  .folder-items { flex: none; flex-direction: row; gap: 6px; padding: 0; overflow: visible; }\n  .folder-row { flex: none; padding-left: 0; }\n  .folder-btn { height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid var(--border-strong); white-space: nowrap; }\n  .folder-btn[aria-current=\"true\"] { border-color: transparent; }\n  .folder-title { overflow: visible; }\n  .folder-count, .folder-btn .icon { display: none; }\n  .folder-menu { display: none; position: static; opacity: 1; }\n  .folder-row:has(.folder-btn[aria-current=\"true\"]) .folder-menu { display: inline-flex; background: none; color: var(--fg-2); }\n  .folder-row.editing { flex: 0 0 82vw; }\n\n  .notes-list { flex: 1; border-radius: 0; background: none; }\n  .notes-tools { padding: 4px 12px 8px; }\n  .notes-items { padding: 0 4px 12px; }\n  .note-item { padding: 12px; }\n\n  .note-editor { flex: 1; border-radius: 0; box-shadow: none; }\n  .ne-back { display: inline",
"-flex; margin-right: 2px; }\n  .ne-bar { padding: 6px 6px 0 4px; }\n  .ne-title { padding: 6px 16px 4px; font-size: 22px; }\n  .ne-toolbar { margin: 0 8px; overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }\n  .ne-linkbar { margin: 4px 8px 0; }\n  .ne-banner { margin: 4px 12px 0; }\n  .ne-find { margin: 4px 12px 0; }\n  .ne-body { padding: 10px 16px 40vh; font-size: 16px; }\n  .ne-body[data-empty=\"1\"]::before { left: 16px; }\n  .notes-intro { display: none; }\n}\n`;\n\n  function start() {\n    const { root } = mountShadow('gkb-app-host', ns.styles.board + PHONE);\n    const history = typeof google !== 'undefined' && google.script && google.script.history;\n\n    const head = h('header', { class: 'app-head' },\n      h('span', { class: 'app-title', text: 'Notes' }),\n      h('button', {\n        class: 'icon-btn', type: 'button', title: 'Refresh', 'aria-label': 'Refresh', dataset: { key: 'app-refresh' },\n        onclick: () => ns.notes.load({ force: true }),\n      }, icon('refresh')));\n    cons",
"t app = h('div', { class: 'overlay app', dataset: { view: 'list' } }, head);\n\n    ns.notes.init({\n      root,\n      onStateError: err => toast(root, err.message, { kind: 'error' }),\n      onLoaded() {},\n      closeBoard() {},\n      barChanged() {},\n      onViewChange(view) {\n        app.dataset.view = view;\n        // A note on the history, so Android's back gesture closes it.\n        if (view === 'note' && history) history.push({ note: 1 }, {}, '');\n        if (view === 'list' && history) history.replace({}, {}, '');\n      },\n    });\n    app.appendChild(ns.notes.element());\n    root.appendChild(app);\n\n    if (history) {\n      history.setChangeHandler(e => {\n        if (e && e.state && e.state.note) return;\n        if (!ns.notes.isOpen()) return;\n        ns.notes.closeNote().then(() => {\n          // Not closed (an unsaved edit): back on the history it goes.\n          if (ns.notes.isOpen()) history.push({ note: 1 }, {}, '');\n        });\n      });\n    }\n\n    // Ctrl+S and F3, for a keyb",
"oard.\n    root.addEventListener('keydown', e => ns.notes.handleKey(e));\n    // \"Saved 5s ago\".\n    setInterval(() => ns.notes.tick(), 5000);\n    // A phone switches away without closing the page.\n    document.addEventListener('visibilitychange', () => {\n      if (document.visibilityState === 'hidden') ns.notes.flush();\n      else if (ns.notes.isStale()) ns.notes.load();\n    });\n    window.addEventListener('pagehide', () => ns.notes.flush());\n\n    ns.notes.load();\n  }\n\n  ns.phoneApp = { start };\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);\n  else start();\n})();\n</script>\n</body>\n</html>\n",
].join('');
