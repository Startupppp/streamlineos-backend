import { Test } from "@nestjs/testing";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import type { CalendarEventProjection, CalendarEventSource, CalendarSourceContext } from "./calendar-event-source";
import { EntitlementsService } from "../access/entitlements.service";
import { AccessService } from "../access/access.service";

const ALL_SOURCE_MODULES: string[] = ["hr", "build", "tasks", "alpha", "beta"];

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
): Promise<CalendarSourceRegistry> {
  const module = await Test.createTestingModule({
    providers: [
      CalendarSourceRegistry,
      {
        provide: EntitlementsService,
        useValue: {
          isCoreModule: () => false,
          getModuleMap: jest.fn().mockImplementation(() =>
            Promise.resolve(
              Object.fromEntries(ALL_SOURCE_MODULES.map((m) => [m, isEnabled(m)])),
            ),
          ),
          getPlanLockedModules: jest.fn().mockResolvedValue([]),
        },
      },
      {
        provide: AccessService,
        useValue: { getUserDeniedModules: jest.fn().mockResolvedValue(new Set<string>()) },
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
      expect(result.failures).toHaveLength(0);
    });

    it("does not call a source whose module is unavailable", async () => {
      const enabled = makeSource("a", "hr", [projection("a1")]);
      const disabled = makeSource("b", "build", [projection("b1")]);
      const registry = await buildRegistry([enabled.source, disabled.source], (m) => m === "hr");

      const result = await registry.loadAll(ctx);

      expect(enabled.load).toHaveBeenCalledTimes(1);
      expect(disabled.load).not.toHaveBeenCalled();
      expect(result.events).toHaveLength(1);
      expect(result.toggleList).toHaveLength(2);
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
  });
});
