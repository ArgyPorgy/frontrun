import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Env has to be in place before the server modules load, so this sits ahead of their imports.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/frontrun_test",
    REDIS_URL: "redis://localhost:6379/15",
    AUTH_MODE: "dev",
    TRADING_MODE: "paper",
    DEV_JWT_SECRET: "test-secret-test-secret-test-secret",
    APP_ORIGIN: "http://localhost:3000",
    GEO_BLOCKED_COUNTRIES: "IR,KP",
    ADMIN_TOKEN: "test-admin",
    FLASH_API_KEY: "",
    UNISWAP_API_KEY: "",
    COINGECKO_API_KEY: "",
    PRIVY_APP_ID: "",
    PRIVY_APP_SECRET: "",
    PRIVY_AUTHORIZATION_KEY: "",
    PRIVY_SIGNER_ID: "",
    PRIVY_POLICY_IDS: "",
    PRIVY_SOLANA_POLICY_IDS: "",
    GAS_TOPUP_PRIVATE_KEY: "",
    THESIS_REGISTRY_ADDRESS: "",
    PIMLICO_API_KEY: "",
    ANCHOR_RELAYER_PRIVATE_KEY: "",
  });
});

import { ApiClient, ApiError, THESIS_RESOLVE_HOURS, tokenKey, type ChainKey, type TokenSnapshot } from "@frontrun/core";
import {
  DEX_BACKGROUND_PER_MINUTE,
  DexBusyError,
  checkWatchedOrders,
  KEYS,
  CHANNELS,
  closeDb,
  closeRedis,
  db,
  fetchTokens,
  pollActiveTrades,
  publish,
  redis,
  resolveDueTheses,
  runMigrations,
  schema,
  statsChanged,
} from "@frontrun/server";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { io as socketClient } from "socket.io-client";
import { buildApp } from "../src/app";
import { attachWebsocket } from "../src/ws";

const TOKEN_A = "0xbc43ce8dec648ea298c4275559b81d6261c90b67";
const TOKEN_B = "0x4c9b47dbd5933aa4574b2c27f82419e4dbbd0222";
const THIN = "0x1111111111111111111111111111111111111111";
const FLAGGED = "0x2222222222222222222222222222222222222222";
const SOL_TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function snapshot(chain: ChainKey, address: string, price: string, liquidity: string, symbol: string): TokenSnapshot {
  const w = { m5: 1, h1: 2, h6: 3, h24: 1000 };
  const t = { buys: 10, sells: 10 };
  return {
    chain,
    address,
    symbol,
    name: symbol,
    imageUrl: null,
    priceUsd: price,
    marketCapUsd: "1000000",
    fdvUsd: "1000000",
    liquidityUsd: liquidity,
    volumeUsd: w,
    txns: { m5: t, h1: t, h6: t, h24: t },
    priceChangePct: { m5: 0, h1: 0, h6: 0, h24: 5 },
    pairAddress: "0xpool",
    dexId: "test",
    pairCreatedAt: 0,
    updatedAt: Date.now(),
  };
}

async function setPrice(chain: ChainKey, address: string, price: string, liquidity = "1000000", symbol = "TKN") {
  const key = tokenKey(chain, address);
  await redis().set(KEYS.snapshot(key), JSON.stringify(snapshot(chain, address, price, liquidity, symbol)), "EX", 3600);
  await redis().set(KEYS.price(key), price, "EX", 3600);
  await redis().set(
    KEYS.tokenInfo(key),
    JSON.stringify({
      gecko: { decimals: 18, holderCount: 100, top10Pct: 20, isHoneypot: false, imageUrl: null },
      flash: { riskFlagged: address === FLAGGED, decimals: 18, holders: 100, imageUrl: null, tradable: true },
    }),
    "EX",
    3600,
  );
}

let app: FastifyInstance;
let closeWs: () => Promise<void>;
let baseUrl: string;

async function login(handle: string) {
  const anon = new ApiClient({ baseUrl });
  const { token } = await anon.devLogin(handle);
  const client = new ApiClient({ baseUrl, getToken: () => token });
  await client.syncMe();
  await client.updateMe({ username: handle });
  return { client, token };
}

async function loginFunded(handle: string) {
  const session = await login(handle);
  await session.client.paperDeposit();
  return session;
}

async function enableOneTap(client: ApiClient, caps?: { perTradeCapUsd: string; dailyCapUsd: string }) {
  await client.grantSigner(caps ?? {});
  await client.approveFlash();
}

/** Buys through the whole flow: quote, execute, and an indexer pass to fill it. */
async function buy(client: ApiClient, address: string, amountUsd: string, chain: ChainKey = "arc") {
  const quote = await client.quote({ chain, address, side: "buy", amountUsd });
  const trade = await client.executeTrade({ quoteId: quote.id, idempotencyKey: `k-${Math.random()}`, confirmed: true });
  await settle();
  return { quote, trade: await client.trade(trade.id) };
}

async function sell(client: ApiClient, address: string, sellPct: number, chain: ChainKey = "arc") {
  const quote = await client.quote({ chain, address, side: "sell", sellPct });
  const trade = await client.executeTrade({ quoteId: quote.id, idempotencyKey: `k-${Math.random()}`, confirmed: true });
  await settle();
  return { quote, trade: await client.trade(trade.id) };
}

async function settle() {
  await redis().eval(
    "for _,k in ipairs(redis.call('keys','paper:fill:*')) do redis.call('set',k,'0') end return 1",
    0,
  );
  await pollActiveTrades();
}

