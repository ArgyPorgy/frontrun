-- A thesis is now judged only on the profit realized when its author sells out. This clears every earlier
-- judgement, and the worker scores the closed ones again from their actual sales.
UPDATE "theses" SET "outcome" = 'pending', "price_at_resolve" = NULL, "return_pct" = NULL, "resolved_at" = NULL WHERE "outcome" <> 'pending';
