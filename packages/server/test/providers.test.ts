import { ARC_USDC, FLASH_ALLOWANCE_ARC, UNISWAP_ARC } from "@frontrun/core";
import { encodeFunctionData, erc20Abi, encodeAbiParameters, keccak256, toHex } from "viem";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://localhost/unused";
  process.env.REDIS_URL ??= "redis://localhost:6379/15";
});

import { BaseError, ContractFunctionRevertedError, HttpRequestError } from "viem";
import { THESIS_REGISTRY_ABI, anchorArgs, canonicalThesis, isThesisSpecificFailure, thesisHash } from "../src/anchoring";
import { assertSafeForProduction, resetEnvForTests, type Env } from "../src/env";
import { extractTokens, isRelevant, parseTelegramPage, parseXResponse } from "../src/trackers";
import { pickWinner } from "../src/routing/engine";
import type { ProviderQuote } from "../src/providers/types";
import { gaslessEnabled, sponsorshipConfigured } from "../src/trading/sponsor";
import { pairToSnapshot, bestSnapshot, type DexPair } from "../src/market/dexscreener";
import { parseSwapReceipt } from "../src/onchain";
import { assertApprovalMatches, assertOrderMatches, buildFlashParams, flashStatusToUpdate } from "../src/providers/flash";
import { lifiStatusToUpdate } from "../src/providers/lifi";
import { paperFill, syntheticQuote } from "../src/providers/paper";
import { assertSwapMatches } from "../src/providers/uniswap";
import type { RouteRequest } from "../src/providers/types";
import { RateLimiter, settleWithinWindow } from "../src/http";
import { withinTolerance } from "../src/routing/engine";

const WALLET = "0xf4f0f84e00000000000000000000000000000001";
const TOKEN = "0xbc43ce8dec648ea298c4275559b81d6261c90b67";
const POOL = "0x162df51c504e7b8321e07387932f333d9be16a72";
const SYSTEM_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";

