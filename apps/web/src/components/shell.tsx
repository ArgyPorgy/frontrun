"use client";

import { APP_NAME, D, formatUsd } from "@frontrun/core";
import { Wordmark } from "./brand";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBalance, useConfig, useMe } from "@/lib/hooks";
import { Avatar } from "./ui";
import { Footer } from "./footer";

type IconName = "trending" | "search" | "portfolio" | "profile" | "bell" | "analytics" | "agents";

function Icon({ name, active }: { name: IconName; active?: boolean }) {
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: active ? 2.2 : 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "agents":
      return (
        <svg {...common}>
          <rect x="4" y="8" width="16" height="12" rx="3" />
          <path d="M12 8V4M9 13h.01M15 13h.01M9 17h6" />
        </svg>
      );
    case "trending":
      return (
        <svg {...common}>
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M15 7h6v6" />
        </svg>
      );
    case "analytics":
      return (
        <svg {...common}>
          <path d="M5 20v-7" />
          <path d="M12 20V5" />
          <path d="M19 20v-11" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      );
    case "portfolio":
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="13" rx="2.5" />
          <path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V7" />
          <path d="M3 13h18" />
        </svg>
      );
    case "profile":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      );
    case "bell":
      return (
        <svg {...common}>
          <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      );
  }
}

const TABS: Array<{ href: string; label: string; icon: IconName; match: (p: string) => boolean }> = [
  { href: "/discovery", label: "Discover", icon: "trending", match: (p) => p === "/discovery" || p.startsWith("/token") || p.startsWith("/thesis") || p.startsWith("/leaderboard") },
  { href: "/search", label: "Search", icon: "search", match: (p) => p.startsWith("/search") },
  { href: "/portfolio", label: "Portfolio", icon: "portfolio", match: (p) => p.startsWith("/portfolio") || p.startsWith("/deposit") },
  { href: "/agents", label: "Agents", icon: "agents", match: (p) => p.startsWith("/agents") },
  { href: "/analytics", label: "Analytics", icon: "analytics", match: (p) => p.startsWith("/analytics") },
  { href: "/profile", label: "Profile", icon: "profile", match: (p) => p.startsWith("/profile") || p.startsWith("/u/") || p.startsWith("/settings") },
];

