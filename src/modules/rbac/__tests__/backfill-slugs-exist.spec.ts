import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMINISTRABLE_MODULES } from "../../../common/rbac/module-vocabulary";
import { ROLE_TEMPLATES } from "../role-templates.constants";

/**
 * A permission backfill that names a role nobody has is a successful migration
 * that does nothing.
 *
 * Seven migrations in the CRM series granted `WHERE slug = 'CRM_ADMIN'`, copied
 * from `ROLE_TEMPLATES` — which is a template an administrator may manually
 * create a role from, not what an organisation is seeded with.
 * `seedSystemRolesForOrg` mints `${MODULE}_MODULE_OWNER|ADMIN|MEMBER`, so all
 * seven matched zero rows. Sixteen permissions ended up granted to nobody,
 * leaving the party module, the ingress endpoint and the review feed unreachable
 * by everyone — and nothing failed, because `ON CONFLICT DO NOTHING` over an
 * empty result set is a clean migration.
 *
 * The check is deliberately narrow. Whether a slug existed *at the time* a given
 * migration ran cannot be decided statically — `0450` granted to
 * `HOME_MODULE_MEMBER` before `0452` retired that ladder, and both were correct.
 * What can be decided is whether a slug is one the seeder has NEVER been able to
 * produce, which is exactly the mistake made here.
 */
describe("permission backfills name a role that can exist", () => {
  const migrationsDir = join(__dirname, "../../../../migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  /**
   * Comments explain these slugs; only executable SQL grants to them. Without
   * stripping, a migration that documents the bug it repairs reports itself.
   */
  const executableSql = (file: string): string =>
    readFileSync(join(migrationsDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");

  /** Slugs the seeder mints for any module, past or present, plus the org rungs. */
  const seededShape = (slug: string): boolean =>
    /^[A-Z0-9]+_MODULE_(OWNER|ADMIN|MEMBER)$/.test(slug) ||
    ["OWNER", "ORG_ADMIN", "MEMBER"].includes(slug);

  it("finds migration files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no grant targets a slug the seeder never produces", () => {
    /** Template slugs that are not also a seeded shape — creatable only by hand. */
    const templateOnly = new Set(
      ROLE_TEMPLATES.map((t) => t.slug).filter((slug) => !seededShape(slug)),
    );

    const offenders: string[] = [];
    for (const file of files) {
      const sql = executableSql(file);
      if (!/INSERT INTO "?role_permission_grants"?/i.test(sql)) continue;
      for (const slug of templateOnly)
        if (new RegExp(`'${slug}'`).test(sql)) offenders.push(`${file}: ${slug}`);
    }

    /**
     * Already applied, so they cannot be edited — the fix is a repair migration.
     * This list must not grow: a new entry means somebody wrote another backfill
     * that reaches nobody.
     *
     * The CRM seven are repaired by `0226`. The HR one is NOT repaired — it is
     * outside the CRM branch's scope and is recorded here so it stays visible.
     * `hr:recruitment*` is currently granted to nobody in any organisation, in
     * exactly the way the party keys were.
     */
    const KNOWN_INERT_BACKFILLS = [
      "0207_backfill_crm_party_permissions.sql: CRM_ADMIN",
      "0210_backfill_party_role_permissions.sql: CRM_ADMIN",
      "0212_backfill_subject_permissions.sql: CRM_ADMIN",
      "0216_backfill_activity_permissions.sql: CRM_ADMIN",
      "0218_backfill_ingress_permission.sql: CRM_ADMIN",
      "0221_repair_party_permission_backfill.sql: CRM_ADMIN",
      "0225_backfill_autonomy_review_permissions.sql: CRM_ADMIN",
      "0398_backfill_hr_admin_branch_hr_recruitment_grants.sql: BRANCH_HR",
      "0398_backfill_hr_admin_branch_hr_recruitment_grants.sql: HR_ADMIN",
    ];

    expect(offenders.sort()).toEqual(KNOWN_INERT_BACKFILLS.sort());
  });

  it("the repair itself targets slugs the seeder does produce", () => {
    const repair = executableSql("0226_repair_crm_module_role_grants.sql");
    const granted = [...repair.matchAll(/'(CRM_[A-Z_]+)'/g)].map((m) => m[1]!);

    expect(granted.length).toBeGreaterThan(0);
    for (const slug of new Set(granted)) expect(seededShape(slug)).toBe(true);
  });

  it("CRM is still an administrable module, so those slugs are minted", () => {
    // If CRM ever leaves this list the repair above goes inert too, silently.
    expect(ADMINISTRABLE_MODULES).toContain("crm");
  });
});
