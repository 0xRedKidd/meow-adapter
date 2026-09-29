# Preserved adapter copies (evidence, not shipped)

| File | What it is | sha256 |
|---|---|---|
| `upstream-merged-5ecdbba.ts` | `DefiLlama/dimension-adapters` `aggregators/meow/index.ts` as merged by PR #9640 (merge `5ecdbba464140c2e406cd8e8e4f757c280f09cc7`, Git blob `44fa6b32d0bb64a2b18ad6fae681ba4ff6326ce3`). Unchanged on master `3d66de5`. | `4a085c905204df1deef77ee6f8f8ed2d1dde7d031180052c67ec5ce8070446d3` |
| `legacy-local-7ce77cc.ts` | This repository's adapter at `7ce77cc`, before stage 5. It was never merged upstream: it uses a manual `isCoreAsset` branch with `addGasToken` for native, and passes raw decoded integers to balances. | `9f75b6ab37fb51353871cfd6bfc712a73028acb63b19db311c7f260e1345a7c5` |

`aggregators/meow/index.ts` is the merged upstream file plus two changes: the
window-end pin with a block-based registry fallback, and the seed #2
checksum. `test/differential.test.mjs` compares all three copies on
identical logs.
