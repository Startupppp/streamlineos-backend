import {
  IDENTITY_ADAPTERS,
  IDENTITY_STATUSES,
  last4Of,
  offerGate,
  resolveIdentity,
  type IdentityStatus,
} from "./identity-policy";

describe("offerGate", () => {
  it("allows any offer for a job that does not require verification", () => {
    for (const status of IDENTITY_STATUSES) {
      expect(offerGate(false, status)).toEqual({ allowed: true });
    }
    expect(offerGate(false, null)).toEqual({ allowed: true });
  });

  it("allows a verified candidate on a job that requires it", () => {
    expect(offerGate(true, "VERIFIED")).toEqual({ allowed: true });
  });

  it.each<[IdentityStatus | null, string]>([
    ["NOT_STARTED", "not been started"],
    [null, "not been started"],
    ["PENDING", "still running"],
    ["FAILED", "did not pass"],
    ["UNAVAILABLE", "no verification provider is connected"],
  ])("blocks %s and says why", (status, fragment) => {
    const gate = offerGate(true, status);
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("expected a refusal");
    expect(gate.reason).toContain(fragment);
  });

  /**
   * The one that decides whether this policy is real. A job whose policy
   * requires verification is one somebody decided the check matters for;
   * letting a missing integration wave it through would make the policy a
   * setting that switches itself off when it is inconvenient.
   */
  it("blocks when no provider is connected, rather than passing", () => {
    expect(offerGate(true, "UNAVAILABLE").allowed).toBe(false);
  });

  /**
   * UNAVAILABLE and FAILED both block, and they say different things. One is a
   * statement about our setup, the other about a person, and a shared message
   * would let an unconfigured integration read as a candidate who failed.
   */
  it("distinguishes a missing provider from a failed check", () => {
    const unavailable = offerGate(true, "UNAVAILABLE");
    const failed = offerGate(true, "FAILED");
    if (unavailable.allowed || failed.allowed) throw new Error("expected refusals");
    expect(unavailable.reason).not.toBe(failed.reason);
  });

  it("gives every refusal a sentence that ends", () => {
    for (const status of IDENTITY_STATUSES) {
      const gate = offerGate(true, status);
      if (gate.allowed) continue;
      expect(gate.reason.endsWith(".")).toBe(true);
    }
  });
});

describe("last4Of", () => {
  it("keeps the last four characters", () => {
    expect(last4Of("ABCDE1234F")).toBe("234F");
  });

  it("trims before taking the suffix", () => {
    expect(last4Of("  ABCDE1234F  ")).toBe("234F");
  });

  /**
   * The point of a suffix is that it is not the number. Keeping all of a short
   * input would defeat that, so anything under five characters stores nothing.
   */
  it("stores nothing for an input short enough that four would be most of it", () => {
    expect(last4Of("1234")).toBeNull();
    expect(last4Of("123")).toBeNull();
    expect(last4Of("")).toBeNull();
  });

  it("keeps a suffix from a long number without keeping the number", () => {
    const aadhaarShaped = "123456789012";
    expect(last4Of(aadhaarShaped)).toBe("9012");
    expect(last4Of(aadhaarShaped)).not.toContain("1234");
  });
});

describe("the identity provider", () => {
  /**
   * Here the empty registry protects the candidate rather than the employer.
   * Every other fabricated state in this lane costs a bad hiring decision; a
   * fabricated "verified" puts a false claim about somebody's government
   * identity into a hiring record.
   */
  it("ships no adapter", () => {
    expect(IDENTITY_ADAPTERS.size).toBe(0);
  });

  it("blocks with no-integration when nothing is connected", () => {
    expect(resolveIdentity(null)).toMatchObject({
      status: "BLOCKED",
      code: "no-integration",
    });
  });

  it("blocks as not-implemented with credentials saved, and promises no storage", () => {
    const resolved = resolveIdentity({
      platform: "IDENTITY",
      isActive: true,
      token: "vendor-key",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
    if ("adapter" in resolved) throw new Error("expected no adapter");
    expect(resolved.message).toContain("full identity numbers are never stored here");
  });
});
