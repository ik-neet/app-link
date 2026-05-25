import { runCli } from './app-link-tool.mjs';

await runCli(['thumbnails', ...process.argv.slice(2)]);
