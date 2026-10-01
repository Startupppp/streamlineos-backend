import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { decodeCursor } from "../../../../common/pagination/cursor";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { ticketsListQuerySchema } from "../dto/projects.schemas";
import { projectAccessRow } from "../project-crud/__tests__/project-access-doubles";

const preciseTimestamp = "2026-09-09 00:00:00.123456+00";
const actor: CurrentUserContext = {
  orgId: "org", userId: "member", role: "MEMBER", isOrgOwner: true,
  sessionId: "session", tokenScopes: null, principal: humanSessionPrincipal(1, true),
};

describe("ticket cursor timestamp precision", () => {
  it("preserves all PostgreSQL microseconds from projection through the next-page predicate", async () => {
    const rows = [1, 2].map((id) => ({ id, rank: "1000", createdAt: new Date(preciseTimestamp),
      cursorPrimary: new Date(preciseTimestamp), cursorPrimaryText: preciseTimestamp, cursorCreatedAt: preciseTimestamp,
    }));
    const where = jest.fn((predicate: SQL | undefined) => {
      if (predicate) predicates.push(predicate);
      return {
        orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue(rows) })),
        limit: jest.fn().mockResolvedValue([projectAccessRow()]),
      };
    });
    const predicates: SQL[] = [];
    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })),
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
        tickets: { findMany: jest.fn().mockResolvedValue([{ id: 1, assignee: null, assignees: [] }]) },
      },
    };
    const module = await Test.createTestingModule({ providers: [ProjectsTicketsReadService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: { scopeFor: jest.fn().mockResolvedValue("all"), resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["build:manage", "all"]])) } },
    ] }).compile();
    try {
      const service = module.get(ProjectsTicketsReadService);
      const first = await service.listTickets(actor, 10, ticketsListQuerySchema.parse({ limit: 1, orderBy: "created", orderDir: "desc" }));
      const cursor = first.pagination.nextCursor;
      if (!cursor) throw new Error("Missing next-page cursor");
      expect(decodeCursor(cursor)?.sortValue).toBe(JSON.stringify({ primary: preciseTimestamp, createdAt: preciseTimestamp }));
      await service.listTickets(actor, 10, ticketsListQuerySchema.parse({ limit: 1, orderBy: "created", orderDir: "desc", cursor }));
      const last = predicates[predicates.length - 1];
      if (!last) throw new Error("Missing cursor predicate");
      expect(new PgDialect().sqlToQuery(last).params).toContain(preciseTimestamp);
    } finally { await module.close(); }
  });
});
