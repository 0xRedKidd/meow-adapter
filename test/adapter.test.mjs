// Executes the real aggregators/meow/index.ts against the in-memory chain model
// in test/harness/chain.mjs. MOCK environment: no RPC, no DefiLlama runner, no
// price conversion. Amounts are checked in raw token units per token.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { isValidAddress, keccak256 } from "../tools/lib/abi.mjs";
import { buildRegistrationRequest } from "../tools/v3-registration.mjs";
import { CHAIN_NAME, MockChain, MockChainApi, makeOptions } from "./harness/chain.mjs";
import { loadAdapter } from "./harness/load-adapter.mjs";
import * as F from "./fixtures.mjs";

const adapter = await loadAdapter();
const key = (token) => `${CHAIN_NAME}:${token.toLowerCase()}`;
const NATIVE_KEY = key(F.ZERO);

let chain;
let txSeq;

function nextTx() {
  txSeq += 1;
  return "0x" + txSeq.toString(16).padStart(64, "0");
}

/** One settled swap: FeeCollected (optional) then Swapped, same tx. */
function swap(router, block, { tokenIn = F.USDG, tokenOut = F.WETH, amountIn = 1000n, amountOut = 997n, fee = 3n, feeToken, tx = nextTx(), logIndex = 0 } = {}) {
  if (fee !== null)
    chain.emit({ address: router, block, tx, logIndex, fragment: F.EVENT_FEE_COLLECTED, args: { token: feeToken ?? (tokenOut === F.ZERO ? F.WETH : tokenOut), recipient: F.TEST_TREASURY, amount: fee } });
  chain.emit({ address: router, block, tx, logIndex: logIndex + 1, fragment: F.EVENT_SWAPPED, args: { sender: F.TEST_TRADER, recipient: F.TEST_TRADER, tokenIn, tokenOut, amountIn, amountOut } });
  return tx;
}

function registerTestV3() {
  const { receipt, transaction } = F.syntheticDeployment();
  const request = buildRegistrationRequest(F.registrationInput(), { receipt: JSON.stringify(receipt), transaction: JSON.stringify(transaction) });
  chain.sendRegistryTx(F.TEST_V3_REGISTRATION_BLOCK, request.calldata);
  return request;
}

const run = (window) => adapter.fetch(makeOptions(chain, window));

beforeEach(() => {
  txSeq = 0;
  chain = new MockChain({ latestBlock: 73_000_000 });
  chain.deployRegistry({ address: F.REGISTRY, block: F.REGISTRY_BLOCK, seeds: F.SEEDS });
});

describe("adapter shape", () => {
  test("metadata unchanged: v2, hourly, robinhood, launch date", () => {
    assert.equal(adapter.version, 2);
    assert.equal(adapter.pullHourly, true);
    assert.deepEqual(adapter.chains, ["robinhood"]);
    assert.equal(adapter.start, "2026-08-11");
    assert.equal(typeof adapter.fetch, "function");
  });
});

describe("pre-registry windows use the five seed routers", () => {
  test("window ending before the registry exists never calls it and scans exactly the seeds", async () => {
    swap(F.V2, 70_600_010);
    swap(F.V1, 70_600_020, { amountIn: 50n, amountOut: 49n, fee: 1n }); // retired router, history still counted
    swap(F.TEST_V3, 70_600_030, { amountIn: 7777n }); // not a seed: must be ignored
    const r = await run({ fromBlock: 70_600_000, toBlock: 70_600_999 });
    assert.equal(chain.ethCalls.length, 0);
    assert.deepEqual(chain.getLogsCalls[0].targets, F.SEED_ROUTERS);
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 1050n });
    assert.deepEqual(r.dailyFees.totals(), { [key(F.WETH)]: 4n });
  });

  test("seed list is exactly the deployment record, every entry a valid EIP-55 address", async () => {
    await run({ fromBlock: 70_600_000, toBlock: 70_600_999 });
    const targets = chain.getLogsCalls[0].targets;
    assert.deepEqual(targets, F.SEED_ROUTERS);
    for (const t of targets) assert.ok(isValidAddress(t), `bad checksum ${t}`);
  });
});

