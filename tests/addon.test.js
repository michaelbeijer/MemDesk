// The phone panel, end to end: addon/Code.gs as Apps Script would run it,
// against the fake Gmail the browser preview uses, driven like a phone.
// See tests/helpers/apps-script.js for what is checked along the way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Phone, loadAddon, plain } = require('./helpers/apps-script.js');

const live = (p, noteId) => plain(p.fake.box.notesWithId(noteId)).filter(n => !n.labels.includes('TRASH'));
const all = (p, noteId) => plain(p.fake.box.notesWithId(noteId));
const idOf = (p, noteId) => live(p, noteId)[0].id;
const html = (p, id) => p.fake.box.messageHtml(id);
const inserts = p => p.writes().filter(w => w.method === 'POST' && w.path === 'messages');
const listSection = p => p.card.sections[p.card.sections.length - 1];
const sectionHeaders = p => p.card.sections.map(s => s.header || '');
// The first message of the seeded thread whose subject contains `part`.
const mailAbout = (p, part) => {
  const threadId = p.fake.box.findThread(part);
  return { threadId, messageId: p.fake.box.thread(threadId).messages[0].id };
};
const threadLabels = (p, threadId) => plain(p.fake.box.threadLabelNames(threadId));
const columnOf = p => p.field('boardColumn').items.find(i => i.selected).text;

// ── The bundle ───────────────────────────────────────────────────────

test('Code.gs is built from the current sources', async () => {
  const { bundle } = await import('../tools/build-addon.mjs');
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'addon', 'Code.gs'), 'utf8'), bundle(),
    'run node tools/build-addon.mjs');
});

test('the manifest names functions the bundle has, and asks for no more than it uses', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'addon', 'appsscript.json'), 'utf8'));
  const { addon } = loadAddon(new Phone().fake);
  const named = [
    manifest.addOns.common.homepageTrigger.runFunction,
    ...manifest.addOns.common.universalActions.map(a => a.runFunction),
    ...manifest.addOns.gmail.contextualTriggers.map(t => t.onTriggerFunction),
  ];
  for (const fn of named) assert.equal(typeof addon[fn], 'function', fn);
  assert.deepEqual(manifest.oauthScopes.sort(), [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.addons.current.message.metadata',
    'https://www.googleapis.com/auth/gmail.addons.execute',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/tasks.readonly',
  ]);
  assert.deepEqual(manifest.urlFetchWhitelist, [
    'https://gmail.googleapis.com/', 'https://www.googleapis.com/calendar/', 'https://tasks.googleapis.com/',
  ]);
  // The advanced services are what switch the APIs on in the script's own
  // Cloud project; the calls themselves go through UrlFetchApp.
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices.map(s => s.serviceId).sort(), ['calendar', 'gmail', 'tasks']);
  // Settings that make Gmail demand a scope of their own. useLocaleFromApp
  // needs script.locale, and without it Gmail refuses to run the add-on
  // at all ("Run time error ... Required permissions: script.locale").
  const needs = { useLocaleFromApp: 'https://www.googleapis.com/auth/script.locale' };
  for (const [setting, scope] of Object.entries(needs)) {
    if (manifest.addOns.common[setting]) assert.ok(manifest.oauthScopes.includes(scope), `${setting} needs ${scope}`);
  }
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(typeof addon.btoa, 'function', 'the shims filled in what the runtime lacks');
  assert.equal(typeof addon.URL, 'function');
});

// ── Opening ──────────────────────────────────────────────────────────

test('opening a note shows its text, a box for each checklist item, its folder', () => {
  const p = new Phone();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  assert.equal(p.card.header.title, 'Launch checklist');
  assert.deepEqual(p.lines(), [
    'Before Friday', 'Deliver to Kestrel by noon, see the portal.',
    '[x] Proofread the IFU', '[ ] Send the invoice', '[ ] \u2003\u2003Check the PO number', // indented a level
    '1.\u2002Zip the files', '2.\u2002Upload', '~~not struck~~ and **not bold**',
  ]);
  assert.equal(p.field('find').title, 'Find in this note', 'Find comes first');
  const body = p.card.sections[1].widgets[0].text;
  assert.match(body, /<b>Kestrel<\/b> by <i>noon<\/i>, see <a href="https:\/\/example\.com\/portal">the portal<\/a>/);
  assert.equal(p.field('addAs').items.find(i => i.selected).value, 'check', 'a checklist note adds checklist items');
  assert.equal(p.field('folder').items.find(i => i.selected).text, 'No folder');
  assert.deepEqual(p.field('folder').items.map(i => i.text), ['No folder', 'Empty', 'Personal', 'Work', 'Work › Clients']);
  assert.equal(p.writes().length, 0, 'looking changes nothing');
});

test('opening any other email shows the newest notes, one entry each', () => {
  const p = new Phone();
  const mail = p.fake.box.threadsInInbox()[0].messages[0].id;
  p.openMessage(mail);
  assert.equal(p.card.name, 'home');
  assert.deepEqual(p.listTitles(), [
    'Ideas for the October newsletter', 'Shopping list', 'Launch checklist', 'Kestrel glossary decisions', 'Rate schedule 2027 – draft',
  ], 'newest first, and the Kestrel note once, though two versions are live');
  const kestrel = listSection(p).widgets.find(w => w.text === 'Kestrel glossary decisions');
  assert.match(kestrel.topLabel, /^Work › Clients · edited /);
  assert.match(kestrel.bottomLabel, /^Stent coating project/);
  assert.deepEqual(p.writes(), []);
});

test('Gmail\'s decimal message ids open the same note', () => {
  const p = new Phone();
  const id = idOf(p, 'launchchecklist0004');
  p.openMessage(`msg-f:${BigInt(`0x${id}`).toString()}`);
  assert.equal(p.card.header.title, 'Launch checklist');
});

