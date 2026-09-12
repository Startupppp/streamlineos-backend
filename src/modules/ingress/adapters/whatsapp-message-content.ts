import {
  decideAttachment,
  type AttachmentDecision,
  type MailAttachment,
} from "./attachment-capture";

/**
 * What a WhatsApp message actually said, and what came attached to it.
 *
 * The same split `mail-message-content.ts` made, for the same reason: the
 * adapter's own contract is "refuse with a named skip, or emit an event", and it
 * was being read through eighty lines of caption handling, unix-seconds parsing
 * and attachment budgeting. None of that varies by channel policy — it varies by
 * what the provider put on the wire — and all of it is provable from a fixture
 * with no organisation and no network.
 *
 * Nothing here imports the adapter. `WhatsAppMedia` and `WhatsAppMediaDecision`
 * are declared here and imported back by `whatsapp-to-inbound-event`, and the
 * message and context shapes are declared structurally, because naming the
 * adapter's types would close a cycle over types erased at compile time anyway —
 * which `check:cycles` counts as a real one.
 */

/** The seam's own limit, matched so an in-process caller cannot exceed the wire's. */
const MAX_BODY_CHARS = 100_000;

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

/** What was decided about one file on the message. */
export interface WhatsAppMediaDecision {
  readonly mediaId: string;
  /** The name it would be stored under, before sanitising. */
  readonly fileName: string;
  readonly decision: AttachmentDecision;
}

/** Only the fields a body is assembled from. */
export interface WhatsAppBodySource {
  /** The message text, or a media caption — whichever the type carries. */
  readonly text?: string | null;
  readonly media?: { readonly caption?: string | null } | null;
}

/** Only the fields an attachment decision is made from. */
export interface WhatsAppMediaSource {
  /** The provider's message id, which the per-message budget is keyed on. */
  readonly id: string;
  readonly media?: WhatsAppMedia | null;
}

/** Only the context field an attachment decision is made against. */
export interface WhatsAppMediaContext {
  readonly organizationId: string;
}

/**
 * The message as text.
 *
 * A caption is the message when a photo is the message — "here's the damaged
 * part" against an image is the whole content, and dropping it would leave a
 * timeline entry with nothing in it. Truncated to the seam's own limit so an
 * in-process caller cannot post a body the wire contract would reject.
 */
export function bodyOf(message: WhatsAppBodySource): string | null {
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
export function mediaDecisionsFor(
  message: WhatsAppMediaSource,
  context: WhatsAppMediaContext,
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
export function normaliseTimestamp(value: string | null | undefined): {
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
