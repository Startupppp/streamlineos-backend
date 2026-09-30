import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import { assertTicketReadAccess } from "./build-ticket-read-access";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { ProjectsTicketChecklistsService } from "./projects-ticket-checklists.service";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { ProjectsTicketLinksService } from "./projects-ticket-links.service";
import { ProjectsTicketWatchersService } from "./projects-ticket-watchers.service";
import { ProjectsTicketLabelsService } from "./projects-ticket-labels.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";

jest.mock("./build-ticket-read-access", () => ({
  assertTicketReadAccess: jest.fn(),
}));

const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function storageThatMustNotRun() {
  const fail = jest.fn().mockRejectedValue(new Error("authorization bypassed"));
  return {
    query: {
      tickets: { findFirst: fail },
      ticketComments: { findFirst: fail },
      ticketWatchers: { findMany: fail },
    },
    select: fail,
    insert: fail,
    update: fail,
    delete: fail,
    transaction: fail,
  };
}

async function makeWatchers() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketWatchersService,
      { provide: DRIZZLE, useValue: storageThatMustNotRun() },
      { provide: AccessService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ProjectsTicketWatchersService);
}

async function makeLabels() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketLabelsService,
      { provide: DRIZZLE, useValue: storageThatMustNotRun() },
      { provide: AccessService, useValue: {} },
      { provide: ProjectsActivityService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ProjectsTicketLabelsService);
}

async function makeChecklists() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketChecklistsService,
      { provide: DRIZZLE, useValue: storageThatMustNotRun() },
      { provide: AccessService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ProjectsTicketChecklistsService);
}

async function makeLinks() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketLinksService,
      { provide: DRIZZLE, useValue: storageThatMustNotRun() },
      { provide: AccessService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ProjectsTicketLinksService);
}

async function makeQuery() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketsQueryService,
      { provide: DRIZZLE, useValue: storageThatMustNotRun() },
      { provide: AccessService, useValue: {} },
      { provide: CacheService, useValue: {} },
      { provide: ProjectsWebhooksDispatchService, useValue: {} },
      { provide: BuildAutomationRunnerService, useValue: {} },
      { provide: ProjectsActivityService, useValue: {} },
      { provide: NotificationDispatchService, useValue: {} },
      { provide: ProjectsTicketsTransferService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ProjectsTicketsQueryService);
}

async function makeComments() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketCommentsService,
      { provide: DRIZZLE, useValue: storageThatMustNotRun() },
      { provide: ProjectsActivityService, useValue: {} },
      { provide: AccessService, useValue: {} },
      { provide: ProjectsWebhooksDispatchService, useValue: {} },
      { provide: AuditService, useValue: { log: jest.fn(), logCritical: jest.fn() } },
    ],
  }).compile();
  return moduleRef.get(ProjectsTicketCommentsService);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(assertTicketReadAccess)
    .mockRejectedValue(new ForbiddenException("Ticket is outside your access scope"));
});

describe("ticket subresource project access — watchers", () => {
  const cases: Array<[string, (service: ProjectsTicketWatchersService) => Promise<unknown>]> = [
    ["getWatchers", (service) => service.getWatchers(actor, 7, 11)],
    ["addWatcher", (service) => service.addWatcher(actor, 7, 11, {})],
    ["removeWatcher", (service) => service.removeWatcher(actor, 7, 11)],
  ];

  it.each(cases)("%s authorizes before storage", async (_name, invoke) => {
    const service = await makeWatchers();

    await expect(invoke(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertTicketReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      actor,
      7,
      11,
    );
  });
});

describe("ticket subresource project access — labels", () => {
  const cases: Array<[string, (service: ProjectsTicketLabelsService) => Promise<unknown>]> = [
    ["addTicketLabel", (service) => service.addTicketLabel(actor, 7, 11, { labelId: 3 })],
    ["removeTicketLabel", (service) => service.removeTicketLabel(actor, 7, 11, 3)],
  ];

  it.each(cases)("%s authorizes before storage", async (_name, invoke) => {
    const service = await makeLabels();

    await expect(invoke(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertTicketReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      actor,
      7,
      11,
    );
  });
});

describe("ticket subresource project access — checklists", () => {
  const cases: Array<[string, (service: ProjectsTicketChecklistsService) => Promise<unknown>]> = [
    ["getChecklists", (service) => service.getChecklists(actor, 7, 11)],
    ["createChecklist", (service) => service.createChecklist(actor, 7, 11, { title: "Ready" })],
    ["updateChecklist", (service) => service.updateChecklist(actor, 7, 11, 17, { title: "Done" })],
    ["deleteChecklist", (service) => service.deleteChecklist(actor, 7, 11, 17)],
    ["createChecklistItem", (service) => service.createChecklistItem(actor, 7, 11, 17, { text: "Verify", order: 0 })],
    ["updateChecklistItem", (service) => service.updateChecklistItem(actor, 7, 11, 17, 19, { text: "Verified" })],
    ["deleteChecklistItem", (service) => service.deleteChecklistItem(actor, 7, 11, 17, 19)],
  ];

  it.each(cases)("%s authorizes before storage", async (_name, invoke) => {
    const service = await makeChecklists();

    await expect(invoke(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertTicketReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      actor,
      7,
      11,
    );
  });
});

describe("ticket subresource project access — links", () => {
  const cases: Array<[string, (service: ProjectsTicketLinksService) => Promise<unknown>]> = [
    ["getGitLinks", (service) => service.getGitLinks(actor, 7, 11)],
  ];

  it.each(cases)("%s authorizes before storage", async (_name, invoke) => {
    const service = await makeLinks();

    await expect(invoke(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertTicketReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      actor,
      7,
      11,
    );
  });
});

describe("ticket subresource project access — query", () => {
  const cases: Array<[string, (service: ProjectsTicketsQueryService) => Promise<unknown>]> = [
    ["getSubtasks", (service) => service.getSubtasks(actor, 7, 11)],
  ];

  it.each(cases)("%s authorizes before storage", async (_name, invoke) => {
    const service = await makeQuery();

    await expect(invoke(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertTicketReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      actor,
      7,
      11,
    );
  });
});

describe("ticket comment project access", () => {
  const cases: Array<
    [string, (service: ProjectsTicketCommentsService) => Promise<unknown>]
  > = [
    ["addComment", (service) => service.addComment(actor, 7, 11, { content: "hello" })],
    ["getComment", (service) => service.getComment(actor, 7, 11, 13)],
    ["editComment", (service) => service.editComment(actor, 7, 11, 13, "edited")],
    ["deleteComment", (service) => service.deleteComment(actor, 7, 11, 13)],
  ];

  it.each(cases)("%s authorizes before storage", async (_name, invoke) => {
    const service = await makeComments();

    await expect(invoke(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertTicketReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      actor,
      7,
      11,
    );
  });
});
