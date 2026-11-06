import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const usd = (name: string) => numeric(name, { precision: 38, scale: 18 });
const qty = (name: string) => numeric(name, { precision: 60, scale: 18 });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  privyId: text("privy_id").notNull().unique(),
  username: text("username").notNull(),
  usernameSet: boolean("username_set").notNull().default(false),
  avatarUrl: text("avatar_url"),
  isBanned: boolean("is_banned").notNull().default(false),
  paperBalanceUsd: usd("paper_balance_usd").notNull().default("0"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("users_username_lower").on(sql`lower(${t.username})`)]);

export const wallets = pgTable("wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  chainType: text("chain_type", { enum: ["evm", "solana"] }).notNull(),
  address: text("address").notNull(),
  isEmbedded: boolean("is_embedded").notNull().default(true),
  /** Privy's wallet id, needed to sign server-side. Null for external wallets. */
  privyWalletId: text("privy_wallet_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("wallets_address").on(t.chainType, t.address),
  index("wallets_user").on(t.userId),
]);

export const signerGrants = pgTable("signer_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  perTradeCapUsd: usd("per_trade_cap_usd").notNull(),
  dailyCapUsd: usd("daily_cap_usd").notNull(),
  grantedAt: ts("granted_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  /** The one-time max USDC approval to Flash; also the wallet's first footprint on Arc. */
  approvalTx: text("approval_tx"),
}, (t) => [index("signer_grants_user").on(t.userId, t.grantedAt)]);

export const tokens = pgTable("tokens", {
  chain: text("chain").notNull(),
  address: text("address").notNull(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  decimals: integer("decimals"),
  imageUrl: text("image_url"),
  /** Set by moderators or the honeypot check. Buys are blocked, sells need a visible confirm. */
  denylisted: boolean("denylisted").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.chain, t.address] })]);

export const trades = pgTable("trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  tokenChain: text("token_chain").notNull(),
  tokenAddr: text("token_addr").notNull(),
  usdIn: usd("usd_in"),
  usdOut: usd("usd_out"),
  qty: qty("qty"),
  priceUsd: usd("price_usd"),
  /** What this sale made or lost against its cost basis. Null on buys. */
  pnlUsd: usd("pnl_usd"),
  /** This sale sold the whole position, which is what earns a PnL card. */
  closedPosition: boolean("closed_position").notNull().default(false),
  feeUsd: usd("fee_usd"),
  /** The app's own fee on this trade. feeUsd can't stand in for it: it's also gas and pool fees on some routes. */
  revenueUsd: usd("revenue_usd").notNull().default("0"),
  provider: text("provider").notNull(),
  providerOrderId: text("provider_order_id"),
  srcChain: text("src_chain").notNull(),
  srcTx: text("src_tx"),
  dstTx: text("dst_tx"),
  status: text("status", {
    enum: ["awaiting_signature", "pending", "source_confirmed", "filled", "refunded", "failed"],
  }).notNull(),
  error: text("error"),
  isPaper: boolean("is_paper").notNull().default(false),
  idempotencyKey: text("idempotency_key").notNull(),
  copiedThesisId: uuid("copied_thesis_id"),
  /** Set when copy trading placed this. A copy is never copied in turn. */
  copiedFromTradeId: uuid("copied_from_trade_id"),
  /** Set once followers' copies of this fill have been placed. */
  copyProcessedAt: ts("copy_processed_at"),
  /** Quote payload and signing progress. Holds no secrets. */
  execState: jsonb("exec_state"),
  applied: boolean("applied").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  filledAt: ts("filled_at"),
  /** Set once followers have been told about this buy. */
  followersNotifiedAt: ts("followers_notified_at"),
}, (t) => [
  uniqueIndex("trades_idempotency").on(t.userId, t.idempotencyKey),
  index("trades_user_created").on(t.userId, t.createdAt),
  index("trades_active").on(t.status).where(sql`status in ('pending','source_confirmed')`),
  index("trades_token").on(t.tokenChain, t.tokenAddr),
]);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenChain: text("token_chain").notNull(),
  tokenAddr: text("token_addr").notNull(),
  type: text("type").notNull(),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  amountUsd: usd("amount_usd"),
  sellPct: real("sell_pct"),
  triggerPriceUsd: usd("trigger_price_usd").notNull(),
  /** "flash" rests on the venue. "app" is watched here, and fires a market order when it hits. */
  engine: text("engine", { enum: ["flash", "app"] }).notNull(),
  providerOrderId: text("provider_order_id"),
  status: text("status", { enum: ["open", "triggered", "filled", "cancelled", "failed"] }).notNull().default("open"),
  tradeId: uuid("trade_id").references(() => trades.id, { onDelete: "set null" }),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
}, (t) => [index("orders_user").on(t.userId, t.status), index("orders_open").on(t.status, t.engine)]);

