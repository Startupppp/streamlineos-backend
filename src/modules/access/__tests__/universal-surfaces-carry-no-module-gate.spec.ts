import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";

const MODULES_ROOT = join(__dirname, "..", "..");
const UNIVERSAL_MODULE_DIRS = ["mail", "calendar", "chat"];

function controllerFilesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...controllerFilesUnder(full));
      continue;
    }
    if (entry.endsWith(".controller.ts")) found.push(full);
  }
  return found;
}

function universalControllerFiles(): string[] {
  return UNIVERSAL_MODULE_DIRS.flatMap((moduleDir) =>
    controllerFilesUnder(join(MODULES_ROOT, moduleDir)),
  );
}

describe("universal surfaces carry no module gate", () => {
  it("enumerates the mail, calendar and chat controllers from the filesystem, so a newly added one is covered automatically", () => {
    const files = universalControllerFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);

    for (const moduleDir of UNIVERSAL_MODULE_DIRS) {
      const owned = files.filter((file) =>
        file.includes(join(MODULES_ROOT, moduleDir)),
      );
      expect(owned.length).toBeGreaterThan(0);
    }
  });

  it("applies no @RequireModule to any handler on a platform-core surface", () => {
    const files = universalControllerFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);

    const gated = files.filter((file) =>
      readFileSync(file, "utf8").includes("@RequireModule"),
    );

    expect(gated.map((file) => file.slice(MODULES_ROOT.length))).toEqual([]);
  });

  it("imports no module-gate metadata key on a platform-core surface", () => {
    const files = universalControllerFiles();
    const importing = files.filter((file) =>
      readFileSync(file, "utf8").includes("require-module.decorator"),
    );

    expect(importing.map((file) => file.slice(MODULES_ROOT.length))).toEqual([]);
  });

  it("reads the metadata key from the decorator module rather than restating it", () => {
    expect(REQUIRE_MODULE).toBe("require_module");
  });

  it("positive control: the same scan does find @RequireModule on a plan-gated surface, so a clean universal result is not a scan that matches nothing", () => {
    const planGated = controllerFilesUnder(join(MODULES_ROOT, "payroll"));
    expect(planGated.length).toBeGreaterThan(0);

    const gated = planGated.filter((file) =>
      readFileSync(file, "utf8").includes("@RequireModule"),
    );
    expect(gated.length).toBeGreaterThan(0);
  });
});
