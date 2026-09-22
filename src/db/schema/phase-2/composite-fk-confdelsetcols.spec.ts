import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as schema from "../index";
import { deriveSetNullDeclarations } from "../set-null-column-lists";
import {
  buildStructuralIndex,
  buildTimeline,
  findFixpoints,
  judge,
  parseInstalls,
  relationName,
  resolveAlias,
  splitStatements,
  structuralKey,
} from "../../../scripts/check-set-null-migration-text";

const BACKEND_ROOT = resolve(__dirname, "../../../..");
const MIGRATIONS_DIR = resolve(BACKEND_ROOT, "migrations");
const SQL_DIR = resolve(BACKEND_ROOT, "docs/phase-2/sql");

const VERIFY_SQL = "c-confdelsetcols-01-verify.sql";
const PAIRING_SQL = "c-confdelsetcols-02-tenant-pairing.sql";
const PROOF_SQL = "c-confdelsetcols-03-cross-tenant-delete-proof.sql";
const REGRESSION_SQL = "c-confdelsetcols-04-bare-form-regression.sql";

function readSql(name: string): string {
  return readFileSync(resolve(SQL_DIR, name), "utf8");
}

type Corpus = { tag: string; sql: string; position: number }[];

let corpusCache: Corpus | undefined;

function readCorpus(): Corpus {
  if (corpusCache !== undefined) return corpusCache;
  const journal = JSON.parse(
    readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const files: Corpus = [];
  journal.entries.forEach((entry, position) => {
    const path = resolve(MIGRATIONS_DIR, `${entry.tag}.sql`);
    if (!existsSync(path)) return;
    files.push({ tag: entry.tag, sql: readFileSync(path, "utf8"), position });
  });
  corpusCache = files;
  return files;
}

function declaredRequiringColumnList() {
  return deriveSetNullDeclarations(schema as unknown as Record<string, unknown>).declared.filter(
    (fk) => fk.requiresColumnList,
  );
}

function parenBalance(sqlText: string): number {
  let depth = 0;
  for (const statement of splitStatements(sqlText)) {
    const flat = statement.replace(/\$[A-Za-z_0-9]*\$[\s\S]*?\$[A-Za-z_0-9]*\$/g, "");
    const stripped = flat.replace(/'(?:[^']|'')*'/g, "");
    for (const ch of stripped) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
    }
  }
  return depth;
}

function dollarTagCounts(sqlText: string): Map<string, number> {
  const counts = new Map<string, number>();
  const matches = sqlText.match(/\$[A-Za-z_0-9]*\$/g) ?? [];
  for (const tag of matches) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return counts;
}

describe("P0 #8 — the composite SET NULL population this workstream must verify", () => {
  it("every declared composite SET NULL key is arity 2", () => {
    const requiring = declaredRequiringColumnList();
    expect(requiring.length).toBeGreaterThanOrEqual(200);
    expect(requiring.filter((fk) => fk.columns.length !== 2)).toEqual([]);
  });

  it("every declared composite SET NULL key has exactly one nullable member", () => {
    expect(declaredRequiringColumnList().filter((fk) => fk.setNullColumns.length !== 1)).toEqual([]);
  });

  it("the leading member is always a tenant column and never appears in the required list", () => {
    const requiring = declaredRequiringColumnList();
    const tenant = new Set(["org_id", "organization_id"]);
    expect(requiring.filter((fk) => !tenant.has(fk.columns[0]))).toEqual([]);
    expect(requiring.filter((fk) => fk.setNullColumns.some((c) => tenant.has(c)))).toEqual([]);
  });

  it("no declared SET NULL key is unreachable, at any arity", () => {
    expect(
      deriveSetNullDeclarations(schema as unknown as Record<string, unknown>).unreachable,
    ).toEqual([]);
  });
});

