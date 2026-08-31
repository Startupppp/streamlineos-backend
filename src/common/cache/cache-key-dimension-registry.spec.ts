import { CACHE_KEYS } from "./cache-keys";

interface DimensionEntry {
  name: string;
  dimensions: readonly string[];
  baseline: () => string;
  vary: Record<string, () => string>;
}

const DIMENSION_REGISTRY: readonly DimensionEntry[] = [
  {
    name: "accessPerms",
    dimensions: ["orgId", "userId", "version"],
    baseline: () => CACHE_KEYS.accessPerms("org-a", "user-1", 1),
    vary: {
      orgId: () => CACHE_KEYS.accessPerms("org-b", "user-1", 1),
      userId: () => CACHE_KEYS.accessPerms("org-a", "user-2", 1),
      version: () => CACHE_KEYS.accessPerms("org-a", "user-1", 2),
    },
  },
  {
    name: "accessVersion",
    dimensions: ["orgId"],
    baseline: () => CACHE_KEYS.accessVersion("org-a"),
    vary: {
      orgId: () => CACHE_KEYS.accessVersion("org-b"),
    },
  },
  {
    name: "accessMembersWithPermPage",
    dimensions: ["orgId", "permKey", "version", "afterMembershipId", "limit"],
    baseline: () => CACHE_KEYS.accessMembersWithPermPage("org-a", "hr:employees:view", 1, 0, 25),
    vary: {
      orgId: () => CACHE_KEYS.accessMembersWithPermPage("org-b", "hr:employees:view", 1, 0, 25),
      permKey: () => CACHE_KEYS.accessMembersWithPermPage("org-a", "crm:contacts:view", 1, 0, 25),
      version: () => CACHE_KEYS.accessMembersWithPermPage("org-a", "hr:employees:view", 2, 0, 25),
      afterMembershipId: () => CACHE_KEYS.accessMembersWithPermPage("org-a", "hr:employees:view", 1, 50, 25),
      limit: () => CACHE_KEYS.accessMembersWithPermPage("org-a", "hr:employees:view", 1, 0, 100),
    },
  },
  {
    name: "userSession",
    dimensions: ["userId"],
    baseline: () => CACHE_KEYS.userSession("user-1"),
    vary: {
      userId: () => CACHE_KEYS.userSession("user-2"),
    },
  },
  {
    name: "permissionsMatrix",
    dimensions: ["orgId", "version"],
    baseline: () => CACHE_KEYS.permissionsMatrix("org-a", 1),
    vary: {
      orgId: () => CACHE_KEYS.permissionsMatrix("org-b", 1),
      version: () => CACHE_KEYS.permissionsMatrix("org-a", 2),
    },
  },
  {
    name: "rolePerms",
    dimensions: ["orgId", "roleId", "version"],
    baseline: () => CACHE_KEYS.rolePerms("org-a", 10, 1),
    vary: {
      orgId: () => CACHE_KEYS.rolePerms("org-b", 10, 1),
      roleId: () => CACHE_KEYS.rolePerms("org-a", 20, 1),
      version: () => CACHE_KEYS.rolePerms("org-a", 10, 2),
    },
  },
  {
    name: "moduleRolesList",
    dimensions: ["orgId", "moduleKey", "version"],
    baseline: () => CACHE_KEYS.moduleRolesList("org-a", "hr", 1),
    vary: {
      orgId: () => CACHE_KEYS.moduleRolesList("org-b", "hr", 1),
      moduleKey: () => CACHE_KEYS.moduleRolesList("org-a", "crm", 1),
      version: () => CACHE_KEYS.moduleRolesList("org-a", "hr", 2),
    },
  },
  {
    name: "moduleGroupsList",
    dimensions: ["orgId", "moduleKey", "version"],
    baseline: () => CACHE_KEYS.moduleGroupsList("org-a", "hr", 1),
    vary: {
      orgId: () => CACHE_KEYS.moduleGroupsList("org-b", "hr", 1),
      moduleKey: () => CACHE_KEYS.moduleGroupsList("org-a", "crm", 1),
      version: () => CACHE_KEYS.moduleGroupsList("org-a", "hr", 2),
    },
  },
  {
    name: "moduleGroupMembers",
    dimensions: ["orgId", "moduleKey", "groupId", "version"],
    baseline: () => CACHE_KEYS.moduleGroupMembers("org-a", "hr", 5, 1),
    vary: {
      orgId: () => CACHE_KEYS.moduleGroupMembers("org-b", "hr", 5, 1),
      moduleKey: () => CACHE_KEYS.moduleGroupMembers("org-a", "crm", 5, 1),
      groupId: () => CACHE_KEYS.moduleGroupMembers("org-a", "hr", 9, 1),
      version: () => CACHE_KEYS.moduleGroupMembers("org-a", "hr", 5, 2),
    },
  },
  {
    name: "moduleAccessMembers",
    dimensions: ["orgId", "moduleKey", "version", "limit"],
    baseline: () => CACHE_KEYS.moduleAccessMembers("org-a", "hr", 25, 1),
    vary: {
      orgId: () => CACHE_KEYS.moduleAccessMembers("org-b", "hr", 25, 1),
      moduleKey: () => CACHE_KEYS.moduleAccessMembers("org-a", "crm", 25, 1),
      version: () => CACHE_KEYS.moduleAccessMembers("org-a", "hr", 25, 2),
      limit: () => CACHE_KEYS.moduleAccessMembers("org-a", "hr", 50, 1),
    },
  },
];

describe("CACHE_KEYS dimension registry — key isolation per factory", () => {
  it("registry covers at least 10 factories (field is not silently absent)", () => {
    expect(DIMENSION_REGISTRY.length).toBeGreaterThanOrEqual(10);
  });

  for (const entry of DIMENSION_REGISTRY) {
    describe(entry.name, () => {
      it("stable for identical inputs", () => {
        expect(entry.baseline()).toBe(entry.baseline());
      });

      it.each(entry.dimensions)("differs when %s varies", (dim) => {
        const variantFn = entry.vary[dim];
        if (!variantFn)
          throw new Error(`dimension registry for ${entry.name} has no variation for '${dim}'`);
        expect(variantFn()).not.toBe(entry.baseline());
      });

      it("vary map covers all declared dimensions (no undeclared variation)", () => {
        const declared = new Set(entry.dimensions);
        for (const dim of Object.keys(entry.vary)) {
          expect(declared.has(dim)).toBe(true);
        }
      });
    });
  }
});
