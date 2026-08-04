import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { blockAnalytics, watchErrors } from "./helpers";
import { TEST_DATA_ROOT } from "./paths";

type App = { slug: string; category: string; hidden?: boolean };
type Category = { id: string; label: string };

function readTestData() {
  const read = <T>(file: string): T =>
    JSON.parse(fs.readFileSync(path.join(TEST_DATA_ROOT, "data", file), "utf8"));
  return {
    apps: read<App[]>("apps.json"),
    categories: read<Category[]>("categories.json"),
  };
}

test.beforeEach(async ({ page }) => {
  await blockAnalytics(page);
});

test("公開トップ: 非表示を除いた全アプリが一覧に出る", async ({ page }) => {
  const { apps, categories } = readTestData();
  const visible = apps.filter((app) => !app.hidden);

  await page.goto("/preview", { waitUntil: "domcontentloaded" });

  await expect(page.locator(".app-link")).toHaveCount(visible.length);
  await expect(page.locator(".app-section")).toHaveCount(categories.length);

  // 件数バッジがカテゴリごとの実数と一致する
  for (const category of categories) {
    const count = visible.filter((app) => app.category === category.id).length;
    const heading = page.locator(`.section-heading:has(h2#${category.id}s-heading) .count`);
    await expect(heading).toHaveText(`${count}件`);
  }
});

test("公開トップ: 外部リンクが安全な rel を持つ", async ({ page }) => {
  await page.goto("/preview", { waitUntil: "domcontentloaded" });

  const links = page.locator(".app-link");
  const total = await links.count();
  expect(total).toBeGreaterThan(0);

  for (let index = 0; index < total; index += 1) {
    const link = links.nth(index);
    await expect(link).toHaveAttribute("target", "_blank");
    const rel = (await link.getAttribute("rel")) ?? "";
    expect(rel, `${await link.getAttribute("href")} の rel`).toContain("noopener");
    expect(rel).toContain("noreferrer");
  }
});

test("公開トップ: カテゴリタブで移動でき、現在地表示が追従する", async ({ page }) => {
  const errors = watchErrors(page);
  const { categories } = readTestData();
  const last = categories[categories.length - 1];

  await page.goto("/preview", { waitUntil: "domcontentloaded" });

  // 先頭では最初のカテゴリが現在地
  await expect(page.locator('.category-tab[aria-current="true"]')).toHaveText(categories[0].label);

  await page.getByRole("link", { name: last.label, exact: true }).click();

  const heading = page.locator(`h2#${last.id}s-heading`);
  await expect(heading).toBeInViewport();
  // 追従ナビの下に隠れていないこと（scroll-margin-top が効いている）
  const navBottom = await page.locator(".category-nav").evaluate((el) => el.getBoundingClientRect().bottom);
  const headingTop = await heading.evaluate((el) => el.getBoundingClientRect().top);
  expect(headingTop).toBeGreaterThanOrEqual(navBottom - 1);

  await expect(page.locator('.category-tab[aria-current="true"]')).toHaveText(last.label);

  // スクロール後は追従ナビが境界表示に切り替わる
  await expect(page.locator(".category-nav")).toHaveAttribute("data-scrolled", "true");

  expect(errors, `致命的な JS/console エラー:\n${errors.join("\n")}`).toEqual([]);
});
