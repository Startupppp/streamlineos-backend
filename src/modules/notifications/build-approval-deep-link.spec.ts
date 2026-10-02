import { buildApprovalDeepLink } from "./unified-inbox-sources";

describe("buildApprovalDeepLink", () => {
  it("points a task approval at the issue itself, so opening it from the inbox shows the issue rather than a list of approvals", () => {
    expect(buildApprovalDeepLink(4, 900)).toBe("/build/4/issues?ticket=900");
  });

  it("uses the issues surface for a task approval, because it is the only surface that reads the ticket query parameter", () => {
    expect(buildApprovalDeepLink(7, 31)).toContain("/issues?ticket=");
  });

  it("falls back to the project-filtered approvals list when the approval is not about a ticket", () => {
    expect(buildApprovalDeepLink(4, null)).toBe("/build/approvals?projectId=4");
  });

  it("falls back to the unfiltered approvals list when there is no project to scope to", () => {
    expect(buildApprovalDeepLink(null, null)).toBe("/build/approvals");
  });

  it("does not invent a project path from a ticket id when the project is unknown", () => {
    expect(buildApprovalDeepLink(null, 900)).toBe("/build/approvals");
  });
});
