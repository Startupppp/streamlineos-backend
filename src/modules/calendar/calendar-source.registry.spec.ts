import { Test } from "@nestjs/testing";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import type { CalendarEventProjection, CalendarEventSource, CalendarSourceContext } from "./calendar-event-source";
import { AccessService } from "../access/access.service";
import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";

const ctx: CalendarSourceContext = {
  orgId: "org-1",
  userId: "user-1",
  start: new Date("2026-08-01"),
  end: new Date("2026-08-31"),
  scope: "all",
};

function projection(id: string): CalendarEventProjection {
  return { id, title: "T", start: new Date(), end: new Date(), allDay: false, category: "test", meta: {} };
}

function makeSource(key: string, moduleKey: string, events: CalendarEventProjection[]) {
  const load = jest.fn().mockResolvedValue(events);
  const source: CalendarEventSource = { key, label: key, module: moduleKey, load };
  return { source, load };
}

async function buildRegistry(
  sources: CalendarEventSource[],
  isEnabled: (moduleKey: string) => boolean,
  disabledKeys: Set<string> = new Set(),
  deniedModules: Set<string> = new Set(),
): Promise<CalendarSourceRegistry> {
  const module = await Test.createTestingModule({
    providers: [
      CalendarSourceRegistry,
      {
        provide: AccessService,
        useValue: {
          moduleAvailabilityFor: jest.fn(
            async (_orgId: string, _userId: string, moduleKey: string) =>
              deniedModules.has(moduleKey) || !isEnabled(moduleKey)
                ? { available: false, reason: "user-denied" }
                : { available: true },
          ),
        },
      },
      {
        provide: CalendarSourcePreferencesService,
        useValue: {
          getDisabledKeys: jest.fn().mockResolvedValue(disabledKeys),
        },
      },
    ],
  }).compile();
  const registry = module.get(CalendarSourceRegistry);
  for (const source of sources) registry.register(source);
  return registry;
}

describe("CalendarSourceRegistry", () => {
  describe("loadAll", () => {
    it("asks both sources, merges their events, and names both in the toggle list", async () => {
      const a = makeSource("a", "hr", [projection("a1")]);
      const b = makeSource("b", "build", [projection("b1")]);
      const registry = await buildRegistry([a.source, b.source], () => true);

      const result = await registry.loadAll(ctx);

      expect(a.load).toHaveBeenCalledWith(ctx);
      expect(b.load).toHaveBeenCalledWith(ctx);
      expect(result.events).toHaveLength(2);
      expect(result.toggleList.map((t) => t.key)).toEqual(["a", "b"]);
      expect(result.toggleList.every((t) => t.enabled)).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("does not call a source whose module is unavailable, and excludes it from the toggle list", async () => {
      const enabled = makeSource("a", "hr", [projection("a1")]);
      const disabled = makeSource("b", "build", [projection("b1")]);
      const registry = await buildRegistry([enabled.source, disabled.source], (m) => m === "hr");

      const result = await registry.loadAll(ctx);

      expect(enabled.load).toHaveBeenCalledTimes(1);
      expect(disabled.load).not.toHaveBeenCalled();
      expect(result.events).toHaveLength(1);
      expect(result.toggleList).toHaveLength(1);
      expect(result.toggleList[0]?.key).toBe("a");
    });

    it("isolates a failing source and reports it without aborting the other", async () => {
      const good = makeSource("good", "hr", [projection("g1")]);
      const bad: CalendarEventSource = {
        key: "bad",
        label: "bad",
        module: "build",
        load: jest.fn().mockRejectedValue(new Error("source error")),
      };
      const registry = await buildRegistry([good.source, bad], () => true);

      const result = await registry.loadAll(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.key).toBe("bad");
    });

    it("never calls load on a source the person has disabled", async () => {
      const a = makeSource("a", "hr", [projection("a1")]);
      const b = makeSource("b", "build", [projection("b1")]);
      const registry = await buildRegistry(
        [a.source, b.source],
        () => true,
        new Set(["b"]),
      );

      const result = await registry.loadAll(ctx);

      expect(a.load).toHaveBeenCalledWith(ctx);
      expect(b.load).not.toHaveBeenCalled();
      expect(result.events).toHaveLength(1);
    });

    it("includes a disabled-but-available source in the toggle list with enabled=false", async () => {
      const a = makeSource("a", "hr", [projection("a1")]);
      const b = makeSource("b", "build", [projection("b1")]);
      const registry = await buildRegistry(
        [a.source, b.source],
        () => true,
        new Set(["b"]),
      );

      const result = await registry.loadAll(ctx);

      expect(result.toggleList).toHaveLength(2);
      const aEntry = result.toggleList.find((t) => t.key === "a");
      const bEntry = result.toggleList.find((t) => t.key === "b");
      expect(aEntry?.enabled).toBe(true);
      expect(bEntry?.enabled).toBe(false);
    });

    it("absence of a stored preference means the source is enabled", async () => {
      const a = makeSource("a", "hr", [projection("a1")]);
      const registry = await buildRegistry([a.source], () => true, new Set());

      const result = await registry.loadAll(ctx);

      expect(a.load).toHaveBeenCalledWith(ctx);
      expect(result.toggleList[0]?.enabled).toBe(true);
    });

    it("a stored preference for an unknown source key does not affect available sources", async () => {
      const a = makeSource("a", "hr", [projection("a1")]);
      const registry = await buildRegistry(
        [a.source],
        () => true,
        new Set(["stale-removed-source"]),
      );

      const result = await registry.loadAll(ctx);

      expect(a.load).toHaveBeenCalledWith(ctx);
      expect(result.events).toHaveLength(1);
      expect(result.toggleList).toHaveLength(1);
      expect(result.toggleList[0]?.enabled).toBe(true);
    });

    it("a person denied a module gets neither its events nor its toggle entry", async () => {
      const a = makeSource("a", "hr", [projection("a1")]);
      const b = makeSource("b", "build", [projection("b1")]);
      const registry = await buildRegistry([a.source, b.source], () => true, new Set(), new Set(["build"]));

      const result = await registry.loadAll(ctx);

      expect(b.load).not.toHaveBeenCalled();
      expect(result.toggleList.map((t) => t.key)).not.toContain("b");
    });
  });

  describe("getToggleList", () => {
    it("returns only available sources with their preference state", async () => {
      const a = makeSource("a", "hr", []);
      const b = makeSource("b", "build", []);
      const registry = await buildRegistry(
        [a.source, b.source],
        (m) => m === "hr",
        new Set(),
      );

      const toggleList = await registry.getToggleList(ctx);

      expect(toggleList).toHaveLength(1);
      expect(toggleList[0]?.key).toBe("a");
      expect(toggleList[0]?.enabled).toBe(true);
    });

    it("marks a disabled source with enabled=false in the toggle list", async () => {
      const a = makeSource("a", "hr", []);
      const b = makeSource("b", "build", []);
      const registry = await buildRegistry(
        [a.source, b.source],
        () => true,
        new Set(["a"]),
      );

      const toggleList = await registry.getToggleList(ctx);

      const aEntry = toggleList.find((t) => t.key === "a");
      const bEntry = toggleList.find((t) => t.key === "b");
      expect(aEntry?.enabled).toBe(false);
      expect(bEntry?.enabled).toBe(true);
    });
  });
});
