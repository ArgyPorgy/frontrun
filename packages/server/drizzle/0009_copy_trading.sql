CREATE TABLE "copy_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"follower_id" uuid NOT NULL,
	"leader_id" uuid NOT NULL,
	"amount_usd" numeric(38, 18) NOT NULL,
	"daily_limit_usd" numeric(38, 18) NOT NULL,
	"copy_sells" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "copied_from_trade_id" uuid;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "copy_processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD CONSTRAINT "copy_settings_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD CONSTRAINT "copy_settings_leader_id_users_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_settings_pair" ON "copy_settings" USING btree ("follower_id","leader_id");--> statement-breakpoint
CREATE INDEX "copy_settings_leader" ON "copy_settings" USING btree ("leader_id");