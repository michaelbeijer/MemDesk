#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// The website (memdesk.app), built
//
//   node tools/build-site.mjs [--out=_site]
//
// Puts together what GitHub Pages serves: site/index.html as it is, the
// privacy policy made into a page from PRIVACY.md (so there is one text,
// not two), the help pages (docs/) made from docs/*.md, the icons and
// README pictures the pages show, and the demo (demo/, demo/phone/), made
// of the real code and its fakes. Nothing is written into the repository
// itself; .github/workflows/pages.yml runs this on every push to main and
// publishes the result.
// ─────────────────────────────────────────────────────────────────────

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appHtml } from './build-addon.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(REPO, rel), 'utf8');
const GITHUB = 'https://github.com/michaelbeijer/MemDesk';

export const ICONS = ['icon.svg', 'icon-32.png', 'icon-192.png'];
export const PICTURES = ['hero.jpg', 'board.jpg', 'gmail.jpg', 'notes.jpg', 'scratchpad.jpg', 'search.jpg', 'calendar.jpg', 'phone.jpg'];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The little Markdown PRIVACY.md and the help pages use: code, bold,
// italics and links. `link` makes a link's address work where the page is
// served; as written, it is how GitHub reads it.
function inline(text, link = url => url) {
  const code = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${link(url)}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[Number(i)]}</code>`);
}

// A heading's id as GitHub makes it - lower case, no punctuation, a hyphen
// for each space, and -1, -2 on repeats - so that board.md#done goes to
// the same place on GitHub and on the site.
function slugger() {
  const seen = new Map();
  return text => {
    const base = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

// Headings, paragraphs, and bulleted and numbered lists whose items run on
// over indented lines: the whole of the Markdown in PRIVACY.md. The help
// pages add a picture on a line of its own, and ask for ids on headings
// and for their links (`link`) and pictures (`picture`) to be made to work
// on the site. Asked for nothing, it makes what it always made.
export function markdown(md, { ids = false, link, picture = (src, alt) => `<img src="${esc(src)}" alt="${esc(alt)}">` } = {}) {
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul' or 'ol', items: [the lines of each item] }
  const slug = ids ? slugger() : null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '), link)}</p>`); para = []; };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>\n${list.items.map(i => `  <li>${inline(i.join(' '), link)}</li>`).join('\n')}\n</${list.tag}>`);
    list = null;
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const n = h[1].length;
      out.push(`<h${n}${slug ? ` id="${slug(h[2])}"` : ''}>${inline(h[2], link)}</h${n}>`);
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line);
    if (img) { flushPara(); flushList(); out.push(picture(img[2], img[1])); continue; }
    const item = /^(- |\d+\. )/.exec(line);
    if (item) {
      flushPara();
      const tag = item[1] === '- ' ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      (list = list || { tag, items: [] }).items.push([line.slice(item[1].length)]);
      continue;
    }
    if (list && /^ {2,}\S/.test(line)) { list.items[list.items.length - 1].push(line.trim()); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('\n');
}

const APP_NAME = /APP_NAME = '([^']+)'/.exec(read('src/shared/ns.js'))[1];

// The privacy page: the landing page's look, plainer.
function privacyPage() {
  const md = read('PRIVACY.md');
  const title = /^# (.+)$/m.exec(md)[1];
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="../icon.svg" type="image/svg+xml">
<link rel="icon" href="../icon-32.png" sizes="32x32" type="image/png">
<style>
  :root { --violet: #6d28d9; --ink: #1f1f1f; --muted: #5f6368; --page: #fff; --line: #e8e5f3; --code: #f5f3ff; }
  @media (prefers-color-scheme: dark) { :root { --violet: #b794fb; --ink: #ececf1; --muted: #b4b0c4; --page: #131217; --line: #2c2938; --code: #1c1a24; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink); font: 17px/1.65 Roboto, "Segoe UI", Arial, sans-serif; }
  a { color: var(--violet); }
  header { background: linear-gradient(135deg, #2e1065 0%, #4c1d95 45%, #6d28d9 100%); }
  header a { display: flex; align-items: center; gap: 10px; max-width: 760px; margin: 0 auto; padding: 16px 20px; color: #fff; text-decoration: none; font-size: 20px; font-weight: 500; }
  header img { width: 30px; height: 30px; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 20px 56px; }
  h1 { font-size: 34px; line-height: 1.2; margin: 18px 0 6px; }
  h2 { font-size: 23px; margin: 36px 0 8px; }
  li { margin: 6px 0; }
  code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: .9em; }
  footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
  footer div { max-width: 760px; margin: 0 auto; padding: 22px 20px 36px; }
  footer a { color: var(--muted); }
</style>
</head>
<body>
<header><a href="../"><img src="../icon.svg" alt="" width="30" height="30">${esc(APP_NAME)}</a></header>
<main>
${markdown(md)}
</main>
<footer><div><a href="../">${esc(APP_NAME)}</a> · <a href="https://github.com/michaelbeijer/MemDesk/blob/main/PRIVACY.md">This policy on GitHub</a></div></footer>
</body>
</html>
`;
}

