import type { Db } from "../../../db/drizzle.module";
import { ProgramsService } from "./programs.service";
import type { AuditService } from "../../../common/audit/audit.service";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

const mockAudit = {} as AuditService;
const ORG = "org-programs-search";

interface Captured {
  where: unknown;
}

function makeDb(captured: Captured, executeResult: unknown[]): Db {
  const builder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  return {
    select: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue(executeResult),
  } as unknown as Db;
}

describe("ProgramsService.listPrograms — search predicate (BE-49, BE-80)", () => {
  it("uses inArray of IDs returned by the SECURITY DEFINER function so the FTS index is exercised rather than a leading-wildcard ILIKE (BE-80)", async () => {
    const captured: Captured = { where: undefined };
    const db = makeDb(captured, [{ id: "42" }, { id: "77" }]);
    const svc = new ProgramsService(db, mockAudit);
    await svc.listPrograms(ORG, { limit: 20, sort: "createdAt", order: "desc", q: "product-launch" });
    const { sql: rendered, params } = dialect.sqlToQuery(
      captured.where as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(rendered).toContain('"id"');
    expect(params).toContain(42);
    expect(params).toContain(77);
  });

  it("keeps orgId in WHERE alongside the search condition so programs from another org cannot be returned", async () => {
    const captured: Captured = { where: undefined };
    const db = makeDb(captured, [{ id: "10" }]);
    const svc = new ProgramsService(db, mockAudit);
    await svc.listPrograms(ORG, { limit: 20, sort: "createdAt", order: "desc", q: "product-launch" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(params).toContain(ORG);
  });

  it("omits a search condition when q is absent so all org programs are returned without a false filter", async () => {
    const captured: Captured = { where: undefined };
    const db = makeDb(captured, []);
    const svc = new ProgramsService(db, mockAudit);
    await svc.listPrograms(ORG, { limit: 20, sort: "createdAt", order: "desc" });
    const { sql: rendered } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(rendered).not.toContain("ilike");
    expect(rendered).not.toContain("search_project_program_ids");
  });
});
