import { ConflictException } from "@nestjs/common";
import { genderEnum } from "../../../db/schema";
import {
  ALREADY_MEMBER_MESSAGE,
  MembershipAdmissionService,
  type AdmissionScreen,
} from "../../organization/core/membership-admission.service";
import {
  bulkOnboardEmployeeRowSchema,
  bulkOnboardEmployeesSchema,
  onboardEmployeeSchema,
  type BulkOnboardEmployeeRow,
} from "./dto/hr-directory.schemas";
import { planBulkOnboarding } from "./bulk-onboarding/bulk-onboarding-plan";
import type { DepartmentCatalog } from "./bulk-onboarding/bulk-onboarding-departments";

const DEPARTMENT_ID = "dept-engineering";
const OTHER_TENANT_DEPARTMENT_ID = "dept-of-another-org";

function singleInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada.lovelace@example.com",
    designation: "Engineer",
    reportingManagerUserId: "user-manager",
    ...overrides,
  };
}

function bulkInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return singleInput({ department: "Engineering", ...overrides });
}

function firstMessage(result: { success: boolean; error?: { issues: { message: string }[] } }): string {
  return result.error?.issues[0]?.message ?? "";
}

function catalog(): DepartmentCatalog {
  return {
    byKey: new Map([["engineering", DEPARTMENT_ID]]),
    activeIds: new Set([DEPARTMENT_ID]),
    usedCodes: new Set(),
    created: false,
  };
}

function clearScreens(emails: readonly [string, string | null][]): Map<string, AdmissionScreen> {
  return new Map(emails.map(([email, userId]) => [email, { kind: "clear", userId }]));
}

function plannedRow(index: number, overrides: Partial<BulkOnboardEmployeeRow> = {}): BulkOnboardEmployeeRow {
  return {
    firstName: "Ada",
    lastName: `Lovelace${String(index)}`,
    email: `ada.lovelace${String(index)}@example.com`,
    designation: "Engineer",
    department: "Engineering",
    reportingManagerUserId: "user-manager",
    ...overrides,
  };
}

describe("employee onboarding validation — single and bulk agree at the schema", () => {
  it("rejects a whitespace-only first name on both paths with the same message", () => {
    const single = onboardEmployeeSchema.safeParse(singleInput({ firstName: "   " }));
    const bulk = bulkOnboardEmployeeRowSchema.safeParse(bulkInput({ firstName: "   " }));

    expect(single.success).toBe(false);
    expect(bulk.success).toBe(false);
    expect(firstMessage(single)).toBe("First name is required");
    expect(firstMessage(bulk)).toBe(firstMessage(single));
  });

  it("rejects a whitespace-only last name on both paths with the same message", () => {
    const single = onboardEmployeeSchema.safeParse(singleInput({ lastName: "\t\n " }));
    const bulk = bulkOnboardEmployeeRowSchema.safeParse(bulkInput({ lastName: "\t\n " }));

    expect(single.success).toBe(false);
    expect(bulk.success).toBe(false);
    expect(firstMessage(single)).toBe("Last name is required");
    expect(firstMessage(bulk)).toBe(firstMessage(single));
  });

  it("rejects a blank designation on both paths with the same message", () => {
    const single = onboardEmployeeSchema.safeParse(singleInput({ designation: "" }));
    const bulk = bulkOnboardEmployeeRowSchema.safeParse(bulkInput({ designation: "  " }));

    expect(single.success).toBe(false);
    expect(bulk.success).toBe(false);
    expect(firstMessage(single)).toBe("Designation is required");
    expect(firstMessage(bulk)).toBe(firstMessage(single));
  });

  it("rejects a malformed joining date on both paths instead of writing NaN-NaN-NaN", () => {
    for (const malformed of ["13/45/2020", "not-a-date", "2020-13-45"]) {
      const single = onboardEmployeeSchema.safeParse(singleInput({ joiningDate: malformed }));
      const bulk = bulkOnboardEmployeeRowSchema.safeParse(bulkInput({ joiningDate: malformed }));

      expect(single.success).toBe(false);
      expect(bulk.success).toBe(false);
      expect(firstMessage(single)).toBe("Joining date must be a valid date");
      expect(firstMessage(bulk)).toBe(firstMessage(single));
    }
  });

  it("still accepts the ISO datetime the wizard sends, a date-only string and an absent value", () => {
    for (const supplied of ["2026-01-15T00:00:00.000Z", "2026-01-15", "", undefined]) {
      const single = onboardEmployeeSchema.safeParse(singleInput({ joiningDate: supplied }));
      const bulk = bulkOnboardEmployeeRowSchema.safeParse(bulkInput({ joiningDate: supplied }));

      expect(single.success).toBe(true);
      expect(bulk.success).toBe(true);
    }
  });

  it("trims names and designation on both paths", () => {
    const single = onboardEmployeeSchema.parse(
      singleInput({ firstName: "  Ada ", lastName: " Lovelace  ", designation: "  Engineer " }),
    );
    const bulk = bulkOnboardEmployeeRowSchema.parse(
      bulkInput({ firstName: "  Ada ", lastName: " Lovelace  ", designation: "  Engineer " }),
    );

    expect(single).toMatchObject({ firstName: "Ada", lastName: "Lovelace", designation: "Engineer" });
    expect(bulk).toMatchObject({ firstName: "Ada", lastName: "Lovelace", designation: "Engineer" });
  });

  it("narrows gender to the users.gender pgEnum rather than a parallel literal", () => {
    for (const value of genderEnum.enumValues) {
      expect(onboardEmployeeSchema.safeParse(singleInput({ gender: value })).success).toBe(true);
      expect(bulkOnboardEmployeeRowSchema.safeParse(bulkInput({ gender: value })).success).toBe(true);
    }

    expect(onboardEmployeeSchema.safeParse(singleInput({ gender: "PREFER_NOT_TO_SAY" })).success).toBe(false);
    expect(bulkOnboardEmployeeRowSchema.safeParse(bulkInput({ gender: "PREFER_NOT_TO_SAY" })).success).toBe(false);
  });

  it("names the offending row when one upload row among good rows is invalid", () => {
    const employees = [bulkInput(), bulkInput({ joiningDate: "13/45/2020" }), bulkInput()];

    const parsed = bulkOnboardEmployeesSchema.safeParse({ employees });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["employees", 1, "joiningDate"]);
    expect(parsed.error?.issues[0]?.message).toBe("Joining date must be a valid date");
  });
});

