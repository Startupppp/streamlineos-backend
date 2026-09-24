import { formIdParams } from "./forms.controller";

describe("formIdParams — build/:projectId/forms prefix params", () => {
  it("accepts projectId from controller prefix and formId from method path", () => {
    expect(() => formIdParams.parse({ projectId: "3", formId: "7" })).not.toThrow();
  });

  it("rejects payload that ZodValidationInterceptor would see before the fix — projectId treated as unknown key by strict schema", () => {
    const pre = formIdParams.safeParse({ formId: "7" });
    expect(pre.success).toBe(false);
  });

  it("rejects extra keys beyond the declared prefix and method params", () => {
    expect(() => formIdParams.parse({ projectId: "3", formId: "7", extra: "x" })).toThrow();
  });
});
