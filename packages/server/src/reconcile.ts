import { D, reconcile, tokenKey, type ChainKey } from "@frontrun/core";
import { and, asc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "./db/client";
import { logger } from "./logger";
import { getPricesFilled } from "./market/service";
import { tokenBalance } from "./onchain";
import { isPaperMode } from "./trading/service";
import { loadSigningWallets } from "./trading/signer";

/**
 * Compares tracked qty with the chain so transfers in or out get caught. Positions with a trade still
 * in flight are skipped, since their balance is expected to differ from our records.
 */
export async function reconcilePositions(batch = 100): Promise<number> {
  if (isPaperMode()) return 0;
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const rows = await db()
    .select()
    .from(schema.positions)
    .where(and(isNull(schema.positions.closedAt), or(isNull(schema.positions.reconciledAt), lt(schema.positions.reconciledAt, staleBefore))))
    .orderBy(asc(schema.positions.reconciledAt))
    .limit(batch);
  if (!rows.length) return 0;
  const prices = await getPricesFilled(rows.map((r) => tokenKey(r.tokenChain as ChainKey, r.tokenAddr)));
  for (const row of rows) {
    try {
      const chain = row.tokenChain as ChainKey;
      const inFlight = await db().query.trades.findFirst({
        where: and(
          eq(schema.trades.userId, row.userId),
          eq(schema.trades.tokenChain, row.tokenChain),
          eq(schema.trades.tokenAddr, row.tokenAddr),
          or(eq(schema.trades.status, "pending"), eq(schema.trades.status, "source_confirmed"), eq(schema.trades.status, "awaiting_signature")),
        ),
      });
      if (inFlight) continue;
      // A fresh fill can take a moment to show up at our RPC. Reading it too soon would look like the
      // tokens left the wallet, and would shrink the position.
      const recentFill = await db().query.trades.findFirst({
        where: and(
          eq(schema.trades.userId, row.userId),
          eq(schema.trades.tokenChain, row.tokenChain),
          eq(schema.trades.tokenAddr, row.tokenAddr),
          gt(schema.trades.updatedAt, staleBefore),
        ),
      });
      if (recentFill) continue;
      const wallets = await loadSigningWallets(row.userId);
      const owner = chain === "solana" ? wallets.solanaAddress : wallets.evmAddress;
      if (!owner) continue;
      const onChain = await tokenBalance(chain, row.tokenAddr, owner);
      const price = prices.get(tokenKey(chain, row.tokenAddr)) ?? "0";
      const state = { qty: row.qty, costBasisUsd: row.costBasisUsd, realizedPnlUsd: row.realizedPnlUsd };
      const next = reconcile(state, onChain, price);
      const closed = D(next.qty).lte(0);
      await db()
        .update(schema.positions)
        .set({
          qty: next.qty,
          costBasisUsd: next.costBasisUsd,
          reconciledAt: new Date(),
          ...(closed ? { closedAt: new Date() } : {}),
        })
        .where(eq(schema.positions.id, row.id));
      if (next !== state) {
        await db()
          .insert(schema.auditLog)
          .values({ userId: row.userId, action: "position_reconciled", detail: { positionId: row.id, from: row.qty, to: next.qty } });
      }
    } catch (err) {
      logger.warn({ positionId: row.id, err: err instanceof Error ? err.message : err }, "reconcile failed");
    }
  }
  return rows.length;
}
