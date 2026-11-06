import {
  ARC_USDC,
  CHAINS,
  D,
  FLASH_ALLOWANCE_ARC,
  PERMIT2,
  arcNativeToUsdc6,
  fromBaseUnits,
  type ChainKey,
} from "@frontrun/core";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { arbitrum, arc, base, bsc, hyperEvm, mainnet, robinhood } from "viem/chains";
import { env } from "./env";
import { fetchJson } from "./http";

const VIEM_CHAINS: Record<Exclude<ChainKey, "solana">, Chain> = {
  arc,
  robinhood,
  base,
  arbitrum,
  ethereum: mainnet,
  bsc,
  hyperevm: hyperEvm,
};

function rpcFor(chain: ChainKey): string {
  const e = env();
  const override: Partial<Record<ChainKey, string | undefined>> = {
    arc: e.ARC_RPC_URL,
    robinhood: e.ROBINHOOD_RPC_URL,
    base: e.BASE_RPC_URL,
    arbitrum: e.ARBITRUM_RPC_URL,
    ethereum: e.ETHEREUM_RPC_URL,
    bsc: e.BSC_RPC_URL,
    hyperevm: e.HYPEREVM_RPC_URL,
    solana: e.SOLANA_RPC_URL,
  };
  return override[chain] ?? CHAINS[chain].defaultRpc;
}

const clients = new Map<ChainKey, PublicClient>();

export function evmClient(chain: ChainKey): PublicClient {
  if (chain === "solana") throw new Error("Solana has no EVM client");
  let client = clients.get(chain);
  if (!client) {
    client = createPublicClient({ chain: VIEM_CHAINS[chain], transport: http(rpcFor(chain), { timeout: 8_000, retryCount: 1 }), batch: { multicall: true } }) as PublicClient;
    clients.set(chain, client);
  }
  return client;
}

export function viemChain(chain: ChainKey): Chain {
  if (chain === "solana") throw new Error("Solana has no viem chain");
  return VIEM_CHAINS[chain];
}

/** Always the ERC-20 interface: 6 decimals. The 18-decimal native side never reaches app logic. */
export async function arcUsdcBalance(address: string): Promise<bigint> {
  return evmClient("arc").readContract({
    address: ARC_USDC as Hex,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as Hex],
  });
}

export async function arcUsdcBalances(addresses: string[]): Promise<Map<string, bigint>> {
  const results = await evmClient("arc").multicall({
    contracts: addresses.map((address) => ({
      address: ARC_USDC as Hex,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [address as Hex] as const,
    })),
    allowFailure: true,
  });
  const out = new Map<string, bigint>();
  results.forEach((r, i) => {
    if (r.status === "success") out.set(addresses[i]!, r.result as bigint);
  });
  return out;
}

export async function erc20Allowance(chain: ChainKey, token: string, owner: string, spender: string): Promise<bigint> {
  return evmClient(chain).readContract({
    address: token as Hex,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner as Hex, spender as Hex],
  });
}

export async function erc20Decimals(chain: ChainKey, token: string): Promise<number> {
  return evmClient(chain).readContract({ address: token as Hex, abi: erc20Abi, functionName: "decimals" });
}

export function encodeApprove(spender: string, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, amount] });
}

export const ARC_APPROVAL_SPENDERS = [FLASH_ALLOWANCE_ARC, PERMIT2] as const;

interface SolanaTokenAccounts {
  result?: {
    value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: string; decimals: number } } } } } }>;
  };
}

/** Waits for a Solana transaction to land, the way an EVM step waits for its receipt. */
export async function waitForSolanaTx(signature: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await fetchJson<{ result?: { value?: Array<{ err: unknown; confirmationStatus?: string } | null> } }>(rpcFor("solana"), {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[signature]] },
      timeoutMs: 6_000,
    }).catch(() => null);
    const status = data?.result?.value?.[0];
    if (status?.err) throw new Error("The transaction reverted on-chain.");
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Solana transaction ${signature} hasn't landed yet.`);
}

