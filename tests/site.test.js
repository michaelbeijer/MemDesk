// The website (tools/build-site.mjs): every file the pages point to is
// there, the privacy page says what PRIVACY.md says, the help pages are
// docs/*.md, all of them, and the demo is made of the real code.
// (tests/e2e/demo.e2e.mjs tries the demo itself.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-site.mjs'), `--out=${OUT}`]);
const page = rel => fs.readFileSync(path.join(OUT, rel), 'utf8');

// Where a local address leads, from the page `rel`: the file, and the
// heading it names, if any.
function target(rel, u) {
  const [address, frag = ''] = u.split('?')[0].split('#');
  const p = path.posix.join(path.posix.dirname(rel), address);
  return { file: p.endsWith('/') || p === '.' ? path.posix.join(p, 'index.html') : p, frag };
}

// The local addresses a page uses: src and href that are not a whole URL,
// an anchor or an email address, resolved from the page's own folder.
function localRefs(rel) {
  const html = page(rel);
  return [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(m => m[1])
    .filter(u => !/^(https?:|mailto:|#|\?)/.test(u))
    .map(u => target(rel, u).file);
}

const DEMO_PAGES = ['demo/index.html', 'demo/phone/index.html', 'demo/phone/app.html', 'demo/phone/server.html'];
// Every file in docs/ is a help page: README.md the overview, docs/; the
// others docs/<name>/.
const DOC_FILES = fs.readdirSync(path.join(ROOT, 'docs')).filter(f => f.endsWith('.md'));
const docPage = f => (f === 'README.md' ? 'docs/index.html' : `docs/${f.replace(/\.md$/, '')}/index.html`);
const DOC_PAGES = DOC_FILES.map(docPage);

test('the site has its pages, and everything they point to', () => {
  for (const rel of ['index.html', 'privacy/index.html', ...DOC_PAGES, ...DEMO_PAGES]) {
    const refs = localRefs(rel);
    assert.ok(refs.length >= 3, rel);
    for (const ref of refs) assert.ok(fs.existsSync(path.join(OUT, ref)), `${rel} points to ${ref}, which is not there`);
  }
});

test('the pages run no scripts and load nothing from elsewhere but links', () => {
  for (const rel of ['index.html', 'privacy/index.html', ...DOC_PAGES]) {
    const html = page(rel);
    assert.doesNotMatch(html, /<script\b/i, rel);
    assert.doesNotMatch(html, /\bon[a-z]+="/i, `${rel}: no inline handlers either`);
  }
  // The demo runs scripts, its own, and loads nothing from elsewhere either.
  for (const rel of ['index.html', 'privacy/index.html', ...DOC_PAGES, ...DEMO_PAGES]) {
    const html = page(rel);
    assert.doesNotMatch(html, /\bsrc="https?:/i, rel);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/i, rel);
  }
});

test('the demo is the real code: the preview’s content scripts, the phone app’s page, and Code.gs itself', () => {
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const manifest = JSON.parse(read('manifest.json'));
  const computer = page('demo/index.html');
  // The extension's content scripts, in the manifest's order, as they are.
  const scripts = [...computer.matchAll(/<script src="(src\/[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, manifest.content_scripts[0].js);
  for (const f of scripts) assert.equal(page(`demo/${f}`), read(f), f);
  assert.equal(page('demo/mock-chrome.js'), read('dev/mock-chrome.js'));
  // Made-up mail, tidy; the demo's bar and script; Gmail's rule on HTML.
  assert.match(computer, /window\.__mockSearch = '\?showcase&latency=\d+'/);
  assert.ok(computer.indexOf('__mockSearch') < computer.indexOf('<script src="mock-chrome.js">'), 'set before the fake loads');
  assert.match(computer, /<div class="demobar"/);
  assert.match(computer, /<script src="demo\.js"><\/script>\n<\/body>/);
  assert.match(computer, /require-trusted-types-for 'script'/);
  assert.doesNotMatch(computer, /<title>[^<]*Gmail/, 'not called Gmail');
  // The phone: the app's page, with google.script standing in before
  // anything else runs, and the script, Code.gs as built.
  const appPage = page('demo/phone/app.html');
  const run = appPage.indexOf('<script src="run.js">');
  assert.ok(run > 0 && run < appPage.indexOf('var MODULES'), 'google.script before the app');
  assert.equal(page('demo/phone/code.js'), read('addon/Code.gs'));
  const server = page('demo/phone/server.html');
  assert.ok(server.indexOf('apps-script-services.js') < server.indexOf('code.js'));
  assert.ok(server.includes(JSON.stringify(JSON.parse(read('addon/appsscript.json')).urlFetchWhitelist)), 'the manifest’s whitelist');
  assert.match(page('demo/phone/index.html'), /<div class="demobar"[\s\S]*aria-current="page">Phone</);
  // Free, whether licences are on sale or not.
  assert.ok(server.indexOf('window.gkb.LICENCE_STORE_ID = 0;') > server.indexOf('code.js'), 'the phone demo’s script');
  assert.match(page('demo/demo.js'), /window\.gkb\.LICENCE_STORE_ID = 0;/, 'the computer demo');
});

test('the website leads to the demo, and to the help', () => {
  const html = page('index.html');
  assert.ok(html.includes('<a class="btn btn-ghost" href="demo/">Try the demo</a>'), 'beside Get MemDesk');
  assert.ok(html.includes('<a href="demo/">Demo</a>'), 'in the top menu');
  const top = html.slice(0, html.indexOf('</header>'));
  const foot = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
  assert.ok(top.includes('<a href="docs/">Help</a>'), 'Help in the top menu');
  assert.ok(foot.includes('<a href="docs/">Help</a>'), 'and at the foot');
});

// ── The help pages ──

// The contents beside a page: where each entry leads, which is this page,
// and what each is called.
function contents(rel) {
  const nav = /<nav class="toc" id="contents"[^>]*>([\s\S]*?)<\/nav>/.exec(page(rel));
  assert.ok(nav, `${rel} has the contents`);
  return [...nav[1].matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)]
    .map(([, href, current, title]) => ({ file: target(rel, href).file, current: !!current, title }));
}

test('the help pages: one for each file in docs/, each listing them all, itself marked, with Previous and Next', () => {
  assert.ok(DOC_FILES.includes('README.md'), 'the overview');
  assert.ok(DOC_FILES.length >= 10, 'all ten');
  const order = contents('docs/index.html').map(c => c.file);
  assert.equal(order[0], 'docs/index.html', 'the overview first');
  // Every file in docs/ built, and listed; nothing listed that is not there.
  assert.deepEqual([...order].sort(), [...DOC_PAGES].sort());
  order.forEach((rel, i) => {
    const list = contents(rel);
    assert.deepEqual(list.map(c => c.file), order, `${rel}: the same contents, in the same order`);
    assert.deepEqual(list.filter(c => c.current).map(c => c.file), [rel], `${rel}: marked as the page you are on, and only it`);
    const html = page(rel);
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${rel}: one title`);
    assert.match(html, /<title>[^<]+<\/title>/, rel);
    const pager = /<nav class="pager"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
    const step = cls => { const m = new RegExp(`<a class="${cls}" href="([^"]+)"`).exec(pager); return m && target(rel, m[1]).file; };
    assert.equal(step('prev'), order[i - 1] || null, `${rel}: Previous`);
    assert.equal(step('next'), order[i + 1] || null, `${rel}: Next`);
    assert.ok(html.includes('<a href="https://github.com/michaelbeijer/MemDesk/blob/main/docs/'), `${rel}: the page on GitHub`);
  });
  // The overview's own list leads to every other page as well.
  const overview = page('docs/index.html');
  const main = overview.slice(overview.indexOf('<main>'), overview.indexOf('<nav class="pager"'));
  const linked = new Set([...main.matchAll(/href="([^"]+)"/g)].map(m => target('docs/index.html', m[1]).file));
  for (const rel of DOC_PAGES.filter(r => r !== 'docs/index.html')) assert.ok(linked.has(rel), `the overview lists ${rel}`);
});

test('the help pages: a link to a heading lands on one, and the Markdown links only to what there is', () => {
  for (const rel of DOC_PAGES) {
    for (const [, u] of page(rel).matchAll(/\bhref="([^"]*#[^"]+)"/g)) {
      if (/^https?:/.test(u)) continue;
      const to = u.startsWith('#') ? { file: rel, frag: u.slice(1) } : target(rel, u);
      assert.ok(page(to.file).includes(` id="${to.frag}"`), `${rel} links to ${u}, and there is no such heading`);
    }
  }
  // Written to read on GitHub too: another page as page.md, a picture from
  // images/, the rest of the repository by its place in it.
  for (const f of DOC_FILES) {
    const md = fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8');
    for (const [, u] of md.matchAll(/\]\(([^)\s#]+)(#[^)\s]*)?\)/g)) {
      if (/^(https?:|mailto:)/.test(u)) continue;
      assert.ok(fs.existsSync(path.join(ROOT, 'docs', u)), `docs/${f} links to ${u}, which is not there`);
    }
  }
});

test('the help pages: each picture is one the site carries, says what it shows, and has its real size', () => {
  const home = page('index.html');
  let seen = 0;
  for (const rel of DOC_PAGES) {
    for (const [tag] of page(rel).matchAll(/<img [^>]+>/g)) {
      const src = /src="([^"]+)"/.exec(tag)[1];
      if (src.endsWith('icon.svg')) continue; // the logo, beside the name
      seen++;
      const name = path.posix.basename(src);
      assert.equal(target(rel, src).file, `img/${name}`, `${rel}: ${src}`);
      assert.match(tag, /alt="[^"]{12,}"/, `${rel}: ${name} says what it shows`);
      // The same size the landing page gives it.
      const size = /width="(\d+)" height="(\d+)"/.exec(tag);
      assert.ok(size, `${rel}: ${name} has its size`);
      assert.ok(home.includes(`src="img/${name}" width="${size[1]}" height="${size[2]}"`), `${rel}: ${name} is ${size[1]}×${size[2]}`);
    }
  }
  assert.ok(seen >= 8, 'the pages have pictures');
});

test('the help pages never call it open source: it is source available', () => {
  for (const f of DOC_FILES) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8'), /(?<!not )open[- ]source/i, `docs/${f}`);
  }
  assert.match(page('docs/licence/index.html'), /source available/);
});

test('the privacy page is as it was before the help pages: Markdown asked for nothing makes what it always made', async () => {
  const { markdown } = await import(pathToFileURL(path.join(ROOT, 'tools', 'build-site.mjs')).href);
  // Every kind of Markdown PRIVACY.md uses, and what it has always become.
  const sample = '# A title with `code`\n\n*Last updated: 1 January 2026*\n\nA paragraph that runs\nover two lines, with **bold**, *italics*, `a <b> & "c"` and [a link](https://example.com/a?b=1&c=2).\n\n## A heading\n\n- **First:** an item that runs on\n  over an indented line.\n- Second, with <tags> & "quotes".\nText straight after a list.\n\n### Smaller\n\nLast.';
  assert.equal(markdown(sample), '<h1>A title with <code>code</code></h1>\n<p><em>Last updated: 1 January 2026</em></p>\n<p>A paragraph that runs over two lines, with <strong>bold</strong>, <em>italics</em>, <code>a &lt;b&gt; &amp; &quot;c&quot;</code> and <a href="https://example.com/a?b=1&amp;c=2">a link</a>.</p>\n<h2>A heading</h2>\n<ul>\n  <li><strong>First:</strong> an item that runs on over an indented line.</li>\n  <li>Second, with &lt;tags&gt; &amp; &quot;quotes&quot;.</li>\n</ul>\n<p>Text straight after a list.</p>\n<h3>Smaller</h3>\n<p>Last.</p>');
  // And the page itself has none of what the help pages add.
  const html = page('privacy/index.html');
  assert.doesNotMatch(html, /<h[1-3] id=/, 'no ids on its headings');
  assert.doesNotMatch(html, /<nav|class="toc"|class="pager"|class="shot"/, 'none of the help pages\' frame');
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

test('every picture opens full size, without a script: a lightbox each, with a way on, back and out', () => {
  const html = page('index.html');
  const views = [...html.matchAll(/<div class="lightbox" id="view-([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(views, ['hero', 'board', 'gmail', 'notes', 'scratchpad', 'search', 'calendar', 'phone']);
  const opened = [...html.matchAll(/class="zoomable"[^>]*href="#view-([a-z]+)"/g)].map(m => m[1]);
  assert.equal(opened.length, 13, 'the five pictures by the text, and the eight in Screenshots');
  for (const v of opened) assert.ok(views.includes(v), v);
  for (const v of views) {
    const at = html.indexOf(`<div class="lightbox" id="view-${v}"`);
    const box = html.slice(at, html.indexOf('</figure>', at));
    assert.ok(box.includes(`<img src="img/${v}.jpg" width="2400"`), `${v}: the picture, full size`);
    assert.ok(box.includes(`href="img/${v}.jpg"`), `${v}: and on its own, to zoom in`);
    const [, back] = /class="lightbox-close" href="#([a-z-]+)"/.exec(box);
    assert.ok(html.includes(`id="${back}"`), `${v}: Close goes back to a place on the page`);
    assert.ok(box.includes(`<a class="lightbox-back" href="#${back}" title="Back to the page"><img src="img/${v}.jpg"`), `${v}: so does a click on the picture`);
    const steps = [...box.matchAll(/href="#view-([a-z]+)">(?:‹ Previous|Next ›)</g)].map(m => m[1]);
    assert.equal(steps.length, 2, `${v}: Previous and Next`);
    for (const to of steps) assert.ok(views.includes(to), `${v} → ${to}`);
  }
  assert.ok(html.includes('<a href="#screens">Screenshots</a>'), 'Screenshots in the top menu');
});
