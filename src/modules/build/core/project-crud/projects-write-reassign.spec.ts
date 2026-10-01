import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ProjectsWriteService } from "./projects-write.service";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { MANAGER_STANDING, projectAccessRow, standingAccess } from "./__tests__/project-access-doubles";

const dialect = new PgDialect();
const ORG = "org-pw-1";

const EXISTING = [
  { userId: "keep-1", membershipId: 1 },
  { userId: "gone-1", membershipId: 2 },
  { userId: "gone-2", membershipId: 3 },
];
const VALID_MEMBERS = [{ id: 1, userId: "keep-1" }];
const OPEN_TICKETS = [
  { id: 10, assigneeUserId: "gone-1" },
  { id: 11, assigneeUserId: "gone-2" },
  { id: 12, assigneeUserId: null },
];

function thenable<T>(rows: T) {
  const chain: Record<string, unknown> = {};
  for (const key of ["from", "innerJoin", "where", "limit", "orderBy"])
    chain[key] = jest.fn().mockReturnValue(chain);
  chain["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

describe("ProjectsWriteService.updateProject — member removal reassignment", () => {
  function makeTx(captured: { statements: SQL[]; ticketUpdates: number }) {
    const select = jest
      .fn()
      .mockReturnValueOnce(thenable(EXISTING))
      .mockReturnValueOnce(thenable(VALID_MEMBERS))
      .mockReturnValueOnce(thenable(OPEN_TICKETS));

    const update = jest.fn().mockImplementation(() => {
      captured.ticketUpdates += 1;
      const chain: Record<string, unknown> = {};
      chain["set"] = jest.fn().mockReturnValue(chain);
      chain["where"] = jest.fn().mockResolvedValue(undefined);
      return chain;
    });

    return {
      select,
      update,
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      execute: jest.fn().mockImplementation((statement: SQL) => {
        captured.statements.push(statement);
        return Promise.resolve([]);
      }),
    };
  }

  function makeService(captured: { statements: SQL[]; ticketUpdates: number }) {
    const tx = makeTx(captured);
    const db = {
      transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
      select: jest.fn(() => thenable([projectAccessRow()])),
      query: { organizationMembers: { findFirst: jest.fn() } },
    } as unknown as Db;

    const service = new ProjectsWriteService(
      db,
      { log: jest.fn() } as never,
      standingAccess(MANAGER_STANDING) as never,
      { getProject: jest.fn().mockResolvedValue({ id: 5 }) } as never,
    );
    return { service, tx };
  }

  const user = { orgId: ORG, userId: "actor-1", isOrgOwner: true, principal: humanSessionPrincipal(9, true) } as CurrentUserContext;

  it("reassigns every ticket in ONE statement, not one per target assignee", async () => {
    const captured = { statements: [] as SQL[], ticketUpdates: 0 };
    const { service } = makeService(captured);

    await service.updateProject(user, 5, {
      memberIds: ["keep-1"],
      reassignments: { "gone-1": "keep-1" },
    } as never);

    // The defective shape grouped the tickets by target assignee and issued one
    // UPDATE per group — two here (keep-1 and unassigned). One statement is the fix.
    expect(captured.statements).toHaveLength(1);
    expect(captured.ticketUpdates).toBe(0);
  });

  it("keeps org_id in the reassignment WHERE and maps each ticket to its own assignee", async () => {
    const captured = { statements: [] as SQL[], ticketUpdates: 0 };
    const { service } = makeService(captured);

    await service.updateProject(user, 5, {
      memberIds: ["keep-1"],
      reassignments: { "gone-1": "keep-1" },
    } as never);

    const query = dialect.sqlToQuery(captured.statements[0] as SQL);
    expect(query.sql).toContain('"tickets"."org_id" =');
    expect(query.params).toContain(ORG);
    expect(query.params).toEqual(expect.arrayContaining([10, 11, 12, 1]));
  });
});
