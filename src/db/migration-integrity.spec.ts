import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface JournalEntry {
  idx: number;
  tag: string;
}

interface MigrationJournal {
  entries: JournalEntry[];
}

function readMigration(name: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
}

describe("RBAC hardening migrations", () => {
  const journal = JSON.parse(
    readMigration("meta/_journal.json"),
  ) as MigrationJournal;

  it("journals the generated migrations", () => {
    expect(journal.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: "0117_invitation-events-org-fk" }),
        expect.objectContaining({ tag: "0118_module_access_indexes" }),
      ]),
    );
  });

  it("keeps the invitation FK lock-safe", () => {
    const migration = readMigration("0117_invitation-events-org-fk.sql");
    expect(migration).toContain("SET lock_timeout = '5s'");
    expect(migration).toContain("NOT VALID");
    expect(migration).toContain("VALIDATE CONSTRAINT");
  });

  it("keeps index creation compatible with Drizzle's transaction wrapper", () => {
    const migration = readMigration("0118_module_access_indexes.sql");
    expect(migration).toContain("SET statement_timeout = 0");
    expect(migration).toContain("SET lock_timeout = '5s'");
    expect(migration).not.toContain("CREATE INDEX CONCURRENTLY");
  });

  it("stages RBAC tenant enforcement before validation", () => {
    const add = readMigration("0394_rbac_composite_tenant_fks.sql");
    const validate = readMigration("0395_validate_rbac_composite_tenant_fks.sql");

    expect(add.match(/ON DELETE CASCADE NOT VALID;/g)).toHaveLength(5);
    expect(add).toContain("SET lock_timeout = '5s'");
    expect(validate.match(/ALTER TABLE \w+ VALIDATE CONSTRAINT/g)).toHaveLength(5);
    expect(validate).toContain("SET lock_timeout = '5s'");
  });

  it("makes the dead-table migration fail closed", () => {
    const migration = readMigration(
      "0396_drop_verified_dead_learning_tables.sql",
    );

    expect(migration).toContain("row_count <> 0");
    expect(migration.match(/DROP TABLE IF EXISTS/g)).toHaveLength(7);
    expect(migration).toContain("RESTRICT");
    expect(migration).not.toMatch(/DROP TABLE[^;]+CASCADE;/);
    expect(migration).not.toMatch(/DROP TABLE IF EXISTS payroll_statutory_rule_sets/);
  });
});