test('an older version, or one in Trash, opens as the latest', () => {
  const p = new Phone();
  const versions = all(p, 'kestrelglossary0001');
  const older = versions.find(v => /older draft/.test(v.text));
  p.openMessage(older.id);
  assert.match(p.lines().join('\n'), /coating" stays "coating"/, 'the newer of the two live versions');
  assert.match(p.lines()[0], /latest version/);

  const before = idOf(p, 'launchchecklist0004');
  p.openMessage(before);
  p.tick(p.boxFor('Send the invoice'));
  p.press('Save');
  p.openMessage(before); // the old version, now in Trash
  assert.match(p.lines()[0], /latest version/);
  assert.ok(p.lines().includes('[x] Send the invoice'));
});

// ── Saving ───────────────────────────────────────────────────────────

test('ticking a box and saving: a new version, the old one in Trash, every bit of formatting kept', () => {
  const p = new Phone();
  const before = idOf(p, 'launchchecklist0004');
  p.openMessage(before);
  p.tick(p.boxFor('Send the invoice'));
  p.tick(p.boxFor('Proofread the IFU'), false);
  p.press('Save');
  assert.equal(p.toast, 'Saved.');
  const now = live(p, 'launchchecklist0004');
  assert.equal(now.length, 1);
  assert.notEqual(now[0].id, before);
  assert.ok(all(p, 'launchchecklist0004').find(v => v.id === before).labels.includes('TRASH'), 'the old version is in Trash');
  const h = html(p, now[0].id);
  assert.match(h, /data-checked="0"><span data-glyph="1">☐&nbsp;<\/span>Proofread the IFU/);
  assert.match(h, /data-checked="1"><span data-glyph="1">☑&nbsp;<\/span>Send the invoice/);
  assert.match(h, /<h2[^>]*>Before Friday<\/h2>/);
  assert.match(h, /<b>Kestrel<\/b>/);
  assert.match(h, /<a href="https:\/\/example\.com\/portal">the portal<\/a>/);
  assert.match(h, /<ol[^>]*><li[^>]*>Zip the files<\/li><li[^>]*>Upload<\/li><\/ol>/);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(now[0].id)), ['_Notes']);
  assert.equal(p.fake.box.messageHeader(now[0].id, 'From'), '"Notes" <notes@notes.invalid>', 'never from the account: not under Sent');
  assert.deepEqual(p.checkboxes().map(c => c.ticked), [false, true, false], 'the card shows what was saved');
  assert.equal(p.card.fixedFooter.primaryButton.onClickAction.parameters.messageId, now[0].id, 'and saves onto it next time');
});

test('adding lines: checklist items at the end, or text read as a paste would be', () => {
  const p = new Phone();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  p.fill('add', 'Book the courier\n\n  [x] Courier booked\n');
  p.press('Save');
  assert.deepEqual(p.lines().slice(-2), ['[ ] Book the courier', '[x] \u2003\u2003Courier booked']);
  p.fill('add', '**Remember** the PO\n- and the IFU');
  p.choose('addAs', 'Text');
  p.press('Save');
  const h = html(p, idOf(p, 'launchchecklist0004'));
  assert.match(h, /<p[^>]*><b>Remember<\/b> the PO<\/p>/);
  assert.match(h, /<ul[^>]*><li[^>]*>and the IFU<\/li><\/ul><\/div>$/);
  assert.equal(p.field('add').value, undefined, 'the box is empty again');
});

test('changing only the folder moves the note, with no new version', () => {
  const p = new Phone();
  const id = idOf(p, 'rateschedule00000003');
  p.openMessage(id);
  p.choose('folder', 'Work › Clients');
  p.press('Save');
  assert.equal(p.toast, 'Moved to Work › Clients.');
  assert.equal(inserts(p).length, 0);
  assert.deepEqual(plain(p.fake.box.messageFolders(id)), ['_Notes/Work/Clients']);
  assert.ok(plain(p.fake.box.messageLabelNames(id)).includes('_Notes'));
  assert.match(p.card.header.subtitle, /^Work › Clients/);
  p.choose('folder', 'No folder');
  p.press('Save');
  assert.equal(p.toast, 'Taken out of its folder.');
  assert.deepEqual(plain(p.fake.box.messageFolders(id)), []);
});

test('ticks, lines and a folder in one save: one new version, in the new folder', () => {
  const p = new Phone();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  p.tick(p.boxFor('Check the PO number'));
  p.fill('add', 'Archive the project');
  p.choose('folder', 'Personal');
  p.press('Save');
  const [now] = live(p, 'launchchecklist0004');
  assert.equal(inserts(p).length, 1);
  assert.deepEqual(plain(p.fake.box.messageFolders(now.id)), ['_Notes/Personal']);
  assert.match(now.text, /☑ Check the PO number[\s\S]*☐ Archive the project$/);
});

test('nothing changed, nothing saved', () => {
  const p = new Phone();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  p.fill('add', '  \n ');
  p.press('Save');
  assert.equal(p.toast, 'Nothing to save.');
  assert.deepEqual(p.writes(), []);
});

