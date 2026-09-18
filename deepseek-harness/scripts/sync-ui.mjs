import { cp, access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, "..");
const source = resolve(harnessRoot, "../deepseek-harness-ui/dist/client");
const target = resolve(harnessRoot, "node_modules/@deepseek-ai/dsh-web-frontend/dist");

try {
  await access(resolve(source, "index.html"), constants.R_OK);
} catch {
  throw new Error(`Loom OS build is missing at ${source}; run npm --prefix ../deepseek-harness-ui run build first`);
}

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
console.log(`Mounted Loom OS into DeepSeek Harness frontend: ${target}`);
