import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  addApp,
  buildIndex,
  categories,
  generateThumbnails,
  readApps,
  removeApp,
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
        categories,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/apps') {
      const body = await readJson(request);
      await addApp(body);
      sendJson(response, { ok: true, apps: await readApps() });
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

    if (request.method === 'POST' && url.pathname === '/api/build') {
      await buildIndex();
      sendJson(response, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/thumbnails') {
      const body = await readJson(request);
      await generateThumbnails(body.slug ? { slug: body.slug } : {});
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
      await generateThumbnails(body.slug ? { slug: body.slug } : {});
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
  <style>
    * { box-sizing: border-box; }

    :root {
      --bg: #f6f8fb;
      --panel: #ffffff;
      --text: #1f2d3d;
      --muted: #607083;
      --line: #d8e1ea;
      --accent: #146c94;
      --danger: #b7372f;
      --soft: #edf5f9;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
      line-height: 1.55;
    }

    header {
      position: sticky;
      top: 0;
      z-index: 2;
      border-bottom: 1px solid var(--line);
      background: rgba(246, 248, 251, 0.96);
      backdrop-filter: blur(8px);
    }

    .bar,
    main {
      width: min(960px, calc(100% - 32px));
      margin: 0 auto;
    }

    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 0;
      flex-wrap: wrap;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.3;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    button,
    select,
    input,
    textarea {
      font: inherit;
    }

    button {
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 7px 10px;
      background: #fff;
      color: var(--text);
      cursor: pointer;
      font-weight: 650;
    }

    button:hover { border-color: #9fb3c5; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.danger { color: var(--danger); }
    button:disabled { cursor: wait; opacity: 0.58; }

    main {
      padding: 22px 0 36px;
    }

    section {
      min-width: 0;
    }

    .section-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin: 0 0 8px;
      border-bottom: 1px solid var(--line);
    }

    h2 {
      margin: 0;
      padding-bottom: 6px;
      font-size: 18px;
    }

    .count {
      color: var(--muted);
      font-size: 13px;
    }

    .app-list {
      display: grid;
      gap: 0;
      margin-bottom: 26px;
      border-top: 1px solid var(--line);
    }

    .app-row {
      display: grid;
      grid-template-columns: 96px 1fr auto;
      align-items: center;
      gap: 14px;
      padding: 12px 4px;
      border-bottom: 1px solid var(--line);
    }

    .thumb {
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
      font-weight: 800;
    }

    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .meta {
      min-width: 0;
    }

    .meta strong,
    .meta span {
      display: block;
    }

    .meta strong {
      font-size: 16px;
      line-height: 1.35;
    }

    .meta span,
    .url {
      color: var(--muted);
      font-size: 13px;
    }

    .url {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .row-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }

    .status {
      min-height: 24px;
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 13px;
    }

    .status.error {
      color: var(--danger);
      font-weight: 700;
    }

    .git-status {
      min-height: 72px;
      max-height: 180px;
      overflow: auto;
      margin: 8px 0 10px;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 8px;
      background: #f8fafc;
      color: var(--muted);
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
      white-space: pre-wrap;
    }

    iframe {
      width: 100%;
      height: 420px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
    }

    .preview-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 8px 0 10px;
    }

    label {
      display: grid;
      gap: 5px;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }

    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 8px 9px;
      background: #fff;
      color: var(--text);
    }

    textarea {
      min-height: 74px;
      resize: vertical;
    }

    .form-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 14px;
    }

    /* --- Modal (dialog) --- */
    dialog {
      width: min(520px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0;
      box-shadow: 0 18px 48px rgba(20, 45, 70, 0.22);
    }

    dialog::backdrop {
      background: rgba(15, 28, 43, 0.45);
    }

    .modal-inner {
      padding: 18px 20px 20px;
    }

    .modal-title {
      margin: 0 0 14px;
      font-size: 18px;
    }

    .modal-close-row {
      display: flex;
      justify-content: flex-end;
    }

    dialog.git-dialog {
      width: min(560px, calc(100vw - 32px));
    }

    .thumb-preview-row {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 14px;
    }

    .thumb-preview {
      width: 140px;
      aspect-ratio: 16 / 9;
      display: grid;
      place-items: center;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #fff;
      color: var(--accent);
      font-size: 28px;
      font-weight: 800;
      flex: none;
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
      gap: 8px;
      flex: 1;
      min-width: 0;
    }

    .thumb-tools input[type="file"] {
      padding: 6px;
      border-style: dashed;
    }

    @media (max-width: 640px) {
      .bar {
        align-items: flex-start;
        flex-direction: column;
      }

      .actions {
        justify-content: flex-start;
      }

      .app-row {
        grid-template-columns: 72px 1fr;
      }

      .thumb {
        width: 72px;
      }

      .row-actions {
        grid-column: 2;
        justify-content: flex-start;
      }

      .thumb-preview-row {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="bar">
      <h1>App Link Admin</h1>
      <div class="actions">
        <button id="reloadButton">再読み込み</button>
        <button id="buildButton">index生成</button>
        <button id="thumbsButton">全サムネイル生成</button>
        <button id="refreshButton" class="primary">全更新</button>
        <button id="addButton" class="primary">新規追加</button>
        <button id="githubButton">GitHub反映</button>
      </div>
    </div>
  </header>

  <main>
    <p id="globalStatus" class="status"></p>
    <section>
      <div id="lists"></div>

      <div class="preview-heading">
        <h2>プレビュー</h2>
        <button id="previewButton">更新</button>
      </div>
      <iframe id="preview" src="/preview"></iframe>
    </section>
  </main>

  <dialog id="appDialog">
    <div class="modal-inner">
      <div class="modal-close-row">
        <button type="button" id="appDialogCloseTop" aria-label="閉じる">×</button>
      </div>
      <h2 class="modal-title" id="appDialogTitle">新規追加</h2>

      <div id="thumbSection" hidden>
        <div class="thumb-preview-row">
          <div class="thumb-preview" id="thumbPreview">-</div>
          <div class="thumb-tools">
            <label>画像を選択
              <input type="file" id="thumbFileInput" accept="image/*" />
            </label>
            <button type="button" id="captureButton">撮影</button>
          </div>
        </div>
      </div>

      <form id="appForm">
        <label>slug
          <input name="slug" required pattern="[a-z0-9-]+" placeholder="sample-app" />
        </label>
        <label>カテゴリ
          <select name="category" required>
            <option value="game">ゲーム</option>
            <option value="tool">ツール</option>
          </select>
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
      <p id="appDialogStatus" class="status"></p>
    </div>
  </dialog>

  <dialog id="githubDialog" class="git-dialog">
    <div class="modal-inner">
      <div class="modal-close-row">
        <button type="button" id="githubDialogCloseTop" aria-label="閉じる">×</button>
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
      <p id="githubDialogStatus" class="status"></p>
    </div>
  </dialog>

  <script>
    const lists = document.querySelector('#lists');
    const preview = document.querySelector('#preview');

    const appDialog = document.querySelector('#appDialog');
    const appDialogTitle = document.querySelector('#appDialogTitle');
    const appDialogStatus = document.querySelector('#appDialogStatus');
    const appForm = document.querySelector('#appForm');
    const thumbSection = document.querySelector('#thumbSection');
    const thumbPreview = document.querySelector('#thumbPreview');
    const thumbFileInput = document.querySelector('#thumbFileInput');

    const githubDialog = document.querySelector('#githubDialog');
    const githubDialogStatus = document.querySelector('#githubDialogStatus');
    const commitMessageInput = document.querySelector('#commitMessage');

    let apps = [];
    let categories = [];
    let editingSlug = null;

    document.querySelector('#reloadButton').addEventListener('click', loadApps);
    document.querySelector('#buildButton').addEventListener('click', () => runAction('/api/build', {}, 'index.html を生成しました。'));
    document.querySelector('#thumbsButton').addEventListener('click', () => runAction('/api/thumbnails', {}, '全サムネイルを生成しました。'));
    document.querySelector('#refreshButton').addEventListener('click', () => runAction('/api/refresh', {}, '全更新しました。'));
    document.querySelector('#previewButton').addEventListener('click', refreshPreview);

    document.querySelector('#addButton').addEventListener('click', openAddDialog);
    document.querySelector('#appDialogCancel').addEventListener('click', () => appDialog.close());
    document.querySelector('#appDialogCloseTop').addEventListener('click', () => appDialog.close());
    appDialog.addEventListener('click', (event) => {
      if (event.target === appDialog) appDialog.close();
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

    appForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(appForm).entries());
      const endpoint = editingSlug ? '/api/apps/' + encodeURIComponent(editingSlug) : '/api/apps';
      const method = editingSlug ? 'PUT' : 'POST';
      await request(endpoint, { method, body: payload }, { statusEl: appDialogStatus });
      setStatus(editingSlug ? '更新しました。' : '追加しました。');
      appDialog.close();
      await loadApps();
      refreshPreview();
    });

    async function loadApps() {
      const data = await request('/api/apps');
      apps = data.apps;
      categories = data.categories;
      renderLists();
      setStatus('読み込みました。');
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
              \${categoryApps.map(renderRow).join('')}
            </div>
          </section>
        \`;
      }).join('');

      lists.querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => openEditDialog(button.dataset.edit));
      });

      lists.querySelectorAll('[data-thumbnail]').forEach((button) => {
        button.addEventListener('click', () => runAction('/api/thumbnails', { slug: button.dataset.thumbnail }, 'サムネイルを生成しました。'));
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
    }

    function renderRow(app) {
      const thumbSrc = '/assets/thumbs/' + encodeURIComponent(app.slug) + '.png?ts=' + Date.now();
      return \`
        <div class="app-row">
          <div class="thumb"><img src="\${thumbSrc}" alt="" onerror="this.replaceWith(document.createTextNode('\${escapeHtml(app.initial)}'))"></div>
          <div class="meta">
            <strong>\${escapeHtml(app.title)}</strong>
            <span>\${escapeHtml(app.description)}</span>
            <div class="url">\${escapeHtml(app.url)}</div>
          </div>
          <div class="row-actions">
            <button data-edit="\${escapeHtml(app.slug)}">編集</button>
            <button data-thumbnail="\${escapeHtml(app.slug)}">撮影</button>
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
      thumbSection.hidden = true;
      thumbFileInput.value = '';
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
      thumbFileInput.value = '';
      updateThumbPreview(app);
      setDialogStatus(appDialogStatus, '');
      appDialog.showModal();
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

    async function handleThumbFileChange(event) {
      const file = event.target.files && event.target.files[0];
      if (!file || !editingSlug) return;

      try {
        setDialogStatus(appDialogStatus, '画像を変換中...');
        const dataUrl = await fileToPngDataUrl(file);
        await request('/api/thumbnails/upload', {
          method: 'POST',
          body: { slug: editingSlug, dataUrl },
        }, { statusEl: appDialogStatus });

        const app = apps.find((item) => item.slug === editingSlug);
        if (app) updateThumbPreview(app);
        await loadApps();
        refreshPreview();
        setDialogStatus(appDialogStatus, 'サムネイルを更新しました。');
      } catch (error) {
        setDialogStatus(appDialogStatus, error.message, true);
      } finally {
        thumbFileInput.value = '';
      }
    }

    function fileToPngDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => reject(new Error('画像の解析に失敗しました。'));
          image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || image.width;
            canvas.height = image.naturalHeight || image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          };
          image.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }

    async function captureThumbnail() {
      if (!editingSlug) return;
      try {
        setDialogStatus(appDialogStatus, '撮影中...');
        await request('/api/refresh', { method: 'POST', body: { slug: editingSlug } }, { statusEl: appDialogStatus });
        await loadApps();
        const app = apps.find((item) => item.slug === editingSlug);
        if (app) updateThumbPreview(app);
        refreshPreview();
        setDialogStatus(appDialogStatus, '撮影しました。');
      } catch (error) {
        setDialogStatus(appDialogStatus, error.message, true);
      }
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

    function setBusy(isBusy) {
      document.querySelectorAll('button, input, textarea, select').forEach((element) => {
        if (element === appForm.elements.slug && editingSlug) {
          element.disabled = true;
          return;
        }
        element.disabled = isBusy;
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
