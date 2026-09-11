import { load as loadCheerio } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

const NOVEL_API = 'https://api.syosetu.com/novelapi/api/';
const PAGE_SIZE = 20;

type NovelApiRow = {
  title?: string;
  ncode?: string;
  writer?: string;
  story?: string;
  genre?: number;
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

class Syosetu implements Plugin.PluginBase {
  id = 'yomou.syosetu';
  name = 'Syosetu';
  icon = 'src/jp/syosetu/icon.png';
  site = 'https://yomou.syosetu.com/';
  novelPrefix = 'https://ncode.syosetu.com';
  version = '1.2.1';

  private normalizeNcode(ncode: string): string {
    return ncode.toLowerCase();
  }

  private toNovelPath(ncode: string): string {
    const code = this.normalizeNcode(ncode);
    return '/' + code.replace(/^\/|\/$/g, '') + '/';
  }

  private async queryNovelApi(params: string): Promise<NovelApiRow[]> {
    const url = NOVEL_API + '?' + params;
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
      const genre = filters.genre.value;
      params =
        'out=json&of=t-n&lim=' + PAGE_SIZE + '&st=' + st + '&order=' + order;
      // isekai-list pseudo-genres (rank/isekailist) map to biggenre + tenni/tensei flag
      if (genre === '1') params += '&biggenre=1&istt=1';
      else if (genre === '2') params += '&biggenre=2&istt=1';
      else if (genre === 'o') params += '&biggenre=3-4-99&istt=1';
      else if (genre) params += '&genre=' + encodeURIComponent(genre);
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
    const body = await fetchText(url);
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
        'out=json&of=t-w-s-g-k-gl-ga-e-nt-l-ti-i&ncode=' +
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

    if (!novel.summary || !novel.author) {
      const body = await fetchText(this.novelPrefix + path);
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
    const body = await fetchText(url);
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
    genre: {
      type: FilterTypes.Picker,
      label: 'Ranking Genre',
      options: [
        { label: '総ジャンル', value: '' },
        { label: '異世界転生/転移〔恋愛〕〕', value: '1' },
        { label: '異世界転生/転移〔ファンタジー〕', value: '2' },
        { label: '異世界転生/転移〔文芸・SF・その他〕', value: 'o' },
        { label: '異世界〔恋愛〕', value: '101' },
        { label: '現実世界〔恋愛〕', value: '102' },
        { label: 'ハイファンタジー〔ファンタジー〕', value: '201' },
        { label: 'ローファンタジー〔ファンタジー〕', value: '202' },
        { label: '純文学〔文芸〕', value: '301' },
        { label: 'ヒューマンドラマ〔文芸〕', value: '302' },
        { label: '歴史〔文芸〕', value: '303' },
        { label: '推理〔文芸〕', value: '304' },
        { label: 'ホラー〔文芸〕', value: '305' },
        { label: 'アクション〔文芸〕', value: '306' },
        { label: 'コメディー〔文芸〕', value: '307' },
        { label: 'VRゲーム〔SF〕', value: '401' },
        { label: '宇宙〔SF〕', value: '402' },
        { label: '空想科学〔SF〕', value: '403' },
        { label: 'パニック〔SF〕', value: '404' },
        { label: '童話〔その他〕', value: '9901' },
        { label: '詩〔その他〕', value: '9902' },
        { label: 'エッセイ〔その他〕', value: '9903' },
        { label: 'その他〔その他〕', value: '9999' },
      ],
      value: '',
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

export default new Syosetu();
