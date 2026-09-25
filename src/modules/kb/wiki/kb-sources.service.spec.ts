import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { KbSourcesService } from "./kb-sources.service";

function makeDb(rows: Record<string, unknown>[]): unknown {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return { update };
}

function makeStorage(deleteFileFn = jest.fn().mockResolvedValue(undefined)) {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    deleteFile: deleteFileFn,
  };
}

function makeIndexing() {
  return { removeSourceChunks: jest.fn().mockResolvedValue(undefined) };
}

const KB_BUCKET = "kb-files";

function makeConfig() {
  return { R2_KB_BUCKET_NAME: KB_BUCKET, R2_KB_PUBLIC_URL: "" };
}

function makeAuthMock() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
  };
}

function makeQuota() {
  return {
    reserve: jest.fn<Promise<void>, [unknown, string, number]>().mockResolvedValue(undefined),
    release: jest.fn<Promise<void>, [string, number]>().mockResolvedValue(undefined),
  };
}

function makeService(
  rows: Record<string, unknown>[],
  deleteFileFn = jest.fn().mockResolvedValue(undefined),
  quota = makeQuota(),
) {
  return new KbSourcesService(
    makeDb(rows) as never,
    makeStorage(deleteFileFn) as never,
    makeIndexing() as never,
    makeConfig() as never,
    {} as never,
    makeAuthMock() as never,
    quota as never,
  );
}

describe("KbSourcesService.remove — indexed-bytes release", () => {
  it("returns a deleted file's reserved bytes so a full-then-empty org can index again", async () => {
    const quota = makeQuota();
    const row = { kind: "file", fileKey: "kb-sources/org-1/doc.pdf", fileSize: 2048, noteText: null };
    const svc = makeService([row], jest.fn().mockResolvedValue(undefined), quota);

    await svc.remove("org-1", 42);

    expect(quota.release).toHaveBeenCalledWith("org-1", 2048);
  });

  it("returns a deleted note's bytes measured the same way the reservation measured them", async () => {
    const quota = makeQuota();
    const row = { kind: "note", fileKey: null, fileSize: null, noteText: "héllo" };
    const svc = makeService([row], jest.fn().mockResolvedValue(undefined), quota);

    await svc.remove("org-1", 43);

    expect(quota.release).toHaveBeenCalledWith("org-1", Buffer.byteLength("héllo", "utf8"));
  });

  it("does not release when the source was not found", async () => {
    const quota = makeQuota();
    const svc = makeService([], jest.fn().mockResolvedValue(undefined), quota);

    await expect(svc.remove("org-1", 44)).rejects.toBeInstanceOf(NotFoundException);

    expect(quota.release).not.toHaveBeenCalled();
  });
});

describe("KbSourcesService.remove — storage cleanup", () => {
  it("calls storage.deleteFile with the KB bucket the upload used, not the default one", async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const row = { kind: "file", fileKey: "kb-sources/org-1/doc.pdf" };
    const svc = makeService([row], deleteFile);

    await svc.remove("org-1", 42);

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(
      "org-1",
      "kb-sources/org-1/doc.pdf",
      KB_BUCKET,
    );
  });

  it("does NOT call storage.deleteFile for a note-kind source", async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const row = { kind: "note", fileKey: null };
    const svc = makeService([row], deleteFile);

    await svc.remove("org-1", 7);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("does NOT call storage.deleteFile for a file-kind source with null fileKey", async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const row = { kind: "file", fileKey: null };
    const svc = makeService([row], deleteFile);

    await svc.remove("org-1", 9);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("swallows a storage failure so the caller still gets { success: true }", async () => {
    const deleteFile = jest.fn().mockRejectedValue(new Error("R2 unreachable"));
    const row = { kind: "file", fileKey: "kb-sources/org-1/doc.pdf" };
    const svc = makeService([row], deleteFile);

    const result = await svc.remove("org-1", 42);

    expect(result).toEqual({ success: true });
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException when the source is not found", async () => {
    const svc = makeService([]);

    await expect(svc.remove("org-1", 99)).rejects.toThrow(NotFoundException);
  });
});
