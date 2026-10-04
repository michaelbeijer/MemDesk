// ─────────────────────────────────────────────────────────────────────
// A stand-in for Apps Script, to run the phone panel's Code.gs in Node
//
// - The bundle runs in a fresh V8 context with nothing but JavaScript's
//   own globals - no btoa, TextEncoder, URL or crypto - which is what
//   Apps Script gives it, so a missing shim fails here first.
// - CardService is strict: a builder method Google's CardService does not
//   have throws, as it would there; a card that Gmail would refuse (an
//   empty section, a dropdown with two items selected, a button with no
//   action, tags a card cannot show, an action naming no function) fails
//   when it is built.
// - UrlFetchApp sends each request to the fake Gmail that the browser
//   preview uses (dev/mock-chrome.js), which keeps the same rules as the
//   real one closely enough to check what the panel does to a mailbox.
// - A Phone drives the cards the way a person would: open an email,
//   press a button - with the event objects Gmail sends.
// ─────────────────────────────────────────────────────────────────────

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));
const { AUTHORIZE_URL, urlFetch, htmlService, propertiesService, scriptApp } = require('../../dev/apps-script-services.js');
const WHITELIST = JSON.parse(read('addon/appsscript.json')).urlFetchWhitelist;

// ── The fake Gmail ───────────────────────────────────────────────────

function fakeGmail(search = '') {
  const ctx = {
    location: { search, href: `http://localhost/dev/preview.html${search}` },
    URL, URLSearchParams, TextEncoder, TextDecoder, btoa, atob, structuredClone, console, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    dispatchEvent() { return true; },
    addEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['src/lib/util.js', 'src/lib/notes-logic.js', 'src/lib/calendar-logic.js', 'dev/mock-chrome.js']) vm.runInContext(read(f), ctx, { filename: f });
  return { box: ctx.__fakeGmail, route: ctx.__mockChrome.route, googleRoute: ctx.__mockChrome.googleRoute, calendar: ctx.__fakeCalendar };
}

// ── CardService ──────────────────────────────────────────────────────

const METHODS = {
  CardBuilder: ['setHeader', 'addSection', 'setFixedFooter', 'setName', 'addCardAction', 'setDisplayStyle', 'setPeekCardHeader'],
  CardHeader: ['setTitle', 'setSubtitle', 'setImageUrl', 'setImageStyle', 'setImageAltText'],
  CardSection: ['setHeader', 'addWidget', 'setCollapsible', 'setNumUncollapsibleWidgets'],
  TextParagraph: ['setText'],
  DecoratedText: ['setText', 'setTopLabel', 'setBottomLabel', 'setWrapText', 'setOnClickAction', 'setSwitchControl', 'setButton',
    'setStartIcon', 'setEndIcon', 'setOpenLink'],
  Switch: ['setFieldName', 'setValue', 'setSelected', 'setControlType', 'setOnChangeAction'],
  TextInput: ['setFieldName', 'setTitle', 'setHint', 'setMultiline', 'setValue', 'setOnChangeAction'],
  SelectionInput: ['setType', 'setTitle', 'setFieldName', 'addItem', 'setOnChangeAction'],
  TextButton: ['setText', 'setOnClickAction', 'setOpenLink', 'setTextButtonStyle', 'setDisabled'],
  ButtonSet: ['addButton'],
  FixedFooter: ['setPrimaryButton', 'setSecondaryButton'],
  Action: ['setFunctionName', 'setParameters', 'setLoadIndicator'],
  ActionResponseBuilder: ['setNavigation', 'setNotification', 'setStateChanged', 'setOpenLink'],
  Navigation: ['pushCard', 'popCard', 'updateCard', 'popToRoot', 'popToNamedCard'],
  Notification: ['setText'],
  UniversalActionResponseBuilder: ['displayAddOnCards', 'setOpenLink'],
  Divider: [],
};
const BUILDS = new Set(['CardBuilder', 'ActionResponseBuilder', 'UniversalActionResponseBuilder']);
const ENUMS = {
  SwitchControlType: ['SWITCH', 'CHECK_BOX'],
  SelectionInputType: ['CHECK_BOX', 'RADIO_BUTTON', 'DROPDOWN', 'SWITCH', 'MULTI_SELECT'],
  TextButtonStyle: ['TEXT', 'FILLED'],
  LoadIndicator: ['SPINNER', 'NONE'],
  ImageStyle: ['SQUARE', 'CIRCLE'],
};
// What card text may contain: Google's list for add-on cards.
const TAG_RE = /<\/?([a-zA-Z]+)([^>]*)>/g;
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'font', 'a', 'br']);

