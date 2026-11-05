import {
  D,
  QUOTE_HARD_TIMEOUT_MS,
  QUOTE_RACE_TIMEOUT_MS,
  evaluateGuardrails,
  scoreQuote,
  smoothedFailureRate,
  type GuardrailResult,
  type ProviderId,
} from "@frontrun/core";
import { and, gt, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { settleWithinWindow } from "../http";
import { logger } from "../logger";
import { providersFor, syntheticQuote, type ProviderQuote, type RouteRequest } from "../providers";
import { cachedJson } from "../redis";

export interface RaceAlternative {
  provider: ProviderId;
  netOutputUsd: string | null;
  error: string | null;
  latencyMs: number;
  score: number | null;
}

export interface RaceResult {
  winner: ProviderQuote | null;
  alternatives: RaceAlternative[];
}

async function failureRates(): Promise<Record<string, number>> {
  return cachedJson("routing:failure-rates", 60, async () => {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await db()
      .select({
        provider: schema.trades.provider,
        attempts: sql<number>`count(*) filter (where ${schema.trades.status} in ('filled','failed','refunded'))::int`,
        failures: sql<number>`count(*) filter (where ${schema.trades.status} in ('failed','refunded'))::int`,
      })
      .from(schema.trades)
      .where(and(gt(schema.trades.createdAt, since)))
      .groupBy(schema.trades.provider);
    return Object.fromEntries(rows.map((r) => [r.provider, smoothedFailureRate(r.attempts, r.failures)]));
  });
}

function recordEvents(events: Array<{ provider: string; kind: "quote_ok" | "quote_error"; latencyMs: number }>) {
  if (!events.length) return;
  db()
    .insert(schema.providerEvents)
    .values(events)
    .catch((err) => logger.warn({ err }, "failed to record provider events"));
}

/**
 * Quotes every provider serving the route at once, then keeps the best score. The user only ever sees
 * one price. A provider that misses the race window simply doesn't take part in this trade.
 */
/**
 * Takes quotes best first. LI.FI can't collect the app's fee until a fee wallet is set up with them, so
 * until then it only wins when nothing else can do the trade.
 */
export function pickWinner(best: ProviderQuote[], lifiCollectsFee: boolean): ProviderQuote | null {
  if (lifiCollectsFee) return best[0] ?? null;
  return best.find((q) => q.provider !== "lifi") ?? best[0] ?? null;
}

export async function raceQuotes(req: RouteRequest, opts: { liquidityUsd: string | null }): Promise<RaceResult> {
  const providers = providersFor(req);
  const rates = await failureRates().catch(() => ({} as Record<string, number>));
  const controller = new AbortController();
  const started = Date.now();

  const settled = await settleWithinWindow(
    providers.map((p) => p.quote(req, controller.signal)),
    QUOTE_RACE_TIMEOUT_MS,
    QUOTE_HARD_TIMEOUT_MS,
  );
  controller.abort();

  const alternatives: RaceAlternative[] = [];
  const candidates: Array<{ quote: ProviderQuote; score: number }> = [];
  const events: Array<{ provider: string; kind: "quote_ok" | "quote_error"; latencyMs: number }> = [];

  settled.forEach((result, i) => {
    const provider = providers[i]!;
    if (result.status === "fulfilled") {
      const quote = result.value;
      const score = scoreQuote({
        netOutputUsd: quote.netOutputUsd,
        notionalUsd: req.notionalUsd,
        etaSeconds: quote.etaSeconds,
        failureRate: rates[provider.id] ?? smoothedFailureRate(0, 0),
      });
      candidates.push({ quote, score });
      alternatives.push({ provider: provider.id, netOutputUsd: quote.netOutputUsd, error: null, latencyMs: quote.latencyMs, score });
      events.push({ provider: provider.id, kind: "quote_ok", latencyMs: quote.latencyMs });
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.debug({ provider: provider.id, message }, "quote failed");
      alternatives.push({ provider: provider.id, netOutputUsd: null, error: message.slice(0, 160), latencyMs: Date.now() - started, score: null });
      events.push({ provider: provider.id, kind: "quote_error", latencyMs: Date.now() - started });
    }
  });
  recordEvents(events);

  candidates.sort((a, b) => b.score - a.score);
  let winner = pickWinner(candidates.map((c) => c.quote), !!env().LIFI_FEE);

  if (!winner && env().TRADING_MODE === "paper") {
    winner = syntheticQuote(req, opts.liquidityUsd);
    alternatives.push({ provider: "paper", netOutputUsd: winner.netOutputUsd, error: null, latencyMs: 0, score: null });
  }
  return { winner, alternatives };
}

export function applyGuardrails(
  req: RouteRequest,
  quote: ProviderQuote,
  token: { liquidityUsd: string | null; riskFlagged: boolean; denylisted: boolean },
): GuardrailResult {
  return evaluateGuardrails({
    side: req.side,
    notionalUsd: req.notionalUsd,
    priceImpact: quote.priceImpact,
    poolLiquidityUsd: token.liquidityUsd,
    riskFlagged: token.riskFlagged || quote.riskFlagged === true,
    denylisted: token.denylisted,
  });
}

/** A re-quote is only used silently if the user would get about what they were shown. */
export function withinTolerance(previousOutUsd: string, nextOutUsd: string, slippage: number): boolean {
  return D(nextOutUsd).gte(D(previousOutUsd).mul(1 - slippage));
}
