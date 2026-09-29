// Loads adapter sources (the real aggregators/meow/index.ts by default) under
// Node 24's built-in type stripping. Each adapter's upstream imports are
// redirected to the local stand-ins in test/upstream-stubs; any other import
// from an adapter fails loudly so a new upstream dependency cannot be
// silently skipped.
//
// MEOW_ADAPTER=<path to a .ts copy> makes loadAdapter() default to another
// copy (see test/run-against.mjs).
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ADAPTER_URL = process.env.MEOW_ADAPTER
  ? pathToFileURL(resolve(process.env.MEOW_ADAPTER)).href
  : new URL("../../aggregators/meow/index.ts", import.meta.url).href;

/** Preserved comparison copies (see test/fixtures/adapters/README.md). */
export const MERGED_UPSTREAM_URL = new URL("../fixtures/adapters/upstream-merged-5ecdbba.ts", import.meta.url).href;
export const LEGACY_LOCAL_URL = new URL("../fixtures/adapters/legacy-local-7ce77cc.ts", import.meta.url).href;

const STUBS = {
  "../../adapters/types": "types.mjs",
  "../../helpers/chains": "chains.mjs",
  "../../helpers/prices": "prices.mjs",
  "../../helpers/coreAssets.json": "coreAssets.mjs",
};

const adapterUrls = new Set();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (adapterUrls.has(context.parentURL)) {
      const stub = STUBS[specifier];
      if (!stub) throw new Error(`adapter imports ${specifier}, which has no local stand-in`);
      return { url: new URL(`../upstream-stubs/${stub}`, import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export async function loadAdapter(url = ADAPTER_URL) {
  adapterUrls.add(url);
  return (await import(url)).default;
}
