// The phone panel and phone app 0.12.3: a Gmail add-on and a web app, in Apps Script.
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

var SUPERMAIL_VERSION = '0.12.3';

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

  // The page itself, built into Code.gs by tools/build-addon.mjs. With
  // ?ping=1, a line that says the script itself runs - to tell a problem
  // here from one in the page.
  function page(e) {
    const html = globalThis.SUPERMAIL_APP_HTML || '';
    if (e && e.parameter && e.parameter.ping) {
      return HtmlService.createHtmlOutput(`<p style="font: 16px/1.5 Arial, sans-serif; padding: 24px">${ns.APP_NAME} ${globalThis.SUPERMAIL_VERSION || ''}: ` +
        `the script runs, and its page is ${html.length} characters long.</p>`).setTitle(`${ns.APP_NAME} notes`);
    }
    return HtmlService.createHtmlOutput(html || '<p>The app is not built into this Code.gs.</p>')
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
"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<base target=\"_top\">\n<style>\n  html, body { margin: 0; height: 100%; background: #f6f8fc; }\n  @media (prefers-color-scheme: dark) { html, body { background: #131314; } }\n</style>\n</head>\n<body>\n<div id=\"boot\" style=\"font: 16px/1.5 Roboto, Arial, sans-serif; color: #444746; padding: 24px;\">Loading your notes&hellip;</div>\n<script>\n  (function () {\n    var problems = [];\n    function show(message, stack) {\n      var boot = document.getElementById('boot');\n      if (!boot) return;\n      problems.push(String(message) + (stack ? '\\n' + String(stack).split('\\n').slice(0, 6).join('\\n') : ''));\n      boot.style.color = '#b3261e';\n      boot.textContent = 'The notes app could not start.';\n      var pre = document.createElement('pre');\n      pre.style.cssText = 'white-space: pre-wrap; font-size: 12px; color: #444746;';\n      pre.textContent = pro",
"blems.join('\\n\\n');\n      boot.appendChild(pre);\n    }\n    window.addEventListener('error', function (e) {\n      show((e.message || 'unknown error') + (e.lineno ? ' (line ' + e.lineno + ')' : ''), e.error && e.error.stack);\n    });\n    window.addEventListener('unhandledrejection', function (e) {\n      show(String((e.reason && e.reason.message) || e.reason), e.reason && e.reason.stack);\n    });\n    window.__bootFailed = show;\n  })();\n</script>\n<script>\n(function () {\n  var MODULES = [[\"src/shared/ns.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNoYXJlZCBuYW1lc3BhY2UKLy8KLy8gQ29udGVudCBzY3JpcHRzIGFyZSBjbGFzc2ljIHNjcmlwdHMgdGhhdCBhbGwgcnVuIGluIG9uZSBpc29sYXRlZCB3b3JsZC4KLy8gVHdvIGZpbGVzIHRoYXQgZWFjaCBkZWNsYXJlZCBhIHRvcC1sZXZlbCBgY29uc3RgIG9mIHRoZSB",
"zYW1lIG5hbWUgd291bGQKLy8gY29sbGlkZSwgc28gZXZlcnkgZmlsZSB3cmFwcyBpdHNlbGYgaW4gYW4gSUlGRSBhbmQgaGFuZ3Mgd2hhdCBpdCBleHBvcnRzCi8vIG9mZiB0aGlzIG9uZSBvYmplY3QgaW5zdGVhZC4gVGhlIHNlcnZpY2Ugd29ya2VyIGFuZCB0aGUgb3B0aW9ucyBwYWdlCi8vIGxvYWQgdGhlIHNhbWUgZmlsZXMgYW5kIHNlZSB0aGUgc2FtZSBzaGFwZS4KLy8KLy8gQVBQX05BTUUgaXMgdGhlIG9ubHkgcGxhY2UgdGhlIGRpc3BsYXkgbmFtZSBsaXZlcyBpbiBjb2RlLiBOb3RoaW5nCi8vIGludGVybmFsIC0gdGhlIG5hbWVzcGFjZSwgc3RvcmFnZSBrZXlzLCBDU1MgY2xhc3NlcywgZWxlbWVudCBpZHMgLSBpcwovLyBkZXJpdmVkIGZyb20gaXQsIHNvIGEgcmVuYW1lIG5ldmVyIGhhcyB0byB0b3VjaCBzdG9yZWQgZGF0YS4gVGhlIFJFQURNRQovLyBsaXN0cyBldmVyeSBzcG90IHRoYXQgZG9lcyBjYXJyeSB0aGUgbmFtZS4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2I",
"gPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CgogIGNvbnN0IEFQUF9OQU1FID0gJ1N1cGVybWFpbCc7CgogIC8vIOKUgOKUgCBTdG9yYWdlIGtleXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBLZXllZCBieSBsb3dlci1jYXNlZCBhY2NvdW50IGVtYWlsLCBiZWNhdXNlIGEgR21haWwgdGFiIGF0IC91LzEvIGlzIGEKICAvLyBkaWZmZXJlbnQgbWFpbGJveCB3aXRoIGRpZmZlcmVudCBsYWJlbHMsIGFuZCBvbmUgcGVyc29uJ3MgY29sdW1uCiAgLy8gbGF5b3V0IG11c3Qgbm90IGxlYWsgaW50byBhbm90aGVyIGFjY291bnQncyBib2FyZC4KCiAgY29uc3QgS0VZUyA9IHsKICAgIGNsaWVudElkOiAnY2xpZW50SWQnLCAgICAgICAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgZG9ja1Bvc2l0aW9uOiAnZG9ja1Bvc2l0aW9uJywgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5zeW5jCiAgICBjb2x1bW5zOiBlbWFpbCA9PiBgY29sdW1uczoke1N0cmluZyhlbWFpbCkudG9Mb3dlckNhc2UoKX1gLCAvLyBzdG9yYWdlLnN5bmMKICAgIG9yZGVyOiBlbWFpbCA9PiBgb3JkZXI6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgICAgIC8vIHN0b3J",
"hZ2UubG9jYWwKICAgIC8vIENhcmQgZWRpdHMgZ2V0IG9uZSBrZXkgcGVyIGNhcmQgcmF0aGVyIHRoYW4gb25lIG1hcCBwZXIgYWNjb3VudDoKICAgIC8vIHN5bmMgY2FwcyBlYWNoIGl0ZW0gYXQgOCBLQiwgd2hpY2ggYSBzaW5nbGUgbWFwIHdvdWxkIG91dGdyb3cgYWZ0ZXIKICAgIC8vIGEgZmV3IGRvemVuIG5vdGVzLCB3aGlsZSB0aGUgNTEyLWl0ZW0gY2FwIGxlYXZlcyByb29tIGZvciBodW5kcmVkcy4KICAgIGNhcmRQcmVmaXg6IGVtYWlsID0-IGBjYXJkOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfTpgLCAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgY2FyZDogKGVtYWlsLCB0aHJlYWRJZCkgPT4gYGNhcmQ6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9OiR7dGhyZWFkSWR9YCwgLy8gc3RvcmFnZS5zeW5jCiAgICBub3RlczogZW1haWwgPT4gYG5vdGVzOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsICAgICAvLyBzdG9yYWdlLnN5bmM6IHsgbGFiZWwsIGxhYmVsSWQgfQogICAgdmlldzogJ3ZpZXcnLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5sb2NhbDogJ2JvYXJkJyB8ICdub3RlcycKICAgIHRva2VuOiBlbWFpbCA9PiBgdG9rZW46JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgICAgIC8vIHN0b3JhZ2Uuc2Vzc2lvbgogICAgZ21haWxUYWJzOiAnZ21haWxUYWJzJywgICAgICAgICAgICAgICAgICAgICAgLy8gc3R",
"vcmFnZS5zZXNzaW9uCiAgfTsKCiAgLy8gRWxlbWVudCBpZHMgZm9yIHRoZSB0d28gc2hhZG93IGhvc3RzLiBTaG9ydCBhbmQgbmFtZXNwYWNlZCByYXRoZXIgdGhhbgogIC8vIGJyYW5kZWQsIHNvIHRoZXkgc3Vydml2ZSBhIHJlbmFtZSBhbmQgYXJlIHVubGlrZWx5IHRvIGNsYXNoIHdpdGggR21haWwuCiAgY29uc3QgSE9TVF9JRFMgPSB7CiAgICBib2FyZDogJ2drYi1ib2FyZC1ob3N0JywKICAgIGRvY2s6ICdna2ItZG9jay1ob3N0JywKICB9OwoKICBucy5BUFBfTkFNRSA9IEFQUF9OQU1FOwogIG5zLktFWVMgPSBLRVlTOwogIG5zLkhPU1RfSURTID0gSE9TVF9JRFM7CgogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgewogICAgbW9kdWxlLmV4cG9ydHMgPSB7IEFQUF9OQU1FLCBLRVlTLCBIT1NUX0lEUyB9OwogIH0KfSkoKTsK\"],[\"src/lib/util.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNtYWxsIHB1cmUgaGVscGVycwovLwovLyBOb3RoaW5nIGluIGhlcmUgdG91Y2hlcyB0aGUgRE9NLCBjaHJvbWUuKiBvciB0aGUgbmV0",
"d29yaywgd2hpY2ggaXMgd2hhdAovLyBsZXRzIHRoZSBOb2RlIHRlc3RzIHJlcXVpcmUgdGhpcyBmaWxlIGRpcmVjdGx5LiBUaGUgY29udGVudCBzY3JpcHRzIGFuZAovLyB0aGUgc2VydmljZSB3b3JrZXIgcmVhY2ggdGhlIHNhbWUgZnVuY3Rpb25zIHRocm91Z2ggdGhlIHNoYXJlZAovLyBuYW1lc3BhY2UgKG5zLnV0aWwpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8g4pSA4pSAIEhlYWRlciBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBoZWFkZXJNYXAobWVzc2FnZSkgewogICAgY29uc3Qgb3V0ID0ge307CiAgICBjb25zdCBoZWFkZXJzID0gKG1lc3NhZ2UgJiYg",
"bWVzc2FnZS5wYXlsb2FkICYmIG1lc3NhZ2UucGF5bG9hZC5oZWFkZXJzKSB8fCBbXTsKICAgIGZvciAoY29uc3QgaCBvZiBoZWFkZXJzKSBvdXRbaC5uYW1lLnRvTG93ZXJDYXNlKCldID0gaC52YWx1ZSB8fCAnJzsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyAiQW5uYSBWb3MgPGFubmFAZXhhbXBsZS5jb20-IiDihpIgeyBuYW1lLCBlbWFpbCB9CiAgZnVuY3Rpb24gcGFyc2VBZGRyZXNzKHJhdykgewogICAgaWYgKCFyYXcpIHJldHVybiB7IG5hbWU6ICcnLCBlbWFpbDogJycgfTsKICAgIGNvbnN0IGFuZ2xlZCA9IHJhdy5tYXRjaCgvXlxzKiguKj8pXHMqPChbXj5dKyk-XHMqJC8pOwogICAgaWYgKGFuZ2xlZCkgewogICAgICByZXR1cm4gewogICAgICAgIG5hbWU6IGFuZ2xlZFsxXS5yZXBsYWNlKC9eWyInXXxbIiddJC9nLCAnJykudHJpbSgpLAogICAgICAgIGVtYWlsOiBhbmdsZWRbMl0udHJpbSgpLnRvTG93ZXJDYXNlKCksCiAgICAgIH07CiAgICB9CiAgICByZXR1cm4geyBuYW1lOiAnJywgZW1haWw6IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKSB9OwogIH0KCiAgLy8gV2hhdCB0byBjYWxsIGEgc2VuZGVyIG9uIGEgY2FyZC4gQSBiYXJlIGFkZHJlc3MgaXMgc2hvcnRlbmVkIHRvIGl0cwogIC8vIGxvY2FsIHBhcnQsIGJlY2F1c2UgImFjY291bnRzIiByZWFkcyBiZXR0ZXIgaW4gYSBuYXJyb3cgY29sdW1uIHRoYW4KICAvLyAiYWNjb3VudHNAYnJpZ2h0d2F0ZXItbGFuZ3VhZ2UuZXhhbXBsZSIuCiAgZnVu",
"Y3Rpb24gZGlzcGxheU5hbWUoYWRkcikgewogICAgaWYgKCFhZGRyKSByZXR1cm4gJyc7CiAgICBpZiAoYWRkci5uYW1lKSByZXR1cm4gYWRkci5uYW1lOwogICAgcmV0dXJuIChhZGRyLmVtYWlsIHx8ICcnKS5zcGxpdCgnQCcpWzBdOwogIH0KCiAgLy8g4pSA4pSAIEVudGl0aWVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gR21haWwgcmV0dXJucyBzbmlwcGV0cyBIVE1MLWVuY29kZWQuIFRoZSBvYnZpb3VzIGRlY29kZXIgLSBhc3NpZ24gdG8gYQogIC8vIGRldGFjaGVkIGVsZW1lbnQncyBpbm5lckhUTUwgYW5kIHJlYWQgdGV4dENvbnRlbnQgYmFjayAtIGlzIHdoYXQKICAvLyBHbWFpbCdzIFRydXN0ZWQgVHlwZXMgcG9saWN5IGZvcmJpZHMsIGFuZCBpdCB3b3VsZCBhbHNvIG1lYW4gZmVlZGluZwogIC8vIHVudHJ1c3RlZCBtYWlsIHRleHQgdG8gdGhlIEhUTUwgcGFyc2VyLiBBIGxvb2t1cCB0YWJsZSBkb2VzIHRoZSBqb2IuCgogIC8vIFRoZSBoYW5kZnVsIGV2ZXJ5IG1haWwgbmVlZHMsIHBsdXMgdGhlIHR5cG9ncmFwaGljIG9uZXMgdGhhdCBIVE1MCiAgLy8gbWFpbCB3cml0dGVuIGluIEdtYWlsIG9yIE91dGxvb2sgaXMgZnVsbCBv",
"Zi4KICBjb25zdCBOQU1FRCA9IHsKICAgIGFtcDogJyYnLCBsdDogJzwnLCBndDogJz4nLCBxdW90OiAnIicsIGFwb3M6ICInIiwgbmJzcDogJ1x1MDBhMCcsCiAgICBsc3F1bzogJ1x1MjAxOCcsIHJzcXVvOiAnXHUyMDE5JywgbGRxdW86ICdcdTIwMWMnLCByZHF1bzogJ1x1MjAxZCcsCiAgICBuZGFzaDogJ1x1MjAxMycsIG1kYXNoOiAnXHUyMDE0JywgaGVsbGlwOiAnXHUyMDI2JywgYnVsbDogJ1x1MjAyMicsIG1pZGRvdDogJ1x1MDBiNycsCiAgICBsYXF1bzogJ1x1MDBhYicsIHJhcXVvOiAnXHUwMGJiJywgZXVybzogJ1x1MjBhYycsIHBvdW5kOiAnXHUwMGEzJywgY29weTogJ1x1MDBhOScsIHJlZzogJ1x1MDBhZScsIHRyYWRlOiAnXHUyMTIyJywKICB9OwoKICBmdW5jdGlvbiBkZWNvZGVFbnRpdGllcyhpbnB1dCkgewogICAgLy8gU2luZ2xlIHBhc3MsIHNvICImYW1wO2x0OyIgYmVjb21lcyB0aGUgbGl0ZXJhbCB0ZXh0ICImbHQ7IiBhbmQgaXMKICAgIC8vIG5vdCBkZWNvZGVkIGEgc2Vjb25kIHRpbWUgaW50byAiPCIuCiAgICByZXR1cm4gU3RyaW5nKGlucHV0ID09IG51bGwgPyAnJyA6IGlucHV0KS5yZXBsYWNlKAogICAgICAvJigjW3hYXVswLTlhLWZBLUZdezEsNn18I1swLTldezEsN318W2EtekEtWl0rKTsvZywKICAgICAgKHdob2xlLCBib2R5KSA9PiB7CiAgICAgICAgaWYgKGJvZHlbMF0gPT09ICcjJykgewogICAgICAgICAgY29uc3QgaGV4ID0gYm9keVsxXSA9PT0gJ3gnIHx8IGJvZHlbMV0gPT09",
"ICdYJzsKICAgICAgICAgIGNvbnN0IGNvZGUgPSBwYXJzZUludChib2R5LnNsaWNlKGhleCA_IDIgOiAxKSwgaGV4ID8gMTYgOiAxMCk7CiAgICAgICAgICAvLyBPdXQtb2YtcmFuZ2UgYW5kIHN1cnJvZ2F0ZSBjb2RlIHBvaW50cyB3b3VsZCB0aHJvdyBvciBwcm9kdWNlCiAgICAgICAgICAvLyBnYXJiYWdlOyBsZWF2ZSB0aGUgb3JpZ2luYWwgdGV4dCBhbG9uZSBpbnN0ZWFkLgogICAgICAgICAgaWYgKCFpc0Zpbml0ZShjb2RlKSB8fCBjb2RlIDwgMSB8fCBjb2RlID4gMHgxMGZmZmYgfHwKICAgICAgICAgICAgICAoY29kZSA-PSAweGQ4MDAgJiYgY29kZSA8PSAweGRmZmYpKSByZXR1cm4gd2hvbGU7CiAgICAgICAgICByZXR1cm4gU3RyaW5nLmZyb21Db2RlUG9pbnQoY29kZSk7CiAgICAgICAgfQogICAgICAgIGNvbnN0IG5hbWVkID0gTkFNRURbYm9keS50b0xvd2VyQ2FzZSgpXTsKICAgICAgICByZXR1cm4gbmFtZWQgPT09IHVuZGVmaW5lZCA_IHdob2xlIDogbmFtZWQ7CiAgICAgIH0KICAgICk7CiAgfQoKICAvLyDilIDilIAgQWNjb3VudCBkZXRlY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IEVNQUlMX09OTFlfUkUgPSAvXlteXHNAPD4oKSJdK0BbXlxzQDw-KCkiXStcLlte",
"XHNAPD4oKSJdKyQvOwogIGNvbnN0IEVNQUlMX0FOWV9SRSA9IC9bXlxzQDw-KCkiXStAW15cc0A8PigpIl0rXC5bXlxzQDw-KCkiXSsvOwoKICAvLyBHbWFpbCdzIHRpdGxlIGlzICI8dmlldyBvciBzdWJqZWN0PiAtIDxhY2NvdW50PiAtIDxwcm9kdWN0PiIsIGUuZy4KICAvLyAiSW5ib3ggKDMsNTkxKSAtIHNvbWVvbmVAZXhhbXBsZS5jb20gLSBHbWFpbCIuIFdvcmtzcGFjZSBhY2NvdW50cyBjYW4KICAvLyByZXBsYWNlICJHbWFpbCIgd2l0aCB0aGUgb3JnYW5pc2F0aW9uJ3Mgb3duIG5hbWUsIHNvIHRoZSBwcm9kdWN0IHBhcnQKICAvLyBpcyBub3QgbWF0Y2hlZC4gU2Nhbm5pbmcgZnJvbSB0aGUgcmlnaHQgZmluZHMgdGhlIGFjY291bnQgZXZlbiB3aGVuIGEKICAvLyBzdWJqZWN0IGxpbmUgY29udGFpbnMgYW4gYWRkcmVzcyBvciBhIGRhc2ggb2YgaXRzIG93bi4KICBmdW5jdGlvbiBhY2NvdW50RnJvbVRpdGxlKHRpdGxlKSB7CiAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyh0aXRsZSB8fCAnJykuc3BsaXQoL1xzWy3igJPigJRdXHMvKTsKICAgIGZvciAobGV0IGkgPSBwYXJ0cy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkgewogICAgICBjb25zdCBwID0gcGFydHNbaV0udHJpbSgpOwogICAgICBpZiAoRU1BSUxfT05MWV9SRS50ZXN0KHApKSByZXR1cm4gcC50b0xvd2VyQ2FzZSgpOwogICAgfQogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gIkdvb2dsZSBBY2NvdW50OiBBbm5hIFZvcyAgKGFubmFAZXhhbXBsZS5j",
"b20pIiDihpIgImFubmFAZXhhbXBsZS5jb20iCiAgZnVuY3Rpb24gYWNjb3VudEZyb21BcmlhTGFiZWwobGFiZWwpIHsKICAgIGNvbnN0IG0gPSBTdHJpbmcobGFiZWwgfHwgJycpLm1hdGNoKEVNQUlMX0FOWV9SRSk7CiAgICByZXR1cm4gbSA_IG1bMF0ucmVwbGFjZSgvWykuLDtdKyQvLCAnJykudG9Mb3dlckNhc2UoKSA6ICcnOwogIH0KCiAgLy8gIi9tYWlsL3UvMS8iIOKGkiAxLiBEZWZhdWx0cyB0byAwLCB3aGljaCBpcyB3aGF0IC9tYWlsLyBhbG9uZSBtZWFucy4KICBmdW5jdGlvbiBhY2NvdW50SW5kZXhGcm9tUGF0aChwYXRobmFtZSkgewogICAgY29uc3QgbSA9IFN0cmluZyhwYXRobmFtZSB8fCAnJykubWF0Y2goL1wvbWFpbFwvdVwvKFxkKylcLy8pOwogICAgcmV0dXJuIG0gPyBOdW1iZXIobVsxXSkgOiAwOwogIH0KCiAgLy8g4pSA4pSAIERhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTW9udGggYW5kIGRheSBuYW1lcyBhcmUgc3BlbGxlZCBvdXQgaGVyZSByYXRoZXIgdGhhbiB0YWtlbiBmcm9tCiAgLy8gSW50bCwgc28gYSBjYXJkIHJlYWRzIHRoZSBzYW1lIHdoYXRldmVyIHRoZSBicm93c2VyIGxvY2Fs",
"ZSBpcyBhbmQKICAvLyB0aGUgdGVzdHMgZG8gbm90IGRlcGVuZCBvbiB0aGUgbWFjaGluZSB0aGV5IHJ1biBvbi4KCiAgY29uc3QgTU9OVEhTID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsCiAgICAgICAgICAgICAgICAgICdKdWwnLCAnQXVnJywgJ1NlcCcsICdPY3QnLCAnTm92JywgJ0RlYyddOwogIGNvbnN0IERBWVMgPSBbJ1N1bicsICdNb24nLCAnVHVlJywgJ1dlZCcsICdUaHUnLCAnRnJpJywgJ1NhdCddOwoKICBmdW5jdGlvbiBzdGFydE9mRGF5KG1zKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUobXMpOwogICAgcmV0dXJuIG5ldyBEYXRlKGQuZ2V0RnVsbFllYXIoKSwgZC5nZXRNb250aCgpLCBkLmdldERhdGUoKSkuZ2V0VGltZSgpOwogIH0KCiAgLy8gQ29tcGFjdCBhZ2UgZm9yIGEgY2FyZDogImp1c3Qgbm93IiwgIjEyIG1pbiIsICIzIGgiLCAiWWVzdGVyZGF5IiwKICAvLyAiTW9uIiwgIjMgU2VwIiwgIjMgU2VwIDIwMjQiLiBIb3VycyB3aW4gb3ZlciAiWWVzdGVyZGF5IiBmb3IgYW55dGhpbmcKICAvLyB1bmRlciBhIGRheSBvbGQsIGJlY2F1c2UgIjIgaCIgaXMgbW9yZSB1c2VmdWwgYXQgMWFtIHRoYW4gIlllc3RlcmRheSIuCiAgZnVuY3Rpb24gcmVsYXRpdmVEYXRlKHRzLCBub3cgPSBEYXRlLm5vdygpKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fCAhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1h",
"eCgwLCBub3cgLSB0KTsKICAgIGNvbnN0IG1pbiA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgIGlmIChtaW4gPCAxKSByZXR1cm4gJ2p1c3Qgbm93JzsKICAgIGlmIChtaW4gPCA2MCkgcmV0dXJuIGAke21pbn0gbWluYDsKICAgIGNvbnN0IGhvdXJzID0gTWF0aC5mbG9vcihtaW4gLyA2MCk7CiAgICBpZiAoaG91cnMgPCAyNCkgcmV0dXJuIGAke2hvdXJzfSBoYDsKCiAgICAvLyBDYWxlbmRhciBkYXlzLCBub3QgMjQtaG91ciBibG9ja3MsIHNvICJZZXN0ZXJkYXkiIG1lYW5zIHllc3RlcmRheS4KICAgIGNvbnN0IGRheXMgPSBNYXRoLnJvdW5kKChzdGFydE9mRGF5KG5vdykgLSBzdGFydE9mRGF5KHQpKSAvIDg2NDAwMDAwKTsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGlmIChkYXlzIDw9IDEpIHJldHVybiAnWWVzdGVyZGF5JzsKICAgIGlmIChkYXlzIDwgNykgcmV0dXJuIERBWVNbZC5nZXREYXkoKV07CiAgICBjb25zdCBkbSA9IGAke2QuZ2V0RGF0ZSgpfSAke01PTlRIU1tkLmdldE1vbnRoKCldfWA7CiAgICByZXR1cm4gZC5nZXRGdWxsWWVhcigpID09PSBuZXcgRGF0ZShub3cpLmdldEZ1bGxZZWFyKCkgPyBkbSA6IGAke2RtfSAke2QuZ2V0RnVsbFllYXIoKX1gOwogIH0KCiAgLy8gRnVsbCBkYXRlIGZvciBhIHRvb2x0aXA6ICJUdWUgMyBTZXAgMjAyNiwgMTQ6MDUiLgogIGZ1bmN0aW9uIGZ1bGxEYXRlKHRzKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fCAh",
"aXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGNvbnN0IHBhZCA9IG4gPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgICByZXR1cm4gYCR7REFZU1tkLmdldERheSgpXX0gJHtkLmdldERhdGUoKX0gJHtNT05USFNbZC5nZXRNb250aCgpXX0gJHtkLmdldEZ1bGxZZWFyKCl9LCBgICsKICAgICAgICAgICBgJHtwYWQoZC5nZXRIb3VycygpKX06JHtwYWQoZC5nZXRNaW51dGVzKCkpfWA7CiAgfQoKICAvLyBGb3IgInVwZGF0ZWQgWHMgYWdvIiBpbiB0aGUgYm9hcmQgaGVhZGVyLgogIGZ1bmN0aW9uIGFnb1RleHQobXMpIHsKICAgIGNvbnN0IHMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKE51bWJlcihtcykgLyAxMDAwKSk7CiAgICBpZiAocyA8IDUpIHJldHVybiAnanVzdCBub3cnOwogICAgaWYgKHMgPCA2MCkgcmV0dXJuIGAke3N9cyBhZ29gOwogICAgY29uc3QgbSA9IE1hdGguZmxvb3IocyAvIDYwKTsKICAgIGlmIChtIDwgNjApIHJldHVybiBgJHttfSBtaW4gYWdvYDsKICAgIHJldHVybiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9IGggYWdvYDsKICB9CgogIC8vIOKUgOKUgCBDb25jdXJyZW5jeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi",
"lIDilIDilIDilIDilIAKCiAgLy8gUnVucyBmbiBvdmVyIGl0ZW1zIHdpdGggYXQgbW9zdCBgbGltaXRgIGluIGZsaWdodC4gR21haWwncyBwZXItdXNlcgogIC8vIHF1b3RhIGlzIGdlbmVyb3VzLCBidXQgYSBib2FyZCBvZiAxMDAgY2hhbmdlZCB0aHJlYWRzIGZpcmVkIGF0IG9uY2UKICAvLyBzdGlsbCB0cmlwcyBpdHMgYnVyc3QgbGltaXRlcjsgc2l4IGF0IGEgdGltZSBrZWVwcyBhIGNvbGQgbG9hZCBxdWljawogIC8vIHdpdGhvdXQgcHJvdm9raW5nIDQyOXMuIFRoZSBmaXJzdCByZWplY3Rpb24gc3RvcHMgbmV3IHdvcmsgc3RhcnRpbmcKICAvLyBhbmQgaXMgcmUtdGhyb3duLCBzbyBhbiBhdXRoIGZhaWx1cmUgZG9lcyBub3QgZmFuIG91dCBpbnRvIDEwMCBtb3JlLgogIGFzeW5jIGZ1bmN0aW9uIG1hcFBvb2woaXRlbXMsIGxpbWl0LCBmbikgewogICAgY29uc3QgcmVzdWx0cyA9IG5ldyBBcnJheShpdGVtcy5sZW5ndGgpOwogICAgbGV0IG5leHQgPSAwOwogICAgbGV0IGZhaWxlZCA9IG51bGw7CiAgICBhc3luYyBmdW5jdGlvbiB3b3JrZXIoKSB7CiAgICAgIHdoaWxlIChmYWlsZWQgPT09IG51bGwgJiYgbmV4dCA8IGl0ZW1zLmxlbmd0aCkgewogICAgICAgIGNvbnN0IGkgPSBuZXh0Kys7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHJlc3VsdHNbaV0gPSBhd2FpdCBmbihpdGVtc1tpXSwgaSk7CiAgICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgICBpZiAoZmFpbGVkID09PSBudWxsKSBmYWlsZWQgPSBl",
"cnI7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBjb25zdCBuID0gTWF0aC5tYXgoMSwgTWF0aC5taW4obGltaXQsIGl0ZW1zLmxlbmd0aCkpOwogICAgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogbiB9LCB3b3JrZXIpKTsKICAgIGlmIChmYWlsZWQgIT09IG51bGwpIHRocm93IGZhaWxlZDsKICAgIHJldHVybiByZXN1bHRzOwogIH0KCiAgY29uc3QgYXBpID0gewogICAgaGVhZGVyTWFwLCBwYXJzZUFkZHJlc3MsIGRpc3BsYXlOYW1lLCBkZWNvZGVFbnRpdGllcywKICAgIGFjY291bnRGcm9tVGl0bGUsIGFjY291bnRGcm9tQXJpYUxhYmVsLCBhY2NvdW50SW5kZXhGcm9tUGF0aCwKICAgIHJlbGF0aXZlRGF0ZSwgZnVsbERhdGUsIGFnb1RleHQsIG1hcFBvb2wsCiAgfTsKCiAgbnMudXRpbCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/notes-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGVzIGxvZ2ljIChwdXJ",
"lKQovLwovLyBBIG5vdGUgaXMgYW4gZW1haWwgdGhhdCB3YXMgbmV2ZXIgc2VudDogYSBtZXNzYWdlIHBsYWNlZCBzdHJhaWdodCBpbnRvCi8vIHRoZSB1c2VyJ3Mgb3duIG1haWxib3ggd2l0aCBtZXNzYWdlcy5pbnNlcnQsIGNhcnJ5aW5nIHRoZSBOb3RlcyBsYWJlbAovLyBhbmQgbm90aGluZyBlbHNlIC0gbm90IElOQk9YLCBub3QgVU5SRUFEIC0gc28gaXQgc3RheXMgb3V0IG9mIHRoZSB3YXkKLy8gdW50aWwgbG9va2VkIGZvciwgYW5kIEdtYWlsJ3Mgb3duIHNlYXJjaCBmaW5kcyBpdC4KLy8KLy8gR21haWwgbWVzc2FnZXMgY2Fubm90IGJlIGNoYW5nZWQgb25jZSBzdG9yZWQsIHNvIHNhdmluZyBhIG5vdGUgaW5zZXJ0cwovLyBhIG5ldyBtZXNzYWdlIGFuZCBtb3ZlcyB0aGUgcHJldmlvdXMgb25lIHRvIFRyYXNoLiBFYWNoIG5vdGUgY2FycmllcyBhCi8vIHN0YWJsZSBpZCBpbiBhbiBYLUdrYi1Ob3RlIGhlYWRlciwgd2hpY2ggaXMgaG93IGl0cyB2ZXJzaW9ucyBhcmUgdGllZAovLyB0b2dldGhlciBhbmQgLSBqdXN0IGFzIGltcG9ydGFudCAtIGhvdyB0aGUgYmFja2dyb3VuZCB3b3JrZXIgdGVsbHMgYQovLyBub3RlIGZyb20gcmVhbCBtYWlsOiBpdCB3aWxsIG9ubHkgaW5zZXJ0IG1lc3NhZ2VzIHRoYXQgY2FycnkgdGhlIGhlYWRlcgovLyBhbmQgb25seSB0cmFzaCBtZXNzYWdlcyB0aGF0IGFscmVhZHkgZG8uCi8vCi8vIExvYWRlZCBieSB0aGUgY29udGVudCBzY3JpcHRzLCB0aGUgc2VydmljZSB3b3JrZXI",
"gYW5kIE5vZGUncyB0ZXN0cy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IE5PVEVfSEVBREVSID0gJ1gtR2tiLU5vdGUnOwogIGNvbnN0IERFRkFVTFRfTEFCRUwgPSAnX05vdGVzJzsKICAvLyAuaW52YWxpZCBpcyByZXNlcnZlZCBhbmQgY2FuIG5ldmVyIGJlIGRlbGl2ZXJlZCB0bywgc28gbm90aGluZyBjYW4KICAvLyBldmVyIGFycml2ZSBmcm9tIG9yIGdvIHRvIHRoaXMgYWRkcmVzcy4KICBjb25zdCBOT1RFX1NFTkRFUiA9ICciTm90ZXMiIDxub3Rlc0Bub3Rlcy5pbnZhbGlkPic7CgogIC8vIEdlbmVyb3VzIGZvciB0eXBlZCBub3RlcywgYW5kIGtlZXBzIG9uZSBzYXZlIGNvbWZvcnRhYmx5IGluc2lkZSB3aGF0CiAgLy8gdGhlIG5vbi11cGxvYWQ",
"gaW5zZXJ0IGVuZHBvaW50IGFuZCBhIHJ1bnRpbWUgbWVzc2FnZSB3aWxsIGNhcnJ5LgogIGNvbnN0IE1BWF9CT0RZID0gMTAwMDAwOwogIGNvbnN0IE1BWF9USVRMRSA9IDMwMDsKCiAgLy8gTGFiZWxzIGEgbm90ZSBtYXkgbmV2ZXIgYmUgaW5zZXJ0ZWQgd2l0aC4gQSBub3RlIGluIHRoZSBJbmJveCwgb3IKICAvLyBkcmVzc2VkIHVwIGFzIHNlbnQgb3IgZHJhZnQgbWFpbCwgaXMgbm8gbG9uZ2VyIG91dCBvZiB0aGUgd2F5IC0gYW5kCiAgLy8gbm90aGluZyBoZXJlIHNob3VsZCBldmVyIGJlIGFibGUgdG8gcHV0IG1haWwgaW50byBTcGFtIG9yIFRyYXNoLgogIGNvbnN0IEZPUkJJRERFTl9JTlNFUlRfTEFCRUxTID0gbmV3IFNldChbJ0lOQk9YJywgJ1NFTlQnLCAnRFJBRlQnLCAnU1BBTScsICdUUkFTSCcsICdVTlJFQUQnXSk7CgogIC8vIOKUgOKUgCBJZHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IElEX1JFID0gL15bYS16MC05XXsxMiw0MH0kLzsKCiAgZnVuY3Rpb24gbmV3Tm90ZUlkKHJhbmQgPSBuID0-IGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKSB7CiAgICByZXR1cm4gQXJ",
"yYXkuZnJvbShyYW5kKDEyKSwgYiA9PiBiLnRvU3RyaW5nKDM2KS5wYWRTdGFydCgyLCAnMCcpLnNsaWNlKC0yKSkuam9pbignJykuc2xpY2UoMCwgMjApOwogIH0KCiAgLy8g4pSA4pSAIEVuY29kaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBieXRlc1RvQmluYXJ5KGJ5dGVzKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIHsKICAgICAgb3V0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCwgYnl0ZXMuc3ViYXJyYXkoaSwgaSArIDB4ODAwMCkpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJpbmFyeVRvQnl0ZXMoYmluKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmluLmxlbmd0aDsgaSsrKSBvdXRbaV0gPSBiaW4uY2hhckNvZGVBdChpKSAmIDB4ZmY7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgdXRmOFRvQmFzZTY0ID0gcyA9PiBidG9hKGJ5dGVzVG9CaW5hcnkobmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHMpKSk7Cgo",
"gIGZ1bmN0aW9uIGJhc2U2NFVybEVuY29kZShiaW5hcnkpIHsKICAgIHJldHVybiBidG9hKGJpbmFyeSkucmVwbGFjZSgvXCsvZywgJy0nKS5yZXBsYWNlKC9cLy9nLCAnXycpLnJlcGxhY2UoLz0rJC8sICcnKTsKICB9CgogIGZ1bmN0aW9uIGJhc2U2NFVybERlY29kZShzKSB7CiAgICBjb25zdCBiNjQgPSBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvLS9nLCAnKycpLnJlcGxhY2UoL18vZywgJy8nKS5yZXBsYWNlKC9ccysvZywgJycpOwogICAgcmV0dXJuIGF0b2IoYjY0ICsgJz0nLnJlcGVhdCgoNCAtIChiNjQubGVuZ3RoICUgNCkpICUgNCkpOwogIH0KCiAgLy8gVGV4dCBpbiB3aGF0ZXZlciBjaGFyc2V0IHRoZSBwYXJ0IGRlY2xhcmVkLiBBbiB1bmtub3duIG9yIG1pc2xhYmVsbGVkCiAgLy8gY2hhcnNldCBmYWxscyBiYWNrIHRvIFVURi04IHJhdGhlciB0aGFuIGZhaWxpbmcgdGhlIHdob2xlIG5vdGUuCiAgZnVuY3Rpb24gZGVjb2RlQnl0ZXMoYnl0ZXMsIGNoYXJzZXQpIHsKICAgIHRyeSB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoY2hhcnNldCB8fCAndXRmLTgnKS5kZWNvZGUoYnl0ZXMpOwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoJ3V0Zi04JykuZGVjb2RlKGJ5dGVzKTsKICAgIH0KICB9CgogIC8vIFJGQyAyMDQ3IGVuY29kZWQgd29yZHMsIGZvciBhIHN1YmplY3QgdGhhdCBpcyBub3QgcGxhaW4gQVNDSUkuIEF0IDM5CiAgLy8gYnl0ZXMgYSB3b3JkLCBldmV",
"uIHRoZSBmaXJzdCBsaW5lICgiU3ViamVjdDogIiBhbmQgb25lIHdvcmQpIHN0YXlzCiAgLy8gdW5kZXIgNzggY2hhcmFjdGVycywgYW5kIG5vIGNoYXJhY3RlciBpcyBzcGxpdCBhY3Jvc3MgdHdvIHdvcmRzLAogIC8vIHdoaWNoIHNvbWUgcmVhZGVycyB3b3VsZCBzaG93IGFzIHR3byBicm9rZW4gaGFsdmVzLgogIGZ1bmN0aW9uIGVuY29kZUhlYWRlclRleHQodGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICgvXltceDIwLVx4N2VdKiQvLnRlc3QocykpIHJldHVybiBzOwogICAgY29uc3Qgd29yZHMgPSBbXTsKICAgIGxldCBjaHVuayA9ICcnOwogICAgbGV0IGJ5dGVzID0gMDsKICAgIGZvciAoY29uc3QgY2ggb2YgcykgewogICAgICBjb25zdCBuID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGNoKS5sZW5ndGg7CiAgICAgIGlmIChieXRlcyArIG4gPiAzOSAmJiBjaHVuaykgewogICAgICAgIHdvcmRzLnB1c2goY2h1bmspOwogICAgICAgIGNodW5rID0gJyc7CiAgICAgICAgYnl0ZXMgPSAwOwogICAgICB9CiAgICAgIGNodW5rICs9IGNoOwogICAgICBieXRlcyArPSBuOwogICAgfQogICAgaWYgKGNodW5rKSB3b3Jkcy5wdXNoKGNodW5rKTsKICAgIHJldHVybiB3b3Jkcy5tYXAodyA9PiBgPT9VVEYtOD9CPyR7dXRmOFRvQmFzZTY0KHcpfT89YCkuam9pbignXHJcbiAnKTsKICB9CgogIC8vIFRoZSBpbnZlcnNlLCBmb3IgdGhlIHByZXZpZXcncyBmYWtlIEdtYWlsIGFuZCB",
"mb3IgdGhlIHRlc3RzLiAoVGhlIHJlYWwKICAvLyBBUEkgaGFuZHMgaGVhZGVycyBiYWNrIGFscmVhZHkgZGVjb2RlZC4pCiAgZnVuY3Rpb24gZGVjb2RlSGVhZGVyVGV4dCh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCAnJykKICAgICAgLnJlcGxhY2UoLyg9XD9bXj9dK1w_W0JiUXFdXD9bXj9dKlw_PSlccysoPz09XD8pL2csICckMScpCiAgICAgIC5yZXBsYWNlKC89XD8oW14_XSspXD8oW0JiUXFdKVw_KFteP10qKVw_PS9nLCAoXywgY2hhcnNldCwgZW5jLCB0ZXh0KSA9PiB7CiAgICAgICAgY29uc3QgYmluID0gZW5jLnRvVXBwZXJDYXNlKCkgPT09ICdCJwogICAgICAgICAgPyBhdG9iKHRleHQpCiAgICAgICAgICA6IHRleHQucmVwbGFjZSgvXy9nLCAnICcpLnJlcGxhY2UoLz0oWzAtOUEtRmEtZl17Mn0pL2csIChtLCBoZXgpID0-IFN0cmluZy5mcm9tQ2hhckNvZGUocGFyc2VJbnQoaGV4LCAxNikpKTsKICAgICAgICByZXR1cm4gZGVjb2RlQnl0ZXMoYmluYXJ5VG9CeXRlcyhiaW4pLCBjaGFyc2V0KTsKICAgICAgfSk7CiAgfQoKICAvLyBIZWFkZXIgdmFsdWVzIG5ldmVyIGNhcnJ5IGxpbmUgYnJlYWtzIG9mIHRoZWlyIG93bjogb25lIGluIGEgdGl0bGUKICAvLyB3b3VsZCBlbmQgdGhlIGhlYWRlciBlYXJseSBhbmQgc3RhcnQgYW5vdGhlciBvZiB0aGUgdXNlcidzIGNob29zaW5nLgogIGNvbnN0IG9uZUxpbmUgPSBzID0-IFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9bXHJcblx0XSsvZyw",
"gJyAnKS5yZXBsYWNlKC9cc3syLH0vZywgJyAnKS50cmltKCk7CgogIC8vIOKUgOKUgCBCdWlsZGluZyBhIG5vdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIEEgbm90ZSB3aXRoIG5vIHRpdGxlIGlzIGZpbGVkIHVuZGVyIGl0cyBmaXJzdCBsaW5lLCBhcyBtb3N0IG5vdGVzCiAgLy8gYXBwcyBkbywgc28gaXQgc3RpbGwgcmVhZHMgYXMgc29tZXRoaW5nIGluIEdtYWlsJ3MgbWVzc2FnZSBsaXN0LgogIGZ1bmN0aW9uIHRpdGxlRm9yKHRpdGxlLCBib2R5KSB7CiAgICBjb25zdCB0ID0gb25lTGluZSh0aXRsZSkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGlmICh0KSByZXR1cm4gdDsKICAgIGNvbnN0IGZpcnN0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnNwbGl0KCdcbicpLm1hcChsID0-IGwudHJpbSgpKS5maW5kKEJvb2xlYW4pIHx8ICcnOwogICAgcmV0dXJuIG9uZUxpbmUoZmlyc3QpLnNsaWNlKDAsIDgwKTsKICB9CgogIGZ1bmN0aW9uIHdyYXA3NihzKSB7CiAgICByZXR1cm4gcy5yZXBsYWNlKC8uezEsNzZ9L2csICckJlxyXG4nKS50cmltRW5kKCk7CiAgfQoKICBjb25zdCB0ZXh0UGFydCA9ICh0eXBlLCBzKSA9PiBbCiAgICBgQ29udGVudC1UeXBlOiAke3R5cGV9OyBjaGFyc2V",
"0PVVURi04YCwKICAgICdDb250ZW50LVRyYW5zZmVyLUVuY29kaW5nOiBiYXNlNjQnLAogICAgJycsCiAgICB3cmFwNzYodXRmOFRvQmFzZTY0KHMucmVwbGFjZSgvXG4vZywgJ1xyXG4nKSkpLAogIF07CgogIC8vIGBib2R5YCBpcyB0aGUgcGxhaW4gdGV4dC4gV2l0aCBgaHRtbGAgYXMgd2VsbCwgdGhlIG5vdGUgaXMgYQogIC8vIG11bHRpcGFydC9hbHRlcm5hdGl2ZSBtZXNzYWdlOiBHbWFpbCBzaG93cyB0aGUgSFRNTCwgYW5kIGl0cyBwcmV2aWV3cwogIC8vIGFuZCBwbGFpbi10ZXh0IHJlYWRlcnMgZ2V0IHRoZSB0ZXh0LgogIGZ1bmN0aW9uIGJ1aWxkTm90ZVJhdyh7IG5vdGVJZCwgdGl0bGUsIGJvZHksIGh0bWwsIGFjY291bnQsIGRhdGUgPSBuZXcgRGF0ZSgpIH0pIHsKICAgIGlmICghSURfUkUudGVzdChTdHJpbmcobm90ZUlkIHx8ICcnKSkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBub3RlIGlkJyk7CiAgICBjb25zdCBtZSA9IG9uZUxpbmUoYWNjb3VudCk7CiAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNsaWNlKDAsIE1BWF9CT0RZKTsKICAgIGNvbnN0IGhlYWQgPSBbCiAgICAgIC8vIE5vdCBmcm9tIHRoZSBhY2NvdW50J3Mgb3duIGFkZHJlc3M6IEdtYWlsIGZpbGVzIGFueXRoaW5nIGZyb20geW91CiAgICAgIC8vIHVuZGVyIFNlbnQsIHdoYXRldmVyIGxhYmVscyBpdCB3YXMgZ2l2ZW4uIFJlcGxpZXMgc3RpbGwgcmVhY2ggeW91LgogICA",
"gICBgRnJvbTogJHtOT1RFX1NFTkRFUn1gLAogICAgICBgVG86ICR7bWV9YCwKICAgICAgYFJlcGx5LVRvOiAke21lfWAsCiAgICAgIGBTdWJqZWN0OiAke2VuY29kZUhlYWRlclRleHQodGl0bGVGb3IodGl0bGUsIHRleHQpIHx8ICdVbnRpdGxlZCBub3RlJyl9YCwKICAgICAgYERhdGU6ICR7ZGF0ZS50b1VUQ1N0cmluZygpfWAsCiAgICAgIGBNZXNzYWdlLUlEOiA8JHtub3RlSWR9LiR7ZGF0ZS5nZXRUaW1lKCl9QG5vdGVzLmludmFsaWQ-YCwKICAgICAgYCR7Tk9URV9IRUFERVJ9OiAke25vdGVJZH1gLAogICAgICAnTUlNRS1WZXJzaW9uOiAxLjAnLAogICAgXTsKICAgIGxldCBsaW5lczsKICAgIGlmIChodG1sKSB7CiAgICAgIC8vIEJhc2U2NCBuZXZlciBjb250YWlucyAiLSIsIHNvIHRoaXMgYm91bmRhcnkgY2Fubm90IG9jY3VyIGluIGEgcGFydC4KICAgICAgY29uc3QgYm91bmRhcnkgPSBgZ2tiLSR7bm90ZUlkfS0ke2RhdGUuZ2V0VGltZSgpfWA7CiAgICAgIGxpbmVzID0gWwogICAgICAgIC4uLmhlYWQsCiAgICAgICAgYENvbnRlbnQtVHlwZTogbXVsdGlwYXJ0L2FsdGVybmF0aXZlOyBib3VuZGFyeT0iJHtib3VuZGFyeX0iYCwKICAgICAgICAnJywKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvcGxhaW4nLCB0ZXh0KSwKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvaHRtbCcsIFN0cmluZyhodG1sKSksCiAgICAgICA",
"gYC0tJHtib3VuZGFyeX0tLWAsCiAgICAgICAgJycsCiAgICAgIF07CiAgICB9IGVsc2UgewogICAgICBsaW5lcyA9IFsuLi5oZWFkLCAuLi50ZXh0UGFydCgndGV4dC9wbGFpbicsIHRleHQpLCAnJ107CiAgICB9CiAgICByZXR1cm4gYmFzZTY0VXJsRW5jb2RlKGxpbmVzLmpvaW4oJ1xyXG4nKSk7CiAgfQoKICAvLyDilIDilIAgV2hhdCB0aGUgd29ya2VyIGFsbG93cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaGVhZGVyQmxvY2soYmluYXJ5KSB7CiAgICBjb25zdCBlbmQgPSBiaW5hcnkuc2VhcmNoKC9ccj9cblxyP1xuLyk7CiAgICByZXR1cm4gZW5kIDwgMCA_IGJpbmFyeSA6IGJpbmFyeS5zbGljZSgwLCBlbmQpOwogIH0KCiAgLy8gVGhlIG5vdGUgaWQgYSByYXcgbWVzc2FnZSBjYXJyaWVzLCBvciAnJyBpZiBpdCBpcyBub3QgYSBub3RlLgogIGZ1bmN0aW9uIG5vdGVJZE9mUmF3KHJhdykgewogICAgbGV0IGJpbjsKICAgIHRyeSB7IGJpbiA9IGJhc2U2NFVybERlY29kZShyYXcpOyB9IGNhdGNoIHsgcmV0dXJuICcnOyB9CiAgICBjb25zdCBtID0gaGVhZGVyQmxvY2soYmluKS5tYXRjaChuZXcgUmVnRXhwKGBeJHtOT1RFX0hFQURFUn06WyBcXHRdKihbXlxcclxcbl0qKSRgLCAnbWknKSk7CiAgICBjb25",
"zdCBpZCA9IG0gPyBtWzFdLnRyaW0oKSA6ICcnOwogICAgcmV0dXJuIElEX1JFLnRlc3QoaWQpID8gaWQgOiAnJzsKICB9CgogIC8vIFRoZSBib2R5IG9mIGEgbWVzc2FnZXMuaW5zZXJ0IHRoZSB3b3JrZXIgd2lsbCBwYXNzIG9uOiBhIG5vdGUsIGZpbGVkCiAgLy8gdW5kZXIgdXNlciBsYWJlbHMgb25seSwgYW5kIG5vdGhpbmcgZWxzZSBpbiB0aGUgcmVxdWVzdC4KICBmdW5jdGlvbiBpc05vdGVJbnNlcnQoYm9keSkgewogICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgYm9keS5yYXcgIT09ICdzdHJpbmcnKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBleHRyYSA9IE9iamVjdC5rZXlzKGJvZHkpLmZpbHRlcihrID0-IGsgIT09ICdyYXcnICYmIGsgIT09ICdsYWJlbElkcycpOwogICAgaWYgKGV4dHJhLmxlbmd0aCkgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgbGFiZWxzID0gYm9keS5sYWJlbElkcyA9PT0gdW5kZWZpbmVkID8gW10gOiBib2R5LmxhYmVsSWRzOwogICAgaWYgKCFBcnJheS5pc0FycmF5KGxhYmVscykpIHJldHVybiBmYWxzZTsKICAgIGlmIChsYWJlbHMuc29tZShpZCA9PiBGT1JCSURERU5fSU5TRVJUX0xBQkVMUy5oYXMoU3RyaW5nKGlkKS50b1VwcGVyQ2FzZSgpKSkpIHJldHVybiBmYWxzZTsKICAgIHJldHVybiAhIW5vdGVJZE9mUmF3KGJvZHkucmF3KTsKICB9CgogIC8vIOKUgOKUgCBSZWFkaW5nIG5vdGVzIGJhY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGhlYWRlck9mKG1lc3NhZ2UsIG5hbWUpIHsKICAgIHJldHVybiB1dGlsLmhlYWRlck1hcChtZXNzYWdlKVtuYW1lLnRvTG93ZXJDYXNlKCldIHx8ICcnOwogIH0KCiAgZnVuY3Rpb24gY2hhcnNldE9mKHBhcnQpIHsKICAgIGNvbnN0IGN0ID0gKHBhcnQuaGVhZGVycyB8fCBbXSkuZmluZChoID0-IGgubmFtZS50b0xvd2VyQ2FzZSgpID09PSAnY29udGVudC10eXBlJyk7CiAgICBjb25zdCBtID0gY3QgJiYgL2NoYXJzZXQ9Ij8oW14iO1xzXSspIj8vaS5leGVjKGN0LnZhbHVlKTsKICAgIHJldHVybiBtID8gbVsxXSA6ICd1dGYtOCc7CiAgfQoKICBmdW5jdGlvbiBwYXJ0VGV4dChwYXJ0KSB7CiAgICBpZiAoIXBhcnQgfHwgIXBhcnQuYm9keSB8fCAhcGFydC5ib2R5LmRhdGEpIHJldHVybiAnJzsKICAgIHJldHVybiBkZWNvZGVCeXRlcyhiaW5hcnlUb0J5dGVzKGJhc2U2NFVybERlY29kZShwYXJ0LmJvZHkuZGF0YSkpLCBjaGFyc2V0T2YocGFydCkpOwogIH0KCiAgLy8gQSByb3VnaCB0ZXh0IHJlbmRlcmluZyBvZiBhbiBIVE1MIGVtYWlsLCBmb3Igbm90ZXMgdGhhdCBhcnJpdmVkIGFzCiAgLy8gbWFpbCAoc2F5LCBzZW50IHRvIHlvdXJzZWxmIGZyb20gYSBwaG9uZSkuIERvbmUgd2l",
"0aCBwYXR0ZXJucyByYXRoZXIKICAvLyB0aGFuIHRoZSBET006IHBhcnNpbmcgSFRNTCBpbnRvIGEgZG9jdW1lbnQgaXMgYSBUcnVzdGVkIFR5cGVzIHNpbmsgb24KICAvLyBHbWFpbCdzIHBhZ2UsIGFuZCBvbmx5IHRoZSB3b3JkcyBhcmUgd2FudGVkIGFueXdheS4KICBmdW5jdGlvbiBodG1sVG9UZXh0KGh0bWwpIHsKICAgIGNvbnN0IHRleHQgPSBTdHJpbmcoaHRtbCB8fCAnJykKICAgICAgLnJlcGxhY2UoLzwoc2NyaXB0fHN0eWxlfGhlYWR8dGl0bGUpXGJbXj5dKj5bXHNcU10qPzxcL1wxXHMqPi9naSwgJycpCiAgICAgIC5yZXBsYWNlKC88YnJccypcLz8-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPGxpXGJbXj5dKj4vZ2ksICdcbuKAoiAnKQogICAgICAucmVwbGFjZSgvPFwvKHB8ZGl2fHVsfG9sfHRyfGhbMS02XXxibG9ja3F1b3RlfHByZXx0YWJsZSlccyo-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPFtePl0rPi9nLCAnJyk7CiAgICByZXR1cm4gdXRpbC5kZWNvZGVFbnRpdGllcyh0ZXh0KQogICAgICAucmVwbGFjZSgvXHUwMGEwL2csICcgJykKICAgICAgLnJlcGxhY2UoL1sgXHRdK1xuL2csICdcbicpCiAgICAgIC5yZXBsYWNlKC9cbnszLH0vZywgJ1xuXG4nKQogICAgICAudHJpbSgpOwogIH0KCiAgZnVuY3Rpb24gdGV4dFBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHBsYWluID0gW107CiAgICBjb25zdCBodG1sID0gW107CiAgICAoZnVuY3Rpb24gd2FsayhwKSB7CiAgICAgIGlmICghcCk",
"gcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gU3RyaW5nKHAubWltZVR5cGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmICh0eXBlID09PSAndGV4dC9wbGFpbicpIHBsYWluLnB1c2gocCk7CiAgICAgIGVsc2UgaWYgKHR5cGUgPT09ICd0ZXh0L2h0bWwnKSBodG1sLnB1c2gocCk7CiAgICAgIChwLnBhcnRzIHx8IFtdKS5mb3JFYWNoKHdhbGspOwogICAgfSkocGF5bG9hZCk7CiAgICByZXR1cm4geyBwbGFpbiwgaHRtbCB9OwogIH0KCiAgLy8gUHJlZmVycyBhIHRleHQvcGxhaW4gcGFydCBhbnl3aGVyZSBpbiB0aGUgdHJlZSwgdGhlbiBIVE1MLgogIGZ1bmN0aW9uIGV4dHJhY3RUZXh0KHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIGlmIChwbGFpbi5sZW5ndGgpIHJldHVybiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKTsKICAgIGlmIChodG1sLmxlbmd0aCkgcmV0dXJuIGh0bWxUb1RleHQoaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykpOwogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gQm90aCByZW5kZXJpbmdzLCBkZWNvZGVkLCBmb3IgdGhlIGZvcm1hdHRlZCByZWFkZXI6IHRoZSBIVE1MIGlzIHRoZQogIC8vIHJlY29yZCwgdGhlIHBsYWluIHRleHQgdGhlIGZhbGxiYWNrIGZvciBtYWlsIHRoYXQgaGFzIG5vIEhUTUwuCiAgZnVuY3Rpb24gbWV",
"zc2FnZVBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIHJldHVybiB7CiAgICAgIHBsYWluOiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKSwKICAgICAgaHRtbDogaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJyksCiAgICB9OwogIH0KCiAgLy8gT25lIG5vdGUgZnJvbSBhIG1lc3NhZ2VzLmdldC4gV2l0aCBmb3JtYXQ9bWV0YWRhdGEgdGhlcmUgaXMgbm8gYm9keQogIC8vIChib2R5IHN0YXlzIG51bGwpOyB3aXRoIGZvcm1hdD1mdWxsIHRoZXJlIGlzLgogIGZ1bmN0aW9uIG5vdGVGcm9tTWVzc2FnZShtc2cpIHsKICAgIGNvbnN0IG5vdGVJZCA9IGhlYWRlck9mKG1zZywgTk9URV9IRUFERVIpLnRyaW0oKTsKICAgIGNvbnN0IG93biA9IElEX1JFLnRlc3Qobm90ZUlkKTsKICAgIGNvbnN0IGZ1bGwgPSAhIShtc2cucGF5bG9hZCAmJiAobXNnLnBheWxvYWQuYm9keSB8fCBtc2cucGF5bG9hZC5wYXJ0cykpOwogICAgcmV0dXJuIHsKICAgICAgbWVzc2FnZUlkOiBtc2cuaWQsCiAgICAgIHRocmVhZElkOiBtc2cudGhyZWFkSWQgfHwgJycsCiAgICAgIG5vdGVJZDogb3duID8gbm90ZUlkIDogJycsCiAgICAgIG93biwKICAgICAga2V5OiBvd24gPyBgbjoke25vdGVJZH1gIDogYG06JHttc2cuaWR9YCwKICAgICAgdGl0bGU6IG9uZUxpbmUoaGVhZGVyT2YobXN",
"nLCAnU3ViamVjdCcpKSB8fCAnVW50aXRsZWQgbm90ZScsCiAgICAgIHVwZGF0ZWQ6IE51bWJlcihtc2cuaW50ZXJuYWxEYXRlKSB8fCBEYXRlLnBhcnNlKGhlYWRlck9mKG1zZywgJ0RhdGUnKSkgfHwgMCwKICAgICAgc25pcHBldDogdXRpbC5kZWNvZGVFbnRpdGllcyhtc2cuc25pcHBldCB8fCAnJyksCiAgICAgIGJvZHk6IGZ1bGwgPyBleHRyYWN0VGV4dChtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBwYXJ0czogZnVsbCA_IG1lc3NhZ2VQYXJ0cyhtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBsYWJlbElkczogbXNnLmxhYmVsSWRzIHx8IFtdLAogICAgfTsKICB9CgogIC8vIFR3byBsaXZlIHZlcnNpb25zIG9mIG9uZSBub3RlIG1lYW4gYSBzYXZlIGluc2VydGVkIHRoZSBuZXcgb25lIGJ1dAogIC8vIGNvdWxkIG5vdCB0cmFzaCB0aGUgb2xkIChvZmZsaW5lLCBjbG9zZWQgdGFiKSwgb3IgdHdvIGNvbXB1dGVycyBzYXZlZAogIC8vIGF0IG9uY2UuIFRoZSBuZXdlc3Qgd2luczsgdGhlIHJlc3QgYXJlIHJlcG9ydGVkIHNvIHRoZXkgY2FuIGJlCiAgLy8gdGlkaWVkIGludG8gVHJhc2gsIHdoZXJlIHRoZXkgc3RheSByZWNvdmVyYWJsZSBmb3IgdGhpcnR5IGRheXMuCiAgZnVuY3Rpb24gZGVkdXBlTm90ZXMobm90ZXMpIHsKICAgIGNvbnN0IGxpdmUgPSBbXTsKICAgIGNvbnN0IHN0YWxlID0gW107CiAgICBjb25zdCBiZXN0ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSB7CiAgICAgIGN",
"vbnN0IGN1ciA9IGJlc3QuZ2V0KG4ua2V5KTsKICAgICAgaWYgKCFjdXIpIHsgYmVzdC5zZXQobi5rZXksIG4pOyBjb250aW51ZTsgfQogICAgICBpZiAobi51cGRhdGVkID4gY3VyLnVwZGF0ZWQpIHsgc3RhbGUucHVzaChjdXIpOyBiZXN0LnNldChuLmtleSwgbik7IH0KICAgICAgZWxzZSBzdGFsZS5wdXNoKG4pOwogICAgfQogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSBpZiAoYmVzdC5nZXQobi5rZXkpID09PSBuKSBsaXZlLnB1c2gobik7CiAgICBsaXZlLnNvcnQoKGEsIGIpID0-IGIudXBkYXRlZCAtIGEudXBkYXRlZCk7CiAgICByZXR1cm4geyBsaXZlLCBzdGFsZSB9OwogIH0KCiAgLy8g4pSA4pSAIEZvbGRlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGZvbGRlciBpcyBhIEdtYWlsIGxhYmVsIHVuZGVyIHRoZSBub3RlcyBsYWJlbDogIl9Ob3Rlcy9Xb3JrIiwKICAvLyAiX05vdGVzL1dvcmsvQ2xpZW50cyIuIEV2ZXJ5IG5vdGUgY2FycmllcyB0aGUgbm90ZXMgbGFiZWwgaXRzZWxmLCBwbHVzCiAgLy8gdGhlIGxhYmVsIG9mIGF0IG1vc3Qgb25lIGZvbGRlciAtIHNvICJBbGwgbm90ZXMiIGlzIG9uZSBsYWJlbCwgYW5",
"kIHRoZQogIC8vIGZvbGRlcnMgc2hvdyB1cCBuZXN0ZWQgdW5kZXIgX05vdGVzIGluIEdtYWlsJ3Mgb3duIGxhYmVsIGxpc3QuCgogIGNvbnN0IEZPTERFUl9OQU1FX01BWCA9IDYwOwoKICAvLyBUaGUgZm9sZGVycyB1bmRlciBgcm9vdGAsIGluIHRyZWUgb3JkZXI6IGVhY2ggcGFyZW50IGZvbGxvd2VkIGJ5IGl0cwogIC8vIGNoaWxkcmVuLCBhbHBoYWJldGljYWxseSwgd2l0aCBpdHMgZGVwdGguIEEgbGFiZWwgd2hvc2UgcGFyZW50IGxhYmVsCiAgLy8gaXMgbWlzc2luZyAobWFkZSBieSBoYW5kIGluIEdtYWlsKSBzdGlsbCBhcHBlYXJzLCBhdCBpdHMgb3duIGRlcHRoLgogIGZ1bmN0aW9uIGZvbGRlclRyZWUobGFiZWxzLCByb290KSB7CiAgICBjb25zdCBwcmVmaXggPSBgJHtyb290fS9gOwogICAgY29uc3QgbGlzdCA9IChsYWJlbHMgfHwgW10pCiAgICAgIC5maWx0ZXIobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKHByZWZpeCkgJiYgbC5uYW1lLmxlbmd0aCA-IHByZWZpeC5sZW5ndGgpCiAgICAgIC5tYXAobCA9PiB7CiAgICAgICAgY29uc3QgcGF0aCA9IGwubmFtZS5zbGljZShwcmVmaXgubGVuZ3RoKTsKICAgICAgICBjb25zdCBwYXJ0cyA9IHBhdGguc3BsaXQoJy8nKTsKICAgICAgICByZXR1cm4geyBpZDogbC5pZCwgbmFtZTogbC5uYW1lLCBwYXRoLCB0aXRsZTogcGFydHNbcGFydHMubGVuZ3RoIC0gMV0sIGRlcHRoOiBwYXJ0cy5sZW5ndGggLSA",
"xLCBwYXJlbnRQYXRoOiBwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpIH07CiAgICAgIH0pOwogICAgLy8gU29ydGluZyBieSBwYXRoIHNlZ21lbnQgYnkgc2VnbWVudCBrZWVwcyBldmVyeSBjaGlsZCB1bmRlciBpdHMgcGFyZW50LgogICAgY29uc3Qga2V5ID0gZiA9PiBmLnBhdGguc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRvTG93ZXJDYXNlKCkpOwogICAgbGlzdC5zb3J0KChhLCBiKSA9PiB7CiAgICAgIGNvbnN0IHggPSBrZXkoYSk7CiAgICAgIGNvbnN0IHkgPSBrZXkoYik7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5taW4oeC5sZW5ndGgsIHkubGVuZ3RoKTsgaSsrKSB7CiAgICAgICAgaWYgKHhbaV0gIT09IHlbaV0pIHJldHVybiB4W2ldIDwgeVtpXSA_IC0xIDogMTsKICAgICAgfQogICAgICByZXR1cm4geC5sZW5ndGggLSB5Lmxlbmd0aDsKICAgIH0pOwogICAgcmV0dXJuIGxpc3Q7CiAgfQoKICAvLyBUaGUgZm9sZGVyIGEgbm90ZSBpcyBpbiwgZnJvbSBpdHMgbGFiZWxzOyAnJyBmb3Igbm9uZS4gVHdvIGZvbGRlcgogIC8vIGxhYmVscyAoYXBwbGllZCBieSBoYW5kKSByZXNvbHZlIHRvIHRoZSBmaXJzdCBpbiB0cmVlIG9yZGVyLgogIGZ1bmN0aW9uIGZvbGRlck9mKGxhYmVsSWRzLCBmb2xkZXJzKSB7CiAgICBjb25zdCBoYXZlID0gbmV3IFNldChsYWJlbElkcyB8fCBbXSk7CiAgICBjb25zdCBmID0gKGZvbGRlcnMgfHwgW10pLmZpbmQoeCA9PiBoYXZlLmhhcyh4LmlkKSk7CiAgICByZXR",
"1cm4gZiA_IGYuaWQgOiAnJzsKICB9CgogIC8vIE1vdmluZyBhIG5vdGU6IGtlZXAgKG9yIHJlc3RvcmUpIHRoZSBub3RlcyBsYWJlbCwgYWRkIHRoZSB0YXJnZXQncywKICAvLyBkcm9wIGV2ZXJ5IG90aGVyIGZvbGRlcidzLgogIGZ1bmN0aW9uIG1vdmVGb2xkZXJEaWZmKHJvb3RJZCwgZm9sZGVycywgdGFyZ2V0SWQpIHsKICAgIGNvbnN0IGFkZCA9IFtyb290SWRdOwogICAgaWYgKHRhcmdldElkKSBhZGQucHVzaCh0YXJnZXRJZCk7CiAgICBjb25zdCByZW1vdmUgPSAoZm9sZGVycyB8fCBbXSkubWFwKGYgPT4gZi5pZCkuZmlsdGVyKGlkID0-IGlkICE9PSB0YXJnZXRJZCk7CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogYWRkLCByZW1vdmVMYWJlbElkczogcmVtb3ZlIH07CiAgfQoKICBmdW5jdGlvbiB2YWxpZGF0ZUZvbGRlclRpdGxlKHRpdGxlLCBzaWJsaW5ncyA9IFtdKSB7CiAgICBjb25zdCB0ID0gU3RyaW5nKHRpdGxlIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXQpIHJldHVybiAnR2l2ZSB0aGUgZm9sZGVyIGEgbmFtZS4nOwogICAgaWYgKHQuaW5jbHVkZXMoJy8nKSkgcmV0dXJuICdBIGZvbGRlciBuYW1lIGNhbm5vdCBjb250YWluIOKAnC_igJ0uIE1ha2UgYSBzdWJmb2xkZXIgaW5zdGVhZC4nOwogICAgaWYgKHQubGVuZ3RoID4gRk9MREVSX05BTUVfTUFYKSByZXR1cm4gYEtlZXAgZm9sZGVyIG5hbWVzIHVuZGVyICR7Rk9MREVSX05BTUVfTUFYfSBjaGFyYWN0ZXJzLmA7CiAgICBpZiAoc2libGluZ3M",
"uc29tZShzID0-IHMudG9Mb3dlckNhc2UoKSA9PT0gdC50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuIGBUaGVyZSBpcyBhbHJlYWR5IGEgZm9sZGVyIGNhbGxlZCDigJwke3R94oCdIGhlcmUuYDsKICAgIHJldHVybiAnJzsKICB9CgogIC8vIFJlbmFtaW5nIGEgZm9sZGVyIHJlbmFtZXMgaXRzIGxhYmVsIGFuZCBldmVyeSBsYWJlbCBiZWxvdyBpdCwgc2luY2UKICAvLyBHbWFpbCdzIEFQSSByZW5hbWVzIG9ubHkgdGhlIG9uZSBsYWJlbCBpdCBpcyBnaXZlbi4KICBmdW5jdGlvbiByZW5hbWVQbGFuKGZvbGRlciwgbmV3VGl0bGUsIGZvbGRlcnMpIHsKICAgIGNvbnN0IHBhcmVudCA9IGZvbGRlci5uYW1lLnNsaWNlKDAsIGZvbGRlci5uYW1lLmxlbmd0aCAtIGZvbGRlci50aXRsZS5sZW5ndGgpOwogICAgY29uc3QgbmV3TmFtZSA9IGAke3BhcmVudH0ke1N0cmluZyhuZXdUaXRsZSkudHJpbSgpfWA7CiAgICByZXR1cm4gKGZvbGRlcnMgfHwgW10pCiAgICAgIC5maWx0ZXIoZiA9PiBmLm5hbWUgPT09IGZvbGRlci5uYW1lIHx8IGYubmFtZS5zdGFydHNXaXRoKGAke2ZvbGRlci5uYW1lfS9gKSkKICAgICAgLm1hcChmID0-ICh7IGlkOiBmLmlkLCBuYW1lOiBuZXdOYW1lICsgZi5uYW1lLnNsaWNlKGZvbGRlci5uYW1lLmxlbmd0aCkgfSkpOwogIH0KCiAgLy8gV2hldGhlciB0aGUgd29ya2VyIG1heSBkZWxldGUgYSBsYWJlbDogYSBmb2xkZXIgdW5kZXIgdGhlIG5vdGVzIGxhYmVsCiAgLy8gd2l0aCBubyBub3RlcyBpbiBpdCB",
"hbmQgbm8gZm9sZGVycyB1bmRlciBpdC4gYGxpdmVNZXNzYWdlc2AgaXMgd2hhdCBhCiAgLy8gbWVzc2FnZXMubGlzdCBvbiB0aGUgbGFiZWwgZm91bmQgLSBub3QgdGhlIGxhYmVsJ3Mgb3duIGNvdW50LCB3aGljaAogIC8vIGFsc28gY291bnRzIG9sZCB2ZXJzaW9ucyB3YWl0aW5nIGluIFRyYXNoIGFuZCB3b3VsZCBrZWVwIGFuIGVtcHRpZWQKICAvLyBmb2xkZXIgdW5kZWxldGFibGUgZm9yIGEgbW9udGguCiAgZnVuY3Rpb24gaXNEZWxldGFibGVGb2xkZXIobGFiZWwsIHJvb3QsIGFsbExhYmVscywgbGl2ZU1lc3NhZ2VzKSB7CiAgICBpZiAoIWxhYmVsIHx8IHR5cGVvZiBsYWJlbC5uYW1lICE9PSAnc3RyaW5nJyB8fCAhcm9vdCkgcmV0dXJuIGZhbHNlOwogICAgaWYgKCFsYWJlbC5uYW1lLnN0YXJ0c1dpdGgoYCR7cm9vdH0vYCkgfHwgbGFiZWwubmFtZS5sZW5ndGggPD0gcm9vdC5sZW5ndGggKyAxKSByZXR1cm4gZmFsc2U7CiAgICBpZiAobGl2ZU1lc3NhZ2VzICE9PSAwKSByZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gIShhbGxMYWJlbHMgfHwgW10pLnNvbWUobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKGAke2xhYmVsLm5hbWV9L2ApKTsKICB9CgogIGNvbnN0IGFwaSA9IHsKICAgIE5PVEVfSEVBREVSLCBOT1RFX1NFTkRFUiwgREVGQVVMVF9MQUJFTCwgTUFYX0JPRFksIE1BWF9USVRMRSwgRk9SQklEREVOX0lOU0VSVF9MQUJFTFMsIEZPTERFUl9OQU1",
"FX01BWCwKICAgIGZvbGRlclRyZWUsIGZvbGRlck9mLCBtb3ZlRm9sZGVyRGlmZiwgdmFsaWRhdGVGb2xkZXJUaXRsZSwgcmVuYW1lUGxhbiwgaXNEZWxldGFibGVGb2xkZXIsCiAgICBuZXdOb3RlSWQsIGVuY29kZUhlYWRlclRleHQsIGRlY29kZUhlYWRlclRleHQsIGJhc2U2NFVybEVuY29kZSwgYmFzZTY0VXJsRGVjb2RlLAogICAgdGl0bGVGb3IsIGJ1aWxkTm90ZVJhdywgbm90ZUlkT2ZSYXcsIGlzTm90ZUluc2VydCwKICAgIGh0bWxUb1RleHQsIGV4dHJhY3RUZXh0LCBtZXNzYWdlUGFydHMsIG5vdGVGcm9tTWVzc2FnZSwgZGVkdXBlTm90ZXMsCiAgfTsKCiAgbnMubm90ZXNMb2dpYyA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/note-format.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGUgZm9ybWF0dGluZyAocHVyZSkKLy8KLy8gQSBmb3JtYXR0ZWQgbm90ZSBpcyBhIGxpc3Qgb2YgYmxvY2tzIC0gcGFyYWdyYXBocywgdGhyZWUgaGVhZG",
"luZwovLyBzaXplcywgYnVsbGV0ZWQsIG51bWJlcmVkIGFuZCBjaGVjayBsaXN0cyBuZXN0ZWQgdXAgdG8gdGhyZWUgZGVlcCAtCi8vIGVhY2ggaG9sZGluZyBydW5zIG9mIHRleHQgdGhhdCBtYXkgYmUgYm9sZCwgaXRhbGljLCBzdHJ1Y2sgdGhyb3VnaCBvcgovLyBhIGxpbmsuIFRoYXQgaXMgdGhlIHdob2xlIG1vZGVsOyBub3RoaW5nIG91dHNpZGUgaXQgc3Vydml2ZXMgYSBzYXZlLgovLwovLyBJdCBpcyBzdG9yZWQgaW4gdGhlIG5vdGUncyBtZXNzYWdlIHR3aWNlLiBUaGUgSFRNTCBwYXJ0IGlzIHRoZSByZWFsCi8vIHJlY29yZDogR21haWwgc2hvd3MgaXQgKG9uIHRoZSBwaG9uZSB0b28pLCBhbmQgdGhpcyBmaWxlIHJlYWRzIGl0IGJhY2sKLy8gd2l0aCBhIHNtYWxsIHRva2VuaXplciBvZiBpdHMgb3duIHJhdGhlciB0aGFuIHRoZSBicm93c2VyJ3MgSFRNTAovLyBwYXJzZXIsIHdoaWNoIGlzIGEgVHJ1c3RlZCBUeXBlcyBzaW5rIG9uIEdtYWlsJ3MgcGFnZSBhbmQgd291bGQgYWNjZXB0Ci8vIGZhciBtb3JlIHRoYW4gdGhlIG1vZGVsIGNhbiBob2xkLiBUaGUgcGxhaW4tdGV4dCBwYXJ0IGlzIGEgcmVhZGFibGUKLy8gcmVuZGVyaW5nIC0gYnVsbGV0cywg4piQIGFuZCDimJEgLSBmb3IgR21haWwncyBwcmV2aWV3cyBhbmQgZm9yIGFueSBtYWlsCi8vIGNsaWVudCB0aGF0IHNob3dzIHRleHQuCi8vCi8vIE1haWwgdGhhdCBhcnJpdmVkIGFzIGEgbm90ZSAod3JpdHRlbiBpbiBHbWFpbCwgc2F5KSBnb2VzIHRocm",
"91Z2ggdGhlCi8vIHNhbWUgcmVhZGVyLCBzbyBpdHMgYm9sZCwgbGlzdHMgYW5kIGxpbmtzIGNvbWUgYWNyb3NzIHdoZXJlIHRoZXkgZml0Ci8vIHRoZSBtb2RlbCBhbmQgZXZlcnl0aGluZyBlbHNlIGlzIHJlZHVjZWQgdG8gdGV4dC4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IFRZUEVTID0gbmV3IFNldChbJ3AnLCAnaDEnLCAnaDInLCAnaDMnLCAndWwnLCAnb2wnLCAnY2hlY2snXSk7CiAgY29uc3QgTElTVFMgPSBuZXcgU2V0KFsndWwnLCAnb2wnLCAnY2hlY2snXSk7CiAgY29uc3QgTUFYX0xFVkVMID0gMzsKICBjb25zdCBCT1ggPSAn4piQJzsgICAgIC8vIOKYkAogIGNvbnN0IFRJQ0tFRCA9ICfimJEnOyAgLy8g4piRCiAgY29uc3QgQlVMTEVUID",
"0gJ-KAoic7ICAvLyDigKIKCiAgLy8g4pSA4pSAIFRoZSBtb2RlbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYmxvY2sodHlwZSA9ICdwJywgcnVucyA9IFtdLCB7IGxldmVsID0gMCwgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgcmV0dXJuIHsgdHlwZSwgbGV2ZWw6IExJU1RTLmhhcyh0eXBlKSA_IGxldmVsIDogMCwgY2hlY2tlZDogdHlwZSA9PT0gJ2NoZWNrJyA_ICEhY2hlY2tlZCA6IGZhbHNlLCBydW5zIH07CiAgfQoKICBmdW5jdGlvbiBlbXB0eURvYygpIHsKICAgIHJldHVybiBbYmxvY2soJ3AnKV07CiAgfQoKICBjb25zdCBzYW1lTWFya3MgPSAoYSwgYikgPT4gISFhLmIgPT09ICEhYi5iICYmICEhYS5pID09PSAhIWIuaSAmJiAhIWEucyA9PT0gISFiLnMgJiYgKGEuaHJlZiB8fCAnJykgPT09IChiLmhyZWYgfHwgJycpOwoKICBmdW5jdGlvbiBjbGVhblJ1bihyKSB7CiAgICBjb25zdCBvdXQgPSB7IHRleHQ6IFN0cmluZyhyLnRleHQgfHwgJycpIH07CiAgICBpZiAoci5iKSBvdXQuYiA9IHRydWU7CiAgICBpZiAoci5pKSBvdXQuaSA9IHRydWU7CiAgICBpZiAoci5zKSBvdXQucyA9IHRydWU7CiAgICBjb25zdCBocmVmID",
"0gci5ocmVmID8gc2FmZUhyZWYoci5ocmVmKSA6ICcnOwogICAgaWYgKGhyZWYpIG91dC5ocmVmID0gaHJlZjsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBEcm9wcyBlbXB0eSBydW5zIGFuZCBqb2lucyBuZWlnaGJvdXJzIHRoYXQgbG9vayB0aGUgc2FtZSwgc28gdHdvCiAgLy8gZG9jdW1lbnRzIHRoYXQgcmVhZCBhbGlrZSBjb21wYXJlIGFsaWtlLgogIGZ1bmN0aW9uIG5vcm1hbGlzZVJ1bnMocnVucykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGNvbnN0IHIgb2YgcnVucyB8fCBbXSkgewogICAgICBpZiAoIXIgfHwgIXIudGV4dCkgY29udGludWU7CiAgICAgIGNvbnN0IGxhc3QgPSBvdXRbb3V0Lmxlbmd0aCAtIDFdOwogICAgICBpZiAobGFzdCAmJiBzYW1lTWFya3MobGFzdCwgcikpIGxhc3QudGV4dCArPSByLnRleHQ7CiAgICAgIGVsc2Ugb3V0LnB1c2goY2xlYW5SdW4ocikpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIFVua25vd24gdHlwZXMgYmVjb21lIHBhcmFncmFwaHM7IGEgbGlzdCBpdGVtIG1heSBzaXQgYXQgbW9zdCBvbmUgbGV2ZWwKICAvLyBkZWVwZXIgdGhhbiB0aGUgbGlzdCBpdGVtIGJlZm9yZSBpdCwgd2hpY2ggaXMgd2hhdCBrZWVwcyB0aGUgSFRNTCBhCiAgLy8gcHJvcGVybHkgbmVzdGVkIGxpc3QgYW5kIHRoZSBlZGl0b3IncyBpbmRlbnRzIG1lYW5pbmdmdWwuCiAgZnVuY3Rpb24gbm9ybWFsaXNlRG9jKGRvYykgewogICAgY29uc3Qgb3V0ID0gW107CiAgIC",
"BsZXQgcHJldkxldmVsID0gLTE7CiAgICBmb3IgKGNvbnN0IGIgb2YgQXJyYXkuaXNBcnJheShkb2MpID8gZG9jIDogW10pIHsKICAgICAgaWYgKCFiIHx8IHR5cGVvZiBiICE9PSAnb2JqZWN0JykgY29udGludWU7CiAgICAgIGNvbnN0IHR5cGUgPSBUWVBFUy5oYXMoYi50eXBlKSA_IGIudHlwZSA6ICdwJzsKICAgICAgbGV0IGxldmVsID0gMDsKICAgICAgaWYgKExJU1RTLmhhcyh0eXBlKSkgewogICAgICAgIGxldmVsID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oTUFYX0xFVkVMLCBOdW1iZXIoYi5sZXZlbCkgfHwgMCwgcHJldkxldmVsICsgMSkpOwogICAgICAgIHByZXZMZXZlbCA9IGxldmVsOwogICAgICB9IGVsc2UgewogICAgICAgIHByZXZMZXZlbCA9IC0xOwogICAgICB9CiAgICAgIG91dC5wdXNoKGJsb2NrKHR5cGUsIG5vcm1hbGlzZVJ1bnMoYi5ydW5zKSwgeyBsZXZlbCwgY2hlY2tlZDogYi5jaGVja2VkIH0pKTsKICAgIH0KICAgIHJldHVybiBvdXQubGVuZ3RoID8gb3V0IDogZW1wdHlEb2MoKTsKICB9CgogIGNvbnN0IGJsb2NrVGV4dCA9IGIgPT4gYi5ydW5zLm1hcChyID0-IHIudGV4dCkuam9pbignJyk7CgogIGZ1bmN0aW9uIGRvY1RleHQoZG9jKSB7CiAgICByZXR1cm4gZG9jLm1hcChibG9ja1RleHQpLmpvaW4oJ1xuJyk7CiAgfQoKICBmdW5jdGlvbiBpc0VtcHR5KGRvYykgewogICAgcmV0dXJuIGRvYy5ldmVyeShiID0-ICFibG9ja1RleHQoYikudHJpbSgpKTsKICB9CgogIC8vIOKUgOKUgCBMaW",
"5rcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gV2ViIGFuZCBtYWlsIGxpbmtzIG9ubHkuICJleGFtcGxlLmNvbS94IiBnZXRzIGh0dHBzOi8vIGluIGZyb250LCBhCiAgLy8gYmFyZSBhZGRyZXNzIGdldHMgbWFpbHRvOiwgYW5kIGFueXRoaW5nIGVsc2UgLSBqYXZhc2NyaXB0OiwgZGF0YTosCiAgLy8gZmlsZTogLSBpcyBub3QgYSBsaW5rIGF0IGFsbC4KICBmdW5jdGlvbiBzYWZlSHJlZih1cmwpIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodXJsIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXMgfHwgL1tcczw-Il0vLnRlc3QocykpIHJldHVybiAnJzsKICAgIGlmICgvXm1haWx0bzovaS50ZXN0KHMpKSByZXR1cm4gL15tYWlsdG86W15AXHNdK0BbXkBcc10rJC9pLnRlc3QocykgPyBzIDogJyc7CiAgICBpZiAoL15bXlxzQC86XStAW15cc0AvOl0rXC5bXlxzQC86XSskLy50ZXN0KHMpKSByZXR1cm4gYG1haWx0bzoke3N9YDsKICAgIGxldCBjYW5kaWRhdGUgPSBzOwogICAgaWYgKCEvXlthLXpdW2EtejAtOSsuLV0qOi9pLnRlc3QocykpIHsKICAgICAgaWYgKCEvXltcdy1dKyhcLltcdy1dKykrKDpcZCspPyhbLz8jXXwkKS8udGVzdC",
"hzKSkgcmV0dXJuICcnOwogICAgICBjYW5kaWRhdGUgPSBgaHR0cHM6Ly8ke3N9YDsKICAgIH0KICAgIHRyeSB7CiAgICAgIGNvbnN0IHUgPSBuZXcgVVJMKGNhbmRpZGF0ZSk7CiAgICAgIHJldHVybiB1LnByb3RvY29sID09PSAnaHR0cDonIHx8IHUucHJvdG9jb2wgPT09ICdodHRwczonID8gdS5ocmVmIDogJyc7CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuICcnOwogICAgfQogIH0KCiAgLy8g4pSA4pSAIEhUTUwgb3V0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBlc2NIdG1sID0gcyA9PiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpLnJlcGxhY2UoLyIvZywgJyZxdW90OycpOwoKICAvLyBTcGFjZXMgSFRNTCB3b3VsZCBjb2xsYXBzZSAtIGRvdWJsZWQsIGF0IGVpdGhlciBlbmQgb2YgYSBibG9jaywgb3IKICAvLyBtZWV0aW5nIGFjcm9zcyBhIHRhZyAtIGFyZSB3cml0dGVuIGFzICZuYnNwOyBzbyB0aGV5IGNvbWUgYmFjayBhcwogIC8vIHR5cGVkLgogIGZ1bmN0aW9uIHJ1bnNIdG1sKHJ1bnMpIHsKICAgIGxldCBvdXQgPSAnJzsKICAgIGxldC",
"BwcmV2U3BhY2UgPSBmYWxzZTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcnVucy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IGhyZWYgPSBydW5zW2ldLmhyZWYgfHwgJyc7CiAgICAgIGxldCBqID0gaTsKICAgICAgbGV0IGlubmVyID0gJyc7CiAgICAgIHdoaWxlIChqIDwgcnVucy5sZW5ndGggJiYgKHJ1bnNbal0uaHJlZiB8fCAnJykgPT09IGhyZWYpIHsKICAgICAgICBjb25zdCByYXcgPSBydW5zW2pdLnRleHQ7CiAgICAgICAgbGV0IHQgPSBlc2NIdG1sKHJhdykucmVwbGFjZSgvIHsyfS9nLCAnICZuYnNwOycpOwogICAgICAgIGlmIChwcmV2U3BhY2UgJiYgdFswXSA9PT0gJyAnKSB0ID0gYCZuYnNwOyR7dC5zbGljZSgxKX1gOwogICAgICAgIHByZXZTcGFjZSA9IC8gJC8udGVzdChyYXcpOwogICAgICAgIGlmIChydW5zW2pdLnMpIHQgPSBgPHM-JHt0fTwvcz5gOwogICAgICAgIGlmIChydW5zW2pdLmkpIHQgPSBgPGk-JHt0fTwvaT5gOwogICAgICAgIGlmIChydW5zW2pdLmIpIHQgPSBgPGI-JHt0fTwvYj5gOwogICAgICAgIGlubmVyICs9IHQ7CiAgICAgICAgaisrOwogICAgICB9CiAgICAgIG91dCArPSBocmVmID8gYDxhIGhyZWY9IiR7ZXNjSHRtbChocmVmKX0iPiR7aW5uZXJ9PC9hPmAgOiBpbm5lcjsKICAgICAgaSA9IGo7CiAgICB9CiAgICAvLyBFZGdlIHNwYWNlcyBvZiB0aGUgd2hvbGUgYmxvY2ssIGFmdGVyIHRoZSB0YWdzIGFyZSBpbiBwbGFjZS4KICAgIHJldHVybiBvdXQucmVwbGFjZSgvXigoPz",
"o8W14-XSs-KSopIC8sICckMSZuYnNwOycpLnJlcGxhY2UoLyAoKD86PFwvW14-XSs-KSopJC8sICcmbmJzcDskMScpOwogIH0KCiAgY29uc3QgU1RZTEUgPSB7CiAgICBkb2M6ICdmb250LWZhbWlseTpBcmlhbCxIZWx2ZXRpY2Esc2Fucy1zZXJpZjtmb250LXNpemU6MTRweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOiMxZjFmMWYnLAogICAgcDogJ21hcmdpbjowJywKICAgIGgxOiAnbWFyZ2luOjE0cHggMCA0cHg7Zm9udC1zaXplOjIycHg7bGluZS1oZWlnaHQ6MS4zO2ZvbnQtd2VpZ2h0OmJvbGQnLAogICAgaDI6ICdtYXJnaW46MTJweCAwIDJweDtmb250LXNpemU6MThweDtsaW5lLWhlaWdodDoxLjM7Zm9udC13ZWlnaHQ6Ym9sZCcsCiAgICBoMzogJ21hcmdpbjoxMHB4IDAgMnB4O2ZvbnQtc2l6ZToxNXB4O2xpbmUtaGVpZ2h0OjEuMztmb250LXdlaWdodDpib2xkJywKICAgIGxpc3Q6ICdtYXJnaW46MDtwYWRkaW5nLWxlZnQ6MjZweCcsCiAgICBjaGVjazogJ21hcmdpbjowO3BhZGRpbmctbGVmdDo0cHg7bGlzdC1zdHlsZTpub25lJywKICAgIGxpOiAnbWFyZ2luOjFweCAwJywKICB9OwoKICBmdW5jdGlvbiB0b0h0bWwoZG9jSW4pIHsKICAgIGNvbnN0IGRvYyA9IG5vcm1hbGlzZURvYyhkb2NJbik7CiAgICBjb25zdCBzdGFjayA9IFtdOyAvLyBvcGVuIGxpc3RzLCBvbmUgcGVyIGxldmVsOiB7IHRhZywgY2hlY2sgfQogICAgbGV0IG91dCA9IGA8ZGl2IGRhdGEtZ2tiLW5vdGU9IjEiIHN0eWxlPSIke1NUWUxFLm",
"RvY30iPmA7CiAgICBjb25zdCBjbG9zZSA9ICgpID0-IHsgb3V0ICs9IGA8L2xpPjwvJHtzdGFjay5wb3AoKS50YWd9PmA7IH07CgogICAgZm9yIChjb25zdCBiIG9mIGRvYykgewogICAgICBjb25zdCBpbm5lciA9IHJ1bnNIdG1sKGIucnVucyk7CiAgICAgIGlmICghTElTVFMuaGFzKGIudHlwZSkpIHsKICAgICAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSBjbG9zZSgpOwogICAgICAgIG91dCArPSBgPCR7Yi50eXBlfSBzdHlsZT0iJHtTVFlMRVtiLnR5cGVdfSI-JHtpbm5lciB8fCAnPGJyPid9PC8ke2IudHlwZX0-XG5gOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IHRhZyA9IGIudHlwZSA9PT0gJ29sJyA_ICdvbCcgOiAndWwnOwogICAgICBjb25zdCBjaGVjayA9IGIudHlwZSA9PT0gJ2NoZWNrJzsKICAgICAgd2hpbGUgKHN0YWNrLmxlbmd0aCA-IGIubGV2ZWwgKyAxKSBjbG9zZSgpOwogICAgICBpZiAoc3RhY2subGVuZ3RoID09PSBiLmxldmVsICsgMSkgewogICAgICAgIGNvbnN0IHRvcCA9IHN0YWNrW3N0YWNrLmxlbmd0aCAtIDFdOwogICAgICAgIGlmICh0b3AudGFnICE9PSB0YWcgfHwgdG9wLmNoZWNrICE9PSBjaGVjaykgY2xvc2UoKTsKICAgICAgICBlbHNlIG91dCArPSAnPC9saT4nOwogICAgICB9CiAgICAgIGlmIChzdGFjay5sZW5ndGggPT09IGIubGV2ZWwpIHsKICAgICAgICBvdXQgKz0gY2hlY2sgPyBgPHVsIGRhdGEtY2hlY2s9IjEiIHN0eWxlPSIke1NUWUxFLmNoZWNrfS",
"I-YCA6IGA8JHt0YWd9IHN0eWxlPSIke1NUWUxFLmxpc3R9Ij5gOwogICAgICAgIHN0YWNrLnB1c2goeyB0YWcsIGNoZWNrIH0pOwogICAgICB9CiAgICAgIGNvbnN0IGdseXBoID0gY2hlY2sgPyBgPHNwYW4gZGF0YS1nbHlwaD0iMSI-JHtiLmNoZWNrZWQgPyBUSUNLRUQgOiBCT1h9Jm5ic3A7PC9zcGFuPmAgOiAnJzsKICAgICAgb3V0ICs9IGA8bGkgc3R5bGU9IiR7U1RZTEUubGl9IiR7Y2hlY2sgPyBgIGRhdGEtY2hlY2tlZD0iJHtiLmNoZWNrZWQgPyAxIDogMH0iYCA6ICcnfT4ke2dseXBofSR7aW5uZXIgfHwgKGNoZWNrID8gJycgOiAnPGJyPicpfWA7CiAgICB9CiAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSBjbG9zZSgpOwogICAgcmV0dXJuIGAke291dH08L2Rpdj5gOwogIH0KCiAgLy8g4pSA4pSAIFBsYWluIHRleHQgb3V0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBydW5zUGxhaW4ocnVucykgewogICAgbGV0IG91dCA9ICcnOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBydW5zLmxlbmd0aDspIHsKICAgICAgY29uc3QgaHJlZiA9IHJ1bnNbaV0uaHJlZiB8fCAnJzsKICAgICAgbGV0IGogPSBpOwogICAgICBsZXQgdGV4dCA9ICcnOwogICAgICB3aGlsZSAoai",
"A8IHJ1bnMubGVuZ3RoICYmIChydW5zW2pdLmhyZWYgfHwgJycpID09PSBocmVmKSB0ZXh0ICs9IHJ1bnNbaisrXS50ZXh0OwogICAgICBjb25zdCBiYXJlID0gaHJlZi5yZXBsYWNlKC9ebWFpbHRvOi8sICcnKTsKICAgICAgY29uc3Qgc2FtZSA9IHMgPT4gcy50cmltKCkucmVwbGFjZSgvXihodHRwcz86XC9cL3xtYWlsdG86KS8sICcnKS5yZXBsYWNlKC9cLyQvLCAnJyk7CiAgICAgIG91dCArPSBocmVmICYmIHNhbWUodGV4dCkgIT09IHNhbWUoaHJlZikgPyBgJHt0ZXh0fSAoJHtiYXJlfSlgIDogdGV4dDsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gdG9QbGFpbihkb2NJbikgewogICAgY29uc3QgZG9jID0gbm9ybWFsaXNlRG9jKGRvY0luKTsKICAgIGNvbnN0IGNvdW50ZXJzID0gWzAsIDAsIDAsIDBdOwogICAgcmV0dXJuIGRvYy5tYXAoYiA9PiB7CiAgICAgIGNvbnN0IHRleHQgPSBydW5zUGxhaW4oYi5ydW5zKTsKICAgICAgaWYgKCFMSVNUUy5oYXMoYi50eXBlKSkgewogICAgICAgIGNvdW50ZXJzLmZpbGwoMCk7CiAgICAgICAgcmV0dXJuIHRleHQ7CiAgICAgIH0KICAgICAgY29uc3QgcGFkID0gJyAgJy5yZXBlYXQoYi5sZXZlbCk7CiAgICAgIGZvciAobGV0IGwgPSBiLmxldmVsICsgMTsgbCA8IGNvdW50ZXJzLmxlbmd0aDsgbCsrKSBjb3VudGVyc1tsXSA9IDA7CiAgICAgIGlmIChiLnR5cGUgPT09ICdvbCcpIHJldHVybiBgJHtwYWR9JHsrK2NvdW50ZXJzW2",
"IubGV2ZWxdfS4gJHt0ZXh0fWA7CiAgICAgIGNvdW50ZXJzW2IubGV2ZWxdID0gMDsKICAgICAgaWYgKGIudHlwZSA9PT0gJ2NoZWNrJykgcmV0dXJuIGAke3BhZH0ke2IuY2hlY2tlZCA_IFRJQ0tFRCA6IEJPWH0gJHt0ZXh0fWA7CiAgICAgIHJldHVybiBgJHtwYWR9JHtCVUxMRVR9ICR7dGV4dH1gOwogICAgfSkuam9pbignXG4nKTsKICB9CgogIC8vIOKUgOKUgCBQbGFpbiB0ZXh0IGluIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBBIHBsYWluIG5vdGUgKGZyb20gYmVmb3JlIGZvcm1hdHRpbmcgZXhpc3RlZCwgb3IgcGxhaW4gbWFpbCkgYmVjb21lcwogIC8vIG9uZSBibG9jayBwZXIgbGluZS4gTGluZXMgdGhhdCBhbHJlYWR5IGxvb2sgbGlrZSBsaXN0cyAtICItICIsICLigKIgIiwKICAvLyAiMS4gIiwgIuKYkCAiIC0gYmVjb21lIGxpc3RzLCBpbmRlbnRlZCB0d28gc3BhY2VzIGEgbGV2ZWwuCiAgZnVuY3Rpb24gZnJvbVBsYWluKHRleHQpIHsKICAgIGNvbnN0IGxpbmVzID0gU3RyaW5nKHRleHQgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNwbGl0KCdcbicpOwogICAgcmV0dXJuIG5vcm1hbGlzZURvYyhsaW5lcy5tYXAobGluZSA9PiB7CiAgICAgIGNvbn",
"N0IG0gPSAvXiggKikoPzooWy0q4oCiXSl8KFxkezEsM30pWy4pXXwoW-KYkOKYkV0pKSAoLiopJC8uZXhlYyhsaW5lKTsKICAgICAgaWYgKCFtKSByZXR1cm4gYmxvY2soJ3AnLCBbeyB0ZXh0OiBsaW5lIH1dKTsKICAgICAgY29uc3QgbGV2ZWwgPSBNYXRoLmZsb29yKG1bMV0ubGVuZ3RoIC8gMik7CiAgICAgIGlmIChtWzRdKSByZXR1cm4gYmxvY2soJ2NoZWNrJywgW3sgdGV4dDogbVs1XSB9XSwgeyBsZXZlbCwgY2hlY2tlZDogbVs0XSA9PT0gVElDS0VEIH0pOwogICAgICByZXR1cm4gYmxvY2sobVszXSA_ICdvbCcgOiAndWwnLCBbeyB0ZXh0OiBtWzVdIH1dLCB7IGxldmVsIH0pOwogICAgfSkpOwogIH0KCiAgLy8g4pSA4pSAIEhUTUwgaW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IFRPS0VOX1JFID0gLzwhLS1bXHNcU10qPy0tPnw8IVxbQ0RBVEFcW1tcc1xTXSo_XF1cXT58PCFbXj5dKj58PFw_W14-XSo-fDwoXC8_KShbYS16QS1aXVthLXpBLVowLTk6LV0qKSgoPzpccytbXlxzIic-Lz1dKyg_OlxzKj1ccyooPzoiW14iXSoifCdbXiddKid8W15ccyInPTw-YF0rKSk_KSopXHMqKFwvPyk-fFtePF0rfDwvZzsKICBjb25zdCBBVF",
"RSX1JFID0gLyhbXlxzIic-Lz1dKykoPzpccyo9XHMqKD86IihbXiJdKikifCcoW14nXSopJ3woW15ccyInPTw-YF0rKSkpPy9nOwogIGNvbnN0IFNLSVAgPSBuZXcgU2V0KFsnc2NyaXB0JywgJ3N0eWxlJywgJ2hlYWQnLCAndGl0bGUnLCAndGVtcGxhdGUnLCAnc3ZnJywgJ21hdGgnLCAnbm9zY3JpcHQnLCAnaWZyYW1lJywgJ29iamVjdCcsICd4bWwnXSk7CiAgY29uc3QgUEFSQSA9IG5ldyBTZXQoWydwJywgJ2RpdicsICdibG9ja3F1b3RlJywgJ3ByZScsICdzZWN0aW9uJywgJ2FydGljbGUnLCAnaGVhZGVyJywgJ2Zvb3RlcicsICdtYWluJywgJ2FzaWRlJywKICAgICduYXYnLCAndGFibGUnLCAndGJvZHknLCAndGhlYWQnLCAndGZvb3QnLCAnY2VudGVyJywgJ2RsJywgJ2R0JywgJ2RkJywgJ2ZpZ3VyZScsICdmaWdjYXB0aW9uJywKICAgICdmb3JtJywgJ2ZpZWxkc2V0JywgJ2FkZHJlc3MnLCAnaHInLCAnYm9keScsICdodG1sJywgJ2NhcHRpb24nXSk7CiAgLy8gVGFncyB0aGF0IG1hcmsgdGV4dCwgYW5kIHRoZSBtYXJrcyB0aGV5IHN0YW5kIGZvci4gc3BhbiBhbmQgZm9udAogIC8vIGNhcnJ5IHRoZWlycyBpbiBhIHN0eWxlIGF0dHJpYnV0ZSwgaWYgYXQgYWxsLgogIGNvbnN0IElOTElORSA9IHsKICAgIGI6IFsnYiddLCBzdHJvbmc6IFsnYiddLCBpOiBbJ2knXSwgZW06IFsnaSddLCBjaXRlOiBbJ2knXSwgczogWydzJ10sIHN0cmlrZTogWydzJ10sIGRlbDogWydzJ10sIHNwYW46IFtdLCBmb250OiBbXSwKIC",
"B9OwogIGNvbnN0IEhFQURJTkdTID0geyBoMTogJ2gxJywgaDI6ICdoMicsIGgzOiAnaDMnLCBoNDogJ2gzJywgaDU6ICdoMycsIGg2OiAnaDMnIH07CgogIGZ1bmN0aW9uIGF0dHJzT2YocykgewogICAgY29uc3Qgb3V0ID0ge307CiAgICBsZXQgbTsKICAgIEFUVFJfUkUubGFzdEluZGV4ID0gMDsKICAgIHdoaWxlICgobSA9IEFUVFJfUkUuZXhlYyhzIHx8ICcnKSkpIHsKICAgICAgb3V0W21bMV0udG9Mb3dlckNhc2UoKV0gPSB1dGlsLmRlY29kZUVudGl0aWVzKG1bMl0gIT09IHVuZGVmaW5lZCA_IG1bMl0gOiBtWzNdICE9PSB1bmRlZmluZWQgPyBtWzNdIDogbVs0XSB8fCAnJyk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gQm9sZCwgaXRhbGljIGFuZCBzdHJpa2UtdGhyb3VnaCB3cml0dGVuIGFzIGlubGluZSBzdHlsZXMsIGFzIE91dGxvb2sKICAvLyBhbmQgcGFzdGVkIHdlYiB0ZXh0IG9mdGVuIGRvLCBjb3VudCB0aGUgc2FtZSBhcyB0aGUgdGFncy4KICBmdW5jdGlvbiBzdHlsZU1hcmtzKHN0eWxlKSB7CiAgICBjb25zdCBzID0gU3RyaW5nKHN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgbWFya3MgPSBbXTsKICAgIGlmICgvZm9udC13ZWlnaHRccyo6XHMqKGJvbGR8Ym9sZGVyfFs2LTldMDApLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdiJyk7CiAgICBpZiAoL2ZvbnQtc3R5bGVccyo6XHMqaXRhbGljLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdpJyk7CiAgICBpZiAoL3RleHQtZG",
"Vjb3JhdGlvbigtbGluZSk_XHMqOlteO10qbGluZS10aHJvdWdoLy50ZXN0KHMpKSBtYXJrcy5wdXNoKCdzJyk7CiAgICByZXR1cm4gbWFya3M7CiAgfQoKICAvLyBXaGV0aGVyIGEgYnJvd3NlciB3b3VsZCBzaG93IHNwYWNlIGJlbG93IGEgPHA-OiBpdCBkb2VzIHVubGVzcyBpdHMKICAvLyBzdHlsZSBzYXlzIG90aGVyd2lzZS4gV29yZCBhbmQgT3V0bG9vayBwYXJhZ3JhcGhzIChNc29Ob3JtYWwpIGFyZQogIC8vIGxpbmVzLCBhbmQgc28gYXJlIHRoZSBlZGl0b3IncyBvd24gYW5kIEdvb2dsZSBEb2NzJy4KICBmdW5jdGlvbiBwYXJhR2FwKGEpIHsKICAgIGlmICgvXGJNc28vLnRlc3QoYS5jbGFzcyB8fCAnJykpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IHN0eWxlID0gU3RyaW5nKGEuc3R5bGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCB6ZXJvID0gdiA9PiAvXi0_MChcLjArKT8oW2Etel0rfCUpPyQvLnRlc3QodiB8fCAnJyk7CiAgICBjb25zdCBib3R0b20gPSAvKD86Xnw7KVxzKm1hcmdpbi1ib3R0b21ccyo6XHMqKFteOyFdKykvLmV4ZWMoc3R5bGUpOwogICAgaWYgKGJvdHRvbSkgcmV0dXJuICF6ZXJvKGJvdHRvbVsxXS50cmltKCkpOwogICAgY29uc3QgYWxsID0gLyg_Ol58OylccyptYXJnaW5ccyo6XHMqKFteOyFdKykvLmV4ZWMoc3R5bGUpOwogICAgaWYgKGFsbCkgewogICAgICBjb25zdCB2ID0gYWxsWzFdLnRyaW0oKS5zcGxpdCgvXHMrLyk7CiAgICAgIHJldHVybiAhemVybyh2Lmxlbm",
"d0aCA-PSAzID8gdlsyXSA6IHZbMF0pOwogICAgfQogICAgcmV0dXJuIHRydWU7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUh0bWwoaHRtbCkgewogICAgY29uc3QgYmxvY2tzID0gW107CiAgICBjb25zdCBsaXN0cyA9IFtdOyAgICAgICAgIC8vIG9wZW4gbGlzdHM6IHsgdHlwZSwgbGlPcGVuIH0KICAgIGNvbnN0IG1hcmtzID0geyBiOiAwLCBpOiAwLCBzOiAwIH07CiAgICBjb25zdCBocmVmcyA9IFtdOwogICAgY29uc3QgaW5saW5lID0gW107ICAgICAgICAvLyBvcGVuIGlubGluZSB0YWdzOiB7IG5hbWUsIG1hcmtzIH0gb3IgeyBuYW1lLCBnbHlwaDogdHJ1ZSB9CiAgICBsZXQgc2tpcCA9IDA7CiAgICBsZXQgZ2x5cGggPSAwOwogICAgbGV0IGN1ciA9IG51bGw7CiAgICBsZXQgcm93ID0gbnVsbDsgICAgICAgICAgIC8vIGFuIG9wZW4gdGFibGUgcm93OiB7IGNlbGxzLCB0aCB9CiAgICBsZXQgcHJlID0gMDsgICAgICAgICAgICAgIC8vIGluc2lkZSA8cHJlPjogbGluZSBicmVha3MgYW5kIHNwYWNlcyBhcmUgdGV4dAogICAgbGV0IHBhcmEgPSBudWxsOyAgICAgICAgICAvLyB0aGUgb3BlbiA8cD46IHsgZ2FwIH0KICAgIGxldCBnYXAgPSBmYWxzZTsgICAgICAgICAgLy8gYSA8cD4ganVzdCBjbG9zZWQgd2l0aCBzcGFjZSBiZWxvdyBpdAogICAgbGV0IG91cnMgPSBmYWxzZTsgICAgICAgICAvLyBpbnNpZGUgYSBub3RlJ3Mgb3duIEhUTUwsIHdoZXJlIHBhcmFncmFwaHMgYXJlIGxpbmVzCgogICAgY29uc3QgbGV2ZW",
"wgPSAoKSA9PiBNYXRoLm1heCgwLCBsaXN0cy5sZW5ndGggLSAxKTsKICAgIGNvbnN0IG9wZW4gPSAodHlwZSwgZXh0cmEpID0-IHsKICAgICAgLy8gVGhlIHNwYWNlIGEgYnJvd3NlciBzaG93cyBhZnRlciBhIHBhcmFncmFwaCBpcyBhbiBlbXB0eSBsaW5lIGluIGEKICAgICAgLy8gbm90ZSAtIHdoaWNoIGhhcyBubyBzcGFjZSBiZXR3ZWVuIHBhcmFncmFwaHMgLSBleGNlcHQgYmVmb3JlIGEKICAgICAgLy8gaGVhZGluZywgd2hpY2ggaGFzIGl0cyBvd24uCiAgICAgIGlmIChnYXApIHsKICAgICAgICBnYXAgPSBmYWxzZTsKICAgICAgICBjb25zdCBsYXN0ID0gYmxvY2tzW2Jsb2Nrcy5sZW5ndGggLSAxXTsKICAgICAgICBpZiAobGFzdCAmJiAhSEVBRElOR1NbdHlwZV0gJiYgbGFzdC5ydW5zLnNvbWUociA9PiAvXFMvLnRlc3Qoci50ZXh0KSkpIGJsb2Nrcy5wdXNoKGJsb2NrKCdwJykpOwogICAgICB9CiAgICAgIGN1ciA9IGJsb2NrKHR5cGUsIFtdLCBleHRyYSk7CiAgICAgIGJsb2Nrcy5wdXNoKGN1cik7CiAgICAgIHJldHVybiBjdXI7CiAgICB9OwogICAgY29uc3QgZW5kID0gKCkgPT4geyBjdXIgPSBudWxsOyB9OwogICAgLy8gV2hlcmUgdGV4dCBsYW5kcyB3aGVuIG5vIGJsb2NrIGlzIG9wZW46IGluc2lkZSBhIGxpc3QgaXRlbSwgYQogICAgLy8gY29udGludWF0aW9uIG9mIHRoYXQgaXRlbTsgb3RoZXJ3aXNlIGEgbmV3IHBhcmFncmFwaC4KICAgIGNvbnN0IGNvbnRleHQgPSAoKSA9PiB7CiAgICAgIGNvbn",
"N0IHRvcCA9IGxpc3RzW2xpc3RzLmxlbmd0aCAtIDFdOwogICAgICBpZiAodG9wICYmIHRvcC5saU9wZW4pIHJldHVybiBvcGVuKHRvcC50eXBlLCB7IGxldmVsOiBsZXZlbCgpLCBjaGVja2VkOiBmYWxzZSB9KTsKICAgICAgcmV0dXJuIG9wZW4oJ3AnKTsKICAgIH07CiAgICBjb25zdCBhcHBseSA9IChsaXN0LCBkZWx0YSkgPT4gbGlzdC5mb3JFYWNoKG0gPT4geyBtYXJrc1ttXSArPSBkZWx0YTsgfSk7CgogICAgbGV0IG07CiAgICBUT0tFTl9SRS5sYXN0SW5kZXggPSAwOwogICAgd2hpbGUgKChtID0gVE9LRU5fUkUuZXhlYyhTdHJpbmcoaHRtbCB8fCAnJykpKSkgewogICAgICBjb25zdCBbd2hvbGUsIGNsb3NpbmcsIHJhd05hbWUsIHJhd0F0dHJzLCBzZWxmQ2xvc2luZ10gPSBtOwogICAgICBpZiAocmF3TmFtZSA9PT0gdW5kZWZpbmVkKSB7CiAgICAgICAgaWYgKHdob2xlWzBdID09PSAnPCcgJiYgd2hvbGUubGVuZ3RoID4gMSkgY29udGludWU7IC8vIGNvbW1lbnQsIGRvY3R5cGUsIENEQVRBCiAgICAgICAgaWYgKHNraXApIGNvbnRpbnVlOwogICAgICAgIGlmIChnbHlwaCkgewogICAgICAgICAgLy8gV29yZCdzIGxpc3QgbWFya2VyICgiwrciLCAiMS4iLCAiYSkiKTogbm90IHRleHQsIGJ1dCBpdCBzYXlzCiAgICAgICAgICAvLyB3aGV0aGVyIHRoZSBsaXN0IGlzIGJ1bGxldGVkIG9yIG51bWJlcmVkLgogICAgICAgICAgaWYgKGN1ciAmJiBjdXIud29yZExpc3QpIGN1ci5tYXJrZXIgKz0gdXRpbC5kZWNvZG",
"VFbnRpdGllcyh3aG9sZSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKHByZSkgewogICAgICAgICAgLy8gRWFjaCBsaW5lIG9mIHByZWZvcm1hdHRlZCB0ZXh0IGlzIGEgbGluZSBvZiB0aGUgbm90ZSwgaXRzCiAgICAgICAgICAvLyBzcGFjZXMga2VwdCAoYXMgJm5ic3A7LCB3aGljaCB0aGUgdGlkeWluZyBiZWxvdyBsZWF2ZXMgYWxvbmUpLgogICAgICAgICAgbGV0IHJhdyA9IHV0aWwuZGVjb2RlRW50aXRpZXMod2hvbGUpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpOwogICAgICAgICAgaWYgKHByZS5mcmVzaCkgcmF3ID0gcmF3LnJlcGxhY2UoL15cbi8sICcnKTsKICAgICAgICAgIHByZS5mcmVzaCA9IGZhbHNlOwogICAgICAgICAgcmF3LnNwbGl0KCdcbicpLmZvckVhY2goKGxpbmUsIGspID0-IHsKICAgICAgICAgICAgaWYgKGspIHsKICAgICAgICAgICAgICBlbmQoKTsKICAgICAgICAgICAgICBvcGVuKCdwJykucHJlTGluZSA9IHRydWU7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgaWYgKCFsaW5lKSByZXR1cm47CiAgICAgICAgICAgIGlmICghY3VyKSBjb250ZXh0KCk7CiAgICAgICAgICAgIGN1ci5ydW5zLnB1c2goewogICAgICAgICAgICAgIHRleHQ6IGxpbmUucmVwbGFjZSgvXHQvZywgJyAgICAnKS5yZXBsYWNlKC8gL2csICdcdTAwYTAnKSwKICAgICAgICAgICAgICBiOiBtYXJrcy5iID4gMCwgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLAogICAgICAgIC",
"AgICAgIGhyZWY6IGhyZWZzLmxlbmd0aCA_IGhyZWZzW2hyZWZzLmxlbmd0aCAtIDFdIDogJycsCiAgICAgICAgICAgIH0pOwogICAgICAgICAgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3QgdGV4dCA9IHV0aWwuZGVjb2RlRW50aXRpZXMod2hvbGUgPT09ICc8JyA_ICc8JyA6IHdob2xlKS5yZXBsYWNlKC9bIFx0XHJcblxmXSsvZywgJyAnKTsKICAgICAgICBpZiAoIWN1cikgewogICAgICAgICAgLy8gT25seSBIVE1MJ3Mgb3duIHdoaXRlc3BhY2UgaXMgbm90aGluZzsgYW4gJm5ic3A7IGlzIGEgc3BhY2Ugc29tZW9uZSB0eXBlZC4KICAgICAgICAgIGlmICghL1teIFx0XHJcblxmXS8udGVzdCh0ZXh0KSkgY29udGludWU7CiAgICAgICAgICBjb250ZXh0KCk7CiAgICAgICAgfQogICAgICAgIGN1ci5ydW5zLnB1c2goewogICAgICAgICAgdGV4dCwKICAgICAgICAgIGI6IG1hcmtzLmIgPiAwLCBpOiBtYXJrcy5pID4gMCwgczogbWFya3MucyA-IDAsCiAgICAgICAgICBocmVmOiBocmVmcy5sZW5ndGggPyBocmVmc1tocmVmcy5sZW5ndGggLSAxXSA6ICcnLAogICAgICAgIH0pOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CgogICAgICBjb25zdCBuYW1lID0gcmF3TmFtZS50b0xvd2VyQ2FzZSgpOwogICAgICBjb25zdCBpc0Nsb3NlID0gY2xvc2luZyA9PT0gJy8nOwogICAgICBpZiAoU0tJUC5oYXMobmFtZSkpIHsKICAgICAgICBpZiAoIXNlbGZDbG9zaW5nKSBza2lwID0gTW",
"F0aC5tYXgoMCwgc2tpcCArIChpc0Nsb3NlID8gLTEgOiAxKSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKHNraXApIGNvbnRpbnVlOwogICAgICBjb25zdCBhID0gaXNDbG9zZSA_IHt9IDogYXR0cnNPZihyYXdBdHRycyk7CgogICAgICBpZiAobmFtZSA9PT0gJ2JyJykgewogICAgICAgIGlmIChjdXIpIGVuZCgpOwogICAgICAgIGVsc2UgeyBjb250ZXh0KCk7IGVuZCgpOyB9CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKEhFQURJTkdTW25hbWVdKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSBvcGVuKEhFQURJTkdTW25hbWVdKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3VsJyB8fCBuYW1lID09PSAnb2wnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UpIGxpc3RzLnBvcCgpOwogICAgICAgIGVsc2UgbGlzdHMucHVzaCh7IHR5cGU6IGFbJ2RhdGEtY2hlY2snXSA_ICdjaGVjaycgOiBuYW1lLCBsaU9wZW46IGZhbHNlIH0pOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnbGknKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFsaXN0cy5sZW5ndGgpIGxpc3RzLnB1c2goeyB0eXBlOiAndWwnLCBsaU9wZW46IGZhbHNlLCBpbXBsaWVkOiB0cnVlIH0pOwogICAgICAgIGNvbnN0IHRvcCA9IGxpc3RzW2xpc3RzLmxlbmd0aCAtIDFdOwogICAgICAgIH",
"RvcC5saU9wZW4gPSAhaXNDbG9zZTsKICAgICAgICBpZiAoIWlzQ2xvc2UpIHsKICAgICAgICAgIG9wZW4odG9wLnR5cGUsIHsgbGV2ZWw6IGxldmVsKCksIGNoZWNrZWQ6IGFbJ2RhdGEtY2hlY2tlZCddID09PSAnMScgfSk7CiAgICAgICAgICAvLyBPbmUgb2Ygb3VyczogaXRzIGJveCBpcyBpbiB0aGUgYXR0cmlidXRlLCBhbmQgYSDimJAgYXQgdGhlIHN0YXJ0CiAgICAgICAgICAvLyBvZiBpdHMgdGV4dCBpcyB0ZXh0LgogICAgICAgICAgaWYgKGFbJ2RhdGEtY2hlY2tlZCddICE9PSB1bmRlZmluZWQpIGN1ci5vdXJzID0gdHJ1ZTsKICAgICAgICAgIC8vIEEgY2hlY2tsaXN0IGl0ZW0gbWFya2VkIHVwIGZvciBzY3JlZW4gcmVhZGVycyAoR29vZ2xlIERvY3MpLgogICAgICAgICAgZWxzZSBpZiAoYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJyB8fCBhWydhcmlhLWNoZWNrZWQnXSA9PT0gJ2ZhbHNlJykgewogICAgICAgICAgICBjdXIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICAgIGN1ci5jaGVja2VkID0gYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJzsKICAgICAgICAgICAgY3VyLm91cnMgPSB0cnVlOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgICBlbHNlIGlmICh0b3AuaW1wbGllZCkgbGlzdHMucG9wKCk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQSB0YWJsZSByb3cgaXMgb25lIGxpbmUsIGl0cyBjZWxscyBzZXBhcmF0ZWQgYnkgIiB8ICI6IHRoZXJlIGFyZQogICAgIC",
"AvLyBubyB0YWJsZXMgaW4gYSBub3RlLCBhbmQgdGhpcyBrZWVwcyBhIHBhc3RlZCByb3cgcmVhZGFibGUuCiAgICAgIC8vIEEgaGVhZGluZyBjZWxsIGlzIGJvbGQsIGFzIGEgYnJvd3NlciBzaG93cyBpdC4KICAgICAgY29uc3QgaGVhZENlbGwgPSBvbiA9PiB7CiAgICAgICAgaWYgKCFyb3cgfHwgcm93LnRoID09PSBvbikgcmV0dXJuOwogICAgICAgIHJvdy50aCA9IG9uOwogICAgICAgIG1hcmtzLmIgKz0gb24gPyAxIDogLTE7CiAgICAgIH07CiAgICAgIGlmIChuYW1lID09PSAndHInKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaGVhZENlbGwoZmFsc2UpOwogICAgICAgIHJvdyA9IGlzQ2xvc2UgPyBudWxsIDogeyBjZWxsczogMCwgdGg6IGZhbHNlIH07CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKG5hbWUgPT09ICd0ZCcgfHwgbmFtZSA9PT0gJ3RoJykgewogICAgICAgIGlmICghcm93KSB7IGVuZCgpOyBjb250aW51ZTsgfQogICAgICAgIGhlYWRDZWxsKGZhbHNlKTsKICAgICAgICBpZiAoIWlzQ2xvc2UgJiYgIXNlbGZDbG9zaW5nKSB7CiAgICAgICAgICBpZiAocm93LmNlbGxzID4gMCkgewogICAgICAgICAgICBpZiAoIWN1cikgY29udGV4dCgpOwogICAgICAgICAgICBjdXIucnVucy5wdXNoKHsgdGV4dDogJyB8ICcsIGI6IGZhbHNlLCBpOiBmYWxzZSwgczogZmFsc2UsIGhyZWY6ICcnIH0pOwogICAgICAgICAgfQogICAgICAgICAgcm93LmNlbGxzKys7CiAgICAgICAgICBoZWFkQ2",
"VsbChuYW1lID09PSAndGgnKTsKICAgICAgICB9CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKG5hbWUgPT09ICdwcmUnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UpIHsKICAgICAgICAgIC8vIFRoZSBsaW5lIGJyZWFrIGJlZm9yZSA8L3ByZT4gZW5kcyB0aGUgbGFzdCBsaW5lOyBpdCBpcyBub3Qgb25lIG1vcmUuCiAgICAgICAgICBjb25zdCBsYXN0ID0gYmxvY2tzW2Jsb2Nrcy5sZW5ndGggLSAxXTsKICAgICAgICAgIGlmIChsYXN0ICYmIGxhc3QucHJlTGluZSAmJiAhbGFzdC5ydW5zLmxlbmd0aCkgYmxvY2tzLnBvcCgpOwogICAgICAgICAgcHJlID0gMDsKICAgICAgICB9IGVsc2UgaWYgKCFzZWxmQ2xvc2luZykgewogICAgICAgICAgcHJlID0geyBmcmVzaDogdHJ1ZSB9OwogICAgICAgIH0KICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICAvLyBBIHRpY2tlZCBvciBlbXB0eSBib3ggYXQgdGhlIHN0YXJ0IG9mIGEgbGluZSAtIGEgdGFzayBsaXN0IG9uIGEKICAgICAgLy8gd2ViIHBhZ2UgKEdpdEh1YikgLSBtYWtlcyBpdCBhIGNoZWNrbGlzdCBpdGVtLgogICAgICBpZiAobmFtZSA9PT0gJ2lucHV0JyAmJiBTdHJpbmcoYS50eXBlIHx8ICcnKS50b0xvd2VyQ2FzZSgpID09PSAnY2hlY2tib3gnKSB7CiAgICAgICAgaWYgKCFjdXIpIGNvbnRleHQoKTsKICAgICAgICBpZiAoIWN1ci5ydW5zLnNvbWUociA9PiAvXFMvLnRlc3Qoci50ZXh0KSkpIHsKICAgICAgIC",
"AgIGN1ci50eXBlID0gJ2NoZWNrJzsKICAgICAgICAgIGN1ci5jaGVja2VkID0gJ2NoZWNrZWQnIGluIGE7CiAgICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiBhWydkYXRhLWdrYi1ub3RlJ10gIT09IHVuZGVmaW5lZCkgb3VycyA9IHRydWU7CiAgICAgIC8vIEEgYmxvY2sgY29waWVkIG91dCBvZiBhIG5vdGUncyBlZGl0b3Iga2VlcHMgaXRzIGtpbmQuCiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiAhaXNDbG9zZSAmJiBUWVBFUy5oYXMoYVsnZGF0YS10eXBlJ10pKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgb3BlbihhWydkYXRhLXR5cGUnXSwgeyBsZXZlbDogTnVtYmVyKGFbJ2RhdGEtbGV2ZWwnXSkgfHwgMCwgY2hlY2tlZDogYVsnZGF0YS1jaGVja2VkJ10gPT09ICcxJyB9KTsKICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gV29yZCB3cml0ZXMgYSBsaXN0IGFzIHBhcmFncmFwaHMgc3R5bGVkICJtc28tbGlzdDogbDAgbGV2ZWwxIi4KICAgICAgaWYgKG5hbWUgPT09ICdwJyAmJiAhaXNDbG9zZSkgewogICAgICAgIGNvbnN0IHdsID0gL21zby1saXN0XHMqOlxzKmxcZCtccytsZXZlbChcZCkvaS5leGVjKGEuc3R5bGUgfHwgJycpOwogICAgICAgIGlmICh3bCkgewogICAgICAgICAgZW5kKCk7CiAgICAgICAgICBvcGVuKCd1bCcsIHsgbG",
"V2ZWw6IE51bWJlcih3bFsxXSkgLSAxIH0pOwogICAgICAgICAgY3VyLndvcmRMaXN0ID0gdHJ1ZTsKICAgICAgICAgIGN1ci5tYXJrZXIgPSAnJzsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3AnKSB7CiAgICAgICAgaWYgKHBhcmEgJiYgcGFyYS5nYXApIGdhcCA9IHRydWU7CiAgICAgICAgcGFyYSA9IG51bGw7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSB7CiAgICAgICAgICBjb25zdCB0b3AgPSBsaXN0c1tsaXN0cy5sZW5ndGggLSAxXTsKICAgICAgICAgIHBhcmEgPSB7IGdhcDogIW91cnMgJiYgIXJvdyAmJiAhKHRvcCAmJiB0b3AubGlPcGVuKSAmJiBwYXJhR2FwKGEpIH07CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChQQVJBLmhhcyhuYW1lKSkgewogICAgICAgIC8vIEluc2lkZSBhIHRhYmxlIGNlbGwsIG9yIHN0cmFpZ2h0IGluc2lkZSBhIGxpc3QgaXRlbSB0aGF0IGhhcyBubwogICAgICAgIC8vIHRleHQgeWV0IChHb29nbGUgRG9jcyB3cmFwcyBldmVyeSBpdGVtIGluIGEgPHA-KSwgdGhlIGxpbmUgZ29lcyBvbi4KICAgICAgICBpZiAocm93KSBjb250aW51ZTsKICAgICAgICBpZiAoY3VyICYmICFjdXIucnVucy5sZW5ndGggJiYgIWlzQ2xvc2UpIGNvbnRpbnVlOwogICAgICAgIGVuZCgpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnYScpIHsKICAgICAgICBpZiAoaXNDbG9zZSkgaHJlZnMucG9wKCk7Ci",
"AgICAgICAgZWxzZSBpZiAoIXNlbGZDbG9zaW5nKSBocmVmcy5wdXNoKHNhZmVIcmVmKGEuaHJlZikpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChJTkxJTkVbbmFtZV0pIHsKICAgICAgICBpZiAoc2VsZkNsb3NpbmcpIGNvbnRpbnVlOwogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgICAvLyBUaGUgaW5uZXJtb3N0IG9wZW4gdGFnIG9mIHRoYXQgbmFtZSAtIG1haWwgaXMgbm90IGFsd2F5cyB0aWRpbHkgbmVzdGVkLgogICAgICAgICAgZm9yIChsZXQgayA9IGlubGluZS5sZW5ndGggLSAxOyBrID49IDA7IGstLSkgewogICAgICAgICAgICBpZiAoaW5saW5lW2tdLm5hbWUgIT09IG5hbWUpIGNvbnRpbnVlOwogICAgICAgICAgICBjb25zdCBbZ290XSA9IGlubGluZS5zcGxpY2UoaywgMSk7CiAgICAgICAgICAgIGlmIChnb3QuZ2x5cGgpIGdseXBoID0gTWF0aC5tYXgoMCwgZ2x5cGggLSAxKTsKICAgICAgICAgICAgZWxzZSBhcHBseShnb3QubWFya3MsIC0xKTsKICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICB9CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3Qgc3R5bGUgPSBTdHJpbmcoYS5zdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAoYVsnZGF0YS1nbHlwaCddIHx8IC9tc28tbGlzdFxzKjpccyppZ25vcmUvLnRlc3Qoc3R5bGUpKSB7CiAgICAgICAgICBpbmxpbmUucHVzaCh7IG5hbWUsIGdseXBoOiB0cnVlIH0pOwogICAgIC",
"AgICAgZ2x5cGgrKzsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBsZXQgZ290ID0gWy4uLklOTElORVtuYW1lXSwgLi4uc3R5bGVNYXJrcyhzdHlsZSldOwogICAgICAgIC8vIEdvb2dsZSBEb2NzIHdyYXBzIGEgd2hvbGUgcGFzdGUgaW4gPGIgc3R5bGU9ImZvbnQtd2VpZ2h0Om5vcm1hbCI-LgogICAgICAgIGlmICgvZm9udC13ZWlnaHRccyo6XHMqKG5vcm1hbHxsaWdodGVyfFsxLTVdMDApXGIvLnRlc3Qoc3R5bGUpKSBnb3QgPSBnb3QuZmlsdGVyKHggPT4geCAhPT0gJ2InKTsKICAgICAgICBpZiAoL2ZvbnQtc3R5bGVccyo6XHMqbm9ybWFsLy50ZXN0KHN0eWxlKSkgZ290ID0gZ290LmZpbHRlcih4ID0-IHggIT09ICdpJyk7CiAgICAgICAgZ290ID0gWy4uLm5ldyBTZXQoZ290KV07CiAgICAgICAgaW5saW5lLnB1c2goeyBuYW1lLCBtYXJrczogZ290IH0pOwogICAgICAgIGFwcGx5KGdvdCwgMSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQW55dGhpbmcgZWxzZSAoaW1nLCB1LCBzdXAsIGNvZGUsIOKApik6IGl0cyB0ZXh0IGlzIGtlcHQsIHRoZSB0YWcgaXMgbm90LgogICAgfQogICAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKG1hcmtzKSkgbWFya3Nba10gPSBNYXRoLm1heCgwLCBtYXJrc1trXSk7CgogICAgLy8gVGlkeSBlYWNoIGJsb2NrOiBjb2xsYXBzZSB0aGUgd2hpdGVzcGFjZSBIVE1MIHdvdWxkIGNvbGxhcHNlLCB0aGVuCiAgICAvLyB0dXJuIHRoZS",
"AmbmJzcDtzIHRoYXQgaGVsZCBkZWxpYmVyYXRlIHNwYWNlcyBiYWNrIGludG8gc3BhY2VzLgogICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICBjb25zdCBydW5zID0gYi5ydW5zOwogICAgICBpZiAocnVucy5sZW5ndGgpIHsKICAgICAgICBydW5zWzBdLnRleHQgPSBydW5zWzBdLnRleHQucmVwbGFjZSgvXiArLywgJycpOwogICAgICAgIHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0ID0gcnVuc1tydW5zLmxlbmd0aCAtIDFdLnRleHQucmVwbGFjZSgvICskLywgJycpOwogICAgICAgIGZvciAobGV0IGkgPSAxOyBpIDwgcnVucy5sZW5ndGg7IGkrKykgewogICAgICAgICAgaWYgKC8gJC8udGVzdChydW5zW2kgLSAxXS50ZXh0KSkgcnVuc1tpXS50ZXh0ID0gcnVuc1tpXS50ZXh0LnJlcGxhY2UoL14gKy8sICcnKTsKICAgICAgICB9CiAgICAgICAgZm9yIChjb25zdCByIG9mIHJ1bnMpIHIudGV4dCA9IHIudGV4dC5yZXBsYWNlKC_CoC9nLCAnICcpOwogICAgICB9CiAgICAgIGlmIChiLndvcmRMaXN0ICYmIC9eXHMqKFxkK3xbYS16XXxbaXZ4bGNdKylbLildXHMqJC9pLnRlc3QoYi5tYXJrZXIgfHwgJycpKSBiLnR5cGUgPSAnb2wnOwogICAgICAvLyBBIGNoZWNrIGJveCBkcmF3biBhcyB0ZXh0IChtYWlsIGZyb20gZWxzZXdoZXJlLCBvciBhIGxpc3Qgd2hvc2UKICAgICAgLy8gbWFya2VycyB3ZXJlIGxvc3QpIHN0aWxsIGNvdW50cyBhcyBhIGNoZWNrIGJveC4KICAgICAgaWYgKExJU1RTLmhhcyhiLn",
"R5cGUpICYmIHJ1bnMubGVuZ3RoICYmICFiLm91cnMpIHsKICAgICAgICBjb25zdCBnID0gL14oW-KYkOKYkV0pID8vLmV4ZWMocnVuc1swXS50ZXh0KTsKICAgICAgICBpZiAoZykgewogICAgICAgICAgcnVuc1swXS50ZXh0ID0gcnVuc1swXS50ZXh0LnNsaWNlKGdbMF0ubGVuZ3RoKTsKICAgICAgICAgIGlmIChiLnR5cGUgPT09ICd1bCcpIGIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICBpZiAoYi50eXBlID09PSAnY2hlY2snKSBiLmNoZWNrZWQgPSBnWzFdID09PSBUSUNLRUQ7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICByZXR1cm4gbm9ybWFsaXNlRG9jKGJsb2Nrcyk7CiAgfQoKICAvLyDilIDilIAgTWFya2Rvd24gaW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUZXh0IGNvcGllZCBmcm9tIGEgY2hhdCBhc3Npc3RhbnQsIGEgUkVBRE1FIG9yIGEgTWFya2Rvd24gZWRpdG9yCiAgLy8gYXJyaXZlcyBhcyBwbGFpbiB0ZXh0IGZ1bGwgb2YgKipzdGFycyoqIGFuZCAiLSAiIGxpbmVzLiBUaGUgY29tbW9uCiAgLy8gcGFydCBvZiBNYXJrZG93biBiZWNvbWVzIGZvcm1hdHRpbmc7IHRoZSByZXN0IHN0YXlzIGFzIHR5cGVkLgoKICBmdW5jdGlvbi",
"BtZElubGluZShzcmMsIG1hcmtzID0ge30pIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgcyA9IFN0cmluZyhzcmMgfHwgJycpOwogICAgbGV0IGJ1ZiA9ICcnOwogICAgY29uc3QgZmx1c2ggPSAoKSA9PiB7CiAgICAgIGlmIChidWYpIG91dC5wdXNoKHsgdGV4dDogYnVmLCAuLi5tYXJrcyB9KTsKICAgICAgYnVmID0gJyc7CiAgICB9OwogICAgY29uc3QgbmVzdGVkID0gKGlubmVyLCBleHRyYSkgPT4gewogICAgICBmbHVzaCgpOwogICAgICBvdXQucHVzaCguLi5tZElubGluZShpbm5lciwgeyAuLi5tYXJrcywgLi4uZXh0cmEgfSkpOwogICAgfTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IHJlc3QgPSBzLnNsaWNlKGkpOwogICAgICBjb25zdCBwcmV2ID0gaSA_IHNbaSAtIDFdIDogJyc7CiAgICAgIGxldCBtOwogICAgICBpZiAoKG0gPSAvXlxcKFtcXGAqX3t9W1xdKCkjK1wtLiF-fD5dKS8uZXhlYyhyZXN0KSkpIHsgYnVmICs9IG1bMV07IGkgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICgobSA9IC9eYChbXmBcbl0rKWAvLmV4ZWMocmVzdCkpKSB7IGJ1ZiArPSBtWzFdOyBpICs9IG1bMF0ubGVuZ3RoOyBjb250aW51ZTsgfQogICAgICBpZiAoKG0gPSAvXlxbKFteXF1cbl0rKVxdXChccyo8PyhbXilccz5dKyk-Pyg_OlxzKyJbXiJdKiIpP1xzKlwpLy5leGVjKHJlc3QpKSkgewogICAgICAgIGNvbnN0IGhyZWYgPSBzYWZlSHJlZihtWz",
"JdKTsKICAgICAgICBuZXN0ZWQobVsxXSwgaHJlZiA_IHsgaHJlZiB9IDoge30pOwogICAgICAgIGkgKz0gbVswXS5sZW5ndGg7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKChtID0gL148KCg_Omh0dHBzPzpcL1wvfG1haWx0bzopW14-XHNdKyk-Ly5leGVjKHJlc3QpKSkgewogICAgICAgIGZsdXNoKCk7CiAgICAgICAgY29uc3QgaHJlZiA9IHNhZmVIcmVmKG1bMV0pOwogICAgICAgIG91dC5wdXNoKHsgdGV4dDogbVsxXS5yZXBsYWNlKC9ebWFpbHRvOi8sICcnKSwgLi4ubWFya3MsIC4uLihocmVmID8geyBocmVmIH0gOiB7fSkgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoKG0gPSAvXihcKlwqfF9fKSg_PVxTKShbXHNcU10qP1xTKVwxLy5leGVjKHJlc3QpKSAmJiAhKG1bMV0gPT09ICdfXycgJiYgL1tccHtMfVxwe059XS91LnRlc3QocHJldikpKSB7CiAgICAgICAgbmVzdGVkKG1bMl0sIHsgYjogdHJ1ZSB9KTsKICAgICAgICBpICs9IG1bMF0ubGVuZ3RoOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICgobSA9IC9efn4oPz1cUykoW1xzXFNdKj9cUyl-fi8uZXhlYyhyZXN0KSkpIHsgbmVzdGVkKG1bMV0sIHsgczogdHJ1ZSB9KTsgaSArPSBtWzBdLmxlbmd0aDsgY29udGludWU7IH0KICAgICAgaWYgKChtID0gL15cKig_PVteXHMqXSkoW1xzXFNdKj9bXlxzKl0pXCooPyFcKikvLmV4ZWMocmVzdCkpKS",
"B7IG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7IGkgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICghL1tccHtMfVxwe059X10vdS50ZXN0KHByZXYpICYmIChtID0gL15fKD89W15cc19dKShbXHNcU10qP1teXHNfXSlfKD8hW1xwe0x9XHB7Tn1fXSkvdS5leGVjKHJlc3QpKSkgewogICAgICAgIG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBidWYgKz0gc1tpXTsKICAgICAgaSsrOwogICAgfQogICAgZmx1c2goKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBPbmUgbGluZSBvZiBNYXJrZG93bjogd2hhdCBraW5kIG9mIGJsb2NrIGl0IGlzLCBpdHMgaW5kZW50IGFuZCB0ZXh0LgogIGZ1bmN0aW9uIG1kTGluZShsaW5lKSB7CiAgICBjb25zdCBbLCBwYWQsIHNdID0gL14oICopKC4qKSQvLmV4ZWMobGluZSk7CiAgICBjb25zdCBpbmRlbnQgPSBwYWQubGVuZ3RoOwogICAgbGV0IHg7CiAgICBpZiAoKHggPSAvXigjezEsNn0pXHMrKC4qPykoPzpccysjKyk_XHMqJC8uZXhlYyhzKSkpIHJldHVybiB7IHR5cGU6IFsnaDEnLCAnaDInLCAnaDMnXVtNYXRoLm1pbigyLCB4WzFdLmxlbmd0aCAtIDEpXSwgdGV4dDogeFsyXSB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzK1xbKFsgeFhdKVxdXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdIC",
"E9PSAnICcsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogICAgaWYgKCh4ID0gL14oW-KYkOKYkV0pXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdID09PSBUSUNLRUQsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzKyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3VsJywgdGV4dDogeFsxXSwgaW5kZW50IH07CiAgICBpZiAoKHggPSAvXlxkezEsM31bLildXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnb2wnLCB0ZXh0OiB4WzFdLCBpbmRlbnQgfTsKICAgIGlmICgoeCA9IC9ePlxzPyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3AnLCB0ZXh0OiB4WzFdLnJlcGxhY2UoL14oPlxzPykrLywgJycpIH07CiAgICBpZiAoL15cfC4qXHxccyokLy50ZXN0KHMpKSByZXR1cm4geyB0eXBlOiAncCcsIGNlbGxzOiBzLnRyaW0oKS5zbGljZSgxLCAtMSkuc3BsaXQoLyg_PCFcXClcfC8pLm1hcChjID0-IGMudHJpbSgpKSB9OwogICAgcmV0dXJuIHsgdHlwZTogJ3AnLCB0ZXh0OiBzIH07CiAgfQoKICBjb25zdCBNRF9SVUxFID0gL15ccyooWy0qX10pKFxzKlwxKXsyLH1ccyokLzsKICBjb25zdCBNRF9UQUJMRV9SVUxFID0gL15ccypcfD9ccyo6Py17Myx9Oj9ccyooXHxccyo6Py17Myx9Oj9ccyopK1x8P1xzKiQvOwoKICBmdW5jdGlvbiBmcm9tTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgbGluZX",
"MgPSBTdHJpbmcodGV4dCB8fCAnJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXHQvZywgJyAgICAnKS5zcGxpdCgnXG4nKTsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgaW5kZW50cyA9IFtdOyAgIC8vIHRoZSBpbmRlbnQgb2YgZWFjaCBvcGVuIGxpc3QgbGV2ZWwKICAgIGxldCBmZW5jZSA9IGZhbHNlOwogICAgY29uc3QgbGFzdCA9ICgpID0-IG91dFtvdXQubGVuZ3RoIC0gMV07CiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHsKICAgICAgaWYgKC9eXHMqKGBgYHx-fn4pLy50ZXN0KGxpbmUpKSB7IGZlbmNlID0gIWZlbmNlOyBjb250aW51ZTsgfQogICAgICBpZiAoZmVuY2UpIHsgb3V0LnB1c2goYmxvY2soJ3AnLCBbeyB0ZXh0OiBsaW5lIH1dKSk7IGNvbnRpbnVlOyB9CiAgICAgIC8vIFRoZSB8LS0tfC0tLXwgbGluZSB1bmRlciBhIHRhYmxlJ3MgaGVhZGluZyByb3cgbWFrZXMgdGhhdCByb3cgYm9sZC4KICAgICAgaWYgKE1EX1RBQkxFX1JVTEUudGVzdChsaW5lKSkgewogICAgICAgIGNvbnN0IGhlYWQgPSBsYXN0KCk7CiAgICAgICAgaWYgKGhlYWQgJiYgaGVhZC50YWJsZSkgZm9yIChjb25zdCByIG9mIGhlYWQucnVucykgaWYgKCFyLnNlcCkgci5iID0gdHJ1ZTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoTURfUlVMRS50ZXN0KGxpbmUpKSBjb250aW51ZTsKICAgICAgLy8gT25lIGVtcHR5IGxpbmUgaXMgYSBnYXA7IG1vcmUgYXJlIG5vdCwgYW5kIG",
"5vciBpcyBvbmUgYmVzaWRlIGEKICAgICAgLy8gaGVhZGluZywgd2hpY2ggaGFzIHNwYWNlIG9mIGl0cyBvd24uCiAgICAgIGlmICghbGluZS50cmltKCkpIHsKICAgICAgICBpZiAoIW91dC5sZW5ndGggfHwgIShmbXRCbGFuayhsYXN0KCkpIHx8IEhFQURJTkdTW2xhc3QoKS50eXBlXSkpIG91dC5wdXNoKGJsb2NrKCdwJykpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IGwgPSBtZExpbmUobGluZS5yZXBsYWNlKC9ccyskLywgJycpKTsKICAgICAgaWYgKEhFQURJTkdTW2wudHlwZV0gJiYgb3V0Lmxlbmd0aCAmJiBmbXRCbGFuayhsYXN0KCkpKSBvdXQucG9wKCk7CiAgICAgIGlmIChMSVNUUy5oYXMobC50eXBlKSkgewogICAgICAgIC8vIEEgYmxhbmsgbGluZSBiZXR3ZWVuIHR3byBpdGVtcyBvZiBhIGxpc3QgaXMgbm90IGEgZ2FwIGluIGl0LgogICAgICAgIGlmIChvdXQubGVuZ3RoID4gMSAmJiBmbXRCbGFuayhsYXN0KCkpICYmIExJU1RTLmhhcyhvdXRbb3V0Lmxlbmd0aCAtIDJdLnR5cGUpKSBvdXQucG9wKCk7CiAgICAgICAgd2hpbGUgKGluZGVudHMubGVuZ3RoICYmIGwuaW5kZW50IDwgaW5kZW50c1tpbmRlbnRzLmxlbmd0aCAtIDFdKSBpbmRlbnRzLnBvcCgpOwogICAgICAgIGlmICghaW5kZW50cy5sZW5ndGggfHwgbC5pbmRlbnQgPiBpbmRlbnRzW2luZGVudHMubGVuZ3RoIC0gMV0pIGluZGVudHMucHVzaChsLmluZGVudCk7CiAgICAgICAgb3V0LnB1c2goYmxvY2sobC50eXBlLC",
"BtZElubGluZShsLnRleHQpLCB7IGxldmVsOiBpbmRlbnRzLmxlbmd0aCAtIDEsIGNoZWNrZWQ6IGwuY2hlY2tlZCB9KSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaW5kZW50cy5sZW5ndGggPSAwOwogICAgICBpZiAobC5jZWxscykgewogICAgICAgIGNvbnN0IHJ1bnMgPSBbXTsKICAgICAgICBsLmNlbGxzLmZvckVhY2goKGMsIGspID0-IHsKICAgICAgICAgIGlmIChrKSBydW5zLnB1c2goeyB0ZXh0OiAnIHwgJywgc2VwOiB0cnVlIH0pOwogICAgICAgICAgcnVucy5wdXNoKC4uLm1kSW5saW5lKGMucmVwbGFjZSgvXFxcfC9nLCAnfCcpKSk7CiAgICAgICAgfSk7CiAgICAgICAgY29uc3QgYiA9IGJsb2NrKCdwJywgcnVucyk7CiAgICAgICAgYi50YWJsZSA9IHRydWU7CiAgICAgICAgb3V0LnB1c2goYik7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgb3V0LnB1c2goYmxvY2sobC50eXBlLCBtZElubGluZShsLnRleHQudHJpbSgpKSkpOwogICAgfQogICAgd2hpbGUgKG91dC5sZW5ndGggPiAxICYmIGZtdEJsYW5rKGxhc3QoKSkpIG91dC5wb3AoKTsKICAgIHdoaWxlIChvdXQubGVuZ3RoID4gMSAmJiBmbXRCbGFuayhvdXRbMF0pKSBvdXQuc2hpZnQoKTsKICAgIHJldHVybiBub3JtYWxpc2VEb2Mob3V0KTsKICB9CgogIGNvbnN0IGZtdEJsYW5rID0gYiA9PiBiLnR5cGUgPT09ICdwJyAmJiAhYi5ydW5zLnNvbWUociA9PiByLnRleHQudHJpbSgpKTsKCiAgLy8gV2hldGhlciBwbGFpbi",
"B0ZXh0IGlzIHdvcnRoIHJlYWRpbmcgYXMgTWFya2Rvd246IGEgaGVhZGluZywgbGlzdCwKICAvLyBxdW90ZSwgdGFibGUgb3IgY29kZSBsaW5lLCBvciBib2xkLCBzdHJ1Y2ssIGxpbmtlZCBvciBjb2RlIHRleHQuCiAgZnVuY3Rpb24gbG9va3NMaWtlTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIHJldHVybiAvXiB7MCwzfSgjezEsNn1ccytcU3xbLSor4oCiXVxzK1xTfFvimJDimJFdXHMrXFN8XGR7MSwzfVsuKV1ccytcU3w-XHN8YGBgKS9tLnRlc3QocykgfHwKICAgICAgL15ccypcfD9ccyo6Py17Myx9Oj9ccyooXHxccyo6Py17Myx9Oj9ccyopK1x8P1xzKiQvbS50ZXN0KHMpIHx8CiAgICAgIC9cKlwqW14qXG5dK1wqXCp8X19bXl9cbl0rX198fn5bXn5cbl0rfn58XFtbXlxdXG5dK1xdXChbXilcc10rXCl8YFteYFxuXStgLy50ZXN0KHMpOwogIH0KCiAgLy8g4pSA4pSAIFBhc3Rpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFdoZXRoZXIgYSBkb2N1bWVudCBoYXMgYW55dGhpbmcgcGxhaW4gdGV4dCB3b3VsZCBub3Q6IGEgaGVhZGluZywgYQogIC8vIGxpc3QsIGEgbWFyayBvciBhIG",
"xpbmsuCiAgZnVuY3Rpb24gaGFzRm9ybWF0dGluZyhkb2MpIHsKICAgIHJldHVybiBkb2Muc29tZShiID0-IGIudHlwZSAhPT0gJ3AnIHx8IGIucnVucy5zb21lKHIgPT4gci5iIHx8IHIuaSB8fCByLnMgfHwgci5ocmVmKSk7CiAgfQoKICAvLyBXaGF0IGEgcGFzdGUgYmVjb21lczogdGhlIGNsaXBib2FyZCdzIEhUTUwsIHJlYWQgbGlrZSBtYWlsOyBvciwgd2hlbgogIC8vIHRoYXQgYnJpbmdzIG5vIGZvcm1hdHRpbmcgYW5kIHRoZSB0ZXh0IGlzIE1hcmtkb3duIChmcm9tIGEgY2hhdAogIC8vIGFzc2lzdGFudCwgc2F5KSwgdGhlIE1hcmtkb3duIHJlYWQgYXMgZm9ybWF0dGluZy4gRW1wdHkgbGluZXMgYXQKICAvLyBlaXRoZXIgZW5kIGdvLiBudWxsIG1lYW5zIHRoZXJlIGlzIG5vdGhpbmcgdG8gZm9ybWF0OiB0aGUgdGV4dCBpcwogIC8vIHBhc3RlZCBhcyBpdCBpcy4KICBmdW5jdGlvbiBwYXN0ZURvYyh7IGh0bWwsIHRleHQgfSA9IHt9KSB7CiAgICBsZXQgZG9jID0gaHRtbCAmJiAvXFMvLnRlc3QoaHRtbCkgPyBwYXJzZUh0bWwoaHRtbCkgOiBudWxsOwogICAgaWYgKGRvYyAmJiBpc0VtcHR5KGRvYykpIGRvYyA9IG51bGw7CiAgICBpZiAoKCFkb2MgfHwgIWhhc0Zvcm1hdHRpbmcoZG9jKSkgJiYgbG9va3NMaWtlTWFya2Rvd24odGV4dCkpIGRvYyA9IGZyb21NYXJrZG93bih0ZXh0KTsKICAgIGlmICghZG9jKSByZXR1cm4gbnVsbDsKICAgIGxldCBpID0gMDsKICAgIGxldCBqID0gZG9jLmxlbmd0aDsKICAgIH",
"doaWxlIChpIDwgaiAmJiBmbXRCbGFuayhkb2NbaV0pKSBpKys7CiAgICB3aGlsZSAoaiA-IGkgJiYgZm10QmxhbmsoZG9jW2ogLSAxXSkpIGotLTsKICAgIHJldHVybiBpIDwgaiA_IGRvYy5zbGljZShpLCBqKSA6IG51bGw7CiAgfQoKICAvLyBUaGUgbm90ZSdzIGNvbnRlbnQgZnJvbSBpdHMgbWVzc2FnZSBwYXJ0czogSFRNTCB3aGVuIHRoZXJlIGlzIGFueSwKICAvLyB0aGUgcGxhaW4gdGV4dCBvdGhlcndpc2UuCiAgZnVuY3Rpb24gZG9jRnJvbVBhcnRzKHsgcGxhaW4sIGh0bWwgfSA9IHt9KSB7CiAgICBpZiAoaHRtbCAmJiBTdHJpbmcoaHRtbCkudHJpbSgpKSByZXR1cm4gcGFyc2VIdG1sKGh0bWwpOwogICAgcmV0dXJuIGZyb21QbGFpbihwbGFpbiB8fCAnJyk7CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBUWVBFUywgTElTVFMsIE1BWF9MRVZFTCwKICAgIGJsb2NrLCBlbXB0eURvYywgbm9ybWFsaXNlUnVucywgbm9ybWFsaXNlRG9jLCBkb2NUZXh0LCBpc0VtcHR5LCBzYWZlSHJlZiwKICAgIHRvSHRtbCwgdG9QbGFpbiwgZnJvbVBsYWluLCBwYXJzZUh0bWwsIGRvY0Zyb21QYXJ0cywgZnJvbU1hcmtkb3duLCBsb29rc0xpa2VNYXJrZG93biwgaGFzRm9ybWF0dGluZywgcGFzdGVEb2MsCiAgfTsKCiAgbnMubm90ZUZvcm1hdCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/search-log",
"ic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNlYXJjaCBoaWdobGlnaHRpbmcgKHB1cmUpCi8vCi8vIEdtYWlsIGRvZXMgdGhlIHNlYXJjaGluZzsgdGhpcyBvbmx5IHNob3dzIHdoZXJlIHRoZSB3b3JkcyBhcmUuIEl0IHRha2VzCi8vIHRoZSB3b3JkcyBvdXQgb2YgYSBHbWFpbCBxdWVyeSAtIGxlYXZpbmcgb3V0IG9wZXJhdG9ycyBzdWNoIGFzIGZyb206IG9yCi8vIGJlZm9yZTosIGFuZCBhbnl0aGluZyBleGNsdWRlZCB3aXRoIGEgbWludXMgLSBhbmQgZmluZHMgdGhlbSBpbiBhCi8vIG5vdGUncyB0ZXh0IHRoZSB3YXkgYSBwZXJzb24gd291bGQgcmVhZCBhIG1hdGNoOiBpZ25vcmluZyBjYXNlIGFuZAovLyBhY2NlbnRzICgiY2FmZSIgZmluZHMgIkNhZsOpIiksIGF0IHRoZSBzdGFydCBvZiBhIHdvcmQgKCJnbG9zcyIgZmluZHMKLy8gImdsb3NzYXJ5Iiwgbm90ICJ4Z2xvc3MiKSwgYW5kIHBocmFzZXMgaW4gcXVvdGVzIGFzIHBocmFzZXMuCi8vCi8vIEZyb20gdGhvc2UgbWF0Y2hlcyBjb21lIHRoZSBleGNlcnB0cyBzaG93biBpbiB0aGUgcmVzdWx0cyBsaXN0LCB3aXRo",
"Ci8vIHRoZWlyIG9mZnNldHMsIHNvIHRoZSBsaXN0IGNhbiBtYXJrIHRoZW0gd2l0aG91dCBwYXJzaW5nIGFueSBIVE1MLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8gT3BlcmF0b3JzIHdob3NlIHZhbHVlIGlzIGEgd29yZCB0byBsb29rIGZvciBpbiB0aGUgbm90ZSBpdHNlbGYuCiAgY29uc3QgVEVYVF9PUFMgPSBuZXcgU2V0KFsnc3ViamVjdCcsICdpbnRpdGxlJ10pOwogIGNvbnN0IEtFWVdPUkRTID0gbmV3IFNldChbJ29yJywgJ2FuZCcsICdhcm91bmQnXSk7CgogIC8vIOKUgOKUgCBUaGUgd29yZHMgaW4gYSBxdWVyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmV0dXJucyBbeyB3b3JkczogWydzdGVudCcsICdj",
"b2F0aW5nJ10gfSwg4oCmXTogb25lIGVudHJ5IHBlciB0ZXJtLCBhCiAgLy8gcGhyYXNlIGJlaW5nIHNldmVyYWwgd29yZHMgaW4gYSByb3cuCiAgZnVuY3Rpb24gcXVlcnlUZXJtcyhxdWVyeSkgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3QgYWRkID0gdGV4dCA9PiB7CiAgICAgIGNvbnN0IHdvcmRzID0gU3RyaW5nKHRleHQpLnNwbGl0KC9bXHMiKClbXF17fTw-XSsvKS5tYXAodyA9PiB3LnJlcGxhY2UoL15bXlxwe0x9XHB7Tn1dK3xbXlxwe0x9XHB7Tn1dKyQvZ3UsICcnKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgICBpZiAoIXdvcmRzLmxlbmd0aCkgcmV0dXJuOwogICAgICBpZiAod29yZHMubGVuZ3RoID09PSAxICYmIHdvcmRzWzBdLmxlbmd0aCA8IDIgJiYgL15bXHB7TH1ccHtOfV0kL3UudGVzdCh3b3Jkc1swXSkgJiYgL1thLXowLTldL2kudGVzdCh3b3Jkc1swXSkpIHJldHVybjsKICAgICAgY29uc3Qga2V5ID0gd29yZHMuam9pbignICcpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm47CiAgICAgIHNlZW4uYWRkKGtleSk7CiAgICAgIG91dC5wdXNoKHsgd29yZHMgfSk7CiAgICB9OwogICAgY29uc3QgdG9rZW5zID0gU3RyaW5nKHF1ZXJ5IHx8ICcnKS5tYXRjaCgvLT9bXHB7TH1ccHtOfV9dKzpcKFteKV0qXCl8LT9bXHB7TH1ccHtOfV9dKzoiW14iXSoifC0_IlteIl0qInxcUysvZ3UpIHx8IFtdOwogICAgZm9y",
"IChjb25zdCByYXcgb2YgdG9rZW5zKSB7CiAgICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnLScpKSBjb250aW51ZTsgLy8gZXhjbHVkZWQ6IG5vdCBpbiB0aGUgbm90ZQogICAgICBjb25zdCBvcCA9IC9eKFtccHtMfVxwe059X10rKTooLiopJC91LmV4ZWMocmF3KTsKICAgICAgaWYgKG9wKSB7CiAgICAgICAgaWYgKFRFWFRfT1BTLmhhcyhvcFsxXS50b0xvd2VyQ2FzZSgpKSkgewogICAgICAgICAgY29uc3QgdiA9IG9wWzJdLnJlcGxhY2UoL15bKCJdfFspIl0kL2csICcnKTsKICAgICAgICAgIGlmICgvXlwoLy50ZXN0KG9wWzJdKSkgdi5zcGxpdCgvXHMrLykuZm9yRWFjaChhZGQpOwogICAgICAgICAgZWxzZSBhZGQodik7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnIicpKSB7IGFkZChyYXcucmVwbGFjZSgvIi9nLCAnJykpOyBjb250aW51ZTsgfQogICAgICBjb25zdCB3b3JkID0gcmF3LnJlcGxhY2UoL15bKygpe31dK3xbKCl7fV0rJC9nLCAnJyk7CiAgICAgIGlmIChLRVlXT1JEUy5oYXMod29yZC50b0xvd2VyQ2FzZSgpKSkgY29udGludWU7CiAgICAgIGFkZCh3b3JkKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgRmluZGluZyB0aGVtIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU",
"gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBMb3dlciBjYXNlLCBhY2NlbnRzIG9mZiAtIG9uZSBjaGFyYWN0ZXIgYXQgYSB0aW1lLCB3aXRoIGEgbWFwIGJhY2sgdG8KICAvLyB3aGVyZSBlYWNoIGZvbGRlZCBjaGFyYWN0ZXIgY2FtZSBmcm9tLCBzbyBhIG1hdGNoIGluIHRoZSBmb2xkZWQgdGV4dAogIC8vIGlzIGEgbWF0Y2ggYXQga25vd24gb2Zmc2V0cyBpbiB0aGUgcmVhbCBvbmUuCiAgZnVuY3Rpb24gZm9sZCh0ZXh0KSB7CiAgICBsZXQgZm9sZGVkID0gJyc7CiAgICBjb25zdCBtYXAgPSBbXTsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHMubGVuZ3RoOykgewogICAgICBjb25zdCBjcCA9IHMuY29kZVBvaW50QXQoaSk7CiAgICAgIGNvbnN0IGNoID0gU3RyaW5nLmZyb21Db2RlUG9pbnQoY3ApOwogICAgICBjb25zdCBmID0gY2gubm9ybWFsaXplKCdORkQnKS5yZXBsYWNlKC9ccHtNfSsvZ3UsICcnKS50b0xvd2VyQ2FzZSgpOwogICAgICBmb3IgKGxldCBrID0gMDsgayA8IGYubGVuZ3RoOyBrKyspIG1hcC5wdXNoKGkpOwogICAgICBmb2xkZWQgKz0gZjsKICAgICAgaSArPSBjaC5sZW5ndGg7CiAgICB9CiAgICBtYXAucHVzaChzLmxlbmd0aCk7CiAgICByZXR1cm4geyBmb2xkZWQsIG1hcCB9OwogIH0KCiAgY29uc3QgZXNjYXBlUmUgPSBzID0-IHMucmVwbGFjZSgvWy4qKz9eJHt9KCl8",
"W1xdXFxdL2csICdcXCQmJyk7CgogIC8vIEV2ZXJ5IHBsYWNlIHRoZSB0ZXJtcyBvY2N1ciwgYXMgW3N0YXJ0LCBlbmQpIG9mZnNldHMgaW50byBgdGV4dGAsCiAgLy8gaW4gb3JkZXIsIHdpdGggb3ZlcmxhcHMgbWVyZ2VkLgogIGZ1bmN0aW9uIGZpbmRNYXRjaGVzKHRleHQsIHRlcm1zKSB7CiAgICBpZiAoIXRlcm1zIHx8ICF0ZXJtcy5sZW5ndGggfHwgIXRleHQpIHJldHVybiBbXTsKICAgIGNvbnN0IHsgZm9sZGVkLCBtYXAgfSA9IGZvbGQodGV4dCk7CiAgICBjb25zdCBmb3VuZCA9IFtdOwogICAgZm9yIChjb25zdCB0IG9mIHRlcm1zKSB7CiAgICAgIGNvbnN0IHBhdHRlcm4gPSB0LndvcmRzLm1hcCh3ID0-IGVzY2FwZVJlKGZvbGQodykuZm9sZGVkKSkuam9pbignW1xcc1xcdTAwYTBdKycpOwogICAgICBpZiAoIXBhdHRlcm4pIGNvbnRpbnVlOwogICAgICBjb25zdCByZSA9IG5ldyBSZWdFeHAoYCg_PCFbXFxwe0x9XFxwe059XSkke3BhdHRlcm59YCwgJ2d1Jyk7CiAgICAgIGxldCBtOwogICAgICB3aGlsZSAoKG0gPSByZS5leGVjKGZvbGRlZCkpKSB7CiAgICAgICAgZm91bmQucHVzaChbbWFwW20uaW5kZXhdLCBtYXBbbS5pbmRleCArIG1bMF0ubGVuZ3RoXV0pOwogICAgICAgIGlmIChtWzBdLmxlbmd0aCA9PT0gMCkgcmUubGFzdEluZGV4Kys7CiAgICAgIH0KICAgIH0KICAgIGZvdW5kLnNvcnQoKGEsIGIpID0-IGFbMF0gLSBiWzBdIHx8IGFbMV0gLSBiWzFdKTsKICAgIGNvbnN0IG1lcmdlZCA9IFtdOwog",
"ICAgZm9yIChjb25zdCBbcywgZV0gb2YgZm91bmQpIHsKICAgICAgY29uc3QgbGFzdCA9IG1lcmdlZFttZXJnZWQubGVuZ3RoIC0gMV07CiAgICAgIGlmIChsYXN0ICYmIHMgPD0gbGFzdC5lbmQpIGxhc3QuZW5kID0gTWF0aC5tYXgobGFzdC5lbmQsIGUpOwogICAgICBlbHNlIG1lcmdlZC5wdXNoKHsgc3RhcnQ6IHMsIGVuZDogZSB9KTsKICAgIH0KICAgIHJldHVybiBtZXJnZWQ7CiAgfQoKICAvLyDilIDilIAgRXhjZXJwdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFVwIHRvIGBtYXhgIHN0cmV0Y2hlcyBvZiB0ZXh0IGFyb3VuZCB0aGUgbWF0Y2hlcywgZWFjaCB3aXRoIHRoZQogIC8vIG1hdGNoZXMgaW5zaWRlIGl0IGF0IG9mZnNldHMgcmVsYXRpdmUgdG8gdGhlIHN0cmV0Y2guIFN0cmV0Y2hlcyBzdGFydAogIC8vIGFuZCBlbmQgb24gYSBzcGFjZSB3aGVyZSBvbmUgaXMgbmVhciwgYW5kIHNheSB3aGV0aGVyIHRleHQgd2FzIGN1dC4KICBmdW5jdGlvbiBleGNlcnB0cyh0ZXh0LCBtYXRjaGVzLCB7IGNvbnRleHQgPSA1MCwgbWF4ID0gMyB9ID0ge30pIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBjb25zdCBvdXQg",
"PSBbXTsKICAgIGxldCBpID0gMDsKICAgIHdoaWxlIChpIDwgbWF0Y2hlcy5sZW5ndGggJiYgb3V0Lmxlbmd0aCA8IG1heCkgewogICAgICBsZXQgc3RhcnQgPSBNYXRoLm1heCgwLCBtYXRjaGVzW2ldLnN0YXJ0IC0gY29udGV4dCk7CiAgICAgIGxldCBlbmQgPSBNYXRoLm1pbihzLmxlbmd0aCwgbWF0Y2hlc1tpXS5lbmQgKyBjb250ZXh0KTsKICAgICAgLy8gTWF0Y2hlcyBjbG9zZSBlbm91Z2ggc2hhcmUgYW4gZXhjZXJwdC4KICAgICAgbGV0IGogPSBpICsgMTsKICAgICAgd2hpbGUgKGogPCBtYXRjaGVzLmxlbmd0aCAmJiBtYXRjaGVzW2pdLnN0YXJ0IDwgZW5kKSB7CiAgICAgICAgZW5kID0gTWF0aC5taW4ocy5sZW5ndGgsIE1hdGgubWF4KGVuZCwgbWF0Y2hlc1tqXS5lbmQgKyBNYXRoLmZsb29yKGNvbnRleHQgLyAyKSkpOwogICAgICAgIGorKzsKICAgICAgfQogICAgICBpZiAoc3RhcnQgPiAwKSB7CiAgICAgICAgY29uc3Qgc3AgPSBzLnNsaWNlKHN0YXJ0LCBtYXRjaGVzW2ldLnN0YXJ0KS5zZWFyY2goL1xzLyk7CiAgICAgICAgaWYgKHNwID49IDApIHN0YXJ0ICs9IHNwICsgMTsKICAgICAgfQogICAgICBpZiAoZW5kIDwgcy5sZW5ndGgpIHsKICAgICAgICBjb25zdCB0YWlsID0gcy5zbGljZShtYXRjaGVzW2ogLSAxXS5lbmQsIGVuZCk7CiAgICAgICAgY29uc3Qgc3AgPSB0YWlsLnNlYXJjaCgvXHNcUyokLyk7CiAgICAgICAgaWYgKHNwID4gMCkgZW5kID0gbWF0Y2hlc1tqIC0gMV0uZW5kICsgc3A7CiAg",
"ICAgIH0KICAgICAgb3V0LnB1c2goewogICAgICAgIHRleHQ6IHMuc2xpY2Uoc3RhcnQsIGVuZCkucmVwbGFjZSgvXHMvZywgJyAnKSwKICAgICAgICBtYXJrczogbWF0Y2hlcy5zbGljZShpLCBqKS5tYXAobSA9PiAoeyBzdGFydDogTWF0aC5tYXgobS5zdGFydCwgc3RhcnQpIC0gc3RhcnQsIGVuZDogTWF0aC5taW4obS5lbmQsIGVuZCkgLSBzdGFydCB9KSksCiAgICAgICAgY3V0QmVmb3JlOiBzdGFydCA-IDAsCiAgICAgICAgY3V0QWZ0ZXI6IGVuZCA8IHMubGVuZ3RoLAogICAgICB9KTsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgYXBpID0geyBxdWVyeVRlcm1zLCBmb2xkLCBmaW5kTWF0Y2hlcywgZXhjZXJwdHMgfTsKCiAgbnMuc2VhcmNoTG9naWMgPSBhcGk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKfSkoKTsK\"],[\"src/content/ui.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIERPTSB0b29sa2l0IGZvciB0aGUgaW5qZWN0ZWQgVUkKLy8",
"KLy8gR21haWwgZW5mb3JjZXMgVHJ1c3RlZCBUeXBlcyBvbiBpdHMgcGFnZSwgdW5kZXIgd2hpY2ggaW5uZXJIVE1MIGFuZAovLyBmcmllbmRzIHRocm93LiBDaHJvbWl1bSBjdXJyZW50bHkgZXhlbXB0cyBhIGNvbnRlbnQgc2NyaXB0J3MgaXNvbGF0ZWQKLy8gd29ybGQgZnJvbSB0aGF0IHBvbGljeSwgYnV0IG5vdGhpbmcgcHJvbWlzZXMgaXQgYWx3YXlzIHdpbGwgLSBhbmQgbWFpbAovLyBzdWJqZWN0cyBhcmUgdW50cnVzdGVkIHRleHQgcmVnYXJkbGVzcy4gU28gZXZlcnkgbm9kZSBoZXJlIGlzIGJ1aWx0Ci8vIHdpdGggY3JlYXRlRWxlbWVudCAvIGNyZWF0ZUVsZW1lbnROUyBhbmQgZmlsbGVkIHdpdGggdGV4dENvbnRlbnQuIEFsbAovLyBvZiBpdCBsaXZlcyBpbiBzaGFkb3cgcm9vdHMgc28gR21haWwncyBzdHlsZXNoZWV0IGFuZCBvdXJzIG5ldmVyIG1lZXQuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgRWx",
"lbWVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFByb3BlcnRpZXMgdGhhdCBtdXN0IGJlIHNldCBhcyBwcm9wZXJ0aWVzLCBub3QgYXR0cmlidXRlcywgdG8gdGFrZQogIC8vIGVmZmVjdCBhZnRlciBmaXJzdCByZW5kZXIgKGFuIGlucHV0J3MgdmFsdWUsIGEgY2hlY2tib3gncyBzdGF0ZSkuCiAgY29uc3QgUFJPUFMgPSBuZXcgU2V0KFsndmFsdWUnLCAnY2hlY2tlZCcsICdkaXNhYmxlZCcsICdoaWRkZW4nXSk7CgogIGZ1bmN0aW9uIGgodGFnLCBwcm9wcywgLi4ua2lkcykgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7CiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhwcm9wcyB8fCB7fSkpIHsKICAgICAgaWYgKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsIHx8IHYgPT09IGZhbHNlKSBjb250aW51ZTsKICAgICAgaWYgKGsgPT09ICdjbGFzcycpIGVsLmNsYXNzTmFtZSA9IEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcihCb29sZWFuKS5qb2luKCcgJykgOiB2OwogICAgICBlbHNlIGlmIChrID09PSAndGV4dCcpIGVsLnRleHRDb250ZW50ID0gU3RyaW5nKHYpOwogICAgICB",
"lbHNlIGlmIChrID09PSAnZGF0YXNldCcpIE9iamVjdC5hc3NpZ24oZWwuZGF0YXNldCwgdik7CiAgICAgIGVsc2UgaWYgKGsuc3RhcnRzV2l0aCgnb24nKSAmJiB0eXBlb2YgdiA9PT0gJ2Z1bmN0aW9uJykgZWwuYWRkRXZlbnRMaXN0ZW5lcihrLnNsaWNlKDIpLCB2KTsKICAgICAgZWxzZSBpZiAoUFJPUFMuaGFzKGspKSBlbFtrXSA9IHY7CiAgICAgIGVsc2UgZWwuc2V0QXR0cmlidXRlKGssIHYgPT09IHRydWUgPyAnJyA6IFN0cmluZyh2KSk7CiAgICB9CiAgICBhcHBlbmQoZWwsIGtpZHMpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgZnVuY3Rpb24gYXBwZW5kKGVsLCBraWRzKSB7CiAgICBmb3IgKGNvbnN0IGtpZCBvZiBraWRzLmZsYXQoSW5maW5pdHkpKSB7CiAgICAgIGlmIChraWQgPT09IG51bGwgfHwga2lkID09PSB1bmRlZmluZWQgfHwga2lkID09PSBmYWxzZSkgY29udGludWU7CiAgICAgIGVsLmFwcGVuZENoaWxkKHR5cGVvZiBraWQgPT09ICdzdHJpbmcnIHx8IHR5cGVvZiBraWQgPT09ICdudW1iZXInCiAgICAgICAgPyBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShTdHJpbmcoa2lkKSkgOiBraWQpOwogICAgfQogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIEljb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTWF0ZXJpYWwgU3ltYm9scyBwYXRocyAoQXBhY2hlIDIuMCksIHBsdXMgdGhlIGJvYXJkIGdseXBoIGRyYXduIHRvCiAgLy8gbWF0Y2ggdGhlIHRvb2xiYXIgaWNvbi4KCiAgY29uc3QgYmFyID0gKHgsIHksIHcsIGh0KSA9PgogICAgYE0ke3ggKyAxfSAke3l9aCR7dyAtIDJ9YTEgMSAwIDAgMSAxIDF2JHtodCAtIDJ9YTEgMSAwIDAgMS0xIDFoLSR7dyAtIDJ9YTEgMSAwIDAgMS0xLTF2LSR7aHQgLSAyfWExIDEgMCAwIDEgMS0xemA7CgogIGNvbnN0IElDT05TID0gewogICAgYm9hcmQ6IGJhcigzLCA0LCA1LCAxNikgKyBiYXIoOS41LCA0LCA1LCAxMCkgKyBiYXIoMTYsIDQsIDUsIDEzKSwKICAgIGNsb3NlOiAnTTE5IDYuNDEgMTcuNTkgNSAxMiAxMC41OSA2LjQxIDUgNSA2LjQxIDEwLjU5IDEyIDUgMTcuNTkgNi40MSAxOSAxMiAxMy40MSAxNy41OSAxOSAxOSAxNy41OSAxMy40MSAxMnonLAogICAgcmVmcmVzaDogJ00xNy42NSA2LjM1QTcuOTYgNy45NiAwIDAgMCAxMiA0YTggOCAwIDEgMCA3LjczIDEwaC0yLjA4QTYgNiAwIDEgMSAxMiA2YzEuNjYgMCAzLjE0LjY5IDQuMjIgMS43OEwxMyAxMWg3VjRsLTIuMzUgMi4zNXonLAogICAgYWRkOiAnTTE5IDEzaC02djZoLTJ2LTZINXYtMmg2VjVoMnY2aDZ2MnonLAogICAgbW9yZTogJ002IDEwYTIgMiAwIDEgMCAwIDQgMiAyIDAgMCAwIDAtNHptMTIgMGEyIDI",
"gMCAxIDAgMCA0IDIgMiAwIDAgMCAwLTR6bS02IDBhMiAyIDAgMSAwIDAgNCAyIDIgMCAwIDAgMC00eicsCiAgICBzdGFyOiAnTTEyIDE3LjI3IDE4LjE4IDIxbC0xLjY0LTcuMDNMMjIgOS4yNGwtNy4xOS0uNjFMMTIgMiA5LjE5IDguNjMgMiA5LjI0bDUuNDYgNC43M0w1LjgyIDIxeicsCiAgICB0dW5lOiAnTTMgMTd2Mmg2di0ySDN6TTMgNXYyaDEwVjVIM3ptMTAgMTZ2LTJoOHYtMmgtOHYtMmgtMnY2aDJ6TTcgOXYySDN2Mmg0djJoMlY5SDd6bTE0IDR2LTJIMTF2MmgxMHptLTYtNGgyVjdoNFY1aC00VjNoLTJ2NnonLAogICAgdXA6ICdNNCAxMmwxLjQxIDEuNDFMMTEgNy44M1YyMGgyVjcuODNsNS41OCA1LjU5TDIwIDEybC04LTgtOCA4eicsCiAgICBkb3duOiAnTTIwIDEybC0xLjQxLTEuNDFMMTMgMTYuMTdWNGgtMnYxMi4xN2wtNS41OC01LjU5TDQgMTJsOCA4IDgtOHonLAogICAgc2VhcmNoOiAnTTE1LjUgMTRoLS43OWwtLjI4LS4yN0E2LjQ3IDYuNDcgMCAwIDAgMTYgOS41IDYuNSA2LjUgMCAxIDAgOS41IDE2YzEuNjEgMCAzLjA5LS41OSA0LjIzLTEuNTdsLjI3LjI4di43OWw1IDQuOTlMMjAuNDkgMTlsLTQuOTktNXptLTYgMEM3LjAxIDE0IDUgMTEuOTkgNSA5LjVTNy4wMSA1IDkuNSA1IDE0IDcuMDEgMTQgOS41IDExLjk5IDE0IDkuNSAxNHonLAogICAgY2hlY2s6ICdNOSAxNi4xNyA0LjgzIDEybC0xLjQyIDEuNDFMOSAxOSAyMSA3bC0xLjQxLTEuNDF6JywKICAgIGNhcmV0OiAnTTcgMTBsNSA1IDUtNXo",
"nLAogICAgb3BlbjogJ00xOSAxOUg1VjVoN1YzSDVhMiAyIDAgMCAwLTIgMnYxNGEyIDIgMCAwIDAgMiAyaDE0YzEuMSAwIDItLjkgMi0ydi03aC0ydjd6TTE0IDN2MmgzLjU5bC05LjgzIDkuODMgMS40MSAxLjQxTDE5IDYuNDFWMTBoMlYzaC03eicsCiAgICBiYWNrOiAnTTIwIDExSDcuODNsNS41OS01LjU5TDEyIDRsLTggOCA4IDggMS40MS0xLjQxTDcuODMgMTNIMjB2LTJ6JywKICAgIGFycm93OiAnTTEyIDRsLTEuNDEgMS40MUwxNi4xNyAxMUg0djJoMTIuMTdsLTUuNTggNS41OUwxMiAyMGw4LTh6JywKICAgIHJlbW92ZTogJ00xOSAxM0g1di0yaDE0djJ6JywKICAgIG5vdGU6ICdNMTQgMkg2Yy0xLjEgMC0xLjk5LjktMS45OSAyTDQgMjBjMCAxLjEuODkgMiAxLjk5IDJIMThjMS4xIDAgMi0uOSAyLTJWOGwtNi02em0yIDE2SDh2LTJoOHYyem0wLTRIOHYtMmg4djJ6bS0zLTVWMy41TDE4LjUgOUgxM3onLAogICAgZGVsZXRlOiAnTTYgMTljMCAxLjEuOSAyIDIgMmg4YzEuMSAwIDItLjkgMi0yVjdINnYxMnpNMTkgNGgtMy41bC0xLTFoLTVsLTEgMUg1djJoMTRWNHonLAogICAgZWRpdDogJ00zIDE3LjI1VjIxaDMuNzVMMTcuODEgOS45NGwtMy43NS0zLjc1TDMgMTcuMjV6TTIwLjcxIDcuMDRhMSAxIDAgMCAwIDAtMS40MWwtMi4zNC0yLjM0YTEgMSAwIDAgMC0xLjQxIDBsLTEuODMgMS44MyAzLjc1IDMuNzUgMS44My0xLjgzeicsCiAgICBmb2xkZXI6ICdNMTAgNEg0Yy0xLjEgMC0xLjk5LjktMS45OSAyTDIgMTh",
"jMCAxLjEuOSAyIDIgMmgxNmMxLjEgMCAyLS45IDItMlY4YzAtMS4xLS45LTItMi0yaC04bC0yLTJ6JywKICAgIG5vdGVzOiAnTTMgMThoMTJ2LTJIM3Yyek0zIDZ2MmgxOFY2SDN6bTAgN2gxOHYtMkgzdjJ6JywKICAgIC8vIEZvcm1hdHRpbmcgdG9vbGJhci4KICAgIGJvbGQ6ICdNMTUuNiAxMC43OWMuOTctLjY3IDEuNjUtMS43NyAxLjY1LTIuNzkgMC0yLjI2LTEuNzUtNC00LTRIN3YxNGg3LjA0YzIuMDkgMCAzLjcxLTEuNyAzLjcxLTMuNzkgMC0xLjUyLS44Ni0yLjgyLTIuMTUtMy40MnpNMTAgNi41aDNjLjgzIDAgMS41LjY3IDEuNSAxLjVzLS42NyAxLjUtMS41IDEuNWgtM3YtM3ptMy41IDlIMTB2LTNoMy41Yy44MyAwIDEuNS42NyAxLjUgMS41cy0uNjcgMS41LTEuNSAxLjV6JywKICAgIGl0YWxpYzogJ00xMCA0djNoMi4yMWwtMy40MiA4SDZ2M2g4di0zaC0yLjIxbDMuNDItOEgxOFY0eicsCiAgICBzdHJpa2U6ICdNMTAgMTloNHYtM2gtNHYzek01IDR2M2g1djNoNFY3aDVWNEg1ek0zIDE0aDE4di0ySDN2MnonLAogICAgYnVsbGV0czogJ000IDEwLjVjLS44MyAwLTEuNS42Ny0xLjUgMS41cy42NyAxLjUgMS41IDEuNSAxLjUtLjY3IDEuNS0xLjUtLjY3LTEuNS0xLjUtMS41em0wLTZjLS44MyAwLTEuNS42Ny0xLjUgMS41UzMuMTcgNy41IDQgNy41IDUuNSA2LjgzIDUuNSA2IDQuODMgNC41IDQgNC41em0wIDEyYy0uODMgMC0xLjUuNjgtMS41IDEuNXMuNjggMS41IDEuNSAxLjUgMS41LS42OCAxLjUtMS41LS4",
"2Ny0xLjUtMS41LTEuNXpNNyAxOWgxNHYtMkg3djJ6bTAtNmgxNHYtMkg3djJ6bTAtOHYyaDE0VjVIN3onLAogICAgbnVtYmVyczogJ00yIDE3aDJ2LjVIM3YxaDF2LjVIMnYxaDN2LTRIMnYxem0xLTloMVY0SDJ2MWgxdjN6bS0xIDNoMS44TDIgMTMuMXYuOWgzdi0xSDMuMkw1IDEwLjlWMTBIMnYxem01LTZ2MmgxNFY1SDd6bTAgMTRoMTR2LTJIN3Yyem0wLTZoMTR2LTJIN3YyeicsCiAgICBjaGVja2xpc3Q6ICdNMjIgN2gtOXYyaDlWN3ptMCA4aC05djJoOXYtMnpNNS41NCAxMSAyIDcuNDZsMS40MS0xLjQxIDIuMTIgMi4xMiA0LjI0LTQuMjQgMS40MSAxLjQxTDUuNTQgMTF6bTAgOEwyIDE1LjQ2bDEuNDEtMS40MSAyLjEyIDIuMTIgNC4yNC00LjI0IDEuNDEgMS40MUw1LjU0IDE5eicsCiAgICBpbmRlbnQ6ICdNMyAyMWgxOHYtMkgzdjJ6TTMgOHY4bDQtNC00LTR6bTggOWgxMHYtMkgxMXYyek0zIDN2MmgxOFYzSDN6bTggNmgxMFY3SDExdjJ6bTAgNGgxMHYtMkgxMXYyeicsCiAgICBvdXRkZW50OiAnTTExIDE3aDEwdi0ySDExdjJ6bS04LTUgNCA0VjhsLTQgNHptMCA5aDE4di0ySDN2MnpNMyAzdjJoMThWM0gzem04IDZoMTBWN0gxMXYyem0wIDRoMTB2LTJIMTF2MnonLAogICAgbGluazogJ00zLjkgMTJjMC0xLjcxIDEuMzktMy4xIDMuMS0zLjFoNFY3SDdjLTIuNzYgMC01IDIuMjQtNSA1czIuMjQgNSA1IDVoNHYtMS45SDdjLTEuNzEgMC0zLjEtMS4zOS0zLjEtMy4xek04IDEzaDh2LTJIOHYyem05LTZoLTR2MS4",
"5aDRjMS43MSAwIDMuMSAxLjM5IDMuMSAzLjFzLTEuMzkgMy4xLTMuMSAzLjFoLTRWMTdoNGMyLjc2IDAgNS0yLjI0IDUtNXMtMi4yNC01LTUtNXonLAogICAgY2xlYXI6ICdNMy4yNyA1IDIgNi4yN2w2Ljk3IDYuOTdMNi41IDE5aDNsMS41Ny0zLjY2TDE2LjczIDIxIDE4IDE5LjczIDMuNTUgNS4yNyAzLjI3IDV6TTYgNXYuMThMOC44MiA4aDIuNGwtLjcyIDEuNjggMi4xIDIuMUwxNC4yMSA4SDIwVjVINnonLAogIH07CgogIGNvbnN0IFNWR19OUyA9ICdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zyc7CgogIGZ1bmN0aW9uIGljb24obmFtZSwgc2l6ZSA9IDIwKSB7CiAgICBjb25zdCBzdmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50TlMoU1ZHX05TLCAnc3ZnJyk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCd2aWV3Qm94JywgJzAgMCAyNCAyNCcpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnd2lkdGgnLCBTdHJpbmcoc2l6ZSkpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnaGVpZ2h0JywgU3RyaW5nKHNpemUpKTsKICAgIHN2Zy5zZXRBdHRyaWJ1dGUoJ2FyaWEtaGlkZGVuJywgJ3RydWUnKTsKICAgIHN2Zy5zZXRBdHRyaWJ1dGUoJ2ZvY3VzYWJsZScsICdmYWxzZScpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnY2xhc3MnLCAnaWNvbicpOwogICAgY29uc3QgcGF0aCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhTVkdfTlMsICdwYXRoJyk7CiAgICBwYXRoLnNldEF0dHJpYnV0ZSgnZCcsIElDT05TW25hbWVdIHx8ICcnKTs",
"KICAgIHBhdGguc2V0QXR0cmlidXRlKCdmaWxsJywgJ2N1cnJlbnRDb2xvcicpOwogICAgc3ZnLmFwcGVuZENoaWxkKHBhdGgpOwogICAgcmV0dXJuIHN2ZzsKICB9CgogIC8vIOKUgOKUgCBTaGFkb3cgaG9zdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGFkb3B0U3R5bGVzKHJvb3QsIGNzc1RleHQpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHNoZWV0ID0gbmV3IENTU1N0eWxlU2hlZXQoKTsKICAgICAgc2hlZXQucmVwbGFjZVN5bmMoY3NzVGV4dCk7CiAgICAgIHJvb3QuYWRvcHRlZFN0eWxlU2hlZXRzID0gW3NoZWV0XTsKICAgICAgcmV0dXJuOwogICAgfSBjYXRjaCB7IC8qIG9sZGVyIGVuZ2luZSBvciBhIGhvc3RpbGUgQ1NQOiBmYWxsIHRocm91Z2ggKi8gfQogICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpOwogICAgc3R5bGUudGV4dENvbnRlbnQgPSBjc3NUZXh0OwogICAgcm9vdC5hcHBlbmRDaGlsZChzdHlsZSk7CiAgfQoKICBmdW5jdGlvbiBtb3VudFNoYWRvdyhpZCwgY3NzVGV4dCkgewogICAgLy8gQSBwcmV2aW91cyBpbmplY3Rpb24gKGV4dGVuc2lvbiByZWxvYWRlZCB3aXRob3V0IHJlbG9hZGluZyB",
"HbWFpbCkKICAgIC8vIGxlYXZlcyBhbiBvcnBoYW5lZCBob3N0IGJlaGluZDsgcmVwbGFjZSBpdCByYXRoZXIgdGhhbiBzdGFjayBhIHNlY29uZC4KICAgIGNvbnN0IHN0YWxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgaWYgKHN0YWxlKSBzdGFsZS5yZW1vdmUoKTsKCiAgICBjb25zdCBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBob3N0LmlkID0gaWQ7CiAgICBjb25zdCByb290ID0gaG9zdC5hdHRhY2hTaGFkb3coeyBtb2RlOiAnb3BlbicgfSk7CiAgICBhZG9wdFN0eWxlcyhyb290LCBjc3NUZXh0KTsKCiAgICAvLyBLZXkgZXZlbnRzIGZyb20gaW5zaWRlIGEgc2hhZG93IHJvb3QgcmVhY2ggR21haWwgcmV0YXJnZXRlZCB0byB0aGUKICAgIC8vIGhvc3QsIHdoaWNoIGlzIG5vdCBhbiBpbnB1dCAtIHNvIHR5cGluZyAiYyIgaW4gb3VyIHNlYXJjaCBib3ggd291bGQKICAgIC8vIG9wZW4gR21haWwncyBDb21wb3NlLiBPdXIgb3duIGhhbmRsZXJzIGluc2lkZSB0aGUgcm9vdCBydW4gZmlyc3Q7CiAgICAvLyBzdG9wcGluZyBwcm9wYWdhdGlvbiBoZXJlIGtlZXBzIEdtYWlsJ3Mgc2hvcnRjdXRzIG91dCBvZiBpdC4KICAgIGZvciAoY29uc3QgdHlwZSBvZiBbJ2tleWRvd24nLCAna2V5cHJlc3MnLCAna2V5dXAnXSkgewogICAgICBob3N0LmFkZEV2ZW50TGlzdGVuZXIodHlwZSwgZSA9PiBlLnN0b3BQcm9wYWdhdGlvbigpKTsKICAgIH0KCiAgICAoZG9jdW1lbnQuYm9",
"keSB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQpLmFwcGVuZENoaWxkKGhvc3QpOwogICAgcmV0dXJuIHsgaG9zdCwgcm9vdCB9OwogIH0KCiAgLy8g4pSA4pSAIFRvYXN0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gdG9hc3RMYXllcihyb290KSB7CiAgICBsZXQgbGF5ZXIgPSByb290LnF1ZXJ5U2VsZWN0b3IoJy50b2FzdHMnKTsKICAgIGlmICghbGF5ZXIpIHsKICAgICAgbGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAndG9hc3RzJywgcm9sZTogJ3N0YXR1cycsICdhcmlhLWxpdmUnOiAncG9saXRlJyB9KTsKICAgICAgcm9vdC5hcHBlbmRDaGlsZChsYXllcik7CiAgICB9CiAgICByZXR1cm4gbGF5ZXI7CiAgfQoKICBmdW5jdGlvbiB0b2FzdChyb290LCBtZXNzYWdlLCB7IGtpbmQgPSAnaW5mbycsIGFjdGlvbiA9IG51bGwsIHRpbWVvdXQgfSA9IHt9KSB7CiAgICBjb25zdCBsYXllciA9IHRvYXN0TGF5ZXIocm9vdCk7CiAgICAvLyBBIG5ldyBjb25maXJtYXRpb24gcmVwbGFjZXMgdGhlIGxhc3Qgb25lIHJhdGhlciB0aGFuIHN0YWNraW5nIHVwOwogICAgLy8gZXJyb3JzIHN0YXkgdW50aWwgcmVhZCBvciB0aW1lZCB",
"vdXQuIE9uZSBzdGlsbCBvZmZlcmluZyBhbiBhY3Rpb24KICAgIC8vIChVbmRvKSBpcyBrZXB0IHRvbywgc2luY2UgaXRzIGJ1dHRvbiBtYXkgYmUgYWJvdXQgdG8gYmUgY2xpY2tlZC4KICAgIGlmIChraW5kICE9PSAnZXJyb3InKSB7CiAgICAgIGZvciAoY29uc3Qgb2xkIG9mIGxheWVyLnF1ZXJ5U2VsZWN0b3JBbGwoJy50b2FzdDpub3QoLnRvYXN0LWVycm9yKScpKSB7CiAgICAgICAgaWYgKCFvbGQucXVlcnlTZWxlY3RvcignLnRvYXN0LWFjdGlvbicpKSBvbGQucmVtb3ZlKCk7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGNsb3NlID0gKCkgPT4gZWwucmVtb3ZlKCk7CiAgICBjb25zdCBlbCA9IGgoJ2RpdicsIHsgY2xhc3M6IFsndG9hc3QnLCBraW5kID09PSAnZXJyb3InICYmICd0b2FzdC1lcnJvciddIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndG9hc3QtdGV4dCcsIHRleHQ6IG1lc3NhZ2UgfSksCiAgICAgIGFjdGlvbiAmJiBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICd0b2FzdC1hY3Rpb24nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYWN0aW9uLmxhYmVsLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgYWN0aW9uLm9uQ2xpY2soKTsgfSwKICAgICAgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICd0b2FzdC1jbG9zZSBpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdEaXNtaXNzJywgb25jbGljazogY2xvc2UgfSwKICAgICAgICBpY29uKCd",
"jbG9zZScsIDE4KSkKICAgICk7CiAgICBsYXllci5hcHBlbmRDaGlsZChlbCk7CiAgICAvLyBFcnJvcnMgc3RheSBhIGxpdHRsZSBsb25nZXI6IHRoZXkgdXN1YWxseSBuZWVkIHJlYWRpbmcsIG5vdCBnbGFuY2luZy4KICAgIHNldFRpbWVvdXQoY2xvc2UsIHRpbWVvdXQgfHwgKGtpbmQgPT09ICdlcnJvcicgPyA5MDAwIDogNTAwMCkpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIE1lbnVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gaXRlbXM6IHsgbGFiZWwsIG9uU2VsZWN0LCBpY29uPywgY2hlY2tlZD8sIGRpc2FibGVkPywgZGFuZ2VyPyB9CiAgLy8gICAgICB8IHsgaGVhZGluZyB9IHwgeyBzZXBhcmF0b3I6IHRydWUgfQoKICBjb25zdCBvcGVuTWVudXMgPSBuZXcgV2Vha01hcCgpOyAvLyByb290IOKGkiBjbG9zZSBmdW5jdGlvbgoKICBmdW5jdGlvbiBjbG9zZU1lbnUocm9vdCkgewogICAgY29uc3QgY2xvc2UgPSBvcGVuTWVudXMuZ2V0KHJvb3QpOwogICAgaWYgKGNsb3NlKSBjbG9zZSgpOwogIH0KCiAgZnVuY3Rpb24gaXNNZW51T3Blbihyb290KSB7CiAgICByZXR1cm4gb3Blbk1lbnVzLmhhcyhyb29",
"0KTsKICB9CgogIGZ1bmN0aW9uIG9wZW5NZW51KHJvb3QsIGFuY2hvciwgaXRlbXMsIHsgbGFiZWwgPSAnQWN0aW9ucycsIHBsYWNlbWVudCA9ICdiZWxvdycgfSA9IHt9KSB7CiAgICBjbG9zZU1lbnUocm9vdCk7CgogICAgY29uc3QgbWVudSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51Jywgcm9sZTogJ21lbnUnLCAnYXJpYS1sYWJlbCc6IGxhYmVsIH0pOwogICAgZm9yIChjb25zdCBpdCBvZiBpdGVtcykgewogICAgICBpZiAoaXQuc2VwYXJhdG9yKSB7IG1lbnUuYXBwZW5kQ2hpbGQoaCgnZGl2JywgeyBjbGFzczogJ21lbnUtc2VwJywgcm9sZTogJ3NlcGFyYXRvcicgfSkpOyBjb250aW51ZTsgfQogICAgICBpZiAoaXQuaGVhZGluZykgeyBtZW51LmFwcGVuZENoaWxkKGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51LWhlYWRpbmcnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScsIHRleHQ6IGl0LmhlYWRpbmcgfSkpOyBjb250aW51ZTsgfQogICAgICBjb25zdCByb2xlID0gaXQuY2hlY2tlZCA9PT0gdW5kZWZpbmVkID8gJ21lbnVpdGVtJyA6ICdtZW51aXRlbXJhZGlvJzsKICAgICAgbWVudS5hcHBlbmRDaGlsZChoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6IFsnbWVudS1pdGVtJywgaXQuZGFuZ2VyICYmICdkYW5nZXInXSwKICAgICAgICB0eXBlOiAnYnV0dG9uJywKICAgICAgICByb2xlLAogICAgICAgICdhcmlhLWNoZWNrZWQnOiBpdC5jaGVja2VkID09PSB1bmRlZmluZWQgPyBudWxsIDogU3RyaW5nKCEhaXQuY2h",
"lY2tlZCksCiAgICAgICAgZGlzYWJsZWQ6ICEhaXQuZGlzYWJsZWQsCiAgICAgICAgZGF0YXNldDogaXQua2V5ID8geyBrZXk6IGl0LmtleSB9IDogdW5kZWZpbmVkLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgaXQub25TZWxlY3QoKTsgfSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtaWNvbicgfSwgaXQuY2hlY2tlZCA_IGljb24oJ2NoZWNrJywgMTgpIDogKGl0Lmljb24gPyBpY29uKGl0Lmljb24sIDE4KSA6IG51bGwpKSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtbGFiZWwnLCB0ZXh0OiBpdC5sYWJlbCB9KQogICAgICApKTsKICAgIH0KCiAgICByb290LmFwcGVuZENoaWxkKG1lbnUpOwogICAgYW5jaG9yLnNldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsICd0cnVlJyk7CgogICAgLy8gRml4ZWQgcG9zaXRpb25pbmcgYWdhaW5zdCB0aGUgYW5jaG9yLCBmbGlwcGVkIG9yIG51ZGdlZCBzbyB0aGUgbWVudQogICAgLy8gbmV2ZXIgcnVucyBvZmYgdGhlIHZpZXdwb3J0IGVkZ2UuCiAgICBjb25zdCByID0gYW5jaG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgbXcgPSBtZW51Lm9mZnNldFdpZHRoOwogICAgY29uc3QgbWggPSBtZW51Lm9mZnNldEhlaWdodDsKICAgIGxldCBsZWZ0ID0gTWF0aC5taW4oci5sZWZ0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIG13IC0gOCk7CiAgICBpZiAoci5yaWdodCAtIG13ID4gOCAmJiBsZWZ0ICs",
"gbXcgPiB3aW5kb3cuaW5uZXJXaWR0aCAtIDgpIGxlZnQgPSByLnJpZ2h0IC0gbXc7CiAgICBsZWZ0ID0gTWF0aC5tYXgoOCwgbGVmdCk7CiAgICBsZXQgdG9wID0gcGxhY2VtZW50ID09PSAnYWJvdmUnID8gci50b3AgLSBtaCAtIDYgOiByLmJvdHRvbSArIDY7CiAgICBpZiAodG9wICsgbWggPiB3aW5kb3cuaW5uZXJIZWlnaHQgLSA4KSB0b3AgPSByLnRvcCAtIG1oIC0gNjsKICAgIGlmICh0b3AgPCA4KSB0b3AgPSA4OwogICAgbWVudS5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5yb3VuZChsZWZ0KX1weGA7CiAgICBtZW51LnN0eWxlLnRvcCA9IGAke01hdGgucm91bmQodG9wKX1weGA7CgogICAgY29uc3QgYnV0dG9ucyA9ICgpID0-IFsuLi5tZW51LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tZW51LWl0ZW06bm90KFtkaXNhYmxlZF0pJyldOwogICAgY29uc3Qgb25LZXkgPSBlID0-IHsKICAgICAgY29uc3QgbGlzdCA9IGJ1dHRvbnMoKTsKICAgICAgY29uc3QgaSA9IGxpc3QuaW5kZXhPZihyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgY2xvc2UoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93RG93bicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyAobGlzdFtpICsgMV0gfHwgbGlzdFswXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93VXAnKSB7IGUucHJldmVudER",
"lZmF1bHQoKTsgKGxpc3RbaSAtIDFdIHx8IGxpc3RbbGlzdC5sZW5ndGggLSAxXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0hvbWUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFswXSAmJiBsaXN0WzBdLmZvY3VzKCk7IH0KICAgICAgZWxzZSBpZiAoZS5rZXkgPT09ICdFbmQnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFtsaXN0Lmxlbmd0aCAtIDFdICYmIGxpc3RbbGlzdC5sZW5ndGggLSAxXS5mb2N1cygpOyB9CiAgICAgIGVsc2UgaWYgKGUua2V5ID09PSAnVGFiJykgeyBjbG9zZSgpOyB9CiAgICB9OwogICAgLy8gQ2xpY2tzIGFueXdoZXJlIGVsc2UgLSBpbiBvdXIgcm9vdCBvciBvbiBHbWFpbCBpdHNlbGYgLSBkaXNtaXNzIGl0LgogICAgY29uc3Qgb25Qb2ludGVyID0gZSA9PiB7CiAgICAgIGlmICghZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhtZW51KSAmJiAhZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhhbmNob3IpKSBjbG9zZSgpOwogICAgfTsKCiAgICAvLyBJZiB0aGUgbWVudSBoZWxkIGZvY3VzLCBpdCBnb2VzIGJhY2sgdG8gdGhlIGFuY2hvciAtIG9uIEVzYywgb24KICAgIC8vIGNob29zaW5nIGFuIGl0ZW0gKGJlZm9yZSB0aGUgYWN0aW9uIHJ1bnMsIHNvIGFuIGFjdGlvbiB0aGF0CiAgICAvLyByZS1yZW5kZXJzIGNhbiBmaW5kIHRoZSBhbmNob3IgYWdhaW4gYnkgaXRzIGRhdGEta2V5KSwgYW5kIHdoZW4gYQogICAgLy8gcmUtcmVuZGVyIGNsb3NlcyB0aGU",
"gbWVudSBmcm9tIHVuZGVybmVhdGguCiAgICBmdW5jdGlvbiBjbG9zZSgpIHsKICAgICAgaWYgKG9wZW5NZW51cy5nZXQocm9vdCkgIT09IGNsb3NlKSByZXR1cm47CiAgICAgIGNvbnN0IGhhZEZvY3VzID0gbWVudS5jb250YWlucyhyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBvcGVuTWVudXMuZGVsZXRlKHJvb3QpOwogICAgICBtZW51LnJlbW92ZSgpOwogICAgICBpZiAoaGFkRm9jdXMgJiYgYW5jaG9yLmlzQ29ubmVjdGVkKSBhbmNob3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBhbmNob3Iuc2V0QXR0cmlidXRlKCdhcmlhLWV4cGFuZGVkJywgJ2ZhbHNlJyk7CiAgICAgIG1lbnUucmVtb3ZlRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCBvblBvaW50ZXIsIHRydWUpOwogICAgfQoKICAgIG1lbnUuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgb25Qb2ludGVyLCB0cnVlKTsKICAgIG9wZW5NZW51cy5zZXQocm9vdCwgY2xvc2UpOwoKICAgIGNvbnN0IGZpcnN0ID0gYnV0dG9ucygpWzBdOwogICAgaWYgKGZpcnN0KSBmaXJzdC5mb2N1cygpOwogICAgcmV0dXJuIGNsb3NlOwogIH0KCiAgbnMudWkgPSB7IGgsIGFwcGVuZCwgaWNvbiwgbW91bnRTaGFkb3csIHRvYXN0LCBvcGVuTWVudSwgY2x",
"vc2VNZW51LCBpc01lbnVPcGVuIH07Cn0pKCk7Cg\"],[\"src/content/styles.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFN0eWxlcyBmb3IgdGhlIGluamVjdGVkIFVJCi8vCi8vIFBsYWluIHN0cmluZ3MsIGFkb3B0ZWQgaW50byBlYWNoIHNoYWRvdyByb290LiBUaGUgbG9vayBib3Jyb3dzIEdtYWlsJ3MKLy8gb3duIHZvY2FidWxhcnkgLSBHb29nbGUgU2FucywgaXRzIGJsdWUsIGl0cyBlbGV2YXRpb24gc2hhZG93cywgcGlsbAovLyBidXR0b25zIC0gc28gdGhlIGJvYXJkIHJlYWRzIGFzIHBhcnQgb2YgR21haWwgcmF0aGVyIHRoYW4gc29tZXRoaW5nCi8vIGJvbHRlZCBvbi4gRGFyayBtb2RlIGZvbGxvd3MgdGhlIG9wZXJhdGluZyBzeXN0ZW0sIGFzIGFza2VkOyBHbWFpbCdzCi8vIG93biB0aGVtZSBzZXR0aW5nIGlzIG5vdCB2aXNpYmxlIHRvIGEgY29udGVudCBzY3JpcHQgd2l0aG91dCBzY3JhcGluZy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA",
"4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CgogIC8vIOKUgOKUgCBTaGFyZWQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IEJBU0UgPSBgCjpob3N0IHsKICBhbGw6IGluaXRpYWwgIWltcG9ydGFudDsKICAvKiBBIHBvc2l0aW9uZWQgaG9zdCB3aXRoIGEgei1pbmRleCBpcyBpdHMgb3duIHN0YWNraW5nIGNvbnRleHQsIHNvCiAgICAgbWVudXMgYW5kIHRvYXN0cyBpbnNpZGUgaXQgY2FuIGxheWVyIG92ZXIgdGhlIGJvYXJkIHdpdGggc21hbGwKICAgICBudW1iZXJzIGluc3RlYWQgb2YgY29tcGV0aW5nIHdpdGggR21haWwncy4gKi8KICBwb3NpdGlvbjogcmVsYXRpdmUgIWltcG9ydGFudDsKICB6LWluZGV4OiAyMTQ3NDgzMDAwICFpbXBvcnRhbnQ7CgogIC0tYmc6ICNmNmY4ZmM7CiAgLS1iYXI6ICNmNmY4ZmM7CiAg",
"LS1jb2w6ICNlOWVlZjY7CiAgLS1zdXJmYWNlOiAjZmZmZmZmOwogIC0tbWVudTogI2ZmZmZmZjsKICAtLWZnOiAjMWYxZjFmOwogIC0tZmctMjogIzQ0NDc0NjsKICAtLWZnLTM6ICM1ZTYwNjI7CiAgLS1hY2NlbnQ6ICMwYjU3ZDA7CiAgLS1vbi1hY2NlbnQ6ICNmZmZmZmY7CiAgLS1hY2NlbnQtc29mdDogI2QzZTNmZDsKICAtLW9uLWFjY2VudC1zb2Z0OiAjMDQxZTQ5OwogIC0tYm9yZGVyOiAjZTFlM2UxOwogIC0tYm9yZGVyLXN0cm9uZzogI2M0YzdjNTsKICAtLWhvdmVyOiByZ2JhKDY4LCA3MSwgNzAsIC4wOCk7CiAgLS1wcmVzczogcmdiYSg2OCwgNzEsIDcwLCAuMTQpOwogIC0tZm9jdXM6ICMwYjU3ZDA7CiAgLS1kYW5nZXI6ICNiMzI2MWU7CiAgLS1zdGFyOiAjZThhNDAwOwogIC0taW52ZXJzZTogIzMwMzAzMDsKICAtLW9uLWludmVyc2U6ICNmMmYyZjI7CiAgLS1pbnZlcnNlLWFjY2VudDogI2E4YzdmYTsKICAtLXNjcmltOiByZ2JhKDMyLCAzMywgMzYsIC40KTsKICAtLXNoYWRvdy0xOiAwIDFweCAycHggcmdiYSg2MCwgNjQsIDY3LCAuMiksIDAgMXB4IDNweCAxcHggcmdiYSg2MCwgNjQsIDY3LCAuMSk7CiAgLS1zaGFkb3ctMjogMCAxcHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjMpLCAwIDJweCA2cHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjE1KTsKICAtLXNoYWRvdy0zOiAwIDRweCA4cHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjE1KSwgMCAxcHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjMpOwogIC0t",
"Zm9udDogIkdvb2dsZSBTYW5zIiwgUm9ib3RvLCBBcmlhbCwgc2Fucy1zZXJpZjsKICAvKiBDYXJkIGNvbG91cnM6IEdvb2dsZSdzIG93biBwYWxldHRlLCBhIHN0ZXAgbGlnaHRlciBpbiBkYXJrIG1vZGUgc28KICAgICB0aGUgc3RyaXBlIHN0aWxsIHJlYWRzIGFnYWluc3QgYSBkYXJrIGNhcmQuICovCiAgLS1jLXJlZDogI2Q5MzAyNTsKICAtLWMtb3JhbmdlOiAjZTg3MTBhOwogIC0tYy15ZWxsb3c6ICNmOWFiMDA7CiAgLS1jLWdyZWVuOiAjMWU4ZTNlOwogIC0tYy1ibHVlOiAjMWE3M2U4OwogIC0tYy1wdXJwbGU6ICM5MzM0ZTY7CiAgLS1jLWdyZXk6ICM4MDg2OGI7CiAgLS1tYXJrOiAjZmRlMjkzOwogIC0tbWFyay1jdXJyZW50OiAjZjlhYjAwOwogIC0tb24tbWFyay1jdXJyZW50OiAjMWYxZjFmOwp9CgpAbWVkaWEgKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKSB7CiAgOmhvc3QgewogICAgLS1iZzogIzEzMTMxNDsKICAgIC0tYmFyOiAjMTMxMzE0OwogICAgLS1jb2w6ICMxZTFmMjA7CiAgICAtLXN1cmZhY2U6ICMyYTJiMmQ7CiAgICAtLW1lbnU6ICMyZDJlMzA7CiAgICAtLWZnOiAjZTNlM2UzOwogICAgLS1mZy0yOiAjYzRjN2M1OwogICAgLS1mZy0zOiAjYTJhNWEzOwogICAgLS1hY2NlbnQ6ICNhOGM3ZmE7CiAgICAtLW9uLWFjY2VudDogIzA2MmU2ZjsKICAgIC0tYWNjZW50LXNvZnQ6ICMwMDRhNzc7CiAgICAtLW9uLWFjY2VudC1zb2Z0OiAjYzJlN2ZmOwogICAgLS1ib3JkZXI6ICMzYTNiM2Q7CiAg",
"ICAtLWJvcmRlci1zdHJvbmc6ICM1YzVlNjA7CiAgICAtLWhvdmVyOiByZ2JhKDIyNywgMjI3LCAyMjcsIC4wOCk7CiAgICAtLXByZXNzOiByZ2JhKDIyNywgMjI3LCAyMjcsIC4xNCk7CiAgICAtLWZvY3VzOiAjYThjN2ZhOwogICAgLS1kYW5nZXI6ICNmMmI4YjU7CiAgICAtLXN0YXI6ICNmZGQ2NjM7CiAgICAtLWludmVyc2U6ICNlM2UzZTM7CiAgICAtLW9uLWludmVyc2U6ICMxZjFmMWY7CiAgICAtLWludmVyc2UtYWNjZW50OiAjMGI1N2QwOwogICAgLS1zY3JpbTogcmdiYSgwLCAwLCAwLCAuNTUpOwogICAgLS1zaGFkb3ctMTogMCAxcHggMnB4IHJnYmEoMCwgMCwgMCwgLjUpLCAwIDFweCAzcHggMXB4IHJnYmEoMCwgMCwgMCwgLjI1KTsKICAgIC0tc2hhZG93LTI6IDAgMXB4IDNweCByZ2JhKDAsIDAsIDAsIC42KSwgMCAycHggOHB4IDJweCByZ2JhKDAsIDAsIDAsIC4zKTsKICAgIC0tc2hhZG93LTM6IDAgNHB4IDEwcHggM3B4IHJnYmEoMCwgMCwgMCwgLjQ1KSwgMCAxcHggM3B4IHJnYmEoMCwgMCwgMCwgLjYpOwogICAgLS1jLXJlZDogI2YyOGI4MjsKICAgIC0tYy1vcmFuZ2U6ICNmY2FkNzA7CiAgICAtLWMteWVsbG93OiAjZmRkNjYzOwogICAgLS1jLWdyZWVuOiAjODFjOTk1OwogICAgLS1jLWJsdWU6ICM4YWI0Zjg7CiAgICAtLWMtcHVycGxlOiAjYzU4YWY5OwogICAgLS1jLWdyZXk6ICM5YWEwYTY7CiAgICAtLW1hcms6ICM2YjU4MDA7CiAgICAtLW1hcmstY3VycmVudDogI2ZkZDY2MzsKICAgIC0tb24t",
"bWFyay1jdXJyZW50OiAjMWYxZjFmOwogIH0KfQoKKiwgKjo6YmVmb3JlLCAqOjphZnRlciB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IH0KCi8qIEF1dGhvciBkaXNwbGF5IHJ1bGVzICgucGlsbCwgLm92ZXJsYXnigKYpIHdvdWxkIG90aGVyd2lzZSBiZWF0IHRoZQogICBicm93c2VyJ3Mgb3duIFtoaWRkZW5dIHsgZGlzcGxheTogbm9uZSB9LiAqLwpbaGlkZGVuXSB7IGRpc3BsYXk6IG5vbmUgIWltcG9ydGFudDsgfQoKYnV0dG9uIHsKICBmb250OiBpbmhlcml0OwogIGNvbG9yOiBpbmhlcml0OwogIGJhY2tncm91bmQ6IG5vbmU7CiAgYm9yZGVyOiAwOwogIG1hcmdpbjogMDsKICBwYWRkaW5nOiAwOwogIGN1cnNvcjogcG9pbnRlcjsKICAtd2Via2l0LXRhcC1oaWdobGlnaHQtY29sb3I6IHRyYW5zcGFyZW50Owp9CmJ1dHRvbjpkaXNhYmxlZCB7IGN1cnNvcjogZGVmYXVsdDsgfQoKOmZvY3VzIHsgb3V0bGluZTogbm9uZTsgfQo6Zm9jdXMtdmlzaWJsZSB7IG91dGxpbmU6IDJweCBzb2xpZCB2YXIoLS1mb2N1cyk7IG91dGxpbmUtb2Zmc2V0OiAycHg7IH0KCi5pY29uIHsgZGlzcGxheTogYmxvY2s7IGZsZXg6IG5vbmU7IH0KCi5pY29uLWJ0biB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICB3aWR0aDogMzZweDsKICBoZWlnaHQ6IDM2cHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBm",
"bGV4OiBub25lOwp9Ci5pY29uLWJ0bjpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQouaWNvbi1idG46YWN0aXZlIHsgYmFja2dyb3VuZDogdmFyKC0tcHJlc3MpOyB9Ci5pY29uLWJ0bjpkaXNhYmxlZCB7IG9wYWNpdHk6IC40OyBiYWNrZ3JvdW5kOiBub25lOyB9CgouYnRuIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIGdhcDogNnB4OwogIGhlaWdodDogMzZweDsKICBwYWRkaW5nOiAwIDE4cHg7CiAgYm9yZGVyLXJhZGl1czogMThweDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjAxZW07CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouYnRuLXByaW1hcnkgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50KTsgfQouYnRuLXByaW1hcnk6aG92ZXIgeyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLmJ0bi10b25hbCB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsgfQouYnRuLXRleHQgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgcGFkZGluZzogMCAxMnB4OyB9Ci5idG4tdGV4dDpob3ZlciwgLmJ0bi10b25hbDpob3ZlciB7IGJhY2tncm91bmQtaW1hZ2U6IGxpbmVhci1ncmFkaWVudCh2YXIoLS1ob3Zl",
"ciksIHZhcigtLWhvdmVyKSk7IH0KLmJ0bjpkaXNhYmxlZCB7IG9wYWNpdHk6IC41OyBib3gtc2hhZG93OiBub25lOyB9CgovKiDilIDilIAgTWVudXMg4pSA4pSAICovCgoubWVudSB7CiAgcG9zaXRpb246IGZpeGVkOwogIHotaW5kZXg6IDIwOwogIG1pbi13aWR0aDogMjA4cHg7CiAgbWF4LXdpZHRoOiAzMjBweDsKICBtYXgtaGVpZ2h0OiA3MHZoOwogIG92ZXJmbG93LXk6IGF1dG87CiAgcGFkZGluZzogOHB4IDA7CiAgYmFja2dyb3VuZDogdmFyKC0tbWVudSk7CiAgY29sb3I6IHZhcigtLWZnKTsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTMpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKICBmb250LXNpemU6IDE0cHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7Cn0KLm1lbnUtaXRlbSB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTJweDsKICB3aWR0aDogMTAwJTsKICBtaW4taGVpZ2h0OiAzNnB4OwogIHBhZGRpbmc6IDZweCAyMHB4IDZweCAxMnB4OwogIHRleHQtYWxpZ246IGxlZnQ7Cn0KLm1lbnUtaXRlbTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQoubWVudS1pdGVtOmZvY3VzLXZpc2libGUgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IG91dGxpbmU6IDJweCBzb2xpZCB2YXIoLS1mb2N1cyk7IG91dGxpbmUtb2Zmc2V0OiAtMnB4OyB9Ci5tZW51LWl0ZW06ZGlzYWJsZWQgeyBvcGFjaXR5OiAu",
"NDU7IGJhY2tncm91bmQ6IG5vbmU7IH0KLm1lbnUtaXRlbS5kYW5nZXIgeyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgfQoubWVudS1pY29uIHsgd2lkdGg6IDE4cHg7IGhlaWdodDogMThweDsgZGlzcGxheTogaW5saW5lLWZsZXg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZmxleDogbm9uZTsgfQoubWVudS1pdGVtLmRhbmdlciAubWVudS1pY29uIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KLm1lbnUtaXRlbVthcmlhLWNoZWNrZWQ9InRydWUiXSAubWVudS1pY29uIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLm1lbnUtbGFiZWwgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9Ci5tZW51LWhlYWRpbmcgewogIHBhZGRpbmc6IDhweCAyMHB4IDRweCA0MnB4OwogIGZvbnQtc2l6ZTogMTJweDsKICBmb250LXdlaWdodDogNTAwOwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKfQoubWVudS1zZXAgeyBoZWlnaHQ6IDFweDsgbWFyZ2luOiA4cHggMDsgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsgfQoKLyog4pSA4pSAIFRvYXN0cyDilIDilIAgKi8KCi50b2FzdHMgewogIHBvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiAzMDsKICBsZWZ0OiA1MCU7CiAgYm90dG9tOiAyNHB4OwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgtNTAlKTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYWxp",
"Z24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7Cn0KLnRvYXN0IHsKICBwb2ludGVyLWV2ZW50czogYXV0bzsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA0cHg7CiAgbWluLWhlaWdodDogNDhweDsKICBtYXgtd2lkdGg6IG1pbig2MDBweCwgY2FsYygxMDB2dyAtIDMycHgpKTsKICBwYWRkaW5nOiA2cHggNnB4IDZweCAxNnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1pbnZlcnNlKTsKICBjb2xvcjogdmFyKC0tb24taW52ZXJzZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTMpOwogIGZvbnQtc2l6ZTogMTRweDsKICBsaW5lLWhlaWdodDogMjBweDsKICBhbmltYXRpb246IHRvYXN0LWluIC4xOHMgZWFzZS1vdXQ7Cn0KLnRvYXN0LWVycm9yIHsgYm9yZGVyLWxlZnQ6IDRweCBzb2xpZCAjZjI4YjgyOyBwYWRkaW5nLWxlZnQ6IDEycHg7IH0KLnRvYXN0LXRleHQgeyBmbGV4OiAxOyBwYWRkaW5nLXJpZ2h0OiA4cHg7IH0KLnRvYXN0LWFjdGlvbiB7CiAgaGVpZ2h0OiAzNnB4OwogIHBhZGRpbmc6IDAgMTJweDsKICBib3JkZXItcmFkaXVzOiAxOHB4OwogIGNvbG9yOiB2YXIoLS1pbnZlcnNlLWFjY2VudCk7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwp9Ci50b2FzdC1hY3Rpb246aG92ZXIgeyBiYWNrZ3JvdW5k",
"OiByZ2JhKDEyOCwgMTI4LCAxMjgsIC4xNik7IH0KLnRvYXN0LWNsb3NlIHsgY29sb3I6IGluaGVyaXQ7IG9wYWNpdHk6IC44OyB9Ci50b2FzdC1jbG9zZTpob3ZlciB7IGJhY2tncm91bmQ6IHJnYmEoMTI4LCAxMjgsIDEyOCwgLjE2KTsgY29sb3I6IGluaGVyaXQ7IH0KQGtleWZyYW1lcyB0b2FzdC1pbiB7IGZyb20geyBvcGFjaXR5OiAwOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoOHB4KTsgfSB0byB7IG9wYWNpdHk6IDE7IHRyYW5zZm9ybTogbm9uZTsgfSB9CgpAbWVkaWEgKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246IHJlZHVjZSkgewogICosICo6OmJlZm9yZSwgKjo6YWZ0ZXIgeyBhbmltYXRpb246IG5vbmUgIWltcG9ydGFudDsgdHJhbnNpdGlvbjogbm9uZSAhaW1wb3J0YW50OyB9Cn0KYDsKCiAgLy8g4pSA4pSAIEJvYXJkIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBCT0FSRCA9IGAKLm92ZXJsYXkgewogIHBvc2l0aW9uOiBmaXhlZDsKICBpbnNldDogMDsKICB6LWluZGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgY29sb3I6IHZh",
"cigtLWZnKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGxpbmUtaGVpZ2h0OiAxLjQ7CiAgLXdlYmtpdC1mb250LXNtb290aGluZzogYW50aWFsaWFzZWQ7Cn0KLm92ZXJsYXlbaGlkZGVuXSB7IGRpc3BsYXk6IG5vbmU7IH0KCi5iYXIgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDRweDsKICBoZWlnaHQ6IDY0cHg7CiAgcGFkZGluZzogMCAxMnB4IDAgMjBweDsKICBmbGV4OiBub25lOwogIGJhY2tncm91bmQ6IHZhcigtLWJhcik7Cn0KLmJyYW5kIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAxMHB4OwogIG1hcmdpbjogMDsKICBmb250LXNpemU6IDIycHg7CiAgZm9udC13ZWlnaHQ6IDQwMDsKICBjb2xvcjogdmFyKC0tZmcpOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmJyYW5kIC5sb2dvIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLmJyYW5kIC5kaW0geyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmFjY291bnQgewogIG1hcmdpbi1sZWZ0OiAxNHB4OwogIHBhZGRpbmc6IDRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDE0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEzcHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIG1p",
"bi13aWR0aDogMDsKfQouc3BhY2VyIHsgZmxleDogMTsgfQoudXBkYXRlZCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxMnB4OyB3aGl0ZS1zcGFjZTogbm93cmFwOyBtYXJnaW4tcmlnaHQ6IDJweDsgfQoKLyog4pSA4pSAIFRhYnM6IEJvYXJkIHwgTm90ZXMg4pSA4pSAICovCgoudGFicyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IDJweDsKICBtYXJnaW4tbGVmdDogMThweDsKICBwYWRkaW5nOiAzcHg7CiAgYm9yZGVyLXJhZGl1czogMjBweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7Cn0KLnRhYiB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCAxNHB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKfQoudGFiOmhvdmVyIHsgY29sb3I6IHZhcigtLWZnKTsgfQoudGFiW2FyaWEtc2VsZWN0ZWQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBjb2xvcjogdmFyKC0tZmcpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLnRhYlthcmlhLXNlbGVjdGVkPSJ0cnVlIl0gLmljb24geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouc3Bpbm5pbmcgLmljb24geyBhbmltYXRpb246IHNwaW4gLjlzIGxpbmVhciBpbmZpbml0ZTsgfQpAa2V5ZnJh",
"bWVzIHNwaW4geyB0byB7IHRyYW5zZm9ybTogcm90YXRlKDM2MGRlZyk7IH0gfQoKLmJvZHkgeyBmbGV4OiAxOyBkaXNwbGF5OiBmbGV4OyBtaW4taGVpZ2h0OiAwOyB9CgouY29sdW1ucyB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMTJweDsKICBwYWRkaW5nOiA0cHggMjBweCAyMHB4OwogIG92ZXJmbG93LXg6IGF1dG87CiAgb3ZlcmZsb3cteTogaGlkZGVuOwogIG1pbi1oZWlnaHQ6IDA7Cn0KLmNvbHVtbiB7CiAgZmxleDogMSAwIDI4MHB4OwogIG1pbi13aWR0aDogMjgwcHg7CiAgbWF4LXdpZHRoOiA0MDBweDsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLWhlaWdodDogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJzOwp9Ci5jb2x1bW4uZHJvcC10YXJnZXQgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgfQouY29sLWhlYWQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMHB4IDZweCA2cHggMTZweDsKICBmbGV4OiBub25lOwp9Ci5jb2wtdGl0bGUgewogIG1hcmdpbjogMDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmcpOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxs",
"aXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouY29sLWNvdW50IHsKICBmbGV4OiBub25lOwogIG1pbi13aWR0aDogMjJweDsKICBwYWRkaW5nOiAwIDdweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9Ci5jb2wtZmxhZyB7CiAgZmxleDogbm9uZTsKICBwYWRkaW5nOiAwIDhweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDExcHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7Cn0KLmNvbC1oZWFkIC5zcGFjZXIgeyBtaW4td2lkdGg6IDRweDsgfQouY29sLW5vdGUgeyBwYWRkaW5nOiAwIDE2cHggNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZmxleDogbm9uZTsgfQoKLmxpc3QgewogIGZsZXg6IDE7CiAgbWluLWhlaWdodDogNzJweDsKICBvdmVyZmxvdy15OiBhdXRvOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiA0cHggOHB4IDEycHg7CiAgc2Nyb2xsYmFyLXdpZHRoOiB0aGluOwp9Ci5saXN0OmVtcHR5OjphZnRlciB7CiAgY29udGVudDogYXR0cihkYXRhLWVtcHR5KTsKICBk",
"aXNwbGF5OiBibG9jazsKICBtYXJnaW46IDJweCAwOwogIHBhZGRpbmc6IDIycHggMTJweDsKICBib3JkZXI6IDEuNXB4IGRhc2hlZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDEzcHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9CgovKiDilIDilIAgQ2FyZHMg4pSA4pSAICovCgouY2FyZCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGZsZXg6IG5vbmU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7CiAgY3Vyc29yOiBncmFiOwogIHRyYW5zaXRpb246IGJveC1zaGFkb3cgLjE1czsKfQouY2FyZDpob3ZlciB7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0yKTsgfQouY2FyZC5kcmFnZ2luZyB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhcmQubGlmdGluZyB7IG9wYWNpdHk6IC41OyB9Ci5jYXJkLW1haW4gewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDEwcHggMTRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBjdXJzb3I6IGluaGVyaXQ7Cn0KLmNhcmQtbWFpbjpmb2N1cy12aXNpYmxlIHsgb3V0bGluZS1vZmZzZXQ6IC0ycHg7IH0KLmNhcmQtdG9wIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2",
"cHg7CiAgbWluLWhlaWdodDogMjBweDsKICBmb250LXNpemU6IDEzcHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5kb3QgeyB3aWR0aDogOHB4OyBoZWlnaHQ6IDhweDsgYm9yZGVyLXJhZGl1czogNTAlOyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBmbGV4OiBub25lOyB9Ci5mcm9tIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZGF0ZSB7IGZsZXg6IG5vbmU7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jYXJkOmhvdmVyIC5kYXRlLCAuY2FyZDpmb2N1cy13aXRoaW4gLmRhdGUgeyB2aXNpYmlsaXR5OiBoaWRkZW47IH0KLnN1YmplY3Qtcm93IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg7IG1hcmdpbi10b3A6IDNweDsgfQouc3ViamVjdCB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIGZvbnQtc2l6ZTogMTRweDsKICBjb2xvcjogdmFyKC0tZmcpOwp9Ci51bnJlYWQgLmZyb20sIC51bnJlYWQgLnN1YmplY3QgeyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5zdGFyIHsgY29sb3I6IHZhcigtLXN0YXIpOyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgZmxleDogbm9uZTsgfQou",
"Y291bnQgewogIGZsZXg6IG5vbmU7CiAgcGFkZGluZzogMCA2cHg7CiAgYm9yZGVyLXJhZGl1czogOXB4OwogIGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxMXB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGluZS1oZWlnaHQ6IDE4cHg7Cn0KLmRyYWZ0IHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTJweDsgfQouc25pcHBldCB7CiAgbWFyZ2luLXRvcDogM3B4OwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMThweDsKICBjb2xvcjogdmFyKC0tZmctMyk7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydGljYWw7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKfQouY2FyZC1ub3RlIHsKICBtYXJnaW4tdG9wOiA0cHg7CiAgcGFkZGluZy1sZWZ0OiA4cHg7CiAgYm9yZGVyLWxlZnQ6IDJweCBzb2xpZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIHdoaXRlLXNwYWNlOiBwcmUtbGluZTsKICBkaXNwbGF5OiAtd2Via2l0LWJveDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDM7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICBvdmVyZmxvdzogaGlkZGVuOwogIG92",
"ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9CgpbZGF0YS1jb2xvdXI9InJlZCJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcmVkKTsgfQpbZGF0YS1jb2xvdXI9Im9yYW5nZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtb3JhbmdlKTsgfQpbZGF0YS1jb2xvdXI9InllbGxvdyJdIHsgLS1zdHJpcGU6IHZhcigtLWMteWVsbG93KTsgfQpbZGF0YS1jb2xvdXI9ImdyZWVuIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ncmVlbik7IH0KW2RhdGEtY29sb3VyPSJibHVlIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ibHVlKTsgfQpbZGF0YS1jb2xvdXI9InB1cnBsZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcHVycGxlKTsgfQpbZGF0YS1jb2xvdXI9ImdyZXkiXSB7IC0tc3RyaXBlOiB2YXIoLS1jLWdyZXkpOyB9Ci5jYXJkW2RhdGEtY29sb3VyXTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiAwOwogIGJvdHRvbTogMDsKICBsZWZ0OiAwOwogIHdpZHRoOiA2cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweCAwIDAgMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdHJpcGUpOwogIHBvaW50ZXItZXZlbnRzOiBub25lOwp9Ci5jYXJkW2RhdGEtY29sb3VyXSAuY2FyZC1tYWluIHsgcGFkZGluZy1sZWZ0OiAxOHB4OyB9CgouY2FyZC1tZW51IHsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiA0cHg7CiAgcmlnaHQ6IDRweDsKICB3aWR0aDogMzJweDsKICBoZWlnaHQ6IDMycHg7CiAgb3BhY2l0eTogMDsK",
"ICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKfQouY2FyZC1tZW51OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5jYXJkOmhvdmVyIC5jYXJkLW1lbnUsIC5jYXJkOmZvY3VzLXdpdGhpbiAuY2FyZC1tZW51LCAuY2FyZC1tZW51W2FyaWEtZXhwYW5kZWQ9InRydWUiXSB7IG9wYWNpdHk6IDE7IH0KQG1lZGlhIChob3Zlcjogbm9uZSkgeyAuY2FyZC1tZW51IHsgb3BhY2l0eTogMTsgfSAuY2FyZCAuZGF0ZSB7IHZpc2liaWxpdHk6IHZpc2libGU7IH0gfQoKLnBsYWNlaG9sZGVyIHsKICBmbGV4OiBub25lOwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYm9yZGVyOiAycHggZGFzaGVkIHZhcigtLWFjY2VudCk7CiAgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWFjY2VudCkgMTAlLCB0cmFuc3BhcmVudCk7Cn0KCi5za2VsZXRvbiB7CiAgZmxleDogbm9uZTsKICBoZWlnaHQ6IDkycHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBvcGFjaXR5OiAuNTU7CiAgYW5pbWF0aW9uOiBwdWxzZSAxLjRzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgcHVsc2UgeyA1MCUgeyBvcGFjaXR5OiAuMzsgfSB9CgovKiDilIDilIAgQ29sdW1uIHNlYXJjaCDilIDilIAgKi8KCi5zZWFyY2ggewogIGZsZXg6IG5vbmU7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGdhcDogNnB4OwogIG1h",
"eC1oZWlnaHQ6IDU1JTsKICBtaW4taGVpZ2h0OiAwOwogIG1hcmdpbjogMCA4cHggOHB4OwogIHBhZGRpbmc6IDhweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0yKTsKfQouc2VhcmNoLWJveCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNnB4OwogIGhlaWdodDogNDBweDsKICBwYWRkaW5nOiAwIDJweCAwIDEycHg7CiAgYm9yZGVyLXJhZGl1czogMjBweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmbGV4OiBub25lOwp9Ci5zZWFyY2gtYm94OmZvY3VzLXdpdGhpbiB7IG91dGxpbmU6IDJweCBzb2xpZCB2YXIoLS1mb2N1cyk7IH0KLnNlYXJjaC1ib3ggaW5wdXQgewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIGhlaWdodDogMTAwJTsKICBib3JkZXI6IDA7CiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7CiAgY29sb3I6IHZhcigtLWZnKTsKICBmb250OiBpbmhlcml0OwogIGZvbnQtc2l6ZTogMTRweDsKfQouc2VhcmNoLWJveCBpbnB1dDo6cGxhY2Vob2xkZXIgeyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLnNlYXJjaC1ib3ggaW5wdXQ6Zm9jdXMtdmlzaWJsZSB7IG91dGxpbmU6IG5vbmU7IH0KLnNlYXJjaC1oaW50IHsgcGFkZGluZzogMCA4cHg7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyBmbGV4",
"OiBub25lOyB9Ci5yZXN1bHRzIHsgb3ZlcmZsb3cteTogYXV0bzsgbWluLWhlaWdodDogMDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAycHg7IHNjcm9sbGJhci13aWR0aDogdGhpbjsgfQoucmVzdWx0IHsKICBkaXNwbGF5OiBibG9jazsKICB3aWR0aDogMTAwJTsKICBwYWRkaW5nOiA3cHggMTBweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKfQoucmVzdWx0OmhvdmVyOm5vdCg6ZGlzYWJsZWQpIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5yZXN1bHQ6ZGlzYWJsZWQgeyBvcGFjaXR5OiAuNTU7IH0KLnItdG9wIHsgZGlzcGxheTogZmxleDsgZ2FwOiA2cHg7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTIpOyB9Ci5yLXRvcCAuZnJvbSB7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLnItc3ViamVjdCB7CiAgZGlzcGxheTogYmxvY2s7CiAgZm9udC1zaXplOiAxM3B4OwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwp9Ci5yLXdoZXJlIHsgZGlzcGxheTogYmxvY2s7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWFjY2VudCk7IG1hcmdpbi10b3A6IDFweDsgfQoucmVzdWx0OmRpc2FibGVkIC5yLXdoZXJlIHsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5yZXN1bHRzLWVtcHR5IHsgcGFkZGluZzogMTJweCA4cHg7",
"IGZvbnQtc2l6ZTogMTNweDsgY29sb3I6IHZhcigtLWZnLTMpOyB0ZXh0LWFsaWduOiBjZW50ZXI7IH0KCi8qIOKUgOKUgCBTdGF0dXMgcGFuZWxzIOKUgOKUgCAqLwoKLnBhbmVsIHsKICBtYXJnaW46IGF1dG87CiAgd2lkdGg6IG1pbig0NjBweCwgY2FsYygxMDB2dyAtIDQ4cHgpKTsKICBwYWRkaW5nOiAzNnB4IDMycHggMzJweDsKICBib3JkZXItcmFkaXVzOiAyOHB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0xKTsKICB0ZXh0LWFsaWduOiBjZW50ZXI7Cn0KLnBhbmVsIC5wYW5lbC1pY29uIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIHdpZHRoOiA1NnB4OwogIGhlaWdodDogNTZweDsKICBib3JkZXItcmFkaXVzOiA1MCU7CiAgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOwogIGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7Cn0KLnBhbmVsIGgyIHsgbWFyZ2luOiAxNnB4IDAgOHB4OyBmb250LXNpemU6IDIycHg7IGZvbnQtd2VpZ2h0OiA0MDA7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLnBhbmVsIHAgeyBtYXJnaW46IDAgMCAyMHB4OyBjb2xvcjogdmFyKC0tZmctMik7IGxpbmUtaGVpZ2h0OiAxLjU7IH0KLnBhbmVsIC5hY3Rpb25zIHsgZGlzcGxheTogZmxleDsgZ2FwOiA4cHg7IGp1c3RpZnktY29udGVudDogY2VudGVyOyB9CgovKiDilIDilIAg",
"Tm90ZXMg4pSA4pSAICovCgoubm90ZXMgewogIGZsZXg6IDE7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IDEycHg7CiAgbWluLXdpZHRoOiAwOwogIG1pbi1oZWlnaHQ6IDA7CiAgcGFkZGluZzogNHB4IDIwcHggMjBweDsKfQoubm90ZXMtZm9sZGVycyB7CiAgZmxleDogMCAwIDIzMHB4OwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAwOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tY29sKTsKfQouZm9sZGVycy1oZWFkIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA0cHg7IHBhZGRpbmc6IDEwcHggNnB4IDRweCAxNnB4OyBmbGV4OiBub25lOyB9Ci5mb2xkZXJzLWhlYWQgaDIgeyBtYXJnaW46IDA7IGZsZXg6IDE7IGZvbnQtc2l6ZTogMTNweDsgZm9udC13ZWlnaHQ6IDUwMDsgY29sb3I6IHZhcigtLWZnLTIpOyBsZXR0ZXItc3BhY2luZzogLjAyZW07IH0KLmZvbGRlci1pdGVtcyB7IGZsZXg6IDE7IG92ZXJmbG93LXk6IGF1dG87IHBhZGRpbmc6IDJweCA4cHggMTBweDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAxcHg7IH0KLmZvbGRlci1yb3cgeyBwb3NpdGlvbjogcmVsYXRpdmU7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGJvcmRlci1yYWRpdXM6IDEwcHg7IHBhZGRpbmctbGVmdDogY2FsYyh2YXIoLS1kZXB0aCwgMCkgKiAxNnB4KTsg",
"fQouZm9sZGVyLXJvdy5kcm9wIHsgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMnB4IHZhcigtLWFjY2VudCk7IGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1hY2NlbnQpIDEwJSwgdHJhbnNwYXJlbnQpOyB9Ci5mb2xkZXItYnRuIHsKICBmbGV4OiAxOwogIG1pbi13aWR0aDogMDsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgaGVpZ2h0OiAzNnB4OwogIHBhZGRpbmc6IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxMHB4OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDE0cHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKfQouZm9sZGVyLWJ0bjpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQouZm9sZGVyLWJ0blthcmlhLWN1cnJlbnQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQouZm9sZGVyLWJ0biAuaWNvbiB7IGNvbG9yOiBpbmhlcml0OyBvcGFjaXR5OiAuODU7IH0KLmZvbGRlci10aXRsZSB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IHdoaXRlLXNwYWNlOiBub3dyYXA7IH0KLmZvbGRlci1jb3VudCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IGluaGVyaXQ7IG9wYWNpdHk6IC43NTsgZm9u",
"dC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtczsgfQouZm9sZGVyLW1lbnUgeyBwb3NpdGlvbjogYWJzb2x1dGU7IHJpZ2h0OiAycHg7IHdpZHRoOiAzMHB4OyBoZWlnaHQ6IDMwcHg7IG9wYWNpdHk6IDA7IGJhY2tncm91bmQ6IHZhcigtLWNvbCk7IH0KLmZvbGRlci1yb3c6aG92ZXIgLmZvbGRlci1tZW51LCAuZm9sZGVyLXJvdzpmb2N1cy13aXRoaW4gLmZvbGRlci1tZW51LCAuZm9sZGVyLW1lbnVbYXJpYS1leHBhbmRlZD0idHJ1ZSJdIHsgb3BhY2l0eTogMTsgfQouZm9sZGVyLXJvdzpob3ZlciAuZm9sZGVyLWNvdW50LCAuZm9sZGVyLXJvdzpmb2N1cy13aXRoaW4gLmZvbGRlci1jb3VudCB7IHZpc2liaWxpdHk6IGhpZGRlbjsgfQouZm9sZGVyLXJvdzpoYXMoLmZvbGRlci1idG5bYXJpYS1jdXJyZW50PSJ0cnVlIl0pIC5mb2xkZXItbWVudSB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsgfQouZm9sZGVyLXJvdy5lZGl0aW5nIHsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgYWxpZ24taXRlbXM6IHN0cmV0Y2g7IHBhZGRpbmctdG9wOiAycHg7IHBhZGRpbmctYm90dG9tOiAycHg7IH0KLmZvbGRlci1lZGl0IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IHBhZGRpbmctbGVmdDogMTBweDsgY29sb3I6IHZhcigtLWZnLTIpOyB9Ci5mb2xkZXItaW5wdXQgeyBoZWlnaHQ6IDM0cHg7IGZsZXg6IDE7IG1pbi13",
"aWR0aDogMDsgfQouZm9sZGVyLWVycm9yIHsgcGFkZGluZzogNHB4IDRweCAycHggMzZweDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgfQoubm90ZXMtc2NvcGUgeyBmbGV4OiBub25lOyBwYWRkaW5nOiAwIDIwcHggNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IH0KLm5vdGVzLWxpc3QgewogIGZsZXg6IDAgMCAzMjBweDsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLWhlaWdodDogMDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7Cn0KLm5vdGVzLXRvb2xzIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IHBhZGRpbmc6IDEycHggMTJweCA4cHg7IGZsZXg6IG5vbmU7IH0KLm5vdGVzLXRvb2xzIC5zZWFyY2gtYm94IHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsgfQoubm90ZXMtdG9vbHMgLmJ0biB7IGhlaWdodDogNDBweDsgcGFkZGluZzogMCAxNnB4IDAgMTJweDsgZmxleDogbm9uZTsgfQoubm90ZXMtaXRlbXMgeyBmbGV4OiAxOyBvdmVyZmxvdy15OiBhdXRvOyBwYWRkaW5nOiAwIDhweCA4cHg7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMnB4",
"OyB9Ci5ub3RlLWl0ZW0gewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDEwcHggMTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIHRleHQtYWxpZ246IGxlZnQ7Cn0KLm5vdGUtaXRlbTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQoubm90ZS1pdGVtW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0xKTsgfQoubmktdG9wIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGJhc2VsaW5lOyBnYXA6IDhweDsgfQoubmktdGl0bGUgewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmcpOwp9Ci5uaS1zbmlwcGV0IHsKICBkaXNwbGF5OiAtd2Via2l0LWJveDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDI7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICBvdmVyZmxvdzogaGlkZGVuOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwogIG1hcmdpbi10b3A6IDJweDsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTMpOwp9Ci5uaS1tZXRhIHsgZGlzcGxheTogZmxleDsgZmxleC13cmFwOiB3",
"cmFwOyBnYXA6IDRweCAxMHB4OyBtYXJnaW4tdG9wOiAzcHg7IH0KLm5pLW1ldGE6ZW1wdHkgeyBkaXNwbGF5OiBub25lOyB9Ci5uaS1mb2xkZXIgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAzcHg7IGZvbnQtc2l6ZTogMTFweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5uaS1tYWlsIHsgZm9udC1zaXplOiAxMXB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouZHJhZ2dpbmctbm90ZSAubm90ZS1pdGVtW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYm94LXNoYWRvdzogbm9uZTsgfQoubmUtZm9sZGVyIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNHB4OwogIGhlaWdodDogMzJweDsKICBtYXgtd2lkdGg6IDI2MHB4OwogIG1hcmdpbi1yaWdodDogNHB4OwogIHBhZGRpbmc6IDAgNHB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEzcHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQoubmUtZm9sZGVyIHNwYW4geyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgfQoubmUtZm9sZGVyOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci8qIFNlYXJjaDogdGhlIHdvcmRzIG1hcmtlZCBpbiByZXN1bHRzLCBhbmQgaW4gdGhlIG9wZW4gbm90ZS4gKi8KbWFyayB7IGJhY2tncm91",
"bmQ6IHZhcigtLW1hcmspOyBjb2xvcjogaW5oZXJpdDsgYm9yZGVyLXJhZGl1czogMnB4OyBwYWRkaW5nOiAwIDFweDsgfQovKiBPbmx5IHRoZSBwaG9uZSBhcHAsIHdoaWNoIHNob3dzIG9uZSBwYW5lIGF0IGEgdGltZSwgbmVlZHMgYSB3YXkgYmFjaywKICAgYW5kIGEgYnV0dG9uIHRvIGZvbGQgdGhlIGZvbGRlciB0cmVlIGF3YXkuICovCi5uZS1iYWNrLCAuZm9sZGVycy10b2dnbGUgeyBkaXNwbGF5OiBub25lOyB9Ci5uaS1leGNlcnB0cyB7IGRpc3BsYXk6IGJsb2NrOyBtYXJnaW4tdG9wOiAzcHg7IH0KLm5pLWV4Y2VycHQgewogIGRpc3BsYXk6IGJsb2NrOwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMThweDsKICBjb2xvcjogdmFyKC0tZmctMyk7CiAgb3ZlcmZsb3ctd3JhcDogYW55d2hlcmU7Cn0KLm5pLWV4Y2VycHQgKyAubmktZXhjZXJwdCB7IG1hcmdpbi10b3A6IDNweDsgfQoubmktZXhjZXJwdCBtYXJrLCAubmktc25pcHBldCBtYXJrLCAubmktdGl0bGUgbWFyayB7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLm5pLWhpdHMgeyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBmb250LXdlaWdodDogNTAwOyB9Cjo6aGlnaGxpZ2h0KGdrYi1tYXRjaCkgeyBiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1tYXJrKTsgfQo6OmhpZ2hsaWdodChna2ItbWF0Y2gtY3VycmVudCkgeyBiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1tYXJrLWN1cnJlbnQpOyBjb2xvcjogdmFyKC0tb24tbWFy",
"ay1jdXJyZW50KTsgfQoubmUtZmluZCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNnB4OwogIG1hcmdpbjogNHB4IDIwcHggMDsKICBwYWRkaW5nOiAycHggNHB4IDJweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tY29sKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxM3B4OwogIGZsZXg6IG5vbmU7Cn0KLm5lLWZpbmQgLmZpbmQtd29yZHMgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5uZS1maW5kIC5maW5kLXBvcyB7IHdoaXRlLXNwYWNlOiBub3dyYXA7IGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7IH0KLm5lLWZpbmQgLmljb24tYnRuIHsgd2lkdGg6IDMycHg7IGhlaWdodDogMzJweDsgfQoubm90ZXMtZW1wdHkgeyBwYWRkaW5nOiAyNHB4IDEycHg7IHRleHQtYWxpZ246IGNlbnRlcjsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLm5vdGVzLWVtcHR5IHAgeyBtYXJnaW46IDAgMCA4cHg7IH0KLm5vdGVzLWZvb3QgeyBmbGV4OiBub25lOyBwYWRkaW5nOiA4cHggMTZweCAxMnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubm90ZXMtZm9vdDplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0K",
"Ci5ub3RlLWVkaXRvciB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOwp9Ci5uZS1iYXIgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDRweDsgcGFkZGluZzogOHB4IDEwcHggMCAyOHB4OyBmbGV4OiBub25lOyBtaW4taGVpZ2h0OiA0OHB4OyB9Ci5uZS1zdGF0dXMgeyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IG1pbi13aWR0aDogMDsgfQoubmUtc3RhdHVzLmVycm9yIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KLm5lLWJhbm5lciB7CiAgbWFyZ2luOiA0cHggMjhweCAwOwogIHBhZGRpbmc6IDEwcHggMTRweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsKICBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMS40NTsKICBmbGV4OiBub25lOwp9Ci5uZS10aXRsZSB7CiAgYm9yZGVyOiAwOwogIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1mYW1pbHk6IHZh",
"cigtLWZvbnQpOwp9Ci5uZS10aXRsZSB7IGZsZXg6IG5vbmU7IHBhZGRpbmc6IDhweCAyOHB4IDZweDsgZm9udC1zaXplOiAyNHB4OyBsaW5lLWhlaWdodDogMS4zOyB9Ci5uZS1ib2R5IHsKICBwb3NpdGlvbjogcmVsYXRpdmU7CiAgZmxleDogMTsKICBtaW4taGVpZ2h0OiAwOwogIG92ZXJmbG93LXk6IGF1dG87CiAgcGFkZGluZzogMTBweCAyOHB4IDI4cHg7CiAgZm9udC1zaXplOiAxNXB4OwogIGxpbmUtaGVpZ2h0OiAxLjY7CiAgd2hpdGUtc3BhY2U6IHByZS13cmFwOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwogIG91dGxpbmU6IG5vbmU7CiAgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOwp9Ci5uZS10aXRsZTo6cGxhY2Vob2xkZXIgeyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLm5lLXRpdGxlOmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiBub25lOyB9Ci5uZS10aXRsZTpkaXNhYmxlZCwgLm5lLWJvZHlbYXJpYS1kaXNhYmxlZD0idHJ1ZSJdIHsgb3BhY2l0eTogLjY7IH0KLm5lLWJvZHlbZGF0YS1lbXB0eT0iMSJdOjpiZWZvcmUgewogIGNvbnRlbnQ6IGF0dHIoZGF0YS1wbGFjZWhvbGRlcik7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHRvcDogMTBweDsKICBsZWZ0OiAyOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKfQoKLyogQmxvY2tzOiBvbmUgcGVyIHBhcmFncmFwaCwgaGVhZGluZyBvciBsaXN0IGl0ZW0uIEJ1bGxldHMsIG51bWJlcnMgYW5kCiAg",
"IGJveGVzIGFyZSBkcmF3biBoZXJlLCBpbiBlYWNoIGJsb2NrJ3MgbGVmdCBwYWRkaW5nLiAqLwouYmxrIHsgcG9zaXRpb246IHJlbGF0aXZlOyBtaW4taGVpZ2h0OiAxLjZlbTsgLS1sdmw6IDA7IH0KLmJsa1tkYXRhLWxldmVsPSIxIl0geyAtLWx2bDogMTsgfQouYmxrW2RhdGEtbGV2ZWw9IjIiXSB7IC0tbHZsOiAyOyB9Ci5ibGtbZGF0YS1sZXZlbD0iMyJdIHsgLS1sdmw6IDM7IH0KLmJsa1tkYXRhLXR5cGU9ImgxIl0geyBmb250LXNpemU6IDI0cHg7IGxpbmUtaGVpZ2h0OiAxLjM7IGZvbnQtd2VpZ2h0OiA2MDA7IG1hcmdpbjogMTRweCAwIDRweDsgfQouYmxrW2RhdGEtdHlwZT0iaDIiXSB7IGZvbnQtc2l6ZTogMjBweDsgbGluZS1oZWlnaHQ6IDEuMzU7IGZvbnQtd2VpZ2h0OiA2MDA7IG1hcmdpbjogMTJweCAwIDJweDsgfQouYmxrW2RhdGEtdHlwZT0iaDMiXSB7IGZvbnQtc2l6ZTogMTdweDsgbGluZS1oZWlnaHQ6IDEuNDsgZm9udC13ZWlnaHQ6IDYwMDsgbWFyZ2luOiAxMHB4IDAgMnB4OyB9Ci5ibGs6Zmlyc3QtY2hpbGQgeyBtYXJnaW4tdG9wOiAwOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdLCAuYmxrW2RhdGEtdHlwZT0ib2wiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl0geyBwYWRkaW5nLWxlZnQ6IGNhbGMoMjhweCArIHZhcigtLWx2bCkgKiAyNHB4KTsgfQouYmxrW2RhdGEtdHlwZT0idWwiXTo6YmVmb3JlIHsKICBjb250ZW50OiAnXFwyMDIyJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgbGVmdDog",
"Y2FsYyg5cHggKyB2YXIoLS1sdmwpICogMjRweCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjEiXTo6YmVmb3JlIHsgY29udGVudDogJ1xcMjVFNic7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMiJdOjpiZWZvcmUsIC5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjMiXTo6YmVmb3JlIHsgY29udGVudDogJ1xcMjVBQSc7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl06OmJlZm9yZSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGModmFyKC0tbHZsKSAqIDI0cHgpOwogIHdpZHRoOiAyMnB4OwogIHRleHQtYWxpZ246IHJpZ2h0OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOwp9Ci8qIE51bWJlcmluZyByZXN0YXJ0cyB3aGVuZXZlciB0aGUgcnVuIG9mIG51bWJlcmVkIGl0ZW1zIGF0IGEgbGV2ZWwgaXMKICAgYnJva2VuIGJ5IGFueXRoaW5nIHNoYWxsb3dlciBvciBieSBhIG5vbi1saXN0IGJsb2NrLiAqLwouYmxrOm5vdChbZGF0YS10eXBlPSJ1bCJdKTpub3QoW2RhdGEtdHlwZT0ib2wiXSk6bm90KFtkYXRhLXR5cGU9ImNoZWNrIl0pIHsgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjAiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMCJdIHsgY291bnRlci1y",
"ZXNldDogb2wwIG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjEiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMSJdIHsgY291bnRlci1yZXNldDogb2wxIG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMiJdLCAuYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWxldmVsPSIyIl0geyBjb3VudGVyLXJlc2V0OiBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdW2RhdGEtbGV2ZWw9IjMiXSwgLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1sZXZlbD0iMyJdIHsgY291bnRlci1yZXNldDogb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjAiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDA7IGNvdW50ZXItcmVzZXQ6IG9sMSBvbDIgb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjEiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDE7IGNvdW50ZXItcmVzZXQ6IG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMiJdIHsgY291bnRlci1pbmNyZW1lbnQ6IG9sMjsgY291bnRlci1yZXNldDogb2wzOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjMiXSB7IGNvdW50ZXItaW5jcmVtZW50OiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMCJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMCkgJy4nOyB9",
"Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjEiXTo6YmVmb3JlIHsgY29udGVudDogY291bnRlcihvbDEsIGxvd2VyLWFscGhhKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMiJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMiwgbG93ZXItcm9tYW4pICcuJzsgfQouYmxrW2RhdGEtdHlwZT0ib2wiXVtkYXRhLWxldmVsPSIzIl06OmJlZm9yZSB7IGNvbnRlbnQ6IGNvdW50ZXIob2wzKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl06OmJlZm9yZSB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGMoM3B4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOwogIHRvcDogY2FsYyguOGVtIC0gOXB4KTsKICB3aWR0aDogMTRweDsKICBoZWlnaHQ6IDE0cHg7CiAgYm9yZGVyOiAycHggc29saWQgdmFyKC0tZmctMyk7CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGN1cnNvcjogcG9pbnRlcjsKfQouYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWNoZWNrZWQ9IjEiXTo6YmVmb3JlIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5ibGtbZGF0YS10eXBlPSJjaGVjayJdW2RhdGEtY2hlY2tlZD0iMSJdOjphZnRlciB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGMoOXB4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOwogIHRvcDogY2FsYyguOGVt",
"IC0gN3B4KTsKICB3aWR0aDogNXB4OwogIGhlaWdodDogMTBweDsKICBib3JkZXI6IHNvbGlkIHZhcigtLW9uLWFjY2VudCk7CiAgYm9yZGVyLXdpZHRoOiAwIDJweCAycHggMDsKICB0cmFuc2Zvcm06IHJvdGF0ZSg0NWRlZyk7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7Cn0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1jaGVja2VkPSIxIl0geyBjb2xvcjogdmFyKC0tZmctMyk7IHRleHQtZGVjb3JhdGlvbjogbGluZS10aHJvdWdoOyB9Ci5uZS1ib2R5IGEgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7IGN1cnNvcjogdGV4dDsgfQoKLyogRm9ybWF0dGluZyB0b29sYmFyIGFuZCB0aGUgbGluayBmaWVsZCBiZW5lYXRoIGl0LiAqLwoubmUtdG9vbGJhciB7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LXdyYXA6IHdyYXA7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBtYXJnaW46IDJweCAyMHB4IDA7CiAgcGFkZGluZzogNHB4IDZweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgZmxleDogbm9uZTsKfQoudGItYnRuIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIHdpZHRoOiAzMnB4OwogIGhlaWdodDogMzJweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci50Yi1idG46",
"aG92ZXI6bm90KDpkaXNhYmxlZCksIC50Yi1zdHlsZTpob3Zlcjpub3QoOmRpc2FibGVkKSB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQoudGItYnRuW2FyaWEtcHJlc3NlZD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci50Yi1idG46ZGlzYWJsZWQsIC50Yi1zdHlsZTpkaXNhYmxlZCB7IG9wYWNpdHk6IC40OyB9Ci50Yi1zdHlsZSB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCA0cHggMCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNTAwOwp9Ci50Yi1zdHlsZS1sYWJlbCB7IG1pbi13aWR0aDogODRweDsgdGV4dC1hbGlnbjogbGVmdDsgfQoudGItc2VwIHsgd2lkdGg6IDFweDsgaGVpZ2h0OiAyMHB4OyBtYXJnaW46IDAgNnB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1ib3JkZXItc3Ryb25nKTsgb3BhY2l0eTogLjY7IH0KLm5lLWxpbmtiYXIgewogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC13cmFwOiB3cmFwOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgbWFyZ2luOiA2cHggMjBweCAwOwogIHBhZGRpbmc6IDZweCA4cHggNnB4IDEycHg7CiAgYm9yZGVyLXJhZGl1",
"czogMTJweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmbGV4OiBub25lOwp9Ci5uZS1saW5rYmFyIC50ZXh0LWlucHV0IHsgZmxleDogMTsgbWluLXdpZHRoOiAxODBweDsgaGVpZ2h0OiAzNHB4OyB9Ci5uZS1saW5rYmFyIC5idG4geyBoZWlnaHQ6IDM0cHg7IH0KLmxpbmstZXJyb3IgeyBmbGV4LWJhc2lzOiAxMDAlOyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgZm9udC1zaXplOiAxMnB4OyB9Ci5saW5rLWVycm9yOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQoubm90ZXMtaW50cm8geyBtYXJnaW46IGF1dG87IG1heC13aWR0aDogNDQwcHg7IHBhZGRpbmc6IDMycHg7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoubm90ZXMtaW50cm8gLnBhbmVsLWljb24gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDU2cHg7CiAgaGVpZ2h0OiA1NnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7CiAgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsKfQoubm90ZXMtaW50cm8gaDIgeyBtYXJnaW46IDE2cHggMCA4cHg7IGZvbnQtc2l6ZTogMjJweDsgZm9udC13ZWlnaHQ6IDQwMDsgfQoubm90ZXMtaW50cm8gcCB7IG1hcmdpbjogMCAwIDIwcHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgbGluZS1oZWlnaHQ6IDEuNTsg",
"fQoKLyog4pSA4pSAIENvbHVtbiBzZXR0aW5ncyBkcmF3ZXIg4pSA4pSAICovCgouc2NyaW0geyBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOyB6LWluZGV4OiA1OyBiYWNrZ3JvdW5kOiB2YXIoLS1zY3JpbSk7IH0KLmRyYXdlciB7CiAgcG9zaXRpb246IGZpeGVkOwogIHotaW5kZXg6IDY7CiAgdG9wOiAwOwogIHJpZ2h0OiAwOwogIGJvdHRvbTogMDsKICB3aWR0aDogbWluKDQ2MHB4LCAxMDB2dyk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTMpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKICBmb250LXNpemU6IDE0cHg7CiAgYW5pbWF0aW9uOiBkcmF3ZXItaW4gLjE4cyBlYXNlLW91dDsKfQpAa2V5ZnJhbWVzIGRyYXdlci1pbiB7IGZyb20geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMjRweCk7IG9wYWNpdHk6IDA7IH0gdG8geyB0cmFuc2Zvcm06IG5vbmU7IG9wYWNpdHk6IDE7IH0gfQouZHJhd2VyLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgcGFkZGluZzogMTJweCAxMnB4IDRweCAyNHB4OyBmbGV4OiBub25lOyB9Ci5kcmF3ZXItaGVhZCBoMiB7IG1hcmdpbjogMDsgZmxleDogMTsgZm9udC1zaXplOiAyMHB4OyBmb250LXdlaWdodDogNDAwOyB9Ci5kcmF3ZXItaW50cm8geyBtYXJn",
"aW46IDA7IHBhZGRpbmc6IDAgMjRweCAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IGZvbnQtc2l6ZTogMTNweDsgbGluZS1oZWlnaHQ6IDEuNTsgZmxleDogbm9uZTsgfQouZHJhd2VyLWJvZHkgeyBmbGV4OiAxOyBvdmVyZmxvdy15OiBhdXRvOyBwYWRkaW5nOiA0cHggMjRweCAxNnB4OyB9Ci5jb2wtcm93IHsKICBkaXNwbGF5OiBncmlkOwogIGdhcDogMTBweDsKICBtYXJnaW4tYm90dG9tOiAxMnB4OwogIHBhZGRpbmc6IDEycHggMTJweCAxMHB4IDE0cHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5yb3ctaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMnB4OyB9Ci5yb3ctaGVhZCAucm93LW51bSB7CiAgd2lkdGg6IDIycHg7CiAgaGVpZ2h0OiAyMnB4OwogIG1hcmdpbi1yaWdodDogOHB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwogIGZsZXg6IG5vbmU7Cn0KLnJvdy1oZWFkIC5yb3ctdGl0bGUgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IGZvbnQtd2VpZ2h0OiA1MDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFj",
"ZTogbm93cmFwOyB9Ci5maWVsZCB7IGRpc3BsYXk6IGdyaWQ7IGdhcDogNHB4OyB9Ci5maWVsZC1sYWJlbCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTIpOyB9Ci50ZXh0LWlucHV0IHsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDM4cHg7CiAgcGFkZGluZzogMCAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQ6IGluaGVyaXQ7CiAgZm9udC1zaXplOiAxNHB4Owp9Ci50ZXh0LWlucHV0OmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogLTFweDsgYm9yZGVyLWNvbG9yOiB0cmFuc3BhcmVudDsgfQouZmllbGQtaGVscCB7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jaGVjayB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMik7IGN1cnNvcjogcG9pbnRlcjsgfQouY2hlY2sgaW5wdXQgeyB3aWR0aDogMThweDsgaGVpZ2h0OiAxOHB4OyBtYXJnaW46IDA7IGFjY2VudC1jb2xvcjogdmFyKC0tYWNjZW50KTsgfQouYWRkLWNvbCB7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDQ0cHg7IGJvcmRlci1yYWRpdXM6IDE2cHg7IGJvcmRlcjogMS41",
"cHggZGFzaGVkIHZhcigtLWJvcmRlci1zdHJvbmcpOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQouYWRkLWNvbDpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQouZHJhd2VyLWZvb3QgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMnB4IDIwcHggMTZweCAyNHB4OwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGZsZXg6IG5vbmU7Cn0KLmRyYXdlci1mb290IC5ub3RlIHsgZmxleDogMTsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGxpbmUtaGVpZ2h0OiAxLjQ1OyB9Ci5mb3JtLWVycm9yIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTNweDsgcGFkZGluZzogMCAyNHB4IDhweDsgZmxleDogbm9uZTsgfQouZm9ybS1lcnJvcjplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KCi8qIOKUgOKUgCBDYXJkIGVkaXRvciDilIDilIAgKi8KCi5kaWFsb2cgewogIHBvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiA2OwogIHRvcDogNTAlOwogIGxlZnQ6IDUwJTsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTAlLCAtNTAlKTsKICB3aWR0aDogbWluKDQ4MHB4LCBjYWxjKDEwMHZ3IC0gMzJweCkpOwogIG1heC1oZWlnaHQ6IGNhbGMoMTAwdmggLSAzMnB4KTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYm9yZGVy",
"LXJhZGl1czogMjRweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmcpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGFuaW1hdGlvbjogZGlhbG9nLWluIC4xNnMgZWFzZS1vdXQ7Cn0KQGtleWZyYW1lcyBkaWFsb2ctaW4geyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGUoLTUwJSwgLTQ3JSk7IH0gdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTAlLCAtNTAlKTsgfSB9Ci5kaWFsb2ctaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nOiAxNHB4IDEycHggMnB4IDI0cHg7IGZsZXg6IG5vbmU7IH0KLmRpYWxvZy1oZWFkIGgyIHsgbWFyZ2luOiAwOyBmbGV4OiAxOyBmb250LXNpemU6IDIwcHg7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLmRpYWxvZy1ib2R5IHsgZGlzcGxheTogZ3JpZDsgZ2FwOiAxOHB4OyBwYWRkaW5nOiAxMHB4IDI0cHggMThweDsgb3ZlcmZsb3cteTogYXV0bzsgfQouZGlhbG9nLWZvb3QgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMnB4IDIwcHggMTZweCAyNHB4OwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGZsZXg6IG5vbmU7Cn0KLmRpYWxvZy1mb290IC5u",
"b3RlIHsgZmxleDogMTsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IGxpbmUtaGVpZ2h0OiAxLjQ1OyB9Ci50ZXh0LWFyZWEgeyBoZWlnaHQ6IGF1dG87IG1pbi1oZWlnaHQ6IDgwcHg7IHBhZGRpbmc6IDlweCAxMnB4OyBsaW5lLWhlaWdodDogMS40NTsgcmVzaXplOiB2ZXJ0aWNhbDsgfQouaGVscC1yb3cgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogYmFzZWxpbmU7IGdhcDogNHB4IDEwcHg7IGZsZXgtd3JhcDogd3JhcDsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmhlbHAtcm93IC5zdWJqZWN0LXJlZiB7IGNvbG9yOiB2YXIoLS1mZy0yKTsgb3ZlcmZsb3ctd3JhcDogYW55d2hlcmU7IH0KLmxpbmstYnRuIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IGZvbnQtc2l6ZTogMTJweDsgZm9udC13ZWlnaHQ6IDUwMDsgYm9yZGVyLXJhZGl1czogNHB4OyB9Ci5saW5rLWJ0bjpob3ZlciB7IHRleHQtZGVjb3JhdGlvbjogdW5kZXJsaW5lOyB9Ci5zd2F0Y2hlcyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiAxMHB4OyBwYWRkaW5nOiAycHggMDsgfQouc3dhdGNoIHsgcG9zaXRpb246IHJlbGF0aXZlOyB3aWR0aDogMjhweDsgaGVpZ2h0OiAyOHB4OyBjdXJzb3I6IHBvaW50ZXI7IH0KLnN3YXRjaCBpbnB1dCB7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgaW5zZXQ6IDA7IHdpZHRoOiAxMDAlOyBoZWlnaHQ6IDEwMCU7IG1hcmdpbjogMDsgb3BhY2l0eTog",
"MDsgY3Vyc29yOiBwb2ludGVyOyB9Ci5zd2F0Y2gtZG90IHsKICBkaXNwbGF5OiBibG9jazsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDEwMCU7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLXN0cmlwZSk7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJzOwp9Ci5zd2F0Y2hbZGF0YS1jb2xvdXI9Im5vbmUiXSAuc3dhdGNoLWRvdCB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgdHJhbnNwYXJlbnQgNDUlLCB2YXIoLS1ib3JkZXItc3Ryb25nKSA0NSUsIHZhcigtLWJvcmRlci1zdHJvbmcpIDU1JSwgdHJhbnNwYXJlbnQgNTUlKSwgdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMS41cHggdmFyKC0tYm9yZGVyLXN0cm9uZyk7Cn0KLnN3YXRjaCBpbnB1dDpjaGVja2VkICsgLnN3YXRjaC1kb3QgeyBib3gtc2hhZG93OiAwIDAgMCAycHggdmFyKC0tc3VyZmFjZSksIDAgMCAwIDRweCB2YXIoLS1mZy0yKTsgfQouc3dhdGNoW2RhdGEtY29sb3VyPSJub25lIl0gaW5wdXQ6Y2hlY2tlZCArIC5zd2F0Y2gtZG90IHsKICBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxLjVweCB2YXIoLS1ib3JkZXItc3Ryb25nKSwgMCAwIDAgMnB4IHZhcigtLXN1cmZhY2UpLCAwIDAgMCA0cHggdmFyKC0tZmctMik7Cn0KLnN3YXRjaCBpbnB1dDpmb2N1cy12aXNpYmxlICsgLnN3YXRjaC1kb3QgeyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBv",
"dXRsaW5lLW9mZnNldDogNXB4OyB9Cgouc3Itb25seSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHdpZHRoOiAxcHg7CiAgaGVpZ2h0OiAxcHg7CiAgcGFkZGluZzogMDsKICBtYXJnaW46IC0xcHg7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBjbGlwOiByZWN0KDAgMCAwIDApOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgYm9yZGVyOiAwOwp9CmA7CgogIC8vIOKUgOKUgCBEb2NrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBET0NLID0gYAo6aG9zdCB7IHotaW5kZXg6IDIxNDc0ODI5OTkgIWltcG9ydGFudDsgfQoKLmRvY2sgewogIHBvc2l0aW9uOiBmaXhlZDsKICBsZWZ0OiAxNnB4OwogIGJvdHRvbTogMTZweDsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwogIGZvbnQtc2l6ZTogMTRweDsKICAtd2Via2l0LWZvbnQtc21vb3RoaW5nOiBhbnRpYWxpYXNlZDsKfQouZG9jay5yaWdodCB7IGxlZnQ6IGF1dG87IHJpZ2h0OiA3MnB4OyB9Ci5kb2NrW2hpZGRlbl0geyBkaXNwbGF5OiBub25lOyB9Ci5waWxsIHsKICBkaXNwbGF5",
"OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNnB4OwogIGhlaWdodDogNDBweDsKICBwYWRkaW5nOiAwIDE2cHggMCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDIwcHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgY29sb3I6IHZhcigtLWZnKTsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMik7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIG1heC13aWR0aDogMzIwcHg7Cn0KLnBpbGw6aG92ZXIgeyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMyk7IGJhY2tncm91bmQtaW1hZ2U6IGxpbmVhci1ncmFkaWVudCh2YXIoLS1ob3ZlciksIHZhcigtLWhvdmVyKSk7IH0KLnBpbGwgLmljb24geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQoucGlsbC5vbiB7IGJhY2tncm91bmQtY29sb3I6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsgfQoucGlsbC5vbiAuaWNvbiB7IGNvbG9yOiBpbmhlcml0OyB9Ci5waWxsIC5waWxsLWxhYmVsIHsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IH0KLnBpbGwgLmNhcmV0IHsgbWFyZ2luOiAwIC02cHggMCAtMnB4OyBjb2xvcjogaW5oZXJpdDsgfQoucGlsbC1jb21wYWN0IHsgcGFkZGluZzogMCAxNHB4IDAgMTBweDsgfQoucGlsbC5idXN5IHsgb3BhY2l0eTogLjc7IH0KYDsKCiAgbnMuc3R5bGVzID0geyBib2FyZDogQkFTRSArIEJP",
"QVJELCBkb2NrOiBCQVNFICsgRE9DSyB9Owp9KSgpOwo\"],[\"src/content/note-editor.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBmb3JtYXR0ZWQgbm90ZSBlZGl0b3IKLy8KLy8gQW4gZWRpdGFibGUgYXJlYSB3aXRoIGEgdG9vbGJhcjogdGV4dCBzdHlsZSAobm9ybWFsLCB0aHJlZSBoZWFkaW5ncyksCi8vIGJvbGQsIGl0YWxpYywgc3RyaWtlLXRocm91Z2gsIGJ1bGxldGVkLCBudW1iZXJlZCBhbmQgY2hlY2sgbGlzdHMgd2l0aAovLyB0aHJlZSBsZXZlbHMgb2YgbmVzdGluZywgbGlua3MsIGFuZCBjbGVhciBmb3JtYXR0aW5nLgovLwovLyBUaGUgZWRpdGFibGUgYXJlYSBpcyBhIGZsYXQgY29sdW1uIG9mIGJsb2NrcyAtIG9uZSA8ZGl2IGNsYXNzPSJibGsiPgovLyBwZXIgcGFyYWdyYXBoLCBoZWFkaW5nIG9yIGxpc3QgaXRlbSwgaXRzIGtpbmQgYW5kIGluZGVudCBpbiBkYXRhCi8vIGF0dHJpYnV0ZXMsIGJ1bGxldHMsIG51bWJlcnMgYW5kIGJveGVzIGRyYXduIGJ5IHRoZSBzdHlsZXNoZWV0LiBCb2xkLAovLyBpdGFsaWMsIHN0cmlrZS10aHJvdWdoIGFuZCB",
"saW5rcyB1c2UgdGhlIGJyb3dzZXIncyBvd24gZWRpdGluZwovLyBjb21tYW5kcywgd2hpY2ggaGFuZGxlIHRoZW0gd2VsbC4gTGlzdHMgYW5kIGhlYWRpbmdzIGRvIG5vdCB1c2UgdGhlbToKLy8gdGhlIGJyb3dzZXIncyBsaXN0IGNvbW1hbmRzIG5lc3QgZWxlbWVudHMgaW4gd2F5cyB0aGF0IGFyZSBoYXJkIHRvIHJlYWQKLy8gYmFjaywgc28gYmxvY2tzIGFyZSByZXN0eWxlZCBoZXJlIGRpcmVjdGx5IGluc3RlYWQuIFdoYXQgaXMgc2F2ZWQgaXMKLy8gbmV2ZXIgdGhpcyBtYXJrdXA6IGl0IGlzIHJlYWQgYmFjayBpbnRvIHRoZSBub3RlLWZvcm1hdCBtb2RlbCwgd2hpY2gKLy8gb25seSBrbm93cyB3aGF0IHRoZSB0b29sYmFyIGNhbiBtYWtlLgovLwovLyBQYXN0ZWQgdGV4dCBrZWVwcyB0aGUgZm9ybWF0dGluZyB0aGUgbW9kZWwgY2FuIGhvbGQgLSBmcm9tIFdvcmQsIEdvb2dsZQovLyBEb2NzLCBhIHdlYiBwYWdlLCBhbiBlbWFpbCwgRXhjZWwsIG9yIE1hcmtkb3duIGZyb20gYSBjaGF0IGFzc2lzdGFudCAtCi8vIHJlYWQgYnkgbm90ZS1mb3JtYXQncyBvd24gcmVhZGVyLCBzbyBhIHBhZ2UgY29waWVkIGZyb20gdGhlIHdlYiBicmluZ3MKLy8gaXRzIGJvbGQgYW5kIGxpc3RzIGJ1dCBuZXZlciBpdHMgc3R5bGVzLCBpbWFnZXMgb3Igc2NyaXB0cy4gQ3RybCtTaGlmdCtWCi8vIHBhc3RlcyB0aGUgdGV4dCBhbG9uZS4gRHJvcHBlZCB0ZXh0IGlzIG5vdCB0YWtlbiBhdCBhbGwuCi8vIOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgb3Blbk1lbnUsIGNsb3NlTWVudSB9ID0gbnMudWk7CiAgY29uc3QgZm10ID0gbnMubm90ZUZvcm1hdDsKCiAgY29uc3QgU1RZTEVTID0gW1sncCcsICdOb3JtYWwgdGV4dCddLCBbJ2gxJywgJ0hlYWRpbmcgMSddLCBbJ2gyJywgJ0hlYWRpbmcgMiddLCBbJ2gzJywgJ0hlYWRpbmcgMyddXTsKICBjb25zdCBTVFlMRV9MQUJFTCA9IE9iamVjdC5mcm9tRW50cmllcyhTVFlMRVMpOwogIGNvbnN0IElOREVOVF9QWCA9IDI0OwoKICAvLyBUeXBlZCBhdCB0aGUgc3RhcnQgb2YgYSBwYXJhZ3JhcGggYW5kIGZvbGxvd2VkIGJ5IGEgc3BhY2UsIHRoZXNlIHR1cm4KICAvLyBpdCBpbnRvIGEgbGlzdCBvciBoZWFkaW5nIC0gdGhlIHNob3J0Y3V0cyBtb3N0IGVkaXRvcnMgc2hhcmUuCiAgY29uc3QgQVVUTyA9IFsKICAgIFsvXlstKuKAol0kLywgeyB0eXBlOiAndWwnIH1dLAogICAgWy9eMVsuKV0kLywgeyB",
"0eXBlOiAnb2wnIH1dLAogICAgWy9eXFsgP1xdJC8sIHsgdHlwZTogJ2NoZWNrJyB9XSwKICAgIFsvXlxbW3hYXVxdJC8sIHsgdHlwZTogJ2NoZWNrJywgY2hlY2tlZDogdHJ1ZSB9XSwKICAgIFsvXiMkLywgeyB0eXBlOiAnaDEnIH1dLAogICAgWy9eIyMkLywgeyB0eXBlOiAnaDInIH1dLAogICAgWy9eIyMjJC8sIHsgdHlwZTogJ2gzJyB9XSwKICBdOwoKICAvLyDilIDilIAgTW9kZWwg4oaUIG1hcmt1cCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gc2V0QmxvY2soZWwsIHR5cGUsIGxldmVsID0gMCwgY2hlY2tlZCA9IGZhbHNlKSB7CiAgICBlbC5kYXRhc2V0LnR5cGUgPSB0eXBlOwogICAgaWYgKGZtdC5MSVNUUy5oYXModHlwZSkpIGVsLmRhdGFzZXQubGV2ZWwgPSBTdHJpbmcobGV2ZWwpOwogICAgZWxzZSBkZWxldGUgZWwuZGF0YXNldC5sZXZlbDsKICAgIGlmICh0eXBlID09PSAnY2hlY2snKSBlbC5kYXRhc2V0LmNoZWNrZWQgPSBjaGVja2VkID8gJzEnIDogJzAnOwogICAgZWxzZSBkZWxldGUgZWwuZGF0YXNldC5jaGVja2VkOwogIH0KCiAgZnVuY3Rpb24gaW5saW5lTm9kZXMocnVucykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID0gMDs",
"gaSA8IHJ1bnMubGVuZ3RoOykgewogICAgICBjb25zdCBocmVmID0gcnVuc1tpXS5ocmVmIHx8ICcnOwogICAgICBjb25zdCBncm91cCA9IFtdOwogICAgICBsZXQgaiA9IGk7CiAgICAgIHdoaWxlIChqIDwgcnVucy5sZW5ndGggJiYgKHJ1bnNbal0uaHJlZiB8fCAnJykgPT09IGhyZWYpIHsKICAgICAgICBsZXQgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHJ1bnNbal0udGV4dCk7CiAgICAgICAgZm9yIChjb25zdCBtIG9mIFsncycsICdpJywgJ2InXSkgewogICAgICAgICAgaWYgKCFydW5zW2pdW21dKSBjb250aW51ZTsKICAgICAgICAgIGNvbnN0IHcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KG0pOwogICAgICAgICAgdy5hcHBlbmRDaGlsZChub2RlKTsKICAgICAgICAgIG5vZGUgPSB3OwogICAgICAgIH0KICAgICAgICBncm91cC5wdXNoKG5vZGUpOwogICAgICAgIGorKzsKICAgICAgfQogICAgICBpZiAoaHJlZikgb3V0LnB1c2goaCgnYScsIHsgaHJlZiwgdGl0bGU6IGhyZWYgfSwgZ3JvdXApKTsKICAgICAgZWxzZSBvdXQucHVzaCguLi5ncm91cCk7CiAgICAgIGkgPSBqOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJsb2NrRWwoYikgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIGVsLmNsYXNzTmFtZSA9ICdibGsnOwogICAgc2V0QmxvY2soZWwsIGIudHlwZSwgYi5sZXZlbCwgYi5jaGVja2VkKTsKICAgIGNvbnN0IGtpZHM",
"gPSBpbmxpbmVOb2RlcyhiLnJ1bnMpOwogICAgaWYgKGtpZHMubGVuZ3RoKSBlbC5hcHBlbmQoLi4ua2lkcyk7CiAgICBlbHNlIGVsLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2JyJykpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgZnVuY3Rpb24gc3R5bGVNYXJrcyhzdHlsZSkgewogICAgY29uc3QgcyA9IFN0cmluZyhzdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgIHJldHVybiB7CiAgICAgIGI6IC9mb250LXdlaWdodFxzKjpccyooYm9sZHxib2xkZXJ8WzYtOV0wMCkvLnRlc3QocyksCiAgICAgIGk6IC9mb250LXN0eWxlXHMqOlxzKml0YWxpYy8udGVzdChzKSwKICAgICAgczogL3RleHQtZGVjb3JhdGlvbigtbGluZSk_XHMqOlteO10qbGluZS10aHJvdWdoLy50ZXN0KHMpLAogICAgfTsKICB9CgogIGNvbnN0IE5FU1RFRF9CTE9DS1MgPSBuZXcgU2V0KFsnZGl2JywgJ3AnLCAnbGknLCAndWwnLCAnb2wnLCAnaDEnLCAnaDInLCAnaDMnLCAnaDQnLCAnaDUnLCAnaDYnLCAnYmxvY2txdW90ZScsICdwcmUnXSk7CgogIC8vIFJlYWRzIG9uZSBibG9jayBlbGVtZW50IC0gYW5kIGFueXRoaW5nIHRoZSBicm93c2VyIG1heSBoYXZlIGxlZnQKICAvLyBpbnNpZGUgaXQsIHN1Y2ggYXMgYSA8YnI-IG9yIGEgbmVzdGVkIDxkaXY-IC0gaW50byBtb2RlbCBibG9ja3MuCiAgZnVuY3Rpb24gcmVhZEJsb2NrKGVsLCBvdXQpIHsKICAgIGNvbnN0IHR5cGUgPSBmbXQuVFlQRVMuaGFzKGVsLmRhdGFzZXQ",
"udHlwZSkgPyBlbC5kYXRhc2V0LnR5cGUgOiAncCc7CiAgICBjb25zdCBsZXZlbCA9IE51bWJlcihlbC5kYXRhc2V0LmxldmVsKSB8fCAwOwogICAgY29uc3QgZmlyc3QgPSBvdXQubGVuZ3RoOwogICAgbGV0IGN1ciA9IGZtdC5ibG9jayh0eXBlLCBbXSwgeyBsZXZlbCwgY2hlY2tlZDogZWwuZGF0YXNldC5jaGVja2VkID09PSAnMScgfSk7CiAgICBvdXQucHVzaChjdXIpOwogICAgY29uc3QgbmV4dCA9ICgpID0-IHsKICAgICAgY3VyID0gZm10LmJsb2NrKHR5cGUsIFtdLCB7IGxldmVsIH0pOwogICAgICBvdXQucHVzaChjdXIpOwogICAgfTsKICAgIChmdW5jdGlvbiB3YWxrKG5vZGUsIG1hcmtzKSB7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZE5vZGVzKSB7CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlID09PSAzKSB7CiAgICAgICAgICBpZiAoY2hpbGQuZGF0YSkgY3VyLnJ1bnMucHVzaCh7IHRleHQ6IGNoaWxkLmRhdGEucmVwbGFjZSgvXHUwMGEwL2csICcgJykucmVwbGFjZSgvXG4vZywgJyAnKSwgLi4ubWFya3MgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlICE9PSAxKSBjb250aW51ZTsKICAgICAgICBjb25zdCB0YWcgPSBjaGlsZC50YWdOYW1lLnRvTG93ZXJDYXNlKCk7CiAgICAgICAgaWYgKHRhZyA9PT0gJ2JyJykgeyBuZXh0KCk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKE5FU1RFRF9CTE9DS1MuaGFzKHRhZykpIHs",
"KICAgICAgICAgIGlmIChjdXIucnVucy5sZW5ndGgpIG5leHQoKTsKICAgICAgICAgIHdhbGsoY2hpbGQsIG1hcmtzKTsKICAgICAgICAgIG5leHQoKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBjb25zdCBtID0geyAuLi5tYXJrcyB9OwogICAgICAgIGlmICh0YWcgPT09ICdiJyB8fCB0YWcgPT09ICdzdHJvbmcnKSBtLmIgPSB0cnVlOwogICAgICAgIGVsc2UgaWYgKHRhZyA9PT0gJ2knIHx8IHRhZyA9PT0gJ2VtJykgbS5pID0gdHJ1ZTsKICAgICAgICBlbHNlIGlmICh0YWcgPT09ICdzJyB8fCB0YWcgPT09ICdzdHJpa2UnIHx8IHRhZyA9PT0gJ2RlbCcpIG0ucyA9IHRydWU7CiAgICAgICAgZWxzZSBpZiAodGFnID09PSAnYScpIHsKICAgICAgICAgIGNvbnN0IGhyZWYgPSBmbXQuc2FmZUhyZWYoY2hpbGQuZ2V0QXR0cmlidXRlKCdocmVmJykpOwogICAgICAgICAgaWYgKGhyZWYpIG0uaHJlZiA9IGhyZWY7CiAgICAgICAgfSBlbHNlIGlmICh0YWcgPT09ICdzcGFuJyB8fCB0YWcgPT09ICdmb250JykgewogICAgICAgICAgY29uc3Qgc3QgPSBzdHlsZU1hcmtzKGNoaWxkLmdldEF0dHJpYnV0ZSgnc3R5bGUnKSk7CiAgICAgICAgICBpZiAoc3QuYikgbS5iID0gdHJ1ZTsKICAgICAgICAgIGlmIChzdC5pKSBtLmkgPSB0cnVlOwogICAgICAgICAgaWYgKHN0LnMpIG0ucyA9IHRydWU7CiAgICAgICAgfQogICAgICAgIHdhbGsoY2hpbGQsIG0pOwogICAgICB9CiAgICB9KShlbCwge30pOwogICA",
"gLy8gQSA8YnI-IG9yIG5lc3RlZCBibG9jayBhdCB0aGUgdmVyeSBlbmQgbGVhdmVzIGFuIGVtcHR5IGJsb2NrIGJlaGluZDoKICAgIC8vIHRoYXQgaXMgdGhlIGJyb3dzZXIncyBwbGFjZWhvbGRlciwgbm90IGEgbmV3IGxpbmUuCiAgICB3aGlsZSAob3V0Lmxlbmd0aCAtIDEgPiBmaXJzdCAmJiAhb3V0W291dC5sZW5ndGggLSAxXS5ydW5zLnNvbWUociA9PiByLnRleHQpKSBvdXQucG9wKCk7CiAgfQoKICBmdW5jdGlvbiByZWFkRG9jKGVkaXRvcikgewogICAgY29uc3QgYmxvY2tzID0gW107CiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZWRpdG9yLmNoaWxkTm9kZXMpIHsKICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS5jbGFzc0xpc3QuY29udGFpbnMoJ2JsaycpKSByZWFkQmxvY2sobm9kZSwgYmxvY2tzKTsKICAgICAgZWxzZSBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMyAmJiBub2RlLmRhdGEudHJpbSgpKSBibG9ja3MucHVzaChmbXQuYmxvY2soJ3AnLCBbeyB0ZXh0OiBub2RlLmRhdGEucmVwbGFjZSgvwqAvZywgJyAnKSB9XSkpOwogICAgICBlbHNlIGlmIChub2RlLm5vZGVUeXBlID09PSAxICYmIG5vZGUudGFnTmFtZSAhPT0gJ0JSJykgcmVhZEJsb2NrKG5vZGUsIGJsb2Nrcyk7CiAgICB9CiAgICByZXR1cm4gZm10Lm5vcm1hbGlzZURvYyhibG9ja3MpOwogIH0KCiAgLy8g4pSA4pSAIFNlbGVjdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gY3JlYXRlKHsgcm9vdCwgb25DaGFuZ2UgfSkgewogICAgY29uc3QgZWxzID0ge307CiAgICBsZXQgc2F2ZWQgPSBudWxsOyAgICAgLy8gdGhlIGxhc3Qgc2VsZWN0aW9uIGluc2lkZSB0aGUgZWRpdG9yCiAgICBsZXQgZWRpdGFibGUgPSBmYWxzZTsKICAgIGxldCBwbGFpbk5leHQgPSBmYWxzZTsgLy8gQ3RybCtTaGlmdCtWOiB0aGUgbmV4dCBwYXN0ZSBpcyB0ZXh0IGFsb25lCiAgICBsZXQgcGFzdGVVbmRvID0gW107ICAgIC8vIGhvdyB0aGUgdGV4dCB3YXMgYmVmb3JlIGVhY2ggZm9ybWF0dGVkIHBhc3RlLCBsYXRlc3QgbGFzdAoKICAgIGNvbnN0IHNlbGVjdGlvbiA9ICgpID0-IChyb290LmdldFNlbGVjdGlvbiA_IHJvb3QuZ2V0U2VsZWN0aW9uKCkgOiBkb2N1bWVudC5nZXRTZWxlY3Rpb24oKSk7CgogICAgZnVuY3Rpb24gcmFuZ2UoKSB7CiAgICAgIGNvbnN0IHNlbCA9IHNlbGVjdGlvbigpOwogICAgICBpZiAoIXNlbCB8fCAhc2VsLnJhbmdlQ291bnQpIHJldHVybiBudWxsOwogICAgICBjb25zdCByID0gc2VsLmdldFJhbmdlQXQoMCk7CiAgICAgIHJldHVybiBlbHMuZWRpdG9yLmNvbnRhaW5zKHIuc3RhcnRDb250YWluZXIpICYmIGVscy5lZGl0b3IuY29udGFpbnMoci5lbmRDb25",
"0YWluZXIpID8gciA6IG51bGw7CiAgICB9CgogICAgZnVuY3Rpb24gc2VsZWN0KHIpIHsKICAgICAgY29uc3Qgc2VsID0gd2luZG93LmdldFNlbGVjdGlvbigpOwogICAgICBzZWwucmVtb3ZlQWxsUmFuZ2VzKCk7CiAgICAgIHNlbC5hZGRSYW5nZShyKTsKICAgIH0KCiAgICAvLyBUb29sYmFyIGJ1dHRvbnMgZG8gbm90IHRha2UgZm9jdXMgZnJvbSB0aGUgdGV4dCwgYnV0IHRoZSBzdHlsZSBtZW51CiAgICAvLyBhbmQgdGhlIGxpbmsgZmllbGQgZG87IHRoZSBzZWxlY3Rpb24gdGhleSB3ZXJlIG9wZW5lZCBvbiBpcyBwdXQKICAgIC8vIGJhY2sgYmVmb3JlIHRoZSBjaGFuZ2UgaXMgYXBwbGllZC4KICAgIGZ1bmN0aW9uIHJlc3RvcmUoKSB7CiAgICAgIC8vIFRoZSBzZWxlY3Rpb24gY2FuIHN0aWxsIGJlIGluIHRoZSB0ZXh0IHdoaWxlIHRoZSBmb2N1cyBpcyBub3QgLQogICAgICAvLyBvbiB0aGUgc3R5bGUgYnV0dG9uIHRoZSBtZW51IGhhbmRlZCBpdCBiYWNrIHRvLCBzYXkgLSBhbmQgdHlwaW5nCiAgICAgIC8vIHdvdWxkIHRoZW4gZ28gbm93aGVyZS4gQm90aCBhcmUgcHV0IGJhY2suCiAgICAgIGNvbnN0IGtlZXAgPSByYW5nZSgpIHx8IChzYXZlZCAmJiBlbHMuZWRpdG9yLmNvbnRhaW5zKHNhdmVkLnN0YXJ0Q29udGFpbmVyKSA_IHNhdmVkIDogbnVsbCk7CiAgICAgIGlmIChyb290LmFjdGl2ZUVsZW1lbnQgIT09IGVscy5lZGl0b3IpIGVscy5lZGl0b3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwo",
"gICAgICBpZiAoa2VlcCkgewogICAgICAgIHRyeSB7IHNlbGVjdChrZWVwLmNsb25lUmFuZ2UgPyBrZWVwLmNsb25lUmFuZ2UoKSA6IGtlZXApOyB9IGNhdGNoIHsgLyogdGhlIHRleHQgY2hhbmdlZCB1bmRlcm5lYXRoICovIH0KICAgICAgfQogICAgfQoKICAgIGZ1bmN0aW9uIGJsb2NrT2Yobm9kZSkgewogICAgICBsZXQgbiA9IG5vZGU7CiAgICAgIGlmIChuID09PSBlbHMuZWRpdG9yKSByZXR1cm4gbnVsbDsKICAgICAgd2hpbGUgKG4gJiYgbi5wYXJlbnROb2RlICE9PSBlbHMuZWRpdG9yKSBuID0gbi5wYXJlbnROb2RlOwogICAgICByZXR1cm4gbiAmJiBuLm5vZGVUeXBlID09PSAxID8gbiA6IG51bGw7CiAgICB9CgogICAgZnVuY3Rpb24gcmFuZ2VCbG9ja3MocikgewogICAgICBjb25zdCBraWRzID0gWy4uLmVscy5lZGl0b3IuY2hpbGRyZW5dOwogICAgICBjb25zdCBlZGdlID0gKGNvbnRhaW5lciwgb2Zmc2V0LCBlbmQpID0-IHsKICAgICAgICBpZiAoY29udGFpbmVyID09PSBlbHMuZWRpdG9yKSByZXR1cm4ga2lkc1tNYXRoLm1pbihraWRzLmxlbmd0aCAtIDEsIE1hdGgubWF4KDAsIG9mZnNldCAtIChlbmQgPyAxIDogMCkpKV07CiAgICAgICAgcmV0dXJuIGJsb2NrT2YoY29udGFpbmVyKTsKICAgICAgfTsKICAgICAgY29uc3QgYSA9IGVkZ2Uoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCwgZmFsc2UpOwogICAgICBjb25zdCBiID0gZWRnZShyLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXQsIHR",
"ydWUpOwogICAgICBjb25zdCBpID0ga2lkcy5pbmRleE9mKGEpOwogICAgICBjb25zdCBqID0ga2lkcy5pbmRleE9mKGIpOwogICAgICBpZiAoaSA8IDAgfHwgaiA8IDApIHJldHVybiBhID8gW2FdIDogW107CiAgICAgIHJldHVybiBraWRzLnNsaWNlKE1hdGgubWluKGksIGopLCBNYXRoLm1heChpLCBqKSArIDEpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNhcmV0QXRCbG9ja1N0YXJ0KHIsIGJsaykgewogICAgICBpZiAoIXIgfHwgIXIuY29sbGFwc2VkIHx8ICFibGspIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgcHJlLnNlbGVjdE5vZGVDb250ZW50cyhibGspOwogICAgICBwcmUuc2V0RW5kKHIuc3RhcnRDb250YWluZXIsIHIuc3RhcnRPZmZzZXQpOwogICAgICByZXR1cm4gcHJlLnRvU3RyaW5nKCkgPT09ICcnOwogICAgfQoKICAgIGZ1bmN0aW9uIHBsYWNlQ2FyZXQobm9kZSwgb2Zmc2V0KSB7CiAgICAgIGNvbnN0IHIgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICByLnNldFN0YXJ0KG5vZGUsIG9mZnNldCk7CiAgICAgIHIuY29sbGFwc2UodHJ1ZSk7CiAgICAgIHNlbGVjdChyKTsKICAgIH0KCiAgICAvLyDilIDilIAgS2VlcGluZyB0aGUgbWFya3VwIHRpZHkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogICAgLy8gRWFjaCBsaXN0IGl0ZW0gbWF5IGJlIGF0IG1vc3Qgb25lIGxldmVsIGRlZXBlciB0aGFuIHRoZSBvbmUgYWJvdmUuCiAgICBmdW5jdGlvbiBmaXhMZXZlbHMoKSB7CiAgICAgIGxldCBwcmV2ID0gLTE7CiAgICAgIGZvciAoY29uc3QgYmxrIG9mIGVscy5lZGl0b3IuY2hpbGRyZW4pIHsKICAgICAgICBpZiAoZm10LkxJU1RTLmhhcyhibGsuZGF0YXNldC50eXBlKSkgewogICAgICAgICAgY29uc3QgbHZsID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oZm10Lk1BWF9MRVZFTCwgTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwLCBwcmV2ICsgMSkpOwogICAgICAgICAgYmxrLmRhdGFzZXQubGV2ZWwgPSBTdHJpbmcobHZsKTsKICAgICAgICAgIHByZXYgPSBsdmw7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHByZXYgPSAtMTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KCiAgICAvLyBUaGUgYnJvd3NlciBzb21ldGltZXMgbGVhdmVzIHRleHQsIGEgPGJyPiBvciBhIHBsYWluIDxkaXY-IGRpcmVjdGx5CiAgICAvLyBpbiB0aGUgZWRpdG9yIChhZnRlciBzZWxlY3QtYWxsIGFuZCBkZWxldGUsIHNheSksIGFuZCB3cmFwcyBtZXJnZWQKICAgIC8vIHRleHQgaW4gPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZeKApiI-IHdoZW4gdHdvIGJsb2NrcyBvZiBkaWZmZXJlbnQgc2l6ZXMKICAgIC8vIGpvaW4uIEJvdGggYXJlIHB1dCByaWdodCBoZXJlLCBrZWVwaW5nIHRoZSB",
"jYXJldCB3aGVyZSBpdCB3YXMuCiAgICBmdW5jdGlvbiB0aWR5KCkgewogICAgICBjb25zdCBzZWwgPSBzZWxlY3Rpb24oKTsKICAgICAgY29uc3QgciA9IHNlbCAmJiBzZWwucmFuZ2VDb3VudCA_IHNlbC5nZXRSYW5nZUF0KDApIDogbnVsbDsKICAgICAgY29uc3Qga2VlcCA9IHIgPyBbci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCwgci5lbmRDb250YWluZXIsIHIuZW5kT2Zmc2V0XSA6IG51bGw7CiAgICAgIGxldCBtb3ZlZCA9IGZhbHNlOwoKICAgICAgZm9yIChjb25zdCBub2RlIG9mIFsuLi5lbHMuZWRpdG9yLmNoaWxkTm9kZXNdKSB7CiAgICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS5jbGFzc0xpc3QuY29udGFpbnMoJ2JsaycpICYmIG5vZGUuZGF0YXNldC50eXBlKSBjb250aW51ZTsKICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiAvXihESVZ8UHxIMXxIMnxIMykkLy50ZXN0KG5vZGUudGFnTmFtZSkpIHsKICAgICAgICAgIG5vZGUuY2xhc3NMaXN0LmFkZCgnYmxrJyk7CiAgICAgICAgICBzZXRCbG9jayhub2RlLCAvXkhbMTIzXSQvLnRlc3Qobm9kZS50YWdOYW1lKSA_IG5vZGUudGFnTmFtZS50b0xvd2VyQ2FzZSgpIDogJ3AnKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMyAmJiAhbm9kZS5kYXRhLnRyaW0oKSAmJiAhKGtlZXAgJiYgKGtlZXBbMF0gPT09IG5vZGUgfHwga2VlcFsyXSA9PT0gbm9",
"kZSkpKSB7CiAgICAgICAgICBub2RlLnJlbW92ZSgpOwogICAgICAgICAgY29udGludWU7CiAgICAgICAgfQogICAgICAgIGNvbnN0IGJsayA9IGJsb2NrRWwoZm10LmJsb2NrKCdwJykpOwogICAgICAgIGJsay5yZXBsYWNlQ2hpbGRyZW4oKTsKICAgICAgICBlbHMuZWRpdG9yLmluc2VydEJlZm9yZShibGssIG5vZGUpOwogICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAxICYmIG5vZGUudGFnTmFtZSA9PT0gJ0JSJykgewogICAgICAgICAgYmxrLmFwcGVuZENoaWxkKG5vZGUpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAvLyBHYXRoZXIgdGhpcyBhbmQgYW55IGZvbGxvd2luZyBpbmxpbmUgbmVpZ2hib3VycyBpbnRvIG9uZSBibG9jay4KICAgICAgICAgIGxldCBuID0gbm9kZTsKICAgICAgICAgIHdoaWxlIChuICYmICEobi5ub2RlVHlwZSA9PT0gMSAmJiAobi5jbGFzc0xpc3QuY29udGFpbnMoJ2JsaycpIHx8IE5FU1RFRF9CTE9DS1MuaGFzKG4udGFnTmFtZS50b0xvd2VyQ2FzZSgpKSkpKSB7CiAgICAgICAgICAgIGNvbnN0IGZvbGxvd2luZyA9IG4ubmV4dFNpYmxpbmc7CiAgICAgICAgICAgIGJsay5hcHBlbmRDaGlsZChuKTsKICAgICAgICAgICAgbiA9IGZvbGxvd2luZzsKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgICAgbW92ZWQgPSB0cnVlOwogICAgICB9CgogICAgICBmb3IgKGNvbnN0IHNwYW4gb2YgWy4uLmVscy5lZGl0b3IucXVlcnlTZWxlY3RvckFsbCgnc3BhbltzdHlsZV0sIGZvbnQ",
"nKV0pIHsKICAgICAgICBjb25zdCBzdCA9IHN0eWxlTWFya3Moc3Bhbi5nZXRBdHRyaWJ1dGUoJ3N0eWxlJykpOwogICAgICAgIGlmIChzdC5iIHx8IHN0LmkgfHwgc3QucykgY29udGludWU7CiAgICAgICAgc3Bhbi5yZXBsYWNlV2l0aCguLi5zcGFuLmNoaWxkTm9kZXMpOwogICAgICAgIG1vdmVkID0gdHJ1ZTsKICAgICAgfQogICAgICBmb3IgKGNvbnN0IGEgb2YgZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yQWxsKCdhW2hyZWZdJykpIHsKICAgICAgICBjb25zdCBocmVmID0gZm10LnNhZmVIcmVmKGEuZ2V0QXR0cmlidXRlKCdocmVmJykpOwogICAgICAgIGlmICghaHJlZikgYS5yZXBsYWNlV2l0aCguLi5hLmNoaWxkTm9kZXMpOwogICAgICAgIGVsc2UgaWYgKGEudGl0bGUgIT09IGhyZWYpIGEudGl0bGUgPSBocmVmOwogICAgICB9CiAgICAgIGlmICghZWxzLmVkaXRvci5jaGlsZHJlbi5sZW5ndGgpIHsKICAgICAgICBlbHMuZWRpdG9yLmFwcGVuZENoaWxkKGJsb2NrRWwoZm10LmJsb2NrKCdwJykpKTsKICAgICAgICBwbGFjZUNhcmV0KGVscy5lZGl0b3IuZmlyc3RDaGlsZCwgMCk7CiAgICAgICAgbW92ZWQgPSBmYWxzZTsKICAgICAgfQogICAgICBpZiAobW92ZWQgJiYga2VlcCAmJiBrZWVwWzBdLmlzQ29ubmVjdGVkICYmIGtlZXBbMl0uaXNDb25uZWN0ZWQpIHsKICAgICAgICB0cnkgewogICAgICAgICAgY29uc3QgYmFjayA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgICBiYWNrLnNldFN0YXJ",
"0KGtlZXBbMF0sIGtlZXBbMV0pOwogICAgICAgICAgYmFjay5zZXRFbmQoa2VlcFsyXSwga2VlcFszXSk7CiAgICAgICAgICBzZWxlY3QoYmFjayk7CiAgICAgICAgfSBjYXRjaCB7IC8qIHBvc2l0aW9ucyBubyBsb25nZXIgdmFsaWQgKi8gfQogICAgICB9CiAgICAgIGZpeExldmVscygpOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIGZ1bmN0aW9uIHVwZGF0ZUVtcHR5KCkgewogICAgICBjb25zdCBraWRzID0gZWxzLmVkaXRvci5jaGlsZHJlbjsKICAgICAgY29uc3QgZW1wdHkgPSBraWRzLmxlbmd0aCA8PSAxICYmICgha2lkc1swXSB8fCAoa2lkc1swXS5kYXRhc2V0LnR5cGUgPT09ICdwJyAmJiAha2lkc1swXS50ZXh0Q29udGVudCkpOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQuZW1wdHkgPSBlbXB0eSA_ICcxJyA6ICcwJzsKICAgIH0KCiAgICBmdW5jdGlvbiBjaGFuZ2VkKCkgewogICAgICBwYXN0ZVVuZG8gPSBbXTsKICAgICAgdGlkeSgpOwogICAgICBvbkNoYW5nZSgpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIOKUgOKUgCBDb21tYW5kcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlvbiB",
"pbmxpbmUoY21kKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgcmVzdG9yZSgpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZChjbWQpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIEFwcGxpZXMgYSBibG9jayB0eXBlIHRvIGV2ZXJ5IGJsb2NrIHRoZSBzZWxlY3Rpb24gdG91Y2hlcyAtIG9yLCBpZgogICAgLy8gdGhleSBhbGwgaGF2ZSBpdCBhbHJlYWR5LCB0dXJucyB0aGVtIGJhY2sgaW50byBwYXJhZ3JhcGhzLgogICAgZnVuY3Rpb24gYmxvY2tUeXBlKHR5cGUsIHsgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIHJlc3RvcmUoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCBibG9ja3MgPSByYW5nZUJsb2NrcyhyKTsKICAgICAgY29uc3Qgb2ZmID0gYmxvY2tzLmV2ZXJ5KGIgPT4gYi5kYXRhc2V0LnR5cGUgPT09IHR5cGUpICYmIHR5cGUgIT09ICdwJzsKICAgICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICAgIGNvbnN0IHdhcyA9IGIuZGF0YXNldC50eXBlOwogICAgICAgIGNvbnN0IGxldmVsID0gZm10LkxJU1RTLmhhcyh3YXMpID8gTnVtYmVyKGIuZGF0YXNldC5sZXZlbCkgfHwgMCA6IDA7CiAgICAgICAgc2V0QmxvY2soYiwgb2ZmID8gJ3AnIDogdHlwZSwgbGV2ZWwsIHR5cGUgPT09ICdjaGVjaycgJiYgd2FzID09PSAnY2h",
"lY2snID8gYi5kYXRhc2V0LmNoZWNrZWQgPT09ICcxJyA6IGNoZWNrZWQpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBpbmRlbnQoZGVsdGEpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyKSByZXR1cm4gZmFsc2U7CiAgICAgIGNvbnN0IGJsb2NrcyA9IHJhbmdlQmxvY2tzKHIpLmZpbHRlcihiID0-IGZtdC5MSVNUUy5oYXMoYi5kYXRhc2V0LnR5cGUpKTsKICAgICAgaWYgKCFibG9ja3MubGVuZ3RoKSByZXR1cm4gZmFsc2U7CiAgICAgIGZvciAoY29uc3QgYiBvZiBibG9ja3MpIGIuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhNYXRoLm1heCgwLCBNYXRoLm1pbihmbXQuTUFYX0xFVkVMLCAoTnVtYmVyKGIuZGF0YXNldC5sZXZlbCkgfHwgMCkgKyBkZWx0YSkpKTsKICAgICAgY2hhbmdlZCgpOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0KCiAgICBmdW5jdGlvbiB0b2dnbGVDaGVjayhibGspIHsKICAgICAgaWYgKCFlZGl0YWJsZSB8fCAhYmxrIHx8IGJsay5kYXRhc2V0LnR5cGUgIT09ICdjaGVjaycpIHJldHVybjsKICAgICAgYmxrLmRhdGFzZXQuY2hlY2tlZCA9IGJsay5kYXRhc2V0LmNoZWNrZWQgPT09ICcxJyA_ICcwJyA6ICcxJzsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNsZWFyRm9ybWF0dGluZygpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuOwogICA",
"gICByZXN0b3JlKCk7CiAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdyZW1vdmVGb3JtYXQnKTsKICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ3VubGluaycpOwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKHIpIGZvciAoY29uc3QgYiBvZiByYW5nZUJsb2NrcyhyKSkgc2V0QmxvY2soYiwgJ3AnKTsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGFuY2hvckF0KHIpIHsKICAgICAgbGV0IG4gPSByICYmIHIuc3RhcnRDb250YWluZXI7CiAgICAgIHdoaWxlIChuICYmIG4gIT09IGVscy5lZGl0b3IpIHsKICAgICAgICBpZiAobi5ub2RlVHlwZSA9PT0gMSAmJiBuLnRhZ05hbWUgPT09ICdBJykgcmV0dXJuIG47CiAgICAgICAgbiA9IG4ucGFyZW50Tm9kZTsKICAgICAgfQogICAgICByZXR1cm4gbnVsbDsKICAgIH0KCiAgICAvLyDilIDilIAgTGlua3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogICAgZnVuY3Rpb24gb3BlbkxpbmsoKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgY29uc3QgciA9IHJhbmdlKCkgfHwgc2F2ZWQ7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICB",
"zYXZlZCA9IHIuY2xvbmVSYW5nZSgpOwogICAgICBjb25zdCBhID0gYW5jaG9yQXQocik7CiAgICAgIGVscy5saW5rSW5wdXQudmFsdWUgPSBhID8gYS5nZXRBdHRyaWJ1dGUoJ2hyZWYnKSA6ICcnOwogICAgICBlbHMubGlua0Vycm9yLnRleHRDb250ZW50ID0gJyc7CiAgICAgIGVscy5saW5rUmVtb3ZlLmhpZGRlbiA9ICFhOwogICAgICBlbHMubGlua2Jhci5oaWRkZW4gPSBmYWxzZTsKICAgICAgZWxzLmxpbmtJbnB1dC5mb2N1cygpOwogICAgICBlbHMubGlua0lucHV0LnNlbGVjdCgpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNsb3NlTGluayh7IHJlZm9jdXMgPSB0cnVlIH0gPSB7fSkgewogICAgICBpZiAoZWxzLmxpbmtiYXIuaGlkZGVuKSByZXR1cm47CiAgICAgIGVscy5saW5rYmFyLmhpZGRlbiA9IHRydWU7CiAgICAgIGlmIChyZWZvY3VzKSByZXN0b3JlKCk7CiAgICB9CgogICAgZnVuY3Rpb24gYXBwbHlMaW5rKCkgewogICAgICBjb25zdCBocmVmID0gZm10LnNhZmVIcmVmKGVscy5saW5rSW5wdXQudmFsdWUpOwogICAgICBpZiAoIWhyZWYpIHsKICAgICAgICBlbHMubGlua0Vycm9yLnRleHRDb250ZW50ID0gJ1RoYXQgaXMgbm90IGEgd2ViIG9yIGVtYWlsIGFkZHJlc3MuJzsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY2xvc2VMaW5rKCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgY29uc3QgYSA9IGFuY2hvckF0KHIpOwogICAgICBpZiAoci5",
"jb2xsYXBzZWQgJiYgYSkgewogICAgICAgIGEuc2V0QXR0cmlidXRlKCdocmVmJywgaHJlZik7CiAgICAgICAgYS50aXRsZSA9IGhyZWY7CiAgICAgIH0gZWxzZSBpZiAoci5jb2xsYXBzZWQpIHsKICAgICAgICAvLyBOb3RoaW5nIHNlbGVjdGVkOiB0aGUgYWRkcmVzcyBpdHNlbGYgYmVjb21lcyB0aGUgbGluayB0ZXh0LgogICAgICAgIGNvbnN0IHRleHQgPSBocmVmLnJlcGxhY2UoL15tYWlsdG86LywgJycpOwogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIHRleHQpOwogICAgICAgIGNvbnN0IGFmdGVyID0gcmFuZ2UoKTsKICAgICAgICBpZiAoYWZ0ZXIpIHsKICAgICAgICAgIGNvbnN0IHNlbCA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgICBzZWwuc2V0U3RhcnQoYWZ0ZXIuc3RhcnRDb250YWluZXIsIE1hdGgubWF4KDAsIGFmdGVyLnN0YXJ0T2Zmc2V0IC0gdGV4dC5sZW5ndGgpKTsKICAgICAgICAgIHNlbC5zZXRFbmQoYWZ0ZXIuc3RhcnRDb250YWluZXIsIGFmdGVyLnN0YXJ0T2Zmc2V0KTsKICAgICAgICAgIHNlbGVjdChzZWwpOwogICAgICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2NyZWF0ZUxpbmsnLCBmYWxzZSwgaHJlZik7CiAgICAgICAgICBjb25zdCBlbmQgPSByYW5nZSgpOwogICAgICAgICAgaWYgKGVuZCkgeyBlbmQuY29sbGFwc2UoZmFsc2UpOyBzZWxlY3QoZW5kKTsgfQogICAgICAgIH0KICAgICAgfSBlbHNlIHsKICAgICAgICBkb2N",
"1bWVudC5leGVjQ29tbWFuZCgnY3JlYXRlTGluaycsIGZhbHNlLCBocmVmKTsKICAgICAgfQogICAgICBjaGFuZ2VkKCk7CiAgICB9CgogICAgZnVuY3Rpb24gcmVtb3ZlTGluaygpIHsKICAgICAgY2xvc2VMaW5rKCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBjb25zdCBhID0gYW5jaG9yQXQocik7CiAgICAgIGlmIChhKSB7CiAgICAgICAgY29uc3Qgc2VsID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICBzZWwuc2VsZWN0Tm9kZUNvbnRlbnRzKGEpOwogICAgICAgIHNlbGVjdChzZWwpOwogICAgICB9CiAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCd1bmxpbmsnKTsKICAgICAgY2hhbmdlZCgpOwogICAgfQoKICAgIC8vIOKUgOKUgCBUb29sYmFyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGNvbnN0IGJ1dHRvbnMgPSB7fTsKICAgIGNvbnN0IHRiQnV0dG9uID0gKGtleSwgbGFiZWwsIGljb25OYW1lLCBvbkNsaWNrLCB0b2dnbGUgPSB0cnVlKSA9PiB7CiAgICAgIGNvbnN0IGIgPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICd0Yi1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGl0bGU6IGxhYmVsLCAnYXJpYS1",
"sYWJlbCc6IGxhYmVsLAogICAgICAgICdhcmlhLXByZXNzZWQnOiB0b2dnbGUgPyAnZmFsc2UnIDogbnVsbCwgZGF0YXNldDogeyBrZXk6IGBmbXQtJHtrZXl9YCB9LAogICAgICAgIC8vIEtlZXBzIHRoZSBmb2N1cyAtIGFuZCBzbyB0aGUgc2VsZWN0aW9uIC0gaW4gdGhlIHRleHQuCiAgICAgICAgb25tb3VzZWRvd246IGUgPT4gZS5wcmV2ZW50RGVmYXVsdCgpLAogICAgICAgIG9uY2xpY2s6ICgpID0-IG9uQ2xpY2soKSwKICAgICAgfSwgaWNvbihpY29uTmFtZSwgMjApKTsKICAgICAgYnV0dG9uc1trZXldID0gYjsKICAgICAgcmV0dXJuIGI7CiAgICB9OwogICAgY29uc3Qgc2VwID0gKCkgPT4gaCgnc3BhbicsIHsgY2xhc3M6ICd0Yi1zZXAnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSk7CgogICAgZWxzLnN0eWxlTGFiZWwgPSBoKCdzcGFuJywgeyBjbGFzczogJ3RiLXN0eWxlLWxhYmVsJywgdGV4dDogJ05vcm1hbCB0ZXh0JyB9KTsKICAgIGVscy5zdHlsZSA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICd0Yi1zdHlsZScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1oYXNwb3B1cCc6ICdtZW51JywgJ2FyaWEtZXhwYW5kZWQnOiAnZmFsc2UnLAogICAgICAnYXJpYS1sYWJlbCc6ICdUZXh0IHN0eWxlJywgdGl0bGU6ICdUZXh0IHN0eWxlJywgZGF0YXNldDogeyBrZXk6ICdmbXQtc3R5bGUnIH0sCiAgICAgIG9ubW91c2Vkb3duOiBlID0-IGUucHJldmVudERlZmF1bHQoKSwKICAgICAgb25jbGljazogKCkgPT4",
"gewogICAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgICBpZiAocikgc2F2ZWQgPSByLmNsb25lUmFuZ2UoKTsKICAgICAgICBjb25zdCBjdXIgPSBjdXJyZW50VHlwZSgpOwogICAgICAgIG9wZW5NZW51KHJvb3QsIGVscy5zdHlsZSwgU1RZTEVTLm1hcCgoW3R5cGUsIGxhYmVsXSkgPT4gKHsKICAgICAgICAgIGxhYmVsLCBrZXk6IGBzdHlsZToke3R5cGV9YCwgY2hlY2tlZDogY3VyID09PSB0eXBlLAogICAgICAgICAgb25TZWxlY3Q6ICgpID0-IGJsb2NrVHlwZSh0eXBlKSwKICAgICAgICB9KSksIHsgbGFiZWw6ICdUZXh0IHN0eWxlJyB9KTsKICAgICAgfSwKICAgIH0sIGVscy5zdHlsZUxhYmVsLCBpY29uKCdjYXJldCcsIDE4KSk7CgogICAgZWxzLnRvb2xiYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtdG9vbGJhcicsIHJvbGU6ICd0b29sYmFyJywgJ2FyaWEtbGFiZWwnOiAnRm9ybWF0dGluZycgfSwKICAgICAgZWxzLnN0eWxlLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ2JvbGQnLCAnQm9sZCAoQ3RybCtCKScsICdib2xkJywgKCkgPT4gaW5saW5lKCdib2xkJykpLAogICAgICB0YkJ1dHRvbignaXRhbGljJywgJ0l0YWxpYyAoQ3RybCtJKScsICdpdGFsaWMnLCAoKSA9PiBpbmxpbmUoJ2l0YWxpYycpKSwKICAgICAgdGJCdXR0b24oJ3N0cmlrZScsICdTdHJpa2UtdGhyb3VnaCcsICdzdHJpa2UnLCAoKSA9PiBpbmxpbmUoJ3N0cmlrZVR",
"ocm91Z2gnKSksCiAgICAgIHNlcCgpLAogICAgICB0YkJ1dHRvbigndWwnLCAnQnVsbGV0ZWQgbGlzdCAoQ3RybCtTaGlmdCs4KScsICdidWxsZXRzJywgKCkgPT4gYmxvY2tUeXBlKCd1bCcpKSwKICAgICAgdGJCdXR0b24oJ29sJywgJ051bWJlcmVkIGxpc3QgKEN0cmwrU2hpZnQrNyknLCAnbnVtYmVycycsICgpID0-IGJsb2NrVHlwZSgnb2wnKSksCiAgICAgIHRiQnV0dG9uKCdjaGVjaycsICdDaGVja2xpc3QgKEN0cmwrU2hpZnQrOSknLCAnY2hlY2tsaXN0JywgKCkgPT4gYmxvY2tUeXBlKCdjaGVjaycpKSwKICAgICAgdGJCdXR0b24oJ291dGRlbnQnLCAnTGVzcyBpbmRlbnQgKFNoaWZ0K1RhYiknLCAnb3V0ZGVudCcsICgpID0-IHsgcmVzdG9yZSgpOyBpbmRlbnQoLTEpOyB9LCBmYWxzZSksCiAgICAgIHRiQnV0dG9uKCdpbmRlbnQnLCAnTW9yZSBpbmRlbnQgKFRhYiknLCAnaW5kZW50JywgKCkgPT4geyByZXN0b3JlKCk7IGluZGVudCgxKTsgfSwgZmFsc2UpLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ2xpbmsnLCAnTGluayAoQ3RybCtLKScsICdsaW5rJywgKCkgPT4gb3BlbkxpbmsoKSksCiAgICAgIHRiQnV0dG9uKCdjbGVhcicsICdDbGVhciBmb3JtYXR0aW5nJywgJ2NsZWFyJywgKCkgPT4gY2xlYXJGb3JtYXR0aW5nKCksIGZhbHNlKSk7CgogICAgZWxzLmxpbmtJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHBsYWNlaG9sZGVyOiA",
"nV2ViIGFkZHJlc3Mgb3IgZW1haWwnLCAnYXJpYS1sYWJlbCc6ICdMaW5rIGFkZHJlc3MnLAogICAgICBzcGVsbGNoZWNrOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWlucHV0JyB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGFwcGx5TGluaygpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNsb3NlTGluaygpOyB9CiAgICAgIH0sCiAgICB9KTsKICAgIGVscy5saW5rRXJyb3IgPSBoKCdzcGFuJywgeyBjbGFzczogJ2xpbmstZXJyb3InLCByb2xlOiAnYWxlcnQnIH0pOwogICAgZWxzLmxpbmtSZW1vdmUgPSBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdSZW1vdmUgbGluaycsIGRhdGFzZXQ6IHsga2V5OiAnZm10LWxpbmstcmVtb3ZlJyB9LCBvbmNsaWNrOiByZW1vdmVMaW5rIH0pOwogICAgZWxzLmxpbmtiYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtbGlua2JhcicsIGhpZGRlbjogdHJ1ZSB9LAogICAgICBpY29uKCdsaW5rJywgMTgpLCBlbHMubGlua0lucHV0LAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10b25hbCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQXBwbHknLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWF",
"wcGx5JyB9LCBvbmNsaWNrOiBhcHBseUxpbmsgfSksCiAgICAgIGVscy5saW5rUmVtb3ZlLAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiAoKSA9PiBjbG9zZUxpbmsoKSB9KSwKICAgICAgZWxzLmxpbmtFcnJvcik7CgogICAgZnVuY3Rpb24gY3VycmVudFR5cGUoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpIHx8IHNhdmVkOwogICAgICBjb25zdCBibGsgPSByICYmIGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIHJldHVybiBibGsgPyBibGsuZGF0YXNldC50eXBlIHx8ICdwJyA6ICdwJzsKICAgIH0KCiAgICBmdW5jdGlvbiByZWZyZXNoVG9vbGJhcigpIHsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gY3VycmVudFR5cGUoKTsKICAgICAgZWxzLnN0eWxlTGFiZWwudGV4dENvbnRlbnQgPSBTVFlMRV9MQUJFTFt0eXBlXSB8fCAnTm9ybWFsIHRleHQnOwogICAgICBmb3IgKGNvbnN0IFtrZXksIGNtZF0gb2YgW1snYm9sZCcsICdib2xkJ10sIFsnaXRhbGljJywgJ2l0YWxpYyddLCBbJ3N0cmlrZScsICdzdHJpa2VUaHJvdWdoJ11dKSB7CiAgICAgICAgbGV0IG9uID0gZmFsc2U7CiAgICAgICAgdHJ5IHsgb24gPSBkb2N1bWVudC5xdWVyeUNvbW1hbmRTdGF0ZShjbWQpOyB9IGNhdGNoIHsgLyogbm90IHN1cHBvcnRlZCAqLyB9CiA",
"gICAgICAgYnV0dG9uc1trZXldLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKG9uKSk7CiAgICAgIH0KICAgICAgZm9yIChjb25zdCB0IG9mIFsndWwnLCAnb2wnLCAnY2hlY2snXSkgYnV0dG9uc1t0XS5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyh0eXBlID09PSB0KSk7CiAgICAgIGJ1dHRvbnMubGluay5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyghIWFuY2hvckF0KHIpKSk7CiAgICB9CgogICAgLy8g4pSA4pSAIFRoZSBlZGl0YWJsZSBhcmVhIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGVscy5lZGl0b3IgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbmUtYm9keScsIHJvbGU6ICd0ZXh0Ym94JywgJ2FyaWEtbXVsdGlsaW5lJzogJ3RydWUnLCAnYXJpYS1sYWJlbCc6ICdOb3RlJywKICAgICAgc3BlbGxjaGVjazogJ3RydWUnLCBkYXRhc2V0OiB7IGtleTogJ25vdGUtYm9keScsIGVtcHR5OiAnMScgfSwKICAgIH0pOwoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIGUgPT4gewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIGNvbnN0IG1vZCA9IGUuY3RybEtleSB8fCBlLm1ldGFLZXk7CiA",
"gICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBjb25zdCBibGsgPSByICYmIGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CgogICAgICBpZiAobW9kICYmICFlLmFsdEtleSAmJiAhZS5zaGlmdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAneicgJiYgcGFzdGVVbmRvLmxlbmd0aCkgewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICB1bmRvUGFzdGUoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKG1vZCAmJiAhZS5hbHRLZXkgJiYgZS5zaGlmdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAndicpIHsKICAgICAgICAvLyBUaGUgcGFzdGUgZXZlbnQgZm9sbG93cyBzdHJhaWdodCBhd2F5LCBpbiB0aGlzIHNhbWUgdGFzay4KICAgICAgICBwbGFpbk5leHQgPSB0cnVlOwogICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBwbGFpbk5leHQgPSBmYWxzZTsgfSwgMCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChtb2QgJiYgIWUuYWx0S2V5ICYmIGUuc2hpZnRLZXkgJiYgL15EaWdpdFs3ODldJC8udGVzdChlLmNvZGUpKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGJsb2NrVHlwZSh7IERpZ2l0NzogJ29sJywgRGlnaXQ4OiAndWwnLCBEaWdpdDk6ICdjaGVjaycgfVtlLmNvZGVdKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKG1vZCAmJiAhZS5zaGlmdEtleSAmJiAhZS5hbHRLZXkpIHsKICAgICAgICBjb25",
"zdCBrID0gZS5rZXkudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAoayA9PT0gJ2snKSB7IGUucHJldmVudERlZmF1bHQoKTsgb3BlbkxpbmsoKTsgcmV0dXJuOyB9CiAgICAgICAgaWYgKGsgPT09ICd1JykgeyBlLnByZXZlbnREZWZhdWx0KCk7IHJldHVybjsgfSAvLyBubyB1bmRlcmxpbmUgaW4gdGhlIG1vZGVsCiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmIGJsayAmJiBibGsuZGF0YXNldC50eXBlID09PSAnY2hlY2snKSB7IGUucHJldmVudERlZmF1bHQoKTsgdG9nZ2xlQ2hlY2soYmxrKTsgcmV0dXJuOyB9CiAgICAgIH0KICAgICAgaWYgKGUua2V5ID09PSAnVGFiJyAmJiAhbW9kICYmICFlLmFsdEtleSAmJiBibGsgJiYgZm10LkxJU1RTLmhhcyhibGsuZGF0YXNldC50eXBlKSkgewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBpbmRlbnQoZS5zaGlmdEtleSA_IC0xIDogMSk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJyAmJiAhbW9kICYmICFlLmFsdEtleSAmJiAhZS5pc0NvbXBvc2luZykgewogICAgICAgIC8vIEFuIGVtcHR5IGxpc3QgaXRlbSBlbmRzIHRoZSBsaXN0OyBTaGlmdCtFbnRlciBpcyBhIG5ldyBsaW5lIGxpa2UKICAgICAgICAvLyBhbnkgb3RoZXIsIHNpbmNlIHRoZSBtb2RlbCBoYXMgbm8gbGluZSBicmVha3MgaW5zaWRlIGEgYmxvY2suCiAgICAgICAgaWYgKGJsayAmJiBmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V",
"0LnR5cGUpICYmICFibGsudGV4dENvbnRlbnQpIHsKICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICAgIGNvbnN0IGx2bCA9IE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMDsKICAgICAgICAgIGlmIChsdmwgPiAwKSBibGsuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsdmwgLSAxKTsKICAgICAgICAgIGVsc2Ugc2V0QmxvY2soYmxrLCAncCcpOwogICAgICAgICAgY2hhbmdlZCgpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBpZiAoZS5zaGlmdEtleSkgewogICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2luc2VydFBhcmFncmFwaCcpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoZS5rZXkgPT09ICdCYWNrc3BhY2UnICYmICFtb2QgJiYgYmxrICYmIGJsay5kYXRhc2V0LnR5cGUgIT09ICdwJyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCBibGspKSB7CiAgICAgICAgLy8gQXQgdGhlIHN0YXJ0IG9mIGEgbGlzdCBpdGVtIG9yIGhlYWRpbmcsIEJhY2tzcGFjZSB1bmRvZXMgdGhlCiAgICAgICAgLy8gZm9ybWF0dGluZyBiZWZvcmUgaXQgc3RhcnRzIGpvaW5pbmcgbGluZXMuCiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGx2bCA9IE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMDsKICAgICAgICBpZiAoZm10LkxJU1RTLmhhcyhibGsuZGF0YXN",
"ldC50eXBlKSAmJiBsdmwgPiAwKSBibGsuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsdmwgLSAxKTsKICAgICAgICBlbHNlIHNldEJsb2NrKGJsaywgJ3AnKTsKICAgICAgICBjaGFuZ2VkKCk7CiAgICAgIH0KICAgIH0pOwoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBlID0-IHsKICAgICAgaWYgKGUuaW5wdXRUeXBlID09PSAnaW5zZXJ0VGV4dCcgJiYgKGUuZGF0YSA9PT0gJyAnIHx8IGUuZGF0YSA9PT0gJ8KgJykpIGF1dG9mb3JtYXQoKTsKICAgICAgaWYgKGUuaW5wdXRUeXBlID09PSAnaW5zZXJ0UGFyYWdyYXBoJykgewogICAgICAgIC8vIFRoZSBuZXcgYmxvY2sgaXMgYSBjb3B5IG9mIHRoZSBvbmUgaXQgd2FzIHNwbGl0IGZyb206IGEgdGlja2VkCiAgICAgICAgLy8gYm94IGFuZCBhIGhlYWRpbmcgc2hvdWxkIG5vdCBjYXJyeSBvbiBpbnRvIGFuIGVtcHR5IG5ldyBsaW5lLgogICAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICAgIGNvbnN0IGJsayA9IHIgJiYgYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKTsKICAgICAgICBpZiAoYmxrICYmICFibGsudGV4dENvbnRlbnQpIHsKICAgICAgICAgIGlmIChibGsuZGF0YXNldC50eXBlID09PSAnY2hlY2snKSBibGsuZGF0YXNldC5jaGVja2VkID0gJzAnOwogICAgICAgICAgaWYgKC9eaFsxMjNdJC8udGVzdChibGsuZGF0YXNldC50eXBlKSkgc2V0QmxvY2soYmxrLCAncCcpOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoL15",
"kZWxldGUvLnRlc3QoZS5pbnB1dFR5cGUpICYmIGVscy5lZGl0b3IuY2hpbGRyZW4ubGVuZ3RoID09PSAxICYmICFlbHMuZWRpdG9yLnRleHRDb250ZW50KSB7CiAgICAgICAgLy8gRXZlcnl0aGluZyBkZWxldGVkOiB0aGUgbm90ZSBzdGFydHMgYWdhaW4gZnJvbSBub3JtYWwgdGV4dC4KICAgICAgICBzZXRCbG9jayhlbHMuZWRpdG9yLmZpcnN0RWxlbWVudENoaWxkLCAncCcpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0pOwoKICAgIGZ1bmN0aW9uIGF1dG9mb3JtYXQoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIgfHwgIXIuY29sbGFwc2VkKSByZXR1cm47CiAgICAgIGNvbnN0IGJsayA9IGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIGlmICghYmxrIHx8IGJsay5kYXRhc2V0LnR5cGUgIT09ICdwJykgcmV0dXJuOwogICAgICBjb25zdCBwcmUgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcmUuc2VsZWN0Tm9kZUNvbnRlbnRzKGJsayk7CiAgICAgIHByZS5zZXRFbmQoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCk7CiAgICAgIGNvbnN0IG0gPSAvXihcU3sxLDN9KVsgwqBdJC8uZXhlYyhwcmUudG9TdHJpbmcoKSk7CiAgICAgIGNvbnN0IHJ1bGUgPSBtICYmIEFVVE8uZmluZCgoW3JlXSkgPT4gcmUudGVzdChtWzFdKSk7CiAgICAgIGlmICghcnVsZSkgcmV0dXJuOwogICAgICBzZWxlY3QocHJlKTsKICAgICAgZG9jdW1lbnQuZXhlY0NvbW1",
"hbmQoJ2RlbGV0ZScpOwogICAgICBzZXRCbG9jayhibGssIHJ1bGVbMV0udHlwZSwgMCwgISFydWxlWzFdLmNoZWNrZWQpOwogICAgfQoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcigncGFzdGUnLCBlID0-IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIGNvbnN0IGRhdGEgPSBlLmNsaXBib2FyZERhdGE7CiAgICAgIGNvbnN0IHRleHQgPSAoZGF0YSAmJiBkYXRhLmdldERhdGEoJ3RleHQvcGxhaW4nKSkgfHwgJyc7CiAgICAgIGNvbnN0IHBsYWluID0gcGxhaW5OZXh0OwogICAgICBwbGFpbk5leHQgPSBmYWxzZTsKICAgICAgY29uc3QgZG9jID0gcGxhaW4gPyBudWxsIDogZm10LnBhc3RlRG9jKHsgaHRtbDogZGF0YSAmJiBkYXRhLmdldERhdGEoJ3RleHQvaHRtbCcpLCB0ZXh0IH0pOwogICAgICAvLyBUZXh0IHdpdGggbm90aGluZyB0byBmb3JtYXQgZ29lcyBpbiB0aGUgd2F5IHR5cGluZyBkb2VzLCBzbyB0aGUKICAgICAgLy8gYnJvd3NlcidzIG93biB1bmRvIHRha2VzIGl0IGJhY2s6IGEgc2luZ2xlIGxpbmUgYXMgY29waWVkLCBzcGFjZXMKICAgICAgLy8gYW5kIGFsbDsgbW9yZSB0aGFuIHRoYXQgYXMgdGhlIEhUTUwgcmVhZHMgKGEgdGFibGUncyAiIHwgIiwgbm90CiAgICAgIC8vIGl0cyB0YWJzKS4KICAgICAgY29uc3QgbGluZSA9IHRleHQucmVwbGFjZSgvW1xyXG5dKyQvLCAnJyk7CiAgICAgIGlmIChkb2MgJiYgZm10Lmhhc0Z",
"vcm1hdHRpbmcoZG9jKSkgaW5zZXJ0RG9jKGRvYyk7CiAgICAgIGVsc2UgaWYgKGRvYyAmJiAhKGRvYy5sZW5ndGggPT09IDEgJiYgbGluZSAmJiAhL1tcclxuXHRdLy50ZXN0KGxpbmUpKSkgaW5zZXJ0UGxhaW4oZm10LmRvY1RleHQoZG9jKSk7CiAgICAgIGVsc2UgaW5zZXJ0UGxhaW4oZG9jID8gbGluZSA6IHRleHQpOwogICAgICByZXZlYWxDYXJldCgpOwogICAgfSk7CiAgICBlbHMuZWRpdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCBlID0-IHsKICAgICAgLy8gRHJvcHBlZCBIVE1MIHdvdWxkIGJyaW5nIGl0cyBvd24gbWFya3VwOyBkcm9wcGVkIGZpbGVzIGhhdmUgbm93aGVyZSB0byBnby4KICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgfSk7CgogICAgZnVuY3Rpb24gaW5zZXJ0UGxhaW4odGV4dCkgewogICAgICBjb25zdCBsaW5lcyA9IFN0cmluZyh0ZXh0KS5yZXBsYWNlKC9cclxuPy9nLCAnXG4nKS5zcGxpdCgnXG4nKTsKICAgICAgbGluZXMuZm9yRWFjaCgobGluZSwgaSkgPT4gewogICAgICAgIGlmIChpKSBkb2N1bWVudC5leGVjQ29tbWFuZCgnaW5zZXJ0UGFyYWdyYXBoJyk7CiAgICAgICAgaWYgKGxpbmUpIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIGxpbmUpOwogICAgICB9KTsKICAgIH0KCiAgICAvLyDilIDilIAgRm9ybWF0dGVkIHBhc3RlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgLy8KICAgIC8vIFRoZSBibG9ja3MgZ28gaW4gZGlyZWN0bHkgLSB0aGUgYnJvd3NlcidzIGVkaXRpbmcgY29tbWFuZHMgd291bGQKICAgIC8vIG5lc3QgYW5kIHJlc3R5bGUgdGhlbSAtIHdpdGggdGhlIHRleHQgYWZ0ZXIgdGhlIGNhcmV0IGNhcnJpZWQgdG8KICAgIC8vIHRoZSBlbmQgb2Ygd2hhdCB3YXMgcGFzdGVkLiBUaGUgYnJvd3NlcidzIHVuZG8gZG9lcyBub3Qga25vdyBhYm91dAogICAgLy8gdGhhdCwgc28gQ3RybCtaIHN0cmFpZ2h0IGFmdGVyd2FyZHMgcHV0cyBiYWNrIGEgY29weSB0YWtlbiBmaXJzdCAtCiAgICAvLyBvbmUgcGFzdGUgYXQgYSB0aW1lLCB1bnRpbCBhbnl0aGluZyBlbHNlIGNoYW5nZXMgdGhlIHRleHQuCgogICAgLy8gRW1wdHkgdGV4dCBhbmQgZW1wdHkgbWFya3MgbGVmdCBiZWhpbmQgYnkgY3V0dGluZyBhIGJsb2NrIGluIHR3bzsKICAgIC8vIGFsc28gdGhlIDxicj4gdGhhdCBob2xkcyBhbiBlbXB0eSBibG9jayBvcGVuLCBwdXQgYmFjayBsYXRlciBpZgogICAgLy8gdGhlIGJsb2NrIGlzIHN0aWxsIGVtcHR5LgogICAgZnVuY3Rpb24gcHJ1bmUoZWwpIHsKICAgICAgZm9yIChjb25zdCBuIG9mIFsuLi5lbC5jaGlsZE5vZGVzXSkgewogICAgICAgIGlmIChuLm5vZGVUeXBlID09PSAzKSB7IGlmICghbi5kYXRhKSBuLnJlbW9",
"2ZSgpOyBjb250aW51ZTsgfQogICAgICAgIGlmIChuLm5vZGVUeXBlICE9PSAxIHx8IG4udGFnTmFtZSA9PT0gJ0JSJykgeyBuLnJlbW92ZSgpOyBjb250aW51ZTsgfQogICAgICAgIHBydW5lKG4pOwogICAgICAgIGlmICghbi5maXJzdENoaWxkKSBuLnJlbW92ZSgpOwogICAgICB9CiAgICB9CiAgICBjb25zdCBob2xkT3BlbiA9IGVsID0-IHsgaWYgKCFlbC5maXJzdENoaWxkKSBlbC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdicicpKTsgfTsKCiAgICBmdW5jdGlvbiBpbnNlcnREb2MoZG9jKSB7CiAgICAgIGlmICghcmFuZ2UoKSkgcmVzdG9yZSgpOwogICAgICBpZiAoIXJhbmdlKCkpIHJldHVybjsKICAgICAgY29uc3QgdW5kbyA9IHBhc3RlVW5kbzsKICAgICAgY29uc3QgYmVmb3JlID0gc25hcHNob3QoKTsKICAgICAgaWYgKCFyYW5nZSgpLmNvbGxhcHNlZCkgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2RlbGV0ZScpOwogICAgICB0aWR5KCk7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKCiAgICAgIGxldCBub2RlID0gci5zdGFydENvbnRhaW5lcjsKICAgICAgbGV0IG9mZnNldCA9IHIuc3RhcnRPZmZzZXQ7CiAgICAgIGlmIChub2RlID09PSBlbHMuZWRpdG9yKSB7CiAgICAgICAgY29uc3Qga2lkcyA9IGVscy5lZGl0b3IuY2hpbGRyZW47CiAgICAgICAgY29uc3QgayA9IE1hdGgubWluKG9mZnNldCwga2lkcy5sZW5ndGggLSAxKTsKICAgICAgICBub2R",
"lID0ga2lkc1trXTsKICAgICAgICBvZmZzZXQgPSBrIDwgb2Zmc2V0ID8gbm9kZS5jaGlsZE5vZGVzLmxlbmd0aCA6IDA7CiAgICAgIH0KICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihub2RlKTsKICAgICAgaWYgKCFibGspIHJldHVybjsKCiAgICAgIC8vIEN1dCB0aGUgYmxvY2sgYXQgdGhlIGNhcmV0LgogICAgICBjb25zdCBjdXQgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBjdXQuc2V0U3RhcnQobm9kZSwgb2Zmc2V0KTsKICAgICAgY3V0LnNldEVuZChibGssIGJsay5jaGlsZE5vZGVzLmxlbmd0aCk7CiAgICAgIGNvbnN0IGFmdGVyID0gY3V0LmV4dHJhY3RDb250ZW50cygpOwogICAgICBwcnVuZShhZnRlcik7CiAgICAgIHBydW5lKGJsayk7CgogICAgICBjb25zdCBvcmlnID0geyB0eXBlOiBibGsuZGF0YXNldC50eXBlIHx8ICdwJywgbGV2ZWw6IE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMCwgY2hlY2tlZDogYmxrLmRhdGFzZXQuY2hlY2tlZCA9PT0gJzEnIH07CiAgICAgIC8vIExpc3RzIHBhc3RlZCBpbnRvIGEgbGlzdCBnbyBpbiBhdCBpdHMgbGV2ZWwuCiAgICAgIGNvbnN0IGJhc2UgPSBmbXQuTElTVFMuaGFzKG9yaWcudHlwZSkgPyBvcmlnLmxldmVsIDogMDsKICAgICAgY29uc3QgbGV2ZWxPZiA9IGIgPT4gKGZtdC5MSVNUUy5oYXMoYi50eXBlKSA_IE1hdGgubWluKGZtdC5NQVhfTEVWRUwsIGIubGV2ZWwgKyBiYXNlKSA6IDApOwoKICAgICAgbGV0IGxhc3QgPSBibGs7CiAgICA",
"gIGxldCBpID0gMDsKICAgICAgLy8gVGhlIGZpcnN0IGxpbmUgam9pbnMgdGhlIHRleHQgYmVmb3JlIHRoZSBjYXJldDsgb24gYW4gZW1wdHkgbGluZQogICAgICAvLyBpdCBhbHNvIGJyaW5ncyBpdHMga2luZCAoYSBoZWFkaW5nLCBhIGxpc3QgaXRlbSkgd2l0aCBpdC4KICAgICAgaWYgKGRvY1swXS50eXBlID09PSAncCcgfHwgIWJsay50ZXh0Q29udGVudCkgewogICAgICAgIGlmICghYmxrLnRleHRDb250ZW50ICYmIGRvY1swXS50eXBlICE9PSAncCcpIHNldEJsb2NrKGJsaywgZG9jWzBdLnR5cGUsIGxldmVsT2YoZG9jWzBdKSwgZG9jWzBdLmNoZWNrZWQpOwogICAgICAgIGJsay5hcHBlbmQoLi4uaW5saW5lTm9kZXMoZG9jWzBdLnJ1bnMpKTsKICAgICAgICBpID0gMTsKICAgICAgfQogICAgICBmb3IgKDsgaSA8IGRvYy5sZW5ndGg7IGkrKykgewogICAgICAgIGNvbnN0IGVsID0gYmxvY2tFbCh7IC4uLmRvY1tpXSwgbGV2ZWw6IGxldmVsT2YoZG9jW2ldKSB9KTsKICAgICAgICBsYXN0LmFmdGVyKGVsKTsKICAgICAgICBsYXN0ID0gZWw7CiAgICAgIH0KCiAgICAgIC8vIFRoZSB0ZXh0IGFmdGVyIHRoZSBjYXJldCBmb2xsb3dzIHRoZSBwYXN0ZWQgdGV4dCAtIG9uIGEgbGluZSBvZgogICAgICAvLyBpdHMgb3duIGtpbmQgaWYgdGhlIHBhc3RlIGVuZGVkIG9uIGEgZGlmZmVyZW50IGtpbmQgb2YgbGluZS4KICAgICAgY29uc3Qga2luZCA9IGVsID0-IGAke2VsLmRhdGFzZXQudHlwZX06JHtlbC5kYXRhc2V0Lmx",
"ldmVsIHx8IDB9YDsKICAgICAgbGV0IHRhcmdldCA9IGxhc3Q7CiAgICAgIGlmIChhZnRlci50ZXh0Q29udGVudCAmJiBsYXN0ICE9PSBibGsgJiYga2luZChsYXN0KSAhPT0gYCR7b3JpZy50eXBlfToke2Jhc2V9YCkgewogICAgICAgIHRhcmdldCA9IGJsb2NrRWwoZm10LmJsb2NrKG9yaWcudHlwZSwgW10sIG9yaWcpKTsKICAgICAgICB0YXJnZXQucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgICAgbGFzdC5hZnRlcih0YXJnZXQpOwogICAgICB9CiAgICAgIHBydW5lKGxhc3QpOwogICAgICBjb25zdCBhdCA9IHRhcmdldCA9PT0gbGFzdCA_IGxhc3QuY2hpbGROb2Rlcy5sZW5ndGggOiAwOwogICAgICB0YXJnZXQuYXBwZW5kKGFmdGVyKTsKICAgICAgaG9sZE9wZW4oYmxrKTsKICAgICAgaG9sZE9wZW4obGFzdCk7CiAgICAgIGhvbGRPcGVuKHRhcmdldCk7CiAgICAgIGlmICh0YXJnZXQgPT09IGxhc3QpIHBsYWNlQ2FyZXQobGFzdCwgYXQpOwogICAgICBlbHNlIHBsYWNlQ2FyZXQobGFzdCwgbGFzdC5maXJzdENoaWxkLm5vZGVOYW1lID09PSAnQlInID8gMCA6IGxhc3QuY2hpbGROb2Rlcy5sZW5ndGgpOwoKICAgICAgY2hhbmdlZCgpOwogICAgICBwYXN0ZVVuZG8gPSBbLi4udW5kby5zbGljZSgtMTkpLCBiZWZvcmVdOwogICAgfQoKICAgIC8vIFRoZSBlZGl0b3IncyBibG9ja3MsIGFuZCB0aGUgc2VsZWN0aW9uIGFzIHRleHQgb2Zmc2V0cyB3aXRoaW4gdGhlbS4KICAgIGZ1bmN0aW9uIHNuYXBzaG90KCkgewogICA",
"gICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgcmV0dXJuIHsKICAgICAgICBub2RlczogWy4uLmVscy5lZGl0b3IuY2hpbGROb2Rlc10ubWFwKG4gPT4gbi5jbG9uZU5vZGUodHJ1ZSkpLAogICAgICAgIHN0YXJ0OiByICYmIHdoZXJlKHIuc3RhcnRDb250YWluZXIsIHIuc3RhcnRPZmZzZXQpLAogICAgICAgIGVuZDogciAmJiB3aGVyZShyLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXQpLAogICAgICB9OwogICAgfQoKICAgIGZ1bmN0aW9uIHdoZXJlKG5vZGUsIG9mZnNldCkgewogICAgICBjb25zdCBraWRzID0gWy4uLmVscy5lZGl0b3IuY2hpbGROb2Rlc107CiAgICAgIGlmIChub2RlID09PSBlbHMuZWRpdG9yKSB7CiAgICAgICAgY29uc3QgayA9IE1hdGgubWluKG9mZnNldCwga2lkcy5sZW5ndGggLSAxKTsKICAgICAgICByZXR1cm4gayA8IDAgPyBudWxsIDogeyBiOiBrLCBvOiBrIDwgb2Zmc2V0ID8ga2lkc1trXS50ZXh0Q29udGVudC5sZW5ndGggOiAwIH07CiAgICAgIH0KICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihub2RlKTsKICAgICAgaWYgKCFibGspIHJldHVybiBudWxsOwogICAgICBjb25zdCBwcmUgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcmUuc2VsZWN0Tm9kZUNvbnRlbnRzKGJsayk7CiAgICAgIHByZS5zZXRFbmQobm9kZSwgb2Zmc2V0KTsKICAgICAgcmV0dXJuIHsgYjoga2lkcy5pbmRleE9mKGJsayksIG86IHByZS50b1N0cmluZygpLmxlbmd0aCB9OwogICAgfQoKICAgIGZ",
"1bmN0aW9uIHBvaW50QXQocCkgewogICAgICBjb25zdCBibGsgPSBwICYmIGVscy5lZGl0b3IuY2hpbGROb2Rlc1twLmJdOwogICAgICBpZiAoIWJsaykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIoYmxrLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7CiAgICAgIGxldCBsZWZ0ID0gcC5vOwogICAgICBmb3IgKGxldCBuID0gd2Fsa2VyLm5leHROb2RlKCk7IG47IG4gPSB3YWxrZXIubmV4dE5vZGUoKSkgewogICAgICAgIGlmIChsZWZ0IDw9IG4uZGF0YS5sZW5ndGgpIHJldHVybiBbbiwgbGVmdF07CiAgICAgICAgbGVmdCAtPSBuLmRhdGEubGVuZ3RoOwogICAgICB9CiAgICAgIHJldHVybiBbYmxrLCAwXTsKICAgIH0KCiAgICBmdW5jdGlvbiB1bmRvUGFzdGUoKSB7CiAgICAgIGNvbnN0IHJlc3QgPSBwYXN0ZVVuZG8uc2xpY2UoMCwgLTEpOwogICAgICBjb25zdCBzbmFwID0gcGFzdGVVbmRvW3Bhc3RlVW5kby5sZW5ndGggLSAxXTsKICAgICAgZWxzLmVkaXRvci5yZXBsYWNlQ2hpbGRyZW4oLi4uc25hcC5ub2Rlcyk7CiAgICAgIGNvbnN0IGEgPSBwb2ludEF0KHNuYXAuc3RhcnQpOwogICAgICBjb25zdCB6ID0gcG9pbnRBdChzbmFwLmVuZCk7CiAgICAgIGlmIChhICYmIHopIHsKICAgICAgICBjb25zdCBiYWNrID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICBiYWNrLnNldFN0YXJ0KC4uLmEpOwogICAgICAgIGJhY2suc2V0RW5kKC4uLnopOwo",
"gICAgICAgIHNlbGVjdChiYWNrKTsKICAgICAgfQogICAgICBjaGFuZ2VkKCk7CiAgICAgIHBhc3RlVW5kbyA9IHJlc3Q7CiAgICAgIHJldmVhbENhcmV0KCk7CiAgICB9CgogICAgLy8gU2Nyb2xscyB0aGUgZWRpdG9yLCBpZiBpdCBoYXMgdG8sIHRvIHNob3cgdGhlIGNhcmV0LgogICAgZnVuY3Rpb24gcmV2ZWFsQ2FyZXQoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgbGV0IGF0ID0gci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgaWYgKCFhdC5oZWlnaHQpIHsKICAgICAgICBjb25zdCBibGsgPSBibG9ja09mKHIuc3RhcnRDb250YWluZXIpOwogICAgICAgIGlmIChibGspIGF0ID0gYmxrLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICB9CiAgICAgIGNvbnN0IGJveCA9IGVscy5lZGl0b3IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICAgIGlmIChhdC5ib3R0b20gPiBib3guYm90dG9tIC0gOCkgZWxzLmVkaXRvci5zY3JvbGxUb3AgKz0gYXQuYm90dG9tIC0gYm94LmJvdHRvbSArIDI0OwogICAgICBlbHNlIGlmIChhdC50b3AgPCBib3gudG9wICsgOCkgZWxzLmVkaXRvci5zY3JvbGxUb3AgLT0gYm94LnRvcCAtIGF0LnRvcCArIDI0OwogICAgfQoKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBlID0-IHsKICAgICAgY29uc3QgYSA9IGUudGFyZ2V0LmNsb3Nlc3QgJiYgZS50YXJnZXQuY2xvc2VzdCgnYVtocmV",
"mXScpOwogICAgICBpZiAoYSAmJiAoZS5jdHJsS2V5IHx8IGUubWV0YUtleSkpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgd2luZG93Lm9wZW4oYS5ocmVmLCAnX2JsYW5rJywgJ25vb3BlbmVyJyk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIC8vIFRoZSBib3ggaXMgZHJhd24gaW4gdGhlIGJsb2NrJ3MgbGVmdCBwYWRkaW5nLCBhdCBpdHMgaW5kZW50LgogICAgICBjb25zdCBibGsgPSBlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0LmNsb3Nlc3QoJy5ibGtbZGF0YS10eXBlPSJjaGVjayJdJyk7CiAgICAgIGlmIChibGsgJiYgZWRpdGFibGUpIHsKICAgICAgICBjb25zdCB4ID0gZS5jbGllbnRYIC0gYmxrLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmxlZnQ7CiAgICAgICAgY29uc3QgYXQgPSAoTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwKSAqIElOREVOVF9QWDsKICAgICAgICBpZiAoeCA-PSBhdCAmJiB4IDwgYXQgKyAyNikgdG9nZ2xlQ2hlY2soYmxrKTsKICAgICAgfQogICAgfSk7CgogICAgY29uc3Qgb25TZWxlY3Rpb24gPSAoKSA9PiB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBpZiAoIXIpIHJldHVybjsKICAgICAgc2F2ZWQgPSByLmNsb25lUmFuZ2UoKTsKICAgICAgcmVmcmVzaFRvb2xiYXIoKTsKICAgIH07CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdzZWxlY3Rpb25jaGFuZ2UnLCBvblNlbGVjdGlvbik7CgogICAgLy8g4pSA4pS",
"AIFNlYXJjaCBoaWdobGlnaHRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgLy8KICAgIC8vIFBhaW50ZWQgd2l0aCB0aGUgQ1NTIEN1c3RvbSBIaWdobGlnaHQgQVBJOiByYW5nZXMgb3ZlciB0aGUgdGV4dCwKICAgIC8vIGNvbG91cmVkIGJ5IHRoZSBzdHlsZXNoZWV0LCB3aXRoIG5vdGhpbmcgYWRkZWQgdG8gdGhlIG1hcmt1cCAtIHNvIGEKICAgIC8vIGhpZ2hsaWdodCBjYW4gbmV2ZXIgZW5kIHVwIHNhdmVkIGludG8gdGhlIG5vdGUuCgogICAgbGV0IG1hdGNoUmFuZ2VzID0gW107CiAgICBjb25zdCBjYW5IaWdobGlnaHQgPSAoKSA9PiB0eXBlb2YgQ1NTICE9PSAndW5kZWZpbmVkJyAmJiBDU1MuaGlnaGxpZ2h0cyAmJiB0eXBlb2YgSGlnaGxpZ2h0ID09PSAnZnVuY3Rpb24nOwoKICAgIC8vIFRoZSBlZGl0b3IncyB0ZXh0IHdpdGggYSBsaW5lIGJyZWFrIGJldHdlZW4gYmxvY2tzLCBhbmQgd2hlcmUgZWFjaAogICAgLy8gdGV4dCBub2RlIHNpdHMgaW4gaXQuCiAgICBmdW5jdGlvbiB0ZXh0SW5kZXgoKSB7CiAgICAgIGNvbnN0IHBhcnRzID0gW107CiAgICAgIGxldCB0ZXh0ID0gJyc7CiAgICAgIGVscy5lZGl0b3IuY2hpbGROb2Rlcy5mb3JFYWNoKChibGssIGIpID0-IHsKICAgICAgICBpZiA",
"oYikgdGV4dCArPSAnXG4nOwogICAgICAgIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIoYmxrLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7CiAgICAgICAgZm9yIChsZXQgbiA9IHdhbGtlci5uZXh0Tm9kZSgpOyBuOyBuID0gd2Fsa2VyLm5leHROb2RlKCkpIHsKICAgICAgICAgIHBhcnRzLnB1c2goeyBub2RlOiBuLCBzdGFydDogdGV4dC5sZW5ndGgsIGVuZDogdGV4dC5sZW5ndGggKyBuLmRhdGEubGVuZ3RoIH0pOwogICAgICAgICAgdGV4dCArPSBuLmRhdGE7CiAgICAgICAgfQogICAgICB9KTsKICAgICAgcmV0dXJuIHsgdGV4dCwgcGFydHMgfTsKICAgIH0KCiAgICBmdW5jdGlvbiByYW5nZUZvcihpZHgsIHN0YXJ0LCBlbmQpIHsKICAgICAgY29uc3QgYSA9IGlkeC5wYXJ0cy5maW5kKHAgPT4gc3RhcnQgPj0gcC5zdGFydCAmJiBzdGFydCA8IHAuZW5kKTsKICAgICAgY29uc3QgYiA9IGlkeC5wYXJ0cy5maW5kKHAgPT4gZW5kID4gcC5zdGFydCAmJiBlbmQgPD0gcC5lbmQpOwogICAgICBpZiAoIWEgfHwgIWIpIHJldHVybiBudWxsOwogICAgICBjb25zdCByID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgci5zZXRTdGFydChhLm5vZGUsIHN0YXJ0IC0gYS5zdGFydCk7CiAgICAgIHIuc2V0RW5kKGIubm9kZSwgZW5kIC0gYi5zdGFydCk7CiAgICAgIHJldHVybiByOwogICAgfQoKICAgIGZ1bmN0aW9uIGhpZ2hsaWdodCh0ZXJtcykgewogICAgICBjbGVhckhpZ2hsaWdodHMoKTs",
"KICAgICAgaWYgKCF0ZXJtcyB8fCAhdGVybXMubGVuZ3RoIHx8ICFjYW5IaWdobGlnaHQoKSkgcmV0dXJuIDA7CiAgICAgIGNvbnN0IGlkeCA9IHRleHRJbmRleCgpOwogICAgICBtYXRjaFJhbmdlcyA9IG5zLnNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKGlkeC50ZXh0LCB0ZXJtcykubWFwKG0gPT4gcmFuZ2VGb3IoaWR4LCBtLnN0YXJ0LCBtLmVuZCkpLmZpbHRlcihCb29sZWFuKTsKICAgICAgaWYgKG1hdGNoUmFuZ2VzLmxlbmd0aCkgQ1NTLmhpZ2hsaWdodHMuc2V0KCdna2ItbWF0Y2gnLCBuZXcgSGlnaGxpZ2h0KC4uLm1hdGNoUmFuZ2VzKSk7CiAgICAgIHJldHVybiBtYXRjaFJhbmdlcy5sZW5ndGg7CiAgICB9CgogICAgLy8gTWFya3Mgb25lIG1hdGNoIGFzIHRoZSBjdXJyZW50IG9uZSBhbmQgc2Nyb2xscyBpdCBpbnRvIHRoZSBtaWRkbGUKICAgIC8vIHRoaXJkIG9mIHRoZSBlZGl0b3IgaWYgaXQgaXMgb3V0IG9mIHZpZXcuCiAgICBmdW5jdGlvbiBzaG93TWF0Y2goaSkgewogICAgICBjb25zdCByID0gbWF0Y2hSYW5nZXNbaV07CiAgICAgIGlmICghciB8fCAhY2FuSGlnaGxpZ2h0KCkpIHJldHVybjsKICAgICAgQ1NTLmhpZ2hsaWdodHMuc2V0KCdna2ItbWF0Y2gtY3VycmVudCcsIG5ldyBIaWdobGlnaHQocikpOwogICAgICBjb25zdCBib3ggPSBlbHMuZWRpdG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICBjb25zdCBhdCA9IHIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICAgIGlmIChhdC5",
"0b3AgPCBib3gudG9wICsgMjQgfHwgYXQuYm90dG9tID4gYm94LmJvdHRvbSAtIDI0KSB7CiAgICAgICAgZWxzLmVkaXRvci5zY3JvbGxUb3AgKz0gYXQudG9wIC0gYm94LnRvcCAtIGJveC5oZWlnaHQgLyAzOwogICAgICB9CiAgICB9CgogICAgZnVuY3Rpb24gY2xlYXJIaWdobGlnaHRzKCkgewogICAgICBtYXRjaFJhbmdlcyA9IFtdOwogICAgICBpZiAoIWNhbkhpZ2hsaWdodCgpKSByZXR1cm47CiAgICAgIENTUy5oaWdobGlnaHRzLmRlbGV0ZSgnZ2tiLW1hdGNoJyk7CiAgICAgIENTUy5oaWdobGlnaHRzLmRlbGV0ZSgnZ2tiLW1hdGNoLWN1cnJlbnQnKTsKICAgIH0KCiAgICAvLyDilIDilIAgQVBJIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGZ1bmN0aW9uIHNldERvYyhkb2MpIHsKICAgICAgcGFzdGVVbmRvID0gW107CiAgICAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKC4uLmZtdC5ub3JtYWxpc2VEb2MoZG9jKS5tYXAoYmxvY2tFbCkpOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIGZ1bmN0aW9uIHNldEVkaXRhYmxlKG9uLCBwbGFjZWhvbGRlcikgewogICAgICBlZGl0YWJsZSA9ICEhb247CiA",
"gICAgIGVscy5lZGl0b3IuY29udGVudEVkaXRhYmxlID0gZWRpdGFibGUgPyAndHJ1ZScgOiAnZmFsc2UnOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQucGxhY2Vob2xkZXIgPSBwbGFjZWhvbGRlciB8fCAnV3JpdGUgaGVyZeKApic7CiAgICAgIGVscy5lZGl0b3Iuc2V0QXR0cmlidXRlKCdhcmlhLWRpc2FibGVkJywgU3RyaW5nKCFlZGl0YWJsZSkpOwogICAgICBmb3IgKGNvbnN0IGIgb2YgWy4uLmVscy50b29sYmFyLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpXSkgYi5kaXNhYmxlZCA9ICFlZGl0YWJsZTsKICAgIH0KCiAgICBmdW5jdGlvbiBmb2N1cygpIHsKICAgICAgZWxzLmVkaXRvci5mb2N1cygpOwogICAgICBjb25zdCBmaXJzdCA9IGVscy5lZGl0b3IuZmlyc3RDaGlsZDsKICAgICAgaWYgKGZpcnN0KSBwbGFjZUNhcmV0KGZpcnN0LCAwKTsKICAgIH0KCiAgICBmdW5jdGlvbiBkZXN0cm95KCkgewogICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKCdzZWxlY3Rpb25jaGFuZ2UnLCBvblNlbGVjdGlvbik7CiAgICAgIGNsZWFySGlnaGxpZ2h0cygpOwogICAgICBjbG9zZU1lbnUocm9vdCk7CiAgICB9CgogICAgcmV0dXJuIHsKICAgICAgZWxlbWVudDogZWxzLmVkaXRvciwKICAgICAgdG9vbGJhcjogZWxzLnRvb2xiYXIsCiAgICAgIGxpbmtiYXI6IGVscy5saW5rYmFyLAogICAgICBzZXREb2MsCiAgICAgIGdldERvYzogKCkgPT4gcmVhZERvYyhlbHMuZWRpdG9yKSwKICAgICAgc2V0RWRpdGF",
"ibGUsCiAgICAgIGZvY3VzLAogICAgICBkZXN0cm95LAogICAgICBoaWdobGlnaHQsCiAgICAgIHNob3dNYXRjaCwKICAgICAgY2xlYXJIaWdobGlnaHRzLAogICAgICBtYXRjaENvdW50OiAoKSA9PiBtYXRjaFJhbmdlcy5sZW5ndGgsCiAgICB9OwogIH0KCiAgbnMubm90ZUVkaXRvciA9IHsgY3JlYXRlLCByZWFkRG9jIH07Cn0pKCk7Cg\"],[\"addon/app/remote.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyB3YXkgdG8gR21haWwKLy8KLy8gVGhlIE5vdGVzIHZpZXcgKHNyYy9jb250ZW50L25vdGVzLmpzKSB0YWxrcyB0byBhIG5vdGVzU3RvcmUuIEluIHRoZQovLyBleHRlbnNpb24gdGhhdCBzdG9yZSBhc2tzIEdtYWlsIHRocm91Z2ggdGhlIGJhY2tncm91bmQgd29ya2VyOyBoZXJlIGl0Ci8vIGFza3MgdGhlIHNjcmlwdCB0aGF0IHNlcnZlZCB0aGlzIHBhZ2UsIHRocm91Z2ggZ29vZ2xlLnNjcmlwdC5ydW4sIHdoaWNoCi8vIGFza3MgR21haWwuIFNhbWUgc2hhcGUsIHNhbWUgYW5zd2Vycywgc28gdGhlIHZpZXcgcnVucyB1bmNoYW5nZWQuCi8vIE",
"Fsc28gdGhlIHR3byBvdGhlciB0aGluZ3MgdGhlIHZpZXcgZXhwZWN0cyB0byBmaW5kOiBgaG9va3NgICh0aGUKLy8gYWNjb3VudCwgYW5kIG9wZW5pbmcgYSBtZXNzYWdlIGluIEdtYWlsKSBhbmQgYGFwaWAgKHdoaWNoIGVycm9ycyBtZWFuCi8vIHRoZSBhY2NvdW50IG5lZWRzIGF0dGVudGlvbiAtIG5vbmUgZG8gaGVyZSkuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IGZtdCA9IG5zLm5vdGVGb3JtYXQ7CgogIC8vIGdvb2dsZS5zY3JpcHQucnVuIGFzIGEgcHJvbWlzZS4gQSByZWZ1c2FsIGZyb20gdGhlIHNjcmlwdCBhcnJpdmVzIGFzCiAgLy8gIm5vdF9hbGxvd2VkOiDigKYiLCB3aGljaCB0aGUgdmlldyBrbm93cyB0byBleHBsYWluLgogIGZ1bmN0aW9uIGNhbGwoZm4sIC4uLmFyZ3MpIHsKICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICAgIGdvb2dsZS5zY3JpcHQucnVuCiAgIC",
"AgICAgLndpdGhTdWNjZXNzSGFuZGxlcihyZXNvbHZlKQogICAgICAgIC53aXRoRmFpbHVyZUhhbmRsZXIoZXJyID0-IHsKICAgICAgICAgIGNvbnN0IHRleHQgPSBTdHJpbmcoKGVyciAmJiBlcnIubWVzc2FnZSkgfHwgZXJyIHx8ICdTb21ldGhpbmcgd2VudCB3cm9uZycpLnJlcGxhY2UoL14oRXhjZXB0aW9ufEVycm9yKTpccyovLCAnJyk7CiAgICAgICAgICBjb25zdCBlID0gbmV3IEVycm9yKHRleHQucmVwbGFjZSgvXm5vdF9hbGxvd2VkOlxzKi8sICcnKSk7CiAgICAgICAgICBpZiAoL15ub3RfYWxsb3dlZDovLnRlc3QodGV4dCkpIGUuY29kZSA9ICdub3RfYWxsb3dlZCc7CiAgICAgICAgICByZWplY3QoZSk7CiAgICAgICAgfSlbZm5dKC4uLmFyZ3MpOwogICAgfSk7CiAgfQoKICBjb25zdCBTID0gewogICAgbGFiZWw6ICdfTm90ZXMnLAogICAgZm9sZGVyczogW10sCiAgICBkb2NzOiBuZXcgTWFwKCksIC8vIG1lc3NhZ2UgaWQg4oaSIGNvbnRlbnQsIGZyb20gYSBzZWFyY2ggb3IgYSBzYXZlCiAgfTsKCiAgbnMubm90ZXNTdG9yZSA9IHsKICAgIGxhYmVsTmFtZTogKCkgPT4gUy5sYWJlbCwKICAgIGZvbGRlcnM6ICgpID0-IFMuZm9sZGVycywKCiAgICBhc3luYyBsaXN0KGFjY291bnQsIHF1ZXJ5KSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBjYWxsKCdhcHBMaXN0JywgcXVlcnkgfHwgJycpOwogICAgICBTLmxhYmVsID0gci5sYWJlbDsKICAgICAgUy5mb2xkZXJzID0gci5mb2xkZXJzIHx8IFtdOwogICAgIC",
"BPYmplY3Qua2V5cyhyLmRvY3MgfHwge30pLmZvckVhY2goaWQgPT4gUy5kb2NzLnNldChpZCwgci5kb2NzW2lkXSkpOwogICAgICByZXR1cm4geyBub3Rlczogci5ub3RlcywgdHJ1bmNhdGVkOiByLnRydW5jYXRlZCwgZm9sZGVyczogUy5mb2xkZXJzIH07CiAgICB9LAoKICAgIC8vIE1lc3NhZ2VzIG5ldmVyIGNoYW5nZSwgc28gYSBub3RlJ3MgY29udGVudCwgb25jZSByZWFkLCBpcyBrZXB0LgogICAgYXN5bmMgYm9keShub3RlKSB7CiAgICAgIGlmIChTLmRvY3MuaGFzKG5vdGUubWVzc2FnZUlkKSkgcmV0dXJuIFMuZG9jcy5nZXQobm90ZS5tZXNzYWdlSWQpOwogICAgICBjb25zdCBkb2MgPSBhd2FpdCBjYWxsKCdhcHBCb2R5Jywgbm90ZS5tZXNzYWdlSWQpOwogICAgICBTLmRvY3Muc2V0KG5vdGUubWVzc2FnZUlkLCBkb2MpOwogICAgICByZXR1cm4gZG9jOwogICAgfSwKCiAgICBhc3luYyBzYXZlKGFjY291bnQsIHByZXZpb3VzLCBzbmFwKSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBjYWxsKCdhcHBTYXZlJywgcHJldmlvdXMgPyBwcmV2aW91cy5tZXNzYWdlSWQgOiAnJywgewogICAgICAgIHRpdGxlOiBzbmFwLnRpdGxlLCBkb2M6IGZtdC5ub3JtYWxpc2VEb2Moc25hcC5kb2MpLCBmb2xkZXJJZDogc25hcC5mb2xkZXJJZCB8fCAnJywKICAgICAgfSk7CiAgICAgIFMuZG9jcy5zZXQoci5ub3RlLm1lc3NhZ2VJZCwgZm10Lm5vcm1hbGlzZURvYyhzbmFwLmRvYykpOwogICAgICByZXR1cm4gci5ub3RlOwogIC",
"AgfSwKCiAgICBhc3luYyByZXRpcmUobm90ZSkgeyBhd2FpdCBjYWxsKCdhcHBSZXRpcmUnLCBub3RlLm1lc3NhZ2VJZCk7IH0sCiAgICBhc3luYyByZXN0b3JlKG5vdGUpIHsgYXdhaXQgY2FsbCgnYXBwUmVzdG9yZScsIG5vdGUubWVzc2FnZUlkLCBub3RlLmZvbGRlcklkIHx8ICcnKTsgfSwKCiAgICBhc3luYyBtb3ZlKG5vdGUsIGZvbGRlcklkKSB7CiAgICAgIGF3YWl0IGNhbGwoJ2FwcE1vdmUnLCBub3RlLm1lc3NhZ2VJZCwgZm9sZGVySWQgfHwgJycpOwogICAgICBub3RlLmZvbGRlcklkID0gZm9sZGVySWQgfHwgJyc7CiAgICB9LAoKICAgIGFzeW5jIGNyZWF0ZUZvbGRlcihwYXJlbnQsIHRpdGxlKSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBjYWxsKCdhcHBDcmVhdGVGb2xkZXInLCBwYXJlbnQgPyBwYXJlbnQuaWQgOiAnJywgdGl0bGUpOwogICAgICBTLmZvbGRlcnMgPSByLmZvbGRlcnM7CiAgICAgIHJldHVybiByLmZvbGRlcjsKICAgIH0sCgogICAgYXN5bmMgcmVuYW1lRm9sZGVyKGZvbGRlciwgdGl0bGUpIHsKICAgICAgUy5mb2xkZXJzID0gKGF3YWl0IGNhbGwoJ2FwcFJlbmFtZUZvbGRlcicsIGZvbGRlci5pZCwgdGl0bGUpKS5mb2xkZXJzOwogICAgfSwKCiAgICBhc3luYyBkZWxldGVGb2xkZXIoZm9sZGVyKSB7CiAgICAgIFMuZm9sZGVycyA9IChhd2FpdCBjYWxsKCdhcHBEZWxldGVGb2xkZXInLCBmb2xkZXIuaWQpKS5mb2xkZXJzOwogICAgfSwKICB9OwoKICBucy5ob29rcyA9IHsKICAgIGdldE",
"FjY291bnQ6ICgpID0-ICcnLAogICAgLy8gVGhlIG1lc3NhZ2UgaW4gR21haWwgLSB3aGljaCwgb24gYSBwaG9uZSwgdGhlIEdtYWlsIGFwcCBtYXkgb2ZmZXIgdG8gb3Blbi4KICAgIG9wZW5UaHJlYWQodGhyZWFkSWQpIHsKICAgICAgd2luZG93Lm9wZW4oYGh0dHBzOi8vbWFpbC5nb29nbGUuY29tL21haWwvdS8wLyNhbGwvJHtlbmNvZGVVUklDb21wb25lbnQodGhyZWFkSWQpfWAsICdfYmxhbmsnLCAnbm9vcGVuZXInKTsKICAgIH0sCiAgfTsKCiAgbnMuYXBpID0geyBTVEFURV9DT0RFUzogbmV3IFNldCgpIH07Cn0pKCk7Cg\"],[\"src/content/notes.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBub3RlcyB2aWV3Ci8vCi8vIFRoZSBib2FyZCdzIHNlY29uZCB0YWI6IGZvbGRlcnMgb24gdGhlIGxlZnQsIHRoZW4gdGhlIG5vdGVzIGluIHRoZQovLyBjaG9zZW4gZm9sZGVyLCB0aGVuIHRoZSBvcGVuIG5vdGUuIFR5cGluZyBzYXZlcyBieSBpdHNlbGYgYSBtb21lbnQgYWZ0ZXIKLy8geW91IHN0b3AsIGFuZCBhZ2FpbiBvbiBzd2l0Y2hpbmcgbm90ZXMsIHN3aXRjaGlu",
"ZyB0YWJzIG9yIGNsb3Npbmc7Ci8vIEN0cmwrUyBzYXZlcyBhdCBvbmNlLiBBIG5vdGUgbW92ZXMgdG8gYW5vdGhlciBmb2xkZXIgYnkgZHJhZ2dpbmcgaXQgb250bwovLyBvbmUsIG9yIGZyb20gdGhlIGZvbGRlciBidXR0b24gYWJvdmUgdGhlIHRleHQuCi8vCi8vIFRoZSBib2FyZCBvd25zIHRoZSBvdmVybGF5LCB0aGUgaGVhZGVyIGFuZCB0aGUgYWNjb3VudCBwYW5lbHMgKHNldHVwLAovLyBjb25uZWN0KTsgdGhpcyBmaWxlIG93bnMgZXZlcnl0aGluZyBpbnNpZGUgdGhlIGJvZHkgd2hpbGUgdGhlIE5vdGVzIHRhYgovLyBpcyBzaG93aW5nLiBJdHMgZWxlbWVudCBpcyBidWlsdCBvbmNlIGFuZCBrZXB0LCBzbyB0aGF0IGEgYm9hcmQgcmVkcmF3Ci8vIG5ldmVyIHB1bGxzIHRoZSB0ZXh0IGJveCBvdXQgZnJvbSB1bmRlciBzb21lb25lIHdobyBpcyB0eXBpbmcuCi8vCi8vIFRoZSBwaG9uZSBhcHAgKGFkZG9uL2FwcCkgcnVucyB0aGlzIHNhbWUgdmlldyBmdWxsLXNjcmVlbiBvbiBhIHBob25lLAovLyB3aXRoIGEgZGlmZmVyZW50IHdheSB0byBHbWFpbCBiZWhpbmQgbm90ZXNTdG9yZS4gQSBwaG9uZSBzaG93cyBvbmUgcGFuZQovLyBhdCBhIHRpbWUgLSB0aGUgbGlzdCwgb3IgdGhlIG9wZW4gbm90ZSAtIHNvIHRoZSBlbGVtZW50IHNheXMgd2hpY2gKLy8gKGRhdGEtdmlldykgYW5kIHRoZSBub3RlIGhhcyBhIEJhY2sgYnV0dG9uLCB3aGljaCBvbmx5IHRoZSBwaG9uZSdzCi8vIHN0eWxlc2hlZXQgc2hvd3MuCi8v",
"IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgdG9hc3QsIG9wZW5NZW51IH0gPSBucy51aTsKICBjb25zdCB7IHV0aWwsIG5vdGVzTG9naWMsIG5vdGVzU3RvcmUsIGhvb2tzLCBhcGkgfSA9IG5zOwogIGNvbnN0IGZtdCA9IG5zLm5vdGVGb3JtYXQ7CiAgY29uc3Qgc2VhcmNoTG9naWMgPSBucy5zZWFyY2hMb2dpYzsKCiAgLy8gSG93IG1hbnkgc2VhcmNoIHJlc3VsdHMgZ2V0IGV4Y2VycHRzIGF0IG9uY2UuIEVhY2ggbmVlZHMgdGhlIG5vdGUncwogIC8vIGZ1bGwgdGV4dCwgd2hpY2ggaXMgb25lIG1vcmUgcmVxdWVzdCB0aGUgZmlyc3QgdGltZS4KICBjb25zdCBFWENFUlBUX0xJTUlUID0gMzA7CgogIC8vIExvbmcgZW5vdWdoIG5vdCB0byBzYXZlIG1pZC1zZW50ZW5jZSAoZWFjaCBzYXZlIGlzIGEgbmV3IG1lc3NhZ2UgYW5kCiAgLy8gYSB0cmFzaGVkIG9sZCBvbmUpLCBzaG9ydCBlbm91Z2ggdGhhdCBsaXR0",
"bGUgaXMgYXQgcmlzay4KICBjb25zdCBBVVRPU0FWRV9NUyA9IDI1MDA7CiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CgogIGNvbnN0IE4gPSB7CiAgICBjdHg6IG51bGwsICAgICAgICAgIC8vIHsgcm9vdCwgb25TdGF0ZUVycm9yLCBvbkxvYWRlZCwgY2xvc2VCb2FyZCwgYmFyQ2hhbmdlZCB9CiAgICBub3RlczogW10sICAgICAgICAgIC8vIGxpdmUgbm90ZXMsIG5ld2VzdCBmaXJzdCAobWV0YWRhdGEgb25seSkKICAgIHRydW5jYXRlZDogZmFsc2UsCiAgICBxdWVyeTogJycsCiAgICBzdGF0dXM6ICdpZGxlJywgICAgIC8vIGlkbGUgfCBsb2FkaW5nIHwgcmVhZHkgfCBlcnJvcgogICAgZXJyb3I6ICcnLAogICAgbG9hZGVkQXQ6IDAsCiAgICBsb2FkaW5nOiBudWxsLAogICAgY3VycmVudDogbnVsbCwgICAgICAvLyB0aGUgbm90ZSBiZWluZyBlZGl0ZWQgLSBzZWUgbmV3Q3VycmVudCgpCiAgICBjaGFpbjogUHJvbWlzZS5yZXNvbHZlKCksIC8vIHNhdmVzIGFuZCBtb3ZlcyBydW4gb25lIGFmdGVyIGFub3RoZXIKICAgIGZvbGRlcnM6IFtdLCAgICAgICAgLy8gbm90ZXNMb2dpYy5mb2xkZXJUcmVlKCksIGZyb20gdGhlIGxhc3QgbGlzdGluZwogICAgZm9sZGVyOiAnJywgICAgICAgICAvLyB0aGUgZm9sZGVyIHNob3duOyAnJyBmb3IgYWxsIG5vdGVzCiAgICBmb2xkZXJFZGl0OiBudWxsLCAgIC8vIHsgbW9kZTogJ25ldycgfCAncmVuYW1lJywgcGFyZW50SWQsIGZvbGRlcklkLCB2YWx1ZSwgZXJyb3IsIGJ1",
"c3kgfQogICAgZHJhZ0tleTogJycsICAgICAgICAvLyB0aGUgbm90ZSBiZWluZyBkcmFnZ2VkIG9udG8gYSBmb2xkZXIKICAgIHRlcm1zOiBbXSwgICAgICAgICAgLy8gc2VhcmNoTG9naWMucXVlcnlUZXJtcygpIG9mIHRoZSBzZWFyY2ggdGhhdCBpcyBzaG93aW5nCiAgICBoaXRzOiBuZXcgTWFwKCksICAgIC8vIGAke21lc3NhZ2VJZH18JHt0ZXJtc31gIOKGkiB7IGNvdW50LCBleGNlcnB0cyB9CiAgICBmaW5kSW5kZXg6IDAsICAgICAgIC8vIHdoaWNoIG1hdGNoIGluIHRoZSBvcGVuIG5vdGUgaXMgdGhlIGN1cnJlbnQgb25lCiAgfTsKCiAgbGV0IHNhdmVUaW1lciA9IDA7CiAgbGV0IHNlYXJjaFRpbWVyID0gMDsKICBsZXQgZmluZFRpbWVyID0gMDsKICBjb25zdCBlbHMgPSB7fTsKCiAgLy8g4pSA4pSAIFNldHVwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBpbml0KGN0eCkgewogICAgTi5jdHggPSBjdHg7CiAgICBOLnZpZXcgPSAnJzsKICAgIC8vIENsb3NpbmcgdGhlIHRhYiBtaWQtc2VudGVuY2Ugd291bGQgbG9zZSB0aGUgbGFzdCBmZXcgc2Vjb25kcyBvZgogICAgLy8gdHlwaW5nOyB0aGUgYnJvd3NlcidzIG93",
"biAiTGVhdmUgc2l0ZT8iIHByb21wdCBpcyB0aGUgb25seSBkZWZlbmNlLgogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2JlZm9yZXVubG9hZCcsIGUgPT4gewogICAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgICBpZiAoYyAmJiAoYy5kaXJ0eSB8fCBjLnNhdmluZykpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgZS5yZXR1cm5WYWx1ZSA9ICcnOwogICAgICB9CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGVsZW1lbnQoKSB7CiAgICBpZiAoZWxzLndyYXApIHJldHVybiBlbHMud3JhcDsKCiAgICBlbHMuc2VhcmNoID0gaCgnaW5wdXQnLCB7CiAgICAgIHR5cGU6ICdzZWFyY2gnLCBwbGFjZWhvbGRlcjogJ1NlYXJjaCBub3RlcycsICdhcmlhLWxhYmVsJzogJ1NlYXJjaCBub3RlcycsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZXMtc2VhcmNoJyB9LAogICAgICBvbmlucHV0OiBlID0-IHsKICAgICAgICBOLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7CiAgICAgICAgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVyKTsKICAgICAgICBzZWFyY2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gbG9hZCh7IGZvcmNlOiB0cnVlIH0pLCA0MDApOwogICAgICB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGNsZWFyVGltZW91dChzZWFyY2hUaW1lcik7IGxvYWQoeyBmb3JjZTogdHJ1ZSB9KTsgfQogICAg",
"ICB9LAogICAgfSk7CiAgICBlbHMuaXRlbXMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtaXRlbXMnLCByb2xlOiAnbGlzdCcsICdhcmlhLWxhYmVsJzogJ05vdGVzJyB9KTsKICAgIGVscy5mb290ID0gaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLWZvb3QnIH0pOwogICAgZWxzLnNjb3BlID0gaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLXNjb3BlJyB9KTsKCiAgICBlbHMubGlzdCA9IGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiAnbm90ZXMtbGlzdCcsICdhcmlhLWxhYmVsJzogJ05vdGVzJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtdG9vbHMnIH0sCiAgICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3NlYXJjaC1ib3gnIH0sIGljb24oJ3NlYXJjaCcsIDE4KSwgZWxzLnNlYXJjaCksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdidG4gYnRuLXRvbmFsJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS1uZXcnIH0sCiAgICAgICAgICB0aXRsZTogJ05ldyBub3RlJywgb25jbGljazogKCkgPT4gbmV3Tm90ZSgpLAogICAgICAgIH0sIGljb24oJ2FkZCcsIDE4KSwgJ05ldycpKSwKICAgICAgZWxzLnNjb3BlLAogICAgICBlbHMuaXRlbXMsCiAgICAgIGVscy5mb290KTsKCiAgICBlbHMuZm9sZGVySXRlbXMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZm9sZGVyLWl0ZW1zJywgcm9sZTogJ2xpc3QnLCAnYXJpYS1sYWJlbCc6ICdGb2xkZXJzJyB9KTsKICAgIC8vIE9u",
"IGEgcGhvbmUgdGhlIHRyZWUgZm9sZHMgYXdheSBiZWhpbmQgb25lIGJ1dHRvbiB0aGF0IHNheXMgd2hlcmUKICAgIC8vIHlvdSBhcmU7IG9ubHkgdGhlIHBob25lJ3Mgc3R5bGVzaGVldCBzaG93cyBpdC4KICAgIGVscy5mb2xkZXJzVG9nZ2xlID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2ZvbGRlcnMtdG9nZ2xlJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywgZGF0YXNldDogeyBrZXk6ICdmb2xkZXJzLXRvZ2dsZScgfSwKICAgICAgb25jbGljazogKCkgPT4gc2V0Rm9sZGVyc09wZW4oZWxzLndyYXAuZGF0YXNldC5mb2xkZXJzICE9PSAnb3BlbicpLAogICAgfSk7CiAgICBlbHMuZm9sZGVyc1BhbmUgPSBoKCdzZWN0aW9uJywgeyBjbGFzczogJ25vdGVzLWZvbGRlcnMnLCAnYXJpYS1sYWJlbCc6ICdGb2xkZXJzJyB9LAogICAgICBlbHMuZm9sZGVyc1RvZ2dsZSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlcnMtaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgdGV4dDogJ0ZvbGRlcnMnIH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGl0bGU6ICdOZXcgZm9sZGVyJywgJ2FyaWEtbGFiZWwnOiAnTmV3IGZvbGRlcicsCiAgICAgICAgICBkYXRhc2V0OiB7IGtleTogJ2ZvbGRlci1uZXcnIH0sIG9uY2xpY2s6ICgpID0-IHN0YXJ0Rm9sZGVyRWRpdCh7IG1vZGU6ICduZXcnLCBwYXJlbnRJ",
"ZDogJycgfSksCiAgICAgICAgfSwgaWNvbignYWRkJywgMjApKSksCiAgICAgIGVscy5mb2xkZXJJdGVtcyk7CgogICAgZWxzLmVkaXRvciA9IGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiAnbm90ZS1lZGl0b3InLCAnYXJpYS1sYWJlbCc6ICdOb3RlJyB9KTsKICAgIGVscy53cmFwID0gaCgnZGl2JywgeyBjbGFzczogJ25vdGVzJywgZGF0YXNldDogeyBmb2xkZXJzOiAnY2xvc2VkJyB9IH0sIGVscy5mb2xkZXJzUGFuZSwgZWxzLmxpc3QsIGVscy5lZGl0b3IpOwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgICBkcmF3RWRpdG9yKCk7CiAgICByZXR1cm4gZWxzLndyYXA7CiAgfQoKICAvLyDilIDilIAgTG9hZGluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaXNTdGFsZSgpIHsKICAgIHJldHVybiBOLnN0YXR1cyAhPT0gJ3JlYWR5JyB8fCBEYXRlLm5vdygpIC0gTi5sb2FkZWRBdCA-IFNUQUxFX01TOwogIH0KCiAgZnVuY3Rpb24gbG9hZCh7IGZvcmNlID0gZmFsc2UgfSA9IHt9KSB7CiAgICBpZiAoTi5sb2FkaW5nKSByZXR1cm4gTi5sb2FkaW5nOwogICAgaWYgKCFmb3JjZSAmJiAhaXNTdGFsZSgpKSByZXR1cm4g",
"UHJvbWlzZS5yZXNvbHZlKCk7CiAgICBjb25zdCBxdWVyeSA9IE4ucXVlcnk7CiAgICBpZiAoIU4ubm90ZXMubGVuZ3RoKSBOLnN0YXR1cyA9ICdsb2FkaW5nJzsKICAgIGRyYXdMaXN0KCk7CgogICAgTi5sb2FkaW5nID0gKGFzeW5jICgpID0-IHsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCByID0gYXdhaXQgbm90ZXNTdG9yZS5saXN0KGhvb2tzLmdldEFjY291bnQoKSwgcXVlcnkpOwogICAgICAgIGlmIChxdWVyeSAhPT0gTi5xdWVyeSkgcmV0dXJuOyAvLyBhIG5ld2VyIHNlYXJjaCBoYXMgc3RhcnRlZAogICAgICAgIE4ubm90ZXMgPSByLm5vdGVzOwogICAgICAgIE4udHJ1bmNhdGVkID0gci50cnVuY2F0ZWQ7CiAgICAgICAgTi5mb2xkZXJzID0gci5mb2xkZXJzIHx8IFtdOwogICAgICAgIGNvbnN0IHRlcm1zID0gc2VhcmNoTG9naWMucXVlcnlUZXJtcyhxdWVyeSk7CiAgICAgICAgaWYgKEpTT04uc3RyaW5naWZ5KHRlcm1zKSAhPT0gSlNPTi5zdHJpbmdpZnkoTi50ZXJtcykpIE4uZmluZEluZGV4ID0gMDsKICAgICAgICBOLnRlcm1zID0gdGVybXM7CiAgICAgICAgLy8gVGhlIGZvbGRlciBzaG93biB3YXMgZGVsZXRlZCBvciByZW5hbWVkIGF3YXkgaW4gR21haWwuCiAgICAgICAgaWYgKE4uZm9sZGVyICYmICFOLmZvbGRlcnMuc29tZShmID0-IGYuaWQgPT09IE4uZm9sZGVyKSkgTi5mb2xkZXIgPSAnJzsKICAgICAgICBOLnN0YXR1cyA9ICdyZWFkeSc7CiAgICAgICAgTi5lcnJvciA9ICcnOwogICAgICAg",
"IE4ubG9hZGVkQXQgPSBEYXRlLm5vdygpOwogICAgICAgIGNhdGNoVXBDdXJyZW50KCk7CiAgICAgICAgTi5jdHgub25Mb2FkZWQoKTsKICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSB7CiAgICAgICAgICBOLnN0YXR1cyA9ICdpZGxlJzsKICAgICAgICAgIE4uY3R4Lm9uU3RhdGVFcnJvcihlcnIpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBOLnN0YXR1cyA9IE4ubm90ZXMubGVuZ3RoID8gJ3JlYWR5JyA6ICdlcnJvcic7CiAgICAgICAgTi5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgICAgIGlmIChOLm5vdGVzLmxlbmd0aCkgdG9hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgbG9hZCBub3RlczogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgIH0gZmluYWxseSB7CiAgICAgICAgTi5sb2FkaW5nID0gbnVsbDsKICAgICAgICBkcmF3Rm9sZGVycygpOwogICAgICAgIGRyYXdMaXN0KCk7CiAgICAgICAgZHJhd0Zvb3QoKTsKICAgICAgICBpZiAoTi5jdXJyZW50KSBkcmF3QmFyKCk7CiAgICAgICAgYXBwbHlIaWdobGlnaHRzKCk7CiAgICAgICAgZmV0Y2hIaXRzKCk7CiAgICAgICAgTi5jdHguYmFyQ2hhbmdlZCgpOwogICAgICB9CiAgICB9KSgpOwogICAgLy8gVGhlIHNlYXJjaCBib3ggY2hhbmdlZCB3aGlsZSB0aGlzIHdhcyBpbiBmbGlnaHQsIGFuZCB0aGUgbG9hZCB0aGF0CiAgICAvLyBjaGFu",
"Z2UgYXNrZWQgZm9yIHdhcyB0dXJuZWQgYXdheSBhYm92ZTogcnVuIGl0IG5vdy4KICAgIGNvbnN0IHAgPSBOLmxvYWRpbmc7CiAgICByZXR1cm4gcC50aGVuKCgpID0-IChxdWVyeSAhPT0gTi5xdWVyeSA_IGxvYWQoeyBmb3JjZTogdHJ1ZSB9KSA6IHVuZGVmaW5lZCkpOwogIH0KCiAgLy8gVGhlIG9wZW4gbm90ZSB3YXMgc2F2ZWQgb24gYW5vdGhlciBjb21wdXRlciBzaW5jZSBpdCB3YXMgb3BlbmVkIGhlcmU6CiAgLy8gc2hvdyB0aGUgbmV3ZXIgdGV4dCwgdW5sZXNzIHRoZXJlIGFyZSBlZGl0cyBoZXJlIHRoYXQgd291bGQgYmUgbG9zdC4KICBmdW5jdGlvbiBjYXRjaFVwQ3VycmVudCgpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMgfHwgIWMubm90ZSB8fCBjLmRpcnR5IHx8IGMuc2F2aW5nKSByZXR1cm47CiAgICBjb25zdCBmcmVzaCA9IE4ubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBjLmtleSk7CiAgICBpZiAoZnJlc2ggJiYgZnJlc2gubWVzc2FnZUlkICE9PSBjLm5vdGUubWVzc2FnZUlkKSBvcGVuTm90ZShmcmVzaCwgeyBmb3JjZTogdHJ1ZSB9KTsKICB9CgogIC8vIOKUgOKUgCBUaGUgbGlzdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi",
"lIDilIDilIAKCiAgZnVuY3Rpb24gZm9sZGVyQnlJZChpZCkgewogICAgcmV0dXJuIE4uZm9sZGVycy5maW5kKGYgPT4gZi5pZCA9PT0gaWQpIHx8IG51bGw7CiAgfQoKICAvLyAiV29yayDigLogQ2xpZW50cyIKICBmdW5jdGlvbiBmb2xkZXJMYWJlbChpZCkgewogICAgY29uc3QgZiA9IGZvbGRlckJ5SWQoaWQpOwogICAgcmV0dXJuIGYgPyBmLnBhdGguc3BsaXQoJy8nKS5qb2luKCcgXHUyMDNhICcpIDogJyc7CiAgfQoKICBmdW5jdGlvbiB2aXNpYmxlTm90ZXMoKSB7CiAgICByZXR1cm4gTi5mb2xkZXIgPyBOLm5vdGVzLmZpbHRlcihuID0-IG4uZm9sZGVySWQgPT09IE4uZm9sZGVyKSA6IE4ubm90ZXM7CiAgfQoKICBmdW5jdGlvbiBkcmF3TGlzdCgpIHsKICAgIGlmICghZWxzLml0ZW1zKSByZXR1cm47CiAgICBjb25zdCBjdXJLZXkgPSBOLmN1cnJlbnQgJiYgTi5jdXJyZW50LmtleTsKICAgIGNvbnN0IHNob3duID0gdmlzaWJsZU5vdGVzKCk7CiAgICBjb25zdCBzZWFyY2hpbmcgPSAhIU4ucXVlcnkudHJpbSgpOwogICAgaWYgKGVscy5zY29wZSkgewogICAgICBjb25zdCB3aGVyZSA9IE4uZm9sZGVyID8gZm9sZGVyTGFiZWwoTi5mb2xkZXIpIDogJ0FsbCBub3Rlcyc7CiAgICAgIGVscy5zY29wZS50ZXh0Q29udGVudCA9IE4uc3RhdHVzID09PSAncmVhZHknCiAgICAgICAgPyBgJHt3aGVyZX0gXHUwMGI3ICR7c2hvd24ubGVuZ3RofSAke3NlYXJjaGluZyA_IChzaG93bi5sZW5ndGggPT09IDEgPyAnbWF0Y2gn",
"IDogJ21hdGNoZXMnKSA6IChzaG93bi5sZW5ndGggPT09IDEgPyAnbm90ZScgOiAnbm90ZXMnKX1gCiAgICAgICAgOiB3aGVyZTsKICAgIH0KICAgIGlmIChlbHMuc2VhcmNoKSBlbHMuc2VhcmNoLnBsYWNlaG9sZGVyID0gTi5mb2xkZXIgPyBgU2VhcmNoIGluICR7Zm9sZGVyQnlJZChOLmZvbGRlcikgPyBmb2xkZXJCeUlkKE4uZm9sZGVyKS50aXRsZSA6ICd0aGlzIGZvbGRlcid9YCA6ICdTZWFyY2ggbm90ZXMnOwoKICAgIGlmIChOLnN0YXR1cyA9PT0gJ2xvYWRpbmcnICYmICFOLm5vdGVzLmxlbmd0aCkgewogICAgICBlbHMuaXRlbXMucmVwbGFjZUNoaWxkcmVuKGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1lbXB0eScsIHRleHQ6ICdMb2FkaW5n4oCmJyB9KSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChOLnN0YXR1cyA9PT0gJ2Vycm9yJyAmJiAhTi5ub3Rlcy5sZW5ndGgpIHsKICAgICAgZWxzLml0ZW1zLnJlcGxhY2VDaGlsZHJlbigKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtZW1wdHknIH0sCiAgICAgICAgICBoKCdwJywgeyB0ZXh0OiBgQ291bGRu4oCZdCBsb2FkIG5vdGVzOiAke04uZXJyb3J9YCB9KSwKICAgICAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdidG4gYnRuLXRleHQnLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1RyeSBhZ2FpbicsIG9uY2xpY2s6ICgpID0-IGxvYWQoeyBmb3JjZTogdHJ1ZSB9KSB9KSkpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoIXNob3du",
"Lmxlbmd0aCkgewogICAgICBsZXQgdGV4dCA9IHNlYXJjaGluZyA_ICdObyBub3RlcyBtYXRjaC4nIDogJ05vIG5vdGVzIHlldC4nOwogICAgICBpZiAoTi5mb2xkZXIpIHRleHQgPSBzZWFyY2hpbmcgPyAnTm8gbm90ZXMgaW4gdGhpcyBmb2xkZXIgbWF0Y2guJyA6ICdObyBub3RlcyBpbiB0aGlzIGZvbGRlciB5ZXQuJzsKICAgICAgZWxzLml0ZW1zLnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtZW1wdHknLCB0ZXh0IH0pKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGVscy5pdGVtcy5yZXBsYWNlQ2hpbGRyZW4oLi4uc2hvd24ubWFwKG4gPT4gewogICAgICBjb25zdCBpdGVtID0gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnbm90ZS1pdGVtJywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICdsaXN0aXRlbScsIGRyYWdnYWJsZTogJ3RydWUnLAogICAgICAgICdhcmlhLWN1cnJlbnQnOiBuLmtleSA9PT0gY3VyS2V5ID8gJ3RydWUnIDogbnVsbCwKICAgICAgICBkYXRhc2V0OiB7IGtleTogYG5vdGU6JHtuLmtleX1gLCBub3RlOiBuLmtleSB9LAogICAgICAgIG9uY2xpY2s6ICgpID0-IG9wZW5Ob3RlKG4pLAogICAgICB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktdG9wJyB9LAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICduaS10aXRsZScgfSwgbWFya2VkKG4udGl0bGUpKSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZGF0ZScsIHRleHQ6IHV0aWwu",
"cmVsYXRpdmVEYXRlKG4udXBkYXRlZCksIHRpdGxlOiB1dGlsLmZ1bGxEYXRlKG4udXBkYXRlZCkgfSkpLAogICAgICAgIGl0ZW1QcmV2aWV3KG4pLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktbWV0YScgfSwKICAgICAgICAgIGhpdENvdW50KG4pLAogICAgICAgICAgIU4uZm9sZGVyICYmIG4uZm9sZGVySWQgPyBoKCdzcGFuJywgeyBjbGFzczogJ25pLWZvbGRlcicgfSwgaWNvbignZm9sZGVyJywgMTQpLCBmb2xkZXJMYWJlbChuLmZvbGRlcklkKSkgOiBudWxsLAogICAgICAgICAgbi5vd24gPyBudWxsIDogaCgnc3BhbicsIHsgY2xhc3M6ICduaS1tYWlsJywgdGV4dDogJ0Zyb20gYW4gZW1haWwnIH0pKSk7CiAgICAgIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ3N0YXJ0JywgZSA9PiB7CiAgICAgICAgTi5kcmFnS2V5ID0gbi5rZXk7CiAgICAgICAgZS5kYXRhVHJhbnNmZXIuZWZmZWN0QWxsb3dlZCA9ICdtb3ZlJzsKICAgICAgICBlLmRhdGFUcmFuc2Zlci5zZXREYXRhKCdhcHBsaWNhdGlvbi94LWdrYi1ub3RlJywgbi5rZXkpOwogICAgICAgIGVscy53cmFwLmNsYXNzTGlzdC5hZGQoJ2RyYWdnaW5nLW5vdGUnKTsKICAgICAgfSk7CiAgICAgIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsICgpID0-IHsKICAgICAgICBOLmRyYWdLZXkgPSAnJzsKICAgICAgICBlbHMud3JhcC5jbGFzc0xpc3QucmVtb3ZlKCdkcmFnZ2luZy1ub3RlJyk7CiAgICAgICAgZm9yIChjb25zdCByIG9mIGVs",
"cy5mb2xkZXJJdGVtcy5xdWVyeVNlbGVjdG9yQWxsKCcuZHJvcCcpKSByLmNsYXNzTGlzdC5yZW1vdmUoJ2Ryb3AnKTsKICAgICAgfSk7CiAgICAgIHJldHVybiBpdGVtOwogICAgfSkpOwogIH0KCiAgLy8g4pSA4pSAIFNlYXJjaCByZXN1bHRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gR21haWwgZmluZHMgdGhlIG5vdGVzOyB0aGVzZSBzaG93IHdoZXJlIHRoZSB3b3JkcyBhcmUuIEVhY2ggcmVzdWx0CiAgLy8gZ2V0cyBleGNlcnB0cyBhcm91bmQgaXRzIG1hdGNoZXMgb25jZSBpdHMgdGV4dCBpcyBpbiwgd2l0aCB0aGUgd29yZHMKICAvLyBtYXJrZWQuIFVudGlsIHRoZW4gLSBvciBpZiBHbWFpbCBtYXRjaGVkIHNvbWV0aGluZyB0aGUgd29yZHMgZG8gbm90CiAgLy8gc2hvdywgc3VjaCBhcyBhIHN0ZW1tZWQgZm9ybSAtIGl0IHNob3dzIEdtYWlsJ3Mgb3duIHNuaXBwZXQuCgogIGNvbnN0IHRlcm1zS2V5ID0gKCkgPT4gSlNPTi5zdHJpbmdpZnkoTi50ZXJtcyk7CgogIC8vIFRleHQgd2l0aCB0aGUgc2VhcmNoIHdvcmRzIHdyYXBwZWQgaW4gPG1hcms-LCBidWlsdCBmcm9tIHRleHQgbm9kZXMuCiAgZnVuY3Rpb24gbWFya2VkKHRleHQsIG1hcmtzKSB7CiAgICBjb25z",
"dCBzID0gU3RyaW5nKHRleHQgfHwgJycpOwogICAgY29uc3QgbSA9IG1hcmtzIHx8IChOLnRlcm1zLmxlbmd0aCA_IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKHMsIE4udGVybXMpIDogW10pOwogICAgaWYgKCFtLmxlbmd0aCkgcmV0dXJuIHM7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBhdCA9IDA7CiAgICBmb3IgKGNvbnN0IHsgc3RhcnQsIGVuZCB9IG9mIG0pIHsKICAgICAgaWYgKHN0YXJ0ID4gYXQpIG91dC5wdXNoKHMuc2xpY2UoYXQsIHN0YXJ0KSk7CiAgICAgIG91dC5wdXNoKGgoJ21hcmsnLCB7IHRleHQ6IHMuc2xpY2Uoc3RhcnQsIGVuZCkgfSkpOwogICAgICBhdCA9IGVuZDsKICAgIH0KICAgIGlmIChhdCA8IHMubGVuZ3RoKSBvdXQucHVzaChzLnNsaWNlKGF0KSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gaXRlbVByZXZpZXcobikgewogICAgY29uc3QgaGl0ID0gTi50ZXJtcy5sZW5ndGggPyBOLmhpdHMuZ2V0KGAke24ubWVzc2FnZUlkfXwke3Rlcm1zS2V5KCl9YCkgOiBudWxsOwogICAgaWYgKGhpdCAmJiBoaXQuZXhjZXJwdHMubGVuZ3RoKSB7CiAgICAgIHJldHVybiBoKCdzcGFuJywgeyBjbGFzczogJ25pLWV4Y2VycHRzJyB9LCBoaXQuZXhjZXJwdHMubWFwKGV4ID0-IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktZXhjZXJwdCcgfSwKICAgICAgICBleC5jdXRCZWZvcmUgPyAnXHUyMDI2JyA6ICcnLCBtYXJrZWQoZXgudGV4dCwgZXgubWFya3MpLCBleC5jdXRBZnRlciA_ICdc",
"dTIwMjYnIDogJycpKSk7CiAgICB9CiAgICByZXR1cm4gbi5zbmlwcGV0ID8gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1zbmlwcGV0JyB9LCBtYXJrZWQobi5zbmlwcGV0KSkgOiBudWxsOwogIH0KCiAgZnVuY3Rpb24gaGl0Q291bnQobikgewogICAgaWYgKCFOLnRlcm1zLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBoaXQgPSBOLmhpdHMuZ2V0KGAke24ubWVzc2FnZUlkfXwke3Rlcm1zS2V5KCl9YCk7CiAgICBpZiAoIWhpdCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1oaXRzJywgdGV4dDogYCR7aGl0LmNvdW50fSAke2hpdC5jb3VudCA9PT0gMSA_ICdtYXRjaCcgOiAnbWF0Y2hlcyd9YCB9KTsKICB9CgogIC8vIEZldGNoZXMgdGhlIHRleHQgb2YgdGhlIHJlc3VsdHMgb24gc2hvdyB0aGF0IGhhdmUgbm8gZXhjZXJwdHMgeWV0LAogIC8vIGEgZmV3IGF0IGEgdGltZSwgcmVkcmF3aW5nIHRoZSBsaXN0IGFzIHRoZXkgY29tZSBpbi4KICBsZXQgaGl0c1J1biA9IDA7CiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hIaXRzKCkgewogICAgaWYgKCFOLnRlcm1zLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgcnVuID0gKytoaXRzUnVuOwogICAgY29uc3Qga2V5ID0gdGVybXNLZXkoKTsKICAgIGNvbnN0IHRlcm1zID0gTi50ZXJtczsKICAgIGNvbnN0IHRvZG8gPSB2aXNpYmxlTm90ZXMoKS5zbGljZSgwLCBFWENFUlBUX0xJTUlUKS5maWx0ZXIobiA9PiAhTi5oaXRzLmhhcyhg",
"JHtuLm1lc3NhZ2VJZH18JHtrZXl9YCkpOwogICAgbGV0IHJlZHJhdyA9IDA7CiAgICBhd2FpdCB1dGlsLm1hcFBvb2wodG9kbywgNCwgYXN5bmMgbiA9PiB7CiAgICAgIGlmIChydW4gIT09IGhpdHNSdW4pIHJldHVybjsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBkb2MgPSBhd2FpdCBub3Rlc1N0b3JlLmJvZHkobik7CiAgICAgICAgY29uc3QgdGV4dCA9IGZtdC5kb2NUZXh0KGRvYyk7CiAgICAgICAgY29uc3QgYm9keSA9IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKHRleHQsIHRlcm1zKTsKICAgICAgICBjb25zdCB0aXRsZSA9IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKG4udGl0bGUsIHRlcm1zKTsKICAgICAgICBOLmhpdHMuc2V0KGAke24ubWVzc2FnZUlkfXwke2tleX1gLCB7CiAgICAgICAgICBjb3VudDogYm9keS5sZW5ndGggKyB0aXRsZS5sZW5ndGgsCiAgICAgICAgICBleGNlcnB0czogc2VhcmNoTG9naWMuZXhjZXJwdHModGV4dCwgYm9keSwgeyBjb250ZXh0OiA0NSwgbWF4OiAzIH0pLAogICAgICAgIH0pOwogICAgICB9IGNhdGNoIHsgLyogdGhlIHNuaXBwZXQgc3RhbmRzIGluICovIH0KICAgICAgaWYgKHJ1biA9PT0gaGl0c1J1biAmJiAhcmVkcmF3KSByZWRyYXcgPSBzZXRUaW1lb3V0KCgpID0-IHsgcmVkcmF3ID0gMDsgZHJhd0xpc3QoKTsgfSwgNjApOwogICAgfSk7CiAgICBpZiAocnVuID09PSBoaXRzUnVuKSBkcmF3TGlzdCgpOwogIH0KCiAgLy8g4pSA4pSAIEZpbmQgaW4gdGhlIG9wZW4g",
"bm90ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYXBwbHlIaWdobGlnaHRzKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghZWxzLmVkIHx8ICFjIHx8IGMuYm9keVN0YXRlICE9PSAncmVhZHknKSB7IGRyYXdGaW5kKCk7IHJldHVybjsgfQogICAgY29uc3QgY291bnQgPSBlbHMuZWQuaGlnaGxpZ2h0KE4udGVybXMpOwogICAgaWYgKE4uZmluZEluZGV4ID49IGNvdW50KSBOLmZpbmRJbmRleCA9IDA7CiAgICBpZiAoY291bnQpIGVscy5lZC5zaG93TWF0Y2goTi5maW5kSW5kZXgpOwogICAgZHJhd0ZpbmQoKTsKICB9CgogIGZ1bmN0aW9uIHN0ZXBNYXRjaChkZWx0YSkgewogICAgY29uc3QgY291bnQgPSBlbHMuZWQgPyBlbHMuZWQubWF0Y2hDb3VudCgpIDogMDsKICAgIGlmICghY291bnQpIHJldHVybjsKICAgIE4uZmluZEluZGV4ID0gKE4uZmluZEluZGV4ICsgZGVsdGEgKyBjb3VudCkgJSBjb3VudDsKICAgIGVscy5lZC5zaG93TWF0Y2goTi5maW5kSW5kZXgpOwogICAgZHJhd0ZpbmQoKTsKICB9CgogIGZ1bmN0aW9uIGNsZWFyU2VhcmNoKCkgewogICAgaWYgKCFlbHMuc2VhcmNoKSByZXR1cm47CiAgICBlbHMuc2VhcmNoLnZhbHVlID0gJyc7CiAgICBOLnF1ZXJ5ID0gJyc7CiAg",
"ICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgbG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogIH0KCiAgZnVuY3Rpb24gZHJhd0ZpbmQoKSB7CiAgICBpZiAoIWVscy5maW5kU2xvdCkgcmV0dXJuOwogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghTi50ZXJtcy5sZW5ndGggfHwgIWMgfHwgIWVscy5lZCB8fCBjLmJvZHlTdGF0ZSAhPT0gJ3JlYWR5JykgewogICAgICBlbHMuZmluZFNsb3QucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGNvdW50ID0gZWxzLmVkLm1hdGNoQ291bnQoKTsKICAgIGNvbnN0IHdvcmRzID0gTi50ZXJtcy5tYXAodCA9PiB0LndvcmRzLmpvaW4oJyAnKSkuam9pbignLCAnKTsKICAgIC8vIEEgcmVkcmF3IHJlcGxhY2VzIHRoZSBhcnJvdyBqdXN0IHByZXNzZWQ7IGZvY3VzIGdvZXMgdG8gaXRzIHN1Y2Nlc3NvcgogICAgLy8gcmF0aGVyIHRoYW4gZmFsbGluZyBvdXQgb2YgdGhlIGJvYXJkLCB3aGVyZSBGMyB3b3VsZCBub3QgcmVhY2ggaXQuCiAgICBjb25zdCBhY3RpdmUgPSBOLmN0eC5yb290LmFjdGl2ZUVsZW1lbnQ7CiAgICBjb25zdCByZWZvY3VzID0gYWN0aXZlICYmIGVscy5maW5kU2xvdC5jb250YWlucyhhY3RpdmUpID8gYWN0aXZlLmRhdGFzZXQua2V5IDogJyc7CiAgICBlbHMuZmluZFNsb3QucmVwbGFjZUNoaWxkcmVuKGgoJ2RpdicsIHsgY2xhc3M6ICduZS1maW5kJywgcm9sZTogJ3NlYXJjaCcsICdhcmlhLWxhYmVsJzog",
"J01hdGNoZXMgaW4gdGhpcyBub3RlJyB9LAogICAgICBpY29uKCdzZWFyY2gnLCAxOCksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmluZC13b3JkcycsIHRleHQ6IHdvcmRzLCB0aXRsZTogd29yZHMgfSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmluZC1wb3MnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScsIHRleHQ6IGNvdW50ID8gYCR7Ti5maW5kSW5kZXggKyAxfSBvZiAke2NvdW50fWAgOiAnTm90IGluIHRoZSB0ZXh0JyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnUHJldmlvdXMgbWF0Y2ggKFNoaWZ0K0YzKScsIHRpdGxlOiAnUHJldmlvdXMgbWF0Y2ggKFNoaWZ0K0YzKScsCiAgICAgICAgZGlzYWJsZWQ6IGNvdW50IDwgMiwgZGF0YXNldDogeyBrZXk6ICdmaW5kLXByZXYnIH0sIG9uY2xpY2s6ICgpID0-IHN0ZXBNYXRjaCgtMSksCiAgICAgIH0sIGljb24oJ3VwJywgMTgpKSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnTmV4dCBtYXRjaCAoRjMpJywgdGl0bGU6ICdOZXh0IG1hdGNoIChGMyknLAogICAgICAgIGRpc2FibGVkOiBjb3VudCA8IDIsIGRhdGFzZXQ6IHsga2V5OiAnZmluZC1uZXh0JyB9LCBvbmNsaWNrOiAoKSA9PiBzdGVwTWF0Y2goMSksCiAgICAgIH0sIGljb24oJ2Rvd24nLCAxOCkpLAog",
"ICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDbGVhciB0aGUgc2VhcmNoJywgdGl0bGU6ICdDbGVhciB0aGUgc2VhcmNoJywKICAgICAgICBkYXRhc2V0OiB7IGtleTogJ2ZpbmQtY2xlYXInIH0sIG9uY2xpY2s6IGNsZWFyU2VhcmNoLAogICAgICB9LCBpY29uKCdjbG9zZScsIDE4KSkpKTsKICAgIGlmIChyZWZvY3VzKSB7CiAgICAgIGNvbnN0IGFnYWluID0gZWxzLmZpbmRTbG90LnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLWtleT0iJHtyZWZvY3VzfSJdYCk7CiAgICAgIGlmIChhZ2FpbiAmJiAhYWdhaW4uZGlzYWJsZWQpIGFnYWluLmZvY3VzKCk7CiAgICB9CiAgfQoKICAvLyDilIDilIAgRm9sZGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gY291bnRzKCkgewogICAgY29uc3Qgb3V0ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCBuIG9mIE4ubm90ZXMpIG91dC5zZXQobi5mb2xkZXJJZCB8fCAnJywgKG91dC5nZXQobi5mb2xkZXJJZCB8fCAnJykgfHwgMCkgKyAxKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBzZXRGb2xk",
"ZXJzT3BlbihvcGVuKSB7CiAgICBpZiAoIWVscy53cmFwKSByZXR1cm47CiAgICBlbHMud3JhcC5kYXRhc2V0LmZvbGRlcnMgPSBvcGVuID8gJ29wZW4nIDogJ2Nsb3NlZCc7CiAgICBlbHMuZm9sZGVyc1RvZ2dsZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnLCBTdHJpbmcob3BlbikpOwogIH0KCiAgZnVuY3Rpb24gc2VsZWN0Rm9sZGVyKGlkKSB7CiAgICBzZXRGb2xkZXJzT3BlbihmYWxzZSk7CiAgICBpZiAoTi5mb2xkZXIgPT09IGlkKSByZXR1cm47CiAgICBOLmZvbGRlciA9IGlkOwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgICBmZXRjaEhpdHMoKTsKICB9CgogIGZ1bmN0aW9uIGRyYXdGb2xkZXJzKCkgewogICAgaWYgKCFlbHMuZm9sZGVySXRlbXMpIHJldHVybjsKICAgIGNvbnN0IHRhbGx5ID0gY291bnRzKCk7CiAgICBjb25zdCByb3dzID0gW2ZvbGRlclJvdyhudWxsLCBOLm5vdGVzLmxlbmd0aCldOwogICAgY29uc3QgZWRpdCA9IE4uZm9sZGVyRWRpdDsKICAgIGlmIChlZGl0ICYmIGVkaXQubW9kZSA9PT0gJ25ldycgJiYgIWVkaXQucGFyZW50SWQpIHJvd3MucHVzaChlZGl0Um93KDApKTsKICAgIE4uZm9sZGVycy5mb3JFYWNoKChmLCBpKSA9PiB7CiAgICAgIHJvd3MucHVzaChlZGl0ICYmIGVkaXQubW9kZSA9PT0gJ3JlbmFtZScgJiYgZWRpdC5mb2xkZXJJZCA9PT0gZi5pZCA_IGVkaXRSb3coZi5kZXB0aCwgZikgOiBmb2xkZXJSb3coZiwgdGFsbHkuZ2V0KGYuaWQpIHx8",
"IDApKTsKICAgICAgLy8gQSBuZXcgc3ViZm9sZGVyJ3MgZmllbGQgZ29lcyBhZnRlciB0aGUgd2hvbGUgYnJhbmNoIGl0IGpvaW5zLgogICAgICBjb25zdCBuZXh0ID0gTi5mb2xkZXJzW2kgKyAxXTsKICAgICAgY29uc3QgYnJhbmNoRW5kcyA9ICFuZXh0IHx8ICFuZXh0Lm5hbWUuc3RhcnRzV2l0aChgJHtmLm5hbWV9L2ApOwogICAgICBpZiAoZWRpdCAmJiBlZGl0Lm1vZGUgPT09ICduZXcnICYmIGVkaXQucGFyZW50SWQpIHsKICAgICAgICBjb25zdCBwYXJlbnQgPSBmb2xkZXJCeUlkKGVkaXQucGFyZW50SWQpOwogICAgICAgIGlmIChwYXJlbnQgJiYgKGYuaWQgPT09IHBhcmVudC5pZCB8fCBmLm5hbWUuc3RhcnRzV2l0aChgJHtwYXJlbnQubmFtZX0vYCkpICYmIGJyYW5jaEVuZHMpIHJvd3MucHVzaChlZGl0Um93KHBhcmVudC5kZXB0aCArIDEpKTsKICAgICAgfQogICAgfSk7CiAgICBlbHMuZm9sZGVySXRlbXMucmVwbGFjZUNoaWxkcmVuKC4uLnJvd3MpOwoKICAgIGNvbnN0IHNob3duID0gTi5mb2xkZXIgPyBmb2xkZXJCeUlkKE4uZm9sZGVyKSA6IG51bGw7CiAgICBlbHMuZm9sZGVyc1RvZ2dsZS5yZXBsYWNlQ2hpbGRyZW4oCiAgICAgIGljb24oc2hvd24gPyAnZm9sZGVyJyA6ICdub3RlcycsIDIwKSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmdC1sYWJlbCcsIHRleHQ6IHNob3duID8gZm9sZGVyTGFiZWwoc2hvd24uaWQpIDogJ0FsbCBub3RlcycgfSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAn",
"ZnQtY291bnQnLCB0ZXh0OiBOLnN0YXR1cyA9PT0gJ3JlYWR5JyA_IFN0cmluZyhzaG93biA_IHRhbGx5LmdldChzaG93bi5pZCkgfHwgMCA6IE4ubm90ZXMubGVuZ3RoKSA6ICcnIH0pLAogICAgICBpY29uKCdjYXJldCcsIDIwKSk7CiAgfQoKICBmdW5jdGlvbiBmb2xkZXJSb3coZiwgY291bnQpIHsKICAgIGNvbnN0IGlkID0gZiA_IGYuaWQgOiAnJzsKICAgIGNvbnN0IGNoaWxkcmVuID0gZiA_IE4uZm9sZGVycy5zb21lKHggPT4geC5uYW1lLnN0YXJ0c1dpdGgoYCR7Zi5uYW1lfS9gKSkgOiBmYWxzZTsKICAgIGNvbnN0IHJvdyA9IGgoJ2RpdicsIHsKICAgICAgY2xhc3M6ICdmb2xkZXItcm93Jywgcm9sZTogJ2xpc3RpdGVtJywgZGF0YXNldDogeyBmb2xkZXI6IGlkIHx8ICdhbGwnIH0sCiAgICB9LAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdmb2xkZXItYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWN1cnJlbnQnOiBOLmZvbGRlciA9PT0gaWQgPyAndHJ1ZScgOiBudWxsLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgZm9sZGVyOiR7aWQgfHwgJ2FsbCd9YCB9LCB0aXRsZTogZiA_IGYubmFtZSA6ICdFdmVyeSBub3RlLCBpbiBhbnkgZm9sZGVyJywKICAgICAgICBvbmNsaWNrOiAoKSA9PiBzZWxlY3RGb2xkZXIoaWQpLAogICAgICB9LAogICAgICAgIGljb24oZiA_ICdmb2xkZXInIDogJ25vdGVzJywgMTgpLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZm9sZGVyLXRpdGxlJywg",
"dGV4dDogZiA_IGYudGl0bGUgOiAnQWxsIG5vdGVzJyB9KSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2ZvbGRlci1jb3VudCcsIHRleHQ6IE4uc3RhdHVzID09PSAncmVhZHknID8gU3RyaW5nKGNvdW50KSA6ICcnIH0pKSwKICAgICAgZiA_IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuIGZvbGRlci1tZW51JywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogYE1vcmUgYWN0aW9uczogJHtmLnRpdGxlfWAsIHRpdGxlOiAnTW9yZSBhY3Rpb25zJywKICAgICAgICAnYXJpYS1oYXNwb3B1cCc6ICdtZW51JywgJ2FyaWEtZXhwYW5kZWQnOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogYGZvbGRlci1tZW51OiR7aWR9YCB9LAogICAgICAgIG9uY2xpY2s6IGUgPT4gb3Blbk1lbnUoTi5jdHgucm9vdCwgZS5jdXJyZW50VGFyZ2V0LCBbCiAgICAgICAgICB7IGxhYmVsOiAnUmVuYW1lJywgaWNvbjogJ2VkaXQnLCBrZXk6ICdmb2xkZXItcmVuYW1lJywgb25TZWxlY3Q6ICgpID0-IHN0YXJ0Rm9sZGVyRWRpdCh7IG1vZGU6ICdyZW5hbWUnLCBmb2xkZXJJZDogaWQgfSkgfSwKICAgICAgICAgIHsgbGFiZWw6ICdOZXcgc3ViZm9sZGVyJywgaWNvbjogJ2FkZCcsIGtleTogJ2ZvbGRlci1zdWInLCBvblNlbGVjdDogKCkgPT4gc3RhcnRGb2xkZXJFZGl0KHsgbW9kZTogJ25ldycsIHBhcmVudElkOiBpZCB9KSB9LAogICAgICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgICAgIHsKICAg",
"ICAgICAgICAgbGFiZWw6IGNvdW50IHx8IGNoaWxkcmVuID8gJ0RlbGV0ZSAoZW1wdHkgaXQgZmlyc3QpJyA6ICdEZWxldGUnLCBpY29uOiAnZGVsZXRlJywgZGFuZ2VyOiB0cnVlLCBrZXk6ICdmb2xkZXItZGVsZXRlJywKICAgICAgICAgICAgZGlzYWJsZWQ6ICEhKGNvdW50IHx8IGNoaWxkcmVuKSwgb25TZWxlY3Q6ICgpID0-IHJlbW92ZUZvbGRlcihmKSwKICAgICAgICAgIH0sCiAgICAgICAgXSwgeyBsYWJlbDogYEFjdGlvbnMgZm9yICR7Zi50aXRsZX1gIH0pLAogICAgICB9LCBpY29uKCdtb3JlJywgMTgpKSA6IG51bGwpOwogICAgLy8gVGhyb3VnaCB0aGUgc3R5bGUgQVBJLCBub3QgYSBzdHlsZSBhdHRyaWJ1dGU6IGEgcGFnZSdzIHNlY3VyaXR5CiAgICAvLyBwb2xpY3kgbWF5IHJlZnVzZSBpbmxpbmUgc3R5bGUgYXR0cmlidXRlcywgbmV2ZXIgdGhpcy4KICAgIHJvdy5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kZXB0aCcsIFN0cmluZyhmID8gZi5kZXB0aCA6IDApKTsKCiAgICAvLyBEcm9wcGluZyBhIG5vdGUgaGVyZSBmaWxlcyBpdCBoZXJlOyBvbiAiQWxsIG5vdGVzIiwgdGFrZXMgaXQgb3V0IG9mCiAgICAvLyBpdHMgZm9sZGVyLgogICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdvdmVyJywgZSA9PiB7CiAgICAgIGlmICghTi5kcmFnS2V5KSByZXR1cm47CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgZS5kYXRhVHJhbnNmZXIuZHJvcEVmZmVjdCA9ICdtb3ZlJzsKICAgICAgcm93LmNsYXNz",
"TGlzdC5hZGQoJ2Ryb3AnKTsKICAgIH0pOwogICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdsZWF2ZScsICgpID0-IHJvdy5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wJykpOwogICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCBlID0-IHsKICAgICAgaWYgKCFOLmRyYWdLZXkpIHJldHVybjsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICByb3cuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcCcpOwogICAgICBjb25zdCBub3RlID0gTi5ub3Rlcy5maW5kKG4gPT4gbi5rZXkgPT09IE4uZHJhZ0tleSk7CiAgICAgIE4uZHJhZ0tleSA9ICcnOwogICAgICBpZiAobm90ZSkgbW92ZU5vdGUobm90ZSwgaWQpOwogICAgfSk7CiAgICByZXR1cm4gcm93OwogIH0KCiAgZnVuY3Rpb24gZWRpdFJvdyhkZXB0aCwgZm9sZGVyKSB7CiAgICBjb25zdCBlZGl0ID0gTi5mb2xkZXJFZGl0OwogICAgY29uc3QgaW5wdXQgPSBoKCdpbnB1dCcsIHsKICAgICAgY2xhc3M6ICd0ZXh0LWlucHV0IGZvbGRlci1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGVkaXQudmFsdWUsIG1heGxlbmd0aDogU3RyaW5nKG5vdGVzTG9naWMuRk9MREVSX05BTUVfTUFYKSwKICAgICAgcGxhY2Vob2xkZXI6IGVkaXQubW9kZSA9PT0gJ25ldycgPyAnRm9sZGVyIG5hbWUsIHRoZW4gRW50ZXInIDogJycsICdhcmlhLWxhYmVsJzogZWRpdC5tb2RlID09PSAnbmV3JyA_ICdOZXcgZm9sZGVyIG5hbWUnIDogYFJlbmFtZSAke2ZvbGRlci50aXRsZX1g",
"LAogICAgICBkaXNhYmxlZDogISFlZGl0LmJ1c3ksIGRhdGFzZXQ6IHsga2V5OiAnZm9sZGVyLWlucHV0JyB9LAogICAgICBvbmlucHV0OiBlID0-IHsgZWRpdC52YWx1ZSA9IGUudGFyZ2V0LnZhbHVlOyB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGNvbW1pdEZvbGRlckVkaXQoKTsgfQogICAgICAgIGlmIChlLmtleSA9PT0gJ0VzY2FwZScpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBlLnN0b3BQcm9wYWdhdGlvbigpOyBjYW5jZWxGb2xkZXJFZGl0KCk7IH0KICAgICAgfSwKICAgICAgb25ibHVyOiAoKSA9PiB7IGlmICghZWRpdC5idXN5ICYmIE4uZm9sZGVyRWRpdCA9PT0gZWRpdCkgc2V0VGltZW91dCgoKSA9PiB7IGlmIChOLmZvbGRlckVkaXQgPT09IGVkaXQgJiYgIWVkaXQuYnVzeSkgY2FuY2VsRm9sZGVyRWRpdCgpOyB9LCAxNTApOyB9LAogICAgfSk7CiAgICBjb25zdCByb3cgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZm9sZGVyLXJvdyBlZGl0aW5nJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZm9sZGVyLWVkaXQnIH0sIGljb24oJ2ZvbGRlcicsIDE4KSwgaW5wdXQpLAogICAgICBlZGl0LmVycm9yID8gaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlci1lcnJvcicsIHJvbGU6ICdhbGVydCcsIHRleHQ6IGVkaXQuZXJyb3IgfSkgOiBudWxsKTsKICAgIHJvdy5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kZXB0aCcsIFN0",
"cmluZyhkZXB0aCkpOwogICAgcmV0dXJuIHJvdzsKICB9CgogIGZ1bmN0aW9uIHN0YXJ0Rm9sZGVyRWRpdCh7IG1vZGUsIHBhcmVudElkID0gJycsIGZvbGRlcklkID0gJycgfSkgewogICAgY29uc3QgZiA9IGZvbGRlckJ5SWQoZm9sZGVySWQpOwogICAgTi5mb2xkZXJFZGl0ID0geyBtb2RlLCBwYXJlbnRJZCwgZm9sZGVySWQsIHZhbHVlOiBtb2RlID09PSAncmVuYW1lJyAmJiBmID8gZi50aXRsZSA6ICcnLCBlcnJvcjogJycsIGJ1c3k6IGZhbHNlIH07CiAgICBkcmF3Rm9sZGVycygpOwogICAgY29uc3QgaW5wdXQgPSBlbHMuZm9sZGVySXRlbXMucXVlcnlTZWxlY3RvcignW2RhdGEta2V5PSJmb2xkZXItaW5wdXQiXScpOwogICAgaWYgKGlucHV0KSB7IGlucHV0LmZvY3VzKCk7IGlucHV0LnNlbGVjdCgpOyB9CiAgfQoKICBmdW5jdGlvbiBjYW5jZWxGb2xkZXJFZGl0KCkgewogICAgaWYgKCFOLmZvbGRlckVkaXQpIHJldHVybjsKICAgIE4uZm9sZGVyRWRpdCA9IG51bGw7CiAgICBkcmF3Rm9sZGVycygpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gY29tbWl0Rm9sZGVyRWRpdCgpIHsKICAgIGNvbnN0IGVkaXQgPSBOLmZvbGRlckVkaXQ7CiAgICBpZiAoIWVkaXQgfHwgZWRpdC5idXN5KSByZXR1cm47CiAgICBjb25zdCB0YXJnZXQgPSBlZGl0Lm1vZGUgPT09ICdyZW5hbWUnID8gZm9sZGVyQnlJZChlZGl0LmZvbGRlcklkKSA6IG51bGw7CiAgICBjb25zdCBwYXJlbnQgPSBlZGl0Lm1vZGUgPT09ICduZXcnID8gZm9s",
"ZGVyQnlJZChlZGl0LnBhcmVudElkKSA6IG51bGw7CiAgICBjb25zdCBwYXJlbnRQYXRoID0gdGFyZ2V0ID8gdGFyZ2V0LnBhcmVudFBhdGggOiBwYXJlbnQgPyBwYXJlbnQucGF0aCA6ICcnOwogICAgY29uc3Qgc2libGluZ3MgPSBOLmZvbGRlcnMuZmlsdGVyKGYgPT4gZi5wYXJlbnRQYXRoID09PSBwYXJlbnRQYXRoICYmIGYgIT09IHRhcmdldCkubWFwKGYgPT4gZi50aXRsZSk7CiAgICBjb25zdCBwcm9ibGVtID0gbm90ZXNMb2dpYy52YWxpZGF0ZUZvbGRlclRpdGxlKGVkaXQudmFsdWUsIHNpYmxpbmdzKTsKICAgIGlmIChlZGl0Lm1vZGUgPT09ICdyZW5hbWUnICYmIHRhcmdldCAmJiBlZGl0LnZhbHVlLnRyaW0oKSA9PT0gdGFyZ2V0LnRpdGxlKSB7IGNhbmNlbEZvbGRlckVkaXQoKTsgcmV0dXJuOyB9CiAgICBpZiAocHJvYmxlbSkgewogICAgICBlZGl0LmVycm9yID0gcHJvYmxlbTsKICAgICAgZHJhd0ZvbGRlcnMoKTsKICAgICAgY29uc3QgaW5wdXQgPSBlbHMuZm9sZGVySXRlbXMucXVlcnlTZWxlY3RvcignW2RhdGEta2V5PSJmb2xkZXItaW5wdXQiXScpOwogICAgICBpZiAoaW5wdXQpIGlucHV0LmZvY3VzKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGVkaXQuYnVzeSA9IHRydWU7CiAgICBkcmF3Rm9sZGVycygpOwogICAgdHJ5IHsKICAgICAgaWYgKGVkaXQubW9kZSA9PT0gJ25ldycpIHsKICAgICAgICBjb25zdCBtYWRlID0gYXdhaXQgbm90ZXNTdG9yZS5jcmVhdGVGb2xkZXIocGFyZW50LCBlZGl0",
"LnZhbHVlKTsKICAgICAgICBOLmZvbGRlcnMgPSBub3Rlc1N0b3JlLmZvbGRlcnMoKTsKICAgICAgICBpZiAobWFkZSkgTi5mb2xkZXIgPSBtYWRlLmlkOwogICAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBGb2xkZXIg4oCcJHtlZGl0LnZhbHVlLnRyaW0oKX3igJ0gY3JlYXRlZC5gKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBhd2FpdCBub3Rlc1N0b3JlLnJlbmFtZUZvbGRlcih0YXJnZXQsIGVkaXQudmFsdWUpOwogICAgICAgIE4uZm9sZGVycyA9IG5vdGVzU3RvcmUuZm9sZGVycygpOwogICAgICB9CiAgICAgIE4uZm9sZGVyRWRpdCA9IG51bGw7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgZWRpdC5idXN5ID0gZmFsc2U7CiAgICAgIGVkaXQuZXJyb3IgPSBgQ291bGRu4oCZdCBzYXZlOiAke2Vyci5tZXNzYWdlfWA7CiAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICB9CiAgICBkcmF3Rm9sZGVycygpOwogICAgZHJhd0xpc3QoKTsKICAgIGlmIChOLmN1cnJlbnQpIGRyYXdCYXIoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJlbW92ZUZvbGRlcihmKSB7CiAgICB0cnkgewogICAgICBhd2FpdCBub3Rlc1N0b3JlLmRlbGV0ZUZvbGRlcihmKTsKICAgICAgTi5mb2xkZXJzID0gbm90ZXNTdG9yZS5mb2xkZXJzKCk7CiAgICAgIGlmIChOLmZvbGRlciA9PT0gZi5pZCkgTi5mb2xkZXIgPSAnJzsKICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYEZv",
"bGRlciDigJwke2YudGl0bGV94oCdIGRlbGV0ZWQuYCk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgY29uc3QgbXNnID0gZXJyLmNvZGUgPT09ICdub3RfYWxsb3dlZCcgPyAnT25seSBhbiBlbXB0eSBmb2xkZXIgY2FuIGJlIGRlbGV0ZWQuIE1vdmUgaXRzIG5vdGVzIG91dCBmaXJzdC4nIDogZXJyLm1lc3NhZ2U7CiAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBDb3VsZG7igJl0IGRlbGV0ZSDigJwke2YudGl0bGV94oCdOiAke21zZ31gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICB9CiAgICBkcmF3Rm9sZGVycygpOwogICAgZHJhd0xpc3QoKTsKICB9CgogIC8vIFJ1bnMgYWZ0ZXIgYW55IHNhdmUgaW4gcHJvZ3Jlc3MsIHNvIHRoZSBtb3ZlIGxhbmRzIG9uIHRoZSBuZXdlc3QKICAvLyB2ZXJzaW9uIHJhdGhlciB0aGFuIG9uZSBhYm91dCB0byBiZSByZXBsYWNlZC4KICBmdW5jdGlvbiBtb3ZlTm90ZShub3RlLCBmb2xkZXJJZCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudCAmJiBOLmN1cnJlbnQubm90ZSA9PT0gbm90ZSA_IE4uY3VycmVudCA6IG51bGw7CiAgICBpZiAoKG5vdGUuZm9sZGVySWQgfHwgJycpID09PSAoZm9sZGVySWQgfHwgJycpKSByZXR1cm4gTi5jaGFpbjsKICAgIE4uY2hhaW4gPSBOLmNoYWluLnRoZW4oYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBsYXRlc3QgPSBjID8gYy5ub3RlIDogbm90ZTsKICAgICAgY29uc3Qgd2FzID0gbGF0ZXN0LmZvbGRlcklkIHx8ICcnOwogICAgICBsYXRlc3Qu",
"Zm9sZGVySWQgPSBmb2xkZXJJZDsKICAgICAgaWYgKGMpIGMuZm9sZGVySWQgPSBmb2xkZXJJZDsKICAgICAgZHJhd0ZvbGRlcnMoKTsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgaWYgKGMpIGRyYXdCYXIoKTsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCBub3Rlc1N0b3JlLm1vdmUobGF0ZXN0LCBmb2xkZXJJZCk7CiAgICAgICAgdG9hc3QoTi5jdHgucm9vdCwgZm9sZGVySWQgPyBgTW92ZWQgdG8gJHtmb2xkZXJMYWJlbChmb2xkZXJJZCl9LmAgOiAnVGFrZW4gb3V0IG9mIGl0cyBmb2xkZXIuJyk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGxhdGVzdC5mb2xkZXJJZCA9IHdhczsKICAgICAgICBpZiAoYykgYy5mb2xkZXJJZCA9IHdhczsKICAgICAgICB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBtb3ZlIOKAnCR7bGF0ZXN0LnRpdGxlfeKAnTogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSBOLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgICAgfQogICAgICBkcmF3Rm9sZGVycygpOwogICAgICBkcmF3TGlzdCgpOwogICAgICBpZiAoTi5jdXJyZW50ID09PSBjICYmIGMpIGRyYXdCYXIoKTsKICAgIH0pOwogICAgcmV0dXJuIE4uY2hhaW47CiAgfQoKICAvLyBUaGUgZm9sZGVyIGJ1dHRvbiBhYm92ZSB0aGUgbm90ZTogd2hlcmUgaXQgaXMsIGFuZCB3aGVyZSBpdCBjYW4gZ28uCiAgZnVuY3Rpb24g",
"Y2hvb3NlRm9sZGVyKGFuY2hvcikgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYykgcmV0dXJuOwogICAgb3Blbk1lbnUoTi5jdHgucm9vdCwgYW5jaG9yLCBbCiAgICAgIHsgaGVhZGluZzogJ01vdmUgdG8nIH0sCiAgICAgIHsgbGFiZWw6ICdObyBmb2xkZXInLCBrZXk6ICdtb3ZlLWZvbGRlcjpub25lJywgY2hlY2tlZDogIWMuZm9sZGVySWQsIG9uU2VsZWN0OiAoKSA9PiBzZXRDdXJyZW50Rm9sZGVyKCcnKSB9LAogICAgICAuLi5OLmZvbGRlcnMubWFwKGYgPT4gKHsKICAgICAgICBsYWJlbDogYCR7J1x1MjAwMycucmVwZWF0KGYuZGVwdGgpfSR7Zi50aXRsZX1gLCBrZXk6IGBtb3ZlLWZvbGRlcjoke2YuaWR9YCwgY2hlY2tlZDogYy5mb2xkZXJJZCA9PT0gZi5pZCwKICAgICAgICBvblNlbGVjdDogKCkgPT4gc2V0Q3VycmVudEZvbGRlcihmLmlkKSwKICAgICAgfSkpLAogICAgXSwgeyBsYWJlbDogJ0ZvbGRlcicgfSk7CiAgfQoKICBmdW5jdGlvbiBzZXRDdXJyZW50Rm9sZGVyKGlkKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFjKSByZXR1cm47CiAgICAvLyBOb3Qgc2F2ZWQgeWV0OiB0aGUgZm9sZGVyIGlzIHNpbXBseSB3aGVyZSB0aGUgZmlyc3Qgc2F2ZSBwdXRzIGl0LgogICAgaWYgKCFjLm5vdGUpIHsKICAgICAgYy5mb2xkZXJJZCA9IGlkOwogICAgICBkcmF3QmFyKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIG1vdmVOb3RlKGMubm90ZSwgaWQpOwogIH0KCiAg",
"ZnVuY3Rpb24gZHJhd0Zvb3QoKSB7CiAgICBpZiAoIWVscy5mb290KSByZXR1cm47CiAgICBlbHMuZm9vdC50ZXh0Q29udGVudCA9IE4udHJ1bmNhdGVkCiAgICAgID8gJ1Nob3dpbmcgdGhlIDEwMCBtb3N0IHJlY2VudC4gU2VhcmNoIHRvIGZpbmQgb2xkZXIgb25lcy4nCiAgICAgIDogYEtlcHQgaW4gR21haWwgdW5kZXIg4oCcJHtub3Rlc1N0b3JlLmxhYmVsTmFtZSgpfeKAnWA7CiAgfQoKICAvLyDilIDilIAgVGhlIGVkaXRvciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gbmV3Q3VycmVudChub3RlKSB7CiAgICByZXR1cm4gewogICAgICBrZXk6IG5vdGUgPyBub3RlLmtleSA6IGBuZXc6JHtEYXRlLm5vdygpfWAsCiAgICAgIG5vdGUsICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBudWxsIHVudGlsIGZpcnN0IHNhdmVkCiAgICAgIHRpdGxlOiBub3RlICYmIG5vdGUudGl0bGUgIT09ICdVbnRpdGxlZCBub3RlJyA_IG5vdGUudGl0bGUgOiAnJywKICAgICAgZG9jOiBub3RlID8gbnVsbCA6IGZtdC5lbXB0eURvYygpLCAgIC8vIGZvcm1hdHRlZCBjb250ZW50LCBvbmNlIGxvYWRlZAogICAgICBib2R5U3RhdGU6IG5vdGUgPyAnbG9hZGluZycg",
"OiAncmVhZHknLCAvLyBsb2FkaW5nIHwgcmVhZHkgfCBlcnJvcgogICAgICBkaXJ0eTogZmFsc2UsCiAgICAgIHNhdmluZzogZmFsc2UsCiAgICAgIGVycm9yOiAnJywKICAgICAgc2F2ZWRBdDogMCwKICAgICAgLy8gQSBuZXcgbm90ZSBzdGFydHMgaW4gdGhlIGZvbGRlciBiZWluZyBsb29rZWQgYXQuCiAgICAgIGZvbGRlcklkOiBub3RlID8gbm90ZS5mb2xkZXJJZCB8fCAnJyA6IE4uZm9sZGVyLAogICAgfTsKICB9CgogIGZ1bmN0aW9uIG5ld05vdGUoKSB7CiAgICBmbHVzaCgpOwogICAgTi5jdXJyZW50ID0gbmV3Q3VycmVudChudWxsKTsKICAgIGRyYXdMaXN0KCk7CiAgICBkcmF3RWRpdG9yKCk7CiAgICBmb2N1c0ZpZWxkKCdub3RlLXRpdGxlJyk7CiAgfQoKICBmdW5jdGlvbiBvcGVuTm90ZShub3RlLCB7IGZvcmNlID0gZmFsc2UgfSA9IHt9KSB7CiAgICBpZiAoIWZvcmNlICYmIE4uY3VycmVudCAmJiBOLmN1cnJlbnQua2V5ID09PSBub3RlLmtleSkgcmV0dXJuOwogICAgZmx1c2goKTsKICAgIGNvbnN0IGMgPSBuZXdDdXJyZW50KG5vdGUpOwogICAgTi5jdXJyZW50ID0gYzsKICAgIE4uZmluZEluZGV4ID0gMDsKICAgIGRyYXdMaXN0KCk7CiAgICBkcmF3RWRpdG9yKCk7CiAgICBub3Rlc1N0b3JlLmJvZHkobm90ZSkudGhlbihkb2MgPT4gewogICAgICBpZiAoTi5jdXJyZW50ICE9PSBjKSByZXR1cm47CiAgICAgIGMuZG9jID0gZG9jOwogICAgICBjLmJvZHlTdGF0ZSA9ICdyZWFkeSc7CiAgICAgIGRyYXdF",
"ZGl0b3IoKTsKICAgICAgYXBwbHlIaWdobGlnaHRzKCk7CiAgICB9LCBlcnIgPT4gewogICAgICBpZiAoTi5jdXJyZW50ICE9PSBjKSByZXR1cm47CiAgICAgIGMuYm9keVN0YXRlID0gJ2Vycm9yJzsKICAgICAgYy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIE4uY3R4Lm9uU3RhdGVFcnJvcihlcnIpOwogICAgICBlbHNlIGRyYXdFZGl0b3IoKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZm9jdXNGaWVsZChrZXkpIHsKICAgIGlmIChrZXkgPT09ICdub3RlLWJvZHknICYmIGVscy5lZCkgeyBlbHMuZWQuZm9jdXMoKTsgcmV0dXJuOyB9CiAgICBjb25zdCBlbCA9IGVscy5lZGl0b3IgJiYgZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yKGBbZGF0YS1rZXk9IiR7a2V5fSJdYCk7CiAgICBpZiAoZWwpIGVsLmZvY3VzKCk7CiAgfQoKICAvLyBXaGljaCBwYW5lIGEgcGhvbmUgc2hvd3M6IHRoZSBsaXN0LCBvciB0aGUgb3BlbiBub3RlLgogIGZ1bmN0aW9uIHNldFZpZXcoKSB7CiAgICBjb25zdCB2aWV3ID0gTi5jdXJyZW50ID8gJ25vdGUnIDogJ2xpc3QnOwogICAgaWYgKGVscy53cmFwKSBlbHMud3JhcC5kYXRhc2V0LnZpZXcgPSB2aWV3OwogICAgaWYgKHZpZXcgIT09IE4udmlldykgewogICAgICBOLnZpZXcgPSB2aWV3OwogICAgICBpZiAoTi5jdHggJiYgTi5jdHgub25WaWV3Q2hhbmdlKSBOLmN0eC5vblZpZXdDaGFuZ2Uodmlldyk7CiAgICB9CiAgfQoK",
"ICAvLyBCYWNrIHRvIHRoZSBsaXN0LCBvbmNlIHdoYXRldmVyIGlzIHBlbmRpbmcgaXMgc2F2ZWQuIEEgc2F2ZSB0aGF0CiAgLy8gZmFpbGVkIGtlZXBzIHRoZSBub3RlIG9wZW4sIHdpdGggaXRzIGVycm9yIHNob3dpbmcsIHJhdGhlciB0aGFuCiAgLy8gbGVhdmluZyB0aGUgZWRpdHMgYmVoaW5kLgogIGFzeW5jIGZ1bmN0aW9uIGNsb3NlTm90ZSgpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMpIHJldHVybjsKICAgIGF3YWl0IGZsdXNoKCk7CiAgICBpZiAoTi5jdXJyZW50ICE9PSBjKSByZXR1cm47CiAgICBpZiAoYy5kaXJ0eSkgewogICAgICB0b2FzdChOLmN0eC5yb290LCAnTm90IHNhdmVkIHlldCwgc28gdGhlIG5vdGUgc3RheXMgb3Blbi4gVHJ5IGFnYWluIGluIGEgbW9tZW50LicsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgcmV0dXJuOwogICAgfQogICAgTi5jdXJyZW50ID0gbnVsbDsKICAgIGRyYXdFZGl0b3IoKTsKICAgIGRyYXdMaXN0KCk7CiAgfQoKICBmdW5jdGlvbiBkcmF3RWRpdG9yKCkgewogICAgaWYgKCFlbHMuZWRpdG9yKSByZXR1cm47CiAgICBzZXRWaWV3KCk7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFjKSB7CiAgICAgIGlmIChlbHMuZWQpIHsgZWxzLmVkLmRlc3Ryb3koKTsgZWxzLmVkID0gbnVsbDsgfQogICAgICBlbHMuZWRpdG9yLnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtaW50cm8nIH0sCiAgICAgICAgaCgn",
"c3BhbicsIHsgY2xhc3M6ICdwYW5lbC1pY29uJyB9LCBpY29uKCdub3RlJywgMjgpKSwKICAgICAgICBoKCdoMicsIHsgdGV4dDogJ05vdGVzLCBrZXB0IGluIEdtYWlsJyB9KSwKICAgICAgICBoKCdwJywgewogICAgICAgICAgdGV4dDogYEVhY2ggbm90ZSBpcyBzYXZlZCBhcyBhIG1lc3NhZ2UgdW5kZXIg4oCcJHtub3Rlc1N0b3JlLmxhYmVsTmFtZSgpfeKAnSwgb3V0IG9mIHlvdXIgSW5ib3guIGAgKwogICAgICAgICAgICAnR21haWzigJlzIHNlYXJjaCBmaW5kcyBpdCwgeW91ciBwaG9uZSBzaG93cyBpdCwgYW5kIGV2ZXJ5IGVhcmxpZXIgdmVyc2lvbiB3YWl0cyBpbiBHbWFpbOKAmXMgVHJhc2ggZm9yIDMwIGRheXMuJywKICAgICAgICB9KSwKICAgICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi1wcmltYXJ5JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdOZXcgbm90ZScsIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS1uZXctaW50cm8nIH0sIG9uY2xpY2s6ICgpID0-IG5ld05vdGUoKSB9KSkpOwogICAgICByZXR1cm47CiAgICB9CgogICAgZWxzLmJhciA9IGgoJ2RpdicsIHsgY2xhc3M6ICduZS1iYXInIH0pOwogICAgZWxzLmJhbm5lclNsb3QgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtYmFubmVyLXNsb3QnIH0pOwogICAgY29uc3QgdGl0bGUgPSBoKCdpbnB1dCcsIHsKICAgICAgY2xhc3M6ICduZS10aXRsZScsIHR5cGU6ICd0ZXh0JywgcGxhY2Vob2xkZXI6ICdUaXRsZScsICdhcmlhLWxhYmVsJzog",
"J1RpdGxlJywKICAgICAgdmFsdWU6IGMudGl0bGUsIG1heGxlbmd0aDogU3RyaW5nKG5vdGVzTG9naWMuTUFYX1RJVExFKSwgZGF0YXNldDogeyBrZXk6ICdub3RlLXRpdGxlJyB9LAogICAgICBkaXNhYmxlZDogYy5ib2R5U3RhdGUgIT09ICdyZWFkeScsCiAgICAgIG9uaW5wdXQ6IGUgPT4gZWRpdGVkKGMsIHsgdGl0bGU6IGUudGFyZ2V0LnZhbHVlIH0pLAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIC8vIEVudGVyIGluIHRoZSB0aXRsZSBjYXJyaWVzIG9uIGludG8gdGhlIGJvZHksIGFzIGluIG1vc3QgZWRpdG9ycy4KICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicgJiYgIWUuaXNDb21wb3NpbmcpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBmb2N1c0ZpZWxkKCdub3RlLWJvZHknKTsgfQogICAgICB9LAogICAgfSk7CiAgICAvLyBBIGZyZXNoIGVkaXRvciBwZXIgbm90ZTogaXRzIHVuZG8gaGlzdG9yeSBiZWxvbmdzIHRvIHRoYXQgbm90ZS4KICAgIGlmIChlbHMuZWQpIGVscy5lZC5kZXN0cm95KCk7CiAgICBjb25zdCBlZCA9IG5zLm5vdGVFZGl0b3IuY3JlYXRlKHsgcm9vdDogTi5jdHgucm9vdCwgb25DaGFuZ2U6ICgpID0-IGVkaXRlZChjLCB7IGRvYzogZWQuZ2V0RG9jKCkgfSkgfSk7CiAgICBlbHMuZWQgPSBlZDsKICAgIGVkLnNldERvYyhjLmRvYyB8fCBmbXQuZW1wdHlEb2MoKSk7CiAgICBlZC5zZXRFZGl0YWJsZShjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JywKICAgICAgYy5ib2R5U3RhdGUg",
"PT09ICdsb2FkaW5nJyA_ICdMb2FkaW5n4oCmJyA6IGMuYm9keVN0YXRlID09PSAnZXJyb3InID8gJ0NvdWxkbuKAmXQgbG9hZCB0aGlzIG5vdGUuJyA6ICdXcml0ZSBoZXJl4oCmJyk7CgogICAgZWxzLmZpbmRTbG90ID0gaCgnZGl2JywgeyBjbGFzczogJ25lLWZpbmQtc2xvdCcgfSk7CiAgICBlbHMuZWRpdG9yLnJlcGxhY2VDaGlsZHJlbihlbHMuYmFyLCBlbHMuYmFubmVyU2xvdCwgZWxzLmZpbmRTbG90LCB0aXRsZSwgZWQudG9vbGJhciwgZWQubGlua2JhciwgZWQuZWxlbWVudCk7CiAgICBkcmF3QmFyKCk7CiAgICBkcmF3RmluZCgpOwogIH0KCiAgLy8gVGhlIHN0cmlwIGFib3ZlIHRoZSB0ZXh0OiBzdGF0dXMsIGJ1dHRvbnMsIGFuZCB0aGUgYmFubmVyIGZvciBhbgogIC8vIGVtYWlsZWQgbm90ZS4gUmVkcmF3biBvbiBpdHMgb3duIGFmdGVyIGEgc2F2ZSAtIHRoZSBmaXJzdCBzYXZlIG9mIGEKICAvLyBuZXcgbm90ZSBnYWlucyBhbiAiT3BlbiBpbiBHbWFpbCIsIGFuIGVtYWlsZWQgb25lIGxvc2VzIGl0cyBiYW5uZXIgLQogIC8vIHdpdGhvdXQgdG91Y2hpbmcgdGhlIHRleHQgYm94ZXMgdGhlIHVzZXIgbWF5IHN0aWxsIGJlIHR5cGluZyBpbi4KICBmdW5jdGlvbiBkcmF3QmFyKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCAhZWxzLmJhcikgcmV0dXJuOwogICAgY29uc3QgZm9yZWlnbiA9ICEhKGMubm90ZSAmJiAhYy5ub3RlLm93bik7CiAgICBlbHMuc3RhdHVzID0gaCgnc3Bh",
"bicsIHsgY2xhc3M6ICduZS1zdGF0dXMnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScgfSk7CiAgICBlbHMuYmFyLnJlcGxhY2VDaGlsZHJlbigKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4gbmUtYmFjaycsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdCYWNrIHRvIHRoZSBsaXN0JywgdGl0bGU6ICdCYWNrIHRvIHRoZSBsaXN0JywKICAgICAgICBkYXRhc2V0OiB7IGtleTogJ25vdGUtYmFjaycgfSwgb25jbGljazogKCkgPT4gY2xvc2VOb3RlKCksCiAgICAgIH0sIGljb24oJ2JhY2snKSksCiAgICAgIGVscy5zdGF0dXMsCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICduZS1mb2xkZXInLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywKICAgICAgICB0aXRsZTogJ01vdmUgdG8gYW5vdGhlciBmb2xkZXInLCBkYXRhc2V0OiB7IGtleTogJ25vdGUtZm9sZGVyJyB9LAogICAgICAgIG9uY2xpY2s6IGUgPT4gY2hvb3NlRm9sZGVyKGUuY3VycmVudFRhcmdldCksCiAgICAgIH0sIGljb24oJ2ZvbGRlcicsIDE4KSwgaCgnc3BhbicsIHsgdGV4dDogYy5mb2xkZXJJZCA_IGZvbGRlckxhYmVsKGMuZm9sZGVySWQpIHx8ICdObyBmb2xkZXInIDogJ05vIGZvbGRlcicgfSksIGljb24oJ2NhcmV0JywgMTgpKSwKICAgICAgYy5ub3Rl",
"ID8gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnT3BlbiBpbiBHbWFpbCcsIHRpdGxlOiAnT3BlbiBpbiBHbWFpbCcsCiAgICAgICAgZGF0YXNldDogeyBrZXk6ICdub3RlLW9wZW4nIH0sIG9uY2xpY2s6ICgpID0-IG9wZW5JbkdtYWlsKGMpLAogICAgICB9LCBpY29uKCdvcGVuJykpIDogbnVsbCwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiBmb3JlaWduID8gJ1Rha2Ugb2ZmIHRoZSBub3RlcyBsaXN0JyA6ICdEZWxldGUgbm90ZScsCiAgICAgICAgdGl0bGU6IGZvcmVpZ24gPyAnVGFrZSBvZmYgdGhlIG5vdGVzIGxpc3QgKHRoZSBlbWFpbCBzdGF5cyknIDogJ0RlbGV0ZSAobW92ZXMgaXQgdG8gR21haWzigJlzIFRyYXNoKScsCiAgICAgICAgZGF0YXNldDogeyBrZXk6ICdub3RlLWRlbGV0ZScgfSwgb25jbGljazogKCkgPT4gZGVsZXRlQ3VycmVudCgpLAogICAgICB9LCBpY29uKCdkZWxldGUnKSkpOwogICAgZWxzLmJhbm5lclNsb3QucmVwbGFjZUNoaWxkcmVuKGZvcmVpZ24gPyBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbmUtYmFubmVyJywKICAgICAgdGV4dDogYFRoaXMgb25lIGlzIGFuIGVtYWlsIGZpbGVkIHVuZGVyIOKAnCR7bm90ZXNTdG9yZS5sYWJlbE5hbWUoKX3igJ0uIEVkaXRpbmcgaXQgc2F2ZXMgYSBuZXcgbm90ZSBpbiBp",
"dHMgcGxhY2U7IGAgKwogICAgICAgICd0aGUgZW1haWwgaXRzZWxmIHN0YXlzIGluIEdtYWlsLCBqdXN0IG9mZiB0aGlzIGxpc3QuJywKICAgIH0pIDogJycpOwogICAgZHJhd1N0YXR1cygpOwogIH0KCiAgZnVuY3Rpb24gZHJhd1N0YXR1cygpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWVscy5zdGF0dXMgfHwgIWMpIHJldHVybjsKICAgIGxldCB0ZXh0OwogICAgaWYgKGMuc2F2aW5nKSB0ZXh0ID0gJ1NhdmluZ-KApic7CiAgICBlbHNlIGlmIChjLmVycm9yICYmIGMuYm9keVN0YXRlID09PSAncmVhZHknKSB0ZXh0ID0gYENvdWxkbuKAmXQgc2F2ZTogJHtjLmVycm9yfWA7CiAgICBlbHNlIGlmIChjLmRpcnR5KSB0ZXh0ID0gJ1Vuc2F2ZWQgY2hhbmdlcyc7CiAgICBlbHNlIGlmIChjLnNhdmVkQXQpIHRleHQgPSBgU2F2ZWQgJHt1dGlsLmFnb1RleHQoRGF0ZS5ub3coKSAtIGMuc2F2ZWRBdCl9YDsKICAgIGVsc2UgaWYgKGMubm90ZSkgdGV4dCA9IGBMYXN0IHNhdmVkICR7dXRpbC5yZWxhdGl2ZURhdGUoYy5ub3RlLnVwZGF0ZWQpfWA7CiAgICBlbHNlIHRleHQgPSAnTmV3IG5vdGUnOwogICAgZWxzLnN0YXR1cy50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBlbHMuc3RhdHVzLmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgISEoYy5lcnJvciAmJiAhYy5zYXZpbmcgJiYgYy5ib2R5U3RhdGUgPT09ICdyZWFkeScpKTsKICAgIGVscy5zdGF0dXMudGl0bGUgPSBjLm5vdGUgPyB1dGlsLmZ1bGxEYXRl",
"KGMubm90ZS51cGRhdGVkKSA6ICcnOwogIH0KCiAgLy8g4pSA4pSAIFNhdmluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gZWRpdGVkKGMsIGNoYW5nZSkgewogICAgT2JqZWN0LmFzc2lnbihjLCBjaGFuZ2UpOwogICAgYy5kaXJ0eSA9IHRydWU7CiAgICBjLmVycm9yID0gJyc7CiAgICBkcmF3U3RhdHVzKCk7CiAgICBpZiAoY2hhbmdlLmRvYyAmJiBOLnRlcm1zLmxlbmd0aCkgewogICAgICBjbGVhclRpbWVvdXQoZmluZFRpbWVyKTsKICAgICAgZmluZFRpbWVyID0gc2V0VGltZW91dChhcHBseUhpZ2hsaWdodHMsIDMwMCk7CiAgICB9CiAgICBjbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTsKICAgIHNhdmVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gc2F2ZShjKSwgQVVUT1NBVkVfTVMpOwogIH0KCiAgLy8gU2F2ZXMgYXJlIGNoYWluZWQ6IGVhY2ggb25lIHJldGlyZXMgdGhlIHZlcnNpb24gdGhlIHByZXZpb3VzIG9uZQogIC8vIHdyb3RlLCBzbyB0d28gaW4gZmxpZ2h0IGF0IG9uY2Ugd291bGQgZWFjaCBsZWF2ZSBhIHN0cmF5IGJlaGluZC4KICBmdW5jdGlvbiBzYXZlKGMpIHsKICAgIE4uY2hhaW4gPSBOLmNoYWluLnRoZW4o",
"YXN5bmMgKCkgPT4gewogICAgICBpZiAoIWMuZGlydHkpIHJldHVybjsKICAgICAgLy8gQW4gdW50b3VjaGVkIG5ldyBub3RlIGlzIG5vdCB3b3J0aCBhIG1lc3NhZ2UuCiAgICAgIGlmICghYy5ub3RlICYmICFjLnRpdGxlLnRyaW0oKSAmJiBmbXQuaXNFbXB0eShjLmRvYykpIHsgYy5kaXJ0eSA9IGZhbHNlOyByZXR1cm47IH0KICAgICAgY29uc3Qgc25hcCA9IHsgdGl0bGU6IGMudGl0bGUsIGRvYzogYy5kb2MsIGZvbGRlcklkOiBjLmZvbGRlcklkIH07CiAgICAgIGNvbnN0IGJlZm9yZSA9IGMubm90ZTsKICAgICAgYy5kaXJ0eSA9IGZhbHNlOwogICAgICBjLnNhdmluZyA9IHRydWU7CiAgICAgIGRyYXdTdGF0dXMoKTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBzYXZlZCA9IGF3YWl0IG5vdGVzU3RvcmUuc2F2ZShob29rcy5nZXRBY2NvdW50KCksIGJlZm9yZSwgc25hcCk7CiAgICAgICAgY29uc3Qgb2xkS2V5ID0gYy5rZXk7CiAgICAgICAgY29uc3Qgd2FzT3VycyA9ICEhKGJlZm9yZSAmJiBiZWZvcmUub3duKTsKICAgICAgICBjLm5vdGUgPSBzYXZlZDsKICAgICAgICBjLmtleSA9IHNhdmVkLmtleTsKICAgICAgICBjLnNhdmVkQXQgPSBEYXRlLm5vdygpOwogICAgICAgIGMuZXJyb3IgPSAnJzsKICAgICAgICBOLm5vdGVzID0gW3NhdmVkLCAuLi5OLm5vdGVzLmZpbHRlcihuID0-IG4ua2V5ICE9PSBvbGRLZXkgJiYgbi5rZXkgIT09IHNhdmVkLmtleSldOwogICAgICAgIGlmICghd2FzT3VycyAmJiBOLmN1",
"cnJlbnQgPT09IGMpIGRyYXdCYXIoKTsKICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgYy5kaXJ0eSA9IHRydWU7CiAgICAgICAgYy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgIH0gZmluYWxseSB7CiAgICAgICAgYy5zYXZpbmcgPSBmYWxzZTsKICAgICAgICBpZiAoTi5jdXJyZW50ID09PSBjKSBkcmF3U3RhdHVzKCk7CiAgICAgICAgZHJhd0xpc3QoKTsKICAgICAgfQogICAgfSk7CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIFdoYXRldmVyIGlzIHBlbmRpbmcsIG5vdy4gQ2FsbGVkIG9uIEN0cmwrUywgb24gc3dpdGNoaW5nIG5vdGVzIG9yCiAgLy8gdGFicywgYW5kIHdoZW4gdGhlIGJvYXJkIGNsb3Nlcy4KICBmdW5jdGlvbiBmbHVzaCgpIHsKICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpOwogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIHJldHVybiBjICYmIGMuZGlydHkgPyBzYXZlKGMpIDogTi5jaGFpbjsKICB9CgogIC8vIOKUgOKUgCBPdGhlciBhY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBhc3luYyBmdW5jdGlv",
"biBvcGVuSW5HbWFpbChjKSB7CiAgICBhd2FpdCBmbHVzaCgpOwogICAgaWYgKCFjLm5vdGUgfHwgIWMubm90ZS50aHJlYWRJZCkgcmV0dXJuOwogICAgTi5jdHguY2xvc2VCb2FyZCgpOwogICAgaG9va3Mub3BlblRocmVhZChjLm5vdGUudGhyZWFkSWQpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZGVsZXRlQ3VycmVudCgpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMpIHJldHVybjsKICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpOwogICAgYXdhaXQgTi5jaGFpbjsKICAgIE4uY3VycmVudCA9IG51bGw7CiAgICBkcmF3RWRpdG9yKCk7CiAgICBjb25zdCBub3RlID0gYy5ub3RlOwogICAgaWYgKCFub3RlKSB7IGRyYXdMaXN0KCk7IHJldHVybjsgfSAvLyBuZXZlciBzYXZlZDogbm90aGluZyBpbiBHbWFpbAoKICAgIGNvbnN0IGF0ID0gTi5ub3Rlcy5maW5kSW5kZXgobiA9PiBuLmtleSA9PT0gbm90ZS5rZXkpOwogICAgTi5ub3RlcyA9IE4ubm90ZXMuZmlsdGVyKG4gPT4gbi5rZXkgIT09IG5vdGUua2V5KTsKICAgIGRyYXdMaXN0KCk7CiAgICB0cnkgewogICAgICBhd2FpdCBub3Rlc1N0b3JlLnJldGlyZShub3RlKTsKICAgICAgdG9hc3QoTi5jdHgucm9vdCwgbm90ZS5vd24KICAgICAgICA_ICdOb3RlIG1vdmVkIHRvIEdtYWls4oCZcyBUcmFzaC4nCiAgICAgICAgOiBgVGFrZW4gb2ZmIHRoZSBub3RlcyBsaXN0LiBUaGUgZW1haWwgc3RheXMgaW4gR21haWwuYCwgewogICAgICAgIGFjdGlv",
"bjogeyBsYWJlbDogJ1VuZG8nLCBvbkNsaWNrOiAoKSA9PiB1bmRvRGVsZXRlKG5vdGUsIGF0KSB9LAogICAgICAgIHRpbWVvdXQ6IDgwMDAsCiAgICAgIH0pOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIE4ubm90ZXMuc3BsaWNlKE1hdGgubWF4KDAsIGF0KSwgMCwgbm90ZSk7CiAgICAgIGRyYXdMaXN0KCk7CiAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBDb3VsZG7igJl0IGRlbGV0ZSDigJwke25vdGUudGl0bGV94oCdOiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgIH0KICB9CgogIGFzeW5jIGZ1bmN0aW9uIHVuZG9EZWxldGUobm90ZSwgYXQpIHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IG5vdGVzU3RvcmUucmVzdG9yZShub3RlKTsKICAgICAgTi5ub3Rlcy5zcGxpY2UoTWF0aC5tYXgoMCwgTWF0aC5taW4oYXQsIE4ubm90ZXMubGVuZ3RoKSksIDAsIG5vdGUpOwogICAgICBkcmF3TGlzdCgpOwogICAgICBvcGVuTm90ZShub3RlLCB7IGZvcmNlOiB0cnVlIH0pOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBDb3VsZG7igJl0IGJyaW5nIGl0IGJhY2s6ICR7ZXJyLm1lc3NhZ2V9LiBJdCBpcyBzdGlsbCBpbiBHbWFpbOKAmXMgVHJhc2guYCwgeyBraW5kOiAnZXJyb3InIH0pOwogICAgfQogIH0KCiAgLy8gQ3RybCtTICjijJhTKSBzYXZlcyBub3cgaW5zdGVhZCBvZiBDaHJvbWUncyAiU2F2ZSBwYWdlIGFzIi4KICBmdW5jdGlvbiBoYW5kbGVLZXkoZSkg",
"ewogICAgaWYgKChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5KSAmJiAhZS5hbHRLZXkgJiYgZS5rZXkudG9Mb3dlckNhc2UoKSA9PT0gJ3MnKSB7CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgZmx1c2goKTsKICAgICAgcmV0dXJuIHRydWU7CiAgICB9CiAgICBpZiAoZS5rZXkgPT09ICdGMycgJiYgTi50ZXJtcy5sZW5ndGggJiYgZWxzLmVkKSB7CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgc3RlcE1hdGNoKGUuc2hpZnRLZXkgPyAtMSA6IDEpOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0KICAgIHJldHVybiBmYWxzZTsKICB9CgogIC8vIENhbGxlZCBldmVyeSBmZXcgc2Vjb25kcyB3aGlsZSB0aGUgYm9hcmQgaXMgb3BlbiwgZm9yICJTYXZlZCA1cyBhZ28iLgogIGZ1bmN0aW9uIHRpY2soKSB7CiAgICBkcmF3U3RhdHVzKCk7CiAgfQoKICBmdW5jdGlvbiBmb2N1c0RlZmF1bHQoKSB7CiAgICBpZiAoTi5jdXJyZW50KSBmb2N1c0ZpZWxkKE4uY3VycmVudC5ib2R5U3RhdGUgPT09ICdyZWFkeScgJiYgTi5jdXJyZW50LnRpdGxlID8gJ25vdGUtYm9keScgOiAnbm90ZS10aXRsZScpOwogICAgZWxzZSBpZiAoZWxzLnNlYXJjaCkgZWxzLnNlYXJjaC5mb2N1cygpOwogIH0KCiAgbnMubm90ZXMgPSB7CiAgICBpbml0LCBlbGVtZW50LCBsb2FkLCBpc1N0YWxlLCBmbHVzaCwgaGFuZGxlS2V5LCB0aWNrLCBmb2N1c0RlZmF1bHQsIGNsb3NlTm90ZSwKICAgIGlzT3BlbjogKCkgPT4gISFOLmN1cnJlbnQs",
"CiAgICBsb2FkZWRBdDogKCkgPT4gTi5sb2FkZWRBdCwKICAgIGlzTG9hZGluZzogKCkgPT4gISFOLmxvYWRpbmcsCiAgfTsKfSkoKTsK\"],[\"addon/app/shell.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAKLy8KLy8gVGhlIGV4dGVuc2lvbidzIE5vdGVzIHZpZXcsIGZ1bGwtc2NyZWVuOiB0aGUgc2FtZSBsaXN0LCBmb2xkZXJzLAovLyBzZWFyY2ggd2l0aCB0aGUgd29yZHMgbWFya2VkLCBmb3JtYXR0aW5nIGVkaXRvciwgYXV0b3NhdmUgYW5kIGZpbmQsCi8vIHdpdGggdGhlIGJvYXJkJ3Mgc3R5bGVzIGFuZCBhIHBob25lIGxheW91dCBvbiB0b3AgLSBvbmUgcGFuZSBhdCBhIHRpbWUsCi8vIHRoZSBsaXN0IG9yIHRoZSBvcGVuIG5vdGUsIHRoZSBmb2xkZXIgdHJlZSBmb2xkZWQgYXdheSBiZWhpbmQgYSBidXR0b24uCi8vCi8vIEEgcGhvbmUgbGVhdmVzIHBhZ2VzIHdpdGhvdXQgY2xvc2luZyB0aGVtLCBzbyB3aGF0ZXZlciBpcyBwZW5kaW5nIGlzCi8vIHNhdmVkIHdoZW5ldmVyIHRoZSBwYWdlIGlzIGhpZGRlbjsgYW5kIEFuZHJvaWQncyBiYWNrIG",
"dlc3R1cmUgZ29lcyBmcm9tCi8vIGEgbm90ZSBiYWNrIHRvIHRoZSBsaXN0LCB0aHJvdWdoIGdvb2dsZS5zY3JpcHQuaGlzdG9yeS4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLCBtb3VudFNoYWRvdywgdG9hc3QgfSA9IG5zLnVpOwoKICBjb25zdCBQSE9ORSA9IGAKOmhvc3QgeyBwb3NpdGlvbjogZml4ZWQgIWltcG9ydGFudDsgaW5zZXQ6IDAgIWltcG9ydGFudDsgfQoub3ZlcmxheSB7IHBhZGRpbmc6IGVudihzYWZlLWFyZWEtaW5zZXQtdG9wKSBlbnYoc2FmZS1hcmVhLWluc2V0LXJpZ2h0KSBlbnYoc2FmZS1hcmVhLWluc2V0LWJvdHRvbSkgZW52KHNhZmUtYXJlYS1pbnNldC1sZWZ0KTsgfQouYXBwLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgcGFkZGluZzogOHB4IDhweCA0cHggMjBweDsgZmxleDogbm9uZTsgfQouYXBwLXRpdGxlIHsgZmxleDogMT",
"sgZm9udC1zaXplOiAyMHB4OyBjb2xvcjogdmFyKC0tZmcpOyB9CgpAbWVkaWEgKG1heC13aWR0aDogNzYwcHgpIHsKICAuYXBwW2RhdGEtdmlldz0ibm90ZSJdIC5hcHAtaGVhZCB7IGRpc3BsYXk6IG5vbmU7IH0KICAubm90ZXMgeyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDA7IHBhZGRpbmc6IDA7IH0KICAubm90ZXNbZGF0YS12aWV3PSJub3RlIl0gLm5vdGVzLWZvbGRlcnMsIC5ub3Rlc1tkYXRhLXZpZXc9Im5vdGUiXSAubm90ZXMtbGlzdCB7IGRpc3BsYXk6IG5vbmU7IH0KICAubm90ZXNbZGF0YS12aWV3PSJsaXN0Il0gLm5vdGUtZWRpdG9yIHsgZGlzcGxheTogbm9uZTsgfQoKICAvKiBGb2xkZXJzOiB0aGUgdHJlZSwgZm9sZGVkIGF3YXkgYmVoaW5kIGEgYnV0dG9uIHRoYXQgc2F5cyB3aGVyZSB5b3UKICAgICBhcmU7IG9wZW4sIGl0IGlzIHRoZSBzYW1lIHRyZWUgYXMgb24gYSBjb21wdXRlciwgbmVzdGluZyBhbmQgYWxsLiAqLwogIC5ub3Rlcy1mb2xkZXJzIHsgZmxleDogbm9uZTsgYmFja2dyb3VuZDogbm9uZTsgYm9yZGVyLXJhZGl1czogMDsgcGFkZGluZzogMnB4IDEycHggNHB4OyB9CiAgLmZvbGRlcnMtdG9nZ2xlIHsKICAgIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgd2lkdGg6IDEwMCU7IGhlaWdodDogNDZweDsgcGFkZGluZzogMCAxMHB4IDAgMTRweDsKICAgIGJvcmRlci1yYWRpdXM6IDE0cHg7IGJhY2tncm91bmQ6IHZhcigtLWNvbCk7IGNvbG",
"9yOiB2YXIoLS1mZyk7IGZvbnQtc2l6ZTogMTVweDsgdGV4dC1hbGlnbjogbGVmdDsKICB9CiAgLmZvbGRlcnMtdG9nZ2xlIC5pY29uIHsgY29sb3I6IHZhcigtLWZnLTIpOyBmbGV4OiBub25lOyB9CiAgLmZ0LWxhYmVsIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQogIC5mdC1jb3VudCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxM3B4OyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9CiAgLm5vdGVzW2RhdGEtZm9sZGVycz0ib3BlbiJdIC5mb2xkZXJzLXRvZ2dsZSB7IGJvcmRlci1yYWRpdXM6IDE0cHggMTRweCAwIDA7IH0KICAubm90ZXNbZGF0YS1mb2xkZXJzPSJvcGVuIl0gLmZvbGRlcnMtdG9nZ2xlIC5pY29uOmxhc3QtY2hpbGQgeyB0cmFuc2Zvcm06IHJvdGF0ZSgxODBkZWcpOyB9CiAgLm5vdGVzOm5vdChbZGF0YS1mb2xkZXJzPSJvcGVuIl0pIC5mb2xkZXJzLWhlYWQsIC5ub3Rlczpub3QoW2RhdGEtZm9sZGVycz0ib3BlbiJdKSAuZm9sZGVyLWl0ZW1zIHsgZGlzcGxheTogbm9uZTsgfQogIC5mb2xkZXJzLWhlYWQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOyBwYWRkaW5nOiAwIDZweCAwIDE2cHg7IH0KICAuZm9sZGVyLWl0ZW1zIHsgZmxleDogbm9uZTsgbWF4LWhlaWdodDogNTV2aDsgYmFja2dyb3VuZDogdmFyKC0tY29sKTsgYm9yZGVyLXJhZGl1cz",
"ogMCAwIDE0cHggMTRweDsgcGFkZGluZzogMnB4IDhweCAxMHB4OyB9CiAgLmZvbGRlci1idG4geyBoZWlnaHQ6IDQ0cHg7IH0KICAvKiBObyBob3ZlciBvbiBhIHBob25lOiBlYWNoIGZvbGRlcidzIOKLryBpcyBhbHdheXMgdGhlcmUsIG5leHQgdG8gaXRzIGNvdW50LiAqLwogIC5mb2xkZXItbWVudSB7IG9wYWNpdHk6IDE7IHJpZ2h0OiA0cHg7IH0KICAuZm9sZGVyLXJvdyAuZm9sZGVyLWNvdW50LCAuZm9sZGVyLXJvdzpob3ZlciAuZm9sZGVyLWNvdW50LCAuZm9sZGVyLXJvdzpmb2N1cy13aXRoaW4gLmZvbGRlci1jb3VudCB7IHZpc2liaWxpdHk6IHZpc2libGU7IG1hcmdpbi1yaWdodDogMzRweDsgfQoKICAubm90ZXMtbGlzdCB7IGZsZXg6IDE7IGJvcmRlci1yYWRpdXM6IDA7IGJhY2tncm91bmQ6IG5vbmU7IH0KICAubm90ZXMtdG9vbHMgeyBwYWRkaW5nOiA0cHggMTJweCA4cHg7IH0KICAubm90ZXMtaXRlbXMgeyBwYWRkaW5nOiAwIDRweCAxMnB4OyB9CiAgLm5vdGUtaXRlbSB7IHBhZGRpbmc6IDEycHg7IH0KCiAgLm5vdGUtZWRpdG9yIHsgZmxleDogMTsgYm9yZGVyLXJhZGl1czogMDsgYm94LXNoYWRvdzogbm9uZTsgfQogIC5uZS1iYWNrIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IG1hcmdpbi1yaWdodDogMnB4OyB9CiAgLm5lLWJhciB7IHBhZGRpbmc6IDZweCA2cHggMCA0cHg7IH0KICAubmUtdGl0bGUgeyBwYWRkaW5nOiA2cHggMTZweCA0cHg7IGZvbnQtc2l6ZTogMjJweDsgfQogIC5uZS10b29sYm",
"FyIHsgbWFyZ2luOiAwIDhweDsgb3ZlcmZsb3cteDogYXV0bzsgZmxleC13cmFwOiBub3dyYXA7IHNjcm9sbGJhci13aWR0aDogbm9uZTsgfQogIC5uZS1saW5rYmFyIHsgbWFyZ2luOiA0cHggOHB4IDA7IH0KICAubmUtYmFubmVyIHsgbWFyZ2luOiA0cHggMTJweCAwOyB9CiAgLm5lLWZpbmQgeyBtYXJnaW46IDRweCAxMnB4IDA7IH0KICAubmUtYm9keSB7IHBhZGRpbmc6IDEwcHggMTZweCA0MHZoOyBmb250LXNpemU6IDE2cHg7IH0KICAubmUtYm9keVtkYXRhLWVtcHR5PSIxIl06OmJlZm9yZSB7IGxlZnQ6IDE2cHg7IH0KICAubm90ZXMtaW50cm8geyBkaXNwbGF5OiBub25lOyB9Cn0KYDsKCiAgLy8gQXBwcyBTY3JpcHQncyBoaXN0b3J5LCBpZiB0aGVyZSBpcyBvbmUsIHVzZWQgc28gdGhhdCBub3RoaW5nIGl0IGRvZXMgLQogIC8vIG9yIGZhaWxzIHRvIGRvIC0gY2FuIHN0b3AgdGhlIGFwcDogdGhlIGJhY2sgZ2VzdHVyZSBpcyBhIG5pY2V0eS4KICBmdW5jdGlvbiBoaXN0b3J5QXBpKCkgewogICAgY29uc3QgYXBpID0gdHlwZW9mIGdvb2dsZSAhPT0gJ3VuZGVmaW5lZCcgJiYgZ29vZ2xlLnNjcmlwdCAmJiBnb29nbGUuc2NyaXB0Lmhpc3Rvcnk7CiAgICBpZiAoIWFwaSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBzYWZlID0gZm4gPT4gKC4uLmFyZ3MpID0-IHsKICAgICAgdHJ5IHsgcmV0dXJuIGFwaVtmbl0oLi4uYXJncyk7IH0gY2F0Y2ggKGVycikgeyBjb25zb2xlLndhcm4oYGdvb2dsZS5zY3JpcHQuaGlzdG",
"9yeS4ke2ZufTogJHtlcnIubWVzc2FnZX1gKTsgcmV0dXJuIHVuZGVmaW5lZDsgfQogICAgfTsKICAgIHJldHVybiB7IHB1c2g6IHNhZmUoJ3B1c2gnKSwgcmVwbGFjZTogc2FmZSgncmVwbGFjZScpLCBzZXRDaGFuZ2VIYW5kbGVyOiBzYWZlKCdzZXRDaGFuZ2VIYW5kbGVyJykgfTsKICB9CgogIGZ1bmN0aW9uIHN0YXJ0KCkgewogICAgY29uc3QgeyByb290IH0gPSBtb3VudFNoYWRvdygnZ2tiLWFwcC1ob3N0JywgbnMuc3R5bGVzLmJvYXJkICsgUEhPTkUpOwogICAgY29uc3QgaGlzdG9yeSA9IGhpc3RvcnlBcGkoKTsKICAgIGxldCBub3RlT25IaXN0b3J5ID0gZmFsc2U7CgogICAgY29uc3QgaGVhZCA9IGgoJ2hlYWRlcicsIHsgY2xhc3M6ICdhcHAtaGVhZCcgfSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdhcHAtdGl0bGUnLCB0ZXh0OiAnTm90ZXMnIH0pLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCB0aXRsZTogJ1JlZnJlc2gnLCAnYXJpYS1sYWJlbCc6ICdSZWZyZXNoJywgZGF0YXNldDogeyBrZXk6ICdhcHAtcmVmcmVzaCcgfSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiBucy5ub3Rlcy5sb2FkKHsgZm9yY2U6IHRydWUgfSksCiAgICAgIH0sIGljb24oJ3JlZnJlc2gnKSkpOwogICAgY29uc3QgYXBwID0gaCgnZGl2JywgeyBjbGFzczogJ292ZXJsYXkgYXBwJywgZGF0YXNldDogeyB2aWV3OiAnbGlzdCcgfSB9LCBoZWFkKTsKCiAgICBucy",
"5ub3Rlcy5pbml0KHsKICAgICAgcm9vdCwKICAgICAgb25TdGF0ZUVycm9yOiBlcnIgPT4gdG9hc3Qocm9vdCwgZXJyLm1lc3NhZ2UsIHsga2luZDogJ2Vycm9yJyB9KSwKICAgICAgb25Mb2FkZWQoKSB7fSwKICAgICAgY2xvc2VCb2FyZCgpIHt9LAogICAgICBiYXJDaGFuZ2VkKCkge30sCiAgICAgIG9uVmlld0NoYW5nZSh2aWV3KSB7CiAgICAgICAgYXBwLmRhdGFzZXQudmlldyA9IHZpZXc7CiAgICAgICAgaWYgKCFoaXN0b3J5KSByZXR1cm47CiAgICAgICAgLy8gQSBub3RlIG9uIHRoZSBoaXN0b3J5LCBzbyBBbmRyb2lkJ3MgYmFjayBnZXN0dXJlIGNsb3NlcyBpdC4KICAgICAgICBpZiAodmlldyA9PT0gJ25vdGUnKSB7CiAgICAgICAgICBoaXN0b3J5LnB1c2goeyBub3RlOiAxIH0sIHt9LCAnJyk7CiAgICAgICAgICBub3RlT25IaXN0b3J5ID0gdHJ1ZTsKICAgICAgICB9IGVsc2UgaWYgKG5vdGVPbkhpc3RvcnkpIHsKICAgICAgICAgIGhpc3RvcnkucmVwbGFjZSh7fSwge30sICcnKTsKICAgICAgICAgIG5vdGVPbkhpc3RvcnkgPSBmYWxzZTsKICAgICAgICB9CiAgICAgIH0sCiAgICB9KTsKICAgIGFwcC5hcHBlbmRDaGlsZChucy5ub3Rlcy5lbGVtZW50KCkpOwogICAgcm9vdC5hcHBlbmRDaGlsZChhcHApOwogICAgY29uc3QgYm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdib290Jyk7CiAgICBpZiAoYm9vdCkgYm9vdC5yZW1vdmUoKTsKCiAgICBpZiAoaGlzdG9yeSkgewogICAgICBoaXN0b3J5Ln",
"NldENoYW5nZUhhbmRsZXIoZSA9PiB7CiAgICAgICAgaWYgKGUgJiYgZS5zdGF0ZSAmJiBlLnN0YXRlLm5vdGUpIHJldHVybjsKICAgICAgICBpZiAoIW5zLm5vdGVzLmlzT3BlbigpKSByZXR1cm47CiAgICAgICAgbnMubm90ZXMuY2xvc2VOb3RlKCkudGhlbigoKSA9PiB7CiAgICAgICAgICAvLyBOb3QgY2xvc2VkIChhbiB1bnNhdmVkIGVkaXQpOiBiYWNrIG9uIHRoZSBoaXN0b3J5IGl0IGdvZXMuCiAgICAgICAgICBpZiAobnMubm90ZXMuaXNPcGVuKCkpIGhpc3RvcnkucHVzaCh7IG5vdGU6IDEgfSwge30sICcnKTsKICAgICAgICB9KTsKICAgICAgfSk7CiAgICB9CgogICAgLy8gQ3RybCtTIGFuZCBGMywgZm9yIGEga2V5Ym9hcmQuCiAgICByb290LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBlID0-IG5zLm5vdGVzLmhhbmRsZUtleShlKSk7CiAgICAvLyAiU2F2ZWQgNXMgYWdvIi4KICAgIHNldEludGVydmFsKCgpID0-IG5zLm5vdGVzLnRpY2soKSwgNTAwMCk7CiAgICAvLyBBIHBob25lIHN3aXRjaGVzIGF3YXkgd2l0aG91dCBjbG9zaW5nIHRoZSBwYWdlLgogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndmlzaWJpbGl0eWNoYW5nZScsICgpID0-IHsKICAgICAgaWYgKGRvY3VtZW50LnZpc2liaWxpdHlTdGF0ZSA9PT0gJ2hpZGRlbicpIG5zLm5vdGVzLmZsdXNoKCk7CiAgICAgIGVsc2UgaWYgKG5zLm5vdGVzLmlzU3RhbGUoKSkgbnMubm90ZXMubG9hZCgpOwogICAgfSk7CiAgICB3aW5kb3cuYW",
"RkRXZlbnRMaXN0ZW5lcigncGFnZWhpZGUnLCAoKSA9PiBucy5ub3Rlcy5mbHVzaCgpKTsKCiAgICBucy5ub3Rlcy5sb2FkKCk7CiAgfQoKICBmdW5jdGlvbiBydW4oKSB7CiAgICB0cnkgewogICAgICBzdGFydCgpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoZXJyKTsKICAgICAgaWYgKHdpbmRvdy5fX2Jvb3RGYWlsZWQpIHdpbmRvdy5fX2Jvb3RGYWlsZWQoZXJyLm1lc3NhZ2UsIGVyci5zdGFjayk7CiAgICB9CiAgfQoKICBucy5waG9uZUFwcCA9IHsgc3RhcnQgfTsKICBpZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gJ2xvYWRpbmcnKSBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdET01Db250ZW50TG9hZGVkJywgcnVuKTsKICBlbHNlIHJ1bigpOwp9KSgpOwo\"]];\n  var SOURCE = String.fromCharCode(10, 47, 47) + '# sourceURL=app/';\n  function decode(text) {\n    var bin = atob(text.replace(/-/g, '+').replace(/_/g, String.fromCharCode(47)));\n    var bytes = new Uint8Array(bin.length);\n    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n    return new TextDecoder('utf-8').decode(bytes);\n  }\n  function run(name, code) {\n    try {\n      (0, eval)(code + SOURCE + name);\n    } catch (err) {\n      if (!(err ins",
"tanceof EvalError)) throw err;\n      var el = document.createElement('script');\n      el.text = code + SOURCE + name;\n      document.head.appendChild(el);\n    }\n  }\n  var failed = [];\n  for (var i = 0; i < MODULES.length; i++) {\n    try {\n      run(MODULES[i][0], decode(MODULES[i][1]));\n    } catch (err) {\n      failed.push(MODULES[i][0] + ': ' + err.message);\n    }\n  }\n  if (failed.length && window.__bootFailed) window.__bootFailed('Parts that did not load: ' + failed.join('; '));\n})();\n</script>\n</body>\n</html>\n",
].join('');
