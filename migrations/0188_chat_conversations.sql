CREATE TABLE IF NOT EXISTS "ai_chat_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_chat_conversations" ADD CONSTRAINT "ai_chat_conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_chat_conversations" ADD CONSTRAINT "ai_chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_chat_conversations_org_user_updated" ON "ai_chat_conversations" USING btree ("org_id","user_id","updated_at");
--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD COLUMN IF NOT EXISTS "conversation_id" integer;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_conversation_id_ai_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_chat_messages_conversation_id" ON "ai_chat_messages" USING btree ("conversation_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_chat_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_chat_conversations" ADD CONSTRAINT "kb_chat_conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_chat_conversations" ADD CONSTRAINT "kb_chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chat_conversations_org_user_updated" ON "kb_chat_conversations" USING btree ("org_id","user_id","updated_at");
--> statement-breakpoint
ALTER TABLE "kb_chat_messages" ADD COLUMN IF NOT EXISTS "conversation_id" integer;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_chat_messages" ADD CONSTRAINT "kb_chat_messages_conversation_id_kb_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."kb_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chat_messages_conversation_id" ON "kb_chat_messages" USING btree ("conversation_id");
--> statement-breakpoint
WITH backfill AS (
  INSERT INTO ai_chat_conversations (org_id, user_id, title, created_at, updated_at)
  SELECT m.org_id, m.user_id, 'Previous conversation', max(m.created_at), max(m.created_at)
  FROM ai_chat_messages m
  WHERE m.conversation_id IS NULL
  GROUP BY m.org_id, m.user_id
  RETURNING id, org_id, user_id
)
UPDATE ai_chat_messages m
SET conversation_id = b.id
FROM backfill b
WHERE m.conversation_id IS NULL
  AND m.org_id = b.org_id
  AND m.user_id = b.user_id;
--> statement-breakpoint
WITH backfill AS (
  INSERT INTO kb_chat_conversations (org_id, user_id, title, created_at, updated_at)
  SELECT m.org_id, m.user_id, 'Previous conversation', max(m.created_at), max(m.created_at)
  FROM kb_chat_messages m
  WHERE m.conversation_id IS NULL
  GROUP BY m.org_id, m.user_id
  RETURNING id, org_id, user_id
)
UPDATE kb_chat_messages m
SET conversation_id = b.id
FROM backfill b
WHERE m.conversation_id IS NULL
  AND m.org_id = b.org_id
  AND m.user_id = b.user_id;
