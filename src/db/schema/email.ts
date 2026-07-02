import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type EmailOutboxStatus = "PENDING" | "SENT" | "FAILED" | "DEAD";

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    html: text("html").notNull(),
    text: text("text"),
    status: text("status").$type<EmailOutboxStatus>().notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("email_outbox_status_next_idx").on(t.status, t.nextAttemptAt),
    index("email_outbox_email_created_idx").on(t.toEmail, t.createdAt),
  ],
);