function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="pad-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur md:hidden"
    >
      <ul className="flex">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active ? "text-ink" : "text-faint hover:text-muted"}`}
              >
                <Icon name={tab.icon} active={active} />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const WIDE_NAV: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  { href: "/discovery", label: "Discover", match: (p) => p === "/discovery" || p.startsWith("/token") || p.startsWith("/thesis") },
  { href: "/portfolio", label: "Portfolio", match: (p) => p.startsWith("/portfolio") },
  { href: "/leaderboard", label: "Leaderboard", match: (p) => p.startsWith("/leaderboard") },
  { href: "/agents", label: "Agents", match: (p) => p.startsWith("/agents") },
  { href: "/analytics", label: "Analytics", match: (p) => p.startsWith("/analytics") },
];

function Logo() {
  return (
    <Link href="/discovery" className="hidden shrink-0 items-center gap-2 md:flex" aria-label={APP_NAME}>
      <Wordmark />
    </Link>
  );
}

/** Cash to trade with, and what's in positions, always in view on a wide screen. */
function WalletPills() {
  const { status } = useAuth();
  const balance = useBalance();
  const portfolio = useQuery({ queryKey: ["portfolio"], queryFn: () => api.portfolio(), enabled: status === "in", refetchInterval: 30_000 });
  if (status !== "in") return null;
  const allTime = portfolio.data ? D(portfolio.data.totals.allTimeUsd) : null;
  return (
    <div className="hidden shrink-0 items-stretch gap-2 md:flex">
      <div className="flex h-10 flex-col items-end justify-center rounded-xl bg-surface px-3 leading-tight">
        <span className="num text-sm font-medium">
          {formatUsd(balance.data?.usdc)}
        </span>
        <Link href="/deposit" className="text-xs font-medium text-signal">
          Deposit
        </Link>
      </div>
      <Link href="/portfolio" className="flex h-10 flex-col items-end justify-center rounded-xl bg-surface px-3 leading-tight">
        <span className="num text-sm font-medium">{formatUsd(portfolio.data?.totals.valueUsd)}</span>
        <span className={`num text-xs ${allTime === null ? "text-faint" : allTime.gte(0) ? "text-up" : "text-down"}`}>{allTime === null ? "—" : `${formatUsd(allTime.toFixed(), { sign: true })}`}</span>
      </Link>
    </div>
  );
}

/** A search bar on every page, as the plan asks. It's a link so it stays light on each screen. */
function TopBar() {
  const { status, login } = useAuth();
  const me = useMe();
  const notifications = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.notifications(),
    enabled: status === "in",
    refetchInterval: 60_000,
  });
  const unread = notifications.data?.unread ?? 0;
  const pathname = usePathname();
  return (
    <header className="pad-top sticky top-0 z-20 border-b border-line/70 bg-bg/95 backdrop-blur">
      <div className="flex items-center gap-2.5 px-4 py-2 md:gap-4">
        <Logo />
        <nav aria-label="Main" className="hidden shrink-0 items-center gap-1 md:flex">
          {WIDE_NAV.map((item) => (
            <Link key={item.href} href={item.href} className={`rounded-lg px-2.5 py-1.5 text-sm font-medium ${item.match(pathname) ? "text-ink" : "text-muted hover:text-ink"}`}>
              {item.label}
            </Link>
          ))}
        </nav>
        <Link href="/search" className="flex h-9 flex-1 items-center gap-2 rounded-xl bg-surface px-3 text-sm text-faint md:h-10">
          <Icon name="search" />
          <span className="truncate">Search tokens, CA, traders</span>
        </Link>
        <WalletPills />
        {status === "in" ? (
          <>
            <Link href="/notifications" aria-label={unread ? `${unread} unread notifications` : "Notifications"} className="relative flex h-9 w-9 items-center justify-center text-muted">
              <Icon name="bell" />
              {unread > 0 && <span className="num absolute top-0.5 right-0 rounded-full bg-signal px-1 text-[10px] leading-4 font-semibold text-signal-ink">{unread > 9 ? "9+" : unread}</span>}
            </Link>
            {me.data && (
              <Link href="/profile" aria-label="Your profile">
                <Avatar user={me.data} size={30} />
              </Link>
            )}
          </>
        ) : status === "out" ? (
          <button onClick={login} className="h-9 rounded-xl bg-signal px-3 text-sm font-semibold text-signal-ink">
            Sign in
          </button>
        ) : null}
      </div>
    </header>
  );
}

function PaperBanner() {
  const config = useConfig();
  if (config.tradingMode !== "paper") return null;
  return (
    <div className="border-b border-warn/25 bg-warn/10 px-4 py-1 text-center text-xs font-medium text-warn">
      Paper trading: live prices and real routes, simulated fills, no real funds.
    </div>
  );
}

interface InstallEvent extends Event {
  prompt(): Promise<void>;
}

/** Add to Home Screen: Android gets the native prompt, iOS gets the Share-sheet hint. */
function InstallHint() {
  const [androidEvent, setAndroidEvent] = useState<InstallEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem("frontrun.installDismissed") === "1";
    } catch {
      // Private mode: fall through and show the hint.
    }
    if (dismissed || window.matchMedia("(display-mode: standalone)").matches) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setAndroidEvent(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) && !/CriOS|FxiOS/.test(ua)) setIosHint(true);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const dismiss = () => {
    setAndroidEvent(null);
    setIosHint(false);
    try {
      localStorage.setItem("frontrun.installDismissed", "1");
    } catch {
      // Nothing to do: it just shows again next visit.
    }
  };

  if (!androidEvent && !iosHint) return null;
  return (
    <div className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-sm">
      <p className="flex-1 text-muted">
        {androidEvent ? "Install the app for alerts and faster trading." : "Tap Share, then Add to Home Screen, to install and get alerts."}
      </p>
      {androidEvent && (
        <button onClick={() => void androidEvent.prompt().then(dismiss)} className="font-semibold text-signal">
          Install
        </button>
      )}
      <button onClick={dismiss} aria-label="Dismiss" className="px-1 text-faint">
        ✕
      </button>
    </div>
  );
}

/** Arc Studio's own watermark: same label, logo, link and look. It floats on a wide screen, but on a phone it would cover the tab bar, so it ends the page there, except on a token page, where the trade bar would sit on top of it. */
export function ArcStudioBadge() {
  const pathname = usePathname();
  const display = pathname.startsWith("/token/") ? "hidden md:flex" : "flex";
  return (
    <a
      href="https://studio.arc.io/"
      target="_blank"
      rel="noopener noreferrer"
      className={`${display} mx-auto mb-4 mt-8 w-fit items-center gap-1.5 rounded-[20px] border border-white/40 bg-[rgba(172,198,233,0.85)] px-3.5 py-2 font-sans text-xs font-semibold text-[#1B3158] no-underline shadow-[0_4px_20px_rgba(27,49,88,0.15),inset_0_1px_0_rgba(255,255,255,0.5)] backdrop-blur-md backdrop-saturate-[1.8] md:fixed md:bottom-14 md:right-4 md:z-40 md:m-0`}
    >
      <svg width="14" height="16" viewBox="0 0 20 22" fill="none" aria-hidden="true">
        <path
          d="M0 21.5001C0.167192 16.2366 1.02308 11.3243 2.45378 7.50459C4.26573 2.66517 6.88869 0 9.83904 0C12.7894 0 15.412 2.66517 17.2243 7.50459C18.1669 10.0216 18.8605 13.0121 19.2713 16.2655C19.3081 16.556 19.3393 16.8513 19.3714 17.146C19.3819 17.1642 19.3881 17.1811 19.386 17.1949C19.386 17.1949 19.6275 18.7674 19.6788 21.5001H19.6515C19.2934 21.1937 15.0694 17.7329 8.06739 18.735C8.17304 17.4996 8.31833 16.2974 8.50603 15.1452C8.51562 15.0863 8.52671 15.0294 8.53649 14.9709C11.2828 14.8846 13.6866 15.2171 15.5299 15.6529C15.5231 15.6073 15.5173 15.5603 15.5103 15.5149C15.1314 13.0547 14.5724 10.8024 13.8517 8.87761C12.6732 5.73037 11.1354 3.77496 9.83904 3.77496C8.54269 3.77496 7.00493 5.73037 5.82649 8.87761C5.54123 9.63889 5.28154 10.4508 5.04866 11.3071C4.72126 12.507 4.44621 13.7934 4.22654 15.1451C3.90141 17.1412 3.69827 19.2821 3.62345 21.5001H0Z"
          fill="currentColor"
        />
      </svg>
      Built with Arc Studio
    </a>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The marketing landing owns the whole screen with its own header and footer, so the app
  // chrome steps aside there. Everything else gets the standard shell.
  if (pathname === "/") return <>{children}</>;
  // The discovery and token pages run edge to edge on a wide screen, with their own column layouts.
  const wideHome = pathname === "/discovery" || pathname.startsWith("/token/");
  return (
    <div className="min-h-dvh">
      <TabBar />
      <TopBar />
      <PaperBanner />
      <InstallHint />
      <main className={`mx-auto max-w-5xl pb-[calc(env(safe-area-inset-bottom)+72px)] md:pb-12 ${wideHome ? "lg:max-w-none lg:pb-0" : ""}`}>
        {children}
        <ArcStudioBadge />
      </main>
      <Footer />
    </div>
  );
}
