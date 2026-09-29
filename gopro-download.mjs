#!/usr/bin/env node
// gopro-download — download your entire GoPro media library from the command line,
// bypassing the website's 25-at-a-time limit.
//
//   node gopro-download.mjs --out /Volumes/MyDrive/GoPro
//
// See README.md for full usage. Zero dependencies (Node >= 22 built-ins only).

import fs from 'node:fs';
import path from 'node:path';
import { getCookies } from './lib/cookies.mjs';
import { GoProClient, AuthError, VIDEO_TYPES, PHOTO_TYPES } from './lib/gopro-api.mjs';
import { downloadResumable } from './lib/download.mjs';

// ---------- args ----------
const args = parseArgs(process.argv.slice(2));
if (args.help || !args.out) { printHelp(); process.exit(args.out ? 0 : 1); }

const OUT = path.resolve(args.out);
const TYPES = args.types === 'photo' ? PHOTO_TYPES
  : args.types === 'all' ? [...VIDEO_TYPES, ...PHOTO_TYPES]
  : VIDEO_TYPES;
const CONCURRENCY = Math.max(1, parseInt(args.concurrency || '3', 10));
const QUALITY = args.quality || 'source';
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const STATE_FILE = path.join(OUT, '.gopro-download-state.json');

// ---------- main ----------
try {
  fs.mkdirSync(OUT, { recursive: true });

  log(`Reading GoPro session${args.cookie || process.env.GOPRO_COOKIE ? ' (manual cookie)' : ` from browser: ${args.browser || 'chrome'}`}...`);
  const { header, profile, count } = getCookies({ browser: args.browser, profile: args.profile, cookie: args.cookie });
  log(`  ✓ ${count} cookies (${profile})`);

  const gp = new GoProClient(header);

  log(`Fetching media list (types: ${args.types || 'video'})...`);
  const state = loadState();
  const media = [];
  for await (const m of gp.listMedia({ types: TYPES })) {
    media.push(m);
    if (media.length % 200 === 0) process.stdout.write(`  ...${media.length}\r`);
    if (media.length >= LIMIT) break;
  }
  log(`  ✓ ${media.length} items`);

  // Plan output filenames (collision-safe, chronological subfolders by date).
  const plan = planFiles(media, state);
  savePlanIntoState(state, plan);

  const totalBytes = plan.reduce((s, p) => s + (p.size || 0), 0);
  const already = plan.filter(p => isDone(p)).length;
  log(`Destination: ${OUT}`);
  log(`Total: ${plan.length} files, ~${gb(totalBytes)} GB. Already downloaded: ${already}. To fetch: ${plan.length - already}.`);

  if (args['dry-run']) {
    log('Dry run — not downloading. Sample of what would be saved:');
    for (const p of plan.slice(0, 10)) log(`  ${isDone(p) ? '[have]' : '[get] '} ${path.relative(OUT, p.dest)}  (${mb(p.size)} MB)`);
    process.exit(0);
  }

  // ---------- concurrent download ----------
  const queue = plan.filter(p => !isDone(p));
  let doneCount = already, failed = 0, doneBytes = plan.filter(isDone).reduce((s, p) => s + (p.size || 0), 0);
  const startedAt = Date.now();
  let cursor = 0;

  async function worker(id) {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const rel = path.relative(OUT, item.dest);
      try {
        const chapterResults = await downloadItemChapters(gp, item, QUALITY, (delta) => { doneBytes += delta; });
        const totalItemBytes = chapterResults.reduce((s, c) => s + c.bytes, 0);
        item.status = 'done';
        item.bytes = totalItemBytes;
        state.media[item.id] = {
          filename: item.filename, dest: item.dest, size: item.size, status: 'done',
          bytes: totalItemBytes, chapters: chapterResults.map(c => ({ dest: c.dest, bytes: c.bytes })),
        };
        doneCount++;
        saveState(state);
        const pct = ((doneCount / plan.length) * 100).toFixed(1);
        const chapterNote = chapterResults.length > 1 ? ` [${chapterResults.length} chapters]` : '';
        log(`✓ [${doneCount}/${plan.length} ${pct}%] ${rel}${chapterNote} (${mb(totalItemBytes)} MB)  |  ${overall(doneBytes, totalBytes, startedAt)}`);
      } catch (err) {
        if (err instanceof AuthError) { console.error(`\n✗ ${err.message}`); process.exit(2); }
        failed++;
        item.status = 'error';
        item.error = String(err.message || err);
        state.media[item.id] = { filename: item.filename, dest: item.dest, size: item.size, status: 'error', error: item.error };
        saveState(state);
        console.error(`✗ ${rel} — ${item.error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  log('');
  log(`Finished. ${doneCount}/${plan.length} downloaded, ${failed} failed.`);
  if (failed) log(`Re-run the same command to retry the ${failed} failed item(s) (completed files are skipped).`);
  process.exit(failed ? 1 : 0);

} catch (err) {
  console.error(`\nError: ${err.message}`);
  if (err instanceof AuthError || /Keychain|cookie|logged in/i.test(err.message)) {
    console.error('\nTip: make sure you are logged in at https://gopro.com/media-library in the browser you are pointing at,');
    console.error('or use the manual cookie method (GOPRO_COOKIE / --cookie). See README.md.');
  }
  process.exit(1);
}

// ---------- helpers ----------

// Downloads every chapter of a media item (usually 1; large recordings split
// into several by the camera — see getDownloadChapters). A chapter whose file
// is already fully on disk (no leftover .part) is trusted and skipped, so
// re-runs only fetch what's actually missing.
async function downloadItemChapters(gp, item, quality, onProgress) {
  const chapters = await gp.getDownloadChapters(item.id, quality);
  const results = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    // Chapter 1 always keeps item.dest (matches the library's existing naming/
    // collision-avoidance); only later chapters get a sibling path, with the
    // extension case matched to item.dest since the CDN's own filename casing
    // can differ from the catalog's (macOS default filesystems are case-
    // insensitive so this wouldn't be caught by testing alone).
    const dest = i === 0 ? item.dest
      : insideOut(path.join(path.dirname(item.dest), sanitize(ch.filename.replace(/\.[^.]+$/, path.extname(item.dest)))));
    const partPath = dest + '.part';
    if (fs.existsSync(dest) && !fs.existsSync(partPath)) {
      results.push({ dest, bytes: fs.statSync(dest).size });
      onProgress(fs.statSync(dest).size);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await downloadResumable({
      mint: async () => {
        const fresh = await gp.getDownloadChapters(item.id, quality);
        // Match by item_number only when it's unambiguous; otherwise by position.
        // Never fall back to a different chapter — that would silently save
        // chapter 1's data under chapter 2's name.
        const byNum = fresh.filter(c => c.itemNumber === ch.itemNumber);
        const match = byNum.length === 1 ? byNum[0] : fresh[i];
        if (!match || fresh.length !== chapters.length) throw new Error(`Chapter list for ${item.id} changed between requests`);
        return match;
      },
      destPath: dest,
      onProgress,
    });
    results.push({ dest, bytes: res.bytes });
  }
  return results;
}

function planFiles(media, state) {
  const used = new Set();
  return media.map(m => {
    const rawDate = (m.captured_at || m.created_at || '').slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : 'undated';
    const safe = sanitize(m.filename || `${m.id}.mp4`);
    let dest = insideOut(path.join(OUT, date, safe));
    // Disambiguate collisions (same filename, different media id) with a short id suffix.
    if (used.has(dest)) {
      const ext = path.extname(safe);
      dest = insideOut(path.join(OUT, date, sanitize(`${path.basename(safe, ext)}_${String(m.id).slice(-6)}${ext}`)));
    }
    used.add(dest);
    const prev = state.media[m.id];
    const size = m.file_size || (prev && prev.size) || 0;
    return {
      id: m.id,
      filename: m.filename,
      size,
      dest,
      // A complete file already on disk counts as done, even if the state file is gone.
      status: fileOk(dest, size) ? 'done' : (prev && prev.status) || 'pending',
    };
  });
}

function isDone(p) { return p.status === 'done' && fileOk(p.dest, p.size); }
function fileOk(dest, size) {
  if (!fs.existsSync(dest)) return false;
  if (!size) return true; // no expected size to check against
  const actual = fs.statSync(dest).size;
  return actual >= size * 0.999; // allow tiny metadata differences
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { version: 1, media: {} }; }
}
function savePlanIntoState(state, plan) {
  for (const p of plan) state.media[p.id] = { filename: p.filename, dest: p.dest, size: p.size, status: p.status };
  saveState(state);
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

// Filenames come from GoPro's API; treat them as untrusted so a malformed
// value can never write outside --out.
function sanitize(name) {
  const s = String(name).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim();
  return !s || /^\.+$/.test(s) ? 'file' : s;
}
function insideOut(dest) {
  const rel = path.relative(OUT, dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing to write outside --out: ${dest}`);
  return dest;
}
function gb(b) { return (b / 1e9).toFixed(1); }
function mb(b) { return (b / 1e6).toFixed(1); }
function overall(done, total, startedAt) {
  const secs = (Date.now() - startedAt) / 1000;
  const rate = done / Math.max(secs, 1); // bytes/s (session)
  const remain = total - done;
  const eta = rate > 0 ? remain / rate : 0;
  return `${gb(done)}/${gb(total)} GB  ${(rate / 1e6).toFixed(1)} MB/s  ETA ${fmtDur(eta)}`;
}
function fmtDur(s) {
  if (!isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : `${m}m`;
}
function log(msg) { console.log(msg); }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function printHelp() {
  console.log(`
gopro-download — download your whole GoPro media library (no 25-item limit)

Usage:
  node gopro-download.mjs --out <dir> [options]

Required:
  --out <dir>          Destination folder (e.g. /Volumes/MyDrive/GoPro)

Options:
  --types <t>          video (default) | photo | all
  --quality <q>        source (default, original) | high_res_proxy_mp4 | edit_proxy
  --concurrency <n>    Parallel downloads (default 3)
  --browser <b>        chrome (default) | brave | edge | chromium | arc   [macOS auto-cookie]
  --profile <name>     Browser profile (default: the one logged into GoPro)
  --cookie <header>    Manual cookie header (or set GOPRO_COOKIE). Works on any OS.
  --limit <n>          Only process the first n items (handy for testing)
  --dry-run            Show what would be downloaded, then exit
  -h, --help           This help

Resuming: safe to Ctrl-C and re-run — finished files are skipped and partial
files resume. Progress is tracked in <out>/.gopro-download-state.json.
`);
}
