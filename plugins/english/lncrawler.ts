import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

const API = 'https://api.lncrawler.monster';

type LncrawlerSourceInfo = {
  id?: string;
  title?: string;
  source_name?: string;
  source_slug?: string;
  authors?: string[];
  tags?: string[];
  language?: string;
  synopsis?: string;
  cover_min_url?: string;
  cover_url?: string;
  chapters_count?: number;
  volumes_count?: number;
  novel_slug?: string;
  novel_title?: string;
};

type LncrawlerSearchResult = {
  id?: string;
  title?: string;
  slug?: string;
  prefered_source?: LncrawlerSourceInfo | null;
};

type LncrawlerSearchResponse = {
  count?: number;
  total_pages?: number;
  current_page?: number;
  results?: LncrawlerSearchResult[];
};

type LncrawlerNovelDetail = {
  id?: string;
  title?: string;
  slug?: string;
  sources?: LncrawlerSourceInfo[];
  avg_rating?: number | null;
  rating_count?: number;
  total_views?: number;
  weekly_views?: number;
  prefered_source?: LncrawlerSourceInfo | null;
};

type LncrawlerChapterInfo = {
  id?: number;
  chapter_id?: number;
  title?: string;
  volume?: number | null;
  volume_title?: string | null;
};

type LncrawlerChapterListResponse = {
  novel_slug?: string;
  source_slug?: string;
  total_pages?: number;
  current_page?: number;
  chapters?: LncrawlerChapterInfo[];
};

type LncrawlerChapterContent = {
  body?: string;
  images_path?: string | null;
};

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function toWebPath(input: string | undefined | null): string {
  if (!input) return '';
  const s = String(input).trim();
  if (!s) return '';
  if (s.charAt(0) === '/') return s;
  if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) {
    const idx = s.indexOf('/novels/');
    if (idx >= 0) return s.substring(idx);
    return '/' + s.replace(/^\/+/, '');
  }
  const idx = s.indexOf('/novels/');
  if (idx >= 0) return s.substring(idx);
  if (s.indexOf('api.lncrawler.monster') >= 0) {
    const idx2 = s.indexOf('/novels/');
    if (idx2 >= 0) return s.substring(idx2);
  }
  return '/' + s.replace(/^\/+/, '');
}

function stripHtml(html: string | undefined | null): string {
  if (!html) return '';
  try {
    return loadCheerio(html).text().trim();
  } catch {
    return String(html)
      .replace(/<[^>]*>/g, ' ')
      .trim();
  }
}

function parseNovelSlug(path: string): string {
  const clean = toWebPath(path).replace(/^\/|\/$/g, '');
  const parts = clean.split('/');
  // /novels/{novelSlug}/{sourceSlug}[/chapter/{id}]
  if (parts[0] === 'novels' && parts[1]) return parts[1];
  return parts[0] || '';
}

function parseSourceSlug(path: string): string {
  const clean = toWebPath(path).replace(/^\/|\/$/g, '');
  const parts = clean.split('/');
  if (parts[0] === 'novels' && parts[2] && parts[2] !== 'chapter') {
    return parts[2];
  }
  return '';
}

