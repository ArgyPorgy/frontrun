import type { TrackerPostView, TrackerSource } from "@frontrun/core";
import { and, desc, eq, lt } from "drizzle-orm";
import { db, schema } from "./db/client";
import { env } from "./env";
import { fetchJson, HttpError } from "./http";
import { logger } from "./logger";
import { redis } from "./redis";

/**
 * The X and Telegram trackers: a curated feed of what crypto's loudest accounts are saying, in the style
 * of GMGN's. Nothing here is a full firehose. Only these lists are read, and only relevant posts are kept.
 * Edit these lists to change who's tracked. Everything read is someone else's text, so it's shown as
 * plain text only, and never acted on.
 */
export const X_ACCOUNTS = [
  "elonmusk", "cz_binance", "VitalikButerin", "saylor", "brian_armstrong", "jessepollak",
  "aeyakovenko", "HyperliquidX", "circle", "coinbase", "binance", "base", "solana", "arbitrum",
  "blknoiz06", "cobie", "HsakaTrades", "MustStopMurad", "Pentosh1", "inversebrah", "DegenSpartan", "gainzy222",
  "lookonchain", "WatcherGuru", "tier10k", "whale_alert", "WuBlockchain", "unusual_whales",
];

export const TELEGRAM_CHANNELS = [
  "WatcherGuru", "cointelegraph", "wublockchainenglish", "lookonchainchannel", "whale_alert_io",
  "binance_announcements", "bwenews", "unfolded", "CoinMarketCapAnnouncements", "pumpfun",
];

/** X allows 512 characters in a query on this plan, which fits about this many accounts at a time. */
const X_QUERY_CHUNK = 18;
const X_API = "https://api.x.com/2/tweets/search/recent";
const KEEP_DAYS = 7;

const CRYPTO_WORDS =
  /\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|usdc|usdt|stablecoin|token|memecoin|altcoin|airdrop|defi|dex|on-?chain|wallet|whale|liquidat\w*|etf|binance|coinbase|hyperliquid|listing|delist\w*|staking|mainnet|tokenomics|bull run|bear market)\b/i;
const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export function extractTokens(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(TICKER)) found.add(`$${m[1]!.toUpperCase()}`);
  for (const m of text.matchAll(EVM_ADDRESS)) found.add(m[0]);
  for (const m of text.matchAll(SOLANA_ADDRESS)) found.add(m[0]);
  return [...found].slice(0, 8);
}

/** "Only the recommended": a post has to name a token or be about crypto to make the feed. */
export function isRelevant(text: string): boolean {
  if (text.trim().length < 12) return false;
  return extractTokens(text).length > 0 || CRYPTO_WORDS.test(text);
}

interface ParsedPost {
  id: string;
  source: TrackerSource;
  authorHandle: string;
  authorName: string;
  authorAvatar: string | null;
  kind: "post" | "quote" | "reply" | "repost";
  body: string;
  url: string;
  postedAt: Date;
}

interface XResponse {
  data?: Array<{ id: string; text: string; author_id: string; created_at: string; referenced_tweets?: Array<{ type: string }> }>;
  includes?: { users?: Array<{ id: string; name: string; username: string; profile_image_url?: string }> };
  meta?: { newest_id?: string };
}

export function parseXResponse(res: XResponse): ParsedPost[] {
  const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u]));
  return (res.data ?? []).flatMap((t) => {
    const author = users.get(t.author_id);
    if (!author) return [];
    const refs = t.referenced_tweets?.map((r) => r.type) ?? [];
    const kind = refs.includes("quoted") ? "quote" : refs.includes("replied_to") ? "reply" : refs.includes("retweeted") ? "repost" : "post";
    return [
      {
        id: `x:${t.id}`,
        source: "x" as const,
        authorHandle: author.username,
        authorName: author.name,
        authorAvatar: author.profile_image_url ?? null,
        kind,
        body: t.text,
        url: `https://x.com/${author.username}/status/${t.id}`,
        postedAt: new Date(t.created_at),
      } satisfies ParsedPost,
    ];
  });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function htmlToText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text).replace(/\n{3,}/g, "\n\n").trim();
}