beforeAll(async () => {
  // Provider and RPC calls fail fast, which sends every quote to the paper engine so results are exact.
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return realFetch(input, init);
    throw new Error(`blocked network call in test: ${url}`);
  });
  await runMigrations();
  app = await buildApp();
  await app.ready();
  closeWs = await attachWebsocket(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

const realFetch = globalThis.fetch;

beforeEach(async () => {
  await db().execute(sql`truncate users, tokens, provider_events, audit_log restart identity cascade`);
  await redis().flushdb();
  await setPrice("arc", TOKEN_A, "2", "1000000", "AAA");
  await setPrice("arc", TOKEN_B, "10", "1000000", "BBB");
  await setPrice("arc", THIN, "1", "1000", "THIN");
  await setPrice("arc", FLAGGED, "1", "1000000", "BAD");
  await setPrice("solana", SOL_TOKEN, "1", "1000000", "SOLT");
});

afterAll(async () => {
  await closeWs();
  await app.close();
  await closeRedis();
  await closeDb();
  vi.unstubAllGlobals();
});

async function expectApiError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

describe("orders", () => {
  const setPrice = async (address: string, price: string) => {
    const key = tokenKey("arc", address);
    await redis().set(KEYS.price(key), price, "EX", 3600);
    await redis().set(KEYS.snapshot(key), JSON.stringify(snapshot("arc", address, price, "5000000", "AAA")), "EX", 3600);
  };

  it("holds a limit buy until the price falls to it, then fills it", async () => {
    const { client } = await loginFunded("limitbuy");
    await setPrice(TOKEN_A, "1");
    const order = await client.createOrder({ chain: "arc", address: TOKEN_A, type: "limit_buy", triggerPriceUsd: "0.8", amountUsd: "50" });
    expect(order.status).toBe("open");
    await checkWatchedOrders();
    expect((await client.orders({ status: "open" })).items).toHaveLength(1);

    await setPrice(TOKEN_A, "0.75");
    await checkWatchedOrders();
    await settle();
    expect((await client.orders({ status: "open" })).items).toHaveLength(0);
    const [done] = (await client.orders({ status: "all" })).items;
    expect(done?.status).toBe("filled");
    expect((await client.myPosition("arc", TOKEN_A)).position).not.toBeNull();
  });

  it("fires a stop-loss when the price drops, and closes the position", async () => {
    const { client } = await loginFunded("stoploss");
    await setPrice(TOKEN_A, "1");
    await buy(client, TOKEN_A, "100");
    await client.createOrder({ chain: "arc", address: TOKEN_A, type: "stop_loss", triggerPriceUsd: "0.7", sellPct: 100 });
    await setPrice(TOKEN_A, "0.9");
    await checkWatchedOrders();
    expect((await client.myPosition("arc", TOKEN_A)).position).not.toBeNull();
    await setPrice(TOKEN_A, "0.65");
    await checkWatchedOrders();
    await settle();
    expect((await client.myPosition("arc", TOKEN_A)).position).toBeNull();
    expect((await client.orders({ status: "all" })).items[0]?.status).toBe("filled");
  });

  it("fires once only, however often it's checked", async () => {
    const { client } = await loginFunded("fireonce");
    await setPrice(TOKEN_A, "1");
    await client.createOrder({ chain: "arc", address: TOKEN_A, type: "stop_buy", triggerPriceUsd: "1.2", amountUsd: "10" });
    await setPrice(TOKEN_A, "1.3");
    await Promise.all([checkWatchedOrders(), checkWatchedOrders()]);
    await settle();
    const me = await client.me();
    const trades = await db().select().from(schema.trades).where(eq(schema.trades.userId, me.id));
    expect(trades).toHaveLength(1);
  });

  it("refuses a trigger on the wrong side of the market", async () => {
    const { client } = await loginFunded("badtrigger");
    await setPrice(TOKEN_A, "1");
    await expectApiError(client.createOrder({ chain: "arc", address: TOKEN_A, type: "limit_buy", triggerPriceUsd: "1.5", amountUsd: "10" }), "bad_trigger");
  });

  it("won't take a sell order on a token you don't hold, or a buy you can't afford", async () => {
    const { client } = await loginFunded("nohold");
    await setPrice(TOKEN_A, "1");
    await expectApiError(client.createOrder({ chain: "arc", address: TOKEN_A, type: "take_profit", triggerPriceUsd: "2", sellPct: 100 }), "no_position");
    await expectApiError(client.createOrder({ chain: "arc", address: TOKEN_A, type: "limit_buy", triggerPriceUsd: "0.5", amountUsd: "99999" }), "insufficient_balance");
  });

  it("stops watching a cancelled order", async () => {
    const { client } = await loginFunded("cancels");
    await setPrice(TOKEN_A, "1");
    const order = await client.createOrder({ chain: "arc", address: TOKEN_A, type: "limit_buy", triggerPriceUsd: "0.8", amountUsd: "10" });
    expect((await client.cancelOrder(order.id)).status).toBe("cancelled");
    await setPrice(TOKEN_A, "0.5");
    await checkWatchedOrders();
    await settle();
    expect((await client.myPosition("arc", TOKEN_A)).position).toBeNull();
    await expectApiError(client.cancelOrder(order.id), "not_open");
  });

  it("keeps each person's orders private", async () => {
    const a = await loginFunded("ordera");
    const b = await loginFunded("orderb");
    await setPrice(TOKEN_A, "1");
    const order = await a.client.createOrder({ chain: "arc", address: TOKEN_A, type: "limit_buy", triggerPriceUsd: "0.8", amountUsd: "10" });
    expect((await b.client.orders({ status: "all" })).items).toHaveLength(0);
    await expect(b.client.cancelOrder(order.id)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("closing a position", () => {
  it("closes its thesis at the sale price, and counts toward accuracy", async () => {
    const { client } = await loginFunded("closer");
    await buy(client, TOKEN_A, "100");
    const thesis = await client.createThesis({ chain: "arc", address: TOKEN_A, body: "Closing this one out soon." });
    expect(thesis.outcome).toBe("pending");
    await sell(client, TOKEN_A, 100);
    const after = await client.thesis(thesis.id);
    expect(after.outcome).not.toBe("pending");
    const me = await client.me();
    const profile = await client.profile(me.username);
    expect(profile.stats.resolved).toBe(1);
  });

  it("keeps the thesis open after a partial sale", async () => {
    const { client } = await loginFunded("partial");
    await buy(client, TOKEN_A, "100");
    const thesis = await client.createThesis({ chain: "arc", address: TOKEN_A, body: "Only trimming this one a bit." });
    await sell(client, TOKEN_A, 25);
    expect((await client.thesis(thesis.id)).outcome).toBe("pending");
  });

  it("marks only the sale that closes a position", async () => {
    const { client } = await loginFunded("closeflag");
    await buy(client, TOKEN_A, "100");
    const partial = await sell(client, TOKEN_A, 25);
    expect(partial.trade.closedPosition).toBe(false);
    const rest = await sell(client, TOKEN_A, 100);
    expect(rest.trade.closedPosition).toBe(true);
  });

  it("reports what a sale made on the trade itself", async () => {
    const { client } = await loginFunded("pnlcard");
    await buy(client, TOKEN_A, "100");
    const { trade } = await sell(client, TOKEN_A, 100);
    expect(trade.pnlUsd).not.toBeNull();
    const list = await client.notifications();
    expect(list.items.some((n) => n.tradeId === trade.id)).toBe(true);
  });
});

describe("the trade indexer", () => {
  it("leaves a live trade alone while it's being submitted, and closes it only if it stalls", async () => {
    const { client } = await loginFunded("midflight");
    const me = await client.me();
    const [trade] = await db()
      .insert(schema.trades)
      .values({
        userId: me.id,
        side: "buy",
        tokenChain: "arc",
        tokenAddr: TOKEN_A,
        usdIn: "5",
        provider: "flash",
        srcChain: "arc",
        status: "pending",
        isPaper: false,
        idempotencyKey: "midflight-1",
        execState: { quote: { provider: "flash" }, request: {} },
        updatedAt: new Date(Date.now() - 10_000),
      })
      .returning();
    const status = async () => (await db().query.trades.findFirst({ where: eq(schema.trades.id, trade!.id) }))!;

    await pollActiveTrades();
    expect((await status()).status).toBe("pending");

    await db().update(schema.trades).set({ updatedAt: new Date(Date.now() - 3 * 60_000) }).where(eq(schema.trades.id, trade!.id));
    await pollActiveTrades();
    expect((await status()).status).toBe("failed");
    expect((await status()).error).toBe("This trade couldn't be submitted.");
  });
});

describe("onboarding", () => {
  it("counts one-tap as on before the Flash approval, which a trade can send later", async () => {
    const { client } = await loginFunded("noapproval");
    expect((await client.me()).onboarding).toBe("enable_one_tap");
    await client.grantSigner({});
    const me = await client.me();
    expect(me.signer.active).toBe(true);
    expect(me.signer.flashApproved).toBe(false);
    expect(me.onboarding).toBe("done");
  });

  it("walks profile, deposit, one-tap, then done", async () => {
    const { token } = await new ApiClient({ baseUrl }).devLogin("newbie");
    const client = new ApiClient({ baseUrl, getToken: () => token });
    let me = await client.syncMe();
    expect(me.onboarding).toBe("profile");
    expect(me.wallets.map((w) => w.chainType).sort()).toEqual(["evm", "solana"]);

    me = await client.updateMe({ username: "newbie" });
    expect(me.onboarding).toBe("deposit");

    await client.paperDeposit();
    me = await client.me();
    expect(me.onboarding).toBe("enable_one_tap");
    expect(me.paperBalanceUsd).toBe("1000");

    await enableOneTap(client);
    me = await client.me();
    expect(me.onboarding).toBe("done");
    expect(me.signer.active).toBe(true);
    expect(me.signer.flashApproved).toBe(true);
  });

  it("rejects a taken username, regardless of case", async () => {
    await login("satoshi");
    const { token } = await new ApiClient({ baseUrl }).devLogin("other");
    const client = new ApiClient({ baseUrl, getToken: () => token });
    await client.syncMe();
    await expectApiError(client.updateMe({ username: "SATOSHI" }), "username_taken");
  });

  it("requires auth on private routes", async () => {
    await expectApiError(new ApiClient({ baseUrl }).me(), "unauthorized");
    await expectApiError(new ApiClient({ baseUrl, getToken: () => "garbage" }).portfolio(), "unauthorized");
  });
});

describe("buying", () => {
  it("won't quote past the balance", async () => {
    const { client } = await login("broke");
    await expectApiError(client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" }), "insufficient_balance");
  });

  it("has no minimum of its own, only what USDC can represent", async () => {
    const { client } = await loginFunded("tiny");
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "0.50" });
    expect(quote.amountInUsd).toBe("0.5");
    const trimmed = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "1.23456789" });
    expect(trimmed.amountInUsd).toBe("1.234567");
    await expectApiError(client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "0.0000001" }), "amount_too_small");
  });

  it("sells any percent of a position", async () => {
    const { client } = await loginFunded("anypercent");
    await buy(client, TOKEN_A, "100");
    const { position } = await client.myPosition("arc", TOKEN_A);
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "sell", sellPct: 12.5 });
    expect(Number(quote.qtyIn)).toBeCloseTo(Number(position!.qty) * 0.125, 6);
    await expect(client.quote({ chain: "arc", address: TOKEN_A, side: "sell", sellPct: 0 })).rejects.toBeInstanceOf(ApiError);
    await expect(client.quote({ chain: "arc", address: TOKEN_A, side: "sell", sellPct: 101 })).rejects.toBeInstanceOf(ApiError);
  });

  it("needs a visible confirm without one-tap, and fills after it", async () => {
    const { client } = await loginFunded("alice");
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "100" });
    expect(quote.oneTap).toBe(false);
    await expectApiError(client.executeTrade({ quoteId: quote.id, idempotencyKey: "alice-key-1" }), "needs_confirm");

    const again = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "100" });
    const trade = await client.executeTrade({ quoteId: again.id, idempotencyKey: "alice-key-2", confirmed: true });
    expect(trade.status).toBe("pending");
    expect(trade.isPaper).toBe(true);

    await settle();
    const filled = await client.trade(trade.id);
    expect(filled.status).toBe("filled");
    expect(Number(filled.qty)).toBeGreaterThan(0);

    const portfolio = await client.portfolio();
    expect(portfolio.open).toHaveLength(1);
    expect(portfolio.open[0]!.token.symbol).toBe("AAA");
    expect(portfolio.open[0]!.costBasisUsd).toBe("100");
    expect(portfolio.cash.usdc).toBe("900");
  });

  it("executes on one tap with a live grant", async () => {
    const { client } = await loginFunded("bob");
    await enableOneTap(client);
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "50" });
    expect(quote.oneTap).toBe(true);
    const trade = await client.executeTrade({ quoteId: quote.id, idempotencyKey: "bob-key-1" });
    expect(trade.status).toBe("pending");
  });

  it("falls back to a visible confirm above the per-trade cap", async () => {
    const { client } = await loginFunded("capped");
    await enableOneTap(client, { perTradeCapUsd: "40", dailyCapUsd: "1000" });
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "50" });
    expect(quote.oneTap).toBe(false);
    expect(quote.confirmReasons[0]!.message).toMatch(/per-trade/);
  });

  it("falls back to a visible confirm past the daily cap", async () => {
    const { client } = await loginFunded("daily");
    await enableOneTap(client, { perTradeCapUsd: "100", dailyCapUsd: "120" });
    await buy(client, TOKEN_A, "100");
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "30" });
    expect(quote.oneTap).toBe(false);
    expect(quote.confirmReasons[0]!.message).toMatch(/daily/);
  });

  it("stops one-tap after revoking and after expiry", async () => {
    const { client } = await loginFunded("revoker");
    await enableOneTap(client);
    await client.revokeSigner();
    let q = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" });
    expect(q.oneTap).toBe(false);

    await client.grantSigner({});
    q = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" });
    expect(q.oneTap).toBe(true);

    await db().update(schema.signerGrants).set({ expiresAt: new Date(Date.now() - 1000) });
    q = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" });
    expect(q.oneTap).toBe(false);
  });

  it("never places two orders for one tap", async () => {
    const { client } = await loginFunded("doubletap");
    await enableOneTap(client);
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" });
    const first = await client.executeTrade({ quoteId: quote.id, idempotencyKey: "same-key-1" });
    const second = await client.executeTrade({ quoteId: quote.id, idempotencyKey: "same-key-1" });
    expect(second.id).toBe(first.id);
    await expectApiError(client.executeTrade({ quoteId: quote.id, idempotencyKey: "other-key-1" }), "quote_used");
    await settle();
    expect((await client.portfolio()).cash.usdc).toBe("990");
  });

  it("won't let one user spend another's quote", async () => {
    const a = await loginFunded("quoteowner");
    const b = await loginFunded("quotethief");
    const quote = await a.client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" });
    await expectApiError(b.client.executeTrade({ quoteId: quote.id, idempotencyKey: "thief-key", confirmed: true }), "forbidden");
  });

  it("won't fill twice if the indexer sees a trade again", async () => {
    const { client } = await loginFunded("idem");
    const { trade } = await buy(client, TOKEN_A, "10");
    const { applyStatus } = await import("@frontrun/server");
    await applyStatus(trade.id, { status: "filled", qty: "999", usdIn: "10" });
    const portfolio = await client.portfolio();
    expect(Number(portfolio.open[0]!.qty)).toBeLessThan(10);
    expect(portfolio.cash.usdc).toBe("990");
  });

  it("re-quotes an expired price once, and proceeds if it still holds", async () => {
    const { client } = await loginFunded("expired");
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" });
    const key = KEYS.quote(quote.id);
    const record = JSON.parse((await redis().get(key))!);
    record.expiresAt = Date.now() - 1000;
    await redis().set(key, JSON.stringify(record), "EX", 60);
    const trade = await client.executeTrade({ quoteId: quote.id, idempotencyKey: "expired-key-1", confirmed: true });
    expect(trade.status).toBe("pending");
  });

  it("asks the user when the price moved past tolerance on re-quote", async () => {
    const { client } = await loginFunded("moved");
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" });
    const key = KEYS.quote(quote.id);
    const record = JSON.parse((await redis().get(key))!);
    record.expiresAt = Date.now() - 1000;
    record.winner.netOutputUsd = "11";
    await redis().set(key, JSON.stringify(record), "EX", 60);
    await expectApiError(client.executeTrade({ quoteId: quote.id, idempotencyKey: "moved-key-1", confirmed: true }), "price_moved");
  });

  it("returns 410 on a quote that's gone", async () => {
    const { client } = await loginFunded("gone");
    const err = await expectApiError(client.executeTrade({ quoteId: "00000000-missing", idempotencyKey: "gone-key-1" }), "quote_expired");
    expect(err.status).toBe(410);
  });

  it("buys Solana tokens into the Solana wallet", async () => {
    const { client } = await loginFunded("solbuyer");
    const { trade } = await buy(client, SOL_TOKEN, "20", "solana");
    expect(trade.status).toBe("filled");
    expect(trade.srcChain).toBe("arc");
    expect((await client.portfolio()).open[0]!.token.chain).toBe("solana");
  });
});

