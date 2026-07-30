import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  assertKnownPermissionKeys,
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  ROLE_RANK,
  toGrantableSet,
} from "./grantability";

const CATALOG = new Set([
  "crm:leads:view",
  "crm:leads:create",
  "hr:employees:view",
  "settings:manage",
  "settings:rbac:manage",
  "billing:analytics:view",
]);

const CRM_META = buildPermissionModuleMap(["crm:leads:view", "crm:leads:create"]);
const HR_META = buildPermissionModuleMap(["hr:employees:view"]);
const MIXED_META = buildPermissionModuleMap([
  "crm:leads:view",
  "crm:leads:create",
  "hr:employees:view",
  "settings:manage",
]);

describe("toGrantableSet", () => {
  it("includes keys with any scope other than none", () => {
    const resolved = new Map<string, string>([
      ["crm:leads:view", "all"],
      ["hr:employees:view", "own"],
      ["billing:analytics:view", "none"],
    ]);
    const set = toGrantableSet(resolved);
    expect(set.has("crm:leads:view")).toBe(true);
    expect(set.has("hr:employees:view")).toBe(true);
    expect(set.has("billing:analytics:view")).toBe(false);
  });

  it("returns an empty set for an empty map", () => {
    expect(toGrantableSet(new Map()).size).toBe(0);
  });
});

describe("buildPermissionModuleMap", () => {
  it("extracts the module prefix from colon-delimited keys", () => {
    const meta = buildPermissionModuleMap(["crm:leads:view", "hr:employees:view", "settings:manage"]);
    expect(meta.get("crm:leads:view")).toBe("crm");
    expect(meta.get("hr:employees:view")).toBe("hr");
    expect(meta.get("settings:manage")).toBe("settings");
  });

  it("maps a key without a colon to null", () => {
    const meta = buildPermissionModuleMap(["global"]);
    expect(meta.get("global")).toBeNull();
  });

  it("returns an empty map for an empty input", () => {
    expect(buildPermissionModuleMap([]).size).toBe(0);
  });
});

describe("assertKnownPermissionKeys", () => {
  it("passes when every key is in the catalog", () => {
    expect(() =>
      assertKnownPermissionKeys(["crm:leads:view", "hr:employees:view"], CATALOG),
    ).not.toThrow();
  });

  it("passes for an empty list", () => {
    expect(() => assertKnownPermissionKeys([], CATALOG)).not.toThrow();
  });

  it("throws BadRequestException naming the unknown key", () => {
    expect(() =>
      assertKnownPermissionKeys(["crm:leads:view", "made:up:key"], CATALOG),
    ).toThrow(BadRequestException);
  });
});

describe("assertPermissionsGrantable — existing rules", () => {
  const grantable = new Set(["crm:leads:view", "crm:leads:create"]);

  it("lets an org owner grant anything (bypass)", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: true, grantable: new Set() },
        ["settings:rbac:manage", "billing:analytics:view"],
      ),
    ).not.toThrow();
  });


  it("allows granting a subset of the caller's own permissions", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, grantable },
        ["crm:leads:view"],
      ),
    ).not.toThrow();
  });

  it("rejects granting a permission the caller does not hold", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, grantable },
        ["crm:leads:view", "hr:employees:view"],
      ),
    ).toThrow(ForbiddenException);
  });

  it("blocks a non-admin from propagating settings:rbac:manage even if they hold it", () => {
    const roleManager = new Set(["settings:rbac:manage", "crm:leads:view"]);
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, grantable: roleManager },
        ["settings:rbac:manage"],
      ),
    ).toThrow(ForbiddenException);
  });

  it("lets an org-admin (holds settings:manage) propagate reserved keys", () => {
    const orgAdmin = new Set(["settings:manage", "settings:rbac:manage"]);
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, grantable: orgAdmin },
        ["settings:rbac:manage"],
      ),
    ).not.toThrow();
  });

  it("passes for an empty requested list", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, grantable },
        [],
      ),
    ).not.toThrow();
  });
});

