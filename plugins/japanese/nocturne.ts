import { load as loadCheerio } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

const NOVEL_API = 'https://api.syosetu.com/novel18api/api/';
const PAGE_SIZE = 20;
// Nocturne (male-oriented) section of the R18 API. 2 = Moonlight,
// 3 = Moonlight BL, 4 = Midnight.
const NOC_GENRE = '1';
// Age-gate bypass: the gate JS only sets `over18=yes` on .syosetu.com.
const AGE_HEADERS = { Cookie: 'over18=yes' };

type NovelApiRow = {
  title?: string;
  ncode?: string;
  writer?: string;
  story?: string;
  nocgenre?: number;
  keyword?: string;
  general_lastup?: string;
  noveltype?: number;
  end?: number;
  general_all_no?: number;
  length?: number;
  time?: number;
  isstop?: number;
};

type NovelApiResponse = [{ allcount?: number }, ...NovelApiRow[]];

const RANK_TO_ORDER: Record<string, string> = {
  daily: 'dailypoint',
  weekly: 'weeklypoint',
  monthly: 'monthlypoint',
  quarter: 'quarterpoint',
  yearly: 'yearlypoint',
  total: 'hyoka',
};

const MODIFIER_TO_TYPE: Record<string, string> = {
  total: '',
  r: 'r',
  er: 'er',
  t: 't',
};

class Nocturne implements Plugin.PluginBase {
  id = 'noc.syosetu';
  name = 'Nocturne';
  icon = 'src/jp/nocturne/logo.png';
  site = 'https://noc.syosetu.com/';
  novelPrefix = 'https://novel18.syosetu.com';
  version = '1.0.2';

  private normalizeNcode(ncode: string): string {
    return ncode.toLowerCase();
  }

  private toNovelPath(ncode: string): string {
    const code = this.normalizeNcode(ncode);
    return '/' + code.replace(/^\/|\/$/g, '') + '/';
  }

  private async queryNovelApi(params: string): Promise<NovelApiRow[]> {
    const url = NOVEL_API + '?' + params + '&nocgenre=' + NOC_GENRE;
    const text = await fetchText(url);
    if (!text) return [];
    let json: NovelApiResponse;
    try {
      json = JSON.parse(text) as NovelApiResponse;
    } catch {
      return [];
    }
    if (!json || !Array.isArray(json) || json.length < 2) return [];
    return json.slice(1) as NovelApiRow[];
  }

  private toNovelItem(row: NovelApiRow): Plugin.NovelItem | null {
    if (!row.ncode) return null;
    return {
      name: row.title || row.ncode,
      path: this.toNovelPath(row.ncode),
      cover: defaultCover,
    };
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const st = (page - 1) * PAGE_SIZE + 1;
    let params: string;

    if (showLatestNovels) {
      params = 'out=json&of=t-n&lim=' + PAGE_SIZE + '&st=' + st + '&order=new';
    } else {
      const order = RANK_TO_ORDER[filters.ranking.value] || 'hyoka';
      const type = MODIFIER_TO_TYPE[filters.modifier.value] || '';
      params =
        'out=json&of=t-n&lim=' + PAGE_SIZE + '&st=' + st + '&order=' + order;
      const elements = filters.elements.value;
      if (elements.length) {
        for (let i = 0; i < elements.length; i++) {
          params += '&' + elements[i] + '=1';
        }
      }
      if (type) params += '&type=' + type;
    }

    const rows = await this.queryNovelApi(params);
    const novels: Plugin.NovelItem[] = [];
    rows.forEach(row => {
      const item = this.toNovelItem(row);
      if (item) novels.push(item);
    });
    return novels;
  }

