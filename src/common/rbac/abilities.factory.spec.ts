import { defineAbilityFor } from "./abilities.factory";

describe("defineAbilityFor", () => {
  it("grants everything to platform admin / org owner", () => {
    const a = defineAbilityFor({ isPlatformAdmin: true });
    expect(a.can("manage", "all")).toBe(true);
    expect(a.can("delete", "crm:leads")).toBe(true);
  });

  it("maps domain:resource:action → can(action, domain:resource)", () => {
    const a = defineAbilityFor({ permissions: ["crm:leads:read"] });
    expect(a.can("read", "crm:leads")).toBe(true);
    expect(a.can("delete", "crm:leads")).toBe(false);
  });

  it("maps domain:action → can(action, domain)", () => {
    const a = defineAbilityFor({ permissions: ["sales:view"] });
    expect(a.can("view", "sales")).toBe(true);
  });

  it("filters out permissions whose module is not enabled", () => {
    const a = defineAbilityFor({
      permissions: ["crm:leads:read", "hr:employees:read"],
      enabledModules: ["crm"],
    });
    expect(a.can("read", "crm:leads")).toBe(true);
    expect(a.can("read", "hr:employees")).toBe(false);
  });

  it("allows all permissions when enabledModules is empty/absent", () => {
    const a = defineAbilityFor({ permissions: ["hr:employees:read"], enabledModules: [] });
    expect(a.can("read", "hr:employees")).toBe(true);
  });
});
