#!/usr/bin/env node
// Run the adapter suite against another copy of the adapter source:
//   node test/run-against.mjs <path/to/aggregators/meow/index.ts>
// Useful for checking a sibling checkout's copy or a previous revision.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target || !existsSync(target)) {
  process.stderr.write("usage: node test/run-against.mjs <adapter .ts file>\n");
  process.exit(1);
}
const repo = resolve(fileURLToPath(import.meta.url), "../..");
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "test/adapter.test.mjs"], {
  cwd: repo,
  stdio: "inherit",
  env: { ...process.env, MEOW_ADAPTER: resolve(target) },
});
process.exit(r.status ?? 1);
