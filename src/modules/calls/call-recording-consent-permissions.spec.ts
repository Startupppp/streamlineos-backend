import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import {
  buildModuleAdminPermissionKeys,
  buildModuleMemberPermissionKeys,
} from "../rbac/seed-system-roles";

/**
 * `crm:call-recording-consent:attest` has to reach the two CRM admin rungs and
 * nobody else, in both directions.
 *
 * The half a naming convention decides. `buildModuleMemberPermissionKeys` hands
 * `CRM_MODULE_MEMBER` every key in the module's namespace whose name ends in
 * `:view` or `:read`, so calling this `crm:call-recording-consent:view` would
 * have let every rep attest that their own call was lawfully recorded. A rep is
 * the person who knows whether the notice was played — and also the person the
 * attestation benefits, since it is what unlocks the analysis of their call. A
 * compliance assertion signed by its beneficiary is not evidence of anything.
 * That is asserted below rather than left as a comment, because the next person
 * to rename a key for readability will not read the comment.
 *
 * The half a migration decides. A catalogued key with no backfill works for
 * every organisation created after it ships and 403s for every one that existed
 * beforehand — `ON CONFLICT DO NOTHING` over zero matched rows is a clean
 * migration, which is why this is checked against the SQL text rather than
 * against a successful run.
 */
describe("the call recording consent key reaches admins and stops there", () => {
  const ATTEST = "crm:call-recording-consent:attest";

  const migration = readFileSync(
    join(__dirname, "../../../migrations/0544_crm_call_recording_consent.sql"),
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
    // A gate on a key the catalogue does not have works for every tenant a
    // migration granted it to and 403s for every tenant created afterwards.
    // `party:divergence:view` shipped exactly that way and nothing failed.
    expect(catalogue.has(ATTEST)).toBe(true);
  });

  it("does not end in a suffix that would hand it to every rep", () => {
    expect(ATTEST.endsWith(":view")).toBe(false);
    expect(ATTEST.endsWith(":read")).toBe(false);
  });

  it("gives a freshly seeded CRM admin the key and a member none of it", () => {
    const admin = buildModuleAdminPermissionKeys("crm", catalogue);
    const member = buildModuleMemberPermissionKeys("crm", catalogue);

    expect(admin).toContain(ATTEST);
    expect(member).not.toContain(ATTEST);
    // A rep still reads the analysis of a call they were on, and still finds out
    // why one is missing — `GET :activityId/recording-consent` is gated on this
    // key, not on the attest key. If this fails, narrowing the attestation has
    // taken the rep's own read away with it.
    expect(member).toContain("crm:call-analysis:view");
  });

  it("backfills the key onto organisations that already exist", () => {
    expect(executableSql).toContain(`'${ATTEST}'`);
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
    // granted to it and reached nobody, and reported themselves clean.
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

  it("mints no key that would let anybody skip the rule", () => {
    /**
     * The migration is where such a key would be added, because that is where a
     * key becomes real for existing tenants. A grant named for an override would
     * make a criminal-law constraint into something an administrator can lift,
     * which is the same as not having it.
     */
    expect(executableSql).not.toMatch(/override|waive|bypass|:disable/i);
  });
});

describe("the tables the rule reads are tenant-isolated", () => {
  const migration = readFileSync(
    join(__dirname, "../../../migrations/0544_crm_call_recording_consent.sql"),
    "utf8",
  );

  it("puts a row-level policy and a REVOKE on both new tables", () => {
    /**
     * Grants arrive through ALTER DEFAULT PRIVILEGES in this database, so a
     * missing policy is silent: the table is simply readable organisation-wide
     * and nothing complains. What leaks from these two is who was recorded,
     * where, and which of a tenant's calls could not be processed.
     */
    for (const table of ["crm_call_recording_consent", "crm_call_analysis_refusals"]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY "tenant_isolation" ON "${table}"`);
      expect(migration).toContain(`REVOKE ALL ON "${table}" FROM PUBLIC`);
    }
  });

  it("constrains the jurisdiction to the shape the register is keyed on", () => {
    // An unconstrained string that matches no register entry resolves to
    // all-party -- the right answer by accident, which stops being right the day
    // somebody adds a fuzzy lookup.
    expect(migration).toContain("chk_crm_call_recording_consent_jurisdiction");
    expect(migration).toContain("'^[A-Z]{2}(-[A-Z0-9]{1,3})?$'");
  });

  it("declares no foreign key from either table to activities", () => {
    /**
     * Deliberate, and the same choice `crm_call_analyses` and
     * `crm_call_analysis_releases` make. A timeline delete must not be able to
     * erase the evidence that a recording was lawful, nor the ledger entry
     * saying a call was refused — both are records of what happened, and the
     * organisation's defence if anybody asks.
     */
    expect(migration).not.toMatch(/REFERENCES\s+"activities"/);
  });

  it("uses lock_timeout and NOT VALID, so it cannot wedge a live database", () => {
    expect(migration).toContain("SET lock_timeout");
    expect(migration).toContain("NOT VALID");
    expect(migration).toContain("VALIDATE CONSTRAINT");
  });
});
