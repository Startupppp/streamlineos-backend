import {
  bodyOf,
  mediaDecisionsFor,
  normaliseTimestamp,
  type WhatsAppMedia,
  type WhatsAppMediaDecision,
} from "./whatsapp-message-content";
import {
  normalisePhoneNumber,
  whatsAppThreadIdentity,
} from "./whatsapp-thread-identity";
import type {
  InboundChannel,
  InboundCommunicationEvent,
  InboundParticipant,
} from "../inbound-event";

/**
 * Turning one WhatsApp message into the one event shape.
 *
 * Same contract as `mail-to-inbound-event`: translate and stop. It resolves no
 * parties, writes nothing, calls no provider — the seam exists so that adding a
 * channel needs no change below it, and this file is the test of that claim for
 * messaging.
 *
 * Two things WhatsApp does not have shape everything here. It has no subject,
 * so the seam's own thread fallback — which synthesises from the subject line —
 * degrades to one thread per message, a pile rather than a conversation; the
 * thread is therefore established before the hand-off, by
 * `whatsapp-thread-identity`. And its addresses are phone numbers rather than
 * mailboxes, which several assumptions below the seam are built on; see the
 * report accompanying this ticket.
 *
 * What is left in this file is the contract itself: the six named refusals and
 * the one event they are the alternative to. Reading a message — its body, its
 * timestamp, what it has attached — is `whatsapp-message-content`, and deciding
 * which conversation it belongs to is `whatsapp-thread-identity`. Both are
 * re-exported below, so nothing that imports this adapter changed.
 */

/**
 * The subset of an inbound WhatsApp message this needs.
 *
 * Flat rather than the provider's nesting, because the envelope is the part
 * most likely to differ between a direct webhook and a relay, and the envelope
 * reader is where that difference belongs. Nothing in this file knows how a
 * message was delivered.
 */
export interface WhatsAppMessageForIngress {
  /** The provider's message id (`wamid.…`). Half of the deduplication key. */
  readonly id: string;
  /** The sender's number, as the provider writes it. */
  readonly from: string;
  /** Unix seconds, as a string, which is how the provider sends it. */
  readonly timestamp: string | null;
  readonly type: string;
  /** The message text, or a media caption — whichever the type carries. */
  readonly text?: string | null;
  readonly media?: WhatsAppMedia | null;
  /**
   * The provider's own conversation identifier, where the delivery carries one.
   *
   * Optional and normally absent: an inbound Cloud API message has no
   * conversation id on it — the `conversation` object appears on delivery
   * *statuses*, not on messages. It is read here anyway because a relay or a
   * chat-shaped provider in front of the same normaliser may supply one, and a
   * provider that knows the answer must always beat a synthesised guess.
   */
  readonly conversationId?: string | null;
  /**
   * The message this one replies to, where the sender used the reply gesture.
   *
   * Carried for completeness and deliberately NOT used for threading: it points
   * at a single message, not a conversation, so threading on it would split one
   * exchange into a chain per reply and leave every unquoted message alone in
   * its own thread.
   */
  readonly contextMessageId?: string | null;
  /** The sender's WhatsApp profile name, where the delivery carries one. */
  readonly profileName?: string | null;
}

/**
 * Re-exported so every existing importer of this adapter — the ingress service,
 * the webhook reader and `whatsapp-to-inbound-event.spec.ts` — is unchanged.
 */
export type { WhatsAppMedia, WhatsAppMediaDecision } from "./whatsapp-message-content";
export { normalisePhoneNumber, whatsAppThreadIdentity } from "./whatsapp-thread-identity";

export interface WhatsAppIngressContext {
  readonly organizationId: string;
  /** `whatsapp`; only used for the deduplication key. */
  readonly provider: string;
  /**
   * The business's own WhatsApp number — the other end of every conversation.
   *
   * Required, and a blank one is refused rather than worked around. It is half
   * of the participant pair the thread is built from, and an organisation with
   * a sales number and a support number would otherwise collapse two separate
   * conversations with the same customer into one thread.
   */
  readonly businessNumber: string;
}

export type WhatsAppSkipReason =
  | "no-identifier"
  | "no-sender"
  | "no-business-number"
  | "own-number-noise"
  | "unsupported-type"
  | "empty";

