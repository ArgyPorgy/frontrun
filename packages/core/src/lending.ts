import { z } from "zod";
import { BASE_USDC } from "./chains";

/**
 * Lending on Base: earn on USDC through Aave and Morpho, and borrow USDC against Coinbase's tokenized stocks
 * in Morpho markets. Every address here was read from the chain, and they're all public.
 */

export const AAVE_BASE = {
  pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
} as const;

export const MORPHO_BASE = {
  blue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  adaptiveCurveIrm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
  chainlinkOracleFactory: "0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d",
} as const;

/** Coinbase's tokenized stocks on Base. Each tracks one share, has 8 decimals and a Chainlink feed run for Coinbase. */
export interface StockToken {
  ticker: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  /** Chainlink "Coinbase <TICKER>" feed, 8 decimals, updated through US market hours on weekdays. */
  feed: string;
}

export const STOCK_TOKENS: readonly StockToken[] = [
  { ticker: "NVDA", symbol: "NVDAc", name: "NVIDIA", address: "0xb20000000000000000000078ee7ce2fE4908108C", decimals: 8, feed: "0x04689a41629776563E6822F76f2e57D148d28513" },
  { ticker: "TSLA", symbol: "TSLAc", name: "Tesla", address: "0xb2000000000000000000001e800a7f5189430cD0", decimals: 8, feed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4" },
  { ticker: "AAPL", symbol: "AAPLc", name: "Apple", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", decimals: 8, feed: "0x787f13dEa48Db0897CbCDD985de77809D837F988" },
  { ticker: "GOOGL", symbol: "GOOGLc", name: "Alphabet", address: "0xb2000000000000000000002D0BA3164cc74f58B7", decimals: 8, feed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2" },
  { ticker: "META", symbol: "METAc", name: "Meta", address: "0xb2000000000000000000008bC8786B856E61707C", decimals: 8, feed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D" },
  { ticker: "AMZN", symbol: "AMZNc", name: "Amazon", address: "0xb200000000000000000000d9192b6B456483C2E8", decimals: 8, feed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295" },
  { ticker: "MSFT", symbol: "MSFTc", name: "Microsoft", address: "0xB200000000000000000000Ab99cFa739E253872B", decimals: 8, feed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c" },
  { ticker: "SPCX", symbol: "SPCXc", name: "SpaceX", address: "0xb2000000000000000000007b9fcbd005511aCBd5", decimals: 8, feed: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68" },
];

export function stockToken(tickerOrAddress: string): StockToken | undefined {
  const k = tickerOrAddress.toLowerCase();
  return STOCK_TOKENS.find((t) => t.ticker.toLowerCase() === k || t.symbol.toLowerCase() === k || t.address.toLowerCase() === k);
}

/** Curated Morpho vaults that lend USDC on Base. Picked for size and curator track record. */
export const MORPHO_USDC_VAULTS = [
  { address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", name: "Gauntlet USDC Prime", curator: "Gauntlet" },
  { address: "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", name: "Steakhouse USDC", curator: "Steakhouse" },
  { address: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca", name: "Moonwell Flagship USDC", curator: "Moonwell" },
  { address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A", name: "Spark USDC Vault", curator: "Spark" },
] as const;

/** A Morpho market that lends USDC against one stock token. Its id is the hash of these params. */
export interface StockMarketDef {
  id: string;
  ticker: string;
  oracle: string;
  lltv: string;
  /** Front Run created it. The others are Morpho's listed markets. */
  ours: boolean;
}

export const STOCK_MARKETS: readonly StockMarketDef[] = [
  { id: "0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13", ticker: "NVDA", oracle: "0x4F698C04d01d9CebCDd9494c189aBdD6C5453f84", lltv: "625000000000000000", ours: false },
  { id: "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28", ticker: "AAPL", oracle: "0xEcC5c9bf18CB2CfC94C2f7EFf8BDd5837A60AB0e", lltv: "625000000000000000", ours: false },
  { id: "0xa3913d896b7e9c0e0a84f1be27d376cf2065616101cb7c44674af8a154e684cc", ticker: "GOOGL", oracle: "0x24DC11055aa5b2C5692E4B77d7285c4f0fd9Cf99", lltv: "770000000000000000", ours: false },
  { id: "0x44b343b5087c0bd34207cb5c199f12030777bf6b8c0a128438246f1212f37ca5", ticker: "META", oracle: "0x4752B27dFc1931eb9a5DFEFC7FBC9d0af9020dC7", lltv: "625000000000000000", ours: false },
  { id: "0xce983b9ee6344e16ebbcc66812f23caafc63ae83fcc14fa29b66c7e69e9cecf6", ticker: "SPCX", oracle: "0x9079857a2b5FFfC3d87052b11b866a185B4A6483", lltv: "625000000000000000", ours: false },
  // Front Run's own markets, made with scripts/create-stock-markets.ts on 2026-11-27.
  { id: "0x0df7e779500c8574b699fbc4a9575c7e9bb769deaa82f7b77e52e18fe2d4f46d", ticker: "TSLA", oracle: "0x582EDa06e93303A1De26C74d2B61DD093c40104e", lltv: "625000000000000000", ours: true },
  { id: "0x6389d18d39260340670465786c9ffd0e9b49a82f02d2220063e1a10042c9f517", ticker: "AMZN", oracle: "0x1e16279c2864B18F402d752fAbd86DccD4Fa3859", lltv: "625000000000000000", ours: true },
  { id: "0xf98eea904e9e1ac9b6dccfb0d64c190f738bf97eec84ecf6aa80e9e2304c65bf", ticker: "MSFT", oracle: "0x0c3BFaA49D04a28265780D086a2B6D4380A57Fd7", lltv: "625000000000000000", ours: true },
];

/** The params Morpho hashes into a market's id. */
export function stockMarketParams(m: StockMarketDef) {
  const token = stockToken(m.ticker);
  if (!token) throw new Error(`Unknown stock ${m.ticker}`);
  return {
    loanToken: BASE_USDC,
    collateralToken: token.address,
    oracle: m.oracle,
    irm: MORPHO_BASE.adaptiveCurveIrm,
    lltv: m.lltv,
  };
}

export type LendingVenue = "aave" | "morpho_vault" | "morpho_market";
export const AAVE_USDC_ID = "aave-usdc";

export interface LendingMarketView {
  /** "aave-usdc", a vault's address, or a Morpho market id. */
  id: string;
  venue: LendingVenue;
  name: string;
  curator: string;
  /** Front Run created this market. */
  ours: boolean;
  /** For stock markets: what's borrowed against, with its oracle price. */
  collateral: { ticker: string; symbol: string; name: string; address: string; decimals: number; priceUsd: number | null } | null;
  /** Borrows are liquidated when debt reaches this share of the collateral's value. */
  lltv: number | null;
  /** Yearly rates, in percent. */
  supplyApy: number | null;
  borrowApy: number | null;
  totalSupplyUsd: number | null;
  totalBorrowUsd: number | null;
  /** What can be borrowed or withdrawn right now. */
  liquidityUsd: number | null;
  utilization: number | null;
}

export interface LendingPositionView {
  market: LendingMarketView;
  suppliedUsd: string;
  collateralQty: string;
  collateralUsd: string | null;
  borrowedUsd: string;
  /** How much more can be borrowed while staying above the app's safety margin. */
  maxBorrowUsd: string | null;
  /** How much collateral can come out while staying above that margin. */
  maxWithdrawCollateral: string | null;
  healthFactor: number | null;
  liquidationPrice: number | null;
}

export interface LendingSummaryView {
  positions: LendingPositionView[];
  totalSuppliedUsd: string;
  totalBorrowedUsd: string;
  totalCollateralUsd: string;
  walletUsdc: string;
  /** Stock tokens in the wallet that could be posted as collateral. */
  stocks: Array<{ ticker: string; symbol: string; qty: string; usd: string | null }>;
}

export const LENDING_ACTIONS = ["supply", "withdraw", "supply_collateral", "withdraw_collateral", "borrow", "repay"] as const;
export type LendingAction = (typeof LENDING_ACTIONS)[number];

export interface LendingActionView {
  id: string;
  action: LendingAction;
  venue: LendingVenue;
  marketId: string;
  marketName: string;
  /** USDC, or the stock token's symbol for collateral moves. */
  asset: string;
  amount: string;
  status: "pending" | "done" | "failed";
  txHash: string | null;
  /** An agent's public reason for it. */
  reason: string | null;
  error: string | null;
  createdAt: string;
}

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, "Enter an amount.");
export const lendingActionSchema = z
  .object({
    marketId: z.string().min(3).max(80),
    action: z.enum(LENDING_ACTIONS),
    /** USDC for supply, withdraw, borrow and repay; the stock token for collateral moves. */
    amount: decimalString.optional(),
    /** Everything: the whole balance, deposit or debt. */
    max: z.boolean().optional(),
  })
  .refine((v) => v.max || (v.amount && Number(v.amount) > 0), { message: "Enter an amount." });
export type LendingActionInput = z.infer<typeof lendingActionSchema>;

/**
 * Borrows and collateral withdrawals stop at this health factor. Morpho liquidates at 1.0, and stocks can gap
 * when markets open, so the app keeps a cushion that a normal day's move won't eat through.
 */
export const LENDING_MIN_HEALTH = 1.25;

/** Collateral value times the liquidation LTV, over the debt. Below 1, the position can be liquidated. */
export function lendingHealthFactor(collateralUsd: number, borrowedUsd: number, lltv: number): number | null {
  if (borrowedUsd <= 0) return null;
  return (collateralUsd * lltv) / borrowedUsd;
}

/** The stock price at which this borrow can be liquidated. */
export function lendingLiquidationPrice(collateralQty: number, borrowedUsd: number, lltv: number): number | null {
  if (borrowedUsd <= 0 || collateralQty <= 0 || lltv <= 0) return null;
  return borrowedUsd / (collateralQty * lltv);
}

/** More USDC that can be borrowed while the health factor stays at or above the minimum. */
export function lendingMaxBorrow(collateralUsd: number, borrowedUsd: number, lltv: number, minHealth = LENDING_MIN_HEALTH): number {
  return Math.max(0, (collateralUsd * lltv) / minHealth - borrowedUsd);
}

/** Collateral that can come out while the health factor stays at or above the minimum. */
export function lendingMaxCollateralOut(collateralQty: number, priceUsd: number, borrowedUsd: number, lltv: number, minHealth = LENDING_MIN_HEALTH): number {
  if (borrowedUsd <= 0) return collateralQty;
  if (priceUsd <= 0 || lltv <= 0) return 0;
  const needed = (borrowedUsd * minHealth) / (lltv * priceUsd);
  return Math.max(0, collateralQty - needed);
}

/** Morpho's per-second borrow rate, as a yearly percentage with continuous compounding. */
export function ratePerSecondToApy(ratePerSecondWad: bigint): number {
  const perSecond = Number(ratePerSecondWad) / 1e18;
  return (Math.exp(perSecond * 31_536_000) - 1) * 100;
}

/** Aave's yearly rate in ray, compounded per second, as a percentage. */
export function aaveRayToApy(rateRay: bigint): number {
  const apr = Number(rateRay) / 1e27;
  return (Math.pow(1 + apr / 31_536_000, 31_536_000) - 1) * 100;
}
