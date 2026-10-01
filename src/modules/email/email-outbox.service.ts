import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
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
import { processRetries } from "./lib/outbox-retries";

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
  if (explicitOrgId) return { organizationId: explicitOrgId, scope: "TENANT" };
  if (explicitOrgId === null) return { organizationId: null, scope: "PLATFORM" };

  const ambient = getTenantContext()?.orgId ?? null;
  if (ambient) return { organizationId: ambient, scope: "TENANT" };

  throw new Error(
    "email outbox: no organization to attribute this send to. Pass organizationId: null for mail that genuinely has no tenant (verification, password reset), or send inside a tenant context.",
  );
}

type DurableEmailOptions = Pick<
  EmailOptions,
  "to" | "subject" | "html" | "text" | "organizationId" | "recipientUserId"
>;

export const INLINE_SEND_BUDGET_MS = 5_000;

export const NO_EMAIL_PROVIDER_REASON =
  "No email provider is configured, so the email could not be sent.";

export const SUPPRESSED_RECIPIENT_REASON =
  "The address is on the email suppression list after a bounce or unsubscribe, so no email was sent.";

export type EmailQueueOutcome = { queued: true } | { queued: false; reason: string };

function isPresent(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  return Array.isArray(value)
    ? value.some((entry) => entry.trim().length > 0)
    : value.trim().length > 0;
}

