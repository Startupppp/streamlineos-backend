import { NotFoundException } from "@nestjs/common";
import { SupportKbService } from "./support-kb.service";
import { SupportKbEngagementService } from "./support-kb-engagement.service";
import { KbPageWriterService } from "../../kb/wiki/kb-page-writer.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportKbService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const builder = {
    from: jest.fn(),
    where: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockResolvedValue([]);

  function makeDb(categoriesRows: unknown[], articleRow: unknown): Db {
    const findManyCategories = jest.fn().mockResolvedValue(categoriesRows);
    const findFirstArticle = jest.fn().mockResolvedValue(articleRow);
    return {
      query: {
        kbCategories: { findMany: findManyCategories, findFirst: jest.fn().mockResolvedValue(null) },
        kbPages: { findFirst: findFirstArticle },
        kbTags: { findFirst: jest.fn().mockResolvedValue(null) },
        users: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue(builder),
    } as unknown as Db;
  }

  it("returns empty categories for a different org (cross-tenant isolation)", async () => {
    const db = makeDb([], null);
    const svc = new SupportKbService(db, new KbPageWriterService({} as never, {} as never));
    const result = await svc.listCategories(ATTACKER_ORG);
    expect(result).toHaveLength(0);
  });

  it("returns categories for the owning org (control — same-tenant access works)", async () => {
    const db = makeDb([{ id: 1, orgId: OWNER_ORG, name: "General" }], null);
    const svc = new SupportKbService(db, new KbPageWriterService({} as never, {} as never));
    const result = await svc.listCategories(OWNER_ORG);
    expect(result).toHaveLength(1);
  });

  it("throws NotFoundException when fetching article belonging to a different org (tenant isolation)", async () => {
    const db = makeDb([], null);
    const svc = new SupportKbService(db, new KbPageWriterService({} as never, {} as never));
    await expect(svc.getArticle(ATTACKER_ORG, 42)).rejects.toThrow(NotFoundException);
  });

  describe("getAttachmentDownloadUrl — cross-tenant isolation", () => {
    it("throws NotFoundException when org B requests org A's attachment", async () => {
      builder.limit.mockResolvedValue([]);
      const db = makeDb([], null);
      const storage = { getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file.pdf") };
      const svc = new SupportKbEngagementService(db, storage as never);

      await expect(svc.getAttachmentDownloadUrl(ATTACKER_ORG, 10, 1)).rejects.toThrow(NotFoundException);
    });

    it("returns downloadUrl for the owning org (control — same-tenant access works)", async () => {
      builder.limit.mockResolvedValue([{
        fileKey: "org-owner/kb-attachments/uuid-file.pdf",
        fileName: "guide.pdf",
        mimeType: "application/pdf",
      }]);
      const db = makeDb([], null);
      const storage = { getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file.pdf?X-Expires=3600") };
      const svc = new SupportKbEngagementService(db, storage as never);

      const result = await svc.getAttachmentDownloadUrl(OWNER_ORG, 10, 1);
      expect(result.downloadUrl).toBe("https://signed.example.com/file.pdf?X-Expires=3600");
      expect(result.fileName).toBe("guide.pdf");
    });
  });
});