  private parseChapterList(
    loadedCheerio: ReturnType<typeof loadCheerio>,
  ): Plugin.ChapterItem[] {
    const chapters: Plugin.ChapterItem[] = [];
    loadedCheerio('.p-eplist__sublist').each((_, element) => {
      const chapterLink = loadedCheerio(element).find('a');
      const chapterUrl = chapterLink.attr('href');
      const chapterName = chapterLink.text().trim();
      const releaseDate = loadedCheerio(element)
        .find('.p-eplist__update')
        .text()
        .trim()
        .split(' ')[0]
        .replace(/\//g, '-');

      if (chapterUrl) {
        chapters.push({
          name: chapterName,
          releaseTime: releaseDate,
          path: chapterUrl.replace(this.novelPrefix, ''),
        });
      }
    });
    return chapters;
  }

  private async fetchChapterPage(
    novelPath: string,
    page: number,
  ): Promise<{ chapters: Plugin.ChapterItem[]; totalPages: number }> {
    const url = this.novelPrefix + novelPath + (page > 1 ? '?p=' + page : '');
    const body = await fetchText(url, { headers: AGE_HEADERS });
    if (!body) return { chapters: [], totalPages: 1 };
    const loadedCheerio = loadCheerio(body);
    const chapters = this.parseChapterList(loadedCheerio);
    const lastPageLink = loadedCheerio('.c-pager__item--last').attr('href');
    let totalPages = 1;
    if (lastPageLink) {
      const match = lastPageLink.match(/\?p=(\d+)/);
      if (match) totalPages = Math.max(1, parseInt(match[1], 10));
    }
    return { chapters, totalPages };
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel & { totalPages: number }> {
    const ncode = this.normalizeNcode(
      novelPath.replace(/^\/|\/$/g, '').split('/')[0],
    );
    const path = this.toNovelPath(ncode);

    const [metaRows, firstPage] = await Promise.all([
      this.queryNovelApi(
        'out=json&of=t-w-s-k-gl-ga-e-nt-l-ti-i&ncode=' +
          encodeURIComponent(ncode),
      ),
      this.fetchChapterPage(path, 1),
    ]);
    const meta = metaRows[0];

    let status: string = NovelStatus.Unknown;
    if (meta) {
      if (meta.noveltype === 2 || meta.end === 0) {
        status = NovelStatus.Completed;
      } else if (meta.isstop === 1) {
        status = NovelStatus.OnHiatus;
      } else {
        status = NovelStatus.Ongoing;
      }
    }

    const novel: Plugin.SourceNovel & { totalPages: number } = {
      path,
      name: (meta && meta.title) || ncode,
      author: (meta && meta.writer) || '',
      status,
      artist: '',
      cover: defaultCover,
      summary: (meta && meta.story) || '',
      genres: meta && meta.keyword ? meta.keyword.split(' ').join(',') : '',
      chapters: firstPage.chapters,
      totalPages: firstPage.totalPages,
    };

    // Tanpen (short stories, noveltype === 2) have no chapter list — the
    // novel page itself is the story body. Synthesize a single chapter
    // pointing at the novel path so the book opens; parseChapter reads
    // the same URL.
    if (
      novel.chapters.length === 0 &&
      meta &&
      meta.noveltype === 2 &&
      firstPage.totalPages <= 1
    ) {
      novel.chapters = [
        {
          name: novel.name,
          path,
          releaseTime:
            (meta.general_lastup && meta.general_lastup.split(' ')[0]) || '',
          chapterNumber: 1,
        },
      ];
      novel.totalPages = 1;
    }

    if (!novel.summary || !novel.author) {
      const body = await fetchText(this.novelPrefix + path, {
        headers: AGE_HEADERS,
      });
      if (body) {
        const $ = loadCheerio(body);
        if (!novel.author) {
          novel.author = $('.p-novel__author')
            .text()
            .replace('作者：', '')
            .trim();
        }
        if (!novel.summary) {
          novel.summary = $('#novel_ex').html() || '';
        }
        if (!novel.genres) {
          const og = $('meta[property="og:description"]').attr('content');
          if (og) novel.genres = og.split(' ').join(',');
        }
        if (status === NovelStatus.Unknown) {
          const announce = $('.c-announce').text();
          if (announce.includes('完結')) novel.status = NovelStatus.Completed;
          else if (announce.includes('更新されていません'))
            novel.status = NovelStatus.OnHiatus;
          else if (announce) novel.status = NovelStatus.Ongoing;
        }
      }
    }

    return novel;
  }

  async parsePage(novelPath: string, page: string): Promise<Plugin.SourcePage> {
    const pageNo = parseInt(page, 10);
    if (!Number.isInteger(pageNo) || pageNo < 1)
      throw new Error('Invalid page');
    const ncode = this.normalizeNcode(
      novelPath.replace(/^\/|\/$/g, '').split('/')[0],
    );
    const { chapters } = await this.fetchChapterPage(
      this.toNovelPath(ncode),
      pageNo,
    );
    return { chapters };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.novelPrefix + chapterPath;
    const body = await fetchText(url, { headers: AGE_HEADERS });
    if (!body) return '';

    const cheerioQuery = loadCheerio(body);
    const chapterTitle = cheerioQuery('.p-novel__title').html() || '';
    const chapterContent =
      cheerioQuery(
        '.p-novel__body .p-novel__text:not([class*="p-novel__text--"])',
      ).html() || '';

    return '<h1>' + chapterTitle + '</h1>' + chapterContent;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const st = (page - 1) * PAGE_SIZE + 1;
    const params =
      'out=json&of=t-n&lim=' +
      PAGE_SIZE +
      '&st=' +
      st +
      '&order=hyoka&word=' +
      encodeURIComponent(searchTerm);
    const rows = await this.queryNovelApi(params);
    const novels: Plugin.NovelItem[] = [];
    rows.forEach(row => {
      const item = this.toNovelItem(row);
      if (item) novels.push(item);
    });
    return novels;
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return this.novelPrefix + path;
  }

  filters = {
    ranking: {
      type: FilterTypes.Picker,
      label: 'Ranked by',
      options: [
        { label: '日間', value: 'daily' },
        { label: '週間', value: 'weekly' },
        { label: '月間', value: 'monthly' },
        { label: '四半期', value: 'quarter' },
        { label: '年間', value: 'yearly' },
        { label: '累計', value: 'total' },
      ],
      value: 'total',
    },
    elements: {
      type: FilterTypes.CheckboxGroup,
      label: 'Elements',
      value: [],
      options: [
        { label: 'ボーイズラブ', value: 'isbl' },
        { label: 'ガールズラブ', value: 'isgl' },
        { label: '残酷な描写あり', value: 'iszankoku' },
        { label: '異世界転生', value: 'istensei' },
        { label: '異世界転移', value: 'istenni' },
      ],
    },
    modifier: {
      type: FilterTypes.Picker,
      label: 'Modifier',
      options: [
        { label: 'すべて', value: 'total' },
        { label: '連載中', value: 'r' },
        { label: '完結済', value: 'er' },
        { label: '短編', value: 't' },
      ],
      value: 'total',
    },
  } satisfies Filters;
}

export default new Nocturne();
