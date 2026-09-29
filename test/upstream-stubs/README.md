# Upstream stand-ins (mocks)

The adapter imports four modules that only exist inside
`DefiLlama/dimension-adapters`. The local test harness (`test/harness/`) maps
those imports to the files here so the real, unmodified
`aggregators/meow/index.ts` can run under plain Node 24. None of this is
upstream code running; it is a local model of it.

| Adapter import | Stand-in | Fidelity |
|---|---|---|
| `../../adapters/types` | `types.mjs` | Type-only upstream; the stand-in exports inert names so the ESM import links. |
| `../../helpers/chains` | `chains.mjs` | Only `CHAIN.ROBINHOOD = "robinhood"`, copied from upstream. |
| `../../helpers/coreAssets.json` | `coreAssets.mjs` | The top-level `null` key and the `robinhood` entry, copied verbatim from upstream. |
| `../../helpers/prices` | `prices.mjs` | `isCoreAsset` and `addOneToken` copied from upstream, reading the entry above. |

Limitations:

- `MockBalances` keys `add(0x0…0)` and `addGasToken()` identically.
  `verify/test/real-sdk.test.cjs` shows the real SDK `Balances` does the same
  (`robinhood:0x0…0`). Pricing of that key was not exercised.
- `MockBalances` records zero amounts; the real `Balances.add` skips them.

Upstream revision the copies were taken from (fetched 2026-09-29):
`DefiLlama/dimension-adapters@3d66de5631bb747a7b12fd78782ebe5af18e20d0`.
`helpers/coreAssets.json` SHA-256 at that revision:
`9465325e6a52c8e53574aa750b27ff51e824798a504272c5b3ef31dba6bed7a8`.

The `FetchOptions` object, `ChainApi` and `Balances` are modelled in
`test/harness/chain.mjs`; see the comments there for which upstream
semantics each piece reproduces.
