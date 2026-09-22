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

describe("Reports to is required at the onboarding boundary", () => {
  it("rejects an employee with neither a reporting manager nor a top-level exception", () => {
    const result = onboardEmployeeSchema.safeParse(BASE);

    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([expect.stringMatching(/^reportingManagerUserId: Reports to is required/)]);
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

  it("holds spreadsheet rows to the same requirement", () => {
    const result = bulkOnboardEmployeeRowSchema.safeParse({ ...BASE, department: "Engineering" });

    expect(issuesOf(result)).toEqual([expect.stringMatching(/^reportingManagerUserId: Reports to is required/)]);
  });
});