describe("guardrails", () => {
  it("blocks a buy over 2% of pool liquidity", async () => {
    const { client } = await loginFunded("whale");
    const quote = await client.quote({ chain: "arc", address: THIN, side: "buy", amountUsd: "100" });
    expect(quote.blocked.map((b) => b.code)).toContain("size_over_pool_share");
    await expectApiError(client.executeTrade({ quoteId: quote.id, idempotencyKey: "whale-key", confirmed: true }), "blocked");
  });

  it("blocks buying a flagged token, but always lets a holder out", async () => {
    const { client } = await loginFunded("trapped");
    const blockedQuote = await client.quote({ chain: "arc", address: FLAGGED, side: "buy", amountUsd: "10" });
    expect(blockedQuote.blocked[0]!.code).toBe("risk_flagged");

    // The holder bought before the flag appeared.
    await setPrice("arc", TOKEN_A, "2");
    await buy(client, TOKEN_A, "10");
    const key = tokenKey("arc", TOKEN_A);
    await redis().set(
      KEYS.tokenInfo(key),
      JSON.stringify({ gecko: null, flash: { riskFlagged: true, decimals: 18, holders: 1, imageUrl: null, tradable: true } }),
      "EX",
      60,
    );
    const sellQuote = await client.quote({ chain: "arc", address: TOKEN_A, side: "sell", sellPct: 100 });
    expect(sellQuote.blocked).toEqual([]);
    expect(sellQuote.confirmReasons.map((c) => c.code)).toContain("risk_flagged");
    const trade = await client.executeTrade({ quoteId: sellQuote.id, idempotencyKey: "trapped-exit", confirmed: true });
    expect(trade.status).toBe("pending");
  });
});

