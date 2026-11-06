"use client";

import { CHAIN_KEYS, CHAINS, formatPct, type TokenListItem } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ChainLogo, TokenIcon } from "@/components/ui";
import { WaybackInstall } from "@/components/wayback-install";

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className="text-signal">
        <path fill="currentColor" d="M13.5 2 4 13.5h6.2L9 22l10-12.5h-6.4L13.5 2Z" />
      </svg>
      <span className="font-display text-lg font-semibold tracking-tight">Front Run</span>
    </span>
  );
}

function Header() {
  const { login } = useAuth();
  return (
    <header className="sticky top-0 z-30 border-b border-line/50 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" aria-label="Front Run home">
          <Wordmark />
        </Link>
        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          <a href="#markets" className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:text-ink">
            Markets
          </a>
          <a href="#features" className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:text-ink">
            Features
          </a>
          <Link href="/analytics" className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:text-ink">
            Analytics
          </Link>
          <a href="#wayback" className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:text-ink">
            Install app
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <button onClick={login} className="hidden rounded-xl px-3 py-2 text-sm font-semibold text-muted hover:text-ink sm:block">
            Log in
          </button>
          <button onClick={login} className="rounded-xl bg-signal px-4 py-2 text-sm font-semibold text-signal-ink transition-opacity hover:opacity-90">
            Start trading
          </button>
        </div>
      </div>
    </header>
  );
}

