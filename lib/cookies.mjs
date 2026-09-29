// Reads GoPro session cookies (including HttpOnly ones) so the CLI can call
// api.gopro.com the same way the logged-in website does.
//
// Auto-extraction is implemented for Chromium-family browsers on macOS.
// Everywhere else (or if you prefer), pass cookies manually via the
// GOPRO_COOKIE env var or --cookie "<header>" (see README).

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

// macOS Chromium-family browsers: { userDataDir, keychainService }
const MAC_BROWSERS = {
  chrome:   { dir: 'Library/Application Support/Google/Chrome',                 service: 'Chrome Safe Storage' },
  brave:    { dir: 'Library/Application Support/BraveSoftware/Brave-Browser',   service: 'Brave Safe Storage' },
  edge:     { dir: 'Library/Application Support/Microsoft Edge',                service: 'Microsoft Edge Safe Storage' },
  chromium: { dir: 'Library/Application Support/Chromium',                      service: 'Chromium Safe Storage' },
  arc:      { dir: 'Library/Application Support/Arc/User Data',                 service: 'Arc Safe Storage' },
};

function macKey(service) {
  const pw = execFileSync('security', ['find-generic-password', '-w', '-s', service]).toString().trim();
  return crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
}

function decryptMac(buf, key) {
  if (!buf || buf.length === 0) return '';
  const prefix = buf.slice(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return buf.toString(); // legacy plaintext
  const dec = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  dec.setAutoPadding(false);
  let out = Buffer.concat([dec.update(buf.slice(3)), dec.final()]);
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.slice(0, out.length - pad);
  const asStr = out.toString('utf8');
  const stripped = out.slice(32).toString('utf8'); // newer Chrome prepends a 32-byte SHA256(domain)
  return (/[^\x20-\x7e]/.test(asStr) && !/[^\x20-\x7e]/.test(stripped)) ? stripped : asStr;
}

// Only cookies scoped to gopro.com or its subdomains are read and decrypted.
// (A plain LIKE '%gopro.com%' would also match unrelated hosts such as
// "notgopro.com" and forward their cookies to GoPro.)
function readProfileCookies(dbPath, key) {
  // Copy to dodge Chrome's write lock. mkdtemp creates a private (0700) dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpck_'));
  const tmp = path.join(dir, 'Cookies.sqlite');
  try {
    fs.copyFileSync(dbPath, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare(
      "SELECT name, encrypted_value, is_httponly FROM cookies " +
      "WHERE host_key IN ('gopro.com', '.gopro.com') OR host_key LIKE '%.gopro.com'"
    ).all();
    db.close();
    return rows.map(r => ({ name: r.name, httponly: !!r.is_httponly, value: decryptMac(Buffer.from(r.encrypted_value), key) }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Returns a Cookie header string for GoPro from the given browser.
// Picks the profile that has the most gopro.com cookies (i.e. the logged-in one).
export function cookiesFromBrowser(browser = 'chrome', wantProfile = null) {
  if (process.platform !== 'darwin') {
    throw new Error(
      `Automatic cookie extraction is currently implemented for macOS only ` +
      `(you're on ${process.platform}). Use the manual method instead: set GOPRO_COOKIE ` +
      `or pass --cookie. See the README section "Manual cookie capture".`
    );
  }
  const b = MAC_BROWSERS[browser];
  if (!b) throw new Error(`Unknown browser "${browser}". Options: ${Object.keys(MAC_BROWSERS).join(', ')}`);
  const base = path.join(HOME, b.dir);
  if (!fs.existsSync(base)) throw new Error(`${browser} not found at ${base}`);

  let key;
  try { key = macKey(b.service); }
  catch { throw new Error(`Could not read the ${browser} encryption key from Keychain. When the popup appears, click Allow.`); }

  const profiles = fs.readdirSync(base).filter(d => d === 'Default' || /^Profile /.test(d));
  let best = null;
  for (const prof of profiles) {
    if (wantProfile && prof !== wantProfile) continue;
    const db = path.join(base, prof, 'Cookies');
    if (!fs.existsSync(db)) continue;
    let jar;
    try { jar = readProfileCookies(db, key); } catch { continue; }
    if (jar.length && (!best || jar.length > best.jar.length)) best = { profile: prof, jar };
  }
  if (!best) {
    throw new Error(
      wantProfile
        ? `No gopro.com cookies in ${browser} profile "${wantProfile}". Are you logged in there?`
        : `No gopro.com cookies found in ${browser}. Log in at https://gopro.com/media-library first.`
    );
  }
  const header = best.jar.map(c => `${c.name}=${c.value}`).join('; ');
  return { header, profile: best.profile, count: best.jar.length };
}

// Manual fallback: GOPRO_COOKIE env or a raw string (may be a full "Copy as cURL").
export function cookiesFromManual(raw) {
  const src = raw || process.env.GOPRO_COOKIE;
  if (!src) return null;
  // If someone pasted a whole curl command, pull the cookie out of it. Chrome's
  // "Copy as cURL" uses -b '...'; older versions / other browsers use -H 'cookie: ...'.
  const m = src.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])(.+?)\1/)?.slice(1)
    || src.match(/-H\s+(['"])cookie:\s*(.+?)\1/i)?.slice(1)
    || src.match(/(?:^|\s)()cookie:\s*(.+)$/im)?.slice(1);
  if (!m && /^\s*curl\s/.test(src)) {
    throw new Error('Could not find a cookie in the pasted curl command. Paste just the cookie header value instead.');
  }
  const header = (m ? m[1] : src).trim();
  return { header, profile: 'manual', count: header.split(';').filter(Boolean).length };
}

export function getCookies({ browser, profile, cookie } = {}) {
  const manual = cookiesFromManual(cookie);
  if (manual) return manual;
  return cookiesFromBrowser(browser || 'chrome', profile || null);
}
