import { MODULE_REGISTRY } from "./module-registry";
import {
  moduleAvailability,
  type ModuleAvailabilityResolver,
} from "./module-availability";

interface ResolverOpts {
  coreModules: Set<string> | string[];
  denied: Set<string>;
  map: Record<string, boolean>;
  locked: string[];
}

function makeResolver(opts: ResolverOpts): ModuleAvailabilityResolver {
  const cores =
    opts.coreModules instanceof Set ? opts.coreModules : new Set(opts.coreModules);
  return {
    isCoreModule: (key) => cores.has(key),
    getModuleMap: async () => ({ ...opts.map }),
    getUserDeniedModules: async () => new Set(opts.denied),
    getPlanLockedModules: async () => [...opts.locked],
  };
}

describe("moduleAvailability — one reason per code path", () => {
  it("returns available when the module is core", async () => {
    const resolver = makeResolver({
      coreModules: ["home"],
      denied: new Set(["home"]),
      map: { home: false },
      locked: ["home"],
    });
    expect(await moduleAvailability(resolver, "org", "user", "home")).toEqual({
      available: true,
    });
  });

  it("returns user-denied when the user has an explicit deny on a non-core module", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(["hr"]),
      map: { hr: true },
      locked: [],
    });
    expect(await moduleAvailability(resolver, "org", "user", "hr")).toEqual({
      available: false,
      reason: "user-denied",
    });
  });

  it("returns available when the org has an enabled row and the user is not denied", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: { crm: true },
      locked: [],
    });
    expect(await moduleAvailability(resolver, "org", "user", "crm")).toEqual({
      available: true,
    });
  });

  it("returns org-disabled when the org has an explicit disabled row", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: { crm: false },
      locked: [],
    });
    expect(await moduleAvailability(resolver, "org", "user", "crm")).toEqual({
      available: false,
      reason: "org-disabled",
    });
  });

  it("returns not-in-plan when there is no org row and the current plan locks the module", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: {},
      locked: ["payroll"],
    });
    expect(await moduleAvailability(resolver, "org", "user", "payroll")).toEqual({
      available: false,
      reason: "not-in-plan",
    });
  });

  it("returns org-disabled when there is no org row and the plan does not lock the module", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: {},
      locked: [],
    });
    expect(await moduleAvailability(resolver, "org", "user", "build")).toEqual({
      available: false,
      reason: "org-disabled",
    });
  });
});

describe("moduleAvailability — downgrade policy: existing enablement survives", () => {
  it("returns available for a module with an enabled row even when the plan would now lock it", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: { payroll: true },
      locked: ["payroll"],
    });
    expect(await moduleAvailability(resolver, "org", "user", "payroll")).toEqual({
      available: true,
    });
  });

  it("still returns not-in-plan when there is no row, pinning that the check reads the absence of a row", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: {},
      locked: ["payroll"],
    });
    const result = await moduleAvailability(resolver, "org", "user", "payroll");
    expect(result).toEqual({ available: false, reason: "not-in-plan" });
  });
});

describe("moduleAvailability — mutation-checked: dropping a branch changes the outcome", () => {
  it("not-in-plan: returning [] from getPlanLockedModules would make this return org-disabled instead", async () => {
    const correctResolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: {},
      locked: ["inventory"],
    });
    const brokenResolver: ModuleAvailabilityResolver = {
      ...correctResolver,
      getPlanLockedModules: async () => [],
    };
    const correct = await moduleAvailability(correctResolver, "org", "user", "inventory");
    const broken = await moduleAvailability(brokenResolver, "org", "user", "inventory");
    expect(correct).toEqual({ available: false, reason: "not-in-plan" });
    expect(broken).toEqual({ available: false, reason: "org-disabled" });
  });

  it("user-denied: returning empty set from getUserDeniedModules would make this return available instead", async () => {
    const correctResolver = makeResolver({
      coreModules: [],
      denied: new Set(["crm"]),
      map: { crm: true },
      locked: [],
    });
    const brokenResolver: ModuleAvailabilityResolver = {
      ...correctResolver,
      getUserDeniedModules: async () => new Set(),
    };
    const correct = await moduleAvailability(correctResolver, "org", "user", "crm");
    const broken = await moduleAvailability(brokenResolver, "org", "user", "crm");
    expect(correct).toEqual({ available: false, reason: "user-denied" });
    expect(broken).toEqual({ available: true });
  });
});

