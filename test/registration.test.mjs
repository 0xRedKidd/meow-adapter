// Registration request builder. All deployment data here is TEST_ONLY
// synthetic (see fixtures.mjs); the committed template must stay refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRegistrationRequest, RegistrationRefused } from "../tools/v3-registration.mjs";
import * as F from "./fixtures.mjs";

const CLI = fileURLToPath(new URL("../tools/v3-registration.mjs", import.meta.url));
const TEMPLATE = fileURLToPath(new URL("../deployments/hoodaggregator-v3-registration.template.json", import.meta.url));

function files(mutate = {}) {
  const { receipt, transaction } = F.syntheticDeployment();
  Object.assign(receipt, mutate.receipt ?? {});
  Object.assign(transaction, mutate.transaction ?? {});
  return { receipt: JSON.stringify(receipt), transaction: JSON.stringify(transaction) };
}

const build = (inputOverrides = {}, mutate = {}) => buildRegistrationRequest(F.registrationInput(inputOverrides), files(mutate));

function refused(fn, pattern) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof RegistrationRefused, `expected refusal, got ${e}`);
    assert.match(e.message, pattern);
    return true;
  });
}

describe("request contents", () => {
  test("exact register(address,uint64,uint32,string) calldata", () => {
    const req = build();
    const w = (hex) => hex.padStart(64, "0");
    const label = Buffer.from("HoodAggregatorV3").toString("hex");
    // Hand-assembled ABI layout, independent of encodeParams.
    const expected =
      "0x5a986cb5" +
      w(F.TEST_V3.slice(2).toLowerCase()) +
      w(F.TEST_V3_DEPLOY_BLOCK.toString(16)) +
      w("1") +
      w("80") +
      w((label.length / 2).toString(16)) +
      label.padEnd(64, "0");
    assert.equal(req.function.selector, "0x5a986cb5");
    assert.equal(req.calldata, expected);
    assert.deepEqual(req.function.args, { router: F.TEST_V3, fromBlock: F.TEST_V3_DEPLOY_BLOCK, abiVersion: 1, label: "HoodAggregatorV3" });
  });

  test("targets the deployed registry from its owner; register only; V2 preserved", () => {
    const req = build();
    assert.equal(req.status, "PREPARED_NOT_BROADCAST");
    assert.equal(req.registry, "0x7b592Bf516cE94AE28e24e34d709Cb95fE596005");
    assert.equal(req.chainId, 4663);
    assert.equal(req.sender, F.REGISTRY_RECORD.owner);
    assert.deepEqual(req.operations, ["register"]);
    assert.ok(!req.calldata.includes("retire"));
    const v2 = req.preservedRouters.find((r) => r.label === "HoodAggregatorV2");
    assert.equal(v2.router, F.V2);
    assert.equal(v2.retiredBlock, 0);
  });

  test("uses the receipt's L2 block and records the L1 block only as information", () => {
    const req = build();
    assert.equal(req.evidence.deploymentBlockNumberL2, F.TEST_V3_DEPLOY_BLOCK);
    assert.equal(req.evidence.receiptL1BlockNumber, F.TEST_V3_L1_BLOCK);
    assert.equal(req.function.args.fromBlock, F.TEST_V3_DEPLOY_BLOCK);
  });

  test("on-chain gates stay explicit and pending", () => {
    const req = build();
    const ids = req.preBroadcastGates.map((g) => g.id);
    for (const id of ["chain", "owner", "prior-entries", "prior-count", "not-registered", "v2-active", "runtime", "deploy-block", "deploy-block-hash", "no-v3-swaps-yet"])
      assert.ok(ids.includes(id), `missing gate ${id}`);
    assert.ok(req.preBroadcastGates.every((g) => g.status === "PENDING_OPERATOR_VERIFICATION"));
    assert.deepEqual(req.preBroadcastGates.find((g) => g.id === "prior-entries").expect, F.SEED_ROUTERS);
    assert.equal(req.preBroadcastGates.find((g) => g.id === "runtime").expect, "0x" + "ef".repeat(32));
  });
});

