import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

type SeriesRow = {
  slug?: string;
  title?: string;
  coverImage?: string;
  type?: string;
};

type SeriesListResponse = {
  data?: SeriesRow[];
  meta?: { hasMore?: boolean };
};

const REDIRECT_REGEX = /REDIRECT;\w+;([^;]+);\d+;/;
const MAX_REDIRECT_HOPS = 3;

function unescapeJs(s: string): string {
  return s
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\')
    .replace(/\\t/g, '\t');
}

function cleanTitleText(text: string): string {
  return text
    .replace(/ — New Chapters/g, '')
    .replace(/ - New Chapters/g, '')
    .trim();
}

function stripWatermark(text: string): string {
  return text
    .split('')
    .filter(ch => WATERMARK_CODES.indexOf(ch.charCodeAt(0)) < 0)
    .join('')
    .trim();
}

const WATERMARK_CODES = [
  0xfeff, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x034f, 0x2060, 0x2061,
  0x2062, 0x2063, 0x2064, 0x2069, 0xfffe,
];

function looksLikeEncryptedPayload(content: string): boolean {
  const c = content.trim();
  if (c.indexOf('"xorEncryption"') >= 0) return true;
  if (c.indexOf('"encryptedBase64"') >= 0) return true;
  if (/\$[0-9a-fA-F]{1,4}/.test(c) && c.indexOf('clientNonce') >= 0)
    return true;
  return false;
}

function parseStatus(status: string | undefined | null): string {
  if (status === 'ONGOING') return NovelStatus.Ongoing;
  if (status === 'COMPLETED' || status === 'MASS_RELEASED')
    return NovelStatus.Completed;
  if (status === 'HIATUS') return NovelStatus.OnHiatus;
  if (status === 'DROPPED' || status === 'CANCELLED')
    return NovelStatus.Cancelled;
  return NovelStatus.Unknown;
}

function typeToUrlSegment(type: string | undefined | null): string {
  if (type === 'MANHWA') return 'manhwa';
  if (type === 'MANGA') return 'manga';
  if (type === 'MANHUA') return 'manhua';
  if (type === 'WEBTOON') return 'webtoon';
  return 'novel';
}

// Portable base64 -> bytes (no Buffer/atob, Hermes-safe).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64ToBytes(b64: string): number[] {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const out: number[] = [];
  let i = 0;
  while (i < clean.length) {
    const c0 = B64.indexOf(clean.charAt(i++));
    const c1 = B64.indexOf(clean.charAt(i++));
    const c2c = clean.charAt(i++);
    const c3c = clean.charAt(i++);
    const c2 = c2c === '=' ? -1 : B64.indexOf(c2c);
    const c3 = c3c === '=' ? -1 : B64.indexOf(c3c);
    if (c0 < 0 || c1 < 0) break;
    const b0 = (c0 << 2) | (c1 >> 4);
    out.push(b0 & 0xff);
    if (c2 >= 0) {
      const b1 = ((c1 & 15) << 4) | (c2 >> 2);
      out.push(b1 & 0xff);
    }
    if (c3 >= 0) {
      const b2 = ((c2 & 3) << 6) | c3;
      out.push(b2 & 0xff);
    }
  }
  return out;
}

