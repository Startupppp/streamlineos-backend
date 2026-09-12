/**
 * Who a WhatsApp message is between, and therefore which conversation it is.
 *
 * Split from the translation for the same reason `mail-message-content.ts` was:
 * the adapter's own contract is "refuse with a named skip, or emit an event",
 * and it was being read through the rules that decide a phone number's canonical
 * form. These two are a different job and a different test — every rule below is
 * provable from two strings, with no message, no media and no attachment budget.
 *
 * They are also the pair with the most external reach. `normalisePhoneNumber` is
 * used by the caller to put a configured business number into the same form
 * before comparing a delivery against the channel it claims to belong to, and a
 * second copy of that reduction is how `0044…` and `+44…` become two people.
 *
 * Nothing here imports the adapter: the two shapes below are declared
 * structurally, exactly as `mail-message-content.ts` does, because naming the
 * adapter's own types would close a cycle over types that are erased at compile
 * time anyway — which `check:cycles` counts as a real one.
 */

/** Only the fields a thread identity is built from. */
export interface WhatsAppThreadMessage {
  /** The sender's number, as the provider writes it. */
  readonly from: string;
  /** The provider's own conversation identifier, where the delivery carries one. */
  readonly conversationId?: string | null;
}

/** Only the context fields a thread identity is built from. */
export interface WhatsAppThreadContext {
  readonly organizationId: string;
  /** The business's own WhatsApp number — the other end of every conversation. */
  readonly businessNumber: string;
}

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
  message: WhatsAppThreadMessage,
  context: WhatsAppThreadContext,
): string {
  const provided = message.conversationId?.trim();
  if (provided) return provided;

  const pair = [normalisePhoneNumber(message.from), normalisePhoneNumber(context.businessNumber)]
    .sort()
    .join("|");

  return `${context.organizationId}:message:${pair}`;
}
