// Type-checks the synced adapters against the real @defillama/sdk 5.0.236
// declarations and the pinned upstream types, with upstream's compiler
// options (tsconfig.json). A negative control mutates the final adapter in
// memory (toApi -> toApiX) to show the check actually sees these files.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const cfgPath = path.join(root, "tsconfig.json");
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, root);
const FINAL = path.join(root, "upstream/aggregators/meow/index.ts");

function diagnostics(overrides = {}) {
  const host = ts.createCompilerHost(cfg.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (f) => (path.resolve(f) in overrides ? overrides[path.resolve(f)] : readFile(f));
  const program = ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options, host });
  return { program, diags: ts.getPreEmitDiagnostics(program) };
}

test(`typescript ${ts.version}: final, merged and legacy adapters type-check with zero diagnostics`, () => {
  const { program, diags } = diagnostics();
  const files = program.getRootFileNames().map((f) => path.relative(root, f));
  for (const name of ["meow", "meow-merged", "meow-legacy"]) assert.ok(files.includes(`upstream/aggregators/${name}/index.ts`), files.join());
  assert.ok(program.getSourceFiles().some((s) => s.fileName.endsWith("@defillama/sdk/build/ChainApi.d.ts")));
  assert.deepEqual(diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});

test("negative control: a misspelled FetchOptions member is reported", () => {
  const src = ts.sys.readFile(FINAL).replace("options.toApi;", "options.toApiX;");
  const { diags } = diagnostics({ [FINAL]: src });
  assert.ok(diags.some((d) => d.file && path.resolve(d.file.fileName) === FINAL && /toApiX/.test(ts.flattenDiagnosticMessageText(d.messageText, " "))));
});
