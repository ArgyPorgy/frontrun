import { randomUUID } from "node:crypto";
import {
  CHAIN_KEYS,
  CHAINS,
  D,
  checkBody,
  fromBaseUnits,
  type ChainKey,
  type PriceTick,
} from "@frontrun/core";
import {
  CHANNELS,
  DEX_BATCH_SIZE,
  DEX_BACKGROUND_PER_MINUTE,
  DexBusyError,
  GeckoBusyError,
  KEYS,
  activeTokenKeys,
  anchorPendingTheses,
  anchorPositionEvents,
  arcUsdcBalances,
  checkWatchedOrders,
  pollTelegramTracker,
  pollXTracker,
  pruneTrackerPosts,
  pollFlashOrders,
  closeDb,
  closeRedis,
  db,
  env,
  fetchTokens,
  geckoRefreshMs,
  isPaperMode,
  logger,
  notify,
  pollActiveTrades,
  publish,
  publishReputation,
  reconcilePositions,
  redis,
  refreshBoosts,
  refreshMarketList,
  refreshRankScores,
  refreshReputation,
  resolveClosedTheses,
  runAgents,
  runCopyTrades,
  sendBuyAlerts,
  syncFreshFills,
  syncThesisPositions,
  trackThesisLows,
  runMigrations,
  schema,
  snapshotToTick,
  writeSnapshot,
} from "@frontrun/server";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";

const INSTANCE = randomUUID();
const stopping = { value: false };

/**
 * Runs a job on an interval. A Redis lease keeps it on one instance at a time, so scaling workers out
 * doesn't double-poll a provider. A failed run is logged and the loop carries on.
 */
function every(name: string, intervalMs: number, job: () => Promise<unknown>, opts: { leaseMs?: number } = {}) {
  const leaseMs = opts.leaseMs ?? Math.max(intervalMs * 3, 5_000);
  const leaseKey = `lease:${name}`;
  const run = async () => {
    if (stopping.value) return;
    const started = Date.now();
    try {
      const got = await redis().set(leaseKey, INSTANCE, "PX", leaseMs, "NX");
      const owner = got ? INSTANCE : await redis().get(leaseKey);
      if (owner === INSTANCE) {
        await redis().pexpire(leaseKey, leaseMs);
        await job();
      }
    } catch (err) {
      // Running out of market-data budget is expected without a paid key, not a failure.
      if (err instanceof GeckoBusyError || err instanceof DexBusyError) logger.debug({ job: name }, "skipped: market data budget used up");
      else logger.warn({ job: name, err: err instanceof Error ? err.message : err }, "job failed");
    }
    setTimeout(run, Math.max(intervalMs - (Date.now() - started), 50));
  };
  void run();
}

/**
 * The 1-second feed: only tokens someone is watching, 30 to a DexScreener call. The calls are evenly
 * spaced rather than sent together, because DexScreener refuses a burst even when the minute's total is
 * well under its limit. Prices go out after each call, so a long cycle doesn't hold them back.
 */
const FEED_SPACING_MS = 60_000 / DEX_BACKGROUND_PER_MINUTE;

async function priceFeed() {
  const keys = await activeTokenKeys(150);
  if (!keys.length) return;
  const byChain = new Map<ChainKey, string[]>();
  for (const key of keys) {
    const [chain, address] = key.split(":") as [ChainKey, string];
    byChain.set(chain, [...(byChain.get(chain) ?? []), address]);
  }
  const batches: Array<[ChainKey, string[]]> = [];
  for (const [chain, addresses] of byChain) {
    for (let i = 0; i < addresses.length; i += DEX_BATCH_SIZE) batches.push([chain, addresses.slice(i, i + DEX_BATCH_SIZE)]);
  }
  for (const [chain, addresses] of batches) {
    if (stopping.value) return;
    const started = Date.now();
    const snaps = await fetchTokens(chain, addresses, "background");
    const ticks: PriceTick[] = [];
    for (const snap of snaps.values()) {
      await writeSnapshot(snap);
      const tick = snapshotToTick(snap);
      if (tick) ticks.push(tick);
    }
    if (ticks.length) await publish(CHANNELS.ticks, ticks);
    await new Promise((resolve) => setTimeout(resolve, Math.max(FEED_SPACING_MS - (Date.now() - started), 0)));
  }
}

/** Refreshes trending and new lists one at a time, so a list refresh never crowds out candle calls. */
function marketRotation() {
  // Trending on every chain first, since it's what people land on. New pools fill in after.
  const jobs = (["trending", "new"] as const).flatMap((tab) => CHAIN_KEYS.map((chain) => ({ tab, chain })));
  let index = 0;
  return async () => {
    const job = jobs[index % jobs.length]!;
    index++;
    await refreshMarketList(job.tab, job.chain);
  };
}

/** Spots deposits by balance change for wallets with the app open. */
async function hasRecentTrade(userId: string): Promise<boolean> {
  const recent = await db().query.trades.findFirst({
    where: and(eq(schema.trades.userId, userId), gt(schema.trades.updatedAt, new Date(Date.now() - 5 * 60_000))),
  });
  return !!recent;
}

