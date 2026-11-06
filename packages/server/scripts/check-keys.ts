/**
 * Tests every key in .env against its real service.
 *   pnpm keys:check
 *
 * Read-only: nothing is signed, sent or created, and no funds move. Key values are never printed,
 * and anything a service sends back is scrubbed of them before it's shown.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { CHAINS, type ChainKey } from "@frontrun/core";
import { PrivyClient } from "@privy-io/node";
import { privateKeyToAddress } from "viem/accounts";
import webpush from "web-push";
import { appOrigins, env } from "../src/env";
import { fetchJson, HttpError } from "../src/http";
import { fetchTokenInfo, GeckoBusyError, geckoPlan, trendingPools } from "../src/market/geckoterminal";
import { evmClient } from "../src/onchain";
import { flashProvider } from "../src/providers/flash";
import { lifiProvider } from "../src/providers/lifi";
import type { RouteRequest } from "../src/providers/types";
import { uniswapProvider } from "../src/providers/uniswap";
import { closeRedis } from "../src/redis";
import { normalizePrivateKey } from "../src/trading/signer";

type State = "ok" | "warn" | "fail" | "missing";

const LABEL: Record<State, string> = { ok: "OK     ", warn: "WARN   ", fail: "FAIL   ", missing: "not set" };

const e = env();

const SECRETS = [
  e.PRIVY_APP_SECRET,
  e.PRIVY_AUTHORIZATION_KEY,
  e.PRIVY_JWT_VERIFICATION_KEY,
  e.FLASH_API_KEY,
  e.UNISWAP_API_KEY,
  e.LIFI_API_KEY,
  e.COINGECKO_API_KEY,
  e.GAS_TOPUP_PRIVATE_KEY,
  e.VAPID_PRIVATE_KEY,
  e.DEV_JWT_SECRET,
  e.ADMIN_TOKEN,
].filter((v): v is string => !!v);

function scrub(text: string): string {
  return SECRETS.reduce((out, secret) => out.split(secret).join("[hidden]"), text);
}

let failures = 0;

function line(state: State, name: string, detail: string) {
  if (state === "fail") failures++;
  console.log(`  ${LABEL[state]}  ${name.padEnd(26)} ${scrub(detail)}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

function reason(err: unknown): string {
  if (err instanceof HttpError) return `HTTP ${err.status}`;
  return err instanceof Error ? err.message.slice(0, 140) : "unknown error";
}

/** Hash of the shared key in Flash's docs, so it can be recognized without storing it here. */
const FLASH_DOCS_KEY_SHA256 = "60e0e493178ca75739cc05aafc54d47a5efc2578fa3a8c1857b97d8ef6a38f17";

const BURN = "0x000000000000000000000000000000000000dEaD";
const ARC_WETH = "0x128cc466b61f542da60c70e3aa11c10e19b84edb";
const BASE_WETH = "0x4200000000000000000000000000000000000006";

const sampleBuy = (over: Partial<RouteRequest>): RouteRequest => ({
  side: "buy",
  chain: "base",
  address: BASE_WETH,
  decimals: 18,
  usdcIn: "1",
  evmAddress: BURN,
  solanaAddress: null,
  priceUsd: "2400",
  notionalUsd: "1",
  ...over,
});

async function checkMarketData() {
  section("Market data");
  const plan = geckoPlan();
  const name = `CoinGecko (${plan} plan)`;
  if (!e.COINGECKO_API_KEY) {
    line("missing", "CoinGecko", "Keyless: about 5 calls a minute, so charts and lists lag. A free Demo key fixes this.");
  } else {
    try {
      const pools = await trendingPools("arc");
      line("ok", name, `${pools.length} trending Arc tokens`);
      const info = await fetchTokenInfo("arc", ARC_WETH).catch(() => null);
      if (info) line("ok", "  holder data", `${info.holderCount ?? "?"} holders, top 10 hold ${info.top10Pct ?? "?"}%`);
      else line("warn", "  holder data", "Not available on this plan, so holder risk flags won't show.");
    } catch (err) {
      if (err instanceof GeckoBusyError) line("warn", name, "Rate limited right now. Run this again in a minute.");
      else line("fail", name, `${reason(err)}. If this is a paid key, set COINGECKO_PLAN=pro. If it's free, use demo.`);
    }
  }
  try {
    const chainId = await evmClient("arc").getChainId();
    if (chainId !== CHAINS.arc.chainId) line("fail", "Arc RPC", `Answered as chain ${chainId}, expected ${CHAINS.arc.chainId}.`);
    else if (e.ARC_RPC_URL === CHAINS.arc.defaultRpc) line("warn", "Arc RPC", "Public endpoint works, but isn't meant for production load.");
    else line("ok", "Arc RPC", "Private endpoint on chain 5042");
  } catch (err) {
    line("fail", "Arc RPC", reason(err));
  }
  const optional: Array<[ChainKey, string | undefined]> = [
    ["robinhood", e.ROBINHOOD_RPC_URL],
    ["base", e.BASE_RPC_URL],
    ["arbitrum", e.ARBITRUM_RPC_URL],
    ["ethereum", e.ETHEREUM_RPC_URL],
    ["bsc", e.BSC_RPC_URL],
    ["hyperevm", e.HYPEREVM_RPC_URL],
  ];
  for (const [chain, url] of optional) {
    if (!url) continue;
    try {
      const chainId = await evmClient(chain).getChainId();
      if (chainId === CHAINS[chain].chainId) line("ok", `${CHAINS[chain].name} RPC`, `chain ${chainId}`);
      else line("fail", `${CHAINS[chain].name} RPC`, `Answered as chain ${chainId}, expected ${CHAINS[chain].chainId}.`);
    } catch (err) {
      line("fail", `${CHAINS[chain].name} RPC`, reason(err));
    }
  }
}