describe("PnL", () => {
  it("tracks realized, unrealized, closes and win rate", async () => {
    const { client } = await loginFunded("trader");
    await buy(client, TOKEN_A, "100");
    let p = await client.portfolio();
    const bought = Number(p.open[0]!.qty);
    expect(p.totals.realizedUsd).toBe("0");

    await setPrice("arc", TOKEN_A, "4");
    p = await client.portfolio();
    expect(Number(p.totals.unrealizedUsd)).toBeCloseTo(bought * 4 - 100, 6);
    expect(Number(p.open[0]!.returnPct)).toBeCloseTo(((bought * 4 - 100) / 100) * 100, 4);

    await sell(client, TOKEN_A, 50);
    p = await client.portfolio();
    expect(Number(p.open[0]!.qty)).toBeCloseTo(bought / 2, 6);
    expect(Number(p.open[0]!.costBasisUsd)).toBeCloseTo(50, 6);
    expect(Number(p.totals.realizedUsd)).toBeGreaterThan(0);

    await sell(client, TOKEN_A, 100);
    p = await client.portfolio();
    expect(p.open).toHaveLength(0);
    expect(p.closed).toHaveLength(1);
    expect(p.winRate).toBe(100);
    expect(Number(p.totals.allTimeUsd)).toBeCloseTo(Number(p.totals.realizedUsd), 8);

    // USDC came back, so cash reflects the win.
    expect(Number(p.cash.usdc)).toBeGreaterThan(1000);
  });

  it("opens a fresh position after a full close", async () => {
    const { client } = await loginFunded("reopen");
    await buy(client, TOKEN_A, "10");
    await sell(client, TOKEN_A, 100);
    await buy(client, TOKEN_A, "10");
    const p = await client.portfolio();
    expect(p.open).toHaveLength(1);
    expect(p.closed).toHaveLength(1);
  });

  it("won't sell what isn't held", async () => {
    const { client } = await loginFunded("nothing");
    await expectApiError(client.quote({ chain: "arc", address: TOKEN_A, side: "sell", sellPct: 100 }), "no_position");
  });

  it("logs failed trades without touching the position", async () => {
    const { client } = await loginFunded("failer");
    const { applyStatus } = await import("@frontrun/server");
    const quote = await client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "10" });
    const trade = await client.executeTrade({ quoteId: quote.id, idempotencyKey: "failer-key-1", confirmed: true });
    await applyStatus(trade.id, { status: "failed", error: "nope" });
    const p = await client.portfolio();
    expect(p.open).toHaveLength(0);
    expect(p.cash.usdc).toBe("1000");
    expect((await client.trade(trade.id)).error).toBe("nope");
  });

  it("writes an audit trail", async () => {
    const { client } = await loginFunded("audited");
    await enableOneTap(client);
    await buy(client, TOKEN_A, "10");
    const actions = (await db().select({ action: schema.auditLog.action }).from(schema.auditLog)).map((a) => a.action);
    expect(actions).toContain("signer_granted");
    expect(actions).toContain("trade_created");
  });
});

