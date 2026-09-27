import { Test } from "@nestjs/testing";
import { KbContentGapService } from "./kb-content-gap.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { SupportKnowledgeGapStatus } from "../../../db/schema/support/support-kb-gap";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (
    db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
    fn: (tx: unknown) => Promise<unknown>,
  ) => db.transaction(fn),
}));

function makeUser(orgId = "org-1"): CurrentUserContext {
  return {
    orgId,
    userId: "user-1",
    role: "admin",
    isOrgOwner: false,
    tokenScopes: null,
    sessionId: "s1",
    principal: humanSessionPrincipal(1, false),
  };
}

describe("KbContentGapService — gap actions", () => {
  let service: KbContentGapService;
  let mockDb: {
    transaction: jest.Mock;
    insert: jest.Mock;
    select: jest.Mock;
  };
  let insertChain: {
    values: jest.Mock;
    onConflictDoUpdate: jest.Mock;
    returning: jest.Mock;
  };

  beforeEach(async () => {
    insertChain = {
      values: jest.fn().mockReturnThis(),
      onConflictDoUpdate: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([
        {
          id: 42,
          clusterKey: "how to reset password",
          status: SupportKnowledgeGapStatus.OPEN,
          proposedArticleId: null,
          draftedBy: null,
          updatedAt: new Date(),
        },
      ]),
    };

    mockDb = {
      transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
      insert: jest.fn().mockReturnValue(insertChain),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              then: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        KbContentGapService,
        { provide: DRIZZLE, useValue: mockDb },
        {
          provide: KnowledgeAuthorizationService,
          useValue: { visiblePagePredicate: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(KbContentGapService);
  });

  describe("assignGap", () => {
    it("upserts a supportKnowledgeGaps row so a missing gap row does not reject the assign, removing this test removes the upsert contract", async () => {
      const result = await service.assignGap(makeUser(), {
        query: "how to reset password",
        assigneeUserId: "user-99",
      });
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org-1",
          clusterKey: "how to reset password",
          draftedBy: "user-99",
        }),
      );
      expect(result.id).toBe(42);
    });

    it("sets draftedBy on the conflict update so a re-assign overwrites the previous owner, removing this test removes the overwrite contract", async () => {
      await service.assignGap(makeUser(), {
        query: "how to reset password",
        assigneeUserId: "user-99",
      });
      expect(insertChain.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({ draftedBy: "user-99" }),
        }),
      );
    });
  });

  describe("dismissGap", () => {
    it("upserts with status=DISMISSED so dismissing a gap that was never upserted does not throw, removing this test removes the upsert contract", async () => {
      insertChain.returning.mockResolvedValue([
        {
          id: 7,
          clusterKey: "how to reset password",
          status: SupportKnowledgeGapStatus.DISMISSED,
          proposedArticleId: null,
          draftedBy: null,
          updatedAt: new Date(),
        },
      ]);
      const result = await service.dismissGap(makeUser(), {
        query: "how to reset password",
        reason: "Not a real gap",
      });
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SupportKnowledgeGapStatus.DISMISSED,
          clusterKey: "how to reset password",
        }),
      );
      expect(result.status).toBe(SupportKnowledgeGapStatus.DISMISSED);
    });

    it("overrides an existing open gap status to DISMISSED on conflict, removing this test removes the status-update contract", async () => {
      await service.dismissGap(makeUser(), {
        query: "reset password",
        reason: "Already covered",
      });
      expect(insertChain.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({ status: SupportKnowledgeGapStatus.DISMISSED }),
        }),
      );
    });
  });

  describe("createFix", () => {
    it("inserts a draft kb_page seeded with the gap query as title, removing this test removes the page-creation contract", async () => {
      const pageInsertChain = {
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 99 }]),
      };
      mockDb.insert
        .mockReturnValueOnce(pageInsertChain)
        .mockReturnValueOnce(insertChain);

      await service.createFix(makeUser(), { query: "how to reset password" });

      expect(mockDb.insert).toHaveBeenCalledTimes(2);
      expect(pageInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "how to reset password",
          status: "draft",
          orgId: "org-1",
        }),
      );
    });

    it("links the created page as proposedArticleId in the gap upsert, removing this test removes the gap-page linkage contract", async () => {
      const pageInsertChain = {
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 99 }]),
      };
      mockDb.insert
        .mockReturnValueOnce(pageInsertChain)
        .mockReturnValueOnce(insertChain);

      await service.createFix(makeUser(), { query: "how to reset password" });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          proposedArticleId: 99,
          status: SupportKnowledgeGapStatus.DRAFTED,
        }),
      );
    });

    it("sets status=DRAFTED on the gap row, so a created-fix cannot remain OPEN and appear actionable again, removing this test removes the status-lock contract", async () => {
      const pageInsertChain = {
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 55 }]),
      };
      mockDb.insert
        .mockReturnValueOnce(pageInsertChain)
        .mockReturnValueOnce(insertChain);

      await service.createFix(makeUser(), { query: "billing question" });

      expect(insertChain.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({ status: SupportKnowledgeGapStatus.DRAFTED }),
        }),
      );
    });

    it("wraps the page insert and gap upsert in one transaction so a gap-upsert failure cannot orphan the draft page permanently", async () => {
      const pageInsertChain = {
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 77 }]),
      };
      mockDb.insert
        .mockReturnValueOnce(pageInsertChain)
        .mockReturnValueOnce(insertChain);

      await service.createFix(makeUser(), { query: "how to export data" });

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).toHaveBeenCalledTimes(2);
    });
  });
});
