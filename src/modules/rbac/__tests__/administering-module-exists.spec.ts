import { PERMISSIONS } from "../permissions";
import {
  administeringModuleOf,
  namespacesForModule,
} from "../../../common/rbac/module-vocabulary";
import {
  moduleDefinition,
  moduleIds,
} from "../../../common/rbac/module-registry";

/**
 * The catalog sync writes `administeringModuleOf(key)` straight into the
 * permission row's module column. When Home's ladder was retired, the map
 * routing chat, mail, calendar and notifications to it was left behind, so those
 * permissions were catalogued against a module that appeared in no list at all.
 *
 * Deriving the map from the registry makes that unrepresentable: a module can
 * only claim a namespace by having a registry entry to claim it from. These
 * assertions hold that property in place.
 */

/**
 * Namespaces that own permissions without being modules anyone enables,
 * delegates or is billed for. They administer themselves, so nothing redirects
 * to a ghost — but they are pinned here because a new one appearing is a
 * decision someone should make on purpose rather than discover later.
 */
const NON_MODULE_NAMESPACES = [
  "ai",
  "audit-log",
  "branch",
  "dashboard",
  "integrations",
  "onboarding",
  "ownership",
  // `party` is deliberately absent: CRM administers it (see module-registry).
  // A CRM administrator has to be able to manage the customers their deals
  // point at, so the party keys belong to the CRM ladder rather than to nobody.
  "payments",
  "reports",
  "sales",
  "self",
  "storage",
  // `tasks` left this list when it was registered: it owns a calendar source,
  // and a source whose module the registry does not hold reads as core-by-
  // default and shows on the calendar of an organisation that has enabled
  // nothing. Registering it as universal/not-plan-gated leaves availability
  // exactly where it was (`isCoreModuleKey("tasks")` was true either way) and
  // makes that a decision rather than an accident.
];

function namespaceOf(permissionKey: string): string {
  const separator = permissionKey.indexOf(":");
  return separator === -1 ? permissionKey : permissionKey.slice(0, separator);
}

describe("every permission is administered by a module that exists", () => {
  it("never redirects a namespace to a module the registry does not hold", () => {
    const ghosts = new Map<string, string[]>();

    for (const permission of PERMISSIONS) {
      const namespace = namespaceOf(permission.name);
      const administering = administeringModuleOf(permission.name);
      if (administering === namespace) continue;
      if (moduleDefinition(administering)) continue;
      const keys = ghosts.get(administering) ?? [];
      keys.push(permission.name);
      ghosts.set(administering, keys);
    }

    expect(Object.fromEntries(ghosts)).toEqual({});
  });

  it("routes the communication namespaces to Home, which is a real module", () => {
    for (const namespace of ["chat", "mail", "calendar", "notifications"])
      expect(administeringModuleOf(`${namespace}:anything:view`)).toBe("home");

    expect(moduleDefinition("home")).toBeDefined();
  });

  it("only lets a registered module claim another namespace", () => {
    for (const permission of PERMISSIONS) {
      const namespace = namespaceOf(permission.name);
      const administering = administeringModuleOf(permission.name);
      if (administering === namespace) continue;
      expect(moduleDefinition(administering)?.administersNamespaces).toContain(
        namespace,
      );
    }
  });

  it("holds the set of namespaces that are not modules, so a new one is a decision", () => {
    const unregistered = new Set<string>();
    for (const permission of PERMISSIONS) {
      const administering = administeringModuleOf(permission.name);
      if (!moduleDefinition(administering)) unregistered.add(administering);
    }

    expect([...unregistered].sort()).toEqual(NON_MODULE_NAMESPACES);
  });

  it("lets a module administer only namespaces it declares", () => {
    for (const id of moduleIds()) {
      const declared = new Set(namespacesForModule(id));
      expect(declared.has(id)).toBe(true);
      for (const namespace of declared) {
        if (namespace === id) continue;
        expect(administeringModuleOf(`${namespace}:anything:view`)).toBe(id);
      }
    }
  });

  it("leaves a module that administers nothing owning only its own namespace", () => {
    for (const id of moduleIds()) {
      if (moduleDefinition(id)?.administersNamespaces.length !== 0) continue;
      expect(namespacesForModule(id)).toEqual([id]);
    }
  });
});
