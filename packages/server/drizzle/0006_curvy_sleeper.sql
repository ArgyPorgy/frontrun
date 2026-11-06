ALTER TABLE "trades" ADD COLUMN "revenue_usd" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Flash's fill fee was 0 until the app's fee went on, and has been only that fee since. Uniswap's quote says what it charged.
UPDATE "trades" SET "revenue_usd" = COALESCE("fee_usd", 0) WHERE "status" = 'filled' AND "provider" = 'flash';--> statement-breakpoint
UPDATE "trades" SET "revenue_usd" = COALESCE(("exec_state"->'quote'->>'feeUsd')::numeric, 0) WHERE "status" = 'filled' AND "provider" = 'uniswap';