describe("the residual gap the migration corpus cannot resolve by name", () => {
  it("leaves no composite SET NULL key untraceable once structural identity is used", () => {
    const corpus = readCorpus();
    const timeline = buildTimeline(corpus);
    const index = buildStructuralIndex(corpus);
    const sweeps = findFixpoints(corpus);
    const through = sweeps[sweeps.length - 1].position;

    const untraceable = declaredRequiringColumnList().filter(
      (fk) =>
        judge(fk.constraint, fk.setNullColumns, timeline, through, {
          index,
          table: fk.table,
          columns: fk.columns,
        }).verdict === "untraceable",
    );

    expect(untraceable.map((fk) => fk.constraint)).toEqual([]);
  });

  it("leaves no composite SET NULL key unresolved as dropped", () => {
    const corpus = readCorpus();
    const timeline = buildTimeline(corpus);
    const index = buildStructuralIndex(corpus);
    const through = findFixpoints(corpus).slice(-1)[0].position;

    const dropped = declaredRequiringColumnList().filter(
      (fk) =>
        judge(fk.constraint, fk.setNullColumns, timeline, through, {
          index,
          table: fk.table,
          columns: fk.columns,
        }).verdict === "dropped",
    );

    expect(dropped.map((fk) => fk.constraint)).toEqual([]);
  });

  it("resolves the two invitations duplicates 0982 dropped to 0965's surviving canonical keys", () => {
    const corpus = readCorpus();
    const timeline = buildTimeline(corpus);
    const index = buildStructuralIndex(corpus);
    const through = findFixpoints(corpus).slice(-1)[0].position;

    const cases: [string, string, string][] = [
      [
        "fk_invitations_org_inviter_membership",
        "inviter_membership_id",
        "fk_invitations_inviter_membership_id_org",
      ],
      [
        "fk_invitations_org_accepted_membership",
        "accepted_membership_id",
        "fk_invitations_accepted_membership_id_org",
      ],
    ];

    for (const [declared, pointer, canonical] of cases) {
      const verdict = judge(declared, [pointer], timeline, through, {
        index,
        table: "invitations",
        columns: ["org_id", pointer],
      });
      expect(verdict.verdict).toBe("installed-alias");
      expect(verdict.alias).toBe(canonical);
      expect(verdict.actual).toEqual([pointer]);
    }
  });

  it("still reports dropped when the column tuple has no surviving constraint", () => {
    const goneForGood = [
      {
        tag: "0001",
        sql: "ALTER TABLE t ADD CONSTRAINT fk_gone FOREIGN KEY (org_id, x_id) REFERENCES p (org_id, id) ON DELETE SET NULL (x_id);",
      },
      { tag: "0002", sql: "ALTER TABLE t DROP CONSTRAINT fk_gone;" },
    ];
    expect(
      judge("fk_gone", ["x_id"], buildTimeline(goneForGood), -1, {
        index: buildStructuralIndex(goneForGood),
        table: "t",
        columns: ["org_id", "x_id"],
      }).verdict,
    ).toBe("dropped");
  });

  it("resolves build.managed_products, whose 77-byte derived name appears in no .sql even truncated to 63, through the name the corpus actually installs", () => {
    const corpus = readCorpus();
    const verdict = judge(
      "managed_products_org_id_owner_membership_id_organization_members_org_id_id_fk",
      ["owner_membership_id"],
      buildTimeline(corpus),
      findFixpoints(corpus).slice(-1)[0].position,
      {
        index: buildStructuralIndex(corpus),
        table: "managed_products",
        columns: ["org_id", "owner_membership_id"],
      },
    );

    expect(verdict.verdict).toBe("installed-alias");
    expect(verdict.alias).toBe("fk_managed_products_owner_membership");
    expect(verdict.actual).toEqual(["owner_membership_id"]);
  });

  it("marks every swept key determinate, so the sweep's fixpoint pins one column list", () => {
    const corpus = readCorpus();
    const timeline = buildTimeline(corpus);
    const index = buildStructuralIndex(corpus);
    const through = findFixpoints(corpus).slice(-1)[0].position;

    const indeterminate = declaredRequiringColumnList().filter(
      (fk) =>
        judge(fk.constraint, fk.setNullColumns, timeline, through, {
          index,
          table: fk.table,
          columns: fk.columns,
        }).verdict === "swept-indeterminate",
    );

    expect(indeterminate.map((fk) => fk.constraint)).toEqual([]);
  });

  it("refuses to resolve a column tuple that two standing constraints share", () => {
    const ambiguous = [
      {
        tag: "0001",
        sql:
          "ALTER TABLE t ADD CONSTRAINT fk_one FOREIGN KEY (org_id, x_id) REFERENCES p (org_id, id) ON DELETE SET NULL (x_id);" +
          " ALTER TABLE t ADD CONSTRAINT fk_two FOREIGN KEY (org_id, x_id) REFERENCES p (org_id, id) ON DELETE SET NULL (x_id);",
      },
    ];
    expect(
      resolveAlias(
        buildTimeline(ambiguous),
        buildStructuralIndex(ambiguous),
        "t",
        ["org_id", "x_id"],
        "fk_derived",
      ),
    ).toBeNull();
  });

  it("does not count a commented-out ADD CONSTRAINT in a CRLF migration as an install", () => {
    const crlf =
      "-- ALTER TABLE t ADD CONSTRAINT fk_commented FOREIGN KEY (org_id, x_id) REFERENCES p (org_id, id) ON DELETE SET NULL;\r\n" +
      "ALTER TABLE t ADD CONSTRAINT fk_live FOREIGN KEY (org_id, x_id) REFERENCES p (org_id, id) ON DELETE SET NULL (x_id);\r\n";
    const names = splitStatements(crlf)
      .flatMap((s) => parseInstalls(s))
      .map((i) => i.name);

    expect(names).toEqual(["fk_live"]);
  });

  it("reads the relation and columns identically from a CRLF statement", () => {
    const crlf =
      'ALTER TABLE "build"."managed_products"\r\n  ADD CONSTRAINT fk_x\r\n  FOREIGN KEY ("org_id", "owner_membership_id")\r\n  REFERENCES public.organization_members (org_id, id)\r\n  ON DELETE SET NULL ("owner_membership_id");\r\n';
    const install = parseInstalls(splitStatements(crlf)[0])[0];

    expect(install.relation).toBe("managed_products");
    expect(install.keyColumns).toEqual(["org_id", "owner_membership_id"]);
    expect(install.setNullColumns).toEqual(["owner_membership_id"]);
  });

  it("indexes an install by its bare relation name and its referencing columns", () => {
    const sql =
      'ALTER TABLE "build"."managed_products" ADD CONSTRAINT fk_x FOREIGN KEY ("org_id", "owner_membership_id") REFERENCES public.organization_members (org_id, id) ON DELETE SET NULL ("owner_membership_id");';
    const install = parseInstalls(splitStatements(sql)[0])[0];

    expect(relationName('"build"."managed_products"')).toBe("managed_products");
    expect(install.relation).toBe("managed_products");
    expect(install.keyColumns).toEqual(["org_id", "owner_membership_id"]);
    expect(
      buildStructuralIndex([{ tag: "t", sql }]).get(
        structuralKey("managed_products", ["org_id", "owner_membership_id"]),
      ),
    ).toEqual(["fk_x"]);
  });
});

