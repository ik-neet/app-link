import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// E2E は APP_LINK_DATA_ROOT に使い捨てのデータ置き場を指すことで、
// リポジトリの data/apps.json と index.html を汚さずに読み書きする。
// サムネイルと assets は実体を共有する（読み取りのみ）。
const dataRoot = process.env.APP_LINK_DATA_ROOT
  ? path.resolve(process.env.APP_LINK_DATA_ROOT)
  : projectRoot;

const dataPath = path.join(dataRoot, 'data', 'apps.json');
const categoriesPath = path.join(dataRoot, 'data', 'categories.json');
const indexPath = path.join(dataRoot, 'index.html');
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

  const categoryAccentRules = cats
    .map((category) => `    .section-heading.${escapeHtml(category.className)},
    .category-tab.${escapeHtml(category.className)} { --cat: var(--cat-${escapeHtml(category.className)}); }`)
    .join('\n');

  const categoryNav = renderCategoryNav(cats);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ik-neet.com | アプリ一覧</title>
  <meta name="description" content="ik-neet.com で公開している Web アプリ・ツール・デスクトップアプリの一覧です。" />
  <meta name="theme-color" content="#f7fafc" />

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
  <link rel="stylesheet" href="assets/tokens.css" />

  <style>
    /* Hallmark · genre: editorial · macrostructure: Catalogue (index list)
     * nav: N9 edge-aligned tab rail · footer: Ft1 hairline colophon
     * design-system: DESIGN.md · designed-as-app
     */

    :root {
${categoryColorVars}
    }

    /* カテゴリ色は --cat 一本に集約し、見出し／タブ側は var(--cat) だけを参照する */
