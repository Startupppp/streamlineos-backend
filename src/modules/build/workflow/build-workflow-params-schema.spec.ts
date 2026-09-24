import { fromStatusIdParams, statusIdParams, transitionIdParams } from "./workflow.controller";

describe("transitionIdParams — build/:projectId/workflow/transitions/:transitionId prefix params", () => {
  it("accepts projectId from controller prefix and transitionId from method path", () => {
    expect(() => transitionIdParams.parse({ projectId: "3", transitionId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = transitionIdParams.safeParse({ transitionId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => transitionIdParams.parse({ projectId: "3", transitionId: "7", extra: "x" })).toThrow();
  });
});

describe("fromStatusIdParams — build/:projectId/workflow/allowed/:fromStatusId prefix params", () => {
  it("accepts projectId from controller prefix and fromStatusId from method path", () => {
    expect(() => fromStatusIdParams.parse({ projectId: "3", fromStatusId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = fromStatusIdParams.safeParse({ fromStatusId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => fromStatusIdParams.parse({ projectId: "3", fromStatusId: "7", extra: "x" })).toThrow();
  });
});

describe("statusIdParams — build/:projectId/workflow/statuses/:statusId/wip prefix params", () => {
  it("accepts projectId from controller prefix and statusId from method path", () => {
    expect(() => statusIdParams.parse({ projectId: "3", statusId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = statusIdParams.safeParse({ statusId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => statusIdParams.parse({ projectId: "3", statusId: "7", extra: "x" })).toThrow();
  });
});
