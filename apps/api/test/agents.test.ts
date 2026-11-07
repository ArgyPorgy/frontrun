import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/frontrun_test",
    REDIS_URL: "redis://localhost:6379/15",
    AUTH_MODE: "dev",
    TRADING_MODE: "paper",
    DEV_JWT_SECRET: "test-secret-test-secret-test-secret",
    APP_ORIGIN: "http://localhost:3000",
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
    OPENROUTER_API_KEY: "test-gateway-key",
    AGENT_DAILY_BUDGET_USD: "10",
  });
});

import { ApiClient, ApiError, tokenKey, type AgentDetailView, type ChainKey, type TokenSnapshot } from "@frontrun/core";
import { KEYS, closeDb, closeRedis, db, isOpenSourceModel, pollActiveTrades, redis, runAgents, runMigrations, schema, toModelViews } from "@frontrun/server";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { attachWebsocket } from "../src/ws";

const TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc";
const OTHER = "0xdddddddddddddddddddddddddddddddddddddddd";
const MODEL = "acme/fast-model";
const realFetch = globalThis.fetch;

type FakeReply = { content?: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }>; fail?: boolean; cost?: number };
const script: FakeReply[] = [];
const requests: Array<{ model: string; messages: Array<{ role: string; content: string | null }>; toolNames: string[] }> = [];

function say(content: string, cost = 0.001): FakeReply {
  return { content, cost };
}
function call(name: string, args: Record<string, unknown> = {}): FakeReply {
  return { tool_calls: [{ name, args }], cost: 0.001 };
}

let modelsDown = false;
let modelsEmpty = false;

