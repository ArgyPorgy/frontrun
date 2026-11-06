import { describe, expect, it } from "vitest";
import {
  ARC_GAS_RESERVE_USDC6,
  D,
  arcNativeToUsdc6,
  cleanAmountInput,
  fromBaseUnits,
  maxSpendableUsdc6,
  parseAmountInput,
  toBaseUnits,
  usdc6ToArcNative,
} from "../src/money";
import { checkSpendCaps, evaluateGuardrails, orderDirection, orderSide, resolveSlippage, triggerHit, triggerProblem, scoreQuote, smoothedFailureRate } from "../src/routing";
import { accuracyPct, checkBody, positionTier, resolveOutcome, returnSincePost, thesisRankScore } from "../src/thesis";
import { computeRiskFlags } from "../src/risk";
import { formatCompactUsd, formatPct, formatPrice, formatUsd, shortAddress, timeAgo } from "../src/format";
import { isValidAddress, normalizeAddress, tokenKey } from "../src/chains";
import { quoteRequestSchema, usernameSchema } from "../src/schemas";

describe("Arc USDC precision", () => {
  it("keeps the 18-decimal gas side and 6-decimal ERC-20 side apart", () => {
    expect(arcNativeToUsdc6(1_000_000_000_000_000_000n)).toBe(1_000_000n);
    expect(usdc6ToArcNative(1_000_000n)).toBe(1_000_000_000_000_000_000n);
  });

  it("rounds native dust down so we never overstate a balance", () => {
    expect(arcNativeToUsdc6(1_999_999_999_999n)).toBe(1n);
  });

  it("holds the gas reserve out of Max", () => {
    expect(maxSpendableUsdc6(1_000_000n)).toBe(1_000_000n - ARC_GAS_RESERVE_USDC6);
    expect(maxSpendableUsdc6(10n)).toBe(0n);
  });

  it("round-trips base units without float error", () => {
    expect(toBaseUnits("0.1", 6)).toBe(100_000n);
    expect(toBaseUnits("123.456789123", 6)).toBe(123_456_789n);
    expect(fromBaseUnits(1_234_567n, 6)).toBe("1.234567");
    expect(toBaseUnits("1", 18)).toBe(10n ** 18n);
  });
});

describe("quote scoring", () => {
  const base = { notionalUsd: 100, etaSeconds: 0, failureRate: 0 };

  it("prefers more net output", () => {
    expect(scoreQuote({ ...base, netOutputUsd: 99 })).toBeGreaterThan(scoreQuote({ ...base, netOutputUsd: 98 }));
  });

  it("penalizes slower routes", () => {
    expect(scoreQuote({ ...base, netOutputUsd: 99, etaSeconds: 60 })).toBeLessThan(scoreQuote({ ...base, netOutputUsd: 99 }));
  });

  it("lets a much faster route win a tiny price gap", () => {
    const slow = scoreQuote({ ...base, netOutputUsd: 99.01, etaSeconds: 120 });
    const fast = scoreQuote({ ...base, netOutputUsd: 99, etaSeconds: 2 });
    expect(fast).toBeGreaterThan(slow);
  });

  it("penalizes failure history", () => {
    expect(scoreQuote({ ...base, netOutputUsd: 99, failureRate: 0.2 })).toBeLessThan(scoreQuote({ ...base, netOutputUsd: 99 }));
  });

  it("smooths thin failure history", () => {
    expect(smoothedFailureRate(1, 1)).toBeLessThan(0.1);
    expect(smoothedFailureRate(0, 0)).toBeCloseTo(0.05);
  });
});

