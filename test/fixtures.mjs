// Shared test fixtures. Everything marked TEST_ONLY is synthetic: it is not a
// deployed address, block, receipt or transaction and must never be used in a
// release input. Real values come from deployments/meow-router-registry-4663.json.
import { readFileSync } from "node:fs";

export const REGISTRY_RECORD = JSON.parse(readFileSync(new URL("../deployments/meow-router-registry-4663.json", import.meta.url), "utf8"));
export const REGISTRY = REGISTRY_RECORD.address;
export const REGISTRY_BLOCK = REGISTRY_RECORD.blockNumber; // 70680538
export const SEEDS = REGISTRY_RECORD.seeds;
export const SEED_ROUTERS = SEEDS.map((s) => s.router);
export const V2 = SEEDS.find((s) => s.label === "HoodAggregatorV2").router;
export const V1 = SEEDS[0].router;

export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const ZERO = "0x0000000000000000000000000000000000000000";

// ---- TEST_ONLY synthetic values
export const TEST_V3 = "0x3333333333333333333333333333333333333333";
export const TEST_LATE_ROUTER = "0x4444444444444444444444444444444444444444";
export const TEST_TOKEN = "0x1111111111111111111111111111111111111111"; // not a core asset
export const TEST_TREASURY = "0x2222222222222222222222222222222222222222";
export const TEST_TRADER = "0x5555555555555555555555555555555555555555";
export const TEST_V3_DEPLOY_BLOCK = 71_000_000;
export const TEST_V3_L1_BLOCK = 23_456_789;
export const TEST_V3_REGISTRATION_BLOCK = 71_000_100;

export const EVENT_SWAPPED =
  "event Swapped(address indexed sender, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)";
export const EVENT_FEE_COLLECTED = "event FeeCollected(address indexed token, address indexed recipient, uint256 amount)";
// Existing V2/V3 event (coordination/contract-baseline.md).
export const EVENT_PARTNER_SWAP =
  "event PartnerSwap(uint256 indexed partnerId, address indexed sender, address indexed tokenOut, uint256 amountOut, uint256 fee)";
// PROPOSED, not frozen (execution plan); used only as an unrelated same-router
// log. The adapter must not depend on it.
export const EVENT_SWAP_REFERRAL = "event SwapReferral(bytes32 indexed referralHash, uint256 indexed partnerId, bytes referralData)";

/** TEST_ONLY deployment receipt/transaction pair in JSON-RPC result shape. */
export function syntheticDeployment({ router = TEST_V3, block = TEST_V3_DEPLOY_BLOCK, l1Block = TEST_V3_L1_BLOCK } = {}) {
  const hash = "0x" + "ab".repeat(32);
  const blockHash = "0x" + "cd".repeat(32);
  const from = REGISTRY_RECORD.owner;
  const receipt = {
    transactionHash: hash,
    transactionIndex: "0x1",
    blockHash,
    blockNumber: "0x" + block.toString(16),
    l1BlockNumber: "0x" + l1Block.toString(16),
    from,
    to: null,
    contractAddress: router,
    cumulativeGasUsed: "0x1",
    gasUsed: "0x1",
    status: "0x1",
    logs: [],
    type: "0x2",
  };
  const transaction = { hash, blockHash, blockNumber: receipt.blockNumber, chainId: "0x1237", from, to: null, input: "0x6080", type: "0x2" };
  return { receipt, transaction };
}

export function registrationInput(overrides = {}) {
  return {
    schema: "meow-router-registration-input/v1",
    chainId: 4663,
    registry: REGISTRY,
    router: TEST_V3,
    fromBlock: TEST_V3_DEPLOY_BLOCK,
    abiVersion: 1,
    label: "HoodAggregatorV3",
    deploymentReceipt: "receipt.json",
    deploymentTransaction: "transaction.json",
    expectedRuntimeCodeHash: "0x" + "ef".repeat(32),
    retire: [],
    ...overrides,
  };
}
