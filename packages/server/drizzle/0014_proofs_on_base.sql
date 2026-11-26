ALTER TABLE "reputation_scores" ADD COLUMN "attest_chain" text DEFAULT 'arc' NOT NULL;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "anchor_chain" text DEFAULT 'arc' NOT NULL;--> statement-breakpoint
ALTER TABLE "thesis_position_events" ADD COLUMN "anchor_chain" text DEFAULT 'arc' NOT NULL;--> statement-breakpoint
-- Scores were written to the Arc registry. Clearing what was last written makes the worker write each one again on Base.
UPDATE "reputation_scores" SET "attested_score" = NULL, "attested_closed" = NULL, "attest_attempts" = 0;
