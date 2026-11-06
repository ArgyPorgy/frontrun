import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A live-mode trade through a stand-in Flash. Only signing and chain reads are replaced.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/frontrun_test",
    REDIS_URL: "redis://localhost:6379/15",
    AUTH_MODE: "dev",
    TRADING_MODE: "live",
    DEV_JWT_SECRET: "test-secret-test-secret-test-secret",
    APP_ORIGIN: "http://localhost:3000",
    FLASH_API_KEY: "test-key",
    FLASH_INTEGRATOR_FEE_BPS: "50",
    UNISWAP_API_KEY: "",
    PIMLICO_API_KEY: "",
    GAS_TOPUP_PRIVATE_KEY: "",
  });
});

const chain = vi.hoisted(() => ({ connectorHeld: "1000" }));

vi.mock("../../../packages/server/src/trading/signer", async (original) => ({
  ...(await original<object>()),
  serverSigningConfigured: () => true,
  solanaSigningConfigured: () => true,
  loadSigningWallets: async () => ({ evmWalletId: "wallet", evmAddress: WALLET, solanaWalletId: null, solanaAddress: null }),
  performServerStep: async (_wallets: unknown, step: { id: string; kind: string }) =>
    step.kind === "evm_tx" ? { id: step.id, txHash: `0x${step.id}` } : { id: step.id, signature: `0xsigned-${step.id}` },
}));

vi.mock("../../../packages/server/src/onchain", async (original) => ({
  ...(await original<object>()),
  tokenBalance: async () => chain.connectorHeld,
  erc20Allowance: async () => 0n,
  arcUsdcBalance: async () => 100_000_000n,
}));

import { ARC_USDC, FLASH_ALLOWANCE_ARC, TWO_STEP_CONNECTORS, toBaseUnits } from "@frontrun/core";
import { KEYS, applyGuardrails, closeDb, closeRedis, db, executeTrade, flashProvider, isTwoStep, pollActiveTrades, redis, runMigrations, schema, type TwoStepRoute } from "@frontrun/server";
import { and, eq, isNull, sql } from "drizzle-orm";

const WALLET = "0xd3be5751936348f00fd2721487813c64fbe37618";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const USDG = TWO_STEP_CONNECTORS.robinhood!.address;
/** approve(Flash's allowance contract, max). */
const APPROVE_FLASH = `0x095ea7b3${FLASH_ALLOWANCE_ARC.slice(2).toLowerCase().padStart(64, "0")}${"f".repeat(64)}`;

interface FlashOrderBody {
  targetAsset: string;
  contraAsset: string;
  contraChain: string;
  side: "buy" | "sell";
  qty: string;
  funderAddress: string;
  flashIntegratorFeeBps?: string;
}

const realFetch = globalThis.fetch;
let placed: FlashOrderBody[] = [];
let fills: Record<string, unknown> = {};
let secondOrderQuoteRate = 0.98;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function flashQuote(body: FlashOrderBody) {
  if (body.contraChain === "arc" && body.targetAsset === NVDA) return json({ error: { code: "NOT_FOUND", message: "flash quote failed: no bridge routes available for this cross-chain transfer" } }, 404);
  const spent = body.side === "sell" ? body.targetAsset : body.contraAsset;
  const decimals = spent === NVDA ? 18 : 6;
  const stable = body.targetAsset === USDG || body.contraAsset === USDG;
  const isSecond = (body.side === "sell" && body.targetAsset === USDG) || (body.side === "buy" && body.targetAsset === NVDA);
  const inUsd = body.side === "sell" && body.targetAsset === NVDA ? Number(body.qty) * 186 : Number(body.qty);
  const outUsd = inUsd * (isSecond ? secondOrderQuoteRate : 0.98);
  const outAmount = body.side === "buy" && body.targetAsset === NVDA ? outUsd / 186 : outUsd;
  if (!stable) throw new Error("this test only trades through USDG");
  return json({
    quoteId: `quote-${placed.length}`,
    from: { amount: body.qty, notional: String(inUsd) },
    to: { amount: outAmount.toFixed(decimals === 18 ? 6 : 18), notional: outUsd.toFixed(6) },
    fees: { estimatedFeeNotional: body.flashIntegratorFeeBps ? "0.02" : "0" },
    estimatedPriceImpact: "0.01",
    evm: {
      approveTx: spent === ARC_USDC ? null : { to: spent, data: APPROVE_FLASH },
      orderTypedData: JSON.stringify({
        domain: { name: "DefinitiveFlashAllowance", chainId: spent === ARC_USDC ? 5042 : 4663, verifyingContract: FLASH_ALLOWANCE_ARC },
        primaryType: "FlashOrder",
        message: { swapper: body.funderAddress, fromToken: spent, fromAmount: toBaseUnits(body.qty, decimals).toString() },
      }),
    },
  });
}

