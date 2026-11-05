/**
 * Read-only checks against the real providers. Nothing is signed or sent, and no funds move.
 * Run on demand, since they depend on the network and on third-party limits:
 *   pnpm test:live
 * Flash checks need FLASH_API_KEY in the environment and are skipped without it.
 */
import { ARC_USDC, CHAINS, CHAIN_KEYS, D } from "@frontrun/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://localhost:5432/frontrun_dev";
  process.env.REDIS_URL ??= "redis://localhost:6379/14";
  process.env.UNISWAP_API_KEY ??= "";
});

import { fetchTokens, searchPairs, fetchBoosts } from "../src/market/dexscreener";
import { redis } from "../src/redis";
import { fetchCandles, fetchTape, fetchTokenInfo, trendingPools } from "../src/market/geckoterminal";
import { arcUsdcBalance, erc20Decimals, evmClient } from "../src/onchain";
import { flashAsset, flashProvider, type FlashQuoteRaw } from "../src/providers/flash";
import { lifiProvider } from "../src/providers/lifi";
import type { RouteRequest } from "../src/providers/types";
import { uniswapDirectProvider } from "../src/providers/uniswap";

const BURN = "0x000000000000000000000000000000000000dEaD";
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const SOL_ADDR = "So11111111111111111111111111111111111111112";

function arcToken() {
  return trendingPools("arc").then((list) => {
    const token = list.find((t) => D(t.liquidityUsd ?? 0).gt(50_000) && t.address.length === 42);
    if (!token) throw new Error("no liquid Arc token to test with");
    return token;
  });
}

const request = (over: Partial<RouteRequest>): RouteRequest => ({
  side: "buy",
  chain: "base",
  address: WETH_BASE,
  decimals: 18,
  usdcIn: "5",
  evmAddress: BURN,
  solanaAddress: SOL_ADDR,
  priceUsd: "2400",
  notionalUsd: "5",
  ...over,
});

describe("Arc RPC", () => {
  it("matches the chain facts we build on", async () => {
    const client = evmClient("arc");
    expect(await client.getChainId()).toBe(5042);
    expect(await erc20Decimals("arc", ARC_USDC)).toBe(6);
    expect(await arcUsdcBalance(BURN)).toBeTypeOf("bigint");
    expect((await client.getGasPrice()) >= 20_000_000_000n).toBe(true);
  });
});

describe("DexScreener", () => {
  it("returns snapshots for tokens on every EVM chain slug we use", async () => {
    const snaps = await fetchTokens("base", [WETH_BASE]);
    const weth = snaps.get(WETH_BASE.toLowerCase());
    expect(weth?.symbol).toBe("WETH");
    expect(Number(weth?.priceUsd)).toBeGreaterThan(100);
    expect(weth?.pairAddress).toBeTruthy();
    expect(Number(weth?.liquidityUsd)).toBeGreaterThan(1000);
  });

  it("searches", async () => {
    const results = await searchPairs("USDC");
    expect(results.length).toBeGreaterThan(0);
    expect(CHAIN_KEYS).toContain(results[0]!.chain);
  });

  it("lists boosts", async () => {
    expect(Array.isArray(await fetchBoosts())).toBe(true);
  });
});

describe("GeckoTerminal", () => {
  beforeEach(() => redis().flushdb());

  it("lists trending Arc tokens with usable data", async () => {
    const token = await arcToken();
    expect(token.symbol).not.toBe("?");
    expect(Number(token.priceUsd)).toBeGreaterThan(0);
    expect(token.pairAddress).toBeTruthy();
  });

  // Keyless GeckoTerminal allows only a few calls a minute, so run this one alone:
  //   pnpm test:live -t "network slug"
  it("has a working network slug for every chain", async () => {
    await redis().flushdb();
    const bad: string[] = [];
    for (const chain of CHAIN_KEYS) {
      await redis().flushdb();
      await new Promise((r) => setTimeout(r, 12_000));
      await trendingPools(chain).catch((err) => bad.push(`${chain}: ${err}`));
    }
    expect(bad).toEqual([]);
  }, 180_000);

  it("returns candles oldest-first, with holder data and a trade tape", async () => {
    const token = await arcToken();
    const candles = await fetchCandles("arc", token.pairAddress!, "15m", 50);
    expect(candles.length).toBeGreaterThan(0);
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.time).toBeGreaterThan(candles[i - 1]!.time);
    const tape = await fetchTape("arc", token.pairAddress!);
    expect(tape.length).toBeGreaterThan(0);
    expect(tape[0]!.usd).toBeGreaterThan(0);
    const info = await fetchTokenInfo("arc", token.address);
    expect(info.holderCount).toBeGreaterThan(0);
  }, 90_000);
});

