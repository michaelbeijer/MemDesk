// Entity decoding, addresses, account detection and date formatting.

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('../src/lib/util.js');

// ── Entities ─────────────────────────────────────────────────────────

test('decodes the entities Gmail puts in snippets', () => {
  assert.equal(util.decodeEntities('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(util.decodeEntities('&lt;b&gt;not bold&lt;/b&gt;'), '<b>not bold</b>');
  assert.equal(util.decodeEntities('&quot;final&quot; version'), '"final" version');
  assert.equal(util.decodeEntities('we&#39;ve attached'), "we've attached");
  assert.equal(util.decodeEntities('caf&#233;'), 'café');
  assert.equal(util.decodeEntities('caf&#xE9; &#x1F600;'), 'café 😀');
  assert.equal(util.decodeEntities('&apos;&nbsp;'), "' ");
});

test('decodes in a single pass', () => {
  assert.equal(util.decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  assert.equal(util.decodeEntities('&amp;amp;'), '&amp;');
});

test('leaves malformed or unknown entities alone', () => {
  assert.equal(util.decodeEntities('&bogus; &#0; &#x110000; &#xD800; & alone'), '&bogus; &#0; &#x110000; &#xD800; & alone');
  assert.equal(util.decodeEntities('no semicolon &amp here'), 'no semicolon &amp here');
  assert.equal(util.decodeEntities(null), '');
  assert.equal(util.decodeEntities(undefined), '');
});

// ── Addresses and headers ────────────────────────────────────────────

test('parses display-name addresses', () => {
  assert.deepEqual(util.parseAddress('Ingrid Vos <Ingrid@Halverson.example>'),
    { name: 'Ingrid Vos', email: 'ingrid@halverson.example' });
  assert.deepEqual(util.parseAddress('"Ferreira, Tomás" <tomas@lumenra.example>'),
    { name: 'Ferreira, Tomás', email: 'tomas@lumenra.example' });
  assert.deepEqual(util.parseAddress('<bare@example.com>'), { name: '', email: 'bare@example.com' });
  assert.deepEqual(util.parseAddress('  Plain@Example.com '), { name: '', email: 'plain@example.com' });
  assert.deepEqual(util.parseAddress(''), { name: '', email: '' });
  assert.deepEqual(util.parseAddress(undefined), { name: '', email: '' });
});

test('display name falls back to the local part', () => {
  assert.equal(util.displayName({ name: 'Ingrid Vos', email: 'i@x.example' }), 'Ingrid Vos');
  assert.equal(util.displayName({ name: '', email: 'accounts@brightwater.example' }), 'accounts');
  assert.equal(util.displayName(null), '');
});

test('header map lower-cases names', () => {
  const m = util.headerMap({ payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'FROM', value: 'a@b.c' }] } });
  assert.deepEqual(m, { subject: 'Hi', from: 'a@b.c' });
  assert.deepEqual(util.headerMap({}), {});
});

// ── Account detection ────────────────────────────────────────────────

test('finds the account in Gmail’s title', () => {
  assert.equal(util.accountFromTitle('Inbox (3,591) - someone@example.com - Gmail'), 'someone@example.com');
  assert.equal(util.accountFromTitle('Inbox - Michael@Beijer.example - Gmail'), 'michael@beijer.example');
});

test('works with a Workspace-branded title', () => {
  assert.equal(util.accountFromTitle('Starred - me@company.example - Company Mail'), 'me@company.example');
});

test('ignores addresses and dashes inside a subject', () => {
  assert.equal(
    util.accountFromTitle('Fwd: Quote - from bob@client.example - re: patent - me@example.com - Gmail'),
    'me@example.com');
  assert.equal(util.accountFromTitle('Re: 2026-10-01 – notes – me@example.com – Gmail'), 'me@example.com');
});

test('returns empty when the title has no account', () => {
  assert.equal(util.accountFromTitle('Gmail'), '');
  assert.equal(util.accountFromTitle(''), '');
  assert.equal(util.accountFromTitle(undefined), '');
  assert.equal(util.accountFromTitle('Loading… - Gmail'), '');
});

test('reads the account from the avatar’s aria-label', () => {
  assert.equal(util.accountFromAriaLabel('Google Account: Sam Test  \n(Sam@Example.com)'), 'sam@example.com');
  assert.equal(util.accountFromAriaLabel('Google Account'), '');
});

test('reads the account index from the path', () => {
  assert.equal(util.accountIndexFromPath('/mail/u/0/'), 0);
  assert.equal(util.accountIndexFromPath('/mail/u/2/'), 2);
  assert.equal(util.accountIndexFromPath('/mail/'), 0);
});

// ── Dates ────────────────────────────────────────────────────────────

// Local-time constructors, so these pass in any timezone.
const NOW = new Date(2026, 9, 1, 14, 30).getTime(); // Thu 1 Oct 2026, 14:30

test('relative dates for recent mail', () => {
  assert.equal(util.relativeDate(NOW - 20 * 1000, NOW), 'just now');
  assert.equal(util.relativeDate(NOW - 12 * 60 * 1000, NOW), '12 min');
  assert.equal(util.relativeDate(NOW - 3 * 3600 * 1000, NOW), '3 h');
  assert.equal(util.relativeDate(NOW - 23 * 3600 * 1000, NOW), '23 h');
  assert.equal(util.relativeDate(NOW + 60 * 1000, NOW), 'just now', 'clock skew is not "in the future"');
});

test('relative dates for older mail', () => {
  assert.equal(util.relativeDate(new Date(2026, 8, 30, 9, 0).getTime(), NOW), 'Yesterday');
  assert.equal(util.relativeDate(new Date(2026, 8, 28, 9, 0).getTime(), NOW), 'Mon');
  assert.equal(util.relativeDate(new Date(2026, 8, 3, 9, 0).getTime(), NOW), '3 Sep');
  assert.equal(util.relativeDate(new Date(2024, 11, 24, 9, 0).getTime(), NOW), '24 Dec 2024');
  assert.equal(util.relativeDate(0, NOW), '');
  assert.equal(util.relativeDate('nonsense', NOW), '');
});

test('full date for tooltips', () => {
  assert.equal(util.fullDate(new Date(2026, 8, 3, 9, 5).getTime()), 'Thu 3 Sep 2026, 09:05');
});

test('“updated … ago” text', () => {
  assert.equal(util.agoText(1200), 'just now');
  assert.equal(util.agoText(42 * 1000), '42s ago');
  assert.equal(util.agoText(5 * 60 * 1000), '5 min ago');
  assert.equal(util.agoText(2 * 3600 * 1000), '2 h ago');
});

// ── Concurrency ──────────────────────────────────────────────────────

test('mapPool keeps results in order and respects the limit', async () => {
  let active = 0;
  let peak = 0;
  const out = await util.mapPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async n => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5 + (n % 3)));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.equal(peak, 3);
});

test('mapPool stops starting work after a failure', async () => {
  const started = [];
  await assert.rejects(
    util.mapPool([1, 2, 3, 4, 5, 6], 1, async n => {
      started.push(n);
      if (n === 2) throw new Error('boom');
    }),
    /boom/);
  assert.deepEqual(started, [1, 2]);
});
