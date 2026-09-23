import { Logger } from "@nestjs/common";
import { EmployeeMutationsService } from "./employee-mutations.service";
import { ScopedRead } from "../../access/scoped-read";
import { employeeDetailSchema } from "./dto/directory-response.schemas";

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
    const skillsQuery = { from: jest.fn(), where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) };
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
      ScopedRead.of("org-1", "actor-1", "all"),
      "user-1",
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

describe("employee detail response contract, which nothing enforces outside NODE_ENV=test because production logs the violation and returns the row anyway", () => {
  const USER = {
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
  };

  function serviceWith(
    employment: Record<string, unknown> | null,
    skills: Array<{ name: string; level: number }>,
  ) {
    const skillsQuery = {
      from: jest.fn(),
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(skills) }),
    };
    skillsQuery.from.mockReturnValue(skillsQuery);
    const employmentQuery = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue(employment === null ? [] : [employment]),
    };
    employmentQuery.from.mockReturnValue(employmentQuery);
    employmentQuery.innerJoin.mockReturnValue(employmentQuery);
    employmentQuery.where.mockReturnValue(employmentQuery);
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ role: "MEMBER", user: USER }),
        },
      },
      select: jest
        .fn()
        .mockReturnValueOnce(skillsQuery)
        .mockReturnValueOnce(employmentQuery),
    };
    return new EmployeeMutationsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getFacts: jest.fn().mockResolvedValue({
          userId: "user-1",
          employmentId: null,
          employeeNumber: null,
          designation: null,
          joiningDate: null,
          departmentId: null,
          locationId: null,
          managerUserId: null,
        }),
      } as never,
    );
  }

  it("satisfies its own @ResponseSchema for a fully onboarded employee", async () => {
    const service = serviceWith(
      {
        id: 9,
        personId: 8,
        employeeNumber: "EMP-EKWK62",
        lifecycleStatus: "ACTIVE",
        workerType: "FULL_TIME",
        departmentId: "dept-1",
        designation: "QA Audit Tester",
        joiningDate: "2026-09-23",
        probationEndDate: null,
        confirmationDate: null,
      },
      [{ name: "Testing", level: 3 }],
    );

    const result = await service.getEmployeeDetail(
      ScopedRead.of("org-1", "actor-1", "all"),
      "user-1",
    );

    const parsed = employeeDetailSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("satisfies its own @ResponseSchema for a person with no employment row", async () => {
    const service = serviceWith(null, []);

    const result = await service.getEmployeeDetail(
      ScopedRead.of("org-1", "actor-1", "all"),
      "user-1",
    );

    expect(result).toEqual(expect.objectContaining({ employment: null }));
    const parsed = employeeDetailSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("carries the department on the nested employment, which the handler builds by hand and so can silently omit", async () => {
    const service = serviceWith(
      {
        id: 9,
        personId: 8,
        employeeNumber: "EMP-EKWK62",
        lifecycleStatus: "ACTIVE",
        workerType: "FULL_TIME",
        departmentId: "dept-1",
        designation: "QA Audit Tester",
        joiningDate: "2026-09-23",
        probationEndDate: null,
        confirmationDate: null,
      },
      [],
    );

    const result = await service.getEmployeeDetail(
      ScopedRead.of("org-1", "actor-1", "all"),
      "user-1",
    );

    expect(result?.employment).toEqual(
      expect.objectContaining({ departmentId: "dept-1" }),
    );
  });
});

describe("employee detail survives an enrichment read that fails, because skills and manager are decoration and a 500 there took the whole profile down", () => {
  const USER = {
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
  };

  function serviceWithFailing(part: "skills" | "employment" | "facts") {
    const boom = new Error(`column does not exist (${part})`);
    const skillsQuery = {
      from: jest.fn(),
      where: jest.fn().mockReturnValue({
        limit:
          part === "skills"
            ? jest.fn().mockRejectedValue(boom)
            : jest.fn().mockResolvedValue([]),
      }),
    };
    skillsQuery.from.mockReturnValue(skillsQuery);
    const employmentQuery = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      limit:
        part === "employment"
          ? jest.fn().mockRejectedValue(boom)
          : jest.fn().mockResolvedValue([]),
    };
    employmentQuery.from.mockReturnValue(employmentQuery);
    employmentQuery.innerJoin.mockReturnValue(employmentQuery);
    employmentQuery.where.mockReturnValue(employmentQuery);
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ role: "MEMBER", user: USER }),
        },
      },
      select: jest
        .fn()
        .mockReturnValueOnce(skillsQuery)
        .mockReturnValueOnce(employmentQuery),
    };
    return new EmployeeMutationsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getFacts:
          part === "facts"
            ? jest.fn().mockRejectedValue(boom)
            : jest.fn().mockResolvedValue({
                userId: "user-1",
                managerUserId: null,
              }),
      } as never,
    );
  }

  it.each(["skills", "employment", "facts"] as const)(
    "still returns the profile when the %s read throws",
    async (part) => {
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const service = serviceWithFailing(part);

      const result = await service.getEmployeeDetail(
        ScopedRead.of("org-1", "actor-1", "all"),
        "user-1",
      );

      expect(result).toEqual(
        expect.objectContaining({ id: "user-1", email: "legacy@example.com" }),
      );
      expect(employeeDetailSchema.safeParse(result).success).toBe(true);
      jest.restoreAllMocks();
    },
  );

  it("says which part was unavailable rather than failing silently", async () => {
    const logged = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const service = serviceWithFailing("facts");

    await service.getEmployeeDetail(
      ScopedRead.of("org-1", "actor-1", "all"),
      "user-1",
    );

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("employment-facts unavailable for user-1"),
    );
    jest.restoreAllMocks();
  });
});