describe("moduleAvailability — core modules are unconditionally available", () => {
  it("core exemption overrides a user deny", async () => {
    const resolver = makeResolver({
      coreModules: ["kb"],
      denied: new Set(["kb"]),
      map: {},
      locked: ["kb"],
    });
    expect(await moduleAvailability(resolver, "org", "user", "kb")).toEqual({
      available: true,
    });
  });

  it("core exemption overrides a disabled org row", async () => {
    const resolver = makeResolver({
      coreModules: ["chat"],
      denied: new Set(),
      map: { chat: false },
      locked: [],
    });
    expect(await moduleAvailability(resolver, "org", "user", "chat")).toEqual({
      available: true,
    });
  });
});

describe("moduleAvailability — property: every MODULE_REGISTRY entry is covered", () => {
  it("returns available for every module when it is declared core, no denies, org-enabled, not locked", async () => {
    for (const { id } of MODULE_REGISTRY) {
      const resolver = makeResolver({
        coreModules: [id],
        denied: new Set(),
        map: { [id]: true },
        locked: [],
      });
      const result = await moduleAvailability(resolver, "org", "user", id);
      expect(result).toEqual({ available: true });
    }
  });

  it("returns user-denied for every non-billing module when the user is explicitly denied and the module has an enabled row", async () => {
    for (const { id, ladder } of MODULE_REGISTRY) {
      if (ladder === "platform-admin") continue;
      const resolver = makeResolver({
        coreModules: [],
        denied: new Set([id]),
        map: { [id]: true },
        locked: [],
      });
      const result = await moduleAvailability(resolver, "org", "user", id);
      expect(result).toEqual({ available: false, reason: "user-denied" });
    }
  });

  it("returns not-in-plan for every plan-gated module when there is no row and it is locked", async () => {
    for (const { id, planGated } of MODULE_REGISTRY) {
      if (!planGated) continue;
      const resolver = makeResolver({
        coreModules: [],
        denied: new Set(),
        map: {},
        locked: [id],
      });
      const result = await moduleAvailability(resolver, "org", "user", id);
      expect(result).toEqual({ available: false, reason: "not-in-plan" });
    }
  });

  it("returns available for every plan-gated module that has an enabled row even when locked", async () => {
    for (const { id, planGated } of MODULE_REGISTRY) {
      if (!planGated) continue;
      const resolver = makeResolver({
        coreModules: [],
        denied: new Set(),
        map: { [id]: true },
        locked: [id],
      });
      const result = await moduleAvailability(resolver, "org", "user", id);
      expect(result).toEqual({ available: true });
    }
  });
});

describe("moduleAvailability — unknown module key never throws or leaks org info", () => {
  it("returns org-disabled for a key not present in any map or locked list", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: {},
      locked: [],
    });
    expect(await moduleAvailability(resolver, "org", "user", "unknown-module")).toEqual({
      available: false,
      reason: "org-disabled",
    });
  });
});

describe("moduleAvailability — canonicalizes resolver facts", () => {
  it("treats legacy uppercase and padded org rows as the same module", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: { " HR ": true },
      locked: [],
    });

    await expect(moduleAvailability(resolver, "org", "user", "hr")).resolves.toEqual({
      available: true,
    });
  });

  it("treats legacy uppercase and padded denies as user-denied", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set([" HR "]),
      map: { hr: true },
      locked: [],
    });

    await expect(moduleAvailability(resolver, "org", "user", "hr")).resolves.toEqual({
      available: false,
      reason: "user-denied",
    });
  });

  it("treats legacy uppercase and padded plan locks as not-in-plan", async () => {
    const resolver = makeResolver({
      coreModules: [],
      denied: new Set(),
      map: {},
      locked: [" HR "],
    });

    await expect(moduleAvailability(resolver, "org", "user", "hr")).resolves.toEqual({
      available: false,
      reason: "not-in-plan",
    });
  });
});
