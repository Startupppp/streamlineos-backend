import {
  classifyDelivery,
  isConsumerDomain,
  isEngagement,
  matchThread,
  normaliseSubject,
  parseInvite,
  resolvePartyByDomain,
} from "./deterministic";

describe("normaliseSubject", () => {
  /** A thread across three clients reads "Re: Fwd: RE: Quote" and must be one thread. */
  it("strips every reply and forward prefix, not just the outermost", () => {
    expect(normaliseSubject("Re: Fwd: RE: Quote for Q3")).toBe("quote for q3");
  });

  it.each([
    ["Re: Quote"],
    ["RE: Quote"],
    ["Fwd: Quote"],
    ["FW: Quote"],
    ["AW: Quote"],
    ["Re[2]: Quote"],
  ])("handles the %s form", (subject) => {
    expect(normaliseSubject(subject)).toBe("quote");
  });

  it("collapses whitespace so spacing differences do not fork a thread", () => {
    expect(normaliseSubject("Quote   for    Q3")).toBe("quote for q3");
  });

  it.each([[null], [undefined], [""], ["   "]])("returns empty for %s", (subject) => {
    expect(normaliseSubject(subject as string | null)).toBe("");
  });
});

describe("matchThread", () => {
  const known = [
    { threadId: "t-1", messageIds: ["<a@x>", "<b@x>"], subject: "Quote for Q3" },
    { threadId: "t-2", messageIds: ["<c@x>"], subject: "Renewal" },
  ];

  it("prefers the provider's own reply header over anything else", () => {
    expect(
      matchThread(
        { fromAddress: "p@x", subject: "Totally different", headers: { "in-reply-to": "<b@x>" } },
        known,
      ),
    ).toBe("t-1");
  });

  it("follows the references chain when in-reply-to is absent", () => {
    expect(
      matchThread({ fromAddress: "p@x", subject: "", headers: { references: "<z@x> <c@x>" } }, known),
    ).toBe("t-2");
  });

  it("falls back to an exact normalised subject", () => {
    expect(matchThread({ fromAddress: "p@x", subject: "Re: Quote for Q3" }, known)).toBe("t-1");
  });

  /** Picking one at random is worse than attaching to neither. */
  it("refuses to guess when two threads share a subject", () => {
    const ambiguous = [
      { threadId: "t-1", messageIds: [], subject: "Quote" },
      { threadId: "t-2", messageIds: [], subject: "Quote" },
    ];
    expect(matchThread({ fromAddress: "p@x", subject: "Quote" }, ambiguous)).toBeNull();
  });

  it("returns nothing when there is neither a header nor a subject", () => {
    expect(matchThread({ fromAddress: "p@x", subject: "" }, known)).toBeNull();
  });

  it("does not match a subject that merely contains another", () => {
    expect(matchThread({ fromAddress: "p@x", subject: "Quote for Q3 — revised" }, known)).toBeNull();
  });
});

describe("resolvePartyByDomain", () => {
  const parties = [
    { partyId: "p-1", domain: "example.com" },
    { partyId: "p-2", domain: "other.test" },
  ];

  it("matches a company domain to its party", () => {
    expect(resolvePartyByDomain("Example.com", parties)).toBe("p-1");
  });

  /** Matching gmail.com would put every consumer sender on one record. */
  it.each([["gmail.com"], ["outlook.com"], ["icloud.com"], ["proton.me"]])(
    "never matches the consumer domain %s",
    (domain) => {
      expect(isConsumerDomain(domain)).toBe(true);
      expect(resolvePartyByDomain(domain, [{ partyId: "p-9", domain }])).toBeNull();
    },
  );

  it("refuses an ambiguous match rather than picking one", () => {
    const duplicated = [
      { partyId: "p-1", domain: "example.com" },
      { partyId: "p-2", domain: "example.com" },
    ];
    expect(resolvePartyByDomain("example.com", duplicated)).toBeNull();
  });

  it("returns nothing for an unknown domain rather than a nearest guess", () => {
    expect(resolvePartyByDomain("unknown.test", parties)).toBeNull();
  });

  it("ignores parties with no domain recorded", () => {
    expect(resolvePartyByDomain("example.com", [{ partyId: "p-1", domain: null }])).toBeNull();
  });
});

