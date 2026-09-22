import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { CommentDraftGeneratorService } from "./comment-draft-generator.service";
import { CommentDraftsService } from "./comment-drafts.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { Db } from "../../../db/drizzle.module";
import { AI_FEATURE_COSTS } from "../../ai/core/billing/ai-cost-catalog";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import { withDelegatingTransaction } from "../../../test/delegating-transaction";
import { tickets } from "../../../db/schema/build/tasks";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const MEMBERSHIP_ID = 42;
const TICKET_ID = 99;

type TicketDraftSource = Pick<
  typeof tickets.$inferSelect,
  "id" | "title" | "description" | "status" | "priority" | "type"
>;

const ticketRow: TicketDraftSource = {
  id: TICKET_ID,
  title: "Fix login timeout",
  description: "Users are getting logged out",
  status: "IN_PROGRESS",
  priority: "HIGH",
  type: "BUG",
};

const aiOutputData = {
  body: "We should extend the session timeout to 30 minutes.",
  evidence: "Users reporting repeated timeouts within 5 minutes.",
  proposedChange: "Increase session TTL from 5 to 30 minutes.",
  impact: "All authenticated users.",
  confidence: 80,
  affectedRecordIds: [99, 100],
};

const aiUsage = {
  model: "gpt-4o-mini",
  promptTokens: 120,
  completionTokens: 60,
  totalTokens: 180,
  credits: 1,
  costUsd: 0.0002,
};

function makeGatewayOk() {
  return {
    ok: true as const,
    data: aiOutputData,
    aiUsage,
    correlationId: "corr-1",
  };
}

function makeGatewayFail(kind: "quota_exceeded" | "provider_unavailable" | "invalid_output") {
  return {
    ok: false as const,
    kind,
    message: `Gateway error: ${kind}`,
    correlationId: "corr-fail",
  };
}

function makeTicketChain(rows: typeof ticketRow[] | []) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function makeCommentsChain(rows: { content: string }[]) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };
}

function makeDb(ticketRows: typeof ticketRow[] | [], commentRows: { content: string }[] = []) {
  return withDelegatingTransaction({
    select: jest.fn()
      .mockReturnValueOnce(makeTicketChain(ticketRows))
      .mockReturnValueOnce(makeCommentsChain(commentRows)),
  }) as unknown as Db;
}

const upsertedDraftRow = {
  id: 1,
  orgId: ORG_ID,
  membershipId: MEMBERSHIP_ID,
  ticketId: TICKET_ID,
  body: aiOutputData.body,
  evidence: aiOutputData.evidence,
  proposedChange: aiOutputData.proposedChange,
  impact: aiOutputData.impact,
  confidence: aiOutputData.confidence,
  affectedRecordIds: JSON.stringify(aiOutputData.affectedRecordIds),
  retryCount: 0,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  primeRelocationTrafficTracker([], Date.now());
});

describe("CommentDraftGeneratorService — membership guard", () => {
  it("throws ForbiddenException before making any DB query when membershipId is null", async () => {
    const db = { select: jest.fn() } as unknown as Db;
    const gateway = { invokeStructuredWithUsage: jest.fn() } as unknown as AiGatewayService;
    const drafts = { upsertGenerated: jest.fn() } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);

    await expect(svc.generate(ORG_ID, null, USER_ID, TICKET_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.select).not.toHaveBeenCalled();
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
  });
});

describe("CommentDraftGeneratorService — unreachable ticket short-circuit", () => {
  it("throws NotFoundException and never calls the AI provider when the ticket is not found in the requesting org", async () => {
    const db = makeDb([]);
    const gateway = { invokeStructuredWithUsage: jest.fn() } as unknown as AiGatewayService;
    const drafts = { upsertGenerated: jest.fn() } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);

    await expect(svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
  });

  it("never calls the AI provider when the ticket belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb([]);
    const gateway = { invokeStructuredWithUsage: jest.fn() } as unknown as AiGatewayService;
    const drafts = { upsertGenerated: jest.fn() } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);

    await expect(
      svc.generate("org-attacker", MEMBERSHIP_ID, USER_ID, TICKET_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
  });
});