describe("refusals", () => {
  test("unfilled placeholders", () => refused(() => build({ router: "<V3_ROUTER_ADDRESS>" }), /placeholder at \$\.router/));
  test("missing field", () => refused(() => build({ expectedRuntimeCodeHash: null }), /placeholder at \$\.expectedRuntimeCodeHash/));
  test("fromBlock given as Solidity block.number (receipt l1BlockNumber)", () =>
    refused(() => build({ fromBlock: F.TEST_V3_L1_BLOCK + 70_000_000 }, { receipt: { l1BlockNumber: "0x" + (F.TEST_V3_L1_BLOCK + 70_000_000).toString(16) } }), /l1BlockNumber.*block\.number/));
  test("fromBlock differs from the receipt", () => refused(() => build({ fromBlock: F.TEST_V3_DEPLOY_BLOCK + 1 }), /does not equal the receipt's L2 blockNumber/));
  test("fromBlock as a string", () => refused(() => build({ fromBlock: String(F.TEST_V3_DEPLOY_BLOCK) }), /positive integer/));
  test("failed deployment", () => refused(() => build({}, { receipt: { status: "0x0" } }), /status/));
  test("receipt address mismatch", () => refused(() => build({}, { receipt: { contractAddress: F.TEST_LATE_ROUTER } }), /contractAddress .* does not match/));
  test("receipt block as a decimal number", () => refused(() => build({}, { receipt: { blockNumber: F.TEST_V3_DEPLOY_BLOCK } }), /hex quantity/));
  test("not a contract creation", () => refused(() => build({}, { receipt: { to: F.REGISTRY } }), /receipt\.to must be null/));
  test("wrong chain", () => refused(() => build({}, { transaction: { chainId: "0xa4b1" } }), /chainId is 42161/));
  test("chain unprovable", () => refused(() => build({}, { transaction: { chainId: undefined } }), /chainId missing/));
  test("transaction/receipt mismatch", () => refused(() => build({}, { transaction: { hash: "0x" + "00".repeat(32) } }), /transaction\.hash/));
  test("bad checksum", () => refused(() => build({ router: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD" }), /EIP-55/));
  test("re-registering V2", () => refused(() => build({ router: F.V2 }), /already registered as "HoodAggregatorV2"/));
  test("abiVersion other than 1", () => refused(() => build({ abiVersion: 2 }), /abiVersion must be 1/));
  test("different label", () => refused(() => build({ label: "HoodAggregatorV3 " }), /label must be exactly/));
  test("retirement in the initial release", () => refused(() => build({ retire: [{ router: F.V2, retiredBlock: 71_000_000 }] }), /retire must be absent or empty/));
  test("block before V2/registry", () => refused(() => build({ fromBlock: 69_000_000 }), /not after the registry deployment block/));
  test("registry/chain constants", () => {
    refused(() => build({ registry: F.TEST_LATE_ROUTER }), /registry must be/);
    refused(() => build({ chainId: "4663" }), /chainId must be the number 4663/);
  });
});

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "meow-registration-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("committed template is refused with every placeholder listed", () => {
    const r = spawnSync(process.execPath, [CLI, TEMPLATE], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    for (const f of ["router", "fromBlock", "deploymentReceipt", "deploymentTransaction", "expectedRuntimeCodeHash"]) assert.match(r.stderr, new RegExp(`placeholder at \\$\\.${f}\\b`));
    assert.equal(r.stdout, "");
  });

  test("filled input with receipt files builds and writes the request", () => {
    const { receipt, transaction } = F.syntheticDeployment();
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ jsonrpc: "2.0", id: 1, result: receipt }));
    writeFileSync(join(dir, "transaction.json"), JSON.stringify(transaction));
    writeFileSync(join(dir, "input.json"), JSON.stringify(F.registrationInput()));
    const out = join(dir, "request.json");
    const r = spawnSync(process.execPath, [CLI, join(dir, "input.json"), "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const req = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(JSON.parse(r.stdout), req);
    assert.equal(req.calldata.slice(0, 10), "0x5a986cb5");
  });

  test("missing receipt file is an IO error, not a request", () => {
    writeFileSync(join(dir, "input2.json"), JSON.stringify(F.registrationInput({ deploymentReceipt: "nope.json" })));
    const r = spawnSync(process.execPath, [CLI, join(dir, "input2.json")], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  });
});
