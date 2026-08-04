import { expect, test, type Page } from "@playwright/test";
import { blockAnalytics, watchErrors } from "./helpers";

// path とページ固有アンカー（静的な見出しを使い、データ到着待ちを避ける）
const PAGES: { name: string; path: string; anchor: (page: Page) => ReturnType<Page["getByRole"]> }[] = [
  {
    name: "公開トップ",
    path: "/preview",
    anchor: (page) => page.getByRole("heading", { level: 1, name: "ik-neet.com" }),
  },
  {
    name: "管理ツール",
    path: "/admin",
    anchor: (page) => page.getByRole("heading", { level: 1, name: "App Link Admin" }),
  },
];

for (const { name, path, anchor } of PAGES) {
  test(`smoke: ${name}(${path}) が表示され致命的エラーが無い`, async ({ page }) => {
    const errors = watchErrors(page);
    await blockAnalytics(page);

    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `${path} は 4xx/5xx を返してはいけない`).toBeLessThan(400);

    await expect(anchor(page)).toBeVisible();
    expect(errors, `致命的な JS/console エラー:\n${errors.join("\n")}`).toEqual([]);
  });
}

test("smoke: 共有トークン(tokens.css)が text/css で配信され適用される", async ({ page }) => {
  await blockAnalytics(page);

  const response = await page.request.get("/assets/tokens.css");
  expect(response.status()).toBe(200);
  // _headers の nosniff があるため、MIME が違うとスタイルが一切当たらない
  expect(response.headers()["content-type"]).toContain("text/css");

  await page.goto("/preview", { waitUntil: "domcontentloaded" });
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim(),
  );
  expect(accent).not.toBe("");
});