// Portable UTF-8 bytes -> string (no TextDecoder, Hermes-safe).
function utf8BytesToString(bytes: number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = bytes[i++] || 0;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i++] || 0;
      const b2 = bytes[i++] || 0;
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f),
      );
    } else {
      const b1 = bytes[i++] || 0;
      const b2 = bytes[i++] || 0;
      const b3 = bytes[i++] || 0;
      let cp =
        ((b0 & 0x07) << 18) |
        ((b1 & 0x3f) << 12) |
        ((b2 & 0x3f) << 6) |
        (b3 & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function utf8CharByteLen(
  s: string,
  idx: number,
): { len: number; units: number } {
  const c = s.charCodeAt(idx);
  if (c >= 0xd800 && c <= 0xdbff && idx + 1 < s.length) {
    const d = s.charCodeAt(idx + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return { len: 4, units: 2 };
  }
  if (c < 0x80) return { len: 1, units: 1 };
  if (c < 0x800) return { len: 2, units: 1 };
  return { len: 3, units: 1 };
}

// Slice a JS string by UTF-8 byte length without TextEncoder.
function utf8Slice(body: string, charStart: number, sizeBytes: number): string {
  if (charStart >= body.length || sizeBytes <= 0) return '';
  let bytes = 0;
  let end = charStart;
  while (end < body.length && bytes < sizeBytes) {
    const info = utf8CharByteLen(body, end);
    if (bytes + info.len > sizeBytes) break;
    bytes += info.len;
    end += info.units;
  }
  return body.substring(charStart, end);
}

function deriveXorKey(
  partialKeyHint: string,
  timestamp: number,
  clientNonce: string,
): number[] {
  const combined = partialKeyHint + '|' + String(timestamp) + '|' + clientNonce;
  let hash = 0x811c9dc5 >>> 0;
  for (let i = 0; i < combined.length; i++) {
    hash = Math.imul((hash ^ combined.charCodeAt(i)) >>> 0, 0x01000193) >>> 0;
  }
  const key: number[] = [];
  for (let i = 0; i < 32; i++) {
    const mixed = Math.imul(i, 0x9e3779b9) >>> 0;
    hash = Math.imul((hash ^ mixed) >>> 0, 0x01000193) >>> 0;
    key.push(hash & 0xff);
  }
  return key;
}

function decryptXorContent(
  encryptedBase64: string,
  partialKeyHint: string,
  timestamp: number,
  clientNonce: string,
): string {
  const key = deriveXorKey(partialKeyHint, timestamp, clientNonce);
  const cipher = base64ToBytes(encryptedBase64);
  const plain: number[] = [];
  for (let i = 0; i < cipher.length; i++) {
    plain.push((cipher[i] ^ key[i % 32]) & 0xff);
  }
  return utf8BytesToString(plain);
}

function resolveTTag(body: string, key: string): string | null {
  const prefix = key + ':T';
  let idx = body.indexOf('\n' + prefix);
  if (idx >= 0) {
    idx += 1;
  } else if (body.indexOf(prefix) === 0) {
    idx = 0;
  } else {
    return null;
  }
  const sizeStart = idx + prefix.length;
  const commaIdx = body.indexOf(',', sizeStart);
  if (commaIdx <= sizeStart || commaIdx - sizeStart > 8) return null;
  const sizeBytes = parseInt(body.substring(sizeStart, commaIdx), 16);
  if (isNaN(sizeBytes) || sizeBytes < 50) return null;
  const raw = utf8Slice(body, commaIdx + 1, sizeBytes);
  return stripWatermark(raw);
}

function resolveEncryptedBase64(body: string, field: string): string | null {
  if (field.charAt(0) === '$' && field.length > 1) {
    const key = field.substring(1);
    const ttag = resolveTTag(body, key);
    if (ttag) return ttag;
    const patterns = [
      new RegExp('\n' + key + ':"((?:[^"\\\\]|\\\\.)*)"'),
      new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'),
      new RegExp(key + ':"((?:[^"\\\\]|\\\\.)*)"'),
    ];
    for (const pattern of patterns) {
      const m = pattern.exec(body);
      if (m && m[1]) {
        const v = unescapeJs(m[1]);
        if (v) return v;
      }
    }
    return null;
  }
  return unescapeJs(field);
}

function extractFromXorEncryption(body: string): string | null {
  const objMatch = /"xorEncryption"\s*:\s*\{([\s\S]*?)\}/.exec(body);
  if (!objMatch) return null;
  const obj = objMatch[1];
  const encMatch = /"encryptedBase64"\s*:\s*"([^"]+)"/.exec(obj);
  const hintMatch = /"partialKeyHint"\s*:\s*"([^"]+)"/.exec(obj);
  const tsMatch = /"timestamp"\s*:\s*(\d+)/.exec(obj);
  const nonceMatch = /"clientNonce"\s*:\s*"([^"]+)"/.exec(obj);
  if (!encMatch || !hintMatch || !tsMatch || !nonceMatch) return null;
  const resolved = resolveEncryptedBase64(body, unescapeJs(encMatch[1]));
  if (!resolved) return null;
  const ts = parseInt(tsMatch[1], 10);
  if (isNaN(ts)) return null;
  const decrypted = decryptXorContent(
    resolved,
    hintMatch[1],
    ts,
    nonceMatch[1],
  );
  if (!decrypted || decrypted.trim().length < 20) return null;
  if (looksLikeEncryptedPayload(decrypted)) return null;
  return stripWatermark(decrypted);
}

function extractFromRscBody(body: string): string | null {
  const marker = '"content":"$';
  const contentIdx = body.indexOf(marker);
  if (contentIdx >= 0) {
    const keyStart = contentIdx + marker.length;
    const keyEnd = body.indexOf('"', keyStart);
    if (keyEnd > keyStart && keyEnd - keyStart <= 4) {
      const key = body.substring(keyStart, keyEnd);
      const ttag = resolveTTag(body, key);
      if (ttag && ttag.length > 50) return ttag;
    }
  }
  const re = /[0-9a-fA-F]+:T([0-9a-fA-F]+),/g;
  let m: RegExpExecArray | null;
  let best: string | null = null;
  let bestScore = 0;
  while ((m = re.exec(body)) !== null) {
    const sizeBytes = parseInt(m[1], 16);
    if (isNaN(sizeBytes) || sizeBytes < 100) continue;
    const contentStart = m.index + m[0].length;
    if (contentStart >= body.length) continue;
    const raw = utf8Slice(body, contentStart, sizeBytes);
    const content = stripWatermark(raw);
    if (!content || content.length < 50) continue;
    const trimmed = content.replace(/^\s+/, '');
    if (trimmed.indexOf('<script') === 0 || trimmed.charAt(0) === '{') continue;
    if (looksLikeEncryptedPayload(content)) continue;
    let score = Math.floor(content.length / 10);
    const pCount = (content.match(/<p[ >]/g) || []).length;
    const brCount = (content.match(/<br/g) || []).length;
    score += pCount * 50 + brCount * 5;
    if (
      content.indexOf('function ') >= 0 ||
      content.indexOf('var ') >= 0 ||
      content.indexOf('window.') >= 0
    ) {
      score -= 500;
    }
    if (content.indexOf('<script') >= 0) score -= 1000;
    if (score > bestScore && content.length > 50) {
      bestScore = score;
      best = content;
    }
  }
  return best;
}

function extractFirstGroup(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  return m ? m[1] : null;
}

function extractNames(section: string | null): string[] {
  if (!section) return [];
  const out: string[] = [];
  const re = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    out.push(unescapeJs(m[1]));
  }
  return out;
}

