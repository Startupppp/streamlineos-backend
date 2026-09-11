/**
 * A read-cost budget's seed floor runs before anything else, and it binds `[orgId]` alone
 * unless the budget declares `rowCountParams`. So a `$2` in `rowCountSql` without that
 * declaration is not a narrower count — it is a bind error, and the budget is removed from
 * the corpus before its ceiling, its plan assertions and the vacuity check are ever reached.
 *
 * Measured 2026-09-05 against the seeded scratch branch: `leave-requests-mine` and
 * `attendance-mine` both failed with "bind message supplies 1 parameters, but prepared
 * statement \"\" requires 2". Neither has ever produced a measurement, on any database,
 * including the production-shaped perf seed PRD-C142 is judged on. The gate reported them
 * among twenty breaches, which reads as two budgets over ceiling rather than two budgets
 * that never ran.
 *
 * This spec is hermetic on purpose. The defect is static — it is visible in the catalog
 * without connecting to anything — and `run-read-cost-budgets.mjs` only surfaces it on a
 * machine that has a seeded database, which is where it hid. `perf-seed-forward-window.db.spec.ts`
 * covers the executed half against a real seed.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BACKEND_ROOT = resolve(__dirname, "..", "..", "..");

interface CatalogEntry {
  id: string;
  highestPlaceholder: number;
  declaresRowCountParams: boolean;
}

/**
 * Both modules are native ESM and this suite runs under ts-jest's CommonJS transform, which
 * cannot require() one. Reading them out of a short-lived `node` process keeps the spec
 * pinned to the real catalog and the real validator rather than a restated copy.
 */
function readCatalog(): { entries: CatalogEntry[]; validatorErrors: string[] } {
  const budgetsUrl = pathToFileURL(
    resolve(BACKEND_ROOT, "src", "scripts", "read-cost-budgets.mjs"),
  ).href;
  const runnerUrl = pathToFileURL(
    resolve(BACKEND_ROOT, "src", "scripts", "run-read-cost-budgets.mjs"),
  ).href;
  const program = `
    import { BUDGETS } from ${JSON.stringify(budgetsUrl)};
    import { validateBudgets, rowCountPlaceholders } from ${JSON.stringify(runnerUrl)};
    const entries = BUDGETS.map((b) => ({
      id: b.id,
      highestPlaceholder: rowCountPlaceholders(b.rowCountSql),
      declaresRowCountParams: typeof b.rowCountParams === "function",
    }));
    process.stdout.write(JSON.stringify({ entries, validatorErrors: validateBudgets(BUDGETS) }));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as { entries: CatalogEntry[]; validatorErrors: string[] };
}

describe("read-cost budget bind arity", () => {
  const { entries, validatorErrors } = readCatalog();

  it("reads a non-empty catalog, so the assertions below are not vacuous", () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  it("binds every rowCountSql placeholder the catalog declares", () => {
    const unbound = entries
      .filter((e) => e.highestPlaceholder > 1 && !e.declaresRowCountParams)
      .map((e) => `${e.id}: rowCountSql uses $${String(e.highestPlaceholder)} with no rowCountParams`);

    expect(unbound).toEqual([]);
  });

  it("declares rowCountParams only where the count needs more than the org id", () => {
    // The inverse guard: a budget that declares the hook without needing it invites the
    // params/rowCountParams pair to drift apart silently.
    const redundant = entries
      .filter((e) => e.declaresRowCountParams && e.highestPlaceholder <= 1)
      .map((e) => e.id);

    expect(redundant).toEqual([]);
  });

  it("passes its own validator", () => {
    expect(validatorErrors).toEqual([]);
  });

  it("rejects an unbound placeholder rather than deferring it to bind time", () => {
    // Bite proof: the rule must fail a budget shaped like the two that were broken.
    const budgetsUrl = pathToFileURL(
      resolve(BACKEND_ROOT, "src", "scripts", "read-cost-budgets.mjs"),
    ).href;
    const runnerUrl = pathToFileURL(
      resolve(BACKEND_ROOT, "src", "scripts", "run-read-cost-budgets.mjs"),
    ).href;
    const program = `
      import { BUDGETS } from ${JSON.stringify(budgetsUrl)};
      import { validateBudgets } from ${JSON.stringify(runnerUrl)};
      const base = BUDGETS[0];
      const broken = {
        ...base,
        id: "bite-proof-unbound",
        rowCountSql: "SELECT count(*)::int FROM attendance WHERE org_id = $1 AND user_membership_id = $2",
        rowCountParams: undefined,
      };
      process.stdout.write(JSON.stringify(validateBudgets([broken])));
    `;
    const errors = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", program], {
        encoding: "utf8",
      }),
    ) as string[];

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bite-proof-unbound");
    expect(errors[0]).toContain("rowCountParams");
  });
});
