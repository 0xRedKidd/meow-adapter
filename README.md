# Meow DefiLlama adapter

DefiLlama dimension adapter for [Meow](https://meow.exchange), a DEX aggregator on
Robinhood Chain (chain id 4663), plus the on-chain router registry it reads.

## Status (2026-09-29)

- Upstream `DefiLlama/dimension-adapters` merged the adapter in PR #9640
  (merge `5ecdbba`, 2026-09-23; Git blob `44fa6b32`, unchanged on master
  `3d66de5`). That merged file is the source of truth here.
- `aggregators/meow/index.ts` is the merged file plus three narrow changes.
  They are local only and have not been proposed upstream:
  1. The registry read checks that `toApi` is pinned to `getToBlock()`.
  2. The pre-registry fallback compares the window's end block with the
     registry deployment block (70680538) instead of comparing `toTimestamp`
     with 1790183334. The real blocks 70680537 and 70680538 share that
     timestamp.
  3. Seed #2 now has a valid EIP-55 checksum.

  Valuation (`addOneToken`), events, fee loops and methodology are unchanged.
- The pre-merge local adapter is kept for comparison in
  `test/fixtures/adapters/`.
- HoodAggregatorV3 is not deployed and not registered.

## Layout

| Path | What it is |
|---|---|
| `aggregators/meow/index.ts` | The adapter, at the path it takes inside [`DefiLlama/dimension-adapters`](https://github.com/DefiLlama/dimension-adapters). |
| `contracts/MeowRouterRegistry.sol` | Source of the registry at `0x7b592Bf516cE94AE28e24e34d709Cb95fE596005` (Solidity 0.8.26, optimizer 100 runs, cancun). Verified on [Sourcify](https://repo.sourcify.dev/4663/0x7b592Bf516cE94AE28e24e34d709Cb95fE596005) with an exact creation and runtime match. |
| `deployments/meow-router-registry-4663.json` | Deployment record: tx, block, seeded routers. |
| `deployments/hoodaggregator-v3-registration.template.json` | Release input for registering HoodAggregatorV3. Unfilled; the builder refuses it until real deployment values are supplied. |
| `tools/v3-registration.mjs` | Offline builder/validator for the V3 `register(...)` request. Never signs or broadcasts. |
| `test/` | Local tests that execute the real adapter against an in-memory chain model (mocks, not upstream). |
| `test/fixtures/adapters/` | Preserved merged-upstream and legacy-local adapter copies used for differential tests. |
| `verify/` | Optional verification against the real `@defillama/sdk` 5.0.236, TypeScript and ethers (local `node_modules`, lockfile committed). |
| `PR_DESCRIPTION.md` | Body for the DefiLlama pull request. |

## How volume is counted

Every settled swap emits `Swapped(sender, recipient, tokenIn, tokenOut, amountIn, amountOut)`
once on the router that executed it, and the router's own output fee emits
`FeeCollected(token, recipient, amount)` in the same transaction. The adapter
sums these into `dailyVolume`, `dailyFees`, `dailyRevenue` and
`dailyProtocolRevenue`. Inner venue hops are never counted, so nothing
double-counts the underlying DEX adapters. Each swap is valued once on its
core-asset side through upstream's `addOneToken`: the input amount when the
input token is a core asset, otherwise the delivered output.

`addOneToken` converts amounts with `Number()`. As a result, raw volume above
2^53 units is rounded: 2^53+1 becomes 2^53, and 1e18+7 becomes 1e18. The SDK's
`Balances` then sums those values as floats. Fees are passed to `Balances` as
the decoded integers and stay exact. The pre-merge local adapter kept volume
exact; the differential tests document that difference.

## Why a registry

Meow's router is redeployed as execution improves. Instead of hard-coding
router addresses and opening a DefiLlama PR for each new one, the adapter reads
`MeowRouterRegistry.routers()` at the end of every window. The registry is an
append-only, owner-curated list of every router deployment: retiring a router
only stamps the block at which it stopped being served, it stays in `routers()`,
so history never disappears and a new router needs no adapter change. Windows
that end before the registry's deployment block (70680538) use the same five
routers the registry was seeded with, frozen in `SEED_ROUTERS`.

The registry never reads `block.number`: on Arbitrum-based chains it returns
the L1 block, which is unrelated to the L2 heights indexers use. Block numbers
are supplied by the owner and checked for ordering only.

`routers()` is read at exactly the window's end block, the same block that
bounds the log scan. In the DefiLlama SDK, `ChainApi.call` ignores a per-call
`block` and uses the api's own block. The runner pins that block to
`getToBlock()` when it has an RPC provider for the chain, and the published
SDK 5.0.236 ships a `robinhood` provider. The adapter checks this invariant
and throws if `toApi` is not pinned to `getToBlock()`, rather than reading
another block.

The seed fallback uses the same end block. The registry exists from block
70680538, and block 70680537 has the same timestamp, so a timestamp comparison
could send a registry read to a block where the contract has no code.

A router is visible to a window only if its registration transaction was
mined at or before that window's end block. Register a new router before it
serves any swap.

## Local tests

Requires Node 24 (built-in TypeScript type stripping and `node:test`); no
`npm install`, no network.

```sh
npm test                                   # node --test "test/*.test.mjs"
node test/run-against.mjs <path/to/index.ts>   # adapter suite against another copy
```

The tests import the real `aggregators/meow/index.ts`. Its upstream imports
are redirected to local stand-ins (`test/upstream-stubs/`), and the chain,
`FetchOptions`, `ChainApi` and `Balances` are an in-memory model
(`test/harness/chain.mjs`). These are mocks: they show the adapter's logic but
are not an upstream integration run.

Covered:

- the pre-registry seed fallback and the registry boundary, using the real
  shared-timestamp headers
- V3 before and after registration, and later retirement keeping history
- window-end block pinning, including refusal when unpinned
- identical swaps in one transaction
- `PartnerSwap`/`SwapReferral` logs coexisting without adding volume or fees
- native input and output, and zero fees
- a differential run of the final copy against the merged-upstream and legacy
  copies

## Verification against the real SDK

```sh
cd verify
npm ci --ignore-scripts   # @defillama/sdk 5.0.236, typescript 5.9.3 (ethers 6.17.0 via the SDK)
npm run typecheck         # adapters vs real SDK types, upstream compiler options
npm test                  # build to CommonJS, then run the verify/test/ suite
```

- `verify/upstream/` holds unmodified `adapters/types.ts`, `helpers/prices.ts`,
  `helpers/chains.ts` and `helpers/coreAssets.json` from `dimension-adapters@3d66de5`,
  hash-checked by `sync.mjs`.
- The tests use the real `ChainApi`, `Balances` and `addOneToken`. The
  JSON-RPC endpoint is a local mock server and logs are supplied by the test,
  decoded with real ethers.
- The registration codec and builder are checked against ethers.
- Not covered: the upstream runner, block lookup and pricing.

## Upstream integration test (not run by this package)

```sh
git clone https://github.com/DefiLlama/dimension-adapters && cd dimension-adapters
npm i
mkdir -p aggregators/meow && cp <this repo>/aggregators/meow/index.ts aggregators/meow/
npm test aggregators meow 2026-09-22     # one full UTC day
npm test aggregators meow                # latest window, reads the registry on chain
```

Results while writing the pre-merge local version (2026-09-23; not re-run for
the current file):

| Window | Volume | Fees |
|---|---|---|
| 2026-09-21 UTC | $70.03k | $142.82 |
| 2026-09-22 14:00 to 2026-09-23 14:00 UTC | $105.30k | $220.44 |

The 2026-09-21 figure combines 59 swaps on the previous router and 8 on the
current one, which matches both raw `eth_getLogs` and Meow's subgraph.

## Registering HoodAggregatorV3

Status: not deployed, not registered. No V3 address or block exists yet.

1. Deploy V3 and save the raw receipt and transaction:
   `cast receipt <tx> --json --rpc-url $ROBINHOOD_RPC > receipt.json` and
   `cast tx <tx> --json --rpc-url $ROBINHOOD_RPC > transaction.json`.
2. Copy `deployments/hoodaggregator-v3-registration.template.json` and fill it
   in. `fromBlock` is the receipt's L2 `blockNumber`, never Solidity
   `block.number` or the receipt's `l1BlockNumber`.
3. `node tools/v3-registration.mjs <filled-input.json> --out request.json`
   validates the receipt (success, creation, address, block, types, chain 4663
   from the transaction) and prints the exact
   `register(address,uint64,uint32,string)` calldata with `abiVersion` 1 and
   label `HoodAggregatorV3`. It refuses any leftover placeholder, and any
   retirement step: V2 stays registered and unretired.
4. Before broadcasting, verify every `preBroadcastGates` entry against the live
   chain: chain id, registry owner, the five existing entries, V3 not yet
   registered, V2 unretired, deployed runtime hash, deployment block/hash and
   no V3 swaps yet. These are not checked offline.
5. Broadcast from the owner before any V3 swap, then run `postBroadcastChecks`
   and record the registration block.

## Operating the registry

On every router redeploy, from the registry owner:

```sh
cast send 0x7b592Bf516cE94AE28e24e34d709Cb95fE596005 "register(address,uint64,uint32,string)" <newRouter> <deployBlock> 1 "<label>"
cast send 0x7b592Bf516cE94AE28e24e34d709Cb95fE596005 "retire(address,uint64)" <oldRouter> <lastServedL2Block>
```

Retirement is not part of the initial V3 release: V2 remains the rollback
target. `abiVersion` stays `1` while routers emit the same `Swapped` and
`FeeCollected` signatures; `PartnerSwap` and the proposed referral event are
attribution only and are never counted. Registering grants nothing: the registry holds no funds and the
routers do not consult it.
