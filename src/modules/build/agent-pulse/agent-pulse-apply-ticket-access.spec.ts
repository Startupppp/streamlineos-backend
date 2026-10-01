import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ProjectsTicketCommentsService } from "../core/tickets";
import { ProjectsActivityService } from "../core/activity/projects-activity.service";
import { ProjectsWebhooksDispatchService } from "../core/webhooks/projects-webhooks-dispatch.service";
import { AgentPulseService } from "./agent-pulse.service";

const PROJECT_ID = 7;
const TICKET_ID = 55;
const DRAFT_ID = 9;
const COMMENT_ID = 101;
const CALLER_MEMBERSHIP = 21;

const caller: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(CALLER_MEMBERSHIP, false),
};

type Standing = "member" | "non-member" | "foreign";

type QueryChain = {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
};

function rowsFor(projection: Record<string, unknown>): unknown[] {
  if ("authorId" in projection) {
    return [
      {
        id: COMMENT_ID,
        orgId: "org-1",
        ticketId: TICKET_ID,
        body: "Ship the fix",
        clientVisible: false,
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        authorId: caller.userId,
        authorDisplayName: null,
        authorFirstName: null,
        authorLastName: null,
        authorImage: null,
        authorEmail: "caller@example.com",
      },
    ];
  }
  if ("body" in projection) return [{ id: DRAFT_ID, ticketId: TICKET_ID, body: "Ship the fix" }];
  if ("allowed" in projection) return [{ id: TICKET_ID, allowed: true }];
  return [];
}

async function build(standing: Standing) {
  const select = jest.fn((projection: Record<string, unknown>) => {
    const chain: QueryChain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue(rowsFor(projection)),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    return chain;
  });
  const insert = jest.fn(() => ({
    values: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ id: COMMENT_ID }]) })),
  }));
  const draftDelete = jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) }));
  const transaction = jest.fn(async (work: (tx: { insert: typeof insert }) => Promise<unknown>) => work({ insert }));
  const ticket =
    standing === "foreign"
      ? undefined
      : { id: TICKET_ID, projectId: PROJECT_ID, assigneeMembershipId: null, reporterId: null, ticketNumber: 3, title: "Fix", assignee: null, assignees: [] };
  const db = {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(ticket) },
      projects: {
        findFirst: jest.fn().mockResolvedValue({
          managerMembershipId: standing === "member" ? CALLER_MEMBERSHIP : 999,
        }),
      },
    },
    select,
    transaction,
    delete: draftDelete,
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentPulseService,
      ProjectsTicketCommentsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      {
        provide: ProjectsActivityService,
        useValue: { logTicketActivity: jest.fn(), processCommentMentions: jest.fn() },
      },
      { provide: ProjectsWebhooksDispatchService, useValue: { enqueue: jest.fn() } },
      {
        provide: AccessService,
        useValue: {
          resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
          scopeFor: jest.fn().mockResolvedValue("all"),
        },
      },
    ],
  }).compile();
  return { service: moduleRef.get(AgentPulseService), insert, draftDelete };
}

describe("POST /build/agent-pulse/proposals/:draftId/apply authorizes through the canonical comment write", () => {
  it("answers 403 to a same-org caller who cannot reach the ticket's project, posting no comment and keeping the draft", async () => {
    const { service, insert, draftDelete } = await build("non-member");
    await expect(service.applyDraft(caller, DRAFT_ID)).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
    expect(draftDelete).not.toHaveBeenCalled();
  });

  it("answers 404 when the draft's ticket is outside the caller's tenant, posting no comment and keeping the draft", async () => {
    const { service, insert, draftDelete } = await build("foreign");
    await expect(service.applyDraft(caller, DRAFT_ID)).rejects.toThrow(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
    expect(draftDelete).not.toHaveBeenCalled();
  });

  it("posts the comment and consumes the draft for a caller who can reach the ticket", async () => {
    const { service, insert, draftDelete } = await build("member");
    await expect(service.applyDraft(caller, DRAFT_ID)).resolves.toEqual({ commentId: COMMENT_ID, ticketId: TICKET_ID });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(draftDelete).toHaveBeenCalledTimes(1);
  });
});
