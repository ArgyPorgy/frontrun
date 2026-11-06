import type { TrackerPostKind, TrackerPostView, TrackerSource } from "@frontrun/core";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "./db/client";
import { env } from "./env";
import { fetchJson, HttpError } from "./http";
import { logger } from "./logger";
import { redis } from "./redis";
import { X_ACCOUNTS } from "./x-accounts";

export { X_ACCOUNTS };

/**
 * The X and Telegram trackers, in the style of GMGN's. Nothing here is a full firehose: only these lists are
 * read. X shows everything its accounts do that can be read, since that list is hand-picked. Telegram only
 * keeps relevant posts. Everything read is someone else's text, so it's shown as plain text only, and never
 * acted on.
 */
export const TELEGRAM_CHANNELS = [
  "WatcherGuru", "cointelegraph", "wublockchainenglish", "lookonchainchannel", "whale_alert_io",
  "binance_announcements", "bwenews", "unfolded", "CoinMarketCapAnnouncements", "pumpfun",
];

/** Searches are rejected past this length. */
const X_QUERY_MAX = 512;
/** X's search leaves plain reposts out unless it's asked for them. */
const X_QUERY_SUFFIX = " include:nativeretweets";
/** Room left in each search for " since_id:" and an id. */
const X_SINCE_ROOM = 35;
/** One run in this many checks an account's follows instead of searching for posts. */
const X_FOLLOW_CHECK_EVERY = 6;
/** TwitterAPI.io, a third party that reads X for far less than X's own API. It isn't affiliated with X. */
const X_API = "https://api.twitterapi.io/twitter/tweet/advanced_search";
const X_FOLLOWINGS_API = "https://api.twitterapi.io/twitter/user/followings";
const KEEP_DAYS = 7;

const CRYPTO_WORDS =
  /\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|usdc|usdt|stablecoin|token|memecoin|altcoin|airdrop|defi|dex|on-?chain|wallet|whale|liquidat\w*|etf|binance|coinbase|hyperliquid|listing|delist\w*|staking|mainnet|tokenomics|bull run|bear market)s?\b/i;
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
  kind: TrackerPostKind;
  body: string;
  url: string;
  postedAt: Date;
}

interface XResponse {
  tweets?: Array<{
    id: string;
    text: string;
    createdAt: string;
    isReply?: boolean;
    quoted_tweet?: XEmbeddedTweet | null;
    retweeted_tweet?: XEmbeddedTweet | null;
    author?: { userName: string; name: string; profilePicture?: string | null };
  }>;
}

interface XEmbeddedTweet {
  text?: string;
  author?: { userName?: string };
}

function embeddedText(t: XEmbeddedTweet): string | null {
  if (!t.text) return null;
  const text = decodeEntities(t.text);
  return t.author?.userName ? `@${t.author.userName}: ${text}` : text;
}

const X_TWEET_ID = /^\d{1,25}$/;
const X_HANDLE = /^\w{1,15}$/;

/** A repost's own text is cut short, and a quote means little without what it quotes, so both carry the original. */
function xPostBody(t: { text: string; quoted_tweet?: XEmbeddedTweet | null; retweeted_tweet?: XEmbeddedTweet | null }): string {
  const text = decodeEntities(t.text);
  if (t.retweeted_tweet) return embeddedText(t.retweeted_tweet) ?? text;
  const quoted = t.quoted_tweet && embeddedText(t.quoted_tweet);
  return quoted ? `${text}\n\nQuoting ${quoted}` : text;
}

/** This comes from a third party, so anything that would end up in a link or a date gets checked first. */
export function parseXResponse(res: XResponse): ParsedPost[] {
  return (res.tweets ?? []).flatMap((t) => {
    const author = t.author;
    const postedAt = new Date(t.createdAt);
    if (!author || !X_TWEET_ID.test(t.id) || !X_HANDLE.test(author.userName) || Number.isNaN(postedAt.getTime())) return [];
    const kind = t.retweeted_tweet ? "repost" : t.quoted_tweet ? "quote" : t.isReply ? "reply" : "post";
    return [
      {
        id: `x:${t.id}`,
        source: "x" as const,
        authorHandle: author.userName,
        authorName: author.name,
        authorAvatar: author.profilePicture?.startsWith("https://") ? author.profilePicture : null,
        kind,
        body: xPostBody(t),
        url: `https://x.com/${author.userName}/status/${t.id}`,
        postedAt,
      } satisfies ParsedPost,
    ];
  });
}

/** The response doesn't name its newest post, so work it out. Ids are too long for a plain number. */
export function newestXId(res: XResponse): string | null {
  const ids = (res.tweets ?? []).map((t) => t.id).filter((id) => X_TWEET_ID.test(id));
  return ids.length ? ids.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a)) : null;
}

export function buildXQuery(accounts: string[], sinceId: string | null): string {
  const query = `(${accounts.map((a) => `from:${a}`).join(" OR ")})${X_QUERY_SUFFIX}`;
  return sinceId ? `${query} since_id:${sinceId}` : query;
}

/** Splits the accounts into as few searches as fit the length limit, so each one is read as often as possible. */
export function xAccountGroups(handles: string[] = X_ACCOUNTS.map((a) => a.handle)): string[][] {
  const groups: string[][] = [];
  for (const handle of handles) {
    const current = groups.at(-1);
    if (current && buildXQuery([...current, handle], null).length + X_SINCE_ROOM <= X_QUERY_MAX) current.push(handle);
    else groups.push([handle]);
  }
  return groups;
}

interface XFollowing {
  id: string | number;
  name: string;
  userName: string;
  description?: string | null;
}

