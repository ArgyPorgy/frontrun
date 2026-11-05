import { D, type Numeric } from "./money";

export function formatUsd(value: Numeric | null | undefined, opts: { sign?: boolean } = {}): string {
  if (value === null || value === undefined) return "—";
  const n = D(value).toNumber();
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1 || abs === 0 ? 2 : abs >= 0.01 ? 4 : 6;
  const body = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
  const sign = n < 0 ? "-" : opts.sign && n > 0 ? "+" : "";
  return `${sign}$${body}`;
}

export function formatCompactUsd(value: Numeric | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = D(value).toNumber();
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(abs >= 1 ? 0 : 2)}`;
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/** Token prices span many magnitudes. Small ones use the 0.0₄123 form traders expect. */
export function formatPrice(value: Numeric | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = D(value).toNumber();
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (n >= 0.0001) return `$${n.toPrecision(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  const fixed = D(value).toFixed(30);
  const match = fixed.match(/^0\.(0+)(\d{1,4})/);
  if (!match) return `$${n.toExponential(2)}`;
  const zeros = String(match[1]!.length)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
  return `$0.0${zeros}${match[2]!.replace(/0+$/, "")}`;
}

export function formatPct(value: number | null | undefined, opts: { sign?: boolean } = { sign: true }): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = opts.sign && value > 0 ? "+" : "";
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatQty(value: Numeric | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = D(value).toNumber();
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return n.toPrecision(3);
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString("en-US");
}

export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars + (address.startsWith("0x") ? 2 : 0))}…${address.slice(-chars)}`;
}

export function timeAgo(from: string | number | Date, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}