describe("HRMS Phase 1 SQL-managed bundle", () => {
  const pendingRoot = "pending/hrms-phase1";
  const forwardNames = [
    "0000_hrms_profiles_workforce.sql",
    "0001_hrms_effective_history.sql",
    "0002_hrms_leave_ledger.sql",
    "0003_hrms_attendance_events.sql",
    "0004_hrms_hierarchy_audit.sql",
  ];
  const forwardSql = forwardNames.map((name) =>
    readMigration(`${pendingRoot}/${name}`),
  );

  it("keeps SQL-managed objects outside the Drizzle schema and journal", () => {
    const runtimeBarrel = readFileSync(
      resolve(process.cwd(), "src/db/schema/index.ts"),
      "utf8",
    );
    const managedBarrel = readFileSync(
      resolve(process.cwd(), "src/db/schema/hrms-phase1-sql-managed.ts"),
      "utf8",
    );
    expect(runtimeBarrel).not.toContain("hrms-phase1-sql-managed");
    expect(managedBarrel).toContain("worker-engagement-state-events");
    expect(managedBarrel).toContain("worker-leave-ledger");
    expect(managedBarrel).toContain("attendance-event-store");
    expect(managedBarrel).toContain("audit-events");
    expect(
      existsSync(resolve(process.cwd(), "migrations", pendingRoot, "meta")),
    ).toBe(false);
    const rootJournal = readMigration("meta/_journal.json");
    for (const name of forwardNames)
      expect(rootJournal).not.toContain(name.replace(/\.sql$/, ""));
  });

  it.each(forwardNames)("keeps %s bounded and deterministic", (name) => {
    const migration = readMigration(`${pendingRoot}/${name}`);
    expect(migration).toContain("SET statement_timeout = '5min';");
    expect(migration).toContain("SET lock_timeout = '5s';");
    expect(migration).toContain("SET search_path = public, pg_catalog;");
    expect(migration).not.toMatch(/statement_timeout\s*=\s*0/i);
    expect(migration).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i);
    expect(migration).not.toMatch(/current_date/i);
    expect(migration).not.toMatch(/PARTITION\s+OF\s+\w+\s+DEFAULT/i);
    expect(migration).not.toMatch(/FOR\s+VALUES\s+FROM/i);
  });

  it("uses reciprocal deferred fact locators", () => {
    const leave = forwardSql[2] ?? "";
    const attendance = forwardSql[3] ?? "";
    const audit = forwardSql[4] ?? "";
    expect(leave).toContain("CONSTRAINT fk_worker_leave_entries_locator");
    expect(leave).toContain("ADD CONSTRAINT fk_worker_leave_locators_fact");
    expect(attendance).toContain("CONSTRAINT fk_attendance_events_locator");
    expect(attendance).toContain(
      "ADD CONSTRAINT fk_attendance_event_locators_fact",
    );
    expect(audit).toContain("CONSTRAINT fk_hr_audit_events_source");
    expect(audit).toContain("ADD CONSTRAINT fk_hr_audit_event_sources_fact");
    for (const migration of [leave, attendance, audit])
      expect(
        migration.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length ?? 0,
      ).toBeGreaterThanOrEqual(2);
  });

  it("keeps the base history wave compatible with the legacy writer", () => {
    const workforce = forwardSql[0] ?? "";
    const history = forwardSql[1] ?? "";
    expect(history).not.toMatch(/INSERT\s+INTO\s+worker_engagement_state_events/i);
    expect(history).not.toMatch(
      /UPDATE\s+worker_engagements[\s\S]+last_state_event_id\s*=/i,
    );
    expect(workforce).toContain(
      "uniq_worker_engagements_active_primary_unarchived",
    );
    expect(history).not.toContain(
      "uniq_worker_engagements_active_primary_unarchived",
    );
  });

  it("serializes hierarchy cycle checks per organization", () => {
    const hierarchy = forwardSql[4] ?? "";
    expect(hierarchy).toContain(
      "streamlineos:hrms:org-unit-hierarchy:",
    );
    expect(hierarchy).toContain("pg_advisory_xact_lock");
    expect(hierarchy).toContain(
      "REVOKE ALL ON FUNCTION app.verify_org_unit_parent_cycle() FROM PUBLIC",
    );
  });

  it("serializes engagement events and their current projection", () => {
    const history = forwardSql[1] ?? "";
    expect(history).toContain("streamlineos:hrms:engagement-state:");
    expect(history).toContain("lock_worker_engagement_state_event");
    expect(history).toContain("lock_worker_engagement_state_projection");
    expect(history).toContain("verify_worker_engagement_state_projection");
    expect(history).toContain("HRMS_ENGAGEMENT_EFFECTIVE_DATE_REGRESSION");
    expect(history).toContain("HRMS_ENGAGEMENT_STATE_POINTER_CANNOT_BE_CLEARED");
    expect(history).toContain("SELECT * INTO current_engagement");
    expect(history).toContain("profile_history_mode <> 'LEGACY'");
    expect(history).toContain("NEW.to_status IN ('ACTIVE', 'CANCELLED')");
    expect(history).toContain("NEW.to_status IN ('COMPLETED', 'TERMINATED')");
    expect(history).toContain(
      "NEW.to_status = 'PLANNED' AND next_event.to_status IN ('ACTIVE', 'CANCELLED')",
    );
  });

  it.each(forwardNames)("pins function search paths in %s", (name) => {
    const migration = readMigration(`${pendingRoot}/${name}`);
    const headers = Array.from(
      migration.matchAll(
        /CREATE(?: OR REPLACE)? FUNCTION[\s\S]*?\nAS\s+\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g,
      ),
      (match) => match[0],
    );
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers)
      expect(header).toContain("SET search_path = pg_catalog, public");
  });

  it("keeps immutable actor identifiers as snapshots", () => {
    const immutableSql = forwardSql.slice(2).join("\n");
    expect(immutableSql).not.toMatch(
      /actor_(?:membership|user)_id[^,;]*REFERENCES/is,
    );
    expect(immutableSql).not.toMatch(
      /REFERENCES\s+(?:organization_members|users)[^;]*actor_(?:membership|user)/is,
    );
  });

  it("withholds broad raw evidence and audit access", () => {
    const attendance = forwardSql[3] ?? "";
    const audit = forwardSql[4] ?? "";
    expect(attendance).not.toMatch(
      /GRANT\s+[^;]+attendance_event_evidence/is,
    );
    expect(attendance).not.toMatch(
      /GRANT\s+[^;]+attendance_evidence_legal_holds/is,
    );
    expect(attendance).not.toMatch(/streamline_kms_writer/i);
    expect(audit).not.toMatch(/GRANT\s+[^;]+hr_audit_events/is);
    expect(audit).not.toMatch(/GRANT\s+[^;]+hr_audit_event_sources/is);
    expect(audit).not.toMatch(/GRANT\s+[^;]+org_unit_closure/is);
  });

  it("checks every effective relation and sequence privilege", () => {
    for (const migration of forwardSql.slice(2)) {
      expect(migration).toContain("'REFERENCES'");
      expect(migration).toContain("'TRIGGER'");
      expect(migration).toContain("'MAINTAIN'");
      expect(migration).toContain("has_any_column_privilege");
      expect(migration).toContain("privilege.grantee = 0");
      expect(migration).toContain("has_sequence_privilege");
      expect(migration).toContain("'USAGE'");
      expect(migration).toContain("'SELECT'");
      expect(migration).toContain("'UPDATE'");
    }
  });

  it.each(forwardNames)("balances PostgreSQL dollar quotes in %s", (name) => {
    const migration = readMigration(`${pendingRoot}/${name}`);
    const tags = migration.match(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g) ?? [];
    const counts = new Map<string, number>();
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    for (const count of counts.values()) expect(count % 2).toBe(0);
  });

  it.each(forwardNames)("makes the %s rollback fail closed", (name) => {
    const downName = name.replace(/\.sql$/, ".down.sql");
    const rollback = readMigration(`${pendingRoot}/${downName}`);
    expect(rollback).toMatch(/(?:DOWN|ROLLBACK)_REFUSED/);
  });

  it("records successful rollbacks after all destructive DDL", () => {
    const ledger = forwardSql[0] ?? "";
    expect(ledger).toContain(
      "state IN ('RUNNING', 'VERIFYING', 'COMPLETE', 'FAILED', 'ROLLED_BACK')",
    );
    expect(ledger).toContain("OLD.state = 'COMPLETE'");
    expect(ledger).toContain("NEW.state = 'ROLLED_BACK'");
    expect(ledger).toContain("OLD.state = 'ROLLED_BACK'");
    for (const name of forwardNames) {
      const rollback = readMigration(
        `${pendingRoot}/${name.replace(/\.sql$/, ".down.sql")}`,
      );
      expect(rollback).toContain("HRMS_BUNDLE_ROLLBACK_COMPLETE_TARGET_INVALID");
      expect(rollback).toContain("HRMS_BUNDLE_ROLLBACK_COMPLETE_TARGET_AMBIGUOUS");
      expect(rollback).toContain("SET state = 'ROLLED_BACK'");
      expect(rollback.lastIndexOf("SET state = 'ROLLED_BACK'")).toBeGreaterThan(
        rollback.lastIndexOf("DROP "),
      );
    }
  });

  it("keeps the leave fact source column order equal to the SQL table", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/db/schema/hr/worker-leave-ledger.ts"),
      "utf8",
    );
    const tableStart = source.indexOf("export const workerLeaveLedgerEntries");
    const organization = source.indexOf('text("organization_id")', tableStart);
    const effectiveDate = source.indexOf('date("effective_date")', organization);
    const entry = source.indexOf('bigint("entry_id"', organization);
    expect(organization).toBeGreaterThan(tableStart);
    expect(effectiveDate).toBeGreaterThan(organization);
    expect(entry).toBeGreaterThan(effectiveDate);
  });
});