// ── The help pages ──
//
// docs/*.md, the manual for the person using it, each made into a page:
// docs/README.md into docs/, the others into docs/<name>/. This order is
// the contents beside every page, and its Previous and Next. The Markdown
// is written to read on GitHub - another page as board.md, a picture as
// ../images/board.jpg, the rest of the repository as ../SETUP.md, the
// website as https://memdesk.app/... - and each link is made to work on
// the site here, or the build stops.

export const DOCS = [
  ['README.md', 'Overview'],
  ['getting-started.md', 'Getting started'],
  ['board.md', 'The board'],
  ['notes.md', 'Notes'],
  ['calendar.md', 'Calendar'],
  ['phone-app.md', 'The phone app'],
  ['gmail-panel.md', 'The Gmail panel'],
  ['privacy.md', 'Privacy and safety'],
  ['licence.md', 'Licence'],
  ['questions.md', 'Questions and troubleshooting'],
].map(([file, title]) => ({ file, title, dir: file === 'README.md' ? 'docs' : `docs/${file.replace(/\.md$/, '')}` }));

// The address of `to`, a place in the site ('' is the site itself, a
// folder ends in '/'), from a page in the folder `from`.
function relLink(from, to) {
  const r = posix.relative(`/${from}`, `/${to.replace(/\/$/, '')}`) || '.';
  return to === '' || to.endsWith('/') ? `${r}/` : r;
}

function docLink(page) {
  return url => {
    const [path, frag] = url.split('#');
    const hash = frag === undefined ? '' : `#${frag}`;
    if (!path) return url;
    const site = /^https:\/\/memdesk\.app\/(.*)$/.exec(path);
    if (site) return relLink(page.dir, site[1]) + hash;
    if (/^(https?:|mailto:)/.test(path)) return url;
    const doc = DOCS.find(d => d.file === path);
    if (doc) return relLink(page.dir, `${doc.dir}/`) + hash;
    if (path.startsWith('../') && existsSync(join(REPO, path.slice(3)))) return `${GITHUB}/blob/main/${path.slice(3)}${hash}`;
    throw new Error(`build-site: docs/${page.file} links to ${url}, which is neither a help page nor a file in the repository`);
  };
}

// A JPEG's size, from its frame header, so that a page keeps its place
// (and a link to a heading lands on it) while the pictures load.
function jpegSize(buf) {
  for (let i = 2; buf[i] === 0xff && i + 9 < buf.length; i += 2 + buf.readUInt16BE(i + 2)) {
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
  }
  throw new Error('build-site: could not read a picture\'s size');
}

// A picture from images/, one of those the site already carries, as a link
// to itself full size.
function docPicture(page) {
  return (src, alt) => {
    const name = /^\.\.\/images\/([\w-]+\.jpg)$/.exec(src);
    if (!name || !PICTURES.includes(name[1])) throw new Error(`build-site: docs/${page.file} shows ${src}, which is not one of the site's pictures`);
    if (!alt.trim()) throw new Error(`build-site: docs/${page.file} shows ${src} with no words to say what it shows`);
    const url = relLink(page.dir, `img/${name[1]}`);
    const { width, height } = jpegSize(readFileSync(join(REPO, 'images', name[1])));
    return `<p class="shot"><a href="${url}" title="See it full size"><img src="${url}" width="${width}" height="${height}" loading="lazy" alt="${esc(alt)}"></a></p>`;
  };
}

