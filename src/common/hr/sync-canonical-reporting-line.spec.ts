import { drizzle } from "drizzle-orm/pg-proxy";
import { writePrimaryLines, writeSecondaryLines } from "./sync-canonical-reporting-line";
import { syncCanonicalReportingLine, syncCanonicalReportingLines, type ReportingLineOutcome } from "../../test/reporting-line-seed";
import type { DbOrTx } from "../rbac/access-invalidate";

const ORG = "org-1";
const MANAGER_USER = "u-mgr";
const MANAGER_EMPLOYMENT = 900;
const TODAY = "2026-09-08";
const YESTERDAY = "2026-09-07";
const OPEN = "infinity";

type Statement = { sql: string; params: unknown[] };

/** id, employment, manager, line type, from, to, source, reason, label, bulk job, request */
type LineRow = [number, number, number, string, string, string, string, string | null, string | null, string | null, string | null];

type Fixture = {
  employments: Array<[string, number]>;
  membership: number | null;
  managerEmploymentId: number | null;
  lines: LineRow[];
};

function line(id: number, employmentId: number, managerEmploymentId: number, from: string, to = OPEN, lineType = "primary", label: string | null = null): LineRow {
  return [id, employmentId, managerEmploymentId, lineType, from, to, "MANUAL", null, label, null, null];
}

function makeDb(fixture: Fixture): { db: DbOrTx; captured: Statement[] } {
  const captured: Statement[] = [];
  let nextId = 7000;
  const db = drizzle(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params });
    if (sql.includes('"manager_employment"'))
      return {
        rows: fixture.managerEmploymentId === null ? [] : [[fixture.managerEmploymentId]],
      };
    if (sql.includes('from "organization_members"'))
      return { rows: fixture.membership === null ? [] : [[fixture.membership]] };
    if (sql.includes('from "hr_employments"')) return { rows: fixture.employments };
    if (sql.startsWith('select "id", "employment_id"')) return { rows: fixture.lines };
    if (sql.startsWith('insert into "hr_reporting_lines"'))
      return { rows: insertedRows(sql, params).map((row) => [nextId++, ...row]) };
    return { rows: [] };
  });
  return { db: db as unknown as DbOrTx, captured };
}

/** [employment, manager, effective_from] of each inserted row, read back from the bound parameters. */
function insertedRows(sql: string, params: unknown[]): Array<[unknown, unknown, unknown]> {
  const tuples = sql.slice(sql.indexOf(" values ") + 8).split("), (");
  return tuples.map((tuple) => {
    const slots = tuple.replace(/[()]/g, "").split(", ");
    const valueAt = (slot: number) => {
      const placeholder = slots[slot];
      return placeholder?.startsWith("$") ? params[Number(placeholder.slice(1)) - 1] : undefined;
    };
    return [valueAt(2), valueAt(3), valueAt(5)];
  });
}

function statementsOn(captured: Statement[], fragment: string): Statement[] {
  return captured.filter((statement) => statement.sql.includes(fragment));
}

function onlyStatementOn(captured: Statement[], fragment: string): Statement {
  const matches = statementsOn(captured, fragment);
  expect(matches).toHaveLength(1);
  return matches[0];
}

const MIXED: Fixture = {
  employments: [
    [MANAGER_USER, MANAGER_EMPLOYMENT],
    ["u-same", 101],
    ["u-change", 102],
    ["u-fresh", 103],
  ],
  membership: 55,
  managerEmploymentId: MANAGER_EMPLOYMENT,
  lines: [line(501, 101, MANAGER_EMPLOYMENT, "2026-01-01"), line(502, 102, 800, "2026-01-01")],
};

const MIXED_SUBJECTS = ["u-none", MANAGER_USER, "u-same", "u-change", "u-fresh"];

