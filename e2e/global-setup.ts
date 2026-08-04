import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, TEST_DATA_ROOT } from "./paths";

// 1) 使い捨てデータ置き場を作り直し、data/*.json を実体からコピーする
// 2) そこへ index.html を生成する（/preview が読むのはこの HTML）
export default function globalSetup() {
  fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DATA_ROOT, "data"), { recursive: true });

  for (const file of ["apps.json", "categories.json"]) {
    fs.copyFileSync(
      path.join(PROJECT_ROOT, "data", file),
      path.join(TEST_DATA_ROOT, "data", file),
    );
  }

  execFileSync("node", ["scripts/app-link-tool.mjs", "build"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, APP_LINK_DATA_ROOT: TEST_DATA_ROOT },
  });
}
