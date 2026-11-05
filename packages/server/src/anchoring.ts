import { CHAINS, toBaseUnits } from "@frontrun/core";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { BaseError, ContractFunctionRevertedError, createWalletClient, getAbiItem, http, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";
import { db, schema } from "./db/client";
import { env } from "./env";
import { logger } from "./logger";
import { arcUsdcBalance, evmClient } from "./onchain";
import { isPaperMode } from "./trading/service";
import { normalizePrivateKey } from "./trading/signer";

/**
 * Anchors each verified thesis on Arc, so anyone can check its text, price and position size weren't
 * changed after posting. This sits entirely outside the trading path: a chain problem here delays an
 * anchor and never blocks a post or a trade. Only the hash goes on-chain, so a deleted thesis's text
 * doesn't live there forever.
 */
export const THESIS_REGISTRY_ABI = parseAbi([
  "event ThesisAnchored(bytes32 indexed thesisHash, address indexed author, uint64 postedAt, uint256 priceAtPostE18, uint256 positionUsdAtPostE6)",
  "error NotRelayer()",
  "error ZeroHash()",
  "error ZeroAddress()",
  "error ZeroPostedAt()",
  "error AlreadyAnchored()",
  "function anchor(bytes32 thesisHash, address author, uint64 postedAt, uint256 priceAtPostE18, uint256 positionUsdAtPostE6)",
  "function anchoredAt(bytes32 thesisHash) view returns (uint64)",
  "function relayer() view returns (address)",
]);

const ANCHORED_EVENT = getAbiItem({ abi: THESIS_REGISTRY_ABI, name: "ThesisAnchored" });
const MAX_ATTEMPTS = 5;
/** Arc's RPC refuses log ranges much wider than this, so older lookups go chunk by chunk. */
const LOG_CHUNK_BLOCKS = 2_000n;
const LOG_CHUNKS = 25;
/** Below this the relayer could run dry, which only delays anchors, so it warns instead of stopping. */
const LOW_BALANCE_USDC6 = 250_000n;

export interface ThesisAnchorInput {
  id: string;
  author: string;
  chain: string;
  token: string;
  body: string;
  priceAtPost: string;
  positionUsdAtPost: string;
  postedAt: number;
}

/**
 * The exact text that gets hashed. Keys are written in a fixed order, because the hash has to come out
 * the same for anyone who recomputes it later.
 */
export function canonicalThesis(t: ThesisAnchorInput): string {
  return JSON.stringify({
    v: 1,
    id: t.id,
    author: t.author.toLowerCase(),
    chain: t.chain,
    token: t.token,
    body: t.body,
    priceAtPost: t.priceAtPost,
    positionUsdAtPost: t.positionUsdAtPost,
    postedAt: t.postedAt,
  });
}

export function thesisHash(canonical: string): Hex {
  return keccak256(toBytes(canonical));
}

export function anchorArgs(t: ThesisAnchorInput) {
  return [
    thesisHash(canonicalThesis(t)),
    t.author as Address,
    BigInt(t.postedAt),
    toBaseUnits(t.priceAtPost, 18),
    toBaseUnits(t.positionUsdAtPost, CHAINS.arc.usdcDecimals),
  ] as const;
}

export function anchoringEnabled(): boolean {
  const e = env();
  return !!(e.THESIS_REGISTRY_ADDRESS && (e.ANCHOR_RELAYER_PRIVATE_KEY || e.GAS_TOPUP_PRIVATE_KEY));
}

function relayerAccount() {
  const e = env();
  const key = e.ANCHOR_RELAYER_PRIVATE_KEY ?? e.GAS_TOPUP_PRIVATE_KEY;
  if (!key) throw new Error("No relayer key is configured.");
  return privateKeyToAccount(normalizePrivateKey(key));
}

/** Sends one anchor and waits for it. Simulating first means a bad call costs no gas. */
export async function sendAnchor(args: ReturnType<typeof anchorArgs>): Promise<Hex> {
  const e = env();
  const registry = e.THESIS_REGISTRY_ADDRESS as Address;
  const account = relayerAccount();
  const client = evmClient("arc");
  const { request } = await client.simulateContract({ account, address: registry, abi: THESIS_REGISTRY_ABI, functionName: "anchor", args });
  const wallet = createWalletClient({ account, chain: arc, transport: http(e.ARC_RPC_URL) });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`Anchor transaction ${hash} reverted.`);
  return hash;
}

