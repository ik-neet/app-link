# app-link

`ik-neet.com` のトップサイトとして公開する静的リンク集です。

## Cloudflare Pages で公開

1. Cloudflare Dashboard で **Workers & Pages** を開く。
2. **Create application** → **Pages** → **Connect to Git** を選ぶ。
3. GitHub リポジトリ `ik-neet/app-link` を選ぶ。
4. Build settings は次の通りにする。

| 項目 | 値 |
|---|---|
| Framework preset | None |
| Build command | 空欄 |
| Build output directory | `/` |
| Root directory | `/` |

5. デプロイ後、Pages プロジェクトの **Custom domains** から `ik-neet.com` を追加する。
6. `ik-neet.com` を Cloudflare の Zone に追加し、ドメイン取得元のネームサーバーを Cloudflare 指定のものへ変更する。

## Wrangler で手動デプロイ

```powershell
npx wrangler pages deploy . --project-name app-link
```

## サムネイル生成

リンク先を開いて `assets/thumbs/` にスクリーンショットを保存します。

```powershell
npm install
npm run thumbnails
```

撮影対象と寄せ方は `scripts/generate-thumbnails.mjs` の `apps` で管理します。
`focus` は `auto`、`top`、`center`、または CSS selector を指定できます。

## メモ

- `wrangler.toml` は Cloudflare Pages 用のプロジェクト名と公開ディレクトリだけを定義しています。
- `www.ik-neet.com` も使う場合は Pages の Custom domains に追加し、Cloudflare 側で `www` から `ik-neet.com` へのリダイレクトを設定します。
