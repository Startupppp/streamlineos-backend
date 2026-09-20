import { caseIdParams } from "./test-cases.controller";
import { suiteIdParams } from "./test-suites.controller";
import { runIdParams, runIdresultIdParams } from "./test-runs.controller";

describe("caseIdParams — build/:projectId/test-cases prefix params", () => {
  it("accepts projectId from controller prefix and caseId from method path", () => {
    expect(() => caseIdParams.parse({ projectId: "3", caseId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = caseIdParams.safeParse({ caseId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => caseIdParams.parse({ projectId: "3", caseId: "7", extra: "x" })).toThrow();
  });
});

describe("suiteIdParams — build/:projectId/test-suites prefix params", () => {
  it("accepts projectId from controller prefix and suiteId from method path", () => {
    expect(() => suiteIdParams.parse({ projectId: "3", suiteId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = suiteIdParams.safeParse({ suiteId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => suiteIdParams.parse({ projectId: "3", suiteId: "7", extra: "x" })).toThrow();
  });
});

describe("runIdParams — build/:projectId/test-runs prefix params", () => {
  it("accepts projectId from controller prefix and runId from method path", () => {
    expect(() => runIdParams.parse({ projectId: "3", runId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = runIdParams.safeParse({ runId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => runIdParams.parse({ projectId: "3", runId: "7", extra: "x" })).toThrow();
  });
});

describe("runIdresultIdParams — build/:projectId/test-runs/:runId/results/:resultId prefix params", () => {
  it("accepts projectId, runId, and resultId matching the full route param set", () => {
    expect(() => runIdresultIdParams.parse({ projectId: "3", runId: "7", resultId: "12" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = runIdresultIdParams.safeParse({ runId: "7", resultId: "12" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => runIdresultIdParams.parse({ projectId: "3", runId: "7", resultId: "12", extra: "x" })).toThrow();
  });
});
