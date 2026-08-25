import {
  decideAttachment,
  type AttachmentDecision,
  type MailAttachment,
} from "./attachment-capture";
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
 * thread is therefore established *here*, before the hand-off. And its
 * addresses are phone numbers rather than mailboxes, which several assumptions
 * below the seam are built on; see the report accompanying this ticket.
 */

/** One file attached to a message. */
export interface WhatsAppMedia {
  /** The provider's media id. Metadata only — the bytes need a second call. */
  readonly id: string;
  readonly mimeType?: string | null;
  /**
   * What the sender called it, on the one message type that carries a name.
   *
   * Documents have a `filename` the sender typed; images, video, audio and
   * stickers have none at all. Either way this string is exactly as
   * attacker-controlled as a filename arriving in an email, and it is handed to
   * `attachmentKey` unmodified so that the single sanitiser in
   * `attachment-capture` is the one that decides what it becomes. There is
   * deliberately no second sanitiser in this file.
   */
  readonly fileName?: string | null;
  readonly caption?: string | null;
  /**
   * Absent on every webhook delivery, and that is not an oversight here.
   *
   * The Cloud API's media object carries an id, a mime type and a checksum but
   * no size; the size only exists on the media-metadata read that also yields
   * the download URL. `decideAttachment` refuses an undeclared size rather than
   * treating it as zero — so until that read is wired, every WhatsApp media
   * item is refused as `size-unknown`, which is the correct refusal and not a
   * silent capture of an unbounded file. Exactly the same is true of Gmail's
   * attachment list today.
   */
  readonly sizeBytes?: number | null;
}

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

/** What was decided about one file on the message. */
export interface WhatsAppMediaDecision {
  readonly mediaId: string;
  /** The name it would be stored under, before sanitising. */
  readonly fileName: string;
  readonly decision: AttachmentDecision;
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

/** The seam's own limit, matched so an in-process caller cannot exceed the wire's. */
const MAX_BODY_CHARS = 100_000;

/**
 * A phone number in one form, so one person is not three parties.
 *
 * The provider sends the sender's number as bare E.164 digits and a configured
 * business number in whatever a person typed into a settings field, so both go
 * through the same reduction: everything that is not a digit is dropped and a
 * `+` is put back on the front. A leading `00` is the ITU international access
 * prefix rather than part of the number — no country code begins with a zero —
 * so `0044…` and `+44…` are the same person and must not become two.
 *
 * Exported because the caller needs the business number in this form to compare
 * a delivery against the channel it claims to belong to, and two copies of this
 * rule would drift.
 */
export function normalisePhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^00/, "");
  return digits ? `+${digits}` : "";
}

/**
 * The thread a WhatsApp message belongs to.
 *
 * The provider's own conversation identifier wins whenever there is one — it is
 * the answer rather than a reconstruction of it. There almost never is: an
 * inbound Cloud API message carries no conversation id, which is why the
 * fallback is the load-bearing half of this function rather than a courtesy.
 *
 * The fallback is the participant pair. WhatsApp is a two-party channel, so the
 * two ends *are* the conversation, and sorting them makes the identity
 * independent of direction — a reply the business sends lands on the same
 * thread as the message that prompted it. The shape matches the seam's own
 * synthesised form (`organisation:channel:…`) so that a synthesised identity
 * can never be mistaken for, or collide with, a provider-issued one.
 *
 * What it deliberately is not: the subject (there is none), the reply pointer
 * (`context.id`, which threads a chain rather than a conversation), or a
 * per-message id (which is what the seam's own fallback degrades to here, and
 * is precisely a pile rather than a conversation).
 */