async function watchBalances() {
  if (isPaperMode()) return;
  const cutoff = Date.now() - 120_000;
  await redis().zremrangebyscore(KEYS.onlineWallets, 0, cutoff);
  const entries = await redis().zrange(KEYS.onlineWallets, 0, 499);
  if (!entries.length) return;
  const parsed = entries.map((e) => {
    const [userId, address] = e.split(":") as [string, string];
    return { userId, address };
  });
  const balances = await arcUsdcBalances(parsed.map((p) => p.address));
  await Promise.all(
    parsed.map(async ({ userId, address }) => {
      const balance = balances.get(address);
      if (balance === undefined) return;
      const key = KEYS.lastBalance(address);
      const previous = await redis().get(key);
      await redis().set(key, balance.toString(), "EX", 86_400);
      if (previous === null) return;
      if (BigInt(previous) === balance) return;
      const usdc = fromBaseUnits(balance, CHAINS.arc.usdcDecimals);
      await publish(CHANNELS.user(userId), { type: "balance", usdc });
      const gained = balance - BigInt(previous);
      // Tiny changes are gas or fill settlement, and a real deposit clears this bar. So do a sale's proceeds,
      // which reach the wallet before the sale reports as filled, so a recent trade rules out a deposit.
      if (gained >= 100_000n && !(await hasRecentTrade(userId))) {
        const amount = D(fromBaseUnits(gained, CHAINS.arc.usdcDecimals)).toFixed(2);
        await notify(userId, { type: "deposit", message: `$${amount} USDC arrived on Arc` }, { push: true });
      }
    }),
  );
}

/**
 * Re-checks recent posts against the current filter rules, since rules tighten after a post goes up,
 * and hides copy-paste spam: the same text from one account across several tokens.
 */
async function moderate() {
  const since = new Date(Date.now() - 30 * 60_000);
  const recent = await db()
    .select({ id: schema.theses.id, body: schema.theses.body, userId: schema.theses.userId })
    .from(schema.theses)
    .where(and(gt(schema.theses.ts, since), isNull(schema.theses.deletedAt), isNull(schema.theses.hiddenAt)));
  const seen = new Map<string, string[]>();
  for (const thesis of recent) {
    if (!checkBody(thesis.body).ok) {
      await db().update(schema.theses).set({ hiddenAt: new Date() }).where(eq(schema.theses.id, thesis.id));
      continue;
    }
    const fingerprint = `${thesis.userId}:${thesis.body.toLowerCase().replace(/\s+/g, " ")}`;
    seen.set(fingerprint, [...(seen.get(fingerprint) ?? []), thesis.id]);
  }
  for (const ids of seen.values()) {
    if (ids.length >= 3) {
      await db().update(schema.theses).set({ hiddenAt: new Date() }).where(inArray(schema.theses.id, ids));
      logger.info({ count: ids.length }, "hid duplicate thesis spam");
    }
  }
}

async function main() {
  const e = env();
  await runMigrations();
  logger.info({ tradingMode: e.TRADING_MODE, instance: INSTANCE }, "workers starting");

  // A cycle across every chain can run for several seconds, and a second worker mustn't start one too.
  every("price-feed", 1_000, priceFeed, { leaseMs: 30_000 });
  every("market-lists", geckoRefreshMs(), marketRotation(), { leaseMs: 60_000 });
  every("boosts", 5 * 60_000, refreshBoosts);
  every("trade-indexer", 1_500, () => pollActiveTrades(), { leaseMs: 20_000 });
  every("balances", 5_000, watchBalances);
  // A stop-loss should fire promptly, and these runs can wait on a trade, so the lease is long.
  // One Telegram channel every 20 seconds, so each is read every few minutes.
  every("tracker-telegram", 20_000, () => pollTelegramTracker());
  // One group of X accounts a minute. X bills per post read, so this sets the running cost.
  every("tracker-x", e.X_TRACKER_INTERVAL_SECONDS * 1000, () => pollXTracker());
  every("tracker-prune", 3_600_000, () => pruneTrackerPosts());
  every("orders-watch", 3_000, () => checkWatchedOrders(), { leaseMs: 2 * 60_000 });
  every("orders-flash", 15_000, () => pollFlashOrders(), { leaseMs: 2 * 60_000 });
  every("buy-alerts", 5_000, () => sendBuyAlerts());
  // A long lease, since a batch of copies waits on signing and sending.
  every("copy-trades", 3_000, () => runCopyTrades(), { leaseMs: 2 * 60_000 });
  // A long lease, since one agent thinking can take a minute or two, and only one runs at a time.
  every("agent-runs", 5_000, () => runAgents(), { leaseMs: 10 * 60_000 });
  every("reconcile", 5 * 60_000, () => reconcilePositions(), { leaseMs: 10 * 60_000 });
  every("thesis-resolve", 60_000, async () => {
    await resolveClosedTheses();
    await refreshReputation();
  });
  every("thesis-live", 2_000, () => syncFreshFills());
  every("thesis-position", 30_000, () => syncThesisPositions(), { leaseMs: 5 * 60_000 });
  every("thesis-lows", 60_000, () => trackThesisLows());
  every("thesis-rank", 5 * 60_000, refreshRankScores);
  every("moderation", 60_000, moderate);
  // A long lease, since a batch waits on several receipts. These run in turn because they share the relayer's nonce.
  every(
    "thesis-anchor",
    15_000,
    async () => {
      await anchorPendingTheses();
      await anchorPositionEvents();
      await publishReputation();
    },
    { leaseMs: 5 * 60_000 },
  );

  const shutdown = async () => {
    stopping.value = true;
    await new Promise((r) => setTimeout(r, 200));
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