test('a note changed on another device is not overwritten: the latest is shown, with the typed lines kept', () => {
  const phone = new Phone();
  const laptop = new Phone({ fake: phone.fake });
  const id = idOf(phone, 'launchchecklist0004');
  phone.openMessage(id);
  laptop.openMessage(id);
  laptop.tick(laptop.boxFor('Send the invoice'));
  laptop.press('Save');

  phone.tick(phone.boxFor('Check the PO number'));
  phone.fill('add', 'Ring Sam');
  phone.press('Save');
  assert.equal(phone.toast, 'Not saved: the note had changed.');
  assert.equal(inserts(phone).length, 0);
  assert.ok(phone.lines()[0].includes('changed somewhere else'));
  assert.ok(phone.lines().includes('[x] Send the invoice'), "the laptop's tick");
  assert.equal(phone.field('add').value, 'Ring Sam', 'what was being added is still there');

  phone.tick(phone.boxFor('Check the PO number'));
  phone.press('Save');
  assert.equal(phone.toast, 'Saved.');
  const [now] = live(phone, 'launchchecklist0004');
  assert.match(now.text, /☑ Send the invoice\n  ☑ Check the PO number[\s\S]*☐ Ring Sam$/);
});

test('an email kept as a note becomes a note of ours when saved, and the email stays where it was', () => {
  const p = new Phone();
  const mail = p.fake.box.findMessageBySubject('Shopping list');
  p.openMessage(mail);
  assert.match(p.card.header.subtitle, /an email kept as a note/);
  assert.equal(p.field('addAs').items.find(i => i.selected).value, 'p');
  p.fill('add', 'Milk');
  p.choose('addAs', 'Bullets');
  p.press('Save');
  const fresh = p.fake.box.findMessageBySubject('Shopping list');
  assert.notEqual(fresh, mail);
  assert.match(p.fake.box.messageHeader(fresh, 'X-Gkb-Note'), /^[a-z0-9]{12,40}$/);
  assert.equal(p.fake.box.messageText(fresh), 'For the weekend\n• Espresso beans\n• Stroopwafels\n• Milk');
  assert.deepEqual(plain(p.fake.box.messageLabelNames(mail)), [], 'out of the notes, not in Trash');
});

// ── The list, and new notes ──────────────────────────────────────────

test('the list: a folder at a time, and Gmail search', () => {
  const p = new Phone();
  p.openHome();
  p.choose('folderFilter', 'Work');
  assert.deepEqual(p.listTitles(), ['Ideas for the October newsletter']);
  assert.equal(listSection(p).header, 'Work');
  p.choose('folderFilter', 'All notes');
  p.fill('q', 'stroopwafels');
  p.press('Search');
  assert.deepEqual(p.listTitles(), ['Shopping list']);
  assert.equal(listSection(p).header, 'All notes: “stroopwafels”');
  p.fill('q', 'nothing-like-this');
  p.press('Search');
  assert.deepEqual(p.lines(), ['No notes match that search.']);
});

test('tapping a note in the list opens it; back returns to the list', () => {
  const p = new Phone();
  p.openHome();
  p.press('Rate schedule 2027 – draft');
  assert.equal(p.card.header.title, 'Rate schedule 2027 – draft');
  assert.equal(p.stack.length, 2);
  p.back();
  assert.equal(p.card.name, 'home');
});

test('a new note, from the list of a folder: in that folder, its lines a checklist', () => {
  const p = new Phone();
  p.openHome();
  p.choose('folderFilter', 'Work');
  p.press('New note');
  assert.equal(p.field('folder').items.find(i => i.selected).text, 'Work');
  p.fill('title', 'Phone note');
  p.fill('body', 'milk\neggs\n[x] bread');
  p.choose('bodyAs', 'Checklist items');
  p.press('Save note');
  assert.equal(p.toast, 'Note saved.');
  assert.equal(p.card.header.title, 'Phone note');
  assert.deepEqual(p.lines(), ['[ ] milk', '[ ] eggs', '[x] bread']);
  const id = p.fake.box.findMessageBySubject('Phone note');
  assert.deepEqual(plain(p.fake.box.messageLabelNames(id)), ['_Notes', '_Notes/Work']);
  assert.equal(p.fake.box.messageText(id), '☐ milk\n☐ eggs\n☑ bread');
});

test('a new note needs a title or some text; a title alone will do', () => {
  const p = new Phone();
  p.universal('onUniversalNewNote');
  p.press('Save note');
  assert.equal(p.toast, 'Write a title or some text first.');
  assert.equal(inserts(p).length, 0);
  p.fill('title', 'Just a title');
  p.press('Save note');
  assert.equal(p.toast, 'Note saved.');
  assert.deepEqual(plain(p.fake.box.messageLabelNames(p.fake.box.findMessageBySubject('Just a title'))), ['_Notes']);
});

test('All notes and New note from the menu, and from a note', () => {
  const p = new Phone();
  p.universal('onUniversalAllNotes');
  assert.equal(p.card.name, 'home');
  p.openMessage(idOf(p, 'kestrelglossary0001'));
  p.press('New note');
  assert.equal(p.card.name, 'new');
  assert.equal(p.field('folder').items.find(i => i.selected).text, 'Work › Clients', 'next to the note it came from');
  p.back();
  p.press('All notes');
  assert.equal(p.card.name, 'home');
});

test('a long note shows its first 80 lines, and the boxes after them keep their ticks', () => {
  const p = new Phone();
  p.openHome();
  p.press('New note');
  p.fill('title', 'Long list');
  p.fill('body', Array.from({ length: 100 }, (_, i) => (i >= 90 ? `[x] item ${i}` : `item ${i}`)).join('\n'));
  p.choose('bodyAs', 'Checklist items');
  p.press('Save note');
  assert.equal(p.checkboxes().length, 80);
  assert.match(p.lines().at(-1), /and 20 more lines/);
  p.tick(p.boxFor('item 0'));
  p.press('Save');
  const text = p.fake.box.messageText(p.fake.box.findMessageBySubject('Long list'));
  assert.match(text, /^☑ item 0\n☐ item 1/);
  assert.match(text, /☐ item 89\n☑ item 90[\s\S]*☑ item 99$/);
});

