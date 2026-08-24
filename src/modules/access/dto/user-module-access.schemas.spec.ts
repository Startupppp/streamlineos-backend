import { setUserModuleAccessSchema } from "./user-module-access.schemas";
import { MODULE_CATALOG } from "../../../common/rbac/module-vocabulary";

describe("setUserModuleAccessSchema", () => {
  it("accepts every plan-gated module the registry lists", () => {
    for (const moduleKey of MODULE_CATALOG) {
      expect(
        setUserModuleAccessSchema.safeParse({ moduleKey, enabled: true }).success,
      ).toBe(true);
    }
  });

  it("rejects a module key that is not plan-gated", () => {
    for (const moduleKey of ["billing", "home", "workflows", "blog", "directory"]) {
      expect(
        setUserModuleAccessSchema.safeParse({ moduleKey, enabled: true }).success,
      ).toBe(false);
    }
  });

  it("rejects an unknown string outright", () => {
    expect(
      setUserModuleAccessSchema.safeParse({ moduleKey: "nonsense", enabled: true })
        .success,
    ).toBe(false);
  });
});
