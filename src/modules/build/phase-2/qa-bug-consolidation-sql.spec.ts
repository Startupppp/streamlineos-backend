import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SQL_DIR = join(REPO_ROOT, "migrations", "sql");

const EXPAND = "b-qa-bug-01-expand.sql";
const BACKFILL = "b-qa-bug-02-backfill.sql";
const VERIFY = "b-qa-bug-03-verify.sql";
const FREEZE = "b-qa-bug-04-contract-freeze.sql";
const DROP = "b-qa-bug-05-contract-drop.sql";

const FILES = [
  EXPAND,
  "b-qa-bug-01-expand-rollback.sql",
  BACKFILL,
  "b-qa-bug-02-backfill-rollback.sql",
  VERIFY,
  FREEZE,
  "b-qa-bug-04-contract-freeze-rollback.sql",
  DROP,
];

function readSql(name: string): string {
  return readFileSync(join(SQL_DIR, name), "utf8").replace(/\r\n/g, "\n");
}

function stripSqlComments(sql: string): string {
  const marker = "__BREAKPOINT__";
  return sql
    .split("--> statement-breakpoint")
    .join(marker)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(marker)
    .join("--> statement-breakpoint");
}

function statements(name: string): string[] {
  return readSql(name).split("--> statement-breakpoint");
}

describe("the QA bug consolidation SQL obeys the migration discipline gate", () => {
  it.each(FILES)("%s exists", (name) => {
    expect(existsSync(join(SQL_DIR, name))).toBe(true);
  });

  it.each(FILES)("%s sets lock_timeout", (name) => {
    expect(/set\s+lock_timeout/i.test(readSql(name))).toBe(true);
  });

  it.each(FILES)("%s adds no foreign key without NOT VALID", (name) => {
    for (const stmt of statements(name)) {
      if (/ADD\s+CONSTRAINT\s+\S+\s+FOREIGN\s+KEY/i.test(stmt)) {
        expect(/NOT\s+VALID/i.test(stmt)).toBe(true);
      }
    }
  });

  it.each(FILES)("%s puts no statement-breakpoint inside a DO block", (name) => {
    for (const m of readSql(name).matchAll(/DO\s+\$\$[\s\S]*?\$\$/gi)) {
      expect(m[0].includes("--> statement-breakpoint")).toBe(false);
    }
  });

  it.each(FILES)("%s creates no index CONCURRENTLY", (name) => {
    expect(/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(stripSqlComments(readSql(name)))).toBe(
      false,
    );
  });

  it.each(FILES)("%s precedes any SET NOT NULL with a CHECK IS NOT NULL NOT VALID", (name) => {
    const sql = stripSqlComments(readSql(name));
    if (!/ALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL/i.test(sql)) return;
    expect(/CHECK\s*\([^)]*IS\s+NOT\s+NULL[^)]*\)\s+NOT\s+VALID/i.test(sql)).toBe(true);
  });

  it.each(FILES)("%s never validates a constraint before its backfill UPDATE", (name) => {
    const stmts = stripSqlComments(readSql(name)).split("--> statement-breakpoint");
    const validateIdx = stmts.findIndex((s) => /VALIDATE\s+CONSTRAINT/i.test(s));
    const backfillIdx = stmts.findIndex((s) => /UPDATE\s+\S+[\s\S]*?WHERE/i.test(s));
    if (validateIdx === -1 || backfillIdx === -1) return;
    expect(validateIdx).toBeGreaterThan(backfillIdx);
  });
});

