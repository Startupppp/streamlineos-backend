import { CalendarSourceRegistry } from "./calendar-source.registry";
import type { CalendarEventSource } from "./calendar-event-source";
import { moduleAvailabilityResolver } from "../../common/rbac/module-availability";

function makeSource(key: string, module: string): CalendarEventSource {
  return {
    key,
    label: key,
    module,
    load: jest.fn().mockResolvedValue([
      { id: `${key}-1`, title: key, start: new Date(), end: new Date(), allDay: false, category: key, meta: {} },
    ]),
  };
}

function makeRegistry(enabledModules: string[]) {
  const entitlements = {
    isCoreModule: () => false,
    getModuleMap: async () =>
      Object.fromEntries(enabledModules.map((key) => [key, true])),
    getPlanLockedModules: async () => [],
  };
  const access = {
    buildModuleAvailabilityResolver: (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) =>
      moduleAvailabilityResolver(
        {
          isCoreModule: entitlements.isCoreModule,
          getModuleMap,
          getPlanLockedModules: entitlements.getPlanLockedModules,
        },
        { getUserDeniedModules: async () => new Set<string>() },
      ),
  };
  return new CalendarSourceRegistry(
    entitlements as never,
    access as never,
    { getDisabledKeys: async () => new Set<string>() } as never,
  );
}

const ctx = {
  orgId: "org-1",
  userId: "user-1",
  start: new Date(),
  end: new Date(),
  scope: "all" as const,
};

describe("a module registers its own calendar source", () => {
  it("starts with no sources, so the calendar knows none of them up front", async () => {
    const registry = makeRegistry(["hr"]);
    const output = await registry.loadAll(ctx);
    expect(output.toggleList).toEqual([]);
    expect(output.events).toEqual([]);
  });

  it("asks a source once its owning module has registered it", async () => {
    const registry = makeRegistry(["hr"]);
    registry.register(makeSource("leaves", "hr"));

    const output = await registry.loadAll(ctx);

    expect(output.toggleList.map((t) => t.key)).toEqual(["leaves"]);
    expect(output.events).toHaveLength(1);
  });

  it("merges sources registered by different modules", async () => {
    const registry = makeRegistry(["hr", "build"]);
    registry.register(makeSource("leaves", "hr"));
    registry.register(makeSource("tickets", "build"));

    const output = await registry.loadAll(ctx);

    expect(output.toggleList.map((t) => t.key).sort()).toEqual(["leaves", "tickets"]);
    expect(output.events).toHaveLength(2);
  });

  it("does not ask a source whose module is unavailable", async () => {
    const registry = makeRegistry(["hr"]);
    const build = makeSource("tickets", "build");
    registry.register(build);

    await registry.loadAll(ctx);

    expect(build.load).not.toHaveBeenCalled();
  });

  it("registering the same source twice does not double its events", async () => {
    const registry = makeRegistry(["hr"]);
    const leaves = makeSource("leaves", "hr");
    registry.register(leaves);
    registry.register(leaves);

    const output = await registry.loadAll(ctx);

    expect(output.events).toHaveLength(1);
  });
});
