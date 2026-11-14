import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

const API = 'https://www.pixiv.net/ajax';
const LANG = 'lang=en';

type RankEntry = {
  id?: string;
  title?: string;
  url?: string;
  series_id?: string | null;
  series_title?: string | null;
  xRestrict?: number;
};

type SearchEntry = {
  id?: string;
  title?: string;
  xRestrict?: number;
  seriesId?: string | null;
  seriesTitle?: string | null;
};

type SeriesInfo = {
  id?: string;
  title?: string;
  caption?: string;
  userName?: string;
  cover?: { urls?: { original?: string } };
  isConcluded?: boolean;
};

type SeriesEpisode = {
  id?: string;
  title?: string;
  seriesContentOrder?: number;
};

type NovelBody = {
  id?: string;
  title?: string;
  description?: string;
  content?: string;
  coverUrl?: string;
  userName?: string;
  tags?: { tags?: { tag?: string }[] };
  seriesNavData?: {
    seriesId?: number | string;
    order?: number;
    isConcluded?: boolean;
  } | null;
  // Embedded-illustration pools (present only on illustrated novels).
  textEmbeddedImages?: unknown;
  imageResponseData?: unknown;
  imageResponseOutData?: unknown;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// [[rb:BASE > RUBY]] → <ruby>BASE<rt>RUBY</rt></ruby>, segments escaped
// individually so the markup's own `>` never leaks into output.
function renderRichLine(line: string): string {
  const out: string[] = [];
  const rubyRe = /\[\[rb:(.+?) > (.+?)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rubyRe.exec(line)) !== null) {
    out.push(escapeHtml(line.slice(last, m.index)));
    out.push(
      '<ruby>' + escapeHtml(m[1]) + '<rt>' + escapeHtml(m[2]) + '</rt></ruby>',
    );
    last = m.index + m[0].length;
  }
  out.push(escapeHtml(line.slice(last)));
  return out.join('');
}

function novelContentToHtml(
  content: string,
  images?: Record<string, string>,
): string {
  const parts: string[] = [];
  const blocks = content.split('[newpage]');
  for (let b = 0; b < blocks.length; b++) {
    if (b > 0) parts.push('<hr>');
    const lines = blocks[b].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Preserve the author's blank lines (paragraph spacing) instead of
      // collapsing paragraphs together.
      if (!line.trim()) {
        parts.push('<p><br></p>');
        continue;
      }
      const chapterMatch = line.match(/^\[chapter:(.*)\]$/);
      if (chapterMatch) {
        parts.push('<h2>' + escapeHtml(chapterMatch[1].trim()) + '</h2>');
        continue;
      }
      // Embedded illustration: render when the ajax payload maps the id to
      // a file, otherwise link the artwork page instead of dropping it.
      const imgMatch = line.trim().match(/^\[pixivimage:([^\]]+)\]$/);
      if (imgMatch) {
        const imgId = imgMatch[1].trim();
        const imgUrl = (images && images[imgId]) || '';
        if (imgUrl) {
          parts.push('<p><img src="' + escapeHtml(imgUrl) + '"/></p>');
        } else if (imgId) {
          parts.push(
            '<p><a href="https://www.pixiv.net/artworks/' +
              escapeHtml(imgId) +
              '">[画像]</a></p>',
          );
        }
        continue;
      }
      parts.push('<p>' + renderRichLine(line) + '</p>');
    }
  }
  return parts.join('');
}

// Collect novel-image id → file-url mappings from the ajax payload pools.
// Shapes vary (arrays of {id,url,...} or id-keyed objects, sometimes with a
// nested urls object), so accept anything that looks like an id/url pair.
function pickImageUrl(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of [
      'original',
      'master',
      'regular',
      'small',
      'thumb',
      'url',
    ]) {
      const v = o[key];
      if (typeof v === 'string' && v) return v;
    }
    const urls = o['urls'];
    if (urls && typeof urls === 'object') return pickImageUrl(urls);
  }
  return '';
}

function collectNovelImages(body: NovelBody): Record<string, string> {
  const map: Record<string, string> = {};
  const add = (id: unknown, url: unknown) => {
    if (
      (typeof id === 'string' || typeof id === 'number') &&
      typeof url === 'string' &&
      url
    ) {
      map[String(id)] = url;
    }
  };
  const pools = [
    body.textEmbeddedImages,
    body.imageResponseData,
    body.imageResponseOutData,
  ];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    if (Array.isArray(pool)) {
      for (const entry of pool) {
        if (!entry || typeof entry !== 'object') continue;
        const o = entry as Record<string, unknown>;
        add(
          o['id'] ?? o['novelImageId'] ?? o['illustId'],
          pickImageUrl(o['url'] ?? o['urls'] ?? o['imageUrl'] ?? entry),
        );
      }
    } else {
      for (const [key, value] of Object.entries(pool)) {
        add(key, pickImageUrl(value));
        if (value && typeof value === 'object') {
          const o = value as Record<string, unknown>;
          add(
            o['id'] ?? o['novelImageId'] ?? o['illustId'],
            pickImageUrl(o['url'] ?? o['urls'] ?? o['imageUrl']),
          );
        }
      }
    }
  }
  return map;
}