type LabelValue = { label: string; value: string };

const GENRE_OPTIONS: LabelValue[] = [
  { label: 'Action', value: 'action' },
  { label: 'Adventure', value: 'adventure' },
  { label: 'Comedy', value: 'comedy' },
  { label: 'Drama', value: 'drama' },
  { label: 'Fantasy', value: 'fantasy' },
  { label: 'Harem', value: 'harem' },
  { label: 'Horror', value: 'horror' },
  { label: 'Isekai', value: 'isekai' },
  { label: 'Josei', value: 'josei' },
  { label: 'Martial Arts', value: 'martial-arts' },
  { label: 'Mature', value: 'mature' },
  { label: 'Mecha', value: 'mecha' },
  { label: 'Mystery', value: 'mystery' },
  { label: 'Psychological', value: 'psychological' },
  { label: 'Reincarnation', value: 'reincarnation' },
  { label: 'Romance', value: 'romance' },
  { label: 'School Life', value: 'school-life' },
  { label: 'Sci-Fi', value: 'sci-fi' },
  { label: 'Seinen', value: 'seinen' },
  { label: 'Shoujo', value: 'shoujo' },
  { label: 'Shounen', value: 'shounen' },
  { label: 'Slice of Life', value: 'slice-of-life' },
  { label: 'Sports', value: 'sports' },
  { label: 'Supernatural', value: 'supernatural' },
  { label: 'Thriller', value: 'thriller' },
  { label: 'Tragedy', value: 'tragedy' },
  { label: 'Wuxia', value: 'wuxia' },
  { label: 'Xianxia', value: 'xianxia' },
  { label: 'Yaoi', value: 'yaoi' },
  { label: 'Yuri', value: 'yuri' },
  { label: 'Adult', value: 'adult' },
  { label: 'Ecchi', value: 'ecchi' },
  { label: 'Smut', value: 'smut' },
  { label: 'Dark Fantasy', value: 'dark-fantasy' },
  { label: 'Cultivation', value: 'cultivation' },
  { label: 'Historical', value: 'historical' },
  { label: 'Military', value: 'military' },
  { label: 'System', value: 'system' },
  { label: 'Regression', value: 'regression' },
  { label: 'Apocalypse', value: 'apocalypse' },
  { label: 'Murim', value: 'murim' },
  { label: 'Kingdom Building', value: 'kingdom-building' },
  { label: 'Tower Climbing', value: 'tower-climbing' },
  { label: 'Revenge', value: 'revenge' },
  { label: 'Overpowered', value: 'overpowered' },
  { label: 'Transmigration', value: 'transmigration' },
  { label: 'BL', value: 'bl' },
  { label: 'GL', value: 'gl' },
  { label: 'Omegaverse', value: 'omegaverse' },
  { label: 'Political', value: 'political' },
  { label: 'War', value: 'war' },
  { label: 'Zombie', value: 'zombie' },
  { label: 'Vampire', value: 'vampire' },
  { label: 'Cyberpunk', value: 'cyberpunk' },
  { label: 'Dystopia', value: 'dystopia' },
  { label: 'Survival', value: 'survival' },
  { label: 'Game World', value: 'game-world' },
  { label: 'Virtual Reality', value: 'virtual-reality' },
  { label: 'MMORPG', value: 'mmorpg' },
  { label: 'Idol', value: 'idol' },
  { label: 'Entertainment Industry', value: 'entertainment-industry' },
  { label: 'Cooking', value: 'cooking' },
  { label: 'Medical', value: 'medical' },
  { label: 'Business', value: 'business' },
  { label: 'Urban Fantasy', value: 'urban-fantasy' },
  { label: 'Modern Fantasy', value: 'modern-fantasy' },
];

const TAG_OPTIONS: LabelValue[] = [
  { label: 'Abandoned Children', value: 'abandoned-children' },
  { label: 'Ability Steal', value: 'ability-steal' },
  { label: 'Academy', value: 'academy' },
  { label: 'Aristocracy', value: 'aristocracy' },
  { label: 'Beautiful Female Lead', value: 'beautiful-female-lead' },
  { label: 'Calm Protagonist', value: 'calm-protagonist' },
  { label: 'First-time Intercourse', value: 'first-time-intercourse' },
  { label: 'Game Elements', value: 'game-elements' },
  { label: 'Hiding True Abilities', value: 'hiding-true-abilities' },
  { label: 'Magic Beasts', value: 'magic-beasts' },
  { label: 'Multiple POV', value: 'multiple-pov' },
  { label: 'Obsessive Love', value: 'obsessive-love' },
  { label: 'Summoning Magic', value: 'summoning-magic' },
  { label: 'Weak to Strong', value: 'weak-to-strong' },
  { label: 'Wizards', value: 'wizards' },
  { label: 'Yandere', value: 'yandere' },
  { label: 'Male Protagonist', value: 'male-protagonist' },
  { label: 'Female Protagonist', value: 'female-protagonist' },
  { label: 'Clever Protagonist', value: 'clever-protagonist' },
  { label: 'Royalty', value: 'royalty' },
  { label: 'Demons', value: 'demons' },
  { label: 'Monsters', value: 'monsters' },
  { label: 'Knights', value: 'knights' },
  { label: 'Elves', value: 'elves' },
  { label: 'Dragons', value: 'dragons' },
  { label: 'Necromancer', value: 'necromancer' },
  { label: 'Blacksmith', value: 'blacksmith' },
  { label: 'Healer', value: 'healer' },
  { label: 'Reincarnated in Game World', value: 'reincarnated-in-game-world' },
  { label: 'Second Chance', value: 'second-chance' },
  { label: 'Possessive Characters', value: 'possessive-characters' },
  { label: 'Love Triangle', value: 'love-triangle' },
  { label: 'Reverse Harem', value: 'reverse-harem' },
  { label: 'Hidden Identity', value: 'hidden-identity' },
  { label: 'Genius Protagonist', value: 'genius-protagonist' },
  { label: 'Overpowered Protagonist', value: 'overpowered-protagonist' },
  { label: 'Farming', value: 'farming' },
  { label: 'Childcare', value: 'childcare' },
  { label: 'Streaming', value: 'streaming' },
  { label: 'Gambling', value: 'gambling' },
  { label: 'Time Travel', value: 'time-travel' },
  { label: 'Alternate History', value: 'alternate-history' },
];

