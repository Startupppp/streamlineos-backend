import { z } from "zod";
import { signPayload, signatureMatches } from "./mailbox-push";
import type { WhatsAppMessageForIngress } from "./whatsapp-to-inbound-event";

/**
 * Reading a WhatsApp delivery, safely.
 *
 * The mailbox push endpoint next door works to a rule this one cannot follow:
 * a notification may not carry data, because the sweep re-reads the message
 * from the provider over an authenticated connection. WhatsApp has no such
 * read. There is no "list messages since" call on the Cloud API — inbound
 * exists only as a push — so the signed body IS the message, and there is
 * nothing to check it against afterwards.
 *
 * That makes the signature load-bearing in a way the mail one is not. A forged
 * mail push at worst triggers a pointless sweep; a forged delivery here is
 * whatever the forger wants written onto a customer's timeline. So the same
 * HMAC primitives are reused rather than re-derived, and an absent secret is a
 * refusal rather than a check against the empty string — which would verify
 * every forgery an attacker could compute for themselves.
 *
 * The one rule that does carry over: a delivery may not name an organisation.
 * It names the business number it arrived on, and the caller resolves the
 * tenant from that.
 */

const metadataSchema = z.object({
  display_phone_number: z.string().optional(),
  phone_number_id: z.string().optional(),
});

const profileSchema = z.object({ name: z.string().optional() }).optional();

const contactSchema = z.object({
  wa_id: z.string().optional(),
  profile: profileSchema,
});

/**
 * One file on a message, as every media type spells it.
 *
 * `filename` appears on documents only — the sender typed it — and no type
 * carries a size, which is why `decideAttachment` refuses WhatsApp media until
 * the separate media-metadata read is wired.
 */
const mediaSchema = z.object({
  id: z.string().optional(),
  mime_type: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
});

const messageSchema = z.object({
  id: z.string().optional(),
  from: z.string().optional(),
  timestamp: z.string().optional(),
  type: z.string().optional(),
  text: z.object({ body: z.string().optional() }).optional(),
  image: mediaSchema.optional(),
  video: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  document: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  context: z.object({ id: z.string().optional() }).optional(),
  /**
   * Read even though an inbound message never carries one.
   *
   * The conversation object belongs to delivery *statuses* on the Cloud API,
   * not to messages. It is picked up here so that a relay or a chat-shaped
   * provider that does supply one wins over the synthesised identity, which is
   * the correct precedence — and costs a field nobody has to fill in.
   */
  conversation: z.object({ id: z.string().optional() }).optional(),
});

