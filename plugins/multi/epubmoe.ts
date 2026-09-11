import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

type SearchResult = {
  md5?: string;
  title?: string;
  author?: string;
  cover_url?: string;
  download_url?: string;
};

type SearchResponse = {
  success?: boolean;
  total?: number;
  results?: SearchResult[];
};

// Search-only JSON API, hard-capped at 20 results (no pagination).
// popularNovels rotates high-frequency single-character queries so Browse
// still yields content.
const BROWSE_TERMS = ['a', 'e', 'i', 'の', '物', '学', '人', '王', '魔', '剣'];

class Epubmoe implements Plugin.PluginBase {
  id = 'epubmoe';
  name = 'Epub.moe';
  icon = 'src/multi/epubmoe/logo2.png';
  site = 'https://epub.moe';
  version = '1.0.3';

  private encodePath(md5: string, title: string, author: string): string {
    return (
      '/' +
      md5 +
      '/' +
      encodeURIComponent(title) +
      '/' +
      encodeURIComponent(author)
    );
  }

  private decodePath(novelPath: string): {
    md5: string;
    title: string;
    author: string;
  } {
    const parts = novelPath.replace(/^\/|\/$/g, '').split('/');
    return {
      md5: parts[0] || '',
      title: parts[1] ? decodeURIComponent(parts[1]) : '',
      author: parts[2] ? decodeURIComponent(parts[2]) : '',
    };
  }

  private async searchApi(
    term: string,
    language?: string,
  ): Promise<SearchResult[]> {
    let url = this.site + '/api/search?q=' + encodeURIComponent(term);
    if (language && language !== 'all') url += '&language=' + language;
    try {
      const res = await fetchApi(url);
      const json = (await res.json()) as SearchResponse;
      if (!json || json.success === false || !Array.isArray(json.results)) {
        return [];
      }
      return json.results;
    } catch {
      return [];
    }
  }

  private toNovelItem(row: SearchResult): Plugin.NovelItem | null {
    if (!row.md5) return null;
    return {
      name: row.title || row.md5,
      path: this.encodePath(row.md5, row.title || '', row.author || ''),
      cover: row.cover_url || `https://cover.epub.moe/${row.md5}.jpg`,
    };
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    void showLatestNovels;
    const page = Math.max(1, pageNo || 1);
    const term = BROWSE_TERMS[(page - 1) % BROWSE_TERMS.length];
    const rows = await this.searchApi(term, filters.language.value);
    const novels: Plugin.NovelItem[] = [];
    rows.forEach(row => {
      const item = this.toNovelItem(row);
      if (item) novels.push(item);
    });
    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const { md5, title, author } = this.decodePath(novelPath);
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: title || md5,
      author: author || undefined,
      cover: md5 ? `https://cover.epub.moe/${md5}.jpg` : defaultCover,
      status: NovelStatus.Unknown,
    };
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    void chapterPath;
    // File source: no per-chapter HTML exists. Chapters are delivered as a
    // whole-file download via getDownloadUrl.
    return '';
  }

  // Note: searchNovels takes no filters, so search always covers both
  // languages. Use the Browse language filter to narrow by language.
  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (Math.max(1, pageNo || 1) > 1) return [];
    const rows = await this.searchApi(searchTerm);
    const novels: Plugin.NovelItem[] = [];
    rows.forEach(row => {
      const item = this.toNovelItem(row);
      if (item) novels.push(item);
    });
    return novels;
  }

  async getDownloadUrl(novelPath: string): Promise<string> {
    const { md5 } = this.decodePath(novelPath);
    if (!md5) return '';
    return this.site + '/books/' + md5 + '/download';
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return this.site + path;
  }

  filters = {
    language: {
      type: FilterTypes.Picker,
      label: 'Language',
      value: 'all',
      options: [
        { label: '全部', value: 'all' },
        { label: '中文', value: 'zh' },
        { label: '日本語', value: 'jp' },
      ],
    },
  } satisfies Filters;
}

export default new Epubmoe();
