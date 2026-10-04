// ─────────────────────────────────────────────────────────────────────
// The website's phone demo: google.script, standing in
//
// The phone app (addon/app) talks to its script through google.script.run.
// Here the script - addon/Code.gs itself - runs in a hidden frame of the
// page (server.html), with Apps Script's services standing in
// (dev/apps-script-services.js) against the fake Gmail, Calendar and
// Tasks. This hands it each call as Apps Script would: a moment later,
// with the arguments and the answer passed through JSON.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // About as long as a call to a script takes, if a good deal quicker.
  const LATENCY = 150;

  // A reload starts afresh: the app's own copy of the notes from last
  // time (and its settings, and any text not yet saved) would be of a
  // mailbox that no longer exists. The website keeps nothing else here,
  // so all of it goes, whatever the app comes to keep.
  try { localStorage.clear(); } catch { /* no storage: nothing kept either */ }

  const frame = document.createElement('iframe');
  frame.src = 'server.html';
  frame.hidden = true;
  frame.title = 'The script, standing in';
  const ready = new Promise(resolve => frame.addEventListener('load', () => resolve(frame.contentWindow), { once: true }));
  document.body.append(frame);

  const json = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  function call(name, args) {
    return ready.then(server => new Promise((resolve, reject) => setTimeout(() => {
      try {
        if (typeof server[name] !== 'function') throw new Error(`Script function not found: ${name}`);
        resolve(json(server[name](...json(args))));
      } catch (err) {
        reject(new Error(String((err && err.message) || err)));
      }
    }, LATENCY)));
  }

  function runner(success, failure, user) {
    return new Proxy({}, {
      get(_, name) {
        if (typeof name !== 'string' || name === 'then') return undefined;
        if (name === 'withSuccessHandler') return fn => runner(fn, failure, user);
        if (name === 'withFailureHandler') return fn => runner(success, fn, user);
        if (name === 'withUserObject') return o => runner(success, failure, o);
        return (...args) => {
          call(name, args).then(res => success && success(res, user), err => failure && failure(err, user));
        };
      },
    });
  }

  window.google = {
    script: {
      run: runner(null, null),
      history: { push() {}, replace() {}, setChangeHandler() {} },
      host: { close() {}, setHeight() {}, setWidth() {}, origin: location.origin },
    },
  };
})();
