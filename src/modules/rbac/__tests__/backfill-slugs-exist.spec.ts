import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMINISTRABLE_MODULES } from "../../../common/rbac/module-vocabulary";
import { ROLE_TEMPLATES } from "../role-templates.constants";
import { PERMISSIONS } from "../permissions";
import { buildDesiredGrants } from "../role-grant-reconciler.service";

/**
 * A permission backfill that names a role nobody has is a successful migration
 * that does nothing.
 *
 * Seven migrations in the CRM series granted `WHERE slug = 'CRM_ADMIN'`, copied
 * from `ROLE_TEMPLATES` — which is a template an administrator may manually
 * create a role from, not what an organisation is seeded with.
 * `seedSystemRolesForOrg` mints `${MODULE}_MODULE_OWNER|ADMIN|MEMBER`, so all
 * seven matched zero rows. Eighteen permissions ended up granted to nobody,
 * leaving the party module, the ingress endpoint, the activity timeline and the
 * review feed unreachable by everyone — and nothing failed, because
 * `ON CONFLICT DO NOTHING` over an empty result set is a clean migration.
 *
 * The slug check is deliberately narrow. Whether a slug existed *at the time* a
 * given migration ran cannot be decided statically — `0450` granted to
 * `HOME_MODULE_MEMBER` before `0452` retired that ladder, and both were correct.
 * What can be decided is whether a slug is one the seeder has NEVER been able to
 * produce, which is exactly the mistake made here.
 *
 * Two things this file could not catch when it was first written, both now
 * covered below, and both learned the hard way:
 *
 * It matched against a list of known-bad slugs, so it could only recognise a
 * mistake somebody had already made. A grant to `CRM_MODULE_ADMINS` or
 * `CRM_OWNER` — neither a template nor a seeded shape — would have reproduced
 * the identical bug and left the suite green. The check is now the inverse:
 * every slug named in a grant must satisfy `seededShape`.
 *
 * And it asserted repair *coverage* in a comment rather than in code. The claim
 * "the CRM seven are repaired by 0226" was false — `0216`'s two activity keys
 * were missing from 0226's list, so the unified timeline returned 403 for every
 * user in every pre-existing organisation while this test passed. A comment is
 * not a test; the last case here is.
 */
