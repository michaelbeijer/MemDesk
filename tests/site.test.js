// The website (tools/build-site.mjs): every file the pages point to is
// there, and the privacy page says what PRIVACY.md says.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-site.mjs'), `--out=${OUT}`]);
const page = rel => fs.readFileSync(path.join(OUT, rel), 'utf8');

// The local addresses a page uses: src and href that are not a whole URL,
// an anchor or an email address, resolved from the page's own folder.
function localRefs(rel) {
  const html = page(rel);
  return [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(m => m[1])
    .filter(u => !/^(https?:|mailto:|#)/.test(u))
    .map(u => {
      const p = path.posix.join(path.posix.dirname(rel), u.split('#')[0]);
      return p.endsWith('/') || p === '.' ? path.posix.join(p, 'index.html') : p;
    });
}

test('the site has its pages, and everything they point to', () => {
  for (const rel of ['index.html', 'privacy/index.html']) {
    const refs = localRefs(rel);
    assert.ok(refs.length > 3, rel);
    for (const ref of refs) assert.ok(fs.existsSync(path.join(OUT, ref)), `${rel} points to ${ref}, which is not there`);
  }
});

test('the pages run no scripts and load nothing from elsewhere but links', () => {
  for (const rel of ['index.html', 'privacy/index.html']) {
    const html = page(rel);
    assert.doesNotMatch(html, /<script\b/i, rel);
    assert.doesNotMatch(html, /\bsrc="https?:/i, rel);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/i, rel);
  }
});

test('the privacy page is PRIVACY.md, all of it', () => {
  const md = fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8');
  const html = page('privacy/index.html');
  // Tags and Markdown's marks both leave gaps; close them the same way.
  const tidy = s => s.replace(/\s+/g, ' ').replace(/ ([,.;:)])/g, '$1').replace(/\( /g, '(');
  const text = tidy(html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
  for (const h of md.match(/^#{1,2} .+$/gm)) assert.ok(text.includes(h.replace(/^#+ /, '')), h);
  assert.equal((html.match(/<li>/g) || []).length, (md.match(/^- /gm) || []).length, 'every list item');
  for (const [, url] of md.matchAll(/\]\(([^)]+)\)/g)) assert.ok(html.includes(`href="${url}"`), url);
  // Every word of the policy, in order, Markdown's marks aside.
  const words = md.replace(/^- /gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`#]/g, ' ').split(/\s+/).filter(Boolean);
  assert.ok(text.includes(tidy(words.join(' '))), 'the policy\'s words, in order');
});
