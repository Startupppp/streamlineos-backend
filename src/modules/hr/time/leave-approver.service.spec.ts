process.env.APP_URL ??= "http://localhost:1000";

import * as applyScopeModule from "../../access/apply-scope";
import { LeaveApproverService } from "./leave-approver.service";

function selectLimit(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
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
  designation: "Lead",
};

describe("LeaveApproverService", () => {
  afterEach(() => jest.restoreAllMocks());

  it("prefers the direct manager when AccessService grants all-scope approval", async () => {
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(selectLimit([{ reportingTo: "manager-1" }]))
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
    const service = new LeaveApproverService(db as never, access as never);

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
        .mockReturnValueOnce(selectLimit([{ reportingTo: "manager-1" }]))
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
    const service = new LeaveApproverService(db as never, access as never);

    await expect(service.resolve("org-1", "employee-1")).resolves.toEqual(
      fallback,
    );
  });

  it("checks team scope against the subject in the tenant", async () => {
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(selectLimit([{ reportingTo: "manager-1" }]))
        .mockReturnValueOnce(selectLimit([{ id: 11 }]))
        .mockReturnValueOnce(selectLimit([APPROVER])),
    };
    const access = {
      membersWithPermission: jest.fn().mockResolvedValue([]),
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValue(new Map([["hr:leaves:approve", "team"]])),
    };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new LeaveApproverService(db as never, access as never);

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
