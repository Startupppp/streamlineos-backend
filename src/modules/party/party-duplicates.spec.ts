import {
  assessDuplicate,
  emailDomain,
  nameSimilarity,
  normaliseHost,
  normaliseName,
  normalisePhone,
  normaliseTaxNumber,
  type PartyFingerprint,
} from "./party-duplicates";

function party(overrides: Partial<PartyFingerprint> = {}): PartyFingerprint {
  return { partyId: "p", name: "Acme Trading", ...overrides };
}

describe("normalisation", () => {
  it("drops legal-form suffixes, which carry no identity", () => {
    expect(normaliseName("Acme Trading Ltd")).toBe("acme trading");
    expect(normaliseName("Acme Trading Pvt Ltd")).toBe("acme trading");
    expect(normaliseName("ACME  Trading, Inc.")).toBe("acme trading");
  });

  it("keeps a name that is only a suffix from collapsing to nothing useful", () => {
    expect(normaliseName("Ltd")).toBe("");
  });

  it("compares the tail of a phone number, so a country code does not break a match", () => {
    expect(normalisePhone("+44 20 7123 4567")).toBe(normalisePhone("020 7123 4567"));
    expect(normalisePhone("+91-98765-43210")).toBe("9876543210");
  });

  it("strips formatting from a tax number", () => {
    expect(normaliseTaxNumber("gb-123 456 789")).toBe("GB123456789");
  });

  it("reduces a website to its host", () => {
    expect(normaliseHost("https://www.acme.example/contact")).toBe("acme.example");
    expect(normaliseHost("acme.example")).toBe("acme.example");
  });

  it("extracts an email domain, and nothing from a malformed address", () => {
    expect(emailDomain("Ops@Acme.Example")).toBe("acme.example");
    expect(emailDomain("not-an-email")).toBe("");
  });

  it("scores name similarity between 0 and 1", () => {
    expect(nameSimilarity("acme trading", "acme trading")).toBe(1);
    expect(nameSimilarity("acme trading", "acme tradng")).toBeGreaterThan(0.8);
    expect(nameSimilarity("acme trading", "globex")).toBeLessThan(0.3);
    expect(nameSimilarity("", "acme")).toBe(0);
  });
});

describe("assessDuplicate", () => {
  it("merges automatically when a tax number and a name both agree", () => {
    const result = assessDuplicate(
      party({ taxNumber: "GB123456789" }),
      party({ partyId: "q", name: "Acme Trading Ltd", taxNumber: "GB-123-456-789" }),
    );

    expect(result.verdict).toBe("auto-merge");
    expect(result.signals).toContain("tax-number");
  });

  it("refuses to merge on a matching name alone, however identical", () => {
    // Any number of unrelated businesses trade under the same name; merging on
    // that is precisely the false merge this weighting exists to avoid.
    const result = assessDuplicate(party(), party({ partyId: "q", name: "Acme Trading" }));

    expect(result.verdict).not.toBe("auto-merge");
    expect(result.signals).toContain("name-exact");
  });

  it("blocks a merge outright when tax numbers contradict, whatever else agrees", () => {
    const result = assessDuplicate(
      party({ taxNumber: "GB111", email: "ops@acme.example", phone: "+44 20 7123 4567" }),
      party({
        partyId: "q",
        name: "Acme Trading",
        taxNumber: "GB999",
        email: "ops@acme.example",
        phone: "+44 20 7123 4567",
      }),
    );

    expect(result.blockers).toContain("different tax numbers");
    expect(result.verdict).not.toBe("auto-merge");
  });

  it("merges on a shared email and name", () => {
    const result = assessDuplicate(
      party({ email: "ops@acme.example" }),
      party({ partyId: "q", name: "Acme Trading Limited", email: "OPS@acme.example" }),
    );

    expect(result.verdict).toBe("auto-merge");
  });

  it("merges on a shared phone line, a website and a name", () => {
    const result = assessDuplicate(
      party({ phone: "+44 20 7123 4567", website: "https://acme.example" }),
      party({
        partyId: "q",
        name: "Acme Trading Ltd",
        phone: "020 7123 4567",
        website: "www.acme.example/about",
      }),
    );

    expect(result.verdict).toBe("auto-merge");
  });

  it("only reviews a shared email domain, since colleagues share one", () => {
    const result = assessDuplicate(
      party({ name: "Acme North", email: "north@acme.example" }),
      party({ partyId: "q", name: "Acme South", email: "south@acme.example" }),
    );

    expect(result.verdict).not.toBe("auto-merge");
  });

  it("surfaces a plausible pair for review rather than dismissing it", () => {
    // Same site and same name, but nothing that identifies a legal entity.
    const result = assessDuplicate(
      party({ website: "acme.example" }),
      party({ partyId: "q", name: "Acme Trading Co", website: "https://www.acme.example" }),
    );

    expect(result.verdict).toBe("review");
  });

  it("does not queue a bare name match, or the review list fills with coincidences", () => {
    const result = assessDuplicate(
      party({ name: "Acme Trading" }),
      party({ partyId: "q", name: "Acme Trading Co" }),
    );

    expect(result.verdict).toBe("distinct");
  });

  it("calls two unrelated records distinct", () => {
    const result = assessDuplicate(
      party({ name: "Acme Trading", email: "ops@acme.example" }),
      party({ partyId: "q", name: "Globex Industries", email: "hello@globex.example" }),
    );

    expect(result.verdict).toBe("distinct");
    expect(result.score).toBeLessThan(0.45);
  });

  it("does not treat two absent fields as agreement", () => {
    // Empty on both sides is the common case for sparse records; counting it as
    // a match would merge half the database.
    const result = assessDuplicate(
      { partyId: "a", name: "Acme", email: null, phone: null, taxNumber: null },
      { partyId: "b", name: "Globex", email: null, phone: null, taxNumber: null },
    );

    expect(result.signals).toEqual([]);
    expect(result.verdict).toBe("distinct");
  });

  it("is symmetric, so which record was created first cannot change the verdict", () => {
    const a = party({ email: "ops@acme.example", taxNumber: "GB1" });
    const b = party({ partyId: "q", name: "Acme Trading Ltd", email: "ops@acme.example" });

    expect(assessDuplicate(a, b)).toEqual(assessDuplicate(b, a));
  });

  it("caps the score at one however many signals agree", () => {
    const everything = {
      email: "ops@acme.example",
      phone: "+44 20 7123 4567",
      taxNumber: "GB1",
      website: "acme.example",
    };
    const result = assessDuplicate(
      party(everything),
      party({ partyId: "q", ...everything }),
    );

    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.verdict).toBe("auto-merge");
  });

  it("matches a name through a typo when identity also agrees", () => {
    const result = assessDuplicate(
      party({ name: "Acme Trading", taxNumber: "GB1" }),
      party({ partyId: "q", name: "Acme Tradng", taxNumber: "GB1" }),
    );

    expect(result.signals).toContain("name-close");
    expect(result.verdict).toBe("auto-merge");
  });

  it("reports the signals that decided it, for the audit record", () => {
    const result = assessDuplicate(
      party({ email: "ops@acme.example", phone: "+44 20 7123 4567" }),
      party({ partyId: "q", name: "Acme Trading", email: "ops@acme.example", phone: "02071234567" }),
    );

    expect(result.signals).toEqual(
      expect.arrayContaining(["email", "phone", "name-exact"]),
    );
  });
});