test('search results show where the words are, marked, with a count per note', () => {
  const p = new Phone();
  p.openHome();
  p.fill('q', 'kestrel');
  p.press('Search');
  const items = p.listItems();
  assert.deepEqual(items.map(i => i.title), ['Launch checklist', 'Kestrel glossary decisions']);
  const launch = items[0];
  assert.match(launch.topLabel, /· 1 match$/);
  assert.equal(launch.excerpts.length, 1);
  assert.match(launch.excerpts[0], /Deliver to Kestrel by noon/);
  assert.match(launch.excerptHtml[0], /<font color="#e8710a"><b>Kestrel<\/b><\/font>/, 'marked, inside the bold it already had');
  const kestrel = items[1];
  assert.match(kestrel.titleHtml, /^<font color="#e8710a"><b>Kestrel<\/b><\/font> glossary decisions$/, 'the title too');
  assert.match(kestrel.topLabel, /1 match$/);
  assert.deepEqual(p.marked(), ['Kestrel', 'Kestrel']);
});

test('a note opened from a search marks every match and says how many; saving keeps them marked', () => {
  const p = new Phone();
  p.openHome();
  p.fill('q', '"send the invoice" proofread');
  p.press('Search');
  p.press('Launch checklist');
  assert.equal(p.lines()[0], '2 matches for “"send the invoice" proofread”');
  assert.deepEqual(p.marked(), ['Proofread', 'Send the invoice']);
  p.tick(p.boxFor('Send the invoice'));
  p.press('Save');
  assert.equal(p.toast, 'Saved.');
  assert.deepEqual(p.marked(), ['Proofread', 'Send the invoice']);
  p.back();
  assert.throws(() => p.press('Rate schedule 2027 – draft'), /Nothing called/, 'only what was found is listed');
});

test('operators are not marked; a match in the title only is said; no search, no marks', () => {
  const p = new Phone();
  p.openHome();
  p.fill('q', 'from:anyone coating');
  p.press('Search');
  p.press('Kestrel glossary decisions');
  assert.equal(p.lines()[0], '3 matches for “from:anyone coating”');
  assert.deepEqual(p.marked(), ['coating', 'coating', 'coating'], 'from: is an operator, not a word');
  p.back();
  p.fill('q', 'kestrel glossary');
  p.press('Search');
  p.press('Kestrel glossary decisions');
  assert.equal(p.lines()[0], '“kestrel glossary” is in the title only');
  p.back();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  assert.deepEqual(p.marked(), []);
  assert.doesNotMatch(p.lines().join('\n'), /match/);
});

test('Find in this note marks the words, and can show only the lines with them', () => {
  const p = new Phone();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  p.fill('find', 'the');
  p.press('Find');
  assert.equal(p.lines()[0], '5 matches for “the”');
  assert.equal(p.marked().length, 5);
  assert.equal(p.field('find').value, 'the');
  p.fill('find', 'upload');
  p.press('Find');
  assert.deepEqual(p.marked(), ['Upload']);
  p.press('Only lines with it');
  assert.deepEqual(p.lines(), ['1 match for “upload” · only the lines with them', '2. Upload'], 'numbered as in the whole note');
  p.press('Whole note');
  assert.ok(p.lines().includes('[ ] Send the invoice'));
  p.press('Clear');
  assert.deepEqual(p.marked(), []);
  assert.equal(p.field('find').value, undefined);
  assert.doesNotMatch(p.lines().join('\n'), /match/);
  p.fill('find', 'nowhere');
  p.press('Find');
  p.press('Only lines with it');
  assert.deepEqual(p.lines(), ['“nowhere” is not in the text itself', 'No line has it.']);
  assert.deepEqual(p.writes(), [], 'finding changes nothing in Gmail');
});

test('Find keeps what was done on the card: ticks, lines to add, the folder - and Save still saves them all', () => {
  const p = new Phone();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  p.tick(p.boxFor('Send the invoice'));
  p.fill('add', 'Courier');
  p.choose('folder', 'Work');
  p.fill('find', 'upload');
  p.press('Find');
  assert.equal(p.checkboxes().find(c => c.text === 'Send the invoice').ticked, true);
  assert.equal(p.field('add').value, 'Courier');
  assert.equal(p.field('folder').items.find(i => i.selected).text, 'Work');
  p.press('Only lines with it');
  assert.deepEqual(p.checkboxes(), [], 'the ticked box is off the card now');
  p.press('Save');
  assert.equal(p.toast, 'Saved.');
  const [now] = live(p, 'launchchecklist0004');
  assert.match(now.text, /☑ Send the invoice/, 'the tick made before Find');
  assert.match(now.text, /☐ Courier$/);
  assert.deepEqual(plain(p.fake.box.messageFolders(now.id)), ['_Notes/Work']);
  assert.deepEqual(p.lines(), ['1 match for “upload” · only the lines with them', '2. Upload'], 'the view stays as it was');
});

// ── The board ────────────────────────────────────────────────────────

test('an email on the board shows its column first, and choosing another moves it at once', () => {
  const p = new Phone();
  const { threadId, messageId } = mailAbout(p, 'Quote request');
  p.openMessage(messageId);
  assert.equal(p.card.header.title, 'Board and notes');
  assert.deepEqual(sectionHeaders(p).slice(0, 2), ['This email on the board', 'Notes']);
  assert.deepEqual(p.field('boardColumn').items.map(i => i.text), ['Not on the board', 'To do', 'Doing', 'Waiting', 'Done']);
  assert.equal(columnOf(p), 'To do');

  p.choose('boardColumn', 'Doing');
  assert.equal(p.toast, 'Moved to Doing.');
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board')), ['_Board/Doing']);
  assert.ok(threadLabels(p, threadId).includes('INBOX'));
  assert.deepEqual(p.writes().map(w => `${w.method} ${w.path}`), [`POST threads/${threadId}/modify`], 'one call, on the whole conversation');

  p.choose('boardColumn', 'Done');
  assert.equal(p.toast, 'Moved to Done and archived.');
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board') || n === 'INBOX'), ['_Board/Done']);

  p.choose('boardColumn', 'Not on the board');
  assert.equal(p.toast, 'Taken off the board.');
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board') || n === 'INBOX'), [], 'off the board, and still archived');

  p.openMessage(messageId);
  assert.equal(columnOf(p), 'Not on the board', 'and that is what it shows next time');
});

