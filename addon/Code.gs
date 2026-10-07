// The phone panel and phone app 0.31.0: a Gmail add-on and a web app, in Apps Script.
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
//   src/lib/licence-logic.js
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

var MEMDESK_VERSION = '0.31.0';

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
  const APP_VERSION = '0.31.0';

  // ── Storage keys ─────────────────────────────────────────────────────
  //
  // Keyed by lower-cased account email, because a Gmail tab at /u/1/ is a
  // different mailbox with different labels, and one person's column
  // layout must not leak into another account's board.

  const KEYS = {
    clientId: 'clientId',                        // storage.sync
    dockPlace: 'dockPlace',                      // storage.sync: where the buttons sit in Gmail (dock.js)
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
    licence: 'licence',                          // storage.sync: the trial and the licence key (licenceLogic)
  };

  // Element ids for the two shadow hosts. Short and namespaced rather than
  // branded, so they survive a rename and are unlikely to clash with Gmail.
  const HOST_IDS = {
    board: 'gkb-board-host',
    dock: 'gkb-dock-host',
    bar: 'gkb-bar-host',     // the dock's buttons, in Gmail's top bar
  };

  // The publisher's own OAuth client, for the build that goes to the
  // Chrome Web Store: with it, a user just clicks "Connect Gmail" and needs
  // no Google Cloud project of their own. Empty here, on purpose:
  // tools/package-extension.mjs writes it into the store build only, so a
  // copy loaded from this repository (or a fork) brings its own client,
  // as SETUP.md describes, rather than using up the publisher's quota of
  // users. A client ID saved on the setup page always wins.
  const BUILT_IN_CLIENT_ID = '';

  // The Lemon Squeezy store that sells licences, and where to buy one.
  // 0 while the app is in preview: free for everyone, no trial, and
  // nothing asked of Lemon Squeezy. Set it when licences go on sale (and
  // publish the notice that ends the preview licence - see LICENSE).
  const LICENCE_STORE_ID = 0;
  const LICENCE_BUY_URL = 'https://memdesk.app/#get';

  ns.APP_NAME = APP_NAME;
  ns.LICENCE_STORE_ID = LICENCE_STORE_ID;
  ns.LICENCE_BUY_URL = LICENCE_BUY_URL;
  ns.APP_VERSION = APP_VERSION;
  ns.BUILT_IN_CLIENT_ID = BUILT_IN_CLIENT_ID;
  ns.KEYS = KEYS;
  ns.HOST_IDS = HOST_IDS;

  if (typeof module === 'object' && module.exports) {
    module.exports = { APP_NAME, APP_VERSION, KEYS, HOST_IDS, LICENCE_STORE_ID, LICENCE_BUY_URL };
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
  // And it chimes, a small reward for finishing something.
  const DEFAULT_COLUMNS = [
    { id: 'todo', title: 'To do', label: `${DEFAULT_ROOT}/To do`, archiveOnDrop: false, chime: false },
    { id: 'doing', title: 'Doing', label: `${DEFAULT_ROOT}/Doing`, archiveOnDrop: false, chime: false },
    { id: 'waiting', title: 'Waiting', label: `${DEFAULT_ROOT}/Waiting`, archiveOnDrop: false, chime: false },
    { id: 'done', title: 'Done', label: `${DEFAULT_ROOT}/Done`, archiveOnDrop: true, chime: true },
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
        // Saved before columns could chime: the one that archives is where
        // finished work goes, so that one does.
        chime: typeof c.chime === 'boolean' ? c.chime : !!c.archiveOnDrop,
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
  // `waiting`: that message is the user's own, to someone else, with no
  // reply being written - the ball is in the other court.
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
    const hasDraft = msgs.some(isDraft);
    // Written to no one but the user (a reminder to self): nobody to wait on.
    // No To or Cc at all (Bcc only) is someone else, unseen.
    const to = `${latestHeaders.to || ''},${latestHeaders.cc || ''}`.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || [];
    const toSelf = to.length > 0 && to.every(e => e.toLowerCase() === String(account).toLowerCase());

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
      hasDraft,
      waiting: me && !hasDraft && !toSelf,
      labelIds: [...labels],
    };
  }

  // ── Labels as colours ──
  //
  // A card shows its conversation's Gmail labels that have a colour in
  // Gmail - as the user set them there, so they mean what the user means
  // by them, and Gmail's filters colour cards by themselves - and takes
  // its stripe from the first. Not Gmail's own labels, and not those named
  // in `skip` or under them (the board's, the notes'). Sorted by name, at
  // most MAX_TAGS. `labels`: Gmail's label resources, or a Map of them by
  // id (made once for a whole board). [{ id, name, short, background, text }]
  const MAX_TAGS = 2;
  const HEX = /^#[0-9a-f]{6}$/i;
  function labelTags(labelIds, labels, skip) {
    const byId = labels instanceof Map ? labels : new Map((labels || []).map(l => [l.id, l]));
    const skipped = (skip || []).map(s => String(s).toLowerCase()).filter(Boolean);
    const out = [];
    for (const id of new Set(labelIds || [])) {
      const l = byId.get(id);
      const c = l && l.color;
      if (!l || l.type === 'system' || !c || !HEX.test(c.backgroundColor || '')) continue;
      const name = String(l.name || '');
      const lower = name.toLowerCase();
      if (!name || skipped.some(s => lower === s || lower.startsWith(`${s}/`))) continue;
      out.push({ id, name, short: name.split('/').pop(), background: c.backgroundColor, text: HEX.test(c.textColor || '') ? c.textColor : '#000000' });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.slice(0, MAX_TAGS);
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
    CARD_COLOURS, MAX_TITLE, MAX_NOTE, normaliseCardEdit, displayTitle, cardEditsFrom, MAX_TAGS, labelTags,
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
// It reads and writes, both ways: the second sign-in asks to read the
// list of calendars and to change events and tasks, and the request
// policy below lets through only what the calendar does - reading the
// calendar list, a calendar's events, the task lists and a list's tasks;
// and adding, changing and deleting one event or one task, with only the
// fields the calendar edits.
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
  // "email" lets the worker check whose calendar it is. Reading the list
  // of calendars needs calendar.readonly; calendar.events changes events,
  // and nothing else about a calendar (not its sharing, not the calendar
  // itself).
  const SCOPES = [
    'email',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
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

  // A path of the given shape, each {} one segment.
  const shaped = (p, re) => { const m = re.exec(p); return !!m && m.slice(1).every(isSegment); };
  const EVENTS = /^calendars\/([^/]+)\/events$/;
  const EVENT = /^calendars\/([^/]+)\/events\/([^/]+)$/;
  const TASKS = /^lists\/([^/]+)\/tasks$/;
  const TASK = /^lists\/([^/]+)\/tasks\/([^/]+)$/;

  // What may be asked, by service and method: reads of the four lists;
  // one event or task added (POST to the list), changed (PATCH) or
  // deleted (DELETE). Nothing else - no calendar, list or sharing.
  const ALLOWED = {
    calendar: {
      // One event read on its own: a repeating event's series, for its rule.
      GET: [p => p === 'users/me/calendarList', p => shaped(p, EVENTS), p => shaped(p, EVENT)],
      POST: [p => shaped(p, EVENTS)],
      PATCH: [p => shaped(p, EVENT)],
      DELETE: [p => shaped(p, EVENT)],
    },
    tasks: {
      GET: [p => p === 'users/@me/lists', p => shaped(p, TASKS)],
      POST: [p => shaped(p, TASKS)],
      PATCH: [p => shaped(p, TASK)],
      DELETE: [p => shaped(p, TASK)],
    },
  };

  // The fields the calendar sets, and nothing else: no attendees (who would be
  // sent invitations), no reminders, no sharing. How an event repeats is a
  // list of rule lines, each one of the four kinds Google knows.
  const EVENT_KEYS = ['summary', 'location', 'start', 'end', 'recurrence'];
  const isRuleLines = v => Array.isArray(v) && v.length <= 20 &&
    v.every(l => typeof l === 'string' && /^(RRULE|EXRULE|RDATE|EXDATE)[:;][^\r\n]{1,1000}$/.test(l));
  const TIME_KEYS = ['date', 'dateTime', 'timeZone'];
  const TASK_KEYS = ['title', 'due', 'status', 'completed'];

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
  const onlyKeys = (o, keys) => isPlain(o) && Object.keys(o).every(k => keys.includes(k));

  function isAllowedBody(service, body) {
    if (service === 'tasks') return onlyKeys(body, TASK_KEYS);
    return onlyKeys(body, EVENT_KEYS) && ['start', 'end'].every(k => !own(body, k) || onlyKeys(body[k], TIME_KEYS)) &&
      (!own(body, 'recurrence') || isRuleLines(body.recurrence));
  }

  function isAllowedRequest(service, method, path, body) {
    const m = String(method || 'GET').toUpperCase();
    const rules = own(ALLOWED, service) && own(ALLOWED[service], m) ? ALLOWED[service][m] : null;
    if (!rules || !rules.some(ok => ok(String(path || '')))) return false;
    if (m === 'POST' || m === 'PATCH') return isAllowedBody(service, body);
    return body === undefined || body === null;
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

  // `short`: on a phone, where the week's number does not fit beside its
  // days.
  function title(view, anchor, today, { short = false } = {}) {
    if (view === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      return `${MONTHS_LONG[m - 1]} ${y}`;
    }
    const { start, end } = viewRange(view, anchor);
    const span = spanText(start, addDays(end, -1), today);
    return view === 'week' && !short ? `Week ${isoWeek(anchor)} · ${span}` : span;
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
      // Holidays, birthdays and calendars shared read-only stay read-only.
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    };
  }

  function listSource(l) {
    if (!l || !l.id) return null;
    return { kind: 'tasks', id: String(l.id), name: String(l.title || '').trim() || 'Tasks', on: true, writable: true };
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
  const EVENT_FIELDS = 'items(id,etag,status,summary,start,end,htmlLink,colorId,eventType,location,' +
    'organizer(self),guestsCanModify,recurringEventId),nextPageToken';

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
      kind: 'event', id: `${cal.id}|${ev.id}`, source: cal.id, eventId: String(ev.id), etag: String(ev.etag || ''),
      title: String(ev.summary || '').trim() || '(No title)',
      colour: EVENT_COLOURS[ev.colorId] || cal.colour,
      link: safeLink(ev.htmlLink), where: String(ev.location || '').trim(),
      // Changed here only on a calendar that may be changed, and only an
      // ordinary event: not a birthday or an out-of-office, and not one
      // someone else organises unless they let guests change it.
      editable: !!cal.writable && (!ev.eventType || ev.eventType === 'default') &&
        (!ev.organizer || ev.organizer.self === true || ev.guestsCanModify === true),
      // One occurrence of a repeating event: a change is to this one only.
      recurring: !!ev.recurringEventId,
      seriesId: String(ev.recurringEventId || ''),
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
      kind: 'task', id: `${list.id}|${t.id}`, source: list.id, taskId: String(t.id), title, due,
      done: t.status === 'completed', email: !!mail,
      link: safeLink(mail ? mail.link : t.webViewLink), list: list.name, editable: true,
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

  // ── Changes ──────────────────────────────────────────────────────────
  //
  // What the calendar sends to Google to add, change or move one event or
  // one task, built here so that Node's tests can check them. A time is
  // local time on the 24-hour clock, sent with the offset that day has and
  // the browser's time zone, so Google keeps the event where it was put.

  // "09:30" from "9:30" or "9.30"; '' for anything that is not a time.
  function normTime(s) {
    const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(s || ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
    return `${pad(Number(m[1]))}:${m[2]}`;
  }

  const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const clock = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

  // What was typed into the add box: "Dentist 14:30", "Call Sam at
  // 9.15-10:00". The time (or the two) comes out, and what is left is the
  // title. With no end, an hour, but not past midnight.
  function parseQuick(text) {
    const s = String(text || '');
    const re = /(^|\s)(?:at\s+)?(\d{1,2}[:.]\d{2})(?:\s*[-–]\s*(\d{1,2}[:.]\d{2}))?(?=$|[\s,;!?])/i;
    const m = re.exec(s);
    const start = m ? normTime(m[2]) : '';
    if (!start) return { title: s.trim(), start: '', end: '' };
    let end = m[3] ? normTime(m[3]) : '';
    if (!end || minutes(end) <= minutes(start)) end = clock(Math.min(minutes(start) + 60, 23 * 60 + 59));
    const title = (s.slice(0, m.index) + m[1] + s.slice(m.index + m[0].length))
      .replace(/\s+/g, ' ').replace(/\s+([,;])/g, '$1').replace(/[\s,;]+$/, '').trim();
    return { title, start, end };
  }

  // "2026-10-05T14:30:00+01:00": a day and a time here, as Google wants it.
  function localStamp(day, time) {
    const [y, mo, d] = day.split('-').map(Number);
    const at = new Date(y, mo - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
    const off = -at.getTimezoneOffset();
    const a = Math.abs(off);
    return `${day}T${time}:00${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }

  const clockOf = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // An event or a task as the editor starts it: an existing one, or a new
  // one on `day` in `source` (a calendar's or a list's id).
  function draftOf(item) {
    if (item.kind === 'task') return { kind: 'task', title: item.title, source: item.source, day: item.due || '', done: !!item.done };
    return {
      kind: 'event', title: item.title === '(No title)' ? '' : item.title, source: item.source, where: item.where || '',
      allDay: !!item.allDay, day: item.first,
      endDay: item.allDay ? item.last : dateKey(item.end),
      start: item.allDay ? '' : clockOf(item.start), end: item.allDay ? '' : clockOf(item.end),
    };
  }

  function newDraft(kind, day, source) {
    return kind === 'task'
      ? { kind, title: '', source, day, done: false }
      : { kind, title: '', source, where: '', allDay: false, day, endDay: day, start: '09:00', end: '10:00' };
  }

  // An event, for Google: { body } or { error } to show. A change clears
  // what no longer applies (an all-day event's dateTime, a timed one's
  // date) with nulls; a new one leaves it out. `recurrence`, when given,
  // is the event's rule lines (recurrenceWith).
  function eventBody(d, timeZone, { patch = false, recurrence } = {}) {
    const title = String(d.title || '').trim();
    if (!title) return { error: 'Give it a title.' };
    if (!isKey(d.day)) return { error: 'Choose a day.' };
    const body = { summary: title, location: String(d.where || '').trim() };
    if (!patch && !body.location) delete body.location;
    if (recurrence !== undefined) body.recurrence = recurrence;
    const endDay = isKey(d.endDay) && d.endDay >= d.day ? d.endDay : d.day;
    if (d.allDay) {
      body.start = { date: d.day };
      body.end = { date: addDays(endDay, 1) };
      if (patch) { body.start.dateTime = null; body.end.dateTime = null; }
      return { body };
    }
    const start = normTime(d.start);
    const end = normTime(d.end);
    if (!start) return { error: 'The start time is hours and minutes, as 09:30.' };
    if (!end) return { error: 'The end time is hours and minutes, as 10:30.' };
    const a = localStamp(d.day, start);
    const b = localStamp(endDay, end);
    if (Date.parse(b) <= Date.parse(a)) return { error: 'It has to end after it starts.' };
    body.start = { dateTime: a };
    body.end = { dateTime: b };
    if (timeZone) { body.start.timeZone = timeZone; body.end.timeZone = timeZone; }
    if (patch) { body.start.date = null; body.end.date = null; }
    return { body };
  }

  // A task, for Google: done or not goes in with a change, not a new one.
  function taskBody(d, { patch = false } = {}) {
    const title = String(d.title || '').trim();
    if (!title) return { error: 'Give it a title.' };
    const body = { title, due: isKey(d.day) ? `${d.day}T00:00:00.000Z` : null };
    if (!patch && !body.due) delete body.due;
    if (patch) Object.assign(body, tickBody(!!d.done));
    return { body };
  }

  // Ticked, or not: Google stamps the time it was done itself.
  function tickBody(done) {
    return done ? { status: 'completed' } : { status: 'needsAction', completed: null };
  }

  // Where a timed event goes when it moves: dragged to another day it
  // keeps its times; dropped at a time of day (`startMin`, minutes after
  // midnight on `toDay`) it starts then. Either way it keeps its length.
  function movedTimes(item, fromDay, toDay, startMin) {
    if (typeof startMin === 'number') {
      const [y, mo, d] = toDay.split('-').map(Number);
      const start = new Date(y, mo - 1, d, 0, startMin).getTime();
      return { start, end: start + (item.end - item.start) };
    }
    const delta = daysBetween(fromDay, toDay);
    const shift = ms => { const x = new Date(ms); x.setDate(x.getDate() + delta); return x.getTime(); };
    return { start: shift(item.start), end: shift(item.end) };
  }

  const stampOf = (ms, timeZone) => {
    const t = { dateTime: localStamp(dateKey(ms), clockOf(ms)) };
    if (timeZone) t.timeZone = timeZone;
    return t;
  };

  // Dragged from one day to another (a task to '' for no day): an event
  // keeps its times and length - or, dropped at a time of day, starts
  // then - and a task gets the new day.
  function moveBody(item, fromDay, toDay, timeZone, startMin) {
    if (item.kind === 'task') return { due: toDay ? `${toDay}T00:00:00.000Z` : null };
    const delta = daysBetween(fromDay, toDay);
    if (item.allDay) return { start: { date: addDays(item.first, delta) }, end: { date: addDays(item.last, delta + 1) } };
    const t = movedTimes(item, fromDay, toDay, startMin);
    return { start: stampOf(t.start, timeZone), end: stampOf(t.end, timeZone) };
  }

  // The same move on the item on screen, until Google's answer is in.
  function movedItem(item, fromDay, toDay, startMin) {
    if (item.kind === 'task') return Object.assign({}, item, { due: toDay || '' });
    if (item.allDay) {
      const delta = daysBetween(fromDay, toDay);
      return Object.assign({}, item, { first: addDays(item.first, delta), last: addDays(item.last, delta) });
    }
    const t = movedTimes(item, fromDay, toDay, startMin);
    return Object.assign({}, item, t, { first: dateKey(t.start), last: dateKey(Math.max(t.start, t.end - 1)) });
  }

  // Its bottom edge dragged: a new end, the start kept.
  function resizeBody(item, endMs, timeZone) {
    return { end: stampOf(endMs, timeZone) };
  }

  // ── The day by the hour ──
  //
  // A day's timed events, placed in the week's hour grid: from and to, in
  // minutes after midnight on that day (one that runs past midnight is
  // cut at the day's edges), and side by side where they overlap - `col`
  // of `cols` in their cluster of overlapping events.
  function dayLayout(entries, day) {
    const [y, mo, d] = day.split('-').map(Number);
    const dayStart = new Date(y, mo - 1, d).getTime();
    const dayEnd = new Date(y, mo - 1, d + 1).getTime();
    const minuteOf = ms => { const x = new Date(ms); return x.getHours() * 60 + x.getMinutes(); };
    const placed = entries
      .filter(e => e.item.kind === 'event' && !e.item.allDay && e.item.end > dayStart && e.item.start < dayEnd)
      .map(e => {
        const from = e.item.start <= dayStart ? 0 : minuteOf(e.item.start);
        const to = e.item.end >= dayEnd ? 1440 : minuteOf(e.item.end);
        return { item: e.item, cont: e.cont, from, to: Math.max(to, from + 1), col: 0, cols: 1 };
      })
      .sort((a, b) => a.from - b.from || b.to - a.to);
    // Clusters of events that overlap one another, each laid out in columns.
    let cluster = [];
    let ends = [];
    let reach = -1;
    const close = () => {
      for (const p of cluster) p.cols = ends.length;
      cluster = [];
      ends = [];
    };
    for (const p of placed) {
      if (p.from >= reach) close();
      let col = ends.findIndex(end => end <= p.from);
      if (col < 0) { col = ends.length; ends.push(p.to); } else ends[col] = p.to;
      p.col = col;
      cluster.push(p);
      reach = Math.max(reach, p.to);
    }
    close();
    return placed;
  }

  // ── Repeating ────────────────────────────────────────────────────────
  //
  // How an event repeats is Google's: one RRULE line, with any EXDATE or
  // RDATE lines beside it, which are kept as they are. The editor offers
  // Google's own menu - daily, weekly on the day, monthly on its weekday,
  // annually, every weekday - and a custom rule. A rule it cannot show is
  // kept untouched, unless another is chosen.

  const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const ORDINALS = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
  const FREQS = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
  const WORKDAYS = 'MO,TU,WE,TH,FR';

  // Which of its weekday in its month a day is: 1 to 4, or -1 for a fifth,
  // which Google calls the last.
  const nthOf = day => { const n = Math.ceil(Number(day.slice(8)) / 7); return n > 4 ? -1 : n; };

  // Google's menu, for an event starting on `day`.
  function repeatChoices(day) {
    const wd = weekday(day);
    const nth = nthOf(day);
    return [
      { id: 'none', label: 'Does not repeat', rule: '' },
      { id: 'daily', label: 'Daily', rule: 'RRULE:FREQ=DAILY' },
      { id: 'weekly', label: `Weekly on ${WEEKDAY_NAMES[wd]}`, rule: `RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAY_CODES[wd]}` },
      { id: 'monthly', label: `Monthly on the ${ORDINALS[nth]} ${WEEKDAY_NAMES[wd]}`, rule: `RRULE:FREQ=MONTHLY;BYDAY=${nth}${WEEKDAY_CODES[wd]}` },
      { id: 'yearly', label: `Annually on ${Number(day.slice(8))} ${MONTHS_LONG[Number(day.slice(5, 7)) - 1]}`, rule: 'RRULE:FREQ=YEARLY' },
      { id: 'weekdays', label: 'Every weekday (Monday to Friday)', rule: `RRULE:FREQ=WEEKLY;BYDAY=${WORKDAYS}` },
    ];
  }

  // An RRULE line as its parts, or null for one with parts the editor does
  // not know - which is then kept as it is.
  function parseRule(line) {
    const m = /^RRULE:(.+)$/.exec(String(line || ''));
    if (!m) return null;
    const p = {};
    for (const kv of m[1].split(';')) {
      const [k, v, more] = kv.split('=');
      if (more !== undefined || !v || !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST'].includes(k)) return null;
      p[k] = v;
    }
    if (!FREQS[p.FREQ]) return null;
    const rule = { freq: p.FREQ, interval: 1, byday: [], bymonthday: 0, count: 0, until: '' };
    if (p.INTERVAL) {
      if (!/^\d{1,3}$/.test(p.INTERVAL) || Number(p.INTERVAL) < 1) return null;
      rule.interval = Number(p.INTERVAL);
    }
    if (p.BYDAY) {
      rule.byday = p.BYDAY.split(',');
      if (!rule.byday.every(d => /^(-1|[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/.test(d))) return null;
    }
    if (p.BYMONTHDAY) {
      if (!/^\d{1,2}$/.test(p.BYMONTHDAY) || Number(p.BYMONTHDAY) < 1 || Number(p.BYMONTHDAY) > 31) return null;
      rule.bymonthday = Number(p.BYMONTHDAY);
    }
    if (p.COUNT) {
      if (!/^\d{1,3}$/.test(p.COUNT) || Number(p.COUNT) < 1) return null;
      rule.count = Number(p.COUNT);
    }
    if (p.UNTIL) {
      const u = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(p.UNTIL);
      if (!u) return null;
      rule.until = `${u[1]}-${u[2]}-${u[3]}`;
    }
    return rule;
  }

  // The editor's own form of a rule: every `every` `unit`s; on `days` of a
  // week; a month by its date or by its weekday; ending never, `on` a day,
  // or `after` so many times.
  function customFor(day) {
    return { every: 1, unit: 'week', days: [WEEKDAY_CODES[weekday(day)]], monthBy: 'date', ends: 'never', until: addMonths(day, 3), count: 10 };
  }

  // A parsed rule as the editor's form, or null if the form cannot hold it.
  function customOf(rule, day) {
    if (!rule) return null;
    const c = Object.assign(customFor(day), { every: rule.interval, unit: FREQS[rule.freq] });
    const plain = rule.byday.filter(d => /^[A-Z]{2}$/.test(d));
    if (rule.freq === 'WEEKLY') {
      if (plain.length !== rule.byday.length || rule.bymonthday) return null;
      if (plain.length) c.days = WEEKDAY_CODES.filter(d => plain.includes(d));
    } else if (rule.freq === 'MONTHLY') {
      if (rule.byday.length > 1 || (rule.byday.length && plain.length) || (rule.byday.length && rule.bymonthday)) return null;
      c.monthBy = rule.byday.length ? 'weekday' : 'date';
    } else if (rule.byday.length || rule.bymonthday) {
      return null;
    }
    if (rule.count) Object.assign(c, { ends: 'after', count: rule.count });
    else if (rule.until) Object.assign(c, { ends: 'on', until: rule.until });
    return c;
  }

  // The editor's form as an RRULE line, for an event starting on `day`. An
  // end date is the day itself for an all-day event, and the end of that
  // day in UTC for a timed one, as Google wants it.
  function customRule(c, day, allDay) {
    const freq = Object.keys(FREQS).find(k => FREQS[k] === c.unit) || 'WEEKLY';
    const parts = [`FREQ=${freq}`];
    const every = Math.max(1, Math.min(999, Math.round(Number(c.every) || 1)));
    if (every > 1) parts.push(`INTERVAL=${every}`);
    if (freq === 'WEEKLY') {
      const days = WEEKDAY_CODES.filter(d => (c.days || []).includes(d));
      parts.push(`BYDAY=${(days.length ? days : [WEEKDAY_CODES[weekday(day)]]).join(',')}`);
    }
    if (freq === 'MONTHLY' && c.monthBy === 'weekday') parts.push(`BYDAY=${nthOf(day)}${WEEKDAY_CODES[weekday(day)]}`);
    if (c.ends === 'after') parts.push(`COUNT=${Math.max(1, Math.min(999, Math.round(Number(c.count) || 1)))}`);
    if (c.ends === 'on' && isKey(c.until)) {
      const ymd = c.until.replace(/-/g, '');
      parts.push(`UNTIL=${allDay ? ymd : `${ymd}T235959Z`}`);
    }
    return `RRULE:${parts.join(';')}`;
  }

  // How an event repeats, from its recurrence lines and its first day:
  // { id } - a choice from the menu, 'custom' with its form, 'other' for a
  // rule kept as it is - and the rule line itself.
  function repeatOf(lines, day) {
    const rule = (lines || []).find(l => /^RRULE:/.test(l)) || '';
    if (!rule) return { id: 'none', rule: '' };
    const parsed = parseRule(rule);
    if (!parsed) return { id: 'other', rule };
    const same = (a, b) => a && b && a.freq === b.freq && a.interval === b.interval && a.count === b.count &&
      a.until === b.until && a.bymonthday === b.bymonthday && a.byday.slice().sort().join() === b.byday.slice().sort().join();
    const preset = repeatChoices(day).find(c => c.rule && same(parseRule(c.rule), parsed));
    if (preset) return { id: preset.id, rule };
    const custom = customOf(parsed, day);
    return custom ? { id: 'custom', rule, custom } : { id: 'other', rule };
  }

  // The rule line for what the editor holds, for an event starting on
  // `day`: a choice from the menu (worked out for that day), the custom
  // form, or the rule kept as it was.
  function ruleFor(repeat, day, allDay) {
    if (!repeat || repeat.id === 'none') return '';
    if (repeat.id === 'custom') return customRule(repeat.custom || customFor(day), day, allDay);
    if (repeat.id === 'other') return repeat.rule || '';
    const c = repeatChoices(day).find(x => x.id === repeat.id);
    return c ? c.rule : '';
  }

  // The recurrence lines with a new rule: the other lines (dates left out
  // or added) kept; none at all once it no longer repeats.
  function recurrenceWith(lines, rule) {
    if (!rule) return [];
    return [rule].concat((lines || []).filter(l => !/^RRULE:/.test(l)));
  }

  const listOf = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '');

  // In words, as the editor shows it: "Every 2 weeks on Monday and
  // Thursday, 10 times".
  function describeRepeat(repeat, day) {
    if (!repeat || repeat.id === 'none') return 'Does not repeat';
    if (repeat.id !== 'custom' && repeat.id !== 'other') {
      const c = repeatChoices(day).find(x => x.id === repeat.id);
      return c ? c.label : '';
    }
    const c = repeat.id === 'custom' ? repeat.custom : null;
    if (!c) return 'Repeats as set in Google Calendar';
    const unit = c.every > 1 ? `Every ${c.every} ${c.unit}s` : `${{ day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Annually' }[c.unit]}`;
    let on = '';
    if (c.unit === 'week') on = ` on ${listOf(WEEKDAY_CODES.filter(d => c.days.includes(d)).map(d => WEEKDAY_NAMES[WEEKDAY_CODES.indexOf(d)]))}`;
    if (c.unit === 'month') on = c.monthBy === 'weekday' ? ` on the ${ORDINALS[nthOf(day)]} ${WEEKDAY_NAMES[weekday(day)]}` : ` on day ${Number(day.slice(8))}`;
    const end = c.ends === 'after' ? `, ${c.count} time${c.count === 1 ? '' : 's'}`
      : c.ends === 'on' && isKey(c.until) ? `, until ${Number(c.until.slice(8))} ${MONTHS[Number(c.until.slice(5, 7)) - 1]} ${c.until.slice(0, 4)}` : '';
    return unit + on + end;
  }

  // A change made on one occurrence, for the whole series: the series still
  // starts on its first day, moved by as many days as the occurrence was,
  // with the occurrence's new times, length, title and place.
  function seriesDraft(seriesStartDay, occurrenceDay, d) {
    const day = addDays(seriesStartDay, daysBetween(occurrenceDay, d.day));
    const span = Math.max(0, daysBetween(d.day, isKey(d.endDay) ? d.endDay : d.day));
    return Object.assign({}, d, { day, endDay: addDays(day, span) });
  }

  // The first day of a series, from Google's event for it.
  function startDayOf(ev) {
    const s = (ev && ev.start) || {};
    return isKey(s.date) ? s.date : isFinite(Date.parse(s.dateTime)) ? dateKey(Date.parse(s.dateTime)) : '';
  }

  const eventsPath = calendarId => `calendars/${encodeURIComponent(calendarId)}/events`;
  const eventPath = item => `${eventsPath(item.source)}/${encodeURIComponent(item.eventId)}`;
  const tasksPath = listId => `lists/${encodeURIComponent(listId)}/tasks`;
  const taskPath = item => `${tasksPath(item.source)}/${encodeURIComponent(item.taskId)}`;

  const api = {
    SCOPES, BASES, USERINFO_URL, VIEWS, AGENDA_DAYS, DAY_NAMES, MONTHS, MONTHS_LONG, EVENT_COLOURS,
    isAllowedRequest, buildUrl,
    normTime, parseQuick, localStamp, draftOf, newDraft, eventBody, taskBody, tickBody, moveBody, movedItem, resizeBody, dayLayout,
    WEEKDAY_CODES, WEEKDAY_NAMES, repeatChoices, parseRule, customFor, customOf, customRule, repeatOf, ruleFor,
    recurrenceWith, describeRepeat, seriesDraft, startDayOf,
    eventsPath, eventPath, tasksPath, taskPath,
    dateKey, isKey, fromKey, addDays, daysBetween, weekday, weekStart, isoWeek, monthStart, addMonths, days,
    viewRange, step, monthWeeks, spanText, title, monthName, dayName,
    safeColour, safeLink, calendarSource, listSource, sources, isOn,
    sourceRequests, rangeRequests, eventItem, taskItem, uniqueById, compareItems, byDay, tray,
  };

  ns.calendarLogic = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

// ════ src/lib/licence-logic.js ════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// The licence: a free trial, then a licence key, checked with Lemon Squeezy
//
// Pure rules, shared by the extension's background worker (which keeps
// the licence in Chrome's synced storage and asks Lemon Squeezy), the
// phone app's script (which keeps it in the script's user properties and
// asks through UrlFetchApp), the dev preview's stand-in and the tests.
//
// - A trial of TRIAL_DAYS starts the first time the licence is looked at.
// - A key from the app's own store is activated once, and checked every
//   CHECK_HOURS after that. A key from Supervertaler's store is a licence
//   too, while it is in force: it is only checked, never activated, so it
//   uses up none of the buyer's activations.
// - As in Supervertaler's own code: a reply that cannot be read changes
//   nothing, only one that says the licence is in force renews the
//   OFFLINE_DAYS it may go unconfirmed, and a key from any other store is
//   not a licence.
// - Lemon Squeezy is sent the key and, to activate it, a name for the
//   activation - nothing else, and never a Google sign-in.
//
// While the store's ID (ns.LICENCE_STORE_ID) is 0, the app is in preview:
// free, with no trial, and nothing is asked of Lemon Squeezy at all.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  const TRIAL_DAYS = 14;
  const OFFLINE_DAYS = 30;
  const CHECK_HOURS = 12;
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  // The store that sells Supervertaler's licences.
  const SUPERVERTALER_STORE_ID = 307062;

  const API = 'https://api.lemonsqueezy.com/v1/licenses/';
  // What may be asked, and with what: nothing more ever leaves.
  const FIELDS = {
    activate: { license_key: true, instance_name: true },
    validate: { license_key: true, instance_id: false },
    deactivate: { license_key: true, instance_id: true },
  };
  const KEY_MAX = 200;

  function isAllowedRequest(action, fields) {
    const want = Object.prototype.hasOwnProperty.call(FIELDS, action) ? FIELDS[action] : null;
    if (!want || !fields || typeof fields !== 'object') return false;
    for (const [k, v] of Object.entries(fields)) {
      if (!Object.prototype.hasOwnProperty.call(want, k) || typeof v !== 'string' || !v || v.length > KEY_MAX) return false;
    }
    return Object.keys(want).every(k => !want[k] || typeof fields[k] === 'string');
  }

  const urlOf = action => API + action;

  function formBody(fields) {
    return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  // Lemon Squeezy's reply: { valid | activated | deactivated, error,
  // license_key: { status }, instance: { id }, meta: { store_id,
  // variant_name } }. "Understood" means it carried a licence and its
  // status, as every real reply about an existing key does; anything else
  // is no answer at all.
  function parseReply(text) {
    let r = null;
    try { r = JSON.parse(String(text)); } catch (err) { r = null; }
    if (!r || typeof r !== 'object') return { understood: false, error: '' };
    const lk = r.license_key && typeof r.license_key === 'object' ? r.license_key : null;
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    const inst = r.instance && typeof r.instance === 'object' ? r.instance : {};
    return {
      understood: !!(lk && typeof lk.status === 'string' && lk.status),
      valid: r.valid === true,
      activated: r.activated === true,
      status: lk && typeof lk.status === 'string' ? lk.status : '',
      storeId: Number(meta.store_id) || 0,
      variant: typeof meta.variant_name === 'string' ? meta.variant_name : '',
      instanceId: typeof inst.id === 'string' ? inst.id : '',
      error: typeof r.error === 'string' ? r.error : '',
    };
  }

  // ── The record ──
  //
  // { trialStart, key, kind ('memdesk' | 'supervertaler'), instance,
  //   active, status, variant, checked, tried } - times in ms.
  // `checked`: when Lemon Squeezy last said it was in force; `tried`: when
  // it was last asked, whatever came back, so that checks are spaced out.

  const EMPTY = { key: '', kind: '', instance: '', active: false, status: '', variant: '', checked: 0, tried: 0 };

  // The record as kept, made whole; with a trial started now if there was
  // none and the app is not in preview. `changed`: it needs keeping.
  function settle(stored, storeId, now) {
    const rec = Object.assign({ trialStart: 0 }, EMPTY, stored && typeof stored === 'object' ? stored : {});
    let changed = false;
    if (storeId && !(rec.trialStart > 0)) {
      rec.trialStart = now;
      changed = true;
    }
    return { rec, changed };
  }

  function stateOf(rec, storeId, now) {
    if (!storeId) return 'preview';
    if (rec.key) return rec.active && now - rec.checked < OFFLINE_DAYS * DAY ? 'licensed' : 'expired';
    return now < rec.trialStart + TRIAL_DAYS * DAY ? 'trial' : 'expired';
  }

  // What the views are told; never the key itself, only its end.
  function view(rec, storeId, now) {
    const state = stateOf(rec, storeId, now);
    const out = { state };
    if (state === 'trial') out.daysLeft = Math.max(1, Math.ceil((rec.trialStart + TRIAL_DAYS * DAY - now) / DAY));
    if (rec.key && storeId) {
      Object.assign(out, {
        kind: rec.kind, status: rec.status, variant: rec.variant, keyEnd: rec.key.slice(-4),
        checked: rec.checked,
        // Why it is not in force: Lemon Squeezy said so, or it has not
        // been able to say anything for too long.
        why: rec.active ? (state === 'expired' ? 'unchecked' : '')
          : rec.status === 'not-ours' || rec.status === 'expired' || rec.status === 'disabled' ? rec.status : 'inactive',
      });
    }
    return out;
  }

  function dueForCheck(rec, storeId, now) {
    return !!(storeId && rec.key && now - Math.max(rec.tried || 0, rec.checked || 0) >= CHECK_HOURS * HOUR);
  }

  // Which store a key is from, by Lemon Squeezy's reply.
  function kindOf(reply, storeId) {
    if (storeId && reply.storeId === storeId) return 'memdesk';
    if (reply.storeId === SUPERVERTALER_STORE_ID) return 'supervertaler';
    return '';
  }

  // In force: one of the app's own keys activated and active; a Supervertaler one
  // valid and not expired or disabled (bought but never activated counts).
  function inForce(kind, reply) {
    if (kind === 'memdesk') return reply.valid && reply.status === 'active';
    if (kind === 'supervertaler') return reply.valid && reply.status !== 'expired' && reply.status !== 'disabled';
    return false;
  }

  // ── Entering a key ──
  //
  // One request at a time: called with the replies so far, it says what
  // to ask next ({ ask: [action, fields] }) or how it ended ({ rec } or
  // { error }). First the key is looked up, which says whose it is; one of
  // the app's own is then activated, one of Supervertaler's taken as it is.
  function enterKey(rec, key, storeId, replies, name, now) {
    const k = String(key || '').trim();
    const app = ns.APP_NAME || 'It';
    if (!storeId) return { error: `${app} is free while it is in preview: there is no licence to enter yet.` };
    if (!k || k.length > KEY_MAX) return { error: 'Enter a licence key.' };
    if (!replies.length) return { ask: ['validate', { license_key: k }] };
    const first = replies[0];
    if (!first.understood) return { error: first.error ? sentence(first.error) : 'That key could not be checked. Try again in a moment.' };
    const kind = kindOf(first, storeId);
    if (!kind) return { error: `That is not a licence key for ${app}, or for Supervertaler.` };
    if (kind === 'supervertaler') {
      if (!inForce(kind, first)) return { error: `That Supervertaler licence is ${first.status === 'disabled' ? 'disabled' : 'no longer in force'}.` };
      return { rec: keyed(rec, k, kind, '', first, now) };
    }
    if (first.status === 'expired' || first.status === 'disabled') return { error: `That licence is ${first.status}.` };
    if (replies.length === 1) return { ask: ['activate', { license_key: k, instance_name: name }] };
    const second = replies[1];
    if (!second.activated || !second.instanceId) {
      return { error: second.error ? sentence(second.error) : 'That key could not be activated. Try again in a moment.' };
    }
    return { rec: keyed(rec, k, kind, second.instanceId, Object.assign({}, second, { valid: true }), now) };
  }

  function keyed(rec, key, kind, instance, reply, now) {
    return Object.assign({}, rec, {
      key, kind, instance, active: inForce(kind, reply), status: reply.status,
      variant: reply.variant, checked: now, tried: now,
    });
  }

  // Lemon Squeezy's own words, as a sentence: "license_key not found." →
  // "That licence key was not found."
  function sentence(text) {
    const t = String(text).trim();
    if (/license_key not found/i.test(t)) return 'That licence key was not found.';
    if (/activation limit/i.test(t)) return 'That licence key is already in use on as many devices as it allows. Remove it from one of them first.';
    return /[.!?]$/.test(t) ? t : `${t}.`;
  }

  // ── Checking it ──

  function checkRequest(rec) {
    const fields = { license_key: rec.key };
    if (rec.kind === 'memdesk' && rec.instance) fields.instance_id = rec.instance;
    return ['validate', fields];
  }

  // A check's reply, applied to the record it was about - not to one whose
  // key has changed meanwhile. Unreadable or no reply: only `tried`.
  function afterCheck(rec, key, reply, storeId, now) {
    if (rec.key !== key) return rec;
    if (!reply || !reply.understood) return Object.assign({}, rec, { tried: now });
    const kind = kindOf(reply, storeId);
    if (kind !== rec.kind) return Object.assign({}, rec, { active: false, status: 'not-ours', tried: now });
    const active = inForce(kind, reply);
    return Object.assign({}, rec, {
      active, status: reply.status, variant: reply.variant || rec.variant,
      tried: now, checked: active ? now : rec.checked,
    });
  }

  // ── Removing it ──
  //
  // An activation of the app's own key is given back; whether that worked or not,
  // the key goes from here. The trial's start stays.
  function removeRequest(rec) {
    return rec.kind === 'memdesk' && rec.instance ? ['deactivate', { license_key: rec.key, instance_id: rec.instance }] : null;
  }

  function withoutKey(rec) {
    return Object.assign({}, rec, EMPTY);
  }

  // The name an activation goes by in Lemon Squeezy, for the buyer to know
  // it again: where it is, and since when.
  function activationName(where, now) {
    const d = new Date(now);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${ns.APP_NAME || 'App'} ${where}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  // ── What each surface does, once ──
  //
  // The steps of each action, written once for the worker (where storage
  // and the network answer later) and the phone app's script (where they
  // answer at once). A flow says what it needs - ['load'], ['save', rec]
  // or ['ask', [action, fields]] - and gets the answer back; runAsync and
  // runSync do what it says with the surface's own `io`. io.ask answers
  // with parseReply's result, or { unreachable: true } when Lemon Squeezy
  // could not be reached at all. Before saving, a flow reads the record
  // again and applies its change to that, so a change made elsewhere
  // meanwhile (a key entered in another tab, or on another phone) stands.
  //
  // `env`: { storeId, where (for the activation's name), now() }.
  // Every flow ends with { view } and, if it did not do what was asked,
  // { error } in words for the person.

  const UNREACHABLE = 'Lemon Squeezy, which looks after the licences, could not be reached. Check the connection and try again.';

  function* loadFlow(env) {
    const { rec, changed } = settle(yield ['load'], env.storeId, env.now());
    if (changed) yield ['save', rec];
    return rec;
  }

  // 'status': a check if one is due; 'peek': none (the phone panel, which
  // must not wait); 'check': one now, asked for.
  function* statusFlow(env, mode) {
    let rec = yield* loadFlow(env);
    const check = mode === 'check' ? !!(env.storeId && rec.key) : mode === 'status' && dueForCheck(rec, env.storeId, env.now());
    let error = '';
    if (check) {
      const key = rec.key;
      const reply = yield ['ask', checkRequest(rec)];
      if (reply && reply.unreachable && mode === 'check') error = UNREACHABLE;
      rec = yield* loadFlow(env);
      const next = afterCheck(rec, key, reply && reply.understood ? reply : null, env.storeId, env.now());
      if (next !== rec) {
        rec = next;
        yield ['save', rec];
      }
    }
    return error ? { view: view(rec, env.storeId, env.now()), error } : { view: view(rec, env.storeId, env.now()) };
  }

  function* enterFlow(env, key) {
    const rec = yield* loadFlow(env);
    const replies = [];
    for (;;) {
      const step = enterKey(rec, key, env.storeId, replies, activationName(env.where, env.now()), env.now());
      if (step.error) return { view: view(rec, env.storeId, env.now()), error: step.error };
      if (step.rec) {
        const fresh = yield* loadFlow(env);
        const next = Object.assign({}, step.rec, { trialStart: fresh.trialStart });
        yield ['save', next];
        // The key it takes the place of gives its activation back, if it can.
        const giveBack = fresh.key && fresh.key !== next.key ? removeRequest(fresh) : null;
        if (giveBack) yield ['ask', giveBack];
        return { view: view(next, env.storeId, env.now()) };
      }
      const reply = yield ['ask', step.ask];
      if (!reply || reply.unreachable) return { view: view(rec, env.storeId, env.now()), error: UNREACHABLE };
      replies.push(reply);
    }
  }

  function* removeFlow(env) {
    const rec = yield* loadFlow(env);
    const giveBack = removeRequest(rec);
    if (giveBack) yield ['ask', giveBack];
    const fresh = yield* loadFlow(env);
    const next = fresh.key === rec.key ? withoutKey(fresh) : fresh;
    yield ['save', next];
    return { view: view(next, env.storeId, env.now()) };
  }

  // The flow for an action from a view, or null for one there is not.
  function flow(action, env, key) {
    switch (action) {
      case 'status': case 'peek': case 'check': return statusFlow(env, action);
      case 'enter': return enterFlow(env, key);
      case 'remove': return removeFlow(env);
      default: return null;
    }
  }

  async function runAsync(f, io) {
    let step = f.next();
    while (!step.done) {
      const [op, arg] = step.value;
      step = f.next(await io[op](arg));
    }
    return step.value;
  }

  function runSync(f, io) {
    let step = f.next();
    while (!step.done) {
      const [op, arg] = step.value;
      step = f.next(io[op](arg));
    }
    return step.value;
  }

  const api = {
    TRIAL_DAYS, OFFLINE_DAYS, CHECK_HOURS, SUPERVERTALER_STORE_ID, API,
    isAllowedRequest, urlOf, formBody, parseReply,
    settle, stateOf, view, dueForCheck, kindOf, enterKey, checkRequest, afterCheck, removeRequest, withoutKey, activationName,
    flow, runAsync, runSync,
  };
  ns.licenceLogic = api;
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

  // One change to Google's other APIs (the calendar's): a whole URL that
  // the caller has checked, with an event's version (If-Match). The
  // response ({} for none), or { error }.
  function sendGoogle(url, method, body, etag) {
    const opts = options(method, body);
    if (etag) opts.headers['If-Match'] = etag;
    try {
      return parse(UrlFetchApp.fetch(url, opts), method, url.split('?')[0], 'Google');
    } catch (err) {
      return { error: err };
    }
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

  ns.addonGmail = { call, callAll, getAll, sendGoogle, insertNote, modifyLabels, modifyThread, trashNote, untrashNote, queryString };
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

  // Once the trial or the licence is over: where to enter a key.
  function licenceCard() {
    return card('licence', NAME, 'A licence is needed', CardService.newCardSection().addWidget(greyText(
      `${NAME}'s free trial has ended. To carry on, enter a licence key in the ${NAME} app (in its logo's menu) or in ${NAME} on your computer. The board is still in Gmail, untouched.`)));
  }
  // The licence as kept, not asked about: the panel must not wait.
  const licenceOver = () => ns.app.licence('peek').view.state === 'expired';

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
    if (licenceOver()) return [licenceCard()];
    const g = (e && e.gmail) || (e && e.messageMetadata) || {};
    const messageId = panel.apiId(g.messageId);
    const threadId = panel.apiId(g.threadId);
    if (!messageId && !threadId) return [homeCard()];
    const { columns, thread } = store.openEmail(messageId, threadId);
    return [boardCard(columns, thread.id, panel.currentColumn(columns, thread.labelIds))];
  });

  // A column's button, or Take off the board (no column).
  const onMoveThread = act(e => {
    if (licenceOver()) return respond({ card: licenceCard(), notify: 'Not done: a licence is needed.' });
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
  // Google Calendar and Google Tasks: the same short list of reads the
  // extension's worker allows (calendarLogic.isAllowedRequest), side by
  // side in one round trip, and one change at a time.

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
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
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

  // One change: an event or a task added, changed or deleted - only what
  // the extension's worker lets through (calendarLogic.isAllowedRequest),
  // with an event's version (If-Match), so one changed in Google
  // meanwhile is refused rather than overwritten. { data }, or { error }
  // with a code the page knows: "changed", or "calendar_scope" and the
  // page that allows it.
  function googleWrite(service, method, path, body, etag) {
    const cal = ns.calendarLogic;
    const m = String(method || '').toUpperCase();
    const b = body === null ? undefined : body;
    if (m === 'GET' || !cal.isAllowedRequest(service, m, path, b)) {
      throw new Error(`not_allowed: ${m} ${service} ${path} is not something the calendar does.`);
    }
    const r = gmail.sendGoogle(cal.buildUrl(service, path, null), m, b, service === 'calendar' ? String(etag || '') : '');
    // A deletion answers with nothing at all.
    if (!r || !r.error) return { data: m === 'DELETE' ? null : r };
    const e = r.error;
    if (e.status === 403 && /insufficient.*scope/i.test(e.detail || e.message)) {
      return { error: { code: 'calendar_scope', status: 403, url: allowUrl(), message: 'Changing it is not allowed for this app yet.' } };
    }
    if (e.status === 412) return { error: { code: 'changed', status: 412, message: 'It was changed in Google meanwhile.' } };
    return { error: { message: e.detail || e.message, status: e.status || 0 } };
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

  // ── The licence ──────────────────────────────────────────────────────
  //
  // As the extension's worker keeps it (licenceLogic), in the script's
  // user properties: one for the phone app and the phone panel, on every
  // phone. Lemon Squeezy is asked through UrlFetchApp with the key and a
  // name for the activation - and, unlike every other request this script
  // makes, without the script's Google token, which must never go there.

  const LICENCE = 'licence';

  function askLemon([action, fields]) {
    const lic = ns.licenceLogic;
    if (!lic.isAllowedRequest(action, fields)) throw new Error('not_allowed: that is not something the licence check asks.');
    try {
      const res = UrlFetchApp.fetch(lic.urlOf(action), {
        method: 'post', contentType: 'application/x-www-form-urlencoded', payload: lic.formBody(fields),
        headers: { Accept: 'application/json' }, muteHttpExceptions: true,
      });
      return lic.parseReply(res.getContentText());
    } catch (err) {
      return { understood: false, unreachable: true, error: '' };
    }
  }

  // `action`: 'status', 'peek' (no asking, for the panel), 'check',
  // 'enter' with a key, or 'remove'. { view, error? }.
  function licence(action, key) {
    const lic = ns.licenceLogic;
    const env = { storeId: Number(ns.LICENCE_STORE_ID) || 0, where: 'phone app', now: () => Date.now() };
    const flow = lic.flow(String(action || 'status'), env, typeof key === 'string' ? key : '');
    if (!flow) throw new Error('not_allowed: that is not something the licence check does.');
    return lic.runSync(flow, {
      load: () => {
        try { return JSON.parse(props().getProperty(LICENCE) || 'null'); } catch (err) { return null; }
      },
      save: rec => { props().setProperty(LICENCE, JSON.stringify(rec)); },
      ask: askLemon,
    });
  }

  ns.app = {
    page, start, list, body, save, retire, restore, move, createFolder, renameFolder, deleteFolder,
    account, boardGmail, boardGmailMany, boardColumns, googleMany, googleWrite, allowCalendar, prefsGet, prefsSet, prefsRemove,
    licence,
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
function appGoogleWrite(service, method, path, body, etag) { return gkb.app.googleWrite(service, method, path, body, etag); }

// For the script editor: run once to give the phone app its calendar
// permissions, if its Allow button does not.
function allowCalendar() { return gkb.app.allowCalendar(); }
function appPrefsGet(keys) { return gkb.app.prefsGet(keys); }
function appPrefsSet(items) { return gkb.app.prefsSet(items); }
function appPrefsRemove(keys) { return gkb.app.prefsRemove(keys); }
function appLicence(action, key) { return gkb.app.licence(action, key); }

// ════ the phone app's page (addon/app, built) ════════════════════

var MEMDESK_APP_HTML = [
"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<base target=\"_top\">\n<style>\n  html, body { margin: 0; height: 100%; background: #f6f8fc; }\n  @media (prefers-color-scheme: dark) { html, body { background: #131314; } }\n</style>\n</head>\n<body>\n<div id=\"boot\" style=\"font: 16px/1.5 Roboto, Arial, sans-serif; color: #444746; padding: 24px;\">Loading&hellip;</div>\n<script>\n  (function () {\n    var problems = [];\n    function show(message, stack) {\n      var boot = document.getElementById('boot');\n      if (!boot) return;\n      problems.push(String(message) + (stack ? '\\n' + String(stack).split('\\n').slice(0, 6).join('\\n') : ''));\n      boot.style.color = '#b3261e';\n      boot.textContent = 'The app could not start.';\n      var pre = document.createElement('pre');\n      pre.style.cssText = 'white-space: pre-wrap; font-size: 12px; color: #444746;';\n      pre.textContent = problems.join('\\n\\n'",
");\n      boot.appendChild(pre);\n    }\n    window.addEventListener('error', function (e) {\n      show((e.message || 'unknown error') + (e.lineno ? ' (line ' + e.lineno + ')' : ''), e.error && e.error.stack);\n    });\n    window.addEventListener('unhandledrejection', function (e) {\n      show(String((e.reason && e.reason.message) || e.reason), e.reason && e.reason.stack);\n    });\n    window.__bootFailed = show;\n  })();\n</script>\n<script>\n(function () {\n  var MODULES = [[\"src/shared/ns.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNoYXJlZCBuYW1lc3BhY2UKLy8KLy8gQ29udGVudCBzY3JpcHRzIGFyZSBjbGFzc2ljIHNjcmlwdHMgdGhhdCBhbGwgcnVuIGluIG9uZSBpc29sYXRlZCB3b3JsZC4KLy8gVHdvIGZpbGVzIHRoYXQgZWFjaCBkZWNsYXJlZCBhIHRvcC1sZXZlbCBgY29uc3RgIG9mIHRoZSBzYW1lIG5hbWUgd291",
"bGQKLy8gY29sbGlkZSwgc28gZXZlcnkgZmlsZSB3cmFwcyBpdHNlbGYgaW4gYW4gSUlGRSBhbmQgaGFuZ3Mgd2hhdCBpdCBleHBvcnRzCi8vIG9mZiB0aGlzIG9uZSBvYmplY3QgaW5zdGVhZC4gVGhlIHNlcnZpY2Ugd29ya2VyIGFuZCB0aGUgb3B0aW9ucyBwYWdlCi8vIGxvYWQgdGhlIHNhbWUgZmlsZXMgYW5kIHNlZSB0aGUgc2FtZSBzaGFwZS4KLy8KLy8gQVBQX05BTUUgaXMgdGhlIG9ubHkgcGxhY2UgdGhlIGRpc3BsYXkgbmFtZSBsaXZlcyBpbiBjb2RlLiBOb3RoaW5nCi8vIGludGVybmFsIC0gdGhlIG5hbWVzcGFjZSwgc3RvcmFnZSBrZXlzLCBDU1MgY2xhc3NlcywgZWxlbWVudCBpZHMgLSBpcwovLyBkZXJpdmVkIGZyb20gaXQsIHNvIGEgcmVuYW1lIG5ldmVyIGhhcyB0byB0b3VjaCBzdG9yZWQgZGF0YS4gVGhlIFJFQURNRQovLyBsaXN0cyBldmVyeSBzcG90IHRoYXQgZG9lcyBjYXJyeSB0aGUgbmFtZS4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlz",
"LmdrYiB8fCB7fSk7CgogIGNvbnN0IEFQUF9OQU1FID0gJ01lbURlc2snOwogIC8vIFNob3duIGluIHRoZSBsb2dvJ3MgbWVudS4gVGhlIHNhbWUgYXMgbWFuaWZlc3QuanNvbidzIChhIHRlc3Qgc2F5cyBzbyksCiAgLy8gZm9yIHRoZSBwaG9uZSBhcHAgdG9vLCB3aGljaCBoYXMgbm8gbWFuaWZlc3QgdG8gcmVhZCBpdCBmcm9tLgogIGNvbnN0IEFQUF9WRVJTSU9OID0gJzAuMzEuMCc7CgogIC8vIOKUgOKUgCBTdG9yYWdlIGtleXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBLZXllZCBieSBsb3dlci1jYXNlZCBhY2NvdW50IGVtYWlsLCBiZWNhdXNlIGEgR21haWwgdGFiIGF0IC91LzEvIGlzIGEKICAvLyBkaWZmZXJlbnQgbWFpbGJveCB3aXRoIGRpZmZlcmVudCBsYWJlbHMsIGFuZCBvbmUgcGVyc29uJ3MgY29sdW1uCiAgLy8gbGF5b3V0IG11c3Qgbm90IGxlYWsgaW50byBhbm90aGVyIGFjY291bnQncyBib2FyZC4KCiAgY29uc3QgS0VZUyA9IHsKICAgIGNsaWVudElkOiAnY2xpZW50SWQnLCAgICAgICAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgZG9ja1BsYWNlOiAnZG9ja1BsYWNlJywgICAgICAgICAgICAgICAgICAgICAgLy8gc3Rv",
"cmFnZS5zeW5jOiB3aGVyZSB0aGUgYnV0dG9ucyBzaXQgaW4gR21haWwgKGRvY2suanMpCiAgICBjb2x1bW5zOiBlbWFpbCA9PiBgY29sdW1uczoke1N0cmluZyhlbWFpbCkudG9Mb3dlckNhc2UoKX1gLCAvLyBzdG9yYWdlLnN5bmMKICAgIG9yZGVyOiBlbWFpbCA9PiBgb3JkZXI6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgICAgIC8vIHN0b3JhZ2UubG9jYWwKICAgIC8vIENhcmQgZWRpdHMgZ2V0IG9uZSBrZXkgcGVyIGNhcmQgcmF0aGVyIHRoYW4gb25lIG1hcCBwZXIgYWNjb3VudDoKICAgIC8vIHN5bmMgY2FwcyBlYWNoIGl0ZW0gYXQgOCBLQiwgd2hpY2ggYSBzaW5nbGUgbWFwIHdvdWxkIG91dGdyb3cgYWZ0ZXIKICAgIC8vIGEgZmV3IGRvemVuIG5vdGVzLCB3aGlsZSB0aGUgNTEyLWl0ZW0gY2FwIGxlYXZlcyByb29tIGZvciBodW5kcmVkcy4KICAgIGNhcmRQcmVmaXg6IGVtYWlsID0-IGBjYXJkOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfTpgLCAgICAgICAgICAgICAgICAgIC8vIHN0b3JhZ2Uuc3luYwogICAgY2FyZDogKGVtYWlsLCB0aHJlYWRJZCkgPT4gYGNhcmQ6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9OiR7dGhyZWFkSWR9YCwgLy8gc3RvcmFnZS5zeW5jCiAgICBub3RlczogZW1haWwgPT4gYG5vdGVzOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsICAgICAvLyBzdG9yYWdlLnN5bmM6IHsgbGFiZWwsIGxhYmVsSWQgfQogICAgdmlldzogJ3ZpZXcnLCAg",
"ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5sb2NhbDogJ2JvYXJkJyB8ICdub3RlcycKICAgIHByZWY6IChlbWFpbCwgbmFtZSkgPT4gYHByZWY6JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9OiR7bmFtZX1gLCAvLyBzdG9yYWdlLmxvY2FsOiB0aGUgbm90ZXMnIHNtYWxsIHByZWZlcmVuY2VzCiAgICB0b2tlbjogZW1haWwgPT4gYHRva2VuOiR7U3RyaW5nKGVtYWlsKS50b0xvd2VyQ2FzZSgpfWAsICAgICAvLyBzdG9yYWdlLnNlc3Npb24KICAgIGNhbGVuZGFyVG9rZW46IGVtYWlsID0-IGBjdG9rZW46JHtTdHJpbmcoZW1haWwpLnRvTG93ZXJDYXNlKCl9YCwgLy8gc3RvcmFnZS5zZXNzaW9uOiB0aGUgY2FsZW5kYXIncyBvd24gc2lnbi1pbgogICAgZ21haWxUYWJzOiAnZ21haWxUYWJzJywgICAgICAgICAgICAgICAgICAgICAgLy8gc3RvcmFnZS5zZXNzaW9uCiAgICBsaWNlbmNlOiAnbGljZW5jZScsICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBzdG9yYWdlLnN5bmM6IHRoZSB0cmlhbCBhbmQgdGhlIGxpY2VuY2Uga2V5IChsaWNlbmNlTG9naWMpCiAgfTsKCiAgLy8gRWxlbWVudCBpZHMgZm9yIHRoZSB0d28gc2hhZG93IGhvc3RzLiBTaG9ydCBhbmQgbmFtZXNwYWNlZCByYXRoZXIgdGhhbgogIC8vIGJyYW5kZWQsIHNvIHRoZXkgc3Vydml2ZSBhIHJlbmFtZSBhbmQgYXJlIHVubGlrZWx5IHRvIGNsYXNoIHdpdGggR21haWwuCiAgY29uc3QgSE9TVF9JRFMgPSB7CiAgICBi",
"b2FyZDogJ2drYi1ib2FyZC1ob3N0JywKICAgIGRvY2s6ICdna2ItZG9jay1ob3N0JywKICAgIGJhcjogJ2drYi1iYXItaG9zdCcsICAgICAvLyB0aGUgZG9jaydzIGJ1dHRvbnMsIGluIEdtYWlsJ3MgdG9wIGJhcgogIH07CgogIC8vIFRoZSBwdWJsaXNoZXIncyBvd24gT0F1dGggY2xpZW50LCBmb3IgdGhlIGJ1aWxkIHRoYXQgZ29lcyB0byB0aGUKICAvLyBDaHJvbWUgV2ViIFN0b3JlOiB3aXRoIGl0LCBhIHVzZXIganVzdCBjbGlja3MgIkNvbm5lY3QgR21haWwiIGFuZCBuZWVkcwogIC8vIG5vIEdvb2dsZSBDbG91ZCBwcm9qZWN0IG9mIHRoZWlyIG93bi4gRW1wdHkgaGVyZSwgb24gcHVycG9zZToKICAvLyB0b29scy9wYWNrYWdlLWV4dGVuc2lvbi5tanMgd3JpdGVzIGl0IGludG8gdGhlIHN0b3JlIGJ1aWxkIG9ubHksIHNvIGEKICAvLyBjb3B5IGxvYWRlZCBmcm9tIHRoaXMgcmVwb3NpdG9yeSAob3IgYSBmb3JrKSBicmluZ3MgaXRzIG93biBjbGllbnQsCiAgLy8gYXMgU0VUVVAubWQgZGVzY3JpYmVzLCByYXRoZXIgdGhhbiB1c2luZyB1cCB0aGUgcHVibGlzaGVyJ3MgcXVvdGEgb2YKICAvLyB1c2Vycy4gQSBjbGllbnQgSUQgc2F2ZWQgb24gdGhlIHNldHVwIHBhZ2UgYWx3YXlzIHdpbnMuCiAgY29uc3QgQlVJTFRfSU5fQ0xJRU5UX0lEID0gJyc7CgogIC8vIFRoZSBMZW1vbiBTcXVlZXp5IHN0b3JlIHRoYXQgc2VsbHMgbGljZW5jZXMsIGFuZCB3aGVyZSB0byBidXkgb25lLgogIC8vIDAgd2hpbGUgdGhlIGFw",
"cCBpcyBpbiBwcmV2aWV3OiBmcmVlIGZvciBldmVyeW9uZSwgbm8gdHJpYWwsIGFuZAogIC8vIG5vdGhpbmcgYXNrZWQgb2YgTGVtb24gU3F1ZWV6eS4gU2V0IGl0IHdoZW4gbGljZW5jZXMgZ28gb24gc2FsZSAoYW5kCiAgLy8gcHVibGlzaCB0aGUgbm90aWNlIHRoYXQgZW5kcyB0aGUgcHJldmlldyBsaWNlbmNlIC0gc2VlIExJQ0VOU0UpLgogIGNvbnN0IExJQ0VOQ0VfU1RPUkVfSUQgPSAwOwogIGNvbnN0IExJQ0VOQ0VfQlVZX1VSTCA9ICdodHRwczovL21lbWRlc2suYXBwLyNnZXQnOwoKICBucy5BUFBfTkFNRSA9IEFQUF9OQU1FOwogIG5zLkxJQ0VOQ0VfU1RPUkVfSUQgPSBMSUNFTkNFX1NUT1JFX0lEOwogIG5zLkxJQ0VOQ0VfQlVZX1VSTCA9IExJQ0VOQ0VfQlVZX1VSTDsKICBucy5BUFBfVkVSU0lPTiA9IEFQUF9WRVJTSU9OOwogIG5zLkJVSUxUX0lOX0NMSUVOVF9JRCA9IEJVSUxUX0lOX0NMSUVOVF9JRDsKICBucy5LRVlTID0gS0VZUzsKICBucy5IT1NUX0lEUyA9IEhPU1RfSURTOwoKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIHsKICAgIG1vZHVsZS5leHBvcnRzID0geyBBUFBfTkFNRSwgQVBQX1ZFUlNJT04sIEtFWVMsIEhPU1RfSURTLCBMSUNFTkNFX1NUT1JFX0lELCBMSUNFTkNFX0JVWV9VUkwgfTsKICB9Cn0pKCk7Cg\"],[\"src/lib/util.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNtYWxsIHB1cmUgaGVscGVycwovLwovLyBOb3RoaW5nIGluIGhlcmUgdG91Y2hlcyB0aGUgRE9NLCBjaHJvbWUuKiBvciB0aGUgbmV0d29yaywgd2hpY2ggaXMgd2hhdAovLyBsZXRzIHRoZSBOb2RlIHRlc3RzIHJlcXVpcmUgdGhpcyBmaWxlIGRpcmVjdGx5LiBUaGUgY29udGVudCBzY3JpcHRzIGFuZAovLyB0aGUgc2VydmljZSB3b3JrZXIgcmVhY2ggdGhlIHNhbWUgZnVuY3Rpb25zIHRocm91Z2ggdGhlIHNoYXJlZAovLyBuYW1lc3BhY2UgKG5zLnV0aWwpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8g4pSA4pSAIEhlYWRlciBoZWxwZXJzIOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBoZWFkZXJNYXAobWVzc2FnZSkgewogICAgY29uc3Qgb3V0ID0ge307CiAgICBjb25zdCBoZWFkZXJzID0gKG1lc3NhZ2UgJiYgbWVzc2FnZS5wYXlsb2FkICYmIG1lc3NhZ2UucGF5bG9hZC5oZWFkZXJzKSB8fCBbXTsKICAgIGZvciAoY29uc3QgaCBvZiBoZWFkZXJzKSBvdXRbaC5uYW1lLnRvTG93ZXJDYXNlKCldID0gaC52YWx1ZSB8fCAnJzsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyAiQW5uYSBWb3MgPGFubmFAZXhhbXBsZS5jb20-IiDihpIgeyBuYW1lLCBlbWFpbCB9CiAgZnVuY3Rpb24gcGFyc2VBZGRyZXNzKHJhdykgewogICAgaWYgKCFyYXcpIHJldHVybiB7IG5hbWU6ICcnLCBlbWFpbDogJycgfTsKICAgIGNvbnN0IGFuZ2xlZCA9IHJhdy5tYXRjaCgvXlxzKiguKj8pXHMqPChbXj5dKyk-XHMqJC8pOwogICAgaWYgKGFuZ2xlZCkgewogICAgICByZXR1cm4gewogICAgICAgIG5hbWU6IGFuZ2xlZFsxXS5yZXBsYWNlKC9eWyInXXxbIiddJC9nLCAnJykudHJpbSgpLAogICAgICAgIGVtYWlsOiBhbmdsZWRbMl0udHJpbSgpLnRvTG93ZXJDYXNlKCksCiAgICAgIH07CiAgICB9CiAgICByZXR1cm4geyBuYW1lOiAnJywgZW1haWw",
"6IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKSB9OwogIH0KCiAgLy8gV2hhdCB0byBjYWxsIGEgc2VuZGVyIG9uIGEgY2FyZC4gQSBiYXJlIGFkZHJlc3MgaXMgc2hvcnRlbmVkIHRvIGl0cwogIC8vIGxvY2FsIHBhcnQsIGJlY2F1c2UgImFjY291bnRzIiByZWFkcyBiZXR0ZXIgaW4gYSBuYXJyb3cgY29sdW1uIHRoYW4KICAvLyAiYWNjb3VudHNAYnJpZ2h0d2F0ZXItbGFuZ3VhZ2UuZXhhbXBsZSIuCiAgZnVuY3Rpb24gZGlzcGxheU5hbWUoYWRkcikgewogICAgaWYgKCFhZGRyKSByZXR1cm4gJyc7CiAgICBpZiAoYWRkci5uYW1lKSByZXR1cm4gYWRkci5uYW1lOwogICAgcmV0dXJuIChhZGRyLmVtYWlsIHx8ICcnKS5zcGxpdCgnQCcpWzBdOwogIH0KCiAgLy8g4pSA4pSAIEVudGl0aWVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gR21haWwgcmV0dXJucyBzbmlwcGV0cyBIVE1MLWVuY29kZWQuIFRoZSBvYnZpb3VzIGRlY29kZXIgLSBhc3NpZ24gdG8gYQogIC8vIGRldGFjaGVkIGVsZW1lbnQncyBpbm5lckhUTUwgYW5kIHJlYWQgdGV4dENvbnRlbnQgYmFjayAtIGlzIHdoYXQKICAvLyBHbWFpbCdzIFRydXN0ZWQgVHlwZXMgcG9saWN5IGZ",
"vcmJpZHMsIGFuZCBpdCB3b3VsZCBhbHNvIG1lYW4gZmVlZGluZwogIC8vIHVudHJ1c3RlZCBtYWlsIHRleHQgdG8gdGhlIEhUTUwgcGFyc2VyLiBBIGxvb2t1cCB0YWJsZSBkb2VzIHRoZSBqb2IuCgogIC8vIFRoZSBoYW5kZnVsIGV2ZXJ5IG1haWwgbmVlZHMsIHBsdXMgdGhlIHR5cG9ncmFwaGljIG9uZXMgdGhhdCBIVE1MCiAgLy8gbWFpbCB3cml0dGVuIGluIEdtYWlsIG9yIE91dGxvb2sgaXMgZnVsbCBvZi4KICBjb25zdCBOQU1FRCA9IHsKICAgIGFtcDogJyYnLCBsdDogJzwnLCBndDogJz4nLCBxdW90OiAnIicsIGFwb3M6ICInIiwgbmJzcDogJ1x1MDBhMCcsCiAgICBsc3F1bzogJ1x1MjAxOCcsIHJzcXVvOiAnXHUyMDE5JywgbGRxdW86ICdcdTIwMWMnLCByZHF1bzogJ1x1MjAxZCcsCiAgICBuZGFzaDogJ1x1MjAxMycsIG1kYXNoOiAnXHUyMDE0JywgaGVsbGlwOiAnXHUyMDI2JywgYnVsbDogJ1x1MjAyMicsIG1pZGRvdDogJ1x1MDBiNycsCiAgICBsYXF1bzogJ1x1MDBhYicsIHJhcXVvOiAnXHUwMGJiJywgZXVybzogJ1x1MjBhYycsIHBvdW5kOiAnXHUwMGEzJywgY29weTogJ1x1MDBhOScsIHJlZzogJ1x1MDBhZScsIHRyYWRlOiAnXHUyMTIyJywKICB9OwoKICBmdW5jdGlvbiBkZWNvZGVFbnRpdGllcyhpbnB1dCkgewogICAgLy8gU2luZ2xlIHBhc3MsIHNvICImYW1wO2x0OyIgYmVjb21lcyB0aGUgbGl0ZXJhbCB0ZXh0ICImbHQ7IiBhbmQgaXMKICAgIC8vIG5vdCBkZWNvZGVkIGEgc2Vjb25kIHRpbWU",
"gaW50byAiPCIuCiAgICByZXR1cm4gU3RyaW5nKGlucHV0ID09IG51bGwgPyAnJyA6IGlucHV0KS5yZXBsYWNlKAogICAgICAvJigjW3hYXVswLTlhLWZBLUZdezEsNn18I1swLTldezEsN318W2EtekEtWl0rKTsvZywKICAgICAgKHdob2xlLCBib2R5KSA9PiB7CiAgICAgICAgaWYgKGJvZHlbMF0gPT09ICcjJykgewogICAgICAgICAgY29uc3QgaGV4ID0gYm9keVsxXSA9PT0gJ3gnIHx8IGJvZHlbMV0gPT09ICdYJzsKICAgICAgICAgIGNvbnN0IGNvZGUgPSBwYXJzZUludChib2R5LnNsaWNlKGhleCA_IDIgOiAxKSwgaGV4ID8gMTYgOiAxMCk7CiAgICAgICAgICAvLyBPdXQtb2YtcmFuZ2UgYW5kIHN1cnJvZ2F0ZSBjb2RlIHBvaW50cyB3b3VsZCB0aHJvdyBvciBwcm9kdWNlCiAgICAgICAgICAvLyBnYXJiYWdlOyBsZWF2ZSB0aGUgb3JpZ2luYWwgdGV4dCBhbG9uZSBpbnN0ZWFkLgogICAgICAgICAgaWYgKCFpc0Zpbml0ZShjb2RlKSB8fCBjb2RlIDwgMSB8fCBjb2RlID4gMHgxMGZmZmYgfHwKICAgICAgICAgICAgICAoY29kZSA-PSAweGQ4MDAgJiYgY29kZSA8PSAweGRmZmYpKSByZXR1cm4gd2hvbGU7CiAgICAgICAgICByZXR1cm4gU3RyaW5nLmZyb21Db2RlUG9pbnQoY29kZSk7CiAgICAgICAgfQogICAgICAgIGNvbnN0IG5hbWVkID0gTkFNRURbYm9keS50b0xvd2VyQ2FzZSgpXTsKICAgICAgICByZXR1cm4gbmFtZWQgPT09IHVuZGVmaW5lZCA_IHdob2xlIDogbmFtZWQ7CiAgICAgIH0KICAgICk7CiAgfQo",
"KICAvLyDilIDilIAgQWNjb3VudCBkZXRlY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IEVNQUlMX09OTFlfUkUgPSAvXlteXHNAPD4oKSJdK0BbXlxzQDw-KCkiXStcLlteXHNAPD4oKSJdKyQvOwogIGNvbnN0IEVNQUlMX0FOWV9SRSA9IC9bXlxzQDw-KCkiXStAW15cc0A8PigpIl0rXC5bXlxzQDw-KCkiXSsvOwoKICAvLyBHbWFpbCdzIHRpdGxlIGlzICI8dmlldyBvciBzdWJqZWN0PiAtIDxhY2NvdW50PiAtIDxwcm9kdWN0PiIsIGUuZy4KICAvLyAiSW5ib3ggKDMsNTkxKSAtIHNvbWVvbmVAZXhhbXBsZS5jb20gLSBHbWFpbCIuIFdvcmtzcGFjZSBhY2NvdW50cyBjYW4KICAvLyByZXBsYWNlICJHbWFpbCIgd2l0aCB0aGUgb3JnYW5pc2F0aW9uJ3Mgb3duIG5hbWUsIHNvIHRoZSBwcm9kdWN0IHBhcnQKICAvLyBpcyBub3QgbWF0Y2hlZC4gU2Nhbm5pbmcgZnJvbSB0aGUgcmlnaHQgZmluZHMgdGhlIGFjY291bnQgZXZlbiB3aGVuIGEKICAvLyBzdWJqZWN0IGxpbmUgY29udGFpbnMgYW4gYWRkcmVzcyBvciBhIGRhc2ggb2YgaXRzIG93bi4KICBmdW5jdGlvbiBhY2NvdW50RnJvbVRpdGxlKHRpdGxlKSB7CiAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyh0aXRsZSB8fCAnJykuc3BsaXQ",
"oL1xzWy3igJPigJRdXHMvKTsKICAgIGZvciAobGV0IGkgPSBwYXJ0cy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkgewogICAgICBjb25zdCBwID0gcGFydHNbaV0udHJpbSgpOwogICAgICBpZiAoRU1BSUxfT05MWV9SRS50ZXN0KHApKSByZXR1cm4gcC50b0xvd2VyQ2FzZSgpOwogICAgfQogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gIkdvb2dsZSBBY2NvdW50OiBBbm5hIFZvcyAgKGFubmFAZXhhbXBsZS5jb20pIiDihpIgImFubmFAZXhhbXBsZS5jb20iCiAgZnVuY3Rpb24gYWNjb3VudEZyb21BcmlhTGFiZWwobGFiZWwpIHsKICAgIGNvbnN0IG0gPSBTdHJpbmcobGFiZWwgfHwgJycpLm1hdGNoKEVNQUlMX0FOWV9SRSk7CiAgICByZXR1cm4gbSA_IG1bMF0ucmVwbGFjZSgvWykuLDtdKyQvLCAnJykudG9Mb3dlckNhc2UoKSA6ICcnOwogIH0KCiAgLy8gIi9tYWlsL3UvMS8iIOKGkiAxLiBEZWZhdWx0cyB0byAwLCB3aGljaCBpcyB3aGF0IC9tYWlsLyBhbG9uZSBtZWFucy4KICBmdW5jdGlvbiBhY2NvdW50SW5kZXhGcm9tUGF0aChwYXRobmFtZSkgewogICAgY29uc3QgbSA9IFN0cmluZyhwYXRobmFtZSB8fCAnJykubWF0Y2goL1wvbWFpbFwvdVwvKFxkKylcLy8pOwogICAgcmV0dXJuIG0gPyBOdW1iZXIobVsxXSkgOiAwOwogIH0KCiAgLy8g4pSA4pSAIERhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gTW9udGggYW5kIGRheSBuYW1lcyBhcmUgc3BlbGxlZCBvdXQgaGVyZSByYXRoZXIgdGhhbiB0YWtlbiBmcm9tCiAgLy8gSW50bCwgc28gYSBjYXJkIHJlYWRzIHRoZSBzYW1lIHdoYXRldmVyIHRoZSBicm93c2VyIGxvY2FsZSBpcyBhbmQKICAvLyB0aGUgdGVzdHMgZG8gbm90IGRlcGVuZCBvbiB0aGUgbWFjaGluZSB0aGV5IHJ1biBvbi4KCiAgY29uc3QgTU9OVEhTID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsCiAgICAgICAgICAgICAgICAgICdKdWwnLCAnQXVnJywgJ1NlcCcsICdPY3QnLCAnTm92JywgJ0RlYyddOwogIGNvbnN0IERBWVMgPSBbJ1N1bicsICdNb24nLCAnVHVlJywgJ1dlZCcsICdUaHUnLCAnRnJpJywgJ1NhdCddOwoKICBmdW5jdGlvbiBzdGFydE9mRGF5KG1zKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUobXMpOwogICAgcmV0dXJuIG5ldyBEYXRlKGQuZ2V0RnVsbFllYXIoKSwgZC5nZXRNb250aCgpLCBkLmdldERhdGUoKSkuZ2V0VGltZSgpOwogIH0KCiAgLy8gQ29tcGFjdCBhZ2UgZm9yIGEgY2FyZDogImp1c3Qgbm93IiwgIjEyIG1pbiIsICIzIGgiLCAiWWVzdGVyZGF5IiwKICAvLyAiTW9uIiwgIjMgU2VwIiwgIjMgU2VwIDIwMjQiLiBIb3VycyB3aW4gb3ZlciAiWWVzdGV",
"yZGF5IiBmb3IgYW55dGhpbmcKICAvLyB1bmRlciBhIGRheSBvbGQsIGJlY2F1c2UgIjIgaCIgaXMgbW9yZSB1c2VmdWwgYXQgMWFtIHRoYW4gIlllc3RlcmRheSIuCiAgZnVuY3Rpb24gcmVsYXRpdmVEYXRlKHRzLCBub3cgPSBEYXRlLm5vdygpKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fCAhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBub3cgLSB0KTsKICAgIGNvbnN0IG1pbiA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgIGlmIChtaW4gPCAxKSByZXR1cm4gJ2p1c3Qgbm93JzsKICAgIGlmIChtaW4gPCA2MCkgcmV0dXJuIGAke21pbn0gbWluYDsKICAgIGNvbnN0IGhvdXJzID0gTWF0aC5mbG9vcihtaW4gLyA2MCk7CiAgICBpZiAoaG91cnMgPCAyNCkgcmV0dXJuIGAke2hvdXJzfSBoYDsKCiAgICAvLyBDYWxlbmRhciBkYXlzLCBub3QgMjQtaG91ciBibG9ja3MsIHNvICJZZXN0ZXJkYXkiIG1lYW5zIHllc3RlcmRheS4KICAgIGNvbnN0IGRheXMgPSBNYXRoLnJvdW5kKChzdGFydE9mRGF5KG5vdykgLSBzdGFydE9mRGF5KHQpKSAvIDg2NDAwMDAwKTsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGlmIChkYXlzIDw9IDEpIHJldHVybiAnWWVzdGVyZGF5JzsKICAgIGlmIChkYXlzIDwgNykgcmV0dXJuIERBWVNbZC5nZXREYXkoKV07CiAgICBjb25zdCBkbSA9IGAke2QuZ2V0RGF0ZSgpfSAke01PTlRIU1tkLmdldE1",
"vbnRoKCldfWA7CiAgICByZXR1cm4gZC5nZXRGdWxsWWVhcigpID09PSBuZXcgRGF0ZShub3cpLmdldEZ1bGxZZWFyKCkgPyBkbSA6IGAke2RtfSAke2QuZ2V0RnVsbFllYXIoKX1gOwogIH0KCiAgLy8gRnVsbCBkYXRlIGZvciBhIHRvb2x0aXA6ICJUdWUgMyBTZXAgMjAyNiwgMTQ6MDUiLgogIGZ1bmN0aW9uIGZ1bGxEYXRlKHRzKSB7CiAgICBjb25zdCB0ID0gTnVtYmVyKHRzKTsKICAgIGlmICghdCB8fCAhaXNGaW5pdGUodCkpIHJldHVybiAnJzsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSh0KTsKICAgIGNvbnN0IHBhZCA9IG4gPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgICByZXR1cm4gYCR7REFZU1tkLmdldERheSgpXX0gJHtkLmdldERhdGUoKX0gJHtNT05USFNbZC5nZXRNb250aCgpXX0gJHtkLmdldEZ1bGxZZWFyKCl9LCBgICsKICAgICAgICAgICBgJHtwYWQoZC5nZXRIb3VycygpKX06JHtwYWQoZC5nZXRNaW51dGVzKCkpfWA7CiAgfQoKICAvLyBGb3IgInVwZGF0ZWQgWHMgYWdvIiBpbiB0aGUgYm9hcmQgaGVhZGVyLgogIGZ1bmN0aW9uIGFnb1RleHQobXMpIHsKICAgIGNvbnN0IHMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKE51bWJlcihtcykgLyAxMDAwKSk7CiAgICBpZiAocyA8IDUpIHJldHVybiAnanVzdCBub3cnOwogICAgaWYgKHMgPCA2MCkgcmV0dXJuIGAke3N9cyBhZ29gOwogICAgY29uc3QgbSA9IE1hdGguZmxvb3IocyAvIDYwKTsKICAgIGlmIChtIDwgNjApIHJldHVybiBgJHt",
"tfSBtaW4gYWdvYDsKICAgIHJldHVybiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9IGggYWdvYDsKICB9CgogIC8vIOKUgOKUgCBDb25jdXJyZW5jeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUnVucyBmbiBvdmVyIGl0ZW1zIHdpdGggYXQgbW9zdCBgbGltaXRgIGluIGZsaWdodC4gR21haWwncyBwZXItdXNlcgogIC8vIHF1b3RhIGlzIGdlbmVyb3VzLCBidXQgYSBib2FyZCBvZiAxMDAgY2hhbmdlZCB0aHJlYWRzIGZpcmVkIGF0IG9uY2UKICAvLyBzdGlsbCB0cmlwcyBpdHMgYnVyc3QgbGltaXRlcjsgc2l4IGF0IGEgdGltZSBrZWVwcyBhIGNvbGQgbG9hZCBxdWljawogIC8vIHdpdGhvdXQgcHJvdm9raW5nIDQyOXMuIFRoZSBmaXJzdCByZWplY3Rpb24gc3RvcHMgbmV3IHdvcmsgc3RhcnRpbmcKICAvLyBhbmQgaXMgcmUtdGhyb3duLCBzbyBhbiBhdXRoIGZhaWx1cmUgZG9lcyBub3QgZmFuIG91dCBpbnRvIDEwMCBtb3JlLgogIGFzeW5jIGZ1bmN0aW9uIG1hcFBvb2woaXRlbXMsIGxpbWl0LCBmbikgewogICAgY29uc3QgcmVzdWx0cyA9IG5ldyBBcnJheShpdGVtcy5sZW5ndGgpOwogICAgbGV0IG5leHQgPSAwOwogICAgbGV0IGZhaWxlZCA9IG51bGw7CiAgICB",
"hc3luYyBmdW5jdGlvbiB3b3JrZXIoKSB7CiAgICAgIHdoaWxlIChmYWlsZWQgPT09IG51bGwgJiYgbmV4dCA8IGl0ZW1zLmxlbmd0aCkgewogICAgICAgIGNvbnN0IGkgPSBuZXh0Kys7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHJlc3VsdHNbaV0gPSBhd2FpdCBmbihpdGVtc1tpXSwgaSk7CiAgICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgICBpZiAoZmFpbGVkID09PSBudWxsKSBmYWlsZWQgPSBlcnI7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBjb25zdCBuID0gTWF0aC5tYXgoMSwgTWF0aC5taW4obGltaXQsIGl0ZW1zLmxlbmd0aCkpOwogICAgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogbiB9LCB3b3JrZXIpKTsKICAgIGlmIChmYWlsZWQgIT09IG51bGwpIHRocm93IGZhaWxlZDsKICAgIHJldHVybiByZXN1bHRzOwogIH0KCiAgY29uc3QgYXBpID0gewogICAgaGVhZGVyTWFwLCBwYXJzZUFkZHJlc3MsIGRpc3BsYXlOYW1lLCBkZWNvZGVFbnRpdGllcywKICAgIGFjY291bnRGcm9tVGl0bGUsIGFjY291bnRGcm9tQXJpYUxhYmVsLCBhY2NvdW50SW5kZXhGcm9tUGF0aCwKICAgIHJlbGF0aXZlRGF0ZSwgZnVsbERhdGUsIGFnb1RleHQsIG1hcFBvb2wsCiAgfTsKCiAgbnMudXRpbCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/notes-logic.js\"",
",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGVzIGxvZ2ljIChwdXJlKQovLwovLyBBIG5vdGUgaXMgYW4gZW1haWwgdGhhdCB3YXMgbmV2ZXIgc2VudDogYSBtZXNzYWdlIHBsYWNlZCBzdHJhaWdodCBpbnRvCi8vIHRoZSB1c2VyJ3Mgb3duIG1haWxib3ggd2l0aCBtZXNzYWdlcy5pbnNlcnQsIGNhcnJ5aW5nIHRoZSBOb3RlcyBsYWJlbAovLyBhbmQgbm90aGluZyBlbHNlIC0gbm90IElOQk9YLCBub3QgVU5SRUFEIC0gc28gaXQgc3RheXMgb3V0IG9mIHRoZSB3YXkKLy8gdW50aWwgbG9va2VkIGZvciwgYW5kIEdtYWlsJ3Mgb3duIHNlYXJjaCBmaW5kcyBpdC4KLy8KLy8gR21haWwgbWVzc2FnZXMgY2Fubm90IGJlIGNoYW5nZWQgb25jZSBzdG9yZWQsIHNvIHNhdmluZyBhIG5vdGUgaW5zZXJ0cwovLyBhIG5ldyBtZXNzYWdlIGFuZCBtb3ZlcyB0aGUgcHJldmlvdXMgb25lIHRvIFRyYXNoLiBFYWNoIG5vdGUgY2FycmllcyBhCi8vIHN0YWJsZSBpZCBpbiBhbiBYLUdrYi1Ob3RlIGhlYWRlciwgd2hpY2ggaXMgaG93IGl0cyB2ZXJzaW9ucyBhcmUgdGllZAovLyB0b2dldGhlciBhbm",
"QgLSBqdXN0IGFzIGltcG9ydGFudCAtIGhvdyB0aGUgYmFja2dyb3VuZCB3b3JrZXIgdGVsbHMgYQovLyBub3RlIGZyb20gcmVhbCBtYWlsOiBpdCB3aWxsIG9ubHkgaW5zZXJ0IG1lc3NhZ2VzIHRoYXQgY2FycnkgdGhlIGhlYWRlcgovLyBhbmQgb25seSB0cmFzaCBtZXNzYWdlcyB0aGF0IGFscmVhZHkgZG8uCi8vCi8vIExvYWRlZCBieSB0aGUgY29udGVudCBzY3JpcHRzLCB0aGUgc2VydmljZSB3b3JrZXIgYW5kIE5vZGUncyB0ZXN0cy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IE5PVEVfSEVBREVSID0gJ1gtR2tiLU5vdGUnOwogIGNvbnN0IERFRkFVTFRfTEFCRUwgPSAnX05vdGVzJzsKICAvLyAuaW52YWxpZCBpcyByZXNlcnZlZCBhbmQgY2FuIG",
"5ldmVyIGJlIGRlbGl2ZXJlZCB0bywgc28gbm90aGluZyBjYW4KICAvLyBldmVyIGFycml2ZSBmcm9tIG9yIGdvIHRvIHRoaXMgYWRkcmVzcy4KICBjb25zdCBOT1RFX1NFTkRFUiA9ICciTm90ZXMiIDxub3Rlc0Bub3Rlcy5pbnZhbGlkPic7CgogIC8vIEdlbmVyb3VzIGZvciB0eXBlZCBub3RlcywgYW5kIGtlZXBzIG9uZSBzYXZlIGNvbWZvcnRhYmx5IGluc2lkZSB3aGF0CiAgLy8gdGhlIG5vbi11cGxvYWQgaW5zZXJ0IGVuZHBvaW50IGFuZCBhIHJ1bnRpbWUgbWVzc2FnZSB3aWxsIGNhcnJ5LgogIGNvbnN0IE1BWF9CT0RZID0gMTAwMDAwOwogIGNvbnN0IE1BWF9USVRMRSA9IDMwMDsKCiAgLy8gTGFiZWxzIGEgbm90ZSBtYXkgbmV2ZXIgYmUgaW5zZXJ0ZWQgd2l0aC4gQSBub3RlIGluIHRoZSBJbmJveCwgb3IKICAvLyBkcmVzc2VkIHVwIGFzIHNlbnQgb3IgZHJhZnQgbWFpbCwgaXMgbm8gbG9uZ2VyIG91dCBvZiB0aGUgd2F5IC0gYW5kCiAgLy8gbm90aGluZyBoZXJlIHNob3VsZCBldmVyIGJlIGFibGUgdG8gcHV0IG1haWwgaW50byBTcGFtIG9yIFRyYXNoLgogIGNvbnN0IEZPUkJJRERFTl9JTlNFUlRfTEFCRUxTID0gbmV3IFNldChbJ0lOQk9YJywgJ1NFTlQnLCAnRFJBRlQnLCAnU1BBTScsICdUUkFTSCcsICdVTlJFQUQnXSk7CgogIC8vIOKUgOKUgCBJZHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IElEX1JFID0gL15bYS16MC05XXsxMiw0MH0kLzsKCiAgZnVuY3Rpb24gbmV3Tm90ZUlkKHJhbmQgPSBuID0-IGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKSB7CiAgICByZXR1cm4gQXJyYXkuZnJvbShyYW5kKDEyKSwgYiA9PiBiLnRvU3RyaW5nKDM2KS5wYWRTdGFydCgyLCAnMCcpLnNsaWNlKC0yKSkuam9pbignJykuc2xpY2UoMCwgMjApOwogIH0KCiAgLy8gVGhlIHNjcmF0Y2hwYWQ6IG9uZSBub3RlIHdpdGggYSBmaXhlZCBpZCwgc28gdGhhdCBldmVyeSBjb21wdXRlciBhbmQKICAvLyBwaG9uZSBmaW5kcyAtIGFuZCBzYXZlcyBpbnRvIC0gdGhlIHNhbWUgb25lLgogIGNvbnN0IFNDUkFUQ0hQQURfSUQgPSAnc2NyYXRjaHBhZDAwMDAwMCc7CiAgY29uc3QgU0NSQVRDSFBBRF9USVRMRSA9ICdTY3JhdGNocGFkJzsKCiAgLy8gVGhlIGlkIGEgc2F2ZSB3cml0ZXMgdW5kZXI6IHRoZSBub3RlJ3Mgb3duLCBvbmNlIGl0IGhhcyBvbmU7IGZvciBhCiAgLy8gZmlyc3Qgc2F2ZSwgdGhlIHNjcmF0Y2hwYWQncyBpZiB0aGF0IGlzIHdoYXQgaXMgYmVpbmcgc2F2ZWQsIGFuZAogIC8vIG90aGVyd2lzZSBhIG5ldyBvbmUuIE5vIG90aGVyIGlkIGNhbiBiZSBhc2tlZCBmb3IuCiAgZnVuY3Rpb24gbm90ZU",
"lkRm9yKHByZXZpb3VzLCB3YW50ZWQpIHsKICAgIGlmIChwcmV2aW91cyAmJiBwcmV2aW91cy5vd24gJiYgSURfUkUudGVzdChTdHJpbmcocHJldmlvdXMubm90ZUlkIHx8ICcnKSkpIHJldHVybiBwcmV2aW91cy5ub3RlSWQ7CiAgICByZXR1cm4gd2FudGVkID09PSBTQ1JBVENIUEFEX0lEID8gU0NSQVRDSFBBRF9JRCA6IG5ld05vdGVJZCgpOwogIH0KCiAgLy8g4pSA4pSAIEVuY29kaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBieXRlc1RvQmluYXJ5KGJ5dGVzKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIHsKICAgICAgb3V0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCwgYnl0ZXMuc3ViYXJyYXkoaSwgaSArIDB4ODAwMCkpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJpbmFyeVRvQnl0ZXMoYmluKSB7CiAgICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmluLmxlbmd0aDsgaSsrKSBvdXRbaV0gPSBiaW4uY2hhckNvZGVBdChpKSAmID",
"B4ZmY7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgdXRmOFRvQmFzZTY0ID0gcyA9PiBidG9hKGJ5dGVzVG9CaW5hcnkobmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHMpKSk7CgogIGZ1bmN0aW9uIGJhc2U2NFVybEVuY29kZShiaW5hcnkpIHsKICAgIHJldHVybiBidG9hKGJpbmFyeSkucmVwbGFjZSgvXCsvZywgJy0nKS5yZXBsYWNlKC9cLy9nLCAnXycpLnJlcGxhY2UoLz0rJC8sICcnKTsKICB9CgogIGZ1bmN0aW9uIGJhc2U2NFVybERlY29kZShzKSB7CiAgICBjb25zdCBiNjQgPSBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvLS9nLCAnKycpLnJlcGxhY2UoL18vZywgJy8nKS5yZXBsYWNlKC9ccysvZywgJycpOwogICAgcmV0dXJuIGF0b2IoYjY0ICsgJz0nLnJlcGVhdCgoNCAtIChiNjQubGVuZ3RoICUgNCkpICUgNCkpOwogIH0KCiAgLy8gVGV4dCBpbiB3aGF0ZXZlciBjaGFyc2V0IHRoZSBwYXJ0IGRlY2xhcmVkLiBBbiB1bmtub3duIG9yIG1pc2xhYmVsbGVkCiAgLy8gY2hhcnNldCBmYWxscyBiYWNrIHRvIFVURi04IHJhdGhlciB0aGFuIGZhaWxpbmcgdGhlIHdob2xlIG5vdGUuCiAgZnVuY3Rpb24gZGVjb2RlQnl0ZXMoYnl0ZXMsIGNoYXJzZXQpIHsKICAgIHRyeSB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoY2hhcnNldCB8fCAndXRmLTgnKS5kZWNvZGUoYnl0ZXMpOwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoJ3V0Zi04JykuZGVjb2RlKGJ5dGVzKTsKIC",
"AgIH0KICB9CgogIC8vIFJGQyAyMDQ3IGVuY29kZWQgd29yZHMsIGZvciBhIHN1YmplY3QgdGhhdCBpcyBub3QgcGxhaW4gQVNDSUkuIEF0IDM5CiAgLy8gYnl0ZXMgYSB3b3JkLCBldmVuIHRoZSBmaXJzdCBsaW5lICgiU3ViamVjdDogIiBhbmQgb25lIHdvcmQpIHN0YXlzCiAgLy8gdW5kZXIgNzggY2hhcmFjdGVycywgYW5kIG5vIGNoYXJhY3RlciBpcyBzcGxpdCBhY3Jvc3MgdHdvIHdvcmRzLAogIC8vIHdoaWNoIHNvbWUgcmVhZGVycyB3b3VsZCBzaG93IGFzIHR3byBicm9rZW4gaGFsdmVzLgogIGZ1bmN0aW9uIGVuY29kZUhlYWRlclRleHQodGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIGlmICgvXltceDIwLVx4N2VdKiQvLnRlc3QocykpIHJldHVybiBzOwogICAgY29uc3Qgd29yZHMgPSBbXTsKICAgIGxldCBjaHVuayA9ICcnOwogICAgbGV0IGJ5dGVzID0gMDsKICAgIGZvciAoY29uc3QgY2ggb2YgcykgewogICAgICBjb25zdCBuID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGNoKS5sZW5ndGg7CiAgICAgIGlmIChieXRlcyArIG4gPiAzOSAmJiBjaHVuaykgewogICAgICAgIHdvcmRzLnB1c2goY2h1bmspOwogICAgICAgIGNodW5rID0gJyc7CiAgICAgICAgYnl0ZXMgPSAwOwogICAgICB9CiAgICAgIGNodW5rICs9IGNoOwogICAgICBieXRlcyArPSBuOwogICAgfQogICAgaWYgKGNodW5rKSB3b3Jkcy5wdXNoKGNodW5rKTsKICAgIHJldHVybiB3b3Jkcy5tYXAodyA9Pi",
"BgPT9VVEYtOD9CPyR7dXRmOFRvQmFzZTY0KHcpfT89YCkuam9pbignXHJcbiAnKTsKICB9CgogIC8vIFRoZSBpbnZlcnNlLCBmb3IgdGhlIHByZXZpZXcncyBmYWtlIEdtYWlsIGFuZCBmb3IgdGhlIHRlc3RzLiAoVGhlIHJlYWwKICAvLyBBUEkgaGFuZHMgaGVhZGVycyBiYWNrIGFscmVhZHkgZGVjb2RlZC4pCiAgZnVuY3Rpb24gZGVjb2RlSGVhZGVyVGV4dCh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCAnJykKICAgICAgLnJlcGxhY2UoLyg9XD9bXj9dK1w_W0JiUXFdXD9bXj9dKlw_PSlccysoPz09XD8pL2csICckMScpCiAgICAgIC5yZXBsYWNlKC89XD8oW14_XSspXD8oW0JiUXFdKVw_KFteP10qKVw_PS9nLCAoXywgY2hhcnNldCwgZW5jLCB0ZXh0KSA9PiB7CiAgICAgICAgY29uc3QgYmluID0gZW5jLnRvVXBwZXJDYXNlKCkgPT09ICdCJwogICAgICAgICAgPyBhdG9iKHRleHQpCiAgICAgICAgICA6IHRleHQucmVwbGFjZSgvXy9nLCAnICcpLnJlcGxhY2UoLz0oWzAtOUEtRmEtZl17Mn0pL2csIChtLCBoZXgpID0-IFN0cmluZy5mcm9tQ2hhckNvZGUocGFyc2VJbnQoaGV4LCAxNikpKTsKICAgICAgICByZXR1cm4gZGVjb2RlQnl0ZXMoYmluYXJ5VG9CeXRlcyhiaW4pLCBjaGFyc2V0KTsKICAgICAgfSk7CiAgfQoKICAvLyBIZWFkZXIgdmFsdWVzIG5ldmVyIGNhcnJ5IGxpbmUgYnJlYWtzIG9mIHRoZWlyIG93bjogb25lIGluIGEgdGl0bGUKICAvLyB3b3VsZCBlbmQgdGhlIGhlYWRlciBlYX",
"JseSBhbmQgc3RhcnQgYW5vdGhlciBvZiB0aGUgdXNlcidzIGNob29zaW5nLgogIGNvbnN0IG9uZUxpbmUgPSBzID0-IFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9bXHJcblx0XSsvZywgJyAnKS5yZXBsYWNlKC9cc3syLH0vZywgJyAnKS50cmltKCk7CgogIC8vIOKUgOKUgCBCdWlsZGluZyBhIG5vdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIEEgbm90ZSB3aXRoIG5vIHRpdGxlIGlzIGZpbGVkIHVuZGVyIGl0cyBmaXJzdCBsaW5lLCBhcyBtb3N0IG5vdGVzCiAgLy8gYXBwcyBkbywgc28gaXQgc3RpbGwgcmVhZHMgYXMgc29tZXRoaW5nIGluIEdtYWlsJ3MgbWVzc2FnZSBsaXN0LgogIGZ1bmN0aW9uIHRpdGxlRm9yKHRpdGxlLCBib2R5KSB7CiAgICBjb25zdCB0ID0gb25lTGluZSh0aXRsZSkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGlmICh0KSByZXR1cm4gdDsKICAgIGNvbnN0IGZpcnN0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnNwbGl0KCdcbicpLm1hcChsID0-IGwudHJpbSgpKS5maW5kKEJvb2xlYW4pIHx8ICcnOwogICAgcmV0dXJuIG9uZUxpbmUoZmlyc3QpLnNsaWNlKDAsIDgwKTsKICB9CgogIGZ1bmN0aW9uIHdyYXA3NihzKSB7CiAgICByZXR1cm4gcy5yZXBsYWNlKC",
"8uezEsNzZ9L2csICckJlxyXG4nKS50cmltRW5kKCk7CiAgfQoKICBjb25zdCB0ZXh0UGFydCA9ICh0eXBlLCBzKSA9PiBbCiAgICBgQ29udGVudC1UeXBlOiAke3R5cGV9OyBjaGFyc2V0PVVURi04YCwKICAgICdDb250ZW50LVRyYW5zZmVyLUVuY29kaW5nOiBiYXNlNjQnLAogICAgJycsCiAgICB3cmFwNzYodXRmOFRvQmFzZTY0KHMucmVwbGFjZSgvXG4vZywgJ1xyXG4nKSkpLAogIF07CgogIC8vIGBib2R5YCBpcyB0aGUgcGxhaW4gdGV4dC4gV2l0aCBgaHRtbGAgYXMgd2VsbCwgdGhlIG5vdGUgaXMgYQogIC8vIG11bHRpcGFydC9hbHRlcm5hdGl2ZSBtZXNzYWdlOiBHbWFpbCBzaG93cyB0aGUgSFRNTCwgYW5kIGl0cyBwcmV2aWV3cwogIC8vIGFuZCBwbGFpbi10ZXh0IHJlYWRlcnMgZ2V0IHRoZSB0ZXh0LgogIGZ1bmN0aW9uIGJ1aWxkTm90ZVJhdyh7IG5vdGVJZCwgdGl0bGUsIGJvZHksIGh0bWwsIGFjY291bnQsIGRhdGUgPSBuZXcgRGF0ZSgpIH0pIHsKICAgIGlmICghSURfUkUudGVzdChTdHJpbmcobm90ZUlkIHx8ICcnKSkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBub3RlIGlkJyk7CiAgICBjb25zdCBtZSA9IG9uZUxpbmUoYWNjb3VudCk7CiAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKGJvZHkgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNsaWNlKDAsIE1BWF9CT0RZKTsKICAgIGNvbnN0IGhlYWQgPSBbCiAgICAgIC8vIE5vdCBmcm9tIHRoZSBhY2NvdW50J3Mgb3duIGFkZHJlc3M6IEdtYW",
"lsIGZpbGVzIGFueXRoaW5nIGZyb20geW91CiAgICAgIC8vIHVuZGVyIFNlbnQsIHdoYXRldmVyIGxhYmVscyBpdCB3YXMgZ2l2ZW4uIFJlcGxpZXMgc3RpbGwgcmVhY2ggeW91LgogICAgICBgRnJvbTogJHtOT1RFX1NFTkRFUn1gLAogICAgICBgVG86ICR7bWV9YCwKICAgICAgYFJlcGx5LVRvOiAke21lfWAsCiAgICAgIGBTdWJqZWN0OiAke2VuY29kZUhlYWRlclRleHQodGl0bGVGb3IodGl0bGUsIHRleHQpIHx8ICdVbnRpdGxlZCBub3RlJyl9YCwKICAgICAgYERhdGU6ICR7ZGF0ZS50b1VUQ1N0cmluZygpfWAsCiAgICAgIGBNZXNzYWdlLUlEOiA8JHtub3RlSWR9LiR7ZGF0ZS5nZXRUaW1lKCl9QG5vdGVzLmludmFsaWQ-YCwKICAgICAgYCR7Tk9URV9IRUFERVJ9OiAke25vdGVJZH1gLAogICAgICAnTUlNRS1WZXJzaW9uOiAxLjAnLAogICAgXTsKICAgIGxldCBsaW5lczsKICAgIGlmIChodG1sKSB7CiAgICAgIC8vIEJhc2U2NCBuZXZlciBjb250YWlucyAiLSIsIHNvIHRoaXMgYm91bmRhcnkgY2Fubm90IG9jY3VyIGluIGEgcGFydC4KICAgICAgY29uc3QgYm91bmRhcnkgPSBgZ2tiLSR7bm90ZUlkfS0ke2RhdGUuZ2V0VGltZSgpfWA7CiAgICAgIGxpbmVzID0gWwogICAgICAgIC4uLmhlYWQsCiAgICAgICAgYENvbnRlbnQtVHlwZTogbXVsdGlwYXJ0L2FsdGVybmF0aXZlOyBib3VuZGFyeT0iJHtib3VuZGFyeX0iYCwKICAgICAgICAnJywKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dF",
"BhcnQoJ3RleHQvcGxhaW4nLCB0ZXh0KSwKICAgICAgICBgLS0ke2JvdW5kYXJ5fWAsCiAgICAgICAgLi4udGV4dFBhcnQoJ3RleHQvaHRtbCcsIFN0cmluZyhodG1sKSksCiAgICAgICAgYC0tJHtib3VuZGFyeX0tLWAsCiAgICAgICAgJycsCiAgICAgIF07CiAgICB9IGVsc2UgewogICAgICBsaW5lcyA9IFsuLi5oZWFkLCAuLi50ZXh0UGFydCgndGV4dC9wbGFpbicsIHRleHQpLCAnJ107CiAgICB9CiAgICByZXR1cm4gYmFzZTY0VXJsRW5jb2RlKGxpbmVzLmpvaW4oJ1xyXG4nKSk7CiAgfQoKICAvLyDilIDilIAgV2hhdCB0aGUgd29ya2VyIGFsbG93cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaGVhZGVyQmxvY2soYmluYXJ5KSB7CiAgICBjb25zdCBlbmQgPSBiaW5hcnkuc2VhcmNoKC9ccj9cblxyP1xuLyk7CiAgICByZXR1cm4gZW5kIDwgMCA_IGJpbmFyeSA6IGJpbmFyeS5zbGljZSgwLCBlbmQpOwogIH0KCiAgLy8gVGhlIG5vdGUgaWQgYSByYXcgbWVzc2FnZSBjYXJyaWVzLCBvciAnJyBpZiBpdCBpcyBub3QgYSBub3RlLgogIGZ1bmN0aW9uIG5vdGVJZE9mUmF3KHJhdykgewogICAgbGV0IGJpbjsKICAgIHRyeSB7IGJpbiA9IGJhc2U2NFVybERlY29kZShyYXcpOyB9IGNhdGNoIHsgcmV0dXJuICcnOy",
"B9CiAgICBjb25zdCBtID0gaGVhZGVyQmxvY2soYmluKS5tYXRjaChuZXcgUmVnRXhwKGBeJHtOT1RFX0hFQURFUn06WyBcXHRdKihbXlxcclxcbl0qKSRgLCAnbWknKSk7CiAgICBjb25zdCBpZCA9IG0gPyBtWzFdLnRyaW0oKSA6ICcnOwogICAgcmV0dXJuIElEX1JFLnRlc3QoaWQpID8gaWQgOiAnJzsKICB9CgogIC8vIFRoZSBib2R5IG9mIGEgbWVzc2FnZXMuaW5zZXJ0IHRoZSB3b3JrZXIgd2lsbCBwYXNzIG9uOiBhIG5vdGUsIGZpbGVkCiAgLy8gdW5kZXIgdXNlciBsYWJlbHMgb25seSwgYW5kIG5vdGhpbmcgZWxzZSBpbiB0aGUgcmVxdWVzdC4KICBmdW5jdGlvbiBpc05vdGVJbnNlcnQoYm9keSkgewogICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgYm9keS5yYXcgIT09ICdzdHJpbmcnKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBleHRyYSA9IE9iamVjdC5rZXlzKGJvZHkpLmZpbHRlcihrID0-IGsgIT09ICdyYXcnICYmIGsgIT09ICdsYWJlbElkcycpOwogICAgaWYgKGV4dHJhLmxlbmd0aCkgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgbGFiZWxzID0gYm9keS5sYWJlbElkcyA9PT0gdW5kZWZpbmVkID8gW10gOiBib2R5LmxhYmVsSWRzOwogICAgaWYgKCFBcnJheS5pc0FycmF5KGxhYmVscykpIHJldHVybiBmYWxzZTsKICAgIGlmIChsYWJlbHMuc29tZShpZCA9PiBGT1JCSURERU5fSU5TRVJUX0xBQkVMUy5oYXMoU3RyaW5nKGlkKS50b1VwcGVyQ2FzZSgpKSkpIH",
"JldHVybiBmYWxzZTsKICAgIHJldHVybiAhIW5vdGVJZE9mUmF3KGJvZHkucmF3KTsKICB9CgogIC8vIOKUgOKUgCBSZWFkaW5nIG5vdGVzIGJhY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGhlYWRlck9mKG1lc3NhZ2UsIG5hbWUpIHsKICAgIHJldHVybiB1dGlsLmhlYWRlck1hcChtZXNzYWdlKVtuYW1lLnRvTG93ZXJDYXNlKCldIHx8ICcnOwogIH0KCiAgZnVuY3Rpb24gY2hhcnNldE9mKHBhcnQpIHsKICAgIGNvbnN0IGN0ID0gKHBhcnQuaGVhZGVycyB8fCBbXSkuZmluZChoID0-IGgubmFtZS50b0xvd2VyQ2FzZSgpID09PSAnY29udGVudC10eXBlJyk7CiAgICBjb25zdCBtID0gY3QgJiYgL2NoYXJzZXQ9Ij8oW14iO1xzXSspIj8vaS5leGVjKGN0LnZhbHVlKTsKICAgIHJldHVybiBtID8gbVsxXSA6ICd1dGYtOCc7CiAgfQoKICBmdW5jdGlvbiBwYXJ0VGV4dChwYXJ0KSB7CiAgICBpZiAoIXBhcnQgfHwgIXBhcnQuYm9keSB8fCAhcGFydC5ib2R5LmRhdGEpIHJldHVybiAnJzsKICAgIHJldHVybiBkZWNvZGVCeXRlcyhiaW5hcnlUb0J5dGVzKGJhc2U2NFVybERlY29kZShwYXJ0LmJvZHkuZGF0YSkpLCBjaGFyc2V0T2YocGFydCkpOwogIH0KCiAgLy8gQSByb3VnaCB0ZXh0IHJlbm",
"RlcmluZyBvZiBhbiBIVE1MIGVtYWlsLCBmb3Igbm90ZXMgdGhhdCBhcnJpdmVkIGFzCiAgLy8gbWFpbCAoc2F5LCBzZW50IHRvIHlvdXJzZWxmIGZyb20gYSBwaG9uZSkuIERvbmUgd2l0aCBwYXR0ZXJucyByYXRoZXIKICAvLyB0aGFuIHRoZSBET006IHBhcnNpbmcgSFRNTCBpbnRvIGEgZG9jdW1lbnQgaXMgYSBUcnVzdGVkIFR5cGVzIHNpbmsgb24KICAvLyBHbWFpbCdzIHBhZ2UsIGFuZCBvbmx5IHRoZSB3b3JkcyBhcmUgd2FudGVkIGFueXdheS4KICBmdW5jdGlvbiBodG1sVG9UZXh0KGh0bWwpIHsKICAgIGNvbnN0IHRleHQgPSBTdHJpbmcoaHRtbCB8fCAnJykKICAgICAgLnJlcGxhY2UoLzwoc2NyaXB0fHN0eWxlfGhlYWR8dGl0bGUpXGJbXj5dKj5bXHNcU10qPzxcL1wxXHMqPi9naSwgJycpCiAgICAgIC5yZXBsYWNlKC88YnJccypcLz8-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPGxpXGJbXj5dKj4vZ2ksICdcbuKAoiAnKQogICAgICAucmVwbGFjZSgvPFwvKHB8ZGl2fHVsfG9sfHRyfGhbMS02XXxibG9ja3F1b3RlfHByZXx0YWJsZSlccyo-L2dpLCAnXG4nKQogICAgICAucmVwbGFjZSgvPFtePl0rPi9nLCAnJyk7CiAgICByZXR1cm4gdXRpbC5kZWNvZGVFbnRpdGllcyh0ZXh0KQogICAgICAucmVwbGFjZSgvXHUwMGEwL2csICcgJykKICAgICAgLnJlcGxhY2UoL1sgXHRdK1xuL2csICdcbicpCiAgICAgIC5yZXBsYWNlKC9cbnszLH0vZywgJ1xuXG4nKQogICAgICAudHJpbSgpOwogIH0KCiAgZnVuY3",
"Rpb24gdGV4dFBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHBsYWluID0gW107CiAgICBjb25zdCBodG1sID0gW107CiAgICAoZnVuY3Rpb24gd2FsayhwKSB7CiAgICAgIGlmICghcCkgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gU3RyaW5nKHAubWltZVR5cGUgfHwgJycpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmICh0eXBlID09PSAndGV4dC9wbGFpbicpIHBsYWluLnB1c2gocCk7CiAgICAgIGVsc2UgaWYgKHR5cGUgPT09ICd0ZXh0L2h0bWwnKSBodG1sLnB1c2gocCk7CiAgICAgIChwLnBhcnRzIHx8IFtdKS5mb3JFYWNoKHdhbGspOwogICAgfSkocGF5bG9hZCk7CiAgICByZXR1cm4geyBwbGFpbiwgaHRtbCB9OwogIH0KCiAgLy8gUHJlZmVycyBhIHRleHQvcGxhaW4gcGFydCBhbnl3aGVyZSBpbiB0aGUgdHJlZSwgdGhlbiBIVE1MLgogIGZ1bmN0aW9uIGV4dHJhY3RUZXh0KHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIGlmIChwbGFpbi5sZW5ndGgpIHJldHVybiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKTsKICAgIGlmIChodG1sLmxlbmd0aCkgcmV0dXJuIGh0bWxUb1RleHQoaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykpOwogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gQm90aCByZW5kZXJpbmdzLCBkZWNvZGVkLCBmb3IgdGhlIGZvcm1hdHRlZC",
"ByZWFkZXI6IHRoZSBIVE1MIGlzIHRoZQogIC8vIHJlY29yZCwgdGhlIHBsYWluIHRleHQgdGhlIGZhbGxiYWNrIGZvciBtYWlsIHRoYXQgaGFzIG5vIEhUTUwuCiAgZnVuY3Rpb24gbWVzc2FnZVBhcnRzKHBheWxvYWQpIHsKICAgIGNvbnN0IHsgcGxhaW4sIGh0bWwgfSA9IHRleHRQYXJ0cyhwYXlsb2FkKTsKICAgIHJldHVybiB7CiAgICAgIHBsYWluOiBwbGFpbi5tYXAocGFydFRleHQpLmpvaW4oJ1xuJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXG4rJC8sICcnKSwKICAgICAgaHRtbDogaHRtbC5tYXAocGFydFRleHQpLmpvaW4oJ1xuJyksCiAgICB9OwogIH0KCiAgLy8gT25lIG5vdGUgZnJvbSBhIG1lc3NhZ2VzLmdldC4gV2l0aCBmb3JtYXQ9bWV0YWRhdGEgdGhlcmUgaXMgbm8gYm9keQogIC8vIChib2R5IHN0YXlzIG51bGwpOyB3aXRoIGZvcm1hdD1mdWxsIHRoZXJlIGlzLgogIGZ1bmN0aW9uIG5vdGVGcm9tTWVzc2FnZShtc2cpIHsKICAgIGNvbnN0IG5vdGVJZCA9IGhlYWRlck9mKG1zZywgTk9URV9IRUFERVIpLnRyaW0oKTsKICAgIGNvbnN0IG93biA9IElEX1JFLnRlc3Qobm90ZUlkKTsKICAgIGNvbnN0IGZ1bGwgPSAhIShtc2cucGF5bG9hZCAmJiAobXNnLnBheWxvYWQuYm9keSB8fCBtc2cucGF5bG9hZC5wYXJ0cykpOwogICAgcmV0dXJuIHsKICAgICAgbWVzc2FnZUlkOiBtc2cuaWQsCiAgICAgIHRocmVhZElkOiBtc2cudGhyZWFkSWQgfHwgJycsCiAgICAgIG5vdGVJZDogb3duID",
"8gbm90ZUlkIDogJycsCiAgICAgIG93biwKICAgICAga2V5OiBvd24gPyBgbjoke25vdGVJZH1gIDogYG06JHttc2cuaWR9YCwKICAgICAgdGl0bGU6IG9uZUxpbmUoaGVhZGVyT2YobXNnLCAnU3ViamVjdCcpKSB8fCAnVW50aXRsZWQgbm90ZScsCiAgICAgIHVwZGF0ZWQ6IE51bWJlcihtc2cuaW50ZXJuYWxEYXRlKSB8fCBEYXRlLnBhcnNlKGhlYWRlck9mKG1zZywgJ0RhdGUnKSkgfHwgMCwKICAgICAgc25pcHBldDogdXRpbC5kZWNvZGVFbnRpdGllcyhtc2cuc25pcHBldCB8fCAnJyksCiAgICAgIGJvZHk6IGZ1bGwgPyBleHRyYWN0VGV4dChtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBwYXJ0czogZnVsbCA_IG1lc3NhZ2VQYXJ0cyhtc2cucGF5bG9hZCkgOiBudWxsLAogICAgICBsYWJlbElkczogbXNnLmxhYmVsSWRzIHx8IFtdLAogICAgfTsKICB9CgogIC8vIFR3byBsaXZlIHZlcnNpb25zIG9mIG9uZSBub3RlIG1lYW4gYSBzYXZlIGluc2VydGVkIHRoZSBuZXcgb25lIGJ1dAogIC8vIGNvdWxkIG5vdCB0cmFzaCB0aGUgb2xkIChvZmZsaW5lLCBjbG9zZWQgdGFiKSwgb3IgdHdvIGNvbXB1dGVycyBzYXZlZAogIC8vIGF0IG9uY2UuIFRoZSBuZXdlc3Qgd2luczsgdGhlIHJlc3QgYXJlIHJlcG9ydGVkIHNvIHRoZXkgY2FuIGJlCiAgLy8gdGlkaWVkIGludG8gVHJhc2gsIHdoZXJlIHRoZXkgc3RheSByZWNvdmVyYWJsZSBmb3IgdGhpcnR5IGRheXMuCiAgZnVuY3Rpb24gZGVkdXBlTm90ZXMobm90ZXMpIHsKIC",
"AgIGNvbnN0IGxpdmUgPSBbXTsKICAgIGNvbnN0IHN0YWxlID0gW107CiAgICBjb25zdCBiZXN0ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSB7CiAgICAgIGNvbnN0IGN1ciA9IGJlc3QuZ2V0KG4ua2V5KTsKICAgICAgaWYgKCFjdXIpIHsgYmVzdC5zZXQobi5rZXksIG4pOyBjb250aW51ZTsgfQogICAgICBpZiAobi51cGRhdGVkID4gY3VyLnVwZGF0ZWQpIHsgc3RhbGUucHVzaChjdXIpOyBiZXN0LnNldChuLmtleSwgbik7IH0KICAgICAgZWxzZSBzdGFsZS5wdXNoKG4pOwogICAgfQogICAgZm9yIChjb25zdCBuIG9mIG5vdGVzKSBpZiAoYmVzdC5nZXQobi5rZXkpID09PSBuKSBsaXZlLnB1c2gobik7CiAgICBsaXZlLnNvcnQoKGEsIGIpID0-IGIudXBkYXRlZCAtIGEudXBkYXRlZCk7CiAgICByZXR1cm4geyBsaXZlLCBzdGFsZSB9OwogIH0KCiAgLy8g4pSA4pSAIEZvbGRlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGZvbGRlciBpcyBhIEdtYWlsIGxhYmVsIHVuZGVyIHRoZSBub3RlcyBsYWJlbDogIl9Ob3Rlcy9Xb3JrIiwKICAvLyAiX05vdGVzL1dvcmsvQ2xpZW50cyIuIEV2ZXJ5IG5vdGUgY2",
"FycmllcyB0aGUgbm90ZXMgbGFiZWwgaXRzZWxmLCBwbHVzCiAgLy8gdGhlIGxhYmVsIG9mIGF0IG1vc3Qgb25lIGZvbGRlciAtIHNvICJBbGwgbm90ZXMiIGlzIG9uZSBsYWJlbCwgYW5kIHRoZQogIC8vIGZvbGRlcnMgc2hvdyB1cCBuZXN0ZWQgdW5kZXIgX05vdGVzIGluIEdtYWlsJ3Mgb3duIGxhYmVsIGxpc3QuCgogIGNvbnN0IEZPTERFUl9OQU1FX01BWCA9IDYwOwoKICAvLyBUaGUgZm9sZGVycyB1bmRlciBgcm9vdGAsIGluIHRyZWUgb3JkZXI6IGVhY2ggcGFyZW50IGZvbGxvd2VkIGJ5IGl0cwogIC8vIGNoaWxkcmVuLCBhbHBoYWJldGljYWxseSwgd2l0aCBpdHMgZGVwdGguIEEgbGFiZWwgd2hvc2UgcGFyZW50IGxhYmVsCiAgLy8gaXMgbWlzc2luZyAobWFkZSBieSBoYW5kIGluIEdtYWlsKSBzdGlsbCBhcHBlYXJzLCBhdCBpdHMgb3duIGRlcHRoLgogIGZ1bmN0aW9uIGZvbGRlclRyZWUobGFiZWxzLCByb290KSB7CiAgICBjb25zdCBwcmVmaXggPSBgJHtyb290fS9gOwogICAgY29uc3QgbGlzdCA9IChsYWJlbHMgfHwgW10pCiAgICAgIC5maWx0ZXIobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKHByZWZpeCkgJiYgbC5uYW1lLmxlbmd0aCA-IHByZWZpeC5sZW5ndGgpCiAgICAgIC5tYXAobCA9PiB7CiAgICAgICAgY29uc3QgcGF0aCA9IGwubmFtZS5zbGljZShwcmVmaXgubGVuZ3RoKTsKICAgICAgICBjb25zdCBwYXJ0cyA9IHBhdGguc3BsaXQoJy",
"8nKTsKICAgICAgICByZXR1cm4geyBpZDogbC5pZCwgbmFtZTogbC5uYW1lLCBwYXRoLCB0aXRsZTogcGFydHNbcGFydHMubGVuZ3RoIC0gMV0sIGRlcHRoOiBwYXJ0cy5sZW5ndGggLSAxLCBwYXJlbnRQYXRoOiBwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpIH07CiAgICAgIH0pOwogICAgLy8gU29ydGluZyBieSBwYXRoIHNlZ21lbnQgYnkgc2VnbWVudCBrZWVwcyBldmVyeSBjaGlsZCB1bmRlciBpdHMgcGFyZW50LgogICAgY29uc3Qga2V5ID0gZiA9PiBmLnBhdGguc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRvTG93ZXJDYXNlKCkpOwogICAgbGlzdC5zb3J0KChhLCBiKSA9PiB7CiAgICAgIGNvbnN0IHggPSBrZXkoYSk7CiAgICAgIGNvbnN0IHkgPSBrZXkoYik7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5taW4oeC5sZW5ndGgsIHkubGVuZ3RoKTsgaSsrKSB7CiAgICAgICAgaWYgKHhbaV0gIT09IHlbaV0pIHJldHVybiB4W2ldIDwgeVtpXSA_IC0xIDogMTsKICAgICAgfQogICAgICByZXR1cm4geC5sZW5ndGggLSB5Lmxlbmd0aDsKICAgIH0pOwogICAgcmV0dXJuIGxpc3Q7CiAgfQoKICAvLyBUaGUgZm9sZGVyIGEgbm90ZSBpcyBpbiwgZnJvbSBpdHMgbGFiZWxzOyAnJyBmb3Igbm9uZS4gVHdvIGZvbGRlcgogIC8vIGxhYmVscyAoYXBwbGllZCBieSBoYW5kKSByZXNvbHZlIHRvIHRoZSBmaXJzdCBpbiB0cmVlIG9yZGVyLgogIGZ1bmN0aW9uIGZvbGRlck9mKGxhYmVsSWRzLCBmb2xkZXJzKSB7Ci",
"AgICBjb25zdCBoYXZlID0gbmV3IFNldChsYWJlbElkcyB8fCBbXSk7CiAgICBjb25zdCBmID0gKGZvbGRlcnMgfHwgW10pLmZpbmQoeCA9PiBoYXZlLmhhcyh4LmlkKSk7CiAgICByZXR1cm4gZiA_IGYuaWQgOiAnJzsKICB9CgogIC8vIE1vdmluZyBhIG5vdGU6IGtlZXAgKG9yIHJlc3RvcmUpIHRoZSBub3RlcyBsYWJlbCwgYWRkIHRoZSB0YXJnZXQncywKICAvLyBkcm9wIGV2ZXJ5IG90aGVyIGZvbGRlcidzLgogIGZ1bmN0aW9uIG1vdmVGb2xkZXJEaWZmKHJvb3RJZCwgZm9sZGVycywgdGFyZ2V0SWQpIHsKICAgIGNvbnN0IGFkZCA9IFtyb290SWRdOwogICAgaWYgKHRhcmdldElkKSBhZGQucHVzaCh0YXJnZXRJZCk7CiAgICBjb25zdCByZW1vdmUgPSAoZm9sZGVycyB8fCBbXSkubWFwKGYgPT4gZi5pZCkuZmlsdGVyKGlkID0-IGlkICE9PSB0YXJnZXRJZCk7CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogYWRkLCByZW1vdmVMYWJlbElkczogcmVtb3ZlIH07CiAgfQoKICBmdW5jdGlvbiB2YWxpZGF0ZUZvbGRlclRpdGxlKHRpdGxlLCBzaWJsaW5ncyA9IFtdKSB7CiAgICBjb25zdCB0ID0gU3RyaW5nKHRpdGxlIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXQpIHJldHVybiAnR2l2ZSB0aGUgZm9sZGVyIGEgbmFtZS4nOwogICAgaWYgKHQuaW5jbHVkZXMoJy8nKSkgcmV0dXJuICdBIGZvbGRlciBuYW1lIGNhbm5vdCBjb250YWluIOKAnC_igJ0uIE1ha2UgYSBzdWJmb2xkZXIgaW5zdGVhZC4nOwogICAgaWYgKHQubG",
"VuZ3RoID4gRk9MREVSX05BTUVfTUFYKSByZXR1cm4gYEtlZXAgZm9sZGVyIG5hbWVzIHVuZGVyICR7Rk9MREVSX05BTUVfTUFYfSBjaGFyYWN0ZXJzLmA7CiAgICBpZiAoc2libGluZ3Muc29tZShzID0-IHMudG9Mb3dlckNhc2UoKSA9PT0gdC50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuIGBUaGVyZSBpcyBhbHJlYWR5IGEgZm9sZGVyIGNhbGxlZCDigJwke3R94oCdIGhlcmUuYDsKICAgIHJldHVybiAnJzsKICB9CgogIC8vIFJlbmFtaW5nIGEgZm9sZGVyIHJlbmFtZXMgaXRzIGxhYmVsIGFuZCBldmVyeSBsYWJlbCBiZWxvdyBpdCwgc2luY2UKICAvLyBHbWFpbCdzIEFQSSByZW5hbWVzIG9ubHkgdGhlIG9uZSBsYWJlbCBpdCBpcyBnaXZlbi4KICBmdW5jdGlvbiByZW5hbWVQbGFuKGZvbGRlciwgbmV3VGl0bGUsIGZvbGRlcnMpIHsKICAgIGNvbnN0IHBhcmVudCA9IGZvbGRlci5uYW1lLnNsaWNlKDAsIGZvbGRlci5uYW1lLmxlbmd0aCAtIGZvbGRlci50aXRsZS5sZW5ndGgpOwogICAgY29uc3QgbmV3TmFtZSA9IGAke3BhcmVudH0ke1N0cmluZyhuZXdUaXRsZSkudHJpbSgpfWA7CiAgICByZXR1cm4gKGZvbGRlcnMgfHwgW10pCiAgICAgIC5maWx0ZXIoZiA9PiBmLm5hbWUgPT09IGZvbGRlci5uYW1lIHx8IGYubmFtZS5zdGFydHNXaXRoKGAke2ZvbGRlci5uYW1lfS9gKSkKICAgICAgLm1hcChmID0-ICh7IGlkOiBmLmlkLCBuYW1lOiBuZXdOYW1lICsgZi5uYW1lLnNsaWNlKGZvbGRlci5uYW1lLmxlbmd0aCkgfSkpOw",
"ogIH0KCiAgLy8gV2hldGhlciB0aGUgd29ya2VyIG1heSBkZWxldGUgYSBsYWJlbDogYSBmb2xkZXIgdW5kZXIgdGhlIG5vdGVzIGxhYmVsCiAgLy8gd2l0aCBubyBub3RlcyBpbiBpdCBhbmQgbm8gZm9sZGVycyB1bmRlciBpdC4gYGxpdmVNZXNzYWdlc2AgaXMgd2hhdCBhCiAgLy8gbWVzc2FnZXMubGlzdCBvbiB0aGUgbGFiZWwgZm91bmQgLSBub3QgdGhlIGxhYmVsJ3Mgb3duIGNvdW50LCB3aGljaAogIC8vIGFsc28gY291bnRzIG9sZCB2ZXJzaW9ucyB3YWl0aW5nIGluIFRyYXNoIGFuZCB3b3VsZCBrZWVwIGFuIGVtcHRpZWQKICAvLyBmb2xkZXIgdW5kZWxldGFibGUgZm9yIGEgbW9udGguCiAgZnVuY3Rpb24gaXNEZWxldGFibGVGb2xkZXIobGFiZWwsIHJvb3QsIGFsbExhYmVscywgbGl2ZU1lc3NhZ2VzKSB7CiAgICBpZiAoIWxhYmVsIHx8IHR5cGVvZiBsYWJlbC5uYW1lICE9PSAnc3RyaW5nJyB8fCAhcm9vdCkgcmV0dXJuIGZhbHNlOwogICAgaWYgKCFsYWJlbC5uYW1lLnN0YXJ0c1dpdGgoYCR7cm9vdH0vYCkgfHwgbGFiZWwubmFtZS5sZW5ndGggPD0gcm9vdC5sZW5ndGggKyAxKSByZXR1cm4gZmFsc2U7CiAgICBpZiAobGl2ZU1lc3NhZ2VzICE9PSAwKSByZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gIShhbGxMYWJlbHMgfHwgW10pLnNvbWUobCA9PiBsICYmIHR5cGVvZiBsLm5hbWUgPT09ICdzdHJpbmcnICYmIGwubmFtZS5zdGFydHNXaXRoKGAke2xhYmVsLm5hbWV9L2ApKTsKICB9CgogIGNvbnN0IGFwaS",
"A9IHsKICAgIE5PVEVfSEVBREVSLCBOT1RFX1NFTkRFUiwgREVGQVVMVF9MQUJFTCwgTUFYX0JPRFksIE1BWF9USVRMRSwgRk9SQklEREVOX0lOU0VSVF9MQUJFTFMsIEZPTERFUl9OQU1FX01BWCwKICAgIGZvbGRlclRyZWUsIGZvbGRlck9mLCBtb3ZlRm9sZGVyRGlmZiwgdmFsaWRhdGVGb2xkZXJUaXRsZSwgcmVuYW1lUGxhbiwgaXNEZWxldGFibGVGb2xkZXIsCiAgICBTQ1JBVENIUEFEX0lELCBTQ1JBVENIUEFEX1RJVExFLCBuZXdOb3RlSWQsIG5vdGVJZEZvciwgZW5jb2RlSGVhZGVyVGV4dCwgZGVjb2RlSGVhZGVyVGV4dCwgYmFzZTY0VXJsRW5jb2RlLCBiYXNlNjRVcmxEZWNvZGUsCiAgICB0aXRsZUZvciwgYnVpbGROb3RlUmF3LCBub3RlSWRPZlJhdywgaXNOb3RlSW5zZXJ0LAogICAgaHRtbFRvVGV4dCwgZXh0cmFjdFRleHQsIG1lc3NhZ2VQYXJ0cywgbm90ZUZyb21NZXNzYWdlLCBkZWR1cGVOb3RlcywKICB9OwoKICBucy5ub3Rlc0xvZ2ljID0gYXBpOwogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgbW9kdWxlLmV4cG9ydHMgPSBhcGk7Cn0pKCk7Cg\"],[\"src/lib/note-format.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIE5vdGUgZm9ybWF0dGluZyAocHVyZSkKLy8KLy8gQSBmb3JtYXR0ZWQgbm90ZSBpcyBhIGxpc3Qgb2YgYmxvY2tzIC0gcGFyYWdyYXBocywgdGhyZWUgaGVhZGluZwovLyBzaXplcywgYnVsbGV0ZWQsIG51bWJlcmVkIGFuZCBjaGVjayBsaXN0cyBuZXN0ZWQgdXAgdG8gdGhyZWUgZGVlcCwgYW5kCi8vIHRhYmxlcyAtIGVhY2ggaG9sZGluZyBydW5zIG9mIHRleHQgdGhhdCBtYXkgYmUgYm9sZCwgaXRhbGljLCBzdHJ1Y2sKLy8gdGhyb3VnaCBvciBhIGxpbmsgKGEgdGFibGUsIHJvd3Mgb2YgY2VsbHMgb2YgdGhlbSkuIFRoYXQgaXMgdGhlIHdob2xlCi8vIG1vZGVsOyBub3RoaW5nIG91dHNpZGUgaXQgc3Vydml2ZXMgYSBzYXZlLgovLwovLyBJdCBpcyBzdG9yZWQgaW4gdGhlIG5vdGUncyBtZXNzYWdlIHR3aWNlLiBUaGUgSFRNTCBwYXJ0IGlzIHRoZSByZWFsCi8vIHJlY29yZDogR21haWwgc2hvd3MgaXQgKG9uIHRoZSBwaG9uZSB0b28pLCBhbmQgdGhpcyBmaWxlIHJlYWRzIGl0IGJhY2sKLy8gd2l0aCBhIHNtYWxsIHRva2VuaXplciBvZiBpdHMgb3duIHJhdGhlciB0aGFuIHRoZSBicm93c2VyJ3MgSFRNTAovLyBwYXJzZXIsIHdoaWNoIGlzIGEgVHJ1c3RlZCBUeXBlcyBzaW5rIG9uIEdtYWlsJ3MgcGFnZSBhbmQgd291bGQgYWNjZXB0Ci8vIGZhciBtb3JlIHRoYW4gdGhlIG1vZGVsIGNhbiBob2xkLiBUaGUgcG",
"xhaW4tdGV4dCBwYXJ0IGlzIGEgcmVhZGFibGUKLy8gcmVuZGVyaW5nIC0gYnVsbGV0cywg4piQIGFuZCDimJEgLSBmb3IgR21haWwncyBwcmV2aWV3cyBhbmQgZm9yIGFueSBtYWlsCi8vIGNsaWVudCB0aGF0IHNob3dzIHRleHQuCi8vCi8vIE1haWwgdGhhdCBhcnJpdmVkIGFzIGEgbm90ZSAod3JpdHRlbiBpbiBHbWFpbCwgc2F5KSBnb2VzIHRocm91Z2ggdGhlCi8vIHNhbWUgcmVhZGVyLCBzbyBpdHMgYm9sZCwgbGlzdHMgYW5kIGxpbmtzIGNvbWUgYWNyb3NzIHdoZXJlIHRoZXkgZml0Ci8vIHRoZSBtb2RlbCBhbmQgZXZlcnl0aGluZyBlbHNlIGlzIHJlZHVjZWQgdG8gdGV4dC4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgdXRpbCA9ICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgPyByZXF1aXJlKCcuL3V0aWwuanMnKSA6IG5zLnV0aWw7CgogIGNvbnN0IFRZUEVTID0gbmV3IFNldC",
"hbJ3AnLCAnaDEnLCAnaDInLCAnaDMnLCAndWwnLCAnb2wnLCAnY2hlY2snLCAndGFibGUnXSk7CiAgY29uc3QgTElTVFMgPSBuZXcgU2V0KFsndWwnLCAnb2wnLCAnY2hlY2snXSk7CiAgY29uc3QgTUFYX0xFVkVMID0gMzsKICAvLyBBIHRhYmxlOiBhdCBtb3N0IHRoaXMgbWFueSBjb2x1bW5zIGFuZCByb3dzOyBhIGNvbHVtbiBpcyBhbGlnbmVkCiAgLy8gbGVmdCAoJycpLCBpbiB0aGUgY2VudHJlIG9yIHRvIHRoZSByaWdodC4KICBjb25zdCBNQVhfQ09MUyA9IDI2OwogIGNvbnN0IE1BWF9ST1dTID0gMTAwMDsKICBjb25zdCBBTElHTlMgPSBuZXcgU2V0KFsnJywgJ2NlbnRlcicsICdyaWdodCddKTsKICBjb25zdCBCT1ggPSAn4piQJzsgICAgIC8vIOKYkAogIGNvbnN0IFRJQ0tFRCA9ICfimJEnOyAgLy8g4piRCiAgY29uc3QgQlVMTEVUID0gJ-KAoic7ICAvLyDigKIKCiAgLy8g4pSA4pSAIFRoZSBtb2RlbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYmxvY2sodHlwZSA9ICdwJywgcnVucyA9IFtdLCB7IGxldmVsID0gMCwgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgcmV0dXJuIHsgdHlwZSwgbGV2ZWw6IExJU1RTLmhhcyh0eX",
"BlKSA_IGxldmVsIDogMCwgY2hlY2tlZDogdHlwZSA9PT0gJ2NoZWNrJyA_ICEhY2hlY2tlZCA6IGZhbHNlLCBydW5zIH07CiAgfQoKICAvLyBBIHRhYmxlIGJsb2NrOiBgcm93c2Agb2YgY2VsbHMsIGVhY2ggY2VsbCB7IHJ1bnMgfSAtIGEgbGluZSBicmVhawogIC8vIGluc2lkZSBhIGNlbGwgaXMgYSAiXG4iIGluIGl0cyB0ZXh0OyBgaGVhZGAsIHdoZXRoZXIgdGhlIGZpcnN0IHJvdyBpcwogIC8vIGEgaGVhZGluZyByb3c7IGBhbGlnbmAsIGVhY2ggY29sdW1uJ3MgYWxpZ25tZW50LgogIGZ1bmN0aW9uIHRhYmxlKHJvd3MgPSBbW3sgcnVuczogW10gfV1dLCB7IGhlYWQgPSBmYWxzZSwgYWxpZ24gPSBbXSB9ID0ge30pIHsKICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJsb2NrKCd0YWJsZScpLCB7IHJvd3MsIGhlYWQ6ICEhaGVhZCwgYWxpZ24gfSk7CiAgfQoKICBjb25zdCBlbXB0eUNlbGwgPSAoKSA9PiAoeyBydW5zOiBbXSB9KTsKCiAgZnVuY3Rpb24gZW1wdHlEb2MoKSB7CiAgICByZXR1cm4gW2Jsb2NrKCdwJyldOwogIH0KCiAgY29uc3Qgc2FtZU1hcmtzID0gKGEsIGIpID0-ICEhYS5iID09PSAhIWIuYiAmJiAhIWEuaSA9PT0gISFiLmkgJiYgISFhLnMgPT09ICEhYi5zICYmIChhLmhyZWYgfHwgJycpID09PSAoYi5ocmVmIHx8ICcnKTsKCiAgZnVuY3Rpb24gY2xlYW5SdW4ocikgewogICAgY29uc3Qgb3V0ID0geyB0ZXh0OiBTdHJpbmcoci50ZXh0IHx8ICcnKSB9OwogICAgaWYgKHIuYikgb3V0LmIgPSB0cn",
"VlOwogICAgaWYgKHIuaSkgb3V0LmkgPSB0cnVlOwogICAgaWYgKHIucykgb3V0LnMgPSB0cnVlOwogICAgY29uc3QgaHJlZiA9IHIuaHJlZiA_IHNhZmVIcmVmKHIuaHJlZikgOiAnJzsKICAgIGlmIChocmVmKSBvdXQuaHJlZiA9IGhyZWY7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gRHJvcHMgZW1wdHkgcnVucyBhbmQgam9pbnMgbmVpZ2hib3VycyB0aGF0IGxvb2sgdGhlIHNhbWUsIHNvIHR3bwogIC8vIGRvY3VtZW50cyB0aGF0IHJlYWQgYWxpa2UgY29tcGFyZSBhbGlrZS4KICBmdW5jdGlvbiBub3JtYWxpc2VSdW5zKHJ1bnMpIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgZm9yIChjb25zdCByIG9mIHJ1bnMgfHwgW10pIHsKICAgICAgaWYgKCFyIHx8ICFyLnRleHQpIGNvbnRpbnVlOwogICAgICBjb25zdCBsYXN0ID0gb3V0W291dC5sZW5ndGggLSAxXTsKICAgICAgaWYgKGxhc3QgJiYgc2FtZU1hcmtzKGxhc3QsIHIpKSBsYXN0LnRleHQgKz0gci50ZXh0OwogICAgICBlbHNlIG91dC5wdXNoKGNsZWFuUnVuKHIpKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBFdmVyeSByb3cgYXMgd2lkZSBhcyB0aGUgd2lkZXN0IChhbmQgd2l0aGluIHRoZSBsaW1pdHMpLCBldmVyeSBjZWxsCiAgLy8gdGlkeSwgYXQgbGVhc3Qgb25lIGNlbGwuCiAgZnVuY3Rpb24gbm9ybWFsaXNlVGFibGUoYikgewogICAgY29uc3Qgc3JjID0gKEFycmF5LmlzQXJyYXkoYi5yb3dzKSA_IGIucm93cyA6IFtdKS5maWx0ZX",
"IoQXJyYXkuaXNBcnJheSkuc2xpY2UoMCwgTUFYX1JPV1MpOwogICAgY29uc3Qgd2lkZXN0ID0gc3JjLnJlZHVjZSgobiwgcikgPT4gTWF0aC5tYXgobiwgci5sZW5ndGgpLCAwKTsKICAgIGNvbnN0IGNvbHMgPSBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfQ09MUywgd2lkZXN0KSk7CiAgICBjb25zdCByb3dzID0gc3JjLm1hcChyID0-IEFycmF5LmZyb20oeyBsZW5ndGg6IGNvbHMgfSwgKF8sIGspID0-ICh7IHJ1bnM6IG5vcm1hbGlzZVJ1bnMocltrXSAmJiByW2tdLnJ1bnMpIH0pKSk7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSByb3dzLnB1c2goQXJyYXkuZnJvbSh7IGxlbmd0aDogY29scyB9LCBlbXB0eUNlbGwpKTsKICAgIGNvbnN0IGFsaWduID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogY29scyB9LCAoXywgaykgPT4gKGIuYWxpZ24gJiYgQUxJR05TLmhhcyhiLmFsaWduW2tdKSA_IGIuYWxpZ25ba10gOiAnJykpOwogICAgcmV0dXJuIHRhYmxlKHJvd3MsIHsgaGVhZDogYi5oZWFkLCBhbGlnbiB9KTsKICB9CgogIC8vIFVua25vd24gdHlwZXMgYmVjb21lIHBhcmFncmFwaHM7IGEgbGlzdCBpdGVtIG1heSBzaXQgYXQgbW9zdCBvbmUgbGV2ZWwKICAvLyBkZWVwZXIgdGhhbiB0aGUgbGlzdCBpdGVtIGJlZm9yZSBpdCwgd2hpY2ggaXMgd2hhdCBrZWVwcyB0aGUgSFRNTCBhCiAgLy8gcHJvcGVybHkgbmVzdGVkIGxpc3QgYW5kIHRoZSBlZGl0b3IncyBpbmRlbnRzIG1lYW5pbmdmdWwuIEEgdGFibGUgaXMKICAvLyBuZX",
"ZlciBsYXN0OiBhIGxpbmUgZm9sbG93cyBpdCwgc29tZXdoZXJlIHRvIHR5cGUgYWZ0ZXIgaXQuCiAgZnVuY3Rpb24gbm9ybWFsaXNlRG9jKGRvYykgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBsZXQgcHJldkxldmVsID0gLTE7CiAgICBmb3IgKGNvbnN0IGIgb2YgQXJyYXkuaXNBcnJheShkb2MpID8gZG9jIDogW10pIHsKICAgICAgaWYgKCFiIHx8IHR5cGVvZiBiICE9PSAnb2JqZWN0JykgY29udGludWU7CiAgICAgIGlmIChiLnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICBvdXQucHVzaChub3JtYWxpc2VUYWJsZShiKSk7CiAgICAgICAgcHJldkxldmVsID0gLTE7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgY29uc3QgdHlwZSA9IFRZUEVTLmhhcyhiLnR5cGUpID8gYi50eXBlIDogJ3AnOwogICAgICBsZXQgbGV2ZWwgPSAwOwogICAgICBpZiAoTElTVFMuaGFzKHR5cGUpKSB7CiAgICAgICAgbGV2ZWwgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihNQVhfTEVWRUwsIE51bWJlcihiLmxldmVsKSB8fCAwLCBwcmV2TGV2ZWwgKyAxKSk7CiAgICAgICAgcHJldkxldmVsID0gbGV2ZWw7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgcHJldkxldmVsID0gLTE7CiAgICAgIH0KICAgICAgb3V0LnB1c2goYmxvY2sodHlwZSwgbm9ybWFsaXNlUnVucyhiLnJ1bnMpLCB7IGxldmVsLCBjaGVja2VkOiBiLmNoZWNrZWQgfSkpOwogICAgfQogICAgaWYgKG91dC5sZW5ndGggJiYgb3V0W291dC5sZW5ndGggLSAxXS50eX",
"BlID09PSAndGFibGUnKSBvdXQucHVzaChibG9jaygncCcpKTsKICAgIHJldHVybiBvdXQubGVuZ3RoID8gb3V0IDogZW1wdHlEb2MoKTsKICB9CgogIGNvbnN0IHJ1bnNUZXh0ID0gcnVucyA9PiBydW5zLm1hcChyID0-IHIudGV4dCkuam9pbignJyk7CiAgLy8gQSB0YWJsZSdzIHRleHQ6IGEgcm93IGEgbGluZSwgaXRzIGNlbGxzIGJldHdlZW4gIiB8ICIuCiAgY29uc3QgdGFibGVUZXh0ID0gYiA9PiBiLnJvd3MubWFwKHIgPT4gci5tYXAoYyA9PiBydW5zVGV4dChjLnJ1bnMpLnJlcGxhY2UoL1xuL2csICcgJykpLmpvaW4oJyB8ICcpKS5qb2luKCdcbicpOwogIGNvbnN0IGJsb2NrVGV4dCA9IGIgPT4gKGIudHlwZSA9PT0gJ3RhYmxlJyA_IHRhYmxlVGV4dChiKSA6IHJ1bnNUZXh0KGIucnVucykpOwoKICBmdW5jdGlvbiBkb2NUZXh0KGRvYykgewogICAgcmV0dXJuIGRvYy5tYXAoYmxvY2tUZXh0KS5qb2luKCdcbicpOwogIH0KCiAgLy8gQSB0YWJsZSBjb3VudHMgYXMgc29tZXRoaW5nIHdyaXR0ZW4sIGV2ZW4gd2l0aCBub3RoaW5nIGluIGl0IHlldC4KICBmdW5jdGlvbiBpc0VtcHR5KGRvYykgewogICAgcmV0dXJuIGRvYy5ldmVyeShiID0-IGIudHlwZSAhPT0gJ3RhYmxlJyAmJiAhYmxvY2tUZXh0KGIpLnRyaW0oKSk7CiAgfQoKICAvLyDilIDilIAgTGlua3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFdlYiBhbmQgbWFpbCBsaW5rcyBvbmx5LiAiZXhhbXBsZS5jb20veCIgZ2V0cyBodHRwczovLyBpbiBmcm9udCwgYQogIC8vIGJhcmUgYWRkcmVzcyBnZXRzIG1haWx0bzosIGFuZCBhbnl0aGluZyBlbHNlIC0gamF2YXNjcmlwdDosIGRhdGE6LAogIC8vIGZpbGU6IC0gaXMgbm90IGEgbGluayBhdCBhbGwuCiAgZnVuY3Rpb24gc2FmZUhyZWYodXJsKSB7CiAgICBjb25zdCBzID0gU3RyaW5nKHVybCB8fCAnJykudHJpbSgpOwogICAgaWYgKCFzIHx8IC9bXHM8PiJdLy50ZXN0KHMpKSByZXR1cm4gJyc7CiAgICBpZiAoL15tYWlsdG86L2kudGVzdChzKSkgcmV0dXJuIC9ebWFpbHRvOlteQFxzXStAW15AXHNdKyQvaS50ZXN0KHMpID8gcyA6ICcnOwogICAgaWYgKC9eW15cc0AvOl0rQFteXHNALzpdK1wuW15cc0AvOl0rJC8udGVzdChzKSkgcmV0dXJuIGBtYWlsdG86JHtzfWA7CiAgICBsZXQgY2FuZGlkYXRlID0gczsKICAgIGlmICghL15bYS16XVthLXowLTkrLi1dKjovaS50ZXN0KHMpKSB7CiAgICAgIGlmICghL15bXHctXSsoXC5bXHctXSspKyg6XGQrKT8oWy8_I118JCkvLnRlc3QocykpIHJldHVybiAnJzsKICAgICAgY2FuZGlkYXRlID0gYGh0dHBzOi8vJHtzfWA7CiAgICB9CiAgICB0cnkgewogICAgICBjb25zdCB1ID0gbmV3IFVSTC",
"hjYW5kaWRhdGUpOwogICAgICByZXR1cm4gdS5wcm90b2NvbCA9PT0gJ2h0dHA6JyB8fCB1LnByb3RvY29sID09PSAnaHR0cHM6JyA_IHUuaHJlZiA6ICcnOwogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiAnJzsKICAgIH0KICB9CgogIC8vIOKUgOKUgCBIVE1MIG91dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgZXNjSHRtbCA9IHMgPT4gU3RyaW5nKHMpLnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9nLCAnJmx0OycpLnJlcGxhY2UoLz4vZywgJyZndDsnKS5yZXBsYWNlKC8iL2csICcmcXVvdDsnKTsKCiAgLy8gU3BhY2VzIEhUTUwgd291bGQgY29sbGFwc2UgLSBkb3VibGVkLCBhdCBlaXRoZXIgZW5kIG9mIGEgYmxvY2ssIG9yCiAgLy8gbWVldGluZyBhY3Jvc3MgYSB0YWcgLSBhcmUgd3JpdHRlbiBhcyAmbmJzcDsgc28gdGhleSBjb21lIGJhY2sgYXMKICAvLyB0eXBlZC4KICBmdW5jdGlvbiBydW5zSHRtbChydW5zKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBsZXQgcHJldlNwYWNlID0gZmFsc2U7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJ1bnMubGVuZ3RoOykgewogICAgICBjb25zdCBocmVmID0gcnVuc1tpXS5ocm",
"VmIHx8ICcnOwogICAgICBsZXQgaiA9IGk7CiAgICAgIGxldCBpbm5lciA9ICcnOwogICAgICB3aGlsZSAoaiA8IHJ1bnMubGVuZ3RoICYmIChydW5zW2pdLmhyZWYgfHwgJycpID09PSBocmVmKSB7CiAgICAgICAgY29uc3QgcmF3ID0gcnVuc1tqXS50ZXh0OwogICAgICAgIGxldCB0ID0gZXNjSHRtbChyYXcpLnJlcGxhY2UoLyB7Mn0vZywgJyAmbmJzcDsnKS5yZXBsYWNlKC9cbi9nLCAnPGJyPicpOwogICAgICAgIGlmIChwcmV2U3BhY2UgJiYgdFswXSA9PT0gJyAnKSB0ID0gYCZuYnNwOyR7dC5zbGljZSgxKX1gOwogICAgICAgIHByZXZTcGFjZSA9IC8gJC8udGVzdChyYXcpOwogICAgICAgIGlmIChydW5zW2pdLnMpIHQgPSBgPHM-JHt0fTwvcz5gOwogICAgICAgIGlmIChydW5zW2pdLmkpIHQgPSBgPGk-JHt0fTwvaT5gOwogICAgICAgIGlmIChydW5zW2pdLmIpIHQgPSBgPGI-JHt0fTwvYj5gOwogICAgICAgIGlubmVyICs9IHQ7CiAgICAgICAgaisrOwogICAgICB9CiAgICAgIG91dCArPSBocmVmID8gYDxhIGhyZWY9IiR7ZXNjSHRtbChocmVmKX0iPiR7aW5uZXJ9PC9hPmAgOiBpbm5lcjsKICAgICAgaSA9IGo7CiAgICB9CiAgICAvLyBFZGdlIHNwYWNlcyBvZiB0aGUgd2hvbGUgYmxvY2ssIGFmdGVyIHRoZSB0YWdzIGFyZSBpbiBwbGFjZS4KICAgIHJldHVybiBvdXQucmVwbGFjZSgvXigoPzo8W14-XSs-KSopIC8sICckMSZuYnNwOycpLnJlcGxhY2UoLyAoKD86PFwvW14-XSs-KSopJC8sICcmbmJzcDskMS",
"cpOwogIH0KCiAgY29uc3QgU1RZTEUgPSB7CiAgICBkb2M6ICdmb250LWZhbWlseTpBcmlhbCxIZWx2ZXRpY2Esc2Fucy1zZXJpZjtmb250LXNpemU6MTRweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOiMxZjFmMWYnLAogICAgcDogJ21hcmdpbjowJywKICAgIGgxOiAnbWFyZ2luOjE0cHggMCA0cHg7Zm9udC1zaXplOjIycHg7bGluZS1oZWlnaHQ6MS4zO2ZvbnQtd2VpZ2h0OmJvbGQnLAogICAgaDI6ICdtYXJnaW46MTJweCAwIDJweDtmb250LXNpemU6MThweDtsaW5lLWhlaWdodDoxLjM7Zm9udC13ZWlnaHQ6Ym9sZCcsCiAgICBoMzogJ21hcmdpbjoxMHB4IDAgMnB4O2ZvbnQtc2l6ZToxNXB4O2xpbmUtaGVpZ2h0OjEuMztmb250LXdlaWdodDpib2xkJywKICAgIGxpc3Q6ICdtYXJnaW46MDtwYWRkaW5nLWxlZnQ6MjZweCcsCiAgICBjaGVjazogJ21hcmdpbjowO3BhZGRpbmctbGVmdDo0cHg7bGlzdC1zdHlsZTpub25lJywKICAgIGxpOiAnbWFyZ2luOjFweCAwJywKICAgIHRhYmxlOiAnYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlO21hcmdpbjo2cHggMCcsCiAgICBjZWxsOiAnYm9yZGVyOjFweCBzb2xpZCAjYzRjN2M1O3BhZGRpbmc6NHB4IDhweDt2ZXJ0aWNhbC1hbGlnbjp0b3A7dGV4dC1hbGlnbjpsZWZ0JywKICAgIHRoOiAnYmFja2dyb3VuZDojZjFmM2Y0O2ZvbnQtd2VpZ2h0OmJvbGQnLAogIH07CgogIC8vIEEgdGFibGUgYXMgR21haWwgYW5kIGFueSBtYWlsIGNsaWVudCBzaG93cyBvbmUsIHN0eWxlZCBpbm",
"xpbmU7IHRoZQogIC8vIGhlYWRpbmcgcm93IGluIDx0aGVhZD4sIGFzIDx0aD4uCiAgZnVuY3Rpb24gdGFibGVIdG1sKGIpIHsKICAgIGNvbnN0IGNlbGwgPSAoYywgaywgdGFnKSA9PiB7CiAgICAgIGNvbnN0IGFsaWduID0gYi5hbGlnbltrXSA_IGA7dGV4dC1hbGlnbjoke2IuYWxpZ25ba119YCA6ICcnOwogICAgICBjb25zdCBzdHlsZSA9IGAke1NUWUxFLmNlbGx9JHt0YWcgPT09ICd0aCcgPyBgOyR7U1RZTEUudGh9YCA6ICcnfSR7YWxpZ259YDsKICAgICAgcmV0dXJuIGA8JHt0YWd9IHN0eWxlPSIke3N0eWxlfSI-JHtydW5zSHRtbChjLnJ1bnMpIHx8ICc8YnI-J308LyR7dGFnfT5gOwogICAgfTsKICAgIGNvbnN0IHJvdyA9IChyLCB0YWcpID0-IGA8dHI-JHtyLm1hcCgoYywgaykgPT4gY2VsbChjLCBrLCB0YWcpKS5qb2luKCcnKX08L3RyPmA7CiAgICBjb25zdCBib2R5ID0gYi5yb3dzLnNsaWNlKGIuaGVhZCA_IDEgOiAwKTsKICAgIHJldHVybiBgPHRhYmxlIGRhdGEtZ2tiLXRhYmxlPSIxIiBzdHlsZT0iJHtTVFlMRS50YWJsZX0iPmAgKwogICAgICAoYi5oZWFkID8gYDx0aGVhZD4ke3JvdyhiLnJvd3NbMF0sICd0aCcpfTwvdGhlYWQ-YCA6ICcnKSArCiAgICAgIChib2R5Lmxlbmd0aCA_IGA8dGJvZHk-JHtib2R5Lm1hcChyID0-IHJvdyhyLCAndGQnKSkuam9pbignJyl9PC90Ym9keT5gIDogJycpICsgJzwvdGFibGU-JzsKICB9CgogIGZ1bmN0aW9uIHRvSHRtbChkb2NJbikgewogICAgY29uc3QgZG9jID",
"0gbm9ybWFsaXNlRG9jKGRvY0luKTsKICAgIGNvbnN0IHN0YWNrID0gW107IC8vIG9wZW4gbGlzdHMsIG9uZSBwZXIgbGV2ZWw6IHsgdGFnLCBjaGVjayB9CiAgICBsZXQgb3V0ID0gYDxkaXYgZGF0YS1na2Itbm90ZT0iMSIgc3R5bGU9IiR7U1RZTEUuZG9jfSI-YDsKICAgIGNvbnN0IGNsb3NlID0gKCkgPT4geyBvdXQgKz0gYDwvbGk-PC8ke3N0YWNrLnBvcCgpLnRhZ30-YDsgfTsKCiAgICBmb3IgKGNvbnN0IGIgb2YgZG9jKSB7CiAgICAgIGlmIChiLnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSBjbG9zZSgpOwogICAgICAgIG91dCArPSBgJHt0YWJsZUh0bWwoYil9XG5gOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IGlubmVyID0gcnVuc0h0bWwoYi5ydW5zKTsKICAgICAgaWYgKCFMSVNUUy5oYXMoYi50eXBlKSkgewogICAgICAgIHdoaWxlIChzdGFjay5sZW5ndGgpIGNsb3NlKCk7CiAgICAgICAgb3V0ICs9IGA8JHtiLnR5cGV9IHN0eWxlPSIke1NUWUxFW2IudHlwZV19Ij4ke2lubmVyIHx8ICc8YnI-J308LyR7Yi50eXBlfT5cbmA7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgY29uc3QgdGFnID0gYi50eXBlID09PSAnb2wnID8gJ29sJyA6ICd1bCc7CiAgICAgIGNvbnN0IGNoZWNrID0gYi50eXBlID09PSAnY2hlY2snOwogICAgICB3aGlsZSAoc3RhY2subGVuZ3RoID4gYi5sZXZlbCArIDEpIGNsb3NlKCk7CiAgICAgIGlmIChzdG",
"Fjay5sZW5ndGggPT09IGIubGV2ZWwgKyAxKSB7CiAgICAgICAgY29uc3QgdG9wID0gc3RhY2tbc3RhY2subGVuZ3RoIC0gMV07CiAgICAgICAgaWYgKHRvcC50YWcgIT09IHRhZyB8fCB0b3AuY2hlY2sgIT09IGNoZWNrKSBjbG9zZSgpOwogICAgICAgIGVsc2Ugb3V0ICs9ICc8L2xpPic7CiAgICAgIH0KICAgICAgaWYgKHN0YWNrLmxlbmd0aCA9PT0gYi5sZXZlbCkgewogICAgICAgIG91dCArPSBjaGVjayA_IGA8dWwgZGF0YS1jaGVjaz0iMSIgc3R5bGU9IiR7U1RZTEUuY2hlY2t9Ij5gIDogYDwke3RhZ30gc3R5bGU9IiR7U1RZTEUubGlzdH0iPmA7CiAgICAgICAgc3RhY2sucHVzaCh7IHRhZywgY2hlY2sgfSk7CiAgICAgIH0KICAgICAgY29uc3QgZ2x5cGggPSBjaGVjayA_IGA8c3BhbiBkYXRhLWdseXBoPSIxIj4ke2IuY2hlY2tlZCA_IFRJQ0tFRCA6IEJPWH0mbmJzcDs8L3NwYW4-YCA6ICcnOwogICAgICBvdXQgKz0gYDxsaSBzdHlsZT0iJHtTVFlMRS5saX0iJHtjaGVjayA_IGAgZGF0YS1jaGVja2VkPSIke2IuY2hlY2tlZCA_IDEgOiAwfSJgIDogJyd9PiR7Z2x5cGh9JHtpbm5lciB8fCAoY2hlY2sgPyAnJyA6ICc8YnI-Jyl9YDsKICAgIH0KICAgIHdoaWxlIChzdGFjay5sZW5ndGgpIGNsb3NlKCk7CiAgICByZXR1cm4gYCR7b3V0fTwvZGl2PmA7CiAgfQoKICAvLyDilIDilIAgUGxhaW4gdGV4dCBvdXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHJ1bnNQbGFpbihydW5zKSB7CiAgICBsZXQgb3V0ID0gJyc7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJ1bnMubGVuZ3RoOykgewogICAgICBjb25zdCBocmVmID0gcnVuc1tpXS5ocmVmIHx8ICcnOwogICAgICBsZXQgaiA9IGk7CiAgICAgIGxldCB0ZXh0ID0gJyc7CiAgICAgIHdoaWxlIChqIDwgcnVucy5sZW5ndGggJiYgKHJ1bnNbal0uaHJlZiB8fCAnJykgPT09IGhyZWYpIHRleHQgKz0gcnVuc1tqKytdLnRleHQ7CiAgICAgIGNvbnN0IGJhcmUgPSBocmVmLnJlcGxhY2UoL15tYWlsdG86LywgJycpOwogICAgICBjb25zdCBzYW1lID0gcyA9PiBzLnRyaW0oKS5yZXBsYWNlKC9eKGh0dHBzPzpcL1wvfG1haWx0bzopLywgJycpLnJlcGxhY2UoL1wvJC8sICcnKTsKICAgICAgb3V0ICs9IGhyZWYgJiYgc2FtZSh0ZXh0KSAhPT0gc2FtZShocmVmKSA_IGAke3RleHR9ICgke2JhcmV9KWAgOiB0ZXh0OwogICAgICBpID0gajsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBBIHRhYmxlIGFzIHBsYWluIHRleHQ6IGEgcm93IGEgbGluZSwgIiB8ICIgYmV0d2VlbiBpdHMgY2VsbHMgLSB3aGF0CiAgLy8gR21haWwncyBwcmV2aWV3cyBhbmQgYSBwbGFpbi10ZXh0IG1haWwgY2xpZW50IHNob3cuIChUaGUgSFRNTCBwYXJ0IG",
"lzCiAgLy8gdGhlIHJlY29yZDsgdGhpcyBvbmx5IGhhcyB0byByZWFkIHdlbGwuKQogIGZ1bmN0aW9uIHRhYmxlUGxhaW4oYikgewogICAgY29uc3QgY2VsbCA9IGMgPT4gcnVuc1BsYWluKGMucnVucykucmVwbGFjZSgvXG4vZywgJyAnKS50cmltKCk7CiAgICByZXR1cm4gYi5yb3dzLm1hcChyID0-IHIubWFwKGNlbGwpLmpvaW4oJyB8ICcpKS5qb2luKCdcbicpOwogIH0KCiAgZnVuY3Rpb24gdG9QbGFpbihkb2NJbikgewogICAgY29uc3QgZG9jID0gbm9ybWFsaXNlRG9jKGRvY0luKTsKICAgIGNvbnN0IGNvdW50ZXJzID0gWzAsIDAsIDAsIDBdOwogICAgcmV0dXJuIGRvYy5tYXAoYiA9PiB7CiAgICAgIGlmIChiLnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICBjb3VudGVycy5maWxsKDApOwogICAgICAgIHJldHVybiB0YWJsZVBsYWluKGIpOwogICAgICB9CiAgICAgIGNvbnN0IHRleHQgPSBydW5zUGxhaW4oYi5ydW5zKTsKICAgICAgaWYgKCFMSVNUUy5oYXMoYi50eXBlKSkgewogICAgICAgIGNvdW50ZXJzLmZpbGwoMCk7CiAgICAgICAgcmV0dXJuIHRleHQ7CiAgICAgIH0KICAgICAgY29uc3QgcGFkID0gJyAgJy5yZXBlYXQoYi5sZXZlbCk7CiAgICAgIGZvciAobGV0IGwgPSBiLmxldmVsICsgMTsgbCA8IGNvdW50ZXJzLmxlbmd0aDsgbCsrKSBjb3VudGVyc1tsXSA9IDA7CiAgICAgIGlmIChiLnR5cGUgPT09ICdvbCcpIHJldHVybiBgJHtwYWR9JHsrK2NvdW50ZXJzW2IubGV2ZWxdfS4gJHt0ZXh0fWA7Ci",
"AgICAgIGNvdW50ZXJzW2IubGV2ZWxdID0gMDsKICAgICAgaWYgKGIudHlwZSA9PT0gJ2NoZWNrJykgcmV0dXJuIGAke3BhZH0ke2IuY2hlY2tlZCA_IFRJQ0tFRCA6IEJPWH0gJHt0ZXh0fWA7CiAgICAgIHJldHVybiBgJHtwYWR9JHtCVUxMRVR9ICR7dGV4dH1gOwogICAgfSkuam9pbignXG4nKTsKICB9CgogIC8vIOKUgOKUgCBQbGFpbiB0ZXh0IGluIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBBIHBsYWluIG5vdGUgKGZyb20gYmVmb3JlIGZvcm1hdHRpbmcgZXhpc3RlZCwgb3IgcGxhaW4gbWFpbCkgYmVjb21lcwogIC8vIG9uZSBibG9jayBwZXIgbGluZS4gTGluZXMgdGhhdCBhbHJlYWR5IGxvb2sgbGlrZSBsaXN0cyAtICItICIsICLigKIgIiwKICAvLyAiMS4gIiwgIuKYkCAiIC0gYmVjb21lIGxpc3RzLCBpbmRlbnRlZCB0d28gc3BhY2VzIGEgbGV2ZWwuCiAgZnVuY3Rpb24gZnJvbVBsYWluKHRleHQpIHsKICAgIGNvbnN0IGxpbmVzID0gU3RyaW5nKHRleHQgfHwgJycpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNwbGl0KCdcbicpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7CiAgICAgIC8vIF",
"R3byBvciBtb3JlIHwgYSB8IGIgfCBsaW5lcywgb3Igb25lIHdpdGggYSB8LS0tfCBsaW5lIHVuZGVyIGl0OiBhIHRhYmxlLgogICAgICBjb25zdCB0ID0gcGlwZVRhYmxlKGxpbmVzLCBpLCBzID0-IFt7IHRleHQ6IHMgfV0pOwogICAgICBpZiAodCAmJiAodC5lbmQgLSBpID4gMSB8fCB0LmJsb2NrLmhlYWQpKSB7CiAgICAgICAgb3V0LnB1c2godC5ibG9jayk7CiAgICAgICAgaSA9IHQuZW5kIC0gMTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBjb25zdCBsaW5lID0gbGluZXNbaV07CiAgICAgIGNvbnN0IG0gPSAvXiggKikoPzooWy0q4oCiXSl8KFxkezEsM30pWy4pXXwoW-KYkOKYkV0pKSAoLiopJC8uZXhlYyhsaW5lKTsKICAgICAgaWYgKCFtKSB7IG91dC5wdXNoKGJsb2NrKCdwJywgW3sgdGV4dDogbGluZSB9XSkpOyBjb250aW51ZTsgfQogICAgICBjb25zdCBsZXZlbCA9IE1hdGguZmxvb3IobVsxXS5sZW5ndGggLyAyKTsKICAgICAgaWYgKG1bNF0pIG91dC5wdXNoKGJsb2NrKCdjaGVjaycsIFt7IHRleHQ6IG1bNV0gfV0sIHsgbGV2ZWwsIGNoZWNrZWQ6IG1bNF0gPT09IFRJQ0tFRCB9KSk7CiAgICAgIGVsc2Ugb3V0LnB1c2goYmxvY2sobVszXSA_ICdvbCcgOiAndWwnLCBbeyB0ZXh0OiBtWzVdIH1dLCB7IGxldmVsIH0pKTsKICAgIH0KICAgIHJldHVybiBub3JtYWxpc2VEb2Mob3V0KTsKICB9CgogIC8vIOKUgOKUgCBQaXBlIHRhYmxlcyAoTWFya2Rvd24ncywgYW5kIHRoZSBwbGFpbiB0ZX",
"h0IGFib3ZlKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgUElQRV9ST1cgPSAvXlxzKlx8LipcfFxzKiQvOwogIGNvbnN0IFBJUEVfUlVMRSA9IC9eXHMqXHw_XHMqOj8tezMsfTo_XHMqKFx8XHMqOj8tezMsfTo_XHMqKSpcfD9ccyokLzsKICBjb25zdCBwaXBlQ2VsbHMgPSBsaW5lID0-IGxpbmUudHJpbSgpLnJlcGxhY2UoL15cfC8sICcnKS5yZXBsYWNlKC9cfCQvLCAnJykuc3BsaXQoLyg_PCFcXClcfC8pLm1hcChjID0-IGMudHJpbSgpLnJlcGxhY2UoL1xcXHwvZywgJ3wnKSk7CgogIC8vIFRoZSB0YWJsZSBvZiB8IHJvd3Mgc3RhcnRpbmcgYXQgbGluZXNbaV0sIG9yIG51bGw6IHsgYmxvY2ssIGVuZCB9LgogIC8vIEEgfC0tLXwgbGluZSB1bmRlciB0aGUgZmlyc3Qgcm93IG1ha2VzIGl0IGEgaGVhZGluZyByb3cgYW5kIGdpdmVzIHRoZQogIC8vIGNvbHVtbnMnIGFsaWdubWVudDsgIjxicj4iIGluIGEgY2VsbCBpcyBhIGxpbmUgYnJlYWsuCiAgZnVuY3Rpb24gcGlwZVRhYmxlKGxpbmVzLCBpLCBpbmxpbmUpIHsKICAgIGlmICghUElQRV9ST1cudGVzdChsaW5lc1tpXSB8fCAnJykgfHwgUElQRV9SVUxFLnRlc3QobGluZXNbaV0pKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHJvd3MgPSBbXTsKICAgIGxldCBoZWFkID0gZmFsc2U7CiAgICBsZXQgYWxpZ24gPSBbXTsKICAgIGxldCBqID0gaTsKICAgIGZvciAoOyBqIDwgbGluZXMubGVuZ3RoICYmIFBJUEVfUk9XLn",
"Rlc3QobGluZXNbal0pOyBqKyspIHsKICAgICAgaWYgKFBJUEVfUlVMRS50ZXN0KGxpbmVzW2pdKSkgewogICAgICAgIGlmIChyb3dzLmxlbmd0aCA9PT0gMSAmJiAhaGVhZCkgewogICAgICAgICAgaGVhZCA9IHRydWU7CiAgICAgICAgICBhbGlnbiA9IHBpcGVDZWxscyhsaW5lc1tqXSkubWFwKGMgPT4gKC9eOi0rOiQvLnRlc3QoYykgPyAnY2VudGVyJyA6IC9eLSs6JC8udGVzdChjKSA_ICdyaWdodCcgOiAnJykpOwogICAgICAgIH0KICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICByb3dzLnB1c2gocGlwZUNlbGxzKGxpbmVzW2pdKS5tYXAoYyA9PiAoeyBydW5zOiBpbmxpbmUoYy5yZXBsYWNlKC88YnJccypcLz8-L2dpLCAnXG4nKSkgfSkpKTsKICAgIH0KICAgIHJldHVybiB7IGJsb2NrOiB0YWJsZShyb3dzLCB7IGhlYWQsIGFsaWduIH0pLCBlbmQ6IGogfTsKICB9CgogIC8vIOKUgOKUgCBIVE1MIGluIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBjb25zdCBUT0tFTl9SRSA9IC88IS0tW1xzXFNdKj8tLT58PCFcW0NEQVRBXFtbXHNcU10qP1xdXF0-fDwhW14-XSo-fDxcP1tePl0qPnw8KFwvPykoW2EtekEtWl1bYS16QS1aMC05Oi1dKi",
"koKD86XHMrW15ccyInPi89XSsoPzpccyo9XHMqKD86IlteIl0qInwnW14nXSonfFteXHMiJz08PmBdKykpPykqKVxzKihcLz8pPnxbXjxdK3w8L2c7CiAgY29uc3QgQVRUUl9SRSA9IC8oW15ccyInPi89XSspKD86XHMqPVxzKig_OiIoW14iXSopInwnKFteJ10qKSd8KFteXHMiJz08PmBdKykpKT8vZzsKICBjb25zdCBTS0lQID0gbmV3IFNldChbJ3NjcmlwdCcsICdzdHlsZScsICdoZWFkJywgJ3RpdGxlJywgJ3RlbXBsYXRlJywgJ3N2ZycsICdtYXRoJywgJ25vc2NyaXB0JywgJ2lmcmFtZScsICdvYmplY3QnLCAneG1sJ10pOwogIGNvbnN0IFBBUkEgPSBuZXcgU2V0KFsncCcsICdkaXYnLCAnYmxvY2txdW90ZScsICdwcmUnLCAnc2VjdGlvbicsICdhcnRpY2xlJywgJ2hlYWRlcicsICdmb290ZXInLCAnbWFpbicsICdhc2lkZScsCiAgICAnbmF2JywgJ3RhYmxlJywgJ3Rib2R5JywgJ3RoZWFkJywgJ3Rmb290JywgJ2NlbnRlcicsICdkbCcsICdkdCcsICdkZCcsICdmaWd1cmUnLCAnZmlnY2FwdGlvbicsCiAgICAnZm9ybScsICdmaWVsZHNldCcsICdhZGRyZXNzJywgJ2hyJywgJ2JvZHknLCAnaHRtbCcsICdjYXB0aW9uJ10pOwogIC8vIFRhZ3MgdGhhdCBtYXJrIHRleHQsIGFuZCB0aGUgbWFya3MgdGhleSBzdGFuZCBmb3IuIHNwYW4gYW5kIGZvbnQKICAvLyBjYXJyeSB0aGVpcnMgaW4gYSBzdHlsZSBhdHRyaWJ1dGUsIGlmIGF0IGFsbC4KICBjb25zdCBJTkxJTkUgPSB7CiAgICBiOiBbJ2InXSwgc3Ryb25nOiBbJ2",
"InXSwgaTogWydpJ10sIGVtOiBbJ2knXSwgY2l0ZTogWydpJ10sIHM6IFsncyddLCBzdHJpa2U6IFsncyddLCBkZWw6IFsncyddLCBzcGFuOiBbXSwgZm9udDogW10sCiAgfTsKICBjb25zdCBIRUFESU5HUyA9IHsgaDE6ICdoMScsIGgyOiAnaDInLCBoMzogJ2gzJywgaDQ6ICdoMycsIGg1OiAnaDMnLCBoNjogJ2gzJyB9OwoKICBmdW5jdGlvbiBhdHRyc09mKHMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgbGV0IG07CiAgICBBVFRSX1JFLmxhc3RJbmRleCA9IDA7CiAgICB3aGlsZSAoKG0gPSBBVFRSX1JFLmV4ZWMocyB8fCAnJykpKSB7CiAgICAgIG91dFttWzFdLnRvTG93ZXJDYXNlKCldID0gdXRpbC5kZWNvZGVFbnRpdGllcyhtWzJdICE9PSB1bmRlZmluZWQgPyBtWzJdIDogbVszXSAhPT0gdW5kZWZpbmVkID8gbVszXSA6IG1bNF0gfHwgJycpOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIEJvbGQsIGl0YWxpYyBhbmQgc3RyaWtlLXRocm91Z2ggd3JpdHRlbiBhcyBpbmxpbmUgc3R5bGVzLCBhcyBPdXRsb29rCiAgLy8gYW5kIHBhc3RlZCB3ZWIgdGV4dCBvZnRlbiBkbywgY291bnQgdGhlIHNhbWUgYXMgdGhlIHRhZ3MuCiAgZnVuY3Rpb24gc3R5bGVNYXJrcyhzdHlsZSkgewogICAgY29uc3QgcyA9IFN0cmluZyhzdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgIGNvbnN0IG1hcmtzID0gW107CiAgICBpZiAoL2ZvbnQtd2VpZ2h0XHMqOlxzKihib2xkfGJvbGRlcnxbNi05XTAwKS8udGVzdC",
"hzKSkgbWFya3MucHVzaCgnYicpOwogICAgaWYgKC9mb250LXN0eWxlXHMqOlxzKml0YWxpYy8udGVzdChzKSkgbWFya3MucHVzaCgnaScpOwogICAgaWYgKC90ZXh0LWRlY29yYXRpb24oLWxpbmUpP1xzKjpbXjtdKmxpbmUtdGhyb3VnaC8udGVzdChzKSkgbWFya3MucHVzaCgncycpOwogICAgcmV0dXJuIG1hcmtzOwogIH0KCiAgLy8gV2hldGhlciBhIGJyb3dzZXIgd291bGQgc2hvdyBzcGFjZSBiZWxvdyBhIDxwPjogaXQgZG9lcyB1bmxlc3MgaXRzCiAgLy8gc3R5bGUgc2F5cyBvdGhlcndpc2UuIFdvcmQgYW5kIE91dGxvb2sgcGFyYWdyYXBocyAoTXNvTm9ybWFsKSBhcmUKICAvLyBsaW5lcywgYW5kIHNvIGFyZSB0aGUgZWRpdG9yJ3Mgb3duIGFuZCBHb29nbGUgRG9jcycuCiAgZnVuY3Rpb24gcGFyYUdhcChhKSB7CiAgICBpZiAoL1xiTXNvLy50ZXN0KGEuY2xhc3MgfHwgJycpKSByZXR1cm4gZmFsc2U7CiAgICBjb25zdCBzdHlsZSA9IFN0cmluZyhhLnN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgemVybyA9IHYgPT4gL14tPzAoXC4wKyk_KFthLXpdK3wlKT8kLy50ZXN0KHYgfHwgJycpOwogICAgY29uc3QgYm90dG9tID0gLyg_Ol58OylccyptYXJnaW4tYm90dG9tXHMqOlxzKihbXjshXSspLy5leGVjKHN0eWxlKTsKICAgIGlmIChib3R0b20pIHJldHVybiAhemVybyhib3R0b21bMV0udHJpbSgpKTsKICAgIGNvbnN0IGFsbCA9IC8oPzpefDspXHMqbWFyZ2luXHMqOlxzKihbXjshXSspLy",
"5leGVjKHN0eWxlKTsKICAgIGlmIChhbGwpIHsKICAgICAgY29uc3QgdiA9IGFsbFsxXS50cmltKCkuc3BsaXQoL1xzKy8pOwogICAgICByZXR1cm4gIXplcm8odi5sZW5ndGggPj0gMyA_IHZbMl0gOiB2WzBdKTsKICAgIH0KICAgIHJldHVybiB0cnVlOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VIdG1sKGh0bWwpIHsKICAgIGNvbnN0IGJsb2NrcyA9IFtdOwogICAgY29uc3QgbGlzdHMgPSBbXTsgICAgICAgICAvLyBvcGVuIGxpc3RzOiB7IHR5cGUsIGxpT3BlbiB9CiAgICBjb25zdCBtYXJrcyA9IHsgYjogMCwgaTogMCwgczogMCB9OwogICAgY29uc3QgaHJlZnMgPSBbXTsKICAgIGNvbnN0IGlubGluZSA9IFtdOyAgICAgICAgLy8gb3BlbiBpbmxpbmUgdGFnczogeyBuYW1lLCBtYXJrcyB9IG9yIHsgbmFtZSwgZ2x5cGg6IHRydWUgfQogICAgbGV0IHNraXAgPSAwOwogICAgbGV0IGdseXBoID0gMDsKICAgIGxldCBjdXIgPSBudWxsOwogICAgLy8gVGhlIG9wZW4gdGFibGUsIGlmIGFueTogeyBiLCByb3csIGNlbGwsIHRoZWFkLCBkZXB0aCB9LiBJdHMgdGV4dCBnb2VzCiAgICAvLyBpbnRvIGl0cyBjZWxsczsgYSB0YWJsZSBpbnNpZGUgYSBjZWxsIGlzIHJlYWQgaW50byB0aGF0IGNlbGwgYXMgdGV4dCwKICAgIC8vIGEgcm93IGEgbGluZSAoZGVwdGggY291bnRzIHRob3NlKS4KICAgIGxldCB0YmwgPSBudWxsOwogICAgbGV0IHByZSA9IDA7ICAgICAgICAgICAgICAvLyBpbnNpZGUgPHByZT46IGxpbmUgYnJlYWtzIG",
"FuZCBzcGFjZXMgYXJlIHRleHQKICAgIGxldCBwYXJhID0gbnVsbDsgICAgICAgICAgLy8gdGhlIG9wZW4gPHA-OiB7IGdhcCB9CiAgICBsZXQgZ2FwID0gZmFsc2U7ICAgICAgICAgIC8vIGEgPHA-IGp1c3QgY2xvc2VkIHdpdGggc3BhY2UgYmVsb3cgaXQKICAgIGxldCBvdXJzID0gZmFsc2U7ICAgICAgICAgLy8gaW5zaWRlIGEgbm90ZSdzIG93biBIVE1MLCB3aGVyZSBwYXJhZ3JhcGhzIGFyZSBsaW5lcwoKICAgIGNvbnN0IGxldmVsID0gKCkgPT4gTWF0aC5tYXgoMCwgbGlzdHMubGVuZ3RoIC0gMSk7CiAgICBjb25zdCBvcGVuID0gKHR5cGUsIGV4dHJhKSA9PiB7CiAgICAgIC8vIFRoZSBzcGFjZSBhIGJyb3dzZXIgc2hvd3MgYWZ0ZXIgYSBwYXJhZ3JhcGggaXMgYW4gZW1wdHkgbGluZSBpbiBhCiAgICAgIC8vIG5vdGUgLSB3aGljaCBoYXMgbm8gc3BhY2UgYmV0d2VlbiBwYXJhZ3JhcGhzIC0gZXhjZXB0IGJlZm9yZSBhCiAgICAgIC8vIGhlYWRpbmcsIHdoaWNoIGhhcyBpdHMgb3duLgogICAgICBpZiAoZ2FwKSB7CiAgICAgICAgZ2FwID0gZmFsc2U7CiAgICAgICAgY29uc3QgbGFzdCA9IGJsb2Nrc1tibG9ja3MubGVuZ3RoIC0gMV07CiAgICAgICAgaWYgKGxhc3QgJiYgIUhFQURJTkdTW3R5cGVdICYmIGxhc3QucnVucy5zb21lKHIgPT4gL1xTLy50ZXN0KHIudGV4dCkpKSBibG9ja3MucHVzaChibG9jaygncCcpKTsKICAgICAgfQogICAgICBjdXIgPSBibG9jayh0eXBlLCBbXSwgZXh0cmEpOwogICAgICBibG",
"9ja3MucHVzaChjdXIpOwogICAgICByZXR1cm4gY3VyOwogICAgfTsKICAgIGNvbnN0IGVuZCA9ICgpID0-IHsgY3VyID0gbnVsbDsgfTsKICAgIC8vIFdoZXJlIHRleHQgbGFuZHMgd2hlbiBubyBibG9jayBpcyBvcGVuOiBpbnNpZGUgYSBsaXN0IGl0ZW0sIGEKICAgIC8vIGNvbnRpbnVhdGlvbiBvZiB0aGF0IGl0ZW07IG90aGVyd2lzZSBhIG5ldyBwYXJhZ3JhcGguCiAgICBjb25zdCBjb250ZXh0ID0gKCkgPT4gewogICAgICBjb25zdCB0b3AgPSBsaXN0c1tsaXN0cy5sZW5ndGggLSAxXTsKICAgICAgaWYgKHRvcCAmJiB0b3AubGlPcGVuKSByZXR1cm4gb3Blbih0b3AudHlwZSwgeyBsZXZlbDogbGV2ZWwoKSwgY2hlY2tlZDogZmFsc2UgfSk7CiAgICAgIHJldHVybiBvcGVuKCdwJyk7CiAgICB9OwogICAgY29uc3QgYXBwbHkgPSAobGlzdCwgZGVsdGEpID0-IGxpc3QuZm9yRWFjaChtID0-IHsgbWFya3NbbV0gKz0gZGVsdGE7IH0pOwogICAgY29uc3QgcnVuID0gdGV4dCA9PiAoeyB0ZXh0LCBiOiBtYXJrcy5iID4gMCwgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLCBocmVmOiBocmVmcy5sZW5ndGggPyBocmVmc1tocmVmcy5sZW5ndGggLSAxXSA6ICcnIH0pOwogICAgLy8gSW5zaWRlIGEgdGFibGU6IHRoZSBvcGVuIGNlbGwncyBydW5zLCBvciBudWxsIGJldHdlZW4gY2VsbHMuCiAgICBjb25zdCBjZWxsUnVucyA9ICgpID0-ICh0YmwgJiYgdGJsLmNlbGwgPyB0YmwuY2VsbC5ydW5zIDogbnVsbCk7Ci",
"AgICAvLyBBIGxpbmUgYnJlYWsgaW4gdGhlIG9wZW4gY2VsbCwgdW5sZXNzIGl0IGlzIGVtcHR5IG9yIGp1c3QgaGFkIG9uZS4KICAgIGNvbnN0IGNlbGxCcmVhayA9ICgpID0-IHsKICAgICAgY29uc3QgcnVucyA9IGNlbGxSdW5zKCk7CiAgICAgIGlmICghcnVucyB8fCAhcnVucy5sZW5ndGgpIHJldHVybjsKICAgICAgY29uc3QgbGFzdCA9IHJ1bnNbcnVucy5sZW5ndGggLSAxXTsKICAgICAgaWYgKCEvXG4kLy50ZXN0KGxhc3QudGV4dCkpIHJ1bnMucHVzaChydW4oJ1xuJykpOwogICAgfTsKICAgIGNvbnN0IHJvd3NTZWVuID0gW107CiAgICBjb25zdCBjbG9zZUNlbGwgPSAoKSA9PiB7CiAgICAgIGlmICghdGJsIHx8ICF0YmwuY2VsbCkgcmV0dXJuOwogICAgICBhcHBseSh0YmwuY2VsbC5tYXJrcywgLTEpOwogICAgICB0YmwuY2VsbCA9IG51bGw7CiAgICB9OwogICAgLy8gVGhlIHRhYmxlIGRvbmU6IGVtcHR5IHJvd3MgZ29uZSwgdGhlIGhlYWRpbmcgcm93IGFuZCB0aGUgY29sdW1ucycKICAgIC8vIGFsaWdubWVudCB3b3JrZWQgb3V0IGZyb20gdGhlIGNlbGxzLgogICAgY29uc3QgZmluaXNoVGFibGUgPSAoKSA9PiB7CiAgICAgIGNsb3NlQ2VsbCgpOwogICAgICBjb25zdCB0ID0gdGJsOwogICAgICB0YmwgPSBudWxsOwogICAgICBjb25zdCByb3dzID0gcm93c1NlZW4uZmlsdGVyKHIgPT4gci5jZWxscy5sZW5ndGggJiYgdC5iLnJvd3MuaW5kZXhPZihyLmNlbGxzKSA-PSAwKTsKICAgICAgcm93c1NlZW4ubG",
"VuZ3RoID0gMDsKICAgICAgdC5iLnJvd3MgPSByb3dzLm1hcChyID0-IHIuY2VsbHMpOwogICAgICBpZiAoIXJvd3MubGVuZ3RoKSB7IGJsb2Nrcy5zcGxpY2UoYmxvY2tzLmluZGV4T2YodC5iKSwgMSk7IHJldHVybjsgfQogICAgICBjb25zdCBmaXJzdCA9IHJvd3NbMF07CiAgICAgIHQuYi5oZWFkID0gZmlyc3QudGhlYWQgfHwgKGZpcnN0LnRoICYmIGZpcnN0LmNlbGxzLnNvbWUoYyA9PiBjLnRoKSAmJiByb3dzLmxlbmd0aCA-IDEpOwogICAgICBjb25zdCBjb2xzID0gTWF0aC5tYXgoLi4ucm93cy5tYXAociA9PiByLmNlbGxzLmxlbmd0aCkpOwogICAgICB0LmIuYWxpZ24gPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiBjb2xzIH0sIChfLCBrKSA9PiB7CiAgICAgICAgY29uc3Qgc2VlbiA9IHJvd3Muc2xpY2UodC5iLmhlYWQgPyAxIDogMCkubWFwKHIgPT4gci5jZWxsc1trXSAmJiByLmNlbGxzW2tdLmFsaWduKS5maWx0ZXIoeCA9PiB4ICE9PSB1bmRlZmluZWQpOwogICAgICAgIHJldHVybiBzZWVuLmxlbmd0aCAmJiBzZWVuLmV2ZXJ5KHggPT4geCA9PT0gc2VlblswXSkgPyBzZWVuWzBdIDogJyc7CiAgICAgIH0pOwogICAgICAvLyBCb2xkIHRoYXQgYSBoZWFkaW5nIGNlbGwgaXMgYW55d2F5LCBhbmQgYSBoZWFkaW5nIGNlbGwgaW4gYSBsYXRlcgogICAgICAvLyByb3cgKGEgcm93J3MgbGFiZWwpLCB3cml0dGVuIGFzIGJvbGQuCiAgICAgIHJvd3MuZm9yRWFjaCgociwgaSkgPT4gci5jZWxscy5mb3JFYWNoKGMgPT",
"4gewogICAgICAgIGlmIChjLnRoICYmICEoaSA9PT0gMCAmJiB0LmIuaGVhZCkpIGMucnVucy5mb3JFYWNoKHggPT4geyB4LmIgPSB0cnVlOyB9KTsKICAgICAgfSkpOwogICAgfTsKCiAgICBsZXQgbTsKICAgIFRPS0VOX1JFLmxhc3RJbmRleCA9IDA7CiAgICB3aGlsZSAoKG0gPSBUT0tFTl9SRS5leGVjKFN0cmluZyhodG1sIHx8ICcnKSkpKSB7CiAgICAgIGNvbnN0IFt3aG9sZSwgY2xvc2luZywgcmF3TmFtZSwgcmF3QXR0cnMsIHNlbGZDbG9zaW5nXSA9IG07CiAgICAgIGlmIChyYXdOYW1lID09PSB1bmRlZmluZWQpIHsKICAgICAgICBpZiAod2hvbGVbMF0gPT09ICc8JyAmJiB3aG9sZS5sZW5ndGggPiAxKSBjb250aW51ZTsgLy8gY29tbWVudCwgZG9jdHlwZSwgQ0RBVEEKICAgICAgICBpZiAoc2tpcCkgY29udGludWU7CiAgICAgICAgaWYgKGdseXBoKSB7CiAgICAgICAgICAvLyBXb3JkJ3MgbGlzdCBtYXJrZXIgKCLCtyIsICIxLiIsICJhKSIpOiBub3QgdGV4dCwgYnV0IGl0IHNheXMKICAgICAgICAgIC8vIHdoZXRoZXIgdGhlIGxpc3QgaXMgYnVsbGV0ZWQgb3IgbnVtYmVyZWQuCiAgICAgICAgICBpZiAoY3VyICYmIGN1ci53b3JkTGlzdCkgY3VyLm1hcmtlciArPSB1dGlsLmRlY29kZUVudGl0aWVzKHdob2xlKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAocHJlKSB7CiAgICAgICAgICAvLyBFYWNoIGxpbmUgb2YgcHJlZm9ybWF0dGVkIHRleHQgaXMgYSBsaW5lIG9mIHRoZS",
"Bub3RlLCBpdHMKICAgICAgICAgIC8vIHNwYWNlcyBrZXB0IChhcyAmbmJzcDssIHdoaWNoIHRoZSB0aWR5aW5nIGJlbG93IGxlYXZlcyBhbG9uZSkuCiAgICAgICAgICBsZXQgcmF3ID0gdXRpbC5kZWNvZGVFbnRpdGllcyh3aG9sZSkucmVwbGFjZSgvXHJcbj8vZywgJ1xuJyk7CiAgICAgICAgICBpZiAocHJlLmZyZXNoKSByYXcgPSByYXcucmVwbGFjZSgvXlxuLywgJycpOwogICAgICAgICAgcHJlLmZyZXNoID0gZmFsc2U7CiAgICAgICAgICBpZiAodGJsKSB7CiAgICAgICAgICAgIGlmIChjZWxsUnVucygpKSBjZWxsUnVucygpLnB1c2gocnVuKHJhdy5yZXBsYWNlKC9cdC9nLCAnICAgICcpKSk7CiAgICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgICAgfQogICAgICAgICAgcmF3LnNwbGl0KCdcbicpLmZvckVhY2goKGxpbmUsIGspID0-IHsKICAgICAgICAgICAgaWYgKGspIHsKICAgICAgICAgICAgICBlbmQoKTsKICAgICAgICAgICAgICBvcGVuKCdwJykucHJlTGluZSA9IHRydWU7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgaWYgKCFsaW5lKSByZXR1cm47CiAgICAgICAgICAgIGlmICghY3VyKSBjb250ZXh0KCk7CiAgICAgICAgICAgIGN1ci5ydW5zLnB1c2goewogICAgICAgICAgICAgIHRleHQ6IGxpbmUucmVwbGFjZSgvXHQvZywgJyAgICAnKS5yZXBsYWNlKC8gL2csICdcdTAwYTAnKSwKICAgICAgICAgICAgICBiOiBtYXJrcy5iID4gMCwgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLAogIC",
"AgICAgICAgICAgIGhyZWY6IGhyZWZzLmxlbmd0aCA_IGhyZWZzW2hyZWZzLmxlbmd0aCAtIDFdIDogJycsCiAgICAgICAgICAgIH0pOwogICAgICAgICAgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3QgdGV4dCA9IHV0aWwuZGVjb2RlRW50aXRpZXMod2hvbGUgPT09ICc8JyA_ICc8JyA6IHdob2xlKS5yZXBsYWNlKC9bIFx0XHJcblxmXSsvZywgJyAnKTsKICAgICAgICBpZiAodGJsKSB7CiAgICAgICAgICAvLyBCZXR3ZWVuIGNlbGxzLCBvbmx5IHN0cmF5IHdoaXRlc3BhY2U6IG5vdGhpbmcuCiAgICAgICAgICBjb25zdCBydW5zID0gY2VsbFJ1bnMoKTsKICAgICAgICAgIGlmIChydW5zICYmIChydW5zLmxlbmd0aCB8fCAvW14gXHRcclxuXGZdLy50ZXN0KHRleHQpKSkgcnVucy5wdXNoKHJ1bih0ZXh0KSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKCFjdXIpIHsKICAgICAgICAgIC8vIE9ubHkgSFRNTCdzIG93biB3aGl0ZXNwYWNlIGlzIG5vdGhpbmc7IGFuICZuYnNwOyBpcyBhIHNwYWNlIHNvbWVvbmUgdHlwZWQuCiAgICAgICAgICBpZiAoIS9bXiBcdFxyXG5cZl0vLnRlc3QodGV4dCkpIGNvbnRpbnVlOwogICAgICAgICAgY29udGV4dCgpOwogICAgICAgIH0KICAgICAgICBjdXIucnVucy5wdXNoKHsKICAgICAgICAgIHRleHQsCiAgICAgICAgICBiOiBtYXJrcy5iID4gMCwgaTogbWFya3MuaSA-IDAsIHM6IG1hcmtzLnMgPiAwLAogICAgIC",
"AgICAgaHJlZjogaHJlZnMubGVuZ3RoID8gaHJlZnNbaHJlZnMubGVuZ3RoIC0gMV0gOiAnJywKICAgICAgICB9KTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQoKICAgICAgY29uc3QgbmFtZSA9IHJhd05hbWUudG9Mb3dlckNhc2UoKTsKICAgICAgY29uc3QgaXNDbG9zZSA9IGNsb3NpbmcgPT09ICcvJzsKICAgICAgaWYgKFNLSVAuaGFzKG5hbWUpKSB7CiAgICAgICAgaWYgKCFzZWxmQ2xvc2luZykgc2tpcCA9IE1hdGgubWF4KDAsIHNraXAgKyAoaXNDbG9zZSA_IC0xIDogMSkpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChza2lwKSBjb250aW51ZTsKICAgICAgY29uc3QgYSA9IGlzQ2xvc2UgPyB7fSA6IGF0dHJzT2YocmF3QXR0cnMpOwoKICAgICAgaWYgKG5hbWUgPT09ICdicicpIHsKICAgICAgICBpZiAodGJsKSB7CiAgICAgICAgICBjb25zdCBydW5zID0gY2VsbFJ1bnMoKTsKICAgICAgICAgIGlmIChydW5zKSBydW5zLnB1c2gocnVuKCdcbicpKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAoY3VyKSBlbmQoKTsKICAgICAgICBlbHNlIHsgY29udGV4dCgpOyBlbmQoKTsgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CgogICAgICAvLyDilIDilIAgVGFibGVzIOKUgOKUgAogICAgICBpZiAobmFtZSA9PT0gJ3RhYmxlJykgewogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgICBpZiAodGJsICYmIHRibC5kZXB0aCkgeyB0YmwuZGVwdGgtLTsgY2",
"VsbEJyZWFrKCk7IGNvbnRpbnVlOyB9CiAgICAgICAgICBpZiAodGJsKSBmaW5pc2hUYWJsZSgpOwogICAgICAgICAgY29udGludWU7CiAgICAgICAgfQogICAgICAgIGlmICh0YmwpIHsgdGJsLmRlcHRoKys7IGNlbGxCcmVhaygpOyBjb250aW51ZTsgfQogICAgICAgIGVuZCgpOwogICAgICAgIHRibCA9IHsgYjogdGFibGUoW10sIHt9KSwgcm93OiBudWxsLCBjZWxsOiBudWxsLCB0aGVhZDogZmFsc2UsIGRlcHRoOiAwLCBoZWFkUm93OiB0cnVlIH07CiAgICAgICAgYmxvY2tzLnB1c2godGJsLmIpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICh0YmwgJiYgbmFtZSA9PT0gJ2NhcHRpb24nKSB7CiAgICAgICAgaWYgKCFzZWxmQ2xvc2luZykgc2tpcCA9IE1hdGgubWF4KDAsIHNraXAgKyAoaXNDbG9zZSA_IC0xIDogMSkpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICh0YmwgJiYgKG5hbWUgPT09ICd0aGVhZCcgfHwgbmFtZSA9PT0gJ3Rib2R5JyB8fCBuYW1lID09PSAndGZvb3QnIHx8IG5hbWUgPT09ICdjb2xncm91cCcgfHwgbmFtZSA9PT0gJ2NvbCcpKSB7CiAgICAgICAgaWYgKG5hbWUgPT09ICd0aGVhZCcgJiYgIXRibC5kZXB0aCkgdGJsLnRoZWFkID0gIWlzQ2xvc2U7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKHRibCAmJiBuYW1lID09PSAndHInKSB7CiAgICAgICAgaWYgKHRibC5kZXB0aCkgeyBjZWxsQnJlYWsoKTsgY29udGludWU7IH0KICAgIC",
"AgICBjbG9zZUNlbGwoKTsKICAgICAgICB0Ymwucm93ID0gbnVsbDsKICAgICAgICBpZiAoIWlzQ2xvc2UpIHsKICAgICAgICAgIHRibC5yb3cgPSB7IGNlbGxzOiBbXSwgdGg6IHRydWUsIHRoZWFkOiB0YmwudGhlYWQgfTsKICAgICAgICAgIHRibC5iLnJvd3MucHVzaCh0Ymwucm93LmNlbGxzKTsKICAgICAgICAgIHJvd3NTZWVuLnB1c2godGJsLnJvdyk7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICh0YmwgJiYgKG5hbWUgPT09ICd0ZCcgfHwgbmFtZSA9PT0gJ3RoJykpIHsKICAgICAgICBpZiAodGJsLmRlcHRoKSB7CiAgICAgICAgICBpZiAoIWlzQ2xvc2UgJiYgY2VsbFJ1bnMoKSAmJiBjZWxsUnVucygpLmxlbmd0aCAmJiAhL1tcbiBdJC8udGVzdChjZWxsUnVucygpW2NlbGxSdW5zKCkubGVuZ3RoIC0gMV0udGV4dCkpIGNlbGxSdW5zKCkucHVzaChydW4oJyAnKSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY2xvc2VDZWxsKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UgfHwgc2VsZkNsb3NpbmcpIGNvbnRpbnVlOwogICAgICAgIGlmICghdGJsLnJvdykgewogICAgICAgICAgdGJsLnJvdyA9IHsgY2VsbHM6IFtdLCB0aDogdHJ1ZSwgdGhlYWQ6IHRibC50aGVhZCB9OwogICAgICAgICAgdGJsLmIucm93cy5wdXNoKHRibC5yb3cuY2VsbHMpOwogICAgICAgICAgcm93c1NlZW4ucHVzaCh0Ymwucm93KTsKICAgICAgICB9CiAgICAgICAgaWYgKG5hbWUgPT",
"09ICd0ZCcpIHRibC5yb3cudGggPSBmYWxzZTsKICAgICAgICBjb25zdCBzdCA9IFN0cmluZyhhLnN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgICAgIGNvbnN0IGFsID0gKC90ZXh0LWFsaWduXHMqOlxzKihjZW50ZXJ8cmlnaHQpLy5leGVjKHN0KSB8fCBbXSlbMV0gfHwgKC9eKGNlbnRlcnxyaWdodCkkL2kudGVzdChhLmFsaWduIHx8ICcnKSA_IGEuYWxpZ24udG9Mb3dlckNhc2UoKSA6ICcnKTsKICAgICAgICAvLyBCb2xkLCBpdGFsaWMgb3Igc3RydWNrIHRocm91Z2ggY2VsbCBzdHlsZXMgKEdvb2dsZSBTaGVldHMpIGNvdW50CiAgICAgICAgLy8gYXMgbWFya3MgLSBidXQgYSBoZWFkaW5nIGNlbGwgaXMgYm9sZCBhbnl3YXkuCiAgICAgICAgY29uc3QgZ290ID0gc3R5bGVNYXJrcyhzdCkuZmlsdGVyKHggPT4gIShuYW1lID09PSAndGgnICYmIHggPT09ICdiJykpOwogICAgICAgIGFwcGx5KGdvdCwgMSk7CiAgICAgICAgdGJsLmNlbGwgPSB7IHJ1bnM6IFtdLCBhbGlnbjogYWwsIG1hcmtzOiBnb3QsIHRoOiBuYW1lID09PSAndGgnIH07CiAgICAgICAgdGJsLnJvdy5jZWxscy5wdXNoKHRibC5jZWxsKTsKICAgICAgICAvLyBBIGNlbGwgc3Bhbm5pbmcgY29sdW1ucyBrZWVwcyB0aGUgY29sdW1ucyBhZnRlciBpdCBpbiBwbGFjZS4KICAgICAgICBjb25zdCBzcGFuID0gTWF0aC5taW4oTUFYX0NPTFMsIE1hdGgubWF4KDEsIHBhcnNlSW50KGEuY29sc3BhbiwgMTApIHx8IDEpKTsKICAgICAgICBmb3IgKG",
"xldCBrID0gMTsgayA8IHNwYW47IGsrKykgdGJsLnJvdy5jZWxscy5wdXNoKGVtcHR5Q2VsbCgpKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAodGJsICYmICF0YmwuY2VsbCAmJiAhaXNDbG9zZSAmJiAoSEVBRElOR1NbbmFtZV0gfHwgUEFSQS5oYXMobmFtZSkgfHwgbmFtZSA9PT0gJ2xpJyB8fCBuYW1lID09PSAndWwnIHx8IG5hbWUgPT09ICdvbCcpKSBjb250aW51ZTsKICAgICAgaWYgKHRibCAmJiAoSEVBRElOR1NbbmFtZV0gfHwgbmFtZSA9PT0gJ2xpJyB8fCBuYW1lID09PSAndWwnIHx8IG5hbWUgPT09ICdvbCcgfHwgbmFtZSA9PT0gJ3ByZScgfHwgUEFSQS5oYXMobmFtZSkpKSB7CiAgICAgICAgLy8gTGluZXMgaW5zaWRlIGEgY2VsbDogcGFyYWdyYXBocywgaGVhZGluZ3MgYW5kIGxpc3QgaXRlbXMgZWFjaAogICAgICAgIC8vIHN0YXJ0IGEgbmV3IG9uZTsgYSBsaXN0IGl0ZW0ga2VlcHMgYSBidWxsZXQuCiAgICAgICAgY2VsbEJyZWFrKCk7CiAgICAgICAgaWYgKG5hbWUgPT09ICdsaScgJiYgIWlzQ2xvc2UgJiYgY2VsbFJ1bnMoKSkgY2VsbFJ1bnMoKS5wdXNoKHJ1bign4oCiICcpKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQoKICAgICAgaWYgKEhFQURJTkdTW25hbWVdKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFpc0Nsb3NlKSBvcGVuKEhFQURJTkdTW25hbWVdKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3VsJyB8fCBuYW",
"1lID09PSAnb2wnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKGlzQ2xvc2UpIGxpc3RzLnBvcCgpOwogICAgICAgIGVsc2UgbGlzdHMucHVzaCh7IHR5cGU6IGFbJ2RhdGEtY2hlY2snXSA_ICdjaGVjaycgOiBuYW1lLCBsaU9wZW46IGZhbHNlIH0pOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnbGknKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgaWYgKCFsaXN0cy5sZW5ndGgpIGxpc3RzLnB1c2goeyB0eXBlOiAndWwnLCBsaU9wZW46IGZhbHNlLCBpbXBsaWVkOiB0cnVlIH0pOwogICAgICAgIGNvbnN0IHRvcCA9IGxpc3RzW2xpc3RzLmxlbmd0aCAtIDFdOwogICAgICAgIHRvcC5saU9wZW4gPSAhaXNDbG9zZTsKICAgICAgICBpZiAoIWlzQ2xvc2UpIHsKICAgICAgICAgIG9wZW4odG9wLnR5cGUsIHsgbGV2ZWw6IGxldmVsKCksIGNoZWNrZWQ6IGFbJ2RhdGEtY2hlY2tlZCddID09PSAnMScgfSk7CiAgICAgICAgICAvLyBPbmUgb2Ygb3VyczogaXRzIGJveCBpcyBpbiB0aGUgYXR0cmlidXRlLCBhbmQgYSDimJAgYXQgdGhlIHN0YXJ0CiAgICAgICAgICAvLyBvZiBpdHMgdGV4dCBpcyB0ZXh0LgogICAgICAgICAgaWYgKGFbJ2RhdGEtY2hlY2tlZCddICE9PSB1bmRlZmluZWQpIGN1ci5vdXJzID0gdHJ1ZTsKICAgICAgICAgIC8vIEEgY2hlY2tsaXN0IGl0ZW0gbWFya2VkIHVwIGZvciBzY3JlZW4gcmVhZGVycyAoR29vZ2xlIERvY3MpLgogICAgICAgICAgZWxzZSBpZi",
"AoYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJyB8fCBhWydhcmlhLWNoZWNrZWQnXSA9PT0gJ2ZhbHNlJykgewogICAgICAgICAgICBjdXIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICAgIGN1ci5jaGVja2VkID0gYVsnYXJpYS1jaGVja2VkJ10gPT09ICd0cnVlJzsKICAgICAgICAgICAgY3VyLm91cnMgPSB0cnVlOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgICBlbHNlIGlmICh0b3AuaW1wbGllZCkgbGlzdHMucG9wKCk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gU3RyYXkgcm93IG9yIGNlbGwgdGFncyBvdXRzaWRlIGEgdGFibGU6IGEgbGluZSBlYWNoLgogICAgICBpZiAobmFtZSA9PT0gJ3RyJyB8fCBuYW1lID09PSAndGQnIHx8IG5hbWUgPT09ICd0aCcpIHsgZW5kKCk7IGNvbnRpbnVlOyB9CiAgICAgIGlmIChuYW1lID09PSAncHJlJykgewogICAgICAgIGVuZCgpOwogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgICAvLyBUaGUgbGluZSBicmVhayBiZWZvcmUgPC9wcmU-IGVuZHMgdGhlIGxhc3QgbGluZTsgaXQgaXMgbm90IG9uZSBtb3JlLgogICAgICAgICAgY29uc3QgbGFzdCA9IGJsb2Nrc1tibG9ja3MubGVuZ3RoIC0gMV07CiAgICAgICAgICBpZiAobGFzdCAmJiBsYXN0LnByZUxpbmUgJiYgIWxhc3QucnVucy5sZW5ndGgpIGJsb2Nrcy5wb3AoKTsKICAgICAgICAgIHByZSA9IDA7CiAgICAgICAgfSBlbHNlIGlmICghc2VsZkNsb3NpbmcpIHsKICAgICAgICAgIH",
"ByZSA9IHsgZnJlc2g6IHRydWUgfTsKICAgICAgICB9CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQSB0aWNrZWQgb3IgZW1wdHkgYm94IGF0IHRoZSBzdGFydCBvZiBhIGxpbmUgLSBhIHRhc2sgbGlzdCBvbiBhCiAgICAgIC8vIHdlYiBwYWdlIChHaXRIdWIpIC0gbWFrZXMgaXQgYSBjaGVja2xpc3QgaXRlbS4KICAgICAgaWYgKG5hbWUgPT09ICdpbnB1dCcgJiYgU3RyaW5nKGEudHlwZSB8fCAnJykudG9Mb3dlckNhc2UoKSA9PT0gJ2NoZWNrYm94JykgewogICAgICAgIGlmICh0YmwpIHsKICAgICAgICAgIGlmIChjZWxsUnVucygpKSBjZWxsUnVucygpLnB1c2gocnVuKCdjaGVja2VkJyBpbiBhID8gYCR7VElDS0VEfSBgIDogYCR7Qk9YfSBgKSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKCFjdXIpIGNvbnRleHQoKTsKICAgICAgICBpZiAoIWN1ci5ydW5zLnNvbWUociA9PiAvXFMvLnRlc3Qoci50ZXh0KSkpIHsKICAgICAgICAgIGN1ci50eXBlID0gJ2NoZWNrJzsKICAgICAgICAgIGN1ci5jaGVja2VkID0gJ2NoZWNrZWQnIGluIGE7CiAgICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiBhWydkYXRhLWdrYi1ub3RlJ10gIT09IHVuZGVmaW5lZCkgb3VycyA9IHRydWU7CiAgICAgIC8vIEEgYmxvY2sgY29waWVkIG91dCBvZiBhIG5vdGUncyBlZGl0b3Iga2",
"VlcHMgaXRzIGtpbmQuCiAgICAgIGlmIChuYW1lID09PSAnZGl2JyAmJiAhaXNDbG9zZSAmJiBUWVBFUy5oYXMoYVsnZGF0YS10eXBlJ10pICYmIGFbJ2RhdGEtdHlwZSddICE9PSAndGFibGUnKSB7CiAgICAgICAgZW5kKCk7CiAgICAgICAgb3BlbihhWydkYXRhLXR5cGUnXSwgeyBsZXZlbDogTnVtYmVyKGFbJ2RhdGEtbGV2ZWwnXSkgfHwgMCwgY2hlY2tlZDogYVsnZGF0YS1jaGVja2VkJ10gPT09ICcxJyB9KTsKICAgICAgICBjdXIub3VycyA9IHRydWU7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gV29yZCB3cml0ZXMgYSBsaXN0IGFzIHBhcmFncmFwaHMgc3R5bGVkICJtc28tbGlzdDogbDAgbGV2ZWwxIi4KICAgICAgaWYgKG5hbWUgPT09ICdwJyAmJiAhaXNDbG9zZSkgewogICAgICAgIGNvbnN0IHdsID0gL21zby1saXN0XHMqOlxzKmxcZCtccytsZXZlbChcZCkvaS5leGVjKGEuc3R5bGUgfHwgJycpOwogICAgICAgIGlmICh3bCkgewogICAgICAgICAgZW5kKCk7CiAgICAgICAgICBvcGVuKCd1bCcsIHsgbGV2ZWw6IE51bWJlcih3bFsxXSkgLSAxIH0pOwogICAgICAgICAgY3VyLndvcmRMaXN0ID0gdHJ1ZTsKICAgICAgICAgIGN1ci5tYXJrZXIgPSAnJzsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAobmFtZSA9PT0gJ3AnKSB7CiAgICAgICAgaWYgKHBhcmEgJiYgcGFyYS5nYXApIGdhcCA9IHRydWU7CiAgICAgICAgcGFyYSA9IG51bGw7CiAgICAgIC",
"AgaWYgKCFpc0Nsb3NlKSB7CiAgICAgICAgICBjb25zdCB0b3AgPSBsaXN0c1tsaXN0cy5sZW5ndGggLSAxXTsKICAgICAgICAgIHBhcmEgPSB7IGdhcDogIW91cnMgJiYgIXRibCAmJiAhKHRvcCAmJiB0b3AubGlPcGVuKSAmJiBwYXJhR2FwKGEpIH07CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChQQVJBLmhhcyhuYW1lKSkgewogICAgICAgIC8vIFN0cmFpZ2h0IGluc2lkZSBhIGxpc3QgaXRlbSB0aGF0IGhhcyBubyB0ZXh0IHlldCAoR29vZ2xlIERvY3MKICAgICAgICAvLyB3cmFwcyBldmVyeSBpdGVtIGluIGEgPHA-KSwgdGhlIGxpbmUgZ29lcyBvbi4KICAgICAgICBpZiAoY3VyICYmICFjdXIucnVucy5sZW5ndGggJiYgIWlzQ2xvc2UpIGNvbnRpbnVlOwogICAgICAgIGVuZCgpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChuYW1lID09PSAnYScpIHsKICAgICAgICBpZiAoaXNDbG9zZSkgaHJlZnMucG9wKCk7CiAgICAgICAgZWxzZSBpZiAoIXNlbGZDbG9zaW5nKSBocmVmcy5wdXNoKHNhZmVIcmVmKGEuaHJlZikpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChJTkxJTkVbbmFtZV0pIHsKICAgICAgICBpZiAoc2VsZkNsb3NpbmcpIGNvbnRpbnVlOwogICAgICAgIGlmIChpc0Nsb3NlKSB7CiAgICAgICAgICAvLyBUaGUgaW5uZXJtb3N0IG9wZW4gdGFnIG9mIHRoYXQgbmFtZSAtIG1haWwgaXMgbm90IGFsd2F5cyB0aWRpbHkgbmVzdGVkLgogICAgICAgICAgZm9yIC",
"hsZXQgayA9IGlubGluZS5sZW5ndGggLSAxOyBrID49IDA7IGstLSkgewogICAgICAgICAgICBpZiAoaW5saW5lW2tdLm5hbWUgIT09IG5hbWUpIGNvbnRpbnVlOwogICAgICAgICAgICBjb25zdCBbZ290XSA9IGlubGluZS5zcGxpY2UoaywgMSk7CiAgICAgICAgICAgIGlmIChnb3QuZ2x5cGgpIGdseXBoID0gTWF0aC5tYXgoMCwgZ2x5cGggLSAxKTsKICAgICAgICAgICAgZWxzZSBhcHBseShnb3QubWFya3MsIC0xKTsKICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICB9CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3Qgc3R5bGUgPSBTdHJpbmcoYS5zdHlsZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAoYVsnZGF0YS1nbHlwaCddIHx8IC9tc28tbGlzdFxzKjpccyppZ25vcmUvLnRlc3Qoc3R5bGUpKSB7CiAgICAgICAgICBpbmxpbmUucHVzaCh7IG5hbWUsIGdseXBoOiB0cnVlIH0pOwogICAgICAgICAgZ2x5cGgrKzsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBsZXQgZ290ID0gWy4uLklOTElORVtuYW1lXSwgLi4uc3R5bGVNYXJrcyhzdHlsZSldOwogICAgICAgIC8vIEdvb2dsZSBEb2NzIHdyYXBzIGEgd2hvbGUgcGFzdGUgaW4gPGIgc3R5bGU9ImZvbnQtd2VpZ2h0Om5vcm1hbCI-LgogICAgICAgIGlmICgvZm9udC13ZWlnaHRccyo6XHMqKG5vcm1hbHxsaWdodGVyfFsxLTVdMDApXGIvLnRlc3Qoc3R5bGUpKSBnb3QgPSBnb3QuZmlsdGVyKH",
"ggPT4geCAhPT0gJ2InKTsKICAgICAgICBpZiAoL2ZvbnQtc3R5bGVccyo6XHMqbm9ybWFsLy50ZXN0KHN0eWxlKSkgZ290ID0gZ290LmZpbHRlcih4ID0-IHggIT09ICdpJyk7CiAgICAgICAgZ290ID0gWy4uLm5ldyBTZXQoZ290KV07CiAgICAgICAgaW5saW5lLnB1c2goeyBuYW1lLCBtYXJrczogZ290IH0pOwogICAgICAgIGFwcGx5KGdvdCwgMSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gQW55dGhpbmcgZWxzZSAoaW1nLCB1LCBzdXAsIGNvZGUsIOKApik6IGl0cyB0ZXh0IGlzIGtlcHQsIHRoZSB0YWcgaXMgbm90LgogICAgfQogICAgaWYgKHRibCkgZmluaXNoVGFibGUoKTsKICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhtYXJrcykpIG1hcmtzW2tdID0gTWF0aC5tYXgoMCwgbWFya3Nba10pOwoKICAgIC8vIFRpZHkgZWFjaCBibG9jazogY29sbGFwc2UgdGhlIHdoaXRlc3BhY2UgSFRNTCB3b3VsZCBjb2xsYXBzZSwgdGhlbgogICAgLy8gdHVybiB0aGUgJm5ic3A7cyB0aGF0IGhlbGQgZGVsaWJlcmF0ZSBzcGFjZXMgYmFjayBpbnRvIHNwYWNlcy4gSW4gYQogICAgLy8gY2VsbCwgYSBsaW5lIGJyZWFrIGNvdW50cyBhcyBhbiBlbmQsIGFuZCBub25lIGlzIGxlZnQgYXQgZWl0aGVyIGVuZC4KICAgIGNvbnN0IHRpZHlSdW5zID0gcnVucyA9PiB7CiAgICAgIGlmICghcnVucy5sZW5ndGgpIHJldHVybjsKICAgICAgcnVuc1swXS50ZXh0ID0gcnVuc1swXS50ZXh0LnJlcGxhY2UoL1",
"5bIFxuXSsvLCAnJyk7CiAgICAgIHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0ID0gcnVuc1tydW5zLmxlbmd0aCAtIDFdLnRleHQucmVwbGFjZSgvWyBcbl0rJC8sICcnKTsKICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBydW5zLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgaWYgKC9bIFxuXSQvLnRlc3QocnVuc1tpIC0gMV0udGV4dCkpIHJ1bnNbaV0udGV4dCA9IHJ1bnNbaV0udGV4dC5yZXBsYWNlKC9eICsvLCAnJyk7CiAgICAgIH0KICAgICAgZm9yIChjb25zdCByIG9mIHJ1bnMpIHIudGV4dCA9IHIudGV4dC5yZXBsYWNlKC8gK1xuL2csICdcbicpLnJlcGxhY2UoL8KgL2csICcgJyk7CiAgICB9OwogICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICBpZiAoYi50eXBlID09PSAndGFibGUnKSB7CiAgICAgICAgYi5yb3dzLmZvckVhY2gociA9PiByLmZvckVhY2goYyA9PiB0aWR5UnVucyhjLnJ1bnMpKSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgY29uc3QgcnVucyA9IGIucnVuczsKICAgICAgdGlkeVJ1bnMocnVucyk7CiAgICAgIGlmIChiLndvcmRMaXN0ICYmIC9eXHMqKFxkK3xbYS16XXxbaXZ4bGNdKylbLildXHMqJC9pLnRlc3QoYi5tYXJrZXIgfHwgJycpKSBiLnR5cGUgPSAnb2wnOwogICAgICAvLyBBIGNoZWNrIGJveCBkcmF3biBhcyB0ZXh0IChtYWlsIGZyb20gZWxzZXdoZXJlLCBvciBhIGxpc3Qgd2hvc2UKICAgICAgLy8gbWFya2VycyB3ZXJlIGxvc3QpIHN0aWxsIGNvdW",
"50cyBhcyBhIGNoZWNrIGJveC4KICAgICAgaWYgKExJU1RTLmhhcyhiLnR5cGUpICYmIHJ1bnMubGVuZ3RoICYmICFiLm91cnMpIHsKICAgICAgICBjb25zdCBnID0gL14oW-KYkOKYkV0pID8vLmV4ZWMocnVuc1swXS50ZXh0KTsKICAgICAgICBpZiAoZykgewogICAgICAgICAgcnVuc1swXS50ZXh0ID0gcnVuc1swXS50ZXh0LnNsaWNlKGdbMF0ubGVuZ3RoKTsKICAgICAgICAgIGlmIChiLnR5cGUgPT09ICd1bCcpIGIudHlwZSA9ICdjaGVjayc7CiAgICAgICAgICBpZiAoYi50eXBlID09PSAnY2hlY2snKSBiLmNoZWNrZWQgPSBnWzFdID09PSBUSUNLRUQ7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICByZXR1cm4gbm9ybWFsaXNlRG9jKGJsb2Nrcyk7CiAgfQoKICAvLyDilIDilIAgTWFya2Rvd24gaW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUZXh0IGNvcGllZCBmcm9tIGEgY2hhdCBhc3Npc3RhbnQsIGEgUkVBRE1FIG9yIGEgTWFya2Rvd24gZWRpdG9yCiAgLy8gYXJyaXZlcyBhcyBwbGFpbiB0ZXh0IGZ1bGwgb2YgKipzdGFycyoqIGFuZCAiLSAiIGxpbmVzLiBUaGUgY29tbW9uCiAgLy8gcGFydCBvZiBNYXJrZG93biBiZWNvbWVzIGZvcm1hdH",
"Rpbmc7IHRoZSByZXN0IHN0YXlzIGFzIHR5cGVkLgoKICBmdW5jdGlvbiBtZElubGluZShzcmMsIG1hcmtzID0ge30pIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgcyA9IFN0cmluZyhzcmMgfHwgJycpOwogICAgbGV0IGJ1ZiA9ICcnOwogICAgY29uc3QgZmx1c2ggPSAoKSA9PiB7CiAgICAgIGlmIChidWYpIG91dC5wdXNoKHsgdGV4dDogYnVmLCAuLi5tYXJrcyB9KTsKICAgICAgYnVmID0gJyc7CiAgICB9OwogICAgY29uc3QgbmVzdGVkID0gKGlubmVyLCBleHRyYSkgPT4gewogICAgICBmbHVzaCgpOwogICAgICBvdXQucHVzaCguLi5tZElubGluZShpbm5lciwgeyAuLi5tYXJrcywgLi4uZXh0cmEgfSkpOwogICAgfTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IHJlc3QgPSBzLnNsaWNlKGkpOwogICAgICBjb25zdCBwcmV2ID0gaSA_IHNbaSAtIDFdIDogJyc7CiAgICAgIGxldCBtOwogICAgICBpZiAoKG0gPSAvXlxcKFtcXGAqX3t9W1xdKCkjK1wtLiF-fD5dKS8uZXhlYyhyZXN0KSkpIHsgYnVmICs9IG1bMV07IGkgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICgobSA9IC9eYChbXmBcbl0rKWAvLmV4ZWMocmVzdCkpKSB7IGJ1ZiArPSBtWzFdOyBpICs9IG1bMF0ubGVuZ3RoOyBjb250aW51ZTsgfQogICAgICBpZiAoKG0gPSAvXlxbKFteXF1cbl0rKVxdXChccyo8PyhbXilccz5dKyk-Pyg_OlxzKyJbXiJdKiIpP1xzKlwpLy5leGVjKH",
"Jlc3QpKSkgewogICAgICAgIGNvbnN0IGhyZWYgPSBzYWZlSHJlZihtWzJdKTsKICAgICAgICBuZXN0ZWQobVsxXSwgaHJlZiA_IHsgaHJlZiB9IDoge30pOwogICAgICAgIGkgKz0gbVswXS5sZW5ndGg7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKChtID0gL148KCg_Omh0dHBzPzpcL1wvfG1haWx0bzopW14-XHNdKyk-Ly5leGVjKHJlc3QpKSkgewogICAgICAgIGZsdXNoKCk7CiAgICAgICAgY29uc3QgaHJlZiA9IHNhZmVIcmVmKG1bMV0pOwogICAgICAgIG91dC5wdXNoKHsgdGV4dDogbVsxXS5yZXBsYWNlKC9ebWFpbHRvOi8sICcnKSwgLi4ubWFya3MsIC4uLihocmVmID8geyBocmVmIH0gOiB7fSkgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoKG0gPSAvXihcKlwqfF9fKSg_PVxTKShbXHNcU10qP1xTKVwxLy5leGVjKHJlc3QpKSAmJiAhKG1bMV0gPT09ICdfXycgJiYgL1tccHtMfVxwe059XS91LnRlc3QocHJldikpKSB7CiAgICAgICAgbmVzdGVkKG1bMl0sIHsgYjogdHJ1ZSB9KTsKICAgICAgICBpICs9IG1bMF0ubGVuZ3RoOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmICgobSA9IC9efn4oPz1cUykoW1xzXFNdKj9cUyl-fi8uZXhlYyhyZXN0KSkpIHsgbmVzdGVkKG1bMV0sIHsgczogdHJ1ZSB9KTsgaSArPSBtWzBdLmxlbmd0aDsgY29udGludWU7IH0KICAgICAgaWYgKChtID0gL15cKig_PVteXH",
"MqXSkoW1xzXFNdKj9bXlxzKl0pXCooPyFcKikvLmV4ZWMocmVzdCkpKSB7IG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7IGkgKz0gbVswXS5sZW5ndGg7IGNvbnRpbnVlOyB9CiAgICAgIGlmICghL1tccHtMfVxwe059X10vdS50ZXN0KHByZXYpICYmIChtID0gL15fKD89W15cc19dKShbXHNcU10qP1teXHNfXSlfKD8hW1xwe0x9XHB7Tn1fXSkvdS5leGVjKHJlc3QpKSkgewogICAgICAgIG5lc3RlZChtWzFdLCB7IGk6IHRydWUgfSk7CiAgICAgICAgaSArPSBtWzBdLmxlbmd0aDsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBidWYgKz0gc1tpXTsKICAgICAgaSsrOwogICAgfQogICAgZmx1c2goKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBPbmUgbGluZSBvZiBNYXJrZG93bjogd2hhdCBraW5kIG9mIGJsb2NrIGl0IGlzLCBpdHMgaW5kZW50IGFuZCB0ZXh0LgogIGZ1bmN0aW9uIG1kTGluZShsaW5lKSB7CiAgICBjb25zdCBbLCBwYWQsIHNdID0gL14oICopKC4qKSQvLmV4ZWMobGluZSk7CiAgICBjb25zdCBpbmRlbnQgPSBwYWQubGVuZ3RoOwogICAgbGV0IHg7CiAgICBpZiAoKHggPSAvXigjezEsNn0pXHMrKC4qPykoPzpccysjKyk_XHMqJC8uZXhlYyhzKSkpIHJldHVybiB7IHR5cGU6IFsnaDEnLCAnaDInLCAnaDMnXVtNYXRoLm1pbigyLCB4WzFdLmxlbmd0aCAtIDEpXSwgdGV4dDogeFsyXSB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzK1xbKFsgeFhdKVxdXHMrKC4qKSQvLmV4ZWMocy",
"kpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdICE9PSAnICcsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogICAgaWYgKCh4ID0gL14oW-KYkOKYkV0pXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB4WzFdID09PSBUSUNLRUQsIHRleHQ6IHhbMl0sIGluZGVudCB9OwogICAgaWYgKCh4ID0gL15bLSor4oCiXVxzKyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3VsJywgdGV4dDogeFsxXSwgaW5kZW50IH07CiAgICBpZiAoKHggPSAvXlxkezEsM31bLildXHMrKC4qKSQvLmV4ZWMocykpKSByZXR1cm4geyB0eXBlOiAnb2wnLCB0ZXh0OiB4WzFdLCBpbmRlbnQgfTsKICAgIGlmICgoeCA9IC9ePlxzPyguKikkLy5leGVjKHMpKSkgcmV0dXJuIHsgdHlwZTogJ3AnLCB0ZXh0OiB4WzFdLnJlcGxhY2UoL14oPlxzPykrLywgJycpIH07CiAgICByZXR1cm4geyB0eXBlOiAncCcsIHRleHQ6IHMgfTsKICB9CgogIGNvbnN0IE1EX1JVTEUgPSAvXlxzKihbLSpfXSkoXHMqXDEpezIsfVxzKiQvOwoKICBmdW5jdGlvbiBmcm9tTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgbGluZXMgPSBTdHJpbmcodGV4dCB8fCAnJykucmVwbGFjZSgvXHJcbj8vZywgJ1xuJykucmVwbGFjZSgvXHQvZywgJyAgICAnKS5zcGxpdCgnXG4nKTsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3QgaW5kZW50cyA9IFtdOyAgIC8vIHRoZSBpbmRlbnQgb2YgZWFjaCBvcGVuIG",
"xpc3QgbGV2ZWwKICAgIGxldCBmZW5jZSA9IGZhbHNlOwogICAgY29uc3QgbGFzdCA9ICgpID0-IG91dFtvdXQubGVuZ3RoIC0gMV07CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXTsKICAgICAgaWYgKC9eXHMqKGBgYHx-fn4pLy50ZXN0KGxpbmUpKSB7IGZlbmNlID0gIWZlbmNlOyBjb250aW51ZTsgfQogICAgICBpZiAoZmVuY2UpIHsgb3V0LnB1c2goYmxvY2soJ3AnLCBbeyB0ZXh0OiBsaW5lIH1dKSk7IGNvbnRpbnVlOyB9CiAgICAgIC8vIHwgYSB8IGIgfCBsaW5lcywgd2l0aCBvciB3aXRob3V0IHRoZSB8LS0tfCBsaW5lIHVuZGVyIGEgaGVhZGluZyByb3cuCiAgICAgIGNvbnN0IHQgPSBwaXBlVGFibGUobGluZXMsIGksIG1kSW5saW5lKTsKICAgICAgaWYgKHQpIHsKICAgICAgICBpbmRlbnRzLmxlbmd0aCA9IDA7CiAgICAgICAgb3V0LnB1c2godC5ibG9jayk7CiAgICAgICAgaSA9IHQuZW5kIC0gMTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoTURfUlVMRS50ZXN0KGxpbmUpKSBjb250aW51ZTsKICAgICAgLy8gT25lIGVtcHR5IGxpbmUgaXMgYSBnYXA7IG1vcmUgYXJlIG5vdCwgYW5kIG5vciBpcyBvbmUgYmVzaWRlIGEKICAgICAgLy8gaGVhZGluZywgd2hpY2ggaGFzIHNwYWNlIG9mIGl0cyBvd24uCiAgICAgIGlmICghbGluZS50cmltKCkpIHsKICAgICAgICBpZiAoIW91dC5sZW5ndGggfHwgIShmbX",
"RCbGFuayhsYXN0KCkpIHx8IEhFQURJTkdTW2xhc3QoKS50eXBlXSkpIG91dC5wdXNoKGJsb2NrKCdwJykpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IGwgPSBtZExpbmUobGluZS5yZXBsYWNlKC9ccyskLywgJycpKTsKICAgICAgaWYgKEhFQURJTkdTW2wudHlwZV0gJiYgb3V0Lmxlbmd0aCAmJiBmbXRCbGFuayhsYXN0KCkpKSBvdXQucG9wKCk7CiAgICAgIGlmIChMSVNUUy5oYXMobC50eXBlKSkgewogICAgICAgIC8vIEEgYmxhbmsgbGluZSBiZXR3ZWVuIHR3byBpdGVtcyBvZiBhIGxpc3QgaXMgbm90IGEgZ2FwIGluIGl0LgogICAgICAgIGlmIChvdXQubGVuZ3RoID4gMSAmJiBmbXRCbGFuayhsYXN0KCkpICYmIExJU1RTLmhhcyhvdXRbb3V0Lmxlbmd0aCAtIDJdLnR5cGUpKSBvdXQucG9wKCk7CiAgICAgICAgd2hpbGUgKGluZGVudHMubGVuZ3RoICYmIGwuaW5kZW50IDwgaW5kZW50c1tpbmRlbnRzLmxlbmd0aCAtIDFdKSBpbmRlbnRzLnBvcCgpOwogICAgICAgIGlmICghaW5kZW50cy5sZW5ndGggfHwgbC5pbmRlbnQgPiBpbmRlbnRzW2luZGVudHMubGVuZ3RoIC0gMV0pIGluZGVudHMucHVzaChsLmluZGVudCk7CiAgICAgICAgb3V0LnB1c2goYmxvY2sobC50eXBlLCBtZElubGluZShsLnRleHQpLCB7IGxldmVsOiBpbmRlbnRzLmxlbmd0aCAtIDEsIGNoZWNrZWQ6IGwuY2hlY2tlZCB9KSk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaW5kZW50cy5sZW5ndGggPSAwOw",
"ogICAgICBvdXQucHVzaChibG9jayhsLnR5cGUsIG1kSW5saW5lKGwudGV4dC50cmltKCkpKSk7CiAgICB9CiAgICB3aGlsZSAob3V0Lmxlbmd0aCA-IDEgJiYgZm10QmxhbmsobGFzdCgpKSkgb3V0LnBvcCgpOwogICAgd2hpbGUgKG91dC5sZW5ndGggPiAxICYmIGZtdEJsYW5rKG91dFswXSkpIG91dC5zaGlmdCgpOwogICAgcmV0dXJuIG5vcm1hbGlzZURvYyhvdXQpOwogIH0KCiAgY29uc3QgZm10QmxhbmsgPSBiID0-IGIudHlwZSA9PT0gJ3AnICYmICFiLnJ1bnMuc29tZShyID0-IHIudGV4dC50cmltKCkpOwogIGNvbnN0IGlzVGFibGUgPSBiID0-IGIudHlwZSA9PT0gJ3RhYmxlJzsKCiAgLy8gV2hldGhlciBwbGFpbiB0ZXh0IGlzIHdvcnRoIHJlYWRpbmcgYXMgTWFya2Rvd246IGEgaGVhZGluZywgbGlzdCwKICAvLyBxdW90ZSwgdGFibGUgb3IgY29kZSBsaW5lLCBvciBib2xkLCBzdHJ1Y2ssIGxpbmtlZCBvciBjb2RlIHRleHQuCiAgZnVuY3Rpb24gbG9va3NMaWtlTWFya2Rvd24odGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICAgIHJldHVybiAvXiB7MCwzfSgjezEsNn1ccytcU3xbLSor4oCiXVxzK1xTfFvimJDimJFdXHMrXFN8XGR7MSwzfVsuKV1ccytcU3w-XHN8YGBgKS9tLnRlc3QocykgfHwKICAgICAgL15ccypcfD9ccyo6Py17Myx9Oj9ccyooXHxccyo6Py17Myx9Oj9ccyopK1x8P1xzKiQvbS50ZXN0KHMpIHx8CiAgICAgIC9cKlwqW14qXG5dK1wqXCp8X19bXl9cbl0rX1",
"98fn5bXn5cbl0rfn58XFtbXlxdXG5dK1xdXChbXilcc10rXCl8YFteYFxuXStgLy50ZXN0KHMpOwogIH0KCiAgLy8g4pSA4pSAIFBhc3Rpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFdoZXRoZXIgYSBkb2N1bWVudCBoYXMgYW55dGhpbmcgcGxhaW4gdGV4dCB3b3VsZCBub3Q6IGEgaGVhZGluZywgYQogIC8vIGxpc3QsIGEgbWFyayBvciBhIGxpbmsuCiAgZnVuY3Rpb24gaGFzRm9ybWF0dGluZyhkb2MpIHsKICAgIHJldHVybiBkb2Muc29tZShiID0-IGIudHlwZSAhPT0gJ3AnIHx8IGIucnVucy5zb21lKHIgPT4gci5iIHx8IHIuaSB8fCByLnMgfHwgci5ocmVmKSk7CiAgfQoKICAvLyBXaGV0aGVyIGEgZG9jdW1lbnQgaXMgb25lIHRhYmxlIGFuZCBub3RoaW5nIGVsc2UgKGVtcHR5IGxpbmVzIGFzaWRlKToKICAvLyB3aGF0IGEgcGFzdGUgb2YgY2VsbHMgZnJvbSBhIHNwcmVhZHNoZWV0IGlzLgogIGZ1bmN0aW9uIG9ubHlUYWJsZShkb2MpIHsKICAgIGNvbnN0IGtlcHQgPSBkb2MuZmlsdGVyKGIgPT4gIWZtdEJsYW5rKGIpKTsKICAgIHJldHVybiBrZXB0Lmxlbmd0aCA9PT0gMSAmJiBpc1RhYmxlKGtlcHRbMF0pID8ga2VwdFswXSA6IG",
"51bGw7CiAgfQoKICAvLyBXaGF0IGEgcGFzdGUgYmVjb21lczogdGhlIGNsaXBib2FyZCdzIEhUTUwsIHJlYWQgbGlrZSBtYWlsOyBvciwgd2hlbgogIC8vIHRoYXQgYnJpbmdzIG5vIGZvcm1hdHRpbmcgYW5kIHRoZSB0ZXh0IGlzIE1hcmtkb3duIChmcm9tIGEgY2hhdAogIC8vIGFzc2lzdGFudCwgc2F5KSwgdGhlIE1hcmtkb3duIHJlYWQgYXMgZm9ybWF0dGluZy4gRW1wdHkgbGluZXMgYXQKICAvLyBlaXRoZXIgZW5kIGdvLiBudWxsIG1lYW5zIHRoZXJlIGlzIG5vdGhpbmcgdG8gZm9ybWF0OiB0aGUgdGV4dCBpcwogIC8vIHBhc3RlZCBhcyBpdCBpcy4KICBmdW5jdGlvbiBwYXN0ZURvYyh7IGh0bWwsIHRleHQgfSA9IHt9KSB7CiAgICBsZXQgZG9jID0gaHRtbCAmJiAvXFMvLnRlc3QoaHRtbCkgPyBwYXJzZUh0bWwoaHRtbCkgOiBudWxsOwogICAgaWYgKGRvYyAmJiBpc0VtcHR5KGRvYykpIGRvYyA9IG51bGw7CiAgICBpZiAoKCFkb2MgfHwgIWhhc0Zvcm1hdHRpbmcoZG9jKSkgJiYgbG9va3NMaWtlTWFya2Rvd24odGV4dCkpIGRvYyA9IGZyb21NYXJrZG93bih0ZXh0KTsKICAgIGlmICghZG9jKSByZXR1cm4gbnVsbDsKICAgIC8vIE9uZSBjZWxsIGNvcGllZCBvbiBpdHMgb3duIGlzIGl0cyB0ZXh0LCBub3QgYSB0YWJsZSBvZiBvbmUuCiAgICBjb25zdCBvbmUgPSBvbmx5VGFibGUoZG9jKTsKICAgIGlmIChvbmUgJiYgb25lLnJvd3MubGVuZ3RoID09PSAxICYmIG9uZS5yb3dzWzBdLmxlbmd0aCA9PT0gMSkgew",
"ogICAgICBjb25zdCBydW5zID0gb25lLnJvd3NbMF1bMF0ucnVuczsKICAgICAgY29uc3QgbGluZXMgPSBbW11dOwogICAgICBmb3IgKGNvbnN0IHIgb2YgcnVucykgewogICAgICAgIHIudGV4dC5zcGxpdCgnXG4nKS5mb3JFYWNoKChwaWVjZSwgaykgPT4gewogICAgICAgICAgaWYgKGspIGxpbmVzLnB1c2goW10pOwogICAgICAgICAgaWYgKHBpZWNlKSBsaW5lc1tsaW5lcy5sZW5ndGggLSAxXS5wdXNoKHsgLi4uciwgdGV4dDogcGllY2UgfSk7CiAgICAgICAgfSk7CiAgICAgIH0KICAgICAgZG9jID0gbm9ybWFsaXNlRG9jKGxpbmVzLm1hcChsID0-IGJsb2NrKCdwJywgbCkpKTsKICAgIH0KICAgIGxldCBpID0gMDsKICAgIGxldCBqID0gZG9jLmxlbmd0aDsKICAgIHdoaWxlIChpIDwgaiAmJiBmbXRCbGFuayhkb2NbaV0pKSBpKys7CiAgICB3aGlsZSAoaiA-IGkgJiYgZm10QmxhbmsoZG9jW2ogLSAxXSkpIGotLTsKICAgIHJldHVybiBpIDwgaiA_IGRvYy5zbGljZShpLCBqKSA6IG51bGw7CiAgfQoKICAvLyBUaGUgbm90ZSdzIGNvbnRlbnQgZnJvbSBpdHMgbWVzc2FnZSBwYXJ0czogSFRNTCB3aGVuIHRoZXJlIGlzIGFueSwKICAvLyB0aGUgcGxhaW4gdGV4dCBvdGhlcndpc2UuCiAgZnVuY3Rpb24gZG9jRnJvbVBhcnRzKHsgcGxhaW4sIGh0bWwgfSA9IHt9KSB7CiAgICBpZiAoaHRtbCAmJiBTdHJpbmcoaHRtbCkudHJpbSgpKSByZXR1cm4gcGFyc2VIdG1sKGh0bWwpOwogICAgcmV0dXJuIGZyb21QbGFpbihwbG",
"FpbiB8fCAnJyk7CiAgfQoKICAvLyDilIDilIAgTWVyZ2luZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIEEgbm90ZSBlZGl0ZWQgaGVyZSB3aGlsZSBhbm90aGVyIGNvbXB1dGVyIG9yIHBob25lIHNhdmVkIGEgbmV3ZXIKICAvLyB2ZXJzaW9uIG9mIGl0OiBib3RoIHNldHMgb2YgY2hhbmdlcywgYmxvY2sgYnkgYmxvY2suIGBiYXNlYCBpcyB0aGUKICAvLyB2ZXJzaW9uIHRoZSBlZGl0cyBoZXJlIHN0YXJ0ZWQgZnJvbSwgYG1pbmVgIHRoZSB0ZXh0IGhlcmUgbm93LCBhbmQKICAvLyBgdGhlaXJzYCB0aGUgbmV3ZXIgdmVyc2lvbi4gQSBzdHJldGNoIG9ubHkgb25lIHNpZGUgY2hhbmdlZCB0YWtlcwogIC8vIHRoYXQgc2lkZSdzIGJsb2NrczsgYSBzdHJldGNoIGJvdGggY2hhbmdlZCBrZWVwcyB0aGVpcnMgYW5kIHRoZW4KICAvLyB3aGF0ZXZlciBvZiBtaW5lIHRoZXkgZG8gbm90IGFscmVhZHkgaGF2ZSwgc28gbm90aGluZyB0eXBlZCBvbgogIC8vIGVpdGhlciBpcyBsb3N0IC0gYXQgd29yc3QgYSBwYXJhZ3JhcGggYXBwZWFycyB0d2ljZS4KCiAgY29uc3QgYmxvY2tLZXkgPSBiID0-IEpTT04uc3RyaW5naWZ5KGIpOwogIGNvbnN0IH",
"NhbWVEb2MgPSAoYSwgYikgPT4gSlNPTi5zdHJpbmdpZnkobm9ybWFsaXNlRG9jKGEpKSA9PT0gSlNPTi5zdHJpbmdpZnkobm9ybWFsaXNlRG9jKGIpKTsKCiAgLy8gVGhlIGxvbmdlc3QgY29tbW9uIHN1YnNlcXVlbmNlIG9mIHR3byBsaXN0cyBvZiBrZXlzLCBhcyBwYWlycyBvZgogIC8vIGluZGljZXMgW2kgaW4gYSwgaiBpbiBiXSwgaW4gb3JkZXIuIFRoZSBlbmRzIGJvdGggbGlzdHMgc2hhcmUgYXJlCiAgLy8gbWF0Y2hlZCBmaXJzdCwgc28gdGhlIHRhYmxlIG9ubHkgc3BhbnMgdGhlIHN0cmV0Y2ggdGhhdCBkaWZmZXJzLgogIGZ1bmN0aW9uIGNvbW1vblBhaXJzKGEsIGIpIHsKICAgIGxldCBsbyA9IDA7CiAgICB3aGlsZSAobG8gPCBhLmxlbmd0aCAmJiBsbyA8IGIubGVuZ3RoICYmIGFbbG9dID09PSBiW2xvXSkgbG8rKzsKICAgIGxldCBlYSA9IGEubGVuZ3RoOwogICAgbGV0IGViID0gYi5sZW5ndGg7CiAgICB3aGlsZSAoZWEgPiBsbyAmJiBlYiA-IGxvICYmIGFbZWEgLSAxXSA9PT0gYltlYiAtIDFdKSB7IGVhLS07IGViLS07IH0KICAgIGNvbnN0IHBhaXJzID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxvOyBpKyspIHBhaXJzLnB1c2goW2ksIGldKTsKICAgIGNvbnN0IG4gPSBlYSAtIGxvOwogICAgY29uc3QgbSA9IGViIC0gbG87CiAgICAvLyBUb28gYmlnIGEgdGFibGUgdG8gYmUgd29ydGggaXQ6IG5vIG1hdGNoZXMgaW4gdGhlIG1pZGRsZSwgd2hpY2gKICAgIC8vIG9ubHkgbWFrZXMgdGhlIG",
"1lcmdlIGtlZXAgbW9yZSBvZiBib3RoIHNpZGVzLgogICAgaWYgKG4gJiYgbSAmJiBuICogbSA8PSA0ZTYpIHsKICAgICAgY29uc3QgbGVuID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogbiArIDEgfSwgKCkgPT4gbmV3IFVpbnQzMkFycmF5KG0gKyAxKSk7CiAgICAgIGZvciAobGV0IGkgPSBuIC0gMTsgaSA-PSAwOyBpLS0pIHsKICAgICAgICBmb3IgKGxldCBqID0gbSAtIDE7IGogPj0gMDsgai0tKSB7CiAgICAgICAgICBsZW5baV1bal0gPSBhW2xvICsgaV0gPT09IGJbbG8gKyBqXSA_IGxlbltpICsgMV1baiArIDFdICsgMSA6IE1hdGgubWF4KGxlbltpICsgMV1bal0sIGxlbltpXVtqICsgMV0pOwogICAgICAgIH0KICAgICAgfQogICAgICBsZXQgaSA9IDA7CiAgICAgIGxldCBqID0gMDsKICAgICAgd2hpbGUgKGkgPCBuICYmIGogPCBtKSB7CiAgICAgICAgaWYgKGFbbG8gKyBpXSA9PT0gYltsbyArIGpdKSB7IHBhaXJzLnB1c2goW2xvICsgaSwgbG8gKyBqXSk7IGkrKzsgaisrOyB9IGVsc2UgaWYgKGxlbltpICsgMV1bal0gPj0gbGVuW2ldW2ogKyAxXSkgaSsrOyBlbHNlIGorKzsKICAgICAgfQogICAgfQogICAgZm9yIChsZXQgayA9IDA7IGsgPCBhLmxlbmd0aCAtIGVhOyBrKyspIHBhaXJzLnB1c2goW2VhICsgaywgZWIgKyBrXSk7CiAgICByZXR1cm4gcGFpcnM7CiAgfQoKICAvLyB7IGRvYywgbWFwLCBjbGVhbiB9OiB0aGUgbWVyZ2VkIGJsb2NrczsgZm9yIGVhY2ggb2YgbWluZSdzIGJsb2NrcywKICAvLyB3aG",
"VyZSBpdCBpcyBpbiB0aGVtIChzbyBhIGN1cnNvciBjYW4gc3RheSBwdXQpOyBhbmQgd2hldGhlciBubwogIC8vIHN0cmV0Y2ggd2FzIGNoYW5nZWQgb24gYm90aCBzaWRlcy4KICBmdW5jdGlvbiBtZXJnZURvY3MoYmFzZUluLCBtaW5lSW4sIHRoZWlyc0luKSB7CiAgICBjb25zdCBiYXNlID0gbm9ybWFsaXNlRG9jKGJhc2VJbik7CiAgICBjb25zdCBtaW5lID0gbm9ybWFsaXNlRG9jKG1pbmVJbik7CiAgICBjb25zdCB0aGVpcnMgPSBub3JtYWxpc2VEb2ModGhlaXJzSW4pOwogICAgY29uc3Qga2IgPSBiYXNlLm1hcChibG9ja0tleSk7CiAgICBjb25zdCBrbSA9IG1pbmUubWFwKGJsb2NrS2V5KTsKICAgIGNvbnN0IGt0ID0gdGhlaXJzLm1hcChibG9ja0tleSk7CiAgICBjb25zdCB0b01pbmUgPSBuZXcgTWFwKGNvbW1vblBhaXJzKGtiLCBrbSkpOwogICAgY29uc3QgdG9UaGVpcnMgPSBuZXcgTWFwKGNvbW1vblBhaXJzKGtiLCBrdCkpOwogICAgLy8gVGhlIGJsb2NrcyBuZWl0aGVyIHNpZGUgdG91Y2hlZCwgaW4gb3JkZXIgb24gYWxsIHRocmVlLgogICAgY29uc3QgYW5jaG9ycyA9IFtdOwogICAgbGV0IGxhc3RNID0gLTE7CiAgICBsZXQgbGFzdFQgPSAtMTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwga2IubGVuZ3RoOyBpKyspIHsKICAgICAgaWYgKCF0b01pbmUuaGFzKGkpIHx8ICF0b1RoZWlycy5oYXMoaSkpIGNvbnRpbnVlOwogICAgICBjb25zdCBtID0gdG9NaW5lLmdldChpKTsKICAgICAgY29uc3QgdCA9IH",
"RvVGhlaXJzLmdldChpKTsKICAgICAgaWYgKG0gPiBsYXN0TSAmJiB0ID4gbGFzdFQpIHsgYW5jaG9ycy5wdXNoKGkpOyBsYXN0TSA9IG07IGxhc3RUID0gdDsgfQogICAgfQogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBtYXAgPSBuZXcgQXJyYXkobWluZS5sZW5ndGgpLmZpbGwoLTEpOwogICAgbGV0IGNsZWFuID0gdHJ1ZTsKICAgIGNvbnN0IHNhbWUgPSAoeCwgeSkgPT4geC5sZW5ndGggPT09IHkubGVuZ3RoICYmIHguZXZlcnkoKHYsIGspID0-IHYgPT09IHlba10pOwogICAgbGV0IGIwID0gMDsKICAgIGxldCBtMCA9IDA7CiAgICBsZXQgdDAgPSAwOwogICAgZm9yIChjb25zdCBhIG9mIGFuY2hvcnMuY29uY2F0KFtrYi5sZW5ndGhdKSkgewogICAgICBjb25zdCBtMSA9IGEgPCBrYi5sZW5ndGggPyB0b01pbmUuZ2V0KGEpIDoga20ubGVuZ3RoOwogICAgICBjb25zdCB0MSA9IGEgPCBrYi5sZW5ndGggPyB0b1RoZWlycy5nZXQoYSkgOiBrdC5sZW5ndGg7CiAgICAgIGNvbnN0IEIgPSBrYi5zbGljZShiMCwgYSk7CiAgICAgIGNvbnN0IE0gPSBrbS5zbGljZShtMCwgbTEpOwogICAgICBjb25zdCBUID0ga3Quc2xpY2UodDAsIHQxKTsKICAgICAgY29uc3Qgc3RhcnQgPSBvdXQubGVuZ3RoOwogICAgICBpZiAoc2FtZShNLCBCKSAmJiAhc2FtZShULCBCKSkgewogICAgICAgIC8vIE9ubHkgdGhleSBjaGFuZ2VkIHRoaXMgc3RyZXRjaC4KICAgICAgICBmb3IgKGxldCBrID0gdDA7IGsgPCB0MTsgaysrKSBvdX",
"QucHVzaCh0aGVpcnNba10pOwogICAgICAgIGZvciAobGV0IGsgPSBtMDsgayA8IG0xOyBrKyspIG1hcFtrXSA9IE1hdGgubWluKHN0YXJ0ICsgKGsgLSBtMCksIE1hdGgubWF4KHN0YXJ0LCBvdXQubGVuZ3RoIC0gMSkpOwogICAgICB9IGVsc2UgaWYgKHNhbWUoVCwgQikgfHwgc2FtZShNLCBUKSkgewogICAgICAgIC8vIE9ubHkgdGhpcyBzaWRlIGNoYW5nZWQgaXQsIG9yIGJvdGggdGhlIHNhbWUgd2F5LgogICAgICAgIGZvciAobGV0IGsgPSBtMDsgayA8IG0xOyBrKyspIHsgbWFwW2tdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVtrXSk7IH0KICAgICAgfSBlbHNlIGlmIChCLmxlbmd0aCAmJiBNLmxlbmd0aCA9PT0gQi5sZW5ndGggJiYgVC5sZW5ndGggPT09IEIubGVuZ3RoKSB7CiAgICAgICAgLy8gQXMgbWFueSBibG9ja3Mgb24gZWFjaCBzaWRlOiBibG9jayBieSBibG9jaywgZWFjaCBzaWRlJ3MgY2hhbmdlCiAgICAgICAgLy8gd2hlcmUgb25seSBpdCBjaGFuZ2VkIG9uZSwgYm90aCB3aGVyZSBib3RoIGNoYW5nZWQgdGhlIHNhbWUgb25lLgogICAgICAgIGZvciAobGV0IGsgPSAwOyBrIDwgQi5sZW5ndGg7IGsrKykgewogICAgICAgICAgY29uc3QgW2IsIG1tLCB0dF0gPSBbQltrXSwgTVtrXSwgVFtrXV07CiAgICAgICAgICBpZiAobW0gPT09IGIpIHsgbWFwW20wICsga10gPSBvdXQubGVuZ3RoOyBvdXQucHVzaCh0aGVpcnNbdDAgKyBrXSk7IH0gZWxzZSBpZiAodHQgPT09IGIgfHwgdHQgPT09IG1tKS",
"B7IG1hcFttMCArIGtdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVttMCArIGtdKTsgfSBlbHNlIHsKICAgICAgICAgICAgY2xlYW4gPSBmYWxzZTsKICAgICAgICAgICAgb3V0LnB1c2godGhlaXJzW3QwICsga10pOwogICAgICAgICAgICBtYXBbbTAgKyBrXSA9IG91dC5sZW5ndGg7CiAgICAgICAgICAgIG91dC5wdXNoKG1pbmVbbTAgKyBrXSk7CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9IGVsc2UgaWYgKEIubGVuZ3RoICYmIChzYW1lKFQuc2xpY2UoMCwgQi5sZW5ndGgpLCBCKSB8fCBzYW1lKFQuc2xpY2UoVC5sZW5ndGggLSBCLmxlbmd0aCksIEIpKSkgewogICAgICAgIC8vIFRoZXkgb25seSBhZGRlZCBiZWZvcmUgb3IgYWZ0ZXIgaXQsIGFuZCB0aGlzIHNpZGUgY2hhbmdlZCBpdC4KICAgICAgICBjb25zdCBhZnRlciA9IHNhbWUoVC5zbGljZSgwLCBCLmxlbmd0aCksIEIpOwogICAgICAgIGlmICghYWZ0ZXIpIGZvciAobGV0IGsgPSB0MDsgayA8IHQxIC0gQi5sZW5ndGg7IGsrKykgb3V0LnB1c2godGhlaXJzW2tdKTsKICAgICAgICBmb3IgKGxldCBrID0gbTA7IGsgPCBtMTsgaysrKSB7IG1hcFtrXSA9IG91dC5sZW5ndGg7IG91dC5wdXNoKG1pbmVba10pOyB9CiAgICAgICAgaWYgKGFmdGVyKSBmb3IgKGxldCBrID0gdDAgKyBCLmxlbmd0aDsgayA8IHQxOyBrKyspIG91dC5wdXNoKHRoZWlyc1trXSk7CiAgICAgIH0gZWxzZSBpZiAoQi5sZW5ndGggJiYgKHNhbWUoTS5zbGljZSgwLCBCLmxlbm",
"d0aCksIEIpIHx8IHNhbWUoTS5zbGljZShNLmxlbmd0aCAtIEIubGVuZ3RoKSwgQikpKSB7CiAgICAgICAgLy8gVGhpcyBzaWRlIG9ubHkgYWRkZWQgYmVmb3JlIG9yIGFmdGVyIGl0LCBhbmQgdGhleSBjaGFuZ2VkIGl0LgogICAgICAgIGNvbnN0IGFmdGVyID0gc2FtZShNLnNsaWNlKDAsIEIubGVuZ3RoKSwgQik7CiAgICAgICAgaWYgKCFhZnRlcikgZm9yIChsZXQgayA9IG0wOyBrIDwgbTEgLSBCLmxlbmd0aDsgaysrKSB7IG1hcFtrXSA9IG91dC5sZW5ndGg7IG91dC5wdXNoKG1pbmVba10pOyB9CiAgICAgICAgY29uc3QgdGhlaXJzQXQgPSBvdXQubGVuZ3RoOwogICAgICAgIGZvciAobGV0IGsgPSB0MDsgayA8IHQxOyBrKyspIG91dC5wdXNoKHRoZWlyc1trXSk7CiAgICAgICAgY29uc3Qga2VwdCA9IGFmdGVyID8gW20wLCBtMCArIEIubGVuZ3RoXSA6IFttMSAtIEIubGVuZ3RoLCBtMV07CiAgICAgICAgZm9yIChsZXQgayA9IGtlcHRbMF07IGsgPCBrZXB0WzFdOyBrKyspIG1hcFtrXSA9IE1hdGgubWluKHRoZWlyc0F0ICsgKGsgLSBrZXB0WzBdKSwgTWF0aC5tYXgodGhlaXJzQXQsIG91dC5sZW5ndGggLSAxKSk7CiAgICAgICAgaWYgKGFmdGVyKSBmb3IgKGxldCBrID0gbTAgKyBCLmxlbmd0aDsgayA8IG0xOyBrKyspIHsgbWFwW2tdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVtrXSk7IH0KICAgICAgfSBlbHNlIHsKICAgICAgICAvLyBCb3RoIGNoYW5nZWQgaXQ6IHRoZWlycywgdGhlbiB3aGF0IG9mIG",
"1pbmUgaXMgbmV3IHRvIGl0LgogICAgICAgIGNsZWFuID0gZmFsc2U7CiAgICAgICAgZm9yIChsZXQgayA9IHQwOyBrIDwgdDE7IGsrKykgb3V0LnB1c2godGhlaXJzW2tdKTsKICAgICAgICBmb3IgKGxldCBrID0gbTA7IGsgPCBtMTsgaysrKSB7CiAgICAgICAgICBjb25zdCB0aGVyZSA9IFQuaW5kZXhPZihrbVtrXSk7CiAgICAgICAgICBpZiAodGhlcmUgPj0gMCkgbWFwW2tdID0gc3RhcnQgKyB0aGVyZTsKICAgICAgICAgIGVsc2UgeyBtYXBba10gPSBvdXQubGVuZ3RoOyBvdXQucHVzaChtaW5lW2tdKTsgfQogICAgICAgIH0KICAgICAgfQogICAgICBpZiAoYSA8IGtiLmxlbmd0aCkgeyBtYXBbbTFdID0gb3V0Lmxlbmd0aDsgb3V0LnB1c2gobWluZVttMV0pOyB9CiAgICAgIGIwID0gYSArIDE7CiAgICAgIG0wID0gbTEgKyAxOwogICAgICB0MCA9IHQxICsgMTsKICAgIH0KICAgIGlmICghb3V0Lmxlbmd0aCkgb3V0LnB1c2goYmxvY2soJ3AnKSk7CiAgICBmb3IgKGxldCBrID0gMDsgayA8IG1hcC5sZW5ndGg7IGsrKykgbWFwW2tdID0gTWF0aC5tYXgoMCwgTWF0aC5taW4ob3V0Lmxlbmd0aCAtIDEsIG1hcFtrXSkpOwogICAgcmV0dXJuIHsgZG9jOiBvdXQsIG1hcCwgY2xlYW4gfTsKICB9CgogIGNvbnN0IGFwaSA9IHsKICAgIFRZUEVTLCBMSVNUUywgTUFYX0xFVkVMLAogICAgYmxvY2ssIGVtcHR5RG9jLCBub3JtYWxpc2VSdW5zLCBub3JtYWxpc2VEb2MsIGRvY1RleHQsIGlzRW1wdHksIHNhZmVIcmVmLAogIC",
"AgdG9IdG1sLCB0b1BsYWluLCBmcm9tUGxhaW4sIHBhcnNlSHRtbCwgZG9jRnJvbVBhcnRzLCBmcm9tTWFya2Rvd24sIGxvb2tzTGlrZU1hcmtkb3duLCBoYXNGb3JtYXR0aW5nLCBwYXN0ZURvYywKICAgIG1lcmdlRG9jcywgc2FtZURvYywgdGFibGUsIG9ubHlUYWJsZSwgdGFibGVUZXh0LCBNQVhfQ09MUywgTUFYX1JPV1MsCiAgfTsKCiAgbnMubm90ZUZvcm1hdCA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/lib/search-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFNlYXJjaCBoaWdobGlnaHRpbmcgKHB1cmUpCi8vCi8vIEdtYWlsIGRvZXMgdGhlIHNlYXJjaGluZzsgdGhpcyBvbmx5IHNob3dzIHdoZXJlIHRoZSB3b3JkcyBhcmUuIEl0IHRha2VzCi8vIHRoZSB3b3JkcyBvdXQgb2YgYSBHbWFpbCBxdWVyeSAtIGxlYXZpbmcgb3V0IG9wZXJhdG9ycyBzdWNoIGFzIGZyb206IG9yCi8vIGJlZm9yZTosIGFuZCBhbnl0aGluZyBleGNsdWRlZCB3aXRo",
"IGEgbWludXMgLSBhbmQgZmluZHMgdGhlbSBpbiBhCi8vIG5vdGUncyB0ZXh0IHRoZSB3YXkgYSBwZXJzb24gd291bGQgcmVhZCBhIG1hdGNoOiBpZ25vcmluZyBjYXNlIGFuZAovLyBhY2NlbnRzICgiY2FmZSIgZmluZHMgIkNhZsOpIiksIGF0IHRoZSBzdGFydCBvZiBhIHdvcmQgKCJnbG9zcyIgZmluZHMKLy8gImdsb3NzYXJ5Iiwgbm90ICJ4Z2xvc3MiKSwgYW5kIHBocmFzZXMgaW4gcXVvdGVzIGFzIHBocmFzZXMuCi8vCi8vIEZyb20gdGhvc2UgbWF0Y2hlcyBjb21lIHRoZSBleGNlcnB0cyBzaG93biBpbiB0aGUgcmVzdWx0cyBsaXN0LCB3aXRoCi8vIHRoZWlyIG9mZnNldHMsIHNvIHRoZSBsaXN0IGNhbiBtYXJrIHRoZW0gd2l0aG91dCBwYXJzaW5nIGFueSBIVE1MLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKCiAgLy8gT3BlcmF0b3JzIHdob3NlIHZhbHVlIGlzIGEgd29yZCB0byBsb29rIGZvciBpbiB0aGUgbm90ZSBpdHNlbGYu",
"CiAgY29uc3QgVEVYVF9PUFMgPSBuZXcgU2V0KFsnc3ViamVjdCcsICdpbnRpdGxlJ10pOwogIGNvbnN0IEtFWVdPUkRTID0gbmV3IFNldChbJ29yJywgJ2FuZCcsICdhcm91bmQnXSk7CgogIC8vIOKUgOKUgCBUaGUgd29yZHMgaW4gYSBxdWVyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmV0dXJucyBbeyB3b3JkczogWydzdGVudCcsICdjb2F0aW5nJ10gfSwg4oCmXTogb25lIGVudHJ5IHBlciB0ZXJtLCBhCiAgLy8gcGhyYXNlIGJlaW5nIHNldmVyYWwgd29yZHMgaW4gYSByb3cuCiAgZnVuY3Rpb24gcXVlcnlUZXJtcyhxdWVyeSkgewogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3QgYWRkID0gdGV4dCA9PiB7CiAgICAgIGNvbnN0IHdvcmRzID0gU3RyaW5nKHRleHQpLnNwbGl0KC9bXHMiKClbXF17fTw-XSsvKS5tYXAodyA9PiB3LnJlcGxhY2UoL15bXlxwe0x9XHB7Tn1dK3xbXlxwe0x9XHB7Tn1dKyQvZ3UsICcnKSkuZmlsdGVyKEJvb2xlYW4pOwogICAgICBpZiAoIXdvcmRzLmxlbmd0aCkgcmV0dXJuOwogICAgICBpZiAod29yZHMubGVuZ3RoID09PSAxICYmIHdvcmRzWzBdLmxlbmd0aCA8IDIgJiYgL15bXHB7TH1ccHtOfV0kL3UudGVzdCh3b3Jk",
"c1swXSkgJiYgL1thLXowLTldL2kudGVzdCh3b3Jkc1swXSkpIHJldHVybjsKICAgICAgY29uc3Qga2V5ID0gd29yZHMuam9pbignICcpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm47CiAgICAgIHNlZW4uYWRkKGtleSk7CiAgICAgIG91dC5wdXNoKHsgd29yZHMgfSk7CiAgICB9OwogICAgY29uc3QgdG9rZW5zID0gU3RyaW5nKHF1ZXJ5IHx8ICcnKS5tYXRjaCgvLT9bXHB7TH1ccHtOfV9dKzpcKFteKV0qXCl8LT9bXHB7TH1ccHtOfV9dKzoiW14iXSoifC0_IlteIl0qInxcUysvZ3UpIHx8IFtdOwogICAgZm9yIChjb25zdCByYXcgb2YgdG9rZW5zKSB7CiAgICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnLScpKSBjb250aW51ZTsgLy8gZXhjbHVkZWQ6IG5vdCBpbiB0aGUgbm90ZQogICAgICBjb25zdCBvcCA9IC9eKFtccHtMfVxwe059X10rKTooLiopJC91LmV4ZWMocmF3KTsKICAgICAgaWYgKG9wKSB7CiAgICAgICAgaWYgKFRFWFRfT1BTLmhhcyhvcFsxXS50b0xvd2VyQ2FzZSgpKSkgewogICAgICAgICAgY29uc3QgdiA9IG9wWzJdLnJlcGxhY2UoL15bKCJdfFspIl0kL2csICcnKTsKICAgICAgICAgIGlmICgvXlwoLy50ZXN0KG9wWzJdKSkgdi5zcGxpdCgvXHMrLykuZm9yRWFjaChhZGQpOwogICAgICAgICAgZWxzZSBhZGQodik7CiAgICAgICAgfQogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnIicpKSB7IGFkZChyYXcucmVwbGFj",
"ZSgvIi9nLCAnJykpOyBjb250aW51ZTsgfQogICAgICBjb25zdCB3b3JkID0gcmF3LnJlcGxhY2UoL15bKygpe31dK3xbKCl7fV0rJC9nLCAnJyk7CiAgICAgIGlmIChLRVlXT1JEUy5oYXMod29yZC50b0xvd2VyQ2FzZSgpKSkgY29udGludWU7CiAgICAgIGFkZCh3b3JkKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgRmluZGluZyB0aGVtIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBMb3dlciBjYXNlLCBhY2NlbnRzIG9mZiAtIG9uZSBjaGFyYWN0ZXIgYXQgYSB0aW1lLCB3aXRoIGEgbWFwIGJhY2sgdG8KICAvLyB3aGVyZSBlYWNoIGZvbGRlZCBjaGFyYWN0ZXIgY2FtZSBmcm9tLCBzbyBhIG1hdGNoIGluIHRoZSBmb2xkZWQgdGV4dAogIC8vIGlzIGEgbWF0Y2ggYXQga25vd24gb2Zmc2V0cyBpbiB0aGUgcmVhbCBvbmUuCiAgZnVuY3Rpb24gZm9sZCh0ZXh0KSB7CiAgICBsZXQgZm9sZGVkID0gJyc7CiAgICBjb25zdCBtYXAgPSBbXTsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHMubGVuZ3RoOykgewogICAgICBjb25zdCBjcCA9IHMuY29kZVBvaW50QXQoaSk7CiAgICAgIGNvbnN0",
"IGNoID0gU3RyaW5nLmZyb21Db2RlUG9pbnQoY3ApOwogICAgICBjb25zdCBmID0gY2gubm9ybWFsaXplKCdORkQnKS5yZXBsYWNlKC9ccHtNfSsvZ3UsICcnKS50b0xvd2VyQ2FzZSgpOwogICAgICBmb3IgKGxldCBrID0gMDsgayA8IGYubGVuZ3RoOyBrKyspIG1hcC5wdXNoKGkpOwogICAgICBmb2xkZWQgKz0gZjsKICAgICAgaSArPSBjaC5sZW5ndGg7CiAgICB9CiAgICBtYXAucHVzaChzLmxlbmd0aCk7CiAgICByZXR1cm4geyBmb2xkZWQsIG1hcCB9OwogIH0KCiAgY29uc3QgZXNjYXBlUmUgPSBzID0-IHMucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xdXFxdL2csICdcXCQmJyk7CgogIC8vIEV2ZXJ5IHBsYWNlIHRoZSB0ZXJtcyBvY2N1ciwgYXMgW3N0YXJ0LCBlbmQpIG9mZnNldHMgaW50byBgdGV4dGAsCiAgLy8gaW4gb3JkZXIsIHdpdGggb3ZlcmxhcHMgbWVyZ2VkLgogIGZ1bmN0aW9uIGZpbmRNYXRjaGVzKHRleHQsIHRlcm1zKSB7CiAgICBpZiAoIXRlcm1zIHx8ICF0ZXJtcy5sZW5ndGggfHwgIXRleHQpIHJldHVybiBbXTsKICAgIGNvbnN0IHsgZm9sZGVkLCBtYXAgfSA9IGZvbGQodGV4dCk7CiAgICBjb25zdCBmb3VuZCA9IFtdOwogICAgZm9yIChjb25zdCB0IG9mIHRlcm1zKSB7CiAgICAgIGNvbnN0IHBhdHRlcm4gPSB0LndvcmRzLm1hcCh3ID0-IGVzY2FwZVJlKGZvbGQodykuZm9sZGVkKSkuam9pbignW1xcc1xcdTAwYTBdKycpOwogICAgICBpZiAoIXBhdHRlcm4pIGNvbnRpbnVlOwogICAgICBjb25z",
"dCByZSA9IG5ldyBSZWdFeHAoYCg_PCFbXFxwe0x9XFxwe059XSkke3BhdHRlcm59YCwgJ2d1Jyk7CiAgICAgIGxldCBtOwogICAgICB3aGlsZSAoKG0gPSByZS5leGVjKGZvbGRlZCkpKSB7CiAgICAgICAgZm91bmQucHVzaChbbWFwW20uaW5kZXhdLCBtYXBbbS5pbmRleCArIG1bMF0ubGVuZ3RoXV0pOwogICAgICAgIGlmIChtWzBdLmxlbmd0aCA9PT0gMCkgcmUubGFzdEluZGV4Kys7CiAgICAgIH0KICAgIH0KICAgIGZvdW5kLnNvcnQoKGEsIGIpID0-IGFbMF0gLSBiWzBdIHx8IGFbMV0gLSBiWzFdKTsKICAgIGNvbnN0IG1lcmdlZCA9IFtdOwogICAgZm9yIChjb25zdCBbcywgZV0gb2YgZm91bmQpIHsKICAgICAgY29uc3QgbGFzdCA9IG1lcmdlZFttZXJnZWQubGVuZ3RoIC0gMV07CiAgICAgIGlmIChsYXN0ICYmIHMgPD0gbGFzdC5lbmQpIGxhc3QuZW5kID0gTWF0aC5tYXgobGFzdC5lbmQsIGUpOwogICAgICBlbHNlIG1lcmdlZC5wdXNoKHsgc3RhcnQ6IHMsIGVuZDogZSB9KTsKICAgIH0KICAgIHJldHVybiBtZXJnZWQ7CiAgfQoKICAvLyDilIDilIAgRXhjZXJwdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFVwIHRvIGBtYXhgIHN0cmV0",
"Y2hlcyBvZiB0ZXh0IGFyb3VuZCB0aGUgbWF0Y2hlcywgZWFjaCB3aXRoIHRoZQogIC8vIG1hdGNoZXMgaW5zaWRlIGl0IGF0IG9mZnNldHMgcmVsYXRpdmUgdG8gdGhlIHN0cmV0Y2guIFN0cmV0Y2hlcyBzdGFydAogIC8vIGFuZCBlbmQgb24gYSBzcGFjZSB3aGVyZSBvbmUgaXMgbmVhciwgYW5kIHNheSB3aGV0aGVyIHRleHQgd2FzIGN1dC4KICBmdW5jdGlvbiBleGNlcnB0cyh0ZXh0LCBtYXRjaGVzLCB7IGNvbnRleHQgPSA1MCwgbWF4ID0gMyB9ID0ge30pIHsKICAgIGNvbnN0IHMgPSBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBpID0gMDsKICAgIHdoaWxlIChpIDwgbWF0Y2hlcy5sZW5ndGggJiYgb3V0Lmxlbmd0aCA8IG1heCkgewogICAgICBsZXQgc3RhcnQgPSBNYXRoLm1heCgwLCBtYXRjaGVzW2ldLnN0YXJ0IC0gY29udGV4dCk7CiAgICAgIGxldCBlbmQgPSBNYXRoLm1pbihzLmxlbmd0aCwgbWF0Y2hlc1tpXS5lbmQgKyBjb250ZXh0KTsKICAgICAgLy8gTWF0Y2hlcyBjbG9zZSBlbm91Z2ggc2hhcmUgYW4gZXhjZXJwdC4KICAgICAgbGV0IGogPSBpICsgMTsKICAgICAgd2hpbGUgKGogPCBtYXRjaGVzLmxlbmd0aCAmJiBtYXRjaGVzW2pdLnN0YXJ0IDwgZW5kKSB7CiAgICAgICAgZW5kID0gTWF0aC5taW4ocy5sZW5ndGgsIE1hdGgubWF4KGVuZCwgbWF0Y2hlc1tqXS5lbmQgKyBNYXRoLmZsb29yKGNvbnRleHQgLyAyKSkpOwogICAgICAgIGorKzsKICAgICAgfQog",
"ICAgICBpZiAoc3RhcnQgPiAwKSB7CiAgICAgICAgY29uc3Qgc3AgPSBzLnNsaWNlKHN0YXJ0LCBtYXRjaGVzW2ldLnN0YXJ0KS5zZWFyY2goL1xzLyk7CiAgICAgICAgaWYgKHNwID49IDApIHN0YXJ0ICs9IHNwICsgMTsKICAgICAgfQogICAgICBpZiAoZW5kIDwgcy5sZW5ndGgpIHsKICAgICAgICBjb25zdCB0YWlsID0gcy5zbGljZShtYXRjaGVzW2ogLSAxXS5lbmQsIGVuZCk7CiAgICAgICAgY29uc3Qgc3AgPSB0YWlsLnNlYXJjaCgvXHNcUyokLyk7CiAgICAgICAgaWYgKHNwID4gMCkgZW5kID0gbWF0Y2hlc1tqIC0gMV0uZW5kICsgc3A7CiAgICAgIH0KICAgICAgb3V0LnB1c2goewogICAgICAgIHRleHQ6IHMuc2xpY2Uoc3RhcnQsIGVuZCkucmVwbGFjZSgvXHMvZywgJyAnKSwKICAgICAgICBtYXJrczogbWF0Y2hlcy5zbGljZShpLCBqKS5tYXAobSA9PiAoeyBzdGFydDogTWF0aC5tYXgobS5zdGFydCwgc3RhcnQpIC0gc3RhcnQsIGVuZDogTWF0aC5taW4obS5lbmQsIGVuZCkgLSBzdGFydCB9KSksCiAgICAgICAgY3V0QmVmb3JlOiBzdGFydCA-IDAsCiAgICAgICAgY3V0QWZ0ZXI6IGVuZCA8IHMubGVuZ3RoLAogICAgICB9KTsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgY29uc3QgYXBpID0geyBxdWVyeVRlcm1zLCBmb2xkLCBmaW5kTWF0Y2hlcywgZXhjZXJwdHMgfTsKCiAgbnMuc2VhcmNoTG9naWMgPSBhcGk7CiAgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYm",
"IG1vZHVsZS5leHBvcnRzKSBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKfSkoKTsK\"],[\"src/lib/board-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIEJvYXJkIGxvZ2ljIChwdXJlKQovLwovLyBUaGUgYm9hcmQgaGFzIG5vIGRhdGEgb2YgaXRzIG93bi4gQSBjYXJkIGlzIGEgR21haWwgdGhyZWFkLCBhIGNvbHVtbiBpcwovLyBhIEdtYWlsIGxhYmVsLCBhbmQgdGhlIG9ubHkgdGhpbmdzIHN0b3JlZCBvdXRzaWRlIEdtYWlsIGFyZSB0aGUgb3JkZXIgb2YKLy8gY2FyZHMgd2l0aGluIGEgY29sdW1uIGFuZCB0aGUgdXNlcidzIG93biBlZGl0cyB0byBhIGNhcmQuIEV2ZXJ5dGhpbmcKLy8gaGVyZSBpcyB0aGUgYXJpdGhtZXRpYyBiZXR3ZWVuIHRob3NlOiB3aGljaCBsYWJlbHMgYSBtb3ZlIGFkZHMgYW5kCi8vIHJlbW92ZXMsIHdoZXJlIGEgdGhyZWFkIHNob3dzIHVwIHdoZW4gaXQgY2FycmllcyB0d28gY29sdW1uIGxhYmVscywgaG93Ci8vIGEgc2F2ZWQgb3JkZXIgbWVldHMgYSBmcmVzaCB0aHJlYWQgbGlzdCwgYW5kIHdoYXQgYW4gZWRpdCBsb29rcyBsaWtlLgovLyDilI",
"DilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB1dGlsID0gKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSA_IHJlcXVpcmUoJy4vdXRpbC5qcycpIDogbnMudXRpbDsKCiAgLy8g4pSA4pSAIENvbHVtbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRoZSBsZWFkaW5nIHVuZGVyc2NvcmUgc29ydHMgdGhlIGJvYXJkJ3MgbGFiZWxzIGFib3ZlIGV2ZXJ5dGhpbmcgZWxzZQogIC8vIGluIEdtYWlsJ3MgbG9uZywgYWxwaGFiZXRpY2FsIGxhYmVsIGxpc3QgLSBvbiB0aGUgcGhvbmUgZXNwZWNpYWxseS4KICBjb25zdCBERUZBVUxUX1",
"JPT1QgPSAnX0JvYXJkJzsKCiAgLy8gRG9uZSBhcmNoaXZlcyBvbiBkcm9wIGJlY2F1c2UgdGhhdCBpcyB3aGF0IGZpbmlzaGluZyBzb21ldGhpbmcgaW4KICAvLyBHbWFpbCB1c3VhbGx5IG1lYW5zOiBvdXQgb2YgdGhlIEluYm94LCBzdGlsbCBmaW5kYWJsZSB1bmRlciBpdHMgbGFiZWwuCiAgLy8gQW5kIGl0IGNoaW1lcywgYSBzbWFsbCByZXdhcmQgZm9yIGZpbmlzaGluZyBzb21ldGhpbmcuCiAgY29uc3QgREVGQVVMVF9DT0xVTU5TID0gWwogICAgeyBpZDogJ3RvZG8nLCB0aXRsZTogJ1RvIGRvJywgbGFiZWw6IGAke0RFRkFVTFRfUk9PVH0vVG8gZG9gLCBhcmNoaXZlT25Ecm9wOiBmYWxzZSwgY2hpbWU6IGZhbHNlIH0sCiAgICB7IGlkOiAnZG9pbmcnLCB0aXRsZTogJ0RvaW5nJywgbGFiZWw6IGAke0RFRkFVTFRfUk9PVH0vRG9pbmdgLCBhcmNoaXZlT25Ecm9wOiBmYWxzZSwgY2hpbWU6IGZhbHNlIH0sCiAgICB7IGlkOiAnd2FpdGluZycsIHRpdGxlOiAnV2FpdGluZycsIGxhYmVsOiBgJHtERUZBVUxUX1JPT1R9L1dhaXRpbmdgLCBhcmNoaXZlT25Ecm9wOiBmYWxzZSwgY2hpbWU6IGZhbHNlIH0sCiAgICB7IGlkOiAnZG9uZScsIHRpdGxlOiAnRG9uZScsIGxhYmVsOiBgJHtERUZBVUxUX1JPT1R9L0RvbmVgLCBhcmNoaXZlT25Ecm9wOiB0cnVlLCBjaGltZTogdHJ1ZSB9LAogIF07CgogIGZ1bmN0aW9uIGRlZmF1bHRDb2x1bW5zKCkgewogICAgcmV0dXJuIERFRkFVTFRfQ09MVU1OUy5tYXAoYyA9PiAoeyAuLi",
"5jIH0pKTsKICB9CgogIC8vIHN0b3JhZ2Uuc3luYyBjYW4gaG9sZCBhbnl0aGluZyBhbiBvbGRlciB2ZXJzaW9uIC0gb3IgYSBoYW5kIGVkaXQgLQogIC8vIHB1dCB0aGVyZS4gQW55dGhpbmcgdW51c2FibGUgZmFsbHMgYmFjayB0byB0aGUgZGVmYXVsdHMgcmF0aGVyIHRoYW4KICAvLyBsZWF2aW5nIGFuIGVtcHR5IGJvYXJkIHdpdGggbm8gb2J2aW91cyB3YXkgYmFjay4KICBmdW5jdGlvbiBub3JtYWxpc2VDb2x1bW5zKHJhdykgewogICAgaWYgKCFBcnJheS5pc0FycmF5KHJhdykpIHJldHVybiBkZWZhdWx0Q29sdW1ucygpOwogICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoKTsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgZm9yIChjb25zdCBjIG9mIHJhdykgewogICAgICBpZiAoIWMgfHwgdHlwZW9mIGMgIT09ICdvYmplY3QnKSBjb250aW51ZTsKICAgICAgY29uc3QgaWQgPSBTdHJpbmcoYy5pZCB8fCAnJykudHJpbSgpOwogICAgICBjb25zdCBsYWJlbCA9IFN0cmluZyhjLmxhYmVsIHx8ICcnKS50cmltKCk7CiAgICAgIGlmICghaWQgfHwgIWxhYmVsIHx8IHNlZW4uaGFzKGlkKSkgY29udGludWU7CiAgICAgIHNlZW4uYWRkKGlkKTsKICAgICAgY29uc3QgY29sID0gewogICAgICAgIGlkLAogICAgICAgIHRpdGxlOiBTdHJpbmcoYy50aXRsZSB8fCAnJykudHJpbSgpIHx8IGxhYmVsLnNwbGl0KCcvJykucG9wKCksCiAgICAgICAgbGFiZWwsCiAgICAgICAgYXJjaGl2ZU9uRHJvcDogISFjLmFyY2hpdmVPbkRyb3AsCi",
"AgICAgICAgLy8gU2F2ZWQgYmVmb3JlIGNvbHVtbnMgY291bGQgY2hpbWU6IHRoZSBvbmUgdGhhdCBhcmNoaXZlcyBpcyB3aGVyZQogICAgICAgIC8vIGZpbmlzaGVkIHdvcmsgZ29lcywgc28gdGhhdCBvbmUgZG9lcy4KICAgICAgICBjaGltZTogdHlwZW9mIGMuY2hpbWUgPT09ICdib29sZWFuJyA_IGMuY2hpbWUgOiAhIWMuYXJjaGl2ZU9uRHJvcCwKICAgICAgfTsKICAgICAgaWYgKGMubGFiZWxJZCAmJiB0eXBlb2YgYy5sYWJlbElkID09PSAnc3RyaW5nJykgY29sLmxhYmVsSWQgPSBjLmxhYmVsSWQ7CiAgICAgIG91dC5wdXNoKGNvbCk7CiAgICB9CiAgICByZXR1cm4gb3V0Lmxlbmd0aCA_IG91dCA6IGRlZmF1bHRDb2x1bW5zKCk7CiAgfQoKICAvLyBXaGVyZSBhIG5ldyBjb2x1bW4ncyBsYWJlbCBnb2VzOiB1bmRlciB0aGUgcGFyZW50IHRoZSBleGlzdGluZyBjb2x1bW5zCiAgLy8gc2hhcmUsIHNvIGEgYm9hcmQgbW92ZWQgdG8gIl9Cb2FyZC_igKYiIGtlZXBzIGdyb3dpbmcgdGhlcmUgcmF0aGVyIHRoYW4KICAvLyBxdWlldGx5IHJlY3JlYXRpbmcgdGhlIG9sZCAiQm9hcmQiIHBhcmVudC4KICBmdW5jdGlvbiBsYWJlbFJvb3QoY29sdW1ucykgewogICAgY29uc3QgcGFyZW50cyA9IG5ldyBTZXQoKGNvbHVtbnMgfHwgW10pLm1hcChjID0-IHsKICAgICAgY29uc3QgcGFydHMgPSBTdHJpbmcoYy5sYWJlbCB8fCAnJykuc3BsaXQoJy8nKTsKICAgICAgcmV0dXJuIHBhcnRzLmxlbmd0aCA-IDEgPyBwYXJ0cy5zbG",
"ljZSgwLCAtMSkuam9pbignLycpIDogJyc7CiAgICB9KSk7CiAgICBpZiAocGFyZW50cy5zaXplID09PSAxKSB7CiAgICAgIGNvbnN0IFtvbmx5XSA9IHBhcmVudHM7CiAgICAgIGlmIChvbmx5KSByZXR1cm4gb25seTsKICAgIH0KICAgIHJldHVybiBERUZBVUxUX1JPT1Q7CiAgfQoKICAvLyBDb2x1bW5zIHJlbWVtYmVyIHRoZWlyIGxhYmVsJ3MgaWQgYXMgd2VsbCBhcyBpdHMgbmFtZSwgYmVjYXVzZSBHbWFpbAogIC8vIGxldHMgYSBsYWJlbCBiZSByZW5hbWVkIC0gYW5kIHJlbmFtaW5nICJCb2FyZCIgdG8gIl9Cb2FyZCIgcmVuYW1lcwogIC8vIGV2ZXJ5IGNvbHVtbiBsYWJlbCB1bmRlciBpdC4gRm9sbG93aW5nIHRoZSBpZCBrZWVwcyBhIGNvbHVtbiBvbiB0aGUKICAvLyBzYW1lIG1haWw7IGZvbGxvd2luZyB0aGUgbmFtZSBhbG9uZSB3b3VsZCBjcmVhdGUgYSBmcmVzaCwgZW1wdHkgbGFiZWwKICAvLyB3aXRoIHRoZSBvbGQgbmFtZS4gUmV0dXJucyB0aGUgY29sdW1ucyB3aXRoIG5hbWVzIGJyb3VnaHQgdXAgdG8gZGF0ZQogIC8vIGFuZCBpZHMgZmlsbGVkIGluLCBhbmQgd2hldGhlciBhbnl0aGluZyBjaGFuZ2VkIChzbyBpdCBjYW4gYmUgc2F2ZWQpLgogIGZ1bmN0aW9uIHJlc29sdmVDb2x1bW5MYWJlbHMoY29sdW1ucywgbGFiZWxzKSB7CiAgICBjb25zdCBieUlkID0gbmV3IE1hcCgobGFiZWxzIHx8IFtdKS5tYXAobCA9PiBbbC5pZCwgbF0pKTsKICAgIGNvbnN0IGJ5TmFtZSA9IG5ldyBNYXAoKGxhYmVscy",
"B8fCBbXSkubWFwKGwgPT4gW1N0cmluZyhsLm5hbWUpLnRvTG93ZXJDYXNlKCksIGxdKSk7CiAgICBsZXQgY2hhbmdlZCA9IGZhbHNlOwogICAgY29uc3Qgb3V0ID0gY29sdW1ucy5tYXAoYyA9PiB7CiAgICAgIGNvbnN0IHZpYUlkID0gYy5sYWJlbElkICYmIGJ5SWQuZ2V0KGMubGFiZWxJZCk7CiAgICAgIGlmICh2aWFJZCkgewogICAgICAgIGlmICh2aWFJZC5uYW1lID09PSBjLmxhYmVsKSByZXR1cm4gYzsKICAgICAgICBjaGFuZ2VkID0gdHJ1ZTsKICAgICAgICByZXR1cm4geyAuLi5jLCBsYWJlbDogdmlhSWQubmFtZSB9OwogICAgICB9CiAgICAgIC8vIEdtYWlsJ3Mgb3duIHNwZWxsaW5nIHdpbnMsIHNvIGEgY2FzZS1vbmx5IGRpZmZlcmVuY2Ugc2V0dGxlcyBoZXJlCiAgICAgIC8vIHJhdGhlciB0aGFuIGNvdW50aW5nIGFzIGEgcmVuYW1lIG9uIHRoZSBuZXh0IHBhc3MuCiAgICAgIGNvbnN0IHZpYU5hbWUgPSBieU5hbWUuZ2V0KFN0cmluZyhjLmxhYmVsKS50b0xvd2VyQ2FzZSgpKTsKICAgICAgaWYgKHZpYU5hbWUpIHsKICAgICAgICBpZiAoYy5sYWJlbElkID09PSB2aWFOYW1lLmlkICYmIGMubGFiZWwgPT09IHZpYU5hbWUubmFtZSkgcmV0dXJuIGM7CiAgICAgICAgY2hhbmdlZCA9IHRydWU7CiAgICAgICAgcmV0dXJuIHsgLi4uYywgbGFiZWw6IHZpYU5hbWUubmFtZSwgbGFiZWxJZDogdmlhTmFtZS5pZCB9OwogICAgICB9CiAgICAgIC8vIE5vdCBpbiBHbWFpbCAoeWV0KTogaXQgaXMgY3JlYXRlZCB1bm",
"RlciB0aGlzIG5hbWUsIGFuZCBpdHMgaWQgaXMKICAgICAgLy8gcmVjb3JkZWQgb24gdGhlIG5leHQgcGFzcy4KICAgICAgaWYgKGMubGFiZWxJZCkgewogICAgICAgIGNoYW5nZWQgPSB0cnVlOwogICAgICAgIGNvbnN0IHsgbGFiZWxJZCwgLi4ucmVzdCB9ID0gYzsKICAgICAgICByZXR1cm4gcmVzdDsKICAgICAgfQogICAgICByZXR1cm4gYzsKICAgIH0pOwogICAgcmV0dXJuIHsgY29sdW1uczogb3V0LCBjaGFuZ2VkIH07CiAgfQoKICBmdW5jdGlvbiBuZXdDb2x1bW5JZChleGlzdGluZywgcmFuZCA9IE1hdGgucmFuZG9tKSB7CiAgICBjb25zdCB0YWtlbiA9IG5ldyBTZXQoKGV4aXN0aW5nIHx8IFtdKS5tYXAoYyA9PiBjLmlkKSk7CiAgICBsZXQgaWQ7CiAgICBkbyB7CiAgICAgIGlkID0gJ2MnICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyBNYXRoLmZsb29yKHJhbmQoKSAqIDFlNikudG9TdHJpbmcoMzYpOwogICAgfSB3aGlsZSAodGFrZW4uaGFzKGlkKSk7CiAgICByZXR1cm4gaWQ7CiAgfQoKICAvLyBHbWFpbCByZXNlcnZlcyBpdHMgc3lzdGVtIGxhYmVsIG5hbWVzIChjYXNlLWluc2Vuc2l0aXZlbHkpIGFuZCByZWplY3RzCiAgLy8gZW1wdHkgcGF0aCBzZWdtZW50cywgc28gYm90aCBhcmUgY2F1Z2h0IGhlcmUgd2l0aCBhIHJlYWRhYmxlIG1lc3NhZ2UKICAvLyBpbnN0ZWFkIG9mIGEgYmFyZSA0MDAgZnJvbSB0aGUgQVBJLgogIGNvbnN0IFJFU0VSVkVEID0gbmV3IFNldChbCiAgICAnaW5ib3gnLCAnc2",
"VudCcsICdkcmFmdHMnLCAnc3BhbScsICd0cmFzaCcsICdzdGFycmVkJywgJ2ltcG9ydGFudCcsCiAgICAndW5yZWFkJywgJ2NoYXQnLCAnc25vb3plZCcsICdzY2hlZHVsZWQnLCAnYWxsIG1haWwnLCAnb3V0Ym94JywKICBdKTsKCiAgZnVuY3Rpb24gdmFsaWRhdGVDb2x1bW5zKGNvbHMpIHsKICAgIGlmICghY29scy5sZW5ndGgpIHJldHVybiAnS2VlcCBhdCBsZWFzdCBvbmUgY29sdW1uLic7CiAgICBjb25zdCBsYWJlbHMgPSBuZXcgU2V0KCk7CiAgICBmb3IgKGNvbnN0IGMgb2YgY29scykgewogICAgICBjb25zdCB0aXRsZSA9IChjLnRpdGxlIHx8ICcnKS50cmltKCk7CiAgICAgIGNvbnN0IGxhYmVsID0gKGMubGFiZWwgfHwgJycpLnRyaW0oKTsKICAgICAgaWYgKCF0aXRsZSkgcmV0dXJuICdFdmVyeSBjb2x1bW4gbmVlZHMgYSB0aXRsZS4nOwogICAgICBpZiAoIWxhYmVsKSByZXR1cm4gYOKAnCR7dGl0bGV94oCdIG5lZWRzIGEgR21haWwgbGFiZWwuYDsKICAgICAgaWYgKGxhYmVsLnNwbGl0KCcvJykuc29tZShzZWcgPT4gIXNlZy50cmltKCkpKSB7CiAgICAgICAgcmV0dXJuIGDigJwke2xhYmVsfeKAnSBoYXMgYW4gZW1wdHkgcGFydCBiZXR3ZWVuIHNsYXNoZXMuYDsKICAgICAgfQogICAgICBpZiAoUkVTRVJWRUQuaGFzKGxhYmVsLnRvTG93ZXJDYXNlKCkpKSByZXR1cm4gYOKAnCR7bGFiZWx94oCdIGlzIGEgR21haWwgc3lzdGVtIGxhYmVsIGFuZCBjYW5ub3QgYmUgdXNlZC5gOwogICAgICBjb25zdCBrZX",
"kgPSBsYWJlbC50b0xvd2VyQ2FzZSgpOwogICAgICBpZiAobGFiZWxzLmhhcyhrZXkpKSByZXR1cm4gYFR3byBjb2x1bW5zIHVzZSB0aGUgbGFiZWwg4oCcJHtsYWJlbH3igJ0uYDsKICAgICAgbGFiZWxzLmFkZChrZXkpOwogICAgfQogICAgcmV0dXJuICcnOwogIH0KCiAgLy8gIl9Cb2FyZC9UbyBkbyIg4oaSIFsiX0JvYXJkIl0uIEdtYWlsIG9ubHkgbmVzdHMgYSBsYWJlbCBpbiBpdHMgc2lkZWJhcgogIC8vIHdoZW4gdGhlIHBhcmVudCBleGlzdHMsIHNvIHRoZSBwYXJlbnRzIGFyZSBjcmVhdGVkIHRvby4KICBmdW5jdGlvbiBsYWJlbEFuY2VzdG9ycyhuYW1lKSB7CiAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyhuYW1lKS5zcGxpdCgnLycpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGxldCBpID0gMTsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSBvdXQucHVzaChwYXJ0cy5zbGljZSgwLCBpKS5qb2luKCcvJykpOwogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIOKUgOKUgCBQbGFjZW1lbnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIEEgdGhyZWFkIGNhcnJ5aW5nIHR3byBjb2x1bW4gbGFiZWxzIChtb3ZlZCBvbiB0aGUgcGhvbmUsIHNheSkgaX",
"Mgc2hvd24KICAvLyBvbmNlLCBpbiB0aGUgbGVmdC1tb3N0IG9mIGl0cyBjb2x1bW5zLiBTaG93aW5nIGl0IHR3aWNlIHdvdWxkIG1ha2UgYQogIC8vIGRyYWcgYW1iaWd1b3VzIGFib3V0IHdoaWNoIGxhYmVsIGl0IGlzIGxlYXZpbmcuCiAgZnVuY3Rpb24gYXNzaWduQ29sdW1ucyhjb2x1bW5zLCBsaXN0c0J5Q29sdW1uKSB7CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgY29uc3Qgb3V0ID0ge307CiAgICBmb3IgKGNvbnN0IGNvbCBvZiBjb2x1bW5zKSB7CiAgICAgIG91dFtjb2wuaWRdID0gW107CiAgICAgIGZvciAoY29uc3QgaWQgb2YgKGxpc3RzQnlDb2x1bW5bY29sLmlkXSB8fCBbXSkpIHsKICAgICAgICBpZiAoc2Vlbi5oYXMoaWQpKSBjb250aW51ZTsKICAgICAgICBzZWVuLmFkZChpZCk7CiAgICAgICAgb3V0W2NvbC5pZF0ucHVzaChpZCk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBTYXZlZCBvcmRlciB3aW5zIGZvciBldmVyeSB0aHJlYWQgaXQgbWVudGlvbnMuIFRocmVhZHMgaXQgZG9lcyBub3QKICAvLyBrbm93IGFib3V0IGFyZSBuZXcgdG8gdGhlIGNvbHVtbiwgc28gdGhleSBnbyBvbiB0b3AgLSBuZXdlc3QgZmlyc3QgLQogIC8vIHdoZXJlIHRoZXkgd2lsbCBiZSBub3RpY2VkLiBJZHMgdGhhdCBoYXZlIGxlZnQgdGhlIGNvbHVtbiBkcm9wIG91dC4KICBmdW5jdGlvbiBtZXJnZU9yZGVyKHNhdmVkSWRzLCB0aHJlYWRzKSB7CiAgICBjb25zdCBwcmVzZW50ID",
"0gbmV3IE1hcCh0aHJlYWRzLm1hcCh0ID0-IFt0LmlkLCB0XSkpOwogICAgY29uc3Qga2VwdCA9IFtdOwogICAgY29uc3Qga2VwdFNldCA9IG5ldyBTZXQoKTsKICAgIGZvciAoY29uc3QgaWQgb2YgKHNhdmVkSWRzIHx8IFtdKSkgewogICAgICBpZiAocHJlc2VudC5oYXMoaWQpICYmICFrZXB0U2V0LmhhcyhpZCkpIHsga2VwdC5wdXNoKGlkKTsga2VwdFNldC5hZGQoaWQpOyB9CiAgICB9CiAgICBjb25zdCBmcmVzaCA9IHRocmVhZHMKICAgICAgLmZpbHRlcih0ID0-ICFrZXB0U2V0Lmhhcyh0LmlkKSkKICAgICAgLnNvcnQoKGEsIGIpID0-IChOdW1iZXIoYi50cykgfHwgMCkgLSAoTnVtYmVyKGEudHMpIHx8IDApKQogICAgICAubWFwKHQgPT4gdC5pZCk7CiAgICByZXR1cm4gZnJlc2guY29uY2F0KGtlcHQpOwogIH0KCiAgLy8gSW5kZXggaXMgYSBwb3NpdGlvbiBpbiB0aGUgbGlzdCBhcyBpdCBsb29rcyBXSVRIT1VUIHRoZSB0aHJlYWQgYmVpbmcKICAvLyBwbGFjZWQgLSB3aGljaCBpcyB3aGF0IHRoZSBkcm9wIHpvbmUgbWVhc3VyZXMsIHNpbmNlIHRoZSBkcmFnZ2VkIGNhcmQKICAvLyBpcyBoaWRkZW4gd2hpbGUgaXQgaXMgaW4gZmxpZ2h0LgogIGZ1bmN0aW9uIHBsYWNlSWQobGlzdCwgaWQsIGluZGV4KSB7CiAgICBjb25zdCByZXN0ID0gKGxpc3QgfHwgW10pLmZpbHRlcih4ID0-IHggIT09IGlkKTsKICAgIGNvbnN0IGkgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihOdW1iZXIoaW5kZXgpIHx8IDAsIHJlc3QubG",
"VuZ3RoKSk7CiAgICByZXN0LnNwbGljZShpLCAwLCBpZCk7CiAgICByZXR1cm4gcmVzdDsKICB9CgogIC8vIERyb3BzIGlkcyB0aGF0IGFyZSBub3Qgb24gdGhlIGJvYXJkIGFueSBtb3JlLCBhbmQgY29sdW1ucyB0aGF0IG5vCiAgLy8gbG9uZ2VyIGV4aXN0LCBzbyBzdG9yYWdlLmxvY2FsIGRvZXMgbm90IHNsb3dseSBmaWxsIHdpdGggZGVhZCB0aHJlYWRzLgogIGZ1bmN0aW9uIHBydW5lT3JkZXIobGlzdHMsIGNvbHVtbnMpIHsKICAgIGNvbnN0IG91dCA9IHt9OwogICAgZm9yIChjb25zdCBjb2wgb2YgY29sdW1ucykgb3V0W2NvbC5pZF0gPSAobGlzdHNbY29sLmlkXSB8fCBbXSkuc2xpY2UoKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyDilIDilIAgTGFiZWwgYXJpdGhtZXRpYyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYXNMb29rdXAobGFiZWxJZE9mKSB7CiAgICBpZiAodHlwZW9mIGxhYmVsSWRPZiA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIGxhYmVsSWRPZjsKICAgIGlmIChsYWJlbElkT2YgaW5zdGFuY2VvZiBNYXApIHJldHVybiBuYW1lID0-IGxhYmVsSWRPZi5nZXQobmFtZSk7CiAgICByZXR1cm4gbmFtZSA9PiAobGFiZWxJZE9mIHx8IHt9KVtuYW1lXTsKICB9Cg",
"ogIC8vIE1vdmluZyBhIGNhcmQgaXMgb25lIHRocmVhZHMubW9kaWZ5OiBhZGQgdGhlIHRhcmdldCdzIGxhYmVsLCBzdHJpcAogIC8vIGV2ZXJ5IG90aGVyIGNvbHVtbiBsYWJlbCAoc28gYSB0aHJlYWQgaXMgb25seSBldmVyIGluIG9uZSBjb2x1bW4sIGV2ZW4KICAvLyBpZiBpdCBoYWQgZHJpZnRlZCBpbnRvIHR3byksIGFuZCBkcm9wIElOQk9YIHdoZW4gdGhlIHRhcmdldCBhcmNoaXZlcy4KICBmdW5jdGlvbiBtb3ZlTGFiZWxEaWZmKGNvbHVtbnMsIHRhcmdldENvbHVtbklkLCBsYWJlbElkT2YpIHsKICAgIGNvbnN0IGxvb2t1cCA9IGFzTG9va3VwKGxhYmVsSWRPZik7CiAgICBjb25zdCB0YXJnZXQgPSBjb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSB0YXJnZXRDb2x1bW5JZCk7CiAgICBpZiAoIXRhcmdldCkgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGNvbHVtbiAke3RhcmdldENvbHVtbklkfWApOwogICAgY29uc3QgYWRkSWQgPSBsb29rdXAodGFyZ2V0LmxhYmVsKTsKICAgIGlmICghYWRkSWQpIHRocm93IG5ldyBFcnJvcihgTm8gR21haWwgbGFiZWwgaWQgZm9yIOKAnCR7dGFyZ2V0LmxhYmVsfeKAnWApOwoKICAgIGNvbnN0IHJlbW92ZSA9IG5ldyBTZXQoKTsKICAgIGZvciAoY29uc3QgYyBvZiBjb2x1bW5zKSB7CiAgICAgIGlmIChjLmlkID09PSB0YXJnZXRDb2x1bW5JZCkgY29udGludWU7CiAgICAgIGNvbnN0IGlkID0gbG9va3VwKGMubGFiZWwpOwogICAgICBpZiAoaWQgJiYgaWQgIT09IGFkZElkKS",
"ByZW1vdmUuYWRkKGlkKTsKICAgIH0KICAgIGlmICh0YXJnZXQuYXJjaGl2ZU9uRHJvcCkgcmVtb3ZlLmFkZCgnSU5CT1gnKTsKICAgIHJldHVybiB7IGFkZExhYmVsSWRzOiBbYWRkSWRdLCByZW1vdmVMYWJlbElkczogWy4uLnJlbW92ZV0gfTsKICB9CgogIC8vIFRha2luZyBhIGNhcmQgb2ZmIHRoZSBib2FyZCBzdHJpcHMgZXZlcnkgY29sdW1uIGxhYmVsIGFuZCBub3RoaW5nCiAgLy8gZWxzZTogdGhlIHRocmVhZCBzdGF5cyBleGFjdGx5IHdoZXJlIGl0IHdhcyBpbiBHbWFpbC4KICBmdW5jdGlvbiByZW1vdmVMYWJlbERpZmYoY29sdW1ucywgbGFiZWxJZE9mKSB7CiAgICBjb25zdCBsb29rdXAgPSBhc0xvb2t1cChsYWJlbElkT2YpOwogICAgY29uc3QgcmVtb3ZlID0gbmV3IFNldCgpOwogICAgZm9yIChjb25zdCBjIG9mIGNvbHVtbnMpIHsKICAgICAgY29uc3QgaWQgPSBsb29rdXAoYy5sYWJlbCk7CiAgICAgIGlmIChpZCkgcmVtb3ZlLmFkZChpZCk7CiAgICB9CiAgICByZXR1cm4geyBhZGRMYWJlbElkczogW10sIHJlbW92ZUxhYmVsSWRzOiBbLi4ucmVtb3ZlXSB9OwogIH0KCiAgLy8gV2hpY2ggY29sdW1uIGEgdGhyZWFkIGJlbG9uZ3MgaW4sIGdpdmVuIHRoZSB1bmlvbiBvZiBpdHMgbGFiZWwgaWRzLgogIGZ1bmN0aW9uIGNvbHVtbkZvckxhYmVscyhjb2x1bW5zLCBsYWJlbElkcywgbGFiZWxJZE9mKSB7CiAgICBjb25zdCBsb29rdXAgPSBhc0xvb2t1cChsYWJlbElkT2YpOwogICAgY29uc3QgaGF2ZSA9IG",
"5ldyBTZXQobGFiZWxJZHMgfHwgW10pOwogICAgZm9yIChjb25zdCBjIG9mIGNvbHVtbnMpIHsKICAgICAgY29uc3QgaWQgPSBsb29rdXAoYy5sYWJlbCk7CiAgICAgIGlmIChpZCAmJiBoYXZlLmhhcyhpZCkpIHJldHVybiBjOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQoKICAvLyDilIDilIAgVGhyZWFkcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gUmVkdWNlcyBhIHRocmVhZHMuZ2V0KGZvcm1hdD1tZXRhZGF0YSkgcmVzcG9uc2UgdG8gd2hhdCBhIGNhcmQgc2hvd3MuCiAgLy8gU3ViamVjdCBjb21lcyBmcm9tIHRoZSBmaXJzdCBtZXNzYWdlIChyZXBsaWVzIHByZWZpeCAiUmU6IiksIHNlbmRlcgogIC8vIGFuZCBkYXRlIGZyb20gdGhlIGxhdGVzdCByZWFsIG1lc3NhZ2UgKGEgcGVuZGluZyBkcmFmdCBpcyBub3QgbmV3cykuCiAgLy8gYHdhaXRpbmdgOiB0aGF0IG1lc3NhZ2UgaXMgdGhlIHVzZXIncyBvd24sIHRvIHNvbWVvbmUgZWxzZSwgd2l0aCBubwogIC8vIHJlcGx5IGJlaW5nIHdyaXR0ZW4gLSB0aGUgYmFsbCBpcyBpbiB0aGUgb3RoZXIgY291cnQuCiAgZnVuY3Rpb24gc3VtbWFyaXNlVGhyZWFkKHRocmVhZCwgYWNjb3VudC",
"kgewogICAgY29uc3QgbXNncyA9ICh0aHJlYWQgJiYgdGhyZWFkLm1lc3NhZ2VzKSB8fCBbXTsKICAgIGNvbnN0IGlkID0gdGhyZWFkICYmIHRocmVhZC5pZDsKICAgIGNvbnN0IGhpc3RvcnlJZCA9IFN0cmluZygodGhyZWFkICYmIHRocmVhZC5oaXN0b3J5SWQpIHx8ICcnKTsKICAgIGlmICghbXNncy5sZW5ndGgpIHsKICAgICAgcmV0dXJuIHsKICAgICAgICBpZCwgaGlzdG9yeUlkLCBzdWJqZWN0OiAnKG5vIHN1YmplY3QpJywgZnJvbTogJycsIGZyb21FbWFpbDogJycsIHRzOiAwLAogICAgICAgIHNuaXBwZXQ6IHV0aWwuZGVjb2RlRW50aXRpZXMoKHRocmVhZCAmJiB0aHJlYWQuc25pcHBldCkgfHwgJycpLAogICAgICAgIGNvdW50OiAwLCB1bnJlYWQ6IGZhbHNlLCBzdGFycmVkOiBmYWxzZSwgaGFzRHJhZnQ6IGZhbHNlLCBsYWJlbElkczogW10sCiAgICAgIH07CiAgICB9CgogICAgY29uc3QgaXNEcmFmdCA9IG0gPT4gKG0ubGFiZWxJZHMgfHwgW10pLmluY2x1ZGVzKCdEUkFGVCcpOwogICAgY29uc3QgcmVhbCA9IG1zZ3MuZmlsdGVyKG0gPT4gIWlzRHJhZnQobSkpOwogICAgY29uc3QgYmFzaXMgPSByZWFsLmxlbmd0aCA_IHJlYWwgOiBtc2dzOwogICAgY29uc3QgbGF0ZXN0ID0gYmFzaXNbYmFzaXMubGVuZ3RoIC0gMV07CiAgICBjb25zdCBmaXJzdEhlYWRlcnMgPSB1dGlsLmhlYWRlck1hcChtc2dzWzBdKTsKICAgIGNvbnN0IGxhdGVzdEhlYWRlcnMgPSB1dGlsLmhlYWRlck1hcChsYXRlc3QpOwoKICAgIG",
"NvbnN0IGZyb20gPSB1dGlsLnBhcnNlQWRkcmVzcyhsYXRlc3RIZWFkZXJzLmZyb20pOwogICAgY29uc3QgbWUgPSAhIWFjY291bnQgJiYgZnJvbS5lbWFpbCA9PT0gU3RyaW5nKGFjY291bnQpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBsYWJlbHMgPSBuZXcgU2V0KG1zZ3MuZmxhdE1hcChtID0-IG0ubGFiZWxJZHMgfHwgW10pKTsKICAgIGNvbnN0IGhhc0RyYWZ0ID0gbXNncy5zb21lKGlzRHJhZnQpOwogICAgLy8gV3JpdHRlbiB0byBubyBvbmUgYnV0IHRoZSB1c2VyIChhIHJlbWluZGVyIHRvIHNlbGYpOiBub2JvZHkgdG8gd2FpdCBvbi4KICAgIC8vIE5vIFRvIG9yIENjIGF0IGFsbCAoQmNjIG9ubHkpIGlzIHNvbWVvbmUgZWxzZSwgdW5zZWVuLgogICAgY29uc3QgdG8gPSBgJHtsYXRlc3RIZWFkZXJzLnRvIHx8ICcnfSwke2xhdGVzdEhlYWRlcnMuY2MgfHwgJyd9YC5tYXRjaCgvW15cczw-LDsiJ10rQFteXHM8Piw7IiddKy9nKSB8fCBbXTsKICAgIGNvbnN0IHRvU2VsZiA9IHRvLmxlbmd0aCA-IDAgJiYgdG8uZXZlcnkoZSA9PiBlLnRvTG93ZXJDYXNlKCkgPT09IFN0cmluZyhhY2NvdW50KS50b0xvd2VyQ2FzZSgpKTsKCiAgICByZXR1cm4gewogICAgICBpZCwKICAgICAgaGlzdG9yeUlkLAogICAgICBzdWJqZWN0OiAoZmlyc3RIZWFkZXJzLnN1YmplY3QgfHwgJycpLnRyaW0oKSB8fCAnKG5vIHN1YmplY3QpJywKICAgICAgZnJvbTogbWUgPyAnbWUnIDogKHV0aWwuZGlzcGxheU5hbWUoZnJvbSkgfHwgJy",
"h1bmtub3duIHNlbmRlciknKSwKICAgICAgZnJvbUVtYWlsOiBmcm9tLmVtYWlsLAogICAgICB0czogTnVtYmVyKGxhdGVzdC5pbnRlcm5hbERhdGUpIHx8IERhdGUucGFyc2UobGF0ZXN0SGVhZGVycy5kYXRlKSB8fCAwLAogICAgICBzbmlwcGV0OiB1dGlsLmRlY29kZUVudGl0aWVzKGxhdGVzdC5zbmlwcGV0IHx8IHRocmVhZC5zbmlwcGV0IHx8ICcnKSwKICAgICAgY291bnQ6IGJhc2lzLmxlbmd0aCwKICAgICAgdW5yZWFkOiBsYWJlbHMuaGFzKCdVTlJFQUQnKSwKICAgICAgc3RhcnJlZDogbGFiZWxzLmhhcygnU1RBUlJFRCcpLAogICAgICBoYXNEcmFmdCwKICAgICAgd2FpdGluZzogbWUgJiYgIWhhc0RyYWZ0ICYmICF0b1NlbGYsCiAgICAgIGxhYmVsSWRzOiBbLi4ubGFiZWxzXSwKICAgIH07CiAgfQoKICAvLyDilIDilIAgTGFiZWxzIGFzIGNvbG91cnMg4pSA4pSACiAgLy8KICAvLyBBIGNhcmQgc2hvd3MgaXRzIGNvbnZlcnNhdGlvbidzIEdtYWlsIGxhYmVscyB0aGF0IGhhdmUgYSBjb2xvdXIgaW4KICAvLyBHbWFpbCAtIGFzIHRoZSB1c2VyIHNldCB0aGVtIHRoZXJlLCBzbyB0aGV5IG1lYW4gd2hhdCB0aGUgdXNlciBtZWFucwogIC8vIGJ5IHRoZW0sIGFuZCBHbWFpbCdzIGZpbHRlcnMgY29sb3VyIGNhcmRzIGJ5IHRoZW1zZWx2ZXMgLSBhbmQgdGFrZXMKICAvLyBpdHMgc3RyaXBlIGZyb20gdGhlIGZpcnN0LiBOb3QgR21haWwncyBvd24gbGFiZWxzLCBhbmQgbm90IHRob3NlIG5hbWVkCiAgLy8gaW4gYH",
"NraXBgIG9yIHVuZGVyIHRoZW0gKHRoZSBib2FyZCdzLCB0aGUgbm90ZXMnKS4gU29ydGVkIGJ5IG5hbWUsIGF0CiAgLy8gbW9zdCBNQVhfVEFHUy4gYGxhYmVsc2A6IEdtYWlsJ3MgbGFiZWwgcmVzb3VyY2VzLCBvciBhIE1hcCBvZiB0aGVtIGJ5CiAgLy8gaWQgKG1hZGUgb25jZSBmb3IgYSB3aG9sZSBib2FyZCkuIFt7IGlkLCBuYW1lLCBzaG9ydCwgYmFja2dyb3VuZCwgdGV4dCB9XQogIGNvbnN0IE1BWF9UQUdTID0gMjsKICBjb25zdCBIRVggPSAvXiNbMC05YS1mXXs2fSQvaTsKICBmdW5jdGlvbiBsYWJlbFRhZ3MobGFiZWxJZHMsIGxhYmVscywgc2tpcCkgewogICAgY29uc3QgYnlJZCA9IGxhYmVscyBpbnN0YW5jZW9mIE1hcCA_IGxhYmVscyA6IG5ldyBNYXAoKGxhYmVscyB8fCBbXSkubWFwKGwgPT4gW2wuaWQsIGxdKSk7CiAgICBjb25zdCBza2lwcGVkID0gKHNraXAgfHwgW10pLm1hcChzID0-IFN0cmluZyhzKS50b0xvd2VyQ2FzZSgpKS5maWx0ZXIoQm9vbGVhbik7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAoY29uc3QgaWQgb2YgbmV3IFNldChsYWJlbElkcyB8fCBbXSkpIHsKICAgICAgY29uc3QgbCA9IGJ5SWQuZ2V0KGlkKTsKICAgICAgY29uc3QgYyA9IGwgJiYgbC5jb2xvcjsKICAgICAgaWYgKCFsIHx8IGwudHlwZSA9PT0gJ3N5c3RlbScgfHwgIWMgfHwgIUhFWC50ZXN0KGMuYmFja2dyb3VuZENvbG9yIHx8ICcnKSkgY29udGludWU7CiAgICAgIGNvbnN0IG5hbWUgPSBTdHJpbmcobC5uYW",
"1lIHx8ICcnKTsKICAgICAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmICghbmFtZSB8fCBza2lwcGVkLnNvbWUocyA9PiBsb3dlciA9PT0gcyB8fCBsb3dlci5zdGFydHNXaXRoKGAke3N9L2ApKSkgY29udGludWU7CiAgICAgIG91dC5wdXNoKHsgaWQsIG5hbWUsIHNob3J0OiBuYW1lLnNwbGl0KCcvJykucG9wKCksIGJhY2tncm91bmQ6IGMuYmFja2dyb3VuZENvbG9yLCB0ZXh0OiBIRVgudGVzdChjLnRleHRDb2xvciB8fCAnJykgPyBjLnRleHRDb2xvciA6ICcjMDAwMDAwJyB9KTsKICAgIH0KICAgIG91dC5zb3J0KChhLCBiKSA9PiBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpKTsKICAgIHJldHVybiBvdXQuc2xpY2UoMCwgTUFYX1RBR1MpOwogIH0KCiAgZnVuY3Rpb24gc2VhcmNoUXVlcnkodGV4dCkgewogICAgY29uc3QgcSA9IFN0cmluZyh0ZXh0IHx8ICcnKS50cmltKCk7CiAgICByZXR1cm4gcSB8fCAnaW46aW5ib3gnOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgZWRpdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGNhcmQgY2FuIGNhcnJ5IHRoZSB1c2VyJ3Mgb3duIHRpdGxlLCBhIHNob3J0IG5vdGUgYW",
"5kIGEgY29sb3VyLiBUaGV5CiAgLy8gbGl2ZSBpbiBzdG9yYWdlLnN5bmMgYmVzaWRlIHRoZSBjb2x1bW4gbGF5b3V0IGFuZCBuZXZlciB0b3VjaCB0aGUgbWFpbDoKICAvLyBHbWFpbCBoYXMgbm93aGVyZSB0byBwdXQgYSBwcml2YXRlIHRpdGxlIG9uIGEgdGhyZWFkLCBhbmQgcmV3cml0aW5nIGEKICAvLyBzdWJqZWN0IHdvdWxkIGNoYW5nZSB3aGF0IGNvcnJlc3BvbmRlbnRzIHNlZSBpbiB0aGVpciByZXBsaWVzLgoKICBjb25zdCBDQVJEX0NPTE9VUlMgPSBbJ3JlZCcsICdvcmFuZ2UnLCAneWVsbG93JywgJ2dyZWVuJywgJ2JsdWUnLCAncHVycGxlJywgJ2dyZXknXTsKCiAgLy8gTG9uZyBlbm91Z2ggZm9yIGEgd29ya2luZyB0aXRsZSBvciBhICI0LDIwMCB3b3JkcywgZHVlIEZyaSIgbm90ZSwgc2hvcnQKICAvLyBlbm91Z2ggdGhhdCBodW5kcmVkcyBvZiBjYXJkcyBmaXQgc3luYydzIDEwMCBLQi4KICBjb25zdCBNQVhfVElUTEUgPSAyMDA7CiAgY29uc3QgTUFYX05PVEUgPSA1MDA7CgogIC8vIFJldHVybnMgdGhlIGVkaXQgdG8gc3RvcmUsIG9yIG51bGwgd2hlbiBub3RoaW5nIGRpZmZlcnMgZnJvbSB0aGUKICAvLyBlbWFpbCAtIHNvIGNsZWFyaW5nIGV2ZXJ5IGZpZWxkIGRlbGV0ZXMgdGhlIHJlY29yZCBpbnN0ZWFkIG9mIGxlYXZpbmcKICAvLyBhbiBlbXB0eSBvbmUgdG8gY291bnQgYWdhaW5zdCB0aGUgcXVvdGEuIEEgdGl0bGUgaWRlbnRpY2FsIHRvIHRoZQogIC8vIHN1YmplY3QgaXMgbm90IGFuIGVkaX",
"QgZWl0aGVyOiB0aGUgZWRpdG9yIG9wZW5zIHByZS1maWxsZWQgd2l0aCBpdC4KICBmdW5jdGlvbiBub3JtYWxpc2VDYXJkRWRpdChyYXcsIHN1YmplY3QgPSAnJykgewogICAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsOwogICAgY29uc3QgdGl0bGUgPSBTdHJpbmcocmF3LnRpdGxlIHx8ICcnKS5yZXBsYWNlKC9ccysvZywgJyAnKS50cmltKCkuc2xpY2UoMCwgTUFYX1RJVExFKTsKICAgIGNvbnN0IG5vdGUgPSBTdHJpbmcocmF3Lm5vdGUgfHwgJycpCiAgICAgIC5yZXBsYWNlKC9cclxuPy9nLCAnXG4nKQogICAgICAucmVwbGFjZSgvXG57Myx9L2csICdcblxuJykKICAgICAgLnRyaW0oKQogICAgICAuc2xpY2UoMCwgTUFYX05PVEUpOwogICAgY29uc3QgY29sb3VyID0gQ0FSRF9DT0xPVVJTLmluY2x1ZGVzKHJhdy5jb2xvdXIpID8gcmF3LmNvbG91ciA6ICcnOwoKICAgIGNvbnN0IG91dCA9IHt9OwogICAgaWYgKHRpdGxlICYmIHRpdGxlICE9PSBTdHJpbmcoc3ViamVjdCB8fCAnJykudHJpbSgpKSBvdXQudGl0bGUgPSB0aXRsZTsKICAgIGlmIChub3RlKSBvdXQubm90ZSA9IG5vdGU7CiAgICBpZiAoY29sb3VyKSBvdXQuY29sb3VyID0gY29sb3VyOwogICAgcmV0dXJuIE9iamVjdC5rZXlzKG91dCkubGVuZ3RoID8gb3V0IDogbnVsbDsKICB9CgogIGZ1bmN0aW9uIGRpc3BsYXlUaXRsZSh0aHJlYWQsIGVkaXQpIHsKICAgIHJldHVybiAoZWRpdCAmJiBlZGl0LnRpdGxlKS",
"B8fCAodGhyZWFkICYmIHRocmVhZC5zdWJqZWN0KSB8fCAnKG5vIHN1YmplY3QpJzsKICB9CgogIC8vIFBpY2tzIG9uZSBhY2NvdW50J3MgY2FyZCBlZGl0cyBvdXQgb2YgYSBzdG9yYWdlLnN5bmMgZHVtcCwga2V5ZWQgYnkKICAvLyB0aHJlYWQgaWQuIFJlY29yZHMgdGhhdCBubyBsb25nZXIgbm9ybWFsaXNlIHRvIGFueXRoaW5nIGFyZSBkcm9wcGVkLgogIGZ1bmN0aW9uIGNhcmRFZGl0c0Zyb20oYWxsLCBwcmVmaXgpIHsKICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTsKICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGFsbCB8fCB7fSkpIHsKICAgICAgaWYgKCFrZXkuc3RhcnRzV2l0aChwcmVmaXgpKSBjb250aW51ZTsKICAgICAgY29uc3QgaWQgPSBrZXkuc2xpY2UocHJlZml4Lmxlbmd0aCk7CiAgICAgIGNvbnN0IGVkaXQgPSBub3JtYWxpc2VDYXJkRWRpdCh2YWx1ZSk7CiAgICAgIGlmIChpZCAmJiBlZGl0KSBvdXQuc2V0KGlkLCBlZGl0KTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBjb25zdCBhcGkgPSB7CiAgICBERUZBVUxUX1JPT1QsIERFRkFVTFRfQ09MVU1OUywgZGVmYXVsdENvbHVtbnMsIG5vcm1hbGlzZUNvbHVtbnMsIGxhYmVsUm9vdCwgcmVzb2x2ZUNvbHVtbkxhYmVscywKICAgIG5ld0NvbHVtbklkLCB2YWxpZGF0ZUNvbHVtbnMsCiAgICBsYWJlbEFuY2VzdG9ycywgYXNzaWduQ29sdW1ucywgbWVyZ2VPcmRlciwgcGxhY2VJZCwgcHJ1bmVPcmRlciwKIC",
"AgIG1vdmVMYWJlbERpZmYsIHJlbW92ZUxhYmVsRGlmZiwgY29sdW1uRm9yTGFiZWxzLCBzdW1tYXJpc2VUaHJlYWQsIHNlYXJjaFF1ZXJ5LAogICAgQ0FSRF9DT0xPVVJTLCBNQVhfVElUTEUsIE1BWF9OT1RFLCBub3JtYWxpc2VDYXJkRWRpdCwgZGlzcGxheVRpdGxlLCBjYXJkRWRpdHNGcm9tLCBNQVhfVEFHUywgbGFiZWxUYWdzLAogIH07CgogIG5zLmxvZ2ljID0gYXBpOwogIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykgbW9kdWxlLmV4cG9ydHMgPSBhcGk7Cn0pKCk7Cg\"],[\"src/lib/calendar-logic.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIENhbGVuZGFyIGxvZ2ljIChwdXJlKQovLwovLyBUaGUgQ2FsZW5kYXIgdGFiIHNob3dzIEdvb2dsZSBDYWxlbmRhcidzIGV2ZW50cyBhbmQgR29vZ2xlIFRhc2tzJwovLyB0YXNrcyBzaWRlIGJ5IHNpZGUsIGRheSBieSBkYXkuIFRoaXMgZmlsZSBob2xkcyB0aGUgcGFydHMgdGhhdCBuZWVkIG5vCi8vIGJyb3dzZXI6IGRhdGVzIGFzICJZWVlZLU1NLUREIiBrZXlzIGluIGxvY2FsIHR",
"pbWUsIHRoZSByYW5nZXMgZWFjaAovLyB2aWV3IHNob3dzLCB0dXJuaW5nIHRoZSB0d28gQVBJcycgYW5zd2VycyBpbnRvIG9uZSBraW5kIG9mIGRheSBpdGVtLAovLyBhbmQgd2hpY2ggcmVxdWVzdHMgdG8gR29vZ2xlIGFyZSBhbGxvd2VkIGF0IGFsbC4KLy8KLy8gSXQgcmVhZHMgYW5kIHdyaXRlcywgYm90aCB3YXlzOiB0aGUgc2Vjb25kIHNpZ24taW4gYXNrcyB0byByZWFkIHRoZQovLyBsaXN0IG9mIGNhbGVuZGFycyBhbmQgdG8gY2hhbmdlIGV2ZW50cyBhbmQgdGFza3MsIGFuZCB0aGUgcmVxdWVzdAovLyBwb2xpY3kgYmVsb3cgbGV0cyB0aHJvdWdoIG9ubHkgd2hhdCB0aGUgY2FsZW5kYXIgZG9lcyAtIHJlYWRpbmcgdGhlCi8vIGNhbGVuZGFyIGxpc3QsIGEgY2FsZW5kYXIncyBldmVudHMsIHRoZSB0YXNrIGxpc3RzIGFuZCBhIGxpc3QncyB0YXNrczsKLy8gYW5kIGFkZGluZywgY2hhbmdpbmcgYW5kIGRlbGV0aW5nIG9uZSBldmVudCBvciBvbmUgdGFzaywgd2l0aCBvbmx5IHRoZQovLyBmaWVsZHMgdGhlIGNhbGVuZGFyIGVkaXRzLgovLwovLyBMb2FkZWQgYnkgdGhlIGNvbnRlbnQgc2NyaXB0cywgdGhlIHNlcnZpY2Ugd29ya2VyLCB0aGUgcGhvbmUgYXBwJ3MKLy8gc2NyaXB0IGFuZCBOb2RlJ3MgdGVzdHMuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgR29vZ2xlLCBhbmQgd2hhdCBtYXkgYmUgYXNrZWQgb2YgaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFRoZSBzZWNvbmQgc2lnbi1pbiwgc2VwYXJhdGUgZnJvbSBHbWFpbCdzLCBzbyB0aGF0IHRoZSBib2FyZCBhbmQgdGhlCiAgLy8gbm90ZXMgbmV2ZXIgc3RvcCB3b3JraW5nIGZvciBzb21lb25lIHdobyBoYXMgbm90IGFsbG93ZWQgdGhlIGNhbGVuZGFyLgogIC8vICJlbWFpbCIgbGV0cyB0aGUgd29ya2VyIGNoZWNrIHdob3NlIGNhbGVuZGFyIGl0IGlzLiBSZWFkaW5nIHRoZSBsaXN0CiAgLy8gb2YgY2FsZW5kYXJzIG5lZWRzIGNhbGVuZGFyLnJlYWRvbmx5OyBjYWxlbmRhci5ldmVudHMgY2hhbmdlcyBldmVudHMsCiAgLy8gYW5kIG5vdGhpbmcgZWxzZSBhYm91dCBhIGNhbGVuZGFyIChub3QgaXRzIHNoYXJpbmcsIG5vdCB0aGUgY2FsZW5kYXIKICAvLyBpdHNlbGYpLgogIGNvbnN0IFNDT1BFUyA9IFsKICAgICdlbWFpbCcsCiAgICA",
"naHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC9jYWxlbmRhci5yZWFkb25seScsCiAgICAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC9jYWxlbmRhci5ldmVudHMnLAogICAgJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2F1dGgvdGFza3MnLAogIF07CgogIGNvbnN0IEJBU0VTID0gewogICAgY2FsZW5kYXI6ICdodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9jYWxlbmRhci92My8nLAogICAgdGFza3M6ICdodHRwczovL3Rhc2tzLmdvb2dsZWFwaXMuY29tL3Rhc2tzL3YxLycsCiAgfTsKCiAgY29uc3QgVVNFUklORk9fVVJMID0gJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL29hdXRoMi92My91c2VyaW5mbyc7CgogIC8vIE9uZSBwYXRoIHNlZ21lbnQ6IGFuIGlkLCBlbmNvZGVkIHdpdGggZW5jb2RlVVJJQ29tcG9uZW50LiBOZXZlciBvbmUKICAvLyB0aGF0IHRoZSBVUkwgcGFyc2VyIHdvdWxkIHJlYWQgYXMgIi4iIG9yICIuLiIsIGVuY29kZWQgb3Igbm90LgogIGZ1bmN0aW9uIGlzU2VnbWVudChzKSB7CiAgICBpZiAoIS9eW0EtWmEtejAtOSUuX34tXSskLy50ZXN0KHMpKSByZXR1cm4gZmFsc2U7CiAgICBsZXQgcGxhaW47CiAgICB0cnkgeyBwbGFpbiA9IGRlY29kZVVSSUNvbXBvbmVudChzKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfQogICAgcmV0dXJuICEvXlwuKyQvLnRlc3QocGxhaW4pICYmICFwbGFpbi5pbmNsdWRlcygnLycpOwogIH0KCiAgLy8gQSBwYXRoIG9mIHRoZSB",
"naXZlbiBzaGFwZSwgZWFjaCB7fSBvbmUgc2VnbWVudC4KICBjb25zdCBzaGFwZWQgPSAocCwgcmUpID0-IHsgY29uc3QgbSA9IHJlLmV4ZWMocCk7IHJldHVybiAhIW0gJiYgbS5zbGljZSgxKS5ldmVyeShpc1NlZ21lbnQpOyB9OwogIGNvbnN0IEVWRU5UUyA9IC9eY2FsZW5kYXJzXC8oW14vXSspXC9ldmVudHMkLzsKICBjb25zdCBFVkVOVCA9IC9eY2FsZW5kYXJzXC8oW14vXSspXC9ldmVudHNcLyhbXi9dKykkLzsKICBjb25zdCBUQVNLUyA9IC9ebGlzdHNcLyhbXi9dKylcL3Rhc2tzJC87CiAgY29uc3QgVEFTSyA9IC9ebGlzdHNcLyhbXi9dKylcL3Rhc2tzXC8oW14vXSspJC87CgogIC8vIFdoYXQgbWF5IGJlIGFza2VkLCBieSBzZXJ2aWNlIGFuZCBtZXRob2Q6IHJlYWRzIG9mIHRoZSBmb3VyIGxpc3RzOwogIC8vIG9uZSBldmVudCBvciB0YXNrIGFkZGVkIChQT1NUIHRvIHRoZSBsaXN0KSwgY2hhbmdlZCAoUEFUQ0gpIG9yCiAgLy8gZGVsZXRlZCAoREVMRVRFKS4gTm90aGluZyBlbHNlIC0gbm8gY2FsZW5kYXIsIGxpc3Qgb3Igc2hhcmluZy4KICBjb25zdCBBTExPV0VEID0gewogICAgY2FsZW5kYXI6IHsKICAgICAgLy8gT25lIGV2ZW50IHJlYWQgb24gaXRzIG93bjogYSByZXBlYXRpbmcgZXZlbnQncyBzZXJpZXMsIGZvciBpdHMgcnVsZS4KICAgICAgR0VUOiBbcCA9PiBwID09PSAndXNlcnMvbWUvY2FsZW5kYXJMaXN0JywgcCA9PiBzaGFwZWQocCwgRVZFTlRTKSwgcCA9PiBzaGFwZWQocCwgRVZFTlQpXSw",
"KICAgICAgUE9TVDogW3AgPT4gc2hhcGVkKHAsIEVWRU5UUyldLAogICAgICBQQVRDSDogW3AgPT4gc2hhcGVkKHAsIEVWRU5UKV0sCiAgICAgIERFTEVURTogW3AgPT4gc2hhcGVkKHAsIEVWRU5UKV0sCiAgICB9LAogICAgdGFza3M6IHsKICAgICAgR0VUOiBbcCA9PiBwID09PSAndXNlcnMvQG1lL2xpc3RzJywgcCA9PiBzaGFwZWQocCwgVEFTS1MpXSwKICAgICAgUE9TVDogW3AgPT4gc2hhcGVkKHAsIFRBU0tTKV0sCiAgICAgIFBBVENIOiBbcCA9PiBzaGFwZWQocCwgVEFTSyldLAogICAgICBERUxFVEU6IFtwID0-IHNoYXBlZChwLCBUQVNLKV0sCiAgICB9LAogIH07CgogIC8vIFRoZSBmaWVsZHMgdGhlIGNhbGVuZGFyIHNldHMsIGFuZCBub3RoaW5nIGVsc2U6IG5vIGF0dGVuZGVlcyAod2hvIHdvdWxkIGJlCiAgLy8gc2VudCBpbnZpdGF0aW9ucyksIG5vIHJlbWluZGVycywgbm8gc2hhcmluZy4gSG93IGFuIGV2ZW50IHJlcGVhdHMgaXMgYQogIC8vIGxpc3Qgb2YgcnVsZSBsaW5lcywgZWFjaCBvbmUgb2YgdGhlIGZvdXIga2luZHMgR29vZ2xlIGtub3dzLgogIGNvbnN0IEVWRU5UX0tFWVMgPSBbJ3N1bW1hcnknLCAnbG9jYXRpb24nLCAnc3RhcnQnLCAnZW5kJywgJ3JlY3VycmVuY2UnXTsKICBjb25zdCBpc1J1bGVMaW5lcyA9IHYgPT4gQXJyYXkuaXNBcnJheSh2KSAmJiB2Lmxlbmd0aCA8PSAyMCAmJgogICAgdi5ldmVyeShsID0-IHR5cGVvZiBsID09PSAnc3RyaW5nJyAmJiAvXihSUlVMRXxFWFJVTEV8UkR",
"BVEV8RVhEQVRFKVs6O11bXlxyXG5dezEsMTAwMH0kLy50ZXN0KGwpKTsKICBjb25zdCBUSU1FX0tFWVMgPSBbJ2RhdGUnLCAnZGF0ZVRpbWUnLCAndGltZVpvbmUnXTsKICBjb25zdCBUQVNLX0tFWVMgPSBbJ3RpdGxlJywgJ2R1ZScsICdzdGF0dXMnLCAnY29tcGxldGVkJ107CgogIGNvbnN0IG93biA9IChvLCBrKSA9PiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwobywgayk7CiAgY29uc3QgaXNQbGFpbiA9IG8gPT4gISFvICYmIHR5cGVvZiBvID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShvKTsKICBjb25zdCBvbmx5S2V5cyA9IChvLCBrZXlzKSA9PiBpc1BsYWluKG8pICYmIE9iamVjdC5rZXlzKG8pLmV2ZXJ5KGsgPT4ga2V5cy5pbmNsdWRlcyhrKSk7CgogIGZ1bmN0aW9uIGlzQWxsb3dlZEJvZHkoc2VydmljZSwgYm9keSkgewogICAgaWYgKHNlcnZpY2UgPT09ICd0YXNrcycpIHJldHVybiBvbmx5S2V5cyhib2R5LCBUQVNLX0tFWVMpOwogICAgcmV0dXJuIG9ubHlLZXlzKGJvZHksIEVWRU5UX0tFWVMpICYmIFsnc3RhcnQnLCAnZW5kJ10uZXZlcnkoayA9PiAhb3duKGJvZHksIGspIHx8IG9ubHlLZXlzKGJvZHlba10sIFRJTUVfS0VZUykpICYmCiAgICAgICghb3duKGJvZHksICdyZWN1cnJlbmNlJykgfHwgaXNSdWxlTGluZXMoYm9keS5yZWN1cnJlbmNlKSk7CiAgfQoKICBmdW5jdGlvbiBpc0FsbG93ZWRSZXF1ZXN0KHNlcnZpY2UsIG1ldGhvZCwgcGF0aCwgYm9keSkgewogICA",
"gY29uc3QgbSA9IFN0cmluZyhtZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCk7CiAgICBjb25zdCBydWxlcyA9IG93bihBTExPV0VELCBzZXJ2aWNlKSAmJiBvd24oQUxMT1dFRFtzZXJ2aWNlXSwgbSkgPyBBTExPV0VEW3NlcnZpY2VdW21dIDogbnVsbDsKICAgIGlmICghcnVsZXMgfHwgIXJ1bGVzLnNvbWUob2sgPT4gb2soU3RyaW5nKHBhdGggfHwgJycpKSkpIHJldHVybiBmYWxzZTsKICAgIGlmIChtID09PSAnUE9TVCcgfHwgbSA9PT0gJ1BBVENIJykgcmV0dXJuIGlzQWxsb3dlZEJvZHkoc2VydmljZSwgYm9keSk7CiAgICByZXR1cm4gYm9keSA9PT0gdW5kZWZpbmVkIHx8IGJvZHkgPT09IG51bGw7CiAgfQoKICAvLyBRdWVyeSB2YWx1ZXMgbWF5IGJlIGFycmF5cywgYXMgZm9yIEdtYWlsLgogIGZ1bmN0aW9uIGJ1aWxkVXJsKHNlcnZpY2UsIHBhdGgsIHF1ZXJ5KSB7CiAgICBjb25zdCBwYXJ0cyA9IFtdOwogICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocXVlcnkgfHwge30pKSB7CiAgICAgIGNvbnN0IHYgPSBxdWVyeVtrZXldOwogICAgICBpZiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwgfHwgdiA9PT0gJycpIGNvbnRpbnVlOwogICAgICBmb3IgKGNvbnN0IG9uZSBvZiBbXS5jb25jYXQodikpIHBhcnRzLnB1c2goYCR7ZW5jb2RlVVJJQ29tcG9uZW50KGtleSl9PSR7ZW5jb2RlVVJJQ29tcG9uZW50KG9uZSl9YCk7CiAgICB9CiAgICByZXR1cm4gQkFTRVNbc2VydmljZV0gKyBwYXR",
"oICsgKHBhcnRzLmxlbmd0aCA_IGA_JHtwYXJ0cy5qb2luKCcmJyl9YCA6ICcnKTsKICB9CgogIC8vIOKUgOKUgCBEYXRlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIEEgZGF5IGlzIGEgIllZWVktTU0tREQiIHN0cmluZyBpbiBsb2NhbCB0aW1lOiBpdCBzb3J0cyBhbmQgY29tcGFyZXMgYXMKICAvLyB0ZXh0LCBhbmQgc3Vydml2ZXMgc3RvcmFnZSBhbmQgbWVzc2FnZXMgdW5jaGFuZ2VkLiBXZWVrcyBzdGFydCBvbgogIC8vIE1vbmRheSBhbmQgYXJlIG51bWJlcmVkIGFzIElTTyA4NjAxIG51bWJlcnMgdGhlbS4KCiAgY29uc3QgREFZX05BTUVTID0gWydNb24nLCAnVHVlJywgJ1dlZCcsICdUaHUnLCAnRnJpJywgJ1NhdCcsICdTdW4nXTsKICBjb25zdCBNT05USFMgPSBbJ0phbicsICdGZWInLCAnTWFyJywgJ0FwcicsICdNYXknLCAnSnVuJywgJ0p1bCcsICdBdWcnLCAnU2VwJywgJ09jdCcsICdOb3YnLCAnRGVjJ107CiAgY29uc3QgTU9OVEhTX0xPTkcgPSBbJ0phbnVhcnknLCAnRmVicnVhcnknLCAnTWFyY2gnLCAnQXByaWwnLCAnTWF5JywgJ0p1bmUnLCAnSnVseScsCiAgICAgICAgICAgICAgICAgICAgICAgJ0F1Z3V",
"zdCcsICdTZXB0ZW1iZXInLCAnT2N0b2JlcicsICdOb3ZlbWJlcicsICdEZWNlbWJlciddOwoKICAvLyBIb3cgZmFyIHRoZSBhZ2VuZGEgbG9va3MgYWhlYWQsIGFuZCBob3cgZmFyIG9uZSBzdGVwIG1vdmVzIGl0LgogIGNvbnN0IEFHRU5EQV9EQVlTID0gMjg7CgogIGNvbnN0IHBhZCA9IG4gPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CgogIGZ1bmN0aW9uIGRhdGVLZXkoZCkgewogICAgY29uc3QgeCA9IGQgaW5zdGFuY2VvZiBEYXRlID8gZCA6IG5ldyBEYXRlKGQpOwogICAgcmV0dXJuIGAke3guZ2V0RnVsbFllYXIoKX0tJHtwYWQoeC5nZXRNb250aCgpICsgMSl9LSR7cGFkKHguZ2V0RGF0ZSgpKX1gOwogIH0KCiAgZnVuY3Rpb24gaXNLZXkoa2V5KSB7CiAgICByZXR1cm4gL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoU3RyaW5nKGtleSB8fCAnJykpOwogIH0KCiAgZnVuY3Rpb24gZnJvbUtleShrZXkpIHsKICAgIGNvbnN0IFt5LCBtLCBkXSA9IFN0cmluZyhrZXkpLnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4gbmV3IERhdGUoeSwgbSAtIDEsIGQpOwogIH0KCiAgZnVuY3Rpb24gYWRkRGF5cyhrZXksIG4pIHsKICAgIGNvbnN0IGQgPSBmcm9tS2V5KGtleSk7CiAgICBkLnNldERhdGUoZC5nZXREYXRlKCkgKyBuKTsKICAgIHJldHVybiBkYXRlS2V5KGQpOwogIH0KCiAgLy8gV2hvbGUgZGF5cyBmcm9tIGEgdG8gYi4gUm91bmRlZCwgYmVjYXVzZSBhIGRheSB3aXRoIGEgY2xvY2sgY2h",
"hbmdlCiAgLy8gaW4gaXQgaXMgYW4gaG91ciBsb25nZXIgb3Igc2hvcnRlciB0aGFuIDI0LgogIGZ1bmN0aW9uIGRheXNCZXR3ZWVuKGEsIGIpIHsKICAgIHJldHVybiBNYXRoLnJvdW5kKChmcm9tS2V5KGIpIC0gZnJvbUtleShhKSkgLyA4NjQwMDAwMCk7CiAgfQoKICAvLyAwIGZvciBNb25kYXkg4oCmIDYgZm9yIFN1bmRheS4KICBmdW5jdGlvbiB3ZWVrZGF5KGtleSkgewogICAgcmV0dXJuIChmcm9tS2V5KGtleSkuZ2V0RGF5KCkgKyA2KSAlIDc7CiAgfQoKICBmdW5jdGlvbiB3ZWVrU3RhcnQoa2V5KSB7CiAgICByZXR1cm4gYWRkRGF5cyhrZXksIC13ZWVrZGF5KGtleSkpOwogIH0KCiAgLy8gVGhlIElTTyB3ZWVrOiB0aGUgb25lIHdpdGggdGhlIHllYXIncyBmaXJzdCBUaHVyc2RheSBpbiBpdCBpcyB3ZWVrIDEuCiAgZnVuY3Rpb24gaXNvV2VlayhrZXkpIHsKICAgIGNvbnN0IHRodXJzZGF5ID0gYWRkRGF5cyh3ZWVrU3RhcnQoa2V5KSwgMyk7CiAgICBjb25zdCBmaXJzdFRodXJzZGF5ID0gYWRkRGF5cyh3ZWVrU3RhcnQoYCR7dGh1cnNkYXkuc2xpY2UoMCwgNCl9LTAxLTA0YCksIDMpOwogICAgcmV0dXJuIDEgKyBkYXlzQmV0d2VlbihmaXJzdFRodXJzZGF5LCB0aHVyc2RheSkgLyA3OwogIH0KCiAgZnVuY3Rpb24gbW9udGhTdGFydChrZXkpIHsKICAgIHJldHVybiBgJHtTdHJpbmcoa2V5KS5zbGljZSgwLCA3KX0tMDFgOwogIH0KCiAgLy8gVGhlIHNhbWUgZGF5IG4gbW9udGhzIG9uLCBvciB0aGUgbW9udGg",
"ncyBsYXN0IGRheSBpZiBpdCBpcyBzaG9ydGVyLgogIGZ1bmN0aW9uIGFkZE1vbnRocyhrZXksIG4pIHsKICAgIGNvbnN0IFt5LCBtLCBkXSA9IFN0cmluZyhrZXkpLnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICBjb25zdCBmaXJzdCA9IG5ldyBEYXRlKHksIG0gLSAxICsgbiwgMSk7CiAgICBjb25zdCBsYXN0ID0gbmV3IERhdGUoZmlyc3QuZ2V0RnVsbFllYXIoKSwgZmlyc3QuZ2V0TW9udGgoKSArIDEsIDApLmdldERhdGUoKTsKICAgIHJldHVybiBkYXRlS2V5KG5ldyBEYXRlKGZpcnN0LmdldEZ1bGxZZWFyKCksIGZpcnN0LmdldE1vbnRoKCksIE1hdGgubWluKGQsIGxhc3QpKSk7CiAgfQoKICAvLyBUaGUgZGF5cyBmcm9tIHN0YXJ0IHVwIHRvLCBub3QgaW5jbHVkaW5nLCBlbmQuCiAgZnVuY3Rpb24gZGF5cyhzdGFydCwgZW5kKSB7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAobGV0IGsgPSBzdGFydDsgayA8IGVuZDsgayA9IGFkZERheXMoaywgMSkpIG91dC5wdXNoKGspOwogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIOKUgOKUgCBWaWV3cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgVklFV1MgPSBbJ3dlZWs",
"nLCAnbW9udGgnLCAnYWdlbmRhJ107CgogIC8vIFdoYXQgYSB2aWV3IHNob3dzIGFyb3VuZCB0aGUgZGF5IGluIGZvY3VzOiB0aGUgd2VlayBpdCBpcyBpbjsgaXRzCiAgLy8gbW9udGgsIGFzIHdob2xlIHdlZWtzOyBvciwgZm9yIHRoZSBhZ2VuZGEsIGZvdXIgd2Vla3MgZnJvbSB0aGF0IGRheS4KICAvLyBlbmQgaXMgdGhlIGRheSBhZnRlciB0aGUgbGFzdC4KICBmdW5jdGlvbiB2aWV3UmFuZ2UodmlldywgYW5jaG9yKSB7CiAgICBpZiAodmlldyA9PT0gJ21vbnRoJykgewogICAgICBjb25zdCBmaXJzdCA9IG1vbnRoU3RhcnQoYW5jaG9yKTsKICAgICAgY29uc3QgbGFzdCA9IGFkZERheXMoYWRkTW9udGhzKGZpcnN0LCAxKSwgLTEpOwogICAgICByZXR1cm4geyBzdGFydDogd2Vla1N0YXJ0KGZpcnN0KSwgZW5kOiBhZGREYXlzKHdlZWtTdGFydChsYXN0KSwgNykgfTsKICAgIH0KICAgIGlmICh2aWV3ID09PSAnYWdlbmRhJykgcmV0dXJuIHsgc3RhcnQ6IGFuY2hvciwgZW5kOiBhZGREYXlzKGFuY2hvciwgQUdFTkRBX0RBWVMpIH07CiAgICBjb25zdCBzdGFydCA9IHdlZWtTdGFydChhbmNob3IpOwogICAgcmV0dXJuIHsgc3RhcnQsIGVuZDogYWRkRGF5cyhzdGFydCwgNykgfTsKICB9CgogIGZ1bmN0aW9uIHN0ZXAodmlldywgYW5jaG9yLCBkaXIpIHsKICAgIGlmICh2aWV3ID09PSAnbW9udGgnKSByZXR1cm4gYWRkTW9udGhzKGFuY2hvciwgZGlyKTsKICAgIGlmICh2aWV3ID09PSAnYWdlbmRhJykgcmV0dXJuIGF",
"kZERheXMoYW5jaG9yLCBkaXIgKiBBR0VOREFfREFZUyk7CiAgICByZXR1cm4gYWRkRGF5cyhhbmNob3IsIGRpciAqIDcpOwogIH0KCiAgLy8gVGhlIG1vbnRoIGFzIHJvd3Mgb2Ygc2V2ZW4gZGF5cywgZm9yIHRoZSBzbWFsbCBjYWxlbmRhci4KICBmdW5jdGlvbiBtb250aFdlZWtzKGFuY2hvcikgewogICAgY29uc3QgeyBzdGFydCwgZW5kIH0gPSB2aWV3UmFuZ2UoJ21vbnRoJywgYW5jaG9yKTsKICAgIGNvbnN0IGFsbCA9IGRheXMoc3RhcnQsIGVuZCk7CiAgICBjb25zdCByb3dzID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGFsbC5sZW5ndGg7IGkgKz0gNykgcm93cy5wdXNoKGFsbC5zbGljZShpLCBpICsgNykpOwogICAgcmV0dXJuIHJvd3M7CiAgfQoKICAvLyAiMjggU2VwIOKAkyA0IE9jdCIsICI1IOKAkyAxMSBPY3QiLCB3aXRoIHRoZSB5ZWFyIHdoZW4gaXQgaXMgbm90IHRoaXMgb25lLgogIGZ1bmN0aW9uIHNwYW5UZXh0KGZpcnN0LCBsYXN0LCB0b2RheSkgewogICAgY29uc3QgW3kxLCBtMSwgZDFdID0gZmlyc3Quc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIGNvbnN0IFt5MiwgbTIsIGQyXSA9IGxhc3Quc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIGNvbnN0IHRoaXNZZWFyID0gTnVtYmVyKFN0cmluZyh0b2RheSkuc2xpY2UoMCwgNCkpOwogICAgY29uc3QgeWVhciA9IHkgPT4gKHkgIT09IHRoaXNZZWFyID8gYCAke3l9YCA6ICcnKTsKICAgIGlmIChmaXJzdCA9PT0gbGFzdCkgcmV0dXJ",
"uIGAke2QxfSAke01PTlRIU1ttMSAtIDFdfSR7eWVhcih5MSl9YDsKICAgIGlmICh5MSAhPT0geTIpIHJldHVybiBgJHtkMX0gJHtNT05USFNbbTEgLSAxXX0gJHt5MX0g4oCTICR7ZDJ9ICR7TU9OVEhTW20yIC0gMV19ICR7eTJ9YDsKICAgIGlmIChtMSA9PT0gbTIpIHJldHVybiBgJHtkMX0g4oCTICR7ZDJ9ICR7TU9OVEhTW20yIC0gMV19JHt5ZWFyKHkyKX1gOwogICAgcmV0dXJuIGAke2QxfSAke01PTlRIU1ttMSAtIDFdfSDigJMgJHtkMn0gJHtNT05USFNbbTIgLSAxXX0ke3llYXIoeTIpfWA7CiAgfQoKICAvLyBgc2hvcnRgOiBvbiBhIHBob25lLCB3aGVyZSB0aGUgd2VlaydzIG51bWJlciBkb2VzIG5vdCBmaXQgYmVzaWRlIGl0cwogIC8vIGRheXMuCiAgZnVuY3Rpb24gdGl0bGUodmlldywgYW5jaG9yLCB0b2RheSwgeyBzaG9ydCA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKHZpZXcgPT09ICdtb250aCcpIHsKICAgICAgY29uc3QgW3ksIG1dID0gYW5jaG9yLnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICAgIHJldHVybiBgJHtNT05USFNfTE9OR1ttIC0gMV19ICR7eX1gOwogICAgfQogICAgY29uc3QgeyBzdGFydCwgZW5kIH0gPSB2aWV3UmFuZ2UodmlldywgYW5jaG9yKTsKICAgIGNvbnN0IHNwYW4gPSBzcGFuVGV4dChzdGFydCwgYWRkRGF5cyhlbmQsIC0xKSwgdG9kYXkpOwogICAgcmV0dXJuIHZpZXcgPT09ICd3ZWVrJyAmJiAhc2hvcnQgPyBgV2VlayAke2lzb1dlZWsoYW5jaG9yKX0gwrcgJHtzcGF",
"ufWAgOiBzcGFuOwogIH0KCiAgZnVuY3Rpb24gbW9udGhOYW1lKGtleSkgewogICAgY29uc3QgW3ksIG1dID0ga2V5LnNwbGl0KCctJykubWFwKE51bWJlcik7CiAgICByZXR1cm4geyBsb25nOiBNT05USFNfTE9OR1ttIC0gMV0sIHNob3J0OiBNT05USFNbbSAtIDFdLCB5ZWFyOiB5IH07CiAgfQoKICBmdW5jdGlvbiBkYXlOYW1lKGtleSkgewogICAgcmV0dXJuIERBWV9OQU1FU1t3ZWVrZGF5KGtleSldOwogIH0KCiAgLy8g4pSA4pSAIFNvdXJjZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIHNhZmVDb2xvdXIoYykgewogICAgcmV0dXJuIC9eI1swLTlhLWZdezZ9JC9pLnRlc3QoU3RyaW5nKGMgfHwgJycpKSA_IFN0cmluZyhjKS50b0xvd2VyQ2FzZSgpIDogJyc7CiAgfQoKICAvLyBPbmx5IHBsYWluIGh0dHBzIGxpbmtzIGFyZSBldmVyIHB1dCBvbiB0aGUgcGFnZS4KICBmdW5jdGlvbiBzYWZlTGluayh1cmwpIHsKICAgIHJldHVybiAvXmh0dHBzOlwvXC9bXlxzXSskL2kudGVzdChTdHJpbmcodXJsIHx8ICcnKSkgPyBTdHJpbmcodXJsKSA6ICcnOwogIH0KCiAgLy8gQSBjYWxlbmRhciBmcm9tIGNhbGVuZGFyTGlzdC4gR29vZ2x",
"lJ3Mgb3duICJzaG93IGluIHRoZSBsaXN0IiBjaG9pY2UKICAvLyAoc2VsZWN0ZWQpIGRlY2lkZXMgd2hldGhlciBpdCBpcyBvbiB1bnRpbCBzb21lb25lIHNheXMgb3RoZXJ3aXNlIGhlcmU7CiAgLy8gY2FsZW5kYXJzIGhpZGRlbiBmcm9tIEdvb2dsZSdzIGxpc3QgYXJlIGxlZnQgb3V0LiBUaGUgbWFpbiBjYWxlbmRhcgogIC8vIGlzIHVzdWFsbHkgbmFtZWQgYWZ0ZXIgdGhlIGFkZHJlc3MsIG9mIHdoaWNoIHRoZSBuYW1lIHBhcnQgd2lsbCBkby4KICBmdW5jdGlvbiBjYWxlbmRhclNvdXJjZShjKSB7CiAgICBpZiAoIWMgfHwgIWMuaWQgfHwgYy5oaWRkZW4pIHJldHVybiBudWxsOwogICAgbGV0IG5hbWUgPSBTdHJpbmcoYy5zdW1tYXJ5T3ZlcnJpZGUgfHwgYy5zdW1tYXJ5IHx8IGMuaWQpLnRyaW0oKTsKICAgIGlmIChjLnByaW1hcnkgJiYgbmFtZS5pbmNsdWRlcygnQCcpKSBuYW1lID0gbmFtZS5zcGxpdCgnQCcpWzBdOwogICAgcmV0dXJuIHsKICAgICAga2luZDogJ2NhbGVuZGFyJywgaWQ6IFN0cmluZyhjLmlkKSwgbmFtZSwKICAgICAgY29sb3VyOiBzYWZlQ29sb3VyKGMuYmFja2dyb3VuZENvbG9yKSB8fCAnIzFhNzNlOCcsCiAgICAgIHByaW1hcnk6ICEhYy5wcmltYXJ5LCBvbjogYy5zZWxlY3RlZCAhPT0gZmFsc2UsCiAgICAgIC8vIEhvbGlkYXlzLCBiaXJ0aGRheXMgYW5kIGNhbGVuZGFycyBzaGFyZWQgcmVhZC1vbmx5IHN0YXkgcmVhZC1vbmx5LgogICAgICB3cml0YWJsZTogYy5hY2Nlc3NSb2xlID0",
"9PSAnb3duZXInIHx8IGMuYWNjZXNzUm9sZSA9PT0gJ3dyaXRlcicsCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gbGlzdFNvdXJjZShsKSB7CiAgICBpZiAoIWwgfHwgIWwuaWQpIHJldHVybiBudWxsOwogICAgcmV0dXJuIHsga2luZDogJ3Rhc2tzJywgaWQ6IFN0cmluZyhsLmlkKSwgbmFtZTogU3RyaW5nKGwudGl0bGUgfHwgJycpLnRyaW0oKSB8fCAnVGFza3MnLCBvbjogdHJ1ZSwgd3JpdGFibGU6IHRydWUgfTsKICB9CgogIC8vIFRoZSBtYWluIGNhbGVuZGFyIGZpcnN0LCB0aGVuIHRoZSByZXN0IGFzIEdvb2dsZSBsaXN0cyB0aGVtLCB0aGVuCiAgLy8gdGhlIHRhc2sgbGlzdHMuCiAgZnVuY3Rpb24gc291cmNlcyhjYWxlbmRhckl0ZW1zLCBsaXN0SXRlbXMpIHsKICAgIGNvbnN0IGNhbHMgPSAoY2FsZW5kYXJJdGVtcyB8fCBbXSkubWFwKGNhbGVuZGFyU291cmNlKS5maWx0ZXIoQm9vbGVhbik7CiAgICBjYWxzLnNvcnQoKGEsIGIpID0-IE51bWJlcihiLnByaW1hcnkpIC0gTnVtYmVyKGEucHJpbWFyeSkpOwogICAgcmV0dXJuIGNhbHMuY29uY2F0KChsaXN0SXRlbXMgfHwgW10pLm1hcChsaXN0U291cmNlKS5maWx0ZXIoQm9vbGVhbikpOwogIH0KCiAgLy8gVGhlIHN3aXRjaCBzb21lb25lIGZsaWNrZWQgaGVyZSB3aW5zIG92ZXIgR29vZ2xlJ3MgZGVmYXVsdC4KICBmdW5jdGlvbiBpc09uKHNvdXJjZSwgb3ZlcnJpZGVzKSB7CiAgICBjb25zdCBvID0gb3ZlcnJpZGVzICYmIE9iamVjdC5wcm90b3R5cGUuaGFzT3d",
"uUHJvcGVydHkuY2FsbChvdmVycmlkZXMsIHNvdXJjZS5pZCkgPyBvdmVycmlkZXNbc291cmNlLmlkXSA6IHVuZGVmaW5lZDsKICAgIHJldHVybiB0eXBlb2YgbyA9PT0gJ2Jvb2xlYW4nID8gbyA6IHNvdXJjZS5vbjsKICB9CgogIC8vIOKUgOKUgCBSZXF1ZXN0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgQ0FMRU5EQVJfTElTVF9GSUVMRFMgPSAnaXRlbXMoaWQsc3VtbWFyeSxzdW1tYXJ5T3ZlcnJpZGUsYmFja2dyb3VuZENvbG9yLHNlbGVjdGVkLGhpZGRlbixwcmltYXJ5LGFjY2Vzc1JvbGUpJzsKICBjb25zdCBFVkVOVF9GSUVMRFMgPSAnaXRlbXMoaWQsZXRhZyxzdGF0dXMsc3VtbWFyeSxzdGFydCxlbmQsaHRtbExpbmssY29sb3JJZCxldmVudFR5cGUsbG9jYXRpb24sJyArCiAgICAnb3JnYW5pemVyKHNlbGYpLGd1ZXN0c0Nhbk1vZGlmeSxyZWN1cnJpbmdFdmVudElkKSxuZXh0UGFnZVRva2VuJzsKCiAgZnVuY3Rpb24gc291cmNlUmVxdWVzdHMoKSB7CiAgICByZXR1cm4gWwogICAgICBbJ2NhbGVuZGFyJywgJ3VzZXJzL21lL2NhbGVuZGFyTGlzdCcsIHsgbWluQWNjZXNzUm9sZTogJ3JlYWRlcicsIG1heFJlc3VsdHM6IDI1MCwgZml",
"lbGRzOiBDQUxFTkRBUl9MSVNUX0ZJRUxEUyB9XSwKICAgICAgWyd0YXNrcycsICd1c2Vycy9AbWUvbGlzdHMnLCB7IG1heFJlc3VsdHM6IDEwMCB9XSwKICAgIF07CiAgfQoKICAvLyBGb3IgZWFjaCBjYWxlbmRhciwgaXRzIGV2ZW50cyBpbiB0aGUgcmFuZ2UgKGEgZGF5IGVpdGhlciBzaWRlLCBmb3IKICAvLyBjYWxlbmRhcnMgaW4gYW5vdGhlciB0aW1lIHpvbmU7IHRoZSBkYXlzIGFyZSBzb3J0ZWQgb3V0IGhlcmUpLiBGb3IKICAvLyBlYWNoIHRhc2sgbGlzdCwgaXRzIG9wZW4gdGFza3MgLSBkYXRlZCBvciBub3QsIGZvciB0aGUgIk5vIGRhdGUiIHRyYXkKICAvLyBhbmQgYW55dGhpbmcgb3ZlcmR1ZSAtIGFuZCB0aGUgb25lcyBkb25lIHdpdGhpbiB0aGUgcmFuZ2UuIEdvb2dsZSdzCiAgLy8gb3duIGFwcHMgaGlkZSBhIHRhc2sgd2hlbiBpdCBpcyB0aWNrZWQsIGhlbmNlIHNob3dIaWRkZW4uCiAgZnVuY3Rpb24gcmFuZ2VSZXF1ZXN0cyhyYW5nZSwgY2FsZW5kYXJzLCBsaXN0cykgewogICAgY29uc3QgZnJvbSA9IGFkZERheXMocmFuZ2Uuc3RhcnQsIC0xKTsKICAgIGNvbnN0IHRvID0gYWRkRGF5cyhyYW5nZS5lbmQsIDEpOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGNvbnN0IGMgb2YgY2FsZW5kYXJzKSB7CiAgICAgIG91dC5wdXNoKFsnY2FsZW5kYXInLCBgY2FsZW5kYXJzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGMuaWQpfS9ldmVudHNgLCB7CiAgICAgICAgdGltZU1pbjogZnJvbUtleShmcm9tKS5",
"0b0lTT1N0cmluZygpLCB0aW1lTWF4OiBmcm9tS2V5KHRvKS50b0lTT1N0cmluZygpLAogICAgICAgIHNpbmdsZUV2ZW50czogJ3RydWUnLCBvcmRlckJ5OiAnc3RhcnRUaW1lJywgbWF4UmVzdWx0czogMjUwMCwgZmllbGRzOiBFVkVOVF9GSUVMRFMsCiAgICAgIH1dKTsKICAgIH0KICAgIGZvciAoY29uc3QgbCBvZiBsaXN0cykgewogICAgICBjb25zdCBwYXRoID0gYGxpc3RzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGwuaWQpfS90YXNrc2A7CiAgICAgIG91dC5wdXNoKFsndGFza3MnLCBwYXRoLCB7IHNob3dDb21wbGV0ZWQ6ICdmYWxzZScsIG1heFJlc3VsdHM6IDEwMCB9XSk7CiAgICAgIG91dC5wdXNoKFsndGFza3MnLCBwYXRoLCB7CiAgICAgICAgc2hvd0NvbXBsZXRlZDogJ3RydWUnLCBzaG93SGlkZGVuOiAndHJ1ZScsIG1heFJlc3VsdHM6IDEwMCwKICAgICAgICBkdWVNaW46IGAke2Zyb219VDAwOjAwOjAwLjAwMFpgLCBkdWVNYXg6IGAke3RvfVQwMDowMDowMC4wMDBaYCwKICAgICAgfV0pOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vIOKUgOKUgCBJdGVtcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gR29vZ2x",
"lIENhbGVuZGFyJ3Mgb3duIGV2ZW50IGNvbG91cnMsIGJ5IGNvbG9ySWQuCiAgY29uc3QgRVZFTlRfQ09MT1VSUyA9IHsKICAgIDE6ICcjNzk4NmNiJywgMjogJyMzM2I2NzknLCAzOiAnIzhlMjRhYScsIDQ6ICcjZTY3YzczJywgNTogJyNmNmJmMjYnLCA2OiAnI2Y0NTExZScsCiAgICA3OiAnIzAzOWJlNScsIDg6ICcjNjE2MTYxJywgOTogJyMzZjUxYjUnLCAxMDogJyMwYjgwNDMnLCAxMTogJyNkNTAwMDAnLAogIH07CgogIC8vIEFuIGV2ZW50LCBvbiBldmVyeSBkYXkgaXQgY292ZXJzIChmaXJzdCB0byBsYXN0LCBib3RoIGluY2x1ZGVkKS4KICAvLyBXb3JraW5nLWxvY2F0aW9uIGVudHJpZXMgKCJIb21lIiwgIk9mZmljZSIpIGFyZSBsZWZ0IG91dDogdGhleSBhcmUKICAvLyBvbiBldmVyeSBkYXkgYW5kIHNheSBub3RoaW5nIGEgZ2xhbmNlIG5lZWRzLgogIGZ1bmN0aW9uIGV2ZW50SXRlbShldiwgY2FsKSB7CiAgICBpZiAoIWV2IHx8IGV2LnN0YXR1cyA9PT0gJ2NhbmNlbGxlZCcgfHwgZXYuZXZlbnRUeXBlID09PSAnd29ya2luZ0xvY2F0aW9uJykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBzID0gZXYuc3RhcnQgfHwge307CiAgICBjb25zdCBlID0gZXYuZW5kIHx8IHt9OwogICAgY29uc3QgYmFzZSA9IHsKICAgICAga2luZDogJ2V2ZW50JywgaWQ6IGAke2NhbC5pZH18JHtldi5pZH1gLCBzb3VyY2U6IGNhbC5pZCwgZXZlbnRJZDogU3RyaW5nKGV2LmlkKSwgZXRhZzogU3RyaW5nKGV2LmV0YWcgfHwgJycpLAo",
"gICAgICB0aXRsZTogU3RyaW5nKGV2LnN1bW1hcnkgfHwgJycpLnRyaW0oKSB8fCAnKE5vIHRpdGxlKScsCiAgICAgIGNvbG91cjogRVZFTlRfQ09MT1VSU1tldi5jb2xvcklkXSB8fCBjYWwuY29sb3VyLAogICAgICBsaW5rOiBzYWZlTGluayhldi5odG1sTGluayksIHdoZXJlOiBTdHJpbmcoZXYubG9jYXRpb24gfHwgJycpLnRyaW0oKSwKICAgICAgLy8gQ2hhbmdlZCBoZXJlIG9ubHkgb24gYSBjYWxlbmRhciB0aGF0IG1heSBiZSBjaGFuZ2VkLCBhbmQgb25seSBhbgogICAgICAvLyBvcmRpbmFyeSBldmVudDogbm90IGEgYmlydGhkYXkgb3IgYW4gb3V0LW9mLW9mZmljZSwgYW5kIG5vdCBvbmUKICAgICAgLy8gc29tZW9uZSBlbHNlIG9yZ2FuaXNlcyB1bmxlc3MgdGhleSBsZXQgZ3Vlc3RzIGNoYW5nZSBpdC4KICAgICAgZWRpdGFibGU6ICEhY2FsLndyaXRhYmxlICYmICghZXYuZXZlbnRUeXBlIHx8IGV2LmV2ZW50VHlwZSA9PT0gJ2RlZmF1bHQnKSAmJgogICAgICAgICghZXYub3JnYW5pemVyIHx8IGV2Lm9yZ2FuaXplci5zZWxmID09PSB0cnVlIHx8IGV2Lmd1ZXN0c0Nhbk1vZGlmeSA9PT0gdHJ1ZSksCiAgICAgIC8vIE9uZSBvY2N1cnJlbmNlIG9mIGEgcmVwZWF0aW5nIGV2ZW50OiBhIGNoYW5nZSBpcyB0byB0aGlzIG9uZSBvbmx5LgogICAgICByZWN1cnJpbmc6ICEhZXYucmVjdXJyaW5nRXZlbnRJZCwKICAgICAgc2VyaWVzSWQ6IFN0cmluZyhldi5yZWN1cnJpbmdFdmVudElkIHx8ICcnKSwKICAgIH07CiA",
"gICBpZiAoaXNLZXkocy5kYXRlKSkgewogICAgICBjb25zdCBsYXN0ID0gaXNLZXkoZS5kYXRlKSA_IGFkZERheXMoZS5kYXRlLCAtMSkgOiBzLmRhdGU7CiAgICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJhc2UsIHsgYWxsRGF5OiB0cnVlLCBmaXJzdDogcy5kYXRlLCBsYXN0OiBsYXN0IDwgcy5kYXRlID8gcy5kYXRlIDogbGFzdCwgc3RhcnQ6IDAsIGVuZDogMCB9KTsKICAgIH0KICAgIGNvbnN0IHN0YXJ0ID0gRGF0ZS5wYXJzZShzLmRhdGVUaW1lKTsKICAgIGlmICghaXNGaW5pdGUoc3RhcnQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGVuZE1zID0gRGF0ZS5wYXJzZShlLmRhdGVUaW1lKTsKICAgIGNvbnN0IGVuZCA9IGlzRmluaXRlKGVuZE1zKSAmJiBlbmRNcyA-IHN0YXJ0ID8gZW5kTXMgOiBzdGFydDsKICAgIC8vIEFuIGV2ZW50IGVuZGluZyBhdCBtaWRuaWdodCBkb2VzIG5vdCBzcGlsbCBpbnRvIHRoZSBuZXh0IGRheS4KICAgIHJldHVybiBPYmplY3QuYXNzaWduKGJhc2UsIHsKICAgICAgYWxsRGF5OiBmYWxzZSwgc3RhcnQsIGVuZCwgZmlyc3Q6IGRhdGVLZXkoc3RhcnQpLCBsYXN0OiBkYXRlS2V5KE1hdGgubWF4KHN0YXJ0LCBlbmQgLSAxKSksCiAgICB9KTsKICB9CgogIC8vIEEgdGFzaywgb24gaXRzIGR1ZSBkYXkuIEdvb2dsZSBrZWVwcyBvbmx5IHRoZSBkYXRlIG9mIGEgZHVlIGRhdGUgKHRoZQogIC8vIHRpbWUgaXMgYWx3YXlzIG1pZG5pZ2h0IFVUQyksIHNvIHRoZSBkYXRlIGlzIHJlYWQgYXM",
"gd3JpdHRlbiwgbm90CiAgLy8gbW92ZWQgaW50byB0aGUgbG9jYWwgdGltZSB6b25lLiBBIHRhc2sgbWFkZSBmcm9tIGFuIGVtYWlsIGluIEdtYWlsCiAgLy8gbGlua3MgYmFjayB0byBpdC4KICBmdW5jdGlvbiB0YXNrSXRlbSh0LCBsaXN0KSB7CiAgICBpZiAoIXQgfHwgIXQuaWQgfHwgdC5kZWxldGVkKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHRpdGxlID0gU3RyaW5nKHQudGl0bGUgfHwgJycpLnRyaW0oKTsKICAgIGlmICghdGl0bGUpIHJldHVybiBudWxsOwogICAgY29uc3QgZHVlID0gL15cZHs0fS1cZHsyfS1cZHsyfS8udGVzdChTdHJpbmcodC5kdWUgfHwgJycpKSA_IFN0cmluZyh0LmR1ZSkuc2xpY2UoMCwgMTApIDogJyc7CiAgICBjb25zdCBtYWlsID0gKHQubGlua3MgfHwgW10pLmZpbmQobCA9PiBsICYmIGwudHlwZSA9PT0gJ2VtYWlsJyAmJiAvXmh0dHBzOlwvXC9tYWlsXC5nb29nbGVcLmNvbVwvLy50ZXN0KFN0cmluZyhsLmxpbmsgfHwgJycpKSk7CiAgICByZXR1cm4gewogICAgICBraW5kOiAndGFzaycsIGlkOiBgJHtsaXN0LmlkfXwke3QuaWR9YCwgc291cmNlOiBsaXN0LmlkLCB0YXNrSWQ6IFN0cmluZyh0LmlkKSwgdGl0bGUsIGR1ZSwKICAgICAgZG9uZTogdC5zdGF0dXMgPT09ICdjb21wbGV0ZWQnLCBlbWFpbDogISFtYWlsLAogICAgICBsaW5rOiBzYWZlTGluayhtYWlsID8gbWFpbC5saW5rIDogdC53ZWJWaWV3TGluayksIGxpc3Q6IGxpc3QubmFtZSwgZWRpdGFibGU6IHRydWUsCiAgICB",
"9OwogIH0KCiAgLy8gVGFza3MgYXJyaXZlIHR3aWNlIHdoZW4gb25lIGlzIGJvdGggb3BlbiBhbmQgZHVlIGluIHRoZSByYW5nZS4KICBmdW5jdGlvbiB1bmlxdWVCeUlkKGl0ZW1zKSB7CiAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogICAgcmV0dXJuIGl0ZW1zLmZpbHRlcih4ID0-ICFzZWVuLmhhcyh4LmlkKSAmJiBzZWVuLmFkZCh4LmlkKSk7CiAgfQoKICAvLyBBbGwtZGF5IGZpcnN0LCB0aGVuIGJ5IHRpbWUsIHRoZW4gdGhlIHRhc2tzOiBvcGVuIGJlZm9yZSBkb25lLgogIGZ1bmN0aW9uIGNvbXBhcmVJdGVtcyhhLCBiKSB7CiAgICBjb25zdCByYW5rID0geCA9PiAoeC5raW5kID09PSAnZXZlbnQnID8gKHguYWxsRGF5ID8gMCA6IDEpIDogKHguZG9uZSA_IDMgOiAyKSk7CiAgICByZXR1cm4gcmFuayhhKSAtIHJhbmsoYikgfHwgKGEuc3RhcnQgfHwgMCkgLSAoYi5zdGFydCB8fCAwKSB8fCBhLnRpdGxlLmxvY2FsZUNvbXBhcmUoYi50aXRsZSk7CiAgfQoKICAvLyBEYXkga2V5IOKGkiB3aGF0IGlzIG9uIGl0LCBlYWNoIGVudHJ5IHsgaXRlbSwgY29udCB9OiBjb250IHdoZW4gYQogIC8vIHRpbWVkIGV2ZW50IHN0YXJ0ZWQgb24gYW4gZWFybGllciBkYXkuCiAgZnVuY3Rpb24gYnlEYXkoaXRlbXMsIGRheUtleXMpIHsKICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoZGF5S2V5cy5tYXAoayA9PiBbaywgW11dKSk7CiAgICBpZiAoIWRheUtleXMubGVuZ3RoKSByZXR1cm4gb3V0OwogICAgY29uc3QgZmlyc3QgPSB",
"kYXlLZXlzWzBdOwogICAgY29uc3QgbGFzdCA9IGRheUtleXNbZGF5S2V5cy5sZW5ndGggLSAxXTsKICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykgewogICAgICBpZiAoaXRlbS5raW5kID09PSAndGFzaycpIHsKICAgICAgICBpZiAoaXRlbS5kdWUgJiYgb3V0LmhhcyhpdGVtLmR1ZSkpIG91dC5nZXQoaXRlbS5kdWUpLnB1c2goeyBpdGVtLCBjb250OiBmYWxzZSB9KTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICBpZiAoaXRlbS5sYXN0IDwgZmlyc3QgfHwgaXRlbS5maXJzdCA-IGxhc3QpIGNvbnRpbnVlOwogICAgICBjb25zdCBmcm9tID0gaXRlbS5maXJzdCA8IGZpcnN0ID8gZmlyc3QgOiBpdGVtLmZpcnN0OwogICAgICBjb25zdCB0byA9IGl0ZW0ubGFzdCA-IGxhc3QgPyBsYXN0IDogaXRlbS5sYXN0OwogICAgICBmb3IgKGxldCBrID0gZnJvbTsgayA8PSB0bzsgayA9IGFkZERheXMoaywgMSkpIHsKICAgICAgICBpZiAob3V0LmhhcyhrKSkgb3V0LmdldChrKS5wdXNoKHsgaXRlbSwgY29udDogayAhPT0gaXRlbS5maXJzdCB9KTsKICAgICAgfQogICAgfQogICAgZm9yIChjb25zdCBsaXN0IG9mIG91dC52YWx1ZXMoKSkgbGlzdC5zb3J0KChhLCBiKSA9PiBjb21wYXJlSXRlbXMoYS5pdGVtLCBiLml0ZW0pKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBXaGF0IHdhaXRzIHVuZGVyIHRoZSB3ZWVrOiBvcGVuIHRhc2tzIHdpdGggbm8gZGF0ZSwgYW5kIG9wZW4gdGFza3MKICAvLyB3aG9zZSB",
"kYXkgaGFzIGdvbmUgYnkuCiAgZnVuY3Rpb24gdHJheShpdGVtcywgdG9kYXkpIHsKICAgIGNvbnN0IG9wZW4gPSBpdGVtcy5maWx0ZXIoeCA9PiB4LmtpbmQgPT09ICd0YXNrJyAmJiAheC5kb25lKTsKICAgIHJldHVybiB7CiAgICAgIG92ZXJkdWU6IG9wZW4uZmlsdGVyKHggPT4geC5kdWUgJiYgeC5kdWUgPCB0b2RheSkuc29ydCgoYSwgYikgPT4gYS5kdWUubG9jYWxlQ29tcGFyZShiLmR1ZSkgfHwgYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpKSwKICAgICAgdW5kYXRlZDogb3Blbi5maWx0ZXIoeCA9PiAheC5kdWUpLAogICAgfTsKICB9CgogIC8vIOKUgOKUgCBDaGFuZ2VzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gV2hhdCB0aGUgY2FsZW5kYXIgc2VuZHMgdG8gR29vZ2xlIHRvIGFkZCwgY2hhbmdlIG9yIG1vdmUgb25lIGV2ZW50IG9yCiAgLy8gb25lIHRhc2ssIGJ1aWx0IGhlcmUgc28gdGhhdCBOb2RlJ3MgdGVzdHMgY2FuIGNoZWNrIHRoZW0uIEEgdGltZSBpcwogIC8vIGxvY2FsIHRpbWUgb24gdGhlIDI0LWhvdXIgY2xvY2ssIHNlbnQgd2l0aCB0aGUgb2Zmc2V0IHRoYXQgZGF5IGhhcyBhbmQKICAvLyB0aGUgYnJ",
"vd3NlcidzIHRpbWUgem9uZSwgc28gR29vZ2xlIGtlZXBzIHRoZSBldmVudCB3aGVyZSBpdCB3YXMgcHV0LgoKICAvLyAiMDk6MzAiIGZyb20gIjk6MzAiIG9yICI5LjMwIjsgJycgZm9yIGFueXRoaW5nIHRoYXQgaXMgbm90IGEgdGltZS4KICBmdW5jdGlvbiBub3JtVGltZShzKSB7CiAgICBjb25zdCBtID0gL15ccyooXGR7MSwyfSlbOi5dKFxkezJ9KVxzKiQvLmV4ZWMoU3RyaW5nKHMgfHwgJycpKTsKICAgIGlmICghbSB8fCBOdW1iZXIobVsxXSkgPiAyMyB8fCBOdW1iZXIobVsyXSkgPiA1OSkgcmV0dXJuICcnOwogICAgcmV0dXJuIGAke3BhZChOdW1iZXIobVsxXSkpfToke21bMl19YDsKICB9CgogIGNvbnN0IG1pbnV0ZXMgPSB0ID0-IE51bWJlcih0LnNsaWNlKDAsIDIpKSAqIDYwICsgTnVtYmVyKHQuc2xpY2UoMywgNSkpOwogIGNvbnN0IGNsb2NrID0gbSA9PiBgJHtwYWQoTWF0aC5mbG9vcihtIC8gNjApKX06JHtwYWQobSAlIDYwKX1gOwoKICAvLyBXaGF0IHdhcyB0eXBlZCBpbnRvIHRoZSBhZGQgYm94OiAiRGVudGlzdCAxNDozMCIsICJDYWxsIFNhbSBhdAogIC8vIDkuMTUtMTA6MDAiLiBUaGUgdGltZSAob3IgdGhlIHR3bykgY29tZXMgb3V0LCBhbmQgd2hhdCBpcyBsZWZ0IGlzIHRoZQogIC8vIHRpdGxlLiBXaXRoIG5vIGVuZCwgYW4gaG91ciwgYnV0IG5vdCBwYXN0IG1pZG5pZ2h0LgogIGZ1bmN0aW9uIHBhcnNlUXVpY2sodGV4dCkgewogICAgY29uc3QgcyA9IFN0cmluZyh0ZXh0IHx8ICcnKTsKICA",
"gIGNvbnN0IHJlID0gLyhefFxzKSg_OmF0XHMrKT8oXGR7MSwyfVs6Ll1cZHsyfSkoPzpccypbLeKAk11ccyooXGR7MSwyfVs6Ll1cZHsyfSkpPyg_PSR8W1xzLDshP10pL2k7CiAgICBjb25zdCBtID0gcmUuZXhlYyhzKTsKICAgIGNvbnN0IHN0YXJ0ID0gbSA_IG5vcm1UaW1lKG1bMl0pIDogJyc7CiAgICBpZiAoIXN0YXJ0KSByZXR1cm4geyB0aXRsZTogcy50cmltKCksIHN0YXJ0OiAnJywgZW5kOiAnJyB9OwogICAgbGV0IGVuZCA9IG1bM10gPyBub3JtVGltZShtWzNdKSA6ICcnOwogICAgaWYgKCFlbmQgfHwgbWludXRlcyhlbmQpIDw9IG1pbnV0ZXMoc3RhcnQpKSBlbmQgPSBjbG9jayhNYXRoLm1pbihtaW51dGVzKHN0YXJ0KSArIDYwLCAyMyAqIDYwICsgNTkpKTsKICAgIGNvbnN0IHRpdGxlID0gKHMuc2xpY2UoMCwgbS5pbmRleCkgKyBtWzFdICsgcy5zbGljZShtLmluZGV4ICsgbVswXS5sZW5ndGgpKQogICAgICAucmVwbGFjZSgvXHMrL2csICcgJykucmVwbGFjZSgvXHMrKFssO10pL2csICckMScpLnJlcGxhY2UoL1tccyw7XSskLywgJycpLnRyaW0oKTsKICAgIHJldHVybiB7IHRpdGxlLCBzdGFydCwgZW5kIH07CiAgfQoKICAvLyAiMjAyNi0xMC0wNVQxNDozMDowMCswMTowMCI6IGEgZGF5IGFuZCBhIHRpbWUgaGVyZSwgYXMgR29vZ2xlIHdhbnRzIGl0LgogIGZ1bmN0aW9uIGxvY2FsU3RhbXAoZGF5LCB0aW1lKSB7CiAgICBjb25zdCBbeSwgbW8sIGRdID0gZGF5LnNwbGl0KCctJykubWFwKE51bWJlcik",
"7CiAgICBjb25zdCBhdCA9IG5ldyBEYXRlKHksIG1vIC0gMSwgZCwgTnVtYmVyKHRpbWUuc2xpY2UoMCwgMikpLCBOdW1iZXIodGltZS5zbGljZSgzLCA1KSkpOwogICAgY29uc3Qgb2ZmID0gLWF0LmdldFRpbWV6b25lT2Zmc2V0KCk7CiAgICBjb25zdCBhID0gTWF0aC5hYnMob2ZmKTsKICAgIHJldHVybiBgJHtkYXl9VCR7dGltZX06MDAke29mZiA8IDAgPyAnLScgOiAnKyd9JHtwYWQoTWF0aC5mbG9vcihhIC8gNjApKX06JHtwYWQoYSAlIDYwKX1gOwogIH0KCiAgY29uc3QgY2xvY2tPZiA9IG1zID0-IHsgY29uc3QgZCA9IG5ldyBEYXRlKG1zKTsgcmV0dXJuIGAke3BhZChkLmdldEhvdXJzKCkpfToke3BhZChkLmdldE1pbnV0ZXMoKSl9YDsgfTsKCiAgLy8gQW4gZXZlbnQgb3IgYSB0YXNrIGFzIHRoZSBlZGl0b3Igc3RhcnRzIGl0OiBhbiBleGlzdGluZyBvbmUsIG9yIGEgbmV3CiAgLy8gb25lIG9uIGBkYXlgIGluIGBzb3VyY2VgIChhIGNhbGVuZGFyJ3Mgb3IgYSBsaXN0J3MgaWQpLgogIGZ1bmN0aW9uIGRyYWZ0T2YoaXRlbSkgewogICAgaWYgKGl0ZW0ua2luZCA9PT0gJ3Rhc2snKSByZXR1cm4geyBraW5kOiAndGFzaycsIHRpdGxlOiBpdGVtLnRpdGxlLCBzb3VyY2U6IGl0ZW0uc291cmNlLCBkYXk6IGl0ZW0uZHVlIHx8ICcnLCBkb25lOiAhIWl0ZW0uZG9uZSB9OwogICAgcmV0dXJuIHsKICAgICAga2luZDogJ2V2ZW50JywgdGl0bGU6IGl0ZW0udGl0bGUgPT09ICcoTm8gdGl0bGUpJyA_ICcnIDogaXRlbS5",
"0aXRsZSwgc291cmNlOiBpdGVtLnNvdXJjZSwgd2hlcmU6IGl0ZW0ud2hlcmUgfHwgJycsCiAgICAgIGFsbERheTogISFpdGVtLmFsbERheSwgZGF5OiBpdGVtLmZpcnN0LAogICAgICBlbmREYXk6IGl0ZW0uYWxsRGF5ID8gaXRlbS5sYXN0IDogZGF0ZUtleShpdGVtLmVuZCksCiAgICAgIHN0YXJ0OiBpdGVtLmFsbERheSA_ICcnIDogY2xvY2tPZihpdGVtLnN0YXJ0KSwgZW5kOiBpdGVtLmFsbERheSA_ICcnIDogY2xvY2tPZihpdGVtLmVuZCksCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gbmV3RHJhZnQoa2luZCwgZGF5LCBzb3VyY2UpIHsKICAgIHJldHVybiBraW5kID09PSAndGFzaycKICAgICAgPyB7IGtpbmQsIHRpdGxlOiAnJywgc291cmNlLCBkYXksIGRvbmU6IGZhbHNlIH0KICAgICAgOiB7IGtpbmQsIHRpdGxlOiAnJywgc291cmNlLCB3aGVyZTogJycsIGFsbERheTogZmFsc2UsIGRheSwgZW5kRGF5OiBkYXksIHN0YXJ0OiAnMDk6MDAnLCBlbmQ6ICcxMDowMCcgfTsKICB9CgogIC8vIEFuIGV2ZW50LCBmb3IgR29vZ2xlOiB7IGJvZHkgfSBvciB7IGVycm9yIH0gdG8gc2hvdy4gQSBjaGFuZ2UgY2xlYXJzCiAgLy8gd2hhdCBubyBsb25nZXIgYXBwbGllcyAoYW4gYWxsLWRheSBldmVudCdzIGRhdGVUaW1lLCBhIHRpbWVkIG9uZSdzCiAgLy8gZGF0ZSkgd2l0aCBudWxsczsgYSBuZXcgb25lIGxlYXZlcyBpdCBvdXQuIGByZWN1cnJlbmNlYCwgd2hlbiBnaXZlbiwKICAvLyBpcyB0aGUgZXZlbnQncyBydWxlIGx",
"pbmVzIChyZWN1cnJlbmNlV2l0aCkuCiAgZnVuY3Rpb24gZXZlbnRCb2R5KGQsIHRpbWVab25lLCB7IHBhdGNoID0gZmFsc2UsIHJlY3VycmVuY2UgfSA9IHt9KSB7CiAgICBjb25zdCB0aXRsZSA9IFN0cmluZyhkLnRpdGxlIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXRpdGxlKSByZXR1cm4geyBlcnJvcjogJ0dpdmUgaXQgYSB0aXRsZS4nIH07CiAgICBpZiAoIWlzS2V5KGQuZGF5KSkgcmV0dXJuIHsgZXJyb3I6ICdDaG9vc2UgYSBkYXkuJyB9OwogICAgY29uc3QgYm9keSA9IHsgc3VtbWFyeTogdGl0bGUsIGxvY2F0aW9uOiBTdHJpbmcoZC53aGVyZSB8fCAnJykudHJpbSgpIH07CiAgICBpZiAoIXBhdGNoICYmICFib2R5LmxvY2F0aW9uKSBkZWxldGUgYm9keS5sb2NhdGlvbjsKICAgIGlmIChyZWN1cnJlbmNlICE9PSB1bmRlZmluZWQpIGJvZHkucmVjdXJyZW5jZSA9IHJlY3VycmVuY2U7CiAgICBjb25zdCBlbmREYXkgPSBpc0tleShkLmVuZERheSkgJiYgZC5lbmREYXkgPj0gZC5kYXkgPyBkLmVuZERheSA6IGQuZGF5OwogICAgaWYgKGQuYWxsRGF5KSB7CiAgICAgIGJvZHkuc3RhcnQgPSB7IGRhdGU6IGQuZGF5IH07CiAgICAgIGJvZHkuZW5kID0geyBkYXRlOiBhZGREYXlzKGVuZERheSwgMSkgfTsKICAgICAgaWYgKHBhdGNoKSB7IGJvZHkuc3RhcnQuZGF0ZVRpbWUgPSBudWxsOyBib2R5LmVuZC5kYXRlVGltZSA9IG51bGw7IH0KICAgICAgcmV0dXJuIHsgYm9keSB9OwogICAgfQogICAgY29uc3Qgc3RhcnQ",
"gPSBub3JtVGltZShkLnN0YXJ0KTsKICAgIGNvbnN0IGVuZCA9IG5vcm1UaW1lKGQuZW5kKTsKICAgIGlmICghc3RhcnQpIHJldHVybiB7IGVycm9yOiAnVGhlIHN0YXJ0IHRpbWUgaXMgaG91cnMgYW5kIG1pbnV0ZXMsIGFzIDA5OjMwLicgfTsKICAgIGlmICghZW5kKSByZXR1cm4geyBlcnJvcjogJ1RoZSBlbmQgdGltZSBpcyBob3VycyBhbmQgbWludXRlcywgYXMgMTA6MzAuJyB9OwogICAgY29uc3QgYSA9IGxvY2FsU3RhbXAoZC5kYXksIHN0YXJ0KTsKICAgIGNvbnN0IGIgPSBsb2NhbFN0YW1wKGVuZERheSwgZW5kKTsKICAgIGlmIChEYXRlLnBhcnNlKGIpIDw9IERhdGUucGFyc2UoYSkpIHJldHVybiB7IGVycm9yOiAnSXQgaGFzIHRvIGVuZCBhZnRlciBpdCBzdGFydHMuJyB9OwogICAgYm9keS5zdGFydCA9IHsgZGF0ZVRpbWU6IGEgfTsKICAgIGJvZHkuZW5kID0geyBkYXRlVGltZTogYiB9OwogICAgaWYgKHRpbWVab25lKSB7IGJvZHkuc3RhcnQudGltZVpvbmUgPSB0aW1lWm9uZTsgYm9keS5lbmQudGltZVpvbmUgPSB0aW1lWm9uZTsgfQogICAgaWYgKHBhdGNoKSB7IGJvZHkuc3RhcnQuZGF0ZSA9IG51bGw7IGJvZHkuZW5kLmRhdGUgPSBudWxsOyB9CiAgICByZXR1cm4geyBib2R5IH07CiAgfQoKICAvLyBBIHRhc2ssIGZvciBHb29nbGU6IGRvbmUgb3Igbm90IGdvZXMgaW4gd2l0aCBhIGNoYW5nZSwgbm90IGEgbmV3IG9uZS4KICBmdW5jdGlvbiB0YXNrQm9keShkLCB7IHBhdGNoID0gZmFsc2UgfSA9IHt",
"9KSB7CiAgICBjb25zdCB0aXRsZSA9IFN0cmluZyhkLnRpdGxlIHx8ICcnKS50cmltKCk7CiAgICBpZiAoIXRpdGxlKSByZXR1cm4geyBlcnJvcjogJ0dpdmUgaXQgYSB0aXRsZS4nIH07CiAgICBjb25zdCBib2R5ID0geyB0aXRsZSwgZHVlOiBpc0tleShkLmRheSkgPyBgJHtkLmRheX1UMDA6MDA6MDAuMDAwWmAgOiBudWxsIH07CiAgICBpZiAoIXBhdGNoICYmICFib2R5LmR1ZSkgZGVsZXRlIGJvZHkuZHVlOwogICAgaWYgKHBhdGNoKSBPYmplY3QuYXNzaWduKGJvZHksIHRpY2tCb2R5KCEhZC5kb25lKSk7CiAgICByZXR1cm4geyBib2R5IH07CiAgfQoKICAvLyBUaWNrZWQsIG9yIG5vdDogR29vZ2xlIHN0YW1wcyB0aGUgdGltZSBpdCB3YXMgZG9uZSBpdHNlbGYuCiAgZnVuY3Rpb24gdGlja0JvZHkoZG9uZSkgewogICAgcmV0dXJuIGRvbmUgPyB7IHN0YXR1czogJ2NvbXBsZXRlZCcgfSA6IHsgc3RhdHVzOiAnbmVlZHNBY3Rpb24nLCBjb21wbGV0ZWQ6IG51bGwgfTsKICB9CgogIC8vIFdoZXJlIGEgdGltZWQgZXZlbnQgZ29lcyB3aGVuIGl0IG1vdmVzOiBkcmFnZ2VkIHRvIGFub3RoZXIgZGF5IGl0CiAgLy8ga2VlcHMgaXRzIHRpbWVzOyBkcm9wcGVkIGF0IGEgdGltZSBvZiBkYXkgKGBzdGFydE1pbmAsIG1pbnV0ZXMgYWZ0ZXIKICAvLyBtaWRuaWdodCBvbiBgdG9EYXlgKSBpdCBzdGFydHMgdGhlbi4gRWl0aGVyIHdheSBpdCBrZWVwcyBpdHMgbGVuZ3RoLgogIGZ1bmN0aW9uIG1vdmVkVGltZXMoaXRlbSwgZnJ",
"vbURheSwgdG9EYXksIHN0YXJ0TWluKSB7CiAgICBpZiAodHlwZW9mIHN0YXJ0TWluID09PSAnbnVtYmVyJykgewogICAgICBjb25zdCBbeSwgbW8sIGRdID0gdG9EYXkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgICAgY29uc3Qgc3RhcnQgPSBuZXcgRGF0ZSh5LCBtbyAtIDEsIGQsIDAsIHN0YXJ0TWluKS5nZXRUaW1lKCk7CiAgICAgIHJldHVybiB7IHN0YXJ0LCBlbmQ6IHN0YXJ0ICsgKGl0ZW0uZW5kIC0gaXRlbS5zdGFydCkgfTsKICAgIH0KICAgIGNvbnN0IGRlbHRhID0gZGF5c0JldHdlZW4oZnJvbURheSwgdG9EYXkpOwogICAgY29uc3Qgc2hpZnQgPSBtcyA9PiB7IGNvbnN0IHggPSBuZXcgRGF0ZShtcyk7IHguc2V0RGF0ZSh4LmdldERhdGUoKSArIGRlbHRhKTsgcmV0dXJuIHguZ2V0VGltZSgpOyB9OwogICAgcmV0dXJuIHsgc3RhcnQ6IHNoaWZ0KGl0ZW0uc3RhcnQpLCBlbmQ6IHNoaWZ0KGl0ZW0uZW5kKSB9OwogIH0KCiAgY29uc3Qgc3RhbXBPZiA9IChtcywgdGltZVpvbmUpID0-IHsKICAgIGNvbnN0IHQgPSB7IGRhdGVUaW1lOiBsb2NhbFN0YW1wKGRhdGVLZXkobXMpLCBjbG9ja09mKG1zKSkgfTsKICAgIGlmICh0aW1lWm9uZSkgdC50aW1lWm9uZSA9IHRpbWVab25lOwogICAgcmV0dXJuIHQ7CiAgfTsKCiAgLy8gRHJhZ2dlZCBmcm9tIG9uZSBkYXkgdG8gYW5vdGhlciAoYSB0YXNrIHRvICcnIGZvciBubyBkYXkpOiBhbiBldmVudAogIC8vIGtlZXBzIGl0cyB0aW1lcyBhbmQgbGVuZ3RoIC0gb3I",
"sIGRyb3BwZWQgYXQgYSB0aW1lIG9mIGRheSwgc3RhcnRzCiAgLy8gdGhlbiAtIGFuZCBhIHRhc2sgZ2V0cyB0aGUgbmV3IGRheS4KICBmdW5jdGlvbiBtb3ZlQm9keShpdGVtLCBmcm9tRGF5LCB0b0RheSwgdGltZVpvbmUsIHN0YXJ0TWluKSB7CiAgICBpZiAoaXRlbS5raW5kID09PSAndGFzaycpIHJldHVybiB7IGR1ZTogdG9EYXkgPyBgJHt0b0RheX1UMDA6MDA6MDAuMDAwWmAgOiBudWxsIH07CiAgICBjb25zdCBkZWx0YSA9IGRheXNCZXR3ZWVuKGZyb21EYXksIHRvRGF5KTsKICAgIGlmIChpdGVtLmFsbERheSkgcmV0dXJuIHsgc3RhcnQ6IHsgZGF0ZTogYWRkRGF5cyhpdGVtLmZpcnN0LCBkZWx0YSkgfSwgZW5kOiB7IGRhdGU6IGFkZERheXMoaXRlbS5sYXN0LCBkZWx0YSArIDEpIH0gfTsKICAgIGNvbnN0IHQgPSBtb3ZlZFRpbWVzKGl0ZW0sIGZyb21EYXksIHRvRGF5LCBzdGFydE1pbik7CiAgICByZXR1cm4geyBzdGFydDogc3RhbXBPZih0LnN0YXJ0LCB0aW1lWm9uZSksIGVuZDogc3RhbXBPZih0LmVuZCwgdGltZVpvbmUpIH07CiAgfQoKICAvLyBUaGUgc2FtZSBtb3ZlIG9uIHRoZSBpdGVtIG9uIHNjcmVlbiwgdW50aWwgR29vZ2xlJ3MgYW5zd2VyIGlzIGluLgogIGZ1bmN0aW9uIG1vdmVkSXRlbShpdGVtLCBmcm9tRGF5LCB0b0RheSwgc3RhcnRNaW4pIHsKICAgIGlmIChpdGVtLmtpbmQgPT09ICd0YXNrJykgcmV0dXJuIE9iamVjdC5hc3NpZ24oe30sIGl0ZW0sIHsgZHVlOiB0b0RheSB8fCAnJyB9KTs",
"KICAgIGlmIChpdGVtLmFsbERheSkgewogICAgICBjb25zdCBkZWx0YSA9IGRheXNCZXR3ZWVuKGZyb21EYXksIHRvRGF5KTsKICAgICAgcmV0dXJuIE9iamVjdC5hc3NpZ24oe30sIGl0ZW0sIHsgZmlyc3Q6IGFkZERheXMoaXRlbS5maXJzdCwgZGVsdGEpLCBsYXN0OiBhZGREYXlzKGl0ZW0ubGFzdCwgZGVsdGEpIH0pOwogICAgfQogICAgY29uc3QgdCA9IG1vdmVkVGltZXMoaXRlbSwgZnJvbURheSwgdG9EYXksIHN0YXJ0TWluKTsKICAgIHJldHVybiBPYmplY3QuYXNzaWduKHt9LCBpdGVtLCB0LCB7IGZpcnN0OiBkYXRlS2V5KHQuc3RhcnQpLCBsYXN0OiBkYXRlS2V5KE1hdGgubWF4KHQuc3RhcnQsIHQuZW5kIC0gMSkpIH0pOwogIH0KCiAgLy8gSXRzIGJvdHRvbSBlZGdlIGRyYWdnZWQ6IGEgbmV3IGVuZCwgdGhlIHN0YXJ0IGtlcHQuCiAgZnVuY3Rpb24gcmVzaXplQm9keShpdGVtLCBlbmRNcywgdGltZVpvbmUpIHsKICAgIHJldHVybiB7IGVuZDogc3RhbXBPZihlbmRNcywgdGltZVpvbmUpIH07CiAgfQoKICAvLyDilIDilIAgVGhlIGRheSBieSB0aGUgaG91ciDilIDilIAKICAvLwogIC8vIEEgZGF5J3MgdGltZWQgZXZlbnRzLCBwbGFjZWQgaW4gdGhlIHdlZWsncyBob3VyIGdyaWQ6IGZyb20gYW5kIHRvLCBpbgogIC8vIG1pbnV0ZXMgYWZ0ZXIgbWlkbmlnaHQgb24gdGhhdCBkYXkgKG9uZSB0aGF0IHJ1bnMgcGFzdCBtaWRuaWdodCBpcwogIC8vIGN1dCBhdCB0aGUgZGF5J3MgZWRnZXMpLCBhbmQgc2lkZSB",
"ieSBzaWRlIHdoZXJlIHRoZXkgb3ZlcmxhcCAtIGBjb2xgCiAgLy8gb2YgYGNvbHNgIGluIHRoZWlyIGNsdXN0ZXIgb2Ygb3ZlcmxhcHBpbmcgZXZlbnRzLgogIGZ1bmN0aW9uIGRheUxheW91dChlbnRyaWVzLCBkYXkpIHsKICAgIGNvbnN0IFt5LCBtbywgZF0gPSBkYXkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKTsKICAgIGNvbnN0IGRheVN0YXJ0ID0gbmV3IERhdGUoeSwgbW8gLSAxLCBkKS5nZXRUaW1lKCk7CiAgICBjb25zdCBkYXlFbmQgPSBuZXcgRGF0ZSh5LCBtbyAtIDEsIGQgKyAxKS5nZXRUaW1lKCk7CiAgICBjb25zdCBtaW51dGVPZiA9IG1zID0-IHsgY29uc3QgeCA9IG5ldyBEYXRlKG1zKTsgcmV0dXJuIHguZ2V0SG91cnMoKSAqIDYwICsgeC5nZXRNaW51dGVzKCk7IH07CiAgICBjb25zdCBwbGFjZWQgPSBlbnRyaWVzCiAgICAgIC5maWx0ZXIoZSA9PiBlLml0ZW0ua2luZCA9PT0gJ2V2ZW50JyAmJiAhZS5pdGVtLmFsbERheSAmJiBlLml0ZW0uZW5kID4gZGF5U3RhcnQgJiYgZS5pdGVtLnN0YXJ0IDwgZGF5RW5kKQogICAgICAubWFwKGUgPT4gewogICAgICAgIGNvbnN0IGZyb20gPSBlLml0ZW0uc3RhcnQgPD0gZGF5U3RhcnQgPyAwIDogbWludXRlT2YoZS5pdGVtLnN0YXJ0KTsKICAgICAgICBjb25zdCB0byA9IGUuaXRlbS5lbmQgPj0gZGF5RW5kID8gMTQ0MCA6IG1pbnV0ZU9mKGUuaXRlbS5lbmQpOwogICAgICAgIHJldHVybiB7IGl0ZW06IGUuaXRlbSwgY29udDogZS5jb250LCBmcm9tLCB0bzogTWF",
"0aC5tYXgodG8sIGZyb20gKyAxKSwgY29sOiAwLCBjb2xzOiAxIH07CiAgICAgIH0pCiAgICAgIC5zb3J0KChhLCBiKSA9PiBhLmZyb20gLSBiLmZyb20gfHwgYi50byAtIGEudG8pOwogICAgLy8gQ2x1c3RlcnMgb2YgZXZlbnRzIHRoYXQgb3ZlcmxhcCBvbmUgYW5vdGhlciwgZWFjaCBsYWlkIG91dCBpbiBjb2x1bW5zLgogICAgbGV0IGNsdXN0ZXIgPSBbXTsKICAgIGxldCBlbmRzID0gW107CiAgICBsZXQgcmVhY2ggPSAtMTsKICAgIGNvbnN0IGNsb3NlID0gKCkgPT4gewogICAgICBmb3IgKGNvbnN0IHAgb2YgY2x1c3RlcikgcC5jb2xzID0gZW5kcy5sZW5ndGg7CiAgICAgIGNsdXN0ZXIgPSBbXTsKICAgICAgZW5kcyA9IFtdOwogICAgfTsKICAgIGZvciAoY29uc3QgcCBvZiBwbGFjZWQpIHsKICAgICAgaWYgKHAuZnJvbSA-PSByZWFjaCkgY2xvc2UoKTsKICAgICAgbGV0IGNvbCA9IGVuZHMuZmluZEluZGV4KGVuZCA9PiBlbmQgPD0gcC5mcm9tKTsKICAgICAgaWYgKGNvbCA8IDApIHsgY29sID0gZW5kcy5sZW5ndGg7IGVuZHMucHVzaChwLnRvKTsgfSBlbHNlIGVuZHNbY29sXSA9IHAudG87CiAgICAgIHAuY29sID0gY29sOwogICAgICBjbHVzdGVyLnB1c2gocCk7CiAgICAgIHJlYWNoID0gTWF0aC5tYXgocmVhY2gsIHAudG8pOwogICAgfQogICAgY2xvc2UoKTsKICAgIHJldHVybiBwbGFjZWQ7CiAgfQoKICAvLyDilIDilIAgUmVwZWF0aW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gSG93IGFuIGV2ZW50IHJlcGVhdHMgaXMgR29vZ2xlJ3M6IG9uZSBSUlVMRSBsaW5lLCB3aXRoIGFueSBFWERBVEUgb3IKICAvLyBSREFURSBsaW5lcyBiZXNpZGUgaXQsIHdoaWNoIGFyZSBrZXB0IGFzIHRoZXkgYXJlLiBUaGUgZWRpdG9yIG9mZmVycwogIC8vIEdvb2dsZSdzIG93biBtZW51IC0gZGFpbHksIHdlZWtseSBvbiB0aGUgZGF5LCBtb250aGx5IG9uIGl0cyB3ZWVrZGF5LAogIC8vIGFubnVhbGx5LCBldmVyeSB3ZWVrZGF5IC0gYW5kIGEgY3VzdG9tIHJ1bGUuIEEgcnVsZSBpdCBjYW5ub3Qgc2hvdyBpcwogIC8vIGtlcHQgdW50b3VjaGVkLCB1bmxlc3MgYW5vdGhlciBpcyBjaG9zZW4uCgogIGNvbnN0IFdFRUtEQVlfQ09ERVMgPSBbJ01PJywgJ1RVJywgJ1dFJywgJ1RIJywgJ0ZSJywgJ1NBJywgJ1NVJ107CiAgY29uc3QgV0VFS0RBWV9OQU1FUyA9IFsnTW9uZGF5JywgJ1R1ZXNkYXknLCAnV2VkbmVzZGF5JywgJ1RodXJzZGF5JywgJ0ZyaWRheScsICdTYXR1cmRheScsICdTdW5kYXknXTsKICBjb25zdCBPUkRJTkFMUyA9IHsgMTogJ2ZpcnN0JywgMjogJ3NlY29uZCcsIDM6ICd0aGlyZCcsIDQ6ICdmb3VydGgnLCAnLTEnOiAnbGFzdCcgfTsKICBjb25zdCB",
"GUkVRUyA9IHsgREFJTFk6ICdkYXknLCBXRUVLTFk6ICd3ZWVrJywgTU9OVEhMWTogJ21vbnRoJywgWUVBUkxZOiAneWVhcicgfTsKICBjb25zdCBXT1JLREFZUyA9ICdNTyxUVSxXRSxUSCxGUic7CgogIC8vIFdoaWNoIG9mIGl0cyB3ZWVrZGF5IGluIGl0cyBtb250aCBhIGRheSBpczogMSB0byA0LCBvciAtMSBmb3IgYSBmaWZ0aCwKICAvLyB3aGljaCBHb29nbGUgY2FsbHMgdGhlIGxhc3QuCiAgY29uc3QgbnRoT2YgPSBkYXkgPT4geyBjb25zdCBuID0gTWF0aC5jZWlsKE51bWJlcihkYXkuc2xpY2UoOCkpIC8gNyk7IHJldHVybiBuID4gNCA_IC0xIDogbjsgfTsKCiAgLy8gR29vZ2xlJ3MgbWVudSwgZm9yIGFuIGV2ZW50IHN0YXJ0aW5nIG9uIGBkYXlgLgogIGZ1bmN0aW9uIHJlcGVhdENob2ljZXMoZGF5KSB7CiAgICBjb25zdCB3ZCA9IHdlZWtkYXkoZGF5KTsKICAgIGNvbnN0IG50aCA9IG50aE9mKGRheSk7CiAgICByZXR1cm4gWwogICAgICB7IGlkOiAnbm9uZScsIGxhYmVsOiAnRG9lcyBub3QgcmVwZWF0JywgcnVsZTogJycgfSwKICAgICAgeyBpZDogJ2RhaWx5JywgbGFiZWw6ICdEYWlseScsIHJ1bGU6ICdSUlVMRTpGUkVRPURBSUxZJyB9LAogICAgICB7IGlkOiAnd2Vla2x5JywgbGFiZWw6IGBXZWVrbHkgb24gJHtXRUVLREFZX05BTUVTW3dkXX1gLCBydWxlOiBgUlJVTEU6RlJFUT1XRUVLTFk7QllEQVk9JHtXRUVLREFZX0NPREVTW3dkXX1gIH0sCiAgICAgIHsgaWQ6ICdtb250aGx5JywgbGFiZWw6IGB",
"Nb250aGx5IG9uIHRoZSAke09SRElOQUxTW250aF19ICR7V0VFS0RBWV9OQU1FU1t3ZF19YCwgcnVsZTogYFJSVUxFOkZSRVE9TU9OVEhMWTtCWURBWT0ke250aH0ke1dFRUtEQVlfQ09ERVNbd2RdfWAgfSwKICAgICAgeyBpZDogJ3llYXJseScsIGxhYmVsOiBgQW5udWFsbHkgb24gJHtOdW1iZXIoZGF5LnNsaWNlKDgpKX0gJHtNT05USFNfTE9OR1tOdW1iZXIoZGF5LnNsaWNlKDUsIDcpKSAtIDFdfWAsIHJ1bGU6ICdSUlVMRTpGUkVRPVlFQVJMWScgfSwKICAgICAgeyBpZDogJ3dlZWtkYXlzJywgbGFiZWw6ICdFdmVyeSB3ZWVrZGF5IChNb25kYXkgdG8gRnJpZGF5KScsIHJ1bGU6IGBSUlVMRTpGUkVRPVdFRUtMWTtCWURBWT0ke1dPUktEQVlTfWAgfSwKICAgIF07CiAgfQoKICAvLyBBbiBSUlVMRSBsaW5lIGFzIGl0cyBwYXJ0cywgb3IgbnVsbCBmb3Igb25lIHdpdGggcGFydHMgdGhlIGVkaXRvciBkb2VzCiAgLy8gbm90IGtub3cgLSB3aGljaCBpcyB0aGVuIGtlcHQgYXMgaXQgaXMuCiAgZnVuY3Rpb24gcGFyc2VSdWxlKGxpbmUpIHsKICAgIGNvbnN0IG0gPSAvXlJSVUxFOiguKykkLy5leGVjKFN0cmluZyhsaW5lIHx8ICcnKSk7CiAgICBpZiAoIW0pIHJldHVybiBudWxsOwogICAgY29uc3QgcCA9IHt9OwogICAgZm9yIChjb25zdCBrdiBvZiBtWzFdLnNwbGl0KCc7JykpIHsKICAgICAgY29uc3QgW2ssIHYsIG1vcmVdID0ga3Yuc3BsaXQoJz0nKTsKICAgICAgaWYgKG1vcmUgIT09IHVuZGVmaW5lZCB8fCAhdiB",
"8fCAhWydGUkVRJywgJ0lOVEVSVkFMJywgJ0JZREFZJywgJ0JZTU9OVEhEQVknLCAnQ09VTlQnLCAnVU5USUwnLCAnV0tTVCddLmluY2x1ZGVzKGspKSByZXR1cm4gbnVsbDsKICAgICAgcFtrXSA9IHY7CiAgICB9CiAgICBpZiAoIUZSRVFTW3AuRlJFUV0pIHJldHVybiBudWxsOwogICAgY29uc3QgcnVsZSA9IHsgZnJlcTogcC5GUkVRLCBpbnRlcnZhbDogMSwgYnlkYXk6IFtdLCBieW1vbnRoZGF5OiAwLCBjb3VudDogMCwgdW50aWw6ICcnIH07CiAgICBpZiAocC5JTlRFUlZBTCkgewogICAgICBpZiAoIS9eXGR7MSwzfSQvLnRlc3QocC5JTlRFUlZBTCkgfHwgTnVtYmVyKHAuSU5URVJWQUwpIDwgMSkgcmV0dXJuIG51bGw7CiAgICAgIHJ1bGUuaW50ZXJ2YWwgPSBOdW1iZXIocC5JTlRFUlZBTCk7CiAgICB9CiAgICBpZiAocC5CWURBWSkgewogICAgICBydWxlLmJ5ZGF5ID0gcC5CWURBWS5zcGxpdCgnLCcpOwogICAgICBpZiAoIXJ1bGUuYnlkYXkuZXZlcnkoZCA9PiAvXigtMXxbMS00XSk_KE1PfFRVfFdFfFRIfEZSfFNBfFNVKSQvLnRlc3QoZCkpKSByZXR1cm4gbnVsbDsKICAgIH0KICAgIGlmIChwLkJZTU9OVEhEQVkpIHsKICAgICAgaWYgKCEvXlxkezEsMn0kLy50ZXN0KHAuQllNT05USERBWSkgfHwgTnVtYmVyKHAuQllNT05USERBWSkgPCAxIHx8IE51bWJlcihwLkJZTU9OVEhEQVkpID4gMzEpIHJldHVybiBudWxsOwogICAgICBydWxlLmJ5bW9udGhkYXkgPSBOdW1iZXIocC5CWU1PTlRIREFZKTsKICAgIH0",
"KICAgIGlmIChwLkNPVU5UKSB7CiAgICAgIGlmICghL15cZHsxLDN9JC8udGVzdChwLkNPVU5UKSB8fCBOdW1iZXIocC5DT1VOVCkgPCAxKSByZXR1cm4gbnVsbDsKICAgICAgcnVsZS5jb3VudCA9IE51bWJlcihwLkNPVU5UKTsKICAgIH0KICAgIGlmIChwLlVOVElMKSB7CiAgICAgIGNvbnN0IHUgPSAvXihcZHs0fSkoXGR7Mn0pKFxkezJ9KShUXGR7Nn1aPyk_JC8uZXhlYyhwLlVOVElMKTsKICAgICAgaWYgKCF1KSByZXR1cm4gbnVsbDsKICAgICAgcnVsZS51bnRpbCA9IGAke3VbMV19LSR7dVsyXX0tJHt1WzNdfWA7CiAgICB9CiAgICByZXR1cm4gcnVsZTsKICB9CgogIC8vIFRoZSBlZGl0b3IncyBvd24gZm9ybSBvZiBhIHJ1bGU6IGV2ZXJ5IGBldmVyeWAgYHVuaXRgczsgb24gYGRheXNgIG9mIGEKICAvLyB3ZWVrOyBhIG1vbnRoIGJ5IGl0cyBkYXRlIG9yIGJ5IGl0cyB3ZWVrZGF5OyBlbmRpbmcgbmV2ZXIsIGBvbmAgYSBkYXksCiAgLy8gb3IgYGFmdGVyYCBzbyBtYW55IHRpbWVzLgogIGZ1bmN0aW9uIGN1c3RvbUZvcihkYXkpIHsKICAgIHJldHVybiB7IGV2ZXJ5OiAxLCB1bml0OiAnd2VlaycsIGRheXM6IFtXRUVLREFZX0NPREVTW3dlZWtkYXkoZGF5KV1dLCBtb250aEJ5OiAnZGF0ZScsIGVuZHM6ICduZXZlcicsIHVudGlsOiBhZGRNb250aHMoZGF5LCAzKSwgY291bnQ6IDEwIH07CiAgfQoKICAvLyBBIHBhcnNlZCBydWxlIGFzIHRoZSBlZGl0b3IncyBmb3JtLCBvciBudWxsIGlmIHRoZSBmb3JtIGNhbm5",
"vdCBob2xkIGl0LgogIGZ1bmN0aW9uIGN1c3RvbU9mKHJ1bGUsIGRheSkgewogICAgaWYgKCFydWxlKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGMgPSBPYmplY3QuYXNzaWduKGN1c3RvbUZvcihkYXkpLCB7IGV2ZXJ5OiBydWxlLmludGVydmFsLCB1bml0OiBGUkVRU1tydWxlLmZyZXFdIH0pOwogICAgY29uc3QgcGxhaW4gPSBydWxlLmJ5ZGF5LmZpbHRlcihkID0-IC9eW0EtWl17Mn0kLy50ZXN0KGQpKTsKICAgIGlmIChydWxlLmZyZXEgPT09ICdXRUVLTFknKSB7CiAgICAgIGlmIChwbGFpbi5sZW5ndGggIT09IHJ1bGUuYnlkYXkubGVuZ3RoIHx8IHJ1bGUuYnltb250aGRheSkgcmV0dXJuIG51bGw7CiAgICAgIGlmIChwbGFpbi5sZW5ndGgpIGMuZGF5cyA9IFdFRUtEQVlfQ09ERVMuZmlsdGVyKGQgPT4gcGxhaW4uaW5jbHVkZXMoZCkpOwogICAgfSBlbHNlIGlmIChydWxlLmZyZXEgPT09ICdNT05USExZJykgewogICAgICBpZiAocnVsZS5ieWRheS5sZW5ndGggPiAxIHx8IChydWxlLmJ5ZGF5Lmxlbmd0aCAmJiBwbGFpbi5sZW5ndGgpIHx8IChydWxlLmJ5ZGF5Lmxlbmd0aCAmJiBydWxlLmJ5bW9udGhkYXkpKSByZXR1cm4gbnVsbDsKICAgICAgYy5tb250aEJ5ID0gcnVsZS5ieWRheS5sZW5ndGggPyAnd2Vla2RheScgOiAnZGF0ZSc7CiAgICB9IGVsc2UgaWYgKHJ1bGUuYnlkYXkubGVuZ3RoIHx8IHJ1bGUuYnltb250aGRheSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIGlmIChydWxlLmNvdW50KSB",
"PYmplY3QuYXNzaWduKGMsIHsgZW5kczogJ2FmdGVyJywgY291bnQ6IHJ1bGUuY291bnQgfSk7CiAgICBlbHNlIGlmIChydWxlLnVudGlsKSBPYmplY3QuYXNzaWduKGMsIHsgZW5kczogJ29uJywgdW50aWw6IHJ1bGUudW50aWwgfSk7CiAgICByZXR1cm4gYzsKICB9CgogIC8vIFRoZSBlZGl0b3IncyBmb3JtIGFzIGFuIFJSVUxFIGxpbmUsIGZvciBhbiBldmVudCBzdGFydGluZyBvbiBgZGF5YC4gQW4KICAvLyBlbmQgZGF0ZSBpcyB0aGUgZGF5IGl0c2VsZiBmb3IgYW4gYWxsLWRheSBldmVudCwgYW5kIHRoZSBlbmQgb2YgdGhhdAogIC8vIGRheSBpbiBVVEMgZm9yIGEgdGltZWQgb25lLCBhcyBHb29nbGUgd2FudHMgaXQuCiAgZnVuY3Rpb24gY3VzdG9tUnVsZShjLCBkYXksIGFsbERheSkgewogICAgY29uc3QgZnJlcSA9IE9iamVjdC5rZXlzKEZSRVFTKS5maW5kKGsgPT4gRlJFUVNba10gPT09IGMudW5pdCkgfHwgJ1dFRUtMWSc7CiAgICBjb25zdCBwYXJ0cyA9IFtgRlJFUT0ke2ZyZXF9YF07CiAgICBjb25zdCBldmVyeSA9IE1hdGgubWF4KDEsIE1hdGgubWluKDk5OSwgTWF0aC5yb3VuZChOdW1iZXIoYy5ldmVyeSkgfHwgMSkpKTsKICAgIGlmIChldmVyeSA-IDEpIHBhcnRzLnB1c2goYElOVEVSVkFMPSR7ZXZlcnl9YCk7CiAgICBpZiAoZnJlcSA9PT0gJ1dFRUtMWScpIHsKICAgICAgY29uc3QgZGF5cyA9IFdFRUtEQVlfQ09ERVMuZmlsdGVyKGQgPT4gKGMuZGF5cyB8fCBbXSkuaW5jbHVkZXMoZCkpOwogICA",
"gICBwYXJ0cy5wdXNoKGBCWURBWT0keyhkYXlzLmxlbmd0aCA_IGRheXMgOiBbV0VFS0RBWV9DT0RFU1t3ZWVrZGF5KGRheSldXSkuam9pbignLCcpfWApOwogICAgfQogICAgaWYgKGZyZXEgPT09ICdNT05USExZJyAmJiBjLm1vbnRoQnkgPT09ICd3ZWVrZGF5JykgcGFydHMucHVzaChgQllEQVk9JHtudGhPZihkYXkpfSR7V0VFS0RBWV9DT0RFU1t3ZWVrZGF5KGRheSldfWApOwogICAgaWYgKGMuZW5kcyA9PT0gJ2FmdGVyJykgcGFydHMucHVzaChgQ09VTlQ9JHtNYXRoLm1heCgxLCBNYXRoLm1pbig5OTksIE1hdGgucm91bmQoTnVtYmVyKGMuY291bnQpIHx8IDEpKSl9YCk7CiAgICBpZiAoYy5lbmRzID09PSAnb24nICYmIGlzS2V5KGMudW50aWwpKSB7CiAgICAgIGNvbnN0IHltZCA9IGMudW50aWwucmVwbGFjZSgvLS9nLCAnJyk7CiAgICAgIHBhcnRzLnB1c2goYFVOVElMPSR7YWxsRGF5ID8geW1kIDogYCR7eW1kfVQyMzU5NTlaYH1gKTsKICAgIH0KICAgIHJldHVybiBgUlJVTEU6JHtwYXJ0cy5qb2luKCc7Jyl9YDsKICB9CgogIC8vIEhvdyBhbiBldmVudCByZXBlYXRzLCBmcm9tIGl0cyByZWN1cnJlbmNlIGxpbmVzIGFuZCBpdHMgZmlyc3QgZGF5OgogIC8vIHsgaWQgfSAtIGEgY2hvaWNlIGZyb20gdGhlIG1lbnUsICdjdXN0b20nIHdpdGggaXRzIGZvcm0sICdvdGhlcicgZm9yIGEKICAvLyBydWxlIGtlcHQgYXMgaXQgaXMgLSBhbmQgdGhlIHJ1bGUgbGluZSBpdHNlbGYuCiAgZnVuY3Rpb24gcmVwZWF0T2Y",
"obGluZXMsIGRheSkgewogICAgY29uc3QgcnVsZSA9IChsaW5lcyB8fCBbXSkuZmluZChsID0-IC9eUlJVTEU6Ly50ZXN0KGwpKSB8fCAnJzsKICAgIGlmICghcnVsZSkgcmV0dXJuIHsgaWQ6ICdub25lJywgcnVsZTogJycgfTsKICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlUnVsZShydWxlKTsKICAgIGlmICghcGFyc2VkKSByZXR1cm4geyBpZDogJ290aGVyJywgcnVsZSB9OwogICAgY29uc3Qgc2FtZSA9IChhLCBiKSA9PiBhICYmIGIgJiYgYS5mcmVxID09PSBiLmZyZXEgJiYgYS5pbnRlcnZhbCA9PT0gYi5pbnRlcnZhbCAmJiBhLmNvdW50ID09PSBiLmNvdW50ICYmCiAgICAgIGEudW50aWwgPT09IGIudW50aWwgJiYgYS5ieW1vbnRoZGF5ID09PSBiLmJ5bW9udGhkYXkgJiYgYS5ieWRheS5zbGljZSgpLnNvcnQoKS5qb2luKCkgPT09IGIuYnlkYXkuc2xpY2UoKS5zb3J0KCkuam9pbigpOwogICAgY29uc3QgcHJlc2V0ID0gcmVwZWF0Q2hvaWNlcyhkYXkpLmZpbmQoYyA9PiBjLnJ1bGUgJiYgc2FtZShwYXJzZVJ1bGUoYy5ydWxlKSwgcGFyc2VkKSk7CiAgICBpZiAocHJlc2V0KSByZXR1cm4geyBpZDogcHJlc2V0LmlkLCBydWxlIH07CiAgICBjb25zdCBjdXN0b20gPSBjdXN0b21PZihwYXJzZWQsIGRheSk7CiAgICByZXR1cm4gY3VzdG9tID8geyBpZDogJ2N1c3RvbScsIHJ1bGUsIGN1c3RvbSB9IDogeyBpZDogJ290aGVyJywgcnVsZSB9OwogIH0KCiAgLy8gVGhlIHJ1bGUgbGluZSBmb3Igd2hhdCB0aGUgZWRpdG9",
"yIGhvbGRzLCBmb3IgYW4gZXZlbnQgc3RhcnRpbmcgb24KICAvLyBgZGF5YDogYSBjaG9pY2UgZnJvbSB0aGUgbWVudSAod29ya2VkIG91dCBmb3IgdGhhdCBkYXkpLCB0aGUgY3VzdG9tCiAgLy8gZm9ybSwgb3IgdGhlIHJ1bGUga2VwdCBhcyBpdCB3YXMuCiAgZnVuY3Rpb24gcnVsZUZvcihyZXBlYXQsIGRheSwgYWxsRGF5KSB7CiAgICBpZiAoIXJlcGVhdCB8fCByZXBlYXQuaWQgPT09ICdub25lJykgcmV0dXJuICcnOwogICAgaWYgKHJlcGVhdC5pZCA9PT0gJ2N1c3RvbScpIHJldHVybiBjdXN0b21SdWxlKHJlcGVhdC5jdXN0b20gfHwgY3VzdG9tRm9yKGRheSksIGRheSwgYWxsRGF5KTsKICAgIGlmIChyZXBlYXQuaWQgPT09ICdvdGhlcicpIHJldHVybiByZXBlYXQucnVsZSB8fCAnJzsKICAgIGNvbnN0IGMgPSByZXBlYXRDaG9pY2VzKGRheSkuZmluZCh4ID0-IHguaWQgPT09IHJlcGVhdC5pZCk7CiAgICByZXR1cm4gYyA_IGMucnVsZSA6ICcnOwogIH0KCiAgLy8gVGhlIHJlY3VycmVuY2UgbGluZXMgd2l0aCBhIG5ldyBydWxlOiB0aGUgb3RoZXIgbGluZXMgKGRhdGVzIGxlZnQgb3V0CiAgLy8gb3IgYWRkZWQpIGtlcHQ7IG5vbmUgYXQgYWxsIG9uY2UgaXQgbm8gbG9uZ2VyIHJlcGVhdHMuCiAgZnVuY3Rpb24gcmVjdXJyZW5jZVdpdGgobGluZXMsIHJ1bGUpIHsKICAgIGlmICghcnVsZSkgcmV0dXJuIFtdOwogICAgcmV0dXJuIFtydWxlXS5jb25jYXQoKGxpbmVzIHx8IFtdKS5maWx0ZXIobCA9PiAhL15SUlV",
"MRTovLnRlc3QobCkpKTsKICB9CgogIGNvbnN0IGxpc3RPZiA9IG5hbWVzID0-IChuYW1lcy5sZW5ndGggPiAxID8gYCR7bmFtZXMuc2xpY2UoMCwgLTEpLmpvaW4oJywgJyl9IGFuZCAke25hbWVzW25hbWVzLmxlbmd0aCAtIDFdfWAgOiBuYW1lc1swXSB8fCAnJyk7CgogIC8vIEluIHdvcmRzLCBhcyB0aGUgZWRpdG9yIHNob3dzIGl0OiAiRXZlcnkgMiB3ZWVrcyBvbiBNb25kYXkgYW5kCiAgLy8gVGh1cnNkYXksIDEwIHRpbWVzIi4KICBmdW5jdGlvbiBkZXNjcmliZVJlcGVhdChyZXBlYXQsIGRheSkgewogICAgaWYgKCFyZXBlYXQgfHwgcmVwZWF0LmlkID09PSAnbm9uZScpIHJldHVybiAnRG9lcyBub3QgcmVwZWF0JzsKICAgIGlmIChyZXBlYXQuaWQgIT09ICdjdXN0b20nICYmIHJlcGVhdC5pZCAhPT0gJ290aGVyJykgewogICAgICBjb25zdCBjID0gcmVwZWF0Q2hvaWNlcyhkYXkpLmZpbmQoeCA9PiB4LmlkID09PSByZXBlYXQuaWQpOwogICAgICByZXR1cm4gYyA_IGMubGFiZWwgOiAnJzsKICAgIH0KICAgIGNvbnN0IGMgPSByZXBlYXQuaWQgPT09ICdjdXN0b20nID8gcmVwZWF0LmN1c3RvbSA6IG51bGw7CiAgICBpZiAoIWMpIHJldHVybiAnUmVwZWF0cyBhcyBzZXQgaW4gR29vZ2xlIENhbGVuZGFyJzsKICAgIGNvbnN0IHVuaXQgPSBjLmV2ZXJ5ID4gMSA_IGBFdmVyeSAke2MuZXZlcnl9ICR7Yy51bml0fXNgIDogYCR7eyBkYXk6ICdEYWlseScsIHdlZWs6ICdXZWVrbHknLCBtb250aDogJ01vbnRobHknLCB",
"5ZWFyOiAnQW5udWFsbHknIH1bYy51bml0XX1gOwogICAgbGV0IG9uID0gJyc7CiAgICBpZiAoYy51bml0ID09PSAnd2VlaycpIG9uID0gYCBvbiAke2xpc3RPZihXRUVLREFZX0NPREVTLmZpbHRlcihkID0-IGMuZGF5cy5pbmNsdWRlcyhkKSkubWFwKGQgPT4gV0VFS0RBWV9OQU1FU1tXRUVLREFZX0NPREVTLmluZGV4T2YoZCldKSl9YDsKICAgIGlmIChjLnVuaXQgPT09ICdtb250aCcpIG9uID0gYy5tb250aEJ5ID09PSAnd2Vla2RheScgPyBgIG9uIHRoZSAke09SRElOQUxTW250aE9mKGRheSldfSAke1dFRUtEQVlfTkFNRVNbd2Vla2RheShkYXkpXX1gIDogYCBvbiBkYXkgJHtOdW1iZXIoZGF5LnNsaWNlKDgpKX1gOwogICAgY29uc3QgZW5kID0gYy5lbmRzID09PSAnYWZ0ZXInID8gYCwgJHtjLmNvdW50fSB0aW1lJHtjLmNvdW50ID09PSAxID8gJycgOiAncyd9YAogICAgICA6IGMuZW5kcyA9PT0gJ29uJyAmJiBpc0tleShjLnVudGlsKSA_IGAsIHVudGlsICR7TnVtYmVyKGMudW50aWwuc2xpY2UoOCkpfSAke01PTlRIU1tOdW1iZXIoYy51bnRpbC5zbGljZSg1LCA3KSkgLSAxXX0gJHtjLnVudGlsLnNsaWNlKDAsIDQpfWAgOiAnJzsKICAgIHJldHVybiB1bml0ICsgb24gKyBlbmQ7CiAgfQoKICAvLyBBIGNoYW5nZSBtYWRlIG9uIG9uZSBvY2N1cnJlbmNlLCBmb3IgdGhlIHdob2xlIHNlcmllczogdGhlIHNlcmllcyBzdGlsbAogIC8vIHN0YXJ0cyBvbiBpdHMgZmlyc3QgZGF5LCBtb3ZlZCBieSBhcyBtYW55IGR",
"heXMgYXMgdGhlIG9jY3VycmVuY2Ugd2FzLAogIC8vIHdpdGggdGhlIG9jY3VycmVuY2UncyBuZXcgdGltZXMsIGxlbmd0aCwgdGl0bGUgYW5kIHBsYWNlLgogIGZ1bmN0aW9uIHNlcmllc0RyYWZ0KHNlcmllc1N0YXJ0RGF5LCBvY2N1cnJlbmNlRGF5LCBkKSB7CiAgICBjb25zdCBkYXkgPSBhZGREYXlzKHNlcmllc1N0YXJ0RGF5LCBkYXlzQmV0d2VlbihvY2N1cnJlbmNlRGF5LCBkLmRheSkpOwogICAgY29uc3Qgc3BhbiA9IE1hdGgubWF4KDAsIGRheXNCZXR3ZWVuKGQuZGF5LCBpc0tleShkLmVuZERheSkgPyBkLmVuZERheSA6IGQuZGF5KSk7CiAgICByZXR1cm4gT2JqZWN0LmFzc2lnbih7fSwgZCwgeyBkYXksIGVuZERheTogYWRkRGF5cyhkYXksIHNwYW4pIH0pOwogIH0KCiAgLy8gVGhlIGZpcnN0IGRheSBvZiBhIHNlcmllcywgZnJvbSBHb29nbGUncyBldmVudCBmb3IgaXQuCiAgZnVuY3Rpb24gc3RhcnREYXlPZihldikgewogICAgY29uc3QgcyA9IChldiAmJiBldi5zdGFydCkgfHwge307CiAgICByZXR1cm4gaXNLZXkocy5kYXRlKSA_IHMuZGF0ZSA6IGlzRmluaXRlKERhdGUucGFyc2Uocy5kYXRlVGltZSkpID8gZGF0ZUtleShEYXRlLnBhcnNlKHMuZGF0ZVRpbWUpKSA6ICcnOwogIH0KCiAgY29uc3QgZXZlbnRzUGF0aCA9IGNhbGVuZGFySWQgPT4gYGNhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzYDsKICBjb25zdCBldmVudFBhdGggPSBpdGVtID0-IGAke2V2ZW5",
"0c1BhdGgoaXRlbS5zb3VyY2UpfS8ke2VuY29kZVVSSUNvbXBvbmVudChpdGVtLmV2ZW50SWQpfWA7CiAgY29uc3QgdGFza3NQYXRoID0gbGlzdElkID0-IGBsaXN0cy8ke2VuY29kZVVSSUNvbXBvbmVudChsaXN0SWQpfS90YXNrc2A7CiAgY29uc3QgdGFza1BhdGggPSBpdGVtID0-IGAke3Rhc2tzUGF0aChpdGVtLnNvdXJjZSl9LyR7ZW5jb2RlVVJJQ29tcG9uZW50KGl0ZW0udGFza0lkKX1gOwoKICBjb25zdCBhcGkgPSB7CiAgICBTQ09QRVMsIEJBU0VTLCBVU0VSSU5GT19VUkwsIFZJRVdTLCBBR0VOREFfREFZUywgREFZX05BTUVTLCBNT05USFMsIE1PTlRIU19MT05HLCBFVkVOVF9DT0xPVVJTLAogICAgaXNBbGxvd2VkUmVxdWVzdCwgYnVpbGRVcmwsCiAgICBub3JtVGltZSwgcGFyc2VRdWljaywgbG9jYWxTdGFtcCwgZHJhZnRPZiwgbmV3RHJhZnQsIGV2ZW50Qm9keSwgdGFza0JvZHksIHRpY2tCb2R5LCBtb3ZlQm9keSwgbW92ZWRJdGVtLCByZXNpemVCb2R5LCBkYXlMYXlvdXQsCiAgICBXRUVLREFZX0NPREVTLCBXRUVLREFZX05BTUVTLCByZXBlYXRDaG9pY2VzLCBwYXJzZVJ1bGUsIGN1c3RvbUZvciwgY3VzdG9tT2YsIGN1c3RvbVJ1bGUsIHJlcGVhdE9mLCBydWxlRm9yLAogICAgcmVjdXJyZW5jZVdpdGgsIGRlc2NyaWJlUmVwZWF0LCBzZXJpZXNEcmFmdCwgc3RhcnREYXlPZiwKICAgIGV2ZW50c1BhdGgsIGV2ZW50UGF0aCwgdGFza3NQYXRoLCB0YXNrUGF0aCwKICAgIGRhdGVLZXksIGlzS2V5LCBmcm9",
"tS2V5LCBhZGREYXlzLCBkYXlzQmV0d2Vlbiwgd2Vla2RheSwgd2Vla1N0YXJ0LCBpc29XZWVrLCBtb250aFN0YXJ0LCBhZGRNb250aHMsIGRheXMsCiAgICB2aWV3UmFuZ2UsIHN0ZXAsIG1vbnRoV2Vla3MsIHNwYW5UZXh0LCB0aXRsZSwgbW9udGhOYW1lLCBkYXlOYW1lLAogICAgc2FmZUNvbG91ciwgc2FmZUxpbmssIGNhbGVuZGFyU291cmNlLCBsaXN0U291cmNlLCBzb3VyY2VzLCBpc09uLAogICAgc291cmNlUmVxdWVzdHMsIHJhbmdlUmVxdWVzdHMsIGV2ZW50SXRlbSwgdGFza0l0ZW0sIHVuaXF1ZUJ5SWQsIGNvbXBhcmVJdGVtcywgYnlEYXksIHRyYXksCiAgfTsKCiAgbnMuY2FsZW5kYXJMb2dpYyA9IGFwaTsKICBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIG1vZHVsZS5leHBvcnRzID0gYXBpOwp9KSgpOwo\"],[\"src/content/ui.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIERPTSB0b29sa2l0IGZvciB0aGUgaW5qZWN0ZWQgVUkKLy8KLy8gR21haWwgZW5mb3JjZXMgVHJ1c3RlZCBUeXBlcyBvbiBpdHMgcGFnZSwgdW5kZXI",
"gd2hpY2ggaW5uZXJIVE1MIGFuZAovLyBmcmllbmRzIHRocm93LiBDaHJvbWl1bSBjdXJyZW50bHkgZXhlbXB0cyBhIGNvbnRlbnQgc2NyaXB0J3MgaXNvbGF0ZWQKLy8gd29ybGQgZnJvbSB0aGF0IHBvbGljeSwgYnV0IG5vdGhpbmcgcHJvbWlzZXMgaXQgYWx3YXlzIHdpbGwgLSBhbmQgbWFpbAovLyBzdWJqZWN0cyBhcmUgdW50cnVzdGVkIHRleHQgcmVnYXJkbGVzcy4gU28gZXZlcnkgbm9kZSBoZXJlIGlzIGJ1aWx0Ci8vIHdpdGggY3JlYXRlRWxlbWVudCAvIGNyZWF0ZUVsZW1lbnROUyBhbmQgZmlsbGVkIHdpdGggdGV4dENvbnRlbnQuIEFsbAovLyBvZiBpdCBsaXZlcyBpbiBzaGFkb3cgcm9vdHMgc28gR21haWwncyBzdHlsZXNoZWV0IGFuZCBvdXJzIG5ldmVyIG1lZXQuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwoKICAvLyDilIDilIAgRWxlbWVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pS",
"A4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIC8vIFByb3BlcnRpZXMgdGhhdCBtdXN0IGJlIHNldCBhcyBwcm9wZXJ0aWVzLCBub3QgYXR0cmlidXRlcywgdG8gdGFrZQogIC8vIGVmZmVjdCBhZnRlciBmaXJzdCByZW5kZXIgKGFuIGlucHV0J3MgdmFsdWUsIGEgY2hlY2tib3gncyBzdGF0ZSkuCiAgY29uc3QgUFJPUFMgPSBuZXcgU2V0KFsndmFsdWUnLCAnY2hlY2tlZCcsICdkaXNhYmxlZCcsICdoaWRkZW4nXSk7CgogIGZ1bmN0aW9uIGgodGFnLCBwcm9wcywgLi4ua2lkcykgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7CiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhwcm9wcyB8fCB7fSkpIHsKICAgICAgaWYgKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsIHx8IHYgPT09IGZhbHNlKSBjb250aW51ZTsKICAgICAgaWYgKGsgPT09ICdjbGFzcycpIGVsLmNsYXNzTmFtZSA9IEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcihCb29sZWFuKS5qb2luKCcgJykgOiB2OwogICAgICBlbHNlIGlmIChrID09PSAndGV4dCcpIGVsLnRleHRDb250ZW50ID0gU3RyaW5nKHYpOwogICAgICBlbHNlIGlmIChrID09PSAnZGF0YXNldCcpIE9iamVjdC5hc3NpZ24oZWwuZGF0YXNldCw",
"gdik7CiAgICAgIGVsc2UgaWYgKGsuc3RhcnRzV2l0aCgnb24nKSAmJiB0eXBlb2YgdiA9PT0gJ2Z1bmN0aW9uJykgZWwuYWRkRXZlbnRMaXN0ZW5lcihrLnNsaWNlKDIpLCB2KTsKICAgICAgZWxzZSBpZiAoUFJPUFMuaGFzKGspKSBlbFtrXSA9IHY7CiAgICAgIGVsc2UgZWwuc2V0QXR0cmlidXRlKGssIHYgPT09IHRydWUgPyAnJyA6IFN0cmluZyh2KSk7CiAgICB9CiAgICBhcHBlbmQoZWwsIGtpZHMpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgZnVuY3Rpb24gYXBwZW5kKGVsLCBraWRzKSB7CiAgICBmb3IgKGNvbnN0IGtpZCBvZiBraWRzLmZsYXQoSW5maW5pdHkpKSB7CiAgICAgIGlmIChraWQgPT09IG51bGwgfHwga2lkID09PSB1bmRlZmluZWQgfHwga2lkID09PSBmYWxzZSkgY29udGludWU7CiAgICAgIGVsLmFwcGVuZENoaWxkKHR5cGVvZiBraWQgPT09ICdzdHJpbmcnIHx8IHR5cGVvZiBraWQgPT09ICdudW1iZXInCiAgICAgICAgPyBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShTdHJpbmcoa2lkKSkgOiBraWQpOwogICAgfQogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIEljb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAo",
"gIC8vCiAgLy8gTWF0ZXJpYWwgU3ltYm9scyBwYXRocyAoQXBhY2hlIDIuMCksIHBsdXMgdGhlIGJvYXJkIGdseXBoIGRyYXduIHRvCiAgLy8gbWF0Y2ggdGhlIHRvb2xiYXIgaWNvbi4KCiAgY29uc3QgYmFyID0gKHgsIHksIHcsIGh0KSA9PgogICAgYE0ke3ggKyAxfSAke3l9aCR7dyAtIDJ9YTEgMSAwIDAgMSAxIDF2JHtodCAtIDJ9YTEgMSAwIDAgMS0xIDFoLSR7dyAtIDJ9YTEgMSAwIDAgMS0xLTF2LSR7aHQgLSAyfWExIDEgMCAwIDEgMS0xemA7CgogIGNvbnN0IElDT05TID0gewogICAgYm9hcmQ6IGJhcigzLCA0LCA1LCAxNikgKyBiYXIoOS41LCA0LCA1LCAxMCkgKyBiYXIoMTYsIDQsIDUsIDEzKSwKICAgIGNsb3NlOiAnTTE5IDYuNDEgMTcuNTkgNSAxMiAxMC41OSA2LjQxIDUgNSA2LjQxIDEwLjU5IDEyIDUgMTcuNTkgNi40MSAxOSAxMiAxMy40MSAxNy41OSAxOSAxOSAxNy41OSAxMy40MSAxMnonLAogICAgcmVmcmVzaDogJ00xNy42NSA2LjM1QTcuOTYgNy45NiAwIDAgMCAxMiA0YTggOCAwIDEgMCA3LjczIDEwaC0yLjA4QTYgNiAwIDEgMSAxMiA2YzEuNjYgMCAzLjE0LjY5IDQuMjIgMS43OEwxMyAxMWg3VjRsLTIuMzUgMi4zNXonLAogICAgYWRkOiAnTTE5IDEzaC02djZoLTJ2LTZINXYtMmg2VjVoMnY2aDZ2MnonLAogICAgbW9yZTogJ002IDEwYTIgMiAwIDEgMCAwIDQgMiAyIDAgMCAwIDAtNHptMTIgMGEyIDIgMCAxIDAgMCA0IDIgMiAwIDAgMCAwLTR6bS02IDBhMiAyIDAgMSAwIDAgNCAyIDIgMCA",
"wIDAgMC00eicsCiAgICBzdGFyOiAnTTEyIDE3LjI3IDE4LjE4IDIxbC0xLjY0LTcuMDNMMjIgOS4yNGwtNy4xOS0uNjFMMTIgMiA5LjE5IDguNjMgMiA5LjI0bDUuNDYgNC43M0w1LjgyIDIxeicsCiAgICB0dW5lOiAnTTMgMTd2Mmg2di0ySDN6TTMgNXYyaDEwVjVIM3ptMTAgMTZ2LTJoOHYtMmgtOHYtMmgtMnY2aDJ6TTcgOXYySDN2Mmg0djJoMlY5SDd6bTE0IDR2LTJIMTF2MmgxMHptLTYtNGgyVjdoNFY1aC00VjNoLTJ2NnonLAogICAgdXA6ICdNNCAxMmwxLjQxIDEuNDFMMTEgNy44M1YyMGgyVjcuODNsNS41OCA1LjU5TDIwIDEybC04LTgtOCA4eicsCiAgICBkb3duOiAnTTIwIDEybC0xLjQxLTEuNDFMMTMgMTYuMTdWNGgtMnYxMi4xN2wtNS41OC01LjU5TDQgMTJsOCA4IDgtOHonLAogICAgc2VhcmNoOiAnTTE1LjUgMTRoLS43OWwtLjI4LS4yN0E2LjQ3IDYuNDcgMCAwIDAgMTYgOS41IDYuNSA2LjUgMCAxIDAgOS41IDE2YzEuNjEgMCAzLjA5LS41OSA0LjIzLTEuNTdsLjI3LjI4di43OWw1IDQuOTlMMjAuNDkgMTlsLTQuOTktNXptLTYgMEM3LjAxIDE0IDUgMTEuOTkgNSA5LjVTNy4wMSA1IDkuNSA1IDE0IDcuMDEgMTQgOS41IDExLjk5IDE0IDkuNSAxNHonLAogICAgY2hlY2s6ICdNOSAxNi4xNyA0LjgzIDEybC0xLjQyIDEuNDFMOSAxOSAyMSA3bC0xLjQxLTEuNDF6JywKICAgIGNhcmV0OiAnTTcgMTBsNSA1IDUtNXonLAogICAgb3BlbjogJ00xOSAxOUg1VjVoN1YzSDVhMiAyIDAgMCAwLTIgMnYxNGEyIDI",
"gMCAwIDAgMiAyaDE0YzEuMSAwIDItLjkgMi0ydi03aC0ydjd6TTE0IDN2MmgzLjU5bC05LjgzIDkuODMgMS40MSAxLjQxTDE5IDYuNDFWMTBoMlYzaC03eicsCiAgICBjYWxlbmRhcjogJ00yMCAzaC0xVjFoLTJ2Mkg3VjFINXYySDRjLTEuMSAwLTIgLjktMiAydjE2YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNWMwLTEuMS0uOS0yLTItMnptMCAxOEg0VjEwaDE2djExem0wLTEzSDRWNWgxNnYzeicsCiAgICBwcmV2OiAnTTE1LjQxIDcuNDEgMTQgNmwtNiA2IDYgNiAxLjQxLTEuNDFMMTAuODMgMTJ6JywKICAgIGNvbHVtbnM6ICdNMTAgMThoNVY1aC01djEzem0tNiAwaDVWNUg0djEzek0xNiA1djEzaDVWNWgtNXonLAogICAgcm93czogJ00yMSA4SDNWNGgxOHY0em0wIDJIM3Y0aDE4di00em0wIDZIM3Y0aDE4di00eicsCiAgICBtb250aDogJ00yMCA0SDRjLTEuMSAwLTIgLjktMiAydjEyYzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNmMwLTEuMS0uOS0yLTItMnpNOCAxMUg0VjZoNHY1em02IDBoLTRWNmg0djV6bTYgMGgtNFY2aDR2NXpNOCAxOEg0di01aDR2NXptNiAwaC00di01aDR2NXptNiAwaC00di01aDR2NXonLAogICAga2V5OiAnTTIxIDEwaC04LjM1QTUuOTkgNS45OSAwIDAgMCA3IDZjLTMuMzEgMC02IDIuNjktNiA2czIuNjkgNiA2IDZhNS45OSA1Ljk5IDAgMCAwIDUuNjUtNEgxM2wyIDIgMi0yIDIgMiA0LTQuMDRMMjEgMTB6TTcgMTVjLTEuNjUgMC0zLTEuMzUtMy0zczEuMzU",
"tMyAzLTMgMyAxLjM1IDMgMy0xLjM1IDMtMyAzeicsCiAgICBob3VyZ2xhc3M6ICdNNiAydjZoLjAxTDYgOC4wMSAxMCAxMmwtNCA0IC4wMS4wMUg2VjIyaDEydi01Ljk5aC0uMDFMMTggMTZsLTQtNCA0LTMuOTktLjAxLS4wMUgxOFYySDZ6bTEwIDE0LjVWMjBIOHYtMy41bDQtNCA0IDR6bS00LTUtNC00VjRoOHYzLjVsLTQgNHonLAogICAgbmlnaHQ6ICdNMTIuMzQgMi4wMkM2LjU5IDEuODIgMiA2LjQyIDIgMTJjMCA1LjUyIDQuNDggMTAgMTAgMTAgMy43MSAwIDYuOTMtMi4wMiA4LjY2LTUuMDItNy41MS0uMjUtMTIuMDktOC40My04LjMyLTE0Ljk2eicsCiAgICBuZXh0OiAnTTEwIDYgOC41OSA3LjQxIDEzLjE3IDEybC00LjU4IDQuNTlMMTAgMThsNi02eicsCiAgICBtYWlsOiAnTTIwIDRINGMtMS4xIDAtMS45OS45LTEuOTkgMkwyIDE4YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNmMwLTEuMS0uOS0yLTItMnptMCA0LTggNS04LTVWNmw4IDUgOC01djJ6JywKICAgIGJhY2s6ICdNMjAgMTFINy44M2w1LjU5LTUuNTlMMTIgNGwtOCA4IDggOCAxLjQxLTEuNDFMNy44MyAxM0gyMHYtMnonLAogICAgYXJyb3c6ICdNMTIgNGwtMS40MSAxLjQxTDE2LjE3IDExSDR2MmgxMi4xN2wtNS41OCA1LjU5TDEyIDIwbDgtOHonLAogICAgcmVtb3ZlOiAnTTE5IDEzSDV2LTJoMTR2MnonLAogICAgbm90ZTogJ00xNCAySDZjLTEuMSAwLTEuOTkuOS0xLjk5IDJMNCAyMGMwIDEuMS44OSAyIDEuOTkgMkgxOGMxLjEgMCA",
"yLS45IDItMlY4bC02LTZ6bTIgMTZIOHYtMmg4djJ6bTAtNEg4di0yaDh2MnptLTMtNVYzLjVMMTguNSA5SDEzeicsCiAgICBkZWxldGU6ICdNNiAxOWMwIDEuMS45IDIgMiAyaDhjMS4xIDAgMi0uOSAyLTJWN0g2djEyek0xOSA0aC0zLjVsLTEtMWgtNWwtMSAxSDV2MmgxNFY0eicsCiAgICBlZGl0OiAnTTMgMTcuMjVWMjFoMy43NUwxNy44MSA5Ljk0bC0zLjc1LTMuNzVMMyAxNy4yNXpNMjAuNzEgNy4wNGExIDEgMCAwIDAgMC0xLjQxbC0yLjM0LTIuMzRhMSAxIDAgMCAwLTEuNDEgMGwtMS44MyAxLjgzIDMuNzUgMy43NSAxLjgzLTEuODN6JywKICAgIGZvbGRlcjogJ00xMCA0SDRjLTEuMSAwLTEuOTkuOS0xLjk5IDJMMiAxOGMwIDEuMS45IDIgMiAyaDE2YzEuMSAwIDItLjkgMi0yVjhjMC0xLjEtLjktMi0yLTJoLThsLTItMnonLAogICAgbm90ZXM6ICdNMyAxOGgxMnYtMkgzdjJ6TTMgNnYyaDE4VjZIM3ptMCA3aDE4di0ySDN2MnonLAogICAgLy8gRm9ybWF0dGluZyB0b29sYmFyLgogICAgYm9sZDogJ00xNS42IDEwLjc5Yy45Ny0uNjcgMS42NS0xLjc3IDEuNjUtMi43OSAwLTIuMjYtMS43NS00LTQtNEg3djE0aDcuMDRjMi4wOSAwIDMuNzEtMS43IDMuNzEtMy43OSAwLTEuNTItLjg2LTIuODItMi4xNS0zLjQyek0xMCA2LjVoM2MuODMgMCAxLjUuNjcgMS41IDEuNXMtLjY3IDEuNS0xLjUgMS41aC0zdi0zem0zLjUgOUgxMHYtM2gzLjVjLjgzIDAgMS41LjY3IDEuNSAxLjVzLS42NyAxLjUtMS41IDEuNXonLAogICA",
"gaXRhbGljOiAnTTEwIDR2M2gyLjIxbC0zLjQyIDhINnYzaDh2LTNoLTIuMjFsMy40Mi04SDE4VjR6JywKICAgIHN0cmlrZTogJ00xMCAxOWg0di0zaC00djN6TTUgNHYzaDV2M2g0VjdoNVY0SDV6TTMgMTRoMTh2LTJIM3YyeicsCiAgICBidWxsZXRzOiAnTTQgMTAuNWMtLjgzIDAtMS41LjY3LTEuNSAxLjVzLjY3IDEuNSAxLjUgMS41IDEuNS0uNjcgMS41LTEuNS0uNjctMS41LTEuNS0xLjV6bTAtNmMtLjgzIDAtMS41LjY3LTEuNSAxLjVTMy4xNyA3LjUgNCA3LjUgNS41IDYuODMgNS41IDYgNC44MyA0LjUgNCA0LjV6bTAgMTJjLS44MyAwLTEuNS42OC0xLjUgMS41cy42OCAxLjUgMS41IDEuNSAxLjUtLjY4IDEuNS0xLjUtLjY3LTEuNS0xLjUtMS41ek03IDE5aDE0di0ySDd2MnptMC02aDE0di0ySDd2MnptMC04djJoMTRWNUg3eicsCiAgICBudW1iZXJzOiAnTTIgMTdoMnYuNUgzdjFoMXYuNUgydjFoM3YtNEgydjF6bTEtOWgxVjRIMnYxaDF2M3ptLTEgM2gxLjhMMiAxMy4xdi45aDN2LTFIMy4yTDUgMTAuOVYxMEgydjF6bTUtNnYyaDE0VjVIN3ptMCAxNGgxNHYtMkg3djJ6bTAtNmgxNHYtMkg3djJ6JywKICAgIGNoZWNrbGlzdDogJ00yMiA3aC05djJoOVY3em0wIDhoLTl2Mmg5di0yek01LjU0IDExIDIgNy40NmwxLjQxLTEuNDEgMi4xMiAyLjEyIDQuMjQtNC4yNCAxLjQxIDEuNDFMNS41NCAxMXptMCA4TDIgMTUuNDZsMS40MS0xLjQxIDIuMTIgMi4xMiA0LjI0LTQuMjQgMS40MSAxLjQxTDUuNTQgMTl6JywKICA",
"gIGluZGVudDogJ00zIDIxaDE4di0ySDN2MnpNMyA4djhsNC00LTQtNHptOCA5aDEwdi0ySDExdjJ6TTMgM3YyaDE4VjNIM3ptOCA2aDEwVjdIMTF2MnptMCA0aDEwdi0ySDExdjJ6JywKICAgIG91dGRlbnQ6ICdNMTEgMTdoMTB2LTJIMTF2MnptLTgtNSA0IDRWOGwtNCA0em0wIDloMTh2LTJIM3Yyek0zIDN2MmgxOFYzSDN6bTggNmgxMFY3SDExdjJ6bTAgNGgxMHYtMkgxMXYyeicsCiAgICBsaW5rOiAnTTMuOSAxMmMwLTEuNzEgMS4zOS0zLjEgMy4xLTMuMWg0VjdIN2MtMi43NiAwLTUgMi4yNC01IDVzMi4yNCA1IDUgNWg0di0xLjlIN2MtMS43MSAwLTMuMS0xLjM5LTMuMS0zLjF6TTggMTNoOHYtMkg4djJ6bTktNmgtNHYxLjloNGMxLjcxIDAgMy4xIDEuMzkgMy4xIDMuMXMtMS4zOSAzLjEtMy4xIDMuMWgtNFYxN2g0YzIuNzYgMCA1LTIuMjQgNS01cy0yLjI0LTUtNS01eicsCiAgICBjbGVhcjogJ00zLjI3IDUgMiA2LjI3bDYuOTcgNi45N0w2LjUgMTloM2wxLjU3LTMuNjZMMTYuNzMgMjEgMTggMTkuNzMgMy41NSA1LjI3IDMuMjcgNXpNNiA1di4xOEw4LjgyIDhoMi40bC0uNzIgMS42OCAyLjEgMi4xTDE0LjIxIDhIMjBWNUg2eicsCiAgICB0YWJsZTogJ00yMCAzSDRjLTEuMSAwLTIgLjktMiAydjE0YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNWMwLTEuMS0uOS0yLTItMnptMCAydjNINFY1aDE2em0tMTAgMTRINHYtNGg2djR6bTAtNkg0di0zaDZ2M3ptMTAgNmgtOHYtNGg4djR6bTAtNmgtOHYtM2g",
"4djN6JywKICAgIGFsaWduTGVmdDogJ00xNSAxNUgzdjJoMTJ2LTJ6bTAtOEgzdjJoMTJWN3pNMyAxM2gxOHYtMkgzdjJ6bTAgOGgxOHYtMkgzdjJ6TTMgM3YyaDE4VjNIM3onLAogICAgYWxpZ25DZW50ZXI6ICdNNyAxNXYyaDEwdi0ySDd6bS00IDZoMTh2LTJIM3Yyem0wLThoMTh2LTJIM3Yyem00LTZ2MmgxMFY3SDd6TTMgM3YyaDE4VjNIM3onLAogICAgYWxpZ25SaWdodDogJ00zIDIxaDE4di0ySDN2MnptNi00aDEydi0ySDl2MnptLTYtNGgxOHYtMkgzdjJ6bTYtNGgxMlY3SDl2MnpNMyAzdjJoMThWM0gzeicsCiAgfTsKCiAgY29uc3QgU1ZHX05TID0gJ2h0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnJzsKCiAgZnVuY3Rpb24gaWNvbihuYW1lLCBzaXplID0gMjApIHsKICAgIGNvbnN0IHN2ZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhTVkdfTlMsICdzdmcnKTsKICAgIHN2Zy5zZXRBdHRyaWJ1dGUoJ3ZpZXdCb3gnLCAnMCAwIDI0IDI0Jyk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCd3aWR0aCcsIFN0cmluZyhzaXplKSk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCdoZWlnaHQnLCBTdHJpbmcoc2l6ZSkpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnYXJpYS1oaWRkZW4nLCAndHJ1ZScpOwogICAgc3ZnLnNldEF0dHJpYnV0ZSgnZm9jdXNhYmxlJywgJ2ZhbHNlJyk7CiAgICBzdmcuc2V0QXR0cmlidXRlKCdjbGFzcycsICdpY29uJyk7CiAgICBjb25zdCBwYXRoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudE5TKFNWR19",
"OUywgJ3BhdGgnKTsKICAgIHBhdGguc2V0QXR0cmlidXRlKCdkJywgSUNPTlNbbmFtZV0gfHwgJycpOwogICAgcGF0aC5zZXRBdHRyaWJ1dGUoJ2ZpbGwnLCAnY3VycmVudENvbG9yJyk7CiAgICBzdmcuYXBwZW5kQ2hpbGQocGF0aCk7CiAgICByZXR1cm4gc3ZnOwogIH0KCiAgLy8gVGhlIGFwcCdzIG1hcms6ICJNZCIgb24gYSB2aW9sZXQgY2lyY2xlLCBhcyBpY29ucy9pY29uLnN2ZyBkcmF3cwogIC8vIGl0IChhIHRlc3Qga2VlcHMgdGhlIHR3byB0aGUgc2FtZSkuCiAgY29uc3QgTE9HTyA9IHsKICAgIGNvbG91cnM6IFsnIzZEMjhEOScsICcjOUY2N0ZBJ10sCiAgICBsZXR0ZXJzOiAnTTYxLjQ1IDg5VjYwLjkzUTYxLjQ1IDU5Ljk4IDYxLjQ3IDU5LjAyUTYxLjQ5IDU4LjA3IDYxLjc4IDUwLjg0UTU5LjQ1IDU5LjY4IDU4LjMzIDYzLjE3TDQ5Ljk4IDg5SDQzLjA4TDM0LjczIDYzLjE3TDMxLjIyIDUwLjg0UTMxLjYxIDU4LjQ3IDMxLjYxIDYwLjkzVjg5SDIzVjQyLjY5SDM1Ljk4TDQ0LjI3IDY4LjU5TDQ0Ljk5IDcxLjA5TDQ2LjU3IDc3LjNMNDguNjQgNjkuODdMNTcuMTUgNDIuNjlINzAuMDdWODlaIE05Ny41OCA5MFE5Ny40NyA4OS41OSA5Ny4zMiA4Ny45NFE5Ny4xNyA4Ni4yOSA5Ny4xNyA4NS4ySDk3LjA3UTk0LjU4IDkwLjU0IDg3LjYzIDkwLjU0UTgyLjQ4IDkwLjU0IDc5LjY3IDg2LjUyUTc2Ljg2IDgyLjUgNzYuODYgNzUuMjdRNzYuODYgNjcuOTQgNzkuODIgNjMuOTRRODIuNzggNTkuOTUgODguMiA1OS4",
"5NVE5MS4zNCA1OS45NSA5My42MiA2MS4yNlE5NS44OSA2Mi41NyA5Ny4xMiA2NS4xNkg5Ny4xN0w5Ny4xMiA2MC4zVjQ5LjUzSDEwNC43OFY4My41NlExMDQuNzggODYuMjkgMTA1IDkwWk05Ny4yMyA3NS4wOFE5Ny4yMyA3MC4zMSA5NS42MyA2Ny43M1E5NC4wNCA2NS4xNiA5MC45MyA2NS4xNlE4Ny44NSA2NS4xNiA4Ni4zNSA2Ny42NVE4NC44NSA3MC4xNSA4NC44NSA3NS4yN1E4NC44NSA4NS4zMSA5MC44OCA4NS4zMVE5My45IDg1LjMxIDk1LjU3IDgyLjY1UTk3LjIzIDc5Ljk5IDk3LjIzIDc1LjA4WicsCiAgfTsKICBsZXQgbG9nb0NvdW50ID0gMDsKCiAgZnVuY3Rpb24gbG9nbyhzaXplID0gMjgpIHsKICAgIGNvbnN0IGVsID0gKHRhZywgYXR0cnMpID0-IHsKICAgICAgY29uc3QgbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhTVkdfTlMsIHRhZyk7CiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGF0dHJzKSkgbi5zZXRBdHRyaWJ1dGUoaywgdik7CiAgICAgIHJldHVybiBuOwogICAgfTsKICAgIC8vIEVhY2ggY29weSBpdHMgb3duIGdyYWRpZW50IGlkOiB0d28gbWFya3MgaW4gb25lIHBhZ2UgbXVzdCBub3Qgc2hhcmUuCiAgICBjb25zdCBpZCA9IGBna2ItbG9nby0keysrbG9nb0NvdW50fWA7CiAgICBjb25zdCBncmFkID0gZWwoJ2xpbmVhckdyYWRpZW50JywgeyBpZCwgeDE6ICcwJywgeTE6ICcwJywgeDI6ICcxJywgeTI6ICcxJyB9KTsKICAgIGdyYWQuYXBwZW5kKGVsKCd",
"zdG9wJywgeyBvZmZzZXQ6ICcwJywgJ3N0b3AtY29sb3InOiBMT0dPLmNvbG91cnNbMF0gfSksIGVsKCdzdG9wJywgeyBvZmZzZXQ6ICcxJywgJ3N0b3AtY29sb3InOiBMT0dPLmNvbG91cnNbMV0gfSkpOwogICAgY29uc3QgZGVmcyA9IGVsKCdkZWZzJywge30pOwogICAgZGVmcy5hcHBlbmQoZ3JhZCk7CiAgICBjb25zdCBzdmcgPSBlbCgnc3ZnJywgeyB2aWV3Qm94OiAnOCA4IDExMiAxMTInLCB3aWR0aDogU3RyaW5nKHNpemUpLCBoZWlnaHQ6IFN0cmluZyhzaXplKSwgJ2FyaWEtaGlkZGVuJzogJ3RydWUnLCBmb2N1c2FibGU6ICdmYWxzZScsIGNsYXNzOiAnbG9nby1tYXJrJyB9KTsKICAgIHN2Zy5hcHBlbmQoZGVmcywgZWwoJ2NpcmNsZScsIHsgY3g6ICc2NCcsIGN5OiAnNjQnLCByOiAnNTYnLCBmaWxsOiBgdXJsKCMke2lkfSlgIH0pLCBlbCgncGF0aCcsIHsgZDogTE9HTy5sZXR0ZXJzLCBmaWxsOiAnI2ZmZicgfSkpOwogICAgcmV0dXJuIHN2ZzsKICB9CgogIC8vIOKUgOKUgCBTaGFkb3cgaG9zdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGFkb3B0U3R5bGVzKHJvb3QsIGNzc1RleHQpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHNoZWV0ID0gbmV",
"3IENTU1N0eWxlU2hlZXQoKTsKICAgICAgc2hlZXQucmVwbGFjZVN5bmMoY3NzVGV4dCk7CiAgICAgIHJvb3QuYWRvcHRlZFN0eWxlU2hlZXRzID0gW3NoZWV0XTsKICAgICAgcmV0dXJuOwogICAgfSBjYXRjaCB7IC8qIG9sZGVyIGVuZ2luZSBvciBhIGhvc3RpbGUgQ1NQOiBmYWxsIHRocm91Z2ggKi8gfQogICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpOwogICAgc3R5bGUudGV4dENvbnRlbnQgPSBjc3NUZXh0OwogICAgcm9vdC5hcHBlbmRDaGlsZChzdHlsZSk7CiAgfQoKICBmdW5jdGlvbiBtb3VudFNoYWRvdyhpZCwgY3NzVGV4dCkgewogICAgLy8gQSBwcmV2aW91cyBpbmplY3Rpb24gKGV4dGVuc2lvbiByZWxvYWRlZCB3aXRob3V0IHJlbG9hZGluZyBHbWFpbCkKICAgIC8vIGxlYXZlcyBhbiBvcnBoYW5lZCBob3N0IGJlaGluZDsgcmVwbGFjZSBpdCByYXRoZXIgdGhhbiBzdGFjayBhIHNlY29uZC4KICAgIGNvbnN0IHN0YWxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgaWYgKHN0YWxlKSBzdGFsZS5yZW1vdmUoKTsKCiAgICBjb25zdCBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBob3N0LmlkID0gaWQ7CiAgICBjb25zdCByb290ID0gaG9zdC5hdHRhY2hTaGFkb3coeyBtb2RlOiAnb3BlbicgfSk7CiAgICBhZG9wdFN0eWxlcyhyb290LCBjc3NUZXh0KTsKCiAgICAvLyBLZXkgZXZlbnRzIGZyb20gaW5zaWRlIGEgc2hhZG9",
"3IHJvb3QgcmVhY2ggR21haWwgcmV0YXJnZXRlZCB0byB0aGUKICAgIC8vIGhvc3QsIHdoaWNoIGlzIG5vdCBhbiBpbnB1dCAtIHNvIHR5cGluZyAiYyIgaW4gb3VyIHNlYXJjaCBib3ggd291bGQKICAgIC8vIG9wZW4gR21haWwncyBDb21wb3NlLiBPdXIgb3duIGhhbmRsZXJzIGluc2lkZSB0aGUgcm9vdCBydW4gZmlyc3Q7CiAgICAvLyBzdG9wcGluZyBwcm9wYWdhdGlvbiBoZXJlIGtlZXBzIEdtYWlsJ3Mgc2hvcnRjdXRzIG91dCBvZiBpdC4KICAgIGZvciAoY29uc3QgdHlwZSBvZiBbJ2tleWRvd24nLCAna2V5cHJlc3MnLCAna2V5dXAnXSkgewogICAgICBob3N0LmFkZEV2ZW50TGlzdGVuZXIodHlwZSwgZSA9PiBlLnN0b3BQcm9wYWdhdGlvbigpKTsKICAgIH0KCiAgICAoZG9jdW1lbnQuYm9keSB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQpLmFwcGVuZENoaWxkKGhvc3QpOwogICAgcmV0dXJuIHsgaG9zdCwgcm9vdCB9OwogIH0KCiAgLy8g4pSA4pSAIFRvYXN0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gdG9hc3RMYXllcihyb290KSB7CiAgICBsZXQgbGF5ZXIgPSByb290LnF1ZXJ5U2VsZWN0b3IoJy50b2FzdHM",
"nKTsKICAgIGlmICghbGF5ZXIpIHsKICAgICAgbGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAndG9hc3RzJywgcm9sZTogJ3N0YXR1cycsICdhcmlhLWxpdmUnOiAncG9saXRlJyB9KTsKICAgICAgcm9vdC5hcHBlbmRDaGlsZChsYXllcik7CiAgICB9CiAgICByZXR1cm4gbGF5ZXI7CiAgfQoKICBmdW5jdGlvbiB0b2FzdChyb290LCBtZXNzYWdlLCB7IGtpbmQgPSAnaW5mbycsIGFjdGlvbiA9IG51bGwsIHRpbWVvdXQgfSA9IHt9KSB7CiAgICBjb25zdCBsYXllciA9IHRvYXN0TGF5ZXIocm9vdCk7CiAgICAvLyBBIG5ldyBjb25maXJtYXRpb24gcmVwbGFjZXMgdGhlIGxhc3Qgb25lIHJhdGhlciB0aGFuIHN0YWNraW5nIHVwOwogICAgLy8gZXJyb3JzIHN0YXkgdW50aWwgcmVhZCBvciB0aW1lZCBvdXQuIE9uZSBzdGlsbCBvZmZlcmluZyBhbiBhY3Rpb24KICAgIC8vIChVbmRvKSBpcyBrZXB0IHRvbywgc2luY2UgaXRzIGJ1dHRvbiBtYXkgYmUgYWJvdXQgdG8gYmUgY2xpY2tlZC4KICAgIGlmIChraW5kICE9PSAnZXJyb3InKSB7CiAgICAgIGZvciAoY29uc3Qgb2xkIG9mIGxheWVyLnF1ZXJ5U2VsZWN0b3JBbGwoJy50b2FzdDpub3QoLnRvYXN0LWVycm9yKScpKSB7CiAgICAgICAgaWYgKCFvbGQucXVlcnlTZWxlY3RvcignLnRvYXN0LWFjdGlvbicpKSBvbGQucmVtb3ZlKCk7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGNsb3NlID0gKCkgPT4gZWwucmVtb3ZlKCk7CiAgICBjb25zdCBlbCA9IGgoJ2RpdicsIHsgY2x",
"hc3M6IFsndG9hc3QnLCBraW5kID09PSAnZXJyb3InICYmICd0b2FzdC1lcnJvciddIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndG9hc3QtdGV4dCcsIHRleHQ6IG1lc3NhZ2UgfSksCiAgICAgIGFjdGlvbiAmJiBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICd0b2FzdC1hY3Rpb24nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYWN0aW9uLmxhYmVsLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgYWN0aW9uLm9uQ2xpY2soKTsgfSwKICAgICAgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICd0b2FzdC1jbG9zZSBpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdEaXNtaXNzJywgb25jbGljazogY2xvc2UgfSwKICAgICAgICBpY29uKCdjbG9zZScsIDE4KSkKICAgICk7CiAgICBsYXllci5hcHBlbmRDaGlsZChlbCk7CiAgICAvLyBFcnJvcnMgc3RheSBhIGxpdHRsZSBsb25nZXI6IHRoZXkgdXN1YWxseSBuZWVkIHJlYWRpbmcsIG5vdCBnbGFuY2luZy4KICAgIHNldFRpbWVvdXQoY2xvc2UsIHRpbWVvdXQgfHwgKGtpbmQgPT09ICdlcnJvcicgPyA5MDAwIDogNTAwMCkpOwogICAgcmV0dXJuIGVsOwogIH0KCiAgLy8g4pSA4pSAIE1lbnVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOK",
"UgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gaXRlbXM6IHsgbGFiZWwsIG9uU2VsZWN0LCBpY29uPywgY2hlY2tlZD8sIGRpc2FibGVkPywgZGFuZ2VyPyB9CiAgLy8gICAgICB8IHsgaGVhZGluZyB9IHwgeyBzZXBhcmF0b3I6IHRydWUgfQoKICBjb25zdCBvcGVuTWVudXMgPSBuZXcgV2Vha01hcCgpOyAvLyByb290IOKGkiBjbG9zZSBmdW5jdGlvbgoKICBmdW5jdGlvbiBjbG9zZU1lbnUocm9vdCkgewogICAgY29uc3QgY2xvc2UgPSBvcGVuTWVudXMuZ2V0KHJvb3QpOwogICAgaWYgKGNsb3NlKSBjbG9zZSgpOwogIH0KCiAgZnVuY3Rpb24gaXNNZW51T3Blbihyb290KSB7CiAgICByZXR1cm4gb3Blbk1lbnVzLmhhcyhyb290KTsKICB9CgogIGZ1bmN0aW9uIG9wZW5NZW51KHJvb3QsIGFuY2hvciwgaXRlbXMsIHsgbGFiZWwgPSAnQWN0aW9ucycsIHBsYWNlbWVudCA9ICdiZWxvdycgfSA9IHt9KSB7CiAgICBjbG9zZU1lbnUocm9vdCk7CgogICAgY29uc3QgbWVudSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51Jywgcm9sZTogJ21lbnUnLCAnYXJpYS1sYWJlbCc6IGxhYmVsIH0pOwogICAgZm9yIChjb25zdCBpdCBvZiBpdGVtcykgewogICAgICBpZiAoaXQuc2VwYXJhdG9yKSB7IG1lbnUuYXBwZW5kQ2hpbGQoaCgnZGl2JywgeyBjbGFzczogJ21lbnUtc2VwJywgcm9sZTogJ3NlcGFyYXRvcicgfSkpOyBjb250aW51ZTsgfQogICAgICBpZiAoaXQ",
"uaGVhZGluZykgeyBtZW51LmFwcGVuZENoaWxkKGgoJ2RpdicsIHsgY2xhc3M6ICdtZW51LWhlYWRpbmcnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScsIHRleHQ6IGl0LmhlYWRpbmcgfSkpOyBjb250aW51ZTsgfQogICAgICBjb25zdCByb2xlID0gaXQuY2hlY2tlZCA9PT0gdW5kZWZpbmVkID8gJ21lbnVpdGVtJyA6ICdtZW51aXRlbXJhZGlvJzsKICAgICAgbWVudS5hcHBlbmRDaGlsZChoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6IFsnbWVudS1pdGVtJywgaXQuZGFuZ2VyICYmICdkYW5nZXInXSwKICAgICAgICB0eXBlOiAnYnV0dG9uJywKICAgICAgICByb2xlLAogICAgICAgICdhcmlhLWNoZWNrZWQnOiBpdC5jaGVja2VkID09PSB1bmRlZmluZWQgPyBudWxsIDogU3RyaW5nKCEhaXQuY2hlY2tlZCksCiAgICAgICAgZGlzYWJsZWQ6ICEhaXQuZGlzYWJsZWQsCiAgICAgICAgZGF0YXNldDogaXQua2V5ID8geyBrZXk6IGl0LmtleSB9IDogdW5kZWZpbmVkLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY2xvc2UoKTsgaXQub25TZWxlY3QoKTsgfSwKICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtaWNvbicgfSwgaXQuY2hlY2tlZCA_IGljb24oJ2NoZWNrJywgMTgpIDogKGl0Lmljb24gPyBpY29uKGl0Lmljb24sIDE4KSA6IG51bGwpKSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21lbnUtbGFiZWwnLCB0ZXh0OiBpdC5sYWJlbCB9KQogICAgICApKTsKICAgIH0KCiAgICByb29",
"0LmFwcGVuZENoaWxkKG1lbnUpOwogICAgYW5jaG9yLnNldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsICd0cnVlJyk7CgogICAgLy8gRml4ZWQgcG9zaXRpb25pbmcgYWdhaW5zdCB0aGUgYW5jaG9yLCBmbGlwcGVkIG9yIG51ZGdlZCBzbyB0aGUgbWVudQogICAgLy8gbmV2ZXIgcnVucyBvZmYgdGhlIHZpZXdwb3J0IGVkZ2UuCiAgICBjb25zdCByID0gYW5jaG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgbXcgPSBtZW51Lm9mZnNldFdpZHRoOwogICAgY29uc3QgbWggPSBtZW51Lm9mZnNldEhlaWdodDsKICAgIGxldCBsZWZ0ID0gTWF0aC5taW4oci5sZWZ0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIG13IC0gOCk7CiAgICBpZiAoci5yaWdodCAtIG13ID4gOCAmJiBsZWZ0ICsgbXcgPiB3aW5kb3cuaW5uZXJXaWR0aCAtIDgpIGxlZnQgPSByLnJpZ2h0IC0gbXc7CiAgICBsZWZ0ID0gTWF0aC5tYXgoOCwgbGVmdCk7CiAgICBsZXQgdG9wID0gcGxhY2VtZW50ID09PSAnYWJvdmUnID8gci50b3AgLSBtaCAtIDYgOiByLmJvdHRvbSArIDY7CiAgICBpZiAodG9wICsgbWggPiB3aW5kb3cuaW5uZXJIZWlnaHQgLSA4KSB0b3AgPSByLnRvcCAtIG1oIC0gNjsKICAgIGlmICh0b3AgPCA4KSB0b3AgPSA4OwogICAgbWVudS5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5yb3VuZChsZWZ0KX1weGA7CiAgICBtZW51LnN0eWxlLnRvcCA9IGAke01hdGgucm91bmQodG9wKX1weGA7CgogICAgY29uc3QgYnV0dG9ucyA9ICg",
"pID0-IFsuLi5tZW51LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tZW51LWl0ZW06bm90KFtkaXNhYmxlZF0pJyldOwogICAgY29uc3Qgb25LZXkgPSBlID0-IHsKICAgICAgY29uc3QgbGlzdCA9IGJ1dHRvbnMoKTsKICAgICAgY29uc3QgaSA9IGxpc3QuaW5kZXhPZihyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgY2xvc2UoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93RG93bicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyAobGlzdFtpICsgMV0gfHwgbGlzdFswXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0Fycm93VXAnKSB7IGUucHJldmVudERlZmF1bHQoKTsgKGxpc3RbaSAtIDFdIHx8IGxpc3RbbGlzdC5sZW5ndGggLSAxXSkuZm9jdXMoKTsgfQogICAgICBlbHNlIGlmIChlLmtleSA9PT0gJ0hvbWUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFswXSAmJiBsaXN0WzBdLmZvY3VzKCk7IH0KICAgICAgZWxzZSBpZiAoZS5rZXkgPT09ICdFbmQnKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGlzdFtsaXN0Lmxlbmd0aCAtIDFdICYmIGxpc3RbbGlzdC5sZW5ndGggLSAxXS5mb2N1cygpOyB9CiAgICAgIGVsc2UgaWYgKGUua2V5ID09PSAnVGFiJykgeyBjbG9zZSgpOyB9CiAgICB9OwogICAgLy8gQ2xpY2tzIGFueXdoZXJlIGVsc2UgLSBpbiBvdXIgcm9vdCBvciB",
"vbiBHbWFpbCBpdHNlbGYgLSBkaXNtaXNzIGl0LgogICAgY29uc3Qgb25Qb2ludGVyID0gZSA9PiB7CiAgICAgIGlmICghZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhtZW51KSAmJiAhZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhhbmNob3IpKSBjbG9zZSgpOwogICAgfTsKCiAgICAvLyBJZiB0aGUgbWVudSBoZWxkIGZvY3VzLCBpdCBnb2VzIGJhY2sgdG8gdGhlIGFuY2hvciAtIG9uIEVzYywgb24KICAgIC8vIGNob29zaW5nIGFuIGl0ZW0gKGJlZm9yZSB0aGUgYWN0aW9uIHJ1bnMsIHNvIGFuIGFjdGlvbiB0aGF0CiAgICAvLyByZS1yZW5kZXJzIGNhbiBmaW5kIHRoZSBhbmNob3IgYWdhaW4gYnkgaXRzIGRhdGEta2V5KSwgYW5kIHdoZW4gYQogICAgLy8gcmUtcmVuZGVyIGNsb3NlcyB0aGUgbWVudSBmcm9tIHVuZGVybmVhdGguCiAgICBmdW5jdGlvbiBjbG9zZSgpIHsKICAgICAgaWYgKG9wZW5NZW51cy5nZXQocm9vdCkgIT09IGNsb3NlKSByZXR1cm47CiAgICAgIGNvbnN0IGhhZEZvY3VzID0gbWVudS5jb250YWlucyhyb290LmFjdGl2ZUVsZW1lbnQpOwogICAgICBvcGVuTWVudXMuZGVsZXRlKHJvb3QpOwogICAgICBtZW51LnJlbW92ZSgpOwogICAgICBpZiAoaGFkRm9jdXMgJiYgYW5jaG9yLmlzQ29ubmVjdGVkKSBhbmNob3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBhbmNob3Iuc2V0QXR0cmlidXRlKCdhcmlhLWV4cGFuZGVkJywgJ2ZhbHNlJyk7CiAgICAgIG1lbnUucmVtb3Z",
"lRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCBvblBvaW50ZXIsIHRydWUpOwogICAgfQoKICAgIG1lbnUuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgb25Qb2ludGVyLCB0cnVlKTsKICAgIG9wZW5NZW51cy5zZXQocm9vdCwgY2xvc2UpOwoKICAgIGNvbnN0IGZpcnN0ID0gYnV0dG9ucygpWzBdOwogICAgaWYgKGZpcnN0KSBmaXJzdC5mb2N1cygpOwogICAgcmV0dXJuIGNsb3NlOwogIH0KCiAgLy8g4pSA4pSAIFNvdW5kIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBBIHNob3J0LCBzb2Z0IGNoaW1lOiB0d28gcmlzaW5nIG5vdGVzLCBlYWNoIGEgYmVsbC1saWtlIHNpbmUgd2l0aCBhCiAgLy8gcXVpZXRlciBvY3RhdmUgYWJvdmUsIHF1aWNrIHRvIHN0cmlrZSBhbmQgc2xvdyB0byBmYWRlLiBNYWRlIG9uIHRoZQogIC8vIHNwb3Qgd2l0aCBXZWIgQXVkaW8gcmF0aGVyIHRoYW4gcGxheWVkIGZyb20gYSBmaWxlLCBzbyB0aGVyZSBpcwo",
"gIC8vIG5vdGhpbmcgdG8gbG9hZCBvciBmZXRjaC4gRWFjaCBjaGltZSBoYXMgaXRzIG93biBhdWRpbyBjb250ZXh0LCBjbG9zZWQKICAvLyBvbmNlIGl0IGhhcyBydW5nLCBzbyBub3RoaW5nIGtlZXBzIHRoZSBjb21wdXRlcidzIHNvdW5kIG9wZW4gaW4KICAvLyBiZXR3ZWVuLiBJZiB0aGUgYnJvd3NlciBoYXMgbm8gc291bmQsIG9yIHdpbGwgbm90IHBsYXkgb25lIHlldCwgaXQKICAvLyBzdGF5cyBxdWlldDogYSBjaGltZSBpcyBuZXZlciB3b3J0aCBhbiBlcnJvci4KICBjb25zdCBDSElNRV9OT1RFUyA9IFtbNzg0LCAwXSwgWzEwNDcsIDAuMDldXTsgLy8gRzUsIHRoZW4gQzY6IEh6LCBzZWNvbmRzIGluCiAgY29uc3QgQ0hJTUVfRkFERSA9IDAuNjsgICAgICAgICAgICAgICAgICAgICAgIC8vIHNlY29uZHMgZWFjaCBub3RlIHJpbmdzCiAgY29uc3QgQ0hJTUVfVk9MVU1FID0gMC4xODsKCiAgZnVuY3Rpb24gY2hpbWUoKSB7CiAgICBjb25zdCBDdHggPSB3aW5kb3cuQXVkaW9Db250ZXh0IHx8IHdpbmRvdy53ZWJraXRBdWRpb0NvbnRleHQ7CiAgICBpZiAoIUN0eCkgcmV0dXJuOwogICAgbGV0IGN0eCA9IG51bGw7CiAgICB0cnkgewogICAgICBjdHggPSBuZXcgQ3R4KCk7CiAgICAgIGNvbnN0IHN0YXJ0ID0gY3R4LmN1cnJlbnRUaW1lICsgMC4wMTsKICAgICAgY29uc3Qgb3V0ID0gY3R4LmNyZWF0ZUdhaW4oKTsKICAgICAgb3V0LmdhaW4udmFsdWUgPSBDSElNRV9WT0xVTUU7CiAgICAgIG91dC5jb25uZWN0KGN",
"0eC5kZXN0aW5hdGlvbik7CiAgICAgIGZvciAoY29uc3QgW2ZyZXEsIGF0XSBvZiBDSElNRV9OT1RFUykgewogICAgICAgIGNvbnN0IHQgPSBzdGFydCArIGF0OwogICAgICAgIGNvbnN0IGVudiA9IGN0eC5jcmVhdGVHYWluKCk7CiAgICAgICAgZW52LmdhaW4uc2V0VmFsdWVBdFRpbWUoMC4wMDAxLCB0KTsKICAgICAgICBlbnYuZ2Fpbi5leHBvbmVudGlhbFJhbXBUb1ZhbHVlQXRUaW1lKDEsIHQgKyAwLjAwOCk7CiAgICAgICAgZW52LmdhaW4uZXhwb25lbnRpYWxSYW1wVG9WYWx1ZUF0VGltZSgwLjAwMDEsIHQgKyBDSElNRV9GQURFKTsKICAgICAgICBlbnYuY29ubmVjdChvdXQpOwogICAgICAgIGZvciAoY29uc3QgW3RpbWVzLCBsZXZlbF0gb2YgW1sxLCAxXSwgWzIsIDAuMjVdXSkgewogICAgICAgICAgY29uc3Qgb3NjID0gY3R4LmNyZWF0ZU9zY2lsbGF0b3IoKTsKICAgICAgICAgIG9zYy5mcmVxdWVuY3kudmFsdWUgPSBmcmVxICogdGltZXM7CiAgICAgICAgICBjb25zdCBnID0gY3R4LmNyZWF0ZUdhaW4oKTsKICAgICAgICAgIGcuZ2Fpbi52YWx1ZSA9IGxldmVsOwogICAgICAgICAgb3NjLmNvbm5lY3QoZykuY29ubmVjdChlbnYpOwogICAgICAgICAgb3NjLnN0YXJ0KHQpOwogICAgICAgICAgb3NjLnN0b3AodCArIENISU1FX0ZBREUgKyAwLjA1KTsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKGN0eC5zdGF0ZSA9PT0gJ3N1c3BlbmRlZCcpIGN0eC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7CiAgICA",
"gIGNvbnN0IGRvbmUgPSBjdHg7CiAgICAgIHNldFRpbWVvdXQoKCkgPT4gZG9uZS5jbG9zZSgpLmNhdGNoKCgpID0-IHt9KSwgMTAwMCk7CiAgICB9IGNhdGNoIChfKSB7CiAgICAgIGlmIChjdHgpIGN0eC5jbG9zZSgpLmNhdGNoKCgpID0-IHt9KTsKICAgIH0KICB9CgogIG5zLnVpID0geyBoLCBhcHBlbmQsIGljb24sIGxvZ28sIExPR08sIG1vdW50U2hhZG93LCB0b2FzdCwgb3Blbk1lbnUsIGNsb3NlTWVudSwgaXNNZW51T3BlbiwgY2hpbWUgfTsKfSkoKTsK\"],[\"src/content/styles.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFN0eWxlcyBmb3IgdGhlIGluamVjdGVkIFVJCi8vCi8vIFBsYWluIHN0cmluZ3MsIGFkb3B0ZWQgaW50byBlYWNoIHNoYWRvdyByb290LiBUaGUgbG9vayBib3Jyb3dzIEdtYWlsJ3MKLy8gb3duIHZvY2FidWxhcnkgLSBHb29nbGUgU2FucywgaXRzIGJsdWUsIGl0cyBlbGV2YXRpb24gc2hhZG93cywgcGlsbAovLyBidXR0b25zIC0gc28gdGhlIGJvYXJkIHJlYWRzIGFzIHBhcnQgb2YgR21haWwgcmF0aGVyIHRoYW4gc29tZXRoaW5nCi8vIGJvbH",
"RlZCBvbi4gRGFyayBtb2RlIGZvbGxvd3MgdGhlIG9wZXJhdGluZyBzeXN0ZW0sIGFzIGFza2VkOyBHbWFpbCdzCi8vIG93biB0aGVtZSBzZXR0aW5nIGlzIG5vdCB2aXNpYmxlIHRvIGEgY29udGVudCBzY3JpcHQgd2l0aG91dCBzY3JhcGluZy4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CgogIC8vIOKUgOKUgCBTaGFyZWQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IEJBU0UgPSBgCjpob3N0IHsKICBhbGw6IGluaXRpYWwgIWltcG9ydGFudDsKICAvKiBBIHBvc2l0aW9uZWQgaG9zdCB3aXRoIGEgei1pbmRleCBpcyBpdHMgb3duIHN0YWNraW5nIGNvbn",
"RleHQsIHNvCiAgICAgbWVudXMgYW5kIHRvYXN0cyBpbnNpZGUgaXQgY2FuIGxheWVyIG92ZXIgdGhlIGJvYXJkIHdpdGggc21hbGwKICAgICBudW1iZXJzIGluc3RlYWQgb2YgY29tcGV0aW5nIHdpdGggR21haWwncy4gKi8KICBwb3NpdGlvbjogcmVsYXRpdmUgIWltcG9ydGFudDsKICB6LWluZGV4OiAyMTQ3NDgzMDAwICFpbXBvcnRhbnQ7CgogIC0tYmc6ICNmNmY4ZmM7CiAgLS1iYXI6ICNmNmY4ZmM7CiAgLS1jb2w6ICNlOWVlZjY7CiAgLS1zdXJmYWNlOiAjZmZmZmZmOwogIC0tbWVudTogI2ZmZmZmZjsKICAtLWZnOiAjMWYxZjFmOwogIC0tZmctMjogIzQ0NDc0NjsKICAtLWZnLTM6ICM1ZTYwNjI7CiAgLS1hY2NlbnQ6ICMwYjU3ZDA7CiAgLS1vbi1hY2NlbnQ6ICNmZmZmZmY7CiAgLS1hY2NlbnQtc29mdDogI2QzZTNmZDsKICAtLW9uLWFjY2VudC1zb2Z0OiAjMDQxZTQ5OwogIC0tYm9yZGVyOiAjZTFlM2UxOwogIC0tYm9yZGVyLXN0cm9uZzogI2M0YzdjNTsKICAtLWhvdmVyOiByZ2JhKDY4LCA3MSwgNzAsIC4wOCk7CiAgLS1wcmVzczogcmdiYSg2OCwgNzEsIDcwLCAuMTQpOwogIC0tZm9jdXM6ICMwYjU3ZDA7CiAgLS1kYW5nZXI6ICNiMzI2MWU7CiAgLS1vbi1kYW5nZXI6ICNmZmZmZmY7CiAgLS1zdGFyOiAjZThhNDAwOwogIC0taW52ZXJzZTogIzMwMzAzMDsKICAtLW9uLWludmVyc2U6ICNmMmYyZjI7CiAgLS1pbnZlcnNlLWFjY2VudDogI2E4YzdmYTsKICAtLXNjcmltOiByZ2JhKDMyLCAzMywgMzYsIC",
"40KTsKICAtLXNoYWRvdy0xOiAwIDFweCAycHggcmdiYSg2MCwgNjQsIDY3LCAuMiksIDAgMXB4IDNweCAxcHggcmdiYSg2MCwgNjQsIDY3LCAuMSk7CiAgLS1zaGFkb3ctMjogMCAxcHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjMpLCAwIDJweCA2cHggMnB4IHJnYmEoNjAsIDY0LCA2NywgLjE1KTsKICAtLXNoYWRvdy0zOiAwIDRweCA4cHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjE1KSwgMCAxcHggM3B4IHJnYmEoNjAsIDY0LCA2NywgLjMpOwogIC0tZm9udDogIkdvb2dsZSBTYW5zIiwgUm9ib3RvLCBBcmlhbCwgc2Fucy1zZXJpZjsKICAvKiBDYXJkIGNvbG91cnM6IEdvb2dsZSdzIG93biBwYWxldHRlLCBhIHN0ZXAgbGlnaHRlciBpbiBkYXJrIG1vZGUgc28KICAgICB0aGUgc3RyaXBlIHN0aWxsIHJlYWRzIGFnYWluc3QgYSBkYXJrIGNhcmQuICovCiAgLS1jLXJlZDogI2Q5MzAyNTsKICAtLWMtb3JhbmdlOiAjZTg3MTBhOwogIC0tYy15ZWxsb3c6ICNmOWFiMDA7CiAgLS1jLWdyZWVuOiAjMWU4ZTNlOwogIC0tYy1ibHVlOiAjMWE3M2U4OwogIC0tYy1wdXJwbGU6ICM5MzM0ZTY7CiAgLS1jLWdyZXk6ICM4MDg2OGI7CiAgLS1tYXJrOiAjZmRlMjkzOwogIC0tbWFyay1jdXJyZW50OiAjZjlhYjAwOwogIC0tb24tbWFyay1jdXJyZW50OiAjMWYxZjFmOwogIC8qIFRoZSBzY3JhdGNocGFkOiBwYXBlciBvZiBpdHMgb3duIGNvbG91ci4gKi8KICAtLXNjcmF0Y2g6ICNmZmY4ZGM7CiAgLS1zY3JhdGNoLWVkZ2U6ICNmMG",
"UxYTA7CiAgLS1zY3JhdGNoLWluazogIzlhNmIwMDsKfQoKQG1lZGlhIChwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaykgewogIDpob3N0IHsKICAgIC0tYmc6ICMxMzEzMTQ7CiAgICAtLWJhcjogIzEzMTMxNDsKICAgIC0tY29sOiAjMWUxZjIwOwogICAgLS1zdXJmYWNlOiAjMmEyYjJkOwogICAgLS1tZW51OiAjMmQyZTMwOwogICAgLS1mZzogI2UzZTNlMzsKICAgIC0tZmctMjogI2M0YzdjNTsKICAgIC0tZmctMzogI2EyYTVhMzsKICAgIC0tYWNjZW50OiAjYThjN2ZhOwogICAgLS1vbi1hY2NlbnQ6ICMwNjJlNmY7CiAgICAtLWFjY2VudC1zb2Z0OiAjMDA0YTc3OwogICAgLS1vbi1hY2NlbnQtc29mdDogI2MyZTdmZjsKICAgIC0tYm9yZGVyOiAjM2EzYjNkOwogICAgLS1ib3JkZXItc3Ryb25nOiAjNWM1ZTYwOwogICAgLS1ob3ZlcjogcmdiYSgyMjcsIDIyNywgMjI3LCAuMDgpOwogICAgLS1wcmVzczogcmdiYSgyMjcsIDIyNywgMjI3LCAuMTQpOwogICAgLS1mb2N1czogI2E4YzdmYTsKICAgIC0tZGFuZ2VyOiAjZjJiOGI1OwogICAgLS1vbi1kYW5nZXI6ICM2MDE0MTA7CiAgICAtLXN0YXI6ICNmZGQ2NjM7CiAgICAtLWludmVyc2U6ICNlM2UzZTM7CiAgICAtLW9uLWludmVyc2U6ICMxZjFmMWY7CiAgICAtLWludmVyc2UtYWNjZW50OiAjMGI1N2QwOwogICAgLS1zY3JpbTogcmdiYSgwLCAwLCAwLCAuNTUpOwogICAgLS1zaGFkb3ctMTogMCAxcHggMnB4IHJnYmEoMCwgMCwgMCwgLjUpLCAwIDFweCAzcHggMX",
"B4IHJnYmEoMCwgMCwgMCwgLjI1KTsKICAgIC0tc2hhZG93LTI6IDAgMXB4IDNweCByZ2JhKDAsIDAsIDAsIC42KSwgMCAycHggOHB4IDJweCByZ2JhKDAsIDAsIDAsIC4zKTsKICAgIC0tc2hhZG93LTM6IDAgNHB4IDEwcHggM3B4IHJnYmEoMCwgMCwgMCwgLjQ1KSwgMCAxcHggM3B4IHJnYmEoMCwgMCwgMCwgLjYpOwogICAgLS1jLXJlZDogI2YyOGI4MjsKICAgIC0tYy1vcmFuZ2U6ICNmY2FkNzA7CiAgICAtLWMteWVsbG93OiAjZmRkNjYzOwogICAgLS1jLWdyZWVuOiAjODFjOTk1OwogICAgLS1jLWJsdWU6ICM4YWI0Zjg7CiAgICAtLWMtcHVycGxlOiAjYzU4YWY5OwogICAgLS1jLWdyZXk6ICM5YWEwYTY7CiAgICAtLW1hcms6ICM2YjU4MDA7CiAgICAtLW1hcmstY3VycmVudDogI2ZkZDY2MzsKICAgIC0tb24tbWFyay1jdXJyZW50OiAjMWYxZjFmOwogICAgLS1zY3JhdGNoOiAjMmEyNjE3OwogICAgLS1zY3JhdGNoLWVkZ2U6ICM0YTQxMjI7CiAgICAtLXNjcmF0Y2gtaW5rOiAjZmRkNjYzOwogIH0KfQoKKiwgKjo6YmVmb3JlLCAqOjphZnRlciB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IH0KCi8qIEF1dGhvciBkaXNwbGF5IHJ1bGVzICgucGlsbCwgLm92ZXJsYXnigKYpIHdvdWxkIG90aGVyd2lzZSBiZWF0IHRoZQogICBicm93c2VyJ3Mgb3duIFtoaWRkZW5dIHsgZGlzcGxheTogbm9uZSB9LiAqLwpbaGlkZGVuXSB7IGRpc3BsYXk6IG5vbmUgIWltcG9ydGFudDsgfQoKYnV0dG9uIHsKICBmb250OiBpbmhlcm",
"l0OwogIGNvbG9yOiBpbmhlcml0OwogIGJhY2tncm91bmQ6IG5vbmU7CiAgYm9yZGVyOiAwOwogIG1hcmdpbjogMDsKICBwYWRkaW5nOiAwOwogIGN1cnNvcjogcG9pbnRlcjsKICAtd2Via2l0LXRhcC1oaWdobGlnaHQtY29sb3I6IHRyYW5zcGFyZW50Owp9CmJ1dHRvbjpkaXNhYmxlZCB7IGN1cnNvcjogZGVmYXVsdDsgfQoKOmZvY3VzIHsgb3V0bGluZTogbm9uZTsgfQo6Zm9jdXMtdmlzaWJsZSB7IG91dGxpbmU6IDJweCBzb2xpZCB2YXIoLS1mb2N1cyk7IG91dGxpbmUtb2Zmc2V0OiAycHg7IH0KCi5pY29uIHsgZGlzcGxheTogYmxvY2s7IGZsZXg6IG5vbmU7IH0KCi5pY29uLWJ0biB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICB3aWR0aDogMzZweDsKICBoZWlnaHQ6IDM2cHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmbGV4OiBub25lOwp9Ci5pY29uLWJ0bjpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQouaWNvbi1idG46YWN0aXZlIHsgYmFja2dyb3VuZDogdmFyKC0tcHJlc3MpOyB9Ci5pY29uLWJ0bjpkaXNhYmxlZCB7IG9wYWNpdHk6IC40OyBiYWNrZ3JvdW5kOiBub25lOyB9CgouYnRuIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIG",
"dhcDogNnB4OwogIGhlaWdodDogMzZweDsKICBwYWRkaW5nOiAwIDE4cHg7CiAgYm9yZGVyLXJhZGl1czogMThweDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjAxZW07CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouYnRuLXByaW1hcnkgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50KTsgfQouYnRuLXByaW1hcnk6aG92ZXIgeyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLmJ0bi10b25hbCB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsgfQouYnRuLXRleHQgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgcGFkZGluZzogMCAxMnB4OyB9Ci5idG4tdGV4dDpob3ZlciwgLmJ0bi10b25hbDpob3ZlciB7IGJhY2tncm91bmQtaW1hZ2U6IGxpbmVhci1ncmFkaWVudCh2YXIoLS1ob3ZlciksIHZhcigtLWhvdmVyKSk7IH0KLmJ0bi10ZXh0LmRhbmdlciB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci5idG4tZGFuZ2VyIHsgYmFja2dyb3VuZDogdmFyKC0tZGFuZ2VyKTsgY29sb3I6IHZhcigtLW9uLWRhbmdlcik7IH0KLmJ0bi1kYW5nZXI6aG92ZXIgeyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLmJ0bjpkaXNhYmxlZCwgLmJ0blthcmlhLWRpc2FibGVkPSJ0cnVlIl0geyBvcGFjaXR5OiAuNTsgYm94LXNoYWRvdzogbm9uZTsgfQoKLy",
"og4pSA4pSAIE1lbnVzIOKUgOKUgCAqLwoKLm1lbnUgewogIHBvc2l0aW9uOiBmaXhlZDsKICB6LWluZGV4OiAyMDsKICBtaW4td2lkdGg6IDIwOHB4OwogIG1heC13aWR0aDogMzIwcHg7CiAgbWF4LWhlaWdodDogNzB2aDsKICBvdmVyZmxvdy15OiBhdXRvOwogIHBhZGRpbmc6IDhweCAwOwogIGJhY2tncm91bmQ6IHZhcigtLW1lbnUpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIGxpbmUtaGVpZ2h0OiAyMHB4Owp9Ci5tZW51LWl0ZW0gewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDEycHg7CiAgd2lkdGg6IDEwMCU7CiAgbWluLWhlaWdodDogMzZweDsKICBwYWRkaW5nOiA2cHggMjBweCA2cHggMTJweDsKICB0ZXh0LWFsaWduOiBsZWZ0Owp9Ci5tZW51LWl0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLm1lbnUtaXRlbTpmb2N1cy12aXNpYmxlIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyBvdXRsaW5lLW9mZnNldDogLTJweDsgfQoubWVudS1pdGVtOmRpc2FibGVkIHsgb3BhY2l0eTogLjQ1OyBiYWNrZ3JvdW5kOiBub25lOyB9Ci5tZW51LWl0ZW0uZGFuZ2VyIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KLm1lbn",
"UtaWNvbiB7IHdpZHRoOiAxOHB4OyBoZWlnaHQ6IDE4cHg7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBjb2xvcjogdmFyKC0tZmctMik7IGZsZXg6IG5vbmU7IH0KLm1lbnUtaXRlbS5kYW5nZXIgLm1lbnUtaWNvbiB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9Ci5tZW51LWl0ZW1bYXJpYS1jaGVja2VkPSJ0cnVlIl0gLm1lbnUtaWNvbiB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5tZW51LWxhYmVsIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQoubWVudS1oZWFkaW5nIHsKICBwYWRkaW5nOiA4cHggMjBweCA0cHggNDJweDsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmctMyk7Cn0KLm1lbnUtc2VwIHsgaGVpZ2h0OiAxcHg7IG1hcmdpbjogOHB4IDA7IGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7IH0KCi8qIOKUgOKUgCBUb2FzdHMg4pSA4pSAICovCgoudG9hc3RzIHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgei1pbmRleDogMzA7CiAgbGVmdDogNTAlOwogIGJvdHRvbTogMjRweDsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoLTUwJSk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgZm9udC1mYW1pbHk6IHZhci",
"gtLWZvbnQpOwp9Ci50b2FzdCB7CiAgcG9pbnRlci1ldmVudHM6IGF1dG87CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNHB4OwogIG1pbi1oZWlnaHQ6IDQ4cHg7CiAgbWF4LXdpZHRoOiBtaW4oNjAwcHgsIGNhbGMoMTAwdncgLSAzMnB4KSk7CiAgcGFkZGluZzogNnB4IDZweCA2cHggMTZweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taW52ZXJzZSk7CiAgY29sb3I6IHZhcigtLW9uLWludmVyc2UpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsKICBmb250LXNpemU6IDE0cHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7CiAgYW5pbWF0aW9uOiB0b2FzdC1pbiAuMThzIGVhc2Utb3V0Owp9Ci50b2FzdC1lcnJvciB7IGJvcmRlci1sZWZ0OiA0cHggc29saWQgI2YyOGI4MjsgcGFkZGluZy1sZWZ0OiAxMnB4OyB9Ci50b2FzdC10ZXh0IHsgZmxleDogMTsgcGFkZGluZy1yaWdodDogOHB4OyB9Ci50b2FzdC1hY3Rpb24gewogIGhlaWdodDogMzZweDsKICBwYWRkaW5nOiAwIDEycHg7CiAgYm9yZGVyLXJhZGl1czogMThweDsKICBjb2xvcjogdmFyKC0taW52ZXJzZS1hY2NlbnQpOwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQoudG9hc3QtYWN0aW9uOmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgxMjgsIDEyOCwgMTI4LCAuMTYpOyB9Ci50b2FzdC1jbG9zZSB7IGNvbG9yOiBpbmhlcml0OyBvcGFjaXR5OiAuOD",
"sgfQoudG9hc3QtY2xvc2U6aG92ZXIgeyBiYWNrZ3JvdW5kOiByZ2JhKDEyOCwgMTI4LCAxMjgsIC4xNik7IGNvbG9yOiBpbmhlcml0OyB9CkBrZXlmcmFtZXMgdG9hc3QtaW4geyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDhweCk7IH0gdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IG5vbmU7IH0gfQoKQG1lZGlhIChwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpIHsKICAqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYW5pbWF0aW9uOiBub25lICFpbXBvcnRhbnQ7IHRyYW5zaXRpb246IG5vbmUgIWltcG9ydGFudDsgfQp9CmA7CgogIC8vIOKUgOKUgCBCb2FyZCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgQk9BUkQgPSBgCi5vdmVybGF5IHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgaW5zZXQ6IDA7CiAgei1pbmRleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwogIGZvbnQtc2l6ZTogMTRweDsKICBsaW5lLWhlaWdodDogMS",
"40OwogIC13ZWJraXQtZm9udC1zbW9vdGhpbmc6IGFudGlhbGlhc2VkOwp9Ci5vdmVybGF5W2hpZGRlbl0geyBkaXNwbGF5OiBub25lOyB9CgouYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA0cHg7CiAgaGVpZ2h0OiA2NHB4OwogIHBhZGRpbmc6IDAgMTJweCAwIDIwcHg7CiAgZmxleDogbm9uZTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iYXIpOwp9Ci5icmFuZCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTBweDsKICBtYXJnaW46IDA7CiAgZm9udC1zaXplOiAyMnB4OwogIGZvbnQtd2VpZ2h0OiA0MDA7CiAgY29sb3I6IHZhcigtLWZnKTsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwp9Ci5icmFuZCAubG9nbyB7IGRpc3BsYXk6IGZsZXg7IH0KLmJyYW5kLWJ0biB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMTBweDsKICBtYXJnaW4tbGVmdDogLTZweDsKICBwYWRkaW5nOiA0cHggMTBweCA0cHggNnB4OwogIGJvcmRlcjogMDsKICBib3JkZXItcmFkaXVzOiAyMHB4OwogIGJhY2tncm91bmQ6IG5vbmU7CiAgY29sb3I6IGluaGVyaXQ7CiAgZm9udDogaW5oZXJpdDsKICBjdXJzb3I6IHBvaW50ZXI7Cn0KLmJyYW5kLWJ0bjpob3ZlciwgLmJyYW5kLWJ0blthcmlhLWV4cGFuZGVkPSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLmJyYW5kIC5kaW0geyBjb2xvcjogdmFyKC",
"0tZmctMyk7IH0KLmFjY291bnQgewogIG1hcmdpbi1sZWZ0OiAxNHB4OwogIHBhZGRpbmc6IDRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDE0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEzcHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwogIG1pbi13aWR0aDogMDsKfQouc3BhY2VyIHsgZmxleDogMTsgfQoudXBkYXRlZCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxMnB4OyB3aGl0ZS1zcGFjZTogbm93cmFwOyBtYXJnaW4tcmlnaHQ6IDJweDsgfQoKLyog4pSA4pSAIFRhYnM6IEJvYXJkIHwgTm90ZXMg4pSA4pSAICovCgoudGFicyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IDJweDsKICBtYXJnaW4tbGVmdDogMThweDsKICBwYWRkaW5nOiAzcHg7CiAgYm9yZGVyLXJhZGl1czogMjBweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7Cn0KLnRhYiB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCAxNHB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKfQoudGFiOmhvdmVyIHsgY29sb3I6IHZhcigtLWZnKTsgfQ",
"oudGFiW2FyaWEtc2VsZWN0ZWQ9InRydWUiXSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBjb2xvcjogdmFyKC0tZmcpOyBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7IH0KLnRhYlthcmlhLXNlbGVjdGVkPSJ0cnVlIl0gLmljb24geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouc3Bpbm5pbmcgLmljb24geyBhbmltYXRpb246IHNwaW4gLjlzIGxpbmVhciBpbmZpbml0ZTsgfQpAa2V5ZnJhbWVzIHNwaW4geyB0byB7IHRyYW5zZm9ybTogcm90YXRlKDM2MGRlZyk7IH0gfQoKLmJvZHkgeyBmbGV4OiAxOyBkaXNwbGF5OiBmbGV4OyBtaW4taGVpZ2h0OiAwOyB9CgouY29sdW1ucyB7CiAgZmxleDogMTsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMTJweDsKICBwYWRkaW5nOiA0cHggMjBweCAyMHB4OwogIG92ZXJmbG93LXg6IGF1dG87CiAgb3ZlcmZsb3cteTogaGlkZGVuOwogIG1pbi1oZWlnaHQ6IDA7Cn0KLmNvbHVtbiB7CiAgZmxleDogMSAwIDI4MHB4OwogIG1pbi13aWR0aDogMjgwcHg7CiAgbWF4LXdpZHRoOiA0MDBweDsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLWhlaWdodDogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgdHJhbnNpdGlvbjogYm94LXNoYWRvdyAuMTJzOwp9Ci5jb2x1bW4uZHJvcC10YXJnZXQgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgfQouY29sLW",
"hlYWQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiAxMHB4IDZweCA2cHggMTZweDsKICBmbGV4OiBub25lOwp9Ci5jb2wtdGl0bGUgewogIG1hcmdpbjogMDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmcpOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouY29sLWNvdW50IHsKICBmbGV4OiBub25lOwogIG1pbi13aWR0aDogMjJweDsKICBwYWRkaW5nOiAwIDdweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgbGluZS1oZWlnaHQ6IDIycHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9Ci5jb2wtZmxhZyB7CiAgZmxleDogbm9uZTsKICBwYWRkaW5nOiAwIDhweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDExcHg7CiAgbGluZS1oZWlnaHQ6IDIwcHg7Cn0KLmNvbC1oZWFkIC5zcGFjZXIgeyBtaW4td2lkdGg6IDRweDsgfQouY29sLW5vdGUgeyBwYWRkaW5nOiAwIDE2cHggNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZmxleD",
"ogbm9uZTsgfQoKLmxpc3QgewogIGZsZXg6IDE7CiAgbWluLWhlaWdodDogNzJweDsKICBvdmVyZmxvdy15OiBhdXRvOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDhweDsKICBwYWRkaW5nOiA0cHggOHB4IDEycHg7CiAgc2Nyb2xsYmFyLXdpZHRoOiB0aGluOwp9Ci5saXN0OmVtcHR5OjphZnRlciB7CiAgY29udGVudDogYXR0cihkYXRhLWVtcHR5KTsKICBkaXNwbGF5OiBibG9jazsKICBtYXJnaW46IDJweCAwOwogIHBhZGRpbmc6IDIycHggMTJweDsKICBib3JkZXI6IDEuNXB4IGRhc2hlZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDEzcHg7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9CgovKiDilIDilIAgQ2FyZHMg4pSA4pSAICovCgouY2FyZCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGZsZXg6IG5vbmU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7CiAgY3Vyc29yOiBncmFiOwogIHRyYW5zaXRpb246IGJveC1zaGFkb3cgLjE1czsKfQouY2FyZDpob3ZlciB7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0yKTsgfQouY2FyZC5kcmFnZ2luZyB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhcmQubGlmdGluZyB7IG9wYWNpdHk6IC41OyB9Ci5jYXJkLW1haW4gewogIGRpc3",
"BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDEwcHggMTRweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgdGV4dC1hbGlnbjogbGVmdDsKICBjdXJzb3I6IGluaGVyaXQ7Cn0KLmNhcmQtbWFpbjpmb2N1cy12aXNpYmxlIHsgb3V0bGluZS1vZmZzZXQ6IC0ycHg7IH0KLmNhcmQtdG9wIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgbWluLWhlaWdodDogMjBweDsKICBmb250LXNpemU6IDEzcHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwp9Ci5kb3QgeyB3aWR0aDogOHB4OyBoZWlnaHQ6IDhweDsgYm9yZGVyLXJhZGl1czogNTAlOyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBmbGV4OiBub25lOyB9Ci5mcm9tIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZGF0ZSB7IGZsZXg6IG5vbmU7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jYXJkOmhvdmVyIC5kYXRlLCAuY2FyZDpmb2N1cy13aXRoaW4gLmRhdGUgeyB2aXNpYmlsaXR5OiBoaWRkZW47IH0KLnN1YmplY3Qtcm93IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg7IG1hcmdpbi10b3A6IDNweDsgfQouc3ViamVjdCB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgb3ZlcmZsb3c6IGhpZGRlbj",
"sKICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIGZvbnQtc2l6ZTogMTRweDsKICBjb2xvcjogdmFyKC0tZmcpOwp9Ci51bnJlYWQgLmZyb20sIC51bnJlYWQgLnN1YmplY3QgeyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5zdGFyIHsgY29sb3I6IHZhcigtLXN0YXIpOyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgZmxleDogbm9uZTsgfQouY291bnQgewogIGZsZXg6IG5vbmU7CiAgcGFkZGluZzogMCA2cHg7CiAgYm9yZGVyLXJhZGl1czogOXB4OwogIGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxMXB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGluZS1oZWlnaHQ6IDE4cHg7Cn0KLmRyYWZ0IHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTJweDsgfQouc25pcHBldCB7CiAgbWFyZ2luLXRvcDogM3B4OwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMThweDsKICBjb2xvcjogdmFyKC0tZmctMyk7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1saW5lLWNsYW1wOiAyOwogIC13ZWJraXQtYm94LW9yaWVudDogdmVydGljYWw7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKfQouY2FyZC1ub3RlIHsKICBtYXJnaW4tdG9wOiA0cHg7CiAgcGFkZGluZy1sZWZ0OiA4cHg7CiAgYm9yZGVyLW",
"xlZnQ6IDJweCBzb2xpZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIHdoaXRlLXNwYWNlOiBwcmUtbGluZTsKICBkaXNwbGF5OiAtd2Via2l0LWJveDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDM7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICBvdmVyZmxvdzogaGlkZGVuOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwp9CgpbZGF0YS1jb2xvdXI9InJlZCJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcmVkKTsgfQpbZGF0YS1jb2xvdXI9Im9yYW5nZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtb3JhbmdlKTsgfQpbZGF0YS1jb2xvdXI9InllbGxvdyJdIHsgLS1zdHJpcGU6IHZhcigtLWMteWVsbG93KTsgfQpbZGF0YS1jb2xvdXI9ImdyZWVuIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ncmVlbik7IH0KW2RhdGEtY29sb3VyPSJibHVlIl0geyAtLXN0cmlwZTogdmFyKC0tYy1ibHVlKTsgfQpbZGF0YS1jb2xvdXI9InB1cnBsZSJdIHsgLS1zdHJpcGU6IHZhcigtLWMtcHVycGxlKTsgfQpbZGF0YS1jb2xvdXI9ImdyZXkiXSB7IC0tc3RyaXBlOiB2YXIoLS1jLWdyZXkpOyB9Ci5jYXJkW2RhdGEtY29sb3VyXTo6YmVmb3JlLAouY2FyZFtkYXRhLXRpbnRlZF06OmJlZm9yZSB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIHRvcDogMDsKICBib3R0b206IDA7CiAgbGVmdDogMDsKICB3aW",
"R0aDogNnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHggMCAwIDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3RyaXBlKTsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKfQouY2FyZFtkYXRhLWNvbG91cl0gLmNhcmQtbWFpbiwgLmNhcmRbZGF0YS10aW50ZWRdIC5jYXJkLW1haW4geyBwYWRkaW5nLWxlZnQ6IDE4cHg7IH0KCi8qIEEgY2FyZCdzIGNvbG91cmVkIEdtYWlsIGxhYmVscywgaW4gdGhlaXIgb3duIGNvbG91cnMuICovCi5jYXJkLXRhZ3MgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LXdyYXA6IHdyYXA7IGdhcDogNHB4OyBtYXJnaW4tdG9wOiA3cHg7IH0KLmxhYmVsLXRhZyB7CiAgbWF4LXdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDFweCA3cHg7CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGJhY2tncm91bmQ6IHZhcigtLXRhZy1iZyk7CiAgY29sb3I6IHZhcigtLXRhZy1mZyk7CiAgZm9udC1zaXplOiAxMS41cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsaW5lLWhlaWdodDogMS41OwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsKfQovKiBXYWl0aW5nIG9uIHRoZW06IHRoZSB1c2VyIHdyb3RlIGxhc3QuIEEgY2xpY2sgbW92ZXMgdGhlIGNhcmQgdG8gV2FpdGluZy4gKi8KLmNhcmQtd2FpdCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNXB4OwogIHdpZHRoOiBmaXQtY29udGVudDsKICBtYXgtd2",
"lkdGg6IGNhbGMoMTAwJSAtIDI0cHgpOwogIG1hcmdpbjogLTRweCAxMnB4IDEwcHg7CiAgcGFkZGluZzogMnB4IDlweCAycHggN3B4OwogIGJvcmRlci1yYWRpdXM6IDExcHg7CiAgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEycHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouY2FyZFtkYXRhLWNvbG91cl0gLmNhcmQtd2FpdCwgLmNhcmRbZGF0YS10aW50ZWRdIC5jYXJkLXdhaXQgeyBtYXJnaW4tbGVmdDogMThweDsgfQouY2FyZC13YWl0IC5pY29uIHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5jYXJkLXdhaXQtbW92ZSB7IGRpc3BsYXk6IG5vbmU7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMnB4OyBtYXJnaW4tbGVmdDogMnB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC13ZWlnaHQ6IDUwMDsgfQpidXR0b24uY2FyZC13YWl0OmhvdmVyLCBidXR0b24uY2FyZC13YWl0OmZvY3VzLXZpc2libGUgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KYnV0dG9uLmNhcmQtd2FpdDpob3ZlciAuY2FyZC13YWl0LW1vdmUsIGJ1dHRvbi5jYXJkLXdhaXQ6Zm9jdXMtdmlzaWJsZSAuY2FyZC13YWl0LW1vdmUgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgY29sb3I6IGluaGVyaXQ7IH0KCi5jYXJkLW1lbnUgewogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICB0b3A6ID",
"RweDsKICByaWdodDogNHB4OwogIHdpZHRoOiAzMnB4OwogIGhlaWdodDogMzJweDsKICBvcGFjaXR5OiAwOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5jYXJkLW1lbnU6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLmNhcmQ6aG92ZXIgLmNhcmQtbWVudSwgLmNhcmQ6Zm9jdXMtd2l0aGluIC5jYXJkLW1lbnUsIC5jYXJkLW1lbnVbYXJpYS1leHBhbmRlZD0idHJ1ZSJdIHsgb3BhY2l0eTogMTsgfQovKiBObyBob3ZlciBvbiBhIHRvdWNoIHNjcmVlbjogdGhlIOKLryBpcyBhbHdheXMgdGhlcmUsIGFuZCB0aGUgdG9wIGxpbmUKICAgbWFrZXMgcm9vbSBmb3IgaXQgcmF0aGVyIHRoYW4gaGlkaW5nIHRoZSBkYXRlIHVuZGVyIGl0LiAqLwpAbWVkaWEgKGhvdmVyOiBub25lKSB7IC5jYXJkLW1lbnUgeyBvcGFjaXR5OiAxOyB9IC5jYXJkIC5kYXRlIHsgdmlzaWJpbGl0eTogdmlzaWJsZTsgfSAuY2FyZC10b3AgeyBwYWRkaW5nLXJpZ2h0OiAzMHB4OyB9IH0KCi5wbGFjZWhvbGRlciB7CiAgZmxleDogbm9uZTsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJvcmRlcjogMnB4IGRhc2hlZCB2YXIoLS1hY2NlbnQpOwogIGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1hY2NlbnQpIDEwJSwgdHJhbnNwYXJlbnQpOwp9Cgouc2tlbGV0b24gewogIGZsZXg6IG5vbmU7CiAgaGVpZ2h0OiA5MnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3",
"VyZmFjZSk7CiAgb3BhY2l0eTogLjU1OwogIGFuaW1hdGlvbjogcHVsc2UgMS40cyBlYXNlLWluLW91dCBpbmZpbml0ZTsKfQpAa2V5ZnJhbWVzIHB1bHNlIHsgNTAlIHsgb3BhY2l0eTogLjM7IH0gfQoKLyog4pSA4pSAIENvbHVtbiBzZWFyY2gg4pSA4pSAICovCgouc2VhcmNoIHsKICBmbGV4OiBub25lOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDZweDsKICBtYXgtaGVpZ2h0OiA1NSU7CiAgbWluLWhlaWdodDogMDsKICBtYXJnaW46IDAgOHB4IDhweDsKICBwYWRkaW5nOiA4cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMik7Cn0KLnNlYXJjaC1ib3ggewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDZweDsKICBoZWlnaHQ6IDQwcHg7CiAgcGFkZGluZzogMCAycHggMCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDIwcHg7CiAgYmFja2dyb3VuZDogdmFyKC0tY29sKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZmxleDogbm9uZTsKfQouc2VhcmNoLWJveDpmb2N1cy13aXRoaW4geyBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tZm9jdXMpOyB9Ci5zZWFyY2gtYm94IGlucHV0IHsKICBmbGV4OiAxOwogIG1pbi13aWR0aDogMDsKICBoZWlnaHQ6IDEwMCU7CiAgYm9yZGVyOiAwOwogIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogIG",
"NvbG9yOiB2YXIoLS1mZyk7CiAgZm9udDogaW5oZXJpdDsKICBmb250LXNpemU6IDE0cHg7Cn0KLnNlYXJjaC1ib3ggaW5wdXQ6OnBsYWNlaG9sZGVyIHsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5zZWFyY2gtYm94IGlucHV0OmZvY3VzLXZpc2libGUgeyBvdXRsaW5lOiBub25lOyB9Ci5zZWFyY2gtaGludCB7IHBhZGRpbmc6IDAgOHB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZmxleDogbm9uZTsgfQoucmVzdWx0cyB7IG92ZXJmbG93LXk6IGF1dG87IG1pbi1oZWlnaHQ6IDA7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMnB4OyBzY3JvbGxiYXItd2lkdGg6IHRoaW47IH0KLnJlc3VsdCB7CiAgZGlzcGxheTogYmxvY2s7CiAgd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogN3B4IDEwcHg7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIHRleHQtYWxpZ246IGxlZnQ7Cn0KLnJlc3VsdDpob3Zlcjpub3QoOmRpc2FibGVkKSB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQoucmVzdWx0OmRpc2FibGVkIHsgb3BhY2l0eTogLjU1OyB9Ci5yLXRvcCB7IGRpc3BsYXk6IGZsZXg7IGdhcDogNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgfQouci10b3AgLmZyb20geyBmb250LXdlaWdodDogNTAwOyB9Ci5yLXN1YmplY3QgewogIGRpc3BsYXk6IGJsb2NrOwogIGZvbnQtc2l6ZTogMTNweDsKICBjb2xvcjogdmFyKC0tZmcpOwogIG92ZXJmbG",
"93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouci13aGVyZSB7IGRpc3BsYXk6IGJsb2NrOyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBtYXJnaW4tdG9wOiAxcHg7IH0KLnJlc3VsdDpkaXNhYmxlZCAuci13aGVyZSB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoucmVzdWx0cy1lbXB0eSB7IHBhZGRpbmc6IDEycHggOHB4OyBmb250LXNpemU6IDEzcHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgdGV4dC1hbGlnbjogY2VudGVyOyB9CgovKiDilIDilIAgU3RhdHVzIHBhbmVscyDilIDilIAgKi8KCi5wYW5lbCB7CiAgbWFyZ2luOiBhdXRvOwogIHdpZHRoOiBtaW4oNDYwcHgsIGNhbGMoMTAwdncgLSA0OHB4KSk7CiAgcGFkZGluZzogMzZweCAzMnB4IDMycHg7CiAgYm9yZGVyLXJhZGl1czogMjhweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMSk7CiAgdGV4dC1hbGlnbjogY2VudGVyOwp9Ci5wYW5lbCAucGFuZWwtaWNvbiB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICB3aWR0aDogNTZweDsKICBoZWlnaHQ6IDU2cHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsKICBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOwp9Ci5wYW",
"5lbCBoMiB7IG1hcmdpbjogMTZweCAwIDhweDsgZm9udC1zaXplOiAyMnB4OyBmb250LXdlaWdodDogNDAwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5wYW5lbCBwIHsgbWFyZ2luOiAwIDAgMjBweDsgY29sb3I6IHZhcigtLWZnLTIpOyBsaW5lLWhlaWdodDogMS41OyB9Ci5wYW5lbCAuYWN0aW9ucyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogOHB4OyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsgfQoKLyogVGhlIGxpY2VuY2U6IHRoZSB0cmlhbCdzIGNoaXAgaW4gdGhlIGJhciwgaXRzIGRpYWxvZywgYW5kIHRoZSBzY3JlZW4KICAgb25jZSBpdCBpcyBvdmVyLiAqLwoubGljZW5jZS1jaGlwIHsKICBmbGV4OiBub25lOwogIGhlaWdodDogMjhweDsKICBwYWRkaW5nOiAwIDEycHg7CiAgYm9yZGVyLXJhZGl1czogMTRweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7CiAgY29sb3I6IHZhcigtLW9uLWFjY2VudC1zb2Z0KTsKICBmb250LXNpemU6IDEzcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICB3aGl0ZS1zcGFjZTogbm93cmFwOwp9Ci5saWNlbmNlLWNoaXA6aG92ZXIgeyBmaWx0ZXI6IGJyaWdodG5lc3MoLjk2KTsgfQoubGljZW5jZS1mb3JtIHsgZGlzcGxheTogZmxleDsgZ2FwOiA4cHg7IHdpZHRoOiAxMDAlOyBtYXgtd2lkdGg6IDQ0MHB4OyBtYXJnaW46IDAgYXV0bzsgfQoubGljZW5jZS1mb3JtIC5saWNlbmNlLWtleSB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgZm9udC1mYW1pbHk6IHVpLW1vbm9zcG",
"FjZSwgQ29uc29sYXMsIG1vbm9zcGFjZTsgfQoubGljZW5jZS1lcnJvciB7IG1hcmdpbjogOHB4IDAgMDsgY29sb3I6IHZhcigtLWRhbmdlcik7IGZvbnQtc2l6ZTogMTNweDsgfQoubGljZW5jZS1lcnJvcjplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KLmxpY2VuY2UtbGlua3MgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDE2cHg7IGp1c3RpZnktY29udGVudDogY2VudGVyOyBtYXJnaW46IDE0cHggMCAwOyBmb250LXNpemU6IDEzLjVweDsgfQoubGljZW5jZS1saW5rcyBhIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLmxpY2VuY2UtY29uZmlybSB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IH0KLmxpY2VuY2UtY29uZmlybVtoaWRkZW5dIHsgZGlzcGxheTogbm9uZTsgfQoubGljZW5jZS1kaWFsb2cgLmxpY2VuY2UtdGl0bGUgeyBtYXJnaW46IDA7IGZvbnQtc2l6ZTogMTZweDsgZm9udC13ZWlnaHQ6IDUwMDsgY29sb3I6IHZhcigtLWZnKTsgfQoubGljZW5jZS1kaWFsb2cgLmxpY2VuY2UtdGV4dCB7IG1hcmdpbjogMCAwIDRweDsgY29sb3I6IHZhcigtLWZnLTIpOyBsaW5lLWhlaWdodDogMS41OyB9Ci5saWNlbmNlLWRpYWxvZyAubGljZW5jZS1mb3JtIHsgbWFyZ2luOiAwOyBtYXgtd2lkdGg6IG5vbmU7IH0KLmxpY2VuY2UtZGlhbG9nIC5saWNlbmNlLWxpbmtzIHsganVzdGlmeS1jb250ZW50OiBmbGV4LXN0YXJ0OyB9Ci5saWNlbmNlLXBhbmVsIH",
"sgbWF4LXdpZHRoOiA1MjBweDsgfQoKLyog4pSA4pSAIE5vdGVzIOKUgOKUgCAqLwoKLm5vdGVzIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAxMnB4OwogIG1pbi13aWR0aDogMDsKICBtaW4taGVpZ2h0OiAwOwogIHBhZGRpbmc6IDRweCAyMHB4IDIwcHg7Cn0KLm5vdGVzLWZvbGRlcnMgewogIGZsZXg6IDAgMCAyMzBweDsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLWhlaWdodDogMDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7Cn0KLmZvbGRlcnMtaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogNHB4OyBwYWRkaW5nOiAxMHB4IDZweCA0cHggMTZweDsgZmxleDogbm9uZTsgfQouZm9sZGVycy1oZWFkIGgyIHsgbWFyZ2luOiAwOyBmbGV4OiAxOyBmb250LXNpemU6IDEzcHg7IGZvbnQtd2VpZ2h0OiA1MDA7IGNvbG9yOiB2YXIoLS1mZy0yKTsgbGV0dGVyLXNwYWNpbmc6IC4wMmVtOyB9Ci5mb2xkZXItaXRlbXMgeyBmbGV4OiAxOyBvdmVyZmxvdy15OiBhdXRvOyBwYWRkaW5nOiAycHggOHB4IDEwcHg7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMXB4OyB9Ci5mb2xkZXItcm93IHsgcG9zaXRpb246IHJlbGF0aXZlOyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBib3JkZXItcmFkaXVzOiAxMHB4OyBwYWRkaW5nLWxlZn",
"Q6IGNhbGModmFyKC0tZGVwdGgsIDApICogMTZweCk7IH0KLmZvbGRlci1yb3cuZHJvcCB7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDJweCB2YXIoLS1hY2NlbnQpOyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYWNjZW50KSAxMCUsIHRyYW5zcGFyZW50KTsgfQouZm9sZGVyLWJ0biB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogOHB4OwogIGhlaWdodDogMzZweDsKICBwYWRkaW5nOiAwIDEwcHg7CiAgYm9yZGVyLXJhZGl1czogMTBweDsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxNHB4OwogIHRleHQtYWxpZ246IGxlZnQ7Cn0KLmZvbGRlci1idG46aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLmZvbGRlci1idG5bYXJpYS1jdXJyZW50PSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLmZvbGRlci1idG4gLmljb24geyBjb2xvcjogaW5oZXJpdDsgb3BhY2l0eTogLjg1OyB9Ci5mb2xkZXItdGl0bGUgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyB9Ci5mb2xkZXItY291bnQgeyBmb250LXNpemU6IDEycHg7IG",
"NvbG9yOiBpbmhlcml0OyBvcGFjaXR5OiAuNzU7IGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7IH0KLmZvbGRlci1tZW51IHsgcG9zaXRpb246IGFic29sdXRlOyByaWdodDogMnB4OyB3aWR0aDogMzBweDsgaGVpZ2h0OiAzMHB4OyBvcGFjaXR5OiAwOyBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOyB9Ci5mb2xkZXItcm93OmhvdmVyIC5mb2xkZXItbWVudSwgLmZvbGRlci1yb3c6Zm9jdXMtd2l0aGluIC5mb2xkZXItbWVudSwgLmZvbGRlci1tZW51W2FyaWEtZXhwYW5kZWQ9InRydWUiXSB7IG9wYWNpdHk6IDE7IH0KLmZvbGRlci1yb3c6aG92ZXIgLmZvbGRlci1jb3VudCwgLmZvbGRlci1yb3c6Zm9jdXMtd2l0aGluIC5mb2xkZXItY291bnQgeyB2aXNpYmlsaXR5OiBoaWRkZW47IH0KLmZvbGRlci1yb3c6aGFzKC5mb2xkZXItYnRuW2FyaWEtY3VycmVudD0idHJ1ZSJdKSAuZm9sZGVyLW1lbnUgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLmZvbGRlci1yb3cuZWRpdGluZyB7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGFsaWduLWl0ZW1zOiBzdHJldGNoOyBwYWRkaW5nLXRvcDogMnB4OyBwYWRkaW5nLWJvdHRvbTogMnB4OyB9Ci5mb2xkZXItZWRpdCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nLWxlZnQ6IDEwcHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgfQouZm9sZGVyLWlucH",
"V0IHsgaGVpZ2h0OiAzNHB4OyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IH0KLmZvbGRlci1lcnJvciB7IHBhZGRpbmc6IDRweCA0cHggMnB4IDM2cHg7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KLyogVGhlIGFycm93IHRoYXQgZm9sZHMgYSBmb2xkZXIncyBzdWJmb2xkZXJzIGF3YXk6IGEgY29sdW1uIG9mIGl0cyBvd24sCiAgIG9uY2Ugc29tZSBmb2xkZXIgaGFzIHN1YmZvbGRlcnMsIHNvIGV2ZXJ5IGZvbGRlcidzIGljb24gbGluZXMgdXAuICovCi5mb2xkZXItdHdpc3R5IHsKICBmbGV4OiBub25lOwogIGRpc3BsYXk6IG5vbmU7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICB3aWR0aDogMjBweDsKICBoZWlnaHQ6IDM2cHg7CiAgbWFyZ2luLXJpZ2h0OiAycHg7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKfQouZm9sZGVyLWl0ZW1zW2RhdGEtbmVzdGVkXSAuZm9sZGVyLXR3aXN0eSB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyB9CmJ1dHRvbi5mb2xkZXItdHdpc3R5OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5mb2xkZXItdHdpc3R5IC5pY29uIHsgdHJhbnNpdGlvbjogdHJhbnNmb3JtIC4xNXMgZWFzZTsgfQouZm9sZGVyLXR3aXN0eVthcmlhLWV4cGFuZGVkPSJmYWxzZSJdIC5pY29uIHsgdHJhbnNmb3JtOiByb3RhdGUoLTkwZGVnKTsgfQouZm9sZG",
"VyLWl0ZW1zW2RhdGEtbmVzdGVkXSAuZm9sZGVyLWVkaXQgeyBwYWRkaW5nLWxlZnQ6IDMycHg7IH0KLmZvbGRlci1pdGVtc1tkYXRhLW5lc3RlZF0gLmZvbGRlci1lcnJvciB7IHBhZGRpbmctbGVmdDogNThweDsgfQovKiBGb2xkZWQsIHdpdGggdGhlIGZvbGRlciBiZWluZyBsb29rZWQgYXQgaW5zaWRlIGl0LiAqLwouZm9sZGVyLWJ0bi5ob2xkcy1jdXJyZW50IHsgY29sb3I6IHZhcigtLWZnKTsgZm9udC13ZWlnaHQ6IDUwMDsgfQoubm90ZXMtc2NvcGUgeyBmbGV4OiBub25lOyBwYWRkaW5nOiAwIDIwcHggNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IH0KLm5vdGVzLWxpc3QgewogIGZsZXg6IDAgMCAzMjBweDsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgbWluLWhlaWdodDogMDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7Cn0KLm5vdGVzLXRvb2xzIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IHBhZGRpbmc6IDEycHggMTJweCA4cHg7IGZsZXg6IG5vbmU7IH0KLm5vdGVzLXRvb2xzIC5zZWFyY2gtYm94IHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsgfQoubm90ZXMtdG9vbHMgLmJ0biB7IGhlaWdodDogND",
"BweDsgcGFkZGluZzogMCAxNnB4IDAgMTJweDsgZmxleDogbm9uZTsgfQoubm90ZXMtaXRlbXMgeyBmbGV4OiAxOyBvdmVyZmxvdy15OiBhdXRvOyBwYWRkaW5nOiAwIDhweCA4cHg7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMnB4OyB9Ci5ub3RlLWl0ZW0gewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIHBhZGRpbmc6IDEwcHggMTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIHRleHQtYWxpZ246IGxlZnQ7Cn0KLm5vdGUtaXRlbTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQoubm90ZS1pdGVtW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0xKTsgfQoubmktdG9wIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGJhc2VsaW5lOyBnYXA6IDhweDsgfQoubmktdGl0bGUgewogIGZsZXg6IDE7CiAgbWluLXdpZHRoOiAwOwogIG92ZXJmbG93OiBoaWRkZW47CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBjb2xvcjogdmFyKC0tZmcpOwp9Ci5uaS1zbmlwcGV0IHsKICBkaXNwbGF5OiAtd2Via2l0LWJveDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDI7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICBvdmVyZmxvdzogaGlkZG",
"VuOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwogIG1hcmdpbi10b3A6IDJweDsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDE4cHg7CiAgY29sb3I6IHZhcigtLWZnLTMpOwp9Ci5uaS1tZXRhIHsgZGlzcGxheTogZmxleDsgZmxleC13cmFwOiB3cmFwOyBnYXA6IDRweCAxMHB4OyBtYXJnaW4tdG9wOiAzcHg7IH0KLm5pLW1ldGE6ZW1wdHkgeyBkaXNwbGF5OiBub25lOyB9Ci5uaS1mb2xkZXIgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAzcHg7IGZvbnQtc2l6ZTogMTFweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci5uaS1tYWlsIHsgZm9udC1zaXplOiAxMXB4OyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouZHJhZ2dpbmctbm90ZSAubm90ZS1pdGVtW2FyaWEtY3VycmVudD0idHJ1ZSJdIHsgYm94LXNoYWRvdzogbm9uZTsgfQoubmUtZm9sZGVyIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNHB4OwogIGhlaWdodDogMzJweDsKICBtYXgtd2lkdGg6IDI2MHB4OwogIG1hcmdpbi1yaWdodDogNHB4OwogIHBhZGRpbmc6IDAgNHB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEzcHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQoubmUtZm9sZGVyIHNwYW4geyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcH",
"NpczsgfQoubmUtZm9sZGVyOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci8qIFNlYXJjaDogdGhlIHdvcmRzIG1hcmtlZCBpbiByZXN1bHRzLCBhbmQgaW4gdGhlIG9wZW4gbm90ZS4gKi8KbWFyayB7IGJhY2tncm91bmQ6IHZhcigtLW1hcmspOyBjb2xvcjogaW5oZXJpdDsgYm9yZGVyLXJhZGl1czogMnB4OyBwYWRkaW5nOiAwIDFweDsgfQovKiBPbmx5IHRoZSBwaG9uZSBhcHAsIHdoaWNoIHNob3dzIG9uZSBwYW5lIGF0IGEgdGltZSwgbmVlZHMgYSB3YXkgYmFjaywKICAgYW5kIGEgYnV0dG9uIHRvIGZvbGQgdGhlIGZvbGRlciB0cmVlIGF3YXkuICovCi5uZS1iYWNrLCAuZm9sZGVycy10b2dnbGUgeyBkaXNwbGF5OiBub25lOyB9Ci5uaS1leGNlcnB0cyB7IGRpc3BsYXk6IGJsb2NrOyBtYXJnaW4tdG9wOiAzcHg7IH0KLm5pLWV4Y2VycHQgewogIGRpc3BsYXk6IGJsb2NrOwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMThweDsKICBjb2xvcjogdmFyKC0tZmctMyk7CiAgb3ZlcmZsb3ctd3JhcDogYW55d2hlcmU7Cn0KLm5pLWV4Y2VycHQgKyAubmktZXhjZXJwdCB7IG1hcmdpbi10b3A6IDNweDsgfQoubmktZXhjZXJwdCBtYXJrLCAubmktc25pcHBldCBtYXJrLCAubmktdGl0bGUgbWFyayB7IGNvbG9yOiB2YXIoLS1mZyk7IH0KLm5pLWhpdHMgeyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBmb250LXdlaWdodDogNTAwOy",
"B9Cjo6aGlnaGxpZ2h0KGdrYi1tYXRjaCkgeyBiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1tYXJrKTsgfQo6OmhpZ2hsaWdodChna2ItbWF0Y2gtY3VycmVudCkgeyBiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1tYXJrLWN1cnJlbnQpOyBjb2xvcjogdmFyKC0tb24tbWFyay1jdXJyZW50KTsgfQoubmUtZmluZCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNnB4OwogIG1hcmdpbjogNHB4IDIwcHggMDsKICBwYWRkaW5nOiAycHggNHB4IDJweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tY29sKTsKICBjb2xvcjogdmFyKC0tZmctMik7CiAgZm9udC1zaXplOiAxM3B4OwogIGZsZXg6IG5vbmU7Cn0KLm5lLWZpbmQgLmZpbmQtd29yZHMgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IG92ZXJmbG93OiBoaWRkZW47IHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOyB3aGl0ZS1zcGFjZTogbm93cmFwOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5uZS1maW5kIC5maW5kLXBvcyB7IHdoaXRlLXNwYWNlOiBub3dyYXA7IGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7IH0KLm5lLWZpbmQgLmljb24tYnRuIHsgd2lkdGg6IDMycHg7IGhlaWdodDogMzJweDsgfQoubm90ZXMtZW1wdHkgeyBwYWRkaW5nOiAyNHB4IDEycHg7IHRleHQtYWxpZ246IGNlbnRlcjsgZm9udC1zaXplOiAxM3B4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLm5vdGVzLWVtcH",
"R5IHAgeyBtYXJnaW46IDAgMCA4cHg7IH0KLm5vdGVzLWZvb3QgeyBmbGV4OiBub25lOyBwYWRkaW5nOiA4cHggMTZweCAxMnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQoubm90ZXMtZm9vdDplbXB0eSB7IGRpc3BsYXk6IG5vbmU7IH0KCi5ub3RlLWVkaXRvciB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOwp9Ci5uZS1iYXIgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDRweDsgcGFkZGluZzogOHB4IDEwcHggMCAyOHB4OyBmbGV4OiBub25lOyBtaW4taGVpZ2h0OiA0OHB4OyB9Ci5uZS1zdGF0dXMgeyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IG1pbi13aWR0aDogMDsgfQoubmUtc3RhdHVzLmVycm9yIHsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KLm5lLWJhbm5lciB7CiAgbWFyZ2luOiA0cHggMjhweCAwOwogIHBhZGRpbmc6IDEwcHggMTRweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1zb2Z0KTsKICBjb2xvcjogdmFyKC0tb24tYWNjZW50LX",
"NvZnQpOwogIGZvbnQtc2l6ZTogMTNweDsKICBsaW5lLWhlaWdodDogMS40NTsKICBmbGV4OiBub25lOwp9Ci5uZS10aXRsZSB7CiAgYm9yZGVyOiAwOwogIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwp9Ci5uZS10aXRsZSB7IGZsZXg6IG5vbmU7IHBhZGRpbmc6IDhweCAyOHB4IDZweDsgZm9udC1zaXplOiAyNHB4OyBsaW5lLWhlaWdodDogMS4zOyB9Ci5uZS1ib2R5IHsKICBwb3NpdGlvbjogcmVsYXRpdmU7CiAgZmxleDogMTsKICBtaW4taGVpZ2h0OiAwOwogIG92ZXJmbG93LXk6IGF1dG87CiAgcGFkZGluZzogMTBweCAyOHB4IDI4cHg7CiAgZm9udC1zaXplOiAxNXB4OwogIGxpbmUtaGVpZ2h0OiAxLjY7CiAgd2hpdGUtc3BhY2U6IHByZS13cmFwOwogIG92ZXJmbG93LXdyYXA6IGFueXdoZXJlOwogIG91dGxpbmU6IG5vbmU7CiAgY291bnRlci1yZXNldDogb2wwIG9sMSBvbDIgb2wzOwp9Ci5uZS10aXRsZTo6cGxhY2Vob2xkZXIgeyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLyogVGhlIHNjcmF0Y2hwYWQ6IGl0cyBvd24gY29sb3VyLCBhIGZpeGVkIG5hbWUsIGFuZCBwaW5uZWQgaW4gdGhlIGxpc3QuICovCi5ub3RlLWVkaXRvci5zY3JhdGNoIHsgYmFja2dyb3VuZDogdmFyKC0tc2NyYXRjaCk7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDFweCB2YXIoLS1zY3JhdGNoLWVkZ2UpLCB2YXIoLS1zaGFkb3ctMSk7IH0KLm5vdGUtZW",
"RpdG9yLnNjcmF0Y2ggLm5lLXRvb2xiYXIgeyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc2NyYXRjaC1lZGdlKSA0NSUsIHRyYW5zcGFyZW50KTsgfQoubm90ZS1lZGl0b3Iuc2NyYXRjaCAubmUtYmFyOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQouc2NyYXRjaC10aXRsZSB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgbWFyZ2luOiAwOyBwYWRkaW5nLXRvcDogMThweDsgZm9udC13ZWlnaHQ6IDQwMDsgfQouc2NyYXRjaC10aXRsZSAuc3QtbmFtZSB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgfQouc2NyYXRjaC10aXRsZSAubmUtc3RhdHVzIHsgZm9udC1zaXplOiAxMnB4OyB9Ci5zY3JhdGNoLXRpdGxlIC5pY29uIHsgY29sb3I6IHZhcigtLXNjcmF0Y2gtaW5rKTsgfQouc2NyYXRjaC1pdGVtIHsgbWFyZ2luLWJvdHRvbTogNHB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1zY3JhdGNoKTsgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMXB4IHZhcigtLXNjcmF0Y2gtZWRnZSk7IH0KLnNjcmF0Y2gtaXRlbTpob3ZlciB7IGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1zY3JhdGNoKSA4NSUsIHZhcigtLXNjcmF0Y2gtZWRnZSkpOyB9Ci5zY3JhdGNoLWl0ZW1bYXJpYS1jdXJyZW50PSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1zY3JhdGNoKTsgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMnB4IHZhcigtLXNjcmF0Y2gtZWRnZSksIHZhcigtLX",
"NoYWRvdy0xKTsgfQouc2NyYXRjaC1pdGVtIC5uaS10aXRsZSB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogNnB4OyBmb250LXdlaWdodDogNTAwOyB9Ci5zY3JhdGNoLWl0ZW0gLm5pLXRpdGxlIC5pY29uIHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLXNjcmF0Y2gtaW5rKTsgfQoubmUtdGl0bGU6Zm9jdXMtdmlzaWJsZSB7IG91dGxpbmU6IG5vbmU7IH0KLm5lLXRpdGxlOmRpc2FibGVkLCAubmUtYm9keVthcmlhLWRpc2FibGVkPSJ0cnVlIl0geyBvcGFjaXR5OiAuNjsgfQoubmUtYm9keVtkYXRhLWVtcHR5PSIxIl06OmJlZm9yZSB7CiAgY29udGVudDogYXR0cihkYXRhLXBsYWNlaG9sZGVyKTsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgdG9wOiAxMHB4OwogIGxlZnQ6IDI4cHg7CiAgY29sb3I6IHZhcigtLWZnLTMpOwogIHBvaW50ZXItZXZlbnRzOiBub25lOwp9CgovKiBCbG9ja3M6IG9uZSBwZXIgcGFyYWdyYXBoLCBoZWFkaW5nIG9yIGxpc3QgaXRlbS4gQnVsbGV0cywgbnVtYmVycyBhbmQKICAgYm94ZXMgYXJlIGRyYXduIGhlcmUsIGluIGVhY2ggYmxvY2sncyBsZWZ0IHBhZGRpbmcuICovCi5ibGsgeyBwb3NpdGlvbjogcmVsYXRpdmU7IG1pbi1oZWlnaHQ6IDEuNmVtOyAtLWx2bDogMDsgfQouYmxrW2RhdGEtbGV2ZWw9IjEiXSB7IC0tbHZsOiAxOyB9Ci5ibGtbZGF0YS1sZXZlbD0iMiJdIHsgLS1sdmw6IDI7IH0KLmJsa1tkYXRhLWxldmVsPSIzIl0geyAtLWx2bDogMzsgfQ",
"ouYmxrW2RhdGEtdHlwZT0iaDEiXSB7IGZvbnQtc2l6ZTogMjRweDsgbGluZS1oZWlnaHQ6IDEuMzsgZm9udC13ZWlnaHQ6IDYwMDsgbWFyZ2luOiAxNHB4IDAgNHB4OyB9Ci5ibGtbZGF0YS10eXBlPSJoMiJdIHsgZm9udC1zaXplOiAyMHB4OyBsaW5lLWhlaWdodDogMS4zNTsgZm9udC13ZWlnaHQ6IDYwMDsgbWFyZ2luOiAxMnB4IDAgMnB4OyB9Ci5ibGtbZGF0YS10eXBlPSJoMyJdIHsgZm9udC1zaXplOiAxN3B4OyBsaW5lLWhlaWdodDogMS40OyBmb250LXdlaWdodDogNjAwOyBtYXJnaW46IDEwcHggMCAycHg7IH0KLmJsazpmaXJzdC1jaGlsZCB7IG1hcmdpbi10b3A6IDA7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl0sIC5ibGtbZGF0YS10eXBlPSJvbCJdLCAuYmxrW2RhdGEtdHlwZT0iY2hlY2siXSB7IHBhZGRpbmctbGVmdDogY2FsYygyOHB4ICsgdmFyKC0tbHZsKSAqIDI0cHgpOyB9Ci5ibGtbZGF0YS10eXBlPSJ1bCJdOjpiZWZvcmUgewogIGNvbnRlbnQ6ICdcXDIwMjInOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICBsZWZ0OiBjYWxjKDlweCArIHZhcigtLWx2bCkgKiAyNHB4KTsKICBjb2xvcjogdmFyKC0tZmctMik7Cn0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMSJdOjpiZWZvcmUgeyBjb250ZW50OiAnXFwyNUU2JzsgfQouYmxrW2RhdGEtdHlwZT0idWwiXVtkYXRhLWxldmVsPSIyIl06OmJlZm9yZSwgLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMyJdOjpiZWZvcmUgeyBjb2",
"50ZW50OiAnXFwyNUFBJzsgfQouYmxrW2RhdGEtdHlwZT0ib2wiXTo6YmVmb3JlIHsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgbGVmdDogY2FsYyh2YXIoLS1sdmwpICogMjRweCk7CiAgd2lkdGg6IDIycHg7CiAgdGV4dC1hbGlnbjogcmlnaHQ7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7Cn0KLyogTnVtYmVyaW5nIHJlc3RhcnRzIHdoZW5ldmVyIHRoZSBydW4gb2YgbnVtYmVyZWQgaXRlbXMgYXQgYSBsZXZlbCBpcwogICBicm9rZW4gYnkgYW55dGhpbmcgc2hhbGxvd2VyIG9yIGJ5IGEgbm9uLWxpc3QgYmxvY2suICovCi5ibGs6bm90KFtkYXRhLXR5cGU9InVsIl0pOm5vdChbZGF0YS10eXBlPSJvbCJdKTpub3QoW2RhdGEtdHlwZT0iY2hlY2siXSkgeyBjb3VudGVyLXJlc2V0OiBvbDAgb2wxIG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMCJdLCAuYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWxldmVsPSIwIl0geyBjb3VudGVyLXJlc2V0OiBvbDAgb2wxIG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMSJdLCAuYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWxldmVsPSIxIl0geyBjb3VudGVyLXJlc2V0OiBvbDEgb2wyIG9sMzsgfQouYmxrW2RhdGEtdHlwZT0idWwiXVtkYXRhLWxldmVsPSIyIl0sIC5ibGtbZGF0YS10eXBlPSJjaGVjayJdW2RhdGEtbGV2ZWw9IjIiXSB7IGNvdW",
"50ZXItcmVzZXQ6IG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9InVsIl1bZGF0YS1sZXZlbD0iMyJdLCAuYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWxldmVsPSIzIl0geyBjb3VudGVyLXJlc2V0OiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMCJdIHsgY291bnRlci1pbmNyZW1lbnQ6IG9sMDsgY291bnRlci1yZXNldDogb2wxIG9sMiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMSJdIHsgY291bnRlci1pbmNyZW1lbnQ6IG9sMTsgY291bnRlci1yZXNldDogb2wyIG9sMzsgfQouYmxrW2RhdGEtdHlwZT0ib2wiXVtkYXRhLWxldmVsPSIyIl0geyBjb3VudGVyLWluY3JlbWVudDogb2wyOyBjb3VudGVyLXJlc2V0OiBvbDM7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMyJdIHsgY291bnRlci1pbmNyZW1lbnQ6IG9sMzsgfQouYmxrW2RhdGEtdHlwZT0ib2wiXVtkYXRhLWxldmVsPSIwIl06OmJlZm9yZSB7IGNvbnRlbnQ6IGNvdW50ZXIob2wwKSAnLic7IH0KLmJsa1tkYXRhLXR5cGU9Im9sIl1bZGF0YS1sZXZlbD0iMSJdOjpiZWZvcmUgeyBjb250ZW50OiBjb3VudGVyKG9sMSwgbG93ZXItYWxwaGEpICcuJzsgfQouYmxrW2RhdGEtdHlwZT0ib2wiXVtkYXRhLWxldmVsPSIyIl06OmJlZm9yZSB7IGNvbnRlbnQ6IGNvdW50ZXIob2wyLCBsb3dlci1yb21hbikgJy4nOyB9Ci5ibGtbZGF0YS10eXBlPSJvbCJdW2RhdGEtbGV2ZWw9IjMiXTo6Ym",
"Vmb3JlIHsgY29udGVudDogY291bnRlcihvbDMpICcuJzsgfQouYmxrW2RhdGEtdHlwZT0iY2hlY2siXTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgbGVmdDogY2FsYygzcHggKyB2YXIoLS1sdmwpICogMjRweCk7CiAgdG9wOiBjYWxjKC44ZW0gLSA5cHgpOwogIHdpZHRoOiAxNHB4OwogIGhlaWdodDogMTRweDsKICBib3JkZXI6IDJweCBzb2xpZCB2YXIoLS1mZy0zKTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY3Vyc29yOiBwb2ludGVyOwp9Ci5ibGtbZGF0YS10eXBlPSJjaGVjayJdW2RhdGEtY2hlY2tlZD0iMSJdOjpiZWZvcmUgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLmJsa1tkYXRhLXR5cGU9ImNoZWNrIl1bZGF0YS1jaGVja2VkPSIxIl06OmFmdGVyIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgbGVmdDogY2FsYyg5cHggKyB2YXIoLS1sdmwpICogMjRweCk7CiAgdG9wOiBjYWxjKC44ZW0gLSA3cHgpOwogIHdpZHRoOiA1cHg7CiAgaGVpZ2h0OiAxMHB4OwogIGJvcmRlcjogc29saWQgdmFyKC0tb24tYWNjZW50KTsKICBib3JkZXItd2lkdGg6IDAgMnB4IDJweCAwOwogIHRyYW5zZm9ybTogcm90YXRlKDQ1ZGVnKTsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKfQouYmxrW2RhdGEtdHlwZT0iY2hlY2siXVtkYXRhLWNoZWNrZWQ9IjEiXSB7IGNvbG9yOiB2YXIoLS1mZy0zKT",
"sgdGV4dC1kZWNvcmF0aW9uOiBsaW5lLXRocm91Z2g7IH0KLm5lLWJvZHkgYSB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB0ZXh0LWRlY29yYXRpb246IHVuZGVybGluZTsgY3Vyc29yOiB0ZXh0OyB9CgovKiBGb3JtYXR0aW5nIHRvb2xiYXIgYW5kIHRoZSBsaW5rIGZpZWxkIGJlbmVhdGggaXQuICovCi5uZS10b29sYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtd3JhcDogd3JhcDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMnB4OwogIG1hcmdpbjogMnB4IDIwcHggMDsKICBwYWRkaW5nOiA0cHggNnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tY29sKTsKICBmbGV4OiBub25lOwp9Ci50Yi1idG4gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgd2lkdGg6IDMycHg7CiAgaGVpZ2h0OiAzMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmctMik7Cn0KLnRiLWJ0bjpob3Zlcjpub3QoOmRpc2FibGVkKSwgLnRiLXN0eWxlOmhvdmVyOm5vdCg6ZGlzYWJsZWQpIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyBjb2xvcjogdmFyKC0tZmcpOyB9Ci50Yi1idG5bYXJpYS1wcmVzc2VkPSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLnRiLWJ0bjpkaXNhYmxlZCwgLnRiLX",
"N0eWxlOmRpc2FibGVkIHsgb3BhY2l0eTogLjQ7IH0KLnRiLXN0eWxlIHsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMnB4OwogIGhlaWdodDogMzJweDsKICBwYWRkaW5nOiAwIDRweCAwIDEwcHg7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udC1zaXplOiAxM3B4OwogIGZvbnQtd2VpZ2h0OiA1MDA7Cn0KLnRiLXN0eWxlLWxhYmVsIHsgbWluLXdpZHRoOiA4NHB4OyB0ZXh0LWFsaWduOiBsZWZ0OyB9Ci50Yi1zZXAgeyB3aWR0aDogMXB4OyBoZWlnaHQ6IDIwcHg7IG1hcmdpbjogMCA2cHg7IGJhY2tncm91bmQ6IHZhcigtLWJvcmRlci1zdHJvbmcpOyBvcGFjaXR5OiAuNjsgfQoubmUtbGlua2JhciB7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LXdyYXA6IHdyYXA7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBtYXJnaW46IDZweCAyMHB4IDA7CiAgcGFkZGluZzogNnB4IDhweCA2cHggMTJweDsKICBib3JkZXItcmFkaXVzOiAxMnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZsZXg6IG5vbmU7Cn0KLm5lLWxpbmtiYXIgLnRleHQtaW5wdXQgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDE4MHB4OyBoZWlnaHQ6IDM0cHg7IH0KLm5lLWxpbmtiYXIgLmJ0biB7IGhlaWdodDogMzRweDsgfQoubGluay1lcnJvciB7IGZsZXgtYmFzaXM6IDEwMCU7IG",
"NvbG9yOiB2YXIoLS1kYW5nZXIpOyBmb250LXNpemU6IDEycHg7IH0KLmxpbmstZXJyb3I6ZW1wdHkgeyBkaXNwbGF5OiBub25lOyB9CgovKiBUYWJsZXM6IGEgYmxvY2sgdGhhdCBzY3JvbGxzIHNpZGV3YXlzIHdoZW4gd2lkZXIgdGhhbiB0aGUgbm90ZSwgaXRzCiAgIGNlbGxzIGVkaXRlZCBvbmUgYXQgYSB0aW1lOyB0aGUgaGVhZGluZyByb3cgc2hhZGVkLiAqLwouYmxrW2RhdGEtdHlwZT0idGFibGUiXSB7IG92ZXJmbG93LXg6IGF1dG87IG1hcmdpbjogOHB4IDA7IHBhZGRpbmc6IDFweCAxcHggNHB4OyB9Ci5ibGtbZGF0YS10eXBlPSJ0YWJsZSJdIHRhYmxlIHsgYm9yZGVyLWNvbGxhcHNlOiBjb2xsYXBzZTsgfQouYmxrW2RhdGEtdHlwZT0idGFibGUiXSB0ZCB7CiAgbWluLXdpZHRoOiA3MnB4OwogIG1heC13aWR0aDogMjhlbTsKICBwYWRkaW5nOiA0cHggMTBweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKICB2ZXJ0aWNhbC1hbGlnbjogdG9wOwogIG92ZXJmbG93LXdyYXA6IG5vcm1hbDsKICB3b3JkLWJyZWFrOiBub3JtYWw7CiAgb3V0bGluZTogbm9uZTsKICBjdXJzb3I6IHRleHQ7Cn0KLmJsa1tkYXRhLXR5cGU9InRhYmxlIl0gdGQ6Zm9jdXMgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgfQouYmxrW2RhdGEtdHlwZT0idGFibGUiXVtkYXRhLWhlYWQ9IjEiXSB0cjpmaXJzdC1jaGlsZCB0ZCB7IGJhY2tncm91bmQ6IHZhcigtLWNvbCk7IG",
"ZvbnQtd2VpZ2h0OiA2MDA7IH0KLm5lLXRhYmxlYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtd3JhcDogd3JhcDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMnB4OwogIG1hcmdpbjogNnB4IDIwcHggMDsKICBwYWRkaW5nOiA0cHggNnB4OwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBmbGV4OiBub25lOwp9Ci5uZS10YWJsZWJhciAudGItbGFiZWwgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgcGFkZGluZzogMCA2cHg7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5uZS10YWJsZWJhciAuc3BhY2VyIHsgZmxleDogMTsgfQoudGItdGV4dCB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCA0cHggMCAxMHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNTAwOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLnRiLXRleHQ6bm90KFthcmlhLWhhc3BvcHVwXSkgeyBwYWRkaW5nLXJpZ2h0OiAxMHB4OyB9Ci50Yi10ZXh0OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci50Yi10ZXh0W2FyaWEtcHJlc3NlZD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZn",
"QpOyB9CgovKiDilIDilIAgQ29sdW1uIHNldHRpbmdzIGRyYXdlciDilIDilIAgKi8KCi5zY3JpbSB7IHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7IHotaW5kZXg6IDU7IGJhY2tncm91bmQ6IHZhcigtLXNjcmltKTsgfQouZHJhd2VyIHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgei1pbmRleDogNjsKICB0b3A6IDA7CiAgcmlnaHQ6IDA7CiAgYm90dG9tOiAwOwogIHdpZHRoOiBtaW4oNDYwcHgsIDEwMHZ3KTsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgY29sb3I6IHZhcigtLWZnKTsKICBib3gtc2hhZG93OiB2YXIoLS1zaGFkb3ctMyk7CiAgZm9udC1mYW1pbHk6IHZhcigtLWZvbnQpOwogIGZvbnQtc2l6ZTogMTRweDsKICBhbmltYXRpb246IGRyYXdlci1pbiAuMThzIGVhc2Utb3V0Owp9CkBrZXlmcmFtZXMgZHJhd2VyLWluIHsgZnJvbSB7IHRyYW5zZm9ybTogdHJhbnNsYXRlWCgyNHB4KTsgb3BhY2l0eTogMDsgfSB0byB7IHRyYW5zZm9ybTogbm9uZTsgb3BhY2l0eTogMTsgfSB9Ci5kcmF3ZXItaGVhZCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyBwYWRkaW5nOiAxMnB4IDEycHggNHB4IDI0cHg7IGZsZXg6IG5vbmU7IH0KLmRyYXdlci1oZWFkIGgyIHsgbWFyZ2luOiAwOyBmbGV4OiAxOyBmb250LXNpemU6IDIwcHg7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLmRyYXdlci1pbnRybyB7IG",
"1hcmdpbjogMDsgcGFkZGluZzogMCAyNHB4IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZm9udC1zaXplOiAxM3B4OyBsaW5lLWhlaWdodDogMS41OyBmbGV4OiBub25lOyB9Ci5kcmF3ZXItYm9keSB7IGZsZXg6IDE7IG92ZXJmbG93LXk6IGF1dG87IHBhZGRpbmc6IDRweCAyNHB4IDE2cHg7IH0KLmNvbC1yb3cgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ2FwOiAxMHB4OwogIG1hcmdpbi1ib3R0b206IDEycHg7CiAgcGFkZGluZzogMTJweCAxMnB4IDEwcHggMTRweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6IDE2cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7Cn0KLnJvdy1oZWFkIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAycHg7IH0KLnJvdy1oZWFkIC5yb3ctbnVtIHsKICB3aWR0aDogMjJweDsKICBoZWlnaHQ6IDIycHg7CiAgbWFyZ2luLXJpZ2h0OiA4cHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLWNvbCk7CiAgY29sb3I6IHZhcigtLWZnLTIpOwogIGZvbnQtc2l6ZTogMTJweDsKICBsaW5lLWhlaWdodDogMjJweDsKICB0ZXh0LWFsaWduOiBjZW50ZXI7CiAgZmxleDogbm9uZTsKfQoucm93LWhlYWQgLnJvdy10aXRsZSB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgZm9udC13ZWlnaHQ6IDUwMDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7IHdoaXRlLX",
"NwYWNlOiBub3dyYXA7IH0KLmZpZWxkIHsgZGlzcGxheTogZ3JpZDsgZ2FwOiA0cHg7IH0KLmZpZWxkLWxhYmVsIHsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMik7IH0KLnRleHQtaW5wdXQgewogIHdpZHRoOiAxMDAlOwogIGhlaWdodDogMzhweDsKICBwYWRkaW5nOiAwIDEycHg7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN0cm9uZyk7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udDogaW5oZXJpdDsKICBmb250LXNpemU6IDE0cHg7Cn0KLnRleHQtaW5wdXQ6Zm9jdXMtdmlzaWJsZSB7IG91dGxpbmU6IDJweCBzb2xpZCB2YXIoLS1mb2N1cyk7IG91dGxpbmUtb2Zmc2V0OiAtMXB4OyBib3JkZXItY29sb3I6IHRyYW5zcGFyZW50OyB9Ci5maWVsZC1oZWxwIHsgZm9udC1zaXplOiAxMnB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLmNoZWNrIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAxMHB4OyBmb250LXNpemU6IDEzcHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgY3Vyc29yOiBwb2ludGVyOyB9Ci5jaGVjayBpbnB1dCB7IHdpZHRoOiAxOHB4OyBoZWlnaHQ6IDE4cHg7IG1hcmdpbjogMDsgYWNjZW50LWNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5hZGQtY29sIHsgd2lkdGg6IDEwMCU7IGhlaWdodDogNDRweDsgYm9yZGVyLXJhZGl1czogMTZweDsgYm9yZGVyOi",
"AxLjVweCBkYXNoZWQgdmFyKC0tYm9yZGVyLXN0cm9uZyk7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBmb250LXdlaWdodDogNTAwOyB9Ci5hZGQtY29sOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9Ci5kcmF3ZXItZm9vdCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogOHB4OwogIHBhZGRpbmc6IDEycHggMjBweCAxNnB4IDI0cHg7CiAgYm9yZGVyLXRvcDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZmxleDogbm9uZTsKfQouZHJhd2VyLWZvb3QgLm5vdGUgeyBmbGV4OiAxOyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgbGluZS1oZWlnaHQ6IDEuNDU7IH0KLmZvcm0tZXJyb3IgeyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgZm9udC1zaXplOiAxM3B4OyBwYWRkaW5nOiAwIDI0cHggOHB4OyBmbGV4OiBub25lOyB9Ci5mb3JtLWVycm9yOmVtcHR5IHsgZGlzcGxheTogbm9uZTsgfQoKLyog4pSA4pSAIENhcmQgZWRpdG9yIOKUgOKUgCAqLwoKLmRpYWxvZyB7CiAgcG9zaXRpb246IGZpeGVkOwogIHotaW5kZXg6IDY7CiAgdG9wOiA1MCU7CiAgbGVmdDogNTAlOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlKC01MCUsIC01MCUpOwogIHdpZHRoOiBtaW4oNDgwcHgsIGNhbGMoMTAwdncgLSAzMnB4KSk7CiAgbWF4LWhlaWdodDogY2FsYygxMDB2aCAtIDMycHgpOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBib3",
"JkZXItcmFkaXVzOiAyNHB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTMpOwogIGZvbnQtZmFtaWx5OiB2YXIoLS1mb250KTsKICBmb250LXNpemU6IDE0cHg7CiAgYW5pbWF0aW9uOiBkaWFsb2ctaW4gLjE2cyBlYXNlLW91dDsKfQpAa2V5ZnJhbWVzIGRpYWxvZy1pbiB7IGZyb20geyBvcGFjaXR5OiAwOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZSgtNTAlLCAtNDclKTsgfSB0byB7IG9wYWNpdHk6IDE7IHRyYW5zZm9ybTogdHJhbnNsYXRlKC01MCUsIC01MCUpOyB9IH0KLmRpYWxvZy1oZWFkIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IHBhZGRpbmc6IDE0cHggMTJweCAycHggMjRweDsgZmxleDogbm9uZTsgfQouZGlhbG9nLWhlYWQgaDIgeyBtYXJnaW46IDA7IGZsZXg6IDE7IGZvbnQtc2l6ZTogMjBweDsgZm9udC13ZWlnaHQ6IDQwMDsgfQouZGlhbG9nLWJvZHkgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDE4cHg7IHBhZGRpbmc6IDEwcHggMjRweCAxOHB4OyBvdmVyZmxvdy15OiBhdXRvOyB9Ci5kaWFsb2ctZm9vdCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogOHB4OwogIHBhZGRpbmc6IDEycHggMjBweCAxNnB4IDI0cHg7CiAgYm9yZGVyLXRvcDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZmxleDogbm9uZTsKfQouZGlhbG9nLWZvb3",
"QgLm5vdGUgeyBmbGV4OiAxOyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgbGluZS1oZWlnaHQ6IDEuNDU7IH0KLnRleHQtYXJlYSB7IGhlaWdodDogYXV0bzsgbWluLWhlaWdodDogODBweDsgcGFkZGluZzogOXB4IDEycHg7IGxpbmUtaGVpZ2h0OiAxLjQ1OyByZXNpemU6IHZlcnRpY2FsOyB9Ci5oZWxwLXJvdyB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBiYXNlbGluZTsgZ2FwOiA0cHggMTBweDsgZmxleC13cmFwOiB3cmFwOyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgfQouaGVscC1yb3cgLnN1YmplY3QtcmVmIHsgY29sb3I6IHZhcigtLWZnLTIpOyBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsgfQoubGluay1idG4geyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC1zaXplOiAxMnB4OyBmb250LXdlaWdodDogNTAwOyBib3JkZXItcmFkaXVzOiA0cHg7IH0KLmxpbmstYnRuOmhvdmVyIHsgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7IH0KLnN3YXRjaGVzIHsgZGlzcGxheTogZmxleDsgZmxleC13cmFwOiB3cmFwOyBnYXA6IDEwcHg7IHBhZGRpbmc6IDJweCAwOyB9Ci5zd2F0Y2ggeyBwb3NpdGlvbjogcmVsYXRpdmU7IHdpZHRoOiAyOHB4OyBoZWlnaHQ6IDI4cHg7IGN1cnNvcjogcG9pbnRlcjsgfQouc3dhdGNoIGlucHV0IHsgcG9zaXRpb246IGFic29sdXRlOyBpbnNldDogMDsgd2lkdGg6IDEwMCU7IGhlaWdodDogMTAwJTsgbWFyZ2luOiAwOyBvcGFjaX",
"R5OiAwOyBjdXJzb3I6IHBvaW50ZXI7IH0KLnN3YXRjaC1kb3QgewogIGRpc3BsYXk6IGJsb2NrOwogIHdpZHRoOiAxMDAlOwogIGhlaWdodDogMTAwJTsKICBib3JkZXItcmFkaXVzOiA1MCU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3RyaXBlKTsKICB0cmFuc2l0aW9uOiBib3gtc2hhZG93IC4xMnM7Cn0KLnN3YXRjaFtkYXRhLWNvbG91cj0ibm9uZSJdIC5zd2F0Y2gtZG90IHsKICBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCB0cmFuc3BhcmVudCA0NSUsIHZhcigtLWJvcmRlci1zdHJvbmcpIDQ1JSwgdmFyKC0tYm9yZGVyLXN0cm9uZykgNTUlLCB0cmFuc3BhcmVudCA1NSUpLCB2YXIoLS1zdXJmYWNlKTsKICBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAxLjVweCB2YXIoLS1ib3JkZXItc3Ryb25nKTsKfQouc3dhdGNoIGlucHV0OmNoZWNrZWQgKyAuc3dhdGNoLWRvdCB7IGJveC1zaGFkb3c6IDAgMCAwIDJweCB2YXIoLS1zdXJmYWNlKSwgMCAwIDAgNHB4IHZhcigtLWZnLTIpOyB9Ci5zd2F0Y2hbZGF0YS1jb2xvdXI9Im5vbmUiXSBpbnB1dDpjaGVja2VkICsgLnN3YXRjaC1kb3QgewogIGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDEuNXB4IHZhcigtLWJvcmRlci1zdHJvbmcpLCAwIDAgMCAycHggdmFyKC0tc3VyZmFjZSksIDAgMCAwIDRweCB2YXIoLS1mZy0yKTsKfQouc3dhdGNoIGlucHV0OmZvY3VzLXZpc2libGUgKyAuc3dhdGNoLWRvdCB7IG91dGxpbmU6IDJweCBzb2xpZCB2YXIoLS1mb2N1cy",
"k7IG91dGxpbmUtb2Zmc2V0OiA1cHg7IH0KCi5zci1vbmx5IHsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgd2lkdGg6IDFweDsKICBoZWlnaHQ6IDFweDsKICBwYWRkaW5nOiAwOwogIG1hcmdpbjogLTFweDsKICBvdmVyZmxvdzogaGlkZGVuOwogIGNsaXA6IHJlY3QoMCAwIDAgMCk7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBib3JkZXI6IDA7Cn0KYDsKCiAgLy8g4pSA4pSAIENhbGVuZGFyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gV2lkZTogdGhlIHdlZWsgYXMgc2V2ZW4gY29sdW1ucywgb3IgYXMgdHdvIHJvd3Mgb2YgZm91ciBhbmQgdGhyZWUKICAvLyAoZGF0YS1sYXlvdXQpLCBvciB0aGUgbW9udGgsIG9yIHRoZSBhZ2VuZGEsIGJlc2lkZSBhIHNpZGViYXIuIE5hcnJvdwogIC8vIChkYXRhLW5hcnJvdywgc2V0IGZyb20gdGhlIHZpZXcncyBvd24gd2lkdGgpOiB0aGUKICAvLyB3ZWVrIGFzIHR3byBjb2x1bW5zIG9mIGRheSB0aWxlcywgcmVhZCBkb3duIHRoZW4gYWNyb3NzLCB3aXRoIHRoZQogIC8vIHNtYWxsIG1vbnRoIGFzIHRoZSBlaWdodGggdGlsZSBhbmQgdGhlIHNpZGViYXIncyBwYXJ0cyBzcHJlYWQgYWJvdmUKICAvLy",
"BhbmQgYmVsb3cuCgogIGNvbnN0IENBTEVOREFSID0gYAouY2FsIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4td2lkdGg6IDA7CiAgbWluLWhlaWdodDogMDsKICBwYWRkaW5nOiAwIDIwcHggMjBweDsKfQouY2FsLWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgaGVpZ2h0OiA1MnB4OyBmbGV4OiBub25lOyB9Ci5jYWwtbmF2IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAycHg7IGZsZXg6IG5vbmU7IH0KLmNhbC1vcmRlciwgLmNhbC1waG9uZS12aWV3IHsgZGlzcGxheTogbm9uZTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1vcmRlciwgLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtcGhvbmUtdmlldyB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXVtkYXRhLXZpZXc9Im1vbnRoIl0gLmNhbC1vcmRlciB7IGRpc3BsYXk6IG5vbmU7IH0KLmNhbC1sYXlvdXQsIC5jYWwtbmlnaHQgeyBkaXNwbGF5OiBub25lOyB9Ci5jYWxbZGF0YS1uYXJyb3c9ImZhbHNlIl1bZGF0YS12aWV3PSJ3ZWVrIl0gLmNhbC1sYXlvdXQgeyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgfQouY2FsW2RhdGEtbmFycm93PSJmYWxzZSJdW2RhdGEtdmlldz0id2VlayJdW2RhdGEtbGF5b3V0PSJjb2x1bW5zIl0gLmNhbC1uaWdodCB7IGRpc3BsYXk6IG",
"lubGluZS1mbGV4OyB9Ci5jYWwtbmlnaHRbYXJpYS1wcmVzc2VkPSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtc29mdCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQtc29mdCk7IH0KLmJ0bi1vdXRsaW5lIHsgaGVpZ2h0OiAzNHB4OyBwYWRkaW5nOiAwIDE2cHg7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOyBjb2xvcjogdmFyKC0tZmcpOyBtYXJnaW4tcmlnaHQ6IDRweDsgfQouYnRuLW91dGxpbmU6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLmNhbC10aXRsZSB7CiAgZmxleDogMTsKICBtaW4td2lkdGg6IDA7CiAgbWFyZ2luOiAwIDAgMCA2cHg7CiAgZm9udC1zaXplOiAyMHB4OwogIGZvbnQtd2VpZ2h0OiA0MDA7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzOwp9Ci5jYWwtdmlld3MgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDJweDsgcGFkZGluZzogM3B4OyBib3JkZXItcmFkaXVzOiAyMHB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IGZsZXg6IG5vbmU7IH0KLnNlZyB7IGhlaWdodDogMzBweDsgcGFkZGluZzogMCAxNHB4OyBib3JkZXItcmFkaXVzOiAxNXB4OyBjb2xvcjogdmFyKC0tZmctMik7IGZvbnQtd2VpZ2h0OiA1MDA7IGZvbnQtc2l6ZTogMTMuNXB4OyB9Ci5zZWc6aG92ZXIgeyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5zZWdbYXJpYS1zZWxlY3RlZD0idHJ1ZSJdIH",
"sgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IGNvbG9yOiB2YXIoLS1mZyk7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0xKTsgfQoKLmNhbC1ub3RlIHsKICBmbGV4OiBub25lOwogIG1hcmdpbjogMCAwIDEwcHg7CiAgcGFkZGluZzogOHB4IDE0cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEzcHg7CiAgbGluZS1oZWlnaHQ6IDEuNDU7Cn0KLmNhbC1ub3RlIHAgeyBtYXJnaW46IDA7IH0KLmNhbC1ub3RlIHAgKyBwIHsgbWFyZ2luLXRvcDogNHB4OyB9Ci5jYWwtbm90ZSBzdHJvbmcgeyBjb2xvcjogdmFyKC0tZmcpOyBmb250LXdlaWdodDogNTAwOyB9Ci5jYWwtbm90ZSBhLCAuY2FsIC5wYW5lbCBhIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IHdvcmQtYnJlYWs6IGJyZWFrLWFsbDsgfQouY2FsLW5vdGUgLmJ0biB7IGhlaWdodDogMjhweDsgbWFyZ2luLWxlZnQ6IDRweDsgfQouY2FsLW5vdGUgYS5idG4geyB0ZXh0LWRlY29yYXRpb246IG5vbmU7IHdvcmQtYnJlYWs6IG5vcm1hbDsgfQoKLmNhbC1ib2R5IHsgZmxleDogMTsgZGlzcGxheTogZmxleDsgZ2FwOiAxMnB4OyBtaW4taGVpZ2h0OiAwOyB9Ci5jYWwtc2lkZSB7IHdpZHRoOiAyMjhweDsgZmxleDogbm9uZTsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbj",
"sgZ2FwOiAxMHB4OyBvdmVyZmxvdy15OiBhdXRvOyB9Ci5jYWwtbWFpbiB7IGZsZXg6IDE7IG1pbi13aWR0aDogMDsgbWluLWhlaWdodDogMDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgfQouY2FsLW1pbmksIC5jYWwtc291cmNlcywgLmNhbC10cmF5IHsKICBmbGV4OiBub25lOwogIHBhZGRpbmc6IDEwcHg7CiAgYm9yZGVyLXJhZGl1czogMTZweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9CgovKiBUaGUgc21hbGwgbW9udGggKi8KLm1pbmktaGVhZCB7IG1hcmdpbjogMCAwIDZweCA0cHg7IGZvbnQtc2l6ZTogMTRweDsgZm9udC13ZWlnaHQ6IDUwMDsgY29sb3I6IHZhcigtLWZnKTsgfQoubWluaS1ncmlkIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoNywgbWlubWF4KDAsIDFmcikpOyByb3ctZ2FwOiAycHg7IHRleHQtYWxpZ246IGNlbnRlcjsgfQoubWluaS1kb3cgeyBwYWRkaW5nOiAycHggMDsgZm9udC1zaXplOiAxMXB4OyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLm1pbmktZGF5IHsgaGVpZ2h0OiAyNnB4OyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZm9udC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtczsgfQoubWluaS1kYXk6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IGJvcmRlci1yYWRpdXM6IDhweDsgfQoubWluaS1kYX",
"kub3RoZXIgeyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLm1pbmktZGF5LnNob3duIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LXNvZnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci5taW5pLWRheS50b2RheSB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQpOyBib3JkZXItcmFkaXVzOiA4cHg7IGZvbnQtd2VpZ2h0OiA2MDA7IH0KCi8qIENhbGVuZGFycyBhbmQgdGFzayBsaXN0cyAqLwouY2FsLXNvdXJjZXMgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDFweDsgcGFkZGluZzogNnB4OyB9Ci5zcmMgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDEwcHg7CiAgaGVpZ2h0OiAzMnB4OwogIHBhZGRpbmc6IDAgOHB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBjb2xvcjogdmFyKC0tZmcpOwogIGZvbnQtc2l6ZTogMTMuNXB4OwogIHRleHQtYWxpZ246IGxlZnQ7Cn0KLnNyYzpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQouc3JjIC5zd2F0Y2ggewogIGZsZXg6IG5vbmU7CiAgd2lkdGg6IDE0cHg7CiAgaGVpZ2h0OiAxNHB4OwogIGJvcmRlcjogMnB4IHNvbGlkIHZhcigtLXNyYywgdmFyKC0tYWNjZW50KSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3JjLCB2YXIoLS1hY2NlbnQpKTsKICBib3JkZXItcmFkaXVzOiA1MCU7Cn0KLnNyYy10YXNrcyAuc3dhdGNoIHsgYm",
"9yZGVyLXJhZGl1czogNHB4OyB9Ci5zcmNbYXJpYS1wcmVzc2VkPSJmYWxzZSJdIC5zd2F0Y2ggeyBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsgfQouc3JjW2FyaWEtcHJlc3NlZD0iZmFsc2UiXSAuc3JjLW5hbWUgeyBjb2xvcjogdmFyKC0tZmctMyk7IH0KLnNyYy1uYW1lIHsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQoKLyogVGFza3Mgd2l0aG91dCBhIGRheSAqLwouY2FsLXRyYXkgaDMgeyBtYXJnaW46IDJweCA0cHggNnB4OyBmb250LXNpemU6IDEyLjVweDsgZm9udC13ZWlnaHQ6IDUwMDsgY29sb3I6IHZhcigtLWZnLTIpOyB9Ci5jYWwtdHJheSBoMyAuY291bnQgeyBjb2xvcjogdmFyKC0tZmctMyk7IGZvbnQtd2VpZ2h0OiA0MDA7IH0KLmNhbC10cmF5IC5jYWwtaXRlbXMgKyBoMyB7IG1hcmdpbi10b3A6IDEycHg7IH0KCi8qIERheXMgKi8KLmNhbC13ZWVrIHsgZmxleDogMTsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoNywgbWlubWF4KDAsIDFmcikpOyBnYXA6IDhweDsgbWluLWhlaWdodDogMDsgfQouY2FsW2RhdGEtbmFycm93PSJmYWxzZSJdW2RhdGEtbGF5b3V0PSJyb3dzIl0gLmNhbC13ZWVrIHsKICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg0LCBtaW5tYXgoMCwgMWZyKSk7CiAgZ3JpZC10ZW1wbGF0ZS1yb3dzOiByZXBlYXQoMiwgbWlubWF4KDAsIDFmci",
"kpOwp9Ci5kYXkgewogIG1pbi13aWR0aDogMDsKICBtaW4taGVpZ2h0OiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBwYWRkaW5nOiA4cHg7CiAgYm9yZGVyLXJhZGl1czogMTRweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5kYXkud2Vla2VuZCwgLm1jZWxsLndlZWtlbmQgeyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc3VyZmFjZSkgNTUlLCB2YXIoLS1jb2wpKTsgfQouZGF5LnRvZGF5IHsgcGFkZGluZzogN3B4OyBib3JkZXI6IDJweCBzb2xpZCB2YXIoLS1hY2NlbnQpOyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc3VyZmFjZSkgOTIlLCB2YXIoLS1hY2NlbnQpKTsgfQouY2FsLXdlZWsgLmRheSAuY2FsLWl0ZW1zIHsgZmxleDogMTsgbWluLWhlaWdodDogMDsgb3ZlcmZsb3cteTogYXV0bzsgfQouZGF5LWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDZweDsgbWFyZ2luOiAwIDAgNnB4IDJweDsgZm9udC1zaXplOiAxNHB4OyBjb2xvcjogdmFyKC0tZmcpOyB9Ci5kYXktaGVhZCAuZG5hbWUgeyBjb2xvcjogdmFyKC0tZmctMik7IH0KLmRheS1oZWFkIC5kbnVtIHsgZm9udC13ZWlnaHQ6IDUwMDsgfQovKiBUaGUgc2NyYXRjaHBhZCBpbiB0aGUgd2VlaydzIGVpZ2h0aCBzcGFjZTogaXRzIGNvbG91ciBmcm9tIH",
"RoZSBub3RlcywKICAgYW5kIGEgc21hbGxlciBlZGl0b3IgdGhhdCBzY3JvbGxzIGluc2lkZSB0aGUgdGlsZS4gKi8KLnNjcmF0Y2gtdGlsZSB7IGJhY2tncm91bmQ6IHZhcigtLXNjcmF0Y2gpOyBib3JkZXItY29sb3I6IHZhcigtLXNjcmF0Y2gtZWRnZSk7IH0KLnNjcmF0Y2gtdGlsZSAuZGF5LWhlYWQgLmljb24geyBmbGV4OiBub25lOyBjb2xvcjogdmFyKC0tc2NyYXRjaC1pbmspOyB9Ci5zY3JhdGNoLXRpbGUgLmRheS1oZWFkIC5kbmFtZSB7IGNvbG9yOiB2YXIoLS1mZyk7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLnNjcmF0Y2gtdGlsZSAuZGF5LWhlYWQgLm5lLXN0YXR1cyB7IG1hcmdpbi1sZWZ0OiBhdXRvOyB9Ci5zY3JhdGNoLXRpbGUtYm9keSB7IGZsZXg6IDE7IG1pbi1oZWlnaHQ6IDA7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IH0KLnNjcmF0Y2gtdGlsZSAubmUtYm9keSB7IHBhZGRpbmc6IDJweCA0cHggOHB4OyBmb250LXNpemU6IDEzLjVweDsgbGluZS1oZWlnaHQ6IDEuNTsgfQouc2NyYXRjaC10aWxlIC5uZS1ib2R5W2RhdGEtZW1wdHk9IjEiXTo6YmVmb3JlIHsgdG9wOiAycHg7IGxlZnQ6IDRweDsgfQouc2NyYXRjaC10aWxlIC5uZS1saW5rYmFyLCAuc2NyYXRjaC10aWxlIC5uZS10YWJsZWJhciB7IG1hcmdpbjogMCAwIDZweDsgfQouc2NyYXRjaC10aWxlIC5uZS1saW5rYmFyIC50ZXh0LWlucHV0IHsgbWluLXdpZHRoOiAwOyB9Ci5zdW5kYXkgLmRheS1oZWFkLCAuc3VuZG",
"F5IC5kYXktaGVhZCAuZG5hbWUsIC5tY2VsbC5zdW5kYXk6bm90KC50b2RheSkgLm1kYXksIC5hZGF5LnN1bmRheSAuYWRheS1kYXRlIHsgY29sb3I6IHZhcigtLWMtcmVkKTsgfQoKLyogVGhlIHdlZWsgYnkgdGhlIGhvdXI6IG9uZSBncmlkIHRoYXQgc2Nyb2xscywgdGhlIGRheXMnIGhlYWRzIGFuZCB0aGVpcgogICBhbGwtZGF5IHJvd3MgaGVsZCBhdCB0aGUgdG9wLCB0aGUgaG91cnMgZG93biB0aGUgc2lkZS4gLS1ob3VyIGlzIGFuCiAgIGhvdXIncyBoZWlnaHQ6IHRoZSBob3VycyBvbiBzY3JlZW4gKC0taG91cnMgb2YgdGhlbSwgZnJvbSAtLXNwYW4tZnJvbSkKICAgZmlsbCB0aGUgc3BhY2UgdGhlcmUgaXMsIGRvd24gdG8gMzZweCBlYWNoLCBhbmQgc2Nyb2xsIGFmdGVyIHRoYXQuCiAgIFdoYXRldmVyIGlzIGluIHRoZSBob3VycyBpcyBwbGFjZWQgYnkgbWludXRlcyBhZnRlciBtaWRuaWdodCAoLS1mcm9tLAogICAtLXRvKSBhbmQsIHNpZGUgYnkgc2lkZSwgYXMgLS1jb2wgb2YgLS1jb2xzLiAqLwouY2FsW2RhdGEtbmFycm93PSJmYWxzZSJdW2RhdGEtdmlldz0id2VlayJdW2RhdGEtbGF5b3V0PSJjb2x1bW5zIl0gLmNhbC1tYWluIHsgY29udGFpbmVyLXR5cGU6IHNpemU7IH0KLmNhbC13ZWVrLmhvdXJzIHsKICAtLWhvdXI6IDQ4cHg7CiAgLS1oZWFkOiA0MnB4OwogIC0tYWxsZGF5OiBjYWxjKHZhcigtLWFsbGRheS1yb3dzLCAxKSAqIDI1cHggKyA5cHgpOwogIC0tZ3V0dGVyOiA2MHB4OwogIGRpc3BsYX",
"k6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiB2YXIoLS1ndXR0ZXIpIHJlcGVhdCg3LCBtaW5tYXgoMCwgMWZyKSk7CiAgYWxpZ24tY29udGVudDogc3RhcnQ7CiAgZ2FwOiAwOwogIG92ZXJmbG93LXk6IGF1dG87CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAxNHB4OwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9CkBzdXBwb3J0cyAoaGVpZ2h0OiAxY3FoKSB7CiAgLmNhbC13ZWVrLmhvdXJzIHsgLS1ob3VyOiBtYXgoMzZweCwgY2FsYygoMTAwY3FoIC0gdmFyKC0taGVhZCkgLSB2YXIoLS1hbGxkYXkpIC0gNHB4KSAvIHZhcigtLWhvdXJzLCAyNCkpKTsgfQp9Ci5jYWwtd2Vlay5ob3Vyc1tkYXRhLXpvbmVzPSIyIl0geyAtLWd1dHRlcjogMTA4cHg7IH0KLmNhbC13ZWVrLmhvdXJzIC5kYXksCi5jYWwtd2Vlay5ob3VycyAuZGF5LnRvZGF5IHsKICAtLWRheS1iZzogdmFyKC0tc3VyZmFjZSk7CiAgZGlzcGxheTogYmxvY2s7CiAgcGFkZGluZzogMDsKICBib3JkZXI6IDA7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6IDA7CiAgYmFja2dyb3VuZDogdmFyKC0tZGF5LWJnKTsKfQouY2FsLXdlZWsuaG91cnMgLmRheS53ZWVrZW5kIHsgLS1kYXktYmc6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1zdXJmYWNlKSA1NSUsIHZhcigtLWNvbCkpOyB9Ci5jYWwtd2Vlay5ob3VycyAuZGF5LWhlYWQgew",
"ogIHBvc2l0aW9uOiBzdGlja3k7CiAgdG9wOiAwOwogIHotaW5kZXg6IDM7CiAgaGVpZ2h0OiB2YXIoLS1oZWFkKTsKICBtYXJnaW46IDA7CiAgcGFkZGluZzogMCA2cHggMCAxMHB4OwogIGJhY2tncm91bmQ6IHZhcigtLWRheS1iZyk7Cn0KLmNhbC13ZWVrLmhvdXJzIC5kYXkudG9kYXkgLmRudW0gewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgbWluLXdpZHRoOiAyNnB4OwogIGhlaWdodDogMjZweDsKICBib3JkZXItcmFkaXVzOiAxM3B4OwogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7CiAgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7Cn0KLmNhbC13ZWVrLmhvdXJzIC5kYXkudG9kYXkgLmJhZGdlIHsgZGlzcGxheTogbm9uZTsgfQouY2FsLXdlZWsuaG91cnMgLmdyaWQtYWxsZGF5IHsKICBwb3NpdGlvbjogc3RpY2t5OwogIHRvcDogdmFyKC0taGVhZCk7CiAgei1pbmRleDogMzsKICBoZWlnaHQ6IHZhcigtLWFsbGRheSk7CiAgb3ZlcmZsb3cteTogYXV0bzsKICBwYWRkaW5nOiA0cHg7CiAgZ2FwOiAzcHg7CiAgYmFja2dyb3VuZDogdmFyKC0tZGF5LWJnKTsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouY2FsLXdlZWsuaG91cnMgLmdyaWQtYWxsZGF5IC5pdGVtIC50IHsgLXdlYmtpdC1saW5lLWNsYW1wOiAxOyB9Ci8qIFRoZSBuaWdodCwgd2hlcmUgaXQgc2hvd3MsIGEgc2hhZGUgZG",
"Fya2VyLiAqLwouZ3JpZC1ib2R5IHsKICAtLW5pZ2h0OiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tY29sKSA0NSUsIHRyYW5zcGFyZW50KTsKICAtLWRhd246IGNhbGMoKDQyMCAtIHZhcigtLXNwYW4tZnJvbSwgMCkpICogdmFyKC0taG91cikgLyA2MCk7CiAgLS1kdXNrOiBjYWxjKCgxMzIwIC0gdmFyKC0tc3Bhbi1mcm9tLCAwKSkgKiB2YXIoLS1ob3VyKSAvIDYwKTsKICBwb3NpdGlvbjogcmVsYXRpdmU7CiAgaGVpZ2h0OiBjYWxjKHZhcigtLWhvdXJzLCAyNCkgKiB2YXIoLS1ob3VyKSk7CiAgYmFja2dyb3VuZC1pbWFnZToKICAgIGxpbmVhci1ncmFkaWVudCh2YXIoLS1ib3JkZXIpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCh2YXIoLS1uaWdodCkgdmFyKC0tZGF3biksIHRyYW5zcGFyZW50IHZhcigtLWRhd24pLCB0cmFuc3BhcmVudCB2YXIoLS1kdXNrKSwgdmFyKC0tbmlnaHQpIHZhcigtLWR1c2spKTsKICBiYWNrZ3JvdW5kLXNpemU6IDEwMCUgdmFyKC0taG91ciksIDEwMCUgMTAwJTsKfQouZ3JpZC1ib2R5ID4gLnRpbWVkLAouZ3JpZC1ib2R5ID4gLmdyaWQtcmVzaXplLAouZHJvcC1naG9zdCB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IGNhbGModmFyKC0tY29sLCAwKSAqICgxMDAlIC0gOHB4KSAvIHZhcigtLWNvbHMsIDEpICsgMnB4KTsKICB3aWR0aDogY2FsYygoMTAwJSAtIDhweCkgLyB2YXIoLS1jb2xzLCAxKSAtIDJweCk7Cn0KLmdyaWQtYm9keSA-IC",
"50aW1lZCwKLmRyb3AtZ2hvc3QgewogIHRvcDogY2FsYygodmFyKC0tZnJvbSkgLSB2YXIoLS1zcGFuLWZyb20sIDApKSAqIHZhcigtLWhvdXIpIC8gNjAgKyAxcHgpOwogIGhlaWdodDogY2FsYygodmFyKC0tdG8pIC0gdmFyKC0tZnJvbSkpICogdmFyKC0taG91cikgLyA2MCAtIDJweCk7Cn0KLmNhbC13ZWVrLmhvdXJzIC50aW1lZCB7CiAgei1pbmRleDogMTsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGZsZXgtd3JhcDogbm93cmFwOwogIGFsaWduLWl0ZW1zOiBzdHJldGNoOwogIGdhcDogMDsKICBvdmVyZmxvdzogaGlkZGVuOwogIHBhZGRpbmc6IDJweCA2cHg7CiAgYmFja2dyb3VuZC1jb2xvcjogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWMsIHZhcigtLWFjY2VudCkpIDIyJSwgdmFyKC0tc3VyZmFjZSkpOwp9Ci5jYWwtd2Vlay5ob3VycyAudGltZWQgLnQgeyBmbGV4OiBub25lOyBmb250LXdlaWdodDogNTAwOyB9Ci5jYWwtd2Vlay5ob3VycyAudGltZWQgLnRpbWUgeyBmb250LXNpemU6IDExLjVweDsgfQouY2FsLXdlZWsuaG91cnMgLnRpbWVkLnNob3J0IHsgZmxleC1kaXJlY3Rpb246IHJvdzsgYWxpZ24taXRlbXM6IGJhc2VsaW5lOyBnYXA6IDZweDsgbWluLWhlaWdodDogMTZweDsgcGFkZGluZy10b3A6IDA7IHBhZGRpbmctYm90dG9tOiAwOyBmb250LXNpemU6IDExLjVweDsgbGluZS1oZWlnaHQ6IDE0cHg7IH0KLmNhbC13ZWVrLmhvdXJzIC50aW1lZC5zaG9ydCAudCB7IGZsZXg6IDAgMSBhdX",
"RvOyAtd2Via2l0LWxpbmUtY2xhbXA6IDE7IH0KLmNhbC13ZWVrLmhvdXJzIC50aW1lZC5zaG9ydCAudGltZSB7IGZsZXg6IG5vbmU7IH0KLmNhbC13ZWVrLmhvdXJzIC50aW1lZC5yZXNpemluZyB7IHotaW5kZXg6IDI7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0xKTsgfQovKiBUaGUgYm90dG9tIGVkZ2Ugb2YgYW4gZXZlbnQgdGhhdCBjYW4gYmUgY2hhbmdlZDogZHJhZ2dlZCwgaXRzIGVuZC4KICAgVGhlIGxhc3QgZmV3IHBpeGVscyBvZiBpdCBhcyBzaG93biAoYSBzaG9ydCBvbmUgaXMgc2hvd24gdGFsbGVyIHRoYW4KICAgaXQgaXMpLCBzbyB0aGF0IHRoZSByZXN0IGNhbiBzdGlsbCBiZSBjbGlja2VkIGFuZCBkcmFnZ2VkLiAqLwouZ3JpZC1ib2R5ID4gLmdyaWQtcmVzaXplIHsKICB6LWluZGV4OiAyOwogIHRvcDogY2FsYyhtYXgoKHZhcigtLXRvKSAtIHZhcigtLXNwYW4tZnJvbSwgMCkpICogdmFyKC0taG91cikgLyA2MCAtIDFweCwgKHZhcigtLWZyb20pIC0gdmFyKC0tc3Bhbi1mcm9tLCAwKSkgKiB2YXIoLS1ob3VyKSAvIDYwICsgMTdweCkgLSA1cHgpOwogIGhlaWdodDogNXB4OwogIGN1cnNvcjogbnMtcmVzaXplOwogIHRvdWNoLWFjdGlvbjogbm9uZTsKfQovKiBXaGVyZSBhIGRyYWdnZWQgZXZlbnQgd291bGQgZ28sIGFuZCBub3cuICovCi5kcm9wLWdob3N0IHsKICB6LWluZGV4OiAyOwogIHBhZGRpbmc6IDFweCA2cHg7CiAgYm9yZGVyOiAycHggZGFzaGVkIHZhcigtLWFjY2VudCk7CiAgYm9yZG",
"VyLXJhZGl1czogNnB4OwogIGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1hY2NlbnQpIDEwJSwgdHJhbnNwYXJlbnQpOwogIGNvbG9yOiB2YXIoLS1hY2NlbnQpOwogIGZvbnQtc2l6ZTogMTEuNXB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7Cn0KLm5vdy1saW5lIHsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgbGVmdDogMDsKICByaWdodDogMDsKICB0b3A6IGNhbGMoKHZhcigtLWZyb20pIC0gdmFyKC0tc3Bhbi1mcm9tLCAwKSkgKiB2YXIoLS1ob3VyKSAvIDYwIC0gMXB4KTsKICB6LWluZGV4OiAyOwogIGhlaWdodDogMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWMtcmVkKTsKICBwb2ludGVyLWV2ZW50czogbm9uZTsKfQoubm93LWxpbmU6OmJlZm9yZSB7CiAgY29udGVudDogIiI7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IC01cHg7CiAgdG9wOiAtNHB4OwogIHdpZHRoOiAxMHB4OwogIGhlaWdodDogMTBweDsKICBib3JkZXItcmFkaXVzOiA1MCU7CiAgYmFja2dyb3VuZDogdmFyKC0tYy1yZWQpOwp9Ci8qIFRoZSBob3VycyBkb3duIHRoZSBzaWRlLCBpbiBvbmUgb3IgdHdvIHRpbWUgem9uZXMuICovCi5ncmlkLWNvcm5lciB7CiAgcG9zaXRpb246IHN0aWNreTsKICB0b3A6IDA7CiAgei1pbmRleDogNDsKICBoZWlnaHQ6IGNhbGModmFyKC0taGVhZCkgKyB2YXIoLS1hbGxkYXkpKTsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBmbG",
"V4LWVuZDsKICBwYWRkaW5nOiAwIDRweCA0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdyaWQtem9uZXMgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDJweDsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDI2cHg7CiAgcGFkZGluZzogMCA0cHggMCAycHg7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIGNvbG9yOiB2YXIoLS1mZy0zKTsKICBmb250LXNpemU6IDEwLjVweDsKfQouZ3JpZC16b25lczpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgY29sb3I6IHZhcigtLWZnKTsgfQouZ3JpZC16b25lcyBzcGFuIHsgZmxleDogMTsgdGV4dC1hbGlnbjogcmlnaHQ7IHdoaXRlLXNwYWNlOiBub3dyYXA7IH0KLmdyaWQtem9uZXMgLmljb24geyBmbGV4OiBub25lOyB9Ci5ncmlkLWhvdXJzIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1yb3dzOiByZXBlYXQodmFyKC0taG91cnMsIDI0KSwgdmFyKC0taG91cikpOyB9Ci5ub3ctbGluZVtoaWRkZW5dIHsgZGlzcGxheTogbm9uZTsgfQouZ3JpZC1ob3VyIHsgZGlzcGxheTogZmxleDsgZ2FwOiAycHg7IHBhZGRpbmc6IDAgOHB4IDAgNHB4OyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtczsgfQouZ3JpZC1ob3VyIHNwYW4geyBmbGV4OiAxOy",
"BoZWlnaHQ6IG1heC1jb250ZW50OyB0ZXh0LWFsaWduOiByaWdodDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKC01MCUpOyB9Ci8qIFRoZSBmaXJzdCBob3VyJ3MgbGluZSBpcyB0aGUgdG9wIGVkZ2U6IGl0cyB0aW1lIGdvZXMganVzdCBiZWxvdyBpdC4gKi8KLmdyaWQtaG91cjpmaXJzdC1jaGlsZCBzcGFuIHsgdHJhbnNmb3JtOiBub25lOyB9Ci5ncmlkLWhvdXIgLm90aGVyLCAuZ3JpZC16b25lcyAub3RoZXIgeyBvcGFjaXR5OiAuNzsgfQouYmFkZ2UgeyBwYWRkaW5nOiAxcHggN3B4OyBib3JkZXItcmFkaXVzOiA5cHg7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7IGNvbG9yOiB2YXIoLS1vbi1hY2NlbnQpOyBmb250LXNpemU6IDExcHg7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLmRheS5wYXN0IC5pdGVtIHsgb3BhY2l0eTogLjc4OyB9Ci5taW5pLXRpbGUgeyBkaXNwbGF5OiBub25lOyB9Ci5sb2FkaW5nIC5jYWwtaXRlbXM6OmJlZm9yZSwKLmNhbC1hZ2VuZGEubG9hZGluZzo6YmVmb3JlIHsKICBjb250ZW50OiAiIjsKICBkaXNwbGF5OiBibG9jazsKICBoZWlnaHQ6IDIycHg7CiAgYm9yZGVyLXJhZGl1czogNnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsKICBhbmltYXRpb246IGNhbC1wdWxzZSAxLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlIGFsdGVybmF0ZTsKfQpAa2V5ZnJhbWVzIGNhbC1wdWxzZSB7IGZyb20geyBvcGFjaXR5OiAuNDsgfSB0byB7IG9wYWNpdHk6IDE7IH0gfQoKLyogRXZlbnRzIGFuZC",
"B0YXNrcyAqLwouY2FsLWl0ZW1zIHsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiA0cHg7IG1pbi13aWR0aDogMDsgfQouaXRlbSB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogNnB4OwogIG1pbi13aWR0aDogMDsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgY29sb3I6IHZhcigtLWZnKTsKICBmb250LXNpemU6IDEyLjVweDsKICBsaW5lLWhlaWdodDogMS4zOwogIHRleHQtZGVjb3JhdGlvbjogbm9uZTsKfQphLml0ZW06aG92ZXIgeyBiYWNrZ3JvdW5kLWltYWdlOiBsaW5lYXItZ3JhZGllbnQodmFyKC0taG92ZXIpLCB2YXIoLS1ob3ZlcikpOyB9Ci5pdGVtIC50IHsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQouZXYgewogIHBhZGRpbmc6IDNweCA2cHg7CiAgYm9yZGVyLWxlZnQ6IDNweCBzb2xpZCB2YXIoLS1jLCB2YXIoLS1hY2NlbnQpKTsKICBiYWNrZ3JvdW5kLWNvbG9yOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYywgdmFyKC0tYWNjZW50KSkgMTQlLCB2YXIoLS1zdXJmYWNlKSk7Cn0KLmV2LmFsbC1kYXkgeyBiYWNrZ3JvdW5kLWNvbG9yOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYywgdmFyKC0tYWNjZW50KSkgMzIlLCB2YXIoLS1zdXJmYWNlKSk7IH0KLmV2IC50aW1lIHsgZmxleDogbm9uZTsgY29sb3I6IHZhcigtLWZnLTIpOy",
"Bmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9Ci8qIEluIGEgZGF5J3MgY29sdW1uIG9yIHRpbGUsIGEgdGl0bGUgZ2V0cyB0d28gbGluZXMgYmVmb3JlIGl0IGlzIGN1dCwKICAgYW5kIGdvZXMgdW5kZXIgaXRzIHRpbWUgd2hlbiB0aGUgdHdvIHdpbGwgbm90IGZpdCBzaWRlIGJ5IHNpZGUuICovCi5jYWwtd2VlayAuaXRlbSB7IGFsaWduLWl0ZW1zOiBmbGV4LXN0YXJ0OyB9Ci5jYWwtd2VlayAuZXYgeyBmbGV4LXdyYXA6IHdyYXA7IHJvdy1nYXA6IDA7IH0KLmNhbC13ZWVrIC5ldiAudCB7IGZsZXg6IDEgMSA2LjVlbTsgfQouY2FsLXdlZWsgLml0ZW0gLnQsIC5jYWwtdHJheSAuaXRlbSAudCB7CiAgZGlzcGxheTogLXdlYmtpdC1ib3g7CiAgLXdlYmtpdC1ib3gtb3JpZW50OiB2ZXJ0aWNhbDsKICAtd2Via2l0LWxpbmUtY2xhbXA6IDI7CiAgd2hpdGUtc3BhY2U6IG5vcm1hbDsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKfQouY2FsLXdlZWsgLnRhc2sgLmJveCwgLmNhbC10cmF5IC50YXNrIC5ib3ggeyBtYXJnaW4tdG9wOiAxcHg7IH0KLnRhc2sgeyBwYWRkaW5nOiAycHggNHB4OyB9Ci50YXNrIC5ib3ggewogIGZsZXg6IG5vbmU7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICB3aWR0aDogMTRweDsKICBoZWlnaHQ6IDE0cHg7CiAgYm9yZGVyOiAxLjZweCBzb2xpZCB2YXIoLS1mZy0yKTsKICBib3JkZX",
"ItcmFkaXVzOiA0cHg7Cn0KLnRhc2suZG9uZSAuYm94IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50KTsgfQoudGFzay5kb25lIC50IHsgY29sb3I6IHZhcigtLWZnLTMpOyB0ZXh0LWRlY29yYXRpb246IGxpbmUtdGhyb3VnaDsgfQoudGFzayAuZHVlIHsgZmxleDogbm9uZTsgbWFyZ2luLWxlZnQ6IGF1dG87IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyBmb250LXNpemU6IDExLjVweDsgfQoudGFzayAubWFpbCB7IGZsZXg6IG5vbmU7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBtYXJnaW4tbGVmdDogYXV0bzsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0KLnRhc2sgLmR1ZSArIC5tYWlsIHsgbWFyZ2luLWxlZnQ6IDRweDsgfQoKLyogQ2hhbmdpbmcgdGhpbmdzOiBhICsgb24gZWFjaCBkYXksIGEgdGFzaydzIGJveCB0aGF0IHRpY2tzIGl0LCBkcmFnZ2luZwogICB0byBhbm90aGVyIGRheSwgYW5kIHRoZSBlZGl0b3IuICovCi5kYXktYWRkIHsgd2lkdGg6IDI4cHg7IGhlaWdodDogMjhweDsgY29sb3I6IHZhcigtLWZnLTIpOyBmbGV4OiBub25lOyB9Ci5kYXktaGVhZCAuZGF5LWFkZCB7IG1hcmdpbjogLTVweCAtNXB4IC01cHggYXV0bzsgfQoubWhlYWQgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyB9Ci5tY2VsbCAuZGF5LWFkZCB7IHdpZHRoOiAyNHB4OyBoZWlnaHQ6IDI0cHg7IG1hcmdpbi1sZWZ0OiBhdX",
"RvOyBvcGFjaXR5OiAwOyB9Ci5tY2VsbDpob3ZlciAuZGF5LWFkZCwgLm1jZWxsIC5kYXktYWRkOmZvY3VzLXZpc2libGUgeyBvcGFjaXR5OiAxOyB9Ci50YXNrLWxpbmsgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogNnB4OyBjb2xvcjogaW5oZXJpdDsgdGV4dC1kZWNvcmF0aW9uOiBub25lOyB9Ci5jYWwtd2VlayAudGFzay1saW5rLCAuY2FsLXRyYXkgLnRhc2stbGluayB7IGFsaWduLWl0ZW1zOiBmbGV4LXN0YXJ0OyB9CmRpdi5pdGVtLnRhc2s6aG92ZXIgeyBiYWNrZ3JvdW5kLWltYWdlOiBsaW5lYXItZ3JhZGllbnQodmFyKC0taG92ZXIpLCB2YXIoLS1ob3ZlcikpOyB9CmJ1dHRvbi5ib3ggeyBwYWRkaW5nOiAwOyBiYWNrZ3JvdW5kOiBub25lOyBjb2xvcjogaW5oZXJpdDsgY3Vyc29yOiBwb2ludGVyOyB9Ci5pdGVtLmRyYWdnaW5nIHsgb3BhY2l0eTogLjQ1OyB9Ci5kcm9wLWhlcmUgeyBib3gtc2hhZG93OiBpbnNldCAwIDAgMCAycHggdmFyKC0tYWNjZW50KTsgfQouY2FsLWVkaXQta2luZHMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDJweDsgcGFkZGluZzogM3B4OyBib3JkZXItcmFkaXVzOiAyMHB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IGp1c3RpZnktc2VsZjogc3RhcnQ7IH0KLmNhbC1lZGl0LWtpbmRzIC5zZWdbYXJpYS1wcmVzc2VkPSJ0cnVlIl0geyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsgY29sb3I6IHZhcigtLW",
"ZnKTsgYm94LXNoYWRvdzogdmFyKC0tc2hhZG93LTEpOyB9Ci5jYWwtZWRpdC1wYXJ0IHsgZGlzcGxheTogZ3JpZDsgZ2FwOiAxNHB4OyB9Ci5jYWwtZWRpdC1wYXJ0W2hpZGRlbl0sIC5jYWwtZWRpdCAuZGlhbG9nLWZvb3RbaGlkZGVuXSwgLmNhbC1lZGl0IC5jYWwtdGltZVtoaWRkZW5dIHsgZGlzcGxheTogbm9uZTsgfQouY2FsLWVkaXQtcm93IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IH0KLmNhbC1lZGl0LXJvdyAuY2FsLWRhdGUgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IH0KLmNhbC10aW1lIHsgd2lkdGg6IDYuNWVtOyBmbGV4OiBub25lOyB0ZXh0LWFsaWduOiBjZW50ZXI7IGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7IH0KLmNhbC1lZGl0LWNoZWNrIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IGN1cnNvcjogcG9pbnRlcjsgfQouY2FsLWVkaXQtd2hlcmUgeyBwYWRkaW5nOiA0cHggMDsgfQouY2FsLWVkaXQgLmRpYWxvZy1ib2R5ID4gLm5vdGUsIC5jYWwtZWRpdC1wYXJ0ID4gLm5vdGUgeyBtYXJnaW46IDA7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLWZnLTMpOyB9Ci8qIEhvdyBpdCByZXBlYXRzOiBHb29nbGUncyBtZW51LCBhbmQgaXRzIEN1c3RvbSBwYW5lbC4gKi8KLmNhbC1lZGl0IFtoaWRkZW5dIHsgZGlzcGxheTogbm9uZSAhaW1wb3J0YW50OyB9Ci5jYWwtcmVwZWF0LWN1c3RvbSB7IG",
"Rpc3BsYXk6IGdyaWQ7IGdhcDogMTBweDsgbWFyZ2luLXRvcDogOHB4OyBwYWRkaW5nOiAxMnB4OyBib3JkZXItcmFkaXVzOiAxMnB4OyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLmNhbC1ldmVyeSB7IHdpZHRoOiA1ZW07IGZsZXg6IG5vbmU7IHRleHQtYWxpZ246IGNlbnRlcjsgfQouY2FsLWRheXMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDZweDsgfQouY2FsLWRheS1waWNrIHsKICB3aWR0aDogMzJweDsKICBoZWlnaHQ6IDMycHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXdlaWdodDogNTAwOwogIGN1cnNvcjogcG9pbnRlcjsKfQouY2FsLWRheS1waWNrW2FyaWEtcHJlc3NlZD0idHJ1ZSJdIHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyBjb2xvcjogdmFyKC0tb24tYWNjZW50KTsgfQouY2FsLWVuZHMgeyBkaXNwbGF5OiBncmlkOyBnYXA6IDZweDsgfQouY2FsLWVuZHMgLmNhbC1lZGl0LWNoZWNrIHsgZ2FwOiA4cHg7IH0KLmNhbC1lbmRzIC50ZXh0LWlucHV0IHsgaGVpZ2h0OiAzMnB4OyB9CgovKiBNb250aCAqLwouY2FsLW1vbnRoIHsgZmxleDogMTsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgbWluLWhlaWdodDogMDsgfQoubW9udGgtZG93cy",
"B7IGRpc3BsYXk6IGdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDcsIG1pbm1heCgwLCAxZnIpKTsgZ2FwOiA2cHg7IHBhZGRpbmctYm90dG9tOiA0cHg7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxMnB4OyB0ZXh0LWFsaWduOiBjZW50ZXI7IH0KLm1vbnRoLWdyaWQgewogIGZsZXg6IDE7CiAgZGlzcGxheTogZ3JpZDsKICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg3LCBtaW5tYXgoMCwgMWZyKSk7CiAgZ3JpZC10ZW1wbGF0ZS1yb3dzOiByZXBlYXQodmFyKC0tcm93cywgNSksIG1pbm1heCgwLCAxZnIpKTsKICBnYXA6IDZweDsKICBtaW4taGVpZ2h0OiAwOwp9Ci5tY2VsbCB7CiAgbWluLXdpZHRoOiAwOwogIG1pbi1oZWlnaHQ6IDA7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiAycHg7CiAgcGFkZGluZzogNHB4IDZweCA2cHg7CiAgYm9yZGVyLXJhZGl1czogMTJweDsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Ci5tY2VsbC5vdGhlciB7IG9wYWNpdHk6IC41NTsgfQoubWNlbGwudG9kYXkgeyBwYWRkaW5nOiAzcHggNXB4IDVweDsgYm9yZGVyOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsgfQoubWRheSB7IGFsaWduLXNlbGY6IGZsZXgtc3RhcnQ7IG1pbi13aWR0aDogMjRweDsgaGVpZ2h0OiAyNHB4OyBwYWRkaW5nOi",
"AwIDZweDsgYm9yZGVyLXJhZGl1czogMTJweDsgZm9udC1zaXplOiAxMi41cHg7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KLm1kYXk6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ob3Zlcik7IH0KLm1jZWxsLnRvZGF5IC5tZGF5IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgY29sb3I6IHZhcigtLW9uLWFjY2VudCk7IH0KLml0ZW0uY29tcGFjdCB7IGZvbnQtc2l6ZTogMTJweDsgfQouZXYuY29tcGFjdCB7IHBhZGRpbmc6IDFweCA1cHg7IH0KLm1vcmUgeyBhbGlnbi1zZWxmOiBmbGV4LXN0YXJ0OyBwYWRkaW5nOiAxcHggNnB4OyBib3JkZXItcmFkaXVzOiA2cHg7IGNvbG9yOiB2YXIoLS1mZy0yKTsgZm9udC1zaXplOiAxMnB4OyB9Ci5tb3JlOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOyB9CgovKiBUaGUgbW9udGggb24gYSBwaG9uZTogb25lIGdyaWQsIGxpbmVzIGJldHdlZW4gdGhlIHdlZWtzLCBlYWNoIGRheSBhCiAgIGJ1dHRvbiB3aXRoIGEgZmV3IGNvbG91cmVkIGxpbmVzOyB0b2RheSdzIGRhdGUgcmluZ2VkLiAqLwouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1tb250aCB7IGZsZXg6IG5vbmU7IH0KLnBob25lLW1vbnRoIC5tb250aC1kb3dzIHsgZ2FwOiAwOyBwYWRkaW5nOiAwIDAgNHB4OyBmb250LXNpemU6IDExLjVweDsgfQoucGhvbmUtbW9udGggLm1vbnRoLWdyaWQgewogIGdyaWQtdGVtcGxhdGUtcm93czogbm9uZTsKICBncmlkLWF1dG8tcm93czogbWlubWF4KDkycHgsIG",
"F1dG8pOwogIGdhcDogMDsKICBib3JkZXItcmFkaXVzOiAxNHB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKfQoucGhvbmUtbW9udGggLm1jZWxsLAoucGhvbmUtbW9udGggLm1jZWxsLnRvZGF5IHsKICBhbGlnbi1pdGVtczogc3RyZXRjaDsKICBnYXA6IDJweDsKICBwYWRkaW5nOiAzcHggMnB4IDRweDsKICBib3JkZXI6IDA7CiAgYm9yZGVyLXRvcDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czogMDsKICBiYWNrZ3JvdW5kOiBub25lOwogIGNvbG9yOiB2YXIoLS1mZyk7CiAgZm9udDogaW5oZXJpdDsKICB0ZXh0LWFsaWduOiBsZWZ0OwogIGN1cnNvcjogcG9pbnRlcjsKfQoucGhvbmUtbW9udGggLm1jZWxsOm50aC1jaGlsZCgtbiArIDcpIHsgYm9yZGVyLXRvcDogMDsgfQoucGhvbmUtbW9udGggLm1jZWxsLndlZWtlbmQgeyBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tc3VyZmFjZSkgNTUlLCB2YXIoLS1jb2wpKTsgfQoucGhvbmUtbW9udGggLm1jZWxsOmFjdGl2ZSB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQoucGhvbmUtbW9udGggLm1jZWxsLm90aGVyIHsgb3BhY2l0eTogMTsgfQoucGhvbmUtbW9udGggLm1jZWxsLm90aGVyID4gKiB7IG9wYWNpdHk6IC41OyB9Ci5waG9uZS1tb250aCAubWRheSB7CiAgYWxpZ24tc2VsZjogY2VudGVyOwogIG",
"Rpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgbWluLXdpZHRoOiAyMnB4OwogIGhlaWdodDogMjJweDsKICBwYWRkaW5nOiAwIDRweDsKICBib3JkZXItcmFkaXVzOiAxMXB4OwogIGZvbnQtc2l6ZTogMTJweDsKfQoucGhvbmUtbW9udGggLmxpbmUgewogIGRpc3BsYXk6IGJsb2NrOwogIG92ZXJmbG93OiBoaWRkZW47CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICBwYWRkaW5nOiAwIDNweDsKICBib3JkZXItcmFkaXVzOiAzcHg7CiAgZm9udC1zaXplOiAxMHB4OwogIGxpbmUtaGVpZ2h0OiAxNHB4OwogIGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jLCB2YXIoLS1hY2NlbnQpKSAyMiUsIHZhcigtLXN1cmZhY2UpKTsKfQoucGhvbmUtbW9udGggLmxpbmUuYWxsLWRheSB7IGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jLCB2YXIoLS1hY2NlbnQpKSA0MiUsIHZhcigtLXN1cmZhY2UpKTsgfQoucGhvbmUtbW9udGggLmxpbmUudGFzayB7IGJhY2tncm91bmQ6IG5vbmU7IGJveC1zaGFkb3c6IGluc2V0IDAgMCAwIDFweCB2YXIoLS1ib3JkZXItc3Ryb25nKTsgfQoucGhvbmUtbW9udGggLmxpbmUuZG9uZSB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgdGV4dC1kZWNvcmF0aW9uOiBsaW5lLXRocm91Z2g7IH0KLnBob25lLW1vbnRoIC5tb3JlIHsgYWxpZ24tc2VsZjogZmxleC1zdGFydDsgcGFkZGluZzogMC",
"AzcHg7IGZvbnQtc2l6ZTogMTBweDsgbGluZS1oZWlnaHQ6IDE0cHg7IH0KLnBob25lLW1vbnRoLmxvYWRpbmcgLm1vbnRoLWdyaWQgeyBvcGFjaXR5OiAuNTsgfQoubWluaS10aWxlIGJ1dHRvbi5taW5pLWhlYWQgeyBwYWRkaW5nOiAwOyBib3JkZXI6IDA7IGJhY2tncm91bmQ6IG5vbmU7IGNvbG9yOiBpbmhlcml0OyBmb250OiBpbmhlcml0OyBmb250LXdlaWdodDogNTAwOyB0ZXh0LWFsaWduOiBsZWZ0OyBjdXJzb3I6IHBvaW50ZXI7IH0KCi8qIEFnZW5kYSAqLwouY2FsLWFnZW5kYSB7IGZsZXg6IDE7IG1pbi1oZWlnaHQ6IDA7IG92ZXJmbG93LXk6IGF1dG87IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogOHB4OyBtYXgtd2lkdGg6IDg4MHB4OyB9Ci5hZGF5IHsgZmxleDogbm9uZTsgZGlzcGxheTogZmxleDsgZ2FwOiAxNnB4OyBwYWRkaW5nOiAxMHB4IDE0cHg7IGJvcmRlci1yYWRpdXM6IDE0cHg7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyB9Ci5hZGF5LnRvZGF5IHsgcGFkZGluZzogOXB4IDEzcHg7IGJvcmRlcjogMnB4IHNvbGlkIHZhcigtLWFjY2VudCk7IH0KLmFkYXktZGF0ZSB7IGZsZXg6IG5vbmU7IHdpZHRoOiA4NHB4OyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDhweDsgY29sb3I6IHZhcigtLWZnKTsgfQouYWRheS1kYXRlIC5kbnVtIHsgbWluLXdpZHRoOiAxLjRlbTsgZm",
"9udC1zaXplOiAyNHB4OyBsaW5lLWhlaWdodDogMTsgdGV4dC1hbGlnbjogcmlnaHQ7IH0KLmFkYXktZGF0ZSAuZG5hbWUgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBmb250LXNpemU6IDEycHg7IGxpbmUtaGVpZ2h0OiAxLjI1OyB9Ci5hZGF5LWRhdGUgLm1vbiB7IG9wYWNpdHk6IC43OyB9Ci5hZGF5IC5jYWwtaXRlbXMgeyBmbGV4OiAxOyBnYXA6IDRweDsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IH0KLmFkYXkgLml0ZW0geyBmb250LXNpemU6IDEzLjVweDsgfQovKiBUaGUgYWdlbmRhIGlzIGEgbGlzdDogYSBkb3Qgb2YgdGhlIGNhbGVuZGFyJ3MgY29sb3VyLCBub3QgYSBibG9jay4gKi8KLmFkYXkgLmV2IHsgcGFkZGluZzogM3B4IDZweDsgYm9yZGVyLWxlZnQ6IDA7IGJhY2tncm91bmQ6IG5vbmU7IH0KLmFkYXkgLmV2OjpiZWZvcmUgeyBjb250ZW50OiAiIjsgZmxleDogbm9uZTsgd2lkdGg6IDEwcHg7IGhlaWdodDogMTBweDsgbWFyZ2luLXJpZ2h0OiA0cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsgYmFja2dyb3VuZDogdmFyKC0tYywgdmFyKC0tYWNjZW50KSk7IH0KLmFkYXkgLmV2IC50aW1lIHsgbWluLXdpZHRoOiA3LjVlbTsgfQouYWRheSAudGFzayB7IHBhZGRpbmctbGVmdDogNHB4OyB9Ci5hZGF5IC50YXNrIC5tYWlsLCAuYWRheSAudGFzayAuZHVlIHsgbWFyZ2luLWxlZnQ6IDZweDsgfQouZW1wdHkgeyBtYXJnaW46IDA7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaX",
"plOiAxM3B4OyB9Ci5jYWwtYWdlbmRhID4gLmVtcHR5IHsgbWFyZ2luOiAyNHB4IGF1dG87IH0KCi8qIE5hcnJvdzogYSBwaG9uZSwgb3IgYSBuYXJyb3cgd2luZG93ICovCi5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSB7IHBhZGRpbmc6IDAgMTJweCAxNnB4OyBvdmVyZmxvdy15OiBhdXRvOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLXZpZXdzIHsgZGlzcGxheTogbm9uZTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1oZWFkIHsgaGVpZ2h0OiA0OHB4OyBnYXA6IDJweDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC10aXRsZSB7IG9yZGVyOiAtMTsgbWFyZ2luOiAwIDJweCAwIDA7IGZvbnQtc2l6ZTogMTUuNXB4OyBmb250LXdlaWdodDogNTAwOyB9Ci5jYWwtd2sgewogIGRpc3BsYXk6IGlubGluZS1ibG9jazsKICBwYWRkaW5nOiAwIDVweDsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgYmFja2dyb3VuZDogdmFyKC0taG92ZXIpOwogIGNvbG9yOiB2YXIoLS1mZy0yKTsKICBmb250LXNpemU6IDEyLjVweDsKICBmb250LXdlaWdodDogNTAwOwogIGxpbmUtaGVpZ2h0OiAyMHB4OwogIHZlcnRpY2FsLWFsaWduOiAycHg7Cn0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5idG4tb3V0bGluZSB7IGhlaWdodDogMzJweDsgcGFkZGluZzogMCAxMnB4OyB9Ci50b2RheS1pY29uIHsgZGlzcGxheTogbm9uZTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC10b2RheSB7IHdpZH",
"RoOiAzNnB4OyBoZWlnaHQ6IDM2cHg7IHBhZGRpbmc6IDA7IG1hcmdpbjogMDsgYm9yZGVyOiAwOyBib3JkZXItcmFkaXVzOiA1MCU7IGNvbG9yOiB2YXIoLS1mZy0yKTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC10b2RheTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWhvdmVyKTsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLnRvZGF5LXdvcmQgeyBkaXNwbGF5OiBub25lOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAudG9kYXktaWNvbiB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBwb3NpdGlvbjogcmVsYXRpdmU7IH0KLnRvZGF5LW51bSB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IDA7CiAgcmlnaHQ6IDA7CiAgdG9wOiAxMHB4OwogIGZvbnQtc2l6ZTogMTBweDsKICBmb250LXdlaWdodDogNzAwOwogIGxpbmUtaGVpZ2h0OiAxMHB4OwogIHRleHQtYWxpZ246IGNlbnRlcjsKICBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOwp9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLWJvZHkgeyBmbGV4OiBub25lOyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDEwcHg7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtc2lkZSB7IGRpc3BsYXk6IGNvbnRlbnRzOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLW1pbmkgeyBkaXNwbGF5OiBub25lOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAuY2FsLXNvdXJjZXMgewogIG9yZGVyOi",
"AwOwogIGZsZXgtZGlyZWN0aW9uOiByb3c7CiAgZ2FwOiA2cHg7CiAgcGFkZGluZzogMCAwIDJweDsKICBib3JkZXI6IDA7CiAgYmFja2dyb3VuZDogbm9uZTsKICBvdmVyZmxvdy14OiBhdXRvOwogIHNjcm9sbGJhci13aWR0aDogbm9uZTsKfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLnNyYyB7CiAgZmxleDogbm9uZTsKICBnYXA6IDdweDsKICBoZWlnaHQ6IDMycHg7CiAgcGFkZGluZzogMCAxMnB4IDAgMTBweDsKICBib3JkZXItcmFkaXVzOiAxNnB4OwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdHJvbmcpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGZvbnQtc2l6ZTogMTNweDsKfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLnNyYyAuc3dhdGNoIHsgd2lkdGg6IDEwcHg7IGhlaWdodDogMTBweDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC1tYWluIHsgb3JkZXI6IDE7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5jYWwtdHJheSB7IG9yZGVyOiAyOyBib3JkZXItc3R5bGU6IGRhc2hlZDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC13ZWVrIHsKICBmbGV4OiBub25lOwogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDIsIG1pbm1heCgwLCAxZnIpKTsKICBncmlkLXRlbXBsYXRlLXJvd3M6IHJlcGVhdCg0LCBhdXRvKTsKICBncmlkLWF1dG8tZmxvdzogY29sdW1uOwp9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXVtkYXRhLW9yZGVyPS",
"JhY3Jvc3MiXSAuY2FsLXdlZWsgeyBncmlkLXRlbXBsYXRlLXJvd3M6IG5vbmU7IGdyaWQtYXV0by1mbG93OiByb3c7IH0KLmNhbFtkYXRhLW5hcnJvdz0idHJ1ZSJdIC5kYXkgeyBtaW4taGVpZ2h0OiAxMjBweDsgfQouY2FsW2RhdGEtbmFycm93PSJ0cnVlIl0gLmNhbC13ZWVrIC5kYXkgLmNhbC1pdGVtcyB7IG92ZXJmbG93OiB2aXNpYmxlOyB9Ci5jYWxbZGF0YS1uYXJyb3c9InRydWUiXSAubWluaS10aWxlIHsgZGlzcGxheTogZmxleDsgfQoubWluaS10aWxlIC5taW5pLWhlYWQgeyBtYXJnaW4tYm90dG9tOiAycHg7IH0KLm1pbmktdGlsZSAubWluaS1kYXkgeyBoZWlnaHQ6IDIwcHg7IGZvbnQtc2l6ZTogMTFweDsgfQoubWluaS10aWxlIC5taW5pLWRvdyB7IGZvbnQtc2l6ZTogMTBweDsgcGFkZGluZzogMDsgfQoKLmNhbC5jYWwtcGFuZWwgLmNhbC1zaWRlIHsgZGlzcGxheTogbm9uZTsgfQouY2FsLW1haW4gPiAucGFuZWwgeyBtYXJnaW46IGF1dG87IH0KYDsKCiAgLy8g4pSA4pSAIERvY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IERPQ0sgPSBgCjpob3N0IHsgei1pbmRleDogMjE0NzQ4Mjk5OSAhaW1wb3J0YW",
"50OyB9CgouZG9jayB7CiAgcG9zaXRpb246IGZpeGVkOwogIGxlZnQ6IDE2cHg7CiAgYm90dG9tOiAxNnB4OwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBmb250LWZhbWlseTogdmFyKC0tZm9udCk7CiAgZm9udC1zaXplOiAxNHB4OwogIC13ZWJraXQtZm9udC1zbW9vdGhpbmc6IGFudGlhbGlhc2VkOwp9Ci5kb2NrLnJpZ2h0IHsgbGVmdDogYXV0bzsgcmlnaHQ6IDcycHg7IH0KLmRvY2tbaGlkZGVuXSB7IGRpc3BsYXk6IG5vbmU7IH0KLnBpbGwgewogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA2cHg7CiAgaGVpZ2h0OiA0MHB4OwogIHBhZGRpbmc6IDAgMTZweCAwIDEycHg7CiAgYm9yZGVyLXJhZGl1czogMjBweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tZmcpOwogIGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0yKTsKICBmb250LXdlaWdodDogNTAwOwogIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgbWF4LXdpZHRoOiAzMjBweDsKfQoucGlsbDpob3ZlciB7IGJveC1zaGFkb3c6IHZhcigtLXNoYWRvdy0zKTsgYmFja2dyb3VuZC1pbWFnZTogbGluZWFyLWdyYWRpZW50KHZhcigtLWhvdmVyKSwgdmFyKC0taG92ZXIpKTsgfQoucGlsbCAuaWNvbiB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5waWxsLm9uIHsgYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tYWNjZW50LXNvZnQpOy",
"Bjb2xvcjogdmFyKC0tb24tYWNjZW50LXNvZnQpOyB9Ci5waWxsLm9uIC5pY29uIHsgY29sb3I6IGluaGVyaXQ7IH0KLnBpbGwgLnBpbGwtbGFiZWwgeyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgfQoucGlsbCAuY2FyZXQgeyBtYXJnaW46IDAgLTZweCAwIC0ycHg7IGNvbG9yOiBpbmhlcml0OyB9Ci5waWxsLWNvbXBhY3QgeyBwYWRkaW5nOiAwIDE0cHggMCAxMHB4OyB9Ci5waWxsLmJ1c3kgeyBvcGFjaXR5OiAuNzsgfQoKLyogSW4gR21haWwncyB0b3AgYmFyOiBwYXJ0IG9mIHRoZSBiYXIncyByb3csIGJldHdlZW4gdGhlIHNlYXJjaCBib3ggYW5kCiAgIEdtYWlsJ3MgaWNvbnMuIFRoZWlyIG93biBiYWNrZ3JvdW5kIGFuZCBhIHRoaW4gb3V0bGluZSwgcmF0aGVyIHRoYW4gbm9uZSwKICAgc28gdGhhdCB0aGV5IHJlYWQgdGhlIHNhbWUgb24gYW55IHRoZW1lIG9mIEdtYWlsJ3M7IGljb25zIG9ubHkgd2hlbiB0aGUKICAgcm9vbSBpcyBzaG9ydCAodGhlIG9wZW4gZW1haWwncyBidXR0b24ga2VlcHMgaXRzIHdvcmRzKS4gKi8KOmhvc3QoLmdrYi1iYXIpIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZmxleDogbm9uZTsgbWFyZ2luOiAwIDRweCAwIDEycHg7IH0KLmRvY2sudG9wIHsgcG9zaXRpb246IHN0YXRpYzsgZ2FwOiA2cHg7IH0KLmRvY2sudG9wIC5waWxsIHsgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMXB4IHZhcigtLWJvcmRlcik7IH0KLmRvY2sudG",
"9wIC5waWxsOmhvdmVyIHsgYm94LXNoYWRvdzogaW5zZXQgMCAwIDAgMXB4IHZhcigtLWJvcmRlci1zdHJvbmcpOyB9Ci5kb2NrLnRvcC5jb21wYWN0IC5waWxsOm5vdChbZGF0YS1hY3Rpb249InRocmVhZC1tZW51Il0pIHsgd2lkdGg6IDQwcHg7IHBhZGRpbmc6IDA7IGp1c3RpZnktY29udGVudDogY2VudGVyOyB9Ci5kb2NrLnRvcC5jb21wYWN0IC5waWxsOm5vdChbZGF0YS1hY3Rpb249InRocmVhZC1tZW51Il0pIC5waWxsLWxhYmVsIHsgZGlzcGxheTogbm9uZTsgfQouZG9jay50b3AgW2RhdGEtYWN0aW9uPSJ0aHJlYWQtbWVudSJdIHsgbWF4LXdpZHRoOiAyNDBweDsgfQpgOwoKICBucy5zdHlsZXMgPSB7IGJvYXJkOiBCQVNFICsgQk9BUkQgKyBDQUxFTkRBUiwgZG9jazogQkFTRSArIERPQ0sgfTsKfSkoKTsK\"],[\"src/content/note-editor.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBmb3JtYXR0ZWQgbm90ZSBlZGl0b3IKLy8KLy8gQW4gZWRpdGFibGUgYXJlYSB3aXRoIGEgdG9vbGJhcjogdGV4dCBzdHlsZSAobm9ybWFsLCB0aHJlZSBoZWFkaW5ncyksCi8v",
"IGJvbGQsIGl0YWxpYywgc3RyaWtlLXRocm91Z2gsIGJ1bGxldGVkLCBudW1iZXJlZCBhbmQgY2hlY2sgbGlzdHMgd2l0aAovLyB0aHJlZSBsZXZlbHMgb2YgbmVzdGluZywgdGFibGVzLCBsaW5rcywgYW5kIGNsZWFyIGZvcm1hdHRpbmcuCi8vCi8vIFRoZSBlZGl0YWJsZSBhcmVhIGlzIGEgZmxhdCBjb2x1bW4gb2YgYmxvY2tzIC0gb25lIDxkaXYgY2xhc3M9ImJsayI-Ci8vIHBlciBwYXJhZ3JhcGgsIGhlYWRpbmcgb3IgbGlzdCBpdGVtLCBpdHMga2luZCBhbmQgaW5kZW50IGluIGRhdGEKLy8gYXR0cmlidXRlcywgYnVsbGV0cywgbnVtYmVycyBhbmQgYm94ZXMgZHJhd24gYnkgdGhlIHN0eWxlc2hlZXQuIEJvbGQsCi8vIGl0YWxpYywgc3RyaWtlLXRocm91Z2ggYW5kIGxpbmtzIHVzZSB0aGUgYnJvd3NlcidzIG93biBlZGl0aW5nCi8vIGNvbW1hbmRzLCB3aGljaCBoYW5kbGUgdGhlbSB3ZWxsLiBMaXN0cyBhbmQgaGVhZGluZ3MgZG8gbm90IHVzZSB0aGVtOgovLyB0aGUgYnJvd3NlcidzIGxpc3QgY29tbWFuZHMgbmVzdCBlbGVtZW50cyBpbiB3YXlzIHRoYXQgYXJlIGhhcmQgdG8gcmVhZAovLyBiYWNrLCBzbyBibG9ja3MgYXJlIHJlc3R5bGVkIGhlcmUgZGlyZWN0bHkgaW5zdGVhZC4gV2hhdCBpcyBzYXZlZCBpcwovLyBuZXZlciB0aGlzIG1hcmt1cDogaXQgaXMgcmVhZCBiYWNrIGludG8gdGhlIG5vdGUtZm9ybWF0IG1vZGVsLCB3aGljaAovLyBvbmx5IGtub3dzIHdoYXQgdGhlIHRvb2xiYXIgY2FuIG1ha2Uu",
"Ci8vCi8vIFBhc3RlZCB0ZXh0IGtlZXBzIHRoZSBmb3JtYXR0aW5nIHRoZSBtb2RlbCBjYW4gaG9sZCAtIGZyb20gV29yZCwgR29vZ2xlCi8vIERvY3MsIGEgd2ViIHBhZ2UsIGFuIGVtYWlsLCBFeGNlbCwgb3IgTWFya2Rvd24gZnJvbSBhIGNoYXQgYXNzaXN0YW50IC0KLy8gcmVhZCBieSBub3RlLWZvcm1hdCdzIG93biByZWFkZXIsIHNvIGEgcGFnZSBjb3BpZWQgZnJvbSB0aGUgd2ViIGJyaW5ncwovLyBpdHMgYm9sZCBhbmQgbGlzdHMgYnV0IG5ldmVyIGl0cyBzdHlsZXMsIGltYWdlcyBvciBzY3JpcHRzLiBDdHJsK1NoaWZ0K1YKLy8gcGFzdGVzIHRoZSB0ZXh0IGFsb25lLiBEcm9wcGVkIHRleHQgaXMgbm90IHRha2VuIGF0IGFsbC4KLy8KLy8gQSB0YWJsZSBpcyBhbiBpc2xhbmQgdGhlIHRleHQgY2Fubm90IHJ1biBpbnRvOiBpdHMgYmxvY2sgaXMgbm90Ci8vIGVkaXRhYmxlLCBlYWNoIG9mIGl0cyBjZWxscyBpcywgb24gaXRzIG93biwgc28gdHlwaW5nLCBkZWxldGluZyBhbmQKLy8gcGFzdGluZyBjYW4gbmV2ZXIgYnJlYWsgdGhlIGdyaWQuIFRhYiBtb3ZlcyBmcm9tIGNlbGwgdG8gY2VsbCAoYW5kCi8vIGFkZHMgYSByb3cgYXQgdGhlIGVuZCksIHRoZSBhcnJvdyBrZXlzIGxlYXZlIGEgY2VsbCBhdCBpdHMgZWRnZXMsIGFuZAovLyB0aGUgdGFibGUgYmFyIC0gc2hvd24gd2hpbGUgdGhlIGN1cnNvciBpcyBpbiBhIGNlbGwgLSBhZGRzLCByZW1vdmVzLAovLyBhbGlnbnMgYW5kIHNvcnRzLiBDZWxscyBjb3Bp",
"ZWQgZnJvbSBhIHNwcmVhZHNoZWV0IGFuZCBwYXN0ZWQgaW50byBhCi8vIGNlbGwgZmlsbCB0aGUgY2VsbHMgZnJvbSB0aGVyZSwgYXMgaW4gYSBzcHJlYWRzaGVldC4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLCBvcGVuTWVudSwgY2xvc2VNZW51IH0gPSBucy51aTsKICBjb25zdCBmbXQgPSBucy5ub3RlRm9ybWF0OwogIGNvbnN0IE5FV19UQUJMRSA9IHsgY29sczogMywgcm93czogMyB9OwoKICBjb25zdCBTVFlMRVMgPSBbWydwJywgJ05vcm1hbCB0ZXh0J10sIFsnaDEnLCAnSGVhZGluZyAxJ10sIFsnaDInLCAnSGVhZGluZyAyJ10sIFsnaDMnLCAnSGVhZGluZyAzJ11dOwogIGNvbnN0IFNUWUxFX0xBQkVMID0gT2JqZWN0LmZyb21FbnRyaWVzKFNUWUxFUyk7CiAgY29uc3QgSU5ERU5UX1BYID0gMjQ7CgogIC8vIFR5cGVkIGF0IHRoZSBzdGFydCBvZiBhIHBhcmFncmFwaCBhbmQgZm9sbG93ZWQgYnkg",
"YSBzcGFjZSwgdGhlc2UgdHVybgogIC8vIGl0IGludG8gYSBsaXN0IG9yIGhlYWRpbmcgLSB0aGUgc2hvcnRjdXRzIG1vc3QgZWRpdG9ycyBzaGFyZS4KICBjb25zdCBBVVRPID0gWwogICAgWy9eWy0q4oCiXSQvLCB7IHR5cGU6ICd1bCcgfV0sCiAgICBbL14xWy4pXSQvLCB7IHR5cGU6ICdvbCcgfV0sCiAgICBbL15cWyA_XF0kLywgeyB0eXBlOiAnY2hlY2snIH1dLAogICAgWy9eXFtbeFhdXF0kLywgeyB0eXBlOiAnY2hlY2snLCBjaGVja2VkOiB0cnVlIH1dLAogICAgWy9eIyQvLCB7IHR5cGU6ICdoMScgfV0sCiAgICBbL14jIyQvLCB7IHR5cGU6ICdoMicgfV0sCiAgICBbL14jIyMkLywgeyB0eXBlOiAnaDMnIH1dLAogIF07CgogIC8vIOKUgOKUgCBNb2RlbCDihpQgbWFya3VwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBzZXRCbG9jayhlbCwgdHlwZSwgbGV2ZWwgPSAwLCBjaGVja2VkID0gZmFsc2UpIHsKICAgIGVsLmRhdGFzZXQudHlwZSA9IHR5cGU7CiAgICBpZiAoZm10LkxJU1RTLmhhcyh0eXBlKSkgZWwuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsZXZlbCk7CiAgICBlbHNlIGRlbGV0ZSBlbC5kYXRhc2V0LmxldmVsOwogICAgaWYgKHR5cGUgPT09ICdjaGVj",
"aycpIGVsLmRhdGFzZXQuY2hlY2tlZCA9IGNoZWNrZWQgPyAnMScgOiAnMCc7CiAgICBlbHNlIGRlbGV0ZSBlbC5kYXRhc2V0LmNoZWNrZWQ7CiAgfQoKICBmdW5jdGlvbiBpbmxpbmVOb2RlcyhydW5zKSB7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcnVucy5sZW5ndGg7KSB7CiAgICAgIGNvbnN0IGhyZWYgPSBydW5zW2ldLmhyZWYgfHwgJyc7CiAgICAgIGNvbnN0IGdyb3VwID0gW107CiAgICAgIGxldCBqID0gaTsKICAgICAgd2hpbGUgKGogPCBydW5zLmxlbmd0aCAmJiAocnVuc1tqXS5ocmVmIHx8ICcnKSA9PT0gaHJlZikgewogICAgICAgIGxldCBub2RlID0gZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUocnVuc1tqXS50ZXh0KTsKICAgICAgICBmb3IgKGNvbnN0IG0gb2YgWydzJywgJ2knLCAnYiddKSB7CiAgICAgICAgICBpZiAoIXJ1bnNbal1bbV0pIGNvbnRpbnVlOwogICAgICAgICAgY29uc3QgdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQobSk7CiAgICAgICAgICB3LmFwcGVuZENoaWxkKG5vZGUpOwogICAgICAgICAgbm9kZSA9IHc7CiAgICAgICAgfQogICAgICAgIGdyb3VwLnB1c2gobm9kZSk7CiAgICAgICAgaisrOwogICAgICB9CiAgICAgIGlmIChocmVmKSBvdXQucHVzaChoKCdhJywgeyBocmVmLCB0aXRsZTogaHJlZiB9LCBncm91cCkpOwogICAgICBlbHNlIG91dC5wdXNoKC4uLmdyb3VwKTsKICAgICAgaSA9IGo7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0K",
"CiAgLy8gTGluZSBicmVha3MgaW4gYSBjZWxsJ3MgdGV4dCBhcyA8YnI-czsgYSBjZWxsIGVuZGluZyBpbiBvbmUgZ2V0cyBhCiAgLy8gc2Vjb25kLCBvciB0aGUgYnJvd3NlciB3b3VsZCBub3Qgc2hvdyB0aGUgZW1wdHkgbGluZS4KICBmdW5jdGlvbiBicmVha0xpbmVzKGVsKSB7CiAgICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKGVsLCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7CiAgICBjb25zdCBmb3VuZCA9IFtdOwogICAgZm9yIChsZXQgbiA9IHdhbGtlci5uZXh0Tm9kZSgpOyBuOyBuID0gd2Fsa2VyLm5leHROb2RlKCkpIGlmIChuLmRhdGEuaW5jbHVkZXMoJ1xuJykpIGZvdW5kLnB1c2gobik7CiAgICBmb3IgKGNvbnN0IG4gb2YgZm91bmQpIHsKICAgICAgY29uc3QgcGFydHMgPSBbXTsKICAgICAgbi5kYXRhLnNwbGl0KCdcbicpLmZvckVhY2goKHBpZWNlLCBpKSA9PiB7CiAgICAgICAgaWYgKGkpIHBhcnRzLnB1c2goZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnInKSk7CiAgICAgICAgaWYgKHBpZWNlKSBwYXJ0cy5wdXNoKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHBpZWNlKSk7CiAgICAgIH0pOwogICAgICBuLnJlcGxhY2VXaXRoKC4uLnBhcnRzKTsKICAgIH0KICAgIGlmIChlbC5sYXN0Q2hpbGQgJiYgZWwubGFzdENoaWxkLm5vZGVOYW1lID09PSAnQlInKSBlbC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdicicpKTsKICB9CgogIGZ1bmN0aW9uIGZpbGxD",
"ZWxsKHRkLCBydW5zKSB7CiAgICB0ZC5yZXBsYWNlQ2hpbGRyZW4oLi4uaW5saW5lTm9kZXMocnVucyB8fCBbXSkpOwogICAgYnJlYWtMaW5lcyh0ZCk7CiAgICBpZiAoIXRkLmZpcnN0Q2hpbGQpIHRkLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2JyJykpOwogIH0KCiAgZnVuY3Rpb24gY2VsbEVsKHJ1bnMsIGFsaWduKSB7CiAgICBjb25zdCB0ZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RkJyk7CiAgICB0ZC5jb250ZW50RWRpdGFibGUgPSAndHJ1ZSc7CiAgICBpZiAoYWxpZ24pIHRkLnN0eWxlLnRleHRBbGlnbiA9IGFsaWduOwogICAgZmlsbENlbGwodGQsIHJ1bnMpOwogICAgcmV0dXJuIHRkOwogIH0KCiAgZnVuY3Rpb24gdGFibGVFbChiKSB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgZWwuY2xhc3NOYW1lID0gJ2Jsayc7CiAgICBlbC5kYXRhc2V0LnR5cGUgPSAndGFibGUnOwogICAgZWwuZGF0YXNldC5oZWFkID0gYi5oZWFkID8gJzEnIDogJzAnOwogICAgZWwuZGF0YXNldC5hbGlnbiA9IGIuYWxpZ24uam9pbignLCcpOwogICAgZWwuY29udGVudEVkaXRhYmxlID0gJ2ZhbHNlJzsKICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd0Ym9keScpOwogICAgZm9yIChjb25zdCByIG9mIGIucm93cykgewogICAgICBjb25zdCB0ciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RyJyk7CiAgICAgIHIuZm9yRWFjaCgo",
"YywgaykgPT4gdHIuYXBwZW5kQ2hpbGQoY2VsbEVsKGMucnVucywgYi5hbGlnbltrXSkpKTsKICAgICAgYm9keS5hcHBlbmRDaGlsZCh0cik7CiAgICB9CiAgICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGFibGUnKTsKICAgIHQuYXBwZW5kQ2hpbGQoYm9keSk7CiAgICBlbC5hcHBlbmRDaGlsZCh0KTsKICAgIHJldHVybiBlbDsKICB9CgogIGZ1bmN0aW9uIGJsb2NrRWwoYikgewogICAgaWYgKGIudHlwZSA9PT0gJ3RhYmxlJykgcmV0dXJuIHRhYmxlRWwoYik7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgZWwuY2xhc3NOYW1lID0gJ2Jsayc7CiAgICBzZXRCbG9jayhlbCwgYi50eXBlLCBiLmxldmVsLCBiLmNoZWNrZWQpOwogICAgY29uc3Qga2lkcyA9IGlubGluZU5vZGVzKGIucnVucyk7CiAgICBpZiAoa2lkcy5sZW5ndGgpIGVsLmFwcGVuZCguLi5raWRzKTsKICAgIGVsc2UgZWwuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnInKSk7CiAgICByZXR1cm4gZWw7CiAgfQoKICBmdW5jdGlvbiBzdHlsZU1hcmtzKHN0eWxlKSB7CiAgICBjb25zdCBzID0gU3RyaW5nKHN0eWxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpOwogICAgcmV0dXJuIHsKICAgICAgYjogL2ZvbnQtd2VpZ2h0XHMqOlxzKihib2xkfGJvbGRlcnxbNi05XTAwKS8udGVzdChzKSwKICAgICAgaTogL2ZvbnQtc3R5bGVccyo6XHMqaXRhbGljLy50ZXN0KHMpLAogICAgICBz",
"OiAvdGV4dC1kZWNvcmF0aW9uKC1saW5lKT9ccyo6W147XSpsaW5lLXRocm91Z2gvLnRlc3QocyksCiAgICB9OwogIH0KCiAgY29uc3QgTkVTVEVEX0JMT0NLUyA9IG5ldyBTZXQoWydkaXYnLCAncCcsICdsaScsICd1bCcsICdvbCcsICdoMScsICdoMicsICdoMycsICdoNCcsICdoNScsICdoNicsICdibG9ja3F1b3RlJywgJ3ByZSddKTsKCiAgLy8gVGhlIG1hcmtzIGluc2lkZSBhbiBlbGVtZW50OiB0aG9zZSBhcm91bmQgaXQsIGFuZCBpdHMgb3duLgogIGZ1bmN0aW9uIG1hcmtzT2YoZWwsIHRhZywgbWFya3MpIHsKICAgIGNvbnN0IG0gPSB7IC4uLm1hcmtzIH07CiAgICBpZiAodGFnID09PSAnYicgfHwgdGFnID09PSAnc3Ryb25nJykgbS5iID0gdHJ1ZTsKICAgIGVsc2UgaWYgKHRhZyA9PT0gJ2knIHx8IHRhZyA9PT0gJ2VtJykgbS5pID0gdHJ1ZTsKICAgIGVsc2UgaWYgKHRhZyA9PT0gJ3MnIHx8IHRhZyA9PT0gJ3N0cmlrZScgfHwgdGFnID09PSAnZGVsJykgbS5zID0gdHJ1ZTsKICAgIGVsc2UgaWYgKHRhZyA9PT0gJ2EnKSB7CiAgICAgIGNvbnN0IGhyZWYgPSBmbXQuc2FmZUhyZWYoZWwuZ2V0QXR0cmlidXRlKCdocmVmJykpOwogICAgICBpZiAoaHJlZikgbS5ocmVmID0gaHJlZjsKICAgIH0gZWxzZSBpZiAodGFnID09PSAnc3BhbicgfHwgdGFnID09PSAnZm9udCcpIHsKICAgICAgY29uc3Qgc3QgPSBzdHlsZU1hcmtzKGVsLmdldEF0dHJpYnV0ZSgnc3R5bGUnKSk7CiAgICAgIGlmIChzdC5iKSBtLmIgPSB0",
"cnVlOwogICAgICBpZiAoc3QuaSkgbS5pID0gdHJ1ZTsKICAgICAgaWYgKHN0LnMpIG0ucyA9IHRydWU7CiAgICB9CiAgICByZXR1cm4gbTsKICB9CgogIC8vIEEgY2VsbCdzIHJ1bnM6IGEgPGJyPiwgb3IgdGhlIHN0YXJ0IG9mIGEgYmxvY2sgdGhlIGJyb3dzZXIgcHV0IGluIGl0LAogIC8vIGlzIGEgbGluZSBicmVhazsgdGhlIG9uZXMgaXQgZW5kcyB3aXRoIGFyZSBpdHMgcGxhY2Vob2xkZXJzLgogIGZ1bmN0aW9uIHJlYWRDZWxsKHRkKSB7CiAgICBjb25zdCBydW5zID0gW107CiAgICBjb25zdCBubCA9ICgpID0-IHsgaWYgKHJ1bnMubGVuZ3RoICYmICEvXG4kLy50ZXN0KHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0KSkgcnVucy5wdXNoKHsgdGV4dDogJ1xuJyB9KTsgfTsKICAgIChmdW5jdGlvbiB3YWxrKG5vZGUsIG1hcmtzKSB7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZE5vZGVzKSB7CiAgICAgICAgLy8gVGhlIGVkaXRvciBrZWVwcyBzcGFjZXMgYW5kIGxpbmUgYnJlYWtzIGFzIHR5cGVkIChwcmUtd3JhcCksIHNvCiAgICAgICAgLy8gQ2hyb21lIHdyaXRlcyBFbnRlciBpbiBhIGNlbGwgYXMgYSBsaW5lIGJyZWFrIGluIHRoZSB0ZXh0IGl0c2VsZi4KICAgICAgICBpZiAoY2hpbGQubm9kZVR5cGUgPT09IDMpIHsKICAgICAgICAgIGlmIChjaGlsZC5kYXRhKSBydW5zLnB1c2goeyB0ZXh0OiBjaGlsZC5kYXRhLnJlcGxhY2UoL1x1MDBhMC9nLCAnICcpLCAuLi5tYXJrcyB9KTsKICAg",
"ICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICBpZiAoY2hpbGQubm9kZVR5cGUgIT09IDEpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IHRhZyA9IGNoaWxkLnRhZ05hbWUudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAodGFnID09PSAnYnInKSB7IHJ1bnMucHVzaCh7IHRleHQ6ICdcbicgfSk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKE5FU1RFRF9CTE9DS1MuaGFzKHRhZykpIHsgbmwoKTsgd2FsayhjaGlsZCwgbWFya3MpOyBubCgpOyBjb250aW51ZTsgfQogICAgICAgIHdhbGsoY2hpbGQsIG1hcmtzT2YoY2hpbGQsIHRhZywgbWFya3MpKTsKICAgICAgfQogICAgfSkodGQsIHt9KTsKICAgIHdoaWxlIChydW5zLmxlbmd0aCAmJiAvXG4kLy50ZXN0KHJ1bnNbcnVucy5sZW5ndGggLSAxXS50ZXh0KSkgewogICAgICBjb25zdCBsYXN0ID0gcnVuc1tydW5zLmxlbmd0aCAtIDFdOwogICAgICBsYXN0LnRleHQgPSBsYXN0LnRleHQucmVwbGFjZSgvXG4kLywgJycpOwogICAgICBpZiAoIWxhc3QudGV4dCkgcnVucy5wb3AoKTsKICAgIH0KICAgIHJldHVybiBydW5zOwogIH0KCiAgZnVuY3Rpb24gcmVhZFRhYmxlKGVsKSB7CiAgICBjb25zdCB0ID0gZWwucXVlcnlTZWxlY3RvcigndGFibGUnKTsKICAgIGNvbnN0IHJvd3MgPSB0ID8gWy4uLnQucm93c10ubWFwKHRyID0-IFsuLi50ci5jZWxsc10ubWFwKHRkID0-ICh7IHJ1bnM6IHJlYWRDZWxsKHRkKSB9KSkpIDogW107CiAgICByZXR1cm4gZm10LnRhYmxl",
"KHJvd3MsIHsgaGVhZDogZWwuZGF0YXNldC5oZWFkID09PSAnMScsIGFsaWduOiBTdHJpbmcoZWwuZGF0YXNldC5hbGlnbiB8fCAnJykuc3BsaXQoJywnKSB9KTsKICB9CgogIC8vIFJlYWRzIG9uZSBibG9jayBlbGVtZW50IC0gYW5kIGFueXRoaW5nIHRoZSBicm93c2VyIG1heSBoYXZlIGxlZnQKICAvLyBpbnNpZGUgaXQsIHN1Y2ggYXMgYSA8YnI-IG9yIGEgbmVzdGVkIDxkaXY-IC0gaW50byBtb2RlbCBibG9ja3MuCiAgZnVuY3Rpb24gcmVhZEJsb2NrKGVsLCBvdXQpIHsKICAgIGNvbnN0IHR5cGUgPSBmbXQuVFlQRVMuaGFzKGVsLmRhdGFzZXQudHlwZSkgPyBlbC5kYXRhc2V0LnR5cGUgOiAncCc7CiAgICBjb25zdCBsZXZlbCA9IE51bWJlcihlbC5kYXRhc2V0LmxldmVsKSB8fCAwOwogICAgY29uc3QgZmlyc3QgPSBvdXQubGVuZ3RoOwogICAgbGV0IGN1ciA9IGZtdC5ibG9jayh0eXBlLCBbXSwgeyBsZXZlbCwgY2hlY2tlZDogZWwuZGF0YXNldC5jaGVja2VkID09PSAnMScgfSk7CiAgICBvdXQucHVzaChjdXIpOwogICAgY29uc3QgbmV4dCA9ICgpID0-IHsKICAgICAgY3VyID0gZm10LmJsb2NrKHR5cGUsIFtdLCB7IGxldmVsIH0pOwogICAgICBvdXQucHVzaChjdXIpOwogICAgfTsKICAgIChmdW5jdGlvbiB3YWxrKG5vZGUsIG1hcmtzKSB7CiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZE5vZGVzKSB7CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlID09PSAzKSB7CiAgICAgICAgICBpZiAo",
"Y2hpbGQuZGF0YSkgY3VyLnJ1bnMucHVzaCh7IHRleHQ6IGNoaWxkLmRhdGEucmVwbGFjZSgvXHUwMGEwL2csICcgJykucmVwbGFjZSgvXG4vZywgJyAnKSwgLi4ubWFya3MgfSk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlICE9PSAxKSBjb250aW51ZTsKICAgICAgICBjb25zdCB0YWcgPSBjaGlsZC50YWdOYW1lLnRvTG93ZXJDYXNlKCk7CiAgICAgICAgaWYgKHRhZyA9PT0gJ2JyJykgeyBuZXh0KCk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKE5FU1RFRF9CTE9DS1MuaGFzKHRhZykpIHsKICAgICAgICAgIGlmIChjdXIucnVucy5sZW5ndGgpIG5leHQoKTsKICAgICAgICAgIHdhbGsoY2hpbGQsIG1hcmtzKTsKICAgICAgICAgIG5leHQoKTsKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICB3YWxrKGNoaWxkLCBtYXJrc09mKGNoaWxkLCB0YWcsIG1hcmtzKSk7CiAgICAgIH0KICAgIH0pKGVsLCB7fSk7CiAgICAvLyBBIDxicj4gb3IgbmVzdGVkIGJsb2NrIGF0IHRoZSB2ZXJ5IGVuZCBsZWF2ZXMgYW4gZW1wdHkgYmxvY2sgYmVoaW5kOgogICAgLy8gdGhhdCBpcyB0aGUgYnJvd3NlcidzIHBsYWNlaG9sZGVyLCBub3QgYSBuZXcgbGluZS4KICAgIHdoaWxlIChvdXQubGVuZ3RoIC0gMSA-IGZpcnN0ICYmICFvdXRbb3V0Lmxlbmd0aCAtIDFdLnJ1bnMuc29tZShyID0-IHIudGV4dCkpIG91dC5wb3AoKTsKICB9CgogIGZ1bmN0aW9uIHJlYWRE",
"b2MoZWRpdG9yKSB7CiAgICBjb25zdCBibG9ja3MgPSBbXTsKICAgIGZvciAoY29uc3Qgbm9kZSBvZiBlZGl0b3IuY2hpbGROb2RlcykgewogICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiBub2RlLmRhdGFzZXQudHlwZSA9PT0gJ3RhYmxlJykgYmxvY2tzLnB1c2gocmVhZFRhYmxlKG5vZGUpKTsKICAgICAgZWxzZSBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiBub2RlLmNsYXNzTGlzdC5jb250YWlucygnYmxrJykpIHJlYWRCbG9jayhub2RlLCBibG9ja3MpOwogICAgICBlbHNlIGlmIChub2RlLm5vZGVUeXBlID09PSAzICYmIG5vZGUuZGF0YS50cmltKCkpIGJsb2Nrcy5wdXNoKGZtdC5ibG9jaygncCcsIFt7IHRleHQ6IG5vZGUuZGF0YS5yZXBsYWNlKC_CoC9nLCAnICcpIH1dKSk7CiAgICAgIGVsc2UgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS50YWdOYW1lICE9PSAnQlInKSByZWFkQmxvY2sobm9kZSwgYmxvY2tzKTsKICAgIH0KICAgIHJldHVybiBmbXQubm9ybWFsaXNlRG9jKGJsb2Nrcyk7CiAgfQoKICAvLyDilIDilIAgU2VsZWN0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBjcmVhdGUoeyByb290LCBv",
"bkNoYW5nZSB9KSB7CiAgICBjb25zdCBlbHMgPSB7fTsKICAgIGxldCBzYXZlZCA9IG51bGw7ICAgICAvLyB0aGUgbGFzdCBzZWxlY3Rpb24gaW5zaWRlIHRoZSBlZGl0b3IKICAgIGxldCBlZGl0YWJsZSA9IGZhbHNlOwogICAgbGV0IHBsYWluTmV4dCA9IGZhbHNlOyAvLyBDdHJsK1NoaWZ0K1Y6IHRoZSBuZXh0IHBhc3RlIGlzIHRleHQgYWxvbmUKICAgIGxldCBwYXN0ZVVuZG8gPSBbXTsgICAgLy8gaG93IHRoZSB0ZXh0IHdhcyBiZWZvcmUgZWFjaCBmb3JtYXR0ZWQgcGFzdGUsIGxhdGVzdCBsYXN0CgogICAgY29uc3Qgc2VsZWN0aW9uID0gKCkgPT4gKHJvb3QuZ2V0U2VsZWN0aW9uID8gcm9vdC5nZXRTZWxlY3Rpb24oKSA6IGRvY3VtZW50LmdldFNlbGVjdGlvbigpKTsKCiAgICBmdW5jdGlvbiByYW5nZSgpIHsKICAgICAgY29uc3Qgc2VsID0gc2VsZWN0aW9uKCk7CiAgICAgIGlmICghc2VsIHx8ICFzZWwucmFuZ2VDb3VudCkgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHIgPSBzZWwuZ2V0UmFuZ2VBdCgwKTsKICAgICAgcmV0dXJuIGVscy5lZGl0b3IuY29udGFpbnMoci5zdGFydENvbnRhaW5lcikgJiYgZWxzLmVkaXRvci5jb250YWlucyhyLmVuZENvbnRhaW5lcikgPyByIDogbnVsbDsKICAgIH0KCiAgICBmdW5jdGlvbiBzZWxlY3QocikgewogICAgICBjb25zdCBzZWwgPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7CiAgICAgIHNlbC5yZW1vdmVBbGxSYW5nZXMoKTsKICAgICAgc2VsLmFkZFJhbmdlKHIpOwog",
"ICAgfQoKICAgIC8vIFRvb2xiYXIgYnV0dG9ucyBkbyBub3QgdGFrZSBmb2N1cyBmcm9tIHRoZSB0ZXh0LCBidXQgdGhlIHN0eWxlIG1lbnUKICAgIC8vIGFuZCB0aGUgbGluayBmaWVsZCBkbzsgdGhlIHNlbGVjdGlvbiB0aGV5IHdlcmUgb3BlbmVkIG9uIGlzIHB1dAogICAgLy8gYmFjayBiZWZvcmUgdGhlIGNoYW5nZSBpcyBhcHBsaWVkLgogICAgZnVuY3Rpb24gcmVzdG9yZSgpIHsKICAgICAgLy8gVGhlIHNlbGVjdGlvbiBjYW4gc3RpbGwgYmUgaW4gdGhlIHRleHQgd2hpbGUgdGhlIGZvY3VzIGlzIG5vdCAtCiAgICAgIC8vIG9uIHRoZSBzdHlsZSBidXR0b24gdGhlIG1lbnUgaGFuZGVkIGl0IGJhY2sgdG8sIHNheSAtIGFuZCB0eXBpbmcKICAgICAgLy8gd291bGQgdGhlbiBnbyBub3doZXJlLiBCb3RoIGFyZSBwdXQgYmFjay4KICAgICAgY29uc3Qga2VlcCA9IHJhbmdlKCkgfHwgKHNhdmVkICYmIGVscy5lZGl0b3IuY29udGFpbnMoc2F2ZWQuc3RhcnRDb250YWluZXIpID8gc2F2ZWQgOiBudWxsKTsKICAgICAgLy8gSW4gYSB0YWJsZSwgdGhlIGNlbGwgaXMgd2hhdCB0YWtlcyB0eXBpbmcuCiAgICAgIGNvbnN0IGhvc3QgPSAoa2VlcCAmJiBjZWxsT2Yoa2VlcC5zdGFydENvbnRhaW5lcikpIHx8IGVscy5lZGl0b3I7CiAgICAgIGlmIChyb290LmFjdGl2ZUVsZW1lbnQgIT09IGhvc3QpIGhvc3QuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICBpZiAoa2VlcCkgewogICAgICAgIHRyeSB7IHNl",
"bGVjdChrZWVwLmNsb25lUmFuZ2UgPyBrZWVwLmNsb25lUmFuZ2UoKSA6IGtlZXApOyB9IGNhdGNoIHsgLyogdGhlIHRleHQgY2hhbmdlZCB1bmRlcm5lYXRoICovIH0KICAgICAgfQogICAgfQoKICAgIGZ1bmN0aW9uIGJsb2NrT2Yobm9kZSkgewogICAgICBsZXQgbiA9IG5vZGU7CiAgICAgIGlmIChuID09PSBlbHMuZWRpdG9yKSByZXR1cm4gbnVsbDsKICAgICAgd2hpbGUgKG4gJiYgbi5wYXJlbnROb2RlICE9PSBlbHMuZWRpdG9yKSBuID0gbi5wYXJlbnROb2RlOwogICAgICByZXR1cm4gbiAmJiBuLm5vZGVUeXBlID09PSAxID8gbiA6IG51bGw7CiAgICB9CgogICAgLy8g4pSA4pSAIFRhYmxlIGNlbGxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAgIGZ1bmN0aW9uIGNlbGxPZihub2RlKSB7CiAgICAgIGZvciAobGV0IG4gPSBub2RlOyBuICYmIG4gIT09IGVscy5lZGl0b3I7IG4gPSBuLnBhcmVudE5vZGUpIHsKICAgICAgICBpZiAobi5ub2RlVHlwZSA9PT0gMSAmJiBuLnRhZ05hbWUgPT09ICdURCcpIHJldHVybiBuOwogICAgICB9CiAgICAgIHJldHVybiBudWxsOwogICAgfQogICAgY29uc3QgdGFibGVPZiA9IHRkID0-IHRkLmNsb3Nlc3QoJy5ibGtbZGF0YS10eXBlPSJ0",
"YWJsZSJdJyk7CiAgICBjb25zdCBhbGlnbnMgPSBlbCA9PiB7CiAgICAgIGNvbnN0IGNvbHMgPSBlbC5xdWVyeVNlbGVjdG9yKCd0cicpID8gZWwucXVlcnlTZWxlY3RvcigndHInKS5jZWxscy5sZW5ndGggOiAwOwogICAgICBjb25zdCBhID0gU3RyaW5nKGVsLmRhdGFzZXQuYWxpZ24gfHwgJycpLnNwbGl0KCcsJyk7CiAgICAgIHJldHVybiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBjb2xzIH0sIChfLCBrKSA9PiBhW2tdIHx8ICcnKTsKICAgIH07CiAgICBsZXQgbGFzdENlbGwgPSBudWxsOyAvLyB0aGUgY2VsbCBsYXN0IHR5cGVkIGluLCBmb3IgdGhlIHRhYmxlIGJhcidzIG1lbnVzCgogICAgLy8gVGhlIGN1cnNvciBpbnRvIGFuIGVsZW1lbnQ6IGl0cyBzdGFydCwgb3IgaXRzIGVuZCAtIGJlZm9yZSB0aGUgPGJyPgogICAgLy8gdGhhdCBvbmx5IGhvbGRzIGFuIGVtcHR5IGxpbmUgb3Blbi4KICAgIGZ1bmN0aW9uIGNhcmV0SW50byhlbCwgYXRFbmQpIHsKICAgICAgY29uc3QgciA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIGNvbnN0IGtpZHMgPSBlbC5jaGlsZE5vZGVzOwogICAgICBpZiAoIWF0RW5kIHx8ICFraWRzLmxlbmd0aCkgci5zZXRTdGFydChlbCwgMCk7CiAgICAgIGVsc2UgaWYgKGtpZHNba2lkcy5sZW5ndGggLSAxXS5ub2RlTmFtZSA9PT0gJ0JSJykgci5zZXRTdGFydChlbCwga2lkcy5sZW5ndGggLSAxKTsKICAgICAgZWxzZSB7IHIuc2VsZWN0Tm9kZUNvbnRlbnRzKGVsKTsgci5jb2xsYXBz",
"ZShmYWxzZSk7IH0KICAgICAgci5jb2xsYXBzZSh0cnVlKTsKICAgICAgc2VsZWN0KHIpOwogICAgfQoKICAgIGZ1bmN0aW9uIGZvY3VzQ2VsbCh0ZCwgYXRFbmQgPSBmYWxzZSkgewogICAgICBpZiAoIXRkKSByZXR1cm47CiAgICAgIHRkLmZvY3VzKHsgcHJldmVudFNjcm9sbDogdHJ1ZSB9KTsKICAgICAgY2FyZXRJbnRvKHRkLCBhdEVuZCk7CiAgICAgIGxhc3RDZWxsID0gdGQ7CiAgICAgIHRkLnNjcm9sbEludG9WaWV3KHsgYmxvY2s6ICduZWFyZXN0JywgaW5saW5lOiAnbmVhcmVzdCcgfSk7CiAgICB9CgogICAgLy8gT3V0IG9mIGEgdGFibGUsIGFib3ZlIG9yIGJlbG93IGl0OiB0byB0aGUgYmxvY2sgdGhlcmUsIG9yIGEgbmV3CiAgICAvLyBlbXB0eSBsaW5lIGlmIHRoZXJlIGlzIG5vbmUgKG9yIG9ubHkgYW5vdGhlciB0YWJsZSkuCiAgICBmdW5jdGlvbiBsZWF2ZVRhYmxlKGVsLCBiZWxvdykgewogICAgICBsZXQgdGFyZ2V0ID0gYmVsb3cgPyBlbC5uZXh0RWxlbWVudFNpYmxpbmcgOiBlbC5wcmV2aW91c0VsZW1lbnRTaWJsaW5nOwogICAgICBpZiAoIXRhcmdldCB8fCB0YXJnZXQuZGF0YXNldC50eXBlID09PSAndGFibGUnKSB7CiAgICAgICAgdGFyZ2V0ID0gYmxvY2tFbChmbXQuYmxvY2soJ3AnKSk7CiAgICAgICAgaWYgKGJlbG93KSBlbC5hZnRlcih0YXJnZXQpOyBlbHNlIGVsLmJlZm9yZSh0YXJnZXQpOwogICAgICAgIGNoYW5nZWQoKTsKICAgICAgfQogICAgICBlbHMuZWRpdG9yLmZvY3VzKHsgcHJl",
"dmVudFNjcm9sbDogdHJ1ZSB9KTsKICAgICAgY2FyZXRJbnRvKHRhcmdldCwgIWJlbG93KTsKICAgIH0KCiAgICAvLyBXaGV0aGVyIHRoZSBjdXJzb3IgaXMgb24gdGhlIGZpcnN0IChvciBsYXN0KSBsaW5lIG9mIGFuIGVsZW1lbnQ6CiAgICAvLyBpdHMgYm94IGFnYWluc3QgdGhlIGVsZW1lbnQncyBmaXJzdCAob3IgbGFzdCkgcG9zaXRpb24uCiAgICBmdW5jdGlvbiBvbkVkZ2VMaW5lKGVsLCByLCBsYXN0KSB7CiAgICAgIGNvbnN0IGF0ID0gci5nZXRDbGllbnRSZWN0cygpWzBdOwogICAgICBpZiAoIWF0KSByZXR1cm4gdHJ1ZTsKICAgICAgY29uc3QgcHJvYmUgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcm9iZS5zZWxlY3ROb2RlQ29udGVudHMoZWwpOwogICAgICBwcm9iZS5jb2xsYXBzZSghbGFzdCk7CiAgICAgIGNvbnN0IGVkZ2UgPSBwcm9iZS5nZXRDbGllbnRSZWN0cygpWzBdIHx8IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICByZXR1cm4gTWF0aC5hYnMoKGxhc3QgPyBhdC5ib3R0b20gLSBlZGdlLmJvdHRvbSA6IGF0LnRvcCAtIGVkZ2UudG9wKSkgPCBhdC5oZWlnaHQgLyAyICsgMTsKICAgIH0KCiAgICBmdW5jdGlvbiBjYXJldEF0RW5kKHIsIGVsKSB7CiAgICAgIGlmICghciB8fCAhci5jb2xsYXBzZWQpIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgcG9zdCA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIHBvc3Quc2VsZWN0Tm9kZUNvbnRlbnRzKGVsKTsKICAg",
"ICAgcG9zdC5zZXRTdGFydChyLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXQpOwogICAgICByZXR1cm4gcG9zdC50b1N0cmluZygpID09PSAnJzsKICAgIH0KCiAgICBmdW5jdGlvbiByYW5nZUJsb2NrcyhyKSB7CiAgICAgIGNvbnN0IGtpZHMgPSBbLi4uZWxzLmVkaXRvci5jaGlsZHJlbl07CiAgICAgIGNvbnN0IGVkZ2UgPSAoY29udGFpbmVyLCBvZmZzZXQsIGVuZCkgPT4gewogICAgICAgIGlmIChjb250YWluZXIgPT09IGVscy5lZGl0b3IpIHJldHVybiBraWRzW01hdGgubWluKGtpZHMubGVuZ3RoIC0gMSwgTWF0aC5tYXgoMCwgb2Zmc2V0IC0gKGVuZCA_IDEgOiAwKSkpXTsKICAgICAgICByZXR1cm4gYmxvY2tPZihjb250YWluZXIpOwogICAgICB9OwogICAgICBjb25zdCBhID0gZWRnZShyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0LCBmYWxzZSk7CiAgICAgIGNvbnN0IGIgPSBlZGdlKHIuZW5kQ29udGFpbmVyLCByLmVuZE9mZnNldCwgdHJ1ZSk7CiAgICAgIGNvbnN0IGkgPSBraWRzLmluZGV4T2YoYSk7CiAgICAgIGNvbnN0IGogPSBraWRzLmluZGV4T2YoYik7CiAgICAgIGlmIChpIDwgMCB8fCBqIDwgMCkgcmV0dXJuIGEgPyBbYV0gOiBbXTsKICAgICAgcmV0dXJuIGtpZHMuc2xpY2UoTWF0aC5taW4oaSwgaiksIE1hdGgubWF4KGksIGopICsgMSk7CiAgICB9CgogICAgZnVuY3Rpb24gY2FyZXRBdEJsb2NrU3RhcnQociwgYmxrKSB7CiAgICAgIGlmICghciB8fCAhci5jb2xsYXBzZWQgfHwgIWJs",
"aykgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCBwcmUgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICBwcmUuc2VsZWN0Tm9kZUNvbnRlbnRzKGJsayk7CiAgICAgIHByZS5zZXRFbmQoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCk7CiAgICAgIHJldHVybiBwcmUudG9TdHJpbmcoKSA9PT0gJyc7CiAgICB9CgogICAgZnVuY3Rpb24gcGxhY2VDYXJldChub2RlLCBvZmZzZXQpIHsKICAgICAgY29uc3QgciA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIHIuc2V0U3RhcnQobm9kZSwgb2Zmc2V0KTsKICAgICAgci5jb2xsYXBzZSh0cnVlKTsKICAgICAgc2VsZWN0KHIpOwogICAgfQoKICAgIC8vIOKUgOKUgCBLZWVwaW5nIHRoZSBtYXJrdXAgdGlkeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICAvLyBFYWNoIGxpc3QgaXRlbSBtYXkgYmUgYXQgbW9zdCBvbmUgbGV2ZWwgZGVlcGVyIHRoYW4gdGhlIG9uZSBhYm92ZS4KICAgIGZ1bmN0aW9uIGZpeExldmVscygpIHsKICAgICAgbGV0IHByZXYgPSAtMTsKICAgICAgZm9yIChjb25zdCBibGsgb2YgZWxzLmVkaXRvci5jaGlsZHJlbikgewogICAgICAgIGlmIChmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V0LnR5cGUpKSB7CiAgICAgICAgICBjb25zdCBsdmwg",
"PSBNYXRoLm1heCgwLCBNYXRoLm1pbihmbXQuTUFYX0xFVkVMLCBOdW1iZXIoYmxrLmRhdGFzZXQubGV2ZWwpIHx8IDAsIHByZXYgKyAxKSk7CiAgICAgICAgICBibGsuZGF0YXNldC5sZXZlbCA9IFN0cmluZyhsdmwpOwogICAgICAgICAgcHJldiA9IGx2bDsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgcHJldiA9IC0xOwogICAgICAgIH0KICAgICAgfQogICAgfQoKICAgIC8vIFRoZSBicm93c2VyIHNvbWV0aW1lcyBsZWF2ZXMgdGV4dCwgYSA8YnI-IG9yIGEgcGxhaW4gPGRpdj4gZGlyZWN0bHkKICAgIC8vIGluIHRoZSBlZGl0b3IgKGFmdGVyIHNlbGVjdC1hbGwgYW5kIGRlbGV0ZSwgc2F5KSwgYW5kIHdyYXBzIG1lcmdlZAogICAgLy8gdGV4dCBpbiA8c3BhbiBzdHlsZT0iZm9udC1zaXpl4oCmIj4gd2hlbiB0d28gYmxvY2tzIG9mIGRpZmZlcmVudCBzaXplcwogICAgLy8gam9pbi4gQm90aCBhcmUgcHV0IHJpZ2h0IGhlcmUsIGtlZXBpbmcgdGhlIGNhcmV0IHdoZXJlIGl0IHdhcy4KICAgIGZ1bmN0aW9uIHRpZHkoKSB7CiAgICAgIGNvbnN0IHNlbCA9IHNlbGVjdGlvbigpOwogICAgICBjb25zdCByID0gc2VsICYmIHNlbC5yYW5nZUNvdW50ID8gc2VsLmdldFJhbmdlQXQoMCkgOiBudWxsOwogICAgICBjb25zdCBrZWVwID0gciA_IFtyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0LCByLmVuZENvbnRhaW5lciwgci5lbmRPZmZzZXRdIDogbnVsbDsKICAgICAgbGV0IG1vdmVkID0gZmFsc2U7CgogICAg",
"ICBmb3IgKGNvbnN0IG5vZGUgb2YgWy4uLmVscy5lZGl0b3IuY2hpbGROb2Rlc10pIHsKICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMSAmJiBub2RlLmNsYXNzTGlzdC5jb250YWlucygnYmxrJykgJiYgbm9kZS5kYXRhc2V0LnR5cGUpIGNvbnRpbnVlOwogICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAxICYmIC9eKERJVnxQfEgxfEgyfEgzKSQvLnRlc3Qobm9kZS50YWdOYW1lKSkgewogICAgICAgICAgbm9kZS5jbGFzc0xpc3QuYWRkKCdibGsnKTsKICAgICAgICAgIHNldEJsb2NrKG5vZGUsIC9eSFsxMjNdJC8udGVzdChub2RlLnRhZ05hbWUpID8gbm9kZS50YWdOYW1lLnRvTG93ZXJDYXNlKCkgOiAncCcpOwogICAgICAgICAgY29udGludWU7CiAgICAgICAgfQogICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAzICYmICFub2RlLmRhdGEudHJpbSgpICYmICEoa2VlcCAmJiAoa2VlcFswXSA9PT0gbm9kZSB8fCBrZWVwWzJdID09PSBub2RlKSkpIHsKICAgICAgICAgIG5vZGUucmVtb3ZlKCk7CiAgICAgICAgICBjb250aW51ZTsKICAgICAgICB9CiAgICAgICAgY29uc3QgYmxrID0gYmxvY2tFbChmbXQuYmxvY2soJ3AnKSk7CiAgICAgICAgYmxrLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICAgIGVscy5lZGl0b3IuaW5zZXJ0QmVmb3JlKGJsaywgbm9kZSk7CiAgICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEgJiYgbm9kZS50YWdOYW1lID09PSAnQlInKSB7CiAgICAgICAgICBibGsuYXBwZW5k",
"Q2hpbGQobm9kZSk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIC8vIEdhdGhlciB0aGlzIGFuZCBhbnkgZm9sbG93aW5nIGlubGluZSBuZWlnaGJvdXJzIGludG8gb25lIGJsb2NrLgogICAgICAgICAgbGV0IG4gPSBub2RlOwogICAgICAgICAgd2hpbGUgKG4gJiYgIShuLm5vZGVUeXBlID09PSAxICYmIChuLmNsYXNzTGlzdC5jb250YWlucygnYmxrJykgfHwgTkVTVEVEX0JMT0NLUy5oYXMobi50YWdOYW1lLnRvTG93ZXJDYXNlKCkpKSkpIHsKICAgICAgICAgICAgY29uc3QgZm9sbG93aW5nID0gbi5uZXh0U2libGluZzsKICAgICAgICAgICAgYmxrLmFwcGVuZENoaWxkKG4pOwogICAgICAgICAgICBuID0gZm9sbG93aW5nOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgICBtb3ZlZCA9IHRydWU7CiAgICAgIH0KCiAgICAgIGZvciAoY29uc3Qgc3BhbiBvZiBbLi4uZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yQWxsKCdzcGFuW3N0eWxlXSwgZm9udCcpXSkgewogICAgICAgIGNvbnN0IHN0ID0gc3R5bGVNYXJrcyhzcGFuLmdldEF0dHJpYnV0ZSgnc3R5bGUnKSk7CiAgICAgICAgaWYgKHN0LmIgfHwgc3QuaSB8fCBzdC5zKSBjb250aW51ZTsKICAgICAgICBzcGFuLnJlcGxhY2VXaXRoKC4uLnNwYW4uY2hpbGROb2Rlcyk7CiAgICAgICAgbW92ZWQgPSB0cnVlOwogICAgICB9CiAgICAgIGZvciAoY29uc3QgYSBvZiBlbHMuZWRpdG9yLnF1ZXJ5U2VsZWN0b3JBbGwoJ2FbaHJlZl0nKSkgewogICAgICAgIGNvbnN0",
"IGhyZWYgPSBmbXQuc2FmZUhyZWYoYS5nZXRBdHRyaWJ1dGUoJ2hyZWYnKSk7CiAgICAgICAgaWYgKCFocmVmKSBhLnJlcGxhY2VXaXRoKC4uLmEuY2hpbGROb2Rlcyk7CiAgICAgICAgZWxzZSBpZiAoYS50aXRsZSAhPT0gaHJlZikgYS50aXRsZSA9IGhyZWY7CiAgICAgIH0KICAgICAgaWYgKCFlbHMuZWRpdG9yLmNoaWxkcmVuLmxlbmd0aCkgewogICAgICAgIGVscy5lZGl0b3IuYXBwZW5kQ2hpbGQoYmxvY2tFbChmbXQuYmxvY2soJ3AnKSkpOwogICAgICAgIHBsYWNlQ2FyZXQoZWxzLmVkaXRvci5maXJzdENoaWxkLCAwKTsKICAgICAgICBtb3ZlZCA9IGZhbHNlOwogICAgICB9CiAgICAgIC8vIFNvbWV3aGVyZSB0byB0eXBlIGFmdGVyIGEgdGFibGUgYXQgdGhlIGVuZC4KICAgICAgY29uc3QgbGFzdEJsayA9IGVscy5lZGl0b3IubGFzdEVsZW1lbnRDaGlsZDsKICAgICAgaWYgKGxhc3RCbGsgJiYgbGFzdEJsay5kYXRhc2V0LnR5cGUgPT09ICd0YWJsZScpIGVscy5lZGl0b3IuYXBwZW5kQ2hpbGQoYmxvY2tFbChmbXQuYmxvY2soJ3AnKSkpOwogICAgICBpZiAobW92ZWQgJiYga2VlcCAmJiBrZWVwWzBdLmlzQ29ubmVjdGVkICYmIGtlZXBbMl0uaXNDb25uZWN0ZWQpIHsKICAgICAgICB0cnkgewogICAgICAgICAgY29uc3QgYmFjayA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgICBiYWNrLnNldFN0YXJ0KGtlZXBbMF0sIGtlZXBbMV0pOwogICAgICAgICAgYmFjay5zZXRFbmQoa2VlcFsyXSwga2Vl",
"cFszXSk7CiAgICAgICAgICBzZWxlY3QoYmFjayk7CiAgICAgICAgfSBjYXRjaCB7IC8qIHBvc2l0aW9ucyBubyBsb25nZXIgdmFsaWQgKi8gfQogICAgICB9CiAgICAgIGZpeExldmVscygpOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIGZ1bmN0aW9uIHVwZGF0ZUVtcHR5KCkgewogICAgICBjb25zdCBraWRzID0gZWxzLmVkaXRvci5jaGlsZHJlbjsKICAgICAgY29uc3QgZW1wdHkgPSBraWRzLmxlbmd0aCA8PSAxICYmICgha2lkc1swXSB8fCAoa2lkc1swXS5kYXRhc2V0LnR5cGUgPT09ICdwJyAmJiAha2lkc1swXS50ZXh0Q29udGVudCkpOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQuZW1wdHkgPSBlbXB0eSA_ICcxJyA6ICcwJzsKICAgIH0KCiAgICBmdW5jdGlvbiBjaGFuZ2VkKCkgewogICAgICBwYXN0ZVVuZG8gPSBbXTsKICAgICAgdGlkeSgpOwogICAgICBvbkNoYW5nZSgpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIOKUgOKUgCBDb21tYW5kcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlvbiBpbmxpbmUoY21kKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgcmVzdG9y",
"ZSgpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZChjbWQpOwogICAgICByZWZyZXNoVG9vbGJhcigpOwogICAgfQoKICAgIC8vIEFwcGxpZXMgYSBibG9jayB0eXBlIHRvIGV2ZXJ5IGJsb2NrIHRoZSBzZWxlY3Rpb24gdG91Y2hlcyAtIG9yLCBpZgogICAgLy8gdGhleSBhbGwgaGF2ZSBpdCBhbHJlYWR5LCB0dXJucyB0aGVtIGJhY2sgaW50byBwYXJhZ3JhcGhzLgogICAgZnVuY3Rpb24gYmxvY2tUeXBlKHR5cGUsIHsgY2hlY2tlZCA9IGZhbHNlIH0gPSB7fSkgewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIHJlc3RvcmUoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghciB8fCBjZWxsT2Yoci5zdGFydENvbnRhaW5lcikpIHJldHVybjsgLy8gYSBjZWxsIGhvbGRzIHRleHQsIG5vdCBsaXN0cyBvciBoZWFkaW5ncwogICAgICBjb25zdCBibG9ja3MgPSByYW5nZUJsb2NrcyhyKTsKICAgICAgY29uc3Qgb2ZmID0gYmxvY2tzLmV2ZXJ5KGIgPT4gYi5kYXRhc2V0LnR5cGUgPT09IHR5cGUpICYmIHR5cGUgIT09ICdwJzsKICAgICAgZm9yIChjb25zdCBiIG9mIGJsb2NrcykgewogICAgICAgIGNvbnN0IHdhcyA9IGIuZGF0YXNldC50eXBlOwogICAgICAgIGNvbnN0IGxldmVsID0gZm10LkxJU1RTLmhhcyh3YXMpID8gTnVtYmVyKGIuZGF0YXNldC5sZXZlbCkgfHwgMCA6IDA7CiAgICAgICAgc2V0QmxvY2soYiwgb2ZmID8gJ3AnIDogdHlwZSwgbGV2ZWwsIHR5cGUgPT09ICdjaGVj",
"aycgJiYgd2FzID09PSAnY2hlY2snID8gYi5kYXRhc2V0LmNoZWNrZWQgPT09ICcxJyA6IGNoZWNrZWQpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBpbmRlbnQoZGVsdGEpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyIHx8IGNlbGxPZihyLnN0YXJ0Q29udGFpbmVyKSkgcmV0dXJuIGZhbHNlOwogICAgICBjb25zdCBibG9ja3MgPSByYW5nZUJsb2NrcyhyKS5maWx0ZXIoYiA9PiBmbXQuTElTVFMuaGFzKGIuZGF0YXNldC50eXBlKSk7CiAgICAgIGlmICghYmxvY2tzLmxlbmd0aCkgcmV0dXJuIGZhbHNlOwogICAgICBmb3IgKGNvbnN0IGIgb2YgYmxvY2tzKSBiLmRhdGFzZXQubGV2ZWwgPSBTdHJpbmcoTWF0aC5tYXgoMCwgTWF0aC5taW4oZm10Lk1BWF9MRVZFTCwgKE51bWJlcihiLmRhdGFzZXQubGV2ZWwpIHx8IDApICsgZGVsdGEpKSk7CiAgICAgIGNoYW5nZWQoKTsKICAgICAgcmV0dXJuIHRydWU7CiAgICB9CgogICAgZnVuY3Rpb24gdG9nZ2xlQ2hlY2soYmxrKSB7CiAgICAgIGlmICghZWRpdGFibGUgfHwgIWJsayB8fCBibGsuZGF0YXNldC50eXBlICE9PSAnY2hlY2snKSByZXR1cm47CiAgICAgIGJsay5kYXRhc2V0LmNoZWNrZWQgPSBibGsuZGF0YXNldC5jaGVja2VkID09PSAnMScgPyAnMCcgOiAnMSc7CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBjbGVhckZv",
"cm1hdHRpbmcoKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgcmVzdG9yZSgpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgncmVtb3ZlRm9ybWF0Jyk7CiAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCd1bmxpbmsnKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmIChyICYmICFjZWxsT2Yoci5zdGFydENvbnRhaW5lcikpIGZvciAoY29uc3QgYiBvZiByYW5nZUJsb2NrcyhyKSkgaWYgKGIuZGF0YXNldC50eXBlICE9PSAndGFibGUnKSBzZXRCbG9jayhiLCAncCcpOwogICAgICBjaGFuZ2VkKCk7CiAgICB9CgogICAgZnVuY3Rpb24gYW5jaG9yQXQocikgewogICAgICBsZXQgbiA9IHIgJiYgci5zdGFydENvbnRhaW5lcjsKICAgICAgd2hpbGUgKG4gJiYgbiAhPT0gZWxzLmVkaXRvcikgewogICAgICAgIGlmIChuLm5vZGVUeXBlID09PSAxICYmIG4udGFnTmFtZSA9PT0gJ0EnKSByZXR1cm4gbjsKICAgICAgICBuID0gbi5wYXJlbnROb2RlOwogICAgICB9CiAgICAgIHJldHVybiBudWxsOwogICAgfQoKICAgIC8vIOKUgOKUgCBMaW5rcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlv",
"biBvcGVuTGluaygpIHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuOwogICAgICBjb25zdCByID0gcmFuZ2UoKSB8fCBzYXZlZDsKICAgICAgaWYgKCFyKSByZXR1cm47CiAgICAgIHNhdmVkID0gci5jbG9uZVJhbmdlKCk7CiAgICAgIGNvbnN0IGEgPSBhbmNob3JBdChyKTsKICAgICAgZWxzLmxpbmtJbnB1dC52YWx1ZSA9IGEgPyBhLmdldEF0dHJpYnV0ZSgnaHJlZicpIDogJyc7CiAgICAgIGVscy5saW5rRXJyb3IudGV4dENvbnRlbnQgPSAnJzsKICAgICAgZWxzLmxpbmtSZW1vdmUuaGlkZGVuID0gIWE7CiAgICAgIGVscy5saW5rYmFyLmhpZGRlbiA9IGZhbHNlOwogICAgICBlbHMubGlua0lucHV0LmZvY3VzKCk7CiAgICAgIGVscy5saW5rSW5wdXQuc2VsZWN0KCk7CiAgICB9CgogICAgZnVuY3Rpb24gY2xvc2VMaW5rKHsgcmVmb2N1cyA9IHRydWUgfSA9IHt9KSB7CiAgICAgIGlmIChlbHMubGlua2Jhci5oaWRkZW4pIHJldHVybjsKICAgICAgZWxzLmxpbmtiYXIuaGlkZGVuID0gdHJ1ZTsKICAgICAgaWYgKHJlZm9jdXMpIHJlc3RvcmUoKTsKICAgIH0KCiAgICBmdW5jdGlvbiBhcHBseUxpbmsoKSB7CiAgICAgIGNvbnN0IGhyZWYgPSBmbXQuc2FmZUhyZWYoZWxzLmxpbmtJbnB1dC52YWx1ZSk7CiAgICAgIGlmICghaHJlZikgewogICAgICAgIGVscy5saW5rRXJyb3IudGV4dENvbnRlbnQgPSAnVGhhdCBpcyBub3QgYSB3ZWIgb3IgZW1haWwgYWRkcmVzcy4nOwogICAgICAgIHJldHVybjsKICAgICAgfQog",
"ICAgICBjbG9zZUxpbmsoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCBhID0gYW5jaG9yQXQocik7CiAgICAgIGlmIChyLmNvbGxhcHNlZCAmJiBhKSB7CiAgICAgICAgYS5zZXRBdHRyaWJ1dGUoJ2hyZWYnLCBocmVmKTsKICAgICAgICBhLnRpdGxlID0gaHJlZjsKICAgICAgfSBlbHNlIGlmIChyLmNvbGxhcHNlZCkgewogICAgICAgIC8vIE5vdGhpbmcgc2VsZWN0ZWQ6IHRoZSBhZGRyZXNzIGl0c2VsZiBiZWNvbWVzIHRoZSBsaW5rIHRleHQuCiAgICAgICAgY29uc3QgdGV4dCA9IGhyZWYucmVwbGFjZSgvXm1haWx0bzovLCAnJyk7CiAgICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2luc2VydFRleHQnLCBmYWxzZSwgdGV4dCk7CiAgICAgICAgY29uc3QgYWZ0ZXIgPSByYW5nZSgpOwogICAgICAgIGlmIChhZnRlcikgewogICAgICAgICAgY29uc3Qgc2VsID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgICAgIHNlbC5zZXRTdGFydChhZnRlci5zdGFydENvbnRhaW5lciwgTWF0aC5tYXgoMCwgYWZ0ZXIuc3RhcnRPZmZzZXQgLSB0ZXh0Lmxlbmd0aCkpOwogICAgICAgICAgc2VsLnNldEVuZChhZnRlci5zdGFydENvbnRhaW5lciwgYWZ0ZXIuc3RhcnRPZmZzZXQpOwogICAgICAgICAgc2VsZWN0KHNlbCk7CiAgICAgICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnY3JlYXRlTGluaycsIGZhbHNlLCBocmVmKTsKICAgICAgICAgIGNvbnN0IGVu",
"ZCA9IHJhbmdlKCk7CiAgICAgICAgICBpZiAoZW5kKSB7IGVuZC5jb2xsYXBzZShmYWxzZSk7IHNlbGVjdChlbmQpOyB9CiAgICAgICAgfQogICAgICB9IGVsc2UgewogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdjcmVhdGVMaW5rJywgZmFsc2UsIGhyZWYpOwogICAgICB9CiAgICAgIGNoYW5nZWQoKTsKICAgIH0KCiAgICBmdW5jdGlvbiByZW1vdmVMaW5rKCkgewogICAgICBjbG9zZUxpbmsoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGNvbnN0IGEgPSBhbmNob3JBdChyKTsKICAgICAgaWYgKGEpIHsKICAgICAgICBjb25zdCBzZWwgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICAgIHNlbC5zZWxlY3ROb2RlQ29udGVudHMoYSk7CiAgICAgICAgc2VsZWN0KHNlbCk7CiAgICAgIH0KICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ3VubGluaycpOwogICAgICBjaGFuZ2VkKCk7CiAgICB9CgogICAgLy8g4pSA4pSAIFRhYmxlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICAvLyBUaGUgY2VsbCBiZWluZyB3b3JrZWQgb246IHRoZSBvbmUgd2l0aCB0aGUgY3Vyc29yLCBvciAtIHdoaWxlIG9uZSBvZgogICAg",
"Ly8gdGhlIHRhYmxlIGJhcidzIG1lbnVzIGhhcyB0aGUgZm9jdXMgLSB0aGUgb25lIGl0IHdhcyBpbi4KICAgIGZ1bmN0aW9uIGNlbGxOb3coKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgICBjb25zdCB0ZCA9IHIgJiYgY2VsbE9mKHIuc3RhcnRDb250YWluZXIpOwogICAgICBpZiAodGQpIHJldHVybiB0ZDsKICAgICAgcmV0dXJuIGxhc3RDZWxsICYmIGxhc3RDZWxsLmlzQ29ubmVjdGVkICYmIGVscy5lZGl0b3IuY29udGFpbnMobGFzdENlbGwpID8gbGFzdENlbGwgOiBudWxsOwogICAgfQoKICAgIC8vIEEgY2hhbmdlIHRvIGEgdGFibGUncyBzaGFwZSwgd2hpY2ggQ3RybCtaIHN0cmFpZ2h0IGFmdGVyd2FyZHMgdGFrZXMKICAgIC8vIGJhY2ssIGFzIGl0IGRvZXMgYSBmb3JtYXR0ZWQgcGFzdGUuIGBmbmAgZ2V0cyB0aGUgY2VsbCBhbmQgaXRzIHRhYmxlCiAgICAvLyBhbmQgcmV0dXJucyB0aGUgY2VsbCB0byBnbyB0byBuZXh0LgogICAgZnVuY3Rpb24gdGFibGVFZGl0KGZuKSB7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgY29uc3QgdGQgPSBjZWxsTm93KCk7CiAgICAgIGlmICghdGQpIHJldHVybjsKICAgICAgY29uc3QgdW5kbyA9IHBhc3RlVW5kbzsKICAgICAgY29uc3QgYmVmb3JlID0gc25hcHNob3QoKTsKICAgICAgY29uc3QgbmV4dCA9IGZuKHRkLCB0YWJsZU9mKHRkKSk7CiAgICAgIGNoYW5nZWQoKTsKICAgICAgcGFzdGVVbmRvID0gWy4uLnVuZG8uc2xpY2UoLTE5KSwg",
"YmVmb3JlXTsKICAgICAgaWYgKG5leHQpIGZvY3VzQ2VsbChuZXh0LCB0cnVlKTsKICAgICAgcmVmcmVzaFRvb2xiYXIoKTsKICAgIH0KCiAgICBjb25zdCByb3dzT2YgPSBlbCA9PiBlbC5xdWVyeVNlbGVjdG9yKCd0YWJsZScpLnJvd3M7CiAgICBmdW5jdGlvbiBuZXdSb3coZWwpIHsKICAgICAgY29uc3QgYSA9IGFsaWducyhlbCk7CiAgICAgIGNvbnN0IHRyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndHInKTsKICAgICAgZm9yIChjb25zdCBhbCBvZiBhKSB0ci5hcHBlbmRDaGlsZChjZWxsRWwoW10sIGFsKSk7CiAgICAgIHJldHVybiB0cjsKICAgIH0KICAgIGNvbnN0IHRib2R5T2YgPSBlbCA9PiBlbC5xdWVyeVNlbGVjdG9yKCd0Ym9keScpIHx8IGVsLnF1ZXJ5U2VsZWN0b3IoJ3RhYmxlJyk7CgogICAgZnVuY3Rpb24gYWRkUm93KGJlbG93LCB7IGZpcnN0ID0gZmFsc2UgfSA9IHt9KSB7CiAgICAgIHRhYmxlRWRpdCgodGQsIGVsKSA9PiB7CiAgICAgICAgaWYgKHJvd3NPZihlbCkubGVuZ3RoID49IGZtdC5NQVhfUk9XUykgcmV0dXJuIHRkOwogICAgICAgIGNvbnN0IHRyID0gbmV3Um93KGVsKTsKICAgICAgICBpZiAoYmVsb3cpIHRkLnBhcmVudE5vZGUuYWZ0ZXIodHIpOwogICAgICAgIGVsc2UgdGQucGFyZW50Tm9kZS5iZWZvcmUodHIpOwogICAgICAgIHJldHVybiB0ci5jZWxsc1tmaXJzdCA_IDAgOiB0ZC5jZWxsSW5kZXhdOwogICAgICB9KTsKICAgIH0KCiAgICBmdW5jdGlvbiBhZGRDb2x1bW4ocmln",
"aHQpIHsKICAgICAgdGFibGVFZGl0KCh0ZCwgZWwpID0-IHsKICAgICAgICBjb25zdCByb3dzID0gcm93c09mKGVsKTsKICAgICAgICBpZiAocm93c1swXS5jZWxscy5sZW5ndGggPj0gZm10Lk1BWF9DT0xTKSByZXR1cm4gdGQ7CiAgICAgICAgY29uc3QgayA9IHRkLmNlbGxJbmRleCArIChyaWdodCA_IDEgOiAwKTsKICAgICAgICBjb25zdCBhID0gYWxpZ25zKGVsKTsKICAgICAgICBhLnNwbGljZShrLCAwLCAnJyk7CiAgICAgICAgZm9yIChjb25zdCB0ciBvZiByb3dzKSB0ci5pbnNlcnRCZWZvcmUoY2VsbEVsKFtdLCAnJyksIHRyLmNlbGxzW2tdIHx8IG51bGwpOwogICAgICAgIGVsLmRhdGFzZXQuYWxpZ24gPSBhLmpvaW4oJywnKTsKICAgICAgICByZXR1cm4gdGQucGFyZW50Tm9kZS5jZWxsc1trXTsKICAgICAgfSk7CiAgICB9CgogICAgLy8gVGhlIHRhYmxlIGdvbmU6IHRoZSBjdXJzb3IgdG8gdGhlIGxpbmUgYWZ0ZXIgaXQuCiAgICBmdW5jdGlvbiByZW1vdmVUYWJsZShlbCkgewogICAgICBsZXQgbmV4dCA9IGVsLm5leHRFbGVtZW50U2libGluZzsKICAgICAgaWYgKCFuZXh0IHx8IG5leHQuZGF0YXNldC50eXBlID09PSAndGFibGUnKSB7CiAgICAgICAgbmV4dCA9IGJsb2NrRWwoZm10LmJsb2NrKCdwJykpOwogICAgICAgIGVsLmFmdGVyKG5leHQpOwogICAgICB9CiAgICAgIGVsLnJlbW92ZSgpOwogICAgICBsYXN0Q2VsbCA9IG51bGw7CiAgICAgIGVscy5lZGl0b3IuZm9jdXMoeyBwcmV2ZW50U2Nyb2xs",
"OiB0cnVlIH0pOwogICAgICBjYXJldEludG8obmV4dCwgZmFsc2UpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KCiAgICBmdW5jdGlvbiBkZWxldGVSb3coKSB7CiAgICAgIHRhYmxlRWRpdCgodGQsIGVsKSA9PiB7CiAgICAgICAgaWYgKHJvd3NPZihlbCkubGVuZ3RoID09PSAxKSByZXR1cm4gcmVtb3ZlVGFibGUoZWwpOwogICAgICAgIGNvbnN0IHRyID0gdGQucGFyZW50Tm9kZTsKICAgICAgICBjb25zdCBuZXh0ID0gdHIubmV4dEVsZW1lbnRTaWJsaW5nIHx8IHRyLnByZXZpb3VzRWxlbWVudFNpYmxpbmc7CiAgICAgICAgdHIucmVtb3ZlKCk7CiAgICAgICAgcmV0dXJuIG5leHQuY2VsbHNbTWF0aC5taW4odGQuY2VsbEluZGV4LCBuZXh0LmNlbGxzLmxlbmd0aCAtIDEpXTsKICAgICAgfSk7CiAgICB9CgogICAgZnVuY3Rpb24gZGVsZXRlQ29sdW1uKCkgewogICAgICB0YWJsZUVkaXQoKHRkLCBlbCkgPT4gewogICAgICAgIGNvbnN0IHJvd3MgPSByb3dzT2YoZWwpOwogICAgICAgIGlmIChyb3dzWzBdLmNlbGxzLmxlbmd0aCA9PT0gMSkgcmV0dXJuIHJlbW92ZVRhYmxlKGVsKTsKICAgICAgICBjb25zdCBrID0gdGQuY2VsbEluZGV4OwogICAgICAgIGNvbnN0IGEgPSBhbGlnbnMoZWwpOwogICAgICAgIGEuc3BsaWNlKGssIDEpOwogICAgICAgIGNvbnN0IHRyID0gdGQucGFyZW50Tm9kZTsKICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiByb3dzKSByb3cuY2VsbHNba10ucmVtb3ZlKCk7CiAgICAgICAgZWwuZGF0",
"YXNldC5hbGlnbiA9IGEuam9pbignLCcpOwogICAgICAgIHJldHVybiB0ci5jZWxsc1tNYXRoLm1pbihrLCB0ci5jZWxscy5sZW5ndGggLSAxKV07CiAgICAgIH0pOwogICAgfQoKICAgIGZ1bmN0aW9uIHRvZ2dsZUhlYWQoKSB7CiAgICAgIHRhYmxlRWRpdCgodGQsIGVsKSA9PiB7CiAgICAgICAgZWwuZGF0YXNldC5oZWFkID0gZWwuZGF0YXNldC5oZWFkID09PSAnMScgPyAnMCcgOiAnMSc7CiAgICAgICAgcmV0dXJuIHRkOwogICAgICB9KTsKICAgIH0KCiAgICBmdW5jdGlvbiBhbGlnbkNvbHVtbih2YWx1ZSkgewogICAgICB0YWJsZUVkaXQoKHRkLCBlbCkgPT4gewogICAgICAgIGNvbnN0IGsgPSB0ZC5jZWxsSW5kZXg7CiAgICAgICAgY29uc3QgYSA9IGFsaWducyhlbCk7CiAgICAgICAgYVtrXSA9IHZhbHVlOwogICAgICAgIGVsLmRhdGFzZXQuYWxpZ24gPSBhLmpvaW4oJywnKTsKICAgICAgICBmb3IgKGNvbnN0IHRyIG9mIHJvd3NPZihlbCkpIGlmICh0ci5jZWxsc1trXSkgdHIuY2VsbHNba10uc3R5bGUudGV4dEFsaWduID0gdmFsdWU7CiAgICAgICAgcmV0dXJuIHRkOwogICAgICB9KTsKICAgIH0KCiAgICAvLyBUaGUgcm93cyBpbiBvcmRlciBvZiBvbmUgY29sdW1uIC0gbnVtYmVycyBhcyBudW1iZXJzLCBlbXB0eSBjZWxscwogICAgLy8gbGFzdCAtIHdpdGggYSBoZWFkaW5nIHJvdyBzdGF5aW5nIG9uIHRvcC4KICAgIGZ1bmN0aW9uIHNvcnRSb3dzKGRlc2MpIHsKICAgICAgdGFibGVFZGl0KCh0ZCwgZWwp",
"ID0-IHsKICAgICAgICBjb25zdCBrID0gdGQuY2VsbEluZGV4OwogICAgICAgIGNvbnN0IHJvd3MgPSBbLi4ucm93c09mKGVsKV07CiAgICAgICAgY29uc3QgaGVhZCA9IGVsLmRhdGFzZXQuaGVhZCA9PT0gJzEnID8gcm93cy5zaGlmdCgpIDogbnVsbDsKICAgICAgICBjb25zdCBrZXkgPSB0ciA9PiAodHIuY2VsbHNba10gPyB0ci5jZWxsc1trXS50ZXh0Q29udGVudC50cmltKCkgOiAnJyk7CiAgICAgICAgY29uc3Qgb3JkZXIgPSBuZXcgSW50bC5Db2xsYXRvcih1bmRlZmluZWQsIHsgbnVtZXJpYzogdHJ1ZSwgc2Vuc2l0aXZpdHk6ICdiYXNlJyB9KTsKICAgICAgICByb3dzLnNvcnQoKHgsIHkpID0-IHsKICAgICAgICAgIGNvbnN0IGEgPSBrZXkoeCk7CiAgICAgICAgICBjb25zdCBiID0ga2V5KHkpOwogICAgICAgICAgaWYgKCFhICE9PSAhYikgcmV0dXJuIGEgPyAtMSA6IDE7CiAgICAgICAgICByZXR1cm4gZGVzYyA_IG9yZGVyLmNvbXBhcmUoYiwgYSkgOiBvcmRlci5jb21wYXJlKGEsIGIpOwogICAgICAgIH0pOwogICAgICAgIGNvbnN0IGJvZHkgPSB0Ym9keU9mKGVsKTsKICAgICAgICBpZiAoaGVhZCkgYm9keS5hcHBlbmRDaGlsZChoZWFkKTsKICAgICAgICBmb3IgKGNvbnN0IHRyIG9mIHJvd3MpIGJvZHkuYXBwZW5kQ2hpbGQodHIpOwogICAgICAgIHJldHVybiB0ZDsKICAgICAgfSk7CiAgICB9CgogICAgLy8gQSBuZXcgdGFibGUgd2hlcmUgdGhlIGN1cnNvciBpczogaW4gcGxhY2Ugb2YgYW4gZW1wdHkg",
"bGluZSwgb3IgYWZ0ZXIKICAgIC8vIHRoZSBsaW5lIGl0IGlzIG9uOyB0aHJlZSBjb2x1bW5zLCBhIGhlYWRpbmcgcm93IGFuZCB0d28gbW9yZS4KICAgIGZ1bmN0aW9uIGluc2VydFRhYmxlKCkgewogICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgIHJlc3RvcmUoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghciB8fCBjZWxsT2Yoci5zdGFydENvbnRhaW5lcikpIHJldHVybjsKICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKSB8fCBlbHMuZWRpdG9yLmxhc3RFbGVtZW50Q2hpbGQ7CiAgICAgIGlmICghYmxrKSByZXR1cm47CiAgICAgIGNvbnN0IHVuZG8gPSBwYXN0ZVVuZG87CiAgICAgIGNvbnN0IGJlZm9yZSA9IHNuYXBzaG90KCk7CiAgICAgIGNvbnN0IHJvd3MgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiBORVdfVEFCTEUucm93cyB9LCAoKSA9PiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBORVdfVEFCTEUuY29scyB9LCAoKSA9PiAoeyBydW5zOiBbXSB9KSkpOwogICAgICBjb25zdCBlbCA9IHRhYmxlRWwoZm10LnRhYmxlKHJvd3MsIHsgaGVhZDogdHJ1ZSwgYWxpZ246IEFycmF5KE5FV19UQUJMRS5jb2xzKS5maWxsKCcnKSB9KSk7CiAgICAgIGlmIChibGsuZGF0YXNldC50eXBlID09PSAncCcgJiYgIWJsay50ZXh0Q29udGVudCkgYmxrLnJlcGxhY2VXaXRoKGVsKTsKICAgICAgZWxzZSBibGsuYWZ0ZXIoZWwpOwogICAgICBpZiAoIWVsLm5leHRFbGVtZW50",
"U2libGluZyB8fCBlbC5uZXh0RWxlbWVudFNpYmxpbmcuZGF0YXNldC50eXBlID09PSAndGFibGUnKSBlbC5hZnRlcihibG9ja0VsKGZtdC5ibG9jaygncCcpKSk7CiAgICAgIGNoYW5nZWQoKTsKICAgICAgcGFzdGVVbmRvID0gWy4uLnVuZG8uc2xpY2UoLTE5KSwgYmVmb3JlXTsKICAgICAgZm9jdXNDZWxsKGVsLnF1ZXJ5U2VsZWN0b3IoJ3RkJykpOwogICAgfQoKICAgIC8vIEtleXMgaW4gYSBjZWxsOiBUYWIgYW5kIFNoaWZ0K1RhYiBmcm9tIGNlbGwgdG8gY2VsbCAoVGFiIGluIHRoZSBsYXN0CiAgICAvLyBvbmUgYWRkcyBhIHJvdyksIEVudGVyIGEgbmV3IGxpbmUgaW4gdGhlIGNlbGwsIHRoZSBhcnJvd3Mgb3V0IG9mIGl0CiAgICAvLyBhdCBpdHMgZWRnZXMsIGFuZCBub3RoaW5nIGpvaW5pbmcgYSBjZWxsIHRvIGFub3RoZXIuCiAgICBmdW5jdGlvbiBjZWxsS2V5KGUsIHRkLCByLCBtb2QpIHsKICAgICAgY29uc3QgZWwgPSB0YWJsZU9mKHRkKTsKICAgICAgY29uc3QgY2VsbHMgPSBbLi4uZWwucXVlcnlTZWxlY3RvckFsbCgndGQnKV07CiAgICAgIGNvbnN0IGkgPSBjZWxscy5pbmRleE9mKHRkKTsKICAgICAgY29uc3QgdHIgPSB0ZC5wYXJlbnROb2RlOwogICAgICBjb25zdCBnbyA9IChjZWxsLCBhdEVuZCkgPT4geyBlLnByZXZlbnREZWZhdWx0KCk7IGZvY3VzQ2VsbChjZWxsLCBhdEVuZCk7IHJldHVybiB0cnVlOyB9OwogICAgICBjb25zdCBvdXQgPSBiZWxvdyA9PiB7IGUucHJldmVudERlZmF1bHQoKTsg",
"bGVhdmVUYWJsZShlbCwgYmVsb3cpOyByZXR1cm4gdHJ1ZTsgfTsKICAgICAgaWYgKGUua2V5ID09PSAnVGFiJyAmJiAhbW9kICYmICFlLmFsdEtleSkgewogICAgICAgIGlmIChlLnNoaWZ0S2V5KSByZXR1cm4gaSA-IDAgPyBnbyhjZWxsc1tpIC0gMV0sIHRydWUpIDogKGUucHJldmVudERlZmF1bHQoKSwgdHJ1ZSk7CiAgICAgICAgaWYgKGkgPCBjZWxscy5sZW5ndGggLSAxKSByZXR1cm4gZ28oY2VsbHNbaSArIDFdLCB0cnVlKTsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgYWRkUm93KHRydWUsIHsgZmlyc3Q6IHRydWUgfSk7CiAgICAgICAgcmV0dXJuIHRydWU7CiAgICAgIH0KICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFtb2QgJiYgIWUuYWx0S2V5ICYmICFlLmlzQ29tcG9zaW5nKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRMaW5lQnJlYWsnKTsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfQogICAgICBpZiAoIW1vZCAmJiAoKGUua2V5ID09PSAnQmFja3NwYWNlJyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCB0ZCkpIHx8IChlLmtleSA9PT0gJ0RlbGV0ZScgJiYgY2FyZXRBdEVuZChyLCB0ZCkpKSkgewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfQogICAgICBpZiAoIW1vZCAmJiAhZS5hbHRLZXkgJiYgIWUuc2hpZnRLZXkgJiYgci5jb2xsYXBz",
"ZWQpIHsKICAgICAgICBjb25zdCBrID0gdGQuY2VsbEluZGV4OwogICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93VXAnICYmIG9uRWRnZUxpbmUodGQsIHIsIGZhbHNlKSkgewogICAgICAgICAgY29uc3QgdXAgPSB0ci5wcmV2aW91c0VsZW1lbnRTaWJsaW5nOwogICAgICAgICAgcmV0dXJuIHVwID8gZ28odXAuY2VsbHNbTWF0aC5taW4oaywgdXAuY2VsbHMubGVuZ3RoIC0gMSldLCB0cnVlKSA6IG91dChmYWxzZSk7CiAgICAgICAgfQogICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93RG93bicgJiYgb25FZGdlTGluZSh0ZCwgciwgdHJ1ZSkpIHsKICAgICAgICAgIGNvbnN0IGRvd24gPSB0ci5uZXh0RWxlbWVudFNpYmxpbmc7CiAgICAgICAgICByZXR1cm4gZG93biA_IGdvKGRvd24uY2VsbHNbTWF0aC5taW4oaywgZG93bi5jZWxscy5sZW5ndGggLSAxKV0sIGZhbHNlKSA6IG91dCh0cnVlKTsKICAgICAgICB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnQXJyb3dMZWZ0JyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCB0ZCkpIHJldHVybiBpID4gMCA_IGdvKGNlbGxzW2kgLSAxXSwgdHJ1ZSkgOiBvdXQoZmFsc2UpOwogICAgICAgIGlmIChlLmtleSA9PT0gJ0Fycm93UmlnaHQnICYmIGNhcmV0QXRFbmQociwgdGQpKSByZXR1cm4gaSA8IGNlbGxzLmxlbmd0aCAtIDEgPyBnbyhjZWxsc1tpICsgMV0sIGZhbHNlKSA6IG91dCh0cnVlKTsKICAgICAgfQogICAgICAvLyBMaXN0cyBhbmQgaGVhZGluZ3MgYXJlIG5vdCBmb3Ig",
"Y2VsbHMuCiAgICAgIGlmIChtb2QgJiYgZS5zaGlmdEtleSAmJiAvXkRpZ2l0Wzc4OV0kLy50ZXN0KGUuY29kZSkpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyByZXR1cm4gdHJ1ZTsgfQogICAgICByZXR1cm4gZmFsc2U7CiAgICB9CgogICAgLy8gS2V5cyBvbiBhIGxpbmUgYmVzaWRlIGEgdGFibGU6IHRoZSBhcnJvd3MgaW50byBpdCwgYW5kIEJhY2tzcGFjZSBvcgogICAgLy8gRGVsZXRlIGludG8gaXQgcmF0aGVyIHRoYW4gdGhyb3VnaCBpdC4KICAgIGZ1bmN0aW9uIGJlc2lkZVRhYmxlKGUsIHIsIGJsaywgbW9kKSB7CiAgICAgIGlmIChtb2QgfHwgZS5hbHRLZXkgfHwgZS5zaGlmdEtleSB8fCAhci5jb2xsYXBzZWQpIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgcHJldiA9IGJsay5wcmV2aW91c0VsZW1lbnRTaWJsaW5nOwogICAgICBjb25zdCBuZXh0ID0gYmxrLm5leHRFbGVtZW50U2libGluZzsKICAgICAgY29uc3QgaW50byA9IChlbCwgbGFzdCkgPT4gewogICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBjZWxscyA9IGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ3RkJyk7CiAgICAgICAgZm9jdXNDZWxsKGxhc3QgPyBjZWxsc1tjZWxscy5sZW5ndGggLSAxXSA6IGNlbGxzWzBdLCBsYXN0KTsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfTsKICAgICAgaWYgKG5leHQgJiYgbmV4dC5kYXRhc2V0LnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICBpZiAoKGUua2V5ID09PSAnQXJyb3dEb3du",
"JyAmJiBvbkVkZ2VMaW5lKGJsaywgciwgdHJ1ZSkpIHx8IChlLmtleSA9PT0gJ0Fycm93UmlnaHQnICYmIGNhcmV0QXRFbmQociwgYmxrKSkpIHJldHVybiBpbnRvKG5leHQsIGZhbHNlKTsKICAgICAgICBpZiAoZS5rZXkgPT09ICdEZWxldGUnICYmIGNhcmV0QXRFbmQociwgYmxrKSkgewogICAgICAgICAgaWYgKCFibGsudGV4dENvbnRlbnQgJiYgYmxrLnByZXZpb3VzRWxlbWVudFNpYmxpbmcpIHsgYmxrLnJlbW92ZSgpOyBjaGFuZ2VkKCk7IH0KICAgICAgICAgIHJldHVybiBpbnRvKG5leHQsIGZhbHNlKTsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKHByZXYgJiYgcHJldi5kYXRhc2V0LnR5cGUgPT09ICd0YWJsZScpIHsKICAgICAgICBpZiAoZS5rZXkgPT09ICdBcnJvd1VwJyAmJiBvbkVkZ2VMaW5lKGJsaywgciwgZmFsc2UpKSB7CiAgICAgICAgICAvLyBVcCBpbnRvIHRoZSBsYXN0IHJvdywgYXQgaXRzIHN0YXJ0LgogICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgICAgY29uc3Qgcm93cyA9IHByZXYucXVlcnlTZWxlY3RvcigndGFibGUnKS5yb3dzOwogICAgICAgICAgZm9jdXNDZWxsKHJvd3Nbcm93cy5sZW5ndGggLSAxXS5jZWxsc1swXSwgdHJ1ZSk7CiAgICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgICB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnQXJyb3dMZWZ0JyAmJiBjYXJldEF0QmxvY2tTdGFydChyLCBibGspKSByZXR1cm4gaW50byhwcmV2LCB0cnVlKTsKICAgICAgICAv",
"LyBBbiBlbXB0eSBsaW5lIGFmdGVyIGEgdGFibGUgZ29lcyAodW5sZXNzIGl0IGlzIHRoZSBsYXN0KTsgYSBsaW5lCiAgICAgICAgLy8gd2l0aCB0ZXh0IGtlZXBzIGl0LCBhbmQgdGhlIGN1cnNvciBnb2VzIGludG8gdGhlIHRhYmxlLgogICAgICAgIGlmIChlLmtleSA9PT0gJ0JhY2tzcGFjZScgJiYgYmxrLmRhdGFzZXQudHlwZSA9PT0gJ3AnICYmIGNhcmV0QXRCbG9ja1N0YXJ0KHIsIGJsaykpIHsKICAgICAgICAgIGlmICghYmxrLnRleHRDb250ZW50ICYmIGJsay5uZXh0RWxlbWVudFNpYmxpbmcpIHsgYmxrLnJlbW92ZSgpOyBjaGFuZ2VkKCk7IH0KICAgICAgICAgIHJldHVybiBpbnRvKHByZXYsIHRydWUpOwogICAgICAgIH0KICAgICAgfQogICAgICByZXR1cm4gZmFsc2U7CiAgICB9CgogICAgLy8gQSBwYXN0ZSBpbnRvIGEgY2VsbDogY2VsbHMgLSBhIHRhYmxlLCBvciB0YWItc2VwYXJhdGVkIHRleHQsIGFzIGEKICAgIC8vIHNwcmVhZHNoZWV0IGNvcGllcyB0aGVtIC0gZmlsbCB0aGUgY2VsbHMgZnJvbSB0aGlzIG9uZSBvbiwgYWRkaW5nCiAgICAvLyByb3dzIGFuZCBjb2x1bW5zIGFzIG5lZWRlZDsgYW55dGhpbmcgZWxzZSBnb2VzIGluIGFzIHRleHQuCiAgICBmdW5jdGlvbiBwYXN0ZUluQ2VsbChkb2MsIHRleHQpIHsKICAgICAgY29uc3QgdCA9IGRvYyAmJiBmbXQub25seVRhYmxlKGRvYyk7CiAgICAgIGxldCBncmlkID0gdCA_IHQucm93cy5tYXAocm93ID0-IHJvdy5tYXAoYyA9PiBjLnJ1bnMpKSA6",
"IG51bGw7CiAgICAgIGlmICghZ3JpZCAmJiAvXHQvLnRlc3QodGV4dCB8fCAnJykpIHsKICAgICAgICBncmlkID0gU3RyaW5nKHRleHQpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnJlcGxhY2UoL1xuJC8sICcnKS5zcGxpdCgnXG4nKS5tYXAobGluZSA9PiBsaW5lLnNwbGl0KCdcdCcpLm1hcChjID0-IFt7IHRleHQ6IGMgfV0pKTsKICAgICAgfQogICAgICBpZiAoZ3JpZCAmJiAoZ3JpZC5sZW5ndGggPiAxIHx8IGdyaWRbMF0ubGVuZ3RoID4gMSkpIHsKICAgICAgICB0YWJsZUVkaXQoKHRkLCBlbCkgPT4gewogICAgICAgICAgY29uc3Qgcm93cyA9IHJvd3NPZihlbCk7CiAgICAgICAgICBjb25zdCByMCA9IHRkLnBhcmVudE5vZGUucm93SW5kZXg7CiAgICAgICAgICBjb25zdCBjMCA9IHRkLmNlbGxJbmRleDsKICAgICAgICAgIGNvbnN0IHdpZGUgPSBNYXRoLm1pbihmbXQuTUFYX0NPTFMsIGMwICsgTWF0aC5tYXgoLi4uZ3JpZC5tYXAocm93ID0-IHJvdy5sZW5ndGgpKSk7CiAgICAgICAgICB3aGlsZSAocm93c1swXS5jZWxscy5sZW5ndGggPCB3aWRlKSBmb3IgKGNvbnN0IHRyIG9mIHJvd3MpIHRyLmFwcGVuZENoaWxkKGNlbGxFbChbXSwgJycpKTsKICAgICAgICAgIGVsLmRhdGFzZXQuYWxpZ24gPSBhbGlnbnMoZWwpLmpvaW4oJywnKTsKICAgICAgICAgIGNvbnN0IHRhbGwgPSBNYXRoLm1pbihmbXQuTUFYX1JPV1MsIHIwICsgZ3JpZC5sZW5ndGgpOwogICAgICAgICAgd2hpbGUgKHJvd3MubGVuZ3RoIDwgdGFs",
"bCkgdGJvZHlPZihlbCkuYXBwZW5kQ2hpbGQobmV3Um93KGVsKSk7CiAgICAgICAgICBsZXQgbGFzdCA9IHRkOwogICAgICAgICAgZ3JpZC5mb3JFYWNoKChyb3csIGkpID0-IHJvdy5mb3JFYWNoKChydW5zLCBqKSA9PiB7CiAgICAgICAgICAgIGNvbnN0IGNlbGwgPSByb3dzW3IwICsgaV0gJiYgcm93c1tyMCArIGldLmNlbGxzW2MwICsgal07CiAgICAgICAgICAgIGlmICghY2VsbCkgcmV0dXJuOwogICAgICAgICAgICBmaWxsQ2VsbChjZWxsLCBydW5zKTsKICAgICAgICAgICAgbGFzdCA9IGNlbGw7CiAgICAgICAgICB9KSk7CiAgICAgICAgICByZXR1cm4gbGFzdDsKICAgICAgICB9KTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgY29uc3Qgb25lID0gZ3JpZCA_IGdyaWRbMF1bMF0ubWFwKHggPT4geC50ZXh0KS5qb2luKCcnKSA6IGRvYyA_IGZtdC5kb2NUZXh0KGRvYykgOiBTdHJpbmcodGV4dCB8fCAnJyk7CiAgICAgIFN0cmluZyhvbmUpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnJlcGxhY2UoL1xuKyQvLCAnJykuc3BsaXQoJ1xuJykuZm9yRWFjaCgobGluZSwgaSkgPT4gewogICAgICAgIGlmIChpKSBkb2N1bWVudC5leGVjQ29tbWFuZCgnaW5zZXJ0TGluZUJyZWFrJyk7CiAgICAgICAgaWYgKGxpbmUpIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIGxpbmUpOwogICAgICB9KTsKICAgIH0KCiAgICAvLyDilIDilIAgVG9vbGJhciDilIDilIDilIDilIDilIDilIDilIDi",
"lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBjb25zdCBidXR0b25zID0ge307CiAgICBjb25zdCB0YkJ1dHRvbiA9IChrZXksIGxhYmVsLCBpY29uTmFtZSwgb25DbGljaywgdG9nZ2xlID0gdHJ1ZSkgPT4gewogICAgICBjb25zdCBiID0gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAndGItYnRuJywgdHlwZTogJ2J1dHRvbicsIHRpdGxlOiBsYWJlbCwgJ2FyaWEtbGFiZWwnOiBsYWJlbCwKICAgICAgICAnYXJpYS1wcmVzc2VkJzogdG9nZ2xlID8gJ2ZhbHNlJyA6IG51bGwsIGRhdGFzZXQ6IHsga2V5OiBgZm10LSR7a2V5fWAgfSwKICAgICAgICAvLyBLZWVwcyB0aGUgZm9jdXMgLSBhbmQgc28gdGhlIHNlbGVjdGlvbiAtIGluIHRoZSB0ZXh0LgogICAgICAgIG9ubW91c2Vkb3duOiBlID0-IGUucHJldmVudERlZmF1bHQoKSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiBvbkNsaWNrKCksCiAgICAgIH0sIGljb24oaWNvbk5hbWUsIDIwKSk7CiAgICAgIGJ1dHRvbnNba2V5XSA9IGI7CiAgICAgIHJldHVybiBiOwogICAgfTsKICAgIGNvbnN0IHNlcCA9ICgpID0-IGgoJ3NwYW4nLCB7IGNsYXNzOiAndGItc2VwJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0pOwoKICAgIGVscy5zdHls",
"ZUxhYmVsID0gaCgnc3BhbicsIHsgY2xhc3M6ICd0Yi1zdHlsZS1sYWJlbCcsIHRleHQ6ICdOb3JtYWwgdGV4dCcgfSk7CiAgICBlbHMuc3R5bGUgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAndGItc3R5bGUnLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywKICAgICAgJ2FyaWEtbGFiZWwnOiAnVGV4dCBzdHlsZScsIHRpdGxlOiAnVGV4dCBzdHlsZScsIGRhdGFzZXQ6IHsga2V5OiAnZm10LXN0eWxlJyB9LAogICAgICBvbm1vdXNlZG93bjogZSA9PiBlLnByZXZlbnREZWZhdWx0KCksCiAgICAgIG9uY2xpY2s6ICgpID0-IHsKICAgICAgICBpZiAoIWVkaXRhYmxlKSByZXR1cm47CiAgICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgICAgaWYgKHIpIHNhdmVkID0gci5jbG9uZVJhbmdlKCk7CiAgICAgICAgY29uc3QgY3VyID0gY3VycmVudFR5cGUoKTsKICAgICAgICBvcGVuTWVudShyb290LCBlbHMuc3R5bGUsIFNUWUxFUy5tYXAoKFt0eXBlLCBsYWJlbF0pID0-ICh7CiAgICAgICAgICBsYWJlbCwga2V5OiBgc3R5bGU6JHt0eXBlfWAsIGNoZWNrZWQ6IGN1ciA9PT0gdHlwZSwKICAgICAgICAgIG9uU2VsZWN0OiAoKSA9PiBibG9ja1R5cGUodHlwZSksCiAgICAgICAgfSkpLCB7IGxhYmVsOiAnVGV4dCBzdHlsZScgfSk7CiAgICAgIH0sCiAgICB9LCBlbHMuc3R5bGVMYWJlbCwgaWNvbignY2FyZXQnLCAxOCkpOwoKICAgIGVscy50",
"b29sYmFyID0gaCgnZGl2JywgeyBjbGFzczogJ25lLXRvb2xiYXInLCByb2xlOiAndG9vbGJhcicsICdhcmlhLWxhYmVsJzogJ0Zvcm1hdHRpbmcnIH0sCiAgICAgIGVscy5zdHlsZSwKICAgICAgc2VwKCksCiAgICAgIHRiQnV0dG9uKCdib2xkJywgJ0JvbGQgKEN0cmwrQiknLCAnYm9sZCcsICgpID0-IGlubGluZSgnYm9sZCcpKSwKICAgICAgdGJCdXR0b24oJ2l0YWxpYycsICdJdGFsaWMgKEN0cmwrSSknLCAnaXRhbGljJywgKCkgPT4gaW5saW5lKCdpdGFsaWMnKSksCiAgICAgIHRiQnV0dG9uKCdzdHJpa2UnLCAnU3RyaWtlLXRocm91Z2gnLCAnc3RyaWtlJywgKCkgPT4gaW5saW5lKCdzdHJpa2VUaHJvdWdoJykpLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ3VsJywgJ0J1bGxldGVkIGxpc3QgKEN0cmwrU2hpZnQrOCknLCAnYnVsbGV0cycsICgpID0-IGJsb2NrVHlwZSgndWwnKSksCiAgICAgIHRiQnV0dG9uKCdvbCcsICdOdW1iZXJlZCBsaXN0IChDdHJsK1NoaWZ0KzcpJywgJ251bWJlcnMnLCAoKSA9PiBibG9ja1R5cGUoJ29sJykpLAogICAgICB0YkJ1dHRvbignY2hlY2snLCAnQ2hlY2tsaXN0IChDdHJsK1NoaWZ0KzkpJywgJ2NoZWNrbGlzdCcsICgpID0-IGJsb2NrVHlwZSgnY2hlY2snKSksCiAgICAgIHRiQnV0dG9uKCdvdXRkZW50JywgJ0xlc3MgaW5kZW50IChTaGlmdCtUYWIpJywgJ291dGRlbnQnLCAoKSA9PiB7IHJlc3RvcmUoKTsgaW5kZW50KC0xKTsgfSwgZmFsc2UpLAogICAgICB0YkJ1",
"dHRvbignaW5kZW50JywgJ01vcmUgaW5kZW50IChUYWIpJywgJ2luZGVudCcsICgpID0-IHsgcmVzdG9yZSgpOyBpbmRlbnQoMSk7IH0sIGZhbHNlKSwKICAgICAgdGJCdXR0b24oJ3RhYmxlJywgJ1RhYmxlJywgJ3RhYmxlJywgKCkgPT4gaW5zZXJ0VGFibGUoKSwgZmFsc2UpLAogICAgICBzZXAoKSwKICAgICAgdGJCdXR0b24oJ2xpbmsnLCAnTGluayAoQ3RybCtLKScsICdsaW5rJywgKCkgPT4gb3BlbkxpbmsoKSksCiAgICAgIHRiQnV0dG9uKCdjbGVhcicsICdDbGVhciBmb3JtYXR0aW5nJywgJ2NsZWFyJywgKCkgPT4gY2xlYXJGb3JtYXR0aW5nKCksIGZhbHNlKSk7CgogICAgZWxzLmxpbmtJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHBsYWNlaG9sZGVyOiAnV2ViIGFkZHJlc3Mgb3IgZW1haWwnLCAnYXJpYS1sYWJlbCc6ICdMaW5rIGFkZHJlc3MnLAogICAgICBzcGVsbGNoZWNrOiAnZmFsc2UnLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWlucHV0JyB9LAogICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgIGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGFwcGx5TGluaygpOyB9CiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgeyBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGNsb3NlTGluaygpOyB9CiAgICAgIH0sCiAgICB9KTsKICAgIGVscy5saW5rRXJyb3IgPSBo",
"KCdzcGFuJywgeyBjbGFzczogJ2xpbmstZXJyb3InLCByb2xlOiAnYWxlcnQnIH0pOwogICAgZWxzLmxpbmtSZW1vdmUgPSBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdSZW1vdmUgbGluaycsIGRhdGFzZXQ6IHsga2V5OiAnZm10LWxpbmstcmVtb3ZlJyB9LCBvbmNsaWNrOiByZW1vdmVMaW5rIH0pOwogICAgZWxzLmxpbmtiYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtbGlua2JhcicsIGhpZGRlbjogdHJ1ZSB9LAogICAgICBpY29uKCdsaW5rJywgMTgpLCBlbHMubGlua0lucHV0LAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10b25hbCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQXBwbHknLCBkYXRhc2V0OiB7IGtleTogJ2ZtdC1saW5rLWFwcGx5JyB9LCBvbmNsaWNrOiBhcHBseUxpbmsgfSksCiAgICAgIGVscy5saW5rUmVtb3ZlLAogICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiAoKSA9PiBjbG9zZUxpbmsoKSB9KSwKICAgICAgZWxzLmxpbmtFcnJvcik7CgogICAgLy8gVGhlIHRhYmxlIGJhcjogdW5kZXIgdGhlIHRvb2xiYXIgd2hpbGUgdGhlIGN1cnNvciBpcyBpbiBhIGNlbGwuCiAgICBjb25zdCBrZWVwRm9jdXMgPSBlID0-IGUucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IG1lbnVCdXR0b24gPSAoa2V5LCBsYWJlbCwg",
"aXRlbXMpID0-IHsKICAgICAgY29uc3QgYiA9IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ3RiLXRleHQnLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywgZGF0YXNldDogeyBrZXkgfSwKICAgICAgICBvbm1vdXNlZG93bjoga2VlcEZvY3VzLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgaWYgKGVkaXRhYmxlICYmIGNlbGxOb3coKSkgb3Blbk1lbnUocm9vdCwgYiwgaXRlbXMoKSwgeyBsYWJlbCB9KTsgfSwKICAgICAgfSwgbGFiZWwsIGljb24oJ2NhcmV0JywgMTgpKTsKICAgICAgcmV0dXJuIGI7CiAgICB9OwogICAgZWxzLnRhYmxlSGVhZCA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICd0Yi10ZXh0JywgdHlwZTogJ2J1dHRvbicsICdhcmlhLXByZXNzZWQnOiAnZmFsc2UnLCB0aXRsZTogJ1RoZSBmaXJzdCByb3cgaXMgYSBoZWFkaW5nIHJvdycsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiAndGFibGUtaGVhZCcgfSwgb25tb3VzZWRvd246IGtlZXBGb2N1cywgb25jbGljazogKCkgPT4gdG9nZ2xlSGVhZCgpLAogICAgfSwgJ0hlYWRpbmcgcm93Jyk7CiAgICBlbHMudGFibGViYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtdGFibGViYXInLCByb2xlOiAndG9vbGJhcicsICdhcmlhLWxhYmVsJzogJ1RhYmxlJywgaGlkZGVuOiB0cnVlIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndGItbGFiZWwnIH0sIGljb24oJ3RhYmxl",
"JywgMTgpKSwKICAgICAgbWVudUJ1dHRvbigndGFibGUtcm93JywgJ1JvdycsICgpID0-IFsKICAgICAgICB7IGxhYmVsOiAnSW5zZXJ0IHJvdyBhYm92ZScsIGtleTogJ3Jvdy1hYm92ZScsIG9uU2VsZWN0OiAoKSA9PiBhZGRSb3coZmFsc2UpIH0sCiAgICAgICAgeyBsYWJlbDogJ0luc2VydCByb3cgYmVsb3cnLCBrZXk6ICdyb3ctYmVsb3cnLCBvblNlbGVjdDogKCkgPT4gYWRkUm93KHRydWUpIH0sCiAgICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgICB7IGxhYmVsOiAnRGVsZXRlIHJvdycsIGtleTogJ3Jvdy1kZWxldGUnLCBkYW5nZXI6IHRydWUsIG9uU2VsZWN0OiAoKSA9PiBkZWxldGVSb3coKSB9LAogICAgICBdKSwKICAgICAgbWVudUJ1dHRvbigndGFibGUtY29sdW1uJywgJ0NvbHVtbicsICgpID0-IFsKICAgICAgICB7IGxhYmVsOiAnSW5zZXJ0IGNvbHVtbiBsZWZ0Jywga2V5OiAnY29sLWxlZnQnLCBvblNlbGVjdDogKCkgPT4gYWRkQ29sdW1uKGZhbHNlKSB9LAogICAgICAgIHsgbGFiZWw6ICdJbnNlcnQgY29sdW1uIHJpZ2h0Jywga2V5OiAnY29sLXJpZ2h0Jywgb25TZWxlY3Q6ICgpID0-IGFkZENvbHVtbih0cnVlKSB9LAogICAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgICAgeyBsYWJlbDogJ0RlbGV0ZSBjb2x1bW4nLCBrZXk6ICdjb2wtZGVsZXRlJywgZGFuZ2VyOiB0cnVlLCBvblNlbGVjdDogKCkgPT4gZGVsZXRlQ29sdW1uKCkgfSwKICAgICAgXSksCiAgICAgIGVscy50",
"YWJsZUhlYWQsCiAgICAgIHNlcCgpLAogICAgICB0YkJ1dHRvbignYWxpZ24tbGVmdCcsICdBbGlnbiBjb2x1bW4gbGVmdCcsICdhbGlnbkxlZnQnLCAoKSA9PiBhbGlnbkNvbHVtbignJykpLAogICAgICB0YkJ1dHRvbignYWxpZ24tY2VudGVyJywgJ0NlbnRyZSBjb2x1bW4nLCAnYWxpZ25DZW50ZXInLCAoKSA9PiBhbGlnbkNvbHVtbignY2VudGVyJykpLAogICAgICB0YkJ1dHRvbignYWxpZ24tcmlnaHQnLCAnQWxpZ24gY29sdW1uIHJpZ2h0JywgJ2FsaWduUmlnaHQnLCAoKSA9PiBhbGlnbkNvbHVtbigncmlnaHQnKSksCiAgICAgIHNlcCgpLAogICAgICBtZW51QnV0dG9uKCd0YWJsZS1zb3J0JywgJ1NvcnQnLCAoKSA9PiBbCiAgICAgICAgeyBsYWJlbDogJ1NvcnQgYnkgdGhpcyBjb2x1bW4sIEEgdG8gWicsIGtleTogJ3NvcnQtYXNjJywgb25TZWxlY3Q6ICgpID0-IHNvcnRSb3dzKGZhbHNlKSB9LAogICAgICAgIHsgbGFiZWw6ICdTb3J0IGJ5IHRoaXMgY29sdW1uLCBaIHRvIEEnLCBrZXk6ICdzb3J0LWRlc2MnLCBvblNlbGVjdDogKCkgPT4gc29ydFJvd3ModHJ1ZSkgfSwKICAgICAgXSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3BhY2VyJyB9KSwKICAgICAgdGJCdXR0b24oJ3RhYmxlLWRlbGV0ZScsICdEZWxldGUgdGFibGUnLCAnZGVsZXRlJywgKCkgPT4gZGVsZXRlVGFibGUoKSwgZmFsc2UpKTsKCiAgICBmdW5jdGlvbiBkZWxldGVUYWJsZSgpIHsKICAgICAgdGFibGVFZGl0KCh0ZCwgZWwpID0-",
"IHJlbW92ZVRhYmxlKGVsKSk7CiAgICB9CgogICAgZnVuY3Rpb24gY3VycmVudFR5cGUoKSB7CiAgICAgIGNvbnN0IHIgPSByYW5nZSgpIHx8IHNhdmVkOwogICAgICBjb25zdCBibGsgPSByICYmIGJsb2NrT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIHJldHVybiBibGsgPyBibGsuZGF0YXNldC50eXBlIHx8ICdwJyA6ICdwJzsKICAgIH0KCiAgICBmdW5jdGlvbiByZWZyZXNoVG9vbGJhcigpIHsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwogICAgICBjb25zdCB0eXBlID0gY3VycmVudFR5cGUoKTsKICAgICAgZWxzLnN0eWxlTGFiZWwudGV4dENvbnRlbnQgPSBTVFlMRV9MQUJFTFt0eXBlXSB8fCAnTm9ybWFsIHRleHQnOwogICAgICBmb3IgKGNvbnN0IFtrZXksIGNtZF0gb2YgW1snYm9sZCcsICdib2xkJ10sIFsnaXRhbGljJywgJ2l0YWxpYyddLCBbJ3N0cmlrZScsICdzdHJpa2VUaHJvdWdoJ11dKSB7CiAgICAgICAgbGV0IG9uID0gZmFsc2U7CiAgICAgICAgdHJ5IHsgb24gPSBkb2N1bWVudC5xdWVyeUNvbW1hbmRTdGF0ZShjbWQpOyB9IGNhdGNoIHsgLyogbm90IHN1cHBvcnRlZCAqLyB9CiAgICAgICAgYnV0dG9uc1trZXldLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKG9uKSk7CiAgICAgIH0KICAgICAgZm9yIChjb25zdCB0IG9mIFsndWwnLCAnb2wnLCAnY2hlY2snXSkgYnV0dG9uc1t0XS5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0",
"cmluZyh0eXBlID09PSB0KSk7CiAgICAgIGJ1dHRvbnMubGluay5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyghIWFuY2hvckF0KHIpKSk7CiAgICAgIC8vIEluIGEgY2VsbDogdGhlIHRhYmxlIGJhciwgYW5kIG5vdGhpbmcgdGhhdCBtYWtlcyBsaXN0cyBvciBoZWFkaW5ncy4KICAgICAgY29uc3QgdGQgPSBjZWxsT2Yoci5zdGFydENvbnRhaW5lcik7CiAgICAgIGlmICh0ZCkgbGFzdENlbGwgPSB0ZDsKICAgICAgZWxzLnRhYmxlYmFyLmhpZGRlbiA9ICF0ZCB8fCAhZWRpdGFibGU7CiAgICAgIGZvciAoY29uc3QgayBvZiBbJ3VsJywgJ29sJywgJ2NoZWNrJywgJ291dGRlbnQnLCAnaW5kZW50JywgJ3RhYmxlJ10pIGJ1dHRvbnNba10uZGlzYWJsZWQgPSAhZWRpdGFibGUgfHwgISF0ZDsKICAgICAgZWxzLnN0eWxlLmRpc2FibGVkID0gIWVkaXRhYmxlIHx8ICEhdGQ7CiAgICAgIGlmICh0ZCkgewogICAgICAgIGNvbnN0IGVsID0gdGFibGVPZih0ZCk7CiAgICAgICAgZWxzLnRhYmxlSGVhZC5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyhlbC5kYXRhc2V0LmhlYWQgPT09ICcxJykpOwogICAgICAgIGNvbnN0IGEgPSBhbGlnbnMoZWwpW3RkLmNlbGxJbmRleF0gfHwgJyc7CiAgICAgICAgYnV0dG9uc1snYWxpZ24tbGVmdCddLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKGEgPT09ICcnKSk7CiAgICAgICAgYnV0dG9uc1snYWxpZ24tY2VudGVyJ10uc2V0QXR0cmli",
"dXRlKCdhcmlhLXByZXNzZWQnLCBTdHJpbmcoYSA9PT0gJ2NlbnRlcicpKTsKICAgICAgICBidXR0b25zWydhbGlnbi1yaWdodCddLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKGEgPT09ICdyaWdodCcpKTsKICAgICAgfQogICAgfQoKICAgIC8vIOKUgOKUgCBUaGUgZWRpdGFibGUgYXJlYSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBlbHMuZWRpdG9yID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ25lLWJvZHknLCByb2xlOiAndGV4dGJveCcsICdhcmlhLW11bHRpbGluZSc6ICd0cnVlJywgJ2FyaWEtbGFiZWwnOiAnTm90ZScsCiAgICAgIHNwZWxsY2hlY2s6ICd0cnVlJywgZGF0YXNldDogeyBrZXk6ICdub3RlLWJvZHknLCBlbXB0eTogJzEnIH0sCiAgICB9KTsKCiAgICBlbHMuZWRpdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBlID0-IHsKICAgICAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuOwogICAgICBjb25zdCBtb2QgPSBlLmN0cmxLZXkgfHwgZS5tZXRhS2V5OwogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgY29uc3QgYmxrID0gciAmJiBibG9ja09mKHIuc3RhcnRDb250YWluZXIpOwogICAgICBjb25zdCB0ZCA9IHIgJiYgY2VsbE9mKHIuc3RhcnRD",
"b250YWluZXIpOwogICAgICBpZiAodGQgJiYgY2VsbEtleShlLCB0ZCwgciwgbW9kKSkgcmV0dXJuOwogICAgICBpZiAoIXRkICYmIGJsayAmJiBiZXNpZGVUYWJsZShlLCByLCBibGssIG1vZCkpIHJldHVybjsKCiAgICAgIGlmIChtb2QgJiYgIWUuYWx0S2V5ICYmICFlLnNoaWZ0S2V5ICYmIGUua2V5LnRvTG93ZXJDYXNlKCkgPT09ICd6JyAmJiBwYXN0ZVVuZG8ubGVuZ3RoKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIHVuZG9QYXN0ZSgpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBpZiAobW9kICYmICFlLmFsdEtleSAmJiBlLnNoaWZ0S2V5ICYmIGUua2V5LnRvTG93ZXJDYXNlKCkgPT09ICd2JykgewogICAgICAgIC8vIFRoZSBwYXN0ZSBldmVudCBmb2xsb3dzIHN0cmFpZ2h0IGF3YXksIGluIHRoaXMgc2FtZSB0YXNrLgogICAgICAgIHBsYWluTmV4dCA9IHRydWU7CiAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7IHBsYWluTmV4dCA9IGZhbHNlOyB9LCAwKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKG1vZCAmJiAhZS5hbHRLZXkgJiYgZS5zaGlmdEtleSAmJiAvXkRpZ2l0Wzc4OV0kLy50ZXN0KGUuY29kZSkpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgYmxvY2tUeXBlKHsgRGlnaXQ3OiAnb2wnLCBEaWdpdDg6ICd1bCcsIERpZ2l0OTogJ2NoZWNrJyB9W2UuY29kZV0pOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBpZiAo",
"bW9kICYmICFlLnNoaWZ0S2V5ICYmICFlLmFsdEtleSkgewogICAgICAgIGNvbnN0IGsgPSBlLmtleS50b0xvd2VyQ2FzZSgpOwogICAgICAgIGlmIChrID09PSAnaycpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBvcGVuTGluaygpOyByZXR1cm47IH0KICAgICAgICBpZiAoayA9PT0gJ3UnKSB7IGUucHJldmVudERlZmF1bHQoKTsgcmV0dXJuOyB9IC8vIG5vIHVuZGVybGluZSBpbiB0aGUgbW9kZWwKICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicgJiYgYmxrICYmIGJsay5kYXRhc2V0LnR5cGUgPT09ICdjaGVjaycpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyB0b2dnbGVDaGVjayhibGspOyByZXR1cm47IH0KICAgICAgfQogICAgICBpZiAoZS5rZXkgPT09ICdUYWInICYmICFtb2QgJiYgIWUuYWx0S2V5ICYmIGJsayAmJiBmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V0LnR5cGUpKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGluZGVudChlLnNoaWZ0S2V5ID8gLTEgOiAxKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFtb2QgJiYgIWUuYWx0S2V5ICYmICFlLmlzQ29tcG9zaW5nKSB7CiAgICAgICAgLy8gQW4gZW1wdHkgbGlzdCBpdGVtIGVuZHMgdGhlIGxpc3Q7IFNoaWZ0K0VudGVyIGlzIGEgbmV3IGxpbmUgbGlrZQogICAgICAgIC8vIGFueSBvdGhlciwgc2luY2UgdGhlIG1vZGVsIGhhcyBubyBsaW5lIGJyZWFrcyBpbnNpZGUgYSBibG9j",
"ay4KICAgICAgICBpZiAoYmxrICYmIGZtdC5MSVNUUy5oYXMoYmxrLmRhdGFzZXQudHlwZSkgJiYgIWJsay50ZXh0Q29udGVudCkgewogICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgICAgY29uc3QgbHZsID0gTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwOwogICAgICAgICAgaWYgKGx2bCA-IDApIGJsay5kYXRhc2V0LmxldmVsID0gU3RyaW5nKGx2bCAtIDEpOwogICAgICAgICAgZWxzZSBzZXRCbG9jayhibGssICdwJyk7CiAgICAgICAgICBjaGFuZ2VkKCk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGlmIChlLnNoaWZ0S2V5KSB7CiAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnaW5zZXJ0UGFyYWdyYXBoJyk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmIChlLmtleSA9PT0gJ0JhY2tzcGFjZScgJiYgIW1vZCAmJiBibGsgJiYgYmxrLmRhdGFzZXQudHlwZSAhPT0gJ3AnICYmIGNhcmV0QXRCbG9ja1N0YXJ0KHIsIGJsaykpIHsKICAgICAgICAvLyBBdCB0aGUgc3RhcnQgb2YgYSBsaXN0IGl0ZW0gb3IgaGVhZGluZywgQmFja3NwYWNlIHVuZG9lcyB0aGUKICAgICAgICAvLyBmb3JtYXR0aW5nIGJlZm9yZSBpdCBzdGFydHMgam9pbmluZyBsaW5lcy4KICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgY29uc3QgbHZsID0gTnVtYmVyKGJsay5kYXRhc2V0Lmxl",
"dmVsKSB8fCAwOwogICAgICAgIGlmIChmbXQuTElTVFMuaGFzKGJsay5kYXRhc2V0LnR5cGUpICYmIGx2bCA-IDApIGJsay5kYXRhc2V0LmxldmVsID0gU3RyaW5nKGx2bCAtIDEpOwogICAgICAgIGVsc2Ugc2V0QmxvY2soYmxrLCAncCcpOwogICAgICAgIGNoYW5nZWQoKTsKICAgICAgfQogICAgfSk7CgogICAgZWxzLmVkaXRvci5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIGUgPT4gewogICAgICBpZiAoZS5pbnB1dFR5cGUgPT09ICdpbnNlcnRUZXh0JyAmJiAoZS5kYXRhID09PSAnICcgfHwgZS5kYXRhID09PSAnwqAnKSkgYXV0b2Zvcm1hdCgpOwogICAgICBpZiAoZS5pbnB1dFR5cGUgPT09ICdpbnNlcnRQYXJhZ3JhcGgnKSB7CiAgICAgICAgLy8gVGhlIG5ldyBibG9jayBpcyBhIGNvcHkgb2YgdGhlIG9uZSBpdCB3YXMgc3BsaXQgZnJvbTogYSB0aWNrZWQKICAgICAgICAvLyBib3ggYW5kIGEgaGVhZGluZyBzaG91bGQgbm90IGNhcnJ5IG9uIGludG8gYW4gZW1wdHkgbmV3IGxpbmUuCiAgICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgICAgY29uc3QgYmxrID0gciAmJiBibG9ja09mKHIuc3RhcnRDb250YWluZXIpOwogICAgICAgIGlmIChibGsgJiYgIWJsay50ZXh0Q29udGVudCkgewogICAgICAgICAgaWYgKGJsay5kYXRhc2V0LnR5cGUgPT09ICdjaGVjaycpIGJsay5kYXRhc2V0LmNoZWNrZWQgPSAnMCc7CiAgICAgICAgICBpZiAoL15oWzEyM10kLy50ZXN0KGJsay5kYXRhc2V0LnR5cGUpKSBzZXRC",
"bG9jayhibGssICdwJyk7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmICgvXmRlbGV0ZS8udGVzdChlLmlucHV0VHlwZSkgJiYgZWxzLmVkaXRvci5jaGlsZHJlbi5sZW5ndGggPT09IDEgJiYgIWVscy5lZGl0b3IudGV4dENvbnRlbnQpIHsKICAgICAgICAvLyBFdmVyeXRoaW5nIGRlbGV0ZWQ6IHRoZSBub3RlIHN0YXJ0cyBhZ2FpbiBmcm9tIG5vcm1hbCB0ZXh0LgogICAgICAgIHNldEJsb2NrKGVscy5lZGl0b3IuZmlyc3RFbGVtZW50Q2hpbGQsICdwJyk7CiAgICAgIH0KICAgICAgY2hhbmdlZCgpOwogICAgfSk7CgogICAgZnVuY3Rpb24gYXV0b2Zvcm1hdCgpIHsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghciB8fCAhci5jb2xsYXBzZWQpIHJldHVybjsKICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKTsKICAgICAgaWYgKCFibGsgfHwgYmxrLmRhdGFzZXQudHlwZSAhPT0gJ3AnKSByZXR1cm47CiAgICAgIGNvbnN0IHByZSA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIHByZS5zZWxlY3ROb2RlQ29udGVudHMoYmxrKTsKICAgICAgcHJlLnNldEVuZChyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0KTsKICAgICAgY29uc3QgbSA9IC9eKFxTezEsM30pWyDCoF0kLy5leGVjKHByZS50b1N0cmluZygpKTsKICAgICAgY29uc3QgcnVsZSA9IG0gJiYgQVVUTy5maW5kKChbcmVdKSA9PiByZS50ZXN0KG1bMV0pKTsKICAgICAgaWYgKCFydWxlKSByZXR1",
"cm47CiAgICAgIHNlbGVjdChwcmUpOwogICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnZGVsZXRlJyk7CiAgICAgIHNldEJsb2NrKGJsaywgcnVsZVsxXS50eXBlLCAwLCAhIXJ1bGVbMV0uY2hlY2tlZCk7CiAgICB9CgogICAgZWxzLmVkaXRvci5hZGRFdmVudExpc3RlbmVyKCdwYXN0ZScsIGUgPT4gewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGlmICghZWRpdGFibGUpIHJldHVybjsKICAgICAgY29uc3QgZGF0YSA9IGUuY2xpcGJvYXJkRGF0YTsKICAgICAgY29uc3QgdGV4dCA9IChkYXRhICYmIGRhdGEuZ2V0RGF0YSgndGV4dC9wbGFpbicpKSB8fCAnJzsKICAgICAgY29uc3QgcGxhaW4gPSBwbGFpbk5leHQ7CiAgICAgIHBsYWluTmV4dCA9IGZhbHNlOwogICAgICBjb25zdCBkb2MgPSBwbGFpbiA_IG51bGwgOiBmbXQucGFzdGVEb2MoeyBodG1sOiBkYXRhICYmIGRhdGEuZ2V0RGF0YSgndGV4dC9odG1sJyksIHRleHQgfSk7CiAgICAgIGNvbnN0IGF0ID0gcmFuZ2UoKTsKICAgICAgaWYgKGF0ICYmIGNlbGxPZihhdC5zdGFydENvbnRhaW5lcikpIHsKICAgICAgICBwYXN0ZUluQ2VsbChkb2MsIHRleHQpOwogICAgICAgIHJldmVhbENhcmV0KCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIC8vIFRleHQgd2l0aCBub3RoaW5nIHRvIGZvcm1hdCBnb2VzIGluIHRoZSB3YXkgdHlwaW5nIGRvZXMsIHNvIHRoZQogICAgICAvLyBicm93c2VyJ3Mgb3duIHVuZG8gdGFrZXMgaXQgYmFjazogYSBz",
"aW5nbGUgbGluZSBhcyBjb3BpZWQsIHNwYWNlcwogICAgICAvLyBhbmQgYWxsOyBtb3JlIHRoYW4gdGhhdCBhcyB0aGUgSFRNTCByZWFkcyAoYSB0YWJsZSdzICIgfCAiLCBub3QKICAgICAgLy8gaXRzIHRhYnMpLgogICAgICBjb25zdCBsaW5lID0gdGV4dC5yZXBsYWNlKC9bXHJcbl0rJC8sICcnKTsKICAgICAgaWYgKGRvYyAmJiBmbXQuaGFzRm9ybWF0dGluZyhkb2MpKSBpbnNlcnREb2MoZG9jKTsKICAgICAgZWxzZSBpZiAoZG9jICYmICEoZG9jLmxlbmd0aCA9PT0gMSAmJiBsaW5lICYmICEvW1xyXG5cdF0vLnRlc3QobGluZSkpKSBpbnNlcnRQbGFpbihmbXQuZG9jVGV4dChkb2MpKTsKICAgICAgZWxzZSBpbnNlcnRQbGFpbihkb2MgPyBsaW5lIDogdGV4dCk7CiAgICAgIHJldmVhbENhcmV0KCk7CiAgICB9KTsKICAgIGVscy5lZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcignZHJvcCcsIGUgPT4gewogICAgICAvLyBEcm9wcGVkIEhUTUwgd291bGQgYnJpbmcgaXRzIG93biBtYXJrdXA7IGRyb3BwZWQgZmlsZXMgaGF2ZSBub3doZXJlIHRvIGdvLgogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICB9KTsKCiAgICBmdW5jdGlvbiBpbnNlcnRQbGFpbih0ZXh0KSB7CiAgICAgIGNvbnN0IGxpbmVzID0gU3RyaW5nKHRleHQpLnJlcGxhY2UoL1xyXG4_L2csICdcbicpLnNwbGl0KCdcbicpOwogICAgICBsaW5lcy5mb3JFYWNoKChsaW5lLCBpKSA9PiB7CiAgICAgICAgaWYgKGkpIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdp",
"bnNlcnRQYXJhZ3JhcGgnKTsKICAgICAgICBpZiAobGluZSkgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2luc2VydFRleHQnLCBmYWxzZSwgbGluZSk7CiAgICAgIH0pOwogICAgfQoKICAgIC8vIOKUgOKUgCBGb3JtYXR0ZWQgcGFzdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAvLwogICAgLy8gVGhlIGJsb2NrcyBnbyBpbiBkaXJlY3RseSAtIHRoZSBicm93c2VyJ3MgZWRpdGluZyBjb21tYW5kcyB3b3VsZAogICAgLy8gbmVzdCBhbmQgcmVzdHlsZSB0aGVtIC0gd2l0aCB0aGUgdGV4dCBhZnRlciB0aGUgY2FyZXQgY2FycmllZCB0bwogICAgLy8gdGhlIGVuZCBvZiB3aGF0IHdhcyBwYXN0ZWQuIFRoZSBicm93c2VyJ3MgdW5kbyBkb2VzIG5vdCBrbm93IGFib3V0CiAgICAvLyB0aGF0LCBzbyBDdHJsK1ogc3RyYWlnaHQgYWZ0ZXJ3YXJkcyBwdXRzIGJhY2sgYSBjb3B5IHRha2VuIGZpcnN0IC0KICAgIC8vIG9uZSBwYXN0ZSBhdCBhIHRpbWUsIHVudGlsIGFueXRoaW5nIGVsc2UgY2hhbmdlcyB0aGUgdGV4dC4KCiAgICAvLyBFbXB0eSB0ZXh0IGFuZCBlbXB0eSBtYXJrcyBsZWZ0IGJlaGluZCBieSBjdXR0aW5nIGEgYmxvY2sgaW4gdHdvOwogICAgLy8gYWxzbyB0aGUgPGJyPiB0aGF0IGhv",
"bGRzIGFuIGVtcHR5IGJsb2NrIG9wZW4sIHB1dCBiYWNrIGxhdGVyIGlmCiAgICAvLyB0aGUgYmxvY2sgaXMgc3RpbGwgZW1wdHkuCiAgICBmdW5jdGlvbiBwcnVuZShlbCkgewogICAgICBmb3IgKGNvbnN0IG4gb2YgWy4uLmVsLmNoaWxkTm9kZXNdKSB7CiAgICAgICAgaWYgKG4ubm9kZVR5cGUgPT09IDMpIHsgaWYgKCFuLmRhdGEpIG4ucmVtb3ZlKCk7IGNvbnRpbnVlOyB9CiAgICAgICAgaWYgKG4ubm9kZVR5cGUgIT09IDEgfHwgbi50YWdOYW1lID09PSAnQlInKSB7IG4ucmVtb3ZlKCk7IGNvbnRpbnVlOyB9CiAgICAgICAgcHJ1bmUobik7CiAgICAgICAgaWYgKCFuLmZpcnN0Q2hpbGQpIG4ucmVtb3ZlKCk7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGhvbGRPcGVuID0gZWwgPT4geyBpZiAoIWVsLmZpcnN0Q2hpbGQpIGVsLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2JyJykpOyB9OwoKICAgIGZ1bmN0aW9uIGluc2VydERvYyhkb2MpIHsKICAgICAgaWYgKCFyYW5nZSgpKSByZXN0b3JlKCk7CiAgICAgIGlmICghcmFuZ2UoKSkgcmV0dXJuOwogICAgICBjb25zdCB1bmRvID0gcGFzdGVVbmRvOwogICAgICBjb25zdCBiZWZvcmUgPSBzbmFwc2hvdCgpOwogICAgICBpZiAoIXJhbmdlKCkuY29sbGFwc2VkKSBkb2N1bWVudC5leGVjQ29tbWFuZCgnZGVsZXRlJyk7CiAgICAgIHRpZHkoKTsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIGlmICghcikgcmV0dXJuOwoKICAgICAgbGV0IG5v",
"ZGUgPSByLnN0YXJ0Q29udGFpbmVyOwogICAgICBsZXQgb2Zmc2V0ID0gci5zdGFydE9mZnNldDsKICAgICAgaWYgKG5vZGUgPT09IGVscy5lZGl0b3IpIHsKICAgICAgICBjb25zdCBraWRzID0gZWxzLmVkaXRvci5jaGlsZHJlbjsKICAgICAgICBjb25zdCBrID0gTWF0aC5taW4ob2Zmc2V0LCBraWRzLmxlbmd0aCAtIDEpOwogICAgICAgIG5vZGUgPSBraWRzW2tdOwogICAgICAgIG9mZnNldCA9IGsgPCBvZmZzZXQgPyBub2RlLmNoaWxkTm9kZXMubGVuZ3RoIDogMDsKICAgICAgfQogICAgICBjb25zdCBibGsgPSBibG9ja09mKG5vZGUpOwogICAgICBpZiAoIWJsaykgcmV0dXJuOwoKICAgICAgLy8gQ3V0IHRoZSBibG9jayBhdCB0aGUgY2FyZXQuCiAgICAgIGNvbnN0IGN1dCA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIGN1dC5zZXRTdGFydChub2RlLCBvZmZzZXQpOwogICAgICBjdXQuc2V0RW5kKGJsaywgYmxrLmNoaWxkTm9kZXMubGVuZ3RoKTsKICAgICAgY29uc3QgYWZ0ZXIgPSBjdXQuZXh0cmFjdENvbnRlbnRzKCk7CiAgICAgIHBydW5lKGFmdGVyKTsKICAgICAgcHJ1bmUoYmxrKTsKCiAgICAgIGNvbnN0IG9yaWcgPSB7IHR5cGU6IGJsay5kYXRhc2V0LnR5cGUgfHwgJ3AnLCBsZXZlbDogTnVtYmVyKGJsay5kYXRhc2V0LmxldmVsKSB8fCAwLCBjaGVja2VkOiBibGsuZGF0YXNldC5jaGVja2VkID09PSAnMScgfTsKICAgICAgLy8gTGlzdHMgcGFzdGVkIGludG8gYSBsaXN0IGdvIGluIGF0IGl0",
"cyBsZXZlbC4KICAgICAgY29uc3QgYmFzZSA9IGZtdC5MSVNUUy5oYXMob3JpZy50eXBlKSA_IG9yaWcubGV2ZWwgOiAwOwogICAgICBjb25zdCBsZXZlbE9mID0gYiA9PiAoZm10LkxJU1RTLmhhcyhiLnR5cGUpID8gTWF0aC5taW4oZm10Lk1BWF9MRVZFTCwgYi5sZXZlbCArIGJhc2UpIDogMCk7CgogICAgICBsZXQgbGFzdCA9IGJsazsKICAgICAgbGV0IGkgPSAwOwogICAgICAvLyBUaGUgZmlyc3QgbGluZSBqb2lucyB0aGUgdGV4dCBiZWZvcmUgdGhlIGNhcmV0OyBvbiBhbiBlbXB0eSBsaW5lCiAgICAgIC8vIGl0IGFsc28gYnJpbmdzIGl0cyBraW5kIChhIGhlYWRpbmcsIGEgbGlzdCBpdGVtKSB3aXRoIGl0LgogICAgICBpZiAoZG9jWzBdLnR5cGUgIT09ICd0YWJsZScgJiYgKGRvY1swXS50eXBlID09PSAncCcgfHwgIWJsay50ZXh0Q29udGVudCkpIHsKICAgICAgICBpZiAoIWJsay50ZXh0Q29udGVudCAmJiBkb2NbMF0udHlwZSAhPT0gJ3AnKSBzZXRCbG9jayhibGssIGRvY1swXS50eXBlLCBsZXZlbE9mKGRvY1swXSksIGRvY1swXS5jaGVja2VkKTsKICAgICAgICBibGsuYXBwZW5kKC4uLmlubGluZU5vZGVzKGRvY1swXS5ydW5zKSk7CiAgICAgICAgaSA9IDE7CiAgICAgIH0KICAgICAgZm9yICg7IGkgPCBkb2MubGVuZ3RoOyBpKyspIHsKICAgICAgICBjb25zdCBlbCA9IGJsb2NrRWwoeyAuLi5kb2NbaV0sIGxldmVsOiBsZXZlbE9mKGRvY1tpXSkgfSk7CiAgICAgICAgbGFzdC5hZnRlcihlbCk7CiAgICAg",
"ICAgbGFzdCA9IGVsOwogICAgICB9CgogICAgICAvLyBUaGUgdGV4dCBhZnRlciB0aGUgY2FyZXQgZm9sbG93cyB0aGUgcGFzdGVkIHRleHQgLSBvbiBhIGxpbmUgb2YKICAgICAgLy8gaXRzIG93biBraW5kIGlmIHRoZSBwYXN0ZSBlbmRlZCBvbiBhIGRpZmZlcmVudCBraW5kIG9mIGxpbmUuCiAgICAgIGNvbnN0IGtpbmQgPSBlbCA9PiBgJHtlbC5kYXRhc2V0LnR5cGV9OiR7ZWwuZGF0YXNldC5sZXZlbCB8fCAwfWA7CiAgICAgIGxldCB0YXJnZXQgPSBsYXN0OwogICAgICBpZiAoYWZ0ZXIudGV4dENvbnRlbnQgJiYgbGFzdCAhPT0gYmxrICYmIGtpbmQobGFzdCkgIT09IGAke29yaWcudHlwZX06JHtiYXNlfWApIHsKICAgICAgICB0YXJnZXQgPSBibG9ja0VsKGZtdC5ibG9jayhvcmlnLnR5cGUsIFtdLCBvcmlnKSk7CiAgICAgICAgdGFyZ2V0LnJlcGxhY2VDaGlsZHJlbigpOwogICAgICAgIGxhc3QuYWZ0ZXIodGFyZ2V0KTsKICAgICAgfQogICAgICAvLyBOb3RoaW5nIGdvZXMgaW50byBhIHBhc3RlZCB0YWJsZTogdGhlIGN1cnNvciBnb2VzIHRvIGEgbGluZSBhZnRlciBpdC4KICAgICAgaWYgKGxhc3QuZGF0YXNldC50eXBlID09PSAndGFibGUnICYmIHRhcmdldCA9PT0gbGFzdCkgewogICAgICAgIHRhcmdldCA9IGJsb2NrRWwoZm10LmJsb2NrKCdwJykpOwogICAgICAgIHRhcmdldC5yZXBsYWNlQ2hpbGRyZW4oKTsKICAgICAgICBsYXN0LmFmdGVyKHRhcmdldCk7CiAgICAgIH0KICAgICAgaWYgKGxhc3QuZGF0",
"YXNldC50eXBlICE9PSAndGFibGUnKSBwcnVuZShsYXN0KTsKICAgICAgY29uc3QgYXQgPSB0YXJnZXQgPT09IGxhc3QgPyBsYXN0LmNoaWxkTm9kZXMubGVuZ3RoIDogMDsKICAgICAgdGFyZ2V0LmFwcGVuZChhZnRlcik7CiAgICAgIGhvbGRPcGVuKGJsayk7CiAgICAgIGlmIChsYXN0LmRhdGFzZXQudHlwZSAhPT0gJ3RhYmxlJykgaG9sZE9wZW4obGFzdCk7CiAgICAgIGhvbGRPcGVuKHRhcmdldCk7CiAgICAgIC8vIEEgdGFibGUgcGFzdGVkIG9uIGFuIGVtcHR5IGxpbmUgdGFrZXMgaXRzIHBsYWNlLgogICAgICBpZiAoZG9jWzBdLnR5cGUgPT09ICd0YWJsZScgJiYgIWJsay50ZXh0Q29udGVudCAmJiBibGsgIT09IHRhcmdldCkgYmxrLnJlbW92ZSgpOwogICAgICBpZiAobGFzdC5kYXRhc2V0LnR5cGUgPT09ICd0YWJsZScpIGNhcmV0SW50byh0YXJnZXQsIGZhbHNlKTsKICAgICAgZWxzZSBpZiAodGFyZ2V0ID09PSBsYXN0KSBwbGFjZUNhcmV0KGxhc3QsIGF0KTsKICAgICAgZWxzZSBwbGFjZUNhcmV0KGxhc3QsIGxhc3QuZmlyc3RDaGlsZC5ub2RlTmFtZSA9PT0gJ0JSJyA_IDAgOiBsYXN0LmNoaWxkTm9kZXMubGVuZ3RoKTsKCiAgICAgIGNoYW5nZWQoKTsKICAgICAgcGFzdGVVbmRvID0gWy4uLnVuZG8uc2xpY2UoLTE5KSwgYmVmb3JlXTsKICAgIH0KCiAgICAvLyBUaGUgZWRpdG9yJ3MgYmxvY2tzLCBhbmQgdGhlIHNlbGVjdGlvbiBhcyB0ZXh0IG9mZnNldHMgd2l0aGluIHRoZW0uCiAgICBmdW5jdGlvbiBz",
"bmFwc2hvdCgpIHsKICAgICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICAgIHJldHVybiB7CiAgICAgICAgbm9kZXM6IFsuLi5lbHMuZWRpdG9yLmNoaWxkTm9kZXNdLm1hcChuID0-IG4uY2xvbmVOb2RlKHRydWUpKSwKICAgICAgICBzdGFydDogciAmJiB3aGVyZShyLnN0YXJ0Q29udGFpbmVyLCByLnN0YXJ0T2Zmc2V0KSwKICAgICAgICBlbmQ6IHIgJiYgd2hlcmUoci5lbmRDb250YWluZXIsIHIuZW5kT2Zmc2V0KSwKICAgICAgfTsKICAgIH0KCiAgICBmdW5jdGlvbiB3aGVyZShub2RlLCBvZmZzZXQpIHsKICAgICAgY29uc3Qga2lkcyA9IFsuLi5lbHMuZWRpdG9yLmNoaWxkTm9kZXNdOwogICAgICBpZiAobm9kZSA9PT0gZWxzLmVkaXRvcikgewogICAgICAgIGNvbnN0IGsgPSBNYXRoLm1pbihvZmZzZXQsIGtpZHMubGVuZ3RoIC0gMSk7CiAgICAgICAgcmV0dXJuIGsgPCAwID8gbnVsbCA6IHsgYjogaywgbzogayA8IG9mZnNldCA_IGtpZHNba10udGV4dENvbnRlbnQubGVuZ3RoIDogMCB9OwogICAgICB9CiAgICAgIGNvbnN0IGJsayA9IGJsb2NrT2Yobm9kZSk7CiAgICAgIGlmICghYmxrKSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTsKICAgICAgcHJlLnNlbGVjdE5vZGVDb250ZW50cyhibGspOwogICAgICBwcmUuc2V0RW5kKG5vZGUsIG9mZnNldCk7CiAgICAgIHJldHVybiB7IGI6IGtpZHMuaW5kZXhPZihibGspLCBvOiBwcmUudG9TdHJpbmcoKS5sZW5ndGgg",
"fTsKICAgIH0KCiAgICBmdW5jdGlvbiBwb2ludEF0KHApIHsKICAgICAgY29uc3QgYmxrID0gcCAmJiBlbHMuZWRpdG9yLmNoaWxkTm9kZXNbcC5iXTsKICAgICAgaWYgKCFibGspIHJldHVybiBudWxsOwogICAgICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKGJsaywgTm9kZUZpbHRlci5TSE9XX1RFWFQpOwogICAgICBsZXQgbGVmdCA9IHAubzsKICAgICAgZm9yIChsZXQgbiA9IHdhbGtlci5uZXh0Tm9kZSgpOyBuOyBuID0gd2Fsa2VyLm5leHROb2RlKCkpIHsKICAgICAgICBpZiAobGVmdCA8PSBuLmRhdGEubGVuZ3RoKSByZXR1cm4gW24sIGxlZnRdOwogICAgICAgIGxlZnQgLT0gbi5kYXRhLmxlbmd0aDsKICAgICAgfQogICAgICByZXR1cm4gW2JsaywgMF07CiAgICB9CgogICAgZnVuY3Rpb24gdW5kb1Bhc3RlKCkgewogICAgICBjb25zdCByZXN0ID0gcGFzdGVVbmRvLnNsaWNlKDAsIC0xKTsKICAgICAgY29uc3Qgc25hcCA9IHBhc3RlVW5kb1twYXN0ZVVuZG8ubGVuZ3RoIC0gMV07CiAgICAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKC4uLnNuYXAubm9kZXMpOwogICAgICBjb25zdCBhID0gcG9pbnRBdChzbmFwLnN0YXJ0KTsKICAgICAgY29uc3QgeiA9IHBvaW50QXQoc25hcC5lbmQpOwogICAgICBpZiAoYSAmJiB6KSB7CiAgICAgICAgY29uc3QgYmFjayA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgICAgYmFjay5zZXRTdGFydCguLi5hKTsKICAgICAgICBiYWNr",
"LnNldEVuZCguLi56KTsKICAgICAgICBzZWxlY3QoYmFjayk7CiAgICAgIH0KICAgICAgY2hhbmdlZCgpOwogICAgICBwYXN0ZVVuZG8gPSByZXN0OwogICAgICByZXZlYWxDYXJldCgpOwogICAgfQoKICAgIC8vIFNjcm9sbHMgdGhlIGVkaXRvciwgaWYgaXQgaGFzIHRvLCB0byBzaG93IHRoZSBjYXJldC4KICAgIGZ1bmN0aW9uIHJldmVhbENhcmV0KCkgewogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyKSByZXR1cm47CiAgICAgIGxldCBhdCA9IHIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICAgIGlmICghYXQuaGVpZ2h0KSB7CiAgICAgICAgY29uc3QgYmxrID0gYmxvY2tPZihyLnN0YXJ0Q29udGFpbmVyKTsKICAgICAgICBpZiAoYmxrKSBhdCA9IGJsay5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgfQogICAgICBjb25zdCBib3ggPSBlbHMuZWRpdG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICBpZiAoYXQuYm90dG9tID4gYm94LmJvdHRvbSAtIDgpIGVscy5lZGl0b3Iuc2Nyb2xsVG9wICs9IGF0LmJvdHRvbSAtIGJveC5ib3R0b20gKyAyNDsKICAgICAgZWxzZSBpZiAoYXQudG9wIDwgYm94LnRvcCArIDgpIGVscy5lZGl0b3Iuc2Nyb2xsVG9wIC09IGJveC50b3AgLSBhdC50b3AgKyAyNDsKICAgIH0KCiAgICBlbHMuZWRpdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZSA9PiB7CiAgICAgIGNvbnN0IGEgPSBlLnRhcmdldC5jbG9zZXN0ICYmIGUudGFyZ2V0",
"LmNsb3Nlc3QoJ2FbaHJlZl0nKTsKICAgICAgaWYgKGEgJiYgKGUuY3RybEtleSB8fCBlLm1ldGFLZXkpKSB7CiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIHdpbmRvdy5vcGVuKGEuaHJlZiwgJ19ibGFuaycsICdub29wZW5lcicpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICAvLyBUaGUgYm94IGlzIGRyYXduIGluIHRoZSBibG9jaydzIGxlZnQgcGFkZGluZywgYXQgaXRzIGluZGVudC4KICAgICAgY29uc3QgYmxrID0gZS50YXJnZXQuY2xvc2VzdCAmJiBlLnRhcmdldC5jbG9zZXN0KCcuYmxrW2RhdGEtdHlwZT0iY2hlY2siXScpOwogICAgICBpZiAoYmxrICYmIGVkaXRhYmxlKSB7CiAgICAgICAgY29uc3QgeCA9IGUuY2xpZW50WCAtIGJsay5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5sZWZ0OwogICAgICAgIGNvbnN0IGF0ID0gKE51bWJlcihibGsuZGF0YXNldC5sZXZlbCkgfHwgMCkgKiBJTkRFTlRfUFg7CiAgICAgICAgaWYgKHggPj0gYXQgJiYgeCA8IGF0ICsgMjYpIHRvZ2dsZUNoZWNrKGJsayk7CiAgICAgIH0KICAgIH0pOwoKICAgIGNvbnN0IG9uU2VsZWN0aW9uID0gKCkgPT4gewogICAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgICAgaWYgKCFyKSByZXR1cm47CiAgICAgIHNhdmVkID0gci5jbG9uZVJhbmdlKCk7CiAgICAgIHJlZnJlc2hUb29sYmFyKCk7CiAgICB9OwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignc2VsZWN0aW9uY2hhbmdlJywgb25TZWxlY3Rpb24p",
"OwoKICAgIC8vIOKUgOKUgCBTZWFyY2ggaGlnaGxpZ2h0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIC8vCiAgICAvLyBQYWludGVkIHdpdGggdGhlIENTUyBDdXN0b20gSGlnaGxpZ2h0IEFQSTogcmFuZ2VzIG92ZXIgdGhlIHRleHQsCiAgICAvLyBjb2xvdXJlZCBieSB0aGUgc3R5bGVzaGVldCwgd2l0aCBub3RoaW5nIGFkZGVkIHRvIHRoZSBtYXJrdXAgLSBzbyBhCiAgICAvLyBoaWdobGlnaHQgY2FuIG5ldmVyIGVuZCB1cCBzYXZlZCBpbnRvIHRoZSBub3RlLgoKICAgIGxldCBtYXRjaFJhbmdlcyA9IFtdOwogICAgY29uc3QgY2FuSGlnaGxpZ2h0ID0gKCkgPT4gdHlwZW9mIENTUyAhPT0gJ3VuZGVmaW5lZCcgJiYgQ1NTLmhpZ2hsaWdodHMgJiYgdHlwZW9mIEhpZ2hsaWdodCA9PT0gJ2Z1bmN0aW9uJzsKCiAgICAvLyBUaGUgZWRpdG9yJ3MgdGV4dCB3aXRoIGEgbGluZSBicmVhayBiZXR3ZWVuIGJsb2NrcywgYW5kIHdoZXJlIGVhY2gKICAgIC8vIHRleHQgbm9kZSBzaXRzIGluIGl0LgogICAgZnVuY3Rpb24gdGV4dEluZGV4KCkgewogICAgICBjb25zdCBwYXJ0cyA9IFtdOwogICAgICBsZXQgdGV4dCA9ICcnOwogICAgICBlbHMuZWRpdG9yLmNoaWxkTm9kZXMuZm9yRWFjaCgoYmxrLCBiKSA9",
"PiB7CiAgICAgICAgaWYgKGIpIHRleHQgKz0gJ1xuJzsKICAgICAgICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKGJsaywgTm9kZUZpbHRlci5TSE9XX1RFWFQpOwogICAgICAgIGZvciAobGV0IG4gPSB3YWxrZXIubmV4dE5vZGUoKTsgbjsgbiA9IHdhbGtlci5uZXh0Tm9kZSgpKSB7CiAgICAgICAgICBwYXJ0cy5wdXNoKHsgbm9kZTogbiwgc3RhcnQ6IHRleHQubGVuZ3RoLCBlbmQ6IHRleHQubGVuZ3RoICsgbi5kYXRhLmxlbmd0aCB9KTsKICAgICAgICAgIHRleHQgKz0gbi5kYXRhOwogICAgICAgIH0KICAgICAgfSk7CiAgICAgIHJldHVybiB7IHRleHQsIHBhcnRzIH07CiAgICB9CgogICAgZnVuY3Rpb24gcmFuZ2VGb3IoaWR4LCBzdGFydCwgZW5kKSB7CiAgICAgIGNvbnN0IGEgPSBpZHgucGFydHMuZmluZChwID0-IHN0YXJ0ID49IHAuc3RhcnQgJiYgc3RhcnQgPCBwLmVuZCk7CiAgICAgIGNvbnN0IGIgPSBpZHgucGFydHMuZmluZChwID0-IGVuZCA-IHAuc3RhcnQgJiYgZW5kIDw9IHAuZW5kKTsKICAgICAgaWYgKCFhIHx8ICFiKSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgciA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7CiAgICAgIHIuc2V0U3RhcnQoYS5ub2RlLCBzdGFydCAtIGEuc3RhcnQpOwogICAgICByLnNldEVuZChiLm5vZGUsIGVuZCAtIGIuc3RhcnQpOwogICAgICByZXR1cm4gcjsKICAgIH0KCiAgICBmdW5jdGlvbiBoaWdobGlnaHQodGVybXMpIHsKICAgICAgY2xl",
"YXJIaWdobGlnaHRzKCk7CiAgICAgIGlmICghdGVybXMgfHwgIXRlcm1zLmxlbmd0aCB8fCAhY2FuSGlnaGxpZ2h0KCkpIHJldHVybiAwOwogICAgICBjb25zdCBpZHggPSB0ZXh0SW5kZXgoKTsKICAgICAgbWF0Y2hSYW5nZXMgPSBucy5zZWFyY2hMb2dpYy5maW5kTWF0Y2hlcyhpZHgudGV4dCwgdGVybXMpLm1hcChtID0-IHJhbmdlRm9yKGlkeCwgbS5zdGFydCwgbS5lbmQpKS5maWx0ZXIoQm9vbGVhbik7CiAgICAgIGlmIChtYXRjaFJhbmdlcy5sZW5ndGgpIENTUy5oaWdobGlnaHRzLnNldCgnZ2tiLW1hdGNoJywgbmV3IEhpZ2hsaWdodCguLi5tYXRjaFJhbmdlcykpOwogICAgICByZXR1cm4gbWF0Y2hSYW5nZXMubGVuZ3RoOwogICAgfQoKICAgIC8vIE1hcmtzIG9uZSBtYXRjaCBhcyB0aGUgY3VycmVudCBvbmUgYW5kIHNjcm9sbHMgaXQgaW50byB0aGUgbWlkZGxlCiAgICAvLyB0aGlyZCBvZiB0aGUgZWRpdG9yIGlmIGl0IGlzIG91dCBvZiB2aWV3LgogICAgZnVuY3Rpb24gc2hvd01hdGNoKGkpIHsKICAgICAgY29uc3QgciA9IG1hdGNoUmFuZ2VzW2ldOwogICAgICBpZiAoIXIgfHwgIWNhbkhpZ2hsaWdodCgpKSByZXR1cm47CiAgICAgIENTUy5oaWdobGlnaHRzLnNldCgnZ2tiLW1hdGNoLWN1cnJlbnQnLCBuZXcgSGlnaGxpZ2h0KHIpKTsKICAgICAgY29uc3QgYm94ID0gZWxzLmVkaXRvci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgICAgY29uc3QgYXQgPSByLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgp",
"OwogICAgICBpZiAoYXQudG9wIDwgYm94LnRvcCArIDI0IHx8IGF0LmJvdHRvbSA-IGJveC5ib3R0b20gLSAyNCkgewogICAgICAgIGVscy5lZGl0b3Iuc2Nyb2xsVG9wICs9IGF0LnRvcCAtIGJveC50b3AgLSBib3guaGVpZ2h0IC8gMzsKICAgICAgfQogICAgfQoKICAgIGZ1bmN0aW9uIGNsZWFySGlnaGxpZ2h0cygpIHsKICAgICAgbWF0Y2hSYW5nZXMgPSBbXTsKICAgICAgaWYgKCFjYW5IaWdobGlnaHQoKSkgcmV0dXJuOwogICAgICBDU1MuaGlnaGxpZ2h0cy5kZWxldGUoJ2drYi1tYXRjaCcpOwogICAgICBDU1MuaGlnaGxpZ2h0cy5kZWxldGUoJ2drYi1tYXRjaC1jdXJyZW50Jyk7CiAgICB9CgogICAgLy8g4pSA4pSAIEFQSSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgICBmdW5jdGlvbiBzZXREb2MoZG9jKSB7CiAgICAgIHBhc3RlVW5kbyA9IFtdOwogICAgICBsYXN0Q2VsbCA9IG51bGw7CiAgICAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKC4uLmZtdC5ub3JtYWxpc2VEb2MoZG9jKS5tYXAoYmxvY2tFbCkpOwogICAgICBmb3IgKGNvbnN0IHRkIG9mIGVscy5lZGl0b3IucXVlcnlTZWxlY3RvckFsbCgndGQnKSkg",
"dGQuY29udGVudEVkaXRhYmxlID0gZWRpdGFibGUgPyAndHJ1ZScgOiAnZmFsc2UnOwogICAgICB1cGRhdGVFbXB0eSgpOwogICAgfQoKICAgIC8vIE5ldyB0ZXh0IHVuZGVyIHNvbWVvbmUgd2hvIG1heSBiZSB0eXBpbmcgLSBhIG5ld2VyIHZlcnNpb24gbWVyZ2VkCiAgICAvLyBpbjogdGhlIHNhbWUgdGV4dCBib3gsIHNvIHRoZSBmb2N1cyBhbmQgYSBwaG9uZSdzIGtleWJvYXJkIHN0YXksCiAgICAvLyBhbmQgdGhlIGN1cnNvciBnb2VzIHRvIHdoZXJlIGl0cyBibG9jayB3ZW50IChgbWFwYCwgb2xkIGJsb2NrCiAgICAvLyBpbmRleCDihpIgbmV3KSwgYXMgZmFyIGFsb25nIGl0IGFzIGl0IHdhcy4KICAgIGZ1bmN0aW9uIHJlcGxhY2VEb2MoZG9jLCBtYXApIHsKICAgICAgY29uc3QgZm9jdXNlZCA9IHJvb3QuYWN0aXZlRWxlbWVudCA9PT0gZWxzLmVkaXRvciB8fCBlbHMuZWRpdG9yLmNvbnRhaW5zKHJvb3QuYWN0aXZlRWxlbWVudCk7CiAgICAgIGNvbnN0IHIgPSBmb2N1c2VkID8gcmFuZ2UoKSA6IG51bGw7CiAgICAgIGNvbnN0IGF0ID0gciAmJiBbd2hlcmUoci5zdGFydENvbnRhaW5lciwgci5zdGFydE9mZnNldCksIHdoZXJlKHIuZW5kQ29udGFpbmVyLCByLmVuZE9mZnNldCldOwogICAgICBzZXREb2MoZG9jKTsKICAgICAgaWYgKCFhdCB8fCAhYXRbMF0gfHwgIWF0WzFdKSByZXR1cm47CiAgICAgIGNvbnN0IGtpZHMgPSBlbHMuZWRpdG9yLmNoaWxkTm9kZXM7CiAgICAgIGNvbnN0IG1vdmVkID0gcCA9PiB7",
"CiAgICAgICAgY29uc3QgYiA9IE1hdGgubWF4KDAsIE1hdGgubWluKGtpZHMubGVuZ3RoIC0gMSwgbWFwICYmIG1hcFtwLmJdICE9PSB1bmRlZmluZWQgPyBtYXBbcC5iXSA6IHAuYikpOwogICAgICAgIHJldHVybiB7IGIsIG86IE1hdGgubWluKHAubywga2lkc1tiXSA_IGtpZHNbYl0udGV4dENvbnRlbnQubGVuZ3RoIDogMCkgfTsKICAgICAgfTsKICAgICAgY29uc3QgYSA9IHBvaW50QXQobW92ZWQoYXRbMF0pKTsKICAgICAgY29uc3QgeiA9IHBvaW50QXQobW92ZWQoYXRbMV0pKTsKICAgICAgaWYgKCFhIHx8ICF6KSByZXR1cm47CiAgICAgIHRyeSB7CiAgICAgICAgLy8gSW4gYSB0YWJsZSwgdGhlIG5ldyBjZWxsIHRha2VzIHRoZSBmb2N1cyB0aGUgb2xkIG9uZSBoYWQuCiAgICAgICAgY29uc3QgaG9zdCA9IGNlbGxPZihhWzBdKSB8fCBlbHMuZWRpdG9yOwogICAgICAgIGlmIChyb290LmFjdGl2ZUVsZW1lbnQgIT09IGhvc3QpIGhvc3QuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgICAgIGNvbnN0IGJhY2sgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpOwogICAgICAgIGJhY2suc2V0U3RhcnQoLi4uYSk7CiAgICAgICAgYmFjay5zZXRFbmQoLi4ueik7CiAgICAgICAgc2VsZWN0KGJhY2spOwogICAgICB9IGNhdGNoIHsgLyogdGhlIGN1cnNvciBzdGF5cyB3aGVyZSB0aGUgYnJvd3NlciBwdXQgaXQgKi8gfQogICAgfQoKICAgIGZ1bmN0aW9uIHNldEVkaXRhYmxlKG9uLCBwbGFjZWhvbGRlcikg",
"ewogICAgICBlZGl0YWJsZSA9ICEhb247CiAgICAgIGVscy5lZGl0b3IuY29udGVudEVkaXRhYmxlID0gZWRpdGFibGUgPyAndHJ1ZScgOiAnZmFsc2UnOwogICAgICBlbHMuZWRpdG9yLmRhdGFzZXQucGxhY2Vob2xkZXIgPSBwbGFjZWhvbGRlciB8fCAnV3JpdGUgaGVyZeKApic7CiAgICAgIGVscy5lZGl0b3Iuc2V0QXR0cmlidXRlKCdhcmlhLWRpc2FibGVkJywgU3RyaW5nKCFlZGl0YWJsZSkpOwogICAgICBmb3IgKGNvbnN0IGIgb2YgWy4uLmVscy50b29sYmFyLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpXSkgYi5kaXNhYmxlZCA9ICFlZGl0YWJsZTsKICAgICAgZm9yIChjb25zdCB0ZCBvZiBlbHMuZWRpdG9yLnF1ZXJ5U2VsZWN0b3JBbGwoJ3RkJykpIHRkLmNvbnRlbnRFZGl0YWJsZSA9IGVkaXRhYmxlID8gJ3RydWUnIDogJ2ZhbHNlJzsKICAgICAgaWYgKCFlZGl0YWJsZSkgZWxzLnRhYmxlYmFyLmhpZGRlbiA9IHRydWU7CiAgICB9CgogICAgZnVuY3Rpb24gZm9jdXMoKSB7CiAgICAgIGVscy5lZGl0b3IuZm9jdXMoKTsKICAgICAgY29uc3QgZmlyc3QgPSBlbHMuZWRpdG9yLmZpcnN0Q2hpbGQ7CiAgICAgIGlmIChmaXJzdCkgcGxhY2VDYXJldChmaXJzdCwgMCk7CiAgICB9CgogICAgZnVuY3Rpb24gZGVzdHJveSgpIHsKICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcignc2VsZWN0aW9uY2hhbmdlJywgb25TZWxlY3Rpb24pOwogICAgICBjbGVhckhpZ2hsaWdodHMoKTsKICAgICAgY2xvc2VN",
"ZW51KHJvb3QpOwogICAgfQoKICAgIHJldHVybiB7CiAgICAgIGVsZW1lbnQ6IGVscy5lZGl0b3IsCiAgICAgIHRvb2xiYXI6IGVscy50b29sYmFyLAogICAgICBsaW5rYmFyOiBlbHMubGlua2JhciwKICAgICAgdGFibGViYXI6IGVscy50YWJsZWJhciwKICAgICAgc2V0RG9jLAogICAgICByZXBsYWNlRG9jLAogICAgICBnZXREb2M6ICgpID0-IHJlYWREb2MoZWxzLmVkaXRvciksCiAgICAgIHNldEVkaXRhYmxlLAogICAgICBmb2N1cywKICAgICAgZGVzdHJveSwKICAgICAgaGlnaGxpZ2h0LAogICAgICBzaG93TWF0Y2gsCiAgICAgIGNsZWFySGlnaGxpZ2h0cywKICAgICAgbWF0Y2hDb3VudDogKCkgPT4gbWF0Y2hSYW5nZXMubGVuZ3RoLAogICAgfTsKICB9CgogIG5zLm5vdGVFZGl0b3IgPSB7IGNyZWF0ZSwgcmVhZERvYyB9Owp9KSgpOwo\"],[\"addon/app/remote.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyB3YXkgdG8gR21haWwKLy8KLy8gVGhlIE5vdGVzIHZpZXcgKHNyYy9jb250ZW50L25vdGVzLmpzKSB0YWxrcyB0byBhIG5vdGVzU3Rvcm",
"UsIGFuZCB0aGUKLy8gYm9hcmQncyBkYXRhIGxheWVyIChzcmMvY29udGVudC9zdG9yZS5qcykgdG8gYGFwaS5nbWFpbGAgYW5kCi8vIGBjaHJvbWUuc3RvcmFnZWAuIEluIHRoZSBleHRlbnNpb24gdGhvc2UgcmVhY2ggR21haWwgdGhyb3VnaCB0aGUKLy8gYmFja2dyb3VuZCB3b3JrZXI7IGhlcmUgdGhleSBhc2sgdGhlIHNjcmlwdCB0aGF0IHNlcnZlZCB0aGlzIHBhZ2UsCi8vIHRocm91Z2ggZ29vZ2xlLnNjcmlwdC5ydW4sIHdoaWNoIGFza3MgR21haWwuIFNhbWUgc2hhcGVzLCBzYW1lIGFuc3dlcnMsCi8vIHNvIHRoZSB2aWV3cyBydW4gdW5jaGFuZ2VkLiBUaGUgY2FsZW5kYXIsIGxpa2V3aXNlLCB0aHJvdWdoCi8vIGBhcGkuZ29vZ2xlTWFueWAuIEFsc28gYGhvb2tzYDogdGhlIGFjY291bnQsIGFuZCBvcGVuaW5nIGEKLy8gY29udmVyc2F0aW9uIGluIEdtYWlsLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCBmbXQgPS",
"Bucy5ub3RlRm9ybWF0OwogIGNvbnN0IG5vdGVzTG9naWMgPSBucy5ub3Rlc0xvZ2ljOwoKICAvLyBnb29nbGUuc2NyaXB0LnJ1biBhcyBhIHByb21pc2UuIEEgcmVmdXNhbCBmcm9tIHRoZSBzY3JpcHQgYXJyaXZlcyBhcwogIC8vICJub3RfYWxsb3dlZDog4oCmIiwgd2hpY2ggdGhlIHZpZXcga25vd3MgdG8gZXhwbGFpbi4KICBmdW5jdGlvbiBjYWxsKGZuLCAuLi5hcmdzKSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgICBnb29nbGUuc2NyaXB0LnJ1bgogICAgICAgIC53aXRoU3VjY2Vzc0hhbmRsZXIocmVzb2x2ZSkKICAgICAgICAud2l0aEZhaWx1cmVIYW5kbGVyKGVyciA9PiB7CiAgICAgICAgICBjb25zdCB0ZXh0ID0gU3RyaW5nKChlcnIgJiYgZXJyLm1lc3NhZ2UpIHx8IGVyciB8fCAnU29tZXRoaW5nIHdlbnQgd3JvbmcnKS5yZXBsYWNlKC9eKEV4Y2VwdGlvbnxFcnJvcik6XHMqLywgJycpOwogICAgICAgICAgY29uc3QgZSA9IG5ldyBFcnJvcih0ZXh0LnJlcGxhY2UoL15ub3RfYWxsb3dlZDpccyovLCAnJykpOwogICAgICAgICAgaWYgKC9ebm90X2FsbG93ZWQ6Ly50ZXN0KHRleHQpKSBlLmNvZGUgPSAnbm90X2FsbG93ZWQnOwogICAgICAgICAgcmVqZWN0KGUpOwogICAgICAgIH0pW2ZuXSguLi5hcmdzKTsKICAgIH0pOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBwaG9uZSdzIG93biBjb3B5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgO",
"KUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gU28gdGhhdCB0aGUgYXBwIG9wZW5zIGF0IG9uY2UsIHRoaXMgYnJvd3NlciBrZWVwcyB3aGF0IHRoZSBub3RlcyBuZWVkCiAgLy8gYmVmb3JlIEdtYWlsIGhhcyBhbnN3ZXJlZDogd2hvc2UgdGhleSBhcmUsIHRoZSBsaXN0ICh0aXRsZXMgYW5kIGZpcnN0CiAgLy8gbGluZXMpLCB0aGUgc2NyYXRjaHBhZCdzIHRleHQgYW5kIHRoZSBhcHAncyBzZXR0aW5ncyAtIGFuZCwgYXBhcnQsCiAgLy8gc2NyYXRjaHBhZCB0ZXh0IHR5cGVkIGJ1dCBub3QgeWV0IHNhdmVkLiBUaGUgcGFnZSBvcGVucyBvbiB0aGVzZSwgYW5kCiAgLy8gR21haWwncyBhbnN3ZXJzIHJlcGxhY2UgdGhlbSBhIG1vbWVudCBsYXRlci4gVGhleSBuZXZlciBsZWF2ZSB0aGUgcGhvbmUuCgogIGNvbnN0IENPUFkgPSAnbWVtZGVzay5jb3B5JzsKICBjb25zdCBEUkFGVCA9ICdtZW1kZXNrLmRyYWZ0JzsKICBjb25zdCByZWFkSnNvbiA9IGtleSA9PiB7CiAgICB0cnkgeyByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpIHx8ICdudWxsJyk7IH0gY2F0Y2ggKGVycikgeyByZXR1cm4gbnVsbDsgfQogIH07CiAgY29uc3Qgd3JpdGVKc29uID0gKGtleSwgdmFsdWUpID0-IHsKICAgIHRyeSB7CiAgICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgbG9jYW",
"xTdG9yYWdlLnJlbW92ZUl0ZW0oa2V5KTsKICAgICAgZWxzZSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7CiAgICB9IGNhdGNoIChlcnIpIHsgLyogc3RvcmFnZSBvZmYgb3IgZnVsbDogbm8gY29weSwgb25seSBhIHNsb3dlciBzdGFydCAqLyB9CiAgfTsKICBjb25zdCByZWFkID0gcmVhZEpzb24oQ09QWSk7CiAgLy8geyBhY2NvdW50LCBsYWJlbCwgZm9sZGVycywgbm90ZXMsIHRydW5jYXRlZCwgc2NyYXRjaCwgcHJlZnMsIGNvbHVtbnMgfTsKICAvLyBzY3JhdGNoIGlzIHsgbm90ZSwgZG9jIH0sIG9yIG51bGwgb25jZSBHbWFpbCBoYXMgc2FpZCB0aGVyZSBpcyBub25lLgogIGNvbnN0IGtlcHQgPSByZWFkICYmIHJlYWQudiA9PT0gMSAmJiByZWFkLmFjY291bnQgPyByZWFkIDogeyB2OiAxIH07CiAgbGV0IGtlZXBUaW1lciA9IDA7CiAgY29uc3Qga2VlcENvcHkgPSAoKSA9PiB7CiAgICBjbGVhclRpbWVvdXQoa2VlcFRpbWVyKTsKICAgIGtlZXBUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gd3JpdGVKc29uKENPUFksIGtlcHQpLCAxNTApOwogIH07CiAgY29uc3QgZm9yZ2V0Q29weSA9ICgpID0-IHsKICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhrZXB0KSkgZGVsZXRlIGtlcHRba107CiAgICBrZXB0LnYgPSAxOwogICAgd3JpdGVKc29uKENPUFksIG51bGwpOwogICAgd3JpdGVKc29uKERSQUZULCBudWxsKTsKICB9OwoKICAvLyBUaGUgbGlzdGluZydzIGZpZW",
"xkcyBvZiBhIG5vdGUsIGFuZCBub3RoaW5nIGVsc2UuCiAgY29uc3QgcGxhaW5Ob3RlID0gbiA9PiBuICYmIHsKICAgIG1lc3NhZ2VJZDogbi5tZXNzYWdlSWQsIHRocmVhZElkOiBuLnRocmVhZElkLCBub3RlSWQ6IG4ubm90ZUlkLCBvd246IG4ub3duLCBrZXk6IG4ua2V5LAogICAgdGl0bGU6IG4udGl0bGUsIHVwZGF0ZWQ6IG4udXBkYXRlZCwgc25pcHBldDogbi5zbmlwcGV0LCBsYWJlbElkczogbi5sYWJlbElkcywgZm9sZGVySWQ6IG4uZm9sZGVySWQgfHwgJycsCiAgfTsKICBjb25zdCBpc1NjcmF0Y2ggPSBuID0-ICEhbiAmJiBuLm5vdGVJZCA9PT0gbm90ZXNMb2dpYy5TQ1JBVENIUEFEX0lEOwogIC8vIFRoZSBzY3JhdGNocGFkJ3MgdGV4dCwgd2hlbiBpdCBpcyB0aGUgbmV3ZXN0IHZlcnNpb24gc2Vlbi4KICBmdW5jdGlvbiBrZWVwU2NyYXRjaChub3RlLCBkb2MpIHsKICAgIGNvbnN0IGhhZCA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZTsKICAgIGlmIChoYWQgJiYgaGFkLm1lc3NhZ2VJZCAhPT0gbm90ZS5tZXNzYWdlSWQgJiYgaGFkLnVwZGF0ZWQgPiBub3RlLnVwZGF0ZWQpIHJldHVybjsKICAgIGtlcHQuc2NyYXRjaCA9IHsgbm90ZTogcGxhaW5Ob3RlKG5vdGUpLCBkb2MgfTsKICAgIGtlZXBDb3B5KCk7CiAgfQoKICBjb25zdCBTID0gewogICAgbGFiZWw6IGtlcHQubGFiZWwgfHwgJ19Ob3RlcycsCiAgICBmb2xkZXJzOiBrZXB0LmZvbGRlcnMgfHwgW10sCiAgICBkb2NzOiBuZXcgTW",
"FwKCksIC8vIG1lc3NhZ2UgaWQg4oaSIGNvbnRlbnQsIGZyb20gYSBzZWFyY2ggb3IgYSBzYXZlCiAgfTsKICBpZiAoa2VwdC5zY3JhdGNoICYmIGtlcHQuc2NyYXRjaC5ub3RlKSBTLmRvY3Muc2V0KGtlcHQuc2NyYXRjaC5ub3RlLm1lc3NhZ2VJZCwga2VwdC5zY3JhdGNoLmRvYyk7CgogIG5zLm5vdGVzU3RvcmUgPSB7CiAgICBsYWJlbE5hbWU6ICgpID0-IFMubGFiZWwsCiAgICBmb2xkZXJzOiAoKSA9PiBTLmZvbGRlcnMsCiAgICAvLyBBIHNhdmUgdGVsbHMgb2YgYSBuZXdlciB2ZXJzaW9uIHNhdmVkIGVsc2V3aGVyZSAoZXJyb3IgY29kZQogICAgLy8gImNvbmZsaWN0IiksIHNvIHRoZSB2aWV3IG1lcmdlcyByYXRoZXIgdGhhbiBvdmVyd3JpdGVzLgogICAgY2hlY2tzQ29uZmxpY3RzOiB0cnVlLAoKICAgIC8vIFdoYXQgdG8gc2hvdyBiZWZvcmUgR21haWwgYW5zd2VycyAobm90ZXMuanMgZnJvbUNvcHkpLCBvciBudWxsLgogICAgY2FjaGVkKCkgewogICAgICBpZiAoIWtlcHQuYWNjb3VudCkgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IGRyYWZ0ID0gcmVhZEpzb24oRFJBRlQpOwogICAgICByZXR1cm4gewogICAgICAgIG5vdGVzOiBrZXB0Lm5vdGVzIHx8IG51bGwsCiAgICAgICAgdHJ1bmNhdGVkOiAhIWtlcHQudHJ1bmNhdGVkLAogICAgICAgIGZvbGRlcnM6IGtlcHQuZm9sZGVycyB8fCBbXSwKICAgICAgICBzY3JhdGNoOiBrZXB0LnNjcmF0Y2ggPyBrZXB0LnNjcmF0Y2ggOiBrZXB0LnNjcmF0Y2ggPT09IG",
"51bGwgPyB7IG5vdGU6IG51bGwsIGRvYzogbnVsbCB9IDogbnVsbCwKICAgICAgICBkcmFmdDogZHJhZnQgJiYgZHJhZnQuYWNjb3VudCA9PT0ga2VwdC5hY2NvdW50ID8gZHJhZnQgOiBudWxsLAogICAgICB9OwogICAgfSwKCiAgICAvLyBUaGUgc2NyYXRjaHBhZCdzIHVuc2F2ZWQgdGV4dCwgb3IgbnVsbCBvbmNlIGl0IGlzIHNhdmVkLgogICAga2VlcERyYWZ0KGQpIHsKICAgICAgd3JpdGVKc29uKERSQUZULCBkID8geyBhY2NvdW50OiB3aG8uYWNjb3VudCwgbm90ZTogcGxhaW5Ob3RlKGQubm90ZSksIGJhc2U6IGQuYmFzZSwgZG9jOiBkLmRvYyB9IDogbnVsbCk7CiAgICB9LAoKICAgIGFzeW5jIGxpc3QoYWNjb3VudCwgcXVlcnkpIHsKICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGwoJ2FwcExpc3QnLCBxdWVyeSB8fCAnJyk7CiAgICAgIFMubGFiZWwgPSByLmxhYmVsOwogICAgICBTLmZvbGRlcnMgPSByLmZvbGRlcnMgfHwgW107CiAgICAgIE9iamVjdC5rZXlzKHIuZG9jcyB8fCB7fSkuZm9yRWFjaChpZCA9PiBTLmRvY3Muc2V0KGlkLCByLmRvY3NbaWRdKSk7CiAgICAgIGlmICghcXVlcnkpIHsKICAgICAgICBPYmplY3QuYXNzaWduKGtlcHQsIHsgbGFiZWw6IFMubGFiZWwsIGZvbGRlcnM6IFMuZm9sZGVycywgbm90ZXM6IHIubm90ZXMubWFwKHBsYWluTm90ZSksIHRydW5jYXRlZDogISFyLnRydW5jYXRlZCB9KTsKICAgICAgICBrZWVwQ29weSgpOwogICAgICB9CiAgICAgIHJldHVybiB7IG5vdGVzOiByLm",
"5vdGVzLCB0cnVuY2F0ZWQ6IHIudHJ1bmNhdGVkLCBmb2xkZXJzOiBTLmZvbGRlcnMgfTsKICAgIH0sCgogICAgLy8gTWVzc2FnZXMgbmV2ZXIgY2hhbmdlLCBzbyBhIG5vdGUncyBjb250ZW50LCBvbmNlIHJlYWQsIGlzIGtlcHQuCiAgICBhc3luYyBib2R5KG5vdGUpIHsKICAgICAgaWYgKFMuZG9jcy5oYXMobm90ZS5tZXNzYWdlSWQpKSByZXR1cm4gUy5kb2NzLmdldChub3RlLm1lc3NhZ2VJZCk7CiAgICAgIGNvbnN0IGRvYyA9IGF3YWl0IGNhbGwoJ2FwcEJvZHknLCBub3RlLm1lc3NhZ2VJZCk7CiAgICAgIFMuZG9jcy5zZXQobm90ZS5tZXNzYWdlSWQsIGRvYyk7CiAgICAgIGlmIChpc1NjcmF0Y2gobm90ZSkpIGtlZXBTY3JhdGNoKG5vdGUsIGRvYyk7CiAgICAgIHJldHVybiBkb2M7CiAgICB9LAoKICAgIGFzeW5jIHNhdmUoYWNjb3VudCwgcHJldmlvdXMsIHNuYXApIHsKICAgICAgY29uc3QgZG9jID0gZm10Lm5vcm1hbGlzZURvYyhzbmFwLmRvYyk7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBjYWxsKCdhcHBTYXZlJywgcHJldmlvdXMgPyBwcmV2aW91cy5tZXNzYWdlSWQgOiAnJywgewogICAgICAgIHRpdGxlOiBzbmFwLnRpdGxlLCBkb2MsIGZvbGRlcklkOiBzbmFwLmZvbGRlcklkIHx8ICcnLCBub3RlSWQ6IHNuYXAubm90ZUlkIHx8ICcnLAogICAgICB9KTsKICAgICAgaWYgKHIuY29uZmxpY3QpIHsKICAgICAgICBjb25zdCBlID0gbmV3IEVycm9yKCdTYXZlZCBvbiBhbm90aGVyIGRldmljZSBpbiB0aGUgbW",
"VhbnRpbWUuJyk7CiAgICAgICAgZS5jb2RlID0gJ2NvbmZsaWN0JzsKICAgICAgICBlLm5ld2VyID0gci5jb25mbGljdDsKICAgICAgICB0aHJvdyBlOwogICAgICB9CiAgICAgIFMuZG9jcy5zZXQoci5ub3RlLm1lc3NhZ2VJZCwgZG9jKTsKICAgICAgaWYgKGlzU2NyYXRjaChyLm5vdGUpKSB7CiAgICAgICAga2VlcFNjcmF0Y2goci5ub3RlLCBkb2MpOwogICAgICAgIGlmIChrZXB0Lm5vdGVzKSBrZXB0Lm5vdGVzID0gW3BsYWluTm90ZShyLm5vdGUpXS5jb25jYXQoa2VwdC5ub3Rlcy5maWx0ZXIobiA9PiBuLmtleSAhPT0gci5ub3RlLmtleSkpOwogICAgICB9CiAgICAgIHJldHVybiByLm5vdGU7CiAgICB9LAoKICAgIGFzeW5jIHJldGlyZShub3RlKSB7IGF3YWl0IGNhbGwoJ2FwcFJldGlyZScsIG5vdGUubWVzc2FnZUlkKTsgfSwKICAgIGFzeW5jIHJlc3RvcmUobm90ZSkgeyBhd2FpdCBjYWxsKCdhcHBSZXN0b3JlJywgbm90ZS5tZXNzYWdlSWQsIG5vdGUuZm9sZGVySWQgfHwgJycpOyB9LAoKICAgIGFzeW5jIG1vdmUobm90ZSwgZm9sZGVySWQpIHsKICAgICAgYXdhaXQgY2FsbCgnYXBwTW92ZScsIG5vdGUubWVzc2FnZUlkLCBmb2xkZXJJZCB8fCAnJyk7CiAgICAgIG5vdGUuZm9sZGVySWQgPSBmb2xkZXJJZCB8fCAnJzsKICAgIH0sCgogICAgYXN5bmMgY3JlYXRlRm9sZGVyKHBhcmVudCwgdGl0bGUpIHsKICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGwoJ2FwcENyZWF0ZUZvbGRlcicsIHBhcmVudCA_IHBhcm",
"VudC5pZCA6ICcnLCB0aXRsZSk7CiAgICAgIFMuZm9sZGVycyA9IHIuZm9sZGVyczsKICAgICAgcmV0dXJuIHIuZm9sZGVyOwogICAgfSwKCiAgICBhc3luYyByZW5hbWVGb2xkZXIoZm9sZGVyLCB0aXRsZSkgewogICAgICBTLmZvbGRlcnMgPSAoYXdhaXQgY2FsbCgnYXBwUmVuYW1lRm9sZGVyJywgZm9sZGVyLmlkLCB0aXRsZSkpLmZvbGRlcnM7CiAgICB9LAoKICAgIGFzeW5jIGRlbGV0ZUZvbGRlcihmb2xkZXIpIHsKICAgICAgUy5mb2xkZXJzID0gKGF3YWl0IGNhbGwoJ2FwcERlbGV0ZUZvbGRlcicsIGZvbGRlci5pZCkpLmZvbGRlcnM7CiAgICB9LAogIH07CgogIC8vIOKUgOKUgCBXaG9zZSBtYWlsYm94LCBhbmQgb3BlbmluZyBhIGNvbnZlcnNhdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3Qgd2hvID0geyBhY2NvdW50OiAnJyB9OwoKICBpZiAoa2VwdC5hY2NvdW50KSB3aG8uYWNjb3VudCA9IGtlcHQuYWNjb3VudDsKCiAgLy8g4pSA4pSAIE9wZW5pbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBPbmUgY2FsbCBhcy",
"B0aGUgYXBwIG9wZW5zIChhcHBTdGFydCksIHNlbnQgYmVmb3JlIGFueXRoaW5nIGlzIGRyYXduOgogIC8vIHRoZSBhY2NvdW50LCB0aGUgc2V0dGluZ3MsIHRoZSBib2FyZCdzIGZpcnN0IGNvbHVtbnMgaWYgaXQgaGFzIG5vbmUsCiAgLy8gYW5kIHRoZSBzY3JhdGNocGFkIC0ganVzdCB3aGV0aGVyIHRoZSBjb3B5IGhlcmUgaXMgc3RpbGwgY3VycmVudCwgaWYKICAvLyB0aGVyZSBpcyBvbmUuIFRoZSBwYWdlIG9wZW5zIG9uIHRoZSBjb3B5IG1lYW53aGlsZSAoc2hlbGwuanMpLgoKICBsZXQgc3RhcnRlZCA9IG51bGw7CiAgbGV0IGNvbHVtbnMgPSAnY29sdW1ucycgaW4ga2VwdCA_IGtlcHQuY29sdW1ucyA6IHVuZGVmaW5lZDsKICBsZXQgcHJlZnNUb3VjaGVkID0gZmFsc2U7CgogIGZ1bmN0aW9uIHN0YXJ0KCkgewogICAgaWYgKHN0YXJ0ZWQpIHJldHVybiBzdGFydGVkOwogICAgY29uc3QgaGludCA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZSA_IGtlcHQuc2NyYXRjaC5ub3RlLm1lc3NhZ2VJZCA6ICcnOwogICAgc3RhcnRlZCA9IGNhbGwoJ2FwcFN0YXJ0JywgaGludCkudGhlbihyID0-IHsKICAgICAgY29uc3QgYWNjb3VudCA9IFN0cmluZyhyLmFjY291bnQgfHwgJycpOwogICAgICAvLyBBIGNvcHkga2VwdCBmb3IgYW5vdGhlciBHb29nbGUgYWNjb3VudCBpcyBubyB1c2UgdG8gdGhpcyBvbmUuCiAgICAgIGNvbnN0IG90aGVyQWNjb3VudCA9ICEha2VwdC5hY2NvdW50ICYmIGtlcHQuYWNjb3",
"VudC50b0xvd2VyQ2FzZSgpICE9PSBhY2NvdW50LnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChvdGhlckFjY291bnQpIGZvcmdldENvcHkoKTsKICAgICAgd2hvLmFjY291bnQgPSBhY2NvdW50OwogICAgICBTLmxhYmVsID0gci5sYWJlbCB8fCBTLmxhYmVsOwogICAgICBTLmZvbGRlcnMgPSByLmZvbGRlcnMgfHwgW107CiAgICAgIGlmICghcHJlZnNUb3VjaGVkKSBzeW5jZWQgPSByLnByZWZzIHx8IHt9OwogICAgICBjb2x1bW5zID0gci5jb2x1bW5zIHx8IG51bGw7CiAgICAgIE9iamVjdC5hc3NpZ24oa2VwdCwgeyBhY2NvdW50LCBsYWJlbDogUy5sYWJlbCwgZm9sZGVyczogUy5mb2xkZXJzLCBwcmVmczogc3luY2VkLCBjb2x1bW5zIH0pOwogICAgICBpZiAoci5zY3JhdGNoKSB7CiAgICAgICAgY29uc3Qgc2FtZSA9IGtlcHQuc2NyYXRjaCAmJiBrZXB0LnNjcmF0Y2gubm90ZSAmJiBrZXB0LnNjcmF0Y2gubm90ZS5tZXNzYWdlSWQgPT09IHIuc2NyYXRjaC5tZXNzYWdlSWQ7CiAgICAgICAgY29uc3QgZG9jID0gci5kb2MgfHwgKHNhbWUgPyBrZXB0LnNjcmF0Y2guZG9jIDogbnVsbCk7CiAgICAgICAgaWYgKGRvYykgewogICAgICAgICAgUy5kb2NzLnNldChyLnNjcmF0Y2gubWVzc2FnZUlkLCBkb2MpOwogICAgICAgICAga2VwdC5zY3JhdGNoID0geyBub3RlOiBwbGFpbk5vdGUoci5zY3JhdGNoKSwgZG9jIH07CiAgICAgICAgfQogICAgICB9IGVsc2UgewogICAgICAgIGtlcHQuc2NyYXRjaCA9IG51bGw7CiAgIC",
"AgIH0KICAgICAgd3JpdGVKc29uKENPUFksIGtlcHQpOwogICAgICByZXR1cm4geyBzY3JhdGNoOiByLnNjcmF0Y2ggfHwgbnVsbCwgb3RoZXJBY2NvdW50IH07CiAgICB9KTsKICAgIHJldHVybiBzdGFydGVkOwogIH0KCiAgY29uc3QgaGFzQ29weSA9ICgpID0-ICEha2VwdC5hY2NvdW50OwoKICAvLyBUaGUgYm9hcmQncyBmaXJzdCBjb2x1bW5zLCB3aGVuIGl0cyBzZXR0aW5ncyBoYXZlIG5vbmU6IGZyb20gdGhlCiAgLy8gZmlyc3QgY2FsbCwgb3IgdGhlIGNvcHkgLSBvciwgZmFpbGluZyB0aG9zZSwgYXNrZWQgZm9yLgogIGFzeW5jIGZ1bmN0aW9uIGZpcnN0Q29sdW1ucygpIHsKICAgIGlmIChjb2x1bW5zICE9PSB1bmRlZmluZWQpIHJldHVybiBjb2x1bW5zOwogICAgaWYgKHN0YXJ0ZWQpIHsKICAgICAgdHJ5IHsgYXdhaXQgc3RhcnRlZDsgfSBjYXRjaCAoZXJyKSB7IC8qIGFza2VkIGZvciBiZWxvdyAqLyB9CiAgICAgIGlmIChjb2x1bW5zICE9PSB1bmRlZmluZWQpIHJldHVybiBjb2x1bW5zOwogICAgfQogICAgcmV0dXJuIGNhbGwoJ2FwcEJvYXJkQ29sdW1ucycpOwogIH0KCiAgY29uc3QgdGhyZWFkVXJsID0gdGhyZWFkSWQgPT4KICAgIGBodHRwczovL21haWwuZ29vZ2xlLmNvbS9tYWlsLz9hdXRodXNlcj0ke2VuY29kZVVSSUNvbXBvbmVudCh3aG8uYWNjb3VudCl9I2FsbC8ke2VuY29kZVVSSUNvbXBvbmVudCh0aHJlYWRJZCl9YDsKCiAgbnMuaG9va3MgPSB7CiAgICBnZXRBY2NvdW50OiAoKSA9PiB3aG",
"8uYWNjb3VudCwKICAgIHRocmVhZFVybCwKICAgIC8vIFRoZSBjb252ZXJzYXRpb24gaW4gR21haWwgLSB3aGljaCwgb24gYSBwaG9uZSwgdGhlIEdtYWlsIGFwcCBtYXkgb2ZmZXIgdG8gb3Blbi4KICAgIG9wZW5UaHJlYWQodGhyZWFkSWQpIHsKICAgICAgd2luZG93Lm9wZW4odGhyZWFkVXJsKHRocmVhZElkKSwgJ19ibGFuaycsICdub29wZW5lcicpOwogICAgfSwKICB9OwoKICAvLyDilIDilIAgVGhlIGJvYXJkJ3MgR21haWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBhcHBCb2FyZEdtYWlsIGFsbG93cyBvbmx5IHdoYXQgdGhlIGJvYXJkIGRvZXMgd2l0aCBHbWFpbC4gRXJyb3JzIGNvbWUKICAvLyBiYWNrIGFzIHRoZSBleHRlbnNpb24ncyBkbyAoImh0dHBfNDA5IiksIHNpbmNlIHRoZSBib2FyZCBhY3RzIG9uIHNvbWUuCgogIGZ1bmN0aW9uIGdtYWlsRXJyb3IobWVzc2FnZSwgc3RhdHVzKSB7CiAgICBjb25zdCBlID0gbmV3IEVycm9yKFN0cmluZyhtZXNzYWdlIHx8ICdHbWFpbCBkaWQgbm90IGFuc3dlci4nKSk7CiAgICBjb25zdCBtID0gL0dtYWlsIGFuc3dlcmVkIChcZHszfSkvLmV4ZWMoZS5tZXNzYWdlKTsKICAgIGUuY29kZSA9IHN0YXR1cyA_IGBodHRwXyR7c3RhdHVzfW",
"AgOiBtID8gYGh0dHBfJHttWzFdfWAgOiAnZ21haWwnOwogICAgcmV0dXJuIGU7CiAgfQoKICBmdW5jdGlvbiBnbWFpbChtZXRob2QsIHBhdGgsIHF1ZXJ5LCBib2R5KSB7CiAgICByZXR1cm4gY2FsbCgnYXBwQm9hcmRHbWFpbCcsIG1ldGhvZCwgcGF0aCwgcXVlcnkgfHwgbnVsbCwgYm9keSB8fCBudWxsKS5jYXRjaChlcnIgPT4gewogICAgICBpZiAoIWVyci5jb2RlKSB0aHJvdyBnbWFpbEVycm9yKGVyci5tZXNzYWdlKTsKICAgICAgdGhyb3cgZXJyOwogICAgfSk7CiAgfQoKICAvLyBBIGJhdGNoIG9mIHJlYWRzIGluIG9uZSByb3VuZCB0cmlwOiBhIGJvYXJkJ3Mgd29ydGggb2YgY2FyZHMgYXQgb25jZS4KICBhc3luYyBmdW5jdGlvbiBnbWFpbE1hbnkobGlzdCkgewogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGNhbGwoJ2FwcEJvYXJkR21haWxNYW55JywgbGlzdCk7CiAgICByZXR1cm4gcmVzdWx0cy5tYXAociA9PiAociAmJiByLmVycm9yID8geyBlcnJvcjogZ21haWxFcnJvcihyLmVycm9yLm1lc3NhZ2UsIHIuZXJyb3Iuc3RhdHVzKSB9IDogcikpOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBjYWxlbmRhcidzIEdvb2dsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIENhbGVuZGFyIGFuZCBUYXNrcyByZW",
"FkcywgaW4gb25lIHJvdW5kIHRyaXAsIGFzIHRoZSBleHRlbnNpb24ncwogIC8vIHdvcmtlciBhbnN3ZXJzIHRoZW06IGVhY2ggdGhlIHJlc3BvbnNlLCBvciB7IGVycm9yIH0gd2l0aCBhIGNvZGUuCgogIGZ1bmN0aW9uIGdvb2dsZUVycm9yKGUpIHsKICAgIGNvbnN0IGVyciA9IG5ldyBFcnJvcihTdHJpbmcoZS5tZXNzYWdlIHx8ICdHb29nbGUgZGlkIG5vdCBhbnN3ZXIuJykpOwogICAgZXJyLmNvZGUgPSBlLmNvZGUgfHwgKGUuc3RhdHVzID8gYGh0dHBfJHtlLnN0YXR1c31gIDogJ2dvb2dsZScpOwogICAgaWYgKGUudXJsKSBlcnIuYWxsb3dVcmwgPSBTdHJpbmcoZS51cmwpOwogICAgcmV0dXJuIGVycjsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGdvb2dsZU1hbnkobGlzdCkgewogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGNhbGwoJ2FwcEdvb2dsZU1hbnknLCBsaXN0KTsKICAgIHJldHVybiByZXN1bHRzLm1hcChyID0-IChyICYmIHIuZXJyb3IgPyB7IGVycm9yOiBnb29nbGVFcnJvcihyLmVycm9yKSB9IDogcikpOwogIH0KCiAgLy8gT25lIGNoYW5nZSwgYXMgdGhlIGV4dGVuc2lvbidzIHdvcmtlciBtYWtlcyBpdDogdGhlIGFuc3dlciwgb3IgYQogIC8vIHJlZnVzYWwgdGhyb3duIHdpdGggaXRzIGNvZGUgKCJjaGFuZ2VkIiwgImNhbGVuZGFyX3Njb3BlIikuCiAgYXN5bmMgZnVuY3Rpb24gZ29vZ2xlV3JpdGUoc2VydmljZSwgbWV0aG9kLCBwYXRoLCBib2R5LCBldGFnKSB7CiAgICBjb25zdCByID0gYXdhaX",
"QgY2FsbCgnYXBwR29vZ2xlV3JpdGUnLCBzZXJ2aWNlLCBtZXRob2QsIHBhdGgsIGJvZHkgPT09IHVuZGVmaW5lZCA_IG51bGwgOiBib2R5LCBldGFnIHx8ICcnKTsKICAgIGlmIChyICYmIHIuZXJyb3IpIHRocm93IGdvb2dsZUVycm9yKHIuZXJyb3IpOwogICAgcmV0dXJuIHIgPyByLmRhdGEgOiBudWxsOwogIH0KCiAgLy8gVGhlIGxpY2VuY2UsIGtlcHQgYnkgdGhlIHNjcmlwdCAobGljZW5jZUxvZ2ljKTogeyB2aWV3LCBlcnJvcj8gfS4KICBmdW5jdGlvbiBsaWNlbmNlKGFjdGlvbiwga2V5KSB7CiAgICByZXR1cm4gY2FsbCgnYXBwTGljZW5jZScsIGFjdGlvbiwga2V5IHx8ICcnKTsKICB9CgogIG5zLmFwaSA9IHsgU1RBVEVfQ09ERVM6IG5ldyBTZXQoKSwgZ21haWwsIGdtYWlsTWFueSwgZ29vZ2xlTWFueSwgZ29vZ2xlV3JpdGUsIGxpY2VuY2UgfTsKICBucy5hcHBSZW1vdGUgPSB7IGNhbGwsIHN0YXJ0LCBoYXNDb3B5LCBmaXJzdENvbHVtbnMgfTsKCiAgLy8g4pSA4pSAIGNocm9tZS5zdG9yYWdlLCBhcyB0aGUgYm9hcmQgdXNlcyBpdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vICJzeW5jIiAtIHRoZSBjb2x1bW4gbGF5b3V0IGFuZCBjYXJkIHRpdGxlcywgbm90ZXMgYW5kIGNvbG91cnMgLSBpcyB0aGUKICAvLyBzY3JpcHQncyBwZXItdXNlciBwcm9wZXJ0aWVzOiB0aGUgc2FtZS",
"BvbiBldmVyeSBwaG9uZSBhbmQgY29tcHV0ZXIKICAvLyB0aGUgYXBwIGlzIG9wZW5lZCBvbiAodGhvdWdoIG5vdCBzaGFyZWQgd2l0aCB0aGUgZXh0ZW5zaW9uLCB3aG9zZQogIC8vIGNvcHkgaXMgQ2hyb21lJ3MpLiAibG9jYWwiIC0gY2FyZCBvcmRlciBhbmQgdGhlIGxhc3QgdGFiIC0gaXMgdGhpcwogIC8vIGJyb3dzZXIncyBvd24gc3RvcmFnZSwgYXMgaW4gdGhlIGV4dGVuc2lvbi4KCiAgZnVuY3Rpb24gcGljayhhbGwsIGtleXMpIHsKICAgIGlmIChrZXlzID09PSBudWxsIHx8IGtleXMgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgLi4uYWxsIH07CiAgICBpZiAodHlwZW9mIGtleXMgPT09ICdzdHJpbmcnKSBrZXlzID0gW2tleXNdOwogICAgY29uc3Qgb3V0ID0ge307CiAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlzKSkgewogICAgICBmb3IgKGNvbnN0IGsgb2Yga2V5cykgaWYgKGsgaW4gYWxsKSBvdXRba10gPSBhbGxba107CiAgICAgIHJldHVybiBvdXQ7CiAgICB9CiAgICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMoa2V5cykpIG91dFtrXSA9IGsgaW4gYWxsID8gYWxsW2tdIDoga2V5c1trXTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBUaGUgYXBwJ3Mgb2xkIG5hbWUsIGtlcHQgc28gcHJlZnMgc2F2ZWQgYmVmb3JlIHRoZSByZW5hbWUgc3RpbGwgY291bnQuCiAgY29uc3QgTE9DQUwgPSAnc3VwZXJtYWlsLic7CiAgZnVuY3Rpb24gbG9jYWxBbGwoKSB7CiAgICBjb25zdCBvdXQgPSB7fTsKICAgIH",
"RyeSB7CiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbG9jYWxTdG9yYWdlLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3QgayA9IGxvY2FsU3RvcmFnZS5rZXkoaSk7CiAgICAgICAgaWYgKCFrIHx8ICFrLnN0YXJ0c1dpdGgoTE9DQUwpKSBjb250aW51ZTsKICAgICAgICB0cnkgeyBvdXRbay5zbGljZShMT0NBTC5sZW5ndGgpXSA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oaykpOyB9IGNhdGNoIChlcnIpIHsgLyogbm90IG91cnMgKi8gfQogICAgICB9CiAgICB9IGNhdGNoIChlcnIpIHsgLyogc3RvcmFnZSBvZmY6IG5vdGhpbmcga2VwdCAqLyB9CiAgICByZXR1cm4gb3V0OwogIH0KICBjb25zdCBsb2NhbCA9IHsKICAgIGFzeW5jIGdldChrZXlzKSB7IHJldHVybiBwaWNrKGxvY2FsQWxsKCksIGtleXMpOyB9LAogICAgYXN5bmMgc2V0KGl0ZW1zKSB7CiAgICAgIHRyeSB7IGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhpdGVtcykpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKExPQ0FMICsgaywgSlNPTi5zdHJpbmdpZnkoaXRlbXNba10pKTsgfSBjYXRjaCAoZXJyKSB7IC8qIG5vdCBrZXB0ICovIH0KICAgIH0sCiAgICBhc3luYyByZW1vdmUoa2V5cykgewogICAgICB0cnkgeyBmb3IgKGNvbnN0IGsgb2YgW10uY29uY2F0KGtleXMpKSBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShMT0NBTCArIGspOyB9IGNhdGNoIChlcnIpIHsgLyogbm90aGluZyB0byByZW1vdmUgKi8gfQogICAgfSwKICB9OwoKIC",
"AvLyBGcm9tIHRoZSBmaXJzdCBjYWxsIChvciB0aGUgY29weSwgdW50aWwgaXQgYW5zd2VycyksIHRoZW4ga2VwdCBoZXJlCiAgLy8gYW5kIHdyaXR0ZW4gdGhyb3VnaC4KICBsZXQgc3luY2VkID0ga2VwdC5wcmVmcyB8fCBudWxsOwogIGNvbnN0IHN5bmNBbGwgPSBhc3luYyAoKSA9PiB7CiAgICBpZiAoIXN5bmNlZCAmJiBzdGFydGVkKSB7IHRyeSB7IGF3YWl0IHN0YXJ0ZWQ7IH0gY2F0Y2ggKGVycikgeyAvKiBhc2tlZCBmb3IgYmVsb3cgKi8gfSB9CiAgICByZXR1cm4gKHN5bmNlZCA9IHN5bmNlZCB8fCBhd2FpdCBjYWxsKCdhcHBQcmVmc0dldCcsIG51bGwpKTsKICB9OwogIGNvbnN0IHN5bmMgPSB7CiAgICBhc3luYyBnZXQoa2V5cykgeyByZXR1cm4gcGljayhhd2FpdCBzeW5jQWxsKCksIGtleXMpOyB9LAogICAgYXN5bmMgc2V0KGl0ZW1zKSB7CiAgICAgIHByZWZzVG91Y2hlZCA9IHRydWU7CiAgICAgIGF3YWl0IGNhbGwoJ2FwcFByZWZzU2V0JywgaXRlbXMpOwogICAgICBPYmplY3QuYXNzaWduKGF3YWl0IHN5bmNBbGwoKSwgSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShpdGVtcykpKTsKICAgICAga2VwdC5wcmVmcyA9IHN5bmNlZDsKICAgICAga2VlcENvcHkoKTsKICAgIH0sCiAgICBhc3luYyByZW1vdmUoa2V5cykgewogICAgICBwcmVmc1RvdWNoZWQgPSB0cnVlOwogICAgICBjb25zdCBsaXN0ID0gW10uY29uY2F0KGtleXMpOwogICAgICBhd2FpdCBjYWxsKCdhcHBQcmVmc1JlbW92ZScsIGxpc3QpOw",
"ogICAgICBjb25zdCBhbGwgPSBhd2FpdCBzeW5jQWxsKCk7CiAgICAgIGZvciAoY29uc3QgayBvZiBsaXN0KSBkZWxldGUgYWxsW2tdOwogICAgICBrZXB0LnByZWZzID0gc3luY2VkOwogICAgICBrZWVwQ29weSgpOwogICAgfSwKICB9OwoKICBjb25zdCBjaHJvbWVMaWtlID0gKGdsb2JhbFRoaXMuY2hyb21lID0gZ2xvYmFsVGhpcy5jaHJvbWUgfHwge30pOwogIGlmICghY2hyb21lTGlrZS5zdG9yYWdlKSBjaHJvbWVMaWtlLnN0b3JhZ2UgPSB7IGxvY2FsLCBzeW5jLCBvbkNoYW5nZWQ6IHsgYWRkTGlzdGVuZXIoKSB7fSB9IH07Cn0pKCk7Cg\"],[\"src/content/store.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIEJvYXJkIGRhdGEKLy8KLy8gU2hhcmVkIGJ5IHRoZSBib2FyZCBhbmQgdGhlIGRvY2ssIHNvIGEgbW92ZSBtYWRlIGZyb20gZWl0aGVyIGlzIHNlZW4gYnkKLy8gYm90aC4gR21haWwgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aCBmb3Igd2hpY2ggY29sdW1uIGEgdGhyZWFkIGlzIGluOwovLyB3aGF0IGxpdmVzIGhlcmUgaXMgYSBjYWNoZSBvZiBsYWJlbCBpZHMgYW5k",
"IHRocmVhZCBzdW1tYXJpZXMsIHBsdXMgdGhlCi8vIHNtYWxsIHRoaW5ncyBHbWFpbCBjYW5ub3QgaG9sZCAtIHRoZSBjb2x1bW4gbGF5b3V0IGFuZCB0aGUgdXNlcidzIG93bgovLyBjYXJkIHRpdGxlcywgbm90ZXMgYW5kIGNvbG91cnMgKHN0b3JhZ2Uuc3luYywgc28gdGhleSBmb2xsb3cgdGhlIHVzZXIKLy8gYmV0d2VlbiBjb21wdXRlcnMpIGFuZCBjYXJkIG9yZGVyIHdpdGhpbiBlYWNoIGNvbHVtbiAoc3RvcmFnZS5sb2NhbCwKLy8gYmVjYXVzZSBpdCBjaGFuZ2VzIG9uIGV2ZXJ5IGRyYWcgYW5kIHN5bmMgaGFzIGEgdGlnaHQgd3JpdGUgcXVvdGEpLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB7IGFwaSwgbG9naWMsIEtFWVMgfSA9IG5zOwoKICBjb25zdCBidXMgPSBuZXcgRXZlbnRUYXJnZXQoKTsKICBjb25zdCBlbWl0ID0gKHR5cGUsIGRldGFpbCkgPT4gYnVzLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50",
"KHR5cGUsIHsgZGV0YWlsIH0pKTsKCiAgY29uc3QgUyA9IHsKICAgIGxhYmVsczogbmV3IE1hcCgpLCAgIC8vIGxvd2VyLWNhc2VkIG5hbWUg4oaSIGxhYmVsIHJlc291cmNlCiAgICBsYWJlbHNBdDogMCwKICAgIG1ldGE6IG5ldyBNYXAoKSwgICAgIC8vIHRocmVhZCBpZCDihpIgc3VtbWFyeSAoc2VlIGxvZ2ljLnN1bW1hcmlzZVRocmVhZCkKICAgIHBlbmRpbmc6IG5ldyBTZXQoKSwgIC8vIGluLWZsaWdodCB0aHJlYWRzLm1vZGlmeSBwcm9taXNlcwogIH07CgogIC8vIEVycm9ycyB0aGF0IG1lYW4gIm5vdGhpbmcgZWxzZSB3aWxsIHdvcmsgZWl0aGVyIiwgd2hpY2ggbXVzdCBzdG9wIGEKICAvLyBiYXRjaCByYXRoZXIgdGhhbiBiZWluZyBzd2FsbG93ZWQgcGVyIHRocmVhZC4KICBmdW5jdGlvbiBpc0ZhdGFsKGVycikgewogICAgcmV0dXJuIGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpIHx8IGVyci5jb2RlID09PSAnZXh0ZW5zaW9uX3JlbG9hZGVkJzsKICB9CgogIC8vIOKUgOKUgCBTZXR0aW5ncyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgYXN5bmMgZnVuY3Rpb24gbG9hZENvbHVtbnMoYWNjb3VudCkgewogICAgY29uc3Qga2V5ID0gS0VZ",
"Uy5jb2x1bW5zKGFjY291bnQpOwogICAgY29uc3QgZ290ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQoa2V5KTsKICAgIHJldHVybiBsb2dpYy5ub3JtYWxpc2VDb2x1bW5zKGdvdFtrZXldKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVDb2x1bW5zKGFjY291bnQsIGNvbHVtbnMpIHsKICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMuc2V0KHsgW0tFWVMuY29sdW1ucyhhY2NvdW50KV06IGNvbHVtbnMgfSk7CiAgICBlbWl0KCdjb2x1bW5zLWNoYW5nZWQnLCB7IGNvbHVtbnMgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBsb2FkT3JkZXIoYWNjb3VudCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5vcmRlcihhY2NvdW50KTsKICAgIGNvbnN0IGdvdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpOwogICAgcmV0dXJuIGdvdFtrZXldIHx8IHt9OwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZU9yZGVyKGFjY291bnQsIGxpc3RzLCBjb2x1bW5zKSB7CiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy5vcmRlcihhY2NvdW50KV06IGxvZ2ljLnBydW5lT3JkZXIobGlzdHMsIGNvbHVtbnMpIH0pOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgZWRpdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA",
"4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIGxvYWRDYXJkRWRpdHMoYWNjb3VudCkgewogICAgY29uc3QgYWxsID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQobnVsbCk7CiAgICByZXR1cm4gbG9naWMuY2FyZEVkaXRzRnJvbShhbGwsIEtFWVMuY2FyZFByZWZpeChhY2NvdW50KSk7CiAgfQoKICAvLyBBIG51bGwgZWRpdCBkZWxldGVzIHRoZSByZWNvcmQuIFN5bmMncyBvd24gcXVvdGEgbWVzc2FnZSAoIlFVT1RBX0JZVEVTCiAgLy8gcXVvdGEgZXhjZWVkZWQiKSBzYXlzIG5vdGhpbmcgYWJvdXQgd2hhdCB0byBkbywgc28gaXQgaXMgcmVwaHJhc2VkLgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVDYXJkRWRpdChhY2NvdW50LCB0aHJlYWRJZCwgZWRpdCkgewogICAgY29uc3Qga2V5ID0gS0VZUy5jYXJkKGFjY291bnQsIHRocmVhZElkKTsKICAgIHRyeSB7CiAgICAgIGlmIChlZGl0KSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLnNldCh7IFtrZXldOiBlZGl0IH0pOwogICAgICBlbHNlIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMucmVtb3ZlKGtleSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKC9xdW90YS9pLnRlc3QoKGVyciAmJiBlcnIubWVzc2FnZSkgfHwgJycpKSB7CiAgICAgICAgdGhyb3cgT2JqZWN0LmFzc2lnbihuZXcgRXJyb3IoCiAgICAgICAgICAnQ2hyb21l4oCZcyBzeW5jZWQgc3RvcmFnZSBpcyBmdWxsLiBDbGVh",
"ciB0aGUgbm90ZXMgb24gY2FyZHMgeW91IG5vIGxvbmdlciBuZWVkLCBvciB0YWtlIGZpbmlzaGVkIGNhcmRzIG9mZiB0aGUgYm9hcmQuJwogICAgICAgICksIHsgY29kZTogJ3F1b3RhJyB9KTsKICAgICAgfQogICAgICB0aHJvdyBlcnI7CiAgICB9CiAgfQoKICAvLyBHbWFpbCdzIHRvcCBiYXIgdW5sZXNzIGEgY29ybmVyLCBvciBub25lLCB3YXMgY2hvc2VuLgogIGFzeW5jIGZ1bmN0aW9uIGxvYWREb2NrUGxhY2UoKSB7CiAgICBjb25zdCBnb3QgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLmdldChLRVlTLmRvY2tQbGFjZSk7CiAgICBjb25zdCB2ID0gZ290W0tFWVMuZG9ja1BsYWNlXTsKICAgIHJldHVybiB2ID09PSAnbGVmdCcgfHwgdiA9PT0gJ3JpZ2h0JyB8fCB2ID09PSAnaGlkZGVuJyA_IHYgOiAndG9wJzsKICB9CgogIC8vIOKUgOKUgCBMYWJlbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hMYWJlbHMoKSB7CiAgICBjb25zdCByID0gYXdhaXQgYXBpLmdtYWlsKCdHRVQnLCAnbGFiZWxzJyk7CiAgICBTLmxhYmVscyA9IG5ldyBNYXAoKHIubGFiZWxzIHx8IFtdKS5tYXAobCA9PiBbbC5u",
"YW1lLnRvTG93ZXJDYXNlKCksIGxdKSk7CiAgICBTLmxhYmVsc0F0ID0gRGF0ZS5ub3coKTsKICB9CgogIGZ1bmN0aW9uIGFsbExhYmVscygpIHsKICAgIHJldHVybiBbLi4uUy5sYWJlbHMudmFsdWVzKCldOwogIH0KCiAgLy8gR21haWwgbGFiZWwgbmFtZXMgYXJlIHVuaXF1ZSBjYXNlLWluc2Vuc2l0aXZlbHksIHNvIGxvb2t1cHMgYXJlIHRvby4KICBmdW5jdGlvbiBsYWJlbElkKG5hbWUpIHsKICAgIGNvbnN0IGwgPSBTLmxhYmVscy5nZXQoU3RyaW5nKG5hbWUgfHwgJycpLnRvTG93ZXJDYXNlKCkpOwogICAgcmV0dXJuIGwgPyBsLmlkIDogJyc7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBlbnN1cmVMYWJlbHMobmFtZXMsIHsgZnJlc2ggPSBmYWxzZSB9ID0ge30pIHsKICAgIGlmIChmcmVzaCB8fCAhUy5sYWJlbHNBdCkgYXdhaXQgcmVmcmVzaExhYmVscygpOwoKICAgIGNvbnN0IHdhbnRlZCA9IFtdOwogICAgZm9yIChjb25zdCBuIG9mIG5hbWVzKSB3YW50ZWQucHVzaCguLi5sb2dpYy5sYWJlbEFuY2VzdG9ycyhuKSwgbik7CgogICAgLy8gU2VxdWVudGlhbCwgcGFyZW50cyBmaXJzdC4gQ3JlYXRpbmcgYSBoYW5kZnVsIG9mIGxhYmVscyBoYXBwZW5zIG9uY2UKICAgIC8vIHBlciBib2FyZCwgc28gdGhlcmUgaXMgbm90aGluZyB0byBnYWluIGZyb20gcmFjaW5nIHRoZW0uCiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgWy4uLm5ldyBTZXQod2FudGVkKV0pIHsKICAgICAgaWYgKGxhYmVsSWQobmFtZSkpIGNvbnRpbnVl",
"OwogICAgICB0cnkgewogICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBhcGkuZ21haWwoJ1BPU1QnLCAnbGFiZWxzJywgbnVsbCwgewogICAgICAgICAgbmFtZSwKICAgICAgICAgIGxhYmVsTGlzdFZpc2liaWxpdHk6ICdsYWJlbFNob3cnLAogICAgICAgICAgbWVzc2FnZUxpc3RWaXNpYmlsaXR5OiAnc2hvdycsCiAgICAgICAgfSk7CiAgICAgICAgUy5sYWJlbHMuc2V0KG5hbWUudG9Mb3dlckNhc2UoKSwgY3JlYXRlZCk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIC8vIDQwOTogaXQgZXhpc3RzIGFmdGVyIGFsbCAoY3JlYXRlZCBpbiBhbm90aGVyIHRhYiwgb3IgZGlmZmVyaW5nCiAgICAgICAgLy8gb25seSBpbiBjYXNlKS4gUmUtcmVhZCByYXRoZXIgdGhhbiBmYWlsLgogICAgICAgIGlmIChlcnIuY29kZSA9PT0gJ2h0dHBfNDA5JykgewogICAgICAgICAgYXdhaXQgcmVmcmVzaExhYmVscygpOwogICAgICAgICAgaWYgKGxhYmVsSWQobmFtZSkpIGNvbnRpbnVlOwogICAgICAgIH0KICAgICAgICB0aHJvdyBlcnI7CiAgICAgIH0KICAgIH0KICB9CgogIC8vIFJlbmFtZXMgdGhlIEdtYWlsIGxhYmVsIGluIHBsYWNlLCBzbyBldmVyeSB0aHJlYWQgd2VhcmluZyBpdCBzdGF5cyBwdXQuCiAgLy8gSWYgdGhlIG5ldyBuYW1lIGFscmVhZHkgZXhpc3RzIGFzIGEgZGlmZmVyZW50IGxhYmVsLCB0aGUgY29sdW1uIHNpbXBseQogIC8vIHN3aXRjaGVzIHRvIHRoYXQgbGFiZWwgLSBwYXRjaGluZyB3b3VsZCBm",
"YWlsIHdpdGggYSBjb25mbGljdCwgYW5kCiAgLy8gcG9pbnRpbmcgYSBjb2x1bW4gYXQgYW4gZXhpc3RpbmcgbGFiZWwgaXMgYSByZWFzb25hYmxlIHRoaW5nIHRvIHdhbnQuCiAgYXN5bmMgZnVuY3Rpb24gcmVuYW1lTGFiZWwob2xkTmFtZSwgbmV3TmFtZSkgewogICAgaWYgKG9sZE5hbWUgPT09IG5ld05hbWUpIHJldHVybiAndW5jaGFuZ2VkJzsKICAgIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKICAgIGNvbnN0IG9sZElkID0gbGFiZWxJZChvbGROYW1lKTsKICAgIGNvbnN0IGV4aXN0aW5nID0gbGFiZWxJZChuZXdOYW1lKTsKICAgIGlmIChleGlzdGluZyAmJiBleGlzdGluZyAhPT0gb2xkSWQpIHJldHVybiAncmVwb2ludGVkJzsKICAgIGlmICghb2xkSWQpIHJldHVybiAnY3JlYXRlZC1sYXRlcic7CiAgICBjb25zdCB1cGRhdGVkID0gYXdhaXQgYXBpLmdtYWlsKCdQQVRDSCcsIGBsYWJlbHMvJHtvbGRJZH1gLCBudWxsLCB7IG5hbWU6IG5ld05hbWUgfSk7CiAgICBTLmxhYmVscy5kZWxldGUob2xkTmFtZS50b0xvd2VyQ2FzZSgpKTsKICAgIFMubGFiZWxzLnNldChuZXdOYW1lLnRvTG93ZXJDYXNlKCksIHVwZGF0ZWQpOwogICAgcmV0dXJuICdyZW5hbWVkJzsKICB9CgogIC8vIOKUgOKUgCBUaHJlYWRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU",
"gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiB0aHJlYWQoaWQpIHsKICAgIHJldHVybiBTLm1ldGEuZ2V0KGlkKSB8fCBudWxsOwogIH0KCiAgLy8gRmV0Y2hlcyBtZXRhZGF0YSBvbmx5IGZvciB0aHJlYWRzIHRoYXQgYXJlIG5ldyB0byB0aGUgY2FjaGUgb3Igd2hvc2UKICAvLyBoaXN0b3J5SWQgbW92ZWQuIE9uIGEgd2FybSByZWZyZXNoIG9mIGFuIHVuY2hhbmdlZCBib2FyZCB0aGF0IGlzIHplcm8KICAvLyBjYWxscyBiZXlvbmQgdGhlIG9uZSBsaXN0IHBlciBjb2x1bW4uCiAgYXN5bmMgZnVuY3Rpb24gaHlkcmF0ZShyZWZzLCBhY2NvdW50KSB7CiAgICBjb25zdCBuZWVkID0gcmVmcy5maWx0ZXIodCA9PiB7CiAgICAgIGNvbnN0IG0gPSBTLm1ldGEuZ2V0KHQuaWQpOwogICAgICByZXR1cm4gIW0gfHwgKHQuaGlzdG9yeUlkICYmIG0uaGlzdG9yeUlkICE9PSBTdHJpbmcodC5oaXN0b3J5SWQpKTsKICAgIH0pOwogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGFwaS5nbWFpbE1hbnkobmVlZC5tYXAodCA9PiBbJ0dFVCcsIGB0aHJlYWRzLyR7dC5pZH1gLCB7CiAgICAgIGZvcm1hdDogJ21ldGFkYXRhJywKICAgICAgLy8gVG8gYW5kIENjOiB3aGV0aGVyIGEgbWVzc2FnZSBvZiB0aGUgdXNlcidzIG93biB3ZW50IHRvIGFueW9uZSBlbHNlLgogICAgICBtZXRhZGF0YUhlYWRlcnM6IFsnU3ViamVjdCcsICdGcm9tJywgJ0RhdGUnLCAnVG8nLCAn",
"Q2MnXSwKICAgIH1dKSk7CiAgICByZXN1bHRzLmZvckVhY2goKGZ1bGwsIGkpID0-IHsKICAgICAgLy8gT25lIHRocmVhZCBkZWxldGVkIGJldHdlZW4gbGlzdCBhbmQgZ2V0IG11c3Qgbm90IHNpbmsgdGhlIGJvYXJkLgogICAgICBpZiAoZnVsbCAmJiBmdWxsLmVycm9yKSB7CiAgICAgICAgaWYgKGlzRmF0YWwoZnVsbC5lcnJvcikpIHRocm93IGZ1bGwuZXJyb3I7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChmdWxsKSBTLm1ldGEuc2V0KG5lZWRbaV0uaWQsIGxvZ2ljLnN1bW1hcmlzZVRocmVhZChmdWxsLCBhY2NvdW50KSk7CiAgICB9KTsKICB9CgogIC8vIEJyaW5ncyB0aGUgY29sdW1ucycgbGFiZWwgbmFtZXMgaW4gbGluZSB3aXRoIEdtYWlsIChhIGxhYmVsIHJlbmFtZWQKICAvLyB0aGVyZSBpcyBmb2xsb3dlZCBieSBpdHMgaWQpIGFuZCByZWNvcmRzIGlkcyBmb3IgbGFiZWxzIHRoYXQgaGF2ZQogIC8vIHRoZW0uIFNhdmVkIG9ubHkgd2hlbiBzb21ldGhpbmcgY2hhbmdlZC4KICBhc3luYyBmdW5jdGlvbiBzeW5jQ29sdW1uTGFiZWxzKGFjY291bnQsIGNvbHVtbnMpIHsKICAgIGNvbnN0IHsgY29sdW1uczogbmV4dCwgY2hhbmdlZCB9ID0gbG9naWMucmVzb2x2ZUNvbHVtbkxhYmVscyhjb2x1bW5zLCBbLi4uUy5sYWJlbHMudmFsdWVzKCldKTsKICAgIGlmIChjaGFuZ2VkKSBhd2FpdCBzYXZlQ29sdW1ucyhhY2NvdW50LCBuZXh0KTsKICAgIHJldHVybiBuZXh0OwogIH0KCiAgLy8gRXZlcnl0",
"aGluZyB0aGUgYm9hcmQgbmVlZHMgZm9yIG9uZSByZW5kZXI6IHBlci1jb2x1bW4gdGhyZWFkIGlkcwogIC8vIChlYWNoIHRocmVhZCBpbiBleGFjdGx5IG9uZSBjb2x1bW4pLCB3aGljaCBjb2x1bW5zIHdlcmUgY3V0IG9mZiwgYW5kCiAgLy8gdGhlIGNvbHVtbnMgdGhlbXNlbHZlcywgaW4gY2FzZSBhIGxhYmVsIHdhcyByZW5hbWVkIGluIEdtYWlsLgogIGFzeW5jIGZ1bmN0aW9uIGxvYWRCb2FyZChhY2NvdW50LCBjb2x1bW5zSW4pIHsKICAgIC8vIExldCBhbnkgbW92ZSBzdGlsbCBpbiBmbGlnaHQgbGFuZCBmaXJzdCwgb3IgdGhlIGxpc3QgY291bGQgc2hvdyB0aGUKICAgIC8vIHRocmVhZCBiYWNrIGluIHRoZSBjb2x1bW4gaXQgaXMgbGVhdmluZy4KICAgIGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChbLi4uUy5wZW5kaW5nXSk7CiAgICAvLyBSZW5hbWVzIGZpcnN0OiBlbnN1cmluZyBsYWJlbHMgYnkgdGhlaXIgc3RhbGUgbmFtZXMgd291bGQgcmVjcmVhdGUKICAgIC8vIHRoZSBvbGQgb25lcywgZW1wdHkuCiAgICBhd2FpdCByZWZyZXNoTGFiZWxzKCk7CiAgICBsZXQgY29sdW1ucyA9IGF3YWl0IHN5bmNDb2x1bW5MYWJlbHMoYWNjb3VudCwgY29sdW1uc0luKTsKICAgIGF3YWl0IGVuc3VyZUxhYmVscyhjb2x1bW5zLm1hcChjID0-IGMubGFiZWwpKTsKICAgIGNvbHVtbnMgPSBhd2FpdCBzeW5jQ29sdW1uTGFiZWxzKGFjY291bnQsIGNvbHVtbnMpOwoKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBhcGkuZ21h",
"aWxNYW55KGNvbHVtbnMubWFwKGNvbCA9PiBbJ0dFVCcsICd0aHJlYWRzJywgeyBsYWJlbElkczogbGFiZWxJZChjb2wubGFiZWwpLCBtYXhSZXN1bHRzOiAxMDAgfV0pKTsKICAgIGNvbnN0IGZhaWxlZCA9IHJlc3VsdHMuZmluZChyID0-IHIgJiYgci5lcnJvcik7CiAgICBpZiAoZmFpbGVkKSB0aHJvdyBmYWlsZWQuZXJyb3I7CgogICAgY29uc3QgcmF3ID0ge307CiAgICBjb25zdCB0cnVuY2F0ZWQgPSB7fTsKICAgIGNvbnN0IHJlZnMgPSBuZXcgTWFwKCk7CiAgICBjb2x1bW5zLmZvckVhY2goKGNvbCwgaSkgPT4gewogICAgICBjb25zdCByID0gcmVzdWx0c1tpXSB8fCB7fTsKICAgICAgY29uc3QgdGhyZWFkcyA9IHIudGhyZWFkcyB8fCBbXTsKICAgICAgcmF3W2NvbC5pZF0gPSB0aHJlYWRzLm1hcCh0ID0-IHQuaWQpOwogICAgICB0cnVuY2F0ZWRbY29sLmlkXSA9ICEhci5uZXh0UGFnZVRva2VuOwogICAgICBmb3IgKGNvbnN0IHQgb2YgdGhyZWFkcykgcmVmcy5zZXQodC5pZCwgdCk7CiAgICB9KTsKCiAgICBhd2FpdCBoeWRyYXRlKFsuLi5yZWZzLnZhbHVlcygpXSwgYWNjb3VudCk7CiAgICBjb25zdCBsaXN0cyA9IGxvZ2ljLmFzc2lnbkNvbHVtbnMoY29sdW1ucywgcmF3KTsKICAgIGZvciAoY29uc3QgaWQgb2YgT2JqZWN0LmtleXMobGlzdHMpKSBsaXN0c1tpZF0gPSBsaXN0c1tpZF0uZmlsdGVyKHQgPT4gUy5tZXRhLmhhcyh0KSk7CiAgICBlbWl0KCdib2FyZC1sb2FkZWQnLCB7fSk7CiAgICByZXR1cm4g",
"eyBsaXN0cywgdHJ1bmNhdGVkLCBjb2x1bW5zIH07CiAgfQoKICAvLyBgc291cmNlYCBsZXRzIGxpc3RlbmVycyBpZ25vcmUgZWNob2VzIG9mIHRoZWlyIG93biBjaGFuZ2VzOiB0aGUgYm9hcmQKICAvLyBoYXMgYWxyZWFkeSBkcmF3biBhIG1vdmUgaXQgbWFkZSwgdGhlIGRvY2sgaGFzIG5vdC4KICBhc3luYyBmdW5jdGlvbiBtb2RpZnkodGhyZWFkSWQsIGRpZmYsIHNvdXJjZSkgewogICAgY29uc3QgcCA9IGFwaS5nbWFpbCgnUE9TVCcsIGB0aHJlYWRzLyR7dGhyZWFkSWR9L21vZGlmeWAsIG51bGwsIGRpZmYpOwogICAgUy5wZW5kaW5nLmFkZChwKTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IHA7CiAgICB9IGZpbmFsbHkgewogICAgICBTLnBlbmRpbmcuZGVsZXRlKHApOwogICAgfQogICAgLy8gTWFyayB0aGUgY2FjaGVkIHN1bW1hcnkgc3RhbGUgc28gdGhlIG5leHQgcmVmcmVzaCByZS1yZWFkcyBpdCwgYW5kCiAgICAvLyBrZWVwIGl0cyBsYWJlbCBzZXQgaG9uZXN0IGluIHRoZSBtZWFudGltZS4KICAgIGNvbnN0IG0gPSBTLm1ldGEuZ2V0KHRocmVhZElkKTsKICAgIGlmIChtKSB7CiAgICAgIG0uaGlzdG9yeUlkID0gJyc7CiAgICAgIGNvbnN0IGxhYmVscyA9IG5ldyBTZXQobS5sYWJlbElkcyk7CiAgICAgIGRpZmYucmVtb3ZlTGFiZWxJZHMuZm9yRWFjaChpZCA9PiBsYWJlbHMuZGVsZXRlKGlkKSk7CiAgICAgIGRpZmYuYWRkTGFiZWxJZHMuZm9yRWFjaChpZCA9PiBsYWJlbHMuYWRkKGlkKSk7CiAgICAgIG0u",
"bGFiZWxJZHMgPSBbLi4ubGFiZWxzXTsKICAgIH0KICAgIGVtaXQoJ3RocmVhZC1jaGFuZ2VkJywgeyB0aHJlYWRJZCwgc291cmNlIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gbW92ZVRvQ29sdW1uKHRocmVhZElkLCBjb2x1bW5zLCBjb2x1bW5JZCwgc291cmNlKSB7CiAgICBhd2FpdCBlbnN1cmVMYWJlbHMoY29sdW1ucy5tYXAoYyA9PiBjLmxhYmVsKSk7CiAgICBhd2FpdCBtb2RpZnkodGhyZWFkSWQsIGxvZ2ljLm1vdmVMYWJlbERpZmYoY29sdW1ucywgY29sdW1uSWQsIGxhYmVsSWQpLCBzb3VyY2UpOwogIH0KCiAgLy8gVGFraW5nIGEgY2FyZCBvZmYgdGhlIGJvYXJkIGFsc28gZm9yZ2V0cyBpdHMgdGl0bGUsIG5vdGUgYW5kIGNvbG91ci4KICAvLyBFZGl0cyB3b3VsZCBvdGhlcndpc2Ugb3V0bGl2ZSB0aGVpciBjYXJkLCBhbmQgc3luYydzIHF1b3RhIGlzIHNtYWxsCiAgLy8gZW5vdWdoIHRoYXQgbGVmdG92ZXJzIHdvdWxkIGV2ZW50dWFsbHkgY3Jvd2Qgb3V0IHRoZSBvbmVzIGluIHVzZS4gQQogIC8vIGNhcmQgdGhhdCBtZXJlbHkgbW92ZXMgdG8gRG9uZSBrZWVwcyB0aGVtLgogIGFzeW5jIGZ1bmN0aW9uIHJlbW92ZUZyb21Cb2FyZCh0aHJlYWRJZCwgY29sdW1ucywgc291cmNlLCBhY2NvdW50KSB7CiAgICBpZiAoIVMubGFiZWxzQXQpIGF3YWl0IHJlZnJlc2hMYWJlbHMoKTsKICAgIGF3YWl0IG1vZGlmeSh0aHJlYWRJZCwgbG9naWMucmVtb3ZlTGFiZWxEaWZmKGNvbHVtbnMsIGxhYmVsSWQpLCBzb3Vy",
"Y2UpOwogICAgaWYgKGFjY291bnQpIGF3YWl0IHNhdmVDYXJkRWRpdChhY2NvdW50LCB0aHJlYWRJZCwgbnVsbCkuY2F0Y2goKCkgPT4ge30pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2VhcmNoKHRleHQsIGFjY291bnQpIHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkuZ21haWwoJ0dFVCcsICd0aHJlYWRzJywgeyBxOiBsb2dpYy5zZWFyY2hRdWVyeSh0ZXh0KSwgbWF4UmVzdWx0czogMTUgfSk7CiAgICBjb25zdCByZWZzID0gci50aHJlYWRzIHx8IFtdOwogICAgYXdhaXQgaHlkcmF0ZShyZWZzLCBhY2NvdW50KTsKICAgIHJldHVybiByZWZzLm1hcCh0ID0-IHQuaWQpLmZpbHRlcihpZCA9PiBTLm1ldGEuaGFzKGlkKSk7CiAgfQoKICAvLyBXaGljaCBjb2x1bW4gKGlmIGFueSkgYSBzaW5nbGUgdGhyZWFkIGlzIGluIC0gZm9yIHRoZSBkb2NrLCB3aGljaCBoYXMKICAvLyBubyBib2FyZCBsb2FkZWQuIGZvcm1hdD1taW5pbWFsIGlzIHRoZSBjaGVhcGVzdCBjYWxsIHRoYXQgcmV0dXJucwogIC8vIGxhYmVsIGlkcy4KICBhc3luYyBmdW5jdGlvbiB0aHJlYWRDb2x1bW4odGhyZWFkSWQsIGNvbHVtbnMpIHsKICAgIGlmICghUy5sYWJlbHNBdCkgYXdhaXQgcmVmcmVzaExhYmVscygpOwogICAgY29uc3QgdCA9IGF3YWl0IGFwaS5nbWFpbCgnR0VUJywgYHRocmVhZHMvJHt0aHJlYWRJZH1gLCB7IGZvcm1hdDogJ21pbmltYWwnIH0pOwogICAgY29uc3QgbGFiZWxzID0gKHQubWVzc2FnZXMgfHwgW10pLmZsYXRNYXAobSA9",
"PiBtLmxhYmVsSWRzIHx8IFtdKTsKICAgIHJldHVybiBsb2dpYy5jb2x1bW5Gb3JMYWJlbHMoY29sdW1ucywgbGFiZWxzLCBsYWJlbElkKTsKICB9CgogIG5zLnN0b3JlID0gewogICAgYnVzLCBsb2FkQ29sdW1ucywgc2F2ZUNvbHVtbnMsIGxvYWRPcmRlciwgc2F2ZU9yZGVyLCBsb2FkQ2FyZEVkaXRzLCBzYXZlQ2FyZEVkaXQsIGxvYWREb2NrUGxhY2UsCiAgICByZWZyZXNoTGFiZWxzLCBlbnN1cmVMYWJlbHMsIHJlbmFtZUxhYmVsLCBsYWJlbElkLCBhbGxMYWJlbHMsCiAgICB0aHJlYWQsIGxvYWRCb2FyZCwgbW92ZVRvQ29sdW1uLCByZW1vdmVGcm9tQm9hcmQsIHNlYXJjaCwgdGhyZWFkQ29sdW1uLAogIH07Cn0pKCk7Cg\"],[\"addon/app/remote-board.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAncyBmaXJzdCBjb2x1bW4gbGF5b3V0Ci8vCi8vIFRoZSBib2FyZCBrZWVwcyBpdHMgY29sdW1uIGxheW91dCBpbiBpdHMgc3luY2VkIHNldHRpbmdzLCB3aGljaCBoZXJlCi8vIGFyZSB0aGUgYXBwJ3Mgb3duLiBVbnRpbCBpdCBoYXMgb25lLCB0aGUgZ",
"Xh0ZW5zaW9uJ3MgZGVmYXVsdCBjb2x1bW5zCi8vIHdvdWxkIGJyaW5nIGJhY2sgIl9Cb2FyZC9XYWl0aW5nIiBhcyBhIGZyZXNoLCBlbXB0eSBsYWJlbCBmb3Igc29tZW9uZQovLyB3aG9zZSBjb2x1bW4gaXMgIl9Cb2FyZC9XYWl0aW5nIG9uIG90aGVycyI7IHNvIHRoZSBmaXJzdCBsYXlvdXQgaXMKLy8gdGhlIGJvYXJkJ3MgbGFiZWxzIGFzIEdtYWlsIGhhcyB0aGVtIC0gYXMgdGhlIHBob25lIHBhbmVsIHJlYWRzIHRoZW0uCi8vIFdpdGggbm8gYm9hcmQgbGFiZWxzIGF0IGFsbCwgdGhlIHVzdWFsIGNvbHVtbnMsIG1hZGUgYXMgaW4gQ2hyb21lLgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IGdsb2JhbFRoaXMuZ2tiOwogIGNvbnN0IHsgc3RvcmUsIGxvZ2ljLCBLRVlTIH0gPSBuczsKICBjb25zdCBzYXZlZCA9IHN0b3JlLmxvYWRDb2x1bW5zOwoKICBzdG9yZS5sb2FkQ29sdW1ucyA9IGFzeW5jIGFjY291bnQgPT4gewogICAgY29uc3Qga2V5ID0gS0VZUy5jb2x1bW5zKGFjY291bnQpOwogICAgaWYgKChhd",
"2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLmdldChrZXkpKVtrZXldKSByZXR1cm4gc2F2ZWQoYWNjb3VudCk7CiAgICBjb25zdCBmcm9tTGFiZWxzID0gYXdhaXQgbnMuYXBwUmVtb3RlLmZpcnN0Q29sdW1ucygpOwogICAgcmV0dXJuIGxvZ2ljLm5vcm1hbGlzZUNvbHVtbnMoZnJvbUxhYmVscyB8fCB1bmRlZmluZWQpOwogIH07Cn0pKCk7Cg\"],[\"src/content/notes.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBub3RlcyB2aWV3Ci8vCi8vIFRoZSBib2FyZCdzIHNlY29uZCB0YWI6IGZvbGRlcnMgb24gdGhlIGxlZnQsIHRoZW4gdGhlIG5vdGVzIGluIHRoZQovLyBjaG9zZW4gZm9sZGVyLCB0aGVuIHRoZSBvcGVuIG5vdGUuIFR5cGluZyBzYXZlcyBieSBpdHNlbGYgYSBtb21lbnQgYWZ0ZXIKLy8geW91IHN0b3AsIGFuZCBhZ2FpbiBvbiBzd2l0Y2hpbmcgbm90ZXMsIHN3aXRjaGluZyB0YWJzIG9yIGNsb3Npbmc7Ci8vIEN0cmwrUyBzYXZlcyBhdCBvbmNlLiBBIG5vdGUgbW92ZXMgdG8gYW5vdGhlciBmb2xkZXIgYnkgZHJhZ2dpbmcgaXQgb250bwovLyBvbmUsIG9yIGZ",
"yb20gdGhlIGZvbGRlciBidXR0b24gYWJvdmUgdGhlIHRleHQuCi8vCi8vIFRoZSBib2FyZCBvd25zIHRoZSBvdmVybGF5LCB0aGUgaGVhZGVyIGFuZCB0aGUgYWNjb3VudCBwYW5lbHMgKHNldHVwLAovLyBjb25uZWN0KTsgdGhpcyBmaWxlIG93bnMgZXZlcnl0aGluZyBpbnNpZGUgdGhlIGJvZHkgd2hpbGUgdGhlIE5vdGVzIHRhYgovLyBpcyBzaG93aW5nLiBJdHMgZWxlbWVudCBpcyBidWlsdCBvbmNlIGFuZCBrZXB0LCBzbyB0aGF0IGEgYm9hcmQgcmVkcmF3Ci8vIG5ldmVyIHB1bGxzIHRoZSB0ZXh0IGJveCBvdXQgZnJvbSB1bmRlciBzb21lb25lIHdobyBpcyB0eXBpbmcuCi8vCi8vIFRoZSBzY3JhdGNocGFkIGlzIHRoZSBub3RlIHRoYXQgaXMgb3BlbiB3aGVuZXZlciBubyBvdGhlciBvbmUgaXM6IG9uZQovLyBub3RlIHdpdGggYSBmaXhlZCBpZCwgc2hhcmVkIGJ5IGV2ZXJ5IGNvbXB1dGVyIGFuZCBwaG9uZSwgdGhlcmUgdG8gdHlwZQovLyBpbnRvIHRoZSBtb21lbnQgdGhlIG5vdGVzIGFwcGVhci4gSXQgaXMgcGlubmVkIGF0IHRoZSB0b3Agb2YgdGhlIGxpc3QsCi8vIGFuZCBjYW5ub3QgYmUgcmVuYW1lZCwgbW92ZWQgb3IgZGVsZXRlZC4gVGhlIGNhbGVuZGFyJ3Mgd2VlaywgaW4gdHdvCi8vIHJvd3MsIHNob3dzIGl0IHRvbywgaW4gYSB0aWxlIG9mIGl0cyBvd24gKHNjcmF0Y2hUaWxlKTogYSBzZWNvbmQgZWRpdG9yCi8vIG9uIHRoZSBzYW1lIHN0YXRlLCBzYXZlZCBhbmQgbWVyZ2VkIGJ5IHRoaXMgZml",
"sZS4KLy8KLy8gVGhlIHBob25lIGFwcCAoYWRkb24vYXBwKSBydW5zIHRoaXMgc2FtZSB2aWV3IGZ1bGwtc2NyZWVuIG9uIGEgcGhvbmUsCi8vIHdpdGggYSBkaWZmZXJlbnQgd2F5IHRvIEdtYWlsIGJlaGluZCBub3Rlc1N0b3JlLiBBIHBob25lIHNob3dzIG9uZQovLyB0aGluZyBhdCBhIHRpbWUsIGFuZCB0aGUgZWxlbWVudCBzYXlzIHdoaWNoIChkYXRhLXZpZXcpOiAiaG9tZSIsIHRoZQovLyBzZWFyY2ggYm94IGFuZCB0aGUgc2NyYXRjaHBhZDsgImxpc3QiLCB0aGUgbm90ZXMgaW4gYSBmb2xkZXIgb3IgYQovLyBzZWFyY2g7IG9yICJub3RlIiwgYSBub3RlIGZ1bGwtc2NyZWVuLiBUaGUgbm90ZSdzIEJhY2sgYnV0dG9uIGFuZCB0aGUKLy8gZm9sZGVyIHRyZWUncyBidXR0b24gb25seSBzaG93IGluIHRoZSBwaG9uZSdzIHN0eWxlc2hlZXQuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgdG9hc3QsIG9",
"wZW5NZW51IH0gPSBucy51aTsKICBjb25zdCB7IHV0aWwsIG5vdGVzTG9naWMsIG5vdGVzU3RvcmUsIGhvb2tzLCBhcGkgfSA9IG5zOwogIGNvbnN0IGZtdCA9IG5zLm5vdGVGb3JtYXQ7CiAgY29uc3Qgc2VhcmNoTG9naWMgPSBucy5zZWFyY2hMb2dpYzsKCiAgLy8gSG93IG1hbnkgc2VhcmNoIHJlc3VsdHMgZ2V0IGV4Y2VycHRzIGF0IG9uY2UuIEVhY2ggbmVlZHMgdGhlIG5vdGUncwogIC8vIGZ1bGwgdGV4dCwgd2hpY2ggaXMgb25lIG1vcmUgcmVxdWVzdCB0aGUgZmlyc3QgdGltZS4KICBjb25zdCBFWENFUlBUX0xJTUlUID0gMzA7CgogIC8vIExvbmcgZW5vdWdoIG5vdCB0byBzYXZlIG1pZC1zZW50ZW5jZSAoZWFjaCBzYXZlIGlzIGEgbmV3IG1lc3NhZ2UgYW5kCiAgLy8gYSB0cmFzaGVkIG9sZCBvbmUpLCBzaG9ydCBlbm91Z2ggdGhhdCBsaXR0bGUgaXMgYXQgcmlzay4KICBjb25zdCBBVVRPU0FWRV9NUyA9IDI1MDA7CiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CgogIGNvbnN0IFNDUkFUQ0hfS0VZID0gYG46JHtub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfSUR9YDsKCiAgY29uc3QgTiA9IHsKICAgIGN0eDogbnVsbCwgICAgICAgICAgLy8geyByb290LCBvblN0YXRlRXJyb3IsIG9uTG9hZGVkLCBjbG9zZUJvYXJkLCBiYXJDaGFuZ2VkIH0KICAgIG5vdGVzOiBbXSwgICAgICAgICAgLy8gbGl2ZSBub3RlcywgbmV3ZXN0IGZpcnN0IChtZXRhZGF0YSBvbmx5KQogICAgdHJ1bmNhdGVkOiBmYWxzZSwKICAgIHF",
"1ZXJ5OiAnJywKICAgIHN0YXR1czogJ2lkbGUnLCAgICAgLy8gaWRsZSB8IGxvYWRpbmcgfCByZWFkeSB8IGVycm9yCiAgICBlcnJvcjogJycsCiAgICBsb2FkZWRBdDogMCwKICAgIGxvYWRpbmc6IG51bGwsCiAgICBjdXJyZW50OiBudWxsLCAgICAgIC8vIHRoZSBub3RlIGJlaW5nIGVkaXRlZCAtIHNlZSBuZXdDdXJyZW50KCk7IHRoZSBzY3JhdGNocGFkIHdoZW4gbm8gb3RoZXIgaXMKICAgIHNjcmF0Y2g6IG51bGwsICAgICAgLy8gdGhlIHNjcmF0Y2hwYWQgYmVpbmcgZWRpdGVkLCBoZXJlIG9yIGluIHRoZSBjYWxlbmRhcidzIHRpbGUsIG9wZW4gaGVyZSBvciBub3QKICAgIHNjcmF0Y2hOb3RlOiBudWxsLCAgLy8gdGhlIHNjcmF0Y2hwYWQncyBtZXNzYWdlLCBvbmNlIGxpc3RlZCAobnVsbDogbmV2ZXIgc2F2ZWQgeWV0KQogICAgc2NyYXRjaEtub3duOiBmYWxzZSwgLy8gd2hldGhlciB0aGUgbGlzdGluZyBoYXMgc2FpZCBpZiB0aGVyZSBpcyBvbmUKICAgIGJyb3dzaW5nOiBmYWxzZSwgICAgLy8gYSBwaG9uZTogdGhlIGxpc3QgaXMgc2hvd2luZywgcmF0aGVyIHRoYW4gdGhlIHNjcmF0Y2hwYWQKICAgIHdhbnRGb2N1czogZmFsc2UsICAgLy8gcHV0IHRoZSBjdXJzb3IgaW4gdGhlIHNjcmF0Y2hwYWQgb25jZSBpdCBpcyByZWFkeQogICAgY2hhaW46IFByb21pc2UucmVzb2x2ZSgpLCAvLyBzYXZlcyBhbmQgbW92ZXMgcnVuIG9uZSBhZnRlciBhbm90aGVyCiAgICBmb2xkZXJzOiBbXSwgICAgICAgIC8vIG5vdGV",
"zTG9naWMuZm9sZGVyVHJlZSgpLCBmcm9tIHRoZSBsYXN0IGxpc3RpbmcKICAgIGZvbGRlcjogJycsICAgICAgICAgLy8gdGhlIGZvbGRlciBzaG93bjsgJycgZm9yIGFsbCBub3RlcwogICAgZm9sZGVyRWRpdDogbnVsbCwgICAvLyB7IG1vZGU6ICduZXcnIHwgJ3JlbmFtZScsIHBhcmVudElkLCBmb2xkZXJJZCwgdmFsdWUsIGVycm9yLCBidXN5IH0KICAgIGZvbGRlZDogbmV3IFNldCgpLCAgLy8gZm9sZGVycyB3aG9zZSBzdWJmb2xkZXJzIGFyZSBmb2xkZWQgYXdheQogICAgZm9sZGVkUmVhZDogZmFsc2UsICAvLyB0aGUgc2F2ZWQgc2V0IGhhcyBiZWVuIGFza2VkIGZvcgogICAgZHJhZ0tleTogJycsICAgICAgICAvLyB0aGUgbm90ZSBiZWluZyBkcmFnZ2VkIG9udG8gYSBmb2xkZXIKICAgIHRlcm1zOiBbXSwgICAgICAgICAgLy8gc2VhcmNoTG9naWMucXVlcnlUZXJtcygpIG9mIHRoZSBzZWFyY2ggdGhhdCBpcyBzaG93aW5nCiAgICBoaXRzOiBuZXcgTWFwKCksICAgIC8vIGAke21lc3NhZ2VJZH18JHt0ZXJtc31gIOKGkiB7IGNvdW50LCBleGNlcnB0cyB9CiAgICBmaW5kSW5kZXg6IDAsICAgICAgIC8vIHdoaWNoIG1hdGNoIGluIHRoZSBvcGVuIG5vdGUgaXMgdGhlIGN1cnJlbnQgb25lCiAgfTsKCiAgbGV0IHNlYXJjaFRpbWVyID0gMDsKICBsZXQgZmluZFRpbWVyID0gMDsKICBjb25zdCBlbHMgPSB7fTsKICAvLyBUaGUgY2FsZW5kYXIncyBzY3JhdGNocGFkIHRpbGU6IGl0cyBlbGVtZW50LCBlZGl0b3IgYW5",
"kIHN0YXR1cyBsaW5lLAogIC8vIHRoZSBzdGF0ZSBpdCBzaG93cywgYW5kIHdoZXRoZXIgdGhlIG5vdGVzJyBlZGl0b3IgY2hhbmdlZCB0aGF0IHNpbmNlLgogIGNvbnN0IFQgPSB7IGVsOiBudWxsLCBib2R5OiBudWxsLCBzdGF0dXM6IG51bGwsIGVkOiBudWxsLCBmb3I6IG51bGwsIHN0YWxlOiBmYWxzZSB9OwoKICAvLyDilIDilIAgU2V0dXAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGluaXQoY3R4KSB7CiAgICBOLmN0eCA9IGN0eDsKICAgIE4udmlldyA9ICcnOwogICAgLy8gQ2xvc2luZyB0aGUgdGFiIG1pZC1zZW50ZW5jZSB3b3VsZCBsb3NlIHRoZSBsYXN0IGZldyBzZWNvbmRzIG9mCiAgICAvLyB0eXBpbmc7IHRoZSBicm93c2VyJ3Mgb3duICJMZWF2ZSBzaXRlPyIgcHJvbXB0IGlzIHRoZSBvbmx5IGRlZmVuY2UuCiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JldW5sb2FkJywgZSA9PiB7CiAgICAgIGlmIChbTi5jdXJyZW50LCBOLnNjcmF0Y2hdLnNvbWUoYyA9PiBjICYmIChjLmRpcnR5IHx8IGMuc2F2aW5nKSkpIHsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgZS5yZXR1cm5",
"WYWx1ZSA9ICcnOwogICAgICB9CiAgICB9KTsKICB9CgogIC8vIEFjY291bnQgdHJvdWJsZSBnb2VzIHRvIHRoZSBib2FyZCwgd2hpY2ggc2hvd3MgaXRzIHBhbmVsIGluIHBsYWNlIG9mCiAgLy8gdGhlIG5vdGVzIC0gYnV0IG9ubHkgd2hpbGUgdGhlIG5vdGVzIGFyZSBzaG93aW5nLiBUaGUgY2FsZW5kYXIgd29ya3MKICAvLyB3aXRob3V0IEdtYWlsLCBhbmQgaXRzIHNjcmF0Y2hwYWQgdGlsZSBzYXlzIHdoYXQgd2VudCB3cm9uZyBpdHNlbGYuCiAgZnVuY3Rpb24gc3RhdGVFcnJvcihlcnIpIHsKICAgIGlmIChlbHMud3JhcCAmJiBlbHMud3JhcC5pc0Nvbm5lY3RlZCkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgfQoKICBmdW5jdGlvbiBlbGVtZW50KCkgewogICAgaWYgKGVscy53cmFwKSB7CiAgICAgIC8vIFRoZSBzY3JhdGNocGFkIHdhcyB0eXBlZCBpbnRvIGluIHRoZSBjYWxlbmRhcidzIHRpbGUgbWVhbndoaWxlLgogICAgICBpZiAoZWxzLmVkU3RhbGUpIGRyYXdFZGl0b3IoKTsKICAgICAgcmV0dXJuIGVscy53cmFwOwogICAgfQoKICAgIGVscy5zZWFyY2ggPSBoKCdpbnB1dCcsIHsKICAgICAgdHlwZTogJ3NlYXJjaCcsIHBsYWNlaG9sZGVyOiAnU2VhcmNoIG5vdGVzJywgJ2FyaWEtbGFiZWwnOiAnU2VhcmNoIG5vdGVzJywKICAgICAgZGF0YXNldDogeyBrZXk6ICdub3Rlcy1zZWFyY2gnIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4gewogICAgICAgIE4ucXVlcnkgPSBlLnRhcmdldC52YWx1ZTsKICAgICA",
"gICAvLyBPbiBhIHBob25lLCBhIHNlYXJjaCBzaG93cyB0aGUgbGlzdCBpbiBwbGFjZSBvZiB0aGUgc2NyYXRjaHBhZC4KICAgICAgICBpZiAoTi5xdWVyeS50cmltKCkgJiYgIU4uYnJvd3NpbmcpIHsgTi5icm93c2luZyA9IHRydWU7IHNldFZpZXcoKTsgfQogICAgICAgIGNsZWFyVGltZW91dChzZWFyY2hUaW1lcik7CiAgICAgICAgc2VhcmNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0-IGxvYWQoeyBmb3JjZTogdHJ1ZSB9KSwgNDAwKTsKICAgICAgfSwKICAgICAgb25rZXlkb3duOiBlID0-IHsKICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOyBsb2FkKHsgZm9yY2U6IHRydWUgfSk7IH0KICAgICAgfSwKICAgIH0pOwogICAgZWxzLml0ZW1zID0gaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLWl0ZW1zJywgcm9sZTogJ2xpc3QnLCAnYXJpYS1sYWJlbCc6ICdOb3RlcycgfSk7CiAgICBlbHMuZm9vdCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1mb290JyB9KTsKICAgIGVscy5zY29wZSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1zY29wZScgfSk7CgogICAgZWxzLmxpc3QgPSBoKCdzZWN0aW9uJywgeyBjbGFzczogJ25vdGVzLWxpc3QnLCAnYXJpYS1sYWJlbCc6ICdOb3RlcycgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ25vdGVzLXRvb2xzJyB9LAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdzZWFyY2gtYm9",
"4JyB9LCBpY29uKCdzZWFyY2gnLCAxOCksIGVscy5zZWFyY2gpLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnYnRuIGJ0bi10b25hbCcsIHR5cGU6ICdidXR0b24nLCBkYXRhc2V0OiB7IGtleTogJ25vdGUtbmV3JyB9LAogICAgICAgICAgdGl0bGU6ICdOZXcgbm90ZScsIG9uY2xpY2s6ICgpID0-IG5ld05vdGUoKSwKICAgICAgICB9LCBpY29uKCdhZGQnLCAxOCksICdOZXcnKSksCiAgICAgIGVscy5zY29wZSwKICAgICAgZWxzLml0ZW1zLAogICAgICBlbHMuZm9vdCk7CgogICAgZWxzLmZvbGRlckl0ZW1zID0gaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlci1pdGVtcycsIHJvbGU6ICdsaXN0JywgJ2FyaWEtbGFiZWwnOiAnRm9sZGVycycgfSk7CiAgICAvLyBPbiBhIHBob25lIHRoZSB0cmVlIGZvbGRzIGF3YXkgYmVoaW5kIG9uZSBidXR0b24gdGhhdCBzYXlzIHdoZXJlCiAgICAvLyB5b3UgYXJlOyBvbmx5IHRoZSBwaG9uZSdzIHN0eWxlc2hlZXQgc2hvd3MgaXQuCiAgICBlbHMuZm9sZGVyc1RvZ2dsZSA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdmb2xkZXJzLXRvZ2dsZScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1leHBhbmRlZCc6ICdmYWxzZScsIGRhdGFzZXQ6IHsga2V5OiAnZm9sZGVycy10b2dnbGUnIH0sCiAgICAgIG9uY2xpY2s6ICgpID0-IHNldEZvbGRlcnNPcGVuKGVscy53cmFwLmRhdGFzZXQuZm9sZGVycyAhPT0gJ29wZW4nKSwKICAgIH0pOwogICAgZWxzLmZvbGR",
"lcnNQYW5lID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdub3Rlcy1mb2xkZXJzJywgJ2FyaWEtbGFiZWwnOiAnRm9sZGVycycgfSwKICAgICAgZWxzLmZvbGRlcnNUb2dnbGUsCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmb2xkZXJzLWhlYWQnIH0sCiAgICAgICAgaCgnaDInLCB7IHRleHQ6ICdGb2xkZXJzJyB9KSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsIHRpdGxlOiAnTmV3IGZvbGRlcicsICdhcmlhLWxhYmVsJzogJ05ldyBmb2xkZXInLAogICAgICAgICAgZGF0YXNldDogeyBrZXk6ICdmb2xkZXItbmV3JyB9LCBvbmNsaWNrOiAoKSA9PiBzdGFydEZvbGRlckVkaXQoeyBtb2RlOiAnbmV3JywgcGFyZW50SWQ6ICcnIH0pLAogICAgICAgIH0sIGljb24oJ2FkZCcsIDIwKSkpLAogICAgICBlbHMuZm9sZGVySXRlbXMpOwoKICAgIGVscy5lZGl0b3IgPSBoKCdzZWN0aW9uJywgeyBjbGFzczogJ25vdGUtZWRpdG9yJywgJ2FyaWEtbGFiZWwnOiAnTm90ZScgfSk7CiAgICBlbHMud3JhcCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdub3RlcycsIGRhdGFzZXQ6IHsgZm9sZGVyczogJ2Nsb3NlZCcgfSB9LCBlbHMuZm9sZGVyc1BhbmUsIGVscy5saXN0LCBlbHMuZWRpdG9yKTsKICAgIGlmICghTi5jdXJyZW50KSBOLmN1cnJlbnQgPSBzY3JhdGNoU3RhdGUoKTsKICAgIGRyYXdGb2xkZXJzKCk7CiAgICBkcmF3TGlzdCgpOwogICAgZHJhd0VkaXRvcig",
"pOwogICAgLy8gVGV4dCB0eXBlZCBsYXN0IHRpbWUgYW5kIG5vdCBzYXZlZCBiZWZvcmUgdGhlIHBhZ2Ugd2VudC4KICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoYyAmJiBjLmRpcnR5KSBsYXRlclNhdmUoYyk7CiAgICByZXR1cm4gZWxzLndyYXA7CiAgfQoKICAvLyBUaGUgc2NyYXRjaHBhZCdzIHN0YXRlLCBtYWRlIHRoZSBmaXJzdCB0aW1lIGFueXRoaW5nIHdhbnRzIGl0OiBmcm9tCiAgLy8gdGhlIHBob25lIGFwcCdzIGNvcHkgaWYgdGhlcmUgaXMgb25lLCBvciB3YWl0aW5nIGZvciB0aGUgbGlzdC4KICBmdW5jdGlvbiBzY3JhdGNoU3RhdGUoKSB7CiAgICBpZiAoIU4uc2NyYXRjaCAmJiAhZnJvbUNvcHkoKSkgcGVuZGluZ1NjcmF0Y2goKTsKICAgIHJldHVybiBOLnNjcmF0Y2g7CiAgfQoKICAvLyBUaGUgcGhvbmUgYXBwJ3Mgb3duIGNvcHkgKG5vdGVzU3RvcmUuY2FjaGVkKTogdGhlIGxpc3QgYW5kIHRoZQogIC8vIHNjcmF0Y2hwYWQgYXMgdGhleSB3ZXJlIHdoZW4gaXQgbGFzdCBoZWFyZCBmcm9tIEdtYWlsLCBhbmQgYW55IHRleHQKICAvLyB0eXBlZCBhbmQgbm90IHlldCBzYXZlZC4gVGhlIHNjcmF0Y2hwYWQgdGFrZXMgdHlwaW5nIGF0IG9uY2U7IEdtYWlsJ3MKICAvLyBhbnN3ZXIgY2F0Y2hlcyB1cCB3aXRoIGl0IGFmdGVyIChjYXRjaFVwQ3VycmVudCwgYWRvcHROZXdlcikuCiAgZnVuY3Rpb24gZnJvbUNvcHkoKSB7CiAgICBjb25zdCBjb3B5ID0gbm90ZXNTdG9yZS5jYWNoZWQgPyBub3R",
"lc1N0b3JlLmNhY2hlZCgpIDogbnVsbDsKICAgIGlmICghY29weSkgcmV0dXJuIG51bGw7CiAgICBpZiAoY29weS5ub3RlcykgewogICAgICBOLm5vdGVzID0gY29weS5ub3RlczsKICAgICAgTi50cnVuY2F0ZWQgPSAhIWNvcHkudHJ1bmNhdGVkOwogICAgICBOLmZvbGRlcnMgPSBjb3B5LmZvbGRlcnMgfHwgW107CiAgICAgIE4uc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgTi5sb2FkZWRBdCA9IDA7IC8vIHN0aWxsIHRvIGJlIGFza2VkIGZvcgogICAgfQogICAgaWYgKGNvcHkuc2NyYXRjaCkgewogICAgICBOLnNjcmF0Y2hOb3RlID0gY29weS5zY3JhdGNoLm5vdGUgfHwgbnVsbDsKICAgICAgTi5zY3JhdGNoS25vd24gPSB0cnVlOwogICAgfQogICAgY29uc3QgZnJvbSA9IGNvcHkuZHJhZnQgfHwgY29weS5zY3JhdGNoOwogICAgaWYgKCFmcm9tKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGMgPSBzY3JhdGNoQ3VycmVudChmcm9tLm5vdGUgfHwgbnVsbCk7CiAgICBjLmJhc2UgPSBjb3B5LmRyYWZ0ID8gY29weS5kcmFmdC5iYXNlIHx8IGZtdC5lbXB0eURvYygpIDogZnJvbS5kb2MgfHwgZm10LmVtcHR5RG9jKCk7CiAgICBjLmRvYyA9IGZyb20uZG9jIHx8IGZtdC5lbXB0eURvYygpOwogICAgYy5ib2R5U3RhdGUgPSAncmVhZHknOwogICAgYy5kaXJ0eSA9ICEhY29weS5kcmFmdDsKICAgIHJldHVybiBjOwogIH0KCiAgLy8gV2hhdCB0aGUgcGhvbmUgYXBwJ3MgZmlyc3QgY2FsbCBmb3VuZCB0aGUgc2NyYXRjaHBhZCB",
"0byBiZTogaW4gR21haWwKICAvLyBhbHJlYWR5LCBwZXJoYXBzIG5ld2VyIHRoYW4gdGhlIGNvcHkgaXQgb3BlbmVkIHdpdGguCiAgZnVuY3Rpb24gc2NyYXRjaEZvdW5kKG5vdGUpIHsKICAgIGlmICghbm90ZSB8fCAhaXNOZXdlcihub3RlLCBOLnNjcmF0Y2hOb3RlKSkgcmV0dXJuOwogICAgTi5zY3JhdGNoTm90ZSA9IG5vdGU7CiAgICBOLnNjcmF0Y2hLbm93biA9IHRydWU7CiAgICBjYXRjaFVwQ3VycmVudCgpOwogIH0KCiAgLy8g4pSA4pSAIExvYWRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIGlzU3RhbGUoKSB7CiAgICByZXR1cm4gTi5zdGF0dXMgIT09ICdyZWFkeScgfHwgRGF0ZS5ub3coKSAtIE4ubG9hZGVkQXQgPiBTVEFMRV9NUzsKICB9CgogIGZ1bmN0aW9uIGxvYWQoeyBmb3JjZSA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKE4ubG9hZGluZykgcmV0dXJuIE4ubG9hZGluZzsKICAgIGlmICghZm9yY2UgJiYgIWlzU3RhbGUoKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOwogICAgY29uc3QgcXVlcnkgPSBOLnF1ZXJ5OwogICAgaWYgKCFOLm5vdGVzLmxlbmd0aCkgTi5zdGF0dXMgPSAnbG9hZGluZyc7CiAgICB",
"kcmF3TGlzdCgpOwoKICAgIE4ubG9hZGluZyA9IChhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgZm9sZGVkID0gTi5mb2xkZWRSZWFkID8gbnVsbCA6IHJlYWRGb2xkZWQoKTsKICAgICAgICBjb25zdCByID0gYXdhaXQgbm90ZXNTdG9yZS5saXN0KGhvb2tzLmdldEFjY291bnQoKSwgcXVlcnkpOwogICAgICAgIGlmIChmb2xkZWQpIGF3YWl0IGZvbGRlZDsKICAgICAgICBpZiAocXVlcnkgIT09IE4ucXVlcnkpIHJldHVybjsgLy8gYSBuZXdlciBzZWFyY2ggaGFzIHN0YXJ0ZWQKICAgICAgICBsZXQgc2NyYXRjaCA9IHIubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBTQ1JBVENIX0tFWSkgfHwgbnVsbDsKICAgICAgICAvLyBOb3QgYW1vbmcgdGhlIG5ld2VzdCBodW5kcmVkOiBhc2sgR21haWwgZm9yIGl0IGJ5IG5hbWUsIHJhdGhlcgogICAgICAgIC8vIHRoYW4gc3RhcnQgYSBzZWNvbmQgb25lIHRoYXQgd291bGQgcHVzaCB0aGUgZmlyc3QgaW50byBUcmFzaC4KICAgICAgICBpZiAoIXNjcmF0Y2ggJiYgIXF1ZXJ5ICYmIHIudHJ1bmNhdGVkKSB7CiAgICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IG5vdGVzU3RvcmUubGlzdChob29rcy5nZXRBY2NvdW50KCksIG5vdGVzTG9naWMuU0NSQVRDSFBBRF9USVRMRSk7CiAgICAgICAgICBzY3JhdGNoID0gZm91bmQubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBTQ1JBVENIX0tFWSkgfHwgbnVsbDsKICAgICAgICAgIGlmIChxdWVyeSAhPT0gTi5",
"xdWVyeSkgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBpZiAoc2NyYXRjaCB8fCAhcXVlcnkpIHsKICAgICAgICAgIE4uc2NyYXRjaE5vdGUgPSBzY3JhdGNoOwogICAgICAgICAgTi5zY3JhdGNoS25vd24gPSB0cnVlOwogICAgICAgIH0KICAgICAgICBOLm5vdGVzID0gci5ub3RlczsKICAgICAgICBOLnRydW5jYXRlZCA9IHIudHJ1bmNhdGVkOwogICAgICAgIE4uZm9sZGVycyA9IHIuZm9sZGVycyB8fCBbXTsKICAgICAgICBjb25zdCB0ZXJtcyA9IHNlYXJjaExvZ2ljLnF1ZXJ5VGVybXMocXVlcnkpOwogICAgICAgIGlmIChKU09OLnN0cmluZ2lmeSh0ZXJtcykgIT09IEpTT04uc3RyaW5naWZ5KE4udGVybXMpKSBOLmZpbmRJbmRleCA9IDA7CiAgICAgICAgTi50ZXJtcyA9IHRlcm1zOwogICAgICAgIC8vIFRoZSBmb2xkZXIgc2hvd24gd2FzIGRlbGV0ZWQgb3IgcmVuYW1lZCBhd2F5IGluIEdtYWlsLgogICAgICAgIGlmIChOLmZvbGRlciAmJiAhTi5mb2xkZXJzLnNvbWUoZiA9PiBmLmlkID09PSBOLmZvbGRlcikpIE4uZm9sZGVyID0gJyc7CiAgICAgICAgTi5zdGF0dXMgPSAncmVhZHknOwogICAgICAgIE4uZXJyb3IgPSAnJzsKICAgICAgICBOLmxvYWRlZEF0ID0gRGF0ZS5ub3coKTsKICAgICAgICBjYXRjaFVwQ3VycmVudCgpOwogICAgICAgIHJlYWR5U2NyYXRjaCgpOwogICAgICAgIE4uY3R4Lm9uTG9hZGVkKCk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGNvbnN0IHMgPSBOLnNjcmF0Y2g7CiA",
"gICAgICAgLy8gVGhlIHNjcmF0Y2hwYWQgd2FzIHdhaXRpbmcgZm9yIHRoaXMgbGlzdCB0byBzYXkgd2hldGhlciBpdCBleGlzdHMuCiAgICAgICAgaWYgKHMgJiYgcy5ib2R5U3RhdGUgPT09ICdsb2FkaW5nJyAmJiAhTi5zY3JhdGNoS25vd24pIHsKICAgICAgICAgIHMuYm9keVN0YXRlID0gJ2Vycm9yJzsKICAgICAgICAgIHMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgICAgIGlmIChzID09PSBOLmN1cnJlbnQpIGRyYXdFZGl0b3IoKTsKICAgICAgICAgIGRyYXdUaWxlKCk7CiAgICAgICAgfQogICAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgewogICAgICAgICAgTi5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgICBzdGF0ZUVycm9yKGVycik7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIE4uc3RhdHVzID0gTi5ub3Rlcy5sZW5ndGggPyAncmVhZHknIDogJ2Vycm9yJzsKICAgICAgICBOLmVycm9yID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgaWYgKE4ubm90ZXMubGVuZ3RoICYmIGVscy53cmFwICYmIGVscy53cmFwLmlzQ29ubmVjdGVkKSB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBsb2FkIG5vdGVzOiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBOLmxvYWRpbmcgPSBudWxsOwogICAgICAgIGRyYXdGb2xkZXJzKCk7CiAgICAgICAgZHJhd0xpc3QoKTsKICAgICAgICBkcmF3Rm9vdCgpOwo",
"gICAgICAgIGlmIChOLmN1cnJlbnQpIGRyYXdCYXIoKTsKICAgICAgICBhcHBseUhpZ2hsaWdodHMoKTsKICAgICAgICBmZXRjaEhpdHMoKTsKICAgICAgICBOLmN0eC5iYXJDaGFuZ2VkKCk7CiAgICAgIH0KICAgIH0pKCk7CiAgICAvLyBUaGUgc2VhcmNoIGJveCBjaGFuZ2VkIHdoaWxlIHRoaXMgd2FzIGluIGZsaWdodCwgYW5kIHRoZSBsb2FkIHRoYXQKICAgIC8vIGNoYW5nZSBhc2tlZCBmb3Igd2FzIHR1cm5lZCBhd2F5IGFib3ZlOiBydW4gaXQgbm93LgogICAgY29uc3QgcCA9IE4ubG9hZGluZzsKICAgIHJldHVybiBwLnRoZW4oKCkgPT4gKHF1ZXJ5ICE9PSBOLnF1ZXJ5ID8gbG9hZCh7IGZvcmNlOiB0cnVlIH0pIDogdW5kZWZpbmVkKSk7CiAgfQoKICAvLyBXaGV0aGVyIGBmcmVzaGAgaXMgYSBsYXRlciB2ZXJzaW9uIHRoYW4gdGhlIG9uZSBgbm90ZWAgaXMgKG9yIHRoYW4KICAvLyBub25lIGF0IGFsbCkuIEdtYWlsJ3Mgb3duIGRhdGUgZm9yIGVhY2ggbWVzc2FnZSBkZWNpZGVzLgogIGNvbnN0IGlzTmV3ZXIgPSAoZnJlc2gsIG5vdGUpID0-ICEhZnJlc2ggJiYgKCFub3RlIHx8IChmcmVzaC5tZXNzYWdlSWQgIT09IG5vdGUubWVzc2FnZUlkICYmIGZyZXNoLnVwZGF0ZWQgPiBub3RlLnVwZGF0ZWQpKTsKCiAgLy8gVGhlIG9wZW4gbm90ZSB3YXMgc2F2ZWQgb24gYW5vdGhlciBjb21wdXRlciBvciBwaG9uZSBzaW5jZSBpdCB3YXMKICAvLyBvcGVuZWQgaGVyZSAob3IsIGZvciB0aGUgc2NyYXRjaHBhZCwgc3R",
"hcnRlZCB0aGVyZSk6IHRoZSBuZXdlciB0ZXh0LAogIC8vIG1lcmdlZCB3aXRoIHdoYXRldmVyIHdhcyB0eXBlZCBoZXJlIG1lYW53aGlsZS4gVGhlIHNjcmF0Y2hwYWQgY2F0Y2hlcwogIC8vIHVwIGFzIHdlbGwgd2hlbiBhbm90aGVyIG5vdGUgaXMgb3BlbiwgZm9yIHRoZSBjYWxlbmRhcidzIHRpbGUuCiAgZnVuY3Rpb24gY2F0Y2hVcEN1cnJlbnQoKSB7CiAgICBmb3IgKGNvbnN0IGMgb2YgbmV3IFNldChbTi5jdXJyZW50LCBOLnNjcmF0Y2hdKSkgewogICAgICBpZiAoIWMpIGNvbnRpbnVlOwogICAgICBjb25zdCBmcmVzaCA9IGMuc2NyYXRjaCA_IE4uc2NyYXRjaE5vdGUgOiBjLm5vdGUgPyBOLm5vdGVzLmZpbmQobiA9PiBuLmtleSA9PT0gYy5rZXkpIDogbnVsbDsKICAgICAgaWYgKCFpc05ld2VyKGZyZXNoLCBjLm5vdGUpKSBjb250aW51ZTsKICAgICAgaWYgKGMuYm9keVN0YXRlID09PSAncmVhZHknKSBhZG9wdE5ld2VyKGMsIGZyZXNoKTsKICAgICAgZWxzZSBpZiAoIWMuZGlydHkgJiYgIWMuc2F2aW5nKSB7CiAgICAgICAgaWYgKGMgPT09IE4uY3VycmVudCkgb3Blbk5vdGUoZnJlc2gsIHsgZm9yY2U6IHRydWUgfSk7CiAgICAgICAgZWxzZSBsb2FkQm9keShzY3JhdGNoQ3VycmVudChmcmVzaCkpOwogICAgICB9CiAgICB9CiAgfQoKICAvLyBPbmNlIHRoZSBsaXN0IGhhcyBzYWlkIHdoZXRoZXIgdGhlcmUgaXMgYSBzY3JhdGNocGFkOiB0aGUgb25lIHdhaXRpbmcKICAvLyBmb3IgdGhhdCBpcyBzaG93biw",
"gaGVyZSBvciBpbiB0aGUgdGlsZSAtIGl0cyB0ZXh0IHJlYWQsIG9yIGVtcHR5IGlmCiAgLy8gdGhlcmUgaXMgbm9uZSB5ZXQuCiAgZnVuY3Rpb24gcmVhZHlTY3JhdGNoKCkgewogICAgY29uc3QgcyA9IE4uc2NyYXRjaDsKICAgIGlmICghcyB8fCAhTi5zY3JhdGNoS25vd24pIHJldHVybjsKICAgIGlmIChzID09PSBOLmN1cnJlbnQpIHsKICAgICAgaWYgKHMuYm9keVN0YXRlICE9PSAncmVhZHknKSBzaG93U2NyYXRjaCgpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAocy5ib2R5U3RhdGUgPT09ICdyZWFkeScgfHwgKHMuYm9keVN0YXRlID09PSAnbG9hZGluZycgJiYgcy5ub3RlKSkgcmV0dXJuOyAvLyByZWFkeSwgb3IgYmVpbmcgcmVhZAogICAgaWYgKE4uc2NyYXRjaE5vdGUpIGxvYWRCb2R5KHNjcmF0Y2hDdXJyZW50KE4uc2NyYXRjaE5vdGUpKTsKICAgIGVsc2UgewogICAgICBzY3JhdGNoQ3VycmVudChudWxsKTsKICAgICAgZHJhd1RpbGUoKTsKICAgIH0KICB9CgogIC8vIEEgbmV3ZXIgdmVyc2lvbiBvZiBhIG5vdGUgYmVpbmcgZWRpdGVkLCB0YWtlbiBpbiBwbGFjZTogdGhlIGVkaXRzCiAgLy8gbWFkZSBoZXJlIHNpbmNlIGBjLmJhc2VgIG1lcmdlZCBpbnRvIGl0IChub3RlRm9ybWF0Lm1lcmdlRG9jcyksIGluCiAgLy8gdGhlIHNhbWUgdGV4dCBib3gsIHNvIHRoZSBjdXJzb3IgYW5kIGEgcGhvbmUncyBrZXlib2FyZCBzdGF5IHB1dC4gSXQKICAvLyB3YWl0cyBmb3IgYSBzYXZlIGluIGZsaWdodCw",
"gYW5kIHRoZSBtZXJnZWQgdGV4dCBpcyBzYXZlZCBpbiB0dXJuLgogIGZ1bmN0aW9uIGFkb3B0TmV3ZXIoYywgZnJlc2gpIHsKICAgIE4uY2hhaW4gPSBOLmNoYWluLnRoZW4oYXN5bmMgKCkgPT4gewogICAgICBpZiAoIWlzTmV3ZXIoZnJlc2gsIGMubm90ZSkpIHJldHVybjsKICAgICAgbGV0IHRoZWlyczsKICAgICAgdHJ5IHsKICAgICAgICB0aGVpcnMgPSBhd2FpdCBub3Rlc1N0b3JlLmJvZHkoZnJlc2gpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICByZXR1cm47IC8vIHRoZSBuZXh0IGxpc3RpbmcgdHJpZXMgYWdhaW4KICAgICAgfQogICAgICBpZiAoIWlzTmV3ZXIoZnJlc2gsIGMubm90ZSkpIHJldHVybjsKICAgICAgY29uc3QgYmFzZSA9IGMuYmFzZSB8fCBmbXQuZW1wdHlEb2MoKTsKICAgICAgY29uc3QgbWluZSA9IGMuZG9jIHx8IGJhc2U7CiAgICAgIGNvbnN0IHR5cGVkID0gYy5kaXJ0eSAmJiAhZm10LnNhbWVEb2MobWluZSwgYmFzZSk7CiAgICAgIGNvbnN0IHRpdGxlZCA9ICFjLnNjcmF0Y2ggJiYgYy5kaXJ0eSAmJiBjLnRpdGxlICE9PSBjLmJhc2VUaXRsZTsKICAgICAgY29uc3QgbWVyZ2VkID0gdHlwZWQgPyBmbXQubWVyZ2VEb2NzKGJhc2UsIG1pbmUsIHRoZWlycykgOiB7IGRvYzogdGhlaXJzLCBtYXA6IG51bGwgfTsKICAgICAgYy5ub3RlID0gZnJlc2g7CiAgICAgIGMua2V5ID0gZnJlc2gua2V5OwogICAgICBjLmJhc2UgPSB0aGVpcnM7CiAgICAgIGMuYmFzZVRpdGxlID0gZnJlc2g",
"udGl0bGU7CiAgICAgIGMuZG9jID0gbWVyZ2VkLmRvYzsKICAgICAgYy5zYXZlZEF0ID0gMDsKICAgICAgYy5lcnJvciA9ICcnOwogICAgICBpZiAoIXRpdGxlZCAmJiAhYy5zY3JhdGNoKSBjLnRpdGxlID0gZnJlc2gudGl0bGUgIT09ICdVbnRpdGxlZCBub3RlJyA_IGZyZXNoLnRpdGxlIDogJyc7CiAgICAgIGlmICghYy5zY3JhdGNoKSBjLmZvbGRlcklkID0gZnJlc2guZm9sZGVySWQgfHwgJyc7CiAgICAgIGMuZGlydHkgPSAodHlwZWQgJiYgIWZtdC5zYW1lRG9jKG1lcmdlZC5kb2MsIHRoZWlycykpIHx8IHRpdGxlZDsKICAgICAgaWYgKGMuc2NyYXRjaCkgeyBOLnNjcmF0Y2hOb3RlID0gZnJlc2g7IE4uc2NyYXRjaEtub3duID0gdHJ1ZTsgfQogICAgICBpZiAoTi5jdXJyZW50ID09PSBjICYmIGVscy5lZCkgewogICAgICAgIGVscy5lZC5yZXBsYWNlRG9jKG1lcmdlZC5kb2MsIG1lcmdlZC5tYXApOwogICAgICAgIGNvbnN0IGlucHV0ID0gZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9Im5vdGUtdGl0bGUiXScpOwogICAgICAgIGlmIChpbnB1dCAmJiBpbnB1dC52YWx1ZSAhPT0gYy50aXRsZSAmJiBOLmN0eC5yb290LmFjdGl2ZUVsZW1lbnQgIT09IGlucHV0KSBpbnB1dC52YWx1ZSA9IGMudGl0bGU7CiAgICAgICAgYXBwbHlIaWdobGlnaHRzKCk7CiAgICAgIH0KICAgICAgaWYgKFQuZWQgJiYgVC5mb3IgPT09IGMpIFQuZWQucmVwbGFjZURvYyhtZXJnZWQuZG9jLCBtZXJnZWQubWFwKTsKICA",
"gICAgaWYgKHR5cGVkKSB0b2FzdChOLmN0eC5yb290LCAnQWxzbyBjaGFuZ2VkIG9uIGFub3RoZXIgZGV2aWNlIGluIHRoZSBtZWFudGltZTogYm90aCBjaGFuZ2VzIGFyZSBrZXB0LicpOwogICAgICBrZWVwRHJhZnQoYyk7CiAgICAgIGlmIChjLmRpcnR5KSBsYXRlclNhdmUoYyk7CiAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMpIGRyYXdCYXIoKTsKICAgICAgZHJhd1N0YXR1cygpOwogICAgICBkcmF3TGlzdCgpOwogICAgfSk7CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIEEgcGhvbmUgYXBwIGtlZXBzIHRoZSBzY3JhdGNocGFkJ3MgdW5zYXZlZCB0ZXh0IG9uIHRoZSBwaG9uZSwgc28gdGhhdAogIC8vIGEgcGFnZSB0aGUgcGhvbmUgY2xvc2VzIG1pZC1zZW50ZW5jZSBsb3NlcyBub3RoaW5nIChub3Rlc1N0b3JlLmtlZXBEcmFmdCkuCiAgbGV0IGRyYWZ0VGltZXIgPSAwOwogIGZ1bmN0aW9uIGtlZXBEcmFmdChjKSB7CiAgICBpZiAoIWMuc2NyYXRjaCB8fCAhbm90ZXNTdG9yZS5rZWVwRHJhZnQpIHJldHVybjsKICAgIGNsZWFyVGltZW91dChkcmFmdFRpbWVyKTsKICAgIG5vdGVzU3RvcmUua2VlcERyYWZ0KGMuZGlydHkgPyB7IG5vdGU6IGMubm90ZSwgYmFzZTogYy5iYXNlLCBkb2M6IGMuZG9jIH0gOiBudWxsKTsKICB9CgogIC8vIOKUgOKUgCBUaGUgbGlzdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilID",
"ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gZm9sZGVyQnlJZChpZCkgewogICAgcmV0dXJuIE4uZm9sZGVycy5maW5kKGYgPT4gZi5pZCA9PT0gaWQpIHx8IG51bGw7CiAgfQoKICAvLyAiV29yayDigLogQ2xpZW50cyIKICBmdW5jdGlvbiBmb2xkZXJMYWJlbChpZCkgewogICAgY29uc3QgZiA9IGZvbGRlckJ5SWQoaWQpOwogICAgcmV0dXJuIGYgPyBmLnBhdGguc3BsaXQoJy8nKS5qb2luKCcgXHUyMDNhICcpIDogJyc7CiAgfQoKICBmdW5jdGlvbiB2aXNpYmxlTm90ZXMoKSB7CiAgICByZXR1cm4gTi5mb2xkZXIgPyBOLm5vdGVzLmZpbHRlcihuID0-IG4uZm9sZGVySWQgPT09IE4uZm9sZGVyKSA6IE4ubm90ZXM7CiAgfQoKICBmdW5jdGlvbiBkcmF3TGlzdCgpIHsKICAgIGlmICghZWxzLml0ZW1zKSByZXR1cm47CiAgICBjb25zdCBjdXJLZXkgPSBOLmN1cnJlbnQgJiYgTi5jdXJyZW50LmtleTsKICAgIGNvbnN0IHNob3duID0gdmlzaWJsZU5vdGVzKCk7CiAgICBjb25zdCBzZWFyY2hpbmcgPSAhIU4ucXVlcnkudHJpbSgpOwogICAgaWYgKGVscy5zY29wZSkgewogICAgICBjb25zdCB3aGVyZSA9IE4uZm9sZGVyID8gZm9sZGVyTGFiZWwoTi5mb2xkZXIpIDogJ0FsbCBub3Rlcyc7CiAgICAgIGVscy5zY29wZS50ZXh0Q29udGVudCA9IE4uc3RhdHVzID09PSAncmVhZHknCiAgICA",
"gICAgPyBgJHt3aGVyZX0gXHUwMGI3ICR7c2hvd24ubGVuZ3RofSAke3NlYXJjaGluZyA_IChzaG93bi5sZW5ndGggPT09IDEgPyAnbWF0Y2gnIDogJ21hdGNoZXMnKSA6IChzaG93bi5sZW5ndGggPT09IDEgPyAnbm90ZScgOiAnbm90ZXMnKX1gCiAgICAgICAgOiB3aGVyZTsKICAgIH0KICAgIGlmIChlbHMuc2VhcmNoKSBlbHMuc2VhcmNoLnBsYWNlaG9sZGVyID0gTi5mb2xkZXIgPyBgU2VhcmNoIGluICR7Zm9sZGVyQnlJZChOLmZvbGRlcikgPyBmb2xkZXJCeUlkKE4uZm9sZGVyKS50aXRsZSA6ICd0aGlzIGZvbGRlcid9YCA6ICdTZWFyY2ggbm90ZXMnOwoKICAgIGlmIChOLnN0YXR1cyA9PT0gJ2xvYWRpbmcnICYmICFOLm5vdGVzLmxlbmd0aCkgewogICAgICBlbHMuaXRlbXMucmVwbGFjZUNoaWxkcmVuKGgoJ2RpdicsIHsgY2xhc3M6ICdub3Rlcy1lbXB0eScsIHRleHQ6ICdMb2FkaW5n4oCmJyB9KSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChOLnN0YXR1cyA9PT0gJ2Vycm9yJyAmJiAhTi5ub3Rlcy5sZW5ndGgpIHsKICAgICAgZWxzLml0ZW1zLnJlcGxhY2VDaGlsZHJlbigKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbm90ZXMtZW1wdHknIH0sCiAgICAgICAgICBoKCdwJywgeyB0ZXh0OiBgQ291bGRu4oCZdCBsb2FkIG5vdGVzOiAke04uZXJyb3J9YCB9KSwKICAgICAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdidG4gYnRuLXRleHQnLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1RyeSBhZ2F",
"pbicsIG9uY2xpY2s6ICgpID0-IGxvYWQoeyBmb3JjZTogdHJ1ZSB9KSB9KSkpOwogICAgICByZXR1cm47CiAgICB9CiAgICAvLyBUaGUgc2NyYXRjaHBhZCBmaXJzdDogaW4gIkFsbCBub3RlcyIsIGFsd2F5cywgc2F2ZWQgeWV0IG9yIG5vdDsKICAgIC8vIGVsc2V3aGVyZSwgd2hlcmUgaXQgaXMgbGlzdGVkIChhIHNlYXJjaCB0aGF0IGZpbmRzIGl0KS4KICAgIGNvbnN0IHNjcmF0Y2ggPSBzaG93bi5maW5kKG4gPT4gbi5rZXkgPT09IFNDUkFUQ0hfS0VZKSB8fCAoIU4uZm9sZGVyICYmICFzZWFyY2hpbmcgJiYgTi5zY3JhdGNoS25vd24gJiYgIU4uc2NyYXRjaE5vdGUgPyAnbmV3JyA6IG51bGwpOwogICAgY29uc3QgcmVzdCA9IHNob3duLmZpbHRlcihuID0-IG4ua2V5ICE9PSBTQ1JBVENIX0tFWSk7CiAgICBjb25zdCBwaW5uZWQgPSBzY3JhdGNoID8gW3NjcmF0Y2hJdGVtKHNjcmF0Y2ggPT09ICduZXcnID8gbnVsbCA6IHNjcmF0Y2gsIGN1cktleSldIDogW107CiAgICBpZiAoIXJlc3QubGVuZ3RoKSB7CiAgICAgIGxldCB0ZXh0ID0gc2VhcmNoaW5nID8gJ05vIG5vdGVzIG1hdGNoLicgOiAnTm8gbm90ZXMgeWV0Lic7CiAgICAgIGlmIChOLmZvbGRlcikgdGV4dCA9IHNlYXJjaGluZyA_ICdObyBub3RlcyBpbiB0aGlzIGZvbGRlciBtYXRjaC4nIDogJ05vIG5vdGVzIGluIHRoaXMgZm9sZGVyIHlldC4nOwogICAgICBlbHMuaXRlbXMucmVwbGFjZUNoaWxkcmVuKC4uLnBpbm5lZCwgaCgnZGl2JywgeyBjbGFzczo",
"gJ25vdGVzLWVtcHR5JywgdGV4dCB9KSk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBlbHMuaXRlbXMucmVwbGFjZUNoaWxkcmVuKC4uLnBpbm5lZCwgLi4ucmVzdC5tYXAobiA9PiB7CiAgICAgIGNvbnN0IGl0ZW0gPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdub3RlLWl0ZW0nLCB0eXBlOiAnYnV0dG9uJywgcm9sZTogJ2xpc3RpdGVtJywgZHJhZ2dhYmxlOiAndHJ1ZScsCiAgICAgICAgJ2FyaWEtY3VycmVudCc6IG4ua2V5ID09PSBjdXJLZXkgPyAndHJ1ZScgOiBudWxsLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgbm90ZToke24ua2V5fWAsIG5vdGU6IG4ua2V5IH0sCiAgICAgICAgb25jbGljazogKCkgPT4gb3Blbk5vdGUobiksCiAgICAgIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICduaS10b3AnIH0sCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ25pLXRpdGxlJyB9LCBtYXJrZWQobi50aXRsZSkpLAogICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkYXRlJywgdGV4dDogdXRpbC5yZWxhdGl2ZURhdGUobi51cGRhdGVkKSwgdGl0bGU6IHV0aWwuZnVsbERhdGUobi51cGRhdGVkKSB9KSksCiAgICAgICAgaXRlbVByZXZpZXcobiksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICduaS1tZXRhJyB9LAogICAgICAgICAgaGl0Q291bnQobiksCiAgICAgICAgICAhTi5mb2xkZXIgJiYgbi5mb2xkZXJJZCA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktZm9sZGVyJyB9LCBpY29",
"uKCdmb2xkZXInLCAxNCksIGZvbGRlckxhYmVsKG4uZm9sZGVySWQpKSA6IG51bGwsCiAgICAgICAgICBuLm93biA_IG51bGwgOiBoKCdzcGFuJywgeyBjbGFzczogJ25pLW1haWwnLCB0ZXh0OiAnRnJvbSBhbiBlbWFpbCcgfSkpKTsKICAgICAgaXRlbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCBlID0-IHsKICAgICAgICBOLmRyYWdLZXkgPSBuLmtleTsKICAgICAgICBlLmRhdGFUcmFuc2Zlci5lZmZlY3RBbGxvd2VkID0gJ21vdmUnOwogICAgICAgIGUuZGF0YVRyYW5zZmVyLnNldERhdGEoJ2FwcGxpY2F0aW9uL3gtZ2tiLW5vdGUnLCBuLmtleSk7CiAgICAgICAgZWxzLndyYXAuY2xhc3NMaXN0LmFkZCgnZHJhZ2dpbmctbm90ZScpOwogICAgICB9KTsKICAgICAgaXRlbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgKCkgPT4gewogICAgICAgIE4uZHJhZ0tleSA9ICcnOwogICAgICAgIGVscy53cmFwLmNsYXNzTGlzdC5yZW1vdmUoJ2RyYWdnaW5nLW5vdGUnKTsKICAgICAgICBmb3IgKGNvbnN0IHIgb2YgZWxzLmZvbGRlckl0ZW1zLnF1ZXJ5U2VsZWN0b3JBbGwoJy5kcm9wJykpIHIuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcCcpOwogICAgICB9KTsKICAgICAgcmV0dXJuIGl0ZW07CiAgICB9KSk7CiAgfQoKICAvLyBUaGUgc2NyYXRjaHBhZCdzIGVudHJ5OiBwaW5uZWQsIG5vdCBkcmFnZ2FibGUsIGFuZCBvbiBhIHBob25lIGl0IGdvZXMKICAvLyBiYWNrIHRvIHRoZSBzY3JhdGNocGFkIHJhdGhlciB",
"0aGFuIG9wZW5pbmcgaXQgZnVsbC1zY3JlZW4uCiAgZnVuY3Rpb24gc2NyYXRjaEl0ZW0obiwgY3VyS2V5KSB7CiAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ25vdGUtaXRlbSBzY3JhdGNoLWl0ZW0nLCB0eXBlOiAnYnV0dG9uJywgcm9sZTogJ2xpc3RpdGVtJywKICAgICAgJ2FyaWEtY3VycmVudCc6IGN1cktleSA9PT0gU0NSQVRDSF9LRVkgPyAndHJ1ZScgOiBudWxsLAogICAgICBkYXRhc2V0OiB7IGtleTogJ25vdGU6c2NyYXRjaHBhZCcsIG5vdGU6IFNDUkFUQ0hfS0VZIH0sCiAgICAgIG9uY2xpY2s6ICgpID0-IHsKICAgICAgICBOLmJyb3dzaW5nID0gZmFsc2U7CiAgICAgICAgaWYgKG4pIG9wZW5Ob3RlKG4pOwogICAgICAgIGVsc2Ugc2hvd1NjcmF0Y2goKTsKICAgICAgICBzZXRWaWV3KCk7CiAgICAgIH0sCiAgICB9LAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ25pLXRvcCcgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ25pLXRpdGxlJyB9LCBpY29uKCdlZGl0JywgMTYpLCBoKCdzcGFuJywge30sIG1hcmtlZChub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUpKSksCiAgICAgICAgbiA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZGF0ZScsIHRleHQ6IHV0aWwucmVsYXRpdmVEYXRlKG4udXBkYXRlZCksIHRpdGxlOiB1dGlsLmZ1bGxEYXRlKG4udXBkYXRlZCkgfSkgOiBudWxsKSwKICAgICAgbiA_IGl0ZW1QcmV2aWV3KG4pIDogaCgnc3BhbicsIHsgY2xhc3M6ICduaS1zbml",
"wcGV0JywgdGV4dDogJ0VtcHR5IOKAkyB3cml0ZSBzb21ldGhpbmcgZG93bicgfSksCiAgICAgIG4gPyBoKCdzcGFuJywgeyBjbGFzczogJ25pLW1ldGEnIH0sIGhpdENvdW50KG4pKSA6IG51bGwpOwogIH0KCiAgLy8g4pSA4pSAIFNlYXJjaCByZXN1bHRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIC8vCiAgLy8gR21haWwgZmluZHMgdGhlIG5vdGVzOyB0aGVzZSBzaG93IHdoZXJlIHRoZSB3b3JkcyBhcmUuIEVhY2ggcmVzdWx0CiAgLy8gZ2V0cyBleGNlcnB0cyBhcm91bmQgaXRzIG1hdGNoZXMgb25jZSBpdHMgdGV4dCBpcyBpbiwgd2l0aCB0aGUgd29yZHMKICAvLyBtYXJrZWQuIFVudGlsIHRoZW4gLSBvciBpZiBHbWFpbCBtYXRjaGVkIHNvbWV0aGluZyB0aGUgd29yZHMgZG8gbm90CiAgLy8gc2hvdywgc3VjaCBhcyBhIHN0ZW1tZWQgZm9ybSAtIGl0IHNob3dzIEdtYWlsJ3Mgb3duIHNuaXBwZXQuCgogIGNvbnN0IHRlcm1zS2V5ID0gKCkgPT4gSlNPTi5zdHJpbmdpZnkoTi50ZXJtcyk7CgogIC8vIFRleHQgd2l0aCB0aGUgc2VhcmNoIHdvcmRzIHdyYXBwZWQgaW4gPG1hcms-LCBidWlsdCBmcm9tIHRleHQgbm9kZXMuCiAgZnVuY3Rpb24gbWFya2VkKHRleHQsIG1hcmtzKSB7CiA",
"gICBjb25zdCBzID0gU3RyaW5nKHRleHQgfHwgJycpOwogICAgY29uc3QgbSA9IG1hcmtzIHx8IChOLnRlcm1zLmxlbmd0aCA_IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKHMsIE4udGVybXMpIDogW10pOwogICAgaWYgKCFtLmxlbmd0aCkgcmV0dXJuIHM7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBhdCA9IDA7CiAgICBmb3IgKGNvbnN0IHsgc3RhcnQsIGVuZCB9IG9mIG0pIHsKICAgICAgaWYgKHN0YXJ0ID4gYXQpIG91dC5wdXNoKHMuc2xpY2UoYXQsIHN0YXJ0KSk7CiAgICAgIG91dC5wdXNoKGgoJ21hcmsnLCB7IHRleHQ6IHMuc2xpY2Uoc3RhcnQsIGVuZCkgfSkpOwogICAgICBhdCA9IGVuZDsKICAgIH0KICAgIGlmIChhdCA8IHMubGVuZ3RoKSBvdXQucHVzaChzLnNsaWNlKGF0KSk7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gaXRlbVByZXZpZXcobikgewogICAgY29uc3QgaGl0ID0gTi50ZXJtcy5sZW5ndGggPyBOLmhpdHMuZ2V0KGAke24ubWVzc2FnZUlkfXwke3Rlcm1zS2V5KCl9YCkgOiBudWxsOwogICAgaWYgKGhpdCAmJiBoaXQuZXhjZXJwdHMubGVuZ3RoKSB7CiAgICAgIHJldHVybiBoKCdzcGFuJywgeyBjbGFzczogJ25pLWV4Y2VycHRzJyB9LCBoaXQuZXhjZXJwdHMubWFwKGV4ID0-IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmktZXhjZXJwdCcgfSwKICAgICAgICBleC5jdXRCZWZvcmUgPyAnXHUyMDI2JyA6ICcnLCBtYXJrZWQoZXgudGV4dCwgZXgubWFya3MpLCBleC5jdXRBZnR",
"lciA_ICdcdTIwMjYnIDogJycpKSk7CiAgICB9CiAgICByZXR1cm4gbi5zbmlwcGV0ID8gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1zbmlwcGV0JyB9LCBtYXJrZWQobi5zbmlwcGV0KSkgOiBudWxsOwogIH0KCiAgZnVuY3Rpb24gaGl0Q291bnQobikgewogICAgaWYgKCFOLnRlcm1zLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBoaXQgPSBOLmhpdHMuZ2V0KGAke24ubWVzc2FnZUlkfXwke3Rlcm1zS2V5KCl9YCk7CiAgICBpZiAoIWhpdCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gaCgnc3BhbicsIHsgY2xhc3M6ICduaS1oaXRzJywgdGV4dDogYCR7aGl0LmNvdW50fSAke2hpdC5jb3VudCA9PT0gMSA_ICdtYXRjaCcgOiAnbWF0Y2hlcyd9YCB9KTsKICB9CgogIC8vIEZldGNoZXMgdGhlIHRleHQgb2YgdGhlIHJlc3VsdHMgb24gc2hvdyB0aGF0IGhhdmUgbm8gZXhjZXJwdHMgeWV0LAogIC8vIGEgZmV3IGF0IGEgdGltZSwgcmVkcmF3aW5nIHRoZSBsaXN0IGFzIHRoZXkgY29tZSBpbi4KICBsZXQgaGl0c1J1biA9IDA7CiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hIaXRzKCkgewogICAgaWYgKCFOLnRlcm1zLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgcnVuID0gKytoaXRzUnVuOwogICAgY29uc3Qga2V5ID0gdGVybXNLZXkoKTsKICAgIGNvbnN0IHRlcm1zID0gTi50ZXJtczsKICAgIGNvbnN0IHRvZG8gPSB2aXNpYmxlTm90ZXMoKS5zbGljZSgwLCBFWENFUlBUX0xJTUlUKS5maWx0ZXIobiA9PiAhTi5oaXR",
"zLmhhcyhgJHtuLm1lc3NhZ2VJZH18JHtrZXl9YCkpOwogICAgbGV0IHJlZHJhdyA9IDA7CiAgICBhd2FpdCB1dGlsLm1hcFBvb2wodG9kbywgNCwgYXN5bmMgbiA9PiB7CiAgICAgIGlmIChydW4gIT09IGhpdHNSdW4pIHJldHVybjsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBkb2MgPSBhd2FpdCBub3Rlc1N0b3JlLmJvZHkobik7CiAgICAgICAgY29uc3QgdGV4dCA9IGZtdC5kb2NUZXh0KGRvYyk7CiAgICAgICAgY29uc3QgYm9keSA9IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKHRleHQsIHRlcm1zKTsKICAgICAgICBjb25zdCB0aXRsZSA9IHNlYXJjaExvZ2ljLmZpbmRNYXRjaGVzKG4udGl0bGUsIHRlcm1zKTsKICAgICAgICBOLmhpdHMuc2V0KGAke24ubWVzc2FnZUlkfXwke2tleX1gLCB7CiAgICAgICAgICBjb3VudDogYm9keS5sZW5ndGggKyB0aXRsZS5sZW5ndGgsCiAgICAgICAgICBleGNlcnB0czogc2VhcmNoTG9naWMuZXhjZXJwdHModGV4dCwgYm9keSwgeyBjb250ZXh0OiA0NSwgbWF4OiAzIH0pLAogICAgICAgIH0pOwogICAgICB9IGNhdGNoIHsgLyogdGhlIHNuaXBwZXQgc3RhbmRzIGluICovIH0KICAgICAgaWYgKHJ1biA9PT0gaGl0c1J1biAmJiAhcmVkcmF3KSByZWRyYXcgPSBzZXRUaW1lb3V0KCgpID0-IHsgcmVkcmF3ID0gMDsgZHJhd0xpc3QoKTsgfSwgNjApOwogICAgfSk7CiAgICBpZiAocnVuID09PSBoaXRzUnVuKSBkcmF3TGlzdCgpOwogIH0KCiAgLy8g4pSA4pSAIEZpbmQgaW4gdGh",
"lIG9wZW4gbm90ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gYXBwbHlIaWdobGlnaHRzKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghZWxzLmVkIHx8ICFjIHx8IGMuYm9keVN0YXRlICE9PSAncmVhZHknKSB7IGRyYXdGaW5kKCk7IHJldHVybjsgfQogICAgY29uc3QgY291bnQgPSBlbHMuZWQuaGlnaGxpZ2h0KE4udGVybXMpOwogICAgaWYgKE4uZmluZEluZGV4ID49IGNvdW50KSBOLmZpbmRJbmRleCA9IDA7CiAgICBpZiAoY291bnQpIGVscy5lZC5zaG93TWF0Y2goTi5maW5kSW5kZXgpOwogICAgZHJhd0ZpbmQoKTsKICB9CgogIGZ1bmN0aW9uIHN0ZXBNYXRjaChkZWx0YSkgewogICAgY29uc3QgY291bnQgPSBlbHMuZWQgPyBlbHMuZWQubWF0Y2hDb3VudCgpIDogMDsKICAgIGlmICghY291bnQpIHJldHVybjsKICAgIE4uZmluZEluZGV4ID0gKE4uZmluZEluZGV4ICsgZGVsdGEgKyBjb3VudCkgJSBjb3VudDsKICAgIGVscy5lZC5zaG93TWF0Y2goTi5maW5kSW5kZXgpOwogICAgZHJhd0ZpbmQoKTsKICB9CgogIGZ1bmN0aW9uIGNsZWFyU2VhcmNoKCkgewogICAgaWYgKCFlbHMuc2VhcmNoKSByZXR1cm47CiAgICBlbHMuc2VhcmNoLnZhbHVlID0gJyc7CiAgICBOLnF1ZXJ5ID0",
"gJyc7CiAgICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgbG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogIH0KCiAgZnVuY3Rpb24gZHJhd0ZpbmQoKSB7CiAgICBpZiAoIWVscy5maW5kU2xvdCkgcmV0dXJuOwogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghTi50ZXJtcy5sZW5ndGggfHwgIWMgfHwgIWVscy5lZCB8fCBjLmJvZHlTdGF0ZSAhPT0gJ3JlYWR5JykgewogICAgICBlbHMuZmluZFNsb3QucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGNvdW50ID0gZWxzLmVkLm1hdGNoQ291bnQoKTsKICAgIGNvbnN0IHdvcmRzID0gTi50ZXJtcy5tYXAodCA9PiB0LndvcmRzLmpvaW4oJyAnKSkuam9pbignLCAnKTsKICAgIC8vIEEgcmVkcmF3IHJlcGxhY2VzIHRoZSBhcnJvdyBqdXN0IHByZXNzZWQ7IGZvY3VzIGdvZXMgdG8gaXRzIHN1Y2Nlc3NvcgogICAgLy8gcmF0aGVyIHRoYW4gZmFsbGluZyBvdXQgb2YgdGhlIGJvYXJkLCB3aGVyZSBGMyB3b3VsZCBub3QgcmVhY2ggaXQuCiAgICBjb25zdCBhY3RpdmUgPSBOLmN0eC5yb290LmFjdGl2ZUVsZW1lbnQ7CiAgICBjb25zdCByZWZvY3VzID0gYWN0aXZlICYmIGVscy5maW5kU2xvdC5jb250YWlucyhhY3RpdmUpID8gYWN0aXZlLmRhdGFzZXQua2V5IDogJyc7CiAgICBlbHMuZmluZFNsb3QucmVwbGFjZUNoaWxkcmVuKGgoJ2RpdicsIHsgY2xhc3M6ICduZS1maW5kJywgcm9sZTogJ3NlYXJjaCcsICdhcmlhLWx",
"hYmVsJzogJ01hdGNoZXMgaW4gdGhpcyBub3RlJyB9LAogICAgICBpY29uKCdzZWFyY2gnLCAxOCksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmluZC13b3JkcycsIHRleHQ6IHdvcmRzLCB0aXRsZTogd29yZHMgfSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmluZC1wb3MnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScsIHRleHQ6IGNvdW50ID8gYCR7Ti5maW5kSW5kZXggKyAxfSBvZiAke2NvdW50fWAgOiAnTm90IGluIHRoZSB0ZXh0JyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnUHJldmlvdXMgbWF0Y2ggKFNoaWZ0K0YzKScsIHRpdGxlOiAnUHJldmlvdXMgbWF0Y2ggKFNoaWZ0K0YzKScsCiAgICAgICAgZGlzYWJsZWQ6IGNvdW50IDwgMiwgZGF0YXNldDogeyBrZXk6ICdmaW5kLXByZXYnIH0sIG9uY2xpY2s6ICgpID0-IHN0ZXBNYXRjaCgtMSksCiAgICAgIH0sIGljb24oJ3VwJywgMTgpKSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnTmV4dCBtYXRjaCAoRjMpJywgdGl0bGU6ICdOZXh0IG1hdGNoIChGMyknLAogICAgICAgIGRpc2FibGVkOiBjb3VudCA8IDIsIGRhdGFzZXQ6IHsga2V5OiAnZmluZC1uZXh0JyB9LCBvbmNsaWNrOiAoKSA9PiBzdGVwTWF0Y2goMSksCiAgICAgIH0sIGljb24oJ2Rvd24nLCA",
"xOCkpLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDbGVhciB0aGUgc2VhcmNoJywgdGl0bGU6ICdDbGVhciB0aGUgc2VhcmNoJywKICAgICAgICBkYXRhc2V0OiB7IGtleTogJ2ZpbmQtY2xlYXInIH0sIG9uY2xpY2s6IGNsZWFyU2VhcmNoLAogICAgICB9LCBpY29uKCdjbG9zZScsIDE4KSkpKTsKICAgIGlmIChyZWZvY3VzKSB7CiAgICAgIGNvbnN0IGFnYWluID0gZWxzLmZpbmRTbG90LnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLWtleT0iJHtyZWZvY3VzfSJdYCk7CiAgICAgIGlmIChhZ2FpbiAmJiAhYWdhaW4uZGlzYWJsZWQpIGFnYWluLmZvY3VzKCk7CiAgICB9CiAgfQoKICAvLyDilIDilIAgRm9sZGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gY291bnRzKCkgewogICAgY29uc3Qgb3V0ID0gbmV3IE1hcCgpOwogICAgZm9yIChjb25zdCBuIG9mIE4ubm90ZXMpIG91dC5zZXQobi5mb2xkZXJJZCB8fCAnJywgKG91dC5nZXQobi5mb2xkZXJJZCB8fCAnJykgfHwgMCkgKyAxKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiB",
"zZXRGb2xkZXJzT3BlbihvcGVuKSB7CiAgICBpZiAoIWVscy53cmFwKSByZXR1cm47CiAgICBlbHMud3JhcC5kYXRhc2V0LmZvbGRlcnMgPSBvcGVuID8gJ29wZW4nIDogJ2Nsb3NlZCc7CiAgICBlbHMuZm9sZGVyc1RvZ2dsZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnLCBTdHJpbmcob3BlbikpOwogIH0KCiAgLy8g4pSA4pSAIEZvbGRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBBIGZvbGRlciB3aXRoIHN1YmZvbGRlcnMgaGFzIGFuIGFycm93IHRoYXQgZm9sZHMgdGhlbSBhd2F5LCBmb3IgYSB0cmVlCiAgLy8gdGhhdCBoYXMgZ3Jvd24gbG9uZy4gV2hpY2ggb25lcyBhcmUgZm9sZGVkIGlzIHJlbWVtYmVyZWQgd2hlcmUgdGhlCiAgLy8gaG9zdCBrZWVwcyBzdWNoIHRoaW5ncyAoY3R4LnByZWZzKSwgaWYgaXQgZG9lczogYSBuaWNldHksIHNvIGFueQogIC8vIHRyb3VibGUgd2l0aCBpdCBqdXN0IGxlYXZlcyBldmVyeSBmb2xkZXIgb3Blbi4KCiAgZnVuY3Rpb24gaGFzU3ViZm9sZGVycyhmKSB7CiAgICByZXR1cm4gTi5mb2xkZXJzLnNvbWUoeCA9PiB4Lm5hbWUuc3RhcnRzV2l0aChgJHtmLm5hbWV9L2ApKTsKICB9Cgo",
"gIC8vIEluc2lkZSBhIGZvbGRlZCBmb2xkZXIsIGF0IGFueSBkZXB0aC4KICBmdW5jdGlvbiBpc1R1Y2tlZChmKSB7CiAgICByZXR1cm4gTi5mb2xkZXJzLnNvbWUoeCA9PiBOLmZvbGRlZC5oYXMoeC5pZCkgJiYgZi5uYW1lLnN0YXJ0c1dpdGgoYCR7eC5uYW1lfS9gKSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiByZWFkRm9sZGVkKCkgewogICAgTi5mb2xkZWRSZWFkID0gdHJ1ZTsKICAgIGNvbnN0IHByZWZzID0gTi5jdHggJiYgTi5jdHgucHJlZnM7CiAgICBpZiAoIXByZWZzKSByZXR1cm47CiAgICB0cnkgewogICAgICBjb25zdCBpZHMgPSBhd2FpdCBwcmVmcy5nZXQoJ2ZvbGRlZEZvbGRlcnMnKTsKICAgICAgaWYgKEFycmF5LmlzQXJyYXkoaWRzKSkgTi5mb2xkZWQgPSBuZXcgU2V0KGlkcy5maWx0ZXIoaWQgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJykpOwogICAgfSBjYXRjaCAoZXJyKSB7IC8qIGV2ZXJ5IGZvbGRlciBvcGVuICovIH0KICB9CgogIGZ1bmN0aW9uIHNhdmVGb2xkZWQoKSB7CiAgICBjb25zdCBwcmVmcyA9IE4uY3R4ICYmIE4uY3R4LnByZWZzOwogICAgaWYgKCFwcmVmcykgcmV0dXJuOwogICAgLy8gT25seSBmb2xkZXJzIHRoYXQgYXJlIHN0aWxsIHRoZXJlLCBzbyBkZWxldGVkIG9uZXMgZG8gbm90IHBpbGUgdXAuCiAgICBjb25zdCBpZHMgPSBbLi4uTi5mb2xkZWRdLmZpbHRlcihpZCA9PiBmb2xkZXJCeUlkKGlkKSk7CiAgICB0cnkgewogICAgICBQcm9taXNlLnJlc29sdmUocHJlZnMuc2V",
"0KCdmb2xkZWRGb2xkZXJzJywgaWRzKSkuY2F0Y2goKCkgPT4ge30pOwogICAgfSBjYXRjaCAoZXJyKSB7IC8qIG5vdCByZW1lbWJlcmVkLCB0aGF0IGlzIGFsbCAqLyB9CiAgfQoKICBmdW5jdGlvbiBzZXRGb2xkZWQoZiwgZm9sZGVkKSB7CiAgICBpZiAoZm9sZGVkID09PSBOLmZvbGRlZC5oYXMoZi5pZCkpIHJldHVybjsKICAgIGlmIChmb2xkZWQpIE4uZm9sZGVkLmFkZChmLmlkKTsKICAgIGVsc2UgTi5mb2xkZWQuZGVsZXRlKGYuaWQpOwogICAgc2F2ZUZvbGRlZCgpOwogICAgLy8gVGhlIHJvd3MgYXJlIGRyYXduIGFmcmVzaDoga2VlcCB0aGUga2V5Ym9hcmQgd2hlcmUgaXQgd2FzLgogICAgY29uc3QgYWN0aXZlID0gTi5jdHgucm9vdC5hY3RpdmVFbGVtZW50OwogICAgY29uc3Qga2V5ID0gYWN0aXZlICYmIGVscy5mb2xkZXJJdGVtcy5jb250YWlucyhhY3RpdmUpID8gYWN0aXZlLmRhdGFzZXQua2V5IDogJyc7CiAgICBkcmF3Rm9sZGVycygpOwogICAgaWYgKGtleSkgewogICAgICBjb25zdCBhZ2FpbiA9IGVscy5mb2xkZXJJdGVtcy5xdWVyeVNlbGVjdG9yKGBbZGF0YS1rZXk9IiR7a2V5fSJdYCk7CiAgICAgIGlmIChhZ2FpbikgYWdhaW4uZm9jdXMoKTsKICAgIH0KICB9CgogIC8vIE9wZW5zIGV2ZXJ5IGZvbGRlciBhYm92ZSB0aGlzIG9uZSwgYW5kIHdpdGggc2VsZiwgdGhpcyBvbmUgdG9vLgogIGZ1bmN0aW9uIHVuZm9sZChmLCBzZWxmKSB7CiAgICBsZXQgY2hhbmdlZCA9IGZhbHNlOwogICAgZm9yICh",
"jb25zdCB4IG9mIE4uZm9sZGVycykgewogICAgICBpZiAoTi5mb2xkZWQuaGFzKHguaWQpICYmICgoc2VsZiAmJiB4LmlkID09PSBmLmlkKSB8fCBmLm5hbWUuc3RhcnRzV2l0aChgJHt4Lm5hbWV9L2ApKSkgewogICAgICAgIE4uZm9sZGVkLmRlbGV0ZSh4LmlkKTsKICAgICAgICBjaGFuZ2VkID0gdHJ1ZTsKICAgICAgfQogICAgfQogICAgaWYgKGNoYW5nZWQpIHNhdmVGb2xkZWQoKTsKICB9CgogIGZ1bmN0aW9uIHNlbGVjdEZvbGRlcihpZCkgewogICAgc2V0Rm9sZGVyc09wZW4oZmFsc2UpOwogICAgLy8gT24gYSBwaG9uZSwgY2hvb3NpbmcgYSBmb2xkZXIgLSAiQWxsIG5vdGVzIiB0b28gLSBzaG93cyBpdHMgbGlzdC4KICAgIGlmICghTi5icm93c2luZykgeyBOLmJyb3dzaW5nID0gdHJ1ZTsgc2V0VmlldygpOyB9CiAgICBpZiAoTi5mb2xkZXIgPT09IGlkKSByZXR1cm47CiAgICBOLmZvbGRlciA9IGlkOwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgICBmZXRjaEhpdHMoKTsKICB9CgogIGZ1bmN0aW9uIGRyYXdGb2xkZXJzKCkgewogICAgaWYgKCFlbHMuZm9sZGVySXRlbXMpIHJldHVybjsKICAgIGNvbnN0IHRhbGx5ID0gY291bnRzKCk7CiAgICBjb25zdCByb3dzID0gW2ZvbGRlclJvdyhudWxsLCBOLm5vdGVzLmxlbmd0aCldOwogICAgY29uc3QgZWRpdCA9IE4uZm9sZGVyRWRpdDsKICAgIGlmIChlZGl0ICYmIGVkaXQubW9kZSA9PT0gJ25ldycgJiYgIWVkaXQucGFyZW50SWQpIHJvd3M",
"ucHVzaChlZGl0Um93KDApKTsKICAgIGNvbnN0IGN1cnJlbnQgPSBOLmZvbGRlciA_IGZvbGRlckJ5SWQoTi5mb2xkZXIpIDogbnVsbDsKICAgIE4uZm9sZGVycy5mb3JFYWNoKChmLCBpKSA9PiB7CiAgICAgIGlmICghaXNUdWNrZWQoZikpIHsKICAgICAgICByb3dzLnB1c2goZWRpdCAmJiBlZGl0Lm1vZGUgPT09ICdyZW5hbWUnICYmIGVkaXQuZm9sZGVySWQgPT09IGYuaWQgPyBlZGl0Um93KGYuZGVwdGgsIGYpCiAgICAgICAgICA6IGZvbGRlclJvdyhmLCB0YWxseS5nZXQoZi5pZCkgfHwgMCwgISFjdXJyZW50ICYmIE4uZm9sZGVkLmhhcyhmLmlkKSAmJiBjdXJyZW50Lm5hbWUuc3RhcnRzV2l0aChgJHtmLm5hbWV9L2ApKSk7CiAgICAgIH0KICAgICAgLy8gQSBuZXcgc3ViZm9sZGVyJ3MgZmllbGQgZ29lcyBhZnRlciB0aGUgd2hvbGUgYnJhbmNoIGl0IGpvaW5zLgogICAgICBjb25zdCBuZXh0ID0gTi5mb2xkZXJzW2kgKyAxXTsKICAgICAgY29uc3QgYnJhbmNoRW5kcyA9ICFuZXh0IHx8ICFuZXh0Lm5hbWUuc3RhcnRzV2l0aChgJHtmLm5hbWV9L2ApOwogICAgICBpZiAoZWRpdCAmJiBlZGl0Lm1vZGUgPT09ICduZXcnICYmIGVkaXQucGFyZW50SWQpIHsKICAgICAgICBjb25zdCBwYXJlbnQgPSBmb2xkZXJCeUlkKGVkaXQucGFyZW50SWQpOwogICAgICAgIGlmIChwYXJlbnQgJiYgKGYuaWQgPT09IHBhcmVudC5pZCB8fCBmLm5hbWUuc3RhcnRzV2l0aChgJHtwYXJlbnQubmFtZX0vYCkpICYmIGJyYW5jaEVuZHM",
"pIHJvd3MucHVzaChlZGl0Um93KHBhcmVudC5kZXB0aCArIDEpKTsKICAgICAgfQogICAgfSk7CiAgICBlbHMuZm9sZGVySXRlbXMucmVwbGFjZUNoaWxkcmVuKC4uLnJvd3MpOwogICAgLy8gUm9vbSBmb3IgdGhlIGFycm93cyBvbmx5IG9uY2Ugc29tZSBmb2xkZXIgaGFzIHN1YmZvbGRlcnMuCiAgICBlbHMuZm9sZGVySXRlbXMudG9nZ2xlQXR0cmlidXRlKCdkYXRhLW5lc3RlZCcsIE4uZm9sZGVycy5zb21lKGYgPT4gZi5kZXB0aCA-IDApKTsKCiAgICBjb25zdCBzaG93biA9IE4uZm9sZGVyID8gZm9sZGVyQnlJZChOLmZvbGRlcikgOiBudWxsOwogICAgZWxzLmZvbGRlcnNUb2dnbGUucmVwbGFjZUNoaWxkcmVuKAogICAgICBpY29uKHNob3duID8gJ2ZvbGRlcicgOiAnbm90ZXMnLCAyMCksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZnQtbGFiZWwnLCB0ZXh0OiBzaG93biA_IGZvbGRlckxhYmVsKHNob3duLmlkKSA6ICdBbGwgbm90ZXMnIH0pLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2Z0LWNvdW50JywgdGV4dDogTi5zdGF0dXMgPT09ICdyZWFkeScgPyBTdHJpbmcoc2hvd24gPyB0YWxseS5nZXQoc2hvd24uaWQpIHx8IDAgOiBOLm5vdGVzLmxlbmd0aCkgOiAnJyB9KSwKICAgICAgaWNvbignY2FyZXQnLCAyMCkpOwogIH0KCiAgLy8gaG9sZHNDdXJyZW50OiBmb2xkZWQsIHdpdGggdGhlIGZvbGRlciBiZWluZyBsb29rZWQgYXQgc29tZXdoZXJlIGluc2lkZS4KICBmdW5jdGlvbiBmb2xkZXJSb3coZiw",
"gY291bnQsIGhvbGRzQ3VycmVudCA9IGZhbHNlKSB7CiAgICBjb25zdCBpZCA9IGYgPyBmLmlkIDogJyc7CiAgICBjb25zdCBjaGlsZHJlbiA9IGYgPyBoYXNTdWJmb2xkZXJzKGYpIDogZmFsc2U7CiAgICBjb25zdCBmb2xkZWQgPSBjaGlsZHJlbiAmJiBOLmZvbGRlZC5oYXMoaWQpOwogICAgY29uc3Qgcm93ID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ2ZvbGRlci1yb3cnLCByb2xlOiAnbGlzdGl0ZW0nLCBkYXRhc2V0OiB7IGZvbGRlcjogaWQgfHwgJ2FsbCcgfSwKICAgIH0sCiAgICAgIGNoaWxkcmVuID8gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnZm9sZGVyLXR3aXN0eScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1leHBhbmRlZCc6IFN0cmluZyghZm9sZGVkKSwKICAgICAgICAnYXJpYS1sYWJlbCc6IGAke2ZvbGRlZCA_ICdTaG93JyA6ICdIaWRlJ30gdGhlIGZvbGRlcnMgaW4gJHtmLnRpdGxlfWAsIHRpdGxlOiBmb2xkZWQgPyAnU2hvdyBzdWJmb2xkZXJzJyA6ICdIaWRlIHN1YmZvbGRlcnMnLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgZm9sZGVyLXR3aXN0eToke2lkfWAgfSwgb25jbGljazogKCkgPT4gc2V0Rm9sZGVkKGYsICFmb2xkZWQpLAogICAgICB9LCBpY29uKCdjYXJldCcsIDE4KSkgOiBoKCdzcGFuJywgeyBjbGFzczogJ2ZvbGRlci10d2lzdHknLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogYGZvbGRlci1idG4ke2h",
"vbGRzQ3VycmVudCA_ICcgaG9sZHMtY3VycmVudCcgOiAnJ31gLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtY3VycmVudCc6IE4uZm9sZGVyID09PSBpZCA_ICd0cnVlJyA6IG51bGwsCiAgICAgICAgZGF0YXNldDogeyBrZXk6IGBmb2xkZXI6JHtpZCB8fCAnYWxsJ31gIH0sIHRpdGxlOiBmID8gZi5uYW1lIDogJ0V2ZXJ5IG5vdGUsIGluIGFueSBmb2xkZXInLAogICAgICAgIG9uY2xpY2s6ICgpID0-IHNlbGVjdEZvbGRlcihpZCksCiAgICAgICAgLy8gQXMgaW4gYW55IHRyZWU6IHJpZ2h0IG9wZW5zIGEgZm9sZGVyJ3Mgc3ViZm9sZGVycywgbGVmdCBmb2xkcyB0aGVtLgogICAgICAgIG9ua2V5ZG93bjogZSA9PiB7CiAgICAgICAgICBpZiAoIWNoaWxkcmVuIHx8IGUuYWx0S2V5IHx8IGUuY3RybEtleSB8fCBlLm1ldGFLZXkgfHwgZS5zaGlmdEtleSkgcmV0dXJuOwogICAgICAgICAgaWYgKGUua2V5ID09PSAnQXJyb3dSaWdodCcgJiYgZm9sZGVkKSB7IGUucHJldmVudERlZmF1bHQoKTsgc2V0Rm9sZGVkKGYsIGZhbHNlKTsgfQogICAgICAgICAgaWYgKGUua2V5ID09PSAnQXJyb3dMZWZ0JyAmJiAhZm9sZGVkKSB7IGUucHJldmVudERlZmF1bHQoKTsgc2V0Rm9sZGVkKGYsIHRydWUpOyB9CiAgICAgICAgfSwKICAgICAgfSwKICAgICAgICBpY29uKGYgPyAnZm9sZGVyJyA6ICdub3RlcycsIDE4KSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2ZvbGRlci10aXRsZScsIHRleHQ6IGYgPyBmLnRpdGxlIDogJ0FsbCB",
"ub3RlcycgfSksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmb2xkZXItY291bnQnLCB0ZXh0OiBOLnN0YXR1cyA9PT0gJ3JlYWR5JyA_IFN0cmluZyhjb3VudCkgOiAnJyB9KSksCiAgICAgIGYgPyBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0biBmb2xkZXItbWVudScsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6IGBNb3JlIGFjdGlvbnM6ICR7Zi50aXRsZX1gLCB0aXRsZTogJ01vcmUgYWN0aW9ucycsCiAgICAgICAgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywgZGF0YXNldDogeyBrZXk6IGBmb2xkZXItbWVudToke2lkfWAgfSwKICAgICAgICBvbmNsaWNrOiBlID0-IG9wZW5NZW51KE4uY3R4LnJvb3QsIGUuY3VycmVudFRhcmdldCwgWwogICAgICAgICAgeyBsYWJlbDogJ1JlbmFtZScsIGljb246ICdlZGl0Jywga2V5OiAnZm9sZGVyLXJlbmFtZScsIG9uU2VsZWN0OiAoKSA9PiBzdGFydEZvbGRlckVkaXQoeyBtb2RlOiAncmVuYW1lJywgZm9sZGVySWQ6IGlkIH0pIH0sCiAgICAgICAgICB7IGxhYmVsOiAnTmV3IHN1YmZvbGRlcicsIGljb246ICdhZGQnLCBrZXk6ICdmb2xkZXItc3ViJywgb25TZWxlY3Q6ICgpID0-IHN0YXJ0Rm9sZGVyRWRpdCh7IG1vZGU6ICduZXcnLCBwYXJlbnRJZDogaWQgfSkgfSwKICAgICAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgICAgICB7CiAgICAgICAgICAgIGxhYmVsOiBjb3VudCB8fCB",
"jaGlsZHJlbiA_ICdEZWxldGUgKGVtcHR5IGl0IGZpcnN0KScgOiAnRGVsZXRlJywgaWNvbjogJ2RlbGV0ZScsIGRhbmdlcjogdHJ1ZSwga2V5OiAnZm9sZGVyLWRlbGV0ZScsCiAgICAgICAgICAgIGRpc2FibGVkOiAhIShjb3VudCB8fCBjaGlsZHJlbiksIG9uU2VsZWN0OiAoKSA9PiByZW1vdmVGb2xkZXIoZiksCiAgICAgICAgICB9LAogICAgICAgIF0sIHsgbGFiZWw6IGBBY3Rpb25zIGZvciAke2YudGl0bGV9YCB9KSwKICAgICAgfSwgaWNvbignbW9yZScsIDE4KSkgOiBudWxsKTsKICAgIC8vIFRocm91Z2ggdGhlIHN0eWxlIEFQSSwgbm90IGEgc3R5bGUgYXR0cmlidXRlOiBhIHBhZ2UncyBzZWN1cml0eQogICAgLy8gcG9saWN5IG1heSByZWZ1c2UgaW5saW5lIHN0eWxlIGF0dHJpYnV0ZXMsIG5ldmVyIHRoaXMuCiAgICByb3cuc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZiA_IGYuZGVwdGggOiAwKSk7CgogICAgLy8gRHJvcHBpbmcgYSBub3RlIGhlcmUgZmlsZXMgaXQgaGVyZTsgb24gIkFsbCBub3RlcyIsIHRha2VzIGl0IG91dCBvZgogICAgLy8gaXRzIGZvbGRlci4KICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsIGUgPT4gewogICAgICBpZiAoIU4uZHJhZ0tleSkgcmV0dXJuOwogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGUuZGF0YVRyYW5zZmVyLmRyb3BFZmZlY3QgPSAnbW92ZSc7CiAgICAgIHJvdy5jbGFzc0xpc3QuYWRkKCdkcm9wJyk7CiAgICB9KTs",
"KICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCdkcmFnbGVhdmUnLCAoKSA9PiByb3cuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcCcpKTsKICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCdkcm9wJywgZSA9PiB7CiAgICAgIGlmICghTi5kcmFnS2V5KSByZXR1cm47CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgcm93LmNsYXNzTGlzdC5yZW1vdmUoJ2Ryb3AnKTsKICAgICAgY29uc3Qgbm90ZSA9IE4ubm90ZXMuZmluZChuID0-IG4ua2V5ID09PSBOLmRyYWdLZXkpOwogICAgICBOLmRyYWdLZXkgPSAnJzsKICAgICAgaWYgKG5vdGUpIG1vdmVOb3RlKG5vdGUsIGlkKTsKICAgIH0pOwogICAgcmV0dXJuIHJvdzsKICB9CgogIGZ1bmN0aW9uIGVkaXRSb3coZGVwdGgsIGZvbGRlcikgewogICAgY29uc3QgZWRpdCA9IE4uZm9sZGVyRWRpdDsKICAgIGNvbnN0IGlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCBmb2xkZXItaW5wdXQnLCB0eXBlOiAndGV4dCcsIHZhbHVlOiBlZGl0LnZhbHVlLCBtYXhsZW5ndGg6IFN0cmluZyhub3Rlc0xvZ2ljLkZPTERFUl9OQU1FX01BWCksCiAgICAgIHBsYWNlaG9sZGVyOiBlZGl0Lm1vZGUgPT09ICduZXcnID8gJ0ZvbGRlciBuYW1lLCB0aGVuIEVudGVyJyA6ICcnLCAnYXJpYS1sYWJlbCc6IGVkaXQubW9kZSA9PT0gJ25ldycgPyAnTmV3IGZvbGRlciBuYW1lJyA6IGBSZW5hbWUgJHtmb2xkZXIudGl0bGV9YCwKICAgICAgZGlzYWJsZWQ6ICEhZWRpdC5",
"idXN5LCBkYXRhc2V0OiB7IGtleTogJ2ZvbGRlci1pbnB1dCcgfSwKICAgICAgb25pbnB1dDogZSA9PiB7IGVkaXQudmFsdWUgPSBlLnRhcmdldC52YWx1ZTsgfSwKICAgICAgb25rZXlkb3duOiBlID0-IHsKICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBjb21taXRGb2xkZXJFZGl0KCk7IH0KICAgICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgY2FuY2VsRm9sZGVyRWRpdCgpOyB9CiAgICAgIH0sCiAgICAgIG9uYmx1cjogKCkgPT4geyBpZiAoIWVkaXQuYnVzeSAmJiBOLmZvbGRlckVkaXQgPT09IGVkaXQpIHNldFRpbWVvdXQoKCkgPT4geyBpZiAoTi5mb2xkZXJFZGl0ID09PSBlZGl0ICYmICFlZGl0LmJ1c3kpIGNhbmNlbEZvbGRlckVkaXQoKTsgfSwgMTUwKTsgfSwKICAgIH0pOwogICAgY29uc3Qgcm93ID0gaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlci1yb3cgZWRpdGluZycgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2ZvbGRlci1lZGl0JyB9LCBpY29uKCdmb2xkZXInLCAxOCksIGlucHV0KSwKICAgICAgZWRpdC5lcnJvciA_IGgoJ2RpdicsIHsgY2xhc3M6ICdmb2xkZXItZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBlZGl0LmVycm9yIH0pIDogbnVsbCk7CiAgICByb3cuc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZGVwdGgpKTsKICAgIHJldHVybiB",
"yb3c7CiAgfQoKICBmdW5jdGlvbiBzdGFydEZvbGRlckVkaXQoeyBtb2RlLCBwYXJlbnRJZCA9ICcnLCBmb2xkZXJJZCA9ICcnIH0pIHsKICAgIGNvbnN0IGYgPSBmb2xkZXJCeUlkKGZvbGRlcklkKTsKICAgIC8vIEEgbmV3IHN1YmZvbGRlcidzIGZpZWxkIHNob3dzIGluc2lkZSBpdHMgcGFyZW50LCBzbyB0aGF0IGhhcyB0byBiZSBvcGVuLgogICAgY29uc3QgcGFyZW50ID0gbW9kZSA9PT0gJ25ldycgPyBmb2xkZXJCeUlkKHBhcmVudElkKSA6IG51bGw7CiAgICBpZiAocGFyZW50KSB1bmZvbGQocGFyZW50LCB0cnVlKTsKICAgIE4uZm9sZGVyRWRpdCA9IHsgbW9kZSwgcGFyZW50SWQsIGZvbGRlcklkLCB2YWx1ZTogbW9kZSA9PT0gJ3JlbmFtZScgJiYgZiA_IGYudGl0bGUgOiAnJywgZXJyb3I6ICcnLCBidXN5OiBmYWxzZSB9OwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGNvbnN0IGlucHV0ID0gZWxzLmZvbGRlckl0ZW1zLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0iZm9sZGVyLWlucHV0Il0nKTsKICAgIGlmIChpbnB1dCkgeyBpbnB1dC5mb2N1cygpOyBpbnB1dC5zZWxlY3QoKTsgfQogIH0KCiAgZnVuY3Rpb24gY2FuY2VsRm9sZGVyRWRpdCgpIHsKICAgIGlmICghTi5mb2xkZXJFZGl0KSByZXR1cm47CiAgICBOLmZvbGRlckVkaXQgPSBudWxsOwogICAgZHJhd0ZvbGRlcnMoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGNvbW1pdEZvbGRlckVkaXQoKSB7CiAgICBjb25zdCBlZGl0ID0gTi5mb2xkZXJFZGl0Owo",
"gICAgaWYgKCFlZGl0IHx8IGVkaXQuYnVzeSkgcmV0dXJuOwogICAgY29uc3QgdGFyZ2V0ID0gZWRpdC5tb2RlID09PSAncmVuYW1lJyA_IGZvbGRlckJ5SWQoZWRpdC5mb2xkZXJJZCkgOiBudWxsOwogICAgY29uc3QgcGFyZW50ID0gZWRpdC5tb2RlID09PSAnbmV3JyA_IGZvbGRlckJ5SWQoZWRpdC5wYXJlbnRJZCkgOiBudWxsOwogICAgY29uc3QgcGFyZW50UGF0aCA9IHRhcmdldCA_IHRhcmdldC5wYXJlbnRQYXRoIDogcGFyZW50ID8gcGFyZW50LnBhdGggOiAnJzsKICAgIGNvbnN0IHNpYmxpbmdzID0gTi5mb2xkZXJzLmZpbHRlcihmID0-IGYucGFyZW50UGF0aCA9PT0gcGFyZW50UGF0aCAmJiBmICE9PSB0YXJnZXQpLm1hcChmID0-IGYudGl0bGUpOwogICAgY29uc3QgcHJvYmxlbSA9IG5vdGVzTG9naWMudmFsaWRhdGVGb2xkZXJUaXRsZShlZGl0LnZhbHVlLCBzaWJsaW5ncyk7CiAgICBpZiAoZWRpdC5tb2RlID09PSAncmVuYW1lJyAmJiB0YXJnZXQgJiYgZWRpdC52YWx1ZS50cmltKCkgPT09IHRhcmdldC50aXRsZSkgeyBjYW5jZWxGb2xkZXJFZGl0KCk7IHJldHVybjsgfQogICAgaWYgKHByb2JsZW0pIHsKICAgICAgZWRpdC5lcnJvciA9IHByb2JsZW07CiAgICAgIGRyYXdGb2xkZXJzKCk7CiAgICAgIGNvbnN0IGlucHV0ID0gZWxzLmZvbGRlckl0ZW1zLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0iZm9sZGVyLWlucHV0Il0nKTsKICAgICAgaWYgKGlucHV0KSBpbnB1dC5mb2N1cygpOwogICAgICByZXR",
"1cm47CiAgICB9CiAgICBlZGl0LmJ1c3kgPSB0cnVlOwogICAgZHJhd0ZvbGRlcnMoKTsKICAgIHRyeSB7CiAgICAgIGlmIChlZGl0Lm1vZGUgPT09ICduZXcnKSB7CiAgICAgICAgY29uc3QgbWFkZSA9IGF3YWl0IG5vdGVzU3RvcmUuY3JlYXRlRm9sZGVyKHBhcmVudCwgZWRpdC52YWx1ZSk7CiAgICAgICAgTi5mb2xkZXJzID0gbm90ZXNTdG9yZS5mb2xkZXJzKCk7CiAgICAgICAgaWYgKG1hZGUpIE4uZm9sZGVyID0gbWFkZS5pZDsKICAgICAgICB0b2FzdChOLmN0eC5yb290LCBgRm9sZGVyIOKAnCR7ZWRpdC52YWx1ZS50cmltKCl94oCdIGNyZWF0ZWQuYCk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgYXdhaXQgbm90ZXNTdG9yZS5yZW5hbWVGb2xkZXIodGFyZ2V0LCBlZGl0LnZhbHVlKTsKICAgICAgICBOLmZvbGRlcnMgPSBub3Rlc1N0b3JlLmZvbGRlcnMoKTsKICAgICAgfQogICAgICBOLmZvbGRlckVkaXQgPSBudWxsOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGVkaXQuYnVzeSA9IGZhbHNlOwogICAgICBlZGl0LmVycm9yID0gYENvdWxkbuKAmXQgc2F2ZTogJHtlcnIubWVzc2FnZX1gOwogICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIE4uY3R4Lm9uU3RhdGVFcnJvcihlcnIpOwogICAgfQogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgICBpZiAoTi5jdXJyZW50KSBkcmF3QmFyKCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiByZW1vdmVGb2xkZXIoZikgewogICA",
"gdHJ5IHsKICAgICAgYXdhaXQgbm90ZXNTdG9yZS5kZWxldGVGb2xkZXIoZik7CiAgICAgIE4uZm9sZGVycyA9IG5vdGVzU3RvcmUuZm9sZGVycygpOwogICAgICBpZiAoTi5mb2xkZXIgPT09IGYuaWQpIE4uZm9sZGVyID0gJyc7CiAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGBGb2xkZXIg4oCcJHtmLnRpdGxlfeKAnSBkZWxldGVkLmApOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGNvbnN0IG1zZyA9IGVyci5jb2RlID09PSAnbm90X2FsbG93ZWQnID8gJ09ubHkgYW4gZW1wdHkgZm9sZGVyIGNhbiBiZSBkZWxldGVkLiBNb3ZlIGl0cyBub3RlcyBvdXQgZmlyc3QuJyA6IGVyci5tZXNzYWdlOwogICAgICB0b2FzdChOLmN0eC5yb290LCBgQ291bGRu4oCZdCBkZWxldGUg4oCcJHtmLnRpdGxlfeKAnTogJHttc2d9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogICAgfQogICAgZHJhd0ZvbGRlcnMoKTsKICAgIGRyYXdMaXN0KCk7CiAgfQoKICAvLyBSdW5zIGFmdGVyIGFueSBzYXZlIGluIHByb2dyZXNzLCBzbyB0aGUgbW92ZSBsYW5kcyBvbiB0aGUgbmV3ZXN0CiAgLy8gdmVyc2lvbiByYXRoZXIgdGhhbiBvbmUgYWJvdXQgdG8gYmUgcmVwbGFjZWQuCiAgZnVuY3Rpb24gbW92ZU5vdGUobm90ZSwgZm9sZGVySWQpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQgJiYgTi5jdXJyZW50Lm5vdGUgPT09IG5vdGUgPyBOLmN1cnJlbnQgOiBudWxsOwogICAgaWYgKChub3RlLmZvbGRlcklkIHx8ICcnKSA9PT0gKGZvbGRlcklkIHx",
"8ICcnKSkgcmV0dXJuIE4uY2hhaW47CiAgICBOLmNoYWluID0gTi5jaGFpbi50aGVuKGFzeW5jICgpID0-IHsKICAgICAgY29uc3QgbGF0ZXN0ID0gYyA_IGMubm90ZSA6IG5vdGU7CiAgICAgIGNvbnN0IHdhcyA9IGxhdGVzdC5mb2xkZXJJZCB8fCAnJzsKICAgICAgbGF0ZXN0LmZvbGRlcklkID0gZm9sZGVySWQ7CiAgICAgIGlmIChjKSBjLmZvbGRlcklkID0gZm9sZGVySWQ7CiAgICAgIGRyYXdGb2xkZXJzKCk7CiAgICAgIGRyYXdMaXN0KCk7CiAgICAgIGlmIChjKSBkcmF3QmFyKCk7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgbm90ZXNTdG9yZS5tb3ZlKGxhdGVzdCwgZm9sZGVySWQpOwogICAgICAgIHRvYXN0KE4uY3R4LnJvb3QsIGZvbGRlcklkID8gYE1vdmVkIHRvICR7Zm9sZGVyTGFiZWwoZm9sZGVySWQpfS5gIDogJ1Rha2VuIG91dCBvZiBpdHMgZm9sZGVyLicpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBsYXRlc3QuZm9sZGVySWQgPSB3YXM7CiAgICAgICAgaWYgKGMpIGMuZm9sZGVySWQgPSB3YXM7CiAgICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgbW92ZSDigJwke2xhdGVzdC50aXRsZX3igJ06ICR7ZXJyLm1lc3NhZ2V9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogICAgICAgIGlmIChhcGkuU1RBVEVfQ09ERVMuaGFzKGVyci5jb2RlKSkgTi5jdHgub25TdGF0ZUVycm9yKGVycik7CiAgICAgIH0KICAgICAgZHJhd0ZvbGRlcnMoKTsKICAgICAgZHJhd0xpc3QoKTsKICA",
"gICAgaWYgKE4uY3VycmVudCA9PT0gYyAmJiBjKSBkcmF3QmFyKCk7CiAgICB9KTsKICAgIHJldHVybiBOLmNoYWluOwogIH0KCiAgLy8gVGhlIGZvbGRlciBidXR0b24gYWJvdmUgdGhlIG5vdGU6IHdoZXJlIGl0IGlzLCBhbmQgd2hlcmUgaXQgY2FuIGdvLgogIGZ1bmN0aW9uIGNob29zZUZvbGRlcihhbmNob3IpIHsKICAgIGNvbnN0IGMgPSBOLmN1cnJlbnQ7CiAgICBpZiAoIWMpIHJldHVybjsKICAgIG9wZW5NZW51KE4uY3R4LnJvb3QsIGFuY2hvciwgWwogICAgICB7IGhlYWRpbmc6ICdNb3ZlIHRvJyB9LAogICAgICB7IGxhYmVsOiAnTm8gZm9sZGVyJywga2V5OiAnbW92ZS1mb2xkZXI6bm9uZScsIGNoZWNrZWQ6ICFjLmZvbGRlcklkLCBvblNlbGVjdDogKCkgPT4gc2V0Q3VycmVudEZvbGRlcignJykgfSwKICAgICAgLi4uTi5mb2xkZXJzLm1hcChmID0-ICh7CiAgICAgICAgbGFiZWw6IGAkeydcdTIwMDMnLnJlcGVhdChmLmRlcHRoKX0ke2YudGl0bGV9YCwga2V5OiBgbW92ZS1mb2xkZXI6JHtmLmlkfWAsIGNoZWNrZWQ6IGMuZm9sZGVySWQgPT09IGYuaWQsCiAgICAgICAgb25TZWxlY3Q6ICgpID0-IHNldEN1cnJlbnRGb2xkZXIoZi5pZCksCiAgICAgIH0pKSwKICAgIF0sIHsgbGFiZWw6ICdGb2xkZXInIH0pOwogIH0KCiAgZnVuY3Rpb24gc2V0Q3VycmVudEZvbGRlcihpZCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYykgcmV0dXJuOwogICAgLy8gTm90IHNhdmVkIHlldDogdGhlIGZ",
"vbGRlciBpcyBzaW1wbHkgd2hlcmUgdGhlIGZpcnN0IHNhdmUgcHV0cyBpdC4KICAgIGlmICghYy5ub3RlKSB7CiAgICAgIGMuZm9sZGVySWQgPSBpZDsKICAgICAgZHJhd0JhcigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBtb3ZlTm90ZShjLm5vdGUsIGlkKTsKICB9CgogIGZ1bmN0aW9uIGRyYXdGb290KCkgewogICAgaWYgKCFlbHMuZm9vdCkgcmV0dXJuOwogICAgZWxzLmZvb3QudGV4dENvbnRlbnQgPSBOLnRydW5jYXRlZAogICAgICA_ICdTaG93aW5nIHRoZSAxMDAgbW9zdCByZWNlbnQuIFNlYXJjaCB0byBmaW5kIG9sZGVyIG9uZXMuJwogICAgICA6IGBLZXB0IGluIEdtYWlsIHVuZGVyIOKAnCR7bm90ZXNTdG9yZS5sYWJlbE5hbWUoKX3igJ1gOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBlZGl0b3Ig4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG5ld0N1cnJlbnQobm90ZSkgewogICAgcmV0dXJuIHsKICAgICAga2V5OiBub3RlID8gbm90ZS5rZXkgOiBgbmV3OiR7RGF0ZS5ub3coKX1gLAogICAgICBub3RlLCAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gbnVsbCB1bnRpbCBmaXJzdCBzYXZlZAogICAgICB0aXRsZTogbm90ZSAmJiBub3R",
"lLnRpdGxlICE9PSAnVW50aXRsZWQgbm90ZScgPyBub3RlLnRpdGxlIDogJycsCiAgICAgIGRvYzogbm90ZSA_IG51bGwgOiBmbXQuZW1wdHlEb2MoKSwgICAvLyBmb3JtYXR0ZWQgY29udGVudCwgb25jZSBsb2FkZWQKICAgICAgYm9keVN0YXRlOiBub3RlID8gJ2xvYWRpbmcnIDogJ3JlYWR5JywgLy8gbG9hZGluZyB8IHJlYWR5IHwgZXJyb3IKICAgICAgZGlydHk6IGZhbHNlLAogICAgICBzYXZpbmc6IGZhbHNlLAogICAgICBlcnJvcjogJycsCiAgICAgIHNhdmVkQXQ6IDAsCiAgICAgIC8vIEEgbmV3IG5vdGUgc3RhcnRzIGluIHRoZSBmb2xkZXIgYmVpbmcgbG9va2VkIGF0LgogICAgICBmb2xkZXJJZDogbm90ZSA_IG5vdGUuZm9sZGVySWQgfHwgJycgOiBOLmZvbGRlciwKICAgICAgLy8gVGhlIHZlcnNpb24gdGhlIGVkaXRzIGhlcmUgc3RhcnRlZCBmcm9tLCBmb3IgYSBtZXJnZS4KICAgICAgYmFzZTogbm90ZSA_IG51bGwgOiBmbXQuZW1wdHlEb2MoKSwKICAgICAgYmFzZVRpdGxlOiBub3RlID8gbm90ZS50aXRsZSA6ICcnLAogICAgfTsKICB9CgogIC8vIFRoZSBzY3JhdGNocGFkLCBhcyB0aGUgbm90ZSBiZWluZyBlZGl0ZWQ6IGl0cyBzYXZlZCBtZXNzYWdlLCBvciBudWxsCiAgLy8gd2hlbiB0aGVyZSBpcyBub25lIHlldC4gSXQga2VlcHMgaXRzIG5hbWUgYW5kIHN0YXlzIG91dCBvZiBmb2xkZXJzLgogIC8vIFRoZXJlIGlzIG9uZSBhdCBhIHRpbWU6IHRoZSBuZXdlc3QgbWFkZSBpcyBOLnNjcmF0Y2guCiA",
"gZnVuY3Rpb24gc2NyYXRjaEN1cnJlbnQobm90ZSkgewogICAgTi5zY3JhdGNoID0gT2JqZWN0LmFzc2lnbihuZXdDdXJyZW50KG5vdGUpLCB7CiAgICAgIHNjcmF0Y2g6IHRydWUsIGtleTogU0NSQVRDSF9LRVksIHRpdGxlOiBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUsIGZvbGRlcklkOiAnJywKICAgIH0pOwogICAgcmV0dXJuIE4uc2NyYXRjaDsKICB9CgogIC8vIEJlZm9yZSB0aGUgbGlzdCBpcyBpbiwgbm9ib2R5IGtub3dzIHlldCB3aGV0aGVyIHRoZXJlIGlzIG9uZS4KICBmdW5jdGlvbiBwZW5kaW5nU2NyYXRjaCgpIHsKICAgIHJldHVybiBPYmplY3QuYXNzaWduKHNjcmF0Y2hDdXJyZW50KG51bGwpLCB7IGRvYzogbnVsbCwgYm9keVN0YXRlOiAnbG9hZGluZycgfSk7CiAgfQoKICAvLyBXaGVuZXZlciBubyBvdGhlciBub3RlIGlzIG9wZW46IHRoZSBzY3JhdGNocGFkIC0gYXMgaXQgaXMsIGlmIGl0IGhhcwogIC8vIGJlZW4gcmVhZCBhbHJlYWR5ICh0aGUgY2FsZW5kYXIncyB0aWxlIG1heSBoYXZlIGVkaXRzIGluIGl0KSwgY2F1Z2h0CiAgLy8gdXAgaWYgdGhlcmUgaXMgYSBuZXdlciB2ZXJzaW9uLgogIGZ1bmN0aW9uIHNob3dTY3JhdGNoKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmIChjICYmIGMuc2NyYXRjaCAmJiBjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykgcmV0dXJuOwogICAgY29uc3QgcyA9IE4uc2NyYXRjaDsKICAgIGlmIChzICYmIHMuYm9keVN0YXRlID09PSAncmVhZHk",
"nKSB7CiAgICAgIGZsdXNoKCk7CiAgICAgIE4uY3VycmVudCA9IHM7CiAgICAgIE4uZmluZEluZGV4ID0gMDsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgZHJhd0VkaXRvcigpOwogICAgICBhcHBseUhpZ2hsaWdodHMoKTsKICAgICAgc2NyYXRjaFJlYWR5KCk7CiAgICAgIGNhdGNoVXBDdXJyZW50KCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChOLnNjcmF0Y2hOb3RlKSB7IG9wZW5Ob3RlKE4uc2NyYXRjaE5vdGUsIHsgZm9yY2U6IHRydWUgfSk7IHJldHVybjsgfQogICAgZmx1c2goKTsKICAgIE4uY3VycmVudCA9IE4uc2NyYXRjaEtub3duID8gc2NyYXRjaEN1cnJlbnQobnVsbCkgOiBwZW5kaW5nU2NyYXRjaCgpOwogICAgZHJhd0xpc3QoKTsKICAgIGRyYXdFZGl0b3IoKTsKICAgIHNjcmF0Y2hSZWFkeSgpOwogIH0KCiAgLy8gVGhlIGN1cnNvciBnb2VzIGludG8gdGhlIHNjcmF0Y2hwYWQgb25jZSBpdCBjYW4gdGFrZSB0eXBpbmcsIGlmIGl0CiAgLy8gd2FzIGFza2VkIGZvciBiZWZvcmUgdGhlbi4KICBmdW5jdGlvbiBzY3JhdGNoUmVhZHkoKSB7CiAgICBjb25zdCBjID0gTi5jdXJyZW50OwogICAgaWYgKCFOLndhbnRGb2N1cyB8fCAhYyB8fCAhYy5zY3JhdGNoIHx8IGMuYm9keVN0YXRlICE9PSAncmVhZHknKSByZXR1cm47CiAgICBOLndhbnRGb2N1cyA9IGZhbHNlOwogICAgZm9jdXNGaWVsZCgnbm90ZS1ib2R5Jyk7CiAgfQoKICBmdW5jdGlvbiBuZXdOb3RlKCkgewogICAgZmx1c2goKTsKICAgIE4",
"uY3VycmVudCA9IG5ld0N1cnJlbnQobnVsbCk7CiAgICBkcmF3TGlzdCgpOwogICAgZHJhd0VkaXRvcigpOwogICAgZm9jdXNGaWVsZCgnbm90ZS10aXRsZScpOwogIH0KCiAgZnVuY3Rpb24gb3Blbk5vdGUobm90ZSwgeyBmb3JjZSA9IGZhbHNlIH0gPSB7fSkgewogICAgaWYgKCFmb3JjZSAmJiBOLmN1cnJlbnQgJiYgTi5jdXJyZW50LmtleSA9PT0gbm90ZS5rZXkpIHJldHVybjsKICAgIGlmIChub3RlLmtleSA9PT0gU0NSQVRDSF9LRVkgJiYgTi5zY3JhdGNoICYmIE4uc2NyYXRjaC5ib2R5U3RhdGUgPT09ICdyZWFkeScgJiYgTi5jdXJyZW50ICE9PSBOLnNjcmF0Y2gpIHsKICAgICAgc2hvd1NjcmF0Y2goKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgZmx1c2goKTsKICAgIGNvbnN0IGMgPSBub3RlLmtleSA9PT0gU0NSQVRDSF9LRVkgPyBzY3JhdGNoQ3VycmVudChub3RlKSA6IG5ld0N1cnJlbnQobm90ZSk7CiAgICBOLmN1cnJlbnQgPSBjOwogICAgTi5maW5kSW5kZXggPSAwOwogICAgZHJhd0xpc3QoKTsKICAgIGRyYXdFZGl0b3IoKTsKICAgIGxvYWRCb2R5KGMpOwogIH0KCiAgLy8gQSBub3RlJ3MgdGV4dCwgcmVhZCBmcm9tIEdtYWlsLiBUaGUgc2NyYXRjaHBhZCdzIGdvZXMgdG8gdGhlCiAgLy8gY2FsZW5kYXIncyB0aWxlIGFzIHdlbGwsIHdoZXRoZXIgb3Igbm90IGl0IGlzIG9wZW4gaGVyZS4KICBmdW5jdGlvbiBsb2FkQm9keShjKSB7CiAgICBjb25zdCB3YW50ZWQgPSAoKSA9PiBOLmN1cnJlbnQgPT0",
"9IGMgfHwgTi5zY3JhdGNoID09PSBjOwogICAgbm90ZXNTdG9yZS5ib2R5KGMubm90ZSkudGhlbihkb2MgPT4gewogICAgICBpZiAoIXdhbnRlZCgpKSByZXR1cm47CiAgICAgIGMuZG9jID0gZG9jOwogICAgICBjLmJhc2UgPSBkb2M7CiAgICAgIGMuYm9keVN0YXRlID0gJ3JlYWR5JzsKICAgICAgaWYgKE4uY3VycmVudCA9PT0gYykgewogICAgICAgIGRyYXdFZGl0b3IoKTsKICAgICAgICBhcHBseUhpZ2hsaWdodHMoKTsKICAgICAgICBzY3JhdGNoUmVhZHkoKTsKICAgICAgfQogICAgICBpZiAoTi5zY3JhdGNoID09PSBjKSBkcmF3VGlsZSgpOwogICAgfSwgZXJyID0-IHsKICAgICAgaWYgKCF3YW50ZWQoKSkgcmV0dXJuOwogICAgICBjLmJvZHlTdGF0ZSA9ICdlcnJvcic7CiAgICAgIGMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSBzdGF0ZUVycm9yKGVycik7CiAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMpIGRyYXdFZGl0b3IoKTsKICAgICAgaWYgKE4uc2NyYXRjaCA9PT0gYykgZHJhd1RpbGUoKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZm9jdXNGaWVsZChrZXkpIHsKICAgIGlmIChrZXkgPT09ICdub3RlLWJvZHknICYmIGVscy5lZCkgeyBlbHMuZWQuZm9jdXMoKTsgcmV0dXJuOyB9CiAgICBjb25zdCBlbCA9IGVscy5lZGl0b3IgJiYgZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yKGBbZGF0YS1rZXk9IiR7a2V5fSJdYCk7CiAgICBpZiAoZWw",
"pIGVsLmZvY3VzKCk7CiAgfQoKICAvLyBXaGF0IGEgcGhvbmUgc2hvd3M6IHRoZSBzY3JhdGNocGFkLCB0aGUgbGlzdCwgb3IgYSBub3RlLgogIGZ1bmN0aW9uIHNldFZpZXcoKSB7CiAgICBjb25zdCB2aWV3ID0gTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCA_ICdub3RlJyA6IE4uYnJvd3NpbmcgPyAnbGlzdCcgOiAnaG9tZSc7CiAgICBpZiAoZWxzLndyYXApIGVscy53cmFwLmRhdGFzZXQudmlldyA9IHZpZXc7CiAgICBpZiAodmlldyAhPT0gTi52aWV3KSB7CiAgICAgIE4udmlldyA9IHZpZXc7CiAgICAgIGlmIChOLmN0eCAmJiBOLmN0eC5vblZpZXdDaGFuZ2UpIE4uY3R4Lm9uVmlld0NoYW5nZSh2aWV3KTsKICAgIH0KICB9CgogIC8vIEJhY2sgdG8gdGhlIGxpc3QsIG9uY2Ugd2hhdGV2ZXIgaXMgcGVuZGluZyBpcyBzYXZlZC4gQSBzYXZlIHRoYXQKICAvLyBmYWlsZWQga2VlcHMgdGhlIG5vdGUgb3Blbiwgd2l0aCBpdHMgZXJyb3Igc2hvd2luZywgcmF0aGVyIHRoYW4KICAvLyBsZWF2aW5nIHRoZSBlZGl0cyBiZWhpbmQuCiAgYXN5bmMgZnVuY3Rpb24gY2xvc2VOb3RlKCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCBjLnNjcmF0Y2gpIHJldHVybjsKICAgIGF3YWl0IGZsdXNoKCk7CiAgICBpZiAoTi5jdXJyZW50ICE9PSBjKSByZXR1cm47CiAgICBpZiAoYy5kaXJ0eSkgewogICAgICB0b2FzdChOLmN0eC5yb290LCAnTm90IHNhdmVkIHlldCwgc28gdGhlIG5vdGUgc3R",
"heXMgb3Blbi4gVHJ5IGFnYWluIGluIGEgbW9tZW50LicsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgcmV0dXJuOwogICAgfQogICAgc2hvd1NjcmF0Y2goKTsKICB9CgogIC8vIEEgcGhvbmUncyBCYWNrOiBhIG5vdGUgYmFjayB0byB3aGVyZSBpdCB3YXMgb3BlbmVkIGZyb20sIGFuZCB0aGUgbGlzdAogIC8vIGJhY2sgdG8gdGhlIHNjcmF0Y2hwYWQsIHdpdGggdGhlIHNlYXJjaCBhbmQgdGhlIGZvbGRlciBjbGVhcmVkLgogIGFzeW5jIGZ1bmN0aW9uIGJhY2soKSB7CiAgICBpZiAoTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCkgcmV0dXJuIGNsb3NlTm90ZSgpOwogICAgaWYgKCFOLmJyb3dzaW5nKSByZXR1cm47CiAgICBOLmJyb3dzaW5nID0gZmFsc2U7CiAgICBzZXRGb2xkZXJzT3BlbihmYWxzZSk7CiAgICBpZiAoTi5mb2xkZXIpIHsgTi5mb2xkZXIgPSAnJzsgZHJhd0ZvbGRlcnMoKTsgZHJhd0xpc3QoKTsgfQogICAgaWYgKE4ucXVlcnkpIGNsZWFyU2VhcmNoKCk7CiAgICBzZXRWaWV3KCk7CiAgfQoKICAvLyBIb3cgZmFyIGZyb20gdGhlIHNjcmF0Y2hwYWQ6IDAgdGhlcmUsIDEgaW4gdGhlIGxpc3Qgb3IgYSBub3RlIG9wZW5lZAogIC8vIGZyb20gdGhlIHNjcmF0Y2hwYWQsIDIgaW4gYSBub3RlIG9wZW5lZCBmcm9tIHRoZSBsaXN0LgogIGZ1bmN0aW9uIGRlcHRoKCkgewogICAgY29uc3QgaW5Ob3RlID0gISEoTi5jdXJyZW50ICYmICFOLmN1cnJlbnQuc2NyYXRjaCk7CiAgICByZXR1cm4gKE4",
"uYnJvd3NpbmcgPyAxIDogMCkgKyAoaW5Ob3RlID8gMSA6IDApOwogIH0KCiAgZnVuY3Rpb24gZHJhd0VkaXRvcigpIHsKICAgIGlmICghZWxzLmVkaXRvcikgcmV0dXJuOwogICAgc2V0VmlldygpOwogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYykgcmV0dXJuOwogICAgZWxzLmVkaXRvci5jbGFzc0xpc3QudG9nZ2xlKCdzY3JhdGNoJywgISFjLnNjcmF0Y2gpOwoKICAgIGVscy5iYXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtYmFyJyB9KTsKICAgIGVscy5iYW5uZXJTbG90ID0gaCgnZGl2JywgeyBjbGFzczogJ25lLWJhbm5lci1zbG90JyB9KTsKICAgIGNvbnN0IHRpdGxlID0gYy5zY3JhdGNoID8gaCgnaDInLCB7IGNsYXNzOiAnbmUtdGl0bGUgc2NyYXRjaC10aXRsZScsIGRhdGFzZXQ6IHsga2V5OiAnc2NyYXRjaC10aXRsZScgfSB9LAogICAgICBpY29uKCdlZGl0JywgMjIpLCBoKCdzcGFuJywgeyBjbGFzczogJ3N0LW5hbWUnLCB0ZXh0OiBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUgfSkpIDogaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAnbmUtdGl0bGUnLCB0eXBlOiAndGV4dCcsIHBsYWNlaG9sZGVyOiAnVGl0bGUnLCAnYXJpYS1sYWJlbCc6ICdUaXRsZScsCiAgICAgIHZhbHVlOiBjLnRpdGxlLCBtYXhsZW5ndGg6IFN0cmluZyhub3Rlc0xvZ2ljLk1BWF9USVRMRSksIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS10aXRsZScgfSwKICAgICAgZGlzYWJsZWQ6IGMuYm9keVN0YXRlICE9PSA",
"ncmVhZHknLAogICAgICBvbmlucHV0OiBlID0-IGVkaXRlZChjLCB7IHRpdGxlOiBlLnRhcmdldC52YWx1ZSB9KSwKICAgICAgb25rZXlkb3duOiBlID0-IHsKICAgICAgICAvLyBFbnRlciBpbiB0aGUgdGl0bGUgY2FycmllcyBvbiBpbnRvIHRoZSBib2R5LCBhcyBpbiBtb3N0IGVkaXRvcnMuCiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFlLmlzQ29tcG9zaW5nKSB7IGUucHJldmVudERlZmF1bHQoKTsgZm9jdXNGaWVsZCgnbm90ZS1ib2R5Jyk7IH0KICAgICAgfSwKICAgIH0pOwogICAgLy8gQSBmcmVzaCBlZGl0b3IgcGVyIG5vdGU6IGl0cyB1bmRvIGhpc3RvcnkgYmVsb25ncyB0byB0aGF0IG5vdGUuCiAgICBpZiAoZWxzLmVkKSBlbHMuZWQuZGVzdHJveSgpOwogICAgY29uc3QgZWQgPSBucy5ub3RlRWRpdG9yLmNyZWF0ZSh7CiAgICAgIHJvb3Q6IE4uY3R4LnJvb3QsCiAgICAgIG9uQ2hhbmdlOiAoKSA9PiB7CiAgICAgICAgZWRpdGVkKGMsIHsgZG9jOiBlZC5nZXREb2MoKSB9KTsKICAgICAgICBpZiAoYyA9PT0gTi5zY3JhdGNoKSBULnN0YWxlID0gdHJ1ZTsKICAgICAgfSwKICAgIH0pOwogICAgZWxzLmVkID0gZWQ7CiAgICBlbHMuZWRTdGFsZSA9IGZhbHNlOwogICAgZWQuc2V0RG9jKGMuZG9jIHx8IGZtdC5lbXB0eURvYygpKTsKICAgIGVkLnNldEVkaXRhYmxlKGMuYm9keVN0YXRlID09PSAncmVhZHknLAogICAgICBjLmJvZHlTdGF0ZSA9PT0gJ2xvYWRpbmcnID8gJ0xvYWRpbmfigKYnIDo",
"gYy5ib2R5U3RhdGUgPT09ICdlcnJvcicgPyAnQ291bGRu4oCZdCBsb2FkIHRoaXMgbm90ZS4nCiAgICAgICAgOiBjLnNjcmF0Y2ggPyBgSm90IGFueXRoaW5nIGRvd24uIEl0IHNhdmVzIGFzIHlvdSB0eXBlLCBhcyBhIG5vdGUgaW4gR21haWwgdW5kZXIg4oCcJHtub3Rlc1N0b3JlLmxhYmVsTmFtZSgpfeKAnS5gIDogJ1dyaXRlIGhlcmXigKYnKTsKCiAgICBlbHMuZmluZFNsb3QgPSBoKCdkaXYnLCB7IGNsYXNzOiAnbmUtZmluZC1zbG90JyB9KTsKICAgIGVscy5lZGl0b3IucmVwbGFjZUNoaWxkcmVuKGVscy5iYXIsIGVscy5iYW5uZXJTbG90LCBlbHMuZmluZFNsb3QsIHRpdGxlLCBlZC50b29sYmFyLCBlZC5saW5rYmFyLCBlZC50YWJsZWJhciwgZWQuZWxlbWVudCk7CiAgICBkcmF3QmFyKCk7CiAgICBkcmF3RmluZCgpOwogIH0KCiAgLy8gVGhlIHN0cmlwIGFib3ZlIHRoZSB0ZXh0OiBzdGF0dXMsIGJ1dHRvbnMsIGFuZCB0aGUgYmFubmVyIGZvciBhbgogIC8vIGVtYWlsZWQgbm90ZS4gUmVkcmF3biBvbiBpdHMgb3duIGFmdGVyIGEgc2F2ZSAtIHRoZSBmaXJzdCBzYXZlIG9mIGEKICAvLyBuZXcgbm90ZSBnYWlucyBhbiAiT3BlbiBpbiBHbWFpbCIsIGFuIGVtYWlsZWQgb25lIGxvc2VzIGl0cyBiYW5uZXIgLQogIC8vIHdpdGhvdXQgdG91Y2hpbmcgdGhlIHRleHQgYm94ZXMgdGhlIHVzZXIgbWF5IHN0aWxsIGJlIHR5cGluZyBpbi4KICBmdW5jdGlvbiBkcmF3QmFyKCkgewogICAgY29uc3QgYyA9IE4uY3VycmV",
"udDsKICAgIGlmICghYyB8fCAhZWxzLmJhcikgcmV0dXJuOwogICAgY29uc3QgZm9yZWlnbiA9ICEhKGMubm90ZSAmJiAhYy5ub3RlLm93bik7CiAgICBlbHMuc3RhdHVzID0gaCgnc3BhbicsIHsgY2xhc3M6ICduZS1zdGF0dXMnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScgfSk7CiAgICAvLyBUaGUgc2NyYXRjaHBhZCdzIHN0YXR1cyBzaXRzIG9uIGl0cyB0aXRsZSBsaW5lOiB0aGVyZSBpcyBub3RoaW5nCiAgICAvLyBlbHNlIGZvciBhIGJhciB0byBob2xkLgogICAgaWYgKGMuc2NyYXRjaCkgewogICAgICBlbHMuYmFyLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICBlbHMuYmFubmVyU2xvdC5yZXBsYWNlQ2hpbGRyZW4oJycpOwogICAgICBjb25zdCBsaW5lID0gZWxzLmVkaXRvci5xdWVyeVNlbGVjdG9yKCcuc2NyYXRjaC10aXRsZScpOwogICAgICBjb25zdCBvbGQgPSBsaW5lICYmIGxpbmUucXVlcnlTZWxlY3RvcignLm5lLXN0YXR1cycpOwogICAgICBpZiAob2xkKSBvbGQucmVwbGFjZVdpdGgoZWxzLnN0YXR1cyk7CiAgICAgIGVsc2UgaWYgKGxpbmUpIGxpbmUuYXBwZW5kKGVscy5zdGF0dXMpOwogICAgICBkcmF3U3RhdHVzKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIC8vIChyZXBsYWNlQ2hpbGRyZW4gd291bGQgc2hvdyBhIG51bGwgYXMgdGhlIHdvcmQgIm51bGwiOiB0aGUgbWlzc2luZwogICAgLy8gYnV0dG9ucyBhcmUgbGVmdCBvdXQgaW5zdGVhZC4pCiAgICBlbHMuYmFyLnJlcGxhY2VDaGlsZHJlbig",
"uLi5bCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuIG5lLWJhY2snLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQmFjayB0byB0aGUgbGlzdCcsIHRpdGxlOiAnQmFjayB0byB0aGUgbGlzdCcsCiAgICAgICAgZGF0YXNldDogeyBrZXk6ICdub3RlLWJhY2snIH0sIG9uY2xpY2s6ICgpID0-IGNsb3NlTm90ZSgpLAogICAgICB9LCBpY29uKCdiYWNrJykpLAogICAgICBlbHMuc3RhdHVzLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc3BhY2VyJyB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnbmUtZm9sZGVyJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWhhc3BvcHVwJzogJ21lbnUnLCAnYXJpYS1leHBhbmRlZCc6ICdmYWxzZScsCiAgICAgICAgdGl0bGU6ICdNb3ZlIHRvIGFub3RoZXIgZm9sZGVyJywgZGF0YXNldDogeyBrZXk6ICdub3RlLWZvbGRlcicgfSwKICAgICAgICBvbmNsaWNrOiBlID0-IGNob29zZUZvbGRlcihlLmN1cnJlbnRUYXJnZXQpLAogICAgICB9LCBpY29uKCdmb2xkZXInLCAxOCksIGgoJ3NwYW4nLCB7IHRleHQ6IGMuZm9sZGVySWQgPyBmb2xkZXJMYWJlbChjLmZvbGRlcklkKSB8fCAnTm8gZm9sZGVyJyA6ICdObyBmb2xkZXInIH0pLCBpY29uKCdjYXJldCcsIDE4KSksCiAgICAgIGMubm90ZSA_IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ09",
"wZW4gaW4gR21haWwnLCB0aXRsZTogJ09wZW4gaW4gR21haWwnLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS1vcGVuJyB9LCBvbmNsaWNrOiAoKSA9PiBvcGVuSW5HbWFpbChjKSwKICAgICAgfSwgaWNvbignb3BlbicpKSA6IG51bGwsCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogZm9yZWlnbiA_ICdUYWtlIG9mZiB0aGUgbm90ZXMgbGlzdCcgOiAnRGVsZXRlIG5vdGUnLAogICAgICAgIHRpdGxlOiBmb3JlaWduID8gJ1Rha2Ugb2ZmIHRoZSBub3RlcyBsaXN0ICh0aGUgZW1haWwgc3RheXMpJyA6ICdEZWxldGUgKG1vdmVzIGl0IHRvIEdtYWls4oCZcyBUcmFzaCknLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiAnbm90ZS1kZWxldGUnIH0sIG9uY2xpY2s6ICgpID0-IGRlbGV0ZUN1cnJlbnQoKSwKICAgICAgfSwgaWNvbignZGVsZXRlJykpXS5maWx0ZXIoQm9vbGVhbikpOwogICAgZWxzLmJhbm5lclNsb3QucmVwbGFjZUNoaWxkcmVuKGZvcmVpZ24gPyBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiAnbmUtYmFubmVyJywKICAgICAgdGV4dDogYFRoaXMgb25lIGlzIGFuIGVtYWlsIGZpbGVkIHVuZGVyIOKAnCR7bm90ZXNTdG9yZS5sYWJlbE5hbWUoKX3igJ0uIEVkaXRpbmcgaXQgc2F2ZXMgYSBuZXcgbm90ZSBpbiBpdHMgcGxhY2U7IGAgKwogICAgICAgICd0aGUgZW1haWwgaXRzZWxmIHN0YXlzIGluIEdtYWlsLCBqdXN",
"0IG9mZiB0aGlzIGxpc3QuJywKICAgIH0pIDogJycpOwogICAgZHJhd1N0YXR1cygpOwogIH0KCiAgLy8gVGhlIHN0YXR1cyBsaW5lIGFib3ZlIHRoZSBvcGVuIG5vdGUsIGFuZCB0aGUgb25lIGluIHRoZSBjYWxlbmRhcidzCiAgLy8gc2NyYXRjaHBhZCB0aWxlLgogIGZ1bmN0aW9uIGRyYXdTdGF0dXMoKSB7CiAgICBpZiAoZWxzLnN0YXR1cyAmJiBOLmN1cnJlbnQpIHN0YXR1c0ludG8oZWxzLnN0YXR1cywgTi5jdXJyZW50KTsKICAgIGlmIChULnN0YXR1cyAmJiBOLnNjcmF0Y2gpIHN0YXR1c0ludG8oVC5zdGF0dXMsIE4uc2NyYXRjaCk7CiAgfQoKICBmdW5jdGlvbiBzdGF0dXNJbnRvKGVsLCBjKSB7CiAgICBsZXQgdGV4dDsKICAgIGlmIChjLnNhdmluZykgdGV4dCA9ICdTYXZpbmfigKYnOwogICAgZWxzZSBpZiAoYy5lcnJvciAmJiBjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykgdGV4dCA9IGBDb3VsZG7igJl0IHNhdmU6ICR7Yy5lcnJvcn1gOwogICAgZWxzZSBpZiAoYy5kaXJ0eSkgdGV4dCA9ICdVbnNhdmVkIGNoYW5nZXMnOwogICAgZWxzZSBpZiAoYy5zYXZlZEF0KSB0ZXh0ID0gYFNhdmVkICR7dXRpbC5hZ29UZXh0KERhdGUubm93KCkgLSBjLnNhdmVkQXQpfWA7CiAgICBlbHNlIGlmIChjLm5vdGUpIHRleHQgPSBgTGFzdCBzYXZlZCAke3V0aWwucmVsYXRpdmVEYXRlKGMubm90ZS51cGRhdGVkKX1gOwogICAgZWxzZSB0ZXh0ID0gYy5zY3JhdGNoID8gJycgOiAnTmV3IG5vdGUnOwogICAgZWwudGV4dENvbnR",
"lbnQgPSB0ZXh0OwogICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCAhIShjLmVycm9yICYmICFjLnNhdmluZyAmJiBjLmJvZHlTdGF0ZSA9PT0gJ3JlYWR5JykpOwogICAgZWwudGl0bGUgPSBjLm5vdGUgPyB1dGlsLmZ1bGxEYXRlKGMubm90ZS51cGRhdGVkKSA6ICcnOwogIH0KCiAgLy8g4pSA4pSAIFNhdmluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gZWRpdGVkKGMsIGNoYW5nZSkgewogICAgT2JqZWN0LmFzc2lnbihjLCBjaGFuZ2UpOwogICAgYy5kaXJ0eSA9IHRydWU7CiAgICBjLmVycm9yID0gJyc7CiAgICBkcmF3U3RhdHVzKCk7CiAgICBpZiAoY2hhbmdlLmRvYyAmJiBOLnRlcm1zLmxlbmd0aCkgewogICAgICBjbGVhclRpbWVvdXQoZmluZFRpbWVyKTsKICAgICAgZmluZFRpbWVyID0gc2V0VGltZW91dChhcHBseUhpZ2hsaWdodHMsIDMwMCk7CiAgICB9CiAgICBsYXRlclNhdmUoYyk7CiAgICBpZiAoYy5zY3JhdGNoICYmIG5vdGVzU3RvcmUua2VlcERyYWZ0KSB7CiAgICAgIGNsZWFyVGltZW91dChkcmFmdFRpbWVyKTsKICAgICAgZHJhZnRUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ga2VlcERyYWZ0KGM",
"pLCAzMDApOwogICAgfQogIH0KCiAgLy8gQSBzYXZlIGEgbW9tZW50IGFmdGVyIHRoZSB0eXBpbmcgc3RvcHMuIEVhY2ggbm90ZSBrZWVwcyBpdHMgb3duIHRpbWVyOgogIC8vIHRoZSBzY3JhdGNocGFkLCB0eXBlZCBpbnRvIGluIHRoZSBjYWxlbmRhcidzIHRpbGUsIG11c3Qgbm90IHB1dCBvZmYKICAvLyB0aGUgc2F2ZSBvZiB0aGUgbm90ZSBvcGVuIGhlcmUsIG9yIHRoZSBvdGhlciB3YXkgcm91bmQuCiAgZnVuY3Rpb24gbGF0ZXJTYXZlKGMpIHsKICAgIGNsZWFyVGltZW91dChjLnRpbWVyKTsKICAgIGMudGltZXIgPSBzZXRUaW1lb3V0KCgpID0-IHNhdmUoYyksIEFVVE9TQVZFX01TKTsKICB9CgogIC8vIFNhdmVzIGFyZSBjaGFpbmVkOiBlYWNoIG9uZSByZXRpcmVzIHRoZSB2ZXJzaW9uIHRoZSBwcmV2aW91cyBvbmUKICAvLyB3cm90ZSwgc28gdHdvIGluIGZsaWdodCBhdCBvbmNlIHdvdWxkIGVhY2ggbGVhdmUgYSBzdHJheSBiZWhpbmQuCiAgZnVuY3Rpb24gc2F2ZShjKSB7CiAgICBOLmNoYWluID0gTi5jaGFpbi50aGVuKGFzeW5jICgpID0-IHsKICAgICAgaWYgKCFjLmRpcnR5KSByZXR1cm47CiAgICAgIC8vIEFuIHVudG91Y2hlZCBuZXcgbm90ZSBpcyBub3Qgd29ydGggYSBtZXNzYWdlLgogICAgICBpZiAoIWMubm90ZSAmJiAoYy5zY3JhdGNoIHx8ICFjLnRpdGxlLnRyaW0oKSkgJiYgZm10LmlzRW1wdHkoYy5kb2MpKSB7IGMuZGlydHkgPSBmYWxzZTsgcmV0dXJuOyB9CiAgICAgIGNvbnN0IHNuYXAgPSB",
"7IHRpdGxlOiBjLnRpdGxlLCBkb2M6IGMuZG9jLCBmb2xkZXJJZDogYy5mb2xkZXJJZCwgbm90ZUlkOiBjLnNjcmF0Y2ggPyBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfSUQgOiAnJyB9OwogICAgICAvLyBBIHNjcmF0Y2hwYWQgc3RhcnRlZCBoZXJlIHdoaWxlIGFub3RoZXIgY29tcHV0ZXIgc3RhcnRlZCBvbmUgdG9vLgogICAgICAvLyBXaGVyZSB0aGUgc3RvcmUgY2hlY2tzIGZvciBuZXdlciB2ZXJzaW9ucyAodGhlIHBob25lIGFwcCksIGl0IHNheXMKICAgICAgLy8gc28gYW5kIHRoZSB0d28gYXJlIG1lcmdlZDsgb3RoZXJ3aXNlIHRoZSBvdGhlcidzIHZlcnNpb24gaXMKICAgICAgLy8gcmV0aXJlZCwgYXMgYW55IG9sZGVyIHZlcnNpb24gaXMuCiAgICAgIGNvbnN0IGJlZm9yZSA9IGMubm90ZSB8fCAoYy5zY3JhdGNoICYmICFub3Rlc1N0b3JlLmNoZWNrc0NvbmZsaWN0cyA_IE4uc2NyYXRjaE5vdGUgOiBudWxsKTsKICAgICAgYy5kaXJ0eSA9IGZhbHNlOwogICAgICBjLnNhdmluZyA9IHRydWU7CiAgICAgIGRyYXdTdGF0dXMoKTsKICAgICAgbGV0IG5ld2VyID0gbnVsbDsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBzYXZlZCA9IGF3YWl0IG5vdGVzU3RvcmUuc2F2ZShob29rcy5nZXRBY2NvdW50KCksIGJlZm9yZSwgc25hcCk7CiAgICAgICAgY29uc3Qgb2xkS2V5ID0gYy5rZXk7CiAgICAgICAgY29uc3Qgd2FzT3VycyA9ICEhKGJlZm9yZSAmJiBiZWZvcmUub3duKTsKICAgICAgICBjLm5vdGUgPSBzYXZlZDs",
"KICAgICAgICBjLmtleSA9IHNhdmVkLmtleTsKICAgICAgICBjLmJhc2UgPSBzbmFwLmRvYzsKICAgICAgICBjLmJhc2VUaXRsZSA9IHNuYXAudGl0bGU7CiAgICAgICAgYy5zYXZlZEF0ID0gRGF0ZS5ub3coKTsKICAgICAgICBjLmNvbmZsaWN0cyA9IDA7CiAgICAgICAgaWYgKGMuc2NyYXRjaCkgeyBOLnNjcmF0Y2hOb3RlID0gc2F2ZWQ7IE4uc2NyYXRjaEtub3duID0gdHJ1ZTsgfQogICAgICAgIGMuZXJyb3IgPSAnJzsKICAgICAgICBOLm5vdGVzID0gW3NhdmVkLCAuLi5OLm5vdGVzLmZpbHRlcihuID0-IG4ua2V5ICE9PSBvbGRLZXkgJiYgbi5rZXkgIT09IHNhdmVkLmtleSldOwogICAgICAgIC8vIEEgZmlyc3Qgc2F2ZSBpcyBvbmUgbW9yZSBub3RlOiB0aGUgY291bnRzIGJ5IHRoZSBmb2xkZXJzIGNoYW5nZS4KICAgICAgICBpZiAoIWJlZm9yZSkgZHJhd0ZvbGRlcnMoKTsKICAgICAgICBpZiAoIXdhc091cnMgJiYgTi5jdXJyZW50ID09PSBjKSBkcmF3QmFyKCk7CiAgICAgICAgaWYgKCFjLmRpcnR5KSBrZWVwRHJhZnQoYyk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGMuZGlydHkgPSB0cnVlOwogICAgICAgIC8vIFNhdmVkIG9uIGFub3RoZXIgZGV2aWNlIHNpbmNlOiBtZXJnZWQsIHRoZW4gc2F2ZWQgYWdhaW4gLSB1bmxlc3MKICAgICAgICAvLyBpdCBrZWVwcyBoYXBwZW5pbmcsIHdoaWNoIG5lZWRzIGEgcGVyc29uIHRvIGxvb2suCiAgICAgICAgaWYgKGVyci5jb2RlID09PSAnY29uZmxpY3Q",
"nICYmIGVyci5uZXdlciAmJiAoYy5jb25mbGljdHMgPSAoYy5jb25mbGljdHMgfHwgMCkgKyAxKSA8PSAzKSBuZXdlciA9IGVyci5uZXdlcjsKICAgICAgICBlbHNlIGMuZXJyb3IgPSBlcnIuY29kZSA9PT0gJ2NvbmZsaWN0JyA_ICdJdCBrZWVwcyBjaGFuZ2luZyBvbiBhbm90aGVyIGRldmljZS4gVHJ5IGFnYWluIGluIGEgbW9tZW50LicgOiBlcnIubWVzc2FnZTsKICAgICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHN0YXRlRXJyb3IoZXJyKTsKICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBjLnNhdmluZyA9IGZhbHNlOwogICAgICAgIGlmIChOLmN1cnJlbnQgPT09IGMgfHwgTi5zY3JhdGNoID09PSBjKSBkcmF3U3RhdHVzKCk7CiAgICAgICAgZHJhd0xpc3QoKTsKICAgICAgfQogICAgICBpZiAobmV3ZXIpIGFkb3B0TmV3ZXIoYywgbmV3ZXIpOwogICAgfSk7CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIFdoYXRldmVyIGlzIHBlbmRpbmcsIG5vdyAtIGluIHRoZSBvcGVuIG5vdGUgYW5kIGluIHRoZSBzY3JhdGNocGFkLAogIC8vIHdoaWNoIHRoZSBjYWxlbmRhcidzIHRpbGUgbWF5IGhhdmUgY2hhbmdlZC4gQ2FsbGVkIG9uIEN0cmwrUywgb24KICAvLyBzd2l0Y2hpbmcgbm90ZXMgb3IgdGFicywgYW5kIHdoZW4gdGhlIGJvYXJkIGNsb3Nlcy4KICBmdW5jdGlvbiBmbHVzaCgpIHsKICAgIGZvciAoY29uc3QgYyBvZiBuZXcgU2V0KFtOLmN1cnJlbnQsIE4uc2NyYXRjaF0pKSB7CiA",
"gICAgIGlmICghYykgY29udGludWU7CiAgICAgIGNsZWFyVGltZW91dChjLnRpbWVyKTsKICAgICAgaWYgKGMuZGlydHkpIHNhdmUoYyk7CiAgICB9CiAgICByZXR1cm4gTi5jaGFpbjsKICB9CgogIC8vIOKUgOKUgCBUaGUgY2FsZW5kYXIncyBzY3JhdGNocGFkIHRpbGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUaGUgZWlnaHRoIHNwYWNlIGluIHRoZSBjYWxlbmRhcidzIHdlZWsgb2YgdHdvIHJvd3MuIFRoZSBzY3JhdGNocGFkCiAgLy8gaW4gYW4gZWRpdG9yIHdpdGggbm8gdG9vbGJhciAtIGl0cyBrZXlzIGFuZCB0eXBlZCBsaXN0cyBzdGlsbCB3b3JrIC0KICAvLyBlZGl0aW5nIE4uc2NyYXRjaCwgc28gdGhlIHNhdmluZywgbWVyZ2luZyBhbmQgZHJhZnRzIGFyZSB0aGUgb25lcwogIC8vIGFib3ZlLiBUaGUgdGlsZSBhbmQgdGhlIG5vdGVzIGFyZSBuZXZlciBvbiBzY3JlZW4gdG9nZXRoZXIsIHNvIGVhY2gKICAvLyB0YWtlcyB1cCB3aGF0IHRoZSBvdGhlciBjaGFuZ2VkIHdoZW4gaXQgaXMgc2hvd24gKFQuc3RhbGUsCiAgLy8gZWxzLmVkU3RhbGUpLiBCdWlsdCBvbmNlIGFuZCBrZXB0LCBsaWtlIHRoZSBub3RlcycgZWxlbWVudDogdGhlCiAgLy8gY2FsZW5kYXIgbW92ZXMgaXQgaW50byBlYWNoIHdlZWsgaXQgZHJhd3Mgd2l0aG91dCByZWJ1aWx",
"kaW5nIGl0LCBzbwogIC8vIGEgcmVkcmF3IG5ldmVyIHRha2VzIHRoZSB0ZXh0IGJveCBmcm9tIHVuZGVyIHNvbWVvbmUgdHlwaW5nLgoKICBmdW5jdGlvbiBzY3JhdGNoVGlsZSgpIHsKICAgIGlmICghVC5lbCkgewogICAgICBULnN0YXR1cyA9IGgoJ3NwYW4nLCB7IGNsYXNzOiAnbmUtc3RhdHVzJyB9KTsKICAgICAgVC5ib2R5ID0gaCgnZGl2JywgeyBjbGFzczogJ3NjcmF0Y2gtdGlsZS1ib2R5JyB9KTsKICAgICAgVC5lbCA9IGgoJ3NlY3Rpb24nLCB7CiAgICAgICAgY2xhc3M6ICdkYXkgc2NyYXRjaC10aWxlJywgcm9sZTogJ2xpc3RpdGVtJywgJ2FyaWEtbGFiZWwnOiBub3Rlc0xvZ2ljLlNDUkFUQ0hQQURfVElUTEUsCiAgICAgICAgLy8gQ3RybCtTIHNhdmVzIGhlcmUgdG9vLCByYXRoZXIgdGhhbiBDaHJvbWUncyAiU2F2ZSBwYWdlIGFzIi4KICAgICAgICBvbmtleWRvd246IGUgPT4gewogICAgICAgICAgaWYgKChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5KSAmJiAhZS5hbHRLZXkgJiYgZS5rZXkudG9Mb3dlckNhc2UoKSA9PT0gJ3MnKSB7CiAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgICAgICAgZmx1c2goKTsKICAgICAgICAgIH0KICAgICAgICB9LAogICAgICB9LAogICAgICBoKCdoZWFkZXInLCB7IGNsYXNzOiAnZGF5LWhlYWQnIH0sCiAgICAgICAgaWNvbignZWRpdCcsIDE2KSwgaCgnc3BhbicsIHsgY2xhc3M6ICdkbmFtZScsIHRleHQ6IG5vdGVzTG9naWMuU0NSQVRDSFBBRF9USVR",
"MRSB9KSwgVC5zdGF0dXMpLAogICAgICBULmJvZHkpOwogICAgfQogICAgc2NyYXRjaFN0YXRlKCk7CiAgICBsb2FkKCk7IC8vIG9ubHkgaWYgdGhlIGxpc3QgaXMgbW9yZSB0aGFuIGEgbWludXRlIG9sZDogbmV3ZXIgdmVyc2lvbnMgZnJvbSBlbHNld2hlcmUKICAgIHJlYWR5U2NyYXRjaCgpOwogICAgaWYgKFQuZm9yICE9PSBOLnNjcmF0Y2ggfHwgVC5zdGFsZSB8fCAhVC5lZCkgZHJhd1RpbGUoKTsKICAgIGRyYXdTdGF0dXMoKTsKICAgIHJldHVybiBULmVsOwogIH0KCiAgZnVuY3Rpb24gZHJhd1RpbGUoKSB7CiAgICBjb25zdCBzID0gTi5zY3JhdGNoOwogICAgaWYgKCFULmVsIHx8ICFzKSByZXR1cm47CiAgICBpZiAoVC5lZCkgVC5lZC5kZXN0cm95KCk7CiAgICBjb25zdCBlZCA9IG5zLm5vdGVFZGl0b3IuY3JlYXRlKHsKICAgICAgcm9vdDogTi5jdHgucm9vdCwKICAgICAgb25DaGFuZ2U6ICgpID0-IHsKICAgICAgICBlZGl0ZWQocywgeyBkb2M6IGVkLmdldERvYygpIH0pOwogICAgICAgIGlmIChzID09PSBOLmN1cnJlbnQpIGVscy5lZFN0YWxlID0gdHJ1ZTsKICAgICAgfSwKICAgIH0pOwogICAgVC5lZCA9IGVkOwogICAgVC5mb3IgPSBzOwogICAgVC5zdGFsZSA9IGZhbHNlOwogICAgZWQuc2V0RG9jKHMuZG9jIHx8IGZtdC5lbXB0eURvYygpKTsKICAgIGVkLnNldEVkaXRhYmxlKHMuYm9keVN0YXRlID09PSAncmVhZHknLAogICAgICBzLmJvZHlTdGF0ZSA9PT0gJ2xvYWRpbmcnID8gJ0xvYWRpbmfigKY",
"nIDogcy5ib2R5U3RhdGUgPT09ICdlcnJvcicgPyBgQ291bGRu4oCZdCBsb2FkIHRoZSBzY3JhdGNocGFkOiAke3MuZXJyb3J9YAogICAgICAgIDogJ0pvdCBhbnl0aGluZyBkb3duLiBJdCBzYXZlcyBhcyB5b3UgdHlwZS4nKTsKICAgIFQuYm9keS5yZXBsYWNlQ2hpbGRyZW4oZWQubGlua2JhciwgZWQudGFibGViYXIsIGVkLmVsZW1lbnQpOwogICAgZHJhd1N0YXR1cygpOwogIH0KCiAgLy8g4pSA4pSAIE90aGVyIGFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIG9wZW5JbkdtYWlsKGMpIHsKICAgIGF3YWl0IGZsdXNoKCk7CiAgICBpZiAoIWMubm90ZSB8fCAhYy5ub3RlLnRocmVhZElkKSByZXR1cm47CiAgICBOLmN0eC5jbG9zZUJvYXJkKCk7CiAgICBob29rcy5vcGVuVGhyZWFkKGMubm90ZS50aHJlYWRJZCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBkZWxldGVDdXJyZW50KCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmICghYyB8fCBjLnNjcmF0Y2gpIHJldHVybjsKICAgIGNsZWFyVGltZW91dChjLnRpbWVyKTsKICAgIGF3YWl0IE4uY2hhaW47CiAgICBOLmN1cnJlbnQgPSBudWxsOwogICAgc2hvd1NjcmF0Y2goKTsKICA",
"gIGNvbnN0IG5vdGUgPSBjLm5vdGU7CiAgICBpZiAoIW5vdGUpIHsgZHJhd0xpc3QoKTsgcmV0dXJuOyB9IC8vIG5ldmVyIHNhdmVkOiBub3RoaW5nIGluIEdtYWlsCgogICAgY29uc3QgYXQgPSBOLm5vdGVzLmZpbmRJbmRleChuID0-IG4ua2V5ID09PSBub3RlLmtleSk7CiAgICBOLm5vdGVzID0gTi5ub3Rlcy5maWx0ZXIobiA9PiBuLmtleSAhPT0gbm90ZS5rZXkpOwogICAgZHJhd0xpc3QoKTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IG5vdGVzU3RvcmUucmV0aXJlKG5vdGUpOwogICAgICB0b2FzdChOLmN0eC5yb290LCBub3RlLm93bgogICAgICAgID8gJ05vdGUgbW92ZWQgdG8gR21haWzigJlzIFRyYXNoLicKICAgICAgICA6IGBUYWtlbiBvZmYgdGhlIG5vdGVzIGxpc3QuIFRoZSBlbWFpbCBzdGF5cyBpbiBHbWFpbC5gLCB7CiAgICAgICAgYWN0aW9uOiB7IGxhYmVsOiAnVW5kbycsIG9uQ2xpY2s6ICgpID0-IHVuZG9EZWxldGUobm90ZSwgYXQpIH0sCiAgICAgICAgdGltZW91dDogODAwMCwKICAgICAgfSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgTi5ub3Rlcy5zcGxpY2UoTWF0aC5tYXgoMCwgYXQpLCAwLCBub3RlKTsKICAgICAgZHJhd0xpc3QoKTsKICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgZGVsZXRlIOKAnCR7bm90ZS50aXRsZX3igJ06ICR7ZXJyLm1lc3NhZ2V9YCwgeyBraW5kOiAnZXJyb3InIH0pOwogICAgfQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gdW5kb0RlbGV0ZShub3R",
"lLCBhdCkgewogICAgdHJ5IHsKICAgICAgYXdhaXQgbm90ZXNTdG9yZS5yZXN0b3JlKG5vdGUpOwogICAgICBOLm5vdGVzLnNwbGljZShNYXRoLm1heCgwLCBNYXRoLm1pbihhdCwgTi5ub3Rlcy5sZW5ndGgpKSwgMCwgbm90ZSk7CiAgICAgIGRyYXdMaXN0KCk7CiAgICAgIG9wZW5Ob3RlKG5vdGUsIHsgZm9yY2U6IHRydWUgfSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgdG9hc3QoTi5jdHgucm9vdCwgYENvdWxkbuKAmXQgYnJpbmcgaXQgYmFjazogJHtlcnIubWVzc2FnZX0uIEl0IGlzIHN0aWxsIGluIEdtYWls4oCZcyBUcmFzaC5gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICB9CiAgfQoKICAvLyBDdHJsK1MgKOKMmFMpIHNhdmVzIG5vdyBpbnN0ZWFkIG9mIENocm9tZSdzICJTYXZlIHBhZ2UgYXMiLgogIGZ1bmN0aW9uIGhhbmRsZUtleShlKSB7CiAgICBpZiAoKGUuY3RybEtleSB8fCBlLm1ldGFLZXkpICYmICFlLmFsdEtleSAmJiBlLmtleS50b0xvd2VyQ2FzZSgpID09PSAncycpIHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBmbHVzaCgpOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0KICAgIGlmIChlLmtleSA9PT0gJ0YzJyAmJiBOLnRlcm1zLmxlbmd0aCAmJiBlbHMuZWQpIHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBzdGVwTWF0Y2goZS5zaGlmdEtleSA_IC0xIDogMSk7CiAgICAgIHJldHVybiB0cnVlOwogICAgfQogICAgcmV0dXJuIGZhbHNlOwogIH0KCiAgLy8gQ2F",
"sbGVkIGV2ZXJ5IGZldyBzZWNvbmRzIHdoaWxlIHRoZSBib2FyZCBpcyBvcGVuLCBmb3IgIlNhdmVkIDVzIGFnbyIuCiAgZnVuY3Rpb24gdGljaygpIHsKICAgIGRyYXdTdGF0dXMoKTsKICB9CgogIC8vIFR5cGluZyBnb2VzIHN0cmFpZ2h0IGludG8gdGhlIHNjcmF0Y2hwYWQgLSBvciwgd2l0aCBhbm90aGVyIG5vdGUKICAvLyBvcGVuLCBpbnRvIHRoYXQuCiAgZnVuY3Rpb24gZm9jdXNEZWZhdWx0KCkgewogICAgY29uc3QgYyA9IE4uY3VycmVudDsKICAgIGlmIChjICYmIGMuc2NyYXRjaCkgewogICAgICBOLndhbnRGb2N1cyA9IHRydWU7CiAgICAgIHNjcmF0Y2hSZWFkeSgpOwogICAgfSBlbHNlIGlmIChjKSBmb2N1c0ZpZWxkKGMuYm9keVN0YXRlID09PSAncmVhZHknICYmIGMudGl0bGUgPyAnbm90ZS1ib2R5JyA6ICdub3RlLXRpdGxlJyk7CiAgICBlbHNlIGlmIChlbHMuc2VhcmNoKSBlbHMuc2VhcmNoLmZvY3VzKCk7CiAgfQoKICBucy5ub3RlcyA9IHsKICAgIGluaXQsIGVsZW1lbnQsIGxvYWQsIGlzU3RhbGUsIGZsdXNoLCBoYW5kbGVLZXksIHRpY2ssIGZvY3VzRGVmYXVsdCwgY2xvc2VOb3RlLCBiYWNrLCBkZXB0aCwgc2NyYXRjaEZvdW5kLCBzY3JhdGNoVGlsZSwKICAgIC8vIEEgbm90ZSBvdGhlciB0aGFuIHRoZSBzY3JhdGNocGFkLgogICAgaXNPcGVuOiAoKSA9PiAhIShOLmN1cnJlbnQgJiYgIU4uY3VycmVudC5zY3JhdGNoKSwKICAgIGxvYWRlZEF0OiAoKSA9PiBOLmxvYWRlZEF0LAogICAgaXNMb2F",
"kaW5nOiAoKSA9PiAhIU4ubG9hZGluZywKICB9Owp9KSgpOwo\"],[\"src/content/calendar-store.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIENhbGVuZGFyIGRhdGEKLy8KLy8gR29vZ2xlIENhbGVuZGFyJ3MgZXZlbnRzIGFuZCBHb29nbGUgVGFza3MnIHRhc2tzLCByZWFkIHRocm91Z2ggdGhlCi8vIGJhY2tncm91bmQgd29ya2VyIHdpdGggdGhlIGNhbGVuZGFyJ3Mgb3duIHNpZ24taW4gKG9yLCBpbiB0aGUgcGhvbmUKLy8gYXBwLCB0aHJvdWdoIGl0cyBzY3JpcHQpLiBUd28ga2luZHMgb2YgcmVhZDogdGhlIHNvdXJjZXMgLSB3aGljaAovLyBjYWxlbmRhcnMgYW5kIHRhc2sgbGlzdHMgdGhlcmUgYXJlIC0ga2VwdCBmb3IgdGVuIG1pbnV0ZXMsIGFuZCB3aGF0IGlzCi8vIG9uIGluIGEgcmFuZ2Ugb2YgZGF5cywgZm9yIHRoZSBzb3VyY2VzIHRoYXQgYXJlIHN3aXRjaGVkIG9uLgovLwovLyBUcm91YmxlIHdpdGggdGhlIHNpZ24taW4gaXMgdGhyb3duLCBmb3IgdGhlIHZpZXcncyBwYW5lbDsgdHJvdWJsZSB3aXRoCi8vIG9uZSBzZXJ2aWNlIChUYXNrcyBub3QgYWxsb3d",
"lZCwgc2F5KSBjb21lcyBiYWNrIHdpdGggdGhlIHJlc3QsIHNvIGEKLy8gY2FsZW5kYXIgc3RpbGwgc2hvd3Mgd2hlbiB0aGUgdGFza3MgY2Fubm90LgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCBjYWwgPSBucy5jYWxlbmRhckxvZ2ljOwoKICBjb25zdCBTT1VSQ0VTX01TID0gMTAgKiA2MCAqIDEwMDA7CgogIC8vIENvZGVzIHRoYXQgYXJlIGFib3V0IHRoZSBzaWduLWluLCBub3QgYWJvdXQgb25lIGNhbGVuZGFyIG9yIGxpc3QuCiAgY29uc3QgU0lHTl9JTiA9IG5ldyBTZXQoWydub3RfY29uZmlndXJlZCcsICdjYWxlbmRhcl9hdXRoX3JlcXVpcmVkJywgJ2NhbGVuZGFyX21pc21hdGNoJywgJ2V4dGVuc2lvbl9yZWxvYWRlZCddKTsKCiAgY29uc3QgUyA9IHsKICAgIGFjY291bnQ6ICcnLAogICAgc291cmNlczogbnVsbCwgICAvLyBjYWxlbmRhckxvZ2ljLnNvdXJjZXMoKQogICAgZXJyb3JzOiB7fSwgICAgICAvLyBzZXJ",
"2aWNlIOKGkiBlcnJvciwgZnJvbSB0aGUgbGFzdCBzb3VyY2VzIHJlYWQKICAgIGF0OiAwLAogIH07CgogIGZ1bmN0aW9uIHRocm93U2lnbkluKHJlc3VsdHMpIHsKICAgIGNvbnN0IGJhZCA9IHJlc3VsdHMuZmluZChyID0-IHIgJiYgci5lcnJvciAmJiBTSUdOX0lOLmhhcyhyLmVycm9yLmNvZGUpKTsKICAgIGlmIChiYWQpIHRocm93IGJhZC5lcnJvcjsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKGFjY291bnQsIHsgZm9yY2UgPSBmYWxzZSB9ID0ge30pIHsKICAgIGlmIChTLmFjY291bnQgIT09IGFjY291bnQpIHsKICAgICAgUy5hY2NvdW50ID0gYWNjb3VudDsKICAgICAgUy5zb3VyY2VzID0gbnVsbDsKICAgIH0KICAgIGlmICghZm9yY2UgJiYgUy5zb3VyY2VzICYmIERhdGUubm93KCkgLSBTLmF0IDwgU09VUkNFU19NUykgcmV0dXJuIHsgc291cmNlczogUy5zb3VyY2VzLCBlcnJvcnM6IFMuZXJyb3JzIH07CiAgICBjb25zdCBbY2FsZW5kYXJzLCBsaXN0c10gPSBhd2FpdCBucy5hcGkuZ29vZ2xlTWFueShjYWwuc291cmNlUmVxdWVzdHMoKSk7CiAgICB0aHJvd1NpZ25JbihbY2FsZW5kYXJzLCBsaXN0c10pOwogICAgY29uc3QgZXJyb3JzID0ge307CiAgICBpZiAoY2FsZW5kYXJzLmVycm9yKSBlcnJvcnMuY2FsZW5kYXIgPSBjYWxlbmRhcnMuZXJyb3I7CiAgICBpZiAobGlzdHMuZXJyb3IpIGVycm9ycy50YXNrcyA9IGxpc3RzLmVycm9yOwogICAgLy8gQSBzZXJ2aWNlIHRoYXQgZmFpbGVkIHR",
"oaXMgdGltZSBrZWVwcyB0aGUgc291cmNlcyBpdCBoYWQuCiAgICBjb25zdCBrZXB0ID0ga2luZCA9PiAoUy5zb3VyY2VzIHx8IFtdKS5maWx0ZXIocyA9PiBzLmtpbmQgPT09IGtpbmQpOwogICAgY29uc3QgZnJlc2ggPSBjYWwuc291cmNlcyhjYWxlbmRhcnMuZXJyb3IgPyBbXSA6IGNhbGVuZGFycy5pdGVtcywgbGlzdHMuZXJyb3IgPyBbXSA6IGxpc3RzLml0ZW1zKTsKICAgIFMuc291cmNlcyA9IFsKICAgICAgLi4uKGNhbGVuZGFycy5lcnJvciA_IGtlcHQoJ2NhbGVuZGFyJykgOiBmcmVzaC5maWx0ZXIocyA9PiBzLmtpbmQgPT09ICdjYWxlbmRhcicpKSwKICAgICAgLi4uKGxpc3RzLmVycm9yID8ga2VwdCgndGFza3MnKSA6IGZyZXNoLmZpbHRlcihzID0-IHMua2luZCA9PT0gJ3Rhc2tzJykpLAogICAgXTsKICAgIFMuZXJyb3JzID0gZXJyb3JzOwogICAgUy5hdCA9IERhdGUubm93KCk7CiAgICByZXR1cm4geyBzb3VyY2VzOiBTLnNvdXJjZXMsIGVycm9ycyB9OwogIH0KCiAgLy8gV2hhdCBpcyBvbiBmcm9tIHJhbmdlLnN0YXJ0IHVwIHRvIHJhbmdlLmVuZCwgZnJvbSB0aGUgZ2l2ZW4gc291cmNlcy4KICBhc3luYyBmdW5jdGlvbiBsb2FkUmFuZ2UocmFuZ2UsIHNvdXJjZXMpIHsKICAgIGNvbnN0IGNhbGVuZGFycyA9IHNvdXJjZXMuZmlsdGVyKHMgPT4gcy5raW5kID09PSAnY2FsZW5kYXInKTsKICAgIGNvbnN0IGxpc3RzID0gc291cmNlcy5maWx0ZXIocyA9PiBzLmtpbmQgPT09ICd0YXNrcycpOwogICAgY29",
"uc3QgcmVzdWx0cyA9IGF3YWl0IG5zLmFwaS5nb29nbGVNYW55KGNhbC5yYW5nZVJlcXVlc3RzKHJhbmdlLCBjYWxlbmRhcnMsIGxpc3RzKSk7CiAgICB0aHJvd1NpZ25JbihyZXN1bHRzKTsKCiAgICBjb25zdCBpdGVtcyA9IFtdOwogICAgY29uc3QgZXJyb3JzID0ge307CiAgICBsZXQgaSA9IDA7CiAgICBmb3IgKGNvbnN0IGMgb2YgY2FsZW5kYXJzKSB7CiAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2krK107CiAgICAgIGlmIChyLmVycm9yKSB7IGVycm9ycy5jYWxlbmRhciA9IGVycm9ycy5jYWxlbmRhciB8fCByLmVycm9yOyBjb250aW51ZTsgfQogICAgICBmb3IgKGNvbnN0IGV2IG9mIHIuaXRlbXMgfHwgW10pIHsKICAgICAgICBjb25zdCBpdGVtID0gY2FsLmV2ZW50SXRlbShldiwgYyk7CiAgICAgICAgaWYgKGl0ZW0pIGl0ZW1zLnB1c2goaXRlbSk7CiAgICAgIH0KICAgIH0KICAgIGZvciAoY29uc3QgbCBvZiBsaXN0cykgewogICAgICBmb3IgKGxldCBwYXNzID0gMDsgcGFzcyA8IDI7IHBhc3MrKykgewogICAgICAgIGNvbnN0IHIgPSByZXN1bHRzW2krK107CiAgICAgICAgaWYgKHIuZXJyb3IpIHsgZXJyb3JzLnRhc2tzID0gZXJyb3JzLnRhc2tzIHx8IHIuZXJyb3I7IGNvbnRpbnVlOyB9CiAgICAgICAgZm9yIChjb25zdCB0IG9mIHIuaXRlbXMgfHwgW10pIHsKICAgICAgICAgIGNvbnN0IGl0ZW0gPSBjYWwudGFza0l0ZW0odCwgbCk7CiAgICAgICAgICBpZiAoaXRlbSkgaXRlbXMucHVzaChpdGVtKTsKICA",
"gICAgICB9CiAgICAgIH0KICAgIH0KICAgIHJldHVybiB7IGl0ZW1zOiBjYWwudW5pcXVlQnlJZChpdGVtcyksIGVycm9ycyB9OwogIH0KCiAgZnVuY3Rpb24gZm9yZ2V0KCkgewogICAgUy5zb3VyY2VzID0gbnVsbDsKICAgIFMuYXQgPSAwOwogIH0KCiAgLy8g4pSA4pSAIENoYW5nZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBPbmUgZXZlbnQgb3IgdGFzayBhdCBhIHRpbWUsIHRocm91Z2ggdGhlIHdvcmtlciAob3IgdGhlIGFwcCdzIHNjcmlwdCksCiAgLy8gd2hpY2ggbGV0cyB0aHJvdWdoIG9ubHkgdGhlc2UuIEFuIGV2ZW50IGdvZXMgd2l0aCB0aGUgdmVyc2lvbiBpdCB3YXMKICAvLyByZWFkIGF0LCBzbyBvbmUgY2hhbmdlZCBpbiBHb29nbGUgbWVhbndoaWxlIGlzIHJlZnVzZWQgKCJjaGFuZ2VkIikKICAvLyByYXRoZXIgdGhhbiBvdmVyd3JpdHRlbiAtIG9yIGRlbGV0ZWQgdW5zZWVuLgoKICBjb25zdCB3cml0ZSA9IChzZXJ2aWNlLCBtZXRob2QsIHBhdGgsIGJvZHksIGV0YWcpID0-IG5zLmFwaS5nb29nbGVXcml0ZShzZXJ2aWNlLCBtZXRob2QsIHBhdGgsIGJvZHksIGV0YWcpOwoKICBmdW5jdGlvbiB0aWNrKGl0ZW0sIGR",
"vbmUpIHsKICAgIHJldHVybiB3cml0ZSgndGFza3MnLCAnUEFUQ0gnLCBjYWwudGFza1BhdGgoaXRlbSksIGNhbC50aWNrQm9keShkb25lKSk7CiAgfQoKICAvLyBgc3RhcnRNaW5gOiBkcm9wcGVkIGF0IGEgdGltZSBvZiBkYXkgaW4gdGhlIHdlZWsgYnkgdGhlIGhvdXIuCiAgZnVuY3Rpb24gbW92ZShpdGVtLCBmcm9tRGF5LCB0b0RheSwgdGltZVpvbmUsIHN0YXJ0TWluKSB7CiAgICBjb25zdCBib2R5ID0gY2FsLm1vdmVCb2R5KGl0ZW0sIGZyb21EYXksIHRvRGF5LCB0aW1lWm9uZSwgc3RhcnRNaW4pOwogICAgcmV0dXJuIGl0ZW0ua2luZCA9PT0gJ3Rhc2snCiAgICAgID8gd3JpdGUoJ3Rhc2tzJywgJ1BBVENIJywgY2FsLnRhc2tQYXRoKGl0ZW0pLCBib2R5KQogICAgICA6IHdyaXRlKCdjYWxlbmRhcicsICdQQVRDSCcsIGNhbC5ldmVudFBhdGgoaXRlbSksIGJvZHksIGl0ZW0uZXRhZyk7CiAgfQoKICAvLyBJdHMgYm90dG9tIGVkZ2UgZHJhZ2dlZCBpbiB0aGUgd2VlayBieSB0aGUgaG91cjogYSBuZXcgZW5kLgogIGZ1bmN0aW9uIHJlc2l6ZShpdGVtLCBlbmQsIHRpbWVab25lKSB7CiAgICByZXR1cm4gd3JpdGUoJ2NhbGVuZGFyJywgJ1BBVENIJywgY2FsLmV2ZW50UGF0aChpdGVtKSwgY2FsLnJlc2l6ZUJvZHkoaXRlbSwgZW5kLCB0aW1lWm9uZSksIGl0ZW0uZXRhZyk7CiAgfQoKICAvLyBXaGF0IHRoZSBlZGl0b3IgaG9sZHM6IGEgY2hhbmdlIHRvIGBpdGVtYCwgb3IgYSBuZXcgb25lIHdoZW4gdGhlcmUgaXM",
"KICAvLyBub25lLiBBIGRyYWZ0IHRoYXQgd2lsbCBub3QgZG8gaXMgcmVmdXNlZCBoZXJlLCBiZWZvcmUgR29vZ2xlIGlzIGFza2VkLgogIC8vIGByZWN1cnJlbmNlYDogYW4gZXZlbnQncyBydWxlIGxpbmVzLCB3aGVuIHRoZXkgYXJlIHRvIGJlIHNldC4KICBmdW5jdGlvbiBzYXZlKGl0ZW0sIGRyYWZ0LCB0aW1lWm9uZSwgcmVjdXJyZW5jZSkgewogICAgY29uc3QgbWFkZSA9IGRyYWZ0LmtpbmQgPT09ICd0YXNrJyA_IGNhbC50YXNrQm9keShkcmFmdCwgeyBwYXRjaDogISFpdGVtIH0pCiAgICAgIDogY2FsLmV2ZW50Qm9keShkcmFmdCwgdGltZVpvbmUsIHsgcGF0Y2g6ICEhaXRlbSwgcmVjdXJyZW5jZSB9KTsKICAgIGlmIChtYWRlLmVycm9yKSByZXR1cm4gUHJvbWlzZS5yZWplY3QoT2JqZWN0LmFzc2lnbihuZXcgRXJyb3IobWFkZS5lcnJvciksIHsgY29kZTogJ2ludmFsaWQnIH0pKTsKICAgIGlmIChkcmFmdC5raW5kID09PSAndGFzaycpIHsKICAgICAgcmV0dXJuIGl0ZW0gPyB3cml0ZSgndGFza3MnLCAnUEFUQ0gnLCBjYWwudGFza1BhdGgoaXRlbSksIG1hZGUuYm9keSkgOiB3cml0ZSgndGFza3MnLCAnUE9TVCcsIGNhbC50YXNrc1BhdGgoZHJhZnQuc291cmNlKSwgbWFkZS5ib2R5KTsKICAgIH0KICAgIHJldHVybiBpdGVtID8gd3JpdGUoJ2NhbGVuZGFyJywgJ1BBVENIJywgY2FsLmV2ZW50UGF0aChpdGVtKSwgbWFkZS5ib2R5LCBpdGVtLmV0YWcpCiAgICAgIDogd3JpdGUoJ2NhbGVuZGFyJywgJ1BPU1Q",
"nLCBjYWwuZXZlbnRzUGF0aChkcmFmdC5zb3VyY2UpLCBtYWRlLmJvZHkpOwogIH0KCiAgLy8gT25lIGV2ZW50IChvbmUgb2NjdXJyZW5jZSBvZiBhIHJlcGVhdGluZyBvbmUpIG9yIG9uZSB0YXNrIC0gbmV2ZXIgbW9yZS4KICBmdW5jdGlvbiByZW1vdmUoaXRlbSkgewogICAgcmV0dXJuIGl0ZW0ua2luZCA9PT0gJ3Rhc2snCiAgICAgID8gd3JpdGUoJ3Rhc2tzJywgJ0RFTEVURScsIGNhbC50YXNrUGF0aChpdGVtKSkKICAgICAgOiB3cml0ZSgnY2FsZW5kYXInLCAnREVMRVRFJywgY2FsLmV2ZW50UGF0aChpdGVtKSwgdW5kZWZpbmVkLCBpdGVtLmV0YWcpOwogIH0KCiAgLy8g4pSA4pSAIEEgcmVwZWF0aW5nIGV2ZW50J3Mgc2VyaWVzIOKUgOKUgAogIC8vCiAgLy8gQW4gb2NjdXJyZW5jZSBuYW1lcyBpdHMgc2VyaWVzOyBHb29nbGUncyBldmVudCBmb3IgdGhlIHNlcmllcyBob2xkcwogIC8vIHRoZSBydWxlLCB0aGUgZmlyc3QgZGF5IGFuZCB0aGUgdmVyc2lvbi4gQSBjaGFuZ2Ugb3IgYSBkZWxldGUgZm9yIGFsbAogIC8vIGV2ZW50cyBnb2VzIHRvIHRoZSBzZXJpZXMsIGF0IHRoYXQgdmVyc2lvbi4KCiAgY29uc3Qgc2VyaWVzUGF0aCA9IChpdGVtLCBzZXJpZXMpID0-IGNhbC5ldmVudFBhdGgoeyBzb3VyY2U6IGl0ZW0uc291cmNlLCBldmVudElkOiBzZXJpZXMgPyBzZXJpZXMuaWQgOiBpdGVtLnNlcmllc0lkIH0pOwoKICBhc3luYyBmdW5jdGlvbiBzZXJpZXMoaXRlbSkgewogICAgY29uc3QgW3JdID0gYXdhaXQ",
"gbnMuYXBpLmdvb2dsZU1hbnkoW1snY2FsZW5kYXInLCBzZXJpZXNQYXRoKGl0ZW0pLCB7fV1dKTsKICAgIGlmICghciB8fCByLmVycm9yKSB0aHJvdyAociAmJiByLmVycm9yKSB8fCBuZXcgRXJyb3IoJ0dvb2dsZSBkaWQgbm90IGFuc3dlci4nKTsKICAgIHJldHVybiByOwogIH0KCiAgLy8gVGhlIG9jY3VycmVuY2UncyBkcmFmdCwgZm9yIHRoZSB3aG9sZSBzZXJpZXMsIHdpdGggYHJ1bGVgICgnJyB0byBzdG9wCiAgLy8gaXQgcmVwZWF0aW5nKSBpbiBwbGFjZSBvZiB0aGUgc2VyaWVzJyBvd24uCiAgZnVuY3Rpb24gc2F2ZVNlcmllcyhzLCBpdGVtLCBkcmFmdCwgcnVsZSwgdGltZVpvbmUpIHsKICAgIGNvbnN0IGQgPSBjYWwuc2VyaWVzRHJhZnQoY2FsLnN0YXJ0RGF5T2YocyksIGl0ZW0uZmlyc3QsIGRyYWZ0KTsKICAgIGNvbnN0IG1hZGUgPSBjYWwuZXZlbnRCb2R5KGQsIHRpbWVab25lLCB7IHBhdGNoOiB0cnVlLCByZWN1cnJlbmNlOiBjYWwucmVjdXJyZW5jZVdpdGgocy5yZWN1cnJlbmNlLCBydWxlKSB9KTsKICAgIGlmIChtYWRlLmVycm9yKSByZXR1cm4gUHJvbWlzZS5yZWplY3QoT2JqZWN0LmFzc2lnbihuZXcgRXJyb3IobWFkZS5lcnJvciksIHsgY29kZTogJ2ludmFsaWQnIH0pKTsKICAgIHJldHVybiB3cml0ZSgnY2FsZW5kYXInLCAnUEFUQ0gnLCBzZXJpZXNQYXRoKGl0ZW0sIHMpLCBtYWRlLmJvZHksIHMuZXRhZyk7CiAgfQoKICBmdW5jdGlvbiByZW1vdmVTZXJpZXMocywgaXRlbSkgewogICAgcmV",
"0dXJuIHdyaXRlKCdjYWxlbmRhcicsICdERUxFVEUnLCBzZXJpZXNQYXRoKGl0ZW0sIHMpLCB1bmRlZmluZWQsIHMuZXRhZyk7CiAgfQoKICBucy5jYWxlbmRhclN0b3JlID0geyBsb2FkU291cmNlcywgbG9hZFJhbmdlLCBmb3JnZXQsIHRpY2ssIG1vdmUsIHJlc2l6ZSwgc2F2ZSwgcmVtb3ZlLCBzZXJpZXMsIHNhdmVTZXJpZXMsIHJlbW92ZVNlcmllcywgU0lHTl9JTiB9Owp9KSgpOwo\"],[\"src/content/calendar.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBjYWxlbmRhciB2aWV3Ci8vCi8vIFRoZSBib2FyZCdzIHRoaXJkIHRhYjogR29vZ2xlIENhbGVuZGFyJ3MgZXZlbnRzIHdpdGggR29vZ2xlIFRhc2tzJwovLyB0YXNrcyBhbW9uZyB0aGVtLCBkYXkgYnkgZGF5LCBjaGFuZ2VkIGhlcmUgYW5kIGluIEdvb2dsZSBhbGlrZS4KLy8KLy8gT24gYSBjb21wdXRlciB0aGVyZSBhcmUgdGhyZWUgdmlld3MgLSBXZWVrIChieSB0aGUgaG91ciwgYXMgaW4gR29vZ2xlCi8vIENhbGVuZGFyLCBvciB0d28gcm93czogTW9uZGF5IHRvIFRodXJzZGF5IGFib3ZlIEZyaWRheSB0b",
"yBTdW5kYXkgYW5kCi8vIHRoZSBzY3JhdGNocGFkLCBhdCB0aGUgY2xpY2sgb2YgYSBidXR0b24gYmVzaWRlIHRoZSB2aWV3cyksIE1vbnRoIGFuZAovLyBBZ2VuZGEgKGZvdXIgd2Vla3MgYXMgb25lIGxpc3QpIC0gYmVzaWRlIGEgc21hbGwgbW9udGgsIHRoZSBjYWxlbmRhcnMKLy8gYW5kIHRhc2sgbGlzdHMgdG8gc2hvdyBvciBoaWRlLCBhbmQgdGhlIHRhc2tzIHdpdGggbm8gZGF0ZS4gTmFycm93LCBhcwovLyBvbiBhIHBob25lLCBpdCBpcyB0aGUgd2VlayAtIHR3byBjb2x1bW5zIG9mIGRheXMgd2l0aCB0aGUgbW9udGggYXMgdGhlCi8vIGVpZ2h0aCB0aWxlIC0gb3IgdGhlIG1vbnRoLCBhIGdyaWQgb2YgZGF5cyB3aXRoIGEgZmV3IGxpbmVzIGVhY2gsIGEgdGFwCi8vIG9uIGEgZGF5IG9wZW5pbmcgaXRzIHdlZWs7IHRoZSBzb3VyY2VzIGFyZSBhIHJvdyBvZiBjaGlwcyBhYm92ZSwgYW5kCi8vIHRoZSB0YXNrcyB3aXRoIG5vIGRhdGUgYmVsb3cuIEEgc3dpcGUgZ29lcyB0byB0aGUgbmV4dCBvciBwcmV2aW91cyB3ZWVrCi8vIG9yIG1vbnRoLCBhbmQgaW4gdGhlIHdlZWsgYSBidXR0b24gdHVybnMgdGhlIG9yZGVyIG9mIHRoZSBkYXlzIGZyb20KLy8gZG93bi10aGVuLWFjcm9zcyB0byBhY3Jvc3MtdGhlbi1kb3duLgovLwovLyBLZXlzLCBhcyBpbiBHb29nbGUgQ2FsZW5kYXI6IHQgdG9kYXksIGogLyBuIG5leHQsIGsgLyBwIHByZXZpb3VzLAovLyB3IC8gbSAvIGEgZm9yIHRoZSB2aWV3cy4KLy8KLy8gVGhlI",
"GJvYXJkIG93bnMgdGhlIG92ZXJsYXksIHRoZSBoZWFkZXIgYW5kIHRoZSBhY2NvdW50IHBhbmVsczsgdGhpcwovLyBmaWxlIG93bnMgdGhlIGJvZHkgd2hpbGUgdGhlIENhbGVuZGFyIHRhYiBpcyBzaG93aW5nLiBJdHMgZWxlbWVudCBpcwovLyBidWlsdCBvbmNlIGFuZCBrZXB0LCBsaWtlIHRoZSBub3RlcycuCi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKKGZ1bmN0aW9uICgpIHsKICAndXNlIHN0cmljdCc7CgogIGNvbnN0IG5zID0gKGdsb2JhbFRoaXMuZ2tiID0gZ2xvYmFsVGhpcy5na2IgfHwge30pOwogIGNvbnN0IHsgaCwgaWNvbiwgdG9hc3QgfSA9IG5zLnVpOwogIGNvbnN0IHsgY2FsZW5kYXJTdG9yZTogc3RvcmUsIGhvb2tzLCBBUFBfTkFNRSB9ID0gbnM7CiAgY29uc3QgY2FsID0gbnMuY2FsZW5kYXJMb2dpYzsKCiAgY29uc3QgU1RBTEVfTVMgPSA2MCAqIDEwMDA7CiAgY29uc3QgTkFSUk9XX1BYID0gNzIwOwogIC8vIEEgbW9udGggY2VsbCBzaG93cyB0aGlzIG1hbnksIHRoZW4gIisyIG1vcmUiLgogIGNvbnN0IE1PTlRIX1JPV1MgPSA0OwogIGNvbnN0IFNXSVBFX1BYID0gN",
"jA7CiAgLy8gVGhlIHdlZWsgYnkgdGhlIGhvdXI6IGEgZHJhZyBtb3ZlcyBpbiBxdWFydGVyIGhvdXJzLCBhIGNsaWNrIGFkZHMgYXQKICAvLyB0aGUgaGFsZiBob3VyOyB0aGUgZGF5IGlzIHNldmVuIGluIHRoZSBtb3JuaW5nIHRvIHRlbiBhdCBuaWdodCwgYW5kCiAgLy8gdGhlIG5pZ2h0IGlzIHNob3duIHdoZW4gYXNrZWQgZm9yIChvciB3aGVuIHNvbWV0aGluZyBpcyBvbiB0aGVuKS4KICBjb25zdCBTVEVQX01JTiA9IDE1OwogIGNvbnN0IENMSUNLX01JTiA9IDMwOwogIGNvbnN0IERBWV9GUk9NID0gNyAqIDYwOwogIGNvbnN0IERBWV9UTyA9IDIyICogNjA7CgogIGNvbnN0IEMgPSB7CiAgICBjdHg6IG51bGwsICAgICAgICAgIC8vIHsgcm9vdCwgb25TdGF0ZUVycm9yLCBvbkxvYWRlZCwgYmFyQ2hhbmdlZCwgcHJlZnMsIGNvbm5lY3QgfQogICAgdmlldzogJ3dlZWsnLCAgICAgICAvLyB0aGUgdmlldyBjaG9zZW4gb24gYSB3aWRlIHNjcmVlbgogICAgcGhvbmVWaWV3OiAnd2VlaycsICAvLyBhbmQgb24gYSBuYXJyb3cgb25lOiB0aGUgd2VlayBvciB0aGUgbW9udGgKICAgIG9yZGVyOiAnZG93bicsICAgICAgLy8gbmFycm93OiB0aGUgZGF5cyBkb3duIHRoZW4gYWNyb3NzLCBvciAnYWNyb3NzJyB0aGVuIGRvd24KICAgIGxheW91dDogJ2NvbHVtbnMnLCAgLy8gd2lkZSwgdGhlIHdlZWs6IGJ5IHRoZSBob3VyIGluIHNldmVuIGNvbHVtbnMsIG9yIHR3byAncm93cycKICAgIHpvbmUyOiAnJywgICAgICAgICAgL",
"y8gYnkgdGhlIGhvdXI6IGEgc2Vjb25kIHRpbWUgem9uZSBiZXNpZGUgeW91ciBvd24sIG9yIG5vbmUKICAgIG5pZ2h0OiBmYWxzZSwgICAgICAgLy8gYnkgdGhlIGhvdXI6IGFsbCAyNCBob3Vycywgb3IgdGhlIGRheSdzIChhbmQgd2hhdGV2ZXIgaXMgb24gb3V0c2lkZSB0aGVtKQogICAgaG91cnNUb3A6IG51bGwsICAgICAvLyBob3cgZmFyIHRoZSBob3VycyB3ZXJlIHNjcm9sbGVkLCBrZXB0IGFjcm9zcyByZWRyYXdzCiAgICBzcGFuOiBbMCwgMTQ0MF0sICAgIC8vIHRoZSBob3VycyBvbiBzY3JlZW4sIGZyb20gYW5kIHRvLCBpbiBtaW51dGVzIGFmdGVyIG1pZG5pZ2h0CiAgICBhbmNob3I6ICcnLCAgICAgICAgIC8vIHRoZSBkYXkgaW4gZm9jdXMKICAgIHRvZGF5OiAnJywKICAgIG5hcnJvdzogZmFsc2UsCiAgICBzb3VyY2VzOiBbXSwKICAgIG92ZXJyaWRlczoge30sICAgICAgLy8gc291cmNlIGlkIOKGkiBzaG93biBvciBub3QsIHdoZXJlIGZsaWNrZWQgaGVyZQogICAgcHJlZnNSZWFkOiBmYWxzZSwKICAgIHN0YXR1czogJ2lkbGUnLCAgICAgLy8gaWRsZSB8IGxvYWRpbmcgfCByZWFkeSB8IGVycm9yIHwgc2lnbmluIHwgbWlzbWF0Y2gKICAgIGVycm9yOiAnJywKICAgIGVycm9yczoge30sICAgICAgICAgLy8gc2VydmljZSDihpIgZXJyb3IsIGZvciB0aGUgbm90ZSBhYm92ZSB0aGUgZGF5cwogICAgc2hvd246IG51bGwsICAgICAgICAvLyB7IGtleSwgcmFuZ2UsIGl0ZW1zLCBmZXRjaGVkOiBTZXQsIGVyc",
"m9ycywgYXQgfSBvbiBzY3JlZW4KICAgIGNhY2hlOiBuZXcgTWFwKCksICAgLy8gcmFuZ2Uga2V5IOKGkiB0aGUgc2FtZQogICAgbG9hZGluZzogbnVsbCwKICAgIGxvYWRlZEF0OiAwLAogICAgc2VxOiAwLAogICAgcmVjaGVjazogZmFsc2UsICAgICAvLyBBbGxvdyB3YXMgcHJlc3NlZDogcmVhZCBldmVyeXRoaW5nIGFnYWluIG9uIHJldHVybgogICAgd3JpdGVzOiBQcm9taXNlLnJlc29sdmUoKSwgLy8gY2hhbmdlcyBnbyB0byBHb29nbGUgb25lIGFmdGVyIGFub3RoZXIKICAgIHBlbmRpbmc6IDAsICAgICAgICAgLy8gY2hhbmdlcyBvbiB0aGVpciB3YXk6IGEgcmVhZCBzdGFydGVkIGJlZm9yZSBvbmUgbGFuZHMgaXMgbm90IHNob3duCiAgICBsYXRlcjogbmV3IE1hcCgpLCAgIC8vIGtleSDihpIgeyB0aW1lciwgaGlkZXMgfTogZG9uZSBvbiBzY3JlZW4sIHNlbnQgdG8gR29vZ2xlIG9uY2UgaXRzIFVuZG8gaGFzIHBhc3NlZAogICAgZHJhZzogbnVsbCwgICAgICAgICAvLyB7IGl0ZW0sIGZyb20sIHRpbWVkLCBncmFiLCBzdGFydE1pbiB9OiB3aGF0IGlzIGJlaW5nIGRyYWdnZWQsIGFuZCBmcm9tIHdoaWNoIGRheSAoJycgZm9yIG5vIGRheSkKICAgIGVkaXQ6IG51bGwsICAgICAgICAgLy8gdGhlIGVkaXRvciwgd2hpbGUgaXQgaXMgb3BlbgogIH07CgogIGNvbnN0IGVscyA9IHt9OwogIGxldCB0aW1lRm9ybWF0ID0gbnVsbDsKCiAgLy8g4pSA4pSAIFNldHVwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUg",
"OKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBpbml0KGN0eCkgewogICAgQy5jdHggPSBjdHg7CiAgICBDLnRvZGF5ID0gY2FsLmRhdGVLZXkobmV3IERhdGUoKSk7CiAgICBDLmFuY2hvciA9IEMudG9kYXk7CiAgICAvLyBCYWNrIGZyb20gR29vZ2xlJ3MgcGVybWlzc2lvbiBwYWdlIChvcGVuZWQgYnkgQWxsb3cpOiByZWFkIGFnYWluLgogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2ZvY3VzJywgKCkgPT4geyBpZiAoQy5yZWNoZWNrKSBsb2FkKCk7IH0pOwogIH0KCiAgZnVuY3Rpb24gZWxlbWVudCgpIHsKICAgIGlmIChlbHMud3JhcCkgcmV0dXJuIGVscy53cmFwOwoKICAgIGNvbnN0IG5hdiA9IChkaXIsIGxhYmVsLCBuYW1lKSA9PiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGl0bGU6IGxhYmVsLCAnYXJpYS1sYWJlbCc6IGxhYmVsLAogICAgICBkYXRhc2V0OiB7IGtleTogYGNhbC0ke25hbWV9YCB9LCBvbmNsaWNrOiAoKSA9PiBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCBkaXIpKSwKICAgIH0sIGljb24obmFtZSwgMjApKTsKCiAgICBlbHMudGl0bGUgPSBoKCdoMicsIHsgY2xhc3M6ICdjYWwtdGl0b",
"GUnLCAnYXJpYS1saXZlJzogJ3BvbGl0ZScgfSk7CiAgICBlbHMudmlld3MgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLXZpZXdzJywgcm9sZTogJ3RhYmxpc3QnLCAnYXJpYS1sYWJlbCc6ICdDYWxlbmRhciB2aWV3JyB9LAogICAgICBjYWwuVklFV1MubWFwKHYgPT4gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnc2VnJywgdHlwZTogJ2J1dHRvbicsIHJvbGU6ICd0YWInLCBkYXRhc2V0OiB7IGtleTogYGNhbC12aWV3OiR7dn1gLCB2aWV3OiB2IH0sCiAgICAgICAgdGV4dDogdlswXS50b1VwcGVyQ2FzZSgpICsgdi5zbGljZSgxKSwgb25jbGljazogKCkgPT4gc2V0Vmlldyh2KSwKICAgICAgfSkpKTsKICAgIGVscy5oZWFkID0gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1oZWFkJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLW5hdicgfSwKICAgICAgICAvLyBOYXJyb3csIGEgY2FsZW5kYXIgd2l0aCB0b2RheSdzIGRhdGUgaW4gaXQsIGFzIG9uIEFuZHJvaWQ6IHRoZQogICAgICAgIC8vIHdvcmQgd291bGQgbGVhdmUgbm8gcm9vbSBmb3IgdGhlIHdlZWsncyBudW1iZXIuCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdidG4gYnRuLW91dGxpbmUgY2FsLXRvZGF5JywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLXRvZGF5JyB9LAogICAgICAgICAgdGl0bGU6ICdUb2RheSAoVCknLCAnYXJpYS1sYWJlbCc6ICdUb2RheScsIG9uY2xpY2s6ICgpID0-IGdvK",
"GNhbC5kYXRlS2V5KG5ldyBEYXRlKCkpKSwKICAgICAgICB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndG9kYXktd29yZCcsIHRleHQ6ICdUb2RheScgfSksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICd0b2RheS1pY29uJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0sIGljb24oJ2NhbGVuZGFyJywgMjQpLCBlbHMudG9kYXlOdW0gPSBoKCdzcGFuJywgeyBjbGFzczogJ3RvZGF5LW51bScgfSkpKSwKICAgICAgICBuYXYoLTEsICdQcmV2aW91cycsICdwcmV2JyksCiAgICAgICAgbmF2KDEsICdOZXh0JywgJ25leHQnKSwKICAgICAgICAvLyBOYXJyb3cgb25seTogd2hpY2ggd2F5IHRoZSBkYXlzIHJ1biBpbiB0aGUgdHdvIGNvbHVtbnMuCiAgICAgICAgZWxzLm9yZGVyID0gaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0biBjYWwtb3JkZXInLCB0eXBlOiAnYnV0dG9uJywgZGF0YXNldDogeyBrZXk6ICdjYWwtb3JkZXInIH0sIG9uY2xpY2s6IHRvZ2dsZU9yZGVyLAogICAgICAgIH0pLAogICAgICAgIC8vIE5hcnJvdyBvbmx5OiB0aGUgd2VlayBvciB0aGUgbW9udGguCiAgICAgICAgZWxzLnBob25lVmlldyA9IGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4gY2FsLXBob25lLXZpZXcnLCB0eXBlOiAnYnV0dG9uJywgZGF0YXNldDogeyBrZXk6ICdjYWwtcGhvbmUtdmlldycgfSwKICAgICAgICAgIG9uY2xpY2s6ICgpID0-IHNldFZpZXcodmlldygpID09P",
"SAnbW9udGgnID8gJ3dlZWsnIDogJ21vbnRoJyksCiAgICAgICAgfSkpLAogICAgICBlbHMudGl0bGUsCiAgICAgIC8vIFdpZGUsIGluIHRoZSB3ZWVrIGJ5IHRoZSBob3VyOiB0aGUgbmlnaHQgc2hvd24gb3Igbm90LgogICAgICBlbHMubmlnaHQgPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0biBjYWwtbmlnaHQnLCB0eXBlOiAnYnV0dG9uJywgZGF0YXNldDogeyBrZXk6ICdjYWwtbmlnaHQnIH0sIG9uY2xpY2s6IHRvZ2dsZU5pZ2h0LAogICAgICB9LCBpY29uKCduaWdodCcsIDIwKSksCiAgICAgIC8vIFdpZGUsIGluIHRoZSB3ZWVrOiBieSB0aGUgaG91ciwgb3IgdHdvIHJvd3MuCiAgICAgIGVscy5sYXlvdXQgPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdpY29uLWJ0biBjYWwtbGF5b3V0JywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWxheW91dCcgfSwgb25jbGljazogdG9nZ2xlTGF5b3V0LAogICAgICB9KSwKICAgICAgZWxzLnZpZXdzKTsKCiAgICBlbHMubm90ZSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtbm90ZScsIHJvbGU6ICdzdGF0dXMnIH0pOwogICAgZWxzLm1pbmkgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLW1pbmknIH0pOwogICAgZWxzLnNvdXJjZXMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLXNvdXJjZXMnLCByb2xlOiAnZ3JvdXAnLCAnYXJpYS1sYWJlbCc6ICdDYWxlbmRhcnMgYW5kIHRhc2sgbGlzdHMnIH0pOwogICAgLy8gQSB0Y",
"XNrIGRyYWdnZWQgaGVyZSBsb3NlcyBpdHMgZGF5LgogICAgZWxzLnRyYXkgPSBoKCdzZWN0aW9uJywgeyBjbGFzczogJ2NhbC10cmF5JywgJ2FyaWEtbGFiZWwnOiAnVGFza3Mgd2l0aG91dCBhIGRheScsIGRhdGFzZXQ6IHsgZHJvcDogJycgfSB9KTsKICAgIGVscy5tYWluID0gaCgnc2VjdGlvbicsIHsgY2xhc3M6ICdjYWwtbWFpbicgfSk7CiAgICBlbHMubWFpbi5hZGRFdmVudExpc3RlbmVyKCd0b3VjaHN0YXJ0Jywgb25Ub3VjaFN0YXJ0LCB7IHBhc3NpdmU6IHRydWUgfSk7CiAgICBlbHMubWFpbi5hZGRFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIG9uVG91Y2hFbmQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTsKCiAgICBlbHMud3JhcCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwnIH0sCiAgICAgIGVscy5oZWFkLAogICAgICBlbHMubm90ZSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2NhbC1ib2R5JyB9LAogICAgICAgIGgoJ2FzaWRlJywgeyBjbGFzczogJ2NhbC1zaWRlJyB9LCBlbHMubWluaSwgZWxzLnNvdXJjZXMsIGVscy50cmF5KSwKICAgICAgICBlbHMubWFpbikpOwoKICAgIC8vIERyYWdnaW5nIGFuIGV2ZW50IG9yIGEgdGFzayB0byBhbm90aGVyIGRheSAob3IgYSB0YXNrIHRvIE5vIGRhdGUpLgogICAgZWxzLndyYXAuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLCBvbkRyYWdPdmVyKTsKICAgIGVscy53cmFwLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCBvbkRyb3ApOwogICAgZWxzLndyYXAuYWRkR",
"XZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsIGVuZERyYWcpOwoKICAgIC8vIE5hcnJvdyBvciB3aWRlIGlzIGFib3V0IHRoZSBzcGFjZSB0aGUgdmlldyBoYXMsIG5vdCB0aGUgc2NyZWVuLgogICAgLy8gR29pbmcgbmFycm93IGNhbiBjaGFuZ2UgdGhlIHZpZXcgKHRvIHRoZSB3ZWVrKSwgYW5kIHNvIHRoZSBkYXlzLgogICAgbmV3IFJlc2l6ZU9ic2VydmVyKGVudHJpZXMgPT4gewogICAgICBjb25zdCBuYXJyb3cgPSBlbnRyaWVzWzBdLmNvbnRlbnRSZWN0LndpZHRoIDwgTkFSUk9XX1BYOwogICAgICBpZiAobmFycm93ID09PSBDLm5hcnJvdykgcmV0dXJuOwogICAgICBjb25zdCBiZWZvcmUgPSByYW5nZUtleShyYW5nZSgpKTsKICAgICAgQy5uYXJyb3cgPSBuYXJyb3c7CiAgICAgIGlmIChyYW5nZUtleShyYW5nZSgpKSAhPT0gYmVmb3JlICYmIChDLnN0YXR1cyA9PT0gJ3JlYWR5JyB8fCBDLnN0YXR1cyA9PT0gJ2xvYWRpbmcnKSkgbG9hZCgpOwogICAgICBlbHNlIGRyYXcoKTsKICAgIH0pLm9ic2VydmUoZWxzLndyYXApOwoKICAgIGRyYXcoKTsKICAgIHJldHVybiBlbHMud3JhcDsKICB9CgogIC8vIE5hcnJvdywgdGhlIHdlZWsgb3IgdGhlIG1vbnRoOyB3aWRlLCBhbnkgb2YgdGhlIHRocmVlLgogIGNvbnN0IFBIT05FX1ZJRVdTID0gWyd3ZWVrJywgJ21vbnRoJ107CiAgZnVuY3Rpb24gdmlldygpIHsKICAgIHJldHVybiBDLm5hcnJvdyA_IEMucGhvbmVWaWV3IDogQy52aWV3OwogIH0KCiAgZnVuY3Rpb24gcmFuZ",
"2UoKSB7CiAgICByZXR1cm4gY2FsLnZpZXdSYW5nZSh2aWV3KCksIEMuYW5jaG9yKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHJlYWRQcmVmcygpIHsKICAgIGlmIChDLnByZWZzUmVhZCkgcmV0dXJuOwogICAgQy5wcmVmc1JlYWQgPSB0cnVlOwogICAgdHJ5IHsKICAgICAgY29uc3QgbmFtZXMgPSBbJ2NhbGVuZGFyVmlldycsICdjYWxlbmRhclNvdXJjZXMnLCAnY2FsZW5kYXJPcmRlcicsICdjYWxlbmRhcldlZWtMYXlvdXQnLCAnY2FsZW5kYXJab25lMicsICdjYWxlbmRhck5pZ2h0JywgJ2NhbGVuZGFyUGhvbmVWaWV3J107CiAgICAgIGNvbnN0IFt2LCBvLCBvcmRlciwgbGF5b3V0LCB6b25lMiwgbmlnaHQsIHBob25lVmlld10gPSBhd2FpdCBQcm9taXNlLmFsbChuYW1lcy5tYXAobiA9PiBDLmN0eC5wcmVmcy5nZXQobikpKTsKICAgICAgaWYgKGNhbC5WSUVXUy5pbmNsdWRlcyh2KSkgQy52aWV3ID0gdjsKICAgICAgaWYgKFBIT05FX1ZJRVdTLmluY2x1ZGVzKHBob25lVmlldykpIEMucGhvbmVWaWV3ID0gcGhvbmVWaWV3OwogICAgICBpZiAobyAmJiB0eXBlb2YgbyA9PT0gJ29iamVjdCcpIEMub3ZlcnJpZGVzID0gbzsKICAgICAgaWYgKG9yZGVyID09PSAnYWNyb3NzJyB8fCBvcmRlciA9PT0gJ2Rvd24nKSBDLm9yZGVyID0gb3JkZXI7CiAgICAgIGlmIChsYXlvdXQgPT09ICdyb3dzJyB8fCBsYXlvdXQgPT09ICdjb2x1bW5zJykgQy5sYXlvdXQgPSBsYXlvdXQ7CiAgICAgIGlmIChpc1pvbmUoem9uZTIpKSBDL",
"npvbmUyID0gem9uZTI7CiAgICAgIEMubmlnaHQgPSBuaWdodCA9PT0gdHJ1ZTsKICAgIH0gY2F0Y2ggeyAvKiBzdG9yYWdlIGdvbmUgKGV4dGVuc2lvbiByZWxvYWRlZCk7IGRlZmF1bHRzIHdpbGwgZG8gKi8gfQogIH0KCiAgZnVuY3Rpb24gc2F2ZVByZWYobmFtZSwgdmFsdWUpIHsKICAgIFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gQy5jdHgucHJlZnMuc2V0KG5hbWUsIHZhbHVlKSkuY2F0Y2goKCkgPT4ge30pOwogIH0KCiAgLy8g4pSA4pSAIExvYWRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGNvbnN0IGlzT24gPSBzID0-IGNhbC5pc09uKHMsIEMub3ZlcnJpZGVzKTsKICBjb25zdCBvblNvdXJjZXMgPSAoKSA9PiBDLnNvdXJjZXMuZmlsdGVyKGlzT24pOwogIGNvbnN0IHJhbmdlS2V5ID0gciA9PiBgJHtyLnN0YXJ0fXwke3IuZW5kfWA7CgogIC8vIFdoYXQgaXMgb24gc2NyZWVuIGNvdmVycyB0aGUgcmFuZ2UgYW5kIGV2ZXJ5IHNvdXJjZSB0aGF0IGlzIG9uLgogIGZ1bmN0aW9uIGNvdmVycyhlbnRyeSkgewogICAgcmV0dXJuICEhZW50cnkgJiYgb25Tb3VyY2VzKCkuZXZlcnkocyA9PiBlbnRyeS5mZXRjaGVkLmhhcyhzLmlkK",
"Sk7CiAgfQoKICBmdW5jdGlvbiBpc1N0YWxlKCkgewogICAgY29uc3QgZW50cnkgPSBDLmNhY2hlLmdldChyYW5nZUtleShyYW5nZSgpKSk7CiAgICByZXR1cm4gQy5yZWNoZWNrIHx8IEMuc3RhdHVzICE9PSAncmVhZHknIHx8ICFjb3ZlcnMoZW50cnkpIHx8IERhdGUubm93KCkgLSBlbnRyeS5hdCA-IFNUQUxFX01TOwogIH0KCiAgLy8gU2hvd3Mgd2hhdGV2ZXIgaXMgY2FjaGVkIGZvciB0aGUgcmFuZ2UgYXQgb25jZSwgdGhlbiByZWFkcyBHb29nbGUKICAvLyBpZiB0aGF0IGlzIG1pc3NpbmcsIG9sZCBvciBzaG9ydCBvZiBhIHNvdXJjZSB0aGF0IGhhcyBiZWVuIHN3aXRjaGVkCiAgLy8gb24uIEEgbmV3ZXIgbG9hZCAodGhlIG5leHQgd2VlaywgdGFwcGVkIHF1aWNrbHkpIG92ZXJ0YWtlcyB0aGlzIG9uZS4KICBmdW5jdGlvbiBsb2FkKHsgZm9yY2UgPSBmYWxzZSB9ID0ge30pIHsKICAgIGlmICghZWxzLndyYXApIGVsZW1lbnQoKTsKICAgIC8vIFRoZSB2aWV3IGNob3NlbiBsYXN0IHRpbWUgZGVjaWRlcyB3aGljaCBkYXlzIHRvIHJlYWQuCiAgICBpZiAoIUMucHJlZnNSZWFkKSByZXR1cm4gcmVhZFByZWZzKCkudGhlbigoKSA9PiBsb2FkKHsgZm9yY2UgfSkpOwogICAgLy8gUGVybWlzc2lvbiBtYXkgaGF2ZSBiZWVuIGdpdmVuIHNpbmNlOiBub3RoaW5nIGNhY2hlZCBjb3VudHMuCiAgICBpZiAoQy5yZWNoZWNrKSB7CiAgICAgIEMucmVjaGVjayA9IGZhbHNlOwogICAgICBmb3JjZSA9IHRydWU7CiAgICAgIEMuY",
"2FjaGUuY2xlYXIoKTsKICAgICAgc3RvcmUuZm9yZ2V0KCk7CiAgICB9CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IGtleSA9IHJhbmdlS2V5KHIpOwogICAgY29uc3QgY2FjaGVkID0gQy5jYWNoZS5nZXQoa2V5KTsKICAgIGlmIChjYWNoZWQpIHsKICAgICAgQy5zaG93biA9IGNhY2hlZDsKICAgICAgaWYgKEMuc3RhdHVzID09PSAnaWRsZScpIEMuc3RhdHVzID0gJ3JlYWR5JzsKICAgIH0KICAgIGRyYXcoKTsKICAgIGlmICghZm9yY2UgJiYgIWlzU3RhbGUoKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOwoKICAgIGNvbnN0IHNlcSA9ICsrQy5zZXE7CiAgICBpZiAoIUMuc2hvd24gfHwgQy5zaG93bi5rZXkgIT09IGtleSkgQy5zaG93biA9IG51bGw7CiAgICBpZiAoIUMuc2hvd24gJiYgQy5zdGF0dXMgIT09ICdzaWduaW4nICYmIEMuc3RhdHVzICE9PSAnbWlzbWF0Y2gnKSBDLnN0YXR1cyA9ICdsb2FkaW5nJzsKICAgIGRyYXcoKTsKCiAgICBjb25zdCBydW4gPSAoYXN5bmMgKCkgPT4gewogICAgICB0cnkgewogICAgICAgIGNvbnN0IGFjY291bnQgPSBob29rcy5nZXRBY2NvdW50KCk7CiAgICAgICAgY29uc3QgZ290ID0gYXdhaXQgc3RvcmUubG9hZFNvdXJjZXMoYWNjb3VudCwgeyBmb3JjZSB9KTsKICAgICAgICBDLnNvdXJjZXMgPSBnb3Quc291cmNlczsKICAgICAgICBjb25zdCB3YW50ZWQgPSBvblNvdXJjZXMoKTsKICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzdG9yZS5sb2FkUmFuZ",
"2Uociwgd2FudGVkKTsKICAgICAgICBpZiAoc2VxICE9PSBDLnNlcSkgcmV0dXJuOwogICAgICAgIC8vIFJlYWQgYmVmb3JlIGEgY2hhbmdlIGxhbmRlZDogdGhlIHJlYWQgdGhhdCBmb2xsb3dzIGl0IGlzIHRoZSBvbmUgdG8gc2hvdy4KICAgICAgICBpZiAoQy5wZW5kaW5nKSByZXR1cm47CiAgICAgICAgY29uc3QgZW50cnkgPSB7CiAgICAgICAgICBrZXksIHJhbmdlOiByLCBpdGVtczogcmVzdWx0Lml0ZW1zLCBhdDogRGF0ZS5ub3coKSwKICAgICAgICAgIGZldGNoZWQ6IG5ldyBTZXQod2FudGVkLm1hcChzID0-IHMuaWQpKSwKICAgICAgICAgIGVycm9yczogT2JqZWN0LmFzc2lnbih7fSwgZ290LmVycm9ycywgcmVzdWx0LmVycm9ycyksCiAgICAgICAgfTsKICAgICAgICBDLmNhY2hlLnNldChrZXksIGVudHJ5KTsKICAgICAgICBDLnNob3duID0gZW50cnk7CiAgICAgICAgQy5lcnJvcnMgPSBlbnRyeS5lcnJvcnM7CiAgICAgICAgQy5zdGF0dXMgPSAncmVhZHknOwogICAgICAgIEMuZXJyb3IgPSAnJzsKICAgICAgICBDLmxvYWRlZEF0ID0gRGF0ZS5ub3coKTsKICAgICAgICBpZiAoQy5jdHgub25Mb2FkZWQpIEMuY3R4Lm9uTG9hZGVkKCk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGlmIChzZXEgIT09IEMuc2VxKSByZXR1cm47CiAgICAgICAgaWYgKGVyci5jb2RlID09PSAnY2FsZW5kYXJfYXV0aF9yZXF1aXJlZCcpIEMuc3RhdHVzID0gJ3NpZ25pbic7CiAgICAgICAgZWxzZSBpZiAoZXJyLmNvZ",
"GUgPT09ICdjYWxlbmRhcl9taXNtYXRjaCcpIHsgQy5zdGF0dXMgPSAnbWlzbWF0Y2gnOyBDLmVycm9yID0gZXJyLm1lc3NhZ2U7IH0KICAgICAgICBlbHNlIGlmIChlcnIuY29kZSA9PT0gJ25vdF9jb25maWd1cmVkJykgewogICAgICAgICAgLy8gTm8gY2xpZW50IElEIGF0IGFsbDogdGhlIGJvYXJkJ3Mgc2V0dXAgcGFuZWwgc2F5cyB3aGF0IHRvIGRvLgogICAgICAgICAgQy5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgICBDLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgICAgICB9IGVsc2UgaWYgKEMuc2hvd24pIHsKICAgICAgICAgIEMuc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgICAgIHRvYXN0KEMuY3R4LnJvb3QsIGBDb3VsZG7igJl0IGxvYWQgdGhlIGNhbGVuZGFyOiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgQy5zdGF0dXMgPSAnZXJyb3InOwogICAgICAgICAgQy5lcnJvciA9IGVyci5tZXNzYWdlOwogICAgICAgIH0KICAgICAgfSBmaW5hbGx5IHsKICAgICAgICBpZiAoQy5sb2FkaW5nID09PSBydW4pIEMubG9hZGluZyA9IG51bGw7CiAgICAgICAgZHJhdygpOwogICAgICAgIEMuY3R4LmJhckNoYW5nZWQoKTsKICAgICAgfQogICAgfSkoKTsKICAgIEMubG9hZGluZyA9IHJ1bjsKICAgIEMuY3R4LmJhckNoYW5nZWQoKTsKICAgIHJldHVybiBydW47CiAgfQoKICBhc3luYyBmdW5jdGlvbiBjb25uZWN0KGJ0bikgewogICAgaWYgKGJ0b",
"ikgYnRuLmRpc2FibGVkID0gdHJ1ZTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IEMuY3R4LmNvbm5lY3QoKTsKICAgICAgQy5zdGF0dXMgPSAnbG9hZGluZyc7CiAgICAgIHN0b3JlLmZvcmdldCgpOwogICAgICBhd2FpdCBsb2FkKHsgZm9yY2U6IHRydWUgfSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKGVyci5jb2RlID09PSAnY2FsZW5kYXJfbWlzbWF0Y2gnKSB7CiAgICAgICAgQy5zdGF0dXMgPSAnbWlzbWF0Y2gnOwogICAgICAgIEMuZXJyb3IgPSBlcnIubWVzc2FnZTsKICAgICAgICBkcmF3KCk7CiAgICAgIH0gZWxzZSBpZiAoZXJyLmNvZGUgPT09ICdub3RfY29uZmlndXJlZCcpIHsKICAgICAgICBDLmN0eC5vblN0YXRlRXJyb3IoZXJyKTsKICAgICAgfSBlbHNlIHsKICAgICAgICB0b2FzdChDLmN0eC5yb290LCBgQ291bGRu4oCZdCBjb25uZWN0OiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICAgICAgfQogICAgfSBmaW5hbGx5IHsKICAgICAgaWYgKGJ0biAmJiBidG4uaXNDb25uZWN0ZWQpIGJ0bi5kaXNhYmxlZCA9IGZhbHNlOwogICAgfQogIH0KCiAgLy8g4pSA4pSAIE1vdmluZyBhYm91dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKC",
"iAgZnVuY3Rpb24gZ28oYW5jaG9yKSB7CiAgICBpZiAoIWNhbC5pc0tleShhbmNob3IpKSByZXR1cm47CiAgICBDLmFuY2hvciA9IGFuY2hvcjsKICAgIEMudG9kYXkgPSBjYWwuZGF0ZUtleShuZXcgRGF0ZSgpKTsKICAgIGxvYWQoKTsKICB9CgogIC8vIEluIHR3byBjb2x1bW5zLCB0aGUgZGF5cyBydW4gZG93biB0aGVuIGFjcm9zcyAoTW9uZGF5IHRvIFRodXJzZGF5IG9uCiAgLy8gdGhlIGxlZnQpLCBvciBhY3Jvc3MgdGhlbiBkb3duIChNb25kYXkgYmVzaWRlIFR1ZXNkYXkpLgogIGZ1bmN0aW9uIHRvZ2dsZU9yZGVyKCkgewogICAgQy5vcmRlciA9IEMub3JkZXIgPT09ICdhY3Jvc3MnID8gJ2Rvd24nIDogJ2Fjcm9zcyc7CiAgICBzYXZlUHJlZignY2FsZW5kYXJPcmRlcicsIEMub3JkZXIpOwogICAgZHJhdygpOwogIH0KCiAgLy8gT24gYSBjb21wdXRlciwgdGhlIHdlZWsgYnkgdGhlIGhvdXIsIG9yIGFzIHR3byByb3dzOiBNb25kYXkgdG8KICAvLyBUaHVyc2RheSBhYm92ZSwgRnJpZGF5IHRvIFN1bmRheSBiZWxvdy4KICBmdW5jdGlvbiB0b2dnbGVMYXlvdXQoKSB7CiAgICBDLmxheW91dCA9IEMubGF5b3V0ID09PSAncm93cycgPyAnY29sdW1ucycgOiAncm93cyc7CiAgICBzYXZlUHJlZignY2FsZW5kYXJXZWVrTGF5b3V0JywgQy5sYXlvdXQpOwogICAgZHJhdygpOwogIH0KCiAgLy8gQnkgdGhlIGhvdXIsIHRoZSBuaWdodCAtIHRlbiBhdCBuaWdodCB0byBzZXZlbiBpbiB0aGUgbW9ybmluZyAtIGlzCiAgL",
"y8gbGVmdCBvdXQgdW5sZXNzIHNvbWV0aGluZyBpcyBvbiB0aGVuOyBvciBzaG93biwgYWxsIDI0IGhvdXJzLgogIGZ1bmN0aW9uIHRvZ2dsZU5pZ2h0KCkgewogICAgQy5uaWdodCA9ICFDLm5pZ2h0OwogICAgQy5ob3Vyc1RvcCA9IG51bGw7CiAgICBzYXZlUHJlZignY2FsZW5kYXJOaWdodCcsIEMubmlnaHQpOwogICAgZHJhdygpOwogIH0KCiAgLy8gTmFycm93IGFuZCB3aWRlIGVhY2ggcmVtZW1iZXIgdGhlaXIgb3duOiBhIHBob25lJ3MgbW9udGggaXMgbm90IHRoZQogIC8vIGNvbXB1dGVyJ3MgYWdlbmRhLgogIGZ1bmN0aW9uIHNldFZpZXcodikgewogICAgaWYgKEMubmFycm93KSB7CiAgICAgIGlmICghUEhPTkVfVklFV1MuaW5jbHVkZXModikpIHJldHVybjsKICAgICAgQy5waG9uZVZpZXcgPSB2OwogICAgICBzYXZlUHJlZignY2FsZW5kYXJQaG9uZVZpZXcnLCB2KTsKICAgIH0gZWxzZSB7CiAgICAgIGlmICghY2FsLlZJRVdTLmluY2x1ZGVzKHYpKSByZXR1cm47CiAgICAgIEMudmlldyA9IHY7CiAgICAgIHNhdmVQcmVmKCdjYWxlbmRhclZpZXcnLCB2KTsKICAgIH0KICAgIGxvYWQoKTsKICB9CgogIGZ1bmN0aW9uIHRvZ2dsZVNvdXJjZShzKSB7CiAgICBDLm92ZXJyaWRlcyA9IE9iamVjdC5hc3NpZ24oe30sIEMub3ZlcnJpZGVzLCB7IFtzLmlkXTogIWlzT24ocykgfSk7CiAgICBzYXZlUHJlZignY2FsZW5kYXJTb3VyY2VzJywgQy5vdmVycmlkZXMpOwogICAgLy8gU3dpdGNoZWQgb2ZmOiBqdXN0IGhpZ",
"GRlbi4gU3dpdGNoZWQgb24gYW5kIG5vdCByZWFkIHlldDogcmVhZCBub3cuCiAgICBpZiAoY292ZXJzKEMuc2hvd24pKSBkcmF3KCk7CiAgICBlbHNlIGxvYWQoKTsKICB9CgogIGxldCB0b3VjaCA9IG51bGw7CiAgZnVuY3Rpb24gb25Ub3VjaFN0YXJ0KGUpIHsKICAgIGlmICghQy5uYXJyb3cgfHwgZS50b3VjaGVzLmxlbmd0aCAhPT0gMSkgeyB0b3VjaCA9IG51bGw7IHJldHVybjsgfQogICAgdG91Y2ggPSB7IHg6IGUudG91Y2hlc1swXS5jbGllbnRYLCB5OiBlLnRvdWNoZXNbMF0uY2xpZW50WSB9OwogIH0KICBmdW5jdGlvbiBvblRvdWNoRW5kKGUpIHsKICAgIGlmICghdG91Y2ggfHwgIWUuY2hhbmdlZFRvdWNoZXMubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBkeCA9IGUuY2hhbmdlZFRvdWNoZXNbMF0uY2xpZW50WCAtIHRvdWNoLng7CiAgICBjb25zdCBkeSA9IGUuY2hhbmdlZFRvdWNoZXNbMF0uY2xpZW50WSAtIHRvdWNoLnk7CiAgICB0b3VjaCA9IG51bGw7CiAgICBpZiAoTWF0aC5hYnMoZHgpID4gU1dJUEVfUFggJiYgTWF0aC5hYnMoZHgpID4gMS41ICogTWF0aC5hYnMoZHkpKSBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCBkeCA8IDAgPyAxIDogLTEpKTsKICB9CgogIC8vIOKUgOKUgCBEcmF3aW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUg",
"OKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICAvLyBUaHJvdWdoIHRoZSBzdHlsZSBBUEksIG5vdCBhIHN0eWxlIGF0dHJpYnV0ZTogYSBwYWdlJ3Mgc2VjdXJpdHkKICAvLyBwb2xpY3kgbWF5IHJlZnVzZSBpbmxpbmUgc3R5bGUgYXR0cmlidXRlcywgbmV2ZXIgdGhpcy4KICBmdW5jdGlvbiB0aW50KGVsLCBuYW1lLCB2YWx1ZSkgewogICAgaWYgKHZhbHVlKSBlbC5zdHlsZS5zZXRQcm9wZXJ0eShuYW1lLCB2YWx1ZSk7CiAgICByZXR1cm4gZWw7CiAgfQoKICBmdW5jdGlvbiBkcmF3KCkgewogICAgaWYgKCFlbHMud3JhcCkgcmV0dXJuOwogICAgLy8gUmVkcmF3aW5nIHJlcGxhY2VzIHRoZSBjaGlwcyBhbmQgdGhlIHNtYWxsIG1vbnRoOyB3aGljaGV2ZXIgb2YgdGhlbQogICAgLy8gaGFkIHRoZSBmb2N1cyBnZXRzIGl0IGJhY2ssIG9yIHRoZSBuZXh0IGtleSB3b3VsZCBnbyB0byBHbWFpbC4KICAgIGNvbnN0IGFjdGl2ZSA9IEMuY3R4LnJvb3QuYWN0aXZlRWxlbWVudDsKICAgIGNvbnN0IGtleSA9IGFjdGl2ZSAmJiBlbHMud3JhcC5jb250YWlucyhhY3RpdmUpICYmIGFjdGl2ZS5kYXRhc2V0ID8gYWN0aXZlLmRhdGFzZXQua2V5IHx8ICcnIDogJyc7CiAgICBwYWludCgpOwogICAgaWYgKGtleSAmJiAhZWxzLndyYXAuY29udGFpbnMoQy5jdHgucm9vdC5hY3RpdmVFbGVtZW50KSkgewogICAgICBjb25zdCBhZ2FpbiA9IFsuLi5lbHMud3JhcC5xd",
"WVyeVNlbGVjdG9yQWxsKCdbZGF0YS1rZXldJyldLmZpbmQoeCA9PiB4LmRhdGFzZXQua2V5ID09PSBrZXkgJiYgeC5nZXRDbGllbnRSZWN0cygpLmxlbmd0aCk7CiAgICAgIGlmIChhZ2FpbikgYWdhaW4uZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcGFpbnQoKSB7CiAgICBjb25zdCB2ID0gdmlldygpOwogICAgZWxzLndyYXAuZGF0YXNldC5uYXJyb3cgPSBTdHJpbmcoQy5uYXJyb3cpOwogICAgZWxzLndyYXAuZGF0YXNldC52aWV3ID0gdjsKICAgIGVscy53cmFwLmRhdGFzZXQub3JkZXIgPSBDLm9yZGVyOwogICAgY29uc3QgYWNyb3NzID0gQy5vcmRlciA9PT0gJ2Fjcm9zcyc7CiAgICBlbHMub3JkZXIucmVwbGFjZUNoaWxkcmVuKGljb24oYWNyb3NzID8gJ3Jvd3MnIDogJ2NvbHVtbnMnLCAyMCkpOwogICAgZWxzLm9yZGVyLnRpdGxlID0gYWNyb3NzID8gJ0RheXMgcnVuIGFjcm9zcywgdGhlbiBkb3duLiBUYXAgZm9yIGRvd24sIHRoZW4gYWNyb3NzLicgOiAnRGF5cyBydW4gZG93biwgdGhlbiBhY3Jvc3MuIFRhcCBmb3IgYWNyb3NzLCB0aGVuIGRvd24uJzsKICAgIGVscy5vcmRlci5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBlbHMub3JkZXIudGl0bGUpOwogICAgZWxzLndyYXAuZGF0YXNldC5sYXlvdXQgPSBDLmxheW91dDsKICAgIGNvbnN0IHJvd3MgPSBDLmxheW91dCA9PT0gJ3Jvd3MnOwogICAgZWxzLmxheW91dC5yZXBsYWNlQ2hpbGRyZW4oaWNvb",
"ihyb3dzID8gJ3Jvd3MnIDogJ2NvbHVtbnMnLCAyMCkpOwogICAgZWxzLmxheW91dC50aXRsZSA9IHJvd3MKICAgICAgPyAnVGhlIHdlZWsgaW4gdHdvIHJvd3MsIE1vbmRheSB0byBUaHVyc2RheSBhYm92ZSBGcmlkYXkgdG8gU3VuZGF5LiBDbGljayBmb3IgdGhlIHdlZWsgYnkgdGhlIGhvdXIuJwogICAgICA6ICdUaGUgd2VlayBieSB0aGUgaG91ci4gQ2xpY2sgZm9yIHR3byByb3dzLCBNb25kYXkgdG8gVGh1cnNkYXkgYWJvdmUgRnJpZGF5IHRvIFN1bmRheS4nOwogICAgZWxzLmxheW91dC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBlbHMubGF5b3V0LnRpdGxlKTsKICAgIGVscy5uaWdodC5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsIFN0cmluZyhDLm5pZ2h0KSk7CiAgICBlbHMubmlnaHQudGl0bGUgPSBDLm5pZ2h0CiAgICAgID8gJ0FsbCAyNCBob3Vycy4gQ2xpY2sgdG8gbGVhdmUgb3V0IHRoZSBuaWdodCwgMjI6MDAgdG8gMDc6MDAsIHVubGVzcyBzb21ldGhpbmcgaXMgb24gdGhlbi4nCiAgICAgIDogJ1RoZSBuaWdodCwgMjI6MDAgdG8gMDc6MDAsIGlzIGxlZnQgb3V0IHVubGVzcyBzb21ldGhpbmcgaXMgb24gdGhlbi4gQ2xpY2sgZm9yIGFsbCAyNCBob3Vycy4nOwogICAgZWxzLm5pZ2h0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsICdBbGwgMjQgaG91cnMnKTsKICAgIGNvbnN0IG1vbnRoID0gdiA9PT0gJ21vbnRoJzsKICAgIGVscy5waG9uZVZpZXcucmVwbGFjZUNoaWxkcmVuKGljb24ob",
"W9udGggPyAnY29sdW1ucycgOiAnbW9udGgnLCAyMCkpOwogICAgZWxzLnBob25lVmlldy50aXRsZSA9IG1vbnRoID8gJ1Nob3cgdGhlIHdlZWsnIDogJ1Nob3cgdGhlIG1vbnRoJzsKICAgIGVscy5waG9uZVZpZXcuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgZWxzLnBob25lVmlldy50aXRsZSk7CiAgICBlbHMudG9kYXlOdW0udGV4dENvbnRlbnQgPSBTdHJpbmcoTnVtYmVyKEMudG9kYXkuc2xpY2UoOCkpKTsKICAgIC8vIE9uIGEgcGhvbmUgdGhlIHdlZWsncyBudW1iZXIgaXMgYSBzbWFsbCAiVzQxIiBhaGVhZCBvZiBpdHMgZGF5czoKICAgIC8vICJXZWVrIDQxIMK3IiBkb2VzIG5vdCBmaXQgYmVzaWRlIHRoZW0gYW5kIHRoZSBidXR0b25zLgogICAgY29uc3QgdGl0bGUgPSBjYWwudGl0bGUodiwgQy5hbmNob3IsIEMudG9kYXksIHsgc2hvcnQ6IEMubmFycm93IH0pOwogICAgaWYgKEMubmFycm93ICYmIHYgPT09ICd3ZWVrJykgewogICAgICBjb25zdCBuID0gY2FsLmlzb1dlZWsoQy5hbmNob3IpOwogICAgICBlbHMudGl0bGUucmVwbGFjZUNoaWxkcmVuKGgoJ3NwYW4nLCB7IGNsYXNzOiAnY2FsLXdrJywgdGV4dDogYFcke259YCwgdGl0bGU6IGBXZWVrICR7bn1gIH0pLCBgICR7dGl0bGV9YCk7CiAgICB9IGVsc2UgewogICAgICBlbHMudGl0bGUudGV4dENvbnRlbnQgPSB0aXRsZTsKICAgIH0KICAgIGZvciAoY29uc3QgYiBvZiBlbHMudmlld3MuY2hpbGRyZW4pIGIuc2V0QXR0cmlidXRlKCdhcmlhLXNlb",
"GVjdGVkJywgU3RyaW5nKGIuZGF0YXNldC52aWV3ID09PSB2KSk7CiAgICBjb25zdCBwYW5lbCA9IHN0YXR1c1BhbmVsKCk7CiAgICBlbHMud3JhcC5jbGFzc0xpc3QudG9nZ2xlKCdjYWwtcGFuZWwnLCAhIXBhbmVsKTsKICAgIGRyYXdOb3RlKCk7CiAgICBkcmF3TWluaSgpOwogICAgZHJhd1NvdXJjZXMoKTsKICAgIGRyYXdUcmF5KCk7CiAgICBpZiAocGFuZWwpIGVscy5tYWluLnJlcGxhY2VDaGlsZHJlbihwYW5lbCk7CiAgICBlbHNlIGlmICh2ID09PSAnbW9udGgnKSBlbHMubWFpbi5yZXBsYWNlQ2hpbGRyZW4oZHJhd01vbnRoKCkpOwogICAgZWxzZSBpZiAodiA9PT0gJ2FnZW5kYScpIGVscy5tYWluLnJlcGxhY2VDaGlsZHJlbihkcmF3QWdlbmRhKCkpOwogICAgZWxzZSB7CiAgICAgIGNvbnN0IHdlZWsgPSBkcmF3V2VlaygpOwogICAgICAvLyBBbHJlYWR5IHNob3dpbmc6IGxlZnQgaW4gcGxhY2UgKHNlZSBkcmF3V2VlaykuCiAgICAgIGlmIChlbHMubWFpbi5maXJzdENoaWxkICE9PSB3ZWVrIHx8IGVscy5tYWluLmNoaWxkTm9kZXMubGVuZ3RoICE9PSAxKSBlbHMubWFpbi5yZXBsYWNlQ2hpbGRyZW4od2Vlayk7CiAgICAgIC8vIEJ5IHRoZSBob3VyOiB3aGVyZSBpdCB3YXMgc2Nyb2xsZWQgdG87IGF0IGZpcnN0LCB0aGUgdG9wIC0gb3Igd2l0aAogICAgICAvLyB0aGUgbmlnaHQgc2hvd24sIGEgbGl0dGxlIGJlZm9yZSBzZXZlbiBpbiB0aGUgbW9ybmluZy4KICAgICAgaWYgKGlzSG91cnMoKSkgewogICAgI",
"CAgIGNvbnN0IGJvZHkgPSB3ZWVrLnF1ZXJ5U2VsZWN0b3IoJy5ncmlkLWJvZHknKTsKICAgICAgICBjb25zdCBob3VyUHggPSBib2R5ID8gYm9keS5vZmZzZXRIZWlnaHQgLyAoKEMuc3BhblsxXSAtIEMuc3BhblswXSkgLyA2MCkgOiAwOwogICAgICAgIHdlZWsuc2Nyb2xsVG9wID0gQy5ob3Vyc1RvcCAhPT0gbnVsbCA_IEMuaG91cnNUb3AgOiBDLm5pZ2h0ID8gaG91clB4ICogTWF0aC5tYXgoMCwgKERBWV9GUk9NIC0gQy5zcGFuWzBdKSAvIDYwIC0gMC4yNSkgOiAwOwogICAgICB9CiAgICB9CiAgfQoKICAvLyBXaGF0IGlzIG9uLCBmcm9tIHRoZSBzb3VyY2VzIHRoYXQgYXJlIG9uLCBieSBkYXkgLSBsZXNzIGFueXRoaW5nCiAgLy8gZGVsZXRlZCBoZXJlIHRoYXQgaXMgc3RpbGwgd2FpdGluZyBvdXQgaXRzIFVuZG8uCiAgZnVuY3Rpb24gdmlzaWJsZUl0ZW1zKCkgewogICAgaWYgKCFDLnNob3duKSByZXR1cm4gW107CiAgICBjb25zdCBvbiA9IG5ldyBTZXQob25Tb3VyY2VzKCkubWFwKHMgPT4gcy5pZCkpOwogICAgY29uc3Qgd2FpdGluZyA9IFsuLi5DLmxhdGVyLnZhbHVlcygpXS5maWx0ZXIobCA9PiBsLmhpZGVzKTsKICAgIHJldHVybiBDLnNob3duLml0ZW1zLmZpbHRlcih4ID0-IG9uLmhhcyh4LnNvdXJjZSkgJiYgIXdhaXRpbmcuc29tZShsID0-IGwuaGlkZXMoeCkpKTsKICB9CgogIGZ1bmN0aW9uIHN0YXR1c1BhbmVsKCkgewogICAgc3dpdGNoIChDLnN0YXR1cykgewogICAgICBjYXNlICdzaWduaW4nO",
"gogICAgICAgIHJldHVybiBwYW5lbCgnY2FsZW5kYXInLCAnQ29ubmVjdCBHb29nbGUgQ2FsZW5kYXInLAogICAgICAgICAgYFNlZSB5b3VyIEdvb2dsZSBDYWxlbmRhciBhbmQgR29vZ2xlIFRhc2tzIGhlcmUsIGJlc2lkZSB0aGUgYm9hcmQgYW5kIHRoZSBub3Rlcy4gJHtBUFBfTkFNRX0gb25seSByZWFkcyB0aGVtLiBHb29nbGUgd2lsbCBhc2sgeW91IHRvIGFsbG93IGl0LmAsCiAgICAgICAgICBDLmN0eC5jb25uZWN0ID8gW2J1dHRvbignQ29ubmVjdCBHb29nbGUgQ2FsZW5kYXInLCAncHJpbWFyeScsIGNvbm5lY3QpXSA6IFtdKTsKICAgICAgY2FzZSAnbWlzbWF0Y2gnOgogICAgICAgIHJldHVybiBwYW5lbCgnY2FsZW5kYXInLCAnVGhhdCB3YXMgYSBkaWZmZXJlbnQgYWNjb3VudCcsIGAke0MuZXJyb3J9IENvbm5lY3QgYWdhaW4gYW5kIGNob29zZSAke2hvb2tzLmdldEFjY291bnQoKX0uYCwKICAgICAgICAgIEMuY3R4LmNvbm5lY3QgPyBbYnV0dG9uKCdDb25uZWN0IGFnYWluJywgJ3ByaW1hcnknLCBjb25uZWN0KV0gOiBbXSk7CiAgICAgIGNhc2UgJ2Vycm9yJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ3JlZnJlc2gnLCAnQ291bGRu4oCZdCBsb2FkIHRoZSBjYWxlbmRhcicsIEMuZXJyb3IsCiAgICAgICAgICBbYnV0dG9uKCdUcnkgYWdhaW4nLCAncHJpbWFyeScsICgpID0-IGxvYWQoeyBmb3JjZTogdHJ1ZSB9KSldKTsKICAgICAgZGVmYXVsdDoKICAgICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogI",
"GZ1bmN0aW9uIHBhbmVsKGljb25OYW1lLCB0aXRsZSwgdGV4dCwgYWN0aW9ucykgewogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdwYW5lbCcsIHJvbGU6ICdyZWdpb24nLCAnYXJpYS1sYWJlbCc6IHRpdGxlIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncGFuZWwtaWNvbicgfSwgaWNvbihpY29uTmFtZSwgMjgpKSwKICAgICAgaCgnaDInLCB7IHRleHQ6IHRpdGxlIH0pLAogICAgICBoKCdwJywge30sIGxpbmtlZCh0ZXh0KSksCiAgICAgIGFjdGlvbnMubGVuZ3RoID8gaCgnZGl2JywgeyBjbGFzczogJ2FjdGlvbnMnIH0sIGFjdGlvbnMpIDogbnVsbCk7CiAgfQoKICBmdW5jdGlvbiBidXR0b24obGFiZWwsIGtpbmQsIG9uQ2xpY2spIHsKICAgIHJldHVybiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiBbJ2J0bicsIGBidG4tJHtraW5kfWBdLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogbGFiZWwsCiAgICAgIG9uY2xpY2s6IGUgPT4gb25DbGljayhlLmN1cnJlbnRUYXJnZXQpLAogICAgfSk7CiAgfQoKICAvLyBHb29nbGUncyBtZXNzYWdlcyBjYXJyeSB0aGUgbGluayB0aGF0IGZpeGVzIHRoZW0gKCJlbmFibGUgaXQgYnkKICAvLyB2aXNpdGluZyBodHRwczovL2NvbnNvbGXigKYiKTogbWFrZSBpdCBvbmUuCiAgZnVuY3Rpb24gbGlua2VkKHRleHQpIHsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgbGV0IGxhc3QgPSAwOwogICAgY29uc3QgcmUgPSAvaHR0cHM6XC9cL1teXHM8PiJdK1teXHM8PiIuLCldL",
"2c7CiAgICBsZXQgbTsKICAgIHdoaWxlICgobSA9IHJlLmV4ZWMoU3RyaW5nKHRleHQpKSkpIHsKICAgICAgb3V0LnB1c2godGV4dC5zbGljZShsYXN0LCBtLmluZGV4KSwgaCgnYScsIHsgaHJlZjogbVswXSwgdGFyZ2V0OiAnX2JsYW5rJywgcmVsOiAnbm9vcGVuZXIgbm9yZWZlcnJlcicsIHRleHQ6IG1bMF0gfSkpOwogICAgICBsYXN0ID0gbS5pbmRleCArIG1bMF0ubGVuZ3RoOwogICAgfQogICAgb3V0LnB1c2goU3RyaW5nKHRleHQpLnNsaWNlKGxhc3QpKTsKICAgIHJldHVybiBvdXQ7CiAgfQoKICAvLyBBIGxpbmUgYWJvdmUgdGhlIGRheXMgZm9yIGEgc2VydmljZSB0aGF0IGNvdWxkIG5vdCBiZSByZWFkLiBOb3QKICAvLyBhbGxvd2VkIGlzIG9uZSBsaW5lIGZvciBib3RoLCB3aXRoIHRoZSB3YXkgdG8gYWxsb3cgaXQ6IGluIENocm9tZSwKICAvLyBjb25uZWN0aW5nIGFnYWluOyBpbiB0aGUgcGhvbmUgYXBwLCBHb29nbGUncyBwYWdlIGZvciB0aGUgc2NyaXB0LgogIGZ1bmN0aW9uIGRyYXdOb3RlKCkgewogICAgY29uc3QgbGluZXMgPSBbXTsKICAgIGlmICghc3RhdHVzUGFuZWwoKSkgewogICAgICBjb25zdCBuYW1lID0gc2VydmljZSA9PiAoc2VydmljZSA9PT0gJ3Rhc2tzJyA_ICdHb29nbGUgVGFza3MnIDogJ0dvb2dsZSBDYWxlbmRhcicpOwogICAgICBjb25zdCBlcnJvcnMgPSBPYmplY3QuZW50cmllcyhDLmVycm9ycyB8fCB7fSk7CiAgICAgIGNvbnN0IGRlbmllZCA9IGVycm9ycy5maWx0ZXIoKFssI",
"GVycl0pID0-IGVyci5jb2RlID09PSAnY2FsZW5kYXJfc2NvcGUnKTsKICAgICAgaWYgKGRlbmllZC5sZW5ndGgpIHsKICAgICAgICBjb25zdCB1cmwgPSAoZGVuaWVkLmZpbmQoKFssIGVycl0pID0-IGVyci5hbGxvd1VybCkgfHwgW10pWzFdOwogICAgICAgIGNvbnN0IGZpeCA9IEMuY3R4LmNvbm5lY3QgPyBidXR0b24oJ0Nvbm5lY3QgYWdhaW4nLCAndGV4dCcsIGNvbm5lY3QpCiAgICAgICAgICA6IHVybCA_IGgoJ2EnLCB7CiAgICAgICAgICAgIGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgaHJlZjogdXJsLmFsbG93VXJsLCB0YXJnZXQ6ICdfYmxhbmsnLCByZWw6ICdub29wZW5lciBub3JlZmVycmVyJywgdGV4dDogJ0FsbG93JywKICAgICAgICAgICAgZGF0YXNldDogeyBrZXk6ICdjYWwtYWxsb3cnIH0sIG9uY2xpY2s6ICgpID0-IHsgQy5yZWNoZWNrID0gdHJ1ZTsgfSwKICAgICAgICAgIH0pCiAgICAgICAgICA6IGgoJ3NwYW4nLCB7IHRleHQ6ICcgSW4gdGhlIHNjcmlwdCBlZGl0b3IsIHJ1biBhbGxvd0NhbGVuZGFyIG9uY2UuJyB9KTsKICAgICAgICBsaW5lcy5wdXNoKGgoJ3AnLCB7fSwKICAgICAgICAgIGgoJ3N0cm9uZycsIHsgdGV4dDogZGVuaWVkLm1hcCgoW3NlcnZpY2VdKSA9PiBuYW1lKHNlcnZpY2UpKS5qb2luKCcgYW5kICcpIH0pLAogICAgICAgICAgYCAke2RlbmllZC5sZW5ndGggPiAxID8gJ25lZWQnIDogJ25lZWRzJ30geW91ciBwZXJtaXNzaW9uLiBgLCBmaXgpKTsKICAgICAgfQogICAgICBmb",
"3IgKGNvbnN0IFtzZXJ2aWNlLCBlcnJdIG9mIGVycm9ycykgewogICAgICAgIGlmIChlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX3Njb3BlJykgY29udGludWU7CiAgICAgICAgbGluZXMucHVzaChoKCdwJywge30sIGgoJ3N0cm9uZycsIHsgdGV4dDogYCR7bmFtZShzZXJ2aWNlKX06IGAgfSksIGxpbmtlZChlcnIubWVzc2FnZSB8fCBTdHJpbmcoZXJyKSkpKTsKICAgICAgfQogICAgfQogICAgZWxzLm5vdGUucmVwbGFjZUNoaWxkcmVuKC4uLmxpbmVzKTsKICAgIGVscy5ub3RlLmhpZGRlbiA9ICFsaW5lcy5sZW5ndGg7CiAgfQoKICBmdW5jdGlvbiBkcmF3U291cmNlcygpIHsKICAgIGNvbnN0IGxpc3QgPSBDLnNvdXJjZXM7CiAgICBlbHMuc291cmNlcy5oaWRkZW4gPSAhbGlzdC5sZW5ndGggfHwgISFzdGF0dXNQYW5lbCgpOwogICAgZWxzLnNvdXJjZXMucmVwbGFjZUNoaWxkcmVuKC4uLmxpc3QubWFwKHMgPT4gdGludChoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiBbJ3NyYycsIGBzcmMtJHtzLmtpbmR9YF0sIHR5cGU6ICdidXR0b24nLCAnYXJpYS1wcmVzc2VkJzogU3RyaW5nKGlzT24ocykpLAogICAgICB0aXRsZTogYCR7aXNPbihzKSA_ICdIaWRlJyA6ICdTaG93J30gJHtzLm5hbWV9YCwgZGF0YXNldDogeyBrZXk6IGBjYWwtc3JjOiR7cy5pZH1gIH0sCiAgICAgIG9uY2xpY2s6ICgpID0-IHRvZ2dsZVNvdXJjZShzKSwKICAgIH0sIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3dhdGNoJywgJ2FyaWEtaGlkZGVuJzogJ",
"3RydWUnIH0pLCBoKCdzcGFuJywgeyBjbGFzczogJ3NyYy1uYW1lJywgdGV4dDogcy5uYW1lIH0pKSwgJy0tc3JjJywgcy5jb2xvdXIpKSk7CiAgfQoKICAvLyBPdmVyZHVlIHRhc2tzIGFscmVhZHkgb24gYSBkYXkgb24gc2NyZWVuIGFyZSBub3QgbGlzdGVkIHR3aWNlLgogIGZ1bmN0aW9uIGRyYXdUcmF5KCkgewogICAgY29uc3QgcGFuZWxVcCA9ICEhc3RhdHVzUGFuZWwoKTsKICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgY29uc3QgdCA9IGNhbC50cmF5KHZpc2libGVJdGVtcygpLCBDLnRvZGF5KTsKICAgIHQub3ZlcmR1ZSA9IHQub3ZlcmR1ZS5maWx0ZXIoeCA9PiB4LmR1ZSA8IHIuc3RhcnQgfHwgeC5kdWUgPj0gci5lbmQpOwogICAgY29uc3QgZ3JvdXAgPSAobGFiZWwsIGxpc3QpID0-IChsaXN0Lmxlbmd0aCA_IFsKICAgICAgaCgnaDMnLCB7fSwgbGFiZWwsIGgoJ3NwYW4nLCB7IGNsYXNzOiAnY291bnQnLCB0ZXh0OiBgIMK3ICR7bGlzdC5sZW5ndGh9YCB9KSksCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtaXRlbXMnIH0sIGxpc3QubWFwKHggPT4gaXRlbUVsKHsgaXRlbTogeCwgY29udDogZmFsc2UgfSwgeyBkdWU6IGxhYmVsID09PSAnT3ZlcmR1ZScgfSkpKSwKICAgIF0gOiBbXSk7CiAgICBjb25zdCBraWRzID0gWy4uLmdyb3VwKCdPdmVyZHVlJywgdC5vdmVyZHVlKSwgLi4uZ3JvdXAoJ05vIGRhdGUnLCB0LnVuZGF0ZWQpXTsKICAgIGVscy50cmF5LnJlcGxhY2VDaGlsZHJlbiguLi5raWRzK",
"TsKICAgIGVscy50cmF5LmhpZGRlbiA9IHBhbmVsVXAgfHwgIWtpZHMubGVuZ3RoOwogIH0KCiAgZnVuY3Rpb24gZHJhd01pbmkoKSB7CiAgICBlbHMubWluaS5yZXBsYWNlQ2hpbGRyZW4obWluaU1vbnRoKCkpOwogIH0KCiAgLy8gVGhlIHNtYWxsIG1vbnRoOiB0aGUgbW9udGggaW4gZm9jdXMsIHRoZSBkYXlzIG9uIHNjcmVlbiBtYXJrZWQ7IGEKICAvLyB0YXAgb24gYSBkYXkgZ29lcyB0aGVyZS4KICBmdW5jdGlvbiBtaW5pTW9udGgoKSB7CiAgICBjb25zdCByID0gcmFuZ2UoKTsKICAgIGNvbnN0IG0gPSBjYWwubW9udGhOYW1lKEMuYW5jaG9yKTsKICAgIGNvbnN0IHJvd3MgPSBjYWwubW9udGhXZWVrcyhDLmFuY2hvcik7CiAgICBjb25zdCBtb250aCA9IEMuYW5jaG9yLnNsaWNlKDAsIDcpOwogICAgY29uc3QgbmFtZSA9IGAke20ubG9uZ30ke20ueWVhciAhPT0gTnVtYmVyKEMudG9kYXkuc2xpY2UoMCwgNCkpID8gYCAke20ueWVhcn1gIDogJyd9YDsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnbWluaScgfSwKICAgICAgLy8gTmFycm93LCB0aGUgbW9udGggYXMgdGhlIHdlZWsncyBlaWdodGggdGlsZTogaXRzIG5hbWUgb3BlbnMgaXQuCiAgICAgIEMubmFycm93ID8gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnbWluaS1oZWFkJywgdHlwZTogJ2J1dHRvbicsIHRleHQ6IG5hbWUsIHRpdGxlOiAnU2hvdyB0aGUgbW9udGgnLCBkYXRhc2V0OiB7IGtleTogJ2NhbC1taW5pLW1vbnRoJyB9LAogI",
"CAgICAgIG9uY2xpY2s6ICgpID0-IHNldFZpZXcoJ21vbnRoJyksCiAgICAgIH0pIDogaCgnZGl2JywgeyBjbGFzczogJ21pbmktaGVhZCcsIHRleHQ6IG5hbWUgfSksCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdtaW5pLWdyaWQnLCByb2xlOiAnZ3JpZCcsICdhcmlhLWxhYmVsJzogYCR7bS5sb25nfSAke20ueWVhcn1gIH0sCiAgICAgICAgY2FsLkRBWV9OQU1FUy5tYXAoZCA9PiBoKCdzcGFuJywgeyBjbGFzczogJ21pbmktZG93JywgdGV4dDogZFswXSwgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0pKSwKICAgICAgICByb3dzLmZsYXQoKS5tYXAoayA9PiBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogWydtaW5pLWRheScsIGsuc2xpY2UoMCwgNykgIT09IG1vbnRoICYmICdvdGhlcicsIGsgPT09IEMudG9kYXkgJiYgJ3RvZGF5JywKICAgICAgICAgICAgayA-PSByLnN0YXJ0ICYmIGsgPCByLmVuZCAmJiAnc2hvd24nXSwKICAgICAgICAgIHR5cGU6ICdidXR0b24nLCB0ZXh0OiBTdHJpbmcoTnVtYmVyKGsuc2xpY2UoOCkpKSwgJ2FyaWEtbGFiZWwnOiBsb25nRGF0ZShrKSwKICAgICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgY2FsLW1pbmk6JHtrfWAgfSwgb25jbGljazogKCkgPT4gZ28oayksCiAgICAgICAgfSkpKSk7CiAgfQoKICBmdW5jdGlvbiBsb25nRGF0ZShrKSB7CiAgICBjb25zdCBtID0gY2FsLm1vbnRoTmFtZShrKTsKICAgIHJldHVybiBgJHtjYWwuZGF5TmFtZShrKX0gJHtOdW1iZXIoay5zbGljZ",
"Sg4KSl9ICR7bS5sb25nfSAke20ueWVhcn1gOwogIH0KCiAgZnVuY3Rpb24gZGF5SGVhZChrKSB7CiAgICByZXR1cm4gaCgnaGVhZGVyJywgeyBjbGFzczogJ2RheS1oZWFkJyB9LAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RuYW1lJywgdGV4dDogY2FsLmRheU5hbWUoaykgfSksCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZG51bScsIHRleHQ6IFN0cmluZyhOdW1iZXIoay5zbGljZSg4KSkpIH0pLAogICAgICBrID09PSBDLnRvZGF5ID8gaCgnc3BhbicsIHsgY2xhc3M6ICdiYWRnZScsIHRleHQ6ICd0b2RheScgfSkgOiBudWxsLAogICAgICBhZGRCdXR0b24oaykpOwogIH0KCiAgLy8gVGhlICsgb24gYSBkYXk6IGEgbmV3IGV2ZW50IG9yIHRhc2sgb24gaXQsIGlmIHRoZXJlIGlzIGFueXdoZXJlIHRvCiAgLy8gcHV0IG9uZS4KICBmdW5jdGlvbiBhZGRCdXR0b24oaykgewogICAgaWYgKCFjYW5DaGFuZ2UoKSB8fCAhd3JpdGFibGUoKS5sZW5ndGgpIHJldHVybiBudWxsOwogICAgY29uc3QgbGFiZWwgPSBgQWRkIHRvICR7bG9uZ0RhdGUoayl9YDsKICAgIHJldHVybiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnaWNvbi1idG4gZGF5LWFkZCcsIHR5cGU6ICdidXR0b24nLCB0aXRsZTogbGFiZWwsICdhcmlhLWxhYmVsJzogbGFiZWwsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgY2FsLWFkZDoke2t9YCB9LCBvbmNsaWNrOiAoKSA9PiBvcGVuRWRpdG9yKG51bGwsIGspLAogICAgfSwgaWNvbignYWRkJywgM",
"TgpKTsKICB9CgogIGZ1bmN0aW9uIGRheUNsYXNzZXMoaywgYmFzZSkgewogICAgY29uc3Qgd2QgPSBjYWwud2Vla2RheShrKTsKICAgIHJldHVybiBbYmFzZSwgayA9PT0gQy50b2RheSAmJiAndG9kYXknLCB3ZCA-PSA1ICYmICd3ZWVrZW5kJywgd2QgPT09IDYgJiYgJ3N1bmRheScsIGsgPCBDLnRvZGF5ICYmICdwYXN0J107CiAgfQoKICAvLyBUaGUgd2VlayBpcyBvbmUgZWxlbWVudCwga2VwdDogaXRzIGRheXMgYXJlIGRyYXduIGFmcmVzaCBlYWNoIHRpbWUsCiAgLy8gYnV0IHRoZSBzY3JhdGNocGFkIHRpbGUgaW4gdGhlIHR3byByb3dzJyBlaWdodGggc3BhY2UgaXMgb25seSBldmVyCiAgLy8gbW92ZWQgaW4gb3Igb3V0LCBuZXZlciB0YWtlbiBvdXQgYW5kIHB1dCBiYWNrIC0gdGhhdCB3b3VsZCB0YWtlIHRoZQogIC8vIGN1cnNvciBvdXQgb2YgaXQgd2hlbmV2ZXIgdGhlIHdlZWsgd2FzIHJlZHJhd24gbWlkLXNlbnRlbmNlLgogIGZ1bmN0aW9uIGRyYXdXZWVrKCkgewogICAgY29uc3QgciA9IHJhbmdlKCk7CiAgICBjb25zdCBrZXlzID0gY2FsLmRheXMoci5zdGFydCwgci5lbmQpOwogICAgY29uc3QgYnlEYXkgPSBjYWwuYnlEYXkodmlzaWJsZUl0ZW1zKCksIGtleXMpOwogICAgY29uc3QgbG9hZGluZyA9IEMuc3RhdHVzID09PSAnbG9hZGluZycgJiYgIUMuc2hvd247CiAgICBjb25zdCB0aWxlID0gIUMubmFycm93ICYmIEMubGF5b3V0ID09PSAncm93cycgJiYgbnMubm90ZXMgPyBucy5ub3Rlcy5zY3Jhd",
"GNoVGlsZSgpIDogbnVsbDsKICAgIGlmICghZWxzLndlZWspIHsKICAgICAgZWxzLndlZWsgPSBoKCdkaXYnLCB7IHJvbGU6ICdsaXN0JyB9KTsKICAgICAgZWxzLndlZWsuYWRkRXZlbnRMaXN0ZW5lcignc2Nyb2xsJywgKCkgPT4gewogICAgICAgIGlmIChlbHMud2Vlay5jbGFzc0xpc3QuY29udGFpbnMoJ2hvdXJzJykpIEMuaG91cnNUb3AgPSBlbHMud2Vlay5zY3JvbGxUb3A7CiAgICAgIH0sIHsgcGFzc2l2ZTogdHJ1ZSB9KTsKICAgIH0KICAgIGNvbnN0IHdlZWsgPSBlbHMud2VlazsKICAgIGNvbnN0IGhvdXJzID0gaXNIb3VycygpOwogICAgd2Vlay5jbGFzc05hbWUgPSBbJ2NhbC13ZWVrJywgaG91cnMgJiYgJ2hvdXJzJywgbG9hZGluZyAmJiAnbG9hZGluZyddLmZpbHRlcihCb29sZWFuKS5qb2luKCcgJyk7CiAgICBmb3IgKGNvbnN0IGtpZCBvZiBbLi4ud2Vlay5jaGlsZHJlbl0pIGlmIChraWQgIT09IHRpbGUpIGtpZC5yZW1vdmUoKTsKICAgIGlmIChob3VycykgewogICAgICB3ZWVrLmFwcGVuZCguLi5kcmF3SG91cnMoa2V5cywgYnlEYXkpKTsKICAgICAgcmV0dXJuIHdlZWs7CiAgICB9CiAgICBjb25zdCBkYXlzID0ga2V5cy5tYXAoayA9PiBoKCdzZWN0aW9uJywgeyBjbGFzczogZGF5Q2xhc3NlcyhrLCAnZGF5JyksIHJvbGU6ICdsaXN0aXRlbScsICdhcmlhLWxhYmVsJzogbG9uZ0RhdGUoayksIGRhdGFzZXQ6IHsgZGF5OiBrLCBkcm9wOiBrIH0gfSwKICAgICAgZGF5SGVhZChrKSwKICAgICAgaCgnZ",
"Gl2JywgeyBjbGFzczogJ2NhbC1pdGVtcycgfSwgYnlEYXkuZ2V0KGspLm1hcChlID0-IGl0ZW1FbChlKSkpKSk7CiAgICAvLyBUaGUgZWlnaHRoIHRpbGUsIGluIHRoZSB0d28gY29sdW1ucyBvZiBhIG5hcnJvdyBzY3JlZW4uCiAgICBkYXlzLnB1c2goaCgnZGl2JywgeyBjbGFzczogJ2RheSBtaW5pLXRpbGUnLCAnYXJpYS1oaWRkZW4nOiBDLm5hcnJvdyA_IG51bGwgOiAndHJ1ZScgfSwgbWluaU1vbnRoKCkpKTsKICAgIGlmICh0aWxlICYmIHRpbGUucGFyZW50Tm9kZSA9PT0gd2VlaykgZGF5cy5mb3JFYWNoKGQgPT4gd2Vlay5pbnNlcnRCZWZvcmUoZCwgdGlsZSkpOwogICAgZWxzZSB3ZWVrLmFwcGVuZCguLi5kYXlzLCAuLi4odGlsZSA_IFt0aWxlXSA6IFtdKSk7CiAgICByZXR1cm4gd2VlazsKICB9CgogIC8vIOKUgOKUgCBUaGUgd2VlayBieSB0aGUgaG91ciDilIDilIAKICAvLwogIC8vIE9uIGEgY29tcHV0ZXIsIGFzIGluIEdvb2dsZSBDYWxlbmRhcjogc2V2ZW4gY29sdW1ucyBiZXNpZGUgdGhlIGhvdXJzLAogIC8vIGVhY2ggZGF5J3MgYWxsLWRheSBldmVudHMgYW5kIHRhc2tzIGFsb25nIHRoZSB0b3AsIGl0cyBvdGhlciBldmVudHMKICAvLyBwbGFjZWQgYnkgdGhlIGhvdXIsIHNpZGUgYnkgc2lkZSB3aGVyZSB0aGV5IG92ZXJsYXAuIFRoZSBkYXkncyBob3VycwogIC8vIGZpbGwgdGhlIHNwYWNlIHRoZXJlIGlzOyB3aXRoIHRoZSBuaWdodCBhcyB3ZWxsLCB0aGV5IHNjcm9sbCB1bmRlciB0aGUKICAvL",
"yBkYXlzJyBoZWFkcy4gQW4gZXZlbnQgY2FuIGJlIGRyYWdnZWQgdG8gYW5vdGhlciB0aW1lIChpbiBxdWFydGVyCiAgLy8gaG91cnMpIG9yIGRheSwgYW5kIGl0cyBib3R0b20gZWRnZSB1cCBvciBkb3duIHRvIGNoYW5nZSB3aGVuIGl0IGVuZHM7CiAgLy8gYSBjbGljayBvbiBhbiBlbXB0eSBoYWxmIGhvdXIgYWRkcyBvbmUgdGhlcmUuCgogIGNvbnN0IGlzSG91cnMgPSAoKSA9PiAhQy5uYXJyb3cgJiYgdmlldygpID09PSAnd2VlaycgJiYgQy5sYXlvdXQgPT09ICdjb2x1bW5zJzsKCiAgY29uc3QgcGFkMiA9IG4gPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsICcwJyk7CiAgY29uc3QgY2xvY2sgPSBtaW4gPT4gYCR7cGFkMihNYXRoLmZsb29yKG1pbiAvIDYwKSAlIDI0KX06JHtwYWQyKG1pbiAlIDYwKX1gOwogIGNvbnN0IG1pbnV0ZU9mID0gbXMgPT4geyBjb25zdCBkID0gbmV3IERhdGUobXMpOyByZXR1cm4gZC5nZXRIb3VycygpICogNjAgKyBkLmdldE1pbnV0ZXMoKTsgfTsKICBjb25zdCBkYXlTdGFydCA9IGsgPT4geyBjb25zdCBbeSwgbSwgZF0gPSBrLnNwbGl0KCctJykubWFwKE51bWJlcik7IHJldHVybiBuZXcgRGF0ZSh5LCBtIC0gMSwgZCkuZ2V0VGltZSgpOyB9OwoKICBmdW5jdGlvbiBzZXRWYXJzKGVsLCB2YXJzKSB7CiAgICBmb3IgKGNvbnN0IFtuYW1lLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFycykpIGVsLnN0eWxlLnNldFByb3BlcnR5KG5hbWUsIFN0cmluZyh2YWx1ZSkpOwogICAgcmV0d",
"XJuIGVsOwogIH0KCiAgZnVuY3Rpb24gZHJhd0hvdXJzKGtleXMsIGJ5RGF5KSB7CiAgICAvLyBBbGwtZGF5IGV2ZW50cyBhbmQgdGFza3M6IGEgcm93IHRhbGwgZW5vdWdoIGZvciB0aGUgYnVzaWVzdCBkYXksCiAgICAvLyB1cCB0byBmb3VyOyBtb3JlIHRoYW4gdGhhdCBzY3JvbGwgd2l0aGluIHRoZWlyIGRheS4KICAgIGNvbnN0IHVudGltZWQgPSBrID0-IGJ5RGF5LmdldChrKS5maWx0ZXIoZSA9PiBlLml0ZW0ua2luZCAhPT0gJ2V2ZW50JyB8fCBlLml0ZW0uYWxsRGF5KTsKICAgIGNvbnN0IHJvd3MgPSBNYXRoLm1pbig0LCBNYXRoLm1heCgxLCAuLi5rZXlzLm1hcChrID0-IHVudGltZWQoaykubGVuZ3RoKSkpOwogICAgc2V0VmFycyhlbHMud2VlaywgeyAnLS1hbGxkYXktcm93cyc6IHJvd3MgfSk7CiAgICBlbHMud2Vlay5kYXRhc2V0LnpvbmVzID0gQy56b25lMiA_ICcyJyA6ICcxJzsKICAgIC8vIFRoZSBkYXkncyBob3VycywgYW5kIGFueSBvZiB0aGUgbmlnaHQncyB0aGF0IHNvbWV0aGluZyBpcyBvbiBpbi4KICAgIGNvbnN0IHBsYWNlZCA9IGtleXMubWFwKGsgPT4gY2FsLmRheUxheW91dChieURheS5nZXQoayksIGspKTsKICAgIGxldCBbZnJvbSwgdG9dID0gQy5uaWdodCA_IFswLCAxNDQwXSA6IFtEQVlfRlJPTSwgREFZX1RPXTsKICAgIGZvciAoY29uc3QgcCBvZiBwbGFjZWQuZmxhdCgpKSB7CiAgICAgIGZyb20gPSBNYXRoLm1pbihmcm9tLCBNYXRoLmZsb29yKHAuZnJvbSAvIDYwKSAqIDYwKTsKI",
"CAgICAgdG8gPSBNYXRoLm1heCh0bywgTWF0aC5jZWlsKHAudG8gLyA2MCkgKiA2MCk7CiAgICB9CiAgICBDLnNwYW4gPSBbZnJvbSwgdG9dOwogICAgc2V0VmFycyhlbHMud2VlaywgeyAnLS1zcGFuLWZyb20nOiBmcm9tLCAnLS1ob3Vycyc6ICh0byAtIGZyb20pIC8gNjAgfSk7CiAgICBlbHMud2Vlay5kYXRhc2V0LnNwYW4gPSBgJHtmcm9tfS0ke3RvfWA7CiAgICBjb25zdCBub3cgPSBtaW51dGVPZihEYXRlLm5vdygpKTsKICAgIGNvbnN0IGRheXMgPSBrZXlzLm1hcCgoaywgaSkgPT4gaCgnc2VjdGlvbicsIHsKICAgICAgY2xhc3M6IGRheUNsYXNzZXMoaywgJ2RheScpLCByb2xlOiAnbGlzdGl0ZW0nLCAnYXJpYS1sYWJlbCc6IGxvbmdEYXRlKGspLCBkYXRhc2V0OiB7IGRheTogaywgZHJvcDogayB9LAogICAgfSwKICAgIGRheUhlYWQoayksCiAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWl0ZW1zIGdyaWQtYWxsZGF5JyB9LCB1bnRpbWVkKGspLm1hcChlID0-IGl0ZW1FbChlKSkpLAogICAgaG91cnNCb2R5KGssIHBsYWNlZFtpXSwgayA9PT0gQy50b2RheSA_IG5vdyA6IC0xKSkpOwogICAgcmV0dXJuIFtob3Vyc0NvbHVtbihrZXlzKSwgLi4uZGF5c107CiAgfQoKICBmdW5jdGlvbiBob3Vyc0JvZHkoaywgcGxhY2VkLCBub3cpIHsKICAgIGNvbnN0IGJvZHkgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZ3JpZC1ib2R5Jywgb25jbGljazogZSA9PiBjbGlja0hvdXIoZSwgaykgfSk7CiAgICBmb3IgKGNvbnN0IHAgb",
"2YgcGxhY2VkKSBib2R5LmFwcGVuZCguLi50aW1lZEVscyhwLCBrKSk7CiAgICBpZiAobm93ID49IDApIGJvZHkuYXBwZW5kKHBsYWNlTm93KGgoJ2RpdicsIHsgY2xhc3M6ICdub3ctbGluZScsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KSwgbm93KSk7CiAgICByZXR1cm4gYm9keTsKICB9CgogIC8vIFRoZSBsaW5lIGZvciBub3csIHdoZXJlIGl0IGlzIC0gb3Igbm9uZSwgaW4gdGhlIG5pZ2h0IGxlZnQgb3V0LgogIGZ1bmN0aW9uIHBsYWNlTm93KGxpbmUsIG5vdykgewogICAgbGluZS5oaWRkZW4gPSBub3cgPCBDLnNwYW5bMF0gfHwgbm93ID49IEMuc3BhblsxXTsKICAgIHJldHVybiBzZXRWYXJzKGxpbmUsIHsgJy0tZnJvbSc6IG5vdyB9KTsKICB9CgogIC8vIEFuIGV2ZW50IGluIHRoZSBob3VycywgYW5kIGZvciBvbmUgdGhhdCBlbmRzIHRoYXQgZGF5IGFuZCBjYW4gYmUKICAvLyBjaGFuZ2VkIGhlcmUsIHRoZSBlZGdlIHRoYXQgZHJhZ3MgaXRzIGVuZC4KICBmdW5jdGlvbiB0aW1lZEVscyhwLCBrKSB7CiAgICBjb25zdCB7IGl0ZW0gfSA9IHA7CiAgICBjb25zdCBwbGFjZSA9IHsgJy0tZnJvbSc6IHAuZnJvbSwgJy0tdG8nOiBwLnRvLCAnLS1jb2wnOiBwLmNvbCwgJy0tY29scyc6IHAuY29scyB9OwogICAgY29uc3QgZWwgPSBzZXRWYXJzKGl0ZW1FbCh7IGl0ZW0sIGNvbnQ6IHAuY29udCB9LCB7IGhvdXJzOiBwIH0pLCBwbGFjZSk7CiAgICBpZiAoIWl0ZW0uZWRpdGFibGUgfHwgIWNhbkNoYW5nZSgpIHx8I",
"GNhbC5kYXRlS2V5KGl0ZW0uZW5kIC0gMSkgIT09IGspIHJldHVybiBbZWxdOwogICAgY29uc3QgZWRnZSA9IGgoJ3NwYW4nLCB7CiAgICAgIGNsYXNzOiAnZ3JpZC1yZXNpemUnLCB0aXRsZTogYERyYWcgdG8gY2hhbmdlIHdoZW4g4oCcJHtpdGVtLnRpdGxlfeKAnSBlbmRzYCwgJ2FyaWEtaGlkZGVuJzogJ3RydWUnLAogICAgICBvbnBvaW50ZXJkb3duOiBlID0-IHN0YXJ0UmVzaXplKGUsIHAsIGssIGVsKSwKICAgICAgb25jbGljazogKCkgPT4gb3BlbkVkaXRvcihpdGVtKSwKICAgIH0pOwogICAgcmV0dXJuIFtlbCwgc2V0VmFycyhlZGdlLCBwbGFjZSldOwogIH0KCiAgLy8gVGhlIGhvdXJzIGRvd24gdGhlIHNpZGUsIGluIHlvdXIgb3duIHRpbWUgem9uZSwgYW5kIGJlc2lkZSB0aGVtIGluIGEKICAvLyBzZWNvbmQgb25lIGlmIGNob3Nlbi4gSXRzIGhvdXJzIGFyZSB3b3JrZWQgb3V0IGZvciB0b2RheSwgb3IgZm9yIHRoZQogIC8vIHdlZWsncyBmaXJzdCBkYXk6IGluIGEgd2VlayB3aGVyZSBvbmUgb2YgdGhlIHR3byBwdXRzIGl0cyBjbG9ja3MKICAvLyBmb3J3YXJkIG9yIGJhY2sgYW5kIHRoZSBvdGhlciBkb2VzIG5vdCwgdGhleSBhcmUgYW4gaG91ciBvdXQgb24gdGhlCiAgLy8gZGF5cyBiZWZvcmUgdGhlIGNoYW5nZS4KICBmdW5jdGlvbiBob3Vyc0NvbHVtbihrZXlzKSB7CiAgICBjb25zdCBiYXNlID0ga2V5cy5pbmNsdWRlcyhDLnRvZGF5KSA_IEMudG9kYXkgOiBrZXlzWzBdOwogICAgY29uc3QgW3ksI",
"G0sIGRdID0gYmFzZS5zcGxpdCgnLScpLm1hcChOdW1iZXIpOwogICAgY29uc3QgYXQgPSBociA9PiBuZXcgRGF0ZSh5LCBtIC0gMSwgZCwgaHIpOwogICAgY29uc3QgaGVyZSA9IHRpbWVab25lKCk7CiAgICBjb25zdCB6b25lcyA9IEMuem9uZTIgPyBbQy56b25lMiwgaGVyZV0gOiBbaGVyZV07CiAgICBjb25zdCBsYWJlbCA9IHogPT4gYCR7eiA9PT0gaGVyZSA_ICdZb3VyIHRpbWUgem9uZScgOiAnU2Vjb25kIHRpbWUgem9uZSd9OiAke3pvbmVOYW1lKHopfSAoJHt6b25lU2hvcnQoeiwgYXQoMTIpKX0pYDsKICAgIGNvbnN0IGNvcm5lciA9IGgoJ2RpdicsIHsgY2xhc3M6ICdncmlkLWNvcm5lcicgfSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnZ3JpZC16b25lcycsIHR5cGU6ICdidXR0b24nLCBkYXRhc2V0OiB7IGtleTogJ2NhbC16b25lcycgfSwgb25jbGljazogb3BlblpvbmVzLAogICAgICAgIHRpdGxlOiBgJHt6b25lcy5tYXAobGFiZWwpLmpvaW4oJ1xuJyl9XG5DbGljayB0byAke0Muem9uZTIgPyAnY2hhbmdlIG9yIHJlbW92ZSB0aGUgc2Vjb25kJyA6ICdhZGQgYSBzZWNvbmQnfSB0aW1lIHpvbmUuYCwKICAgICAgICAnYXJpYS1sYWJlbCc6IEMuem9uZTIgPyAnVGltZSB6b25lcycgOiAnQWRkIGEgc2Vjb25kIHRpbWUgem9uZScsCiAgICAgIH0sCiAgICAgIHpvbmVzLm1hcCh6ID0-IGgoJ3NwYW4nLCB7IGNsYXNzOiB6ID09PSBoZXJlID8gJ293bicgOiAnb3RoZXInLCB0ZXh0OiB6b",
"25lU2hvcnQoeiwgYXQoMTIpKSB9KSksCiAgICAgIEMuem9uZTIgPyBudWxsIDogaWNvbignYWRkJywgMTQpKSk7CiAgICBjb25zdCBob3VycyA9IFtdOwogICAgZm9yIChsZXQgaHIgPSBDLnNwYW5bMF0gLyA2MDsgaHIgPCBDLnNwYW5bMV0gLyA2MDsgaHIrKykgewogICAgICBob3Vycy5wdXNoKGgoJ2RpdicsIHsgY2xhc3M6ICdncmlkLWhvdXInIH0sIHpvbmVzLm1hcCh6ID0-IGgoJ3NwYW4nLCB7CiAgICAgICAgY2xhc3M6IHogPT09IGhlcmUgPyAnb3duJyA6ICdvdGhlcicsIHRleHQ6IHogPT09IGhlcmUgPyBjbG9jayhociAqIDYwKSA6IHpvbmVDbG9jayh6LCBhdChocikpLAogICAgICB9KSkpKTsKICAgIH0KICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnZ3JpZC10aW1lcycgfSwgY29ybmVyLCBoKCdkaXYnLCB7IGNsYXNzOiAnZ3JpZC1ob3VycycsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9LCBob3VycykpOwogIH0KCiAgY29uc3Qgem9uZUZvcm1hdHMgPSBuZXcgTWFwKCk7CiAgZnVuY3Rpb24gem9uZUZvcm1hdCh6LCBvcHRpb25zKSB7CiAgICBjb25zdCBrZXkgPSBgJHt6fXwke0pTT04uc3RyaW5naWZ5KG9wdGlvbnMpfWA7CiAgICBpZiAoIXpvbmVGb3JtYXRzLmhhcyhrZXkpKSB6b25lRm9ybWF0cy5zZXQoa2V5LCBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tR0InLCBPYmplY3QuYXNzaWduKHsgdGltZVpvbmU6IHogfHwgdW5kZWZpbmVkIH0sIG9wdGlvbnMpKSk7CiAgICByZXR1cm4gem9uZ",
"UZvcm1hdHMuZ2V0KGtleSk7CiAgfQoKICBmdW5jdGlvbiBpc1pvbmUoeikgewogICAgaWYgKHR5cGVvZiB6ICE9PSAnc3RyaW5nJyB8fCAheikgcmV0dXJuIGZhbHNlOwogICAgdHJ5IHsgem9uZUZvcm1hdCh6LCB7fSk7IHJldHVybiB0cnVlOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9CiAgfQoKICAvLyAiR01UKzIiLCAiR01UKzU6MzAiLCAiR01UIi4KICBmdW5jdGlvbiB6b25lU2hvcnQoeiwgd2hlbikgewogICAgdHJ5IHsKICAgICAgY29uc3QgcGFydCA9IHpvbmVGb3JtYXQoeiwgeyB0aW1lWm9uZU5hbWU6ICdzaG9ydE9mZnNldCcgfSkuZm9ybWF0VG9QYXJ0cyh3aGVuKS5maW5kKHggPT4geC50eXBlID09PSAndGltZVpvbmVOYW1lJyk7CiAgICAgIHJldHVybiBwYXJ0ID8gcGFydC52YWx1ZSA6IHo7CiAgICB9IGNhdGNoIHsgcmV0dXJuIHo7IH0KICB9CgogIGNvbnN0IHpvbmVOYW1lID0geiA9PiBTdHJpbmcoeikucmVwbGFjZSgvXy9nLCAnICcpOwogIGNvbnN0IHpvbmVDbG9jayA9ICh6LCB3aGVuKSA9PiB6b25lRm9ybWF0KHosIHsgaG91cjogJzItZGlnaXQnLCBtaW51dGU6ICcyLWRpZ2l0JywgaG91ckN5Y2xlOiAnaDIzJyB9KS5mb3JtYXQod2hlbik7CgogIGZ1bmN0aW9uIHpvbmVMaXN0KCkgewogICAgdHJ5IHsgcmV0dXJuIEludGwuc3VwcG9ydGVkVmFsdWVzT2YoJ3RpbWVab25lJyk7IH0gY2F0Y2ggeyByZXR1cm4gWydFdXJvcGUvTG9uZG9uJywgJ0V1cm9wZS9BbXN0ZXJkYW0nLCAnQW1lcmljY",
"S9OZXdfWW9yaycsICdBbWVyaWNhL0xvc19BbmdlbGVzJywgJ0FzaWEvVG9reW8nLCAnVVRDJ107IH0KICB9CgogIC8vIFRoZSBzZWNvbmQgdGltZSB6b25lOiBjaG9zZW4gZnJvbSBhbGwgb2YgdGhlbSwgb3Igbm9uZS4KICBmdW5jdGlvbiBvcGVuWm9uZXMoKSB7CiAgICBpZiAoIUMuY3R4LmRpYWxvZykgcmV0dXJuOwogICAgY29uc3QgaGVyZSA9IHRpbWVab25lKCk7CiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpOwogICAgY29uc3Qgc2VsZWN0ID0gaCgnc2VsZWN0JywgeyBjbGFzczogJ3RleHQtaW5wdXQnLCBpZDogJ2drYi1jYWwtem9uZTInLCBkYXRhc2V0OiB7IGtleTogJ2NhbC16b25lMicgfSB9LAogICAgICBoKCdvcHRpb24nLCB7IHZhbHVlOiAnJywgdGV4dDogJ05vbmUnIH0pLAogICAgICB6b25lTGlzdCgpLmZpbHRlcih6ID0-IHogIT09IGhlcmUpLm1hcCh6ID0-IGgoJ29wdGlvbicsIHsKICAgICAgICB2YWx1ZTogeiwgdGV4dDogYCR7em9uZU5hbWUoeil9ICgke3pvbmVTaG9ydCh6LCBub3cpfSlgLCBzZWxlY3RlZDogeiA9PT0gQy56b25lMiwKICAgICAgfSkpKTsKICAgIGNvbnN0IGRvbmUgPSAoKSA9PiB7CiAgICAgIEMuem9uZTIgPSBpc1pvbmUoc2VsZWN0LnZhbHVlKSA_IHNlbGVjdC52YWx1ZSA6ICcnOwogICAgICBzYXZlUHJlZignY2FsZW5kYXJab25lMicsIEMuem9uZTIpOwogICAgICBDLmN0eC5kaWFsb2cuY2xvc2UoKTsKICAgICAgZHJhdygpOwogICAgfTsKICAgIEMuY3R4LmRpYWxvZ",
"y5zaG93KGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2cgY2FsLXpvbmVzJywgcm9sZTogJ2RpYWxvZycsICdhcmlhLW1vZGFsJzogJ3RydWUnLCAnYXJpYS1sYWJlbGxlZGJ5JzogJ2drYi1jYWwtem9uZXMtaGVhZGluZycgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1oZWFkJyB9LAogICAgICAgIGgoJ2gyJywgeyBpZDogJ2drYi1jYWwtem9uZXMtaGVhZGluZycsIHRleHQ6ICdUaW1lIHpvbmVzJyB9KSwKICAgICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQ2xvc2UnLCBvbmNsaWNrOiAoKSA9PiBDLmN0eC5kaWFsb2cuY2xvc2UoKSB9LCBpY29uKCdjbG9zZScpKSksCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2ctYm9keScgfSwKICAgICAgICBoKCdwJywgeyBjbGFzczogJ25vdGUnLCB0ZXh0OiBgVGhlIGhvdXJzIGFyZSBpbiB5b3VyIG93biB0aW1lIHpvbmUsICR7em9uZU5hbWUoaGVyZSl9ICgke3pvbmVTaG9ydChoZXJlLCBub3cpfSksIGFzIHNldCBvbiB0aGlzICR7Qy5jdHguY29ubmVjdCA_ICdjb21wdXRlcicgOiAnZGV2aWNlJ30uIEEgc2Vjb25kIG9uZSBzaG93cyBiZXNpZGUgdGhlbS5gIH0pLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWNhbC16b25lMicsIHRleHQ6ICdTZWNvbmQgd",
"GltZSB6b25lJyB9KSwKICAgICAgICAgIHNlbGVjdCkpLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZGlhbG9nLWZvb3QnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdidG4gYnRuLXRleHQnLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ0NhbmNlbCcsIG9uY2xpY2s6ICgpID0-IEMuY3R4LmRpYWxvZy5jbG9zZSgpIH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdidG4gYnRuLXByaW1hcnknLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ0RvbmUnLCBkYXRhc2V0OiB7IGtleTogJ2NhbC16b25lcy1kb25lJyB9LCBvbmNsaWNrOiBkb25lIH0pKSksCiAgICB7IG9uQ2xvc2U6ICgpID0-IGZvY3VzS2V5KCdjYWwtem9uZXMnKSB9KTsKICAgIHNlbGVjdC5mb2N1cygpOwogIH0KCiAgLy8gV2hlcmUgaW4gdGhlIGRheSBhIHBvaW50IG9uIHRoZSBob3VycyBpcywgaW4gbWludXRlcyBhZnRlciBtaWRuaWdodDsKICAvLyBhbmQgdGhhdCB0byB0aGUgbmVhcmVzdCBgc3RlcGAgKG9yIHRoZSBvbmUgYmVmb3JlLCB3aXRoIGBmbG9vcmApLAogIC8vIGJldHdlZW4gYGxvYCBhbmQgYGhpYC4KICBmdW5jdGlvbiBtaW51dGVBdChib2R5LCB5KSB7CiAgICBjb25zdCByID0gYm9keS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgIGNvbnN0IFtmcm9tLCB0b10gPSBDLnNwYW47CiAgICByZXR1cm4gZnJvbSArICh5IC0gci50b3ApIC8gK",
"HIuaGVpZ2h0IC8gKHRvIC0gZnJvbSkpOwogIH0KICBjb25zdCBzbmFwID0gKG1pbiwgc3RlcCwgbG8sIGhpLCBmbG9vciA9IGZhbHNlKSA9PgogICAgTWF0aC5taW4oaGksIE1hdGgubWF4KGxvLCAoZmxvb3IgPyBNYXRoLmZsb29yKG1pbiAvIHN0ZXApIDogTWF0aC5yb3VuZChtaW4gLyBzdGVwKSkgKiBzdGVwKSk7CgogIC8vIEEgY2xpY2sgb24gYW4gZW1wdHkgaGFsZiBob3VyOiBhIG5ldyBldmVudCB0aGVyZSwgYW4gaG91ciBsb25nLgogIGZ1bmN0aW9uIGNsaWNrSG91cihlLCBrKSB7CiAgICBpZiAoZS50YXJnZXQgIT09IGUuY3VycmVudFRhcmdldCB8fCAhY2FuQ2hhbmdlKCkgfHwgIXdyaXRhYmxlKCdjYWxlbmRhcicpLmxlbmd0aCkgcmV0dXJuOwogICAgb3BlbkVkaXRvcihudWxsLCBrLCBzbmFwKG1pbnV0ZUF0KGUuY3VycmVudFRhcmdldCwgZS5jbGllbnRZKSwgQ0xJQ0tfTUlOLCBDLnNwYW5bMF0sIEMuc3BhblsxXSAtIENMSUNLX01JTiwgdHJ1ZSkpOwogIH0KCiAgLy8gVGhlIGJvdHRvbSBlZGdlIG9mIGFuIGV2ZW50LCBkcmFnZ2VkOiB3aGVyZSBpdCBlbmRzLCBpbiBxdWFydGVyIGhvdXJzLAogIC8vIG5vdCBiZWZvcmUgYSBxdWFydGVyIGhvdXIgYWZ0ZXIgaXQgc3RhcnRzLiBGb2xsb3dlZCBvbiB0aGUgd2luZG93LCBzbwogIC8vIHRoYXQgaXQgZW5kcyB3aGVyZXZlciB0aGUgYnV0dG9uIGlzIGxldCBnbyAtIGV2ZW4gaWYgdGhlIGRheXMgYXJlCiAgLy8gcmVkcmF3biBtZWFud2hpbGUuIEEgYnV0d",
"G9uIGxldCBnbyB1bnNlZW4gKG91dHNpZGUgdGhlIHdpbmRvdykgZW5kcwogIC8vIGl0IHdpdGggbm90aGluZyBjaGFuZ2VkLCBub3QgYXQgdGhlIG5leHQgY2xpY2suCiAgZnVuY3Rpb24gc3RhcnRSZXNpemUoZSwgcCwgaywgZWwpIHsKICAgIGlmIChlLmJ1dHRvbikgcmV0dXJuOwogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgZS5zdG9wUHJvcGFnYXRpb24oKTsKICAgIGNvbnN0IGJvZHkgPSBlLmN1cnJlbnRUYXJnZXQucGFyZW50Tm9kZTsKICAgIGNvbnN0IGVkZ2UgPSBlLmN1cnJlbnRUYXJnZXQ7CiAgICB0cnkgeyBlZGdlLnNldFBvaW50ZXJDYXB0dXJlKGUucG9pbnRlcklkKTsgfSBjYXRjaCB7IC8qIHRoZSB3aW5kb3cgc3RpbGwgaGVhcnMgaXQgKi8gfQogICAgbGV0IHRvID0gcC50bzsKICAgIGNvbnN0IHRpbWUgPSBlbC5xdWVyeVNlbGVjdG9yKCcudGltZScpOwogICAgY29uc3QgbW92ZSA9IGV2ID0-IHsKICAgICAgaWYgKCEoZXYuYnV0dG9ucyAmIDEpKSB7IGZpbmlzaCh7IHR5cGU6ICdwb2ludGVyY2FuY2VsJyB9KTsgcmV0dXJuOyB9CiAgICAgIGNvbnN0IG1pbiA9IHNuYXAobWludXRlQXQoYm9keSwgZXYuY2xpZW50WSksIFNURVBfTUlOLCBwLmZyb20gKyBTVEVQX01JTiwgQy5zcGFuWzFdKTsKICAgICAgaWYgKG1pbiA9PT0gdG8pIHJldHVybjsKICAgICAgdG8gPSBtaW47CiAgICAgIHNldFZhcnMoZWwsIHsgJy0tdG8nOiB0byB9KTsKICAgICAgc2V0VmFycyhlZGdlLCB7ICctLXRvJzogdG8gf",
"Sk7CiAgICAgIGlmICh0aW1lKSB0aW1lLnRleHRDb250ZW50ID0gYCR7dGltZVRleHQocC5pdGVtLnN0YXJ0KX0g4oCTICR7Y2xvY2sodG8pfWA7CiAgICB9OwogICAgY29uc3QgZmluaXNoID0gZXYgPT4gewogICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBtb3ZlLCB0cnVlKTsKICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIGZpbmlzaCwgdHJ1ZSk7CiAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVyY2FuY2VsJywgZmluaXNoLCB0cnVlKTsKICAgICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgncmVzaXppbmcnKTsKICAgICAgaWYgKGV2LnR5cGUgIT09ICdwb2ludGVydXAnIHx8IHRvID09PSBwLnRvKSB7CiAgICAgICAgaWYgKHRvICE9PSBwLnRvKSBkcmF3KCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIHN3YWxsb3dDbGljaygpOwogICAgICByZXNpemVJdGVtKHAuaXRlbSwgZGF5U3RhcnQoaykgKyB0byAqIDYwMDAwKTsKICAgIH07CiAgICBlbC5jbGFzc0xpc3QuYWRkKCdyZXNpemluZycpOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgbW92ZSwgdHJ1ZSk7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgZmluaXNoLCB0cnVlKTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVyY2FuY2VsJywgZmluaXNoLCB0cnVlKTsKICB9CgogIC8vI",
"FRoZSBjbGljayB0aGF0IGVuZHMgYSBkcmFnIG9mIGFuIGVkZ2UgaXMgbm90IGEgY2xpY2sgb24gd2hhdCBpcyB1bmRlciBpdC4KICBmdW5jdGlvbiBzd2FsbG93Q2xpY2soKSB7CiAgICBjb25zdCBzdG9wID0gZSA9PiB7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGUucHJldmVudERlZmF1bHQoKTsgfTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHN0b3AsIHsgY2FwdHVyZTogdHJ1ZSwgb25jZTogdHJ1ZSB9KTsKICAgIHNldFRpbWVvdXQoKCkgPT4gd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgc3RvcCwgeyBjYXB0dXJlOiB0cnVlIH0pLCAwKTsKICB9CgogIGZ1bmN0aW9uIGRyYXdNb250aCgpIHsKICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgY29uc3Qga2V5cyA9IGNhbC5kYXlzKHIuc3RhcnQsIHIuZW5kKTsKICAgIGNvbnN0IGJ5RGF5ID0gY2FsLmJ5RGF5KHZpc2libGVJdGVtcygpLCBrZXlzKTsKICAgIGNvbnN0IG1vbnRoID0gQy5hbmNob3Iuc2xpY2UoMCwgNyk7CiAgICBpZiAoQy5uYXJyb3cpIHJldHVybiBwaG9uZU1vbnRoKGtleXMsIGJ5RGF5LCBtb250aCk7CiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1tb250aCcgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ21vbnRoLWRvd3MnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSwgY2FsLkRBWV9OQU1FUy5tYXAoZCA9PiBoKCdzcGFuJywgeyB0ZXh0OiBkIH0pKSksCiAgICAgIHRpbnQoaCgnZGl2J",
"ywgeyBjbGFzczogJ21vbnRoLWdyaWQnIH0sCiAgICAgICAga2V5cy5tYXAoayA9PiB7CiAgICAgICAgICBjb25zdCBhbGwgPSBieURheS5nZXQoayk7CiAgICAgICAgICBjb25zdCBtb3JlID0gYWxsLmxlbmd0aCAtIE1PTlRIX1JPV1M7CiAgICAgICAgICByZXR1cm4gaCgnc2VjdGlvbicsIHsgY2xhc3M6IFsuLi5kYXlDbGFzc2VzKGssICdtY2VsbCcpLCBrLnNsaWNlKDAsIDcpICE9PSBtb250aCAmJiAnb3RoZXInXSwgJ2FyaWEtbGFiZWwnOiBsb25nRGF0ZShrKSwgZGF0YXNldDogeyBkcm9wOiBrIH0gfSwKICAgICAgICAgICAgaCgnZGl2JywgeyBjbGFzczogJ21oZWFkJyB9LAogICAgICAgICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgICAgICAgIGNsYXNzOiAnbWRheScsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiBTdHJpbmcoTnVtYmVyKGsuc2xpY2UoOCkpKSwgdGl0bGU6IGBXZWVrIG9mICR7bG9uZ0RhdGUoayl9YCwKICAgICAgICAgICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgY2FsLWRheToke2t9YCB9LCBvbmNsaWNrOiAoKSA9PiBvcGVuV2VlayhrKSwKICAgICAgICAgICAgICB9KSwKICAgICAgICAgICAgICBhZGRCdXR0b24oaykpLAogICAgICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWl0ZW1zJyB9LCBhbGwuc2xpY2UoMCwgbW9yZSA-IDAgPyBNT05USF9ST1dTIC0gMSA6IE1PTlRIX1JPV1MpLm1hcChlID0-IGl0ZW1FbChlLCB7IGNvbXBhY3Q6IHRydWUgfSkpLAogICAgICAgICAgICAgI",
"G1vcmUgPiAwID8gaCgnYnV0dG9uJywgeyBjbGFzczogJ21vcmUnLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYCske21vcmUgKyAxfSBtb3JlYCwgb25jbGljazogKCkgPT4gb3BlbldlZWsoaykgfSkgOiBudWxsKSk7CiAgICAgICAgfSkpLCAnLS1yb3dzJywgU3RyaW5nKGtleXMubGVuZ3RoIC8gNykpKTsKICB9CgogIC8vIE9uIGEgcGhvbmU6IGVhY2ggZGF5IG9uZSBidXR0b24sIHdpdGggYSBsaW5lIGZvciBlYWNoIG9mIHRoZSBmaXJzdAogIC8vIGZldyB0aGluZ3Mgb24gaXQgaW4gdGhlaXIgY29sb3VyLCBhbmQgIisyIiBmb3IgdGhlIHJlc3Q7IGEgdGFwIG9wZW5zCiAgLy8gdGhhdCBkYXkncyB3ZWVrLCB3aGVyZSB0aGV5IGNhbiBiZSByZWFkIGFuZCBjaGFuZ2VkLgogIGZ1bmN0aW9uIHBob25lTW9udGgoa2V5cywgYnlEYXksIG1vbnRoKSB7CiAgICBjb25zdCBsb2FkaW5nID0gQy5zdGF0dXMgPT09ICdsb2FkaW5nJyAmJiAhQy5zaG93bjsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiBbJ2NhbC1tb250aCcsICdwaG9uZS1tb250aCcsIGxvYWRpbmcgJiYgJ2xvYWRpbmcnXSB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnbW9udGgtZG93cycsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9LCBjYWwuREFZX05BTUVTLm1hcChkID0-IGgoJ3NwYW4nLCB7IHRleHQ6IGQuc2xpY2UoMCwgMSkgfSkpKSwKICAgICAgdGludChoKCdkaXYnLCB7IGNsYXNzOiAnbW9udGgtZ3JpZCcgfSwga2V5cy5tYXAoayA9PiB7C",
"iAgICAgICAgY29uc3QgYWxsID0gYnlEYXkuZ2V0KGspOwogICAgICAgIGNvbnN0IG1vcmUgPSBhbGwubGVuZ3RoIC0gTU9OVEhfUk9XUzsKICAgICAgICBjb25zdCBzaG93biA9IGFsbC5zbGljZSgwLCBtb3JlID4gMCA_IE1PTlRIX1JPV1MgLSAxIDogTU9OVEhfUk9XUyk7CiAgICAgICAgY29uc3QgbGFiZWwgPSBgJHtsb25nRGF0ZShrKX0ke2FsbC5sZW5ndGggPyBgOiAke2FsbC5tYXAoZSA9PiBlLml0ZW0udGl0bGUpLmpvaW4oJywgJyl9YCA6ICcsIG5vdGhpbmcgb24nfWA7CiAgICAgICAgcmV0dXJuIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIHR5cGU6ICdidXR0b24nLCBjbGFzczogWy4uLmRheUNsYXNzZXMoaywgJ21jZWxsJyksIGsuc2xpY2UoMCwgNykgIT09IG1vbnRoICYmICdvdGhlciddLAogICAgICAgICAgJ2FyaWEtbGFiZWwnOiBsYWJlbCwgZGF0YXNldDogeyBrZXk6IGBjYWwtZGF5OiR7a31gLCBkYXk6IGsgfSwgb25jbGljazogKCkgPT4gb3BlbldlZWsoayksCiAgICAgICAgfSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ21kYXknLCB0ZXh0OiBTdHJpbmcoTnVtYmVyKGsuc2xpY2UoOCkpKSB9KSwKICAgICAgICBzaG93bi5tYXAoKHsgaXRlbSB9KSA9PiB0aW50KGgoJ3NwYW4nLCB7CiAgICAgICAgICBjbGFzczogWydsaW5lJywgaXRlbS5raW5kID09PSAndGFzaycgPyAndGFzaycgOiBpdGVtLmFsbERheSA_ICdhbGwtZGF5JyA6ICd0aW1lZCcsIGl0ZW0uZG9uZSAmJiAnZG9uZSddLAogI",
"CAgICAgICAgdGV4dDogaXRlbS50aXRsZSwKICAgICAgICB9KSwgJy0tYycsIGl0ZW0uY29sb3VyKSksCiAgICAgICAgbW9yZSA-IDAgPyBoKCdzcGFuJywgeyBjbGFzczogJ21vcmUnLCB0ZXh0OiBgKyR7bW9yZSArIDF9YCB9KSA6IG51bGwpOwogICAgICB9KSksICctLXJvd3MnLCBTdHJpbmcoa2V5cy5sZW5ndGggLyA3KSkpOwogIH0KCiAgZnVuY3Rpb24gb3BlbldlZWsoaykgewogICAgQy5hbmNob3IgPSBrOwogICAgc2V0Vmlldygnd2VlaycpOwogIH0KCiAgZnVuY3Rpb24gZHJhd0FnZW5kYSgpIHsKICAgIGNvbnN0IHIgPSByYW5nZSgpOwogICAgY29uc3Qga2V5cyA9IGNhbC5kYXlzKHIuc3RhcnQsIHIuZW5kKTsKICAgIGNvbnN0IGJ5RGF5ID0gY2FsLmJ5RGF5KHZpc2libGVJdGVtcygpLCBrZXlzKTsKICAgIGNvbnN0IGRheXMgPSBrZXlzLmZpbHRlcihrID0-IGJ5RGF5LmdldChrKS5sZW5ndGggfHwgayA9PT0gQy50b2RheSk7CiAgICBpZiAoQy5zdGF0dXMgPT09ICdsb2FkaW5nJyAmJiAhQy5zaG93bikgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtYWdlbmRhIGxvYWRpbmcnIH0pOwogICAgaWYgKCFkYXlzLmxlbmd0aCkgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtYWdlbmRhJyB9LCBoKCdwJywgeyBjbGFzczogJ2VtcHR5JywgdGV4dDogJ05vdGhpbmcgb24gaW4gdGhlc2UgZm91ciB3ZWVrcy4nIH0pKTsKICAgIHJldHVybiBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWFnZW5kYScgfSwgZ",
"GF5cy5tYXAoayA9PiB7CiAgICAgIGNvbnN0IG0gPSBjYWwubW9udGhOYW1lKGspOwogICAgICByZXR1cm4gaCgnc2VjdGlvbicsIHsgY2xhc3M6IGRheUNsYXNzZXMoaywgJ2FkYXknKSwgJ2FyaWEtbGFiZWwnOiBsb25nRGF0ZShrKSB9LAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdhZGF5LWRhdGUnIH0sCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RudW0nLCB0ZXh0OiBTdHJpbmcoTnVtYmVyKGsuc2xpY2UoOCkpKSB9KSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZG5hbWUnIH0sIGgoJ3NwYW4nLCB7IHRleHQ6IGNhbC5kYXlOYW1lKGspIH0pLCBoKCdzcGFuJywgeyBjbGFzczogJ21vbicsIHRleHQ6IG0uc2hvcnQgfSkpKSwKICAgICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWl0ZW1zJyB9LCBieURheS5nZXQoaykubGVuZ3RoCiAgICAgICAgICA_IGJ5RGF5LmdldChrKS5tYXAoZSA9PiBpdGVtRWwoZSwgeyBhZ2VuZGE6IHRydWUgfSkpCiAgICAgICAgICA6IGgoJ3AnLCB7IGNsYXNzOiAnZW1wdHknLCB0ZXh0OiAnTm90aGluZyBvbiB0b2RheS4nIH0pKSk7CiAgICB9KSk7CiAgfQoKICBmdW5jdGlvbiB0aW1lVGV4dChtcykgewogICAgLy8gVGhlIDI0LWhvdXIgY2xvY2ssIHR3byBkaWdpdHMgZm9yIHRoZSBob3VyLCB3aGF0ZXZlciB0aGUgYnJvd3NlcidzCiAgICAvLyBsYW5ndWFnZSB3b3VsZCBoYXZlIGNob3NlbjogIjA5OjMwIiwgIjE5OjMwIi4KICAgIGlmICghdGltZUZvc",
"m1hdCkgdGltZUZvcm1hdCA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KHVuZGVmaW5lZCwgeyBob3VyOiAnMi1kaWdpdCcsIG1pbnV0ZTogJzItZGlnaXQnLCBob3VyQ3ljbGU6ICdoMjMnIH0pOwogICAgcmV0dXJuIHRpbWVGb3JtYXQuZm9ybWF0KG5ldyBEYXRlKG1zKSk7CiAgfQoKICBmdW5jdGlvbiB3aGVuVGV4dChpdGVtLCBjb250KSB7CiAgICBpZiAoaXRlbS5hbGxEYXkpIHJldHVybiBpdGVtLmZpcnN0ID09PSBpdGVtLmxhc3QgPyAnQWxsIGRheScgOiBgJHtzaG9ydERhdGUoaXRlbS5maXJzdCl9IOKAkyAke3Nob3J0RGF0ZShpdGVtLmxhc3QpfWA7CiAgICBjb25zdCBzcGFuID0gYCR7dGltZVRleHQoaXRlbS5zdGFydCl9IOKAkyAke3RpbWVUZXh0KGl0ZW0uZW5kKX1gOwogICAgcmV0dXJuIGl0ZW0uZmlyc3QgPT09IGl0ZW0ubGFzdCA_IHNwYW4gOiBgJHtzaG9ydERhdGUoaXRlbS5maXJzdCl9ICR7dGltZVRleHQoaXRlbS5zdGFydCl9IOKAkyAke3Nob3J0RGF0ZShpdGVtLmxhc3QpfSAke3RpbWVUZXh0KGl0ZW0uZW5kKX1gOwogIH0KCiAgZnVuY3Rpb24gc2hvcnREYXRlKGspIHsKICAgIHJldHVybiBgJHtOdW1iZXIoay5zbGljZSg4KSl9ICR7Y2FsLm1vbnRoTmFtZShrKS5zaG9ydH1gOwogIH0KCiAgLy8gQW4gZXZlbnQgb3IgYSB0YXNrLCBhcyBhIGxpbmsgdG8gd2hlcmUgaXQgbGl2ZXMgaW4gR29vZ2xlLiBPbmUgdGhhdAogIC8vIGNhbiBiZSBjaGFuZ2VkIGhlcmUgb3BlbnMgdGhlIGVkaXRvciBvb",
"iBhIHBsYWluIGNsaWNrIGluc3RlYWQgKEN0cmwsCiAgLy8gU2hpZnQgb3IgdGhlIG1pZGRsZSBidXR0b24gc3RpbGwgb3BlbiBpdCBpbiBHb29nbGUpLCBjYW4gYmUgZHJhZ2dlZAogIC8vIHRvIGFub3RoZXIgZGF5IChvciB0aW1lKSwgYW5kIGEgdGFzaydzIGJveCB0aWNrcyBpdC4gYGhvdXJzYDogaXRzCiAgLy8gcGxhY2UgaW4gdGhlIHdlZWsgYnkgdGhlIGhvdXIsIGZyb20gYW5kIHRvIGluIG1pbnV0ZXMuCiAgZnVuY3Rpb24gaXRlbUVsKHsgaXRlbSwgY29udCB9LCB7IGNvbXBhY3QgPSBmYWxzZSwgYWdlbmRhID0gZmFsc2UsIGR1ZSA9IGZhbHNlLCBob3VycyA9IG51bGwgfSA9IHt9KSB7CiAgICBjb25zdCBlZGl0YWJsZSA9ICEhaXRlbS5lZGl0YWJsZSAmJiBjYW5DaGFuZ2UoKTsKICAgIGNvbnN0IHRhZyA9IGl0ZW0ubGluayB8fCBlZGl0YWJsZSA_ICdhJyA6ICdkaXYnOwogICAgY29uc3QgbGluayA9IGl0ZW0ubGluayA_IHsgaHJlZjogaXRlbS5saW5rLCB0YXJnZXQ6ICdfYmxhbmsnLCByZWw6ICdub29wZW5lciBub3JlZmVycmVyJyB9IDogZWRpdGFibGUgPyB7IGhyZWY6ICcjJywgcm9sZTogJ2J1dHRvbicgfSA6IHt9OwogICAgY29uc3QgZWRpdCA9IGVkaXRhYmxlID8gewogICAgICBkYXRhc2V0OiB7IGtleTogYGNhbC1pdGVtOiR7aXRlbS5pZH1gIH0sCiAgICAgIG9uY2xpY2s6IGUgPT4gewogICAgICAgIGlmIChlLmJ1dHRvbiB8fCBlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuc2hpZnRLZXkgf",
"HwgZS5hbHRLZXkpIHJldHVybjsKICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgb3BlbkVkaXRvcihpdGVtKTsKICAgICAgfSwKICAgIH0gOiB7fTsKICAgIC8vIEluIHRoZSBob3VycywgYSBwaWVjZSBjYXJyaWVkIG92ZXIgZnJvbSB0aGUgZGF5IGJlZm9yZSBtb3ZlcyBieSBkYXlzIG9ubHkuCiAgICBjb25zdCBkcmFnID0gZWRpdGFibGUgPyB7IGRyYWdnYWJsZTogJ3RydWUnLCBvbmRyYWdzdGFydDogZSA9PiBzdGFydERyYWcoZSwgaXRlbSwgISFob3VycyAmJiAhY29udCkgfSA6IHt9OwogICAgaWYgKGl0ZW0ua2luZCA9PT0gJ2V2ZW50JykgewogICAgICBjb25zdCB0aXAgPSBbaXRlbS50aXRsZSwgd2hlblRleHQoaXRlbSwgY29udCksIGl0ZW0ud2hlcmVdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcbicpOwogICAgICAvLyBJbiB0aGUgaG91cnM6IGl0cyB0aXRsZSwgdGhlbiBmcm9tIGFuZCB0byAtIG9yLCBpbiBoYWxmIGFuIGhvdXIKICAgICAgLy8gb3IgbGVzcywgb25lIGxpbmUgd2l0aCB3aGVuIGl0IHN0YXJ0cy4KICAgICAgaWYgKGhvdXJzKSB7CiAgICAgICAgY29uc3Qgc2hvcnQgPSBob3Vycy50byAtIGhvdXJzLmZyb20gPD0gMzA7CiAgICAgICAgY29uc3Qgd2hlbiA9IGNvbnQgPyBgdW50aWwgJHt0aW1lVGV4dChpdGVtLmVuZCl9YCA6IHNob3J0ID8gdGltZVRleHQoaXRlbS5zdGFydCkgOiBgJHt0aW1lVGV4dChpdGVtLnN0YXJ0KX0g4oCTICR7dGltZVRleHQoaXRlbS5lbmQpfWA7C",
"iAgICAgICAgcmV0dXJuIHRpbnQoaCh0YWcsIE9iamVjdC5hc3NpZ24oewogICAgICAgICAgY2xhc3M6IFsnaXRlbScsICdldicsICd0aW1lZCcsIHNob3J0ICYmICdzaG9ydCddLCB0aXRsZTogdGlwLAogICAgICAgIH0sIGxpbmssIGVkaXQsIGRyYWcpLAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndCcsIHRleHQ6IGl0ZW0udGl0bGUgfSksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICd0aW1lJywgdGV4dDogd2hlbiB9KSksICctLWMnLCBpdGVtLmNvbG91cik7CiAgICAgIH0KICAgICAgY29uc3QgdGltZSA9IGl0ZW0uYWxsRGF5ID8gKGFnZW5kYSA_ICdBbGwgZGF5JyA6ICcnKSA6IGNvbnQgPyAoYWdlbmRhID8gJ3VudGlsICcgKyB0aW1lVGV4dChpdGVtLmVuZCkgOiAn4oCmJykgOiB0aW1lVGV4dChpdGVtLnN0YXJ0KTsKICAgICAgcmV0dXJuIHRpbnQoaCh0YWcsIE9iamVjdC5hc3NpZ24oewogICAgICAgIGNsYXNzOiBbJ2l0ZW0nLCAnZXYnLCBpdGVtLmFsbERheSAmJiAnYWxsLWRheScsIGNvbXBhY3QgJiYgJ2NvbXBhY3QnXSwgdGl0bGU6IHRpcCwKICAgICAgfSwgbGluaywgZWRpdCwgZHJhZyksCiAgICAgIHRpbWUgPyBoKCdzcGFuJywgeyBjbGFzczogJ3RpbWUnLCB0ZXh0OiB0aW1lIH0pIDogbnVsbCwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICd0JywgdGV4dDogaXRlbS50aXRsZSB9KSksICctLWMnLCBpdGVtLmNvbG91cik7CiAgICB9CiAgICBjb25zdCB0aXAgPSBbaXRlbS50aXRsZSwga",
"XRlbS5saXN0ICYmIGBHb29nbGUgVGFza3MgwrcgJHtpdGVtLmxpc3R9YCwgZHVlICYmIGl0ZW0uZHVlICYmIGBEdWUgJHtzaG9ydERhdGUoaXRlbS5kdWUpfWAsCiAgICAgIGl0ZW0uZW1haWwgJiYgJ09wZW5zIHRoZSBlbWFpbCddLmZpbHRlcihCb29sZWFuKS5qb2luKCdcbicpOwogICAgY29uc3Qgd29yZHMgPSBbCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAndCcsIHRleHQ6IGl0ZW0udGl0bGUgfSksCiAgICAgIGR1ZSAmJiBpdGVtLmR1ZSA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnZHVlJywgdGV4dDogc2hvcnREYXRlKGl0ZW0uZHVlKSB9KSA6IG51bGwsCiAgICAgIGl0ZW0uZW1haWwgPyBoKCdzcGFuJywgeyBjbGFzczogJ21haWwnLCB0aXRsZTogJ0Zyb20gYW4gZW1haWwnIH0sIGljb24oJ21haWwnLCAxNCkpIDogbnVsbCwKICAgIF07CiAgICBpZiAoIWVkaXRhYmxlKSB7CiAgICAgIHJldHVybiBoKHRhZywgT2JqZWN0LmFzc2lnbih7IGNsYXNzOiBbJ2l0ZW0nLCAndGFzaycsIGl0ZW0uZG9uZSAmJiAnZG9uZScsIGNvbXBhY3QgJiYgJ2NvbXBhY3QnXSwgdGl0bGU6IHRpcCB9LCBsaW5rKSwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2JveCcsICdhcmlhLWxhYmVsJzogaXRlbS5kb25lID8gJ0RvbmUnIDogJ1RvIGRvJywgcm9sZTogJ2ltZycgfSwgaXRlbS5kb25lID8gaWNvbignY2hlY2snLCAxMikgOiBudWxsKSwKICAgICAgICAuLi53b3Jkcyk7CiAgICB9CiAgICAvLyBUaGUgYm94IHRpY2tzIGl0O",
"yB0aGUgcmVzdCBvcGVucyBpdC4KICAgIHJldHVybiBoKCdkaXYnLCBPYmplY3QuYXNzaWduKHsgY2xhc3M6IFsnaXRlbScsICd0YXNrJywgaXRlbS5kb25lICYmICdkb25lJywgY29tcGFjdCAmJiAnY29tcGFjdCddIH0sIGRyYWcpLAogICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdib3gnLCB0eXBlOiAnYnV0dG9uJywgcm9sZTogJ2NoZWNrYm94JywgJ2FyaWEtY2hlY2tlZCc6IFN0cmluZyghIWl0ZW0uZG9uZSksICdhcmlhLWxhYmVsJzogYERvbmU6ICR7aXRlbS50aXRsZX1gLAogICAgICAgIHRpdGxlOiBpdGVtLmRvbmUgPyAnRG9uZS4gQ2xpY2sgdG8gdW5kby4nIDogJ0NsaWNrIHdoZW4gZG9uZScsIGRhdGFzZXQ6IHsga2V5OiBgY2FsLXRpY2s6JHtpdGVtLmlkfWAgfSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiB0aWNrVGFzayhpdGVtKSwKICAgICAgfSwgaXRlbS5kb25lID8gaWNvbignY2hlY2snLCAxMikgOiBudWxsKSwKICAgICAgaCh0YWcsIE9iamVjdC5hc3NpZ24oeyBjbGFzczogJ3Rhc2stbGluaycsIHRpdGxlOiB0aXAgfSwgbGluaywgZWRpdCksIC4uLndvcmRzKSk7CiAgfQoKICAvLyDilIDilIAgQ2hhbmdpbmcgdGhpbmdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUg",
"OKUgAogIC8vCiAgLy8gQm90aCB3YXlzOiBhbiBldmVudCBvciBhIHRhc2sgaXMgZWRpdGVkIGhlcmUsIGEgdGFzaydzIGJveCB0aWNrcyBpdCwKICAvLyBhbnl0aGluZyBkcmFnZ2VkIHRvIGFub3RoZXIgZGF5IG1vdmVzIHRoZXJlLCB0aGUgKyBvbiBhIGRheSBhZGRzIG9uZSwKICAvLyBhbmQgdGhlIGVkaXRvciBkZWxldGVzLiBFYWNoIGNoYW5nZSBnb2VzIHRvIEdvb2dsZSBhZnRlciB0aGUgb25lCiAgLy8gYmVmb3JlIGl0IChDLndyaXRlcyksIHNob3dzIGF0IG9uY2UsIGFuZCB0aGUgZGF5cyBhcmUgcmVhZCBhZ2FpbiBvbmNlCiAgLy8gdGhlIGxhc3QgaGFzIGxhbmRlZCwgc28gdGhhdCB3aGF0IHN0YXlzIG9uIHNjcmVlbiBpcyBHb29nbGUncyBvd24uCgogIGNvbnN0IGNhbkNoYW5nZSA9ICgpID0-ICEhKG5zLmFwaSAmJiBucy5hcGkuZ29vZ2xlV3JpdGUgJiYgQy5jdHggJiYgQy5jdHguZGlhbG9nKTsKCiAgLy8gQ2FsZW5kYXJzIGFuZCBsaXN0cyB0aGF0IGNhbiB0YWtlIGEgbmV3IGV2ZW50IG9yIHRhc2s6IHRoZSBvbmVzCiAgLy8gc2hvd2luZywgb3IgaWYgbm9uZSBvZiB0aG9zZSBjYW4sIGFueS4KICBmdW5jdGlvbiB3cml0YWJsZShraW5kKSB7CiAgICBjb25zdCBhbGwgPSBDLnNvdXJjZXMuZmlsdGVyKHMgPT4gcy53cml0YWJsZSAmJiAoIWtpbmQgfHwgcy5raW5kID09PSBraW5kKSk7CiAgICBjb25zdCBvbiA9IGFsbC5maWx0ZXIoaXNPbik7CiAgICByZXR1cm4gb24ubGVuZ3RoID8gb24gOiBhbGw7C",
"iAgfQoKICBjb25zdCBzb3VyY2VOYW1lID0gaWQgPT4gKEMuc291cmNlcy5maW5kKHMgPT4gcy5pZCA9PT0gaWQpIHx8IHt9KS5uYW1lIHx8ICcnOwoKICBmdW5jdGlvbiB0aW1lWm9uZSgpIHsKICAgIHRyeSB7IHJldHVybiBJbnRsLkRhdGVUaW1lRm9ybWF0KCkucmVzb2x2ZWRPcHRpb25zKCkudGltZVpvbmUgfHwgJyc7IH0gY2F0Y2ggeyByZXR1cm4gJyc7IH0KICB9CgogIC8vIEEgY2hhbmdlIG5hbWVzIHRoZSB2ZXJzaW9uIG9mIHRoZSBldmVudCBpdCB3YXMgbWFkZSB0by4gT25lIG1hZGUKICAvLyBoZXJlIGEgbW9tZW50IGFnbyAtIGRyYWdnZWQgdHdpY2UsIHNheSwgYmVmb3JlIEdvb2dsZSdzIGFuc3dlciB3YXMKICAvLyByZWFkIGJhY2sgLSBuYW1lcyB0aGUgdmVyc2lvbiB0aGF0IGNoYW5nZSBtYWRlLCBhbmQgbm9ib2R5IGVsc2Uncy4KICBjb25zdCBvdXJzID0gbmV3IE1hcCgpOyAvLyBhIHZlcnNpb24gd2UgY2hhbmdlZCDihpIgdGhlIHZlcnNpb24gaXQgYmVjYW1lCiAgZnVuY3Rpb24gZnJlc2goaXRlbSkgewogICAgbGV0IGV0YWcgPSBpdGVtLmV0YWc7CiAgICBmb3IgKGxldCBob3BzID0gMDsgZXRhZyAmJiBvdXJzLmhhcyhldGFnKSAmJiBob3BzIDwgNTA7IGhvcHMrKykgZXRhZyA9IG91cnMuZ2V0KGV0YWcpOwogICAgcmV0dXJuIGV0YWcgPT09IGl0ZW0uZXRhZyA_IGl0ZW0gOiBPYmplY3QuYXNzaWduKHt9LCBpdGVtLCB7IGV0YWcgfSk7CiAgfQogIGNvbnN0IHZlcnNpb25lZCA9IChpdGVtLCBzZ",
"W5kKSA9PiBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBpdCA9IGZyZXNoKGl0ZW0pOwogICAgY29uc3QgcmVzID0gYXdhaXQgc2VuZChpdCk7CiAgICBpZiAoaXQua2luZCA9PT0gJ2V2ZW50JyAmJiBpdC5ldGFnICYmIHJlcyAmJiByZXMuZXRhZykgb3Vycy5zZXQoaXQuZXRhZywgcmVzLmV0YWcpOwogICAgcmV0dXJuIHJlczsKICB9OwoKICAvLyBBIGNoYW5nZSBHb29nbGUgbmV2ZXIgYW5zd2VycyB3b3VsZCBob2xkIGV2ZXJ5IHJlYWQgYmFjayAoQy5wZW5kaW5nKSwKICAvLyBhbmQgdGhlIGNhbGVuZGFyIHdvdWxkIHN0b3AgbW92aW5nOiBhZnRlciB0aGlzIGxvbmcgaXQgY291bnRzIGFzCiAgLy8gZmFpbGVkLCBhbmQgdGhlIGRheXMgYXJlIHJlYWQgYWdhaW4gdG8gc2hvdyB3aGV0aGVyIGl0IGhhcHBlbmVkLgogIGNvbnN0IENIQU5HRV9NUyA9IDMwMDAwOwogIGZ1bmN0aW9uIGluVGltZShydW4pIHsKICAgIGxldCB0aW1lciA9IDA7CiAgICBjb25zdCBsYXRlID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KE9iamVjdC5hc3NpZ24oCiAgICAgICAgbmV3IEVycm9yKCdHb29nbGUgdG9vayB0b28gbG9uZyB0byBhbnN3ZXIuIEl0IG1heSBoYXZlIGJlZW4gZG9uZSBhbGwgdGhlIHNhbWU6IHRoZSBjYWxlbmRhciBpcyByZWFkIGFnYWluJyksIHsgY29kZTogJ3RpbWVvdXQnIH0pKSwgQ0hBTkdFX01TKTsKICAgIH0pOwogICAgcmV0d",
"XJuIFByb21pc2UucmFjZShbUHJvbWlzZS5yZXNvbHZlKCkudGhlbihydW4pLCBsYXRlXSkuZmluYWxseSgoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpKTsKICB9CgogIC8vIE9uZSBjaGFuZ2UgdG8gR29vZ2xlLCBhZnRlciBhbnkgYmVmb3JlIGl0OyB0aGUgZGF5cyBhcmUgcmVhZCBhZ2FpbgogIC8vIG9uY2UgdGhlIGxhc3QgaGFzIGxhbmRlZC4gQSBmYWlsdXJlIGlzIGEgdG9hc3QsIHVubGVzcyBgcXVpZXRgICh0aGUKICAvLyBlZGl0b3Igc2hvd3MgaXRzIG93bikuIFJlc29sdmVzIHRvIHRoZSBlcnJvciwgb3IgbnVsbC4KICBmdW5jdGlvbiBjaGFuZ2UocnVuLCB3aGF0LCB7IHF1aWV0ID0gZmFsc2UgfSA9IHt9KSB7CiAgICBDLnBlbmRpbmcrKzsKICAgIGNvbnN0IGRvbmUgPSBDLndyaXRlcy50aGVuKCgpID0-IGluVGltZShydW4pKS50aGVuKCgpID0-IG51bGwsIGVyciA9PiBlcnIgfHwgbmV3IEVycm9yKCdJdCBkaWQgbm90IHdvcmsuJykpOwogICAgQy53cml0ZXMgPSBkb25lLnRoZW4oZXJyID0-IHsKICAgICAgQy5wZW5kaW5nLS07CiAgICAgIGlmIChlcnIgJiYgIXF1aWV0KSBmYWlsZWQoZXJyLCB3aGF0KTsKICAgICAgaWYgKEMucGVuZGluZykgcmV0dXJuIHVuZGVmaW5lZDsKICAgICAgb3Vycy5jbGVhcigpOwogICAgICBDLmNhY2hlLmNsZWFyKCk7CiAgICAgIHJldHVybiBsb2FkKHsgZm9yY2U6IHRydWUgfSk7CiAgICB9KS5jYXRjaCgoKSA9PiB7fSk7CiAgICByZXR1cm4gZG9uZTsKICB9CgogIGZ1b",
"mN0aW9uIGZhaWxlZChlcnIsIHdoYXQpIHsKICAgIGlmIChlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX3Njb3BlJykgewogICAgICBjb25zdCBhbGxvdyA9IEMuY3R4LmNvbm5lY3QgPyB7IGxhYmVsOiAnQ29ubmVjdCBhZ2FpbicsIG9uQ2xpY2s6ICgpID0-IGNvbm5lY3QoKSB9CiAgICAgICAgOiBlcnIuYWxsb3dVcmwgPyB7IGxhYmVsOiAnQWxsb3cnLCBvbkNsaWNrOiAoKSA9PiB7IEMucmVjaGVjayA9IHRydWU7IHdpbmRvdy5vcGVuKGVyci5hbGxvd1VybCwgJ19ibGFuaycsICdub29wZW5lcicpOyB9IH0KICAgICAgICAgIDogbnVsbDsKICAgICAgdG9hc3QoQy5jdHgucm9vdCwgYCR7d2hhdH06IGNoYW5naW5nIHlvdXIgY2FsZW5kYXIgbmVlZHMgeW91ciBwZXJtaXNzaW9uIGZpcnN0LmAsIHsga2luZDogJ2Vycm9yJywgYWN0aW9uOiBhbGxvdywgdGltZW91dDogMTUwMDAgfSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IHdoeSA9IGVyci5jb2RlID09PSAnY2hhbmdlZCcgPyAnaXQgd2FzIGNoYW5nZWQgaW4gR29vZ2xlIG1lYW53aGlsZSwgc28gaGVyZSBpcyB0aGUgbGF0ZXN0JyA6IGVyci5tZXNzYWdlOwogICAgdG9hc3QoQy5jdHgucm9vdCwgYCR7d2hhdH06ICR7d2h5fS5gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgfQoKICAvLyBUaGUgY2hhbmdlIG9uIHNjcmVlbiBhdCBvbmNlLCBpbiBldmVyeSByYW5nZSByZWFkLCB1bnRpbCBHb29nbGUncyBvd24KICAvLyB2ZXJzaW9uIHJlcGxhY2VzIGl0OyBgb",
"mV4dGAgbnVsbCB0YWtlcyB0aGUgaXRlbSBvZmYuCiAgZnVuY3Rpb24gc2hvd0NoYW5nZWQoaWQsIG5leHQpIHsKICAgIGZvciAoY29uc3QgZW50cnkgb2YgbmV3IFNldChbLi4uQy5jYWNoZS52YWx1ZXMoKSwgQy5zaG93bl0uZmlsdGVyKEJvb2xlYW4pKSkgewogICAgICBlbnRyeS5pdGVtcyA9IGVudHJ5Lml0ZW1zLmZsYXRNYXAoeCA9PiAoeC5pZCAhPT0gaWQgPyBbeF0gOiBuZXh0ID8gW25leHRdIDogW10pKTsKICAgIH0KICAgIGRyYXcoKTsKICB9CgogIGZ1bmN0aW9uIHRpY2tUYXNrKGl0ZW0pIHsKICAgIGNvbnN0IGRvbmUgPSAhaXRlbS5kb25lOwogICAgc2hvd0NoYW5nZWQoaXRlbS5pZCwgT2JqZWN0LmFzc2lnbih7fSwgaXRlbSwgeyBkb25lIH0pKTsKICAgIGNoYW5nZSgoKSA9PiBzdG9yZS50aWNrKGl0ZW0sIGRvbmUpLCBgQ291bGRu4oCZdCAke2RvbmUgPyAndGljayBvZmYnIDogJ3VudGljayd9IOKAnCR7aXRlbS50aXRsZX3igJ1gKTsKICB9CgogIGZ1bmN0aW9uIGZvY3VzS2V5KGtleSkgewogICAgY29uc3QgZWwgPSBrZXkgJiYgWy4uLmVscy53cmFwLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWtleV0nKV0uZmluZCh4ID0-IHguZGF0YXNldC5rZXkgPT09IGtleSAmJiB4LmdldENsaWVudFJlY3RzKCkubGVuZ3RoKTsKICAgIGlmIChlbCkgZWwuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOwogIH0KCiAgLy8g4pSA4pSAIERyYWdnaW5nIHRvIGFub3RoZXIgZGF5LCBvciB0aW1lIOKUgOKUg",
"AogIC8vCiAgLy8gYHRpbWVkYDogYW4gZXZlbnQgaW4gdGhlIGhvdXJzLCB3aGljaCBkcm9wcGVkIGluIHRoZSBob3VycyBzdGFydHMKICAvLyB3aGVyZSBpdHMgdG9wIGlzIGxldCBnbyAtIGBncmFiYCBpcyBob3cgZmFyIGRvd24gaXQgd2FzIGhlbGQuCgogIGZ1bmN0aW9uIHN0YXJ0RHJhZyhlLCBpdGVtLCB0aW1lZCA9IGZhbHNlKSB7CiAgICBjb25zdCBmcm9tID0gZS5jdXJyZW50VGFyZ2V0LmNsb3Nlc3QoJ1tkYXRhLWRyb3BdJyk7CiAgICBpZiAoIWZyb20pIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyByZXR1cm47IH0KICAgIGNvbnN0IGdyYWIgPSB0aW1lZCA_IGUuY2xpZW50WSAtIGUuY3VycmVudFRhcmdldC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS50b3AgOiAwOwogICAgQy5kcmFnID0geyBpdGVtLCBmcm9tOiBmcm9tLmRhdGFzZXQuZHJvcCwgdGltZWQsIGdyYWIsIHN0YXJ0TWluOiB0aW1lZCA_IG1pbnV0ZU9mKGl0ZW0uc3RhcnQpIDogLTEgfTsKICAgIGUuZGF0YVRyYW5zZmVyLmVmZmVjdEFsbG93ZWQgPSAnbW92ZSc7CiAgICBlLmRhdGFUcmFuc2Zlci5zZXREYXRhKCd0ZXh0L3BsYWluJywgaXRlbS50aXRsZSk7CiAgICBlLmN1cnJlbnRUYXJnZXQuY2xhc3NMaXN0LmFkZCgnZHJhZ2dpbmcnKTsKICB9CgogIC8vIEEgZGF5IGl0IGlzIG5vdCBhbHJlYWR5IG9uLCBvciBpbiB0aGUgaG91cnMgYSB0aW1lIGl0IGRvZXMgbm90CiAgLy8gYWxyZWFkeSBzdGFydCBhdDsgb3IgTm8gZGF0ZSwgZm9yIGEgdGFza",
"y4geyBlbCwgZGF5LCBhdCwgYm9keSB9LCBgYXRgCiAgLy8gaW4gbWludXRlcyBvciBudWxsIGZvciB0aGUgZGF5IGFsb25lLgogIGZ1bmN0aW9uIGRyb3BUYXJnZXQoZSkgewogICAgY29uc3QgZCA9IEMuZHJhZzsKICAgIGlmICghZCkgcmV0dXJuIG51bGw7CiAgICBjb25zdCB0ID0gZS50YXJnZXQgJiYgZS50YXJnZXQuY2xvc2VzdCA_IGUudGFyZ2V0LmNsb3Nlc3QoJ1tkYXRhLWRyb3BdJykgOiBudWxsOwogICAgaWYgKCF0IHx8ICFlbHMud3JhcC5jb250YWlucyh0KSkgcmV0dXJuIG51bGw7CiAgICBpZiAoIXQuZGF0YXNldC5kcm9wICYmIGQuaXRlbS5raW5kICE9PSAndGFzaycpIHJldHVybiBudWxsOwogICAgY29uc3QgYm9keSA9IGQudGltZWQgPyBlLnRhcmdldC5jbG9zZXN0KCcuZ3JpZC1ib2R5JykgOiBudWxsOwogICAgY29uc3QgYXQgPSBib2R5ID8gc25hcChtaW51dGVBdChib2R5LCBlLmNsaWVudFkgLSBkLmdyYWIpLCBTVEVQX01JTiwgQy5zcGFuWzBdLCBDLnNwYW5bMV0gLSBTVEVQX01JTikgOiBudWxsOwogICAgaWYgKHQuZGF0YXNldC5kcm9wID09PSBkLmZyb20gJiYgKGF0ID09PSBudWxsIHx8IGF0ID09PSBkLnN0YXJ0TWluKSkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4geyBlbDogdCwgZGF5OiB0LmRhdGFzZXQuZHJvcCwgYXQsIGJvZHkgfTsKICB9CgogIC8vIEEgZGF5IGlzIG91dGxpbmVkOyBhIHRpbWUsIHNob3duIHdoZXJlIHRoZSBldmVudCB3b3VsZCBnby4KICBmdW5jdGlvbiBtYXJrR",
"HJvcCh0KSB7CiAgICBjb25zdCBkYXkgPSB0ICYmIHQuYXQgPT09IG51bGwgPyB0LmVsIDogbnVsbDsKICAgIGZvciAoY29uc3QgeCBvZiBlbHMud3JhcC5xdWVyeVNlbGVjdG9yQWxsKCcuZHJvcC1oZXJlJykpIGlmICh4ICE9PSBkYXkpIHguY2xhc3NMaXN0LnJlbW92ZSgnZHJvcC1oZXJlJyk7CiAgICBpZiAoZGF5KSBkYXkuY2xhc3NMaXN0LmFkZCgnZHJvcC1oZXJlJyk7CiAgICBpZiAoIXQgfHwgdC5hdCA9PT0gbnVsbCkgewogICAgICBpZiAoZWxzLmdob3N0KSBlbHMuZ2hvc3QucmVtb3ZlKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGxlbmd0aCA9IE1hdGgucm91bmQoKEMuZHJhZy5pdGVtLmVuZCAtIEMuZHJhZy5pdGVtLnN0YXJ0KSAvIDYwMDAwKTsKICAgIGlmICghZWxzLmdob3N0KSBlbHMuZ2hvc3QgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZHJvcC1naG9zdCcsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KTsKICAgIGVscy5naG9zdC50ZXh0Q29udGVudCA9IGAke2Nsb2NrKHQuYXQpfSDigJMgJHtjbG9jaygodC5hdCArIGxlbmd0aCkgJSAxNDQwKX1gOwogICAgc2V0VmFycyhlbHMuZ2hvc3QsIHsgJy0tZnJvbSc6IHQuYXQsICctLXRvJzogTWF0aC5taW4oQy5zcGFuWzFdLCB0LmF0ICsgTWF0aC5tYXgobGVuZ3RoLCBTVEVQX01JTikpIH0pOwogICAgaWYgKGVscy5naG9zdC5wYXJlbnROb2RlICE9PSB0LmJvZHkpIHQuYm9keS5hcHBlbmQoZWxzLmdob3N0KTsKICB9CgogIGZ1bmN0aW9uIG9uR",
"HJhZ092ZXIoZSkgewogICAgY29uc3QgdCA9IGRyb3BUYXJnZXQoZSk7CiAgICBtYXJrRHJvcCh0KTsKICAgIGlmICghdCkgcmV0dXJuOwogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgZS5kYXRhVHJhbnNmZXIuZHJvcEVmZmVjdCA9ICdtb3ZlJzsKICB9CgogIGZ1bmN0aW9uIG9uRHJvcChlKSB7CiAgICBjb25zdCB0ID0gZHJvcFRhcmdldChlKTsKICAgIGNvbnN0IGQgPSBDLmRyYWc7CiAgICBlbmREcmFnKCk7CiAgICBpZiAoIXQgfHwgIWQpIHJldHVybjsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIG1vdmVJdGVtKGQuaXRlbSwgZC5mcm9tLCB0LmRheSwgdC5hdCk7CiAgfQoKICBmdW5jdGlvbiBlbmREcmFnKCkgewogICAgQy5kcmFnID0gbnVsbDsKICAgIG1hcmtEcm9wKG51bGwpOwogICAgZm9yIChjb25zdCB4IG9mIGVscy53cmFwLnF1ZXJ5U2VsZWN0b3JBbGwoJy5kcmFnZ2luZycpKSB4LmNsYXNzTGlzdC5yZW1vdmUoJ2RyYWdnaW5nJyk7CiAgfQoKICAvLyBgYXRgOiBtaW51dGVzIGFmdGVyIG1pZG5pZ2h0LCBkcm9wcGVkIGluIHRoZSBob3VyczsgZWxzZSBudWxsLgogIGZ1bmN0aW9uIG1vdmVJdGVtKGl0ZW0sIGZyb20sIHRvLCBhdCA9IG51bGwpIHsKICAgIGNvbnN0IHN0YXJ0TWluID0gYXQgPT09IG51bGwgPyB1bmRlZmluZWQgOiBhdDsKICAgIHNob3dDaGFuZ2VkKGl0ZW0uaWQsIGNhbC5tb3ZlZEl0ZW0oaXRlbSwgZnJvbSwgdG8sIHN0YXJ0TWluKSk7CiAgICBjaGFuZ2UodmVyc2lvbmVkK",
"Gl0ZW0sIGl0ID0-IHN0b3JlLm1vdmUoaXQsIGZyb20sIHRvLCB0aW1lWm9uZSgpLCBzdGFydE1pbikpLAogICAgICBgQ291bGRu4oCZdCBtb3ZlIOKAnCR7aXRlbS50aXRsZX3igJ0gdG8gJHt0byA_IGxvbmdEYXRlKHRvKSA6ICdObyBkYXRlJ30ke2F0ID09PSBudWxsID8gJycgOiBgIGF0ICR7Y2xvY2soYXQpfWB9YCk7CiAgfQoKICAvLyBJdHMgYm90dG9tIGVkZ2UgZHJhZ2dlZCBpbiB0aGUgaG91cnM6IGEgbmV3IGVuZCwgdGhlIHN0YXJ0IGtlcHQuCiAgZnVuY3Rpb24gcmVzaXplSXRlbShpdGVtLCBlbmQpIHsKICAgIHNob3dDaGFuZ2VkKGl0ZW0uaWQsIE9iamVjdC5hc3NpZ24oe30sIGl0ZW0sIHsgZW5kLCBsYXN0OiBjYWwuZGF0ZUtleShlbmQgLSAxKSB9KSk7CiAgICBjaGFuZ2UodmVyc2lvbmVkKGl0ZW0sIGl0ID0-IHN0b3JlLnJlc2l6ZShpdCwgZW5kLCB0aW1lWm9uZSgpKSksIGBDb3VsZG7igJl0IGNoYW5nZSB3aGVuIOKAnCR7aXRlbS50aXRsZX3igJ0gZW5kc2ApOwogIH0KCiAgLy8g4pSA4pSAIERvbmUgYWZ0ZXIgYW4gVW5kbyDilIDilIAKICAvLwogIC8vIERlbGV0aW5nIC0gb25lIGV2ZW50LCBvbmUgdGFzaywgb3IgZXZlcnkgZXZlbnQgaW4gYSBzZXJpZXMgLSBhbmQgYQogIC8vIHNlcmllcyBzdG9wcGVkIHJlcGVhdGluZyAod2hpY2ggdGFrZXMgaXRzIG90aGVyIGV2ZW50cyBhd2F5KSBvbmx5IGV2ZXIKICAvLyBmb2xsb3cgYSBjb25maXJtYXRpb24gaW4gdGhlIGVkaXRvci4gVGhlIHNjcmVlb",
"iBzaG93cyBpdCBhdCBvbmNlLCBidXQKICAvLyBHb29nbGUgaXMgb25seSBhc2tlZCBvbmNlIHRoZSBVbmRvIGhhcyBoYWQgaXRzIHRpbWU6IGEgdGFiIGNsb3NlZAogIC8vIGJlZm9yZSB0aGVuIGNoYW5nZXMgbm90aGluZyBhdCBhbGwuCgogIGNvbnN0IFVORE9fTVMgPSA4MDAwOwoKICAvLyBgaGlkZXNgOiB0aGUgaXRlbXMgdGhhdCBnbyBmcm9tIHRoZSBzY3JlZW4gbWVhbndoaWxlLgogIGZ1bmN0aW9uIGxhdGVyKGtleSwgeyBtZXNzYWdlLCBoaWRlcywgcnVuLCB3aGF0IH0pIHsKICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7CiAgICAgIGlmICghQy5sYXRlci5oYXMoa2V5KSkgcmV0dXJuOwogICAgICBDLmxhdGVyLmRlbGV0ZShrZXkpOwogICAgICBpZiAoaGlkZXMpIHsKICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIG5ldyBTZXQoWy4uLkMuY2FjaGUudmFsdWVzKCksIEMuc2hvd25dLmZpbHRlcihCb29sZWFuKSkpIGVudHJ5Lml0ZW1zID0gZW50cnkuaXRlbXMuZmlsdGVyKHggPT4gIWhpZGVzKHgpKTsKICAgICAgICBkcmF3KCk7CiAgICAgIH0KICAgICAgY2hhbmdlKHJ1biwgd2hhdCk7CiAgICB9LCBVTkRPX01TICsgNTAwKTsgLy8gYWZ0ZXIgdGhlIFVuZG8gaXMgZ29uZSwgbmV2ZXIgd2hpbGUgaXQgc2hvd3MKICAgIEMubGF0ZXIuc2V0KGtleSwgeyB0aW1lciwgaGlkZXMgfSk7CiAgICBkcmF3KCk7CiAgICB0b2FzdChDLmN0eC5yb290LCBtZXNzYWdlLCB7CiAgICAgIHRpbWVvdXQ6I",
"FVORE9fTVMsCiAgICAgIGFjdGlvbjogewogICAgICAgIGxhYmVsOiAnVW5kbycsCiAgICAgICAgb25DbGljazogKCkgPT4gewogICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTsKICAgICAgICAgIEMubGF0ZXIuZGVsZXRlKGtleSk7CiAgICAgICAgICBkcmF3KCk7CiAgICAgICAgfSwKICAgICAgfSwKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZGVsZXRlTGF0ZXIoaXRlbSkgewogICAgbGF0ZXIoYGRlbGV0ZToke2l0ZW0uaWR9YCwgewogICAgICBtZXNzYWdlOiBgRGVsZXRlZCDigJwke2l0ZW0udGl0bGV94oCdLmAsCiAgICAgIGhpZGVzOiB4ID0-IHguaWQgPT09IGl0ZW0uaWQsCiAgICAgIHJ1bjogdmVyc2lvbmVkKGl0ZW0sIGl0ID0-IHN0b3JlLnJlbW92ZShpdCkpLAogICAgICB3aGF0OiBgQ291bGRu4oCZdCBkZWxldGUg4oCcJHtpdGVtLnRpdGxlfeKAnWAsCiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGRlbGV0ZVNlcmllc0xhdGVyKHNlcmllcywgaXRlbSkgewogICAgbGF0ZXIoYHNlcmllczoke2l0ZW0uc291cmNlfXwke3Nlcmllcy5pZH1gLCB7CiAgICAgIG1lc3NhZ2U6IGBEZWxldGVkIGV2ZXJ5IGV2ZW50IGluIOKAnCR7aXRlbS50aXRsZX3igJ0uYCwKICAgICAgaGlkZXM6IHggPT4geC5zb3VyY2UgPT09IGl0ZW0uc291cmNlICYmICh4LnNlcmllc0lkID09PSBzZXJpZXMuaWQgfHwgeC5ldmVudElkID09PSBzZXJpZXMuaWQpLAogICAgICBydW46ICgpID0-IHN0b3JlLnJlbW92ZVNlcmllcyhzZXJpZ",
"XMsIGl0ZW0pLAogICAgICB3aGF0OiBgQ291bGRu4oCZdCBkZWxldGUgdGhlIGV2ZW50cyBpbiDigJwke2l0ZW0udGl0bGV94oCdYCwKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gc3RvcExhdGVyKHNlcmllcywgaXRlbSwgZHJhZnQpIHsKICAgIGxhdGVyKGBzdG9wOiR7aXRlbS5zb3VyY2V9fCR7c2VyaWVzLmlkfWAsIHsKICAgICAgbWVzc2FnZTogYOKAnCR7aXRlbS50aXRsZX3igJ0gd2lsbCBzdG9wIHJlcGVhdGluZy5gLAogICAgICBydW46ICgpID0-IHN0b3JlLnNhdmVTZXJpZXMoc2VyaWVzLCBpdGVtLCBkcmFmdCwgJycsIHRpbWVab25lKCkpLAogICAgICB3aGF0OiBgQ291bGRu4oCZdCBzdG9wIOKAnCR7aXRlbS50aXRsZX3igJ0gcmVwZWF0aW5nYCwKICAgIH0pOwogIH0KCiAgLy8g4pSA4pSAIFRoZSBlZGl0b3Ig4pSA4pSACiAgLy8KICAvLyBPbmUgZGlhbG9nIGZvciBhbiBldmVudCBvciBhIHRhc2ssIG5ldyBvciBub3QsIGluIHRoZSBib2FyZCdzIGRpYWxvZwogIC8vIGxheWVyLiBOZXcsIGl0IHN0YXJ0cyBvbiB0aGUgZGF5IHdob3NlICsgd2FzIHByZXNzZWQgKG9yLCBjbGlja2VkIGluCiAgLy8gdGhlIGhvdXJzLCBhcyBhbiBldmVudCBhbiBob3VyIGxvbmcgZnJvbSBgYXRgLCBtaW51dGVzKTsgdHlwaW5nCiAgLy8gIkRlbnRpc3QgMTQ6MzAiIG1ha2VzIGl0IGFuIGV2ZW50IGF0IHRoYXQgdGltZSwgIlBheSB0aGUgaW52b2ljZSIgYQogIC8vIHRhc2ssIHVudGlsIEV2ZW50IG9yIFRhc2sgaXMgY2hvc",
"2VuIGJ5IGhhbmQuIEFuIGV2ZW50IGNhbiByZXBlYXQsIGFzCiAgLy8gR29vZ2xlJ3Mgb3duIG1lbnUgb2ZmZXJzOyBvbmUgb2NjdXJyZW5jZSBvZiBhIHNlcmllcyBhc2tzLCBvbiBzYXZpbmcKICAvLyBvciBkZWxldGluZywgd2hldGhlciB0aGF0IGlzIGZvciB0aGlzIGV2ZW50IG9yIGZvciBhbGwgb2YgdGhlbS4KCiAgZnVuY3Rpb24gb3BlbkVkaXRvcihpdGVtLCBkYXksIGF0ID0gbnVsbCkgewogICAgaWYgKCFjYW5DaGFuZ2UoKSB8fCAoaXRlbSAmJiAhaXRlbS5lZGl0YWJsZSkpIHJldHVybjsKICAgIGNvbnN0IGNhbHMgPSB3cml0YWJsZSgnY2FsZW5kYXInKTsKICAgIGNvbnN0IGxpc3RzID0gd3JpdGFibGUoJ3Rhc2tzJyk7CiAgICBpZiAoIWl0ZW0gJiYgIWNhbHMubGVuZ3RoICYmICFsaXN0cy5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IHN0YXJ0ID0gaXRlbSA_IGNhbC5kcmFmdE9mKGl0ZW0pIDogbnVsbDsKICAgIGNvbnN0IGRlZmF1bHRDYWwgPSAoY2Fscy5maW5kKGMgPT4gYy5wcmltYXJ5KSB8fCBjYWxzWzBdIHx8IHt9KS5pZCB8fCAnJzsKICAgIGNvbnN0IGVkID0gewogICAgICBpdGVtLCBpc05ldzogIWl0ZW0sIGtpbmRDaG9zZW46IGZhbHNlLCB0aW1lc1RvdWNoZWQ6IGZhbHNlLCBzYXZpbmc6IGZhbHNlLCBjb25maXJtaW5nOiBmYWxzZSwgc2NvcGU6IGZhbHNlLCBlcnJvcjogJycsCiAgICAgIGtpbmQ6IGl0ZW0gPyBpdGVtLmtpbmQgOiBjYWxzLmxlbmd0aCA_ICdldmVudCcgOiAndGFzaycsC",
"iAgICAgIHRpdGxlOiBzdGFydCA_IHN0YXJ0LnRpdGxlIDogJycsCiAgICAgIGV2ZW50OiBzdGFydCAmJiBzdGFydC5raW5kID09PSAnZXZlbnQnID8gc3RhcnQgOiBjYWwubmV3RHJhZnQoJ2V2ZW50JywgZGF5IHx8IEMudG9kYXksIGRlZmF1bHRDYWwpLAogICAgICB0YXNrOiBzdGFydCAmJiBzdGFydC5raW5kID09PSAndGFzaycgPyBzdGFydCA6IGNhbC5uZXdEcmFmdCgndGFzaycsIGRheSB8fCAnJywgKGxpc3RzWzBdIHx8IHt9KS5pZCB8fCAnJyksCiAgICAgIC8vIEhvdyBpdCByZXBlYXRzOiBhcyBjaG9zZW4gaGVyZSwgYW5kIGFzIGl0IHdhcy4KICAgICAgcmVwZWF0OiB7IGlkOiAnbm9uZScsIHJ1bGU6ICcnIH0sIHJlcGVhdEF0OiBudWxsLCByZXBlYXRUb3VjaGVkOiBmYWxzZSwKICAgICAgLy8gQW4gb2NjdXJyZW5jZSdzIHNlcmllcywgcmVhZCBmcm9tIEdvb2dsZTogeyBzdGF0ZSwgZXZlbnQsIGVycm9yIH0uCiAgICAgIHNlcmllczogbnVsbCwKICAgICAgYmFjazogaXRlbSA_IGBjYWwtaXRlbToke2l0ZW0uaWR9YCA6IGBjYWwtYWRkOiR7ZGF5fWAsCiAgICB9OwogICAgaWYgKCFpdGVtICYmIGF0ICE9PSBudWxsICYmIGNhbHMubGVuZ3RoKSB7CiAgICAgIGNvbnN0IGVuZCA9IGF0ICsgNjA7CiAgICAgIE9iamVjdC5hc3NpZ24oZWQuZXZlbnQsIHsgYWxsRGF5OiBmYWxzZSwgc3RhcnQ6IGNsb2NrKGF0KSwgZW5kOiBjbG9jayhlbmQgJSAxNDQwKSwgZW5kRGF5OiBlbmQgPj0gMTQ0MCA_IGNhbC5hZGREY",
"XlzKGRheSwgMSkgOiBkYXkgfSk7CiAgICAgIE9iamVjdC5hc3NpZ24oZWQsIHsga2luZDogJ2V2ZW50Jywga2luZENob3NlbjogdHJ1ZSwgdGltZXNUb3VjaGVkOiB0cnVlIH0pOwogICAgfQogICAgQy5lZGl0ID0gZWQ7CiAgICBpZiAoaXRlbSAmJiBpdGVtLnJlY3VycmluZyAmJiBpdGVtLnNlcmllc0lkKSB7CiAgICAgIGVkLnNlcmllcyA9IHsgc3RhdGU6ICdsb2FkaW5nJyB9OwogICAgICBzdG9yZS5zZXJpZXMoaXRlbSkudGhlbihldiA9PiB7CiAgICAgICAgaWYgKEMuZWRpdCAhPT0gZWQpIHJldHVybjsKICAgICAgICBlZC5zZXJpZXMgPSB7IHN0YXRlOiAncmVhZHknLCBldmVudDogZXYgfTsKICAgICAgICBlZC5yZXBlYXRBdCA9IGNhbC5yZXBlYXRPZihldi5yZWN1cnJlbmNlLCBjYWwuc3RhcnREYXlPZihldikpOwogICAgICAgIGlmICghZWQucmVwZWF0VG91Y2hlZCkgZWQucmVwZWF0ID0gY29weVJlcGVhdChlZC5yZXBlYXRBdCk7CiAgICAgICAgZWQuc3luYygpOwogICAgICB9LCBlcnIgPT4gewogICAgICAgIGlmIChDLmVkaXQgIT09IGVkKSByZXR1cm47CiAgICAgICAgZWQuc2VyaWVzID0geyBzdGF0ZTogJ2Vycm9yJywgZXJyb3I6IGVyci5tZXNzYWdlIH07CiAgICAgICAgZWQuc3luYygpOwogICAgICB9KTsKICAgIH0KICAgIEMuY3R4LmRpYWxvZy5zaG93KGVkaXRvckVsKGVkLCBjYWxzLCBsaXN0cyksIHsKICAgICAgb25DbG9zZTogKCkgPT4gewogICAgICAgIGlmIChDLmVkaXQgPT09IGVkKSBDL",
"mVkaXQgPSBudWxsOwogICAgICAgIGZvY3VzS2V5KGVkLmJhY2spOwogICAgICB9LAogICAgfSk7CiAgICBjb25zdCB0aXRsZSA9IEMuY3R4LnJvb3QucXVlcnlTZWxlY3RvcignW2RhdGEta2V5PSJjYWwtZWRpdC10aXRsZSJdJyk7CiAgICBpZiAodGl0bGUpIHsgdGl0bGUuZm9jdXMoKTsgdGl0bGUuc2VsZWN0KCk7IH0KICB9CgogIGNvbnN0IGNvcHlSZXBlYXQgPSByID0-IE9iamVjdC5hc3NpZ24oe30sIHIsIHIuY3VzdG9tID8geyBjdXN0b206IE9iamVjdC5hc3NpZ24oe30sIHIuY3VzdG9tLCB7IGRheXM6IHIuY3VzdG9tLmRheXMuc2xpY2UoKSB9KSB9IDoge30pOwoKICAvLyBUaGUgZGF5IGEgcnVsZSBpcyB3b3JrZWQgb3V0IGZvcjogdGhlIGV2ZW50J3Mgb3duLCBvciBmb3IgYW4KICAvLyBvY2N1cnJlbmNlLCBpdHMgc2VyaWVzJyBmaXJzdCBkYXksIG1vdmVkIGFzIGZhciBhcyB0aGUgb2NjdXJyZW5jZSB3YXMuCiAgZnVuY3Rpb24gcmVwZWF0RGF5KGVkKSB7CiAgICBjb25zdCBzID0gZWQuc2VyaWVzICYmIGVkLnNlcmllcy5zdGF0ZSA9PT0gJ3JlYWR5JyA_IGVkLnNlcmllcy5ldmVudCA6IG51bGw7CiAgICByZXR1cm4gcyA_IGNhbC5zZXJpZXNEcmFmdChjYWwuc3RhcnREYXlPZihzKSwgZWQuaXRlbS5maXJzdCwgZWQuZXZlbnQpLmRheSA6IGVkLmV2ZW50LmRheTsKICB9CgogIGNvbnN0IFVOSVRTID0gW1snZGF5JywgJ2RheXMnXSwgWyd3ZWVrJywgJ3dlZWtzJ10sIFsnbW9udGgnLCAnbW9udGhzJ10sI",
"FsneWVhcicsICd5ZWFycyddXTsKCiAgZnVuY3Rpb24gZWRpdG9yRWwoZWQsIGNhbHMsIGxpc3RzKSB7CiAgICBjb25zdCBldiA9IGVkLmV2ZW50OwogICAgY29uc3QgdGsgPSBlZC50YXNrOwogICAgY29uc3QgaWQgPSBuYW1lID0-IGBna2ItY2FsLSR7bmFtZX1gOwogICAgY29uc3Qgb25FbnRlciA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicgJiYgIWUuaXNDb21wb3NpbmcpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBzYXZlRWRpdChlZCk7IH0gfTsKICAgIGNvbnN0IGlucHV0ID0gKG5hbWUsIHByb3BzKSA9PiBoKCdpbnB1dCcsIE9iamVjdC5hc3NpZ24oeyBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIGlkOiBpZChuYW1lKSwgb25rZXlkb3duOiBvbkVudGVyIH0sIHByb3BzKSk7CiAgICBjb25zdCBmaWVsZCA9IChuYW1lLCBsYWJlbCwgLi4uY29udHJvbHMpID0-IGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgaCgnbGFiZWwnLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCBmb3I6IGlkKG5hbWUpLCB0ZXh0OiBsYWJlbCB9KSwgLi4uY29udHJvbHMpOwogICAgY29uc3QgcGljayA9IChuYW1lLCBsaXN0LCB2YWx1ZSwgc2V0KSA9PiAobGlzdC5sZW5ndGggPiAxICYmIGVkLmlzTmV3CiAgICAgID8gaCgnc2VsZWN0JywgeyBjbGFzczogJ3RleHQtaW5wdXQnLCBpZDogaWQobmFtZSksIG9uY2hhbmdlOiBlID0-IHNldChlLnRhcmdldC52YWx1ZSkgfSwKICAgICAgICBsaXN0Lm1hc",
"ChzID0-IGgoJ29wdGlvbicsIHsgdmFsdWU6IHMuaWQsIHNlbGVjdGVkOiBzLmlkID09PSB2YWx1ZSwgdGV4dDogcy5uYW1lIH0pKSkKICAgICAgOiBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWVkaXQtd2hlcmUnLCBpZDogaWQobmFtZSksIHRleHQ6IHNvdXJjZU5hbWUodmFsdWUpIH0pKTsKICAgIGNvbnN0IHJlY3VycmluZyA9ICEhKGVkLml0ZW0gJiYgZWQuaXRlbS5yZWN1cnJpbmcpOwoKICAgIGNvbnN0IGVsczIgPSB7fTsKICAgIGNvbnN0IHN5bmMgPSAoKSA9PiB7CiAgICAgIGZvciAoY29uc3QgYiBvZiBlbHMyLmtpbmRzID8gZWxzMi5raW5kcy5jaGlsZHJlbiA6IFtdKSBiLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKGIuZGF0YXNldC5raW5kID09PSBlZC5raW5kKSk7CiAgICAgIGVsczIuZXZlbnQuaGlkZGVuID0gZWQua2luZCAhPT0gJ2V2ZW50JzsKICAgICAgZWxzMi50YXNrLmhpZGRlbiA9IGVkLmtpbmQgIT09ICd0YXNrJzsKICAgICAgZm9yIChjb25zdCB0IG9mIFtlbHMyLnN0YXJ0VGltZSwgZWxzMi5lbmRUaW1lXSkgdC5oaWRkZW4gPSBldi5hbGxEYXk7CiAgICAgIHN5bmNSZXBlYXQoKTsKICAgICAgZWxzMi5lcnJvci50ZXh0Q29udGVudCA9IGVkLmVycm9yOwogICAgICAvLyBCdXN5LCBub3QgZGlzYWJsZWQ6IGEgZGlzYWJsZWQgYnV0dG9uIGRyb3BzIHRoZSBmb2N1cyBvdXQgb2YgdGhlCiAgICAgIC8vIGRpYWxvZywgYW5kIEVzYyB3b3VsZCB0aGVuIGNsb3NlIHRoZSB3aG9sZ",
"SBib2FyZC4KICAgICAgZWxzMi5zYXZlLnNldEF0dHJpYnV0ZSgnYXJpYS1kaXNhYmxlZCcsIFN0cmluZyhlZC5zYXZpbmcpKTsKICAgICAgZWxzMi5zYXZlLnRleHRDb250ZW50ID0gZWQuc2F2aW5nID8gJ1NhdmluZ-KApicgOiBlZC5pc05ldyA_ICdBZGQnIDogJ1NhdmUnOwogICAgICBjb25zdCBzZXJpZXNSZWFkeSA9ICEhKGVkLnNlcmllcyAmJiBlZC5zZXJpZXMuc3RhdGUgPT09ICdyZWFkeScpOwogICAgICBmb3IgKGNvbnN0IGIgb2YgW2VsczIuc2NvcGVBbGwsIGVsczIuZGVsZXRlQWxsXSkgaWYgKGIpIGIuc2V0QXR0cmlidXRlKCdhcmlhLWRpc2FibGVkJywgU3RyaW5nKCFzZXJpZXNSZWFkeSkpOwogICAgICBpZiAoZWxzMi5zY29wZU9uZSkgZWxzMi5zY29wZU9uZS5oaWRkZW4gPSAhIWVkLnJ1bGVDaGFuZ2VkOwogICAgICBpZiAoZWxzMi5zY29wZVRleHQpIHsKICAgICAgICBlbHMyLnNjb3BlVGV4dC50ZXh0Q29udGVudCA9IGVkLnN0b3BwaW5nCiAgICAgICAgICA_ICdJdCB3aWxsIHN0b3AgcmVwZWF0aW5nOiB0aGUgb3RoZXIgZXZlbnRzIGluIHRoZSBzZXJpZXMgZ28gZnJvbSBHb29nbGUgQ2FsZW5kYXIgdG9vLCBvbmNlIFVuZG8gaGFzIHBhc3NlZC4nCiAgICAgICAgICA6IGVkLnJ1bGVDaGFuZ2VkID8gJ0EgY2hhbmdlIHRvIGhvdyBpdCByZXBlYXRzIGlzIGZvciBhbGwgZXZlbnRzIGluIHRoZSBzZXJpZXMuJwogICAgICAgICAgICA6ICdTYXZlIHRoaXMgY2hhbmdlIGZvciB0aGlzIGV2ZW50IG9ub",
"HksIG9yIGZvciBhbGwgZXZlbnRzIGluIHRoZSBzZXJpZXM_JzsKICAgICAgfQogICAgICBlbHMyLmNvbmZpcm0uaGlkZGVuID0gIWVkLmNvbmZpcm1pbmc7CiAgICAgIGlmIChlbHMyLnNjb3BlKSBlbHMyLnNjb3BlLmhpZGRlbiA9ICFlZC5zY29wZTsKICAgICAgZWxzMi5mb290LmhpZGRlbiA9IGVkLmNvbmZpcm1pbmcgfHwgZWQuc2NvcGU7CiAgICB9OwogICAgZWQuc3luYyA9IHN5bmM7CgogICAgLy8gTmV3LCBhbmQgYm90aCBraW5kcyBwb3NzaWJsZTogRXZlbnQgb3IgVGFzaywgY2hvc2VuIGJ5IHdoYXQgaXMgdHlwZWQKICAgIC8vIHVudGlsIGNob3NlbiBieSBoYW5kLgogICAgZWxzMi5raW5kcyA9IGVkLmlzTmV3ICYmIGNhbHMubGVuZ3RoICYmIGxpc3RzLmxlbmd0aCA_IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtZWRpdC1raW5kcycsIHJvbGU6ICdncm91cCcsICdhcmlhLWxhYmVsJzogJ0FkZCBhbiBldmVudCBvciBhIHRhc2snIH0sCiAgICAgIFsnZXZlbnQnLCAndGFzayddLm1hcChrID0-IGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ3NlZycsIHR5cGU6ICdidXR0b24nLCBkYXRhc2V0OiB7IGtpbmQ6IGssIGtleTogYGNhbC1lZGl0LWtpbmQ6JHtrfWAgfSwgdGV4dDogayA9PT0gJ2V2ZW50JyA_ICdFdmVudCcgOiAnVGFzaycsCiAgICAgICAgb25jbGljazogKCkgPT4geyBlZC5raW5kID0gazsgZWQua2luZENob3NlbiA9IHRydWU7IHN5bmMoKTsgfSwKICAgICAgfSkpKSA6IG51bGw7CgogICAgY",
"29uc3QgdGl0bGVJbnB1dCA9IGlucHV0KCd0aXRsZScsIHsKICAgICAgdmFsdWU6IGVkLnRpdGxlLCBtYXhsZW5ndGg6ICcxMDAwJywgZGF0YXNldDogeyBrZXk6ICdjYWwtZWRpdC10aXRsZScgfSwKICAgICAgcGxhY2Vob2xkZXI6IGVkLmlzTmV3ID8gJ0RlbnRpc3QgMTQ6MzAsIG9yIFBheSB0aGUgaW52b2ljZScgOiAnJywKICAgICAgb25pbnB1dDogZSA9PiB7CiAgICAgICAgZWQudGl0bGUgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgICBpZiAoIWVkLmlzTmV3KSByZXR1cm47CiAgICAgICAgY29uc3QgcSA9IGNhbC5wYXJzZVF1aWNrKGVkLnRpdGxlKTsKICAgICAgICBpZiAoIWVkLmtpbmRDaG9zZW4gJiYgZWxzMi5raW5kcykgZWQua2luZCA9IHEuc3RhcnQgPyAnZXZlbnQnIDogJ3Rhc2snOwogICAgICAgIGlmIChxLnN0YXJ0ICYmICFlZC50aW1lc1RvdWNoZWQpIHsKICAgICAgICAgIGV2LnN0YXJ0ID0gcS5zdGFydDsKICAgICAgICAgIGV2LmVuZCA9IHEuZW5kOwogICAgICAgICAgZXYuYWxsRGF5ID0gZmFsc2U7CiAgICAgICAgICBlbHMyLnN0YXJ0VGltZS52YWx1ZSA9IHEuc3RhcnQ7CiAgICAgICAgICBlbHMyLmVuZFRpbWUudmFsdWUgPSBxLmVuZDsKICAgICAgICAgIGVsczIuYWxsRGF5LmNoZWNrZWQgPSBmYWxzZTsKICAgICAgICB9CiAgICAgICAgc3luYygpOwogICAgICB9LAogICAgfSk7CgogICAgLy8gQW4gZXZlbnQ6IHdoZXJlIGl0IGdvZXMsIGFsbCBkYXkgb3Igd2hlbiwgaG93IGl0IHJlcGVhd",
"HMsIGFuZCB3aGVyZS4KICAgIGNvbnN0IHRpbWVJbnB1dCA9IChuYW1lLCBrZXkpID0-IGlucHV0KG5hbWUsIHsKICAgICAgY2xhc3M6ICd0ZXh0LWlucHV0IGNhbC10aW1lJywgdmFsdWU6IGV2W2tleV0sIG1heGxlbmd0aDogJzUnLCBpbnB1dG1vZGU6ICdudW1lcmljJywgcGxhY2Vob2xkZXI6IGtleSA9PT0gJ3N0YXJ0JyA_ICcwOTozMCcgOiAnMTA6MzAnLAogICAgICAnYXJpYS1sYWJlbCc6IGtleSA9PT0gJ3N0YXJ0JyA_ICdTdGFydCB0aW1lJyA6ICdFbmQgdGltZScsIGRhdGFzZXQ6IHsga2V5OiBgY2FsLWVkaXQtJHtuYW1lfWAgfSwKICAgICAgb25pbnB1dDogZSA9PiB7IGV2W2tleV0gPSBlLnRhcmdldC52YWx1ZTsgZWQudGltZXNUb3VjaGVkID0gdHJ1ZTsgfSwKICAgIH0pOwogICAgY29uc3QgZGF0ZUlucHV0ID0gKG5hbWUsIGdldCwgc2V0LCBsYWJlbCkgPT4gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCBjYWwtZGF0ZScsIHR5cGU6ICdkYXRlJywgaWQ6IGlkKG5hbWUpLCB2YWx1ZTogZ2V0KCksICdhcmlhLWxhYmVsJzogbGFiZWwsIGRhdGFzZXQ6IHsga2V5OiBgY2FsLWVkaXQtJHtuYW1lfWAgfSwKICAgICAgb25jaGFuZ2U6IGUgPT4gc2V0KGUudGFyZ2V0LnZhbHVlKSwgb25rZXlkb3duOiBvbkVudGVyLAogICAgfSk7CiAgICBlbHMyLnN0YXJ0VGltZSA9IHRpbWVJbnB1dCgnc3RhcnQtdGltZScsICdzdGFydCcpOwogICAgZWxzMi5lbmRUaW1lID0gdGltZUlucHV0KCdlbmQtd",
"GltZScsICdlbmQnKTsKICAgIGVsczIuYWxsRGF5ID0gaCgnaW5wdXQnLCB7CiAgICAgIHR5cGU6ICdjaGVja2JveCcsIGlkOiBpZCgnYWxsLWRheScpLCBjaGVja2VkOiAhIWV2LmFsbERheSwgZGF0YXNldDogeyBrZXk6ICdjYWwtZWRpdC1hbGwtZGF5JyB9LAogICAgICBvbmNoYW5nZTogZSA9PiB7IGV2LmFsbERheSA9IGUudGFyZ2V0LmNoZWNrZWQ7IHN5bmMoKTsgfSwKICAgIH0pOwoKICAgIC8vIEhvdyBpdCByZXBlYXRzOiBHb29nbGUncyBtZW51IGZvciB0aGUgZGF5IGl0IHN0YXJ0cywgYW5kIEN1c3RvbS4KICAgIGNvbnN0IHRvdWNoID0gKCkgPT4geyBlZC5yZXBlYXRUb3VjaGVkID0gdHJ1ZTsgfTsKICAgIGVsczIucmVwZWF0ID0gaCgnc2VsZWN0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCBpZDogaWQoJ3JlcGVhdCcpLCBkYXRhc2V0OiB7IGtleTogJ2NhbC1lZGl0LXJlcGVhdCcgfSwKICAgICAgb25jaGFuZ2U6IGUgPT4gewogICAgICAgIHRvdWNoKCk7CiAgICAgICAgY29uc3QgdiA9IGUudGFyZ2V0LnZhbHVlOwogICAgICAgIGVkLnJlcGVhdCA9IHYgPT09ICdvdGhlcicgPyBjb3B5UmVwZWF0KGVkLnJlcGVhdEF0KSA6IHsgaWQ6IHYsIHJ1bGU6ICcnLCBjdXN0b206IHYgPT09ICdjdXN0b20nID8gKGVkLnJlcGVhdC5jdXN0b20gfHwgY2FsLmN1c3RvbUZvcihyZXBlYXREYXkoZWQpKSkgOiB1bmRlZmluZWQgfTsKICAgICAgICBzeW5jKCk7CiAgICAgIH0sCiAgICB9KTsKICAgIGNvbnN0I",
"GMgPSAoKSA9PiBlZC5yZXBlYXQuY3VzdG9tOwogICAgZWxzMi5ldmVyeSA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQgY2FsLWV2ZXJ5JywgdHlwZTogJ251bWJlcicsIG1pbjogJzEnLCBtYXg6ICc5OTknLCBpZDogaWQoJ2V2ZXJ5JyksICdhcmlhLWxhYmVsJzogJ1JlcGVhdCBldmVyeScsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWVkaXQtZXZlcnknIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyB0b3VjaCgpOyBjKCkuZXZlcnkgPSBNYXRoLm1heCgxLCBOdW1iZXIoZS50YXJnZXQudmFsdWUpIHx8IDEpOyBzeW5jKCk7IH0sCiAgICB9KTsKICAgIGVsczIudW5pdCA9IGgoJ3NlbGVjdCcsIHsKICAgICAgY2xhc3M6ICd0ZXh0LWlucHV0JywgJ2FyaWEtbGFiZWwnOiAnVW5pdCcsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWVkaXQtdW5pdCcgfSwKICAgICAgb25jaGFuZ2U6IGUgPT4geyB0b3VjaCgpOyBjKCkudW5pdCA9IGUudGFyZ2V0LnZhbHVlOyBzeW5jKCk7IH0sCiAgICB9KTsKICAgIGVsczIuZGF5cyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtZGF5cycsIHJvbGU6ICdncm91cCcsICdhcmlhLWxhYmVsJzogJ09uJyB9LAogICAgICBjYWwuV0VFS0RBWV9DT0RFUy5tYXAoKGNvZGUsIGkpID0-IGgoJ2J1dHRvbicsIHsKICAgICAgICB0eXBlOiAnYnV0dG9uJywgY2xhc3M6ICdjYWwtZGF5LXBpY2snLCB0ZXh0OiBjYWwuV0VFS0RBWV9OQU1FU1tpXVswXSwgdGl0bGU6IGNhbC5XRUVLREFZX05BT",
"UVTW2ldLAogICAgICAgICdhcmlhLWxhYmVsJzogY2FsLldFRUtEQVlfTkFNRVNbaV0sIGRhdGFzZXQ6IHsgY29kZSwga2V5OiBgY2FsLWVkaXQtZGF5OiR7Y29kZX1gIH0sCiAgICAgICAgb25jbGljazogKCkgPT4gewogICAgICAgICAgdG91Y2goKTsKICAgICAgICAgIGNvbnN0IGRheXMgPSBjKCkuZGF5czsKICAgICAgICAgIGMoKS5kYXlzID0gZGF5cy5pbmNsdWRlcyhjb2RlKSA_IGRheXMuZmlsdGVyKGQgPT4gZCAhPT0gY29kZSkgOiBkYXlzLmNvbmNhdChjb2RlKTsKICAgICAgICAgIHN5bmMoKTsKICAgICAgICB9LAogICAgICB9KSkpOwogICAgZWxzMi5tb250aEJ5ID0gaCgnc2VsZWN0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCAnYXJpYS1sYWJlbCc6ICdXaGljaCBkYXkgb2YgdGhlIG1vbnRoJywgZGF0YXNldDogeyBrZXk6ICdjYWwtZWRpdC1tb250aC1ieScgfSwKICAgICAgb25jaGFuZ2U6IGUgPT4geyB0b3VjaCgpOyBjKCkubW9udGhCeSA9IGUudGFyZ2V0LnZhbHVlOyB9LAogICAgfSk7CiAgICBjb25zdCBlbmRzUmFkaW8gPSAodmFsdWUsIGxhYmVsLCAuLi5tb3JlKSA9PiBoKCdsYWJlbCcsIHsgY2xhc3M6ICdjYWwtZWRpdC1jaGVjaycgfSwKICAgICAgaCgnaW5wdXQnLCB7CiAgICAgICAgdHlwZTogJ3JhZGlvJywgbmFtZTogJ2drYi1jYWwtZW5kcycsIHZhbHVlLCBkYXRhc2V0OiB7IGtleTogYGNhbC1lZGl0LWVuZHM6JHt2YWx1ZX1gIH0sCiAgICAgICAgb25jaGFuZ2U6ICgpID0-I",
"HsgdG91Y2goKTsgYygpLmVuZHMgPSB2YWx1ZTsgc3luYygpOyB9LAogICAgICB9KSwgbGFiZWwsIC4uLm1vcmUpOwogICAgZWxzMi51bnRpbCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQgY2FsLWRhdGUnLCB0eXBlOiAnZGF0ZScsICdhcmlhLWxhYmVsJzogJ0VuZHMgb24nLCBkYXRhc2V0OiB7IGtleTogJ2NhbC1lZGl0LXVudGlsJyB9LAogICAgICBvbmNoYW5nZTogZSA9PiB7IHRvdWNoKCk7IGMoKS51bnRpbCA9IGUudGFyZ2V0LnZhbHVlOyB9LAogICAgfSk7CiAgICBlbHMyLmNvdW50ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCBjYWwtZXZlcnknLCB0eXBlOiAnbnVtYmVyJywgbWluOiAnMScsIG1heDogJzk5OScsICdhcmlhLWxhYmVsJzogJ0VuZHMgYWZ0ZXIgc28gbWFueSB0aW1lcycsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWVkaXQtY291bnQnIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyB0b3VjaCgpOyBjKCkuY291bnQgPSBNYXRoLm1heCgxLCBOdW1iZXIoZS50YXJnZXQudmFsdWUpIHx8IDEpOyB9LAogICAgfSk7CiAgICBlbHMyLmVuZHMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWVuZHMnLCByb2xlOiAncmFkaW9ncm91cCcsICdhcmlhLWxhYmVsJzogJ0VuZHMnIH0sCiAgICAgIGVuZHNSYWRpbygnbmV2ZXInLCAnTmV2ZXInKSwKICAgICAgZW5kc1JhZGlvKCdvbicsICdPbicsIGVsczIudW50aWwpLAogICAgICBlbmRzUmFkaW8oJ2FmdGVyJywgJ",
"0FmdGVyJywgZWxzMi5jb3VudCwgJyB0aW1lcycpKTsKICAgIGVsczIuY3VzdG9tID0gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1yZXBlYXQtY3VzdG9tJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnY2FsLWVkaXQtcm93JyB9LCBoKCdzcGFuJywgeyB0ZXh0OiAnRXZlcnknIH0pLCBlbHMyLmV2ZXJ5LCBlbHMyLnVuaXQpLAogICAgICBlbHMyLmRheXMsIGVsczIubW9udGhCeSwKICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmaWVsZC1sYWJlbCcsIHRleHQ6ICdFbmRzJyB9KSwgZWxzMi5lbmRzKTsKICAgIGVsczIucmVwZWF0Tm90ZSA9IGgoJ3AnLCB7IGNsYXNzOiAnbm90ZScgfSk7CgogICAgY29uc3Qgc3luY1JlcGVhdCA9ICgpID0-IHsKICAgICAgY29uc3QgZGF5ID0gcmVwZWF0RGF5KGVkKTsKICAgICAgY29uc3QgbG9hZGluZyA9ICEhKGVkLnNlcmllcyAmJiBlZC5zZXJpZXMuc3RhdGUgPT09ICdsb2FkaW5nJyk7CiAgICAgIGNvbnN0IGJyb2tlbiA9ICEhKGVkLnNlcmllcyAmJiBlZC5zZXJpZXMuc3RhdGUgPT09ICdlcnJvcicpOwogICAgICBjb25zdCBvcHRpb25zID0gY2FsLnJlcGVhdENob2ljZXMoZGF5KS5tYXAobyA9PiBbby5pZCwgby5sYWJlbF0pLmNvbmNhdChbWydjdXN0b20nLCAnQ3VzdG9t4oCmJ11dKTsKICAgICAgaWYgKGVkLnJlcGVhdC5pZCA9PT0gJ290aGVyJyB8fCAoZWQucmVwZWF0QXQgJiYgZWQucmVwZWF0QXQuaWQgPT09ICdvdGhlcicpKSBvcHRpb25zLnB1c2goWydvdGhlcicsI",
"CdBcyBzZXQgaW4gR29vZ2xlIENhbGVuZGFyJ10pOwogICAgICBpZiAoZWxzMi5yZXBlYXQuZGF0YXNldC5kYXkgIT09IGRheSB8fCBlbHMyLnJlcGVhdC5vcHRpb25zLmxlbmd0aCAhPT0gb3B0aW9ucy5sZW5ndGgpIHsKICAgICAgICBlbHMyLnJlcGVhdC5yZXBsYWNlQ2hpbGRyZW4oLi4ub3B0aW9ucy5tYXAoKFt2LCBsYWJlbF0pID0-IGgoJ29wdGlvbicsIHsgdmFsdWU6IHYsIHRleHQ6IGxhYmVsIH0pKSk7CiAgICAgICAgZWxzMi5yZXBlYXQuZGF0YXNldC5kYXkgPSBkYXk7CiAgICAgIH0KICAgICAgZWxzMi5yZXBlYXQudmFsdWUgPSBlZC5yZXBlYXQuaWQ7CiAgICAgIGVsczIucmVwZWF0LmRpc2FibGVkID0gbG9hZGluZzsKICAgICAgZWxzMi5yZXBlYXRGaWVsZC5oaWRkZW4gPSBicm9rZW47CiAgICAgIGVsczIucmVwZWF0Tm90ZS5oaWRkZW4gPSAhKGxvYWRpbmcgfHwgYnJva2VuKTsKICAgICAgZWxzMi5yZXBlYXROb3RlLnRleHRDb250ZW50ID0gbG9hZGluZyA_ICdSZWFkaW5nIGhvdyBpdCByZXBlYXRz4oCmJwogICAgICAgIDogYnJva2VuID8gYEl0IHJlcGVhdHMsIGJ1dCB0aGUgc2VyaWVzIGNvdWxkIG5vdCBiZSByZWFkICgke2VkLnNlcmllcy5lcnJvcn0pOiBhIGNoYW5nZSBoZXJlIGlzIHRvIHRoaXMgZXZlbnQgb25seS5gIDogJyc7CiAgICAgIGNvbnN0IGN1ID0gZWQucmVwZWF0LmlkID09PSAnY3VzdG9tJyA_IGVkLnJlcGVhdC5jdXN0b20gOiBudWxsOwogICAgICBlbHMyLmN1c3RvbS5oaWRkZ",
"W4gPSAhY3U7CiAgICAgIGlmICghY3UpIHJldHVybjsKICAgICAgaWYgKEMuY3R4LnJvb3QuYWN0aXZlRWxlbWVudCAhPT0gZWxzMi5ldmVyeSkgZWxzMi5ldmVyeS52YWx1ZSA9IFN0cmluZyhjdS5ldmVyeSk7CiAgICAgIGVsczIudW5pdC5yZXBsYWNlQ2hpbGRyZW4oLi4uVU5JVFMubWFwKChbdiwgcGx1cmFsXSkgPT4gaCgnb3B0aW9uJywgeyB2YWx1ZTogdiwgdGV4dDogY3UuZXZlcnkgPiAxID8gcGx1cmFsIDogdiB9KSkpOwogICAgICBlbHMyLnVuaXQudmFsdWUgPSBjdS51bml0OwogICAgICBlbHMyLmRheXMuaGlkZGVuID0gY3UudW5pdCAhPT0gJ3dlZWsnOwogICAgICBmb3IgKGNvbnN0IGIgb2YgZWxzMi5kYXlzLmNoaWxkcmVuKSBiLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKGN1LmRheXMuaW5jbHVkZXMoYi5kYXRhc2V0LmNvZGUpKSk7CiAgICAgIGVsczIubW9udGhCeS5oaWRkZW4gPSBjdS51bml0ICE9PSAnbW9udGgnOwogICAgICBlbHMyLm1vbnRoQnkucmVwbGFjZUNoaWxkcmVuKAogICAgICAgIGgoJ29wdGlvbicsIHsgdmFsdWU6ICdkYXRlJywgdGV4dDogYE9uIGRheSAke051bWJlcihkYXkuc2xpY2UoOCkpfWAgfSksCiAgICAgICAgaCgnb3B0aW9uJywgeyB2YWx1ZTogJ3dlZWtkYXknLCB0ZXh0OiBjYWwucmVwZWF0Q2hvaWNlcyhkYXkpWzNdLmxhYmVsLnJlcGxhY2UoL15Nb250aGx5IG9uIC8sICdPbiAnKSB9KSk7CiAgICAgIGVsczIubW9udGhCeS52YWx1ZSA9IGN1Lm1vb",
"nRoQnk7CiAgICAgIGZvciAoY29uc3QgciBvZiBlbHMyLmVuZHMucXVlcnlTZWxlY3RvckFsbCgnaW5wdXRbdHlwZT0icmFkaW8iXScpKSByLmNoZWNrZWQgPSByLnZhbHVlID09PSBjdS5lbmRzOwogICAgICBlbHMyLnVudGlsLnZhbHVlID0gY3UudW50aWw7CiAgICAgIGVsczIudW50aWwuZGlzYWJsZWQgPSBjdS5lbmRzICE9PSAnb24nOwogICAgICBpZiAoQy5jdHgucm9vdC5hY3RpdmVFbGVtZW50ICE9PSBlbHMyLmNvdW50KSBlbHMyLmNvdW50LnZhbHVlID0gU3RyaW5nKGN1LmNvdW50KTsKICAgICAgZWxzMi5jb3VudC5kaXNhYmxlZCA9IGN1LmVuZHMgIT09ICdhZnRlcic7CiAgICB9OwoKICAgIGVsczIucmVwZWF0RmllbGQgPSBmaWVsZCgncmVwZWF0JywgJ1JlcGVhdHMnLCBlbHMyLnJlcGVhdCwgZWxzMi5jdXN0b20pOwogICAgZWxzMi5ldmVudCA9IGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtZWRpdC1wYXJ0JyB9LAogICAgICBmaWVsZCgnY2FsZW5kYXInLCAnQ2FsZW5kYXInLCBwaWNrKCdjYWxlbmRhcicsIGNhbHMsIGV2LnNvdXJjZSwgdiA9PiB7IGV2LnNvdXJjZSA9IHY7IH0pKSwKICAgICAgaCgnbGFiZWwnLCB7IGNsYXNzOiAnY2FsLWVkaXQtY2hlY2snIH0sIGVsczIuYWxsRGF5LCAnQWxsIGRheScpLAogICAgICBmaWVsZCgnc3RhcnQtZGF5JywgJ1N0YXJ0cycsIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtZWRpdC1yb3cnIH0sCiAgICAgICAgZGF0ZUlucHV0KCdzdGFydC1kYXknLCAoKSA9PiBldi5kY",
"XksIHYgPT4geyBldi5kYXkgPSB2OyBpZiAoIWV2LmVuZERheSB8fCBldi5lbmREYXkgPCB2KSB7IGV2LmVuZERheSA9IHY7IGVsczIuZW5kRGF5LnZhbHVlID0gdjsgfSBzeW5jKCk7IH0sICdTdGFydCBkYXknKSwKICAgICAgICBlbHMyLnN0YXJ0VGltZSkpLAogICAgICBmaWVsZCgnZW5kLWRheScsICdFbmRzJywgaCgnZGl2JywgeyBjbGFzczogJ2NhbC1lZGl0LXJvdycgfSwKICAgICAgICBlbHMyLmVuZERheSA9IGRhdGVJbnB1dCgnZW5kLWRheScsICgpID0-IGV2LmVuZERheSwgdiA9PiB7IGV2LmVuZERheSA9IHY7IH0sICdFbmQgZGF5JyksCiAgICAgICAgZWxzMi5lbmRUaW1lKSksCiAgICAgIGVsczIucmVwZWF0RmllbGQsCiAgICAgIGVsczIucmVwZWF0Tm90ZSwKICAgICAgZmllbGQoJ3doZXJlJywgJ1doZXJlJywgaW5wdXQoJ3doZXJlJywgeyB2YWx1ZTogZXYud2hlcmUgfHwgJycsIG1heGxlbmd0aDogJzUwMCcsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWVkaXQtd2hlcmUnIH0sIG9uaW5wdXQ6IGUgPT4geyBldi53aGVyZSA9IGUudGFyZ2V0LnZhbHVlOyB9IH0pKSk7CgogICAgLy8gQSB0YXNrOiBpdHMgbGlzdCwgaXRzIGRheSAob3Igbm9uZSksIGFuZCBkb25lLgogICAgZWxzMi50YXNrID0gaCgnZGl2JywgeyBjbGFzczogJ2NhbC1lZGl0LXBhcnQnIH0sCiAgICAgIGZpZWxkKCdsaXN0JywgJ0xpc3QnLCBwaWNrKCdsaXN0JywgbGlzdHMsIHRrLnNvdXJjZSwgdiA9PiB7IHRrLnNvdXJjZSA9IHY7IH0pK",
"SwKICAgICAgZmllbGQoJ3Rhc2stZGF5JywgJ0RheScsIGgoJ2RpdicsIHsgY2xhc3M6ICdjYWwtZWRpdC1yb3cnIH0sCiAgICAgICAgZWxzMi50YXNrRGF5ID0gZGF0ZUlucHV0KCd0YXNrLWRheScsICgpID0-IHRrLmRheSwgdiA9PiB7IHRrLmRheSA9IHY7IH0sICdEYXknKSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2xpbmstYnRuJywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdObyBkYXRlJywgZGF0YXNldDogeyBrZXk6ICdjYWwtZWRpdC1uby1kYXRlJyB9LAogICAgICAgICAgb25jbGljazogKCkgPT4geyB0ay5kYXkgPSAnJzsgZWxzMi50YXNrRGF5LnZhbHVlID0gJyc7IH0sCiAgICAgICAgfSkpKSwKICAgICAgZWQuaXNOZXcgPyBudWxsIDogaCgnbGFiZWwnLCB7IGNsYXNzOiAnY2FsLWVkaXQtY2hlY2snIH0sIGgoJ2lucHV0JywgewogICAgICAgIHR5cGU6ICdjaGVja2JveCcsIGNoZWNrZWQ6ICEhdGsuZG9uZSwgZGF0YXNldDogeyBrZXk6ICdjYWwtZWRpdC1kb25lJyB9LCBvbmNoYW5nZTogZSA9PiB7IHRrLmRvbmUgPSBlLnRhcmdldC5jaGVja2VkOyB9LAogICAgICB9KSwgJ0RvbmUnKSk7CgogICAgZWxzMi5lcnJvciA9IGgoJ2RpdicsIHsgY2xhc3M6ICdmb3JtLWVycm9yJywgcm9sZTogJ2FsZXJ0JyB9KTsKICAgIGVsczIuc2F2ZSA9IGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdidG4gYnRuLXByaW1hcnknLCB0eXBlOiAnYnV0dG9uJywgZGF0YXNldDogeyBrZXk6ICdjYWwtZ",
"WRpdC1zYXZlJyB9LCBvbmNsaWNrOiAoKSA9PiBzYXZlRWRpdChlZCkgfSk7CiAgICBjb25zdCB3aGVyZSA9IGVkLml0ZW0gPyBzb3VyY2VOYW1lKGVkLml0ZW0uc291cmNlKSA6ICcnOwogICAgY29uc3QgZ29vZ2xlID0gZWQuaXRlbSAmJiBlZC5pdGVtLmtpbmQgPT09ICd0YXNrJyA_ICdHb29nbGUgVGFza3MnIDogJ0dvb2dsZSBDYWxlbmRhcic7CiAgICBlbHMyLmZvb3QgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZGlhbG9nLWZvb3QnIH0sCiAgICAgIGVkLml0ZW0gPyBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdidG4gYnRuLXRleHQgZGFuZ2VyJywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdEZWxldGUnLCBkYXRhc2V0OiB7IGtleTogJ2NhbC1lZGl0LWRlbGV0ZScgfSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiB7IGVkLmNvbmZpcm1pbmcgPSB0cnVlOyBlZC5lcnJvciA9ICcnOyBzeW5jKCk7IGZvY3VzSW4oJ2NhbC1lZGl0LWRlbGV0ZS15ZXMnKTsgfSwKICAgICAgfSkgOiBudWxsLAogICAgICBlZC5pdGVtICYmIGVkLml0ZW0ubGluayA_IGgoJ2EnLCB7CiAgICAgICAgY2xhc3M6ICdidG4gYnRuLXRleHQnLCBocmVmOiBlZC5pdGVtLmxpbmssIHRhcmdldDogJ19ibGFuaycsIHJlbDogJ25vb3BlbmVyIG5vcmVmZXJyZXInLCB0ZXh0OiBgT3BlbiBpbiAke2dvb2dsZX1gLAogICAgICB9KSA6IG51bGwsCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3BhY2VyJyB9KSwKICAgICAgaCgnYnV0dG9uJywgeyBjb",
"GFzczogJ2J0biBidG4tdGV4dCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQ2FuY2VsJywgb25jbGljazogKCkgPT4gQy5jdHguZGlhbG9nLmNsb3NlKCkgfSksCiAgICAgIGVsczIuc2F2ZSk7CgogICAgLy8gQW4gb2NjdXJyZW5jZTogdGhpcyBldmVudCwgb3IgYWxsIGV2ZW50cyBpbiB0aGUgc2VyaWVzPwogICAgY29uc3Qgc2VyaWVzUmVhZHkgPSAoKSA9PiAhIShlZC5zZXJpZXMgJiYgZWQuc2VyaWVzLnN0YXRlID09PSAncmVhZHknKTsKICAgIGlmIChyZWN1cnJpbmcpIHsKICAgICAgZWxzMi5zY29wZVRleHQgPSBoKCdzcGFuJywgeyBjbGFzczogJ25vdGUnIH0pOwogICAgICBlbHMyLnNjb3BlT25lID0gaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdUaGlzIGV2ZW50JywgZGF0YXNldDogeyBrZXk6ICdjYWwtZWRpdC1zY29wZS1vbmUnIH0sCiAgICAgICAgb25jbGljazogKCkgPT4gc2F2ZUVkaXQoZWQsICdvbmUnKSwKICAgICAgfSk7CiAgICAgIGVsczIuc2NvcGVBbGwgPSBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdidG4gYnRuLXByaW1hcnknLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ0FsbCBldmVudHMnLCBkYXRhc2V0OiB7IGtleTogJ2NhbC1lZGl0LXNjb3BlLWFsbCcgfSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiB7IGlmIChzZXJpZXNSZWFkeSgpKSBzYXZlRWRpdChlZCwgJ2FsbCcpOyB9LAogICAgICB9KTsKICAgI",
"CAgZWxzMi5zY29wZSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2ctZm9vdCBjYWwtZWRpdC1jb25maXJtJywgcm9sZTogJ2FsZXJ0JyB9LAogICAgICAgIGVsczIuc2NvcGVUZXh0LAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdCYWNrJywgZGF0YXNldDogeyBrZXk6ICdjYWwtZWRpdC1zY29wZS1ubycgfSwKICAgICAgICAgIG9uY2xpY2s6ICgpID0-IHsgZWQuc2NvcGUgPSBmYWxzZTsgZWQucnVsZUNoYW5nZWQgPSBmYWxzZTsgZWQuc3RvcHBpbmcgPSBmYWxzZTsgc3luYygpOyBmb2N1c0luKCdjYWwtZWRpdC1zYXZlJyk7IH0sCiAgICAgICAgfSksCiAgICAgICAgZWxzMi5zY29wZU9uZSwgZWxzMi5zY29wZUFsbCk7CiAgICB9CgogICAgLy8gRGVsZXRpbmcgYXNrcyBmaXJzdCwgbmFtaW5nIHdoYXQgYW5kIHdoZXJlOyBhbiBvY2N1cnJlbmNlLCB3aGV0aGVyCiAgICAvLyBpdCBpcyB0aGlzIGV2ZW50IG9yIGV2ZXJ5IGV2ZW50IGluIHRoZSBzZXJpZXMuCiAgICBlbHMyLmRlbGV0ZUFsbCA9IHJlY3VycmluZyA_IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdidG4gYnRuLWRhbmdlcicsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQWxsIGV2ZW50cycsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWVkaXQtZGVsZXRlLWFsbCcgfSwKICAgICAgb25jbGljazogKCkgPT4geyBpZiAoIXNlcmllc1JlYWR5KCkpIHJldHVybjsgY",
"29uc3QgaXQgPSBlZC5pdGVtOyBjb25zdCBzID0gZWQuc2VyaWVzLmV2ZW50OyBDLmN0eC5kaWFsb2cuY2xvc2UoKTsgZGVsZXRlU2VyaWVzTGF0ZXIocywgaXQpOyB9LAogICAgfSkgOiBudWxsOwogICAgZWxzMi5jb25maXJtID0gaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1mb290IGNhbC1lZGl0LWNvbmZpcm0nLCByb2xlOiAnYWxlcnQnIH0sCiAgICAgIGgoJ3NwYW4nLCB7CiAgICAgICAgY2xhc3M6ICdub3RlJywKICAgICAgICB0ZXh0OiAhZWQuaXRlbSA_ICcnIDogcmVjdXJyaW5nCiAgICAgICAgICA_IGBEZWxldGUg4oCcJHtlZC5pdGVtLnRpdGxlfeKAnSR7d2hlcmUgPyBgIGZyb20gJHt3aGVyZX1gIDogJyd9OiB0aGlzIGV2ZW50IG9ubHksIG9yIGV2ZXJ5IGV2ZW50IGluIHRoZSBzZXJpZXM_IEl0IGdvZXMgZnJvbSAke2dvb2dsZX0gdG9vLCBvbmNlIFVuZG8gaGFzIHBhc3NlZC5gCiAgICAgICAgICA6IGBEZWxldGUg4oCcJHtlZC5pdGVtLnRpdGxlfeKAnSR7d2hlcmUgPyBgIGZyb20gJHt3aGVyZX1gIDogJyd9PyBJdCBnb2VzIGZyb20gJHtnb29nbGV9IHRvbywgb25jZSBVbmRvIGhhcyBwYXNzZWQuYCwKICAgICAgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2J0biBidG4tdGV4dCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnS2VlcCBpdCcsIGRhdGFzZXQ6IHsga2V5OiAnY2FsLWVkaXQtZGVsZXRlLW5vJyB9LAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgZWQuY29uZmlyb",
"WluZyA9IGZhbHNlOyBzeW5jKCk7IGZvY3VzSW4oJ2NhbC1lZGl0LWRlbGV0ZScpOyB9LAogICAgICB9KSwKICAgICAgaCgnYnV0dG9uJywgewogICAgICAgIGNsYXNzOiByZWN1cnJpbmcgPyAnYnRuIGJ0bi10ZXh0IGRhbmdlcicgOiAnYnRuIGJ0bi1kYW5nZXInLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogcmVjdXJyaW5nID8gJ1RoaXMgZXZlbnQnIDogJ0RlbGV0ZScsCiAgICAgICAgZGF0YXNldDogeyBrZXk6ICdjYWwtZWRpdC1kZWxldGUteWVzJyB9LAogICAgICAgIG9uY2xpY2s6ICgpID0-IHsgY29uc3QgaXQgPSBlZC5pdGVtOyBDLmN0eC5kaWFsb2cuY2xvc2UoKTsgZGVsZXRlTGF0ZXIoaXQpOyB9LAogICAgICB9KSwKICAgICAgZWxzMi5kZWxldGVBbGwpOwoKICAgIGNvbnN0IGhlYWRpbmcgPSBlZC5pc05ldyA_ICdBZGQnIDogZWQuaXRlbS5raW5kID09PSAndGFzaycgPyAnVGFzaycgOiAnRXZlbnQnOwogICAgY29uc3QgZGlhbG9nID0gaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZyBjYWwtZWRpdCcsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1tb2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6IGlkKCdoZWFkaW5nJykgfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1oZWFkJyB9LAogICAgICAgIGgoJ2gyJywgeyBpZDogaWQoJ2hlYWRpbmcnKSwgdGV4dDogaGVhZGluZyB9KSwKICAgICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2Fya",
"WEtbGFiZWwnOiAnQ2xvc2Ugd2l0aG91dCBzYXZpbmcnLCBvbmNsaWNrOiAoKSA9PiBDLmN0eC5kaWFsb2cuY2xvc2UoKSB9LCBpY29uKCdjbG9zZScpKSksCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2ctYm9keScgfSwKICAgICAgICBlbHMyLmtpbmRzLAogICAgICAgIGZpZWxkKCd0aXRsZScsICdUaXRsZScsIHRpdGxlSW5wdXQpLAogICAgICAgIGVsczIuZXZlbnQsCiAgICAgICAgZWxzMi50YXNrKSwKICAgICAgZWxzMi5lcnJvciwKICAgICAgZWxzMi5mb290LAogICAgICBlbHMyLnNjb3BlLAogICAgICBlbHMyLmNvbmZpcm0pOwogICAgc3luYygpOwogICAgcmV0dXJuIGRpYWxvZzsKICB9CgogIGZ1bmN0aW9uIGZvY3VzSW4oa2V5KSB7CiAgICBjb25zdCBlbCA9IEMuY3R4LnJvb3QucXVlcnlTZWxlY3RvcihgW2RhdGEta2V5PSIke2tleX0iXWApOwogICAgaWYgKGVsKSBlbC5mb2N1cygpOwogIH0KCiAgLy8gYHNjb3BlYCwgZm9yIGFuIG9jY3VycmVuY2Ugb2YgYSBzZXJpZXM6ICdvbmUnIG9yICdhbGwnLCBhcyBjaG9zZW4gaW4KICAvLyB0aGUgcm93IFNhdmUgYnJpbmdzIHVwLgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVFZGl0KGVkLCBzY29wZSA9ICcnKSB7CiAgICBpZiAoZWQuc2F2aW5nIHx8IGVkLmNvbmZpcm1pbmcgfHwgKGVkLnNjb3BlICYmICFzY29wZSkpIHJldHVybjsKICAgIGNvbnN0IGRyYWZ0ID0gT2JqZWN0LmFzc2lnbih7fSwgZWQua2luZCA9PT0gJ2V2ZW50JyA_IGVkLmV2ZW50IDogZ",
"WQudGFzayk7CiAgICBsZXQgdGl0bGUgPSBlZC50aXRsZTsKICAgIC8vICJEZW50aXN0IDE0OjMwIjogdGhlIHRpbWUgd2VudCBpbnRvIHRoZSB0aW1lcywgbm90IHRoZSB0aXRsZS4KICAgIGlmIChlZC5pc05ldyAmJiBlZC5raW5kID09PSAnZXZlbnQnKSB7CiAgICAgIGNvbnN0IHEgPSBjYWwucGFyc2VRdWljayh0aXRsZSk7CiAgICAgIGlmIChxLnN0YXJ0KSB0aXRsZSA9IHEudGl0bGU7CiAgICB9CiAgICBkcmFmdC50aXRsZSA9IHRpdGxlOwogICAgY29uc3QgaXNFdmVudCA9IGRyYWZ0LmtpbmQgPT09ICdldmVudCc7CiAgICBjb25zdCB0eiA9IHRpbWVab25lKCk7CiAgICBjb25zdCBzZXJpZXMgPSBlZC5zZXJpZXMgJiYgZWQuc2VyaWVzLnN0YXRlID09PSAncmVhZHknID8gZWQuc2VyaWVzLmV2ZW50IDogbnVsbDsKICAgIGNvbnN0IHJ1bGUgPSBpc0V2ZW50ID8gY2FsLnJ1bGVGb3IoZWQucmVwZWF0LCByZXBlYXREYXkoZWQpLCBkcmFmdC5hbGxEYXkpIDogJyc7CiAgICAvLyBDaGVja2VkIGhlcmUgZmlyc3Q6IHdoYXQgd2lsbCBub3QgZG8gbmV2ZXIgbGVhdmVzIHRoZSBwYWdlLgogICAgY29uc3QgbWFkZSA9ICFpc0V2ZW50ID8gY2FsLnRhc2tCb2R5KGRyYWZ0LCB7IHBhdGNoOiAhZWQuaXNOZXcgfSkKICAgICAgOiBjYWwuZXZlbnRCb2R5KHNjb3BlID09PSAnYWxsJyAmJiBzZXJpZXMgPyBjYWwuc2VyaWVzRHJhZnQoY2FsLnN0YXJ0RGF5T2Yoc2VyaWVzKSwgZWQuaXRlbS5maXJzdCwgZHJhZnQpIDogZHJhZ",
"nQsIHR6LCB7IHBhdGNoOiAhZWQuaXNOZXcgfSk7CiAgICBpZiAobWFkZS5lcnJvcikgewogICAgICBlZC5lcnJvciA9IG1hZGUuZXJyb3I7CiAgICAgIGVkLnNjb3BlID0gZmFsc2U7CiAgICAgIGVkLnN5bmMoKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgLy8gQW4gb2NjdXJyZW5jZTogd2hpY2gsIGZpcnN0LiBBIG5ldyBydWxlIGNhbiBvbmx5IGJlIGZvciBhbGwgb2YgdGhlbS4KICAgIGlmIChlZC5pdGVtICYmIGVkLml0ZW0ucmVjdXJyaW5nICYmICFzY29wZSkgewogICAgICBlZC5ydWxlQ2hhbmdlZCA9ICEhKHNlcmllcyAmJiBlZC5yZXBlYXRUb3VjaGVkICYmIHJ1bGUgIT09IGNhbC5ydWxlRm9yKGVkLnJlcGVhdEF0LCByZXBlYXREYXkoZWQpLCBkcmFmdC5hbGxEYXkpKTsKICAgICAgZWQuc3RvcHBpbmcgPSBlZC5ydWxlQ2hhbmdlZCAmJiAhcnVsZTsKICAgICAgZWQuc2NvcGUgPSB0cnVlOwogICAgICBlZC5lcnJvciA9ICcnOwogICAgICBlZC5zeW5jKCk7CiAgICAgIGZvY3VzSW4oZWQucnVsZUNoYW5nZWQgfHwgIXNlcmllcyA_ICdjYWwtZWRpdC1zY29wZS1hbGwnIDogJ2NhbC1lZGl0LXNjb3BlLW9uZScpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoc2NvcGUgPT09ICdhbGwnICYmICFzZXJpZXMpIHJldHVybjsKICAgIC8vIEV2ZXJ5IGV2ZW50IGluIGEgc2VyaWVzIGJhciB0aGUgZmlyc3QgZ29uZTogbGlrZSBhIGRlbGV0ZSwgYWZ0ZXIgYW4gVW5kby4KICAgIGlmIChzY29wZSA9PT0gJ2Fsb",
"CcgJiYgIXJ1bGUpIHsKICAgICAgY29uc3QgaXRlbSA9IGVkLml0ZW07CiAgICAgIEMuY3R4LmRpYWxvZy5jbG9zZSgpOwogICAgICBzdG9wTGF0ZXIoc2VyaWVzLCBpdGVtLCBkcmFmdCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGxldCBydW47CiAgICBpZiAoc2NvcGUgPT09ICdhbGwnKSBydW4gPSAoKSA9PiBzdG9yZS5zYXZlU2VyaWVzKHNlcmllcywgZWQuaXRlbSwgZHJhZnQsIHJ1bGUsIHR6KTsKICAgIGVsc2UgaWYgKHNjb3BlID09PSAnb25lJykgcnVuID0gdmVyc2lvbmVkKGVkLml0ZW0sIGl0ID0-IHN0b3JlLnNhdmUoaXQsIGRyYWZ0LCB0eikpOwogICAgZWxzZSBpZiAoZWQuaXNOZXcpIHJ1biA9ICgpID0-IHN0b3JlLnNhdmUobnVsbCwgZHJhZnQsIHR6LCBydWxlID8gW3J1bGVdIDogdW5kZWZpbmVkKTsKICAgIC8vIEFuIGV2ZW50IHRoYXQgZGlkIG5vdCByZXBlYXQ6IGZyb20gbm93IG9uIGl0IGRvZXMsIGlmIGEgcnVsZSB3YXMgY2hvc2VuLgogICAgZWxzZSBydW4gPSB2ZXJzaW9uZWQoZWQuaXRlbSwgaXQgPT4gc3RvcmUuc2F2ZShpdCwgZHJhZnQsIHR6LCBpc0V2ZW50ICYmIHJ1bGUgPyBjYWwucmVjdXJyZW5jZVdpdGgoW10sIHJ1bGUpIDogdW5kZWZpbmVkKSk7CiAgICBlZC5zYXZpbmcgPSB0cnVlOwogICAgZWQuZXJyb3IgPSAnJzsKICAgIGVkLnN5bmMoKTsKICAgIGNvbnN0IHdoYXQgPSBlZC5pc05ldyA_IGBDb3VsZG7igJl0IGFkZCDigJwke3RpdGxlLnRyaW0oKX3igJ1gIDogYENvdWxkb",
"uKAmXQgc2F2ZSDigJwke2VkLml0ZW0udGl0bGV94oCdYDsKICAgIGNvbnN0IGVyciA9IGF3YWl0IGNoYW5nZShydW4sIHdoYXQsIHsgcXVpZXQ6IHRydWUgfSk7CiAgICBpZiAoQy5lZGl0ICE9PSBlZCkgcmV0dXJuOyAvLyBjbG9zZWQgbWVhbndoaWxlOyB0aGUgY2hhbmdlIHN0YW5kcwogICAgZWQuc2F2aW5nID0gZmFsc2U7CiAgICBpZiAoIWVycikgewogICAgICBDLmN0eC5kaWFsb2cuY2xvc2UoKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgZWQuc2NvcGUgPSBmYWxzZTsKICAgIGlmIChlcnIuY29kZSA9PT0gJ2NhbGVuZGFyX3Njb3BlJykgZmFpbGVkKGVyciwgd2hhdCk7CiAgICBlZC5lcnJvciA9IGVyci5jb2RlID09PSAnY2hhbmdlZCcgPyAnVGhpcyB3YXMgY2hhbmdlZCBpbiBHb29nbGUgbWVhbndoaWxlLCBzbyBub3RoaW5nIHdhcyBzYXZlZC4gQ2xvc2UgdGhpcyBhbmQgb3BlbiBpdCBhZ2FpbiB0byBzZWUgdGhlIGxhdGVzdC4nCiAgICAgIDogZXJyLmNvZGUgPT09ICdjYWxlbmRhcl9zY29wZScgPyAnQ2hhbmdpbmcgeW91ciBjYWxlbmRhciBuZWVkcyB5b3VyIHBlcm1pc3Npb24gZmlyc3Q6IHNlZSB0aGUgbWVzc2FnZSBhdCB0aGUgYm90dG9tLicKICAgICAgICA6IGAke3doYXR9OiAke2Vyci5tZXNzYWdlfWA7CiAgICBlZC5zeW5jKCk7CiAgfQoKICAvLyDilIDilIAgS2V5cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDil",
"IDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gaGFuZGxlS2V5KGUpIHsKICAgIGlmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuYWx0S2V5IHx8IGUuZGVmYXVsdFByZXZlbnRlZCkgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgdCA9IGUuY29tcG9zZWRQYXRoKClbMF07CiAgICBpZiAodCAmJiAodC5pc0NvbnRlbnRFZGl0YWJsZSB8fCAvXihJTlBVVHxURVhUQVJFQXxTRUxFQ1QpJC8udGVzdCh0LnRhZ05hbWUpKSkgcmV0dXJuIGZhbHNlOwogICAgaWYgKEMuc3RhdHVzID09PSAnc2lnbmluJyB8fCBDLnN0YXR1cyA9PT0gJ21pc21hdGNoJykgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgayA9IGUua2V5LnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBhY3QgPSB7CiAgICAgIHQ6ICgpID0-IGdvKGNhbC5kYXRlS2V5KG5ldyBEYXRlKCkpKSwKICAgICAgajogKCkgPT4gZ28oY2FsLnN0ZXAodmlldygpLCBDLmFuY2hvciwgMSkpLAogICAgICBuOiAoKSA9PiBnbyhjYWwuc3RlcCh2aWV3KCksIEMuYW5jaG9yLCAxKSksCiAgICAgIGs6ICgpID0-IGdvKGNhbC5zdGVwKHZpZXcoKSwgQy5hbmNob3IsIC0xKSksCiAgICAgIHA6ICgpID0-IGdvKGNhbC5zdGVwKHZpZXcoKSwgQy5hbmNob3IsIC0xKSksCiAgICAgIHc6ICgpID0-IHNldFZpZXcoJ3dlZ",
"WsnKSwKICAgICAgbTogKCkgPT4gc2V0VmlldygnbW9udGgnKSwKICAgICAgYTogKCkgPT4gc2V0VmlldygnYWdlbmRhJyksCiAgICB9W2tdOwogICAgaWYgKCFhY3QpIHJldHVybiBmYWxzZTsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGFjdCgpOwogICAgcmV0dXJuIHRydWU7CiAgfQoKICAvLyBFdmVyeSBmZXcgc2Vjb25kcyB3aGlsZSBvcGVuOiB0aGUgbGluZSBmb3Igbm93IG1vdmVzIGRvd24gdGhlIGhvdXJzLAogIC8vIGFuZCBwYXN0IG1pZG5pZ2h0LCB0b2RheSBtb3ZlcyBvbi4KICBmdW5jdGlvbiB0aWNrKCkgewogICAgY29uc3Qgbm93ID0gY2FsLmRhdGVLZXkobmV3IERhdGUoKSk7CiAgICBjb25zdCBsaW5lID0gZWxzLndlZWsgJiYgZWxzLndlZWsucXVlcnlTZWxlY3RvcignLm5vdy1saW5lJyk7CiAgICBpZiAobGluZSkgcGxhY2VOb3cobGluZSwgbWludXRlT2YoRGF0ZS5ub3coKSkpOwogICAgaWYgKG5vdyA9PT0gQy50b2RheSkgcmV0dXJuOwogICAgaWYgKEMuYW5jaG9yID09PSBDLnRvZGF5KSBDLmFuY2hvciA9IG5vdzsKICAgIEMudG9kYXkgPSBub3c7CiAgICBsb2FkKCk7CiAgfQoKICBucy5jYWxlbmRhciA9IHsKICAgIGluaXQsIGVsZW1lbnQsIGxvYWQsIGlzU3RhbGUsIGhhbmRsZUtleSwgdGljaywKICAgIGxvYWRlZEF0OiAoKSA9PiBDLmxvYWRlZEF0LAogICAgaXNMb2FkaW5nOiAoKSA9PiAhIUMubG9hZGluZywKICB9Owp9KSgpOwo\"],[\"src/content/board.js\",\"Ly8g4pSA4p",
"SA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBib2FyZAovLwovLyBBIGZ1bGwtdmlld3BvcnQgb3ZlcmxheSBvdmVyIEdtYWlsLiBDb2x1bW5zIGFyZSBHbWFpbCBsYWJlbHMsIGNhcmRzIGFyZQovLyB0aHJlYWRzLCBhbmQgZXZlcnkgY2hhbmdlIGlzIGEgdGhyZWFkcy5tb2RpZnkgYXBwbGllZCBvcHRpbWlzdGljYWxseToKLy8gdGhlIGNhcmQgbW92ZXMgYXQgb25jZSwgYW5kIG1vdmVzIGJhY2sgd2l0aCBhIHRvYXN0IGlmIEdtYWlsIHJlZnVzZXMuCi8vIERyYWdnaW5nIGlzIHRoZSBxdWljayB3YXkgdG8gbW92ZSB0aGluZ3MsIGJ1dCBldmVyeSBhY3Rpb24gaXMgYWxzbyBvbgovLyB0aGUgY2FyZCdzICLii68iIG1lbnUsIHNvIG5vdGhpbmcgbmVlZHMgYSBtb3VzZS4KLy8KLy8gVGhlIHBob25lIGFwcCAoYWRkb24vYXBwKSBydW5zIHRoaXMgc2FtZSBib2FyZCBhcyB0aGUgYXBwIGl0c2VsZiByYXRoZXIKLy8gdGhhbiBvdmVyIEdtYWlsOiBpdCBzZXRzIG5zLmJvYXJkRnJhbWUgLSB3aGVyZSB0byBkcmF3LCB0aGUgdGFiIHRvIHN0YXJ0Ci8vIG9uLCBhbmQgd2hhdCB0aGUgbm90ZXMgbmVlZC",
"Bmcm9tIGl0IC0gYW5kIHRoZXJlIGlzIHRoZW4gbm90aGluZyB0bwovLyBjbG9zZSwgYW5kIG5vIEdtYWlsIHBhZ2UgYmVoaW5kIHRvIGtlZXAgdGhlIGtleWJvYXJkIG91dCBvZi4KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgY29uc3QgbnMgPSAoZ2xvYmFsVGhpcy5na2IgPSBnbG9iYWxUaGlzLmdrYiB8fCB7fSk7CiAgY29uc3QgeyBoLCBpY29uLCBsb2dvLCBtb3VudFNoYWRvdywgdG9hc3QsIG9wZW5NZW51LCBjbG9zZU1lbnUsIGlzTWVudU9wZW4sIGNoaW1lIH0gPSBucy51aTsKICBjb25zdCB7IHV0aWwsIGxvZ2ljLCBzdG9yZSwgaG9va3MsIGFwaSwgQVBQX05BTUUsIEhPU1RfSURTLCBLRVlTIH0gPSBuczsKCiAgLy8gU3RhdGVzIHdpdGggYSBwYW5lbCBvZiB0aGVpciBvd24sIHNob3duIHdoaWNoZXZlciB0YWIgaXMgb3BlbjogdGhleQogIC8vIGFyZSBhYm91dCB0aGUgYWNjb3VudCwgbm90IGFib3V0IHRoZSBib2FyZCBvciB0aGUgbm90ZXMuCiAgY29uc3QgUEFORUxfU1RBVEVTID0gbmV3IFNldChbJ25vX2FjY291bn",
"QnLCAnbm90X2NvbmZpZ3VyZWQnLCAnYXV0aF9yZXF1aXJlZCcsICdhY2NvdW50X21pc21hdGNoJ10pOwoKICAvLyBPcGVuaW5nIHRoZSBib2FyZCByZS1yZWFkcyBHbWFpbCBpZiB3aGF0IGlzIG9uIHNjcmVlbiBpcyBvbGRlciB0aGFuCiAgLy8gdGhpcy4gU2hvcnQgZW5vdWdoIHRoYXQgYSBsYWJlbCBhZGRlZCBvbiB0aGUgcGhvbmUgc2hvd3MgdXA7IGxvbmcKICAvLyBlbm91Z2ggdGhhdCBmbGlja2luZyB0aGUgYm9hcmQgb3BlbiBhbmQgc2h1dCBjb3N0cyBub3RoaW5nLgogIGNvbnN0IFNUQUxFX01TID0gNjAgKiAxMDAwOwoKICBjb25zdCBEUkFHX1RZUEUgPSAnYXBwbGljYXRpb24veC1na2ItdGhyZWFkJzsKCiAgY29uc3QgVklFV1MgPSBbJ2JvYXJkJywgJ25vdGVzJywgJ2NhbGVuZGFyJ107CgogIC8vIOKUgOKUgCBTdGF0ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgY29uc3QgUyA9IHsKICAgIG1vdW50ZWQ6IGZhbHNlLAogICAgb3BlbjogZmFsc2UsCiAgICB2aWV3OiAnYm9hcmQnLCAgICAvLyBib2FyZCB8IG5vdGVzIHwgY2FsZW5kYXIgLSB0aGUgb3ZlcmxheSdzIHRocmVlIHRhYnMKICAgIHZpZXdMb2FkZWQ6IGZhbHNlLA",
"ogICAgYWNjb3VudDogJycsCiAgICBjb2x1bW5zOiBbXSwKICAgIGxpc3RzOiB7fSwgICAgICAgIC8vIGNvbHVtbiBpZCDihpIgdGhyZWFkIGlkcywgaW4gZGlzcGxheSBvcmRlcgogICAgdHJ1bmNhdGVkOiB7fSwgICAgLy8gY29sdW1uIGlkIOKGkiB0cnVlIHdoZW4gR21haWwgaGFkIG1vcmUgdGhhbiAxMDAKICAgIGxvYWRlZEF0OiAwLAogICAgbG9hZGluZzogbnVsbCwgICAgLy8gcHJvbWlzZSBvZiB0aGUgcmVmcmVzaCBpbiBwcm9ncmVzcwogICAgc3RhdHVzOiAnaWRsZScsICAgLy8gaWRsZSB8IGxvYWRpbmcgfCByZWFkeSB8IGVycm9yIHwgbm9fYWNjb3VudCB8IG5vdF9jb25maWd1cmVkIHwgYXV0aF9yZXF1aXJlZCB8IGFjY291bnRfbWlzbWF0Y2gKICAgIHN0YXR1c01lc3NhZ2U6ICcnLAogICAgc2VhcmNoOiBudWxsLCAgICAgLy8geyBjb2xJZCwgcXVlcnksIGlkcywgbG9hZGluZywgZXJyb3IsIHNlcSB9CiAgICBkcmF3ZXI6IG51bGwsICAgICAvLyB7IGRyYWZ0LCBlcnJvciwgc2F2aW5nIH0KICAgIGVkaXRzOiBuZXcgTWFwKCksIC8vIHRocmVhZCBpZCDihpIgeyB0aXRsZT8sIG5vdGU_LCBjb2xvdXI_IH0gKHNlZSBsb2dpYy5ub3JtYWxpc2VDYXJkRWRpdCkKICAgIGVkaXRvcjogbnVsbCwgICAgIC8vIHsgaWQsIHN1YmplY3QsIGRyYWZ0LCBlcnJvciwgc2F2aW5nIH0KICAgIGRyYWc6IG51bGwsICAgICAgIC8vIHsgaWQsIGZyb21Db2wsIGNhcmQsIHBsYWNlaG9sZGVyIH0KICAgIG11dGF0aW9uczogMC",
"wgICAgIC8vIGxvY2FsIG1vdmVzIG1hZGU7IGEgcmVmcmVzaCB0aGF0IHNwYW5zIG9uZSBpcyBzdGFsZQogICAgcmVuZGVyRGVmZXJyZWQ6IGZhbHNlLAogICAgcmV0dXJuRm9jdXM6IG51bGwsCiAgICB0aWNrZXI6IDAsCiAgICBsaWNlbmNlOiBudWxsLCAgICAvLyB0aGUgbGljZW5jZSwgYXMgbGljZW5jZUxvZ2ljLnZpZXcgdGVsbHMgaXQ7IG51bGwgdW50aWwgYXNrZWQKICB9OwoKICBsZXQgcm9vdCA9IG51bGw7CiAgbGV0IGZyYW1lID0gbnVsbDsgLy8gbnMuYm9hcmRGcmFtZSwgaW4gdGhlIHBob25lIGFwcAogIGNvbnN0IGVscyA9IHt9OwoKICAvLyDilIDilIAgTW91bnRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGZ1bmN0aW9uIG1vdW50KCkgewogICAgaWYgKFMubW91bnRlZCkgcmV0dXJuOwogICAgZnJhbWUgPSBucy5ib2FyZEZyYW1lIHx8IG51bGw7CiAgICAoeyByb290IH0gPSBmcmFtZSA_IHsgcm9vdDogZnJhbWUucm9vdCB9IDogbW91bnRTaGFkb3coSE9TVF9JRFMuYm9hcmQsIG5zLnN0eWxlcy5ib2FyZCkpOwoKICAgIGVscy5hY2NvdW50ID0gaCgnc3BhbicsIHsgY2xhc3M6ICdhY2NvdW50JyB9KTsKICAgIC8vIEluIHRoZSB0cm",
"lhbCwgaG93IGxvbmcgaXMgbGVmdDsgYSBjbGljayBmb3IgdGhlIGxpY2VuY2UuCiAgICBlbHMubGljZW5jZSA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdsaWNlbmNlLWNoaXAnLCB0eXBlOiAnYnV0dG9uJywgaGlkZGVuOiB0cnVlLCBkYXRhc2V0OiB7IGtleTogJ2xpY2VuY2UtY2hpcCcgfSwgb25jbGljazogKCkgPT4gb3BlbkxpY2VuY2UoKSwKICAgIH0pOwogICAgZWxzLnVwZGF0ZWQgPSBoKCdzcGFuJywgeyBjbGFzczogJ3VwZGF0ZWQnIH0pOwogICAgZWxzLnJlZnJlc2ggPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnUmVmcmVzaCcsIHRpdGxlOiAnUmVmcmVzaCcsCiAgICAgIG9uY2xpY2s6ICgpID0-IChTLnZpZXcgPT09ICdub3RlcycgPyBucy5ub3Rlcy5sb2FkKHsgZm9yY2U6IHRydWUgfSkKICAgICAgICA6IFMudmlldyA9PT0gJ2NhbGVuZGFyJyA_IG5zLmNhbGVuZGFyLmxvYWQoeyBmb3JjZTogdHJ1ZSB9KSA6IHJlZnJlc2goKSksCiAgICB9LCBpY29uKCdyZWZyZXNoJykpOwogICAgZWxzLnNldHRpbmdzID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogJ0NvbHVtbiBzZXR0aW5ncycsIHRpdGxlOiAnQ29sdW1uIHNldHRpbmdzJywKICAgICAgZGF0YXNldDogeyBrZXk6ICdzZXR0aW5ncycgfSwgb25jbGljazogb3BlbkRyYXdlciwKIC",
"AgIH0sIGljb24oJ3R1bmUnKSk7CiAgICBlbHMuY2xvc2UgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQ2xvc2UgYm9hcmQnLCB0aXRsZTogJ0Nsb3NlIChFc2MpJywKICAgICAgaGlkZGVuOiAhIWZyYW1lLCBvbmNsaWNrOiBjbG9zZSwKICAgIH0sIGljb24oJ2Nsb3NlJykpOwoKICAgIGNvbnN0IHRhYiA9ICh2aWV3LCBsYWJlbCwgaWNvbk5hbWUpID0-IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICd0YWInLCB0eXBlOiAnYnV0dG9uJywgcm9sZTogJ3RhYicsICdhcmlhLXNlbGVjdGVkJzogU3RyaW5nKFMudmlldyA9PT0gdmlldyksCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgdmlldzoke3ZpZXd9YCwgdmlldyB9LCBvbmNsaWNrOiAoKSA9PiBzd2l0Y2hWaWV3KHZpZXcpLAogICAgfSwgaWNvbihpY29uTmFtZSwgMTgpLCBsYWJlbCk7CiAgICBlbHMudGFicyA9IGgoJ2RpdicsIHsgY2xhc3M6ICd0YWJzJywgcm9sZTogJ3RhYmxpc3QnLCAnYXJpYS1sYWJlbCc6ICdWaWV3JyB9LAogICAgICB0YWIoJ2JvYXJkJywgJ0JvYXJkJywgJ2JvYXJkJyksIHRhYignbm90ZXMnLCAnTm90ZXMnLCAnbm90ZScpLCB0YWIoJ2NhbGVuZGFyJywgJ0NhbGVuZGFyJywgJ2NhbGVuZGFyJykpOwoKICAgIC8vIFRoZSBsb2dvIGFuZCBuYW1lIG9wZW4gYSBzbWFsbCBtZW51OiB0aGUgdmVyc2lvbiwgdGhlIHdlYnNpdGUgYW5kCiAgICAvLyB0aGUgcHJpdm",
"FjeSBwYWdlLCBhbmQgLSBpbiB0aGUgcGhvbmUgYXBwIC0gaG93IGxvbmcgaXQgdG9vayB0byBvcGVuLgogICAgY29uc3QgYnJhbmQgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnYnJhbmQtYnRuJywgdHlwZTogJ2J1dHRvbicsIHRpdGxlOiBgQWJvdXQgJHtBUFBfTkFNRX1gLCAnYXJpYS1oYXNwb3B1cCc6ICdtZW51JywgJ2FyaWEtZXhwYW5kZWQnOiAnZmFsc2UnLAogICAgICBkYXRhc2V0OiB7IGtleTogJ2Fib3V0JyB9LCBvbmNsaWNrOiBlID0-IG9wZW5BYm91dChlLmN1cnJlbnRUYXJnZXQpLAogICAgfSwgaCgnc3BhbicsIHsgY2xhc3M6ICdsb2dvJyB9LCBsb2dvKDI2KSksIGgoJ3NwYW4nLCB7IHRleHQ6IEFQUF9OQU1FIH0pKTsKICAgIGNvbnN0IGJhciA9IGgoJ2hlYWRlcicsIHsgY2xhc3M6ICdiYXInIH0sCiAgICAgIGgoJ2gxJywgeyBjbGFzczogJ2JyYW5kJyB9LCBicmFuZCksCiAgICAgIGVscy50YWJzLAogICAgICBlbHMuYWNjb3VudCwKICAgICAgZWxzLmxpY2VuY2UsCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICBlbHMudXBkYXRlZCwgZWxzLnJlZnJlc2gsIGVscy5zZXR0aW5ncywgZWxzLmNsb3NlKTsKCiAgICBlbHMuYm9keSA9IGgoJ21haW4nLCB7IGNsYXNzOiAnYm9keScgfSk7CiAgICBlbHMubGl2ZSA9IGgoJ2RpdicsIHsgY2xhc3M6ICdzci1vbmx5JywgJ2FyaWEtbGl2ZSc6ICdwb2xpdGUnIH0pOwogICAgZWxzLmRyYXdlckxheWVyID0gaCgnZGl2Jy",
"wgeyBjbGFzczogJ2RyYXdlci1sYXllcicgfSk7CiAgICBlbHMuZWRpdG9yTGF5ZXIgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZWRpdG9yLWxheWVyJyB9KTsKCiAgICBlbHMub3ZlcmxheSA9IGgoJ2RpdicsIHsKICAgICAgY2xhc3M6ICdvdmVybGF5Jywgcm9sZTogZnJhbWUgPyBudWxsIDogJ2RpYWxvZycsICdhcmlhLW1vZGFsJzogZnJhbWUgPyBudWxsIDogJ3RydWUnLCAnYXJpYS1sYWJlbCc6IGAke0FQUF9OQU1FfSBib2FyZGAsCiAgICAgIHRhYmluZGV4OiAnLTEnLCBoaWRkZW46IHRydWUsIG9ua2V5ZG93bjogb25PdmVybGF5S2V5LAogICAgfSwgYmFyLCBlbHMuYm9keSwgZWxzLmxpdmUsIGVscy5kcmF3ZXJMYXllciwgZWxzLmVkaXRvckxheWVyKTsKCiAgICByb290LmFwcGVuZENoaWxkKGVscy5vdmVybGF5KTsKICAgIFMubW91bnRlZCA9IHRydWU7CgogICAgLy8gU21hbGwgcGVyLWFjY291bnQgcHJlZmVyZW5jZXMgKGZvbGRlZCBmb2xkZXJzLCB0aGUgY2FsZW5kYXIncyB2aWV3KSwKICAgIC8vIG9uIHRoaXMgY29tcHV0ZXIuCiAgICBjb25zdCBwcmVmcyA9IHsKICAgICAgYXN5bmMgZ2V0KG5hbWUpIHsKICAgICAgICBjb25zdCBrZXkgPSBLRVlTLnByZWYoaG9va3MuZ2V0QWNjb3VudCgpLCBuYW1lKTsKICAgICAgICByZXR1cm4gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpKVtrZXldOwogICAgICB9LAogICAgICBzZXQ6IChuYW1lLCB2YWx1ZSkgPT4gY2hyb21lLnN0b3JhZ2UubG9jYW",
"wuc2V0KHsgW0tFWVMucHJlZihob29rcy5nZXRBY2NvdW50KCksIG5hbWUpXTogdmFsdWUgfSksCiAgICB9OwoKICAgIG5zLm5vdGVzLmluaXQoT2JqZWN0LmFzc2lnbih7CiAgICAgIHJvb3QsCiAgICAgIC8vIEFjY291bnQgdHJvdWJsZSBmb3VuZCBieSB0aGUgbm90ZXMgZ2V0cyB0aGUgc2FtZSBwYW5lbCBhcyB0aGUgYm9hcmQncy4KICAgICAgb25TdGF0ZUVycm9yOiBlcnIgPT4gewogICAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0sCiAgICAgIG9uTG9hZGVkOiAoKSA9PiB7CiAgICAgICAgaWYgKCFQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSkgcmV0dXJuOwogICAgICAgIFMuc3RhdHVzID0gJ2lkbGUnOwogICAgICAgIHJlbmRlcigpOwogICAgICB9LAogICAgICBjbG9zZUJvYXJkOiBjbG9zZSwKICAgICAgYmFyQ2hhbmdlZDogdXBkYXRlQmFyLAogICAgICAvLyBXaGljaCBmb2xkZXJzIGFyZSBmb2xkZWQsIG9uIHRoaXMgY29tcHV0ZXIsIGZvciB0aGlzIGFjY291bnQuCiAgICAgIHByZWZzLAogICAgfSwgZnJhbWUgJiYgZnJhbWUubm90ZXMpKTsKCiAgICBucy5jYWxlbmRhci5pbml0KE9iamVjdC5hc3NpZ24oewogICAgICByb290LAogICAgICAvLyBObyBjbGllbnQgSUQgeWV0OiB0aGUgYm9hcmQncyBvd24gc2V0dXAgcGFuZWwuIFRoZSBjYWxlbmRhcidzCiAgICAgIC8vIG93biBzaWduLW",
"luIGhhcyBhIHBhbmVsIG9mIGl0cyBvd24sIGluc2lkZSB0aGUgY2FsZW5kYXIuCiAgICAgIG9uU3RhdGVFcnJvcjogZXJyID0-IHsKICAgICAgICBTLnN0YXR1cyA9IGVyci5jb2RlOwogICAgICAgIFMuc3RhdHVzTWVzc2FnZSA9IGVyci5tZXNzYWdlOwogICAgICAgIHJlbmRlcigpOwogICAgICB9LAogICAgICBvbkxvYWRlZDogKCkgPT4gewogICAgICAgIGlmICghUEFORUxfU1RBVEVTLmhhcyhTLnN0YXR1cykpIHJldHVybjsKICAgICAgICBTLnN0YXR1cyA9ICdpZGxlJzsKICAgICAgICByZW5kZXIoKTsKICAgICAgfSwKICAgICAgYmFyQ2hhbmdlZDogdXBkYXRlQmFyLAogICAgICBwcmVmcywKICAgICAgY29ubmVjdDogKCkgPT4gYXBpLmNvbm5lY3RDYWxlbmRhcigpLAogICAgICBkaWFsb2c6IHsgc2hvdzogc2hvd0RpYWxvZywgY2xvc2U6IGNsb3NlRWRpdG9yIH0sCiAgICB9LCBmcmFtZSAmJiBmcmFtZS5jYWxlbmRhcikpOwoKICAgIC8vIEEgbW92ZSBtYWRlIGZyb20gdGhlIGRvY2sgKG9yIGFub3RoZXIgdGFiKSBtYWtlcyB3aGF0IHRoZSBib2FyZCBsYXN0CiAgICAvLyBsb2FkZWQgd3Jvbmc7IHRoZSBib2FyZCdzIG93biBtb3ZlcyBhcmUgYWxyZWFkeSByZWZsZWN0ZWQgb24gc2NyZWVuLgogICAgc3RvcmUuYnVzLmFkZEV2ZW50TGlzdGVuZXIoJ3RocmVhZC1jaGFuZ2VkJywgZSA9PiB7CiAgICAgIGlmIChlLmRldGFpbCAmJiBlLmRldGFpbC5zb3VyY2UgPT09ICdib2FyZCcpIHJldHVybjsKICAgICAgUy",
"5sb2FkZWRBdCA9IDA7CiAgICAgIGlmIChTLm9wZW4gJiYgUy52aWV3ID09PSAnYm9hcmQnKSByZWZyZXNoKCk7CiAgICB9KTsKICB9CgogIC8vIOKUgOKUgCBPcGVuIC8gY2xvc2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGFzeW5jIGZ1bmN0aW9uIG9wZW4oeyB2aWV3IH0gPSB7fSkgewogICAgbW91bnQoKTsKICAgIGlmIChTLm9wZW4pIHsKICAgICAgaWYgKHZpZXcpIHN3aXRjaFZpZXcodmlldyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIFMub3BlbiA9IHRydWU7CiAgICBTLnJldHVybkZvY3VzID0gZnJhbWUgPyBudWxsIDogZGVlcEFjdGl2ZUVsZW1lbnQoKTsKICAgIGVscy5vdmVybGF5LmhpZGRlbiA9IGZhbHNlOwogICAgaWYgKCFmcmFtZSkgZWxzLmNsb3NlLmZvY3VzKCk7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgb25Eb2N1bWVudEtleSwgdHJ1ZSk7CiAgICBTLnRpY2tlciA9IHNldEludGVydmFsKHVwZGF0ZUJhciwgNTAwMCk7CgogICAgLy8gVGhlIHRhYiBsYXN0IHVzZWQsIHVubGVzcyB0aGUgY2FsbGVyIGFza2VkIGZvciBvbmUuCiAgICBpZiAoIVMudmlld0xvYWRlZCkgewogICAgICBTLnZpZXdMb2FkZWQgPSB0cnVlOw",
"ogICAgICB0cnkgewogICAgICAgIGNvbnN0IGdvdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChLRVlTLnZpZXcpOwogICAgICAgIGlmIChWSUVXUy5pbmNsdWRlcyhnb3RbS0VZUy52aWV3XSkpIFMudmlldyA9IGdvdFtLRVlTLnZpZXddOwogICAgICAgIGVsc2UgaWYgKGZyYW1lICYmIGZyYW1lLnZpZXcpIFMudmlldyA9IGZyYW1lLnZpZXc7CiAgICAgIH0gY2F0Y2ggeyAvKiBleHRlbnNpb24gcmVsb2FkZWQ7IGhhbmRsZWQganVzdCBiZWxvdyAqLyB9CiAgICB9CiAgICBpZiAodmlldykgUy52aWV3ID0gdmlldzsKCiAgICBTLmFjY291bnQgPSBob29rcy5nZXRBY2NvdW50KCk7CiAgICBpZiAoIVMuYWNjb3VudCkgewogICAgICBTLnN0YXR1cyA9ICdub19hY2NvdW50JzsKICAgICAgcmVuZGVyKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRyeSB7CiAgICAgIGlmICghUy5jb2x1bW5zLmxlbmd0aCkgUy5jb2x1bW5zID0gYXdhaXQgc3RvcmUubG9hZENvbHVtbnMoUy5hY2NvdW50KTsKICAgIH0gY2F0Y2ggewogICAgICAvLyBjaHJvbWUuc3RvcmFnZSB0aHJvd3Mgb25jZSB0aGUgZXh0ZW5zaW9uIGhhcyBiZWVuIHJlbG9hZGVkIHVuZGVyCiAgICAgIC8vIHRoaXMgdGFiOyBub3RoaW5nIGVsc2Ugd2lsbCB3b3JrIHVudGlsIEdtYWlsIGlzIHJlbG9hZGVkIGVpdGhlci4KICAgICAgUy5zdGF0dXMgPSAnZXJyb3InOwogICAgICBTLnN0YXR1c01lc3NhZ2UgPSAnVGhlIGV4dGVuc2lvbiB3YXMgdXBkYX",
"RlZC4gUmVsb2FkIHRoaXMgR21haWwgdGFiLic7CiAgICAgIHJlbmRlcigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjaGVja0xpY2VuY2UoKTsKICAgIHNob3dWaWV3KCk7CiAgfQoKICBmdW5jdGlvbiBzaG93VmlldygpIHsKICAgIGlmIChTLnZpZXcgPT09ICdub3RlcycpIHNob3dOb3RlcygpOwogICAgZWxzZSBpZiAoUy52aWV3ID09PSAnY2FsZW5kYXInKSBzaG93Q2FsZW5kYXIoKTsKICAgIGVsc2Ugc2hvd0JvYXJkKCk7CiAgfQoKICBmdW5jdGlvbiBzaG93Qm9hcmQoKSB7CiAgICBpZiAoYmxvY2tlZCgpKSB7IHJlbmRlcigpOyByZXR1cm47IH0KICAgIGNvbnN0IHN0YWxlID0gUy5zdGF0dXMgIT09ICdyZWFkeScgfHwgRGF0ZS5ub3coKSAtIFMubG9hZGVkQXQgPiBTVEFMRV9NUzsKICAgIC8vIFNrZWxldG9uIGNvbHVtbnMgd2hpbGUgYSBmaXJzdCAob3IgcmV0cmllZCkgbG9hZCBydW5zLCByYXRoZXIgdGhhbgogICAgLy8gbGVhdmluZyBhbiBvbGQgIkNvbm5lY3QgR21haWwiIHBhbmVsIHVwIGFmdGVyIHRoZSB1c2VyIGhhcyBjb25uZWN0ZWQuCiAgICBpZiAoUy5zdGF0dXMgIT09ICdyZWFkeScpIFMuc3RhdHVzID0gJ2xvYWRpbmcnOwogICAgcmVuZGVyKCk7CiAgICBpZiAoc3RhbGUpIHJlZnJlc2goKTsKICB9CgogIC8vIEFuIGFjY291bnQgcGFuZWwgbGVmdCBvdmVyIGZyb20gZWFybGllciBpcyByZXRyaWVkIHJhdGhlciB0aGFuIHNob3duCiAgLy8gYWdhaW47IGlmIHRoZSB0cm91YmxlIGlzIHN0aW",
"xsIHRoZXJlLCB0aGUgbm90ZXMnIG93biBsb2FkIHNheXMgc28uCiAgZnVuY3Rpb24gc2hvd05vdGVzKCkgewogICAgaWYgKGJsb2NrZWQoKSkgeyByZW5kZXIoKTsgcmV0dXJuOyB9CiAgICBpZiAoUEFORUxfU1RBVEVTLmhhcyhTLnN0YXR1cykpIFMuc3RhdHVzID0gJ2lkbGUnOwogICAgcmVuZGVyKCk7CiAgICBucy5ub3Rlcy5sb2FkKCk7CiAgICBpZiAoIWZyYW1lIHx8IGZyYW1lLmZvY3VzICE9PSBmYWxzZSkgbnMubm90ZXMuZm9jdXNEZWZhdWx0KCk7CiAgfQoKICAvLyBUaGUgY2FsZW5kYXIgbmVlZHMgbm90aGluZyBvZiBHbWFpbCdzLCBzbyBhIEdtYWlsIHBhbmVsIGlzIG5vIHJlYXNvbgogIC8vIHRvIGtlZXAgaXQgaGlkZGVuOyBvbmx5IGEgbWlzc2luZyBjbGllbnQgSUQgb3IgYWNjb3VudCBzdGFuZHMgaW4gaXRzIHdheS4KICBmdW5jdGlvbiBzaG93Q2FsZW5kYXIoKSB7CiAgICBpZiAoYmxvY2tlZCgpKSB7IHJlbmRlcigpOyByZXR1cm47IH0KICAgIGlmIChQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSAmJiBTLnN0YXR1cyAhPT0gJ25vdF9jb25maWd1cmVkJyAmJiBTLnN0YXR1cyAhPT0gJ25vX2FjY291bnQnKSBTLnN0YXR1cyA9ICdpZGxlJzsKICAgIHJlbmRlcigpOwogICAgbnMuY2FsZW5kYXIubG9hZCgpOwogIH0KCiAgY29uc3QgU0lURSA9ICdodHRwczovL21lbWRlc2suYXBwLyc7CgogIGZ1bmN0aW9uIG9wZW5BYm91dChhbmNob3IpIHsKICAgIGNvbnN0IGxpbmsgPSAobGFiZWwsIHVybCkgPT",
"4gKHsgbGFiZWwsIGljb246ICdvcGVuJywga2V5OiBgYWJvdXQ6JHtsYWJlbH1gLCBvblNlbGVjdDogKCkgPT4gd2luZG93Lm9wZW4odXJsLCAnX2JsYW5rJywgJ25vb3BlbmVyJykgfSk7CiAgICBjb25zdCBpdGVtcyA9IFsKICAgICAgeyBoZWFkaW5nOiBgJHtBUFBfTkFNRX0gJHtucy5BUFBfVkVSU0lPTn1gIH0sCiAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgIGxpbmsoJ21lbWRlc2suYXBwJywgU0lURSksCiAgICAgIGxpbmsoJ1ByaXZhY3knLCBgJHtTSVRFfXByaXZhY3kvYCksCiAgICAgIHsgc2VwYXJhdG9yOiB0cnVlIH0sCiAgICAgIHsgbGFiZWw6IGxpY2VuY2VNZW51TGFiZWwoKSwgaWNvbjogJ2tleScsIGtleTogJ2Fib3V0OmxpY2VuY2UnLCBvblNlbGVjdDogKCkgPT4gb3BlbkxpY2VuY2UoKSB9LAogICAgXTsKICAgIC8vIEZvciBmaW5kaW5nIG91dCB3aGF0IGlzIHNsb3csIG5vdCBmb3IgZXZlcnkgZGF5OiBvdXQgb2YgdGhlIHdheS4KICAgIGlmIChmcmFtZSAmJiBmcmFtZS50aW1pbmdzKSB7CiAgICAgIGl0ZW1zLnB1c2goeyBzZXBhcmF0b3I6IHRydWUgfSwgewogICAgICAgIGxhYmVsOiAnQWR2YW5jZWQ6IHN0YXJ0dXAgdGltaW5ncycsIGljb246ICd0dW5lJywga2V5OiAnYWJvdXQ6dGltaW5ncycsCiAgICAgICAgb25TZWxlY3Q6ICgpID0-IHRvYXN0KHJvb3QsIGZyYW1lLnRpbWluZ3MoKSwgeyB0aW1lb3V0OiA4MDAwIH0pLAogICAgICB9KTsKICAgIH0KICAgIG9wZW5NZW51KHJvb3",
"QsIGFuY2hvciwgaXRlbXMsIHsgbGFiZWw6IGBBYm91dCAke0FQUF9OQU1FfWAgfSk7CiAgfQoKICBmdW5jdGlvbiBzd2l0Y2hWaWV3KHZpZXcpIHsKICAgIGlmICh2aWV3ID09PSBTLnZpZXcgfHwgIVMub3BlbikgcmV0dXJuOwogICAgLy8gVGhlIG5vdGVzLCBvciB0aGUgY2FsZW5kYXIncyBzY3JhdGNocGFkIHRpbGUuCiAgICBucy5ub3Rlcy5mbHVzaCgpOwogICAgY2xvc2VNZW51KHJvb3QpOwogICAgUy5zZWFyY2ggPSBudWxsOwogICAgUy52aWV3ID0gdmlldzsKICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtLRVlTLnZpZXddOiB2aWV3IH0pLmNhdGNoKCgpID0-IHt9KTsKICAgIHNob3dWaWV3KCk7CiAgfQoKICAvLyBUaGUgZG9jaydzIGJ1dHRvbnM6IG9wZW4gb24gdGhhdCB0YWIsIHN3aXRjaCB0byBpdCwgb3IgLSB3aGVuIGl0CiAgLy8gaXMgYWxyZWFkeSBzaG93aW5nIC0gY2xvc2UuCiAgZnVuY3Rpb24gdG9nZ2xlVmlldyh2aWV3KSB7CiAgICBpZiAoUy5vcGVuICYmIFMudmlldyA9PT0gdmlldykgY2xvc2UoKTsKICAgIGVsc2UgaWYgKFMub3Blbikgc3dpdGNoVmlldyh2aWV3KTsKICAgIGVsc2Ugb3Blbih7IHZpZXcgfSk7CiAgfQoKICBmdW5jdGlvbiBjbG9zZSgpIHsKICAgIC8vIEluIHRoZSBwaG9uZSBhcHAgdGhlIGJvYXJkIGlzIHRoZSBhcHA6IHRoZXJlIGlzIG5vdGhpbmcgdG8gY2xvc2UgdG8uCiAgICBpZiAoIVMub3BlbiB8fCBmcmFtZSkgcmV0dXJuOwogICAgLy8gV2hhdGV2ZXIgd2",
"FzIHR5cGVkIGluIHRoZSBsYXN0IHNlY29uZCBvciB0d28gaXMgc2F2ZWQgb24gdGhlIHdheSBvdXQuCiAgICBucy5ub3Rlcy5mbHVzaCgpOwogICAgY2xvc2VNZW51KHJvb3QpOwogICAgUy5vcGVuID0gZmFsc2U7CiAgICBTLnNlYXJjaCA9IG51bGw7CiAgICBTLmRyYXdlciA9IG51bGw7CiAgICAvLyBUaGUgY2FsZW5kYXIncyBkaWFsb2cgaXMgdG9sZCBpdCBjbG9zZWQ7IHRoZSBjYXJkIGVkaXRvciBqdXN0IGdvZXMuCiAgICBpZiAoUy5lZGl0b3IgJiYgUy5lZGl0b3IuZXh0ZXJuYWwpIGNsb3NlRWRpdG9yKCk7CiAgICBTLmVkaXRvciA9IG51bGw7CiAgICByZW5kZXJEcmF3ZXIoKTsKICAgIHJlbmRlckVkaXRvcigpOwogICAgZWxzLm92ZXJsYXkuaGlkZGVuID0gdHJ1ZTsKICAgIC8vICJDb2x1bW5zIHNhdmVkIiBtZWFucyBub3RoaW5nIG9uY2UgdGhlIGJvYXJkIGlzIGdvbmU7IGVycm9ycyBzdGF5CiAgICAvLyB1bnRpbCByZWFkIG9yIHRpbWVkIG91dCwgc2luY2UgdGhleSBtYXkgZXhwbGFpbiBhIGNhcmQgdGhhdCBtb3ZlZCBiYWNrLgogICAgZm9yIChjb25zdCB0IG9mIHJvb3QucXVlcnlTZWxlY3RvckFsbCgnLnRvYXN0Om5vdCgudG9hc3QtZXJyb3IpJykpIHQucmVtb3ZlKCk7CiAgICBjbGVhckludGVydmFsKFMudGlja2VyKTsKICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBvbkRvY3VtZW50S2V5LCB0cnVlKTsKICAgIGNvbnN0IGJhY2sgPSBTLnJldHVybkZvY3VzOwogIC",
"AgUy5yZXR1cm5Gb2N1cyA9IG51bGw7CiAgICBpZiAoYmFjayAmJiBiYWNrLmlzQ29ubmVjdGVkICYmIHR5cGVvZiBiYWNrLmZvY3VzID09PSAnZnVuY3Rpb24nKSBiYWNrLmZvY3VzKCk7CiAgfQoKICBmdW5jdGlvbiB0b2dnbGUoKSB7CiAgICBpZiAoUy5vcGVuKSBjbG9zZSgpOwogICAgZWxzZSBvcGVuKCk7CiAgfQoKICAvLyBkb2N1bWVudC5hY3RpdmVFbGVtZW50IHN0b3BzIGF0IGEgc2hhZG93IGhvc3QgLSB0aGUgZG9jaydzLCB3aGVuIHRoZQogIC8vIGJvYXJkIHdhcyBvcGVuZWQgZnJvbSBpdHMgYnV0dG9uIC0gYW5kIGEgaG9zdCBjYW5ub3QgdGFrZSBmb2N1cyBiYWNrLgogIGZ1bmN0aW9uIGRlZXBBY3RpdmVFbGVtZW50KCkgewogICAgbGV0IGEgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50OwogICAgd2hpbGUgKGEgJiYgYS5zaGFkb3dSb290ICYmIGEuc2hhZG93Um9vdC5hY3RpdmVFbGVtZW50KSBhID0gYS5zaGFkb3dSb290LmFjdGl2ZUVsZW1lbnQ7CiAgICByZXR1cm4gYTsKICB9CgogIC8vIOKUgOKUgCBLZXlib2FyZCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gRXNjIHBlZWxzIGJhY2sgb25lIGxheWVyIGF0IGEgdGltZTogY2FyZC",
"BlZGl0b3Igb3IgZHJhd2VyLCB0aGVuCiAgLy8gc2VhcmNoLCB0aGVuIGJvYXJkLiBPcGVuIG1lbnVzIGhhbmRsZSB0aGVpciBvd24gRXNjIGJlZm9yZSBpdCBnZXRzIGhlcmUuCiAgZnVuY3Rpb24gb25PdmVybGF5S2V5KGUpIHsKICAgIGlmIChTLnZpZXcgPT09ICdub3RlcycgJiYgIVMuZWRpdG9yICYmIG5zLm5vdGVzLmhhbmRsZUtleShlKSkgcmV0dXJuOwogICAgaWYgKFMudmlldyA9PT0gJ2NhbGVuZGFyJyAmJiAhUy5lZGl0b3IgJiYgIVMuZHJhd2VyICYmICFpc01lbnVPcGVuKHJvb3QpICYmIG5zLmNhbGVuZGFyLmhhbmRsZUtleShlKSkgcmV0dXJuOwogICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykgewogICAgICBpZiAoaXNNZW51T3Blbihyb290KSkgcmV0dXJuOwogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGlmIChTLmVkaXRvcikgY2xvc2VFZGl0b3IoKTsKICAgICAgZWxzZSBpZiAoUy5kcmF3ZXIpIGNsb3NlRHJhd2VyKCk7CiAgICAgIGVsc2UgaWYgKFMuc2VhcmNoKSBjbG9zZVNlYXJjaCgpOwogICAgICBlbHNlIGNsb3NlKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChlLmtleSA9PT0gJ1RhYicgJiYgIWZyYW1lKSB0cmFwRm9jdXMoZSk7CiAgfQoKICAvLyBJZiBmb2N1cyBoYXMgZXNjYXBlZCB0byBHbWFpbCdzIHBhZ2UgKGEgY2xpY2sgb24gaXRzIGVkZ2UsIHNheSksIEVzYwogIC8vIHNob3VsZCBzdGlsbCBjbG9zZSB0aGUgYm9hcmQgcmF0aGVyIHRoYW4gcmVhY2ggR21haW",
"wuCiAgZnVuY3Rpb24gb25Eb2N1bWVudEtleShlKSB7CiAgICAvLyBGMyBzdGVwcyB0aHJvdWdoIHNlYXJjaCBtYXRjaGVzIHdoZXJldmVyIHRoZSBmb2N1cyBoYXMgd2FuZGVyZWQuCiAgICBpZiAoZS5rZXkgPT09ICdGMycgJiYgUy5vcGVuICYmIFMudmlldyA9PT0gJ25vdGVzJyAmJiAhZS5jb21wb3NlZFBhdGgoKS5pbmNsdWRlcyhlbHMub3ZlcmxheSkpIHsKICAgICAgbnMubm90ZXMuaGFuZGxlS2V5KGUpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoZS5rZXkgIT09ICdFc2NhcGUnIHx8ICFTLm9wZW4gfHwgZnJhbWUpIHJldHVybjsKICAgIGlmIChlLmNvbXBvc2VkUGF0aCgpLmluY2x1ZGVzKGVscy5vdmVybGF5KSkgcmV0dXJuOwogICAgaWYgKGlzTWVudU9wZW4ocm9vdCkpIHJldHVybjsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICBjbG9zZSgpOwogIH0KCiAgLy8gQSBtb2RhbCB0aGF0IGxldHMgVGFiIHdhbmRlciBpbnRvIHRoZSBwYWdlIGJlaGluZCBpdCBpcyBub3QgbW9kYWwuCiAgZnVuY3Rpb24gdHJhcEZvY3VzKGUpIHsKICAgIGNvbnN0IHNjb3BlID0gUy5lZGl0b3IgPyBlbHMuZWRpdG9yTGF5ZXIgOiBTLmRyYXdlciA_IGVscy5kcmF3ZXJMYXllciA6IGVscy5vdmVybGF5OwogICAgY29uc3QgZm9jdXNhYmxlID0gWy4uLnNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbjpub3QoW2Rpc2FibGVkXSksIGlucHV0Om5vdChbZGlzYWJsZWRdKS",
"wgdGV4dGFyZWE6bm90KFtkaXNhYmxlZF0pLCBzZWxlY3Q6bm90KFtkaXNhYmxlZF0pLCBhW2hyZWZdJyldCiAgICAgIC5maWx0ZXIoZWwgPT4gZWwuZ2V0Q2xpZW50UmVjdHMoKS5sZW5ndGgpOwogICAgaWYgKCFmb2N1c2FibGUubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBmaXJzdCA9IGZvY3VzYWJsZVswXTsKICAgIGNvbnN0IGxhc3QgPSBmb2N1c2FibGVbZm9jdXNhYmxlLmxlbmd0aCAtIDFdOwogICAgY29uc3QgYWN0aXZlID0gcm9vdC5hY3RpdmVFbGVtZW50OwogICAgaWYgKGUuc2hpZnRLZXkgJiYgKGFjdGl2ZSA9PT0gZmlyc3QgfHwgIXNjb3BlLmNvbnRhaW5zKGFjdGl2ZSkpKSB7IGUucHJldmVudERlZmF1bHQoKTsgbGFzdC5mb2N1cygpOyB9CiAgICBlbHNlIGlmICghZS5zaGlmdEtleSAmJiAoYWN0aXZlID09PSBsYXN0IHx8ICFzY29wZS5jb250YWlucyhhY3RpdmUpKSkgeyBlLnByZXZlbnREZWZhdWx0KCk7IGZpcnN0LmZvY3VzKCk7IH0KICB9CgogIC8vIOKUgOKUgCBMb2FkaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiByZWZyZXNoKCkgewogICAgaWYgKCFTLm1vdW50ZWQpIHJldHVybiBQcm9taXNlLnJlc2",
"9sdmUoKTsKICAgIGlmIChTLmxvYWRpbmcpIHJldHVybiBTLmxvYWRpbmc7CiAgICBpZiAoIVMuYWNjb3VudCkgUy5hY2NvdW50ID0gaG9va3MuZ2V0QWNjb3VudCgpOwogICAgaWYgKCFTLmFjY291bnQpIHsKICAgICAgUy5zdGF0dXMgPSAnbm9fYWNjb3VudCc7CiAgICAgIHJlbmRlcigpOwogICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7CiAgICB9CgogICAgY29uc3Qgc3RhcnRlZEF0ID0gUy5tdXRhdGlvbnM7CiAgICBsZXQgb3ZlcnRha2VuID0gZmFsc2U7CgogICAgUy5sb2FkaW5nID0gKGFzeW5jICgpID0-IHsKICAgICAgdXBkYXRlQmFyKCk7CiAgICAgIHRyeSB7CiAgICAgICAgUy5jb2x1bW5zID0gYXdhaXQgc3RvcmUubG9hZENvbHVtbnMoUy5hY2NvdW50KTsKICAgICAgICBjb25zdCBbYm9hcmQsIHNhdmVkLCBlZGl0c10gPSBhd2FpdCBQcm9taXNlLmFsbChbCiAgICAgICAgICBzdG9yZS5sb2FkQm9hcmQoUy5hY2NvdW50LCBTLmNvbHVtbnMpLAogICAgICAgICAgc3RvcmUubG9hZE9yZGVyKFMuYWNjb3VudCksCiAgICAgICAgICBzdG9yZS5sb2FkQ2FyZEVkaXRzKFMuYWNjb3VudCksCiAgICAgICAgXSk7CiAgICAgICAgUy5lZGl0cyA9IGVkaXRzOwogICAgICAgIC8vIExhYmVsIG5hbWVzIGFzIEdtYWlsIGhhcyB0aGVtIG5vdzsgYSBjb2x1bW4gZm9sbG93cyBhIHJlbmFtZS4KICAgICAgICBTLmNvbHVtbnMgPSBib2FyZC5jb2x1bW5zOwogICAgICAgIC8vIEEgY2FyZCBtb3ZlZCB3aGlsZSB0aG",
"UgbGlzdHMgd2VyZSBpbiBmbGlnaHQ6IHdoYXQgY2FtZSBiYWNrIG1heQogICAgICAgIC8vIHByZWRhdGUgdGhhdCBtb3ZlIGFuZCB3b3VsZCBzbmFwIHRoZSBjYXJkIGJhY2suIFRocm93IGl0IGF3YXkgYW5kCiAgICAgICAgLy8gYXNrIGFnYWluOyBsb2FkQm9hcmQgd2FpdHMgZm9yIHRoZSBtb3ZlIHRvIGxhbmQgZmlyc3QuCiAgICAgICAgaWYgKFMubXV0YXRpb25zICE9PSBzdGFydGVkQXQpIHsKICAgICAgICAgIG92ZXJ0YWtlbiA9IHRydWU7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGNvbnN0IGxpc3RzID0ge307CiAgICAgICAgZm9yIChjb25zdCBjb2wgb2YgUy5jb2x1bW5zKSB7CiAgICAgICAgICBjb25zdCB0aHJlYWRzID0gKGJvYXJkLmxpc3RzW2NvbC5pZF0gfHwgW10pLm1hcChpZCA9PiAoeyBpZCwgdHM6IChzdG9yZS50aHJlYWQoaWQpIHx8IHt9KS50cyB9KSk7CiAgICAgICAgICBsaXN0c1tjb2wuaWRdID0gbG9naWMubWVyZ2VPcmRlcihzYXZlZFtjb2wuaWRdLCB0aHJlYWRzKTsKICAgICAgICB9CiAgICAgICAgUy5saXN0cyA9IGxpc3RzOwogICAgICAgIFMudHJ1bmNhdGVkID0gYm9hcmQudHJ1bmNhdGVkOwogICAgICAgIFMubG9hZGVkQXQgPSBEYXRlLm5vdygpOwogICAgICAgIFMuc3RhdHVzID0gJ3JlYWR5JzsKICAgICAgICBTLnN0YXR1c01lc3NhZ2UgPSAnJzsKICAgICAgICAvLyBTYXZlZCBkaXJlY3RseSwgbm90IHZpYSBwZXJzaXN0T3JkZXI6IHRoaXMgcHJ1bmVzIH",
"ZhbmlzaGVkIGlkcwogICAgICAgIC8vIGFuZCBpcyBub3QgYSBsb2NhbCBtb3ZlLgogICAgICAgIHN0b3JlLnNhdmVPcmRlcihTLmFjY291bnQsIFMubGlzdHMsIFMuY29sdW1ucykuY2F0Y2goKCkgPT4ge30pOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBoYW5kbGVFcnJvcihlcnIsICdDb3VsZG7igJl0IGxvYWQgdGhlIGJvYXJkJyk7CiAgICAgIH0gZmluYWxseSB7CiAgICAgICAgUy5sb2FkaW5nID0gbnVsbDsKICAgICAgICBpZiAoIW92ZXJ0YWtlbikgewogICAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgICBpZiAoUy5zZWFyY2ggJiYgUy5zZWFyY2guaWRzID09PSBudWxsKSBydW5TZWFyY2goKTsKICAgICAgICB9CiAgICAgIH0KICAgIH0pKCk7CiAgICBjb25zdCBwID0gUy5sb2FkaW5nOwogICAgcmV0dXJuIHAudGhlbigoKSA9PiAob3ZlcnRha2VuID8gcmVmcmVzaCgpIDogdW5kZWZpbmVkKSk7CiAgfQoKICAvLyBUaGUgdGhyZWUgYWNjb3VudCBzdGF0ZXMgZ2V0IGEgcGFuZWwgb2YgdGhlaXIgb3duOyBhbnl0aGluZyBlbHNlIGlzCiAgLy8gYSB0b2FzdCBvdmVyIHdoYXRldmVyIHdhcyBhbHJlYWR5IG9uIHNjcmVlbi4KICBmdW5jdGlvbiBoYW5kbGVFcnJvcihlcnIsIHByZWZpeCkgewogICAgaWYgKGFwaS5TVEFURV9DT0RFUy5oYXMoZXJyLmNvZGUpKSB7CiAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgIFMuc3RhdHVzTWVzc2FnZSA9IGVyci5tZXNzYWdlOwogICAgICBTLnNlYXJjaC",
"A9IG51bGw7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChTLnN0YXR1cyAhPT0gJ3JlYWR5JykgewogICAgICBTLnN0YXR1cyA9ICdlcnJvcic7CiAgICAgIFMuc3RhdHVzTWVzc2FnZSA9IGVyci5tZXNzYWdlOwogICAgICByZXR1cm47CiAgICB9CiAgICB0b2FzdChyb290LCBgJHtwcmVmaXh9OiAke2Vyci5tZXNzYWdlfWAsIHsga2luZDogJ2Vycm9yJyB9KTsKICB9CgogIC8vIEV2ZXJ5IGxvY2FsIGNoYW5nZSB0byB0aGUgbGlzdHMgZ29lcyB0aHJvdWdoIGhlcmUsIHdoaWNoIGlzIGFsc28gd2hhdAogIC8vIG1hcmtzIGFuIGluLWZsaWdodCByZWZyZXNoIGFzIG92ZXJ0YWtlbi4KICBmdW5jdGlvbiBwZXJzaXN0T3JkZXIoKSB7CiAgICBTLm11dGF0aW9ucysrOwogICAgc3RvcmUuc2F2ZU9yZGVyKFMuYWNjb3VudCwgUy5saXN0cywgUy5jb2x1bW5zKS5jYXRjaCgoKSA9PiB7fSk7CiAgfQoKICAvLyDilIDilIAgUmVuZGVyaW5nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiB1cGRhdGVCYXIoKSB7CiAgICBpZiAoIVMubW91bnRlZCkgcmV0dXJuOwogICAgZWxzLmFjY291bnQudGV4dENvbnRlbnQgPSBTLmFjY291bnQgfHwgJ0FjY291bn",
"Qgbm90IGRldGVjdGVkJzsKICAgIGVscy5hY2NvdW50LnRpdGxlID0gUy5hY2NvdW50ID8gYEdtYWlsIGFjY291bnQ6ICR7Uy5hY2NvdW50fWAgOiAnJzsKICAgIC8vIFRoZSByZWZyZXNoIGJ1dHRvbiBhbmQgInVwZGF0ZWQg4oCmIiBzcGVhayBmb3Igd2hpY2hldmVyIHRhYiBpcyBvcGVuLgogICAgY29uc3Qgbm90ZXMgPSBTLnZpZXcgPT09ICdub3Rlcyc7CiAgICBjb25zdCBjYWxlbmRhciA9IFMudmlldyA9PT0gJ2NhbGVuZGFyJzsKICAgIGNvbnN0IGxvYWRpbmcgPSBub3RlcyA_IG5zLm5vdGVzLmlzTG9hZGluZygpIDogY2FsZW5kYXIgPyBucy5jYWxlbmRhci5pc0xvYWRpbmcoKSA6ICEhUy5sb2FkaW5nOwogICAgY29uc3QgbG9hZGVkQXQgPSBub3RlcyA_IG5zLm5vdGVzLmxvYWRlZEF0KCkgOiBjYWxlbmRhciA_IG5zLmNhbGVuZGFyLmxvYWRlZEF0KCkgOiBTLmxvYWRlZEF0OwogICAgZWxzLnVwZGF0ZWQudGV4dENvbnRlbnQgPSBsb2FkaW5nID8gJ1VwZGF0aW5n4oCmJwogICAgICA6IGxvYWRlZEF0ID8gYHVwZGF0ZWQgJHt1dGlsLmFnb1RleHQoRGF0ZS5ub3coKSAtIGxvYWRlZEF0KX1gIDogJyc7CiAgICBlbHMucmVmcmVzaC5jbGFzc0xpc3QudG9nZ2xlKCdzcGlubmluZycsIGxvYWRpbmcpOwogICAgZWxzLnJlZnJlc2guZGlzYWJsZWQgPSBsb2FkaW5nIHx8ICFTLmFjY291bnQ7CiAgICBlbHMuc2V0dGluZ3MuaGlkZGVuID0gbm90ZXMgfHwgY2FsZW5kYXI7CiAgICBlbHMuc2V0dGluZ3MuZGlzYWJsZW",
"QgPSBTLnN0YXR1cyAhPT0gJ3JlYWR5JzsKICAgIGZvciAoY29uc3QgdCBvZiBlbHMudGFicy5jaGlsZHJlbikgdC5zZXRBdHRyaWJ1dGUoJ2FyaWEtc2VsZWN0ZWQnLCBTdHJpbmcodC5kYXRhc2V0LnZpZXcgPT09IFMudmlldykpOwogICAgLy8gVGhlIGNhbGVuZGFyJ3Mgc2NyYXRjaHBhZCB0aWxlIGhhcyBhICJTYXZlZCA1cyBhZ28iIG9mIGl0cyBvd24uCiAgICBpZiAobm90ZXMgfHwgY2FsZW5kYXIpIG5zLm5vdGVzLnRpY2soKTsKICAgIGlmIChjYWxlbmRhcikgbnMuY2FsZW5kYXIudGljaygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyKCkgewogICAgaWYgKCFTLm1vdW50ZWQpIHJldHVybjsKICAgIC8vIFJlYnVpbGRpbmcgdGhlIGNvbHVtbnMgbWlkLWRyYWcgd291bGQgcHVsbCB0aGUgY2FyZCBvdXQgZnJvbSB1bmRlcgogICAgLy8gdGhlIHBvaW50ZXIuIFdoYXRldmVyIGNoYW5nZWQgaXMgZHJhd24gb25jZSB0aGUgZHJhZyBlbmRzLgogICAgaWYgKFMuZHJhZykgeyBTLnJlbmRlckRlZmVycmVkID0gdHJ1ZTsgcmV0dXJuOyB9CgogICAgdXBkYXRlQmFyKCk7CiAgICBjbG9zZU1lbnUocm9vdCk7CgogICAgY29uc3Qga2V5ID0gZm9jdXNLZXkoKTsKICAgIGNvbnN0IHNjcm9sbCA9IGNhcHR1cmVTY3JvbGwoKTsKICAgIC8vIFRoZSBub3RlcyB2aWV3IGhhbmRzIGJhY2sgdGhlIHNhbWUgZWxlbWVudCBldmVyeSB0aW1lOyBwdXR0aW5nIGl0CiAgICAvLyBiYWNrIHdvdWxkIGJsdXIgdGhlIHRleHQgYm94IG1pZC",
"1zZW50ZW5jZSwgc28gaXQgaXMgbGVmdCBpbiBwbGFjZS4KICAgIGNvbnN0IG5leHQgPSByZW5kZXJCb2R5KCk7CiAgICBpZiAoZWxzLmJvZHkuZmlyc3RDaGlsZCAhPT0gbmV4dCB8fCBlbHMuYm9keS5jaGlsZE5vZGVzLmxlbmd0aCAhPT0gMSkgZWxzLmJvZHkucmVwbGFjZUNoaWxkcmVuKG5leHQpOwogICAgcmVzdG9yZVNjcm9sbChzY3JvbGwpOwogICAgcmVzdG9yZUZvY3VzKGtleSwgZWxzLmJvZHkpOwogICAgLy8gVGhlIGZvY3VzZWQgY2FyZCBtYXkgYmUgZ29uZSAocmVtb3ZlZCwgb3IgbW92ZWQgb2ZmIGEgY29sdW1uIHRoYXQKICAgIC8vIHJlLXJlbmRlcmVkKS4gS2VlcCBmb2N1cyBpbiB0aGUgZGlhbG9nIHJhdGhlciB0aGFuIGRyb3BwaW5nIGl0IG9uCiAgICAvLyBHbWFpbCdzIHBhZ2UsIHdoZXJlIHRoZSBuZXh0IGtleSBwcmVzcyB3b3VsZCBiZSBHbWFpbCdzLgogICAgaWYgKGtleSAmJiBTLm9wZW4gJiYgIWVscy5vdmVybGF5LmNvbnRhaW5zKHJvb3QuYWN0aXZlRWxlbWVudCkpIGVscy5vdmVybGF5LmZvY3VzKCk7CiAgfQoKICBmdW5jdGlvbiBmb2N1c0tleSgpIHsKICAgIGNvbnN0IGEgPSByb290LmFjdGl2ZUVsZW1lbnQ7CiAgICByZXR1cm4gYSAmJiBhLmRhdGFzZXQgPyBhLmRhdGFzZXQua2V5IHx8ICcnIDogJyc7CiAgfQoKICBmdW5jdGlvbiByZXN0b3JlRm9jdXMoa2V5LCBzY29wZSkgewogICAgaWYgKCFrZXkpIHJldHVybjsKICAgIGNvbnN0IGVsID0gWy4uLnNjb3BlLnF1ZXJ5U2VsZWN0b3",
"JBbGwoJ1tkYXRhLWtleV0nKV0uZmluZCh4ID0-IHguZGF0YXNldC5rZXkgPT09IGtleSk7CiAgICBpZiAoIWVsIHx8IGVsLmRpc2FibGVkKSByZXR1cm47CiAgICBlbC5mb2N1cyh7IHByZXZlbnRTY3JvbGw6IHRydWUgfSk7CiAgICBpZiAoZWwudGFnTmFtZSA9PT0gJ0lOUFVUJyAmJiBlbC50eXBlICE9PSAnY2hlY2tib3gnKSB7CiAgICAgIGNvbnN0IG4gPSBlbC52YWx1ZS5sZW5ndGg7CiAgICAgIHRyeSB7IGVsLnNldFNlbGVjdGlvblJhbmdlKG4sIG4pOyB9IGNhdGNoIHsgLyogbm90IGEgdGV4dCBpbnB1dCAqLyB9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBjYXB0dXJlU2Nyb2xsKCkgewogICAgY29uc3Qgb3V0ID0geyBsZWZ0OiAwLCBsaXN0czoge30gfTsKICAgIGNvbnN0IGNvbHMgPSBlbHMuYm9keS5xdWVyeVNlbGVjdG9yKCcuY29sdW1ucycpOwogICAgaWYgKCFjb2xzKSByZXR1cm4gb3V0OwogICAgb3V0LmxlZnQgPSBjb2xzLnNjcm9sbExlZnQ7CiAgICBmb3IgKGNvbnN0IHNlYyBvZiBjb2xzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2x1bW4nKSkgewogICAgICBjb25zdCBsaXN0ID0gc2VjLnF1ZXJ5U2VsZWN0b3IoJy5saXN0Jyk7CiAgICAgIGlmIChsaXN0KSBvdXQubGlzdHNbc2VjLmRhdGFzZXQuY29sXSA9IGxpc3Quc2Nyb2xsVG9wOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIHJlc3RvcmVTY3JvbGwocykgewogICAgY29uc3QgY29scyA9IGVscy5ib2R5LnF1ZXJ5U2VsZWN0b3",
"IoJy5jb2x1bW5zJyk7CiAgICBpZiAoIWNvbHMpIHJldHVybjsKICAgIGNvbHMuc2Nyb2xsTGVmdCA9IHMubGVmdDsKICAgIGZvciAoY29uc3Qgc2VjIG9mIGNvbHMucXVlcnlTZWxlY3RvckFsbCgnLmNvbHVtbicpKSB7CiAgICAgIGNvbnN0IGxpc3QgPSBzZWMucXVlcnlTZWxlY3RvcignLmxpc3QnKTsKICAgICAgaWYgKGxpc3QgJiYgcy5saXN0c1tzZWMuZGF0YXNldC5jb2xdKSBsaXN0LnNjcm9sbFRvcCA9IHMubGlzdHNbc2VjLmRhdGFzZXQuY29sXTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckJvZHkoKSB7CiAgICBpZiAoYmxvY2tlZCgpKSByZXR1cm4gbGljZW5jZVBhbmVsKCk7CiAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnICYmICFQQU5FTF9TVEFURVMuaGFzKFMuc3RhdHVzKSkgcmV0dXJuIG5zLm5vdGVzLmVsZW1lbnQoKTsKICAgIGlmIChTLnZpZXcgPT09ICdjYWxlbmRhcicgJiYgIVBBTkVMX1NUQVRFUy5oYXMoUy5zdGF0dXMpKSByZXR1cm4gbnMuY2FsZW5kYXIuZWxlbWVudCgpOwogICAgc3dpdGNoIChTLnN0YXR1cykgewogICAgICBjYXNlICdub19hY2NvdW50JzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2JvYXJkJywgJ1doaWNoIGFjY291bnQgaXMgdGhpcz8nLAogICAgICAgICAgYCR7QVBQX05BTUV9IGNvdWxkbuKAmXQgdGVsbCB3aGljaCBHb29nbGUgYWNjb3VudCB0aGlzIEdtYWlsIHRhYiBiZWxvbmdzIHRvLCBzbyBpdCBkb2VzbuKAmXQga25vdyB3aG9zZSBib2FyZCB0byBzaG93Li",
"BSZWxvYWRpbmcgR21haWwgdXN1YWxseSBzb3J0cyBpdCBvdXQuYCwKICAgICAgICAgIFtdKTsKICAgICAgY2FzZSAnbm90X2NvbmZpZ3VyZWQnOgogICAgICAgIHJldHVybiBwYW5lbCgndHVuZScsICdGaW5pc2ggc2V0dGluZyB1cCcsCiAgICAgICAgICAnQWRkIHlvdXIgT0F1dGggY2xpZW50IElEIG9uIHRoZSBzZXR1cCBwYWdlLiBJdCBpcyBhIG9uZS1vZmYgYW5kIHRha2VzIGEgY291cGxlIG9mIG1pbnV0ZXMuJywKICAgICAgICAgIFtidXR0b24oJ09wZW4gc2V0dXAnLCAncHJpbWFyeScsICgpID0-IGFwaS5vcGVuT3B0aW9ucygpLmNhdGNoKGVyciA9PiB0b2FzdChyb290LCBlcnIubWVzc2FnZSwgeyBraW5kOiAnZXJyb3InIH0pKSldKTsKICAgICAgY2FzZSAnYXV0aF9yZXF1aXJlZCc6CiAgICAgICAgcmV0dXJuIHBhbmVsKCdib2FyZCcsICdDb25uZWN0IEdtYWlsJywKICAgICAgICAgIGBBbGxvdyAke0FQUF9OQU1FfSB0byByZWFkIGFuZCBsYWJlbCBtYWlsIGluICR7Uy5hY2NvdW50fS4gR29vZ2xlIHdpbGwgYXNrIHlvdSB0byBjb25maXJtLmAsCiAgICAgICAgICBbYnV0dG9uKCdDb25uZWN0IEdtYWlsJywgJ3ByaW1hcnknLCBjb25uZWN0KV0pOwogICAgICBjYXNlICdhY2NvdW50X21pc21hdGNoJzoKICAgICAgICByZXR1cm4gcGFuZWwoJ2JvYXJkJywgJ1RoYXQgd2FzIGEgZGlmZmVyZW50IGFjY291bnQnLAogICAgICAgICAgYCR7Uy5zdGF0dXNNZXNzYWdlfSBUaGUgYm9hcmQgb25seSBldmVyIGFjdH",
"Mgb24gdGhlIG1haWxib3ggb3BlbiBpbiB0aGlzIHRhYi4gQ29ubmVjdCBhZ2FpbiBhbmQgY2hvb3NlICR7Uy5hY2NvdW50fS5gLAogICAgICAgICAgW2J1dHRvbignQ29ubmVjdCBhZ2FpbicsICdwcmltYXJ5JywgY29ubmVjdCldKTsKICAgICAgY2FzZSAnZXJyb3InOgogICAgICAgIHJldHVybiBwYW5lbCgncmVmcmVzaCcsICdDb3VsZG7igJl0IGxvYWQgdGhlIGJvYXJkJywgUy5zdGF0dXNNZXNzYWdlLAogICAgICAgICAgW2J1dHRvbignVHJ5IGFnYWluJywgJ3ByaW1hcnknLCAoKSA9PiByZWZyZXNoKCkpXSk7CiAgICAgIGRlZmF1bHQ6CiAgICAgICAgcmV0dXJuIHJlbmRlckNvbHVtbnMoKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHBhbmVsKGljb25OYW1lLCB0aXRsZSwgdGV4dCwgYWN0aW9ucykgewogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdwYW5lbCcsIHJvbGU6ICdyZWdpb24nLCAnYXJpYS1sYWJlbCc6IHRpdGxlIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncGFuZWwtaWNvbicgfSwgaWNvbihpY29uTmFtZSwgMjgpKSwKICAgICAgaCgnaDInLCB7IHRleHQ6IHRpdGxlIH0pLAogICAgICBoKCdwJywgeyB0ZXh0IH0pLAogICAgICBhY3Rpb25zLmxlbmd0aCA_IGgoJ2RpdicsIHsgY2xhc3M6ICdhY3Rpb25zJyB9LCBhY3Rpb25zKSA6IG51bGwpOwogIH0KCiAgZnVuY3Rpb24gYnV0dG9uKGxhYmVsLCBraW5kLCBvbkNsaWNrKSB7CiAgICByZXR1cm4gaCgnYnV0dG9uJywgewogICAgICBjbG",
"FzczogWydidG4nLCBgYnRuLSR7a2luZH1gXSwgdHlwZTogJ2J1dHRvbicsIHRleHQ6IGxhYmVsLAogICAgICBvbmNsaWNrOiBlID0-IG9uQ2xpY2soZS5jdXJyZW50VGFyZ2V0KSwKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gY29ubmVjdChidG4pIHsKICAgIGlmIChidG4pIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkuY29ubmVjdCgpOwogICAgICBpZiAoUy52aWV3ID09PSAnbm90ZXMnKSB7CiAgICAgICAgUy5zdGF0dXMgPSAnaWRsZSc7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgICAgYXdhaXQgbnMubm90ZXMubG9hZCh7IGZvcmNlOiB0cnVlIH0pOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBTLnN0YXR1cyA9ICdsb2FkaW5nJzsKICAgICAgcmVuZGVyKCk7CiAgICAgIGF3YWl0IHJlZnJlc2goKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAoZXJyLmNvZGUgPT09ICdhY2NvdW50X21pc21hdGNoJyB8fCBlcnIuY29kZSA9PT0gJ25vdF9jb25maWd1cmVkJykgewogICAgICAgIFMuc3RhdHVzID0gZXJyLmNvZGU7CiAgICAgICAgUy5zdGF0dXNNZXNzYWdlID0gZXJyLm1lc3NhZ2U7CiAgICAgICAgcmVuZGVyKCk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdG9hc3Qocm9vdCwgYENvdWxkbuKAmXQgY29ubmVjdDogJHtlcnIubWVzc2FnZX1gLCB7IGtpbmQ6ICdlcnJvcicgfSk7CiAgICAgIH0KICAgIH0gZmluYWxseSB7CiAgICAgIGlmIChidG4gJi",
"YgYnRuLmlzQ29ubmVjdGVkKSBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckNvbHVtbnMoKSB7CiAgICBjb25zdCBza2VsZXRvbiA9IFMuc3RhdHVzICE9PSAncmVhZHknOwogICAgdGFnSW5kZXggPSBudWxsOyAvLyB0aGUgbGFiZWxzLCBsb29rZWQgdXAgYWZyZXNoIGZvciB0aGlzIGRyYXdpbmcKICAgIGNvbnN0IHdyYXAgPSBoKCdkaXYnLCB7IGNsYXNzOiAnY29sdW1ucycgfSk7CiAgICBmb3IgKGNvbnN0IGNvbCBvZiBTLmNvbHVtbnMpIHdyYXAuYXBwZW5kQ2hpbGQocmVuZGVyQ29sdW1uKGNvbCwgc2tlbGV0b24pKTsKICAgIHdyYXAuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLCBvbkRyYWdPdmVyKTsKICAgIHdyYXAuYWRkRXZlbnRMaXN0ZW5lcignZHJvcCcsIG9uRHJvcCk7CiAgICByZXR1cm4gd3JhcDsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckNvbHVtbihjb2wsIHNrZWxldG9uKSB7CiAgICBjb25zdCBpZHMgPSBTLmxpc3RzW2NvbC5pZF0gfHwgW107CiAgICBjb25zdCBzZWFyY2hpbmcgPSAhIShTLnNlYXJjaCAmJiBTLnNlYXJjaC5jb2xJZCA9PT0gY29sLmlkKTsKCiAgICBjb25zdCBsaXN0ID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ2xpc3QnLCByb2xlOiAnbGlzdCcsICdhcmlhLWxhYmVsJzogYCR7Y29sLnRpdGxlfTogdGhyZWFkc2AsCiAgICAgICdkYXRhLWVtcHR5JzogJ0RyYWcgdGhyZWFkcyBoZXJlLCBvciB1c2UgKyB0byBmaW5kIG9uZScsCi",
"AgICB9KTsKICAgIGlmIChza2VsZXRvbikgewogICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDM7IGkrKykgbGlzdC5hcHBlbmRDaGlsZChoKCdkaXYnLCB7IGNsYXNzOiAnc2tlbGV0b24nLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSkpOwogICAgfSBlbHNlIHsKICAgICAgZm9yIChjb25zdCBpZCBvZiBpZHMpIHsKICAgICAgICBjb25zdCBjYXJkID0gcmVuZGVyQ2FyZChpZCwgY29sKTsKICAgICAgICBpZiAoY2FyZCkgbGlzdC5hcHBlbmRDaGlsZChjYXJkKTsKICAgICAgfQogICAgfQoKICAgIGNvbnN0IGNvdW50ID0gUy50cnVuY2F0ZWRbY29sLmlkXSA_IGAke2lkcy5sZW5ndGh9K2AgOiBTdHJpbmcoaWRzLmxlbmd0aCk7CiAgICBjb25zdCBoZWFkID0gaCgnZGl2JywgeyBjbGFzczogJ2NvbC1oZWFkJyB9LAogICAgICBoKCdoMicsIHsgY2xhc3M6ICdjb2wtdGl0bGUnLCB0ZXh0OiBjb2wudGl0bGUsIHRpdGxlOiBgR21haWwgbGFiZWw6ICR7Y29sLmxhYmVsfWAgfSksCiAgICAgIHNrZWxldG9uID8gbnVsbCA6IGgoJ3NwYW4nLCB7IGNsYXNzOiAnY29sLWNvdW50JywgdGV4dDogY291bnQsICdhcmlhLWxhYmVsJzogYCR7Y291bnR9IHRocmVhZHNgIH0pLAogICAgICBjb2wuYXJjaGl2ZU9uRHJvcCA_IGgoJ3NwYW4nLCB7CiAgICAgICAgY2xhc3M6ICdjb2wtZmxhZycsIHRleHQ6ICdBcmNoaXZlcycsCiAgICAgICAgdGl0bGU6ICdNb3ZpbmcgYSB0aHJlYWQgaGVyZSBhbHNvIGFyY2hpdmVzIGl0ICh0YWtlcyBpdC",
"BvdXQgb2YgdGhlIEluYm94KScsCiAgICAgIH0pIDogbnVsbCwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3NwYWNlcicgfSksCiAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsCiAgICAgICAgJ2FyaWEtbGFiZWwnOiBgRmluZCBhIHRocmVhZCB0byBhZGQgdG8gJHtjb2wudGl0bGV9YCwgdGl0bGU6ICdBZGQgZnJvbSBHbWFpbCcsCiAgICAgICAgJ2FyaWEtZXhwYW5kZWQnOiBTdHJpbmcoc2VhcmNoaW5nKSwgZGlzYWJsZWQ6IHNrZWxldG9uLAogICAgICAgIGRhdGFzZXQ6IHsga2V5OiBgYWRkOiR7Y29sLmlkfWAsIGFjdGlvbjogJ2FkZCcgfSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiB0b2dnbGVTZWFyY2goY29sLmlkKSwKICAgICAgfSwgaWNvbihzZWFyY2hpbmcgPyAnY2xvc2UnIDogJ2FkZCcpKSk7CgogICAgcmV0dXJuIGgoJ3NlY3Rpb24nLCB7IGNsYXNzOiAnY29sdW1uJywgJ2FyaWEtbGFiZWwnOiBjb2wudGl0bGUsIGRhdGFzZXQ6IHsgY29sOiBjb2wuaWQgfSB9LAogICAgICBoZWFkLAogICAgICBTLnRydW5jYXRlZFtjb2wuaWRdID8gaCgnZGl2JywgeyBjbGFzczogJ2NvbC1ub3RlJywgdGV4dDogJ1Nob3dpbmcgdGhlIGZpcnN0IDEwMCB0aHJlYWRzJyB9KSA6IG51bGwsCiAgICAgIHNlYXJjaGluZyA_IHJlbmRlclNlYXJjaChjb2wpIDogbnVsbCwKICAgICAgbGlzdCk7CiAgfQoKICAvLyBBIGNhcmQgc2hvd3MgdGhlIHVzZXIncyBvd24gdG",
"l0bGUgYW5kIG5vdGUgd2hlbiBpdCBoYXMgdGhlbS4gVGhlCiAgLy8gZW1haWwncyBzdWJqZWN0IHN0YXlzIG9uZSBob3ZlciBhd2F5LCBzbyBhIHJlbmFtZWQgY2FyZCBjYW4gYWx3YXlzIGJlCiAgLy8gbWF0Y2hlZCB0byB0aGUgbWFpbCBiZWhpbmQgaXQuCiAgZnVuY3Rpb24gcmVuZGVyQ2FyZChpZCwgY29sKSB7CiAgICBjb25zdCB0ID0gc3RvcmUudGhyZWFkKGlkKTsKICAgIGlmICghdCkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBkYXRlID0gdXRpbC5yZWxhdGl2ZURhdGUodC50cyk7CiAgICBjb25zdCBlZGl0ID0gUy5lZGl0cy5nZXQoaWQpIHx8IG51bGw7CiAgICBjb25zdCB0aXRsZSA9IGxvZ2ljLmRpc3BsYXlUaXRsZSh0LCBlZGl0KTsKICAgIGNvbnN0IHRhZ3MgPSBjYXJkVGFncyh0KTsKCiAgICBjb25zdCBtYWluID0gaCgnYnV0dG9uJywgewogICAgICBjbGFzczogJ2NhcmQtbWFpbicsIHR5cGU6ICdidXR0b24nLCBkYXRhc2V0OiB7IGtleTogYGNhcmQ6JHtpZH1gIH0sCiAgICAgIHRpdGxlOiBlZGl0ICYmIGVkaXQudGl0bGUKICAgICAgICA_IGBFbWFpbCBzdWJqZWN0OiAke3Quc3ViamVjdH1cbk9wZW4gaW4gR21haWwgKEN0cmwtY2xpY2sgZm9yIGEgbmV3IHRhYilgCiAgICAgICAgOiAnT3BlbiBpbiBHbWFpbCAoQ3RybC1jbGljayBmb3IgYSBuZXcgdGFiKScsCiAgICAgIG9uY2xpY2s6IGUgPT4gb3BlblRocmVhZChpZCwgZSksCiAgICAgIG9uYXV4Y2xpY2s6IGUgPT4geyBpZiAoZS5idXR0b24gPT",
"09IDEpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBvcGVuVGhyZWFkKGlkLCB7IGN0cmxLZXk6IHRydWUgfSk7IH0gfSwKICAgIH0sCiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnY2FyZC10b3AnIH0sCiAgICAgICAgdC51bnJlYWQgPyBoKCdzcGFuJywgeyBjbGFzczogJ2RvdCcsIHRpdGxlOiAnVW5yZWFkJyB9KSA6IG51bGwsCiAgICAgICAgdC51bnJlYWQgPyBoKCdzcGFuJywgeyBjbGFzczogJ3NyLW9ubHknLCB0ZXh0OiAnVW5yZWFkLiAnIH0pIDogbnVsbCwKICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2Zyb20nLCB0ZXh0OiB0LmZyb20gfSksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdkYXRlJywgdGV4dDogZGF0ZSwgdGl0bGU6IHV0aWwuZnVsbERhdGUodC50cykgfSkpLAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3N1YmplY3Qtcm93JyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3ViamVjdCcsIHRleHQ6IHRpdGxlIH0pLAogICAgICAgIHQuaGFzRHJhZnQgPyBoKCdzcGFuJywgeyBjbGFzczogJ2RyYWZ0JywgdGV4dDogJ0RyYWZ0JyB9KSA6IG51bGwsCiAgICAgICAgdC5zdGFycmVkID8gaCgnc3BhbicsIHsgY2xhc3M6ICdzdGFyJywgdGl0bGU6ICdTdGFycmVkJywgJ2FyaWEtbGFiZWwnOiAnU3RhcnJlZCcgfSwgaWNvbignc3RhcicsIDE2KSkgOiBudWxsLAogICAgICAgIHQuY291bnQgPiAxID8gaCgnc3BhbicsIHsgY2xhc3M6ICdjb3VudCcsIHRleHQ6IFN0cmluZyh0LmNvdW",
"50KSwgdGl0bGU6IGAke3QuY291bnR9IG1lc3NhZ2VzYCB9KSA6IG51bGwpLAogICAgICBlZGl0ICYmIGVkaXQubm90ZQogICAgICAgID8gaCgnc3BhbicsIHsgY2xhc3M6ICdjYXJkLW5vdGUnIH0sIGgoJ3NwYW4nLCB7IGNsYXNzOiAnc3Itb25seScsIHRleHQ6ICdOb3RlOiAnIH0pLCBlZGl0Lm5vdGUpCiAgICAgICAgOiB0LnNuaXBwZXQgPyBoKCdzcGFuJywgeyBjbGFzczogJ3NuaXBwZXQnLCB0ZXh0OiB0LnNuaXBwZXQgfSkgOiBudWxsLAogICAgICBsYWJlbFRhZ3NFbCh0YWdzKSk7CgogICAgY29uc3QgbW9yZSA9IGgoJ2J1dHRvbicsIHsKICAgICAgY2xhc3M6ICdpY29uLWJ0biBjYXJkLW1lbnUnLCB0eXBlOiAnYnV0dG9uJywKICAgICAgJ2FyaWEtbGFiZWwnOiBgTW9yZSBhY3Rpb25zOiAke3RpdGxlfWAsIHRpdGxlOiAnTW9yZSBhY3Rpb25zJywKICAgICAgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsICdhcmlhLWV4cGFuZGVkJzogJ2ZhbHNlJywKICAgICAgZGF0YXNldDogeyBrZXk6IGBtZW51OiR7aWR9YCB9LAogICAgICBvbmNsaWNrOiBlID0-IG9wZW5DYXJkTWVudShlLmN1cnJlbnRUYXJnZXQsIGlkLCBjb2wuaWQpLAogICAgfSwgaWNvbignbW9yZScsIDIwKSk7CgogICAgLy8gSXRzIGNvbG91cjogb25lIHNldCBieSBoYW5kLCBlbHNlIGl0cyBmaXJzdCBjb2xvdXJlZCBHbWFpbCBsYWJlbCdzLgogICAgY29uc3QgdGludCA9ICEoZWRpdCAmJiBlZGl0LmNvbG91cikgJiYgdGFncy5sZW5ndGggPyB0YW",
"dzWzBdLmJhY2tncm91bmQgOiAnJzsKICAgIGNvbnN0IGNhcmQgPSBoKCdkaXYnLCB7CiAgICAgIGNsYXNzOiBbJ2NhcmQnLCB0LnVucmVhZCAmJiAndW5yZWFkJ10sIHJvbGU6ICdsaXN0aXRlbScsIGRyYWdnYWJsZTogJ3RydWUnLAogICAgICBkYXRhc2V0OiBlZGl0ICYmIGVkaXQuY29sb3VyID8geyBpZCwgY29sb3VyOiBlZGl0LmNvbG91ciB9IDogdGludCA_IHsgaWQsIHRpbnRlZDogJycgfSA6IHsgaWQgfSwKICAgIH0sIG1haW4sIHdhaXRpbmdNYXJrKHQsIGlkLCBjb2wpLCBtb3JlKTsKICAgIGlmICh0aW50KSBjYXJkLnN0eWxlLnNldFByb3BlcnR5KCctLXN0cmlwZScsIHRpbnQpOwogICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCBlID0-IG9uRHJhZ1N0YXJ0KGUsIGlkLCBjb2wuaWQsIGNhcmQpKTsKICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsIG9uRHJhZ0VuZCk7CiAgICByZXR1cm4gY2FyZDsKICB9CgogIC8vIOKUgOKUgCBXaGF0IGEgY2FyZCBzYXlzIGJlc2lkZXMg4pSA4pSACiAgLy8KICAvLyBJdHMgR21haWwgbGFiZWxzIHRoYXQgaGF2ZSBhIGNvbG91ciB0aGVyZSwgYXMgc21hbGwgdGFncyBpbiBpdCAoc2VlCiAgLy8gbG9naWMubGFiZWxUYWdzKTogbm90IHRoZSBib2FyZCdzIG93biBsYWJlbHMsIG5vciB0aGUgbm90ZXMnLiBUaGUKICAvLyBsYWJlbHMgYnkgaWQsIGFuZCB0aG9zZSB0byBza2lwLCBvbmNlIGZvciBlYWNoIGRyYXdpbmcgb2YgdGhlIGJvYX",
"JkLAogIC8vIG5vdCBvbmNlIGZvciBlYWNoIGNhcmQuCiAgbGV0IHRhZ0luZGV4ID0gbnVsbDsKICBmdW5jdGlvbiBjYXJkVGFncyh0KSB7CiAgICBpZiAoIXRhZ0luZGV4KSB7CiAgICAgIGNvbnN0IHNraXAgPSBTLmNvbHVtbnMuZmxhdE1hcChjID0-IFtjLmxhYmVsLCAuLi5sb2dpYy5sYWJlbEFuY2VzdG9ycyhjLmxhYmVsKV0pOwogICAgICBpZiAobnMubm90ZXNMb2dpYykgc2tpcC5wdXNoKG5zLm5vdGVzTG9naWMuREVGQVVMVF9MQUJFTCk7CiAgICAgIHRhZ0luZGV4ID0geyBieUlkOiBuZXcgTWFwKHN0b3JlLmFsbExhYmVscygpLm1hcChsID0-IFtsLmlkLCBsXSkpLCBza2lwIH07CiAgICB9CiAgICByZXR1cm4gbG9naWMubGFiZWxUYWdzKHQubGFiZWxJZHMsIHRhZ0luZGV4LmJ5SWQsIHRhZ0luZGV4LnNraXApOwogIH0KCiAgZnVuY3Rpb24gbGFiZWxUYWdzRWwodGFncykgewogICAgaWYgKCF0YWdzLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gaCgnc3BhbicsIHsgY2xhc3M6ICdjYXJkLXRhZ3MnIH0sIHRhZ3MubWFwKHRhZyA9PiB7CiAgICAgIGNvbnN0IGVsID0gaCgnc3BhbicsIHsgY2xhc3M6ICdsYWJlbC10YWcnLCB0ZXh0OiB0YWcuc2hvcnQsIHRpdGxlOiBgR21haWwgbGFiZWw6ICR7dGFnLm5hbWV9YCB9KTsKICAgICAgZWwuc3R5bGUuc2V0UHJvcGVydHkoJy0tdGFnLWJnJywgdGFnLmJhY2tncm91bmQpOwogICAgICBlbC5zdHlsZS5zZXRQcm9wZXJ0eSgnLS10YWctZmcnLCB0YWcudG",
"V4dCk7CiAgICAgIHJldHVybiBlbDsKICAgIH0pKTsKICB9CgogIC8vIFRoZSBjb2x1bW4gYSB0aHJlYWQgd2FpdHMgaW46IHRoZSBib2FyZCdzIG93biBXYWl0aW5nLCBvciBvbmUgY2FsbGVkIHNvLgogIGZ1bmN0aW9uIHdhaXRpbmdDb2x1bW4oKSB7CiAgICByZXR1cm4gUy5jb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSAnd2FpdGluZycpIHx8IFMuY29sdW1ucy5maW5kKGMgPT4gL3dhaXQvaS50ZXN0KGMudGl0bGUpKSB8fCBudWxsOwogIH0KCiAgLy8gIldhaXRpbmcgb24gdGhlbSI6IHRoZSBuZXdlc3QgbWVzc2FnZSBpcyB0aGUgdXNlcidzIG93biBhbmQgbm90aGluZyBpcwogIC8vIGJlaW5nIHdyaXR0ZW4gYmFjaywgc28gdGhlIGJhbGwgaXMgaW4gdGhlIG90aGVyIGNvdXJ0IC0gb24gYSBjYXJkIGluCiAgLy8gYW55IGNvbHVtbiBidXQgdGhlIHdhaXRpbmcgb25lIGFuZCBhIGRvbmUgb25lLiBBIGNsaWNrIG1vdmVzIGl0IHRvIHRoZQogIC8vIHdhaXRpbmcgY29sdW1uLCBpZiB0aGVyZSBpcyBvbmU7IGl0IG1vdmVzIG5vd2hlcmUgYnkgaXRzZWxmLgogIGZ1bmN0aW9uIHdhaXRpbmdNYXJrKHQsIGlkLCBjb2wpIHsKICAgIGNvbnN0IHdhaXQgPSB3YWl0aW5nQ29sdW1uKCk7CiAgICBpZiAoIXQud2FpdGluZyB8fCBjb2wuYXJjaGl2ZU9uRHJvcCB8fCAod2FpdCAmJiBjb2wuaWQgPT09IHdhaXQuaWQpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IHdoeSA9ICdZb3VyIG1lc3NhZ2Ugd2FzIHRoZSBsYXN0IG9uZT",
"ogdGhlIGJhbGwgaXMgaW4gdGhlaXIgY291cnQuJzsKICAgIGNvbnN0IGlubmVyID0gW2ljb24oJ2hvdXJnbGFzcycsIDE0KSwgaCgnc3BhbicsIHsgdGV4dDogJ1dhaXRpbmcgb24gdGhlbScgfSldOwogICAgaWYgKCF3YWl0KSByZXR1cm4gaCgnc3BhbicsIHsgY2xhc3M6ICdjYXJkLXdhaXQnLCB0aXRsZTogd2h5IH0sIGlubmVyKTsKICAgIHJldHVybiBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnY2FyZC13YWl0JywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiBgd2FpdDoke2lkfWAgfSwKICAgICAgdGl0bGU6IGAke3doeX0gQ2xpY2sgdG8gbW92ZSBpdCB0byAke3dhaXQudGl0bGV9LmAsCiAgICAgICdhcmlhLWxhYmVsJzogYFdhaXRpbmcgb24gdGhlbS4gTW92ZSB0byAke3dhaXQudGl0bGV9YCwKICAgICAgb25jbGljazogKCkgPT4gbW92ZVRocmVhZChpZCwgY29sLmlkLCB3YWl0LmlkLCAwKSwKICAgIH0sIGlubmVyLCBoKCdzcGFuJywgeyBjbGFzczogJ2NhcmQtd2FpdC1tb3ZlJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0sIGljb24oJ2Fycm93JywgMTQpLCB3YWl0LnRpdGxlKSk7CiAgfQoKICBmdW5jdGlvbiBhbm5vdW5jZShtc2cpIHsKICAgIGVscy5saXZlLnRleHRDb250ZW50ID0gbXNnOwogIH0KCiAgLy8g4pSA4pSAIENhcmQgYWN0aW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilI",
"DilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gb3BlblRocmVhZChpZCwgZSkgewogICAgaWYgKGUgJiYgKGUuY3RybEtleSB8fCBlLm1ldGFLZXkgfHwgZS5zaGlmdEtleSkpIHsKICAgICAgd2luZG93Lm9wZW4oaG9va3MudGhyZWFkVXJsKGlkKSwgJ19ibGFuaycsICdub29wZW5lcicpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjbG9zZSgpOwogICAgaG9va3Mub3BlblRocmVhZChpZCk7CiAgfQoKICBmdW5jdGlvbiBjb2x1bW5PZihpZCkgewogICAgcmV0dXJuIFMuY29sdW1ucy5maW5kKGMgPT4gKFMubGlzdHNbYy5pZF0gfHwgW10pLmluY2x1ZGVzKGlkKSkgfHwgbnVsbDsKICB9CgogIGZ1bmN0aW9uIGNhcmRUaXRsZShpZCkgewogICAgcmV0dXJuIGxvZ2ljLmRpc3BsYXlUaXRsZShzdG9yZS50aHJlYWQoaWQpLCBTLmVkaXRzLmdldChpZCkpOwogIH0KCiAgZnVuY3Rpb24gb3BlbkNhcmRNZW51KGFuY2hvciwgaWQsIGNvbElkKSB7CiAgICBjb25zdCBsaXN0ID0gUy5saXN0c1tjb2xJZF0gfHwgW107CiAgICBjb25zdCBhdCA9IGxpc3QuaW5kZXhPZihpZCk7CiAgICBvcGVuTWVudShyb290LCBhbmNob3IsIFsKICAgICAgeyBsYWJlbDogJ09wZW4gaW4gR21haWwnLCBpY29uOiAnb3BlbicsIGtleTogJ29wZW4nLCBvblNlbGVjdDogKCkgPT4gb3BlblRocmVhZChpZCkgfSwKICAgICAgeyBsYWJlbD",
"ogJ0VkaXQgY2FyZOKApicsIGljb246ICdlZGl0Jywga2V5OiAnZWRpdCcsIG9uU2VsZWN0OiAoKSA9PiBvcGVuRWRpdG9yKGlkKSB9LAogICAgICB7IHNlcGFyYXRvcjogdHJ1ZSB9LAogICAgICAvLyBSZW9yZGVyaW5nIGlzIGEgZHJhZyBvdGhlcndpc2U7IHRoZXNlIGtlZXAgaXQgd2l0aGluIHJlYWNoIG9mIHRoZQogICAgICAvLyBrZXlib2FyZC4gRm9jdXMgcmV0dXJucyB0byB0aGlzIGNhcmQncyBtZW51IGJ1dHRvbiBhZnRlcndhcmRzLCBzbwogICAgICAvLyByZXBlYXRlZCBwcmVzc2VzIGtlZXAgbW92aW5nIHRoZSBzYW1lIGNhcmQuCiAgICAgIHsgbGFiZWw6ICdNb3ZlIHVwJywgaWNvbjogJ3VwJywga2V5OiAndXAnLCBkaXNhYmxlZDogYXQgPD0gMCwgb25TZWxlY3Q6ICgpID0-IG1vdmVUaHJlYWQoaWQsIGNvbElkLCBjb2xJZCwgYXQgLSAxKSB9LAogICAgICB7IGxhYmVsOiAnTW92ZSBkb3duJywgaWNvbjogJ2Rvd24nLCBrZXk6ICdkb3duJywgZGlzYWJsZWQ6IGF0IDwgMCB8fCBhdCA-PSBsaXN0Lmxlbmd0aCAtIDEsIG9uU2VsZWN0OiAoKSA9PiBtb3ZlVGhyZWFkKGlkLCBjb2xJZCwgY29sSWQsIGF0ICsgMSkgfSwKICAgICAgeyBzZXBhcmF0b3I6IHRydWUgfSwKICAgICAgeyBoZWFkaW5nOiAnTW92ZSB0bycgfSwKICAgICAgLi4uUy5jb2x1bW5zLm1hcChjID0-ICh7CiAgICAgICAgbGFiZWw6IGMudGl0bGUsCiAgICAgICAgY2hlY2tlZDogYy5pZCA9PT0gY29sSWQsCiAgICAgICAgZGlzYWJsZWQ6IG",
"MuaWQgPT09IGNvbElkLAogICAgICAgIGtleTogYG1vdmU6JHtjLmlkfWAsCiAgICAgICAgb25TZWxlY3Q6ICgpID0-IG1vdmVUaHJlYWQoaWQsIGNvbElkLCBjLmlkLCAwKSwKICAgICAgfSkpLAogICAgICB7IHNlcGFyYXRvcjogdHJ1ZSB9LAogICAgICB7IGxhYmVsOiAnUmVtb3ZlIGZyb20gYm9hcmQnLCBpY29uOiAncmVtb3ZlJywgZGFuZ2VyOiB0cnVlLCBrZXk6ICdyZW1vdmUnLCBvblNlbGVjdDogKCkgPT4gcmVtb3ZlVGhyZWFkKGlkKSB9LAogICAgXSwgeyBsYWJlbDogYEFjdGlvbnMgZm9yICR7Y2FyZFRpdGxlKGlkKX1gIH0pOwogIH0KCiAgLy8gT3B0aW1pc3RpYzogdGhlIGNhcmQgbW92ZXMgbm93LCBhbmQgb25seSB0aGlzIGNhcmQgbW92ZXMgYmFjayBpZgogIC8vIEdtYWlsIHJlZnVzZXMgLSBvdGhlciBtb3ZlcyBtYWRlIGluIHRoZSBtZWFudGltZSBhcmUgbGVmdCBhbG9uZS4KICBhc3luYyBmdW5jdGlvbiBtb3ZlVGhyZWFkKGlkLCBmcm9tQ29sLCB0b0NvbCwgaW5kZXgpIHsKICAgIGNvbnN0IGZyb20gPSBTLmxpc3RzW2Zyb21Db2xdIHx8IFtdOwogICAgY29uc3Qgb3JpZ2luYWxJbmRleCA9IGZyb20uaW5kZXhPZihpZCk7CgogICAgaWYgKGZyb21Db2wgPT09IHRvQ29sKSB7CiAgICAgIFMubGlzdHNbdG9Db2xdID0gbG9naWMucGxhY2VJZChmcm9tLCBpZCwgaW5kZXgpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKICAgICAgcmVuZGVyKCk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBjb25zdCB0YX",
"JnZXQgPSBTLmNvbHVtbnMuZmluZChjID0-IGMuaWQgPT09IHRvQ29sKTsKICAgIFMubGlzdHNbZnJvbUNvbF0gPSBmcm9tLmZpbHRlcih4ID0-IHggIT09IGlkKTsKICAgIFMubGlzdHNbdG9Db2xdID0gbG9naWMucGxhY2VJZChTLmxpc3RzW3RvQ29sXSwgaWQsIGluZGV4KTsKICAgIHBlcnNpc3RPcmRlcigpOwogICAgcmVuZGVyKCk7CiAgICBhbm5vdW5jZShgTW92ZWQgdG8gJHt0YXJnZXQudGl0bGV9JHt0YXJnZXQuYXJjaGl2ZU9uRHJvcCA_ICcgYW5kIGFyY2hpdmVkJyA6ICcnfS5gKTsKICAgIC8vIFdpdGggdGhlIGNhcmQncyBtb3ZlLCBub3QgR21haWwncyBhbnN3ZXIsIHNvIHRoZSB0d28gZ28gdG9nZXRoZXIuIElmCiAgICAvLyBHbWFpbCByZWZ1c2VzLCB0aGUgY2FyZCBnb2luZyBiYWNrIGFuZCB0aGUgdG9hc3Qgc2F5IHNvLgogICAgaWYgKHRhcmdldC5jaGltZSkgY2hpbWUoKTsKCiAgICB0cnkgewogICAgICBhd2FpdCBzdG9yZS5tb3ZlVG9Db2x1bW4oaWQsIFMuY29sdW1ucywgdG9Db2wsICdib2FyZCcpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIFMubGlzdHNbdG9Db2xdID0gKFMubGlzdHNbdG9Db2xdIHx8IFtdKS5maWx0ZXIoeCA9PiB4ICE9PSBpZCk7CiAgICAgIGlmIChTLmxpc3RzW2Zyb21Db2xdKSBTLmxpc3RzW2Zyb21Db2xdID0gbG9naWMucGxhY2VJZChTLmxpc3RzW2Zyb21Db2xdLCBpZCwgTWF0aC5tYXgoMCwgb3JpZ2luYWxJbmRleCkpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKIC",
"AgICAgcmVuZGVyKCk7CiAgICAgIGZhaWxUb2FzdCgnbW92ZScsIGlkLCBlcnIpOwogICAgfQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcmVtb3ZlVGhyZWFkKGlkKSB7CiAgICBjb25zdCBjb2wgPSBjb2x1bW5PZihpZCk7CiAgICBpZiAoIWNvbCkgcmV0dXJuOwogICAgY29uc3Qgb3JpZ2luYWxJbmRleCA9IFMubGlzdHNbY29sLmlkXS5pbmRleE9mKGlkKTsKICAgIFMubGlzdHNbY29sLmlkXSA9IFMubGlzdHNbY29sLmlkXS5maWx0ZXIoeCA9PiB4ICE9PSBpZCk7CiAgICBwZXJzaXN0T3JkZXIoKTsKICAgIHJlbmRlcigpOwogICAgYW5ub3VuY2UoJ1JlbW92ZWQgZnJvbSB0aGUgYm9hcmQuJyk7CiAgICB0cnkgewogICAgICBhd2FpdCBzdG9yZS5yZW1vdmVGcm9tQm9hcmQoaWQsIFMuY29sdW1ucywgJ2JvYXJkJywgUy5hY2NvdW50KTsKICAgICAgUy5lZGl0cy5kZWxldGUoaWQpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIFMubGlzdHNbY29sLmlkXSA9IGxvZ2ljLnBsYWNlSWQoUy5saXN0c1tjb2wuaWRdLCBpZCwgb3JpZ2luYWxJbmRleCk7CiAgICAgIHBlcnNpc3RPcmRlcigpOwogICAgICByZW5kZXIoKTsKICAgICAgZmFpbFRvYXN0KCdyZW1vdmUnLCBpZCwgZXJyKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGZhaWxUb2FzdCh2ZXJiLCBpZCwgZXJyKSB7CiAgICBjb25zdCBvcHRzID0geyBraW5kOiAnZXJyb3InIH07CiAgICBpZiAoZXJyLmNvZGUgPT09ICdhdXRoX3JlcXVpcmVkJykgb3B0cy5hY3Rpb24gPS",
"B7IGxhYmVsOiAnQ29ubmVjdCcsIG9uQ2xpY2s6ICgpID0-IGNvbm5lY3QoKSB9OwogICAgdG9hc3Qocm9vdCwgYENvdWxkbuKAmXQgJHt2ZXJifSDigJwke3N0b3JlLnRocmVhZChpZCkgPyBjYXJkVGl0bGUoaWQpIDogJ3RoYXQgdGhyZWFkJ33igJ06ICR7ZXJyLm1lc3NhZ2V9YCwgb3B0cyk7CiAgfQoKICAvLyDilIDilIAgRHJhZyBhbmQgZHJvcCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgZnVuY3Rpb24gb25EcmFnU3RhcnQoZSwgaWQsIGNvbElkLCBjYXJkKSB7CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBjb25zdCBwbGFjZWhvbGRlciA9IGgoJ2RpdicsIHsgY2xhc3M6ICdwbGFjZWhvbGRlcicsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KTsKICAgIHBsYWNlaG9sZGVyLnN0eWxlLmhlaWdodCA9IGAke2NhcmQub2Zmc2V0SGVpZ2h0fXB4YDsKICAgIFMuZHJhZyA9IHsgaWQsIGZyb21Db2w6IGNvbElkLCBjYXJkLCBwbGFjZWhvbGRlciB9OwogICAgZS5kYXRhVHJhbnNmZXIuZWZmZWN0QWxsb3dlZCA9ICdtb3ZlJzsKICAgIC8vIEEgcHJpdmF0ZSB0eXBlLCBzbyBkcm9wcGluZyBhIGNhcmQgb24gR21haWwncyBjb21wb3NlIGJveCBkb2VzIG5vdAogICAgLy8gcGFzdGUgYS",
"B0aHJlYWQgaWQgaW50byBhbiBlbWFpbC4KICAgIGUuZGF0YVRyYW5zZmVyLnNldERhdGEoRFJBR19UWVBFLCBpZCk7CiAgICBjYXJkLmNsYXNzTGlzdC5hZGQoJ2xpZnRpbmcnKTsKICAgIC8vIEhpZGUgdGhlIGNhcmQgb25seSBhZnRlciB0aGUgYnJvd3NlciBoYXMgY2FwdHVyZWQgaXQgYXMgdGhlIGRyYWcKICAgIC8vIGltYWdlOyBoaWRpbmcgaXQgc3luY2hyb25vdXNseSBjYW5jZWxzIHRoZSBkcmFnIGluIENocm9tZS4KICAgIHNldFRpbWVvdXQoKCkgPT4gewogICAgICBpZiAoIVMuZHJhZyB8fCBTLmRyYWcuY2FyZCAhPT0gY2FyZCkgcmV0dXJuOwogICAgICBjYXJkLnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKHBsYWNlaG9sZGVyLCBjYXJkKTsKICAgICAgY2FyZC5jbGFzc0xpc3QuYWRkKCdkcmFnZ2luZycpOwogICAgfSwgMCk7CiAgfQoKICBmdW5jdGlvbiBkcm9wSW5kZXgobGlzdCwgeSkgewogICAgY29uc3QgY2FyZHMgPSBbLi4ubGlzdC5xdWVyeVNlbGVjdG9yQWxsKCc6c2NvcGUgPiAuY2FyZDpub3QoLmRyYWdnaW5nKScpXTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY2FyZHMubGVuZ3RoOyBpKyspIHsKICAgICAgY29uc3QgciA9IGNhcmRzW2ldLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgICBpZiAoeSA8IHIudG9wICsgci5oZWlnaHQgLyAyKSByZXR1cm4gaTsKICAgIH0KICAgIHJldHVybiBjYXJkcy5sZW5ndGg7CiAgfQoKICBmdW5jdGlvbiBvbkRyYWdPdmVyKGUpIHsKICAgIGlmICghUy",
"5kcmFnKSByZXR1cm47CiAgICBjb25zdCBzZWN0aW9uID0gZS50YXJnZXQuY2xvc2VzdCAmJiBlLnRhcmdldC5jbG9zZXN0KCcuY29sdW1uJyk7CiAgICBjb25zdCBwaCA9IFMuZHJhZy5wbGFjZWhvbGRlcjsKICAgIGlmICghc2VjdGlvbikgewogICAgICBwaC5yZW1vdmUoKTsKICAgICAgbWFya1RhcmdldChudWxsKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgZS5kYXRhVHJhbnNmZXIuZHJvcEVmZmVjdCA9ICdtb3ZlJzsKICAgIGNvbnN0IGxpc3QgPSBzZWN0aW9uLnF1ZXJ5U2VsZWN0b3IoJy5saXN0Jyk7CiAgICBjb25zdCBpZHggPSBkcm9wSW5kZXgobGlzdCwgZS5jbGllbnRZKTsKICAgIGNvbnN0IGNhcmRzID0gWy4uLmxpc3QucXVlcnlTZWxlY3RvckFsbCgnOnNjb3BlID4gLmNhcmQ6bm90KC5kcmFnZ2luZyknKV07CiAgICBjb25zdCByZWYgPSBjYXJkc1tpZHhdIHx8IG51bGw7CiAgICBpZiAocmVmKSB7CiAgICAgIGlmIChyZWYucHJldmlvdXNFbGVtZW50U2libGluZyAhPT0gcGgpIGxpc3QuaW5zZXJ0QmVmb3JlKHBoLCByZWYpOwogICAgfSBlbHNlIGlmIChsaXN0Lmxhc3RFbGVtZW50Q2hpbGQgIT09IHBoKSB7CiAgICAgIGxpc3QuYXBwZW5kQ2hpbGQocGgpOwogICAgfQogICAgbWFya1RhcmdldChzZWN0aW9uKTsKICB9CgogIGZ1bmN0aW9uIG9uRHJvcChlKSB7CiAgICBpZiAoIVMuZHJhZykgcmV0dXJuOwogICAgY29uc3Qgc2VjdGlvbiA9IGUudGFyZ2V0Lm",
"Nsb3Nlc3QgJiYgZS50YXJnZXQuY2xvc2VzdCgnLmNvbHVtbicpOwogICAgaWYgKCFzZWN0aW9uKSByZXR1cm47CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBjb25zdCBpZHggPSBkcm9wSW5kZXgoc2VjdGlvbi5xdWVyeVNlbGVjdG9yKCcubGlzdCcpLCBlLmNsaWVudFkpOwogICAgY29uc3QgeyBpZCwgZnJvbUNvbCB9ID0gUy5kcmFnOwogICAgZW5kRHJhZyhmYWxzZSk7CiAgICBtb3ZlVGhyZWFkKGlkLCBmcm9tQ29sLCBzZWN0aW9uLmRhdGFzZXQuY29sLCBpZHgpOwogIH0KCiAgZnVuY3Rpb24gb25EcmFnRW5kKCkgewogICAgaWYgKFMuZHJhZykgZW5kRHJhZyh0cnVlKTsKICB9CgogIGZ1bmN0aW9uIGVuZERyYWcoY2FuY2VsbGVkKSB7CiAgICBjb25zdCBkID0gUy5kcmFnOwogICAgUy5kcmFnID0gbnVsbDsKICAgIGQucGxhY2Vob2xkZXIucmVtb3ZlKCk7CiAgICBkLmNhcmQuY2xhc3NMaXN0LnJlbW92ZSgnZHJhZ2dpbmcnLCAnbGlmdGluZycpOwogICAgbWFya1RhcmdldChudWxsKTsKICAgIGlmIChjYW5jZWxsZWQgfHwgUy5yZW5kZXJEZWZlcnJlZCkgewogICAgICBTLnJlbmRlckRlZmVycmVkID0gZmFsc2U7CiAgICAgIHJlbmRlcigpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gbWFya1RhcmdldChzZWN0aW9uKSB7CiAgICBmb3IgKGNvbnN0IHMgb2YgZWxzLmJvZHkucXVlcnlTZWxlY3RvckFsbCgnLmNvbHVtbi5kcm9wLXRhcmdldCcpKSB7CiAgICAgIGlmIChzICE9PSBzZWN0aW9uKSBzLmNsYXNzTG",
"lzdC5yZW1vdmUoJ2Ryb3AtdGFyZ2V0Jyk7CiAgICB9CiAgICBpZiAoc2VjdGlvbikgc2VjdGlvbi5jbGFzc0xpc3QuYWRkKCdkcm9wLXRhcmdldCcpOwogIH0KCiAgLy8g4pSA4pSAIENvbHVtbiBzZWFyY2ggKCIrIikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgogIGxldCBzZWFyY2hUaW1lciA9IDA7CgogIGZ1bmN0aW9uIHRvZ2dsZVNlYXJjaChjb2xJZCkgewogICAgaWYgKFMuc2VhcmNoICYmIFMuc2VhcmNoLmNvbElkID09PSBjb2xJZCkgewogICAgICBjbG9zZVNlYXJjaCgpOwogICAgICByZXR1cm47CiAgICB9CiAgICBTLnNlYXJjaCA9IHsgY29sSWQsIHF1ZXJ5OiAnJywgaWRzOiBudWxsLCBsb2FkaW5nOiBmYWxzZSwgZXJyb3I6ICcnLCBzZXE6IDAgfTsKICAgIHJlbmRlcigpOwogICAgY29uc3QgaW5wdXQgPSBlbHMuYm9keS5xdWVyeVNlbGVjdG9yKCcuc2VhcmNoIGlucHV0Jyk7CiAgICBpZiAoaW5wdXQpIGlucHV0LmZvY3VzKCk7CiAgICBydW5TZWFyY2goKTsKICB9CgogIGZ1bmN0aW9uIGNsb3NlU2VhcmNoKCkgewogICAgaWYgKCFTLnNlYXJjaCkgcmV0dXJuOwogICAgY29uc3QgY29sSWQgPSBTLnNlYXJjaC5jb2xJZDsKICAgIFMuc2VhcmNoID0gbnVsbDsKICAgIGNsZWFyVGltZW91dChzZWFyY2",
"hUaW1lcik7CiAgICByZW5kZXIoKTsKICAgIHJlc3RvcmVGb2N1cyhgYWRkOiR7Y29sSWR9YCwgZWxzLmJvZHkpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyU2VhcmNoKGNvbCkgewogICAgY29uc3QgcyA9IFMuc2VhcmNoOwogICAgY29uc3QgaW5wdXQgPSBoKCdpbnB1dCcsIHsKICAgICAgdHlwZTogJ3NlYXJjaCcsCiAgICAgIHBsYWNlaG9sZGVyOiAnU2VhcmNoIG1haWwsIGUuZy4gZnJvbTphbm5hIGlzOnVucmVhZCcsCiAgICAgICdhcmlhLWxhYmVsJzogYFNlYXJjaCBHbWFpbCBmb3IgYSB0aHJlYWQgdG8gYWRkIHRvICR7Y29sLnRpdGxlfWAsCiAgICAgIHZhbHVlOiBzLnF1ZXJ5LAogICAgICBkYXRhc2V0OiB7IGtleTogYHNlYXJjaDoke2NvbC5pZH1gIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4gewogICAgICAgIHMucXVlcnkgPSBlLnRhcmdldC52YWx1ZTsKICAgICAgICBjbGVhclRpbWVvdXQoc2VhcmNoVGltZXIpOwogICAgICAgIHNlYXJjaFRpbWVyID0gc2V0VGltZW91dChydW5TZWFyY2gsIDQ1MCk7CiAgICAgIH0sCiAgICAgIG9ua2V5ZG93bjogZSA9PiB7CiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInKSB7IGUucHJldmVudERlZmF1bHQoKTsgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVyKTsgcnVuU2VhcmNoKCk7IH0KICAgICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSB7IGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgY2xvc2VTZWFyY2goKTsgfQogICAgICB9LAogIC",
"AgfSk7CiAgICBlbHMucmVzdWx0cyA9IGgoJ2RpdicsIHsgY2xhc3M6ICdyZXN1bHRzJywgcm9sZTogJ2xpc3QnLCAnYXJpYS1sYWJlbCc6ICdTZWFyY2ggcmVzdWx0cycsICdhcmlhLWJ1c3knOiBTdHJpbmcocy5sb2FkaW5nKSB9KTsKICAgIGZpbGxSZXN1bHRzKHRydWUpOwogICAgcmV0dXJuIGgoJ2RpdicsIHsgY2xhc3M6ICdzZWFyY2gnLCByb2xlOiAnc2VhcmNoJyB9LAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnc2VhcmNoLWJveCcgfSwgaWNvbignc2VhcmNoJywgMTgpLCBpbnB1dCksCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdzZWFyY2gtaGludCcsIHRleHQ6ICdHbWFpbCBzZWFyY2ggc3ludGF4LiBMZWF2ZSBpdCBlbXB0eSB0byBsaXN0IHlvdXIgSW5ib3guJyB9KSwKICAgICAgZWxzLnJlc3VsdHMpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gcnVuU2VhcmNoKCkgewogICAgY29uc3QgcyA9IFMuc2VhcmNoOwogICAgaWYgKCFzKSByZXR1cm47CiAgICBjb25zdCBzZXEgPSArK3Muc2VxOwogICAgcy5sb2FkaW5nID0gdHJ1ZTsKICAgIGZpbGxSZXN1bHRzKCk7CiAgICB0cnkgewogICAgICBjb25zdCBpZHMgPSBhd2FpdCBzdG9yZS5zZWFyY2gocy5xdWVyeSwgUy5hY2NvdW50KTsKICAgICAgaWYgKFMuc2VhcmNoICE9PSBzIHx8IHNlcSAhPT0gcy5zZXEpIHJldHVybjsKICAgICAgcy5pZHMgPSBpZHM7CiAgICAgIHMuZXJyb3IgPSAnJzsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAoUy5zZWFyY2",
"ggIT09IHMgfHwgc2VxICE9PSBzLnNlcSkgcmV0dXJuOwogICAgICBpZiAoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHsKICAgICAgICBoYW5kbGVFcnJvcihlcnIpOwogICAgICAgIHJlbmRlcigpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBzLmlkcyA9IFtdOwogICAgICBzLmVycm9yID0gZXJyLm1lc3NhZ2U7CiAgICB9CiAgICBzLmxvYWRpbmcgPSBmYWxzZTsKICAgIGZpbGxSZXN1bHRzKCk7CiAgfQoKICAvLyBgYnVpbGRpbmdgIGlzIHRydWUgd2hpbGUgdGhlIHBhbmVsIGlzIGJlaW5nIGNyZWF0ZWQgYW5kIGlzIG5vdCB5ZXQgaW4KICAvLyB0aGUgZG9jdW1lbnQ7IG90aGVyd2lzZSBhIGRldGFjaGVkIGJveCBtZWFucyBhbiBhc3luYyBzZWFyY2ggZmluaXNoZWQKICAvLyBhZnRlciBpdHMgcGFuZWwgd2FzIGNsb3NlZCwgYW5kIHRoZXJlIGlzIG5vdGhpbmcgdG8gZmlsbC4KICBmdW5jdGlvbiBmaWxsUmVzdWx0cyhidWlsZGluZyA9IGZhbHNlKSB7CiAgICBjb25zdCBzID0gUy5zZWFyY2g7CiAgICBjb25zdCBib3ggPSBlbHMucmVzdWx0czsKICAgIGlmICghcyB8fCAhYm94IHx8ICghYnVpbGRpbmcgJiYgIWJveC5pc0Nvbm5lY3RlZCkpIHJldHVybjsKICAgIGJveC5zZXRBdHRyaWJ1dGUoJ2FyaWEtYnVzeScsIFN0cmluZyhzLmxvYWRpbmcpKTsKCiAgICBpZiAocy5pZHMgPT09IG51bGwgfHwgKHMubG9hZGluZyAmJiAhcy5pZHMubGVuZ3RoKSkgewogICAgICBib3gucmVwbGFjZUNoaW",
"xkcmVuKGgoJ2RpdicsIHsgY2xhc3M6ICdyZXN1bHRzLWVtcHR5JywgdGV4dDogJ1NlYXJjaGluZ-KApicgfSkpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAocy5lcnJvcikgewogICAgICBib3gucmVwbGFjZUNoaWxkcmVuKGgoJ2RpdicsIHsgY2xhc3M6ICdyZXN1bHRzLWVtcHR5JywgdGV4dDogYFNlYXJjaCBmYWlsZWQ6ICR7cy5lcnJvcn1gIH0pKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKCFzLmlkcy5sZW5ndGgpIHsKICAgICAgYm94LnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAncmVzdWx0cy1lbXB0eScsIHRleHQ6ICdObyB0aHJlYWRzIG1hdGNoLicgfSkpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3QgdGFyZ2V0ID0gUy5jb2x1bW5zLmZpbmQoYyA9PiBjLmlkID09PSBzLmNvbElkKTsKICAgIGJveC5yZXBsYWNlQ2hpbGRyZW4oLi4ucy5pZHMubWFwKGlkID0-IHsKICAgICAgY29uc3QgdCA9IHN0b3JlLnRocmVhZChpZCk7CiAgICAgIGNvbnN0IHdoZXJlID0gY29sdW1uT2YoaWQpOwogICAgICBjb25zdCBoZXJlID0gd2hlcmUgJiYgd2hlcmUuaWQgPT09IHMuY29sSWQ7CiAgICAgIHJldHVybiBoKCdidXR0b24nLCB7CiAgICAgICAgY2xhc3M6ICdyZXN1bHQnLCB0eXBlOiAnYnV0dG9uJywgcm9sZTogJ2xpc3RpdGVtJywgZGlzYWJsZWQ6IGhlcmUsCiAgICAgICAgZGF0YXNldDogeyBrZXk6IGByZXN1bHQ6JHtpZH1gLCBpZCB9LAogICAgICAgIHRpdGxlOiBoZX",
"JlID8gJycgOiBgQWRkIHRvICR7dGFyZ2V0ID8gdGFyZ2V0LnRpdGxlIDogJ3RoaXMgY29sdW1uJ31gLAogICAgICAgIG9uY2xpY2s6ICgpID0-IGFkZEZyb21TZWFyY2goaWQsIHMuY29sSWQpLAogICAgICB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnci10b3AnIH0sCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2Zyb20nLCB0ZXh0OiB0LmZyb20gfSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3NwYWNlcicgfSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ2RhdGUnLCB0ZXh0OiB1dGlsLnJlbGF0aXZlRGF0ZSh0LnRzKSB9KSksCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdyLXN1YmplY3QnLCB0ZXh0OiBsb2dpYy5kaXNwbGF5VGl0bGUodCwgUy5lZGl0cy5nZXQoaWQpKSB9KSwKICAgICAgICB3aGVyZSA_IGgoJ3NwYW4nLCB7IGNsYXNzOiAnci13aGVyZScsIHRleHQ6IGhlcmUgPyAnQWxyZWFkeSBpbiB0aGlzIGNvbHVtbicgOiBgSW4gJHt3aGVyZS50aXRsZX0gwrcgbW92ZXMgaGVyZWAgfSkgOiBudWxsKTsKICAgIH0pKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIGFkZEZyb21TZWFyY2goaWQsIGNvbElkKSB7CiAgICBjb25zdCB3aGVyZSA9IGNvbHVtbk9mKGlkKTsKICAgIGlmICh3aGVyZSAmJiB3aGVyZS5pZCA9PT0gY29sSWQpIHJldHVybjsKICAgIGlmICh3aGVyZSkgewogICAgICBtb3ZlVGhyZWFkKGlkLCB3aGVyZS5pZCwgY29sSWQsIDApOwogICAgICByZX",
"R1cm47CiAgICB9CiAgICBjb25zdCB0YXJnZXQgPSBTLmNvbHVtbnMuZmluZChjID0-IGMuaWQgPT09IGNvbElkKTsKICAgIFMubGlzdHNbY29sSWRdID0gbG9naWMucGxhY2VJZChTLmxpc3RzW2NvbElkXSwgaWQsIDApOwogICAgcGVyc2lzdE9yZGVyKCk7CiAgICByZW5kZXIoKTsKICAgIGFubm91bmNlKGBBZGRlZCB0byAke3RhcmdldC50aXRsZX0uYCk7CiAgICBpZiAodGFyZ2V0LmNoaW1lKSBjaGltZSgpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgc3RvcmUubW92ZVRvQ29sdW1uKGlkLCBTLmNvbHVtbnMsIGNvbElkLCAnYm9hcmQnKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBTLmxpc3RzW2NvbElkXSA9IChTLmxpc3RzW2NvbElkXSB8fCBbXSkuZmlsdGVyKHggPT4geCAhPT0gaWQpOwogICAgICBwZXJzaXN0T3JkZXIoKTsKICAgICAgcmVuZGVyKCk7CiAgICAgIGZhaWxUb2FzdCgnYWRkJywgaWQsIGVycik7CiAgICB9CiAgfQoKICAvLyDilIDilIAgQ29sdW1uIHNldHRpbmdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKICBmdW5jdGlvbiBvcGVuRHJhd2VyKCkgewogICAgaWYgKFMuc3RhdHVzICE9PSAncmVhZHknKSByZXR1cm47CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBTLm",
"RyYXdlciA9IHsKICAgICAgZHJhZnQ6IFMuY29sdW1ucy5tYXAoYyA9PiAoeyAuLi5jLCBvcmlnTGFiZWw6IGMubGFiZWwsIGlzTmV3OiBmYWxzZSwgbGFiZWxUb3VjaGVkOiB0cnVlIH0pKSwKICAgICAgZXJyb3I6ICcnLAogICAgICBzYXZpbmc6IGZhbHNlLAogICAgfTsKICAgIHJlbmRlckRyYXdlcigndGl0bGU6MCcpOwogIH0KCiAgZnVuY3Rpb24gY2xvc2VEcmF3ZXIoKSB7CiAgICBpZiAoIVMuZHJhd2VyKSByZXR1cm47CiAgICBTLmRyYXdlciA9IG51bGw7CiAgICByZW5kZXJEcmF3ZXIoKTsKICAgIGlmIChTLm9wZW4pIGVscy5zZXR0aW5ncy5mb2N1cygpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRHJhd2VyKGZvY3VzKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXI7CiAgICBpZiAoIWQpIHsKICAgICAgZWxzLmRyYXdlckxheWVyLnJlcGxhY2VDaGlsZHJlbigpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBrZXkgPSBmb2N1cyB8fCBmb2N1c0tleSgpOwoKICAgIGNvbnN0IGRyYXdlciA9IGgoJ2FzaWRlJywgewogICAgICBjbGFzczogJ2RyYXdlcicsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1tb2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6ICdna2ItZHJhd2VyLXRpdGxlJywKICAgIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkcmF3ZXItaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItZHJhd2VyLXRpdGxlJywgdGV4dDogJ0NvbHVtbnMnIH0pLAogICAgICAgIGgoJ2",
"J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOiAnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiAnQ2xvc2UgY29sdW1uIHNldHRpbmdzJywgb25jbGljazogY2xvc2VEcmF3ZXIsCiAgICAgICAgfSwgaWNvbignY2xvc2UnKSkpLAogICAgICBoKCdwJywgewogICAgICAgIGNsYXNzOiAnZHJhd2VyLWludHJvJywKICAgICAgICB0ZXh0OiAnRWFjaCBjb2x1bW4gaXMgYSBHbWFpbCBsYWJlbC4gUmVuYW1pbmcgYSBsYWJlbCBoZXJlIHJlbmFtZXMgaXQgaW4gR21haWwsIHNvIHRoZSBtYWlsIGZpbGVkIHVuZGVyIGl0IHN0YXlzIHB1dC4nLAogICAgICB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RyYXdlci1ib2R5JyB9LAogICAgICAgIGQuZHJhZnQubWFwKChjLCBpKSA9PiByZW5kZXJEcmFmdFJvdyhjLCBpKSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdhZGQtY29sJywgdHlwZTogJ2J1dHRvbicsIGRhdGFzZXQ6IHsga2V5OiAnYWRkLWNvbCcgfSwgb25jbGljazogYWRkRHJhZnRDb2x1bW4sCiAgICAgICAgfSwgJysgQWRkIGNvbHVtbicpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2Zvcm0tZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBkLmVycm9yIH0pLAogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZHJhd2VyLWZvb3QnIH0sCiAgICAgICAgaCgnc3BhbicsIHsKICAgICAgICAgIGNsYXNzOiAnbm90ZScsCiAgICAgICAgICB0ZXh0OiAnUmVtb3",
"ZpbmcgYSBjb2x1bW4gb25seSB0YWtlcyBpdCBvZmYgdGhlIGJvYXJkLiBJdHMgR21haWwgbGFiZWwsIGFuZCB0aGUgbWFpbCBpbiBpdCwgYXJlIGxlZnQgdW50b3VjaGVkLicsCiAgICAgICAgfSksCiAgICAgICAgaCgnYnV0dG9uJywgeyBjbGFzczogJ2J0biBidG4tdGV4dCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnQ2FuY2VsJywgb25jbGljazogY2xvc2VEcmF3ZXIgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdidG4gYnRuLXByaW1hcnknLCB0eXBlOiAnYnV0dG9uJywgZGlzYWJsZWQ6IGQuc2F2aW5nLCBkYXRhc2V0OiB7IGtleTogJ3NhdmUnIH0sCiAgICAgICAgICB0ZXh0OiBkLnNhdmluZyA_ICdTYXZpbmfigKYnIDogJ1NhdmUnLCBvbmNsaWNrOiBzYXZlRHJhd2VyLAogICAgICAgIH0pKSk7CgogICAgZWxzLmRyYXdlckxheWVyLnJlcGxhY2VDaGlsZHJlbihoKCdkaXYnLCB7IGNsYXNzOiAnc2NyaW0nLCBvbmNsaWNrOiBjbG9zZURyYXdlciB9KSwgZHJhd2VyKTsKICAgIHJlc3RvcmVGb2N1cyhrZXksIGVscy5kcmF3ZXJMYXllcik7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJEcmFmdFJvdyhjLCBpKSB7CiAgICBjb25zdCBuID0gUy5kcmF3ZXIuZHJhZnQubGVuZ3RoOwogICAgY29uc3Qgcm93VGl0bGUgPSBoKCdzcGFuJywgeyBjbGFzczogJ3Jvdy10aXRsZScsIHRleHQ6IGMudGl0bGUgfHwgJ05ldyBjb2x1bW4nIH0pOwogICAgY29uc3QgaGVscCA9IGgoJ3NwYW4nLCB7IG",
"NsYXNzOiAnZmllbGQtaGVscCcgfSk7CiAgICBjb25zdCBzZXRIZWxwID0gKCkgPT4gewogICAgICBoZWxwLnRleHRDb250ZW50ID0gYy5pc05ldwogICAgICAgID8gJ0NyZWF0ZWQgaW4gR21haWwgd2hlbiB5b3Ugc2F2ZS4nCiAgICAgICAgOiBjLmxhYmVsLnRyaW0oKSAhPT0gYy5vcmlnTGFiZWwgPyBgUmVuYW1lcyDigJwke2Mub3JpZ0xhYmVsfeKAnSBpbiBHbWFpbCB3aGVuIHlvdSBzYXZlLmAgOiAnJzsKICAgIH07CiAgICBzZXRIZWxwKCk7CgogICAgY29uc3QgbGFiZWxJbnB1dCA9IGgoJ2lucHV0JywgewogICAgICBjbGFzczogJ3RleHQtaW5wdXQnLCB0eXBlOiAndGV4dCcsIHZhbHVlOiBjLmxhYmVsLCBzcGVsbGNoZWNrOiAnZmFsc2UnLAogICAgICBkYXRhc2V0OiB7IGtleTogYGxhYmVsOiR7aX1gIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBjLmxhYmVsID0gZS50YXJnZXQudmFsdWU7IGMubGFiZWxUb3VjaGVkID0gdHJ1ZTsgc2V0SGVscCgpOyB9LAogICAgfSk7CiAgICBjb25zdCB0aXRsZUlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGMudGl0bGUsCiAgICAgIGRhdGFzZXQ6IHsga2V5OiBgdGl0bGU6JHtpfWAgfSwKICAgICAgb25pbnB1dDogZSA9PiB7CiAgICAgICAgYy50aXRsZSA9IGUudGFyZ2V0LnZhbHVlOwogICAgICAgIHJvd1RpdGxlLnRleHRDb250ZW50ID0gYy50aXRsZSB8fCAnTmV3IGNvbHVtbic7CiAgICAgIC",
"AgLy8gQSBuZXcgY29sdW1uJ3MgbGFiZWwgZm9sbG93cyBpdHMgdGl0bGUgdW50aWwgZWRpdGVkIGJ5IGhhbmQuCiAgICAgICAgaWYgKGMuaXNOZXcgJiYgIWMubGFiZWxUb3VjaGVkKSB7CiAgICAgICAgICBjLmxhYmVsID0gYCR7Yy5yb290fS8ke2MudGl0bGUudHJpbSgpfWA7CiAgICAgICAgICBsYWJlbElucHV0LnZhbHVlID0gYy5sYWJlbDsKICAgICAgICB9CiAgICAgIH0sCiAgICB9KTsKCiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ2NvbC1yb3cnLCBkYXRhc2V0OiB7IHJvdzogU3RyaW5nKGkpIH0gfSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ3Jvdy1oZWFkJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAncm93LW51bScsIHRleHQ6IFN0cmluZyhpICsgMSkgfSksCiAgICAgICAgcm93VGl0bGUsCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6IGBNb3ZlICR7Yy50aXRsZSB8fCAnY29sdW1uJ30gdXBgLCB0aXRsZTogJ01vdmUgdXAgKGZ1cnRoZXIgbGVmdCBvbiB0aGUgYm9hcmQpJywKICAgICAgICAgIGRpc2FibGVkOiBpID09PSAwLCBkYXRhc2V0OiB7IGtleTogYHVwOiR7aX1gIH0sIG9uY2xpY2s6ICgpID0-IG1vdmVEcmFmdChpLCAtMSksCiAgICAgICAgfSwgaWNvbigndXAnLCAxOCkpLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnaWNvbi1idG4nLCB0eXBlOi",
"AnYnV0dG9uJywgJ2FyaWEtbGFiZWwnOiBgTW92ZSAke2MudGl0bGUgfHwgJ2NvbHVtbid9IGRvd25gLCB0aXRsZTogJ01vdmUgZG93biAoZnVydGhlciByaWdodCBvbiB0aGUgYm9hcmQpJywKICAgICAgICAgIGRpc2FibGVkOiBpID09PSBuIC0gMSwgZGF0YXNldDogeyBrZXk6IGBkb3duOiR7aX1gIH0sIG9uY2xpY2s6ICgpID0-IG1vdmVEcmFmdChpLCAxKSwKICAgICAgICB9LCBpY29uKCdkb3duJywgMTgpKSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2ljb24tYnRuJywgdHlwZTogJ2J1dHRvbicsICdhcmlhLWxhYmVsJzogYFJlbW92ZSAke2MudGl0bGUgfHwgJ2NvbHVtbid9IGZyb20gdGhlIGJvYXJkYCwKICAgICAgICAgIHRpdGxlOiAnUmVtb3ZlIGZyb20gYm9hcmQgKGtlZXBzIHRoZSBHbWFpbCBsYWJlbCknLCBkYXRhc2V0OiB7IGtleTogYHJlbW92ZToke2l9YCB9LAogICAgICAgICAgb25jbGljazogKCkgPT4gcmVtb3ZlRHJhZnQoaSksCiAgICAgICAgfSwgaWNvbignY2xvc2UnLCAxOCkpKSwKICAgICAgaCgnbGFiZWwnLCB7IGNsYXNzOiAnZmllbGQnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdmaWVsZC1sYWJlbCcsIHRleHQ6ICdUaXRsZScgfSksCiAgICAgICAgdGl0bGVJbnB1dCksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkJyB9LAogICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCB0ZXh0OiAnR21haWwgbGFiZWwnIH",
"0pLAogICAgICAgIGxhYmVsSW5wdXQsCiAgICAgICAgaGVscCksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2NoZWNrJyB9LAogICAgICAgIGgoJ2lucHV0JywgewogICAgICAgICAgdHlwZTogJ2NoZWNrYm94JywgY2hlY2tlZDogISFjLmFyY2hpdmVPbkRyb3AsIGRhdGFzZXQ6IHsga2V5OiBgYXJjaGl2ZToke2l9YCB9LAogICAgICAgICAgb25jaGFuZ2U6IGUgPT4geyBjLmFyY2hpdmVPbkRyb3AgPSBlLnRhcmdldC5jaGVja2VkOyB9LAogICAgICAgIH0pLAogICAgICAgICdBcmNoaXZlIHRocmVhZHMgbW92ZWQgaGVyZSAodGFrZSB0aGVtIG91dCBvZiB0aGUgSW5ib3gpJyksCiAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2NoZWNrJyB9LAogICAgICAgIGgoJ2lucHV0JywgewogICAgICAgICAgdHlwZTogJ2NoZWNrYm94JywgY2hlY2tlZDogISFjLmNoaW1lLCBkYXRhc2V0OiB7IGtleTogYGNoaW1lOiR7aX1gIH0sCiAgICAgICAgICAvLyBUaWNrZWQsIGl0IHBsYXlzLCBzbyB0aGUgYm94IHNheXMgd2hhdCBpdCBkb2VzLgogICAgICAgICAgb25jaGFuZ2U6IGUgPT4gewogICAgICAgICAgICBjLmNoaW1lID0gZS50YXJnZXQuY2hlY2tlZDsKICAgICAgICAgICAgaWYgKGMuY2hpbWUpIGNoaW1lKCk7CiAgICAgICAgICB9LAogICAgICAgIH0pLAogICAgICAgICdQbGF5IGEgc2hvcnQgY2hpbWUgd2hlbiBhIGNhcmQgaXMgbW92ZWQgaGVyZScpKTsKICB9CgogIGZ1bmN0aW9uIG1vdmVEcmFmdChpLCBkZWx0YS",
"kgewogICAgY29uc3QgZCA9IFMuZHJhd2VyLmRyYWZ0OwogICAgY29uc3QgaiA9IGkgKyBkZWx0YTsKICAgIGlmIChqIDwgMCB8fCBqID49IGQubGVuZ3RoKSByZXR1cm47CiAgICBbZFtpXSwgZFtqXV0gPSBbZFtqXSwgZFtpXV07CiAgICAvLyBLZWVwIGZvY3VzIG9uIHRoZSBzYW1lIGFycm93LCBub3cgb24gdGhlIHJvdydzIG5ldyBwb3NpdGlvbiwgc28KICAgIC8vIHJlcGVhdGVkIHByZXNzZXMga2VlcCBtb3ZpbmcgdGhlIHNhbWUgY29sdW1uLgogICAgY29uc3Qga2V5ID0gZGVsdGEgPCAwID8gKGogPT09IDAgPyBgZG93bjoke2p9YCA6IGB1cDoke2p9YCkgOiAoaiA9PT0gZC5sZW5ndGggLSAxID8gYHVwOiR7an1gIDogYGRvd246JHtqfWApOwogICAgcmVuZGVyRHJhd2VyKGtleSk7CiAgfQoKICBmdW5jdGlvbiByZW1vdmVEcmFmdChpKSB7CiAgICBTLmRyYXdlci5kcmFmdC5zcGxpY2UoaSwgMSk7CiAgICBjb25zdCBuID0gUy5kcmF3ZXIuZHJhZnQubGVuZ3RoOwogICAgcmVuZGVyRHJhd2VyKG4gPyBgdGl0bGU6JHtNYXRoLm1pbihpLCBuIC0gMSl9YCA6ICdhZGQtY29sJyk7CiAgfQoKICBmdW5jdGlvbiBhZGREcmFmdENvbHVtbigpIHsKICAgIGNvbnN0IGQgPSBTLmRyYXdlci5kcmFmdDsKICAgIC8vIFVuZGVyIHdoYXRldmVyIHBhcmVudCB0aGUgY29sdW1ucyBhbHJlYWR5IHNoYXJlICgiX0JvYXJkIiwgb3Igb25lCiAgICAvLyB0aGUgdXNlciBtb3ZlZCB0aGVtIHRvKSwgbm90IGEgaGFyZC1jb2RlZCBvbm",
"UuCiAgICBjb25zdCByb290ID0gbG9naWMubGFiZWxSb290KFMuY29sdW1ucyk7CiAgICBkLnB1c2goewogICAgICBpZDogbG9naWMubmV3Q29sdW1uSWQoZCksCiAgICAgIHRpdGxlOiAnTmV3IGNvbHVtbicsCiAgICAgIGxhYmVsOiBgJHtyb290fS9OZXcgY29sdW1uYCwKICAgICAgcm9vdCwKICAgICAgYXJjaGl2ZU9uRHJvcDogZmFsc2UsCiAgICAgIGNoaW1lOiBmYWxzZSwKICAgICAgb3JpZ0xhYmVsOiAnJywKICAgICAgaXNOZXc6IHRydWUsCiAgICAgIGxhYmVsVG91Y2hlZDogZmFsc2UsCiAgICB9KTsKICAgIHJlbmRlckRyYXdlcihgdGl0bGU6JHtkLmxlbmd0aCAtIDF9YCk7CiAgICBjb25zdCBpbnB1dCA9IFsuLi5lbHMuZHJhd2VyTGF5ZXIucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEta2V5XScpXS5maW5kKHggPT4geC5kYXRhc2V0LmtleSA9PT0gYHRpdGxlOiR7ZC5sZW5ndGggLSAxfWApOwogICAgaWYgKGlucHV0KSBpbnB1dC5zZWxlY3QoKTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVEcmF3ZXIoKSB7CiAgICBjb25zdCBkID0gUy5kcmF3ZXI7CiAgICBjb25zdCB0aWR5ID0gcyA9PiBTdHJpbmcocyB8fCAnJykuc3BsaXQoJy8nKS5tYXAocCA9PiBwLnRyaW0oKSkuam9pbignLycpOwogICAgY29uc3QgY29scyA9IGQuZHJhZnQubWFwKGMgPT4gKHsKICAgICAgaWQ6IGMuaWQsCiAgICAgIHRpdGxlOiBTdHJpbmcoYy50aXRsZSB8fCAnJykudHJpbSgpLAogICAgICBsYWJlbDogdGlkeShjLmxhYmVsKS",
"wKICAgICAgYXJjaGl2ZU9uRHJvcDogISFjLmFyY2hpdmVPbkRyb3AsCiAgICAgIGNoaW1lOiAhIWMuY2hpbWUsCiAgICB9KSk7CgogICAgY29uc3QgcHJvYmxlbSA9IGxvZ2ljLnZhbGlkYXRlQ29sdW1ucyhjb2xzKTsKICAgIGlmIChwcm9ibGVtKSB7CiAgICAgIGQuZXJyb3IgPSBwcm9ibGVtOwogICAgICByZW5kZXJEcmF3ZXIoKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGQuc2F2aW5nID0gdHJ1ZTsKICAgIGQuZXJyb3IgPSAnJzsKICAgIHJlbmRlckRyYXdlcignc2F2ZScpOwogICAgY29uc3Qgbm90ZXMgPSBbXTsKCiAgICB0cnkgewogICAgICAvLyBMYWJlbCByZW5hbWVzIGZpcnN0LCBwZXJzaXN0aW5nIGFmdGVyIGVhY2ggb25lLiBJZiBhIGxhdGVyIHN0ZXAKICAgICAgLy8gZmFpbHMsIHRoZSBzYXZlZCBsYXlvdXQgc3RpbGwgbWF0Y2hlcyB3aGF0IEdtYWlsIG5vdyBoYXMsIGluc3RlYWQKICAgICAgLy8gb2YgcG9pbnRpbmcgYXQgYSBsYWJlbCBuYW1lIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cy4KICAgICAgbGV0IHBlcnNpc3RlZCA9IFMuY29sdW1ucy5tYXAoYyA9PiAoeyAuLi5jIH0pKTsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBkLmRyYWZ0Lmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3Qgcm93ID0gZC5kcmFmdFtpXTsKICAgICAgICBjb25zdCBuZXh0ID0gY29sc1tpXTsKICAgICAgICBpZiAocm93LmlzTmV3IHx8ICFyb3cub3JpZ0xhYmVsIHx8IHJvdy5vcmlnTGFiZWwgPT09IG5leHQubG",
"FiZWwpIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN0b3JlLnJlbmFtZUxhYmVsKHJvdy5vcmlnTGFiZWwsIG5leHQubGFiZWwpOwogICAgICAgIGlmIChyZXN1bHQgPT09ICdyZXBvaW50ZWQnKSBub3Rlcy5wdXNoKGDigJwke25leHQudGl0bGV94oCdIG5vdyB1c2VzIHRoZSBleGlzdGluZyBsYWJlbCDigJwke25leHQubGFiZWx94oCdLmApOwogICAgICAgIHBlcnNpc3RlZCA9IHBlcnNpc3RlZC5tYXAoYyA9PiAoYy5pZCA9PT0gbmV4dC5pZCA_IHsgLi4uYywgbGFiZWw6IG5leHQubGFiZWwgfSA6IGMpKTsKICAgICAgICBhd2FpdCBzdG9yZS5zYXZlQ29sdW1ucyhTLmFjY291bnQsIHBlcnNpc3RlZCk7CiAgICAgICAgUy5jb2x1bW5zID0gcGVyc2lzdGVkOwogICAgICB9CgogICAgICBhd2FpdCBzdG9yZS5lbnN1cmVMYWJlbHMoY29scy5tYXAoYyA9PiBjLmxhYmVsKSwgeyBmcmVzaDogdHJ1ZSB9KTsKICAgICAgYXdhaXQgc3RvcmUuc2F2ZUNvbHVtbnMoUy5hY2NvdW50LCBjb2xzKTsKICAgICAgUy5jb2x1bW5zID0gY29sczsKICAgICAgUy5kcmF3ZXIgPSBudWxsOwogICAgICByZW5kZXJEcmF3ZXIoKTsKICAgICAgZWxzLnNldHRpbmdzLmZvY3VzKCk7CiAgICAgIHRvYXN0KHJvb3QsIFsnQ29sdW1ucyBzYXZlZC4nLCAuLi5ub3Rlc10uam9pbignICcpKTsKICAgICAgUy5sb2FkZWRBdCA9IDA7CiAgICAgIGF3YWl0IHJlZnJlc2goKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZi",
"AoYXBpLlNUQVRFX0NPREVTLmhhcyhlcnIuY29kZSkpIHsKICAgICAgICBTLmRyYXdlciA9IG51bGw7CiAgICAgICAgcmVuZGVyRHJhd2VyKCk7CiAgICAgICAgaGFuZGxlRXJyb3IoZXJyKTsKICAgICAgICByZW5kZXIoKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgZC5zYXZpbmcgPSBmYWxzZTsKICAgICAgZC5lcnJvciA9IGBDb3VsZG7igJl0IHNhdmU6ICR7ZXJyLm1lc3NhZ2V9YDsKICAgICAgcmVuZGVyRHJhd2VyKCk7CiAgICB9CiAgfQoKICAvLyDilIDilIAgQ2FyZCBlZGl0b3Ig4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgLy8KICAvLyBUaGUgdXNlcidzIG93biB0aXRsZSwgbm90ZSBhbmQgY29sb3VyIGZvciBvbmUgY2FyZC4gTm9uZSBvZiBpdCByZWFjaGVzCiAgLy8gR21haWw6IHRoZSByZWNvcmQgbGl2ZXMgaW4gc3RvcmFnZS5zeW5jLCBhbmQgdGhlIGVtYWlsIC0gaXRzIHN1YmplY3QsCiAgLy8gaXRzIGxhYmVscywgd2hhdCBjb3JyZXNwb25kZW50cyBzZWUgLSBpcyBleGFjdGx5IGFzIGl0IHdhcy4KCiAgY29uc3QgQ09MT1VSX05BTUVTID0gewogICAgcmVkOiAnUmVkJywgb3JhbmdlOiAnT3JhbmdlJywgeWVsbG93OiAnWWVsbG93JywgZ3JlZW",
"46ICdHcmVlbicsCiAgICBibHVlOiAnQmx1ZScsIHB1cnBsZTogJ1B1cnBsZScsIGdyZXk6ICdHcmV5JywKICB9OwoKICBmdW5jdGlvbiBvcGVuRWRpdG9yKGlkKSB7CiAgICBjb25zdCB0ID0gc3RvcmUudGhyZWFkKGlkKTsKICAgIGlmICghdCB8fCBTLnN0YXR1cyAhPT0gJ3JlYWR5JykgcmV0dXJuOwogICAgY2xvc2VNZW51KHJvb3QpOwogICAgY29uc3QgZWRpdCA9IFMuZWRpdHMuZ2V0KGlkKSB8fCB7fTsKICAgIFMuZWRpdG9yID0gewogICAgICBpZCwKICAgICAgc3ViamVjdDogdC5zdWJqZWN0LAogICAgICAvLyBQcmUtZmlsbGVkIHdpdGggdGhlIHN1YmplY3QgcmF0aGVyIHRoYW4gbGVmdCBibGFuaywgYmVjYXVzZSB0aGUKICAgICAgLy8gdXN1YWwgZWRpdCBpcyB0cmltbWluZyBhIGxvbmcgc3ViamVjdCBkb3duLCBub3Qgc3RhcnRpbmcgYWZyZXNoLgogICAgICBkcmFmdDogeyB0aXRsZTogZWRpdC50aXRsZSB8fCB0LnN1YmplY3QsIG5vdGU6IGVkaXQubm90ZSB8fCAnJywgY29sb3VyOiBlZGl0LmNvbG91ciB8fCAnJyB9LAogICAgICBlcnJvcjogJycsCiAgICAgIHNhdmluZzogZmFsc2UsCiAgICB9OwogICAgcmVuZGVyRWRpdG9yKCdlZGl0LXRpdGxlJyk7CiAgICBjb25zdCBpbnB1dCA9IGVscy5lZGl0b3JMYXllci5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9ImVkaXQtdGl0bGUiXScpOwogICAgaWYgKGlucHV0KSBpbnB1dC5zZWxlY3QoKTsKICB9CgogIC8vIOKUgOKUgCBUaGUgbGljZW5jZSDilIDilI",
"DilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAvLwogIC8vIFdoYXQgdGhlIGxpY2VuY2UgaXMgKGxpY2VuY2VMb2dpYy52aWV3KSBjb21lcyBmcm9tIHRoZSB3b3JrZXIsIG9yIHRoZQogIC8vIHBob25lIGFwcCdzIHNjcmlwdCwgZWFjaCB0aW1lIHRoZSBib2FyZCBvcGVucy4gSW4gcHJldmlldyBvciBsaWNlbnNlZAogIC8vIG5vdGhpbmcgc2hvd3M7IGluIHRoZSB0cmlhbCBhIGNoaXAgaW4gdGhlIGJhciAob24gYSBjb21wdXRlcikgYW5kIHRoZQogIC8vIGxvZ28ncyBtZW51IHNheSBob3cgbG9uZyBpcyBsZWZ0OyBvbmNlIGl0IGlzIG92ZXIsIHRoZSBsaWNlbmNlIHNjcmVlbgogIC8vIHN0YW5kcyBpbiBmb3IgdGhlIGJvYXJkLCB0aGUgbm90ZXMgYW5kIHRoZSBjYWxlbmRhciAtIHdoaWNoIGFyZSBhbGwKICAvLyBzdGlsbCBpbiBHbWFpbCwgdW50b3VjaGVkLiBBIGxpY2VuY2UgdGhhdCBjb3VsZCBub3QgYmUgYXNrZWQgYWJvdXQgaXMKICAvLyBuZXZlciBhIHJlYXNvbiB0byBzdG9wLgoKICBjb25zdCBibG9ja2VkID0gKCkgPT4gISEoUy5saWNlbmNlICYmIFMubGljZW5jZS5zdGF0ZSA9PT0gJ2V4cGlyZWQnKTsKICBjb25zdCBwbHVyYWwgPSAobiwgd29yZCkgPT4gYCR7bn0gJH",
"t3b3JkfSR7biA9PT0gMSA_ICcnIDogJ3MnfWA7CgogIC8vIGBhY3Rpb25gOiAnc3RhdHVzJywgJ2NoZWNrJywgJ2VudGVyJyAod2l0aCBga2V5YCkgb3IgJ3JlbW92ZScuCiAgLy8gUmVzb2x2ZXMgdG8geyB2aWV3LCBlcnJvcj8gfSwgb3IgeyBlcnJvciB9IGlmIGl0IGNvdWxkIG5vdCBiZSBhc2tlZC4KICBhc3luYyBmdW5jdGlvbiBjaGVja0xpY2VuY2UoYWN0aW9uID0gJ3N0YXR1cycsIGtleSA9ICcnKSB7CiAgICBpZiAoIWFwaS5saWNlbmNlKSByZXR1cm4gbnVsbDsKICAgIGxldCByZXM7CiAgICB0cnkgewogICAgICByZXMgPSBhd2FpdCBhcGkubGljZW5jZShhY3Rpb24sIGtleSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgcmV0dXJuIHsgZXJyb3I6IGVyci5tZXNzYWdlIH07CiAgICB9CiAgICBpZiAoIXJlcyB8fCAhcmVzLnZpZXcpIHJldHVybiByZXM7CiAgICBjb25zdCB3YXMgPSBibG9ja2VkKCk7CiAgICBTLmxpY2VuY2UgPSByZXMudmlldzsKICAgIHVwZGF0ZUxpY2VuY2UoKTsKICAgIGlmIChTLm9wZW4gJiYgUy5tb3VudGVkICYmIHdhcyAhPT0gYmxvY2tlZCgpKSB7CiAgICAgIGlmIChibG9ja2VkKCkpIHJlbmRlcigpOwogICAgICBlbHNlIHNob3dWaWV3KCk7CiAgICB9CiAgICByZXR1cm4gcmVzOwogIH0KCiAgZnVuY3Rpb24gdXBkYXRlTGljZW5jZSgpIHsKICAgIGlmICghZWxzLmxpY2VuY2UpIHJldHVybjsKICAgIGNvbnN0IHYgPSBTLmxpY2VuY2U7CiAgICBjb25zdCB0cmlhbCA9ICEhKH",
"YgJiYgdi5zdGF0ZSA9PT0gJ3RyaWFsJykgJiYgIWZyYW1lOwogICAgZWxzLmxpY2VuY2UuaGlkZGVuID0gIXRyaWFsOwogICAgaWYgKHRyaWFsKSB7CiAgICAgIGVscy5saWNlbmNlLnRleHRDb250ZW50ID0gYFRyaWFsOiAke3BsdXJhbCh2LmRheXNMZWZ0LCAnZGF5Jyl9IGxlZnRgOwogICAgICBlbHMubGljZW5jZS50aXRsZSA9IGAke0FQUF9OQU1FfeKAmXMgZnJlZSB0cmlhbC4gQ2xpY2sgdG8gZW50ZXIgYSBsaWNlbmNlIGtleS5gOwogICAgfQogIH0KCiAgZnVuY3Rpb24gbGljZW5jZU1lbnVMYWJlbCgpIHsKICAgIGNvbnN0IHYgPSBTLmxpY2VuY2U7CiAgICBpZiAoIXYpIHJldHVybiAnTGljZW5jZSc7CiAgICBpZiAodi5zdGF0ZSA9PT0gJ3ByZXZpZXcnKSByZXR1cm4gJ0xpY2VuY2U6IGZyZWUgd2hpbGUgaW4gcHJldmlldyc7CiAgICBpZiAodi5zdGF0ZSA9PT0gJ3RyaWFsJykgcmV0dXJuIGBMaWNlbmNlOiB0cmlhbCwgJHtwbHVyYWwodi5kYXlzTGVmdCwgJ2RheScpfSBsZWZ0YDsKICAgIGlmICh2LnN0YXRlID09PSAnbGljZW5zZWQnKSByZXR1cm4gdi5raW5kID09PSAnc3VwZXJ2ZXJ0YWxlcicgPyAnTGljZW5jZTogd2l0aCBTdXBlcnZlcnRhbGVyJyA6ICdMaWNlbmNlOiBsaWNlbnNlZCc7CiAgICByZXR1cm4gJ0xpY2VuY2U6IG5lZWRlZCc7CiAgfQoKICAvLyBXaGF0IHRvIHNheSBhYm91dCBpdDogYSB0aXRsZSBhbmQgYSBzZW50ZW5jZSBvciB0d28uCiAgZnVuY3Rpb24gbGljZW5jZVdvcmRzKHYpIH",
"sKICAgIGNvbnN0IGtlZXAgPSAnWW91ciBib2FyZCwgeW91ciBub3RlcyBhbmQgeW91ciBjYWxlbmRhciBhcmUgYWxsIHN0aWxsIGluIEdtYWlsLCB1bnRvdWNoZWQuJzsKICAgIGNvbnN0IGFsc28gPSAnQSBTdXBlcnZlcnRhbGVyIGxpY2VuY2Ugd29ya3MgdG9vLic7CiAgICBpZiAoIXYpIHJldHVybiB7IHRpdGxlOiAnTGljZW5jZScsIHRleHQ6ICdJdCBjb3VsZCBub3QgYmUgbG9va2VkIHVwIGp1c3Qgbm93LicgfTsKICAgIHN3aXRjaCAodi5zdGF0ZSkgewogICAgICBjYXNlICdwcmV2aWV3JzoKICAgICAgICByZXR1cm4geyB0aXRsZTogJ0ZyZWUgd2hpbGUgaW4gcHJldmlldycsIHRleHQ6IGAke0FQUF9OQU1FfSBpcyBmcmVlIHRvIHVzZSB1bnRpbCBsaWNlbmNlcyBnbyBvbiBzYWxlLiBUaGVyZSBpcyBub3RoaW5nIHRvIGVudGVyLmAgfTsKICAgICAgY2FzZSAndHJpYWwnOgogICAgICAgIHJldHVybiB7IHRpdGxlOiBgRnJlZSB0cmlhbDogJHtwbHVyYWwodi5kYXlzTGVmdCwgJ2RheScpfSBsZWZ0YCwgdGV4dDogYFRvIGNhcnJ5IG9uIGFmdGVyIHRoZSB0cmlhbCwgZW50ZXIgYSBsaWNlbmNlIGtleS4gJHthbHNvfWAgfTsKICAgICAgY2FzZSAnbGljZW5zZWQnOgogICAgICAgIHJldHVybiB7CiAgICAgICAgICB0aXRsZTogJ0xpY2Vuc2VkJywKICAgICAgICAgIHRleHQ6IHYua2luZCA9PT0gJ3N1cGVydmVydGFsZXInCiAgICAgICAgICAgID8gYFdpdGggeW91ciBTdXBlcnZlcnRhbGVyIGxpY2VuY2UsIHRoZS",
"BrZXkgZW5kaW5nICR7di5rZXlFbmR9LiBUaGFuayB5b3UhYAogICAgICAgICAgICA6IGBBICR7QVBQX05BTUV9IGxpY2VuY2Uke3YudmFyaWFudCA_IGAgKCR7di52YXJpYW50fSlgIDogJyd9LCB0aGUga2V5IGVuZGluZyAke3Yua2V5RW5kfS4gVGhhbmsgeW91IWAsCiAgICAgICAgfTsKICAgICAgZGVmYXVsdDoKICAgICAgICBpZiAoIXYua2luZCkgcmV0dXJuIHsgdGl0bGU6ICdZb3VyIGZyZWUgdHJpYWwgaGFzIGVuZGVkJywgdGV4dDogYCR7a2VlcH0gVG8gY2Fycnkgb24sIGVudGVyIGEgbGljZW5jZSBrZXkuICR7YWxzb31gIH07CiAgICAgICAgaWYgKHYud2h5ID09PSAndW5jaGVja2VkJykgcmV0dXJuIHsgdGl0bGU6ICdZb3VyIGxpY2VuY2UgbmVlZHMgY2hlY2tpbmcnLCB0ZXh0OiBgSXQgaGFzIG5vdCBiZWVuIHBvc3NpYmxlIHRvIGNoZWNrIGl0IGZvciBhIG1vbnRoLiAke2tlZXB9IENoZWNrIGFnYWluIHdoZW4geW91IGFyZSBvbmxpbmUuYCB9OwogICAgICAgIGlmICh2LndoeSA9PT0gJ2V4cGlyZWQnKSByZXR1cm4geyB0aXRsZTogJ1lvdXIgbGljZW5jZSBoYXMgcnVuIG91dCcsIHRleHQ6IGAke2tlZXB9IFJlbmV3IGl0LCBvciBlbnRlciBhbm90aGVyIGtleS5gIH07CiAgICAgICAgaWYgKHYud2h5ID09PSAnZGlzYWJsZWQnKSByZXR1cm4geyB0aXRsZTogJ1lvdXIgbGljZW5jZSBoYXMgYmVlbiBzd2l0Y2hlZCBvZmYnLCB0ZXh0OiBgTGVtb24gU3F1ZWV6eSwgd2hpY2ggbG9va3MgYWZ0ZXIgdGhlIG",
"xpY2VuY2VzLCBzYXlzIHNvIC0gYWZ0ZXIgYSByZWZ1bmQsIGZvciBpbnN0YW5jZS4gJHtrZWVwfSBFbnRlciBhbm90aGVyIGtleSB0byBjYXJyeSBvbi5gIH07CiAgICAgICAgaWYgKHYud2h5ID09PSAnbm90LW91cnMnKSByZXR1cm4geyB0aXRsZTogJ1RoYXQga2V5IGlzIG5vdCBhIGxpY2VuY2UnLCB0ZXh0OiBgSXQgdHVybmVkIG91dCBub3QgdG8gYmUgYSBsaWNlbmNlIGZvciAke0FQUF9OQU1FfS4gJHtrZWVwfSBFbnRlciBhbm90aGVyIGtleSB0byBjYXJyeSBvbi5gIH07CiAgICAgICAgcmV0dXJuIHsgdGl0bGU6ICdZb3VyIGxpY2VuY2UgaXMgbm90IGFjdGl2ZScsIHRleHQ6IGAke2tlZXB9IEVudGVyIGFub3RoZXIga2V5IHRvIGNhcnJ5IG9uLmAgfTsKICAgIH0KICB9CgogIC8vIFRoZSBjb250cm9scyBmb3IgdGhlIHN0YXRlIGl0IGlzIGluOiBhIGtleSB0byBlbnRlciAoaW4gdGhlIHRyaWFsLAogIC8vIG9yIG9uY2UgaXQgaXMgb3ZlciksIGFuZCAtIGxpY2Vuc2VkIC0gYSB3YXkgdG8gdGFrZSBpdCBvZmYgaGVyZS4KICBmdW5jdGlvbiBsaWNlbmNlQ29udHJvbHModiwgeyBkaWFsb2cgPSBmYWxzZSB9ID0ge30pIHsKICAgIGNvbnN0IGVycm9yID0gaCgncCcsIHsgY2xhc3M6ICdsaWNlbmNlLWVycm9yJywgcm9sZTogJ2FsZXJ0JyB9KTsKICAgIGNvbnN0IGJ1c3kgPSAoYnRuLCBsYWJlbCkgPT4gewogICAgICBidG4uc2V0QXR0cmlidXRlKCdhcmlhLWRpc2FibGVkJywgJ3RydWUnKTsKICAgICAgYnRuLn",
"RleHRDb250ZW50ID0gbGFiZWw7CiAgICB9OwogICAgY29uc3QgcmVhZHkgPSAoYnRuLCBsYWJlbCkgPT4gewogICAgICBidG4ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWRpc2FibGVkJyk7CiAgICAgIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsOwogICAgfTsKICAgIGNvbnN0IGRvbmUgPSAocmVzLCBtZXNzYWdlKSA9PiB7CiAgICAgIGlmIChkaWFsb2cgJiYgIShyZXMgJiYgcmVzLmVycm9yKSkgewogICAgICAgIGNsb3NlRWRpdG9yKCk7CiAgICAgICAgdG9hc3Qocm9vdCwgbWVzc2FnZSk7CiAgICAgIH0KICAgIH07CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGlmICh2ICYmICh2LnN0YXRlID09PSAndHJpYWwnIHx8IHYuc3RhdGUgPT09ICdleHBpcmVkJykpIHsKICAgICAgY29uc3QgaW5wdXQgPSBoKCdpbnB1dCcsIHsKICAgICAgICBjbGFzczogJ3RleHQtaW5wdXQgbGljZW5jZS1rZXknLCB0eXBlOiAndGV4dCcsIGF1dG9jb21wbGV0ZTogJ29mZicsIHNwZWxsY2hlY2s6ICdmYWxzZScsIG1heGxlbmd0aDogJzIwMCcsCiAgICAgICAgcGxhY2Vob2xkZXI6ICdMaWNlbmNlIGtleScsICdhcmlhLWxhYmVsJzogJ0xpY2VuY2Uga2V5JywgZGF0YXNldDogeyBrZXk6ICdsaWNlbmNlLWtleScgfSwKICAgICAgICBvbmtleWRvd246IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicgJiYgIWUuaXNDb21wb3NpbmcpIHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBlbnRlcigpOyB9IH0sCiAgICAgIH0pOwogICAgICBjb25zdCBhY3",
"RpdmF0ZSA9IGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdidG4gYnRuLXByaW1hcnknLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ0FjdGl2YXRlJywgZGF0YXNldDogeyBrZXk6ICdsaWNlbmNlLWVudGVyJyB9LCBvbmNsaWNrOiAoKSA9PiBlbnRlcigpIH0pOwogICAgICBhc3luYyBmdW5jdGlvbiBlbnRlcigpIHsKICAgICAgICBpZiAoYWN0aXZhdGUuZ2V0QXR0cmlidXRlKCdhcmlhLWRpc2FibGVkJykgPT09ICd0cnVlJykgcmV0dXJuOwogICAgICAgIGJ1c3koYWN0aXZhdGUsICdDaGVja2luZ-KApicpOwogICAgICAgIGVycm9yLnRleHRDb250ZW50ID0gJyc7CiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgY2hlY2tMaWNlbmNlKCdlbnRlcicsIGlucHV0LnZhbHVlKTsKICAgICAgICByZWFkeShhY3RpdmF0ZSwgJ0FjdGl2YXRlJyk7CiAgICAgICAgaWYgKCFyZXMgfHwgcmVzLmVycm9yKSB7CiAgICAgICAgICBlcnJvci50ZXh0Q29udGVudCA9IChyZXMgJiYgcmVzLmVycm9yKSB8fCAnVGhhdCBkaWQgbm90IHdvcmsuIFRyeSBhZ2FpbiBpbiBhIG1vbWVudC4nOwogICAgICAgICAgaWYgKGlucHV0LmlzQ29ubmVjdGVkKSBpbnB1dC5mb2N1cygpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBkb25lKHJlcywgJ0xpY2Vuc2VkLiBUaGFuayB5b3UhJyk7CiAgICAgIH0KICAgICAgb3V0LnB1c2goaCgnZGl2JywgeyBjbGFzczogJ2xpY2VuY2UtZm9ybScgfSwgaW5wdXQsIGFjdGl2YXRlKSwgZXJyb3IsCi",
"AgICAgICAgaCgncCcsIHsgY2xhc3M6ICdsaWNlbmNlLWxpbmtzJyB9LAogICAgICAgICAgaCgnYScsIHsgaHJlZjogbnMuTElDRU5DRV9CVVlfVVJMLCB0YXJnZXQ6ICdfYmxhbmsnLCByZWw6ICdub29wZW5lciBub3JlZmVycmVyJywgdGV4dDogJ0J1eSBhIGxpY2VuY2UnLCBkYXRhc2V0OiB7IGtleTogJ2xpY2VuY2UtYnV5JyB9IH0pLAogICAgICAgICAgdi53aHkgPT09ICd1bmNoZWNrZWQnID8gaCgnYnV0dG9uJywgewogICAgICAgICAgICBjbGFzczogJ2xpbmstYnRuJywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDaGVjayBhZ2FpbicsIGRhdGFzZXQ6IHsga2V5OiAnbGljZW5jZS1jaGVjaycgfSwKICAgICAgICAgICAgb25jbGljazogYXN5bmMgZSA9PiB7CiAgICAgICAgICAgICAgY29uc3QgYnRuID0gZS5jdXJyZW50VGFyZ2V0OwogICAgICAgICAgICAgIGJ1c3koYnRuLCAnQ2hlY2tpbmfigKYnKTsKICAgICAgICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBjaGVja0xpY2VuY2UoJ2NoZWNrJyk7CiAgICAgICAgICAgICAgaWYgKGJ0bi5pc0Nvbm5lY3RlZCkgcmVhZHkoYnRuLCAnQ2hlY2sgYWdhaW4nKTsKICAgICAgICAgICAgICBpZiAocmVzICYmIHJlcy5lcnJvcikgZXJyb3IudGV4dENvbnRlbnQgPSByZXMuZXJyb3I7CiAgICAgICAgICAgIH0sCiAgICAgICAgICB9KSA6IG51bGwpKTsKICAgIH0KICAgIGlmICh2ICYmIHYuc3RhdGUgPT09ICdsaWNlbnNlZCcpIHsKICAgICAgY29uc3Qgd2hlcmUgPSBmcm",
"FtZSA_ICd0aGlzIGFwcCcgOiAndGhpcyBjb21wdXRlcic7CiAgICAgIGNvbnN0IGNvbmZpcm0gPSBoKCdkaXYnLCB7IGNsYXNzOiAnbGljZW5jZS1jb25maXJtJywgaGlkZGVuOiB0cnVlIH0sCiAgICAgICAgaCgnc3BhbicsIHsgdGV4dDogYFRha2UgdGhlIGxpY2VuY2Ugb2ZmICR7d2hlcmV9PyBZb3UgY2FuIGVudGVyIGl0IGFnYWluIGF0IGFueSB0aW1lLmAgfSksCiAgICAgICAgaCgnYnV0dG9uJywgeyBjbGFzczogJ2J0biBidG4tdGV4dCcsIHR5cGU6ICdidXR0b24nLCB0ZXh0OiAnS2VlcCBpdCcsIG9uY2xpY2s6ICgpID0-IHsgY29uZmlybS5oaWRkZW4gPSB0cnVlOyByZW1vdmUuaGlkZGVuID0gZmFsc2U7IHJlbW92ZS5mb2N1cygpOyB9IH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsKICAgICAgICAgIGNsYXNzOiAnYnRuIGJ0bi1kYW5nZXInLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1Rha2UgaXQgb2ZmJywgZGF0YXNldDogeyBrZXk6ICdsaWNlbmNlLXJlbW92ZS15ZXMnIH0sCiAgICAgICAgICBvbmNsaWNrOiBhc3luYyBlID0-IHsKICAgICAgICAgICAgYnVzeShlLmN1cnJlbnRUYXJnZXQsICdUYWtpbmcgaXQgb2Zm4oCmJyk7CiAgICAgICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGNoZWNrTGljZW5jZSgncmVtb3ZlJyk7CiAgICAgICAgICAgIGRvbmUocmVzLCBgVGhlIGxpY2VuY2UgaXMgb2ZmICR7d2hlcmV9LmApOwogICAgICAgICAgfSwKICAgICAgICB9KSk7CiAgICAgIGNvbnN0IHJlbW92ZSA9IG",
"goJ2J1dHRvbicsIHsKICAgICAgICBjbGFzczogJ2J0biBidG4tdGV4dCBkYW5nZXInLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogYFRha2UgdGhlIGxpY2VuY2Ugb2ZmICR7d2hlcmV9YCwgZGF0YXNldDogeyBrZXk6ICdsaWNlbmNlLXJlbW92ZScgfSwKICAgICAgICBvbmNsaWNrOiAoKSA9PiB7IHJlbW92ZS5oaWRkZW4gPSB0cnVlOyBjb25maXJtLmhpZGRlbiA9IGZhbHNlOyBjb25maXJtLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0ibGljZW5jZS1yZW1vdmUteWVzIl0nKS5mb2N1cygpOyB9LAogICAgICB9KTsKICAgICAgb3V0LnB1c2gocmVtb3ZlLCBjb25maXJtLCBlcnJvcik7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gVGhlIHNjcmVlbiBvbmNlIHRoZSB0cmlhbCBvciB0aGUgbGljZW5jZSBpcyBvdmVyLgogIGZ1bmN0aW9uIGxpY2VuY2VQYW5lbCgpIHsKICAgIGNvbnN0IHdvcmRzID0gbGljZW5jZVdvcmRzKFMubGljZW5jZSk7CiAgICByZXR1cm4gaCgnZGl2JywgeyBjbGFzczogJ3BhbmVsIGxpY2VuY2UtcGFuZWwnLCByb2xlOiAncmVnaW9uJywgJ2FyaWEtbGFiZWwnOiB3b3Jkcy50aXRsZSB9LAogICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3BhbmVsLWljb24nIH0sIGljb24oJ2tleScsIDI4KSksCiAgICAgIGgoJ2gyJywgeyB0ZXh0OiB3b3Jkcy50aXRsZSB9KSwKICAgICAgaCgncCcsIHsgdGV4dDogd29yZHMudGV4dCB9KSwKICAgICAgLi4ubGljZW5jZUNvbnRyb2xzKFMubGljZW5jZS",
"kpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gb3BlbkxpY2VuY2UoKSB7CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBpZiAoIVMubGljZW5jZSkgYXdhaXQgY2hlY2tMaWNlbmNlKCk7CiAgICBjb25zdCB2ID0gUy5saWNlbmNlOwogICAgY29uc3Qgd29yZHMgPSBsaWNlbmNlV29yZHModik7CiAgICBjb25zdCBkaWFsb2cgPSBoKCdkaXYnLCB7IGNsYXNzOiAnZGlhbG9nIGxpY2VuY2UtZGlhbG9nJywgcm9sZTogJ2RpYWxvZycsICdhcmlhLW1vZGFsJzogJ3RydWUnLCAnYXJpYS1sYWJlbGxlZGJ5JzogJ2drYi1saWNlbmNlLWhlYWRpbmcnIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2ctaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItbGljZW5jZS1oZWFkaW5nJywgdGV4dDogJ0xpY2VuY2UnIH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDbG9zZScsIG9uY2xpY2s6IGNsb3NlRWRpdG9yIH0sIGljb24oJ2Nsb3NlJykpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1ib2R5JyB9LAogICAgICAgIGgoJ3AnLCB7IGNsYXNzOiAnbGljZW5jZS10aXRsZScsIHRleHQ6IHdvcmRzLnRpdGxlIH0pLAogICAgICAgIGgoJ3AnLCB7IGNsYXNzOiAnbGljZW5jZS10ZXh0JywgdGV4dDogd29yZHMudGV4dCB9KSwKICAgICAgICAuLi5saWNlbmNlQ29udHJvbHModiwgeyBkaWFsb2c6IHRydWUgfSkpLA",
"ogICAgICBoKCdkaXYnLCB7IGNsYXNzOiAnZGlhbG9nLWZvb3QnIH0sCiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3M6ICdzcGFjZXInIH0pLAogICAgICAgIGgoJ2J1dHRvbicsIHsgY2xhc3M6ICdidG4gYnRuLXRleHQnLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ0Nsb3NlJywgb25jbGljazogY2xvc2VFZGl0b3IgfSkpKTsKICAgIHNob3dEaWFsb2coZGlhbG9nLCB7IG9uQ2xvc2U6ICgpID0-IHJlc3RvcmVGb2N1cygnYWJvdXQnLCBlbHMub3ZlcmxheSkgfSk7CiAgICBjb25zdCBmaXJzdCA9IGRpYWxvZy5xdWVyeVNlbGVjdG9yKCdbZGF0YS1rZXk9ImxpY2VuY2Uta2V5Il0nKSB8fCBkaWFsb2cucXVlcnlTZWxlY3RvcignYnV0dG9uJyk7CiAgICBpZiAoZmlyc3QpIGZpcnN0LmZvY3VzKCk7CiAgfQoKICAvLyBBIGRpYWxvZyBvZiBhbm90aGVyIHZpZXcncyAtIHRoZSBjYWxlbmRhcidzIGVkaXRvciAtIGluIHRoZSBjYXJkCiAgLy8gZWRpdG9yJ3MgbGF5ZXIsIHNvIHRoZSBzY3JpbSwgRXNjIGFuZCB0aGUgZm9jdXMgdHJhcCB3b3JrIHRoZSBzYW1lLgogIC8vIGBvbkNsb3NlYCBydW5zIGhvd2V2ZXIgaXQgY2xvc2VzLgogIGZ1bmN0aW9uIHNob3dEaWFsb2coZGlhbG9nLCB7IG9uQ2xvc2UgfSA9IHt9KSB7CiAgICBjbG9zZU1lbnUocm9vdCk7CiAgICBTLmVkaXRvciA9IHsgZXh0ZXJuYWw6IHRydWUsIG9uQ2xvc2UgfTsKICAgIGVscy5lZGl0b3JMYXllci5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzcz",
"ogJ3NjcmltJywgb25jbGljazogY2xvc2VFZGl0b3IgfSksIGRpYWxvZyk7CiAgfQoKICBmdW5jdGlvbiBjbG9zZUVkaXRvcigpIHsKICAgIGlmICghUy5lZGl0b3IpIHJldHVybjsKICAgIGlmIChTLmVkaXRvci5leHRlcm5hbCkgewogICAgICBjb25zdCB7IG9uQ2xvc2UgfSA9IFMuZWRpdG9yOwogICAgICBTLmVkaXRvciA9IG51bGw7CiAgICAgIGVscy5lZGl0b3JMYXllci5yZXBsYWNlQ2hpbGRyZW4oKTsKICAgICAgaWYgKG9uQ2xvc2UpIG9uQ2xvc2UoKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgaWQgPSBTLmVkaXRvci5pZDsKICAgIFMuZWRpdG9yID0gbnVsbDsKICAgIHJlbmRlckVkaXRvcigpOwogICAgaWYgKFMub3BlbikgcmVzdG9yZUZvY3VzKGBtZW51OiR7aWR9YCwgZWxzLmJvZHkpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRWRpdG9yKGZvY3VzKSB7CiAgICBjb25zdCBlZCA9IFMuZWRpdG9yOwogICAgaWYgKCFlZCkgewogICAgICBlbHMuZWRpdG9yTGF5ZXIucmVwbGFjZUNoaWxkcmVuKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGtleSA9IGZvY3VzIHx8IGZvY3VzS2V5KCk7CiAgICBjb25zdCBkID0gZWQuZHJhZnQ7CgogICAgY29uc3QgcmVzZXQgPSBoKCdidXR0b24nLCB7CiAgICAgIGNsYXNzOiAnbGluay1idG4nLCB0eXBlOiAnYnV0dG9uJywgdGV4dDogJ1VzZSB0aGUgZW1haWwgc3ViamVjdCcsIGRhdGFzZXQ6IHsga2V5OiAnZWRpdC1yZXNldCcgfSwKICAgICAgb2",
"5jbGljazogKCkgPT4gewogICAgICAgIGQudGl0bGUgPSBlZC5zdWJqZWN0OwogICAgICAgIHRpdGxlSW5wdXQudmFsdWUgPSBlZC5zdWJqZWN0OwogICAgICAgIHN5bmNSZXNldCgpOwogICAgICAgIHRpdGxlSW5wdXQuZm9jdXMoKTsKICAgICAgfSwKICAgIH0pOwogICAgY29uc3Qgc3luY1Jlc2V0ID0gKCkgPT4gewogICAgICBjb25zdCB2ID0gZC50aXRsZS50cmltKCk7CiAgICAgIHJlc2V0LmhpZGRlbiA9ICF2IHx8IHYgPT09IGVkLnN1YmplY3QudHJpbSgpOwogICAgfTsKCiAgICBjb25zdCB0aXRsZUlucHV0ID0gaCgnaW5wdXQnLCB7CiAgICAgIGNsYXNzOiAndGV4dC1pbnB1dCcsIHR5cGU6ICd0ZXh0JywgdmFsdWU6IGQudGl0bGUsIG1heGxlbmd0aDogU3RyaW5nKGxvZ2ljLk1BWF9USVRMRSksCiAgICAgIHBsYWNlaG9sZGVyOiBlZC5zdWJqZWN0LCAnYXJpYS1kZXNjcmliZWRieSc6ICdna2ItZWRpdC1zdWJqZWN0JywgZGF0YXNldDogeyBrZXk6ICdlZGl0LXRpdGxlJyB9LAogICAgICBvbmlucHV0OiBlID0-IHsgZC50aXRsZSA9IGUudGFyZ2V0LnZhbHVlOyBzeW5jUmVzZXQoKTsgfSwKICAgICAgb25rZXlkb3duOiBlID0-IHsgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFlLmlzQ29tcG9zaW5nKSB7IGUucHJldmVudERlZmF1bHQoKTsgc2F2ZUVkaXRvcigpOyB9IH0sCiAgICB9KTsKICAgIHN5bmNSZXNldCgpOwoKICAgIGNvbnN0IG5vdGVJbnB1dCA9IGgoJ3RleHRhcmVhJywgewogICAgICBjbGFzcz",
"ogWyd0ZXh0LWlucHV0JywgJ3RleHQtYXJlYSddLCByb3dzOiAnMycsIG1heGxlbmd0aDogU3RyaW5nKGxvZ2ljLk1BWF9OT1RFKSwgdmFsdWU6IGQubm90ZSwKICAgICAgcGxhY2Vob2xkZXI6ICdPcHRpb25hbC4gU2hvd24gb24gdGhlIGNhcmQgaW4gcGxhY2Ugb2YgdGhlIGVtYWlsIHByZXZpZXcuJywKICAgICAgZGF0YXNldDogeyBrZXk6ICdlZGl0LW5vdGUnIH0sCiAgICAgIG9uaW5wdXQ6IGUgPT4geyBkLm5vdGUgPSBlLnRhcmdldC52YWx1ZTsgfSwKICAgICAgLy8gRW50ZXIgaXMgYSBuZXcgbGluZSBpbiBhIG5vdGU7IEN0cmwrRW50ZXIgc2F2ZXMsIGFzIGluIEdtYWlsJ3MgY29tcG9zZS4KICAgICAgb25rZXlkb3duOiBlID0-IHsgaWYgKGUua2V5ID09PSAnRW50ZXInICYmIChlLmN0cmxLZXkgfHwgZS5tZXRhS2V5KSkgeyBlLnByZXZlbnREZWZhdWx0KCk7IHNhdmVFZGl0b3IoKTsgfSB9LAogICAgfSk7CgogICAgY29uc3Qgc3dhdGNoZXMgPSBoKCdkaXYnLCB7IGNsYXNzOiAnc3dhdGNoZXMnLCByb2xlOiAncmFkaW9ncm91cCcsICdhcmlhLWxhYmVsbGVkYnknOiAnZ2tiLWVkaXQtY29sb3VyJyB9LAogICAgICBbJycsIC4uLmxvZ2ljLkNBUkRfQ09MT1VSU10ubWFwKGMgPT4gewogICAgICAgIGNvbnN0IG5hbWUgPSBjID8gQ09MT1VSX05BTUVTW2NdIDogJ05vIGNvbG91cic7CiAgICAgICAgcmV0dXJuIGgoJ2xhYmVsJywgeyBjbGFzczogJ3N3YXRjaCcsIHRpdGxlOiBuYW1lLCBkYXRhc2V0OiB7IGNvbG",
"91cjogYyB8fCAnbm9uZScgfSB9LAogICAgICAgICAgaCgnaW5wdXQnLCB7CiAgICAgICAgICAgIHR5cGU6ICdyYWRpbycsIG5hbWU6ICdna2ItY2FyZC1jb2xvdXInLCB2YWx1ZTogYywgY2hlY2tlZDogZC5jb2xvdXIgPT09IGMsICdhcmlhLWxhYmVsJzogbmFtZSwKICAgICAgICAgICAgZGF0YXNldDogeyBrZXk6IGBlZGl0LWNvbG91cjoke2MgfHwgJ25vbmUnfWAgfSwKICAgICAgICAgICAgb25jaGFuZ2U6ICgpID0-IHsgZC5jb2xvdXIgPSBjOyB9LAogICAgICAgICAgfSksCiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzczogJ3N3YXRjaC1kb3QnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSkpOwogICAgICB9KSk7CgogICAgY29uc3QgZGlhbG9nID0gaCgnZGl2JywgewogICAgICBjbGFzczogJ2RpYWxvZycsIHJvbGU6ICdkaWFsb2cnLCAnYXJpYS1tb2RhbCc6ICd0cnVlJywgJ2FyaWEtbGFiZWxsZWRieSc6ICdna2ItZWRpdC1oZWFkaW5nJywKICAgIH0sCiAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdkaWFsb2ctaGVhZCcgfSwKICAgICAgICBoKCdoMicsIHsgaWQ6ICdna2ItZWRpdC1oZWFkaW5nJywgdGV4dDogJ0VkaXQgY2FyZCcgfSksCiAgICAgICAgaCgnYnV0dG9uJywgewogICAgICAgICAgY2xhc3M6ICdpY29uLWJ0bicsIHR5cGU6ICdidXR0b24nLCAnYXJpYS1sYWJlbCc6ICdDbG9zZSB3aXRob3V0IHNhdmluZycsIG9uY2xpY2s6IGNsb3NlRWRpdG9yLAogICAgICAgIH0sIGljb24oJ2Nsb3NlJykpKS",
"wKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1ib2R5JyB9LAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWVkaXQtdGl0bGUnLCB0ZXh0OiAnVGl0bGUgb24gdGhlIGJvYXJkJyB9KSwKICAgICAgICAgIE9iamVjdC5hc3NpZ24odGl0bGVJbnB1dCwgeyBpZDogJ2drYi1lZGl0LXRpdGxlJyB9KSwKICAgICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdoZWxwLXJvdycsIGlkOiAnZ2tiLWVkaXQtc3ViamVjdCcgfSwKICAgICAgICAgICAgaCgnc3BhbicsIHt9LCAnRW1haWwgc3ViamVjdDogJywgaCgnc3BhbicsIHsgY2xhc3M6ICdzdWJqZWN0LXJlZicsIHRleHQ6IGVkLnN1YmplY3QgfSkpLAogICAgICAgICAgICByZXNldCkpLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ2xhYmVsJywgeyBjbGFzczogJ2ZpZWxkLWxhYmVsJywgZm9yOiAnZ2tiLWVkaXQtbm90ZScsIHRleHQ6ICdOb3RlJyB9KSwKICAgICAgICAgIE9iamVjdC5hc3NpZ24obm90ZUlucHV0LCB7IGlkOiAnZ2tiLWVkaXQtbm90ZScgfSkpLAogICAgICAgIGgoJ2RpdicsIHsgY2xhc3M6ICdmaWVsZCcgfSwKICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzOiAnZmllbGQtbGFiZWwnLCBpZDogJ2drYi1lZGl0LWNvbG91cicsIHRleHQ6ICdDb2xvdXInIH0pLAogICAgICAgICAgc3dhdG",
"NoZXMpKSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2Zvcm0tZXJyb3InLCByb2xlOiAnYWxlcnQnLCB0ZXh0OiBlZC5lcnJvciB9KSwKICAgICAgaCgnZGl2JywgeyBjbGFzczogJ2RpYWxvZy1mb290JyB9LAogICAgICAgIGgoJ3NwYW4nLCB7CiAgICAgICAgICBjbGFzczogJ25vdGUnLAogICAgICAgICAgdGV4dDogJ09ubHkgdGhlIGJvYXJkIGNoYW5nZXMuIFRoZSBlbWFpbCBpdHNlbGYsIGFuZCB3aGF0IG90aGVycyBzZWUsIHN0YXkgYXMgdGhleSBhcmUuJywKICAgICAgICB9KSwKICAgICAgICBoKCdidXR0b24nLCB7IGNsYXNzOiAnYnRuIGJ0bi10ZXh0JywgdHlwZTogJ2J1dHRvbicsIHRleHQ6ICdDYW5jZWwnLCBvbmNsaWNrOiBjbG9zZUVkaXRvciB9KSwKICAgICAgICBoKCdidXR0b24nLCB7CiAgICAgICAgICBjbGFzczogJ2J0biBidG4tcHJpbWFyeScsIHR5cGU6ICdidXR0b24nLCBkaXNhYmxlZDogZWQuc2F2aW5nLCBkYXRhc2V0OiB7IGtleTogJ2VkaXQtc2F2ZScgfSwKICAgICAgICAgIHRleHQ6ICdTYXZlJywgb25jbGljazogc2F2ZUVkaXRvciwKICAgICAgICB9KSkpOwoKICAgIGVscy5lZGl0b3JMYXllci5yZXBsYWNlQ2hpbGRyZW4oaCgnZGl2JywgeyBjbGFzczogJ3NjcmltJywgb25jbGljazogY2xvc2VFZGl0b3IgfSksIGRpYWxvZyk7CiAgICByZXN0b3JlRm9jdXMoa2V5LCBlbHMuZWRpdG9yTGF5ZXIpOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUVkaXRvcigpIHsKICAgIGNvbnN0IG",
"VkID0gUy5lZGl0b3I7CiAgICBpZiAoIWVkIHx8IGVkLnNhdmluZykgcmV0dXJuOwogICAgY29uc3QgZWRpdCA9IGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KGVkLmRyYWZ0LCBlZC5zdWJqZWN0KTsKICAgIGVkLnNhdmluZyA9IHRydWU7CiAgICBjb25zdCBzYXZlID0gZWxzLmVkaXRvckxheWVyLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWtleT0iZWRpdC1zYXZlIl0nKTsKICAgIGlmIChzYXZlKSBzYXZlLmRpc2FibGVkID0gdHJ1ZTsKCiAgICB0cnkgewogICAgICBhd2FpdCBzdG9yZS5zYXZlQ2FyZEVkaXQoUy5hY2NvdW50LCBlZC5pZCwgZWRpdCk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgaWYgKFMuZWRpdG9yICE9PSBlZCkgcmV0dXJuOwogICAgICBlZC5zYXZpbmcgPSBmYWxzZTsKICAgICAgZWQuZXJyb3IgPSBgQ291bGRu4oCZdCBzYXZlOiAke2Vyci5tZXNzYWdlfWA7CiAgICAgIHJlbmRlckVkaXRvcignZWRpdC1zYXZlJyk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAoZWRpdCkgUy5lZGl0cy5zZXQoZWQuaWQsIGVkaXQpOwogICAgZWxzZSBTLmVkaXRzLmRlbGV0ZShlZC5pZCk7CiAgICBpZiAoUy5lZGl0b3IgPT09IGVkKSBTLmVkaXRvciA9IG51bGw7CiAgICByZW5kZXJFZGl0b3IoKTsKICAgIHJlbmRlcigpOwogICAgcmVzdG9yZUZvY3VzKGBtZW51OiR7ZWQuaWR9YCwgZWxzLmJvZHkpOwogICAgYW5ub3VuY2UoZWRpdCA_ICdDYXJkIHVwZGF0ZWQuJyA6ICdDYXJkIGJhY2sgdG8gc2hvd2luZy",
"B0aGUgZW1haWwuJyk7CiAgfQoKICAvLyDilIDilIAgRXh0ZXJuYWwgY2hhbmdlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiAgLy8gQ29sdW1ucyBlZGl0ZWQgaW4gYW5vdGhlciB0YWIgb3Igb24gYW5vdGhlciBjb21wdXRlciAoc3RvcmFnZS5zeW5jKS4KICAvLyBUaGlzIHRhYidzIG93biBzYXZlcyBlY2hvIGJhY2sgaGVyZSB0b287IHRob3NlIGFyZSBhbHJlYWR5IG9uIHNjcmVlbi4KICBmdW5jdGlvbiBjb2x1bW5zQ2hhbmdlZChuZXh0KSB7CiAgICBpZiAobmV4dCAmJiBKU09OLnN0cmluZ2lmeShuZXh0KSA9PT0gSlNPTi5zdHJpbmdpZnkoUy5jb2x1bW5zKSkgcmV0dXJuOwogICAgUy5sb2FkZWRBdCA9IDA7CiAgICBpZiAoUy5vcGVuICYmICFTLmRyYXdlciAmJiBTLnZpZXcgPT09ICdib2FyZCcpIHJlZnJlc2goKTsKICB9CgogIC8vIENhcmQgZWRpdHMgc2F2ZWQgaW4gYW5vdGhlciB0YWIsIG9yIHN5bmNlZCBmcm9tIGFub3RoZXIgY29tcHV0ZXIuCiAgLy8gVGhpcyB0YWIncyBvd24gc2F2ZXMgZWNobyBiYWNrIGhlcmUgYXMgd2VsbDsgdGhvc2UgYXJlIGFscmVhZHkgZHJhd24sCiAgLy8gYW5kIHJlZHJhd2luZyBmb3IgdGhlbSB3b3VsZCBjbG9zZSBhIG1lbnUgb3BlbmVkIGluIHRoZS",
"BtZWFudGltZS4KICBmdW5jdGlvbiBjYXJkRWRpdHNDaGFuZ2VkKGNoYW5nZXMsIHByZWZpeCkgewogICAgbGV0IGNoYW5nZWQgPSBmYWxzZTsKICAgIGZvciAoY29uc3QgW2tleSwgY2hhbmdlXSBvZiBPYmplY3QuZW50cmllcyhjaGFuZ2VzKSkgewogICAgICBpZiAoIWtleS5zdGFydHNXaXRoKHByZWZpeCkpIGNvbnRpbnVlOwogICAgICBjb25zdCBpZCA9IGtleS5zbGljZShwcmVmaXgubGVuZ3RoKTsKICAgICAgY29uc3QgbmV4dCA9IGxvZ2ljLm5vcm1hbGlzZUNhcmRFZGl0KGNoYW5nZSAmJiBjaGFuZ2UubmV3VmFsdWUpOwogICAgICBpZiAoSlNPTi5zdHJpbmdpZnkobmV4dCkgPT09IEpTT04uc3RyaW5naWZ5KFMuZWRpdHMuZ2V0KGlkKSB8fCBudWxsKSkgY29udGludWU7CiAgICAgIGlmIChuZXh0KSBTLmVkaXRzLnNldChpZCwgbmV4dCk7CiAgICAgIGVsc2UgUy5lZGl0cy5kZWxldGUoaWQpOwogICAgICBjaGFuZ2VkID0gdHJ1ZTsKICAgIH0KICAgIGlmIChjaGFuZ2VkICYmIFMub3BlbiAmJiBTLnN0YXR1cyA9PT0gJ3JlYWR5JyAmJiBTLnZpZXcgPT09ICdib2FyZCcpIHJlbmRlcigpOwogIH0KCiAgbnMuYm9hcmQgPSB7CiAgICBvcGVuLCBjbG9zZSwgdG9nZ2xlLCB0b2dnbGVWaWV3LCBjb2x1bW5zQ2hhbmdlZCwgY2FyZEVkaXRzQ2hhbmdlZCwKICAgIGlzT3BlbjogKCkgPT4gUy5vcGVuLAogICAgLy8gRm9yIHRoZSBkb2NrOiB0aGUgbGljZW5jZSBhcyBpdCBpcyBub3cgKGFza2VkIGFmcmVzaCkuCiAgIC",
"BsaWNlbmNlOiAoKSA9PiBjaGVja0xpY2VuY2UoKS50aGVuKCgpID0-IFMubGljZW5jZSksCiAgICAvLyBGb3IgdGhlIHBob25lIGFwcDogd2hhdCBpcyBzaG93aW5nLCBhbmQgYSByZWZyZXNoIGlmIGl0IGlzIHN0YWxlLgogICAgdmlldzogKCkgPT4gUy52aWV3LAogICAgcmVmcmVzaElmU3RhbGUoKSB7CiAgICAgIGlmIChTLm9wZW4gJiYgUy52aWV3ID09PSAnYm9hcmQnICYmIERhdGUubm93KCkgLSBTLmxvYWRlZEF0ID4gU1RBTEVfTVMpIHJlZnJlc2goKTsKICAgIH0sCiAgfTsKfSkoKTsK\"],[\"addon/app/shell.js\",\"Ly8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACi8vIFRoZSBwaG9uZSBhcHAKLy8KLy8gVGhlIGV4dGVuc2lvbidzIGJvYXJkLCBOb3RlcyBhbmQgQ2FsZW5kYXIsIGZ1bGwtc2NyZWVuLCBhcyB0aGUgYXBwCi8vIGl0c2VsZjogdGhlIHNhbWUgdGFicywgY29sdW1ucywgY2FyZHMsIG5vdGVzLCBzZWFyY2gsIGVkaXRvciwgYXV0b3NhdmUKLy8gYW5kIGNhbGVuZGFyLCB3aXRoIHRoZSBib2FyZCdzIHN0eWxlcyBhbmQgYSBwaG9uZSBsYXlvdXQgb24gdG9wLiBPbiBhCi8v",
"IHBob25lIHRoZSBib2FyZCBzaG93cyBvbmUgY29sdW1uIGF0IGEgdGltZSwgc3dpcGVkIHNpZGV3YXlzOyB0aGUgbm90ZXMKLy8gb3BlbiBvbiB0aGUgU2NyYXRjaHBhZCwgdW5kZXIgdGhlIHNlYXJjaCBib3g7IGEgZm9sZGVyIG9yIGEgc2VhcmNoCi8vIHNob3dzIHRoZSBsaXN0IGluc3RlYWQsIGFuZCBhIG5vdGUgb3BlbnMgZnVsbC1zY3JlZW47IHRoZSBjYWxlbmRhciBpcwovLyB0aGUgd2VlayBhcyB0d28gY29sdW1ucyBvZiBkYXlzLCBzd2lwZWQgdG8gdGhlIG5leHQgd2Vlay4gQSBmaXJzdCB2aXNpdCBvcGVucyBvbiB0aGUKLy8gbm90ZXM7IGFmdGVyIHRoYXQsIG9uIHdoaWNoZXZlciB0YWIgd2FzIHVzZWQgbGFzdC4KLy8KLy8gQSBwaG9uZSBsZWF2ZXMgcGFnZXMgd2l0aG91dCBjbG9zaW5nIHRoZW0sIHNvIHdoYXRldmVyIGlzIHBlbmRpbmcgaXMKLy8gc2F2ZWQgd2hlbmV2ZXIgdGhlIHBhZ2UgaXMgaGlkZGVuOyBhbmQgQW5kcm9pZCdzIGJhY2sgZ2VzdHVyZSBzdGVwcwovLyBiYWNrIHRocm91Z2ggdGhlIG5vdGVzIC0gYSBub3RlIHRvIHRoZSBsaXN0LCB0aGUgbGlzdCB0byB0aGUKLy8gU2NyYXRjaHBhZCAtIHRocm91Z2ggZ29vZ2xlLnNjcmlwdC5oaXN0b3J5LgovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi",
"lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCihmdW5jdGlvbiAoKSB7CiAgJ3VzZSBzdHJpY3QnOwoKICBjb25zdCBucyA9IChnbG9iYWxUaGlzLmdrYiA9IGdsb2JhbFRoaXMuZ2tiIHx8IHt9KTsKICBjb25zdCB7IG1vdW50U2hhZG93IH0gPSBucy51aTsKCiAgLy8gSG93IGxvbmcgb3BlbmluZyB0b29rLCBmb3IgZmluZGluZyBvdXQgd2hhdCBpcyBzbG93ICh0aGUgbG9nbydzIG1lbnUsCiAgLy8gdW5kZXIgQWR2YW5jZWQpOiBmcm9tIHRoaXMgcGFnZSdzIHN0YXJ0LCB3aGljaCBjb21lcyBhZnRlciBHb29nbGUncwogIC8vIG93biBwYWdlIGFyb3VuZCBpdC4KICBjb25zdCBtYXJrcyA9IHsgY29kZTogcGVyZm9ybWFuY2Uubm93KCkgfTsKICBjb25zdCBtYXJrID0gbmFtZSA9PiB7IGlmICghKG5hbWUgaW4gbWFya3MpKSBtYXJrc1tuYW1lXSA9IHBlcmZvcm1hbmNlLm5vdygpOyB9OwogIGNvbnN0IHNlY3MgPSBtcyA9PiBgJHsobXMgLyAxMDAwKS50b0ZpeGVkKDEpfSBzYDsKICBmdW5jdGlvbiB0aW1pbmdUZXh0KCkgewogICAgY29uc3QgcGFydHMgPSBbYHBhZ2UgYW5kIGNvZGUgJHtzZWNzKG1hcmtzLmNvZGUpfWBdOwogICAgaWYgKCdyZWFkeScgaW4gbWFya3MpIHBhcnRzLnB1c2goYHJlYWR5IHRvIHR5cGUgJHtzZWNzKG1hcmtzLnJlYWR5KX1gKTsKICAgIGlmICgnY2hlY2tlZCcgaW4gbWFya3MpIHBhcnRzLnB1c2goYGNo",
"ZWNrZWQgd2l0aCBHbWFpbCAke3NlY3MobWFya3MuY2hlY2tlZCl9YCk7CiAgICBpZiAoJ2xpc3RlZCcgaW4gbWFya3MpIHBhcnRzLnB1c2goYGxpc3QgdXAgdG8gZGF0ZSAke3NlY3MobWFya3MubGlzdGVkKX1gKTsKICAgIHJldHVybiBgT3BlbmVkIGluICR7c2VjcyhtYXJrcy5yZWFkeSB8fCBtYXJrcy5jb2RlKX06ICR7cGFydHMuam9pbignLCAnKX0uYDsKICB9CgogIGNvbnN0IFBIT05FID0gYAo6aG9zdCB7IHBvc2l0aW9uOiBmaXhlZCAhaW1wb3J0YW50OyBpbnNldDogMCAhaW1wb3J0YW50OyB9Ci5vdmVybGF5IHsgcGFkZGluZzogZW52KHNhZmUtYXJlYS1pbnNldC10b3ApIGVudihzYWZlLWFyZWEtaW5zZXQtcmlnaHQpIGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSBlbnYoc2FmZS1hcmVhLWluc2V0LWxlZnQpOyB9CgpAbWVkaWEgKG1heC13aWR0aDogNzYwcHgpIHsKICAvKiBUaGUgaGVhZGVyOiB0aGUgbWFyaywgdGhlIHRocmVlIHRhYnMsIHJlZnJlc2ggYW5kIHRoZSBjb2x1bW4KICAgICBzZXR0aW5nczsgZ29uZSB3aGlsZSBhIG5vdGUgaGFzIHRoZSB3aG9sZSBzY3JlZW4uIE9uIGEgc21hbGwgcGhvbmUKICAgICBvbmx5IHRoZSBvcGVuIHRhYiBzYXlzIGl0cyBuYW1lLiAqLwogIC5iYXIgeyBoZWlnaHQ6IDU2cHg7IHBhZGRpbmc6IDAgNHB4IDAgMTJweDsgZ2FwOiAycHg7IH0KICAuYnJhbmQtYnRuID4gc3Bhbjpub3QoLmxvZ28pLCAuYWNjb3VudCwgLnVwZGF0ZWQgeyBkaXNwbGF5OiBub25lOyB9",
"CiAgLnRhYnMgeyBtYXJnaW4tbGVmdDogMTBweDsgbWluLXdpZHRoOiAwOyB9CiAgLnRhYiB7IHBhZGRpbmc6IDAgMTJweCAwIDEwcHg7IH0KICA6aG9zdChbZGF0YS12aWV3PSJub3RlIl0pIC5iYXIgeyBkaXNwbGF5OiBub25lOyB9CgogIC8qIFRoZSBib2FyZDogb25lIGNvbHVtbiB0byBhIHNjcmVlbiwgc3dpcGVkIHNpZGV3YXlzLiBDYXJkcyBtb3ZlIHdpdGgKICAgICB0aGVpciDii68gbWVudSwgc2luY2UgYSBmaW5nZXIgY2Fubm90IGRyYWcgdGhlbS4gKi8KICAuY29sdW1ucyB7IHNjcm9sbC1zbmFwLXR5cGU6IHggbWFuZGF0b3J5OyBnYXA6IDEwcHg7IHBhZGRpbmc6IDRweCAxNnB4IDEycHg7IHNjcm9sbC1wYWRkaW5nOiAwIDE2cHg7IH0KICAuY29sdW1uIHsgZmxleDogMCAwIGNhbGMoMTAwdncgLSA0NHB4KTsgbWluLXdpZHRoOiAwOyBtYXgtd2lkdGg6IG5vbmU7IHNjcm9sbC1zbmFwLWFsaWduOiBjZW50ZXI7IH0KCiAgLm5vdGVzIHsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAwOyBwYWRkaW5nOiAwOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0ibm90ZSJdIC5ub3Rlcy1mb2xkZXJzLCAubm90ZXNbZGF0YS12aWV3PSJub3RlIl0gLm5vdGVzLWxpc3QgeyBkaXNwbGF5OiBub25lOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0ibGlzdCJdIC5ub3RlLWVkaXRvciB7IGRpc3BsYXk6IG5vbmU7IH0KCiAgLyogSG9tZTogdGhlIHNlYXJjaCBib3gsIGFuZCB0aGUgc2NyYXRjaHBhZCBmaWxsaW5nIHRoZSByZXN0",
"LiAqLwogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubm90ZXMtbGlzdCB7IGZsZXg6IG5vbmU7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5vdGVzLXNjb3BlLCAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5vdGVzLWl0ZW1zLCAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5vdGVzLWZvb3QgeyBkaXNwbGF5OiBub25lOyB9CiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5ub3RlLWVkaXRvciB7IG1hcmdpbjogMCAxMnB4IDEycHg7IGJvcmRlci1yYWRpdXM6IDIycHg7IG1pbi1oZWlnaHQ6IDA7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5lLXRpdGxlIHsgcGFkZGluZzogMTRweCAxOHB4IDZweDsgfQogIC5ub3Rlc1tkYXRhLXZpZXc9ImhvbWUiXSAubmUtdG9vbGJhciB7IG1hcmdpbjogMCAxMHB4OyB9CiAgLm5vdGVzW2RhdGEtdmlldz0iaG9tZSJdIC5uZS1ib2R5IHsgcGFkZGluZzogMTBweCAxOHB4IDIwdmg7IH0KICAubm90ZXNbZGF0YS12aWV3PSJob21lIl0gLm5lLWJvZHlbZGF0YS1lbXB0eT0iMSJdOjpiZWZvcmUgeyBsZWZ0OiAxOHB4OyByaWdodDogMThweDsgfQoKICAvKiBGb2xkZXJzOiB0aGUgdHJlZSwgZm9sZGVkIGF3YXkgYmVoaW5kIGEgYnV0dG9uIHRoYXQgc2F5cyB3aGVyZSB5b3UKICAgICBhcmU7IG9wZW4sIGl0IGlzIHRoZSBzYW1lIHRyZWUgYXMgb24gYSBjb21wdXRlciwgbmVzdGluZyBhbmQgYWxsLiAqLwogIC5ub3Rlcy1mb2xkZXJzIHsgZmxleDogbm9u",
"ZTsgYmFja2dyb3VuZDogbm9uZTsgYm9yZGVyLXJhZGl1czogMDsgcGFkZGluZzogMnB4IDEycHggNHB4OyB9CiAgLmZvbGRlcnMtdG9nZ2xlIHsKICAgIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTBweDsgd2lkdGg6IDEwMCU7IGhlaWdodDogNDZweDsgcGFkZGluZzogMCAxMHB4IDAgMTRweDsKICAgIGJvcmRlci1yYWRpdXM6IDE0cHg7IGJhY2tncm91bmQ6IHZhcigtLWNvbCk7IGNvbG9yOiB2YXIoLS1mZyk7IGZvbnQtc2l6ZTogMTVweDsgdGV4dC1hbGlnbjogbGVmdDsKICB9CiAgLmZvbGRlcnMtdG9nZ2xlIC5pY29uIHsgY29sb3I6IHZhcigtLWZnLTIpOyBmbGV4OiBub25lOyB9CiAgLmZ0LWxhYmVsIHsgZmxleDogMTsgbWluLXdpZHRoOiAwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpczsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQogIC5mdC1jb3VudCB7IGNvbG9yOiB2YXIoLS1mZy0zKTsgZm9udC1zaXplOiAxM3B4OyBmb250LXZhcmlhbnQtbnVtZXJpYzogdGFidWxhci1udW1zOyB9CiAgLm5vdGVzW2RhdGEtZm9sZGVycz0ib3BlbiJdIC5mb2xkZXJzLXRvZ2dsZSB7IGJvcmRlci1yYWRpdXM6IDE0cHggMTRweCAwIDA7IH0KICAubm90ZXNbZGF0YS1mb2xkZXJzPSJvcGVuIl0gLmZvbGRlcnMtdG9nZ2xlIC5pY29uOmxhc3QtY2hpbGQgeyB0cmFuc2Zvcm06IHJvdGF0ZSgxODBkZWcpOyB9CiAgLm5vdGVzOm5vdChbZGF0YS1mb2xkZXJzPSJvcGVu",
"Il0pIC5mb2xkZXJzLWhlYWQsIC5ub3Rlczpub3QoW2RhdGEtZm9sZGVycz0ib3BlbiJdKSAuZm9sZGVyLWl0ZW1zIHsgZGlzcGxheTogbm9uZTsgfQogIC5mb2xkZXJzLWhlYWQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1jb2wpOyBwYWRkaW5nOiAwIDZweCAwIDE2cHg7IH0KICAuZm9sZGVyLWl0ZW1zIHsgZmxleDogbm9uZTsgbWF4LWhlaWdodDogNTV2aDsgYmFja2dyb3VuZDogdmFyKC0tY29sKTsgYm9yZGVyLXJhZGl1czogMCAwIDE0cHggMTRweDsgcGFkZGluZzogMnB4IDhweCAxMHB4OyB9CiAgLmZvbGRlci1idG4geyBoZWlnaHQ6IDQ0cHg7IH0KICAuZm9sZGVyLXR3aXN0eSB7IHdpZHRoOiAzNHB4OyBoZWlnaHQ6IDQ0cHg7IG1hcmdpbi1yaWdodDogMDsgfQogIC5mb2xkZXItaXRlbXNbZGF0YS1uZXN0ZWRdIC5mb2xkZXItZWRpdCB7IHBhZGRpbmctbGVmdDogNDRweDsgfQogIC5mb2xkZXItaXRlbXNbZGF0YS1uZXN0ZWRdIC5mb2xkZXItZXJyb3IgeyBwYWRkaW5nLWxlZnQ6IDcwcHg7IH0KICAvKiBObyBob3ZlciBvbiBhIHBob25lOiBlYWNoIGZvbGRlcidzIOKLryBpcyBhbHdheXMgdGhlcmUsIG5leHQgdG8gaXRzIGNvdW50LiAqLwogIC5mb2xkZXItbWVudSB7IG9wYWNpdHk6IDE7IHJpZ2h0OiA0cHg7IH0KICAuZm9sZGVyLXJvdyAuZm9sZGVyLWNvdW50LCAuZm9sZGVyLXJvdzpob3ZlciAuZm9sZGVyLWNvdW50LCAuZm9sZGVyLXJvdzpmb2N1cy13aXRoaW4gLmZvbGRlci1jb3VudCB7IHZpc2liaWxpdHk6",
"IHZpc2libGU7IG1hcmdpbi1yaWdodDogMzRweDsgfQoKICAubm90ZXMtbGlzdCB7IGZsZXg6IDE7IGJvcmRlci1yYWRpdXM6IDA7IGJhY2tncm91bmQ6IG5vbmU7IH0KICAubm90ZXMtdG9vbHMgeyBwYWRkaW5nOiA0cHggMTJweCA4cHg7IH0KICAubm90ZXMtaXRlbXMgeyBwYWRkaW5nOiAwIDRweCAxMnB4OyB9CiAgLm5vdGUtaXRlbSB7IHBhZGRpbmc6IDEycHg7IH0KCiAgLyogbWluLWhlaWdodDogMCwgb3IgYSBsb25nIG5vdGUgZ3Jvd3MgcGFzdCB0aGUgc2NyZWVuLCBjdXQgb2ZmLCB3aXRoCiAgICAgbm90aGluZyB0byBzY3JvbGw6IGl0cyB0ZXh0IGJveCBzY3JvbGxzIG9ubHkgaWYgdGhlIGVkaXRvciBzdG9wcyBhdAogICAgIHRoZSBzY3JlZW4ncyBmb290LiAqLwogIC5ub3RlLWVkaXRvciB7IGZsZXg6IDE7IG1pbi1oZWlnaHQ6IDA7IGJvcmRlci1yYWRpdXM6IDA7IGJveC1zaGFkb3c6IG5vbmU7IH0KICAubmUtYmFjayB7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBtYXJnaW4tcmlnaHQ6IDJweDsgfQogIC5uZS1iYXIgeyBwYWRkaW5nOiA2cHggNnB4IDAgNHB4OyB9CiAgLm5lLXRpdGxlIHsgcGFkZGluZzogNnB4IDE2cHggNHB4OyBmb250LXNpemU6IDIycHg7IH0KICAubmUtdG9vbGJhciB7IG1hcmdpbjogMCA4cHg7IG92ZXJmbG93LXg6IGF1dG87IGZsZXgtd3JhcDogbm93cmFwOyBzY3JvbGxiYXItd2lkdGg6IG5vbmU7IH0KICAubmUtbGlua2JhciB7IG1hcmdpbjogNHB4IDhweCAwOyB9CiAgLm5lLXRh",
"YmxlYmFyIHsgbWFyZ2luOiA0cHggOHB4IDA7IG92ZXJmbG93LXg6IGF1dG87IGZsZXgtd3JhcDogbm93cmFwOyBzY3JvbGxiYXItd2lkdGg6IG5vbmU7IH0KICAubmUtdGFibGViYXIgLnNwYWNlciB7IGRpc3BsYXk6IG5vbmU7IH0KICAubmUtYmFubmVyIHsgbWFyZ2luOiA0cHggMTJweCAwOyB9CiAgLm5lLWZpbmQgeyBtYXJnaW46IDRweCAxMnB4IDA7IH0KICAubmUtYm9keSB7IHBhZGRpbmc6IDEwcHggMTZweCA0MHZoOyBmb250LXNpemU6IDE2cHg7IH0KICAubmUtYm9keVtkYXRhLWVtcHR5PSIxIl06OmJlZm9yZSB7IGxlZnQ6IDE2cHg7IH0KfQpAbWVkaWEgKG1heC13aWR0aDogNDgwcHgpIHsKICAudGFiW2FyaWEtc2VsZWN0ZWQ9ImZhbHNlIl0geyBnYXA6IDA7IHBhZGRpbmc6IDAgMTBweDsgZm9udC1zaXplOiAwOyB9Cn0KYDsKCiAgLy8gQXBwcyBTY3JpcHQncyBoaXN0b3J5LCBpZiB0aGVyZSBpcyBvbmUsIHVzZWQgc28gdGhhdCBub3RoaW5nIGl0IGRvZXMgLQogIC8vIG9yIGZhaWxzIHRvIGRvIC0gY2FuIHN0b3AgdGhlIGFwcDogdGhlIGJhY2sgZ2VzdHVyZSBpcyBhIG5pY2V0eS4KICBmdW5jdGlvbiBoaXN0b3J5QXBpKCkgewogICAgY29uc3QgYXBpID0gdHlwZW9mIGdvb2dsZSAhPT0gJ3VuZGVmaW5lZCcgJiYgZ29vZ2xlLnNjcmlwdCAmJiBnb29nbGUuc2NyaXB0Lmhpc3Rvcnk7CiAgICBpZiAoIWFwaSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBzYWZlID0gZm4gPT4gKC4uLmFyZ3MpID0-IHsKICAg",
"ICAgdHJ5IHsgcmV0dXJuIGFwaVtmbl0oLi4uYXJncyk7IH0gY2F0Y2ggKGVycikgeyBjb25zb2xlLndhcm4oYGdvb2dsZS5zY3JpcHQuaGlzdG9yeS4ke2ZufTogJHtlcnIubWVzc2FnZX1gKTsgcmV0dXJuIHVuZGVmaW5lZDsgfQogICAgfTsKICAgIHJldHVybiB7IHB1c2g6IHNhZmUoJ3B1c2gnKSwgcmVwbGFjZTogc2FmZSgncmVwbGFjZScpLCBzZXRDaGFuZ2VIYW5kbGVyOiBzYWZlKCdzZXRDaGFuZ2VIYW5kbGVyJykgfTsKICB9CgogIGNvbnN0IHdpZGUgPSAoKSA9PiAhISh3aW5kb3cubWF0Y2hNZWRpYSAmJiB3aW5kb3cubWF0Y2hNZWRpYSgnKG1pbi13aWR0aDogNzYxcHgpJykubWF0Y2hlcyk7CgogIGZ1bmN0aW9uIHN0YXJ0KCkgewogICAgLy8gV2l0aG91dCBhbGwgaXRzIHBhcnRzIHRoZSBhcHAgY2Fubm90IHdvcms6IHRoZSBsb2FkZXIncyBsaXN0IG9mCiAgICAvLyB3aGF0IGRpZCBub3QgbG9hZCBzdGF5cyBvbiB0aGUgc2NyZWVuIGluc3RlYWQuCiAgICBpZiAod2luZG93Ll9fcGFydHNGYWlsZWQgJiYgd2luZG93Ll9fcGFydHNGYWlsZWQubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCB7IGhvc3QsIHJvb3QgfSA9IG1vdW50U2hhZG93KCdna2ItYXBwLWhvc3QnLCBucy5zdHlsZXMuYm9hcmQgKyBQSE9ORSk7CiAgICBjb25zdCBoaXN0b3J5ID0gaGlzdG9yeUFwaSgpOwogICAgLy8gSG93IG1hbnkgc3RlcHMgaW4gZnJvbSB0aGUgU2NyYXRjaHBhZCB0aGUgaGlzdG9yeSBob2xkcywgYW5kIHdoZXRoZXIK",
"ICAgIC8vIHRoZSBiYWNrIGdlc3R1cmUgaXMgYmVpbmcgZm9sbG93ZWQgcmlnaHQgbm93LgogICAgbGV0IGRlcHRoID0gMDsKICAgIGxldCBzdGVwcGluZyA9IGZhbHNlOwoKICAgIC8vIFdoaWNoIGZvbGRlcnMgYXJlIGZvbGRlZCwgd2hpY2ggY2FsZW5kYXJzIHNob3csIG9uIHRoaXMgcGhvbmUuIFRoZQogICAgLy8gcGFnZSBpcyBvbmx5IGV2ZXIgb3BlbmVkIGJ5IGl0cyBvd25lciwgc28gdGhlcmUgaXMgbm8gYWNjb3VudCB0bwogICAgLy8ga2V5IHRoZW0gYnkuIFRoZSAnc3VwZXJtYWlsLicgcHJlZml4IGlzIHRoZSBhcHAncyBvbGQgbmFtZSwga2VwdCBzbwogICAgLy8gcHJlZnMgc2F2ZWQgYmVmb3JlIHRoZSByZW5hbWUgc3RpbGwgY291bnQuCiAgICBjb25zdCBwcmVmcyA9IHsKICAgICAgZ2V0KG5hbWUpIHsKICAgICAgICB0cnkgeyByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShgc3VwZXJtYWlsLiR7bmFtZX1gKSB8fCAnbnVsbCcpOyB9IGNhdGNoIChlcnIpIHsgcmV0dXJuIG51bGw7IH0KICAgICAgfSwKICAgICAgc2V0KG5hbWUsIHZhbHVlKSB7CiAgICAgICAgdHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oYHN1cGVybWFpbC4ke25hbWV9YCwgSlNPTi5zdHJpbmdpZnkodmFsdWUpKTsgfSBjYXRjaCAoZXJyKSB7IC8qIHN0b3JhZ2Ugb2ZmOiBub3QgcmVtZW1iZXJlZCAqLyB9CiAgICAgIH0sCiAgICB9OwoKICAgIG5zLmJvYXJkRnJhbWUgPSB7CiAgICAgIHJvb3QsCiAgICAgIHZp",
"ZXc6ICdub3RlcycsCiAgICAgIHRpbWluZ3M6IHRpbWluZ1RleHQsCiAgICAgIC8vIE9uIGEgY29tcHV0ZXIsIHR5cGluZyBnb2VzIHN0cmFpZ2h0IGludG8gdGhlIFNjcmF0Y2hwYWQuIChBIHBob25lCiAgICAgIC8vIHdvdWxkIG9ubHkgcG9wIGl0cyBrZXlib2FyZCB1cCBvdmVyIGl0LCBzbyB0aGVyZSBpdCB3YWl0cyBmb3IgYSB0YXAuKQogICAgICBmb2N1czogd2lkZSgpLAogICAgICAvLyBUaGUgc2NyaXB0J3Mgb3duIGFjY2VzcyBjb3ZlcnMgdGhlIGNhbGVuZGFyOiBub3RoaW5nIHRvIGNvbm5lY3QuCiAgICAgIGNhbGVuZGFyOiB7IHByZWZzLCBjb25uZWN0OiBudWxsIH0sCiAgICAgIG5vdGVzOiB7CiAgICAgICAgcHJlZnMsCiAgICAgICAgLy8gRWFjaCBzdGVwIGluIGdvZXMgb24gdGhlIGhpc3RvcnksIHNvIHRoZSBiYWNrIGdlc3R1cmUgY2FuIHVuZG8gaXQ7CiAgICAgICAgLy8gYSBzdGVwIG91dCB0YWtlbiBpbiB0aGUgYXBwIGl0c2VsZiByZXdyaXRlcyB0aGUgdG9wIGVudHJ5IGluc3RlYWQsCiAgICAgICAgLy8gc2luY2Ugbm90aGluZyBoZXJlIGNhbiB0YWtlIGFuIGVudHJ5IG9mZi4KICAgICAgICBvblZpZXdDaGFuZ2UodmlldykgewogICAgICAgICAgaG9zdC5kYXRhc2V0LnZpZXcgPSB2aWV3OwogICAgICAgICAgY29uc3QgZCA9IG5zLm5vdGVzLmRlcHRoKCk7CiAgICAgICAgICBpZiAoaGlzdG9yeSAmJiAhc3RlcHBpbmcpIHsKICAgICAgICAgICAgaWYgKGQgPiBkZXB0aCkgZm9yIChsZXQgaSA9",
"IGRlcHRoICsgMTsgaSA8PSBkOyBpKyspIGhpc3RvcnkucHVzaCh7IGRlcHRoOiBpIH0sIHt9LCAnJyk7CiAgICAgICAgICAgIGVsc2UgaWYgKGQgPCBkZXB0aCkgaGlzdG9yeS5yZXBsYWNlKHsgZGVwdGg6IGQgfSwge30sICcnKTsKICAgICAgICAgIH0KICAgICAgICAgIGRlcHRoID0gZDsKICAgICAgICB9LAogICAgICB9LAogICAgfTsKCiAgICBpZiAoaGlzdG9yeSkgewogICAgICBoaXN0b3J5LnNldENoYW5nZUhhbmRsZXIoYXN5bmMgZSA9PiB7CiAgICAgICAgY29uc3QgdGFyZ2V0ID0gKGUgJiYgZS5zdGF0ZSAmJiBOdW1iZXIoZS5zdGF0ZS5kZXB0aCkpIHx8IDA7CiAgICAgICAgc3RlcHBpbmcgPSB0cnVlOwogICAgICAgIHRyeSB7CiAgICAgICAgICB3aGlsZSAobnMubm90ZXMuZGVwdGgoKSA-IHRhcmdldCkgewogICAgICAgICAgICBjb25zdCBiZWZvcmUgPSBucy5ub3Rlcy5kZXB0aCgpOwogICAgICAgICAgICBhd2FpdCBucy5ub3Rlcy5iYWNrKCk7CiAgICAgICAgICAgIGlmIChucy5ub3Rlcy5kZXB0aCgpID49IGJlZm9yZSkgYnJlYWs7IC8vIGFuIHVuc2F2ZWQgZWRpdCBrZXB0IHRoZSBub3RlIG9wZW4KICAgICAgICAgIH0KICAgICAgICB9IGZpbmFsbHkgewogICAgICAgICAgc3RlcHBpbmcgPSBmYWxzZTsKICAgICAgICB9CiAgICAgICAgLy8gTm90IGFzIGZhciBiYWNrIGFzIHRoZSBnZXN0dXJlIHdlbnQ6IHRob3NlIHN0ZXBzIGdvIGJhY2sgb24uCiAgICAgICAgZGVwdGggPSBucy5ub3Rlcy5kZXB0",
"aCgpOwogICAgICAgIGZvciAobGV0IGkgPSB0YXJnZXQgKyAxOyBpIDw9IGRlcHRoOyBpKyspIGhpc3RvcnkucHVzaCh7IGRlcHRoOiBpIH0sIHt9LCAnJyk7CiAgICAgIH0pOwogICAgfQoKICAgIC8vIEEgcGhvbmUgc3dpdGNoZXMgYXdheSB3aXRob3V0IGNsb3NpbmcgdGhlIHBhZ2UuCiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd2aXNpYmlsaXR5Y2hhbmdlJywgKCkgPT4gewogICAgICBpZiAoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlID09PSAnaGlkZGVuJykgbnMubm90ZXMuZmx1c2goKTsKICAgICAgZWxzZSBpZiAobnMuYm9hcmQudmlldygpID09PSAnbm90ZXMnKSB7IGlmIChucy5ub3Rlcy5pc1N0YWxlKCkpIG5zLm5vdGVzLmxvYWQoKTsgfQogICAgICBlbHNlIGlmIChucy5ib2FyZC52aWV3KCkgPT09ICdjYWxlbmRhcicpIHsgaWYgKG5zLmNhbGVuZGFyLmlzU3RhbGUoKSkgbnMuY2FsZW5kYXIubG9hZCgpOyB9CiAgICAgIGVsc2UgbnMuYm9hcmQucmVmcmVzaElmU3RhbGUoKTsKICAgIH0pOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BhZ2VoaWRlJywgKCkgPT4gbnMubm90ZXMuZmx1c2goKSk7CgogICAgLy8gT25lIGNhbGwgdG8gdGhlIHNjcmlwdCwgc2VudCBiZWZvcmUgYW55dGhpbmcgZWxzZSAocmVtb3RlLmpzKS4gV2l0aAogICAgLy8gdGhlIHBob25lJ3MgY29weSBvZiB0aGUgbm90ZXMsIHRoZSBhcHAgb3BlbnMgb24gdGhhdCBhdCBvbmNlIGFuZCB0aGUKICAgIC8vIGNhbGwg",
"Y2F0Y2hlcyBpdCB1cDsgd2l0aG91dCBvbmUgKGEgZmlyc3QgdmlzaXQpLCBpdCB3YWl0cyBmb3IgaXQuCiAgICBjb25zdCByZW1vdGUgPSBucy5hcHBSZW1vdGU7CiAgICBjb25zdCBiZWd1biA9IHJlbW90ZS5zdGFydCgpOwogICAgY29uc3Qgc2hvdyA9ICgpID0-IHsKICAgICAgbnMuYm9hcmQub3BlbigpOwogICAgICBjb25zdCBib290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Jvb3QnKTsKICAgICAgaWYgKGJvb3QpIGJvb3QucmVtb3ZlKCk7CiAgICAgIG1hcmsoJ3JlYWR5Jyk7CiAgICB9OwogICAgY29uc3QgY2F1Z2h0VXAgPSByID0-IHsKICAgICAgbWFyaygnY2hlY2tlZCcpOwogICAgICBpZiAoci5vdGhlckFjY291bnQgJiYgd2luZG93Ll9fYm9vdEZhaWxlZCkgewogICAgICAgIHdpbmRvdy5fX2Jvb3RGYWlsZWQoJ1RoaXMgcGhvbmUgaGFkIG5vdGVzIGZyb20gYW5vdGhlciBHb29nbGUgYWNjb3VudCwgbm93IGNsZWFyZWQuIENsb3NlIHRoZSBhcHAgYW5kIG9wZW4gaXQgYWdhaW4uJyk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIG5zLm5vdGVzLnNjcmF0Y2hGb3VuZChyLnNjcmF0Y2gpOwogICAgfTsKICAgIGxldCBwb2xscyA9IDA7CiAgICBjb25zdCBsaXN0ZWQgPSAoKSA9PiB7CiAgICAgIGlmIChucy5ub3Rlcy5sb2FkZWRBdCgpKSBtYXJrKCdsaXN0ZWQnKTsKICAgICAgZWxzZSBpZiAoKytwb2xscyA8IDMwMCkgc2V0VGltZW91dChsaXN0ZWQsIDIwMCk7CiAgICB9OwogICAgbGlz",
"dGVkKCk7CiAgICBpZiAocmVtb3RlLmhhc0NvcHkoKSkgewogICAgICBzaG93KCk7CiAgICAgIC8vIE9mZmxpbmUsIG9yIHRoZSBzY3JpcHQgdW5yZWFjaGFibGU6IHRoZSBjb3B5IGNhcnJpZXMgb24sIGFuZCB0aGUKICAgICAgLy8gbm90ZXMnIG93biBsb2FkaW5nIHNheXMgd2hhdCBpcyB3cm9uZy4KICAgICAgcmV0dXJuIGJlZ3VuLnRoZW4oY2F1Z2h0VXAsIGVyciA9PiBjb25zb2xlLndhcm4oYFRoZSBmaXJzdCBjYWxsIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7CiAgICB9CiAgICByZXR1cm4gYmVndW4udGhlbihyID0-IHsKICAgICAgc2hvdygpOwogICAgICBjYXVnaHRVcChyKTsKICAgIH0sIGVyciA9PiB7CiAgICAgIGlmICh3aW5kb3cuX19ib290RmFpbGVkKSB3aW5kb3cuX19ib290RmFpbGVkKGBHbWFpbCBjb3VsZCBub3QgYmUgcmVhY2hlZDogJHtlcnIubWVzc2FnZX1gKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcnVuKCkgewogICAgdHJ5IHsKICAgICAgc3RhcnQoKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBjb25zb2xlLmVycm9yKGVycik7CiAgICAgIGlmICh3aW5kb3cuX19ib290RmFpbGVkKSB3aW5kb3cuX19ib290RmFpbGVkKGVyci5tZXNzYWdlLCBlcnIuc3RhY2spOwogICAgfQogIH0KCiAgbnMucGhvbmVBcHAgPSB7IHN0YXJ0IH07CiAgaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09ICdsb2FkaW5nJykgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRl",
"ZCcsIHJ1bik7CiAgZWxzZSBydW4oKTsKfSkoKTsK\"]];\n  var SOURCE = String.fromCharCode(10, 47, 47) + '# sourceURL=app/';\n  function decode(text) {\n    var bin = atob(text.replace(/-/g, '+').replace(/_/g, String.fromCharCode(47)));\n    var bytes = new Uint8Array(bin.length);\n    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n    return new TextDecoder('utf-8').decode(bytes);\n  }\n  function run(name, code) {\n    try {\n      (0, eval)(code + SOURCE + name);\n    } catch (err) {\n      if (!(err instanceof EvalError)) throw err;\n      var el = document.createElement('script');\n      el.text = code + SOURCE + name;\n      document.head.appendChild(el);\n    }\n  }\n  var failed = [];\n  for (var i = 0; i < MODULES.length; i++) {\n    try {\n      run(MODULES[i][0], decode(MODULES[i][1]));\n    } catch (err) {\n      failed.push(MODULES[i][0] + ': ' + err.message);\n    }\n  }\n  if (failed.length) {\n    window.__partsFailed = failed;\n    if (window.__bootFailed) window.__bootFailed('Parts th",
"at did not load: ' + failed.join('; '));\n  }\n})();\n</script>\n</body>\n</html>\n",
].join('');
