import { drizzle } from "drizzle-orm/pg-proxy";
import {
  syncCanonicalReportingLine,
  syncCanonicalReportingLines,
  type ReportingLineOutcome,
} from "./sync-canonical-reporting-line";
import type { DbOrTx } from "../rbac/access-invalidate";

const ORG = "org-1";
const MANAGER_USER = "u-mgr";
const MANAGER_EMPLOYMENT = 900;
const TODAY = "2026-09-08";
const YESTERDAY = "2026-09-07";

type Statement = { sql: string; params: unknown[] };

type Fixture = {
  employments: Array<[string, number]>;
  membership: number | null;
  managerEmploymentId: number | null;
  openLines: Array<[number, number, number]>;
};

function makeDb(fixture: Fixture): { db: DbOrTx; captured: Statement[] } {
  const captured: Statement[] = [];
  const db = drizzle(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params });
    if (sql.includes('"manager_employment"'))
      return {
        rows: fixture.managerEmploymentId === null ? [] : [[fixture.managerEmploymentId]],
      };
    if (sql.includes('from "organization_members"'))
      return { rows: fixture.membership === null ? [] : [[fixture.membership]] };
    if (sql.includes('from "hr_employments"')) return { rows: fixture.employments };
    if (sql.includes('from "hr_reporting_lines"')) return { rows: fixture.openLines };
    return { rows: [] };
  });
  return { db: db as unknown as DbOrTx, captured };
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
  openLines: [
    [501, 101, MANAGER_EMPLOYMENT],
    [502, 102, 800],
  ],
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

  it("reads every open primary line in one statement", async () => {
    const { db, captured } = makeDb(MIXED);

    await syncCanonicalReportingLines(db, ORG, MIXED_SUBJECTS, MANAGER_USER, TODAY, "actor-1");

    const select = onlyStatementOn(captured, 'select "id", "employment_id"');
    expect(select.sql).toBe(
      'select "id", "employment_id", "manager_employment_id" from "hr_reporting_lines" where ("hr_reporting_lines"."org_id" = $1 and "hr_reporting_lines"."employment_id" in ($2, $3, $4) and "hr_reporting_lines"."line_type" = $5 and "hr_reporting_lines"."effective_to" = \'infinity\'::date)',
    );
    expect(select.params).toEqual([ORG, 101, 102, 103, "primary"]);
  });

  it("closes the superseded line with effective_to and opens a new one, never editing the manager in place", async () => {
    const { db, captured } = makeDb(MIXED);

    await syncCanonicalReportingLines(db, ORG, MIXED_SUBJECTS, MANAGER_USER, TODAY, "actor-1");

    const close = onlyStatementOn(captured, 'update "hr_reporting_lines"');
    expect(close.sql).toBe(
      'update "hr_reporting_lines" set "effective_to" = $1 where ("hr_reporting_lines"."org_id" = $2 and "hr_reporting_lines"."id" in ($3))',
    );
    expect(close.params).toEqual([YESTERDAY, ORG, 502]);
    expect(close.sql).not.toContain("manager_employment_id");

    const insert = onlyStatementOn(captured, 'insert into "hr_reporting_lines"');
    expect(insert.sql.match(/\(default, \$/g)).toHaveLength(2);
    expect(insert.params).toEqual([
      ORG, 102, MANAGER_EMPLOYMENT, "primary", TODAY, "actor-1",
      ORG, 103, MANAGER_EMPLOYMENT, "primary", TODAY, "actor-1",
    ]);
  });

  it("returns the hand-computed outcome for every reportee in a mixed batch", async () => {
    const { db } = makeDb(MIXED);

    const outcomes = await syncCanonicalReportingLines(
      db,
      ORG,
      MIXED_SUBJECTS,
      MANAGER_USER,
      TODAY,
      "actor-1",
    );

    expect([...outcomes.entries()]).toEqual([
      ["u-none", { status: "unmappable", reason: "employment-missing" }],
      [MANAGER_USER, { status: "unmappable", reason: "self-reference" }],
      [
        "u-same",
        { status: "unchanged", employmentId: 101, managerEmploymentId: MANAGER_EMPLOYMENT },
      ],
      [
        "u-change",
        { status: "written", employmentId: 102, managerEmploymentId: MANAGER_EMPLOYMENT },
      ],
      [
        "u-fresh",
        { status: "written", employmentId: 103, managerEmploymentId: MANAGER_EMPLOYMENT },
      ],
    ]);
  });

  it("issues six statements for two hundred reportees", async () => {
    const subjects = Array.from({ length: 200 }, (_unused, index) => `u-${index}`);
    const { db, captured } = makeDb({
      employments: subjects.map((userId, index) => [userId, index + 1]),
      membership: 55,
      managerEmploymentId: MANAGER_EMPLOYMENT,
      openLines: subjects.map((_unused, index) => [10_000 + index, index + 1, 800]),
    });

    await syncCanonicalReportingLines(db, ORG, subjects, MANAGER_USER, TODAY, "actor-1");

    expect(captured).toHaveLength(6);
    expect(statementsOn(captured, 'insert into "hr_reporting_lines"')).toHaveLength(1);
    expect(statementsOn(captured, 'update "hr_reporting_lines"')).toHaveLength(1);
  });

  it("writes nothing when every reportee already reports to that manager", async () => {
    const { db, captured } = makeDb({
      employments: [["u-same", 101]],
      membership: 55,
      managerEmploymentId: MANAGER_EMPLOYMENT,
      openLines: [[501, 101, MANAGER_EMPLOYMENT]],
    });

    const outcomes = await syncCanonicalReportingLines(
      db,
      ORG,
      ["u-same"],
      MANAGER_USER,
      TODAY,
      "actor-1",
    );

    expect(statementsOn(captured, 'update "hr_reporting_lines"')).toHaveLength(0);
    expect(statementsOn(captured, 'insert into "hr_reporting_lines"')).toHaveLength(0);
    expect(outcomes.get("u-same")).toEqual({
      status: "unchanged",
      employmentId: 101,
      managerEmploymentId: MANAGER_EMPLOYMENT,
    });
  });

  it("clears every open line in one UPDATE when the manager is removed", async () => {
    const { db, captured } = makeDb({
      employments: [["u-a", 101], ["u-b", 102]],
      membership: 55,
      managerEmploymentId: MANAGER_EMPLOYMENT,
      openLines: [],
    });

    const outcomes = await syncCanonicalReportingLines(
      db,
      ORG,
      ["u-a", "u-b"],
      null,
      TODAY,
      "actor-1",
    );

    const close = onlyStatementOn(captured, 'update "hr_reporting_lines"');
    expect(close.sql).toBe(
      'update "hr_reporting_lines" set "effective_to" = $1 where ("hr_reporting_lines"."org_id" = $2 and "hr_reporting_lines"."employment_id" in ($3, $4) and "hr_reporting_lines"."line_type" = $5 and "hr_reporting_lines"."effective_to" = \'infinity\'::date)',
    );
    expect(close.params).toEqual([YESTERDAY, ORG, 101, 102, "primary"]);
    expect(statementsOn(captured, 'from "organization_members"')).toHaveLength(0);
    expect(outcomes.get("u-a")).toEqual({ status: "cleared", employmentId: 101 });
    expect(outcomes.get("u-b")).toEqual({ status: "cleared", employmentId: 102 });
  });

  it("marks every reportee unmappable and writes nothing when the manager is not a member", async () => {
    const { db, captured } = makeDb({
      employments: [["u-a", 101]],
      membership: null,
      managerEmploymentId: null,
      openLines: [],
    });

    const outcomes = await syncCanonicalReportingLines(
      db,
      ORG,
      ["u-a"],
      MANAGER_USER,
      TODAY,
      "actor-1",
    );

    expect(outcomes.get("u-a")).toEqual({
      status: "unmappable",
      reason: "manager-not-in-organization",
    });
    expect(statementsOn(captured, 'update "hr_reporting_lines"')).toHaveLength(0);
    expect(statementsOn(captured, 'insert into "hr_reporting_lines"')).toHaveLength(0);
  });

  it("marks every reportee unmappable when the manager has no employment", async () => {
    const { db } = makeDb({
      employments: [["u-a", 101]],
      membership: 55,
      managerEmploymentId: null,
      openLines: [],
    });

    const outcomes = await syncCanonicalReportingLines(
      db,
      ORG,
      ["u-a"],
      MANAGER_USER,
      TODAY,
      "actor-1",
    );

    expect(outcomes.get("u-a")).toEqual({
      status: "unmappable",
      reason: "manager-has-no-employment",
    });
  });

  it("touches nothing when no reportee resolves to an employment", async () => {
    const { db, captured } = makeDb({
      employments: [],
      membership: 55,
      managerEmploymentId: MANAGER_EMPLOYMENT,
      openLines: [],
    });

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

describe("syncCanonicalReportingLine", () => {
  it("returns the singular outcome the batched form computed for that one user", async () => {
    const { db } = makeDb(MIXED);

    const outcome: ReportingLineOutcome = await syncCanonicalReportingLine(
      db,
      ORG,
      "u-change",
      MANAGER_USER,
      TODAY,
      "actor-1",
    );

    expect(outcome).toEqual({
      status: "written",
      employmentId: 102,
      managerEmploymentId: MANAGER_EMPLOYMENT,
    });
  });

  it("still closes the open line before inserting the replacement", async () => {
    const { db, captured } = makeDb(MIXED);

    await syncCanonicalReportingLine(db, ORG, "u-change", MANAGER_USER, TODAY, "actor-1");

    const close = onlyStatementOn(captured, 'update "hr_reporting_lines"');
    expect(close.params).toEqual([YESTERDAY, ORG, 502]);
    const insert = onlyStatementOn(captured, 'insert into "hr_reporting_lines"');
    expect(insert.params).toEqual([
      ORG,
      102,
      MANAGER_EMPLOYMENT,
      "primary",
      TODAY,
      "actor-1",
    ]);
    expect(captured.indexOf(close)).toBeLessThan(captured.indexOf(insert));
  });
});
