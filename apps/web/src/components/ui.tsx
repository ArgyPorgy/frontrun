"use client";

import { CHAINS, formatPct, type ChainKey, type UserSummary } from "@frontrun/core";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const AVATAR_PALETTE: Array<[string, string]> = [
  ["#c8f135", "#2f6b3a"],
  ["#5b8def", "#1d2c6b"],
  ["#ff8a5c", "#6b1d3a"],
  ["#f5b945", "#6b3a1d"],
  ["#35d990", "#124a4a"],
  ["#d38bff", "#3a1d6b"],
  ["#ff5d8f", "#5c1740"],
  ["#50e3c2", "#17415c"],
  ["#ffd166", "#5c3a17"],
  ["#9bb0ff", "#2b2f66"],
  ["#b7f06a", "#1f4d2c"],
  ["#ff9f9f", "#5c1f1f"],
];

export const AVATAR_CHOICES = AVATAR_PALETTE.map((_, i) => `gen:${i}`);

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

function GeneratedAvatar({ index, label, size }: { index: number; label: string; size: number }) {
  const [from, to] = AVATAR_PALETTE[index % AVATAR_PALETTE.length]!;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-black/80"
      style={{ width: size, height: size, background: `radial-gradient(circle at 30% 25%, ${from}, ${to})`, fontSize: size * 0.42 }}
      aria-hidden
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Avatar({ user, size = 32 }: { user: Pick<UserSummary, "username" | "avatarUrl">; size?: number }) {
  const url = user.avatarUrl;
  if (url?.startsWith("https://")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  const index = url?.startsWith("gen:") ? Number(url.slice(4)) : hashSeed(user.username);
  return <GeneratedAvatar index={index} label={user.username} size={size} />;
}

export function TokenIcon({ symbol, imageUrl, size = 36 }: { symbol: string; imageUrl: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (imageUrl && !failed) {
    return (
      // Token logos come from many hosts and are small, so optimizing them isn't worth a proxy.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full bg-raised object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-raised font-semibold text-muted"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
      aria-hidden
    >
      {symbol.slice(0, 3).toUpperCase()}
    </span>
  );
}

export function ChainLogo({ chain, size = 16 }: { chain: ChainKey; size?: number }) {
  return (
    // Fixed local files, small enough that an image optimizer would only add a round trip.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/chains/${chain}.webp`} alt={CHAINS[chain].name} width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  );
}

export function ChainBadge({ chain }: { chain: ChainKey }) {
  const info = CHAINS[chain];
  return (
    <span className="num inline-flex items-center gap-1 rounded-md bg-raised py-0.5 pr-1.5 pl-0.5 text-[10px] font-medium tracking-normal text-muted">
      <ChainLogo chain={chain} size={14} />
      {info.shortName}
    </span>
  );
}

export function Pct({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  const tone = value == null || value === 0 ? "text-muted" : value > 0 ? "text-up" : "text-down";
  return <span className={`num ${tone} ${className}`}>{formatPct(value)}</span>;
}

/** Flashes green or red briefly when the number moves. */
export function LiveNumber({ value, numeric, className = "" }: { value: string; numeric: number | null; className?: string }) {
  const last = useRef(numeric);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (numeric === null || last.current === null || numeric === last.current) {
      last.current = numeric;
      return;
    }
    setFlash(numeric > last.current ? "up" : "down");
    last.current = numeric;
    const timer = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(timer);
  }, [numeric]);
  return <span className={`num ${className} ${flash === "up" ? "animate-flash-up" : flash === "down" ? "animate-flash-down" : ""}`}>{value}</span>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-shimmer rounded-lg bg-raised ${className}`} />;
}

export function RowSkeletons({ count = 8 }: { count?: number }) {
  return (
    <div className="divide-y divide-line/60">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="ml-auto h-3.5 w-16" />
            <Skeleton className="ml-auto h-3 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="font-semibold">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-xs text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose(): void; title?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  // At the top of the page, so the chart's own layers or a parent's blur can never sit over it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end bg-black/80 md:items-center md:justify-center" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-sheet max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] border-t border-line bg-surface md:max-w-md md:rounded-[20px] md:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-line md:hidden" />
        {title && <h2 className="px-5 pt-3 text-lg font-semibold">{title}</h2>}
        <div className="px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+20px)]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = "",
}: {
  options: Array<{ value: NoInfer<T>; label: string }>;
  value: T;
  onChange(value: NoInfer<T>): void;
  className?: string;
}) {
  return (
    <div className={`no-scrollbar flex gap-1 overflow-x-auto ${className}`} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
            o.value === value ? "bg-ink text-bg" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PillFilter<T extends string | number>({
  options,
  value,
  onChange,
  className = "",
}: {
  options: Array<{ value: NoInfer<T>; label: string; icon?: ReactNode }>;
  value: T;
  onChange(value: NoInfer<T>): void;
  className?: string;
}) {
  return (
    <div className={`no-scrollbar flex gap-1.5 overflow-x-auto ${className}`}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
            o.value === value ? "border-ink/50 bg-raised text-ink" : "border-line text-muted hover:text-ink"
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-signal text-signal-ink",
    secondary: "bg-raised text-ink border border-line",
    ghost: "text-muted hover:text-ink",
    danger: "bg-raised text-down border border-line",
  }[variant];
  return (
    <button {...props} className={`rounded-xl px-4 py-2.5 font-semibold transition-opacity disabled:opacity-40 ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "primary", className = "" }: { href: string; children: ReactNode; variant?: "primary" | "secondary"; className?: string }) {
  const styles = variant === "primary" ? "bg-signal text-signal-ink" : "bg-raised text-ink border border-line";
  return (
    <Link href={href} className={`inline-block rounded-xl px-4 py-2.5 text-center font-semibold ${styles} ${className}`}>
      {children}
    </Link>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <p className="num mt-0.5 truncate font-medium">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`rounded-lg bg-raised px-2.5 py-1 text-xs font-medium text-ink ${className}`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function PageTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-2">
      <h1 className="text-xl font-semibold tracking-tight">{children}</h1>
      {right}
    </div>
  );
}