describe("no composite SET NULL key is installed in the bare form migration 1142 exists to repair", () => {
  const setNullStatements = FILES.flatMap((name) =>
    statements(name)
      .filter((s) => /ON\s+DELETE\s+SET\s+NULL/i.test(s))
      .map((s) => ({ name, sql: s })),
  );

  it("finds SET NULL keys at all, so the shape assertions below are not vacuous", () => {
    expect(setNullStatements.length).toBeGreaterThan(0);
  });

  it("gives every multi-column SET NULL foreign key an explicit column list", () => {
    let composite = 0;
    for (const { sql } of setNullStatements) {
      const key = /FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(sql);
      if (!key) continue;
      if (key[1].split(",").length < 2) continue;
      composite += 1;
      expect(/ON\s+DELETE\s+SET\s+NULL\s*\(\s*"[a-z_]+"\s*\)/i.test(sql)).toBe(true);
    }
    expect(composite).toBeGreaterThan(0);
  });

  it("never names the tenant column in a SET NULL column list", () => {
    for (const { sql } of setNullStatements) {
      const list = /ON\s+DELETE\s+SET\s+NULL\s*\(([^)]*)\)/i.exec(sql);
      if (!list) continue;
      expect(list[1]).not.toMatch(/org_id/i);
    }
  });

  it("leaves a column list off only where the key is single-column and needs none", () => {
    let bare = 0;
    for (const { sql } of setNullStatements) {
      if (/ON\s+DELETE\s+SET\s+NULL\s*\(/i.test(sql)) continue;
      bare += 1;
      const key = /FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(sql);
      expect(key).not.toBeNull();
      expect(key === null ? [] : key[1].split(",")).toHaveLength(1);
    }
    expect(bare).toBeGreaterThan(0);
  });
});

describe("the sidecar cannot drift from the ticket it denormalises", () => {
  const expand = stripSqlComments(readSql(EXPAND));

  it("creates work_item_qa_details rather than widening tickets", () => {
    expect(expand).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"build"\."work_item_qa_details"/i);
  });

  it("binds the denormalised project_id through a three-column foreign key to tickets", () => {
    expect(expand).toMatch(
      /FOREIGN\s+KEY\s*\(\s*"org_id"\s*,\s*"project_id"\s*,\s*"work_item_id"\s*\)\s*REFERENCES\s+"build"\."tickets"\s*\(\s*"org_id"\s*,\s*"project_id"\s*,\s*"id"\s*\)/i,
    );
  });

  it("creates the unique index on tickets that the three-column foreign key requires", () => {
    expect(expand).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"uniq_tickets_org_project_id"/i);
  });

  it("keeps the legacy identity in a map table the contract drop does not remove", () => {
    expect(expand).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"build"\."bug_work_item_map"/i);
    expect(stripSqlComments(readSql(DROP))).not.toMatch(/DROP\s+TABLE[^;]*bug_work_item_map/i);
  });
});

describe("the backfill is re-runnable and loses no history", () => {
  const backfill = readSql(BACKFILL);

  it("guards every INSERT with a conflict clause or a NOT EXISTS predicate", () => {
    const inserts = stripSqlComments(backfill)
      .split("--> statement-breakpoint")
      .filter((s) => /INSERT\s+INTO/i.test(s));
    expect(inserts.length).toBeGreaterThan(0);
    for (const stmt of inserts) {
      expect(/ON\s+CONFLICT|NOT\s+EXISTS/i.test(stmt)).toBe(true);
    }
  });

  const CANONICAL_INSERTS = [
    "build.tickets",
    "build.work_item_qa_details",
    "build_events.ticket_activity_log",
  ];

  function canonicalInsert(target: string): string {
    const stmt = stripSqlComments(backfill)
      .split("--> statement-breakpoint")
      .find((s) => new RegExp(`INSERT\\s+INTO\\s+${target.replace(".", "\\.")}\\s*\\(`, "i").test(s));
    if (stmt === undefined) throw new Error(`no INSERT INTO ${target} in the backfill`);
    return stmt;
  }

  it.each(CANONICAL_INSERTS)("the insert into %s dates migrated history from the source row, never the clock", (target) => {
    expect(canonicalInsert(target)).not.toMatch(/\b(now\(\)|current_timestamp|random\(\))/i);
  });

  it.each(CANONICAL_INSERTS)(
    "the insert into %s converts every timestamp it writes, because bugs stores them without a time zone",
    (target) => {
      const stmt = canonicalInsert(target);
      const columnList = new RegExp(`INSERT\\s+INTO\\s+${target.replace(".", "\\.")}\\s*\\(([^)]*)\\)`, "i").exec(stmt);
      expect(columnList).not.toBeNull();
      const timestampColumns = (columnList === null ? "" : columnList[1])
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c === "created_at" || c === "updated_at" || c === "deleted_at");
      expect(timestampColumns.length).toBeGreaterThan(0);
      const conversions = stmt.match(/AT\s+TIME\s+ZONE\s+'UTC'/gi) ?? [];
      expect(conversions.length).toBeGreaterThanOrEqual(timestampColumns.length);
    },
  );

  it("stamps the clock only on bookkeeping columns of rows it updates, never on a migrated row", () => {
    const clockStatements = stripSqlComments(backfill)
      .split("--> statement-breakpoint")
      .filter((s) => /\bnow\(\)/i.test(s));
    expect(clockStatements.length).toBeGreaterThan(0);
    for (const stmt of clockStatements) {
      expect(stmt).toMatch(/(ON\s+CONFLICT[\s\S]*DO\s+UPDATE|^\s*UPDATE\s)/i);
    }
  });

  it("records the nine-value bug_status verbatim as qa_state, because the projection onto five state groups is lossy", () => {
    expect(stripSqlComments(backfill)).toMatch(/qa_state/);
    expect(stripSqlComments(readSql(EXPAND))).toMatch(/qa_state/);
  });

  it("never lets severity rewrite the triage decision recorded in ticket priority", () => {
    const priorityCast = /CASE\s+([a-z]{1,3}\.[a-z_]+)::text[\s\S]*?END\s*\)?::public\.ticket_priority/i.exec(
      stripSqlComments(backfill),
    );
    expect(priorityCast).not.toBeNull();
    expect(priorityCast === null ? "" : priorityCast[1]).toMatch(/\.priority$/);
  });

  it("converts linked_ticket_id into a work_item_relations row rather than dropping it", () => {
    expect(stripSqlComments(backfill)).toMatch(/INSERT\s+INTO\s+build\.work_item_relations/i);
  });
});

