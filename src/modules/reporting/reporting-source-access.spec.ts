import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import { REPORTING_REGISTRY } from "./compiler/registry";
import {
  REPORTING_MANAGE,
  REPORTING_RUN,
  REPORTING_VIEW,
  REPORTING_SCOPE_GAP,
  decideSourceAccess,
  readableSources,
} from "./reporting-source-access";

/**
 * Reporting must not become a way to read what you were refused.
 *
 * The failure this file exists to prevent has no symptom. A generic query
 * surface guarded only by `crm:reporting:run` returns correct answers, scoped to
 * the right tenant, with no error anywhere — and hands a person who was denied
 * the deals screen the whole pipeline totalled by stage. Nothing in a log looks
 * wrong, because nothing is wrong except who asked.
 *
 * So the decision is a pure function over a set of held keys, and it is tested
 * here directly rather than through the service. A check that is only exercised
 * end to end is a check whose absence looks like a passing test suite.
 */
describe("who may run a report against a source", () => {
  const held = (...keys: string[]): ReadonlySet<string> => new Set(keys);

  it("names three keys the catalogue actually has", () => {
    /**
     * The controller spells these keys out as literals so
     * `gated-keys-are-catalogued.spec.ts` can scan them; this file holds the same
     * keys as constants for the logic above. Two spellings of one key is a typo
     * waiting to happen, and a typo here is silent — the constant would gate
     * nothing while the decorator gated the route, so `decideSourceAccess` would
     * refuse everybody and look like a permissions problem.
     *
     * Checking them against the catalogue catches both halves: a key that is
     * misspelt is not in `ALL_PERMISSION_NAMES`, and a key that is not in the
     * catalogue is never granted to an organisation created after it shipped.
     */
    for (const key of [REPORTING_VIEW, REPORTING_MANAGE, REPORTING_RUN])
      expect(ALL_PERMISSION_NAMES).toContain(key);
  });

  it("refuses a caller who cannot run reports at all", () => {
    const decision = decideSourceAccess("deals", held("crm:deals:read"));
    expect(decision.allowed).toBe(false);
    expect(decision.missing).toBe(REPORTING_RUN);
  });

  it("refuses a caller who may run reports but may not read the source", () => {
    /**
     * The central case. This caller holds the reporting key and is denied
     * anyway, because reporting adds a way to ask and not a right to know.
     */
    const decision = decideSourceAccess("deals", held(REPORTING_RUN));
    expect(decision.allowed).toBe(false);
    expect(decision.missing).toBe("crm:deals:read");
  });

  it("names the missing key, so the caller knows what to ask an administrator for", () => {
    expect(decideSourceAccess("parties", held(REPORTING_RUN)).missing).toBe(
      "party:parties:view",
    );
    expect(decideSourceAccess("activities", held(REPORTING_RUN)).missing).toBe(
      "crm:activities:view",
    );
  });

  it("allows a caller holding both keys", () => {
    expect(decideSourceAccess("deals", held(REPORTING_RUN, "crm:deals:read")).allowed).toBe(
      true,
    );
  });

  it("does not let one source's key unlock another's", () => {
    /**
     * A single `canReport` boolean would do exactly this. The keys are per
     * source because "may total the pipeline" and "may list every customer" are
     * different authorities that happen to share a query language.
     */
    const dealsOnly = held(REPORTING_RUN, "crm:deals:read");
    expect(decideSourceAccess("deals", dealsOnly).allowed).toBe(true);
    expect(decideSourceAccess("parties", dealsOnly).allowed).toBe(false);
    expect(decideSourceAccess("activities", dealsOnly).allowed).toBe(false);
  });

  it("refuses an unregistered source without inventing a key to blame", () => {
    /**
     * There is no permission that would grant this, so reporting a missing key
     * would send the caller to an administrator who cannot help. The service
     * turns this shape into a 400 rather than a 403.
     */
    const decision = decideSourceAccess("users", held(REPORTING_RUN));
    expect(decision.allowed).toBe(false);
    expect(decision.missing).toBeUndefined();
  });

  it("decides without compiling, so a caller who checks access checks something", () => {
    /**
     * An unregistered source would fail in the compiler too. This function must
     * not rely on that: a future caller that authorises without compiling —
     * a workflow step deciding whether to schedule a report, say — would
     * otherwise be authorising against nothing.
     */
    expect(decideSourceAccess("__proto__", held(REPORTING_RUN)).allowed).toBe(false);
    expect(decideSourceAccess("constructor", held(REPORTING_RUN)).allowed).toBe(false);
  });

  it("lists only the sources a caller could actually run", () => {
    /**
     * The sources endpoint is filtered rather than annotated. A response listing
     * every source with a `canRead: false` beside the denied ones discloses the
     * schema to exactly the people who were refused it.
     */
    expect(readableSources(held(REPORTING_RUN, "crm:deals:read"))).toEqual(["deals"]);
    expect(readableSources(held("crm:deals:read"))).toEqual([]);
    expect(
      readableSources(
        held(REPORTING_RUN, "crm:deals:read", "crm:activities:view", "party:parties:view"),
      ).sort(),
    ).toEqual([...REPORTING_REGISTRY.keys()].sort());
  });

  it("keeps the run key out of the reach of a scope-narrowed member role", () => {
    /**
     * The known gap, pinned so it cannot widen silently.
     *
     * `decideSourceAccess` honours the source's key and ignores its data scope,
     * so a caller holding `crm:deals:read` at `own` would report on the whole
     * organisation. What contains that today is which roles get the run key:
     * `buildModuleMemberPermissionKeys` filters to keys ending `:view` or
     * `:read`, and `crm:reporting:run` ends in neither — so no seeded member
     * role has it.
     *
     * If somebody renames the key to `crm:reporting:read` to be tidy, every CRM
     * member in every organisation silently gains org-wide reporting. This test
     * is what stops that being a rename.
     */
    expect(REPORTING_RUN.endsWith(":view")).toBe(false);
    expect(REPORTING_RUN.endsWith(":read")).toBe(false);
    expect(REPORTING_SCOPE_GAP).toContain("ignores its data scope");
  });

  it("is backfilled to the slugs the seeder actually mints", () => {
    /**
     * Read from the migration rather than asserted about it. Seven migrations in
     * this repo's history granted CRM permissions to `CRM_ADMIN` — a
     * `ROLE_TEMPLATES` slug nothing mints — and every one of them was a clean,
     * successful migration that granted to nobody. `ON CONFLICT DO NOTHING` over
     * zero rows leaves no trace.
     *
     * `backfill-slugs-exist.spec.ts` covers the general rule by scanning every
     * migration. This asserts the specific thing that matters for this ticket:
     * that these three keys are in there, against seeded slugs, with the member
     * split matching what `buildModuleMemberPermissionKeys` would produce.
     */
    const sql = readFileSync(
      join(__dirname, "../../../migrations/0556_backfill_crm_reporting_permissions.sql"),
      "utf8",
    );
    /**
     * Comments are stripped before anything is asserted. Half this file is prose
     * explaining the `CRM_ADMIN` mistake it avoids, and a check that read the
     * comments would find the wrong slug in the explanation and report the
     * migration as broken — which is exactly how the repo's own
     * `backfill-slugs-exist.spec.ts` learned to do the same thing.
     *
     * The split happens first: `--> statement-breakpoint` starts with `--`, so
     * stripping comments before splitting destroys the separator.
     */
    const strip = (text: string): string =>
      text
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");

    const statements = sql.split("--> statement-breakpoint").map(strip);
    const executable = statements.join("\n");

    expect(executable).toContain("'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN'");
    expect(executable).not.toContain("CRM_ADMIN'");
    for (const key of ["crm:reporting:view", "crm:reporting:manage", "crm:reporting:run"])
      expect(executable).toContain(`'${key}'`);

    /**
     * The member statement grants the view key and nothing else.
     *
     * Isolated by splitting on the statement separator rather than by slicing a
     * fixed window, so the assertion does not silently start reading a
     * neighbouring statement when the comments above it change length.
     */
    const memberStatement = statements.find((s) => s.includes("CRM_MODULE_MEMBER"));
    expect(memberStatement).toBeDefined();
    expect(memberStatement).toContain("'crm:reporting:view'");
    expect(memberStatement).not.toContain("'crm:reporting:run'");
    expect(memberStatement).not.toContain("'crm:reporting:manage'");

    /**
     * The cache version bump. Without it the grants are invisible until the
     * per-organisation permission cache expires, so every endpoint 403s for the
     * length of the TTL and the backfill looks like it failed.
     */
    expect(executable).toContain("access_versions");
  });
});