class NovelDexPlugin implements Plugin.PluginBase {
  id = 'noveldex';
  name = 'NovelDex';
  icon = 'src/en/noveldex/icon.png';
  site = 'https://noveldex.io';
  version = '1.0.1';

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: 'https://noveldex.io/',
    },
  };

  private rscInit(): { headers: Record<string, string> } {
    return { headers: { rsc: '1', Accept: '*/*' } };
  }

  private async fetchRscText(url: string): Promise<string> {
    try {
      const res = await fetchApi(url, this.rscInit());
      if (!res.ok) return '';
      return await res.text();
    } catch {
      return '';
    }
  }

  private async resolveRedirects(
    initialBody: string,
  ): Promise<{ body: string; finalPath: string | null }> {
    let body = initialBody;
    let finalPath: string | null = null;
    for (let hops = 0; hops < MAX_REDIRECT_HOPS; hops++) {
      const m = REDIRECT_REGEX.exec(body);
      if (!m) break;
      finalPath = m[1];
      const next = await this.fetchRscText(this.site + finalPath);
      if (!next) break;
      body = next;
    }
    return { body, finalPath };
  }

  private parseApiResponse(body: string): Plugin.NovelItem[] {
    const trimmed = body.replace(/^\s+/, '');
    if (!trimmed || trimmed.charAt(0) === '<') return [];
    try {
      const json = JSON.parse(body) as SeriesListResponse;
      const data = (json && json.data) || [];
      const novels: Plugin.NovelItem[] = [];
      data.forEach(row => {
        if (!row || !row.slug) return;
        const title = cleanTitleText(row.title || '');
        if (!title) return;
        const cover = row.coverImage
          ? row.coverImage.charAt(0) === '/'
            ? this.site + row.coverImage
            : row.coverImage
          : defaultCover;
        novels.push({
          name: title,
          path: '/series/' + typeToUrlSegment(row.type) + '/' + row.slug,
          cover,
        });
      });
      return novels;
    } catch {
      return [];
    }
  }

  private buildSeriesUrl(
    page: number,
    sort: string,
    search: string,
    f: {
      genres: { include?: string[]; exclude?: string[] };
      tags: { include?: string[]; exclude?: string[] };
      types: string[];
      statuses: string[];
      minCh: string;
      maxCh: string;
      hasImages: boolean;
    },
  ): string {
    let url = this.site + '/api/series?page=' + page + '&limit=24';
    if (sort) url += '&sort=' + encodeURIComponent(sort);
    if (search) url += '&search=' + encodeURIComponent(search);
    if (f.genres.include && f.genres.include.length) {
      url += '&genre=' + encodeURIComponent(f.genres.include.join(','));
    }
    if (f.genres.exclude && f.genres.exclude.length) {
      url += '&exgenre=' + encodeURIComponent(f.genres.exclude.join(','));
    }
    if (f.tags.include && f.tags.include.length) {
      url += '&tag=' + encodeURIComponent(f.tags.include.join(','));
    }
    if (f.tags.exclude && f.tags.exclude.length) {
      url += '&extag=' + encodeURIComponent(f.tags.exclude.join(','));
    }
    if (f.types.length) url += '&type=' + encodeURIComponent(f.types.join(','));
    if (f.statuses.length)
      url += '&status=' + encodeURIComponent(f.statuses.join(','));
    if (f.minCh) url += '&ch_min=' + encodeURIComponent(f.minCh);
    if (f.maxCh) url += '&ch_max=' + encodeURIComponent(f.maxCh);
    if (f.hasImages) url += '&images=true';
    return url;
  }

  // Read one filter value by candidate keys. Some app bridges re-key
  // filters from their labels (e.g. "Include Genre" -> "include_genre")
  // and merge those alongside our own keys, so check the bridge-derived
  // keys first and fall back to ours.
  private filterValue(filters: unknown, keys: string[]): unknown {
    if (!filters || typeof filters !== 'object') return undefined;
    const obj = filters as Record<string, { value?: unknown } | null>;
    for (const k of keys) {
      const entry = obj[k];
      if (entry !== undefined && entry !== null && entry.value !== undefined) {
        return entry.value;
      }
    }
    return undefined;
  }

  private pickerOptions(key: string): LabelValue[] {
    const entry = (
      this.filters as unknown as Record<string, { options?: LabelValue[] }>
    )[key];
    return (entry && entry.options) || [];
  }

  // Accept an API value directly, but also translate a display label back
  // to its value (some bridges round-trip the label that was picked).
  private normalizeOption(
    raw: unknown,
    options: LabelValue[],
    fallback: string,
  ): string {
    if (Array.isArray(raw)) raw = raw.length ? raw[0] : undefined;
    if (typeof raw === 'string') {
      for (const o of options) {
        if (o.value === raw) return raw;
      }
      for (const o of options) {
        if (o.label === raw) return o.value;
      }
    }
    return fallback;
  }

  private normalizeBool(raw: unknown, fallback = false): boolean {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return raw === 'true' || raw === '1';
    return fallback;
  }

  private normalizeText(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
  }

  private readFilterState(filters: unknown): {
    sort: string;
    genres: { include: string[]; exclude: string[] };
    tags: { include: string[]; exclude: string[] };
    types: string[];
    statuses: string[];
    minCh: string;
    maxCh: string;
    hasImages: boolean;
  } {
    const status = this.normalizeOption(
      this.filterValue(filters, ['status']),
      this.pickerOptions('status'),
      '',
    );
    const type = this.normalizeOption(
      this.filterValue(filters, ['type']),
      this.pickerOptions('type'),
      '',
    );
    const genreInc = this.normalizeOption(
      this.filterValue(filters, ['include_genre', 'genreInclude']),
      this.pickerOptions('genreInclude'),
      '',
    );
    const genreExc = this.normalizeOption(
      this.filterValue(filters, ['exclude_genre', 'genreExclude']),
      this.pickerOptions('genreExclude'),
      '',
    );
    const tagInc = this.normalizeOption(
      this.filterValue(filters, ['include_tag', 'tagInclude']),
      this.pickerOptions('tagInclude'),
      '',
    );
    const tagExc = this.normalizeOption(
      this.filterValue(filters, ['exclude_tag', 'tagExclude']),
      this.pickerOptions('tagExclude'),
      '',
    );
    return {
      sort: this.normalizeOption(
        this.filterValue(filters, ['sort']),
        this.pickerOptions('sort'),
        'popular',
      ),
      genres: {
        include: genreInc ? [genreInc] : [],
        exclude: genreExc ? [genreExc] : [],
      },
      tags: {
        include: tagInc ? [tagInc] : [],
        exclude: tagExc ? [tagExc] : [],
      },
      types: type ? [type] : [],
      statuses: status ? [status] : [],
      minCh: this.normalizeText(
        this.filterValue(filters, ['min_chapters', 'minChapters']),
      ),
      maxCh: this.normalizeText(
        this.filterValue(filters, ['max_chapters', 'maxChapters']),
      ),
      hasImages: this.normalizeBool(
        this.filterValue(filters, ['has_images', 'hasImages']),
      ),
    };
  }

  private parseSeriesBlock(seriesJson: string): {
    title: string;
    description?: string;
    author?: string;
    genres?: string;
    status?: string;
  } {
    const titleRaw = extractFirstGroup(
      /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      seriesJson,
    );
    const title = cleanTitleText(titleRaw ? unescapeJs(titleRaw) : '');
    const descRaw = extractFirstGroup(
      /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      seriesJson,
    );
    const description = descRaw ? unescapeJs(descRaw).trim() : undefined;
    const coverRaw = extractFirstGroup(
      /"coverImage"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      seriesJson,
    );
    const cover = coverRaw ? unescapeJs(coverRaw) : undefined;
    const teamRaw = extractFirstGroup(
      /"team"\s*:\s*\{[^}]*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      seriesJson,
    );
    const author = teamRaw ? unescapeJs(teamRaw) : undefined;
    const genresSection = extractFirstGroup(
      /"genres"\s*:\s*\[([\s\S]*?)\]/,
      seriesJson,
    );
    // Tags section may contain nested arrays; capture generously then trim.
    const tagsMatch = /"tags"\s*:\s*\[([\s\S]*?)\]/.exec(seriesJson);
    const genreNames = extractNames(
      genresSection ? '[' + genresSection + ']' : null,
    );
    const tagNames = extractNames(tagsMatch ? '[' + tagsMatch[1] + ']' : null);
    const genres = genreNames.concat(tagNames).join(', ') || undefined;
    const statusRaw = extractFirstGroup(
      /"status"\s*:\s*"([A-Z_]+)"/,
      seriesJson,
    );
    return {
      title,
      description: description || undefined,
      author,
      genres,
      status: parseStatus(statusRaw),
      ...(cover ? { cover } : {}),
    } as {
      title: string;
      description?: string;
      author?: string;
      genres?: string;
      status?: string;
    };
  }

  private parseDetailBody(body: string): {
    title: string;
    description?: string;
    cover?: string;
    author?: string;
    genres?: string;
    status: string;
  } {
    const seriesMatch =
      /"series"\s*:\s*(\{.+?"similarSeries"\s*:\s*\[.*?\]\s*\}[^}]*\})/s.exec(
        body,
      );
    if (seriesMatch) {
      try {
        const parsed = this.parseSeriesBlock(seriesMatch[1]);
        const coverRaw = extractFirstGroup(
          /"coverImage"\s*:\s*"((?:[^"\\]|\\.)*)"/,
          seriesMatch[1],
        );
        const cover = coverRaw ? unescapeJs(coverRaw) : undefined;
        return {
          title: parsed.title || '',
          description: parsed.description,
          author: parsed.author,
          genres: parsed.genres,
          status: parsed.status || NovelStatus.Unknown,
          cover,
        };
      } catch {
        // fall through to raw parsing
      }
    }
    const titleRaw =
      extractFirstGroup(
        /"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"slug"\s*:/,
        body,
      ) || extractFirstGroup(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/, body);
    const descRaw = extractFirstGroup(
      /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      body,
    );
    const coverRaw = extractFirstGroup(/"coverImage"\s*:\s*"(\/[^"]+)"/, body);
    const teamRaw = extractFirstGroup(
      /"team"\s*:\s*\{[^}]*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      body,
    );
    const genresSection = extractFirstGroup(
      /"genres"\s*:\s*\[([\s\S]*?)\]/,
      body,
    );
    const tagsMatch = /"tags"\s*:\s*\[([\s\S]*?)\]/.exec(body);
    const genreNames = extractNames(
      genresSection ? '[' + genresSection + ']' : null,
    );
    const tagNames = extractNames(tagsMatch ? '[' + tagsMatch[1] + ']' : null);
    const statusRaw = extractFirstGroup(/"status"\s*:\s*"([A-Z_]+)"/, body);
    return {
      title: cleanTitleText(titleRaw ? unescapeJs(titleRaw) : ''),
      description: descRaw ? unescapeJs(descRaw).trim() : undefined,
      cover: coverRaw || undefined,
      author: teamRaw ? unescapeJs(teamRaw) : undefined,
      genres: genreNames.concat(tagNames).join(', ') || undefined,
      status: parseStatus(statusRaw),
    };
  }

  private parseChaptersFromArray(
    arrText: string,
    seriesType: string,
    novelSlug: string,
    out: { name: string; chapterNumber: number; date?: string }[],
  ): void {
    try {
      const arr = JSON.parse(arrText) as {
        number?: number;
        title?: string;
        publishedAt?: string;
        isLocked?: boolean;
      }[];
      arr.forEach(ch => {
        if (!ch || typeof ch.number !== 'number') return;
        if (ch.isLocked) return;
        out.push({
          name: (ch.title || 'Chapter ' + ch.number).trim(),
          chapterNumber: ch.number,
          date: ch.publishedAt,
        });
      });
    } catch {
      // ignore malformed chunk
    }
  }

  private toChapterItems(
    novelPath: string,
    seriesType: string,
    novelSlug: string,
    raw: { name: string; chapterNumber: number; date?: string }[],
  ): Plugin.ChapterItem[] {
    void novelPath;
    const seen = new Set<number>();
    const items: Plugin.ChapterItem[] = [];
    raw.forEach(entry => {
      const n = entry.chapterNumber;
      if (seen.has(n)) return;
      seen.add(n);
      let releaseTime: string | undefined = undefined;
      if (entry.date) {
        try {
          const t = Date.parse(entry.date);
          if (!isNaN(t)) releaseTime = new Date(t).toISOString();
        } catch {
          releaseTime = undefined;
        }
      }
      items.push({
        name: entry.name,
        path: '/series/' + seriesType + '/' + novelSlug + '/chapter/' + n,
        chapterNumber: n,
        ...(releaseTime ? { releaseTime } : {}),
      });
    });
    items.sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));
    return items;
  }

  private async parseChapterListBody(
    rawBody: string,
    requestPath: string,
  ): Promise<{
    items: Plugin.ChapterItem[];
    seriesType: string;
    novelSlug: string;
  }> {
    const resolved = await this.resolveRedirects(rawBody);
    const body = resolved.body;
    const requestUrl = resolved.finalPath || requestPath;
    const slugMatch = /\/series\/([^/]+)\/([^/?]+)/.exec(requestUrl);
    const seriesType = slugMatch ? slugMatch[1] : 'novel';
    const novelSlug = slugMatch ? slugMatch[2] : '';
    const raw: { name: string; chapterNumber: number; date?: string }[] = [];

    const allMatch = /"allChapters"\s*:\s*(\[[\s\S]*?\])(?=\s*[,}])/.exec(body);
    if (allMatch) {
      this.parseChaptersFromArray(allMatch[1], seriesType, novelSlug, raw);
      if (raw.length) {
        return {
          items: this.toChapterItems(requestUrl, seriesType, novelSlug, raw),
          seriesType,
          novelSlug,
        };
      }
    }

    const chMatch = /"chapters"\s*:\s*(\[[\s\S]*?\])(?=\s*[,}])/.exec(body);
    if (chMatch) {
      this.parseChaptersFromArray(chMatch[1], seriesType, novelSlug, raw);
    }
    if (raw.length) {
      const totalPagesMatch = /"totalPages"\s*:\s*(\d+)/.exec(body);
      const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1], 10) : 1;
      if (totalPages > 1) {
        const capped = Math.min(totalPages, 20);
        for (let page = 2; page <= capped; page++) {
          try {
            const pageBody = await this.fetchRscText(
              this.site +
                '/series/' +
                seriesType +
                '/' +
                novelSlug +
                '?page=' +
                page,
            );
            if (!pageBody) continue;
            const pm = /"chapters"\s*:\s*(\[[\s\S]*?\])(?=\s*[,}])/.exec(
              pageBody,
            );
            if (pm)
              this.parseChaptersFromArray(pm[1], seriesType, novelSlug, raw);
          } catch {
            // ignore single page failure
          }
        }
      }
      return {
        items: this.toChapterItems(requestUrl, seriesType, novelSlug, raw),
        seriesType,
        novelSlug,
      };
    }

    const countMatch = /"chapterCount"\s*:\s*(\d+)/.exec(body);
    const chapterCount = countMatch ? parseInt(countMatch[1], 10) : 0;
    if (chapterCount > 0 && novelSlug) {
      const capped = Math.min(chapterCount, 5000);
      for (let n = 1; n <= capped; n++) {
        raw.push({ name: 'Chapter ' + n, chapterNumber: n });
      }
      return {
        items: this.toChapterItems(requestUrl, seriesType, novelSlug, raw),
        seriesType,
        novelSlug,
      };
    }

    if (novelSlug && requestUrl.indexOf('/chapter/') < 0) {
      try {
        const ch1 = await this.fetchRscText(
          this.site + '/series/' + seriesType + '/' + novelSlug + '/chapter/1',
        );
        if (ch1) {
          const m = /"allChapters"\s*:\s*(\[[\s\S]*?\])(?=\s*[,}])/.exec(ch1);
          if (m) {
            this.parseChaptersFromArray(m[1], seriesType, novelSlug, raw);
            if (raw.length) {
              return {
                items: this.toChapterItems(
                  requestUrl,
                  seriesType,
                  novelSlug,
                  raw,
                ),
                seriesType,
                novelSlug,
              };
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (!raw.length && novelSlug) {
      try {
        const apiRes = await fetchApi(
          this.site +
            '/api/series?page=1&limit=1&slug=' +
            encodeURIComponent(novelSlug),
        );
        if (apiRes.ok) {
          const text = await apiRes.text();
          const dataMatch = /"chapters"\s*:\s*(\[[\s\S]*?\])(?=\s*[,}])/.exec(
            text,
          );
          if (dataMatch) {
            this.parseChaptersFromArray(
              dataMatch[1],
              seriesType,
              novelSlug,
              raw,
            );
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      items: this.toChapterItems(requestUrl, seriesType, novelSlug, raw),
      seriesType,
      novelSlug,
    };
  }

  private extractFromNextData(html: string): string | null {
    try {
      const $ = loadCheerio(html);
      const data = $('script#__NEXT_DATA__').html();
      if (!data) return null;
      const root = JSON.parse(data) as {
        props?: { pageProps?: Record<string, unknown> };
      };
      const props = (root && root.props && root.props.pageProps) || {};
      const keys = ['content', 'chapterContent', 'body', 'text', 'html'];
      for (const key of keys) {
        const v = props[key];
        if (typeof v === 'string' && v.length > 50) return v;
      }
      const ch = props['chapter'] as Record<string, unknown> | undefined;
      if (ch) {
        for (const key of keys) {
          const v = ch[key];
          if (typeof v === 'string' && v.length > 50) return v as string;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const state = this.readFilterState(filters);
    const sort = showLatestNovels ? '' : state.sort;
    const url = this.buildSeriesUrl(page, sort, '', state);
    try {
      const res = await fetchApi(url);
      if (!res.ok) return [];
      return this.parseApiResponse(await res.text());
    } catch {
      return [];
    }
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const clean = novelPath.charAt(0) === '/' ? novelPath : '/' + novelPath;
    const novel: Plugin.SourceNovel = {
      path: clean,
      name: clean,
      cover: defaultCover,
      status: NovelStatus.Unknown,
      chapters: [],
    };
    const rawBody = await this.fetchRscText(this.site + clean);
    if (!rawBody) return novel;
    const resolved = await this.resolveRedirects(rawBody);
    if (resolved.finalPath) novel.path = resolved.finalPath;
    const detail = this.parseDetailBody(resolved.body);
    novel.name = detail.title || clean;
    if (detail.description) novel.summary = detail.description;
    if (detail.author) novel.author = detail.author;
    if (detail.genres) novel.genres = detail.genres;
    if (detail.status) novel.status = detail.status;
    novel.cover =
      detail.cover != null
        ? detail.cover.charAt(0) === '/'
          ? this.site + detail.cover
          : detail.cover
        : defaultCover;
    // Reuse the already-resolved body so stale slugs don't pay for the
    // redirect chain twice (resolving it again would be a no-op scan).
    const list = await this.parseChapterListBody(
      resolved.body,
      resolved.finalPath || clean,
    );
    if (list.items.length) {
      if (resolved.finalPath) novel.path = resolved.finalPath;
      novel.chapters = list.items;
    } else {
      novel.chapters = [];
    }
    return novel;
  }

  private absolutizeUrl(url: string): string {
    const s = (url || '').trim();
    if (!s) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.indexOf('//') === 0) return 'https:' + s;
    if (s.indexOf('data:') === 0) return s;
    if (s.charAt(0) === '/') return this.site + s;
    return this.site + '/' + s;
  }

  private absolutizeSrcset(srcset: string): string {
    return srcset
      .split(',')
      .map(part => {
        const pieces = part.trim().split(/\s+/);
        if (!pieces[0]) return part;
        pieces[0] = this.absolutizeUrl(pieces[0]);
        return pieces.join(' ');
      })
      .join(', ');
  }

  // Chapter HTML ships <img> tags with site-relative URLs
  // (e.g. /uploads/chapters/...); the app webview has no base URL to
  // resolve them against, so rewrite every image reference to absolute.
  private withAbsoluteImages(html: string): string {
    if (!html || html.indexOf('<img') < 0) return html;
    try {
      const $ = loadCheerio(html);
      $('img').each((_, el) => {
        const img = $(el);
        const src = img.attr('src');
        if (src) {
          img.attr('src', this.absolutizeUrl(src));
        } else {
          const lazy = img.attr('data-src') || img.attr('data-original');
          if (lazy) img.attr('src', this.absolutizeUrl(lazy));
        }
        const srcset = img.attr('srcset');
        if (srcset) img.attr('srcset', this.absolutizeSrcset(srcset));
      });
      return $('body').html() || $.html() || html;
    } catch {
      return html;
    }
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const clean =
      chapterPath.charAt(0) === '/' ? chapterPath : '/' + chapterPath;
    const url = /^https?:\/\//i.test(chapterPath)
      ? chapterPath
      : this.site + clean;
    try {
      const rscRes = await fetchApi(url, this.rscInit());
      if (rscRes.ok) {
        const rscBody = await rscRes.text();
        const resolved = await this.resolveRedirects(rscBody);
        const xor = extractFromXorEncryption(resolved.body);
        if (xor) return this.withAbsoluteImages(xor);
        const rsc = extractFromRscBody(resolved.body);
        if (rsc) return this.withAbsoluteImages(rsc);
      }
    } catch {
      // fall through to HTML
    }
    try {
      const htmlRes = await fetchApi(url);
      if (!htmlRes.ok) return '';
      const html = await htmlRes.text();
      if (!html) return '';
      const $ = loadCheerio(html);
      const selectors = [
        'div.chapter-content',
        'div.prose',
        'article.chapter',
        'div[class*=chapter-text]',
        'div[class*=chapterContent]',
        'div[class*=reading-content]',
        'div[class*=novelContent]',
      ];
      for (const selector of selectors) {
        const content = $(selector).first().html();
        if (content && content.length > 50)
          return this.withAbsoluteImages(content);
      }
      const next = this.extractFromNextData(html);
      if (next && next.length > 50) return this.withAbsoluteImages(next);
      const xor = extractFromXorEncryption(html);
      if (xor) return this.withAbsoluteImages(xor);
      const rsc = extractFromRscBody(html);
      if (rsc) return this.withAbsoluteImages(rsc);
      return '';
    } catch {
      return '';
    }
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const term = (searchTerm || '').trim();
    if (!term) return [];
    // searchNovels takes no filter args (LNReader platform limitation — the
    // reference passes browse filters here too), so search uses defaults.
    const state = {
      genres: {},
      tags: {},
      types: [],
      statuses: [],
      minCh: '',
      maxCh: '',
      hasImages: false,
    };
    const url = this.buildSeriesUrl(page, '', term, state);
    try {
      const res = await fetchApi(url);
      if (!res.ok) return [];
      return this.parseApiResponse(await res.text());
    } catch {
      return [];
    }
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (path.charAt(0) !== '/') return this.site + '/' + path;
    return this.site + path;
  }

  filters = {
    sort: {
      type: FilterTypes.Picker,
      label: 'Sort',
      value: 'popular',
      options: [
        { label: 'Recently Updated', value: '' },
        { label: 'Most Popular', value: 'popular' },
        { label: 'Newest', value: 'newest' },
        { label: 'Most Views', value: 'views' },
        { label: 'Longest', value: 'longest' },
        { label: 'Top Rated', value: 'rating' },
      ],
    },
    hasImages: {
      type: FilterTypes.Switch,
      label: 'Has Images',
      value: false,
    },
    minChapters: {
      type: FilterTypes.TextInput,
      label: 'Min Chapters',
      value: '',
    },
    maxChapters: {
      type: FilterTypes.TextInput,
      label: 'Max Chapters',
      value: '',
    },
    status: {
      type: FilterTypes.Picker,
      label: 'Status',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Ongoing', value: 'ONGOING' },
        { label: 'Completed', value: 'COMPLETED' },
        { label: 'Dropped', value: 'DROPPED' },
        { label: 'Cancelled', value: 'CANCELLED' },
        { label: 'Hiatus', value: 'HIATUS' },
        { label: 'Mass Released', value: 'MASS_RELEASED' },
        { label: 'Coming Soon', value: 'COMING_SOON' },
      ],
    },
    type: {
      type: FilterTypes.Picker,
      label: 'Type',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Web Novel', value: 'WEB_NOVEL' },
        { label: 'Manhwa', value: 'MANHWA' },
        { label: 'Manga', value: 'MANGA' },
        { label: 'Manhua', value: 'MANHUA' },
        { label: 'Webtoon', value: 'WEBTOON' },
      ],
    },
    genreInclude: {
      type: FilterTypes.Picker,
      label: 'Include Genre',
      value: '',
      options: [{ label: 'All', value: '' }, ...GENRE_OPTIONS],
    },
    genreExclude: {
      type: FilterTypes.Picker,
      label: 'Exclude Genre',
      value: '',
      options: [{ label: 'None', value: '' }, ...GENRE_OPTIONS],
    },
    tagInclude: {
      type: FilterTypes.Picker,
      label: 'Include Tag',
      value: '',
      options: [{ label: 'All', value: '' }, ...TAG_OPTIONS],
    },
    tagExclude: {
      type: FilterTypes.Picker,
      label: 'Exclude Tag',
      value: '',
      options: [{ label: 'None', value: '' }, ...TAG_OPTIONS],
    },
  } satisfies Filters;
}

export default new NovelDexPlugin();
