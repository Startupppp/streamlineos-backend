import {
  activityKindFor,
  addressDomain,
  deduplicationKey,
  externalParticipants,
  identifierKindForChannel,
  identifierOf,
  normaliseAddress,
  normaliseIdentifier,
  type IdentifierKind,
  partyNameFor,
  senderOf,
  threadIdentity,
  validateInboundEvent,
  type InboundCommunicationEvent,
} from "./inbound-event";

function event(overrides: Partial<InboundCommunicationEvent> = {}): InboundCommunicationEvent {
  return {
    organizationId: "org-1",
    channel: "email",
    provider: "fixture",
    providerMessageId: "msg-1",
    occurredAt: "2026-08-23T10:00:00.000Z",
    subject: "Quote for Q3",
    body: "Can you send the quote?",
    participants: [
      { address: "Priya@Example.COM", displayName: "Priya Raman", role: "from" },
      { address: "sales@acme-crm.test", role: "to" },
    ],
    ...overrides,
  };
}

describe("validateInboundEvent", () => {
  it("accepts a well-formed event", () => {
    expect(validateInboundEvent(event())).toEqual([]);
  });

  it.each([
    ["organizationId", { organizationId: "" }],
    ["provider", { provider: "" }],
    ["providerMessageId", { providerMessageId: "  " }],
  ])("rejects an event with no %s", (field, override) => {
    const problems = validateInboundEvent(event(override as Partial<InboundCommunicationEvent>));
    expect(problems.map((problem) => problem.field)).toContain(field);
  });

  it("rejects an unknown channel rather than guessing one", () => {
    const problems = validateInboundEvent(
      event({ channel: "carrier-pigeon" as InboundCommunicationEvent["channel"] }),
    );
    expect(problems.map((problem) => problem.field)).toContain("channel");
  });

  it("rejects an unparseable timestamp", () => {
    expect(validateInboundEvent(event({ occurredAt: "yesterday" })).map((p) => p.field)).toContain(
      "occurredAt",
    );
  });

  it("rejects an event with nobody on it", () => {
    expect(validateInboundEvent(event({ participants: [] })).map((p) => p.field)).toContain(
      "participants",
    );
  });

  /** Without a sender there is nobody to resolve to a party, so nothing can follow. */
  it("rejects an event with recipients but no sender", () => {
    const problems = validateInboundEvent(
      event({ participants: [{ address: "sales@acme-crm.test", role: "to" }] }),
    );
    expect(problems.map((problem) => problem.message)).toContain(
      "an event needs a sender, or there is nobody to resolve to a party",
    );
  });

  it("collects every problem rather than stopping at the first", () => {
    const problems = validateInboundEvent(
      event({ organizationId: "", provider: "", participants: [] }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("addresses", () => {
  it("normalises case and whitespace so one person is not three parties", () => {
    expect(normaliseAddress("  Priya@Example.COM ")).toBe("priya@example.com");
  });

  it("reads the domain for matching a sender to an organisation", () => {
    expect(addressDomain("Priya@Example.COM")).toBe("example.com");
  });

  it.each([["+44 7700 900123"], ["not-an-address"], ["@example.com"], [""]])(
    "returns null rather than a guess for %s",
    (address) => {
      expect(addressDomain(address)).toBeNull();
    },
  );
});

describe("deduplicationKey", () => {
  it("is stable for the same delivery", () => {
    expect(deduplicationKey(event())).toBe(deduplicationKey(event()));
  });

  /**
   * A message id is unique within a provider, not across tenants. A global key
   * would let one organisation's event suppress another's.
   */
  it("separates the same message id across organisations", () => {
    expect(deduplicationKey(event({ organizationId: "org-1" }))).not.toBe(
      deduplicationKey(event({ organizationId: "org-2" })),
    );
  });

  it("separates the same message id across adapters", () => {
    expect(deduplicationKey(event({ provider: "gmail" }))).not.toBe(
      deduplicationKey(event({ provider: "outlook" })),
    );
  });
});

describe("senderOf and externalParticipants", () => {
  it("finds the sender", () => {
    expect(senderOf(event())?.address).toBe("Priya@Example.COM");
  });

  /** A colleague on the thread is a user, not a new party belonging to the customer. */
  it("excludes the tenant's own people", () => {
    const external = externalParticipants(event(), ["acme-crm.test"]);
    expect(external.map((participant) => participant.address)).toEqual(["Priya@Example.COM"]);
  });

  /**
   * The defect ticket 22 exists for, stated as an assertion.
   *
   * This filter used to require a resolvable domain, which requires an `@`. So
   * `record-participants` wrote ZERO rows for every call and every WhatsApp
   * message, and `AutonomyService.loadActivity` then left-joined
   * `activity_participants` for a sender that could not be there — handing the
   * bounce classifier an empty address for two whole channels.
   *
   * "External" means "not one of ours", and only a domain can establish that. A
   * telephone number has none, so it cannot be shown to be internal and is
   * therefore external, which is the right default on a channel where every
   * caller is a stranger until they are resolved.
   */
  it("keeps participants of every kind, including ones with no domain", () => {
    const withPhone = event({
      participants: [
        { address: "priya@example.com", role: "from" },
        { address: "+44 7700 900123", role: "to" },
      ],
    });
    expect(externalParticipants(withPhone, []).map((p) => p.address)).toEqual([
      "priya@example.com",
      "+44 7700 900123",
    ]);
  });

  it("still excludes an internal address while keeping a number beside it", () => {
    const mixed = event({
      participants: [
        { address: "+44 7700 900123", role: "from" },
        { address: "rep@acme-crm.test", role: "to" },
      ],
    });
    expect(externalParticipants(mixed, ["acme-crm.test"]).map((p) => p.address)).toEqual([
      "+44 7700 900123",
    ]);
  });
});

/**
 * What an address IS, as opposed to what it looks like.
 *
 * Every rule here is one half of "one person must not become three parties".
 * The other half is that nothing infers the kind from the characters — a guess
 * is how `+1-555…` became an email address in `business_parties.email`.
 */
describe("identifier kinds and normalisation", () => {
  it("lower-cases and trims an address, so one person is not three parties", () => {
    expect(normaliseIdentifier("email", "  Priya@Example.COM ")).toBe("priya@example.com");
  });

  it("reduces one telephone line written four ways to one value", () => {
    const written = ["+14155551212", "+1 (415) 555-1212", "+1-415-555-1212", "0014155551212"];
    const normalised = new Set(written.map((value) => normaliseIdentifier("phone", value)));
    expect([...normalised]).toEqual(["+14155551212"]);
  });

  /**
   * The trade the telephony adapter made when it landed, now made once for
   * every kind: a national number could belong to any of a dozen countries, and
   * picking one would merge two strangers on the strength of a guess. It stays
   * as it came — a visible duplicate rather than a silent wrong match.
   */
  it("does not invent a country code for a number that arrived without one", () => {
    expect(normaliseIdentifier("phone", "415 555 1212")).toBe("4155551212");
    expect(normaliseIdentifier("phone", "415 555 1212")).not.toBe(
      normaliseIdentifier("phone", "+14155551212"),
    );
  });

  it("normalises a WhatsApp number by the same rule as a telephone number", () => {
    expect(normaliseIdentifier("whatsapp", "+44 20 7123 4567")).toBe(
      normaliseIdentifier("phone", "+44 20 7123 4567"),
    );
  });

  it("takes the kind from the adapter rather than from the string's shape", () => {
    const call = event({
      channel: "call",
      participants: [{ address: "priya@example.com", role: "from", identifierKind: "email" }],
    });
    // The address looks like mail and the channel says telephone. The adapter
    // read it, so the adapter wins — the alternative is a guess, and a guess is
    // what this ticket removed.
    expect(identifierOf(call, call.participants[0]!)).toEqual({
      kind: "email",
      value: "priya@example.com",
      normalisedValue: "priya@example.com",
    });
  });

  /**
   * The fallback exists only for events already sitting in
   * `inbound_events.payload`, which predate the field.
   */
  it("falls back to the channel for an event stored before the kind existed", () => {
    const call = event({ channel: "call", participants: [{ address: "+1 415 555 1212", role: "from" }] });
    expect(identifierOf(call, call.participants[0]!)?.kind).toBe("phone");
  });

  /**
   * `message` carries WhatsApp AND web forms — a phone number and an email
   * address — so the channel cannot answer for it. `handle` says "an opaque
   * address on some channel", which is the truth, rather than asserting one of
   * the two.
   */
  it("refuses to guess between the two things a message can be", () => {
    expect(identifierKindForChannel("message")).toBe("handle");
    expect(identifierKindForChannel("email")).toBe("email");
    expect(identifierKindForChannel("calendar")).toBe("email");
    expect(identifierKindForChannel("call")).toBe("phone");
  });

  /**
   * Refused once here rather than five times and then dead-lettered: the seam
   * is the last place an event can be rejected cheaply, and everything past it
   * runs as a durable workflow with retries.
   */
  it("refuses a participant carrying a kind nothing knows how to normalise", () => {
    const odd = event({
      participants: [
        { address: "priya@example.com", role: "from", identifierKind: "fax" as IdentifierKind },
      ],
    });
    expect(validateInboundEvent(odd).map((problem) => problem.field)).toEqual([
      "participants[0].identifierKind",
    ]);
  });

  it("reports no identifier for an address that reduces to nothing", () => {
    const empty = event({
      channel: "call",
      participants: [{ address: "  ", role: "from", identifierKind: "phone" }],
    });
    expect(identifierOf(empty, empty.participants[0]!)).toBeNull();
  });
});

describe("partyNameFor", () => {
  it("prefers the name the provider gave", () => {
    expect(partyNameFor({ address: "priya@example.com", displayName: "Priya Raman", role: "from" })).toBe(
      "Priya Raman",
    );
  });

  /** A CRM full of parties called `no-reply@` is what storing the address produces. */
  it("builds a readable name from the local part when there is none", () => {
    expect(partyNameFor({ address: "priya.raman@example.com", role: "from" })).toBe("Priya Raman");
    expect(partyNameFor({ address: "john_smith@example.com", role: "from" })).toBe("John Smith");
  });

  it("ignores a blank display name rather than storing whitespace", () => {
    expect(partyNameFor({ address: "priya@example.com", displayName: "   ", role: "from" })).toBe(
      "Priya",
    );
  });
});

describe("threadIdentity", () => {
  it("uses the provider's thread where there is one", () => {
    expect(threadIdentity(event({ providerThreadId: "thread-9" }))).toBe("thread-9");
  });

  /** A channel with no threading still has to group a conversation. */
  it("groups a reply with what it replies to when there is not", () => {
    const original = threadIdentity(event({ subject: "Quote for Q3", providerMessageId: "a" }));
    const reply = threadIdentity(event({ subject: "Re: Quote for Q3", providerMessageId: "b" }));
    expect(reply).toBe(original);
  });

  it("strips every reply prefix, not just the first", () => {
    expect(threadIdentity(event({ subject: "RE: Quote for Q3" }))).toBe(
      threadIdentity(event({ subject: "Quote for Q3" })),
    );
    expect(threadIdentity(event({ subject: "Fwd: Quote for Q3" }))).toBe(
      threadIdentity(event({ subject: "Quote for Q3" })),
    );
  });

  it("falls back to the message id when there is no subject either", () => {
    const identity = threadIdentity(event({ subject: null, providerThreadId: null }));
    expect(identity).toContain("msg-1");
  });

  it("never groups two organisations' conversations", () => {
    expect(threadIdentity(event({ organizationId: "org-1", providerThreadId: null }))).not.toBe(
      threadIdentity(event({ organizationId: "org-2", providerThreadId: null })),
    );
  });
});

describe("activityKindFor", () => {
  it.each([
    ["email", "email"],
    ["calendar", "meeting"],
    ["call", "call"],
    ["message", "note"],
  ] as const)("maps the %s channel to a %s activity", (channel, kind) => {
    expect(activityKindFor(channel)).toBe(kind);
  });
});
