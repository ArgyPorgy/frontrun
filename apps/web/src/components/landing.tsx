"use client";

import { formatPct, type BasketToken, type TrackerPostView } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark, Wordmark } from "@/components/brand";
import { ArcStudioBadge } from "@/components/shell";
import { TokenIcon } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const CARD_LABEL = "num text-[11px] tracking-[0.14em] uppercase";

function Header() {
  const { login } = useAuth();
  return (
    <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
      <Link href="/" aria-label="Front Run home">
        <Wordmark />
      </Link>
      <button onClick={login} className="font-display rounded-full border border-line bg-raised px-4 py-2 text-sm font-semibold transition-colors hover:border-faint">
        launch app
      </button>
    </header>
  );
}

function useVoices() {
  return useQuery({ queryKey: ["landing", "voices"], queryFn: () => api.landingVoices(), refetchInterval: 120_000, staleTime: 60_000 }).data;
}

function useBasket(): BasketToken[] {
  return useQuery({ queryKey: ["market", "basket"], queryFn: () => api.marketBasket(), refetchInterval: 60_000, staleTime: 30_000 }).data?.items ?? [];
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function PostAvatar({ post, size }: { post: TrackerPostView; size: number }) {
  if (!post.authorAvatar) return <span className="flex shrink-0 items-center justify-center rounded-full bg-raised text-xs font-bold" style={{ width: size, height: size }}>{post.authorName.slice(0, 1)}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={post.authorAvatar} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
}

function HeroArt() {
  const voices = useVoices();
  const post = voices?.named.theunipcs ?? voices?.named.frankdegods ?? voices?.recent[0];
  return (
    <div className="relative mx-auto aspect-[10/9] w-full max-w-[560px]">
      <div aria-hidden className="absolute inset-0">
        <div className="absolute top-[8%] left-[6%] h-[70%] w-[62%] rounded-full bg-up/25 blur-[70px]" />
        <div className="absolute top-[24%] right-0 h-[66%] w-[50%] rounded-full bg-cyan/25 blur-[70px]" />
        {[32, 46, 60].map((top, i) => (
          <div key={top} className="absolute left-[2%] h-[3px] rounded-full bg-gradient-to-r from-transparent to-signal/70" style={{ top: `${top}%`, width: i === 1 ? "28%" : "22%", marginLeft: i === 1 ? "6%" : 0 }} />
        ))}
        <div className="animate-float absolute top-[20%] left-[28%] w-[64%] drop-shadow-[0_0_34px_rgba(109,234,178,0.55)]">
          <LogoMark width={1000} className="h-auto w-full" />
        </div>
        <svg viewBox="0 0 520 170" className="absolute right-0 bottom-[4%] w-full" fill="none">
          <defs>
            <linearGradient id="hero-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5ac4f1" stopOpacity="0.28" />
              <stop offset="1" stopColor="#5ac4f1" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M0 150 52 138 104 148 156 118 208 126 260 92 312 100 364 62 416 34 520 10V170H0Z" fill="url(#hero-area)" />
          <path d="M0 150 52 138 104 148 156 118 208 126 260 92 312 100 364 62 416 34 520 10" stroke="#5ac4f1" strokeWidth="3" strokeLinejoin="round" />
        </svg>
        <div className="absolute right-[2%] bottom-[24%] rounded-2xl border border-line bg-surface/95 px-3 py-2">
          <span className="num block text-[10px] text-muted">example: copied it early</span>
          <span className="font-display text-brand block text-xl font-bold">+424%</span>
        </div>
      </div>
      {post && (
        <a href={post.url} target="_blank" rel="noreferrer noopener" className="absolute top-[2%] left-[2%] flex max-w-[86%] items-center gap-2.5 rounded-2xl border border-cyan/40 bg-surface/90 px-3 py-2 transition-colors hover:border-cyan">
          <PostAvatar post={post} size={32} />
          <span className="min-w-0">
            <span className="num block truncate text-[10px] text-muted">@{post.authorHandle} posted this</span>
            <span className="block truncate text-xs font-semibold">&ldquo;{short(post.body, 70)}&rdquo;</span>
          </span>
        </a>
      )}
    </div>
  );
}

function Hero() {
  const { login } = useAuth();
  return (
    <section className="relative mx-auto grid max-w-6xl items-center gap-6 px-5 pt-6 pb-10 md:grid-cols-2 md:pt-10 md:pb-16">
      <div className="animate-rise">
        <h1 className="font-display text-[46px] leading-[1.02] font-bold tracking-tight md:text-[68px]">
          frontrun your favourite <span className="text-brand">traders.</span>
        </h1>
        <p className="font-display mt-5 max-w-sm text-lg text-muted">trade everything, from stocks to memes. all in one place.</p>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <button onClick={login} className="font-display rounded-full bg-signal px-8 py-3.5 font-semibold text-signal-ink shadow-[0_0_34px_rgba(109,234,178,0.35)] transition-opacity hover:opacity-90">
            start trading
          </button>
          <a href="#inside" className="font-display rounded-full border border-line bg-raised px-8 py-3.5 text-center font-semibold transition-colors hover:border-faint">
            see what&apos;s inside
          </a>
        </div>
      </div>
      <HeroArt />
    </section>
  );
}

/** A real mix of stocks, big coins, memes and whatever's trending, with their actual logos and moves. */
function LiveTape() {
  const row = useBasket().filter((t) => t.group !== "currency");
  if (row.length < 6) return null;
  return (
    <div className="tape-hover relative overflow-hidden border-y border-line/50 py-3">
      <div className="animate-tape flex w-max">
        {[...row, ...row].map((t, i) => (
          <Link key={`${t.chain}:${t.address}:${i}`} href={`/token/${t.chain}/${t.address}`} className="num mr-2.5 flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-3 pl-1.5 text-xs whitespace-nowrap transition-colors hover:border-faint">
            <TokenIcon symbol={t.symbol} imageUrl={t.imageUrl} size={22} eager />
            <span className="font-semibold">{t.symbol}</span>
            <span className={t.change24h >= 0 ? "text-up" : "text-down"}>{formatPct(t.change24h)}</span>
          </Link>
        ))}
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-bg to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-bg to-transparent" />
    </div>
  );
}

const GLOWS = {
  "top-left": "-top-20 -left-20 bg-up/25",
  "top-right": "-top-20 -right-20 bg-cyan/20",
  "bottom-center": "-bottom-28 left-1/3 bg-cyan/15",
  "bottom-right": "-right-20 -bottom-24 bg-up/20",
  "bottom-left": "-bottom-24 -left-20 bg-cyan/20",
} as const;

function FeatureCard(props: { eyebrow: string; tone: "mint" | "blue"; title: ReactNode; body: string; art: ReactNode; artFirst?: boolean; glow: keyof typeof GLOWS; badge?: string; live?: boolean }) {
  return (
    <section className="rounded-[28px] bg-gradient-to-br from-up/50 via-line/60 to-cyan/50 p-px">
      <div className="relative grid items-center gap-8 overflow-hidden rounded-[27px] bg-[#09090c] p-6 md:grid-cols-2 md:gap-10 md:p-10">
        <div aria-hidden className={`pointer-events-none absolute h-72 w-72 rounded-full blur-[70px] ${GLOWS[props.glow]}`} />
        <div className={`relative ${props.artFirst ? "md:order-2" : ""}`}>
          <p className={`${CARD_LABEL} flex flex-wrap items-center gap-2 ${props.tone === "mint" ? "text-signal" : "text-cyan"}`}>
            {props.eyebrow}
            {props.badge && <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] text-ink normal-case">{props.badge}</span>}
          </p>
          <h2 className="font-display mt-3 text-[34px] leading-[1.05] font-bold tracking-tight md:text-[42px]">{props.title}</h2>
          <p className="font-display mt-3 max-w-md text-muted">{props.body}</p>
        </div>
        <div aria-hidden={props.live ? undefined : true} className={`relative min-w-0 ${props.artFirst ? "md:order-1" : ""}`}>
          {props.art}
        </div>
      </div>
    </section>
  );
}

function AlphaFeedArt() {
  const voices = useVoices();
  const posts = [voices?.named.frankdegods, voices?.named.iruletrenches, voices?.named.theunipcs, ...(voices?.recent ?? [])].filter((p): p is TrackerPostView => !!p).slice(0, 2);
  return (
    <div className="space-y-2.5">
      {posts.map((post) => (
        <a key={post.id} href={post.url} target="_blank" rel="noreferrer noopener" className="block rounded-2xl bg-raised p-3.5 transition-colors hover:bg-line/60">
          <div className="flex items-center gap-2.5">
            <PostAvatar post={post} size={28} />
            <span className="truncate text-sm font-semibold">@{post.authorHandle}</span>
            <span className="num ml-auto shrink-0 rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] uppercase">𝕏 live</span>
          </div>
          <p className="mt-2 text-sm">{short(post.body, 110)}</p>
        </a>
      ))}
      <div className="rounded-2xl bg-raised p-3.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan text-xs font-bold text-signal-ink">A</span>
          <span className="text-sm font-semibold">Arc Alpha Group</span>
          <span className="num ml-auto rounded-full bg-cyan/20 px-2 py-0.5 text-[10px] text-cyan uppercase">telegram</span>
        </div>
        <p className="mt-2 text-sm">early call: new meme on Base, liquidity locked.</p>
      </div>
    </div>
  );
}

function SafetyNetArt() {
  return (
    <div className="rounded-2xl border border-line bg-[#060608] p-3">
      <div className="relative overflow-hidden rounded-xl">
        <svg viewBox="0 0 400 240" className="w-full" fill="none">
          <defs>
            <linearGradient id="net-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5ac4f1" stopOpacity="0.32" />
              <stop offset="1" stopColor="#5ac4f1" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="net-line" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#5ac4f1" />
              <stop offset="1" stopColor="#6deab2" />
            </linearGradient>
          </defs>
          <rect width="400" height="48" fill="#35db98" fillOpacity="0.1" />
          <rect y="196" width="400" height="44" fill="#eb5271" fillOpacity="0.1" />
          <path d="M0 48H400" stroke="#35db98" strokeWidth="2" strokeDasharray="4 5" />
          <path d="M0 140H400" stroke="#8d9299" strokeOpacity="0.5" strokeDasharray="4 5" />
          <path d="M0 196H400" stroke="#eb5271" strokeWidth="1.5" strokeDasharray="4 5" />
          <path d="M0 128 50 142 80 148 110 142 150 118 190 126 230 92 270 98 310 70 345 76 380 50V240H0Z" fill="url(#net-area)" />
          <path d="M0 128 50 142 80 148 110 142 150 118 190 126 230 92 270 98 310 70 345 76 380 50" stroke="url(#net-line)" strokeWidth="3" strokeLinejoin="round" />
          <circle cx="80" cy="148" r="7" fill="#050507" stroke="#f5f4f7" strokeWidth="2.5" />
          <circle cx="380" cy="50" r="13" stroke="#6deab2" strokeOpacity="0.4" strokeWidth="2" />
          <circle cx="380" cy="50" r="7" fill="#6deab2" />
          <text x="10" y="32" fill="#6deab2" fontFamily="monospace" fontSize="14">TAKE PROFIT +60%</text>
          <text x="10" y="124" fill="#f5f4f7" fontFamily="monospace" fontSize="13">LIMIT BUY · FILLED</text>
          <text x="10" y="224" fill="#eb5271" fontFamily="monospace" fontSize="14">STOP LOSS -10%</text>
        </svg>
      </div>
      <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-up/30 bg-up/10 px-3 py-2 text-xs font-semibold">
        <span className="text-up">✓</span> position protected
      </div>
    </div>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 ${on ? "justify-end bg-signal" : "justify-start bg-line"}`}>
      <span className="h-5 w-5 rounded-full bg-ink" />
    </span>
  );
}

function AutoCopyArt() {
  const rows = [
    { initial: "AI", tile: "bg-gradient-to-br from-signal to-cyan text-signal-ink", name: "momentum bot", detail: "AI bot · $50 per trade", gain: "+31%", on: true },
    { initial: "SM", tile: "bg-up/20 text-signal", name: "smart money bot", detail: "AI bot · $100 per trade", gain: "+64%", on: true },
    { initial: "ST", tile: "bg-line text-muted", name: "stocks bot", detail: "AI bot · paused", gain: "+12%", on: false },
  ];
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.name} className={`flex items-center gap-3 rounded-2xl border p-3 ${r.on ? "border-up/30 bg-raised" : "border-transparent bg-raised/70"}`}>
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${r.tile}`}>{r.initial}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{r.name}</span>
            <span className="block truncate text-xs text-muted">{r.detail}</span>
          </span>
          <span className={`num text-xs ${r.on ? "text-up" : "text-muted"}`}>{r.gain}</span>
          <Toggle on={r.on} />
        </div>
      ))}
    </div>
  );
}

