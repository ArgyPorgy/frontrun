import { z } from "zod";
import { CHAIN_KEYS, type ChainKey } from "./chains";
import { REPLY_MAX_LENGTH, THESIS_MAX_LENGTH } from "./thesis";
import { TIMEFRAMES } from "./types";
import { isPositiveDecimal } from "./money";

export const chainKeySchema = z.enum(CHAIN_KEYS as [ChainKey, ...ChainKey[]]);
export const timeframeSchema = z.enum(TIMEFRAMES as [(typeof TIMEFRAMES)[number], ...(typeof TIMEFRAMES)[number][]]);
const positiveDecimal = z.string().max(64).refine(isPositiveDecimal, "must be a positive number");

export const usernameSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-zA-Z0-9_]+$/, "letters, numbers and underscores only");

export const updateProfileSchema = z.object({
  username: usernameSchema.optional(),
  /** `gen:<n>` picks a built-in generated avatar. Anything else has to be an https URL. */
  avatarUrl: z.string().max(500).regex(/^(gen:\d{1,3}|https:\/\/.+)$/, "invalid avatar").nullable().optional(),
});

export const quoteRequestSchema = z
  .object({
    chain: chainKeySchema,
    address: z.string().min(16).max(64),
    side: z.enum(["buy", "sell"]),
    /** USD (USDC) to spend on a buy. */
    amountUsd: positiveDecimal.optional(),
    /** Share of the position to sell, above 0 and up to 100. */
    sellPct: z.number().gt(0).max(100).optional(),
    copyThesisId: z.string().uuid().optional(),
  })
  .refine((q) => (q.side === "buy" ? !!q.amountUsd : q.sellPct !== undefined), {
    message: "buys need amountUsd, sells need sellPct",
  });
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const executeTradeSchema = z.object({
  quoteId: z.string().min(8).max(64),
  /** Client-generated per tap, so a double tap or retry can't place two orders. */
  idempotencyKey: z.string().min(8).max(64),
  /** The user saw and accepted a visible confirm. */
  confirmed: z.boolean().optional(),
});

export const submitStepsSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().max(64),
        signature: z.string().max(4096).optional(),
        txHash: z.string().max(128).optional(),
        signedTransaction: z.string().max(32768).optional(),
      }),
    )
    .min(1)
    .max(8),
});

export const createThesisSchema = z.object({
  chain: chainKeySchema,
  address: z.string().min(16).max(64),
  body: z.string().min(1).max(THESIS_MAX_LENGTH + 64),
});

export const createReplySchema = z.object({
  body: z.string().min(1).max(REPLY_MAX_LENGTH + 64),
});

export const listThesesSchema = z.object({
  tab: z.enum(["top", "recent", "following"]).default("top"),
  chain: chainKeySchema.optional(),
  address: z.string().max(64).optional(),
  username: z.string().max(32).optional(),
  minPosition: z.coerce.number().min(0).max(1_000_000).optional(),
  sort: z.enum(["liked", "recent"]).optional(),
  includeUnverified: z.coerce.boolean().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

export const signerGrantSchema = z.object({
  perTradeCapUsd: positiveDecimal.optional(),
  dailyCapUsd: positiveDecimal.optional(),
});

export const signerCapsSchema = z.object({
  perTradeCapUsd: positiveDecimal,
  dailyCapUsd: positiveDecimal,
});

export const reportSchema = z
  .object({
    thesisId: z.string().uuid().optional(),
    username: z.string().max(32).optional(),
    reason: z.enum(["spam", "scam", "abuse", "other"]),
    note: z.string().max(500).optional(),
  })
  .refine((r) => r.thesisId || r.username, { message: "report a thesis or a user" });

export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

export const devLoginSchema = z.object({ handle: usernameSchema });

export const paperWithdrawSchema = z.object({
  to: z.string().min(16).max(64),
  amountUsd: positiveDecimal,
});
