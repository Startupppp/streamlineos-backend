/**
 * The one shape every inbound communication becomes.
 *
 * This is the seam. Email, calendar, telephony and messaging each normalise into
 * this and hand off; nothing below this file knows which provider produced the
 * event, which is what lets the whole autonomous pipeline be driven end to end
 * from a fixture without a single provider SDK being mocked — and what makes
 * adding a channel in phase 2 a new adapter rather than a change downstream.
 *
 * Pure, so every rule here is provable without a database, a tenant or a network.
 */

export const INBOUND_CHANNELS = ["email", "calendar", "call", "message"] as const;
export type InboundChannel = (typeof INBOUND_CHANNELS)[number];

export const PARTICIPANT_ROLES = ["from", "to", "cc", "attendee", "organiser"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/**
 * What an address IS, as opposed to what it looks like.
 *
 * The seam's third closed vocabulary, and the one Phase 2 had to add. Below the
 * seam an address is matched against `party_identifiers`, keyed on the pair
 * `(kind, value)` — so the kind has to arrive with the address rather than be
 * inferred from it. Inference is precisely how a phone number ended up in
 * `business_parties.email`: `+1-555-0100` is a string, every string is a
 * plausible identifier of some kind, and whichever kind the guess picks looks
 * right on the row it writes.
 *
 * `handle` is the honest answer rather than a category: an opaque address on a
 * channel that is neither mail nor a telephone line. It exists so that a
 * participant is never dropped for want of a kind, which is what
 * `externalParticipants` used to do to every caller.
 */
export const IDENTIFIER_KINDS = ["email", "phone", "whatsapp", "handle"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export interface InboundParticipant {
  /** An email address, a phone number, a handle — whatever the channel uses. */
  readonly address: string;
  readonly displayName?: string | null;
  readonly role: ParticipantRole;
  /**
   * Which kind of identifier `address` is, stated by the adapter that read it.
   *
   * Optional only because events already sitting in `inbound_events.payload`
   * predate it; `identifierKindOf` falls back to the channel for those. A new
   * adapter should always say, because the channel is not always enough to
   * tell: WhatsApp and web forms both arrive as `message`, and one carries a
   * phone number while the other carries an email address.
   */
  readonly identifierKind?: IdentifierKind;
}

export interface InboundCommunicationEvent {
  readonly organizationId: string;
  readonly channel: InboundChannel;
  /**
   * Which adapter produced this, as an opaque label.
   *
   * It exists ONLY to make the deduplication key unique across adapters that
   * might mint colliding message ids. Nothing branches on it — the moment
   * something does, the seam has leaked.
   */
  readonly provider: string;
  /** The provider's own identifier for this message. Half of the dedupe key. */
  readonly providerMessageId: string;
  /** The provider's thread identifier, where it has one. */
  readonly providerThreadId?: string | null;
  readonly occurredAt: string;
  readonly subject?: string | null;
  readonly body?: string | null;
  readonly participants: readonly InboundParticipant[];
}

export interface EventProblem {
  readonly field: string;
  readonly message: string;
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lower-cased and trimmed, so one person is not three parties. */
export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * A telephone number in one shape.
 *
 * Carriers, messaging providers and settings fields hand the same line over as
 * `+14155551212`, `+1 (415) 555-1212`, `+1-415-555-1212` and `0014155551212`,
 * and every one of those has to reduce to the same string or the same customer
 * gets a record per formatting habit. A leading `00` is the ITU international
 * access prefix rather than part of the number — no country code begins with a
 * zero — so `0044…` and `+44…` are one person.
 *
 * Not exported: `normaliseIdentifier` is the only way to reach it, so there is
 * one entry point per kind rather than one function per caller's taste.
 *
 * What it deliberately does NOT do is add a country code to a number that
 * arrived without one. `4155551212` could be American and could equally be a
 * local number in a dozen other places; picking one would merge two strangers
 * on the strength of a guess. Such a number stays as it came, does not match
 * the same person's E.164 form, and produces a visible duplicate instead of a
 * silent wrong match. That trade is the telephony adapter's, made when it
 * landed, and this is the same rule in the one place every kind now shares.
 */
function normalisePhoneNumber(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return `+${digits}`;
  return digits.startsWith("00") ? `+${digits.slice(2)}` : digits;
}

/**
 * One identifier reduced to the single form it is matched on.
 *
 * The whole per-kind rule, stated once. Everything that writes a
 * `party_identifiers` row and everything that looks one up goes through here,
 * because a normaliser that exists twice is a normaliser that disagrees with
 * itself the first time somebody improves one copy — and disagreement here does
 * not throw, it silently splits one person into two records.
 *
 * Returns the empty string for anything that reduces to nothing, which the
 * callers treat as "no identifier" rather than storing.
 */
export function normaliseIdentifier(kind: IdentifierKind, value: string): string {
  switch (kind) {
    case "phone":
    case "whatsapp":
      return normalisePhoneNumber(value);
    case "email":
    case "handle":
      return normaliseAddress(value);
  }
}

/**
 * What kind of address a channel carries, when the adapter did not say.
 *
 * Only ever a fallback, and only for events stored before adapters carried the
 * kind. `message` resolves to `handle` rather than to a guess between mail and
 * a phone number: an unlabelled message address is genuinely an opaque one, and
 * `handle` says exactly that instead of asserting something that might be
 * wrong.
 */
export function identifierKindForChannel(channel: InboundChannel): IdentifierKind {
  switch (channel) {
    case "email":
    case "calendar":
      return "email";
    case "call":
      return "phone";
    case "message":
      return "handle";
  }
}

/** The adapter's word first, the channel only where there is none. */
export function identifierKindOf(
  event: InboundCommunicationEvent,
  participant: InboundParticipant,
): IdentifierKind {
  return participant.identifierKind ?? identifierKindForChannel(event.channel);
}

/**
 * A participant as the pair `party_identifiers` is keyed on.
 *
 * Null when the address reduces to nothing, which is the one case that has no
 * identity to record at all.
 */
export function identifierOf(
  event: InboundCommunicationEvent,
  participant: InboundParticipant,
): { kind: IdentifierKind; value: string; normalisedValue: string } | null {
  const kind = identifierKindOf(event, participant);
  const normalisedValue = normaliseIdentifier(kind, participant.address);
  return normalisedValue ? { kind, value: participant.address.trim(), normalisedValue } : null;
}

/**
 * The domain half of an address, for matching a sender to an organisation.
 *
 * Returns null rather than a guess for anything that is not an address — a
 * phone number has no domain, and inventing one would match every caller to the
 * same party.
 */
export function addressDomain(address: string): string | null {
  const normalised = normaliseAddress(address);
  if (!ADDRESS.test(normalised)) return null;
  const at = normalised.lastIndexOf("@");
  return at === -1 ? null : normalised.slice(at + 1);
}

/**
 * The key two deliveries of the same message share.
 *
 * Scoped by organisation as well as provider: a message id is unique within a
 * provider, not across tenants, and a global key would let one tenant's event
 * suppress another's.
 */
export function deduplicationKey(event: InboundCommunicationEvent): string {
  return `${event.organizationId}:${event.provider}:${event.providerMessageId}`;
}

/**
 * Validates the envelope, not the content.
 *
 * The seam is the last place an event can be rejected cheaply. Everything past
 * it runs as a durable workflow with retries, so a malformed event that gets
 * through does not fail once — it fails five times and then dead-letters.
 */
export function validateInboundEvent(event: InboundCommunicationEvent): EventProblem[] {
  const problems: EventProblem[] = [];

  if (!event.organizationId?.trim())
    problems.push({ field: "organizationId", message: "an event has to name its organisation" });

  if (!INBOUND_CHANNELS.includes(event.channel))
    problems.push({ field: "channel", message: `unknown channel "${String(event.channel)}"` });

  if (!event.provider?.trim())
    problems.push({ field: "provider", message: "an event has to name the adapter that produced it" });

  if (!event.providerMessageId?.trim())
    problems.push({
      field: "providerMessageId",
      message: "without a provider message id the same delivery cannot be recognised twice",
    });

  if (Number.isNaN(new Date(event.occurredAt).getTime()))
    problems.push({ field: "occurredAt", message: "occurredAt is not a date" });

  if (event.participants.length === 0)
    problems.push({ field: "participants", message: "an event with nobody on it has no consequences" });

  if (!event.participants.some((participant) => participant.role === "from"))
    problems.push({
      field: "participants",
      message: "an event needs a sender, or there is nobody to resolve to a party",
    });

  for (const [index, participant] of event.participants.entries()) {
    if (!participant.address?.trim())
      problems.push({ field: `participants[${index}].address`, message: "a participant needs an address" });
    if (!PARTICIPANT_ROLES.includes(participant.role))
      problems.push({
        field: `participants[${index}].role`,
        message: `unknown role "${String(participant.role)}"`,
      });
    // Absent is fine — the channel answers for events stored before adapters
    // carried it. Present and unrecognised is not: the resolver would find no
    // normalisation rule, produce no identifier, and the delivery would fail
    // five times and dead-letter instead of being refused once, here.
    if (participant.identifierKind !== undefined &&
        !IDENTIFIER_KINDS.includes(participant.identifierKind))
      problems.push({
        field: `participants[${index}].identifierKind`,
        message: `unknown identifier kind "${String(participant.identifierKind)}"`,
      });
  }

  return problems;
}

/** The sender. The one participant every event is required to carry. */
export function senderOf(event: InboundCommunicationEvent): InboundParticipant | undefined {
  return event.participants.find((participant) => participant.role === "from");
}

/**
 * Everyone who is not us.
 *
 * `internalDomains` are the tenant's own; a colleague on the thread resolves to
 * a user, not to a new party called "Priya" belonging to the customer.
 */
export function externalParticipants(
  event: InboundCommunicationEvent,
  internalDomains: readonly string[],
): InboundParticipant[] {
  const internal = new Set(internalDomains.map((domain) => domain.trim().toLowerCase()));

  /**
   * An address with no domain is kept, not dropped.
   *
   * This filter used to require `addressDomain` to be non-null, which requires
   * an `@` — so `record-participants` wrote zero rows for every call and every
   * WhatsApp message, and `AutonomyService.loadActivity` then left-joined
   * `activity_participants` for a sender that could not be there and handed the
   * bounce classifier an empty address for the entire channel.
   *
   * "External" means "not one of ours", and only a domain can say that. A phone
   * number has none, so it cannot be shown to be internal and is therefore
   * external — which is the correct default for an inbound channel where every
   * caller is a stranger until resolved.
   */
  return event.participants.filter((participant) => {
    const domain = addressDomain(participant.address);
    return domain === null || !internal.has(domain);
  });
}

/**
 * A display name for a party we have never seen.
 *
 * Prefers what the provider said the person is called, falls back to the local
 * part of the address, and never stores a bare address as a name — a CRM full of
 * parties called `no-reply@` is what that produces.
 */
export function partyNameFor(participant: InboundParticipant): string {
  const given = participant.displayName?.trim();
  if (given) return given;

  const normalised = normaliseAddress(participant.address);
  const at = normalised.indexOf("@");
  const local = at === -1 ? normalised : normalised.slice(0, at);

  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  return words.length > 0 ? words.join(" ") : normalised;
}

/**
 * The thread this belongs to.
 *
 * Uses the provider's identity where there is one, and otherwise synthesises a
 * stable one from the organisation and subject — so a channel with no threading
 * of its own still groups a conversation rather than scattering it.
 */
export function threadIdentity(event: InboundCommunicationEvent): string {
  const provided = event.providerThreadId?.trim();
  if (provided) return provided;

  const subject = (event.subject ?? "")
    .trim()
    .toLowerCase()
    .replace(/^(re|fwd|fw)\s*:\s*/gi, "")
    .replace(/\s+/g, " ");

  return subject
    ? `${event.organizationId}:${event.channel}:${subject}`
    : `${event.organizationId}:${event.channel}:${event.providerMessageId}`;
}

/** The activity kind a channel produces. One mapping, stated once. */
export function activityKindFor(channel: InboundChannel): "email" | "meeting" | "call" | "note" {
  switch (channel) {
    case "email":
      return "email";
    case "calendar":
      return "meeting";
    case "call":
      return "call";
    case "message":
      return "note";
  }
}