${categoryAccentRules}

    *, *::before, *::after { box-sizing: border-box; }

    html {
      -webkit-text-size-adjust: 100%;
      scroll-behavior: smooth;
    }

    html, body { overflow-x: clip; }

    body {
      margin: 0;
      background: var(--color-paper);
      color: var(--color-ink);
      font-family: var(--font-body);
      font-size: var(--text-md);
      line-height: var(--leading-body);
      letter-spacing: var(--track-body);
      font-optical-sizing: auto;
      -webkit-font-smoothing: antialiased;
    }

    .shell {
      width: min(var(--page-width), calc(100% - var(--space-lg)));
      margin-inline: auto;
    }

    :where(a, button, [tabindex]):focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
      border-radius: var(--radius-sm);
    }

    .skip-link {
      position: absolute;
      left: var(--space-sm);
      top: var(--space-sm);
      z-index: 80;
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-pill);
      background: var(--color-accent);
      color: var(--color-accent-ink);
      font-size: var(--text-xs);
      font-weight: 700;
      text-decoration: none;
      transform: translateY(-200%);
    }

    .skip-link:focus-visible { transform: translateY(0); }

    /* --- header --- */

    .site-header {
      padding-block: var(--space-xl) var(--space-md);
    }

    .site-title { margin: 0; }

    .site-logo {
      display: block;
      width: min(18.75rem, 82vw);
      height: auto;
    }

    .lead {
      max-width: var(--measure);
      margin: var(--space-2xs) 0 0;
      color: var(--color-ink-2);
      font-size: var(--text-md);
    }

    /* --- category rail (translucent chrome, content scrolls under) --- */

    .category-nav {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--material-chrome);
      backdrop-filter: blur(var(--material-blur)) saturate(180%);
      -webkit-backdrop-filter: blur(var(--material-blur)) saturate(180%);
      box-shadow: inset 0 -1px transparent;
      transition: box-shadow var(--dur-short) var(--ease-out);
    }

    .category-nav[data-scrolled="true"] {
      box-shadow: inset 0 -1px var(--color-rule);
    }

    /* スクロールエッジ: 罫線ではなくフェードでコンテンツと分ける */
    .category-nav::after {
      content: "";
      position: absolute;
      inset: 100% 0 auto 0;
      height: var(--space-sm);
      background: linear-gradient(to bottom, var(--color-paper), transparent);
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--dur-short) var(--ease-out);
    }

    .category-nav[data-scrolled="true"]::after { opacity: 1; }

    .category-nav-track {
      display: flex;
      gap: var(--space-sm);
      padding-block: var(--space-3xs);
      overflow-x: auto;
      scrollbar-width: none;
    }

    .category-nav-track::-webkit-scrollbar { display: none; }

    .category-tab {
      --cat: var(--color-accent);
      position: relative;
      display: inline-flex;
      align-items: center;
      min-height: 2.5rem;
      padding-inline: var(--space-2xs);
      border-radius: var(--radius-sm);
      color: var(--color-ink-2);
      font-size: var(--text-sm);
      font-weight: 650;
      letter-spacing: var(--track-small);
      text-decoration: none;
      white-space: nowrap;
      transition: color var(--dur-instant) var(--ease-out), background-color var(--dur-instant) var(--ease-out), transform var(--dur-instant) var(--ease-out);
    }

    .category-tab::after {
      content: "";
      position: absolute;
      left: var(--space-2xs);
      right: var(--space-2xs);
      bottom: 0.3rem;
      height: 2px;
      border-radius: var(--radius-pill);
      background: var(--cat);
      transform: scaleX(0);
      transform-origin: left center;
      transition: transform var(--dur-short) var(--ease-out);
    }

    .category-tab:hover {
      color: var(--color-ink);
      background: var(--color-paper-3);
    }

    .category-tab:active { transform: translateY(1px); }

    .category-tab:hover::after,
    .category-tab[aria-current="true"]::after { transform: scaleX(1); }

    .category-tab[aria-current="true"] { color: var(--color-ink); }

    /* --- sections --- */

    main { padding-bottom: var(--space-sm); }

    .app-section { padding-block: var(--space-lg) var(--space-2xs); }

    .section-heading {
      --cat: var(--color-accent);
      display: flex;
      align-items: baseline;
      gap: var(--space-2xs);
      padding-bottom: var(--space-2xs);
      border-bottom: var(--rule-hair) solid var(--color-rule);
    }

    .section-heading h2 {
      position: relative;
      margin: 0;
      font-size: var(--text-xl);
      font-weight: 700;
      line-height: var(--leading-heading);
      letter-spacing: var(--track-heading);
      overflow-wrap: anywhere;
      min-width: 0;
      scroll-margin-top: calc(var(--chrome-height) + var(--space-sm));
    }

    .section-heading h2::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(-1 * var(--space-2xs) - 1px);
      height: 2px;
      border-radius: var(--radius-pill);
      background: var(--cat);
    }

    .section-heading .count {
      flex: none;
      padding: 0.05rem var(--space-2xs);
      border-radius: var(--radius-pill);
      background: color-mix(in oklab, var(--cat) 16%, transparent);
      color: var(--color-ink-2);
      font-size: var(--text-2xs);
      font-weight: 650;
      letter-spacing: var(--track-small);
    }

    .app-items {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .app-item + .app-item { border-top: var(--rule-hair) solid var(--color-rule); }

    .app-empty {
      margin: 0;
      padding: var(--space-sm) var(--space-2xs);
      color: var(--color-ink-2);
      font-size: var(--text-sm);
    }

    .app-link {
      display: grid;
      grid-template-columns: 7.5rem minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-sm);
      margin-inline: calc(-1 * var(--space-2xs));
      padding: var(--space-xs) var(--space-2xs);
      border-radius: var(--radius-md);
      color: inherit;
      text-decoration: none;
      transition: background-color var(--dur-instant) var(--ease-out), transform var(--dur-instant) var(--ease-out);
    }

    .app-link:hover { background: var(--color-paper-3); }

    .app-link:active {
      background: var(--color-accent-wash);
      transform: scale(0.995);
    }

    .app-thumb {
      width: 7.5rem;
      aspect-ratio: 16 / 9;
      display: grid;
      place-items: center;
      overflow: hidden;
      border: var(--rule-hair) solid var(--color-rule);
      border-radius: var(--radius-sm);
      background: var(--color-paper-2);
      color: var(--color-accent);
      font-size: var(--text-xl);
      font-weight: 700;
      letter-spacing: var(--track-heading);
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
      font-size: var(--text-lg);
      font-weight: 700;
      line-height: var(--leading-tight);
      letter-spacing: var(--track-heading);
      overflow-wrap: anywhere;
    }

    .app-description {
      display: block;
      margin-top: 0.125rem;
      color: var(--color-ink-2);
      font-size: var(--text-sm);
      line-height: 1.55;
    }

    .app-action {
      display: inline-flex;
      align-items: center;
      gap: var(--space-3xs);
      color: var(--color-accent);
      font-size: var(--text-xs);
      font-weight: 700;
      letter-spacing: var(--track-small);
      white-space: nowrap;
    }

    .app-action svg {
      width: 0.7rem;
      height: 0.7rem;
      transition: transform var(--dur-short) var(--ease-out);
    }

    .app-link:hover .app-action svg { transform: translateX(3px); }

    /* --- hover zoom preview (materializes from the thumbnail it belongs to) --- */

    .thumb-zoom-preview {
      position: fixed;
      z-index: 60;
      padding: var(--space-3xs);
      background: var(--material-float);
      backdrop-filter: blur(var(--material-blur));
      -webkit-backdrop-filter: blur(var(--material-blur));
      border: var(--rule-hair) solid var(--color-rule);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-float);
      opacity: 0;
      transform: scale(0.94);
      filter: blur(6px);
      pointer-events: none;
      transition: opacity var(--dur-short) var(--ease-out), transform var(--dur-short) var(--ease-out), filter var(--dur-short) var(--ease-out);
    }

    .thumb-zoom-preview.visible {
      opacity: 1;
      transform: scale(1);
      filter: blur(0);
    }

    .thumb-zoom-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      border-radius: var(--radius-sm);
    }

    @media (hover: none) {
      .thumb-zoom-preview { display: none; }
    }

    /* --- footer --- */

    .site-footer {
      margin-top: var(--space-lg);
      padding-block: var(--space-md) var(--space-xl);
      border-top: var(--rule-hair) solid var(--color-rule);
      color: var(--color-ink-2);
      font-size: var(--text-2xs);
      letter-spacing: var(--track-small);
    }

    /* --- narrow --- */

    @media (max-width: 40rem) {
      .shell { width: calc(100% - var(--space-md)); }

      .site-header { padding-top: var(--space-lg); }

      .app-link {
        grid-template-columns: 5.5rem minmax(0, 1fr);
        gap: var(--space-2xs) var(--space-xs);
        padding-inline: var(--space-3xs);
      }

      .app-thumb { width: 5.5rem; }

      .app-action {
        grid-column: 2;
        justify-self: start;
        margin-top: calc(-1 * var(--space-3xs));
      }
    }

    /* --- reduced motion: 位置の動きを外し、不透明度のみに落とす --- */

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }

      .app-link:active,
      .category-tab:active,
      .app-link:hover .app-action svg { transform: none; }

      .category-tab::after {
        transform: scaleX(1);
        opacity: 0;
        transition: opacity 150ms linear;
      }

      .category-tab:hover::after,
      .category-tab[aria-current="true"]::after { opacity: 1; }

      .thumb-zoom-preview {
        transform: none;
        filter: none;
        transition: opacity 150ms linear;
      }

      .thumb-zoom-preview.visible { transform: none; }
    }
  </style>
