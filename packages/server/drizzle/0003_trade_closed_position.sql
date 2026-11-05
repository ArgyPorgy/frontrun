ALTER TABLE "trades" ADD COLUMN "closed_position" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "trades" t SET "closed_position" = true WHERE t.side = 'sell' AND t.status = 'filled' AND NOT EXISTS (
  SELECT 1 FROM "trades" later WHERE later.user_id = t.user_id AND later.token_chain = t.token_chain AND later.token_addr = t.token_addr
    AND later.status = 'filled' AND later.created_at > t.created_at AND later.side = 'sell'
) AND NOT EXISTS (
  SELECT 1 FROM "positions" p WHERE p.user_id = t.user_id AND p.token_chain = t.token_chain AND p.token_addr = t.token_addr AND p.closed_at IS NULL
);