export const trackerPosts = pgTable("tracker_posts", {
  /** The source's own id, so reading a post twice can't save it twice. */
  id: text("id").primaryKey(),
  source: text("source", { enum: ["x", "telegram"] }).notNull(),
  authorHandle: text("author_handle").notNull(),
  authorName: text("author_name").notNull(),
  authorAvatar: text("author_avatar"),
  kind: text("kind").notNull(),
  body: text("body").notNull(),
  url: text("url").notNull(),
  tokens: jsonb("tokens").$type<string[]>().notNull().default([]),
  postedAt: ts("posted_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("tracker_posts_feed").on(t.source, t.postedAt)]);

export const positions = pgTable("positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenChain: text("token_chain").notNull(),
  tokenAddr: text("token_addr").notNull(),
  qty: qty("qty").notNull().default("0"),
  costBasisUsd: usd("cost_basis_usd").notNull().default("0"),
  realizedPnlUsd: usd("realized_pnl_usd").notNull().default("0"),
  openedAt: ts("opened_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
  reconciledAt: ts("reconciled_at"),
}, (t) => [
  uniqueIndex("positions_open_unique").on(t.userId, t.tokenChain, t.tokenAddr).where(sql`closed_at is null`),
  index("positions_user").on(t.userId),
  index("positions_open").on(t.tokenChain, t.tokenAddr).where(sql`closed_at is null`),
]);

export const theses = pgTable("theses", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenChain: text("token_chain").notNull(),
  tokenAddr: text("token_addr").notNull(),
  body: text("body").notNull(),
  /** Locked at post time. There is no edit: authors can delete, never rewrite history. */
  priceAtPost: usd("price_at_post").notNull(),
  ts: ts("ts").notNull().defaultNow(),
  positionUsdAtPost: usd("position_usd_at_post").notNull().default("0"),
  authorAvgEntry: usd("author_avg_entry"),
  verified: boolean("verified").notNull().default(false),
  likeCount: integer("like_count").notNull().default(0),
  replyCount: integer("reply_count").notNull().default(0),
  rankScore: real("rank_score").notNull().default(0),
  outcome: text("outcome", { enum: ["pending", "right", "wrong"] }).notNull().default("pending"),
  priceAtResolve: usd("price_at_resolve"),
  returnPct: real("return_pct"),
  resolvedAt: ts("resolved_at"),
  deletedAt: ts("deleted_at"),
  hiddenAt: ts("hidden_at"),
  /** The exact JSON that was hashed, kept so anyone can recompute the hash on Arc. */
  anchorPayload: text("anchor_payload"),
  anchorHash: text("anchor_hash"),
  anchorTx: text("anchor_tx"),
  anchoredAt: ts("anchored_at"),
  anchorAttempts: integer("anchor_attempts").notNull().default(0),
}, (t) => [
  index("theses_token_ts").on(t.tokenChain, t.tokenAddr, t.ts),
  index("theses_user_ts").on(t.userId, t.ts),
  index("theses_rank").on(t.rankScore),
  index("theses_ts").on(t.ts),
  index("theses_unresolved").on(t.ts).where(sql`outcome = 'pending' and deleted_at is null`),
]);

export const thesisReplies = pgTable("thesis_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  thesisId: uuid("thesis_id").notNull().references(() => theses.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [index("thesis_replies_thesis").on(t.thesisId, t.createdAt)]);

export const likes = pgTable("likes", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  thesisId: uuid("thesis_id").notNull().references(() => theses.id, { onDelete: "cascade" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.thesisId] })]);

export const follows = pgTable("follows", {
  followerId: uuid("follower_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  followeeId: uuid("followee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.followerId, t.followeeId] }),
  index("follows_followee").on(t.followeeId),
]);

export const blocks = pgTable("blocks", {
  blockerId: uuid("blocker_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  blockedId: uuid("blocked_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })]);

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  reporterId: uuid("reporter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  thesisId: uuid("thesis_id").references(() => theses.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  note: text("note"),
  createdAt: ts("created_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
}, (t) => [
  uniqueIndex("reports_one_per_thesis").on(t.reporterId, t.thesisId),
  index("reports_thesis").on(t.thesisId),
]);

/** Who copies whose trades, and with how much of their own money. */
export const copySettings = pgTable("copy_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  followerId: uuid("follower_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  leaderId: uuid("leader_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amountUsd: usd("amount_usd").notNull(),
  dailyLimitUsd: usd("daily_limit_usd").notNull(),
  copySells: boolean("copy_sells").notNull().default(true),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("copy_settings_pair").on(t.followerId, t.leaderId),
  index("copy_settings_leader").on(t.leaderId),
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  thesisId: uuid("thesis_id").references(() => theses.id, { onDelete: "cascade" }),
  tokenChain: text("token_chain"),
  tokenAddr: text("token_addr"),
  /** Set on fills, so the notification can open that trade's result. */
  tradeId: uuid("trade_id").references(() => trades.id, { onDelete: "set null" }),
  message: text("message").notNull(),
  readAt: ts("read_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("notifications_user").on(t.userId, t.createdAt)]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Append-only record of every action taken with a user's signer, for the plan's audit requirement. */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  detail: jsonb("detail"),
  ip: text("ip"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("audit_user").on(t.userId, t.createdAt), index("audit_action").on(t.action, t.createdAt)]);

export const providerEvents = pgTable("provider_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  provider: text("provider").notNull(),
  kind: text("kind", { enum: ["quote_ok", "quote_error", "fill", "fail"] }).notNull(),
  latencyMs: integer("latency_ms"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("provider_events_lookup").on(t.provider, t.kind, t.createdAt)]);

/** Native gas sent to a user so a first sell can be set up; recovered from that sell's proceeds. */
export const gasTopups = pgTable("gas_topups", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  chain: text("chain").notNull(),
  amountWei: text("amount_wei").notNull(),
  costUsd: usd("cost_usd").notNull(),
  txHash: text("tx_hash").notNull(),
  tradeId: uuid("trade_id"),
  settledAt: ts("settled_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("gas_topups_user").on(t.userId)]);