describe("migration 1128a and 1142 — the premise this workstream was given", () => {
  const read = (tag: string): string => readFileSync(resolve(MIGRATIONS_DIR, `${tag}.sql`), "utf8");

  it("1128a installs the bare composite form over a NOT NULL tenant column", () => {
    const install = parseInstalls(
      splitStatements(read("1128a_requisition_headcount_link")).find((s) =>
        s.includes("fk_job_requisitions_headcount_org"),
      ) as string,
    ).find((i) => i.name === "fk_job_requisitions_headcount_org");

    expect(install?.action).toBe("SET NULL");
    expect(install?.setNullColumns).toBeNull();
    expect(install?.keyColumns).toEqual(["org_id", "headcount_id"]);
  });

  it("1142 installs the column list naming only the nullable pointer", () => {
    const install = parseInstalls(
      splitStatements(read("1142_fix_requisition_headcount_fk_set_null")).find((s) =>
        s.includes("ADD CONSTRAINT"),
      ) as string,
    ).find((i) => i.name === "fk_job_requisitions_headcount_org");

    expect(install?.action).toBe("SET NULL");
    expect(install?.setNullColumns).toEqual(["headcount_id"]);
  });

  it("the corpus therefore leaves 1142's form standing, not 1128a's", () => {
    const corpus = readCorpus();
    const verdict = judge(
      "fk_job_requisitions_headcount_org",
      ["headcount_id"],
      buildTimeline(corpus),
      findFixpoints(corpus).slice(-1)[0].position,
    );

    expect(verdict.verdict).toBe("installed");
    expect(verdict.actual).toEqual(["headcount_id"]);
    expect(verdict.tag).toBe("1142_fix_requisition_headcount_fk_set_null");
  });

  it("1128a lands after the last catalog-driven sweep, so no sweep would have repaired it", () => {
    const corpus = readCorpus();
    const lastSweep = findFixpoints(corpus).slice(-1)[0];
    const position = corpus.find((f) => f.tag === "1128a_requisition_headcount_link")?.position;

    expect(position).toBeDefined();
    expect(position as number).toBeGreaterThan(lastSweep.position);
  });
});

