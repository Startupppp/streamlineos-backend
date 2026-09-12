import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import {
  buildModuleAdminPermissionKeys,
  buildModuleMemberPermissionKeys,
} from "../rbac/seed-system-roles";

/**
 * `crm:call-analysis:view-team` has to reach the two admin rungs and nobody
 * else, in both directions.
 *
 * The half that a naming convention decides. `buildModuleMemberPermissionKeys`
 * hands `CRM_MODULE_MEMBER` every key in the module's namespace whose name ends
 * in `:view` or `:read`. Calling this key `crm:call-analysis:team-view` would
 * therefore have granted every rep the right to read every other rep's calls at
 * seed time — the leaderboard this ticket exists to prevent, arrived at through
 * a suffix. Nothing anywhere would have failed. That is asserted below rather
 * than left as a comment on the catalogue entry, because the next person to
 * rename a key for readability will not read the comment.
 *
 * The half that a migration decides. A catalogued key with no backfill works for
 * every organisation created after it ships and 403s for every one that existed
 * beforehand — `ON CONFLICT DO NOTHING` over zero matched rows is a clean
 * migration, which is why this is checked against the SQL text.
 */
describe("the call-analysis team key reaches admins and stops there", () => {
  const TEAM = "crm:call-analysis:view-team";
  const VIEW = "crm:call-analysis:view";

  const migration = readFileSync(
    join(__dirname, "../../../migrations/0543a_crm_call_analysis_team_permissions.sql"),
    "utf8",
  );

  /**
   * Split on the breakpoint first, strip comments second. `--> statement-breakpoint`
   * is itself a comment to a naive stripper, and removing it collapses the file
   * into one statement — which is how an assertion that no member grant exists
   * silently starts reading the admin grant instead.
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

  it("catalogues the key, so a new organisation is seeded with it", () => {
    expect(catalogue.has(TEAM)).toBe(true);
  });

  it("does not end in a suffix that would hand it to every rep", () => {
    // The rule `buildModuleMemberPermissionKeys` applies, restated so a rename
    // fails here and not in production.
    expect(TEAM.endsWith(":view")).toBe(false);
    expect(TEAM.endsWith(":read")).toBe(false);
  });

  it("gives a freshly seeded CRM admin the key and a member none of it", () => {
    const admin = buildModuleAdminPermissionKeys("crm", catalogue);
    const member = buildModuleMemberPermissionKeys("crm", catalogue);

    expect(admin).toContain(TEAM);
    expect(member).not.toContain(TEAM);
    // The rep's own key is untouched by this ticket: a member still reads the
    // analysis of a call they were on. If this ever fails, narrowing the team
    // read has taken away the rep's own read as well.
    expect(member).toContain(VIEW);
  });

  it("backfills the key onto organisations that already exist", () => {
    expect(executableSql).toContain(`'${TEAM}'`);
    expect(executableSql).toContain("'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN'");
  });

  it("grants it to no member rung, matching what the seeder does", () => {
    const memberGrants = statements.filter(
      (sql) => sql.includes("CRM_MODULE_MEMBER") && sql.includes("role_permission_grants"),
    );
    expect(memberGrants).toEqual([]);
  });

  it("names only slugs the seeder mints, never a ROLE_TEMPLATES slug", () => {
    // `CRM_ADMIN` is a template an administrator may create a role from; no
    // organisation is ever seeded with one. Seven migrations in the 02xx series
    // granted to it and reached nobody.
    expect(executableSql).not.toContain("'CRM_ADMIN'");
    const slugs = [
      ...executableSql.matchAll(/slug"?\s*(?:=|IN|LIKE)\s*\(?\s*'([A-Z0-9_%]+)'/g),
    ].map((match) => match[1]!);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(slug).toMatch(/^CRM_MODULE_(OWNER|ADMIN|MEMBER|%)$/);
  });

  it("bumps the access version, or the grant sits behind a cache nobody invalidates", () => {
    expect(executableSql).toContain('INSERT INTO "access_versions"');
    expect(executableSql).toContain('"permissions_version" + 1');
  });
});
