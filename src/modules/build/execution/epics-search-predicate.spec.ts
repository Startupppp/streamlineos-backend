import { PgDialect } from "drizzle-orm/pg-core";
import { EpicsService } from "./epics.service";
import type { BuildTicketCreationService, ProjectsTicketsUpdateService, ProjectsTicketsDeleteService } from "../core/tickets";
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
  it("uses a trailing-wildcard pattern, not a leading wildcard, so the epic title column can use a prefix index rather than a full scan over the project's epic rows", async () => {
    const captured: Captured = { where: undefined };
    const svc = new EpicsService(buildDb(captured), {} as unknown as BuildTicketCreationService, {} as unknown as ProjectsTicketsUpdateService, {} as unknown as ProjectsTicketsDeleteService);
    await svc.listEpics("org-1", 1, { q: "checkout" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => !p.startsWith("%"))).toBe(true);
  });

  it("appends a trailing % so a search for 'checkout' finds 'Checkout flow redesign' — the title begins with the typed term", async () => {
    const captured: Captured = { where: undefined };
    const svc = new EpicsService(buildDb(captured), {} as unknown as BuildTicketCreationService, {} as unknown as ProjectsTicketsUpdateService, {} as unknown as ProjectsTicketsDeleteService);
    await svc.listEpics("org-1", 1, { q: "checkout" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBe("checkout%");
  });

  it("omits the ilike predicate when no q is given so all epics in the project are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new EpicsService(buildDb(captured), {} as unknown as BuildTicketCreationService, {} as unknown as ProjectsTicketsUpdateService, {} as unknown as ProjectsTicketsDeleteService);
    await svc.listEpics("org-1", 1, {});
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