describe("syncCanonicalReportingLines", () => {
  it("preloads every reportee's primary employment in one tenant-scoped join", async () => {
    const { db, captured } = makeDb(MIXED);

    await syncCanonicalReportingLines(db, ORG, MIXED_SUBJECTS, MANAGER_USER, TODAY, "actor-1");

    const select = onlyStatementOn(captured, 'from "hr_employments" inner join');
    expect(select.sql).toBe(
      'select "hr_people"."user_id", "hr_employments"."id" from "hr_employments" inner join "hr_people" on ("hr_people"."id" = "hr_employments"."person_id" and "hr_people"."org_id" = "hr_employments"."org_id") where ("hr_employments"."org_id" = $1 and "hr_employments"."is_primary" = $2 and "hr_employments"."deleted_at" is null and "hr_people"."user_id" in ($3, $4, $5, $6, $7) and "hr_people"."deleted_at" is null)',
    );
    expect(select.params).toEqual([ORG, true, ...MIXED_SUBJECTS]);
  });

  it("resolves the shared manager once, not once per reportee", async () => {
    const { db, captured } = makeDb(MIXED);

    await syncCanonicalReportingLines(db, ORG, MIXED_SUBJECTS, MANAGER_USER, TODAY, "actor-1");

    expect(statementsOn(captured, 'from "organization_members"')).toHaveLength(1);
    expect(statementsOn(captured, '"manager_employment"')).toHaveLength(1);
  });

  it("serialises the org's reporting-line writes and locks every line it may change in one read", async () => {
    const { db, captured } = makeDb(MIXED);

    await syncCanonicalReportingLines(db, ORG, MIXED_SUBJECTS, MANAGER_USER, TODAY, "actor-1");

    expect(statementsOn(captured, "pg_advisory_xact_lock")).toHaveLength(1);
    const read = onlyStatementOn(captured, 'select "id", "employment_id"');
    expect(read.sql).toContain('"hr_reporting_lines"."effective_to" >= $');
    expect(read.sql).toMatch(/ for update$/);
    expect(read.params).toEqual([ORG, 101, 102, 103, "primary", TODAY]);
  });

  it("closes the replaced line the day before and opens a MANUAL line, never editing the manager in place", async () => {
    const { db, captured } = makeDb(MIXED);

    await syncCanonicalReportingLines(db, ORG, MIXED_SUBJECTS, MANAGER_USER, TODAY, "actor-1");

    const close = onlyStatementOn(captured, 'update "hr_reporting_lines"');
    expect(close.sql).toContain('set "effective_to" = $1, "updated_at" = $2');
    expect(close.sql).not.toContain("manager_employment_id");
    expect(close.params[0]).toBe(YESTERDAY);
    expect(close.params.slice(2)).toEqual([ORG, 502]);

    const insert = onlyStatementOn(captured, 'insert into "hr_reporting_lines"');
    expect(insert.params).toEqual([
      ORG, 102, MANAGER_EMPLOYMENT, "primary", TODAY, "actor-1", "MANUAL", null, null, null, null,
      ORG, 103, MANAGER_EMPLOYMENT, "primary", TODAY, "actor-1", "MANUAL", null, null, null, null,
    ]);
    expect(statementsOn(captured, "hr_reporting_lines_superseded")).toHaveLength(0);
  });

  it("returns the hand-computed outcome for every reportee in a mixed batch", async () => {
    const { db } = makeDb(MIXED);

    const outcomes = await syncCanonicalReportingLines(db, ORG, MIXED_SUBJECTS, MANAGER_USER, TODAY, "actor-1");

    expect([...outcomes.entries()]).toEqual([
      ["u-none", { status: "unmappable", reason: "employment-missing" }],
      [MANAGER_USER, { status: "unmappable", reason: "self-reference" }],
      ["u-same", { status: "unchanged", employmentId: 101, managerEmploymentId: MANAGER_EMPLOYMENT, lineId: 501 }],
      ["u-change", { status: "written", employmentId: 102, managerEmploymentId: MANAGER_EMPLOYMENT, lineId: 7000 }],
      ["u-fresh", { status: "written", employmentId: 103, managerEmploymentId: MANAGER_EMPLOYMENT, lineId: 7001 }],
    ]);
  });

  it("issues a constant seven statements for two hundred reportees", async () => {
    const subjects = Array.from({ length: 200 }, (_unused, index) => `u-${index}`);
    const { db, captured } = makeDb({
      employments: subjects.map((userId, index) => [userId, index + 1]),
      membership: 55,
      managerEmploymentId: MANAGER_EMPLOYMENT,
      lines: subjects.map((_unused, index) => line(10_000 + index, index + 1, 800, "2026-01-01")),
    });

    await syncCanonicalReportingLines(db, ORG, subjects, MANAGER_USER, TODAY, "actor-1");

    expect(captured).toHaveLength(7);
    expect(statementsOn(captured, 'insert into "hr_reporting_lines"')).toHaveLength(1);
    expect(statementsOn(captured, 'update "hr_reporting_lines"')).toHaveLength(1);
  });

  it("writes nothing when every reportee already reports to that manager", async () => {
    const { db, captured } = makeDb({
      employments: [["u-same", 101]],
      membership: 55,
      managerEmploymentId: MANAGER_EMPLOYMENT,
      lines: [line(501, 101, MANAGER_EMPLOYMENT, "2026-01-01")],
    });

    const outcomes = await syncCanonicalReportingLines(db, ORG, ["u-same"], MANAGER_USER, TODAY, "actor-1");

    expect(statementsOn(captured, 'update "hr_reporting_lines"')).toHaveLength(0);
    expect(statementsOn(captured, 'insert into "hr_reporting_lines"')).toHaveLength(0);
    expect(outcomes.get("u-same")).toEqual({ status: "unchanged", employmentId: 101, managerEmploymentId: MANAGER_EMPLOYMENT, lineId: 501 });
  });

  it("closes every current line in one UPDATE when the manager is removed", async () => {
    const { db, captured } = makeDb({
      employments: [["u-a", 101], ["u-b", 102]],
      membership: 55,
      managerEmploymentId: MANAGER_EMPLOYMENT,
      lines: [line(601, 101, 800, "2026-01-01"), line(602, 102, 800, "2026-02-01")],
    });

    const outcomes = await syncCanonicalReportingLines(db, ORG, ["u-a", "u-b"], null, TODAY, "actor-1");

    const close = onlyStatementOn(captured, 'update "hr_reporting_lines"');
    expect(close.params[0]).toBe(YESTERDAY);
    expect(close.params.slice(2)).toEqual([ORG, 601, 602]);
    expect(statementsOn(captured, 'insert into "hr_reporting_lines"')).toHaveLength(0);
    expect(statementsOn(captured, 'from "organization_members"')).toHaveLength(0);
    expect(outcomes.get("u-a")).toEqual({ status: "cleared", employmentId: 101 });
    expect(outcomes.get("u-b")).toEqual({ status: "cleared", employmentId: 102 });
  });

  it("marks every reportee unmappable and writes nothing when the manager is not a member", async () => {
    const { db, captured } = makeDb({ employments: [["u-a", 101]], membership: null, managerEmploymentId: null, lines: [] });

    const outcomes = await syncCanonicalReportingLines(db, ORG, ["u-a"], MANAGER_USER, TODAY, "actor-1");

    expect(outcomes.get("u-a")).toEqual({ status: "unmappable", reason: "manager-not-in-organization" });
    expect(statementsOn(captured, 'update "hr_reporting_lines"')).toHaveLength(0);
    expect(statementsOn(captured, 'insert into "hr_reporting_lines"')).toHaveLength(0);
  });

  it("marks every reportee unmappable when the manager has no employment", async () => {
    const { db } = makeDb({ employments: [["u-a", 101]], membership: 55, managerEmploymentId: null, lines: [] });

    const outcomes = await syncCanonicalReportingLines(db, ORG, ["u-a"], MANAGER_USER, TODAY, "actor-1");

    expect(outcomes.get("u-a")).toEqual({ status: "unmappable", reason: "manager-has-no-employment" });
  });

  it("touches nothing when no reportee resolves to an employment", async () => {
    const { db, captured } = makeDb({ employments: [], membership: 55, managerEmploymentId: MANAGER_EMPLOYMENT, lines: [] });

    await syncCanonicalReportingLines(db, ORG, ["u-a"], MANAGER_USER, TODAY, "actor-1");

    expect(captured).toHaveLength(1);
  });

  it("writes nothing at all for an empty reportee list", async () => {
    const { db, captured } = makeDb(MIXED);

    const outcomes = await syncCanonicalReportingLines(db, ORG, [], MANAGER_USER, TODAY, "actor-1");

    expect(captured).toHaveLength(0);
    expect(outcomes.size).toBe(0);
  });
});

