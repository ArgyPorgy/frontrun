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
    TWITTERAPI_IO_KEY: "test-key",
  });
});

import { closeDb, closeRedis, pickTokenTweets, redis, resetEnvForTests, tokenTweets } from "@frontrun/server";

const SOL = "DKYcjobF7HPtL9RyQBRdeRQ2iWvizpfbgWwPWNXdpump";
const EVM = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

const tweet = (id: string, handle: string, text: string, extra: object = {}) => ({
  id,
  text,
  createdAt: "2026-11-06T10:00:00.000Z",
  author: { userName: handle, name: handle, profilePicture: "https://pbs.twimg.com/a.jpg" },
  ...extra,
});

let searches: string[] = [];
let respond: () => Response = () => new Response("{}");
const realFetch = globalThis.fetch;

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.twitterapi.io/")) {
      searches.push(new URL(url).searchParams.get("query") ?? "");
      return respond();
    }
    return realFetch(input, init);
  });
});

beforeEach(async () => {
  await redis().flushdb();
  searches = [];
  respond = () => new Response(JSON.stringify({ tweets: [tweet("1", "someone", `aping ${SOL} now`)] }), { status: 200, headers: { "content-type": "application/json" } });
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
  vi.unstubAllGlobals();
});

describe("picking a token's posts", () => {
  it("keeps real mentions of the address, and skips reposts", () => {
    const items = pickTokenTweets({ tweets: [tweet("1", "a", `buy ${SOL}`), tweet("2", "b", "nothing to see"), tweet("3", "c", `rt ${SOL}`, { retweeted_tweet: { text: SOL } })] }, SOL);
    expect(items.map((p) => p.authorHandle)).toEqual(["a"]);
    expect(items[0]?.url).toBe("https://x.com/a/status/1");
  });

  it("matches an EVM address in any case, but a Solana address exactly", () => {
    expect(pickTokenTweets({ tweets: [tweet("1", "a", `check ${EVM.toUpperCase().replace("0X", "0x")}`)] }, EVM)).toHaveLength(1);
    expect(pickTokenTweets({ tweets: [tweet("1", "a", `check ${SOL.toLowerCase()}`)] }, SOL)).toHaveLength(0);
  });

  it("stops one account from filling the feed", () => {
    const spam = ["1", "2", "3", "4"].map((id) => tweet(id, "shiller", `buy ${SOL} ${id}`));
    expect(pickTokenTweets({ tweets: [...spam, tweet("5", "other", `hm ${SOL}`)] }, SOL).map((p) => p.authorHandle)).toEqual(["shiller", "shiller", "other"]);
  });
});

describe("searching X for a token", () => {
  it("searches the contract address, then shares the result for a while", async () => {
    const first = await tokenTweets(SOL);
    expect(first.items).toHaveLength(1);
    expect(first.unavailable).toBe(false);
    await tokenTweets(SOL);
    expect(searches).toEqual([SOL]);
  });

  it("says so when X can't be read, rather than claiming nobody's posting", async () => {
    respond = () => new Response("slow down", { status: 429 });
    expect(await tokenTweets(SOL)).toMatchObject({ items: [], unavailable: true });
  });

  it("stops searching at the hourly limit", async () => {
    const hour = Math.floor(Date.now() / 3_600_000);
    await redis().set(`tracker:x:token-budget:${hour}`, "240");
    expect(await tokenTweets(SOL)).toMatchObject({ items: [], unavailable: true });
    expect(searches).toEqual([]);
  });

  it("stays quiet when no X key is set", async () => {
    const key = process.env.TWITTERAPI_IO_KEY;
    process.env.TWITTERAPI_IO_KEY = "";
    resetEnvForTests();
    expect(await tokenTweets(SOL)).toMatchObject({ configured: false });
    expect(searches).toEqual([]);
    process.env.TWITTERAPI_IO_KEY = key;
    resetEnvForTests();
  });
});