describe("assertPermissionsGrantable — rank enforcement (rule 2)", () => {
  const crmGrant = new Set(["crm:leads:view", "crm:leads:create"]);

  it("allows a Module Admin to grant to a role of strictly lower authority (rank 30)", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: crmGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["crm"]),
        },
        ["crm:leads:view"],
        { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey: "crm" },
        CRM_META,
      ),
    ).not.toThrow();
  });

  it("allows a Module Admin to grant to a functional role (rank 40)", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: crmGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["crm"]),
        },
        ["crm:leads:create"],
        { rank: ROLE_RANK.FUNCTIONAL, moduleKey: null },
        CRM_META,
      ),
    ).not.toThrow();
  });

  it("blocks a Module Admin from granting to an equal-rank role in a different module", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: crmGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["crm"]),
        },
        ["crm:leads:view"],
        { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "hr" },
        CRM_META,
      ),
    ).toThrow(ForbiddenException);
  });

  it("blocks a Module Admin from granting to a role at or above Org Admin rank", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: new Set(["settings:manage"]),
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: null,
        },
        ["settings:manage"],
        { rank: ROLE_RANK.ORG_ADMIN, moduleKey: null },
      ),
    ).toThrow(ForbiddenException);
  });

  it("blocks a functional-role holder from granting to an equal-rank role", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: crmGrant,
          bestRank: ROLE_RANK.FUNCTIONAL,
          allowedModules: null,
        },
        ["crm:leads:view"],
        { rank: ROLE_RANK.FUNCTIONAL, moduleKey: null },
        CRM_META,
      ),
    ).toThrow(ForbiddenException);
  });

  it("owner bypasses rank check entirely", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: true,
          grantable: new Set(),
          bestRank: ROLE_RANK.FUNCTIONAL,
          allowedModules: null,
        },
        ["settings:manage"],
        { rank: ROLE_RANK.ORG_ADMIN, moduleKey: null },
      ),
    ).not.toThrow();
  });

  it("skips rank check when bestRank is absent (backward compat)", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, grantable: crmGrant },
        ["crm:leads:view"],
        { rank: ROLE_RANK.ORG_ADMIN, moduleKey: null },
        CRM_META,
      ),
    ).not.toThrow();
  });
});

describe("assertPermissionsGrantable — peer Module Admin exception (rule 4)", () => {
  const hrGrant = new Set(["hr:employees:view"]);

  it("allows a Module Admin to configure a peer Module Admin in their own module", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: hrGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["hr"]),
        },
        ["hr:employees:view"],
        { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "hr" },
        HR_META,
      ),
    ).not.toThrow();
  });

  it("blocks a Module Admin from configuring a Module Admin role in a different module", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: hrGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["hr"]),
        },
        ["hr:employees:view"],
        { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "crm" },
        HR_META,
      ),
    ).toThrow(ForbiddenException);
  });

  it("blocks a Module Admin with null allowedModules from using the peer exception", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: hrGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: null,
        },
        ["hr:employees:view"],
        { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "hr" },
        HR_META,
      ),
    ).toThrow(ForbiddenException);
  });
});

describe("assertPermissionsGrantable — module-boundary enforcement (rule 3)", () => {
  const hrGrant = new Set(["hr:employees:view", "crm:leads:view"]);

  it("allows a Module Admin to grant permissions within their own module", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: hrGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["hr"]),
        },
        ["hr:employees:view"],
        { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey: "hr" },
        HR_META,
      ),
    ).not.toThrow();
  });

  it("blocks a Module Admin from granting permissions belonging to another module", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: hrGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["hr"]),
        },
        ["crm:leads:view"],
        { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey: "hr" },
        MIXED_META,
      ),
    ).toThrow(ForbiddenException);
  });

  it("blocks a Module Admin from mixing own-module and cross-module permissions", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: hrGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["hr"]),
        },
        ["hr:employees:view", "crm:leads:view"],
        { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey: "hr" },
        MIXED_META,
      ),
    ).toThrow(ForbiddenException);
  });

  it("skips module-boundary check when allowedModules is undefined (backward compat)", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, grantable: hrGrant },
        ["crm:leads:view", "hr:employees:view"],
        { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey: null },
        MIXED_META,
      ),
    ).not.toThrow();
  });

  it("skips module-boundary check when allowedModules is null (org-wide role)", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: hrGrant,
          bestRank: ROLE_RANK.ORG_ADMIN,
          allowedModules: null,
        },
        ["crm:leads:view", "hr:employees:view"],
        { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey: null },
        MIXED_META,
      ),
    ).not.toThrow();
  });

  it("a multi-module admin can grant for any of their modules", () => {
    expect(() =>
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: hrGrant,
          bestRank: ROLE_RANK.MODULE_ADMIN,
          allowedModules: new Set(["hr", "crm"]),
        },
        ["hr:employees:view", "crm:leads:view"],
        { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey: null },
        MIXED_META,
      ),
    ).not.toThrow();
  });
});