describe("Uniswap v3 direct on Arc", () => {
  it("quotes a real pool through QuoterV2", async () => {
    const list = await trendingPools("arc");
    const v3 = list.find((t) => t.dexId === "uniswap-v3-arc");
    if (!v3) return;
    const quote = await uniswapDirectProvider.quote(
      request({ chain: "arc", address: v3.address, decimals: null, priceUsd: v3.priceUsd!, usdcIn: "1", notionalUsd: "1" }),
    );
    expect(quote.provider).toBe("uniswap_direct");
    expect(Number(quote.expectedOut)).toBeGreaterThan(0);
    // $1 in, so a sane net output lands near $1. A decimals mix-up would miss by orders of magnitude.
    expect(Number(quote.netOutputUsd)).toBeGreaterThan(0.5);
    expect(Number(quote.netOutputUsd)).toBeLessThan(1.5);
    expect(Number(quote.gasUsd)).toBeLessThan(0.1);
  });
});

describe("LI.FI", () => {
  it("quotes Arc USDC to Base WETH with sane amounts", async () => {
    const quote = await lifiProvider.quote(request({}));
    expect(Number(quote.expectedOut)).toBeGreaterThan(0);
    expect(Number(quote.netOutputUsd)).toBeGreaterThan(2.5);
    expect(Number(quote.netOutputUsd)).toBeLessThan(5.5);
    const raw = quote.raw as { transactionRequest?: { to?: string; chainId?: number } };
    expect(raw.transactionRequest?.chainId).toBe(5042);
  });
});

const flashKey = process.env.FLASH_API_KEY;

describe.skipIf(!flashKey)("Flash", () => {
  it("quotes a cross-chain buy and returns signing data we accept", async () => {
    const quote = await flashProvider.quote(request({}));
    const raw = quote.raw as FlashQuoteRaw;
    expect(Number(quote.netOutputUsd)).toBeGreaterThan(2.5);
    const typed = JSON.parse(raw.evm!.orderTypedData!);
    expect(typed.primaryType).toBe("FlashOrder");
    expect(typed.domain.name).toBe("DefinitiveFlashAllowance");
    expect(Number(typed.domain.chainId)).toBe(5042);
    expect(typed.message.swapper.toLowerCase()).toBe(BURN.toLowerCase());
    expect(typed.message.fromToken.toLowerCase()).toBe(ARC_USDC);
    expect(BigInt(typed.message.fromAmount)).toBe(5_000_000n);
  });

  it("reports the spender on another chain's sell", async () => {
    const quote = await flashProvider.quote(request({ side: "sell", usdcIn: undefined, qtyIn: "0.002", notionalUsd: "5" }));
    const raw = quote.raw as FlashQuoteRaw;
    const typed = JSON.parse(raw.evm!.orderTypedData!);
    expect(Number(typed.domain.chainId)).toBe(CHAINS.base.chainId);
    expect(typed.domain.name).toBe("DefinitiveFlashAllowance");
    console.log("flash sell domain", typed.domain.verifyingContract, "approve", raw.evm!.approveTx?.data?.slice(0, 74));
  });

  it("quotes a Solana buy into a Solana recipient", async () => {
    const quote = await flashProvider.quote(request({ chain: "solana", address: SOL_ADDR, priceUsd: "150", decimals: 9 }));
    expect(Number(quote.expectedOut)).toBeGreaterThan(0);
    console.log("flash arc->solana", { eta: quote.etaSeconds, impact: quote.priceImpact, slip: quote.recommendedSlippage });
  });

  it("looks a token up with its risk flag and decimals", async () => {
    const asset = await flashAsset("base", WETH_BASE);
    expect(asset?.decimals).toBe(18);
    expect(asset?.riskFlagged).toBe(false);
  });
});
