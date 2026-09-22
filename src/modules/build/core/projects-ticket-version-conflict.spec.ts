import { Test } from "@nestjs/testing";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import { ProjectsTicketConflictException } from "../../../common/http/api-exceptions";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { systemActor } from "../../../common/auth/system-actor";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { AccessService } from "../../access/access.service";

async function createService(ticket: Record<string, unknown>) {
  const transaction = jest.fn();
  const module = await Test.createTestingModule({ providers: [ProjectsTicketsUpdateService,
    { provide: DRIZZLE, useValue: { transaction, query: { tickets: { findFirst: async () => ticket } } } },
    ...[CacheService, NotificationDispatchService, ProjectsActivityService, ProjectsTicketsQueryService,
      ProjectsTicketsReadService, ProjectsTicketsTransferService, ProjectsWebhooksDispatchService,
      BuildAutomationRunnerService].map(provide => ({ provide, useValue: {} })),
    { provide: AccessService, useValue: { holds: jest.fn().mockResolvedValue(true) } },
  ] }).compile();
  return { module, service: module.get(ProjectsTicketsUpdateService), transaction };
}

it("rejects a future client version before it can bypass validation against the read version", async () => {
  const { module, service, transaction } = await createService({ projectId: 1, version: 1 });
  await expect(service.updateTicket(
    systemActor("integrations.git.webhook", "org-a"), 1, 7, { version: 2, status: "DONE" },
  )).rejects.toThrow(ProjectsTicketConflictException);
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
    update,
  )).rejects.toThrow("Due date must be on or after start date");
  expect(transaction).not.toHaveBeenCalled();
  await module.close();
});
