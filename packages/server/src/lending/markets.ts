import {
  AAVE_BASE,
  AAVE_USDC_ID,
  BASE_USDC,
  MORPHO_BASE,
  MORPHO_USDC_VAULTS,
  STOCK_MARKETS,
  aaveRayToApy,
  ratePerSecondToApy,
  stockMarketParams,
  stockToken,
  type LendingMarketView,
  type StockMarketDef,
} from "@frontrun/core";
import { erc20Abi, parseAbi, type Hex } from "viem";
import { fetchJson } from "../http";
import { logger } from "../logger";
import { evmClient } from "../onchain";
import { cachedJson } from "../redis";

export const AAVE_POOL_ABI = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
]);

export const VAULT_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

const MARKET_PARAMS = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";
export const MORPHO_ABI = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  `function supply(${MARKET_PARAMS} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function withdraw(${MARKET_PARAMS} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function borrow(${MARKET_PARAMS} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function repay(${MARKET_PARAMS} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function supplyCollateral(${MARKET_PARAMS} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function withdrawCollateral(${MARKET_PARAMS} marketParams, uint256 assets, address onBehalf, address receiver)`,
]);
const IRM_ABI = parseAbi([
  `function borrowRateView(${MARKET_PARAMS} marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)`,
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);

export type MarketState = { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint };

/** Morpho's share math, with its virtual shares and assets, rounded the way Morpho rounds them. */
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;
export function sharesToAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}
export function sharesToAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const d = totalShares + VIRTUAL_SHARES;
  return (shares * (totalAssets + VIRTUAL_ASSETS) + d - 1n) / d;
}

export function marketParamsFor(def: StockMarketDef) {
  const p = stockMarketParams(def);
  return { loanToken: p.loanToken as Hex, collateralToken: p.collateralToken as Hex, oracle: p.oracle as Hex, irm: p.irm as Hex, lltv: BigInt(p.lltv) };
}

/** One whole token's price in USD, from a Morpho oracle (USDC units per token unit, scaled by 1e36). */
export function oraclePriceUsd(price: bigint, collateralDecimals: number): number {
  return Number((price * 10n ** BigInt(collateralDecimals)) / 10n ** 30n) / 1e6 / 1e6;
}

const usd = (raw: bigint) => Number(raw) / 1e6;

async function readAave(): Promise<LendingMarketView> {
  const client = evmClient("base");
  const reserve = await client.readContract({ address: AAVE_BASE.pool as Hex, abi: AAVE_POOL_ABI, functionName: "getReserveData", args: [BASE_USDC as Hex] });
  const [supply, debt, cash] = await Promise.all([
    client.readContract({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: "totalSupply" }),
    client.readContract({ address: reserve.variableDebtTokenAddress, abi: erc20Abi, functionName: "totalSupply" }),
    client.readContract({ address: BASE_USDC as Hex, abi: erc20Abi, functionName: "balanceOf", args: [reserve.aTokenAddress] }),
  ]);
  return {
    id: AAVE_USDC_ID,
    venue: "aave",
    name: "Aave USDC",
    curator: "Aave",
    ours: false,
    collateral: null,
    lltv: null,
    supplyApy: aaveRayToApy(reserve.currentLiquidityRate),
    borrowApy: aaveRayToApy(reserve.currentVariableBorrowRate),
    totalSupplyUsd: usd(supply),
    totalBorrowUsd: usd(debt),
    liquidityUsd: usd(cash),
    utilization: supply > 0n ? Number(debt) / Number(supply) : null,
  };
}

/** Vault yields include each vault's fee and rewards, so they come from Morpho's API. Without it they show as unknown. */
async function vaultApys(): Promise<Record<string, number>> {
  return cachedJson("lending:vault-apys", 600, async () => {
    try {
      const addresses = MORPHO_USDC_VAULTS.map((v) => `"${v.address}"`).join(",");
      const res = await fetchJson<{ data?: { vaults?: { items?: Array<{ address: string; state?: { netApy?: number } }> } } }>("https://api.morpho.org/graphql", {
        method: "POST",
        body: { query: `{ vaults(where:{chainId_in:[8453], address_in:[${addresses}]}) { items { address state { netApy } } } }` },
        timeoutMs: 8_000,
      });
      const out: Record<string, number> = {};
      for (const v of res.data?.vaults?.items ?? []) if (typeof v.state?.netApy === "number" && v.state.netApy < 1) out[v.address.toLowerCase()] = v.state.netApy * 100;
      return out;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "Morpho vault yields unavailable");
      return {};
    }
  });
}

