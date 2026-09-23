import { LeaveApproverService } from "../leave-approver.service";

const ORG = "org-1";
const EMPLOYEE = "user-employee";
const OWNER = "user-owner";

function serviceWith(options: {
  ownerIsOwnerFlag: boolean;
  resolvedPermissions?: Map<string, string>;
  managerUserId?: string | null;
}) {
  const memberCheck = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue([{ userId: EMPLOYEE }]),
  };
  memberCheck.from.mockReturnValue(memberCheck);
  memberCheck.where.mockReturnValue(memberCheck);

  const candidateQuery = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue([
      {
        id: OWNER,
        name: "Founder",
        firstName: "Foun",
        lastName: "Der",
        email: "founder@example.test",
        image: null,
        isOwner: options.ownerIsOwnerFlag,
      },
    ]),
  };
  candidateQuery.from.mockReturnValue(candidateQuery);
  candidateQuery.innerJoin.mockReturnValue(candidateQuery);
  candidateQuery.where.mockReturnValue(candidateQuery);

  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce(memberCheck)
      .mockReturnValueOnce(candidateQuery),
  };

  const access = {
    membersWithPermission: jest.fn().mockResolvedValue([{ userId: OWNER, membershipId: 1 }]),
    resolveUserPermissions: jest
      .fn()
      .mockResolvedValue(options.resolvedPermissions ?? new Map()),
  };

  const employment = {
    getFacts: jest.fn().mockResolvedValue({
      userId: EMPLOYEE,
      managerUserId: options.managerUserId ?? null,
      designation: null,
    }),
    getFactsBatch: jest.fn().mockResolvedValue(new Map()),
  };

  return {
    service: new LeaveApproverService(db as never, access as never, employment as never),
    access,
  };
}

describe("an India SMB founder is a valid leave approver, because membersWithPermission counts ownership and resolveUserPermissions does not", () => {
  it("resolves the org owner even though their role grants carry no hr:leaves:approve", async () => {
    const { service, access } = serviceWith({ ownerIsOwnerFlag: true });

    const approver = await service.resolve(ORG, EMPLOYEE);

    expect(approver).toEqual(
      expect.objectContaining({ id: OWNER, email: "founder@example.test" }),
    );
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("does not leak the ownership flag into the approver the API returns", async () => {
    const { service } = serviceWith({ ownerIsOwnerFlag: true });

    const approver = await service.resolve(ORG, EMPLOYEE);

    expect(approver).not.toHaveProperty("isOwner");
  });

  it("still refuses a non-owner whose leave-approve scope covers nobody else", async () => {
    const { service } = serviceWith({
      ownerIsOwnerFlag: false,
      resolvedPermissions: new Map([["hr:leaves:approve", "self"]]),
    });

    expect(await service.resolve(ORG, EMPLOYEE)).toBeNull();
  });

  it("accepts a non-owner who genuinely holds an unrestricted approve scope", async () => {
    const { service } = serviceWith({
      ownerIsOwnerFlag: false,
      resolvedPermissions: new Map([["hr:leaves:approve", "all"]]),
    });

    expect(await service.resolve(ORG, EMPLOYEE)).toEqual(
      expect.objectContaining({ id: OWNER }),
    );
  });

  it("never offers the requester themselves as their own approver", async () => {
    const { service } = serviceWith({ ownerIsOwnerFlag: true });

    expect(await service.resolve(ORG, OWNER)).toBeNull();
  });
});
