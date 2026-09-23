# Meow DefiLlama adapter

DefiLlama dimension adapter for [Meow](https://meow.exchange), a DEX aggregator on
Robinhood Chain (chain id 4663), plus the on-chain router registry it reads.

## Layout

| Path | What it is |
|---|---|
| `aggregators/meow/index.ts` | The adapter, at the path it takes inside [`DefiLlama/dimension-adapters`](https://github.com/DefiLlama/dimension-adapters). |
| `contracts/MeowRouterRegistry.sol` | Source of the registry at `0x7b592Bf516cE94AE28e24e34d709Cb95fE596005` (Solidity 0.8.26, optimizer 100 runs, cancun). Verified on [Sourcify](https://repo.sourcify.dev/4663/0x7b592Bf516cE94AE28e24e34d709Cb95fE596005) with an exact creation and runtime match. |
| `deployments/meow-router-registry-4663.json` | Deployment record: tx, block, seeded routers. |
| `PR_DESCRIPTION.md` | Body for the DefiLlama pull request. |

## How volume is counted

Every settled swap emits `Swapped(sender, recipient, tokenIn, tokenOut, amountIn, amountOut)`
once on the router that executed it, and the router's own output fee emits
`FeeCollected(token, recipient, amount)` in the same transaction. The adapter
sums these into `dailyVolume`, `dailyFees`, `dailyRevenue` and
`dailyProtocolRevenue`. Inner venue hops are never counted, so nothing
double-counts the underlying DEX adapters. Each swap is valued once on its
core-asset side (input amount when the input token is a core asset, otherwise
the delivered output).

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

## Testing

```sh
git clone https://github.com/DefiLlama/dimension-adapters && cd dimension-adapters
npm i
mkdir -p aggregators/meow && cp <this repo>/aggregators/meow/index.ts aggregators/meow/
npm test aggregators meow 2026-09-22     # one full UTC day
npm test aggregators meow                # latest window, reads the registry on chain
```

Results while writing this (2026-09-23):

| Window | Volume | Fees |
|---|---|---|
| 2026-09-21 UTC | $70.03k | $142.82 |
| 2026-09-22 14:00 to 2026-09-23 14:00 UTC | $105.30k | $220.44 |

The 2026-09-21 figure combines 59 swaps on the previous router and 8 on the
current one, which matches both raw `eth_getLogs` and Meow's subgraph.

## Operating the registry

On every router redeploy, from the registry owner:

```sh
cast send 0x7b592Bf516cE94AE28e24e34d709Cb95fE596005 "register(address,uint64,uint32,string)" <newRouter> <deployBlock> 1 "<label>"
cast send 0x7b592Bf516cE94AE28e24e34d709Cb95fE596005 "retire(address,uint64)" <oldRouter> <lastServedL2Block>
```

`abiVersion` stays `1` while routers emit the same `Swapped` and `FeeCollected`
signatures. Registering grants nothing: the registry holds no funds and the
routers do not consult it.