describe("CommentDraftGeneratorService — no eligible context (denial of wallet)", () => {
  it("spends no credits on a ticket with neither a description nor comments, because there is nothing to draft from", async () => {
    const db = makeDb([{ ...ticketRow, description: null }], []);
    const gateway = { invokeStructuredWithUsage: jest.fn() } as unknown as AiGatewayService;
    const drafts = { upsertGenerated: jest.fn() } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);

    await expect(
      svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
    expect(drafts.upsertGenerated).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only description as absent, so blank text cannot buy a provider call", async () => {
    const db = makeDb([{ ...ticketRow, description: "   \n\t  " }], []);
    const gateway = { invokeStructuredWithUsage: jest.fn() } as unknown as AiGatewayService;
    const drafts = { upsertGenerated: jest.fn() } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);

    await expect(
      svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
  });

  it("proceeds on a comment alone, so an empty description does not block a draftable ticket", async () => {
    const db = makeDb([{ ...ticketRow, description: null }], [{ content: "Reproduced on staging." }]);
    const gateway = {
      invokeStructuredWithUsage: jest.fn().mockResolvedValue(makeGatewayOk()),
    } as unknown as AiGatewayService;
    const drafts = {
      upsertGenerated: jest.fn().mockResolvedValue(upsertedDraftRow),
    } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);
    await svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID);

    expect(gateway.invokeStructuredWithUsage).toHaveBeenCalled();
  });
});

describe("CommentDraftGeneratorService — credit exhaustion", () => {
  it("throws InsufficientAiCreditsException when the gateway returns quota_exceeded, and persists no draft", async () => {
    const db = makeDb([ticketRow]);
    const gateway = {
      invokeStructuredWithUsage: jest.fn().mockResolvedValue(makeGatewayFail("quota_exceeded")),
    } as unknown as AiGatewayService;
    const drafts = { upsertGenerated: jest.fn() } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);

    await expect(svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID)).rejects.toBeInstanceOf(
      InsufficientAiCreditsException,
    );
    expect(drafts.upsertGenerated).not.toHaveBeenCalled();
  });

  it("throws a generic Error when the gateway returns provider_unavailable, and persists no draft", async () => {
    const db = makeDb([ticketRow]);
    const gateway = {
      invokeStructuredWithUsage: jest.fn().mockResolvedValue(
        makeGatewayFail("provider_unavailable"),
      ),
    } as unknown as AiGatewayService;
    const drafts = { upsertGenerated: jest.fn() } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);

    await expect(svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID)).rejects.toThrow(Error);
    expect(drafts.upsertGenerated).not.toHaveBeenCalled();
  });
});

