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

it("rejects a future client version before it can bypass validation against the read version", async () => {
  const transaction = jest.fn();
  const module = await Test.createTestingModule({ providers: [ProjectsTicketsUpdateService,
    { provide: DRIZZLE, useValue: { transaction, query: { tickets: { findFirst: async () => ({ projectId: 1, version: 1 }) } } } },
    ...[CacheService, NotificationDispatchService, ProjectsActivityService, ProjectsTicketsQueryService,
      ProjectsTicketsReadService, ProjectsTicketsTransferService, ProjectsWebhooksDispatchService,
      BuildAutomationRunnerService].map(provide => ({ provide, useValue: {} })),
  ] }).compile();
  await expect(module.get(ProjectsTicketsUpdateService).updateTicket(
    systemActor("integrations.git.webhook", "org-a"), 7, { version: 2, status: "DONE" },
  )).rejects.toThrow(ProjectsTicketConflictException);
  expect(transaction).not.toHaveBeenCalled();
  await module.close();
});
