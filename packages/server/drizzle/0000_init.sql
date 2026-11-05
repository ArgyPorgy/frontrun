CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"detail" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_followee_id_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "gas_topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"amount_wei" text NOT NULL,
	"cost_usd" numeric(38, 18) NOT NULL,
	"tx_hash" text NOT NULL,
	"trade_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"user_id" uuid NOT NULL,
	"thesis_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_user_id_thesis_id_pk" PRIMARY KEY("user_id","thesis_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid,
	"thesis_id" uuid,
	"token_chain" text,
	"token_addr" text,
	"message" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_chain" text NOT NULL,
	"token_addr" text NOT NULL,
	"qty" numeric(60, 18) DEFAULT '0' NOT NULL,
	"cost_basis_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"realized_pnl_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"thesis_id" uuid,
	"target_user_id" uuid,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signer_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"per_trade_cap_usd" numeric(38, 18) NOT NULL,
	"daily_cap_usd" numeric(38, 18) NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"approval_tx" text
);
--> statement-breakpoint
CREATE TABLE "theses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_chain" text NOT NULL,
	"token_addr" text NOT NULL,
	"body" text NOT NULL,
	"price_at_post" numeric(38, 18) NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"position_usd_at_post" numeric(38, 18) DEFAULT '0' NOT NULL,
	"author_avg_entry" numeric(38, 18),
	"verified" boolean DEFAULT false NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"rank_score" real DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"price_at_resolve" numeric(38, 18),
	"return_pct" real,
	"resolved_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"hidden_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "thesis_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"decimals" integer,
	"image_url" text,
	"denylisted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"side" text NOT NULL,
	"token_chain" text NOT NULL,
	"token_addr" text NOT NULL,
	"usd_in" numeric(38, 18),
	"usd_out" numeric(38, 18),
	"qty" numeric(60, 18),
	"price_usd" numeric(38, 18),
	"fee_usd" numeric(38, 18),
	"provider" text NOT NULL,
	"provider_order_id" text,
	"src_chain" text NOT NULL,
	"src_tx" text,
	"dst_tx" text,
	"status" text NOT NULL,
	"error" text,
	"is_paper" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"copied_thesis_id" uuid,
	"exec_state" jsonb,
	"applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_id" text NOT NULL,
	"username" text NOT NULL,
	"username_set" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"is_banned" boolean DEFAULT false NOT NULL,
	"paper_balance_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_privy_id_unique" UNIQUE("privy_id")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_type" text NOT NULL,
	"address" text NOT NULL,
	"is_embedded" boolean DEFAULT true NOT NULL,
	"privy_wallet_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gas_topups" ADD CONSTRAINT "gas_topups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer_grants" ADD CONSTRAINT "signer_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_replies" ADD CONSTRAINT "thesis_replies_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_replies" ADD CONSTRAINT "thesis_replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_user" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_action" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "follows_followee" ON "follows" USING btree ("followee_id");--> statement-breakpoint
CREATE INDEX "gas_topups_user" ON "gas_topups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_open_unique" ON "positions" USING btree ("user_id","token_chain","token_addr") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "positions_user" ON "positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "positions_open" ON "positions" USING btree ("token_chain","token_addr") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "provider_events_lookup" ON "provider_events" USING btree ("provider","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_one_per_thesis" ON "reports" USING btree ("reporter_id","thesis_id");--> statement-breakpoint
CREATE INDEX "reports_thesis" ON "reports" USING btree ("thesis_id");--> statement-breakpoint
CREATE INDEX "signer_grants_user" ON "signer_grants" USING btree ("user_id","granted_at");--> statement-breakpoint
CREATE INDEX "theses_token_ts" ON "theses" USING btree ("token_chain","token_addr","ts");--> statement-breakpoint
CREATE INDEX "theses_user_ts" ON "theses" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "theses_rank" ON "theses" USING btree ("rank_score");--> statement-breakpoint
CREATE INDEX "theses_ts" ON "theses" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "theses_unresolved" ON "theses" USING btree ("ts") WHERE outcome = 'pending' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "thesis_replies_thesis" ON "thesis_replies" USING btree ("thesis_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_idempotency" ON "trades" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "trades_user_created" ON "trades" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_active" ON "trades" USING btree ("status") WHERE status in ('pending','source_confirmed');--> statement-breakpoint
CREATE INDEX "trades_token" ON "trades" USING btree ("token_chain","token_addr");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_address" ON "wallets" USING btree ("chain_type","address");--> statement-breakpoint
CREATE INDEX "wallets_user" ON "wallets" USING btree ("user_id");