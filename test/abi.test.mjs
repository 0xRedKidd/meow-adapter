// Known-answer tests for the dependency-free Keccak/ABI helpers the
// registration builder and the harness rely on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEventLog, decodeParams, encodeEventLog, encodeParams, isValidAddress, keccak256, parseFragment, selector, toChecksumAddress } from "../tools/lib/abi.mjs";

test("keccak256 known vectors", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(keccak256("Transfer(address,address,uint256)"), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
});

test("keccak256 across the 136-byte rate boundary is consistent", () => {
  for (const n of [135, 136, 137, 272]) assert.match(keccak256("a".repeat(n)), /^0x[0-9a-f]{64}$/);
  assert.notEqual(keccak256("a".repeat(135)), keccak256("a".repeat(136)));
});

test("EIP-55 vectors from the EIP", () => {
  for (const a of [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ]) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a);
    assert.ok(isValidAddress(a));
  }
  assert.ok(!isValidAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"));
});

test("static/dynamic tuple round-trip", () => {
  const types = ["address", "uint64", "uint32", "string"];
  const enc = encodeParams(types, ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", 71000000, 1, "HoodAggregatorV3"]);
  assert.deepEqual(decodeParams(types, enc), ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", 71000000n, 1n, "HoodAggregatorV3"]);
  assert.throws(() => encodeParams(["uint64"], [1n << 64n]), /out of range/);
});

test("event encode/decode round-trip and topic0", () => {
  const frag = "event FeeCollected(address indexed token, address indexed recipient, uint256 amount)";
  assert.equal(parseFragment(frag).signature, "FeeCollected(address,address,uint256)");
  const log = encodeEventLog(frag, { token: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", recipient: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", amount: 5n });
  assert.equal(log.topics.length, 3);
  assert.deepEqual(decodeEventLog(frag, log), { token: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", recipient: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", amount: 5n });
});
