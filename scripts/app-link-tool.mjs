import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataPath = path.join(projectRoot, 'data', 'apps.json');
const indexPath = path.join(projectRoot, 'index.html');
const outputDir = path.join(projectRoot, 'assets', 'thumbs');

const categories = [
  { id: 'game', label: 'ゲーム', className: 'game' },
  { id: 'tool', label: 'ツール', className: 'tool' },
];

const viewport = {
  width: 1280,
  height: 720,
};

const command = process.argv[2] || 'help';
const flags = parseFlags(process.argv.slice(3));

switch (command) {
  case 'list':
    await listApps();
    break;
  case 'add':
    await addApp(flags);
    break;
  case 'update':
    await updateApp(flags);
    break;
  case 'remove':
    await removeApp(flags);
    break;
  case 'build':
    await buildIndex();
    break;
  case 'thumbnails':
    await generateThumbnails(flags);
    break;
  case 'refresh':
    await generateThumbnails(flags);
    await buildIndex();
    break;
  case 'help':
  default:
    printHelp();
    break;
}

async function listApps() {
  const apps = await readApps();

  for (const category of categories) {
    console.log(`${category.label}`);
    for (const app of apps.filter((item) => item.category === category.id)) {
      console.log(`  ${app.slug} | ${app.title} | ${app.url}`);
    }
  }
}

async function addApp(input) {
  const apps = await readApps();
  const app = normalizeApp(input);

  if (apps.some((item) => item.slug === app.slug)) {
    throw new Error(`slug "${app.slug}" は既に存在します。更新する場合は update を使ってください。`);
  }

  apps.push(app);
  await writeApps(apps);
  await buildIndex(apps);
  console.log(`Added ${app.slug}`);
}

async function updateApp(input) {
  if (!input.slug) {
    throw new Error('update には --slug が必要です。');
  }

  const apps = await readApps();
  const index = apps.findIndex((app) => app.slug === input.slug);

  if (index === -1) {
    throw new Error(`slug "${input.slug}" が見つかりません。`);
  }

  apps[index] = normalizeApp({ ...apps[index], ...input });
  await writeApps(apps);
  await buildIndex(apps);
  console.log(`Updated ${input.slug}`);
}

async function removeApp(input) {
  if (!input.slug) {
    throw new Error('remove には --slug が必要です。');
  }

  const apps = await readApps();
  const nextApps = apps.filter((app) => app.slug !== input.slug);

  if (nextApps.length === apps.length) {
    throw new Error(`slug "${input.slug}" が見つかりません。`);
  }

  await writeApps(nextApps);
  await buildIndex(nextApps);
  console.log(`Removed ${input.slug}`);
}

async function buildIndex(existingApps) {
  const apps = existingApps || await readApps();
  await writeFile(indexPath, renderIndex(apps), 'utf8');
  console.log('Built index.html');
}

async function generateThumbnails(input) {
  const apps = await readApps();
  const targets = input.slug
    ? apps.filter((app) => app.slug === input.slug)
    : apps;

  if (input.slug && targets.length === 0) {
    throw new Error(`slug "${input.slug}" が見つかりません。`);
  }

  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });

  for (const app of targets) {
    console.log(`Capturing ${app.slug}...`);

    try {
      await page.goto(app.url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await alignPage(page, app.focus || 'auto');
      await page.waitForTimeout(300);

      await page.screenshot({
        path: path.join(outputDir, `${app.slug}.png`),
        fullPage: false,
      });
    } catch (error) {
      console.warn(`Skipped ${app.slug}: ${error.message}`);
    }
  }

  await browser.close();
  console.log(`Saved thumbnails to ${path.relative(projectRoot, outputDir)}`);
}

async function alignPage(page, focus) {
  if (focus === 'top') {
    await page.evaluate(() => window.scrollTo(0, 0));
    return;
  }

  const target = await page.evaluate((focusMode) => {
    const selectors = [
      focusMode && focusMode !== 'auto' && focusMode !== 'center' ? focusMode : null,
      'canvas',
      'main',
      '[role="main"]',
      '#app',
      '#root',
      '.app',
      '.game',
      '.container',
    ].filter(Boolean);

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const isVisible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width >= 240
        && rect.height >= 160;

      if (isVisible) {
        return {
          top: rect.top + window.scrollY,
          height: rect.height,
        };
      }
    }

    return {
      top: 0,
      height: Math.min(document.documentElement.scrollHeight, window.innerHeight),
    };
  }, focus);

  await page.evaluate(({ target, focusMode }) => {
    const viewportHeight = window.innerHeight;
    const shouldTopAlign = focusMode === 'auto' && target.height > viewportHeight * 0.78;
    const nextY = shouldTopAlign
      ? target.top
      : target.top - ((viewportHeight - target.height) / 2);

    window.scrollTo(0, Math.max(0, nextY));
  }, { target, focusMode: focus });
}

async function readApps() {
  const apps = JSON.parse(await readFile(dataPath, 'utf8'));
  return apps.map(normalizeApp);
}

async function writeApps(apps) {
  const sortedApps = categories.flatMap((category) => apps.filter((app) => app.category === category.id));
  await writeFile(dataPath, `${JSON.stringify(sortedApps, null, 2)}\n`, 'utf8');
}

function normalizeApp(input) {
  const app = {
    slug: input.slug,
    category: input.category,
    title: input.title,
    description: input.description,
    url: input.url,
    initial: input.initial,
    focus: input.focus || 'auto',
  };

  const requiredFields = ['slug', 'category', 'title', 'description', 'url', 'initial'];
  for (const field of requiredFields) {
    if (!app[field]) {
      throw new Error(`アプリ情報に ${field} がありません。`);
    }
  }

  if (!/^[a-z0-9-]+$/.test(app.slug)) {
    throw new Error('slug は英小文字、数字、ハイフンだけで指定してください。');
  }

  if (!categories.some((category) => category.id === app.category)) {
    throw new Error('category は game または tool を指定してください。');
  }

  return app;
}

