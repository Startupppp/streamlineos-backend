/**
 * Pure guard matrix for manager team approvals (no Nest DI).
 */

function canActOnReport(opts: {
  isDirectReport: boolean;
  hasApprovePerm: boolean;
  isOwnRequest: boolean;
  status: string;
}): { ok: boolean; reason?: string } {
  if (!opts.hasApprovePerm) return { ok: false, reason: "missing_permission" };
  if (!opts.isDirectReport) return { ok: false, reason: "not_direct_report" };
  if (opts.isOwnRequest) return { ok: false, reason: "own_request" };
  if (opts.status !== "PENDING") return { ok: false, reason: "not_pending" };
  return { ok: true };
}

describe("manager team approve guards", () => {
  it("allows direct report pending claim with approve perm", () => {
    expect(
      canActOnReport({
        isDirectReport: true,
        hasApprovePerm: true,
        isOwnRequest: false,
        status: "PENDING",
      }).ok,
    ).toBe(true);
  });

  it("blocks non-report even with perm", () => {
    expect(
      canActOnReport({
        isDirectReport: false,
        hasApprovePerm: true,
        isOwnRequest: false,
        status: "PENDING",
      }).reason,
    ).toBe("not_direct_report");
  });

  it("blocks own request", () => {
    expect(
      canActOnReport({
        isDirectReport: true,
        hasApprovePerm: true,
        isOwnRequest: true,
        status: "PENDING",
      }).reason,
    ).toBe("own_request");
  });

  it("blocks without permission", () => {
    expect(
      canActOnReport({
        isDirectReport: true,
        hasApprovePerm: false,
        isOwnRequest: false,
        status: "PENDING",
      }).reason,
    ).toBe("missing_permission");
  });
});