test('an email not on the board can be put on it; one in two columns ends up in one', () => {
  const p = new Phone();
  const nda = mailAbout(p, '3,000-word NDA');
  p.openMessage(nda.messageId);
  assert.equal(columnOf(p), 'Not on the board');
  p.choose('boardColumn', 'To do');
  assert.deepEqual(threadLabels(p, nda.threadId).filter(n => n.startsWith('_Board')), ['_Board/To do']);

  const drawing = mailAbout(p, 'Drawing labels');
  assert.deepEqual(threadLabels(p, drawing.threadId).filter(n => n.startsWith('_Board')), ['_Board/To do', '_Board/Waiting']);
  p.openMessage(drawing.messageId);
  assert.equal(columnOf(p), 'To do', 'the first of its columns, as on the board');
  p.choose('boardColumn', 'Waiting');
  assert.deepEqual(threadLabels(p, drawing.threadId).filter(n => n.startsWith('_Board')), ['_Board/Waiting']);
});

test('searching the notes keeps the open email\'s board line', () => {
  const p = new Phone();
  const { messageId } = mailAbout(p, 'Quote request');
  p.openMessage(messageId);
  p.choose('folderFilter', 'Work');
  assert.equal(columnOf(p), 'To do');
  assert.deepEqual(p.listTitles(), ['Ideas for the October newsletter']);
  p.fill('q', 'stroopwafels');
  p.choose('folderFilter', 'All notes');
  p.press('Search');
  assert.equal(columnOf(p), 'To do');
  assert.deepEqual(p.listTitles(), ['Shopping list']);
});

test('no board line on a note, on the notes list from the menu, or when there are no columns', () => {
  const p = new Phone();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  assert.throws(() => p.field('boardColumn'), /No input/);
  p.universal('onUniversalAllNotes');
  assert.throws(() => p.field('boardColumn'), /No input/);
  p.openHome();
  assert.throws(() => p.field('boardColumn'), /No input/);

  const fresh = new Phone({ search: '?fresh' });
  const mail = fresh.fake.box.threadsInInbox()[0].messages[0].id;
  fresh.openMessage(mail);
  assert.equal(fresh.card.header.title, 'Notes');
  assert.throws(() => fresh.field('boardColumn'), /No input/);
});

test('a failed move says so and changes nothing', () => {
  const p = new Phone({ search: '?fail=modify' });
  const { threadId, messageId } = mailAbout(p, 'Quote request');
  p.openMessage(messageId);
  p.choose('boardColumn', 'Doing');
  assert.match(p.toast, /^Not done: Gmail answered 500/);
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board')), ['_Board/To do']);
});

// ── The phone app's server side ──────────────────────────────────────

test('the app page: served by doGet, titled, sized for a phone, with the notes view inside', () => {
  const p = new Phone();
  const out = p.addon.doGet({}).output;
  assert.equal(out.title, 'Supermail');
  assert.deepEqual(out.meta, [['viewport', 'width=device-width, initial-scale=1, viewport-fit=cover']]);
  assert.equal(out.favicon, 'https://raw.githubusercontent.com/michaelbeijer/Supermail/main/icons/icon-192.png', 'our icon, not Apps Script\'s');
  assert.match(out.html, /^<!DOCTYPE html>/);
  // The modules are packed in base64url inside one loader script, in order,
  // each exactly its source file.
  const packed = JSON.parse(/var MODULES = (\[.*?\]);\n/.exec(out.html)[1]);
  const names = packed.map(m => m[0]);
  for (const f of ['src/content/notes.js', 'src/content/note-editor.js', 'addon/app/remote.js', 'addon/app/shell.js']) {
    const m = packed.find(x => x[0] === f);
    assert.ok(m, f);
    assert.equal(Buffer.from(m[1], 'base64url').toString('utf8'), fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), f);
    assert.match(m[1], /^[A-Za-z0-9_-]+$/, 'nothing but base64url');
  }
  assert.ok(names.indexOf('addon/app/remote.js') < names.indexOf('src/content/notes.js'), 'the store before the view');
  // Nothing a careless rewrite of the page could cut: no "//", "<!--" or
  // "</" anywhere in the scripts.
  for (const [, body] of out.html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    for (const bad of ['//', '<!--', '</']) assert.ok(!body.includes(bad), `a script contains "${bad}"`);
  }
  assert.match(out.html, /<div id="boot"[^>]*>Loading/, 'something to see before the scripts run');
  const ping = p.addon.doGet({ parameter: { ping: '1' } }).output;
  assert.match(ping.html, new RegExp(`Supermail ${require('../manifest.json').version}: the script runs, and its page is ${out.html.length} characters long`));
});