const transferTopic = keccak256(toHex("Transfer(address,address,uint256)"));
const padAddress = (a: string) => `0x${a.slice(2).padStart(64, "0").toLowerCase()}` as `0x${string}`;
function transferLog(emitter: string, from: string, to: string, value: bigint) {
  return {
    address: emitter as `0x${string}`,
    topics: [transferTopic, padAddress(from), padAddress(to)] as [`0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockNumber: 1n,
    blockHash: "0x00" as `0x${string}`,
    transactionHash: "0x00" as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

describe("Arc receipt parsing", () => {
  // Same shape as a real Arc swap receipt: every USDC move logs twice, from the system emitter at
  // 18 decimals and from the ERC-20 contract at 6.
  const receipt = {
    gasUsed: 400_000n,
    effectiveGasPrice: 20_000_000_000n,
    logs: [
      transferLog(SYSTEM_EMITTER, WALLET, POOL, 10_964_457_000_000_000_000n),
      transferLog(ARC_USDC, WALLET, POOL, 10_964_457n),
      transferLog(TOKEN, POOL, WALLET, 6_563_581_842_727_636_426_389n),
    ],
  };

  it("counts each USDC move once, in 6 decimals", () => {
    const fill = parseSwapReceipt(receipt, WALLET, ARC_USDC, TOKEN);
    expect(fill.amountIn).toBe(10_964_457n);
    expect(fill.amountOut).toBe(6_563_581_842_727_636_426_389n);
  });

  it("reports gas in native 18-decimal units", () => {
    expect(parseSwapReceipt(receipt, WALLET, ARC_USDC, TOKEN).gasNative).toBe(8_000_000_000_000_000n);
  });

  it("works for the sell direction", () => {
    const sell = {
      ...receipt,
      logs: [
        transferLog(TOKEN, WALLET, POOL, 500n),
        transferLog(SYSTEM_EMITTER, POOL, WALLET, 7_000_000_000_000_000_000n),
        transferLog(ARC_USDC, POOL, WALLET, 7_000_000n),
      ],
    };
    const fill = parseSwapReceipt(sell, WALLET, TOKEN, ARC_USDC);
    expect(fill.amountIn).toBe(500n);
    expect(fill.amountOut).toBe(7_000_000n);
  });

  it("reads a native USDC buy, which only the system emitter logs", () => {
    // How Uniswap really takes USDC on Arc: paid as value, so the ERC-20 contract logs nothing.
    const native = {
      ...receipt,
      logs: [
        transferLog(SYSTEM_EMITTER, WALLET, POOL, 1_000_000_000_000_000_000n),
        transferLog(TOKEN, POOL, WALLET, 400_000_000_000_000n),
      ],
    };
    const fill = parseSwapReceipt(native, WALLET, ARC_USDC, TOKEN);
    expect(fill.amountIn).toBe(1_000_000n);
    expect(fill.amountOut).toBe(400_000_000_000_000n);
  });

  it("reads USDC received as native on a sell", () => {
    const native = {
      ...receipt,
      logs: [transferLog(TOKEN, WALLET, POOL, 500n), transferLog(SYSTEM_EMITTER, POOL, WALLET, 2_500_000_000_000_000_000n)],
    };
    const fill = parseSwapReceipt(native, WALLET, TOKEN, ARC_USDC);
    expect(fill.amountIn).toBe(500n);
    expect(fill.amountOut).toBe(2_500_000n);
  });

  it("nets off a router refund, so unused value doesn't count as spent", () => {
    const refund = {
      ...receipt,
      logs: [
        transferLog(SYSTEM_EMITTER, WALLET, POOL, 2_000_000_000_000_000_000n),
        transferLog(SYSTEM_EMITTER, POOL, WALLET, 500_000_000_000_000_000n),
        transferLog(TOKEN, POOL, WALLET, 9n),
      ],
    };
    expect(parseSwapReceipt(refund, WALLET, ARC_USDC, TOKEN).amountIn).toBe(1_500_000n);
  });

  it("doesn't charge the user for gas a paymaster paid", () => {
    const own = parseSwapReceipt({ ...receipt, from: WALLET, logs: [] }, WALLET, ARC_USDC, TOKEN);
    expect(own.gasNative).toBe(receipt.gasUsed * receipt.effectiveGasPrice);
    const sponsored = parseSwapReceipt({ ...receipt, from: POOL, logs: [] }, WALLET, ARC_USDC, TOKEN);
    expect(sponsored.gasNative).toBe(0n);
  });

  it("doesn't count gas as money spent", () => {
    expect(parseSwapReceipt({ ...receipt, logs: [] }, WALLET, ARC_USDC, TOKEN).amountIn).toBe(0n);
  });

  it("ignores other wallets' transfers in the same transaction", () => {
    const other = "0x00000000000000000000000000000000000000aa";
    const fill = parseSwapReceipt({ ...receipt, logs: [transferLog(ARC_USDC, other, POOL, 99n)] }, WALLET, ARC_USDC, TOKEN);
    expect(fill.amountIn).toBe(0n);
  });
});

const flashTyped = (overrides: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) =>
  JSON.stringify({
    domain: { name: "DefinitiveFlashAllowance", version: "1", chainId: "5042", verifyingContract: FLASH_ALLOWANCE_ARC, ...domain },
    primaryType: "FlashOrder",
    types: {},
    message: { swapper: WALLET, fromToken: ARC_USDC, fromAmount: "5000000", recipient: "0xB41d6e009562B91CaaCE7373f2E481386519e7d9", ...overrides },
  });

describe("Flash signing checks", () => {
  const expected = { funder: WALLET, spentToken: ARC_USDC, fromAmount: 5_000_000n, chainId: 5042 };

  it("accepts a payload that matches the quote", () => {
    expect(() => assertOrderMatches(flashTyped(), expected)).not.toThrow();
  });

  it("allows a bridge recipient, which cross-chain FlashOrders use by design", () => {
    expect(() => assertOrderMatches(flashTyped({ recipient: "0x000000000000000000000000000000000000dEaD" }), expected)).not.toThrow();
  });

  it.each([
    ["wrong wallet", { swapper: "0x000000000000000000000000000000000000dEaD" }, {}],
    ["wrong token", { fromToken: TOKEN }, {}],
    ["inflated amount", { fromAmount: "5000001" }, {}],
    ["wrong chain", {}, { chainId: "8453" }],
    ["wrong domain", {}, { name: "SomethingElse" }],
  ])("refuses to sign with %s", (_name, message, domain) => {
    expect(() => assertOrderMatches(flashTyped(message, domain), expected)).toThrow(/Refusing to sign/);
  });

  const approveData = (spender: string) =>
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, 2n ** 256n - 1n] });

  it("accepts an approval to the known spender", () => {
    expect(() => assertApprovalMatches({ to: ARC_USDC, data: approveData(FLASH_ALLOWANCE_ARC) }, ARC_USDC, [FLASH_ALLOWANCE_ARC])).not.toThrow();
  });

  it("refuses an approval to an unknown spender", () => {
    expect(() =>
      assertApprovalMatches({ to: ARC_USDC, data: approveData("0x000000000000000000000000000000000000dEaD") }, ARC_USDC, [FLASH_ALLOWANCE_ARC]),
    ).toThrow(/unknown spender/);
  });

  it("refuses an approval of the wrong token", () => {
    expect(() => assertApprovalMatches({ to: TOKEN, data: approveData(FLASH_ALLOWANCE_ARC) }, ARC_USDC, [FLASH_ALLOWANCE_ARC])).toThrow(/wrong token/);
  });

  it("refuses a transfer dressed up as setup", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [WALLET as `0x${string}`, 1n] });
    expect(() => assertApprovalMatches({ to: ARC_USDC, data }, ARC_USDC, [FLASH_ALLOWANCE_ARC])).toThrow(/isn't an approval/);
  });
});

const baseReq: RouteRequest = {
  side: "buy",
  chain: "base",
  address: TOKEN,
  decimals: 18,
  usdcIn: "25",
  evmAddress: WALLET,
  solanaAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  priceUsd: "2",
  notionalUsd: "25",
};

describe("Flash request building", () => {
  it("spends Arc USDC on a cross-chain buy and pins the recipient to the user", () => {
    const p = buildFlashParams(baseReq, 0);
    expect(p).toMatchObject({ targetChain: "base", contraChain: "arc", contraAsset: ARC_USDC, side: "buy", qty: "25", funderAddress: WALLET, recipientAddress: WALLET });
    expect(p.maxSlippage).toBe("0.2");
    expect(p.maxPriceImpact).toBe("0.5");
  });

  it("sends Solana buys to the Solana wallet", () => {
    const p = buildFlashParams({ ...baseReq, chain: "solana" }, 0);
    expect(p.funderAddress).toBe(WALLET);
    expect(p.recipientAddress).toBe(baseReq.solanaAddress);
  });

  it("funds Solana sells from the Solana wallet and returns USDC to Arc", () => {
    const p = buildFlashParams({ ...baseReq, chain: "solana", side: "sell", usdcIn: undefined, qtyIn: "100" }, 0);
    expect(p.funderAddress).toBe(baseReq.solanaAddress);
    expect(p.recipientAddress).toBe(WALLET);
    expect(p.qty).toBe("100");
  });

  it("uses 1% slippage same-chain and no recipient", () => {
    const p = buildFlashParams({ ...baseReq, chain: "arc" }, 0);
    expect(p.maxSlippage).toBe("0.05");
    expect(p.maxPriceImpact).toBe("0.5");
    expect(p.recipientAddress).toBeUndefined();
  });

  it("sends the fee only when one is set", () => {
    expect(buildFlashParams(baseReq, 0).flashIntegratorFeeBps).toBeUndefined();
    expect(buildFlashParams(baseReq, 50).flashIntegratorFeeBps).toBe("50");
  });

  it("errors clearly when a Solana wallet is missing", () => {
    expect(() => buildFlashParams({ ...baseReq, chain: "solana", solanaAddress: null }, 0)).toThrow(/no Solana wallet/);
  });
});

describe("Flash status mapping", () => {
  const order = (status: string, extra: object = {}) => ({ order: { status, closeReason: null, ...extra }, fills: [] });

  it("maps a buy fill", () => {
    const u = flashStatusToUpdate(
      {
        order: { status: "ORDER_STATUS_FILLED", closeReason: "REASON_FULLY_FILLED", filled: { targetAmount: "10", contraAmount: "25", averageNotionalPrice: "2.5" } },
        fills: [{ transactionId: "0xsrc", feeNotional: "0.1" }, { transactionId: "0xdst", feeNotional: "0.2" }],
      },
      { side: "buy" },
    );
    expect(u).toMatchObject({ status: "filled", qty: "10", usdIn: "25", priceUsd: "2.5", srcTx: "0xsrc", dstTx: "0xdst" });
    expect(Number(u.feeUsd)).toBeCloseTo(0.3);
  });

  it("maps a sell fill to USD out", () => {
    const u = flashStatusToUpdate({ order: { status: "ORDER_STATUS_FILLED", closeReason: null, filled: { targetAmount: "10", contraAmount: "30" } }, fills: [] }, { side: "sell" });
    expect(u).toMatchObject({ status: "filled", qty: "10", usdOut: "30", priceUsd: "3" });
  });

  it("calls it failed when nothing moved", () => {
    expect(flashStatusToUpdate({ order: { status: "ORDER_STATUS_REJECTED", closeReason: "REASON_MAXIMUM_SLIPPAGE_EXCEEDED" }, fills: [] }, { side: "buy" })).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/slippage/),
    });
  });

  it("calls it refunded when funds left the source chain and the order still closed", () => {
    expect(flashStatusToUpdate({ order: { status: "ORDER_STATUS_TERMINATED", closeReason: null }, fills: [{ transactionId: "0xsrc" }] }, { side: "buy" }).status).toBe("refunded");
  });

  it("tracks progress", () => {
    expect(flashStatusToUpdate(order("ORDER_STATUS_ACCEPTED"), { side: "buy" }).status).toBe("pending");
    expect(flashStatusToUpdate({ order: { status: "ORDER_STATUS_ACCEPTED", closeReason: null }, fills: [{ transactionId: "0xsrc" }] }, { side: "buy" }).status).toBe("source_confirmed");
  });
});

describe("LI.FI status mapping", () => {
  const req = { side: "buy" as const, usdcIn: "25", priceUsd: "2" };
  it("maps a completed buy", () => {
    const u = lifiStatusToUpdate({ status: "DONE", substatus: "COMPLETED", receiving: { amount: "10000000000000000000", txHash: "0xd", token: { decimals: 18 } } }, req, "0xs");
    expect(u).toMatchObject({ status: "filled", qty: "10", usdIn: "25", priceUsd: "2.5", dstTx: "0xd" });
  });
  it("detects a refund", () => {
    expect(lifiStatusToUpdate({ status: "DONE", substatus: "REFUNDED" }, req, "0xs").status).toBe("refunded");
  });
  it("maps failures and progress", () => {
    expect(lifiStatusToUpdate({ status: "FAILED" }, req, "0xs").status).toBe("failed");
    expect(lifiStatusToUpdate({ status: "PENDING" }, req, "0xs").status).toBe("source_confirmed");
    expect(lifiStatusToUpdate({ status: "NOT_FOUND" }, req, "0xs").status).toBe("pending");
  });
});

describe("paper fills", () => {
  it("fills at exactly what the quote promised", () => {
    const quote = syntheticQuote(baseReq, "100000");
    const fill = paperFill(baseReq, quote);
    expect(fill.status).toBe("filled");
    expect(fill.qty).toBe(quote.expectedOut);
    expect(fill.usdIn).toBe("25");
  });
  it("costs more when the pool is thin", () => {
    expect(Number(syntheticQuote(baseReq, "1000").expectedOut)).toBeLessThan(Number(syntheticQuote(baseReq, "1000000").expectedOut));
  });
});

describe("re-quote tolerance", () => {
  it("accepts a small move and rejects a large one", () => {
    expect(withinTolerance("100", "99.5", 0.01)).toBe(true);
    expect(withinTolerance("100", "98.9", 0.01)).toBe(false);
    expect(withinTolerance("100", "105", 0.01)).toBe(true);
  });
});

describe("DexScreener normalization", () => {
  const pair = (over: Partial<DexPair>): DexPair => ({
    chainId: "arc",
    dexId: "uniswap",
    pairAddress: "0xpool",
    baseToken: { address: TOKEN, name: "Token", symbol: "TKN" },
    quoteToken: { address: ARC_USDC, name: "USDC", symbol: "USDC" },
    priceUsd: "2",
    marketCap: 1000,
    liquidity: { usd: 100 },
    volume: { h24: 10 },
    txns: { h24: { buys: 1, sells: 2 } },
    ...over,
  });

  it("doesn't use the pair's price when the token is the quote side", () => {
    const snap = pairToSnapshot("arc", ARC_USDC, pair({}));
    expect(snap.priceUsd).toBeNull();
    expect(snap.marketCapUsd).toBeNull();
    expect(snap.symbol).toBe("USDC");
  });

  it("prices from the deepest pool and sums volume across pools", () => {
    const snap = bestSnapshot("arc", TOKEN, [pair({ priceUsd: "1", liquidity: { usd: 50 } }), pair({ priceUsd: "2", liquidity: { usd: 500 }, pairAddress: "0xdeep" })])!;
    expect(snap.priceUsd).toBe("2");
    expect(snap.pairAddress).toBe("0xdeep");
    expect(snap.volumeUsd.h24).toBe(20);
    expect(snap.txns.h24).toEqual({ buys: 2, sells: 4 });
  });

  it("returns null with no pools", () => {
    expect(bestSnapshot("arc", TOKEN, [])).toBeNull();
  });
});

describe("production guard", () => {
  const prod = {
    NODE_ENV: "production",
    AUTH_MODE: "privy",
    TRADING_MODE: "live",
    PRIVY_APP_ID: "a",
    PRIVY_APP_SECRET: "b",
    FLASH_API_KEY: "c",
    APP_ORIGIN: "https://app.example.com",
  } as Env;

  it("passes a real production config", () => {
    expect(() => assertSafeForProduction(prod)).not.toThrow();
  });
  it("refuses dev login in production", () => {
    expect(() => assertSafeForProduction({ ...prod, AUTH_MODE: "dev" })).toThrow(/AUTH_MODE=dev/);
  });
  it("refuses paper trading in production", () => {
    expect(() => assertSafeForProduction({ ...prod, TRADING_MODE: "paper" })).toThrow(/TRADING_MODE=paper/);
  });
  it("refuses missing keys and plain http", () => {
    expect(() => assertSafeForProduction({ ...prod, FLASH_API_KEY: undefined })).toThrow(/FLASH_API_KEY/);
    expect(() => assertSafeForProduction({ ...prod, APP_ORIGIN: "http://x" })).toThrow(/https/);
  });
  it("doesn't apply outside production", () => {
    expect(() => assertSafeForProduction({ ...prod, NODE_ENV: "development", AUTH_MODE: "dev", TRADING_MODE: "paper" })).not.toThrow();
  });
});

describe("rate limiter", () => {
  it("lets a burst through, then makes callers wait", async () => {
    const limiter = new RateLimiter(600, 2);
    const started = Date.now();
    await Promise.all([limiter.acquire(), limiter.acquire()]);
    expect(Date.now() - started).toBeLessThan(50);
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });
});

describe("quote race window", () => {
  const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));
  const failAfter = (ms: number) => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("boom")), ms));

  it("returns as soon as everything has answered", async () => {
    const started = Date.now();
    const results = await settleWithinWindow([after(5, "a"), after(10, "b")], 100, 300);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(Date.now() - started).toBeLessThan(90);
  });

  it("drops a straggler once the window closes and a quote is in", async () => {
    const started = Date.now();
    const results = await settleWithinWindow([after(5, "fast"), after(1000, "slow")], 50, 300);
    expect(results[0]).toEqual({ status: "fulfilled", value: "fast" });
    expect(results[1]!.status).toBe("rejected");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("keeps waiting past the window when nothing has answered yet", async () => {
    const results = await settleWithinWindow([after(100, "late")], 20, 500);
    expect(results[0]).toEqual({ status: "fulfilled", value: "late" });
  });

  it("gives up at the hard limit", async () => {
    const started = Date.now();
    const results = await settleWithinWindow([after(1000, "never")], 20, 80);
    expect(results[0]!.status).toBe("rejected");
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("reports errors without hanging", async () => {
    const results = await settleWithinWindow([failAfter(5), after(10, "ok")], 100, 300);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("handles no providers", async () => {
    expect(await settleWithinWindow([], 10, 20)).toEqual([]);
  });
});

describe("Uniswap swap sanity", () => {
  const router = UNISWAP_ARC.universalRouter212;
  it("accepts a native buy whose value is the amount at 18 decimals", () => {
    expect(() => assertSwapMatches({ to: router, value: "0x0de0b6b3a7640000" }, { amountIn: 1_000_000n, nativeInput: true })).not.toThrow();
  });
  it("accepts a token sell with no value", () => {
    expect(() => assertSwapMatches({ to: router.toLowerCase(), value: "0x0" }, { amountIn: 5n, nativeInput: false })).not.toThrow();
  });
  it("refuses a buy that would spend more than quoted", () => {
    expect(() => assertSwapMatches({ to: router, value: "0x1bc16d674ec80000" }, { amountIn: 1_000_000n, nativeInput: true })).toThrow(/value/);
  });
  it("refuses a sell that also sends USDC", () => {
    expect(() => assertSwapMatches({ to: router, value: "0x1" }, { amountIn: 5n, nativeInput: false })).toThrow(/value/);
  });
  it("refuses any other contract", () => {
    expect(() => assertSwapMatches({ to: WALLET, value: "0x0" }, { amountIn: 5n, nativeInput: false })).toThrow(/Universal Router/);
  });
});

describe("thesis anchoring", () => {
  const input = {
    id: "11111111-1111-1111-1111-111111111111",
    author: "0xFA8864f4CC3DE8e659EF16ee3FcA726408cb186a",
    chain: "arc",
    token: TOKEN,
    body: "Volume is real",
    priceAtPost: "0.001673000000000000",
    positionUsdAtPost: "24.740000000000000000",
    postedAt: 1_793_880_000,
  };

  it("hashes the same thesis the same way every time, whatever the key order given", () => {
    const shuffled = { body: input.body, postedAt: input.postedAt, id: input.id, token: input.token, chain: input.chain, author: input.author, positionUsdAtPost: input.positionUsdAtPost, priceAtPost: input.priceAtPost };
    expect(canonicalThesis(shuffled)).toBe(canonicalThesis(input));
    expect(thesisHash(canonicalThesis(input))).toBe(thesisHash(canonicalThesis(shuffled)));
  });

  it("changes the hash if anything in the thesis changes", () => {
    const base = thesisHash(canonicalThesis(input));
    expect(thesisHash(canonicalThesis({ ...input, body: "Volume is fake" }))).not.toBe(base);
    expect(thesisHash(canonicalThesis({ ...input, priceAtPost: "0.002" }))).not.toBe(base);
    expect(thesisHash(canonicalThesis({ ...input, positionUsdAtPost: "2474" }))).not.toBe(base);
  });

  it("treats an address the same in any letter case", () => {
    expect(canonicalThesis({ ...input, author: input.author.toLowerCase() })).toBe(canonicalThesis(input));
  });

  it("keeps a thesis's retries through outages, and spends them only on its own failures", () => {
    const revert = (errorName: string) => {
      const err = new BaseError("reverted", { cause: new ContractFunctionRevertedError({ abi: THESIS_REGISTRY_ABI, functionName: "anchor", message: errorName }) });
      const inner = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError;
      Object.assign(inner, { data: { errorName, abiItem: {}, args: [] } });
      return err;
    };
    expect(isThesisSpecificFailure(new HttpRequestError({ url: "https://rpc.mainnet.arc.io" }))).toBe(false);
    expect(isThesisSpecificFailure(new BaseError("insufficient funds for gas"))).toBe(false);
    expect(isThesisSpecificFailure(revert("NotRelayer"))).toBe(false);
    expect(isThesisSpecificFailure(revert("ZeroAddress"))).toBe(true);
    expect(isThesisSpecificFailure(new Error("Bad number in the thesis"))).toBe(true);
  });

  it("sends price at 18 decimals and position at 6", () => {
    const [, , postedAt, price, position] = anchorArgs(input);
    expect(postedAt).toBe(1_793_880_000n);
    expect(price).toBe(1_673_000_000_000_000n);
    expect(position).toBe(24_740_000n);
  });
});

describe("forbidden endpoint", () => {
  it("is not called anywhere in the code", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const banned = ["definitive.fi/api", "/leads"].join("");
    const root = resolve(__dirname, "../../..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        if (["node_modules", ".next", "dist", ".redis"].includes(name)) return [];
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const hits = ["apps", "packages"].flatMap((d) => walk(join(root, d))).filter((f) => /\.(ts|tsx|js|json)$/.test(f) && readFileSync(f, "utf8").includes(banned));
    expect(hits).toEqual([]);
  });
});

describe("gas sponsorship", () => {
  const withKey = (key: string, run: () => void) => {
    const before = process.env.PIMLICO_API_KEY;
    process.env.PIMLICO_API_KEY = key;
    resetEnvForTests();
    try {
      run();
    } finally {
      process.env.PIMLICO_API_KEY = before ?? "";
      resetEnvForTests();
    }
  };

  it("stays off until a key is set", () => {
    withKey("", () => {
      expect(gaslessEnabled()).toBe(false);
      expect(sponsorshipConfigured("arc")).toBe(false);
    });
  });

  it("covers the chains where wallets can upgrade, and leaves the rest to the old path", () => {
    withKey("test-key", () => {
      expect(gaslessEnabled()).toBe(true);
      for (const chain of ["arc", "robinhood", "base", "arbitrum", "ethereum", "bsc"] as const) expect(sponsorshipConfigured(chain)).toBe(true);
      expect(sponsorshipConfigured("hyperevm")).toBe(false);
      expect(sponsorshipConfigured("solana")).toBe(false);
    });
  });
});

describe("the app's fee", () => {
  const quote = (provider: string) => ({ provider }) as ProviderQuote;

  it("skips a route that can't collect the fee when another can do the trade", () => {
    expect(pickWinner([quote("lifi"), quote("flash")], false)?.provider).toBe("flash");
  });

  it("still uses that route when it's the only way to trade", () => {
    expect(pickWinner([quote("lifi")], false)?.provider).toBe("lifi");
  });

  it("lets it compete on price once it can collect", () => {
    expect(pickWinner([quote("lifi"), quote("flash")], true)?.provider).toBe("lifi");
  });

  it("sends the fee to Flash on quotes and orders", () => {
    const request = { side: "buy", chain: "base", address: TOKEN, decimals: 18, usdcIn: "10", evmAddress: WALLET, solanaAddress: null, priceUsd: "1", notionalUsd: "10" } as const;
    expect(buildFlashParams(request, 50).flashIntegratorFeeBps).toBe("50");
  });
});

describe("trackers", () => {
  it("keeps posts that name a token or are about crypto, and drops the rest", () => {
    expect(isRelevant("Just bought more $WIF, looks strong")).toBe(true);
    expect(isRelevant("Bitcoin ETF flows are picking up again")).toBe(true);
    expect(isRelevant("Check 0x4200000000000000000000000000000000000006 today")).toBe(true);
    expect(isRelevant("Had a great dinner with friends tonight")).toBe(false);
    expect(isRelevant("gm")).toBe(false);
  });

  it("finds tickers and addresses in a post", () => {
    expect(extractTokens("$wif and $BONK on 0x4200000000000000000000000000000000000006")).toEqual(["$WIF", "$BONK", "0x4200000000000000000000000000000000000006"]);
    expect(extractTokens("Costs $100 today")).toEqual([]);
  });

  it("reads X's response, and labels quotes", () => {
    const posts = parseXResponse({
      data: [
        { id: "1", text: "hello", author_id: "a", created_at: "2026-11-06T00:00:00Z" },
        { id: "2", text: "quoted", author_id: "a", created_at: "2026-11-06T00:00:00Z", referenced_tweets: [{ type: "quoted" }] },
        { id: "3", text: "no author", author_id: "missing", created_at: "2026-11-06T00:00:00Z" },
      ],
      includes: { users: [{ id: "a", name: "Ann", username: "ann" }] },
    });
    expect(posts.map((p) => [p.id, p.kind, p.url])).toEqual([
      ["x:1", "post", "https://x.com/ann/status/1"],
      ["x:2", "quote", "https://x.com/ann/status/2"],
    ]);
  });

  it("reads Telegram's preview page as plain text, with no markup left", () => {
    const html = `<meta property="og:title" content="Guru &amp; Co">
      <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="guru/42">
      <div class="tgme_widget_message_text js-message_text" dir="auto"><b>JUST IN:</b> $BTC &gt; 100k<br/>wow <script>alert(1)</script></div>
      <div class="tgme_widget_message_footer"><time datetime="2026-11-06T01:02:03+00:00">x</time></div></div></div>`;
    const [post] = parseTelegramPage(html, "guru");
    expect(post).toMatchObject({ id: "telegram:guru:42", authorName: "Guru & Co", url: "https://t.me/guru/42" });
    expect(post!.body.startsWith("JUST IN: $BTC > 100k\nwow")).toBe(true);
    expect(post!.body).not.toContain("<");
  });
});
