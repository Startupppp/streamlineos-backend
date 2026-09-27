import { Test } from "@nestjs/testing";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
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

it.each(["parentTicketId", "epicId"] as const)("rejects an inverse %s edge committed while the request awaited serialization", async field => {
  const tx = {
    execute: async () => [{ id: 8, next_id: 7, project_id: 1, depth: 0 }],
    update: () => { throw new Error("The inverse edge reached the write boundary"); },
  };
  const db = {
    query: { tickets: { findFirst: async () => ({ projectId: 1, version: 1 }) } },
    execute: async () => [{ id: 8, next_id: null, project_id: 1, depth: 0 }],
    transaction: async <T>(operation: (transaction: typeof tx) => Promise<T>) => operation(tx),
  };
  const module = await Test.createTestingModule({ providers: [ProjectsTicketsUpdateService,
    { provide: DRIZZLE, useValue: db },
    ...[CacheService, NotificationDispatchService, ProjectsActivityService, ProjectsTicketsQueryService,
      ProjectsTicketsReadService, ProjectsTicketsTransferService, ProjectsWebhooksDispatchService,
      BuildAutomationRunnerService].map(provide => ({ provide, useValue: {} })),
    { provide: AccessService, useValue: { holds: jest.fn().mockResolvedValue(true) } },
  ] }).compile();
  try {
    await expect(module.get(ProjectsTicketsUpdateService).updateTicket(
      systemActor("integrations.git.webhook", "org-a"), 1, 7, { version: 1, [field]: 8 },
    )).rejects.toThrow("would create a cycle");
  } finally {
    await module.close();
  }
});