// The privacy page's look, with the contents beside the page (below it,
// on a phone) and Previous and Next under it.
function docsPage(i) {
  const page = DOCS[i];
  const md = read(`docs/${page.file}`);
  const h1 = /^# (.+)$/m.exec(md)[1];
  const title = i === 0 ? h1 : `${h1} · ${APP_NAME} help`;
  const site = relLink(page.dir, '');
  const to = d => relLink(page.dir, `${d.dir}/`);
  const contents = DOCS.map(d => `  <li><a href="${to(d)}"${d === page ? ' aria-current="page"' : ''}>${esc(d.title)}</a></li>`).join('\n');
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];
  const pager = [
    prev ? `<a class="prev" href="${to(prev)}" rel="prev"><span>Previous</span>${esc(prev.title)}</a>` : '',
    next ? `<a class="next" href="${to(next)}" rel="next"><span>Next</span>${esc(next.title)}</a>` : '',
  ].join('');
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="${site}icon.svg" type="image/svg+xml">
<link rel="icon" href="${site}icon-32.png" sizes="32x32" type="image/png">
<style>
  :root { --violet: #6d28d9; --ink: #1f1f1f; --muted: #5f6368; --page: #fff; --soft: #f5f3ff; --line: #e8e5f3; --code: #f5f3ff; }
  @media (prefers-color-scheme: dark) { :root { --violet: #b794fb; --ink: #ececf1; --muted: #b4b0c4; --page: #131217; --soft: #1c1a24; --line: #2c2938; --code: #1c1a24; } }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--page); color: var(--ink); font: 17px/1.65 Roboto, "Segoe UI", Arial, sans-serif; }
  a { color: var(--violet); }
  header { background: linear-gradient(135deg, #2e1065 0%, #4c1d95 45%, #6d28d9 100%); }
  .top { display: flex; align-items: center; gap: 10px; max-width: 1080px; margin: 0 auto; padding: 16px 20px; }
  .top a { color: #fff; text-decoration: none; }
  .top a:hover { text-decoration: underline; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 500; }
  .brand img { width: 30px; height: 30px; }
  .section { font-size: 20px; opacity: .88; }
  .section::before { content: "/"; margin-right: 10px; opacity: .6; }
  .jump { display: none; margin-left: auto; font-size: 15px; opacity: .88; }
  .layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 0 56px; max-width: 1080px; margin: 0 auto; padding: 0 20px; }
  main { grid-column: 2; grid-row: 1; max-width: 760px; padding: 24px 0 48px; overflow-wrap: break-word; }
  .toc { grid-column: 1; grid-row: 1; align-self: start; position: sticky; top: 0; max-height: 100vh; overflow-y: auto; padding: 34px 0 24px; font-size: 15px; }
  .toc p { margin: 0 0 8px; font-size: 13px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase; color: var(--muted); }
  .toc ol { list-style: none; margin: 0; padding: 0; }
  .toc li { margin: 2px 0; }
  .toc a { display: block; padding: 5px 10px; border-left: 3px solid transparent; border-radius: 0 6px 6px 0; color: var(--ink); text-decoration: none; line-height: 1.4; }
  .toc a:hover { background: var(--soft); }
  .toc a[aria-current="page"] { border-left-color: var(--violet); background: var(--soft); font-weight: 600; }
  h1 { font-size: 34px; line-height: 1.2; margin: 18px 0 10px; }
  h2 { font-size: 24px; line-height: 1.3; margin: 40px 0 8px; }
  h3 { font-size: 19px; line-height: 1.35; margin: 28px 0 6px; }
  h2, h3 { scroll-margin-top: 16px; }
  ul, ol { padding-left: 1.5em; }
  li { margin: 6px 0; }
  code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: .9em; overflow-wrap: anywhere; }
  .shot { margin: 22px 0 26px; }
  .shot a { display: block; border-radius: 10px; }
  .shot img { display: block; width: 100%; height: auto; border-radius: 10px; box-shadow: 0 8px 30px rgba(46, 16, 101, .18); }
  .pager { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--line); }
  .pager a { padding: 12px 16px; border: 1px solid var(--line); border-radius: 10px; text-decoration: none; font-weight: 500; }
  .pager a:hover { border-color: var(--violet); }
  .pager span { display: block; font-size: 13px; font-weight: 400; color: var(--muted); }
  .pager .next { grid-column: 2; text-align: right; }
  footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
  footer div { max-width: 1080px; margin: 0 auto; padding: 22px 20px 36px; }
  footer a { color: var(--muted); }
  @media (max-width: 860px) {
    .layout { display: block; }
    .toc { position: static; max-height: none; overflow: visible; padding: 24px 0 32px; border-top: 1px solid var(--line); }
    .jump { display: inline; }
  }
  @media (max-width: 520px) {
    body { font-size: 16px; }
    .top, .layout, footer div { padding-left: 16px; padding-right: 16px; }
    .brand, .section { font-size: 18px; }
    h1 { font-size: 28px; }
    h2 { font-size: 21px; }
    .pager { grid-template-columns: 1fr; }
    .pager .next { grid-column: 1; }
  }
</style>
</head>
<body>
<header><div class="top">
  <a class="brand" href="${site}"><img src="${site}icon.svg" alt="" width="30" height="30">${esc(APP_NAME)}</a>
  <a class="section" href="${to(DOCS[0])}">Help</a>
  <a class="jump" href="#contents">Contents</a>
</div></header>
<div class="layout">
<main>
${markdown(md, { ids: true, link: docLink(page), picture: docPicture(page) })}
<nav class="pager" aria-label="Previous and next page">${pager}</nav>
</main>
<nav class="toc" id="contents" aria-label="Help pages">
<p>Help</p>
<ol>
${contents}
</ol>
</nav>
</div>
<footer><div><a href="${site}">${esc(APP_NAME)}</a> · <a href="${site}privacy/">Privacy</a> · <a href="${GITHUB}/blob/main/docs/${page.file}">This page on GitHub</a></div></footer>
</body>
</html>
`;
}

function buildDocs(out) {
  DOCS.forEach((page, i) => {
    mkdirSync(join(out, page.dir), { recursive: true });
    writeFileSync(join(out, page.dir, 'index.html'), docsPage(i));
  });
}

// ── The demo ──
//
// demo/: the dev preview - the extension's real content scripts in a
// made-up Gmail - in its tidy showcase mode, under the demo's bar.
// demo/phone/: the phone app's page, as Code.gs serves it, with Code.gs
// itself running beside it in a hidden frame (server.html), its Apps
// Script services standing in against the same kind of made-up mailbox.
// Nothing is kept: a reload starts afresh. See site/demo.

// Each change to a page made here must find its place exactly once, so
// that a change to the preview or the app's page breaks the build, not
// the demo.
function once(text, find, put) {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`build-site: expected "${find}" once, found it ${n} times`);
  return text.replace(find, () => put);
}

// The fake services: tidy, and a little quicker than the preview's.
const DEMO_FLAGS = '?showcase&latency=80';

function demoBar(phone) {
  const root = phone ? '../../' : '../';
  return `<div class="demobar" role="region" aria-label="About this demo">
  <a class="demo-home" href="${root}" aria-label="${esc(APP_NAME)}: the website"><img src="${root}icon.svg" alt="" width="22" height="22"><span class="demo-name">${esc(APP_NAME)}</span></a>
  <span class="demo-what">A demo with made-up mail, notes and calendar. Try anything: nothing leaves this page, and a reload starts afresh.</span>
  <nav class="demo-switch" aria-label="Computer or phone">
    <a href="${phone ? '../?computer' : './'}"${phone ? '' : ' aria-current="page"'}>Computer</a><a href="${phone ? './' : 'phone/'}"${phone ? ' aria-current="page"' : ''}>Phone</a>
  </nav>
  <a class="demo-get" href="${root}#get">Get ${esc(APP_NAME)}</a>
</div>`;
}

export const CONTENT_SCRIPTS = JSON.parse(read('manifest.json')).content_scripts[0].js;
// What the hidden script frame needs besides Code.gs: the fake mailbox,
// and what it uses.
const SERVER_SCRIPTS = ['src/lib/util.js', 'src/lib/notes-logic.js', 'src/lib/calendar-logic.js'];

function computerPage() {
  let html = read('dev/preview.html');
  html = once(html, /<title>[^<]*<\/title>/.exec(html)[0], `<title>${esc(APP_NAME)} demo</title>
<meta name="description" content="Try ${esc(APP_NAME)} in a made-up Gmail: the board, the notes and the calendar, with nothing to install.">
<link rel="icon" href="../icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="demo.css">`);
  html = once(html, '<body>\n', `<body>\n${demoBar(false)}\n`);
  html = once(html, '<script src="mock-chrome.js"></script>', `<script>
    window.__mockSearch = '${DEMO_FLAGS}';
    // On a phone, the phone's demo, unless the computer's was asked for.
    if (matchMedia('(max-width: 700px)').matches && !/[?&]computer\\b/.test(location.search)) location.replace('phone/');
  </script>
  <script src="mock-chrome.js"></script>`);
  const scripts = html.match(/<script src="\.\.\/src\/[^"]+"><\/script>/g) || [];
  if (scripts.length !== CONTENT_SCRIPTS.length) throw new Error('build-site: the preview does not load the manifest’s content scripts');
  html = html.replace(/<script src="\.\.\/src\//g, '<script src="src/');
  return once(html, '</body>', '<script src="demo.js"></script>\n</body>');
}

function serverPage() {
  const whitelist = JSON.parse(read('addon/appsscript.json')).urlFetchWhitelist;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The phone app's script, standing in</title>
</head>
<body>
<script>window.__mockSearch = '${DEMO_FLAGS.replace(/latency=\d+/, 'latency=0')}';</script>
${SERVER_SCRIPTS.map(f => `<script src="../${f}"></script>`).join('\n')}
<script src="../mock-chrome.js"></script>
<script src="../apps-script-services.js"></script>
<script>
  // Apps Script's globals, as Code.gs finds them there. What it fetches
  // is not logged: a long visit would only pile it up.
  (function () {
    var services = window.appsScriptServices;
    var fake = { route: window.__mockChrome.route, googleRoute: window.__mockChrome.googleRoute, lemonRoute: window.__mockChrome.lemonRoute };
    window.UrlFetchApp = services.urlFetch(fake, { push: function () {} }, ${JSON.stringify(whitelist)});
    window.PropertiesService = services.propertiesService(fake);
    window.ScriptApp = services.scriptApp(fake);
    window.HtmlService = services.htmlService();
  })();
</script>
<script src="code.js"></script>
<script>
  // The demo is free, whether licences are on sale or not: the script
  // reads this each time it is asked about the licence.
  window.gkb.LICENCE_STORE_ID = 0;
</script>
</body>
</html>
`;
}

function buildDemo(out) {
  const demo = join(out, 'demo');
  const copy = (from, to) => {
    mkdirSync(dirname(join(demo, to)), { recursive: true });
    copyFileSync(join(REPO, from), join(demo, to));
  };
  mkdirSync(join(demo, 'phone'), { recursive: true });
  writeFileSync(join(demo, 'index.html'), computerPage());
  for (const f of new Set([...CONTENT_SCRIPTS, ...SERVER_SCRIPTS])) copy(f, f);
  copy('dev/mock-chrome.js', 'mock-chrome.js');
  copy('dev/apps-script-services.js', 'apps-script-services.js');
  copy('site/demo/demo.css', 'demo.css');
  copy('site/demo/demo.js', 'demo.js');
  writeFileSync(join(demo, 'phone', 'index.html'), once(read('site/demo/phone.html'), '<!-- demo bar -->', demoBar(true)));
  writeFileSync(join(demo, 'phone', 'app.html'), appHtml({
    before: '<link rel="stylesheet" href="../demo.css">\n<script src="../demo.js"></script>\n<script src="run.js"></script>\n',
  }));
  copy('site/demo/run.js', 'phone/run.js');
  writeFileSync(join(demo, 'phone', 'server.html'), serverPage());
  copy('addon/Code.gs', 'phone/code.js');
}

export function build(out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'img'), { recursive: true });
  mkdirSync(join(out, 'privacy'), { recursive: true });
  copyFileSync(join(REPO, 'site', 'index.html'), join(out, 'index.html'));
  writeFileSync(join(out, 'privacy', 'index.html'), privacyPage());
  for (const f of ICONS) copyFileSync(join(REPO, 'icons', f), join(out, f));
  for (const f of PICTURES) copyFileSync(join(REPO, 'images', f), join(out, 'img', f));
  buildDocs(out);
  buildDemo(out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = process.argv.find(a => a.startsWith('--out='));
  const out = build(arg ? arg.slice('--out='.length) : join(REPO, '_site'));
  console.log(`Wrote the website to ${out}`);
}
