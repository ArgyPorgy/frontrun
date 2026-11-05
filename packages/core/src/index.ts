export * from "./chains";
export * from "./money";
export * from "./pnl";
export * from "./routing";
export * from "./thesis";
export * from "./risk";
export * from "./format";
export * from "./types";
export * from "./schemas";
export * from "./api";

export const APP_NAME = "Front Run";
export const COPY_BUY_CAP_USD = "100";
export const PAPER_STARTING_BALANCE_USD = "1000";
export const BUY_PRESETS_USD = [10, 25, 50, 100] as const;
export const SELL_PRESETS_PCT = [25, 50, 75, 100] as const;
