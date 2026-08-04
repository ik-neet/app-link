# Design — app-link (ik-neet.com)

`ik-neet.com` のトップページと管理ツール（`/admin`）が共有する、ロック済みのデザインシステム。
このプロジェクトの UI を触るときは、まずこのファイルを読む。
色・寸法・イージングの実体は [`assets/tokens.css`](assets/tokens.css) にあり、**唯一のソース**。

- 公開トップ: `scripts/app-link-tool.mjs` の `renderIndex()` が `index.html` を生成する。
  `index.html` は生成物なので直接編集しない。変更したら `npm run apps:build`。
- 管理ツール: `scripts/admin-server.mjs` の `renderAdminPage()`。

## Genre / macrostructure

- Genre: **editorial**（個人が作ったものを並べる索引。装飾ではなく一覧性が主役）
- 公開トップ: **Catalogue（index list）** — カテゴリ見出し＋1行1アプリのリスト
  - nav: 追従するカテゴリタブレール（半透明レイヤー）
  - footer: 罫線1本のコロフォン
- 管理ツール: **Workbench（app surface）** — マストヘッド＋リスト＋プレビュー
  - 装飾（ヒーロー画像・イラスト等）は入れない。機能がページを持たせる。

2つの面はテーマ・書体・CTA の声を**共有する**。差分はマクロ構造だけ。

## Theme

ブランドのシアン（ロゴの `#159BD3`）を軸にした OKLCH パレット。
ライト／ダーク両対応。値は `assets/tokens.css` の `:root` と
`@media (prefers-color-scheme: dark)` を参照。

| 役割 | token |
|---|---|
| 地 | `--color-paper` / `--color-paper-2` / `--color-paper-3` |
| 文字 | `--color-ink` / `--color-ink-2` |
| 罫線 | `--color-rule` / `--color-rule-strong` |
| アクセント | `--color-accent` / `--color-accent-bright` / `--color-accent-wash` |
| フォーカス | `--color-focus` |
| 破壊的操作 | `--color-danger` / `--color-danger-wash` |
| 材質 | `--material-chrome` / `--material-float` / `--material-blur` / `--scrim` |

カテゴリ色（`data/categories.json` の `color`）は生成時に `--cat-<className>` として
出力し、見出し／タブ側は `var(--cat)` だけを参照する。ダークテーマでは
`color-mix(in oklab, <色> 42%, white)` で明度を持ち上げる。

## Typography

- 書体はプラットフォームのシステムフォント（`--font-body`）。等幅は `--font-mono`。
  独自 Web フォントは読み込まない（読み込み遅延と和文の重さに見合わない）。
- **tracking はサイズ別**。大きい字ほど詰める。
  `--track-display` / `--track-heading` / `--track-body` / `--track-small`
- **leading もサイズに反比例**。`--leading-display` … `--leading-body`
- 階層は「サイズ＋ウェイト＋leading」の組で作る。サイズだけで作らない。
- 寸法は `rem`。ユーザーの文字サイズ設定でレイアウトごと拡大させる。

## Spacing

4pt スケール（`--space-3xs` 〜 `--space-2xl`）。生値を書かない。
ページ幅は `--page-width`、本文の可読幅は `--measure`。

## Motion

- イージングは3つだけ: `--ease-out` / `--ease-in` / `--ease-in-out`。
  ブラウザ既定の `ease` とバウンスは使わない。
- 時間は `--dur-instant`（押下の反応）/ `--dur-short` / `--dur-medium`。
- アニメーションするのは `transform` と `opacity`（＋材質の `filter: blur`）のみ。
- **フィードバックは pointer-down の瞬間**に出す（`:active`）。押し上げを待たない。
- 出現と退場は同じ経路・同じ起点。ポップオーバーは `transform-origin` を
  トリガー要素側に置く（more メニュー＝右上、サムネイル拡大＝サムネイル側）。
- `prefers-reduced-motion: reduce` では位置の動きを全部落とし、
  150ms 以内の不透明度クロスフェードに差し替える。

## 材質と奥行き

- 追従するナビ／マストヘッドは `backdrop-filter` の半透明レイヤーにし、
  コンテンツをその下に流す。不透明な帯で場所を専有しない。
- コンテンツとの境界は 1px の罫線ではなく**スクロールエッジのフェード**で作る。
  スクロール位置に応じて `data-scrolled` を切り替える。
- 面が大きいほど blur と影を強くする（`--shadow-lift` < `--shadow-float`）。
- モーダルは scrim（`--scrim`）で背景を沈める。非ブロッキングなパネルには scrim を敷かない。

## アクセシビリティ（必須）

- `:focus-visible` のリングは `--color-focus` で即時表示。**リングをアニメーションさせない**。
- `prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast` の
  3つすべてに応答する（`tokens.css` が材質と罫線を差し替える）。
- タップ／クリック対象の最小高さは 2.25rem。ボタン文字は折り返さない。
- 状態メッセージは `role="status"` + `aria-live="polite"`。
- 外部リンクは `rel="noopener noreferrer"`。

## CTA / ボタンの声

- primary: アクセント塗り（`--color-accent` / `--color-accent-ink`）、`--radius-sm`
- 既定: `--color-paper-2` 地＋`--color-rule-strong` の枠
- quiet: 枠なし・透明地。副次的な操作用
- danger: 文字色 `--color-danger`、hover で `--color-danger-wash`
- 確認ダイアログは**取り返しのつかない操作だけ**（削除、commit & push）

## レスポンシブ

- `html, body { overflow-x: clip }`。横スクロールは出さない。
- 画像を含むグリッドトラックは `minmax(0, 1fr)`。素の `1fr` は使わない。
- 320 / 375 / 414 / 768px で崩れないこと。ブレークポイントは `40rem`。

## 共有すべきもの / 変えてよいもの

**共有する**: ロゴ、アクセント色とその使用量、書体、ボタンの声、
セクション見出しのリズム（見出し＋件数＋カテゴリ色の下線）。

**変えてよい**: マクロ構造（トップ＝Catalogue / 管理＝Workbench）、
セクションの並び、管理側だけのツール類。
