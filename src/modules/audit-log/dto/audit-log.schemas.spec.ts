import { listSchema } from "./audit-log.schemas";

describe("audit log list schema", () => {
  it("parses a bounded server-side action filter", () => {
    const result = listSchema.parse({
      actions: "role.changed, role.permissions.set",
    });
    expect(result.actions).toEqual(["role.changed", "role.permissions.set"]);
  });

  it("rejects more than twenty actions", () => {
    const actions = Array.from({ length: 21 }, (_, index) => `role.action-${index}`).join(
      ",",
    );
    expect(() => listSchema.parse({ actions })).toThrow();
  });
});
