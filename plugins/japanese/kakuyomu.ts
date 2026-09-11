import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

const NEXT_DATA_REGEX =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

type ApolloState = Record<string, ApolloNode>;

type ApolloNode = {
  __typename?: string;
  id?: string;
  title?: string;
  serialStatus?: string;
  tagLabels?: string[];
  introduction?: string;
  adminCoverImageUrl?: string;
  activityName?: string;
  publishedAt?: string;
  author?: { __ref?: string };
  chapter?: { __ref?: string };
  episodeUnions?: { __ref?: string }[];
  tableOfContentsV2?: TableOfContentsChapter[];
  [key: string]: unknown;
};

type RankedWorksEntry = { __ref?: string; nodes?: { __ref?: string }[] };

function extractApolloState(html: string): ApolloState | null {
  if (!html) return null;
  const match = html.match(NEXT_DATA_REGEX);
  if (!match || !match[1]) return null;
  try {
    const json = JSON.parse(match[1]);
    const state = json?.props?.pageProps?.__APOLLO_STATE__;
    if (state && typeof state === 'object') return state as ApolloState;
  } catch {
    return null;
  }
  return null;
}

function findRootFieldKey(
  state: ApolloState,
  prefix: string,
  mustContain?: string,
): string | null {
  const root = state['ROOT_QUERY'];
  if (!root || typeof root !== 'object') return null;
  const keys = Object.keys(root);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (
      key.indexOf(prefix) === 0 &&
      (!mustContain || key.indexOf(mustContain) !== -1)
    ) {
      return key;
    }
  }
  return null;
}

function connectionNodes(state: ApolloState, key: string): string[] {
  const root = state['ROOT_QUERY'] as Record<string, unknown>;
  const entry = root[key] as RankedWorksEntry | undefined;
  const nodes = (entry && entry.nodes) || [];
  const refs: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i] && nodes[i].__ref) refs.push(nodes[i].__ref as string);
  }
  return refs;
}

function workIdFromPath(novelPath: string): string {
  const parts = novelPath.replace(/^\/|\/$/g, '').split('/');
  // /works/<id> or /works/<id>/episodes/<epId>
  if (parts[0] === 'works' && parts[1]) return parts[1];
  return parts[0] || '';
}

class KakuyomuPlugin implements Plugin.PluginBase {
  id = 'kakuyomu';
  name = 'kakuyomu';
  icon = 'src/jp/kakuyomu/icon.png';
  site = 'https://kakuyomu.jp';
  version = '1.2.0';
  filters = {
    genre: {
      type: FilterTypes.Picker,
      label: 'Genre',
      options: [
        { label: '総合', value: 'all' },
        { label: '異世界ファンタジー', value: 'fantasy' },
        { label: '現代ファンタジー', value: 'action' },
        { label: 'SF', value: 'sf' },
        { label: '恋愛', value: 'love_story' },
        { label: 'ラブコメ', value: 'romance' },
        { label: '現代ドラマ', value: 'drama' },
        { label: 'ホラー', value: 'horror' },
        { label: 'ミステリー', value: 'mystery' },
        { label: 'エッセイ・ノンフィクション', value: 'nonfiction' },
        { label: '歴史・時代・伝奇', value: 'history' },
        { label: '創作論・評論', value: 'criticism' },
        { label: '詩・童話・その他', value: 'others' },
        { label: '魔法のiらんど', value: 'maho' },
        { label: '二次創作', value: 'fan_fiction' },
      ],
      value: 'all',
    },
    period: {
      type: FilterTypes.Picker,
      label: 'Period',
      options: [
        { label: '累計', value: 'entire' },
        { label: '日間', value: 'daily' },
        { label: '週間', value: 'weekly' },
        { label: '月間', value: 'monthly' },
        { label: '年間', value: 'yearly' },
      ],
      value: 'entire',
    },
    workVariation: {
      type: FilterTypes.Picker,
      label: 'Length',
      options: [
        { label: '長編', value: 'long' },
        { label: '短編', value: 'short' },
        { label: 'すべて', value: 'all' },
      ],
      value: 'long',
    },
    searchOrder: {
      type: FilterTypes.Picker,
      label: 'Search order',
      options: [
        { label: '週間ランキング', value: 'weekly_ranking' },
        { label: '累計ランキング', value: 'popular' },
        { label: '新作順', value: 'published_at' },
        { label: '更新順', value: 'last_episode_published_at' },
      ],
      value: 'weekly_ranking',
    },
    serialStatus: {
      type: FilterTypes.Picker,
      label: 'Status',
      options: [
        { label: 'すべて', value: '' },
        { label: '連載中', value: 'RUNNING' },
        { label: '完結済', value: 'COMPLETED' },
      ],
      value: '',
    },
    workLength: {
      type: FilterTypes.Picker,
      label: 'Work length',
      options: [
        { label: 'すべて', value: '' },
        { label: '短編（〜2万文字）', value: '-20000' },
        { label: '中編', value: '20000-100000' },
        { label: '長編（10万文字〜）', value: '100000-' },
        { label: '大長編', value: '500000-' },
      ],
      value: '',
    },
  } satisfies Filters;
  imageRequestInit?: Plugin.ImageRequestInit | undefined = undefined;

