// In-memory model of chain 4663 and of the DefiLlama runner objects the
// adapter touches. MOCK: nothing here talks to a node or to upstream code.
//
// What each piece reproduces, with the upstream source it follows
// (DefiLlama/dimension-adapters@3d66de5631bb747a7b12fd78782ebe5af18e20d0,
//  DefiLlama/defillama-sdk@83ee1f69102cd3b5ca7b56e753790e8e3fafb5f5):
//  - MockChain.getLogs: eth_getLogs semantics — inclusive block range, address
//    filter (case-insensitive), topic0 = keccak(event signature), no dedup, and
//    decoding of indexed/non-indexed args by name (onlyArgs=true default of
//    adapters/utils/runAdapter.ts getLogs).
//  - MockChain registry: MeowRouterRegistry state as of a block. The contract
//    does not exist before its deployment block; register/retire take effect
//    from the block of their transaction; routers() never drops entries.
//  - MockChainApi.call: sdk src/ChainApi.ts `call` — spreads the caller's
//    params and then overwrites `block` with the api's own block. With no
//    block the read is served at "latest", as the SDK does for recent windows.
//  - makeOptions: runAdapter.ts getOptionsObject — getFromBlock/getToBlock,
//    getLogs defaulting to that range, api === toApi pinned to toBlock.
//  - MockBalances: records add()/addGasToken() calls; gas token is keyed as
//    the chain's zero address like sdk Balances.
import { readFileSync } from "node:fs";
import { decodeEventLog, decodeParams, encodeEventLog, parseFragment, selector, toChecksumAddress } from "../../tools/lib/abi.mjs";

export const CHAIN_NAME = "robinhood";
export const ZERO = "0x0000000000000000000000000000000000000000";
const ROUTERS_ABI = "function routers() view returns (address[])";
const REGISTER_SELECTOR = selector("register(address,uint64,uint32,string)");
const RETIRE_SELECTOR = selector("retire(address,uint64)");

export class MockChain {
  constructor({ latestBlock }) {
    this.latestBlock = latestBlock;
    this.logs = [];
    this.registry = null;
    this.ethCalls = [];
    this.getLogsCalls = [];
  }

  // -------------------------------------------------------- registry
  deployRegistry({ address, block, seeds }) {
    this.registry = { address, block, entries: [] };
    for (const s of seeds) this._register(block, s);
  }

  _register(txBlock, r) {
    const reg = this.registry;
    if (reg.entries.some((e) => e.router.toLowerCase() === r.router.toLowerCase())) throw new Error(`AlreadyRegistered(${r.router})`);
    if (!r.abiVersion) throw new Error("InvalidAbiVersion()");
    if (!r.fromBlock || (r.retiredBlock && r.retiredBlock < r.fromBlock)) throw new Error("InvalidBlockRange()");
    reg.entries.push({ ...r, txBlock, retirements: r.retiredBlock ? [{ txBlock, retiredBlock: r.retiredBlock }] : [] });
  }

  /** Apply a registry transaction's calldata mined at `txBlock`. */
  sendRegistryTx(txBlock, calldata) {
    const sel = calldata.slice(0, 10);
    if (sel === REGISTER_SELECTOR) {
      const [router, fromBlock, abiVersion, label] = decodeParams(["address", "uint64", "uint32", "string"], calldata.slice(10));
      this._register(txBlock, { router, fromBlock: Number(fromBlock), retiredBlock: 0, abiVersion: Number(abiVersion), label });
    } else if (sel === RETIRE_SELECTOR) {
      const [router, retiredBlock] = decodeParams(["address", "uint64"], calldata.slice(10));
      const e = this.registry.entries.find((x) => x.router.toLowerCase() === router.toLowerCase());
      if (!e) throw new Error(`NotRegistered(${router})`);
      if (e.retirements.length) throw new Error(`AlreadyRetired(${router})`);
      e.retirements.push({ txBlock, retiredBlock: Number(retiredBlock) });
    } else throw new Error(`unknown registry selector ${sel}`);
  }

  registryRoutersAt(block) {
    const reg = this.registry;
    if (!reg || block < reg.block) throw new Error(`eth_call at ${block}: registry has no code yet`);
    return reg.entries.filter((e) => e.txBlock <= block).map((e) => e.router);
  }

  ethCall({ target, abi, block }) {
    const at = block ?? this.latestBlock;
    this.ethCalls.push({ target, abi, block, servedAt: at });
    if (!this.registry || target.toLowerCase() !== this.registry.address.toLowerCase()) throw new Error(`no contract at ${target}`);
    if (abi !== ROUTERS_ABI) throw new Error(`unexpected abi ${abi}`);
    return this.registryRoutersAt(at);
  }

