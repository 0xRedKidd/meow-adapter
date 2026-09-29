// Independent check of the repository's dependency-free Keccak/EIP-55/ABI
// codec (tools/lib/abi.mjs) and the registration builder against ethers
// 6.17.0 (installed as a dependency of @defillama/sdk 5.0.236). Inputs are
// deterministic pseudo-random plus edge values. Nothing is sent anywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as local from "../../tools/lib/abi.mjs";
import { buildRegistrationRequest } from "../../tools/v3-registration.mjs";

const require = createRequire(import.meta.url);
const { ethers } = require("ethers");
// ethers' exports map hides package.json, so read it by path.
const ETHERS_VERSION = require("../node_modules/ethers/package.json");

// xorshift64* — deterministic so failures are reproducible.
let state = 0x9e3779b97f4a7c15n;
function rand64() {
  state ^= state >> 12n; state ^= (state << 25n) & ((1n << 64n) - 1n); state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & ((1n << 64n) - 1n);
}
const randBytes = (n) => Uint8Array.from({ length: n }, () => Number(rand64() & 0xffn));
const randAddress = () => ethers.hexlify(randBytes(20));
const randInt = (max) => Number(rand64() % BigInt(max));

const REGISTER = "register(address,uint64,uint32,string)";
const REGISTRY_IFACE = new ethers.Interface([
  `function ${REGISTER}`,
  "function routers() view returns (address[])",
  "function owner() view returns (address)",
  "event RouterRegistered(address indexed router, uint64 fromBlock, uint64 retiredBlock, uint32 abiVersion, string label)",
]);
const EVENTS = [
  "event Swapped(address indexed sender, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
  "event FeeCollected(address indexed token, address indexed recipient, uint256 amount)",
  "event PartnerSwap(uint256 indexed partnerId, address indexed sender, address indexed tokenOut, uint256 amountOut, uint256 fee)",
  "event SwapReferral(bytes32 indexed referralHash, uint256 indexed partnerId, bytes referralData)",
  "event RouterRegistered(address indexed router, uint64 fromBlock, uint64 retiredBlock, uint32 abiVersion, string label)",
];

test("ethers version under comparison", () => {
  assert.equal(ETHERS_VERSION.version, "6.17.0");
});

test("keccak256 matches ethers for 600 random inputs incl. rate-boundary lengths", () => {
  const lengths = [0, 1, 31, 32, 33, 135, 136, 137, 271, 272, 273, 1000];
  for (let i = 0; i < 600; i++) {
    const bytes = randBytes(i < lengths.length ? lengths[i] : randInt(400));
    assert.equal(local.keccak256(bytes), ethers.keccak256(bytes));
  }
  assert.equal(local.keccak256("register(address,uint64,uint32,string)"), ethers.id(REGISTER));
});

test("EIP-55 checksum and validity match ethers for 500 random addresses and case mutations", () => {
  for (let i = 0; i < 500; i++) {
    const a = randAddress();
    const cs = ethers.getAddress(a);
    assert.equal(local.toChecksumAddress(a), cs);
    assert.ok(local.isValidAddress(cs));
    // flip the case of one letter: ethers rejects iff our validator rejects
    const idx = [...cs].findIndex((c, j) => j > 1 && /[a-fA-F]/.test(c) && rand64() % 2n === 0n);
    if (idx < 0) continue;
    const c = cs[idx];
    const mutated = cs.slice(0, idx) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + cs.slice(idx + 1);
    let ethersOk = true;
    try { ethers.getAddress(mutated); } catch { ethersOk = false; }
    assert.equal(local.isValidAddress(mutated), ethersOk, mutated);
  }
});

test("seed #2: original literal fails ethers checksum, corrected literal passes, same 20 bytes", () => {
  const original = "0xcbA20b3109ef4944DeAfC265B4b3d38316a3a17A";
  const corrected = "0xcBA20B3109Ef4944dEAFc265B4b3D38316A3a17a";
  assert.throws(() => ethers.getAddress(original), /bad address checksum/);
  assert.equal(ethers.getAddress(corrected), corrected);
  assert.equal(original.toLowerCase(), corrected.toLowerCase());
  for (const s of JSON.parse(readFileSync(new URL("../../deployments/meow-router-registry-4663.json", import.meta.url))).seeds)
    assert.equal(ethers.getAddress(s.router), s.router);
});

test("selectors and event topics match ethers", () => {
  assert.equal(local.selector(REGISTER), REGISTRY_IFACE.getFunction("register").selector);
  assert.equal(local.selector(REGISTER), "0x5a986cb5");
  assert.equal(local.selector("routers()"), REGISTRY_IFACE.getFunction("routers").selector);
  for (const e of EVENTS) assert.equal(local.parseFragment(e).topic0, ethers.EventFragment.from(e).topicHash);
});

