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
