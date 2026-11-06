import { CHAINS, formatCompactUsd, formatPct, formatPrice, type ThesisView } from "@frontrun/core";
import { ImageResponse } from "next/og";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** The X share card: who said it, what they hold, their entry, how it's going, and the thesis. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await fetch(`${API_URL}/v1/theses/${encodeURIComponent(id)}`, { next: { revalidate: 60 } });
  if (!res.ok) return new Response("Not found", { status: 404 });
  const t = (await res.json()) as ThesisView;
  const up = (t.returnPct ?? 0) >= 0;
  const body = t.body.length > 220 ? `${t.body.slice(0, 220)}…` : t.body;
  // One string on purpose: the renderer needs display:flex on any element with several children,
  // and fails mid-response without logging if one is missing.
  const detail = `${t.verified ? `Holding ${formatCompactUsd(t.positionUsdAtPost)} · ` : ""}Posted at ${formatPrice(t.priceAtPost)}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#050507", color: "#f5f4f7", padding: 64, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 56, fontWeight: 700 }}>{t.token.symbol}</div>
            <div style={{ fontSize: 24, color: "#8d9299" }}>{CHAINS[t.token.chain].name}</div>
          </div>
          {t.returnPct !== null && <div style={{ fontSize: 64, fontWeight: 700, color: up ? "#35db98" : "#eb5271" }}>{formatPct(t.returnPct)}</div>}
        </div>
        <div style={{ fontSize: 36, lineHeight: 1.3, display: "flex" }}>{body}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", fontSize: 26, color: "#8d9299" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#f5f4f7", fontWeight: 600 }}>{t.author.username}</div>
            <div style={{ display: "flex" }}>{detail}</div>
          </div>
          <div style={{ color: "#6deab2", fontWeight: 700 }}>frontrun</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
