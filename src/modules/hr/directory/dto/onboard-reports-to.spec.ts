import { bulkOnboardEmployeeRowSchema, onboardEmployeeSchema } from "./hr-directory.schemas";

const BASE = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  designation: "Engineer",
};

function issuesOf(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("HRM-15: the reporting manager is optional at the onboarding boundary; the server resolves the fallback", () => {
  it("accepts an employee with no manager and no top-level exception, leaving D2 fallback to the service", () => {
    expect(onboardEmployeeSchema.safeParse(BASE).success).toBe(true);
  });

  it("accepts a reporting manager", () => {
    expect(onboardEmployeeSchema.safeParse({ ...BASE, reportingManagerUserId: "user-manager" }).success).toBe(true);
  });

  it("accepts a top-level role only when the exception is explained", () => {
    expect(issuesOf(onboardEmployeeSchema.safeParse({ ...BASE, topLevelRole: true }))).toEqual([
      expect.stringMatching(/^topLevelRoleReason: Explain why/),
    ]);
    expect(
      onboardEmployeeSchema.safeParse({ ...BASE, topLevelRole: true, topLevelRoleReason: "Founder and CEO" }).success,
    ).toBe(true);
  });

  it("refuses a top-level role that also names a manager", () => {
    const result = onboardEmployeeSchema.safeParse({
      ...BASE,
      topLevelRole: true,
      topLevelRoleReason: "CEO",
      reportingManagerUserId: "user-manager",
    });

    expect(issuesOf(result)).toEqual([expect.stringMatching(/^topLevelRole: A top-level role cannot also/)]);
  });

  it("lets a spreadsheet row name the manager by email instead of user id", () => {
    const row = { ...BASE, department: "Engineering", reportingManagerEmail: "Boss@Example.com" };

    const result = bulkOnboardEmployeeRowSchema.safeParse(row);

    expect(result.success).toBe(true);
    expect(result.success && result.data.reportingManagerEmail).toBe("boss@example.com");
  });

  it("accepts a spreadsheet row with a blank manager, which the fallback policy resolves", () => {
    expect(bulkOnboardEmployeeRowSchema.safeParse({ ...BASE, department: "Engineering" }).success).toBe(true);
  });

  it("refuses a spreadsheet top-level row that also names a primary manager by the canonical column", () => {
    const result = bulkOnboardEmployeeRowSchema.safeParse({
      ...BASE,
      department: "Engineering",
      topLevelRole: true,
      topLevelRoleReason: "CEO",
      primaryManagerEmail: "boss@example.com",
    });

    expect(issuesOf(result)).toEqual([expect.stringMatching(/^topLevelRole: A top-level role cannot also/)]);
  });

  it("caps secondary managers on a single onboarding at three", () => {
    const four = ["a", "b", "c", "d"].map((managerUserId) => ({ managerUserId }));
    expect(onboardEmployeeSchema.safeParse({ ...BASE, secondaryManagers: four.slice(0, 3) }).success).toBe(true);
    expect(onboardEmployeeSchema.safeParse({ ...BASE, secondaryManagers: four }).success).toBe(false);
  });
});
