import { PERMISSIONS } from "../rbac/permissions/catalog";
import { isScopable } from "../rbac/permissions";
import { PROJECTS_MANAGE_PERMISSION } from "./core";
import { TICKETS_PERMISSION } from "./core/tickets";
import {
  TIMESHEETS_MANAGE_PERMISSION,
  TIMESHEETS_VIEW_PERMISSION,
} from "./execution/timesheets-scope";

const scopableBuildKeys = PERMISSIONS.filter(
  (permission) => permission.name.startsWith("build:") && permission.scopable === true,
)
  .map((permission) => permission.name)
  .sort();

const keysABuildResolverNarrows = [
  PROJECTS_MANAGE_PERMISSION,
  TICKETS_PERMISSION,
  TIMESHEETS_MANAGE_PERMISSION,
  TIMESHEETS_VIEW_PERMISSION,
].sort();

describe("Build DataScope — a key an administrator can restrict must have a resolver that honours the restriction", () => {
  it("leaves no scopable Build key without a resolver, so adding one without narrowing turns this red", () => {
    const unresolved = scopableBuildKeys.filter(
      (key) => !keysABuildResolverNarrows.includes(key),
    );
    expect(unresolved).toEqual([]);
  });

  it("pins the scopable Build set, because an empty set would make the coverage assertion vacuous", () => {
    expect(scopableBuildKeys).toEqual(["build:manage", "build:timesheets:manage"]);
  });

  it("keeps every resolver constant pointed at a key the catalog still registers", () => {
    const registered = new Set(PERMISSIONS.map((permission) => permission.name));
    for (const key of keysABuildResolverNarrows) {
      expect(registered.has(key)).toBe(true);
    }
  });

  it("agrees with the runtime predicate the access layer uses to decide a key is restrictable", () => {
    for (const key of scopableBuildKeys) {
      expect(isScopable(key)).toBe(true);
    }
    expect(isScopable("build:qa:view")).toBe(false);
  });
});
