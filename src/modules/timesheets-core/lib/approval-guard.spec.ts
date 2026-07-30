import { canActOnPeriod } from "./approval-guard";

const worker = { userId: "worker-1", isOrgOwner: false};
const manager = { userId: "mgr-1", isOrgOwner: false};
const owner = { userId: "owner-1", isOrgOwner: true};

describe("canActOnPeriod", () => {
  it("blocks self-approval for non-privileged users", () => {
    const d = canActOnPeriod(worker, { userId: "worker-1", currentApproverId: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/own timesheet/i);
  });

  it("allows an org owner to approve their own period (sole-admin orgs)", () => {
    const d = canActOnPeriod(owner, { userId: "owner-1", currentApproverId: null });
    expect(d.allowed).toBe(true);
  });

  it("allows the assigned approver", () => {
    const d = canActOnPeriod(manager, { userId: "worker-1", currentApproverId: "mgr-1" });
    expect(d.allowed).toBe(true);
  });

  it("blocks a non-assigned user even with the permission", () => {
    const other = { userId: "other-1", isOrgOwner: false};
    const d = canActOnPeriod(other, { userId: "worker-1", currentApproverId: "mgr-1" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/assigned approver/i);
  });

  it("allows a delegate of the assigned approver", () => {
    const delegate = { userId: "delegate-1", isOrgOwner: false};
    const d = canActOnPeriod(
      delegate,
      { userId: "worker-1", currentApproverId: "mgr-1" },
      { delegateeOfApprover: true },
    );
    expect(d.allowed).toBe(true);
  });

  it("allows org owner regardless of assigned approver", () => {
    const d = canActOnPeriod(owner, { userId: "worker-1", currentApproverId: "mgr-1" });
    expect(d.allowed).toBe(true);
  });

  it("allows permission holders when no approver is assigned", () => {
    const d = canActOnPeriod(manager, { userId: "worker-1", currentApproverId: null });
    expect(d.allowed).toBe(true);
  });

  it("blocks the assigned approver from approving their own period", () => {
    const d = canActOnPeriod(manager, { userId: "mgr-1", currentApproverId: "mgr-1" });
    expect(d.allowed).toBe(false);
  });
});