async function readVaults(): Promise<LendingMarketView[]> {
  const client = evmClient("base");
  const [apys, totals] = await Promise.all([
    vaultApys(),
    Promise.all(MORPHO_USDC_VAULTS.map((v) => client.readContract({ address: v.address as Hex, abi: VAULT_ABI, functionName: "totalAssets" }).catch(() => null))),
  ]);
  return MORPHO_USDC_VAULTS.map((v, i) => ({
    id: v.address,
    venue: "morpho_vault" as const,
    name: v.name,
    curator: v.curator,
    ours: false,
    collateral: null,
    lltv: null,
    supplyApy: apys[v.address.toLowerCase()] ?? null,
    borrowApy: null,
    totalSupplyUsd: totals[i] === null ? null : usd(totals[i]!),
    totalBorrowUsd: null,
    liquidityUsd: null,
    utilization: null,
  }));
}

export async function readMarketState(id: string): Promise<MarketState> {
  const m = await evmClient("base").readContract({ address: MORPHO_BASE.blue as Hex, abi: MORPHO_ABI, functionName: "market", args: [id as Hex] });
  return { totalSupplyAssets: m[0], totalSupplyShares: m[1], totalBorrowAssets: m[2], totalBorrowShares: m[3], lastUpdate: m[4], fee: m[5] };
}

export async function readOraclePrice(def: StockMarketDef): Promise<bigint> {
  return evmClient("base").readContract({ address: def.oracle as Hex, abi: ORACLE_ABI, functionName: "price" });
}

async function readStockMarket(def: StockMarketDef): Promise<LendingMarketView> {
  const token = stockToken(def.ticker)!;
  const params = marketParamsFor(def);
  const [state, price] = await Promise.all([readMarketState(def.id), readOraclePrice(def).catch(() => null)]);
  const rate = await evmClient("base")
    .readContract({ address: MORPHO_BASE.adaptiveCurveIrm as Hex, abi: IRM_ABI, functionName: "borrowRateView", args: [params, state] })
    .catch(() => null);
  const utilization = state.totalSupplyAssets > 0n ? Number(state.totalBorrowAssets) / Number(state.totalSupplyAssets) : 0;
  const borrowApy = rate === null ? null : ratePerSecondToApy(rate);
  const fee = Number(state.fee) / 1e18;
  return {
    id: def.id,
    venue: "morpho_market",
    name: `${token.symbol} / USDC`,
    curator: def.ours ? "Front Run" : "Morpho",
    ours: def.ours,
    collateral: { ticker: token.ticker, symbol: token.symbol, name: token.name, address: token.address, decimals: token.decimals, priceUsd: price === null ? null : oraclePriceUsd(price, token.decimals) },
    lltv: Number(BigInt(def.lltv)) / 1e18,
    supplyApy: borrowApy === null ? null : borrowApy * utilization * (1 - fee),
    borrowApy,
    totalSupplyUsd: usd(state.totalSupplyAssets),
    totalBorrowUsd: usd(state.totalBorrowAssets),
    liquidityUsd: usd(state.totalSupplyAssets - state.totalBorrowAssets),
    utilization,
  };
}

/** Every lending market, with live rates. Cached for a minute, since rates move slowly. */
export async function lendingMarkets(): Promise<LendingMarketView[]> {
  return cachedJson("lending:markets:v1", 60, async () => {
    const [aave, vaults, stocks] = await Promise.all([
      readAave().catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : err }, "Aave read failed");
        return null;
      }),
      readVaults(),
      Promise.all(
        STOCK_MARKETS.map((m) =>
          readStockMarket(m).catch((err) => {
            logger.warn({ id: m.id, err: err instanceof Error ? err.message : err }, "Morpho market read failed");
            return null;
          }),
        ),
      ),
    ]);
    return [...(aave ? [aave] : []), ...vaults, ...stocks.filter((m): m is LendingMarketView => m !== null)];
  });
}

export async function lendingMarket(id: string): Promise<LendingMarketView | undefined> {
  const k = id.toLowerCase();
  return (await lendingMarkets()).find((m) => m.id.toLowerCase() === k);
}

export function stockMarketDef(id: string): StockMarketDef | undefined {
  const k = id.toLowerCase();
  return STOCK_MARKETS.find((m) => m.id.toLowerCase() === k);
}
