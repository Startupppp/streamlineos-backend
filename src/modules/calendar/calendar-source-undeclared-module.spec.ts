import { CalendarSourceRegistry } from "./calendar-source.registry";
import type { CalendarEventSource, CalendarSourceContext } from "./calendar-event-source";
import { moduleAvailability, moduleAvailabilityResolver } from "../../common/rbac/module-availability";
import { isCoreModuleKey } from "../../common/rbac/module-registry";

/**
 * The availability answer here is the production one, not a stub that decides
 * from a list of module keys the test wrote. `isCoreModuleKey` is the real
 * function, the org map is empty and nothing is plan-locked — an organisation
 * that has enabled no module at all. Anything a stub decided instead would
 * prove nothing about the fail-open this file exists to hold shut.
 */
function registryForOrgWithNoEnabledModules(): CalendarSourceRegistry {
  const resolver = moduleAvailabilityResolver({
    isCoreModule: isCoreModuleKey,
    getModuleMap: async () => ({}),
    getPlanLockedModules: async () => [],
  });
  const access = {
    moduleAvailabilityFor: (orgId: string, userId: string, moduleKey: string) =>
      moduleAvailability(resolver, orgId, userId, moduleKey),
    isModuleEnabled: async (_orgId: string, moduleKey: string) => isCoreModuleKey(moduleKey),
  };
  return new CalendarSourceRegistry(access as never, {
    getDisabledKeys: async () => new Set<string>(),
  } as never);
}

function makeSource(key: string, module: string) {
  const load = jest.fn().mockResolvedValue([
    {
      id: `${key}-1`,
      title: key,
      start: new Date("2026-08-10T09:00:00.000Z"),
      end: new Date("2026-08-10T10:00:00.000Z"),
      allDay: false,
      category: key,
      meta: {},
    },
  ]);
  const source: CalendarEventSource = { key, label: key, module, load };
  return { source, load };
}

const ctx: CalendarSourceContext = {
  orgId: "org-with-nothing-enabled",
  userId: "user-1",
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-31T00:00:00.000Z"),
  scope: "all",
};

describe("a calendar source whose module the registry does not hold", () => {
  it("is not offered to an organisation with no enabled modules", async () => {
    const registry = registryForOrgWithNoEnabledModules();
    const ghost = makeSource("ghost-events", "ghost-module");
    const core = makeSource("calendar-events", "calendar");
    const gated = makeSource("hr-leaves", "hr");
    registry.register(ghost.source);
    registry.register(core.source);
    registry.register(gated.source);

    const toggles = await registry.getToggleList(ctx);

    expect(toggles.map((t) => `${t.key}:${t.module}`).sort()).toEqual([
      "calendar-events:calendar",
    ]);
  });

  it("is never asked to load, so its rows cannot reach the merged calendar", async () => {
    const registry = registryForOrgWithNoEnabledModules();
    const ghost = makeSource("ghost-events", "ghost-module");
    const core = makeSource("calendar-events", "calendar");
    registry.register(ghost.source);
    registry.register(core.source);

    const output = await registry.loadAll(ctx);

    expect(ghost.load).not.toHaveBeenCalled();
    expect(core.load).toHaveBeenCalledTimes(1);
    expect(output.events.map((event) => event.id)).toEqual(["calendar-events-1"]);
  });

  it("reads as not enabled on the org-level admin list rather than as core", async () => {
    const registry = registryForOrgWithNoEnabledModules();
    registry.register(makeSource("ghost-events", "ghost-module").source);
    registry.register(makeSource("calendar-events", "calendar").source);

    const sources = await registry.getOrgLevelSources(ctx.orgId);

    expect(
      sources.map((s) => `${s.key}:${s.moduleEnabled ? "enabled" : "not-enabled"}`).sort(),
    ).toEqual(["calendar-events:enabled", "ghost-events:not-enabled"]);
  });

  /**
   * The mutation check on the seam itself: the guard has teeth only if the same
   * source becomes visible the moment its module IS declared. Without this, a
   * guard that dropped every source would pass the three assertions above.
   */
  it("becomes visible again once its module is a declared core module", async () => {
    const registry = registryForOrgWithNoEnabledModules();
    registry.register(makeSource("ghost-events", "calendar").source);

    const toggles = await registry.getToggleList(ctx);

    expect(toggles.map((t) => t.key)).toEqual(["ghost-events"]);
  });
});