const filled = (targetAmount: string, contraAmount: string, tx: string, feeNotional = "0") => ({
  order: { status: "ORDER_STATUS_FILLED", closeReason: null, filled: { targetAmount, contraAmount } },
  fills: [{ transactionId: tx, feeNotional }],
});
const closed = { order: { status: "ORDER_STATUS_CANCELLED", closeReason: "REASON_ORDER_EXPIRED" }, fills: [] };

let userId: string;

/** Lets the next poll act right away: nothing's waiting on a clock in these tests. */
async function tick() {
  await db().execute(sql`update trades set updated_at = now() - interval '1 minute', exec_state = jsonb_set(exec_state, '{quote,raw,nextAttemptAt}', 'null') where status in ('pending', 'source_confirmed')`);
  await pollActiveTrades();
}

async function placeTrade(side: "buy" | "sell") {
  const request = {
    side,
    chain: "robinhood" as const,
    address: NVDA,
    decimals: 18,
    ...(side === "sell" ? { qtyIn: "0.02" } : { usdcIn: "4" }),
    evmAddress: WALLET,
    solanaAddress: null,
    priceUsd: "186",
    notionalUsd: side === "sell" ? "3.72" : "4",
  };
  const winner = await flashProvider.quote(request);
  expect(isTwoStep(winner.raw)).toBe(true);
  const tokenSafety = { liquidityUsd: "1900000", riskFlagged: false, denylisted: false };
  const id = crypto.randomUUID();
  const record = {
    id,
    userId,
    request,
    winner,
    alternatives: [],
    guardrails: applyGuardrails(request, winner, tokenSafety),
    token: { chain: "robinhood", address: NVDA, symbol: "NVDA", name: "NVIDIA", imageUrl: null },
    tokenSafety,
    copy: null,
    slippage: 0.2,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
  };
  await redis().set(KEYS.quote(id), JSON.stringify(record), "EX", 180);
  return executeTrade(userId, { quoteId: id, idempotencyKey: crypto.randomUUID(), confirmed: true });
}

const tradeRow = async (id: string) => (await db().query.trades.findFirst({ where: eq(schema.trades.id, id) }))!;
const openPosition = (address: string) =>
  db().query.positions.findFirst({ where: and(eq(schema.positions.userId, userId), eq(schema.positions.tokenAddr, address), isNull(schema.positions.closedAt)) });

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("flash.definitive.fi/v1/quote")) return flashQuote(JSON.parse(String(init?.body)) as FlashOrderBody);
    if (url.endsWith("flash.definitive.fi/v1/order")) {
      placed.push(JSON.parse(String(init?.body)) as FlashOrderBody);
      return json({ orderId: `order-${placed.length}` });
    }
    const status = url.match(/\/v1\/orders\/([^?]+)/);
    if (status) return json(fills[status[1]!] ?? { order: { status: "ORDER_STATUS_PENDING", closeReason: null }, fills: [] });
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return realFetch(input, init);
    throw new Error(`blocked network call in test: ${url}`);
  });
  await runMigrations();
});

beforeEach(async () => {
  await db().execute(sql`truncate users, tokens, provider_events, audit_log restart identity cascade`);
  await redis().flushdb();
  placed = [];
  fills = {};
  chain.connectorHeld = "1000";
  secondOrderQuoteRate = 0.98;
  const [user] = await db().insert(schema.users).values({ privyId: "did:test", username: "tester" }).returning();
  userId = user!.id;
  await db().insert(schema.signerGrants).values({ userId, perTradeCapUsd: "100", dailyCapUsd: "1000", expiresAt: new Date(Date.now() + 86_400_000), approvalTx: "0xdone" });
  await db().insert(schema.tokens).values({ chain: "robinhood", address: NVDA, symbol: "NVDA", name: "NVIDIA" });
  await db().insert(schema.positions).values({ userId, tokenChain: "robinhood", tokenAddr: NVDA, qty: "0.02", costBasisUsd: "3.8" });
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
  vi.unstubAllGlobals();
});