test("register calldata matches ethers for random and edge uint64/uint32/label inputs, both directions", () => {
  const u64 = [0n, 1n, 2n ** 32n, 2n ** 53n - 1n, 2n ** 53n + 1n, 2n ** 63n, 2n ** 64n - 1n, 70680538n, 75760453n];
  const u32 = [0n, 1n, 2n ** 31n, 2n ** 32n - 1n];
  const labels = ["", "HoodAggregatorV3", "x".repeat(31), "y".repeat(32), "z".repeat(33), "ünïcödé ✓ 🐱", "a".repeat(200)];
  for (let i = 0; i < 400; i++) {
    const router = ethers.getAddress(randAddress());
    const fromBlock = i < u64.length ? u64[i] : rand64();
    const abiVersion = i < u32.length ? u32[i] : rand64() & 0xffffffffn;
    const label = i < labels.length ? labels[i] : Buffer.from(randBytes(randInt(80))).toString("base64");
    const mine = local.encodeCall(REGISTER, [router, fromBlock, abiVersion, label]);
    const theirs = REGISTRY_IFACE.encodeFunctionData("register", [router, fromBlock, abiVersion, label]);
    assert.equal(mine, theirs);
    const back = local.decodeParams(["address", "uint64", "uint32", "string"], theirs.slice(10));
    assert.deepEqual(back, [router, fromBlock, abiVersion, label]);
  }
  assert.throws(() => local.encodeCall(REGISTER, [ethers.ZeroAddress, 2n ** 64n, 1, ""]), /out of range/);
});

test("builder output equals ethers encoding for random valid synthetic receipts (TEST_ONLY values)", () => {
  const blocks = [70680539, 75760454, 2 ** 53 - 1];
  for (let i = 0; i < 100; i++) {
    const router = ethers.getAddress(randAddress());
    const block = i < blocks.length ? blocks[i] : 70680539 + randInt(1e9);
    const hash = ethers.hexlify(randBytes(32));
    const blockHash = ethers.hexlify(randBytes(32));
    const from = "0x7E4CEFA712BB2080623b96fEf6c1d327FC965553";
    const receipt = { transactionHash: hash, blockHash, blockNumber: ethers.toQuantity(block), status: "0x1", from, to: null, contractAddress: router, logs: [] };
    const transaction = { hash, blockHash, blockNumber: receipt.blockNumber, chainId: "0x1237", from, to: null };
    const input = {
      schema: "meow-router-registration-input/v1", chainId: 4663, registry: "0x7b592Bf516cE94AE28e24e34d709Cb95fE596005",
      router, fromBlock: block, abiVersion: 1, label: "HoodAggregatorV3",
      deploymentReceipt: "r.json", deploymentTransaction: "t.json", expectedRuntimeCodeHash: ethers.hexlify(randBytes(32)), retire: [],
    };
    const req = buildRegistrationRequest(input, { receipt: JSON.stringify(receipt), transaction: JSON.stringify(transaction) });
    assert.equal(req.calldata, REGISTRY_IFACE.encodeFunctionData("register", [router, block, 1, "HoodAggregatorV3"]));
    const decoded = REGISTRY_IFACE.decodeFunctionData("register", req.calldata);
    assert.deepEqual([decoded[0], decoded[1], decoded[2], decoded[3]], [router, BigInt(block), 1n, "HoodAggregatorV3"]);
    assert.ok(req.preBroadcastGates.every((g) => g.status === "PENDING_OPERATOR_VERIFICATION"));
  }
});

test("event log encoding/decoding matches ethers", () => {
  for (let i = 0; i < 100; i++) {
    const [a, b, c, d] = [0, 1, 2, 3].map(() => ethers.getAddress(randAddress()));
    const x = rand64() * rand64() * rand64();
    const y = rand64();
    const data = ethers.hexlify(randBytes(randInt(70)));
    const cases = [
      [EVENTS[0], { sender: a, recipient: b, tokenIn: c, tokenOut: d, amountIn: x, amountOut: y }],
      [EVENTS[1], { token: a, recipient: b, amount: x }],
      [EVENTS[2], { partnerId: y, sender: a, tokenOut: c, amountOut: x, fee: y }],
      [EVENTS[3], { referralHash: ethers.keccak256(data), partnerId: y, referralData: data }],
      [EVENTS[4], { router: a, fromBlock: y, retiredBlock: 0n, abiVersion: 1n, label: "HoodAggregatorV3" }],
    ];
    for (const [frag, args] of cases) {
      const f = ethers.EventFragment.from(frag);
      const iface = new ethers.Interface([f]);
      const theirs = iface.encodeEventLog(f, f.inputs.map((p) => args[p.name]));
      const mine = local.encodeEventLog(frag, args);
      assert.deepEqual(mine.topics, theirs.topics);
      assert.equal(mine.data, theirs.data);
      assert.deepEqual(local.decodeEventLog(frag, theirs), args);
    }
  }
});

test("live registry snapshot @75760453 (captured 2026-09-29T15:35:21Z) decodes to the recorded owner and five seeds", () => {
  const live = JSON.parse(readFileSync(new URL("../../test/fixtures/live-registry-75760453.json", import.meta.url)));
  const record = JSON.parse(readFileSync(new URL("../../deployments/meow-router-registry-4663.json", import.meta.url)));
  assert.equal(live.blockNumber, 75760453);
  const [owner] = REGISTRY_IFACE.decodeFunctionResult("owner", live.rawCalls["owner()"].result);
  const [routers] = REGISTRY_IFACE.decodeFunctionResult("routers", live.rawCalls["routers()"].result);
  assert.equal(owner, record.owner);
  assert.deepEqual([...routers], record.seeds.map((s) => s.router));
  assert.deepEqual(local.decodeParams(["address"], live.rawCalls["owner()"].result), [record.owner]);
});
