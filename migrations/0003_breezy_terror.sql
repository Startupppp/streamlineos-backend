CREATE TYPE "public"."broadcast_status" AS ENUM('DRAFT', 'SCHEDULED', 'QUEUED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('QUEUED', 'PROCESSING', 'DELIVERED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('SECURITY', 'CRM', 'HRMS', 'BILLING', 'AI', 'PROJECTS', 'WORKFLOW', 'MARKETING', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('IN_APP', 'EMAIL', 'PUSH', 'SMS', 'WHATSAPP', 'SLACK', 'TEAMS', 'WEBHOOK');--> statement-breakpoint
CREATE TYPE "public"."notification_priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"type" "notification_type" DEFAULT 'INFO' NOT NULL,
	"priority" "notification_priority" DEFAULT 'NORMAL' NOT NULL,
	"category" "notification_category" DEFAULT 'SYSTEM' NOT NULL,
	"channels" jsonb DEFAULT '["IN_APP"]'::jsonb NOT NULL,
	"audience" jsonb NOT NULL,
	"status" "broadcast_status" DEFAULT 'DRAFT' NOT NULL,
	"scheduled_at" timestamp,
	"sent_at" timestamp,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"notification_id" integer,
	"broadcast_id" integer,
	"actor_id" text,
	"action" text NOT NULL,
	"source_module" text,
	"channel" text,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"template_key" text NOT NULL,
	"name" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"category" "notification_category" DEFAULT 'SYSTEM' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_notification_templates_key_locale_version" UNIQUE("org_id","template_key","locale","version")
);
--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "channel" SET DEFAULT 'IN_APP';--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "slack_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "teams_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "whatsapp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "sound_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "quiet_hours_timezone" text DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "digest_mode" text DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "channel_categories" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "priority" "notification_priority" DEFAULT 'NORMAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "category" "notification_category" DEFAULT 'SYSTEM' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "source_module" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "snoozed_until" timestamp;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_audit_logs" ADD CONSTRAINT "notification_audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_audit_logs" ADD CONSTRAINT "notification_audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_broadcasts_org_status" ON "broadcasts" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_broadcasts_scheduled" ON "broadcasts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_broadcasts_created_by" ON "broadcasts" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_notif_audit_org_action" ON "notification_audit_logs" USING btree ("org_id","action");--> statement-breakpoint
CREATE INDEX "idx_notif_audit_org_created" ON "notification_audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notif_audit_notification" ON "notification_audit_logs" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "idx_notification_templates_org" ON "notification_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_notification_templates_channel" ON "notification_templates" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "idx_notification_templates_active" ON "notification_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_archived" ON "notifications" USING btree ("user_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_org_category" ON "notifications" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_notifications_priority" ON "notifications" USING btree ("priority");