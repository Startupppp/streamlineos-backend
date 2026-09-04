import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isCoreModuleKey, moduleDefinition } from "../../common/rbac/module-registry";
import { moduleAvailability } from "../../common/rbac/module-availability";

/**
 * The KB module-gate contract, pinned from both ends so it cannot drift back silently.
 *
 * Thirteen KB controller e2e suites shipped a case asserting `402 MODULE_NOT_ENABLED`
 * for a token with `enabledModules: []`. Forty-two of those assertions were red and
 * always had been: `kb` is registered `planGated: false`, `isCoreModuleKey("kb")` is
 * therefore true, and `moduleAvailability` short-circuits to `{ available: true }`
 * before it reads an entitlement row. Every `@RequireModule("kb")` on a KB controller
 * was inert — a gate that reads as protection in review and can never fire.
 *
 * That is not a bug in the registry. It is the constitution's rule (CLAUDE.md §8):
 * knowledge is platform core, not a paid entitlement, and a member keeps KB reading
 * even when their only enabled product is Build or CRM. So the inert decorators were
 * removed rather than made to work, and the two halves of the resulting contract are
 * pinned here:
 *
 *   - the registry half — `kb` stays `planGated: false`, and availability stays `true`
 *     against a resolver doing everything it can to say otherwise;
 *   - the controller half — no KB controller carries `@RequireModule` again.
 *
 * The two are load-bearing together. Flipping `planGated` to `true` for `kb` without
 * restoring the decorators would leave KB ungated with nothing to say so; restoring a
 * decorator without flipping `planGated` puts back the inert gate. Either move fails
 * here first.
 */

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

  /**
   * The hostile resolver: kb is user-denied, org-disabled AND plan-locked. A core
   * module ignores all three, which is exactly why `@RequireModule("kb")` could never
   * throw. If this ever answers `available: false`, KB reads have become an
   * entitlement and every controller needs its gate back.
   */
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
