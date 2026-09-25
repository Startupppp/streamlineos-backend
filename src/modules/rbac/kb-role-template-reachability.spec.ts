import { KB_PERMISSIONS } from "./permissions/kb";
import { ROLE_TEMPLATES } from "./role-templates.constants";

const AWAITING_A_RETENTION_RUNG = new Set<string>(["kb:pages:purge"]);

function keysGrantedByAnyTemplate(): Set<string> {
  const granted = new Set<string>();
  for (const template of ROLE_TEMPLATES)
    for (const key of template.permissions) granted.add(key);
  return granted;
}

describe("kb permission keys are reachable through a role template", () => {
  it("grants every catalogued kb key to at least one role template", () => {
    const granted = keysGrantedByAnyTemplate();
    const unreachable = KB_PERMISSIONS.map((permission) => permission.name)
      .filter((name) => !granted.has(name))
      .filter((name) => !AWAITING_A_RETENTION_RUNG.has(name));

    expect(unreachable).toEqual([]);
  });

  it("leaves permanent purge off the knowledge-manager role, so destruction needs its own rung", () => {
    const granted = keysGrantedByAnyTemplate();
    for (const key of AWAITING_A_RETENTION_RUNG)
      expect(granted.has(key)).toBe(false);
  });

  it("puts import and export where the other page-management keys live", () => {
    const owning = ROLE_TEMPLATES.filter((template) =>
      template.permissions.includes("kb:pages:manage"),
    );

    expect(owning.length).toBeGreaterThan(0);
    for (const template of owning) {
      expect(template.permissions).toContain("kb:pages:import");
      expect(template.permissions).toContain("kb:pages:export");
    }
  });

  it("does not grant a kb key that the catalogue never declared", () => {
    const catalogued = new Set(KB_PERMISSIONS.map((p) => p.name));
    const granted = [...keysGrantedByAnyTemplate()].filter((key) =>
      key.startsWith("kb:"),
    );

    expect(granted.filter((key) => !catalogued.has(key))).toEqual([]);
  });
});
