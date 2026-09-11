import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CONTROLLER_ROOT = resolve(__dirname, "..", "..", "modules");

const NO_DATABASE_ACCESS: Record<string, string> = {
  "billing/core/billing.controller.ts:getPlans":
    "Returns the static plan catalogue from `buildPlanCatalog()`; opens no connection.",
};

const METHOD_SIGNATURE = /^ {2}(?:(?:public|private|protected)\s+)?(?:async\s+)?([a-zA-Z_]\w*)\s*\(/;

function controllerFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".controller.ts")) continue;
      found.push(full);
    }
  };
  walk(CONTROLLER_ROOT);
  return found;
}

interface OrgLessHandler {
  id: string;
  optedOut: boolean;
}

function orgLessHandlers(file: string): OrgLessHandler[] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const relativePath = relative(CONTROLLER_ROOT, file).replaceAll("\\", "/");
  const handlers: OrgLessHandler[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*@AllowNoOrg\(\)/.test(lines[index] ?? "")) continue;

    let optedOut = false;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (/^\s*@NoTenantTransaction\(\)/.test(line)) optedOut = true;
      const signature = METHOD_SIGNATURE.exec(line);
      if (!signature) continue;
      handlers.push({ id: `${relativePath}:${signature[1]}`, optedOut });
      break;
    }
  }

  return handlers;
}

describe("every @AllowNoOrg() handler opts out of the ambient tenant transaction", () => {
  const handlers = controllerFiles().flatMap(orgLessHandlers);

  it("finds the handlers it is meant to be checking", () => {
    expect(handlers.length).toBeGreaterThan(5);
  });

  it("pairs @AllowNoOrg() with @NoTenantTransaction()", () => {
    const unguarded = handlers
      .filter((handler) => !handler.optedOut)
      .filter((handler) => !(handler.id in NO_DATABASE_ACCESS))
      .map((handler) => handler.id)
      .sort();

    expect(unguarded).toEqual([]);
  });

  it("keeps the wizard's own reads opted out", () => {
    const wizardReads = handlers.filter((handler) =>
      [
        "organization/setup/org.controller.ts:getSetupSession",
        "organization/setup/org.controller.ts:getSetupStatus",
      ].includes(handler.id),
    );

    expect(wizardReads).toHaveLength(2);
    expect(wizardReads.every((handler) => handler.optedOut)).toBe(true);
  });

  it("gives every exception a reason", () => {
    const unexplained = Object.entries(NO_DATABASE_ACCESS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([id]) => id);

    expect(unexplained).toEqual([]);
  });

  it("does not allowlist a handler that no longer exists", () => {
    const present = new Set(handlers.map((handler) => handler.id));
    const stale = Object.keys(NO_DATABASE_ACCESS).filter((id) => !present.has(id));

    expect(stale).toEqual([]);
  });
});
