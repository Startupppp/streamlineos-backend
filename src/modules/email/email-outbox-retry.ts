import type { Logger } from "@nestjs/common";
import { and, eq, lte } from "drizzle-orm";
import { emailOutbox } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { EmailOptions } from "./email.provider";
import type { EmailDispatcher } from "./email-provider-selection";
import { filterOrgMemberIds } from "../../common/tenant/org-membership";

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;

export interface EmailOutboxRetryResult {
  processed: number;
  sent: number;
  dead: number;
}

export async function drainEmailOutboxRetries(
  db: Db,
  emailProvider: EmailDispatcher,
  logger: Logger,
): Promise<EmailOutboxRetryResult> {
  const now = new Date();
  const rows = await db
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
      await db
        .update(emailOutbox)
        .set({ status: "DEAD", attempts: newAttempts, lastError: "No valid recipients" })
        .where(eq(emailOutbox.id, row.id));
      dead++;
      continue;
    }

    if (row.recipientUserId && row.organizationId) {
      const stillActive = await filterOrgMemberIds(db, row.organizationId, [row.recipientUserId]);
      if (stillActive.length === 0) {
        await db
          .update(emailOutbox)
          .set({ status: "SUPPRESSED", attempts: newAttempts, lastError: "Recipient is no longer an active org member" })
          .where(eq(emailOutbox.id, row.id));
        logger.warn("EMAIL_OUTBOX: retry suppressed — recipient membership revoked", {
          id: row.id,
          toEmail: row.toEmail,
          recipientUserId: row.recipientUserId,
          organizationId: row.organizationId,
        });
        dead++;
        continue;
      }
    }

    const emailOptions: EmailOptions = {
      to,
      subject: row.subject,
      html: row.html,
      ...(row.text ? { text: row.text } : {}),
    };

    try {
      await emailProvider.sendEmailOnceDirect(emailOptions);
      await db
        .update(emailOutbox)
        .set({ status: "SENT", sentAt: new Date(), attempts: newAttempts, lastError: null })
        .where(eq(emailOutbox.id, row.id));
      sent++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (newAttempts >= MAX_ATTEMPTS) {
        await db
          .update(emailOutbox)
          .set({ status: "DEAD", attempts: newAttempts, lastError: errorMessage })
          .where(eq(emailOutbox.id, row.id));
        logger.error("EMAIL_OUTBOX: message dead after max retries", {
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
        await db
          .update(emailOutbox)
          .set({ attempts: newAttempts, lastError: errorMessage, nextAttemptAt })
          .where(eq(emailOutbox.id, row.id));
        logger.warn("EMAIL_OUTBOX: retry failed, rescheduling", {
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
