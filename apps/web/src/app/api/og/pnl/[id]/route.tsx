import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatCardPct, formatPrice, pnlCardTier, type TradeCardView } from "@frontrun/core";
import { ImageResponse } from "next/og";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const files = new Map<string, Promise<Buffer>>();
function brandFile(path: string): Promise<Buffer> {
  let file = files.get(path);
  if (!file) {
    file = readFile(join(process.cwd(), "public/brand", path));
    files.set(path, file);
  }
  return file;
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/** The card's font has no subscript digits, so the zero count in a tiny price is drawn small by hand. */
function PriceText({ value }: { value: string }) {
  const parts = value.split(/([₀-₉]+)/).filter(Boolean);
  return (
    <div style={{ display: "flex", alignItems: "baseline", fontSize: 44, color: "#f5f4f7" }}>
      {parts.map((part, i) =>
        SUBSCRIPT.includes(part[0]!) ? (
          <span key={i} style={{ fontSize: 26, marginBottom: -10 }}>
            {[...part].map((d) => SUBSCRIPT.indexOf(d)).join("")}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
}

function Price({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 22, color: "#8d9299" }}>{label}</div>
      <PriceText value={value} />
    </div>
  );
}

/** A closed position's result card. The same image shows in the app and goes out when it's shared. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await fetch(`${API_URL}/v1/trades/${encodeURIComponent(id)}/card`, { next: { revalidate: 300 } });
  if (!res.ok) return new Response("Not found", { status: 404 });
  const card = (await res.json()) as TradeCardView;
  const up = card.returnPct >= 0;
  const accent = up ? "#35db98" : "#eb5271";
  const [photo, light, regular, medium] = await Promise.all([
    brandFile(`pnl/${pnlCardTier(card.returnPct)}.jpg`),
    brandFile("fonts/SpaceGrotesk-300.woff"),
    brandFile("fonts/SpaceGrotesk-400.woff"),
    brandFile("fonts/SpaceGrotesk-500.woff"),
  ]);
  const symbol = card.symbol.length > 12 ? `${card.symbol.slice(0, 12)}…` : card.symbol;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#050407", color: "#f5f4f7", fontFamily: "Space Grotesk" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/jpeg;base64,${photo.toString("base64")}`} alt="" width={614} height={675} style={{ position: "absolute", top: 0, right: 0, width: 614, height: 675, objectFit: "cover" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "52px 56px", width: "100%", height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width={32} height={23} viewBox="0 0 580 416">
              <defs>
                <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#00f5a0" />
                  <stop offset="1" stopColor="#00d0ea" />
                </linearGradient>
              </defs>
              <path fill="#f5f4f7" d="M0 0 237 208 0 416Z" />
              <path fill="url(#mark)" d="M234 0 495 208 234 416Z" />
              <rect fill="url(#mark)" x="522" width="58" height="416" rx="10" />
            </svg>
            <div style={{ fontSize: 28, fontWeight: 500, letterSpacing: 1 }}>FRONTRUN</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 48, height: 48, borderRadius: 24, background: accent, color: "#050407", fontSize: 24, fontWeight: 500 }}>{card.symbol.slice(0, 1).toUpperCase()}</div>
              <div style={{ fontSize: 40, fontWeight: 500 }}>{symbol}</div>
            </div>
            <div style={{ fontSize: 140, fontWeight: 300, letterSpacing: -6, color: accent, lineHeight: 1.15, marginTop: 4 }}>{formatCardPct(card.returnPct)}</div>
            <div style={{ display: "flex", gap: 56, marginTop: 28 }}>
              <Price label="Entry Price" value={formatPrice(card.entryPriceUsd)} />
              <Price label="Exit Price" value={formatPrice(card.exitPriceUsd)} />
            </div>
          </div>
          <div style={{ display: "flex" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, height: 56, padding: "0 26px", borderRadius: 28, border: "1px solid #3a3d44", background: "#15161acc", fontSize: 23 }}>
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#c3c6cc" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
              </svg>
              {`${new URL(APP_URL).host}/u/${card.username}`}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 675,
      fonts: [
        { name: "Space Grotesk", data: light, weight: 300, style: "normal" },
        { name: "Space Grotesk", data: regular, weight: 400, style: "normal" },
        { name: "Space Grotesk", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