describe("permission backfills name a role that can exist", () => {
  const migrationsDir = join(__dirname, "../../../../migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  /**
   * Comments explain these slugs; only executable SQL grants to them. Without
   * stripping, a migration that documents the bug it repairs reports itself.
   */
  // Split on /\r?\n/, not "\n": `.` does not match `\r`, so on a CRLF migration
  // `--.*$` matched nothing and every comment survived stripping.
  const executableSql = (file: string): string =>
    readFileSync(join(migrationsDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");

  /** Slugs the seeder mints for any module, past or present, plus the org rungs. */
  const seededShape = (slug: string): boolean =>
    /^[A-Z0-9]+_MODULE_(OWNER|ADMIN|MEMBER)$/.test(slug) ||
    ["OWNER", "ORG_ADMIN", "MEMBER"].includes(slug);

  /**
   * Both grant tables, not just the role one. `user_permission_grants` (added in
   * `0438`) keys on a user rather than a role, but a backfill against it can name
   * a role in its selection just the same.
   */
  const isGrantMigration = (sql: string): boolean =>
    /INSERT INTO "?(role|user)_permission_grants"?/i.test(sql);

  /** Every slug literal sitting in a `slug = '…'` or `slug IN ('…', '…')` predicate. */
  const slugsNamedIn = (sql: string): string[] =>
    [...sql.matchAll(/"?slug"?\s*(?:=|IN)\s*(\([^)]*\)|'[A-Z0-9_]+')/gi)].flatMap((match) =>
      [...match[1]!.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!),
    );

  /** Permission keys are `module:resource:action`; nothing else in this SQL looks like one. */
  const permissionKeysIn = (sql: string): string[] =>
    [...sql.matchAll(/'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'/g)].map((m) => m[1]!);

  it("finds migration files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  /**
   * Already applied, so they cannot be edited — the fix is a repair migration.
   * This list must not grow: a new entry means somebody wrote another backfill
   * that reaches nobody.
   *
   * The CRM seven are repaired by `0226` and `0232` — asserted below rather than
   * claimed here. The HR one is NOT repaired; it is outside the CRM branch's
   * scope and is recorded so it stays visible. `hr:recruitment*` is currently
   * granted to nobody in any organisation, in exactly the way the party keys were.
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

  /**
   * A second, separate list — never an extension of the one above, and it earns
   * its entries rather than excusing them.
   *
   * A backfill *migration* cannot deliver a key introduced in the same release
   * at all: `role_permission_grants.permission_key` has a foreign key to
   * `permissions.name`, and `permissions` is filled by
   * `PermissionCatalogSyncService` at boot, after `db:migrate`. The `EXISTS`
   * guard every backfill carries therefore skips the new key and nothing re-runs
   * afterwards. `RoleGrantReconcilerService` is the mechanism that replaces
   * them: it runs from that same sync, after the catalog exists, and converges
   * every pristine seeded or template-materialised role on what the seeder and
   * `ROLE_TEMPLATES` would produce today.
   *
   * So a migration listed here is a historical no-op whose *intent* is delivered
   * — and the test below proves that, key by key, against the reconciler's own
   * desired-grant computation. Drop a key from the template and this goes red;
   * it cannot rot into a comment. Measured on a scratch database: `0990` insert
   * 0 rows in an organisation seeded the way the product seeds one, and the
   * reconciler then granted all six of its keys to `CUSTOMER_SUPPORT`.
   */
  const SUPERSEDED_BY_RECONCILER = [
    "0990_support_template_grant_backfill.sql: CUSTOMER_SUPPORT",
  ];

  it("no grant targets a slug the seeder never produces", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sql = executableSql(file);
      if (!isGrantMigration(sql)) continue;
      for (const slug of new Set(slugsNamedIn(sql)))
        if (!seededShape(slug)) offenders.push(`${file}: ${slug}`);
    }

    expect(offenders.sort()).toEqual(
      [...KNOWN_INERT_BACKFILLS, ...SUPERSEDED_BY_RECONCILER].sort(),
    );
  });

  it("every key a superseded backfill named is one the reconciler actually grants", () => {
    const desired = buildDesiredGrants(new Set(PERMISSIONS.map((p) => p.name)));

    const undelivered: string[] = [];
    for (const entry of SUPERSEDED_BY_RECONCILER) {
      const [file, slug] = entry.split(": ") as [string, string];
      const granted = new Set(
        (desired.get(slug) ?? []).map((grant) => grant.permissionKey),
      );
      for (const key of new Set(permissionKeysIn(executableSql(file))))
        if (!granted.has(key)) undelivered.push(`${file}: ${slug}: ${key}`);
    }

    expect(undelivered.sort()).toEqual([]);
  });

  it("the reconciler still covers template slugs, which is what makes supersession possible", () => {
    // `KNOWN_INERT_BACKFILLS` is the record of what happens when a grant names a
    // slug nothing reaches. If the reconciler ever stops reading ROLE_TEMPLATES,
    // every entry above silently becomes that again.
    const desired = buildDesiredGrants(new Set(PERMISSIONS.map((p) => p.name)));
    const templateSlugs = SUPERSEDED_BY_RECONCILER.map(
      (entry) => entry.split(": ")[1]!,
    );

    for (const slug of templateSlugs) {
      expect(seededShape(slug)).toBe(false);
      expect(desired.get(slug)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("every key the inert backfills tried to grant is actually repaired", () => {
    /**
     * `0226` renamed two keys while repairing them, so the spelling a repair
     * grants is not the spelling the inert migration named. Anything not listed
     * here must be repaired under its own name.
     */
    const RENAMED_BY_REPAIR: Record<string, string> = {
      "crm:autonomy:review": "crm:autonomy:view",
      "crm:autonomy:configure": "crm:autonomy:manage",
    };

    const REPAIRS = [
      "0226_repair_crm_module_role_grants.sql",
      "0230_backfill_import_permission.sql",
      "0232_repair_crm_activity_grants.sql",
    ];

    const repaired = new Set(REPAIRS.flatMap((file) => permissionKeysIn(executableSql(file))));

    // HR's `0398` is knowingly unrepaired and out of scope; it stays in the
    // inert list above so it remains visible, and is excluded only here.
    const crmInertFiles = [
      ...new Set(
        KNOWN_INERT_BACKFILLS.map((entry) => entry.split(": ")[0]!).filter((file) =>
          file.startsWith("02"),
        ),
      ),
    ];

    const unrepaired: string[] = [];
    for (const file of crmInertFiles)
      for (const key of new Set(permissionKeysIn(executableSql(file)))) {
        const expected = RENAMED_BY_REPAIR[key] ?? key;
        if (!repaired.has(expected)) unrepaired.push(`${file}: ${key}`);
      }

    expect(unrepaired.sort()).toEqual([]);
  });

  it("the repairs themselves target slugs the seeder does produce", () => {
    for (const file of [
      "0226_repair_crm_module_role_grants.sql",
      "0230_backfill_import_permission.sql",
      "0232_repair_crm_activity_grants.sql",
    ]) {
      const slugs = new Set(slugsNamedIn(executableSql(file)));
      expect(slugs.size).toBeGreaterThan(0);
      for (const slug of slugs) expect(seededShape(slug)).toBe(true);
    }
  });

  it("CRM is still an administrable module, so those slugs are minted", () => {
    // If CRM ever leaves this list the repairs above go inert too, silently.
    expect(ADMINISTRABLE_MODULES).toContain("crm");
  });

  it("ROLE_TEMPLATES slugs are still distinct from seeded ones", () => {
    // The whole bug was confusing the two vocabularies. If a template ever takes
    // a seeded shape, `seededShape` stops discriminating and this guard weakens
    // without anything else noticing.
    const templateOnly = ROLE_TEMPLATES.map((t) => t.slug).filter((slug) => !seededShape(slug));
    expect(templateOnly).toContain("CRM_ADMIN");
  });
});
