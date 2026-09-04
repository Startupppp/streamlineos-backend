import { NotFoundException } from "@nestjs/common";
import { SupportKbEngagementService } from "./support-kb-engagement.service";
import type { Db } from "../../../db/drizzle.module";
import type { CreateKbAttachmentInput, CreateKbCommentInput } from "./dto/support.schemas";

describe("SupportKbEngagementService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const ARTICLE_ID = 42;
  const COMMENT_ID = 7;
  const ATTACHMENT_ID = 13;
  const USER_ID = "user-attacker";

  const COMMENT_INPUT: CreateKbCommentInput = { body: "hello" };
  const ATTACHMENT_INPUT: CreateKbAttachmentInput = {
    fileName: "report.pdf",
    fileKey: "org-owner/kb-attachments/uuid.pdf",
    fileSize: 1024,
    mimeType: "application/pdf",
  };

  function makeSelectChain(resolveWith: unknown[] = []) {
    const chain: Record<string, jest.Mock> = {};
    for (const m of ["from", "where", "leftJoin", "orderBy"]) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.limit = jest.fn().mockResolvedValue(resolveWith);
    return chain as unknown as Record<string, jest.Mock>;
  }

  function makeDeleteChain(rows: unknown[]) {
    const returning = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ returning });
    const del = jest.fn().mockReturnValue({ where });
    return del;
  }

  interface InsertedRow {
    table: unknown;
    values: Record<string, unknown>;
  }

  function makeDb(opts: {
    articleRow?: unknown;
    selectRows?: unknown[];
    deleteRows?: unknown[];
    insertRows?: unknown[];
  } = {}): { db: Db; inserted: InsertedRow[] } {
    const findFirst = jest.fn().mockResolvedValue(opts.articleRow ?? null);
    const inserted: InsertedRow[] = [];
    const db = {
      query: {
        kbArticles: { findFirst },
        users: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue(makeSelectChain(opts.selectRows ?? [])),
      delete: makeDeleteChain(opts.deleteRows ?? []),
      insert: jest.fn().mockImplementation((table: unknown) => ({
        values: jest.fn().mockImplementation((values: Record<string, unknown>) => {
          inserted.push({ table, values });
          const settled = Promise.resolve(opts.insertRows ?? []);
          return Object.assign(settled, {
            returning: jest.fn().mockResolvedValue(opts.insertRows ?? []),
            onConflictDoUpdate: jest.fn().mockReturnValue(settled),
          });
        }),
      })),
    } as unknown as Db;
    return { db, inserted };
  }

  const storage = { getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file") };

  describe("listFeedback", () => {
    it("throws NotFoundException when the article belongs to a different org (cross-tenant isolation)", async () => {
      const { db } = makeDb({ articleRow: null });
      const svc = new SupportKbEngagementService(db, storage as never);
      await expect(svc.listFeedback(ATTACKER_ORG, ARTICLE_ID)).rejects.toThrow(NotFoundException);
    });

    it("returns feedback for the owning org (control — same-tenant)", async () => {
      const { db } = makeDb({ articleRow: { id: ARTICLE_ID }, selectRows: [] });
      const svc = new SupportKbEngagementService(db, storage as never);
      const result = await svc.listFeedback(OWNER_ORG, ARTICLE_ID);
      expect(result).toHaveLength(0);
    });
  });

  describe("listComments", () => {
    it("throws NotFoundException when the article belongs to a different org (cross-tenant isolation)", async () => {
      const { db } = makeDb({ articleRow: null });
      const svc = new SupportKbEngagementService(db, storage as never);
      await expect(svc.listComments(ATTACKER_ORG, ARTICLE_ID)).rejects.toThrow(NotFoundException);
    });

    it("returns comments for the owning org (control — same-tenant)", async () => {
      const { db } = makeDb({ articleRow: { id: ARTICLE_ID }, selectRows: [] });
      const svc = new SupportKbEngagementService(db, storage as never);
      const result = await svc.listComments(OWNER_ORG, ARTICLE_ID);
      expect(result).toHaveLength(0);
    });
  });

  describe("createComment", () => {
    it("throws NotFoundException when the article belongs to a different org (cross-tenant isolation)", async () => {
      const { db } = makeDb({ articleRow: null });
      const svc = new SupportKbEngagementService(db, storage as never);
      await expect(
        svc.createComment(ATTACKER_ORG, ARTICLE_ID, USER_ID, COMMENT_INPUT),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("deleteComment", () => {
    it("throws NotFoundException when the comment does not belong to the caller's org (cross-tenant isolation)", async () => {
      const { db } = makeDb({ deleteRows: [] });
      const svc = new SupportKbEngagementService(db, storage as never);
      await expect(
        svc.deleteComment(ATTACKER_ORG, ARTICLE_ID, COMMENT_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it("returns success when the comment belongs to the caller's org (control — same-tenant)", async () => {
      const { db } = makeDb({ deleteRows: [{ id: COMMENT_ID }] });
      const svc = new SupportKbEngagementService(db, storage as never);
      const result = await svc.deleteComment(OWNER_ORG, ARTICLE_ID, COMMENT_ID);
      expect(result).toEqual({ success: true });
    });
  });

  describe("listAttachments", () => {
    it("throws NotFoundException when the article belongs to a different org (cross-tenant isolation)", async () => {
      const { db } = makeDb({ articleRow: null });
      const svc = new SupportKbEngagementService(db, storage as never);
      await expect(svc.listAttachments(ATTACKER_ORG, ARTICLE_ID)).rejects.toThrow(NotFoundException);
    });

    it("returns attachments for the owning org (control — same-tenant)", async () => {
      const { db } = makeDb({ articleRow: { id: ARTICLE_ID }, selectRows: [] });
      const svc = new SupportKbEngagementService(db, storage as never);
      const result = await svc.listAttachments(OWNER_ORG, ARTICLE_ID);
      expect(result).toHaveLength(0);
    });
  });

  describe("createAttachment", () => {
    it("throws NotFoundException when the article belongs to a different org (cross-tenant isolation)", async () => {
      const { db } = makeDb({ articleRow: null });
      const svc = new SupportKbEngagementService(db, storage as never);
      await expect(
        svc.createAttachment(ATTACKER_ORG, ARTICLE_ID, USER_ID, ATTACHMENT_INPUT),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("deleteAttachment", () => {
    it("throws NotFoundException when the attachment does not belong to the caller's org (cross-tenant isolation)", async () => {
      const { db } = makeDb({ deleteRows: [] });
      const svc = new SupportKbEngagementService(db, storage as never);
      await expect(
        svc.deleteAttachment(ATTACKER_ORG, ARTICLE_ID, ATTACHMENT_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it("returns success when the attachment belongs to the caller's org (control — same-tenant)", async () => {
      const { db } = makeDb({ deleteRows: [{ fileKey: "org-owner/kb-attachments/uuid.pdf" }] });
      const svc = new SupportKbEngagementService(db, storage as never);
      const result = await svc.deleteAttachment(OWNER_ORG, ARTICLE_ID, ATTACHMENT_ID);
      expect(result).toEqual({ success: true });
    });

    /**
     * PRD-C103, "deletion must clean database rows and objects without
     * orphaning". The row was deleted with `.returning({ fileKey })` and the key
     * it fetched was then thrown away, so every deleted attachment left its
     * object behind with nothing left pointing at it.
     */
    it("enqueues the deleted attachment's object for purge instead of discarding the key", async () => {
      const { db, inserted } = makeDb({
        deleteRows: [{ fileKey: "org-owner/kb-attachments/uuid.pdf" }],
      });
      const svc = new SupportKbEngagementService(db, storage as never);
      await svc.deleteAttachment(OWNER_ORG, ARTICLE_ID, ATTACHMENT_ID);

      expect(inserted).toHaveLength(1);
      expect(inserted[0]?.values).toEqual({
        orgId: OWNER_ORG,
        storageKey: "org-owner/kb-attachments/uuid.pdf",
        purpose: "support:kb-attachment:delete",
        bucket: "default",
        status: "pending",
      });
    });
  });

  describe("getAttachmentDownloadUrl", () => {
    it("throws NotFoundException when the attachment belongs to a different org (cross-tenant isolation)", async () => {
      const { db } = makeDb({ selectRows: [] });
      const svc = new SupportKbEngagementService(db, storage as never);
      await expect(
        svc.getAttachmentDownloadUrl(ATTACKER_ORG, ARTICLE_ID, ATTACHMENT_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it("returns the download URL when the attachment belongs to the caller's org (control — same-tenant)", async () => {
      const { db } = makeDb({
        selectRows: [
          {
            fileKey: "org-owner/kb-attachments/uuid.pdf",
            fileName: "report.pdf",
            mimeType: "application/pdf",
          },
        ],
      });
      const svc = new SupportKbEngagementService(db, storage as never);
      const result = await svc.getAttachmentDownloadUrl(OWNER_ORG, ARTICLE_ID, ATTACHMENT_ID);
      expect(result.downloadUrl).toBe("https://signed.example.com/file");
      expect(result.fileName).toBe("report.pdf");
    });
  });
});
