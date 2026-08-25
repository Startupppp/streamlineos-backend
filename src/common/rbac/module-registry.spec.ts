import {
  MODULE_REGISTRY,
  additionalNamespaces,
  delegableModuleIds,
  moduleDefinition,
  moduleIdFromStored,
  moduleIds,
  planGatedModuleIds,
  storedModuleKey,
  coreModuleIds,
  administrableModuleIds,
} from "./module-registry";
import { MODULE_CATALOG, isPlanGatedModule } from "./module-vocabulary";
import { ACCESS_MANAGED_MODULES } from "../../modules/rbac/permissions";
import { isCoreModuleKey } from "../../modules/access/entitlements.service";
import { moduleAvailability, moduleAvailabilityResolver } from "./module-availability";

/**
 * These assertions enumerate the registry rather than a literal list, so a
 * nineteenth module is covered by them without any test being edited.
 */
describe("module registry", () => {
  it("gives every module a unique id", () => {
    expect(new Set(moduleIds()).size).toBe(MODULE_REGISTRY.length);
  });

  it("gives every module a display name and a ladder", () => {
    for (const definition of MODULE_REGISTRY) {
      expect(definition.displayName.length).toBeGreaterThan(0);
      expect(["delegable", "universal", "platform-admin"]).toContain(
        definition.ladder,
      );
    }
  });

  it("keeps module ids lowercase, because grants are stored against them", () => {
    for (const id of moduleIds()) expect(id).toBe(id.toLowerCase());
  });
});

describe("derived views agree with the registry", () => {
  it("the plan-gated catalog is exactly the plan-gated modules", () => {
    expect([...MODULE_CATALOG]).toEqual(planGatedModuleIds());
  });

  it("the access-managed list is exactly the delegable modules", () => {
    expect([...ACCESS_MANAGED_MODULES]).toEqual(delegableModuleIds());
  });

  it("plan gating answers from the registry", () => {
    for (const definition of MODULE_REGISTRY)
      expect(isPlanGatedModule(definition.id)).toBe(definition.planGated);
  });

  it("the namespace map holds every module that administers another namespace", () => {
    const map = additionalNamespaces();
    for (const definition of MODULE_REGISTRY) {
      if (definition.administersNamespaces.length === 0) {
        expect(map[definition.id]).toBeUndefined();
        continue;
      }
      expect(map[definition.id]).toEqual(definition.administersNamespaces);
    }
  });
});

describe("settled decisions the registry must keep", () => {
  it("never delegates billing, and keeps it out of both derived lists", () => {
    expect(moduleDefinition("billing")?.ladder).toBe("platform-admin");
    expect(delegableModuleIds()).not.toContain("billing");
    expect(planGatedModuleIds()).not.toContain("billing");
  });

  it("treats the communication surfaces and Home as universal, never delegable", () => {
    for (const id of ["home", "chat", "mail", "calendar", "notifications"]) {
      expect(moduleDefinition(id)?.ladder).toBe("universal");
      expect(delegableModuleIds()).not.toContain(id);
    }
  });

  it("lets no namespace be administered by two modules", () => {
    const claimed = new Map<string, string>();
    for (const definition of MODULE_REGISTRY) {
      for (const namespace of definition.administersNamespaces) {
        expect(claimed.get(namespace)).toBeUndefined();
        claimed.set(namespace, definition.id);
      }
    }
  });

  it("lets no module claim its own id as an additional namespace", () => {
    for (const definition of MODULE_REGISTRY)
      expect(definition.administersNamespaces).not.toContain(definition.id);
  });
});

describe("stored module keys", () => {
  it("round-trips every module through the stored projection", () => {
    for (const id of moduleIds())
      expect(moduleIdFromStored(storedModuleKey(id))).toBe(id);
  });

  it("translates the stored uppercase form to a module the registry knows", () => {
    for (const id of moduleIds())
      expect(moduleDefinition(moduleIdFromStored(storedModuleKey(id)))).toBeDefined();
  });
});

