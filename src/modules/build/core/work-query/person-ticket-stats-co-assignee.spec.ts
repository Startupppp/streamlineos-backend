import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsWorkQueryService } from "./projects-work-query.service";
import type { Db } from "../../../../db/drizzle.module";

const ORG_ID = "org-r7";
const CALLER_USER_ID = "user-caller";
const CALLER_MEMBERSHIP_ID = 1;
const SUBJECT_USER_ID = "user-priya";

const dialect = new PgDialect();

function renderSql(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

function makeCaller() {
  return {
    orgId: ORG_ID,
    userId: CALLER_USER_ID,
    role: "MEMBER" as const,
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: false },
  };
}

type GroupedRow = {
  projectId: number | null;
  projectName: string;
  status: string;
  cnt: string;
};

function makeDbMock(options: {
  executeRows?: Record<string, unknown>[];
  groupedRows?: GroupedRow[];
}) {
  const executedStatements: unknown[] = [];
  const groupedWheres: unknown[] = [];

  const groupBy = jest.fn().mockResolvedValue(options.groupedRows ?? []);
  const groupedWhere = jest.fn().mockImplementation((where: unknown) => {
    groupedWheres.push(where);
    return { groupBy };
  });
  const groupedInnerJoin = jest.fn().mockReturnValue({ where: groupedWhere });
  const groupedFrom = jest.fn().mockReturnValue({ innerJoin: groupedInnerJoin });

  const select = jest.fn().mockReturnValue({ from: groupedFrom });

  const execute = jest.fn().mockImplementation((statement: unknown) => {
    executedStatements.push(statement);
    return Promise.resolve(options.executeRows ?? []);
  });

  const db = { select, execute } as unknown as Db;
  return { db, executedStatements, groupedWheres, select, execute, groupBy };
}

async function runPersonStats(
  mock: ReturnType<typeof makeDbMock>,
  opts: { assigneeId?: string; projectIds?: number[] },
) {
  const service = new ProjectsWorkQueryService(mock.db);
  return service.countTicketsByProjectAndStatus(makeCaller(), opts);
}

