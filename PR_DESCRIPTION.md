<!-- Body for the DefiLlama/dimension-adapters pull request. Fill the bracketed fields. -->

## Add Meow aggregator adapter (Robinhood Chain)

**Name:** Meow
**Website:** https://meow.exchange
**X:** https://x.com/meowdotexchange
**Logo:** [direct PNG/SVG URL, square]
**Category:** DEX Aggregator
**Chains:** Robinhood Chain (`robinhood`, chain id 4663)
**Launch:** 2026-08-11 (first router deployment, block 33693446)
**Token:** none

**Description:** Meow is a DEX aggregator on Robinhood Chain that routes swaps
across the chain's Uniswap v2/v3/v4, Sushi, PancakeSwap, up., GIGA, Sheriff,
Ramses and Pons venues through a single audited router, with split and
multi-hop execution and a 0.25% output fee.

### Methodology

- **Volume:** every `Swapped` event emitted by a Meow router, counted once per
  swap on the core-asset side of the trade (input amount when the input token
  is a core asset, otherwise the delivered output). Inner venue hops are not
  counted, so nothing double-counts the underlying DEX adapters.
- **Fees / Revenue / ProtocolRevenue:** the router's own output fee, taken from
  each swap and emitted as `FeeCollected(token, recipient, amount)`. All of it
  accrues to the Meow treasury; underlying pool fees are excluded.
  SupplySideRevenue is 0.
- **Router discovery:** routers are read on-chain from `MeowRouterRegistry`
  at `0x7b592Bf516cE94AE28e24e34d709Cb95fE596005` (verified source: https://repo.sourcify.dev/4663/0x7b592Bf516cE94AE28e24e34d709Cb95fE596005), an
  append-only, owner-curated list of every Meow router deployment. Reading it
  at the end of the window returns all routers ever registered, retired ones
  included, so historical days stay complete and new deployments need no
  adapter change. Windows before the registry's deployment block
  `70680538` use the same five seed routers hard-coded in the file.

### Test

```
npm test aggregators meow 2026-09-22
[paste the run output]
```
