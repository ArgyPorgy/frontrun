import Decimal from "decimal.js";

Decimal.set({ precision: 60, rounding: Decimal.ROUND_DOWN, toExpNeg: -40, toExpPos: 60 });

export { Decimal };
export type Numeric = Decimal.Value;

/**
 * Arc exposes one USDC balance through two interfaces with different precision.
 * Everything in the app is in the ERC-20 unit (6 decimals). The native 18-decimal value
 * only appears in gas accounting and must pass through these helpers.
 */
export const USDC_ERC20_DECIMALS = 6;
export const ARC_NATIVE_DECIMALS = 18;
const NATIVE_TO_ERC20_FACTOR = 10n ** BigInt(ARC_NATIVE_DECIMALS - USDC_ERC20_DECIMALS);

/** Kept out of 'Max' buys so gas can always be paid from the same balance. $0.05. */
export const ARC_GAS_RESERVE_USDC6 = 50_000n;

export function D(value: Numeric | null | undefined): Decimal {
  return new Decimal(value ?? 0);
}

export function toBaseUnits(amount: Numeric, decimals: number): bigint {
  const scaled = D(amount).mul(D(10).pow(decimals)).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  return BigInt(scaled.toFixed(0));
}

export function fromBaseUnits(amount: bigint | string, decimals: number): string {
  return D(amount.toString()).div(D(10).pow(decimals)).toFixed();
}

export function arcNativeToUsdc6(nativeWei: bigint): bigint {
  return nativeWei / NATIVE_TO_ERC20_FACTOR;
}

export function usdc6ToArcNative(usdc6: bigint): bigint {
  return usdc6 * NATIVE_TO_ERC20_FACTOR;
}

/** What the 'Max' preset spends: the balance minus the gas reserve, never negative. */
export function maxSpendableUsdc6(balanceUsdc6: bigint, reserve: bigint = ARC_GAS_RESERVE_USDC6): bigint {
  return balanceUsdc6 > reserve ? balanceUsdc6 - reserve : 0n;
}

/** Keeps what someone types in an amount field to a plain decimal. Some keyboards only offer a comma. */
export function cleanAmountInput(raw: string, maxDecimals: number): string {
  const [whole = "", ...rest] = raw.replace(/,/g, ".").replace(/[^\d.]/g, "").split(".");
  const digits = whole.slice(0, 12);
  return rest.length ? `${digits}.${rest.join("").slice(0, maxDecimals)}` : digits;
}

/** The amount typed, or null while it's empty, unfinished or zero. */
export function parseAmountInput(text: string): Decimal | null {
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const value = new Decimal(text);
  return value.gt(0) ? value : null;
}

export function isPositiveDecimal(value: string): boolean {
  try {
    const d = new Decimal(value);
    return d.isFinite() && d.gt(0);
  } catch {
    return false;
  }
}
