import { load as loadCheerio } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

class Hameln implements Plugin.PluginBase {
  id = 'hameln';
  name = 'Hameln';
  icon = 'src/jp/hameln/logo.png';
  site = 'https://syosetu.org';
  version = '1.0.1';

  private parseCards(
    loadedCheerio: ReturnType<typeof loadCheerio>,
  ): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    loadedCheerio('a[href^="/novel/"]').each((_, el) => {
      const href = loadedCheerio(el).attr('href') || '';
      const idMatch = href.match(/^\/novel\/(\d+)\/?$/);
      if (!idMatch) return;
      const name = loadedCheerio(el).text().trim();
      if (!name) return;
      const path = '/novel/' + idMatch[1] + '/';
      if (novels.some(n => n.path === path)) return;
      novels.push({ name, path, cover: defaultCover });
    });
    return novels;
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    let url: string;
    if (showLatestNovels) {
      url = this.site + '/';
    } else {
      url =
        this.site +
        '/?mode=' +
        filters.rank.value +
        (page > 1 ? '&page=' + page : '');
    }
    const body = await fetchText(url);
    if (!body) return [];
    return this.parseCards(loadCheerio(body));
  }

  private novelIdFromPath(novelPath: string): string {
    const match = novelPath.match(/\/novel\/(\d+)/);
    return match ? match[1] : '';
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const id = this.novelIdFromPath(novelPath);
    const path = '/novel/' + id + '/';
    const novel: Plugin.SourceNovel = {
      path,
      name: id,
      cover: defaultCover,
      status: NovelStatus.Unknown,
      chapters: [],
    };
    if (!id) return novel;

    const [tocBody, detailBody] = await Promise.all([
      fetchText(this.site + path),
      fetchText(this.site + '/?mode=ss_detail&nid=' + id),
    ]);
    if (!tocBody && !detailBody) return novel;

    if (detailBody) {
      const $ = loadCheerio(detailBody);
      const field = (label: string): string => {
        let value = '';
        $('tr').each((_, el) => {
          const cells = $(el).find('th, td');
          if (cells.length >= 2 && $(cells[0]).text().trim().includes(label)) {
            value = $(cells[1]).text().trim();
          }
        });
        return value;
      };
      novel.name = field('タイトル') || novel.name;
      novel.author = field('作者') || undefined;
      novel.summary = field('あらすじ') || undefined;
      const tags = field('タグ');
      const origin = field('原作');
      const genres = [origin, tags].filter(g => g).join(',');
      if (genres) novel.genres = genres;
      const statusText = field('話数') + field('完結');
      if (/完結/.test(statusText)) novel.status = NovelStatus.Completed;
      else if (/連載|連載中/.test(statusText))
        novel.status = NovelStatus.Ongoing;
    }

    if (tocBody) {
      const $ = loadCheerio(tocBody);
      if (!novel.name || novel.name === id) {
        const title = $('title')
          .text()
          .trim()
          .split(/[-|｜]/)[0]
          .trim();
        if (title) novel.name = title;
      }
      const chapters: Plugin.ChapterItem[] = [];
      const linkRe = new RegExp('^/novel/' + id + '/\\d+\\.html$');
      $('a').each((idx, el) => {
        const href = $(el).attr('href') || '';
        if (!linkRe.test(href)) return;
        if (chapters.some(c => c.path === href)) return;
        chapters.push({
          name: $(el).text().trim() || 'Chapter ' + (chapters.length + 1),
          path: href,
          chapterNumber: chapters.length + 1,
        });
        void idx;
      });
      // Single-chapter works render the body on the novel page itself.
      if (!chapters.length && $('#honbun').length) {
        chapters.push({ name: novel.name, path, chapterNumber: 1 });
      }
      novel.chapters = chapters;
    }

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const body = await fetchText(this.site + chapterPath);
    if (!body) return '';
    const $ = loadCheerio(body);
    const title = $('title')
      .text()
      .trim()
      .split(/[-|｜]/)[0]
      .trim();
    const honbun = $('#honbun');
    if (!honbun.length) return '';
    honbun.find('script').remove();
    return (title ? '<h1>' + title + '</h1>' : '') + (honbun.html() || '');
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const url =
      this.site +
      '/search?mode=search&word=' +
      encodeURIComponent(searchTerm) +
      (page > 1 ? '&page=' + page : '');
    const body = await fetchText(url);
    if (!body) return [];
    return this.parseCards(loadCheerio(body));
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return this.site + path;
  }

  filters = {
    rank: {
      type: FilterTypes.Picker,
      label: 'Ranking',
      value: 'rank_total',
      options: [
        { label: '総合 (累計)', value: 'rank_total' },
        { label: '日間', value: 'rank_day' },
        { label: '週間', value: 'rank_week' },
        { label: '月間', value: 'rank_month' },
      ],
    },
  } satisfies Filters;
}

export default new Hameln();
