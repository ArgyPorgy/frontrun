ALTER TABLE "theses" ADD COLUMN "anchor_payload" text;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "anchor_hash" text;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "anchor_tx" text;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "anchored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "anchor_attempts" integer DEFAULT 0 NOT NULL;