/*
 * Chain-repair migrations transcribe a pg_catalog, so they recreate STRUCTURE
 * and cannot recreate DATA — and they do not always recreate the structure
 * faithfully either.
 *
 * `0464_gl_kernel` creates `gl_currencies` with `code text PRIMARY KEY` and two
 * CHECK constraints, then seeds 20 currencies. `0489_chain_creates_early` and
 * `0619_chain_creates_what_production_has` create the same table with NO primary
 * key and NO checks, and no rows. On a cold build that is harmless: 0464 sits at
 * journal position 248 and the repairs at 366 and 385, so 0464 wins and their
 * `IF NOT EXISTS` skips. It bites only where 0464 was skipped — which is exactly
 * what happened on the shared Neon branch, whose applied watermark ran ahead of
 * the journal (see [[db-migrate-lies-on-neon]]). There the table exists, empty,
 * without its key, and `accounting-setup.service.ts:173` reads it to decide
 * whether the currency catalogue is installed.
 *
 * A table correctly shaped and empty is the hardest kind of missing to notice,
 * so this bounds the set rather than leaving it to be rediscovered. It is a
 * RATCHET, not a fix: the shared branch is repaired by a decision that is not
 * ours to take, so the known case stays listed and the test fails if the set
 * GROWS. Note the drifted copy has no unique constraint, so a repair cannot use
 * `ON CONFLICT (code)` — it has to restore the key first.
 */
