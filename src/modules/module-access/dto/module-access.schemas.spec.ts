import { setModuleRolePermissionsSchema } from "./module-access.schemas";

describe("setModuleRolePermissionsSchema is strict all the way down", () => {
  const item = { permissionKey: "crm:leads:view", scope: "own" as const };

  it("accepts a declared item", () => {
    const parsed = setModuleRolePermissionsSchema.safeParse({ version: 1, items: [item] });
    expect(parsed.success).toBe(true);
  });

  it("refuses an unknown key on the body", () => {
    const parsed = setModuleRolePermissionsSchema.safeParse({
      version: 1,
      items: [item],
      orgId: "org-2",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses an unknown key inside items[]", () => {
    const parsed = setModuleRolePermissionsSchema.safeParse({
      version: 1,
      items: [{ ...item, scop: "all" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("does not silently strip a misspelt scope into the default", () => {
    const parsed = setModuleRolePermissionsSchema.safeParse({
      version: 1,
      items: [{ permissionKey: "crm:leads:view", scpe: "own" }],
    });
    expect(parsed.success).toBe(false);
  });
});
