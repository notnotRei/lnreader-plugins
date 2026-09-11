const fs = require('node:fs');
const path = require('node:path');

const themeDirectories = {
  madara: 'madara',
  lightnovelwp: 'lightnovelwp',
  hotnovelpub: 'hotnovelpub',
  fictioneer: 'fictioneer',
};

function issueField(body, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(
    new RegExp(`(?:^|\\n)### ${escapedLabel}\\s*\\n+([^\\n]+)`, 'i'),
  );
  const value = match?.[1]?.trim();
  return value && value !== '_No response_' ? value : '';
}

function sourceId(name, hostname) {
  const id = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  return (
    id ||
    hostname
      .replace(/^www\./, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
  );
}

function canonicalLanguage(language) {
  const directory = path.join(
    process.cwd(),
    'plugins',
    language.trim().toLowerCase(),
  );
  if (!language || !fs.existsSync(directory)) {
    throw new Error(`Unsupported language from issue: "${language}"`);
  }

  return (
    language.trim().charAt(0).toUpperCase() +
    language.trim().slice(1).toLowerCase()
  );
}

function hotNovelPubLanguage(language) {
  const codes = {
    English: 'en',
    Russian: 'ru',
    Spanish: 'es',
    Portuguese: 'pt',
    Turkish: 'th',
  };
  const code = codes[language];
  if (!code) {
    throw new Error(
      `HotNovelPub does not map the requested language "${language}"`,
    );
  }
  return code;
}

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const body = process.env.ISSUE_BODY || '';
const theme = (process.env.THEME || '').toLowerCase();
const themeDirectory = themeDirectories[theme];

if (!themeDirectory) {
  throw new Error(`Unsupported detected theme: "${theme}"`);
}

const submittedUrl = issueField(body, 'Website URL');
const name = issueField(body, 'Plugin Name');
const language = canonicalLanguage(issueField(body, 'Language'));

if (!submittedUrl || !name) {
  throw new Error('The issue is missing a Website URL or Plugin Name');
}
if (name.length > 100 || /[\/\\\0\r\n]/.test(name)) {
  throw new Error('The Plugin Name contains unsupported characters');
}

let url;
try {
  url = new URL(submittedUrl);
} catch {
  throw new Error(`Invalid Website URL from issue: "${submittedUrl}"`);
}

if (!['http:', 'https:'].includes(url.protocol)) {
  throw new Error(`Unsupported Website URL protocol: "${url.protocol}"`);
}

const sourceSite = url.origin;
const id = sourceId(name, url.hostname);
const sourcesPath = path.join(
  process.cwd(),
  'plugins',
  'multisrc',
  themeDirectory,
  'sources.json',
);
const sourcesText = fs.readFileSync(sourcesPath, 'utf8');
const sources = JSON.parse(sourcesText);

const duplicate = sources.find(source => {
  try {
    return (
      source.id.toLowerCase() === id.toLowerCase() ||
      new URL(source.sourceSite).hostname
        .replace(/^www\./, '')
        .toLowerCase() === url.hostname.replace(/^www\./, '').toLowerCase()
    );
  } catch {
    return source.id.toLowerCase() === id.toLowerCase();
  }
});

if (duplicate) {
  console.log(
    `Skipping ${sourceSite}: it already matches source "${duplicate.id}"`,
  );
  writeOutput('changed', 'false');
  writeOutput('source_name', name.replace(/[\r\n]/g, ' '));
  process.exit(0);
}

const source = {
  id,
  sourceSite,
  sourceName: name,
};

if (theme === 'fictioneer') {
  source.options = {
    browsePage: 'browse',
    ...(language === 'English' ? {} : { lang: language }),
  };
} else if (theme === 'hotnovelpub') {
  const lang = hotNovelPubLanguage(language);
  if (lang !== 'en') source.options = { lang };
} else if (language !== 'English') {
  source.options = { lang: language };
}

const serializedSource = JSON.stringify(source, null, 2)
  .split('\n')
  .map(line => `  ${line}`)
  .join('\n');
const updatedSources = sourcesText.replace(
  /\n\]\s*$/,
  `,\n${serializedSource}\n]\n`,
);
if (updatedSources === sourcesText) {
  throw new Error(`Could not append a source to ${sourcesPath}`);
}
fs.writeFileSync(sourcesPath, updatedSources);

console.log(`Added ${id} to ${path.relative(process.cwd(), sourcesPath)}`);
writeOutput('changed', 'true');
writeOutput('source_name', name.replace(/[\r\n]/g, ' '));
writeOutput('source_id', id);
