// ─────────────────────────────────────────────────────────────────────
// Apps Script's services, standing in
//
// What the phone app's script (addon/Code.gs) asks of Apps Script, done
// against the fake Gmail, Calendar and Tasks of dev/mock-chrome.js: for
// the tests in Node (tests/helpers/apps-script.js, which adds a strict
// CardService for the panel) and for the website's phone demo, where the
// script runs in the visitor's browser (site/demo).
//
// - UrlFetchApp sends each request to the fake services, and only to
//   addresses on the manifest's whitelist, with the script's token.
// - PropertiesService keeps the user's properties in memory.
// - ScriptApp gives the token, and says what has been allowed.
// - HtmlService makes the page doGet serves.
//
// `fake`: { route, googleRoute } from dev/mock-chrome.js, and what a test
// sets on it (denied scopes, the user's properties).
// ─────────────────────────────────────────────────────────────────────

(function (root) {
  'use strict';

  // ── UrlFetchApp ──────────────────────────────────────────────────────

  const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
  // The calendar's APIs, answered by the fake Calendar and Tasks; and what
  // the manifest lets UrlFetchApp reach at all.
  const GOOGLE = {
    calendar: 'https://www.googleapis.com/calendar/v3/',
    tasks: 'https://tasks.googleapis.com/tasks/v1/',
  };
  const TOKEN = 'token-for-tests';
  const FETCH_OPTIONS = new Set(['method', 'headers', 'contentType', 'payload', 'muteHttpExceptions']);

  // Each request is logged with the round trip it went in: one fetch, or
  // one fetchAll's worth side by side.
  function urlFetch(fake, log, whitelist) {
    const response = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
    let rounds = 0;
    function send(url, opts, round) {
      for (const k of Object.keys(opts)) if (!FETCH_OPTIONS.has(k)) throw new Error(`UrlFetchApp: unexpected option ${k}`);
      if (!opts.muteHttpExceptions) throw new Error('UrlFetchApp: without muteHttpExceptions a Gmail error would throw');
      if (!whitelist.some(w => url.startsWith(w))) throw new Error(`UrlFetchApp: ${url} is not on the manifest's whitelist`);
      if (!opts.headers || opts.headers.Authorization !== `Bearer ${TOKEN}`) return response(401, '{"error":{"message":"no token"}}');
      const service = Object.keys(GOOGLE).find(k => url.startsWith(GOOGLE[k]));
      if (service) return sendGoogle(service, url, opts, round);
      if (!url.startsWith(BASE)) throw new Error(`UrlFetchApp: ${url} is not Gmail, Calendar or Tasks`);
      const u = new URL(url);
      const apiPath = decodeURIComponent(u.pathname.slice(new URL(BASE).pathname.length));
      const query = {};
      for (const key of new Set(u.searchParams.keys())) {
        const all = u.searchParams.getAll(key);
        query[key] = all.length > 1 ? all : all[0];
      }
      const method = String(opts.method || 'get').toUpperCase();
      const body = opts.payload === undefined ? undefined : JSON.parse(opts.payload);
      log.push({ method, path: apiPath, query, body, round });
      try {
        return response(200, JSON.stringify(fake.route(method, apiPath, query, body)));
      } catch (err) {
        const m = /^http_(\d+)$/.exec(err.code || '');
        const status = m ? Number(m[1]) : err.code === 'not_allowed' ? 403 : 500;
        return response(status, JSON.stringify({ error: { code: status, message: err.message } }));
      }
    }
    function sendGoogle(service, url, opts, round) {
      const u = new URL(url);
      const apiPath = u.pathname.slice(new URL(GOOGLE[service]).pathname.length);
      const query = {};
      for (const key of new Set(u.searchParams.keys())) {
        const all = u.searchParams.getAll(key);
        query[key] = all.length > 1 ? all : all[0];
      }
      const method = String(opts.method || 'get').toUpperCase();
      const body = opts.payload === undefined ? undefined : JSON.parse(opts.payload);
      log.push({ service, method, path: apiPath, query, body, round });
      // What each needs of the manifest's scopes: reading the calendar list
      // and events, calendar.readonly; changing an event, calendar.events;
      // anything of Tasks, tasks.
      const scope = `https://www.googleapis.com/auth/${service === 'tasks' ? 'tasks' : method === 'GET' ? 'calendar.readonly' : 'calendar.events'}`;
      if (fake.denied && fake.denied.has(scope)) {
        return response(403, JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.' } }));
      }
      try {
        const etag = (opts.headers && opts.headers['If-Match']) || '';
        const data = fake.googleRoute(service, apiPath, query, method, body, etag);
        return data === null ? response(204, '') : response(200, JSON.stringify(data));
      } catch (err) {
        if (err.code === 'calendar_scope') return response(403, JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.' } }));
        const m = /^http_(\d+)$/.exec(err.code || '');
        const status = m ? Number(m[1]) : err.code === 'not_allowed' ? 400 : 500;
        return response(status, JSON.stringify({ error: { code: status, message: err.message } }));
      }
    }

    return {
      fetch(url, opts = {}) {
        if ('url' in opts) throw new Error('UrlFetchApp.fetch: the url goes first, not in the options');
        return send(url, opts, ++rounds);
      },
      fetchAll(requests) {
        const round = ++rounds;
        return requests.map(r => {
          const { url, ...opts } = r;
          if (!url) throw new Error('UrlFetchApp.fetchAll: every request needs its url');
          return send(url, opts, round);
        });
      },
    };
  }

  // ── HtmlService ──────────────────────────────────────────────────────

  function htmlService() {
    return {
      createHtmlOutput(html) {
        const out = { html: String(html), title: '', meta: [] };
        const api = {
          setTitle(t) { out.title = t; return api; },
          addMetaTag(name, content) { out.meta.push([name, content]); return api; },
          setFaviconUrl(url) { out.favicon = url; return api; },
          getContent: () => out.html,
          getTitle: () => out.title,
          output: out,
        };
        return new Proxy(api, {
          get(t, prop) {
            if (prop in t || typeof prop === 'symbol') return t[prop];
            throw new TypeError(`HtmlOutput has no method ${String(prop)}`);
          },
        });
      },
    };
  }

  // ── PropertiesService ────────────────────────────────────────────────
  //
  // User properties belong to the account, so every phone on one mailbox
  // sees the same ones. Values are strings, as in Apps Script.

  function propertiesService(fake) {
    const store = (fake.userProperties = fake.userProperties || new Map());
    const user = {
      getProperties: () => Object.fromEntries(store),
      getProperty: k => (store.has(k) ? store.get(k) : null),
      setProperties(items) {
        for (const [k, v] of Object.entries(items)) {
          if (typeof v !== 'string') throw new TypeError('Property values must be strings');
          store.set(k, v);
        }
        return user;
      },
      setProperty(k, v) { return user.setProperties({ [k]: v }); },
      deleteProperty(k) { store.delete(k); return user; },
    };
    return { getUserProperties: () => user };
  }

  // ── ScriptApp ────────────────────────────────────────────────────────
  //
  // The token, and what the script has been allowed. Google lets someone
  // allow some of a script's permissions and not others; a test says
  // which with fake.denied, a set of scopes (all allowed when empty).

  const AUTHORIZE_URL = 'https://script.google.com/macros/d/test-script/authorize';

  function scriptApp(fake) {
    fake.denied = fake.denied || new Set();
    const AuthMode = { FULL: 'FULL', LIMITED: 'LIMITED', NONE: 'NONE' };
    const AuthorizationStatus = { REQUIRED: 'REQUIRED', NOT_REQUIRED: 'NOT_REQUIRED' };
    const info = scopes => {
      const missing = [...fake.denied].filter(sc => !scopes || scopes.includes(sc));
      return {
        getAuthorizationStatus: () => (missing.length ? AuthorizationStatus.REQUIRED : AuthorizationStatus.NOT_REQUIRED),
        getAuthorizationUrl: () => (missing.length ? AUTHORIZE_URL : null),
      };
    };
    return {
      AuthMode,
      AuthorizationStatus,
      getOAuthToken: () => TOKEN,
      getAuthorizationInfo(mode, scopes) {
        if (!AuthMode[mode]) throw new Error('ScriptApp.getAuthorizationInfo: unknown AuthMode');
        return info(scopes);
      },
      requireAllScopes(mode) {
        if (!AuthMode[mode]) throw new Error('ScriptApp.requireAllScopes: unknown AuthMode');
        if (fake.denied.size) throw new Error('Authorization is required to perform that action.');
      },
    };
  }

  const api = { BASE, GOOGLE, TOKEN, AUTHORIZE_URL, urlFetch, htmlService, propertiesService, scriptApp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.appsScriptServices = api;
})(this);
