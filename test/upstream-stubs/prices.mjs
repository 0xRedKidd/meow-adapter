// Stand-in for dimension-adapters `helpers/prices.ts`: `isCoreAsset` and
// `addOneToken` copied from DefiLlama/dimension-adapters@3d66de5631bb747a7b12fd78782ebe5af18e20d0.
// (The local adapter uses isCoreAsset; upstream's merged copy uses addOneToken.)
import coreAssets from "./coreAssets.mjs";

const coreAssetCache = {};

export function isCoreAsset(chain, address) {
  if (!coreAssetCache[chain])
    coreAssetCache[chain] = new Set(Object.values(coreAssets[chain] ?? {}).map((a) => a.toLowerCase()));
  return coreAssetCache[chain].has(address.toLowerCase());
}

export function addOneToken({ chain, balances, token0, amount0, token1, amount1, label }) {
  if (!chain) chain = balances.chain;

  amount0 = normalize(amount0);
  amount1 = normalize(amount1);
  if (isCoreAsset(chain, token0)) {
    balances.add(token0, amount0, label);
    return { token: token0, amount: amount0 };
  } else {
    balances.add(token1, amount1, label);
    return { token: token1, amount: amount1 };
  }

  function normalize(amount) {
    amount = Number(amount);
    return amount < 0 ? amount * -1 : amount;
  }
}
