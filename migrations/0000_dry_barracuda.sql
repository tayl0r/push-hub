CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_slug" text NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "push_tokens_app_token_unique" UNIQUE("app_slug","token")
);
--> statement-breakpoint
CREATE INDEX "push_tokens_app_user_idx" ON "push_tokens" USING btree ("app_slug","user_id");