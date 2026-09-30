import type { Db } from "../../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { ApplyTicketChangeDeps } from "./apply-ticket-change";
import { applyTicketChange } from "./apply-ticket-change";
import { bulkMutateTickets } from "./build-ticket-bulk-mutation";
import { rankTicket } from "./projects-tickets-rank-utils";
import type { TicketChangeEffectDeps } from "./ticket-change-effects";
import type { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import type { ProjectsActivityService } from "../activity/projects-activity.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";

jest.mock("../project-crud/project-access", () => ({
  authorizeTicketMutation: jest.fn().mockResolvedValue({ role: "MEMBER", predicate: {} }),
  lockProjectTicketMutation: jest.fn().mockResolvedValue(undefined),
  readMutationTickets: jest.fn().mockImplementation(
    (_db: unknown, _actor: unknown, _projectId: unknown, ids: number[]) =>
      Promise.resolve(
        ids.map((id) => ({
          id,
          status: "TODO",
          rank: String(id * 1000),
          version: 1,
          assigneeMembershipId: null,
          dueDate: null,
          priority: "MEDIUM",
          points: null,
          epicId: null,
          cycleId: null,
          allowed: true,
        })),
      ),
  ),
}));

jest.mock("../project-crud/project-access", () => ({
  resolveProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" }),
  resolveProjectAssignableMemberships: jest
    .fn()
    .mockResolvedValue(new Map([["assignee-2", 7]])),
}));

jest.mock("./build-ticket-batch-workflow", () => ({
  validateBatchTransition: jest.fn().mockResolvedValue(undefined),
  emitBatchStatusChanges: jest.fn().mockResolvedValue(undefined),
}));

const ORG = "org-effect-parity";
const TICKET_ID = 1;
const PROJECT_ID = 1;
const TITLE = "Ticket";

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "actor-1",
  isOrgOwner: true,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
} as never;

type ActivityDouble = Pick<ProjectsActivityService, "logTicketFieldChanges">;
type DispatchDouble = Pick<NotificationDispatchService, "emit">;
type TransferDouble = Pick<ProjectsTicketsTransferService, "notifyAssignedTickets">;

interface Sink {
  readonly effects: string[];
  readonly assignmentRequests: string[];
}

function makeSink(): Sink {
  return { effects: [], assignmentRequests: [] };
}

function makeActivity(sink: Sink): ActivityDouble {
  return {
    logTicketFieldChanges: jest.fn().mockImplementation(
      async (
        _orgId: string,
        ticketId: number,
        _userId: string,
        before: { status: string },
        changes: { status?: string },
      ) => {
        sink.effects.push(
          `activity:${ticketId}:${before.status}->${changes.status ?? "-"}`,
        );
      },
    ),
  } as unknown as ActivityDouble;
}

function makeDispatch(sink: Sink): DispatchDouble {
  return {
    emit: jest.fn().mockImplementation(async (input: { eventKey: string; entityId: string }) => {
      sink.effects.push(`notification:${input.eventKey}:${input.entityId}`);
      return undefined;
    }),
  } as unknown as DispatchDouble;
}

function makeTransfer(sink: Sink): TransferDouble {
  return {
    notifyAssignedTickets: jest.fn().mockImplementation(
      async (
        _orgId: string,
        ticketIds: readonly number[],
        _actingUserId: string,
        assigneeUserIds: readonly string[],
      ) => {
        for (const ticketId of ticketIds)
          for (const userId of assigneeUserIds)
            sink.assignmentRequests.push(`${ticketId}:${userId}`);
      },
    ),
  } as unknown as TransferDouble;
}

function makeWebhooks(sink: Sink) {
  return {
    enqueue: jest.fn().mockImplementation(
      async (
        _tx: unknown,
        _orgId: string,
        _projectId: number,
        eventName: string,
        payload: { id: number },
      ) => {
        sink.effects.push(`webhook:${eventName}:${payload.id}`);
      },
    ),
  };
}

function makeAutomation(sink: Sink) {
  return {
    runForTicketEvent: jest.fn().mockImplementation(
      (_orgId: string, _projectId: number, event: string, payload: { ticketId: number }) => {
        sink.effects.push(`automation:${event}:${payload.ticketId}`);
      },
    ),
  };
}

function makeDetailDeps(sink: Sink): ApplyTicketChangeDeps {
  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: TICKET_ID, version: 2 }]),
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      projectStatuses: { findMany: jest.fn().mockResolvedValue([]) },
      workflowTransitions: { findMany: jest.fn().mockResolvedValue([]) },
    },
  };
  return {
    db: {
      query: {
        tickets: {
          findFirst: jest.fn().mockResolvedValue({
            id: TICKET_ID,
            orgId: ORG,
            projectId: PROJECT_ID,
            status: "TODO",
            title: TITLE,
            priority: "MEDIUM",
            version: 1,
            assigneeMembershipId: null,
            assignee: null,
            startDate: null,
            dueDate: null,
            reporterId: "reporter-1",
            updatedAt: new Date("2026-01-01"),
            points: null,
            type: "TASK",
            cycleId: null,
          }),
        },
      },
      transaction: jest
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as Db,
    dispatch: makeDispatch(sink) as never,
    activity: makeActivity(sink) as never,
    query: { authorizeMutation: jest.fn().mockResolvedValue([]) } as never,
    transfer: makeTransfer(sink) as never,
    webhooksDispatch: makeWebhooks(sink) as never,
    automationRunner: makeAutomation(sink) as never,
    cache: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    access: { holds: jest.fn().mockResolvedValue(true) } as never,
  };
}

