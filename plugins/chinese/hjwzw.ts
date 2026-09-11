import { load as loadCheerio } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

const NO_RESULT_MARK = '對不起,沒有找到文章';

class Hjwzw implements Plugin.PluginBase {
  id = 'hjwzw';
  name = 'Huangjinwu';
  icon = 'src/cn/hjwzw/logo.png';
  site = 'https://tw.hjwzw.com';
  version = '1.0.1';

  private parseCards(
    loadedCheerio: ReturnType<typeof loadCheerio>,
  ): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    loadedCheerio('table[width="100%"][height="128px"]').each((_, element) => {
      const card = loadedCheerio(element);
      const anchor = card.find('span.wd10 > a');
      const href = anchor.attr('href');
      const name = anchor.text().trim();
      if (!href || !name) return;
      const cover =
        card.find('img').attr('src') || card.find('img').attr('data-src');
      novels.push({
        name,
        path: href,
        cover: cover ? new URL(cover, this.site).toString() : defaultCover,
      });
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
    // No dedicated latest endpoint; Latest reuses the unfiltered listing.
    // Genre listings share the /List/ shape: /List/<tag> (p1),
    // /List/<tag>__<N> (pN). Tags are Chinese (see /Channel/ nav).
    const tag =
      !showLatestNovels && filters.genre.value !== 'all'
        ? filters.genre.value
        : 'all';
    const base = '/List/' + (tag === 'all' ? 'all' : encodeURIComponent(tag));
    const url = this.site + base + (page > 1 ? '__' + page : '');
    const body = await fetchText(url);
    if (!body || body.includes(NO_RESULT_MARK)) return [];
    return this.parseCards(loadCheerio(body));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await fetchText(this.site + novelPath);
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: novelPath,
      cover: defaultCover,
      status: NovelStatus.Unknown,
      chapters: [],
    };
    if (!body) return novel;
    const $ = loadCheerio(body);

    novel.name = $('h1').first().text().trim() || novelPath;

    const info = $('div[style*="height: 300px"]');
    const scope = info.length ? info : $;
    const authorAnchor = scope.find('a[href^="/List/"]').first();
    if (authorAnchor.length) {
      novel.author = authorAnchor.text().trim() || undefined;
    }
    const genreList: string[] = [];
    scope.find('a[href^="/Channel/"]').each((_, el) => {
      const genre = $(el).text().trim();
      if (genre) genreList.push(genre);
    });
    if (genreList.length) novel.genres = genreList.join(',');

    const infoText = scope.text();
    const summaryIdx = infoText.indexOf('【內容簡介】');
    if (summaryIdx !== -1) {
      novel.summary = infoText.slice(summaryIdx + '【內容簡介】'.length).trim();
    }

    const idMatch = novelPath.match(/\/Book\/(\d+)/);
    const cover =
      scope.find('img[src^="/images/id/"]').attr('src') ||
      (idMatch ? '/images/id/' + idMatch[1] + '.jpg' : undefined);
    if (cover) {
      novel.cover = cover.startsWith('http')
        ? cover
        : new URL(cover, this.site).toString();
    }

    // Full chapter list lives on the dedicated page (single page).
    const id = idMatch ? idMatch[1] : '';
    if (id) {
      const listBody = await fetchText(this.site + '/Book/Chapter/' + id);
      if (listBody) {
        const list = loadCheerio(listBody);
        const chapters: Plugin.ChapterItem[] = [];
        list('#tbchapterlist td > a').each((idx, el) => {
          const href = list(el).attr('href');
          const titleAttr = list(el).attr('title') || '';
          if (!href) return;
          const timeMatch = titleAttr.match(/更新時間:\s*(\d{4}-\d{2}-\d{2})/);
          chapters.push({
            name: list(el).text().trim() || 'Chapter ' + (idx + 1),
            path: href,
            releaseTime: timeMatch ? timeMatch[1] : undefined,
            chapterNumber: idx + 1,
          });
        });
        novel.chapters = chapters;
      }
    }

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const body = await fetchText(this.site + chapterPath);
    if (!body) return '';
    const $ = loadCheerio(body);
    const title = $('h1').first().text().trim();
    // The chapter body is the indented content div (friend-link and nav divs
    // share font-size but not the text indent).
    const content = $('div[style*="text-indent: 2em"]').first();
    if (!content.length) return '';
    // Drop the first two lines (site-domain notice + title repeat).
    const lines = (content.html() || '').split(/<br\s*\/?>/i);
    const kept = lines.length > 2 ? lines.slice(2) : lines;
    const chapterText = kept.join('<br>');
    return (title ? '<h1>' + title + '</h1>' : '') + chapterText;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // Search shares the /List/ endpoint shape; traditional Chinese only.
    // No page parameter observed — page 1 only.
    if (Math.max(1, pageNo || 1) > 1) return [];
    const url = this.site + '/List/' + encodeURIComponent(searchTerm);
    const body = await fetchText(url);
    if (!body || body.includes(NO_RESULT_MARK)) return [];
    return this.parseCards(loadCheerio(body));
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return this.site + path;
  }

  filters = {
    genre: {
      type: FilterTypes.Picker,
      label: 'Genre',
      value: 'all',
      options: [
        { label: '全部', value: 'all' },
        { label: '玄幻', value: '玄幻' },
        { label: '奇幻', value: '奇幻' },
        { label: '武俠', value: '武俠' },
        { label: '仙俠', value: '仙俠' },
        { label: '都市', value: '都市' },
        { label: '言情', value: '言情' },
        { label: '歷史', value: '歷史' },
        { label: '軍事', value: '軍事' },
        { label: '遊戲', value: '遊戲' },
        { label: '競技', value: '競技' },
        { label: '科幻', value: '科幻' },
        { label: '靈異', value: '靈異' },
        { label: '全本', value: '全本' },
      ],
    },
  } satisfies Filters;
}

export default new Hjwzw();