describe("theses", () => {
  it("verifies a holder and pins post price and position", async () => {
    const { client } = await loginFunded("holder");
    await buy(client, TOKEN_A, "200");
    const thesis = await client.createThesis({ chain: "arc", address: TOKEN_A, body: "Volume is real here." });
    expect(thesis.verified).toBe(true);
    expect(thesis.priceAtPost).toBe("2");
    expect(Number(thesis.positionUsdAtPost)).toBeGreaterThan(150);
    expect(Number(thesis.authorAvgEntry)).toBeGreaterThan(0);
    expect(thesis.outcome).toBe("pending");
  });

  it("shows a non-holder's thesis in the feed, without the verified badge", async () => {
    const { client } = await login("tourist");
    const thesis = await client.createThesis({ chain: "arc", address: TOKEN_A, body: "Looks fun." });
    expect(thesis.verified).toBe(false);
    const anon = new ApiClient({ baseUrl });
    // Every published thesis appears in the feed now; being a non-holder only costs the verified badge.
    const feed = await anon.theses({ tab: "recent" });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.verified).toBe(false);
    expect((await anon.theses({ username: "tourist" })).items).toHaveLength(1);
  });

  it("filters by verified position size", async () => {
    const small = await loginFunded("smallfish");
    const big = await loginFunded("bigfish");
    await buy(small.client, TOKEN_A, "60");
    await buy(big.client, TOKEN_A, "600");
    await small.client.createThesis({ chain: "arc", address: TOKEN_A, body: "small" });
    await big.client.createThesis({ chain: "arc", address: TOKEN_A, body: "big" });
    const anon = new ApiClient({ baseUrl });
    const params = { chain: "arc" as const, address: TOKEN_A };
    expect((await anon.theses({ ...params, minPosition: 50 })).items).toHaveLength(2);
    expect((await anon.theses({ ...params, minPosition: 500 })).items.map((t) => t.body)).toEqual(["big"]);
    expect((await anon.theses({ ...params, minPosition: 1000 })).items).toHaveLength(0);
  });

  it("starts unanchored, and paper theses never reach the chain", async () => {
    const { client } = await loginFunded("anchorless");
    await buy(client, TOKEN_A, "100");
    const thesis = await client.createThesis({ chain: "arc", address: TOKEN_A, body: "No anchor in paper mode." });
    expect(thesis.anchor).toBeNull();
    const { anchorPendingTheses } = await import("@frontrun/server");
    expect(await anchorPendingTheses()).toBe(0);
    const proof = await new ApiClient({ baseUrl }).thesisProof(thesis.id);
    expect(proof).toMatchObject({ chainId: 5042, payload: null, hash: null, txHash: null });
  });

  it("keeps showing the last price when market data is limited, but never trades or posts on it", async () => {
    const token = "0x9999999999999999999999999999999999999999";
    const key = tokenKey("arc", token);
    await redis().set(KEYS.snapshotStale(key), JSON.stringify(snapshot("arc", token, "2", "500000", "OLD")), "EX", 600);
    await redis().set("dex:cooldown", "1", "EX", 30);
    const { client } = await loginFunded("stalecheck");

    const shown = await new ApiClient({ baseUrl }).token("arc", token);
    expect(shown.priceUsd).toBe("2");
    await expect(client.quote({ chain: "arc", address: token, side: "buy", amountUsd: "10" })).rejects.toMatchObject({ status: 503, code: "market_data_busy" });
    await expect(client.createThesis({ chain: "arc", address: token, body: "This should not lock an old price." })).rejects.toMatchObject({ status: 503, code: "market_data_busy" });
  });

  it("stops the price feed early, so people can still load a token", async () => {
    await redis().set(`dex:window:${Math.floor(Date.now() / 60_000)}`, String(DEX_BACKGROUND_PER_MINUTE));
    await expect(fetchTokens("arc", [TOKEN_A], "background")).rejects.toBeInstanceOf(DexBusyError);
    // Past the budget, this reaches the network, which the test harness blocks.
    await expect(fetchTokens("arc", [TOKEN_A])).rejects.toThrow(/blocked network call/);
  });

  it("rejects drainer lures and unknown links", async () => {
    const { client } = await login("spammer");
    await expectApiError(client.createThesis({ chain: "arc", address: TOKEN_A, body: "claim your airdrop now" }), "drainer_language");
    await expectApiError(client.createThesis({ chain: "arc", address: TOKEN_A, body: "go to https://evil.xyz" }), "blocked_link");
  });

  it("throttles new accounts", async () => {
    const { client } = await login("newacct");
    for (let i = 0; i < 5; i++) await client.createThesis({ chain: "arc", address: TOKEN_A, body: `take ${i}` });
    const err = await expectApiError(client.createThesis({ chain: "arc", address: TOKEN_A, body: "take 6" }), "new_account_throttled");
    expect(err.status).toBe(429);
  });

  it("has no edit, and deleting is author-only", async () => {
    const a = await login("author");
    const b = await login("notauthor");
    const thesis = await a.client.createThesis({ chain: "arc", address: TOKEN_A, body: "mine" });
    await expectApiError(b.client.deleteThesis(thesis.id), "forbidden");
    await a.client.deleteThesis(thesis.id);
    await expectApiError(new ApiClient({ baseUrl }).thesis(thesis.id), "not_found");
  });

  it("counts likes once and replies, and notifies the author", async () => {
    const a = await login("poster");
    const b = await login("fan");
    const thesis = await a.client.createThesis({ chain: "arc", address: TOKEN_A, body: "hello" });
    await b.client.likeThesis(thesis.id);
    await b.client.likeThesis(thesis.id);
    const reply = await b.client.reply(thesis.id, "agreed");
    let view = await b.client.thesis(thesis.id);
    expect(view.likeCount).toBe(1);
    expect(view.likedByMe).toBe(true);
    expect(view.replyCount).toBe(1);
    expect((await b.client.replies(thesis.id)).items[0]!.body).toBe("agreed");

    const inbox = await a.client.notifications();
    expect(inbox.unread).toBe(2);
    expect(inbox.items.map((n) => n.type).sort()).toEqual(["thesis_liked", "thesis_replied"]);
    await a.client.markNotificationsRead();
    expect((await a.client.notifications()).unread).toBe(0);

    await b.client.unlikeThesis(thesis.id);
    await b.client.deleteReply(thesis.id, reply.id);
    view = await b.client.thesis(thesis.id);
    expect(view.likeCount).toBe(0);
    expect(view.replyCount).toBe(0);
  });

  it("sorts most liked and pages through the feed", async () => {
    const a = await loginFunded("pager");
    const fan = await login("pagerfan");
    await buy(a.client, TOKEN_A, "100");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await a.client.createThesis({ chain: "arc", address: TOKEN_A, body: `t${i}` })).id);
    await fan.client.likeThesis(ids[1]!);
    const anon = new ApiClient({ baseUrl });
    expect((await anon.theses({ sort: "liked", limit: 2 })).items[0]!.id).toBe(ids[1]);

    const first = await anon.theses({ tab: "recent", limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await anon.theses({ tab: "recent", limit: 2, cursor: first.nextCursor! });
    const third = await anon.theses({ tab: "recent", limit: 2, cursor: second.nextCursor! });
    const all = [...first.items, ...second.items, ...third.items].map((t) => t.id);
    expect(new Set(all).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it("shows a following feed and alerts followers", async () => {
    const leader = await loginFunded("leader");
    const follower = await login("follower");
    await follower.client.follow("leader");
    await buy(leader.client, TOKEN_A, "100");
    await leader.client.createThesis({ chain: "arc", address: TOKEN_A, body: "follow this" });
    await vi.waitFor(async () => {
      const inbox = await follower.client.notifications();
      expect(inbox.items.map((n) => n.type)).toContain("thesis_posted");
    });
    expect((await follower.client.theses({ tab: "following" })).items).toHaveLength(1);
    expect((await new ApiClient({ baseUrl }).theses({ tab: "following" })).items).toHaveLength(0);
  });

  it("hides blocked users both ways and breaks the follow", async () => {
    const a = await loginFunded("blocker");
    const b = await loginFunded("blockee");
    await a.client.follow("blockee");
    await b.client.follow("blocker");
    await buy(b.client, TOKEN_A, "100");
    const thesis = await b.client.createThesis({ chain: "arc", address: TOKEN_A, body: "you can't see me" });
    await a.client.block("blockee");

    expect((await a.client.theses({ tab: "recent" })).items).toHaveLength(0);
    expect((await a.client.profile("blockee")).isBlocked).toBe(true);
    expect((await a.client.profile("blockee")).isFollowing).toBe(false);
    await expectApiError(b.client.follow("blocker"), "blocked");
    const owned = await a.client.createThesis({ chain: "arc", address: TOKEN_A, body: "mine" });
    await expectApiError(b.client.reply(owned.id, "hi"), "forbidden");
    expect((await a.client.blocks()).items[0]!.username).toBe("blockee");

    await a.client.unblock("blockee");
    expect((await a.client.theses({ tab: "recent" })).items.map((t) => t.id)).toContain(thesis.id);
  });

  it("auto-hides after 5 distinct reports", async () => {
    const author = await login("reported");
    const thesis = await author.client.createThesis({ chain: "arc", address: TOKEN_A, body: "sketchy" });
    for (let i = 0; i < 5; i++) {
      const r = await login(`reporter${i}`);
      await r.client.report({ thesisId: thesis.id, reason: "scam" });
      // A repeat report from the same account must not count twice.
      await r.client.report({ thesisId: thesis.id, reason: "scam" });
      if (i < 4) expect((await new ApiClient({ baseUrl }).thesis(thesis.id)).id).toBe(thesis.id);
    }
    await expectApiError(new ApiClient({ baseUrl }).thesis(thesis.id), "not_found");
  });

  it("copy-buy caps the size and shows the author's entry", async () => {
    const author = await loginFunded("caller");
    await buy(author.client, TOKEN_A, "100");
    const thesis = await author.client.createThesis({ chain: "arc", address: TOKEN_A, body: "copy me" });
    const copier = await loginFunded("copier");
    const quote = await copier.client.quote({ chain: "arc", address: TOKEN_A, side: "buy", amountUsd: "500", copyThesisId: thesis.id });
    expect(quote.amountInUsd).toBe("100");
    expect(quote.copy?.capUsd).toBe("100");
    expect(Number(quote.copy?.authorEntry)).toBeGreaterThan(0);
    await copier.client.executeTrade({ quoteId: quote.id, idempotencyKey: "copy-key-1", confirmed: true });
    await settle();
    await vi.waitFor(async () => {
      expect((await author.client.notifications()).items.map((n) => n.type)).toContain("copy_buy");
    });
  });
});

describe("thesis outcomes and leaderboard", () => {
  async function postAndAge(client: ApiClient, n: number) {
    for (let i = 0; i < n; i++) await client.createThesis({ chain: "arc", address: TOKEN_A, body: `call ${i}` });
    await db()
      .update(schema.theses)
      .set({ ts: new Date(Date.now() - (THESIS_RESOLVE_HOURS + 1) * 3_600_000) })
      .where(eq(schema.theses.outcome, "pending"));
  }

  it("resolves at the deadline and ranks by accuracy, needing 5 resolved", async () => {
    const good = await loginFunded("goodcaller");
    const few = await loginFunded("fewcalls");
    await buy(good.client, TOKEN_A, "100");
    await buy(few.client, TOKEN_A, "100");
    await postAndAge(good.client, 5);
    await postAndAge(few.client, 2);

    await setPrice("arc", TOKEN_A, "3");
    expect(await resolveDueTheses()).toBe(7);

    const list = await good.client.theses({ username: "goodcaller" });
    expect(list.items.every((t) => t.outcome === "right")).toBe(true);
    expect(list.items[0]!.returnPct).toBe(50);

    const board = await new ApiClient({ baseUrl }).leaderboard();
    expect(board.minResolved).toBe(5);
    expect(board.items.map((r) => r.user.username)).toEqual(["goodcaller"]);
    expect(board.items[0]!.accuracy).toBe(100);

    const profile = await new ApiClient({ baseUrl }).profile("goodcaller");
    expect(profile.stats.accuracy).toBe(100);
    expect(profile.stats.right).toBe(5);

    // The judged return stays fixed even when the price moves later.
    await setPrice("arc", TOKEN_A, "1");
    expect((await good.client.theses({ username: "goodcaller" })).items[0]!.returnPct).toBe(50);
  });

  it("marks a falling token wrong", async () => {
    const { client } = await loginFunded("wrongcaller");
    await buy(client, TOKEN_A, "100");
    await postAndAge(client, 1);
    await setPrice("arc", TOKEN_A, "1");
    await resolveDueTheses();
    expect((await client.theses({ username: "wrongcaller" })).items[0]!.outcome).toBe("wrong");
  });
});

describe("profiles", () => {
  it("reports followers, PnL and follow state", async () => {
    const a = await loginFunded("profiled");
    const b = await login("viewer");
    await b.client.follow("profiled");
    await b.client.follow("profiled");
    expect((await b.client.profile("profiled")).followers).toBe(1);
    expect((await b.client.profile("profiled")).isFollowing).toBe(true);
    await buy(a.client, TOKEN_A, "10");
    await setPrice("arc", TOKEN_A, "4");
    expect(Number((await b.client.profile("profiled")).stats.allTimePnlUsd)).toBeGreaterThan(0);
    await b.client.unfollow("profiled");
    expect((await b.client.profile("profiled")).followers).toBe(0);
    await expectApiError(a.client.follow("profiled"), "self_follow");
  });

  it("404s an unknown user", async () => {
    await expectApiError(new ApiClient({ baseUrl }).profile("nobody_here"), "not_found");
  });
});

describe("paper withdraw", () => {
  it("can't overdraw", async () => {
    const { client } = await loginFunded("withdrawer");
    await client.paperWithdraw({ to: TOKEN_A, amountUsd: "400" });
    expect((await client.balance()).usdc).toBe("600");
    await expectApiError(client.paperWithdraw({ to: TOKEN_A, amountUsd: "601" }), "insufficient_balance");
  });
});

describe("platform", () => {
  it("serves config with no secrets", async () => {
    const config = await new ApiClient({ baseUrl }).config();
    expect(config.tradingMode).toBe("paper");
    expect(config.providers.flash).toBe(false);
    expect(config.providers.uniswap_direct).toBe(true);
    const text = JSON.stringify(config);
    expect(text).not.toContain("test-secret");
    expect(text).not.toContain("test-admin");
  });

  it("geo-blocks sanctioned regions", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/config", headers: { "cf-ipcountry": "IR" } });
    expect(res.statusCode).toBe(451);
    expect((await app.inject({ method: "GET", url: "/v1/config", headers: { "cf-ipcountry": "IN" } })).statusCode).toBe(200);
  });

  it("rate limits per route", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await app.inject({ method: "POST", url: "/v1/auth/dev", payload: { handle: "limited" }, remoteAddress: "10.0.0.9" });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("validates input", async () => {
    const { client } = await login("validator");
    await expectApiError(client.quote({ chain: "arc", address: "nope-not-an-address-xxxx", side: "buy", amountUsd: "1" }), "invalid_address");
    const res = await app.inject({ method: "POST", url: "/v1/auth/dev", payload: { handle: "x" }, remoteAddress: "10.0.0.10" });
    expect(res.statusCode).toBe(400);
  });

  it("guards metrics behind the admin token", async () => {
    expect((await app.inject({ method: "GET", url: "/internal/metrics" })).statusCode).toBe(404);
    const res = await app.inject({ method: "GET", url: "/internal/metrics", headers: { "x-admin-token": "test-admin" } });
    expect(res.statusCode).toBe(200);
  });

  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ ok: true, db: true, redis: true });
  });
});

