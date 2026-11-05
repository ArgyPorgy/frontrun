import { D, type Numeric } from "./money";

export type RiskCode =
  | "flash_flagged"
  | "low_liquidity"
  | "new_pool"
  | "holder_concentration"
  | "thin_volume"
  | "sell_pressure";

export interface RiskFlag {
  code: RiskCode;
  label: string;
  severity: "high" | "medium";
  detail: string;
}

export interface RiskInput {
  flashRiskFlagged: boolean;
  liquidityUsd: Numeric | null;
  volume24hUsd: Numeric | null;
  pairCreatedAt: number | null;
  /** Percent of supply held by the top 10 wallets, when a source reports it. */
  top10HolderPct: number | null;
  buys24h: number | null;
  sells24h: number | null;
  now?: number;
}

export function computeRiskFlags(input: RiskInput): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const now = input.now ?? Date.now();

  if (input.flashRiskFlagged) {
    flags.push({
      code: "flash_flagged",
      label: "Flagged",
      severity: "high",
      detail: "Flash reports risk indicators such as thin liquidity or deployer-held supply.",
    });
  }
  if (input.liquidityUsd !== null && D(input.liquidityUsd).lt(10_000)) {
    flags.push({
      code: "low_liquidity",
      label: "Low liquidity",
      severity: "high",
      detail: "Under $10K in the top pool. Even small trades will move the price.",
    });
  }
  if (input.top10HolderPct !== null && input.top10HolderPct > 50) {
    flags.push({
      code: "holder_concentration",
      label: "Concentrated",
      severity: "high",
      detail: `The top 10 wallets hold ${input.top10HolderPct.toFixed(0)}% of supply.`,
    });
  }
  if (input.pairCreatedAt !== null && now - input.pairCreatedAt < 24 * 3600 * 1000) {
    flags.push({
      code: "new_pool",
      label: "New",
      severity: "medium",
      detail: "The pool is less than a day old.",
    });
  }
  if (input.volume24hUsd !== null && D(input.volume24hUsd).lt(1_000)) {
    flags.push({
      code: "thin_volume",
      label: "Thin volume",
      severity: "medium",
      detail: "Under $1K traded in the last 24 hours.",
    });
  }
  if (input.buys24h !== null && input.sells24h !== null && input.sells24h > 20 && input.buys24h === 0) {
    flags.push({
      code: "sell_pressure",
      label: "No buys",
      severity: "high",
      detail: "Sells but no buys in 24 hours, which can mean buyers can't sell.",
    });
  }
  return flags;
}
