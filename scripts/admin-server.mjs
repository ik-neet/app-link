import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  addApp,
  addCategory,
  buildIndex,
  generateThumbnails,
  readApps,
  readCategories,
  removeApp,
  reorderApp,
  updateApp,
} from './app-link-tool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const thumbsDir = path.join(projectRoot, 'assets', 'thumbs');
const indexPath = path.join(projectRoot, 'index.html');
const port = Number(process.env.PORT || 8790);
const execFileAsync = promisify(execFile);
const slugPattern = /^[a-z0-9-]+$/;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === 'GET' && url.pathname === '/') {
      redirect(response, '/admin');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/admin') {
      sendHtml(response, renderAdminPage());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/apps') {
      sendJson(response, {
        apps: await readApps(),
        categories: await readCategories(),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/apps') {
      const body = await readJson(request);
      await addApp(body);
      sendJson(response, { ok: true, apps: await readApps() });
      return;
    }

    if (request.method === 'PUT' && url.pathname === '/api/apps/order') {
      const body = await readJson(request);
      const apps = await reorderApp({ slug: body.slug, direction: body.direction });
      sendJson(response, { ok: true, apps });
      return;
    }

    if (request.method === 'PUT' && url.pathname.startsWith('/api/apps/')) {
      const slug = decodeURIComponent(url.pathname.split('/').pop());
      const body = await readJson(request);
      await updateApp({ ...body, slug });
      sendJson(response, { ok: true, apps: await readApps() });
      return;
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/api/apps/')) {
      const slug = decodeURIComponent(url.pathname.split('/').pop());
      await removeApp({ slug });
      sendJson(response, { ok: true, apps: await readApps() });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/categories') {
      sendJson(response, { ok: true, categories: await readCategories() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/categories') {
      const body = await readJson(request);
      await addCategory(body);
      await buildIndex();
      sendJson(response, { ok: true, categories: await readCategories() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/build') {
      await buildIndex();
      sendJson(response, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/thumbnails') {
      const body = await readJson(request);
      await generateThumbnails(body.slug ? { slug: body.slug, url: body.url } : {});
      await buildIndex();
      sendJson(response, { ok: true, apps: await readApps() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/thumbnails/upload') {
      const body = await readJson(request, 10 * 1024 * 1024);
      await uploadThumbnail(body);
      await buildIndex();
      sendJson(response, { ok: true, apps: await readApps() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/refresh') {
      const body = await readJson(request);
      await generateThumbnails(body.slug ? { slug: body.slug, url: body.url } : {});
      await buildIndex();
      sendJson(response, { ok: true, apps: await readApps() });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/git/status') {
      sendJson(response, { ok: true, status: await getGitStatus() });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/git/suggest-message') {
      sendJson(response, { ok: true, message: await suggestCommitMessage() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/git/commit-push') {
      const body = await readJson(request);
      sendJson(response, { ok: true, result: await commitAndPush(body.message) });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/preview') {
      await sendPreview(response);
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
      await sendStatic(response, url.pathname);
      return;
    }

    sendJson(response, { error: 'Not found' }, 404);
  } catch (error) {
    sendJson(response, { error: error.message }, 500);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`App Link Admin: http://127.0.0.1:${port}/admin`);
});

async function readJson(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('リクエスト本文が大きすぎます。');
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function uploadThumbnail(body) {
  const slug = String(body.slug || '');
  const dataUrl = String(body.dataUrl || '');

  if (!slugPattern.test(slug)) {
    throw new Error('slug の形式が不正です。');
  }

  const apps = await readApps();
  if (!apps.some((app) => app.slug === slug)) {
    throw new Error(`slug "${slug}" が見つかりません。`);
  }

  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('画像データの形式が不正です。');
  }

  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length === 0) {
    throw new Error('画像データが空です。');
  }

  await writeFile(path.join(thumbsDir, `${slug}.png`), buffer);
}

async function getGitStatus() {
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const shortStatus = (await runGit(['status', '--short', '--branch'])).trim();
  const changedLines = shortStatus
    .split('\n')
    .filter((line) => line && !line.startsWith('##'));

  return {
    branch,
    clean: changedLines.length === 0,
    text: shortStatus || `## ${branch}`,
  };
}

async function suggestCommitMessage() {
  const statusLines = (await runGit(['status', '--short']).catch(() => ''))
    .split('\n')
    .filter(Boolean);

  const appChanges = await diffApps();
  const thumbCount = statusLines.filter((line) => /assets\/thumbs\/.+\.png$/i.test(line.slice(3))).length;
  const indexChanged = statusLines.some((line) => line.slice(3).trim() === 'index.html');

  const parts = [];

  if (appChanges.added.length > 0) {
    parts.push(`アプリ「${appChanges.added.join('」「')}」を追加`);
  }

  if (appChanges.removed.length > 0) {
    parts.push(`アプリ「${appChanges.removed.join('」「')}」を削除`);
  }

  if (appChanges.changed.length > 0) {
    parts.push(`アプリ「${appChanges.changed.join('」「')}」を更新`);
  }

  if (thumbCount > 0) {
    parts.push(`サムネイル${thumbCount}件を更新`);
  }

  if (parts.length === 0 && indexChanged) {
    parts.push('index.htmlを更新');
  }

  if (parts.length === 0) {
    return '更新：アプリリンクを更新';
  }

  const kind = appChanges.added.length > 0 && appChanges.removed.length === 0 && appChanges.changed.length === 0
    ? '追加'
    : '更新';

  return `${kind}：${parts.join('、')}`;
}

async function diffApps() {
  const empty = { added: [], removed: [], changed: [] };

  let previousApps;
  try {
    const previousText = await runGit(['show', 'HEAD:data/apps.json']);
    previousApps = JSON.parse(previousText);
  } catch {
    return empty;
  }

  let currentApps;
  try {
    currentApps = await readApps();
  } catch {
    return empty;
  }

  const previousMap = new Map(previousApps.map((app) => [app.slug, app]));
  const currentMap = new Map(currentApps.map((app) => [app.slug, app]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [slug, app] of currentMap) {
    if (!previousMap.has(slug)) {
      added.push(app.title || slug);
    }
  }

  for (const [slug, app] of previousMap) {
    if (!currentMap.has(slug)) {
      removed.push(app.title || slug);
    }
  }

  for (const [slug, app] of currentMap) {
    const previous = previousMap.get(slug);
    if (!previous) continue;
    const isDifferent = ['title', 'description', 'url', 'category', 'initial', 'focus']
      .some((field) => previous[field] !== app[field]);
    if (isDifferent) {
      changed.push(app.title || slug);
    }
  }

  return { added, removed, changed };
}

async function commitAndPush(message) {
  const trimmedMessage = String(message || '').trim();

  if (!trimmedMessage) {
    throw new Error('コミットメッセージを入力してください。');
  }

  const beforeStatus = await getGitStatus();

  if (beforeStatus.clean) {
    throw new Error('コミットする変更がありません。');
  }

  await runGit(['add', '-A']);
  const commitOutput = await runGit(['commit', '-m', trimmedMessage]);
  const pushOutput = await runGit(['push', 'origin', beforeStatus.branch]);

  return {
    branch: beforeStatus.branch,
    commit: commitOutput.trim(),
    push: pushOutput.trim(),
    status: await getGitStatus(),
  };
}

async function runGit(args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: projectRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
    });

    return [stdout, stderr].filter(Boolean).join('\n');
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    throw new Error(output);
  }
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

async function sendPreview(response) {
  const html = await readFile(indexPath, 'utf8');
  const busted = html.replace(
    /(assets\/thumbs\/[a-z0-9-]+\.png)(?!\?)/gi,
    (match) => `${match}?ts=${Date.now()}`,
  );

  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(busted);
}

async function sendStatic(response, pathname) {
  const target = path.resolve(projectRoot, `.${pathname}`);

  if (!target.startsWith(projectRoot)) {
    sendJson(response, { error: 'Forbidden' }, 403);
    return;
  }

  await readFile(target);
  response.writeHead(200, {
    'Content-Type': contentType(target),
    'Cache-Control': 'no-store',
  });
  createReadStream(target).pipe(response);
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.svg') return 'image/svg+xml; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.ico') return 'image/x-icon';
  if (extension === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>App Link Admin</title>
  <link rel="icon" href="/assets/icon/icon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/tokens.css" />
  <style>
    /* Hallmark · genre: editorial · macrostructure: Workbench (app surface)
     * nav: N6 masthead toolbar · design-system: DESIGN.md · designed-as-app
     * 色・寸法・イージングは /assets/tokens.css の token のみを参照する。
     */

    *, *::before, *::after { box-sizing: border-box; }

    html { -webkit-text-size-adjust: 100%; }
    html, body { overflow-x: clip; }

    body {
      margin: 0;
      background: var(--color-paper);
      color: var(--color-ink);
      font-family: var(--font-body);
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      letter-spacing: var(--track-body);
      -webkit-font-smoothing: antialiased;
    }

    body[data-busy="true"] { cursor: progress; }

    .shell {
      width: min(var(--page-width), calc(100% - var(--space-lg)));
      margin-inline: auto;
    }

    :where(a, button, input, select, textarea, [tabindex]):focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
      border-radius: var(--radius-sm);
    }

    /* --- masthead: 半透明レイヤーの下をコンテンツが流れる --- */

    .masthead {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--material-chrome);
      backdrop-filter: blur(var(--material-blur)) saturate(180%);
      -webkit-backdrop-filter: blur(var(--material-blur)) saturate(180%);
      box-shadow: inset 0 -1px transparent;
      transition: box-shadow var(--dur-short) var(--ease-out);
    }

    .masthead[data-scrolled="true"] { box-shadow: inset 0 -1px var(--color-rule); }

    .masthead::after {
      content: "";
      position: absolute;
      inset: 100% 0 auto 0;
      height: var(--space-sm);
      background: linear-gradient(to bottom, var(--color-paper), transparent);
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--dur-short) var(--ease-out);
    }

    .masthead[data-scrolled="true"]::after { opacity: 1; }

    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
      flex-wrap: wrap;
      padding-block: var(--space-2xs);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: var(--space-2xs);
      min-width: 0;
    }

    .brand img {
      width: 1.5rem;
      height: 1.5rem;
      display: block;
    }

    h1 {
      margin: 0;
      font-size: var(--text-lg);
      font-weight: 700;
      line-height: var(--leading-heading);
      letter-spacing: var(--track-heading);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3xs);
      justify-content: flex-end;
    }

    /* --- controls --- */

    button, select, input, textarea { font: inherit; }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3xs);
      min-height: 2.25rem;
      padding-inline: var(--space-xs);
      border: var(--rule-hair) solid var(--color-rule-strong);
      border-radius: var(--radius-sm);
      background: var(--color-paper-2);
      color: var(--color-ink);
      font-size: var(--text-xs);
      font-weight: 650;
      letter-spacing: var(--track-small);
      white-space: nowrap;
      cursor: pointer;
      transition: background-color var(--dur-instant) var(--ease-out), border-color var(--dur-instant) var(--ease-out), transform var(--dur-instant) var(--ease-out);
    }

    button:hover { background: var(--color-paper-3); }

    /* フィードバックは pointer-down の瞬間に出す */
    button:active { transform: translateY(1px); }

    button.primary {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: var(--color-accent-ink);
    }

    button.primary:hover { background: color-mix(in oklab, var(--color-accent) 88%, var(--color-ink)); }

    button.danger { color: var(--color-danger); }
    button.danger:hover { background: var(--color-danger-wash); border-color: var(--color-danger); }

    button.quiet {
      border-color: transparent;
      background: transparent;
      color: var(--color-ink-2);
    }

    button.quiet:hover { background: var(--color-paper-3); color: var(--color-ink); }

    button.icon {
      min-width: 2.25rem;
      padding-inline: var(--space-2xs);
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }

    input, select, textarea {
      width: 100%;
      min-height: 2.25rem;
      padding: var(--space-3xs) var(--space-2xs);
      border: var(--rule-hair) solid var(--color-rule-strong);
      border-radius: var(--radius-sm);
      background: var(--color-paper-2);
      color: var(--color-ink);
      font-size: var(--text-sm);
      transition: border-color var(--dur-instant) var(--ease-out);
    }

    input:hover, select:hover, textarea:hover { border-color: var(--color-ink-2); }

    textarea {
      min-height: 4.5rem;
      line-height: var(--leading-body);
      resize: vertical;
    }

    input[type="color"] { padding: 2px; }

    label {
      display: grid;
      gap: var(--space-3xs);
      margin-bottom: var(--space-2xs);
      color: var(--color-ink-2);
      font-size: var(--text-2xs);
      font-weight: 650;
      letter-spacing: var(--track-small);
    }

    /* --- layout --- */

    main { padding-block: var(--space-md) var(--space-xl); }

    .section-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-2xs);
      margin: 0 0 var(--space-2xs);
      padding-bottom: var(--space-3xs);
      border-bottom: var(--rule-hair) solid var(--color-rule);
    }

    h2 {
      margin: 0;
      font-size: var(--text-md);
      font-weight: 700;
      letter-spacing: var(--track-heading);
    }

    .count {
      color: var(--color-ink-2);
      font-size: var(--text-2xs);
      letter-spacing: var(--track-small);
    }

    .app-list { margin-bottom: var(--space-lg); }

    .app-row {
      display: grid;
      grid-template-columns: 7.5rem minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-2xs) var(--space-3xs);
      border-bottom: var(--rule-hair) solid var(--color-rule);
      transition: background-color var(--dur-instant) var(--ease-out);
    }

    .app-row:hover { background: var(--color-paper-3); }

    .thumb {
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
    }

    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .meta { min-width: 0; }

    .meta strong {
      display: block;
      font-size: var(--text-md);
      font-weight: 700;
      line-height: var(--leading-tight);
      letter-spacing: var(--track-heading);
      overflow-wrap: anywhere;
    }

    .meta .desc {
      display: block;
      margin-top: 0.125rem;
      color: var(--color-ink-2);
      font-size: var(--text-xs);
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .url {
      margin-top: 0.125rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--color-ink-2);
      font-family: var(--font-mono);
      font-size: var(--text-2xs);
    }

    .row-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3xs);
      justify-content: flex-end;
    }

    .status {
      min-height: 1.5rem;
      margin: var(--space-2xs) 0 0;
      color: var(--color-ink-2);
      font-size: var(--text-xs);
    }

    .status.error {
      color: var(--color-danger);
      font-weight: 700;
    }

    .git-status {
      min-height: 4.5rem;
      max-height: 11rem;
      overflow: auto;
      margin: var(--space-2xs) 0;
      padding: var(--space-2xs);
      border: var(--rule-hair) solid var(--color-rule);
      border-radius: var(--radius-sm);
      background: var(--color-paper-3);
      color: var(--color-ink-2);
      font-family: var(--font-mono);
      font-size: var(--text-2xs);
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .preview-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2xs);
      margin-bottom: var(--space-2xs);
    }

    iframe {
      width: 100%;
      height: 26rem;
      border: var(--rule-hair) solid var(--color-rule);
      border-radius: var(--radius-md);
      background: var(--color-paper-2);
      box-shadow: var(--shadow-lift);
    }

    /* --- more menu: トリガー起点で開く --- */

    .menu-wrap { position: relative; }

    .menu {
      position: absolute;
      top: calc(100% + var(--space-3xs));
      right: 0;
      z-index: 30;
      display: flex;
      flex-direction: column;
      gap: var(--space-3xs);
      min-width: 11rem;
      padding: var(--space-3xs);
      border: var(--rule-hair) solid var(--color-rule);
      border-radius: var(--radius-md);
      background: var(--material-float);
      backdrop-filter: blur(var(--material-blur));
      -webkit-backdrop-filter: blur(var(--material-blur));
      box-shadow: var(--shadow-float);
      transform-origin: top right;
      animation: material-in var(--dur-short) var(--ease-out);
    }

    .menu[hidden] { display: none; }

    .menu button { justify-content: flex-start; }

    /* --- dialogs --- */

    dialog {
      width: min(33rem, calc(100vw - var(--space-lg)));
      max-height: calc(100vh - var(--space-xl));
      overflow: auto;
      padding: 0;
      border: var(--rule-hair) solid var(--color-rule);
      border-radius: var(--radius-lg);
      background: var(--color-paper-2);
      color: var(--color-ink);
      box-shadow: var(--shadow-float);
    }

    dialog[open] { animation: material-in var(--dur-medium) var(--ease-out); }

    dialog::backdrop {
      background: var(--scrim);
      backdrop-filter: blur(2px);
    }

    @keyframes material-in {
      from { opacity: 0; transform: scale(0.96); filter: blur(4px); }
      to { opacity: 1; transform: scale(1); filter: blur(0); }
    }

    .modal-inner { padding: var(--space-2xs) var(--space-md) var(--space-md); }

    .modal-close-row {
      display: flex;
      justify-content: flex-end;
    }

    .modal-title {
      margin: 0 0 var(--space-sm);
      font-size: var(--text-lg);
      font-weight: 700;
      letter-spacing: var(--track-heading);
      overflow-wrap: anywhere;
    }

    dialog.git-dialog { width: min(35rem, calc(100vw - var(--space-lg))); }
    dialog.image-editor-dialog { width: min(40rem, calc(100vw - var(--space-lg))); }

    .form-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-2xs);
      margin-top: var(--space-sm);
    }

    /* --- thumbnail tools --- */

    .thumb-preview-row {
      display: flex;
      align-items: flex-start;
      gap: var(--space-sm);
      margin-bottom: var(--space-sm);
    }

    .thumb-preview {
      width: 10rem;
      aspect-ratio: 16 / 9;
      display: grid;
      place-items: center;
      overflow: hidden;
      flex: none;
      border: var(--rule-hair) solid var(--color-rule);
      border-radius: var(--radius-sm);
      background: var(--color-paper-3);
      color: var(--color-accent);
      font-size: var(--text-2xl);
      font-weight: 700;
    }

    .thumb-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .thumb-tools {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      flex: 1;
      min-width: 0;
    }

    .thumb-tools input[type="file"] {
      padding: var(--space-3xs);
      border-style: dashed;
    }

    .thumb-tools .hint {
      margin: 0;
      color: var(--color-ink-2);
      font-size: var(--text-2xs);
      line-height: 1.5;
    }

    .thumb-tools .thumb-tool-row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3xs);
    }

    .app-row.is-hidden .thumb,
    .app-row.is-hidden .meta { opacity: 0.5; }

    .badge-hidden {
      display: inline-block;
      margin-left: var(--space-3xs);
      padding: 0 var(--space-2xs);
      border-radius: var(--radius-pill);
      background: color-mix(in oklab, var(--color-ink) 10%, transparent);
      color: var(--color-ink-2);
      font-size: var(--text-2xs);
      font-weight: 650;
      vertical-align: middle;
    }

    /* --- image editor --- */

    .editor-canvas-wrap {
      display: flex;
      justify-content: center;
      margin-bottom: var(--space-2xs);
      padding: var(--space-2xs);
      border: var(--rule-hair) solid var(--color-rule);
      border-radius: var(--radius-sm);
      background: repeating-conic-gradient(var(--color-paper-3) 0% 25%, var(--color-paper-2) 0% 50%) 0 0 / 20px 20px;
    }

    #editorCanvas {
      max-width: 100%;
      cursor: crosshair;
      touch-action: none;
    }

    .editor-controls {
      display: grid;
      gap: var(--space-2xs);
      margin-bottom: var(--space-2xs);
    }

    .editor-controls label {
      display: grid;
      grid-template-columns: 5rem minmax(0, 1fr);
      align-items: center;
      gap: var(--space-2xs);
      margin-bottom: 0;
    }

    .editor-controls input[type="range"] {
      width: 100%;
      min-height: 0;
      padding: 0;
      border: 0;
      background: transparent;
      accent-color: var(--color-accent);
    }

    /* --- narrow --- */

    @media (max-width: 40rem) {
      .shell { width: calc(100% - var(--space-md)); }

      .bar {
        flex-direction: column;
        align-items: stretch;
      }

      .actions { justify-content: flex-start; }

      .app-row { grid-template-columns: 5.5rem minmax(0, 1fr); }

      .thumb { width: 5.5rem; }

      .row-actions {
        grid-column: 1 / -1;
        justify-content: flex-start;
      }

      .thumb-preview-row { flex-direction: column; }

      .form-actions { grid-template-columns: 1fr; }
    }

    @media (prefers-reduced-motion: reduce) {
      button:active { transform: none; }

      dialog[open], .menu { animation: fade-in 150ms linear; }

      @keyframes fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    }
  </style>
