import { PgDialect } from "drizzle-orm/pg-core";
import { EpicsService } from "./epics.service";
import type { BuildTicketCreationService, ProjectsTicketsDeleteService, ProjectsTicketsUpdateService } from "../core/tickets";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import { principalAccess, projectAccessRow } from "../__tests__/project-access-doubles";

const owner: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, true),
};

function epicsService(db: Db): EpicsService {
  return new EpicsService(
    db,
    stubService<BuildTicketCreationService>({}),
    stubService<ProjectsTicketsUpdateService>({}),
    stubService<ProjectsTicketsDeleteService>({}),
    stubService<AccessService>(principalAccess()),
  );
}

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
    select: jest.fn((projection: Record<string, unknown> = {}) =>
      "manages" in projection
        ? { from: () => ({ where: () => ({ limit: async () => [projectAccessRow()] }) }) }
        : { from: () => ({ where: async () => [] }) },
    ),
  } as unknown as Db;
}

describe("EpicsService.listEpics — search predicate shape (BE-49)", () => {
  it("uses full-text search so mid-title matches are found, not just prefix matches", async () => {
    const captured: Captured = { where: undefined };
    const svc = epicsService(buildDb(captured));
    await svc.listEpics(owner, 1, { q: "checkout" });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("to_tsvector");
    expect(sql.toLowerCase()).toContain("plainto_tsquery");
  });

  it("places the search term directly in params without a wildcard suffix", async () => {
    const captured: Captured = { where: undefined };
    const svc = epicsService(buildDb(captured));
    await svc.listEpics(owner, 1, { q: "checkout" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(params).toContain("checkout");
    expect(params.every((p) => typeof p !== "string" || !p.includes("%"))).toBe(true);
  });

  it("omits the fts predicate when no q is given so all epics in the project are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = epicsService(buildDb(captured));
    await svc.listEpics(owner, 1, {});
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("plainto_tsquery");
  });
});
