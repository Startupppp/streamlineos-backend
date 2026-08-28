import {
  actingMembershipId,
  accountableMembershipId,
  assertNever,
  ACCOUNT_ONLY_PRINCIPAL,
  agentTokenPrincipal,
  humanSessionPrincipal,
  personalTokenPrincipal,
  principalCeiling,
  principalIsOrgOwner,
  systemJobCovers,
  systemJobPrincipal,
} from "./principal";

describe("actingMembershipId", () => {
  it("returns membershipId for human-session", () => {
    expect(actingMembershipId(humanSessionPrincipal(42, false))).toBe(42);
  });

  it("returns membershipId for personal-token", () => {
    expect(actingMembershipId(personalTokenPrincipal(7, true, "tok-abc", []))).toBe(7);
  });

  it("returns null for account-only", () => {
    expect(actingMembershipId(ACCOUNT_ONLY_PRINCIPAL)).toBeNull();
  });

  it("returns null for agent-token", () => {
    expect(actingMembershipId(agentTokenPrincipal(99, 1, ["build:tickets:view"]))).toBeNull();
  });

  it("returns null for system-job", () => {
    expect(actingMembershipId(systemJobPrincipal("integrations.git.webhook"))).toBeNull();
  });
});

describe("accountableMembershipId", () => {
  it("returns the issuerMembershipId for agent-token", () => {
    expect(accountableMembershipId(agentTokenPrincipal(55, 1, []))).toBe(55);
  });

  it("differs from actingMembershipId for agent-token — the only variant where they diverge", () => {
    const p = agentTokenPrincipal(55, 1, []);
    expect(accountableMembershipId(p)).toBe(55);
    expect(actingMembershipId(p)).toBeNull();
  });

  it("returns membershipId for human-session, identical to actingMembershipId", () => {
    const p = humanSessionPrincipal(11, false);
    expect(accountableMembershipId(p)).toBe(actingMembershipId(p));
    expect(accountableMembershipId(p)).toBe(11);
  });

  it("returns null for account-only, same as actingMembershipId", () => {
    expect(accountableMembershipId(ACCOUNT_ONLY_PRINCIPAL)).toBeNull();
  });

  it("returns null for system-job, same as actingMembershipId", () => {
    expect(accountableMembershipId(systemJobPrincipal("integrations.git.webhook"))).toBeNull();
  });
});

describe("principalIsOrgOwner", () => {
  it("is true for human-session when isOrgOwner is true", () => {
    expect(principalIsOrgOwner(humanSessionPrincipal(1, true))).toBe(true);
  });

  it("is false for human-session when isOrgOwner is false", () => {
    expect(principalIsOrgOwner(humanSessionPrincipal(1, false))).toBe(false);
  });

  it("is true for personal-token when isOrgOwner is true", () => {
    expect(principalIsOrgOwner(personalTokenPrincipal(2, true, "t", []))).toBe(true);
  });

  it("is false for personal-token when isOrgOwner is false", () => {
    expect(principalIsOrgOwner(personalTokenPrincipal(2, false, "t", []))).toBe(false);
  });

  it("is false for account-only", () => {
    expect(principalIsOrgOwner(ACCOUNT_ONLY_PRINCIPAL)).toBe(false);
  });

  it("is false for agent-token even though that variant has no isOrgOwner field", () => {
    expect(principalIsOrgOwner(agentTokenPrincipal(99, 1, []))).toBe(false);
  });

  it("is false for system-job even though that variant has no isOrgOwner field", () => {
    expect(principalIsOrgOwner(systemJobPrincipal("integrations.git.webhook"))).toBe(false);
  });

  it("ownership is unreachable on agent-token — the union makes the property absent at runtime", () => {
    const p = agentTokenPrincipal(1, 2, []);
    expect("isOrgOwner" in p).toBe(false);
  });

  it("ownership is unreachable on system-job — the union makes the property absent at runtime", () => {
    const p = systemJobPrincipal("integrations.git.webhook");
    expect("isOrgOwner" in p).toBe(false);
  });
});

describe("principalCeiling", () => {
  it("returns null for human-session", () => {
    expect(principalCeiling(humanSessionPrincipal(1, false))).toBeNull();
  });

  it("returns null for account-only", () => {
    expect(principalCeiling(ACCOUNT_ONLY_PRINCIPAL)).toBeNull();
  });

  it("returns the declared array for personal-token", () => {
    const c = ["hr:employees:view"] as const;
    expect(principalCeiling(personalTokenPrincipal(1, false, "t", c))).toBe(c);
  });

  it("returns the declared array for agent-token", () => {
    const c = ["build:tickets:view"] as const;
    expect(principalCeiling(agentTokenPrincipal(1, 2, c))).toBe(c);
  });

  it("returns the job ceiling for system-job", () => {
    const p = systemJobPrincipal("integrations.git.webhook");
    const ceiling = principalCeiling(p);
    expect(ceiling).toContain("build:tickets:view");
    expect(ceiling).toContain("build:tickets:update");
  });
});

describe("systemJobCovers", () => {
  it("is true for a system-job whose ceiling contains the key", () => {
    const p = systemJobPrincipal("integrations.git.webhook");
    expect(systemJobCovers(p, "build:tickets:view")).toBe(true);
  });

  it("is false for a system-job whose ceiling does not contain the key", () => {
    const p = systemJobPrincipal("integrations.git.webhook");
    expect(systemJobCovers(p, "hr:employees:view")).toBe(false);
  });

  it("is false for human-session — human authority comes from the resolved permission map", () => {
    expect(systemJobCovers(humanSessionPrincipal(1, true), "build:tickets:view")).toBe(false);
  });

  it("is false for personal-token even when the key appears in its ceiling", () => {
    const p = personalTokenPrincipal(1, false, "t", ["build:tickets:view"]);
    expect(systemJobCovers(p, "build:tickets:view")).toBe(false);
  });

  it("is false for account-only", () => {
    expect(systemJobCovers(ACCOUNT_ONLY_PRINCIPAL, "build:tickets:view")).toBe(false);
  });
});

describe("assertNever", () => {
  it("throws when handed an unhandled variant", () => {
    const bogus = { kind: "unknown-kind" } as never;
    expect(() => assertNever(bogus)).toThrow(Error);
  });

  it("names the unhandled value in the error message", () => {
    const bogus = { kind: "unknown-kind" } as never;
    expect(() => assertNever(bogus)).toThrow("unknown-kind");
  });
});
