import { D, type Numeric } from "./money";

export const THESIS_MAX_LENGTH = 560;
export const REPLY_MAX_LENGTH = 280;
export const POSITION_TIERS = [50, 100, 500, 1000] as const;
export type PositionTier = (typeof POSITION_TIERS)[number];

/** Authors need this many closed theses before they rank on the reputation leaderboard. */
export const LEADERBOARD_MIN_RESOLVED = 5;
/** Smallest position that earns the verified-holder badge. */
export const VERIFIED_MIN_USD = 1;
/** Accounts younger than this are throttled and need a position to reach the default feed. */
export const NEW_ACCOUNT_HOURS = 24;
export const AUTO_HIDE_REPORT_COUNT = 5;

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|xyz|fi|org|net|app|gg|co|me|finance|exchange|top|click|link|site|online|info|cc|ru|tk|vip|live|pro)\b(?:\/[^\s]*)?/gi;

/** Hosts we let through because they're where traders legitimately point to. */
const ALLOWED_LINK_HOSTS = [
  "x.com",
  "twitter.com",
  "dexscreener.com",
  "geckoterminal.com",
  "arc.io",
  "explorer.arc.io",
  "basescan.org",
  "etherscan.io",
  "solscan.io",
  "arbiscan.io",
  "bscscan.com",
];

/** Wording that shows up in wallet-drainer lures. */
const DRAINER_PATTERNS = [
  /\bclaim\b.{0,24}\b(airdrop|reward|token)s?\b/i,
  /\bconnect\s+(your\s+)?wallet\b/i,
  /\bverify\s+(your\s+)?wallet\b/i,
  /\bfree\s+(mint|airdrop|tokens?)\b/i,
  /\b(seed|recovery)\s+phrase\b/i,
  /\bprivate\s+key\b/i,
  /\bsend\s+\d*\.?\d*\s*(eth|usdc|sol)\b.*\b(back|double|return)\b/i,
];

const INVISIBLE_CHARS = /[​-‍⁠﻿­]/g;

export interface BodyCheck {
  ok: boolean;
  body: string;
  reason?: "empty" | "too_long" | "blocked_link" | "drainer_language";
}

function linkHost(raw: string): string {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw.toLowerCase();
  }
}

function isAllowedHost(host: string): boolean {
  return ALLOWED_LINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function checkBody(input: string, maxLength: number = THESIS_MAX_LENGTH): BodyCheck {
  // Invisible characters come out first so they can't split a URL or a drainer phrase.
  const body = input.replace(INVISIBLE_CHARS, "").trim();
  if (!body) return { ok: false, body, reason: "empty" };
  if (body.length > maxLength) return { ok: false, body, reason: "too_long" };
  for (const pattern of DRAINER_PATTERNS) {
    if (pattern.test(body)) return { ok: false, body, reason: "drainer_language" };
  }
  for (const match of body.matchAll(URL_PATTERN)) {
    if (!isAllowedHost(linkHost(match[0]))) return { ok: false, body, reason: "blocked_link" };
  }
  return { ok: true, body };
}

export const BODY_REJECTION_MESSAGES: Record<NonNullable<BodyCheck["reason"]>, string> = {
  empty: "Write something first.",
  too_long: "That's too long.",
  blocked_link: "Links to that site aren't allowed.",
  drainer_language: "This looks like a wallet-drainer lure, so it can't be posted.",
};

export function positionTier(positionUsd: Numeric): PositionTier | null {
  const usd = D(positionUsd);
  let tier: PositionTier | null = null;
  for (const t of POSITION_TIERS) if (usd.gte(t)) tier = t;
  return tier;
}

export type ThesisOutcome = "pending" | "right" | "wrong";

export function returnSincePost(priceAtPost: Numeric, price: Numeric): number {
  const entry = D(priceAtPost);
  if (entry.lte(0)) return 0;
  return D(price).sub(entry).div(entry).mul(100).toNumber();
}

/** A thesis is right if its author actually made money when they sold out. Nothing else counts. */
export function resolveOutcome(realizedPnlUsd: Numeric): Exclude<ThesisOutcome, "pending"> {
  return D(realizedPnlUsd).gt(0) ? "right" : "wrong";
}

export function accuracyPct(right: number, resolved: number): number | null {
  return resolved > 0 ? (right / resolved) * 100 : null;
}

/** Feed rank: verified size and engagement, decayed by age so fresh theses surface. */
export function thesisRankScore(input: {
  likeCount: number;
  replyCount: number;
  positionUsd: Numeric;
  verified: boolean;
  ageHours: number;
}): number {
  const size = Math.log10(1 + Math.max(D(input.positionUsd).toNumber(), 0));
  const engagement = input.likeCount + input.replyCount * 2;
  const base = (input.verified ? 3 : 0) + size + Math.log2(1 + engagement);
  return base / Math.pow(input.ageHours + 2, 1.2);
}