</head>
<body>

<a class="skip-link" href="#main">本文へスキップ</a>

<header class="site-header shell">
  <h1 class="site-title">
    <img class="site-logo" src="assets/logo.svg" alt="ik-neet.com" width="421" height="120" />
  </h1>
  <p class="lead">制作したWebアプリの一覧です。</p>
</header>

${categoryNav}

<main id="main" class="shell">
${sections}
</main>

<footer class="site-footer shell">
  © 2026 ik_neet
</footer>

<div class="thumb-zoom-preview" id="thumbZoomPreview" aria-hidden="true"><img alt="" /></div>

<script>
  (function () {
    var nav = document.getElementById('categoryNav');
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.category-tab'));
    var headings = tabs.map(function (tab) {
      return document.getElementById(tab.getAttribute('href').slice(1));
    });
    var ticking = false;

    function syncScrollState() {
      ticking = false;

      if (nav) {
        nav.setAttribute('data-scrolled', window.scrollY > 4 ? 'true' : 'false');
      }

      if (tabs.length === 0) return;

      var offset = (nav ? nav.getBoundingClientRect().height : 48) + 12;
      var activeIndex = 0;

      for (var i = 0; i < headings.length; i += 1) {
        if (headings[i] && headings[i].getBoundingClientRect().top <= offset) activeIndex = i;
      }

      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        activeIndex = headings.length - 1;
      }

      tabs.forEach(function (tab, index) {
        if (index === activeIndex) tab.setAttribute('aria-current', 'true');
        else tab.removeAttribute('aria-current');
      });
    }

    function requestSync() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(syncScrollState);
    }

    window.addEventListener('scroll', requestSync, { passive: true });
    window.addEventListener('resize', requestSync, { passive: true });
    syncScrollState();

    if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;

    var preview = document.getElementById('thumbZoomPreview');
    var previewImg = preview.querySelector('img');
    var maxPreviewWidth = 420;
    var minPreviewWidth = 160;
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
      var spaceLeft = rect.left - margin * 2;
      var spaceRight = window.innerWidth - rect.right - margin * 2;

      var width;
      var left;
      var origin;

      if (spaceLeft >= minPreviewWidth) {
        width = Math.min(maxPreviewWidth, spaceLeft);
        left = rect.left - width - margin;
        origin = 'right center';
      } else if (spaceRight >= minPreviewWidth) {
        width = Math.min(maxPreviewWidth, spaceRight);
        left = rect.right + margin;
        origin = 'left center';
      } else {
        width = Math.min(maxPreviewWidth, window.innerWidth - margin * 2);
        left = Math.max(margin, (window.innerWidth - width) / 2);
        origin = 'center center';
      }

      var height = width * 9 / 16;
      var top = rect.top + rect.height / 2 - height / 2;
      top = Math.min(Math.max(top, margin), window.innerHeight - height - margin);

      preview.style.width = width + 'px';
      preview.style.height = height + 'px';
      preview.style.left = left + 'px';
      preview.style.top = top + 'px';
      preview.style.transformOrigin = origin;
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

  return `<nav class="category-nav" id="categoryNav" aria-label="カテゴリ">
  <div class="category-nav-track shell">
${tabs}
  </div>
</nav>`;
}

function renderSection(category, apps) {
  const headingId = `${category.id}s-heading`;
  const items = apps.length > 0
    ? `    <ul class="app-items">
${apps.map(renderAppItem).join('\n\n')}
    </ul>`
    : '    <p class="app-empty">このカテゴリのアプリはまだありません。</p>';

  return `  <section class="app-section" aria-labelledby="${headingId}">
    <div class="section-heading ${category.className}">
      <h2 id="${headingId}">${escapeHtml(category.label)}</h2>
      <span class="count">${apps.length}件</span>
    </div>

${items}
  </section>`;
}

function renderAppItem(app) {
  return `      <li class="app-item">
        <a class="app-link" href="${escapeHtml(app.url)}" target="_blank" rel="noopener noreferrer">
          <span class="app-thumb">${renderThumbnail(app)}</span>
          <span class="app-text">
            <strong class="app-title">${escapeHtml(app.title)}</strong>
            <span class="app-description">${escapeHtml(app.description)}</span>
          </span>
          <span class="app-action">開く${arrowIcon()}</span>
        </a>
      </li>`;
}

function arrowIcon() {
  return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M8.5 4l4 4-4 4" /></svg>';
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
