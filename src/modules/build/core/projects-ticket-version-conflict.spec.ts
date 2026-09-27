import { Test } from "@nestjs/testing";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import { TicketVersionConflictException } from "./ticket-version-conflict.exception";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { systemActor } from "../../../common/auth/system-actor";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { AccessService } from "../../access/access.service";
import { updateTicketSchema } from "./dto/projects.schemas";

async function createService(ticket: Record<string, unknown>) {
  const transaction = jest.fn();
  const module = await Test.createTestingModule({ providers: [ProjectsTicketsUpdateService,
    { provide: DRIZZLE, useValue: { transaction, query: { tickets: { findFirst: async () => ticket } } } },
    ...[CacheService, NotificationDispatchService, ProjectsActivityService, ProjectsTicketsQueryService,
      ProjectsTicketsTransferService, ProjectsWebhooksDispatchService,
      BuildAutomationRunnerService].map(provide => ({ provide, useValue: {} })),
    { provide: AccessService, useValue: { holds: jest.fn().mockResolvedValue(true) } },
  ] }).compile();
  return { module, service: module.get(ProjectsTicketsUpdateService), transaction };
}

it("rejects a future client version before it can bypass validation against the read version", async () => {
  const { module, service, transaction } = await createService({ projectId: 1, version: 1 });
  await expect(service.updateTicket(
    systemActor("integrations.git.webhook", "org-a"), 1, 7, { version: 2, status: "DONE" },
  )).rejects.toThrow(TicketVersionConflictException);
  expect(transaction).not.toHaveBeenCalled();
  await module.close();
});

it.each([
  [{ startDate: "2026-09-20", dueDate: "2026-09-25" }, { dueDate: "2026-09-19" }],
  [{ startDate: "2026-09-20", dueDate: "2026-09-25" }, { startDate: "2026-09-26" }],
])("rejects a partial date update that conflicts with the stored counterpart", async (storedDates, update) => {
  const { module, service, transaction } = await createService({
    projectId: 1,
    version: 1,
    ...storedDates,
  });
  await expect(service.updateTicket(
    systemActor("integrations.git.webhook", "org-a"),
    1,
    7,
    { version: 1, ...update },
  )).rejects.toThrow("Due date must be on or after start date");
  expect(transaction).not.toHaveBeenCalled();
  await module.close();
});

it("stale token carries the current version in the 409 response (ticket-12 box-2)", async () => {
  const { module, service } = await createService({ projectId: 1, version: 7 });
  const error = await service.updateTicket(
    systemActor("integrations.git.webhook", "org-a"), 1, 99, { version: 6, title: "x x x" },
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TicketVersionConflictException);
  expect((error as TicketVersionConflictException).getResponse()).toMatchObject({
    details: { currentVersion: 7 },
  });
  await module.close();
});

it("passes the conflict check and proceeds when the token matches — positive pair for stale-token test (BE-141)", async () => {
  const { module, service, transaction } = await createService({ projectId: 1, version: 7 });
  const error = await service.updateTicket(
    systemActor("integrations.git.webhook", "org-a"), 1, 99, { version: 7, title: "x x x" },
  ).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(TicketVersionConflictException);
  expect(transaction).toHaveBeenCalled();
  await module.close();
});

it("CAS failure inside the transaction re-reads the current version and throws 409 with it (ticket-12 box-3)", async () => {
  const casFailTx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ version: 9 }]),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    query: {
      projectStatuses: { findMany: jest.fn().mockResolvedValue([]) },
      workflowTransitions: { findMany: jest.fn().mockResolvedValue([]) },
    },
  };

  const transaction = jest.fn().mockImplementation(
    async (cb: (tx: typeof casFailTx) => Promise<void>) => cb(casFailTx),
  );

  const dbWithCasFail = {
    transaction,
    query: {
      tickets: {
        findFirst: jest.fn().mockResolvedValue({
          projectId: 1,
          version: 8,
          title: "Ticket",
          status: "TODO",
          priority: "MEDIUM",
          assigneeMembershipId: null,
          startDate: null,
          dueDate: null,
          reporterId: null,
          updatedAt: new Date(),
          points: null,
          type: "TASK",
          cycleId: null,
          assignee: null,
        }),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    }),
  };

  const module = await Test.createTestingModule({ providers: [ProjectsTicketsUpdateService,
    { provide: DRIZZLE, useValue: dbWithCasFail },
    ...[CacheService, NotificationDispatchService, ProjectsActivityService, ProjectsTicketsQueryService,
      ProjectsTicketsTransferService, ProjectsWebhooksDispatchService,
      BuildAutomationRunnerService].map(provide => ({ provide, useValue: {} })),
    { provide: AccessService, useValue: { holds: jest.fn().mockResolvedValue(true) } },
  ] }).compile();

  const service = module.get(ProjectsTicketsUpdateService);
  const error = await service.updateTicket(
    systemActor("integrations.git.webhook", "org-a"), 1, 99, { version: 8, title: "x x x" },
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(TicketVersionConflictException);
  expect((error as TicketVersionConflictException).getResponse()).toMatchObject({
    details: { currentVersion: 9 },
  });
  await module.close();
});

it("version is required — a body without it fails schema validation (ticket-12 box-1)", () => {
  const result = updateTicketSchema.safeParse({ title: "New title" });
  expect(result.success).toBe(false);
});

it("version present — body passes schema validation (BE-141 positive pair for version-required test)", () => {
  const result = updateTicketSchema.safeParse({ title: "New title", version: 5 });
  expect(result.success).toBe(true);
});
