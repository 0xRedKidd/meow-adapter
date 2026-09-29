#!/usr/bin/env node
// Offline builder/validator for the HoodAggregatorV3 registration in
// MeowRouterRegistry (chain 4663). It reads a filled release input plus the
// real deployment receipt and transaction (JSON-RPC results), validates them,
// and prints the exact register(address,uint64,uint32,string) request.
//
// It never talks to a network, never signs and never broadcasts. On-chain
// ownership, prior registry entries and the deployed runtime are listed as
// pre-broadcast gates the operator must verify against the live chain.
//
//   node tools/v3-registration.mjs <release-input.json> [--out <request.json>]
//
// Exit codes: 0 request built, 2 input refused, 1 usage/IO error.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeParams, encodeCall, isValidAddress, parseFragment, selector, toChecksumAddress } from "./lib/abi.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_RECORD = JSON.parse(readFileSync(resolve(REPO, "deployments/meow-router-registry-4663.json"), "utf8"));

export const CHAIN_ID = 4663;
export const REGISTRY = "0x7b592Bf516cE94AE28e24e34d709Cb95fE596005";
export const REGISTER_SIGNATURE = "register(address,uint64,uint32,string)";
export const ABI_VERSION = 1;
export const LABEL = "HoodAggregatorV3";
export const INPUT_SCHEMA = "meow-router-registration-input/v1";
export const REQUEST_SCHEMA = "meow-router-registration-request/v1";
const REGISTRY_DEPLOY_BLOCK = REGISTRY_RECORD.blockNumber;
const REGISTRY_OWNER = REGISTRY_RECORD.owner;
const SEEDS = REGISTRY_RECORD.seeds;
const V2 = SEEDS.find((s) => s.label === "HoodAggregatorV2");
const UINT64_MAX = (1n << 64n) - 1n;
const SWAPPED = parseFragment(
  "event Swapped(address indexed sender, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
);
const ROUTER_REGISTERED = parseFragment(
  "event RouterRegistered(address indexed router, uint64 fromBlock, uint64 retiredBlock, uint32 abiVersion, string label)",
);

