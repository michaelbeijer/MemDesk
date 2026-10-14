// ─────────────────────────────────────────────────────────────────────
// Pictures in notes, in the page
//
// A picture put into a note - picked, pasted or dropped - is made
// smaller here first: no side longer than MAX_SIDE pixels, as a JPEG,
// or a PNG where it has see-through parts or PNG is smaller. One that is
// small already keeps its own bytes (an animated GIF stays animated).
// Until the note is saved it is held in this page, under a "new-…" name
// that the editor shows it by (note-format's picture block); the save
// puts it into Gmail as a message of its own (notes-logic's pictures,
// and notes.js, which saves).
//
// Pictures already in Gmail are read as they come into view, a few at a
// time, and the most recently seen are kept here - up to CACHE_CHARS of
// them - so that going back to a note does not read them again. All of
// them are held as data: URLs, which an <img> keeps its own hold on: one
// dropped from here never goes blank on the screen. A picture added here
// is held apart until it is saved, then kept with the rest; its "new-…"
// name still finds it after that (an undone delete, or a copy pasted into
// another note, may ask for it by that name).
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  // Sharp enough to read a screenshot of a whole screen; a few hundred
  // KB for a photo.
  const MAX_SIDE = 1600;
  const KEEP_BYTES = 400 * 1024;
  const JPEG_QUALITY = 0.85;
  // Most of the time a JPEG is the smaller; a PNG this size or less is
  // kept as one without looking.
  const PNG_FINE = 300 * 1024;
  const CACHE_CHARS = 48 * 1024 * 1024;
  const AT_ONCE = 4;

  const pending = new Map();  // "new-…" → { type, url }, until saved
  const saved = new Map();    // "new-…" → the id of the message it was saved as
  const cache = new Map();    // message id → { url, trashed }, oldest first
  let cached = 0;             // their URLs' length, together
  const inflight = new Map(); // message id → the read under way

  const isPending = src => /^new-/.test(String(src));
  const gone = () => Object.assign(new Error('This picture is no longer in Gmail.'), { code: 'gone' });
  // Added in a page that has closed since, before it was saved.
  const lost = () => Object.assign(new Error('This picture was not saved.'), { code: 'gone', lost: true });
  const splitUrl = url => {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(url);
    return m ? { type: m[1], data: m[2] } : null;
  };

  function newKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return `new-${Array.from(bytes, b => b.toString(36).padStart(2, '0').slice(-2)).join('')}`;
  }

  // ── Adding ───────────────────────────────────────────────────────────

  const blobUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('The picture could not be read.'));
    reader.readAsDataURL(blob);
  });

  const toBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

  function hasSeeThrough(ctx, w, h) {
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
    return false;
  }

  // The file as a data: URL: as it is, if it is small already, or drawn
  // smaller.
  async function shrunk(file, type, bitmap) {
    const { width: w0, height: h0 } = bitmap;
    if (ns.notesLogic.PICTURE_TYPES.has(type) && file.size <= KEEP_BYTES && Math.max(w0, h0) <= MAX_SIDE) return blobUrl(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    let blob;
    if (type === 'image/jpeg') {
      blob = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    } else {
      blob = await toBlob(canvas, 'image/png');
      if (blob && blob.size > PNG_FINE && !hasSeeThrough(ctx, w, h)) {
        const jpeg = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
        if (jpeg && jpeg.size < blob.size) blob = jpeg;
      }
    }
    // Still too big (a huge, busy photo): one more try, plainer.
    if (blob && blob.size > ns.notesLogic.MAX_PICTURE && blob.type === 'image/jpeg') blob = await toBlob(canvas, 'image/jpeg', 0.7);
    if (!blob || blob.size > ns.notesLogic.MAX_PICTURE) throw new Error('That picture is too big for a note, even made smaller.');
    return blobUrl(blob);
  }

  // The picture from a file, made smaller if it needs to be, held here
  // until the note is saved. Resolves to { src }; a file that is not a
  // picture, or one that cannot be made small enough, is refused with a
  // message to show.
  async function add(file) {
    const type = String(file && file.type || '').toLowerCase();
    if (!/^image\//.test(type)) throw new Error('That is not a picture.');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      throw new Error('This kind of picture cannot be read here. Save it as a JPEG or PNG first.');
    }
    let url = '';
    try {
      url = await shrunk(file, type, bitmap);
    } finally {
      if (bitmap.close) bitmap.close();
    }
    const got = splitUrl(url);
    if (!got || !ns.notesLogic.PICTURE_TYPES.has(got.type)) throw new Error('That picture could not be read.');
    const src = newKey();
    pending.set(src, { type: got.type, url });
    return { src };
  }

  // ── Reading ──────────────────────────────────────────────────────────

  function keep(id, entry) {
    const had = cache.get(id);
    if (had) {
      cached -= had.url.length;
      cache.delete(id);
    }
    cache.set(id, entry);
    cached += entry.url.length;
    for (const [k, v] of cache) {
      if (cached <= CACHE_CHARS || cache.size <= 1) break;
      cache.delete(k);
      cached -= v.url.length;
    }
  }

  // A few reads at a time, so that a note full of pictures does not ask
  // Gmail for all of them at once.
  let running = 0;
  const waiting = [];
  function queued(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        running++;
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          running--;
          if (waiting.length) waiting.shift()();
        });
      };
      if (running < AT_ONCE) go();
      else waiting.push(go);
    });
  }

  // A picture to show: { url, trashed } - trashed, if its message is in
  // Gmail's Trash. Fails with code "gone" if there is no such picture.
  function load(src) {
    const s = String(src || '');
    if (isPending(s)) {
      const p = pending.get(s);
      if (p) return Promise.resolve({ url: p.url, trashed: false });
      return saved.has(s) ? load(saved.get(s)) : Promise.reject(lost());
    }
    const hit = cache.get(s);
    if (hit) {
      cache.delete(s);
      cache.set(s, hit);
      return Promise.resolve(hit);
    }
    if (inflight.has(s)) return inflight.get(s);
    const p = queued(() => ns.notesStore.picture(s)).then(got => {
      if (!got) throw gone();
      const entry = { url: `data:${got.type};base64,${got.data}`, trashed: !!got.trashed };
      keep(s, entry);
      return entry;
    }).finally(() => inflight.delete(s));
    inflight.set(s, p);
    return p;
  }

  // Its bytes, to save: { type, data } in base64, or null if there is no
  // such picture any more. Other failures (offline) are thrown.
  async function dataOf(src) {
    try {
      return splitUrl((await load(src)).url);
    } catch (err) {
      if (err.code === 'gone') return null;
      throw err;
    }
  }

  // Saved as message `id`: kept under that, with the rest, so it is not
  // read back - and no longer held apart.
  function adopt(src, id) {
    const p = pending.get(src) || cache.get(src);
    if (p) keep(id, { url: p.url, trashed: false });
    if (pending.delete(src)) saved.set(src, id);
  }

  // Taken out of Trash.
  function untrashed(id) {
    const hit = cache.get(id);
    if (hit) hit.trashed = false;
  }

  ns.pictures = { MAX_SIDE, isPending, add, load, dataOf, adopt, untrashed };
})();
