import {
  D,
  POSITION_ACTION_CODES,
  POSITION_LEDGER_ARC,
  applyFillToHeld,
  chainChange,
  returnSincePost,
  toBaseUnits,
  tokenKey,
  type ChainKey,
  type PositionAction,
  type ThesisLive,
} from "@frontrun/core";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getAbiItem, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { findLogTx, isThesisSpecificFailure, relayerEnabled, relayerWrite } from "./anchoring";
import { db, schema } from "./db/client";
import { logger } from "./logger";
import { getPrices } from "./market/service";
import { notify } from "./notifications";
import { evmClient, tokenBalance } from "./onchain";
import { CHANNELS, publish } from "./redis";
import { isPaperMode, tokenRefFor } from "./trading/service";
import { loadSigningWallets } from "./trading/signer";

/**
 * Keeps each thesis's badge true to what its author actually holds. Fills here update it straight away, and
 * a slower pass reads the author's wallet, which catches tokens that left without a trade here. Each change
 * is then written to Arc, where nobody can edit it. None of this ever blocks a trade or a post.
 */
export const POSITION_LEDGER_ABI = parseAbi([
  "event PositionRecorded(bytes32 indexed thesisHash, address indexed author, bytes32 indexed eventId, uint8 action, uint32 heldBps, uint256 priceE18, uint64 occurredAt)",
  "error NotRelayer()",
  "error ZeroHash()",
  "error ZeroAddress()",
  "error ZeroTime()",
  "error AlreadyRecorded()",
  "function record(bytes32 thesisHash, address author, bytes32 eventId, uint8 action, uint32 heldBps, uint256 priceE18, uint64 occurredAt)",
  "function isRecorded(bytes32 eventId) view returns (bool)",
  "function heldBpsOf(bytes32 thesisHash) view returns (uint32 heldBps, bool changed)",
]);
const RECORDED_EVENT = getAbiItem({ abi: POSITION_LEDGER_ABI, name: "PositionRecorded" });

type Thesis = typeof schema.theses.$inferSelect;
type PositionEvent = typeof schema.thesisPositionEvents.$inferSelect;

const MAX_ATTEMPTS = 5;
/** Older changes, found by a catch-up pass, are recorded without alerting anyone. */
const ALERT_WINDOW_MS = 10 * 60_000;
/** A smaller change than this isn't worth interrupting someone over. */
const ALERT_MIN_BPS = 500;
/** A fresh fill can take a moment to reach our RPC, and reading it too soon would look like tokens leaving. */
const SETTLE_MS = 5 * 60_000;

export function toThesisLive(thesis: Thesis, events: PositionEvent[]): ThesisLive {
  const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const views = ordered.map((e) => ({
    id: e.id,
    action: e.action,
    heldPct: e.heldBps / 100,
    priceUsd: e.priceUsd ? D(e.priceUsd).toFixed() : null,
    at: e.occurredAt.toISOString(),
    txHash: e.anchorTx,
  }));
  const proofTx = [...views].reverse().find((e) => e.txHash)?.txHash ?? null;
  const changedAt = thesis.positionChangedAt?.toISOString() ?? null;
  if (!thesis.verified) return { status: "none", heldPct: 0, exitPriceUsd: null, exitReturnPct: null, changedAt: null, proofTx: null, events: [] };
  // A thesis is only judged once its position is sold, so a judged one has exited whatever the sweep has got to.
  if (thesis.outcome !== "pending" || thesis.positionStatus === "exited") {
    const exitPrice = thesis.priceAtResolve ?? ordered[ordered.length - 1]?.priceUsd ?? null;
    return {
      status: "exited",
      heldPct: 0,
      exitPriceUsd: exitPrice ? D(exitPrice).toFixed() : null,
      exitReturnPct: thesis.returnPct ?? (exitPrice ? returnSincePost(thesis.priceAtPost, exitPrice) : null),
      changedAt: changedAt ?? thesis.resolvedAt?.toISOString() ?? null,
      proofTx,
      events: views,
    };
  }
  return { status: thesis.positionStatus, heldPct: thesis.heldBps / 100, exitPriceUsd: null, exitReturnPct: null, changedAt, proofTx, events: views };
}

export async function positionEventsFor(thesisIds: string[]): Promise<Map<string, PositionEvent[]>> {
  const out = new Map<string, PositionEvent[]>();
  if (!thesisIds.length) return out;
  const rows = await db().select().from(schema.thesisPositionEvents).where(inArray(schema.thesisPositionEvents.thesisId, thesisIds));
  for (const row of rows) out.set(row.thesisId, [...(out.get(row.thesisId) ?? []), row]);
  return out;
}

