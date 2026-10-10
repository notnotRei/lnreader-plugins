import { load as loadCheerio } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import { Plugin } from '@/types/plugin';

type Book = {
  bookId: string;
  title: string;
  author?: string;
  cover?: string;
  intro?: string;
  category?: string;
  categories?: { title: string }[];
  finished?: number;
  format?: string;
  type?: number;
};
type Entry = { bookInfo: Book; searchIdx: number };
type Chapter = {
  chapterUid: number;
  chapterIdx: number;
  title: string;
  updateTime?: number;
};
type Reader = {
  bookId: string;
  bookInfo: Book;
  chapterInfos: Chapter[];
  isBookInfoError?: boolean;
  psvts: string;
};
type State = { reader?: Reader };

// WeRead uses MD5 for numeric reader IDs and ASCII response checksums.
// Keep this local: the app runtime has no Node crypto module.
function md5(text: string): string {
  const words: number[] = [];
  for (let i = 0; i < text.length; i++) {
    words[i >> 2] =
      (words[i >> 2] || 0) | (text.charCodeAt(i) << ((i % 4) * 8));
  }
  words[text.length >> 2] =
    (words[text.length >> 2] || 0) | (0x80 << ((text.length % 4) * 8));
  const size = (((text.length + 8) >> 6) + 1) * 16;
  words[size - 2] = text.length * 8;
  const state = [0x67452301, -0x10325477, -0x67452302, 0x10325476];
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let offset = 0; offset < size; offset += 16) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      const round = Math.floor(i / 16);
      const f =
        round === 0
          ? (b & c) | (~b & d)
          : round === 1
            ? (d & b) | (~d & c)
            : round === 2
              ? b ^ c ^ d
              : c ^ (b | ~d);
      const index =
        round === 0
          ? i
          : round === 1
            ? (5 * i + 1) % 16
            : round === 2
              ? (3 * i + 5) % 16
              : (7 * i) % 16;
      const sum =
        (a +
          f +
          (words[offset + index] || 0) +
          Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000)) |
        0;
      const shift = shifts[round * 4 + (i % 4)];
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
  }
  return state
    .map(word =>
      [0, 8, 16, 24]
        .map(shift => ('0' + ((word >>> shift) & 255).toString(16)).slice(-2))
        .join(''),
    )
    .join('');
}

function readerId(value: string | number): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('Invalid WeRead book/chapter ID.');
  const hash = md5(text);
  let result = hash.slice(0, 3) + '32' + hash.slice(-2);
  const parts = text.match(/.{1,9}/g) || [];
  result += parts
    .map(part => {
      const hex = parseInt(part, 10).toString(16);
      return ('0' + hex.length.toString(16)).slice(-2) + hex;
    })
    .join('g');
  if (result.length < 20) result += hash.slice(0, 20 - result.length);
  return result + md5(result).slice(0, 3);
}