describe("chain-repair migrations do not silently weaken a table", () => {
  const journal = JSON.parse(readMigration("meta/_journal.json")) as MigrationJournal;
  const tags = journal.entries.map((e) => e.tag);

  // "public"."x", "x" and bare x all appear in this tree.
  const NAME = String.raw`(?:"?[a-z_0-9]+"?\.)?"?([a-z_0-9]+)"?`;
  const created = (sql: string): Set<string> =>
    new Set([...sql.matchAll(new RegExp(String.raw`CREATE TABLE(?:\s+IF NOT EXISTS)?\s+${NAME}`, "gi"))].map((m) => m[1].toLowerCase()));
  const seeded = (sql: string): Set<string> =>
    new Set([...sql.matchAll(new RegExp(String.raw`INSERT INTO\s+${NAME}`, "gi"))].map((m) => m[1].toLowerCase()));

  /** Tables a migration both creates and fills — their rows exist nowhere else. */
  function seededOnCreation(): Map<string, string> {
    const out = new Map<string, string>();
    for (const tag of tags) {
      const sql = readMigration(`${tag}.sql`);
      for (const t of created(sql)) if (seeded(sql).has(t)) out.set(t, tag);
    }
    return out;
  }

  function chainRepairTags(): string[] {
    return tags.filter((t) => t.includes("chain_creates"));
  }

  it("reads the migrations it claims to, and finds the case we know about", () => {
    // Without this the two cases below pass over an empty census.
    expect(chainRepairTags().length).toBeGreaterThanOrEqual(2);
    const onCreation = seededOnCreation();
    expect(onCreation.size).toBeGreaterThanOrEqual(20);
    expect(onCreation.get("gl_currencies")).toBe("0464_gl_kernel");
  });

  it("lists exactly the tables a chain repair can leave shaped and empty", () => {
    const onCreation = seededOnCreation();
    const byRepair = new Set(chainRepairTags().flatMap((t) => [...created(readMigration(`${t}.sql`))]));
    const atRisk = [...onCreation.keys()].filter((t) => byRepair.has(t)).sort();
    // Growing this list means a new chain repair took over a seeded table.
    // Add it here only with the repair for it, never to make the test pass.
    expect(atRisk).toEqual(["gl_currencies"]);
  });

  it("keeps the authoritative migration ahead of every repair that recreates it", () => {
    // This ordering is the only reason a cold build is unaffected. If a repair
    // ever sorts first, its keyless copy wins and 0464's un-guarded CREATE TABLE
    // fails outright.
    const authoritative = tags.indexOf("0464_gl_kernel");
    expect(authoritative).toBeGreaterThan(-1);
    for (const repair of chainRepairTags()) {
      if (created(readMigration(`${repair}.sql`)).has("gl_currencies")) {
        expect(tags.indexOf(repair)).toBeGreaterThan(authoritative);
      }
    }
  });
});
