#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// The website (memdesk.app), built
//
//   node tools/build-site.mjs [--out=_site]
//
// Puts together what GitHub Pages serves: site/index.html as it is, the
// privacy policy made into a page from PRIVACY.md (so there is one text,
// not two), the icons and README pictures the page shows, and the demo
// (demo/, demo/phone/), made of the real code and its fakes. Nothing is
// written into the repository itself; .github/workflows/pages.yml runs
// this on every push to main and publishes the result.
// ─────────────────────────────────────────────────────────────────────

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appHtml } from './build-addon.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(REPO, rel), 'utf8');

export const ICONS = ['icon.svg', 'icon-32.png', 'icon-192.png'];
export const PICTURES = ['hero.jpg', 'board.jpg', 'gmail.jpg', 'notes.jpg', 'scratchpad.jpg', 'search.jpg', 'calendar.jpg', 'phone.jpg'];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The little Markdown PRIVACY.md uses: code, bold, italics and links.
function inline(text) {
  const code = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[Number(i)]}</code>`);
}

// Headings, paragraphs and bulleted lists whose items run on over
// indented lines: the whole of the Markdown in PRIVACY.md.
export function markdown(md) {
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<ul>\n${list.map(i => `  <li>${inline(i.join(' '))}</li>`).join('\n')}\n</ul>`); list = null; };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^- /.test(line)) { flushPara(); (list = list || []).push([line.slice(2)]); continue; }
    if (list && /^ {2,}\S/.test(line)) { list[list.length - 1].push(line.trim()); continue; }
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
    var fake = { route: window.__mockChrome.route, googleRoute: window.__mockChrome.googleRoute };
    window.UrlFetchApp = services.urlFetch(fake, { push: function () {} }, ${JSON.stringify(whitelist)});
    window.PropertiesService = services.propertiesService(fake);
    window.ScriptApp = services.scriptApp(fake);
    window.HtmlService = services.htmlService();
  })();
</script>
<script src="code.js"></script>
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
  buildDemo(out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = process.argv.find(a => a.startsWith('--out='));
  const out = build(arg ? arg.slice('--out='.length) : join(REPO, '_site'));
  console.log(`Wrote the website to ${out}`);
}