describe("classifyDelivery", () => {
  it.each([
    ["mailer-daemon@example.com", "Undeliverable: Quote"],
    ["postmaster@example.com", "Delivery Status Notification (Failure)"],
    ["anyone@example.com", "Returned mail: see transcript"],
  ])("reads %s / %s as a bounce", (fromAddress, subject) => {
    expect(classifyDelivery({ fromAddress, subject })).toBe("bounce");
  });

  it("reads a failed-recipients header as a bounce whatever the subject says", () => {
    expect(
      classifyDelivery({
        fromAddress: "priya@example.com",
        subject: "Quote for Q3",
        headers: { "x-failed-recipients": "sales@acme.test" },
      }),
    ).toBe("bounce");
  });

  it.each([
    ["Out of Office: back Monday"],
    ["Automatic reply: Annual leave"],
    ["AutoReply — away from desk"],
  ])("reads %s as an auto-reply", (subject) => {
    expect(classifyDelivery({ fromAddress: "priya@example.com", subject })).toBe("auto-reply");
  });

  it("trusts the Auto-Submitted header", () => {
    expect(
      classifyDelivery({
        fromAddress: "priya@example.com",
        subject: "Re: Quote",
        headers: { "auto-submitted": "auto-replied" },
      }),
    ).toBe("auto-reply");
  });

  it("treats Auto-Submitted: no as an ordinary message", () => {
    expect(
      classifyDelivery({
        fromAddress: "priya@example.com",
        subject: "Re: Quote",
        headers: { "auto-submitted": "no" },
      }),
    ).toBe("delivered");
  });

  it("reads an ordinary reply as delivered", () => {
    expect(classifyDelivery({ fromAddress: "priya@example.com", subject: "Re: Quote" })).toBe(
      "delivered",
    );
  });

  /**
   * The reason this exists at all.
   *
   * A bounce read as engagement advances a deal on the strength of a mail server
   * saying the customer never received anything.
   */
  it("counts only a real reply as engagement", () => {
    expect(isEngagement({ fromAddress: "priya@example.com", subject: "Re: Quote" })).toBe(true);
    expect(isEngagement({ fromAddress: "mailer-daemon@x", subject: "Undeliverable" })).toBe(false);
    expect(isEngagement({ fromAddress: "priya@example.com", subject: "Out of Office" })).toBe(false);
  });
});

describe("parseInvite", () => {
  it("reads the fields the invite already states", () => {
    const parsed = parseInvite({
      start: "2026-09-01T10:00:00.000Z",
      end: "2026-09-01T11:00:00.000Z",
      attendees: ["Priya@Example.com", " sales@acme.test "],
      title: "  Discovery call  ",
    });

    expect(parsed?.startsAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(parsed?.endsAt?.toISOString()).toBe("2026-09-01T11:00:00.000Z");
    expect(parsed?.attendees).toEqual(["priya@example.com", "sales@acme.test"]);
    expect(parsed?.title).toBe("Discovery call");
  });

  it("returns nothing when there is no usable start", () => {
    expect(parseInvite({ start: null })).toBeNull();
    expect(parseInvite({ start: "whenever" })).toBeNull();
  });

  it("drops an end that precedes its start rather than storing a negative meeting", () => {
    const parsed = parseInvite({
      start: "2026-09-01T10:00:00.000Z",
      end: "2026-09-01T09:00:00.000Z",
    });
    expect(parsed?.endsAt).toBeNull();
  });

  it("copes with an invite that carries no attendees or title", () => {
    const parsed = parseInvite({ start: "2026-09-01T10:00:00.000Z" });
    expect(parsed?.attendees).toEqual([]);
    expect(parsed?.title).toBeNull();
  });
});
