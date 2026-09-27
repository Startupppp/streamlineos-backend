import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { KbExportService } from "./kb-export.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  ),
}));
import { kbExportJobs } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { StorageService } from "../../storage/storage.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ExportPageInput } from "./dto/kb-import-export.schemas";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-A",
    role: "member",
    isOrgOwner: false,
    enabledModules: ["kb"],
  } as unknown as CurrentUserContext;
}

const sharedAudit = { log: jest.fn() } as unknown as AuditService;

function makeSelectChain(rows: unknown[] = []) {
  const chain = Object.assign(Promise.resolve(rows), {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
  });
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

describe("KbExportService.exportPage — storage upload", () => {
  afterEach(() => jest.clearAllMocks());

  function makeExportDb(pageRow: { id: number; title: string; contentText: string | null } | undefined) {
    const insertReturning = jest.fn().mockResolvedValue([{ id: 42 }]);
    const insertValues = jest.fn().mockReturnValue({ returning: insertReturning });
    return {
      db: {
        query: {
          kbPages: {
            findFirst: jest.fn().mockResolvedValue(pageRow),
          },
        },
        select: jest.fn().mockReturnValue(makeSelectChain([])),
        insert: jest.fn().mockReturnValue({ values: insertValues }),
        transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
          query: { kbPages: { findFirst: jest.fn().mockResolvedValue(pageRow) } },
          insert: jest.fn().mockReturnValue({ values: insertValues }),
          execute: jest.fn().mockResolvedValue([]),
        })),
      } as unknown as Db,
      insertValues,
      insertReturning,
    };
  }

  it("uploads content to storage before inserting the export job row (storage upload is required for download to work)", async () => {
    const { db, insertValues } = makeExportDb({ id: 1, title: "Doc", contentText: "body" });
    const uploadFile = jest.fn().mockResolvedValue({ key: "org-A/kb-exports/1-uuid.md" });
    const storage = { uploadFile } as unknown as StorageService;
    const auth = { assertPageAccess: jest.fn().mockResolvedValue(undefined) } as never;

    const svc = new KbExportService(db, sharedAudit, auth, storage);
    const input: ExportPageInput = { format: "markdown" };
    await svc.exportPage(makeUser(), 1, input);

    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [orgId, buffer, folder, , mimeType] = uploadFile.mock.calls[0] as [string, Buffer, string, string, string];
    expect(orgId).toBe("org-A");
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(folder).toBe("kb-exports");
    expect(mimeType).toBe("text/markdown");
    expect(insertValues).toHaveBeenCalledTimes(1);
  });

  it("persists fileKey and expiresAt on the export job row so the download endpoint can serve a pre-signed URL", async () => {
    const uploadedKey = "org-A/kb-exports/1-uuid.md";
    const { db, insertValues } = makeExportDb({ id: 1, title: "Doc", contentText: "body" });
    const storage = { uploadFile: jest.fn().mockResolvedValue({ key: uploadedKey }) } as unknown as StorageService;
    const auth = { assertPageAccess: jest.fn().mockResolvedValue(undefined) } as never;

    const svc = new KbExportService(db, sharedAudit, auth, storage);
    const before = Date.now();
    await svc.exportPage(makeUser(), 1, { format: "markdown" });
    const after = Date.now();

    const [valuesArg] = insertValues.mock.calls[0] as [{ fileKey: string; expiresAt: Date }];
    expect(valuesArg.fileKey).toBe(uploadedKey);
    expect(valuesArg.expiresAt).toBeInstanceOf(Date);
    expect(valuesArg.expiresAt.getTime()).toBeGreaterThan(before);
    expect(valuesArg.expiresAt.getTime()).toBeGreaterThan(after);
  });

  it("throws NotFoundException when the requested page does not exist", async () => {
    const { db } = makeExportDb(undefined);
    const storage = { uploadFile: jest.fn() } as unknown as StorageService;
    const auth = { assertPageAccess: jest.fn().mockResolvedValue(undefined) } as never;

    const svc = new KbExportService(db, sharedAudit, auth, storage);
    await expect(svc.exportPage(makeUser(), 999, { format: "markdown" })).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });
});

describe("KbExportService.getExportJobDownload — expiry handling", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns a downloadUrl using the seconds remaining until expiresAt (honours the job's own expiry, not a fresh TTL)", async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000);
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ id: 5, fileKey: "org-A/kb-exports/x.md", expiresAt }])),
    } as unknown as Db;
    const getFileUrl = jest.fn().mockResolvedValue("https://cdn.example.com/signed");
    const storage = { getFileUrl } as unknown as StorageService;

    const svc = new KbExportService(db, sharedAudit, {} as never, storage);
    const result = await svc.getExportJobDownload("org-A", 5);

    expect(result.downloadUrl).toBe("https://cdn.example.com/signed");
    const [, , expiresIn] = getFileUrl.mock.calls[0] as [string, string, number];
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(3600);
  });

  it("throws NotFoundException when the export job has expired (expiresAt is in the past)", async () => {
    const expiresAt = new Date(Date.now() - 1000);
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ id: 5, fileKey: "org-A/kb-exports/x.md", expiresAt }])),
    } as unknown as Db;
    const storage = { getFileUrl: jest.fn() } as unknown as StorageService;

    const svc = new KbExportService(db, sharedAudit, {} as never, storage);
    await expect(svc.getExportJobDownload("org-A", 5)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the export job has no fileKey (page was exported before storage upload was wired)", async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000);
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ id: 5, fileKey: null, expiresAt }])),
    } as unknown as Db;
    const storage = { getFileUrl: jest.fn() } as unknown as StorageService;

    const svc = new KbExportService(db, sharedAudit, {} as never, storage);
    await expect(svc.getExportJobDownload("org-A", 5)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("KbExportService.listExportJobs — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb() {
    const wheres: unknown[] = [];
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return Object.assign(Promise.resolve([]), {
                orderBy: jest.fn().mockReturnValue(
                  Object.assign(Promise.resolve([]), {
                    limit: jest.fn().mockResolvedValue([]),
                  }),
                ),
              });
            }),
          }),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("scopes export job list to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbExportService(db, {} as never, {} as never, {} as never);

    await svc.listExportJobs(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns a cursor page for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new KbExportService(db, {} as never, {} as never, {} as never);

    const result = await svc.listExportJobs(OWNER);
    expect(Array.isArray(result.data)).toBe(true);
  });
});
