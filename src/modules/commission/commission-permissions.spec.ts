import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import { scopeForGrant } from "../rbac/seed-system-roles";

/**
 * That this module reaches anybody at all.
 *
 * A commission surface can be complete, typechecked, tested and gated, and be
 * usable by nobody: the catalogue decides what a NEW organisation is seeded
 * with, a backfill migration decides what an EXISTING one gets, and either
 * missing is silent — `ON CONFLICT DO NOTHING` over an empty result set is a
 * clean migration. This repository has produced that outcome twice already
 * (see `backfill-slugs-exist.spec.ts` and `crm-permissions-reach-somebody.db.spec.ts`).
 *
 * `gated-keys-are-catalogued.spec.ts` covers the catalogue half repository-wide.
 * This file covers the half it cannot see: whether *this* module's keys are in
 * *this* module's migration, granted to slugs the seeder actually mints, and at
 * the same scope a freshly seeded organisation would receive.
 */
describe("the commission surface reaches somebody", () => {
  const root = join(__dirname, "../../..");
  const controller = readFileSync(
    join(root, "src/modules/commission/commission.controller.ts"),
    "utf8",
  );
  const migration = readFileSync(
    join(root, "migrations/0545_crm_commission_plans.sql"),
    "utf8",
  );

  /** Comments explain slugs and keys; only executable SQL grants them. */
  const executableSql = migration
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  const gatedKeys = [
    ...new Set(
      [...controller.matchAll(/@RequirePermission\(\s*"([^"]+)"/g)].map((m) => m[1]!),
    ),
  ].sort();

  it("gates every route on a key, and on the keys this ticket introduced", () => {
    expect(gatedKeys).toEqual([
      "crm:commission-earnings:approve",
      "crm:commission-earnings:calculate",
      "crm:commission-earnings:view",
      "crm:commission-plans:manage",
      "crm:commission-plans:view",
    ]);
  });

  it("catalogues every gated key, so a new organisation is seeded with it", () => {
    const catalogued = new Set(ALL_PERMISSION_NAMES);
    expect(gatedKeys.filter((key) => !catalogued.has(key))).toEqual([]);
  });

  it("inserts every gated key into the permissions table in the migration", () => {
    // Without the catalogue row the EXISTS guard on each grant is false and
    // every grant below is skipped in silence; `PermissionCatalogSync` runs at
    // boot, which is after migrations.
    const missing = gatedKeys.filter(
      (key) => !new RegExp(`'${key}',\\s*'`).test(executableSql),
    );
    expect(missing).toEqual([]);
  });

  it("grants every gated key to the CRM admin rungs the seeder actually mints", () => {
    const adminGrant = executableSql.slice(
      executableSql.indexOf("'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN'") - 2000,
      executableSql.indexOf("'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN'"),
    );
    const missing = gatedKeys.filter((key) => !adminGrant.includes(`('${key}')`));
    expect(missing).toEqual([]);
  });

  it("names no slug outside the shapes seedSystemRolesForOrg produces", () => {
    const seededShape = (slug: string): boolean =>
      /^[A-Z0-9]+_MODULE_(OWNER|ADMIN|MEMBER)$/.test(slug) ||
      ["OWNER", "ORG_ADMIN", "MEMBER"].includes(slug);

    const named = [
      ...new Set(
        [
          ...executableSql.matchAll(/"?slug"?\s*(?:=|IN)\s*(\([^)]*\)|'[A-Z0-9_]+')/gi),
        ].flatMap((match) => [...match[1]!.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!)),
      ),
    ];

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((slug) => !seededShape(slug))).toEqual([]);
  });

  /**
   * The invariant migration 0226 exists because it was broken: a backfilled
   * organisation and a newly seeded one must resolve to the same capability, or
   * a tenant's permissions depend on when they signed up.
   *
   * An earning is somebody's pay, so a plain CRM member gets it at `own`. If
   * `MODULE_MEMBER_KEY_SCOPE_OVERRIDE` ever loses that entry, new organisations
   * start seeding it at `all` while this migration keeps existing ones at `own`
   * — and the newer tenants are the ones leaking salaries.
   */
  it("gives module members the same scope the backfill does", () => {
    expect(scopeForGrant("CRM_MODULE_MEMBER", "crm:commission-earnings:view")).toBe("own");
    expect(executableSql).toMatch(
      /'crm:commission-earnings:view',\s*'own'[\s\S]*?'CRM_MODULE_MEMBER'/,
    );

    // A plan is a scheme document, not a payslip; members read it in full.
    expect(scopeForGrant("CRM_MODULE_MEMBER", "crm:commission-plans:view")).toBe("all");
    expect(executableSql).toMatch(
      /'crm:commission-plans:view',\s*'all'[\s\S]*?'CRM_MODULE_MEMBER'/,
    );
  });

  /**
   * `buildModuleMemberPermissionKeys` grants a module's keys ending `:view` or
   * `:read` to its members. Anything else in the namespace reaches admins only.
   * Stated here so that the member grants above are visibly the complete set
   * rather than a subset somebody trimmed by hand.
   */
  it("backfills members exactly the keys the seeder would give them", () => {
    const memberEligible = gatedKeys.filter((key) => key.endsWith(":view"));
    for (const key of memberEligible)
      expect(executableSql).toMatch(new RegExp(`'${key}',\\s*'(own|all)'`));

    for (const key of gatedKeys.filter((key) => !memberEligible.includes(key)))
      expect(
        new RegExp(`'${key}',\\s*'(own|all)'[\\s\\S]*?'CRM_MODULE_MEMBER'`).test(
          executableSql,
        ),
      ).toBe(false);
  });
});