/** The wallet's SOL, in lamports. */
export async function solanaLamports(owner: string): Promise<number> {
  const data = await fetchJson<{ result?: { value?: number } }>(rpcFor("solana"), { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "getBalance", params: [owner] }, timeoutMs: 6_000, retries: 1 });
  return data.result?.value ?? 0;
}

export async function solanaTokenBalance(owner: string, mint: string): Promise<{ qty: string; decimals: number | null }> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [owner, { mint }, { encoding: "jsonParsed" }],
  };
  const data = await fetchJson<SolanaTokenAccounts>(rpcFor("solana"), { method: "POST", body, timeoutMs: 8_000 });
  let qty = D(0);
  let decimals: number | null = null;
  for (const entry of data.result?.value ?? []) {
    const amount = entry.account.data.parsed.info.tokenAmount;
    qty = qty.add(amount.uiAmountString);
    decimals = amount.decimals;
  }
  return { qty: qty.toFixed(), decimals };
}

export async function tokenBalance(chain: ChainKey, address: string, owner: string): Promise<string> {
  if (chain === "solana") return (await solanaTokenBalance(owner, address)).qty;
  const client = evmClient(chain);
  const [raw, decimals] = await Promise.all([
    client.readContract({ address: address as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner as Hex] }),
    client.readContract({ address: address as Hex, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return fromBaseUnits(raw, decimals);
}

export interface ReceiptFill {
  amountIn: bigint;
  amountOut: bigint;
  gasNative: bigint;
}

/** Arc's system emitter: it logs every USDC move, native or ERC-20, at 18 decimals. */
export const ARC_SYSTEM_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";

/**
 * Sums what a wallet sent and received in an Arc swap.
 *
 * USDC needs care here. Each ERC-20 move logs twice, from the contract at 6 decimals and from the
 * system emitter at 18. A native move, which is how Uniswap takes USDC on a buy, logs ONLY from the
 * system emitter. So the system emitter is the one source that sees every USDC move exactly once. It's
 * what gets read for a USDC leg, and the ERC-20 log is ignored, then the value is scaled to 6 decimals.
 * Refunds are netted off, so a router returning unused value doesn't read as money spent.
 */
export function parseSwapReceipt(receipt: Pick<TransactionReceipt, "logs" | "gasUsed" | "effectiveGasPrice"> & { from?: string }, wallet: string, tokenIn: string, tokenOut: string): ReceiptFill {
  const me = getAddress(wallet);
  const usdc = getAddress(ARC_USDC);
  const system = getAddress(ARC_SYSTEM_EMITTER);
  const emitterFor = (token: string) => (getAddress(token) === usdc ? system : getAddress(token));
  const inEmitter = emitterFor(tokenIn);
  const outEmitter = emitterFor(tokenOut);
  const scale = (emitter: string, value: bigint) => (emitter === system ? arcNativeToUsdc6(value) : value);
  let spent = 0n;
  let refunded = 0n;
  let received = 0n;
  for (const log of receipt.logs) {
    const emitter = getAddress(log.address);
    if (emitter !== inEmitter && emitter !== outEmitter) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (decoded.eventName !== "Transfer") continue;
    const { from, to, value } = decoded.args as { from: string; to: string; value: bigint };
    if (emitter === inEmitter && getAddress(from) === me) spent += value;
    if (emitter === inEmitter && getAddress(to) === me) refunded += value;
    if (emitter === outEmitter && getAddress(to) === me) received += value;
  }
  const netIn = spent > refunded ? spent - refunded : 0n;
  // A sponsored swap arrives in a bundler's transaction, and that gas was never the user's.
  const paidByUser = !receipt.from || getAddress(receipt.from) === me;
  return { amountIn: scale(inEmitter, netIn), amountOut: scale(outEmitter, received), gasNative: paidByUser ? receipt.gasUsed * receipt.effectiveGasPrice : 0n };
}

export const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const SWAP_ROUTER_02_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
