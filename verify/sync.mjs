// Lays out the adapters under test next to the vendored upstream helpers so
// their `../../adapters/types`, `../../helpers/*` imports resolve to the real
// pinned files, exactly as inside dimension-adapters:
//   upstream/aggregators/meow/index.ts          <- ../aggregators/meow/index.ts (final)
//   upstream/aggregators/meow-merged/index.ts   <- merged upstream copy (5ecdbba)
//   upstream/aggregators/meow-legacy/index.ts   <- legacy local copy (7ce77cc)
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const manifest = JSON.parse(readFileSync(join(here, "upstream/MANIFEST.json"), "utf8"));
for (const [file, want] of Object.entries(manifest.files)) {
  const got = sha(join(here, "upstream", file));
  if (got !== want) throw new Error(`vendored upstream ${file} changed: ${got} != ${want}`);
}

const ADAPTERS = {
  meow: "../aggregators/meow/index.ts",
  "meow-merged": "../test/fixtures/adapters/upstream-merged-5ecdbba.ts",
  "meow-legacy": "../test/fixtures/adapters/legacy-local-7ce77cc.ts",
};
rmSync(join(here, "upstream/aggregators"), { recursive: true, force: true });
for (const [name, src] of Object.entries(ADAPTERS)) {
  const dst = join(here, "upstream/aggregators", name, "index.ts");
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(here, src), dst);
  console.log(`${name.padEnd(12)} ${sha(dst)}  <- ${src}`);
}