describe("selling a token Flash can't bridge directly", () => {
  it("sells into the stablecoin, then brings that to Arc, and records one trade", async () => {
    const trade = await placeTrade("sell");
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ targetAsset: NVDA, contraAsset: USDG, contraChain: "robinhood", side: "sell", qty: "0.02" });
    expect(placed[0]!.flashIntegratorFeeBps).toBeUndefined();

    // Nothing moves on until the first order has filled.
    await tick();
    expect(placed).toHaveLength(1);
    expect((await tradeRow(trade.id)).status).toBe("pending");

    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    await tick();
    expect((await tradeRow(trade.id)).status).toBe("source_confirmed");
    await tick();
    expect(placed).toHaveLength(2);
    expect(placed[1]).toMatchObject({ targetAsset: USDG, contraAsset: ARC_USDC, contraChain: "arc", side: "sell", qty: "3.6", flashIntegratorFeeBps: "50" });

    fills["order-2"] = filled("3.6", "3.55", "0xbridged", "0.018");
    await tick();
    const row = await tradeRow(trade.id);
    expect(row.status).toBe("filled");
    expect(row.qty).toMatch(/^0\.02/);
    expect(row.usdOut).toMatch(/^3\.55/);
    expect(row.revenueUsd).toMatch(/^0\.018/);
    expect(row.srcTx).toBe("0xsold");
    expect(row.dstTx).toBe("0xbridged");
    expect(await openPosition(NVDA)).toBeUndefined();
    expect(await openPosition(USDG)).toBeUndefined();
  });

  it("only sells what this trade received, even if the wallet holds more", async () => {
    await placeTrade("sell");
    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    chain.connectorHeld = "50";
    await tick();
    await tick();
    expect(placed[1]!.qty).toBe("3.6");
  });

  it("waits for the stablecoin to show up rather than selling nothing", async () => {
    const trade = await placeTrade("sell");
    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    chain.connectorHeld = "0";
    await tick();
    await tick();
    expect(placed).toHaveLength(1);
    expect((await tradeRow(trade.id)).status).toBe("source_confirmed");
    chain.connectorHeld = "3.6";
    await tick();
    expect(placed).toHaveLength(2);
  });

  it("fails cleanly when the first order doesn't fill, since nothing moved", async () => {
    const trade = await placeTrade("sell");
    fills["order-1"] = closed;
    await tick();
    const row = await tradeRow(trade.id);
    expect(row.status).toBe("failed");
    expect(placed).toHaveLength(1);
    expect((await openPosition(NVDA))?.qty).toMatch(/^0\.02/);
  });

  it("tries the second order again after it closes unfilled", async () => {
    const trade = await placeTrade("sell");
    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    await tick();
    await tick();
    fills["order-2"] = closed;
    await tick();
    expect((await tradeRow(trade.id)).providerOrderId).toBeNull();
    await tick();
    expect(placed).toHaveLength(3);
    fills["order-3"] = filled("3.6", "3.5", "0xbridged");
    await tick();
    const row = await tradeRow(trade.id);
    expect(row.status).toBe("filled");
    expect(row.usdOut).toMatch(/^3\.5/);
    expect(await openPosition(USDG)).toBeUndefined();
  });

  it("hands the stablecoin over as a holding once the tries run out", async () => {
    const trade = await placeTrade("sell");
    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    await tick();
    for (let attempt = 2; attempt <= 7; attempt++) {
      await tick();
      expect(placed).toHaveLength(attempt);
      fills[`order-${attempt}`] = closed;
      await tick();
    }
    await tick();
    expect(placed).toHaveLength(7);
    const row = await tradeRow(trade.id);
    expect(row.status).toBe("filled");
    expect(row.usdOut).toMatch(/^3\.6/);
    expect(await openPosition(NVDA)).toBeUndefined();
    expect((await openPosition(USDG))?.qty).toMatch(/^3\.6/);
    const note = await db().query.notifications.findFirst({ where: and(eq(schema.notifications.userId, userId), sql`${schema.notifications.message} like '%portfolio%'`) });
    expect(note?.message).toContain("3.6 USDG");
    const token = await db().query.tokens.findFirst({ where: eq(schema.tokens.address, USDG) });
    expect(token?.symbol).toBe("USDG");
    // Closed, so it's never picked up again and the holding can't be counted twice.
    await tick();
    expect((await openPosition(USDG))?.qty).toMatch(/^3\.6/);
  });

  it("won't send a second order that loses too much, and keeps the stablecoin instead", async () => {
    const trade = await placeTrade("sell");
    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    await tick();
    secondOrderQuoteRate = 0.5;
    for (let i = 0; i < 8; i++) await tick();
    expect(placed).toHaveLength(1);
    expect((await tradeRow(trade.id)).status).toBe("filled");
    expect((await openPosition(USDG))?.qty).toMatch(/^3\.6/);
  });

  it("stops at the stablecoin when one-tap was turned off in between", async () => {
    const trade = await placeTrade("sell");
    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    await tick();
    await db().update(schema.signerGrants).set({ revokedAt: new Date() }).where(eq(schema.signerGrants.userId, userId));
    await tick();
    expect(placed).toHaveLength(1);
    expect((await tradeRow(trade.id)).status).toBe("filled");
    expect((await openPosition(USDG))?.qty).toMatch(/^3\.6/);
  });

  it("sends the second order once when two copies of the workers poll together", async () => {
    await placeTrade("sell");
    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    await db().execute(sql`update trades set updated_at = now() - interval '1 minute'`);
    await Promise.all([pollActiveTrades(), pollActiveTrades()]);
    await db().execute(sql`update trades set updated_at = now() - interval '1 minute'`);
    await Promise.all([pollActiveTrades(), pollActiveTrades(), pollActiveTrades()]);
    expect(placed).toHaveLength(2);
  });

  it("keeps the working order's id when a stale poll sees the first order fill", async () => {
    const trade = await placeTrade("sell");
    fills["order-1"] = filled("0.02", "3.6", "0xsold");
    await tick();
    await tick();
    expect((await tradeRow(trade.id)).providerOrderId).toBe("order-2");
    const route = (await tradeRow(trade.id)).execState as { quote: { raw: TwoStepRoute } };
    expect(route.quote.raw.current).toBe(1);
    expect(route.quote.raw.legs[0].orderId).toBe("order-1");
  });
});

