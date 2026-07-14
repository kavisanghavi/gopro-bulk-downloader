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
        fs.mkdirSync(path.dirname(item.dest), { recursive: true });
        const res = await downloadResumable({
          mint: () => gp.getDownloadUrl(item.id, QUALITY),
          destPath: item.dest,
          expectedSize: item.size,
          onProgress: (delta) => { doneBytes += delta; },
        });
        item.status = 'done';
        item.bytes = res.bytes;
        state.media[item.id] = { filename: item.filename, dest: item.dest, size: item.size, status: 'done', bytes: res.bytes };
        doneCount++;
        saveState(state);
        const pct = ((doneCount / plan.length) * 100).toFixed(1);
        log(`✓ [${doneCount}/${plan.length} ${pct}%] ${rel} (${mb(res.bytes)} MB)  |  ${overall(doneBytes, totalBytes, startedAt)}`);
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
function planFiles(media, state) {
  const used = new Set();
  return media.map(m => {
    const date = (m.captured_at || m.created_at || '').slice(0, 10) || 'undated';
    const safe = sanitize(m.filename || `${m.id}.mp4`);
    let dest = path.join(OUT, date, safe);
    // Disambiguate collisions (same filename, different media id) with a short id suffix.
    if (used.has(dest)) {
      const ext = path.extname(safe);
      dest = path.join(OUT, date, `${path.basename(safe, ext)}_${String(m.id).slice(-6)}${ext}`);
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

function sanitize(name) { return name.replace(/[\/\\:*?"<>|]/g, '_').trim() || 'file'; }
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
