import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import {
  buildModuleAdminPermissionKeys,
  buildModuleMemberPermissionKeys,
} from "../rbac/seed-system-roles";

/**
 * The two keys this ticket adds have to reach somebody, in both directions.
 *
 * `gated-keys-are-catalogued.spec.ts` covers one half — a decorator naming a key
 * the catalogue does not hold. It cannot cover the other half, which is the
 * failure this branch has already shipped twice: a key that IS catalogued, so a
 * newly created organisation gets it at seed time, and that no migration ever
 * granted, so every organisation that existed beforehand gets a 403 on an
 * endpoint their newer neighbours can use. Nothing fails when that happens —
 * `ON CONFLICT DO NOTHING` over zero matched rows is a clean migration — which
 * is exactly why it is asserted here rather than assumed.
 *
 * Both halves are read from the artefacts themselves: the catalogue from
 * `ALL_PERMISSION_NAMES`, the seeding rules from the functions the seeder
 * actually calls, and the backfill from the migration's SQL text.
 */
describe("the call-analysis permission keys reach somebody", () => {
  const VIEW = "crm:call-analysis:view";
  const RUN = "crm:call-analysis:run";

  const migration = readFileSync(
    join(__dirname, "../../../migrations/0541_crm_call_analysis_permissions.sql"),
    "utf8",
  );

  /**
   * Comments explain the slugs; only executable SQL grants to them, so they are
   * stripped before anything is asserted — a migration that documents the bug it
   * avoids must not report itself as committing it.
   *
   * Split first, strip second. `--> statement-breakpoint` is itself a comment as
   * far as a naive stripper is concerned, and removing it collapses the file into
   * one statement — which is how an assertion about the member grant silently
   * starts reading the admin grant above it.
   */
  const statements = migration
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n"),
    );
  const executableSql = statements.join("\n");

  const catalogue = new Set(ALL_PERMISSION_NAMES);

  it("catalogues both keys, so a new organisation is seeded with them", () => {
    expect(catalogue.has(VIEW)).toBe(true);
    expect(catalogue.has(RUN)).toBe(true);
  });

  it("gives a freshly seeded CRM admin both, and a member the read-only one", () => {
    const admin = buildModuleAdminPermissionKeys("crm", catalogue);
    const member = buildModuleMemberPermissionKeys("crm", catalogue);

    expect(admin).toContain(VIEW);
    expect(admin).toContain(RUN);
    expect(member).toContain(VIEW);
    // Spending the organisation's AI credits is not a member's authority. If
    // this ever passes, the key stopped ending in something the member builder
    // excludes and every rep gained the ability to spend.
    expect(member).not.toContain(RUN);
  });

  it("backfills both keys onto organisations that already exist", () => {
    expect(executableSql).toContain(`'${VIEW}'`);
    expect(executableSql).toContain(`'${RUN}'`);
  });

  it("backfills the same shape the seeder produces, or a tenant's rights depend on signup date", () => {
    // `:view` to all three rungs, `:run` to the two admin rungs — the exact
    // split `buildModuleAdminPermissionKeys`/`buildModuleMemberPermissionKeys`
    // assert above.
    const memberGrant = statements.filter((sql) => sql.includes("CRM_MODULE_MEMBER"));
    expect(memberGrant).toHaveLength(1);
    expect(memberGrant[0]).toContain(VIEW);
    expect(memberGrant[0]).not.toContain(RUN);

    expect(executableSql).toContain("'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN'");
  });

  it("names only slugs the seeder mints, never a ROLE_TEMPLATES slug", () => {
    // `CRM_ADMIN` is a template an administrator may create a role from; no
    // organisation is ever seeded with one. Seven migrations in the 02xx series
    // granted to it and reached nobody.
    expect(executableSql).not.toContain("'CRM_ADMIN'");
    const slugs = [...executableSql.matchAll(/slug"?\s*(?:=|IN|LIKE)\s*\(?\s*'([A-Z0-9_%]+)'/g)].map(
      (match) => match[1]!,
    );
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(slug).toMatch(/^CRM_MODULE_(OWNER|ADMIN|MEMBER|%)$/);
  });

  it("bumps the access version, or the grant sits behind a cache nobody invalidates", () => {
    expect(executableSql).toContain('INSERT INTO "access_versions"');
    expect(executableSql).toContain('"permissions_version" + 1');
  });
});