test('appList: every note once, newest first, with its folder; stale versions tidied; a search brings content', () => {
  const p = new Phone();
  const r = p.server('appList', '');
  assert.deepEqual(r.notes.map(n => n.title), [
    'Ideas for the October newsletter', 'Shopping list', 'Launch checklist', 'Kestrel glossary decisions', 'Rate schedule 2027 – draft',
  ]);
  assert.equal(r.label, '_Notes');
  assert.deepEqual(r.folders.map(f => f.path), ['Empty', 'Personal', 'Work', 'Work/Clients']);
  const byTitle = t => r.notes.find(n => n.title === t);
  assert.equal(r.folders.find(f => f.id === byTitle('Kestrel glossary decisions').folderId).path, 'Work/Clients');
  assert.equal(byTitle('Rate schedule 2027 – draft').folderId, '');
  assert.equal(byTitle('Shopping list').own, false);
  assert.deepEqual(r.docs, {});
  assert.equal(live(p, 'kestrelglossary0001').length, 1, 'the older live version went to Trash');
  assert.ok(!('parts' in r.notes[0]), 'no message parts sent to the page');

  const s = p.server('appList', 'kestrel');
  assert.deepEqual(s.notes.map(n => n.title), ['Launch checklist', 'Kestrel glossary decisions']);
  assert.deepEqual(Object.keys(s.docs).sort(), s.notes.map(n => n.messageId).sort());
  assert.match(JSON.stringify(s.docs), /Kestrel/);
});

test('the board in the app: Gmail only as the board uses it - reading, labelling, and nothing more', () => {
  const p = new Phone();
  const refused = (...args) => assert.throws(() => p.server('appBoardGmail', ...args), /not_allowed|never moved to Trash, Spam or the Inbox/, args.slice(0, 2).join(' '));
  const threadId = p.fake.box.findThread('Termbase export');

  // Reading: labels, a column's threads, one thread.
  assert.ok(p.server('appBoardGmail', 'GET', 'labels').labels.some(l => l.name === '_Board/Doing'));
  const doing = p.server('appBoardGmail', 'GET', 'labels').labels.find(l => l.name === '_Board/Doing');
  assert.ok(p.server('appBoardGmail', 'GET', 'threads', { labelIds: doing.id, maxResults: 100 }).threads.some(t => t.id === threadId));
  assert.equal(p.server('appBoardGmail', 'GET', `threads/${threadId}`, { format: 'metadata', metadataHeaders: ['Subject'] }).id, threadId);

  // Labelling: a move between columns, as the board sends it.
  const waiting = p.server('appBoardGmail', 'GET', 'labels').labels.find(l => l.name === '_Board/Waiting');
  p.server('appBoardGmail', 'POST', `threads/${threadId}/modify`, null, { addLabelIds: [waiting.id], removeLabelIds: [doing.id] });
  assert.deepEqual(plain(p.fake.box.threadLabelNames(threadId)).filter(n => n.startsWith('_Board')), ['_Board/Waiting']);

  // Nothing else: no sending, deleting, Trash, Spam or Inbox; no other labels' business.
  refused('POST', 'messages/send', null, { raw: 'x' });
  refused('POST', 'messages', null, { raw: 'x' });
  refused('DELETE', `threads/${threadId}`);
  refused('POST', `threads/${threadId}/trash`);
  refused('DELETE', `labels/${waiting.id}`);
  refused('PATCH', 'labels/INBOX', null, { name: 'Gone' });
  refused('GET', 'messages');
  refused('POST', `threads/${threadId}/modify`, null, { addLabelIds: ['TRASH'], removeLabelIds: [] });
  refused('POST', `threads/${threadId}/modify`, null, { addLabelIds: ['INBOX'], removeLabelIds: [] });
  refused('POST', `threads/${threadId}/modify`, null, { addLabelIds: ['SPAM'], removeLabelIds: [] });

  // A label is a name and nothing else.
  const made = p.server('appBoardGmail', 'POST', 'labels', null, { name: '_Board/Later', type: 'system', color: { textColor: '#000000' } });
  assert.equal(made.name, '_Board/Later');
  assert.throws(() => p.server('appBoardGmail', 'POST', 'labels', null, { name: ' ' }), /needs a name/);
  assert.equal(p.server('appBoardGmail', 'PATCH', `labels/${made.id}`, null, { name: '_Board/Someday' }).name, '_Board/Someday');
});

test('the board in the app: a board of cards in one round trip, reads only', () => {
  const p = new Phone();
  const ids = plain(p.server('appBoardGmail', 'GET', 'threads', { maxResults: 5 }).threads).map(t => t.id);
  const got = p.server('appBoardGmailMany', ids.map(id => ['GET', `threads/${id}`, { format: 'metadata' }]).concat([['GET', 'threads/ffffffffffffffff', {}]]));
  assert.deepEqual(got.slice(0, ids.length).map(t => t.id), ids);
  assert.equal(got[ids.length].error.status, 404, 'one missing thread is an answer, not a failure');
  assert.throws(() => p.server('appBoardGmailMany', [['POST', `threads/${ids[0]}/modify`, {}]]), /only reads/);
  assert.throws(() => p.server('appBoardGmailMany', [['GET', 'messages', {}]]), /not_allowed/);
});

