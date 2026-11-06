CREATE TABLE "reputation_scores" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"score" integer NOT NULL,
	"closed" integer NOT NULL,
	"wins" integer NOT NULL,
	"win_rate_pct" real NOT NULL,
	"avg_return_pct" real NOT NULL,
	"avg_drawdown_pct" real NOT NULL,
	"avg_hold_seconds" integer NOT NULL,
	"fee_pct" real NOT NULL,
	"components" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attested_score" integer,
	"attested_closed" integer,
	"attest_tx" text,
	"attested_at" timestamp with time zone,
	"attest_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thesis_position_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" uuid NOT NULL,
	"trade_id" uuid,
	"action" text NOT NULL,
	"qty_after" numeric(60, 18) NOT NULL,
	"held_bps" integer NOT NULL,
	"price_usd" numeric(38, 18),
	"occurred_at" timestamp with time zone NOT NULL,
	"anchor_tx" text,
	"anchored_at" timestamp with time zone,
	"anchor_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "qty_at_post" numeric(60, 18);--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "held_qty" numeric(60, 18);--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "held_bps" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "position_status" text DEFAULT 'holding' NOT NULL;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "position_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "position_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "low_price_since_post" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "proof_processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reputation_scores" ADD CONSTRAINT "reputation_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_position_events" ADD CONSTRAINT "thesis_position_events_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reputation_scores_rank" ON "reputation_scores" USING btree ("score");--> statement-breakpoint
CREATE UNIQUE INDEX "thesis_position_events_trade" ON "thesis_position_events" USING btree ("thesis_id","trade_id");--> statement-breakpoint
CREATE INDEX "thesis_position_events_thesis" ON "thesis_position_events" USING btree ("thesis_id","occurred_at");--> statement-breakpoint
CREATE INDEX "thesis_position_events_unanchored" ON "thesis_position_events" USING btree ("occurred_at") WHERE anchor_tx is null;--> statement-breakpoint
CREATE INDEX "theses_position_check" ON "theses" USING btree ("position_checked_at") WHERE verified and position_status <> 'exited';
--> statement-breakpoint
-- What a thesis's author held when posting, worked out for theses from before this was recorded.
UPDATE "theses" SET "qty_at_post" = "position_usd_at_post" / "price_at_post", "held_qty" = "position_usd_at_post" / "price_at_post" WHERE "verified" AND "price_at_post" > 0;
--> statement-breakpoint
-- Before lows were tracked, the only prices on record are the post and the sale.
UPDATE "theses" SET "low_price_since_post" = LEAST("price_at_post", COALESCE("price_at_resolve", "price_at_post")) WHERE "verified";