// Pixiv lists every episode of a series as its own hit sharing one seriesId,
// so one search/ranking page can contain the same /series/<id> path several
// times. Duplicate paths crash app lists keyed by URL — collapse them here.
function dedupeByPath(novels: Plugin.NovelItem[]): Plugin.NovelItem[] {
  const seen = new Set<string>();
  return novels.filter(n => {
    if (seen.has(n.path)) return false;
    seen.add(n.path);
    return true;
  });
}

class Pixiv implements Plugin.PluginBase {
  id = 'pixiv';
  name = 'Pixiv';
  icon = 'src/ja/pixiv/logo.png';
  site = 'https://www.pixiv.net';
  version = '1.0.4';
  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: 'https://www.pixiv.net/',
    },
  };

  private async getJson(url: string): Promise<unknown> {
    try {
      const res = await fetchApi(url);
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Path segments of a stored path or full URL, ignoring query strings.
   * Pixiv moved novel pages to /novel/show.php?id=<id>, so older library
   * entries (/novel/<id>) and new ones must both parse.
   */
  private pathSegments(novelPath: string): string[] {
    return novelPath
      .split(/[?#]/)[0]
      .replace(/^https?:\/\/[^/]+/i, '')
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);
  }

  private queryId(novelPath: string): string {
    const match = novelPath.match(/[?&]id=(\d+)/);
    return match ? match[1] : '';
  }

  private isSeriesPath(novelPath: string): boolean {
    const segments = this.pathSegments(novelPath);
    return (
      segments[0] === 'series' ||
      (segments[0] === 'novel' && segments[1] === 'series')
    );
  }

  private seriesIdFromPath(novelPath: string): string {
    const segments = this.pathSegments(novelPath);
    if (segments[0] === 'series') return segments[1] || '';
    if (segments[0] === 'novel' && segments[1] === 'series') {
      return segments[2] || '';
    }
    return '';
  }

  private novelIdFromPath(novelPath: string): string {
    // New URL: /novel/show.php?id=<id>
    const queryId = this.queryId(novelPath);
    if (queryId) return queryId;

    const segments = this.pathSegments(novelPath);
    // Old URL: /novel/<id>
    if (segments[0] === 'novel' && /^\d+$/.test(segments[1] || '')) {
      return segments[1];
    }
    // Bare id or any other shape: use the last numeric segment.
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(segments[i])) return segments[i];
    }
    return '';
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, Math.min(pageNo || 1, 2));
    // Ranking API only serves p=1-2. Latest reuses the rookie board.
    const mode = showLatestNovels ? 'rookie' : filters.mode.value;
    const json = (await this.getJson(
      API +
        '/ranking/novel?mode=' +
        mode +
        '&content=novel&p=' +
        page +
        '&' +
        LANG,
    )) as { body?: { display_a?: { rank_a?: RankEntry[] } } } | null;
    const entries =
      (json &&
        json.body &&
        json.body.display_a &&
        json.body.display_a.rank_a) ||
      [];
    const novels: Plugin.NovelItem[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.id || entry.xRestrict === 1) continue;
      if (entry.series_id) {
        novels.push({
          name: (entry.series_title || entry.title) + '',
          path: '/novel/series/' + entry.series_id,
          cover: entry.url || defaultCover,
        });
      } else {
        novels.push({
          name: entry.title + '',
          path: '/novel/show.php?id=' + entry.id,
          cover: entry.url || defaultCover,
        });
      }
    }
    return dedupeByPath(novels);
  }

  private async seriesChapters(
    seriesId: string,
  ): Promise<{ chapters: Plugin.ChapterItem[]; info: SeriesInfo | null }> {
    const infoJson = (await this.getJson(
      API + '/novel/series/' + seriesId + '?' + LANG,
    )) as { body?: SeriesInfo } | null;
    const info = (infoJson && infoJson.body) || null;
    const chapters: Plugin.ChapterItem[] = [];
    let lastOrder = 0;
    for (let page = 0; page < 20; page++) {
      const json = (await this.getJson(
        API +
          '/novel/series_content/' +
          seriesId +
          '?limit=30&last_order=' +
          lastOrder +
          '&order_by=asc&' +
          LANG,
      )) as {
        body?: { thumbnails?: { novel?: SeriesEpisode[] } };
      } | null;
      const episodes =
        (json &&
          json.body &&
          json.body.thumbnails &&
          json.body.thumbnails.novel) ||
        [];
      if (!episodes.length) break;
      for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i];
        if (!ep.id) continue;
        chapters.push({
          name:
            ep.title ||
            'Episode ' + (ep.seriesContentOrder || chapters.length + 1),
          path: '/novel/show.php?id=' + ep.id,
          chapterNumber: ep.seriesContentOrder || chapters.length + 1,
        });
        if (
          typeof ep.seriesContentOrder === 'number' &&
          ep.seriesContentOrder > lastOrder
        ) {
          lastOrder = ep.seriesContentOrder;
        }
      }
      if (episodes.length < 30) break;
      if (!lastOrder) break;
    }
    return { chapters, info };
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    if (this.isSeriesPath(novelPath)) {
      const seriesId = this.seriesIdFromPath(novelPath);
      const path = '/novel/series/' + seriesId;
      const { chapters, info } = await this.seriesChapters(seriesId);
      const tags: string[] = [];
      const novel: Plugin.SourceNovel = {
        path,
        name: (info && info.title) || seriesId,
        author: (info && info.userName) || '',
        cover:
          (info && info.cover && info.cover.urls && info.cover.urls.original) ||
          defaultCover,
        summary: (info && info.caption) || '',
        genres: tags.join(','),
        status:
          info && info.isConcluded
            ? NovelStatus.Completed
            : NovelStatus.Ongoing,
        chapters,
      };
      return novel;
    }

    const novelId = this.novelIdFromPath(novelPath);
    const path = '/novel/show.php?id=' + novelId;
    const json = (await this.getJson(
      API + '/novel/' + novelId + '?' + LANG,
    )) as { body?: NovelBody } | null;
    const body = (json && json.body) || null;
    const novel: Plugin.SourceNovel = {
      path,
      name: (body && body.title) || novelId,
      author: (body && body.userName) || '',
      cover: (body && body.coverUrl) || defaultCover,
      summary: (body && body.description) || '',
      genres:
        (body && body.tags && body.tags.tags
          ? body.tags.tags.map(t => t.tag || '').filter(t => t)
          : []
        ).join(',') || undefined,
      status: NovelStatus.Completed,
      chapters: body
        ? [
            {
              name: body.title || novelId,
              path,
              chapterNumber: 1,
            },
          ]
        : [],
    };
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const novelId = this.novelIdFromPath(chapterPath);
    if (!novelId || this.isSeriesPath(chapterPath)) return '';
    const json = (await this.getJson(
      API + '/novel/' + novelId + '?' + LANG,
    )) as { body?: NovelBody } | null;
    const body = (json && json.body) || null;
    if (!body || !body.content) return '';
    return (
      '<h1>' +
      escapeHtml(body.title || '') +
      '</h1>' +
      novelContentToHtml(body.content, collectNovelImages(body))
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const json = (await this.getJson(
      API +
        '/search/novels/' +
        encodeURIComponent(searchTerm) +
        '?word=' +
        encodeURIComponent(searchTerm) +
        '&order=date_d&mode=safe&p=' +
        page +
        '&s_mode=s_tag&' +
        LANG,
    )) as { body?: { novel?: { data?: SearchEntry[] } } } | null;
    const entries =
      (json && json.body && json.body.novel && json.body.novel.data) || [];
    const novels: Plugin.NovelItem[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.id || entry.xRestrict === 1) continue;
      if (entry.seriesId) {
        novels.push({
          name: entry.seriesTitle || entry.title || entry.id,
          path: '/novel/series/' + entry.seriesId,
          cover: defaultCover,
        });
      } else {
        novels.push({
          name: entry.title || entry.id,
          path: '/novel/show.php?id=' + entry.id,
          cover: defaultCover,
        });
      }
    }
    return dedupeByPath(novels);
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (this.isSeriesPath(path)) {
      const seriesId = this.seriesIdFromPath(path);
      return seriesId
        ? this.site + '/novel/series/' + seriesId
        : this.site + '/' + path.replace(/^\/+/, '');
    }
    const novelId = this.novelIdFromPath(path);
    return novelId
      ? this.site + '/novel/show.php?id=' + novelId
      : this.site + '/' + path.replace(/^\/+/, '');
  }

  filters = {
    mode: {
      type: FilterTypes.Picker,
      label: 'Ranking',
      value: 'daily',
      options: [
        { label: 'Daily', value: 'daily' },
        { label: 'Weekly', value: 'weekly' },
        { label: 'Monthly', value: 'monthly' },
        { label: 'Rookie', value: 'rookie' },
        { label: 'Weekly Original', value: 'weekly_original' },
        { label: 'Weekly AI', value: 'weekly_ai' },
        { label: 'Male', value: 'male' },
        { label: 'Female', value: 'female' },
      ],
    },
  } satisfies Filters;
}

export default new Pixiv();