class LnCrawlerPlugin implements Plugin.PluginBase {
  id = 'lncrawler';
  name = 'LnCrawler';
  icon = 'src/en/lncrawler/icon.png';
  site = 'https://lncrawler.monster';
  version = '1.0.0';

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: 'https://lncrawler.monster/',
    },
  };

  private resolveCover(raw: string | undefined | null): string {
    if (!raw) return this.site + '/assets/default-cover-Dooaozbf.jpg';
    const s = String(raw).trim();
    if (!s) return this.site + '/assets/default-cover-Dooaozbf.jpg';
    if (s.indexOf('<img') >= 0) {
      try {
        const $ = loadCheerio(s);
        const src = $('img').first().attr('src');
        if (!src) return this.site + '/assets/default-cover-Dooaozbf.jpg';
        return this.absolutizeCover(src);
      } catch {
        return this.site + '/assets/default-cover-Dooaozbf.jpg';
      }
    }
    return this.absolutizeCover(s);
  }

  private absolutizeCover(src: string): string {
    const s = src.trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (s.charAt(0) === '/') return this.site + s;
    return this.site + '/' + s;
  }

  private resolveImageUrl(
    src: string,
    imagesPath: string | null | undefined,
  ): string {
    const s = src.trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.indexOf('images/') === 0 && imagesPath) {
      return imagesPath + '/' + s.replace(/^images\//, '');
    }
    if (s.charAt(0) === '/') return API + s;
    return API + '/' + s;
  }

  private toNovelItem(result: LncrawlerSearchResult): Plugin.NovelItem | null {
    const title = (result.title || '').trim();
    if (!title) return null;
    const src = result.prefered_source || undefined;
    const novelSlug = (src && src.novel_slug) || result.slug || '';
    if (!novelSlug) return null;
    const sourceSlug = (src && src.source_slug) || '';
    const path = sourceSlug
      ? '/novels/' + novelSlug + '/' + sourceSlug
      : '/novels/' + novelSlug;
    const cover = this.resolveCover(
      (src && (src.cover_min_url || src.cover_url)) || undefined,
    );
    return {
      name: title,
      path,
      cover,
    };
  }

  private buildSearchUrl(
    page: number,
    query: string,
    sortBy: string,
    sortOrder: string,
    language: string,
    minRating: string,
    includeTags: string[],
    excludeTags: string[],
    authors: string[],
  ): string {
    let url =
      API +
      '/novels/search/?page=' +
      page +
      '&page_size=24&sort_by=' +
      encodeURIComponent(sortBy || 'popularity') +
      '&sort_order=' +
      encodeURIComponent(sortOrder || 'desc');
    if (query) url += '&query=' + encodeURIComponent(query);
    if (language) url += '&language=' + encodeURIComponent(language);
    if (minRating) url += '&min_rating=' + encodeURIComponent(minRating);
    includeTags.forEach(tag => {
      url += '&tag=' + encodeURIComponent(tag);
    });
    excludeTags.forEach(tag => {
      url += '&exclude_tag=' + encodeURIComponent(tag);
    });
    authors.forEach(author => {
      url += '&author=' + encodeURIComponent(author);
    });
    return url;
  }

  private pickSource(
    detail: LncrawlerNovelDetail,
  ): LncrawlerSourceInfo | undefined {
    if (detail.prefered_source) return detail.prefered_source;
    const sources = detail.sources || [];
    if (!sources.length) return undefined;
    let best = sources[0];
    let bestCount = best.chapters_count || 0;
    for (let i = 1; i < sources.length; i++) {
      const c = sources[i].chapters_count || 0;
      if (c > bestCount) {
        best = sources[i];
        bestCount = c;
      }
    }
    return best;
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const sortBy = showLatestNovels
      ? 'last_updated'
      : filters.sortBy.value || 'popularity';
    const sortOrder = showLatestNovels
      ? 'desc'
      : filters.sortOrder.value || 'desc';
    const url = this.buildSearchUrl(
      page,
      '',
      sortBy,
      sortOrder,
      (filters.language.value || '').trim(),
      (filters.minRating.value || '').trim(),
      splitCsv(filters.includeTags.value || ''),
      splitCsv(filters.excludeTags.value || ''),
      splitCsv(filters.authors.value || ''),
    );
    try {
      const res = await fetchApi(url);
      if (!res.ok) return [];
      const json = (await res.json()) as LncrawlerSearchResponse;
      const results = (json && json.results) || [];
      const novels: Plugin.NovelItem[] = [];
      results.forEach(result => {
        const item = this.toNovelItem(result);
        if (item) novels.push(item);
      });
      return novels;
    } catch {
      return [];
    }
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const cleanPath = toWebPath(novelPath) || novelPath;
    let novelSlug = parseNovelSlug(cleanPath);
    let sourceSlug = parseSourceSlug(cleanPath);
    const novel: Plugin.SourceNovel = {
      path: cleanPath,
      name: novelSlug || cleanPath,
      cover: defaultCover,
      status: NovelStatus.Unknown,
      chapters: [],
    };
    if (!novelSlug) return novel;
    try {
      const detailRes = await fetchApi(
        API + '/novels/' + encodeURIComponent(novelSlug) + '/',
      );
      if (!detailRes.ok) return novel;
      const detail = (await detailRes.json()) as LncrawlerNovelDetail;
      if (!detail || !detail.title) return novel;
      novelSlug = detail.slug || novelSlug;
      const source = this.pickSource(detail);
      if (source && source.source_slug) sourceSlug = source.source_slug;
      // Keep the stored path stable when the caller already had a source.
      if (sourceSlug) {
        novel.path = '/novels/' + novelSlug + '/' + sourceSlug;
      } else {
        novel.path = '/novels/' + novelSlug;
      }
      novel.name = detail.title;
      novel.cover =
        this.resolveCover(
          source && (source.cover_min_url || source.cover_url),
        ) || defaultCover;
      if (source && source.authors && source.authors.length) {
        novel.author = source.authors.join(', ');
      }
      if (source && source.tags && source.tags.length) {
        novel.genres = source.tags.join(',');
      }
      const synopsis = stripHtml(source && source.synopsis);
      const meta: string[] = [];
      if (typeof detail.total_views === 'number') {
        meta.push(
          'Views: ' +
            detail.total_views +
            ' (Weekly: ' +
            (detail.weekly_views || 0) +
            ')',
        );
      }
      if (typeof detail.avg_rating === 'number') {
        meta.push(
          'Rating: ' +
            detail.avg_rating +
            ' (' +
            (detail.rating_count || 0) +
            ' votes)',
        );
      }
      const sourceCount = (detail.sources && detail.sources.length) || 1;
      meta.push('Sources: ' + sourceCount);
      if (source) {
        meta.push(
          'Current Source: ' + (source.source_name || source.source_slug || ''),
        );
        meta.push('Chapters: ' + (source.chapters_count || 0));
        meta.push('Volumes: ' + (source.volumes_count || 0));
      }
      novel.summary =
        synopsis + (synopsis && meta.length ? '\n\n' : '') + meta.join('\n');

      if (!sourceSlug) {
        novel.chapters = [];
        return novel;
      }
      const chapters = await this.fetchAllChapters(novelSlug, sourceSlug);
      novel.chapters = chapters;
      return novel;
    } catch {
      if (!novel.chapters) novel.chapters = [];
      return novel;
    }
  }

  private async fetchAllChapters(
    novelSlug: string,
    sourceSlug: string,
  ): Promise<Plugin.ChapterItem[]> {
    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<number>();
    let page = 1;
    let totalPages = 1;
    // Safety cap: 1000/page means even 50k chapters finish in ~50 calls;
    // cap at 60 pages to avoid runaway loops on bad API data.
    while (page <= totalPages && page <= 60) {
      let url = '';
      try {
        url =
          API +
          '/novels/' +
          encodeURIComponent(novelSlug) +
          '/' +
          encodeURIComponent(sourceSlug) +
          '/chapters/?page=' +
          page +
          '&page_size=1000';
        const res = await fetchApi(url);
        if (!res.ok) break;
        const json = (await res.json()) as LncrawlerChapterListResponse;
        const list = (json && json.chapters) || [];
        totalPages = (json && json.total_pages) || 1;
        const respNovel = (json && json.novel_slug) || novelSlug;
        const respSource = (json && json.source_slug) || sourceSlug;
        list.forEach(ch => {
          if (typeof ch.chapter_id !== 'number') return;
          if (seen.has(ch.chapter_id)) return;
          seen.add(ch.chapter_id);
          const title = (ch.title || 'Chapter ' + ch.chapter_id).trim();
          const name = ch.volume_title
            ? '[' + ch.volume_title + '] ' + title
            : title;
          chapters.push({
            name,
            path:
              '/novels/' +
              respNovel +
              '/' +
              respSource +
              '/chapter/' +
              ch.chapter_id,
            chapterNumber: ch.chapter_id,
          });
        });
      } catch {
        break;
      }
      page += 1;
    }
    chapters.sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));
    return chapters;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const clean = toWebPath(chapterPath) || chapterPath;
    const url = /^https?:\/\//i.test(clean) ? clean : API + clean;
    try {
      const res = await fetchApi(url);
      if (!res.ok) return '';
      const json = (await res.json()) as LncrawlerChapterContent;
      const body = (json && json.body) || '';
      if (!body) return '';
      const imagesPath = json.images_path || null;
      const $ = loadCheerio(body);
      let html = '';
      const root = $('body');
      const nodes = root.length
        ? root.children().toArray()
        : $.root().children().toArray();
      nodes.forEach(el => {
        const tag = (
          (el as unknown as { tagName?: string }).tagName || ''
        ).toLowerCase();
        const sel = $(el);
        if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
          const text = sel.text().trim();
          if (text) html += '<h2>' + text + '</h2>\n';
          return;
        }
        if (tag === 'p') {
          const img = sel.find('img').first();
          const src = img.length ? img.attr('src') : undefined;
          if (src) {
            const full = this.resolveImageUrl(src, imagesPath);
            if (full) html += '<img src="' + full + '">\n';
          } else {
            const text = sel.text().trim();
            if (text) html += '<p>' + text + '</p>\n';
          }
          return;
        }
        if (tag === 'img') {
          const src = sel.attr('src');
          if (src) {
            const full = this.resolveImageUrl(src, imagesPath);
            if (full) html += '<img src="' + full + '">\n';
          }
          return;
        }
        const img = sel.find('img').first();
        const src = img.length ? img.attr('src') : sel.attr('src');
        if ((tag === 'div' || tag === 'figure') && src) {
          const full = this.resolveImageUrl(src, imagesPath);
          if (full) {
            html += '<img src="' + full + '">\n';
            return;
          }
        }
        const text = sel.text().trim();
        if (text) html += '<p>' + text + '</p>\n';
      });
      if (!html) {
        const text = $.root().text().trim();
        if (text.length > 50) html = '<p>' + text + '</p>\n';
      }
      return html;
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
    const url = this.buildSearchUrl(
      page,
      term,
      'popularity',
      'desc',
      '',
      '',
      [],
      [],
      [],
    );
    try {
      const res = await fetchApi(url);
      if (!res.ok) return [];
      const json = (await res.json()) as LncrawlerSearchResponse;
      const results = (json && json.results) || [];
      const novels: Plugin.NovelItem[] = [];
      results.forEach(result => {
        const item = this.toNovelItem(result);
        if (item) novels.push(item);
      });
      return novels;
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
    language: {
      type: FilterTypes.Picker,
      label: 'Language',
      value: '',
      options: [
        { label: 'Any', value: '' },
        { label: 'English', value: 'en' },
        { label: 'French', value: 'fr' },
        { label: 'Spanish', value: 'es' },
        { label: 'German', value: 'de' },
        { label: 'Italian', value: 'it' },
        { label: 'Japanese', value: 'ja' },
        { label: 'Korean', value: 'ko' },
        { label: 'Chinese', value: 'zh' },
        { label: 'Portuguese', value: 'pt' },
        { label: 'Russian', value: 'ru' },
        { label: 'Arabic', value: 'ar' },
        { label: 'Hindi', value: 'hi' },
        { label: 'Thai', value: 'th' },
        { label: 'Vietnamese', value: 'vi' },
        { label: 'Indonesian', value: 'id' },
        { label: 'Turkish', value: 'tr' },
        { label: 'Polish', value: 'pl' },
        { label: 'Dutch', value: 'nl' },
        { label: 'Swedish', value: 'sv' },
      ],
    },
    sortBy: {
      type: FilterTypes.Picker,
      label: 'Sort By',
      value: 'popularity',
      options: [
        { label: 'Popularity (All-time)', value: 'popularity' },
        { label: 'Trending (Weekly)', value: 'trending' },
        { label: 'Rating', value: 'rating' },
        { label: 'Last Updated', value: 'last_updated' },
        { label: 'Date Added', value: 'date_added' },
        { label: 'Title', value: 'title' },
      ],
    },
    sortOrder: {
      type: FilterTypes.Picker,
      label: 'Order',
      value: 'desc',
      options: [
        { label: 'Descending', value: 'desc' },
        { label: 'Ascending', value: 'asc' },
      ],
    },
    includeTags: {
      type: FilterTypes.TextInput,
      label: 'Include Tags (comma-separated)',
      value: '',
    },
    excludeTags: {
      type: FilterTypes.TextInput,
      label: 'Exclude Tags (comma-separated)',
      value: '',
    },
    minRating: {
      type: FilterTypes.TextInput,
      label: 'Minimum Rating (0-5)',
      value: '',
    },
    authors: {
      type: FilterTypes.TextInput,
      label: 'Authors (comma-separated)',
      value: '',
    },
  } satisfies Filters;
}

export default new LnCrawlerPlugin();
