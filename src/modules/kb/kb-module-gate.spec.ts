import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isCoreModuleKey, moduleDefinition } from "../../common/rbac/module-registry";
import { moduleAvailability } from "../../common/rbac/module-availability";


const KB_ROOT = join(__dirname);

function kbControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...kbControllerFiles(full));
    else if (entry.name.endsWith(".controller.ts")) out.push(full);
  }
  return out.sort();
}

describe("KB module gate", () => {
  it("registers kb as a core, non-plan-gated module", () => {
    const definition = moduleDefinition("kb");
    expect(definition).toBeDefined();
    expect(definition?.planGated).toBe(false);
    expect(isCoreModuleKey("kb")).toBe(true);
  });

  it("answers available for kb even when every entitlement source denies it", async () => {
    const result = await moduleAvailability(
      {
        isCoreModule: isCoreModuleKey,
        getModuleMap: async () => ({ kb: false }),
        getUserDeniedModules: async () => new Set(["kb"]),
        getPlanLockedModules: async () => ["kb"],
      },
      "org-1",
      "user-1",
      "kb",
    );
    expect(result).toEqual({ available: true });
  });

  it("keeps the comparison honest — a plan-gated module is still refused", async () => {
    expect(isCoreModuleKey("inventory")).toBe(false);
    const result = await moduleAvailability(
      {
        isCoreModule: isCoreModuleKey,
        getModuleMap: async () => ({}),
        getUserDeniedModules: async () => new Set<string>(),
        getPlanLockedModules: async () => ["inventory"],
      },
      "org-1",
      "user-1",
      "inventory",
    );
    expect(result).toEqual({ available: false, reason: "not-in-plan" });
  });

  it("finds the KB controllers it is scanning", () => {
    expect(kbControllerFiles(KB_ROOT).length).toBeGreaterThanOrEqual(25);
  });

  it("carries no @RequireModule on any KB controller", () => {
    const offenders = kbControllerFiles(KB_ROOT).filter((file) =>
      /@RequireModule\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