export class RegistrationRefused extends Error {
  constructor(problems) {
    super(`registration input refused:\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
  }
}

const PLACEHOLDER_RE = /[<>]|\bTBD\b|\bTODO\b|PLACEHOLDER|FILL[ _-]?ME|XXX/i;
const QUANTITY_RE = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const HASH32_RE = /^0x[0-9a-f]{64}$/;

/** Every string/null leaf that still looks like an unfilled template value. */
function findPlaceholders(value, path = "$") {
  if (value === null || value === undefined) return [path];
  if (typeof value === "string") return PLACEHOLDER_RE.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findPlaceholders(v, `${path}[${i}]`));
  if (typeof value === "object") return Object.entries(value).flatMap(([k, v]) => (k.startsWith("_") ? [] : findPlaceholders(v, `${path}.${k}`)));
  return [];
}

const unwrapRpc = (doc) => (doc && typeof doc === "object" && "result" in doc && "jsonrpc" in doc ? doc.result : doc);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const eqAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Validate a release input and return the registration request.
 * `files` maps the input's receipt/transaction paths to their raw JSON text,
 * so the function stays pure; the CLI reads them from disk.
 */
export function buildRegistrationRequest(input, files) {
  const problems = [];
  const fail = (msg) => problems.push(msg);

  if (!input || typeof input !== "object") throw new RegistrationRefused(["input is not a JSON object"]);
  const placeholders = findPlaceholders(input);
  if (placeholders.length) throw new RegistrationRefused(placeholders.map((p) => `unfilled placeholder at ${p}`));

  if (input.schema !== INPUT_SCHEMA) fail(`schema must be "${INPUT_SCHEMA}"`);
  if (input.chainId !== CHAIN_ID) fail(`chainId must be the number ${CHAIN_ID}`);
  if (input.registry !== REGISTRY) fail(`registry must be ${REGISTRY}`);
  if (input.abiVersion !== ABI_VERSION) fail(`abiVersion must be ${ABI_VERSION} (canonical Swapped/FeeCollected signatures unchanged)`);
  if (input.label !== LABEL) fail(`label must be exactly "${LABEL}"`);
  if (input.retire !== undefined && !(Array.isArray(input.retire) && input.retire.length === 0))
    fail("retire must be absent or empty: the initial V3 release keeps V2 registered and unretired");

  const router = input.router;
  if (!isValidAddress(router)) fail(`router ${router} is not a valid (EIP-55 if mixed-case) address`);
  else {
    if (/^0x0{40}$/i.test(router)) fail("router is the zero address");
    const seed = SEEDS.find((s) => eqAddr(s.router, router));
    if (seed) fail(`router ${router} is already registered as "${seed.label}"`);
  }

  const fromBlock = input.fromBlock;
  if (!Number.isSafeInteger(fromBlock) || fromBlock <= 0) fail("fromBlock must be a positive integer (the receipt's L2 blockNumber)");
  else {
    if (BigInt(fromBlock) > UINT64_MAX) fail("fromBlock exceeds uint64");
    if (fromBlock <= REGISTRY_DEPLOY_BLOCK) fail(`fromBlock ${fromBlock} is not after the registry deployment block ${REGISTRY_DEPLOY_BLOCK}`);
    if (fromBlock <= V2.fromBlock) fail(`fromBlock ${fromBlock} is not after V2's deployment block ${V2.fromBlock}`);
  }

  if (!HASH32_RE.test(input.expectedRuntimeCodeHash ?? ""))
    fail("expectedRuntimeCodeHash must be the lowercase 0x-prefixed keccak256 of the frozen artifact's deployed runtime (immutables accounted for)");

  // ---------------------------------------------------------- receipt
  let receipt;
  let tx;
  try {
    receipt = unwrapRpc(JSON.parse(files.receipt));
  } catch (e) {
    fail(`deployment receipt is not valid JSON: ${e.message}`);
  }
  try {
    tx = unwrapRpc(JSON.parse(files.transaction));
  } catch (e) {
    fail(`deployment transaction is not valid JSON: ${e.message}`);
  }
  if (!receipt || typeof receipt !== "object") fail("deployment receipt missing or not an object");
  if (!tx || typeof tx !== "object") fail("deployment transaction missing or not an object");
  if (problems.length) throw new RegistrationRefused(problems);

  if (receipt.status !== "0x1") fail(`receipt status is ${JSON.stringify(receipt.status)}, expected "0x1" (success)`);
  if (!HASH32_RE.test(receipt.transactionHash ?? "")) fail("receipt.transactionHash must be a lowercase 32-byte hex string");
  if (!HASH32_RE.test(receipt.blockHash ?? "")) fail("receipt.blockHash must be a lowercase 32-byte hex string");
  if (!QUANTITY_RE.test(receipt.blockNumber ?? "")) fail("receipt.blockNumber must be a JSON-RPC hex quantity");
  if (receipt.to !== null && receipt.to !== undefined) fail("receipt.to must be null: V3 must be a direct contract-creation transaction");
  if (!isValidAddress(receipt.from ?? "")) fail("receipt.from must be an address");
  if (!isValidAddress(receipt.contractAddress ?? "")) fail("receipt.contractAddress must be an address");
  else if (!eqAddr(receipt.contractAddress, router)) fail(`receipt.contractAddress ${receipt.contractAddress} does not match router ${router}`);

  let receiptBlock;
  if (QUANTITY_RE.test(receipt.blockNumber ?? "")) {
    receiptBlock = Number(BigInt(receipt.blockNumber));
    if (receiptBlock !== fromBlock) {
      const l1 = QUANTITY_RE.test(receipt.l1BlockNumber ?? "") ? Number(BigInt(receipt.l1BlockNumber)) : undefined;
      if (l1 !== undefined && l1 === fromBlock)
        fail(`fromBlock ${fromBlock} is the receipt's l1BlockNumber (what Solidity block.number returns on this chain); use the L2 blockNumber ${receiptBlock}`);
      else fail(`fromBlock ${fromBlock} does not equal the receipt's L2 blockNumber ${receiptBlock}`);
    }
  }

  // ---------------------------------------------------------- transaction
  if (tx.hash !== receipt.transactionHash) fail("transaction.hash does not match receipt.transactionHash");
  if (!QUANTITY_RE.test(tx.chainId ?? "")) fail("transaction.chainId missing: chain 4663 cannot be proven (pre-EIP-155 or non-RPC input)");
  else if (Number(BigInt(tx.chainId)) !== CHAIN_ID) fail(`transaction.chainId is ${Number(BigInt(tx.chainId))}, expected ${CHAIN_ID}`);
  if (tx.blockNumber !== receipt.blockNumber) fail("transaction.blockNumber does not match receipt.blockNumber");
  if (tx.blockHash !== receipt.blockHash) fail("transaction.blockHash does not match receipt.blockHash");
  if (tx.to !== null && tx.to !== undefined) fail("transaction.to must be null (contract creation)");
  if (!eqAddr(tx.from, receipt.from)) fail("transaction.from does not match receipt.from");

  if (problems.length) throw new RegistrationRefused(problems);

  // ---------------------------------------------------------- request
  const routerChecksummed = toChecksumAddress(router);
  const calldata = encodeCall(REGISTER_SIGNATURE, [routerChecksummed, fromBlock, ABI_VERSION, LABEL]);
  // Round-trip the encoding so a codec bug cannot slip into the request.
  const decoded = decodeParams(["address", "uint64", "uint32", "string"], calldata.slice(10));
  if (!eqAddr(decoded[0], routerChecksummed) || decoded[1] !== BigInt(fromBlock) || decoded[2] !== BigInt(ABI_VERSION) || decoded[3] !== LABEL)
    throw new Error("internal: calldata round-trip mismatch");

  const rpc = "$ROBINHOOD_RPC";
  const call = (sig, ...args) => `cast call ${REGISTRY} "${sig}" ${args.join(" ")} --rpc-url ${rpc}`.replace(/ +--/, " --");
  const seedList = SEEDS.map((s) => s.router);

  return {
    schema: REQUEST_SCHEMA,
    status: "PREPARED_NOT_BROADCAST",
    chainId: CHAIN_ID,
    registry: REGISTRY,
    sender: REGISTRY_OWNER,
    function: {
      signature: REGISTER_SIGNATURE,
      selector: selector(REGISTER_SIGNATURE),
      args: { router: routerChecksummed, fromBlock, abiVersion: ABI_VERSION, label: LABEL },
    },
    calldata,
    value: "0",
    evidence: {
      deploymentTransactionHash: receipt.transactionHash,
      deploymentBlockNumberL2: receiptBlock,
      deploymentBlockHash: receipt.blockHash,
      receiptL1BlockNumber: QUANTITY_RE.test(receipt.l1BlockNumber ?? "") ? Number(BigInt(receipt.l1BlockNumber)) : null,
      receiptL1BlockNumberNote: "informational only; never used as fromBlock",
      deployer: receipt.from,
      deploymentTransactionChainId: CHAIN_ID,
      receiptSha256: sha256(files.receipt),
      transactionSha256: sha256(files.transaction),
      expectedRuntimeCodeHash: input.expectedRuntimeCodeHash,
    },
    operations: ["register"],
    notIncluded: ["retire(...): V2 stays registered and unretired as the rollback target in the initial V3 release"],
    preservedRouters: SEEDS.map((s) => ({ router: s.router, label: s.label, fromBlock: s.fromBlock, retiredBlock: s.retiredBlock })),
    sequencing:
      "Broadcast and confirm this registration before any V3 swap, including canaries. The adapter reads routers() at each window's end block, so a V3 swap in any window that ends before the registration block would not be counted.",
    preBroadcastGates: [
      { id: "chain", check: "RPC is chain 4663", command: `cast chain-id --rpc-url ${rpc}`, expect: String(CHAIN_ID) },
      { id: "owner", check: "registry owner is the signer that will send this request", command: call("owner()(address)"), expect: REGISTRY_OWNER },
      { id: "prior-entries", check: "registry still holds exactly the five recorded routers, in order", command: call("routers()(address[])"), expect: seedList },
      { id: "prior-count", check: "no other registration since the recorded deployment", command: call("count()(uint256)"), expect: String(SEEDS.length) },
      { id: "not-registered", check: "V3 is not yet registered", command: call("isRegistered(address)(bool)", routerChecksummed), expect: "false" },
      { id: "v2-active", check: "V2 is registered and unretired", command: call("record(address)((address,uint64,uint64,uint32,string))", V2.router), expect: `(${V2.router}, ${V2.fromBlock}, 0, 1, "${V2.label}")` },
      { id: "runtime", check: "deployed runtime at the V3 address matches the frozen artifact", command: `cast keccak $(cast code ${routerChecksummed} --rpc-url ${rpc})`, expect: input.expectedRuntimeCodeHash },
      { id: "deploy-block", check: "live receipt still reports this L2 block (no reorg)", command: `cast receipt ${receipt.transactionHash} blockNumber --rpc-url ${rpc}`, expect: String(fromBlock) },
      { id: "deploy-block-hash", check: "block hash at fromBlock matches the receipt", command: `cast block ${fromBlock} hash --rpc-url ${rpc}`, expect: receipt.blockHash },
      { id: "no-v3-swaps-yet", check: "V3 has emitted no Swapped log yet", command: `cast logs --from-block ${fromBlock} --address ${routerChecksummed} ${SWAPPED.topic0} --rpc-url ${rpc}`, expect: "no logs" },
    ].map((g) => ({ ...g, status: "PENDING_OPERATOR_VERIFICATION" })),
    broadcastCommandForOperator: `cast send ${REGISTRY} "${REGISTER_SIGNATURE}" ${routerChecksummed} ${fromBlock} ${ABI_VERSION} "${LABEL}" --rpc-url ${rpc} --from ${REGISTRY_OWNER}`,
    postBroadcastChecks: [
      { id: "event", check: `registration receipt has status 0x1 and one RouterRegistered log (topic0 ${ROUTER_REGISTERED.topic0}) from the registry with topic1 = router` },
      { id: "record", command: call("record(address)((address,uint64,uint64,uint32,string))", routerChecksummed), expect: `(${routerChecksummed}, ${fromBlock}, 0, 1, "${LABEL}")` },
      { id: "count", command: call("count()(uint256)"), expect: String(SEEDS.length + 1) },
      { id: "routers", command: call("routers()(address[])"), expect: [...seedList, routerChecksummed] },
      { id: "v2-still-active", command: call("record(address)((address,uint64,uint64,uint32,string))", V2.router), expect: `(${V2.router}, ${V2.fromBlock}, 0, 1, "${V2.label}")` },
      { id: "record-registration-block", check: "store the registration receipt's L2 blockNumber R in the release manifest; the adapter sees V3 in every window whose end block is >= R" },
    ],
  };
}

function main(argv) {
  const args = argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const inputPath = args.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1));
  if (!inputPath || (outIdx >= 0 && !out)) {
    process.stderr.write("usage: node tools/v3-registration.mjs <release-input.json> [--out <request.json>]\n");
    return 1;
  }
  let input;
  let files;
  try {
    input = JSON.parse(readFileSync(inputPath, "utf8"));
    const placeholders = findPlaceholders(input);
    if (placeholders.length) throw new RegistrationRefused(placeholders.map((p) => `unfilled placeholder at ${p}`));
    const base = dirname(resolve(inputPath));
    const read = (p, what) => {
      if (typeof p !== "string") throw new RegistrationRefused([`${what} path missing`]);
      return readFileSync(resolve(base, p), "utf8");
    };
    files = { receipt: read(input.deploymentReceipt, "deploymentReceipt"), transaction: read(input.deploymentTransaction, "deploymentTransaction") };
    const request = buildRegistrationRequest(input, files);
    const text = JSON.stringify(request, null, 2) + "\n";
    if (out) writeFileSync(out, text);
    process.stdout.write(text);
    return 0;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return e instanceof RegistrationRefused ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv);
