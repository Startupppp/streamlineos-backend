import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KbAttachmentIndexingService } from "./kb-attachment-indexing.service";
import type { Db } from "../../../db/drizzle.module";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { StorageService } from "../../storage/storage.service";
import type { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";
import { stubService } from "../../../test/service-stub.spec-fixtures";

const ORG = "org-deindex";
const ATTACHMENT_ID = 77;
const PAGE_ID = 5;

const dialect = new PgDialect();
const renderWhere = (cond: SQL): string => dialect.sqlToQuery(cond).sql;

interface AttachmentRow {
  pageId: number;
  fileKey: string;
  mimeType: string;
  fileName: string;
  deletedAt: Date | null;
  pageAclRevision: number | null;
  pageDeletedAt: Date | null;
}

function liveRow(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    pageId: PAGE_ID,
    fileKey: "uploads/handbook.pdf",
    mimeType: "application/pdf",
    fileName: "handbook.pdf",
    deletedAt: null,
    pageAclRevision: 3,
    pageDeletedAt: null,
    ...overrides,
  };
}

function harness(attachmentRow: AttachmentRow | null) {
  const deletes: SQL[] = [];
  const pageLookups: SQL[] = [];

  const selectChain: Record<string, jest.Mock> = {
    from: jest.fn(() => selectChain),
    leftJoin: jest.fn(() => selectChain),
    where: jest.fn(() => selectChain),
    limit: jest.fn().mockResolvedValue(attachmentRow === null ? [] : [attachmentRow]),
  };
  const deleteChain = {
    where: jest.fn((cond: SQL) => {
      deletes.push(cond);
      return Promise.resolve(undefined);
    }),
  };
  const db = {
    select: jest.fn(() => selectChain),
    delete: jest.fn(() => deleteChain),
    query: {
      kbPages: {
        findFirst: jest.fn((args: { where: SQL }) => {
          pageLookups.push(args.where);
          return Promise.resolve(undefined);
        }),
      },
    },
  } as unknown as Db;

  const getFileStream = jest.fn().mockRejectedValue(new Error("stream not wired"));

  const service = new KbAttachmentIndexingService(
    db,
    stubService<AiGatewayService>({
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    }),
    stubService<StorageService>({ getFileStream }),
    stubService<KbIngestionCheckpointService>({}),
  );

  return { service, deletes, pageLookups, getFileStream };
}

describe("a soft-deleted page takes its derived chunks out of the index", () => {
  it("de-indexes an attachment whose parent page is soft-deleted instead of re-embedding it, because retrieval anchors attachment chunks to page_id and a deleted page must not stay answerable", async () => {
    const { service, deletes, getFileStream } = harness(
      liveRow({ pageDeletedAt: new Date("2026-01-01T00:00:00Z") }),
    );

    const result = await service.indexAttachment(ORG, ATTACHMENT_ID);

    expect(result).toEqual({ chunks: 0, warning: null });
    expect(deletes).toHaveLength(1);
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it("still reaches storage for an attachment on a live page, so the de-index above is the deleted_at check and not a guard that rejects everything", async () => {
    const { service, getFileStream } = harness(liveRow());

    const result = await service.indexAttachment(ORG, ATTACHMENT_ID);

    expect(getFileStream).toHaveBeenCalledWith(ORG, "uploads/handbook.pdf");
    expect(result.warning).toContain("could not read file");
  });

  it("deletes the attachment's chunks by attachment_id when the parent page is soft-deleted", async () => {
    const { service, deletes } = harness(
      liveRow({ pageDeletedAt: new Date("2026-01-01T00:00:00Z") }),
    );

    await service.indexAttachment(ORG, ATTACHMENT_ID);

    const rendered = renderWhere(deletes[0]);
    expect(rendered).toContain(`"attachment_id"`);
    expect(rendered).toContain(`"org_id"`);
  });

  it("filters deleted_at when indexPageDocument resolves the parent page, so an upload cannot re-index a page that was soft-deleted mid-flight", async () => {
    const { service, pageLookups } = harness(null);

    const result = await service.indexPageDocument(
      ORG,
      PAGE_ID,
      Buffer.from(""),
      "application/pdf",
      "handbook.pdf",
    );

    expect(result).toEqual({ chunks: 0, warning: null });
    expect(pageLookups).toHaveLength(1);
    expect(renderWhere(pageLookups[0])).toContain(`"deleted_at" is null`);
  });
});
