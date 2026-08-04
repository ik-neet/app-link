# app-link

`ik-neet.com` のトップページ（静的リンク集）と、その管理ツール（`/admin`）。

## 構成

- `index.html` は **生成物**。直接編集しない。テンプレートは
  `scripts/app-link-tool.mjs` の `renderIndex()` にあり、直したら `npm run apps:build`。
- 管理画面は `scripts/admin-server.mjs` の `renderAdminPage()`（1ファイル完結）。
- データは `data/apps.json` / `data/categories.json`。
- デザイン規約は [DESIGN.md](DESIGN.md)、色・寸法・イージングの実体は
  [assets/tokens.css](assets/tokens.css)。UI を触る前に両方読む。生値を書かない。

## デプロイ

`main` に push すると Cloudflare Pages が自動デプロイし、`ik-neet.com` に反映される。
**push = 本番公開**なので、UI に触れた変更は下記 E2E を緑にしてから push する。

## E2E テスト（Playwright）

```bash
npm run e2e            # 実行（headless）
npm run e2e:ui         # UI モードでデバッグ
npm run e2e:report     # 直近の html レポート
```

- ランナーは `@playwright/test`。**サムネイル撮影で使う `playwright` と同じ版に固定する**
  （現在 1.60.0）。片方を上げたらもう片方も上げる。
- `playwright.config.ts` が `admin-server.mjs` を **ポート 8795**（通常の 8790 とは別）で起動する。
  普段使いの管理画面を立ち上げたままでもテストを回せる。
- **使い捨てデータ置き場**: `e2e/global-setup.ts` が `e2e/.tmp/` に `data/*.json` をコピーし、
  そこへ `index.html` を生成する。サーバとツールは環境変数 `APP_LINK_DATA_ROOT` でそちらを見る。
  リポジトリの `data/apps.json` と `index.html` は**テストで汚れない**。
  `assets/`（ロゴ・サムネイル・tokens.css）は実体を共有する（読み取りのみ）。
- 公開トップの検証は `/preview`（admin server が生成済み `index.html` を配信する経路）で行う。

### カバレッジ

| ファイル | 内容 |
|---|---|
| `e2e/smoke.spec.ts` | 公開トップ / 管理画面が開き、未捕捉例外と `console.error` が 0 件。`tokens.css` が `text/css` で配信され適用される |
| `e2e/top-page.spec.ts` | 非表示を除く全アプリが並ぶ・件数バッジが実数と一致・外部リンクの `rel` ・カテゴリタブ移動と現在地表示の追従 |
| `e2e/admin.spec.ts` | 一覧描画と新規追加ダイアログの開閉・表示/非表示の切替が公開ページに反映され元に戻せる |

### 対象外（意図的に入れていない）

- **サムネイル撮影**（`/api/thumbnails`, `/api/refresh` の実撮影）— 外部サイトへ実アクセスするため flaky。
- **GitHub 反映**（`/api/git/commit-push`）— 実リポジトリを変更するため。
- **スクリーンショット比較** — フォント差でフレークしやすい（ワークスペースのルール v1 準拠）。
- 計測タグ（Google Analytics）はテスト中 `blockAnalytics()` で遮断している。
