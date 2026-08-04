import { shouldDenyTeamPayrollCopilot } from "./ops-copilot-tools";

describe("shouldDenyTeamPayrollCopilot", () => {
  it("denies team scope instead of silently narrowing to self", () => {
    expect(shouldDenyTeamPayrollCopilot("team")).toBe(true);
  });

  it("does not deny own scope", () => {
    expect(shouldDenyTeamPayrollCopilot("own")).toBe(false);
  });

  it("does not deny all scope", () => {
    expect(shouldDenyTeamPayrollCopilot("all")).toBe(false);
  });
});
