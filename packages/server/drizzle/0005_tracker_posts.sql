CREATE TABLE "tracker_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"author_handle" text NOT NULL,
	"author_name" text NOT NULL,
	"author_avatar" text,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"url" text NOT NULL,
	"tokens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tracker_posts_feed" ON "tracker_posts" USING btree ("source","posted_at");