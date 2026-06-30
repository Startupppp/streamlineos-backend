CREATE TYPE "public"."enterprise_quote_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "enterprise_quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_ref" text NOT NULL,
	"subject" text NOT NULL,
	"plan_tier" text DEFAULT 'ENTERPRISE' NOT NULL,
	"requested_seats" integer DEFAULT 0 NOT NULL,
	"negotiated_seats" integer DEFAULT 0 NOT NULL,
	"price_per_seat_in_paise" integer DEFAULT 0 NOT NULL,
	"contract_term_months" integer DEFAULT 12 NOT NULL,
	"contract_terms" text,
	"status" "enterprise_quote_status" DEFAULT 'DRAFT' NOT NULL,
	"approver_id" text,
	"approval_notes" text,
	"approved_at" timestamp,
	"sent_at" timestamp,
	"accepted_at" timestamp,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"valid_until" date NOT NULL,
	"notes" text,
	"deal_id" integer,
	"client_id" integer,
	"created_by_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::text;--> statement-breakpoint
UPDATE "invoices" SET "status" = 'ISSUED' WHERE "status" = 'SENT';--> statement-breakpoint
UPDATE "invoices" SET "status" = 'FAILED' WHERE "status" = 'OVERDUE';--> statement-breakpoint
UPDATE "invoices" SET "status" = 'VOIDED' WHERE "status" = 'CANCELLED';--> statement-breakpoint
DROP TYPE "public"."invoice_status";--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'PAID', 'FAILED', 'VOIDED');--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DATA TYPE "public"."invoice_status" USING "status"::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_client_id_client_accounts_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ent_quotes_org_status" ON "enterprise_quotes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_ent_quotes_deal" ON "enterprise_quotes" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_ent_quotes_client" ON "enterprise_quotes" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ent_quotes_ref" ON "enterprise_quotes" USING btree ("org_id","quote_ref");