async function announceChange(thesisId: string) {
  const thesis = await db().query.theses.findFirst({ where: eq(schema.theses.id, thesisId) });
  if (!thesis) return;
  const events = await positionEventsFor([thesisId]);
  await publish(CHANNELS.theses, { type: "thesis_position", thesisId, live: toThesisLive(thesis, events.get(thesisId) ?? []) });
}

function alertMessage(username: string, symbol: string, action: PositionAction, bps: number): string {
  if (action === "exit") return `${username} sold out of ${symbol}, which they posted a thesis on`;
  if (action === "trim") return `${username} sold ${Math.round((10000 - bps) / 100)}% of their ${symbol} after posting a thesis on it`;
  return `${username}'s ${symbol} left their wallet after they posted a thesis on it`;
}

/** Followers hear about a sale, and so does anyone who bought because of this thesis. */
async function alertSale(thesis: Thesis, action: PositionAction, bps: number, previousBps: number, at: Date) {
  if (action === "add") return;
  if (Date.now() - at.getTime() > ALERT_WINDOW_MS) return;
  if (action !== "exit" && previousBps - bps < ALERT_MIN_BPS) return;
  const author = await db().query.users.findFirst({ where: eq(schema.users.id, thesis.userId) });
  if (!author) return;
  const { symbol } = await tokenRefFor(thesis.tokenChain, thesis.tokenAddr);
  const [followers, copiers, blockedBy] = await Promise.all([
    db().select({ id: schema.follows.followerId }).from(schema.follows).where(eq(schema.follows.followeeId, thesis.userId)),
    db().selectDistinct({ id: schema.trades.userId }).from(schema.trades).where(and(eq(schema.trades.copiedThesisId, thesis.id), eq(schema.trades.status, "filled"))),
    db().select({ id: schema.blocks.blockerId }).from(schema.blocks).where(eq(schema.blocks.blockedId, thesis.userId)),
  ]);
  const blocked = new Set(blockedBy.map((b) => b.id));
  const ids = new Set([...followers, ...copiers].map((r) => r.id));
  const message = alertMessage(author.username, symbol, action, bps);
  for (const id of ids) {
    if (id === thesis.userId || blocked.has(id)) continue;
    await notify(id, { type: "thesis_position", actorId: thesis.userId, thesisId: thesis.id, tokenChain: thesis.tokenChain, tokenAddr: thesis.tokenAddr, message }, { push: true });
  }
}

/** Applies any fills on this token that this thesis hasn't counted yet. They're walked in order, and an exit ends it. */
async function applyNewFills(thesis: Thesis): Promise<Thesis> {
  if (!thesis.qtyAtPost) return thesis;
  const fills = await db()
    .select()
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.userId, thesis.userId),
        eq(schema.trades.tokenChain, thesis.tokenChain),
        eq(schema.trades.tokenAddr, thesis.tokenAddr),
        eq(schema.trades.status, "filled"),
        gte(schema.trades.filledAt, thesis.ts),
      ),
    )
    .orderBy(asc(schema.trades.filledAt));
  if (!fills.length) return thesis;
  const seen = await db()
    .select({ tradeId: schema.thesisPositionEvents.tradeId })
    .from(schema.thesisPositionEvents)
    .where(and(eq(schema.thesisPositionEvents.thesisId, thesis.id), isNotNull(schema.thesisPositionEvents.tradeId)));
  const counted = new Set(seen.map((s) => s.tradeId));

  let current = thesis;
  for (const fill of fills) {
    if (current.positionStatus === "exited") break;
    if (counted.has(fill.id) || !fill.qty) continue;
    const previousBps = current.heldBps;
    const change = applyFillToHeld({ qty: current.heldQty ?? current.qtyAtPost!, bps: current.heldBps, status: current.positionStatus }, { side: fill.side, qty: fill.qty, closedPosition: fill.closedPosition }, current.qtyAtPost!);
    const at = fill.filledAt ?? new Date();
    const price = fill.priceUsd ?? (fill.usdOut && D(fill.qty).gt(0) ? D(fill.usdOut).div(fill.qty).toFixed() : null);
    const updated = await db().transaction(async (tx) => {
      // The unique index makes this safe to run twice, including from a second worker.
      const [inserted] = await tx
        .insert(schema.thesisPositionEvents)
        .values({ thesisId: thesis.id, tradeId: fill.id, action: change.action, qtyAfter: change.qty, heldBps: change.bps, priceUsd: price, occurredAt: at })
        .onConflictDoNothing()
        .returning({ id: schema.thesisPositionEvents.id });
      if (!inserted) return null;
      const [row] = await tx
        .update(schema.theses)
        .set({ heldQty: change.qty, heldBps: change.bps, positionStatus: change.status, positionChangedAt: at })
        .where(eq(schema.theses.id, thesis.id))
        .returning();
      return row ?? null;
    });
    if (!updated) continue;
    current = updated;
    await announceChange(thesis.id);
    await alertSale(thesis, change.action, change.bps, previousBps, at).catch((err) => logger.warn({ err: err instanceof Error ? err.message : err }, "position alert failed"));
  }
  return current;
}

