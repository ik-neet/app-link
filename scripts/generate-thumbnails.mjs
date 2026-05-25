import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'assets', 'thumbs');

const apps = [
  {
    slug: 'pin-quiz',
    url: 'https://pin-quiz.ik-neet.com/',
    focus: 'auto',
  },
  {
    slug: 'zennin-icchi',
    url: 'https://zennin-icchi.ik-neet.com/',
    focus: 'auto',
  },
  {
    slug: 'wikipedia-card-battle',
    url: 'https://wikipedia-card-battle.ik-neet.com/',
    focus: 'center',
  },
  {
    slug: 'quiz-battle',
    url: 'https://quiz-battle-9a6fa.web.app/',
    focus: 'center',
  },
  {
    slug: 'talk-theme',
    url: 'https://talk-theme.ik-neet.com/',
    focus: 'auto',
  },
  {
    slug: 'roulette',
    url: 'https://roulette.ik-neet.com/',
    focus: 'center',
  },
  {
    slug: 'warikan',
    url: 'https://warikan.ik-neet.com/',
    focus: 'top',
  },
];

const viewport = {
  width: 1280,
  height: 720,
};

async function main() {
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });

  for (const app of apps) {
    console.log(`Capturing ${app.slug}...`);

    try {
      await page.goto(app.url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await alignPage(page, app.focus);
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