function sign(params: Record<string, string | number>): string {
  const text = Object.keys(params)
    .sort()
    .map(key => key + '=' + encodeURIComponent(params[key]))
    .join('&');
  let a = 0x15051505;
  let b = a;
  for (let i = text.length - 1; i > 0; i -= 2) {
    a = (a ^ (text.charCodeAt(i) << ((text.length - i) % 30))) & 0x7fffffff;
    b = (b ^ (text.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
  }
  return (a + b).toString(16);
}

// The response is a marker followed by base64 with pairs of characters swapped.
// Undo those swaps only after assembling all the chapter's response fragments.
function decodeContent(encoded: string): string {
  const text = encoded.slice(1);
  const length = text.length;
  const indexes: number[] = [];
  if (length >= 4 && length < 11) indexes.push(0, 2);
  else if (length >= 11) {
    const tail = Math.min(4, Math.ceil(length / 10));
    let digits = '';
    for (let i = length - 1; i > length - 1 - tail; i--) {
      digits += parseInt(text.charCodeAt(i).toString(2), 4);
    }
    const limit = length - tail - 2;
    const width = String(limit).length;
    for (
      let i = 0;
      indexes.length < 10 && i + width < digits.length;
      i += width
    ) {
      indexes.push(parseInt(digits.slice(i, i + width), 10) % limit);
      indexes.push(parseInt(digits.slice(i + 1, i + 1 + width), 10) % limit);
    }
  }
  const chars = text.split('');
  for (let i = indexes.length - 1; i >= 0; i -= 2) {
    for (let j = 1; j >= 0; j--) {
      const a = indexes[i] + j;
      const b = indexes[i - 1] + j;
      const saved = chars[a];
      chars[a] = chars[b];
      chars[b] = saved;
    }
  }
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bits = 0;
  let buffer = 0;
  let escaped = '';
  for (const char of chars.join('')) {
    if (char === '=') break;
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Invalid WeRead chapter encoding.');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      escaped += '%' + ('0' + ((buffer >>> bits) & 255).toString(16)).slice(-2);
    }
  }
  return decodeURIComponent(escaped);
}

class WeRead implements Plugin.PluginBase {
  id = 'weread';
  name = 'WeRead (微信读书)';
  icon = 'src/cn/weread/icon.png';
  site = 'https://weread.qq.com';
  version = '1.0.1';
  imageRequestInit = { headers: { Referer: this.site + '/' } };

  private async request(path: string, body?: Record<string, string | number>) {
    const response = await fetchApi(this.resolveUrl(path), {
      headers: {
        Referer: this.site + '/',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw Object.assign(
        new Error('WeRead returned HTTP ' + response.status),
        {
          status: response.status,
          response,
        },
      );
    }
    return response;
  }

  private async reader(path: string): Promise<Reader> {
    const html = await (await this.request(path)).text();
    const $ = loadCheerio(html);
    const script = $('script')
      .toArray()
      .map(element => $(element).text())
      .find(text => text.includes('window.__INITIAL_STATE__='));
    const match = script?.match(
      /window\.__INITIAL_STATE__=(\{[\s\S]*?\});\s*\(function/,
    );
    if (!match)
      throw new Error(
        'WeRead reader data is unavailable. Open the site in WebView and sign in.',
      );
    const state = JSON.parse(match[1]) as State;
    if (!state.reader?.bookInfo?.title || state.reader.isBookInfoError) {
      throw new Error('This book is unavailable in the WeRead web reader.');
    }
    return state.reader;
  }

  private items(entries: Entry[]): Plugin.NovelItem[] {
    const seen = new Set<string>();
    return entries
      .filter(entry => {
        const book = entry.bookInfo;
        if (
          !book?.bookId ||
          !book.title ||
          book.type !== 0 ||
          seen.has(book.bookId)
        )
          return false;
        seen.add(book.bookId);
        return true;
      })
      .map(({ bookInfo }) => ({
        name: bookInfo.title,
        path: '/web/reader/' + readerId(bookInfo.bookId),
        cover: bookInfo.cover || defaultCover,
      }));
  }

  async popularNovels(
    pageNo: number,
    {
      filters,
      showLatestNovels,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const category = showLatestNovels ? 'newbook' : filters.ranking.value;
    const page = Math.max(1, pageNo || 1);
    const result = (await (
      await this.request(
        '/web/bookListInCategory/' +
          category +
          '?rank=1&maxIndex=' +
          (page - 1) * 20,
      )
    ).json()) as { books?: Entry[] };
    return this.items(result.books || []);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (!searchTerm.trim()) return [];
    const page = Math.max(1, pageNo || 1);
    const result = (await (
      await this.request(
        '/web/search/global?keyword=' +
          encodeURIComponent(searchTerm.trim()) +
          '&count=20&maxIdx=' +
          (page - 1) * 20 +
          '&fragmentSize=120',
      )
    ).json()) as { books?: Entry[] };
    return this.items(result.books || []);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const path = this.novelPath(novelPath);
    const reader = await this.reader(path);
    const book = reader.bookInfo;
    return {
      path,
      name: book.title,
      author: book.author,
      cover: book.cover || defaultCover,
      summary: book.intro,
      genres:
        book.categories?.map(category => category.title).join(',') ||
        book.category,
      status:
        book.finished === 1
          ? NovelStatus.Completed
          : book.finished === 0
            ? NovelStatus.Ongoing
            : NovelStatus.Unknown,
      chapters: reader.chapterInfos
        .slice()
        .sort((a, b) => a.chapterIdx - b.chapterIdx)
        .map(chapter => ({
          name: chapter.title,
          path: path + 'k' + readerId(chapter.chapterUid),
          chapterNumber: chapter.chapterIdx,
          releaseTime: chapter.updateTime
            ? new Date(chapter.updateTime * 1000).toISOString()
            : undefined,
        })),
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const path = this.relativePath(chapterPath);
    if (
      !/^\/web\/reader\/[a-f\d]+(?:g[a-f\d]+)*k[a-f\d]+(?:g[a-f\d]+)*$/.test(
        path,
      )
    ) {
      throw new Error('Invalid WeRead chapter URL.');
    }
    const reader = await this.reader(path);
    const chapter = reader.chapterInfos.find(item =>
      path.endsWith('k' + readerId(item.chapterUid)),
    );
    if (!chapter) throw new Error('This chapter is unavailable on WeRead.');
    const format = reader.bookInfo.format;
    if (format !== 'epub' && format !== 'txt')
      throw new Error('WeRead PDF and comic books are not supported.');
    // The web reader initializes this on the client; SSR leaves pclts at zero.
    // Sending that SSR placeholder makes even preview chapters return {}.
    const clientTimestamp = readerId(Math.floor(Date.now() / 1000));
    const parts = await Promise.all(
      (format === 'epub' ? [0, 1, 3] : [0, 1]).map(async index => {
        const params: Record<string, string | number> = {
          b: readerId(reader.bookId),
          c: readerId(chapter.chapterUid),
          r: Math.pow(Math.floor(Math.random() * 10000), 2),
          st: 0,
          ct: Math.floor(Date.now() / 1000),
          ps: reader.psvts,
          pc: clientTimestamp,
          sc: 0,
        };
        params.s = sign(params);
        const payload = await (
          await this.request(
            '/web/book/chapter/' + (format === 'epub' ? 'e_' : 't_') + index,
            params,
          )
        ).text();
        if (!payload || payload.trim().startsWith('{')) {
          throw new Error(
            'WeRead did not provide chapter text. Open this chapter in WebView, sign in, and check that your account can read it.',
          );
        }
        if (
          payload.length <= 32 ||
          payload.slice(0, 32) !== md5(payload.slice(32)).toUpperCase()
        ) {
          throw new Error('WeRead chapter response failed its checksum.');
        }
        return payload.slice(32);
      }),
    );
    const content = decodeContent(parts.join(''));
    if (!content.trim() || content === '...')
      throw new Error('This chapter requires access through WeRead.');
    if (format === 'txt') {
      const $ = loadCheerio('<div></div>');
      return content
        .split(/\r?\n/)
        .filter(line => line.trim())
        .map(line => $('<p>').text(line).toString())
        .join('');
    }
    const $ = loadCheerio(content);
    $('script, style, iframe').remove();
    $('img').each((_, element) => {
      const image = $(element);
      if ((image.attr('class') || '').includes('qqreader-footnote')) {
        image.replaceWith($('<span>').text(image.attr('alt') || ''));
      } else {
        const src = image.attr('src');
        if (src?.startsWith('../images/'))
          image.attr(
            'src',
            'https://res.weread.qq.com/wrepub/web/' +
              reader.bookId +
              '/' +
              src.slice(10),
          );
      }
    });
    return $('body').html() || '';
  }

  private relativePath(path: string): string {
    const relative = path
      .replace(/^https:\/\/weread\.qq\.com/, '')
      .split(/[?#]/)[0];
    if (!relative.startsWith('/web/reader/'))
      throw new Error('Invalid WeRead reader URL.');
    return relative;
  }

  private novelPath(path: string): string {
    return this.relativePath(path).split('k')[0];
  }

  resolveUrl(path: string): string {
    return /^https:\/\/weread\.qq\.com\//.test(path) ? path : this.site + path;
  }

  filters = {
    ranking: {
      type: FilterTypes.Picker,
      label: 'Ranking',
      value: 'all',
      options: [
        { label: 'Overall', value: 'all' },
        { label: 'Rising', value: 'rising' },
        { label: 'New books', value: 'newbook' },
        { label: 'Novels', value: 'general_novel_rising' },
        { label: 'Top rated', value: 'newrating_publish' },
        { label: 'Fiction', value: '100000' },
        { label: 'History', value: '200000' },
        { label: 'Literature', value: '300000' },
      ],
    },
  } satisfies Filters;
}

export default new WeRead();