function ReputationArt() {
  const others = [
    { rank: "02", name: "runner-up", score: 84, tone: "from-signal to-cyan" },
    { rank: "03", name: "third place", score: 79, tone: "from-signal to-cyan" },
    { rank: "—", name: "the loudest account", score: 22, tone: "from-down to-down" },
  ];
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-5 rounded-2xl bg-raised p-4">
        <div className="relative h-16 w-28 shrink-0">
          <svg viewBox="0 0 120 68" className="w-full" fill="none">
            <defs>
              <linearGradient id="gauge" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stopColor="#5ac4f1" />
                <stop offset="1" stopColor="#6deab2" />
              </linearGradient>
            </defs>
            <path d="M8 62a52 52 0 0 1 104 0" stroke="#24262c" strokeWidth="9" strokeLinecap="round" />
            <path d="M8 62a52 52 0 0 1 100-20" stroke="url(#gauge)" strokeWidth="9" strokeLinecap="round" />
          </svg>
          <span className="font-display absolute inset-x-0 bottom-0 text-center text-2xl font-semibold">92</span>
        </div>
        <div className="min-w-0">
          <p className="font-semibold">top of the board</p>
          <p className="text-xs text-muted">reputation score</p>
          <p className="num mt-1 text-[11px] text-signal">TOP 1% · 41 RIGHT CALLS</p>
        </div>
      </div>
      {others.map((o) => (
        <div key={o.name} className="flex items-center gap-3 rounded-xl bg-raised px-3.5 py-2.5">
          <span className="num w-5 text-xs text-muted">{o.rank}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{o.name}</span>
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line">
            <span className={`block h-full rounded-full bg-gradient-to-r ${o.tone}`} style={{ width: `${o.score}%` }} />
          </span>
          <span className={`num w-6 text-right text-sm ${o.score < 50 ? "text-down" : ""}`}>{o.score}</span>
        </div>
      ))}
    </div>
  );
}