test('the calendar in the app: Calendar and Tasks in one round trip, reads only', () => {
  const p = new Phone();
  const cal = require('../src/lib/calendar-logic.js');
  const [calendars, lists] = plain(p.server('appGoogleMany', cal.sourceRequests()));
  const sources = cal.sources(calendars.items, lists.items);
  assert.deepEqual(sources.map(s => s.name), ['test', 'Jobs', 'Family', 'Holidays in the United Kingdom', 'My Tasks', 'Admin']);

  const today = cal.dateKey(new Date());
  const range = cal.viewRange('week', today);
  const on = sources.filter(s => s.on);
  const reqs = cal.rangeRequests(range, on.filter(s => s.kind === 'calendar'), on.filter(s => s.kind === 'tasks'));
  const got = plain(p.server('appGoogleMany', reqs));
  assert.equal(got.length, reqs.length);
  assert.ok(got.every(r => !r.error));
  const titles = got.flatMap(r => r.items.map(x => x.summary || x.title));
  assert.ok(titles.includes('Lumenra glossary delivery'));
  assert.ok(titles.includes('Quote for Ingrid'));
  assert.ok(titles.includes('Proofread the IFU'), 'a task ticked in Google’s apps is hidden, and still read');
  assert.ok(!titles.includes('Bank holiday'), 'not from a calendar that is off');
  assert.ok(p.log.filter(l => l.service).every(l => l.method === 'GET'));

  // A calendar that is not there is one answer among the rest.
  const missing = plain(p.server('appGoogleMany', [['calendar', 'calendars/nope%40example.com/events', {}], ['tasks', 'users/@me/lists', {}]]));
  assert.equal(missing[0].error.status, 404);
  assert.equal(missing[1].items.length, 2);

  // Nothing but the four reads.
  assert.throws(() => p.server('appGoogleMany', [['calendar', 'calendars/primary/acl', {}]]), /not_allowed/);
  assert.throws(() => p.server('appGoogleMany', [['calendar', 'calendars/primary/events/ev1', {}]]), /not_allowed/);
  assert.throws(() => p.server('appGoogleMany', [['gmail', 'profile', {}]]), /not_allowed/);
  assert.throws(() => p.server('appGoogleMany', [['tasks', 'lists/abc/tasks/clear', {}]]), /not_allowed/);
});

test('the calendar in the app: Tasks not allowed says so, and the calendar still reads', () => {
  const p = new Phone({ search: '?calendar=notasks' });
  const got = plain(p.server('appGoogleMany', [['tasks', 'lists/MTAxMjM0NTY3ODk/tasks', {}], ['calendar', 'users/me/calendarList', {}]]));
  assert.equal(got[0].error.code, 'calendar_scope');
  assert.match(got[0].error.message, /allow it/);
  assert.equal(got[1].items.length, 4);
});

test('the board in the app: whose mailbox, the first column layout, and settings kept per account', () => {
  const p = new Phone();
  assert.equal(p.server('appAccount'), 'test@example.com');
  const cols = plain(p.server('appBoardColumns'));
  assert.deepEqual(cols.map(c => c.title), ['To do', 'Doing', 'Waiting', 'Done'], 'from the _Board labels, in the usual order');
  assert.ok(cols.every(c => c.label === `_Board/${c.title}` && c.labelId));
  assert.deepEqual(cols.map(c => c.archiveOnDrop), [false, false, false, true]);

  assert.deepEqual(plain(p.server('appPrefsGet', null)), {});
  p.server('appPrefsSet', { 'columns:test@example.com': [{ id: 'a', title: 'A', label: '_Board/A' }], 'card:test@example.com:123': { title: 'Mine' } });
  // Another phone (or computer) on the same account sees them.
  const other = new Phone({ fake: p.fake });
  assert.deepEqual(plain(other.server('appPrefsGet', ['card:test@example.com:123'])), { 'card:test@example.com:123': { title: 'Mine' } });
  other.server('appPrefsRemove', ['card:test@example.com:123']);
  assert.deepEqual(Object.keys(plain(p.server('appPrefsGet', null))), ['columns:test@example.com']);
  assert.throws(() => p.server('appPrefsSet', { big: 'x'.repeat(9000) }), /too much/);

  const fresh = new Phone({ search: '?fresh' });
  assert.equal(fresh.server('appBoardColumns'), null, 'no board labels yet: the usual columns, made as in Chrome');
});

test('appSave: the scratchpad saves under its fixed id, and only it can ask for one', () => {
  const p = new Phone();
  const first = p.server('appSave', '', { title: 'Scratchpad', doc: [{ type: 'p', runs: [{ text: 'Call the bank' }] }], noteId: 'scratchpad000000' }).note;
  assert.equal(first.key, 'n:scratchpad000000');
  const next = p.server('appSave', first.messageId, { title: 'Scratchpad', doc: [{ type: 'p', runs: [{ text: 'Call the bank today' }] }], noteId: 'scratchpad000000' }).note;
  assert.equal(next.key, 'n:scratchpad000000');
  const live = plain(p.fake.box.notesWithId('scratchpad000000')).filter(n => !n.labels.includes('TRASH'));
  assert.deepEqual(live.map(n => n.text), ['Call the bank today'], 'one live version');
  const other = p.server('appSave', '', { title: 'Sneaky', doc: [], noteId: 'aaaaaaaaaaaaaaaa' }).note;
  assert.notEqual(other.key, 'n:aaaaaaaaaaaaaaaa', 'any other id is ignored');
  // In the phone panel, it is listed first.
  p.openHome();
  assert.equal(p.listItems()[0].title, 'Scratchpad');
});

test('appBody, and appSave: a new note, a new version, an email turned into a note', () => {
  const p = new Phone();
  const launch = idOf(p, 'launchchecklist0004');
  const doc = p.server('appBody', launch);
  assert.equal(doc[0].type, 'h2');
  assert.equal(doc.find(b => b.type === 'check').runs[0].text, 'Proofread the IFU');

  const work = p.server('appList', '').folders.find(f => f.path === 'Work').id;
  const made = p.server('appSave', '', { title: 'From the phone', doc: [{ type: 'p', runs: [{ text: 'Hello', b: true }] }], folderId: work }).note;
  assert.equal(made.title, 'From the phone');
  assert.equal(made.folderId, work);
  assert.ok(made.own);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(made.messageId)), ['_Notes', '_Notes/Work']);
  assert.match(html(p, made.messageId), /<b>Hello<\/b>/);

  const next = p.server('appSave', made.messageId, { title: 'From the phone', doc: [{ type: 'p', runs: [{ text: 'Hello again' }] }], folderId: work }).note;
  assert.equal(next.noteId, made.noteId, 'the same note');
  assert.ok(plain(p.fake.box.messageLabelNames(made.messageId)).includes('TRASH'), 'the old version in Trash');

  const mail = p.fake.box.findMessageBySubject('Shopping list');
  const kept = p.server('appSave', mail, { title: 'Shopping list', doc: [{ type: 'p', runs: [{ text: 'Milk' }] }], folderId: '' }).note;
  assert.ok(kept.own);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(mail)), [], 'the email leaves the list, not for Trash');
});