describe("websocket", () => {
  it("delivers ticks to subscribers and private events only to their owner", async () => {
    const owner = await login("wsowner");
    const stranger = await login("wsstranger");
    const ownerMe = await owner.client.me();
    const a = socketClient(baseUrl, { auth: { token: owner.token }, transports: ["websocket"] });
    const b = socketClient(baseUrl, { auth: { token: stranger.token }, transports: ["websocket"] });
    try {
      await Promise.all([a, b].map((s) => new Promise((r) => s.on("connect", () => r(null)))));
      a.emit("sub", { chain: "arc", address: TOKEN_A });
      // The server replies right away with the last known price.
      const price = await new Promise<{ priceUsd: string }>((r) => a.once("price", r));
      expect(price.priceUsd).toBe("2");
      expect((await redis().zrange(KEYS.activeTokens, 0, -1))).toContain(tokenKey("arc", TOKEN_A));

      const tickPromise = new Promise<{ priceUsd: string }>((r) => a.once("tick", r));
      let strangerGotTick = false;
      b.on("tick", () => (strangerGotTick = true));
      await publish(CHANNELS.ticks, [{ chain: "arc", address: TOKEN_A, priceUsd: "2.5", priceChange24h: 0, liquidityUsd: null, marketCapUsd: null, volume24hUsd: 0, at: Date.now() }]);
      expect((await tickPromise).priceUsd).toBe("2.5");

      const privatePromise = new Promise<{ usdc: string }>((r) => a.once("balance", r));
      let strangerGotPrivate = false;
      b.on("balance", () => (strangerGotPrivate = true));
      await publish(CHANNELS.user(ownerMe.id), { type: "balance", usdc: "42" });
      expect((await privatePromise).usdc).toBe("42");
      await new Promise((r) => setTimeout(r, 100));
      expect(strangerGotTick).toBe(false);
      expect(strangerGotPrivate).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("analytics", () => {
  const publicStats = () => new ApiClient({ baseUrl }).stats();

  it("starts empty, and is open to anyone", async () => {
    const stats = await publicStats();
    expect(stats.allTime).toEqual({ volumeUsd: "0", revenueUsd: "0", trades: 0, traders: 0 });
    expect(stats.firstTradeAt).toBeNull();
    expect(stats.recent).toEqual([]);
    expect(stats.hourly).toHaveLength(24);
    expect(stats.daily).toHaveLength(30);
  });

  it("counts a buy by what went in and a sale by what came out, and says nothing about who made them", async () => {
    const { client } = await loginFunded("statsfan");
    await setPrice("arc", TOKEN_A, "1", "1000000", "AAA");
    const { trade: bought } = await buy(client, TOKEN_A, "100");
    const { trade: sold } = await sell(client, TOKEN_A, 100);
    const stats = await publicStats();
    const expected = Number(bought.usdIn) + Number(sold.usdOut);
    expect(Number(stats.allTime.volumeUsd)).toBeCloseTo(expected);
    expect(Number(stats.allTime.revenueUsd)).toBeCloseTo(Number(bought.feeUsd) + Number(sold.feeUsd));
    expect(Number(stats.allTime.revenueUsd)).toBeGreaterThan(0);
    expect(stats.allTime).toMatchObject({ trades: 2, traders: 1 });
    expect(stats.last24h).toEqual(stats.allTime);
    expect(stats.hourly.at(-1)!.trades).toBe(2);
    expect(stats.daily.at(-1)!.trades).toBe(2);
    expect(stats.byChain).toMatchObject([{ chain: "arc", trades: 2 }]);
    expect(stats.recent.map((r) => r.side)).toEqual(["sell", "buy"]);
    expect(stats.recent[0]!.token.address).toBe(TOKEN_A);
    const me = await client.me();
    const text = JSON.stringify(stats);
    expect(text).not.toContain("statsfan");
    expect(text).not.toContain(me.id);
  });

  it("leaves out a trade that didn't complete", async () => {
    const { client } = await loginFunded("statsfail");
    await setPrice("arc", TOKEN_A, "1", "1000000", "AAA");
    const { trade } = await buy(client, TOKEN_A, "100");
    await db().update(schema.trades).set({ status: "failed" }).where(eq(schema.trades.id, trade.id));
    await statsChanged();
    expect((await publicStats()).allTime.trades).toBe(0);
  });

  it("serves new numbers and tells open dashboards as soon as a trade fills", async () => {
    const { client } = await loginFunded("statslive");
    await setPrice("arc", TOKEN_A, "1", "1000000", "AAA");
    expect((await publicStats()).allTime.trades).toBe(0);
    const viewer = socketClient(baseUrl, { transports: ["websocket"] });
    try {
      await new Promise((r) => viewer.on("connect", () => r(null)));
      const told = new Promise((r) => viewer.once("stats", () => r(true)));
      await buy(client, TOKEN_A, "50");
      expect(await told).toBe(true);
      expect((await publicStats()).allTime.trades).toBe(1);
    } finally {
      viewer.close();
    }
  });
});
