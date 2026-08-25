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

export interface InboundParticipant {
  /** An email address, a phone number, a handle — whatever the channel uses. */
  readonly address: string;
  readonly displayName?: string | null;
  readonly role: ParticipantRole;
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

  return event.participants.filter((participant) => {
    const domain = addressDomain(participant.address);
    return domain !== null && !internal.has(domain);
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