describe("writePrimaryLines — the close hazards", () => {
  const provenance = { source: "BULK_REASSIGNMENT" as const, reason: "Sales reorganisation", bulkJobId: "job-1", requestId: null, createdBy: "actor-1" };

  function closes(captured: Statement[]): unknown[] {
    return statementsOn(captured, 'update "hr_reporting_lines"').map((statement) => statement.params[0]);
  }

  function archived(captured: Statement[]): unknown[][] {
    return statementsOn(captured, "hr_reporting_lines_superseded").map((statement) => statement.params);
  }

  it("moves a same-day line to the superseded archive instead of ending it before it starts", async () => {
    const { db, captured } = makeDb({ ...MIXED, lines: [line(701, 102, 800, TODAY)] });

    const results = await writePrimaryLines(db, ORG, [{ employmentId: 102, managerEmploymentId: MANAGER_EMPLOYMENT }], { from: TODAY }, provenance);

    expect(closes(captured)).toEqual([]);
    expect(archived(captured)).toEqual([["actor-1", ORG, [701], ORG]]);
    expect(results.get(102)).toEqual({ status: "written", lineId: 7000, previousLineId: 701, managerEmploymentId: MANAGER_EMPLOYMENT });
  });

  it("supersedes a future-dated line that the new assignment replaces, never closing it to a day before its start", async () => {
    const { db, captured } = makeDb({ ...MIXED, lines: [line(711, 102, 800, "2026-01-01", "2026-09-30"), line(712, 102, 801, "2026-10-01")] });

    await writePrimaryLines(db, ORG, [{ employmentId: 102, managerEmploymentId: MANAGER_EMPLOYMENT }], { from: TODAY }, provenance);

    expect(closes(captured)).toEqual([YESTERDAY]);
    expect(onlyStatementOn(captured, 'update "hr_reporting_lines"').params.slice(2)).toEqual([ORG, 711]);
    expect(archived(captured)).toEqual([["actor-1", ORG, [712], ORG]]);
  });

  it("closes the line in force on a back-dated day and supersedes the one that started after it", async () => {
    const { db, captured } = makeDb({ ...MIXED, lines: [line(721, 102, 800, "2026-01-01", "2026-08-31"), line(722, 102, 801, "2026-09-01")] });

    await writePrimaryLines(db, ORG, [{ employmentId: 102, managerEmploymentId: MANAGER_EMPLOYMENT }], { from: "2026-08-15" }, provenance);

    expect(closes(captured)).toEqual(["2026-08-14"]);
    expect(archived(captured)).toEqual([["actor-1", ORG, [722], ORG]]);
  });

  it("stamps source, reason and bulk job on the new line", async () => {
    const { db, captured } = makeDb({ ...MIXED, lines: [] });

    await writePrimaryLines(db, ORG, [{ employmentId: 103, managerEmploymentId: MANAGER_EMPLOYMENT }], { from: TODAY }, provenance);

    expect(onlyStatementOn(captured, 'insert into "hr_reporting_lines"').params).toEqual([
      ORG, 103, MANAGER_EMPLOYMENT, "primary", TODAY, "actor-1", "BULK_REASSIGNMENT", "Sales reorganisation", null, "job-1", null,
    ]);
  });

  it("carves a bounded window out of an open line and re-opens the old manager the day after it", async () => {
    const { db, captured } = makeDb({ ...MIXED, lines: [line(731, 102, 800, "2026-01-01")] });

    const results = await writePrimaryLines(
      db,
      ORG,
      [{ employmentId: 102, managerEmploymentId: MANAGER_EMPLOYMENT }],
      { from: TODAY, to: "2026-09-30" },
      { source: "EFFECTIVE_CHANGE", createdBy: null },
    );

    expect(closes(captured)).toEqual([YESTERDAY]);
    const insert = onlyStatementOn(captured, 'insert into "hr_reporting_lines"');
    expect(insertedRows(insert.sql, insert.params)).toEqual([
      [102, MANAGER_EMPLOYMENT, TODAY],
      [102, 800, "2026-10-01"],
    ]);
    expect(insert.params).toContain("2026-09-30");
    expect(results.get(102)).toMatchObject({ status: "written", managerEmploymentId: MANAGER_EMPLOYMENT });
  });
});

