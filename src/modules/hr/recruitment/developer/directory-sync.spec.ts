import { directorySyncState } from "./directory-sync";

describe("directorySyncState", () => {
  /**
   * The measured answer, not the assumed one. The ticket for this work said
   * "recruiter SSO is org SSO if the platform already has it"; this codebase
   * has no SAML, no per-tenant OIDC, no enforced-SSO setting and no SCIM
   * endpoint of any kind. Reporting either as supported would be the exact
   * failure this lane exists to avoid.
   */
  it("reports both as blocked, never as supported", () => {
    for (const entry of directorySyncState()) {
      expect(entry.provider.status).toBe("BLOCKED");
      expect(entry.provider.code).toBe("not-implemented");
    }
  });

  it("covers SSO and SCIM and nothing else", () => {
    expect(directorySyncState().map((e) => e.capability)).toEqual(["SSO", "SCIM"]);
  });

  /**
   * The harm this sentence prevents. An admin who reads "SSO" assumes
   * deprovisioning a leaver in their IdP removes access here. It does not, and
   * finding that out during an audit is the cost of the euphemism.
   */
  it("says outright that Google sign-in is not directory deprovisioning", () => {
    const sso = directorySyncState().find((e) => e.capability === "SSO");
    expect(sso?.provider.message).toContain("does not remove their access here");
    expect(sso?.provider.message).toContain("revoke the membership");
  });

  it("names what an administrator can do today instead of only refusing", () => {
    for (const entry of directorySyncState()) {
      expect(entry.availableToday.length).toBeGreaterThan(0);
      expect(entry.provider.message.length).toBeGreaterThan(40);
    }
  });
});
