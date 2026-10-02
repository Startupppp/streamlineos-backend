import { PgDialect } from "drizzle-orm/pg-core";
import { EpicsService } from "./epics.service";
import type { BuildTicketCreationService, ProjectsTicketsUpdateService } from "../core/tickets";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

interface Captured {
  where: unknown;
}

function buildDb(captured: Captured) {
  const findMany = jest.fn().mockImplementation((args: { where?: unknown }) => {
    captured.where = args.where;
    return Promise.resolve([]);
  });
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      tickets: { findMany },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  } as unknown as Db;
}

describe("EpicsService.listEpics — search predicate shape (BE-49)", () => {
  it("uses full-text search so mid-title matches are found, not just prefix matches", async () => {
    const captured: Captured = { where: undefined };
    const svc = new EpicsService(buildDb(captured), {} as unknown as BuildTicketCreationService, {} as unknown as ProjectsTicketsUpdateService, {} as unknown as AuditService);
    await svc.listEpics("org-1", 1, { q: "checkout" });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("to_tsvector");
    expect(sql.toLowerCase()).toContain("plainto_tsquery");
  });

  it("places the search term directly in params without a wildcard suffix", async () => {
    const captured: Captured = { where: undefined };
    const svc = new EpicsService(buildDb(captured), {} as unknown as BuildTicketCreationService, {} as unknown as ProjectsTicketsUpdateService, {} as unknown as AuditService);
    await svc.listEpics("org-1", 1, { q: "checkout" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(params).toContain("checkout");
    expect(params.every((p) => typeof p !== "string" || !p.includes("%"))).toBe(true);
  });

  it("omits the fts predicate when no q is given so all epics in the project are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new EpicsService(buildDb(captured), {} as unknown as BuildTicketCreationService, {} as unknown as ProjectsTicketsUpdateService, {} as unknown as AuditService);
    await svc.listEpics("org-1", 1, {});
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("plainto_tsquery");
  });
});