function PortfolioArt() {
  const legend = [
    { label: "stocks 47%", color: "bg-signal", width: 47 },
    { label: "crypto 36%", color: "bg-cyan", width: 36 },
    { label: "currency 8%", color: "bg-ink/80", width: 8 },
    { label: "memes 7%", color: "bg-[#a8f0d0]", width: 7 },
  ];
  const rows = [
    { symbol: "NVDA", kind: "stock", value: "$4,820", change: "+12.4%", tint: "text-signal" },
    { symbol: "TSLA", kind: "stock", value: "$2,140", change: "+4.2%", tint: "text-signal" },
    { symbol: "BTC", kind: "crypto", value: "$3,900", change: "+8.1%", tint: "text-cyan" },
    { symbol: "ETH", kind: "crypto", value: "$1,450", change: "+1.8%", tint: "text-cyan" },
    { symbol: "EURC", kind: "currency", value: "$1,200", change: "+0.4%", tint: "text-ink" },
    { symbol: "PEPE", kind: "memecoin", value: "$640", change: "+88%", tint: "text-signal" },
    { symbol: "WIF", kind: "memecoin", value: "$310", change: "+41%", tint: "text-signal" },
  ];
  return (
    <div className="rounded-2xl bg-raised p-4">
      <p className={`${CARD_LABEL} text-muted`}>portfolio</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className="font-display text-3xl font-bold">$14,660</p>
        <span className="num rounded-full bg-up/15 px-2.5 py-1 text-[11px] text-up">+18.4% this month</span>
      </div>
      <div className="mt-3 flex h-1.5 gap-1">
        {legend.map((l) => (
          <span key={l.label} className={`rounded-full ${l.color}`} style={{ width: `${l.width}%` }} />
        ))}
      </div>
      <div className="num mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
        {legend.map((l) => (
          <span key={l.label} className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${l.color}`} />
            {l.label}
          </span>
        ))}
      </div>
      <div className="mt-3 divide-y divide-line/60">
        {rows.map((r) => (
          <div key={r.symbol} className="flex items-center gap-3 py-2">
            <TokenIcon symbol={r.symbol} imageUrl={`/brand/tokens/${r.symbol.toLowerCase()}.png`} size={32} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{r.symbol}</span>
              <span className={`num block text-[10px] uppercase ${r.tint}`}>{r.kind}</span>
            </span>
            <span className="text-right">
              <span className="num block text-sm">{r.value}</span>
              <span className="num block text-[11px] text-up">{r.change}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Features() {
  return (
    <div id="inside" className="mx-auto max-w-5xl scroll-mt-6 space-y-4 px-4 py-10 md:py-14">
      <FeatureCard
        eyebrow="alpha feed"
        tone="mint"
        glow="top-left"
        title={
          <>
            all the alpha.
            <br />
            one feed.
          </>
        }
        body="theses from your favourite traders, plus live alpha from X and Telegram."
        art={<AlphaFeedArt />}
        live
      />
      <FeatureCard
        eyebrow="protect yourself"
        tone="blue"
        glow="top-right"
        artFirst
        title={
          <>
            ape in.
            <br />
            with a safety net.
          </>
        }
        body="limit orders, stop losses and take profits on every trade."
        art={<SafetyNetArt />}
      />
      <FeatureCard
        eyebrow="auto copy"
        badge="coming soon"
        tone="mint"
        glow="bottom-center"
        title={
          <>
            copy the best.
            <br />
            on autopilot.
          </>
        }
        body="follow AI bots or your favourite KOLs. their trades copy to you, automatically."
        art={<AutoCopyArt />}
      />
      <FeatureCard
        eyebrow="reputation score"
        tone="mint"
        glow="bottom-right"
        artFirst
        title={
          <>
            ranked for
            <br />
            being right.
          </>
        }
        body="every caller gets a score. loud doesn't count. right does."
        art={<ReputationArt />}
      />
      <FeatureCard
        eyebrow="one platform"
        tone="blue"
        glow="bottom-left"
        title={
          <>
            stocks to memes.
            <br />
            one place.
          </>
        }
        body="your entire portfolio, managed right here."
        art={<PortfolioArt />}
      />
    </div>
  );
}

function Closing() {
  return (
    <section className="relative overflow-hidden pt-14 pb-20 text-center">
      <div aria-hidden className="pointer-events-none absolute top-1/3 left-[12%] h-96 w-[45%] rounded-full bg-up/25 blur-[90px]" />
      <div aria-hidden className="pointer-events-none absolute top-1/3 right-[10%] h-96 w-[42%] rounded-full bg-cyan/20 blur-[90px]" />
      <div className="relative px-4">
        <p className="font-display text-3xl leading-tight font-bold tracking-tight md:text-5xl">
          we frontrun <span className="text-brand">for</span> you.
          <br />
          not against you.
        </p>
        <p className="font-display mt-16 text-[15vw] leading-[1] font-bold tracking-tight whitespace-nowrap md:mt-24 md:text-[128px]">
          don&rsquo;t fomo.
          <br />
          <span className="text-brand">be early.</span>
        </p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8 md:flex-row md:items-center md:justify-between">
        <Wordmark />
        <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
          <Link href="/discovery" className="hover:text-ink">
            Discover
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
      <p className="mx-auto max-w-6xl px-5 text-xs text-faint">Trading involves risk, including the loss of principal. Nothing here is financial advice. Posts marked live are real posts, shortened with links removed, and don't mean their authors use or endorse this app. All other names and figures are illustrative.</p>
      <ArcStudioBadge />
    </footer>
  );
}

export function Landing() {
  return (
    <div className="min-h-dvh overflow-x-hidden bg-bg text-ink">
      <Header />
      <main>
        <Hero />
        <LiveTape />
        <Features />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