describe("guardrails", () => {
  const ok = { side: "buy" as const, notionalUsd: 100, priceImpact: 0.001, poolLiquidityUsd: 1_000_000, riskFlagged: false, denylisted: false };

  it("passes a clean trade", () => {
    const r = evaluateGuardrails(ok);
    expect(r.blocked).toEqual([]);
    expect(r.confirm).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("blocks buys over 5% impact and warns over 2%", () => {
    expect(evaluateGuardrails({ ...ok, priceImpact: 0.051 }).blocked[0]?.code).toBe("price_impact_high");
    expect(evaluateGuardrails({ ...ok, priceImpact: 0.03 }).warnings[0]?.code).toBe("price_impact_warn");
    expect(evaluateGuardrails({ ...ok, priceImpact: 0.03 }).blocked).toEqual([]);
  });

  it("blocks buys over 2% of pool liquidity", () => {
    expect(evaluateGuardrails({ ...ok, notionalUsd: 2500, poolLiquidityUsd: 100_000 }).blocked[0]?.code).toBe("size_over_pool_share");
    expect(evaluateGuardrails({ ...ok, notionalUsd: 2000, poolLiquidityUsd: 100_000 }).blocked).toEqual([]);
  });

  it("blocks risk-flagged buys", () => {
    expect(evaluateGuardrails({ ...ok, riskFlagged: true }).blocked[0]?.code).toBe("risk_flagged");
  });

  it("never traps a seller: limits become a visible confirm", () => {
    const r = evaluateGuardrails({ ...ok, side: "sell", riskFlagged: true, priceImpact: 0.2, denylisted: true, notionalUsd: 50_000, poolLiquidityUsd: 100_000 });
    expect(r.blocked).toEqual([]);
    expect(r.confirm.map((i) => i.code).sort()).toEqual(["price_impact_high", "risk_flagged", "size_over_pool_share", "token_denied"]);
  });

  it("handles unknown impact and liquidity", () => {
    const r = evaluateGuardrails({ ...ok, priceImpact: null, poolLiquidityUsd: null });
    expect(r.blocked).toEqual([]);
  });
});

describe("slippage", () => {
  it("defaults to 1% same-chain, ignoring the suggestion", () => {
    expect(resolveSlippage(true)).toBe(0.05);
  });
  it("uses the provider suggestion cross-chain, with a ceiling", () => {
    expect(resolveSlippage(false)).toBe(0.2);
  });
});

describe("spend caps", () => {
  const caps = { perTradeCapUsd: 250, dailyCapUsd: 1000 };
  it("allows within caps, including exactly at them", () => {
    expect(checkSpendCaps({ amountUsd: 250, spentTodayUsd: 750, ...caps }).allowed).toBe(true);
  });
  it("catches the per-trade cap", () => {
    expect(checkSpendCaps({ amountUsd: 251, spentTodayUsd: 0, ...caps })).toEqual({ allowed: false, reason: "per_trade" });
  });
  it("catches the daily cap", () => {
    expect(checkSpendCaps({ amountUsd: 200, spentTodayUsd: 900, ...caps })).toEqual({ allowed: false, reason: "daily" });
  });
});

describe("thesis body filter", () => {
  it("accepts plain text and trims", () => {
    expect(checkBody("  Volume is real, holders are growing.  ")).toEqual({ ok: true, body: "Volume is real, holders are growing." });
  });
  it("rejects empty and over-long bodies", () => {
    expect(checkBody("   ").reason).toBe("empty");
    expect(checkBody("x".repeat(561)).reason).toBe("too_long");
  });
  it("blocks unknown links in several forms", () => {
    expect(checkBody("buy here https://evil-site.xyz/claim").reason).toBe("blocked_link");
    expect(checkBody("go to evil-drain.io now").reason).toBe("blocked_link");
    expect(checkBody("www.scam.top").reason).toBe("blocked_link");
  });
  it("allows known hosts", () => {
    expect(checkBody("chart https://dexscreener.com/arc/0xabc").ok).toBe(true);
    expect(checkBody("see x.com/someone/status/1").ok).toBe(true);
  });
  it("is not fooled by a known host inside another domain", () => {
    expect(checkBody("https://x.com.evil.xyz/a").reason).toBe("blocked_link");
  });
  it("blocks drainer language", () => {
    expect(checkBody("claim your airdrop today").reason).toBe("drainer_language");
    expect(checkBody("Connect your wallet to verify").reason).toBe("drainer_language");
    expect(checkBody("share your seed phrase").reason).toBe("drainer_language");
  });
  it("is not fooled by zero-width characters", () => {
    expect(checkBody("evil​-drain.io").reason).toBe("blocked_link");
    expect(checkBody("claim​ your airdrop").reason).toBe("drainer_language");
  });
  it("does not trip on ordinary trading talk", () => {
    expect(checkBody("Holding 3.5 at $0.01, target 2x. Not financial advice.").ok).toBe(true);
    expect(checkBody("MCAP 4.2M vs 1.1M liquidity looks healthy").ok).toBe(true);
  });
});

describe("thesis scoring", () => {
  it("maps position size to the highest tier reached", () => {
    expect(positionTier(49)).toBeNull();
    expect(positionTier(50)).toBe(50);
    expect(positionTier(499.99)).toBe(100);
    expect(positionTier(5000)).toBe(1000);
  });
  it("resolves right only on a realized profit", () => {
    expect(resolveOutcome("0.01")).toBe("right");
    expect(resolveOutcome(0)).toBe("wrong");
    expect(resolveOutcome("-3")).toBe("wrong");
  });
  it("computes returns and accuracy", () => {
    expect(returnSincePost(2, 3)).toBe(50);
    expect(returnSincePost(0, 3)).toBe(0);
    expect(accuracyPct(3, 4)).toBe(75);
    expect(accuracyPct(0, 0)).toBeNull();
  });
  it("ranks verified, bigger, fresher theses higher", () => {
    const base = { likeCount: 0, replyCount: 0, positionUsd: 100, verified: true, ageHours: 1 };
    expect(thesisRankScore(base)).toBeGreaterThan(thesisRankScore({ ...base, verified: false }));
    expect(thesisRankScore(base)).toBeGreaterThan(thesisRankScore({ ...base, ageHours: 48 }));
    expect(thesisRankScore({ ...base, positionUsd: 5000 })).toBeGreaterThan(thesisRankScore(base));
    expect(thesisRankScore({ ...base, likeCount: 10 })).toBeGreaterThan(thesisRankScore(base));
  });
});

describe("risk flags", () => {
  const clean = { flashRiskFlagged: false, liquidityUsd: 500_000, volume24hUsd: 100_000, pairCreatedAt: 0, top10HolderPct: 20, buys24h: 100, sells24h: 100, now: 10 * 24 * 3600 * 1000 };
  it("is quiet on a healthy token", () => {
    expect(computeRiskFlags(clean)).toEqual([]);
  });
  it("flags each condition", () => {
    const codes = computeRiskFlags({
      flashRiskFlagged: true,
      liquidityUsd: 100,
      volume24hUsd: 10,
      pairCreatedAt: clean.now - 1000,
      top10HolderPct: 86,
      buys24h: 0,
      sells24h: 50,
      now: clean.now,
    }).map((f) => f.code);
    expect(codes.sort()).toEqual(["flash_flagged", "holder_concentration", "low_liquidity", "new_pool", "sell_pressure", "thin_volume"]);
  });
  it("does not flag what it can't measure", () => {
    expect(computeRiskFlags({ ...clean, liquidityUsd: null, volume24hUsd: null, top10HolderPct: null, pairCreatedAt: null, buys24h: null, sells24h: null })).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats USD and sign", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(-3.2)).toBe("-$3.20");
    expect(formatUsd(3.2, { sign: true })).toBe("+$3.20");
    expect(formatUsd(null)).toBe("—");
  });
  it("uses compact units", () => {
    expect(formatCompactUsd(4_713_533)).toBe("$4.71M");
    expect(formatCompactUsd(2_500)).toBe("$2.5K");
  });
  it("uses subscript notation for tiny prices", () => {
    expect(formatPrice("0.00001234")).toBe("$0.0₄1234");
    expect(formatPrice("0.005112")).toBe("$0.005112");
    expect(formatPrice("2417.19")).toBe("$2,417.19");
  });
  it("formats percents", () => {
    expect(formatPct(64.18)).toBe("+64.2%");
    expect(formatPct(-0.39)).toBe("-0.39%");
    expect(formatPct(null)).toBe("—");
  });
  it("shortens addresses", () => {
    expect(shortAddress("0x4C9b47Dbd5933aa4574B2c27F82419E4DBBD0222")).toBe("0x4C9b…0222");
    expect(shortAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("EPjF…Dt1v");
  });
  it("renders relative time", () => {
    const now = Date.UTC(2026, 0, 2);
    expect(timeAgo(now - 30_000, now)).toBe("30s");
    expect(timeAgo(now - 3 * 3600_000, now)).toBe("3h");
    expect(timeAgo(now - 5 * 86_400_000, now)).toBe("5d");
  });
});

describe("addresses", () => {
  it("validates per chain type", () => {
    expect(isValidAddress("arc", "0x3600000000000000000000000000000000000000")).toBe(true);
    expect(isValidAddress("arc", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false);
    expect(isValidAddress("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
  });
  it("lowercases EVM keys but not Solana ones, which are case-sensitive", () => {
    expect(normalizeAddress("base", "0xABC")).toBe("0xabc");
    expect(normalizeAddress("solana", "EPjF")).toBe("EPjF");
    expect(tokenKey("base", "0xABC")).toBe("base:0xabc");
  });
});

describe("schemas", () => {
  it("requires an amount on buys and a percent on sells", () => {
    const token = { chain: "arc", address: "0x3600000000000000000000000000000000000000" };
    expect(quoteRequestSchema.safeParse({ ...token, side: "buy", amountUsd: "10" }).success).toBe(true);
    expect(quoteRequestSchema.safeParse({ ...token, side: "buy" }).success).toBe(false);
    expect(quoteRequestSchema.safeParse({ ...token, side: "sell", sellPct: 50 }).success).toBe(true);
    expect(quoteRequestSchema.safeParse({ ...token, side: "sell" }).success).toBe(false);
    expect(quoteRequestSchema.safeParse({ ...token, side: "buy", amountUsd: "-1" }).success).toBe(false);
    expect(quoteRequestSchema.safeParse({ ...token, side: "buy", amountUsd: "NaN" }).success).toBe(false);
  });
  it("restricts usernames", () => {
    expect(usernameSchema.safeParse("satoshi_21").success).toBe(true);
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("has space").success).toBe(false);
    expect(D(1).toNumber()).toBe(1);
  });
});

describe("typed amounts", () => {
  it("keeps only a plain decimal", () => {
    expect(cleanAmountInput("$1,5a0", 6)).toBe("1.50");
    expect(cleanAmountInput("12.34.56", 6)).toBe("12.3456");
    expect(cleanAmountInput("0.1234567", 6)).toBe("0.123456");
    expect(cleanAmountInput("12.345", 2)).toBe("12.34");
    expect(cleanAmountInput(".5", 6)).toBe(".5");
    expect(cleanAmountInput("", 6)).toBe("");
  });

  it("reads an amount only once it's a real one", () => {
    expect(parseAmountInput("0.01")?.toFixed()).toBe("0.01");
    expect(parseAmountInput("5.")?.toFixed()).toBe("5");
    expect(parseAmountInput(".5")?.toFixed()).toBe("0.5");
    for (const unfinished of ["", ".", "0", "0.00", "1e5", "-1"]) expect(parseAmountInput(unfinished)).toBeNull();
  });
});

describe("small trades", () => {
  const base = { side: "buy" as const, poolLiquidityUsd: "1000000", riskFlagged: false, denylisted: false };

  it("asks before a small buy that would lose too much to route costs, rather than stopping it", () => {
    const { blocked, confirm } = evaluateGuardrails({ ...base, notionalUsd: "0.10", priceImpact: 0.36 });
    expect(blocked).toEqual([]);
    expect(confirm[0]?.message).toBe("Route costs would take 36.0% of this small trade.");
  });

  it("still stops a small buy in a pool too thin for it", () => {
    const { blocked } = evaluateGuardrails({ ...base, notionalUsd: "5", priceImpact: 0.3, poolLiquidityUsd: "100" });
    expect(blocked.map((b) => b.code)).toEqual(["size_over_pool_share"]);
  });

  it("stops a buy of $10 or more at the 5% limit", () => {
    const { blocked, confirm } = evaluateGuardrails({ ...base, notionalUsd: "10", priceImpact: 0.06 });
    expect(blocked[0]?.code).toBe("price_impact_high");
    expect(confirm).toEqual([]);
  });

  it("keeps the price impact wording on a normal size", () => {
    const { blocked } = evaluateGuardrails({ ...base, notionalUsd: "500", priceImpact: 0.08 });
    expect(blocked[0]?.message).toBe("Price impact is 8.0%, above the 5% limit.");
  });
});

describe("order rules", () => {
  it("knows which way each order waits", () => {
    expect(orderDirection("limit_buy")).toBe("lower");
    expect(orderDirection("stop_loss")).toBe("lower");
    expect(orderDirection("limit_sell")).toBe("upper");
    expect(orderDirection("take_profit")).toBe("upper");
    expect(orderDirection("stop_buy")).toBe("upper");
    expect(orderSide("stop_buy")).toBe("buy");
    expect(orderSide("stop_loss")).toBe("sell");
  });

  it("fires at the trigger, not before", () => {
    expect(triggerHit("lower", "10", "10.01")).toBe(false);
    expect(triggerHit("lower", "10", "10")).toBe(true);
    expect(triggerHit("upper", "10", "9.99")).toBe(false);
    expect(triggerHit("upper", "10", "10.5")).toBe(true);
  });

  it("refuses a trigger that would run straight away", () => {
    expect(triggerProblem("limit_buy", "9", "10")).toBeNull();
    expect(triggerProblem("limit_buy", "11", "10")).toMatch(/below the current price/);
    expect(triggerProblem("stop_loss", "11", "10")).toMatch(/set it lower/);
    expect(triggerProblem("take_profit", "9", "10")).toMatch(/set it higher/);
    expect(triggerProblem("stop_buy", "9", "10")).toMatch(/above the current price/);
    expect(triggerProblem("limit_sell", "10", "10")).toMatch(/above the current price/);
  });
});