/** Reads Telegram's public web preview of a channel, which needs no key or account. */
export function parseTelegramPage(html: string, channel: string): ParsedPost[] {
  const title = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1];
  const avatar = /<meta property="og:image" content="([^"]*)"/.exec(html)?.[1];
  return html.split('<div class="tgme_widget_message_wrap').slice(1).flatMap((chunk) => {
    const post = /data-post="([^"/]+)\/(\d+)"/.exec(chunk);
    const time = /<time[^>]*datetime="([^"]+)"/.exec(chunk);
    const bodyStart = chunk.search(/<div class="tgme_widget_message_text[^"]*"[^>]*>/);
    if (!post || !time || bodyStart < 0) return [];
    const open = chunk.indexOf(">", bodyStart) + 1;
    // The text block ends where the message footer begins.
    const end = chunk.indexOf('<div class="tgme_widget_message_footer', open);
    const raw = chunk.slice(open, end < 0 ? undefined : end).replace(/<\/div>\s*$/g, "");
    const body = htmlToText(raw);
    if (!body) return [];
    return [
      {
        id: `telegram:${post[1]}:${post[2]}`,
        source: "telegram" as const,
        authorHandle: post[1]!,
        authorName: title ? decodeEntities(title) : channel,
        authorAvatar: avatar ? decodeEntities(avatar) : null,
        kind: "post" as const,
        body,
        url: `https://t.me/${post[1]}/${post[2]}`,
        postedAt: new Date(time[1]!),
      },
    ];
  });
}

async function savePosts(posts: ParsedPost[]): Promise<number> {
  const relevant = posts.filter((p) => isRelevant(p.body));
  if (!relevant.length) return 0;
  const inserted = await db()
    .insert(schema.trackerPosts)
    .values(relevant.map((p) => ({ ...p, body: p.body.slice(0, 2_000), tokens: extractTokens(p.body) })))
    .onConflictDoNothing()
    .returning({ id: schema.trackerPosts.id });
  return inserted.length;
}

export function xTrackerConfigured(): boolean {
  return !!env().X_BEARER_TOKEN;
}

/** Worker: reads one group of X accounts per run. X bills per post read, so sinceId keeps it to new ones. */
export async function pollXTracker(): Promise<number> {
  const token = env().X_BEARER_TOKEN;
  if (!token) return 0;
  const r = redis();
  const groups = Math.ceil(X_ACCOUNTS.length / X_QUERY_CHUNK);
  const group = Number(await r.incr("tracker:x:cursor")) % groups;
  const accounts = X_ACCOUNTS.slice(group * X_QUERY_CHUNK, (group + 1) * X_QUERY_CHUNK);
  const sinceKey = `tracker:x:since:${group}`;
  const sinceId = await r.get(sinceKey);
  const params = new URLSearchParams({
    // Replies and plain reposts are most of the noise, and each one would cost a read.
    query: `(${accounts.map((a) => `from:${a}`).join(" OR ")}) -is:reply -is:retweet`,
    max_results: "50",
    "tweet.fields": "created_at,referenced_tweets,author_id",
    expansions: "author_id",
    "user.fields": "name,username,profile_image_url",
  });
  if (sinceId) params.set("since_id", sinceId);
  try {
    const res = await fetchJson<XResponse>(`${X_API}?${params}`, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 10_000 });
    if (res.meta?.newest_id) await r.set(sinceKey, res.meta.newest_id, "EX", 7 * 86_400);
    return await savePosts(parseXResponse(res));
  } catch (err) {
    logger.warn({ status: err instanceof HttpError ? err.status : undefined }, "X tracker read failed");
    return 0;
  }
}

/** Worker: reads one Telegram channel per run, spreading them out so the preview pages aren't hammered. */
export async function pollTelegramTracker(): Promise<number> {
  const position = Number(await redis().incr("tracker:tg:cursor")) % TELEGRAM_CHANNELS.length;
  const channel = TELEGRAM_CHANNELS[position]!;
  try {
    const res = await fetch(`https://t.me/s/${channel}`, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await savePosts(parseTelegramPage(await res.text(), channel));
  } catch (err) {
    logger.warn({ channel, err: err instanceof Error ? err.message : err }, "Telegram tracker read failed");
    return 0;
  }
}

export async function pruneTrackerPosts(): Promise<void> {
  await db().delete(schema.trackerPosts).where(lt(schema.trackerPosts.postedAt, new Date(Date.now() - KEEP_DAYS * 86_400_000)));
}

export async function listTrackerPosts(source: TrackerSource, opts: { before?: string; limit?: number } = {}): Promise<{ items: TrackerPostView[]; configured: boolean }> {
  const rows = await db()
    .select()
    .from(schema.trackerPosts)
    .where(and(eq(schema.trackerPosts.source, source), opts.before ? lt(schema.trackerPosts.postedAt, new Date(opts.before)) : undefined))
    .orderBy(desc(schema.trackerPosts.postedAt))
    .limit(opts.limit ?? 40);
  return {
    configured: source === "telegram" || xTrackerConfigured(),
    items: rows.map((r) => ({
      id: r.id,
      source: r.source as TrackerSource,
      authorHandle: r.authorHandle,
      authorName: r.authorName,
      authorAvatar: r.authorAvatar,
      kind: r.kind as TrackerPostView["kind"],
      body: r.body,
      url: r.url,
      tokens: r.tokens,
      postedAt: r.postedAt.toISOString(),
    })),
  };
}
