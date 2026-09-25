import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import { emailOutbox } from "../../../db/schema";
import type { EmailOutboxStatus } from "../../../db/schema/common/email";
import type { Db } from "../../../db/drizzle.module";
import { getBrandName } from "../../email/branding";

/**
 * HRMS-E2E-018. What an administrator is allowed to be told about an invite email.
 *
 * The ticket's acceptance criterion names five states — queued, sent, delivered,
 * bounced, failed. Only three of those are facts this system holds, and this list
 * is deliberately shorter than the criterion rather than padded out to match it.
 *
 * `email_outbox.status` is the entire delivery record: PENDING, SENT, FAILED, DEAD,
 * SUPPRESSED. SENT means the provider's API accepted the message — nothing more.
 * Whether it then reached an inbox is something only a per-message provider receipt
 * could say, and there is none: `EmailWebhookService` receives Resend and ZeptoMail
 * bounce and complaint callbacks, but it writes `email_suppressions` keyed on the
 * ADDRESS and platform-wide, because (its own comment records this) "`email_outbox`
 * has no provider message id to join on, and nothing tags outbound mail with the
 * organisation". So no webhook event can be attributed to a particular invite.
 *
 * Inferring `bounced` from a suppression row for the address would be a guess about
 * which message bounced and when, dressed as an observation — the exact failure this
 * ticket exists to undo, where the UI asserted something the server never said.
 * `delivered` and `bounced` are therefore absent until a provider webhook carries a
 * message id back to an outbox row.
 *
 * `suppressed` is not in the criterion but is genuinely observed: the send was
 * withheld before it left, and an administrator who is not told this sees an invite
 * that is neither queued nor sent nor failed and has no reason to look further.
 */
export const INVITE_DELIVERY_STATUSES = [
  "none",
  "queued",
  "sent",
  "failed",
  "suppressed",
] as const;

export type InviteDeliveryStatus = (typeof INVITE_DELIVERY_STATUSES)[number];

export interface InviteDeliveryState {
  status: InviteDeliveryStatus;
  /** When the outbox row was written. */
  queuedAt: Date | null;
  /** When the provider accepted the message. Null unless `status` is "sent". */
  sentAt: Date | null;
  attempts: number;
  lastError: string | null;
  /**
   * Always false, and a field rather than an omission so the surface has to say so.
   * Nothing in this product observes an inbox delivery, so no caller may treat
   * "sent" as arrival.
   */
  deliveryConfirmed: false;
}

export const NO_INVITE_DELIVERY: InviteDeliveryState = {
  status: "none",
  queuedAt: null,
  sentAt: null,
  attempts: 0,
  lastError: null,
  deliveryConfirmed: false,
};

export function inviteDeliveryStatusOf(
  outboxStatus: EmailOutboxStatus,
): InviteDeliveryStatus {
  switch (outboxStatus) {
    case "PENDING":
      return "queued";
    case "SENT":
      return "sent";
    // A retryable failure and an exhausted one are the same fact to the person
    // reading the screen: it did not go. `attempts` and `lastError` carry the rest.
    case "FAILED":
    case "DEAD":
      return "failed";
    case "SUPPRESSED":
      return "suppressed";
  }
}

export interface InviteOutboxRow {
  status: EmailOutboxStatus;
  createdAt: Date;
  sentAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export function toInviteDeliveryState(
  row: InviteOutboxRow | undefined,
): InviteDeliveryState {
  if (!row) return NO_INVITE_DELIVERY;
  return {
    status: inviteDeliveryStatusOf(row.status),
    queuedAt: row.createdAt,
    sentAt: row.sentAt,
    attempts: row.attempts,
    lastError: row.lastError,
    deliveryConfirmed: false,
  };
}

/**
 * Invite mail carries no kind column, so it is identified by the two subjects the
 * two invite senders produce — `welcomeEmailOptions` and `queueMembershipAddedEmail`.
 * Matching on the address rather than `recipient_user_id` is deliberate: a withheld
 * send is written by `applySuppression`, which records `to_email` but no recipient
 * id, so a recipient-id filter would silently drop exactly the case an administrator
 * most needs to see.
 */
export const MEMBERSHIP_ADDED_SUBJECT_PREFIX = "You've been added to ";

export function inviteOutboxWhere(orgId: string, email: string): SQL | undefined {
  return and(
    eq(emailOutbox.organizationId, orgId),
    eq(emailOutbox.toEmail, email),
    or(
      eq(emailOutbox.subject, `Your ${getBrandName()} account is ready`),
      like(emailOutbox.subject, `${MEMBERSHIP_ADDED_SUBJECT_PREFIX}%`),
    ),
  );
}

/** The most recent invite email for this employee in this tenant, or nothing. */
export async function readInviteDelivery(
  db: Db,
  orgId: string,
  email: string,
): Promise<InviteDeliveryState> {
  const rows = await db
    .select({
      status: emailOutbox.status,
      createdAt: emailOutbox.createdAt,
      sentAt: emailOutbox.sentAt,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
    })
    .from(emailOutbox)
    .where(inviteOutboxWhere(orgId, email))
    .orderBy(desc(emailOutbox.createdAt))
    .limit(1);

  return toInviteDeliveryState(rows[0]);
}
