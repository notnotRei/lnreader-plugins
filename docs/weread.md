# WeRead (微信读书)

Source: `https://weread.qq.com`.

The plugin supports rankings (including New books through Latest), paginated
search, book details, and chapter lists. It implements WeRead's signed chapter
requests and fragment decoding for EPUB and plain-text books. PDF, comics, and
audiobook content are unsupported.

## Chapter access

WeRead controls chapter access through its own account, membership, purchases,
and preview limits. The plugin does not purchase or unlock chapters. An empty or
restricted response produces an explicit error instead of saving an empty chapter
or the login screen as book text.

Guest preview reading was verified with Playwright and the live checker. The
reader initializes an encoded client timestamp (`pc`) when it loads; using the
server-rendered placeholder (`pclts: 0`) instead causes empty JSON responses even
for previews. The plugin now generates the timestamp in the same way as the web
reader. It does not require a browser at runtime.

Reading restricted chapters with an authenticated app session still needs
verification: open the chapter on WeRead in the app's WebView, sign in, confirm
the account can read it there, and retry in the app. Do not paste account cookies
into source code or test logs.

## Validation

Run the repository's documented live checker:

```sh
npm run check:plugin -- plugins/chinese/weread.ts
npx eslint plugins/chinese/weread.ts
npx prettier --check plugins/chinese/weread.ts
npm run build:compile
```

The live checker runs without a logged-in WeRead session. A chapter failure needs
investigation or verification in an authenticated app session; it must not be
reported as a passing reader test.
