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
    'https://www.googleapis.com/auth/gmail.addons.current.message.metadata',
    'https://www.googleapis.com/auth/gmail.addons.execute',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/script.external_request',
  ]);
  assert.deepEqual(manifest.urlFetchWhitelist, ['https://gmail.googleapis.com/']);
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
  const body = p.card.sections[0].widgets[0].text;
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
  const kestrel = p.card.sections[1].widgets.find(w => w.text === 'Kestrel glossary decisions');
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
  assert.equal(p.card.sections[1].header, 'Work');
  p.choose('folderFilter', 'All notes');
  p.fill('q', 'stroopwafels');
  p.press('Search');
  assert.deepEqual(p.listTitles(), ['Shopping list']);
  assert.equal(p.card.sections[1].header, 'All notes: “stroopwafels”');
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

// ── Limits and failures ──────────────────────────────────────────────

test('it trashes only notes, never adds Trash, Spam or Inbox, and inserts only notes', () => {
  const p = new Phone();
  const g = p.addon.gkb.addonGmail;
  const mail = p.fake.box.threadsInInbox()[0].messages[0].id;
  assert.throws(() => g.trashNote(mail), /Only notes/);
  for (const label of ['TRASH', 'SPAM', 'INBOX']) assert.throws(() => g.modifyLabels(mail, { addLabelIds: [label] }), /never moved/);
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