describe("bulk onboarding plan — per-row outcome in original order", () => {
  it("rejects only the row whose departmentId belongs to another tenant", () => {
    const rows = [
      plannedRow(1),
      plannedRow(2, { department: undefined, departmentId: OTHER_TENANT_DEPARTMENT_ID }),
      plannedRow(3),
    ];

    const plan = planBulkOnboarding(
      rows,
      catalog(),
      clearScreens([
        ["ada.lovelace1@example.com", null],
        ["ada.lovelace2@example.com", null],
        ["ada.lovelace3@example.com", null],
      ]),
      new Map(),
      new Map(),
      new Set<string>(),
      new Map(),
    );

    expect(plan.rejected).toEqual([
      {
        row: 2,
        email: "ada.lovelace2@example.com",
        success: false,
        error:
          "Unknown department. Create it under Organization → Departments (or HR departments) first.",
      },
    ]);
    expect(plan.accepted.map((entry) => entry.row)).toEqual([1, 3]);
  });

  it("rejects only the globally suspended account, with restore guidance", () => {
    const rows = [plannedRow(1), plannedRow(2), plannedRow(3)];

    const plan = planBulkOnboarding(
      rows,
      catalog(),
      clearScreens([
        ["ada.lovelace1@example.com", "user-1"],
        ["ada.lovelace2@example.com", "user-2"],
        ["ada.lovelace3@example.com", null],
      ]),
      new Map(),
      new Map(),
      new Set(["user-2"]),
      new Map(),
    );

    expect(plan.rejected).toEqual([
      {
        row: 2,
        email: "ada.lovelace2@example.com",
        success: false,
        error:
          "This account is globally suspended. Contact platform support to restore it before adding to an organization.",
      },
    ]);
    expect(plan.accepted.map((entry) => entry.row)).toEqual([1, 3]);
  });

  it("keeps 1-based original row numbers after earlier rows are rejected", () => {
    const rows = [
      plannedRow(1, { department: "Marketing" }),
      plannedRow(2, { department: "Marketing" }),
      plannedRow(3),
      plannedRow(4),
    ];

    const plan = planBulkOnboarding(
      rows,
      catalog(),
      clearScreens([
        ["ada.lovelace1@example.com", null],
        ["ada.lovelace2@example.com", null],
        ["ada.lovelace3@example.com", null],
        ["ada.lovelace4@example.com", null],
      ]),
      new Map(),
      new Map(),
      new Set<string>(),
      new Map(),
    );

    expect(plan.rejected.map((entry) => entry.row)).toEqual([1, 2]);
    expect(plan.accepted.map((entry) => entry.row)).toEqual([3, 4]);
  });

  it("accepts the corrected rows on a retry while still refusing a persisted employee ID", () => {
    const retry = [
      plannedRow(1, { employeeId: "EMP-PERSISTED" }),
      plannedRow(2, { employeeId: "EMP-FRESH" }),
    ];

    const plan = planBulkOnboarding(
      retry,
      catalog(),
      clearScreens([
        ["ada.lovelace1@example.com", "user-1"],
        ["ada.lovelace2@example.com", "user-2"],
      ]),
      new Map([["EMP-PERSISTED", "someone-else"]]),
      new Map(),
      new Set<string>(),
      new Map(),
    );

    expect(plan.rejected).toEqual([
      {
        row: 1,
        email: "ada.lovelace1@example.com",
        success: false,
        error: 'Employee ID "EMP-PERSISTED" is already in use in your organization.',
      },
    ]);
    expect(plan.accepted.map((entry) => [entry.row, entry.employeeNumber])).toEqual([
      [2, "EMP-FRESH"],
    ]);
  });
});

