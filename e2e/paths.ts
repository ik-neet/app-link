import path from "node:path";

// E2E 専用の使い捨てデータ置き場。リポジトリの data/apps.json と index.html を
// 汚さないよう、global-setup で毎回作り直す。
// assets（ロゴ・サムネイル・tokens.css）は実体を共有する（読み取りのみ）。
export const PROJECT_ROOT = process.cwd();
export const TEST_DATA_ROOT = path.join(PROJECT_ROOT, "e2e", ".tmp");
export const TEST_PORT = 8795; // 通常の admin(8790) と別番号
export const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
