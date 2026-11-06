import { formatCardPct, type TradeCardView } from "@frontrun/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function loadCard(id: string): Promise<TradeCardView | null> {
  const res = await fetch(`${API_URL}/v1/trades/${encodeURIComponent(id)}/card`, { next: { revalidate: 300 } });
  return res.ok ? ((await res.json()) as TradeCardView) : null;
}

/** Gives a shared result a preview card on X and elsewhere. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const image = `/api/og/pnl/${id}`;
  return {
    title: "Result",
    openGraph: { images: [image] },
    twitter: { card: "summary_large_image", images: [image] },
  };
}

export default async function PnlPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await loadCard(id);
  if (!card) notFound();
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/og/pnl/${id}`} alt={`${card.username} closed ${card.symbol} at ${formatCardPct(card.returnPct)}`} width={1200} height={675} className="w-full rounded-2xl border border-line" />
      <div className="mt-4 flex gap-3">
        <Link href={`/u/${card.username}`} className="flex-1 rounded-xl bg-raised py-3 text-center font-semibold">
          View {card.username}
        </Link>
        <Link href="/discovery" className="bg-signal text-signal-ink flex-1 rounded-xl py-3 text-center font-semibold">
          Start trading
        </Link>
      </div>
    </div>
  );
}