function rowReproducesSend(options: EmailOptions): boolean {
  if ((options.attachments?.length ?? 0) > 0) return false;
  if (options.headers !== undefined && Object.keys(options.headers).length > 0)
    return false;
  return !isPresent(options.cc) && !isPresent(options.bcc) && !isPresent(options.replyTo);
}

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

  async enqueueOnly(options: EmailOptions): Promise<EmailQueueOutcome> {
    const filtered = await this.applySuppression(options);
    if (!filtered) return { queued: false, reason: SUPPRESSED_RECIPIENT_REASON };
    if (this.emailProvider.getEmailProvider() === "none") {
      await this.recordUnsendable(filtered);
      return { queued: false, reason: NO_EMAIL_PROVIDER_REASON };
    }
    await this.enqueueForDelivery([filtered]);
    return { queued: true };
  }

  async enqueueManyOnly(options: readonly EmailOptions[]): Promise<EmailQueueOutcome[]> {
    if (options.length === 0) return [];

    const scopes = options.map((item) => resolveScope(item.organizationId));
    const scopeKey = (scope: { organizationId: string | null; scope: "PLATFORM" | "TENANT" }) =>
      `${scope.scope}:${scope.organizationId ?? ""}`;
    const firstScope = scopes[0];
    if (!firstScope || scopes.some((scope) => scopeKey(scope) !== scopeKey(firstScope)))
      throw new Error("email outbox: a batched enqueue must use one organization scope");

    const recipients = options.flatMap((item) =>
      Array.isArray(item.to) ? item.to : [item.to],
    );
    const suppressed = await this.suppression.findSuppressed(
      recipients,
      firstScope.organizationId,
    );
    const providerMissing = this.emailProvider.getEmailProvider() === "none";
    const outcomes: EmailQueueOutcome[] = [];
    const pending: DurableEmailOptions[] = [];
    const withheld: Array<{
      options: DurableEmailOptions;
      status: "SUPPRESSED" | "FAILED";
      lastError: string;
    }> = [];

    for (const item of options) {
      const itemRecipients = Array.isArray(item.to) ? item.to : [item.to];
      const deliverable = itemRecipients.filter(
        (recipient) => !suppressed.has(canonicalEmail(recipient)),
      );
      if (deliverable.length === 0) {
        outcomes.push({ queued: false, reason: SUPPRESSED_RECIPIENT_REASON });
        withheld.push({
          options: { ...item, to: itemRecipients },
          status: "SUPPRESSED",
          lastError: "Recipient is on the email suppression list",
        });
        continue;
      }

      const filtered: DurableEmailOptions = {
        ...item,
        to: Array.isArray(item.to) ? deliverable : deliverable[0]!,
      };
      if (providerMissing) {
        outcomes.push({ queued: false, reason: NO_EMAIL_PROVIDER_REASON });
        withheld.push({
          options: filtered,
          status: "FAILED",
          lastError: "No email provider configured",
        });
        continue;
      }

      outcomes.push({ queued: true });
      pending.push(filtered);
    }

    if (withheld.length > 0) {
      await this.db.insert(emailOutbox).values(
        withheld.map(({ options: item, status, lastError }) => {
          const { organizationId, scope } = resolveScope(item.organizationId);
          return {
            organizationId,
            scope,
            toEmail: Array.isArray(item.to) ? item.to.join(",") : item.to,
            subject: item.subject,
            html: status === "SUPPRESSED" ? "" : item.html,
            text: status === "SUPPRESSED" ? null : (item.text ?? null),
            recipientUserId: item.recipientUserId ?? null,
            status,
            attempts: status === "FAILED" ? 1 : 0,
            lastError,
          };
        }),
      );
    }
    await this.enqueueForDelivery(pending);
    return outcomes;
  }

  private async recordUnsendable(options: DurableEmailOptions): Promise<void> {
    const { organizationId, scope } = resolveScope(options.organizationId);
    const toEmail = Array.isArray(options.to) ? options.to.join(",") : options.to;
    await this.db.insert(emailOutbox).values({
      organizationId,
      scope,
      toEmail,
      subject: options.subject,
      html: options.html,
      text: options.text ?? null,
      recipientUserId: options.recipientUserId ?? null,
      status: "FAILED",
      attempts: 1,
      lastError: "No email provider configured",
    });
    this.logger.warn("EMAIL_OUTBOX: no provider configured — marked FAILED", {
      to: toEmail,
      subject: options.subject,
    });
  }

  /**
   * Hands already-queued rows to the provider. Invite mail is inserted inside
   * the token transaction (`enqueueOnly`) so a crash cannot leave a live link
   * with no outbox row. That insert does not talk to the provider; without this
   * step the message stays "queued" until a later worker that may never run.
   */
  async dispatchPendingRecipient(toEmail: string): Promise<{ sent: number }> {
    const rows = await this.db
      .select({
        id: emailOutbox.id,
        subject: emailOutbox.subject,
        html: emailOutbox.html,
        text: emailOutbox.text,
        attempts: emailOutbox.attempts,
      })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.toEmail, toEmail), eq(emailOutbox.status, "PENDING")))
      .orderBy(desc(emailOutbox.createdAt))
      .limit(5);

    if (this.emailProvider.getEmailProvider() === "none") return { sent: 0 };

    let sent = 0;
    for (const row of rows) {
      try {
        await this.emailProvider.sendEmailOnceDirect(
          { to: toEmail, subject: row.subject, html: row.html, text: row.text ?? undefined },
          INLINE_SEND_BUDGET_MS,
        );
        await this.db
          .update(emailOutbox)
          .set({ status: "SENT", sentAt: new Date(), attempts: row.attempts + 1 })
          .where(eq(emailOutbox.id, row.id));
        sent += 1;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.db
          .update(emailOutbox)
          .set({
            attempts: row.attempts + 1,
            lastError: errorMessage,
            nextAttemptAt: new Date(Date.now() + 60_000),
          })
          .where(eq(emailOutbox.id, row.id));
        this.logger.warn("EMAIL_OUTBOX: handoff failed, left queued for retry", {
          id: row.id,
          to: toEmail,
          error: errorMessage,
        });
      }
    }
    return { sent };
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

    const reproducible = rowReproducesSend(options);

    try {
      await this.emailProvider.sendEmailOnceDirect(
        options,
        reproducible ? INLINE_SEND_BUDGET_MS : undefined,
      );
      await this.db
        .update(emailOutbox)
        .set({ status: "SENT", sentAt: new Date(), attempts: 1 })
        .where(eq(emailOutbox.id, row.id));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const retryable = reproducible && isTransientError(err);

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

      const reason = reproducible
        ? "non-retryable-error"
        : "not-reproducible-from-outbox-row";
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

  /** @see lib/outbox-retries.ts */
  async processRetries(): Promise<{ processed: number; sent: number; dead: number }> {
    return processRetries({
      db: this.db,
      logger: this.logger,
      emailProvider: this.emailProvider,
    });
  }
}
