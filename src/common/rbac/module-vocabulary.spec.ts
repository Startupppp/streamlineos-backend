import {
  administeringModuleOf,
  impliedViewKey,
  moduleOwningNamespace,
  namespaceOf,
  namespacesForModule,
  permissionAreaLabel,
} from "./module-vocabulary";
import { MODULE_REGISTRY } from "./module-registry";

const HOME_ADMINISTERED = ["chat", "mail", "calendar", "notifications"] as const;

describe("the two permission-module questions stay distinct", () => {
  it.each(HOME_ADMINISTERED)("%s:* is administered by Home", (namespace) => {
    expect(administeringModuleOf(`${namespace}:anything:manage`)).toBe("home");
    expect(moduleOwningNamespace(namespace)).toBe("home");
  });

  it.each(HOME_ADMINISTERED)(
    "%s:* keeps its own runtime entitlement namespace",
    (namespace) => {
      expect(namespaceOf(`${namespace}:anything:manage`)).toBe(namespace);
      expect(namespaceOf(`${namespace}:anything:manage`)).not.toBe("home");
    },
  );

  it("administers party through CRM while its runtime namespace stays party", () => {
    expect(administeringModuleOf("party:contacts:view")).toBe("crm");
    expect(namespaceOf("party:contacts:view")).toBe("party");
    expect(administeringModuleOf("crm:deals:view")).toBe("crm");
    expect(namespaceOf("crm:deals:view")).toBe("crm");
  });

  it("agrees with the naive prefix only where no module claims the namespace", () => {
    const claimed = new Set(
      MODULE_REGISTRY.flatMap((definition) => [
        ...definition.administersNamespaces,
      ]),
    );
    expect(claimed.size).toBeGreaterThan(0);

    for (const namespace of claimed) {
      const key = `${namespace}:anything:view`;
      expect(administeringModuleOf(key)).not.toBe(namespace);
      expect(namespaceOf(key)).toBe(namespace);
    }

    for (const definition of MODULE_REGISTRY) {
      if (claimed.has(definition.id)) continue;
      const key = `${definition.id}:anything:view`;
      expect(administeringModuleOf(key)).toBe(namespaceOf(key));
    }
  });

  // Registry-driven, so a future administered namespace is covered without editing this test.
  it("cannot fall back to prefix grouping for a non-core administered namespace", () => {
    for (const definition of MODULE_REGISTRY) {
      for (const namespace of definition.administersNamespaces) {
        const key = `${namespace}:anything:view`;
        expect(administeringModuleOf(key)).toBe(definition.id);
        expect(namespacesForModule(definition.id)).toContain(namespace);
        expect(namespacesForModule(definition.id)[0]).toBe(definition.id);
      }
    }
  });

  it("returns the key itself when it carries no namespace segment", () => {
    expect(namespaceOf("global")).toBe("global");
    expect(administeringModuleOf("global")).toBe("global");
    expect(moduleOwningNamespace("nothing-claims-this")).toBe(
      "nothing-claims-this",
    );
  });
});

describe("impliedViewKey", () => {
  const catalog = new Set([
    "hr:employees:view",
    "surveys:view",
    "tasks:read",
    "hr:onboarding:tasks:view",
  ]);

  it("derives the sibling read key from the last segment at any arity", () => {
    expect(impliedViewKey(catalog, "hr:employees:update")).toBe(
      "hr:employees:view",
    );
    expect(impliedViewKey(catalog, "surveys:create")).toBe("surveys:view");
    expect(impliedViewKey(catalog, "hr:onboarding:tasks:complete")).toBe(
      "hr:onboarding:tasks:view",
    );
    expect(impliedViewKey(catalog, "tasks:write")).toBe("tasks:read");
  });

  it("returns null for a read key, an uncatalogued sibling and a bare segment", () => {
    expect(impliedViewKey(catalog, "hr:employees:view")).toBeNull();
    expect(impliedViewKey(catalog, "payroll:runs:post")).toBeNull();
    expect(impliedViewKey(catalog, "settings")).toBeNull();
  });
});

describe("permissionAreaLabel", () => {
  it("reads the leading segments verbatim and resolves no ownership", () => {
    expect(permissionAreaLabel("hr:employees:view")).toBe("hr employees");
    expect(permissionAreaLabel("chat:messages:read")).toBe("chat messages");
    expect(permissionAreaLabel("surveys:create")).toBe("surveys create");
    expect(permissionAreaLabel("settings")).toBe("settings");
  });
});
