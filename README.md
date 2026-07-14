# gopro-media-downloader

Download your **entire** GoPro cloud media library from the command line — no
25-items-at-a-time limit, no clicking through the website.

- ✅ Downloads **original quality** (or smaller proxies) straight from GoPro's CDN
- ✅ **Resumable** — Ctrl-C and re-run; finished files skip, partial files continue
- ✅ Handles thousands of files / hundreds of GB, saved anywhere (e.g. an external drive)
- ✅ **Zero dependencies** — just Node. Uses your existing browser login; no password needed
- ✅ One file to share; MIT licensed

> Use it only for **your own** media that you have the right to download.

---

## How it works

GoPro's website only *shows* a "download up to 25" button, but the underlying API
(`api.gopro.com`, the same one the site uses) has no such limit. This tool:

1. Reads your GoPro session cookie from your browser (so it's authenticated as you).
2. Lists every item in your library via the media API.
3. For each item, mints a fresh signed download URL and streams the file to disk.

Signed URLs expire after ~1 hour, so URLs are generated **just before** each
download and re-minted automatically if a large transfer gets interrupted.

---

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite`). Check with `node -v`.
- You must be **logged in to GoPro** in your browser at
  <https://gopro.com/media-library>.
- **Automatic** cookie reading currently supports **macOS** with a Chromium-family
  browser (Chrome, Brave, Edge, Chromium, Arc). On Windows/Linux or other browsers,
  use the [manual cookie method](#manual-cookie-capture-any-os--browser) — everything
  else works identically.

---

## Quick start

```bash
git clone <this-repo> gopro-media-downloader
cd gopro-media-downloader

# Dry run first — lists what would download, nothing is written:
node gopro-download.mjs --out /Volumes/MyDrive/GoPro --dry-run

# Then the real thing:
node gopro-download.mjs --out /Volumes/MyDrive/GoPro
```

The first run shows a macOS **Keychain popup** ("… wants to use your confidential
information stored in Chrome Safe Storage") — click **Allow**. This lets the tool
read the browser cookie that authenticates you. It never leaves your machine.

Files are organized by capture date:

```
/Volumes/MyDrive/GoPro/
  2025-12-06/GX010042.MP4
  2026-01-19/GX011208.MP4
  ...
  .gopro-download-state.json   ← progress tracker (safe to delete; disk is source of truth)
```

---

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--out <dir>` | *(required)* | Destination folder |
| `--types <t>` | `video` | `video`, `photo`, or `all` |
| `--quality <q>` | `source` | `source` (original), `high_res_proxy_mp4`, or `edit_proxy` (smaller) |
| `--concurrency <n>` | `3` | Parallel downloads |
| `--browser <b>` | `chrome` | `chrome`, `brave`, `edge`, `chromium`, `arc` (macOS auto-cookie) |
| `--profile <name>` | *(auto)* | Browser profile; default = the one logged into GoPro |
| `--cookie <header>` | — | Manual cookie header (or `GOPRO_COOKIE` env). Any OS. |
| `--limit <n>` | — | Only process the first n items (handy for testing) |
| `--dry-run` | — | Show what would download, then exit |
| `-h`, `--help` | — | Help |

Examples:

```bash
# Smaller 1080p proxies instead of originals, 5 at a time
node gopro-download.mjs --out ~/GoPro --quality high_res_proxy_mp4 --concurrency 5

# Photos too
node gopro-download.mjs --out ~/GoPro --types all

# Use Brave instead of Chrome
node gopro-download.mjs --out ~/GoPro --browser brave
```

---

## Resuming

Safe to interrupt at any time. Re-run the **same command**: completed files are
skipped (verified by size) and partial files resume via HTTP range requests.
If some items failed (network blips, etc.), the summary tells you — just run again.

---

## Manual cookie capture (any OS / browser)

If you're not on macOS Chrome, provide the cookie yourself:

1. Open <https://gopro.com/media-library> (logged in) and open **DevTools → Network**.
2. Refresh; click a request to `api.gopro.com/media/search`.
3. Under **Request Headers**, copy the entire **`cookie:`** value.
4. Pass it to the tool:

```bash
export GOPRO_COOKIE='paste-the-cookie-value-here'
node gopro-download.mjs --out /Volumes/MyDrive/GoPro
```

You can also paste a whole **"Copy as cURL"** string to `--cookie` / `GOPRO_COOKIE`;
the tool extracts the cookie header from it. Cookies expire — if you get an auth
error, grab a fresh one.

---

## Troubleshooting

- **`401 / session expired`** — re-open the media library in your browser (re-login),
  then run again. For the manual method, grab a fresh cookie.
- **Keychain popup keeps appearing** — click *Always Allow*.
- **`No gopro.com cookies found`** — you're not logged in, or in a different browser/
  profile. Use `--browser` / `--profile`, or the manual method.
- **Wrong browser profile** — pass `--profile "Profile 1"` (folder name under the
  browser's *User Data* directory).

---

## Notes & limits

- This uses an **undocumented** API; GoPro could change it at any time.
- Respect GoPro's Terms of Service and only download media you own.
- `.part` files are in-progress downloads; they become the final file on completion.

## License

MIT — see [LICENSE](LICENSE).
