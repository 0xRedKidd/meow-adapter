// Final adapter vs merged upstream copy vs legacy local copy on IDENTICAL
// logs and correctly pinned windows. MOCK chain/runner/Balances; the helper
// is upstream's addOneToken copied verbatim (test/upstream-stubs/prices.mjs).
// Real-SDK Balances behaviour is covered separately in verify/.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { keccak256 } from "../tools/lib/abi.mjs";
import { buildRegistrationRequest } from "../tools/v3-registration.mjs";
import { MockChain, makeOptions } from "./harness/chain.mjs";
import { LEGACY_LOCAL_URL, MERGED_UPSTREAM_URL, loadAdapter } from "./harness/load-adapter.mjs";
import * as F from "./fixtures.mjs";

const finalAdapter = await loadAdapter();
const merged = await loadAdapter(MERGED_UPSTREAM_URL);
const legacy = await loadAdapter(LEGACY_LOCAL_URL);

let chain;
let seq;
const tx = () => "0x" + (++seq).toString(16).padStart(64, "0");

function swap(router, block, { tokenIn = F.USDG, tokenOut = F.WETH, amountIn = 1000n, amountOut = 997n, fee = 3n, feeToken = F.WETH, t = tx(), li = 0 } = {}) {
  if (fee !== null) chain.emit({ address: router, block, tx: t, logIndex: li, fragment: F.EVENT_FEE_COLLECTED, args: { token: feeToken, recipient: F.TEST_TREASURY, amount: fee } });
  chain.emit({ address: router, block, tx: t, logIndex: li + 1, fragment: F.EVENT_SWAPPED, args: { sender: F.TEST_TRADER, recipient: F.TEST_TRADER, tokenIn, tokenOut, amountIn, amountOut } });
  return t;
}

function populate() {
  const { receipt, transaction } = F.syntheticDeployment();
  const req = buildRegistrationRequest(F.registrationInput(), { receipt: JSON.stringify(receipt), transaction: JSON.stringify(transaction) });
  chain.sendRegistryTx(F.TEST_V3_REGISTRATION_BLOCK, req.calldata);
  const blocks = [70_600_010, 70_690_000, 71_000_050, 71_000_200];
  for (const b of blocks) {
    swap(F.V2, b);
    swap(F.V1, b, { amountIn: 7n, fee: 0n }); // retired router
    swap(F.V2, b, { tokenIn: F.ZERO, tokenOut: F.TEST_TOKEN, amountIn: 10n ** 18n + 7n, amountOut: 5n, feeToken: F.TEST_TOKEN });
    swap(F.V2, b, { tokenIn: F.TEST_TOKEN, tokenOut: F.ZERO, amountIn: 1n, amountOut: 3n * 10n ** 17n + 1n });
    swap(F.V2, b, { tokenIn: F.TEST_TOKEN, tokenOut: "0x6666666666666666666666666666666666666666", amountIn: 8n, amountOut: 7n, fee: null });
    const t = tx();
    swap(F.V2, b, { t, li: 0 });
    swap(F.V2, b, { t, li: 2 }); // identical twin
    chain.emit({ address: F.V2, block: b, tx: t, logIndex: 4, fragment: F.EVENT_PARTNER_SWAP, args: { partnerId: 7n, sender: F.TEST_TRADER, tokenOut: F.WETH, amountOut: 997n, fee: 3n } });
    chain.emit({ address: F.V2, block: b, tx: t, logIndex: 5, fragment: F.EVENT_SWAP_REFERRAL, args: { referralHash: keccak256("r"), partnerId: 7n, referralData: "0x72" } });
    swap(F.TEST_V3, b, { amountIn: 11n });
  }
}

const WINDOWS = [
  ["pre-registry", 70_600_000, 70_600_999],
  ["post-registry", 70_689_000, 70_690_999],
  ["V3 deployed, not yet registered", 71_000_000, F.TEST_V3_REGISTRATION_BLOCK - 1],
  ["V2 + V3 after registration", F.TEST_V3_REGISTRATION_BLOCK, 71_000_999],
];

const summary = (r) =>
  Object.fromEntries(
    ["dailyVolume", "dailyFees", "dailyRevenue", "dailyProtocolRevenue"].map((k) => [k, r[k].calls.map(({ key, raw, label }) => ({ key, raw, label }))]),
  );

beforeEach(() => {
  seq = 0;
  chain = new MockChain({ latestBlock: 75_760_453 });
  chain.deployRegistry({ address: F.REGISTRY, block: F.REGISTRY_BLOCK, seeds: F.SEEDS });
  populate();
});

describe("final vs merged upstream (same helper): identical accounting", () => {
  for (const [label, fromBlock, toBlock] of WINDOWS) {
    test(label, async () => {
      const a = await finalAdapter.fetch(makeOptions(chain, { fromBlock, toBlock }));
      const ethCallsFinal = chain.ethCalls.length;
      const b = await merged.fetch(makeOptions(chain, { fromBlock, toBlock }));
      assert.deepEqual(summary(a), summary(b));
      assert.equal(a.dailySupplySideRevenue, b.dailySupplySideRevenue);
      assert.equal(chain.ethCalls.length, 2 * ethCallsFinal);
      assert.ok(a.dailyVolume.calls.length > 0);
    });
  }
});

describe("legacy local vs final: documented differences only", () => {
  test("same selected sides and keys; native via addGasToken vs add(0x0); amounts rounded through Number", async () => {
    const [, fromBlock, toBlock] = WINDOWS[3];
    const f = await finalAdapter.fetch(makeOptions(chain, { fromBlock, toBlock }));
    const l = await legacy.fetch(makeOptions(chain, { fromBlock, toBlock }));
    const fv = f.dailyVolume.calls;
    const lv = l.dailyVolume.calls;
    assert.equal(fv.length, lv.length);
    for (let i = 0; i < fv.length; i++) {
      assert.equal(fv[i].key, lv[i].key);
      assert.equal(typeof lv[i].raw, "bigint"); // legacy: raw decoded integer
      assert.equal(typeof fv[i].raw, "number"); // upstream helper: Number(amount)
      assert.equal(fv[i].raw, Number(lv[i].raw));
      if (lv[i].key.endsWith(F.ZERO)) {
        assert.equal(lv[i].method, "addGasToken");
        assert.equal(fv[i].method, "add");
      }
    }
    // 1e18 + 7 and 3e17 + 1 are not representable; the helper rounds them.
    const lost = lv.reduce((s, c, i) => s + (c.raw - BigInt(fv[i].raw)), 0n);
    assert.equal(lost, 7n + 1n);
    // Fees are passed through unchanged by both.
    assert.deepEqual(summary(f).dailyFees, summary(l).dailyFees);
  });
});
