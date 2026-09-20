import { updateIdParams } from "./updates.controller";

describe("updateIdParams — build/:projectId/updates prefix params", () => {
  it("accepts projectId from controller prefix and updateId from method path", () => {
    expect(() => updateIdParams.parse({ projectId: "3", updateId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = updateIdParams.safeParse({ updateId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => updateIdParams.parse({ projectId: "3", updateId: "7", extra: "x" })).toThrow();
  });
});