/**
 * Returns the transaction behind an anchor that already landed, or null if the hash isn't anchored yet.
 * This covers a worker that died, or timed out, after sending but before saving the result.
 */
export async function findAnchorTx(hash: Hex): Promise<Hex | null> {
  const registry = env().THESIS_REGISTRY_ADDRESS as Address;
  const client = evmClient("arc");
  const anchoredAt = await client.readContract({ address: registry, abi: THESIS_REGISTRY_ABI, functionName: "anchoredAt", args: [hash] });
  if (anchoredAt === 0n) return null;
  let toBlock = await client.getBlockNumber();
  for (let i = 0; i < LOG_CHUNKS && toBlock > 0n; i++) {
    const fromBlock = toBlock >= LOG_CHUNK_BLOCKS ? toBlock - LOG_CHUNK_BLOCKS + 1n : 0n;
    const logs = await client.getLogs({ address: registry, event: ANCHORED_EVENT, args: { thesisHash: hash }, fromBlock, toBlock });
    if (logs[0]) return logs[0].transactionHash;
    toBlock = fromBlock - 1n;
    // Arc's public RPC starts refusing at a few requests a second.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("This hash is anchored, but too far back to find its transaction.");
}

/**
 * A network, gas or relayer problem would hit every thesis alike, so it mustn't use up their retries.
 * Without this, a long outage would leave every thesis in the queue permanently unanchored.
 */
export function isThesisSpecificFailure(err: unknown): boolean {
  if (!(err instanceof BaseError)) return true;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  return !!reverted && reverted.data?.errorName !== "NotRelayer";
}

/** Worker job. Theses are anchored one at a time, since they share the relayer's nonce. */
export async function anchorPendingTheses(limit = 10): Promise<number> {
  // Paper positions aren't real, so they never go on-chain as if they were.
  if (!anchoringEnabled() || isPaperMode()) return 0;
  const rows = await db()
    .select({ thesis: schema.theses, wallet: schema.wallets.address })
    .from(schema.theses)
    .innerJoin(schema.wallets, and(eq(schema.wallets.userId, schema.theses.userId), eq(schema.wallets.chainType, "evm"), eq(schema.wallets.isEmbedded, true)))
    .where(
      and(
        eq(schema.theses.verified, true),
        isNull(schema.theses.anchorTx),
        isNull(schema.theses.deletedAt),
        isNull(schema.theses.hiddenAt),
        lt(schema.theses.anchorAttempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(schema.theses.ts))
    .limit(limit);
  if (!rows.length) return 0;

  const balance = await arcUsdcBalance(relayerAccount().address).catch(() => null);
  if (balance !== null && balance < LOW_BALANCE_USDC6) {
    logger.error({ balanceUsdc6: balance.toString() }, "ALERT: thesis anchoring wallet is running low on USDC");
  }

  for (const { thesis, wallet } of rows) {
    const input: ThesisAnchorInput = {
      id: thesis.id,
      author: wallet,
      chain: thesis.tokenChain,
      token: thesis.tokenAddr,
      body: thesis.body,
      priceAtPost: thesis.priceAtPost,
      positionUsdAtPost: thesis.positionUsdAtPost,
      postedAt: Math.floor(thesis.ts.getTime() / 1000),
    };
    const payload = canonicalThesis(input);
    const hash = thesisHash(payload);
    try {
      const txHash = (await findAnchorTx(hash)) ?? (await sendAnchor(anchorArgs(input)));
      await db()
        .update(schema.theses)
        .set({ anchorTx: txHash, anchorHash: hash, anchorPayload: payload, anchoredAt: new Date() })
        .where(eq(schema.theses.id, thesis.id));
      logger.info({ thesisId: thesis.id, txHash }, "thesis anchored");
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
      if (!isThesisSpecificFailure(err)) {
        logger.warn({ thesisId: thesis.id, err: message }, "anchoring paused until the next run");
        break;
      }
      await db().update(schema.theses).set({ anchorAttempts: thesis.anchorAttempts + 1 }).where(eq(schema.theses.id, thesis.id));
      logger.warn({ thesisId: thesis.id, attempt: thesis.anchorAttempts + 1, err: message }, "anchor failed");
    }
  }
  return rows.length;
}