describe("registry boundary", () => {
  test("toBlock = registry block - 1 uses seeds; toBlock = registry block reads the registry at that block", async () => {
    await run({ fromBlock: F.REGISTRY_BLOCK - 100, toBlock: F.REGISTRY_BLOCK - 1 });
    assert.equal(chain.ethCalls.length, 0);
    await run({ fromBlock: F.REGISTRY_BLOCK - 100, toBlock: F.REGISTRY_BLOCK });
    assert.equal(chain.ethCalls.length, 1);
    assert.equal(chain.ethCalls[0].block, F.REGISTRY_BLOCK);
    assert.deepEqual(chain.getLogsCalls.at(-1).targets, F.SEED_ROUTERS);
  });

  test("a window straddling the registry deployment counts logs on both sides once", async () => {
    swap(F.V2, F.REGISTRY_BLOCK - 5);
    swap(F.V2, F.REGISTRY_BLOCK + 5);
    const r = await run({ fromBlock: F.REGISTRY_BLOCK - 10, toBlock: F.REGISTRY_BLOCK + 10 });
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 2000n });
    assert.equal(r.dailyVolume.calls.length, 2);
  });
});

describe("V3 registration (TEST_ONLY V3 address/blocks)", () => {
  test("V3 swaps are invisible to windows ending before the registration block, counted once it is registered", async () => {
    registerTestV3();
    const B = F.TEST_V3_DEPLOY_BLOCK;
    const R = F.TEST_V3_REGISTRATION_BLOCK;
    swap(F.TEST_V3, B + 10, { amountIn: 300n });
    swap(F.V2, B + 20, { amountIn: 200n });

    // Window closes before registration: routers() at R-1 has no V3. This is
    // why the release gate requires registration before any V3 swap.
    const before = await run({ fromBlock: B, toBlock: R - 1 });
    assert.equal(chain.ethCalls.at(-1).block, R - 1);
    assert.ok(!chain.getLogsCalls.at(-1).targets.includes(F.TEST_V3));
    assert.deepEqual(before.dailyVolume.totals(), { [key(F.USDG)]: 200n });

    const after = await run({ fromBlock: B, toBlock: R });
    assert.deepEqual(chain.getLogsCalls.at(-1).targets, [...F.SEED_ROUTERS, F.TEST_V3]);
    assert.deepEqual(after.dailyVolume.totals(), { [key(F.USDG)]: 500n });
  });

  test("V2 keeps being counted alongside V3 after registration", async () => {
    registerTestV3();
    const R = F.TEST_V3_REGISTRATION_BLOCK;
    swap(F.TEST_V3, R + 1, { amountIn: 10n, fee: 1n });
    swap(F.V2, R + 2, { amountIn: 20n, fee: 2n });
    const r = await run({ fromBlock: R, toBlock: R + 100 });
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 30n });
    assert.deepEqual(r.dailyFees.totals(), { [key(F.WETH)]: 3n });
  });

  test("later retirement of a router keeps its history and its later-served logs", async () => {
    registerTestV3();
    swap(F.V2, 71_400_000, { amountIn: 40n });
    swap(F.V2, 71_550_000, { amountIn: 60n });
    // TEST_ONLY future retirement; not part of the initial V3 release.
    chain.sendRegistryTx(71_600_000, "0x" + retireCalldata(F.V2, 71_500_000));

    const historical = await run({ fromBlock: 71_399_000, toBlock: 71_400_999 });
    assert.deepEqual(historical.dailyVolume.totals(), { [key(F.USDG)]: 40n });

    const afterRetire = await run({ fromBlock: 71_549_000, toBlock: 71_700_000 });
    assert.ok(chain.getLogsCalls.at(-1).targets.includes(F.V2));
    assert.deepEqual(afterRetire.dailyVolume.totals(), { [key(F.USDG)]: 60n });
  });
});

function retireCalldata(router, block) {
  // retire(address,uint64); selector computed, not hard-coded.
  const sel = keccak256("retire(address,uint64)").slice(2, 10);
  return sel + router.slice(2).toLowerCase().padStart(64, "0") + block.toString(16).padStart(64, "0");
}

