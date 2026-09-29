// Executes the compiled adapters (verify/build, from `npm run build`) against
// the REAL @defillama/sdk 5.0.236 ChainApi and Balances and the REAL upstream
// helpers/prices.ts addOneToken + helpers/coreAssets.json (pinned revision).
//
// MOCKED: the JSON-RPC endpoint (a local HTTP server; the SDK is pointed at it
// with ROBINHOOD_WHITELISTED_RPC, which replaces the public RPC list), and the
// runner's getLogs (logs are ABI-encoded and decoded with the real ethers
// Interface, returning the same Result args the SDK's getEventLogs yields).
// Not exercised: the upstream runner itself, block lookup, pricing (getUSDValue).
"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { before, after, describe, test } = require("node:test");
const { ethers } = require("ethers");

const CHAIN = "robinhood";
const REGISTRY = "0x7b592Bf516cE94AE28e24e34d709Cb95fE596005";
const B = 70680538; // registry deployment block (receipt)
const TS = 1790183334; // real timestamp of both 70680537 and 70680538
const SEEDS = require("../../deployments/meow-router-registry-4663.json").seeds.map((s) => s.router);
const V2 = SEEDS[4];
const ZERO = ethers.ZeroAddress;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const TOKEN = "0x1111111111111111111111111111111111111111"; // TEST_ONLY non-core
const TRADER = "0x5555555555555555555555555555555555555555";
const TREASURY = "0x2222222222222222222222222222222222222222";
const TWO53 = 2n ** 53n;

const IFACE = new ethers.Interface([
  "event Swapped(address indexed sender, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
  "event FeeCollected(address indexed token, address indexed recipient, uint256 amount)",
  "event PartnerSwap(uint256 indexed partnerId, address indexed sender, address indexed tokenOut, uint256 amountOut, uint256 fee)",
  "function routers() view returns (address[])",
]);

// ------------------------------------------------------------ mock RPC
const rpcCalls = [];
let registryEntries = []; // [{router, txBlock}]
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = JSON.parse(body);
    const one = (m) => {
      const out = { jsonrpc: "2.0", id: m.id };
      switch (m.method) {
        case "eth_chainId": out.result = "0x1237"; break;
        case "net_version": out.result = "4663"; break;
        case "eth_blockNumber": out.result = ethers.toQuantity(75760453); break;
        case "eth_call": {
          const [{ to, data }, tag] = m.params;
          rpcCalls.push({ to, data, tag });
          const block = tag === "latest" ? 75760453 : Number(BigInt(tag));
          if (to.toLowerCase() !== REGISTRY.toLowerCase() || block < B) out.result = "0x"; // no code
          else out.result = IFACE.encodeFunctionResult("routers", [registryEntries.filter((e) => e.txBlock <= block).map((e) => e.router)]);
          break;
        }
        default: out.error = { code: -32601, message: `unsupported ${m.method}` };
      }
      return out;
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
  });
});

let sdk, addOneToken, finalAdapter, merged, legacy;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.ROBINHOOD_WHITELISTED_RPC = `http://127.0.0.1:${server.address().port}`;
  sdk = require("@defillama/sdk");
  addOneToken = require("../build/helpers/prices").addOneToken;
  finalAdapter = require("../build/aggregators/meow/index").default;
  merged = require("../build/aggregators/meow-merged/index").default;
  legacy = require("../build/aggregators/meow-legacy/index").default;
});
after(() => server.close());

// ------------------------------------------------------------ runner-shaped options
function makeLog(name, args) {
  const frag = IFACE.getEvent(name);
  const { data, topics } = IFACE.encodeEventLog(frag, args);
  return IFACE.parseLog({ data, topics }).args; // ethers Result, like getEventLogs onlyArgs
}

