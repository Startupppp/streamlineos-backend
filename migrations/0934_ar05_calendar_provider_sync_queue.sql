SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "calendar_provider_sync_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"event_id" integer,
	"connection_id" integer NOT NULL,
	"operation" text NOT NULL,
	"external_event_id" text,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "calendar_provider_sync_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "idx_cal_provider_sync_queue_pending" ON "calendar_provider_sync_queue" ("state","id") WHERE state IN ('PENDING','IN_FLIGHT');
--> statement-breakpoint
CREATE INDEX "idx_cal_provider_sync_queue_org" ON "calendar_provider_sync_queue" ("org_id","state");
