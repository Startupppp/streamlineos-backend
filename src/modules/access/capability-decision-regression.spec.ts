import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * These production seams must use AccessService's deep capability interface.
 * Resource-level filtering remains in the caller; capability resolution does not.
 * Keep this list intentionally bounded to the modules migrated by c3/c4.
 */
const migratedProductionFiles = [
  "build/core/projects-scope.ts",
  "build/core/tickets/tickets-scope.ts",
  "build/execution/timesheets-scope.ts",
  "build/execution/timesheets.service.ts",
  "build/execution/whiteboards.service.ts",
  "build/execution/whiteboard-sharing.service.ts",
  "build/approvals/approvals.service.ts",
  "timesheets/core/timesheets-core-scope.ts",
  "kb/core/kb-scope.ts",
  "kb/wiki/kb-pages.controller.ts",
  "kb/wiki/kb-page-comments.controller.ts",
  "sales/sales.controller.ts",
] as const;

const rawCapabilityDecision =
  /resolveUserPermissions|\b(?:perms|permissions|resolved)\.(?:has|get)\(\s*["']/;

describe("c3/c4 capability decision seam", () => {
  it("does not regress migrated production callers to raw permission maps", () => {
    const modulesRoot = resolve(__dirname, "..");
    const violations = migratedProductionFiles.filter((relativePath) =>
      rawCapabilityDecision.test(
        readFileSync(resolve(modulesRoot, relativePath), "utf8"),
      ),
    );

    expect(violations).toEqual([]);
  });
});
