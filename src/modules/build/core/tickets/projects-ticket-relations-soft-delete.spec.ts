import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTicketRelationsService } from "./projects-ticket-relations.service";

jest.mock("../project-crud/project-access", () => ({
  assertTicketReadAccess: jest.fn().mockResolvedValue(undefined),
}));

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL).sql;

const u = { orgId: "org-1", userId: "user-1" } as unknown as CurrentUserContext;
const access = {} as never;

function ticketRow(id: number) {
  return {
    id,
    title: `T-${id}`,
    ticketNumber: id,
    status: "open",
    priority: "medium",
    type: "task",
    points: null,
    version: 1,
    assigneeMembershipId: null,
    projectId: 1,
    assignee: null,
    project: { key: "AAA" },
  };
}

function makeListDb(rows: unknown[]) {
  const captured: { config?: Record<string, unknown> } = {};
  const findMany = jest.fn().mockImplementation((config: Record<string, unknown>) => {
    captured.config = config;
    return Promise.resolve(rows);
  });
  return {
    db: { query: { workItemRelations: { findMany } } } as unknown as Db,
    captured,
  };
}

describe("ProjectsTicketRelationsService — soft-delete filtering (BE-50)", () => {
  it("both relation endpoints carry an isNull(deletedAt) predicate on the joined ticket", async () => {
    const { db, captured } = makeListDb([]);
    const svc = new ProjectsTicketRelationsService(db, access);

    await svc.listRelations(u, 1, 7);

    const withConfig = captured.config!["with"] as Record<
      string,
      { where?: unknown }
    >;
    expect(withConfig["workItem"].where).toBeDefined();
    expect(withConfig["relatedWorkItem"].where).toBeDefined();
    expect(render(withConfig["workItem"].where)).toBe(
      '"build"."tickets"."deleted_at" is null',
    );
    expect(render(withConfig["relatedWorkItem"].where)).toBe(
      '"build"."tickets"."deleted_at" is null',
    );
  });

  it("a relation whose endpoint the lateral filtered out is dropped, not projected into the panel", async () => {
    const { db } = makeListDb([
      {
        id: 10,
        workItemId: 7,
        relatedWorkItemId: 8,
        relationType: "relates_to",
        workItem: ticketRow(7),
        relatedWorkItem: ticketRow(8),
      },
      {
        id: 11,
        workItemId: 7,
        relatedWorkItemId: 9,
        relationType: "blocks",
        workItem: ticketRow(7),
        relatedWorkItem: null,
      },
      {
        id: 12,
        workItemId: 9,
        relatedWorkItemId: 7,
        relationType: "blocks",
        workItem: null,
        relatedWorkItem: ticketRow(7),
      },
    ]);
    const svc = new ProjectsTicketRelationsService(db, access);

    const out = await svc.listRelations(u, 1, 7);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(10);
    expect(out.map((r) => r.relatedTicket.id)).not.toContain(9);
  });

  it("the blocking-cycle edge scan joins only live tickets", async () => {
    const joinConds: unknown[] = [];
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockImplementation((_table, cond) => {
      joinConds.push(cond);
      return { where };
    });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const returning = jest.fn().mockResolvedValue([{ id: 99 }]);
    const tx = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({ returning }),
        }),
      }),
    };
    const db = {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue({ id: 8 }) } },
      select: jest.fn().mockReturnValue({ from }),
      transaction: jest
        .fn()
        .mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Db;
    const svc = new ProjectsTicketRelationsService(db, access);

    await svc.addRelation(u, 1, 7, {
      relatedTicketId: 8,
      relationType: "blocks",
    } as never);

    expect(joinConds).toHaveLength(1);
    expect(render(joinConds[0])).toContain('"build"."tickets"."deleted_at" is null');
  });
});
