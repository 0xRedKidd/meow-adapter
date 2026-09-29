// Minimal, dependency-free Keccak-256 and the small slice of the Solidity ABI
// this repository needs (static words, one dynamic string/bytes, event topics).
// Shared by the registration request builder and the adapter test harness.
// Correctness is pinned by known vectors in test/abi.test.mjs.

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}

/** Keccak-256 (the pre-NIST padding Ethereum uses). Returns 0x-prefixed hex. */
export function keccak256(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = "0x";
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 8; j++) out += Number((s[i] >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`invalid hex: ${hex}`);
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
}

export const bytesToHex = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// ------------------------------------------------------------ addresses

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 checksum form of a 20-byte address. */
export function toChecksumAddress(address) {
  if (!ADDRESS_RE.test(address)) throw new Error(`not an address: ${address}`);
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256(lower).slice(2);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/**
 * True for a well-formed address whose mixed case (if any) is a valid EIP-55
 * checksum. All-lowercase and all-uppercase forms carry no checksum and pass.
 */
export function isValidAddress(address) {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

// ------------------------------------------------------------ signatures

export const selector = (signature) => keccak256(signature).slice(0, 10);

/** Canonical `name(type,...)` of a human-readable event/function fragment. */
export function parseFragment(fragment) {
  const m = fragment.trim().match(/^(event|function)\s+(\w+)\s*\((.*?)\)/);
  if (!m) throw new Error(`cannot parse fragment: ${fragment}`);
  const params = m[3].trim() === "" ? [] : m[3].split(",").map((p) => {
    const parts = p.trim().split(/\s+/);
    return { type: parts[0], indexed: parts.includes("indexed"), name: parts.length > 1 ? parts[parts.length - 1] : "" };
  });
  const signature = `${m[2]}(${params.map((p) => p.type).join(",")})`;
  return { kind: m[1], name: m[2], params, signature, topic0: keccak256(signature) };
}

// ------------------------------------------------------------ encoding

const word = (hex) => hex.padStart(64, "0");

function encodeStatic(type, value) {
  if (type === "address") {
    if (!ADDRESS_RE.test(value)) throw new Error(`bad address ${value}`);
    return word(value.slice(2).toLowerCase());
  }
  if (type === "bool") return word(value ? "1" : "0");
  const u = type.match(/^uint(\d+)$/);
  if (u) {
    const v = BigInt(value);
    if (v < 0n || v >= 1n << BigInt(u[1])) throw new Error(`${value} out of range for ${type}`);
    return word(v.toString(16));
  }
  const b = type.match(/^bytes(\d+)$/);
  if (b) {
    const h = value.slice(2);
    if (h.length !== Number(b[1]) * 2) throw new Error(`bad ${type} ${value}`);
    return h.toLowerCase().padEnd(64, "0");
  }
  throw new Error(`unsupported static type ${type}`);
}

const isDynamic = (type) => type === "string" || type === "bytes";

function encodeDynamic(type, value) {
  const bytes = type === "string" ? new TextEncoder().encode(value) : hexToBytes(value);
  const body = bytesToHex(bytes).slice(2);
  return word(bytes.length.toString(16)) + body.padEnd(Math.ceil(body.length / 64) * 64, "0");
}

/** ABI-encode a tuple of (static | string | bytes) values. Returns hex without 0x. */
export function encodeParams(types, values) {
  if (types.length !== values.length) throw new Error("types/values length mismatch");
  let head = "";
  let tail = "";
  const headSize = 32 * types.length;
  types.forEach((t, i) => {
    if (isDynamic(t)) {
      head += word((headSize + tail.length / 2).toString(16));
      tail += encodeDynamic(t, values[i]);
    } else head += encodeStatic(t, values[i]);
  });
  return head + tail;
}

function decodeWord(type, w) {
  if (type === "address") return toChecksumAddress("0x" + w.slice(24));
  if (type === "bool") return BigInt("0x" + w) !== 0n;
  if (/^uint\d+$/.test(type)) return BigInt("0x" + w);
  const b = type.match(/^bytes(\d+)$/);
  if (b) return "0x" + w.slice(0, Number(b[1]) * 2);
  throw new Error(`unsupported type ${type}`);
}

/** Decode a tuple encoded by encodeParams. `hex` may carry a 0x prefix. */
export function decodeParams(types, hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return types.map((t, i) => {
    const w = h.slice(i * 64, i * 64 + 64);
    if (w.length !== 64) throw new Error("data too short");
    if (!isDynamic(t)) return decodeWord(t, w);
    const off = Number(BigInt("0x" + w)) * 2;
    const len = Number(BigInt("0x" + h.slice(off, off + 64)));
    const body = h.slice(off + 64, off + 64 + len * 2);
    if (body.length !== len * 2) throw new Error("dynamic data out of bounds");
    return t === "string" ? new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(body)) : "0x" + body;
  });
}

export function encodeCall(signature, values) {
  const types = signature.slice(signature.indexOf("(") + 1, -1).split(",").filter(Boolean);
  return selector(signature) + encodeParams(types, values);
}

/** Build a raw log {topics, data} for an event fragment and named args. */
export function encodeEventLog(fragment, args) {
  const f = parseFragment(fragment);
  const topics = [f.topic0];
  const dataTypes = [];
  const dataValues = [];
  for (const p of f.params) {
    if (!(p.name in args)) throw new Error(`missing event arg ${p.name}`);
    if (p.indexed) {
      topics.push("0x" + (isDynamic(p.type) ? keccak256(p.type === "string" ? args[p.name] : hexToBytes(args[p.name])).slice(2) : encodeStatic(p.type, args[p.name])));
    } else {
      dataTypes.push(p.type);
      dataValues.push(args[p.name]);
    }
  }
  return { topics, data: "0x" + encodeParams(dataTypes, dataValues) };
}

/** Decode a raw log against an event fragment into a named-args object. */
export function decodeEventLog(fragment, log) {
  const f = parseFragment(fragment);
  if (log.topics[0]?.toLowerCase() !== f.topic0) throw new Error("topic0 mismatch");
  const data = decodeParams(f.params.filter((p) => !p.indexed).map((p) => p.type), log.data);
  const out = {};
  let ti = 1;
  let di = 0;
  for (const p of f.params) {
    if (p.indexed) out[p.name] = isDynamic(p.type) ? log.topics[ti++] : decodeWord(p.type, log.topics[ti++].slice(2));
    else out[p.name] = data[di++];
  }
  return out;
}
