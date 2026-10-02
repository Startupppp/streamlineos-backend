import { PgDialect } from "drizzle-orm/pg-core";
import { eq, or, sql } from "drizzle-orm";
import { projects, tickets } from "../../../../db/schema";
import { ProjectsWorkQueryService } from "./projects-work-query.service";
import type { AccessService } from "../../../access/access.service";
import { MEMBER_STANDING, principalAccess } from "../../__tests__/project-access-doubles";

const memberAccess = () => principalAccess(MEMBER_STANDING) as unknown as AccessService;
import type { Db } from "../../../../db/drizzle.module";
import type { AllWorkQuery } from "../dto/projects.schemas";

const dialect = new PgDialect();

function render(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

function makeSearchQuery(search: string): AllWorkQuery {
  return {
    limit: 25,
    orderBy: "rank",
    scope: "all",
    search,
  } as AllWorkQuery;
}

function makeUser(orgId: string) {
  return {
    orgId,
    userId: "u1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: false },
  };
}

function makeMockedDb(): { db: Db; capturedTicketWhere: jest.Mock } {
  const capturedTicketWhere = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
  });

  const countWhere = jest.fn().mockResolvedValue([{ total: "0" }]);

  const db = {
    select: jest.fn()
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              leftJoin: jest.fn().mockReturnValue({
                where: capturedTicketWhere,
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: countWhere,
          }),
        }),
      }),
  } as unknown as Db;

  return { db, capturedTicketWhere };
}

const ORG = "org-test";

describe("ProjectsWorkQueryService — ticket-reference search (STRE-157)", () => {
  it(
    "searching STRE-147 binds projects.key = STRE alongside ticket_number so WEB-147 cannot match",
    async () => {
      const { db, capturedTicketWhere } = makeMockedDb();
      await new ProjectsWorkQueryService(db, memberAccess()).getAllWork(makeUser(ORG), makeSearchQuery("STRE-147"));
      const { sql: text, params } = render(capturedTicketWhere.mock.calls[0]?.[0]);
      expect(text).toContain('"key"');
      expect(params).toContain("STRE");
      expect(params).toContain(147);
    },
  );

  it(
    "searching bare 147 does not bind a project key, so the number search spans all allowed projects",
    async () => {
      const { db, capturedTicketWhere } = makeMockedDb();
      await new ProjectsWorkQueryService(db, memberAccess()).getAllWork(makeUser(ORG), makeSearchQuery("147"));
      const { sql: text, params } = render(capturedTicketWhere.mock.calls[0]?.[0]);
      expect(text).not.toContain('"key"');
      expect(params).toContain(147);
    },
  );

  it(
    "searching STRE-147 keeps the title ILIKE fallback so a ticket titled literally STRE-147 is still found",
    async () => {
      const { db, capturedTicketWhere } = makeMockedDb();
      await new ProjectsWorkQueryService(db, memberAccess()).getAllWork(makeUser(ORG), makeSearchQuery("STRE-147"));
      const { sql: text, params } = render(capturedTicketWhere.mock.calls[0]?.[0]);
      expect(text).toContain("ILIKE");
      expect(params).toContain("%STRE-147%");
    },
  );

  it(
    "searching bare #147 keeps the title ILIKE fallback so a ticket with 147 in the title is still found",
    async () => {
      const { db, capturedTicketWhere } = makeMockedDb();
      await new ProjectsWorkQueryService(db, memberAccess()).getAllWork(makeUser(ORG), makeSearchQuery("#147"));
      const { sql: text, params } = render(capturedTicketWhere.mock.calls[0]?.[0]);
      expect(text).toContain("ILIKE");
      expect(params).toContain("%#147%");
    },
  );

  it(
    "bite proof — the pre-fix number-only condition matches ticket_number without constraining projects.key, which is the defect STRE-157 closes",
    () => {
      const preFixCondition = or(
        sql`${tickets.title} ILIKE ${"%" + "STRE-147" + "%"}`,
        eq(tickets.ticketNumber, 147),
      );
      const { sql: text, params } = render(preFixCondition);
      expect(text).not.toContain('"key"');
      expect(params).toContain(147);
      expect(params).not.toContain("STRE");
    },
  );
});