describe("buying a token Flash can't bridge directly", () => {
  it("buys the stablecoin from Arc, then the token, and records one trade", async () => {
    const trade = await placeTrade("buy");
    expect(placed[0]).toMatchObject({ targetAsset: USDG, contraAsset: ARC_USDC, contraChain: "arc", side: "buy", qty: "4", flashIntegratorFeeBps: "50" });

    fills["order-1"] = filled("3.9", "4", "0xbridged", "0.02");
    await tick();
    await tick();
    expect(placed[1]).toMatchObject({ targetAsset: NVDA, contraAsset: USDG, contraChain: "robinhood", side: "buy", qty: "3.9" });
    expect(placed[1]!.flashIntegratorFeeBps).toBeUndefined();

    fills["order-2"] = filled("0.0205", "3.9", "0xbought");
    await tick();
    const row = await tradeRow(trade.id);
    expect(row.status).toBe("filled");
    expect(row.tokenAddr).toBe(NVDA);
    expect(row.usdIn).toMatch(/^4/);
    expect(row.qty).toMatch(/^0\.0205/);
    expect((await openPosition(NVDA))?.qty).toMatch(/^0\.0405/);
    expect(await openPosition(USDG)).toBeUndefined();
  });

  it("records a buy of the stablecoin when the second order can't go through", async () => {
    const trade = await placeTrade("buy");
    fills["order-1"] = filled("3.9", "4", "0xbridged", "0.02");
    await tick();
    secondOrderQuoteRate = 0.5;
    for (let i = 0; i < 8; i++) await tick();
    const row = await tradeRow(trade.id);
    expect(row.status).toBe("filled");
    expect(row.tokenAddr).toBe(USDG);
    expect(row.usdIn).toMatch(/^4/);
    expect((await openPosition(USDG))?.qty).toMatch(/^3\.9/);
    expect((await openPosition(NVDA))?.qty).toMatch(/^0\.02/);
  });
});
