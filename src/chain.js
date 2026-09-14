// chain.js
// A very small Ethereum JSON-RPC client for Robinhood Chain, plus just enough
// ABI encoding to read ERC-20 tokens and Uniswap V2-shaped pools.
//
// Zero dependencies is a hard rule in this project, which normally means no
// ethers/viem and therefore no keccak256 to hash function signatures with. We
// get away with it because every selector and event topic we need is standard
// and has been the same value on every EVM chain since 2017, so they are
// written out below as constants rather than computed.
//
// Adding a NON-standard call means computing its selector elsewhere (cast sig,
// or a browser console) and pasting the result here. Don't guess one.

import { config } from "./config.js";

// Every RPC call this run has made. Rate limits are the real constraint on how
// many tokens a run can score, so the number is reported rather than estimated.
export const rpcCalls = { count: 0, batches: 0 };

// --- standard function selectors (first 4 bytes of keccak256 of the signature) ---
export const SELECTOR = {
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  owner: "0x8da5cb5b",
  transfer: "0xa9059cbb",
  // Uniswap V2 pair + factory
  getReserves: "0x0902f1ac",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  getPair: "0xe6a43905",
  // Uniswap V3 pool. Present on V3, absent on a V2 pair, so it is what
  // tells the two apart when totalSupply reverts on both counts.
  //
  // VERIFIED ON CHAIN, not recalled: called against three live RHC pools,
  // which answered it alongside fee(), slot0() and liquidity() while
  // reverting on totalSupply() and getReserves(). Do not add a selector here
  // from memory - a Mint topic guessed that way in this same investigation
  // was wrong by one nibble and silently returned zero results.
  tickSpacing: "0xd0c93a7c",
};

// --- standard event topics (keccak256 of the full event signature) ---
export const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  swap: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  sync: "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
  pairCreated: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * A real 20-byte account address.
 *
 * Worth checking rather than assuming: Uniswap V4 identifies a pool by a
 * 32-byte pool id against a singleton, and market-data APIs hand that back in
 * the same "address" field a V2 pair address arrives in. Padding one into an
 * ABI word produces valid-looking calldata that always reverts - which read as
 * "this token blocked the transfer" and flagged the chain's largest tokens as
 * honeypots.
 */
export function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

let nextId = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every request in this process goes through one gate, in order, with a
// minimum gap between them.
//
// The public endpoint answers 429 well before anything else breaks, and it
// counts whole HTTP requests rather than the calls inside a batch. Firing
// concurrent batches at it - which is what Promise.all over several tokens
// does - gets all of them rejected, so the queue below serialises the lot and
// the retry rides out the window rather than spending another slot on it.
let gate = Promise.resolve();
let lastRequestAt = 0;

// Extra delay this run has earned by being blocked.
//
// Under sustained load the public endpoint stops answering 429 and starts
// answering 403 - a temporary block rather than a rate limit, and it clears on
// its own within minutes. Retrying into it at the same pace just collects more
// of them, so every 403 also slows the whole run down a little and the pace
// stays slowed for the rest of it.
let pacePenaltyMs = 0;

// Patient on purpose. When the endpoint is under pressure, giving up on a
// token drops it from the reading - and because the shortlist is ordered by
// volume, dropping tokens mid-run silently reshapes the sample rather than
// just shrinking it. Measured once: a squeezed run kept 33 of 150 tokens and
// still printed a confident-looking gauge. Waiting two minutes for a token is
// far cheaper than reporting a market that was never read.
const RPC_BACKOFF_MS = [1000, 4000, 12000, 30000, 45000, 60000];

// Node's fetch has no default timeout, and every request in this process
// queues behind one gate - so a single connection that is accepted and then
// never answered does not slow the run down, it stops it dead. Measured once:
// a full sweep sat for 66 minutes with no output and no progress, which is
// indistinguishable from a run that is merely slow.
const REQUEST_TIMEOUT_MS = 60000;

