// Thin wrapper around the (undocumented) GoPro media API that the media-library
// website uses. Auth is via the browser session cookie.

const BASE = 'https://api.gopro.com';
const ACCEPT = 'application/vnd.gopro.jk.media+json; version=2.0.0';

// Media types that are videos.
export const VIDEO_TYPES = ['Video', 'LoopedVideo', 'TimeLapseVideo', 'BurstVideo'];
export const PHOTO_TYPES = ['Photo', 'Burst', 'Continuous', 'TimeLapse', 'NightLapse'];

export class GoProClient {
  constructor(cookieHeader) {
    this.cookie = cookieHeader;
  }

  async #get(pathAndQuery, { retries = 4 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(BASE + pathAndQuery, {
          headers: {
            'Accept': ACCEPT,
            'Cookie': this.cookie,
            'Origin': 'https://gopro.com',
            'Referer': 'https://gopro.com/',
            'User-Agent': 'gopro-media-downloader',
          },
        });
        if (res.status === 401 || res.status === 403) {
          const body = await res.text().catch(() => '');
          throw new AuthError(`GoPro API returned ${res.status}. Your session cookie is missing or expired. ` +
            `Re-open https://gopro.com/media-library in your browser (log in), then run again. ${body.slice(0, 120)}`);
        }
        if (res.status === 429) { // rate limited
          const wait = (parseInt(res.headers.get('retry-after') || '0', 10) || (attempt + 1) * 3) * 1000;
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`GoPro API ${res.status} for ${pathAndQuery.slice(0, 80)}`);
        return await res.json();
      } catch (err) {
        if (err instanceof AuthError) throw err;
        lastErr = err;
        await sleep((attempt + 1) * 1000);
      }
    }
    throw lastErr;
  }

  // Paginate the full media list. Yields media items (not download URLs).
  async *listMedia({ types = VIDEO_TYPES, perPage = 100, fields } = {}) {
    const f = fields || 'id,filename,type,file_size,captured_at,width,height,source_duration,camera_model';
    let page = 1;
    while (true) {
      const q = `/media/search?fields=${encodeURIComponent(f)}` +
        `&type=${types.join(',')}&page=${page}&per_page=${perPage}`;
      const json = await this.#get(q);
      const items = (json._embedded && json._embedded.media) || [];
      for (const it of items) yield it;
      const pages = json._pages;
      if (!pages || page >= pages.total_pages || items.length === 0) break;
      page++;
    }
  }

  // Convenience: total count + list in one pass.
  async collectMedia(opts = {}) {
    const items = [];
    for await (const it of this.listMedia(opts)) items.push(it);
    return items;
  }

  // Mint a fresh, signed CDN download URL for one media item.
  // quality: 'source' (original) | 'high_res_proxy_mp4' | 'edit_proxy' | ...
  // Falls back to the best available original if the requested label is absent.
  async getDownloadUrl(mediaId, quality = 'source') {
    const json = await this.#get(`/media/${mediaId}/download`);
    const emb = json._embedded || {};
    const variations = emb.variations || [];
    const files = emb.files || [];

    const pick =
      variations.find(v => v.label === quality) ||
      variations.find(v => v.label === 'source') ||
      (files.find(f => f.url) && { url: files.find(f => f.url).url, label: 'file' }) ||
      // largest variation by pixel area as a last resort
      variations.filter(v => v.url).sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];

    if (!pick || !pick.url) throw new Error(`No downloadable variation for media ${mediaId}`);
    return {
      url: pick.url,
      label: pick.label,
      type: pick.type,
      width: pick.width,
      height: pick.height,
      filename: json.filename,
    };
  }
}

export class AuthError extends Error {}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