function makeBulkDb(): Db {
  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([
            { id: TICKET_ID, title: TITLE, type: "TASK", reporterId: "reporter-1" },
          ]),
          orderBy: jest.fn().mockReturnValue({ for: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: TICKET_ID, version: 2 }]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest
        .fn()
        .mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue([]) }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };
  return {
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

function makeBulkEffectDeps(sink: Sink): TicketChangeEffectDeps {
  return {
    webhooksDispatch: makeWebhooks(sink),
    automationRunner: makeAutomation(sink),
    activity: makeActivity(sink),
    dispatch: makeDispatch(sink),
    transfer: makeTransfer(sink),
  };
}

function makeRankDb(): Db {
  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValue([
              { id: TICKET_ID, title: TITLE, type: "TASK", reporterId: "reporter-1" },
            ]),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([{ rank: "1500", valid: true }]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            { id: TICKET_ID, rank: "1500", status: "IN_REVIEW", version: 2 },
          ]),
        }),
      }),
    }),
  };
  return {
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

const noCache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;

const access = {
  holds: jest.fn().mockResolvedValue(true),
  scopeFor: jest.fn().mockResolvedValue("all"),
} as never;

describe("the same logical change produces the same activity, notification and automation effects whether the detail route or the bulk route performed it", () => {
  it("a TODO->IN_REVIEW status change yields an identical effect set from applyTicketChange and bulkMutateTickets", async () => {
    const detail = makeSink();
    await applyTicketChange(makeDetailDeps(detail), actor, PROJECT_ID, TICKET_ID, {
      version: 1,
      status: "IN_REVIEW",
    });

    const bulk = makeSink();
    await bulkMutateTickets(
      makeBulkDb(),
      access,
      actor,
      PROJECT_ID,
      { ticketIds: [TICKET_ID], status: "IN_REVIEW" },
      makeBulkEffectDeps(bulk),
    );

    expect([...bulk.effects].sort()).toEqual([...detail.effects].sort());
    expect(detail.effects).toContain(`activity:${TICKET_ID}:TODO->IN_REVIEW`);
    expect(detail.effects).toContain(
      `notification:build.ticket.review_requested:${TICKET_ID}`,
    );
    expect(detail.effects).toContain(`webhook:ticket.status_changed:${TICKET_ID}`);
  });

  it("an assignee change asks the notifier for the same (ticket, new assignee) pair from both routes", async () => {
    const detail = makeSink();
    await applyTicketChange(makeDetailDeps(detail), actor, PROJECT_ID, TICKET_ID, {
      version: 1,
      assigneeId: "assignee-2",
    });

    const bulk = makeSink();
    await bulkMutateTickets(
      makeBulkDb(),
      access,
      actor,
      PROJECT_ID,
      { ticketIds: [TICKET_ID], assigneeId: "assignee-2" },
      makeBulkEffectDeps(bulk),
    );

    expect(bulk.assignmentRequests).toEqual([`${TICKET_ID}:assignee-2`]);
    expect(detail.assignmentRequests).toEqual(bulk.assignmentRequests);
  });
});

describe("the same logical change produces the same effects whether the detail route, the bulk route or the rank route performed it", () => {
  it("a TODO->IN_REVIEW status change yields an identical effect set from applyTicketChange and rankTicket", async () => {
    const detail = makeSink();
    await applyTicketChange(makeDetailDeps(detail), actor, PROJECT_ID, TICKET_ID, {
      version: 1,
      status: "IN_REVIEW",
    });

    const rank = makeSink();
    await rankTicket(
      makeRankDb(),
      noCache,
      access,
      actor,
      PROJECT_ID,
      TICKET_ID,
      { status: "IN_REVIEW" },
      makeBulkEffectDeps(rank),
    );

    expect([...rank.effects].sort()).toEqual([...detail.effects].sort());
    expect(rank.effects).toContain(`webhook:ticket.status_changed:${TICKET_ID}`);
    expect(rank.effects).toContain(
      `notification:build.ticket.review_requested:${TICKET_ID}`,
    );
  });

  it("an assignee change yields the same ticket.assigned webhook and automation from the detail route and the bulk route", async () => {
    const detail = makeSink();
    await applyTicketChange(makeDetailDeps(detail), actor, PROJECT_ID, TICKET_ID, {
      version: 1,
      assigneeId: "assignee-2",
    });

    const bulk = makeSink();
    await bulkMutateTickets(
      makeBulkDb(),
      access,
      actor,
      PROJECT_ID,
      { ticketIds: [TICKET_ID], assigneeId: "assignee-2" },
      makeBulkEffectDeps(bulk),
    );

    expect([...bulk.effects].sort()).toEqual([...detail.effects].sort());
    expect(bulk.effects).toContain(`webhook:ticket.assigned:${TICKET_ID}`);
    expect(bulk.effects).toContain(`automation:ticket.assigned:${TICKET_ID}`);
  });
});