/**
 * X doesn't say when a follow happened, only that the list is newest first, so a new follow is anything above
 * the first one already known. Anything lower may just have slid up after an unfollow. A page with nothing
 * known in it means there's no way to tell, so it counts as nothing new.
 */
export function newFollows(page: XFollowing[], known: Set<string>): XFollowing[] {
  const firstKnown = page.findIndex((u) => known.has(String(u.id)));
  return firstKnown < 0 ? [] : page.slice(0, firstKnown);
}

export function followPost(account: { handle: string; name: string }, avatar: string | null, target: XFollowing, seenAt: Date): ParsedPost | null {
  if (!X_HANDLE.test(target.userName)) return null;
  const bio = target.description?.trim();
  return {
    id: `x:follow:${account.handle}:${target.id}`,
    source: "x",
    authorHandle: account.handle,
    authorName: account.name,
    authorAvatar: avatar,
    kind: "follow",
    body: `Followed ${target.name} (@${target.userName})${bio ? `\n\n${bio}` : ""}`,
    url: `https://x.com/${target.userName}`,
    postedAt: seenAt,
  };
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
  if (!posts.length) return 0;
  const inserted = await db()
    .insert(schema.trackerPosts)
    .values(posts.map((p) => ({ ...p, body: p.body.slice(0, 2_000), tokens: extractTokens(p.body) })))
    .onConflictDoNothing()
    .returning({ id: schema.trackerPosts.id });
  return inserted.length;
}

export function xTrackerConfigured(): boolean {
  return !!env().TWITTERAPI_IO_KEY;
}

/** Worker: one request per run, so runs can't collide with the service's rate limit. */
export async function pollXTracker(): Promise<number> {
  const key = env().TWITTERAPI_IO_KEY;
  if (!key) return 0;
  const run = Number(await redis().incr("tracker:x:run"));
  return run % X_FOLLOW_CHECK_EVERY === 0 ? checkXFollows(key) : readXPosts(key);
}

/** Reads one group of accounts. Reads are billed per post, so sinceId keeps it to new ones. */
async function readXPosts(key: string): Promise<number> {
  const r = redis();
  const groups = xAccountGroups();
  const group = Number(await r.incr("tracker:x:cursor")) % groups.length;
  const accounts = groups[group]!;
  const sinceKey = `tracker:x:since:${group}`;
  const sinceId = await r.get(sinceKey);
  // One page per run, up to 20 posts: enough for a couple of minutes of these accounts, and it caps the cost.
  const params = new URLSearchParams({ query: buildXQuery(accounts, sinceId), queryType: "Latest" });
  try {
    const res = await fetchJson<XResponse>(`${X_API}?${params}`, { headers: { "x-api-key": key }, timeoutMs: 10_000 });
    const newest = newestXId(res);
    if (newest) await r.set(sinceKey, newest, "EX", 7 * 86_400);
    return await savePosts(parseXResponse(res));
  } catch (err) {
    logger.warn({ status: err instanceof HttpError ? err.status : undefined }, "X tracker read failed");
    return 0;
  }
}

/** Compares one account's newest follows with the ones seen before. The first look at an account only takes notes. */
async function checkXFollows(key: string): Promise<number> {
  const r = redis();
  const account = X_ACCOUNTS[Number(await r.incr("tracker:x:follow-cursor")) % X_ACCOUNTS.length]!;
  const knownKey = `tracker:x:following:${account.handle}`;
  const params = new URLSearchParams({ userName: account.handle, pageSize: "20" });
  try {
    const res = await fetchJson<{ followings?: XFollowing[] }>(`${X_FOLLOWINGS_API}?${params}`, { headers: { "x-api-key": key }, timeoutMs: 10_000 });
    const page = res.followings ?? [];
    if (!page.length) return 0;
    const followed = newFollows(page, new Set(await r.smembers(knownKey)));
    await r.sadd(knownKey, ...page.map((u) => String(u.id)));
    if (!followed.length) return 0;
    const [latest] = await db()
      .select({ avatar: schema.trackerPosts.authorAvatar })
      .from(schema.trackerPosts)
      .where(and(eq(schema.trackerPosts.source, "x"), eq(sql`lower(${schema.trackerPosts.authorHandle})`, account.handle.toLowerCase())))
      .orderBy(desc(schema.trackerPosts.postedAt))
      .limit(1);
    const now = new Date();
    return await savePosts(followed.flatMap((u) => followPost(account, latest?.avatar ?? null, u, now) ?? []));
  } catch (err) {
    logger.warn({ handle: account.handle, status: err instanceof HttpError ? err.status : undefined }, "X follow check failed");
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
    return await savePosts(parseTelegramPage(await res.text(), channel).filter((p) => isRelevant(p.body)));
  } catch (err) {
    logger.warn({ channel, err: err instanceof Error ? err.message : err }, "Telegram tracker read failed");
    return 0;
  }
}

export async function pruneTrackerPosts(): Promise<void> {
  await db().delete(schema.trackerPosts).where(lt(schema.trackerPosts.postedAt, new Date(Date.now() - KEEP_DAYS * 86_400_000)));
}

export async function listTrackerPosts(source: TrackerSource, opts: { before?: string; kind?: TrackerPostKind; limit?: number } = {}): Promise<{ items: TrackerPostView[]; configured: boolean }> {
  const rows = await db()
    .select()
    .from(schema.trackerPosts)
    .where(
      and(
        eq(schema.trackerPosts.source, source),
        opts.before ? lt(schema.trackerPosts.postedAt, new Date(opts.before)) : undefined,
        opts.kind ? eq(schema.trackerPosts.kind, opts.kind) : undefined,
      ),
    )
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
      kind: r.kind as TrackerPostKind,
      body: r.body,
      url: r.url,
      tokens: r.tokens,
      postedAt: r.postedAt.toISOString(),
    })),
  };
}