describe("window-end block pinning", () => {
  test("registry read uses exactly getToBlock(), the same block that bounds getLogs", async () => {
    // TEST_ONLY router registered after the window closes; it swapped inside
    // the window (a gate violation), so a latest-state read would count it.
    chain.sendRegistryTx(72_000_000, registerCalldataFor(F.TEST_LATE_ROUTER, 71_999_000));
    swap(F.TEST_LATE_ROUTER, 71_999_500, { amountIn: 9999n });
    swap(F.V2, 71_999_600, { amountIn: 1n });
    const r = await run({ fromBlock: 71_999_000, toBlock: 71_999_999 });
    assert.equal(chain.ethCalls.length, 1);
    assert.equal(chain.ethCalls[0].block, 71_999_999);
    for (const c of chain.getLogsCalls) assert.equal(c.toBlock, 71_999_999);
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 1n });
  });

  test("refuses to read the registry when the runner's api is unpinned (no provider)", async () => {
    await assert.rejects(run({ fromBlock: 71_999_000, toBlock: 71_999_999, apiBlock: null }), /not be pinned to window end block 71999999/);
    assert.equal(chain.ethCalls.length, 0);
    assert.equal(chain.getLogsCalls.length, 0);
  });

  test("refuses when the api is pinned to a different block", async () => {
    await assert.rejects(run({ fromBlock: 71_999_000, toBlock: 71_999_999, apiBlock: 72_000_000 }), /not be pinned/);
    assert.equal(chain.getLogsCalls.length, 0);
  });

  test("refuses an invalid window end block", async () => {
    await assert.rejects(run({ fromBlock: 1, toBlock: null }), /invalid window end block/);
  });

  test("model check: like sdk ChainApi.call, a per-call block is overridden by the api block", async () => {
    const api = new MockChainApi({ chain: CHAIN_NAME, block: 71_000_000 });
    api._mock = chain;
    await api.call({ target: F.REGISTRY, abi: "function routers() view returns (address[])", block: 72_500_000 });
    assert.equal(chain.ethCalls.at(-1).servedAt, 71_000_000);
  });
});

function registerCalldataFor(router, fromBlock) {
  const { receipt, transaction } = F.syntheticDeployment({ router, block: fromBlock });
  return buildRegistrationRequest(F.registrationInput({ router, fromBlock }), { receipt: JSON.stringify(receipt), transaction: JSON.stringify(transaction) }).calldata;
}

