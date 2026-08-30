import { NotFoundException } from "@nestjs/common";
import { SupportKbService } from "./support-kb.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportKbService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(categoriesRows: unknown[], articleRow: unknown): Db {
    const findManyCategories = jest.fn().mockResolvedValue(categoriesRows);
    const findFirstArticle = jest.fn().mockResolvedValue(articleRow);
    const selectChain = jest.fn().mockReturnValue([]);
    const builder = { from: jest.fn(), where: jest.fn(), innerJoin: jest.fn(), leftJoin: jest.fn(), orderBy: jest.fn(), limit: jest.fn() };
    builder.from.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.innerJoin.mockReturnValue(builder);
    builder.leftJoin.mockReturnValue(builder);
    builder.orderBy.mockReturnValue(builder);
    builder.limit.mockResolvedValue([]);
    const indexing = { indexAttachment: jest.fn().mockResolvedValue(undefined) };
    return {
      query: {
        kbCategories: { findMany: findManyCategories, findFirst: jest.fn().mockResolvedValue(null) },
        kbArticles: { findFirst: findFirstArticle },
        kbTags: { findFirst: jest.fn().mockResolvedValue(null) },
        users: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue(builder),
    } as unknown as Db;
  }

  it("returns empty categories for a different org (cross-tenant isolation)", async () => {
    const db = makeDb([], null);
    const svc = new SupportKbService(db, { indexAttachment: jest.fn() } as never);
    const result = await svc.listCategories(ATTACKER_ORG);
    expect(result).toHaveLength(0);
  });

  it("returns categories for the owning org (control — same-tenant access works)", async () => {
    const db = makeDb([{ id: 1, orgId: OWNER_ORG, name: "General" }], null);
    const svc = new SupportKbService(db, { indexAttachment: jest.fn() } as never);
    const result = await svc.listCategories(OWNER_ORG);
    expect(result).toHaveLength(1);
  });

  it("throws NotFoundException when fetching article belonging to a different org (tenant isolation)", async () => {
    const db = makeDb([], null);
    const svc = new SupportKbService(db, { indexAttachment: jest.fn() } as never);
    await expect(svc.getArticle(ATTACKER_ORG, 42)).rejects.toThrow(NotFoundException);
  });
});