/** Compares the wallet with our records, unless a trade is moving tokens right now. */
async function checkWallet(thesis: Thesis): Promise<void> {
  if (isPaperMode() || !thesis.qtyAtPost) return;
  const chain = thesis.tokenChain as ChainKey;
  const busy = await db().query.trades.findFirst({
    where: and(
      eq(schema.trades.userId, thesis.userId),
      eq(schema.trades.tokenChain, thesis.tokenChain),
      eq(schema.trades.tokenAddr, thesis.tokenAddr),
      or(inArray(schema.trades.status, ["pending", "source_confirmed", "awaiting_signature"]), gt(schema.trades.updatedAt, new Date(Date.now() - SETTLE_MS))),
    ),
  });
  if (busy) return;
  const wallets = await loadSigningWallets(thesis.userId);
  const owner = chain === "solana" ? wallets.solanaAddress : wallets.evmAddress;
  if (!owner) return;
  const balance = await tokenBalance(chain, thesis.tokenAddr, owner);
  const change = chainChange({ qty: thesis.heldQty ?? thesis.qtyAtPost, bps: thesis.heldBps, status: thesis.positionStatus }, balance, thesis.qtyAtPost);
  if (!change) return;
  const at = new Date();
  const price = (await getPrices([tokenKey(chain, thesis.tokenAddr)])).get(tokenKey(chain, thesis.tokenAddr)) ?? null;
  await db().transaction(async (tx) => {
    await tx.insert(schema.thesisPositionEvents).values({ thesisId: thesis.id, action: change.action, qtyAfter: change.qty, heldBps: change.bps, priceUsd: price, occurredAt: at });
    await tx.update(schema.theses).set({ heldQty: change.qty, heldBps: change.bps, positionStatus: change.status, positionChangedAt: at }).where(eq(schema.theses.id, thesis.id));
  });
  logger.info({ thesisId: thesis.id, action: change.action, heldBps: change.bps }, "wallet doesn't match a thesis's position");
  await announceChange(thesis.id);
  await alertSale(thesis, change.action, change.bps, thesis.heldBps, at).catch((err) => logger.warn({ err: err instanceof Error ? err.message : err }, "position alert failed"));
}

/** Worker: shows a fresh fill on its theses straight away. This is what makes the badge flip live. */
export async function syncFreshFills(limit = 50): Promise<number> {
  const due = await db()
    .select()
    .from(schema.trades)
    .where(and(eq(schema.trades.status, "filled"), isNull(schema.trades.proofProcessedAt), gt(schema.trades.filledAt, new Date(Date.now() - 3_600_000))))
    .orderBy(asc(schema.trades.filledAt))
    .limit(limit);
  for (const trade of due) {
    const claimed = await db().update(schema.trades).set({ proofProcessedAt: new Date() }).where(and(eq(schema.trades.id, trade.id), isNull(schema.trades.proofProcessedAt))).returning({ id: schema.trades.id });
    if (!claimed.length) continue;
    const theses = await db()
      .select()
      .from(schema.theses)
      .where(
        and(
          eq(schema.theses.userId, trade.userId),
          eq(schema.theses.tokenChain, trade.tokenChain),
          eq(schema.theses.tokenAddr, trade.tokenAddr),
          eq(schema.theses.verified, true),
          ne(schema.theses.positionStatus, "exited"),
          isNull(schema.theses.deletedAt),
        ),
      );
    for (const thesis of theses) await applyNewFills(thesis);
  }
  return due.length;
}

/** Worker: a slow pass over every open thesis, which catches old fills and tokens that left the wallet. */
export async function syncThesisPositions(limit = 25): Promise<number> {
  const rows = await db()
    .select()
    .from(schema.theses)
    .where(and(eq(schema.theses.verified, true), ne(schema.theses.positionStatus, "exited"), isNull(schema.theses.deletedAt)))
    .orderBy(sql`${schema.theses.positionCheckedAt} asc nulls first`)
    .limit(limit);
  for (const row of rows) {
    await db().update(schema.theses).set({ positionCheckedAt: new Date() }).where(eq(schema.theses.id, row.id));
    try {
      const thesis = await applyNewFills(row);
      if (thesis.outcome !== "pending") {
        // Judged means sold out, whatever the fills added up to.
        if (thesis.positionStatus !== "exited") await db().update(schema.theses).set({ heldBps: 0, heldQty: "0", positionStatus: "exited" }).where(eq(schema.theses.id, thesis.id));
        continue;
      }
      if (thesis.positionStatus !== "exited") await checkWallet(thesis);
    } catch (err) {
      logger.warn({ thesisId: row.id, err: err instanceof Error ? err.message : err }, "position check failed");
    }
  }
  return rows.length;
}

