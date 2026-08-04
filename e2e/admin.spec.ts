import { expect, test } from "@playwright/test";
import { blockAnalytics, watchErrors } from "./helpers";

test.beforeEach(async ({ page }) => {
  await blockAnalytics(page);
});

test("管理: 一覧が描画され、新規追加ダイアログが開閉できる", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/admin", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#globalStatus")).toHaveText("読み込みました。");

  const rows = page.locator(".app-row");
  expect(await rows.count()).toBeGreaterThan(0);

  const dialog = page.locator("#appDialog");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "新規追加" }).click();
  await expect(dialog).toBeVisible();
  await expect(page.locator("#appDialogTitle")).toHaveText("新規追加");

  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toBeHidden();

  expect(errors, `致命的な JS/console エラー:\n${errors.join("\n")}`).toEqual([]);
});

test("管理: 表示/非表示の切り替えが公開ページに反映され、元に戻せる", async ({ page }) => {
  await page.goto("/preview", { waitUntil: "domcontentloaded" });
  const before = await page.locator(".app-link").count();
  expect(before).toBeGreaterThan(0);

  await page.goto("/admin", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#globalStatus")).toHaveText("読み込みました。");

  const firstRow = page.locator(".app-row").first();
  await firstRow.getByRole("button", { name: "非表示にする" }).click();

  await expect(page.locator("#globalStatus")).toHaveText("非表示にしました。");
  await expect(page.locator(".app-row").first()).toHaveClass(/is-hidden/);
  await expect(page.locator(".app-row").first().getByText("非表示")).toBeVisible();

  await page.goto("/preview", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-link")).toHaveCount(before - 1);

  await page.goto("/admin", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#globalStatus")).toHaveText("読み込みました。");
  await page.locator(".app-row").first().getByRole("button", { name: "表示する" }).click();
  await expect(page.locator("#globalStatus")).toHaveText("表示にしました。");

  await page.goto("/preview", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-link")).toHaveCount(before);
});
