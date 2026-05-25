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

アプリ一覧は `data/apps.json` で管理し、`index.html` とサムネイルをツールで更新します。

```powershell
npm install
npm run apps:list
npm run apps:build
npm run thumbnails
```

新規追加は次の形式です。

```powershell
npm run app -- add --slug sample-app --category tool --title "サンプルアプリ" --description "説明文" --url "https://example.com/" --initial "S" --focus auto
npm run app -- thumbnails --slug sample-app
```

既存アプリの修正は次の形式です。

```powershell
npm run app -- update --slug sample-app --title "新しいタイトル" --focus center
```

削除は次の形式です。

```powershell
npm run app -- remove --slug sample-app
```

`focus` は `auto`、`top`、`center`、または CSS selector を指定できます。
サムネイル撮影と `index.html` 生成をまとめて行う場合は `npm run refresh` を使います。

## メモ

- `wrangler.toml` は Cloudflare Pages 用のプロジェクト名と公開ディレクトリだけを定義しています。
- `www.ik-neet.com` も使う場合は Pages の Custom domains に追加し、Cloudflare 側で `www` から `ik-neet.com` へのリダイレクトを設定します。