// apiBlock: defaults to toBlock (runner with a provider); null = unpinned api
// with no timestamp (runner's recent-window branch), so nothing resolves it.
function options({ toBlock, apiBlock = toBlock, toTimestamp = TS + 3600, swaps = [], fees = [], logCalls = [] }) {
  const pinned = apiBlock !== null;
  const api = new sdk.ChainApi({ chain: CHAIN, timestamp: pinned ? toTimestamp + 1 : undefined, block: pinned ? apiBlock : undefined });
  assert.equal(api.block, pinned ? apiBlock : undefined);
  const logsByEvent = { Swapped: swaps, FeeCollected: fees };
  return {
    chain: CHAIN,
    toTimestamp,
    fromTimestamp: toTimestamp - 3600,
    getToBlock: async () => toBlock,
    getFromBlock: async () => toBlock - 1000,
    createBalances: () => new sdk.Balances({ chain: CHAIN, timestamp: toTimestamp + 1 }),
    getLogs: async ({ targets, eventAbi }) => {
      logCalls.push({ targets, eventAbi });
      const name = eventAbi.match(/event (\w+)/)[1];
      const set = new Set(targets.map((t) => t.toLowerCase()));
      return (logsByEvent[name] ?? []).filter((l) => set.has(l.router.toLowerCase())).map((l) => l.args);
    },
    api,
    toApi: api,
    fromApi: new sdk.ChainApi({ chain: CHAIN, block: toBlock - 1000 }),
  };
}

const swap = (router, a) => ({ router, args: makeLog("Swapped", [TRADER, TRADER, a.tokenIn, a.tokenOut, a.amountIn, a.amountOut]) });
const fee = (router, token, amount) => ({ router, args: makeLog("FeeCollected", [token, TREASURY, amount]) });
const key = (t) => `${CHAIN}:${t}`;

function reset(extra = []) {
  rpcCalls.length = 0;
  registryEntries = [...SEEDS.map((router) => ({ router, txBlock: B })), ...extra];
}

// ------------------------------------------------------------ tests
describe("real ChainApi: registry read pinning", () => {
  test("toApi pinned to getToBlock(): eth_call carries exactly that block tag", async () => {
    reset();
    const logCalls = [];
    await finalAdapter.fetch(options({ toBlock: 75_000_000, logCalls }));
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].tag, ethers.toQuantity(75_000_000));
    assert.equal(rpcCalls[0].data, IFACE.getFunction("routers").selector);
    assert.deepEqual(logCalls[0].targets, SEEDS);
  });

  test("a per-call block is overwritten by the ChainApi instance block", async () => {
    reset();
    const api = new sdk.ChainApi({ chain: CHAIN, block: 75_000_000 });
    await api.call({ target: REGISTRY, abi: "function routers() view returns (address[])", block: 72_000_000 });
    assert.equal(rpcCalls[0].tag, ethers.toQuantity(75_000_000));
  });

  test("unpinned ChainApi (no block): adapter throws before any eth_call or log scan", async () => {
    reset();
    const logCalls = [];
    await assert.rejects(finalAdapter.fetch(options({ toBlock: 75_000_000, apiBlock: null, logCalls })), /not be pinned/);
    assert.equal(rpcCalls.length, 0);
    assert.equal(logCalls.length, 0);
  });

  test("contrast: merged upstream with the same unpinned ChainApi reads the registry at 'latest'", async () => {
    reset([{ router: "0x4444444444444444444444444444444444444444", txBlock: 75_500_000 }]);
    const logCalls = [];
    await merged.fetch(options({ toBlock: 75_000_000, apiBlock: null, logCalls }));
    assert.equal(rpcCalls[0].tag, "latest");
    // A router registered after the window's end block is scanned for that window.
    assert.ok(logCalls[0].targets.map((a) => a.toLowerCase()).includes("0x4444444444444444444444444444444444444444"));
  });

  test("ChainApi pinned to an earlier or later block: throws before any eth_call", async () => {
    for (const apiBlock of [74_999_999, 75_000_001]) {
      reset();
      await assert.rejects(finalAdapter.fetch(options({ toBlock: 75_000_000, apiBlock })), /not be pinned/);
      assert.equal(rpcCalls.length, 0);
    }
  });

  test("V3 registered at R is visible from R on, not at R-1 (TEST_ONLY V3/R)", async () => {
    const V3 = "0x3333333333333333333333333333333333333333";
    const R = 75_900_000;
    for (const [toBlock, visible] of [[R - 1, false], [R, true]]) {
      reset([{ router: V3, txBlock: R }]);
      const logCalls = [];
      await finalAdapter.fetch(options({ toBlock, logCalls }));
      assert.equal(logCalls[0].targets.map((a) => a.toLowerCase()).includes(V3), visible);
    }
  });
});