describe("getPersonTicketStats — countTicketsByProjectAndStatus covers co-assignees", () => {
  it("consults the ticket_assignees link table, so a ticket the subject is a co-assignee of is not omitted from their count", async () => {
    const mock = makeDbMock({});

    await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID });

    const rendered = mock.executedStatements.map(renderSql);
    expect(rendered.some((statement) => statement.sql.includes("ticket_assignees"))).toBe(true);
  });

  it("counts a ticket the subject is both primary assignee and a ticket_assignees row of exactly once, by UNION set semantics rather than UNION ALL", async () => {
    const mock = makeDbMock({});

    await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID });

    const rendered = mock.executedStatements.map((statement) => renderSql(statement).sql);
    const personStatement = rendered.find((statement) => statement.includes("ticket_assignees"));
    expect(personStatement).toBeDefined();
    const upper = (personStatement ?? "").toUpperCase();
    expect(upper).toContain("UNION");
    expect(upper).not.toContain("UNION ALL");
  });

  it("deduplicates on the ticket id, so the two branches cannot both contribute a row for one ticket", async () => {
    const mock = makeDbMock({});

    await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID });

    const personStatement = mock.executedStatements
      .map((statement) => renderSql(statement).sql)
      .find((statement) => statement.includes("ticket_assignees"));
    const branchProjections =
      (personStatement ?? "").match(/select\s+(?:"\w+"\.)?"tickets"\."id" as id/gi) ?? [];
    expect(branchProjections).toHaveLength(2);
    expect(personStatement).toMatch(/count\(\*\)/i);
  });

  it("applies the caller's project-membership bound to the co-assigned branch too, so a co-assignment cannot expose a ticket in a project the caller cannot see", async () => {
    const mock = makeDbMock({});

    await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID, projectIds: [7, 99] });

    const rendered = mock.executedStatements.map(renderSql);
    const personStatement = rendered.find((statement) => statement.sql.includes("ticket_assignees"));
    expect(personStatement).toBeDefined();
    const reachabilityOccurrences =
      (personStatement?.sql ?? "").toLowerCase().split("manager_membership_id").length - 1;
    expect(reachabilityOccurrences).toBe(2);
    expect(personStatement?.params).toContain(CALLER_MEMBERSHIP_ID);
  });

  it("carries the soft-delete and archived-project exclusions onto both branches, so a co-assigned deleted ticket is not counted", async () => {
    const mock = makeDbMock({});

    await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID });

    const personStatement = mock.executedStatements
      .map(renderSql)
      .find((statement) => statement.sql.includes("ticket_assignees"));
    const deletedAtPredicates = (personStatement?.sql ?? "").match(/"deleted_at" is null/gi) ?? [];
    expect(deletedAtPredicates).toHaveLength(2);
    expect(personStatement?.params.filter((param) => param === "ARCHIVED")).toHaveLength(2);
  });

  it("binds the subject user id as a parameter on both branches rather than inlining it, so neither branch can widen to the whole organisation", async () => {
    const mock = makeDbMock({});

    await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID });

    const personStatement = mock.executedStatements
      .map(renderSql)
      .find((statement) => statement.sql.includes("ticket_assignees"));
    expect(personStatement?.params.filter((param) => param === SUBJECT_USER_ID)).toHaveLength(2);
    expect(personStatement?.sql).not.toContain(SUBJECT_USER_ID);
    expect(personStatement?.params.filter((param) => param === ORG_ID).length).toBeGreaterThanOrEqual(2);
  });

  it("aggregates the deduplicated union rows into per-project totals, converting the raw count text at the use site", async () => {
    const mock = makeDbMock({
      executeRows: [
        { project_id: 10, project_name: "Alpha", status: "DONE", cnt: "3" },
        { project_id: 10, project_name: "Alpha", status: "IN_PROGRESS", cnt: "2" },
        { project_id: 20, project_name: "Beta", status: "IN_REVIEW", cnt: "1" },
      ],
    });

    const result = await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID });

    expect(result.byProject).toEqual([
      { projectId: 10, projectName: "Alpha", total: 5, done: 3, inProgress: 2 },
      { projectId: 20, projectName: "Beta", total: 1, done: 0, inProgress: 1 },
    ]);
    expect(result.totals).toEqual({ total: 6, done: 3, inProgress: 3 });
  });

  it("returns zero totals when the caller belongs to no projects, with the reachability predicate enforcing the scope in SQL so a co-assignment grants no visibility of its own", async () => {
    const mock = makeDbMock({});

    const result = await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID });

    expect(result).toEqual({ byProject: [], totals: { total: 0, done: 0, inProgress: 0 } });
    const personStatement = mock.executedStatements
      .map(renderSql)
      .find((s) => s.sql.includes("ticket_assignees"));
    expect(personStatement).toBeDefined();
    expect(personStatement?.sql.toLowerCase()).toContain("project_members");
    expect(personStatement?.params).toContain(CALLER_MEMBERSHIP_ID);
  });

  it("returns zero totals when the requested project is outside the caller's membership, with the reachability predicate enforcing the bound in SQL", async () => {
    const mock = makeDbMock({});

    const result = await runPersonStats(mock, { assigneeId: SUBJECT_USER_ID, projectIds: [99] });

    expect(result).toEqual({ byProject: [], totals: { total: 0, done: 0, inProgress: 0 } });
    const personStatement = mock.executedStatements
      .map(renderSql)
      .find((s) => s.sql.includes("ticket_assignees"));
    expect(personStatement).toBeDefined();
    expect(personStatement?.sql.toLowerCase()).toContain("project_members");
    expect(personStatement?.params).toContain(CALLER_MEMBERSHIP_ID);
  });

  it("keeps the single-pass grouped scan when no subject is named, because an unfiltered union would deduplicate every ticket for nothing", async () => {
    const mock = makeDbMock({
      groupedRows: [{ projectId: 10, projectName: "Alpha", status: "DONE", cnt: "4" }],
    });

    const result = await runPersonStats(mock, {});

    expect(mock.execute).not.toHaveBeenCalled();
    expect(mock.groupBy).toHaveBeenCalledTimes(1);
    expect(result.totals).toEqual({ total: 4, done: 4, inProgress: 0 });
  });
});
