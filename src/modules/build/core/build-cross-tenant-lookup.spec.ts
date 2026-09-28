import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ProjectsTicketsDeleteService } from "./tickets/projects-tickets-delete.service";
import { ProjectsActivityService } from "./activity/projects-activity.service";
import { assertTicketReadAccess } from "./tickets/build-ticket-read-access";

jest.mock("./tickets/build-ticket-read-access", () => ({
  assertTicketReadAccess: jest.fn(),
}));

/**
 * Two lookups that carried no organisation predicate, and one that was unbounded.
 *
 * **Neither missing predicate was an exploitable cross-tenant read, and this
 * file should not be read as claiming one.** Both lookups match on a globally
 * unique identity column reached through a composite `(org_id, id)` foreign
 * key, so a matching row already had to belong to the caller's organisation.
 * What they were is *unstated* — correctness resting on an invariant two tables
 * away rather than on the query, which is the shape that becomes a leak the
 * first time a caller passes ids from somewhere less constrained.
 *
 * The substantive defect is the other half: the delete guard's blocker lookup
 * had no limit, so a yes/no question loaded every blocker in the caller's
 * dependency graph.
 *
 * The proof is the bound parameter list — the organisation has to actually
 * reach the query, not merely be in scope at the call site.
 */

/** Pulls the literal values drizzle would bind, out of a where-clause tree. */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const OWNER_ORG = "org-owner";

function makeActor(orgId = OWNER_ORG): CurrentUserContext {
  return {
    userId: "member-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

describe("the delete guard's blocker lookup", () => {
  beforeEach(() => {
    jest.mocked(assertTicketReadAccess).mockResolvedValue();
  });

  function serviceWithBlockers(blockers: { workItemId: number }[]) {
    const findMany = jest.fn().mockResolvedValue(blockers);
    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue({ id: 7, projectId: 3, title: "t" }) },
        workItemRelations: { findMany },
      },
    } as unknown as Db;

    const service = new ProjectsTicketsDeleteService(
      db,
      {} as never,
      {} as never,
      { scopeFor: jest.fn(), resolveUserPermissions: jest.fn() },
    );

    return { service, findMany };
  }

  it("binds the caller's organisation into the blocker query", async () => {
    const { service, findMany } = serviceWithBlockers([{ workItemId: 9 }]);

    await expect(service.deleteTicket(makeActor(), 3, 7, false)).rejects.toThrow(
      ConflictException,
    );

    const where = (findMany.mock.calls[0]?.[0] as { where?: unknown }).where;
    expect(sqlValues(where)).toContain(OWNER_ORG);
  });

  /**
   * Bounded as well as scoped. Without a limit the guard materialises every
   * blocker a caller happens to have created, to answer a yes/no question.
   */
  it("caps how many blockers it reads", async () => {
    const { service, findMany } = serviceWithBlockers([{ workItemId: 9 }]);

    await expect(service.deleteTicket(makeActor(), 3, 7, false)).rejects.toThrow(
      ConflictException,
    );

    const args = findMany.mock.calls[0]?.[0] as { limit?: number };
    expect(typeof args.limit).toBe("number");
    expect(args.limit).toBeGreaterThan(0);
  });

  /**
   * At the cap the true count is unknown, so the message says so rather than
   * reporting the sentinel as if it were exact.
   */
  it("does not report the sentinel as an exact count", async () => {
    const atCap = Array.from({ length: 50 }, (_, i) => ({ workItemId: i }));
    const { service } = serviceWithBlockers(atCap);

    await expect(service.deleteTicket(makeActor(), 3, 7, false)).rejects.toThrow(/50\+/);
  });

  it("allows the delete when nothing blocks it (control)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const transaction = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue({ id: 7, projectId: 3, title: "t" }) },
        workItemRelations: { findMany },
      },
      transaction,
    } as unknown as Db;

    const service = new ProjectsTicketsDeleteService(
      db,
      { enqueue: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn(), delByPrefix: jest.fn() } as never,
      { scopeFor: jest.fn(), resolveUserPermissions: jest.fn() },
    );

    await service.deleteTicket(makeActor(), 3, 7, false).catch(() => undefined);

    expect(transaction).toHaveBeenCalled();
  });
});

describe("the activity feed's cycle-name lookup", () => {
  it("binds the organisation into the cycle lookup", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });

    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = {
      select,
      insert: () => ({ values: insertValues }),
      // resolveMembershipId reads through the same select chain.
      query: {},
    } as unknown as Db;

    const service = new ProjectsActivityService(db, {} as never, {} as never);

    const before = {
      title: "t",
      status: "TODO",
      priority: "MEDIUM",
      assigneeId: null,
      sprintId: null,
      dueDate: null,
      points: null,
      type: "TASK",
      cycleId: 1,
    };

    await service
      .logTicketFieldChanges(OWNER_ORG, 7, "user-1", before, { cycleId: 2 })
      .catch(() => undefined);

    /**
     * Identified by the cycle ids, not by the org.
     *
     * `resolveMembershipId` runs first and binds the same organisation, so
     * "some query mentioned the org" passes with or without the fix — it was
     * vacuous as first written. The cycle lookup is the one binding the id
     * pair, and the assertion is that *that* query also carries the org.
     */
    const bound = where.mock.calls.map((call) => sqlValues(call[0]));
    const cycleQuery = bound.find((values) => values.includes(1) && values.includes(2));

    expect(cycleQuery).toBeDefined();
    expect(cycleQuery).toContain(OWNER_ORG);
  });
});
