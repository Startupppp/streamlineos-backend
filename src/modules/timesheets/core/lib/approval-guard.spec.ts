import { canActOnPeriod } from "./approval-guard";

const worker = { membershipId: 1, isOrgOwner: false };
const manager = { membershipId: 2, isOrgOwner: false };
const owner = { membershipId: 3, isOrgOwner: true };

describe("canActOnPeriod", () => {
  it("blocks self-approval for non-privileged users", () => {
    const d = canActOnPeriod(worker, { userMembershipId: 1, currentApproverMembershipId: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/own timesheet/i);
  });

  it("allows an org owner to approve their own period (sole-admin orgs)", () => {
    const d = canActOnPeriod(owner, { userMembershipId: 3, currentApproverMembershipId: null });
    expect(d.allowed).toBe(true);
  });

  it("allows the assigned approver", () => {
    const d = canActOnPeriod(manager, { userMembershipId: 1, currentApproverMembershipId: 2 });
    expect(d.allowed).toBe(true);
  });

  it("blocks a non-assigned user even with the permission", () => {
    const other = { membershipId: 99, isOrgOwner: false };
    const d = canActOnPeriod(other, { userMembershipId: 1, currentApproverMembershipId: 2 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/assigned approver/i);
  });

  it("allows a delegate of the assigned approver", () => {
    const delegate = { membershipId: 5, isOrgOwner: false };
    const d = canActOnPeriod(
      delegate,
      { userMembershipId: 1, currentApproverMembershipId: 2 },
      { delegateeOfApprover: true },
    );
    expect(d.allowed).toBe(true);
  });

  it("allows org owner regardless of assigned approver", () => {
    const d = canActOnPeriod(owner, { userMembershipId: 1, currentApproverMembershipId: 2 });
    expect(d.allowed).toBe(true);
  });

  it("allows permission holders when no approver is assigned", () => {
    const d = canActOnPeriod(manager, { userMembershipId: 1, currentApproverMembershipId: null });
    expect(d.allowed).toBe(true);
  });

  it("blocks the assigned approver from approving their own period", () => {
    const d = canActOnPeriod(manager, { userMembershipId: 2, currentApproverMembershipId: 2 });
    expect(d.allowed).toBe(false);
  });

  it("blocks a principal with no membership, because the self-approval check silently skipped it and fell through to allowed", () => {
    const agentToken = { membershipId: null, isOrgOwner: false };
    const d = canActOnPeriod(agentToken, { userMembershipId: 1, currentApproverMembershipId: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/personal session/i);
  });

  it("blocks a membership-less principal even when it is the assigned approver slot that is empty and the period is unowned", () => {
    const systemJob = { membershipId: null, isOrgOwner: false };
    const d = canActOnPeriod(systemJob, { userMembershipId: null, currentApproverMembershipId: null });
    expect(d.allowed).toBe(false);
  });
});