</head>
<body>
  <header class="masthead" id="masthead">
    <div class="bar shell">
      <div class="brand">
        <img src="/assets/icon/icon.svg" alt="" width="24" height="24" />
        <h1>App Link Admin</h1>
      </div>
      <div class="actions">
        <button id="reloadButton" class="quiet">再読み込み</button>
        <button id="addCategoryButton">カテゴリ追加</button>
        <button id="addButton">新規追加</button>
        <button id="githubButton" class="primary">GitHub反映</button>
        <div class="menu-wrap">
          <button id="moreMenuButton" class="icon" aria-haspopup="true" aria-expanded="false" aria-label="その他の操作">…</button>
          <div id="moreMenu" class="menu" hidden>
            <button id="thumbsButton" class="quiet">全サムネイル生成</button>
            <button id="refreshButton" class="quiet">全更新</button>
          </div>
        </div>
      </div>
    </div>
  </header>

  <main class="shell">
    <p id="globalStatus" class="status" role="status" aria-live="polite"></p>
    <section>
      <div id="lists"></div>

      <div class="preview-heading">
        <h2>プレビュー</h2>
        <button id="previewButton" class="quiet">更新</button>
      </div>
      <iframe id="preview" src="/preview" title="トップページのプレビュー"></iframe>
    </section>
  </main>

  <dialog id="appDialog">
    <div class="modal-inner">
      <div class="modal-close-row">
        <button type="button" id="appDialogCloseTop" class="quiet icon" aria-label="閉じる">×</button>
      </div>
      <h2 class="modal-title" id="appDialogTitle">新規追加</h2>

      <div id="thumbSection" hidden>
        <p id="thumbNewHint" class="status" hidden>「撮影」を行うと先にアプリが保存されます。画像選択・貼り付け・編集は「保存」を押すまで確定しません。</p>
        <div class="thumb-preview-row">
          <div class="thumb-preview" id="thumbPreview">-</div>
          <div class="thumb-tools">
            <label>画像を選択
              <input type="file" id="thumbFileInput" accept="image/*" />
            </label>
            <p class="hint">この欄にフォーカスした状態で Ctrl+V すると、クリップボードの画像を貼り付けられます。</p>
            <label>撮影用URL（任意・空欄で通常のURLを使用）
              <input type="url" id="captureUrlInput" placeholder="https://example.com/some-page" />
            </label>
            <div class="thumb-tool-row">
              <button type="button" id="captureButton">撮影</button>
              <button type="button" id="thumbEditButton">画像を編集</button>
              <button type="button" id="thumbRevertButton" class="quiet" hidden>元に戻す</button>
            </div>
          </div>
        </div>
      </div>

      <form id="appForm">
        <label>slug
          <input name="slug" required pattern="[a-z0-9-]+" placeholder="sample-app" />
        </label>
        <label>カテゴリ
          <select name="category" id="categorySelect" required></select>
        </label>
        <label>タイトル
          <input name="title" required />
        </label>
        <label>説明
          <textarea name="description" required></textarea>
        </label>
        <label>URL
          <input name="url" required type="url" placeholder="https://example.com/" />
        </label>
        <label>代替文字
          <input name="initial" required maxlength="2" />
        </label>
        <label>撮影位置
          <input name="focus" required value="auto" placeholder="auto / top / center / CSS selector" />
        </label>
        <div class="form-actions">
          <button type="button" id="appDialogCancel">キャンセル</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>
      <p id="appDialogStatus" class="status" role="status" aria-live="polite"></p>
    </div>
  </dialog>

  <dialog id="categoryDialog">
    <div class="modal-inner">
      <div class="modal-close-row">
        <button type="button" id="categoryDialogCloseTop" class="quiet icon" aria-label="閉じる">×</button>
      </div>
      <h2 class="modal-title">カテゴリ追加</h2>

      <form id="categoryForm">
        <label>id
          <input name="id" required pattern="[a-z0-9-]+" placeholder="example" />
        </label>
        <label>label
          <input name="label" required placeholder="表示名" />
        </label>
        <label>color（任意）
          <input name="color" type="color" value="#146c94" />
        </label>
        <div class="form-actions">
          <button type="button" id="categoryDialogCancel">キャンセル</button>
          <button type="submit" class="primary">追加</button>
        </div>
      </form>
      <p id="categoryDialogStatus" class="status" role="status" aria-live="polite"></p>
    </div>
  </dialog>

  <dialog id="githubDialog" class="git-dialog">
    <div class="modal-inner">
      <div class="modal-close-row">
        <button type="button" id="githubDialogCloseTop" class="quiet icon" aria-label="閉じる">×</button>
      </div>
      <h2 class="modal-title">GitHub反映</h2>

      <label>コミットメッセージ
        <input id="commitMessage" value="更新：アプリリンクを更新" />
      </label>
      <div class="form-actions">
        <button type="button" id="gitStatusButton">状態確認</button>
        <button type="button" id="commitPushButton" class="primary">コミットしてpush</button>
      </div>
      <pre id="gitStatus" class="git-status">未確認</pre>
      <p id="githubDialogStatus" class="status" role="status" aria-live="polite"></p>
    </div>
  </dialog>

  <dialog id="imageEditorDialog" class="image-editor-dialog">
    <div class="modal-inner">
      <div class="modal-close-row">
        <button type="button" id="editorCloseTop" class="quiet icon" aria-label="閉じる">×</button>
      </div>
      <h2 class="modal-title">サムネイル編集</h2>

      <div class="editor-canvas-wrap">
        <canvas id="editorCanvas"></canvas>
      </div>

      <div class="editor-controls">
        <label>明るさ <input type="range" id="editBrightness" min="-100" max="100" value="0" /></label>
        <label>コントラスト <input type="range" id="editContrast" min="-100" max="100" value="0" /></label>
        <label>彩度 <input type="range" id="editSaturation" min="-100" max="100" value="0" /></label>
      </div>

      <div class="form-actions">
        <button type="button" id="editorResetButton">リセット</button>
        <button type="button" id="editorCancelButton">キャンセル</button>
      </div>
      <div class="form-actions">
        <button type="button" id="editorApplyButton" class="primary" style="grid-column: 1 / -1;">この内容を反映</button>
      </div>
      <p id="editorStatus" class="status" role="status" aria-live="polite"></p>
    </div>
  </dialog>

  <script>
    const lists = document.querySelector('#lists');
    const preview = document.querySelector('#preview');
    const masthead = document.querySelector('#masthead');

    const appDialog = document.querySelector('#appDialog');
    const appDialogTitle = document.querySelector('#appDialogTitle');
    const appDialogStatus = document.querySelector('#appDialogStatus');
    const appForm = document.querySelector('#appForm');
    const categorySelect = document.querySelector('#categorySelect');
    const thumbSection = document.querySelector('#thumbSection');
    const thumbNewHint = document.querySelector('#thumbNewHint');
    const thumbPreview = document.querySelector('#thumbPreview');
    const thumbFileInput = document.querySelector('#thumbFileInput');
    const captureUrlInput = document.querySelector('#captureUrlInput');
    const thumbEditButton = document.querySelector('#thumbEditButton');
    const thumbRevertButton = document.querySelector('#thumbRevertButton');

    const categoryDialog = document.querySelector('#categoryDialog');
    const categoryDialogStatus = document.querySelector('#categoryDialogStatus');
    const categoryForm = document.querySelector('#categoryForm');

    const githubDialog = document.querySelector('#githubDialog');
    const githubDialogStatus = document.querySelector('#githubDialogStatus');
    const commitMessageInput = document.querySelector('#commitMessage');

    const moreMenuButton = document.querySelector('#moreMenuButton');
    const moreMenu = document.querySelector('#moreMenu');

    const imageEditorDialog = document.querySelector('#imageEditorDialog');
    const editorCanvas = document.querySelector('#editorCanvas');
    const editorStatus = document.querySelector('#editorStatus');
    const editBrightness = document.querySelector('#editBrightness');
    const editContrast = document.querySelector('#editContrast');
    const editSaturation = document.querySelector('#editSaturation');

    let apps = [];
    let categories = [];
    let editingSlug = null;
    let editorState = null;
    let pendingThumbnailDataUrl = null;

    window.addEventListener('scroll', () => {
      masthead.setAttribute('data-scrolled', window.scrollY > 4 ? 'true' : 'false');
    }, { passive: true });

    document.querySelector('#reloadButton').addEventListener('click', loadApps);
    document.querySelector('#thumbsButton').addEventListener('click', () => {
      closeMoreMenu();
      runAction('/api/thumbnails', {}, '全サムネイルを生成しました。');
    });
    document.querySelector('#refreshButton').addEventListener('click', () => {
      closeMoreMenu();
      runAction('/api/refresh', {}, '全更新しました。');
    });
    document.querySelector('#previewButton').addEventListener('click', refreshPreview);

    moreMenuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const isHidden = moreMenu.hidden;
      moreMenu.hidden = !isHidden;
      moreMenuButton.setAttribute('aria-expanded', String(isHidden));
    });
    document.addEventListener('click', closeMoreMenu);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !moreMenu.hidden) closeMoreMenu();
    });

    function closeMoreMenu() {
      moreMenu.hidden = true;
      moreMenuButton.setAttribute('aria-expanded', 'false');
    }

    document.querySelector('#addButton').addEventListener('click', openAddDialog);
    document.querySelector('#appDialogCancel').addEventListener('click', () => appDialog.close());
    document.querySelector('#appDialogCloseTop').addEventListener('click', () => appDialog.close());
    appDialog.addEventListener('click', (event) => {
      if (event.target === appDialog) appDialog.close();
    });

    document.querySelector('#addCategoryButton').addEventListener('click', openCategoryDialog);
    document.querySelector('#categoryDialogCancel').addEventListener('click', () => categoryDialog.close());
    document.querySelector('#categoryDialogCloseTop').addEventListener('click', () => categoryDialog.close());
    categoryDialog.addEventListener('click', (event) => {
      if (event.target === categoryDialog) categoryDialog.close();
    });

    document.querySelector('#githubButton').addEventListener('click', openGithubDialog);
    document.querySelector('#githubDialogCloseTop').addEventListener('click', () => githubDialog.close());
    githubDialog.addEventListener('click', (event) => {
      if (event.target === githubDialog) githubDialog.close();
    });
    document.querySelector('#gitStatusButton').addEventListener('click', () => loadGitStatus());
    document.querySelector('#commitPushButton').addEventListener('click', commitAndPush);

    document.querySelector('#captureButton').addEventListener('click', captureThumbnail);
    thumbFileInput.addEventListener('change', handleThumbFileChange);
    thumbEditButton.addEventListener('click', openEditorForCurrentThumbnail);
    thumbRevertButton.addEventListener('click', revertPendingThumbnail);

    document.addEventListener('paste', async (event) => {
      if (!appDialog.open) return;
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;

      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          event.preventDefault();
          try {
            const dataUrl = await readFileAsDataUrl(file);
            openImageEditor(dataUrl, stageEditedThumbnail);
          } catch (error) {
            setDialogStatus(appDialogStatus, error.message, true);
          }
          return;
        }
      }
    });

    document.querySelector('#editorCloseTop').addEventListener('click', () => imageEditorDialog.close());
    document.querySelector('#editorCancelButton').addEventListener('click', () => imageEditorDialog.close());
    document.querySelector('#editorResetButton').addEventListener('click', resetEditorAdjustments);
    document.querySelector('#editorApplyButton').addEventListener('click', applyImageEditor);
    imageEditorDialog.addEventListener('click', (event) => {
      if (event.target === imageEditorDialog) imageEditorDialog.close();
    });
    [editBrightness, editContrast, editSaturation].forEach((input) => {
      input.addEventListener('input', drawEditor);
    });

    categoryForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(categoryForm).entries());
      await request('/api/categories', { method: 'POST', body: payload }, { statusEl: categoryDialogStatus });
      setStatus('カテゴリを追加しました。');
      categoryDialog.close();
      await loadApps();
      refreshPreview();
    });

    appForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(appForm).entries());
      const endpoint = editingSlug ? '/api/apps/' + encodeURIComponent(editingSlug) : '/api/apps';
      const method = editingSlug ? 'PUT' : 'POST';
      await request(endpoint, { method, body: payload }, { statusEl: appDialogStatus });
      const savedSlug = editingSlug || payload.slug;

      if (pendingThumbnailDataUrl) {
        await request('/api/thumbnails/upload', {
          method: 'POST',
          body: { slug: savedSlug, dataUrl: pendingThumbnailDataUrl },
        }, { statusEl: appDialogStatus });
        pendingThumbnailDataUrl = null;
      }

      setStatus(editingSlug ? '更新しました。' : '追加しました。');
      appDialog.close();
      await loadApps();
      refreshPreview();
    });

    async function loadApps() {
      const data = await request('/api/apps');
      apps = data.apps;
      categories = data.categories;
      renderCategoryOptions();
      renderLists();
      setStatus('読み込みました。');
    }

    function renderCategoryOptions() {
      const previousValue = categorySelect.value;
      categorySelect.innerHTML = categories
        .map((category) => \`<option value="\${escapeHtml(category.id)}">\${escapeHtml(category.label)}</option>\`)
        .join('');
      if (previousValue && categories.some((category) => category.id === previousValue)) {
        categorySelect.value = previousValue;
      }
    }

    function renderLists() {
      lists.innerHTML = categories.map((category) => {
        const categoryApps = apps.filter((app) => app.category === category.id);
        return \`
          <section>
            <div class="section-title">
              <h2>\${escapeHtml(category.label)}</h2>
              <span class="count">\${categoryApps.length}件</span>
            </div>
            <div class="app-list">
              \${categoryApps.map((app, index) => renderRow(app, index === 0, index === categoryApps.length - 1)).join('')}
            </div>
          </section>
        \`;
      }).join('');

      lists.querySelectorAll('.thumb img').forEach((img) => {
        img.addEventListener('error', () => {
          const holder = img.parentElement;
          if (holder) holder.textContent = img.dataset.fallback || '-';
        });
      });

      lists.querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => openEditDialog(button.dataset.edit));
      });

      lists.querySelectorAll('[data-thumbnail]').forEach((button) => {
        button.addEventListener('click', () => captureRowThumbnail(button.dataset.thumbnail));
      });

      lists.querySelectorAll('[data-visibility]').forEach((button) => {
        button.addEventListener('click', () => toggleVisibility(button.dataset.visibility));
      });

      lists.querySelectorAll('[data-remove]').forEach((button) => {
        button.addEventListener('click', async () => {
          const slug = button.dataset.remove;
          if (!confirm(slug + ' を削除しますか？')) return;
          await request('/api/apps/' + encodeURIComponent(slug), { method: 'DELETE' });
          setStatus('削除しました。');
          await loadApps();
          refreshPreview();
        });
      });

      lists.querySelectorAll('[data-move-up]').forEach((button) => {
        button.addEventListener('click', () => moveApp(button.dataset.moveUp, 'up'));
      });

      lists.querySelectorAll('[data-move-down]').forEach((button) => {
        button.addEventListener('click', () => moveApp(button.dataset.moveDown, 'down'));
      });
    }

    async function captureRowThumbnail(slug) {
      const app = apps.find((item) => item.slug === slug);
      const input = window.prompt('撮影するURL（空欄で通常のURLを使用）', app ? app.url : '');
      if (input === null) return;
      const overrideUrl = input.trim();
      const body = overrideUrl ? { slug, url: overrideUrl } : { slug };
      await runAction('/api/thumbnails', body, 'サムネイルを生成しました。');
    }

    async function toggleVisibility(slug) {
      const app = apps.find((item) => item.slug === slug);
      if (!app) return;
      await request('/api/apps/' + encodeURIComponent(slug), { method: 'PUT', body: { hidden: !app.hidden } });
      setStatus(app.hidden ? '表示にしました。' : '非表示にしました。');
      await loadApps();
      refreshPreview();
    }

    async function moveApp(slug, direction) {
      await request('/api/apps/order', { method: 'PUT', body: { slug, direction } });
      setStatus('並び順を変更しました。');
      await loadApps();
      refreshPreview();
    }

    function renderRow(app, isFirst, isLast) {
      const thumbSrc = '/assets/thumbs/' + encodeURIComponent(app.slug) + '.png?ts=' + Date.now();
      const hiddenBadge = app.hidden ? '<span class="badge-hidden">非表示</span>' : '';
      return \`
        <div class="app-row \${app.hidden ? 'is-hidden' : ''}">
          <div class="thumb"><img src="\${thumbSrc}" alt="" data-fallback="\${escapeHtml(app.initial)}"></div>
          <div class="meta">
            <strong>\${escapeHtml(app.title)}\${hiddenBadge}</strong>
            <span class="desc">\${escapeHtml(app.description)}</span>
            <div class="url">\${escapeHtml(app.url)}</div>
          </div>
          <div class="row-actions">
            <button class="icon quiet" data-move-up="\${escapeHtml(app.slug)}" \${isFirst ? 'disabled' : ''} aria-label="上へ移動">▲</button>
            <button class="icon quiet" data-move-down="\${escapeHtml(app.slug)}" \${isLast ? 'disabled' : ''} aria-label="下へ移動">▼</button>
            <button data-edit="\${escapeHtml(app.slug)}">編集</button>
            <button data-thumbnail="\${escapeHtml(app.slug)}">撮影</button>
            <button class="quiet" data-visibility="\${escapeHtml(app.slug)}">\${app.hidden ? '表示する' : '非表示にする'}</button>
            <button class="danger" data-remove="\${escapeHtml(app.slug)}">削除</button>
          </div>
        </div>
      \`;
    }

    function openAddDialog() {
      editingSlug = null;
      appForm.reset();
      appForm.elements.focus.value = 'auto';
      appForm.elements.slug.disabled = false;
      appDialogTitle.textContent = '新規追加';
      thumbSection.hidden = false;
      thumbNewHint.hidden = false;
      thumbFileInput.value = '';
      captureUrlInput.value = '';
      thumbPreview.innerHTML = '';
      thumbPreview.textContent = '-';
      pendingThumbnailDataUrl = null;
      thumbRevertButton.hidden = true;
      setDialogStatus(appDialogStatus, '');
      appDialog.showModal();
    }

    function openEditDialog(slug) {
      const app = apps.find((item) => item.slug === slug);
      if (!app) return;

      editingSlug = slug;
      appForm.reset();
      for (const [key, value] of Object.entries(app)) {
        if (appForm.elements[key]) appForm.elements[key].value = value;
      }
      appForm.elements.slug.disabled = true;
      appDialogTitle.textContent = '編集：' + app.title;
      thumbSection.hidden = false;
      thumbNewHint.hidden = true;
      thumbFileInput.value = '';
      captureUrlInput.value = '';
      pendingThumbnailDataUrl = null;
      thumbRevertButton.hidden = true;
      updateThumbPreview(app);
      setDialogStatus(appDialogStatus, '');
      appDialog.showModal();
    }

    function openCategoryDialog() {
      categoryForm.reset();
      setDialogStatus(categoryDialogStatus, '');
      categoryDialog.showModal();
    }

    function updateThumbPreview(app) {
      thumbPreview.innerHTML = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = '/assets/thumbs/' + encodeURIComponent(app.slug) + '.png?ts=' + Date.now();
      img.onerror = () => {
        thumbPreview.innerHTML = '';
        thumbPreview.textContent = app.initial;
      };
      thumbPreview.appendChild(img);
    }

    async function ensureSavedForThumbnail() {
      if (editingSlug) return editingSlug;

      if (!appForm.reportValidity()) {
        throw new Error('必須項目を入力してください。');
      }

      const payload = Object.fromEntries(new FormData(appForm).entries());
      await request('/api/apps', { method: 'POST', body: payload }, { statusEl: appDialogStatus });

      editingSlug = payload.slug;
      appForm.elements.slug.disabled = true;
      appDialogTitle.textContent = '編集：' + payload.title;
      thumbNewHint.hidden = true;
      await loadApps();

      return editingSlug;
    }

    async function handleThumbFileChange(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;

      try {
        const dataUrl = await readFileAsDataUrl(file);
        openImageEditor(dataUrl, stageEditedThumbnail);
      } catch (error) {
        setDialogStatus(appDialogStatus, error.message, true);
      } finally {
        thumbFileInput.value = '';
      }
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
    }

    function openEditorForCurrentThumbnail() {
      const img = thumbPreview.querySelector('img');
      if (!img) {
        setDialogStatus(appDialogStatus, '編集できるサムネイル画像がありません。先に撮影するか画像を選択してください。', true);
        return;
      }
      openImageEditor(img.src, stageEditedThumbnail);
    }

    function stageEditedThumbnail(dataUrl) {
      pendingThumbnailDataUrl = dataUrl;
      thumbPreview.innerHTML = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = dataUrl;
      thumbPreview.appendChild(img);
      thumbRevertButton.hidden = false;
      setDialogStatus(appDialogStatus, '画像を変更しました。「保存」を押すと確定します。');
    }

    function revertPendingThumbnail() {
      pendingThumbnailDataUrl = null;
      thumbRevertButton.hidden = true;
      const app = editingSlug && apps.find((item) => item.slug === editingSlug);
      if (app) {
        updateThumbPreview(app);
      } else {
        thumbPreview.innerHTML = '';
        thumbPreview.textContent = '-';
      }
      setDialogStatus(appDialogStatus, '元に戻しました。');
    }

    async function captureThumbnail() {
      try {
        const slug = await ensureSavedForThumbnail();
        setDialogStatus(appDialogStatus, '撮影中...');
        const overrideUrl = captureUrlInput.value.trim();
        const body = overrideUrl ? { slug, url: overrideUrl } : { slug };
        await request('/api/refresh', { method: 'POST', body }, { statusEl: appDialogStatus });
        pendingThumbnailDataUrl = null;
        thumbRevertButton.hidden = true;
        await loadApps();
        const app = apps.find((item) => item.slug === slug);
        if (app) updateThumbPreview(app);
        refreshPreview();
        setDialogStatus(appDialogStatus, '撮影しました。');
      } catch (error) {
        setDialogStatus(appDialogStatus, error.message, true);
      }
    }

    function openImageEditor(imageSrc, onApply) {
      const image = new Image();
      image.onload = () => {
        const maxWidth = 560;
        const maxHeight = 360;
        const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
        const displayWidth = Math.max(1, Math.round(image.naturalWidth * ratio));
        const displayHeight = Math.max(1, Math.round(image.naturalHeight * ratio));

        editorCanvas.width = displayWidth;
        editorCanvas.height = displayHeight;

        editorState = {
          image,
          scale: displayWidth / image.naturalWidth,
          crop: { x: 0, y: 0, w: displayWidth, h: displayHeight },
          dragMode: null,
          dragStart: null,
          cropStart: null,
          onApply,
        };

        resetEditorAdjustments();
        setDialogStatus(editorStatus, '');
        imageEditorDialog.showModal();
      };
      image.onerror = () => {
        setDialogStatus(appDialogStatus, '画像の読み込みに失敗しました。', true);
      };
      image.src = imageSrc;
    }

    function resetEditorAdjustments() {
      editBrightness.value = '0';
      editContrast.value = '0';
      editSaturation.value = '0';
      if (editorState) {
        editorState.crop = { x: 0, y: 0, w: editorCanvas.width, h: editorCanvas.height };
      }
      drawEditor();
    }

    function currentEditorFilter() {
      const brightness = 1 + Number(editBrightness.value) / 100;
      const contrast = 1 + Number(editContrast.value) / 100;
      const saturation = 1 + Number(editSaturation.value) / 100;
      return \`brightness(\${brightness}) contrast(\${contrast}) saturate(\${saturation})\`;
    }

    function readCssColor(name, fallback) {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    }

    function drawEditor() {
      if (!editorState) return;
      const ctx = editorCanvas.getContext('2d');
      const { image, crop } = editorState;
      const w = editorCanvas.width;
      const h = editorCanvas.height;

      ctx.save();
      ctx.filter = currentEditorFilter();
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
      ctx.restore();

      ctx.fillStyle = 'rgba(15, 23, 32, 0.5)';
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.beginPath();
      ctx.rect(crop.x, crop.y, crop.w, crop.h);
      ctx.clip();
      ctx.filter = currentEditorFilter();
      ctx.drawImage(image, 0, 0, w, h);
      ctx.restore();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(crop.x + 0.75, crop.y + 0.75, Math.max(0, crop.w - 1.5), Math.max(0, crop.h - 1.5));

      const handleSize = 10;
      const corners = [
        [crop.x, crop.y],
        [crop.x + crop.w, crop.y],
        [crop.x, crop.y + crop.h],
        [crop.x + crop.w, crop.y + crop.h],
      ];
      ctx.fillStyle = readCssColor('--color-accent', '#146c94');
      corners.forEach(([px, py]) => {
        ctx.fillRect(px - handleSize / 2, py - handleSize / 2, handleSize, handleSize);
      });
    }

    function getCanvasPos(event) {
      const rect = editorCanvas.getBoundingClientRect();
      const scaleX = editorCanvas.width / rect.width;
      const scaleY = editorCanvas.height / rect.height;
      return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      };
    }

    function hitTestHandle(pos, crop) {
      const tolerance = 12;
      const corners = {
        nw: { x: crop.x, y: crop.y },
        ne: { x: crop.x + crop.w, y: crop.y },
        sw: { x: crop.x, y: crop.y + crop.h },
        se: { x: crop.x + crop.w, y: crop.y + crop.h },
      };
      for (const [name, point] of Object.entries(corners)) {
        if (Math.abs(pos.x - point.x) <= tolerance && Math.abs(pos.y - point.y) <= tolerance) {
          return name;
        }
      }
      return null;
    }

    function pointInCrop(pos, crop) {
      return pos.x >= crop.x && pos.x <= crop.x + crop.w && pos.y >= crop.y && pos.y <= crop.y + crop.h;
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function resizeCrop(handle, dx, dy, cropStart, canvasWidth, canvasHeight) {
      const minSize = 20;
      let { x, y, w, h } = cropStart;

      if (handle.includes('n')) {
        const newY = clamp(y + dy, 0, y + h - minSize);
        h = y + h - newY;
        y = newY;
      }
      if (handle.includes('s')) {
        h = clamp(h + dy, minSize, canvasHeight - y);
      }
      if (handle.includes('w')) {
        const newX = clamp(x + dx, 0, x + w - minSize);
        w = x + w - newX;
        x = newX;
      }
      if (handle.includes('e')) {
        w = clamp(w + dx, minSize, canvasWidth - x);
      }

      return { x, y, w, h };
    }

    /* ドラッグは Pointer Events + setPointerCapture で 1:1 に追従させる
       （キャンバス外へ出ても掴んだままになる／タッチでも動く） */
    editorCanvas.addEventListener('pointerdown', (event) => {
      if (!editorState) return;
      const pos = getCanvasPos(event);
      const handle = hitTestHandle(pos, editorState.crop);

      if (handle) {
        editorState.dragMode = 'resize:' + handle;
      } else if (pointInCrop(pos, editorState.crop)) {
        editorState.dragMode = 'move';
      } else {
        return;
      }

      editorCanvas.setPointerCapture(event.pointerId);
      editorState.pointerId = event.pointerId;
      editorState.dragStart = pos;
      editorState.cropStart = { ...editorState.crop };
    });

    editorCanvas.addEventListener('pointermove', (event) => {
      if (!editorState || !editorState.dragMode) return;
      if (editorState.pointerId !== undefined && event.pointerId !== editorState.pointerId) return;

      const pos = getCanvasPos(event);
      const dx = pos.x - editorState.dragStart.x;
      const dy = pos.y - editorState.dragStart.y;
      const w = editorCanvas.width;
      const h = editorCanvas.height;

      if (editorState.dragMode === 'move') {
        const { x: startX, y: startY, w: cw, h: ch } = editorState.cropStart;
        editorState.crop = {
          x: clamp(startX + dx, 0, w - cw),
          y: clamp(startY + dy, 0, h - ch),
          w: cw,
          h: ch,
        };
      } else {
        const handle = editorState.dragMode.split(':')[1];
        editorState.crop = resizeCrop(handle, dx, dy, editorState.cropStart, w, h);
      }

      drawEditor();
    });

    function endEditorDrag(event) {
      if (!editorState) return;
      if (editorState.pointerId !== undefined && editorCanvas.hasPointerCapture(editorState.pointerId)) {
        editorCanvas.releasePointerCapture(editorState.pointerId);
      }
      editorState.dragMode = null;
      editorState.pointerId = undefined;
    }

    editorCanvas.addEventListener('pointerup', endEditorDrag);
    editorCanvas.addEventListener('pointercancel', endEditorDrag);

    function applyImageEditor() {
      if (!editorState) return;
      const { image, crop, scale, onApply } = editorState;
      const natural = {
        x: crop.x / scale,
        y: crop.y / scale,
        w: crop.w / scale,
        h: crop.h / scale,
      };

      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = Math.max(1, Math.round(natural.w));
      outputCanvas.height = Math.max(1, Math.round(natural.h));
      const ctx = outputCanvas.getContext('2d');
      ctx.filter = currentEditorFilter();
      ctx.drawImage(image, natural.x, natural.y, natural.w, natural.h, 0, 0, outputCanvas.width, outputCanvas.height);

      const dataUrl = outputCanvas.toDataURL('image/png');
      imageEditorDialog.close();
      onApply(dataUrl);
    }

    async function openGithubDialog() {
      setDialogStatus(githubDialogStatus, '');
      githubDialog.showModal();
      await loadGitStatus({ silent: true });
      await loadSuggestedMessage();
    }

    async function loadSuggestedMessage() {
      try {
        const data = await request('/api/git/suggest-message', { silent: true });
        commitMessageInput.value = data.message;
      } catch (error) {
        setDialogStatus(githubDialogStatus, error.message, true);
      }
    }

    async function loadGitStatus(options = {}) {
      const data = await request('/api/git/status', { silent: options.silent });
      document.querySelector('#gitStatus').textContent = data.status.text;
      if (!options.silent) {
        setDialogStatus(githubDialogStatus, data.status.clean ? 'Git状態: 変更なし' : 'Git状態: 未コミット変更あり');
      }
    }

    async function commitAndPush() {
      const message = commitMessageInput.value.trim();
      if (!message) {
        setDialogStatus(githubDialogStatus, 'コミットメッセージを入力してください。', true);
        return;
      }

      if (!confirm('現在の変更をすべてコミットして GitHub に push します。実行しますか？')) {
        return;
      }

      const data = await request('/api/git/commit-push', {
        method: 'POST',
        body: { message },
      }, { statusEl: githubDialogStatus });
      document.querySelector('#gitStatus').textContent = data.result.status.text;
      setDialogStatus(githubDialogStatus, 'コミットしてpushしました。');
    }

    async function runAction(endpoint, body, message) {
      await request(endpoint, { method: 'POST', body });
      setStatus(message);
      await loadApps();
      refreshPreview();
    }

    async function request(endpoint, options = {}, { statusEl } = {}) {
      setBusy(true);
      if (!options.silent && statusEl) setDialogStatus(statusEl, '処理中...');
      try {
        const response = await fetch(endpoint, {
          method: options.method || 'GET',
          headers: options.body ? { 'Content-Type': 'application/json' } : {},
          body: options.body ? JSON.stringify(options.body) : undefined,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
      } catch (error) {
        if (statusEl) {
          setDialogStatus(statusEl, error.message, true);
        } else {
          setStatus(error.message, true);
        }
        throw error;
      } finally {
        setBusy(false);
      }
    }

    function refreshPreview() {
      preview.src = '/preview?ts=' + Date.now();
    }

    /* 処理中に止めるのはボタンだけ。入力欄は触れたままにして操作を奪わない */
    function setBusy(isBusy) {
      document.body.dataset.busy = String(isBusy);
      document.body.setAttribute('aria-busy', String(isBusy));
      document.querySelectorAll('button').forEach((element) => {
        if (isBusy) {
          element.dataset.wasDisabled = String(element.disabled);
          element.disabled = true;
          return;
        }
        element.disabled = element.dataset.wasDisabled === 'true';
        delete element.dataset.wasDisabled;
      });
    }

    function setStatus(message, isError = false) {
      const statusEl = document.querySelector('#globalStatus');
      if (statusEl) {
        statusEl.textContent = message;
        statusEl.classList.toggle('error', isError);
      }
    }

    function setDialogStatus(element, message, isError = false) {
      element.textContent = message;
      element.classList.toggle('error', isError);
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    loadApps();
  </script>
</body>
</html>`;
}
