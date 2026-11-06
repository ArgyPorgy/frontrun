import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

function loadRootEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadRootEnv();

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ORIGIN: z.string().default("http://localhost:3000"),
  API_PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  AUTH_MODE: z.enum(["privy", "dev"]).default("privy"),
  TRADING_MODE: z.enum(["live", "paper"]).default("live"),
  DEV_JWT_SECRET: optional,

  PRIVY_APP_ID: optional,
  PRIVY_APP_SECRET: optional,
  PRIVY_JWT_VERIFICATION_KEY: optional,
  PRIVY_AUTHORIZATION_KEY: optional,
  PRIVY_SIGNER_ID: optional,
  PRIVY_POLICY_IDS: optional,
  PRIVY_SOLANA_POLICY_IDS: optional,

  FLASH_API_KEY: optional,
  /** The app's fee on every trade, in basis points. It applies on every route that can collect one. */
  FLASH_INTEGRATOR_FEE_BPS: z.coerce.number().min(0).max(1000).default(50),
  /** Receives the fee on Uniswap trades. Flash pays its fee into the Definitive account instead. */
  FEE_RECIPIENT_ADDRESS: optional,
  /** Set to 0.005 once a fee wallet is set up at portal.li.fi. Until then LI.FI is only a last resort. */
  LIFI_FEE: optional,
  UNISWAP_API_KEY: optional,
  LIFI_API_KEY: optional,
  LIFI_INTEGRATOR: z.string().default("frontrun"),
  COINGECKO_API_KEY: optional,
  COINGECKO_PLAN: z.enum(["demo", "pro"]).default("demo"),

  ARC_RPC_URL: z.string().default("https://rpc.mainnet.arc.io"),
  ROBINHOOD_RPC_URL: optional,
  BASE_RPC_URL: optional,
  ARBITRUM_RPC_URL: optional,
  ETHEREUM_RPC_URL: optional,
  BSC_RPC_URL: optional,
  HYPEREVM_RPC_URL: optional,
  SOLANA_RPC_URL: optional,

  /** Funds small native top-ups when Privy can't sponsor a sell's setup. Leave unset to disable. */
  GAS_TOPUP_PRIVATE_KEY: optional,

  /** Pays gas for users through Pimlico's paymaster. While unset, every step falls back to the old path. */
  PIMLICO_API_KEY: optional,
  /** Optional spending limits, set up in Pimlico's dashboard. */
  PIMLICO_SPONSORSHIP_POLICY_ID: optional,

  /** Reads the X tracker's accounts through TwitterAPI.io, billed per post read. While unset, that tab says it isn't connected. */
  TWITTERAPI_IO_KEY: optional,
  /** Seconds between X tracker requests. Lower is fresher and costs more. Free accounts are limited to one every 5 seconds. */
  X_TRACKER_INTERVAL_SECONDS: z.coerce.number().min(5).default(20),

  /** ThesisRegistry on Arc. While unset, theses simply aren't anchored. */
  THESIS_REGISTRY_ADDRESS: optional,
  /** Pays to anchor theses. Falls back to the gas top-up wallet. */
  ANCHOR_RELAYER_PRIVATE_KEY: optional,

  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  VAPID_SUBJECT: z.string().default("mailto:hello@example.com"),

  /** Comma-separated ISO country codes. Empty means nothing is blocked. */
  GEO_BLOCKED_COUNTRIES: z.string().default("CU,IR,KP,SY,RU,BY"),
  ADMIN_TOKEN: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  assertSafeForProduction(parsed.data);
  cached = parsed.data;
  return cached;
}

/** Test-only: drops the cached env so a test can change process.env. */
export function resetEnvForTests() {
  cached = undefined;
}

/**
 * Dev login and paper fills exist so the app runs without third-party keys. Neither may reach
 * production, so the process refuses to boot rather than warn.
 */
export function assertSafeForProduction(e: Env) {
  if (e.NODE_ENV !== "production") return;
  const problems: string[] = [];
  if (e.AUTH_MODE === "dev") problems.push("AUTH_MODE=dev is not allowed in production");
  if (e.TRADING_MODE === "paper") problems.push("TRADING_MODE=paper is not allowed in production");
  if (!e.PRIVY_APP_ID || !e.PRIVY_APP_SECRET) problems.push("PRIVY_APP_ID and PRIVY_APP_SECRET are required");
  if (!e.FLASH_API_KEY) problems.push("FLASH_API_KEY is required");
  if (!e.APP_ORIGIN.startsWith("https://")) problems.push("APP_ORIGIN must be https");
  if (problems.length) throw new Error(`Refusing to start:\n  ${problems.join("\n  ")}`);
}

export function rootPath(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}
