import {
  createTestSuiteSchema,
  updateTestSuiteSchema,
  createTestCaseSchema,
  updateTestCaseSchema,
  createTestRunSchema,
  updateTestRunSchema,
} from "./dto/qa.schemas";

describe("createTestSuiteSchema — whitespace-only name persists to DB until trim+min", () => {
  it("rejects whitespace-only name", () => {
    const result = createTestSuiteSchema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a non-blank name", () => {
    const result = createTestSuiteSchema.safeParse({ name: "Login flows" });
    expect(result.success).toBe(true);
  });
});

describe("updateTestSuiteSchema — whitespace-only name update persists to DB until trim+min", () => {
  it("rejects whitespace-only name on update", () => {
    const result = updateTestSuiteSchema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a partial update that omits the name", () => {
    const result = updateTestSuiteSchema.safeParse({ description: "Auth regression" });
    expect(result.success).toBe(true);
  });
});

describe("createTestCaseSchema — whitespace-only title persists to DB until trim+min", () => {
  it("rejects whitespace-only title", () => {
    const result = createTestCaseSchema.safeParse({ title: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a non-blank title", () => {
    const result = createTestCaseSchema.safeParse({ title: "Login with invalid password" });
    expect(result.success).toBe(true);
  });
});

describe("updateTestCaseSchema — whitespace-only title persists to DB until trim+min", () => {
  it("rejects whitespace-only title on update", () => {
    const result = updateTestCaseSchema.safeParse({ title: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a partial update that only changes priority", () => {
    const result = updateTestCaseSchema.safeParse({ priority: "high" });
    expect(result.success).toBe(true);
  });
});

describe("createTestRunSchema — whitespace-only name persists to DB until trim+min", () => {
  it("rejects whitespace-only name", () => {
    const result = createTestRunSchema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a non-blank name", () => {
    const result = createTestRunSchema.safeParse({ name: "Sprint 12 regression run" });
    expect(result.success).toBe(true);
  });
});

describe("updateTestRunSchema — whitespace-only name persists to DB until trim+min", () => {
  it("rejects whitespace-only name on update", () => {
    const result = updateTestRunSchema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a partial update that only changes status", () => {
    const result = updateTestRunSchema.safeParse({ status: "in_progress" });
    expect(result.success).toBe(true);
  });
});