/** Worker: remembers how far each open thesis's price has dipped, which feeds the reputation score's risk. */
export async function trackThesisLows(): Promise<number> {
  const open = await db()
    .selectDistinct({ chain: schema.theses.tokenChain, address: schema.theses.tokenAddr })
    .from(schema.theses)
    .where(and(eq(schema.theses.verified, true), eq(schema.theses.outcome, "pending"), ne(schema.theses.positionStatus, "exited")));
  if (!open.length) return 0;
  const prices = await getPrices(open.map((t) => tokenKey(t.chain as ChainKey, t.address)));
  let updated = 0;
  for (const token of open) {
    const price = prices.get(tokenKey(token.chain as ChainKey, token.address));
    if (!price) continue;
    const rows = await db()
      .update(schema.theses)
      .set({ lowPriceSincePost: price })
      .where(
        and(
          eq(schema.theses.tokenChain, token.chain),
          eq(schema.theses.tokenAddr, token.address),
          eq(schema.theses.verified, true),
          eq(schema.theses.outcome, "pending"),
          ne(schema.theses.positionStatus, "exited"),
          sql`coalesce(${schema.theses.lowPriceSincePost}, ${schema.theses.priceAtPost}) > ${price}`,
        ),
      )
      .returning({ id: schema.theses.id });
    updated += rows.length;
  }
  return updated;
}

export function ledgerArgs(event: Pick<PositionEvent, "id" | "action" | "heldBps" | "priceUsd" | "occurredAt">, thesisHash: string, author: string) {
  return [
    thesisHash as Hex,
    author as Address,
    keccak256(toBytes(event.id)),
    POSITION_ACTION_CODES[event.action],
    event.heldBps,
    event.priceUsd ? toBaseUnits(event.priceUsd, 18) : 0n,
    BigInt(Math.floor(event.occurredAt.getTime() / 1000)),
  ] as const;
}

/**
 * Worker: writes position changes to Arc, oldest first. A change waits for its thesis to be anchored, since
 * it's recorded against the hash that thesis was anchored under.
 */
export async function anchorPositionEvents(limit = 10): Promise<number> {
  if (!POSITION_LEDGER_ARC || !relayerEnabled() || isPaperMode()) return 0;
  const rows = await db()
    .select({ event: schema.thesisPositionEvents, hash: schema.theses.anchorHash, wallet: schema.wallets.address })
    .from(schema.thesisPositionEvents)
    .innerJoin(schema.theses, eq(schema.theses.id, schema.thesisPositionEvents.thesisId))
    .innerJoin(schema.wallets, and(eq(schema.wallets.userId, schema.theses.userId), eq(schema.wallets.chainType, "evm"), eq(schema.wallets.isEmbedded, true)))
    .where(and(isNull(schema.thesisPositionEvents.anchorTx), lt(schema.thesisPositionEvents.anchorAttempts, MAX_ATTEMPTS), isNotNull(schema.theses.anchorHash)))
    .orderBy(asc(schema.thesisPositionEvents.occurredAt))
    .limit(limit);
  const ledger = POSITION_LEDGER_ARC as Address;
  for (const { event, hash, wallet } of rows) {
    const args = ledgerArgs(event, hash!, wallet);
    try {
      const recorded = await evmClient("arc").readContract({ address: ledger, abi: POSITION_LEDGER_ABI, functionName: "isRecorded", args: [args[2]] });
      const txHash = recorded ? await findLogTx(ledger, RECORDED_EVENT, { eventId: args[2] }) : await relayerWrite({ address: ledger, abi: POSITION_LEDGER_ABI, functionName: "record", args });
      await db().update(schema.thesisPositionEvents).set({ anchorTx: txHash, anchoredAt: new Date() }).where(eq(schema.thesisPositionEvents.id, event.id));
      logger.info({ eventId: event.id, txHash }, "position change recorded on Arc");
      await announceChange(event.thesisId);
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
      if (!isThesisSpecificFailure(err)) {
        logger.warn({ eventId: event.id, err: message }, "position anchoring paused until the next run");
        break;
      }
      await db().update(schema.thesisPositionEvents).set({ anchorAttempts: event.anchorAttempts + 1 }).where(eq(schema.thesisPositionEvents.id, event.id));
      logger.warn({ eventId: event.id, attempt: event.anchorAttempts + 1, err: message }, "position anchor failed");
    }
  }
  return rows.length;
}
