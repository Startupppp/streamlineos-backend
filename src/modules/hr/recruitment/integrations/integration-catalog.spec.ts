import {
  INTEGRATION_CATALOG,
  INTEGRATION_FAMILIES,
  integrationFor,
  statusOf,
} from "./integration-catalog";
import { SUPPORTED_BOARDS } from "../boards/job-board-adapters";

const LIVE = { isActive: true, hasCredentials: true, credentialHint: "…abcd" };

describe("the integration catalog", () => {
  it("declares every family it names", () => {
    const declared = new Set(INTEGRATION_CATALOG.map((entry) => entry.family));
    for (const family of INTEGRATION_FAMILIES) expect([family, declared.has(family)]).toEqual([family, true]);
  });

  it("names each platform exactly once", () => {
    const platforms = INTEGRATION_CATALOG.map((entry) => entry.platform);
    expect(new Set(platforms).size).toBe(platforms.length);
  });

  it("covers every board the distribution code supports", () => {
    for (const board of SUPPORTED_BOARDS) expect(integrationFor(board)).not.toBeNull();
  });

  /**
   * The rule that keeps "not available" from being a shrug. Anything without an
   * adapter has to say what it is waiting on, in terms of the actual dependency
   * — a partner programme, an account, an app registration — rather than
   * "coming soon", which tells a recruiter nothing they can act on.
   */
  it("says what each unimplemented integration is waiting on", () => {
    for (const entry of INTEGRATION_CATALOG) {
      if (entry.adapterImplemented) continue;
      expect([entry.platform, entry.blockedBy]).not.toEqual([entry.platform, null]);
      expect(entry.blockedBy ?? "").toMatch(/needs|partner|account|registration/i);
    }
  });

  it("never sells a fallback it does not have, or hides one it does", () => {
    for (const entry of INTEGRATION_CATALOG)
      expect([entry.platform, typeof entry.manualFallback]).toEqual([
        entry.platform,
        entry.manualFallback === null ? "object" : "string",
      ]);
  });
});

describe("statusOf", () => {
  const board = integrationFor("NAUKRI")!;
  const rsc = integrationFor("LINKEDIN_RSC")!;

  it("is available only with an adapter, an active row and credentials", () => {
    expect(statusOf(board, LIVE).blockedCode).toBeNull();
  });

  it("is no-integration when the organisation has never connected it", () => {
    expect(statusOf(board, null).blockedCode).toBe("no-integration");
  });

  it("is inactive when the row is switched off", () => {
    expect(statusOf(board, { ...LIVE, isActive: false }).blockedCode).toBe("inactive");
  });

  it("is needs-keys when it is on with nothing saved", () => {
    expect(statusOf(board, { ...LIVE, hasCredentials: false }).blockedCode).toBe("needs-keys");
  });

  /**
   * Order matters, and this is the case that proves it. LinkedIn RSC has no
   * adapter, so even a fully configured organisation is `not-implemented`
   * rather than available — and an organisation with nothing saved is told the
   * same thing rather than being sent to find keys for a capability that could
   * not use them.
   */
  it("reports a missing adapter ahead of missing credentials, both ways round", () => {
    expect(statusOf(rsc, LIVE).blockedCode).toBe("not-implemented");
    expect(statusOf(rsc, null).blockedCode).toBe("not-implemented");
  });

  it("never returns the credential itself, only a hint", () => {
    const status = statusOf(board, LIVE);
    expect(Object.keys(status)).not.toContain("token");
    expect(status.credentialHint).toBe("…abcd");
  });
});
