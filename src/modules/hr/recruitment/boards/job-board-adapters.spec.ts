import { ADAPTERS, BLOCKED_MESSAGE, resolveBoard } from "./job-board-adapters";

const ACTIVE_WITH_TOKEN = { isActive: true, oauthToken: "tok" };

describe("resolveBoard", () => {
  it("blocks a board the org has never connected", () => {
    expect(resolveBoard("LINKEDIN", null)).toMatchObject({
      status: "BLOCKED",
      code: "no-integration",
    });
  });

  it("blocks a board whose integration is switched off", () => {
    expect(resolveBoard("LINKEDIN", { isActive: false, oauthToken: "tok" })).toMatchObject({
      status: "BLOCKED",
      code: "inactive",
    });
  });

  it("blocks an active integration with no credentials, as needs-keys", () => {
    expect(resolveBoard("LINKEDIN", { isActive: true, oauthToken: null })).toMatchObject({
      status: "BLOCKED",
      code: "needs-keys",
    });
  });

  /**
   * The case the old code called success. Credentials saved, no adapter that
   * can use them: `publish` answered `PUBLISHED` and invented an external id.
   */
  it("blocks credentials with no adapter behind them, as not-implemented", () => {
    expect(resolveBoard("LINKEDIN", ACTIVE_WITH_TOKEN)).toMatchObject({
      status: "BLOCKED",
      code: "not-implemented",
    });
  });

  it("blocks a platform nobody supports even when credentials exist", () => {
    expect(resolveBoard("MONSTER", ACTIVE_WITH_TOKEN)).toMatchObject({
      status: "BLOCKED",
      code: "not-implemented",
    });
  });

  it("distinguishes missing keys from a missing adapter in what the recruiter reads", () => {
    expect(BLOCKED_MESSAGE["needs-keys"]).not.toBe(BLOCKED_MESSAGE["not-implemented"]);
    expect(BLOCKED_MESSAGE["not-implemented"]).toMatch(/yourself/i);
  });

  /**
   * The registry is empty, and this records that as the product's state rather
   * than as an accident. A partnership that goes live registers an adapter here
   * and this expectation is the thing that has to be updated deliberately.
   */
  it("has no live board adapter", () => {
    expect(ADAPTERS.size).toBe(0);
  });
});
