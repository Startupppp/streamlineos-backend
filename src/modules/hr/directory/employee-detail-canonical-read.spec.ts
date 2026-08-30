import { EmployeeMutationsService } from "./employee-mutations.service";

describe("EmployeeMutationsService canonical employment reads", () => {
  it("reads employment facts from the organization's primary employment", async () => {
    const member = {
      role: "MEMBER",
      user: {
        id: "user-1",
        name: "Legacy Name",
        firstName: "Legacy",
        lastName: "Name",
        email: "legacy@example.com",
        image: null,
        isActive: true,
        bio: null,
        linkedinUrl: null,
        twitterUrl: null,
        githubUrl: null,
        websiteUrl: null,
        phone: null,
      },
    };
    const employment = {
      id: 9,
      personId: 8,
      employeeNumber: "CAN-9",
      lifecycleStatus: "ACTIVE",
      workerType: "FULL_TIME",
      departmentId: "canonical-dept",
      designation: "Canonical Role",
      joiningDate: "2026-01-01",
      probationEndDate: null,
      confirmationDate: null,
    };
    const skillsQuery = { from: jest.fn(), where: jest.fn().mockResolvedValue([]) };
    skillsQuery.from.mockReturnValue(skillsQuery);
    const employmentQuery = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue([employment]),
    };
    employmentQuery.from.mockReturnValue(employmentQuery);
    employmentQuery.innerJoin.mockReturnValue(employmentQuery);
    employmentQuery.where.mockReturnValue(employmentQuery);
    const db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(member) } },
      select: jest
        .fn()
        .mockReturnValueOnce(skillsQuery)
        .mockReturnValueOnce(employmentQuery),
    };
    const service = new EmployeeMutationsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getFacts: jest.fn().mockResolvedValue({ userId: "user-1", employmentId: 9, employeeNumber: "CAN-9", designation: "Canonical Role", joiningDate: "2026-01-01", departmentId: "canonical-dept", locationId: null, managerUserId: null }) } as never,
    );

    const result = await service.getEmployeeDetail(
      "org-1",
      "actor-1",
      "user-1",
      "all",
    );

    expect(result).toEqual(
      expect.objectContaining({
        designation: "Canonical Role",
        employeeId: "CAN-9",
        orgDepartmentId: "canonical-dept",
        joiningDate: "2026-01-01",
      }),
    );
    expect(result).not.toHaveProperty("monthlySalary");
  });
});
