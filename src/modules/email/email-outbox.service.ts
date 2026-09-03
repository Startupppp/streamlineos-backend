import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { emailOutbox } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  type EmailOptions,
  isTransientError,
  EmailProviderService,
} from "./email.provider";
import type { EmailDispatcher } from "./email-provider-selection";
import { EmailSuppressionService, canonicalEmail } from "./email-suppression.service";
import { getTenantContext } from "../../common/tenant/tenant-context";
import { drainEmailOutboxRetries } from "./email-outbox-retry";

/**
 * SCH-014. Callers almost never passed `organizationId`, so every one of the 34 rows in
 * the table was NULL — and the old RLS policy treated a NULL organization as visible to
 * every tenant. Rather than edit 75 call sites (and rely on the 76th remembering), the
 * organization is taken from the ambient tenant context, which every authenticated
 * request already establishes. An explicit argument still wins.
 *
 * What is left NULL after this is genuinely tenant-less: verification and password-reset
 * mail, sent before the user belongs to anywhere. Those are marked PLATFORM.
 */
function resolveScope(explicitOrgId: string | null | undefined): {
  organizationId: string | null;
  scope: "PLATFORM" | "TENANT";
} {
  const orgId = explicitOrgId ?? getTenantContext()?.orgId ?? null;
  return orgId ? { organizationId: orgId, scope: "TENANT" } : { organizationId: null, scope: "PLATFORM" };
}

type DurableEmailOptions = Pick<
  EmailOptions,
  "to" | "subject" | "html" | "text" | "organizationId" | "recipientUserId"
>;

@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly suppression: EmailSuppressionService,
    @Inject(EmailProviderService) private readonly emailProvider: EmailDispatcher,
  ) {}

  /**
   * Drops suppressed recipients. Returns null when nothing is left to send, in
   * which case a SUPPRESSED outbox row records that the send was withheld — callers
   * must not be able to tell the difference, since many `void` this method and a
   * throw would surface as an unhandled rejection on an unrelated request.
   */
  private async applySuppression(options: EmailOptions): Promise<EmailOptions | null> {
    const recipients = Array.isArray(options.to) ? options.to : [options.to];
    const { organizationId: orgId, scope } = resolveScope(options.organizationId);
    const suppressed = await this.suppression.findSuppressed(recipients, orgId);
    if (suppressed.size === 0) return options;

    const remaining = recipients.filter((r) => !suppressed.has(canonicalEmail(r)));

    await this.db.insert(emailOutbox).values({
      organizationId: orgId,
      scope,
      toEmail: [...suppressed].join(","),
      subject: options.subject,
      // The body is deliberately not stored for a withheld send: there is no
      // delivery to reconstruct, and email_outbox has no retention sweep (SEC-009).
      html: "",
      status: "SUPPRESSED",
      attempts: 0,
      lastError: "Recipient is on the email suppression list",
    });

    this.logger.warn(
      `EMAIL_OUTBOX: ${suppressed.size} recipient(s) suppressed, ${remaining.length} remaining`,
      { subject: options.subject },
    );

    if (remaining.length === 0) return null;
    return { ...options, to: Array.isArray(options.to) ? remaining : remaining[0] };
  }

  async enqueueForDelivery(
    options: readonly DurableEmailOptions[],
  ): Promise<number> {
    if (options.length === 0) return 0;

    const now = new Date();
    const inserted = await this.db
      .insert(emailOutbox)
      .values(
        options.map((item) => {
          const { organizationId, scope } = resolveScope(item.organizationId);
          return {
            organizationId,
            scope,
            toEmail: Array.isArray(item.to) ? item.to.join(",") : item.to,
            subject: item.subject,
            html: item.html,
            text: item.text ?? null,
            recipientUserId: item.recipientUserId ?? null,
            status: "PENDING" as const,
            attempts: 0,
            nextAttemptAt: now,
            createdAt: now,
          };
        }),
      )
      .returning({ id: emailOutbox.id });

    if (inserted.length !== options.length)
      throw new Error("Failed to enqueue all emails");
    return inserted.length;
  }

  async enqueueAndTry(options: EmailOptions): Promise<void> {
    // SEC-002/SEC-003: the suppression gate. Every named sender on EmailService
    // routes through here, so this one check covers all 75 direct-send call sites.
    // It applies to mandatory notification types too — a hard-bounced address is
    // not deliverable regardless of policy, and continuing to send to it degrades
    // delivery for every other recipient on the domain.
    const filtered = await this.applySuppression(options);
    if (!filtered) return;
    options = filtered;

    const toEmail = Array.isArray(options.to) ? options.to.join(",") : options.to;
    const now = new Date();
    const { organizationId, scope } = resolveScope(options.organizationId);

    const inserted = await this.db
      .insert(emailOutbox)
      .values({
        organizationId,
        scope,
        toEmail,
        subject: options.subject,
        html: options.html,
        text: options.text ?? null,
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        recipientUserId: options.recipientUserId ?? null,
      })
      .returning({ id: emailOutbox.id });

    const row = inserted[0];
    if (!row) {
      this.logger.error("EMAIL_OUTBOX: insert failed", { to: toEmail, subject: options.subject });
      throw new Error("Failed to enqueue email");
    }

    if (this.emailProvider.getEmailProvider() === "none") {
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
      await this.emailProvider.sendEmailOnceDirect(options);
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
    return drainEmailOutboxRetries(this.db, this.emailProvider, this.logger);
  }
}
