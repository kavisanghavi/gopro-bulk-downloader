# gopro-media-downloader

Download your **entire** GoPro cloud media library from the command line — no
25-items-at-a-time limit, no clicking through the website.

- ✅ Downloads **original quality** (or smaller proxies) straight from GoPro's CDN
- ✅ **Resumable** — Ctrl-C and re-run; finished files skip, partial files continue
- ✅ Handles thousands of files / hundreds of GB, saved anywhere (e.g. an external drive)
- ✅ **Zero dependencies** — just Node. Uses your existing browser login; no password needed
- ✅ **Read-only** — never modifies or deletes anything in your GoPro account
- ✅ Free for personal / non-commercial use ([license](#license))

> Use it only for **your own** media that you have the right to download.
> Not affiliated with or endorsed by GoPro, Inc.

---

## How it works

GoPro's website only *shows* a "download up to 25" button, but the underlying API
(`api.gopro.com`, the same one the site uses) has no such limit. This tool:

1. Reads your GoPro session cookie from your browser (so it's authenticated as you).
2. Lists every item in your library via the media API.
3. For each item, mints a fresh signed download URL and streams the file to disk.

Signed URLs expire after ~1 hour, so URLs are generated **just before** each
download and re-minted automatically if a large transfer gets interrupted.

Recordings the camera split into multiple **chapters** (anything that ends up
over ~4GB as a single file, e.g. long 4K/5K clips) are stored by GoPro as one
media item but multiple downloadable parts. The tool detects every chapter and
downloads each one (saved as separate files, e.g. `GX010701.MP4` +
`GX020701.MP4`) — not just the first — so nothing gets silently truncated.

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
git clone https://github.com/kavisanghavi/gopro-bulk-downloader.git
cd gopro-bulk-downloader

# Dry run first — lists what would download, nothing is written:
node gopro-download.mjs --out /Volumes/MyDrive/GoPro --dry-run

# Then the real thing:
node gopro-download.mjs --out /Volumes/MyDrive/GoPro
```

### About the Keychain / password prompt

The first run triggers a macOS **Keychain** prompt — a popup saying
*"security wants to use your confidential information stored in "Chrome Safe
Storage" in your keychain"* (`security` is macOS's built-in Keychain command-line
tool, which this script calls). Click **Allow**. If your login keychain happens
to be locked, macOS first asks for **your Mac user account password** to unlock it.

> **Click "Allow", not "Always Allow".** "Always Allow" permanently lets the
> `security` tool read Chrome's cookie encryption key without asking — for
> *any* program on your Mac, not just this one. One prompt per run is the
> safer trade-off. If you already clicked it, you can undo it in **Keychain
> Access → "Chrome Safe Storage" → Access Control**.


That's your **Mac login password, not your GoPro password** — GoPro's own
password is never touched; the tool only ever reads a session cookie. Here's
why it's needed: Chrome encrypts the cookies it stores on disk, and it keeps
the decryption key in your Mac's login Keychain (an item called "Chrome Safe
Storage"). To read your `gopro.com` session cookie the same way Chrome itself
does, this tool has to ask the Keychain for that key — which is exactly the
system dialog you're seeing. Everything happens locally: the key and the
cookie never leave your machine, and this tool has zero network calls other
than to `api.gopro.com` and GoPro's CDN.

Files are organized by capture date:

```
/Volumes/MyDrive/GoPro/
  2025-12-06/GX010042.MP4
  2026-01-19/GX011208.MP4
  2023-12-08/GX010701.MP4        ← chapter 1 of a long recording
  2023-12-08/GX020701.MP4        ← chapter 2 of the same recording
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
read -rs GOPRO_COOKIE && export GOPRO_COOKIE   # paste, press Enter (input is hidden)
node gopro-download.mjs --out /Volumes/MyDrive/GoPro
```

Using `read -rs` keeps the cookie out of your shell history. (`--cookie <value>`
also works, but the value is visible to other processes via `ps` and ends up in
history — prefer the env var.) Your session cookie is equivalent to being logged
in to your GoPro account, so don't paste it anywhere else.

You can also paste a whole **"Copy as cURL"** string; the tool extracts the
cookie from it. Cookies expire — if you get an auth error, grab a fresh one.

---

## Troubleshooting

- **`401 / session expired`** — re-open the media library in your browser (re-login),
  then run again. For the manual method, grab a fresh cookie.
- **Keychain / password prompt appears every run** — that's expected; click
  *Allow*. See [About the Keychain / password prompt](#about-the-keychain--password-prompt)
  for why *Always Allow* isn't recommended. To avoid the prompt entirely, use
  the [manual cookie method](#manual-cookie-capture-any-os--browser).
- **`No gopro.com cookies found`** — you're not logged in, or in a different browser/
  profile. Use `--browser` / `--profile`, or the manual method.
- **Wrong browser profile** — pass `--profile "Profile 1"` (folder name under the
  browser's *User Data* directory).

---

## Notes & limits

- This uses an **undocumented** API; GoPro could change it at any time.
- Respect GoPro's Terms of Service and only download media you own.
- `.part` files are in-progress downloads; they become the final file on completion.
- Multi-chapter recordings (long clips split by the camera at ~4GB) download as
  multiple sibling files per item; the on-disk total is the source of truth, not
  the single-file size shown for the item in GoPro's library UI.

## Security & privacy

This tool handles your GoPro login session, so here's exactly what it does:

- **What it reads:** only cookies for `gopro.com` / `*.gopro.com` from your
  browser's cookie database. It uses the "Chrome Safe Storage" Keychain key to
  decrypt them; that key stays in memory and is never written to disk or logged.
  A temporary copy of the cookie database is made in a private temp folder and
  deleted right after.
- **Where it connects:** `api.gopro.com` (listing media, requesting download
  links) and the HTTPS download links GoPro returns. Your cookie is sent **only**
  to `api.gopro.com`. There is no telemetry, analytics, or any other server.
- **What it changes:** nothing in your GoPro account — every API call is a
  read-only `GET`. On disk it only writes inside your `--out` folder.
- **Dependencies:** none. ~600 lines of plain Node.js across 4 files — you can
  read the whole thing in a few minutes. To check every network call yourself:
  `grep -n "fetch(" gopro-download.mjs lib/*.mjs`.
- Prefer not to grant Keychain access at all? Use the
  [manual cookie method](#manual-cookie-capture-any-os--browser) — the tool then
  never touches your browser's files.

Found a security issue? Please open a GitHub issue (or contact me privately via
my GitHub profile for anything sensitive).

---

## License

**Free for personal and other non-commercial use** under the
[PolyForm Noncommercial License 1.0.0](LICENSE) — back up your own library,
share it with friends, modify it, all fine.

**Commercial use** (using it in or for a business, a paid service, or a
product) requires a separate commercial license — reach out via
[GitHub](https://github.com/kavisanghavi).