describe("real ChainApi at the real shared-timestamp boundary", () => {
  test("final: ts 1790183334 resolved to 70680537 uses seeds with no eth_call", async () => {
    reset();
    const logCalls = [];
    await finalAdapter.fetch(options({ toBlock: B - 1, toTimestamp: TS, logCalls }));
    assert.equal(rpcCalls.length, 0);
    assert.deepEqual(logCalls[0].targets, SEEDS);
  });

  test("final: ts 1790183334 resolved to 70680538 reads the registry at 70680538", async () => {
    reset();
    await finalAdapter.fetch(options({ toBlock: B, toTimestamp: TS }));
    assert.equal(rpcCalls[0].tag, ethers.toQuantity(B));
  });

  test("merged upstream: ts 1790183334 resolved to 70680537 calls the registry before it exists and fails", async () => {
    reset();
    // eth_call to an address without code returns 0x, which the SDK reports as a failed call.
    await assert.rejects(merged.fetch(options({ toBlock: B - 1, toTimestamp: TS })), /Failed to call: function routers\(\)/);
    assert.equal(rpcCalls[0].tag, ethers.toQuantity(B - 1));
  });

  test("merged upstream: ts - 1 uses seeds", async () => {
    reset();
    await merged.fetch(options({ toBlock: B - 2, toTimestamp: TS - 1 }));
    assert.equal(rpcCalls.length, 0);
  });
});

