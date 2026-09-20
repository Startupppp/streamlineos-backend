import { decisionIdParams } from "./decisions.controller";
import { riskIdParams } from "./risks.controller";

describe("decisionIdParams — build/:projectId/decisions prefix params", () => {
  it("accepts projectId from controller prefix and decisionId from method path", () => {
    expect(() => decisionIdParams.parse({ projectId: "3", decisionId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = decisionIdParams.safeParse({ decisionId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => decisionIdParams.parse({ projectId: "3", decisionId: "7", extra: "x" })).toThrow();
  });
});

describe("riskIdParams — build/:projectId/risks prefix params", () => {
  it("accepts projectId from controller prefix and riskId from method path", () => {
    expect(() => riskIdParams.parse({ projectId: "3", riskId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = riskIdParams.safeParse({ riskId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => riskIdParams.parse({ projectId: "3", riskId: "7", extra: "x" })).toThrow();
  });
});
