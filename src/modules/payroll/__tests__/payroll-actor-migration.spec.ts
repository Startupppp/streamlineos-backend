import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  assertOrganizationActor,
  OrganizationActorError,
} from "../../../common/organization/organization-actor";
import { ReimbursementsService } from "../hr-payroll/reimbursements.service";

jest.mock("../../../common/organization/organization-actor", () => {
  const actual = jest.requireActual<typeof import("../../../common/organization/organization-actor")>(
    "../../../common/organization/organization-actor",
  );
  return { ...actual, assertOrganizationActor: jest.fn() };
});

const mockAssertActor = assertOrganizationActor as jest.MockedFunction<typeof assertOrganizationActor>;

function makeDb(existing: unknown) {
  const findFirst = jest.fn().mockResolvedValue(existing);
  const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return {
    query: {
      reimbursements: { findFirst },
      users: { findFirst: jest.fn().mockResolvedValue({ name: "Employee", email: "employee@example.invalid" }) },
    },
    update,
    _set: set,
    _where: where,
  };
}

const EXISTING = {
  id: 1,
  orgId: "org-a",
  userId: "employee-user",
  amount: "500.00",
  status: "PENDING",
};

const BODY = { status: "APPROVED" as const };

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ReimbursementsService — actor resolution on approval", () => {
  it("rejects a non-member: throws NotFoundException and does not write", async () => {
    const db = makeDb(EXISTING);
    mockAssertActor.mockRejectedValue(
      new OrganizationActorError("org-a", { kind: "user", userId: "approver" }, "no-membership"),
    );
    const svc = new ReimbursementsService(db as never, { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never);

    await expect(svc.updateStatus("org-a", "approver", 1, BODY)).rejects.toThrow(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects a SUSPENDED member: throws ForbiddenException and does not write", async () => {
    const db = makeDb(EXISTING);
    mockAssertActor.mockRejectedValue(
      new OrganizationActorError("org-a", { kind: "user", userId: "approver" }, "membership-inactive"),
    );
    const svc = new ReimbursementsService(db as never, { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never);

    await expect(svc.updateStatus("org-a", "approver", 1, BODY)).rejects.toThrow(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects a different-org member: throws NotFoundException (not ForbiddenException)", async () => {
    const db = makeDb(EXISTING);
    const err = new OrganizationActorError(
      "org-a",
      { kind: "user", userId: "other-org-approver" },
      "membership-in-another-organization",
    );
    mockAssertActor.mockRejectedValue(err);
    const svc = new ReimbursementsService(db as never, { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never);

    await expect(svc.updateStatus("org-a", "other-org-approver", 1, BODY)).rejects.toThrow(
      NotFoundException,
    );
    await expect(svc.updateStatus("org-a", "other-org-approver", 1, BODY)).rejects.not.toThrow(
      ForbiddenException,
    );
  });

  it("writes both approved_by and approved_by_membership_id for a valid approval", async () => {
    const db = makeDb(EXISTING);
    mockAssertActor.mockResolvedValue({
      orgId: "org-a",
      membershipId: 42,
      userId: "approver",
      organizationPersonId: null,
      role: "MEMBER",
      isOwner: false,
      resolvedVia: "user" as const,
    });
    const svc = new ReimbursementsService(db as never, { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never);

    const result = await svc.updateStatus("org-a", "approver", 1, BODY);

    expect(result).toEqual({ ok: true });
    expect(db.update).toHaveBeenCalled();
    const setArg = db._set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toMatchObject({
      status: "APPROVED",
      approvedBy: "approver",
      approvedByMembershipId: 42,
    });
  });

  it("blocks self-approval before the actor resolution step", async () => {
    const db = makeDb({ ...EXISTING, userId: "approver" });
    const svc = new ReimbursementsService(db as never, { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never);

    const result = await svc.updateStatus("org-a", "approver", 1, BODY);

    expect(result).toEqual({ ok: false, reason: "own_request" });
    expect(mockAssertActor).not.toHaveBeenCalled();
  });
});
