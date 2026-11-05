import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

const ALLOWED = new Set([96, 180, 192, 512]);

/** Icons are drawn in code, so there are no binary assets to keep in sync with the brand. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!ALLOWED.has(size)) return new Response("Not found", { status: 404 });
  // Maskable icons get cropped to a circle or squircle, so the mark stays inside the safe zone.
  const maskable = req.nextUrl.searchParams.has("maskable");
  const mark = size * (maskable ? 0.42 : 0.58);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0c0b" }}>
        <svg width={mark} height={mark} viewBox="0 0 24 24" fill="none">
          <path d="M3 17l6-6 4 4 8-8" stroke="#c8f135" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="21" cy="7" r="2.6" fill="#c8f135" />
        </svg>
      </div>
    ),
    { width: size, height: size, headers: { "cache-control": "public, max-age=604800, immutable" } },
  );
}
