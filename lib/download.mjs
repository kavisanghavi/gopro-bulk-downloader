// Resumable single-file downloader for GoPro CDN URLs.
// Signed URLs expire ~1h, so we mint each URL just before use and, if a large
// download is interrupted (expiry, network), we re-mint and resume via HTTP Range.

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// Download `mint()` -> {url,...} into destPath. Resumes from an existing .part file.
// onProgress(deltaBytes) is called as bytes arrive.
export async function downloadResumable({ mint, destPath, expectedSize, onProgress, maxAttempts = 6 }) {
  const partPath = destPath + '.part';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let have = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;

    // Already complete from a previous run?
    if (expectedSize && have >= expectedSize) { finalize(partPath, destPath); return { bytes: have, attempts: attempt }; }

    const { url } = await mint(); // fresh signed URL every attempt
    if (!/^https:\/\//i.test(url)) throw new Error('Refusing non-HTTPS download URL');
    const headers = have > 0 ? { Range: `bytes=${have}-` } : {};

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      await backoff(attempt); continue;
    }

    if (res.url && !/^https:\/\//i.test(res.url)) throw new Error('Refusing download redirected to non-HTTPS URL');

    // If the server ignored our Range (200 instead of 206) we must restart the file.
    if (have > 0 && res.status === 200) {
      fs.rmSync(partPath, { force: true });
      have = 0;
    }
    if (!res.ok && res.status !== 206) {
      // 403 usually = expired URL -> just retry (re-mint) and resume.
      if (res.status === 403 || res.status === 401 || res.status >= 500) { await backoff(attempt); continue; }
      throw new Error(`Download failed: HTTP ${res.status}`);
    }

    const total = totalFromHeaders(res, have) ?? expectedSize;
    const out = fs.createWriteStream(partPath, { flags: have > 0 ? 'a' : 'w' });

    try {
      const body = Readable.fromWeb(res.body);
      body.on('data', chunk => onProgress && onProgress(chunk.length));
      await pipeline(body, out);
    } catch (err) {
      await backoff(attempt); continue; // partial data kept in .part, resume next attempt
    }

    const finalSize = fs.statSync(partPath).size;
    if (total && finalSize < total) { await backoff(attempt); continue; } // truncated, resume

    finalize(partPath, destPath);
    return { bytes: finalSize, attempts: attempt };
  }
  throw new Error(`Gave up after ${maxAttempts} attempts`);
}

function totalFromHeaders(res, have) {
  const cr = res.headers.get('content-range'); // bytes start-end/total
  if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) return parseInt(m[1], 10); }
  const cl = res.headers.get('content-length');
  if (cl) return have + parseInt(cl, 10);
  return null;
}

function finalize(partPath, destPath) {
  fs.renameSync(partPath, destPath);
}

function backoff(attempt) {
  const ms = Math.min(1000 * 2 ** attempt, 15000);
  return new Promise(r => setTimeout(r, ms));
}