export type WhatsAppIngressResult =
  | {
      readonly ok: true;
      readonly event: InboundCommunicationEvent;
      /**
       * What would be captured from this message, decided but not fetched.
       *
       * Returned beside the event rather than inside it because
       * `InboundCommunicationEvent` has no attachment field and its wire schema
       * is `.strict()` — the seam carries no attachments today, for any
       * channel. Putting them in the result keeps the decision with the message
       * it belongs to without widening the seam to do it.
       */
      readonly media: readonly WhatsAppMediaDecision[];
      /**
       * The provider gave no usable timestamp and `occurredAt` is this instant.
       *
       * Reported for the same reason the mail adapter reports it: a message
       * placed at ingest time sits in the wrong place on a timeline, and a
       * caller that keeps any kind of high-water mark must not move it on a
       * timestamp nobody supplied.
       */
      readonly occurredAtEstimated: boolean;
    }
  | { readonly ok: false; readonly reason: WhatsAppSkipReason };

/**
 * The message types that are correspondence with a person.
 *
 * Everything else the channel delivers is refused by name rather than
 * quietly dropped: `reaction` is a thumbs-up with no body, `system` is a
 * "this number changed" notice, and `location`, `contacts`, `order` and
 * `interactive` carry structure this event shape has nowhere to put. A refusal
 * with a name is countable, and a caller that finds itself refusing everything
 * can say so — a channel that reports healthy while delivering nothing is the
 * failure this whole module has already paid for once.
 */
export const SUPPORTED_MESSAGE_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
] as const;

const SUPPORTED = new Set<string>(SUPPORTED_MESSAGE_TYPES);

/**
 * A WhatsApp message as an inbound communication event, or a reason it is not.
 *
 * Refusing is half the job here too. The caller is a webhook handling a batch,
 * so one message it cannot make sense of returns a named skip rather than
 * throwing and losing the rest of the delivery.
 */
export function whatsAppToInboundEvent(
  message: WhatsAppMessageForIngress,
  context: WhatsAppIngressContext,
): WhatsAppIngressResult {
  if (!message.id?.trim()) return { ok: false, reason: "no-identifier" };

  const from = normalisePhoneNumber(message.from ?? "");
  if (!from) return { ok: false, reason: "no-sender" };

  /**
   * Refused rather than threaded on the sender alone.
   *
   * Without the business's own number there is no pair, and threading on one
   * end would merge every conversation a customer has with the organisation —
   * sales and support on separate numbers — into a single thread. A property
   * that cannot be established is a refusal, not an assumption: the messages
   * stay unfiled and visibly so, which is recoverable, whereas a merged
   * timeline is not.
   */
  const business = normalisePhoneNumber(context.businessNumber ?? "");
  if (!business) return { ok: false, reason: "no-business-number" };

  /**
   * Our own number as the sender is an echo, not correspondence.
   *
   * The Cloud API does not deliver the business's outbound messages back as
   * inbound ones, but a relay replaying a log can, and filing one would create
   * a party for the organisation itself.
   */
  if (from === business) return { ok: false, reason: "own-number-noise" };

  if (!SUPPORTED.has(message.type)) return { ok: false, reason: "unsupported-type" };

  const body = bodyOf(message);
  const media = mediaDecisionsFor(message, context);
  if (!body && media.length === 0) return { ok: false, reason: "empty" };

  const occurredAt = normaliseTimestamp(message.timestamp);

  /**
   * `whatsapp`, not `phone`, and stated here rather than derived below.
   *
   * The channel cannot say it: web forms arrive as `message` too, carrying an
   * email address. And the distinction from `phone` is real — a WhatsApp number
   * is a messaging account that happens to be named after a telephone line, and
   * ticket 01 gave it its own column for that reason. The resolver treats the
   * two as one line when it has to; deciding that is its job, not this file's.
   */
  const identifierKind = "whatsapp" as const;

  const participants: InboundParticipant[] = [
    {
      address: from,
      displayName: message.profileName?.trim() || null,
      role: "from",
      identifierKind,
    },
    /**
     * The business number is on the event as the recipient.
     *
     * It is what makes the pair readable from the event itself rather than only
     * from the thread id, and it is the participant a reply would be addressed
     * to. It costs nothing: the workflow's participant step keeps addresses it
     * cannot resolve to a party.
     */
    { address: business, role: "to", identifierKind },
  ];

  return {
    ok: true,
    media,
    occurredAtEstimated: occurredAt.estimated,
    event: {
      organizationId: context.organizationId,
      channel: "message" satisfies InboundChannel,
      provider: context.provider,
      providerMessageId: message.id,
      /**
       * Always set, never left null.
       *
       * The seam's `threadIdentity` falls back to the subject and then to the
       * message id, and WhatsApp has no subject — so leaving this null would
       * put every single message in a thread of its own. The adapter knows the
       * answer, so the adapter states it, and nothing below the seam changes.
       */
      providerThreadId: whatsAppThreadIdentity(message, context),
      occurredAt: occurredAt.iso,
      /** There is no such thing as a WhatsApp subject. Absent, not invented. */
      subject: null,
      body,
      participants,
    },
  };
}
