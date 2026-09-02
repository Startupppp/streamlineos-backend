process.env.APP_URL ??= "http://localhost:1000";

import * as applyScopeModule from "../../access/apply-scope";
import { LeaveApproverService } from "./leave-approver.service";

function selectLimit(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

const APPROVER = {
  id: "manager-1",
  name: "Manager",
  firstName: "Direct",
  lastName: "Manager",
  email: "manager@example.com",
  image: null,
  designation: null,
};

function makeEmployment(managerUserId: string | null = "manager-1") {
  return {
    getFacts: jest.fn().mockResolvedValue({
      userId: "employee-1",
      employmentId: null,
      employeeNumber: null,
      designation: null,
      joiningDate: null,
      departmentId: null,
      locationId: null,
      managerUserId,
    }),
    getFactsBatch: jest.fn().mockResolvedValue(new Map()),
  };
}

describe("LeaveApproverService", () => {
  afterEach(() => jest.restoreAllMocks());

  it("prefers the direct manager when AccessService grants all-scope approval", async () => {
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(selectLimit([{ userId: "employee-1" }]))
        .mockReturnValueOnce(selectLimit([APPROVER])),
    };
    const access = {
      membersWithPermission: jest.fn().mockResolvedValue([
        { userId: "hr-1", membershipId: 3 },
      ]),
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValue(new Map([["hr:leaves:approve", "all"]])),
    };
    const service = new LeaveApproverService(db as never, access as never, makeEmployment("manager-1") as never);

    await expect(service.resolve("org-1", "employee-1")).resolves.toEqual(
      APPROVER,
    );
    expect(access.resolveUserPermissions).toHaveBeenCalledWith(
      "org-1",
      "manager-1",
    );
  });

  it("skips a manager whose scope cannot include the subject", async () => {
    const fallback = { ...APPROVER, id: "hr-1", email: "hr@example.com" };
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(selectLimit([{ userId: "employee-1" }]))
        .mockReturnValueOnce(selectLimit([fallback])),
    };
    const access = {
      membersWithPermission: jest.fn().mockResolvedValue([
        { userId: "hr-1", membershipId: 3 },
      ]),
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValueOnce(new Map([["hr:leaves:approve", "own"]]))
        .mockResolvedValueOnce(new Map([["hr:leaves:approve", "all"]])),
    };
    const service = new LeaveApproverService(db as never, access as never, makeEmployment("manager-1") as never);

    await expect(service.resolve("org-1", "employee-1")).resolves.toEqual(
      fallback,
    );
  });

  it("reads every candidate's membership in one query, not one per candidate", async () => {
    const winner = { ...APPROVER, id: "hr-2", email: "hr2@example.com" };
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(selectLimit([{ userId: "employee-1" }]))
        .mockReturnValueOnce(selectLimit([winner]))
        .mockReturnValue(selectLimit([winner])),
    };
    const access = {
      membersWithPermission: jest.fn().mockResolvedValue([
        { userId: "hr-1", membershipId: 3 },
        { userId: "hr-2", membershipId: 4 },
      ]),
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValue(new Map([["hr:leaves:approve", "all"]])),
    };
    const service = new LeaveApproverService(db as never, access as never, makeEmployment("manager-1") as never);

    await expect(service.resolve("org-1", "employee-1")).resolves.toEqual(winner);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("checks team scope against the subject in the tenant", async () => {
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(selectLimit([{ userId: "employee-1" }]))
        .mockReturnValueOnce(selectLimit([APPROVER]))
        .mockReturnValueOnce(selectLimit([{ id: 11 }])),
    };
    const access = {
      membersWithPermission: jest.fn().mockResolvedValue([]),
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValue(new Map([["hr:leaves:approve", "team"]])),
    };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new LeaveApproverService(db as never, access as never, makeEmployment("manager-1") as never);

    await expect(service.resolve("org-1", "employee-1")).resolves.toEqual(
      APPROVER,
    );
    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "manager-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });
});
