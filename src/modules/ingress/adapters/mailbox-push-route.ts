import { readPush } from "./mailbox-push";

/** The columns a push needs from the mailbox it claims to be about. */
export interface PushMailboxRow {
  readonly crmMailboxSyncId: string;
  readonly organizationId: string;
  readonly provider: "gmail" | "outlook";
  readonly mailboxAddress: string;
  readonly pushSecret: string | null;
  readonly enabled: boolean;
}

export type PushResolution =
  | { readonly ok: true; readonly organizationId: string; readonly crmMailboxSyncId: string }
  | { readonly ok: false };

/**
 * Whether an unauthenticated push may cause a sweep, and of whose mailbox.
 *
 * The ordering is the security argument. The mailbox row is located from the
 * address the notification names, that row's **own** secret verifies the body,
 * and the tenant is read from the row. So a caller who signs correctly for a
 * mailbox they control still cannot name another organisation — the body's
 * opinion about tenancy is never consulted.
 *
 * The notification is a doorbell rather than a delivery. Gmail and Microsoft
 * Graph both say only "something changed for this mailbox"; nothing here reads
 * content out of the body, because a push endpoint that accepted content would
 * let anyone who guessed an address write into a customer's timeline.
 *
 * **Every refusal is the same refusal.** Returning a different answer for a bad
 * signature than for an unknown mailbox turns the endpoint into an oracle for
 * which addresses this deployment syncs, and mailbox addresses are people.
 *
 * A mailbox with no `pushSecret` has never registered a subscription. It refuses
 * rather than falling back to a deployment-wide secret, so the mailbox nobody
 * configured is not the one anybody can ring.
 */
export function resolvePush(
  rawBody: string,
  signature: string | undefined,
  mailbox: PushMailboxRow | null,
): PushResolution {
  if (!mailbox || !mailbox.enabled || !mailbox.pushSecret) return { ok: false };

  const verdict = readPush(rawBody, signature, mailbox.pushSecret, safeParse(rawBody));
  if (!verdict.ok) return { ok: false };

  // The notification has to be about the mailbox we looked up, not merely
  // signed with its secret.
  if (verdict.notification.provider !== mailbox.provider) return { ok: false };
  if (verdict.notification.resource !== mailbox.mailboxAddress) return { ok: false };

  return {
    ok: true,
    organizationId: mailbox.organizationId,
    crmMailboxSyncId: mailbox.crmMailboxSyncId,
  };
}

/** A malformed body is a refusal, never a throw out of an open endpoint. */
function safeParse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