  //flag indicates whether access to LocalStorage, SesesionStorage is required.
  webStorageUtilized?: boolean;

  private async latestNovels(
    pageNo: number,
    genre?: string,
  ): Promise<Plugin.NovelItem[]> {
    const base =
      genre && genre !== 'all'
        ? '/genres/' + genre + '/recent_works'
        : '/recent_works';
    const url = this.site + base + (pageNo > 1 ? '?page=' + pageNo : '');
    const html = await fetchText(url);
    if (!html) return [];
    const $ = loadCheerio(html);
    const novels: Plugin.NovelItem[] = [];

    $('.widget-media-genresWorkList-right > .widget-work').each((_, elem) => {
      const anchor = $(elem).find('a.widget-workCard-titleLabel');
      const path = anchor.attr('href');
      if (!path) return;
      const name = anchor.text().trim();
      if (!name) return;
      novels.push({
        name,
        path,
        cover: defaultCover,
      });
    });

    return novels;
  }

  private async rankedNovels(
    pageNo: number,
    genre: string,
    period: string,
    workVariation: string,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      this.site +
      '/rankings/' +
      (genre || 'all') +
      '/' +
      (period || 'weekly') +
      '?work_variation=' +
      (workVariation || 'long') +
      (pageNo > 1 ? '&page=' + pageNo : '');
    const html = await fetchText(url);
    const state = extractApolloState(html);
    if (!state) return [];
    const key = findRootFieldKey(state, 'rankedWorks(');
    if (!key) return [];
    const novels: Plugin.NovelItem[] = [];
    const refs = connectionNodes(state, key);
    for (let i = 0; i < refs.length; i++) {
      const work = state[refs[i]];
      if (!work || work.__typename !== 'Work' || !work.id) continue;
      novels.push({
        name: work.title || work.id,
        path: '/works/' + work.id,
        cover: defaultCover,
      });
    }
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
    if (showLatestNovels) return this.latestNovels(page, filters.genre.value);
    if (
      filters.searchOrder.value !== 'weekly_ranking' ||
      filters.serialStatus.value !== '' ||
      filters.workLength.value !== ''
    ) {
      return this.browseSearch(
        '',
        page,
        filters.searchOrder.value,
        filters.genre.value,
        filters.serialStatus.value,
        filters.workLength.value,
      );
    }
    return this.rankedNovels(
      page,
      filters.genre.value,
      filters.period.value,
      filters.workVariation.value,
    );
  }