function LiveTape() {
  const market = useQuery({
    queryKey: ["market", "trending", "all"],
    queryFn: () => api.marketList({ tab: "trending" }),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const items: TokenListItem[] = market.data?.items ?? [];
  if (items.length < 6) return null;
  const row = items.slice(0, 18);
  return (
    <div className="relative overflow-hidden border-y border-line/50 bg-surface/30 py-2.5">
      <div className="animate-tape flex w-max gap-7 pl-6">
        {[...row, ...row].map((t, i) => (
          <span key={`${t.chain}:${t.address}:${i}`} className="num flex items-center gap-2 text-sm whitespace-nowrap">
            <TokenIcon symbol={t.symbol} imageUrl={t.imageUrl} size={18} />
            <span className="font-semibold">{t.symbol}</span>
            <span className={t.priceChangePct.h24 >= 0 ? "text-up" : "text-down"}>{formatPct(t.priceChangePct.h24)}</span>
          </span>
        ))}
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-bg to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-bg to-transparent" />
    </div>
  );
}

function Hero() {
  const { login } = useAuth();
  return (
    <section className="relative isolate overflow-hidden">
      {/* Cosmic backdrop, layered from gradients and a gradient starfield — no image assets. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="starfield animate-float absolute inset-0 opacity-70" />
        <div className="absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(60%_80%_at_50%_-10%,rgba(200,241,53,0.16),transparent_70%)]" />
        <div className="absolute -bottom-40 left-1/2 h-[520px] w-[920px] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(50%_50%_at_50%_50%,rgba(91,141,239,0.18),transparent_70%)]" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-bg" />
      </div>

      <div className="mx-auto max-w-4xl px-4 pt-20 pb-14 text-center md:pt-28 md:pb-20">
        <span className="animate-rise inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3.5 py-1.5 text-xs font-medium text-muted">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
          </span>
          Non-custodial social trading, live on Arc
        </span>

        <h1 className="font-display animate-rise mx-auto mt-6 max-w-3xl text-balance text-[13vw] leading-[1.02] font-semibold tracking-tight sm:text-6xl md:text-7xl">
          Trade any token
          <br />
          <span className="text-signal">from one balance.</span>
        </h1>

        <p className="animate-rise mx-auto mt-5 max-w-xl text-pretty text-base text-muted md:text-lg">
          Buy on 8 chains from a single USDC balance on Arc — in one tap. Every thesis shows the author&apos;s real position, and whether they were right.
        </p>

        <div className="animate-rise mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            onClick={login}
            className="w-full rounded-xl bg-signal px-7 py-3.5 font-semibold text-signal-ink shadow-lg shadow-signal/20 transition-opacity hover:opacity-90 sm:w-auto"
          >
            Start trading
          </button>
          <Link
            href="/discovery"
            className="w-full rounded-xl border border-line bg-surface/60 px-7 py-3.5 text-center font-semibold text-ink transition-colors hover:bg-raised sm:w-auto"
          >
            Explore markets
          </Link>
        </div>

        <p className="animate-rise mt-6 text-sm text-faint">No seed phrases · No bridging · You hold the keys</p>
      </div>
    </section>
  );
}

function ChainsRow() {
  return (
    <section id="markets" className="mx-auto w-full max-w-5xl px-4 pb-4 pt-10">
      <p className="text-center text-xs font-medium tracking-wide text-faint uppercase">One USDC balance. Eight chains.</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
        {CHAIN_KEYS.map((chain) => (
          <span key={chain} className="flex items-center gap-2 text-sm text-muted">
            <ChainLogo chain={chain} size={22} />
            <span className="hidden sm:inline">{CHAINS[chain].name}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

function FeatureIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-bg text-signal">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </span>
  );
}

const FEATURES: Array<{ title: string; body: string; icon: ReactNode }> = [
  {
    title: "One balance, every chain",
    body: "Hold USDC on Arc and buy tokens across 8 chains. No bridging, no juggling gas, no wrapped detours.",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
      </>
    ),
  },
  {
    title: "Thesis you can trust",
    body: "Every post is pinned to the chart and shows the author's real position size — and whether the call paid off.",
    icon: (
      <>
        <path d="M3 17l6-6 4 4 8-8" />
        <path d="M15 7h6v6" />
      </>
    ),
  },
  {
    title: "Trade in one tap",
    body: "Approve once within your own limits, then every trade clears with no pop-ups. Non-custodial the whole way.",
    icon: (
      <>
        <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
      </>
    ),
  },
  {
    title: "Guardrails by default",
    body: "Price-impact checks, pool-share limits and risk flags run before anything is signed, so you never get trapped.",
    icon: (
      <>
        <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
];

function Features() {
  return (
    <section id="features" className="mx-auto w-full max-w-5xl px-4 py-16 md:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">Built for traders who do the work.</h2>
        <p className="mt-3 text-muted">Everything you need to find conviction, act on it fast, and stay in control of your funds.</p>
      </div>
      <div className="mt-12 grid gap-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-2xl border border-line bg-surface/60 p-6 transition-colors hover:border-line hover:bg-surface">
            <FeatureIcon>{f.icon}</FeatureIcon>
            <h3 className="mt-4 text-lg font-semibold tracking-tight">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const STEPS: Array<{ n: string; title: string; body: string }> = [
  { n: "01", title: "Sign in", body: "Google, email or wallet. A non-custodial wallet is created for you in seconds." },
  { n: "02", title: "Add USDC", body: "Fund one balance on Arc. That's all you need to trade anything, anywhere." },
  { n: "03", title: "Trade any token", body: "Search or tap a trending token and buy in one tap. Post your thesis if you want." },
];

function Steps() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-4">
      <div className="grid gap-4 md:grid-cols-3">
        {STEPS.map((s) => (
          <div key={s.n} className="rounded-2xl border border-line/70 bg-surface/40 p-6">
            <span className="num font-display text-2xl font-semibold text-signal">{s.n}</span>
            <h3 className="mt-3 font-semibold tracking-tight">{s.title}</h3>
            <p className="mt-1.5 text-sm text-muted">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  const { login } = useAuth();
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-20">
      <div className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-b from-surface to-bg p-10 text-center md:p-16">
        <div aria-hidden className="starfield pointer-events-none absolute inset-0 opacity-40" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-10 h-40 bg-[radial-gradient(50%_80%_at_50%_0,rgba(200,241,53,0.18),transparent)]" />
        <div className="relative">
          <h2 className="font-display text-3xl font-semibold tracking-tight md:text-5xl">Where traders become legends.</h2>
          <p className="mx-auto mt-3 max-w-md text-muted">Start from one USDC balance. Trade any token, back it with a thesis, and let your record speak.</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button onClick={login} className="w-full rounded-xl bg-signal px-7 py-3.5 font-semibold text-signal-ink transition-opacity hover:opacity-90 sm:w-auto">
              Start trading
            </button>
            <Link href="/discovery" className="w-full rounded-xl border border-line bg-surface/60 px-7 py-3.5 text-center font-semibold text-ink transition-colors hover:bg-raised sm:w-auto">
              Explore markets
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 md:flex-row md:items-center md:justify-between">
        <div className="max-w-sm">
          <Wordmark />
          <p className="mt-3 text-sm text-muted">Non-custodial social trading. Trade any token from one USDC balance on Arc.</p>
        </div>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
          <Link href="/discovery" className="hover:text-ink">
            Markets
          </Link>
          <Link href="/analytics" className="hover:text-ink">
            Analytics
          </Link>
          <Link href="/legal/terms" className="hover:text-ink">
            Terms
          </Link>
          <Link href="/legal/privacy" className="hover:text-ink">
            Privacy
          </Link>
          <Link href="/legal/risk" className="hover:text-ink">
            Risk
          </Link>
        </nav>
      </div>
      <p className="mx-auto max-w-6xl px-4 pb-10 text-xs text-faint">
        Trading involves risk, including the loss of principal. Nothing here is financial advice.
      </p>
    </footer>
  );
}

export function Landing() {
  return (
    <div className="min-h-dvh bg-bg text-ink">
      <Header />
      <main>
        <Hero />
        <LiveTape />
        <ChainsRow />
        <Features />
        <Steps />
        <WaybackInstall />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
