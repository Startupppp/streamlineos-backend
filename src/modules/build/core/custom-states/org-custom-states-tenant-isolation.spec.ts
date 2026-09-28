import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ProjectsCustomStatesService } from "./projects-custom-states.service";
import type { Db } from "../../../../db/drizzle.module";

const ORG_A = "org-a-uuid";
const ORG_B = "org-b-uuid";

function makeSelectChain(
  rows: Array<{ name: string; color: string | null; type: string | null }>,
) {
  let capturedJoinCondition: SQL | undefined;
  let capturedWhereCondition: SQL | undefined;

  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const groupBy = jest.fn().mockReturnValue({ orderBy });
  const where = jest.fn().mockImplementation((cond: SQL) => {
    capturedWhereCondition = cond;
    return { groupBy };
  });
  const innerJoin = jest.fn().mockImplementation((_table: unknown, cond: SQL) => {
    capturedJoinCondition = cond;
    return { where };
  });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const db = {
    select: jest.fn().mockReturnValue({ from }),
  } as unknown as Db;

  return {
    db,
    getCapturedJoin: () => capturedJoinCondition,
    getCapturedWhere: () => capturedWhereCondition,
  };
}

const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) };

describe("ProjectsCustomStatesService.listOrgCustomStates — tenant isolation", () => {
  it("binds the WHERE clause to the requesting org and not to any other org", async () => {
    const { db, getCapturedWhere } = makeSelectChain([]);
    const svc = new ProjectsCustomStatesService(db, access as never);

    await svc.listOrgCustomStates(ORG_A);

    const whereSQL = getCapturedWhere();
    expect(whereSQL).toBeDefined();
    const { params } = new PgDialect().sqlToQuery(whereSQL!);
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(ORG_B);
  });

  it("joins to the projects table with a deleted_at IS NULL guard to exclude soft-deleted projects", async () => {
    const { db, getCapturedJoin } = makeSelectChain([]);
    const svc = new ProjectsCustomStatesService(db, access as never);

    await svc.listOrgCustomStates(ORG_A);

    const joinSQL = getCapturedJoin();
    expect(joinSQL).toBeDefined();
    const { sql: sqlStr, params } = new PgDialect().sqlToQuery(joinSQL!);
    expect(sqlStr).toMatch(/deleted_at/);
    expect(params).toContain(ORG_A);
  });

  it("returns whatever rows the database provides for the requesting org", async () => {
    const rows = [
      { name: "CODE REVIEW", color: "#00ff00", type: "started" },
      { name: "BLOCKED", color: "#ff0000", type: "started" },
    ];
    const { db } = makeSelectChain(rows);
    const svc = new ProjectsCustomStatesService(db, access as never);

    const result = await svc.listOrgCustomStates(ORG_A);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: "CODE REVIEW" });
    expect(result[1]).toMatchObject({ name: "BLOCKED" });
  });

  it("makes a single DB call with a GROUP BY so the database de-duplicates by name across projects", async () => {
    const deduplicatedRows = [
      { name: "IN_REVIEW", color: null, type: "started" },
    ];
    const { db } = makeSelectChain(deduplicatedRows);
    const svc = new ProjectsCustomStatesService(db, access as never);

    const result = await svc.listOrgCustomStates(ORG_A);

    expect((db.select as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("IN_REVIEW");
  });
});
