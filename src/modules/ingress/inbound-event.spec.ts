import {
  activityKindFor,
  addressDomain,
  deduplicationKey,
  externalParticipants,
  normaliseAddress,
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

  it("drops participants with no resolvable domain rather than inventing one", () => {
    const withPhone = event({
      participants: [
        { address: "priya@example.com", role: "from" },
        { address: "+44 7700 900123", role: "to" },
      ],
    });
    expect(externalParticipants(withPhone, []).map((p) => p.address)).toEqual([
      "priya@example.com",
    ]);
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