const changeValueSchema = z.object({
  metadata: metadataSchema.optional(),
  contacts: z.array(contactSchema).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const changeSchema = z.object({
  field: z.string().optional(),
  value: changeValueSchema.optional(),
});

const webhookSchema = z.object({
  entry: z.array(z.object({ changes: z.array(changeSchema).optional() })).optional(),
});

/**
 * Everything one `changes` block delivered, for one business number.
 *
 * A single webhook body can carry blocks for several numbers, and on a shared
 * relay those numbers can belong to different tenants. Keeping them apart —
 * rather than flattening every message into one list — is what stops one
 * organisation's delivery from being filed against another's, and it is why
 * the caller is handed the phone number id alongside the messages rather than
 * being trusted to have noticed.
 */
export interface WhatsAppDelivery {
  /** `metadata.phone_number_id` — the provider's handle for the business line. */
  readonly businessPhoneNumberId: string;
  /** `metadata.display_phone_number` — the number as a person would dial it. */
  readonly businessNumber: string;
  readonly messages: readonly WhatsAppMessageForIngress[];
  /**
   * Well-formed parts of the block that are not messages.
   *
   * Delivery receipts and read receipts arrive on the same webhook as the
   * messages do. They are not communications and must not become timeline
   * entries, but a block that is *all* receipts is a healthy delivery with
   * nothing to file — which is a very different thing from a broken one, and
   * counting them is how the caller can tell the two apart.
   */
  readonly ignored: number;
}

export type WhatsAppWebhookVerdict =
  | { readonly ok: true; readonly deliveries: readonly WhatsAppDelivery[] }
  | {
      readonly ok: false;
      readonly reason: "bad-signature" | "no-secret" | "malformed";
    };

/**
 * Whether this body really came from the provider.
 *
 * The header is `sha256=<hex>` over the raw request body, keyed with the app
 * secret — the same HMAC-SHA256 the mailbox push endpoint already computes, so
 * `signPayload` and the constant-time comparison in `signatureMatches` are
 * reused whole. Only the prefix is this channel's own.
 *
 * The raw body has to be the bytes as received. Re-serialising a parsed object
 * changes key order and whitespace and produces a different digest, so a caller
 * that hands over `JSON.stringify(req.body)` will reject every genuine
 * delivery — see the note on `readWhatsAppWebhook`.
 */
export function whatsAppSignatureMatches(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): boolean {
  /**
   * No secret is no verification, and no verification is no delivery.
   *
   * Signing with the empty string produces a digest anybody can compute, so
   * accepting one would mean an unconfigured channel trusted every forgery
   * aimed at it. A channel that ingests nothing until it is configured is
   * visible and recoverable; one that ingests anything is neither.
   */
  if (!appSecret) return false;
  if (typeof header !== "string") return false;

  const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  return signatureMatches(signPayload(appSecret, rawBody), provided);
}

/**
 * A verified delivery, split by the business number it arrived on.
 *
 * `rawBody` must be the exact bytes the provider sent and `parsed` the result
 * of parsing them; they are taken separately because the signature covers the
 * former and only the latter can be read. Handing in a re-serialised body is
 * the one mistake that fails silently in the safe direction — every delivery
 * rejected, nothing ingested — which is the shape of failure this module has
 * seen before, so the caller's wiring is worth checking against a real
 * delivery rather than assumed.
 *
 * A body that verifies but contains no message block is `ok` with no
 * deliveries, not an error: receipts and account-update notifications arrive on
 * the same webhook and are a normal, uninteresting thing to receive.
 */
export function readWhatsAppWebhook(
  rawBody: string,
  signature: string | undefined,
  appSecret: string,
  parsed: unknown,
): WhatsAppWebhookVerdict {
  if (!appSecret) return { ok: false, reason: "no-secret" };
  if (!whatsAppSignatureMatches(rawBody, signature, appSecret))
    return { ok: false, reason: "bad-signature" };

  const body = webhookSchema.safeParse(parsed);
  if (!body.success) return { ok: false, reason: "malformed" };

  const deliveries: WhatsAppDelivery[] = [];

  for (const entry of body.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      /**
       * Only the message field. A WhatsApp Business Account emits changes for
       * template approvals, quality ratings and phone-number settings on the
       * same subscription, and none of those is correspondence.
       */
      if (change.field && change.field !== "messages") continue;

      const value = change.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id?.trim() ?? "";
      const displayNumber = value.metadata?.display_phone_number?.trim() ?? "";
      const raw = value.messages ?? [];
      const ignored = (value.statuses ?? []).length;

      if (raw.length === 0 && ignored === 0) continue;

      const names = profileNames(value.contacts ?? []);
      const messages = raw.map((message) => toIngressMessage(message, names));

      deliveries.push({
        businessPhoneNumberId: phoneNumberId,
        businessNumber: displayNumber,
        messages,
        ignored,
      });
    }
  }

  return { ok: true, deliveries };
}

type RawMessage = z.infer<typeof messageSchema>;
type RawContact = z.infer<typeof contactSchema>;
type RawMedia = z.infer<typeof mediaSchema>;

/**
 * The sender's profile name, which arrives beside the messages rather than on
 * them.
 *
 * Worth the extra pass: without it a new party is named after its own phone
 * number, because the seam's `partyNameFor` has nothing else to work from once
 * an address has no local part to make a name out of.
 */
function profileNames(contacts: readonly RawContact[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const contact of contacts) {
    const waId = contact.wa_id?.trim();
    const name = contact.profile?.name?.trim();
    if (waId && name) names.set(waId, name);
  }
  return names;
}

function toIngressMessage(
  message: RawMessage,
  names: Map<string, string>,
): WhatsAppMessageForIngress {
  const from = message.from?.trim() ?? "";
  const type = message.type?.trim() ?? "";
  const media = mediaOf(message, type);

  return {
    id: message.id?.trim() ?? "",
    from,
    timestamp: message.timestamp?.trim() ?? null,
    type,
    /**
     * The text of a text message, or the caption of a media one — the
     * normaliser treats them the same because for the person who sent it they
     * are the same thing: what they said.
     */
    text: message.text?.body ?? media?.caption ?? null,
    media: media
      ? {
          id: media.id?.trim() ?? "",
          mimeType: media.mime_type ?? null,
          fileName: media.filename ?? null,
          caption: media.caption ?? null,
          /**
           * Never present on a webhook. Stated rather than omitted so that the
           * refusal it causes downstream is an obvious consequence of the wire
           * format rather than a mystery.
           */
          sizeBytes: null,
        }
      : null,
    conversationId: message.conversation?.id?.trim() ?? null,
    contextMessageId: message.context?.id?.trim() ?? null,
    profileName: names.get(from) ?? null,
  };
}

/**
 * The media object, which the provider keys by the message's own type.
 *
 * An image message carries `image`, a document carries `document`, and so on;
 * there is no common `media` key to read. Looked up by type rather than by
 * trying each in turn, so a message whose type and payload disagree resolves to
 * nothing instead of to whichever key happened to be checked first.
 */
function mediaOf(message: RawMessage, type: string): RawMedia | null {
  switch (type) {
    case "image":
      return message.image ?? null;
    case "video":
      return message.video ?? null;
    case "audio":
      return message.audio ?? null;
    case "document":
      return message.document ?? null;
    case "sticker":
      return message.sticker ?? null;
    default:
      return null;
  }
}