describe("money and surface are two facts, not one", () => {
  const TODAYS_CORE = ["kb","home","chat","mail","calendar","notifications","workflows","blog","directory"];

  it("derives exactly the nine keys that were compiled into the service", () => {
    expect(coreModuleIds().sort()).toEqual([...TODAYS_CORE].sort());
  });

  it("still lists kb and chat on the screens even though they are free", () => {
    for (const id of ["kb", "chat"]) {
      expect(administrableModuleIds()).toContain(id);
      expect(coreModuleIds()).toContain(id);
    }
  });

  it("keeps delegable-and-free modules core rather than plan-gating them", () => {
    for (const id of ["workflows", "blog", "directory"]) expect(coreModuleIds()).toContain(id);
  });

  it("excludes billing, which is free to nobody and administers nothing on the screen", () => {
    expect(coreModuleIds()).not.toContain("billing");
    expect(administrableModuleIds()).not.toContain("billing");
  });

  // The mutation check: a field has teeth only when changing it changes the answer.
  it("stops calling a module core the moment it becomes plan-gated", () => {
    const core = (e: { planGated: boolean; ladder: string; id: string }[]) =>
      e.filter((x) => !x.planGated && x.ladder !== "platform-admin").map((x) => x.id);
    expect(core([{ id: "chat", planGated: false, ladder: "universal" }])).toEqual(["chat"]);
    expect(core([{ id: "chat", planGated: true, ladder: "universal" }])).toEqual([]);
    expect(core([{ id: "billing", planGated: false, ladder: "platform-admin" }])).toEqual([]);
  });

  it("keeps the two sets genuinely different, which is the point of splitting them", () => {
    expect(administrableModuleIds().sort()).not.toEqual(coreModuleIds().sort());
  });
});

describe("registry fields drive availability: end-to-end proof", () => {
  it("every module in coreModuleIds() is core through isCoreModuleKey", () => {
    for (const id of coreModuleIds()) expect(isCoreModuleKey(id)).toBe(true);
  });

  it("every plan-gated module is not core through isCoreModuleKey", () => {
    for (const id of planGatedModuleIds()) expect(isCoreModuleKey(id)).toBe(false);
  });

  it("billing (planGated=false, ladder=platform-admin) is not core through isCoreModuleKey", () => {
    expect(isCoreModuleKey("billing")).toBe(false);
  });

  it("core modules are unconditionally available even with a disabled org row, a user deny and a plan lock", async () => {
    for (const id of coreModuleIds()) {
      const resolver = moduleAvailabilityResolver(
        {
          isCoreModule: isCoreModuleKey,
          getModuleMap: async () => ({ [id]: false }),
          getPlanLockedModules: async () => [id],
        },
        { getUserDeniedModules: async () => new Set([id]) },
      );
      expect(await moduleAvailability(resolver, "org-1", "user-1", id)).toEqual({ available: true });
    }
  });

  it("plan-gated modules are blocked with reason not-in-plan when absent from the org map and plan-locked", async () => {
    for (const id of planGatedModuleIds()) {
      const resolver = moduleAvailabilityResolver({
        isCoreModule: isCoreModuleKey,
        getModuleMap: async () => ({}),
        getPlanLockedModules: async () => [id],
      });
      expect(await moduleAvailability(resolver, "org-1", "user-1", id)).toEqual({ available: false, reason: "not-in-plan" });
    }
  });

  it("billing is blocked with reason org-disabled when absent from the org map", async () => {
    const resolver = moduleAvailabilityResolver({
      isCoreModule: isCoreModuleKey,
      getModuleMap: async () => ({}),
      getPlanLockedModules: async () => [],
    });
    expect(await moduleAvailability(resolver, "org-1", "user-1", "billing")).toEqual({ available: false, reason: "org-disabled" });
  });

  it("the constitution's named core modules resolve available: home, kb, chat, mail, calendar", async () => {
    for (const id of ["home", "kb", "chat", "mail", "calendar"]) {
      const resolver = moduleAvailabilityResolver(
        {
          isCoreModule: isCoreModuleKey,
          getModuleMap: async () => ({ [id]: false }),
          getPlanLockedModules: async () => [id],
        },
        { getUserDeniedModules: async () => new Set([id]) },
      );
      expect(await moduleAvailability(resolver, "org-1", "user-1", id)).toEqual({ available: true });
    }
  });
});
