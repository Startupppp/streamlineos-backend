process.env.APP_URL ??= "http://localhost:1000";

jest.mock("../../../common/tenant/org-membership", () => ({
  assertUsersInOrg: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/org/sync-org-unit-placement", () => ({
  syncOrgUnitPlacement: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/hr/sync-canonical-employment-fields", () => ({
  syncCanonicalEmploymentFields: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../common/date", () => {
  const actual = jest.requireActual<typeof import("../../../common/date")>(
    "../../../common/date",
  );
  return {
    ...actual,
    differenceInDays: jest.fn(actual.differenceInDays),
  };
});

import { BadRequestException } from "@nestjs/common";
import { differenceInDays } from "../../../common/date";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { updateEmployeeSchema } from "./dto/hr-directory.schemas";
import { EmployeeMutationsService } from "./employee-mutations.service";

function ctx(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId: "org-1",
    role: "HR",
    permissions: ["hr:employees:manage"],
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    ...overrides,
  };
}

function buildService(scope: DataScope, targetMember: object | null = { userId: "target-1" }) {
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const tx = {
    update: jest.fn().mockReturnValue({ set: updateSet }),
  };
  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(targetMember),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue({
          firstName: "Target",
          lastName: "Employee",
          name: "Target Employee",
          joiningDate: "2026-08-01",
        }),
      },
    },
    execute: jest.fn().mockResolvedValue([{ creates_cycle: false }]),
    transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(
      scope === "none"
        ? new Map<string, DataScope>()
        : new Map<string, DataScope>([["hr:employees:manage", scope]]),
    ),
  };
  const service = new EmployeeMutationsService(
    db as never,
    { invalidate: jest.fn() } as never,
    { logCritical: jest.fn() } as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    access as never,
  );

  return { access, db, service, tx, updateSet };
}

describe("EmployeeMutationsService.updateEmployee authorization", () => {
  it("ignores stale role and token claims when AccessService has no manage grant", async () => {
    const { access, db, service } = buildService("none");
    const staleActor = ctx({
      role: "LEGACY_HR_ADMIN",
      permissions: ["hr:employees:manage"],
    });

    await expect(
      service.updateEmployee(staleActor, "target-1", { designation: "Manager" }),
    ).rejects.toThrow("You do not have permission to update this employee.");

    expect(access.resolveUserPermissions).toHaveBeenCalledWith("org-1", "actor-1");
    expect(db.query.organizationMembers.findFirst).not.toHaveBeenCalled();
  });

  it("allows a database-resolved manage grant even when the token claim is empty", async () => {
    const { service } = buildService("all");
    const grantedActor = ctx({ role: "MEMBER", permissions: [] });

    await expect(
      service.updateEmployee(grantedActor, "target-1", { designation: "Manager" }),
    ).resolves.toEqual({ success: true });
  });

  it("retains self-service updates without granting access to another employee", async () => {
    const { service } = buildService("none", { userId: "actor-1" });

    await expect(
      service.updateEmployee(ctx({ permissions: [] }), "actor-1", { phone: "+919999999999" }),
    ).resolves.toEqual({ success: true });
  });

  it("rejects isActive:false through the dedicated termination workflow", async () => {
    const { service } = buildService("all");

    await expect(
      service.updateEmployee(ctx(), "target-1", { isActive: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("checks a proposed manager chain in one recursive query", async () => {
    const { db, service } = buildService("all");

    await expect(
      service.updateEmployee(ctx(), "target-1", {
        reportingTo: "manager-1",
      }),
    ).resolves.toEqual({ success: true });

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.query.users.findFirst).toHaveBeenCalledTimes(1);
  });

  it("shifts pending onboarding due dates from the pre-update joining date", async () => {
    const { service, updateSet } = buildService("all");
    const dayDifference = jest.mocked(differenceInDays);

    await expect(
      service.updateEmployee(ctx(), "target-1", {
        joiningDate: "2026-08-11",
      }),
    ).resolves.toEqual({ success: true });

    expect(updateSet).toHaveBeenCalledTimes(2);
    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({
      joiningDate: "2026-08-11",
    });
    expect(updateSet.mock.calls[1]?.[0]).toHaveProperty("dueDate");
    expect(dayDifference).toHaveBeenCalledWith(
      new Date("2026-08-11"),
      new Date("2026-08-01"),
    );
    expect(dayDifference).toHaveReturnedWith(10);
  });
});

describe("EmployeeMutationsService base response boundary", () => {
  it("does not serialize private fields returned by the global user relation", async () => {
    const forbiddenFields = {
      monthlySalary: 100_000,
      bankDetails: { accountNumber: "123456789" },
      taxId: "ABCDE1234F",
      dateOfBirth: "1990-01-01",
      personalEmail: "private@example.test",
      address: { city: "Private" },
      emergencyContact: { phone: "+919999999999" },
    };
    const memberQuery = jest.fn().mockResolvedValue({
      role: "MEMBER",
      user: {
        id: "target-1",
        name: "Target Employee",
        firstName: "Target",
        lastName: "Employee",
        email: "target@example.test",
        designation: "Engineer",
        employeeId: "EMP-1",
        orgDepartmentId: "department-1",
        image: null,
        isActive: true,
        joiningDate: "2026-08-01",
        reportingTo: null,
        bio: null,
        linkedinUrl: null,
        twitterUrl: null,
        githubUrl: null,
        websiteUrl: null,
        phone: null,
        ...forbiddenFields,
      },
    });
    const skillsQuery = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    };
    const employmentQuery = {
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const db = {
      query: { organizationMembers: { findFirst: memberQuery } },
      select: jest
        .fn()
        .mockReturnValueOnce(skillsQuery)
        .mockReturnValueOnce(employmentQuery),
    };
    const service = new EmployeeMutationsService(
      db as never,
      { invalidate: jest.fn() } as never,
      { logCritical: jest.fn() } as never,
      { emit: jest.fn() } as never,
      {} as never,
    );

    const response = await service.getEmployeeDetail(
      "org-1",
      "actor-1",
      "target-1",
      "all",
    );

    expect(response).toMatchObject({ id: "target-1", email: "target@example.test" });
    for (const forbiddenField of Object.keys(forbiddenFields)) {
      expect(response).not.toHaveProperty(forbiddenField);
    }
  });
});

describe("updateEmployeeSchema sensitive-field boundary", () => {
  it.each([
    ["taxId", { taxId: "ABCDE1234F" }],
    ["monthlySalary", { monthlySalary: 100_000 }],
    ["bankDetails", { bankDetails: { accountNumber: "123456789" } }],
  ])("rejects %s on the general profile endpoint", (_field, input) => {
    expect(updateEmployeeSchema.safeParse(input).success).toBe(false);
  });

  it("continues to accept non-sensitive profile fields", () => {
    expect(
      updateEmployeeSchema.safeParse({
        firstName: "Ada",
        designation: "Engineering Manager",
        phone: "+919999999999",
      }).success,
    ).toBe(true);
  });
});