async function checkRouting() {
  section("Trade routing (quotes only)");
  if (!e.FLASH_API_KEY) {
    line("missing", "Flash", "Cross-chain falls back to LI.FI only.");
  } else {
    const isDocsKey = createHash("sha256").update(e.FLASH_API_KEY).digest("hex") === FLASH_DOCS_KEY_SHA256;
    try {
      const started = Date.now();
      await flashProvider.quote(sampleBuy({}));
      const detail = `$1 Arc USDC to Base WETH quoted in ${Date.now() - started}ms`;
      if (isDocsKey) line("warn", "Flash", `Works, but this is the shared key from Flash's docs. Get your own: it's rate limited. ${detail}`);
      else line("ok", "Flash", detail);
    } catch (err) {
      line("fail", "Flash", reason(err));
    }
  }
  if (!e.PIMLICO_API_KEY) {
    line("missing", "Pimlico", "Trades aren't gasless. Users pay gas, and first sells on other chains need the gas wallet funded.");
  } else {
    try {
      const res = await fetchJson<{ result?: unknown; error?: { message?: string } }>(`https://api.pimlico.io/v2/5042/rpc?apikey=${e.PIMLICO_API_KEY}`, {
        method: "POST",
        body: { jsonrpc: "2.0", id: 1, method: "pimlico_getUserOperationGasPrice", params: [] },
        timeoutMs: 8_000,
      });
      if (res.error) line("fail", "Pimlico", res.error.message ?? "The key was refused.");
      else line("ok", "Pimlico", "Key works on Arc. Run pnpm sponsor:test to prove sponsorship end to end.");
    } catch (err) {
      line("fail", "Pimlico", err instanceof HttpError ? `HTTP ${err.status}. The key may be wrong.` : "Couldn't reach Pimlico.");
    }
  }
  if (!e.UNISWAP_API_KEY) {
    line("missing", "Uniswap Trading API", "Arc swaps use the direct v3 route, which only reaches single-hop USDC pools.");
  } else {
    try {
      const quote = await uniswapProvider.quote(sampleBuy({ chain: "arc", address: ARC_WETH, priceUsd: "2400" }));
      line("ok", "Uniswap Trading API", `Serves Arc: $1 USDC quotes ${Number(quote.expectedOut).toFixed(6)} WETH`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      if (status === 401 || status === 403) line("fail", "Uniswap Trading API", `Key rejected (HTTP ${status}).`);
      else line("warn", "Uniswap Trading API", `Key accepted, but no Arc quote: ${reason(err)}. The direct route doesn't run while a key is set.`);
    }
  }
  try {
    // LI.FI's routes have a minimum above $1, so this uses a size it can actually serve.
    await lifiProvider.quote(sampleBuy({ usdcIn: "5", notionalUsd: "5" }));
    line("ok", e.LIFI_API_KEY ? "LI.FI (your key)" : "LI.FI (no key needed)", "Cross-chain fallback quoted");
  } catch (err) {
    line(e.LIFI_API_KEY ? "fail" : "warn", "LI.FI", reason(err));
  }
}

function publicKeyBody(key: string): string {
  return key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
}

async function checkPrivy() {
  section("Login and one-tap signing (Privy)");
  if (!e.PRIVY_APP_ID || !e.PRIVY_APP_SECRET) {
    line("missing", "Privy app", "Dev login stays in use until PRIVY_APP_ID and PRIVY_APP_SECRET are set.");
    if (e.PRIVY_APP_ID || e.PRIVY_APP_SECRET) line("fail", "Privy app", "Only one of the id and secret is set. Both are needed.");
    return;
  }
  const client = new PrivyClient({ appId: e.PRIVY_APP_ID, appSecret: e.PRIVY_APP_SECRET });
  try {
    const settings = await client.apps().getSettings();
    line("ok", "Privy app", `Connected to "${settings.name}"`);
    if (!settings.google_oauth) line("warn", "  Google login", "Off. Turn it on: Dashboard > Login methods.");
    else line("ok", "  Google login", "On");
    for (const origin of appOrigins(e)) {
      const host = new URL(origin).host;
      if (settings.allowed_domains.length && !settings.allowed_domains.some((d) => d.includes(host))) {
        line("warn", "  allowed domains", `${host} isn't listed, so login from this address will be refused.`);
      }
    }
  } catch (err) {
    line("fail", "Privy app", `${reason(err)}. Check the app id and secret.`);
    return;
  }

  if (e.PRIVY_JWT_VERIFICATION_KEY) {
    try {
      createPublicKey(e.PRIVY_JWT_VERIFICATION_KEY.replace(/\\n/g, "\n"));
      line("ok", "JWT verification key", "Valid format");
    } catch {
      line("fail", "JWT verification key", "Can't be parsed. Paste it as one line with \\n between lines, in quotes.");
    }
  }

  if (!e.PRIVY_AUTHORIZATION_KEY || !e.PRIVY_SIGNER_ID) {
    line("missing", "App signer", "One-tap stays off: every trade asks for a wallet confirm.");
    return;
  }
  let derivedPublic: string;
  try {
    const body = e.PRIVY_AUTHORIZATION_KEY.replace(/^wallet-auth:/, "");
    const key = createPrivateKey({ key: Buffer.from(body, "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("wrong curve");
    derivedPublic = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
    line("ok", "Authorization key", "Valid P-256 key");
  } catch {
    line("fail", "Authorization key", "Can't be parsed. It should look like wallet-auth:... from the dashboard.");
    return;
  }
  try {
    const quorum = await client.keyQuorums().get(e.PRIVY_SIGNER_ID);
    const member = quorum.authorization_keys.some((k) => publicKeyBody(k.public_key) === derivedPublic);
    if (member) line("ok", "Signer id", "Matches the authorization key");
    else line("fail", "Signer id", "Found, but your authorization key isn't part of it. They came from different keys.");
  } catch (err) {
    line("fail", "Signer id", reason(err));
  }

  const checkPolicies = async (name: string, ids: string | undefined, chainType: string, missing: string) => {
    if (!ids) {
      line("missing", name, missing);
      return;
    }
    for (const id of ids.split(",").map((p) => p.trim()).filter(Boolean)) {
      try {
        const policy = await client.policies().get(id);
        if (policy.chain_type === chainType) line("ok", name, `"${policy.name}", ${policy.rules.length} rules`);
        else line("fail", name, `This policy is for ${policy.chain_type}, expected ${chainType}.`);
      } catch (err) {
        line("fail", name, reason(err));
      }
    }
  };
  await checkPolicies("EVM signer policy", e.PRIVY_POLICY_IDS, "ethereum", "One-tap stays off until this is set. Create it with: pnpm privy:policy");
  await checkPolicies("Solana signer policy", e.PRIVY_SOLANA_POLICY_IDS, "solana", "Solana sells will ask for a wallet confirm. Create it with: pnpm privy:policy");
}

function checkOther() {
  section("Other");
  if (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY) {
    line("missing", "Web push", "Push notifications stay off. Generate keys with: pnpm exec web-push generate-vapid-keys");
  } else {
    try {
      webpush.setVapidDetails(e.VAPID_SUBJECT, e.VAPID_PUBLIC_KEY, e.VAPID_PRIVATE_KEY);
      if (e.VAPID_SUBJECT.includes("example.com")) line("warn", "Web push", "Keys are valid. Put a real contact in VAPID_SUBJECT before launch.");
      else line("ok", "Web push", "Keys are valid");
    } catch (err) {
      line("fail", "Web push", reason(err));
    }
  }
  if (!e.GAS_TOPUP_PRIVATE_KEY) {
    line("missing", "Gas top-up wallet", "Optional. First sells on chains Privy can't sponsor can't be set up without it.");
  } else {
    try {
      line("ok", "Gas top-up wallet", `Address ${privateKeyToAddress(normalizePrivateKey(e.GAS_TOPUP_PRIVATE_KEY))}. Keep it funded on each chain.`);
    } catch {
      line("fail", "Gas top-up wallet", "Not a valid private key.");
    }
  }
}

function summary() {
  section("Where this leaves you");
  const hasPrivy = !!(e.PRIVY_APP_ID && e.PRIVY_APP_SECRET);
  const login = e.AUTH_MODE === "privy" ? "real Privy login" : "stand-in dev login";
  const fills = e.TRADING_MODE === "live" ? "REAL TRADES WITH REAL FUNDS" : "simulated fills, no real funds";
  console.log(`  Running with: ${login}, ${fills}.`);
  if (hasPrivy && e.AUTH_MODE === "dev") {
    console.log("  Next: set AUTH_MODE=privy in .env for real Google login. Fills stay simulated.");
  }
  if (e.AUTH_MODE === "privy" && e.TRADING_MODE === "paper" && !failures) {
    console.log("  Real money only starts when TRADING_MODE=live. Follow the $1-2 test in docs/GO_LIVE.md first.");
  }
  if (failures) console.log(`\n  ${failures} check${failures === 1 ? "" : "s"} failed. Fix those and run this again.`);
  else console.log("\n  No failures. Restart the API and workers so they pick up any new values.");
}

async function main() {
  console.log("Key check. Read-only: nothing is signed or sent, and key values are never printed.");
  await checkMarketData();
  await checkRouting();
  await checkPrivy();
  checkOther();
  summary();
}

main()
  .catch((err) => {
    failures++;
    console.error(scrub(err instanceof Error ? err.message : String(err)));
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    process.exit(failures ? 1 : 0);
  });
