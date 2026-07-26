import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  assertKnownPermissionKeys,
  assertPermissionsGrantable,
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

describe("assertPermissionsGrantable", () => {
  const grantable = new Set(["crm:leads:view", "crm:leads:create"]);

  it("lets an org owner grant anything (bypass)", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: true, isPlatformAdmin: false, grantable: new Set() },
        ["settings:rbac:manage", "billing:analytics:view"],
      ),
    ).not.toThrow();
  });

  it("lets a platform admin grant anything (bypass)", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, isPlatformAdmin: true, grantable: new Set() },
        ["settings:manage"],
      ),
    ).not.toThrow();
  });

  it("allows granting a subset of the caller's own permissions", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, isPlatformAdmin: false, grantable },
        ["crm:leads:view"],
      ),
    ).not.toThrow();
  });

  it("rejects granting a permission the caller does not hold", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, isPlatformAdmin: false, grantable },
        ["crm:leads:view", "hr:employees:view"],
      ),
    ).toThrow(ForbiddenException);
  });

  it("blocks a non-admin from propagating settings:rbac:manage even if they hold it", () => {
    // A narrow 'role manager' holds rbac:manage (so they reached the endpoint) but not settings:manage.
    const roleManager = new Set(["settings:rbac:manage", "crm:leads:view"]);
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, isPlatformAdmin: false, grantable: roleManager },
        ["settings:rbac:manage"],
      ),
    ).toThrow(ForbiddenException);
  });

  it("lets an org-admin (holds settings:manage) propagate reserved keys", () => {
    const orgAdmin = new Set(["settings:manage", "settings:rbac:manage"]);
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, isPlatformAdmin: false, grantable: orgAdmin },
        ["settings:rbac:manage"],
      ),
    ).not.toThrow();
  });

  it("passes for an empty requested list", () => {
    expect(() =>
      assertPermissionsGrantable(
        { isOrgOwner: false, isPlatformAdmin: false, grantable },
        [],
      ),
    ).not.toThrow();
  });
});