describe("bulk onboarding admission failures never read as success", () => {
  function buildTx() {
    const updateReturning = jest.fn().mockResolvedValue([]);
    const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const update = jest.fn().mockReturnValue({ set: updateSet });
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
    const execute = jest.fn().mockResolvedValue([]);
    return { update, insert, execute };
  }

  function admissionHarness(options: { limitError?: Error; membershipError?: Error }) {
    const tx = buildTx();
    const assertWithinLimit = options.limitError
      ? jest.fn().mockRejectedValue(options.limitError)
      : jest.fn().mockResolvedValue(undefined);
    const createMemberships = options.membershipError
      ? jest.fn().mockRejectedValue(options.membershipError)
      : jest.fn().mockResolvedValue(new Map([["user-1", 7]]));
    const seatLedger = { recordSeatEvents: jest.fn().mockResolvedValue(undefined) };
    const service = new MembershipAdmissionService(
      { assertWithinLimit } as never,
      seatLedger as never,
    );

    return {
      admit: () =>
        service.admitMany(tx as never, {
          orgId: "org-1",
          actor: { userId: "actor-1" },
          membership: { createMemberships } as never,
          seatReason: "employee onboarded",
          candidates: [
            {
              email: "ada.lovelace1@example.com",
              role: "MEMBER",
              screen: { kind: "clear", userId: "user-1" },
              createUserIfMissing: null,
            },
          ],
        }),
      createMemberships,
      assertWithinLimit,
      seatLedger,
    };
  }

  it("surfaces the same person imported concurrently as a conflict, not an unhandled 23505", async () => {
    const duplicate = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint_name: "organization_members_org_id_user_id_unique",
    });

    await expect(admissionHarness({ membershipError: duplicate }).admit()).rejects.toThrow(
      ConflictException,
    );
    await expect(admissionHarness({ membershipError: duplicate }).admit()).rejects.toThrow(
      ALREADY_MEMBER_MESSAGE,
    );
  });

  it("stops the batch at the capacity edge and creates no membership or seat event", async () => {
    const limitError = new Error("Member limit reached for your plan");
    const { admit, createMemberships, assertWithinLimit, seatLedger } = admissionHarness({
      limitError,
    });

    await expect(admit()).rejects.toThrow("Member limit reached for your plan");
    expect(assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(createMemberships).not.toHaveBeenCalled();
    expect(seatLedger.recordSeatEvents).not.toHaveBeenCalled();
  });
});

describe("bulk onboarding resolves the reporting manager before any write", () => {
  it("rejects the row whose manager email is not an active member, and resolves the one that is", () => {
    const rows = [
      plannedRow(1, { reportingManagerUserId: undefined, reportingManagerEmail: "boss@example.com" }),
      plannedRow(2, { reportingManagerUserId: undefined, reportingManagerEmail: "stranger@example.com" }),
    ];

    const plan = planBulkOnboarding(
      rows,
      catalog(),
      clearScreens([
        ["ada.lovelace1@example.com", null],
        ["ada.lovelace2@example.com", null],
      ]),
      new Map(),
      new Map(),
      new Set<string>(),
      new Map([["boss@example.com", "user-boss"]]),
    );

    expect(plan.accepted.map((employee) => [employee.row, employee.reportingManagerUserId])).toEqual([[1, "user-boss"]]);
    expect(plan.rejected).toEqual([
      expect.objectContaining({ row: 2, error: expect.stringContaining("stranger@example.com") }),
    ]);
  });
});
