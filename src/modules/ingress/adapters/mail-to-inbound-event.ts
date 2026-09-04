import type {
  InboundChannel,
  InboundCommunicationEvent,
  InboundParticipant,
} from "../inbound-event";
import { isPrivate } from "./mail-ingress-privacy";

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
  readonly date: string | null;
  /**
   * Labels or folders as the provider names them, or `null` when the provider
   * did not say.
   *
   * Required rather than optional, and nullable rather than defaulted, because
   * this is the field the privacy rule turns on. An optional `labels?` reads as
   * "absent means none", every caller that forgets it compiles, and a message
   * somebody marked private is filed into the CRM with nobody the wiser — which
   * is exactly what a `as unknown as` cast over a provider type that has no
   * labels at all used to do here. `null` forces the caller to say so, and
   * saying so is refused below.
   */
  readonly labels: readonly string[] | null;
}

/**
 * Who applied the "keep this out of the CRM" rule for these messages.
 *
 * `message-labels` — the provider handed over each message's own labels and
 * this adapter decides. The strongest form: the evidence is in front of us.
 *
 * `provider-query` — the provider was asked to withhold labelled mail as part
 * of the same query that bounds the sweep by date, so a message arriving here
 * has already been through the filter and carrying no labels is not a gap.
 * Weaker, because it cannot be verified from what comes back — used only where
 * the provider's own client offers no way to see a message's labels.
 */
export type PrivateLabelRule = "message-labels" | "provider-query";

export interface MailIngressContext {
  readonly organizationId: string;
  /** `gmail` or `outlook`; only used for the deduplication key. */
  readonly provider: string;
  /** The mailbox this arrived in, so a reply from the owner is not a stranger. */
  readonly mailboxAddress: string;
  /** How the sweep that produced this message enforced the private-label rule. */
  readonly privateLabelRule: PrivateLabelRule;
}

export type MailIngressResult =
  | {
      readonly ok: true;
      readonly event: InboundCommunicationEvent;
      /**
       * The provider gave no usable timestamp and `occurredAt` is this instant
       * rather than when the message happened.
       *
       * The caller needs to know because it moves a watermark: a single
       * malformed `Date:` header would otherwise set "everything up to now has
       * been read" and skip whatever the provider had not yet indexed.
       */
      readonly occurredAtEstimated: boolean;
    }
  | { readonly ok: false; readonly reason: MailSkipReason };

export type MailSkipReason =
  | "private"
  | "labels-unknown"
  | "no-sender"
  | "no-identifier"
  | "own-mailbox-noise";

/** The seam's own limit, matched so an in-process caller cannot exceed the wire's. */
const MAX_BODY_CHARS = 100_000;

function addressOf(
  party: { readonly email?: string | null; readonly name?: string | null } | null | undefined,
): { address: string; displayName?: string; identifierKind: "email" } | null {
  const address = party?.email?.trim().toLowerCase();
  if (!address) return null;
  const displayName = party?.name?.trim();
  /**
   * Stated even though the channel would imply it.
   *
   * `identifierKindOf` falls back to the channel only for events stored before
   * adapters carried the kind. A live adapter that relies on the fallback is one
   * whose participants stop being labelled the day the channel it uses gains a
   * second meaning — which is exactly what happened to `message`.
   */
  const identifierKind = "email" as const;
  return displayName ? { address, displayName, identifierKind } : { address, identifierKind };
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
  /**
   * Checked first: a private message should not even be inspected further.
   *
   * And when the labels are unknown the answer is to refuse, not to assume the
   * message is fair game. Filing somebody's private mail into a shared CRM
   * cannot be undone by an apology, whereas a provider whose labels we cannot
   * read yet ingests nothing until it can — which is visible, and recoverable.
   */
  if (message.labels) {
    if (isPrivate(message.labels)) return { ok: false, reason: "private" };
  } else if (context.privateLabelRule !== "provider-query") {
    return { ok: false, reason: "labels-unknown" };
  }

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

  const occurredAt = normaliseDate(message.date);

  return {
    ok: true,
    occurredAtEstimated: occurredAt.estimated,
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
      occurredAt: occurredAt.iso,
      subject: message.subject?.trim() || null,
      body: bodyOf(message),
      participants,
    },
  };
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * The message as text.
 *
 * Text over HTML: the pipeline caps and reads this, and stripping markup
 * downstream would mean every consumer re-implementing it. Some providers only
 * ever return HTML — Graph hands back `contentType: html` for almost
 * everything — so the markup is flattened here rather than left to become a
 * timeline entry full of `<div>`. The snippet is the last resort, because a
 * 160-character preview is a poor record of a conversation and a worse input to
 * anything that reads the body afterwards.
 */
function bodyOf(message: MailMessageForIngress): string | null {
  const text = message.bodyText?.trim();
  if (text) return text.slice(0, MAX_BODY_CHARS);

  const fromHtml = message.bodyHtml ? htmlToText(message.bodyHtml) : "";
  if (fromHtml) return fromHtml.slice(0, MAX_BODY_CHARS);

  return message.snippet?.trim() || null;
}

/**
 * Markup to something a person can read.
 *
 * Style and script blocks go first, contents and all: stripping only the tags
 * would leave a stylesheet in the middle of the email. Block boundaries become
 * newlines so paragraphs survive, and the handful of entities that actually
 * appear in mail are decoded — anything more ambitious belongs in a library,
 * and this is not rendering, it is making a body readable and searchable.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * A timestamp the rest of the system can rely on.
 *
 * Providers send several formats and occasionally something unparseable. An
 * invalid date would become `Invalid Date` and then `null` in the database,
 * losing when a conversation happened; falling back to now is wrong by minutes
 * rather than wrong by everything.
 *
 * The fallback is reported rather than hidden. `occurredAt` feeds the mailbox
 * watermark, and one message with a malformed `Date:` header would otherwise
 * move it to this instant — claiming everything up to now had been read, and
 * permanently skipping whatever the provider had not yet indexed.
 */
function normaliseDate(value: string | null | undefined): { iso: string; estimated: boolean } {
  if (!value) return { iso: new Date().toISOString(), estimated: true };
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? { iso: new Date().toISOString(), estimated: true }
    : { iso: parsed.toISOString(), estimated: false };
}
