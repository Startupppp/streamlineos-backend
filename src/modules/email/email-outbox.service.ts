import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, lte } from "drizzle-orm";
import { emailOutbox } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  type EmailOptions,
  getEmailProvider,
  isTransientError,
  sendEmailOnceDirect,
} from "./email.provider";

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;

@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async enqueueAndTry(options: EmailOptions): Promise<void> {
    const toEmail = Array.isArray(options.to) ? options.to.join(",") : options.to;
    const now = new Date();

    const inserted = await this.db
      .insert(emailOutbox)
      .values({
        organizationId: options.organizationId ?? null,
        toEmail,
        subject: options.subject,
        html: options.html,
        text: options.text ?? null,
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })
      .returning({ id: emailOutbox.id });

    const row = inserted[0];
    if (!row) {
      this.logger.error("EMAIL_OUTBOX: insert failed", { to: toEmail, subject: options.subject });
      throw new Error("Failed to enqueue email");
    }

    if (getEmailProvider() === "none") {
      await this.db
        .update(emailOutbox)
        .set({ status: "FAILED", attempts: 1, lastError: "No email provider configured" })
        .where(eq(emailOutbox.id, row.id));
      this.logger.warn("EMAIL_OUTBOX: no provider configured — marked FAILED", {
        id: row.id,
        to: toEmail,
        subject: options.subject,
      });
      throw new Error("No email provider configured");
    }

    try {
      await sendEmailOnceDirect(options);
      await this.db
        .update(emailOutbox)
        .set({ status: "SENT", sentAt: new Date(), attempts: 1 })
        .where(eq(emailOutbox.id, row.id));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const hasAttachments = (options.attachments?.length ?? 0) > 0;
      const retryable = !hasAttachments && isTransientError(err);

      if (retryable) {
        const nextAttemptAt = new Date(Date.now() + 60_000);
        await this.db
          .update(emailOutbox)
          .set({ attempts: 1, lastError: errorMessage, nextAttemptAt })
          .where(eq(emailOutbox.id, row.id));
        this.logger.warn("EMAIL_OUTBOX: initial send failed, queued for retry", {
          id: row.id,
          to: toEmail,
          subject: options.subject,
          error: errorMessage,
        });
        // Queued for cron retry — treat as accepted for callers
        return;
      }

      const reason = hasAttachments ? "has-attachments" : "non-retryable-error";
      await this.db
        .update(emailOutbox)
        .set({ status: "FAILED", attempts: 1, lastError: `${reason}: ${errorMessage}` })
        .where(eq(emailOutbox.id, row.id));
      this.logger.error("EMAIL_OUTBOX: send failed (not retryable)", {
        id: row.id,
        to: toEmail,
        subject: options.subject,
        reason,
        error: errorMessage,
      });
      throw err instanceof Error ? err : new Error(errorMessage);
    }
  }

  async processRetries(): Promise<{ processed: number; sent: number; dead: number }> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, "PENDING"), lte(emailOutbox.nextAttemptAt, now)))
      .limit(BATCH_SIZE);

    let processed = 0;
    let sent = 0;
    let dead = 0;

    for (const row of rows) {
      processed++;
      const newAttempts = row.attempts + 1;
      const to = row.toEmail.split(",").filter(Boolean);

      if (to.length === 0) {
        await this.db
          .update(emailOutbox)
          .set({ status: "DEAD", attempts: newAttempts, lastError: "No valid recipients" })
          .where(eq(emailOutbox.id, row.id));
        dead++;
        continue;
      }

      const emailOptions: EmailOptions = {
        to,
        subject: row.subject,
        html: row.html,
        ...(row.text ? { text: row.text } : {}),
      };

      try {
        await sendEmailOnceDirect(emailOptions);
        await this.db
          .update(emailOutbox)
          .set({ status: "SENT", sentAt: new Date(), attempts: newAttempts, lastError: null })
          .where(eq(emailOutbox.id, row.id));
        sent++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (newAttempts >= MAX_ATTEMPTS) {
          await this.db
            .update(emailOutbox)
            .set({ status: "DEAD", attempts: newAttempts, lastError: errorMessage })
            .where(eq(emailOutbox.id, row.id));
          this.logger.error("EMAIL_OUTBOX: message dead after max retries", {
            id: row.id,
            toEmail: row.toEmail,
            subject: row.subject,
            attempts: newAttempts,
            lastError: errorMessage,
          });
          dead++;
        } else {
          const backoffMinutes = Math.min(Math.pow(2, row.attempts), 60);
          const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60_000);
          await this.db
            .update(emailOutbox)
            .set({ attempts: newAttempts, lastError: errorMessage, nextAttemptAt })
            .where(eq(emailOutbox.id, row.id));
          this.logger.warn("EMAIL_OUTBOX: retry failed, rescheduling", {
            id: row.id,
            attempts: newAttempts,
            nextAttemptAt,
            error: errorMessage,
          });
        }
      }
    }

    return { processed, sent, dead };
  }
}
