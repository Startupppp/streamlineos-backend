import {
  DASHBOARD_HOME_SECTIONS,
  isModuleSection,
  isPermissionSection,
  permissionOf,
  type ModuleSection,
  type PermissionSection,
} from "./dashboard-section-registry";

describe("DASHBOARD_HOME_SECTIONS — authoritative section registry (ITEMS A+B)", () => {
  it("registry is non-empty", () => {
    expect(DASHBOARD_HOME_SECTIONS.length).toBeGreaterThan(0);
  });

  it("FAIL-CLOSED: every section has a recognised kind — adding a section without a valid kind makes this test red", () => {
    const VALID = new Set(["universal", "module", "permission"]);
    for (const section of DASHBOARD_HOME_SECTIONS) {
      if (!VALID.has(section.kind)) {
        throw new Error(
          `Section '${section.key}' is unclassified (kind='${section.kind}'). ` +
            `Classify it as universal, module, or permission in dashboard-section-registry.ts.`,
        );
      }
    }
  });

  it("every section has a non-empty key and cacheNs", () => {
    for (const section of DASHBOARD_HOME_SECTIONS) {
      expect(section.key.length).toBeGreaterThan(0);
      expect(section.cacheNs.length).toBeGreaterThan(0);
    }
  });

  it("section keys are unique", () => {
    const keys = DASHBOARD_HOME_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every module section declares a non-empty module string", () => {
    const modules = DASHBOARD_HOME_SECTIONS.filter(isModuleSection) as ModuleSection[];
    expect(modules.length).toBeGreaterThan(0);
    for (const s of modules) {
      expect(typeof s.module).toBe("string");
      expect(s.module.length).toBeGreaterThan(0);
    }
  });

  it("every permission section declares a permission string and cacheScope", () => {
    const perms = DASHBOARD_HOME_SECTIONS.filter(isPermissionSection) as PermissionSection[];
    expect(perms.length).toBeGreaterThan(0);
    for (const s of perms) {
      expect(typeof s.permission).toBe("string");
      expect(s.permission.length).toBeGreaterThan(0);
      expect(["org", "scoped"]).toContain(s.cacheScope);
    }
  });

  it("permission keys follow the module:resource:action naming convention", () => {
    const perms = DASHBOARD_HOME_SECTIONS.filter(isPermissionSection) as PermissionSection[];
    for (const s of perms) {
      expect(s.permission).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]+/);
    }
  });

  it("universal sections carry no module or permission field", () => {
    const universals = DASHBOARD_HOME_SECTIONS.filter((s) => s.kind === "universal");
    for (const s of universals) {
      expect(Object.prototype.hasOwnProperty.call(s, "permission")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(s, "module")).toBe(false);
    }
  });

  it("ITEM B — known universal sections (per §8 CLAUDE.md) are classified as universal", () => {
    const universalKeys = new Set(
      DASHBOARD_HOME_SECTIONS.filter((s) => s.kind === "universal").map((s) => s.key),
    );
    expect(universalKeys.has("announcements")).toBe(true);
    expect(universalKeys.has("upcoming-events")).toBe(true);
    expect(universalKeys.has("unread-notifications")).toBe(true);
    expect(universalKeys.has("birthdays")).toBe(true);
  });

  it("ITEM B — HR admin sections are NOT classified as universal", () => {
    const nonUniversalKeys = new Set(
      DASHBOARD_HOME_SECTIONS.filter((s) => s.kind !== "universal").map((s) => s.key),
    );
    expect(nonUniversalKeys.has("stats-employees")).toBe(true);
    expect(nonUniversalKeys.has("pending-approvals")).toBe(true);
    expect(nonUniversalKeys.has("crm-executive")).toBe(true);
  });
});

describe("permissionOf helper", () => {
  it("returns the permission key for a permission section", () => {
    expect(permissionOf("stats-employees")).toBe("hr:employees:view");
    expect(permissionOf("stats-projects")).toBe("build:tickets:view");
    expect(permissionOf("recent-projects")).toBe("build:manage");
    expect(permissionOf("leaves-today")).toBe("hr:leaves:approve");
  });

  it("throws for an unknown section key", () => {
    expect(() => permissionOf("nonexistent-section")).toThrow();
  });

  it("throws for a universal section key (not a permission section)", () => {
    expect(() => permissionOf("announcements")).toThrow();
  });

  it("throws for a module section key (not a permission section)", () => {
    expect(() => permissionOf("my-tasks")).toThrow();
  });
});
