CREATE TABLE "perp_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pair_index" integer NOT NULL,
	"symbol" text NOT NULL,
	"asset_class" text NOT NULL,
	"side" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"collateral_usd" numeric(38, 18) NOT NULL,
	"leverage" real NOT NULL,
	"entry_price" numeric(38, 18),
	"liquidation_price" numeric(38, 18),
	"take_profit" numeric(38, 18),
	"stop_loss" numeric(38, 18),
	"venue_index" integer,
	"open_tx" text,
	"close_tx" text,
	"close_price" numeric(38, 18),
	"realized_pnl_usd" numeric(38, 18),
	"fees_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"is_paper" boolean DEFAULT false NOT NULL,
	"agent_reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "perp_positions" ADD CONSTRAINT "perp_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "perp_positions_user" ON "perp_positions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "perp_positions_status" ON "perp_positions" USING btree ("status");