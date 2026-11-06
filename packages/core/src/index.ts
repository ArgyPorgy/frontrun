export * from "./chains";
export * from "./money";
export * from "./pnl";
export * from "./routing";
export * from "./thesis";
export * from "./proof";
export * from "./reputation";
export * from "./risk";
export * from "./format";
export * from "./types";
export * from "./schemas";
export * from "./api";

export const APP_NAME = "Front Run";
export const COPY_BUY_CAP_USD = "100";
/** Copy trading's limits. The per-trade cap matches copy buys, so followers can't become one trader's exit liquidity. */
export const COPY_TRADE_MAX_USD = COPY_BUY_CAP_USD;
export const COPY_DAILY_MAX_USD = "1000";
export const COPY_MIN_USD = "1";
export const COPY_DEFAULT_AMOUNT_USD = "25";
export const COPY_DEFAULT_DAILY_USD = "250";
/** Who can turn copying on while it's being tried out with small amounts. Lowercase usernames. */
export const COPY_TRADING_BETA: readonly string[] = ["argyporgy", "sayan"];
export const PAPER_STARTING_BALANCE_USD = "1000";
export const BUY_PRESETS_USD = [10, 25, 50, 100] as const;
export const SELL_PRESETS_PCT = [25, 50, 75, 100] as const;
