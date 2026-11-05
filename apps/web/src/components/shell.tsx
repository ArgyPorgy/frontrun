"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useConfig, useMe } from "@/lib/hooks";
import { Avatar } from "./ui";

type IconName = "trending" | "search" | "portfolio" | "profile" | "bell";

function Icon({ name, active }: { name: IconName; active?: boolean }) {
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: active ? 2.2 : 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "trending":
      return (
        <svg {...common}>
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M15 7h6v6" />
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
  { href: "/", label: "Trending", icon: "trending", match: (p) => p === "/" || p.startsWith("/token") || p.startsWith("/thesis") || p.startsWith("/leaderboard") },
  { href: "/search", label: "Search", icon: "search", match: (p) => p.startsWith("/search") },
  { href: "/portfolio", label: "Portfolio", icon: "portfolio", match: (p) => p.startsWith("/portfolio") || p.startsWith("/deposit") },
  { href: "/profile", label: "Profile", icon: "profile", match: (p) => p.startsWith("/profile") || p.startsWith("/u/") || p.startsWith("/settings") },
];

function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="pad-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur md:inset-x-auto md:top-0 md:bottom-0 md:left-0 md:w-52 md:border-t-0 md:border-r md:pt-4"
    >
      <p className="hidden px-5 pb-5 text-lg font-semibold tracking-tight md:block">Front Run</p>
      <ul className="flex md:flex-col md:gap-1 md:px-2">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium md:flex-row md:gap-3 md:rounded-lg md:px-3 md:py-2.5 md:text-sm ${
                  active ? "text-ink md:bg-raised" : "text-faint hover:text-muted"
                }`}
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
  return (
    <header className="pad-top sticky top-0 z-20 border-b border-line/70 bg-bg/95 backdrop-blur">
      <div className="flex items-center gap-2.5 px-4 py-2">
        <Link href="/search" className="flex h-9 flex-1 items-center gap-2 rounded-xl bg-surface px-3 text-sm text-faint">
          <Icon name="search" />
          <span className="truncate">Search any token</span>
        </Link>
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

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:pl-52">
      <TabBar />
      <TopBar />
      <PaperBanner />
      <InstallHint />
      <main className="mx-auto max-w-5xl pb-[calc(env(safe-area-inset-bottom)+72px)] md:pb-10">{children}</main>
    </div>
  );
}