function gateway(url: string, init?: RequestInit): Response {
  if (url.endsWith("/models")) {
    if (modelsDown) throw new Error("connect timeout");
    if (modelsEmpty) return Response.json({ data: [] });
    return Response.json({
      data: [
        { id: MODEL, name: "Acme: Fast Model", supported_parameters: ["tools"], pricing: { prompt: "0.0000001", completion: "0.0000005" } },
        { id: "deepseek/open-model", name: "DeepSeek: Open", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
        { id: "acme/no-tools", name: "Acme: No Tools", supported_parameters: ["temperature"], pricing: { prompt: "0.000001", completion: "0.000001" } },
        { id: "openrouter/auto", name: "Auto", supported_parameters: ["tools"], pricing: { prompt: "-1", completion: "-1" } },
      ],
    });
  }
  const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string | null }>; tools: Array<{ function: { name: string } }> };
  requests.push({ model: body.model, messages: body.messages, toolNames: body.tools.map((t) => t.function.name) });
  const next = script.shift() ?? say("Nothing worth doing this round.");
  if (next.fail) return new Response("model unavailable", { status: 400 });
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: next.content ?? null,
          tool_calls: next.tool_calls?.map((c, i) => ({ id: `call_${requests.length}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        },
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 100, cost: next.cost ?? 0 },
  });
}

function snapshot(chain: ChainKey, address: string, price: string, liquidity: string, symbol: string): TokenSnapshot {
  const w = { m5: 1, h1: 2, h6: 3, h24: 1000 };
  const t = { buys: 10, sells: 10 };
  return { chain, address, symbol, name: symbol, imageUrl: null, priceUsd: price, marketCapUsd: "1000000", fdvUsd: "1000000", liquidityUsd: liquidity, volumeUsd: w, txns: { m5: t, h1: t, h6: t, h24: t }, priceChangePct: { m5: 0, h1: 0, h6: 0, h24: 5 }, pairAddress: "0xpool", dexId: "test", pairCreatedAt: 0, updatedAt: Date.now() };
}

async function setPrice(address: string, price: string, liquidity = "1000000", symbol = "TKN") {
  const key = tokenKey("arc", address);
  await redis().set(KEYS.snapshot(key), JSON.stringify(snapshot("arc", address, price, liquidity, symbol)), "EX", 3600);
  await redis().set(KEYS.price(key), price, "EX", 3600);
  await redis().set(KEYS.tokenInfo(key), JSON.stringify({ gecko: { decimals: 18, holderCount: 100, top10Pct: 20, isHoneypot: false, imageUrl: null }, flash: { riskFlagged: false, decimals: 18, holders: 100, imageUrl: null, tradable: true } }), "EX", 3600);
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
  await client.paperDeposit();
  return client;
}

const settings = { model: MODEL, strategy: "Buy strength, cut losers quickly.", perTradeUsd: "20", dailyLimitUsd: "50", thinkEveryMinutes: 60 };

async function newAgent(client: ApiClient, name = "testbot", fund = "100"): Promise<AgentDetailView> {
  const agent = await client.createAgent({ name, ...settings });
  if (fund !== "0") return client.fundAgentPaper(agent.id, fund);
  return agent;
}

/** Runs the worker's pass while filling paper trades, the way the trade indexer would. */
async function runWorker() {
  const filler = setInterval(() => {
    void redis()
      .eval("for _,k in ipairs(redis.call('keys','paper:fill:*')) do redis.call('set',k,'0') end return 1", 0)
      .then(() => pollActiveTrades())
      .catch(() => {});
  }, 200);
  try {
    return await runAgents();
  } finally {
    clearInterval(filler);
  }
}

async function due(agent: AgentDetailView) {
  await db().update(schema.agents).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schema.agents.id, agent.id));
}

async function expectApiError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
}

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return realFetch(input, init);
    if (url.startsWith("https://openrouter.ai/")) return gateway(url, init);
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

beforeEach(async () => {
  await db().execute(sql`truncate users, tokens, provider_events, audit_log restart identity cascade`);
  await redis().flushdb();
  script.length = 0;
  requests.length = 0;
  modelsDown = false;
  modelsEmpty = false;
  await setPrice(TOKEN, "2");
  await setPrice(OTHER, "10");
});

afterAll(async () => {
  await closeWs();
  await app.close();
  await closeRedis();
  await closeDb();
  vi.unstubAllGlobals();
});

describe("models", () => {
  it("offers only models that can call tools, and skips the auto-router", () => {
    const views = toModelViews([
      { id: "a/tools", supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "a/none", supported_parameters: [], pricing: { prompt: "0", completion: "0" } },
      { id: "openrouter/auto", supported_parameters: ["tools"], pricing: { prompt: "-1", completion: "-1" } },
    ]);
    expect(views.map((v) => v.id)).toEqual(["a/tools"]);
    expect(views[0]!.promptPrice).toBeCloseTo(1, 6);
    expect(views[0]!.completionPrice).toBeCloseTo(2, 6);
  });

  it("tells open-source models apart", () => {
    expect(isOpenSourceModel("meta-llama/llama-4")).toBe(true);
    expect(isOpenSourceModel("deepseek/deepseek-v4-flash")).toBe(true);
    expect(isOpenSourceModel("anthropic/claude-haiku-5.5")).toBe(false);
    expect(isOpenSourceModel("openai/gpt-5")).toBe(false);
  });

  it("lists them to anyone, with no account", async () => {
    const { items } = await new ApiClient({ baseUrl }).agentModels();
    expect(items.map((m) => m.id).sort()).toEqual(["acme/fast-model", "deepseek/open-model"]);
    expect(items.find((m) => m.id === "deepseek/open-model")).toMatchObject({ openSource: true, free: true });
  });
});

describe("when the gateway is down", () => {
  it("keeps offering the last good list", async () => {
    const anon = new ApiClient({ baseUrl });
    expect((await anon.agentModels()).items).toHaveLength(2);
    await redis().del("agents:models");
    modelsDown = true;
    expect((await anon.agentModels()).items).toHaveLength(2);
  });

  it("says so plainly if it has never had a list", async () => {
    modelsDown = true;
    await expectApiError(new ApiClient({ baseUrl }).agentModels(), "models_unavailable");
    const client = await login("argyporgy");
    await expectApiError(client.createAgent({ name: "nomodels", ...settings }), "models_unavailable");
  });

  it("doesn't save an empty list, which would leave nothing to pick for an hour", async () => {
    modelsEmpty = true;
    await expectApiError(new ApiClient({ baseUrl }).agentModels(), "models_unavailable");
    expect(await redis().exists("agents:models")).toBe(0);
    modelsEmpty = false;
    expect((await new ApiClient({ baseUrl }).agentModels()).items).toHaveLength(2);
  });
});

describe("creating an agent", () => {
  it("stays closed to accounts outside the beta", async () => {
    const client = await login("someone");
    const view = await client.agents();
    expect(view.available).toBe(false);
    expect(view.unavailableReason).toContain("opening soon");
    await expectApiError(client.createAgent({ name: "nope", ...settings }), "agents_unavailable");
  });

  it("gets its own account and wallets, and its owner follows it", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client, "testbot", "0");
    const me = await client.me();
    expect(agent.wallet.evm).not.toBe(me.wallets.find((w) => w.chainType === "evm")!.address);
    expect(agent.user.username).toBe("testbot");
    expect(agent.enabled).toBe(true);

    const profile = await new ApiClient({ baseUrl }).profile("testbot");
    expect(profile.agentModel).toBe("fast-model");
    expect(profile.agentOwner?.username).toBe("argyporgy");
    expect((await client.profile("testbot")).isFollowing).toBe(true);
  });

  it("refuses a model that can't call tools, or limits out of range", async () => {
    const client = await login("argyporgy");
    await expectApiError(client.createAgent({ name: "bad1", ...settings, model: "acme/no-tools" }), "agent_model");
    await expectApiError(client.createAgent({ name: "bad2", ...settings, perTradeUsd: "500", dailyLimitUsd: "500" }), "agent_trade_limit");
    await expectApiError(client.createAgent({ name: "bad3", ...settings, perTradeUsd: "20", dailyLimitUsd: "5" }), "agent_daily_limit");
    await expectApiError(client.createAgent({ name: "bad4", ...settings, thinkEveryMinutes: 1 }), "agent_interval");
  });

  it("won't take a name that's in use, and leaves nothing behind", async () => {
    const client = await login("argyporgy");
    await expectApiError(client.createAgent({ name: "argyporgy", ...settings }), "username_taken");
    expect((await client.agents()).items).toHaveLength(0);
  });

  it("caps how many one person can run", async () => {
    const client = await login("argyporgy");
    for (const name of ["one_bot", "two_bot", "three_bot"]) await newAgent(client, name, "0");
    await expectApiError(client.createAgent({ name: "four_bot", ...settings }), "agent_limit");
  });

  it("only lets its owner open it", async () => {
    const owner = await login("argyporgy");
    const agent = await newAgent(owner);
    const other = await login("sayan");
    await expectApiError(other.agent(agent.id), "not_found");
    await expectApiError(other.withdrawFromAgent(agent.id, "10"), "not_found");
    await expectApiError(other.sendAgentMessage(agent.id, "sell everything"), "not_found");
    await expectApiError(other.updateAgent(agent.id, { enabled: false }), "not_found");
  });
});

describe("a round of thinking", () => {
  it("can decide to do nothing, and logs why", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    script.push(call("get_portfolio"), say("Nothing looks good. Holding cash."));
    await due(agent);
    await runWorker();

    const { items } = await client.agentRuns(agent.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ trigger: "schedule", summary: "Nothing looks good. Holding cash.", error: null });
    expect(items[0]!.actions).toEqual([{ tool: "get_portfolio", summary: "Checked its portfolio", ok: true, acted: false }]);
    expect(items[0]!.costUsd).toBeCloseTo(0.002, 6);
    expect(requests[0]!.model).toBe(MODEL);
    expect(requests[0]!.messages[0]!.content).toContain("Buy strength, cut losers quickly.");
    const detail = await client.agent(agent.id);
    expect(detail.portfolio.open).toHaveLength(0);
    expect(new Date(detail.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("buys with its own wallet and posts a thesis on what it holds, which shows the live badge", async () => {
    const client = await login("argyporgy");
    const before = (await client.balance()).usdc;
    const agent = await newAgent(client);
    script.push(call("buy", { chain: "arc", address: TOKEN, amountUsd: 15 }), call("post_thesis", { chain: "arc", address: TOKEN, body: "Volume is rising with deep liquidity." }), say("Bought and explained why."));
    await due(agent);
    await runWorker();

    const detail = await client.agent(agent.id);
    expect(detail.portfolio.open).toHaveLength(1);
    expect(Number(detail.balanceUsd)).toBeCloseTo(85, 0);
    // The owner's own balance only moved by what they chose to send it.
    expect(Number((await client.balance()).usdc)).toBeCloseTo(Number(before) - 100, 2);

    const { items } = await new ApiClient({ baseUrl }).theses({ username: "testbot" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ verified: true, body: "Volume is rising with deep liquidity." });
    expect(items[0]!.author.agentModel).toBe("fast-model");
    expect(items[0]!.live).toMatchObject({ status: "holding", heldPct: 100 });

    const { items: alerts } = await client.notifications();
    expect(alerts.some((n) => n.type === "agent_action" && n.message.includes("testbot bought TKN"))).toBe(true);
  });

  it("can't post a thesis on something it doesn't hold", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    script.push(call("post_thesis", { chain: "arc", address: TOKEN, body: "I don't own this but it looks great." }), say("Couldn't post that."));
    await due(agent);
    await runWorker();
    expect((await new ApiClient({ baseUrl }).theses({ username: "testbot" })).items).toHaveLength(0);
    const { items } = await client.agentRuns(agent.id);
    expect(items[0]!.actions[0]).toMatchObject({ tool: "post_thesis", ok: false, acted: false });
    const toolReply = requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolReply?.content).toContain("only post a thesis on a token you hold");
  });

  it("is refused over its per-trade limit, whatever the model asks for", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    script.push(call("buy", { chain: "arc", address: TOKEN, amountUsd: 90 }), say("That was too big."));
    await due(agent);
    await runWorker();
    expect((await client.agent(agent.id)).portfolio.open).toHaveLength(0);
    const { items } = await client.agentRuns(agent.id);
    expect(items[0]!.actions[0]).toMatchObject({ tool: "buy", ok: false, acted: false });
    expect(items[0]!.actions[0]!.summary).toContain("per-trade limit");
  });

  it("is refused past its daily limit", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    script.push(
      call("buy", { chain: "arc", address: TOKEN, amountUsd: 20 }),
      call("buy", { chain: "arc", address: TOKEN, amountUsd: 20 }),
      call("buy", { chain: "arc", address: OTHER, amountUsd: 20 }),
      say("Reached the limit."),
    );
    await due(agent);
    await runWorker();
    const { items } = await client.agentRuns(agent.id);
    expect(items[0]!.actions.map((a) => a.ok)).toEqual([true, true, false]);
    expect(items[0]!.actions[2]!.summary).toContain("daily limit");
    expect(Number((await client.agent(agent.id)).spentTodayUsd)).toBeCloseTo(40, 4);
  });

  it("stops at a few trades in one round, even within its limits", async () => {
    const client = await login("argyporgy");
    const agent = await client.updateAgent((await newAgent(client)).id, { perTradeUsd: "5", dailyLimitUsd: "100" });
    for (let i = 0; i < 4; i++) script.push(call("buy", { chain: "arc", address: TOKEN, amountUsd: 5 }));
    script.push(say("Done."));
    await due(agent);
    await runWorker();
    const { items } = await client.agentRuns(agent.id);
    expect(items[0]!.actions.map((a) => a.ok)).toEqual([true, true, true, false]);
  }, 30_000);

  it("has no tool that moves funds, and can't be talked into one", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    script.push(call("transfer", { to: "0xbad", amountUsd: 100 }), say("There's no such thing."));
    await due(agent);
    await runWorker();
    expect(requests[0]!.toolNames.some((n) => /transfer|withdraw|send/i.test(n))).toBe(false);
    expect(Number((await client.agent(agent.id)).balanceUsd)).toBe(100);
    expect((await client.agentRuns(agent.id)).items[0]!.actions[0]).toMatchObject({ ok: false, acted: false });
  });

  it("stops after too many steps", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    for (let i = 0; i < 20; i++) script.push(call("get_portfolio"));
    await due(agent);
    await runWorker();
    expect(requests).toHaveLength(8);
    expect((await client.agentRuns(agent.id)).items[0]!.summary).toContain("Ran out of steps");
  });

  it("doesn't bill a model when it has nothing to trade with", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client, "testbot", "0");
    await due(agent);
    await runWorker();
    expect(requests).toHaveLength(0);
  });

  it("doesn't run while paused, or before it's due", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    await client.updateAgent(agent.id, { enabled: false });
    await due(agent);
    await runWorker();
    expect(requests).toHaveLength(0);
    await client.updateAgent(agent.id, { enabled: true });
    await runWorker();
    expect(requests.length).toBeGreaterThan(0);
    requests.length = 0;
    await runWorker();
    expect(requests).toHaveLength(0);
  });

  it("stops for the day at its model budget", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    await db().insert(schema.agentRuns).values({ agentId: agent.id, trigger: "schedule", costUsd: 2.5, finishedAt: new Date() });
    await due(agent);
    await runWorker();
    expect(requests).toHaveLength(0);
  });

  it("stops every agent at the shared budget", async () => {
    const client = await login("argyporgy");
    const spender = await newAgent(client, "spender");
    const agent = await newAgent(client, "second", "100");
    await db().insert(schema.agentRuns).values({ agentId: spender.id, trigger: "schedule", costUsd: 11, finishedAt: new Date() });
    await due(agent);
    await runWorker();
    expect(requests).toHaveLength(0);
  });

  it("pauses itself when its model keeps failing, and says so", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    for (let i = 0; i < 5; i++) {
      script.push({ fail: true });
      await due(agent);
      await runWorker();
    }
    const detail = await client.agent(agent.id);
    expect(detail.enabled).toBe(false);
    expect(detail.failures).toBe(5);
    const runs = (await client.agentRuns(agent.id)).items;
    expect(runs[0]!.error).toBeTruthy();
    const { items } = await client.notifications();
    expect(items.some((n) => n.message.includes("is paused"))).toBe(true);
  }, 30_000);
});

describe("talking to it", () => {
  async function holding(client: ApiClient) {
    const agent = await newAgent(client);
    script.push(call("buy", { chain: "arc", address: TOKEN, amountUsd: 20 }), say("Bought."));
    await due(agent);
    await runWorker();
    requests.length = 0;
    return agent;
  }

  it("sells when its owner says so, and answers", async () => {
    const client = await login("argyporgy");
    const agent = await holding(client);
    await client.sendAgentMessage(agent.id, "Sell half of it.");
    const pending = await client.agentMessages(agent.id);
    expect(pending.items.at(-1)).toMatchObject({ role: "owner", pending: true });

    script.push(call("sell", { chain: "arc", address: TOKEN, sellPct: 50 }), say("Sold half, as you asked."));
    await runWorker();

    const { items } = await client.agentMessages(agent.id);
    expect(items.map((m) => m.role)).toEqual(["owner", "agent"]);
    expect(items[0]!.pending).toBe(false);
    expect(items[1]!.body).toBe("Sold half, as you asked.");
    expect(requests[0]!.messages.some((m) => m.role === "user" && m.content === "Sell half of it.")).toBe(true);
    const position = (await client.agent(agent.id)).portfolio.open[0]!;
    expect(Number(position.qty)).toBeCloseTo(5, 0);
    expect((await client.agentRuns(agent.id)).items[0]).toMatchObject({ trigger: "chat" });
  }, 30_000);

  it("answers once, even if the worker passes again", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client, "testbot", "0");
    await client.sendAgentMessage(agent.id, "How are you doing?");
    script.push(say("Fine."));
    await runWorker();
    await runWorker();
    expect((await client.agentMessages(agent.id)).items.filter((m) => m.role === "agent")).toHaveLength(1);
  });

  it("sets and cancels a stop-loss when asked", async () => {
    const client = await login("argyporgy");
    const agent = await holding(client);
    await client.sendAgentMessage(agent.id, "Set a stop at 1.5.");
    script.push(call("place_order", { chain: "arc", address: TOKEN, type: "stop_loss", triggerPriceUsd: 1.5, sellPct: 100 }), say("Stop set at $1.50."));
    await runWorker();
    const { orders } = await client.agent(agent.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ type: "stop_loss", status: "open", sellPct: 100 });

    await client.sendAgentMessage(agent.id, "Cancel it.");
    script.push(call("cancel_order", { orderId: orders[0]!.id }), say("Cancelled."));
    await runWorker();
    expect((await client.agent(agent.id)).orders).toHaveLength(0);
  }, 30_000);

  it("won't let a limit order get around its per-trade limit", async () => {
    const client = await login("argyporgy");
    const agent = await holding(client);
    await client.sendAgentMessage(agent.id, "Put a limit buy for $90 at 1.");
    script.push(call("place_order", { chain: "arc", address: TOKEN, type: "limit_buy", triggerPriceUsd: 1, amountUsd: 90 }), say("That's over my limit."));
    await runWorker();
    expect((await client.agent(agent.id)).orders).toHaveLength(0);
  });

  it("works while paused, since the owner is asking", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    await client.updateAgent(agent.id, { enabled: false });
    await client.sendAgentMessage(agent.id, "Are you there?");
    script.push(say("Yes, paused but here."));
    await runWorker();
    expect((await client.agentMessages(agent.id)).items.at(-1)?.body).toBe("Yes, paused but here.");
  });

  it("says when the model failed, rather than leaving its owner waiting", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client, "testbot", "0");
    await client.sendAgentMessage(agent.id, "Hello?");
    script.push({ fail: true });
    await runWorker();
    expect((await client.agentMessages(agent.id)).items.at(-1)?.body).toContain("couldn't reach my model");
  });
});

describe("money", () => {
  it("moves between owner and agent, and no further than either has", async () => {
    const client = await login("argyporgy");
    const start = Number((await client.balance()).usdc);
    const agent = await newAgent(client);
    expect(Number((await client.balance()).usdc)).toBeCloseTo(start - 100, 2);
    await expectApiError(client.withdrawFromAgent(agent.id, "500"), "insufficient_balance");
    await expectApiError(client.fundAgentPaper(agent.id, "999999"), "insufficient_balance");
    const after = await client.withdrawFromAgent(agent.id, "40");
    expect(Number(after.balanceUsd)).toBe(60);
    expect(Number((await client.balance()).usdc)).toBeCloseTo(start - 60, 2);
  });
});

describe("the leaderboard", () => {
  it("ranks agents next to people, and compares them", async () => {
    const client = await login("argyporgy");
    const agent = await newAgent(client);
    script.push(call("buy", { chain: "arc", address: TOKEN, amountUsd: 20 }), call("post_thesis", { chain: "arc", address: TOKEN, body: "Going up from here on volume." }), say("In."));
    await due(agent);
    await runWorker();
    await setPrice(TOKEN, "3");
    await client.sendAgentMessage(agent.id, "Take the profit.");
    script.push(call("sell", { chain: "arc", address: TOKEN, sellPct: 100 }), say("Done."));
    await runWorker();

    const human = await login("sayan");
    await setPrice(TOKEN, "3");
    const quote = await human.quote({ chain: "arc", address: TOKEN, side: "buy", amountUsd: "50" });
    await human.executeTrade({ quoteId: quote.id, idempotencyKey: "human-buy-1", confirmed: true });
    await redis().eval("for _,k in ipairs(redis.call('keys','paper:fill:*')) do redis.call('set',k,'0') end return 1", 0);
    await pollActiveTrades();
    await human.createThesis({ chain: "arc", address: TOKEN, body: "Late to this." });
    await setPrice(TOKEN, "2");
    const out = await human.quote({ chain: "arc", address: TOKEN, side: "sell", sellPct: 100 });
    await human.executeTrade({ quoteId: out.id, idempotencyKey: "human-sell-1", confirmed: true });
    await redis().eval("for _,k in ipairs(redis.call('keys','paper:fill:*')) do redis.call('set',k,'0') end return 1", 0);
    await pollActiveTrades();

    const board = await new ApiClient({ baseUrl }).leaderboard();
    const names = board.provisional.map((r) => r.user.username);
    expect(names).toEqual(["testbot", "sayan"]);
    expect(board.provisional[0]!.user.agentModel).toBe("fast-model");
    expect(board.provisional[1]!.user.agentModel).toBeNull();
    expect(board.versus.agents).toMatchObject({ traders: 1, closed: 1, winRatePct: 100 });
    expect(board.versus.humans).toMatchObject({ traders: 1, closed: 1, winRatePct: 0 });
    expect(board.versus.agents!.avgScore).toBeGreaterThan(board.versus.humans!.avgScore);
  }, 30_000);
});
