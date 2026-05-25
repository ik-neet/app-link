import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
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
const port = Number(process.env.PORT || 8790);

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
      sendJson(response, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/refresh') {
      const body = await readJson(request);
      await generateThumbnails(body.slug ? { slug: body.slug } : {});
      await buildIndex();
      sendJson(response, { ok: true, apps: await readApps() });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/preview') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      createReadStream(path.join(projectRoot, 'index.html')).pipe(response);
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

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
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
      width: min(1160px, calc(100% - 32px));
      margin: 0 auto;
    }

    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 0;
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
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 24px;
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

    aside {
      position: sticky;
      top: 78px;
      align-self: start;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      padding: 16px;
    }

    .form-title {
      margin: 0 0 12px;
      font-size: 17px;
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

    @media (max-width: 900px) {
      main {
        grid-template-columns: 1fr;
      }

      aside {
        position: static;
        order: -1;
      }
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
      </div>
    </div>
  </header>

  <main>
    <section>
      <div id="lists"></div>

      <div class="preview-heading">
        <h2>プレビュー</h2>
        <button id="previewButton">更新</button>
      </div>
      <iframe id="preview" src="/preview"></iframe>
    </section>

    <aside>
      <h2 class="form-title" id="formTitle">新規追加</h2>
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
          <button type="button" id="clearButton">新規入力</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>
      <p id="status" class="status"></p>
    </aside>
  </main>

  <script>
    const lists = document.querySelector('#lists');
    const form = document.querySelector('#appForm');
    const formTitle = document.querySelector('#formTitle');
    const statusText = document.querySelector('#status');
    const preview = document.querySelector('#preview');
    let apps = [];
    let categories = [];
    let editingSlug = null;

    document.querySelector('#reloadButton').addEventListener('click', loadApps);
    document.querySelector('#buildButton').addEventListener('click', () => runAction('/api/build', {}, 'index.html を生成しました。'));
    document.querySelector('#thumbsButton').addEventListener('click', () => runAction('/api/thumbnails', {}, '全サムネイルを生成しました。'));
    document.querySelector('#refreshButton').addEventListener('click', () => runAction('/api/refresh', {}, '全更新しました。'));
    document.querySelector('#previewButton').addEventListener('click', refreshPreview);
    document.querySelector('#clearButton').addEventListener('click', clearForm);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form).entries());
      const endpoint = editingSlug ? '/api/apps/' + encodeURIComponent(editingSlug) : '/api/apps';
      const method = editingSlug ? 'PUT' : 'POST';
      await request(endpoint, { method, body: payload });
      setStatus(editingSlug ? '更新しました。' : '追加しました。');
      clearForm();
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
        button.addEventListener('click', () => editApp(button.dataset.edit));
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

    function editApp(slug) {
      const app = apps.find((item) => item.slug === slug);
      if (!app) return;
      editingSlug = slug;
      formTitle.textContent = '編集';
      for (const [key, value] of Object.entries(app)) {
        if (form.elements[key]) form.elements[key].value = value;
      }
      form.elements.slug.disabled = true;
      setStatus(slug + ' を編集中です。');
    }

    function clearForm() {
      editingSlug = null;
      form.reset();
      form.elements.focus.value = 'auto';
      form.elements.slug.disabled = false;
      formTitle.textContent = '新規追加';
      setStatus('');
    }

    async function runAction(endpoint, body, message) {
      await request(endpoint, { method: 'POST', body });
      setStatus(message);
      await loadApps();
      refreshPreview();
    }

    async function request(endpoint, options = {}) {
      setBusy(true);
      setStatus('処理中...');
      try {
        const response = await fetch(endpoint, {
          method: options.method || 'GET',
          headers: options.body ? { 'Content-Type': 'application/json' } : {},
          body: options.body ? JSON.stringify(options.body) : undefined,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        statusText.classList.remove('error');
        return data;
      } catch (error) {
        setStatus(error.message, true);
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
        if (element === form.elements.slug && editingSlug) {
          element.disabled = true;
          return;
        }
        element.disabled = isBusy;
      });
    }

    function setStatus(message, isError = false) {
      statusText.textContent = message;
      statusText.classList.toggle('error', isError);
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