  // -------------------------------------------------------- logs
  /** Append a log built from a fragment and named args. */
  emit({ address, block, tx, logIndex, fragment, args }) {
    const { topics, data } = encodeEventLog(fragment, args);
    const log = { address: toChecksumAddress(address), blockNumber: block, transactionHash: tx, logIndex, topics, data };
    this.logs.push(log);
    return log;
  }

  getLogs({ target, targets, eventAbi, fromBlock, toBlock, onlyArgs = true }) {
    this.getLogsCalls.push({ targets: targets ?? [target], eventAbi, fromBlock, toBlock });
    const topic0 = parseFragment(eventAbi).topic0;
    const want = new Set((targets ?? [target]).map((a) => a.toLowerCase()));
    return this.logs
      .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && want.has(l.address.toLowerCase()) && l.topics[0] === topic0)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      .map((l) => (onlyArgs ? decodeEventLog(eventAbi, l) : l));
  }
}

export class MockChainApi {
  constructor({ chain, block }) {
    this.chain = chain;
    this.block = block;
    this.api = this;
  }

  async call(params) {
    return this._mock.ethCall({ ...params, block: this.block, chain: CHAIN_NAME });
  }
}

export class MockBalances {
  constructor() {
    this.calls = [];
  }
  // `raw` keeps the value exactly as the adapter passed it (bigint from logs,
  // or a JS number after upstream addOneToken) so tests can see rounding.
  add(token, amount, label) {
    this.calls.push({ method: "add", key: `${CHAIN_NAME}:${token.toLowerCase()}`, amount: BigInt(amount), raw: amount, label });
  }
  addGasToken(amount, label) {
    this.calls.push({ method: "addGasToken", key: `${CHAIN_NAME}:${ZERO}`, amount: BigInt(amount), raw: amount, label });
  }
  /** Sum per token key. */
  totals() {
    const out = {};
    for (const c of this.calls) out[c.key] = (out[c.key] ?? 0n) + c.amount;
    return out;
  }
}

// Block timestamps. REAL: the two headers around the registry deployment
// (test/fixtures/registry-boundary-blocks.json) — blocks 70680537 and
// 70680538 share timestamp 1790183334. Every other block gets a SYNTHETIC
// filler (one second per block away from that pair), used only so
// timestamp-based adapter copies receive a monotone toTimestamp in windows far
// from the boundary. The filler is not chain evidence; boundary tests pass
// real headers explicitly.
export const REAL_HEADERS = new Map(
  JSON.parse(readFileSync(new URL("../fixtures/registry-boundary-blocks.json", import.meta.url), "utf8")).map((h) => [h.block, h.timestamp]),
);
const SHARED_TS = 1790183334;
export function timestampOf(block) {
  if (REAL_HEADERS.has(block)) return REAL_HEADERS.get(block);
  return block < 70680537 ? SHARED_TS - (70680537 - block) : SHARED_TS + (block - 70680538);
}

/**
 * FetchOptions for one window, shaped like runAdapter.ts getOptionsObject.
 * `apiBlock` defaults to toBlock (the runner's behaviour when it has an RPC
 * provider); pass `null` for an unpinned api. `toTimestamp` defaults to the
 * timestamp of toBlock; pass it explicitly to model the runner's
 * timestamp -> block lookup landing on either of two same-second blocks.
 */
export function makeOptions(chain, { fromBlock, toBlock, apiBlock = toBlock, toTimestamp }) {
  const api = new MockChainApi({ chain: CHAIN_NAME, block: apiBlock ?? undefined });
  api._mock = chain;
  const fromApi = new MockChainApi({ chain: CHAIN_NAME, block: fromBlock });
  fromApi._mock = chain;
  const getFromBlock = async () => fromBlock;
  const getToBlock = async () => toBlock;
  return {
    chain: CHAIN_NAME,
    fromTimestamp: Number.isInteger(fromBlock) ? timestampOf(fromBlock) : undefined,
    toTimestamp: toTimestamp ?? (Number.isInteger(toBlock) ? timestampOf(toBlock) : undefined),
    createBalances: () => new MockBalances(),
    getFromBlock,
    getToBlock,
    getStartBlock: getFromBlock,
    getEndBlock: getToBlock,
    getLogs: async (p) => chain.getLogs({ ...p, fromBlock: p.fromBlock ?? (await getFromBlock()), toBlock: p.toBlock ?? (await getToBlock()) }),
    api,
    toApi: api,
    fromApi,
  };
}
