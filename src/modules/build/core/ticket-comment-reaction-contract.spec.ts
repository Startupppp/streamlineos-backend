import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { reactionSchema } from "./dto/build-tickets-response.schemas";
import { ticketCommentReactions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { agentTokenPrincipal, humanSessionPrincipal } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";

const PROJECT_ID = 3;
const TICKET_ID = 9;

function makeActor(orgId: string, membershipId: number | null): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: membershipId === null
      ? agentTokenPrincipal(7, 1, [])
      : humanSessionPrincipal(membershipId, false),
  };
}

function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

async function buildService(options: {
  ticketRows?: unknown[];
  membershipRows?: unknown[];
  teamRows?: unknown[];
  comment?: { id: number };
}) {
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });
  const deleteWhere = jest.fn().mockResolvedValue(undefined);
  const deleteReaction = jest.fn().mockReturnValue({ where: deleteWhere });
  const db = {
    query: {
      ticketComments: { findFirst: jest.fn().mockResolvedValue(options.comment) },
      projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
    },
    select: jest.fn()
      .mockReturnValueOnce(makeSelectChain(options.ticketRows ?? [{ id: TICKET_ID, allowed: true }]))
      .mockReturnValueOnce(makeSelectChain(options.membershipRows ?? [{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain(options.teamRows ?? [])),
    insert,
    delete: deleteReaction,
  };
  const module = await Test.createTestingModule({
    providers: [
      ProjectsTicketCommentsService,
      { provide: DRIZZLE, useValue: db },
      { provide: ProjectsActivityService, useValue: {} },
      {
        provide: AccessService,
        useValue: {
          scopeFor: jest.fn().mockResolvedValue("all"),
          resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
        },
      },
      { provide: ProjectsWebhooksDispatchService, useValue: {} },
    ],
  }).compile();
  return {
    module,
    service: module.get(ProjectsTicketCommentsService),
    insert,
    values,
    onConflictDoNothing,
    deleteReaction,
  };
}

describe("ProjectsTicketCommentsService.addReaction", () => {
  it("returns the actor-shaped payload the contract declares, not the inserted row", async () => {
    const { module, service } = await buildService({ comment: { id: 42 } });

    const result = await service.addReaction(makeActor("org-1", 7), PROJECT_ID, TICKET_ID, 42, "👍");

    expect(result).toEqual({ commentId: 42, userId: "user-1", emoji: "👍" });
    expect(reactionSchema.safeParse(result).success).toBe(true);
    await module.close();
  });

  it("never asks the insert for the row back, because that row has no userId to return", async () => {
    const { module, service, values, onConflictDoNothing } = await buildService({ comment: { id: 42 } });

    await service.addReaction(makeActor("org-1", 7), PROJECT_ID, TICKET_ID, 42, "👍");

    expect(values).toHaveBeenCalledWith({ commentId: 42, orgId: "org-1", emoji: "👍", membershipId: 7 });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(onConflictDoNothing.mock.results[0]?.value).not.toHaveProperty("returning");
    await module.close();
  });

  it("refuses a caller with no membership before writing a reaction row", async () => {
    const { module, service, insert } = await buildService({ comment: { id: 42 } });

    await expect(
      service.addReaction(makeActor("org-1", null), PROJECT_ID, TICKET_ID, 42, "👍"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
    await module.close();
  });

  it("reports a comment outside the caller's org as missing rather than forbidden", async () => {
    const { module, service, insert } = await buildService({});

    await expect(
      service.addReaction(makeActor("other-org", 7), PROJECT_ID, TICKET_ID, 42, "👍"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
    await module.close();
  });

  it("reports a ticket outside the URL's project as missing, before ever looking at the comment", async () => {
    const { module, service, insert } = await buildService({ ticketRows: [], comment: { id: 42 } });

    await expect(
      service.addReaction(makeActor("org-1", 7), PROJECT_ID, TICKET_ID, 42, "👍"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
    await module.close();
  });

  it("refuses a caller who cannot reach the URL project before writing", async () => {
    const { module, service, insert } = await buildService({ membershipRows: [], comment: { id: 42 } });

    await expect(
      service.addReaction(makeActor("org-1", 7), PROJECT_ID, TICKET_ID, 42, "👍"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
    await module.close();
  });
});

describe("ProjectsTicketCommentsService.removeReaction", () => {
  it("reports a ticket outside the URL's project as missing, before ever looking at the comment", async () => {
    const { module, service } = await buildService({ ticketRows: [], comment: { id: 42 } });

    await expect(
      service.removeReaction(makeActor("org-1", 7), PROJECT_ID, TICKET_ID, 42, "👍"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await module.close();
  });

  it("refuses a caller who cannot reach the URL project before deleting", async () => {
    const { module, service, deleteReaction } = await buildService({ membershipRows: [], comment: { id: 42 } });

    await expect(
      service.removeReaction(makeActor("org-1", 7), PROJECT_ID, TICKET_ID, 42, "👍"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleteReaction).not.toHaveBeenCalled();
    await module.close();
  });
});

describe("ticket comment reaction response", () => {
  it("has no userId column on the reaction row, which is why returning the inserted row broke the contract", () => {
    const columns = Object.keys(ticketCommentReactions);

    expect(columns).toContain("membershipId");
    expect(columns).not.toContain("userId");
  });

  it("rejects the raw inserted row, the shape that used to be returned on a first-time reaction", () => {
    const insertedRow = {
      id: 1,
      orgId: "org-1",
      commentId: 42,
      membershipId: 7,
      emoji: "👍",
      createdAt: new Date(),
    };

    expect(reactionSchema.safeParse(insertedRow).success).toBe(false);
  });

  it("accepts the actor-shaped payload the handler now always returns", () => {
    expect(
      reactionSchema.safeParse({ commentId: 42, userId: "user-1", emoji: "👍" }).success,
    ).toBe(true);
  });

  it("requires userId, so a future refactor cannot silently drop the only field identifying who reacted", () => {
    expect(reactionSchema.safeParse({ commentId: 42, emoji: "👍" }).success).toBe(false);
  });
});