describe("canonical accounting", () => {
  const W = { fromBlock: 71_100_000, toBlock: 71_100_999 };

  test("two identical swaps in one transaction are two trades", async () => {
    const tx = nextTx();
    swap(F.V2, 71_100_010, { tx, logIndex: 0 });
    swap(F.V2, 71_100_010, { tx, logIndex: 2 });
    const r = await run(W);
    assert.equal(r.dailyVolume.calls.length, 2);
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 2000n });
    assert.deepEqual(r.dailyFees.totals(), { [key(F.WETH)]: 6n });
  });

  test("PartnerSwap and SwapReferral logs coexist without adding volume, fees or trades", async () => {
    const block = 71_100_020;
    // partner != 0 with referral: FeeCollected, Swapped, PartnerSwap, SwapReferral
    const tx1 = swap(F.V2, block, { amountIn: 1000n, amountOut: 997n, fee: 3n, logIndex: 0 });
    chain.emit({ address: F.V2, block, tx: tx1, logIndex: 2, fragment: F.EVENT_PARTNER_SWAP, args: { partnerId: 7n, sender: F.TEST_TRADER, tokenOut: F.WETH, amountOut: 997n, fee: 3n } });
    const data = "0x00c0ffee";
    chain.emit({ address: F.V2, block, tx: tx1, logIndex: 3, fragment: F.EVENT_SWAP_REFERRAL, args: { referralHash: keccak256(Uint8Array.from([0x00, 0xc0, 0xff, 0xee])), partnerId: 7n, referralData: data } });
    // partner == 0 with referral only
    const tx2 = swap(F.V2, block + 1, { amountIn: 500n, amountOut: 499n, fee: 1n, logIndex: 0 });
    chain.emit({ address: F.V2, block: block + 1, tx: tx2, logIndex: 2, fragment: F.EVENT_SWAP_REFERRAL, args: { referralHash: keccak256("x"), partnerId: 0n, referralData: "0x78" } });

    const r = await run(W);
    assert.equal(chain.logs.length, 7);
    assert.equal(r.dailyVolume.calls.length, 2);
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 1500n });
    assert.equal(r.dailyFees.calls.length, 2);
    assert.deepEqual(r.dailyFees.totals(), { [key(F.WETH)]: 4n });
    const requested = chain.getLogsCalls.map((c) => c.eventAbi);
    assert.ok(requested.every((e) => e.startsWith("event Swapped(") || e.startsWith("event FeeCollected(")), requested.join("\n"));
  });

  test("native input is valued as the gas token on the input side", async () => {
    swap(F.V2, 71_100_030, { tokenIn: F.ZERO, tokenOut: F.TEST_TOKEN, amountIn: 10n ** 18n, amountOut: 5n, fee: 1n, feeToken: F.TEST_TOKEN });
    const r = await run(W);
    assert.deepEqual(r.dailyVolume.totals(), { [NATIVE_KEY]: 10n ** 18n });
    assert.deepEqual(r.dailyFees.totals(), { [key(F.TEST_TOKEN)]: 1n });
  });

  test("native output against a non-core input uses delivered native output; fee is in WETH", async () => {
    swap(F.V2, 71_100_040, { tokenIn: F.TEST_TOKEN, tokenOut: F.ZERO, amountIn: 123n, amountOut: 2n * 10n ** 17n, fee: 5n * 10n ** 14n });
    const r = await run(W);
    assert.deepEqual(r.dailyVolume.totals(), { [NATIVE_KEY]: 2n * 10n ** 17n });
    assert.deepEqual(r.dailyFees.totals(), { [key(F.WETH)]: 5n * 10n ** 14n });
  });

  test("core ERC20 input is preferred; non-core on both sides falls back to output", async () => {
    swap(F.V2, 71_100_050, { tokenIn: F.USDG, tokenOut: F.TEST_TOKEN, amountIn: 100n, amountOut: 9n });
    swap(F.V2, 71_100_051, { tokenIn: F.TEST_TOKEN, tokenOut: "0x6666666666666666666666666666666666666666", amountIn: 8n, amountOut: 7n });
    const r = await run(W);
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 100n, [key("0x6666666666666666666666666666666666666666")]: 7n });
  });

  test("zero protocol fee: FeeCollected(0) and fee-less swaps still count volume, fees stay zero", async () => {
    swap(F.V2, 71_100_060, { amountIn: 100n, fee: 0n });
    swap(F.V2, 71_100_061, { amountIn: 200n, fee: null });
    const r = await run(W);
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 300n });
    assert.deepEqual(r.dailyFees.totals(), { [key(F.WETH)]: 0n });
    assert.deepEqual(r.dailyRevenue.totals(), { [key(F.WETH)]: 0n });
    assert.deepEqual(r.dailyProtocolRevenue.totals(), { [key(F.WETH)]: 0n });
    assert.equal(r.dailySupplySideRevenue, 0);
  });

  test("fees flow to revenue and protocol revenue with their breakdown labels", async () => {
    swap(F.V2, 71_100_070, { fee: 9n });
    const r = await run(W);
    assert.deepEqual(r.dailyFees.calls.map((c) => c.label), ["Swap Fees"]);
    assert.deepEqual(r.dailyRevenue.calls.map((c) => c.label), ["Swap Fees To Protocol"]);
    assert.deepEqual(r.dailyProtocolRevenue.calls.map((c) => c.label), ["Swap Fees To Protocol"]);
    assert.equal(r.dailyRevenue.totals()[key(F.WETH)], 9n);
  });

  test("logs outside the window are excluded at both ends", async () => {
    swap(F.V2, W.fromBlock - 1, { amountIn: 1n });
    swap(F.V2, W.fromBlock, { amountIn: 10n });
    swap(F.V2, W.toBlock, { amountIn: 100n });
    swap(F.V2, W.toBlock + 1, { amountIn: 1000n });
    const r = await run(W);
    assert.deepEqual(r.dailyVolume.totals(), { [key(F.USDG)]: 110n });
  });
});
