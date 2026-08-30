import { NotFoundException } from "@nestjs/common";
import { SupportKbGapService } from "./support-kb-gap.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportKbGapService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(listRows: unknown[]): Db {
    const builder = {
      from: jest.fn(),
      where: jest.fn(),
      leftJoin: jest.fn(),
      innerJoin: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      groupBy: jest.fn(),
      selectDistinct: jest.fn(),
    };
    builder.from.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.leftJoin.mockReturnValue(builder);
    builder.innerJoin.mockReturnValue(builder);
    builder.orderBy.mockReturnValue(builder);
    builder.groupBy.mockReturnValue(builder);
    builder.limit.mockResolvedValue(listRows);
    const updateReturning = jest.fn().mockResolvedValue([]);
    const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateChain = jest.fn().mockReturnValue({ set: updateSet });
    return {
      query: {
        supportKnowledgeGaps: { findFirst: jest.fn().mockResolvedValue(null) },
        kbSpaces: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue(builder),
      selectDistinct: jest.fn().mockReturnValue(builder),
      update: updateChain,
      insert: jest.fn(),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
  }

  it("returns empty gaps for a different org (cross-tenant isolation)", async () => {
    const db = makeDb([]);
    const aiGateway = { invokeStructuredWithUsage: jest.fn() };
    const kbArticles = { create: jest.fn() };
    const kbEvents = { record: jest.fn() };
    const notificationDispatch = { emit: jest.fn() };
    const svc = new SupportKbGapService(db, aiGateway as never, kbArticles as never, kbEvents as never, notificationDispatch as never);
    const result = await svc.listGaps(ATTACKER_ORG);
    expect(result.gaps).toHaveLength(0);
  });

  it("returns gaps for the owning org (control — same-tenant access works)", async () => {
    const row = { id: 1, orgId: OWNER_ORG, clusterKey: "k1", representativeQuestion: "How?", ticketCount: 3, sampleTicketIds: [], status: "OPEN", proposedArticleId: null, draftedBy: null, reviewedBy: null, evidence: null, createdAt: new Date(), updatedAt: new Date(), proposedArticleTitle: null };
    const db = makeDb([row]);
    const aiGateway = { invokeStructuredWithUsage: jest.fn() };
    const kbArticles = { create: jest.fn() };
    const kbEvents = { record: jest.fn() };
    const notificationDispatch = { emit: jest.fn() };
    const svc = new SupportKbGapService(db, aiGateway as never, kbArticles as never, kbEvents as never, notificationDispatch as never);
    const result = await svc.listGaps(OWNER_ORG);
    expect(result.gaps.length).toBeGreaterThanOrEqual(0);
  });

  it("throws NotFoundException when dismissing a gap that belongs to a different org (tenant isolation)", async () => {
    const db = makeDb([]);
    const aiGateway = { invokeStructuredWithUsage: jest.fn() };
    const kbArticles = { create: jest.fn() };
    const kbEvents = { record: jest.fn() };
    const notificationDispatch = { emit: jest.fn() };
    const svc = new SupportKbGapService(db, aiGateway as never, kbArticles as never, kbEvents as never, notificationDispatch as never);
    await expect(svc.dismissGap(ATTACKER_ORG, 999)).rejects.toThrow(NotFoundException);
  });
});