export function whatsAppThreadIdentity(
  message: WhatsAppMessageForIngress,
  context: WhatsAppIngressContext,
): string {
  const provided = message.conversationId?.trim();
  if (provided) return provided;

  const pair = [normalisePhoneNumber(message.from), normalisePhoneNumber(context.businessNumber)]
    .sort()
    .join("|");

  return `${context.organizationId}:message:${pair}`;
}

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

  const participants: InboundParticipant[] = [
    { address: from, displayName: message.profileName?.trim() || null, role: "from" },
    /**
     * The business number is on the event as the recipient.
     *
     * It is what makes the pair readable from the event itself rather than only
     * from the thread id, and it is the participant a reply would be addressed
     * to. It costs nothing: the workflow's participant step keeps addresses it
     * cannot resolve to a party.
     */
    { address: business, role: "to" },
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

/**
 * The message as text.
 *
 * A caption is the message when a photo is the message — "here's the damaged
 * part" against an image is the whole content, and dropping it would leave a
 * timeline entry with nothing in it. Truncated to the seam's own limit so an
 * in-process caller cannot post a body the wire contract would reject.
 */
function bodyOf(message: WhatsAppMessageForIngress): string | null {
  const text = message.text?.trim() || message.media?.caption?.trim();
  return text ? text.slice(0, MAX_BODY_CHARS) : null;
}

/**
 * What would be stored from this message's media, decided by the email path.
 *
 * `decideAttachment` is called rather than reimplemented: it owns the per-file
 * ceiling, the per-message budget, the refusal of an undeclared size and the
 * filename sanitiser, and a WhatsApp filename is exactly as attacker-controlled
 * as an email one. A second copy of any of those rules would be a second set of
 * limits to keep in step.
 *
 * A WhatsApp message carries at most one media object, so the running budget
 * starts at nothing and the per-file ceiling is the cap that bites. That is
 * weaker than it is for email, and deliberately not fixed here — see the
 * report: a burst of ten photos is ten messages, so it is ten separate
 * budgets, and a budget that would hold across them is a per-thread notion
 * `attachment-capture` does not have.
 */
function mediaDecisionsFor(
  message: WhatsAppMessageForIngress,
  context: WhatsAppIngressContext,
): WhatsAppMediaDecision[] {
  const media = message.media;
  if (!media?.id?.trim()) return [];

  const fileName = fileNameFor(media);
  const attachment: MailAttachment = {
    id: media.id,
    fileName,
    mimeType: media.mimeType ?? null,
    sizeBytes: media.sizeBytes ?? null,
    /**
     * Nothing on WhatsApp is inline. There is no message body with embedded
     * images to be part of, so a photo is always the point of the message
     * rather than a signature block or a tracking pixel.
     */
    inline: false,
  };

  return [
    {
      mediaId: media.id,
      fileName,
      decision: decideAttachment(attachment, context.organizationId, message.id, 0),
    },
  ];
}

/**
 * A name to store the file under.
 *
 * The sender's own filename wherever there is one, passed through untouched so
 * that `attachmentKey` is the single place a filename is made safe. Only when
 * there is none — every image, video, audio note and sticker — is one made, and
 * it is made from the provider's media id so that two photos in the same
 * conversation cannot land on the same key. The mime type goes on the end raw:
 * it is provider-declared rather than trusted, and the same sanitiser handles
 * it.
 */
function fileNameFor(media: WhatsAppMedia): string {
  const given = media.fileName?.trim();
  if (given) return given;

  const subtype = (media.mimeType ?? "").split(";")[0]?.split("/")[1]?.trim();
  return subtype ? `${media.id}.${subtype}` : media.id;
}

/**
 * A timestamp the rest of the system can rely on.
 *
 * The provider sends unix seconds as a string. Anything that is not a positive
 * finite number of them is not a timestamp, and falling back to now is wrong by
 * the delivery delay rather than wrong by everything — but the fallback is
 * reported, never hidden, because a caller that keeps a high-water mark must
 * not be allowed to move it to this instant off the back of one malformed
 * field.
 */
function normaliseTimestamp(value: string | null | undefined): {
  iso: string;
  estimated: boolean;
} {
  const seconds = Number(value);
  if (!value || !Number.isFinite(seconds) || seconds <= 0)
    return { iso: new Date().toISOString(), estimated: true };

  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime())
    ? { iso: new Date().toISOString(), estimated: true }
    : { iso: at.toISOString(), estimated: false };
}