async function send(body) {
  const wait = config.rpcMinDelayMs + pacePenaltyMs - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // A timeout or a network-level failure. Both are worth another try.
      if (attempt < RPC_BACKOFF_MS.length) {
        await sleep(RPC_BACKOFF_MS[attempt]);
        lastRequestAt = Date.now();
        continue;
      }
      throw new Error(`${config.chainName} RPC unreachable: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return res.json();

    // 403 belongs here with the rest. It reads like a permission error and was
    // treated as fatal at first, which quietly cost a third of one run's
    // tokens - but the endpoint answers 200 again minutes later, so it is a
    // temporary block and the right response is to wait, not to give up.
    const blocked = res.status === 403;
    if (blocked) pacePenaltyMs = Math.min(pacePenaltyMs + 250, 2000);

    const retryable = blocked || res.status === 429 || res.status >= 500;
    if (retryable && attempt < RPC_BACKOFF_MS.length) {
      const after = Number(res.headers.get("retry-after"));
      const pause = Number.isFinite(after) && after > 0 ? after * 1000 : RPC_BACKOFF_MS[attempt];
      await sleep(pause);
      lastRequestAt = Date.now();
      continue;
    }

    throw new Error(`${config.chainName} RPC returned HTTP ${res.status}`);
  }
}

function post(body) {
  if (!config.rpcUrl) {
    throw new Error("No RHC_RPC_URL set. Run with --mock, or add one to .env");
  }

  // Chain onto the gate so requests queue instead of racing, and keep the
  // gate alive when one fails so a single error doesn't wedge the queue.
  const result = gate.then(() => send(body));
  gate = result.then(() => {}, () => {});
  return result;
}

/** One JSON-RPC call. Throws on an RPC-level error. */
export async function rpc(method, params = []) {
  rpcCalls.count++;
  const json = await post({ jsonrpc: "2.0", id: nextId++, method, params });
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

/**
 * Many calls in one HTTP round trip.
 *
 * This is what makes holder distribution affordable: reading the top 10 of a
 * token means a balanceOf per candidate wallet, and 400 candidates as 400
 * separate requests is both slow and the fastest way to get rate-limited.
 *
 * Failures come back as `null` in place of a result rather than throwing, so
 * one bad address can't lose the other 399.
 */
export async function rpcBatch(calls, chunkSize = config.rpcBatchSize) {
  const out = [];

  for (let i = 0; i < calls.length; i += chunkSize) {
    const chunk = calls.slice(i, i + chunkSize);
    rpcCalls.count += chunk.length;
    rpcCalls.batches++;

    const body = chunk.map((c) => ({
      jsonrpc: "2.0",
      id: nextId++,
      method: c.method,
      params: c.params || [],
    }));

    const json = await post(body);
    const results = Array.isArray(json) ? json : [json];

    // A batch response is allowed to come back in any order, so match on id
    // rather than position.
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const request of body) {
      const found = byId.get(request.id);
      out.push(found && !found.error ? found.result : null);
    }
  }

  return out;
}

// --- encoding ---

function strip(hex) {
  return String(hex || "").replace(/^0x/, "");
}

/** Left-pad a value to one 32-byte ABI word. */
export function word(value) {
  return strip(value).toLowerCase().padStart(64, "0");
}

export function encodeAddress(address) {
  return word(address);
}

export function encodeUint(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

/** Build calldata: a selector followed by its already-encoded arguments. */
export function calldata(selector, ...args) {
  return selector + args.join("");
}

// --- decoding ---

/** One 32-byte word out of a returndata blob, as a BigInt. */
export function readUint(hex, wordIndex = 0) {
  const data = strip(hex);
  const slice = data.slice(wordIndex * 64, wordIndex * 64 + 64);
  if (!slice) return 0n;
  return BigInt("0x" + slice);
}

export function readAddress(hex, wordIndex = 0) {
  const data = strip(hex);
  const slice = data.slice(wordIndex * 64, wordIndex * 64 + 64);
  if (!slice) return null;
  return "0x" + slice.slice(24);
}

/**
 * A string return value, handling both shapes in the wild: a proper dynamic
 * `string` (offset, length, bytes) and the older `bytes32` that early tokens
 * like MKR still use.
 */
export function readString(hex) {
  const data = strip(hex);
  if (!data) return "";

  const toText = (h) => {
    let out = "";
    for (let i = 0; i + 1 < h.length; i += 2) {
      const code = parseInt(h.slice(i, i + 2), 16);
      if (code) out += String.fromCharCode(code);
    }
    return out.trim();
  };

  // bytes32: exactly one word, no offset header.
  if (data.length === 64) return toText(data);

  const length = Number(readUint(data, 1));
  if (!length || length > 256) return "";
  return toText(data.slice(128, 128 + length * 2));
}

/** The address packed into an indexed log topic. */
export function topicToAddress(topic) {
  return "0x" + strip(topic).slice(24).toLowerCase();
}

export function toHex(n) {
  return "0x" + BigInt(n).toString(16);
}

// --- common reads ---

export async function call(to, data, from) {
  const params = from ? { to, data, from } : { to, data };
  return rpc("eth_call", [params, "latest"]);
}

export async function blockNumber() {
  return Number(readUint(await rpc("eth_blockNumber")));
}

export async function getCode(address) {
  return rpc("eth_getCode", [address, "latest"]);
}

// What the endpoint enforces, measured rather than assumed: a query matching
// this many logs is rejected outright, and one spanning too many blocks times
// out. Robinhood Chain runs at about ten blocks a second, so a day is roughly
// 850,000 blocks - paging that at a fixed small size costs hundreds of
// requests and gets the whole run rate-limited, which is exactly what happened
// before this was adaptive.
const LOG_LIMIT = 10000;
const SPLITTABLE = /exceeds limit|timed out|too many|response size|query returned more/i;

/**
 * One getLogs range, halved recursively until each piece fits.
 *
 * Splitting on the error rather than guessing a safe page size is what keeps
 * this cheap: a quiet token is one request whatever the span, and only a busy
 * one pays for more.
 */
async function fetchRange(filter, from, to) {
  let logs;
  try {
    logs = await rpc("eth_getLogs", [
      { ...filter, fromBlock: toHex(from), toBlock: toHex(to) },
    ]);
  } catch (err) {
    if (from >= to || !SPLITTABLE.test(err.message)) throw err;
    const mid = Math.floor((from + to) / 2);
    return [...(await fetchRange(filter, from, mid)), ...(await fetchRange(filter, mid + 1, to))];
  }

  // A response sitting exactly on the cap has almost certainly been truncated
  // without saying so, which would silently lose holders.
  if (logs.length >= LOG_LIMIT && from < to) {
    const mid = Math.floor((from + to) / 2);
    return [...(await fetchRange(filter, from, mid)), ...(await fetchRange(filter, mid + 1, to))];
  }

  return logs;
}

function buildFilter(address, topics) {
  return {
    ...(address ? { address } : {}),
    ...(topics ? { topics } : {}),
  };
}

/** Every matching log in a range. */
export async function getLogs({ address, topics, fromBlock, toBlock }) {
  if (toBlock < fromBlock) return [];
  return fetchRange(buildFilter(address, topics), fromBlock, toBlock);
}

/**
 * Walk a range newest-first, a page at a time, and stop as soon as the caller
 * has what it needs.
 *
 * Holder reconstruction only wants the most recent N wallets to have touched a
 * token, so reading the whole history of a two-month-old token to then throw
 * away all but the last few hundred receivers is pure waste. `onPage` returns
 * false to end the walk.
 */
export async function scanLogsBackwards({
  address,
  topics,
  fromBlock,
  toBlock,
  pageSize = config.logPageBlocks,
  onPage,
}) {
  const filter = buildFilter(address, topics);
  let end = toBlock;

  while (end >= fromBlock) {
    const start = Math.max(fromBlock, end - pageSize + 1);
    const page = await fetchRange(filter, start, end);

    // Within a page logs run oldest-first; the caller wants newest-first.
    if (onPage(page.reverse()) === false) return;
    end = start - 1;
  }
}

/**
 * Roughly how many blocks cover a span of time.
 *
 * Measured off two real blocks rather than assumed: Orbit chains run fast
 * enough (sub-second) that a wrong constant here turns a 24-hour lookback into
 * a 3-hour one without any visible error.
 */
export async function blocksPerSecond(head) {
  const SAMPLE = 5000;
  const from = Math.max(1, head - SAMPLE);

  const [a, b] = await rpcBatch([
    { method: "eth_getBlockByNumber", params: [toHex(from), false] },
    { method: "eth_getBlockByNumber", params: [toHex(head), false] },
  ]);

  if (!a || !b) return 4; // fall back to a fast-L2 guess rather than failing

  const seconds = Number(readUint(b.timestamp)) - Number(readUint(a.timestamp));
  if (seconds <= 0) return 4;
  return (head - from) / seconds;
}
