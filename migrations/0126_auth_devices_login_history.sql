CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"browser" text,
	"os" text,
	"platform" text,
	"trusted" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_history" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"event" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"country" text,
	"city" text,
	"success" boolean DEFAULT true NOT NULL,
	"failure_reason" text,
	"device_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "expires_at" timestamp;
--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_revoked_last" ON "user_sessions" USING btree ("user_id","is_revoked","last_active");
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_devices_user_fingerprint" ON "devices" USING btree ("user_id","fingerprint");
--> statement-breakpoint
CREATE INDEX "idx_devices_user" ON "devices" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_login_history_user_created" ON "login_history" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_login_history_org_created" ON "login_history" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_login_history_user_success" ON "login_history" USING btree ("user_id","success");