describe("the verification SQL is well formed and reads the right catalog", () => {
  const files = [VERIFY_SQL, PAIRING_SQL, PROOF_SQL, REGRESSION_SQL];

  it.each(files)("%s exists and is non-trivial", (name) => {
    expect(readSql(name).trim().length).toBeGreaterThan(200);
  });

  it.each(files)(
    "%s balances its parentheses, counting outside strings, dollar-quoted bodies and comments so a '(' inside a NOTICE message cannot skew it",
    (name) => {
      expect(parenBalance(readSql(name))).toBe(0);
    },
  );

  it.each(files)("%s balances every dollar-quote tag", (name) => {
    for (const [tag, count] of dollarTagCounts(readSql(name)))
      expect(`${tag}:${count % 2}`).toBe(`${tag}:0`);
  });

  it.each(files)("%s splits into at least one complete statement", (name) => {
    expect(splitStatements(readSql(name)).length).toBeGreaterThan(0);
  });

  it.each(files)("%s never reads information_schema.delete_rule", (name) => {
    const sql = readSql(name);
    expect(sql).not.toMatch(/referential_constraints/i);
    expect(sql).not.toMatch(/delete_rule/i);
  });

  it("the verification query resolves confdelsetcols against pg_attribute", () => {
    const sql = readSql(VERIFY_SQL);
    expect(sql).toMatch(/unnest\s*\(\s*fk\.confdelsetcols\s*\)/i);
    expect(sql).toMatch(/JOIN\s+pg_attribute/i);
    expect(sql).toMatch(/att\.attrelid\s*=\s*fk\.conrelid/i);
    expect(sql).toMatch(/att\.attnum\s*=\s*s\.attnum/i);
    expect(sql).toMatch(/array_agg\(att\.attname/i);
  });

  it("the verification query selects on the SET NULL delete action only", () => {
    const sql = readSql(VERIFY_SQL);
    expect(sql).toMatch(/con\.contype\s*=\s*'f'/i);
    expect(sql).toMatch(/con\.confdeltype\s*=\s*'n'/i);
  });

  it("the verification query emits all three checks and a PASS/FAIL verdict", () => {
    const sql = readSql(VERIFY_SQL);
    expect(sql).toMatch(/check_a_list_is_exactly_intended/);
    expect(sql).toMatch(/check_b_every_named_column_nullable/);
    expect(sql).toMatch(/check_c_tenant_excluded_and_not_null/);
    expect(sql).toMatch(/'PASS'/);
    expect(sql).toMatch(/'FAIL'/);
    expect(sql).toMatch(/AS\s+verdict/i);
  });

  it("the verification query derives the intended list from attnotnull, not from a hardcoded list", () => {
    const sql = readSql(VERIFY_SQL);
    expect(sql).toMatch(/FILTER\s*\(\s*WHERE\s+NOT\s+attnotnull\s*\)/i);
    expect(sql).toMatch(/intended_set_null_columns/);
  });

  it("the verification query names both tenant column spellings the schema actually uses", () => {
    const tenant = new Set(
      declaredRequiringColumnList().map((fk) => fk.columns[0]),
    );
    const sql = readSql(VERIFY_SQL);
    for (const column of tenant) expect(sql).toContain(`'${column}'`);
  });

  it("the verification query refuses to report an empty catalog as clean", () => {
    const sql = readSql(VERIFY_SQL);
    expect(sql).toMatch(/PREREQUISITE UNMET/);
    expect(sql).toMatch(/server_version_num/);
    expect(sql).toMatch(/150000/);
  });

  it("the tenant-pairing query maps child key columns onto parent key columns positionally", () => {
    const sql = readSql(PAIRING_SQL);
    expect(sql).toMatch(/fk\.conkey\[k\.ord\]/);
    expect(sql).toMatch(/fk\.confkey\[k\.ord\]/);
    expect(sql).toMatch(/generate_subscripts\s*\(\s*fk\.conkey\s*,\s*1\s*\)/i);
  });
});

describe("the transactional proofs cannot commit", () => {
  const proofs = [PROOF_SQL, REGRESSION_SQL];

  it.each(proofs)("%s opens a transaction and ends it with ROLLBACK", (name) => {
    const statements = splitStatements(readSql(name)).map((s) => s.trim().toUpperCase());
    expect(statements[0]).toBe("BEGIN");
    expect(statements[statements.length - 1]).toBe("ROLLBACK");
  });

  it.each(proofs)("%s contains no COMMIT at any nesting level", (name) => {
    expect(readSql(name)).not.toMatch(/\bCOMMIT\b/i);
  });

  it.each(proofs)("%s contains no DROP TABLE and no TRUNCATE", (name) => {
    const sql = readSql(name);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it.each(proofs)("%s bounds its locks and statements", (name) => {
    const sql = readSql(name);
    expect(sql).toMatch(/SET\s+LOCAL\s+lock_timeout/i);
    expect(sql).toMatch(/SET\s+LOCAL\s+statement_timeout/i);
  });

  it("the cross-tenant proof asserts on the other tenant's rows, not only its own", () => {
    const sql = readSql(PROOF_SQL);
    expect(sql).toMatch(/CROSS-TENANT FAILURE/);
    expect(sql).toMatch(/b_headcount\s+IS\s+DISTINCT\s+FROM\s+parent_b/i);
    expect(sql).toMatch(/b_org\s+IS\s+DISTINCT\s+FROM\s+org_b/i);
    expect(sql).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+headcount_requests/i);
  });

  it("the cross-tenant proof refuses to run against an unrepaired 1128a constraint", () => {
    const sql = readSql(PROOF_SQL);
    expect(sql).toMatch(/PRECONDITION FAILED/);
    expect(sql).toMatch(/fk_job_requisitions_headcount_org/);
    expect(sql).toMatch(/ARRAY\['headcount_id'\]/);
  });

  it("the cross-tenant proof supplies every NOT NULL column it can name, and checks for the rest", () => {
    const sql = readSql(PROOF_SQL);
    expect(sql).toMatch(/organizations\.owner_membership_id/);
    expect(sql).toMatch(/is_nullable\s*=\s*'NO'/i);
    expect(sql).toMatch(/column_default\s+IS\s+NULL/i);
  });

  it("the regression proof restores the bare form and expects 23502", () => {
    const sql = readSql(REGRESSION_SQL);
    expect(sql).toMatch(/ON\s+DELETE\s+SET\s+NULL\s*;/i);
    expect(sql).toMatch(/WHEN\s+not_null_violation\s+THEN/i);
    expect(sql).toMatch(/REGRESSION PROOF FAILED/);
  });

  it("the regression proof's restored constraint is byte-identical in shape to 1128a's", () => {
    const restored = parseInstalls(
      splitStatements(readSql(REGRESSION_SQL)).find((s) =>
        /ADD\s+CONSTRAINT\s+fk_job_requisitions_headcount_org/i.test(s),
      ) as string,
    ).find((i) => i.name === "fk_job_requisitions_headcount_org");

    const original = parseInstalls(
      splitStatements(
        readFileSync(resolve(MIGRATIONS_DIR, "1128a_requisition_headcount_link.sql"), "utf8"),
      ).find((s) => s.includes("ADD CONSTRAINT")) as string,
    ).find((i) => i.name === "fk_job_requisitions_headcount_org");

    expect(restored?.action).toBe(original?.action);
    expect(restored?.setNullColumns).toBe(original?.setNullColumns);
    expect(restored?.keyColumns).toEqual(original?.keyColumns);
  });
});
