import { MODULE_REGISTRY } from "./module-registry";

const ALWAYS_ON_AT_RUNTIME = [
  "blog",
  "calendar",
  "chat",
  "directory",
  "home",
  "kb",
  "mail",
  "notifications",
  "workflows",
] as const;

const registryIds = new Set(MODULE_REGISTRY.map((m) => m.id));
const universal: string[] = MODULE_REGISTRY.filter((m) => m.ladder === "universal").map((m) => m.id);
const notPlanGated: string[] = MODULE_REGISTRY.filter((m) => !m.planGated).map((m) => m.id);

describe("what makes a module always available", () => {
  it("every always-on module has a registry entry", () => {
    for (const id of ALWAYS_ON_AT_RUNTIME) expect(registryIds.has(id)).toBe(true);
  });

  it("ladder does not decide plan gating, and is not a candidate source for it", () => {
    const missing = ALWAYS_ON_AT_RUNTIME.filter((id) => !universal.includes(id));
    expect(missing.sort()).toEqual(["blog", "directory", "workflows"]);
  });

  it("planGated does not decide always-on either, and disagrees in both directions", () => {
    const alwaysOnButPlanGated = ALWAYS_ON_AT_RUNTIME.filter(
      (id) => !notPlanGated.includes(id),
    );
    const alwaysOn: string[] = [...ALWAYS_ON_AT_RUNTIME];
    const notPlanGatedButNotAlwaysOn = notPlanGated.filter((id) => !alwaysOn.includes(id));

    expect(alwaysOnButPlanGated.sort()).toEqual(["chat", "kb"]);
    expect(notPlanGatedButNotAlwaysOn.sort()).toEqual(["billing"]);
  });

  it("keeps billing out of the always-on set", () => {
    expect([...ALWAYS_ON_AT_RUNTIME]).not.toContain("billing");
  });
});