function parseFlags(args) {
  const values = {};

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) continue;

    const key = item.slice(2);
    const next = args[index + 1];

    if (!next || next.startsWith('--')) {
      values[key] = true;
      continue;
    }

    values[key] = next;
    index += 1;
  }

  return values;
}

function renderIndex(apps) {
  const sections = categories
    .map((category) => renderSection(category, apps.filter((app) => app.category === category.id)))
    .join('\n\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ik-neet.com | アプリ一覧</title>
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />

  <style>
    * { box-sizing: border-box; }

    :root {
      --bg: #f7fafc;
      --text: #1f2d3d;
      --muted: #627386;
      --line: #d9e4ec;
      --accent: #146c94;
      --surface-hover: #eef6fa;
      --game: #1f8a70;
      --tool: #8a5a1f;
    }

    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
      color: var(--text);
      background: var(--bg);
      line-height: 1.65;
    }

    header,
    main,
    footer {
      width: min(960px, calc(100% - 40px));
      margin: 0 auto;
    }

    header {
      padding: 48px 0 22px;
      border-bottom: 1px solid var(--line);
    }

    h1 { margin: 0; }

    .site-logo {
      display: block;
      width: min(300px, 82vw);
      height: auto;
    }

    .lead {
      max-width: 560px;
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 15px;
    }

    main { padding: 22px 0 8px; }

    .app-section { padding: 26px 0 12px; }

    .section-heading {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 10px;
      border-bottom: 2px solid var(--line);
    }

    .section-heading h2 {
      margin: 0;
      padding-bottom: 8px;
      font-size: 22px;
      line-height: 1.3;
      letter-spacing: 0;
    }

    .section-heading .count {
      color: var(--muted);
      font-size: 13px;
    }

    .section-heading.game h2 { border-bottom: 2px solid var(--game); }
    .section-heading.tool h2 { border-bottom: 2px solid var(--tool); }

    .app-items {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .app-item { border-bottom: 1px solid var(--line); }

    .app-link {
      display: grid;
      grid-template-columns: 96px 1fr auto;
      align-items: center;
      gap: 16px;
      padding: 14px 4px;
      color: inherit;
      text-decoration: none;
    }

    .app-link:hover { background: var(--surface-hover); }

    .app-link:focus-visible {
      outline: 3px solid rgba(20, 108, 148, 0.22);
      outline-offset: 2px;
    }

    .app-thumb {
      width: 96px;
      aspect-ratio: 16 / 9;
      display: grid;
      place-items: center;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #fff;
      color: var(--accent);
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .app-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .app-text { min-width: 0; }

    .app-title {
      display: block;
      margin-bottom: 2px;
      font-size: 17px;
      line-height: 1.4;
    }

    .app-description {
      display: block;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }

    .app-action {
      color: var(--accent);
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }

    footer {
      padding: 28px 0 44px;
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 640px) {
      header,
      main,
      footer {
        width: min(100% - 28px, 960px);
      }

      header { padding-top: 34px; }

      .app-link {
        grid-template-columns: 72px 1fr;
        gap: 12px;
        padding: 13px 0;
      }

      .app-thumb { width: 72px; }

      .app-action {
        grid-column: 2;
        justify-self: start;
        margin-top: -6px;
      }
    }
  </style>
</head>
<body>

<header>
  <h1><img class="site-logo" src="assets/logo.svg" alt="ik-neet.com" /></h1>
  <p class="lead">制作したWebアプリの一覧です。</p>
</header>

<main>
${sections}
</main>

<footer>
  © 2026 ik_neet
</footer>

</body>
</html>
`;
}

function renderSection(category, apps) {
  const headingId = `${category.id}s-heading`;
  const items = apps.map(renderAppItem).join('\n\n');

  return `  <section class="app-section" aria-labelledby="${headingId}">
    <div class="section-heading ${category.className}">
      <h2 id="${headingId}">${escapeHtml(category.label)}</h2>
      <span class="count">${apps.length}件</span>
    </div>

    <ul class="app-items">
${items}
    </ul>
  </section>`;
}

function renderAppItem(app) {
  return `      <li class="app-item">
        <a class="app-link" href="${escapeHtml(app.url)}" target="_blank">
          <span class="app-thumb">${renderThumbnail(app)}</span>
          <span class="app-text">
            <strong class="app-title">${escapeHtml(app.title)}</strong>
            <span class="app-description">${escapeHtml(app.description)}</span>
          </span>
          <span class="app-action">開く</span>
        </a>
      </li>`;
}

function renderThumbnail(app) {
  const thumbnailPath = path.join(outputDir, `${app.slug}.png`);

  return existsSync(thumbnailPath)
    ? `<img src="assets/thumbs/${escapeHtml(app.slug)}.png" alt="" />`
    : escapeHtml(app.initial);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function printHelp() {
  console.log(`Usage:
  npm run app -- list
  npm run app -- build
  npm run app -- thumbnails [--slug slug]
  npm run app -- refresh [--slug slug]
  npm run app -- add --slug slug --category game|tool --title title --description text --url url --initial text [--focus auto|top|center|selector]
  npm run app -- update --slug slug [--category game|tool] [--title title] [--description text] [--url url] [--initial text] [--focus auto|top|center|selector]
  npm run app -- remove --slug slug
`);
}
