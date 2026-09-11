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
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function novelContentToHtml(content: string): string {
  const parts: string[] = [];
  const blocks = content.split('[newpage]');
  for (let b = 0; b < blocks.length; b++) {
    if (b > 0) parts.push('<hr>');
    const lines = blocks[b].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const chapterMatch = line.match(/^\[chapter:(.*)\]$/);
      if (chapterMatch) {
        parts.push('<h2>' + escapeHtml(chapterMatch[1].trim()) + '</h2>');
        continue;
      }
      if (/^\[pixivimage:[^\]]+\]$/.test(line.trim())) continue;
      parts.push('<p>' + escapeHtml(line) + '</p>');
    }
  }
  return parts.join('');
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
  version = '1.0.2';
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

  private isSeriesPath(novelPath: string): boolean {
    return novelPath.replace(/^\/|\/$/g, '').split('/')[0] === 'series';
  }

  private seriesIdFromPath(novelPath: string): string {
    return novelPath.replace(/^\/|\/$/g, '').split('/')[1] || '';
  }

  private novelIdFromPath(novelPath: string): string {
    return novelPath.replace(/^\/|\/$/g, '').split('/')[1] || '';
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
          path: '/series/' + entry.series_id,
          cover: entry.url || defaultCover,
        });
      } else {
        novels.push({
          name: entry.title + '',
          path: '/novel/' + entry.id,
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
          path: '/novel/' + ep.id,
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
      const path = '/series/' + seriesId;
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
    const path = '/novel/' + novelId;
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
    if (!novelId || chapterPath.indexOf('/series/') === 0) return '';
    const json = (await this.getJson(
      API + '/novel/' + novelId + '?' + LANG,
    )) as { body?: NovelBody } | null;
    const body = (json && json.body) || null;
    if (!body || !body.content) return '';
    return (
      '<h1>' +
      escapeHtml(body.title || '') +
      '</h1>' +
      novelContentToHtml(body.content)
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
          path: '/series/' + entry.seriesId,
          cover: defaultCover,
        });
      } else {
        novels.push({
          name: entry.title || entry.id,
          path: '/novel/' + entry.id,
          cover: defaultCover,
        });
      }
    }
    return dedupeByPath(novels);
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const clean = '/' + path.replace(/^\/|\/$/g, '');
    if (clean.indexOf('/series/') === 0) {
      return this.site + '/novel/series/' + clean.split('/')[2];
    }
    return this.site + '/novel/show.php?id=' + clean.split('/')[2];
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
