import type {
  InboundChannel,
  InboundCommunicationEvent,
  InboundParticipant,
} from "../inbound-event";

/**
 * Turning a mailbox message into the one event shape.
 *
 * This file's entire responsibility is that translation. It resolves no
 * parties, writes nothing, calls nothing — because ticket 10's seam exists so
 * that adding a channel requires no change below it, and an adapter that starts
 * making decisions is an adapter that has to be re-tested through the whole
 * pipeline every time a provider changes a field name.
 *
 * The tests for this file assert nothing beyond the shape, deliberately.
 * Everything downstream is exercised by driving a fixture event through the
 * seam, which is why no test in this repo mocks a provider SDK.
 */

/** The subset of a normalised mail message this needs. */
export interface MailMessageForIngress {
  readonly id: string;
  readonly threadId: string | null;
  readonly from: { readonly email?: string | null; readonly name?: string | null } | null;
  readonly to?: readonly { readonly email?: string | null; readonly name?: string | null }[];
  readonly cc?: readonly { readonly email?: string | null; readonly name?: string | null }[];
  readonly subject?: string | null;
  readonly bodyText?: string | null;
  readonly bodyHtml?: string | null;
  readonly snippet?: string | null;
  readonly date?: string | null;
  /** Labels or folders, as the provider names them. */
  readonly labels?: readonly string[];
}

export interface MailIngressContext {
  readonly organizationId: string;
  /** `gmail` or `outlook`; only used for the deduplication key. */
  readonly provider: string;
  /** The mailbox this arrived in, so a reply from the owner is not a stranger. */
  readonly mailboxAddress: string;
}

export type MailIngressResult =
  | { readonly ok: true; readonly event: InboundCommunicationEvent }
  | { readonly ok: false; readonly reason: MailSkipReason };

export type MailSkipReason =
  | "private"
  | "no-sender"
  | "no-identifier"
  | "own-mailbox-noise";

/**
 * Labels a person uses to keep a message out of the CRM.
 *
 * Compared case-insensitively against the provider's own labels and folders,
 * because a person marking mail private is doing it in their mail client and
 * has no idea this system exists. `Private` and `CRM-Exclude` are the two
 * conventions worth honouring by default; a tenant can be given more later, but
 * honouring none by default would make personal mail a support ticket rather
 * than a setting.
 */
const PRIVATE_LABELS = new Set([
  "private",
  "personal",
  "confidential",
  "crm-exclude",
  "no-crm",
]);

/** Folders whose contents are not correspondence with anybody. */
const EXCLUDED_FOLDERS = new Set(["spam", "junk", "junk email", "trash", "deleted items", "drafts"]);

function isPrivate(labels: readonly string[] | undefined): boolean {
  if (!labels) return false;
  return labels.some((label) => {
    const normalised = label.trim().toLowerCase();
    return PRIVATE_LABELS.has(normalised) || EXCLUDED_FOLDERS.has(normalised);
  });
}

function addressOf(
  party: { readonly email?: string | null; readonly name?: string | null } | null | undefined,
): { address: string; displayName?: string } | null {
  const address = party?.email?.trim().toLowerCase();
  if (!address) return null;
  const displayName = party?.name?.trim();
  return displayName ? { address, displayName } : { address };
}

/**
 * A mail message as an inbound communication event, or a reason it is not one.
 *
 * Refusing is half the job. A message with no sender cannot be attributed, one
 * with no provider id cannot be deduplicated, and a private one must never
 * reach the CRM at all — and each of those is a skip with a name rather than a
 * throw, because the caller is a sync loop and one odd message must not stop
 * the mailbox.
 */
export function mailToInboundEvent(
  message: MailMessageForIngress,
  context: MailIngressContext,
): MailIngressResult {
  // Checked first: a private message should not even be inspected further.
  if (isPrivate(message.labels)) return { ok: false, reason: "private" };

  if (!message.id?.trim()) return { ok: false, reason: "no-identifier" };

  const from = addressOf(message.from);
  if (!from) return { ok: false, reason: "no-sender" };

  const participants: InboundParticipant[] = [
    { ...from, role: "from" },
    ...(message.to ?? []).map(addressOf).filter(nonNull).map((p) => ({ ...p, role: "to" as const })),
    ...(message.cc ?? []).map(addressOf).filter(nonNull).map((p) => ({ ...p, role: "cc" as const })),
  ];

  /**
   * A message the mailbox owner sent to nobody but themselves carries no
   * correspondent, so there is no party for the CRM to file it against.
   */
  const others = participants.filter(
    (participant) => participant.address !== context.mailboxAddress.trim().toLowerCase(),
  );
  if (others.length === 0) return { ok: false, reason: "own-mailbox-noise" };

  return {
    ok: true,
    event: {
      organizationId: context.organizationId,
      channel: "email" satisfies InboundChannel,
      provider: context.provider,
      providerMessageId: message.id,
      /**
       * The provider's own thread id, never a subject line.
       *
       * Subjects are edited, translated and reused; two unrelated conversations
       * both called "Re: Invoice" are one thread if you infer from the subject,
       * and a renamed thread splits in two. The provider already knows the
       * answer and it is stable.
       */
      providerThreadId: message.threadId ?? null,
      occurredAt: normaliseDate(message.date),
      subject: message.subject?.trim() || null,
      // Text over HTML: the pipeline caps and reads this, and stripping markup
      // downstream would mean every consumer re-implementing it.
      body: message.bodyText?.trim() || message.snippet?.trim() || null,
      participants,
    },
  };
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * A timestamp the rest of the system can rely on.
 *
 * Providers send several formats and occasionally something unparseable. An
 * invalid date would become `Invalid Date` and then `null` in the database,
 * losing when a conversation happened; falling back to now is wrong by minutes
 * rather than wrong by everything.
 */
function normaliseDate(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