const KIND = Symbol('kind');

function cardService(isFunction) {
  function make(kind) {
    const node = { [KIND]: kind, calls: [] };
    for (const m of METHODS[kind]) {
      node[m] = (...args) => {
        node.calls.push([m, args]);
        return node;
      };
    }
    if (BUILDS.has(kind)) node.build = () => toTree(node);
    return new Proxy(node, {
      get(t, prop) {
        if (prop in t || typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return t[prop];
        throw new TypeError(`CardService ${kind} has no method ${String(prop)}`);
      },
    });
  }

  function toTree(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(toTree);
    if (!node[KIND]) return node; // plain values, and cards already built
    const kind = node[KIND];
    const out = { kind };
    for (const [m, args] of node.calls) {
      const key = m.replace(/^(set|add)/, '').replace(/^./, c => c.toLowerCase());
      if (m === 'addItem') (out.items = out.items || []).push({ text: args[0], value: args[1], selected: !!args[2] });
      else if (m.startsWith('add')) (out[`${key}s`] = out[`${key}s`] || []).push(toTree(args[0]));
      else if (kind === 'Navigation') (out.ops = out.ops || []).push({ op: m, card: toTree(args[0]) });
      else if (m === 'displayAddOnCards') out.cards = args[0].map(toTree);
      else out[key] = toTree(args[0]);
    }
    validate(out);
    if (BUILDS.has(kind)) out.built = true;
    return out;
  }

  function checkHtml(where, html) {
    if (typeof html !== 'string' || !html.replace(/<[^>]+>/g, '').trim()) throw new Error(`${where}: no text`);
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(html))) {
      if (!ALLOWED_TAGS.has(m[1].toLowerCase())) throw new Error(`${where}: a card cannot show <${m[1]}>`);
    }
  }

  function validate(n) {
    switch (n.kind) {
      case 'CardBuilder':
        if (!n.sections || !n.sections.length) throw new Error('A card needs a section');
        if (n.header && !n.header.title) throw new Error('A card header needs a title');
        if (n.fixedFooter && !n.fixedFooter.primaryButton) throw new Error('A fixed footer needs a primary button');
        {
          const names = fields(n).map(f => f.fieldName);
          const dup = names.find((x, i) => names.indexOf(x) !== i);
          if (dup) throw new Error(`Two inputs are both called ${dup}`);
        }
        break;
      case 'CardSection':
        if (!n.widgets || !n.widgets.length) throw new Error('A card section needs a widget');
        break;
      case 'TextParagraph': checkHtml('TextParagraph', n.text); break;
      case 'DecoratedText':
        checkHtml('DecoratedText', n.text);
        if (n.switchControl && n.onClickAction) throw new Error('DecoratedText: a switch and a click action together');
        break;
      case 'Switch':
        if (!n.fieldName || n.value === undefined) throw new Error('Switch: needs a field name and a value');
        if (!['SwitchControlType.SWITCH', 'SwitchControlType.CHECK_BOX', undefined].includes(n.controlType)) throw new Error('Switch: bad control type');
        break;
      case 'TextInput':
        if (!n.fieldName || !n.title) throw new Error('TextInput: needs a field name and a title');
        break;
      case 'SelectionInput':
        if (!n.fieldName || !n.title || !n.type) throw new Error('SelectionInput: needs a field name, title and type');
        if (!n.items || !n.items.length) throw new Error('SelectionInput: needs items');
        if (n.items.some(i => typeof i.value !== 'string' || !i.value)) throw new Error('SelectionInput: every item needs a value');
        if (n.type === 'SelectionInputType.DROPDOWN' && n.items.filter(i => i.selected).length > 1) throw new Error('Dropdown: two items selected');
        break;
      case 'TextButton':
        if (!n.text) throw new Error('TextButton: needs text');
        if (!n.onClickAction && !n.openLink) throw new Error(`TextButton ${n.text}: does nothing`);
        break;
      case 'Action':
        if (!n.functionName || !isFunction(n.functionName)) throw new Error(`Action: no function called ${n.functionName}`);
        for (const [k, v] of Object.entries(n.parameters || {})) {
          if (typeof v !== 'string' || !v) throw new Error(`Action ${n.functionName}: parameter ${k} is not a non-empty string`);
        }
        break;
      case 'Navigation':
        if (!n.ops || n.ops.length !== 1) throw new Error('Navigation: one step at a time here');
        break;
      case 'Notification':
        if (!n.text) throw new Error('Notification: needs text');
        break;
      default:
    }
  }

  const service = {};
  for (const kind of Object.keys(METHODS)) service[`new${kind}`] = () => make(kind);
  for (const [name, values] of Object.entries(ENUMS)) {
    service[name] = Object.fromEntries(values.map(v => [v, `${name}.${v}`]));
  }
  return new Proxy(service, {
    get(t, prop) {
      if (prop in t || typeof prop === 'symbol') return t[prop];
      throw new TypeError(`CardService has no ${String(prop)}`);
    },
  });
}

