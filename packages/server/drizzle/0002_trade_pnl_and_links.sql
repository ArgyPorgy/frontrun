ALTER TABLE "notifications" ADD COLUMN "trade_id" uuid;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "pnl_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "notifications" n SET "trade_id" = (
  SELECT t.id FROM "trades" t
  WHERE t.user_id = n.user_id AND t.token_chain = n.token_chain AND t.token_addr = n.token_addr
    AND t.status IN ('filled', 'failed', 'refunded')
  ORDER BY abs(extract(epoch from t.updated_at - n.created_at)) LIMIT 1
) WHERE n.type = 'trade_update';
