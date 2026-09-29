import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { CacheService } from "../../../../common/cache/cache.service";
import { AccessService } from "../../../access/access.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { TicketVersionConflictException } from "./ticket-version-conflict.exception";
import { bulkUpdateSchema } from "../dto/projects.schemas";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";

const actor: CurrentUserContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

async function harness(ticketVersion: number) {
  const scopeFor = jest.fn().mockResolvedValue("all");
  const rows = [
    {
      id: 10,
      status: "TODO",
      version: ticketVersion,
      assigneeMembershipId: null,
      allowed: true,
    },
  ];
  const ticketChain = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
    then: (resolve: (value: typeof rows) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  const set = jest
    .fn()
    .mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(rows),
      }),
    });
  const db = {
    select: jest.fn().mockReturnValue(ticketChain),
    update: jest.fn(() => ({ set })),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      projects: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 1, managerMembershipId: 1 }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(undefined),
      },
    },
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation(
    async (callback: (tx: typeof db) => Promise<unknown>) => callback(db),
  );
  const module = await Test.createTestingModule({
    providers: [
      ProjectsTicketsQueryService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: CacheService,
        useValue: {
          invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          del: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: AccessService, useValue: { scopeFor } },
      {
        provide: ProjectsWebhooksDispatchService,
        useValue: { enqueue: jest.fn().mockResolvedValue(undefined) },
      },
      {
        provide: BuildAutomationRunnerService,
        useValue: { runForTicketEvent: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: ProjectsActivityService, useValue: { logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } },
      { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
    ],
  }).compile();
  return {
    module,
    db,
    set,
    service: module.get(ProjectsTicketsQueryService),
  };
}

describe("bulkUpdateSchema — per-row versions field declared for stage-one CAS", () => {
  it("accepts a body without versions — omitting the token must not break existing callers", () => {
    const result = bulkUpdateSchema.safeParse({
      ticketIds: [1],
      status: "DONE",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a body with a versions map keyed by ticket-id strings", () => {
    const result = bulkUpdateSchema.safeParse({
      ticketIds: [1, 2],
      status: "DONE",
      versions: { "1": 3, "2": 7 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a versions map whose values are non-positive integers", () => {
    const result = bulkUpdateSchema.safeParse({
      ticketIds: [1],
      status: "DONE",
      versions: { "1": 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("bulkMutateTickets — per-row version CAS (stage-one: accept-and-warn)", () => {
  it("throws TicketVersionConflictException carrying the stale row's current version when the versions map contains a mismatched entry (i — stale token → 409)", async () => {
    const h = await harness(1);
    try {
      const error = await h.service
        .bulkUpdate(actor, 1, {
          ticketIds: [10],
          status: "DONE",
          versions: { "10": 99 },
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TicketVersionConflictException);
      expect(
        (error as TicketVersionConflictException).getResponse(),
      ).toMatchObject({
        code: "PROJECTS_TICKET_CONFLICT",
        details: { currentVersion: 1 },
      });
    } finally {
      await h.module.close();
    }
  });

  it("makes no write when a stale per-row version is detected — the update must not execute before the conflict is raised (BE-141 stale-negative pair)", async () => {
    const h = await harness(1);
    try {
      await h.service
        .bulkUpdate(actor, 1, {
          ticketIds: [10],
          status: "DONE",
          versions: { "10": 99 },
        })
        .catch(() => undefined);
      expect(h.set).not.toHaveBeenCalled();
    } finally {
      await h.module.close();
    }
  });

  it("resolves without error when the versions map matches the stored versions (ii — correct token → 200)", async () => {
    const h = await harness(1);
    try {
      await expect(
        h.service.bulkUpdate(actor, 1, {
          ticketIds: [10],
          priority: "HIGH",
          versions: { "10": 1 },
        }),
      ).resolves.toMatchObject({ updated: 1 });
    } finally {
      await h.module.close();
    }
  });

  it("resolves without error when versions is omitted — omitting the map must never reject the request (iii — token omitted → success, breaking-change guard)", async () => {
    const h = await harness(1);
    try {
      await expect(
        h.service.bulkUpdate(actor, 1, { ticketIds: [10], priority: "HIGH" }),
      ).resolves.toMatchObject({ updated: 1 });
    } finally {
      await h.module.close();
    }
  });
});
