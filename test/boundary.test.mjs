// Registry-deployment boundary with the REAL headers: blocks 70680537 and
// 70680538 both have timestamp 1790183334. MOCK chain/runner (see
// test/harness/chain.mjs). Compares the final adapter with the merged
// upstream copy, whose fallback is `toTimestamp < 1790183334`.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { CHAIN_NAME, MockChain, REAL_HEADERS, makeOptions } from "./harness/chain.mjs";
import { MERGED_UPSTREAM_URL, loadAdapter } from "./harness/load-adapter.mjs";
import * as F from "./fixtures.mjs";

const finalAdapter = await loadAdapter();
const mergedAdapter = await loadAdapter(MERGED_UPSTREAM_URL);
const B = F.REGISTRY_BLOCK;
const TS = 1790183334;
const USDG_KEY = `${CHAIN_NAME}:${F.USDG.toLowerCase()}`;

let chain;
beforeEach(() => {
  chain = new MockChain({ latestBlock: 75_760_453 });
  chain.deployRegistry({ address: F.REGISTRY, block: B, seeds: F.SEEDS });
  // One V2 swap in each block around the boundary.
  for (const [i, block] of [B - 2, B - 1, B, B + 1].entries()) {
    const tx = "0x" + (i + 1).toString(16).padStart(64, "0");
    chain.emit({ address: F.V2, block, tx, logIndex: 0, fragment: F.EVENT_SWAPPED, args: { sender: F.TEST_TRADER, recipient: F.TEST_TRADER, tokenIn: F.USDG, tokenOut: F.WETH, amountIn: 10n ** BigInt(i), amountOut: 1n } });
  }
});

describe("real boundary headers", () => {
  test("fixture holds the real headers: 70680537 and 70680538 share timestamp 1790183334", () => {
    assert.equal(REAL_HEADERS.get(B - 1), TS);
    assert.equal(REAL_HEADERS.get(B), TS);
    assert.equal(F.REGISTRY_RECORD.blockNumber, B);
    assert.equal(F.REGISTRY_RECORD.blockHash, "0x93ce93d40b08da6c1b9f0fc9fc41751889044918ff476cf47f72c24334c648e5");
  });
});

// Cases: [label, toTimestamp, toBlock]. ts-1 and ts+1 blocks are synthetic
// neighbours (their headers were not captured); ts with B-1 and B is real.
const CASES = [
  ["ts-1 / block B-2 (synthetic)", TS - 1, B - 2],
  ["ts / block B-1 (real header)", TS, B - 1],
  ["ts / block B (real header)", TS, B],
  ["ts+1 / block B+1 (synthetic)", TS + 1, B + 1],
];

describe("final adapter: fallback follows the resolved block", () => {
  const expectCall = { [B - 2]: false, [B - 1]: false, [B]: true, [B + 1]: true };
  for (const [label, toTimestamp, toBlock] of CASES) {
    test(label, async () => {
      const r = await finalAdapter.fetch(makeOptions(chain, { fromBlock: B - 2, toBlock, toTimestamp }));
      if (expectCall[toBlock]) {
        assert.equal(chain.ethCalls.length, 1);
        assert.equal(chain.ethCalls[0].servedAt, toBlock);
      } else assert.equal(chain.ethCalls.length, 0);
      assert.deepEqual(chain.getLogsCalls[0].targets.map((a) => a.toLowerCase()), F.SEED_ROUTERS.map((a) => a.toLowerCase()));
      // Every V2 swap from B-2 up to toBlock is counted exactly once.
      const expected = [B - 2, B - 1, B, B + 1].map((b, i) => (b <= toBlock ? 10n ** BigInt(i) : 0n)).reduce((a, b) => a + b);
      assert.deepEqual(r.dailyVolume.totals(), { [USDG_KEY]: expected });
    });
  }
});

describe("merged upstream copy: fallback follows toTimestamp", () => {
  test("ts-1: seeds, no registry call", async () => {
    await mergedAdapter.fetch(makeOptions(chain, { fromBlock: B - 2, toBlock: B - 2, toTimestamp: TS - 1 }));
    assert.equal(chain.ethCalls.length, 0);
  });

  test("ts with the lookup landing on B-1: reads the registry before it exists", async () => {
    await assert.rejects(
      mergedAdapter.fetch(makeOptions(chain, { fromBlock: B - 2, toBlock: B - 1, toTimestamp: TS })),
      /registry has no code yet/,
    );
    assert.equal(chain.ethCalls[0].servedAt, B - 1);
  });

  test("ts with the lookup landing on B: same result as the final adapter", async () => {
    const merged = await mergedAdapter.fetch(makeOptions(chain, { fromBlock: B - 2, toBlock: B, toTimestamp: TS }));
    const final = await finalAdapter.fetch(makeOptions(chain, { fromBlock: B - 2, toBlock: B, toTimestamp: TS }));
    assert.deepEqual(merged.dailyVolume.calls, final.dailyVolume.calls);
  });
});
