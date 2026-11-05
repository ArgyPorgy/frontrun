CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_chain" text NOT NULL,
	"token_addr" text NOT NULL,
	"type" text NOT NULL,
	"side" text NOT NULL,
	"amount_usd" numeric(38, 18),
	"sell_pct" real,
	"trigger_price_usd" numeric(38, 18) NOT NULL,
	"engine" text NOT NULL,
	"provider_order_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"trade_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_user" ON "orders" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "orders_open" ON "orders" USING btree ("status","engine");