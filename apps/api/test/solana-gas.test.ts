import { createPublicKey, verify } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A throwaway vault key and a stand-in Solana network. Nothing here reaches a real chain.
const vault = vi.hoisted(() => {
  // Runs ahead of the imports, so it has to load this itself.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const bytes = [...Buffer.from(jwk.d!, "base64url"), ...Buffer.from(jwk.x!, "base64url")];
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
    SOLANA_RPC_URL: "https://solana.test/rpc",
    GAS_TOPUP_SOLANA_PRIVATE_KEY: JSON.stringify(bytes),
  });
  return { publicDer: publicKey.export({ format: "der", type: "spki" }) };
});

import { closeDb, closeRedis, db, ensureSolGasForSetup, flashProvider, parseSolanaSecretKey, runMigrations, schema, solTopUpAmount, solanaKeyAddress } from "@frontrun/server";
import { eq, sql } from "drizzle-orm";

const WALLET = "AX262Th9tP2jjm6sUC74GQMvTRCkZe2iaKHwzAGMgAvo";
const TRADE = "11111111-1111-4111-8111-111111111111";

let balances: Record<string, number> = {};
let sent: string[] = [];
let quotes: Array<{ flashIntegratorFeeBps?: string }> = [];
let userId: string;
const realFetch = globalThis.fetch;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://solana.test/rpc") {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const reply = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });
      if (method === "getBalance") return reply({ value: balances[params[0] as string] ?? 0 });
      if (method === "getLatestBlockhash") return reply({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } });
      if (method === "sendTransaction") {
        sent.push(params[0] as string);
        return reply("sig123");
      }
      if (method === "getSignatureStatuses") return reply({ value: [{ err: null, confirmationStatus: "confirmed" }] });
      throw new Error(`unexpected RPC ${method}`);
    }
    if (url.endsWith("flash.definitive.fi/v1/quote")) {
      const body = JSON.parse(String(init?.body)) as { flashIntegratorFeeBps?: string };
      quotes.push(body);
      return json({ quoteId: "q2", from: { amount: "100", notional: "46" }, to: { amount: "45", notional: "45" }, fees: { estimatedFeeNotional: "0.5" }, svm: { orderMessage: "DFS|order", nonce: "1", deadline: "2" }, setupTxs: [] });
    }
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return realFetch(input, init);
    throw new Error(`blocked network call in test: ${url}`);
  });
  await runMigrations();
});

beforeEach(async () => {
  await db().execute(sql`truncate users, tokens, provider_events, audit_log restart identity cascade`);
  sent = [];
  quotes = [];
  balances = { [await solanaKeyAddress(process.env.GAS_TOPUP_SOLANA_PRIVATE_KEY!)]: 1_000_000_000 };
  const [user] = await db().insert(schema.users).values({ privyId: "did:sol", username: "soluser" }).returning();
  userId = user!.id;
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
  vi.unstubAllGlobals();
});

const topUp = () => ensureSolGasForSetup({ address: WALLET, userId, tradeId: TRADE });

describe("the Solana gas vault", () => {
  it("tops an empty wallet up, signed by the vault, and records it", async () => {
    expect(await topUp()).toBe(true);
    expect(sent).toHaveLength(1);

    // A real signed transaction: the signature has to check out against the vault's key.
    const wire = Buffer.from(sent[0]!, "base64");
    expect(wire[0]).toBe(1);
    const signature = wire.subarray(1, 65);
    const message = wire.subarray(65);
    expect(verify(null, message, createPublicKey({ key: vault.publicDer, format: "der", type: "spki" }), signature)).toBe(true);
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(3_500_000n);
    expect(message.includes(amount)).toBe(true);

    const rows = await db().select().from(schema.gasTopups).where(eq(schema.gasTopups.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chain: "solana", amountWei: "3500000", txHash: "sig123", tradeId: TRADE });
  });

  it("only sends what's missing, and nothing when there's enough", async () => {
    expect(solTopUpAmount(0)).toBe(3_500_000);
    expect(solTopUpAmount(2_000_000)).toBe(1_500_000);
    expect(solTopUpAmount(3_000_000)).toBe(0);
    balances[WALLET] = 3_200_000;
    expect(await topUp()).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("stops at the daily limit, so nobody can keep draining the vault", async () => {
    for (let i = 0; i < 3; i++) await topUp();
    await expect(topUp()).rejects.toMatchObject({ code: "gas_limit" });
    expect(sent).toHaveLength(3);
  });

  it("sends nothing when the vault can't afford it", async () => {
    balances = {};
    await expect(topUp()).rejects.toThrow(/out of SOL/);
    expect(sent).toHaveLength(0);
  });

  it("reads keys in both of Solana's formats", () => {
    const bytes = parseSolanaSecretKey(process.env.GAS_TOPUP_SOLANA_PRIVATE_KEY!);
    expect(bytes).toHaveLength(64);
    expect(() => parseSolanaSecretKey("[1,2,3]")).toThrow(/64 bytes/);
  });
});

describe("recovering a top-up", () => {
  const request = { side: "sell", chain: "solana", address: "DKYcjobF7HPtL9RyQBRdeRQ2iWvizpfbgWwPWNXdpump", decimals: 6, qtyIn: "100", evmAddress: "0x0000000000000000000000000000000000000001", solanaAddress: WALLET, priceUsd: "0.46", notionalUsd: "46" } as const;
  const raw = { quoteId: "q1", from: { amount: "100", notional: "46" }, to: { amount: "46", notional: "46" }, fees: { estimatedFeeNotional: "0.23" }, svm: { orderMessage: "DFS|old", nonce: "1", deadline: "2" }, setupTxs: ["setup"] };
  const context = () => ({ tradeId: TRADE, userId, request, quote: { provider: "flash", netOutputUsd: "46", expectedOut: "46", feeUsd: "0.23", gasUsd: "0", etaSeconds: 40, priceImpact: 0.1, recommendedSlippage: null, crossChain: true, needsSetup: true, sponsoredSetup: false, latencyMs: 1, raw }, completed: [{ id: "setup-0", txHash: "0xsetup" }] });

  it("adds the cost to that sell's fee once, then signs the fresh order", async () => {
    await db().insert(schema.gasTopups).values({ userId, chain: "solana", amountWei: "3500000", costUsd: "0.46", txHash: "sig", tradeId: TRADE });
    const ctx = context();
    const next = await flashProvider.advance(ctx as never);
    // $0.46 on a $46 sale is 100 bps, on top of the 50 the app already takes.
    expect(quotes[0]?.flashIntegratorFeeBps).toBe("150");
    expect("steps" in next && next.steps[0]).toMatchObject({ id: "order", kind: "svm_message", message: "DFS|order" });
    const [row] = await db().select().from(schema.gasTopups).where(eq(schema.gasTopups.tradeId, TRADE));
    expect(row?.settledAt).not.toBeNull();

    await flashProvider.advance(ctx as never);
    expect(quotes).toHaveLength(1);
  });

  it("leaves the quote alone when there was no top-up", async () => {
    const next = await flashProvider.advance(context() as never);
    expect(quotes).toHaveLength(0);
    expect("steps" in next && next.steps[0]).toMatchObject({ id: "order", message: "DFS|old" });
  });
});