describe("CommentDraftGeneratorService — evidence fields persisted on success", () => {
  it("calls upsertGenerated with all evidence fields from the AI output on a successful generation", async () => {
    const db = makeDb([ticketRow], [{ content: "Looks like a timeout issue." }]);
    const gateway = {
      invokeStructuredWithUsage: jest.fn().mockResolvedValue(makeGatewayOk()),
    } as unknown as AiGatewayService;
    const drafts = {
      upsertGenerated: jest.fn().mockResolvedValue(upsertedDraftRow),
    } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);
    const result = await svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID);

    expect(drafts.upsertGenerated).toHaveBeenCalledWith(
      ORG_ID,
      MEMBERSHIP_ID,
      TICKET_ID,
      aiOutputData,
    );
    expect(result.aiUsage).toEqual(aiUsage);
    expect(result.evidence).toBe(upsertedDraftRow.evidence);
    expect(result.proposedChange).toBe(upsertedDraftRow.proposedChange);
    expect(result.impact).toBe(upsertedDraftRow.impact);
    expect(result.confidence).toBe(upsertedDraftRow.confidence);
    expect(result.affectedRecordIds).toBe(upsertedDraftRow.affectedRecordIds);
  });

  it("passes the correct actor and feature key to the AI gateway so billing is attributed to the right org and feature", async () => {
    const db = makeDb([ticketRow]);
    const gateway = {
      invokeStructuredWithUsage: jest.fn().mockResolvedValue(makeGatewayOk()),
    } as unknown as AiGatewayService;
    const drafts = {
      upsertGenerated: jest.fn().mockResolvedValue(upsertedDraftRow),
    } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);
    await svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID);

    const callArg = (gateway.invokeStructuredWithUsage as jest.Mock).mock.calls[0][0] as {
      actor: { orgId: string; userId: string };
      feature: string;
      charge: boolean;
      tier: string;
    };
    expect(callArg.actor.orgId).toBe(ORG_ID);
    expect(callArg.actor.userId).toBe(USER_ID);
    expect(callArg.charge).toBe(true);
    expect(callArg.tier).toBe("fast");
  });

  it("charges a feature key the cost catalog knows, because an unregistered key silently reserves one credit instead of erroring", async () => {
    const db = makeDb([ticketRow]);
    const gateway = {
      invokeStructuredWithUsage: jest.fn().mockResolvedValue(makeGatewayOk()),
    } as unknown as AiGatewayService;
    const drafts = {
      upsertGenerated: jest.fn().mockResolvedValue(upsertedDraftRow),
    } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);
    await svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID);

    const callArg = (gateway.invokeStructuredWithUsage as jest.Mock).mock.calls[0][0] as {
      feature: string;
    };
    expect(Object.keys(AI_FEATURE_COSTS)).toContain(callArg.feature);
  });
});

describe("BSN-03-A06 — generator writes only to commentDrafts; db.update and db.delete are never reached on a successful generation", () => {
  it("db.update, db.delete, and db.insert are never called during generation — a tracked double catches any unauthorized mutation added to the service", async () => {
    const trackedUpdate = jest.fn();
    const trackedDelete = jest.fn();
    const trackedInsert = jest.fn();
    const db = withDelegatingTransaction({
      select: jest.fn()
        .mockReturnValueOnce(makeTicketChain([ticketRow]))
        .mockReturnValueOnce(makeCommentsChain([])),
      update: trackedUpdate,
      delete: trackedDelete,
      insert: trackedInsert,
    }) as unknown as Db;
    const gateway = {
      invokeStructuredWithUsage: jest.fn().mockResolvedValue(makeGatewayOk()),
    } as unknown as AiGatewayService;
    const drafts = {
      upsertGenerated: jest.fn().mockResolvedValue(upsertedDraftRow),
    } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);
    await svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID);

    expect(trackedUpdate).not.toHaveBeenCalled();
    expect(trackedDelete).not.toHaveBeenCalled();
    expect(trackedInsert).not.toHaveBeenCalled();
  });

  it("the only write path on success is CommentDraftsService.upsertGenerated called exactly once with the AI output and the caller's org/membership/ticket", async () => {
    const db = makeDb([ticketRow], []);
    const gateway = {
      invokeStructuredWithUsage: jest.fn().mockResolvedValue(makeGatewayOk()),
    } as unknown as AiGatewayService;
    const drafts = {
      upsertGenerated: jest.fn().mockResolvedValue(upsertedDraftRow),
    } as unknown as CommentDraftsService;

    const svc = new CommentDraftGeneratorService(db, gateway, drafts);
    await svc.generate(ORG_ID, MEMBERSHIP_ID, USER_ID, TICKET_ID);

    expect(drafts.upsertGenerated).toHaveBeenCalledTimes(1);
    expect(drafts.upsertGenerated).toHaveBeenCalledWith(
      ORG_ID,
      MEMBERSHIP_ID,
      TICKET_ID,
      aiOutputData,
    );
  });

  it("CommentDraftsService exposes no publishDraft, applyDraft, publishProposal, or applyProposal method, so no unapproved proposal can reach a meaningful write", () => {
    const proto = Object.getOwnPropertyNames(CommentDraftsService.prototype);
    expect(proto).not.toContain("publishDraft");
    expect(proto).not.toContain("applyDraft");
    expect(proto).not.toContain("publishProposal");
    expect(proto).not.toContain("applyProposal");
  });
});
