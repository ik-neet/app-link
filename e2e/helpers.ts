import type { Page } from "@playwright/test";

const IGNORE_CONSOLE = [
  /favicon/i,
  /Failed to load resource/i, // 画像/計測タグ等の 404・遮断（ロジックではない）
  /googletagmanager/i,
];

/** 未捕捉例外と console.error を集める。テスト末尾で 0 件を検証する。 */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (IGNORE_CONSOLE.some((re) => re.test(text))) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

/** 計測タグは外部ネットワーク依存なので遮断してフレークを防ぐ。 */
export async function blockAnalytics(page: Page): Promise<void> {
  await page.route(/googletagmanager\.com/, (route) => route.abort());
}
