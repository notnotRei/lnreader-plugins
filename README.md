# notnotrei plugins

Curated LNReader plugin set made for [Chimahon](https://github.com/Chimahon/chimahon) — including **EPUB extensions** that download whole books as EPUB files instead of scraping chapters.

## Install

Add this repository URL in Chimahon (Browse → Extensions → add repo):

```
https://raw.githubusercontent.com/notnotRei/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json
```

## Extensions

| Name | Language | Type | Site |
|---|---|---|---|
| Syosetu | 日本語 | Chapters | yomou.syosetu.com |
| Kakuyomu | 日本語 | Chapters | kakuyomu.jp |
| Nocturne | 日本語 | Chapters (R18) | noc.syosetu.com |
| Pixiv | 日本語 | Chapters | pixiv.net |
| Hameln | 日本語 | Chapters | syosetu.org |
| Huangjinwu | 中文 | Chapters | tw.hjwzw.com |
| Moelibrary | Multi | **EPUB** | books.moelibrary.cc |
| Epub.moe | Multi | **EPUB** | epub.moe |

## EPUB extensions

Normal extensions list chapters that the app fetches one by one. EPUB extensions (`kind: "download"`, via `getDownloadUrl` in [`src/types/plugin.ts`](./src/types/plugin.ts)) point at a whole-book file instead: the detail screen shows a single **Download EPUB** button, imports the file into your Library, and lets you delete it from there. See the [plugin docs](./docs/docs.md) for the contract.

## Development

**Prerequisites:** Node.js >= 22

```bash
npm install
npm run dev:start       # web test UI at localhost:3000
npm run check:plugin -- plugins/<lang>/<name>.ts   # required live check
npm run serve:dev       # localhost repo for the app (see .env.template)
```

Pushing to `master` builds and publishes to the `plugins/v3.0.0` branch automatically ([workflow](./.github/workflows/publish-plugins.yml)).

## Disclaimer

Not affiliated with any content providers.
