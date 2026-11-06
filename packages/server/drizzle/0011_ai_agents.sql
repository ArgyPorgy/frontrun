CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"summary" text,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"model" text NOT NULL,
	"strategy" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"per_trade_usd" numeric(38, 18) NOT NULL,
	"daily_limit_usd" numeric(38, 18) NOT NULL,
	"think_every_minutes" integer DEFAULT 60 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "agent_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "agent_model" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_messages_agent" ON "agent_messages" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_messages_pending" ON "agent_messages" USING btree ("created_at") WHERE role = 'owner' and handled_at is null;--> statement-breakpoint
CREATE INDEX "agent_runs_agent" ON "agent_runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_created" ON "agent_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agents_owner" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agents_due" ON "agents" USING btree ("next_run_at") WHERE enabled;--> statement-breakpoint
CREATE INDEX "users_agent_owner" ON "users" USING btree ("agent_owner_id");