describe("writeSecondaryLines", () => {
  it("keeps an unchanged secondary, ends one no longer wanted, and opens the missing one as matrix", async () => {
    const { db, captured } = makeDb({
      ...MIXED,
      lines: [line(801, 102, 810, "2026-01-01", OPEN, "matrix", "Project"), line(802, 102, 820, "2026-01-01", OPEN, "dotted", null)],
    });

    const result = await writeSecondaryLines(
      db,
      ORG,
      102,
      [{ managerEmploymentId: 810, label: "Project" }, { managerEmploymentId: 830, label: "Functional" }],
      TODAY,
      { source: "MANUAL", createdBy: "actor-1" },
    );

    expect(result.keptLineIds).toEqual([801]);
    expect(result.endedLineIds).toEqual([802]);
    expect(result.addedLineIds).toEqual([7000]);
    expect(onlyStatementOn(captured, 'select "id", "employment_id"').params).toEqual([ORG, 102, "primary", TODAY]);
    expect(onlyStatementOn(captured, 'insert into "hr_reporting_lines"').params).toEqual([
      ORG, 102, 830, "matrix", TODAY, "actor-1", "MANUAL", null, "Functional", null, null,
    ]);
  });

  it("ends every secondary line when the desired set is empty", async () => {
    const { db, captured } = makeDb({ ...MIXED, lines: [line(811, 102, 810, TODAY, OPEN, "matrix", null)] });

    const result = await writeSecondaryLines(db, ORG, 102, [], TODAY, { source: "MANUAL", createdBy: "actor-1" });

    expect(result).toEqual({ addedLineIds: [], endedLineIds: [811], keptLineIds: [] });
    expect(statementsOn(captured, 'insert into "hr_reporting_lines"')).toHaveLength(0);
    expect(statementsOn(captured, "hr_reporting_lines_superseded")).toHaveLength(1);
  });
});

describe("syncCanonicalReportingLine", () => {
  it("returns the singular outcome the batched form computed for that one user", async () => {
    const { db } = makeDb(MIXED);

    const outcome: ReportingLineOutcome = await syncCanonicalReportingLine(db, ORG, "u-change", MANAGER_USER, TODAY, "actor-1");

    expect(outcome).toEqual({ status: "written", employmentId: 102, managerEmploymentId: MANAGER_EMPLOYMENT, lineId: 7000 });
  });

  it("still closes the open line before inserting the replacement", async () => {
    const { db, captured } = makeDb(MIXED);

    await syncCanonicalReportingLine(db, ORG, "u-change", MANAGER_USER, TODAY, "actor-1");

    const close = onlyStatementOn(captured, 'update "hr_reporting_lines"');
    expect(close.params.slice(2)).toEqual([ORG, 502]);
    const insert = onlyStatementOn(captured, 'insert into "hr_reporting_lines"');
    expect(captured.indexOf(close)).toBeLessThan(captured.indexOf(insert));
  });
});