  private async browseSearch(
    query: string,
    pageNo: number,
    order: string,
    genre: string,
    serialStatus: string,
    workLength: string,
  ): Promise<Plugin.NovelItem[]> {
    let url =
      this.site +
      '/search?q=' +
      encodeURIComponent(query) +
      '&order=' +
      (order || 'weekly_ranking');
    if (genre && genre !== 'all') url += '&genre_name=' + genre;
    if (serialStatus) url += '&serial_status=' + serialStatus;
    if (workLength) {
      const [min, max] = workLength.split('-');
      if (min) url += '&total_character_count_min=' + min;
      if (max) url += '&total_character_count_max=' + max;
    }
    if (pageNo > 1) url += '&page=' + pageNo;
    const html = await fetchText(url);
    const state = extractApolloState(html);
    if (!state) return [];
    const key = findRootFieldKey(state, 'searchWorks(');
    if (!key) return [];
    return this.novelsFromSearchKey(state, key);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const workId = workIdFromPath(novelPath);
    const path = '/works/' + workId;
    const html = await fetchText(this.site + path);
    const state = extractApolloState(html || '');

    if (state) {
      const root = state['ROOT_QUERY'] as Record<string, unknown>;
      const rootRef = root['work({"id":"' + workId + '"})'] as
        { __ref?: string } | undefined;
      const mainRef = rootRef && rootRef.__ref;
      const work = (mainRef && state[mainRef]) || undefined;

      if (work && work.__typename !== 'Work') {
        // fall through to empty novel below if pointer is stale
      }

      if (work && (!work.__typename || work.__typename === 'Work')) {
        const authorRef = work.author && work.author.__ref;
        const author =
          (authorRef && state[authorRef] && state[authorRef].activityName) ||
          '';
        const tocRefs =
          (work.tableOfContentsV2 as unknown as { __ref?: string }[]) || [];
        const chapters = [];
        for (let i = 0; i < tocRefs.length; i++) {
          const tocRef = tocRefs[i] && tocRefs[i].__ref;
          const toc = (tocRef && state[tocRef]) || undefined;
          if (!toc) continue;
          const unions = (toc.episodeUnions as { __ref?: string }[]) || [];
          const chapterRef =
            (toc.chapter as { __ref?: string } | undefined) &&
            (toc.chapter as { __ref?: string }).__ref;
          const chapterTitle =
            (chapterRef &&
              state[chapterRef] &&
              (state[chapterRef].title as string)) ||
            '';
          for (let j = 0; j < unions.length; j++) {
            const epRef = unions[j] && unions[j].__ref;
            const episode = (epRef && state[epRef]) || undefined;
            if (!episode || !episode.id) continue;
            const epTitle = (episode.title as string) || '';
            chapters.push({
              name: chapterTitle ? chapterTitle + ' - ' + epTitle : epTitle,
              path: path + '/episodes/' + episode.id,
              releaseTime: episode.publishedAt
                ? new Date(episode.publishedAt as string).toISOString()
                : '',
            });
          }
        }

        return {
          path,
          name: (work.title as string) || workId,
          cover: (work.adminCoverImageUrl as string) || defaultCover,
          genres: ((work.tagLabels as string[]) || []).join(','),
          author: (author as string) || '',
          status:
            work.serialStatus === 'COMPLETED'
              ? NovelStatus.Completed
              : NovelStatus.Ongoing,
          summary: (work.introduction as string) || '',
          chapters,
        };
      }
    }

    return {
      path,
      name: workId,
      cover: defaultCover,
      chapters: [],
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const html = await fetchText(this.site + chapterPath);
    if (!html) return '';
    const $ = loadCheerio(html);
    const episodeTitle = $('.widget-episodeTitle').html() || '';
    const episodeBody = $('.widget-episodeBody').html() || '';
    if (!episodeBody) return '';
    const chapterText =
      '<div>' +
      (episodeTitle ? '<h2>' + episodeTitle + '</h2>' : '') +
      '</div><p><br><br></p>' +
      episodeBody;
    return chapterText;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo || 1);
    const url =
      this.site +
      '/search?q=' +
      encodeURIComponent(searchTerm) +
      '&order=weekly_ranking' +
      (page > 1 ? '&page=' + page : '');
    const html = await fetchText(url);
    const state = extractApolloState(html);
    if (!state) return [];
    // The server normalizes the query/offset into the key; the page carries
    // a single searchWorks entry, so take the first match.
    const key = findRootFieldKey(state, 'searchWorks(');
    if (!key) return [];
    return this.novelsFromSearchKey(state, key);
  }

  private novelsFromSearchKey(
    state: ApolloState,
    key: string,
  ): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    const refs = connectionNodes(state, key);
    for (let i = 0; i < refs.length; i++) {
      const work = state[refs[i]];
      if (!work || !work.id) continue;
      novels.push({
        name: (work.title as string) || work.id,
        path: '/works/' + work.id,
        cover: defaultCover,
      });
    }
    return novels;
  }
}

export default new KakuyomuPlugin();

type TableOfContentsChapter = {
  chapter?: {
    __ref?: string;
  };
  episodeUnions?: {
    __ref?: string;
  }[];
};
