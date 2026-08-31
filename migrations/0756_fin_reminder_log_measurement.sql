ALTER TABLE "fin_reminder_log" ADD COLUMN "scheduled_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE "fin_reminder_log" ADD COLUMN "paid_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "fin_reminder_log" ALTER COLUMN "sent_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "fin_reminder_log" ALTER COLUMN "sent_at" DROP DEFAULT;