test('appRetire and appRestore: Trash and back for a note; off and on the list for an email', () => {
  const p = new Phone();
  const rate = idOf(p, 'rateschedule00000003');
  p.server('appRetire', rate);
  assert.ok(plain(p.fake.box.messageLabelNames(rate)).includes('TRASH'));
  p.server('appRestore', rate, '');
  assert.deepEqual(plain(p.fake.box.messageLabelNames(rate)), ['_Notes']);

  const mail = p.fake.box.findMessageBySubject('Shopping list');
  const personal = p.server('appList', '').folders.find(f => f.path === 'Personal').id;
  p.server('appRetire', mail);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(mail)), []);
  p.server('appRestore', mail, personal);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(mail)), ['_Notes', '_Notes/Personal']);

  const inbox = p.fake.box.threadsInInbox()[0].messages[0].id;
  assert.throws(() => p.server('appRetire', inbox) && p.addon.gkb.addonGmail.trashNote(inbox), /Only notes/);
  assert.ok(!plain(p.fake.box.messageLabelNames(inbox)).includes('TRASH'), 'an email is never sent to Trash');
});

test('appMove and the folder functions, with the extension\'s rules', () => {
  const p = new Phone();
  const folders = () => p.server('appList', '').folders;
  const idFor = path => folders().find(f => f.path === path).id;
  const rate = idOf(p, 'rateschedule00000003');
  p.server('appMove', rate, idFor('Personal'));
  assert.deepEqual(plain(p.fake.box.messageFolders(rate)), ['_Notes/Personal']);

  const made = p.server('appCreateFolder', idFor('Work'), 'Archive');
  assert.equal(made.folder.path, 'Work/Archive');
  assert.throws(() => p.server('appCreateFolder', idFor('Work'), 'archive'), /already a folder/);
  assert.throws(() => p.server('appCreateFolder', '', 'a/b'), /cannot contain/);

  const r = p.server('appRenameFolder', idFor('Work'), 'Jobs');
  assert.deepEqual(r.folders.map(f => f.path), ['Empty', 'Jobs', 'Jobs/Archive', 'Jobs/Clients', 'Personal'], 'the branch follows');

  assert.throws(() => p.server('appDeleteFolder', idFor('Jobs/Clients')), /^Error: not_allowed: only an empty notes folder/);
  const after = p.server('appDeleteFolder', idFor('Empty')).folders;
  assert.ok(!after.some(f => f.path === 'Empty'));
  const notNotes = plain(p.fake.box.labelByName('Clients')).id;
  assert.throws(() => p.server('appDeleteFolder', notNotes), /not_allowed/, 'never a label outside the notes');
});

// ── Limits and failures ──────────────────────────────────────────────

test('it trashes only notes, never adds Trash, Spam or Inbox, and inserts only notes', () => {
  const p = new Phone();
  const g = p.addon.gkb.addonGmail;
  const mail = p.fake.box.threadsInInbox()[0].messages[0].id;
  assert.throws(() => g.trashNote(mail), /Only notes/);
  for (const label of ['TRASH', 'SPAM', 'INBOX']) {
    assert.throws(() => g.modifyLabels(mail, { addLabelIds: [label] }), /never moved/);
    assert.throws(() => g.modifyThread(p.fake.box.threadsInInbox()[0].id, { addLabelIds: [label] }), /never moved/);
  }
  assert.throws(() => g.insertNote({ raw: 'U3ViamVjdDogaGkNCg0KaGk', labelIds: [] }), /Only notes/);
  assert.throws(() => g.insertNote({ raw: 'x', labelIds: ['INBOX'] }), /Only notes/);
  assert.ok(!plain(p.fake.box.messageLabelNames(mail)).includes('TRASH'));
  assert.equal(p.writes().length, 0);
});

test('a fresh mailbox gets its _Notes label, and an empty list', () => {
  const p = new Phone({ search: '?fresh' });
  p.openHome();
  assert.ok(plain(p.fake.box.labelNames()).includes('_Notes'));
  assert.deepEqual(p.lines(), ['No notes here yet.']);
});

test('a failed save says so, keeps the card, and leaves the note as it was', () => {
  const p = new Phone({ search: '?fail=insert' });
  const id = idOf(p, 'launchchecklist0004');
  p.openMessage(id);
  p.tick(p.boxFor('Send the invoice'));
  p.fill('add', 'kept');
  p.press('Save');
  assert.match(p.toast, /^Not done: Gmail answered 500/);
  assert.deepEqual(live(p, 'launchchecklist0004').map(n => n.id), [id]);
  assert.equal(p.card.header.title, 'Launch checklist');
  assert.match(p.logged.map(l => l[1]).join('\n'), /Backend Error/, 'and the details go to the log');
});

test('a trigger that fails shows what went wrong rather than nothing', () => {
  const p = new Phone();
  p.addon.ScriptApp.getOAuthToken = () => 'expired';
  p.openHome();
  assert.equal(p.card.name, 'error');
  assert.match(p.lines()[0], /permission/);
});