// ── Reading built cards ──────────────────────────────────────────────

function widgets(card) {
  return (card.sections || []).flatMap(s => s.widgets || []);
}

function fields(card) {
  const out = [];
  for (const w of widgets(card)) {
    if (w.kind === 'TextInput' || w.kind === 'SelectionInput') out.push(w);
    if (w.kind === 'DecoratedText' && w.switchControl) out.push(w.switchControl);
  }
  return out;
}

const stripTags = s => String(s || '').replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// ── The add-on, loaded ───────────────────────────────────────────────

function loadAddon(fake) {
  const log = [];
  const logged = [];
  const sandbox = {
    console: { log: () => {}, info: () => {}, warn: m => logged.push(['warn', String(m)]), error: m => logged.push(['error', String(m)]) },
    UrlFetchApp: urlFetch(fake, log, WHITELIST),
    ScriptApp: scriptApp(fake),
    HtmlService: htmlService(),
    PropertiesService: propertiesService(fake),
  };
  sandbox.CardService = cardService(name => typeof sandbox[name] === 'function');
  vm.createContext(sandbox);
  vm.runInContext(read('addon/Code.gs'), sandbox, { filename: 'Code.gs' });
  return { addon: sandbox, log, logged };
}

// ── A phone, holding the add-on ──────────────────────────────────────

class Phone {
  // A second phone on the same mailbox: new Phone({ fake: first.fake }).
  constructor({ search = '', fake = null } = {}) {
    this.fake = fake || fakeGmail(search);
    const { addon, log, logged } = loadAddon(this.fake);
    this.addon = addon;
    this.log = log;
    this.logged = logged;
    this.stack = [];
    this.toasts = [];
    this.edits = {};
    this.messageId = '';
  }

  get card() { return this.stack[this.stack.length - 1]; }

  show(cards) {
    const list = plain(cards);
    if (!Array.isArray(list) || !list.length || !list[0].built) throw new Error('A trigger must return built cards');
    this.stack = [list[0]];
    this.edits = {};
    return this.card;
  }

  // Opening a message with the panel open: what Gmail's trigger does. It
  // says which conversation is open as well, unless `threadId` says
  // otherwise ('' for not at all).
  openMessage(messageId, { threadId, platform = 'ANDROID' } = {}) {
    this.messageId = messageId;
    let thread = threadId;
    if (thread === undefined) {
      const msg = this.fake.box.allMessages().find(m => m.id === messageId);
      thread = msg ? msg.threadId : '';
    }
    return this.show(this.addon.onGmailMessage({
      commonEventObject: { hostApp: 'GMAIL', platform },
      gmail: { messageId, threadId: thread, accessToken: 'message-token' },
    }));
  }

  openHome() {
    this.messageId = '';
    return this.show(this.addon.onHomepage({ commonEventObject: { hostApp: 'GMAIL', platform: 'WEB' } }));
  }

  // The form as Gmail would send it: every input on the card, with what
  // has been typed or chosen since it was drawn.
  formInputs() {
    const out = {};
    for (const f of fields(this.card)) {
      let v;
      if (f.fieldName in this.edits) v = this.edits[f.fieldName];
      else if (f.kind === 'TextInput') v = f.value || '';
      else if (f.kind === 'SelectionInput') v = (f.items.find(i => i.selected) || f.items[0]).value;
      else v = f.selected ? f.value : null; // a switch
      if (f.kind === 'Switch' && f.fieldName in this.edits) v = this.edits[f.fieldName] ? f.value : null;
      if (v === null || v === '') continue;
      out[f.fieldName] = { stringInputs: { value: [String(v)] } };
    }
    return out;
  }