describe("the contract phases cut over in an order that cannot fork the two identities", () => {
  it("revokes the legacy write grant before anything is dropped", () => {
    expect(stripSqlComments(readFileSync(join(SQL_DIR, FREEZE), "utf8"))).toMatch(
      /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE\s+ON\s+"build"\."bugs"\s+FROM\s+streamline_app/i,
    );
  });

  it("re-grants exactly what the freeze revoked, so the freeze is reversible", () => {
    expect(stripSqlComments(readSql("b-qa-bug-04-contract-freeze-rollback.sql"))).toMatch(
      /GRANT\s+INSERT,\s*UPDATE,\s*DELETE\s+ON\s+"build"\."bugs"\s+TO\s+streamline_app/i,
    );
  });

  it("destroys no data in the freeze phase, so the rollback window is real", () => {
    const freeze = stripSqlComments(readSql(FREEZE));
    expect(freeze).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(freeze).not.toMatch(/DELETE\s+FROM/i);
  });

  it("ships no rollback file for the drop phase and says so in the file itself", () => {
    expect(existsSync(join(SQL_DIR, "b-qa-bug-05-contract-drop-rollback.sql"))).toBe(false);
    expect(readSql(DROP)).toMatch(/There is no in-place undo/i);
  });

  it("names the verification file the drop phase depends on", () => {
    expect(existsSync(join(SQL_DIR, VERIFY))).toBe(true);
    expect(readSql(FREEZE)).toContain(VERIFY);
  });

  it("writes nothing in the verification file, so it can be run against a live database", () => {
    const verify = stripSqlComments(readSql(VERIFY));
    expect(verify).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+[a-z_."]+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+)/i);
    expect(verify).toMatch(/SELECT/i);
  });
});

describe("none of these files can reach a database by accident", () => {
  const journal: { entries?: { tag?: string }[] } = JSON.parse(
    readFileSync(join(REPO_ROOT, "migrations", "meta", "_journal.json"), "utf8"),
  );
  const tags = new Set((journal.entries ?? []).map((e) => e.tag));

  it("reads a journal with entries, so the exclusion assertions below are not vacuous", () => {
    expect(tags.size).toBeGreaterThan(0);
  });

  it.each(FILES)("%s has no entry in the migration journal", (name) => {
    expect(tags.has(name.replace(/\.sql$/, ""))).toBe(false);
  });
});
