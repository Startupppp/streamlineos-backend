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
import { ProjectsTicketLinksService } from "./projects-ticket-links.service";
import { ProjectsTicketRelationsService } from "./projects-ticket-relations.service";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";

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

async function makeSubresources() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketSubresourcesService,
      { provide: DRIZZLE, useValue: storageThatMustNotRun() },
      { provide: ProjectsActivityService, useValue: {} },
      { provide: ProjectsTicketCommentsService, useValue: {} },
      { provide: ProjectsTicketChecklistsService, useValue: {} },
      { provide: ProjectsTicketLinksService, useValue: {} },
      { provide: ProjectsTicketRelationsService, useValue: {} },
      { provide: AccessService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ProjectsTicketSubresourcesService);
}

async function makeComments() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketCommentsService,
      { provide: DRIZZLE, useValue: storageThatMustNotRun() },
      { provide: ProjectsActivityService, useValue: {} },
      { provide: AccessService, useValue: {} },
      { provide: ProjectsWebhooksDispatchService, useValue: {} },
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

describe("ticket subresource project access", () => {
  const cases: Array<
    [string, (service: ProjectsTicketSubresourcesService) => Promise<unknown>]
  > = [
    ["getSubtasks", (service) => service.getSubtasks(actor, 7, 11)],
    ["getWatchers", (service) => service.getWatchers(actor, 7, 11)],
    ["addWatcher", (service) => service.addWatcher(actor, 7, 11, {})],
    ["removeWatcher", (service) => service.removeWatcher(actor, 7, 11)],
    ["addLabel", (service) => service.addLabel(actor, 7, 11, { labelId: 3 })],
    ["removeLabel", (service) => service.removeLabel(actor, 7, 11, 3)],
    [
      "addAttachment",
      (service) =>
        service.addAttachment(actor, 7, 11, {
          fileUrl: "https://example.test/file.txt",
          fileName: "file.txt",
          fileSize: 1,
          mimeType: "text/plain",
        }),
    ],
    ["getChecklists", (service) => service.getChecklists(actor, 7, 11)],
    [
      "createChecklist",
      (service) => service.createChecklist(actor, 7, 11, { title: "Ready" }),
    ],
    [
      "updateChecklist",
      (service) => service.updateChecklist(actor, 7, 11, 17, { title: "Done" }),
    ],
    ["deleteChecklist", (service) => service.deleteChecklist(actor, 7, 11, 17)],
    [
      "createChecklistItem",
      (service) =>
        service.createChecklistItem(actor, 7, 11, 17, {
          text: "Verify",
          order: 0,
        }),
    ],
    [
      "updateChecklistItem",
      (service) =>
        service.updateChecklistItem(actor, 7, 11, 17, 19, {
          text: "Verified",
        }),
    ],
    [
      "deleteChecklistItem",
      (service) => service.deleteChecklistItem(actor, 7, 11, 17, 19),
    ],
    ["getGitLinks", (service) => service.getGitLinks(actor, 7, 11)],
  ];

  it.each(cases)("%s authorizes before storage", async (_name, invoke) => {
    const service = await makeSubresources();

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