describe("real Balances + real addOneToken", () => {
  const W = { toBlock: 75_000_000 };

  test("native zero address: add(0x0) (final/merged) and addGasToken (legacy) land on the same Balances key", async () => {
    const swaps = [swap(V2, { tokenIn: ZERO, tokenOut: TOKEN, amountIn: 5n * 10n ** 17n, amountOut: 9n })];
    for (const a of [finalAdapter, merged, legacy]) {
      reset();
      const r = await a.fetch(options({ ...W, swaps }));
      assert.deepEqual(Object.keys(r.dailyVolume.getBalances()), [key(ZERO)]);
    }
    const g = new sdk.Balances({ chain: CHAIN });
    g.addGasToken(1n);
    assert.deepEqual(Object.keys(g.getBalances()), [key(ZERO)]);
  });

  test("native output against a non-core input values the output side", async () => {
    reset();
    const r = await finalAdapter.fetch(options({ ...W, swaps: [swap(V2, { tokenIn: TOKEN, tokenOut: ZERO, amountIn: 3n, amountOut: 2n * 10n ** 17n })] }));
    assert.deepEqual(r.dailyVolume.getBalances(), { [key(ZERO)]: 2e17 });
  });

  test("both amount sides: core input -> amountIn; non-core input -> amountOut", async () => {
    reset();
    const r = await finalAdapter.fetch(options({ ...W, swaps: [
      swap(V2, { tokenIn: USDG, tokenOut: TOKEN, amountIn: 100n, amountOut: 9n }),
      swap(V2, { tokenIn: TOKEN, tokenOut: WETH, amountIn: 8n, amountOut: 7n }),
    ] }));
    assert.deepEqual(r.dailyVolume.getBalances(), { [key(USDG)]: 100, [key(WETH)]: 7 });
  });

  test("addOneToken rounds through Number: 2^53-1 exact, 2^53+1 -> 2^53, uneven 18-decimal values rounded", () => {
    const cases = [TWO53 - 1n, TWO53, TWO53 + 1n, 123456789012345678901n, 10n ** 18n + 7n];
    for (const amount of cases) {
      const b = new sdk.Balances({ chain: CHAIN });
      const out = addOneToken({ chain: CHAIN, balances: b, token0: USDG, amount0: amount, token1: TOKEN, amount1: 1n });
      assert.equal(out.amount, Number(amount));
      assert.equal(b.getBalances()[key(USDG)], Number(amount));
    }
    assert.equal(BigInt(Number(TWO53 + 1n)), TWO53);
    assert.equal(BigInt(Number(10n ** 18n + 7n)), 10n ** 18n);
  });

  test("final == merged exactly (same helper rounding); legacy keeps exact integers; documented delta", async () => {
    const amounts = [TWO53 + 1n, 123456789012345678901n, 10n ** 18n + 7n, 3n];
    const swaps = amounts.map((amountIn) => swap(V2, { tokenIn: USDG, tokenOut: TOKEN, amountIn, amountOut: 1n }));
    reset();
    const f = (await finalAdapter.fetch(options({ ...W, swaps }))).dailyVolume.getBalances();
    reset();
    const m = (await merged.fetch(options({ ...W, swaps }))).dailyVolume.getBalances();
    reset();
    const l = (await legacy.fetch(options({ ...W, swaps }))).dailyVolume.getBalances();
    assert.deepEqual(f, m);
    const floatSum = amounts.reduce((s, a) => s + Number(a), 0);
    assert.equal(f[key(USDG)], floatSum); // JS number, summed as float by Balances
    const exact = amounts.reduce((s, a) => s + a, 0n);
    assert.equal(l[key(USDG)], exact.toString()); // legacy: bigint -> exact string
    // Record the difference for the report; it is non-zero by construction.
    assert.notEqual(BigInt(floatSum), exact);
  });

  test("fees stay exact integers; zero fee adds nothing; supply side 0", async () => {
    reset();
    const r = await finalAdapter.fetch(options({ ...W,
      swaps: [swap(V2, { tokenIn: USDG, tokenOut: WETH, amountIn: 10n, amountOut: 9n })],
      fees: [fee(V2, WETH, TWO53 + 1n), fee(V2, WETH, 0n), fee(V2, WETH, 10n ** 18n + 7n)] }));
    const exact = (TWO53 + 1n + 10n ** 18n + 7n).toString();
    assert.deepEqual(r.dailyFees.getBalances(), { [key(WETH)]: exact });
    assert.deepEqual(r.dailyRevenue.getBalances(), { [key(WETH)]: exact });
    assert.deepEqual(r.dailyProtocolRevenue.getBalances(), { [key(WETH)]: exact });
    assert.deepEqual(Object.keys(r.dailyFees.getBreakdownBalances()), ["Swap Fees"]);
    assert.deepEqual(Object.keys(r.dailyRevenue.getBreakdownBalances()), ["Swap Fees To Protocol"]);
    assert.equal(r.dailySupplySideRevenue, 0);

    reset();
    const z = await finalAdapter.fetch(options({ ...W, swaps: [swap(V2, { tokenIn: USDG, tokenOut: WETH, amountIn: 10n, amountOut: 9n })], fees: [fee(V2, WETH, 0n)] }));
    assert.deepEqual(z.dailyFees.getBalances(), {});
    assert.deepEqual(z.dailyVolume.getBalances(), { [key(USDG)]: 10 });
  });

  test("two identical swaps count twice; PartnerSwap is never requested", async () => {
    reset();
    const s = swap(V2, { tokenIn: USDG, tokenOut: WETH, amountIn: 1000n, amountOut: 997n });
    const logCalls = [];
    const r = await finalAdapter.fetch(options({ ...W, swaps: [s, s], logCalls }));
    assert.deepEqual(r.dailyVolume.getBalances(), { [key(USDG)]: 2000 });
    assert.ok(logCalls.every((c) => /event (Swapped|FeeCollected)\(/.test(c.eventAbi)));
  });
});