  field(name) {
    const f = fields(this.card).find(x => x.fieldName === name);
    if (!f) throw new Error(`No input called ${name} on the card`);
    return f;
  }

  fill(name, text) {
    if (this.field(name).kind !== 'TextInput') throw new Error(`${name} is not a text box`);
    this.edits[name] = text;
  }

  choose(name, text) {
    const f = this.field(name);
    const item = f.items.find(i => i.text === text || i.value === text);
    if (!item) throw new Error(`${name} has no item ${text}: ${f.items.map(i => i.text).join(', ')}`);
    this.edits[name] = item.value;
    if (f.onChangeAction) return this.run(f.onChangeAction);
    return null;
  }

  // Presses a button, or taps a list item, by its text.
  press(label) {
    const card = this.card;
    const buttons = widgets(card).flatMap(w => (w.kind === 'ButtonSet' ? w.buttons : w.kind === 'TextButton' ? [w] : []));
    if (card.fixedFooter) buttons.push(card.fixedFooter.primaryButton, card.fixedFooter.secondaryButton);
    const b = buttons.find(x => x && x.text === label);
    if (b) return this.run(b.onClickAction);
    const item = widgets(card).find(w => w.kind === 'DecoratedText' && w.onClickAction && stripTags(w.text).split('\n')[0] === label);
    if (item) return this.run(item.onClickAction);
    throw new Error(`Nothing called “${label}” on the card “${card.header ? card.header.title : card.name}”`);
  }

  run(action) {
    const e = {
      commonEventObject: { hostApp: 'GMAIL', platform: 'ANDROID', parameters: action.parameters || {}, formInputs: this.formInputs() },
      gmail: this.messageId ? { messageId: this.messageId, accessToken: 'message-token' } : undefined,
    };
    const r = plain(this.addon[action.functionName](e));
    if (r.kind !== 'ActionResponseBuilder') throw new Error(`${action.functionName} did not return an action response`);
    if (r.notification) this.toasts.push(r.notification.text);
    if (r.navigation) {
      const [{ op, card }] = r.navigation.ops;
      if (op === 'pushCard') this.stack.push(card);
      else if (op === 'updateCard') this.stack[this.stack.length - 1] = card;
      else if (op === 'popCard') this.stack.pop();
      this.edits = {};
    }
    return r;
  }

  back() {
    if (this.stack.length < 2) throw new Error('Nothing to go back to');
    this.stack.pop();
    this.edits = {};
  }

  get toast() { return this.toasts[this.toasts.length - 1] || ''; }

  // What the card says, line by line, ticked boxes as [x].
  lines() {
    const out = [];
    for (const w of widgets(this.card)) {
      if (w.kind === 'TextParagraph') out.push(...stripTags(w.text).split('\n'));
      if (w.kind === 'DecoratedText') {
        const box = w.switchControl ? (w.switchControl.selected ? '[x] ' : '[ ] ') : '';
        out.push(box + stripTags(w.text));
      }
    }
    return out;
  }

  // The buttons on the card, in order; a filled one as "[Doing]".
  buttons() {
    return widgets(this.card).flatMap(w => (w.kind === 'ButtonSet' ? w.buttons : w.kind === 'TextButton' ? [w] : []))
      .map(b => (b.textButtonStyle === 'TextButtonStyle.FILLED' ? `[${b.text}]` : b.text));
  }

  // The Gmail requests made, as "GET labels", "POST threads/…/modify".
  requests() {
    return this.log.filter(l => !l.service).map(l => `${l.method} ${l.path}`);
  }

  // How many times the script waited on Google.
  roundTrips() {
    return new Set(this.log.map(l => l.round)).size;
  }

  writes() {
    return this.log.filter(l => l.method !== 'GET');
  }

  // A server function, as google.script.run calls it from the phone app:
  // arguments and answer pass through JSON on the way.
  server(fn, ...args) {
    if (typeof this.addon[fn] !== 'function') throw new Error(`No server function ${fn}`);
    return plain(this.addon[fn](...plain(args)));
  }
}

module.exports = { AUTHORIZE_URL, Phone, fakeGmail, loadAddon, stripTags, widgets, fields, plain };
