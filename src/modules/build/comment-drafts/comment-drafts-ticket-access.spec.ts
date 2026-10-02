import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import { withDelegatingTransaction } from "../../../test/delegating-transaction";
import { CommentDraftGeneratorService } from "./comment-draft-generator.service";
import { CommentDraftsService } from "./comment-drafts.service";
import { MEMBER_STANDING, standingAccess } from "../__tests__/project-access-doubles";

const PROJECT_ID = 7;
const TICKET_ID = 55;
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

const TICKET = {
  id: TICKET_ID,
  title: "Fix login timeout",
  description: "Users are logged out early",
  status: "IN_PROGRESS",
  priority: "HIGH",
  type: "BUG",
};

function rowsFor(standing: Standing, projection: Record<string, unknown>): unknown[] {
  if (standing === "foreign") return [];
  if ("reachable" in projection)
    return [{ projectId: PROJECT_ID, projectState: "ACTIVE", projectDeletedAt: null, reachable: standing === "member", inScope: true }];
  if ("projectId" in projection) return [{ projectId: PROJECT_ID }];
  if ("title" in projection) return [TICKET];
  if ("content" in projection) return [{ content: "Reproduced on staging." }];
  return [];
}

async function build(standing: Standing) {
  const select = jest.fn((projection: Record<string, unknown>) => {
    const chain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue(rowsFor(standing, projection)),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    return chain;
  });
  const returning = jest.fn().mockResolvedValue([{ id: 1, ticketId: TICKET_ID }]);
  const onConflictDoUpdate = jest.fn(() => ({ returning }));
  const insert = jest.fn(() => ({ values: jest.fn(() => ({ onConflictDoUpdate })) }));
  const db = withDelegatingTransaction({
    select,
    insert,
  });
  const gateway = {
    invokeStructuredWithUsage: jest.fn().mockResolvedValue({
      ok: true,
      data: { body: "Extend the timeout.", evidence: null, proposedChange: null, impact: null, confidence: 80, affectedRecordIds: null },
      aiUsage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, credits: 1, costUsd: 0 },
      correlationId: "c",
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      CommentDraftsService,
      CommentDraftGeneratorService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiGatewayService, useValue: gateway },
      {
        provide: AccessService,
        useValue: standingAccess(MEMBER_STANDING),
      },
    ],
  }).compile();
  return {
    drafts: moduleRef.get(CommentDraftsService),
    generator: moduleRef.get(CommentDraftGeneratorService),
    gateway,
    insert,
  };
}

beforeEach(() => {
  primeRelocationTrafficTracker([], Date.now());
});

describe("PUT /build/comment-drafts/tickets/:ticketId requires read access to the ticket", () => {
  it("answers 403 to a same-org caller who cannot reach the ticket's project, without storing a draft", async () => {
    const { drafts, insert } = await build("non-member");
    await expect(drafts.upsert(caller, TICKET_ID, { body: "draft" })).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers 404 for a ticket outside the caller's tenant, without storing a draft", async () => {
    const { drafts, insert } = await build("foreign");
    await expect(drafts.upsert(caller, TICKET_ID, { body: "draft" })).rejects.toThrow(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("stores the draft for a caller who can read the ticket", async () => {
    const { drafts, insert } = await build("member");
    await expect(drafts.upsert(caller, TICKET_ID, { body: "draft" })).resolves.toMatchObject({ ticketId: TICKET_ID });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("POST /build/comment-drafts/tickets/:ticketId/generate-draft never feeds an unreadable ticket to the model", () => {
  it("answers 403 to a same-org caller who cannot reach the ticket's project, before any provider call", async () => {
    const { generator, gateway } = await build("non-member");
    await expect(generator.generate(caller, TICKET_ID)).rejects.toThrow(ForbiddenException);
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
  });

  it("answers 404 for a ticket outside the caller's tenant, before any provider call", async () => {
    const { generator, gateway } = await build("foreign");
    await expect(generator.generate(caller, TICKET_ID)).rejects.toThrow(NotFoundException);
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
  });

  it("drafts from the ticket for a caller who can read it", async () => {
    const { generator, gateway } = await build("member");
    await generator.generate(caller, TICKET_ID);
    expect(gateway.invokeStructuredWithUsage).toHaveBeenCalledTimes(1);
  });
});
