import { load as loadCheerio } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

const SORTS: Record<string, string> = {
  books: '/',
  hot: '/hot/stored',
  rated: '/rated/stored',
  discover: '/discover/stored',
  // No trailing slashes: the site 308-redirects them to http, which OkHttp
  // will not follow back up to https (Latest came back empty on-device).
  // 'new' tracks publication date (/newest/pubnew), not library-add date:
  // recently-added is already covered by Books (/), and users expect
  // Newest/Latest to mean new releases (this also feeds showLatestNovels).
  new: '/newest/pubnew',
  old: '/newest/old',
  abc: '/newest/abc',
  zyx: '/newest/zyx',
  authaz: '/newest/authaz',
  authza: '/newest/authza',
  pubnew: '/newest/pubnew',
  pubold: '/newest/pubold',
};

class Moelibrary implements Plugin.PluginBase {
  id = 'moelibrary';
  name = 'Moelibrary';
  icon = 'src/jp/moelibrary/logo.png';
  site = 'https://books.moelibrary.cc';
  version = '1.0.4';

  private absolutize(url: string | undefined): string | undefined {
    if (!url) return undefined;
    if (/^https?:\/\//i.test(url)) return url;
    return this.site + (url.startsWith('/') ? url : '/' + url);
  }

  private parseCards(
    loadedCheerio: ReturnType<typeof loadCheerio>,
  ): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();
    loadedCheerio('div.book').each((_, element) => {
      const card = loadedCheerio(element);
      // Skip the "Discover (Random Books)" block: it renders 4 random books
      // at the top of every listing page, so including it made every browse
      // refresh look like only the first 4 entries ever update.
      if (card.closest('.random-books').length) return;
      const anchor = card.find('a[href^="/book/"]').first();
      const href = anchor.attr('href');
      if (!href || seen.has(href)) return;
      const name = card.find('p.title').text().trim() || anchor.text().trim();
      if (!name) return;
      seen.add(href);
      const cover = card.find('img').attr('src');
      novels.push({
        name,
        path: href,
        cover: this.absolutize(cover) || defaultCover,
      });
    });
    return novels;
  }

  private listingUrl(source: string, page: number): string {
    const base = SORTS[source] || SORTS.books;
    if (base === '/') return this.site + (page > 1 ? '/page/' + page : '/');
    if (base.startsWith('/newest/')) {
      return this.site + base + (page > 1 ? '/1/' + page : '');
    }
    // The /view/sort family (hot/rated/discover) paginates as base/1/page —
    // the same pattern the site's own Next links use (/newest/new/1/2).
    // base/page (e.g. /rated/stored/2) silently repeats page 1 forever.
    return this.site + base + (page > 1 ? '/1/' + page : '');
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const source = showLatestNovels ? 'new' : filters.source.value;
    const body = await fetchText(this.listingUrl(source, page));
    if (!body) return [];
    return this.parseCards(loadCheerio(body));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await fetchText(this.site + novelPath);
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: novelPath,
      cover: defaultCover,
      status: NovelStatus.Unknown,
    };
    if (!body) return novel;
    const $ = loadCheerio(body);

    const titleTag = $('title').text().trim();
    novel.name =
      titleTag.replace(/^Moe Library\s*\|\s*/, '').trim() || novelPath;

    const author = $('p.author a')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(a => a)
      .join(', ');
    if (author) novel.author = author;

    const summary = $('.comments p').first().html();
    if (summary && summary.trim()) novel.summary = summary.trim();

    const stars = $('.rating span.glyphicon-star.good').length;
    if (stars > 0) novel.rating = Math.min(5, stars);

    const tags = $('.tags a')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(t => t)
      .join(',');
    if (tags) novel.genres = tags;

    // No dedicated publisher/language fields: surface them in the summary.
    const publisher = $('.publishers a').first().text().trim();
    const pubDate = $('.publishing-date p')
      .text()
      .trim()
      .replace(/^Published:\s*/i, '');
    const language = $('.languages .label')
      .text()
      .trim()
      .replace(/^Language:\s*/i, '');
    const extra = [
      publisher ? 'Publisher: ' + publisher : '',
      pubDate ? 'Published: ' + pubDate : '',
      language ? 'Language: ' + language : '',
    ].filter(s => s);
    if (extra.length) {
      const line = extra.join(' · ');
      novel.summary = novel.summary ? novel.summary + '<br><br>' + line : line;
    }

    const cover = $('img#detailcover').attr('src');
    const abs = this.absolutize(cover);
    if (abs) novel.cover = abs;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    void chapterPath;
    // File source: books are whole-file downloads via getDownloadUrl.
    return '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (Math.max(1, pageNo || 1) > 1) return [];
    const body = await fetchText(
      this.site + '/search?query=' + encodeURIComponent(searchTerm),
    );
    if (!body) return [];
    return this.parseCards(loadCheerio(body));
  }

  async getDownloadUrl(novelPath: string, format?: string): Promise<string> {
    const want = (format || 'epub').toLowerCase();
    const body = await fetchText(this.site + novelPath);
    if (!body) return '';
    const $ = loadCheerio(body);
    const links: string[] = [];
    $('a[href^="/download/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) links.push(href);
    });
    if (!links.length) return '';
    const match =
      links.find(l => l.toLowerCase().includes('/' + want + '/')) || links[0];
    return this.absolutize(match) || '';
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return this.site + path;
  }

  filters = {
    source: {
      type: FilterTypes.Picker,
      label: 'Browse',
      value: 'books',
      options: [
        { label: 'Books', value: 'books' },
        { label: 'Hot Books', value: 'hot' },
        { label: 'Top Rated', value: 'rated' },
        { label: 'Discover', value: 'discover' },
        { label: 'Newest', value: 'new' },
        { label: 'Oldest', value: 'old' },
        { label: 'Title A-Z', value: 'abc' },
        { label: 'Title Z-A', value: 'zyx' },
        { label: 'Author A-Z', value: 'authaz' },
        { label: 'Author Z-A', value: 'authza' },
        { label: 'Oldest Published', value: 'pubold' },
      ],
    },
  } satisfies Filters;
}

export default new Moelibrary();
