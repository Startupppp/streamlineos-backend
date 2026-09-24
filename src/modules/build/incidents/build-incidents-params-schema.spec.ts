import { incidentIdParams } from "./incidents.controller";

describe("incidentIdParams — build/:projectId/incidents prefix params", () => {
  it("accepts projectId from controller prefix and incidentId from method path", () => {
    expect(() => incidentIdParams.parse({ projectId: "3", incidentId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = incidentIdParams.safeParse({ incidentId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => incidentIdParams.parse({ projectId: "3", incidentId: "7", extra: "x" })).toThrow();
  });
});
