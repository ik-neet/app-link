import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataPath = path.join(projectRoot, 'data', 'apps.json');
const categoriesPath = path.join(projectRoot, 'data', 'categories.json');
const indexPath = path.join(projectRoot, 'index.html');
const outputDir = path.join(projectRoot, 'assets', 'thumbs');

const defaultCategories = [
  { id: 'game', label: 'ゲーム', className: 'game', color: '#1f8a70' },
  { id: 'tool', label: 'ツール', className: 'tool', color: '#8a5a1f' },
];

const categoryColorPalette = ['#3b6fa0', '#9c5fb0', '#b07b3b', '#3b9c87', '#a04a4a'];

const viewport = {
  width: 1280,
  height: 720,
};

export {
  addApp,
  addCategory,
  buildIndex,
  generateThumbnails,
  listApps,
  readApps,
  readCategories,
  removeApp,
  reorderApp,
  runCli,
  updateApp,
  writeCategories,
};

if (isCliEntry()) {
  await runCli(process.argv.slice(2));
}

async function runCli(args) {
  const command = args[0] || 'help';
  const flags = parseFlags(args.slice(1));

  switch (command) {
    case 'list':
      await listApps({ print: true });
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
}

async function listApps(options = {}) {
  const apps = await readApps();

  if (options.print) {
    const categories = await readCategories();
    for (const category of categories) {
      console.log(`${category.label}`);
      for (const app of apps.filter((item) => item.category === category.id)) {
        console.log(`  ${app.slug} | ${app.title} | ${app.url}`);
      }
    }
  }

  return apps;
}

async function addApp(input) {
  const apps = await readApps();
  const app = normalizeApp(input);
  await assertCategoryExists(app.category);

  if (apps.some((item) => item.slug === app.slug)) {
    throw new Error(`slug "${app.slug}" は既に存在します。更新する場合は update を使ってください。`);
  }

  apps.push(app);
  await writeApps(apps);
  await buildIndex(apps);
  console.log(`Added ${app.slug}`);
  return app;
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

  const nextApp = normalizeApp({ ...apps[index], ...input });
  await assertCategoryExists(nextApp.category);

  apps[index] = nextApp;
  await writeApps(apps);
  await buildIndex(apps);
  console.log(`Updated ${input.slug}`);
  return apps[index];
}

async function assertCategoryExists(categoryId) {
  const categories = await readCategories();
  if (!categories.some((category) => category.id === categoryId)) {
    throw new Error(`category "${categoryId}" は存在しません。先にカテゴリを追加してください。`);
  }
}

async function reorderApp({ slug, direction }) {
  if (!slug) {
    throw new Error('order には slug が必要です。');
  }

  if (direction !== 'up' && direction !== 'down') {
    throw new Error('direction は up または down を指定してください。');
  }

  const apps = await readApps();
  const target = apps.find((app) => app.slug === slug);

  if (!target) {
    throw new Error(`slug "${slug}" が見つかりません。`);
  }

  const siblingIndexes = apps
    .map((app, index) => ({ app, index }))
    .filter(({ app }) => app.category === target.category)
    .map(({ index }) => index);

  const targetIndex = apps.indexOf(target);
  const positionInSiblings = siblingIndexes.indexOf(targetIndex);
  const swapWith = direction === 'up'
    ? siblingIndexes[positionInSiblings - 1]
    : siblingIndexes[positionInSiblings + 1];

  if (swapWith === undefined) {
    return apps;
  }

  const nextApps = [...apps];
  [nextApps[targetIndex], nextApps[swapWith]] = [nextApps[swapWith], nextApps[targetIndex]];

  await writeApps(nextApps);
  await buildIndex(nextApps);
  return nextApps;
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
  return input.slug;
}

async function buildIndex(existingApps) {
  const apps = existingApps || await readApps();
  const cats = await readCategories();
  const visibleApps = apps.filter((app) => !app.hidden);
  await writeFile(indexPath, renderIndex(visibleApps, cats), 'utf8');
  console.log('Built index.html');
  return indexPath;
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

  const urlOverride = input.slug ? String(input.url || '').trim() : '';

  for (const app of targets) {
    const captureUrl = urlOverride || app.url;
    console.log(`Capturing ${app.slug} (${captureUrl})...`);

    try {
      await page.goto(captureUrl, {
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
  return targets.map((app) => path.join(outputDir, `${app.slug}.png`));
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
  const categories = await readCategories();
  const knownIds = new Set(categories.map((category) => category.id));
  const grouped = categories.flatMap((category) => apps.filter((app) => app.category === category.id));
  const unknown = apps.filter((app) => !knownIds.has(app.category));
  const sortedApps = [...grouped, ...unknown];
  await writeFile(dataPath, `${JSON.stringify(sortedApps, null, 2)}\n`, 'utf8');
}

async function readCategories() {
  if (!existsSync(categoriesPath)) {
    return defaultCategories;
  }

  const categories = JSON.parse(await readFile(categoriesPath, 'utf8'));
  return categories;
}

async function writeCategories(categories) {
  await mkdir(path.dirname(categoriesPath), { recursive: true });
  await writeFile(categoriesPath, `${JSON.stringify(categories, null, 2)}\n`, 'utf8');
}

async function addCategory(input) {
  const id = String(input.id || '').trim();
  const label = String(input.label || '').trim();

  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error('カテゴリidは英小文字、数字、ハイフンだけで指定してください。');
  }

  if (!label) {
    throw new Error('カテゴリのlabelは必須です。');
  }

  const categories = await readCategories();

  if (categories.some((category) => category.id === id)) {
    throw new Error(`カテゴリ "${id}" は既に存在します。`);
  }

  const fallbackColor = categoryColorPalette[categories.length % categoryColorPalette.length];
  const requestedColor = String(input.color || '').trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(requestedColor) ? requestedColor : fallbackColor;

  const category = { id, label, className: id, color };
  const nextCategories = [...categories, category];
  await writeCategories(nextCategories);
  return category;
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
    hidden: Boolean(input.hidden),
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

  if (!/^[a-z0-9-]+$/.test(app.category)) {
    throw new Error('category は英小文字、数字、ハイフンだけで指定してください。');
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

function renderIndex(apps, cats) {
  const sections = cats
    .map((category) => renderSection(category, apps.filter((app) => app.category === category.id)))
    .join('\n\n');

  const categoryColorVars = cats
    .map((category) => `      --cat-${escapeHtml(category.className)}: ${escapeHtml(category.color || '#146c94')};`)
    .join('\n');

  const categoryHeadingRules = cats
    .map((category) => `    .section-heading.${escapeHtml(category.className)} h2 { border-bottom: 2px solid var(--cat-${escapeHtml(category.className)}); }`)
    .join('\n');

  const categoryTabRules = cats
    .map((category) => `    .category-tab.${escapeHtml(category.className)} { border-bottom-color: var(--cat-${escapeHtml(category.className)}); }`)
    .join('\n');

  const categoryNav = renderCategoryNav(cats);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ik-neet.com | アプリ一覧</title>

  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-Z1G7WQ77E1"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-Z1G7WQ77E1');
  </script>
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
${categoryColorVars}
    }

    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
      color: var(--text);
      background: var(--bg);
      line-height: 1.65;
    }

    header,
    nav,
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
      scroll-margin-top: 64px;
    }

    .section-heading .count {
      color: var(--muted);
      font-size: 13px;
    }

    .category-nav {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 22px;
      padding: 14px 0;
      position: sticky;
      top: 0;
      z-index: 3;
      background: rgba(247, 250, 252, 0.96);
      backdrop-filter: blur(6px);
      border-bottom: 1px solid var(--line);
    }

    .category-tab {
      display: inline-block;
      padding-bottom: 4px;
      border-bottom: 2px solid transparent;
      color: var(--text);
      text-decoration: none;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .category-tab:hover { color: var(--accent); }

${categoryTabRules}

${categoryHeadingRules}

    .app-items {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .app-item { border-bottom: 1px solid var(--line); }

    .app-link {
      display: grid;
      grid-template-columns: 120px 1fr auto;
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
      width: 120px;
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

    .thumb-zoom-preview {
      position: fixed;
      z-index: 50;
      width: 360px;
      max-width: calc(100vw - 24px);
      aspect-ratio: 16 / 9;
      padding: 4px;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 18px 44px rgba(15, 30, 45, 0.28);
      opacity: 0;
      transform: scale(0.96);
      pointer-events: none;
      transition: opacity 0.12s ease, transform 0.12s ease;
    }

    .thumb-zoom-preview.visible {
      opacity: 1;
      transform: scale(1);
    }

    .thumb-zoom-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      border-radius: 4px;
    }

    @media (hover: none) {
      .thumb-zoom-preview { display: none; }
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
        grid-template-columns: 88px 1fr;
        gap: 12px;
        padding: 13px 0;
      }

      .app-thumb { width: 88px; }

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

${categoryNav}

<main>
${sections}
</main>

<footer>
  © 2026 ik_neet
</footer>

<div class="thumb-zoom-preview" id="thumbZoomPreview" aria-hidden="true"><img alt="" /></div>

<script>
  (function () {
    if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;

    var preview = document.getElementById('thumbZoomPreview');
    var previewImg = preview.querySelector('img');
    var previewWidth = 360;
    var previewHeight = 360 * 9 / 16;
    var margin = 12;

    document.querySelectorAll('.app-thumb').forEach(function (thumb) {
      var img = thumb.querySelector('img');
      if (!img) return;

      thumb.addEventListener('mouseenter', function () {
        previewImg.src = img.currentSrc || img.src;
        positionPreview(thumb);
        preview.classList.add('visible');
      });

      thumb.addEventListener('mouseleave', function () {
        preview.classList.remove('visible');
      });
    });

    window.addEventListener('scroll', function () {
      preview.classList.remove('visible');
    }, { passive: true });

    function positionPreview(thumb) {
      var rect = thumb.getBoundingClientRect();

      var left = rect.right + margin;
      if (left + previewWidth > window.innerWidth - margin) {
        left = rect.left - previewWidth - margin;
      }
      if (left < margin) {
        left = Math.max(margin, (window.innerWidth - previewWidth) / 2);
      }

      var top = rect.top + rect.height / 2 - previewHeight / 2;
      top = Math.min(Math.max(top, margin), window.innerHeight - previewHeight - margin);

      preview.style.left = left + 'px';
      preview.style.top = top + 'px';
    }
  })();
</script>

</body>
</html>
`;
}

function renderCategoryNav(cats) {
  const tabs = cats
    .map((category) => `    <a class="category-tab ${escapeHtml(category.className)}" href="#${category.id}s-heading">${escapeHtml(category.label)}</a>`)
    .join('\n');

  return `<nav class="category-nav" aria-label="カテゴリ">
${tabs}
</nav>`;
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
  npm run app -- add --slug slug --category categoryId --title title --description text --url url --initial text [--focus auto|top|center|selector]
  npm run app -- update --slug slug [--category categoryId] [--title title] [--description text] [--url url] [--initial text] [--focus auto|top|center|selector]
  npm run app -- remove --slug slug
`);
}

function isCliEntry() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
